/**
 * MainExecutor — pure execution function for the Main Agent Channel.
 *
 * Uses the SAME pipeline as Talk execution (agentRouter.execute()), but with:
 * - Main thread memory loaded via main-context-loader
 * - Only persists the run context snapshot; worker owns message + terminal writes
 * - No terminal event emits (worker owns completed/failed events)
 *
 * The executor resolves an agent, builds a thread-scoped context package,
 * records an auditable run snapshot, calls executeWithAgent, emits streaming
 * events (started, deltas, usage), and returns output.
 * On failure it throws — the worker catches and emits the authoritative failure.
 *
 * Phase 2: Main executor now has direct web and browser tools.
 */

import { getContainerRuntimeStatus } from '../../container-runtime.js';
import { getDb } from '../../db.js';
import {
  getRegisteredAgent,
  type RegisteredAgentRecord,
} from '../db/agent-accessors.js';
import {
  getSettingValue,
  getTalkRunById,
  getTalkRunTaskType,
  updateTalkRunMetadata,
} from '../db/accessors.js';
import {
  executeWithAgent,
  type ExecutionContext,
  type ExecutionEvent,
} from './agent-router.js';
import {
  EXECUTOR_MAIN_PROJECT_PATH_KEY,
  getContainerAllowedTools,
  planMainExecution,
  type ExecutionRouteReason,
  type MainExecutionPlan,
} from './execution-planner.js';
import { MAIN_SUBSCRIPTION_WARM_WORKER_ENABLED } from '../config.js';
import { getMainAgent } from './agent-registry.js';
import {
  buildMainSystemPrompt,
  loadMainContext,
  renderMainPromptPayload,
} from './main-context-loader.js';
import { resolveValidatedProjectMountPath } from './project-mounts.js';
import {
  executeContainerAgentTurn,
  type ExecuteContainerTurnInput,
  type ExecuteContainerTurnOutput,
} from './container-turn-executor.js';
import { executeCodexAgentTurn } from './codex-turn-executor.js';
import {
  BROWSER_TOOL_DEFINITIONS,
  executeBrowserTool,
} from '../tools/browser-tools.js';
import { buildBrowserResumeSection } from '../browser/run-context.js';
import type { ExecutionDecisionMetadata } from '../browser/metadata.js';
import {
  executeWebFetch,
  executeWebSearch,
  WEB_TOOL_DEFINITIONS,
} from '../tools/web-tools.js';
import { subscribeBrowserBridgeRunEvents } from '../browser/bridge.js';
import {
  executeWarmMainSubscriptionTurn,
  MainSubscriptionWorkerManagerError,
} from './main-subscription-worker-manager.js';
import type { MainRunLeaseState } from '../browser/metadata.js';

// ============================================================================
// Types
// ============================================================================

export interface MainExecutorInput {
  runId: string;
  threadId: string;
  requestedBy: string;
  triggerMessageId: string;
  triggerContent: string;
  targetAgentId?: string | null;
}

export interface MainExecutorOutput {
  content: string;
  agentId: string;
  agentName: string;
  providerId: string;
  modelId: string;
  threadId: string;
  latencyMs: number;
  promotionRequest?: MainPromotionRequest | null;
  usage?: {
    inputTokens: number;
    cachedInputTokens?: number;
    outputTokens: number;
    estimatedCostUsd?: number;
  };
}

export interface MainPromotionRequest {
  taskDescription: string;
  requiredToolFamilies: Array<'shell' | 'filesystem'>;
  userVisibleSummary: string;
  handoffNote: string | null;
  requiresApproval: boolean;
}

type MainExecutionStrategy = 'browser_fast_lane' | 'generic_agent_loop';
type BrowserTimeoutProfile = 'default' | 'fast_lane';

export class MainRunPhaseTimeoutError extends Error {
  constructor(
    public readonly timeoutPhase:
      | 'lease_queue'
      | 'lease_boot'
      | 'queue_to_executor_start'
      | 'first_progress'
      | 'first_page_ready'
      | 'worker_unresponsive'
      | 'total_run',
    message: string,
  ) {
    super(message);
    this.name = 'MainRunPhaseTimeoutError';
  }
}

/** Streaming-only events emitted during execution. Terminal events are worker-owned. */
export type MainExecutionEvent =
  | {
      type: 'main_response_started';
      runId: string;
      threadId: string;
      agentId: string;
      agentName: string;
    }
  | {
      type: 'main_response_delta';
      runId: string;
      threadId: string;
      text: string;
    }
  | {
      type: 'main_progress_update';
      runId: string;
      threadId: string;
      message: string;
    }
  | {
      type: 'main_response_usage';
      runId: string;
      threadId: string;
      usage: {
        inputTokens: number;
        cachedInputTokens?: number;
        outputTokens: number;
        estimatedCostUsd?: number;
      };
    }
  | {
      type: 'main_promotion_pending';
      runId: string;
      threadId: string;
      requestedToolFamilies: string[];
      userVisibleSummary: string;
    };

function getModelContextWindow(agent: RegisteredAgentRecord): number {
  const row = getDb()
    .prepare(
      `
      SELECT context_window_tokens
      FROM llm_provider_models
      WHERE provider_id = ? AND model_id = ?
      LIMIT 1
    `,
    )
    .get(agent.provider_id, agent.model_id) as
    | { context_window_tokens: number }
    | undefined;

  return row?.context_window_tokens || 128000;
}

const REQUEST_HEAVY_EXECUTION_TOOL = {
  name: 'request_heavy_execution',
  description:
    'Escalate this Main request into a heavy background run when shell or filesystem tools are required.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      taskDescription: { type: 'string', maxLength: 2000 },
      requiredToolFamilies: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['shell', 'filesystem'],
        },
        minItems: 1,
        uniqueItems: true,
      },
      userVisibleSummary: { type: 'string', maxLength: 120 },
      handoffNote: { type: ['string', 'null'], maxLength: 500 },
    },
    required: ['taskDescription', 'requiredToolFamilies', 'userVisibleSummary'],
  },
} satisfies ExecutionContext['contextTools'][number];

const BROWSER_FAST_LANE_MAX_TOOL_ITERATIONS = 3;
const MAIN_RUN_LEASE_QUEUE_BUDGET_MS = 5_000;
const MAIN_RUN_LEASE_BOOT_BUDGET_MS = 15_000;
const MAIN_RUN_QUEUE_START_BUDGET_MS = 2_000;
const MAIN_RUN_FIRST_PROGRESS_BUDGET_MS = 10_000;
// Cold browser startup plus a LinkedIn checkpoint page can exceed 45s before
// the auth block is surfaced, especially on subscription-backed runs.
const MAIN_RUN_FIRST_PAGE_READY_BUDGET_MS = 90_000;
const MAIN_RUN_FAST_LANE_TOTAL_BUDGET_MS = 90_000;
const MAIN_RUN_WARM_SUBSCRIPTION_TOTAL_BUDGET_MS = 60_000;
const MAIN_RUN_COLD_SUBSCRIPTION_TOTAL_BUDGET_MS = 90_000;
const MAIN_RUN_SUBSCRIPTION_FALLBACK_TOTAL_BUDGET_MS = 120_000;

function looksLikeBrowserFastLaneIntent(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const mentionsSurface =
    /https?:\/\//.test(normalized) ||
    /\blinkedin\b/.test(normalized) ||
    /\b(browser|website|page|site|session)\b/.test(normalized);
  if (!mentionsSurface) {
    return false;
  }
  return /\b(open|access|check|inspect|visit|navigate|log in|login|see|show|tell me what you can access|what can you access)\b/.test(
    normalized,
  );
}

function shouldUseBrowserFastLane(input: {
  triggerContent: string;
  mainPlan: MainExecutionPlan;
  promotedRun: MainPromotionRequest | null;
  useHostCodex: boolean;
}): boolean {
  return (
    !input.promotedRun &&
    !input.useHostCodex &&
    toolFamilyEnabled(input.mainPlan.effectiveTools, 'browser') &&
    looksLikeBrowserFastLaneIntent(input.triggerContent)
  );
}

function buildBrowserFastLaneSection(): string {
  return [
    'This run is on the browser fast lane.',
    'Use browser tools first and keep the run tightly bounded.',
    'Open or reuse the target browser session immediately.',
    'Classify whether the page is accessible, blocked by login, or waiting for phone/app approval.',
    'Stop exploring once the page state is known and summarize only what is accessible or visible.',
    'Prefer the minimum tool calls needed to answer. Do not wander or perform unrelated browsing.',
  ].join('\n');
}

function deriveRouteReason(input: {
  strategy: MainExecutionStrategy;
  shouldUseContainer: boolean;
  useHostCodex: boolean;
  mainPlan: MainExecutionPlan;
}): ExecutionRouteReason {
  if (input.strategy === 'browser_fast_lane' && !input.shouldUseContainer) {
    return 'browser_fast_lane';
  }
  if (input.shouldUseContainer) {
    return input.mainPlan.containerPlan?.routeReason || 'normal';
  }
  if (input.useHostCodex) {
    return 'normal';
  }
  return input.mainPlan.directPlan?.routeReason || 'normal';
}

function parseObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignored
  }
  return {};
}

function appendSystemSection(
  base: string,
  heading: string,
  body: string,
): string {
  const section = [`# ${heading}`, '', body].join('\n');
  return base ? `${base}\n\n${section}` : section;
}

function toolFamilyEnabled(
  effectiveTools: MainExecutionPlan['effectiveTools'],
  family: string,
): boolean {
  return effectiveTools.some(
    (tool) => tool.toolFamily === family && tool.enabled,
  );
}

function updateRunTiming(runId: string, patch: Record<string, unknown>): void {
  updateTalkRunMetadata(runId, (current) => {
    const timing =
      current.timing &&
      typeof current.timing === 'object' &&
      !Array.isArray(current.timing)
        ? { ...(current.timing as Record<string, unknown>) }
        : {};
    return {
      ...current,
      timing: {
        ...timing,
        ...patch,
      },
    };
  });
}

function updateRunStateMetadata(
  runId: string,
  patch: Record<string, unknown>,
): void {
  updateTalkRunMetadata(runId, (current) => ({
    ...current,
    ...patch,
  }));
}

function setRunBrowserPhase(
  runId: string,
  phase: 'starting' | 'interacting' | 'summarizing' | null,
): void {
  getDb()
    .prepare(
      `
      UPDATE talk_runs
      SET browser_phase = ?
      WHERE id = ?
    `,
    )
    .run(phase, runId);
}

function parseRunTimingMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const timing = metadata.timing;
  if (timing && typeof timing === 'object' && !Array.isArray(timing)) {
    return { ...(timing as Record<string, unknown>) };
  }
  return {};
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function createChildSignal(parentSignal: AbortSignal): {
  signal: AbortSignal;
  abort: (reason: unknown) => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal.reason || 'aborted');
  if (parentSignal.aborted) {
    onAbort();
  } else {
    parentSignal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    abort: (reason) => {
      if (!controller.signal.aborted) {
        controller.abort(
          reason instanceof Error ? reason : new Error(String(reason)),
        );
      }
    },
    cleanup: () => {
      parentSignal.removeEventListener('abort', onAbort);
    },
  };
}

function validatePromotionRequest(
  args: Record<string, unknown>,
  mainPlan: MainExecutionPlan,
): { ok: true; value: MainPromotionRequest } | { ok: false; error: string } {
  const taskDescription =
    typeof args.taskDescription === 'string' ? args.taskDescription.trim() : '';
  if (!taskDescription) {
    return { ok: false, error: 'taskDescription is required.' };
  }
  if (taskDescription.length > 2000) {
    return {
      ok: false,
      error: 'taskDescription must be 2000 characters or fewer.',
    };
  }

  const requiredToolFamiliesRaw = Array.isArray(args.requiredToolFamilies)
    ? args.requiredToolFamilies
    : [];
  const requiredToolFamilies = Array.from(
    new Set(
      requiredToolFamiliesRaw.filter(
        (entry): entry is 'shell' | 'filesystem' =>
          entry === 'shell' || entry === 'filesystem',
      ),
    ),
  );
  if (requiredToolFamilies.length === 0) {
    return {
      ok: false,
      error: 'requiredToolFamilies must include shell or filesystem.',
    };
  }

  const allowedFamilies = new Set(mainPlan.heavyToolFamilies);
  for (const family of requiredToolFamilies) {
    if (!allowedFamilies.has(family)) {
      return {
        ok: false,
        error: `Tool family '${family}' is not enabled for this Main agent.`,
      };
    }
  }

  const userVisibleSummary =
    typeof args.userVisibleSummary === 'string'
      ? args.userVisibleSummary.trim()
      : '';
  if (!userVisibleSummary) {
    return { ok: false, error: 'userVisibleSummary is required.' };
  }
  if (userVisibleSummary.length > 120) {
    return {
      ok: false,
      error: 'userVisibleSummary must be 120 characters or fewer.',
    };
  }

  const handoffNoteRaw =
    args.handoffNote == null
      ? null
      : typeof args.handoffNote === 'string'
        ? args.handoffNote.trim()
        : '';
  if (handoffNoteRaw !== null && handoffNoteRaw.length > 500) {
    return { ok: false, error: 'handoffNote must be 500 characters or fewer.' };
  }

  const toolByFamily = new Map(
    mainPlan.effectiveTools.map((tool) => [tool.toolFamily, tool]),
  );
  const requiresApproval = requiredToolFamilies.some(
    (family) => toolByFamily.get(family)?.requiresApproval === true,
  );

  return {
    ok: true,
    value: {
      taskDescription,
      requiredToolFamilies,
      userVisibleSummary,
      handoffNote: handoffNoteRaw || null,
      requiresApproval,
    },
  };
}

function buildExecutionDecisionForMain(input: {
  agent: RegisteredAgentRecord;
  mainPlan: MainExecutionPlan;
  backend: 'direct_http' | 'container' | 'host_codex';
  routeReason: ExecutionRouteReason;
}): ExecutionDecisionMetadata {
  if (input.backend === 'container') {
    const containerPlan = input.mainPlan.containerPlan;
    if (!containerPlan) {
      throw new Error('Missing container plan for Main execution decision');
    }
    return {
      backend: 'container',
      authPath: containerPlan.containerCredential.authMode,
      credentialSource: containerPlan.containerCredential.credentialSource,
      routeReason: input.routeReason,
      plannerReason: input.mainPlan.policy,
      providerId: input.agent.provider_id,
      modelId: input.agent.model_id,
    };
  }

  if (input.backend === 'host_codex') {
    const hostCodexPlan = input.mainPlan.hostCodexPlan;
    if (!hostCodexPlan) {
      throw new Error('Missing Codex host plan for Main execution decision');
    }
    return {
      backend: 'host_codex',
      authPath: hostCodexPlan.authPath,
      credentialSource: hostCodexPlan.credentialSource,
      routeReason: input.routeReason,
      plannerReason: input.mainPlan.policy,
      providerId: input.agent.provider_id,
      modelId: input.agent.model_id,
    };
  }

  const directPlan = input.mainPlan.directPlan;
  if (!directPlan) {
    throw new Error('Missing direct plan for Main execution decision');
  }
  return {
    backend: 'direct_http',
    authPath: directPlan.authPath,
    credentialSource: directPlan.credentialSource,
    routeReason: input.routeReason,
    plannerReason: input.mainPlan.policy,
    providerId: input.agent.provider_id,
    modelId: input.agent.model_id,
  };
}

function buildPromotionHandoffSection(
  promotionRequest: MainPromotionRequest,
): string {
  return [
    'This Main turn was promoted into container execution because heavy tools are required.',
    '',
    `Task description: ${promotionRequest.taskDescription}`,
    promotionRequest.handoffNote
      ? `Additional note: ${promotionRequest.handoffNote}`
      : null,
    `Required tool families: ${promotionRequest.requiredToolFamilies.join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ============================================================================
// Main Executor (worker-owned terminal writes; persists context snapshot only)
// ============================================================================

export async function executeMainChannel(
  input: MainExecutorInput,
  signal: AbortSignal,
  emit?: (event: MainExecutionEvent) => void,
): Promise<MainExecutorOutput> {
  const emitEvent = emit || (() => {});
  const startTime = Date.now();

  // --- Step 1: Resolve agent ---
  let agent: RegisteredAgentRecord | undefined;
  if (input.targetAgentId) {
    agent = getRegisteredAgent(input.targetAgentId);
  }
  if (!agent) {
    agent = getMainAgent();
  }

  if (!agent) {
    throw new Error('No agent available for Main channel');
  }

  const mainPlan = planMainExecution(agent, input.requestedBy);
  const runRecord = getTalkRunById(input.runId);
  const runTaskType = runRecord ? getTalkRunTaskType(runRecord) : 'chat';
  const intendedTransport =
    runTaskType === 'browser' &&
    (runRecord?.transport === 'direct' ||
      runRecord?.transport === 'subscription')
      ? runRecord.transport
      : runTaskType === 'browser'
        ? null
        : runRecord?.transport === 'direct' ||
            runRecord?.transport === 'subscription'
          ? runRecord.transport
          : null;
  const runMetadata = parseObject(runRecord?.metadata_json);
  const timingMetadata = parseRunTimingMetadata(runMetadata);
  const browserResumeSection = buildBrowserResumeSection(runMetadata);
  const promotedRun =
    runMetadata.kind === 'main_promotion'
      ? ({
          taskDescription:
            typeof runMetadata.taskDescription === 'string'
              ? runMetadata.taskDescription
              : '',
          requiredToolFamilies: Array.isArray(runMetadata.requestedToolFamilies)
            ? runMetadata.requestedToolFamilies.filter(
                (entry): entry is 'shell' | 'filesystem' =>
                  entry === 'shell' || entry === 'filesystem',
              )
            : [],
          userVisibleSummary:
            typeof runMetadata.userVisibleSummary === 'string'
              ? runMetadata.userVisibleSummary
              : 'Background task',
          handoffNote:
            typeof runMetadata.handoffNote === 'string'
              ? runMetadata.handoffNote
              : null,
          requiresApproval: false,
        } satisfies MainPromotionRequest)
      : null;
  let useHostCodex = mainPlan.policy === 'host_codex_only';
  const executionStrategy: MainExecutionStrategy = shouldUseBrowserFastLane({
    triggerContent: input.triggerContent,
    mainPlan,
    promotedRun,
    useHostCodex,
  })
    ? 'browser_fast_lane'
    : 'generic_agent_loop';
  let shouldUseContainer =
    Boolean(promotedRun) || mainPlan.policy === 'container_only';
  if (runTaskType === 'browser') {
    if (intendedTransport === 'direct') {
      if (!mainPlan.directPlan) {
        throw new Error(
          'Direct plan unavailable for browser run. The credential may have been removed after the run was created.',
        );
      }
      useHostCodex = false;
      shouldUseContainer = false;
    } else if (intendedTransport === 'subscription') {
      if (!mainPlan.containerPlan) {
        throw new Error(
          'Container plan unavailable for browser run. The subscription credential may have been removed after the run was created.',
        );
      }
      useHostCodex = false;
      shouldUseContainer = true;
    } else {
      throw new Error(
        `Invalid transport '${String(runRecord?.transport ?? null)}' for browser run.`,
      );
    }
  }
  const routeReason = deriveRouteReason({
    strategy: executionStrategy,
    shouldUseContainer,
    useHostCodex,
    mainPlan,
  });
  const backend = useHostCodex
    ? 'host_codex'
    : shouldUseContainer
      ? 'container'
      : 'direct_http';
  const useWarmSubscriptionWorker =
    runTaskType !== 'browser' &&
    shouldUseContainer &&
    routeReason === 'subscription_fallback' &&
    MAIN_SUBSCRIPTION_WARM_WORKER_ENABLED;
  const executorStartedAt = new Date().toISOString();
  const queueStartedAtMs = parseIsoMs(
    timingMetadata.queueStartedAt || timingMetadata.enqueuedAt,
  );

  updateRunTiming(input.runId, {
    queueStartedAt:
      typeof timingMetadata.queueStartedAt === 'string'
        ? timingMetadata.queueStartedAt
        : typeof timingMetadata.enqueuedAt === 'string'
          ? timingMetadata.enqueuedAt
          : null,
    executorStartedAt,
  });
  if (runTaskType === 'browser') {
    setRunBrowserPhase(input.runId, 'starting');
  }
  updateRunStateMetadata(input.runId, {
    executionStrategy,
    routeReason,
    leaseState: null,
    timeoutPhase: null,
    currentStep:
      executionStrategy === 'browser_fast_lane'
        ? shouldUseContainer
          ? useWarmSubscriptionWorker
            ? 'Preparing warm subscription browser run…'
            : 'Starting Claude subscription runtime…'
          : 'Starting browser-first model…'
        : shouldUseContainer
          ? useWarmSubscriptionWorker
            ? 'Preparing warm subscription worker…'
            : routeReason === 'subscription_fallback'
              ? 'Starting Claude subscription runtime…'
              : 'Starting container runtime…'
          : useHostCodex
            ? 'Starting host runtime…'
            : 'Starting model…',
  });

  if (
    queueStartedAtMs &&
    Date.parse(executorStartedAt) - queueStartedAtMs >
      MAIN_RUN_QUEUE_START_BUDGET_MS
  ) {
    throw new MainRunPhaseTimeoutError(
      'queue_to_executor_start',
      'The run waited too long in the queue before execution started.',
    );
  }

  emitEvent({
    type: 'main_response_started',
    runId: input.runId,
    threadId: input.threadId,
    agentId: agent.id,
    agentName: agent.name,
  });

  // --- Step 2: Load thread-scoped Main memory context ---
  const modelContextWindow = getModelContextWindow(agent);
  const mainContext = loadMainContext(
    input.threadId,
    modelContextWindow,
    input.triggerMessageId,
  );
  updateTalkRunMetadata(input.runId, (current) => ({
    ...current,
    ...mainContext.contextSnapshot,
    executionDecision: buildExecutionDecisionForMain({
      agent,
      mainPlan,
      backend,
      routeReason,
    }),
    executionStrategy,
    routeReason,
    renderer: backend,
    executionPolicy: mainPlan.policy,
  }));

  // --- Step 3: Execute via agent router ---
  // Main channel has web tools but no context-source or connector tools.
  const projectMountHostPath = resolveValidatedProjectMountPath(
    getSettingValue(EXECUTOR_MAIN_PROJECT_PATH_KEY),
    true,
  );
  let systemPrompt = agent.system_prompt?.trim() || '';
  if (mainContext.summaryText) {
    systemPrompt = appendSystemSection(
      systemPrompt,
      'Main Thread Context',
      mainContext.summaryText,
    );
  }
  if (browserResumeSection) {
    systemPrompt = appendSystemSection(
      systemPrompt,
      'Browser Resume Context',
      browserResumeSection,
    );
  }
  if (promotedRun) {
    systemPrompt = appendSystemSection(
      systemPrompt,
      'Promotion Handoff',
      buildPromotionHandoffSection(promotedRun),
    );
  }
  if (executionStrategy === 'browser_fast_lane') {
    systemPrompt = appendSystemSection(
      systemPrompt,
      'Browser Fast Lane',
      buildBrowserFastLaneSection(),
    );
  }

  const executionSignalControl = createChildSignal(signal);
  const executionSignal = executionSignalControl.signal;
  let phaseTimeoutError: MainRunPhaseTimeoutError | null = null;
  const budgetTimers = new Set<ReturnType<typeof setTimeout>>();
  let firstMeaningfulProgressRecorded = false;
  let firstBrowserEventRecorded = false;
  let firstPageReadyRecorded = false;

  const clearBudgetTimer = (timer: ReturnType<typeof setTimeout> | null) => {
    if (!timer) return;
    clearTimeout(timer);
    budgetTimers.delete(timer);
  };
  const clearAllBudgetTimers = () => {
    for (const timer of budgetTimers) {
      clearTimeout(timer);
    }
    budgetTimers.clear();
  };
  const triggerTimeout = (
    timeoutPhase:
      | 'lease_queue'
      | 'lease_boot'
      | 'first_progress'
      | 'first_page_ready'
      | 'worker_unresponsive'
      | 'total_run',
    message: string,
  ) => {
    if (phaseTimeoutError) return;
    phaseTimeoutError = new MainRunPhaseTimeoutError(timeoutPhase, message);
    executionSignalControl.abort(phaseTimeoutError);
  };
  const scheduleBudgetTimer = (
    timeoutMs: number,
    timeoutPhase:
      | 'lease_queue'
      | 'lease_boot'
      | 'first_progress'
      | 'first_page_ready'
      | 'worker_unresponsive'
      | 'total_run',
    message: string,
  ) => {
    const timer = setTimeout(
      () => triggerTimeout(timeoutPhase, message),
      timeoutMs,
    );
    budgetTimers.add(timer);
    return timer;
  };
  const resetBudgetTimer = (
    current: ReturnType<typeof setTimeout> | null,
    timeoutMs: number,
    timeoutPhase:
      | 'lease_queue'
      | 'lease_boot'
      | 'first_progress'
      | 'first_page_ready'
      | 'worker_unresponsive'
      | 'total_run',
    message: string,
  ) => {
    clearBudgetTimer(current);
    return scheduleBudgetTimer(timeoutMs, timeoutPhase, message);
  };
  let leaseQueueTimer: ReturnType<typeof setTimeout> | null = null;
  let leaseBootTimer: ReturnType<typeof setTimeout> | null = null;
  let firstProgressTimer: ReturnType<typeof setTimeout> | null = null;
  let firstPageReadyTimer: ReturnType<typeof setTimeout> | null = null;
  let totalBudgetTimer: ReturnType<typeof setTimeout> | null = null;
  const markMeaningfulProgress = () => {
    if (firstMeaningfulProgressRecorded) {
      return;
    }
    firstMeaningfulProgressRecorded = true;
    clearBudgetTimer(firstProgressTimer);
    firstProgressTimer = null;
  };
  const markFirstBrowserEvent = () => {
    markMeaningfulProgress();
    if (firstBrowserEventRecorded) {
      return;
    }
    firstBrowserEventRecorded = true;
    updateRunTiming(input.runId, {
      firstBrowserEventAt: new Date().toISOString(),
    });
  };
  const markFirstPageReady = (currentStep?: string) => {
    if (firstPageReadyRecorded) {
      return;
    }
    firstPageReadyRecorded = true;
    clearBudgetTimer(firstPageReadyTimer);
    firstPageReadyTimer = null;
    updateRunTiming(input.runId, {
      firstPageReadyAt: new Date().toISOString(),
    });
    if (runTaskType === 'browser') {
      setRunBrowserPhase(input.runId, 'interacting');
    }
    if (currentStep) {
      emitEvent({
        type: 'main_progress_update',
        runId: input.runId,
        threadId: input.threadId,
        message: currentStep,
      });
    }
  };
  const startFirstProgressBudget = () => {
    if (firstProgressTimer || firstMeaningfulProgressRecorded) {
      return;
    }
    firstProgressTimer = scheduleBudgetTimer(
      MAIN_RUN_FIRST_PROGRESS_BUDGET_MS,
      'first_progress',
      'The run did not produce provider or browser progress quickly enough.',
    );
  };
  const startFirstPageReadyBudget = () => {
    if (
      executionStrategy !== 'browser_fast_lane' ||
      firstPageReadyTimer ||
      firstPageReadyRecorded
    ) {
      return;
    }
    firstPageReadyTimer = scheduleBudgetTimer(
      MAIN_RUN_FIRST_PAGE_READY_BUDGET_MS,
      'first_page_ready',
      'The browser did not reach a usable page state quickly enough.',
    );
  };
  const setCurrentStep = (message: string) => {
    emitEvent({
      type: 'main_progress_update',
      runId: input.runId,
      threadId: input.threadId,
      message,
    });
  };
  const unsubscribeBrowserBridgeEvents =
    shouldUseContainer &&
    toolFamilyEnabled(mainPlan.effectiveTools, 'browser') &&
    input.requestedBy
      ? subscribeBrowserBridgeRunEvents(input.runId, (event) => {
          if (event.type === 'activity') {
            markFirstBrowserEvent();
            startFirstPageReadyBudget();
            switch (event.toolName) {
              case 'browser_open':
                setCurrentStep('Opening LinkedIn…');
                break;
              case 'browser_snapshot':
                setCurrentStep('Inspecting page…');
                break;
              case 'browser_wait':
                setCurrentStep('Waiting for page state…');
                break;
              default:
                setCurrentStep('Interacting with page…');
                break;
            }
          } else if (event.type === 'page_ready') {
            markFirstPageReady(event.currentStep);
          }
        })
      : null;

  if (!shouldUseContainer) {
    startFirstProgressBudget();
  }
  if (executionStrategy === 'browser_fast_lane' && !shouldUseContainer) {
    startFirstPageReadyBudget();
  }
  if (executionStrategy === 'browser_fast_lane' && !useWarmSubscriptionWorker) {
    const totalMs = shouldUseContainer
      ? MAIN_RUN_SUBSCRIPTION_FALLBACK_TOTAL_BUDGET_MS
      : MAIN_RUN_FAST_LANE_TOTAL_BUDGET_MS;
    totalBudgetTimer = scheduleBudgetTimer(
      totalMs,
      'total_run',
      shouldUseContainer
        ? 'The container browser run exceeded its maximum time budget.'
        : 'The browser fast-lane run exceeded its maximum time budget.',
    );
  } else if (
    shouldUseContainer &&
    routeReason === 'subscription_fallback' &&
    !useWarmSubscriptionWorker
  ) {
    totalBudgetTimer = scheduleBudgetTimer(
      MAIN_RUN_SUBSCRIPTION_FALLBACK_TOTAL_BUDGET_MS,
      'total_run',
      'The subscription fallback run exceeded its maximum time budget.',
    );
  }
  try {
    if (shouldUseContainer) {
      if (
        runTaskType === 'browser' &&
        intendedTransport === 'subscription' &&
        getContainerRuntimeStatus({ refresh: true }) !== 'ready'
      ) {
        throw new Error(
          'Claude container runtime is unavailable on this host. Start Docker before using subscription mode for browser runs.',
        );
      }
      const containerPlan = mainPlan.containerPlan;
      if (!containerPlan) {
        throw new Error(
          'Main container execution is not configured for this agent',
        );
      }
      const containerEffectiveTools = promotedRun
        ? containerPlan.effectiveTools.filter(
            (tool) =>
              tool.toolFamily === 'web' ||
              tool.toolFamily === 'browser' ||
              promotedRun.requiredToolFamilies.includes(
                tool.toolFamily as 'shell' | 'filesystem',
              ),
          )
        : containerPlan.effectiveTools;
      const containerTurnInput: ExecuteContainerTurnInput = {
        runId: input.runId,
        userId: input.requestedBy,
        agent,
        promptLabel: 'main' as const,
        userMessage: renderMainPromptPayload(mainContext, input.triggerContent),
        signal: executionSignal,
        allowedTools: getContainerAllowedTools({
          effectiveTools: containerEffectiveTools,
        }),
        context: {
          systemPrompt,
          history: mainContext.history,
        },
        modelContextWindow,
        containerCredential: containerPlan.containerCredential,
        threadId: input.threadId,
        projectMountHostPath,
        enableBrowserTools: containerEffectiveTools.some(
          (tool) => tool.toolFamily === 'browser' && tool.enabled,
        ),
        timeoutProfile:
          executionStrategy === 'browser_fast_lane' ? 'fast_lane' : 'default',
      };

      let result:
        | ExecuteContainerTurnOutput
        | (ExecuteContainerTurnOutput & {
            leaseState?: MainRunLeaseState | null;
            timing?: Record<string, unknown>;
          });

      if (useWarmSubscriptionWorker) {
        updateRunTiming(input.runId, {
          leaseRequestedAt: new Date().toISOString(),
        });
        setCurrentStep('Starting warm subscription worker…');
        let leaseRequestedAtMs = Date.now();
        const runWarmAttempt = async (
          recoveryMode: 'normal' | 'recovered_cold_boot',
        ) =>
          executeWarmMainSubscriptionTurn({
            turn: containerTurnInput,
            timeoutProfile: containerTurnInput.timeoutProfile ?? 'default',
            recoveryMode,
            callbacks: {
              onQueueWaitStart: (at) => {
                leaseRequestedAtMs = Date.parse(at);
                setCurrentStep('Waiting for warm subscription worker…');
                leaseQueueTimer = resetBudgetTimer(
                  leaseQueueTimer,
                  MAIN_RUN_LEASE_QUEUE_BUDGET_MS,
                  'lease_queue',
                  'The run waited too long for an available warm subscription worker.',
                );
              },
              onLeaseBootStart: ({ at, leaseState }) => {
                updateRunTiming(input.runId, {
                  leaseRequestedAt:
                    typeof at === 'string' ? at : new Date().toISOString(),
                });
                clearBudgetTimer(leaseQueueTimer);
                leaseQueueTimer = null;
                leaseBootTimer = resetBudgetTimer(
                  leaseBootTimer,
                  MAIN_RUN_LEASE_BOOT_BUDGET_MS,
                  'lease_boot',
                  'The warm subscription worker took too long to start.',
                );
                setCurrentStep(
                  leaseState === 'recovered_cold_boot'
                    ? 'Recovering warm subscription worker…'
                    : 'Starting warm subscription worker…',
                );
                updateRunStateMetadata(input.runId, {
                  leaseState,
                });
              },
              onLeaseReady: ({ at, leaseState }) => {
                clearBudgetTimer(leaseQueueTimer);
                clearBudgetTimer(leaseBootTimer);
                leaseQueueTimer = null;
                leaseBootTimer = null;
                updateRunStateMetadata(input.runId, {
                  leaseState,
                });
                updateRunTiming(input.runId, {
                  leaseReadyAt: at,
                });
                setCurrentStep(
                  leaseState === 'warm_reuse'
                    ? 'Reusing warm subscription worker…'
                    : leaseState === 'recovered_cold_boot'
                      ? 'Recovered warm subscription worker.'
                      : 'Warm subscription worker ready.',
                );
                const elapsedMs = Math.max(
                  0,
                  Date.parse(at) - leaseRequestedAtMs,
                );
                const totalBudgetMs =
                  leaseState === 'warm_reuse'
                    ? MAIN_RUN_WARM_SUBSCRIPTION_TOTAL_BUDGET_MS
                    : MAIN_RUN_COLD_SUBSCRIPTION_TOTAL_BUDGET_MS;
                totalBudgetTimer = resetBudgetTimer(
                  totalBudgetTimer,
                  Math.max(1, totalBudgetMs - elapsedMs),
                  'total_run',
                  leaseState === 'warm_reuse'
                    ? 'The warm subscription run exceeded its maximum time budget.'
                    : 'The cold-start subscription run exceeded its maximum time budget.',
                );
              },
              onTaskDispatched: (at) => {
                updateRunTiming(input.runId, {
                  taskDispatchedAt: at,
                });
                startFirstProgressBudget();
                startFirstPageReadyBudget();
                setCurrentStep('Opening LinkedIn…');
              },
              onWorkerProgress: (at) => {
                markMeaningfulProgress();
                updateRunTiming(input.runId, {
                  firstProviderEventAt: at,
                });
              },
            },
          });

        try {
          result = await runWarmAttempt('normal');
        } catch (error) {
          if (!(error instanceof MainSubscriptionWorkerManagerError)) {
            throw error;
          }
          if (phaseTimeoutError) {
            throw phaseTimeoutError;
          }
          try {
            result = await runWarmAttempt('recovered_cold_boot');
          } catch (retryError) {
            if (phaseTimeoutError) {
              throw phaseTimeoutError;
            }
            updateRunStateMetadata(input.runId, {
              leaseState: 'one_shot_fallback',
            });
            setCurrentStep('Falling back to one-shot subscription runtime…');
            totalBudgetTimer = resetBudgetTimer(
              totalBudgetTimer,
              MAIN_RUN_SUBSCRIPTION_FALLBACK_TOTAL_BUDGET_MS,
              'total_run',
              'The subscription fallback run exceeded its maximum time budget.',
            );
            result = await executeContainerAgentTurn(containerTurnInput).catch(
              (fallbackError) => {
                if (phaseTimeoutError) {
                  throw phaseTimeoutError;
                }
                if (
                  retryError instanceof MainSubscriptionWorkerManagerError &&
                  retryError.code === 'worker_unresponsive'
                ) {
                  throw new MainRunPhaseTimeoutError(
                    'worker_unresponsive',
                    retryError.message,
                  );
                }
                throw fallbackError;
              },
            );
          }
        }
      } else {
        result = await executeContainerAgentTurn(containerTurnInput).catch(
          (error) => {
            if (phaseTimeoutError) {
              throw phaseTimeoutError;
            }
            throw error;
          },
        );
      }

      clearBudgetTimer(totalBudgetTimer);
      clearBudgetTimer(leaseQueueTimer);
      clearBudgetTimer(leaseBootTimer);
      updateRunTiming(input.runId, {
        completedAt: new Date().toISOString(),
        ...(('timing' in result && result.timing) || {}),
      });
      if ('leaseState' in result && result.leaseState) {
        updateRunStateMetadata(input.runId, {
          leaseState: result.leaseState,
        });
      }
      return {
        content: result.content,
        agentId: agent.id,
        agentName: agent.name,
        providerId: agent.provider_id,
        modelId: agent.model_id,
        threadId: input.threadId,
        latencyMs: Date.now() - startTime,
        promotionRequest: null,
      };
    }

    if (useHostCodex) {
      const hostCodexPlan = mainPlan.hostCodexPlan;
      if (!hostCodexPlan) {
        throw new Error(
          'Main Codex host execution is not configured for this agent',
        );
      }
      const result = await executeCodexAgentTurn({
        runId: input.runId,
        userId: input.requestedBy,
        agent,
        promptLabel: 'main',
        userMessage: renderMainPromptPayload(mainContext, input.triggerContent),
        signal: executionSignal,
        context: {
          systemPrompt,
          history: mainContext.history,
        },
        modelContextWindow,
        threadId: input.threadId,
        projectMountHostPath,
        enableWebTools: hostCodexPlan.effectiveTools.some(
          (tool) => tool.toolFamily === 'web' && tool.enabled,
        ),
        enableBrowserTools: hostCodexPlan.effectiveTools.some(
          (tool) => tool.toolFamily === 'browser' && tool.enabled,
        ),
        onProgressUpdate: (message) => {
          markMeaningfulProgress();
          emitEvent({
            type: 'main_progress_update',
            runId: input.runId,
            threadId: input.threadId,
            message,
          });
        },
      }).catch((error) => {
        if (phaseTimeoutError) {
          throw phaseTimeoutError;
        }
        throw error;
      });

      clearBudgetTimer(firstProgressTimer);
      clearBudgetTimer(totalBudgetTimer);
      if (
        result.usage?.inputTokens !== undefined ||
        result.usage?.cachedInputTokens !== undefined ||
        result.usage?.outputTokens !== undefined
      ) {
        emitEvent({
          type: 'main_response_usage',
          runId: input.runId,
          threadId: input.threadId,
          usage: {
            inputTokens: result.usage.inputTokens ?? 0,
            cachedInputTokens: result.usage.cachedInputTokens,
            outputTokens: result.usage.outputTokens ?? 0,
          },
        });
      }

      updateRunTiming(input.runId, {
        completedAt: new Date().toISOString(),
      });
      return {
        content: result.content,
        agentId: agent.id,
        agentName: agent.name,
        providerId: agent.provider_id,
        modelId: agent.model_id,
        threadId: input.threadId,
        latencyMs: Date.now() - startTime,
        promotionRequest: null,
        usage: result.usage
          ? {
              inputTokens: result.usage.inputTokens ?? 0,
              cachedInputTokens: result.usage.cachedInputTokens,
              outputTokens: result.usage.outputTokens ?? 0,
            }
          : undefined,
      };
    }

    if (!mainPlan.directPlan) {
      throw new Error('Main direct execution is not configured for this agent');
    }

    let firstProviderEventRecorded = false;
    let firstTokenRecorded = false;
    let promotionRequest: MainPromotionRequest | null = null;
    const browserTools = toolFamilyEnabled(mainPlan.effectiveTools, 'browser')
      ? BROWSER_TOOL_DEFINITIONS
      : [];
    const webTools = toolFamilyEnabled(mainPlan.effectiveTools, 'web')
      ? WEB_TOOL_DEFINITIONS
      : [];
    const directContextTools =
      executionStrategy === 'browser_fast_lane'
        ? [...browserTools, ...webTools]
        : [...webTools, ...browserTools];
    let directSystemPrompt = buildMainSystemPrompt(mainContext.summaryText);
    if (browserResumeSection) {
      directSystemPrompt = appendSystemSection(
        directSystemPrompt,
        'Browser Resume Context',
        browserResumeSection,
      );
    }
    if (promotedRun) {
      directSystemPrompt = appendSystemSection(
        directSystemPrompt,
        'Promotion Handoff',
        buildPromotionHandoffSection(promotedRun),
      );
    }
    if (executionStrategy === 'browser_fast_lane') {
      directSystemPrompt = appendSystemSection(
        directSystemPrompt,
        'Browser Fast Lane',
        buildBrowserFastLaneSection(),
      );
    }
    const context: ExecutionContext = {
      systemPrompt: directSystemPrompt,
      contextTools:
        mainPlan.policy === 'direct_with_promotion'
          ? [...directContextTools, REQUEST_HEAVY_EXECUTION_TOOL]
          : directContextTools,
      connectorTools: [],
      history: mainContext.history,
    };
    const result = await executeWithAgent(
      agent.id,
      context,
      input.triggerContent,
      {
        runId: input.runId,
        userId: input.requestedBy,
        signal: executionSignal,
        maxToolIterations:
          executionStrategy === 'browser_fast_lane'
            ? BROWSER_FAST_LANE_MAX_TOOL_ITERATIONS
            : undefined,
        toolIterationLimitFallback:
          executionStrategy === 'browser_fast_lane'
            ? 'I reached the browser fast-lane step limit before a fuller response was available. Based on the steps completed so far, the page state should be treated as the current result.'
            : undefined,
        alwaysAllowedContextToolNames:
          mainPlan.policy === 'direct_with_promotion'
            ? [REQUEST_HEAVY_EXECUTION_TOOL.name]
            : undefined,
        emit: (event: ExecutionEvent) => {
          if (
            !firstProviderEventRecorded &&
            (event.type === 'text_delta' ||
              event.type === 'tool_call' ||
              event.type === 'tool_result' ||
              event.type === 'usage')
          ) {
            firstProviderEventRecorded = true;
            markMeaningfulProgress();
            updateRunTiming(input.runId, {
              firstProviderEventAt: new Date().toISOString(),
            });
          }
          if (event.type === 'text_delta') {
            if (!firstTokenRecorded) {
              firstTokenRecorded = true;
              updateRunTiming(input.runId, {
                firstTokenAt: new Date().toISOString(),
              });
            }
            emitEvent({
              type: 'main_response_delta',
              runId: input.runId,
              threadId: input.threadId,
              text: event.text,
            });
          } else if (event.type === 'usage') {
            emitEvent({
              type: 'main_response_usage',
              runId: input.runId,
              threadId: input.threadId,
              usage: {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                estimatedCostUsd: event.estimatedCostUsd,
              },
            });
          }
        },
        executeToolCall: buildMainToolExecutor({
          signal: executionSignal,
          input,
          mainPlan,
          timeoutProfile:
            executionStrategy === 'browser_fast_lane' ? 'fast_lane' : 'default',
          onBrowserActivity: () => {
            markFirstBrowserEvent();
          },
          onBrowserPageReady: () => {
            markFirstPageReady('Reading page access…');
          },
          onProgressRequested: (message) => {
            markMeaningfulProgress();
            emitEvent({
              type: 'main_progress_update',
              runId: input.runId,
              threadId: input.threadId,
              message,
            });
          },
          onPromotionRequested: (request) => {
            promotionRequest = request;
            updateTalkRunMetadata(input.runId, (current) => ({
              ...current,
              promotionRequested: true,
              promotionState: 'pending',
              promotionChildRunId: null,
              requestedToolFamilies: request.requiredToolFamilies,
              userVisibleSummary: request.userVisibleSummary,
            }));
            emitEvent({
              type: 'main_promotion_pending',
              runId: input.runId,
              threadId: input.threadId,
              requestedToolFamilies: request.requiredToolFamilies,
              userVisibleSummary: request.userVisibleSummary,
            });
          },
        }),
      },
    ).catch((error) => {
      if (phaseTimeoutError) {
        throw phaseTimeoutError;
      }
      throw error;
    });

    clearBudgetTimer(firstProgressTimer);
    clearBudgetTimer(firstPageReadyTimer);
    clearBudgetTimer(totalBudgetTimer);
    updateRunTiming(input.runId, {
      completedAt: new Date().toISOString(),
    });
    return {
      content: result.content,
      agentId: agent.id,
      agentName: agent.name,
      providerId: agent.provider_id,
      modelId: agent.model_id,
      threadId: input.threadId,
      latencyMs: Date.now() - startTime,
      promotionRequest,
      usage: result.usage,
    };
  } finally {
    clearAllBudgetTimers();
    executionSignalControl.cleanup();
    unsubscribeBrowserBridgeEvents?.();
  }
}

// ============================================================================
// Main Tool Executor
// ============================================================================

/**
 * Build the executeToolCall callback for the Main channel.
 * Main supports direct web/browser tools plus promotion requests — no context sources or connectors.
 */
function buildMainToolExecutor(input: {
  signal: AbortSignal;
  input: MainExecutorInput;
  mainPlan: MainExecutionPlan;
  timeoutProfile: BrowserTimeoutProfile;
  onBrowserActivity: () => void;
  onBrowserPageReady: () => void;
  onProgressRequested: (message: string) => void;
  onPromotionRequested: (request: MainPromotionRequest) => void;
}) {
  let promotionRequested = false;
  return async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ result: string; isError?: boolean }> => {
    if (toolName === 'web_fetch') {
      if (!toolFamilyEnabled(input.mainPlan.effectiveTools, 'web')) {
        return {
          result: "Tool 'web_fetch' is not enabled for this Main agent",
          isError: true,
        };
      }
      return executeWebFetch(args, input.signal);
    }
    if (toolName === 'web_search') {
      if (!toolFamilyEnabled(input.mainPlan.effectiveTools, 'web')) {
        return {
          result: "Tool 'web_search' is not enabled for this Main agent",
          isError: true,
        };
      }
      return executeWebSearch(args, input.signal);
    }
    if (toolName.startsWith('browser_')) {
      if (!toolFamilyEnabled(input.mainPlan.effectiveTools, 'browser')) {
        return {
          result: `Tool '${toolName}' is not enabled for this Main agent`,
          isError: true,
        };
      }
      input.onBrowserActivity();
      return executeBrowserTool({
        toolName,
        args,
        context: {
          signal: input.signal,
          userId: input.input.requestedBy,
          runId: input.input.runId,
          onProgress: input.onProgressRequested,
          timeoutProfile: input.timeoutProfile,
          onPageReady: input.onBrowserPageReady,
        },
      });
    }
    if (toolName === REQUEST_HEAVY_EXECUTION_TOOL.name) {
      if (input.mainPlan.policy !== 'direct_with_promotion') {
        return {
          result:
            'Heavy execution promotion is not available for this Main run.',
          isError: true,
        };
      }
      if (!input.mainPlan.containerPlan) {
        return {
          result: 'Heavy execution is not configured for this Main agent.',
          isError: true,
        };
      }
      const validated = validatePromotionRequest(args, input.mainPlan);
      if (!validated.ok) {
        return {
          result: `Retry request_heavy_execution with a shorter valid handoff. ${validated.error}`,
          isError: true,
        };
      }
      if (promotionRequested) {
        return {
          result:
            'Heavy execution has already been requested for this Main turn.',
          isError: true,
        };
      }
      promotionRequested = true;
      input.onPromotionRequested(validated.value);
      return {
        result: `Heavy execution requested: ${validated.value.userVisibleSummary}`,
      };
    }

    return {
      result: `Tool '${toolName}' is not available in Main channel execution`,
      isError: true,
    };
  };
}
