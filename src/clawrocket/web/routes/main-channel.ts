import { randomUUID } from 'crypto';
import {
  type BrowserBlockMetadata,
  type BrowserResumeMetadata,
  type CarriedBrowserSessionMetadata,
  type ExecutionDecisionMetadata,
  type MainRunLeaseState,
  type MainRunTimingMetadata,
} from '../../browser/metadata.js';
import { resolveMainBrowserContract } from '../../agents/main-browser-contract.js';
import type { TalkRunBrowserPhase } from '../../db/index.js';
import {
  canUserAccessMainThread,
  cancelMainRunAtomic,
  deleteMainMessagesAtomic,
  deleteMainThread,
  enqueueMainTurnAtomic,
  getLastMainRunForThread,
  getPendingMainBrowserRun,
  getTalkRunBlockedReason,
  getTalkRunBrowserPhase,
  getTalkRunBrowserSessionId,
  getTalkRunSelectedMode,
  getTalkRunTaskType,
  getTalkRunTimeoutPhase,
  getTalkRunTransport,
  getMainThreadTitle,
  getTalkRunById,
  listMainThreadsForUser,
  listMainRunsForThread,
  MainThreadBusyError,
  normalizeTalkRunSelectedMode,
  normalizeTalkRunTaskType,
  normalizeTalkRunTransport,
  recordMainRunFirstVisibleAt,
  TalkActiveRoundError,
  ThreadDeleteConflictError,
  updateMainThreadMetadata,
} from '../../db/index.js';
import {
  ThreadTitleValidationError,
  validateEditableThreadTitle,
} from '../../db/thread-title-utils.js';
import { getDb } from '../../../db.js';
import type { AuthContext, ApiEnvelope } from '../types.js';

function looksLikeHighConfidenceBrowserIntent(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return false;
  const mentionsSurface =
    /https?:\/\//.test(normalized) ||
    /\blinkedin\b/.test(normalized) ||
    /\bbrowser\b/.test(normalized) ||
    /\bsession\b/.test(normalized) ||
    /\bsite\b/.test(normalized);
  const mentionsAction =
    /\b(open|access|check|visit|navigate|login|log in|show|see)\b/.test(
      normalized,
    ) || /what you can access/.test(normalized);
  return mentionsSurface && mentionsAction;
}

function humanizeBrowserSite(siteKey: string): string {
  if (siteKey.toLowerCase() === 'linkedin') {
    return 'LinkedIn';
  }
  if (siteKey.length <= 3) {
    return siteKey.toUpperCase();
  }
  return siteKey
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function buildPendingBrowserRunMessage(input: BrowserBlockMetadata): string {
  const siteLabel = humanizeBrowserSite(input.siteKey);
  if (input.kind === 'confirmation_required') {
    return `${siteLabel} already has a paused browser action waiting for approval in this thread. Use the existing blocked run instead of sending another browser message.`;
  }
  if (input.kind === 'human_step_required') {
    return `${siteLabel} already has a manual browser step waiting in this thread. Finish that step and resume the existing run instead of sending another browser message.`;
  }
  if (input.kind === 'session_conflict') {
    return `${siteLabel} already has a paused browser task in this thread. Resolve or resume the existing blocked run before sending another browser message.`;
  }
  return `${siteLabel} sign-in is already waiting in this thread. Finish that step and resume the existing run instead of sending another browser message.`;
}
// ---------------------------------------------------------------------------
// List Main Threads Route
// ---------------------------------------------------------------------------

interface ThreadSummary {
  threadId: string;
  title: string | null;
  isPinned: boolean;
  lastMessageAt: string;
  messageCount: number;
  hasActiveRun: boolean;
}

export function listMainThreadsRoute(auth: AuthContext): {
  statusCode: number;
  body: ApiEnvelope<ThreadSummary[]>;
} {
  try {
    const rows = listMainThreadsForUser(auth.userId);

    const threads: ThreadSummary[] = rows.map((row) => ({
      threadId: row.thread_id,
      title: row.title,
      isPinned: row.is_pinned === 1,
      lastMessageAt: row.last_message_at,
      messageCount: row.message_count,
      hasActiveRun: row.has_active_run === 1,
    }));

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: threads,
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to list threads: ${String(err)}`,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Get Main Thread Route
// ---------------------------------------------------------------------------

interface ThreadMessage {
  id: string;
  threadId: string;
  role: string;
  content: string;
  runId: string | null;
  agentId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export function getMainThreadRoute(
  auth: AuthContext,
  threadId: string,
): {
  statusCode: number;
  body: ApiEnvelope<ThreadMessage[]>;
} {
  try {
    // Ownership check
    if (!canUserAccessMainThread(threadId, auth.userId)) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'not_found',
            message: `Thread '${threadId}' not found`,
          },
        },
      };
    }

    const rows = getDb()
      .prepare(
        `
      SELECT
        id,
        thread_id,
        role,
        content,
        run_id,
        agent_id,
        created_by,
        created_at
      FROM talk_messages
      WHERE talk_id IS NULL AND thread_id = ?
      ORDER BY created_at ASC
    `,
      )
      .all(threadId) as Array<{
      id: string;
      thread_id: string;
      role: string;
      content: string;
      run_id: string | null;
      agent_id: string | null;
      created_by: string | null;
      created_at: string;
    }>;

    if (rows.length === 0) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'not_found',
            message: `Thread '${threadId}' not found`,
          },
        },
      };
    }

    const messages: ThreadMessage[] = rows.map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      role: row.role,
      content: row.content,
      runId: row.run_id,
      agentId: row.agent_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: messages,
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to get thread messages: ${String(err)}`,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Post Main Message Route
// ---------------------------------------------------------------------------

interface PostMainMessageBody {
  content?: unknown;
  threadId?: unknown;
  forceBrowser?: unknown;
}

interface PostMainMessageResponse {
  messageId: string;
  threadId: string;
  runId: string;
  title: string | null;
  run: MainRunApiRecord;
}

interface CancelMainRunResponse {
  runId: string;
  threadId: string;
  cancelled: boolean;
}

interface MainRunTerminalSummaryApiRecord {
  statusLabel: 'Failed' | 'Cancelled';
  body: string;
}

export interface MainRunApiRecord {
  id: string;
  threadId: string;
  taskType: 'chat' | 'browser';
  browserPhase: 'starting' | 'interacting' | 'summarizing' | null;
  blockedReason:
    | 'login_required'
    | 'phone_approval'
    | 'app_approval'
    | 'code_entry'
    | 'session_conflict'
    | 'manual_takeover'
    | null;
  browserSessionId: string | null;
  selectedMode: 'api' | 'subscription' | null;
  transport: 'direct' | 'subscription' | null;
  status:
    | 'queued'
    | 'running'
    | 'awaiting_confirmation'
    | 'cancelled'
    | 'completed'
    | 'failed';
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  triggerMessageId: string | null;
  targetAgentId: string | null;
  cancelReason: string | null;
  kind: string | null;
  parentRunId: string | null;
  promotionState: 'pending' | 'superseded' | null;
  promotionChildRunId: string | null;
  requestedToolFamilies: string[];
  userVisibleSummary: string | null;
  browserBlock: BrowserBlockMetadata | null;
  browserResume: BrowserResumeMetadata | null;
  carriedBrowserSessions: CarriedBrowserSessionMetadata[];
  executionDecision: ExecutionDecisionMetadata | null;
  executionStrategy: 'browser_fast_lane' | 'generic_agent_loop' | null;
  routeReason: 'browser_fast_lane' | 'subscription_fallback' | 'normal' | null;
  currentStep: string | null;
  timeoutPhase: string | null;
  leaseState: MainRunLeaseState | null;
  timing: MainRunTimingMetadata | null;
  streamedTextPreview: string | null;
  lastProgressMessage: string | null;
  lastHeartbeatAt: string | null;
  terminalSummary: MainRunTerminalSummaryApiRecord | null;
  resumeRequestedAt: string | null;
  resumeRequestedBy: string | null;
}

function parseRunMetadata(
  metadataJson: string | null | undefined,
): Record<string, unknown> {
  if (!metadataJson) return {};
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignored
  }
  return {};
}

function parseMetadataObject<T>(value: unknown): T | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as T;
}

function parseTerminalSummary(
  value: unknown,
): MainRunTerminalSummaryApiRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const summary = value as {
    statusLabel?: unknown;
    body?: unknown;
  };
  if (
    (summary.statusLabel === 'Failed' || summary.statusLabel === 'Cancelled') &&
    typeof summary.body === 'string'
  ) {
    return {
      statusLabel: summary.statusLabel,
      body: summary.body,
    };
  }
  return null;
}

function toMainRunApiRecord(run: {
  id: string;
  thread_id: string;
  status:
    | 'queued'
    | 'running'
    | 'awaiting_confirmation'
    | 'cancelled'
    | 'completed'
    | 'failed';
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  trigger_message_id: string | null;
  target_agent_id?: string | null;
  cancel_reason: string | null;
  metadata_json?: string | null;
  task_type?: 'chat' | 'browser' | null;
  browser_phase?: 'starting' | 'interacting' | 'summarizing' | null;
  blocked_reason?:
    | 'login_required'
    | 'phone_approval'
    | 'app_approval'
    | 'code_entry'
    | 'session_conflict'
    | 'manual_takeover'
    | null;
  browser_session_id?: string | null;
  selected_mode?: 'api' | 'subscription' | null;
  transport?: 'direct' | 'subscription' | null;
  timeout_phase?: string | null;
}): MainRunApiRecord {
  const metadata = parseRunMetadata(run.metadata_json);
  return {
    id: run.id,
    threadId: run.thread_id,
    taskType: getTalkRunTaskType(run),
    browserPhase: getTalkRunBrowserPhase(run),
    blockedReason: getTalkRunBlockedReason(run),
    browserSessionId: getTalkRunBrowserSessionId(run),
    selectedMode: getTalkRunSelectedMode(run),
    transport: getTalkRunTransport(run),
    status: run.status,
    createdAt: run.created_at,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    triggerMessageId: run.trigger_message_id,
    targetAgentId: run.target_agent_id ?? null,
    cancelReason: run.cancel_reason,
    kind: typeof metadata.kind === 'string' ? metadata.kind : null,
    parentRunId:
      typeof metadata.parentRunId === 'string' ? metadata.parentRunId : null,
    promotionState:
      metadata.promotionState === 'pending' ||
      metadata.promotionState === 'superseded'
        ? metadata.promotionState
        : null,
    promotionChildRunId:
      typeof metadata.promotionChildRunId === 'string'
        ? metadata.promotionChildRunId
        : null,
    requestedToolFamilies: Array.isArray(metadata.requestedToolFamilies)
      ? metadata.requestedToolFamilies.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
    userVisibleSummary:
      typeof metadata.userVisibleSummary === 'string'
        ? metadata.userVisibleSummary
        : null,
    browserBlock: parseMetadataObject<BrowserBlockMetadata>(
      metadata.browserBlock,
    ),
    browserResume: parseMetadataObject<BrowserResumeMetadata>(
      metadata.browserResume,
    ),
    carriedBrowserSessions: Array.isArray(metadata.carriedBrowserSessions)
      ? metadata.carriedBrowserSessions.filter(
          (entry): entry is CarriedBrowserSessionMetadata =>
            Boolean(entry) &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            typeof (entry as { sessionId?: unknown }).sessionId === 'string' &&
            typeof (entry as { siteKey?: unknown }).siteKey === 'string',
        )
      : [],
    executionDecision: parseMetadataObject<ExecutionDecisionMetadata>(
      metadata.executionDecision,
    ),
    executionStrategy:
      metadata.executionStrategy === 'browser_fast_lane' ||
      metadata.executionStrategy === 'generic_agent_loop'
        ? metadata.executionStrategy
        : null,
    routeReason:
      metadata.routeReason === 'browser_fast_lane' ||
      metadata.routeReason === 'subscription_fallback' ||
      metadata.routeReason === 'normal'
        ? metadata.routeReason
        : null,
    currentStep:
      typeof metadata.currentStep === 'string' ? metadata.currentStep : null,
    timeoutPhase: getTalkRunTimeoutPhase(run),
    leaseState:
      metadata.leaseState === 'cold_boot' ||
      metadata.leaseState === 'warm_reuse' ||
      metadata.leaseState === 'recovered_cold_boot' ||
      metadata.leaseState === 'one_shot_fallback'
        ? metadata.leaseState
        : null,
    timing: parseMetadataObject<MainRunTimingMetadata>(metadata.timing),
    streamedTextPreview:
      typeof metadata.streamedTextPreview === 'string'
        ? metadata.streamedTextPreview
        : null,
    lastProgressMessage:
      typeof metadata.lastProgressMessage === 'string'
        ? metadata.lastProgressMessage
        : null,
    lastHeartbeatAt:
      typeof metadata.lastHeartbeatAt === 'string'
        ? metadata.lastHeartbeatAt
        : null,
    terminalSummary: parseTerminalSummary(metadata.terminalSummary),
    resumeRequestedAt:
      typeof metadata.resumeRequestedAt === 'string'
        ? metadata.resumeRequestedAt
        : null,
    resumeRequestedBy:
      typeof metadata.resumeRequestedBy === 'string'
        ? metadata.resumeRequestedBy
        : null,
  };
}

export function postMainMessageRoute(
  auth: AuthContext,
  body: PostMainMessageBody,
): {
  statusCode: number;
  body: ApiEnvelope<PostMainMessageResponse>;
} {
  // Validate content
  if (typeof body.content !== 'string' || !body.content.trim()) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'content is required and must be a non-empty string',
        },
      },
    };
  }
  if (
    body.forceBrowser !== undefined &&
    body.forceBrowser !== null &&
    typeof body.forceBrowser !== 'boolean'
  ) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'forceBrowser must be a boolean if provided',
        },
      },
    };
  }

  const content = body.content.trim();
  const forceBrowser = body.forceBrowser === true;

  // Determine threadId early so it's available for browser inheritance
  let threadId: string;
  if (body.threadId !== undefined) {
    if (typeof body.threadId !== 'string' || !body.threadId.trim()) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: 'threadId must be a non-empty string if provided',
          },
        },
      };
    }
    threadId = body.threadId.trim();

    // Ownership check for existing threads
    if (!canUserAccessMainThread(threadId, auth.userId)) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'not_found',
            message: `Thread '${threadId}' not found`,
          },
        },
      };
    }
  } else {
    threadId = randomUUID();
  }

  const browserContract = resolveMainBrowserContract(auth.userId);
  const browserCapable = browserContract.browserEnabled;

  // If follow-up in existing thread, check if last run was browser
  let inheritedBrowser: {
    selectedMode: 'api' | 'subscription' | null;
    transport: 'direct' | 'subscription' | null;
  } | null = null;
  if (body.threadId && browserCapable && !forceBrowser) {
    const lastRun = getLastMainRunForThread(threadId);
    if (lastRun) {
      const lastTaskType = normalizeTalkRunTaskType(lastRun.task_type);
      if (lastTaskType === 'browser') {
        inheritedBrowser = {
          selectedMode: normalizeTalkRunSelectedMode(lastRun.selected_mode),
          transport: normalizeTalkRunTransport(lastRun.transport),
        };
      }
    }
  }

  const taskType: 'chat' | 'browser' =
    forceBrowser ||
    inheritedBrowser !== null ||
    (browserCapable && looksLikeHighConfidenceBrowserIntent(content))
      ? 'browser'
      : 'chat';
  let selectedMode: 'api' | 'subscription' | null = null;
  let transport: 'direct' | 'subscription' | null = null;

  if (taskType === 'browser') {
    if (body.threadId) {
      const pendingBrowserRun = getPendingMainBrowserRun({ threadId });
      if (pendingBrowserRun) {
        return {
          statusCode: 409,
          body: {
            ok: false,
            error: {
              code: 'browser_run_pending',
              message: buildPendingBrowserRunMessage(
                pendingBrowserRun.browserBlock,
              ),
            },
          },
        };
      }
    }

    if (inheritedBrowser && browserContract.ready) {
      selectedMode = inheritedBrowser.selectedMode;
      transport = inheritedBrowser.transport;
    } else if (!browserContract.ready) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'browser_execution_not_configured',
            message: browserContract.message,
          },
        },
      };
    } else {
      selectedMode = browserContract.selectedMode;
      transport = browserContract.transport;
    }
  }

  try {
    const messageId = `msg_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;

    const result = enqueueMainTurnAtomic({
      threadId,
      userId: auth.userId,
      content,
      messageId,
      runId,
      taskType,
      selectedMode,
      transport,
    });

    return {
      statusCode: 202,
      body: {
        ok: true,
        data: {
          messageId: result.message.id,
          threadId,
          runId: result.run.id,
          title: getMainThreadTitle(threadId, auth.userId),
          run: toMainRunApiRecord(result.run),
        },
      },
    };
  } catch (err) {
    if (err instanceof MainThreadBusyError) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'thread_busy',
            message: 'Thread already has an active run',
          },
        },
      };
    }

    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to post message: ${String(err)}`,
        },
      },
    };
  }
}

export function cancelMainRunRoute(
  auth: AuthContext,
  runId: string,
): {
  statusCode: number;
  body: ApiEnvelope<CancelMainRunResponse>;
  cancelledRunning: boolean;
} {
  const run = getTalkRunById(runId);
  if (!run || run.talk_id !== null || !run.thread_id) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'not_found',
          message: `Main run '${runId}' not found`,
        },
      },
      cancelledRunning: false,
    };
  }

  if (!canUserAccessMainThread(run.thread_id, auth.userId)) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'not_found',
          message: `Main run '${runId}' not found`,
        },
      },
      cancelledRunning: false,
    };
  }

  const cancellation = cancelMainRunAtomic({
    runId,
    cancelledBy: auth.userId,
  });
  if (!cancellation.cancelled) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'no_active_run',
          message: 'No queued, running, or blocked Main run exists for this id',
        },
      },
      cancelledRunning: false,
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        runId,
        threadId: run.thread_id,
        cancelled: true,
      },
    },
    cancelledRunning: cancellation.cancelledRunning,
  };
}

export function listMainRunsRoute(
  auth: AuthContext,
  threadId: string,
): {
  statusCode: number;
  body: ApiEnvelope<MainRunApiRecord[]>;
} {
  try {
    if (!canUserAccessMainThread(threadId, auth.userId)) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'not_found',
            message: `Thread '${threadId}' not found`,
          },
        },
      };
    }

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: listMainRunsForThread(threadId).map(toMainRunApiRecord),
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to list main runs: ${String(err)}`,
        },
      },
    };
  }
}

interface DeleteMainMessagesBody {
  messageIds?: unknown;
}

interface DeleteMainMessagesResponse {
  threadId: string;
  deletedCount: number;
  deletedMessageIds: string[];
  threadDeleted: boolean;
}

export function deleteMainMessagesRoute(
  auth: AuthContext,
  threadId: string,
  body: DeleteMainMessagesBody,
): {
  statusCode: number;
  body: ApiEnvelope<DeleteMainMessagesResponse>;
} {
  if (!canUserAccessMainThread(threadId, auth.userId)) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'not_found',
          message: `Thread '${threadId}' not found`,
        },
      },
    };
  }

  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(body.messageIds) ? body.messageIds : [])
        .filter((value): value is string => typeof value === 'string')
        .map((messageId) => messageId.trim())
        .filter((messageId) => messageId.length > 0),
    ),
  );
  if (normalizedIds.length === 0) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_message_ids',
          message: 'Select at least one message to delete.',
        },
      },
    };
  }
  if (normalizedIds.length > 200) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'too_many_message_ids',
          message: 'Delete at most 200 messages at a time.',
        },
      },
    };
  }

  try {
    const deleted = deleteMainMessagesAtomic({
      threadId,
      userId: auth.userId,
      messageIds: normalizedIds,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          threadId,
          deletedCount: deleted.deletedCount,
          deletedMessageIds: deleted.deletedMessageIds,
          threadDeleted: deleted.threadDeleted,
        },
      },
    };
  } catch (error) {
    if (error instanceof TalkActiveRoundError && error.scope === 'thread') {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'thread_active_round',
            message:
              'Wait for the current response to finish or cancel it before editing history.',
          },
        },
      };
    }

    const message =
      error instanceof Error
        ? error.message
        : 'Unable to edit Main thread history';
    if (message === 'main thread not found') {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'not_found',
            message: `Thread '${threadId}' not found`,
          },
        },
      };
    }
    if (message === 'one or more main messages were not found') {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'message_not_found',
            message: 'One or more selected messages no longer exist.',
          },
        },
      };
    }
    if (message === 'system messages cannot be deleted') {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_message_role',
            message: 'System messages cannot be deleted.',
          },
        },
      };
    }
    if (message === 'main thread must retain at least one user message') {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'main_thread_requires_user_message',
            message:
              'Main threads must keep at least one user message. Delete the whole thread if you want to remove everything else.',
          },
        },
      };
    }
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'main_history_edit_failed',
          message,
        },
      },
    };
  }
}

export function postMainRunVisibleRoute(
  auth: AuthContext,
  runId: string,
  body: { firstVisibleAt?: unknown },
): {
  statusCode: number;
  body: ApiEnvelope<{ recorded: boolean }>;
} {
  const run = getTalkRunById(runId);
  if (
    !run ||
    run.talk_id !== null ||
    !canUserAccessMainThread(run.thread_id, auth.userId)
  ) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'not_found',
          message: `Run '${runId}' not found`,
        },
      },
    };
  }

  if (
    typeof body.firstVisibleAt !== 'string' ||
    !body.firstVisibleAt.trim() ||
    Number.isNaN(Date.parse(body.firstVisibleAt))
  ) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'firstVisibleAt must be an ISO timestamp string',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        recorded: recordMainRunFirstVisibleAt({
          runId,
          firstVisibleAt: body.firstVisibleAt,
        }),
      },
    },
  };
}

interface PatchMainThreadBody {
  title?: unknown;
  pinned?: unknown;
}

interface PatchMainThreadResponse {
  threadId: string;
  title: string | null;
  isPinned: boolean;
}

interface PatchMainThreadDeps {
  updateMainThreadMetadata?: typeof updateMainThreadMetadata;
}

export function patchMainThreadRoute(
  auth: AuthContext,
  threadId: string,
  body: PatchMainThreadBody,
  deps?: PatchMainThreadDeps,
): {
  statusCode: number;
  body: ApiEnvelope<PatchMainThreadResponse>;
} {
  if (body.title === undefined && body.pinned === undefined) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'At least one of title or pinned is required',
        },
      },
    };
  }

  let title: string | undefined;
  if (body.title !== undefined) {
    try {
      title = validateEditableThreadTitle(
        typeof body.title === 'string' ? body.title : null,
      );
    } catch (err) {
      if (err instanceof ThreadTitleValidationError) {
        return {
          statusCode: 400,
          body: {
            ok: false,
            error: {
              code: 'invalid_input',
              message: err.message,
            },
          },
        };
      }
      throw err;
    }
  }

  let pinned: boolean | undefined;
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== 'boolean') {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: 'pinned must be a boolean',
          },
        },
      };
    }
    pinned = body.pinned;
  }

  if (!canUserAccessMainThread(threadId, auth.userId)) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'not_found',
          message: `Thread '${threadId}' not found`,
        },
      },
    };
  }

  try {
    const updated = (
      deps?.updateMainThreadMetadata ?? updateMainThreadMetadata
    )({
      threadId,
      userId: auth.userId,
      ...(title !== undefined ? { title } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
    });
    if (!updated) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'not_found',
            message: `Thread '${threadId}' not found`,
          },
        },
      };
    }

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          threadId: updated.thread_id,
          title: updated.title,
          isPinned: updated.is_pinned === 1,
        },
      },
    };
  } catch (err) {
    if (err instanceof ThreadTitleValidationError) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: err.message,
          },
        },
      };
    }
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to update thread title: ${String(err)}`,
        },
      },
    };
  }
}

interface DeleteMainThreadResponse {
  deleted: true;
}

interface DeleteMainThreadDeps {
  deleteMainThread?: typeof deleteMainThread;
}

export function deleteMainThreadRoute(
  auth: AuthContext,
  threadId: string,
  deps?: DeleteMainThreadDeps,
): {
  statusCode: number;
  body: ApiEnvelope<DeleteMainThreadResponse>;
} {
  if (!canUserAccessMainThread(threadId, auth.userId)) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'not_found',
          message: `Thread '${threadId}' not found`,
        },
      },
    };
  }

  try {
    const deleted = (deps?.deleteMainThread ?? deleteMainThread)({
      threadId,
      userId: auth.userId,
    });
    if (!deleted) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'not_found',
            message: `Thread '${threadId}' not found`,
          },
        },
      };
    }

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: { deleted: true },
      },
    };
  } catch (err) {
    if (err instanceof ThreadDeleteConflictError) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: err.code,
            message: err.message,
          },
        },
      };
    }
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to delete thread: ${String(err)}`,
        },
      },
    };
  }
}
