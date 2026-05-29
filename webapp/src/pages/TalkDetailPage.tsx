import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import {
  Component,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import {
  AgentProviderCard,
  AiAgentsPageData,
  attachTalkDataConnector,
  ApiError,
  cancelTalkRuns,
  ChannelConnection,
  ChannelInstructionReview,
  ChannelQueueFailure,
  ChannelTarget,
  ChannelTargetListPage,
  Content,
  ContentEditSummary,
  ContentFormat,
  ContentSidebarItem,
  ContextGoal,
  ContextRule,
  ContextSource,
  createTalkContent,
  createThreadContent,
  getThreadContent,
  patchContent,
  createTalkThread,
  createTalkChannel,
  createTalkContextRule,
  createTalkJob,
  DataConnector,
  deleteTalkChannel,
  deleteTalkChannelBindingState,
  deleteTalkChannelDeliveryFailure,
  deleteTalkChannelIngressFailure,
  deleteTalkMessages,
  deleteTalkThread,
  deleteTalkContextRule,
  deleteTalkJob,
  deleteTalkStateEntry,
  detachTalkDataConnector,
  getAiAgents,
  getDataConnectors,
  getTalk,
  getTalkAgents,
  getTalkContent,
  getTalkJob,
  getTalkState,
  getTalkContext,
  getTalkRunContext,
  getTalkDataConnectors,
  getTalkRuns,
  listTalkJobRuns,
  listTalkJobs,
  listTalkThreads,
  listChannelConnections,
  listChannelTargets,
  listTalkChannelDeliveryFailures,
  listTalkChannelIngressFailures,
  listTalkChannels,
  listTalkChannelBindingState,
  syncSlackWorkspace,
  listTalkMessages,
  searchTalkMessages,
  patchTalkChannel,
  patchTalkContextRule,
  patchTalkMetadata,
  patchTalkJob,
  retryTalkChannelDeliveryFailure,
  retryTalkChannelIngressFailure,
  reviewTalkChannelInstructions,
  sendTalkMessage,
  setTalkGoal,
  Talk,
  TalkAgent,
  TalkJob,
  TalkJobRunSummary,
  TalkJobSchedule,
  TalkJobScope,
  TalkJobWeekday,
  TalkChannelBinding,
  TalkChannelBindingStateEntry,
  TalkDataConnector,
  TalkMessage,
  TalkMessageSearchResult,
  TalkMessageAttachment,
  TalkRun,
  TalkSnapshot,
  TalkRunContextSnapshot,
  TalkStateEntry,
  TalkThread,
  uploadTalkAttachment,
  testTalkChannelBinding,
  unquarantineTalkChannelBinding,
  retryTalkChannelDeliveryFailuresCapped,
  upsertTalkChannelBindingState,
  updateTalkAgents,
  updateTalkThread,
  pauseTalkJob,
  resumeTalkJob,
  runTalkJobNow,
  listRegisteredAgents,
  type RegisteredAgent,
  UnauthorizedError,
} from '../lib/api';
import { BrowserBlockedRunCard } from '../components/BrowserBlockedRunCard';
import { CopyExportMenu } from '../components/CopyExportMenu';
import { DocPaneHeader, type DocPaneMode } from '../components/DocPaneHeader';
import { DocPaneEdgeTab } from '../components/DocPaneEdgeTab';
import { PendingEditDocSurface } from '../components/PendingEditDocSurface';
import { SafeHtml } from '../components/SafeHtml';
import { ExecutionDecisionSummary } from '../components/ExecutionDecisionSummary';
import { LiveResponsePanel } from '../components/LiveResponsePanel';
import { InlineEditableTitle } from '../components/InlineEditableTitle';
import { TalkToolsPanel } from '../components/TalkToolsPanel';
import { SavedSourcesPanel } from '../components/SavedSourcesPanel';
import {
  SourceMentionPicker,
  buildSourceMentionOptions,
  type SourceMentionOption,
} from '../components/SourceMentionPicker';
import { ToolChipsBar } from '../components/ToolChipsBar';
import { TalkConnectorsPanel } from '../components/connectors/TalkConnectorsPanel';
import { ThreadContextMenu } from '../components/ThreadContextMenu';
import { ThreadRowTitleEditor } from '../components/ThreadRowTitleEditor';
import { ThreadStartButton } from '../components/ThreadStartButton';
import { TalkHistoryEditor } from '../components/TalkHistoryEditor';
import { stripInternalAssistantText } from '../lib/assistantText';
import {
  getContentSplitRatio,
  setContentSplitRatio,
} from '../lib/contentSplitRatio';
import {
  getLastThreadForTalk,
  setLastThreadForTalk,
} from '../lib/lastThreadForTalk';
import { linkifyText } from '../lib/linkifyText';
import {
  clearThreadScroll,
  loadThreadScroll,
  saveThreadScroll,
} from '../lib/threadScroll';
import { displayThreadTitle } from '../lib/threadTitles';
import { openTalkStream } from '../lib/talkStream';
import { useQueryClient } from '@tanstack/react-query';
import {
  rememberActiveThreadForTalk,
  snapshotQueryKey,
  useTalkSnapshot,
} from '../lib/useTalkSnapshot';
import {
  appendTalkMessageToSnapshot,
  applyMessageAppendedDelta,
  createWsCacheRouter,
  patchTalkInSnapshot,
  prependOlderTalkMessagesToSnapshot,
} from '../lib/wsCacheRouter';
import { type RichTextEditorSaveStatus } from '../components/rich-text/RichTextEditor';
import type {
  TalkBrowserBlockedEvent,
  TalkBrowserUnblockedEvent,
  MessageAppendedEvent,
  TalkContentEditAppliedEvent,
  TalkContentEditResolvedEvent,
  TalkContentEditRunAbortedEvent,
  TalkContentEditRunStartedEvent,
  TalkContentUpdatedEvent,
  TalkHistoryEditedEvent,
  TalkProgressUpdateEvent,
  TalkResponseDeltaEvent,
  TalkResponseStartedEvent,
  TalkResponseTerminalEvent,
  TalkResponseUsageEvent,
  TalkRunCancelledEvent,
  TalkRunCompletedEvent,
  TalkRunFailedEvent,
  TalkRunRetryingEvent,
  TalkRunStartedEvent,
  TalkStreamState,
} from '../lib/talkStream';

type TabKey = 'talk' | 'agents' | 'context' | 'connectors' | 'runs';

type TalkOrchestrationMode = Talk['orchestrationMode'];

const ORCHESTRATION_MODE_OPTIONS: ReadonlyArray<{
  value: TalkOrchestrationMode;
  label: string;
}> = [
  { value: 'ordered', label: 'Ordered' },
  { value: 'panel', label: 'Parallel' },
];

const ORCHESTRATION_MODE_TOOLTIP =
  'Ordered is turn based synthesis focused multi-agent response. Parallel is fast independent response.';

function getOrchestrationModeLabel(mode: TalkOrchestrationMode): string {
  return mode === 'ordered' ? 'Ordered' : 'Parallel';
}

function getOrderedStepTone(run: RunView): OrderedRoundStepTone {
  switch (run.status) {
    case 'running':
    case 'awaiting_confirmation':
      return 'active';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'warning';
    case 'queued':
    default:
      return 'muted';
  }
}

function getOrderedStepStatusLabel(run: RunView, totalSteps: number): string {
  switch (run.status) {
    case 'running':
      return run.sequenceIndex === totalSteps - 1
        ? 'synthesizing'
        : 'responding';
    case 'awaiting_confirmation':
      return 'awaiting confirmation';
    case 'queued':
      return 'queued';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return run.cancelReason === 'blocked_by_prior_failure'
        ? 'blocked by prior failure'
        : 'cancelled';
    default:
      return run.status;
  }
}

type RunView = TalkRun & {
  updatedAt: number;
};

export type LiveResponseView = {
  runId: string;
  rawText: string;
  text: string;
  progressMessage?: string;
  agentId?: string | null;
  agentNickname?: string | null;
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
  providerId?: string | null;
  modelId?: string | null;
  errorCode?: string | null;
  errorMessage?: string;
  startedAt: number;
  queuedAt: number;
  pendingStatus?: 'queued' | 'running' | 'reconnecting';
  terminalStatus?: 'completed' | 'failed' | 'cancelled';
  // Queue retry visibility. Set when a `talk_run_retrying` event lands
  // (CF Queues redelivered the message). LiveResponsePanel reads
  // `retryAttempt` to show "Retrying N/maxRetries" instead of "Queued".
  retryAttempt?: number;
  retryMaxRetries?: number;
};

export type { RunView };

type OrderedRoundStepTone =
  | 'active'
  | 'success'
  | 'error'
  | 'warning'
  | 'muted';

type OrderedRoundStepSummary = {
  runId: string;
  stepNumber: number;
  label: string;
  statusLabel: string;
  tone: OrderedRoundStepTone;
  isCurrent: boolean;
  isSynthesis: boolean;
};

type OrderedRoundSummary = {
  heading: string;
  note: string | null;
  progressLabel: string | null;
  steps: OrderedRoundStepSummary[];
  retryRunId: string | null;
};

type RunContextPanelState = {
  open: boolean;
  status: 'idle' | 'loading' | 'loaded' | 'error';
  snapshot: TalkRunContextSnapshot | null;
  message?: string;
};

type TalkTimelineEntry =
  | {
      kind: 'message';
      key: string;
      timestamp: number;
      sortOrder: number;
      message: TalkMessage;
    }
  | {
      kind: 'live-response';
      key: string;
      timestamp: number;
      sortOrder: number;
      response: LiveResponseView;
    }
  | {
      kind: 'browser-run';
      key: string;
      timestamp: number;
      sortOrder: number;
      run: RunView;
    };

type ThreadListState = {
  threads: TalkThread[];
  loading: boolean;
  error: string | null;
};

type TalkJobDraft = {
  title: string;
  prompt: string;
  targetAgentId: string;
  scheduleKind: TalkJobSchedule['kind'];
  everyHours: number;
  weekdays: TalkJobWeekday[];
  hour: number;
  minute: number;
  timezone: string;
  connectorIds: string[];
  channelBindingIds: string[];
  allowWeb: boolean;
};

// PR C (talk-load architecture refactor): server data — talk, messages,
// threads, content — moved to React Query (snapshotQuery). This reducer
// holds only UI state + live streaming/runs state that the WS event
// fan-out needs to render token-by-token without re-rendering the
// snapshot subscriber tree.
type DetailState = {
  selectedThreadId: string | null;
  runsById: Record<string, RunView>;
  streamState: TalkStreamState;
  sendState: {
    status: 'idle' | 'posting' | 'error';
    error?: string;
    lastDraft?: string;
  };
  liveResponsesByRunId: Record<string, LiveResponseView>;
  cancelState: {
    status: 'idle' | 'posting' | 'success' | 'error';
    message?: string;
  };
  hasUnreadBelow: boolean;
};

const JOB_WEEKDAY_ORDER: TalkJobWeekday[] = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
];

const JOB_WEEKDAY_LABELS: Record<TalkJobWeekday, string> = {
  sun: 'Sun',
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
};

function getDefaultJobTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function buildDefaultJobDraft(input?: {
  targetAgentId?: string;
  timezone?: string;
}): TalkJobDraft {
  return {
    title: '',
    prompt: '',
    targetAgentId: input?.targetAgentId ?? '',
    scheduleKind: 'weekly',
    everyHours: 24,
    weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    hour: 9,
    minute: 0,
    timezone: input?.timezone ?? getDefaultJobTimezone(),
    connectorIds: [],
    channelBindingIds: [],
    allowWeb: false,
  };
}

function buildJobDraftFromJob(job: TalkJob): TalkJobDraft {
  return {
    title: job.title,
    prompt: job.prompt,
    targetAgentId: job.targetAgentId ?? '',
    scheduleKind: job.schedule.kind,
    everyHours:
      job.schedule.kind === 'hourly_interval' ? job.schedule.everyHours : 24,
    weekdays:
      job.schedule.kind === 'weekly'
        ? [...job.schedule.weekdays]
        : ['mon', 'tue', 'wed', 'thu', 'fri'],
    hour: job.schedule.kind === 'weekly' ? job.schedule.hour : 9,
    minute: job.schedule.kind === 'weekly' ? job.schedule.minute : 0,
    timezone: job.timezone,
    connectorIds: [...job.sourceScope.connectorIds],
    channelBindingIds: [...job.sourceScope.channelBindingIds],
    allowWeb: job.sourceScope.allowWeb,
  };
}

function draftToTalkJobSchedule(draft: TalkJobDraft): TalkJobSchedule {
  if (draft.scheduleKind === 'hourly_interval') {
    return {
      kind: 'hourly_interval',
      everyHours: Math.max(1, Math.min(24, Math.trunc(draft.everyHours || 1))),
    };
  }
  return {
    kind: 'weekly',
    weekdays:
      draft.weekdays.length > 0
        ? draft.weekdays
        : ['mon', 'tue', 'wed', 'thu', 'fri'],
    hour: Math.max(0, Math.min(23, Math.trunc(draft.hour || 0))),
    minute: Math.max(0, Math.min(59, Math.trunc(draft.minute || 0))),
  };
}

function draftToTalkJobScope(draft: TalkJobDraft): TalkJobScope {
  return {
    connectorIds: [...draft.connectorIds],
    channelBindingIds: [...draft.channelBindingIds],
    allowWeb: draft.allowWeb,
  };
}

function formatTalkJobSchedule(schedule: TalkJobSchedule): string {
  if (schedule.kind === 'hourly_interval') {
    return `Every ${schedule.everyHours} hour${schedule.everyHours === 1 ? '' : 's'}`;
  }
  const days = schedule.weekdays
    .map((day) => JOB_WEEKDAY_LABELS[day])
    .join(', ');
  return `${days} at ${String(schedule.hour).padStart(2, '0')}:${String(
    schedule.minute,
  ).padStart(2, '0')}`;
}

function summarizeTalkJobScope(
  scope: TalkJobScope,
  connectors: TalkDataConnector[],
  bindings: TalkChannelBinding[],
): string {
  const parts: string[] = [];
  if (scope.connectorIds.length > 0) {
    parts.push(
      `${scope.connectorIds.length} connector${
        scope.connectorIds.length === 1 ? '' : 's'
      }`,
    );
  }
  if (scope.channelBindingIds.length > 0) {
    parts.push(
      `${scope.channelBindingIds.length} channel binding${
        scope.channelBindingIds.length === 1 ? '' : 's'
      }`,
    );
  }
  if (scope.allowWeb) {
    parts.push('web access');
  }
  if (parts.length === 0) {
    return 'No extra scoped sources selected.';
  }
  const connectorNames = connectors
    .filter((connector) => scope.connectorIds.includes(connector.id))
    .map((connector) => connector.name);
  const channelNames = bindings
    .filter((binding) => scope.channelBindingIds.includes(binding.id))
    .map((binding) => binding.displayName);
  const named = [...connectorNames, ...channelNames];
  return named.length > 0
    ? `${parts.join(' · ')}: ${named.join(', ')}`
    : parts.join(' · ');
}

type DetailAction =
  | { type: 'TALK_RESET' }
  | { type: 'SNAPSHOT_HYDRATED'; threadId: string; runs: TalkRun[] }
  | { type: 'THREAD_SELECTED'; threadId: string | null }
  | { type: 'MERGE_HISTORICAL_RUNS'; runs: TalkRun[] }
  | {
      type: 'MESSAGE_LANDED';
      message: TalkMessage;
      wasNearBottom: boolean;
    }
  | {
      type: 'RUN_STARTED';
      runId: string;
      threadId?: string | null;
      triggerMessageId: string | null;
      executorAlias?: string | null;
      executorModel?: string | null;
      createdAt?: string | null;
      targetAgentId?: string | null;
      targetAgentNickname?: string | null;
      responseGroupId?: string | null;
      sequenceIndex?: number | null;
    }
  | {
      type: 'RUN_QUEUED';
      runId: string;
      threadId?: string | null;
      triggerMessageId: string | null;
      executorAlias?: string | null;
      executorModel?: string | null;
      createdAt?: string | null;
      targetAgentId?: string | null;
      targetAgentNickname?: string | null;
      responseGroupId?: string | null;
      sequenceIndex?: number | null;
    }
  | {
      type: 'RUN_RETRYING';
      runId: string;
      retryAttempt: number;
      maxRetries: number;
    }
  | {
      type: 'RUN_COMPLETED';
      runId: string;
      threadId?: string | null;
      triggerMessageId: string | null;
      responseMessageId: string | null;
      executorAlias?: string | null;
      executorModel?: string | null;
      responseGroupId?: string | null;
      sequenceIndex?: number | null;
    }
  | {
      type: 'RUN_FAILED';
      runId: string;
      threadId?: string | null;
      showInlineFailure: boolean;
      triggerMessageId: string | null;
      errorCode: string;
      errorMessage: string;
      executorAlias?: string | null;
      executorModel?: string | null;
      responseGroupId?: string | null;
      sequenceIndex?: number | null;
    }
  | {
      type: 'RUN_CANCELLED_BATCH';
      runIds: string[];
      cancelledBy?: string | null;
    }
  | { type: 'RESPONSE_STARTED'; event: TalkResponseStartedEvent }
  | { type: 'RESPONSE_PROGRESS'; event: TalkProgressUpdateEvent }
  | { type: 'RESPONSE_DELTA'; event: TalkResponseDeltaEvent }
  | { type: 'RESPONSE_COMPLETED'; event: TalkResponseTerminalEvent }
  | { type: 'RESPONSE_FAILED'; event: TalkResponseTerminalEvent }
  | { type: 'RESPONSE_CANCELLED'; event: TalkResponseTerminalEvent }
  | { type: 'STREAM_CONNECTING' }
  | { type: 'STREAM_LIVE' }
  | { type: 'STREAM_RECONNECTING' }
  | { type: 'STREAM_OFFLINE' }
  | { type: 'SEND_STARTED' }
  | { type: 'SEND_FAILED'; message: string; lastDraft: string }
  | { type: 'SEND_CLEARED' }
  | { type: 'CANCEL_STARTED' }
  | { type: 'CANCEL_SUCCEEDED'; message: string }
  | { type: 'CANCEL_FAILED'; message: string }
  | { type: 'CLEAR_UNREAD' };

const SCROLL_STICK_THRESHOLD_PX = 120;
const TALK_MESSAGE_MAX_CHARS = 20_000;
// Grace window after RUN_COMPLETED before we refetch the active thread to
// pick up a missing MESSAGE_APPENDED. 3s is long enough to absorb normal
// out-of-order delivery and short enough that the user doesn't stare at an
// empty timeline.
const MISSING_PERSISTED_MESSAGE_REFETCH_MS = 3_000;
const MAX_EVENT_RUN_CACHE = 500;
const COMPOSER_TEXTAREA_MIN_HEIGHT_PX = 48;
const COMPOSER_TEXTAREA_MAX_HEIGHT_PX = 240;
const BINDING_INSTRUCTIONS_TEXTAREA_MAX_HEIGHT_PX = 360;

const TALK_AGENT_ROLE_OPTIONS: TalkAgent['role'][] = [
  'assistant',
  'analyst',
  'critic',
  'strategist',
  'devils-advocate',
  'synthesizer',
  'editor',
];

function formatPersonaRoleLabel(
  role: TalkRunContextSnapshot['personaRole'],
): string {
  if (!role) return 'Unspecified';
  return role
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function renderRunContextSnapshot(
  snapshot: TalkRunContextSnapshot,
): JSX.Element {
  return (
    <div className="run-context-panel">
      <p className="run-context-meta">
        Role: <strong>{formatPersonaRoleLabel(snapshot.personaRole)}</strong>
        {' · '}
        Estimated context: <code>{snapshot.estimatedTokens}</code> tokens
        {' · '}
        History messages: <code>{snapshot.history.turnCount}</code>
      </p>
      {snapshot.roleHint ? (
        <p className="run-context-note">{snapshot.roleHint}</p>
      ) : null}
      {snapshot.activeRules.length > 0 ? (
        <div className="run-context-section">
          <strong>Rules</strong>
          <ul>
            {snapshot.activeRules.map((rule, index) => (
              <li key={`${index}-${rule}`}>{rule}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {snapshot.stateSnapshot.included.length > 0 ? (
        <div className="run-context-section">
          <strong>State Snapshot</strong>
          <ul>
            {snapshot.stateSnapshot.included.map((entry) => (
              <li key={`${entry.key}-${entry.version}`}>
                <code>{entry.key}</code> v{entry.version}:{' '}
                <code>{JSON.stringify(entry.value)}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {snapshot.retrieval.state.length > 0 ? (
        <div className="run-context-section">
          <strong>Retrieved State</strong>
          <ul>
            {snapshot.retrieval.state.map((entry) => (
              <li key={`${entry.key}-${entry.version}`}>
                <code>{entry.key}</code> v{entry.version}:{' '}
                <code>{JSON.stringify(entry.value)}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {snapshot.retrieval.sources.length > 0 ? (
        <div className="run-context-section">
          <strong>Retrieved Sources</strong>
          <ul>
            {snapshot.retrieval.sources.map((source) => (
              <li key={source.ref}>
                <span>
                  [{source.ref}] {source.title}
                </span>
                <p>{source.excerpt}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {snapshot.sources.manifest.length > 0 ? (
        <div className="run-context-section">
          <strong>Source Manifest</strong>
          <p className="run-context-meta">
            {snapshot.sources.manifest
              .map((source) => `[${source.ref}] ${source.title}`)
              .join(', ')}
          </p>
        </div>
      ) : null}
      <div className="run-context-section">
        <strong>Available Tools</strong>
        <p className="run-context-meta">
          Context:{' '}
          <code>{snapshot.tools.contextToolNames.join(', ') || 'none'}</code>
        </p>
        <p className="run-context-meta">
          Connectors:{' '}
          <code>{snapshot.tools.connectorToolNames.join(', ') || 'none'}</code>
        </p>
      </div>
    </div>
  );
}

type AgentCreationDraft = {
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  modelId: string;
  role: TalkAgent['role'];
};

type InstructionTemplateKey = 'blank' | 'study_tracker';

type InstructionLintStatus =
  | 'ready'
  | 'needs_more_specifics'
  | 'potential_conflicts';

type InstructionLintResult = {
  status: InstructionLintStatus;
  messages: string[];
};

type ChannelInstructionReviewState = {
  status: 'idle' | 'reviewing' | 'error' | 'ready';
  review: ChannelInstructionReview | null;
  message?: string;
};

type BindingMemoryPanelState = {
  status: 'idle' | 'loading' | 'saving' | 'ready' | 'error';
  stateNamespace: string;
  entries: TalkChannelBindingStateEntry[];
  newKeySuffix: string;
  newValueJson: string;
  errorMessage?: string;
};

const CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY = '__create__';

type ChannelBindingDraft = {
  displayName: string;
  active: boolean;
  responseMode: TalkChannelBinding['responseMode'];
  responderMode: TalkChannelBinding['responderMode'];
  responderAgentId: string;
  deliveryMode: TalkChannelBinding['deliveryMode'];
  timezone: string;
  instructions: string;
  template: InstructionTemplateKey;
  inboundRateLimitPerMinute: string;
  maxPendingEvents: string;
  overflowPolicy: TalkChannelBinding['overflowPolicy'];
  maxDeferredAgeMinutes: string;
};

type ChannelCreateDraft = {
  platform: ChannelConnection['platform'] | '';
  connectionId: string;
  targetKey: string;
  displayName: string;
  responseMode: TalkChannelBinding['responseMode'];
  responderMode: TalkChannelBinding['responderMode'];
  responderAgentId: string;
  deliveryMode: TalkChannelBinding['deliveryMode'];
  timezone: string;
  instructions: string;
  template: InstructionTemplateKey;
  inboundRateLimitPerMinute: string;
  maxPendingEvents: string;
  overflowPolicy: TalkChannelBinding['overflowPolicy'];
  maxDeferredAgeMinutes: string;
};

type ChannelTargetInventoryState = ChannelTargetListPage;

type TalkAgentSourceOption = {
  id: string;
  label: string;
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
};

function createInitialDetailState(): DetailState {
  return {
    selectedThreadId: null,
    runsById: {},
    streamState: 'connecting',
    sendState: { status: 'idle' },
    liveResponsesByRunId: {},
    cancelState: { status: 'idle' },
    hasUnreadBelow: false,
  };
}

function summarizeMessageForRun(
  message: TalkMessage | undefined,
  messageId: string,
): string {
  if (!message) return messageId;
  const compact = message.content.trim().replace(/\s+/g, ' ');
  const preview = compact.length > 42 ? `${compact.slice(0, 42)}…` : compact;
  return `${message.role}: ${preview || '(empty)'}`;
}

function toRunView(run: TalkRun): RunView {
  return {
    ...run,
    updatedAt:
      Date.parse(run.completedAt || run.startedAt || run.createdAt) ||
      Date.now(),
  };
}

function mapRunsById(runs: TalkRun[]): Record<string, RunView> {
  return runs.reduce<Record<string, RunView>>((acc, run) => {
    acc[run.id] = toRunView(run);
    return acc;
  }, {});
}

const EMPTY_MESSAGES: TalkMessage[] = [];

// Stable conversion from the snapshot's wire shape to the webapp's Talk
// type (defaults `title` to '' and `agents` to []) so render-site reads
// against `snapshot.talk` get the same shape the old reducer mirrored.
function snapshotTalkToTalk(snapshotTalk: TalkSnapshot['talk']): Talk {
  return {
    id: snapshotTalk.id,
    ownerId: snapshotTalk.ownerId,
    title: snapshotTalk.title ?? '',
    orchestrationMode: snapshotTalk.orchestrationMode,
    agents: [],
    status: snapshotTalk.status,
    folderId: snapshotTalk.folderId,
    sortOrder: snapshotTalk.sortOrder,
    version: snapshotTalk.version,
    createdAt: snapshotTalk.createdAt,
    updatedAt: snapshotTalk.updatedAt,
    accessRole: snapshotTalk.accessRole,
  };
}

function snapshotRunsToTalkRuns(snapshotRuns: TalkSnapshot['runs']): TalkRun[] {
  return snapshotRuns.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    responseGroupId: row.responseGroupId,
    sequenceIndex: row.sequenceIndex,
    status: row.status,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.endedAt,
    triggerMessageId: row.triggerMessageId,
    targetAgentId: row.targetAgentId,
    targetAgentNickname: null,
    errorCode: null,
    errorMessage: null,
    cancelReason: null,
    executorAlias: row.executorAlias,
    executorModel: row.executorModel,
  }));
}

function deriveLiveResponsesFromRuns(
  runs: TalkRun[],
  threadId: string | null,
): Record<string, LiveResponseView> {
  const result: Record<string, LiveResponseView> = {};
  for (const run of runs) {
    if (threadId !== null && run.threadId !== threadId) continue;
    if (!isNonTerminalRunStatus(run.status)) continue;
    const queuedAt = Date.parse(run.createdAt) || Date.now();
    result[run.id] = {
      runId: run.id,
      rawText: '',
      text: '',
      agentId: run.targetAgentId ?? null,
      agentNickname: run.targetAgentNickname ?? null,
      responseGroupId: run.responseGroupId ?? null,
      sequenceIndex: run.sequenceIndex ?? null,
      queuedAt,
      startedAt: run.startedAt
        ? Date.parse(run.startedAt) || queuedAt
        : queuedAt,
      pendingStatus: run.status === 'queued' ? 'queued' : 'running',
    };
  }
  return result;
}

function pruneEventRunCache(
  runsById: Record<string, RunView>,
): Record<string, RunView> {
  const entries = Object.entries(runsById);
  if (entries.length <= MAX_EVENT_RUN_CACHE) {
    return runsById;
  }

  const pinned = entries.filter(([, run]) =>
    ['queued', 'running', 'awaiting_confirmation'].includes(run.status),
  );
  const overflow = Math.max(0, pinned.length - MAX_EVENT_RUN_CACHE);
  const retainedPinned =
    overflow > 0 ? pinned.slice(0, MAX_EVENT_RUN_CACHE) : pinned;
  const remainingSlots = Math.max(
    0,
    MAX_EVENT_RUN_CACHE - retainedPinned.length,
  );
  const recentTerminal = entries
    .filter(
      ([, run]) =>
        !['queued', 'running', 'awaiting_confirmation'].includes(run.status),
    )
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, remainingSlots);

  return Object.fromEntries([...retainedPinned, ...recentTerminal]);
}

function isNonTerminalRunStatus(
  status: TalkRun['status'] | RunView['status'] | undefined,
): boolean {
  return (
    status === 'queued' ||
    status === 'running' ||
    status === 'awaiting_confirmation'
  );
}

function clearFailedLiveResponsesForThread(
  liveResponsesByRunId: Record<string, LiveResponseView>,
  runsById: Record<string, RunView>,
  threadId: string,
): Record<string, LiveResponseView> {
  const next = { ...liveResponsesByRunId };
  for (const [runId, response] of Object.entries(next)) {
    if (response.terminalStatus !== 'failed') continue;
    if (runsById[runId]?.threadId !== threadId) continue;
    delete next[runId];
  }
  return next;
}

function shouldShowInlineFailure(input: {
  selectedThreadId: string | null;
  eventThreadId?: string | null;
  existing?: LiveResponseView;
  priorRun?: RunView;
  showInlineFailure?: boolean;
}): boolean {
  if (input.showInlineFailure === false) return false;
  if (!input.eventThreadId || input.eventThreadId !== input.selectedThreadId) {
    return false;
  }
  return (
    Boolean(input.existing) || isNonTerminalRunStatus(input.priorRun?.status)
  );
}

function hasFileTransfer(
  dataTransfer: DataTransfer | null | undefined,
): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files.length > 0) return true;

  const { types } = dataTransfer;
  if (!types) return false;

  const domTypes = types as unknown as DOMStringList;
  if (typeof domTypes.contains === 'function') {
    return domTypes.contains('Files');
  }

  return Array.from(types as ArrayLike<string>).includes('Files');
}

function withRun(
  state: DetailState,
  runId: string,
  patch: Partial<RunView> & Pick<RunView, 'status'>,
): Record<string, RunView> {
  const now = Date.now();
  const current = state.runsById[runId];
  return pruneEventRunCache({
    ...state.runsById,
    [runId]: {
      id: runId,
      threadId:
        patch.threadId !== undefined
          ? patch.threadId
          : (current?.threadId ?? ''),
      status: patch.status,
      createdAt:
        patch.createdAt ?? current?.createdAt ?? new Date(now).toISOString(),
      startedAt:
        patch.startedAt !== undefined
          ? patch.startedAt
          : (current?.startedAt ?? null),
      completedAt:
        patch.completedAt !== undefined
          ? patch.completedAt
          : (current?.completedAt ?? null),
      triggerMessageId:
        patch.triggerMessageId !== undefined
          ? patch.triggerMessageId
          : (current?.triggerMessageId ?? null),
      responseGroupId:
        patch.responseGroupId !== undefined
          ? patch.responseGroupId
          : (current?.responseGroupId ?? null),
      sequenceIndex:
        patch.sequenceIndex !== undefined
          ? patch.sequenceIndex
          : (current?.sequenceIndex ?? null),
      targetAgentId:
        patch.targetAgentId !== undefined
          ? patch.targetAgentId
          : (current?.targetAgentId ?? null),
      targetAgentNickname:
        patch.targetAgentNickname !== undefined
          ? patch.targetAgentNickname
          : (current?.targetAgentNickname ?? null),
      errorCode:
        patch.errorCode !== undefined
          ? patch.errorCode
          : (current?.errorCode ?? null),
      errorMessage:
        patch.errorMessage !== undefined
          ? patch.errorMessage
          : (current?.errorMessage ?? null),
      cancelReason:
        patch.cancelReason !== undefined
          ? patch.cancelReason
          : (current?.cancelReason ?? null),
      executorAlias:
        patch.executorAlias !== undefined
          ? patch.executorAlias
          : (current?.executorAlias ?? null),
      executorModel:
        patch.executorModel !== undefined
          ? patch.executorModel
          : (current?.executorModel ?? null),
      updatedAt: now,
    },
  });
}

function detailReducer(state: DetailState, action: DetailAction): DetailState {
  switch (action.type) {
    case 'TALK_RESET':
      // Cross-talk navigation: previously BOOTSTRAP_LOADING cleared the
      // full reducer state because the snapshot hydrate replaced it.
      // PR C kept the existing run cache so a parallel-fetch race
      // wouldn't drop in-flight runs — but on a fresh talkId the old
      // talk's runs/live state must not survive into the new one.
      return createInitialDetailState();
    case 'SNAPSHOT_HYDRATED': {
      // First snapshot hydration for a (talkId, threadId). Seed runsById
      // from the snapshot's active runs while preserving any live-state
      // already accumulated from WS deltas that beat the snapshot. The
      // first-paint scroll position is owned by threadScroll — the
      // thread-show effect restores it on mount.
      const incoming = mapRunsById(action.runs);
      const merged = { ...incoming };
      for (const [runId, view] of Object.entries(state.runsById)) {
        merged[runId] = { ...merged[runId], ...view };
      }
      const seededLive = deriveLiveResponsesFromRuns(
        action.runs,
        action.threadId,
      );
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      for (const [runId, view] of Object.entries(seededLive)) {
        if (!liveResponsesByRunId[runId]) liveResponsesByRunId[runId] = view;
      }
      return {
        ...state,
        selectedThreadId: action.threadId,
        runsById: pruneEventRunCache(merged),
        liveResponsesByRunId,
        hasUnreadBelow: false,
      };
    }
    case 'THREAD_SELECTED':
      if (state.selectedThreadId === action.threadId) return state;
      return {
        ...state,
        selectedThreadId: action.threadId,
        liveResponsesByRunId: {},
        hasUnreadBelow: false,
      };
    case 'MERGE_HISTORICAL_RUNS': {
      // Server-authoritative refresh: every run in `action.runs` carries
      // the latest persisted shape (status, browserBlock, errorMessage,
      // etc.). Incoming wins for matched run ids so a resync (e.g. after
      // approving a browser confirmation) clears stale fields like
      // browserBlock. Runs that are only in local state — typically
      // ephemeral entries the live stream just minted — are preserved so
      // a parallel fetch racing a fresh RUN_QUEUED doesn't drop the
      // in-flight panel.
      const merged = mapRunsById(action.runs);
      for (const [runId, view] of Object.entries(state.runsById)) {
        if (!(runId in merged)) {
          merged[runId] = view;
        }
      }
      return { ...state, runsById: merged };
    }
    case 'MESSAGE_LANDED': {
      // The snapshot cache holds the message itself (router setQueryData
      // already appended it). This action only updates the
      // streaming/runs slices: drop the live placeholder for the
      // run, clear any failed live cards if this is a user turn, and
      // bump the unread-below pill if the user wasn't near bottom.
      let liveResponsesByRunId = { ...state.liveResponsesByRunId };
      if (action.message.runId) {
        delete liveResponsesByRunId[action.message.runId];
      }
      if (action.message.role === 'user') {
        liveResponsesByRunId = clearFailedLiveResponsesForThread(
          liveResponsesByRunId,
          state.runsById,
          action.message.threadId,
        );
      }
      return {
        ...state,
        liveResponsesByRunId,
        hasUnreadBelow: action.wasNearBottom
          ? false
          : state.hasUnreadBelow || true,
      };
    }
    case 'RUN_STARTED': {
      const runsById = withRun(state, action.runId, {
        threadId: action.threadId || undefined,
        status: 'running',
        triggerMessageId: action.triggerMessageId,
        executorAlias: action.executorAlias,
        executorModel: action.executorModel,
        createdAt: action.createdAt || undefined,
        startedAt: new Date().toISOString(),
        targetAgentId: action.targetAgentId,
        targetAgentNickname: action.targetAgentNickname,
        responseGroupId: action.responseGroupId,
        sequenceIndex: action.sequenceIndex,
      });
      if (action.threadId && action.threadId !== state.selectedThreadId) {
        return { ...state, runsById };
      }
      const existing = state.liveResponsesByRunId[action.runId];
      const queuedAt = existing?.queuedAt ?? Date.now();
      const liveResponsesByRunId = {
        ...state.liveResponsesByRunId,
        [action.runId]: {
          runId: action.runId,
          rawText: existing?.rawText ?? '',
          text: existing?.text ?? '',
          progressMessage: existing?.progressMessage,
          agentId: existing?.agentId ?? action.targetAgentId ?? null,
          agentNickname:
            existing?.agentNickname ?? action.targetAgentNickname ?? null,
          responseGroupId:
            existing?.responseGroupId ?? action.responseGroupId ?? null,
          sequenceIndex:
            existing?.sequenceIndex ?? action.sequenceIndex ?? null,
          providerId: existing?.providerId,
          modelId: existing?.modelId,
          errorMessage: existing?.errorMessage,
          queuedAt,
          startedAt: existing?.startedAt ?? queuedAt,
          pendingStatus: 'running' as const,
          terminalStatus: existing?.terminalStatus,
        },
      };
      return { ...state, runsById, liveResponsesByRunId };
    }
    case 'RUN_QUEUED': {
      const runsById = withRun(state, action.runId, {
        threadId: action.threadId || undefined,
        status: 'queued',
        triggerMessageId: action.triggerMessageId,
        executorAlias: action.executorAlias,
        executorModel: action.executorModel,
        createdAt: action.createdAt || undefined,
        targetAgentId: action.targetAgentId,
        targetAgentNickname: action.targetAgentNickname,
        responseGroupId: action.responseGroupId,
        sequenceIndex: action.sequenceIndex,
      });
      if (action.threadId && action.threadId !== state.selectedThreadId) {
        return { ...state, runsById };
      }
      const existing = state.liveResponsesByRunId[action.runId];
      const queuedAt = existing?.queuedAt ?? Date.now();
      const liveResponsesByRunId = {
        ...state.liveResponsesByRunId,
        [action.runId]: {
          runId: action.runId,
          rawText: existing?.rawText ?? '',
          text: existing?.text ?? '',
          progressMessage: existing?.progressMessage,
          agentId: existing?.agentId ?? action.targetAgentId ?? null,
          agentNickname:
            existing?.agentNickname ?? action.targetAgentNickname ?? null,
          responseGroupId:
            existing?.responseGroupId ?? action.responseGroupId ?? null,
          sequenceIndex:
            existing?.sequenceIndex ?? action.sequenceIndex ?? null,
          providerId: existing?.providerId,
          modelId: existing?.modelId,
          queuedAt,
          startedAt: existing?.startedAt ?? queuedAt,
          pendingStatus: 'queued' as const,
          terminalStatus: existing?.terminalStatus,
        },
      };
      return { ...state, runsById, liveResponsesByRunId };
    }
    case 'RUN_RETRYING': {
      const existing = state.liveResponsesByRunId[action.runId];
      // Only stamp retry visibility onto a live response we already
      // know about — no point synthesizing one if we never saw the
      // RUN_QUEUED frame.
      if (!existing) return state;
      const liveResponsesByRunId = {
        ...state.liveResponsesByRunId,
        [action.runId]: {
          ...existing,
          retryAttempt: action.retryAttempt,
          retryMaxRetries: action.maxRetries,
        },
      };
      return { ...state, liveResponsesByRunId };
    }
    case 'RUN_COMPLETED': {
      const runsById = withRun(state, action.runId, {
        threadId: action.threadId || undefined,
        status: 'completed',
        triggerMessageId: action.triggerMessageId,
        executorAlias: action.executorAlias,
        executorModel: action.executorModel,
        completedAt: new Date().toISOString(),
        responseGroupId: action.responseGroupId,
        sequenceIndex: action.sequenceIndex,
      });
      // Keep the live panel visible with terminalStatus='completed' until
      // MESSAGE_APPENDED replaces it — prevents the panel from vanishing
      // before the persisted assistant message renders. The dedup at
      // MESSAGE_APPENDED removes it once the message lands; the 3 s
      // MISSING_PERSISTED_MESSAGE_REFETCH_MS backstop covers event drops.
      const existing = state.liveResponsesByRunId[action.runId];
      if (!existing) {
        return { ...state, runsById };
      }
      return {
        ...state,
        runsById,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.runId]: {
            ...existing,
            pendingStatus: undefined,
            terminalStatus: 'completed' as const,
          },
        },
      };
    }
    case 'RUN_FAILED': {
      const existing = state.liveResponsesByRunId[action.runId];
      const priorRun = state.runsById[action.runId];
      const runsById = withRun(state, action.runId, {
        threadId: action.threadId || undefined,
        status: 'failed',
        triggerMessageId: action.triggerMessageId,
        errorCode: action.errorCode,
        errorMessage: action.errorMessage,
        executorAlias: action.executorAlias,
        executorModel: action.executorModel,
        completedAt: new Date().toISOString(),
        responseGroupId: action.responseGroupId,
        sequenceIndex: action.sequenceIndex,
      });
      if (
        !shouldShowInlineFailure({
          selectedThreadId: state.selectedThreadId,
          eventThreadId: action.threadId,
          existing,
          priorRun,
          showInlineFailure: action.showInlineFailure,
        })
      ) {
        return {
          ...state,
          runsById,
        };
      }
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.runId]: {
            runId: action.runId,
            rawText: existing?.rawText || '',
            text: existing?.text || '',
            agentId: existing?.agentId,
            agentNickname: existing?.agentNickname,
            responseGroupId: existing?.responseGroupId,
            sequenceIndex: existing?.sequenceIndex,
            providerId: existing?.providerId,
            modelId: existing?.modelId,
            errorCode: action.errorCode,
            errorMessage: action.errorMessage,
            queuedAt: existing?.queuedAt ?? Date.now(),
            startedAt: existing?.startedAt || Date.now(),
            terminalStatus: 'failed',
          },
        },
        runsById,
      };
    }
    case 'RUN_CANCELLED_BATCH': {
      if (action.runIds.length === 0) return state;
      // Keep cancelled panels visible with terminalStatus='cancelled' so the
      // user sees "Cancelled · Ns" with retained elapsed. Previously these
      // were deleted on cancel — which silently removed feedback.
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      for (const runId of action.runIds) {
        const existing = liveResponsesByRunId[runId];
        if (existing) {
          liveResponsesByRunId[runId] = {
            ...existing,
            pendingStatus: undefined,
            terminalStatus: 'cancelled' as const,
          };
        }
      }
      const runsById = { ...state.runsById };
      for (const runId of action.runIds) {
        runsById[runId] = {
          ...(runsById[runId] || {
            id: runId,
            threadId: '',
            status: 'cancelled',
            createdAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            triggerMessageId: null,
            responseGroupId: null,
            sequenceIndex: null,
            targetAgentId: null,
            targetAgentNickname: null,
            errorCode: null,
            errorMessage: null,
            cancelReason: null,
            executorAlias: null,
            executorModel: null,
            updatedAt: Date.now(),
          }),
          status: 'cancelled',
          completedAt: new Date().toISOString(),
          cancelReason:
            runsById[runId]?.cancelReason ??
            (action.cancelledBy === 'system' &&
            runsById[runId]?.responseGroupId &&
            runsById[runId]?.sequenceIndex != null
              ? 'blocked_by_prior_failure'
              : null),
          updatedAt: Date.now(),
        };
      }
      return {
        ...state,
        liveResponsesByRunId,
        runsById: pruneEventRunCache(runsById),
      };
    }
    case 'RESPONSE_STARTED': {
      // Upsert: refine the queued/running placeholder created at RUN_QUEUED
      // with provider details; do NOT clobber existing text/queuedAt.
      const existing = state.liveResponsesByRunId[action.event.runId];
      const queuedAt = existing?.queuedAt ?? Date.now();
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.event.runId]: {
            runId: action.event.runId,
            rawText: existing?.rawText ?? '',
            text: existing?.text ?? '',
            progressMessage: existing?.progressMessage,
            agentId: action.event.agentId ?? existing?.agentId ?? null,
            agentNickname:
              action.event.agentNickname ?? existing?.agentNickname ?? null,
            responseGroupId:
              action.event.responseGroupId ?? existing?.responseGroupId ?? null,
            sequenceIndex:
              action.event.sequenceIndex ?? existing?.sequenceIndex ?? null,
            providerId: action.event.providerId ?? existing?.providerId,
            modelId: action.event.modelId ?? existing?.modelId,
            queuedAt,
            startedAt: existing?.startedAt ?? Date.now(),
            pendingStatus: 'running' as const,
            terminalStatus: existing?.terminalStatus,
          },
        },
      };
    }
    case 'RESPONSE_PROGRESS': {
      const existing = state.liveResponsesByRunId[action.event.runId];
      const queuedAt = existing?.queuedAt ?? Date.now();
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.event.runId]: {
            runId: action.event.runId,
            rawText: existing?.rawText || '',
            text: existing?.text || '',
            progressMessage: action.event.message,
            agentId: action.event.agentId ?? existing?.agentId,
            agentNickname:
              action.event.agentNickname ?? existing?.agentNickname,
            responseGroupId:
              action.event.responseGroupId ?? existing?.responseGroupId ?? null,
            sequenceIndex:
              action.event.sequenceIndex ?? existing?.sequenceIndex ?? null,
            providerId: action.event.providerId ?? existing?.providerId,
            modelId: action.event.modelId ?? existing?.modelId,
            queuedAt,
            startedAt: existing?.startedAt || Date.now(),
            errorMessage: existing?.errorMessage,
            pendingStatus: existing?.pendingStatus ?? 'running',
            terminalStatus: existing?.terminalStatus,
          },
        },
      };
    }
    case 'RESPONSE_DELTA': {
      const existing = state.liveResponsesByRunId[action.event.runId];
      // If RUN_COMPLETED already deleted the in-flight liveResponse, drop
      // late deltas. Without this guard, the next delta re-creates a
      // "zombie" liveResponse seeded with just the trailing chunk(s) — which
      // surfaces as a truncated message marked "Done" (mid-sentence header
      // + missing prefix) while the real content waits on MESSAGE_APPENDED.
      // We only block creation; if the liveResponse already exists (e.g. a
      // reconnect replays started+delta+failed against a failed-from-DB
      // run), deltas keep appending normally.
      if (!existing) {
        const trackedRun = state.runsById[action.event.runId];
        if (trackedRun && !isNonTerminalRunStatus(trackedRun.status)) {
          return state;
        }
      }
      const rawText = `${existing?.rawText || ''}${action.event.deltaText}`;
      const queuedAtDelta = existing?.queuedAt ?? Date.now();
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.event.runId]: {
            runId: action.event.runId,
            rawText,
            text: stripInternalAssistantText(rawText),
            progressMessage: existing?.progressMessage,
            agentId: action.event.agentId,
            agentNickname: action.event.agentNickname,
            responseGroupId:
              action.event.responseGroupId ?? existing?.responseGroupId ?? null,
            sequenceIndex:
              action.event.sequenceIndex ?? existing?.sequenceIndex ?? null,
            providerId: action.event.providerId,
            modelId: action.event.modelId,
            queuedAt: queuedAtDelta,
            startedAt: existing?.startedAt || Date.now(),
            errorMessage: existing?.errorMessage,
            pendingStatus: existing?.pendingStatus ?? 'running',
            terminalStatus: existing?.terminalStatus,
          },
        },
      };
    }
    case 'RESPONSE_COMPLETED':
      return state;
    case 'RESPONSE_FAILED': {
      const existing = state.liveResponsesByRunId[action.event.runId];
      const priorRun = state.runsById[action.event.runId];
      if (
        !shouldShowInlineFailure({
          selectedThreadId: state.selectedThreadId,
          eventThreadId: action.event.threadId,
          existing,
          priorRun,
        })
      ) {
        return state;
      }
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.event.runId]: {
            runId: action.event.runId,
            rawText: existing?.rawText || '',
            text: existing?.text || '',
            agentId: action.event.agentId,
            agentNickname: action.event.agentNickname,
            responseGroupId:
              action.event.responseGroupId ?? existing?.responseGroupId ?? null,
            sequenceIndex:
              action.event.sequenceIndex ?? existing?.sequenceIndex ?? null,
            providerId: action.event.providerId,
            modelId: action.event.modelId,
            queuedAt: existing?.queuedAt ?? Date.now(),
            startedAt: existing?.startedAt || Date.now(),
            progressMessage: existing?.progressMessage,
            errorMessage: action.event.errorMessage,
            terminalStatus: 'failed',
          },
        },
      };
    }
    case 'RESPONSE_CANCELLED': {
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      delete liveResponsesByRunId[action.event.runId];
      return { ...state, liveResponsesByRunId };
    }
    case 'STREAM_CONNECTING':
      return { ...state, streamState: 'connecting' };
    case 'STREAM_LIVE': {
      // Revert any panels stuck in 'reconnecting' back to 'running'.
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      let changed = false;
      for (const [runId, entry] of Object.entries(liveResponsesByRunId)) {
        if (entry.pendingStatus === 'reconnecting') {
          liveResponsesByRunId[runId] = { ...entry, pendingStatus: 'running' };
          changed = true;
        }
      }
      return {
        ...state,
        streamState: 'live',
        liveResponsesByRunId: changed
          ? liveResponsesByRunId
          : state.liveResponsesByRunId,
      };
    }
    case 'STREAM_RECONNECTING': {
      // Flip all non-terminal panels to 'reconnecting' so the UI shows the SSE drop.
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      let changed = false;
      for (const [runId, entry] of Object.entries(liveResponsesByRunId)) {
        if (entry.terminalStatus) continue;
        if (entry.pendingStatus === 'reconnecting') continue;
        liveResponsesByRunId[runId] = {
          ...entry,
          pendingStatus: 'reconnecting',
        };
        changed = true;
      }
      return {
        ...state,
        streamState: 'reconnecting',
        liveResponsesByRunId: changed
          ? liveResponsesByRunId
          : state.liveResponsesByRunId,
      };
    }
    case 'STREAM_OFFLINE':
      return { ...state, streamState: 'offline' };
    case 'SEND_STARTED':
      return { ...state, sendState: { status: 'posting' } };
    case 'SEND_FAILED':
      return {
        ...state,
        sendState: {
          status: 'error',
          error: action.message,
          lastDraft: action.lastDraft,
        },
      };
    case 'SEND_CLEARED':
      return { ...state, sendState: { status: 'idle' } };
    case 'CANCEL_STARTED':
      return { ...state, cancelState: { status: 'posting' } };
    case 'CANCEL_SUCCEEDED':
      return {
        ...state,
        cancelState: { status: 'success', message: action.message },
      };
    case 'CANCEL_FAILED':
      return {
        ...state,
        cancelState: { status: 'error', message: action.message },
      };
    case 'CLEAR_UNREAD':
      return {
        ...state,
        hasUnreadBelow: false,
      };
    default:
      return state;
  }
}

function formatTalkRole(role: TalkAgent['role']): string {
  switch (role) {
    case 'assistant':
      return 'General';
    case 'analyst':
      return 'Analyst';
    case 'critic':
      return 'Critic';
    case 'strategist':
      return 'Strategist';
    case 'devils-advocate':
      return "Devil's Advocate";
    case 'synthesizer':
      return 'Synthesizer';
    case 'editor':
      return 'Editor';
    default:
      return role;
  }
}

function getTabFromPath(pathname: string, talkId: string): TabKey {
  const base = `/app/talks/${talkId}`;
  if (pathname === `${base}/agents`) return 'agents';
  if (pathname === `${base}/context`) return 'context';
  if (pathname === `${base}/connectors`) return 'connectors';
  if (pathname === `${base}/runs`) return 'runs';
  if (
    pathname === `${base}/tools` ||
    pathname === `${base}/state` ||
    pathname === `${base}/channels` ||
    pathname === `${base}/data-connectors`
  ) {
    return 'context';
  }
  return 'talk';
}

function formatConnectorKind(kind: DataConnector['connectorKind']): string {
  return kind === 'posthog' ? 'PostHog' : 'Google Sheets';
}

function formatConnectorStatus(
  status: DataConnector['verificationStatus'],
): string {
  switch (status) {
    case 'missing':
      return 'Missing credential';
    case 'not_verified':
      return 'Needs verification';
    case 'verifying':
      return 'Verifying…';
    case 'verified':
      return 'Configured';
    case 'invalid':
      return 'Invalid';
    case 'unavailable':
      return 'Unavailable';
    default:
      return status;
  }
}

function connectorStatusClass(
  status: DataConnector['verificationStatus'],
): string {
  switch (status) {
    case 'verified':
      return 'talk-agent-chip talk-agent-chip-success';
    case 'invalid':
      return 'talk-agent-chip talk-agent-chip-error';
    case 'unavailable':
      return 'talk-agent-chip talk-agent-chip-warning';
    default:
      return 'talk-agent-chip';
  }
}

function formatChannelPlatform(
  platform: ChannelConnection['platform'],
): string {
  return platform === 'telegram' ? 'Telegram' : 'Slack';
}

function formatChannelConnectionHealthStatus(
  status: ChannelConnection['healthStatus'],
): string {
  switch (status) {
    case 'healthy':
      return 'healthy';
    case 'degraded':
      return 'degraded';
    case 'disconnected':
      return 'disconnected';
    case 'error':
      return 'error';
    default:
      return status;
  }
}

function channelConnectionStatusClass(
  status: ChannelConnection['healthStatus'],
): string {
  switch (status) {
    case 'healthy':
      return 'talk-agent-chip talk-agent-chip-success';
    case 'degraded':
    case 'disconnected':
      return 'talk-agent-chip talk-agent-chip-warning';
    case 'error':
      return 'talk-agent-chip talk-agent-chip-error';
    default:
      return 'talk-agent-chip';
  }
}

function readChannelConnectionStringConfig(
  connection: ChannelConnection,
  key: string,
): string | null {
  const value = connection.config?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readChannelConnectionNumberConfig(
  connection: ChannelConnection,
  key: string,
): number | null {
  const value = connection.config?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildSlackWorkspaceSyncSummary(connection: ChannelConnection): string {
  const totalCount = readChannelConnectionNumberConfig(
    connection,
    'lastSyncTotalCount',
  );
  const publicCount = readChannelConnectionNumberConfig(
    connection,
    'lastSyncPublicCount',
  );
  const privateCount = readChannelConnectionNumberConfig(
    connection,
    'lastSyncPrivateCount',
  );
  const lastSyncedAt = readChannelConnectionStringConfig(
    connection,
    'lastSyncedAt',
  );
  const countLabel =
    totalCount == null
      ? 'Sync Slack channels to refresh recent invites.'
      : `${totalCount} synced channel${totalCount === 1 ? '' : 's'}`;
  const splitLabel =
    publicCount != null && privateCount != null
      ? ` (${publicCount} public, ${privateCount} private)`
      : '';
  const freshnessLabel = lastSyncedAt
    ? ` · Last synced ${formatDateTime(lastSyncedAt)}`
    : ' · Never synced';
  return `${countLabel}${splitLabel}${freshnessLabel}`;
}

function buildSlackWorkspaceSyncMessage(
  workspaceLabel: string,
  result: { syncedCount: number; publicCount: number; privateCount: number },
): string {
  const countLabel = `${result.syncedCount} Slack channel${result.syncedCount === 1 ? '' : 's'}`;
  return `Synced ${countLabel} for ${workspaceLabel} (${result.publicCount} public, ${result.privateCount} private).`;
}

function buildBindingWorkspaceSummary(
  binding: TalkChannelBinding,
  connection: ChannelConnection | null,
): string | null {
  if (!connection || binding.platform !== 'slack') return null;
  return `${connection.displayName} is ${formatChannelConnectionHealthStatus(connection.healthStatus)}. ${buildSlackWorkspaceSyncSummary(connection)}`;
}

function buildBindingActivitySummary(binding: TalkChannelBinding): string[] {
  const summaries: string[] = [];
  const platformLabel = binding.platform === 'slack' ? 'Slack' : 'Telegram';
  if (binding.deferredIngressCount > 0) {
    summaries.push(
      `${binding.deferredIngressCount} ${platformLabel} message${binding.deferredIngressCount === 1 ? '' : 's'} waiting because another conversation is still running.`,
    );
  }
  if (binding.pendingIngressCount > 0) {
    summaries.push(
      `${binding.pendingIngressCount} inbound message${binding.pendingIngressCount === 1 ? '' : 's'} queued and ready to process.`,
    );
  }
  const unresolvedInboundOnly = Math.max(
    0,
    binding.unresolvedIngressCount - binding.deferredIngressCount,
  );
  if (unresolvedInboundOnly > 0) {
    summaries.push(
      `${unresolvedInboundOnly} inbound message${unresolvedInboundOnly === 1 ? '' : 's'} could not be resolved automatically and may need manual retry.`,
    );
  }
  if (binding.deadLetterCount > 0) {
    summaries.push(
      `${binding.deadLetterCount} outbound deliver${binding.deadLetterCount === 1 ? 'y has' : 'ies have'} failed and can be retried below.`,
    );
  }
  if (binding.suppressedReplyCount > 0) {
    const lastSuppressedLabel = binding.lastSuppressedAt
      ? ` Last suppressed ${formatDateTime(binding.lastSuppressedAt)}.`
      : '';
    const reasonLabel = binding.lastSuppressionReason
      ? ` ${binding.lastSuppressionReason}`
      : '';
    summaries.push(
      `${binding.suppressedReplyCount} reply${binding.suppressedReplyCount === 1 ? ' was' : 'ies were'} intentionally suppressed by channel instructions.${lastSuppressedLabel}${reasonLabel}`.trim(),
    );
  }
  return summaries;
}

function buildChannelTargetOptionLabel(
  target: ChannelTarget,
  connections: ChannelConnection[],
): string {
  const connection =
    connections.find((candidate) => candidate.id === target.connectionId) ||
    null;
  const platformLabel = connection
    ? formatChannelPlatform(connection.platform)
    : 'Channel';
  const connectionLabel = connection?.displayName || target.connectionId;
  return `${platformLabel} · ${connectionLabel} · ${target.displayName}`;
}

function buildChannelTargetOptionMetaLabel(
  target: ChannelTarget,
  connections: ChannelConnection[],
): string {
  const connection =
    connections.find((candidate) => candidate.id === target.connectionId) ||
    null;
  const platformLabel = connection
    ? formatChannelPlatform(connection.platform)
    : 'Channel';
  const connectionLabel = connection?.displayName || target.connectionId;
  return `${platformLabel} · ${connectionLabel}`;
}

function buildChannelTargetOccupancyLabel(
  target: ChannelTarget,
  talkId: string,
): string {
  if (!target.activeBindingTalkId) return 'Available';
  return target.activeBindingTalkId === talkId
    ? 'Already bound'
    : `Bound to ${target.activeBindingTalkTitle || 'another Talk'}`;
}

function readChannelTargetBooleanMetadata(
  target: ChannelTarget,
  key: string,
): boolean | null {
  const value = target.metadata?.[key];
  return typeof value === 'boolean' ? value : null;
}

function formatChannelReasonCode(value: string | null): string {
  if (!value) return 'None';
  switch (value) {
    case 'overflow_drop_oldest':
      return 'Dropped oldest queued message';
    case 'overflow_drop_newest':
      return 'Dropped newest queued message';
    case 'overflow_no_evictable_row':
      return 'Queue full while another item was processing';
    case 'expired_while_busy':
      return 'Dropped after waiting too long for the talk to become idle';
    case 'binding_deactivated':
      return 'Binding was deactivated';
    case 'enqueue_invalid_state':
      return 'Talk state prevented channel enqueue';
    case 'delivery_retries_exhausted':
      return 'Delivery retries exhausted';
    case 'delivery_transient_failure':
      return 'Delivery failed and will retry';
    default:
      return value.replace(/_/g, ' ');
  }
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleString();
}

const STATE_JSON_TRUNCATE_LENGTH = 2000;

function TalkStateCard({
  entry,
  canDelete,
  onDelete,
}: {
  entry: TalkStateEntry;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const jsonText = JSON.stringify(entry.value, null, 2);
  const isTruncated = jsonText.length > STATE_JSON_TRUNCATE_LENGTH;
  const displayText =
    isTruncated && !expanded
      ? jsonText.slice(0, STATE_JSON_TRUNCATE_LENGTH)
      : jsonText;

  return (
    <article className="talk-llm-card talk-state-card">
      <div className="connector-card-header">
        <div>
          <h3>{entry.key}</h3>
          <p className="talk-llm-meta">
            Version {entry.version} · Updated {formatDateTime(entry.updatedAt)}
          </p>
        </div>
        {canDelete ? (
          <button
            className="btn btn-sm btn-danger"
            onClick={onDelete}
            title="Delete state entry"
          >
            &times;
          </button>
        ) : null}
      </div>
      {entry.updatedByRunId ? (
        <p className="talk-llm-meta">
          Updated by run <code>{entry.updatedByRunId}</code>
        </p>
      ) : null}
      {entry.updatedByUserId ? (
        <p className="talk-llm-meta">
          Updated by user <code>{entry.updatedByUserId}</code>
        </p>
      ) : null}
      <pre className="talk-state-json">{displayText}</pre>
      {isTruncated ? (
        <button className="btn btn-sm" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Show full value'}
        </button>
      ) : null}
    </article>
  );
}

function sortThreads(threads: TalkThread[]): TalkThread[] {
  return [...threads].sort((left, right) => {
    if (left.isPinned !== right.isPinned) {
      return Number(right.isPinned) - Number(left.isPinned);
    }
    const leftAt = left.lastMessageAt || left.createdAt;
    const rightAt = right.lastMessageAt || right.createdAt;
    const delta = Date.parse(rightAt) - Date.parse(leftAt);
    if (Number.isFinite(delta) && delta !== 0) return delta;
    return rightAt.localeCompare(leftAt);
  });
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

function OrchestrationModeIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
      <path
        d="M2.25 4.5A1.75 1.75 0 0 1 4 2.75h5.25A1.75 1.75 0 0 1 11 4.5v1.75A1.75 1.75 0 0 1 9.25 8H6.64L3.8 10.12a.5.5 0 0 1-.8-.4V8.97A1.75 1.75 0 0 1 2.25 7.3V4.5Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.25"
      />
      <path
        d="M6.25 6.75h5.25A1.25 1.25 0 0 1 12.75 8v1.1A1.25 1.25 0 0 1 11.5 10.35H9.52l-1.97 1.47a.5.5 0 0 1-.8-.4v-1.1"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.25"
      />
    </svg>
  );
}

function OrchestrationChevronIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
      <path
        d="m4.25 6.5 3.75 3.5 3.75-3.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function OrchestrationCheckIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
      <path
        d="M3.5 8.25 6.4 11.1 12.5 5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function ComposerAttachIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
      <path
        d="M9.95 3.05a2.75 2.75 0 0 1 3.89 3.89L7.42 13.37a4 4 0 1 1-5.66-5.66l6.19-6.19a2.5 2.5 0 1 1 3.53 3.53L5.64 10.9a1.25 1.25 0 1 1-1.77-1.77l5.13-5.13"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function ComposerCancelRunsIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="5.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M5.4 5.4 10.6 10.6M10.6 5.4 5.4 10.6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function ComposerSendIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
      <path
        d="M2 13.2 14 8 2 2.8l1.53 4.08L9.2 8l-5.67 1.12L2 13.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

function formatThreadLabel(thread: TalkThread): string {
  return displayThreadTitle(thread.title);
}

function buildThreadHref(
  talkId: string,
  threadId: string,
  tab?: TabKey,
): string {
  const base =
    tab && tab !== 'talk'
      ? `/app/talks/${talkId}/${tab}`
      : `/app/talks/${talkId}`;
  return `${base}?thread=${encodeURIComponent(threadId)}`;
}

function sortRulesByOrder(rules: ContextRule[]): ContextRule[] {
  return [...rules].sort((left, right) => {
    const delta = left.sortOrder - right.sortOrder;
    if (delta !== 0) return delta;
    return left.createdAt.localeCompare(right.createdAt);
  });
}

function buildRuleDraftMap(rules: ContextRule[]): Record<string, string> {
  return rules.reduce<Record<string, string>>((acc, rule) => {
    acc[rule.id] = rule.ruleText;
    return acc;
  }, {});
}

function reorderRules(
  rules: ContextRule[],
  activeId: string,
  overId: string,
): ContextRule[] {
  const ordered = sortRulesByOrder(rules);
  const fromIndex = ordered.findIndex((rule) => rule.id === activeId);
  const toIndex = ordered.findIndex((rule) => rule.id === overId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return ordered;
  }

  const next = [...ordered];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return ordered;
  next.splice(toIndex, 0, moved);
  return next.map((rule, index) => ({ ...rule, sortOrder: index }));
}

function RuleRow({
  ruleId,
  disabled,
  label,
  children,
}: {
  ruleId: string;
  disabled: boolean;
  label: string;
  children: ReactNode;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: ruleId,
      disabled,
    });
  const { isOver, setNodeRef: setDropNodeRef } = useDroppable({
    id: ruleId,
    disabled,
  });

  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        setDropNodeRef(node);
      }}
      className={`talk-rule-row${isDragging ? ' talk-rule-row-dragging' : ''}${
        isOver && !disabled ? ' talk-rule-row-over' : ''
      }`}
      style={{
        transform: transform ? CSS.Translate.toString(transform) : undefined,
      }}
    >
      <button
        type="button"
        className="talk-rule-handle"
        aria-label={`Reorder ${label}`}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <span aria-hidden="true">⋮⋮</span>
      </button>
      <div className="talk-rule-row-body">{children}</div>
    </div>
  );
}

function buildChannelBindingDraft(
  binding: TalkChannelBinding,
): ChannelBindingDraft {
  return {
    displayName: binding.displayName,
    active: binding.active,
    responseMode: binding.responseMode,
    responderMode: binding.responderMode,
    responderAgentId: binding.responderAgentId || '',
    deliveryMode: binding.deliveryMode,
    timezone: binding.timezone,
    instructions: binding.instructions || '',
    template: 'blank',
    inboundRateLimitPerMinute: String(binding.inboundRateLimitPerMinute),
    maxPendingEvents: String(binding.maxPendingEvents),
    overflowPolicy: binding.overflowPolicy,
    maxDeferredAgeMinutes: String(binding.maxDeferredAgeMinutes),
  };
}

function buildDefaultChannelCreateDraft(): ChannelCreateDraft {
  return {
    platform: '',
    connectionId: '',
    targetKey: '',
    displayName: '',
    responseMode: 'mentions',
    responderMode: 'primary',
    responderAgentId: '',
    deliveryMode: 'reply',
    timezone: getDefaultJobTimezone(),
    instructions: '',
    template: 'blank',
    inboundRateLimitPerMinute: '10',
    maxPendingEvents: '20',
    overflowPolicy: 'drop_oldest',
    maxDeferredAgeMinutes: '10',
  };
}

function buildEmptyChannelTargetInventory(): ChannelTargetInventoryState {
  return {
    targets: [],
    totalCount: 0,
    hasMore: false,
    nextOffset: null,
  };
}

function buildChannelTargetKey(
  target: Pick<ChannelTarget, 'connectionId' | 'targetKind' | 'targetId'>,
): string {
  return `${target.connectionId}::${target.targetKind}::${target.targetId}`;
}

function parseChannelTargetKey(
  value: string,
): { connectionId: string; targetKind: string; targetId: string } | null {
  const firstSeparatorIndex = value.indexOf('::');
  if (firstSeparatorIndex <= 0) return null;
  const secondSeparatorIndex = value.indexOf('::', firstSeparatorIndex + 2);
  if (secondSeparatorIndex <= firstSeparatorIndex + 2) return null;
  return {
    connectionId: value.slice(0, firstSeparatorIndex),
    targetKind: value.slice(firstSeparatorIndex + 2, secondSeparatorIndex),
    targetId: value.slice(secondSeparatorIndex + 2),
  };
}

function buildAgentLabel(agent: Pick<TalkAgent, 'nickname' | 'role'>): string {
  return `${agent.nickname} (${formatTalkRole(agent.role)})`;
}

function buildAgentChipLabel(agent: Pick<TalkAgent, 'nickname'>): string {
  return agent.nickname;
}

function isRenderableImageAttachment(mimeType: string): boolean {
  return (
    mimeType === 'image/png' ||
    mimeType === 'image/jpeg' ||
    mimeType === 'image/webp'
  );
}

function buildTalkAttachmentContentUrl(
  talkId: string,
  attachmentId: string,
): string {
  return `/api/v1/talks/${encodeURIComponent(talkId)}/attachments/${encodeURIComponent(attachmentId)}/content`;
}

function getConfiguredProviders(
  data: AiAgentsPageData | null,
): AgentProviderCard[] {
  if (!data) return [];
  // Any credential surface the execution-resolver will accept: personal
  // or workspace api_key, personal or workspace OAuth subscription. The
  // ChatGPT Codex provider is subscription_only — gating on
  // hasCredential alone would hide it after a user connected ChatGPT.
  return data.additionalProviders.filter(
    (provider) =>
      provider.hasCredential ||
      provider.workspaceHasCredential ||
      provider.hasPersonalSubscription ||
      provider.hasWorkspaceSubscription,
  );
}

function buildTalkAgentSourceOptions(input: {
  providers: AgentProviderCard[];
}): TalkAgentSourceOption[] {
  return [
    {
      id: 'claude_default',
      label: 'Claude',
      sourceKind: 'claude_default',
      providerId: null,
    },
    ...input.providers.map((provider) => ({
      id: provider.id,
      label: provider.name,
      sourceKind: 'provider' as const,
      providerId: provider.id,
    })),
  ];
}

function getModelSuggestionsForSource(input: {
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  aiAgents: AiAgentsPageData | null;
}): Array<{
  modelId: string;
  displayName: string;
  supportsVision: boolean;
}> {
  if (!input.aiAgents) return [];
  if (input.sourceKind === 'claude_default') {
    return input.aiAgents.claudeModelSuggestions.map((model) => ({
      modelId: model.modelId,
      displayName: model.displayName,
      supportsVision: model.supportsVision === true,
    }));
  }

  const provider = input.aiAgents.additionalProviders.find(
    (entry) => entry.id === input.providerId,
  );
  return (provider?.modelSuggestions || []).map((model) => ({
    modelId: model.modelId,
    displayName: model.displayName,
    supportsVision: model.supportsVision === true,
  }));
}

function talkAgentSupportsVision(
  agent: Pick<TalkAgent, 'sourceKind' | 'providerId' | 'modelId'>,
  registeredAgent:
    | Pick<RegisteredAgent, 'providerId' | 'modelId' | 'supportsVision'>
    | undefined,
  aiAgents: AiAgentsPageData | null,
): boolean {
  // Main slot (modelId=null on the TalkAgent row): trust the registered
  // agent's supportsVision, which is the backend's ground truth from
  // resolveModelCapabilities. Avoids the modelSuggestions lookup, which
  // can miss for subscription providers whose curated rows aren't
  // materialized as suggestions (e.g. Codex's gpt-5.4).
  if (!agent.modelId?.trim()) {
    return registeredAgent?.supportsVision === true;
  }

  if (!aiAgents) return false;

  // Provider-pinned agents (TalkAgent row has its own modelId): look up
  // vision capability via the provider's modelSuggestions. Fall back to
  // the registered agent's supportsVision when the suggestion list misses.
  const provider = aiAgents.additionalProviders.find(
    (entry) => entry.id === agent.providerId,
  );
  if (provider) {
    const model = provider.modelSuggestions.find(
      (entry) => entry.modelId === agent.modelId,
    );
    if (model) return model.supportsVision === true;
  }
  if (agent.providerId === 'provider.anthropic') {
    const claudeModel = aiAgents.claudeModelSuggestions.find(
      (entry) => entry.modelId === agent.modelId,
    );
    if (claudeModel) return claudeModel.supportsVision === true;
  }
  return registeredAgent?.supportsVision === true;
}

function buildAutoNicknameBase(input: {
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  modelId: string | null;
  modelDisplayName?: string | null;
  aiAgents: AiAgentsPageData | null;
}): string {
  if (input.modelDisplayName?.trim()) return input.modelDisplayName.trim();
  const suggestions = getModelSuggestionsForSource({
    sourceKind: input.sourceKind,
    providerId: input.providerId,
    aiAgents: input.aiAgents,
  });
  const found = suggestions.find((entry) => entry.modelId === input.modelId);
  if (found?.displayName) return found.displayName;
  if (input.modelId?.trim()) return input.modelId.trim();
  return input.sourceKind === 'claude_default' ? 'Claude' : 'Provider';
}

function buildUniqueNickname(
  base: string,
  agents: TalkAgent[],
  excludeId?: string,
): string {
  const used = new Set(
    agents
      .filter((agent) => agent.id !== excludeId)
      .map((agent) => agent.nickname.trim())
      .filter(Boolean),
  );
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base} ${index}`)) {
    index += 1;
  }
  return `${base} ${index}`;
}

function applySourceModelSelection(
  agent: TalkAgent,
  input: {
    sourceKind: 'claude_default' | 'provider';
    providerId: string | null;
    modelId: string;
  },
  allAgents: TalkAgent[],
  aiAgents: AiAgentsPageData | null,
): TalkAgent {
  const suggestions = getModelSuggestionsForSource({
    sourceKind: input.sourceKind,
    providerId: input.providerId,
    aiAgents,
  });
  const selectedModel =
    suggestions.find((entry) => entry.modelId === input.modelId) ||
    suggestions[0] ||
    null;
  const modelId = selectedModel?.modelId || input.modelId || null;
  const modelDisplayName = selectedModel?.displayName || input.modelId || null;
  const nickname =
    agent.nicknameMode === 'custom'
      ? agent.nickname
      : buildUniqueNickname(
          buildAutoNicknameBase({
            sourceKind: input.sourceKind,
            providerId: input.providerId,
            modelId,
            modelDisplayName,
            aiAgents,
          }),
          allAgents,
          agent.id,
        );
  return {
    ...agent,
    sourceKind: input.sourceKind,
    providerId: input.sourceKind === 'provider' ? input.providerId : null,
    modelId,
    modelDisplayName,
    nickname,
  };
}

function buildNewAgentDraft(
  _aiAgents: AiAgentsPageData | null,
): AgentCreationDraft {
  // modelId is overloaded to store the selected registered agent ID.
  // Start empty so the dropdown shows the "Choose a registered agent…" placeholder
  // and the Add button is disabled until the user selects one.
  return {
    sourceKind: 'provider',
    providerId: null,
    modelId: '',
    role: 'assistant',
  };
}

function buildTargetSelection(
  agents: TalkAgent[],
  current: string[],
): string[] {
  const valid = current.filter((id) => agents.some((agent) => agent.id === id));
  if (valid.length > 0) return valid;
  const primary = agents.find((agent) => agent.isPrimary);
  return primary ? [primary.id] : agents[0] ? [agents[0].id] : [];
}

type TalkAgentExecutionGuardrail = {
  kind: 'direct_safe' | 'unavailable';
  badgeLabel: string | null;
  message: string | null;
};

function summarizeAgentLabels(labels: string[]): string {
  if (labels.length === 0) return 'One or more selected agents';
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

function buildTalkAgentExecutionGuardrail(
  agent: TalkAgent,
  registeredAgent: RegisteredAgent | undefined,
): TalkAgentExecutionGuardrail {
  if (!registeredAgent) {
    return {
      kind: 'direct_safe',
      badgeLabel: null,
      message: null,
    };
  }

  const preview = registeredAgent.executionPreview;
  if (!preview.ready) {
    return {
      kind: 'unavailable',
      badgeLabel: 'Unavailable',
      message: preview.message,
    };
  }

  return {
    kind: 'direct_safe',
    badgeLabel: null,
    message: null,
  };
}

const BINDING_INSTRUCTIONS_PLACEHOLDER = `Describe what this channel assistant should do, when it should reply, and what state it should keep.

Example:
- Reply only when directly asked or when a weekly milestone is reached.
- For routine logs, begin with [[NO_CHANNEL_REPLY]] and update binding-owned state.
- Keep all binding state under the provided binding state namespace.
- Use one narrow state key per tracked person instead of one shared totals blob.
- Weekly reset happens on Monday in the binding timezone.`;

function buildInstructionTemplate(
  template: InstructionTemplateKey,
  stateNamespace?: string | null,
): string {
  if (template === 'blank') {
    return '';
  }
  const namespaceHint = stateNamespace || '<binding state namespace>';
  return [
    'You are a study tracker for this Slack channel.',
    'Reply only when someone directly asks for progress, asks for advice, or a tracked participant reaches the weekly goal.',
    'For routine study logs, begin your response with [[NO_CHANNEL_REPLY]] so nothing is posted back to Slack.',
    `Keep binding-owned state under ${namespaceHint}. Use one narrow key per participant, for example ${namespaceHint}tracker.asher.`,
    'Use list_state with the binding namespace to inspect existing tracker entries before creating or summarizing state.',
    'Store each participant entry as JSON with weekStartLocal, timezone, weeklyTargetMinutes, totalMinutes, carryoverMinutes, and lastLogAt.',
    'Prefer stable Slack sender IDs over names whenever possible.',
    'Use the binding timezone shown in channel settings when applying weekly reset logic.',
    'Treat Monday as the weekly reset boundary in the binding timezone and carry over only minutes above 300.',
    'If update_state reports a version conflict, read the latest state and retry.',
    'When formatting a progress reply, include each participant total and how far they are from 300 minutes.',
  ].join('\n');
}

type AutoGrowingTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  maxHeightPx?: number;
};

function AutoGrowingTextarea({
  maxHeightPx = BINDING_INSTRUCTIONS_TEXTAREA_MAX_HEIGHT_PX,
  style,
  value,
  ...props
}: AutoGrowingTextareaProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const minHeightRef = useRef<number | null>(null);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const measuredMinHeight = textarea.offsetHeight;
    if (!minHeightRef.current && measuredMinHeight > 0) {
      minHeightRef.current = measuredMinHeight;
    }
    const minHeight = minHeightRef.current ?? measuredMinHeight;
    const scrollHeight = Math.max(textarea.scrollHeight, minHeight);
    const nextHeight = Math.min(scrollHeight, maxHeightPx);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = scrollHeight > maxHeightPx ? 'auto' : 'hidden';
  }, [maxHeightPx]);

  useEffect(() => {
    resizeTextarea();
  }, [resizeTextarea, value]);

  return (
    <textarea
      {...props}
      ref={textareaRef}
      value={value}
      style={{
        ...style,
        overflowY: 'hidden',
      }}
    />
  );
}

function lintChannelInstructions(input: {
  instructions: string;
  stateNamespace?: string | null;
  timezone?: string | null;
}): InstructionLintResult {
  const trimmed = input.instructions.trim();
  if (trimmed.length === 0) {
    return {
      status: 'needs_more_specifics',
      messages: ['Add instructions that explain what this binding should do.'],
    };
  }

  const lower = trimmed.toLowerCase();
  const messages: string[] = [];
  let hasConflict = false;

  const mentionsSilenceRule =
    lower.includes('[[no_channel_reply]]') ||
    lower.includes('stay silent') ||
    lower.includes('do not reply') ||
    lower.includes('reply only');
  if (!mentionsSilenceRule) {
    messages.push(
      'Explain when the assistant should reply versus stay silent.',
    );
  }

  const seemsStateful =
    /(track|state|log|weekly|minutes|total|ledger|memory)/i.test(trimmed);
  const mentionsStateStrategy =
    /(state namespace|list_state|read_state|update_state|key|json schema|json)/i.test(
      trimmed,
    );
  if (seemsStateful && !mentionsStateStrategy) {
    messages.push(
      'Stateful instructions should describe the state keys or JSON schema to use.',
    );
  }

  if (
    /(week|weekly|daily|monday|timezone|reset|schedule)/i.test(trimmed) &&
    !(
      /(timezone|america\/|utc|local day-of-week|binding timezone)/i.test(
        trimmed,
      ) || Boolean(input.timezone?.trim())
    )
  ) {
    messages.push(
      'Time-based behavior should name a timezone or reset rule explicitly.',
    );
  }

  if (
    /(participant|sender|kid|child|member|person|student)/i.test(trimmed) &&
    !/(sender id|slack id|stable id|user id)/i.test(trimmed)
  ) {
    messages.push(
      'Entity-tracking instructions work better when they mention stable sender IDs.',
    );
  }

  if (
    /(every message|always reply)/i.test(trimmed) &&
    /(\[\[no_channel_reply\]\]|stay silent|reply only)/i.test(trimmed)
  ) {
    hasConflict = true;
    messages.push('The instructions describe conflicting reply behavior.');
  }

  if (trimmed.length < 120) {
    messages.push(
      'Add more specifics so the assistant knows the trigger rules, reply policy, and state strategy.',
    );
  }

  if (trimmed.length > 4000) {
    messages.push(
      'Remove repetitive detail. Shorter, sharper instructions usually work better.',
    );
  }

  if (/(study_tracker\.|tracker\.[a-z0-9_-]+)/i.test(trimmed)) {
    hasConflict = true;
    messages.push(
      'Use the binding state namespace instead of hard-coded global state keys.',
    );
  }

  if (
    input.stateNamespace &&
    trimmed.includes('channel.') &&
    !trimmed.includes(input.stateNamespace)
  ) {
    messages.push(
      'If you reference explicit state keys, keep them inside this binding namespace.',
    );
  }

  if (hasConflict) {
    return { status: 'potential_conflicts', messages };
  }
  if (messages.length > 0) {
    return { status: 'needs_more_specifics', messages };
  }
  return {
    status: 'ready',
    messages: [
      'The instructions define a clear reply policy and state strategy.',
    ],
  };
}

function getInstructionTemplateOptions(
  platform: ChannelConnection['platform'] | '' | null | undefined,
): Array<{ value: InstructionTemplateKey; label: string }> {
  return platform === 'slack'
    ? [
        { value: 'blank', label: 'Blank' },
        { value: 'study_tracker', label: 'Study Tracker' },
      ]
    : [{ value: 'blank', label: 'Blank' }];
}

function buildEmptyBindingMemoryPanelState(
  stateNamespace: string,
): BindingMemoryPanelState {
  return {
    status: 'idle',
    stateNamespace,
    entries: [],
    newKeySuffix: '',
    newValueJson: '{\n  \n}',
  };
}

function formatInstructionLintTitle(status: InstructionLintStatus): string {
  switch (status) {
    case 'ready':
      return 'Ready';
    case 'potential_conflicts':
      return 'Potential conflicts';
    default:
      return 'Needs more specifics';
  }
}

function formatInstructionLintClassName(status: InstructionLintStatus): string {
  switch (status) {
    case 'ready':
      return 'inline-banner inline-banner-success';
    case 'potential_conflicts':
      return 'inline-banner inline-banner-warning';
    default:
      return 'inline-banner';
  }
}

function formatJsonForStateEditor(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return 'null';
  }
}

function serializeTalkAgentForDraftCompare(agent: TalkAgent): string {
  return JSON.stringify({
    id: agent.id,
    nickname: agent.nickname,
    nicknameMode: agent.nicknameMode,
    sourceKind: agent.sourceKind,
    providerId: agent.providerId,
    modelId: agent.modelId,
    modelDisplayName: agent.modelDisplayName,
    role: agent.role,
    isPrimary: agent.isPrimary,
    displayOrder: agent.displayOrder,
  });
}

function haveSameTalkAgentDraftState(
  left: TalkAgent[],
  right: TalkAgent[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (
      serializeTalkAgentForDraftCompare(left[index]) !==
      serializeTalkAgentForDraftCompare(right[index])
    ) {
      return false;
    }
  }
  return true;
}

// Lazy-loaded raw-HTML editor for the Source-mode pane. CodeMirror is
// heavyweight enough that we don't want to bundle it on the main route.
// The HtmlSourceEditor module exports both a named export and a default;
// React.lazy needs the default.
const LazyHtmlSourceEditor = lazy(() =>
  import('../components/HtmlSourceEditor').then((mod) => ({
    default: mod.HtmlSourceEditor,
  })),
);

// Error boundary specifically for the lazy CodeMirror import. If the
// dynamic import fails (network blip, code-split chunk missing), show
// a graceful inline message with a reload escape hatch instead of
// crashing the whole TalkDetailPage tree.
class HtmlEditorErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="talk-tab-doc-body" role="alert">
          Editor failed to load.{' '}
          <button
            type="button"
            className="talk-tab-doc-conflict-button"
            onClick={() => {
              if (typeof window !== 'undefined') window.location.reload();
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function TalkDetailPage({
  userId,
  onUnauthorized,
  titleOverride,
  renameDraft,
  onRenameDraftChange,
  onRenameDraftCancel,
  onRenameDraftCommit,
  onSidebarChanged,
  sidebarContents,
}: {
  userId: string;
  onUnauthorized: () => void;
  titleOverride?: string | null;
  renameDraft: { talkId: string; draft: string } | null;
  onRenameDraftChange: (talkId: string, draft: string) => void;
  onRenameDraftCancel: (talkId: string) => void;
  onRenameDraftCommit: (talkId: string, draft: string) => Promise<void>;
  onSidebarChanged: () => Promise<void> | void;
  sidebarContents: ContentSidebarItem[];
}): JSX.Element {
  const { talkId = '' } = useParams<{ talkId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const currentTab = getTabFromPath(location.pathname, talkId);
  const locationParams = new URLSearchParams(location.search);
  const requestedThreadId = locationParams.get('thread')?.trim() || null;
  // If the URL hasn't pinned a thread yet, ride the saved last-viewed
  // thread for this Talk so the snapshot warms straight to the UX the
  // user expects (avoids the bootstrap → refetch-on-resolve double-hop).
  const initialResolvedThreadId =
    requestedThreadId ?? getLastThreadForTalk(talkId);
  const queryClient = useQueryClient();
  const snapshotQuery = useTalkSnapshot({
    userId,
    talkId,
    threadId: initialResolvedThreadId,
    onUnauthorized,
  });
  const wsCacheRouterRef = useRef(createWsCacheRouter(queryClient));
  const [state, dispatch] = useReducer(
    detailReducer,
    undefined,
    createInitialDetailState,
  );

  // Derived snapshot accessors — PR C: server data lives in React
  // Query. Render-site reads pull from these instead of the reducer.
  //
  // Once the page has rendered with snapshot data, we stay 'ready' even
  // during background refetches and thread-switch rekeys (which drop
  // snapshotQuery.data back to undefined). Flipping pageKind back to
  // 'loading' would unmount the ready-branch tree — replacing the
  // thread rail / composer DOM nodes — which breaks any handler that
  // captured a DOM reference (e.g. handleDeleteThread holding a
  // threadRail node) and causes a visible page-level loading flash.
  const lastSnapshotRef = useRef<TalkSnapshot | null>(null);
  // Only fall back to the last-good snapshot when it belongs to the
  // currently-routed talk. Cross-talk navigation drops the fallback
  // immediately so the previous talk's messages/title can't render
  // against the new talkId — and so handlers reading pageTalk.id can't
  // mutate the previous Talk before the new snapshot resolves.
  if (snapshotQuery.data) {
    lastSnapshotRef.current = snapshotQuery.data;
  } else if (
    lastSnapshotRef.current &&
    lastSnapshotRef.current.talk.id !== talkId
  ) {
    lastSnapshotRef.current = null;
  }
  const talkSnapshot = snapshotQuery.data ?? lastSnapshotRef.current;
  const snapshotError = snapshotQuery.error;
  const snapshotIs404 =
    snapshotError instanceof ApiError && snapshotError.status === 404;
  const pageKind: 'loading' | 'ready' | 'unavailable' | 'error' = snapshotIs404
    ? 'unavailable'
    : snapshotError
      ? 'error'
      : !talkSnapshot
        ? 'loading'
        : 'ready';
  const pageErrorMessage: string | null = snapshotIs404
    ? 'Talk not found'
    : snapshotError instanceof Error
      ? snapshotError.message
      : null;
  const pageTalk: Talk | null = useMemo(
    () => (talkSnapshot ? snapshotTalkToTalk(talkSnapshot.talk) : null),
    [talkSnapshot?.talk],
  );

  const [threadState, setThreadState] = useState<ThreadListState>({
    threads: [],
    loading: true,
    error: null,
  });
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [threadMenu, setThreadMenu] = useState<{
    threadId: string;
    x: number;
    y: number;
  } | null>(null);
  const [runContextPanels, setRunContextPanels] = useState<
    Record<string, RunContextPanelState>
  >({});
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<TalkMessageSearchResult[]>(
    [],
  );
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [retryRunState, setRetryRunState] = useState<{
    runId: string;
    status: 'posting' | 'error';
    message: string;
  } | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<
    Array<{
      localId: string;
      file: File;
      fileName: string;
      fileSize: number;
      mimeType: string;
      isImage: boolean;
      previewUrl?: string;
      status: 'uploading' | 'ready' | 'error';
      attachmentId?: string;
      errorMessage?: string;
    }>
  >([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingAttachmentsRef = useRef(pendingAttachments);
  const runContextPanelsRef = useRef<Record<string, RunContextPanelState>>({});
  const threadRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const threadRefreshInFlightRef = useRef(false);
  const threadRefreshDirtyRef = useRef(false);
  const pendingComposerFocusRef = useRef(false);
  const pendingRunHistoryScrollRef = useRef<string | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);
  // Talk id for which `threadState.threads` was last loaded. Gates the
  // routing-resolution effect so it can't run with a freshly-changed
  // talkId but stale threadState (same-commit cross-talk navigation).
  const threadStateTalkIdRef = useRef<string | null>(null);
  const threadSnapshotVersionRef = useRef(0);
  const deletedMessageIdsRef = useRef<Set<string>>(new Set());
  // Bumped whenever deleted ids are recorded so memoized message lists
  // re-run the deleted-id filter even if the messages array itself is
  // unchanged (a stale resync can return the pre-delete list verbatim).
  const [deletedIdsVersion, setDeletedIdsVersion] = useState(0);
  // Tracks every runId we've ever seen on MESSAGE_APPENDED. Used by the
  // "missing persisted message" timer below to decide whether to refetch.
  const persistedRunMessageIdsRef = useRef<Set<string>>(new Set());
  // Timer per runId that fires if RUN_COMPLETED arrives but the matching
  // MESSAGE_APPENDED never lands. Without this, a dropped persistence event
  // leaves the timeline empty until the user reloads or switches threads.
  const pendingMessageRefetchTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const threadStateRef = useRef<ThreadListState>(threadState);
  const searchQueryRef = useRef(searchQuery);
  const orchestrationMenuRef = useRef<HTMLDivElement | null>(null);
  const [docModalOpen, setDocModalOpen] = useState(false);
  const [docModalTitle, setDocModalTitle] = useState('');
  const [docModalFormat, setDocModalFormat] =
    useState<ContentFormat>('markdown');
  const [docModalSubmitting, setDocModalSubmitting] = useState(false);
  const [docModalError, setDocModalError] = useState<string | null>(null);
  const docModalInputRef = useRef<HTMLInputElement | null>(null);
  const [talkContent, setTalkContent] = useState<Content | null>(null);
  const [talkContentLoading, setTalkContentLoading] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  // Tracks whether the server has more history past the current view.
  // Initial value follows snapshot.hasOlderMessages; flips to false the
  // moment a `?before=<oldest>` page comes back short, so the
  // Load-earlier button hides once history is exhausted.
  const [olderMessagesAvailable, setOlderMessagesAvailable] = useState(false);
  const [talkContentError, setTalkContentError] = useState<string | null>(null);
  const [talkContentPendingEdits, setTalkContentPendingEdits] = useState<
    ContentEditSummary[]
  >([]);
  const [pendingEditStreamingByRunId, setPendingEditStreamingByRunId] =
    useState<Map<string, string | null>>(() => new Map());
  // Sidecar timestamps so the streaming-banner TTL sweep can age out
  // stuck entries when the server never emits a terminal event (e.g.,
  // an executor crash that bypasses the `content_edit_run_aborted`
  // emit). Kept as a ref — the periodic sweep uses it but no UI reads
  // it directly. Always kept in sync with `pendingEditStreamingByRunId`
  // — every add to the map writes here, every remove deletes here.
  const pendingEditStreamingStartedAtRef = useRef<Map<string, number>>(
    new Map(),
  );
  const [pendingEditInFlight, setPendingEditInFlight] = useState<Set<string>>(
    () => new Set(),
  );
  // Bumped each time a `talk_tools_changed` event arrives. Triggers
  // ToolChipsBar to refetch its active set so chip state syncs across
  // tabs without us threading the payload through.
  const [toolsRefreshKey, setToolsRefreshKey] = useState(0);
  // Composer `@`-mention typeahead. Tracks the live `@` index in the
  // draft and the active picker selection. Opens when @ lands at a word
  // boundary AND the Talk has an attached doc OR at least one ready
  // saved source. The popover offers `@doc` (if applicable) plus every
  // ready source filtered by the chars typed after `@`.
  const [mentionState, setMentionState] = useState<{
    atIndex: number;
    selectedIndex: number;
  } | null>(null);
  const [talkContentSaveStatus, setTalkContentSaveStatus] =
    useState<RichTextEditorSaveStatus>('idle');
  const [talkContentConflict, setTalkContentConflict] = useState(false);
  const talkContentRef = useRef<Content | null>(null);
  const talkContentSaveStatusRef = useRef<RichTextEditorSaveStatus>('idle');
  useEffect(() => {
    talkContentRef.current = talkContent;
  }, [talkContent]);
  useEffect(() => {
    talkContentSaveStatusRef.current = talkContentSaveStatus;
  }, [talkContentSaveStatus]);
  // Doc-pane visibility + HTML Preview/Source mode. Persisted per
  // thread via localStorage key `clawtalk_doc_state:{threadId}` so the
  // user's last layout choice survives reload + thread switch.
  const [docPaneHidden, setDocPaneHidden] = useState<boolean>(false);
  const [htmlMode, setHtmlMode] = useState<DocPaneMode>('preview');
  // Tracks whether we've already auto-flipped this doc from Source ➜
  // Preview after the first AI generation. Sticky for the lifetime of
  // the page mount — flips only once per doc.
  const htmlAutoFlippedRef = useRef<Set<string>>(new Set());
  // Local draft for the HTML source editor. The optimistic state
  // sidesteps the lag between keystrokes and the debounced PATCH
  // round-trip, so the editor always shows the latest characters.
  const [htmlSourceDraft, setHtmlSourceDraft] = useState<string>('');
  const htmlSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const htmlSavingRef = useRef<boolean>(false);
  const htmlLastSavedRef = useRef<string>('');
  const docBodyRef = useRef<HTMLDivElement | null>(null);
  const docEdgeTabRef = useRef<HTMLButtonElement | null>(null);
  const docNarrowShowBtnRef = useRef<HTMLButtonElement | null>(null);
  const [chatRatio, setChatRatio] = useState(0.5);
  const [isNarrowViewport, setIsNarrowViewport] = useState(() => {
    if (typeof window === 'undefined') return false;
    if (typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(max-width: 767px)').matches;
  });
  const initialDocParam = locationParams.get('doc') === '1';
  const [mobilePane, setMobilePane] = useState<'chat' | 'doc'>(
    initialDocParam ? 'doc' : 'chat',
  );
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const splitHandleRef = useRef<HTMLDivElement | null>(null);
  const splitDraggingRef = useRef(false);
  const [agents, setAgents] = useState<TalkAgent[]>([]);
  const [agentDrafts, setAgentDrafts] = useState<TalkAgent[]>([]);
  const [aiAgentsData, setAiAgentsData] = useState<AiAgentsPageData | null>(
    null,
  );
  const [registeredAgentsCatalog, setRegisteredAgentsCatalog] = useState<
    RegisteredAgent[]
  >([]);
  const [agentsCatalogError, setAgentsCatalogError] = useState<string | null>(
    null,
  );
  const [targetAgentIds, setTargetAgentIds] = useState<string[]>([]);
  const [newAgentDraft, setNewAgentDraft] = useState<AgentCreationDraft>({
    sourceKind: 'claude_default',
    providerId: null,
    modelId: '',
    role: 'assistant',
  });
  const [agentState, setAgentState] = useState<{
    status: 'idle' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });
  const [talkConnectors, setTalkConnectors] = useState<TalkDataConnector[]>([]);
  const [orgConnectors, setOrgConnectors] = useState<DataConnector[]>([]);
  const [attachConnectorId, setAttachConnectorId] = useState('');
  const [connectorState, setConnectorState] = useState<{
    status: 'idle' | 'loading' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });
  const [historyEditorOpen, setHistoryEditorOpen] = useState(false);
  const [historyEditState, setHistoryEditState] = useState<{
    status: 'idle' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });
  const [orchestrationState, setOrchestrationState] = useState<{
    status: 'idle' | 'saving' | 'error';
    message?: string;
  }>({ status: 'idle' });
  const [orchestrationMenuOpen, setOrchestrationMenuOpen] = useState(false);

  // Context tab state
  const [contextGoal, setContextGoal] = useState<ContextGoal | null>(null);
  const [contextRules, setContextRules] = useState<ContextRule[]>([]);
  const [contextSources, setContextSources] = useState<ContextSource[]>([]);
  const [contextLoaded, setContextLoaded] = useState(false);
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, string>>({});
  const [contextStatus, setContextStatus] = useState<{
    status: 'idle' | 'loading' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });
  const [talkStateEntries, setTalkStateEntries] = useState<TalkStateEntry[]>(
    [],
  );
  const [talkStateLoaded, setTalkStateLoaded] = useState(false);
  const [talkStateStatus, setTalkStateStatus] = useState<{
    status: 'idle' | 'loading' | 'error';
    message?: string;
  }>({ status: 'idle' });
  const [talkJobs, setTalkJobs] = useState<TalkJob[]>([]);
  const [talkJobsLoaded, setTalkJobsLoaded] = useState(false);
  const [talkJobsStatus, setTalkJobsStatus] = useState<{
    status: 'idle' | 'loading' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedJobRuns, setSelectedJobRuns] = useState<TalkJobRunSummary[]>(
    [],
  );
  const [selectedJobRunsStatus, setSelectedJobRunsStatus] = useState<{
    status: 'idle' | 'loading' | 'error';
    message?: string;
  }>({ status: 'idle' });
  const [creatingJob, setCreatingJob] = useState(false);
  const [jobDraft, setJobDraft] = useState<TalkJobDraft>(() =>
    buildDefaultJobDraft(),
  );
  const [goalDraft, setGoalDraft] = useState('');
  const [newRuleText, setNewRuleText] = useState('');
  const [channelBindings, setChannelBindings] = useState<TalkChannelBinding[]>(
    [],
  );
  const [channelConnections, setChannelConnections] = useState<
    ChannelConnection[]
  >([]);
  const [channelTargetInventory, setChannelTargetInventory] =
    useState<ChannelTargetInventoryState>(buildEmptyChannelTargetInventory());
  const [channelDrafts, setChannelDrafts] = useState<
    Record<string, ChannelBindingDraft>
  >({});
  const [channelFailuresByBindingId, setChannelFailuresByBindingId] = useState<
    Record<
      string,
      { ingress: ChannelQueueFailure[]; delivery: ChannelQueueFailure[] }
    >
  >({});
  const [channelBindingMemoryById, setChannelBindingMemoryById] = useState<
    Record<string, BindingMemoryPanelState>
  >({});
  const [channelInstructionReviews, setChannelInstructionReviews] = useState<
    Record<string, ChannelInstructionReviewState>
  >({});
  const [channelCreateDraft, setChannelCreateDraft] =
    useState<ChannelCreateDraft>(buildDefaultChannelCreateDraft());
  const [channelTargetQuery, setChannelTargetQuery] = useState('');
  const [channelTargetsLoading, setChannelTargetsLoading] = useState(false);
  const [channelSyncingConnectionId, setChannelSyncingConnectionId] = useState<
    string | null
  >(null);
  const [channelStatus, setChannelStatus] = useState<{
    status: 'idle' | 'loading' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });
  const [channelTestStatus, setChannelTestStatus] = useState<{
    bindingId: string | null;
    status: 'idle' | 'sending' | 'error' | 'success';
    message?: string;
    location?: 'diagnosis' | 'footer';
  }>({ bindingId: null, status: 'idle' });

  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const messageElementRefs = useRef<Map<string, HTMLElement>>(new Map());
  const autoStickToBottomRef = useRef(false);
  const onUnauthorizedRef = useRef(onUnauthorized);

  useEffect(() => {
    onUnauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  activeThreadIdRef.current = activeThreadId;
  threadStateRef.current = threadState;
  searchQueryRef.current = searchQuery;
  runContextPanelsRef.current = runContextPanels;

  useEffect(() => {
    threadSnapshotVersionRef.current += 1;
  }, [activeThreadId]);

  // PR C: keep the reducer's selectedThreadId in lockstep with the
  // page's activeThreadId useState. Several actions (RUN_QUEUED,
  // RUN_STARTED, RESPONSE_FAILED) guard on this to decide whether a
  // live-response panel belongs in the currently-rendered thread.
  useEffect(() => {
    dispatch({ type: 'THREAD_SELECTED', threadId: activeThreadId });
  }, [activeThreadId]);

  const ruleSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const orderedContextRules = useMemo(
    () => sortRulesByOrder(contextRules),
    [contextRules],
  );
  const activeRuleCount = useMemo(
    () => contextRules.filter((rule) => rule.isActive).length,
    [contextRules],
  );

  const currentThreadHasContent = useMemo(
    () =>
      activeThreadId !== null &&
      sidebarContents.some((c) => c.threadId === activeThreadId),
    [activeThreadId, sidebarContents],
  );

  const openDocModal = useCallback(() => {
    setDocModalTitle('');
    setDocModalFormat('markdown');
    setDocModalError(null);
    setDocModalOpen(true);
  }, []);

  const closeDocModal = useCallback(() => {
    if (docModalSubmitting) return;
    setDocModalOpen(false);
    setDocModalError(null);
  }, [docModalSubmitting]);

  const handleCreateDoc = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (docModalSubmitting) return;
      const trimmed = docModalTitle.trim();
      if (!trimmed) {
        setDocModalError('Please enter a title.');
        return;
      }
      setDocModalSubmitting(true);
      setDocModalError(null);
      try {
        // Prefer the thread-scoped endpoint when the active thread is
        // known — the backend keys content rows on threadId and the
        // /threads route works equally well for default threads. Fall
        // back to talk-scoped if the thread list hasn't hydrated yet.
        const created = activeThreadId
          ? await createThreadContent({
              threadId: activeThreadId,
              title: trimmed,
              format: docModalFormat,
            })
          : await createTalkContent({
              talkId,
              title: trimmed,
              format: docModalFormat,
            });

        // Render the new doc immediately. The create API returns the row,
        // so we don't wait on a background snapshot/WS refetch — for a
        // brand-new doc the WS content handler bails while talkContent is
        // still null (see onContentUpdated ~4747), so otherwise the doc
        // only lands on a much later refetch (that "took a long time" feel).
        //
        // Clobber-safety: the snapshot hydration effect does an
        // unconditional setTalkContent(snapshot.content). A same-thread
        // snapshot fetch already in flight (it read the server before this
        // doc existed) would resolve content:null and wipe the optimistic
        // doc back out. Cancel those in-flight fetches and seed the cache so
        // hydration reads content:created. Key on created.threadId so the
        // talk-scoped fallback (default thread) is covered too.
        const threadKey = snapshotQueryKey(userId, talkId, created.threadId);
        await queryClient.cancelQueries({ queryKey: threadKey });
        queryClient.setQueryData<TalkSnapshot>(threadKey, (old) =>
          old ? { ...old, content: created, pendingEdits: [] } : old,
        );

        setTalkContent(created);
        setTalkContentPendingEdits([]);
        setTalkContentError(null);
        setTalkContentConflict(false);
        setTalkContentSaveStatus('idle');
        setTalkContentLoading(false);
        setDocPaneHidden(false);
        setDocModalOpen(false);
        setDocModalTitle('');
        // Reconcile the sidebar (hides "+ Doc") in the background — don't
        // block the modal close on it.
        void onSidebarChanged();
        // Preserve ?thread= so we stay on the canonical thread-keyed
        // snapshot entry (no bootstrap refetch that could reintroduce the
        // clobber).
        navigate(
          `${buildThreadHref(talkId, created.threadId, currentTab)}&doc=1`,
        );
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        const message =
          err instanceof Error ? err.message : 'Failed to create document.';
        setDocModalError(message);
        if (err instanceof ApiError && err.code === 'content_already_exists') {
          await onSidebarChanged();
        }
      } finally {
        setDocModalSubmitting(false);
      }
    },
    [
      activeThreadId,
      currentTab,
      docModalFormat,
      docModalSubmitting,
      docModalTitle,
      navigate,
      onSidebarChanged,
      onUnauthorized,
      queryClient,
      talkId,
      userId,
    ],
  );

  useEffect(() => {
    if (!docModalOpen) return;
    docModalInputRef.current?.focus();
  }, [docModalOpen]);

  useEffect(() => {
    setTalkContent(null);
    setTalkContentError(null);
    setTalkContentConflict(false);
    setTalkContentSaveStatus('idle');
    setTalkContentPendingEdits([]);
    setPendingEditStreamingByRunId(new Map());
    pendingEditStreamingStartedAtRef.current.clear();
    setPendingEditInFlight(new Set());
  }, [talkId]);

  // TTL sweep for the streaming-banner map. The server normally emits
  // `content_edit_run_aborted` when the agent finishes a turn without
  // calling apply_content_edit, but an executor crash mid-turn can
  // bypass that emit and leave the banner stuck on "X is editing…"
  // forever. Sweep every 15s and drop entries older than the TTL.
  useEffect(() => {
    const STREAMING_TTL_MS = 90_000;
    const interval = setInterval(() => {
      const now = Date.now();
      const stale: string[] = [];
      for (const [
        runId,
        startedAt,
      ] of pendingEditStreamingStartedAtRef.current) {
        if (now - startedAt > STREAMING_TTL_MS) stale.push(runId);
      }
      if (stale.length === 0) return;
      setPendingEditStreamingByRunId((prev) => {
        let next: Map<string, string | null> | null = null;
        for (const runId of stale) {
          if (prev.has(runId)) {
            if (next === null) next = new Map(prev);
            next.delete(runId);
          }
        }
        return next ?? prev;
      });
      for (const runId of stale) {
        pendingEditStreamingStartedAtRef.current.delete(runId);
      }
    }, 15_000);
    return () => clearInterval(interval);
  }, []);

  // Combined doc-pane state lifecycle: hydrate once per thread, decide
  // the initial HTML mode (Preview unless empty-HTML doc with no
  // persisted preference → Source), then persist on every change. We
  // do this in one effect chain (gated by per-thread refs) so the
  // first persist doesn't race the auto-source decision.
  const docStateHydratedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeThreadId) return;
    if (typeof window === 'undefined') return;
    if (docStateHydratedForRef.current === activeThreadId) return;
    docStateHydratedForRef.current = activeThreadId;
    try {
      const raw = window.localStorage.getItem(
        `clawtalk_doc_state:${activeThreadId}`,
      );
      if (raw) {
        const parsed = JSON.parse(raw) as {
          hidden?: boolean;
          mode?: DocPaneMode;
        };
        setDocPaneHidden(parsed.hidden === true);
        setHtmlMode(parsed.mode === 'source' ? 'source' : 'preview');
        return;
      }
    } catch {
      // Malformed entry — fall through to defaults.
    }
    setDocPaneHidden(false);
    setHtmlMode('preview');
  }, [activeThreadId]);

  // Auto-flip an empty HTML doc into Source mode, BUT only when there
  // is no persisted preference for this thread. The ref guard ensures
  // we only attempt this once per content id so the user can later
  // manually toggle to Preview while the body is still empty.
  // ALWAYS sets the ref (even for markdown / non-empty HTML / persisted
  // preference cases) so the persist effect's gate opens after the
  // initial decision is made.
  const docFirstLoadModeAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!talkContent) return;
    if (docFirstLoadModeAppliedRef.current === talkContent.id) return;
    docFirstLoadModeAppliedRef.current = talkContent.id;
    if (talkContent.contentFormat !== 'html') return;
    const body = talkContent.bodyHtml ?? '';
    if (body.length > 0) return;
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(
        `clawtalk_doc_state:${talkContent.threadId}`,
      );
      if (raw) return;
    } catch {
      // Ignore localStorage read failures.
    }
    setHtmlMode('source');
    // Write the same value to localStorage immediately so the hydrate
    // effect (which may fire later when activeThreadId arrives in a
    // separate commit) sees the auto-source preference and doesn't
    // overwrite it back to Preview.
    try {
      window.localStorage.setItem(
        `clawtalk_doc_state:${talkContent.threadId}`,
        JSON.stringify({ hidden: false, mode: 'source' }),
      );
    } catch {
      // Quota / private mode — silently ignore.
    }
  }, [talkContent]);

  // Persist doc-pane state to localStorage on user-initiated changes.
  // Gated on "we've already done initial hydration AND first-load
  // auto-source for this content" so the very first commit doesn't
  // overwrite the auto-source choice with the default `preview`.
  useEffect(() => {
    if (!talkContent) return;
    if (typeof window === 'undefined') return;
    // Only persist after both hydration and first-load auto-source
    // have settled for the active thread/content. Otherwise the first
    // commit (where htmlMode is still the stale `'preview'` closure
    // captured before either of those effects fired) clobbers the
    // newly-computed mode.
    if (!activeThreadId) return;
    if (docStateHydratedForRef.current !== activeThreadId) return;
    if (docFirstLoadModeAppliedRef.current !== talkContent.id) return;
    try {
      window.localStorage.setItem(
        `clawtalk_doc_state:${talkContent.threadId}`,
        JSON.stringify({ hidden: docPaneHidden, mode: htmlMode }),
      );
    } catch {
      // Quota / private mode — silently ignore.
    }
  }, [activeThreadId, docPaneHidden, htmlMode, talkContent]);

  // Keep the local HTML draft in sync with the server-side content body
  // so server-driven changes (initial fetch, AI edits, conflict reloads)
  // land in the editor.
  useEffect(() => {
    if (!talkContent) {
      setHtmlSourceDraft('');
      htmlLastSavedRef.current = '';
      return;
    }
    if (talkContent.contentFormat !== 'html') return;
    const body = talkContent.bodyHtml ?? '';
    setHtmlSourceDraft(body);
    htmlLastSavedRef.current = body;
  }, [talkContent]);

  // Cancel any in-flight HTML autosave debounce on unmount.
  useEffect(() => {
    return () => {
      if (htmlSaveTimerRef.current !== null) {
        clearTimeout(htmlSaveTimerRef.current);
        htmlSaveTimerRef.current = null;
      }
    };
  }, []);

  // Persist an HTML source edit. Mirrors the markdown autosave shape:
  // PATCH with bodyHtml, swap to 'saving', then 'saved' / 'error'. On
  // version_conflict we surface the same reload banner the markdown
  // path uses.
  const performHtmlSave = useCallback(
    async (next: string): Promise<void> => {
      const cur = talkContentRef.current;
      if (!cur) return;
      if (cur.contentFormat !== 'html') return;
      if (next === htmlLastSavedRef.current) return;
      if (htmlSavingRef.current) return;
      htmlSavingRef.current = true;
      setTalkContentSaveStatus('saving');
      try {
        const result = await patchContent({
          contentId: cur.id,
          expectedVersion: cur.bodyVersion,
          bodyHtml: next,
        });
        htmlLastSavedRef.current = result.content.bodyHtml ?? '';
        setTalkContent(result.content);
        setTalkContentSaveStatus('saved');
      } catch (err) {
        if (err instanceof ApiError && err.code === 'version_conflict') {
          setTalkContentConflict(true);
          setTalkContentSaveStatus('error');
          return;
        }
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setTalkContentSaveStatus('error');
        setTalkContentError(
          err instanceof Error ? err.message : 'Failed to save document.',
        );
      } finally {
        htmlSavingRef.current = false;
      }
    },
    [onUnauthorized],
  );

  const handleHtmlSourceChange = useCallback((next: string) => {
    setHtmlSourceDraft(next);
    setTalkContentSaveStatus('pending');
  }, []);

  const handleHtmlSourceSave = useCallback(
    (next: string) => {
      // HtmlSourceEditor already debounces; this just fires the PATCH.
      void performHtmlSave(next);
    },
    [performHtmlSave],
  );

  // PATCH the doc title from the header's InlineEditableTitle. Throws
  // on error so InlineEditableTitle can surface the message inline.
  const handleDocTitleSave = useCallback(
    async (nextTitle: string): Promise<void> => {
      const cur = talkContentRef.current;
      if (!cur) return;
      const trimmed = nextTitle.trim();
      if (!trimmed) throw new Error('Title cannot be empty.');
      if (trimmed === cur.title) return;
      try {
        const result = await patchContent({
          contentId: cur.id,
          expectedVersion: cur.bodyVersion,
          title: trimmed,
        });
        setTalkContent(result.content);
        // Sidebar shows the title — refresh so the rename propagates.
        void onSidebarChanged();
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (err instanceof ApiError && err.code === 'version_conflict') {
          setTalkContentConflict(true);
          throw new Error('Document changed elsewhere. Reload to retry.');
        }
        throw err instanceof Error ? err : new Error('Failed to update title.');
      }
    },
    [onSidebarChanged, onUnauthorized],
  );

  // Hide / show the doc pane. The button is rendered both in the
  // header (hide) and as an edge-tab (show) — both share this setter
  // so the localStorage write effect fires either way.
  const handleHideDocPane = useCallback(() => {
    setDocPaneHidden(true);
    // Move focus to the edge tab (or narrow-viewport "Show doc" btn)
    // so keyboard users don't lose their place.
    requestAnimationFrame(() => {
      docEdgeTabRef.current?.focus();
      docNarrowShowBtnRef.current?.focus();
    });
  }, []);

  const handleShowDocPane = useCallback(() => {
    setDocPaneHidden(false);
    requestAnimationFrame(() => {
      docBodyRef.current?.focus();
    });
  }, []);

  const refetchTalkContent = useCallback(async (): Promise<Content | null> => {
    if (!talkId) return null;
    try {
      // Prefer thread-scoped fetch when we know the active thread.
      // /threads/:threadId/content works for the default thread too,
      // so we can keep a single code path once threads have hydrated.
      // Read the activeThreadId via ref so this callback stays stable
      // — the openTalkStream effect depends on it and we don't want
      // to tear the WebSocket down every time the thread changes.
      const threadId = activeThreadIdRef.current;
      const payload = threadId
        ? await getThreadContent(threadId)
        : await getTalkContent(talkId);
      setTalkContent(payload.content);
      setTalkContentPendingEdits(payload.pendingEdits ?? []);
      setTalkContentError(null);
      return payload.content;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return null;
      }
      setTalkContentError(
        err instanceof Error ? err.message : 'Failed to load document.',
      );
      return null;
    }
  }, [onUnauthorized, talkId]);

  // Doc state is hydrated entirely by the snapshot. The defensive clear
  // that used to live here raced sidebarContents on initial load —
  // App.tsx fetches the sidebar tree separately, so `currentThreadHasContent`
  // could land `false` for a thread that genuinely has a doc, clearing
  // `snapshot.content` before the sidebar caught up. Codex #462 P1.

  useEffect(() => {
    if (!talkId) return;
    setChatRatio(getContentSplitRatio(talkId));
  }, [talkId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (event: MediaQueryListEvent) =>
      setIsNarrowViewport(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // When the user navigates to ?doc=1 (e.g., from the sidebar CONTENT
  // row or the +Doc promotion modal), default the narrow-screen toggle
  // to the doc pane. Re-evaluates whenever the query string changes.
  useEffect(() => {
    if (initialDocParam) setMobilePane('doc');
  }, [initialDocParam]);

  const clampRatio = useCallback((value: number) => {
    if (!Number.isFinite(value)) return 0.5;
    return Math.max(0.2, Math.min(0.8, value));
  }, []);

  const applyChatRatio = useCallback(
    (nextRaw: number) => {
      const next = clampRatio(nextRaw);
      setChatRatio(next);
      if (talkId) setContentSplitRatio(talkId, next);
    },
    [clampRatio, talkId],
  );

  const handleResizeHandleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        applyChatRatio(chatRatio - 0.05);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        applyChatRatio(chatRatio + 0.05);
      } else if (event.key === 'Home') {
        event.preventDefault();
        applyChatRatio(0.2);
      } else if (event.key === 'End') {
        event.preventDefault();
        applyChatRatio(0.8);
      }
    },
    [applyChatRatio, chatRatio],
  );

  useEffect(() => {
    const handle = splitHandleRef.current;
    if (!handle) return;
    const onPointerDown = (event: PointerEvent) => {
      splitDraggingRef.current = true;
      handle.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!splitDraggingRef.current) return;
      const container = splitContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      applyChatRatio((event.clientX - rect.left) / rect.width);
    };
    const onPointerUp = (event: PointerEvent) => {
      splitDraggingRef.current = false;
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
    };
    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);
    return () => {
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerUp);
    };
  }, [applyChatRatio, currentThreadHasContent, talkContent]);

  const isNearBottom = useCallback((): boolean => {
    const container = timelineRef.current;
    if (!container) return true;
    const distanceToBottom =
      container.scrollHeight - (container.scrollTop + container.clientHeight);
    return distanceToBottom <= SCROLL_STICK_THRESHOLD_PX;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    // Drive timelineRef.scrollTop directly instead of
    // endRef.scrollIntoView. The latter walks every overflow-scrollable
    // ancestor and the talk shell has two of them (.talk-workspace-scroll
    // wraps .talk-thread-scroll). In nested scroll containers,
    // scrollIntoView can end up scrolling the outer wrapper to put endRef
    // at the bottom of the viewport — which visually leaves the inner
    // scroll at the top showing the oldest messages. Targeting the inner
    // container alone is unambiguous. requestAnimationFrame defers the
    // write to the next frame so scrollHeight reflects the newly
    // committed message.
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      const w = window as unknown as { __clawtalkScrollToBottomCount?: number };
      w.__clawtalkScrollToBottomCount =
        (w.__clawtalkScrollToBottomCount ?? 0) + 1;
    }
    const apply = () => {
      const container = timelineRef.current;
      if (!container) return;
      const target = container.scrollHeight - container.clientHeight;
      if (target <= 0) return;
      if (behavior === 'smooth' && typeof container.scrollTo === 'function') {
        container.scrollTo({ top: target, behavior: 'smooth' });
      } else {
        container.scrollTop = target;
      }
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(apply);
    } else {
      apply();
    }
  }, []);

  const setMessageElementRef = useCallback(
    (messageId: string, element: HTMLElement | null) => {
      if (element) {
        messageElementRefs.current.set(messageId, element);
        return;
      }
      messageElementRefs.current.delete(messageId);
    },
    [],
  );

  const handleUnauthorized = useCallback(() => {
    onUnauthorizedRef.current();
  }, []);

  const refreshThreadListNow = useCallback(async () => {
    if (threadRefreshInFlightRef.current) {
      threadRefreshDirtyRef.current = true;
      return;
    }
    threadRefreshInFlightRef.current = true;
    try {
      const next = sortThreads(await listTalkThreads(talkId));
      setThreadState({ threads: next, loading: false, error: null });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setThreadState((current) => ({
        ...current,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load threads.',
      }));
    } finally {
      threadRefreshInFlightRef.current = false;
      if (threadRefreshDirtyRef.current) {
        threadRefreshDirtyRef.current = false;
        void refreshThreadListNow();
      }
    }
  }, [handleUnauthorized, talkId]);

  const rememberDeletedMessageIds = useCallback((messageIds: string[]) => {
    if (messageIds.length === 0) return;
    const next = new Set(deletedMessageIdsRef.current);
    for (const messageId of messageIds) {
      const normalized = messageId.trim();
      if (normalized) {
        next.add(normalized);
      }
    }
    deletedMessageIdsRef.current = next;
    // Re-run memoized message filters even if the messages array doesn't
    // change — otherwise a racing execution resync that returns the
    // pre-delete rows verbatim would flash the just-deleted messages back.
    setDeletedIdsVersion((v) => v + 1);
  }, []);

  const filterDeletedMessages = useCallback((messages: TalkMessage[]) => {
    if (deletedMessageIdsRef.current.size === 0) return messages;
    return messages.filter(
      (message) => !deletedMessageIdsRef.current.has(message.id),
    );
  }, []);

  // PR C: cached message timeline derived from the snapshot. The wsCacheRouter
  // appends new messages via setQueryData; this memo re-derives whenever the
  // identity of `talkSnapshot.messages` changes (mutation, refetch, delete).
  const pageMessages: TalkMessage[] = useMemo(
    () => filterDeletedMessages(talkSnapshot?.messages ?? EMPTY_MESSAGES),
    [deletedIdsVersion, filterDeletedMessages, talkSnapshot?.messages],
  );
  const pageMessageIds = useMemo(
    () => new Set(pageMessages.map((m) => m.id)),
    [pageMessages],
  );

  const handleLoadOlderMessages = useCallback(async (): Promise<void> => {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    if (loadingOlderMessages) return;
    const oldest = pageKind === 'ready' ? pageMessages[0] : null;
    if (!oldest) return;
    setLoadingOlderMessages(true);
    const pageSize = 200;
    try {
      const older = await listTalkMessages(talkId, {
        threadId,
        before: oldest.createdAt,
        limit: pageSize,
      });
      if (activeThreadIdRef.current !== threadId) return;
      const filtered = filterDeletedMessages(older);
      // Server returned fewer than we asked for → no more history. Patch
      // the snapshot's `hasOlderMessages` in the same setQueryData so a
      // background refetch can't mirror the stale `true` back into the
      // page state (Codex #466 P2 + Codex #462 P3).
      const isFinalPage = older.length < pageSize;
      prependOlderTalkMessagesToSnapshot({
        queryClient,
        userId,
        talkId,
        threadId,
        messages: filtered,
        hasOlderMessages: isFinalPage ? false : undefined,
      });
      if (isFinalPage) {
        setOlderMessagesAvailable(false);
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
      }
    } finally {
      setLoadingOlderMessages(false);
    }
  }, [
    filterDeletedMessages,
    handleUnauthorized,
    loadingOlderMessages,
    pageKind,
    pageMessages,
    queryClient,
    talkId,
    userId,
  ]);

  const scheduleThreadListRefresh = useCallback(() => {
    threadRefreshDirtyRef.current = true;
    if (threadRefreshTimerRef.current) return;
    threadRefreshTimerRef.current = setTimeout(() => {
      threadRefreshTimerRef.current = null;
      if (!threadRefreshDirtyRef.current) return;
      threadRefreshDirtyRef.current = false;
      void refreshThreadListNow();
    }, 500);
  }, [refreshThreadListNow]);

  const resyncTalkState = useCallback(
    async (options?: { refreshThreads?: boolean }) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      const snapshotVersion = threadSnapshotVersionRef.current;
      // PR C: messages + active runs come from the snapshot query —
      // invalidate it and let RQ refetch. Historical runs are still
      // separate; re-fetch them in parallel so the Runs tab updates.
      // The threads list stays on its component-local state.
      void queryClient.invalidateQueries({
        queryKey: snapshotQueryKey(userId, talkId, threadId),
      });
      try {
        const [threads, runs] = await Promise.all([
          options?.refreshThreads === false
            ? Promise.resolve(null)
            : listTalkThreads(talkId),
          getTalkRuns(talkId),
        ]);
        if (
          threadId !== activeThreadIdRef.current ||
          snapshotVersion !== threadSnapshotVersionRef.current
        ) {
          return;
        }
        if (threads) {
          setThreadState({
            threads: sortThreads(threads),
            loading: false,
            error: null,
          });
        }
        dispatch({ type: 'MERGE_HISTORICAL_RUNS', runs });
        autoStickToBottomRef.current = true;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
        }
      }
    },
    [handleUnauthorized, queryClient, talkId, userId],
  );

  const refreshBrowserRuns = useCallback(
    async () => resyncTalkState({ refreshThreads: true }),
    [resyncTalkState],
  );

  const refreshContext = useCallback(
    async (options?: { hydrateGoalDraft?: boolean; showLoading?: boolean }) => {
      if (options?.showLoading) {
        setContextStatus({ status: 'loading' });
      }
      const ctx = await getTalkContext(talkId);
      setContextGoal(ctx.goal);
      if (options?.hydrateGoalDraft) {
        setGoalDraft(ctx.goal?.goalText ?? '');
      }
      const sortedRules = sortRulesByOrder(ctx.rules);
      setContextRules(sortedRules);
      setRuleDrafts(buildRuleDraftMap(sortedRules));
      setContextSources(ctx.sources);
      setContextLoaded(true);
      setContextStatus({ status: 'idle' });
    },
    [talkId],
  );

  const refreshTalkStateEntries = useCallback(
    async (options?: { showLoading?: boolean }) => {
      if (options?.showLoading) {
        setTalkStateStatus({ status: 'loading' });
      }
      try {
        const entries = await getTalkState(talkId);
        setTalkStateEntries(entries);
        setTalkStateLoaded(true);
        setTalkStateStatus({ status: 'idle' });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setTalkStateStatus({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load state.',
        });
      }
    },
    [handleUnauthorized, talkId],
  );

  const loadSelectedJobRuns = useCallback(
    async (jobId: string, options?: { showLoading?: boolean }) => {
      if (options?.showLoading) {
        setSelectedJobRunsStatus({ status: 'loading' });
      }
      const runs = await listTalkJobRuns({ talkId, jobId, limit: 20 });
      setSelectedJobRuns(runs);
      setSelectedJobRunsStatus({ status: 'idle' });
      return runs;
    },
    [talkId],
  );

  const refreshTalkJobs = useCallback(
    async (options?: {
      showLoading?: boolean;
      preserveSelection?: boolean;
      preferredJobId?: string | null;
    }) => {
      if (options?.showLoading) {
        setTalkJobsStatus({ status: 'loading' });
      }
      const [jobs, attachedConnectors, bindings] = await Promise.all([
        listTalkJobs(talkId),
        getTalkDataConnectors(talkId),
        listTalkChannels(talkId),
      ]);
      setTalkJobs(jobs);
      setTalkJobsLoaded(true);
      setTalkConnectors(attachedConnectors);
      setChannelBindings(bindings);
      setTalkJobsStatus({ status: 'idle' });

      const nextSelectedId =
        (options?.preferredJobId &&
          jobs.some((job) => job.id === options.preferredJobId) &&
          options.preferredJobId) ||
        (options?.preserveSelection &&
          selectedJobId &&
          jobs.some((job) => job.id === selectedJobId) &&
          selectedJobId) ||
        jobs[0]?.id ||
        null;

      if (!nextSelectedId) {
        setSelectedJobId(null);
        setCreatingJob(false);
        setJobDraft(
          buildDefaultJobDraft({
            targetAgentId:
              agents.find((agent) => agent.isPrimary)?.id || agents[0]?.id,
          }),
        );
        setSelectedJobRuns([]);
        setSelectedJobRunsStatus({ status: 'idle' });
        return jobs;
      }

      const job = jobs.find((candidate) => candidate.id === nextSelectedId);
      if (!job) {
        return jobs;
      }

      setCreatingJob(false);
      setSelectedJobId(job.id);
      setJobDraft(buildJobDraftFromJob(job));
      await loadSelectedJobRuns(job.id, { showLoading: false });
      return jobs;
    },
    [agents, loadSelectedJobRuns, selectedJobId, talkId],
  );

  const refreshSelectedJobExecutionState = useCallback(
    async (jobId: string) => {
      const [job, runs] = await Promise.all([
        getTalkJob({ talkId, jobId }),
        listTalkJobRuns({ talkId, jobId, limit: 20 }),
      ]);
      setTalkJobs((current) =>
        current.map((candidate) => (candidate.id === job.id ? job : candidate)),
      );
      if (selectedJobId === job.id) {
        setSelectedJobId(job.id);
        setJobDraft(buildJobDraftFromJob(job));
        setSelectedJobRuns(runs);
      }
      setSelectedJobRunsStatus({ status: 'idle' });
      return { job, runs };
    },
    [selectedJobId, talkId],
  );

  // Tracks the last (talkId, activeThreadId) we fully hydrated from the
  // snapshot. PR C: same-thread refetches no longer dispatch into the
  // reducer at all — the snapshot owns messages/talk/content — but we
  // still gate the run-side SNAPSHOT_HYDRATED so we don't re-seed active
  // runs on every background refetch.
  const hydratedKeyRef = useRef<string | null>(null);

  // Reset every per-talk slice when talkId changes. The snapshot query
  // and the runs/agents fetch below re-hydrate them; the rest stay at
  // their defaults until the user opens the corresponding tab.
  useEffect(() => {
    dispatch({ type: 'TALK_RESET' });
    threadStateTalkIdRef.current = null;
    hydratedKeyRef.current = null;
    lastSnapshotRef.current = null;
    messageElementRefs.current.clear();
    setThreadState({ threads: [], loading: true, error: null });
    deletedMessageIdsRef.current = new Set();
    setActiveThreadId(null);
    setSearchQuery('');
    setSearchResults([]);
    setSearchLoading(false);
    setSearchError(null);
    setAgents([]);
    setAgentDrafts([]);
    setTargetAgentIds([]);
    setAgentsCatalogError(null);
    setAgentState({ status: 'idle' });
    setTalkConnectors([]);
    setOrgConnectors([]);
    setAttachConnectorId('');
    setConnectorState({ status: 'idle' });
    setHistoryEditorOpen(false);
    setHistoryEditState({ status: 'idle' });
    setOrchestrationState({ status: 'idle' });
    setRunContextPanels({});
    setContextLoaded(false);
    setContextGoal(null);
    setContextRules([]);
    setContextSources([]);
    setRuleDrafts({});
    setContextStatus({ status: 'idle' });
    setTalkStateEntries([]);
    setTalkStateLoaded(false);
    setTalkStateStatus({ status: 'idle' });
    setTalkJobs([]);
    setTalkJobsLoaded(false);
    setTalkJobsStatus({ status: 'idle' });
    setSelectedJobId(null);
    setSelectedJobRuns([]);
    setSelectedJobRunsStatus({ status: 'idle' });
    setCreatingJob(false);
    setJobDraft(buildDefaultJobDraft());
    setGoalDraft('');
    setNewRuleText('');
    setChannelBindings([]);
    setChannelConnections([]);
    setChannelTargetInventory(buildEmptyChannelTargetInventory());
    setChannelDrafts({});
    setChannelFailuresByBindingId({});
    setChannelCreateDraft(buildDefaultChannelCreateDraft());
    setChannelTargetsLoading(false);
    setChannelStatus({ status: 'idle' });
    setTalkContent(null);
    setTalkContentPendingEdits([]);
    setTalkContentError(null);
    setTalkContentLoading(false);
    return () => {
      if (threadRefreshTimerRef.current) {
        clearTimeout(threadRefreshTimerRef.current);
        threadRefreshTimerRef.current = null;
      }
    };
  }, [talkId]);

  // Hydrate non-RQ side-effects the moment the snapshot resolves: the
  // thread list (kept in component state because the threads tab edits
  // it independently), the doc panel useState bridges (kept until a
  // future PR migrates them to RQ), and the reducer's runs slice via
  // SNAPSHOT_HYDRATED. Same-thread refetches re-run only the bridges,
  // never the reducer dispatch, so an inbound `setQueryData` patch
  // doesn't clobber live-streaming state.
  useEffect(() => {
    if (snapshotQuery.error) return;
    const snapshot = snapshotQuery.data;
    if (!snapshot) return;
    if (snapshot.talk.id !== talkId) return;
    const hydrationKey = `${talkId}::${snapshot.activeThreadId}`;
    const isFirstHydration = hydratedKeyRef.current !== hydrationKey;
    const sortedThreads = sortThreads(
      snapshot.threads.filter((thread) => !thread.isInternal),
    );
    setThreadState({ threads: sortedThreads, loading: false, error: null });
    threadStateTalkIdRef.current = talkId;
    // Always reconcile doc state — it advances independently of the
    // message timeline (content_updated/applied/resolved invalidates).
    setTalkContent(snapshot.content);
    setTalkContentPendingEdits(
      snapshot.pendingEdits.map((edit) => ({
        id: edit.id,
        contentId: edit.contentId,
        runId: edit.runId,
        agentId: edit.agentId,
        agentNickname: edit.agentNickname,
        messageId: edit.messageId,
        kind: edit.kind,
        baseContentVersion: edit.baseContentVersion,
        targetAnchorId: edit.targetAnchorId,
        newMarkdown: edit.newMarkdown,
        rationale: edit.rationale,
        createdAt: edit.createdAt,
      })),
    );
    setTalkContentError(null);
    setTalkContentLoading(false);
    rememberActiveThreadForTalk(talkId, snapshot.activeThreadId);
    setOlderMessagesAvailable(snapshot.hasOlderMessages);
    if (!isFirstHydration) return;
    hydratedKeyRef.current = hydrationKey;
    dispatch({
      type: 'SNAPSHOT_HYDRATED',
      threadId: snapshot.activeThreadId,
      runs: snapshotRunsToTalkRuns(snapshot.runs),
    });
  }, [snapshotQuery.data, snapshotQuery.error, talkId]);

  // Rich runs (historical) + rich agents (provider/model/health) come
  // from these two existing endpoints — kept out of the snapshot wire
  // shape to keep that payload tight. Fire in parallel with the
  // snapshot so they don't gate the first paint. PR C: both ordering
  // cases (parallel-first or snapshot-first) merge cleanly because
  // SNAPSHOT_HYDRATED and MERGE_HISTORICAL_RUNS are both pure overlays
  // on `runsById` that preserve any live-state already accumulated.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [runs, talkAgents] = await Promise.all([
          getTalkRuns(talkId),
          getTalkAgents(talkId),
        ]);
        if (cancelled) return;
        setAgents(talkAgents);
        setAgentDrafts(talkAgents);
        setTargetAgentIds(buildTargetSelection(talkAgents, []));
        // MERGE_HISTORICAL_RUNS is a pure overlay — order-independent
        // vs the snapshot effect's SNAPSHOT_HYDRATED, since neither
        // clobbers in-flight live state on existing run ids.
        dispatch({ type: 'MERGE_HISTORICAL_RUNS', runs });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [handleUnauthorized, talkId]);

  useEffect(() => {
    if (threadState.loading) return;
    // Bail when threadState was loaded for a different talkId — happens
    // mid-commit during cross-talk sidebar navigation, where this effect
    // fires before the bootstrap effect's state resets propagate.
    // Without this gate we'd save Talk A's threads[0] under Talk B's key.
    if (threadStateTalkIdRef.current !== talkId) return;
    if (threadState.threads.length === 0) {
      setActiveThreadId(null);
      return;
    }
    // Resolution order: URL ?thread= → saved-last-thread for this Talk
    // (localStorage) → most-recent-by-activity (threads[0]). Saved id is
    // dropped if the thread no longer exists.
    let validThreadId: string | null = null;
    if (
      requestedThreadId &&
      threadState.threads.some((thread) => thread.id === requestedThreadId)
    ) {
      validThreadId = requestedThreadId;
    } else {
      const saved = getLastThreadForTalk(talkId);
      if (saved && threadState.threads.some((thread) => thread.id === saved)) {
        validThreadId = saved;
      } else {
        validThreadId = threadState.threads[0]?.id || null;
      }
    }
    if (!validThreadId) return;
    if (requestedThreadId !== validThreadId) {
      navigate(buildThreadHref(talkId, validThreadId, currentTab), {
        replace: true,
      });
    }
    if (activeThreadId !== validThreadId) {
      setActiveThreadId(validThreadId);
    }
    // Persist the (talkId, threadId) pairing here — this is the only
    // place we know threadState has been loaded for the CURRENT talkId,
    // so a sidebar click to another Talk can't race a stale activeThreadId
    // into the wrong key.
    setLastThreadForTalk(talkId, validThreadId);
  }, [
    activeThreadId,
    currentTab,
    navigate,
    requestedThreadId,
    talkId,
    threadState.loading,
    threadState.threads,
  ]);

  useEffect(() => {
    setSearchResults([]);
    setSearchError(null);
    setRetryRunState(null);
  }, [activeThreadId]);

  // Thread-show scroll: restore the saved offset for this (talkId,
  // threadId) if the user had scrolled up to read history; otherwise
  // park at the bottom.
  //
  // We gate on the snapshot's activeThreadId matching the current
  // activeThreadId so a thread switch waits for the new snapshot to
  // land before scrolling — pageKind stays 'ready' across switches via
  // lastSnapshotRef, so the previous thread's DOM is what's mounted
  // until the new snapshot resolves. snapshotActiveThreadId is a
  // primitive derived from the cached snapshot, so background refetches
  // for the same thread don't re-trigger this effect.
  const snapshotActiveThreadId = snapshotQuery.data?.activeThreadId ?? null;
  useEffect(() => {
    if (pageKind !== 'ready' || !activeThreadId) return;
    if (snapshotActiveThreadId !== activeThreadId) return;
    const saved = loadThreadScroll(talkId, activeThreadId);
    const rafId = requestAnimationFrame(() => {
      if (pendingComposerFocusRef.current) {
        pendingComposerFocusRef.current = false;
        textareaRef.current?.focus();
      }
      if (saved && !saved.atBottom) {
        const container = timelineRef.current;
        if (container) {
          const maxOffset = Math.max(
            0,
            container.scrollHeight - container.clientHeight,
          );
          container.scrollTop = Math.min(saved.offset, maxOffset);
        }
      } else {
        scrollToBottom('auto');
      }
      dispatch({ type: 'CLEAR_UNREAD' });
    });
    // StrictMode in dev runs the mount effect twice; cancelling the
    // first rAF on cleanup ensures the second setup wins and we don't
    // scroll twice on warm-cache mounts where the gate passes on the
    // very first render.
    return () => cancelAnimationFrame(rafId);
  }, [
    activeThreadId,
    scrollToBottom,
    pageKind,
    snapshotActiveThreadId,
    talkId,
  ]);

  // Persist scroll position + at-bottom flag on user scroll, debounced
  // ~200ms. Owns the localStorage write end of the per-thread scroll
  // memory so the next mount can restore.
  useEffect(() => {
    const container = timelineRef.current;
    if (!container) return;
    if (pageKind !== 'ready' || !activeThreadId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const capturedTalkId = talkId;
    const capturedThreadId = activeThreadId;
    const onScroll = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const el = timelineRef.current;
        if (!el) return;
        saveThreadScroll(capturedTalkId, capturedThreadId, {
          offset: el.scrollTop,
          atBottom: isNearBottom(),
        });
      }, 200);
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [activeThreadId, isNearBottom, pageKind, talkId]);

  useEffect(() => {
    let cancelled = false;
    const loadAiAgents = async () => {
      try {
        const [next, regAgents] = await Promise.all([
          getAiAgents(),
          listRegisteredAgents(),
        ]);
        if (cancelled) return;
        setAiAgentsData(next);
        setRegisteredAgentsCatalog(regAgents);
        setAgentsCatalogError(null);
        setNewAgentDraft((current) =>
          current.modelId ? current : buildNewAgentDraft(next),
        );
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (!cancelled) {
          setAiAgentsData(null);
          setRegisteredAgentsCatalog([]);
          setAgentsCatalogError(
            err instanceof Error ? err.message : 'Failed to load AI agents.',
          );
        }
      }
    };

    void loadAiAgents();
    return () => {
      cancelled = true;
    };
  }, [handleUnauthorized]);

  const ensureKnownThread = useCallback(
    (threadId?: string | null): boolean => {
      if (!threadId) return false;
      const known = threadStateRef.current.threads.some(
        (thread) => thread.id === threadId,
      );
      if (!known) {
        scheduleThreadListRefresh();
      }
      return known;
    },
    [scheduleThreadListRefresh],
  );

  const bumpThreadSummaryFromMessage = useCallback(
    (threadId: string, createdAt: string) => {
      const known = threadStateRef.current.threads.some(
        (thread) => thread.id === threadId,
      );
      if (!known) {
        scheduleThreadListRefresh();
        return;
      }
      setThreadState((current) => {
        const threads = current.threads.map((thread) => {
          if (thread.id !== threadId) return thread;
          return {
            ...thread,
            messageCount: thread.messageCount + 1,
            lastMessageAt: createdAt,
          };
        });
        return { ...current, threads: sortThreads(threads) };
      });
    },
    [scheduleThreadListRefresh],
  );

  useEffect(() => {
    if (pageKind !== 'ready') return;
    const stream = openTalkStream({
      talkId,
      onUnauthorized: handleUnauthorized,
      onMessageAppended: (event: MessageAppendedEvent) => {
        if (event.talkId !== talkId) return;
        if (deletedMessageIdsRef.current.has(event.messageId)) return;
        if (event.runId) {
          persistedRunMessageIdsRef.current.add(event.runId);
          const pendingTimer = pendingMessageRefetchTimersRef.current.get(
            event.runId,
          );
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingMessageRefetchTimersRef.current.delete(event.runId);
          }
        }
        // Surgical RQ cache patch — keeps the persisted IDB snapshot
        // exact across reloads even when no React consumer is mounted.
        applyMessageAppendedDelta({ queryClient, userId, event });
        if (event.threadId) {
          ensureKnownThread(event.threadId);
        }
        if (!event.content || !event.createdAt) {
          if (event.threadId && event.threadId === activeThreadIdRef.current) {
            void resyncTalkState({ refreshThreads: true });
          } else {
            scheduleThreadListRefresh();
          }
          return;
        }
        if (event.threadId) {
          bumpThreadSummaryFromMessage(event.threadId, event.createdAt);
        }
        if (!event.threadId || event.threadId !== activeThreadIdRef.current) {
          return;
        }
        const nearBottom = isNearBottom();
        if (nearBottom) {
          autoStickToBottomRef.current = true;
        }
        dispatch({
          type: 'MESSAGE_LANDED',
          wasNearBottom: nearBottom,
          message: {
            id: event.messageId,
            threadId: event.threadId || activeThreadIdRef.current || '',
            role: event.role,
            content: event.content,
            createdBy: event.createdBy,
            createdAt: event.createdAt,
            runId: event.runId,
            agentId: event.agentId,
            agentNickname: event.agentNickname,
            metadata: event.metadata,
          },
        });
      },
      onRunStarted: (event: TalkRunStartedEvent) => {
        if (event.talkId !== talkId) return;
        ensureKnownThread(event.threadId);
        dispatch({
          type: event.status === 'queued' ? 'RUN_QUEUED' : 'RUN_STARTED',
          runId: event.runId,
          threadId: event.threadId,
          triggerMessageId: event.triggerMessageId,
          executorAlias: event.executorAlias,
          executorModel: event.executorModel,
          responseGroupId: event.responseGroupId,
          sequenceIndex: event.sequenceIndex,
        });
      },
      onRunQueued: (event: TalkRunStartedEvent) => {
        if (event.talkId !== talkId) return;
        ensureKnownThread(event.threadId);
        dispatch({
          type: 'RUN_QUEUED',
          runId: event.runId,
          threadId: event.threadId,
          triggerMessageId: event.triggerMessageId,
          executorAlias: event.executorAlias,
          executorModel: event.executorModel,
          responseGroupId: event.responseGroupId,
          sequenceIndex: event.sequenceIndex,
        });
      },
      onResponseStarted: (event: TalkResponseStartedEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadId !== activeThreadIdRef.current) return;
        // If the user is parked at the bottom (typical right after a
        // send), stay stuck so the "Thinking…" placeholder is visible
        // when the agent starts streaming. Mirrors onResponseDelta.
        const nearBottom = isNearBottom();
        if (nearBottom) autoStickToBottomRef.current = true;
        dispatch({ type: 'RESPONSE_STARTED', event });
      },
      onProgressUpdate: (event: TalkProgressUpdateEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadId !== activeThreadIdRef.current) return;
        dispatch({ type: 'RESPONSE_PROGRESS', event });
      },
      onResponseDelta: (event: TalkResponseDeltaEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadId !== activeThreadIdRef.current) return;
        const nearBottom = isNearBottom();
        if (nearBottom) autoStickToBottomRef.current = true;
        dispatch({ type: 'RESPONSE_DELTA', event });
      },
      onResponseUsage: (_event: TalkResponseUsageEvent) => {
        // Reserved for later usage surfacing.
      },
      onResponseCompleted: (event: TalkResponseTerminalEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadId !== activeThreadIdRef.current) return;
        dispatch({ type: 'RESPONSE_COMPLETED', event });
      },
      onResponseFailed: (event: TalkResponseTerminalEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadId !== activeThreadIdRef.current) return;
        dispatch({ type: 'RESPONSE_FAILED', event });
      },
      onResponseCancelled: (event: TalkResponseTerminalEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadId !== activeThreadIdRef.current) return;
        dispatch({ type: 'RESPONSE_CANCELLED', event });
      },
      onRunCompleted: (event: TalkRunCompletedEvent) => {
        if (event.talkId !== talkId) return;
        ensureKnownThread(event.threadId);
        // If MESSAGE_APPENDED never arrives for this run, the timeline
        // shows nothing for the response (RUN_COMPLETED deletes the
        // liveResponse buffer). Schedule a refetch fallback that fires
        // after a short grace window if the persisted message hasn't
        // landed yet. Scoped to the user's active thread — refetching
        // is a no-op otherwise, and the message arrives via
        // THREAD_MESSAGES_LOADING when they navigate back.
        if (
          event.threadId === activeThreadIdRef.current &&
          !persistedRunMessageIdsRef.current.has(event.runId)
        ) {
          const existingTimer = pendingMessageRefetchTimersRef.current.get(
            event.runId,
          );
          if (existingTimer) clearTimeout(existingTimer);
          const timer = setTimeout(() => {
            pendingMessageRefetchTimersRef.current.delete(event.runId);
            if (persistedRunMessageIdsRef.current.has(event.runId)) return;
            void resyncTalkState({ refreshThreads: false });
          }, MISSING_PERSISTED_MESSAGE_REFETCH_MS);
          pendingMessageRefetchTimersRef.current.set(event.runId, timer);
        }
        dispatch({
          type: 'RUN_COMPLETED',
          runId: event.runId,
          threadId: event.threadId,
          triggerMessageId: event.triggerMessageId,
          responseMessageId: event.responseMessageId,
          executorAlias: event.executorAlias,
          executorModel: event.executorModel,
          responseGroupId: event.responseGroupId,
          sequenceIndex: event.sequenceIndex,
        });
      },
      onRunFailed: (event: TalkRunFailedEvent) => {
        if (event.talkId !== talkId) return;
        ensureKnownThread(event.threadId);
        dispatch({
          type: 'RUN_FAILED',
          runId: event.runId,
          threadId: event.threadId,
          showInlineFailure: event.threadId === activeThreadIdRef.current,
          triggerMessageId: event.triggerMessageId,
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
          executorAlias: event.executorAlias,
          executorModel: event.executorModel,
          responseGroupId: event.responseGroupId,
          sequenceIndex: event.sequenceIndex,
        });
      },
      onRunCancelled: (event: TalkRunCancelledEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({
          type: 'RUN_CANCELLED_BATCH',
          runIds: event.runIds,
          cancelledBy: event.cancelledBy,
        });
      },
      onHistoryEdited: (event: TalkHistoryEditedEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadIds?.includes(activeThreadIdRef.current || '')) {
          rememberDeletedMessageIds(event.deletedMessageIds || []);
          void resyncTalkState({ refreshThreads: true });
          return;
        }
        scheduleThreadListRefresh();
      },
      onBrowserBlocked: (event: TalkBrowserBlockedEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadId) {
          ensureKnownThread(event.threadId);
        }
        if (event.threadId && event.threadId === activeThreadIdRef.current) {
          void resyncTalkState({ refreshThreads: true });
          return;
        }
        scheduleThreadListRefresh();
      },
      onBrowserUnblocked: (event: TalkBrowserUnblockedEvent) => {
        if (event.talkId !== talkId) return;
        if (event.threadId) {
          ensureKnownThread(event.threadId);
        }
        if (event.threadId && event.threadId === activeThreadIdRef.current) {
          void resyncTalkState({ refreshThreads: true });
          return;
        }
        scheduleThreadListRefresh();
      },
      onContentUpdated: (event: TalkContentUpdatedEvent) => {
        // Mark the snapshot stale across consumers; tab-local refetch
        // still happens inline so the editor reconciles right away.
        wsCacheRouterRef.current.scheduleInvalidate({ userId, talkId });
        // The DO scopes events to the current talk-room subscription, so
        // the contentId here always belongs to this Talk. Bail when the
        // user hasn't loaded the doc yet — no local version to compare.
        const current = talkContentRef.current;
        if (!current || current.id !== event.contentId) return;
        if (event.version <= current.bodyVersion) return;
        const status = talkContentSaveStatusRef.current;
        const hasUnsavedEdits =
          status === 'pending' || status === 'saving' || status === 'error';
        if (hasUnsavedEdits) {
          setTalkContentConflict(true);
          return;
        }
        void refetchTalkContent();
      },
      onContentEditRunStarted: (event: TalkContentEditRunStartedEvent) => {
        // No guard on talkContentRef — these events fire during the
        // tx that just created the row, so the local content state may
        // not have hydrated yet (sidebar-driven load races the
        // WebSocket arrival). Banner state is keyed on contentId so a
        // mismatched/stale ref doesn't corrupt anything; refetch fills
        // in the rest.
        setPendingEditStreamingByRunId((prev) => {
          if (prev.has(event.runId)) return prev;
          const next = new Map(prev);
          next.set(event.runId, event.agentNickname ?? null);
          return next;
        });
        pendingEditStreamingStartedAtRef.current.set(event.runId, Date.now());
        void refetchTalkContent();
      },
      onContentEditRunAborted: (event: TalkContentEditRunAbortedEvent) => {
        setPendingEditStreamingByRunId((prev) => {
          if (!prev.has(event.runId)) return prev;
          const next = new Map(prev);
          next.delete(event.runId);
          return next;
        });
        pendingEditStreamingStartedAtRef.current.delete(event.runId);
      },
      onContentEditApplied: (event: TalkContentEditAppliedEvent) => {
        wsCacheRouterRef.current.scheduleInvalidate({ userId, talkId });
        // Always refetch — the apply just created a pending row that
        // the UI must surface. The prior `current.id !== event.contentId`
        // guard caused a missed-update bug when the WebSocket event
        // arrived before talkContent had hydrated.
        setPendingEditStreamingByRunId((prev) => {
          if (!prev.has(event.runId)) return prev;
          const next = new Map(prev);
          next.delete(event.runId);
          return next;
        });
        pendingEditStreamingStartedAtRef.current.delete(event.runId);
        // First AI edit on an empty HTML doc auto-flips Source ➜
        // Preview so the user immediately sees the rendered result.
        // Sticky: each doc id only flips once per page mount.
        const cur = talkContentRef.current;
        if (
          cur &&
          cur.id === event.contentId &&
          cur.contentFormat === 'html' &&
          (cur.bodyHtml ?? '').length === 0 &&
          !htmlAutoFlippedRef.current.has(cur.id)
        ) {
          htmlAutoFlippedRef.current.add(cur.id);
          setHtmlMode('preview');
        }
        void refetchTalkContent();
      },
      onContentEditResolved: (event: TalkContentEditResolvedEvent) => {
        wsCacheRouterRef.current.scheduleInvalidate({ userId, talkId });
        setTalkContentPendingEdits((prev) =>
          prev.filter((edit) => !event.editIds.includes(edit.id)),
        );
        // Refetch in all cases so the banner / body reconcile against
        // the server-authoritative snapshot — including rejected runs
        // (the row went away, the cached state should reflect it).
        void refetchTalkContent();
      },
      onTalkToolsChanged: () => {
        wsCacheRouterRef.current.scheduleInvalidate({ userId, talkId });
        // Cross-tab sync: another tab toggled a tool chip. Bumping
        // refreshKey causes ToolChipsBar to refetch and reflect the
        // post-toggle active set. The event filter at
        // src/clawtalk/talks/event-filters.ts allowlists this event
        // for thread-scoped subscriptions (T7).
        setToolsRefreshKey((k) => k + 1);
      },
      onTalkRunRetrying: (event: TalkRunRetryingEvent) => {
        // CF Queues redelivered the run message — surface "Retrying
        // N/M" in the LiveResponsePanel pill so the user knows the
        // queue is alive and waiting (vs. the stale "Queued · 2:30"
        // badge that looked dead).
        dispatch({
          type: 'RUN_RETRYING',
          runId: event.runId,
          retryAttempt: event.retryAttempt,
          maxRetries: event.maxRetries,
        });
      },
      onReplayGap: async () => {
        await resyncTalkState({ refreshThreads: true });
      },
      onStateChange: (streamState) => {
        switch (streamState) {
          case 'connecting':
            dispatch({ type: 'STREAM_CONNECTING' });
            break;
          case 'live':
            // Coming back online (or first live tick on mount) — mark
            // every cached snapshot stale so any other open Talk pulls
            // the latest the next time it renders, and the active one
            // refetches immediately. Debounced so a reconnect replay
            // backlog collapses to one round-trip.
            wsCacheRouterRef.current.scheduleInvalidateAllSnapshots();
            dispatch({ type: 'STREAM_LIVE' });
            break;
          case 'reconnecting':
            dispatch({ type: 'STREAM_RECONNECTING' });
            break;
          case 'offline':
            dispatch({ type: 'STREAM_OFFLINE' });
            break;
          default:
            break;
        }
      },
    });

    return () => {
      stream.close();
      dispatch({ type: 'STREAM_OFFLINE' });
      for (const timer of pendingMessageRefetchTimersRef.current.values()) {
        clearTimeout(timer);
      }
      pendingMessageRefetchTimersRef.current.clear();
    };
  }, [
    bumpThreadSummaryFromMessage,
    ensureKnownThread,
    handleUnauthorized,
    isNearBottom,
    queryClient,
    refetchTalkContent,
    rememberDeletedMessageIds,
    resyncTalkState,
    scheduleThreadListRefresh,
    pageKind,
    talkId,
    userId,
  ]);

  useEffect(() => {
    if (pageKind !== 'ready') return;
    if (!autoStickToBottomRef.current) return;
    autoStickToBottomRef.current = false;
    scrollToBottom('smooth');
    dispatch({ type: 'CLEAR_UNREAD' });
    // Also depends on liveResponsesByRunId so the effect re-runs on
    // RESPONSE_STARTED (placeholder appears) and on each RESPONSE_DELTA
    // (text grows). The talkStream handlers re-set autoStickToBottomRef
    // every event if the user is still near the bottom, so this becomes
    // a continuous "stick" during streaming. If the user scrolls away,
    // nearBottom flips false, the handlers stop setting the ref, and
    // this effect skips the scroll until they scroll back down.
  }, [
    scrollToBottom,
    pageKind,
    pageMessages.length,
    state.liveResponsesByRunId,
  ]);

  const accessRole = pageKind === 'ready' ? pageTalk?.accessRole : null;
  const canEditAgents =
    accessRole === 'owner' || accessRole === 'admin' || accessRole === 'editor';
  const canEditJobs = canEditAgents;
  const canEditDoc = canEditAgents;

  const canManageTalkConnectors =
    accessRole === 'owner' || accessRole === 'admin';
  const canEditChannels = canEditAgents;
  const canBrowseChannelConnections = canManageTalkConnectors;
  const selectedJob = useMemo(
    () => talkJobs.find((job) => job.id === selectedJobId) ?? null,
    [selectedJobId, talkJobs],
  );
  const hasUnsavedJobChanges = useMemo(() => {
    if (creatingJob) {
      return Boolean(jobDraft.title.trim() || jobDraft.prompt.trim());
    }
    if (!selectedJob) return false;
    const original = buildJobDraftFromJob(selectedJob);
    return JSON.stringify(original) !== JSON.stringify(jobDraft);
  }, [creatingJob, jobDraft, selectedJob]);

  const configuredProviders = useMemo(
    () => getConfiguredProviders(aiAgentsData),
    [aiAgentsData],
  );
  const sourceOptions = useMemo(
    () => buildTalkAgentSourceOptions({ providers: configuredProviders }),
    [configuredProviders],
  );
  const newAgentModelOptions = useMemo(
    () =>
      getModelSuggestionsForSource({
        sourceKind: newAgentDraft.sourceKind,
        providerId: newAgentDraft.providerId,
        aiAgents: aiAgentsData,
      }),
    [aiAgentsData, newAgentDraft.providerId, newAgentDraft.sourceKind],
  );
  const hasUnsavedAgentChanges = useMemo(
    () => !haveSameTalkAgentDraftState(agents, agentDrafts),
    [agentDrafts, agents],
  );
  const hasPendingFooterAgentSelection =
    newAgentDraft.modelId.trim().length > 0;
  const effectiveAgents = hasUnsavedAgentChanges ? agentDrafts : agents;
  useEffect(() => {
    setTargetAgentIds((current) =>
      buildTargetSelection(effectiveAgents, current),
    );
  }, [effectiveAgents]);
  const registeredAgentsById = useMemo(
    () =>
      new Map(
        registeredAgentsCatalog.map((agent) => [agent.id, agent] as const),
      ),
    [registeredAgentsCatalog],
  );
  const talkAgentExecutionGuardrailsById = useMemo(
    () =>
      effectiveAgents.reduce<Record<string, TalkAgentExecutionGuardrail>>(
        (acc, agent) => {
          acc[agent.id] = buildTalkAgentExecutionGuardrail(
            agent,
            registeredAgentsById.get(agent.id),
          );
          return acc;
        },
        {},
      ),
    [effectiveAgents, registeredAgentsById],
  );
  const agentLabelById = useMemo(
    () =>
      effectiveAgents.reduce<Record<string, string>>((acc, agent) => {
        acc[agent.id] = buildAgentLabel(agent);
        return acc;
      }, {}),
    [effectiveAgents],
  );

  const orchestrationMode: TalkOrchestrationMode =
    pageKind === 'ready' && pageTalk ? pageTalk.orchestrationMode : 'ordered';
  const orchestrationModeLabel = getOrchestrationModeLabel(orchestrationMode);
  const showOrchestrationSelector = agents.length >= 2;
  useEffect(() => {
    if (showOrchestrationSelector && orchestrationState.status !== 'saving') {
      return;
    }
    setOrchestrationMenuOpen(false);
  }, [orchestrationState.status, showOrchestrationSelector]);
  useEffect(() => {
    if (!orchestrationMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (
        orchestrationMenuRef.current &&
        !orchestrationMenuRef.current.contains(event.target as Node)
      ) {
        setOrchestrationMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOrchestrationMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [orchestrationMenuOpen]);
  const selectedTargetAgents = useMemo(
    () => effectiveAgents.filter((agent) => targetAgentIds.includes(agent.id)),
    [effectiveAgents, targetAgentIds],
  );
  const selectedUnavailableAgents = useMemo(
    () =>
      selectedTargetAgents.filter(
        (agent) =>
          talkAgentExecutionGuardrailsById[agent.id]?.kind === 'unavailable',
      ),
    [selectedTargetAgents, talkAgentExecutionGuardrailsById],
  );
  const pendingImageAttachments = useMemo(
    () => pendingAttachments.filter((attachment) => attachment.isImage),
    [pendingAttachments],
  );
  const selectedNonVisionAgents = useMemo(
    () =>
      pendingImageAttachments.length === 0
        ? []
        : selectedTargetAgents.filter(
            (agent) =>
              !talkAgentSupportsVision(
                agent,
                registeredAgentsById.get(agent.id),
                aiAgentsData,
              ),
          ),
    [
      aiAgentsData,
      pendingImageAttachments.length,
      registeredAgentsById,
      selectedTargetAgents,
    ],
  );
  const composerGuardrailMessage = useMemo(() => {
    if (selectedUnavailableAgents.length > 0) {
      const labels = selectedUnavailableAgents.map((agent) =>
        buildAgentLabel(agent),
      );
      if (labels.length === 1) {
        const status =
          talkAgentExecutionGuardrailsById[selectedUnavailableAgents[0]!.id];
        return `${labels[0]} does not have a valid execution path right now. ${
          status?.message || 'Adjust the selected agents before sending.'
        }`;
      }
      return `${summarizeAgentLabels(labels)} do not currently have a valid execution path. Adjust the selected agents before sending.`;
    }

    if (selectedNonVisionAgents.length > 0) {
      const labels = selectedNonVisionAgents.map((agent) =>
        buildAgentLabel(agent),
      );
      if (labels.length === 1) {
        return `${labels[0]} does not support image attachments. Switch to a vision-capable model or remove the images before sending.`;
      }
      return `${summarizeAgentLabels(labels)} do not support image attachments. Switch to vision-capable models or remove the images before sending.`;
    }

    return null;
  }, [
    aiAgentsData,
    selectedNonVisionAgents,
    selectedUnavailableAgents,
    talkAgentExecutionGuardrailsById,
  ]);
  const selectedGuardrailAgentIds = useMemo(
    () =>
      new Set(
        [...selectedUnavailableAgents, ...selectedNonVisionAgents].map(
          (agent) => agent.id,
        ),
      ),
    [selectedNonVisionAgents, selectedUnavailableAgents],
  );
  const sendBlockedByGuardrail = Boolean(composerGuardrailMessage);
  const composerTargetHelp = useMemo(() => {
    if (selectedTargetAgents.length <= 1) {
      return 'Only the selected agent will respond.';
    }
    if (orchestrationMode === 'ordered') {
      return 'Selected agents will respond in order, with the final response synthesizing earlier perspectives.';
    }
    return 'Selected agents will each respond independently.';
  }, [orchestrationMode, selectedTargetAgents.length]);
  const messageLookup = useMemo(
    () =>
      new Map(pageMessages.map((message) => [message.id, message] as const)),
    [pageMessages],
  );
  const sortedThreads = useMemo(
    () => sortThreads(threadState.threads),
    [threadState.threads],
  );
  const activeThread = useMemo(
    () => sortedThreads.find((thread) => thread.id === activeThreadId) || null,
    [activeThreadId, sortedThreads],
  );
  const menuThread = useMemo(
    () =>
      threadMenu
        ? threadState.threads.find(
            (thread) => thread.id === threadMenu.threadId,
          ) || null
        : null,
    [threadMenu, threadState.threads],
  );
  const updateThreadMetadata = useCallback(
    async (
      threadId: string,
      patch: {
        title?: string;
        pinned?: boolean;
      },
    ) => {
      if (pageKind !== 'ready' || !pageTalk) {
        throw new Error('Talk not ready.');
      }
      try {
        const updated = await updateTalkThread({
          talkId: pageTalk.id,
          threadId,
          ...patch,
        });
        setThreadState((current) => ({
          ...current,
          error: null,
          threads: current.threads.map((thread) =>
            thread.id === updated.id
              ? {
                  ...thread,
                  title: updated.title,
                  isPinned: updated.isPinned,
                  updatedAt: updated.updatedAt,
                }
              : thread,
          ),
        }));
        return updated;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
        }
        throw err;
      }
    },
    [handleUnauthorized, state],
  );
  const handleRenameThread = useCallback(
    async (threadId: string, title: string) => {
      await updateThreadMetadata(threadId, { title });
      setEditingThreadId((current) => (current === threadId ? null : current));
    },
    [updateThreadMetadata],
  );
  const handleDeleteThread = useCallback(
    async (thread: TalkThread) => {
      if (pageKind !== 'ready' || !pageTalk) return;
      const confirmed = window.confirm(
        `Delete "${formatThreadLabel(thread)}"? This will permanently remove the thread and its messages.`,
      );
      if (!confirmed) return;
      try {
        await deleteTalkThread({
          talkId: pageTalk.id,
          threadId: thread.id,
        });
        // Garbage-collect this thread's doc-pane layout state so we
        // don't leave a stale localStorage record behind.
        if (typeof window !== 'undefined') {
          try {
            window.localStorage.removeItem(`clawtalk_doc_state:${thread.id}`);
          } catch {
            // Quota / private mode — ignore.
          }
        }
        clearThreadScroll(pageTalk.id, thread.id);
        const remaining = sortThreads(
          threadState.threads.filter((candidate) => candidate.id !== thread.id),
        );
        setThreadState((current) => ({
          ...current,
          error: null,
          threads: current.threads.filter(
            (candidate) => candidate.id !== thread.id,
          ),
        }));
        setEditingThreadId((current) =>
          current === thread.id ? null : current,
        );
        if (activeThreadId === thread.id) {
          const fallbackThreadId = remaining[0]?.id || null;
          if (fallbackThreadId) {
            navigate(buildThreadHref(talkId, fallbackThreadId, currentTab));
          }
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setThreadState((current) => ({
          ...current,
          error:
            err instanceof Error ? err.message : 'Failed to delete thread.',
        }));
      }
    },
    [
      activeThreadId,
      currentTab,
      handleUnauthorized,
      navigate,
      state,
      talkId,
      threadState.threads,
    ],
  );
  const handleRenameActiveThread = useCallback(
    async (title: string) => {
      if (!activeThread) return;
      await handleRenameThread(activeThread.id, title);
    },
    [activeThread, handleRenameThread],
  );
  const runHistory = useMemo(
    () =>
      Object.values(state.runsById).sort(
        (left, right) => right.updatedAt - left.updatedAt,
      ),
    [state.runsById],
  );
  // Set of runIds that already have a persisted assistant message in
  // pageMessages. Used to filter out orphan "Streaming…" placeholders
  // for runs whose final message already landed — happens when
  // MESSAGE_APPENDED reaches the SPA but the placeholder cleanup in the
  // reducer missed (e.g., older message rows without a runId, or stream
  // events arriving out of order across reconnects).
  const persistedMessageRunIds = useMemo(
    () =>
      new Set(
        pageMessages
          .map((message) => message.runId)
          .filter((id): id is string => Boolean(id)),
      ),
    [pageMessages],
  );
  const liveResponses = useMemo(
    () =>
      Object.values(state.liveResponsesByRunId)
        .filter((response) => !persistedMessageRunIds.has(response.runId))
        .sort((left, right) => left.startedAt - right.startedAt),
    [persistedMessageRunIds, state.liveResponsesByRunId],
  );
  useEffect(() => {
    if (currentTab !== 'runs') return;
    const runId = pendingRunHistoryScrollRef.current;
    if (!runId) return;
    const row = document.getElementById(`run-${runId}`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    pendingRunHistoryScrollRef.current = null;
  }, [currentTab, runHistory]);
  const orderedRunsByGroup = useMemo(
    () =>
      Object.values(state.runsById)
        .filter(
          (run) =>
            run.threadId === activeThreadId &&
            Boolean(run.responseGroupId) &&
            run.sequenceIndex != null,
        )
        .reduce<Record<string, RunView[]>>((acc, run) => {
          const groupId = run.responseGroupId!;
          (acc[groupId] ||= []).push(run);
          return acc;
        }, {}),
    [activeThreadId, state.runsById],
  );
  const orderedGroupSizesById = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(orderedRunsByGroup).map(([groupId, groupRuns]) => [
          groupId,
          groupRuns.length,
        ]),
      ),
    [orderedRunsByGroup],
  );
  const latestOrderedRound = useMemo<OrderedRoundSummary | null>(() => {
    const groupRuns = Object.values(orderedRunsByGroup)
      .filter((candidate) => candidate.length > 1)
      .sort((left, right) => {
        const leftAt = Math.max(...left.map((run) => run.updatedAt));
        const rightAt = Math.max(...right.map((run) => run.updatedAt));
        return rightAt - leftAt;
      })[0];
    if (!groupRuns) return null;

    const orderedGroupRuns = [...groupRuns].sort(
      (left, right) => (left.sequenceIndex ?? 0) - (right.sequenceIndex ?? 0),
    );
    const totalSteps = orderedGroupRuns.length;
    const currentRun =
      orderedGroupRuns.find((run) => run.status === 'running') ||
      orderedGroupRuns.find((run) => run.status === 'awaiting_confirmation') ||
      orderedGroupRuns.find((run) => run.status === 'queued');
    const completedCount = orderedGroupRuns.filter(
      (run) => run.status === 'completed',
    ).length;
    const failedRun = orderedGroupRuns.find((run) => run.status === 'failed');
    const failedSequenceIndex = failedRun?.sequenceIndex ?? null;
    const cancelledRun = orderedGroupRuns.find(
      (run) => run.status === 'cancelled',
    );
    const runsAfterFailure =
      failedSequenceIndex == null
        ? []
        : orderedGroupRuns.filter(
            (run) =>
              (run.sequenceIndex ?? Number.NEGATIVE_INFINITY) >
              failedSequenceIndex,
          );
    const continuedAfterFailure = runsAfterFailure.some(
      (run) =>
        run.status === 'queued' ||
        run.status === 'running' ||
        run.status === 'awaiting_confirmation' ||
        run.status === 'completed',
    );
    const allCompleted = orderedGroupRuns.every(
      (run) => run.status === 'completed',
    );

    let heading = 'Ordered round';
    if (currentRun) {
      heading = failedRun
        ? `Ordered round continuing after a failed step · ${completedCount} of ${totalSteps} finished`
        : `Ordered round in progress · ${completedCount} of ${totalSteps} finished`;
    } else if (failedRun && continuedAfterFailure) {
      heading = 'Ordered round finished with a failed step';
    } else if (failedRun) {
      heading = 'Ordered round failed';
    } else if (cancelledRun) {
      heading = 'Ordered round cancelled';
    } else if (allCompleted) {
      heading = 'Ordered round finished';
    }

    const currentLabel =
      currentRun &&
      (currentRun.targetAgentNickname ||
        (currentRun.targetAgentId
          ? agentLabelById[currentRun.targetAgentId]
          : null) ||
        state.liveResponsesByRunId[currentRun.id]?.agentNickname ||
        'Agent');
    const progressStatus =
      currentRun && currentRun.sequenceIndex != null
        ? currentRun.status === 'awaiting_confirmation'
          ? 'awaiting confirmation…'
          : currentRun.status === 'queued'
            ? 'queued…'
            : currentRun.sequenceIndex === totalSteps - 1
              ? 'synthesizing…'
              : 'responding…'
        : null;
    const progressLabel =
      currentRun && currentRun.sequenceIndex != null && currentLabel
        ? `Agent ${currentRun.sequenceIndex + 1} of ${totalSteps} · ${currentLabel} ${progressStatus}`
        : null;

    let note: string | null = null;
    if (failedRun) {
      const failedLabel =
        failedRun.targetAgentNickname ||
        (failedRun.targetAgentId
          ? agentLabelById[failedRun.targetAgentId]
          : null) ||
        'Agent';
      note = continuedAfterFailure
        ? `${failedLabel} failed, so later agents continued without using its unfinished output.`
        : `${failedLabel} failed. Open Run History for diagnostics.`;
    } else if (cancelledRun?.cancelReason === 'blocked_by_prior_failure') {
      note = 'Later agents were blocked after an earlier step failed.';
    } else if (allCompleted) {
      note =
        'Each agent in the latest ordered round finished and saved a response.';
    }

    return {
      heading,
      note,
      progressLabel,
      retryRunId:
        failedRun?.errorCode === 'incomplete_response' &&
        failedRun.targetAgentId &&
        failedRun.triggerMessageId
          ? failedRun.id
          : null,
      steps: orderedGroupRuns.map((run, index) => {
        const liveResponse = state.liveResponsesByRunId[run.id];
        const label =
          run.targetAgentNickname ||
          (run.targetAgentId ? agentLabelById[run.targetAgentId] : null) ||
          liveResponse?.agentNickname ||
          'Agent';
        return {
          runId: run.id,
          stepNumber: index + 1,
          label,
          statusLabel: getOrderedStepStatusLabel(run, totalSteps),
          tone: getOrderedStepTone(run),
          isCurrent: run.id === currentRun?.id,
          isSynthesis: index === totalSteps - 1,
        };
      }),
    };
  }, [agentLabelById, orderedRunsByGroup, state.liveResponsesByRunId]);
  const activeOrderedProgress = latestOrderedRound?.progressLabel
    ? { label: latestOrderedRound.progressLabel }
    : null;
  const talkTimeline = useMemo<TalkTimelineEntry[]>(
    () =>
      [
        ...pageMessages.map((message, index) => ({
          kind: 'message' as const,
          key: message.id,
          timestamp: Date.parse(message.createdAt) || 0,
          sortOrder: index,
          message,
        })),
        ...liveResponses.map((response, index) => {
          const run = state.runsById[response.runId];
          // Anchor on the trigger user message if known — keeps panels
          // visually below the user message even when run.createdAt is
          // microseconds earlier (runs are created before message_appended
          // is emitted inside enqueueTalkTurnAtomic).
          const triggerMessageId = run?.triggerMessageId ?? null;
          const triggerMessage = triggerMessageId
            ? pageMessages.find((m) => m.id === triggerMessageId)
            : undefined;
          const anchorTimestamp = Date.parse(
            triggerMessage?.createdAt || run?.startedAt || run?.createdAt || '',
          );
          return {
            kind: 'live-response' as const,
            key: response.runId,
            timestamp:
              Number.isFinite(anchorTimestamp) && anchorTimestamp > 0
                ? anchorTimestamp
                : response.queuedAt || response.startedAt,
            sortOrder: pageMessages.length + index,
            response,
          };
        }),
        ...Object.values(state.runsById)
          .filter(
            (run) =>
              run.threadId === activeThreadId &&
              run.status === 'awaiting_confirmation' &&
              Boolean(run.browserBlock),
          )
          .map((run, index) => {
            const updatedAt = Date.parse(
              run.browserBlock?.updatedAt || run.startedAt || run.createdAt,
            );
            return {
              kind: 'browser-run' as const,
              key: `browser-run-${run.id}`,
              timestamp:
                Number.isFinite(updatedAt) && updatedAt > 0
                  ? updatedAt
                  : Date.parse(run.createdAt) || 0,
              sortOrder: pageMessages.length + liveResponses.length + index,
              run,
            };
          }),
      ].sort(
        (left, right) =>
          left.timestamp - right.timestamp || left.sortOrder - right.sortOrder,
      ),
    [
      activeThreadId,
      liveResponses,
      orderedGroupSizesById,
      pageMessages,
      state.runsById,
    ],
  );
  const activeRound = useMemo(
    () =>
      Object.values(state.runsById).some(
        (run) =>
          run.threadId === activeThreadId &&
          (run.status === 'queued' ||
            run.status === 'running' ||
            run.status === 'awaiting_confirmation'),
      ),
    [activeThreadId, state.runsById],
  );
  // Per-second ticker for elapsed-time display in LiveResponsePanel.
  // Only runs while at least one run is non-terminal — idle when no active round.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!activeRound) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [activeRound]);
  // Dense mode: when ≥4 panels are queued/running with no visible content yet,
  // collapse all bodies to keep the timeline scannable. Flips off as soon as any
  // panel emits text or a progress message (all-or-nothing to avoid jitter).
  const isDenseRound = useMemo(
    () =>
      liveResponses.length >= 4 &&
      liveResponses.every(
        (r) => !r.text && !r.progressMessage && !r.terminalStatus,
      ),
    [liveResponses],
  );
  const canEditHistory = useMemo(
    () =>
      pageKind === 'ready' &&
      !activeRound &&
      pageMessages.some((message) => message.role !== 'system'),
    [activeRound, state],
  );
  const resolveMessageActorLabel = useCallback(
    (message: TalkMessage): string | null => {
      return (
        (message.agentId ? agentLabelById[message.agentId] : null) ||
        message.agentNickname ||
        null
      );
    },
    [agentLabelById],
  );
  const availableConnectors = useMemo(
    () =>
      orgConnectors.filter(
        (connector) =>
          connector.enabled &&
          connector.verificationStatus === 'verified' &&
          !talkConnectors.some((attached) => attached.id === connector.id),
      ),
    [orgConnectors, talkConnectors],
  );
  const availableChannelPlatforms = useMemo(
    () =>
      Array.from(
        new Set(channelConnections.map((connection) => connection.platform)),
      ),
    [channelConnections],
  );
  const selectedChannelPlatform = useMemo(
    () =>
      channelCreateDraft.platform &&
      availableChannelPlatforms.includes(channelCreateDraft.platform)
        ? channelCreateDraft.platform
        : availableChannelPlatforms[0] || '',
    [availableChannelPlatforms, channelCreateDraft.platform],
  );
  const selectedPlatformConnections = useMemo(
    () =>
      selectedChannelPlatform
        ? channelConnections.filter(
            (connection) => connection.platform === selectedChannelPlatform,
          )
        : ([] as ChannelConnection[]),
    [channelConnections, selectedChannelPlatform],
  );
  const selectedChannelConnection = useMemo(
    () =>
      selectedPlatformConnections.find(
        (connection) => connection.id === channelCreateDraft.connectionId,
      ) ||
      selectedPlatformConnections[0] ||
      null,
    [channelCreateDraft.connectionId, selectedPlatformConnections],
  );
  const selectedChannelTarget = useMemo(
    () =>
      channelTargetInventory.targets.find(
        (target) =>
          buildChannelTargetKey(target) === channelCreateDraft.targetKey,
      ) || null,
    [channelCreateDraft.targetKey, channelTargetInventory.targets],
  );
  const createInstructionTemplateOptions = useMemo(
    () => getInstructionTemplateOptions(selectedChannelPlatform),
    [selectedChannelPlatform],
  );
  const createInstructionLint = useMemo(
    () =>
      lintChannelInstructions({
        instructions: channelCreateDraft.instructions,
        stateNamespace: null,
        timezone: channelCreateDraft.timezone,
      }),
    [channelCreateDraft.instructions, channelCreateDraft.timezone],
  );
  const channelTargetOptions = useMemo(
    () =>
      channelTargetInventory.targets
        .map((target) => {
          const key = buildChannelTargetKey(target);
          const label = buildChannelTargetOptionLabel(
            target,
            channelConnections,
          );
          const metaLabel = buildChannelTargetOptionMetaLabel(
            target,
            channelConnections,
          );
          const connection =
            channelConnections.find(
              (candidate) => candidate.id === target.connectionId,
            ) || null;
          const occupiedByThisTalk = target.activeBindingTalkId === talkId;
          const occupiedByOtherTalk =
            Boolean(target.activeBindingTalkId) && !occupiedByThisTalk;
          const requiresInvite =
            connection?.platform === 'slack' &&
            readChannelTargetBooleanMetadata(target, 'isMember') === false;
          return {
            key,
            label,
            metaLabel,
            occupancyLabel: requiresInvite
              ? 'Invite app in Slack, then sync channels'
              : buildChannelTargetOccupancyLabel(target, talkId),
            occupiedByThisTalk,
            occupiedByOtherTalk,
            requiresInvite,
            openTalkHref:
              occupiedByOtherTalk &&
              target.activeBindingTalkAccessible &&
              target.activeBindingTalkId
                ? `/app/talks/${encodeURIComponent(target.activeBindingTalkId)}/channels`
                : null,
            target,
          };
        })
        .sort((left, right) => left.label.localeCompare(right.label)),
    [channelConnections, channelTargetInventory.targets, talkId],
  );
  const talkTabHref = `/app/talks/${talkId}`;
  const threadAwareTalkTabHref = activeThreadId
    ? buildThreadHref(talkId, activeThreadId)
    : talkTabHref;
  const agentsTabHref = activeThreadId
    ? buildThreadHref(talkId, activeThreadId, 'agents')
    : `/app/talks/${talkId}/agents`;
  const contextTabHref = activeThreadId
    ? buildThreadHref(talkId, activeThreadId, 'context')
    : `/app/talks/${talkId}/context`;
  const workspaceConnectorsTabHref = activeThreadId
    ? buildThreadHref(talkId, activeThreadId, 'connectors')
    : `/app/talks/${talkId}/connectors`;
  const runsTabHref = activeThreadId
    ? buildThreadHref(talkId, activeThreadId, 'runs')
    : `/app/talks/${talkId}/runs`;
  const manageAgentsHref = `/app/settings?tab=agents&returnTo=${encodeURIComponent(
    threadAwareTalkTabHref,
  )}`;
  const handleOpenRunHistory = useCallback(
    (runId: string) => {
      pendingRunHistoryScrollRef.current = runId;
      navigate(runsTabHref);
    },
    [navigate, runsTabHref],
  );
  const manageConnectorsHref = '/app/connectors';
  const isRenaming = renameDraft?.talkId === talkId;

  const reloadTalkChannels = useCallback(
    async (options?: { quiet?: boolean }) => {
      if (pageKind !== 'ready') return;
      if (!options?.quiet) {
        setChannelStatus((current) =>
          current.status === 'saving' ? current : { status: 'loading' },
        );
      }
      try {
        const [bindings, connections] = await Promise.all([
          listTalkChannels(talkId),
          canBrowseChannelConnections
            ? listChannelConnections()
            : Promise.resolve([] as ChannelConnection[]),
        ]);
        const failureEntries = await Promise.all(
          bindings.map(async (binding) => {
            const [ingress, delivery] = await Promise.all([
              listTalkChannelIngressFailures({
                talkId,
                bindingId: binding.id,
              }),
              listTalkChannelDeliveryFailures({
                talkId,
                bindingId: binding.id,
              }),
            ]);
            return [binding.id, { ingress, delivery }] as const;
          }),
        );
        setChannelBindings(bindings);
        setChannelDrafts(
          bindings.reduce<Record<string, ChannelBindingDraft>>(
            (acc, binding) => {
              acc[binding.id] = buildChannelBindingDraft(binding);
              return acc;
            },
            {},
          ),
        );
        setChannelBindingMemoryById((current) =>
          Object.fromEntries(
            bindings.map((binding) => [
              binding.id,
              current[binding.id] ??
                buildEmptyBindingMemoryPanelState(binding.stateNamespace),
            ]),
          ),
        );
        setChannelInstructionReviews((current) => ({
          [CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY]: current[
            CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY
          ] ?? {
            status: 'idle',
            review: null,
          },
          ...Object.fromEntries(
            bindings.map((binding) => [
              binding.id,
              current[binding.id] ?? { status: 'idle', review: null },
            ]),
          ),
        }));
        setChannelFailuresByBindingId(Object.fromEntries(failureEntries));
        setChannelConnections(connections);
        setChannelCreateDraft((current) => {
          const availablePlatforms = Array.from(
            new Set(connections.map((connection) => connection.platform)),
          );
          const nextPlatform =
            current.platform && availablePlatforms.includes(current.platform)
              ? current.platform
              : availablePlatforms[0] || '';
          const platformConnections = nextPlatform
            ? connections.filter(
                (connection) => connection.platform === nextPlatform,
              )
            : [];
          const nextConnectionId =
            platformConnections.find(
              (connection) => connection.id === current.connectionId,
            )?.id ||
            platformConnections[0]?.id ||
            '';
          const parsedTarget = current.targetKey
            ? parseChannelTargetKey(current.targetKey)
            : null;
          return {
            ...current,
            platform: nextPlatform,
            connectionId: nextConnectionId,
            template:
              nextPlatform === 'slack' || current.template === 'blank'
                ? current.template
                : 'blank',
            targetKey:
              parsedTarget?.connectionId === nextConnectionId
                ? current.targetKey
                : '',
          };
        });
        if (!options?.quiet) {
          setChannelStatus({ status: 'idle' });
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to load talk channels.',
        });
      }
    },
    [canBrowseChannelConnections, handleUnauthorized, pageKind, talkId],
  );

  // Load Talk context once so Rules badges and context surfaces stay hydrated.
  useEffect(() => {
    if (pageKind !== 'ready') return;
    if (contextLoaded) return;

    let cancelled = false;

    const loadContext = async () => {
      try {
        await refreshContext({
          hydrateGoalDraft: true,
          showLoading: currentTab === 'context',
        });
        if (cancelled) return;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (!cancelled) {
          setContextStatus({
            status: 'error',
            message:
              err instanceof Error ? err.message : 'Failed to load context.',
          });
        }
      }
    };

    void loadContext();
    return () => {
      cancelled = true;
    };
  }, [contextLoaded, currentTab, handleUnauthorized, refreshContext, pageKind]);

  useEffect(() => {
    if (pageKind !== 'ready' || currentTab !== 'context') {
      return;
    }

    void refreshTalkStateEntries({ showLoading: !talkStateLoaded });
  }, [currentTab, refreshTalkStateEntries, pageKind, talkStateLoaded]);

  useEffect(() => {
    if (pageKind !== 'ready' || currentTab !== 'context' || !contextLoaded) {
      return;
    }
    if (!contextSources.some((source) => source.status === 'pending')) {
      return;
    }

    let cancelled = false;
    const interval = window.setInterval(() => {
      void refreshContext().catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setContextStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to refresh saved source status.',
        });
      });
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    contextLoaded,
    contextSources,
    currentTab,
    handleUnauthorized,
    refreshContext,
    pageKind,
  ]);

  // Context handlers
  const handleSaveGoal = async () => {
    setContextStatus({ status: 'saving' });
    try {
      const result = await setTalkGoal({ talkId, goalText: goalDraft });
      setContextGoal(result.goal);
      setContextStatus({ status: 'success', message: 'Goal saved.' });
    } catch (err) {
      setContextStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to save goal.',
      });
    }
  };

  const handleAddRule = async () => {
    if (!newRuleText.trim()) return;
    setContextStatus({ status: 'saving' });
    try {
      const rule = await createTalkContextRule({
        talkId,
        ruleText: newRuleText.trim(),
      });
      setContextRules((prev) => sortRulesByOrder([...prev, rule]));
      setRuleDrafts((prev) => ({ ...prev, [rule.id]: rule.ruleText }));
      setNewRuleText('');
      setContextStatus({ status: 'idle' });
    } catch (err) {
      setContextStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to add rule.',
      });
    }
  };

  const handleToggleRule = async (rule: ContextRule) => {
    try {
      const updated = await patchTalkContextRule({
        talkId,
        ruleId: rule.id,
        isActive: !rule.isActive,
      });
      setContextRules((prev) =>
        sortRulesByOrder(prev.map((r) => (r.id === updated.id ? updated : r))),
      );
    } catch (err) {
      setContextStatus({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to update rule state.',
      });
    }
  };

  const handleSaveRuleText = async (rule: ContextRule) => {
    const draft = (ruleDrafts[rule.id] ?? rule.ruleText).trim();
    if (!draft) {
      setRuleDrafts((prev) => ({ ...prev, [rule.id]: rule.ruleText }));
      setContextStatus({
        status: 'error',
        message: 'Rule text is required.',
      });
      return;
    }
    if (draft === rule.ruleText) {
      return;
    }

    setContextStatus({ status: 'saving' });
    try {
      const updated = await patchTalkContextRule({
        talkId,
        ruleId: rule.id,
        ruleText: draft,
      });
      setContextRules((prev) =>
        sortRulesByOrder(
          prev.map((current) =>
            current.id === updated.id ? updated : current,
          ),
        ),
      );
      setRuleDrafts((prev) => ({ ...prev, [rule.id]: updated.ruleText }));
      setContextStatus({ status: 'success', message: 'Rule updated.' });
    } catch (err) {
      setContextStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to update rule.',
      });
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    try {
      await deleteTalkContextRule({ talkId, ruleId });
      setContextRules((prev) => prev.filter((r) => r.id !== ruleId));
      setRuleDrafts((prev) => {
        const next = { ...prev };
        delete next[ruleId];
        return next;
      });
    } catch (err) {
      setContextStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to delete rule.',
      });
    }
  };

  const handleRuleReorder = async (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || activeId === overId) {
      return;
    }

    const previousRules = orderedContextRules;
    const nextRules = reorderRules(previousRules, activeId, overId);
    if (nextRules === previousRules) {
      return;
    }

    const changedRules = nextRules.filter((rule, index) => {
      const previous = previousRules.find(
        (candidate) => candidate.id === rule.id,
      );
      return previous?.sortOrder !== index;
    });

    setContextRules(nextRules);
    setContextStatus({ status: 'saving' });

    try {
      await Promise.all(
        changedRules.map((rule, index) =>
          patchTalkContextRule({
            talkId,
            ruleId: rule.id,
            sortOrder: rule.sortOrder,
          }),
        ),
      );
      setContextStatus({ status: 'success', message: 'Rule order updated.' });
    } catch (err) {
      setContextRules(previousRules);
      setContextStatus({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to reorder rules.',
      });
    }
  };

  const handleCreateJobDraft = useCallback(() => {
    setCreatingJob(true);
    setSelectedJobId(null);
    setSelectedJobRuns([]);
    setSelectedJobRunsStatus({ status: 'idle' });
    setTalkJobsStatus({ status: 'idle' });
    setJobDraft(
      buildDefaultJobDraft({
        targetAgentId:
          agents.find((agent) => agent.isPrimary)?.id || agents[0]?.id,
      }),
    );
  }, [agents]);

  const handleSelectJob = useCallback(
    async (jobId: string) => {
      const job = talkJobs.find((candidate) => candidate.id === jobId);
      if (!job) return;
      setCreatingJob(false);
      setSelectedJobId(job.id);
      setJobDraft(buildJobDraftFromJob(job));
      try {
        await loadSelectedJobRuns(job.id, { showLoading: true });
        setTalkJobsStatus({ status: 'idle' });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setSelectedJobRunsStatus({
          status: 'error',
          message:
            err instanceof Error ? err.message : 'Failed to load job runs.',
        });
      }
    },
    [handleUnauthorized, loadSelectedJobRuns, talkJobs],
  );

  const handleToggleJobWeekday = useCallback((weekday: TalkJobWeekday) => {
    setJobDraft((current) => {
      const exists = current.weekdays.includes(weekday);
      return {
        ...current,
        weekdays: exists
          ? current.weekdays.filter((value) => value !== weekday)
          : [...current.weekdays, weekday],
      };
    });
  }, []);

  const handleToggleJobConnector = useCallback((connectorId: string) => {
    setJobDraft((current) => {
      const exists = current.connectorIds.includes(connectorId);
      return {
        ...current,
        connectorIds: exists
          ? current.connectorIds.filter((value) => value !== connectorId)
          : [...current.connectorIds, connectorId],
      };
    });
  }, []);

  const handleToggleJobChannelBinding = useCallback((bindingId: string) => {
    setJobDraft((current) => {
      const exists = current.channelBindingIds.includes(bindingId);
      return {
        ...current,
        channelBindingIds: exists
          ? current.channelBindingIds.filter((value) => value !== bindingId)
          : [...current.channelBindingIds, bindingId],
      };
    });
  }, []);

  const handleSaveJob = useCallback(async () => {
    if (!canEditJobs) return;
    if (!creatingJob && !selectedJob) return;

    setTalkJobsStatus({ status: 'saving' });
    try {
      const sourceScope = draftToTalkJobScope(jobDraft);
      const schedule = draftToTalkJobSchedule(jobDraft);

      const saved = creatingJob
        ? await createTalkJob({
            talkId,
            title: jobDraft.title,
            prompt: jobDraft.prompt,
            targetAgentId: jobDraft.targetAgentId,
            schedule,
            timezone: jobDraft.timezone,
            sourceScope,
          })
        : await patchTalkJob({
            talkId,
            jobId: selectedJob!.id,
            title: jobDraft.title,
            prompt: jobDraft.prompt,
            targetAgentId: jobDraft.targetAgentId,
            schedule,
            timezone: jobDraft.timezone,
            sourceScope,
          });

      await refreshTalkJobs({
        preferredJobId: saved.id,
        preserveSelection: true,
      });
      setTalkJobsStatus({
        status: 'success',
        message: creatingJob ? 'Job created.' : 'Job saved.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setTalkJobsStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to save job.',
      });
    }
  }, [
    canEditJobs,
    creatingJob,
    handleUnauthorized,
    jobDraft,
    refreshTalkJobs,
    selectedJob,
    talkId,
  ]);

  const handleDeleteJob = useCallback(async () => {
    if (!selectedJob || !canEditJobs) return;
    const confirmed = window.confirm(
      `Delete "${selectedJob.title}"? This cannot be undone.`,
    );
    if (!confirmed) return;

    setTalkJobsStatus({ status: 'saving' });
    try {
      await deleteTalkJob({ talkId, jobId: selectedJob.id });
      const remaining = talkJobs.filter((job) => job.id !== selectedJob.id);
      setTalkJobs(remaining);
      setTalkJobsLoaded(true);
      if (remaining.length > 0) {
        const next = remaining[0]!;
        setCreatingJob(false);
        setSelectedJobId(next.id);
        setJobDraft(buildJobDraftFromJob(next));
        await loadSelectedJobRuns(next.id, { showLoading: false });
      } else {
        setSelectedJobId(null);
        setSelectedJobRuns([]);
        setSelectedJobRunsStatus({ status: 'idle' });
        setCreatingJob(false);
        setJobDraft(
          buildDefaultJobDraft({
            targetAgentId:
              agents.find((agent) => agent.isPrimary)?.id || agents[0]?.id,
          }),
        );
      }
      setTalkJobsStatus({ status: 'success', message: 'Job deleted.' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setTalkJobsStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to delete job.',
      });
    }
  }, [
    agents,
    canEditJobs,
    handleUnauthorized,
    loadSelectedJobRuns,
    selectedJob,
    talkId,
    talkJobs,
  ]);

  const handlePauseJob = useCallback(async () => {
    if (!selectedJob || !canEditJobs) return;
    setTalkJobsStatus({ status: 'saving' });
    try {
      const paused = await pauseTalkJob({ talkId, jobId: selectedJob.id });
      setTalkJobs((current) =>
        current.map((job) => (job.id === paused.id ? paused : job)),
      );
      setTalkJobsStatus({ status: 'success', message: 'Job paused.' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setTalkJobsStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to pause job.',
      });
    }
  }, [canEditJobs, handleUnauthorized, selectedJob, talkId]);

  const handleResumeJob = useCallback(async () => {
    if (!selectedJob || !canEditJobs) return;
    setTalkJobsStatus({ status: 'saving' });
    try {
      const resumed = await resumeTalkJob({ talkId, jobId: selectedJob.id });
      setTalkJobs((current) =>
        current.map((job) => (job.id === resumed.id ? resumed : job)),
      );
      setTalkJobsStatus({ status: 'success', message: 'Job resumed.' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setTalkJobsStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to resume job.',
      });
    }
  }, [canEditJobs, handleUnauthorized, selectedJob, talkId]);

  const handleRunJobNow = useCallback(async () => {
    if (!selectedJob || !canEditJobs) return;
    setTalkJobsStatus({ status: 'saving' });
    try {
      const queued = await runTalkJobNow({ talkId, jobId: selectedJob.id });
      await refreshSelectedJobExecutionState(selectedJob.id);
      setTalkJobsStatus({ status: 'success', message: 'Job queued.' });

      void (async () => {
        const isTerminal = (status: TalkJobRunSummary['status']) =>
          status === 'completed' ||
          status === 'failed' ||
          status === 'cancelled';

        for (let attempt = 0; attempt < 15; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          try {
            const { runs } = await refreshSelectedJobExecutionState(
              selectedJob.id,
            );
            const latest =
              runs.find((run) => run.id === queued.runId) ?? runs[0] ?? null;
            if (!latest || !isTerminal(latest.status)) {
              continue;
            }
            if (selectedJob.threadId === activeThreadIdRef.current) {
              await resyncTalkState({ refreshThreads: true });
            }
            setTalkJobsStatus(
              latest.status === 'completed'
                ? { status: 'success', message: 'Job completed.' }
                : {
                    status: 'error',
                    message:
                      latest.errorMessage ||
                      latest.cancelReason ||
                      `Job ${latest.status}.`,
                  },
            );
            return;
          } catch (pollErr) {
            if (pollErr instanceof UnauthorizedError) {
              handleUnauthorized();
            }
            return;
          }
        }
      })();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setTalkJobsStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to queue job.',
      });
    }
  }, [
    canEditJobs,
    handleUnauthorized,
    refreshSelectedJobExecutionState,
    resyncTalkState,
    selectedJob,
    talkId,
  ]);

  const handleChannelDraftChange = useCallback(
    (bindingId: string, patch: Partial<ChannelBindingDraft>) => {
      setChannelDrafts((current) => ({
        ...current,
        [bindingId]: {
          ...current[bindingId],
          ...patch,
        },
      }));
      if (patch.instructions !== undefined) {
        setChannelInstructionReviews((current) => ({
          ...current,
          [bindingId]: {
            status: 'idle',
            review: null,
          },
        }));
      }
    },
    [],
  );

  const handleApplyChannelTemplate = useCallback(
    (binding: TalkChannelBinding, template: InstructionTemplateKey) => {
      const nextInstructions = buildInstructionTemplate(
        template,
        binding.stateNamespace,
      );
      const currentInstructions =
        channelDrafts[binding.id]?.instructions || binding.instructions || '';
      if (
        currentInstructions.trim().length > 0 &&
        currentInstructions.trim() !== nextInstructions.trim() &&
        !window.confirm(
          `Replace the current instructions for ${binding.displayName}?`,
        )
      ) {
        return;
      }
      handleChannelDraftChange(binding.id, {
        template,
        instructions: nextInstructions,
      });
    },
    [channelDrafts, handleChannelDraftChange],
  );

  const handleApplyCreateTemplate = useCallback(
    (template: InstructionTemplateKey) => {
      const nextInstructions = buildInstructionTemplate(template, null);
      setChannelCreateDraft((current) => {
        if (
          current.instructions.trim().length > 0 &&
          current.instructions.trim() !== nextInstructions.trim() &&
          !window.confirm('Replace the current draft instructions?')
        ) {
          return current;
        }
        return {
          ...current,
          template,
          instructions: nextInstructions,
        };
      });
      setChannelInstructionReviews((current) => ({
        ...current,
        [CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY]: {
          status: 'idle',
          review: null,
        },
      }));
    },
    [],
  );

  const handleLoadMoreChannelTargets = useCallback(async () => {
    if (
      !selectedChannelConnection ||
      channelTargetInventory.nextOffset == null
    ) {
      return;
    }
    setChannelTargetsLoading(true);
    try {
      const nextPage = await listChannelTargets({
        connectionId: selectedChannelConnection.id,
        query: channelTargetQuery.trim() || undefined,
        limit: selectedChannelPlatform === 'slack' ? 50 : 100,
        offset: channelTargetInventory.nextOffset,
        approval: selectedChannelPlatform === 'slack' ? 'all' : 'approved',
      });
      setChannelTargetInventory((current) => ({
        targets: [...current.targets, ...nextPage.targets],
        totalCount: nextPage.totalCount,
        hasMore: nextPage.hasMore,
        nextOffset: nextPage.nextOffset,
      }));
      setChannelStatus({ status: 'idle' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setChannelStatus({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to load more channel targets.',
      });
    } finally {
      setChannelTargetsLoading(false);
    }
  }, [
    channelTargetInventory.nextOffset,
    channelTargetQuery,
    handleUnauthorized,
    selectedChannelConnection,
    selectedChannelPlatform,
  ]);

  const handleSyncSelectedSlackWorkspace = useCallback(async () => {
    if (
      !canBrowseChannelConnections ||
      !selectedChannelConnection ||
      selectedChannelConnection.platform !== 'slack'
    ) {
      return;
    }

    const connectionId = selectedChannelConnection.id;
    const workspaceLabel = selectedChannelConnection.displayName;
    setChannelSyncingConnectionId(connectionId);
    setChannelStatus({ status: 'idle' });

    try {
      const result = await syncSlackWorkspace(connectionId);
      await reloadTalkChannels({ quiet: true });
      setChannelStatus({
        status: 'success',
        message: buildSlackWorkspaceSyncMessage(workspaceLabel, result),
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setChannelStatus({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to sync Slack channels.',
      });
    } finally {
      setChannelSyncingConnectionId((current) =>
        current === connectionId ? null : current,
      );
    }
  }, [
    canBrowseChannelConnections,
    handleUnauthorized,
    reloadTalkChannels,
    selectedChannelConnection,
  ]);

  const handleCreateChannel = useCallback(async () => {
    if (!canEditChannels) return;
    const parsedTarget = parseChannelTargetKey(channelCreateDraft.targetKey);
    if (!parsedTarget) {
      setChannelStatus({
        status: 'error',
        message:
          'Select a channel destination before creating a channel binding.',
      });
      return;
    }
    if (
      selectedChannelPlatform === 'slack' &&
      selectedChannelTarget &&
      readChannelTargetBooleanMetadata(selectedChannelTarget, 'isMember') ===
        false
    ) {
      setChannelStatus({
        status: 'error',
        message:
          'Invite the Slack app to this channel first, then sync channels again before binding it to this Talk.',
      });
      return;
    }
    setChannelStatus({ status: 'saving' });
    try {
      await createTalkChannel({
        talkId,
        connectionId: parsedTarget.connectionId,
        targetKind: parsedTarget.targetKind,
        targetId: parsedTarget.targetId,
        displayName:
          channelCreateDraft.displayName.trim() ||
          selectedChannelTarget?.displayName ||
          parsedTarget.targetId,
        responseMode: channelCreateDraft.responseMode,
        responderMode: channelCreateDraft.responderMode,
        responderAgentId:
          channelCreateDraft.responderMode === 'agent'
            ? channelCreateDraft.responderAgentId || null
            : null,
        deliveryMode: channelCreateDraft.deliveryMode,
        timezone: channelCreateDraft.timezone.trim() || null,
        instructions: channelCreateDraft.instructions.trim() || null,
        inboundRateLimitPerMinute:
          Number.parseInt(channelCreateDraft.inboundRateLimitPerMinute, 10) ||
          10,
        maxPendingEvents:
          Number.parseInt(channelCreateDraft.maxPendingEvents, 10) || 20,
        overflowPolicy: channelCreateDraft.overflowPolicy,
        maxDeferredAgeMinutes:
          Number.parseInt(channelCreateDraft.maxDeferredAgeMinutes, 10) || 10,
      });
      await reloadTalkChannels({ quiet: true });
      setChannelCreateDraft((current) => ({
        ...buildDefaultChannelCreateDraft(),
        platform: current.platform,
        connectionId: parsedTarget.connectionId,
      }));
      setChannelStatus({
        status: 'success',
        message: 'Talk channel binding created.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setChannelStatus({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to create talk channel binding.',
      });
    }
  }, [
    canEditChannels,
    channelCreateDraft,
    handleUnauthorized,
    reloadTalkChannels,
    selectedChannelTarget?.displayName,
    talkId,
  ]);

  const handleSaveChannelBinding = useCallback(
    async (binding: TalkChannelBinding) => {
      if (!canEditChannels) return;
      const draft = channelDrafts[binding.id];
      if (!draft) return;
      setChannelStatus({ status: 'saving' });
      try {
        await patchTalkChannel({
          talkId,
          bindingId: binding.id,
          active: draft.active,
          displayName: draft.displayName.trim() || binding.displayName,
          responseMode: draft.responseMode,
          responderMode: draft.responderMode,
          responderAgentId:
            draft.responderMode === 'agent'
              ? draft.responderAgentId || null
              : null,
          deliveryMode: draft.deliveryMode,
          timezone: draft.timezone.trim() || null,
          instructions: draft.instructions.trim() || null,
          inboundRateLimitPerMinute:
            Number.parseInt(draft.inboundRateLimitPerMinute, 10) ||
            binding.inboundRateLimitPerMinute,
          maxPendingEvents:
            Number.parseInt(draft.maxPendingEvents, 10) ||
            binding.maxPendingEvents,
          overflowPolicy: draft.overflowPolicy,
          maxDeferredAgeMinutes:
            Number.parseInt(draft.maxDeferredAgeMinutes, 10) ||
            binding.maxDeferredAgeMinutes,
        });
        await reloadTalkChannels({ quiet: true });
        setChannelStatus({
          status: 'success',
          message: `Saved channel settings for ${binding.displayName}.`,
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to save talk channel settings.',
        });
      }
    },
    [
      canEditChannels,
      channelDrafts,
      handleUnauthorized,
      reloadTalkChannels,
      talkId,
    ],
  );

  const handleLoadChannelBindingMemory = useCallback(
    async (binding: TalkChannelBinding, force = false) => {
      const current = channelBindingMemoryById[binding.id];
      if (
        !force &&
        current &&
        (current.status === 'loading' || current.status === 'ready')
      ) {
        return;
      }
      setChannelBindingMemoryById((state) => ({
        ...state,
        [binding.id]: {
          ...(state[binding.id] ??
            buildEmptyBindingMemoryPanelState(binding.stateNamespace)),
          status: 'loading',
          errorMessage: undefined,
          stateNamespace: binding.stateNamespace,
        },
      }));
      try {
        const result = await listTalkChannelBindingState({
          talkId,
          bindingId: binding.id,
        });
        setChannelBindingMemoryById((state) => ({
          ...state,
          [binding.id]: {
            ...(state[binding.id] ??
              buildEmptyBindingMemoryPanelState(result.stateNamespace)),
            status: 'ready',
            stateNamespace: result.stateNamespace,
            entries: result.entries,
            errorMessage: undefined,
          },
        }));
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelBindingMemoryById((state) => ({
          ...state,
          [binding.id]: {
            ...(state[binding.id] ??
              buildEmptyBindingMemoryPanelState(binding.stateNamespace)),
            status: 'error',
            errorMessage:
              err instanceof Error
                ? err.message
                : 'Failed to load binding memory.',
          },
        }));
      }
    },
    [channelBindingMemoryById, handleUnauthorized, talkId],
  );

  const handleChannelBindingMemoryDraftChange = useCallback(
    (
      bindingId: string,
      patch: Partial<
        Pick<BindingMemoryPanelState, 'newKeySuffix' | 'newValueJson'>
      >,
    ) => {
      setChannelBindingMemoryById((state) => ({
        ...state,
        [bindingId]: {
          ...state[bindingId],
          ...patch,
        },
      }));
    },
    [],
  );

  const handleCreateChannelBindingMemoryEntry = useCallback(
    async (binding: TalkChannelBinding) => {
      if (!canEditChannels) return;
      const panel =
        channelBindingMemoryById[binding.id] ??
        buildEmptyBindingMemoryPanelState(binding.stateNamespace);
      const keySuffix = panel.newKeySuffix.trim();
      if (!keySuffix) {
        setChannelStatus({
          status: 'error',
          message: 'Enter a key suffix before saving binding memory.',
        });
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(panel.newValueJson);
      } catch {
        setChannelStatus({
          status: 'error',
          message: 'Binding memory values must be valid JSON.',
        });
        return;
      }

      setChannelBindingMemoryById((state) => ({
        ...state,
        [binding.id]: {
          ...panel,
          status: 'saving',
          errorMessage: undefined,
        },
      }));
      try {
        await upsertTalkChannelBindingState({
          talkId,
          bindingId: binding.id,
          keySuffix,
          value,
          expectedVersion: 0,
        });
        await handleLoadChannelBindingMemory(binding, true);
        setChannelBindingMemoryById((state) => ({
          ...state,
          [binding.id]: {
            ...(state[binding.id] ??
              buildEmptyBindingMemoryPanelState(binding.stateNamespace)),
            status: 'ready',
            stateNamespace: binding.stateNamespace,
            newKeySuffix: '',
            newValueJson: '{\n  \n}',
            entries: state[binding.id]?.entries ?? [],
          },
        }));
        setChannelStatus({
          status: 'success',
          message: `Added binding memory entry for ${binding.displayName}.`,
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelBindingMemoryById((state) => ({
          ...state,
          [binding.id]: {
            ...(state[binding.id] ??
              buildEmptyBindingMemoryPanelState(binding.stateNamespace)),
            status: 'error',
            errorMessage:
              err instanceof Error
                ? err.message
                : 'Failed to save binding memory.',
          },
        }));
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to save binding memory.',
        });
      }
    },
    [
      canEditChannels,
      channelBindingMemoryById,
      handleLoadChannelBindingMemory,
      handleUnauthorized,
      talkId,
    ],
  );

  const handleEditChannelBindingMemoryEntry = useCallback(
    async (
      binding: TalkChannelBinding,
      entry: TalkChannelBindingStateEntry,
    ) => {
      if (!canEditChannels) return;
      const nextValueJson = window.prompt(
        `Edit JSON for ${entry.keySuffix}:`,
        formatJsonForStateEditor(entry.value),
      );
      if (nextValueJson == null) return;
      let value: unknown;
      try {
        value = JSON.parse(nextValueJson);
      } catch {
        setChannelStatus({
          status: 'error',
          message: 'Binding memory values must be valid JSON.',
        });
        return;
      }
      setChannelBindingMemoryById((state) => ({
        ...state,
        [binding.id]: {
          ...(state[binding.id] ??
            buildEmptyBindingMemoryPanelState(binding.stateNamespace)),
          status: 'saving',
          stateNamespace: binding.stateNamespace,
          entries: state[binding.id]?.entries ?? [],
        },
      }));
      try {
        await upsertTalkChannelBindingState({
          talkId,
          bindingId: binding.id,
          keySuffix: entry.keySuffix,
          value,
          expectedVersion: entry.version,
        });
        await handleLoadChannelBindingMemory(binding, true);
        setChannelStatus({
          status: 'success',
          message: `Updated ${entry.keySuffix}.`,
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to update binding memory.',
        });
        setChannelBindingMemoryById((state) => ({
          ...state,
          [binding.id]: {
            ...(state[binding.id] ??
              buildEmptyBindingMemoryPanelState(binding.stateNamespace)),
            status: 'error',
            errorMessage:
              err instanceof Error
                ? err.message
                : 'Failed to update binding memory.',
          },
        }));
      }
    },
    [
      canEditChannels,
      handleLoadChannelBindingMemory,
      handleUnauthorized,
      talkId,
    ],
  );

  const handleDeleteChannelBindingMemoryEntry = useCallback(
    async (
      binding: TalkChannelBinding,
      entry: TalkChannelBindingStateEntry,
    ) => {
      if (!canEditChannels) return;
      const confirmed = window.confirm(
        `Delete binding memory entry ${entry.keySuffix}?`,
      );
      if (!confirmed) return;
      setChannelBindingMemoryById((state) => ({
        ...state,
        [binding.id]: {
          ...(state[binding.id] ??
            buildEmptyBindingMemoryPanelState(binding.stateNamespace)),
          status: 'saving',
          stateNamespace: binding.stateNamespace,
          entries: state[binding.id]?.entries ?? [],
        },
      }));
      try {
        await deleteTalkChannelBindingState({
          talkId,
          bindingId: binding.id,
          keySuffix: entry.keySuffix,
          expectedVersion: entry.version,
        });
        await handleLoadChannelBindingMemory(binding, true);
        setChannelStatus({
          status: 'success',
          message: `Deleted ${entry.keySuffix}.`,
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to delete binding memory.',
        });
        setChannelBindingMemoryById((state) => ({
          ...state,
          [binding.id]: {
            ...(state[binding.id] ??
              buildEmptyBindingMemoryPanelState(binding.stateNamespace)),
            status: 'error',
            errorMessage:
              err instanceof Error
                ? err.message
                : 'Failed to delete binding memory.',
          },
        }));
      }
    },
    [
      canEditChannels,
      handleLoadChannelBindingMemory,
      handleUnauthorized,
      talkId,
    ],
  );

  const handleReviewBindingInstructions = useCallback(
    async (input: {
      reviewKey: string;
      platform: 'slack' | 'telegram';
      instructions: string;
      bindingId?: string | null;
      bindingLabel?: string | null;
      timezone?: string | null;
    }) => {
      if (!canEditChannels) return;
      if (input.instructions.trim().length === 0) {
        setChannelStatus({
          status: 'error',
          message: 'Enter instructions before requesting a review.',
        });
        return;
      }
      setChannelInstructionReviews((current) => ({
        ...current,
        [input.reviewKey]: { status: 'reviewing', review: null },
      }));
      try {
        const review = await reviewTalkChannelInstructions({
          talkId,
          platform: input.platform,
          instructions: input.instructions,
          bindingId: input.bindingId ?? null,
          bindingLabel: input.bindingLabel ?? null,
          timezone: input.timezone ?? null,
        });
        setChannelInstructionReviews((current) => ({
          ...current,
          [input.reviewKey]: {
            status: 'ready',
            review,
          },
        }));
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelInstructionReviews((current) => ({
          ...current,
          [input.reviewKey]: {
            status: 'error',
            review: null,
            message:
              err instanceof Error
                ? err.message
                : 'Failed to review channel instructions.',
          },
        }));
      }
    },
    [canEditChannels, handleUnauthorized, talkId],
  );

  const handleDeleteChannelBinding = useCallback(
    async (binding: TalkChannelBinding) => {
      if (!canEditChannels) return;
      const confirmed = window.confirm(
        `Delete the channel binding for ${binding.displayName}?`,
      );
      if (!confirmed) return;
      setChannelStatus({ status: 'saving' });
      try {
        await deleteTalkChannel({
          talkId,
          bindingId: binding.id,
        });
        await reloadTalkChannels({ quiet: true });
        setChannelStatus({
          status: 'success',
          message: `Deleted channel binding for ${binding.displayName}.`,
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to delete talk channel binding.',
        });
      }
    },
    [canEditChannels, handleUnauthorized, reloadTalkChannels, talkId],
  );

  const handleTestChannel = useCallback(
    async (
      binding: TalkChannelBinding,
      location: 'diagnosis' | 'footer' = 'footer',
    ) => {
      if (!canEditChannels) return;
      setChannelStatus({ status: 'saving', message: 'Sending test…' });
      setChannelTestStatus({
        bindingId: binding.id,
        status: 'sending',
        message: 'Sending test…',
        location,
      });
      try {
        await testTalkChannelBinding({
          talkId,
          bindingId: binding.id,
        });
        await reloadTalkChannels({ quiet: true });
        setChannelStatus({
          status: 'success',
          message: `Sent a test message to ${binding.displayName}.`,
        });
        setChannelTestStatus({
          bindingId: binding.id,
          status: 'success',
          message: `Sent a test message to ${binding.displayName}.`,
          location,
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        const message =
          err instanceof Error
            ? err.message
            : 'Failed to send test channel message.';
        setChannelStatus({
          status: 'error',
          message,
        });
        setChannelTestStatus({
          bindingId: binding.id,
          status: 'error',
          message,
          location,
        });
      }
    },
    [canEditChannels, handleUnauthorized, reloadTalkChannels, talkId],
  );

  const handleRetryIngressFailure = useCallback(
    async (bindingId: string, rowId: string) => {
      setChannelStatus({ status: 'saving' });
      try {
        await retryTalkChannelIngressFailure({ talkId, bindingId, rowId });
        await reloadTalkChannels({ quiet: true });
        setChannelStatus({
          status: 'success',
          message: 'Ingress failure retried.',
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to retry ingress failure.',
        });
      }
    },
    [handleUnauthorized, reloadTalkChannels, talkId],
  );

  const handleDismissIngressFailure = useCallback(
    async (bindingId: string, rowId: string) => {
      setChannelStatus({ status: 'saving' });
      try {
        await deleteTalkChannelIngressFailure({ talkId, bindingId, rowId });
        await reloadTalkChannels({ quiet: true });
        setChannelStatus({
          status: 'success',
          message: 'Ingress failure dismissed.',
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to dismiss ingress failure.',
        });
      }
    },
    [handleUnauthorized, reloadTalkChannels, talkId],
  );

  const handleRetryDeliveryFailure = useCallback(
    async (bindingId: string, rowId: string) => {
      setChannelStatus({ status: 'saving' });
      try {
        await retryTalkChannelDeliveryFailure({ talkId, bindingId, rowId });
        await reloadTalkChannels({ quiet: true });
        setChannelStatus({
          status: 'success',
          message: 'Delivery failure retried.',
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to retry delivery failure.',
        });
      }
    },
    [handleUnauthorized, reloadTalkChannels, talkId],
  );

  const handleDismissDeliveryFailure = useCallback(
    async (bindingId: string, rowId: string) => {
      setChannelStatus({ status: 'saving' });
      try {
        await deleteTalkChannelDeliveryFailure({ talkId, bindingId, rowId });
        await reloadTalkChannels({ quiet: true });
        setChannelStatus({
          status: 'success',
          message: 'Delivery failure dismissed.',
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to dismiss delivery failure.',
        });
      }
    },
    [handleUnauthorized, reloadTalkChannels, talkId],
  );

  const openHistoryEditor = useCallback(() => {
    if (pageKind !== 'ready') return;
    if (activeRound) {
      setHistoryEditState({
        status: 'error',
        message:
          'Wait for the current round to finish or cancel it before editing history.',
      });
      return;
    }
    if (!pageMessages.some((message) => message.role !== 'system')) {
      setHistoryEditState({
        status: 'error',
        message: 'There are no editable messages in this Talk yet.',
      });
      return;
    }
    setHistoryEditState({ status: 'idle' });
    setHistoryEditorOpen(true);
  }, [activeRound, state]);

  const handleCloseHistoryEditor = useCallback(() => {
    if (historyEditState.status === 'saving') return;
    setHistoryEditorOpen(false);
    setHistoryEditState((current) =>
      current.status === 'success' ? current : { status: 'idle' },
    );
  }, [historyEditState.status]);

  const handleDeleteHistoryMessages = useCallback(
    async (messageIds: string[]) => {
      if (pageKind !== 'ready' || !pageTalk) return;
      const threadId = activeThreadId;
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
        } from this Talk history?`,
      );
      if (!confirmed) return;

      setHistoryEditState({ status: 'saving' });
      try {
        const result = await deleteTalkMessages({
          talkId: pageTalk.id,
          messageIds,
          threadId,
        });
        threadSnapshotVersionRef.current += 1;
        rememberDeletedMessageIds(result.deletedMessageIds);
        await resyncTalkState({ refreshThreads: true });
        setHistoryEditorOpen(false);
        setHistoryEditState({
          status: 'success',
          message: `Deleted ${result.deletedCount} message${
            result.deletedCount === 1 ? '' : 's'
          } from this Talk history.`,
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (err instanceof ApiError && err.code === 'message_not_found') {
          threadSnapshotVersionRef.current += 1;
          rememberDeletedMessageIds(messageIds);
          void resyncTalkState({ refreshThreads: true });
        }
        setHistoryEditState({
          status: 'error',
          message:
            err instanceof Error ? err.message : 'Unable to edit Talk history.',
        });
      }
    },
    [
      activeThreadId,
      handleUnauthorized,
      rememberDeletedMessageIds,
      resyncTalkState,
      state,
    ],
  );

  const mentionFilter = useMemo(() => {
    if (!mentionState) return '';
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? draft.length;
    const between = draft.slice(mentionState.atIndex + 1, cursor);
    // The filter is only the word characters / hyphens immediately
    // after `@`. Any whitespace ends the filter (and the mention).
    if (/\s/.test(between)) return between.split(/\s/)[0] ?? '';
    return between;
  }, [draft, mentionState]);

  const mentionOptions = useMemo(
    () =>
      buildSourceMentionOptions({
        sources: contextSources,
        filter: mentionFilter,
        contentTitle: talkContent ? talkContent.title : null,
      }),
    [contextSources, mentionFilter, talkContent],
  );

  // Keep the highlighted index inside the valid range as the filter
  // text shrinks/grows the option list. When options become empty we
  // dismiss the picker so the user sees their literal `@filter` text.
  useEffect(() => {
    if (!mentionState) return;
    if (mentionOptions.length === 0) {
      setMentionState(null);
      return;
    }
    if (mentionState.selectedIndex >= mentionOptions.length) {
      setMentionState({
        atIndex: mentionState.atIndex,
        selectedIndex: 0,
      });
    }
  }, [mentionOptions.length, mentionState]);

  const insertMentionOption = useCallback(
    (option: SourceMentionOption) => {
      if (!mentionState) return;
      const ta = textareaRef.current;
      const cursor = ta?.selectionStart ?? draft.length;
      const before = draft.slice(0, mentionState.atIndex);
      // Everything from `@` through the cursor (including the filter
      // chars the user typed) is replaced by the canonical insertion.
      const after = draft.slice(cursor);
      const inserted = option.insertion;
      const next = before + inserted + after;
      setDraft(next);
      setMentionState(null);
      requestAnimationFrame(() => {
        const taNow = textareaRef.current;
        if (!taNow) return;
        taNow.focus();
        const nextCursor = before.length + inserted.length;
        taNow.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [draft, mentionState],
  );

  const handleDraftChange = (value: string) => {
    setDraft(value);
    if (pageKind === 'ready' && state.sendState.status === 'error') {
      dispatch({ type: 'SEND_CLEARED' });
    }
    // `@` trigger: open the mention picker when the user types `@` at a
    // word boundary AND the Talk has either an attached doc or at least
    // one ready saved source. The literal `@` stays in the textarea;
    // selection replaces the `@filter` slice with the canonical token.
    const hasMentionable =
      !!talkContent ||
      contextSources.some((source) => source.status === 'ready');
    if (hasMentionable) {
      const ta = textareaRef.current;
      const pos = ta?.selectionStart ?? value.length;
      const atIndex = pos - 1;
      if (atIndex >= 0 && value[atIndex] === '@') {
        const prev = atIndex > 0 ? value[atIndex - 1] : '';
        const atWordBoundary = atIndex === 0 || /\s/.test(prev);
        if (atWordBoundary) {
          setMentionState({ atIndex, selectedIndex: 0 });
          return;
        }
      }
    }
    // Dismiss the picker if the cursor moved past the `@<filter>` span
    // (e.g. the user inserted a space or backspaced over the `@`).
    if (mentionState) {
      const ta = textareaRef.current;
      const cursor = ta?.selectionStart ?? value.length;
      if (
        cursor <= mentionState.atIndex ||
        value[mentionState.atIndex] !== '@'
      ) {
        setMentionState(null);
      }
    }
  };

  const resizeComposerTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const scrollHeight = Math.max(
      textarea.scrollHeight,
      COMPOSER_TEXTAREA_MIN_HEIGHT_PX,
    );
    const nextHeight = Math.min(scrollHeight, COMPOSER_TEXTAREA_MAX_HEIGHT_PX);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      scrollHeight > COMPOSER_TEXTAREA_MAX_HEIGHT_PX ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeComposerTextarea();
  }, [activeThreadId, currentTab, draft, resizeComposerTextarea, pageKind]);

  const ALLOWED_ATTACHMENT_EXTENSIONS =
    '.txt,.md,.csv,.html,.rtf,' +
    '.json,.xml,.yaml,.yml,.py,.js,.ts,.jsx,.tsx,.java,.c,.h,.cpp,.hpp,.go,.rs,.sh,.bash,.sql,.rb,.php,.swift,.kt,.lua,.r,.toml,.ini,.cfg,.env,.log,' +
    '.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.webp';
  const ALLOWED_ATTACHMENT_MIMES = new Set([
    // Text-based (existing)
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/html',
    // NEW: RTF
    'text/rtf',
    'application/rtf',
    // NEW: Code / structured data (treated as plain text)
    'text/xml',
    'application/json',
    'application/xml',
    'text/yaml',
    'text/x-yaml',
    'application/x-yaml',
    'text/x-python',
    'text/x-java',
    'text/javascript',
    'application/javascript',
    'text/typescript',
    'text/x-c',
    'text/x-c++',
    'text/x-go',
    'text/x-rust',
    'text/x-shellscript',
    'text/x-sql',
    // Documents (existing + PPTX)
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/png',
    'image/jpeg',
    'image/webp',
  ]);
  const IMAGE_ATTACHMENT_MIMES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
  ]);
  const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
  const MAX_IMAGE_ATTACHMENT_SIZE = 5 * 1024 * 1024;
  const MAX_ATTACHMENTS_PER_MESSAGE = 5;
  const MAX_IMAGE_ATTACHMENTS_PER_MESSAGE = 3;

  const inferAttachmentMimeType = (file: File): string => {
    if (ALLOWED_ATTACHMENT_MIMES.has(file.type)) {
      return file.type;
    }
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith('.png')) return 'image/png';
    if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
      return 'image/jpeg';
    }
    if (lowerName.endsWith('.webp')) return 'image/webp';
    return file.type;
  };

  const handleFilesSelected = async (files: FileList | File[]) => {
    if (!pageTalk) return;
    const fileArray = Array.from(files);
    const currentCount = pendingAttachments.length;
    if (currentCount + fileArray.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      dispatch({
        type: 'SEND_FAILED',
        message: `You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`,
        lastDraft: draft,
      });
      return;
    }

    const currentImageCount = pendingAttachments.filter(
      (attachment) => attachment.isImage,
    ).length;
    const incomingImageCount = fileArray.filter((file) =>
      IMAGE_ATTACHMENT_MIMES.has(inferAttachmentMimeType(file)),
    ).length;
    if (
      currentImageCount + incomingImageCount >
      MAX_IMAGE_ATTACHMENTS_PER_MESSAGE
    ) {
      dispatch({
        type: 'SEND_FAILED',
        message: `You can attach up to ${MAX_IMAGE_ATTACHMENTS_PER_MESSAGE} images per message.`,
        lastDraft: draft,
      });
      return;
    }

    for (const file of fileArray) {
      const mimeType = inferAttachmentMimeType(file);
      const isImage = IMAGE_ATTACHMENT_MIMES.has(mimeType);

      if (!ALLOWED_ATTACHMENT_MIMES.has(mimeType) && file.type !== '') {
        dispatch({
          type: 'SEND_FAILED',
          message: `File type "${file.type}" is not supported. Supported: text, markdown, CSV, HTML, RTF, PDF, DOCX, XLSX, PPTX, PNG, JPEG, WEBP, and common code/config files.`,
          lastDraft: draft,
        });
        continue;
      }
      const maxSize = isImage ? MAX_IMAGE_ATTACHMENT_SIZE : MAX_ATTACHMENT_SIZE;
      if (file.size > maxSize) {
        dispatch({
          type: 'SEND_FAILED',
          message: `"${file.name}" exceeds the ${maxSize / (1024 * 1024)} MB size limit.`,
          lastDraft: draft,
        });
        continue;
      }

      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
      setPendingAttachments((prev) => [
        ...prev,
        {
          localId,
          file,
          fileName: file.name,
          fileSize: file.size,
          mimeType,
          isImage,
          previewUrl,
          status: 'uploading',
        },
      ]);

      try {
        const result = await uploadTalkAttachment(pageTalk!.id, file);
        setPendingAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId
              ? {
                  ...a,
                  status: 'ready' as const,
                  attachmentId: result.attachment.id,
                }
              : a,
          ),
        );
      } catch (err) {
        setPendingAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId
              ? {
                  ...a,
                  status: 'error' as const,
                  errorMessage:
                    err instanceof Error ? err.message : 'Upload failed',
                }
              : a,
          ),
        );
      }
    }
  };

  const handleRemoveAttachment = (localId: string) => {
    setPendingAttachments((prev) => {
      const next: typeof prev = [];
      for (const attachment of prev) {
        if (attachment.localId === localId) {
          if (attachment.previewUrl) {
            URL.revokeObjectURL(attachment.previewUrl);
          }
          continue;
        }
        next.push(attachment);
      }
      return next;
    });
  };

  const handleAttachButtonClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    if (event.target.files && event.target.files.length > 0) {
      void handleFilesSelected(event.target.files);
      event.target.value = '';
    }
  };

  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  const handleDragEnter = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current += 1;
    if (hasFileTransfer(event.dataTransfer)) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (hasFileTransfer(event.dataTransfer)) {
      event.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    if (event.dataTransfer.files.length > 0) {
      void handleFilesSelected(event.dataTransfer.files);
    }
  };

  useEffect(() => {
    return () => {
      pendingAttachmentsRef.current.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
    };
  }, []);

  useEffect(() => {
    // Always start a tab visit with a clean drag-overlay state — even
    // when we just switched TO 'talk'. The workspace dragCounter can
    // stick at >0 if a child dropzone in another tab (e.g. the Context
    // tab's SavedSourcesPanel) stops propagation on its own drop,
    // leaving the workspace's matching dragLeave unfired. Without this
    // reset, switching back to the Talk tab would re-render the
    // overlay with no live drag in progress.
    dragCounterRef.current = 0;
    setIsDragOver(false);

    if (currentTab !== 'talk') return;

    const preventWindowFileNavigation = (event: DragEvent) => {
      if (!hasFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      if (event.type === 'drop') {
        dragCounterRef.current = 0;
        setIsDragOver(false);
      }
    };

    window.addEventListener('dragenter', preventWindowFileNavigation, true);
    window.addEventListener('dragover', preventWindowFileNavigation, true);
    window.addEventListener('drop', preventWindowFileNavigation, true);

    return () => {
      window.removeEventListener(
        'dragenter',
        preventWindowFileNavigation,
        true,
      );
      window.removeEventListener('dragover', preventWindowFileNavigation, true);
      window.removeEventListener('drop', preventWindowFileNavigation, true);
    };
  }, [currentTab]);

  const handleToggleTarget = (agentId: string) => {
    setTargetAgentIds((current) => {
      const selected = current.includes(agentId);
      if (selected) {
        if (current.length === 1) return current;
        return current.filter((id) => id !== agentId);
      }
      return [...current, agentId];
    });
    if (pageKind === 'ready' && state.sendState.status === 'error') {
      dispatch({ type: 'SEND_CLEARED' });
    }
  };

  const queueTalkMessage = useCallback(
    async (input: {
      content: string;
      targetAgentIds: string[];
      attachmentIds?: string[];
    }) => {
      if (pageKind !== 'ready' || !pageTalk || !activeThreadId) {
        throw new Error('Thread unavailable.');
      }

      const result = await sendTalkMessage({
        talkId: pageTalk.id,
        content: input.content,
        targetAgentIds: input.targetAgentIds,
        attachmentIds: input.attachmentIds,
        threadId: activeThreadId,
      });
      // The user just submitted — show them where their message landed,
      // even if they were scrolled up reading earlier history. Subsequent
      // agent responses go through the usual nearBottom gate so a user
      // who scrolls away mid-stream won't get yanked back.
      autoStickToBottomRef.current = true;
      appendTalkMessageToSnapshot({
        queryClient,
        userId,
        talkId,
        message: result.message,
      });
      dispatch({
        type: 'MESSAGE_LANDED',
        wasNearBottom: true,
        message: result.message,
      });
      for (const run of result.runs) {
        dispatch({
          type: 'RUN_QUEUED',
          runId: run.id,
          threadId: run.threadId,
          triggerMessageId: run.triggerMessageId,
          createdAt: run.createdAt,
          targetAgentId: run.targetAgentId,
          targetAgentNickname: run.targetAgentNickname,
          responseGroupId: run.responseGroupId,
          sequenceIndex: run.sequenceIndex,
          executorAlias: run.executorAlias,
          executorModel: run.executorModel,
        });
      }
      return result;
    },
    [activeThreadId, pageKind, pageTalk],
  );

  const submitDraft = async () => {
    if (pageKind !== 'ready' || !pageTalk || !activeThreadId) return;

    const content = draft.trim();
    if (!content) {
      dispatch({
        type: 'SEND_FAILED',
        message: 'Message content is required.',
        lastDraft: draft,
      });
      return;
    }
    if (content === '/edit') {
      setDraft('');
      dispatch({ type: 'SEND_CLEARED' });
      openHistoryEditor();
      return;
    }
    if (content.length > TALK_MESSAGE_MAX_CHARS) {
      dispatch({
        type: 'SEND_FAILED',
        message: `Message exceeds ${TALK_MESSAGE_MAX_CHARS} characters.`,
        lastDraft: content,
      });
      return;
    }
    if (activeRound) {
      dispatch({
        type: 'SEND_FAILED',
        message: 'Wait for the current round to finish or cancel it first.',
        lastDraft: content,
      });
      return;
    }
    if (hasUnsavedAgentChanges) {
      dispatch({
        type: 'SEND_FAILED',
        message: 'Save agent changes before sending a message.',
        lastDraft: content,
      });
      return;
    }
    if (composerGuardrailMessage) {
      dispatch({
        type: 'SEND_FAILED',
        message: composerGuardrailMessage,
        lastDraft: content,
      });
      return;
    }

    // Collect ready attachment IDs
    const readyAttachments = pendingAttachments.filter(
      (a) => a.status === 'ready' && a.attachmentId,
    );
    const stillUploading = pendingAttachments.some(
      (a) => a.status === 'uploading',
    );
    if (stillUploading) {
      dispatch({
        type: 'SEND_FAILED',
        message: 'Wait for file uploads to finish before sending.',
        lastDraft: content,
      });
      return;
    }

    dispatch({ type: 'SEND_STARTED' });
    try {
      await queueTalkMessage({
        content,
        targetAgentIds,
        attachmentIds: readyAttachments.map((a) => a.attachmentId!),
      });
      pendingAttachments.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
      setDraft('');
      setPendingAttachments([]);
      dispatch({ type: 'SEND_CLEARED' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      dispatch({
        type: 'SEND_FAILED',
        message: err instanceof Error ? err.message : 'Failed to send message',
        lastDraft: content,
      });
    }
  };

  const handleRetryAgentRun = useCallback(
    async (runId: string) => {
      if (pageKind !== 'ready' || !pageTalk || !activeThreadId) return;
      if (activeRound) {
        setRetryRunState({
          runId,
          status: 'error',
          message: 'Wait for the current round to finish or cancel it first.',
        });
        return;
      }
      if (hasUnsavedAgentChanges) {
        setRetryRunState({
          runId,
          status: 'error',
          message: 'Save agent changes before retrying this agent.',
        });
        return;
      }

      const run = state.runsById[runId];
      const triggerMessage = pageMessages.find(
        (message) =>
          message.id === run?.triggerMessageId && message.role === 'user',
      );
      if (!run?.targetAgentId || !triggerMessage?.content.trim()) {
        setRetryRunState({
          runId,
          status: 'error',
          message: 'The original prompt is unavailable for this retry.',
        });
        return;
      }

      setRetryRunState({
        runId,
        status: 'posting',
        message: 'Retrying this agent from the original prompt…',
      });
      try {
        await queueTalkMessage({
          content: triggerMessage.content,
          targetAgentIds: [run.targetAgentId],
        });
        setRetryRunState(null);
        dispatch({ type: 'SEND_CLEARED' });
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          setRetryRunState(null);
          handleUnauthorized();
          return;
        }
        setRetryRunState({
          runId,
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Unable to retry this agent.',
        });
      }
    },
    [
      activeRound,
      activeThreadId,
      handleUnauthorized,
      hasUnsavedAgentChanges,
      queueTalkMessage,
      pageKind,
      pageMessages,
      state.runsById,
      pageTalk,
    ],
  );

  const handleSend = (event: FormEvent) => {
    event.preventDefault();
    void submitDraft();
  };

  const handleComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (mentionState && mentionOptions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionState({
          atIndex: mentionState.atIndex,
          selectedIndex: Math.min(
            mentionState.selectedIndex + 1,
            mentionOptions.length - 1,
          ),
        });
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionState({
          atIndex: mentionState.atIndex,
          selectedIndex: Math.max(mentionState.selectedIndex - 1, 0),
        });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const option = mentionOptions[mentionState.selectedIndex];
        if (option) insertMentionOption(option);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionState(null);
        return;
      }
    }
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    ) {
      return;
    }
    event.preventDefault();
    void submitDraft();
  };

  const handleCancelRuns = async () => {
    if (pageKind !== 'ready' || !pageTalk || !activeThreadId) return;
    dispatch({ type: 'CANCEL_STARTED' });
    try {
      const result = await cancelTalkRuns(pageTalk.id, activeThreadId);
      dispatch({
        type: 'CANCEL_SUCCEEDED',
        message: `Cancelled ${result.cancelledRuns} run${result.cancelledRuns === 1 ? '' : 's'}.`,
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      dispatch({
        type: 'CANCEL_FAILED',
        message: err instanceof Error ? err.message : 'Failed to cancel runs',
      });
    }
  };

  const handleSelectThread = useCallback(
    (threadId: string) => {
      navigate(buildThreadHref(talkId, threadId, currentTab));
    },
    [currentTab, navigate, talkId],
  );

  const openThreadMenu = useCallback(
    (threadId: string, x: number, y: number) => {
      if (!canEditAgents) return;
      setThreadMenu({ threadId, x, y });
    },
    [canEditAgents],
  );

  const handleThreadSecondaryClick = useCallback(
    (threadId: string) => (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 2) return;
      event.preventDefault();
      event.stopPropagation();
      openThreadMenu(threadId, event.clientX, event.clientY);
    },
    [openThreadMenu],
  );

  const handleThreadContextMenu = useCallback(
    (threadId: string) => (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      openThreadMenu(threadId, event.clientX, event.clientY);
    },
    [openThreadMenu],
  );

  const handleOrchestrationModeChange = useCallback(
    async (nextMode: TalkOrchestrationMode) => {
      if (pageKind !== 'ready' || !pageTalk) return;
      if (pageTalk.orchestrationMode === nextMode) return;

      setOrchestrationState({ status: 'saving' });
      try {
        const updatedTalk = await patchTalkMetadata({
          talkId: pageTalk.id,
          orchestrationMode: nextMode,
        });
        patchTalkInSnapshot({
          queryClient,
          userId,
          talkId,
          threadId: activeThreadIdRef.current,
          patch: {
            orchestrationMode: updatedTalk.orchestrationMode,
            title: updatedTalk.title,
            version: updatedTalk.version,
            updatedAt: updatedTalk.updatedAt,
          },
        });
        setOrchestrationState({ status: 'idle' });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setOrchestrationState({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to update response mode.',
        });
      }
    },
    [handleUnauthorized, pageKind, pageTalk, queryClient, talkId, userId],
  );

  const handleCreateThread = useCallback(async () => {
    if (pageKind !== 'ready' || !pageTalk) return;
    try {
      const nextThread = await createTalkThread({ talkId: pageTalk.id });
      setThreadState((current) => ({
        ...current,
        threads: sortThreads([nextThread, ...current.threads]),
      }));
      pendingComposerFocusRef.current = true;
      navigate(buildThreadHref(talkId, nextThread.id, currentTab));
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setThreadState((current) => ({
        ...current,
        error: err instanceof Error ? err.message : 'Failed to create thread.',
      }));
    }
  }, [currentTab, handleUnauthorized, navigate, state, talkId]);

  const handleSearch = useCallback(async () => {
    const query = searchQueryRef.current.trim();
    if (!query) {
      setSearchResults([]);
      setSearchError(null);
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    try {
      const results = await searchTalkMessages({ talkId, query });
      setSearchResults(results);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setSearchError(
        err instanceof Error ? err.message : 'Failed to search talk messages.',
      );
    } finally {
      setSearchLoading(false);
    }
  }, [handleUnauthorized, talkId]);

  const handleSearchResultSelect = useCallback(
    (result: TalkMessageSearchResult) => {
      setSearchResults([]);
      navigate(buildThreadHref(talkId, result.threadId));
    },
    [navigate, talkId],
  );

  const handleAttachConnector = async () => {
    if (!canManageTalkConnectors || !attachConnectorId) return;

    setConnectorState({ status: 'saving' });
    try {
      const attached = await attachTalkDataConnector({
        talkId,
        connectorId: attachConnectorId,
      });
      setTalkConnectors((current) =>
        current.some((connector) => connector.id === attached.id)
          ? current
          : [...current, attached],
      );
      setOrgConnectors((current) =>
        current.map((connector) =>
          connector.id === attached.id
            ? {
                ...connector,
                attachedTalkCount: connector.attachedTalkCount + 1,
              }
            : connector,
        ),
      );
      setConnectorState({
        status: 'success',
        message: `${attached.name} attached to this talk.`,
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setConnectorState({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to attach data connector.',
      });
    }
  };

  const handleDetachConnector = async (connector: TalkDataConnector) => {
    if (!canManageTalkConnectors) return;

    setConnectorState({ status: 'saving' });
    try {
      await detachTalkDataConnector({
        talkId,
        connectorId: connector.id,
      });
      setTalkConnectors((current) =>
        current.filter((item) => item.id !== connector.id),
      );
      setOrgConnectors((current) =>
        current.map((item) =>
          item.id === connector.id
            ? {
                ...item,
                attachedTalkCount: Math.max(0, item.attachedTalkCount - 1),
              }
            : item,
        ),
      );
      setConnectorState({
        status: 'success',
        message: `${connector.name} detached from this talk.`,
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setConnectorState({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to detach data connector.',
      });
    }
  };

  const handleClearUnread = () => {
    scrollToBottom('smooth');
    dispatch({ type: 'CLEAR_UNREAD' });
  };

  const handleAgentSourceChange = (
    agentId: string,
    sourceKind: 'claude_default' | 'provider',
    providerId: string | null,
  ) => {
    setAgentDrafts((current) =>
      current.map((agent) => {
        if (agent.id !== agentId) return agent;
        const suggestions = getModelSuggestionsForSource({
          sourceKind,
          providerId,
          aiAgents: aiAgentsData,
        });
        const nextModelId =
          suggestions.find((entry) => entry.modelId === agent.modelId)
            ?.modelId ||
          suggestions[0]?.modelId ||
          '';
        return applySourceModelSelection(
          agent,
          { sourceKind, providerId, modelId: nextModelId },
          current,
          aiAgentsData,
        );
      }),
    );
    setAgentState({ status: 'idle' });
  };

  const handleAgentModelChange = (agentId: string, modelId: string) => {
    setAgentDrafts((current) =>
      current.map((agent) =>
        agent.id === agentId
          ? applySourceModelSelection(
              agent,
              {
                sourceKind: agent.sourceKind,
                providerId:
                  agent.sourceKind === 'provider' ? agent.providerId : null,
                modelId,
              },
              current,
              aiAgentsData,
            )
          : agent,
      ),
    );
    setAgentState({ status: 'idle' });
  };

  const handleAgentNicknameChange = (agentId: string, nickname: string) => {
    setAgentDrafts((current) =>
      current.map((agent) =>
        agent.id === agentId
          ? {
              ...agent,
              nickname,
              nicknameMode: 'custom',
            }
          : agent,
      ),
    );
    setAgentState({ status: 'idle' });
  };

  const handleResetNickname = (agentId: string) => {
    setAgentDrafts((current) =>
      current.map((agent) => {
        if (agent.id !== agentId) return agent;
        // Use registered agent name if available, otherwise fall back to
        // the old source-based nickname builder.
        const regAgent = registeredAgentsCatalog.find(
          (ra) => ra.id === agent.id,
        );
        const base = regAgent
          ? regAgent.name
          : buildAutoNicknameBase({
              sourceKind: agent.sourceKind,
              providerId: agent.providerId,
              modelId: agent.modelId,
              modelDisplayName: agent.modelDisplayName,
              aiAgents: aiAgentsData,
            });
        return {
          ...agent,
          nickname: buildUniqueNickname(base, current, agent.id),
          nicknameMode: 'auto',
        };
      }),
    );
    setAgentState({ status: 'idle' });
  };

  const handleAgentRoleChange = (agentId: string, role: TalkAgent['role']) => {
    setAgentDrafts((current) =>
      current.map((agent) =>
        agent.id === agentId ? { ...agent, role } : agent,
      ),
    );
    setAgentState({ status: 'idle' });
  };

  const handleSetPrimaryAgent = (agentId: string) => {
    setAgentDrafts((current) =>
      current.map((agent) => ({
        ...agent,
        isPrimary: agent.id === agentId,
      })),
    );
    setAgentState({ status: 'idle' });
  };

  const handleRemoveAgent = (agentId: string) => {
    setAgentDrafts((current) => {
      const remaining = current.filter((agent) => agent.id !== agentId);
      if (remaining.length === 0) return current;
      if (!remaining.some((agent) => agent.isPrimary)) {
        remaining[0] = { ...remaining[0], isPrimary: true };
      }
      return remaining.map((agent, index) => ({
        ...agent,
        displayOrder: index,
      }));
    });
    setTargetAgentIds((current) => {
      const next = current.filter((id) => id !== agentId);
      return next.length > 0 ? next : [];
    });
    setAgentState({ status: 'idle' });
  };

  const materializePendingFooterAgent = (
    currentDrafts: TalkAgent[],
  ): {
    nextAgents: TalkAgent[];
    nextDraft: AgentCreationDraft;
    added: boolean;
    error: string | null;
  } => {
    const selectedAgentId = newAgentDraft.modelId.trim();
    if (!selectedAgentId) {
      return {
        nextAgents: currentDrafts,
        nextDraft: newAgentDraft,
        added: false,
        error: null,
      };
    }

    const regAgent = registeredAgentsCatalog.find(
      (ra) => ra.id === selectedAgentId && ra.enabled,
    );
    if (!regAgent) {
      return {
        nextAgents: currentDrafts,
        nextDraft: newAgentDraft,
        added: false,
        error:
          'Selected registered agent is no longer available. Refresh and try again.',
      };
    }

    if (currentDrafts.some((agent) => agent.id === regAgent.id)) {
      return {
        nextAgents: currentDrafts,
        nextDraft: newAgentDraft,
        added: false,
        error: 'Selected registered agent is already assigned to this talk.',
      };
    }

    const nickname = buildUniqueNickname(regAgent.name, currentDrafts);
    return {
      nextAgents: [
        ...currentDrafts,
        {
          id: regAgent.id,
          nickname,
          nicknameMode: 'auto',
          sourceKind: 'provider',
          role: newAgentDraft.role,
          isPrimary: false,
          displayOrder: currentDrafts.length,
          health: 'ready',
          providerId: regAgent.providerId,
          modelId: regAgent.modelId,
          modelDisplayName: null,
        },
      ],
      nextDraft: {
        ...newAgentDraft,
        modelId: '',
        providerId: null,
      },
      added: true,
      error: null,
    };
  };

  const handleAddAgent = () => {
    const materialized = materializePendingFooterAgent(agentDrafts);
    if (materialized.error) {
      setAgentState({ status: 'error', message: materialized.error });
      return;
    }
    if (!materialized.added) return;
    setAgentDrafts(materialized.nextAgents);
    setNewAgentDraft(materialized.nextDraft);
    setAgentState({ status: 'idle' });
  };

  const handleSaveAgents = async () => {
    if (pageKind !== 'ready' || !pageTalk || !canEditAgents) return;
    const materialized = materializePendingFooterAgent(agentDrafts);
    if (materialized.error) {
      setAgentState({ status: 'error', message: materialized.error });
      return;
    }
    if (materialized.added) {
      setAgentDrafts(materialized.nextAgents);
      setNewAgentDraft(materialized.nextDraft);
    }
    setAgentState({ status: 'saving' });
    try {
      const saved = await updateTalkAgents({
        talkId: pageTalk.id,
        agents: materialized.nextAgents.map((agent, index) => ({
          id: agent.id,
          nickname: agent.nickname.trim(),
          nicknameMode: agent.nicknameMode,
          sourceKind: agent.sourceKind,
          providerId: agent.sourceKind === 'provider' ? agent.providerId : null,
          modelId: agent.modelId,
          modelDisplayName: agent.modelDisplayName,
          role: agent.role,
          isPrimary: agent.isPrimary,
          displayOrder: index,
          health: agent.health,
        })),
      });
      setAgents(saved);
      setAgentDrafts(saved);
      setNewAgentDraft(materialized.nextDraft);
      setTargetAgentIds((current) => buildTargetSelection(saved, current));
      setAgentState({ status: 'success', message: 'Talk agents updated.' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setAgentState({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to update talk agents',
      });
    }
  };

  const handleToggleRunContext = useCallback(
    async (runId: string) => {
      const current = runContextPanelsRef.current[runId];
      if (current?.open) {
        setRunContextPanels((existing) => ({
          ...existing,
          [runId]: {
            ...(existing[runId] || {
              open: false,
              status: 'idle',
              snapshot: null,
            }),
            open: false,
          },
        }));
        return;
      }

      if (current?.status === 'loaded') {
        setRunContextPanels((existing) => ({
          ...existing,
          [runId]: {
            ...(existing[runId] || {
              open: false,
              status: 'idle',
              snapshot: null,
            }),
            open: true,
          },
        }));
        return;
      }

      setRunContextPanels((existing) => ({
        ...existing,
        [runId]: {
          open: true,
          status: 'loading',
          snapshot: existing[runId]?.snapshot ?? null,
        },
      }));

      try {
        const snapshot = await getTalkRunContext({ talkId, runId });
        setRunContextPanels((existing) => ({
          ...existing,
          [runId]: {
            open: true,
            status: 'loaded',
            snapshot,
          },
        }));
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setRunContextPanels((existing) => ({
          ...existing,
          [runId]: {
            open: true,
            status: 'error',
            snapshot: null,
            message:
              err instanceof Error
                ? err.message
                : 'Failed to load run context.',
          },
        }));
      }
    },
    [handleUnauthorized, talkId],
  );

  const jumpToMessage = (messageId: string) => {
    const element = messageElementRefs.current.get(messageId);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleOpenRunTrigger = useCallback(
    (run: TalkRun) => {
      if (!run.threadId) return;
      if (run.threadId !== activeThreadId) {
        navigate(buildThreadHref(talkId, run.threadId));
        return;
      }
      if (run.triggerMessageId) {
        jumpToMessage(run.triggerMessageId);
      }
    },
    [activeThreadId, navigate, talkId],
  );

  useEffect(() => {
    if (!isRenaming) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [isRenaming]);

  if (pageKind === 'loading') {
    return <p className="page-state">Loading talk…</p>;
  }

  if (pageKind === 'unavailable') {
    return (
      <section className="page-state">
        <h2>Talk Unavailable</h2>
        <p>{pageErrorMessage || 'Talk not found.'}</p>
        <Link to="/app/talks">Back to talks</Link>
      </section>
    );
  }

  if (pageKind === 'error' || !pageTalk) {
    return (
      <section className="page-state">
        <h2>Talk Error</h2>
        <p>{pageErrorMessage || 'Failed to load talk.'}</p>
        <Link to="/app/talks">Back to talks</Link>
      </section>
    );
  }

  const talk = pageTalk;
  const displayedTitle = titleOverride || talk.title;

  return (
    <section className="page-shell talk-detail-shell">
      <div
        className={`talk-workspace${isDragOver ? ' talk-workspace-drag-over' : ''}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {isDragOver ? (
          <div className="talk-workspace-drop-overlay">
            Drop files to attach
          </div>
        ) : null}
        <div className="talk-workspace-header">
          <header className="page-header talk-page-header">
            <div className="talk-page-heading">
              <div className="talk-page-topbar">
                {isRenaming ? (
                  <input
                    ref={titleInputRef}
                    className="talk-title-input"
                    type="text"
                    value={renameDraft?.draft ?? ''}
                    onChange={(event) =>
                      onRenameDraftChange(talkId, event.target.value)
                    }
                    onKeyDown={async (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        await onRenameDraftCommit(
                          talkId,
                          renameDraft?.draft ?? '',
                        );
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        onRenameDraftCancel(talkId);
                      }
                    }}
                    onBlur={() => {
                      void onRenameDraftCommit(
                        talkId,
                        renameDraft?.draft ?? '',
                      );
                    }}
                    aria-label="Talk title"
                  />
                ) : (
                  <h1 className="talk-title">
                    <button
                      type="button"
                      className="talk-title-button"
                      onClick={() =>
                        onRenameDraftChange(talkId, displayedTitle)
                      }
                      aria-label="Rename talk title"
                      title="Rename talk title"
                    >
                      {displayedTitle}
                    </button>
                  </h1>
                )}
                <div className="talk-tabs-stack">
                  <div className="talk-tabs-row">
                    <nav className="talk-tabs" aria-label="Talk sections">
                      <Link
                        to={threadAwareTalkTabHref}
                        className={`talk-tab ${currentTab === 'talk' ? 'talk-tab-active' : ''}`}
                      >
                        Talk
                      </Link>
                      <Link
                        to={agentsTabHref}
                        className={`talk-tab ${currentTab === 'agents' ? 'talk-tab-active' : ''}`}
                      >
                        Agents
                      </Link>
                      <Link
                        to={contextTabHref}
                        className={`talk-tab ${currentTab === 'context' ? 'talk-tab-active' : ''}`}
                      >
                        Context
                        <span
                          className="talk-tab-badge"
                          aria-label={`${activeRuleCount} active rules`}
                        >
                          {activeRuleCount}
                        </span>
                      </Link>
                      <Link
                        to={workspaceConnectorsTabHref}
                        className={`talk-tab ${currentTab === 'connectors' ? 'talk-tab-active' : ''}`}
                      >
                        Connectors
                      </Link>
                      <Link
                        to={runsTabHref}
                        className={`talk-tab ${currentTab === 'runs' ? 'talk-tab-active' : ''}`}
                      >
                        Run History
                      </Link>
                    </nav>
                    {showOrchestrationSelector ? (
                      <div
                        className="talk-orchestration-menu"
                        ref={orchestrationMenuRef}
                      >
                        <button
                          type="button"
                          className={`talk-orchestration-trigger${
                            orchestrationMenuOpen
                              ? ' talk-orchestration-trigger-open'
                              : ''
                          }`}
                          onClick={() =>
                            setOrchestrationMenuOpen((current) => !current)
                          }
                          aria-expanded={orchestrationMenuOpen}
                          aria-haspopup="menu"
                          aria-label={`Response mode, ${orchestrationModeLabel}`}
                          title={ORCHESTRATION_MODE_TOOLTIP}
                          disabled={orchestrationState.status === 'saving'}
                        >
                          <span
                            className="talk-orchestration-trigger-icon"
                            aria-hidden="true"
                          >
                            <OrchestrationModeIcon />
                          </span>
                          <span className="talk-orchestration-trigger-text">
                            {orchestrationModeLabel}
                          </span>
                          <span
                            className="talk-orchestration-trigger-chevron"
                            aria-hidden="true"
                          >
                            <OrchestrationChevronIcon />
                          </span>
                        </button>
                        {orchestrationMenuOpen ? (
                          <div
                            className="talk-orchestration-dropdown"
                            role="menu"
                            aria-label="Response mode options"
                          >
                            {ORCHESTRATION_MODE_OPTIONS.map((option) => {
                              const selected =
                                orchestrationMode === option.value;
                              return (
                                <button
                                  type="button"
                                  key={option.value}
                                  className={`talk-orchestration-option${
                                    selected
                                      ? ' talk-orchestration-option-selected'
                                      : ''
                                  }`}
                                  role="menuitemradio"
                                  aria-checked={selected}
                                  onClick={() => {
                                    setOrchestrationMenuOpen(false);
                                    void handleOrchestrationModeChange(
                                      option.value,
                                    );
                                  }}
                                >
                                  <span>{option.label}</span>
                                  {selected ? (
                                    <span
                                      className="talk-orchestration-option-check"
                                      aria-hidden="true"
                                    >
                                      <OrchestrationCheckIcon />
                                    </span>
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {!currentThreadHasContent ? (
                      <button
                        type="button"
                        className="talk-tabs-add-doc"
                        onClick={openDocModal}
                        aria-label="Add a document to this thread"
                        title="Add a document to this thread"
                      >
                        + Doc
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
              {effectiveAgents.length > 0 ? (
                <div
                  className="talk-status-strip"
                  role="list"
                  aria-label="Talk agent status"
                >
                  {effectiveAgents.map((agent) => {
                    const guardrail =
                      talkAgentExecutionGuardrailsById[agent.id];
                    return (
                      <span
                        key={agent.id}
                        className={`talk-status-pill talk-status-pill-${agent.health}`}
                        role="listitem"
                        title={guardrail?.message || undefined}
                      >
                        <span
                          className={`talk-status-dot talk-status-dot-${agent.health}`}
                          aria-hidden="true"
                        />
                        <span>{buildAgentLabel(agent)}</span>
                        {guardrail?.badgeLabel ? (
                          <span
                            className={`talk-status-constraint talk-status-constraint-${guardrail.kind}`}
                          >
                            {guardrail.badgeLabel}
                          </span>
                        ) : null}
                        {agent.isPrimary ? (
                          <span className="talk-status-primary">Primary</span>
                        ) : null}
                      </span>
                    );
                  })}
                </div>
              ) : null}
              {orchestrationState.status === 'error' ? (
                <p className="talk-thread-search-error" role="alert">
                  {orchestrationState.message}
                </p>
              ) : null}
            </div>
          </header>
        </div>

        <div
          className={`talk-workspace-scroll${
            currentTab === 'talk' ? ' talk-workspace-scroll-talk' : ''
          }`}
        >
          {currentTab === 'agents' ? (
            <section className="talk-tab-panel" aria-label="Talk agents">
              <div className="agents-panel-header">
                <h2>Agents</h2>
                <Link className="secondary-btn" to={manageAgentsHref}>
                  Manage AI Agents
                </Link>
              </div>
              <p className="policy-muted">
                Nicknames are local to this talk. The primary agent responds to
                normal user messages by default.
              </p>
              {agentDrafts.map((agent) => (
                <div key={agent.id} className="agent-editor-card">
                  <label>
                    <span>Registered Agent</span>
                    <select
                      value={agent.id}
                      onChange={(event) => {
                        const regAgent = registeredAgentsCatalog.find(
                          (ra) => ra.id === event.target.value,
                        );
                        if (!regAgent) return;
                        setAgentDrafts((current) =>
                          current.map((a) =>
                            a.id === agent.id
                              ? {
                                  ...a,
                                  id: regAgent.id,
                                  sourceKind: 'provider',
                                  providerId: regAgent.providerId,
                                  modelId: regAgent.modelId,
                                  modelDisplayName: null,
                                  nickname:
                                    a.nicknameMode === 'auto'
                                      ? regAgent.name
                                      : a.nickname,
                                  health: 'ready',
                                }
                              : a,
                          ),
                        );
                        setAgentState({ status: 'idle' });
                      }}
                      disabled={
                        !canEditAgents || agentState.status === 'saving'
                      }
                    >
                      <option
                        value={agent.id}
                        disabled={
                          !registeredAgentsCatalog.some(
                            (ra) => ra.id === agent.id,
                          )
                        }
                      >
                        {registeredAgentsCatalog.find(
                          (ra) => ra.id === agent.id,
                        )?.name ||
                          agent.nickname ||
                          'Unknown agent'}
                      </option>
                      {registeredAgentsCatalog
                        .filter(
                          (ra) =>
                            ra.enabled &&
                            ra.id !== agent.id &&
                            !agentDrafts.some((d) => d.id === ra.id),
                        )
                        .map((ra) => (
                          <option key={ra.id} value={ra.id}>
                            {ra.name}
                            {ra.personaRole ? ` · ${ra.personaRole}` : ''} (
                            {ra.modelId})
                          </option>
                        ))}
                    </select>
                  </label>
                  {(() => {
                    const persona = registeredAgentsCatalog.find(
                      (ra) => ra.id === agent.id,
                    );
                    return persona?.description ? (
                      <p className="talk-llm-meta talk-agent-persona-blurb">
                        {persona.description}
                      </p>
                    ) : null;
                  })()}
                  <label>
                    <span>Nickname</span>
                    <input
                      type="text"
                      value={agent.nickname}
                      onChange={(event) =>
                        handleAgentNicknameChange(agent.id, event.target.value)
                      }
                      disabled={
                        !canEditAgents || agentState.status === 'saving'
                      }
                    />
                  </label>
                  <label>
                    <span>Role</span>
                    <select
                      value={agent.role}
                      onChange={(event) =>
                        handleAgentRoleChange(
                          agent.id,
                          event.target.value as TalkAgent['role'],
                        )
                      }
                      disabled={
                        !canEditAgents || agentState.status === 'saving'
                      }
                    >
                      {TALK_AGENT_ROLE_OPTIONS.map((role) => (
                        <option key={role} value={role}>
                          {formatTalkRole(role)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="agent-editor-actions">
                    <label className="policy-primary-toggle">
                      <input
                        type="radio"
                        name="primary-talk-agent"
                        checked={agent.isPrimary}
                        onChange={() => handleSetPrimaryAgent(agent.id)}
                        disabled={
                          !canEditAgents || agentState.status === 'saving'
                        }
                      />
                      <span>Primary Agent</span>
                    </label>
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => handleResetNickname(agent.id)}
                      disabled={
                        !canEditAgents || agentState.status === 'saving'
                      }
                    >
                      Reset name
                    </button>
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => handleRemoveAgent(agent.id)}
                      disabled={
                        !canEditAgents ||
                        agentState.status === 'saving' ||
                        agentDrafts.length <= 1
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}

              <div className="agent-editor-footer">
                <label>
                  <span>Agent</span>
                  <select
                    value={newAgentDraft.modelId}
                    onChange={(event) => {
                      const ra = registeredAgentsCatalog.find(
                        (a) => a.id === event.target.value,
                      );
                      if (!ra) return;
                      setNewAgentDraft({
                        sourceKind: 'provider',
                        providerId: ra.providerId,
                        modelId: ra.id,
                        role:
                          (ra.personaRole as TalkAgent['role']) || 'assistant',
                      });
                    }}
                    disabled={!canEditAgents || agentState.status === 'saving'}
                  >
                    <option value="" disabled>
                      Choose a registered agent…
                    </option>
                    {registeredAgentsCatalog
                      .filter(
                        (ra) =>
                          ra.enabled &&
                          !agentDrafts.some((d) => d.id === ra.id),
                      )
                      .map((ra) => (
                        <option key={ra.id} value={ra.id}>
                          {ra.name}
                          {ra.personaRole ? ` · ${ra.personaRole}` : ''} (
                          {ra.modelId})
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  <span>Role</span>
                  <select
                    value={newAgentDraft.role}
                    onChange={(event) =>
                      setNewAgentDraft((current) => ({
                        ...current,
                        role: event.target.value as TalkAgent['role'],
                      }))
                    }
                    disabled={!canEditAgents || agentState.status === 'saving'}
                  >
                    {TALK_AGENT_ROLE_OPTIONS.map((role) => (
                      <option key={role} value={role}>
                        {formatTalkRole(role)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={handleAddAgent}
                  disabled={
                    !canEditAgents ||
                    agentState.status === 'saving' ||
                    !newAgentDraft.modelId
                  }
                >
                  Add Agent
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={handleSaveAgents}
                  disabled={!canEditAgents || agentState.status === 'saving'}
                >
                  {agentState.status === 'saving'
                    ? 'Saving…'
                    : hasPendingFooterAgentSelection
                      ? 'Add + Save Agents'
                      : 'Save Agents'}
                </button>
              </div>
              {agentsCatalogError ? (
                <div className="inline-banner inline-banner-error" role="alert">
                  {agentsCatalogError}
                </div>
              ) : null}
              {agentState.status === 'error' ? (
                <div className="inline-banner inline-banner-error" role="alert">
                  {agentState.message}
                </div>
              ) : null}
              {agentState.status === 'success' ? (
                <div
                  className="inline-banner inline-banner-success"
                  role="status"
                >
                  {agentState.message}
                </div>
              ) : null}
            </section>
          ) : null}

          {currentTab === 'context' ? (
            <section className="talk-tab-panel" aria-label="Talk context">
              {contextStatus.status === 'loading' ? (
                <p className="page-state">Loading context…</p>
              ) : contextStatus.status === 'error' ? (
                <p className="page-state error">{contextStatus.message}</p>
              ) : (
                <>
                  {/* Goal */}
                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Goal</h3>
                        <p className="talk-llm-meta">
                          What is this talk for? Describe the overall objective
                          so agents share a frame for every discussion.
                        </p>
                      </div>
                    </div>
                    {canEditAgents ? (
                      <>
                        <label style={{ display: 'block' }}>
                          <span className="sr-only">Talk goal</span>
                          <textarea
                            maxLength={1000}
                            rows={4}
                            value={goalDraft}
                            onChange={(e) => setGoalDraft(e.target.value)}
                            placeholder="e.g. Track and discuss Cal Football news each week — scores, key plays, injury reports, and how the team is trending toward bowl eligibility."
                            disabled={contextStatus.status === 'saving'}
                            style={{ width: '100%' }}
                          />
                        </label>
                        <div
                          className="connector-attach-row"
                          style={{ justifyContent: 'space-between' }}
                        >
                          <p className="talk-llm-meta">
                            {goalDraft.length}/1000
                          </p>
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() => void handleSaveGoal()}
                            disabled={contextStatus.status === 'saving'}
                          >
                            Save
                          </button>
                        </div>
                      </>
                    ) : (
                      <p className="talk-llm-meta">
                        {contextGoal?.goalText || <em>No goal set.</em>}
                      </p>
                    )}
                  </div>

                  {/* Rules */}
                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Rules</h3>
                        <p className="talk-llm-meta">
                          Specific formats and constraints — e.g. an output
                          shape to follow, or sources to avoid. Up to 8 active
                          rules, applied in order. Inactive rules stay editable
                          without affecting prompt injection.
                        </p>
                      </div>
                    </div>
                    {orderedContextRules.length > 0 ? (
                      <DndContext
                        sensors={ruleSensors}
                        collisionDetection={closestCenter}
                        onDragEnd={(event) => void handleRuleReorder(event)}
                      >
                        <div className="talk-rule-list">
                          {orderedContextRules.map((rule) => {
                            const draft = ruleDrafts[rule.id] ?? rule.ruleText;
                            const hasTextChange =
                              draft.trim().length > 0 &&
                              draft.trim() !== rule.ruleText;
                            return (
                              <RuleRow
                                key={rule.id}
                                ruleId={rule.id}
                                disabled={!canEditAgents}
                                label={rule.ruleText}
                              >
                                <div
                                  className={`talk-rule-card${
                                    rule.isActive
                                      ? ''
                                      : ' talk-rule-card-inactive'
                                  }`}
                                >
                                  <div className="talk-rule-card-top">
                                    <span className="talk-agent-chip">
                                      {rule.isActive ? 'Active' : 'Inactive'}
                                    </span>
                                    <span className="talk-llm-meta">
                                      Position {rule.sortOrder + 1}
                                    </span>
                                  </div>
                                  {canEditAgents ? (
                                    <>
                                      <label className="talk-rule-edit-field">
                                        <span className="sr-only">
                                          Rule text
                                        </span>
                                        <textarea
                                          maxLength={800}
                                          rows={2}
                                          value={draft}
                                          onChange={(event) =>
                                            setRuleDrafts((prev) => ({
                                              ...prev,
                                              [rule.id]: event.target.value,
                                            }))
                                          }
                                          onBlur={() =>
                                            void handleSaveRuleText(rule)
                                          }
                                          disabled={
                                            contextStatus.status === 'saving'
                                          }
                                          style={{ width: '100%' }}
                                        />
                                      </label>
                                      <div className="talk-rule-actions">
                                        <button
                                          type="button"
                                          className="secondary-btn"
                                          onClick={() =>
                                            void handleToggleRule(rule)
                                          }
                                        >
                                          {rule.isActive ? 'Pause' : 'Activate'}
                                        </button>
                                        <button
                                          type="button"
                                          className="secondary-btn"
                                          onClick={() =>
                                            void handleSaveRuleText(rule)
                                          }
                                          disabled={
                                            contextStatus.status === 'saving' ||
                                            !hasTextChange
                                          }
                                        >
                                          Save
                                        </button>
                                        <button
                                          type="button"
                                          className="secondary-btn"
                                          onClick={() =>
                                            void handleDeleteRule(rule.id)
                                          }
                                        >
                                          Delete
                                        </button>
                                      </div>
                                    </>
                                  ) : (
                                    <p className="talk-rule-readonly">
                                      {rule.ruleText}
                                    </p>
                                  )}
                                </div>
                              </RuleRow>
                            );
                          })}
                        </div>
                      </DndContext>
                    ) : (
                      <p className="page-state">No rules yet.</p>
                    )}
                    {canEditAgents ? (
                      <div className="talk-rule-create-row">
                        <label style={{ flex: 1 }}>
                          <span className="sr-only">New rule text</span>
                          <textarea
                            maxLength={800}
                            rows={2}
                            value={newRuleText}
                            onChange={(e) => setNewRuleText(e.target.value)}
                            placeholder="e.g. When summarizing Cal Football news, use: ⟨headline⟩ — ⟨score⟩ — three bullets of key plays."
                            disabled={contextStatus.status === 'saving'}
                            style={{ width: '100%' }}
                          />
                        </label>
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => void handleAddRule()}
                          disabled={
                            contextStatus.status === 'saving' ||
                            !newRuleText.trim()
                          }
                        >
                          Add Rule
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <SavedSourcesPanel
                    talkId={talkId}
                    sources={contextSources}
                    setSources={setContextSources}
                    canEdit={canEditAgents}
                    onUnauthorized={handleUnauthorized}
                  />

                  {/* State */}
                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>State</h3>
                        <p className="talk-llm-meta">
                          Structured Talk state entries. Agents read and write
                          these via compare-and-swap updates.
                        </p>
                      </div>
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          void refreshTalkStateEntries({ showLoading: false });
                        }}
                      >
                        Refresh
                      </button>
                    </div>
                    {talkStateStatus.status === 'error' ? (
                      <p className="page-state error">
                        {talkStateStatus.message}
                      </p>
                    ) : null}
                    {talkStateStatus.status === 'loading' &&
                    !talkStateLoaded ? (
                      <p className="page-state">Loading state…</p>
                    ) : talkStateEntries.length > 0 ? (
                      <div className="talk-state-list">
                        {talkStateEntries.map((entry) => (
                          <TalkStateCard
                            key={entry.id}
                            entry={entry}
                            canDelete={canEditAgents}
                            onDelete={async () => {
                              const confirmed = window.confirm(
                                `Delete state entry "${entry.key}"? This cannot be undone.`,
                              );
                              if (!confirmed) return;
                              try {
                                await deleteTalkStateEntry(talkId, entry.key);
                                setTalkStateStatus({ status: 'idle' });
                                setTalkStateEntries((prev) =>
                                  prev.filter((e) => e.id !== entry.id),
                                );
                              } catch (err) {
                                if (err instanceof UnauthorizedError) {
                                  handleUnauthorized();
                                  return;
                                }
                                setTalkStateStatus({
                                  status: 'error',
                                  message:
                                    err instanceof Error
                                      ? err.message
                                      : 'Failed to delete state entry.',
                                });
                              }
                            }}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="page-state">No state entries yet.</p>
                    )}
                  </div>

                  {/* Drive Resources */}
                  <TalkToolsPanel talkId={talkId} />

                  {contextStatus.status === 'success' &&
                  contextStatus.message ? (
                    <p className="page-state">{contextStatus.message}</p>
                  ) : null}
                </>
              )}
            </section>
          ) : null}

          {currentTab === 'connectors' ? (
            <TalkConnectorsPanel
              talkId={talkId}
              onUnauthorized={handleUnauthorized}
            />
          ) : null}

          {currentTab === 'runs' ? (
            <section
              className="talk-tab-panel run-history-panel"
              aria-label="Run history"
            >
              <h2>Run History</h2>
              {runHistory.length === 0 ? (
                <p className="page-state">No runs yet.</p>
              ) : (
                <ul className="run-history-list">
                  {runHistory.map((run) => {
                    const runContextPanel = runContextPanels[run.id];
                    return (
                      <li
                        key={run.id}
                        id={`run-${run.id}`}
                        className="run-history-item"
                      >
                        <div className="run-history-main">
                          <span
                            className={`run-history-status run-history-status-${run.status}`}
                          >
                            {run.status}
                          </span>
                          <code>{run.id}</code>
                        </div>
                        {run.targetAgentNickname ? (
                          <p className="run-history-meta">
                            Agent: {run.targetAgentNickname}
                          </p>
                        ) : null}
                        <div className="run-history-links">
                          {run.triggerMessageId ? (
                            <button
                              type="button"
                              className="run-history-link"
                              onClick={() => handleOpenRunTrigger(run)}
                            >
                              Trigger:{' '}
                              {summarizeMessageForRun(
                                messageLookup.get(run.triggerMessageId),
                                run.triggerMessageId,
                              )}
                            </button>
                          ) : (
                            <span className="run-history-muted">
                              Trigger: not available
                            </span>
                          )}
                          <button
                            type="button"
                            className="secondary-btn run-history-context-toggle"
                            onClick={() => void handleToggleRunContext(run.id)}
                          >
                            {runContextPanel?.status === 'loading'
                              ? 'Loading context…'
                              : runContextPanel?.open
                                ? 'Hide context'
                                : 'View context'}
                          </button>
                        </div>
                        {run.browserBlock ? (
                          <BrowserBlockedRunCard
                            runId={run.id}
                            browserBlock={run.browserBlock}
                            executionDecision={run.executionDecision}
                            talkId={talkId}
                            onUnauthorized={handleUnauthorized}
                            onStateChanged={refreshBrowserRuns}
                          />
                        ) : null}
                        {run.status === 'failed' ? (
                          <ExecutionDecisionSummary
                            executionDecision={run.executionDecision}
                          />
                        ) : null}
                        {runContextPanel?.open ? (
                          <section
                            className="run-context-shell"
                            aria-label={`Context used for run ${run.id}`}
                          >
                            {runContextPanel.status === 'loading' ? (
                              <div className="run-context-panel">
                                <p className="run-context-note">
                                  Loading context snapshot…
                                </p>
                              </div>
                            ) : runContextPanel.status === 'error' ? (
                              <div className="run-context-panel">
                                <p className="run-context-note" role="alert">
                                  {runContextPanel.message ||
                                    'Failed to load run context.'}
                                </p>
                              </div>
                            ) : runContextPanel.snapshot ? (
                              renderRunContextSnapshot(runContextPanel.snapshot)
                            ) : (
                              <div className="run-context-panel">
                                <p className="run-context-note">
                                  No saved context snapshot is available for
                                  this run.
                                </p>
                              </div>
                            )}
                          </section>
                        ) : null}
                        {run.status === 'failed' && run.errorMessage ? (
                          <p className="run-history-error">
                            {run.errorCode ? `${run.errorCode}: ` : ''}
                            {run.errorMessage}
                          </p>
                        ) : null}
                        {run.status === 'cancelled' && run.cancelReason ? (
                          <p className="run-history-muted">
                            Cancel reason: {run.cancelReason}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ) : null}

          {currentTab === 'talk' ? (
            <div
              ref={splitContainerRef}
              className={[
                'talk-tab-content',
                talkContent ? 'talk-tab-content-split' : '',
                talkContent && isNarrowViewport
                  ? 'talk-tab-content-split-narrow'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {talkContent && isNarrowViewport ? (
                <div
                  className="talk-tab-mobile-toggle"
                  role="tablist"
                  aria-label="Talk or document"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mobilePane === 'chat'}
                    className={`talk-tab-mobile-toggle-btn${
                      mobilePane === 'chat'
                        ? ' talk-tab-mobile-toggle-btn-active'
                        : ''
                    }`}
                    onClick={() => setMobilePane('chat')}
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mobilePane === 'doc'}
                    className={`talk-tab-mobile-toggle-btn${
                      mobilePane === 'doc'
                        ? ' talk-tab-mobile-toggle-btn-active'
                        : ''
                    }`}
                    onClick={() => {
                      // Switching to the doc tab also un-hides the
                      // doc pane — the narrow-viewport "Show doc"
                      // button does the same thing more explicitly.
                      if (docPaneHidden) setDocPaneHidden(false);
                      setMobilePane('doc');
                    }}
                  >
                    Doc
                  </button>
                  {docPaneHidden && mobilePane === 'chat' ? (
                    <button
                      ref={docNarrowShowBtnRef}
                      type="button"
                      className="talk-tab-mobile-show-doc"
                      onClick={() => {
                        setDocPaneHidden(false);
                        setMobilePane('doc');
                      }}
                    >
                      Show doc
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div
                className={[
                  'talk-tab-chat-pane',
                  talkContent && isNarrowViewport && mobilePane !== 'chat'
                    ? 'talk-tab-pane-hidden'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={
                  talkContent && !isNarrowViewport
                    ? { flex: `${chatRatio} 1 0` }
                    : undefined
                }
              >
                <div className="talk-thread-shell">
                  <aside className="talk-thread-rail" aria-label="Talk threads">
                    <div className="talk-thread-rail-header">
                      <h2>Threads</h2>
                      <ThreadStartButton
                        onClick={() => void handleCreateThread()}
                      />
                    </div>
                    <form
                      className="talk-thread-search"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void handleSearch();
                      }}
                    >
                      <input
                        type="search"
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder="Search threads"
                        aria-label="Search Talk messages"
                      />
                      <button
                        type="submit"
                        className="secondary-btn"
                        disabled={searchLoading}
                      >
                        {searchLoading ? 'Searching…' : 'Search'}
                      </button>
                    </form>
                    {searchError ? (
                      <p className="talk-thread-search-error" role="alert">
                        {searchError}
                      </p>
                    ) : null}
                    {searchResults.length > 0 ? (
                      <ul className="talk-thread-search-results">
                        {searchResults.map((result) => (
                          <li key={result.messageId}>
                            <button
                              type="button"
                              className="talk-thread-search-result"
                              onClick={() => handleSearchResultSelect(result)}
                            >
                              <strong>
                                {displayThreadTitle(result.threadTitle)}
                              </strong>
                              <span>{result.preview}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {threadState.error ? (
                      <p className="page-state" role="alert">
                        {threadState.error}
                      </p>
                    ) : null}
                    {threadState.loading ? (
                      <p className="page-state">Loading threads…</p>
                    ) : sortedThreads.length === 0 ? (
                      <p className="page-state">No threads yet.</p>
                    ) : (
                      <ul className="talk-thread-items">
                        {sortedThreads.map((thread) => (
                          <li key={thread.id}>
                            {editingThreadId === thread.id ? (
                              <div
                                className={`talk-thread-item${
                                  thread.id === activeThreadId
                                    ? ' talk-thread-item-active'
                                    : ''
                                } talk-thread-item-editing`}
                                onMouseDown={handleThreadSecondaryClick(
                                  thread.id,
                                )}
                                onContextMenu={handleThreadContextMenu(
                                  thread.id,
                                )}
                              >
                                <ThreadRowTitleEditor
                                  title={formatThreadLabel(thread)}
                                  isEditing={true}
                                  onSave={(title) =>
                                    handleRenameThread(thread.id, title)
                                  }
                                  onCancel={() => setEditingThreadId(null)}
                                  staticClassName="talk-thread-item-title"
                                  inputClassName="thread-row-title-input"
                                  errorClassName="thread-row-title-error"
                                  leadingVisual={
                                    thread.isPinned ? (
                                      <ThreadPinIcon />
                                    ) : undefined
                                  }
                                />
                                <span className="talk-thread-item-meta">
                                  {thread.messageCount} message
                                  {thread.messageCount === 1 ? '' : 's'} ·{' '}
                                  {formatDateTime(
                                    thread.lastMessageAt || thread.createdAt,
                                  )}
                                </span>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className={`talk-thread-item${
                                  thread.id === activeThreadId
                                    ? ' talk-thread-item-active'
                                    : ''
                                }`}
                                onClick={() => handleSelectThread(thread.id)}
                                onMouseDown={handleThreadSecondaryClick(
                                  thread.id,
                                )}
                                onContextMenu={handleThreadContextMenu(
                                  thread.id,
                                )}
                              >
                                <ThreadRowTitleEditor
                                  title={formatThreadLabel(thread)}
                                  isEditing={false}
                                  onSave={() => undefined}
                                  onCancel={() => undefined}
                                  staticClassName="talk-thread-item-title"
                                  inputClassName="thread-row-title-input"
                                  errorClassName="thread-row-title-error"
                                  leadingVisual={
                                    thread.isPinned ? (
                                      <ThreadPinIcon />
                                    ) : undefined
                                  }
                                />
                                <span className="talk-thread-item-meta">
                                  {thread.messageCount} message
                                  {thread.messageCount === 1 ? '' : 's'} ·{' '}
                                  {formatDateTime(
                                    thread.lastMessageAt || thread.createdAt,
                                  )}
                                </span>
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </aside>

                  <div className="talk-thread-detail">
                    <div
                      ref={timelineRef}
                      className="talk-thread-scroll"
                      aria-label="Talk timeline"
                    >
                      <div className="talk-thread-detail-header">
                        <div>
                          {activeThread ? (
                            <InlineEditableTitle
                              title={formatThreadLabel(activeThread)}
                              onSave={handleRenameActiveThread}
                              buttonClassName="thread-detail-title-button"
                              inputClassName="thread-detail-title-input"
                              errorClassName="thread-detail-title-error"
                            />
                          ) : (
                            <h2>New thread</h2>
                          )}
                          <p className="policy-muted">
                            Use <code>/edit</code> or the button here to remove
                            old messages from this thread.
                          </p>
                        </div>
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={openHistoryEditor}
                          disabled={!canEditHistory}
                        >
                          Edit history
                        </button>
                      </div>

                      {activeOrderedProgress ? (
                        <div className="talk-ordered-progress" role="status">
                          {activeOrderedProgress.label}
                        </div>
                      ) : null}
                      {latestOrderedRound ? (
                        <section
                          className="talk-ordered-summary"
                          aria-label="Ordered round summary"
                        >
                          <div className="talk-ordered-summary-header">
                            <strong className="talk-ordered-summary-title">
                              {latestOrderedRound.heading}
                            </strong>
                            {latestOrderedRound.note ? (
                              <span className="talk-ordered-summary-note">
                                {latestOrderedRound.note}
                              </span>
                            ) : null}
                            {latestOrderedRound.retryRunId ? (
                              <button
                                type="button"
                                className="run-history-link"
                                onClick={() =>
                                  void handleRetryAgentRun(
                                    latestOrderedRound.retryRunId!,
                                  )
                                }
                                disabled={
                                  retryRunState?.runId ===
                                    latestOrderedRound.retryRunId &&
                                  retryRunState.status === 'posting'
                                }
                              >
                                {retryRunState?.runId ===
                                  latestOrderedRound.retryRunId &&
                                retryRunState.status === 'posting'
                                  ? 'Retrying…'
                                  : 'Retry agent'}
                              </button>
                            ) : null}
                          </div>
                          <div className="talk-ordered-summary-steps">
                            {latestOrderedRound.steps.map((step) => (
                              <span
                                key={step.runId}
                                className={`talk-ordered-step talk-ordered-step-${step.tone}${
                                  step.isCurrent
                                    ? ' talk-ordered-step-current'
                                    : ''
                                }`}
                                aria-current={
                                  step.isCurrent ? 'step' : undefined
                                }
                              >
                                <span className="talk-ordered-step-index">
                                  {step.stepNumber}
                                </span>
                                <span className="talk-ordered-step-label">
                                  {step.label}
                                </span>
                                {step.isSynthesis ? (
                                  <span className="talk-ordered-step-tag">
                                    Synthesis
                                  </span>
                                ) : null}
                                <span className="talk-ordered-step-status">
                                  {step.statusLabel}
                                </span>
                              </span>
                            ))}
                          </div>
                          {latestOrderedRound.retryRunId &&
                          retryRunState?.runId ===
                            latestOrderedRound.retryRunId &&
                          retryRunState.status === 'error' ? (
                            <p className="run-history-error">
                              {retryRunState.message}
                            </p>
                          ) : null}
                        </section>
                      ) : null}

                      <div className="timeline talk-thread-timeline">
                        {!snapshotQuery.isPending &&
                        activeThread &&
                        olderMessagesAvailable &&
                        !loadingOlderMessages &&
                        pageMessages.length > 0 ? (
                          <button
                            type="button"
                            className="timeline-load-earlier"
                            onClick={() => void handleLoadOlderMessages()}
                          >
                            Load earlier messages
                          </button>
                        ) : null}
                        {loadingOlderMessages ? (
                          <p className="page-state">Loading earlier…</p>
                        ) : null}
                        {snapshotQuery.isPending ? (
                          <p className="page-state">Loading thread…</p>
                        ) : !activeThread ? (
                          <p className="page-state">No thread selected.</p>
                        ) : talkTimeline.length === 0 ? (
                          <div className="talk-onboarding-banner">
                            <p>
                              This Talk is using the default agent with all
                              tools enabled.{' '}
                              <Link
                                to={agentsTabHref}
                                className="talk-onboarding-link"
                              >
                                Customize →
                              </Link>
                            </p>
                            <p className="page-state">No messages yet.</p>
                          </div>
                        ) : (
                          talkTimeline.map((entry) => {
                            if (entry.kind === 'message') {
                              const { message } = entry;
                              const isSynthesis =
                                message.metadata?.isSynthesis === true;
                              const orderedRun = message.runId
                                ? state.runsById[message.runId]
                                : null;
                              const orderedGroupSize =
                                orderedRun?.responseGroupId
                                  ? (orderedGroupSizesById[
                                      orderedRun.responseGroupId
                                    ] ?? null)
                                  : null;
                              const orderedStepLabel =
                                orderedRun?.sequenceIndex != null &&
                                orderedGroupSize &&
                                orderedGroupSize > 1
                                  ? `Step ${orderedRun.sequenceIndex + 1} of ${orderedGroupSize}`
                                  : null;
                              const agentLabel =
                                (message.agentId &&
                                  agentLabelById[message.agentId]) ||
                                message.agentNickname ||
                                null;
                              const headerActorLabel =
                                message.role === 'assistant' && agentLabel
                                  ? agentLabel
                                  : agentLabel
                                    ? `${agentLabel} · ${message.role}`
                                    : message.role;
                              return (
                                <article
                                  key={entry.key}
                                  id={`message-${message.id}`}
                                  ref={(element) =>
                                    setMessageElementRef(message.id, element)
                                  }
                                  className={`message message-${message.role}${
                                    isSynthesis ? ' message-synthesis' : ''
                                  }`}
                                >
                                  <header>
                                    <strong>{headerActorLabel}</strong>
                                    {orderedStepLabel ? (
                                      <span className="message-sequence-badge">
                                        {orderedStepLabel}
                                      </span>
                                    ) : null}
                                    {isSynthesis ? (
                                      <span className="message-synthesis-badge">
                                        Synthesis
                                      </span>
                                    ) : null}
                                    <time>
                                      {new Date(
                                        message.createdAt,
                                      ).toLocaleString()}
                                    </time>
                                  </header>
                                  <p>
                                    {linkifyText(
                                      message.role === 'assistant'
                                        ? stripInternalAssistantText(
                                            message.content,
                                          )
                                        : message.content,
                                    )}
                                  </p>
                                  {message.attachments &&
                                  message.attachments.length > 0 ? (
                                    <div className="message-attachments">
                                      {message.attachments.map((att) => (
                                        <div
                                          key={att.id}
                                          className="message-attachment-item"
                                        >
                                          {isRenderableImageAttachment(
                                            att.mimeType,
                                          ) ? (
                                            <a
                                              href={buildTalkAttachmentContentUrl(
                                                talkId,
                                                att.id,
                                              )}
                                              target="_blank"
                                              rel="noreferrer"
                                              className="message-attachment-image-link"
                                            >
                                              <img
                                                src={buildTalkAttachmentContentUrl(
                                                  talkId,
                                                  att.id,
                                                )}
                                                alt={att.fileName}
                                                className="message-attachment-image"
                                              />
                                            </a>
                                          ) : null}
                                          <span
                                            className="message-attachment-chip"
                                            title={att.mimeType}
                                          >
                                            {att.fileName}
                                            <span className="message-attachment-size">
                                              {' '}
                                              {att.fileSize < 1024
                                                ? `${att.fileSize} B`
                                                : att.fileSize < 1048576
                                                  ? `${(att.fileSize / 1024).toFixed(1)} KB`
                                                  : `${(att.fileSize / 1048576).toFixed(1)} MB`}
                                            </span>
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : null}
                                </article>
                              );
                            }

                            if (entry.kind === 'browser-run') {
                              const { run } = entry;
                              return run.browserBlock ? (
                                <article
                                  key={entry.key}
                                  className="message message-system main-run-chip"
                                >
                                  <header>
                                    <strong>
                                      {run.targetAgentNickname || 'Browser'}
                                    </strong>
                                    <time>
                                      {new Date(
                                        run.browserBlock.updatedAt ||
                                          run.createdAt,
                                      ).toLocaleString()}
                                    </time>
                                  </header>
                                  <BrowserBlockedRunCard
                                    runId={run.id}
                                    browserBlock={run.browserBlock}
                                    executionDecision={run.executionDecision}
                                    talkId={talkId}
                                    onUnauthorized={handleUnauthorized}
                                    onStateChanged={refreshBrowserRuns}
                                  />
                                </article>
                              ) : null;
                            }

                            const { response } = entry;
                            const label =
                              (response.agentId &&
                                agentLabelById[response.agentId]) ||
                              response.agentNickname ||
                              'Assistant';
                            const failedRun = state.runsById[response.runId];
                            const canRetryAgent =
                              response.terminalStatus === 'failed' &&
                              failedRun?.errorCode === 'incomplete_response' &&
                              Boolean(
                                failedRun.triggerMessageId &&
                                failedRun.targetAgentId,
                              );
                            const retryPosting =
                              retryRunState?.runId === response.runId &&
                              retryRunState.status === 'posting';
                            const retryError =
                              retryRunState?.runId === response.runId &&
                              retryRunState.status === 'error'
                                ? retryRunState.message
                                : null;
                            return (
                              <LiveResponsePanel
                                key={entry.key}
                                panelKey={entry.key}
                                response={response}
                                run={failedRun}
                                agentLabel={label}
                                isDense={isDenseRound}
                                now={nowTick}
                                canRetryAgent={canRetryAgent}
                                retryPosting={retryPosting}
                                retryError={retryError}
                                onRetry={() =>
                                  void handleRetryAgentRun(response.runId)
                                }
                                onOpenRunHistory={() =>
                                  handleOpenRunHistory(response.runId)
                                }
                              />
                            );
                          })
                        )}
                      </div>

                      {state.hasUnreadBelow ? (
                        <button
                          type="button"
                          className="timeline-new-indicator"
                          onClick={handleClearUnread}
                        >
                          New messages
                        </button>
                      ) : null}

                      <div ref={endRef} />
                    </div>

                    <ToolChipsBar
                      talkId={talkId}
                      refreshKey={toolsRefreshKey}
                    />

                    <form
                      className="composer talk-workspace-composer"
                      onSubmit={handleSend}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept={ALLOWED_ATTACHMENT_EXTENSIONS}
                        onChange={handleFileInputChange}
                        style={{ display: 'none' }}
                      />
                      <div
                        className="composer-targets"
                        role="group"
                        aria-label="Selected agents"
                      >
                        {effectiveAgents.map((agent) => {
                          const selected = targetAgentIds.includes(agent.id);
                          const guardrail =
                            talkAgentExecutionGuardrailsById[agent.id];
                          const hasGuardrailViolation =
                            selectedGuardrailAgentIds.has(agent.id);
                          return (
                            <button
                              key={agent.id}
                              type="button"
                              className={`composer-target-chip${
                                selected ? ' composer-target-chip-selected' : ''
                              }${
                                hasGuardrailViolation
                                  ? ' composer-target-chip-warning'
                                  : ''
                              }`}
                              onClick={() => handleToggleTarget(agent.id)}
                              disabled={state.sendState.status === 'posting'}
                              aria-pressed={selected}
                              aria-label={
                                agent.isPrimary
                                  ? `${buildAgentLabel(agent)} Primary`
                                  : buildAgentLabel(agent)
                              }
                              title={guardrail?.message || undefined}
                            >
                              <span
                                className={`talk-status-dot talk-status-dot-${agent.health}`}
                                aria-hidden="true"
                              />
                              <span>{buildAgentChipLabel(agent)}</span>
                              {guardrail?.badgeLabel ? (
                                <span
                                  className={`talk-status-constraint talk-status-constraint-${guardrail.kind}`}
                                >
                                  {guardrail.badgeLabel}
                                </span>
                              ) : null}
                              {agent.isPrimary ? (
                                <span className="talk-status-primary">
                                  Primary
                                </span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                      <div className="composer-meta-row">
                        <p className="composer-target-help">
                          {composerTargetHelp}
                        </p>
                        <span className="composer-count">
                          {draft.length}/{TALK_MESSAGE_MAX_CHARS}
                        </span>
                      </div>
                      {composerGuardrailMessage ? (
                        <div
                          className="inline-banner inline-banner-warning"
                          role="status"
                          aria-live="polite"
                        >
                          {composerGuardrailMessage}
                        </div>
                      ) : null}

                      <div
                        className="composer-input-shell"
                        style={{ position: 'relative' }}
                      >
                        {mentionState && mentionOptions.length > 0 ? (
                          <SourceMentionPicker
                            options={mentionOptions}
                            selectedIndex={mentionState.selectedIndex}
                            onSelect={(option) => insertMentionOption(option)}
                            onDismiss={() => setMentionState(null)}
                          />
                        ) : null}
                        <textarea
                          ref={textareaRef}
                          value={draft}
                          onChange={(event) =>
                            handleDraftChange(event.target.value)
                          }
                          onKeyDown={handleComposerKeyDown}
                          placeholder={
                            talkContent ||
                            contextSources.some((s) => s.status === 'ready')
                              ? 'Send a message to this thread. Type @ to reference a saved source or the doc.'
                              : 'Send a message to this thread.'
                          }
                          rows={1}
                          maxLength={TALK_MESSAGE_MAX_CHARS}
                          disabled={
                            state.sendState.status === 'posting' ||
                            activeRound ||
                            hasUnsavedAgentChanges ||
                            !activeThreadId
                          }
                        />

                        {pendingAttachments.length > 0 ? (
                          <div className="composer-attachments">
                            {pendingAttachments.map((att) => (
                              <span
                                key={att.localId}
                                className={`composer-attachment-chip composer-attachment-${att.status}`}
                                title={
                                  att.status === 'error'
                                    ? att.errorMessage
                                    : att.fileName
                                }
                              >
                                {att.isImage && att.previewUrl ? (
                                  <img
                                    src={att.previewUrl}
                                    alt={att.fileName}
                                    className="composer-attachment-preview"
                                  />
                                ) : null}
                                <span className="composer-attachment-name">
                                  {att.fileName}
                                </span>
                                {att.status === 'uploading' ? (
                                  <span className="composer-attachment-status">
                                    {' '}
                                    uploading…
                                  </span>
                                ) : null}
                                {att.status === 'error' ? (
                                  <span className="composer-attachment-status">
                                    {' '}
                                    failed
                                  </span>
                                ) : null}
                                <button
                                  type="button"
                                  className="composer-attachment-remove"
                                  onClick={() =>
                                    handleRemoveAttachment(att.localId)
                                  }
                                  aria-label={`Remove ${att.fileName}`}
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                        ) : null}

                        <div className="composer-controls">
                          <div className="composer-tool-buttons">
                            <button
                              type="button"
                              className="composer-icon-btn composer-attach-btn"
                              onClick={handleAttachButtonClick}
                              disabled={
                                state.sendState.status === 'posting' ||
                                activeRound ||
                                hasUnsavedAgentChanges ||
                                !activeThreadId
                              }
                              aria-label="Attach"
                              title="Attach files"
                            >
                              <ComposerAttachIcon />
                            </button>
                            {canEditAgents && activeRound ? (
                              <button
                                type="button"
                                className="composer-icon-btn composer-cancel-btn"
                                onClick={handleCancelRuns}
                                disabled={
                                  state.cancelState.status === 'posting'
                                }
                                aria-label="Cancel Runs"
                                title={
                                  state.cancelState.status === 'posting'
                                    ? 'Cancelling runs…'
                                    : 'Cancel runs'
                                }
                              >
                                <ComposerCancelRunsIcon />
                              </button>
                            ) : null}
                          </div>
                          <button
                            type="submit"
                            className="composer-icon-btn composer-send-btn"
                            disabled={
                              state.sendState.status === 'posting' ||
                              activeRound ||
                              hasUnsavedAgentChanges ||
                              !activeThreadId ||
                              sendBlockedByGuardrail
                            }
                            aria-label="Send"
                            title={
                              state.sendState.status === 'posting'
                                ? 'Sending…'
                                : 'Send'
                            }
                          >
                            <ComposerSendIcon />
                          </button>
                        </div>
                      </div>

                      {activeRound ? (
                        <div
                          className="inline-banner inline-banner-warning"
                          role="status"
                        >
                          Wait for the current round to finish or cancel it
                          before sending another message.
                        </div>
                      ) : null}

                      {!activeRound && hasUnsavedAgentChanges ? (
                        <div
                          className="inline-banner inline-banner-warning"
                          role="status"
                        >
                          Save agent changes before sending a message.
                        </div>
                      ) : null}

                      {state.sendState.status === 'error' ? (
                        <div
                          className="inline-banner inline-banner-error"
                          role="alert"
                        >
                          {state.sendState.error || 'Unable to send message.'}
                        </div>
                      ) : null}

                      {historyEditState.status === 'success' ? (
                        <div
                          className="inline-banner inline-banner-success"
                          role="status"
                        >
                          {historyEditState.message}
                        </div>
                      ) : null}

                      {historyEditState.status === 'error' ? (
                        <div
                          className="inline-banner inline-banner-error"
                          role="alert"
                        >
                          {historyEditState.message}
                        </div>
                      ) : null}

                      {state.cancelState.status === 'success' ? (
                        <div
                          className="inline-banner inline-banner-success"
                          role="status"
                        >
                          {state.cancelState.message}
                        </div>
                      ) : null}

                      {state.cancelState.status === 'error' ? (
                        <div
                          className="inline-banner inline-banner-error"
                          role="alert"
                        >
                          {state.cancelState.message}
                        </div>
                      ) : null}
                    </form>
                  </div>
                  {threadMenu && menuThread ? (
                    <ThreadContextMenu
                      x={threadMenu.x}
                      y={threadMenu.y}
                      isPinned={menuThread.isPinned}
                      canDelete={!menuThread.isDefault}
                      onClose={() => setThreadMenu(null)}
                      onRename={() => setEditingThreadId(menuThread.id)}
                      onTogglePin={() => {
                        void updateThreadMetadata(menuThread.id, {
                          pinned: !menuThread.isPinned,
                        }).catch((err) => {
                          setThreadState((current) => ({
                            ...current,
                            error:
                              err instanceof Error
                                ? err.message
                                : 'Failed to update thread.',
                          }));
                        });
                      }}
                      onDelete={() => void handleDeleteThread(menuThread)}
                    />
                  ) : null}
                </div>
              </div>
              {talkContent && !isNarrowViewport && !docPaneHidden ? (
                <div
                  ref={splitHandleRef}
                  className="talk-tab-split-handle"
                  role="separator"
                  aria-orientation="vertical"
                  aria-valuemin={20}
                  aria-valuemax={80}
                  aria-valuenow={Math.round(chatRatio * 100)}
                  aria-label="Resize chat and document panes"
                  tabIndex={0}
                  onKeyDown={handleResizeHandleKeyDown}
                />
              ) : null}
              {talkContent && docPaneHidden && !isNarrowViewport ? (
                <DocPaneEdgeTab
                  docTitle={talkContent.title}
                  format={talkContent.contentFormat}
                  onClick={handleShowDocPane}
                />
              ) : null}
              {talkContent ? (
                <section
                  className={[
                    'talk-tab-doc-pane',
                    (isNarrowViewport && mobilePane !== 'doc') ||
                    (!isNarrowViewport && docPaneHidden)
                      ? 'talk-tab-pane-hidden'
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={
                    !isNarrowViewport && !docPaneHidden
                      ? { flex: `${1 - chatRatio} 1 0` }
                      : undefined
                  }
                  aria-label="Talk document"
                >
                  <DocPaneHeader
                    title={talkContent.title}
                    onTitleSave={handleDocTitleSave}
                    format={talkContent.contentFormat}
                    saveStatus={talkContentSaveStatus}
                    loading={talkContentLoading}
                    mode={
                      talkContent.contentFormat === 'html'
                        ? htmlMode
                        : undefined
                    }
                    onModeChange={
                      talkContent.contentFormat === 'html'
                        ? setHtmlMode
                        : undefined
                    }
                    copyExportSlot={
                      <CopyExportMenu
                        format={talkContent.contentFormat}
                        bodyMarkdown={talkContent.bodyMarkdown}
                        bodyHtml={talkContent.bodyHtml}
                        documentTitle={talkContent.title}
                      />
                    }
                    onHidePane={handleHideDocPane}
                    sanitizeWarning={null}
                  />
                  {talkContentConflict ? (
                    <div
                      className="talk-tab-doc-conflict"
                      role="alert"
                      aria-live="assertive"
                    >
                      <span>
                        This document changed elsewhere. Reload to see the
                        latest version — your unsaved edits will be lost.
                      </span>
                      <button
                        type="button"
                        className="talk-tab-doc-conflict-button"
                        onClick={() => {
                          setTalkContentConflict(false);
                          setTalkContentSaveStatus('idle');
                          void refetchTalkContent();
                        }}
                      >
                        Reload
                      </button>
                    </div>
                  ) : null}
                  {talkContentError ? (
                    <p className="page-state" role="alert">
                      {talkContentError}
                    </p>
                  ) : talkContent.contentFormat === 'html' ? (
                    htmlMode === 'source' ? (
                      <HtmlEditorErrorBoundary>
                        <Suspense
                          fallback={
                            <div className="talk-tab-doc-body" aria-busy="true">
                              Loading editor…
                            </div>
                          }
                        >
                          <div
                            className="talk-tab-doc-body"
                            ref={docBodyRef}
                            tabIndex={-1}
                          >
                            <LazyHtmlSourceEditor
                              value={htmlSourceDraft}
                              onChange={handleHtmlSourceChange}
                              onSave={
                                canEditDoc && !talkContentConflict
                                  ? handleHtmlSourceSave
                                  : undefined
                              }
                              readOnly={!canEditDoc || talkContentConflict}
                              placeholder="Ask an agent to generate, or type HTML"
                            />
                          </div>
                        </Suspense>
                      </HtmlEditorErrorBoundary>
                    ) : (
                      <div
                        ref={docBodyRef}
                        tabIndex={-1}
                        className="talk-tab-doc-body-wrap"
                      >
                        <SafeHtml
                          html={talkContent.bodyHtml ?? ''}
                          className="talk-tab-doc-body"
                        />
                      </div>
                    )
                  ) : (
                    <div
                      className="talk-tab-doc-body"
                      ref={docBodyRef}
                      tabIndex={-1}
                    >
                      <PendingEditDocSurface
                        content={talkContent}
                        pendingEdits={talkContentPendingEdits}
                        streamingByRunId={pendingEditStreamingByRunId}
                        inFlightEditIds={pendingEditInFlight}
                        canEditDoc={canEditDoc}
                        conflict={talkContentConflict}
                        onSaved={(content) =>
                          setTalkContent((current) =>
                            current && current.id === content.id
                              ? content
                              : current,
                          )
                        }
                        onConflict={() => setTalkContentConflict(true)}
                        onError={(err) => setTalkContentError(err.message)}
                        onStatusChange={setTalkContentSaveStatus}
                        setPendingEdits={setTalkContentPendingEdits}
                        setInFlightEditIds={setPendingEditInFlight}
                        refetchTalkContent={refetchTalkContent}
                      />
                    </div>
                  )}
                </section>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <TalkHistoryEditor
        isOpen={historyEditorOpen}
        messages={pageMessages}
        busy={historyEditState.status === 'saving'}
        errorMessage={
          historyEditorOpen && historyEditState.status === 'error'
            ? historyEditState.message || null
            : null
        }
        onClose={handleCloseHistoryEditor}
        onConfirm={handleDeleteHistoryMessages}
        resolveActorLabel={resolveMessageActorLabel}
      />
      {docModalOpen ? (
        <div
          className="doc-promote-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="doc-promote-modal-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDocModal();
          }}
        >
          <form className="doc-promote-modal" onSubmit={handleCreateDoc}>
            <h3 id="doc-promote-modal-title">Add a document</h3>
            <label
              className="doc-promote-modal-label"
              htmlFor="doc-promote-modal-input"
            >
              Title
            </label>
            <input
              id="doc-promote-modal-input"
              ref={docModalInputRef}
              type="text"
              className="doc-promote-modal-input"
              value={docModalTitle}
              onChange={(event) => setDocModalTitle(event.target.value)}
              placeholder="Untitled document"
              maxLength={160}
              disabled={docModalSubmitting}
              autoComplete="off"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeDocModal();
                }
              }}
            />
            <fieldset
              className="doc-promote-modal-format"
              disabled={docModalSubmitting}
            >
              <legend className="doc-promote-modal-label">Format</legend>
              <label className="doc-promote-modal-format-option">
                <input
                  type="radio"
                  name="doc-promote-modal-format"
                  value="markdown"
                  checked={docModalFormat === 'markdown'}
                  onChange={() => setDocModalFormat('markdown')}
                />
                Markdown
              </label>
              <label className="doc-promote-modal-format-option">
                <input
                  type="radio"
                  name="doc-promote-modal-format"
                  value="html"
                  checked={docModalFormat === 'html'}
                  onChange={() => setDocModalFormat('html')}
                />
                HTML
              </label>
            </fieldset>
            {docModalError ? (
              <p className="doc-promote-modal-error" role="alert">
                {docModalError}
              </p>
            ) : null}
            <div className="doc-promote-modal-actions">
              <button
                type="button"
                className="doc-promote-modal-cancel"
                onClick={closeDocModal}
                disabled={docModalSubmitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="doc-promote-modal-submit"
                disabled={docModalSubmitting || !docModalTitle.trim()}
              >
                {docModalSubmitting ? 'Creating…' : 'Create document'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}
