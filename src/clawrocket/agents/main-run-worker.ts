/**
 * MainRunWorker — polling worker that claims and executes Main channel runs.
 *
 * Mirrors the TalkRunWorker pattern but simplified:
 * - No promotion (Main has no run queue per-thread beyond one-active guard)
 * - No channel delivery
 * - Events publish to `user:${requestedBy}` (not `talk:${talkId}`)
 * - Response content sanitized via TalkResponseStreamSanitizer + stripInternalTalkResponseText
 */

import { randomUUID } from 'crypto';

import { getDb } from '../../db.js';
import { TALK_RUN_MAX_CONCURRENCY, TALK_RUN_POLL_MS } from '../config.js';
import {
  appendOutboxEvent,
  claimQueuedMainRuns,
  completeMainRunAtomic,
  createMainPromotionRunAtomic,
  failInterruptedMainRunsOnStartup,
  failMainRunAtomic,
  getTalkRunTaskType,
  getUnambiguousPausedMainBrowserOwner,
  getTalkMessageById,
  getTalkRunById,
  pauseRunForBrowserBlock,
  upsertSettingValue,
  updateTalkRunMetadata,
  type TalkRunRecord,
} from '../db/index.js';
import { logger } from '../../logger.js';
import { BrowserRunPausedError } from '../browser/run-paused-error.js';
import {
  createTalkResponseStreamSanitizer,
  stripInternalTalkResponseText,
} from '../talks/internal-tags.js';
import {
  executeMainChannel,
  MainRunPhaseTimeoutError,
  type MainExecutionEvent,
} from './main-executor.js';
import { refreshMainThreadSummary } from './main-context-loader.js';
import { getBrowserService } from '../browser/service.js';

// ============================================================================
// Types
// ============================================================================

export type MainExecutorFn = typeof executeMainChannel;

export interface MainRunWorkerOptions {
  pollMs?: number;
  maxConcurrency?: number;
  heartbeatMs?: number;
  /** Override executor for testing. Defaults to executeMainChannel. */
  executor?: MainExecutorFn;
}

export interface MainRunWorkerControl {
  wake(): void;
  cancelRun(runId: string): void;
}

// ============================================================================
// Worker
// ============================================================================

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown main execution failure';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function getTypedBrowserRunTransport(
  run: TalkRunRecord,
): 'direct' | 'subscription' | null {
  return run.transport === 'direct' || run.transport === 'subscription'
    ? run.transport
    : null;
}

function isDirectBrowserAuthFailure(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes('anthropic api error: unauthorized') ||
    normalized.includes('anthropic api error: forbidden') ||
    normalized.includes('invalid api key') ||
    normalized.includes('invalid_api_key') ||
    /\b401\b/.test(normalized) ||
    /\b403\b/.test(normalized)
  );
}

function isSubscriptionBrowserBootstrapFailure(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes('claude container runtime is unavailable') ||
    normalized.includes('container runtime is unavailable') ||
    normalized.includes(
      'container execution requires an executor oauth/auth token',
    ) ||
    normalized.includes('subscription credential may have been removed') ||
    normalized.includes('unauthorized') ||
    normalized.includes('invalid_api_key') ||
    /\b401\b/.test(normalized) ||
    /\b403\b/.test(normalized)
  );
}

function invalidateAnthropicBrowserVerification(lastError: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO llm_provider_verifications (
         provider_id, status, last_verified_at, last_error, updated_at
       ) VALUES ('provider.anthropic', 'invalid', NULL, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         status = 'invalid',
         last_verified_at = NULL,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
    )
    .run(lastError, now);
}

function invalidateSubscriptionBrowserVerification(
  updatedBy: string,
  lastError: string,
): void {
  upsertSettingValue({
    key: 'executor.verificationStatus',
    value: 'not_verified',
    updatedBy,
  });
  upsertSettingValue({
    key: 'executor.lastVerifiedAt',
    value: null,
    updatedBy,
  });
  upsertSettingValue({
    key: 'executor.lastVerificationError',
    value: lastError,
    updatedBy,
  });
  upsertSettingValue({
    key: 'executor.lastVerificationMode',
    value: null,
    updatedBy,
  });
  upsertSettingValue({
    key: 'executor.lastVerificationMethod',
    value: null,
    updatedBy,
  });
}

function maybeInvalidateBrowserReadiness(
  run: TalkRunRecord,
  failureMessage: string,
): void {
  if (getTalkRunTaskType(run) !== 'browser') {
    return;
  }
  const transport = getTypedBrowserRunTransport(run);
  if (transport === 'direct' && isDirectBrowserAuthFailure(failureMessage)) {
    invalidateAnthropicBrowserVerification(failureMessage);
    return;
  }
  if (
    transport === 'subscription' &&
    isSubscriptionBrowserBootstrapFailure(failureMessage)
  ) {
    invalidateSubscriptionBrowserVerification(run.requested_by, failureMessage);
  }
}

const STREAMED_TEXT_PREVIEW_MAX_CHARS = 4_000;
const STREAMED_TEXT_PERSIST_INTERVAL_MS = 1_000;
const MAIN_RUN_HEARTBEAT_INTERVAL_MS = 10_000;

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

function appendStreamedPreview(currentPreview: string, delta: string): string {
  if (!delta) return currentPreview;
  const nextPreview = `${currentPreview}${delta}`;
  if (nextPreview.length <= STREAMED_TEXT_PREVIEW_MAX_CHARS) {
    return nextPreview;
  }
  return nextPreview.slice(
    nextPreview.length - STREAMED_TEXT_PREVIEW_MAX_CHARS,
  );
}

function parseRequestedToolFamilies(run: TalkRunRecord): string[] {
  if (!run.metadata_json) return [];
  try {
    const parsed = JSON.parse(run.metadata_json) as {
      requestedToolFamilies?: unknown;
    };
    if (!Array.isArray(parsed.requestedToolFamilies)) {
      return [];
    }
    return parsed.requestedToolFamilies.filter(
      (entry): entry is string => typeof entry === 'string',
    );
  } catch {
    return [];
  }
}

interface ActiveRun {
  run: TalkRunRecord;
  controller: AbortController;
}

export class MainRunWorker implements MainRunWorkerControl {
  private readonly pollMs: number;
  private readonly maxConcurrency: number;
  private readonly heartbeatMs: number;
  private readonly executor: MainExecutorFn;

  private running = false;
  private loopPromise: Promise<void> | null = null;

  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepResolver: (() => void) | null = null;

  private readonly activeRunsById = new Map<string, ActiveRun>();
  private readonly activeRunTasks = new Map<string, Promise<void>>();

  constructor(options: MainRunWorkerOptions = {}) {
    this.pollMs = Math.max(10, Math.floor(options.pollMs ?? TALK_RUN_POLL_MS));
    this.maxConcurrency = Math.max(
      1,
      Math.floor(options.maxConcurrency ?? TALK_RUN_MAX_CONCURRENCY),
    );
    this.heartbeatMs = Math.max(
      1_000,
      Math.floor(options.heartbeatMs ?? MAIN_RUN_HEARTBEAT_INTERVAL_MS),
    );
    this.executor = options.executor ?? executeMainChannel;
  }

  async start(): Promise<void> {
    if (this.running) return;

    const recovery = failInterruptedMainRunsOnStartup();
    if (recovery.failedRunIds.length > 0) {
      logger.warn(
        { failedRuns: recovery.failedRunIds.length },
        'Recovered interrupted main runs on startup',
      );
    }

    this.running = true;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      if (this.loopPromise) await this.loopPromise;
      return;
    }

    this.running = false;
    this.wake();

    for (const active of this.activeRunsById.values()) {
      active.controller.abort('worker_stopping');
    }

    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }

    if (this.activeRunTasks.size > 0) {
      await Promise.allSettled(this.activeRunTasks.values());
    }
  }

  wake(): void {
    const resolver = this.sleepResolver;
    if (!resolver) return;
    this.clearSleepState();
    resolver();
  }

  cancelRun(runId: string): void {
    const active = this.activeRunsById.get(runId);
    if (!active) return;
    active.controller.abort(`main_run_cancelled:${runId}`);
  }

  // --------------------------------------------------------------------------
  // Loop
  // --------------------------------------------------------------------------

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        this.processCycle();
      } catch (error) {
        logger.error({ err: error }, 'Main run worker cycle failed');
      }

      await this.waitForNextTick();
    }

    this.clearSleepState();
  }

  private processCycle(): void {
    const availableSlots = this.maxConcurrency - this.activeRunsById.size;
    if (availableSlots <= 0) return;

    const claimedRuns = claimQueuedMainRuns(availableSlots);
    for (const run of claimedRuns) {
      if (this.activeRunsById.size >= this.maxConcurrency) break;
      this.startRun(run);
    }
  }

  private startRun(run: TalkRunRecord): void {
    const controller = new AbortController();
    this.activeRunsById.set(run.id, { run, controller });

    const task = this.executeRun(run, controller.signal)
      .catch((error) => {
        logger.error(
          { err: error, runId: run.id, threadId: run.thread_id },
          'Main run execution crashed',
        );
      })
      .finally(() => {
        this.activeRunsById.delete(run.id);
        this.activeRunTasks.delete(run.id);
        this.wake();
      });
    this.activeRunTasks.set(run.id, task);
  }

  // --------------------------------------------------------------------------
  // Execution
  // --------------------------------------------------------------------------

  private async executeRun(
    run: TalkRunRecord,
    signal: AbortSignal,
  ): Promise<void> {
    const runTaskType = getTalkRunTaskType(run);
    if (!run.trigger_message_id) {
      this.failRun(
        run,
        'trigger_message_missing',
        'Run missing trigger message reference',
      );
      return;
    }

    const triggerMessage = getTalkMessageById(run.trigger_message_id);
    if (!triggerMessage) {
      this.failRun(
        run,
        'trigger_message_not_found',
        `Trigger message not found: ${run.trigger_message_id}`,
      );
      return;
    }

    const requestedToolFamilies = parseRequestedToolFamilies(run);
    if (run.thread_id && requestedToolFamilies.includes('browser')) {
      const owner = getUnambiguousPausedMainBrowserOwner({
        threadId: run.thread_id,
        excludeRunId: run.id,
      });
      if (owner) {
        const now = new Date().toISOString();
        pauseRunForBrowserBlock({
          runId: run.id,
          browserBlock: {
            kind: 'session_conflict',
            sessionId: owner.sessionId,
            siteKey: owner.siteKey,
            accountLabel: owner.accountLabel,
            conflictingRunId: owner.runId,
            conflictingSessionId: owner.sessionId,
            conflictingRunSummary: owner.summary,
            url: owner.url,
            title: owner.title,
            message: `Another paused browser task already owns the ${owner.siteKey} session. Resolve that task before this run can continue.`,
            riskReason: 'session_conflict',
            setupCommand: null,
            artifacts: [],
            confirmationId: null,
            pendingToolCall: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        logger.info(
          {
            runId: run.id,
            threadId: run.thread_id,
            conflictingRunId: owner.runId,
            siteKey: owner.siteKey,
          },
          'Main run paused due to an existing browser-session conflict',
        );
        return;
      }
    }

    const sanitizer = createTalkResponseStreamSanitizer();
    let streamedPreview = '';
    let lastPreviewPersistAt = 0;

    const persistRunSnapshot = (
      updater: (current: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      updateTalkRunMetadata(run.id, updater);
    };

    const persistPreviewIfNeeded = (force = false) => {
      const now = Date.now();
      if (
        !force &&
        lastPreviewPersistAt !== 0 &&
        now - lastPreviewPersistAt < STREAMED_TEXT_PERSIST_INTERVAL_MS
      ) {
        return;
      }
      lastPreviewPersistAt = now;
      const heartbeatAt = new Date(now).toISOString();
      persistRunSnapshot((current) => ({
        ...current,
        streamedTextPreview: streamedPreview || null,
        lastHeartbeatAt: heartbeatAt,
      }));
    };

    const heartbeatTimer = this.startRunHeartbeat(run);

    try {
      const output = await this.executor(
        {
          runId: run.id,
          threadId: run.thread_id,
          requestedBy: run.requested_by,
          triggerMessageId: triggerMessage.id,
          triggerContent: triggerMessage.content,
          targetAgentId: run.target_agent_id,
        },
        signal,
        (event: MainExecutionEvent) => {
          let eventToPublish = event;
          // Sanitize streaming deltas before publishing
          if (event.type === 'main_response_delta') {
            if (runTaskType === 'browser') {
              setRunBrowserPhase(run.id, 'summarizing');
            }
            const cleaned = sanitizer.push(event.text);
            if (!cleaned) return;
            eventToPublish = { ...event, text: cleaned };
            streamedPreview = appendStreamedPreview(streamedPreview, cleaned);
            if (
              lastPreviewPersistAt === 0 ||
              Date.now() - lastPreviewPersistAt >=
                STREAMED_TEXT_PERSIST_INTERVAL_MS
            ) {
              persistPreviewIfNeeded(true);
            }
          }
          switch (eventToPublish.type) {
            case 'main_response_started':
              persistRunSnapshot((current) => ({
                ...current,
                lastHeartbeatAt: new Date().toISOString(),
                lastProgressMessage: null,
                currentStep:
                  typeof current.currentStep === 'string'
                    ? current.currentStep
                    : 'Starting model…',
                timeoutPhase: null,
                terminalSummary: null,
              }));
              break;
            case 'main_progress_update':
              persistRunSnapshot((current) => ({
                ...current,
                lastProgressMessage: eventToPublish.message,
                currentStep: eventToPublish.message,
                lastHeartbeatAt: new Date().toISOString(),
              }));
              break;
            case 'main_response_usage':
            case 'main_promotion_pending':
              persistRunSnapshot((current) => ({
                ...current,
                lastHeartbeatAt: new Date().toISOString(),
              }));
              break;
            default:
              break;
          }
          appendOutboxEvent({
            topic: `user:${run.requested_by}`,
            eventType: eventToPublish.type,
            payload: JSON.stringify(eventToPublish),
          });
        },
      );

      // Sanitize stored content (strip internal tags)
      const sanitizedContent = stripInternalTalkResponseText(output.content);
      if (streamedPreview) {
        persistPreviewIfNeeded(true);
      }

      // Atomic: run status + assistant message + llm_attempt + terminal event
      const completed = completeMainRunAtomic({
        runId: run.id,
        threadId: run.thread_id,
        requestedBy: run.requested_by,
        responseMessageId: `msg_${randomUUID()}`,
        responseContent: sanitizedContent,
        agentId: output.agentId,
        providerId: output.providerId,
        modelId: output.modelId,
        latencyMs: output.latencyMs,
        usage: output.usage,
      });

      if (!completed.applied) {
        logger.debug(
          { runId: run.id, threadId: run.thread_id },
          'Main run completion skipped due to non-running status',
        );
        return;
      }

      if (output.promotionRequest) {
        const carriedBrowserSessions = getBrowserService()
          .getRunTouchedSessions(run.id)
          .map((session) => ({
            sessionId: session.sessionId,
            siteKey: session.siteKey,
            accountLabel: session.accountLabel,
            lastKnownState: session.lastKnownState,
            blockedKind: session.blockedKind,
            lastKnownUrl: session.lastKnownUrl,
            lastKnownTitle: session.lastKnownTitle,
            lastUpdatedAt: session.lastUpdatedAt,
          }));
        const childRun = createMainPromotionRunAtomic({
          parentRunId: run.id,
          childRunId: `run_${randomUUID()}`,
          threadId: run.thread_id,
          requestedBy: run.requested_by,
          triggerMessageId: run.trigger_message_id,
          targetAgentId: output.agentId,
          requiredToolFamilies: output.promotionRequest.requiredToolFamilies,
          userVisibleSummary: output.promotionRequest.userVisibleSummary,
          handoffNote: output.promotionRequest.handoffNote,
          taskDescription: output.promotionRequest.taskDescription,
          requiresApproval: output.promotionRequest.requiresApproval,
          carriedBrowserSessions,
        });
        if (!childRun) {
          logger.warn(
            { runId: run.id, threadId: run.thread_id },
            'Main promotion child run could not be created after parent completion',
          );
        }
      }

      try {
        refreshMainThreadSummary(run.thread_id);
      } catch (error) {
        logger.warn(
          { err: error, runId: run.id, threadId: run.thread_id },
          'Failed to refresh Main thread summary after completion',
        );
      }
    } catch (error) {
      if (error instanceof BrowserRunPausedError) {
        if (streamedPreview) {
          persistPreviewIfNeeded(true);
        }
        logger.info(
          {
            runId: run.id,
            threadId: run.thread_id,
            browserBlock: error.browserBlock.kind,
          },
          'Main run paused for browser intervention',
        );
        return;
      }
      if (isAbortError(error)) {
        if (streamedPreview) {
          persistPreviewIfNeeded(true);
        }
        if (!this.running) return;
        if (this.isCancelled(run.id)) return;
        this.failRun(run, 'execution_aborted', errorMessage(error));
        return;
      }

      if (streamedPreview) {
        persistPreviewIfNeeded(true);
      }
      if (error instanceof MainRunPhaseTimeoutError) {
        this.failRun(
          run,
          'execution_timeout',
          error.message,
          error.timeoutPhase,
        );
        return;
      }
      const failureMessage = errorMessage(error);
      maybeInvalidateBrowserReadiness(run, failureMessage);
      this.failRun(run, 'execution_failed', failureMessage);
    } finally {
      this.stopRunHeartbeat(heartbeatTimer);
    }
  }

  private startRunHeartbeat(
    run: TalkRunRecord,
  ): ReturnType<typeof setInterval> | null {
    if (this.heartbeatMs <= 0) return null;
    return setInterval(() => {
      const currentRun = getTalkRunById(run.id);
      if (!currentRun || currentRun.status !== 'running') {
        return;
      }

      const heartbeatAt = new Date().toISOString();
      updateTalkRunMetadata(run.id, (current) => ({
        ...current,
        lastHeartbeatAt: heartbeatAt,
      }));
      appendOutboxEvent({
        topic: `user:${run.requested_by}`,
        eventType: 'main_heartbeat',
        payload: JSON.stringify({
          runId: run.id,
          threadId: run.thread_id,
          at: heartbeatAt,
        }),
      });
    }, this.heartbeatMs);
  }

  private stopRunHeartbeat(timer: ReturnType<typeof setInterval> | null): void {
    if (!timer) return;
    clearInterval(timer);
  }

  private failRun(
    run: TalkRunRecord,
    errorCode: string,
    errorMessageText: string,
    timeoutPhase?: string | null,
  ): void {
    const result = failMainRunAtomic({
      runId: run.id,
      threadId: run.thread_id,
      requestedBy: run.requested_by,
      errorCode,
      errorMessage: errorMessageText,
      timeoutPhase: timeoutPhase ?? null,
    });
    if (!result.applied) {
      logger.debug(
        { runId: run.id, threadId: run.thread_id },
        'Main run failure skipped due to non-running status',
      );
    }
  }

  private isCancelled(runId: string): boolean {
    return getTalkRunById(runId)?.status === 'cancelled';
  }

  // --------------------------------------------------------------------------
  // Sleep / Wake
  // --------------------------------------------------------------------------

  private waitForNextTick(): Promise<void> {
    if (!this.running) return Promise.resolve();

    return new Promise((resolve) => {
      this.sleepResolver = resolve;
      this.sleepTimer = setTimeout(() => {
        this.clearSleepState();
        resolve();
      }, this.pollMs);
    });
  }

  private clearSleepState(): void {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    this.sleepResolver = null;
  }
}
