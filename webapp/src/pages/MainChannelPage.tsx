/**
 * MainChannelPage — Primary AI surface for Nanoclaw (Main Agent Channel).
 *
 * Combined view: thread list on the left, active thread detail on the right.
 * Single-agent, context-free execution with web tools (fetch + search).
 * Uses the user-scoped SSE stream for real-time updates.
 */

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import {
  ApiError,
  cancelMainRun,
  deleteMainMessages,
  deleteMainThread,
  getMainThread,
  getMainRegisteredAgent,
  listMainRuns,
  listMainThreads,
  postMainRunVisible,
  postMainMessage,
  type TalkMessage,
  UnauthorizedError,
  updateMainThread,
  type MainRun,
  type MainThreadMessage,
  type MainThreadSummary,
  type RegisteredAgent,
} from '../lib/api';
import { stripInternalAssistantText } from '../lib/assistantText';
import { isPhoneApprovalBrowserBlock } from '../lib/browser-blocks';
import { BrowserBlockedRunCard } from '../components/BrowserBlockedRunCard';
import { ExecutionDecisionSummary } from '../components/ExecutionDecisionSummary';
import { InlineEditableTitle } from '../components/InlineEditableTitle';
import { TalkHistoryEditor } from '../components/TalkHistoryEditor';
import { ThreadContextMenu } from '../components/ThreadContextMenu';
import { ThreadRowTitleEditor } from '../components/ThreadRowTitleEditor';
import { ThreadStartButton } from '../components/ThreadStartButton';
import {
  displayThreadTitle,
  inferThreadTitleFromContent,
} from '../lib/threadTitles';
import {
  type MainHeartbeatEvent,
  openMainStream,
  type MainMessageAppendedEvent,
  type MainProgressUpdateEvent,
  type MainResponseStartedEvent,
  type MainRunEvent,
  type MainPromotionPendingEvent,
  type MainStreamState,
} from '../lib/mainStream';

// ============================================================================
type MainState = {
  threads: MainThreadSummary[];
  threadsLoading: boolean;
  threadsError: string | null;
  activeThreadId: string | null;
  messages: MainThreadMessage[];
  runsById: Record<string, MainRun>;
  messagesLoading: boolean;
  messagesError: string | null;
  streamState: MainStreamState;
  sendState: 'idle' | 'posting' | 'error';
  sendError: string | null;
};

type MainTimelineEntry =
  | { kind: 'message'; message: MainThreadMessage }
  | { kind: 'run'; run: MainRun }
  | { kind: 'terminal-run'; run: MainRun };

type OpenInBrowserNotice = {
  runId: string;
  tone: 'success' | 'error';
  message: string;
};

type MainAction =
  | { type: 'THREADS_LOADING' }
  | { type: 'THREADS_LOADED'; threads: MainThreadSummary[] }
  | { type: 'THREADS_ERROR'; message: string }
  | { type: 'THREAD_REMOVED'; threadId: string }
  | { type: 'THREAD_RUN_STATE'; threadId: string; hasActiveRun: boolean }
  | { type: 'THREAD_SELECTED'; threadId: string }
  | {
      type: 'THREAD_UPDATED';
      threadId: string;
      title: string | null;
      isPinned: boolean;
    }
  | { type: 'MESSAGES_LOADING' }
  | { type: 'MESSAGES_LOADED'; messages: MainThreadMessage[] }
  | { type: 'RUNS_LOADED'; threadId: string; runs: MainRun[] }
  | { type: 'RUN_UPSERTED'; run: MainRun }
  | {
      type: 'PROMOTION_PENDING';
      event: MainPromotionPendingEvent;
    }
  | {
      type: 'RUN_TERMINAL';
      runId: string;
      threadId: string;
      status: 'completed' | 'failed' | 'cancelled';
      cancelReason?: string | null;
    }
  | { type: 'MESSAGES_ERROR'; message: string }
  | { type: 'MESSAGE_APPENDED'; message: MainThreadMessage }
  | {
      type: 'HISTORY_DELETED';
      threadId: string;
      deletedMessageIds: string[];
    }
  | { type: 'RESPONSE_STARTED'; event: MainResponseStartedEvent }
  | { type: 'RESPONSE_PROGRESS'; event: MainProgressUpdateEvent }
  | { type: 'RESPONSE_HEARTBEAT'; event: MainHeartbeatEvent }
  | { type: 'RESPONSE_DELTA'; event: { runId: string; threadId: string; text: string } }
  | { type: 'RESPONSE_COMPLETED'; runId: string; threadId: string }
  | {
      type: 'RESPONSE_FAILED';
      event: { runId: string; threadId: string; errorCode: string; errorMessage: string };
    }
  | { type: 'STREAM_STATE'; state: MainStreamState }
  | { type: 'SEND_STARTED' }
  | { type: 'SEND_FAILED'; message: string }
  | { type: 'SEND_CLEARED' }
  | {
      type: 'NEW_THREAD_CREATED';
      threadId: string;
      threadSummary: MainThreadSummary;
    }
  | { type: 'CLEAR_THREAD' }
  | {
      type: 'MESSAGES_LOADED_FOR_THREAD';
      threadId: string;
      messages: MainThreadMessage[];
    };

function createInitialState(): MainState {
  return {
    threads: [],
    threadsLoading: true,
    threadsError: null,
    activeThreadId: null,
    messages: [],
    runsById: {},
    messagesLoading: false,
    messagesError: null,
    streamState: 'connecting',
    sendState: 'idle',
    sendError: null,
  };
}

const SCROLL_STICK_THRESHOLD_PX = 120;
const MAIN_MESSAGE_MAX_CHARS = 20_000;
const MAIN_RUN_STALLED_AFTER_MS = 30_000;
const STREAMED_TEXT_PREVIEW_MAX_CHARS = 4_000;

function humanizeExecutionStrategy(
  value: MainRun['executionStrategy'],
): string | null {
  if (value === 'browser_fast_lane') return 'Browser fast lane';
  if (value === 'generic_agent_loop') return 'Generic agent loop';
  return null;
}

function humanizeRouteReason(value: MainRun['routeReason']): string | null {
  if (value === 'browser_fast_lane') return 'Direct API fast lane';
  if (value === 'subscription_fallback') return 'Subscription fallback';
  if (value === 'normal') return 'Normal route';
  return null;
}

function humanizeLeaseState(value: MainRun['leaseState']): string | null {
  if (value === 'cold_boot') return 'Warm worker cold boot';
  if (value === 'warm_reuse') return 'Warm worker reuse';
  if (value === 'recovered_cold_boot') return 'Warm worker recovery';
  if (value === 'one_shot_fallback') return 'One-shot fallback';
  return null;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

function diffTimingMs(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
): number | null {
  if (!startIso || !endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return end - start;
}

function summarizeTimeoutPhase(
  timeoutPhase: MainRun['timeoutPhase'],
  fallback: string | null,
): string | null {
  switch (timeoutPhase) {
    case 'lease_queue':
      return 'The run timed out waiting for an available warm subscription worker.';
    case 'lease_boot':
      return 'The warm subscription worker took too long to start.';
    case 'queue_to_executor_start':
      return 'The run timed out before execution could start.';
    case 'first_progress':
      return 'The run timed out before the model or browser produced visible progress.';
    case 'first_page_ready':
      return 'The browser timed out before it reached a usable page state.';
    case 'worker_unresponsive':
      return 'The warm subscription worker stopped responding.';
    case 'total_run':
      return 'The run exceeded its total time budget.';
    default:
      return fallback;
  }
}

function formatMainRunMetaLine(run: MainRun): string | null {
  const parts: string[] = [];
  const strategy = humanizeExecutionStrategy(run.executionStrategy);
  const routeReason = humanizeRouteReason(run.routeReason);
  const leaseState = humanizeLeaseState(run.leaseState);
  if (strategy) {
    parts.push(strategy);
  }
  if (routeReason) {
    parts.push(routeReason);
  }
  if (leaseState) {
    parts.push(leaseState);
  }
  const queueMs = diffTimingMs(
    run.timing?.queueStartedAt || run.createdAt,
    run.timing?.executorStartedAt,
  );
  const leaseMs = diffTimingMs(
    run.timing?.leaseRequestedAt,
    run.timing?.leaseReadyAt,
  );
  const dispatchMs = diffTimingMs(
    run.timing?.leaseReadyAt,
    run.timing?.taskDispatchedAt,
  );
  const providerMs = diffTimingMs(
    run.timing?.executorStartedAt,
    run.timing?.firstProviderEventAt,
  );
  const pageMs = diffTimingMs(
    run.timing?.executorStartedAt,
    run.timing?.firstPageReadyAt,
  );
  if (queueMs != null) {
    parts.push(`Queue ${formatDurationMs(queueMs)}`);
  }
  if (leaseMs != null) {
    parts.push(`Lease ${formatDurationMs(leaseMs)}`);
  }
  if (dispatchMs != null) {
    parts.push(`Dispatch ${formatDurationMs(dispatchMs)}`);
  }
  if (providerMs != null) {
    parts.push(`Provider ${formatDurationMs(providerMs)}`);
  }
  if (pageMs != null) {
    parts.push(`Page ${formatDurationMs(pageMs)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function isBlockedBrowserRun(run: MainRun): boolean {
  return (
    run.taskType === 'browser' &&
    run.status === 'awaiting_confirmation' &&
    Boolean(run.blockedReason || run.browserBlock)
  );
}

function getBrowserBlockStatusLabel(run: MainRun): string {
  if (run.resumeRequestedAt) {
    return 'Resume requested';
  }
  const browserBlock = run.browserBlock;
  if (!browserBlock) {
    switch (run.blockedReason) {
      case 'phone_approval':
      case 'app_approval':
        return 'Check phone approval';
      case 'code_entry':
      case 'login_required':
        return 'Authentication required';
      case 'manual_takeover':
        return 'Manual step required';
      case 'session_conflict':
        return 'Waiting for browser session';
      default:
        return 'Waiting for approval';
    }
  }
  switch (browserBlock.kind) {
    case 'auth_required':
      return isPhoneApprovalBrowserBlock(browserBlock)
        ? 'Check phone approval'
        : 'Authentication required';
    case 'confirmation_required':
      return 'Approval required';
    case 'human_step_required':
      return 'Manual step required';
    case 'session_conflict':
      return 'Waiting for browser session';
  }
}

function describeMainBrowserCapability(agent: RegisteredAgent | null): {
  badgeLabel: string;
  badgeTone: 'ready' | 'invalid' | 'unknown';
  note: string | null;
} {
  if (!agent) {
    return {
      badgeLabel: 'Browser unknown',
      badgeTone: 'unknown',
      note: null,
    };
  }

  if (agent.toolPermissions.browser !== true) {
    return {
      badgeLabel: 'Browser disabled',
      badgeTone: 'unknown',
      note:
        'The selected Main agent can use web search and fetch, but browser automation is disabled.',
    };
  }

  if (!agent.executionPreview.ready) {
    return {
      badgeLabel: 'Browser misconfigured',
      badgeTone: 'invalid',
      note: agent.executionPreview.message,
    };
  }

  return {
    badgeLabel:
      agent.executionPreview.selectedMode === 'api'
        ? 'Browser ready (API)'
        : agent.executionPreview.selectedMode === 'subscription'
          ? 'Browser ready (Subscription)'
          : 'Browser ready',
    badgeTone: 'ready',
    note: agent.executionPreview.message,
  };
}

function getTriggerMessageForRun(
  run: MainRun,
  messages: MainThreadMessage[],
): MainThreadMessage | null {
  if (!run.triggerMessageId) return null;
  return (
    messages.find(
      (message) =>
        message.id === run.triggerMessageId && message.role === 'user',
    ) || null
  );
}

function canOpenRunInBrowserInstead(
  run: MainRun,
  messages: MainThreadMessage[],
  capability: ReturnType<typeof describeMainBrowserCapability>,
): boolean {
  if (run.taskType !== 'chat') return false;
  if (capability.badgeTone !== 'ready') return false;
  return Boolean(getTriggerMessageForRun(run, messages));
}

function summarizeTerminalMainRun(run: MainRun): {
  statusLabel: 'Failed' | 'Cancelled';
  body: string;
} | null {
  const timeoutSummary = summarizeTimeoutPhase(run.timeoutPhase, null);
  if (run.terminalSummary) {
    return run.terminalSummary;
  }
  if (run.status === 'cancelled') {
    if (run.cancelReason === 'superseded_by_new_user_message') {
      return null;
    }
    if (run.cancelReason === 'interrupted_by_restart') {
      return {
        statusLabel: 'Cancelled',
        body: 'Execution interrupted by server restart.',
      };
    }
    return {
      statusLabel: 'Cancelled',
      body: run.cancelReason
        ? `Run cancelled: ${run.cancelReason}`
        : 'The run was cancelled before a response could be recorded.',
    };
  }

  if (run.status !== 'failed') {
    return null;
  }

  if (!run.cancelReason) {
    return {
      statusLabel: 'Failed',
      body:
        timeoutSummary || 'The run failed before a response could be recorded.',
    };
  }

  const separator = run.cancelReason.indexOf(': ');
  return {
    statusLabel: 'Failed',
    body:
      timeoutSummary ||
      (separator >= 0
        ? run.cancelReason.slice(separator + 2)
        : run.cancelReason),
  };
}

function getMainRunTimelineTimestamp(run: MainRun): number {
  const candidates =
    run.status === 'failed' || run.status === 'cancelled'
      ? [run.endedAt, run.startedAt, run.createdAt]
      : run.status === 'awaiting_confirmation'
        ? [run.browserBlock?.updatedAt, run.startedAt, run.createdAt]
        : [run.startedAt, run.createdAt];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const timestamp = Date.parse(candidate);
    if (Number.isFinite(timestamp) && timestamp > 0) {
      return timestamp;
    }
  }
  return 0;
}

function sortMainThreads(threads: MainThreadSummary[]): MainThreadSummary[] {
  return [...threads].sort((left, right) => {
    if (left.isPinned !== right.isPinned) {
      return Number(right.isPinned) - Number(left.isPinned);
    }
    const delta =
      new Date(right.lastMessageAt).getTime() -
      new Date(left.lastMessageAt).getTime();
    if (Number.isFinite(delta) && delta !== 0) return delta;
    return right.lastMessageAt.localeCompare(left.lastMessageAt);
  });
}

function updateThreadRunState(
  threads: MainThreadSummary[],
  threadId: string,
  hasActiveRun: boolean,
): MainThreadSummary[] {
  return threads.map((thread) =>
    thread.threadId === threadId ? { ...thread, hasActiveRun } : thread,
  );
}

function threadHasActiveRun(
  runsById: Record<string, MainRun>,
  threadId: string,
): boolean {
  return Object.values(runsById).some(
    (run) =>
      run.threadId === threadId &&
      (run.promotionState === 'pending' || isMainRunActive(run)),
  );
}

function isMainRunActive(run: MainRun): boolean {
  return ['queued', 'running', 'awaiting_confirmation'].includes(run.status);
}

function getRunHeartbeatAt(run: MainRun): number {
  for (const candidate of [run.lastHeartbeatAt, run.startedAt, run.createdAt]) {
    if (!candidate) continue;
    const timestamp = Date.parse(candidate);
    if (Number.isFinite(timestamp) && timestamp > 0) {
      return timestamp;
    }
  }
  return 0;
}

function isMainRunStalled(run: MainRun, nowMs: number): boolean {
  if (run.status !== 'queued' && run.status !== 'running') {
    return false;
  }
  const heartbeatAt = getRunHeartbeatAt(run);
  return heartbeatAt > 0 && nowMs - heartbeatAt >= MAIN_RUN_STALLED_AFTER_MS;
}

function appendRunPreview(currentPreview: string | null | undefined, delta: string): string {
  const nextPreview = `${currentPreview || ''}${delta}`;
  if (nextPreview.length <= STREAMED_TEXT_PREVIEW_MAX_CHARS) {
    return nextPreview;
  }
  return nextPreview.slice(nextPreview.length - STREAMED_TEXT_PREVIEW_MAX_CHARS);
}

function patchRun(
  runsById: Record<string, MainRun>,
  runId: string,
  updater: (run: MainRun) => MainRun,
): Record<string, MainRun> {
  const existing = runsById[runId];
  if (!existing) return runsById;
  return {
    ...runsById,
    [runId]: updater(existing),
  };
}

function withThreadActivity(
  threads: MainThreadSummary[],
  runsById: Record<string, MainRun>,
  threadId: string,
): MainThreadSummary[] {
  const hasActiveRun = threadHasActiveRun(runsById, threadId);
  return threads.map((thread) =>
    thread.threadId === threadId ? { ...thread, hasActiveRun } : thread,
  );
}

function upsertRun(
  runsById: Record<string, MainRun>,
  run: MainRun | undefined,
): Record<string, MainRun> {
  if (!run) return runsById;
  return {
    ...runsById,
    [run.id]: {
      ...runsById[run.id],
      ...run,
    },
  };
}

function ThreadPinIcon(): JSX.Element {
  return (
    <span className="thread-pin-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" focusable="false">
        <path
          d="M10.9 1.8a.75.75 0 0 1 1.06 0l2.24 2.24a.75.75 0 0 1 0 1.06L12.7 6.6v2.02a.75.75 0 0 1-.22.53L9.9 11.73v2.77a.75.75 0 0 1-1.28.53l-1.8-1.8a.75.75 0 0 1-.22-.53v-.97H5.6a.75.75 0 0 1-.53-.22l-1.8-1.8a.75.75 0 0 1 .53-1.28h2.77l2.58-2.58a.75.75 0 0 1 .53-.22h2.02l1.2-1.2-1.18-1.18-1.2 1.2H8.5a.75.75 0 0 1-.53-.22L6.3 2.56a.75.75 0 0 1 0-1.06l1.8-1.8a.75.75 0 0 1 1.06 0l1.74 1.74h.02Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

// ============================================================================
// Reducer
// ============================================================================

function mainReducer(state: MainState, action: MainAction): MainState {
  switch (action.type) {
    case 'THREADS_LOADING':
      return { ...state, threadsLoading: true, threadsError: null };
    case 'THREADS_LOADED':
      return {
        ...state,
        threads: action.threads,
        threadsLoading: false,
        threadsError: null,
      };
    case 'THREADS_ERROR':
      return { ...state, threadsLoading: false, threadsError: action.message };
    case 'THREAD_REMOVED':
      return {
        ...state,
        threads: state.threads.filter(
          (thread) => thread.threadId !== action.threadId,
        ),
        activeThreadId:
          state.activeThreadId === action.threadId
            ? null
            : state.activeThreadId,
        messages:
          state.activeThreadId === action.threadId ? [] : state.messages,
        messagesLoading:
          state.activeThreadId === action.threadId
            ? false
            : state.messagesLoading,
        messagesError:
          state.activeThreadId === action.threadId ? null : state.messagesError,
        runsById:
          state.activeThreadId === action.threadId
            ? {}
            : Object.fromEntries(
                Object.entries(state.runsById).filter(
                  ([, run]) => run.threadId !== action.threadId,
                ),
              ),
      };
    case 'THREAD_RUN_STATE':
      return {
        ...state,
        threads: updateThreadRunState(
          state.threads,
          action.threadId,
          action.hasActiveRun,
        ),
      };
    case 'THREAD_SELECTED':
      return {
        ...state,
        activeThreadId: action.threadId,
        messages: [],
        runsById: {},
        messagesLoading: true,
        messagesError: null,
      };
    case 'THREAD_UPDATED':
      return {
        ...state,
        threads: state.threads.map((thread) =>
          thread.threadId === action.threadId
            ? {
                ...thread,
                title: action.title,
                isPinned: action.isPinned,
              }
            : thread,
        ),
      };
    case 'MESSAGES_LOADING':
      return { ...state, messagesLoading: true, messagesError: null };
    case 'MESSAGES_LOADED':
      return {
        ...state,
        messages: action.messages,
        messagesLoading: false,
        messagesError: null,
      };
    case 'RUNS_LOADED': {
      if (action.threadId !== state.activeThreadId) return state;
      const runsById = action.runs.reduce<Record<string, MainRun>>(
        (acc, run) => {
          acc[run.id] = run;
          return acc;
        },
        {},
      );
      return {
        ...state,
        runsById,
        threads: withThreadActivity(state.threads, runsById, action.threadId),
      };
    }
    case 'RUN_UPSERTED': {
      if (!action.run) return state;
      const runsById = upsertRun(state.runsById, action.run);
      const threads = withThreadActivity(
        state.threads,
        runsById,
        action.run.threadId,
      );
      if (
        action.run.parentRunId &&
        runsById[action.run.parentRunId]?.promotionState === 'pending'
      ) {
        runsById[action.run.parentRunId] = {
          ...runsById[action.run.parentRunId],
          promotionState: null,
          promotionChildRunId: action.run.id,
        };
      }
      return {
        ...state,
        runsById,
        threads,
      };
    }
    case 'PROMOTION_PENDING': {
      const existingRun = state.runsById[action.event.runId];
      const runsById = upsertRun(state.runsById, {
        id: action.event.runId,
        threadId: action.event.threadId,
        taskType: existingRun?.taskType || 'chat',
        status: existingRun?.status || 'running',
        createdAt: existingRun?.createdAt || new Date().toISOString(),
        startedAt: existingRun?.startedAt || new Date().toISOString(),
        endedAt: existingRun?.endedAt || null,
        triggerMessageId: existingRun?.triggerMessageId || null,
        targetAgentId: existingRun?.targetAgentId || null,
        cancelReason: existingRun?.cancelReason || null,
        kind: existingRun?.kind || null,
        parentRunId: existingRun?.parentRunId || null,
        promotionState: 'pending',
        promotionChildRunId: existingRun?.promotionChildRunId || null,
        requestedToolFamilies: action.event.requestedToolFamilies,
        userVisibleSummary: action.event.userVisibleSummary,
      });
      return {
        ...state,
        runsById,
        threads: withThreadActivity(
          state.threads,
          runsById,
          action.event.threadId,
        ),
      };
    }
    case 'RUN_TERMINAL': {
      const existingRun = state.runsById[action.runId];
      if (!existingRun) return state;
      const terminalSummary: MainRun['terminalSummary'] =
        action.status === 'failed'
          ? {
              statusLabel: 'Failed',
              body:
                (action.cancelReason !== undefined
                  ? action.cancelReason
                  : existingRun.cancelReason) ||
                'The run failed before a response could be recorded.',
            }
          : action.status === 'cancelled'
            ? summarizeTerminalMainRun({
                ...existingRun,
                status: 'cancelled',
                cancelReason:
                  action.cancelReason !== undefined
                    ? action.cancelReason
                    : existingRun.cancelReason,
              })
            : null;
      const runsById = {
        ...state.runsById,
        [action.runId]: {
          ...existingRun,
          status: action.status,
          endedAt: new Date().toISOString(),
          cancelReason:
            action.cancelReason !== undefined
              ? action.cancelReason
              : existingRun.cancelReason,
          lastHeartbeatAt: new Date().toISOString(),
          terminalSummary,
        },
      };
      return {
        ...state,
        runsById,
        threads: withThreadActivity(state.threads, runsById, action.threadId),
      };
    }
    case 'MESSAGES_ERROR':
      return {
        ...state,
        messagesLoading: false,
        messagesError: action.message,
      };
    case 'MESSAGES_LOADED_FOR_THREAD':
      // Only apply if the user hasn't navigated away — drop stale results
      if (action.threadId !== state.activeThreadId) return state;
      return {
        ...state,
        messages: action.messages,
        messagesLoading: false,
        messagesError: null,
      };
    case 'MESSAGE_APPENDED': {
      // Deduplicate
      if (state.messages.some((m) => m.id === action.message.id)) return state;

      const tid = action.message.threadId;
      const ts = action.message.createdAt;

      // Update thread list: bump existing entry or insert new one
      const knownThread = state.threads.some((t) => t.threadId === tid);
      const threads = knownThread
        ? state.threads.map((t) =>
            t.threadId === tid
              ? {
                  ...t,
                  title:
                    t.title ||
                    (action.message.role === 'user'
                      ? inferThreadTitleFromContent(action.message.content)
                      : t.title),
                  lastMessageAt: ts,
                  messageCount: t.messageCount + 1,
                  hasActiveRun: action.message.role === 'user',
                }
              : t,
          )
        : [
            {
              threadId: tid,
              title:
                action.message.role === 'user'
                  ? inferThreadTitleFromContent(action.message.content)
                  : null,
              isPinned: false,
              lastMessageAt: ts,
              messageCount: 1,
              hasActiveRun: action.message.role === 'user',
            },
            ...state.threads,
          ];

      // Not the active thread — only update thread list
      if (tid !== state.activeThreadId) {
        return { ...state, threads };
      }

      // Active thread — also append message and clear matching live response
      const messages = [...state.messages, action.message];
      let runsById = state.runsById;
      if (action.message.role === 'assistant' && action.message.runId) {
        runsById = patchRun(state.runsById, action.message.runId, (run) => ({
          ...run,
          streamedTextPreview: null,
          lastProgressMessage: null,
          terminalSummary: null,
        }));
      }
      return { ...state, threads, messages, runsById };
    }
    case 'HISTORY_DELETED': {
      if (action.threadId !== state.activeThreadId) return state;
      const deletedIds = new Set(action.deletedMessageIds);
      const messages = state.messages.filter(
        (message) => !deletedIds.has(message.id),
      );
      if (messages.length === 0) {
        return {
          ...state,
          threads: state.threads.filter(
            (thread) => thread.threadId !== action.threadId,
          ),
          activeThreadId: null,
          messages: [],
          runsById: {},
          messagesLoading: false,
          messagesError: null,
        };
      }
      const lastMessageAt = messages[messages.length - 1]?.createdAt;
      return {
        ...state,
        threads: state.threads.map((thread) =>
          thread.threadId === action.threadId
            ? {
                ...thread,
                messageCount: messages.length,
                lastMessageAt: lastMessageAt || thread.lastMessageAt,
              }
            : thread,
        ),
        messages,
      };
    }
    case 'RESPONSE_STARTED': {
      const existing = state.runsById[action.event.runId];
      if (!existing) {
        return {
          ...state,
          threads: updateThreadRunState(
            state.threads,
            action.event.threadId,
            true,
          ),
        };
      }
      const nowIso = new Date().toISOString();
      const runsById = patchRun(state.runsById, action.event.runId, (run) => ({
        ...run,
        status: 'running',
        startedAt: run.startedAt || nowIso,
        endedAt: null,
        cancelReason: null,
        lastHeartbeatAt: nowIso,
        lastProgressMessage: null,
        currentStep: run.currentStep || 'Starting model…',
        timeoutPhase: null,
        terminalSummary: null,
      }));
      return {
        ...state,
        runsById,
        threads: withThreadActivity(state.threads, runsById, action.event.threadId),
      };
    }
    case 'RESPONSE_PROGRESS': {
      const existing = state.runsById[action.event.runId];
      if (!existing) return state;
      const nowIso = new Date().toISOString();
      const runsById = patchRun(state.runsById, action.event.runId, (run) => ({
        ...run,
        lastProgressMessage: action.event.message,
        currentStep: action.event.message,
        lastHeartbeatAt: nowIso,
      }));
      return {
        ...state,
        runsById,
        threads: withThreadActivity(state.threads, runsById, action.event.threadId),
      };
    }
    case 'RESPONSE_HEARTBEAT': {
      const existing = state.runsById[action.event.runId];
      if (!existing) return state;
      const runsById = patchRun(state.runsById, action.event.runId, (run) => ({
        ...run,
        lastHeartbeatAt: action.event.at,
      }));
      return {
        ...state,
        runsById,
        threads: withThreadActivity(state.threads, runsById, action.event.threadId),
      };
    }
    case 'RESPONSE_DELTA': {
      const existing = state.runsById[action.event.runId];
      if (!existing) return state;
      const nowIso = new Date().toISOString();
      const runsById = patchRun(state.runsById, action.event.runId, (run) => ({
        ...run,
        streamedTextPreview: appendRunPreview(
          run.streamedTextPreview,
          action.event.text,
        ),
        lastHeartbeatAt: nowIso,
      }));
      return {
        ...state,
        runsById,
        threads: withThreadActivity(state.threads, runsById, action.event.threadId),
      };
    }
    case 'RESPONSE_COMPLETED': {
      const runsById = patchRun(state.runsById, action.runId, (run) => ({
        ...run,
        lastHeartbeatAt: new Date().toISOString(),
        currentStep: null,
      }));
      return {
        ...state,
        runsById,
        threads: withThreadActivity(state.threads, runsById, action.threadId),
      };
    }
    case 'RESPONSE_FAILED': {
      const existing = state.runsById[action.event.runId];
      if (!existing) {
        return {
          ...state,
          threads: updateThreadRunState(
            state.threads,
            action.event.threadId,
            false,
          ),
        };
      }
      const nowIso = new Date().toISOString();
      const runsById = patchRun(state.runsById, action.event.runId, (run) => ({
        ...run,
        status: 'failed',
        endedAt: nowIso,
        cancelReason: action.event.errorMessage,
        lastHeartbeatAt: nowIso,
        currentStep: null,
        terminalSummary: {
          statusLabel: 'Failed',
          body: action.event.errorMessage,
        },
      }));
      return {
        ...state,
        runsById,
        threads: withThreadActivity(state.threads, runsById, action.event.threadId),
      };
    }
    case 'STREAM_STATE':
      return { ...state, streamState: action.state };
    case 'SEND_STARTED':
      return { ...state, sendState: 'posting', sendError: null };
    case 'SEND_FAILED':
      return { ...state, sendState: 'error', sendError: action.message };
    case 'SEND_CLEARED':
      return { ...state, sendState: 'idle', sendError: null };
    case 'NEW_THREAD_CREATED': {
      // Merge-or-insert: if SSE already inserted this thread via MESSAGE_APPENDED, update it; otherwise prepend.
      const alreadyExists = state.threads.some(
        (t) => t.threadId === action.threadId,
      );
      const threads = alreadyExists
        ? state.threads.map((t) =>
            t.threadId === action.threadId
              ? {
                  ...t,
              title: action.threadSummary.title,
              lastMessageAt: action.threadSummary.lastMessageAt,
              messageCount: Math.max(
                t.messageCount,
                action.threadSummary.messageCount,
              ),
              hasActiveRun: action.threadSummary.hasActiveRun,
            }
          : t,
      )
        : [action.threadSummary, ...state.threads];
      return {
        ...state,
        threads,
        activeThreadId: action.threadId,
        messages: [],
        runsById: {},
        messagesLoading: false,
        messagesError: null,
      };
    }
    case 'CLEAR_THREAD':
      return {
        ...state,
        activeThreadId: null,
        messages: [],
        runsById: {},
        messagesLoading: false,
        messagesError: null,
      };
    default:
      return state;
  }
}

// ============================================================================
// Component
// ============================================================================

export function MainChannelPage({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const { threadId: routeThreadId } = useParams<{ threadId?: string }>();
  const [state, dispatch] = useReducer(mainReducer, createInitialState());
  const [draft, setDraft] = useState('');
  const [mainAgent, setMainAgent] = useState<RegisteredAgent | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeThreadIdRef = useRef<string | null>(state.activeThreadId);
  const runsByIdRef = useRef<Record<string, MainRun>>(state.runsById);
  const threadSnapshotVersionRef = useRef(0);
  const firstVisibleReportedRunIdsRef = useRef<Set<string>>(new Set());
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [threadMenu, setThreadMenu] = useState<{
    threadId: string;
    x: number;
    y: number;
  } | null>(null);
  const [historyEditorOpen, setHistoryEditorOpen] = useState(false);
  const [historyEditState, setHistoryEditState] = useState<{
    status: 'idle' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });
  const [openInBrowserPendingRunId, setOpenInBrowserPendingRunId] = useState<
    string | null
  >(null);
  const [openInBrowserState, setOpenInBrowserState] =
    useState<OpenInBrowserNotice | null>(null);
  const [runClockMs, setRunClockMs] = useState(() => Date.now());

  // ── Auto-scroll ──
  const isNearBottom = useCallback(() => {
    const container = timelineRef.current;
    if (!container) return true;
    return (
      container.scrollHeight - container.scrollTop - container.clientHeight <
      SCROLL_STICK_THRESHOLD_PX
    );
  }, []);

  const scrollToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const reportRunVisible = useCallback((runId: string) => {
    if (firstVisibleReportedRunIdsRef.current.has(runId)) return;
    firstVisibleReportedRunIdsRef.current.add(runId);
    void postMainRunVisible({
      runId,
      firstVisibleAt: new Date().toISOString(),
    }).catch(() => {
      firstVisibleReportedRunIdsRef.current.delete(runId);
    });
  }, []);

  const refreshActiveThread = useCallback(
    async ({
      refreshThreads = false,
    }: {
      refreshThreads?: boolean;
    } = {}) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      const snapshotVersion = threadSnapshotVersionRef.current;
      try {
        const [messages, runs, threads] = await Promise.all([
          getMainThread(threadId),
          listMainRuns(threadId),
          refreshThreads ? listMainThreads() : Promise.resolve(null),
        ]);
        if (
          threadId !== activeThreadIdRef.current ||
          snapshotVersion !== threadSnapshotVersionRef.current
        ) {
          return;
        }
        if (threads !== null) {
          dispatch({ type: 'THREADS_LOADED', threads });
        }
        dispatch({
          type: 'MESSAGES_LOADED_FOR_THREAD',
          threadId,
          messages,
        });
        dispatch({ type: 'RUNS_LOADED', threadId, runs });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
        }
      }
    },
    [onUnauthorized],
  );

  // ── Load threads ──
  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'THREADS_LOADING' });
    listMainThreads()
      .then((threads) => {
        if (cancelled) return;
        dispatch({ type: 'THREADS_LOADED', threads });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        dispatch({ type: 'THREADS_ERROR', message: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  useEffect(() => {
    let cancelled = false;
    getMainRegisteredAgent()
      .then((agent) => {
        if (cancelled) return;
        setMainAgent(agent);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setMainAgent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  // ── Sync route threadId ──
  useEffect(() => {
    if (state.threadsLoading) return;
    if (!routeThreadId) {
      if (state.activeThreadId) {
        dispatch({ type: 'CLEAR_THREAD' });
      }
      return;
    }

    const isKnownThread = state.threads.some(
      (thread) => thread.threadId === routeThreadId,
    );
    if (!isKnownThread) {
      if (state.activeThreadId) {
        dispatch({ type: 'CLEAR_THREAD' });
      }
      navigate('/app/main', { replace: true });
      return;
    }

    if (routeThreadId !== state.activeThreadId) {
      dispatch({ type: 'THREAD_SELECTED', threadId: routeThreadId });
    }
  }, [
    navigate,
    routeThreadId,
    state.activeThreadId,
    state.threads,
    state.threadsLoading,
  ]);

  // Keep ref in sync for use in SSE callbacks (avoids SSE effect depending on activeThreadId)
  activeThreadIdRef.current = state.activeThreadId;
  runsByIdRef.current = state.runsById;

  useEffect(() => {
    threadSnapshotVersionRef.current += 1;
    setOpenInBrowserPendingRunId(null);
    setOpenInBrowserState(null);
  }, [state.activeThreadId]);

  // ── Load messages when activeThreadId changes ──
  useEffect(() => {
    if (!state.activeThreadId) return;
    const threadId = state.activeThreadId;
    const snapshotVersion = threadSnapshotVersionRef.current;
    let cancelled = false;
    dispatch({ type: 'MESSAGES_LOADING' });
    getMainThread(threadId)
      .then((messages) => {
        if (cancelled) return;
        if (
          threadId !== activeThreadIdRef.current ||
          snapshotVersion !== threadSnapshotVersionRef.current
        ) {
          return;
        }
        dispatch({ type: 'MESSAGES_LOADED_FOR_THREAD', threadId, messages });
        // Scroll to bottom after messages load
        requestAnimationFrame(() => scrollToBottom());
      })
      .catch((err) => {
        if (cancelled) return;
        if (
          threadId !== activeThreadIdRef.current ||
          snapshotVersion !== threadSnapshotVersionRef.current
        ) {
          return;
        }
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          dispatch({ type: 'THREAD_REMOVED', threadId });
          navigate('/app/main', { replace: true });
          return;
        }
        dispatch({ type: 'MESSAGES_ERROR', message: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, onUnauthorized, scrollToBottom, state.activeThreadId]);

  useEffect(() => {
    if (!state.activeThreadId) return;
    const threadId = state.activeThreadId;
    const snapshotVersion = threadSnapshotVersionRef.current;
    let cancelled = false;
    listMainRuns(threadId)
      .then((runs) => {
        if (cancelled) return;
        if (
          threadId !== activeThreadIdRef.current ||
          snapshotVersion !== threadSnapshotVersionRef.current
        ) {
          return;
        }
        dispatch({ type: 'RUNS_LOADED', threadId, runs });
        for (const run of runs) {
          if (
            run.promotionState === 'pending' ||
            ['queued', 'running', 'awaiting_confirmation'].includes(run.status)
          ) {
            reportRunVisible(run.id);
          }
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (
          threadId !== activeThreadIdRef.current ||
          snapshotVersion !== threadSnapshotVersionRef.current
        ) {
          return;
        }
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized, reportRunVisible, state.activeThreadId]);

  // ── SSE Stream ──
  useEffect(() => {
    const handle = openMainStream({
      onMessageAppended: (event: MainMessageAppendedEvent) => {
        const message: MainThreadMessage = {
          id: event.messageId,
          threadId: event.threadId,
          role: event.role,
          content: event.content || '',
          runId: event.runId || null,
          agentId: event.agentId || null,
          createdBy: event.createdBy,
          createdAt: event.createdAt || new Date().toISOString(),
        };
        dispatch({ type: 'MESSAGE_APPENDED', message });
        if (isNearBottom()) {
          requestAnimationFrame(() => scrollToBottom());
        }
      },
      onRunQueued: (event: MainRunEvent) => {
        reportRunVisible(event.runId);
        dispatch({
          type: 'RUN_UPSERTED',
          run: {
            id: event.runId,
            threadId: event.threadId,
            taskType: 'chat',
            status: 'queued',
            createdAt: event.createdAt || new Date().toISOString(),
            startedAt: null,
            endedAt: null,
            triggerMessageId: event.triggerMessageId || null,
            targetAgentId: null,
            cancelReason: null,
            kind: 'main_promotion',
            parentRunId: event.parentRunId || null,
            promotionState: null,
            promotionChildRunId: null,
            requestedToolFamilies: event.requestedToolFamilies || [],
            userVisibleSummary: event.userVisibleSummary || null,
            lastHeartbeatAt: event.createdAt || new Date().toISOString(),
            terminalSummary: null,
          },
        });
      },
      onRunStarted: (event: MainRunEvent) => {
        reportRunVisible(event.runId);
        const existing = runsByIdRef.current[event.runId];
        dispatch({
          type: 'RUN_UPSERTED',
          run: {
            id: event.runId,
            threadId: event.threadId,
            taskType: existing?.taskType || 'chat',
            status: 'running',
            createdAt: existing?.createdAt || new Date().toISOString(),
            startedAt: event.startedAt || new Date().toISOString(),
            endedAt: null,
            triggerMessageId: existing?.triggerMessageId || null,
            targetAgentId: existing?.targetAgentId || null,
            cancelReason: null,
            kind: existing?.kind || null,
            parentRunId: existing?.parentRunId || null,
            promotionState: existing?.promotionState || null,
            promotionChildRunId: existing?.promotionChildRunId || null,
            requestedToolFamilies: existing?.requestedToolFamilies || [],
            userVisibleSummary: existing?.userVisibleSummary || null,
            lastHeartbeatAt: event.startedAt || new Date().toISOString(),
            terminalSummary: null,
          },
        });
      },
      onRunWaitingApproval: (event: MainRunEvent) => {
        reportRunVisible(event.runId);
        const existing = runsByIdRef.current[event.runId];
        dispatch({
          type: 'RUN_UPSERTED',
          run: {
            id: event.runId,
            threadId: event.threadId,
            taskType: existing?.taskType || 'chat',
            status: 'awaiting_confirmation',
            createdAt: event.createdAt || existing?.createdAt || new Date().toISOString(),
            startedAt: event.startedAt || existing?.startedAt || null,
            endedAt: null,
            triggerMessageId: event.triggerMessageId || existing?.triggerMessageId || null,
            targetAgentId: existing?.targetAgentId || null,
            cancelReason: null,
            kind: 'main_promotion',
            parentRunId: event.parentRunId || existing?.parentRunId || null,
            promotionState: null,
            promotionChildRunId: null,
            requestedToolFamilies: event.requestedToolFamilies || existing?.requestedToolFamilies || [],
            userVisibleSummary: event.userVisibleSummary || existing?.userVisibleSummary || null,
            lastHeartbeatAt: new Date().toISOString(),
            terminalSummary: null,
          },
        });
      },
      onRunCompleted: (event: MainRunEvent) => {
        dispatch({
          type: 'RUN_TERMINAL',
          runId: event.runId,
          threadId: event.threadId,
          status: 'completed',
        });
      },
      onRunFailed: (event: MainRunEvent) => {
        dispatch({
          type: 'RUN_TERMINAL',
          runId: event.runId,
          threadId: event.threadId,
          status: 'failed',
          cancelReason: event.errorMessage || null,
        });
      },
      onRunCancelled: (event: MainRunEvent) => {
        dispatch({
          type: 'RUN_TERMINAL',
          runId: event.runId,
          threadId: event.threadId,
          status: 'cancelled',
          cancelReason: event.cancelReason || null,
        });
      },
      onPromotionPending: (event: MainPromotionPendingEvent) => {
        reportRunVisible(event.runId);
        dispatch({ type: 'PROMOTION_PENDING', event });
      },
      onBrowserBlocked: (event) => {
        if (event.threadId !== activeThreadIdRef.current) return;
        void refreshActiveThread({ refreshThreads: true });
      },
      onBrowserUnblocked: (event) => {
        if (event.threadId !== activeThreadIdRef.current) return;
        void refreshActiveThread({ refreshThreads: true });
      },
      onResponseStarted: (event) => {
        reportRunVisible(event.runId);
        dispatch({ type: 'RESPONSE_STARTED', event });
      },
      onProgressUpdate: (event) => {
        reportRunVisible(event.runId);
        dispatch({ type: 'RESPONSE_PROGRESS', event });
      },
      onHeartbeat: (event) => {
        reportRunVisible(event.runId);
        dispatch({ type: 'RESPONSE_HEARTBEAT', event });
      },
      onResponseDelta: (event) => {
        reportRunVisible(event.runId);
        dispatch({ type: 'RESPONSE_DELTA', event });
        if (isNearBottom()) {
          requestAnimationFrame(() => scrollToBottom());
        }
      },
      onResponseCompleted: (event) => {
        dispatch({
          type: 'RESPONSE_COMPLETED',
          runId: event.runId,
          threadId: event.threadId,
        });
      },
      onResponseFailed: (event) => {
        dispatch({ type: 'RESPONSE_FAILED', event });
      },
      onStateChange: (streamState) => {
        dispatch({ type: 'STREAM_STATE', state: streamState });
      },
      onReplayGap: () => {
        void refreshActiveThread();
      },
      onUnauthorized,
    });

    return () => handle.close();
  }, [
    onUnauthorized,
    isNearBottom,
    refreshActiveThread,
    reportRunVisible,
    scrollToBottom,
  ]);

  // ── Thread selection ──
  const selectThread = useCallback(
    (threadId: string) => {
      navigate(`/app/main/${threadId}`);
    },
    [navigate],
  );

  const openThreadMenu = useCallback(
    (threadId: string, x: number, y: number) => {
      setThreadMenu({ threadId, x, y });
    },
    [],
  );

  const handleThreadContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const threadId = event.currentTarget.dataset.threadId;
      if (!threadId) return;
      event.preventDefault();
      openThreadMenu(threadId, event.clientX, event.clientY);
    },
    [openThreadMenu],
  );

  const startNewThread = useCallback(() => {
    navigate('/app/main');
    dispatch({ type: 'CLEAR_THREAD' });
    setDraft('');
    setHistoryEditorOpen(false);
    setHistoryEditState({ status: 'idle' });
  }, [navigate]);

  // ── Build timeline entries ──
  const timeline = useMemo(() => {
    const entries: MainTimelineEntry[] = [];
    const visibleMessageIds = new Set(
      state.messages
        .filter((message) => message.threadId === state.activeThreadId)
        .map((message) => message.id),
    );
    const assistantRunIds = new Set(
      state.messages
        .filter(
          (message) =>
            message.threadId === state.activeThreadId &&
            message.role === 'assistant' &&
            message.runId,
        )
        .map((message) => message.runId as string),
    );
    for (const message of state.messages) {
      entries.push({ kind: 'message', message });
    }
    for (const run of Object.values(state.runsById)) {
      if (run.threadId !== state.activeThreadId) continue;
      const isPromotionPending = run.promotionState === 'pending';
      const isBlockedRunCard = isBlockedBrowserRun(run);
      const isGenericActiveRun =
        isMainRunActive(run) && !isBlockedRunCard;
      if (isPromotionPending || isBlockedRunCard || isGenericActiveRun) {
        entries.push({ kind: 'run', run });
        continue;
      }

      if (
        !run.triggerMessageId ||
        !visibleMessageIds.has(run.triggerMessageId)
      ) {
        continue;
      }

      const terminalSummary = summarizeTerminalMainRun(run);
      if (terminalSummary && !assistantRunIds.has(run.id)) {
        entries.push({ kind: 'terminal-run', run });
      }
    }
    return entries.sort((left, right) => {
      const leftAt =
        left.kind === 'message'
          ? Date.parse(left.message.createdAt)
          : getMainRunTimelineTimestamp(left.run);
      const rightAt =
        right.kind === 'message'
          ? Date.parse(right.message.createdAt)
          : getMainRunTimelineTimestamp(right.run);
      return leftAt - rightAt;
    });
  }, [state.activeThreadId, state.messages, state.runsById]);

  // ── Stream badge ──
  const streamBadgeClass = `stream-badge stream-${state.streamState}`;
  const streamBadgeLabel =
    state.streamState === 'live'
      ? 'Connected'
      : state.streamState === 'connecting'
        ? 'Connecting…'
        : state.streamState === 'reconnecting'
          ? 'Reconnecting…'
          : 'Offline';

  // ── Textarea auto-resize ──
  const handleDraftChange = useCallback((value: string) => {
    if (value.length <= MAIN_MESSAGE_MAX_CHARS) {
      setDraft(value);
    }
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, []);

  // ── Sorted threads (most recent first) ──
  const sortedThreads = useMemo(
    () => sortMainThreads(state.threads),
    [state.threads],
  );
  const activeThread = useMemo(
    () =>
      sortedThreads.find(
        (thread) => thread.threadId === state.activeThreadId,
      ) || null,
    [sortedThreads, state.activeThreadId],
  );
  const activeRound = useMemo(
    () =>
      Boolean(activeThread?.hasActiveRun) ||
      (state.activeThreadId
        ? threadHasActiveRun(state.runsById, state.activeThreadId)
        : false),
    [activeThread?.hasActiveRun, state.activeThreadId, state.runsById],
  );
  const mainBrowserCapability = useMemo(
    () => describeMainBrowserCapability(mainAgent),
    [mainAgent],
  );
  const canEditHistory = useMemo(
    () =>
      Boolean(state.activeThreadId) &&
      !activeRound &&
      state.messages.some((message) => message.role !== 'system'),
    [activeRound, state.activeThreadId, state.messages],
  );
  useEffect(() => {
    if (
      !state.activeThreadId ||
      !Object.values(state.runsById).some(
        (run) => run.threadId === state.activeThreadId && isMainRunActive(run),
      )
    ) {
      return;
    }
    const interval = window.setInterval(() => {
      setRunClockMs(Date.now());
    }, 5_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [state.activeThreadId, state.runsById]);
  const historyEditorMessages = useMemo<TalkMessage[]>(
    () =>
      state.messages.map((message) => ({
        ...message,
        runId: null,
      })),
    [state.messages],
  );
  const menuThread = useMemo(
    () =>
      threadMenu
        ? state.threads.find((thread) => thread.threadId === threadMenu.threadId) ||
          null
        : null,
    [state.threads, threadMenu],
  );

  const updateThreadMetadata = useCallback(
    async (
      threadId: string,
      patch: {
        title?: string;
        pinned?: boolean;
      },
    ) => {
      try {
        const updated = await updateMainThread({
          threadId,
          ...patch,
        });
        dispatch({
          type: 'THREAD_UPDATED',
          threadId: updated.threadId,
          title: updated.title,
          isPinned: updated.isPinned,
        });
        dispatch({ type: 'SEND_CLEARED' });
        return updated;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
        }
        throw err;
      }
    },
    [onUnauthorized],
  );

  const handleRenameThread = useCallback(
    async (threadId: string, title: string) => {
      await updateThreadMetadata(threadId, { title });
      setEditingThreadId((current) => (current === threadId ? null : current));
    },
    [updateThreadMetadata],
  );

  const handleDeleteThread = useCallback(
    async (thread: MainThreadSummary) => {
      const confirmed = window.confirm(
        `Delete "${displayThreadTitle(thread.title)}"? This will permanently remove the thread and its messages.`,
      );
      if (!confirmed) return;
      try {
        await deleteMainThread(thread.threadId);
        const remaining = sortMainThreads(
          state.threads.filter(
            (candidate) => candidate.threadId !== thread.threadId,
          ),
        );
        dispatch({ type: 'THREAD_REMOVED', threadId: thread.threadId });
        setEditingThreadId((current) =>
          current === thread.threadId ? null : current,
        );
        if (state.activeThreadId === thread.threadId) {
          navigate(
            remaining[0] ? `/app/main/${remaining[0].threadId}` : '/app/main',
          );
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        dispatch({
          type: 'THREADS_ERROR',
          message:
            err instanceof Error ? err.message : 'Failed to delete thread.',
        });
      }
    },
    [navigate, onUnauthorized, state.activeThreadId, state.threads],
  );

  const openHistoryEditor = useCallback(() => {
    if (!state.activeThreadId) {
      setHistoryEditState({
        status: 'error',
        message: 'Select a Main thread before editing history.',
      });
      return;
    }
    if (activeRound) {
      setHistoryEditState({
        status: 'error',
        message:
          'Wait for the current response to finish or cancel it before editing history.',
      });
      return;
    }
    if (!state.messages.some((message) => message.role !== 'system')) {
      setHistoryEditState({
        status: 'error',
        message: 'There are no editable messages in this Main thread yet.',
      });
      return;
    }
    setHistoryEditState({ status: 'idle' });
    setHistoryEditorOpen(true);
  }, [activeRound, state.activeThreadId, state.messages]);

  const handleCloseHistoryEditor = useCallback(() => {
    if (historyEditState.status === 'saving') return;
    setHistoryEditorOpen(false);
    setHistoryEditState((current) =>
      current.status === 'success' ? current : { status: 'idle' },
    );
  }, [historyEditState.status]);

  const resolveHistoryActorLabel = useCallback((message: TalkMessage) => {
    if (message.role === 'assistant') return 'Nanoclaw';
    if (message.role === 'tool') return 'Nanoclaw';
    return null;
  }, []);

  const handleDeleteHistoryMessages = useCallback(
    async (messageIds: string[]) => {
      const threadId = state.activeThreadId;
      if (!threadId) return;
      if (messageIds.length === 0) {
        setHistoryEditState({
          status: 'error',
          message: 'Select at least one message to delete.',
        });
        return;
      }
      const confirmed = window.confirm(
        `Delete ${messageIds.length} selected message${
          messageIds.length === 1 ? '' : 's'
        } from this Main thread history?`,
      );
      if (!confirmed) return;

      setHistoryEditState({ status: 'saving' });
      try {
        const result = await deleteMainMessages({
          threadId,
          messageIds,
        });
        if (result.threadDeleted) {
          dispatch({ type: 'THREAD_REMOVED', threadId });
          navigate('/app/main', { replace: true });
        } else {
          threadSnapshotVersionRef.current += 1;
          dispatch({
            type: 'HISTORY_DELETED',
            threadId,
            deletedMessageIds: result.deletedMessageIds,
          });
          void refreshActiveThread({ refreshThreads: true });
        }
        setHistoryEditorOpen(false);
        setHistoryEditState({
          status: 'success',
          message: `Deleted ${result.deletedCount} message${
            result.deletedCount === 1 ? '' : 's'
          } from this Main thread history.`,
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (err instanceof ApiError && err.code === 'message_not_found') {
          threadSnapshotVersionRef.current += 1;
          void refreshActiveThread({ refreshThreads: true });
        }
        setHistoryEditState({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Unable to edit Main thread history.',
        });
      }
    },
    [navigate, onUnauthorized, refreshActiveThread, state.activeThreadId],
  );

  const handleOpenInBrowserInstead = useCallback(
    async (run: MainRun) => {
      const triggerMessage = getTriggerMessageForRun(run, state.messages);
      if (!triggerMessage) {
        setOpenInBrowserState({
          runId: run.id,
          tone: 'error',
          message:
            'The original user message is no longer available for browser retry.',
        });
        return;
      }

      setOpenInBrowserState(null);
      setOpenInBrowserPendingRunId(run.id);
      try {
        if (isMainRunActive(run)) {
          try {
            await cancelMainRun({ runId: run.id });
          } catch (error) {
            if (
              !(error instanceof ApiError && error.code === 'no_active_run')
            ) {
              throw error;
            }
          }
        }

        const result = await postMainMessage({
          content: triggerMessage.content,
          threadId: run.threadId,
          forceBrowser: true,
        });
        reportRunVisible(result.run.id);
        await refreshActiveThread({ refreshThreads: true });
        setOpenInBrowserState({
          runId: run.id,
          tone: 'success',
          message: isMainRunActive(run)
            ? 'Cancelled the chat run and queued a browser run from the same prompt.'
            : 'Queued a browser run from the same prompt.',
        });
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setOpenInBrowserState({
          runId: run.id,
          tone: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Unable to retry this prompt as a browser run.',
        });
      } finally {
        setOpenInBrowserPendingRunId((current) =>
          current === run.id ? null : current,
        );
      }
    },
    [onUnauthorized, refreshActiveThread, reportRunVisible, state.messages],
  );

  // ── Send message ──
  const handleSend = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const content = draft.trim();
      if (!content || state.sendState === 'posting') return;
      if (content === '/edit') {
        setDraft('');
        dispatch({ type: 'SEND_CLEARED' });
        openHistoryEditor();
        return;
      }

      dispatch({ type: 'SEND_STARTED' });
      setDraft('');

      try {
        const result = await postMainMessage({
          content,
          threadId: state.activeThreadId || undefined,
        });

        dispatch({ type: 'RUN_UPSERTED', run: result.run });
        reportRunVisible(result.run.id);

        if (!state.activeThreadId) {
          dispatch({
            type: 'NEW_THREAD_CREATED',
            threadId: result.threadId,
            threadSummary: {
              threadId: result.threadId,
              title: result.title || inferThreadTitleFromContent(content),
              isPinned: false,
              lastMessageAt: new Date().toISOString(),
              messageCount: 1,
              hasActiveRun: true,
            },
          });
          navigate(`/app/main/${result.threadId}`, { replace: true });
        } else {
          dispatch({
            type: 'THREAD_RUN_STATE',
            threadId: result.threadId,
            hasActiveRun: true,
          });
        }

        dispatch({ type: 'SEND_CLEARED' });
        requestAnimationFrame(() => scrollToBottom());
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        const msg =
          err instanceof ApiError && err.code === 'thread_busy'
            ? 'Thread is busy — wait for the current response to finish.'
            : err instanceof Error
              ? err.message
              : 'Failed to send message';
        dispatch({ type: 'SEND_FAILED', message: msg });
        setDraft(content);
      }
    },
    [
      draft,
      navigate,
      onUnauthorized,
      openHistoryEditor,
      reportRunVisible,
      scrollToBottom,
      state.activeThreadId,
      state.sendState,
    ],
  );

  // ── Keyboard submit (Enter without Shift) ──
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (draft.trim() && state.sendState !== 'posting') {
          void handleSend(event as unknown as FormEvent);
        }
      }
    },
    [draft, state.sendState, handleSend],
  );

  const renderThreadMeta = useCallback((thread: MainThreadSummary) => {
    if (thread.threadId === state.activeThreadId) {
      const threadRuns = Object.values(state.runsById).filter(
        (run) => run.threadId === thread.threadId,
      );
      const blockedRun = threadRuns.find((run) => isBlockedBrowserRun(run));
      if (blockedRun) {
        return (
          <span className="main-thread-item-meta main-thread-item-meta-responding">
            * {getBrowserBlockStatusLabel(blockedRun)}
          </span>
        );
      }
      const stalledRun = threadRuns.find((run) =>
        isMainRunStalled(run, runClockMs),
      );
      if (stalledRun) {
        return (
          <span className="main-thread-item-meta main-thread-item-meta-responding">
            * Stalled
          </span>
        );
      }
      const activeRun = threadRuns.find((run) => isMainRunActive(run));
      if (activeRun) {
        return (
          <span className="main-thread-item-meta main-thread-item-meta-responding">
            * {activeRun.currentStep || 'Working…'}
          </span>
        );
      }
    }
    if (thread.hasActiveRun) {
      return (
        <span className="main-thread-item-meta main-thread-item-meta-responding">
          * Working…
        </span>
      );
    }

    return (
      <span className="main-thread-item-meta">
        {thread.messageCount} msg · {formatRelativeTime(thread.lastMessageAt)}
      </span>
    );
  }, [runClockMs, state.activeThreadId, state.runsById]);

  const hasActiveThread = !!routeThreadId;

  return (
    <div className="main-channel-shell">
      {/* Thread List Sidebar */}
      <aside className="main-thread-list" aria-label="Threads">
        <div className="main-thread-list-header">
          <h2>Main (Nanoclaw)</h2>
          <ThreadStartButton onClick={startNewThread} />
        </div>

        {state.threadsLoading ? (
          <p className="main-thread-list-empty">Loading threads…</p>
        ) : state.threadsError ? (
          <p className="main-thread-list-empty">{state.threadsError}</p>
        ) : sortedThreads.length === 0 ? (
          <p className="main-thread-list-empty">
            No threads yet. Start a conversation below.
          </p>
        ) : (
          <ul className="main-thread-items">
            {sortedThreads.map((thread) => (
              <li key={thread.threadId}>
                {editingThreadId === thread.threadId ? (
                  <div
                    className={`main-thread-item${
                      thread.threadId === state.activeThreadId
                        ? ' main-thread-item-active'
                        : ''
                    } main-thread-item-editing`}
                    data-thread-id={thread.threadId}
                    onContextMenu={handleThreadContextMenu}
                  >
                    <ThreadRowTitleEditor
                      title={displayThreadTitle(thread.title)}
                      isEditing={true}
                      onSave={(title) =>
                        handleRenameThread(thread.threadId, title)
                      }
                      onCancel={() => setEditingThreadId(null)}
                      staticClassName="main-thread-item-title"
                      inputClassName="thread-row-title-input"
                      errorClassName="thread-row-title-error"
                      leadingVisual={
                        thread.isPinned ? <ThreadPinIcon /> : undefined
                      }
                    />
                    {renderThreadMeta(thread)}
                  </div>
                ) : (
                  <button
                    type="button"
                    className={`main-thread-item${
                      thread.threadId === state.activeThreadId
                        ? ' main-thread-item-active'
                        : ''
                    }`}
                    data-thread-id={thread.threadId}
                    onClick={() => selectThread(thread.threadId)}
                    onContextMenu={handleThreadContextMenu}
                  >
                    <ThreadRowTitleEditor
                      title={displayThreadTitle(thread.title)}
                      isEditing={false}
                      onSave={() => undefined}
                      onCancel={() => undefined}
                      staticClassName="main-thread-item-title"
                      inputClassName="thread-row-title-input"
                      errorClassName="thread-row-title-error"
                      leadingVisual={
                        thread.isPinned ? <ThreadPinIcon /> : undefined
                      }
                    />
                    {renderThreadMeta(thread)}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* Thread Detail */}
      <div className="main-thread-detail">
        <header className="main-thread-detail-header">
          <div className="main-thread-detail-title">
            {hasActiveThread ? (
              activeThread ? (
                <InlineEditableTitle
                  title={displayThreadTitle(activeThread.title)}
                  onSave={(title) =>
                    handleRenameThread(activeThread.threadId, title)
                  }
                  buttonClassName="thread-detail-title-button"
                  inputClassName="thread-detail-title-input"
                  errorClassName="thread-detail-title-error"
                />
              ) : (
                <span>{displayThreadTitle(null)}</span>
              )
            ) : (
              <span>New thread</span>
            )}
            {hasActiveThread ? (
              <p className="policy-muted">
                Use <code>/edit</code> or the button here to remove old messages
                from this thread.
              </p>
            ) : null}
            {mainBrowserCapability.note ? (
              <p className="policy-muted main-thread-capability-note">
                {mainBrowserCapability.note}
              </p>
            ) : null}
          </div>
          <div className="thread-detail-header-actions">
            <div
              className="main-thread-capability-list"
              role="list"
              aria-label="Main capability status"
            >
              <span
                className={`talk-status-pill talk-status-pill-${mainBrowserCapability.badgeTone}`}
                role="listitem"
              >
                {mainBrowserCapability.badgeLabel}
              </span>
            </div>
            <button
              type="button"
              className="secondary-btn"
              onClick={openHistoryEditor}
              disabled={!canEditHistory}
            >
              Edit history
            </button>
            <span className={streamBadgeClass}>{streamBadgeLabel}</span>
          </div>
        </header>

        {historyEditState.status === 'success' && historyEditState.message ? (
          <div className="inline-banner inline-banner-success" role="status">
            {historyEditState.message}
          </div>
        ) : null}
        {historyEditState.status === 'error' && historyEditState.message ? (
          <div className="inline-banner inline-banner-error" role="alert">
            {historyEditState.message}
          </div>
        ) : null}

        <div className="main-thread-timeline" ref={timelineRef}>
          {state.messagesLoading ? (
            <p className="page-state">Loading messages…</p>
          ) : state.messagesError ? (
            <p className="page-state">{state.messagesError}</p>
          ) : !hasActiveThread && timeline.length === 0 ? (
            <div className="main-empty-state">
              <h3>Nanoclaw</h3>
              <p>
                Your primary everyday AI surface. Ask anything — Nanoclaw has
                web search and web fetch tools available.
              </p>
            </div>
          ) : timeline.length === 0 ? (
            <p className="page-state">No messages yet.</p>
          ) : (
            timeline.map((entry) => {
              if (entry.kind === 'message') {
                const { message } = entry;
                return (
                  <article
                    key={message.id}
                    className={`message message-${message.role}`}
                  >
                    <header>
                      <strong>{message.role}</strong>
                      <time>
                        {new Date(message.createdAt).toLocaleString()}
                      </time>
                    </header>
                    <p>
                      {message.role === 'assistant'
                        ? stripInternalAssistantText(message.content)
                        : message.content}
                    </p>
                  </article>
                );
              }

              if (entry.kind === 'run') {
                const { run } = entry;
                const isStalled = isMainRunStalled(run, runClockMs);
                const runMetaLine = formatMainRunMetaLine(run);
                const canOpenInBrowser = canOpenRunInBrowserInstead(
                  run,
                  state.messages,
                  mainBrowserCapability,
                );
                const openInBrowserNotice =
                  openInBrowserState?.runId === run.id
                    ? openInBrowserState
                    : null;
                const statusLabel =
                  run.promotionState === 'pending'
                    ? 'Starting background task…'
                    : isStalled
                      ? 'Stalled'
                    : run.status === 'awaiting_confirmation'
                      ? getBrowserBlockStatusLabel(run)
                    : run.status === 'queued'
                        ? 'Queued'
                        : 'Working';
                const runBodyCopy =
                  (run.resumeRequestedAt
                    ? 'Will resume when current task finishes.'
                    : null) ||
                  run.currentStep ||
                  run.streamedTextPreview ||
                  run.lastProgressMessage ||
                  run.userVisibleSummary ||
                  (isStalled
                    ? 'This run has stopped sending progress updates. Refreshing run state or retrying may be required.'
                    : null) ||
                  (run.status === 'awaiting_confirmation'
                    ? 'Waiting for your approval before continuing.'
                    : run.status === 'queued'
                      ? 'Preparing the run…'
                      : 'Run in progress…');
                return (
                  <article
                    key={`run-${run.id}`}
                    className="message message-system main-run-chip"
                  >
                    <header>
                      <strong>Nanoclaw</strong>
                      <time>{statusLabel}</time>
                    </header>
                    {run.browserBlock ? (
                      <BrowserBlockedRunCard
                        runId={run.id}
                        browserBlock={run.browserBlock}
                        resumeRequestedAt={run.resumeRequestedAt}
                        executionDecision={run.executionDecision}
                        onUnauthorized={onUnauthorized}
                        onStateChanged={refreshActiveThread}
                      />
                    ) : (
                      <p>
                        <em>* {runBodyCopy}</em>
                      </p>
                    )}
                    {canOpenInBrowser ? (
                      <div className="browser-block-actions">
                        <button
                          type="button"
                          className="secondary-btn"
                          disabled={openInBrowserPendingRunId === run.id}
                          onClick={() => {
                            void handleOpenInBrowserInstead(run);
                          }}
                        >
                          {openInBrowserPendingRunId === run.id
                            ? 'Opening in browser…'
                            : 'Open in browser instead'}
                        </button>
                      </div>
                    ) : null}
                    {openInBrowserNotice ? (
                      <p className="browser-block-message">
                        {openInBrowserNotice.message}
                      </p>
                    ) : null}
                    {runMetaLine ? (
                      <p className="policy-muted">{runMetaLine}</p>
                    ) : null}
                  </article>
                );
              }

              if (entry.kind === 'terminal-run') {
                const { run } = entry;
                const terminalSummary = summarizeTerminalMainRun(run);
                const canOpenInBrowser = canOpenRunInBrowserInstead(
                  run,
                  state.messages,
                  mainBrowserCapability,
                );
                const openInBrowserNotice =
                  openInBrowserState?.runId === run.id
                    ? openInBrowserState
                    : null;
                if (!terminalSummary) {
                  return null;
                }
                return (
                  <article
                    key={`terminal-run-${run.id}`}
                    className={`message message-assistant${
                      run.status === 'failed' ? ' message-error' : ''
                    }`}
                  >
                    <header>
                      <strong>Nanoclaw</strong>
                      <time>{terminalSummary.statusLabel}</time>
                    </header>
                    <p>{terminalSummary.body}</p>
                    {run.streamedTextPreview ? (
                      <p>{run.streamedTextPreview}</p>
                    ) : null}
                    {formatMainRunMetaLine(run) ? (
                      <p className="policy-muted">
                        {formatMainRunMetaLine(run)}
                      </p>
                    ) : null}
                    {canOpenInBrowser ? (
                      <div className="browser-block-actions">
                        <button
                          type="button"
                          className="secondary-btn"
                          disabled={openInBrowserPendingRunId === run.id}
                          onClick={() => {
                            void handleOpenInBrowserInstead(run);
                          }}
                        >
                          {openInBrowserPendingRunId === run.id
                            ? 'Opening in browser…'
                            : 'Open in browser instead'}
                        </button>
                      </div>
                    ) : null}
                    {openInBrowserNotice ? (
                      <p className="browser-block-message">
                        {openInBrowserNotice.message}
                      </p>
                    ) : null}
                    <ExecutionDecisionSummary
                      executionDecision={run.executionDecision}
                    />
                  </article>
                );
              }
            })
          )}
          <div ref={endRef} />
        </div>

        {/* Composer */}
        <form className="main-composer" onSubmit={handleSend}>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Nanoclaw…"
            rows={1}
            disabled={state.sendState === 'posting'}
          />
          <button
            type="submit"
            className="main-send-btn"
            disabled={!draft.trim() || state.sendState === 'posting'}
          >
            {state.sendState === 'posting' ? 'Sending…' : 'Send'}
          </button>
        </form>
        {state.sendState === 'error' && state.sendError ? (
          <p className="main-send-error">{state.sendError}</p>
        ) : null}
        {threadMenu && menuThread ? (
          <ThreadContextMenu
            x={threadMenu.x}
            y={threadMenu.y}
            isPinned={menuThread.isPinned}
            onClose={() => setThreadMenu(null)}
            onRename={() => setEditingThreadId(menuThread.threadId)}
            onTogglePin={() => {
              void updateThreadMetadata(menuThread.threadId, {
                pinned: !menuThread.isPinned,
              }).catch((err) => {
                dispatch({
                  type: 'THREADS_ERROR',
                  message:
                    err instanceof Error
                      ? err.message
                      : 'Failed to update thread.',
                });
              });
            }}
            onDelete={() => void handleDeleteThread(menuThread)}
          />
        ) : null}
        <TalkHistoryEditor
          isOpen={historyEditorOpen}
          messages={historyEditorMessages}
          busy={historyEditState.status === 'saving'}
          errorMessage={
            historyEditorOpen && historyEditState.status === 'error'
              ? historyEditState.message || null
              : null
          }
          onClose={handleCloseHistoryEditor}
          onConfirm={handleDeleteHistoryMessages}
          resolveActorLabel={resolveHistoryActorLabel}
        />
      </div>
    </div>
  );
}

// ── Helpers ──

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
