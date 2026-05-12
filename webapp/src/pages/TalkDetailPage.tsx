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
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
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
  connectUserGoogleAccount,
  ContextGoal,
  ContextRule,
  ContextSource,
  createTalkThread,
  createTalkGoogleDriveResource,
  createTalkChannel,
  createTalkContextRule,
  createTalkContextSource,
  createTalkOutput,
  createTalkJob,
  DataConnector,
  clearTalkProjectMount,
  deleteTalkResource,
  deleteTalkChannel,
  deleteTalkChannelBindingState,
  deleteTalkChannelDeliveryFailure,
  deleteTalkChannelIngressFailure,
  deleteTalkMessages,
  deleteTalkThread,
  deleteTalkContextRule,
  deleteTalkContextSource,
  deleteTalkOutput,
  deleteTalkJob,
  deleteTalkStateEntry,
  detachTalkDataConnector,
  expandUserGoogleScopes,
  getAiAgents,
  getDataConnectors,
  getGooglePickerSession,
  getTalk,
  getTalkAgents,
  getTalkOutput,
  getTalkJob,
  getTalkState,
  getTalkTools,
  getTalkContext,
  getTalkRunContext,
  getTalkDataConnectors,
  getTalkRuns,
  listTalkJobRuns,
  listTalkJobs,
  listTalkOutputs,
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
  patchTalkOutput,
  patchTalkJob,
  retryTalkChannelDeliveryFailure,
  retryTalkChannelIngressFailure,
  retryTalkContextSource,
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
  TalkTools,
  TalkChannelBinding,
  TalkChannelBindingStateEntry,
  TalkDataConnector,
  TalkMessage,
  TalkMessageSearchResult,
  TalkMessageAttachment,
  TalkRun,
  TalkRunContextSnapshot,
  TalkOutput,
  TalkOutputSummary,
  TalkStateEntry,
  TalkThread,
  uploadTalkAttachment,
  uploadTalkContextSource,
  testTalkChannelBinding,
  unquarantineTalkChannelBinding,
  retryTalkChannelDeliveryFailuresCapped,
  updateTalkProjectMount,
  upsertTalkChannelBindingState,
  updateTalkTools,
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
import { ExecutionDecisionSummary } from '../components/ExecutionDecisionSummary';
import { InlineEditableTitle } from '../components/InlineEditableTitle';
import { ThreadContextMenu } from '../components/ThreadContextMenu';
import { ThreadRowTitleEditor } from '../components/ThreadRowTitleEditor';
import { ThreadStartButton } from '../components/ThreadStartButton';
import { TalkHistoryEditor } from '../components/TalkHistoryEditor';
import { stripInternalAssistantText } from '../lib/assistantText';
import { launchGoogleAccountPopup } from '../lib/googleAccountPopup';
import { openGoogleDrivePicker } from '../lib/googlePicker';
import { displayThreadTitle } from '../lib/threadTitles';
import { openTalkStream } from '../lib/talkStream';
import type {
  TalkBrowserBlockedEvent,
  TalkBrowserUnblockedEvent,
  MessageAppendedEvent,
  TalkHistoryEditedEvent,
  TalkProgressUpdateEvent,
  TalkResponseDeltaEvent,
  TalkResponseStartedEvent,
  TalkResponseTerminalEvent,
  TalkResponseUsageEvent,
  TalkRunCancelledEvent,
  TalkRunCompletedEvent,
  TalkRunFailedEvent,
  TalkRunStartedEvent,
  TalkStreamState,
} from '../lib/talkStream';

type TabKey =
  | 'talk'
  | 'agents'
  | 'jobs'
  | 'tools'
  | 'context'
  | 'rules'
  | 'state'
  | 'outputs'
  | 'channels'
  | 'data-connectors'
  | 'runs';

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

const SETTINGS_TAB_KEYS: ReadonlyArray<
  Extract<
    TabKey,
    'context' | 'rules' | 'tools' | 'state' | 'channels' | 'data-connectors'
  >
> = ['context', 'rules', 'tools', 'state', 'channels', 'data-connectors'];

function isSettingsTabKey(tab: TabKey): boolean {
  return SETTINGS_TAB_KEYS.includes(tab as (typeof SETTINGS_TAB_KEYS)[number]);
}

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

type LiveResponseView = {
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
  errorMessage?: string;
  startedAt: number;
  terminalStatus?: 'failed';
};

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
  deliverableKind: 'thread' | 'report';
  reportTargetMode: 'existing' | 'create';
  reportOutputId: string;
  createReportTitle: string;
  createReportContentMarkdown: string;
  connectorIds: string[];
  channelBindingIds: string[];
  allowWeb: boolean;
};

type DetailState = {
  kind: 'loading' | 'ready' | 'unavailable' | 'error';
  talk: Talk | null;
  errorMessage: string | null;
  selectedThreadId: string | null;
  messages: TalkMessage[];
  messageIds: Set<string>;
  messagesLoading: boolean;
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
  initialScrollPending: boolean;
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
    deliverableKind: 'thread',
    reportTargetMode: 'existing',
    reportOutputId: '',
    createReportTitle: '',
    createReportContentMarkdown: '',
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
    deliverableKind: job.deliverableKind,
    reportTargetMode: 'existing',
    reportOutputId: job.reportOutputId ?? '',
    createReportTitle: '',
    createReportContentMarkdown: '',
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
  | { type: 'BOOTSTRAP_LOADING' }
  | {
      type: 'BOOTSTRAP_READY';
      talk: Talk;
      runs: TalkRun[];
    }
  | { type: 'BOOTSTRAP_ERROR'; unavailable: boolean; message: string }
  | { type: 'TALK_UPDATED'; talk: Talk }
  | { type: 'THREAD_MESSAGES_LOADING'; threadId: string }
  | {
      type: 'THREAD_MESSAGES_LOADED';
      threadId: string;
      messages: TalkMessage[];
    }
  | { type: 'THREAD_MESSAGES_FAILED'; threadId: string; message: string }
  | {
      type: 'RESET_FROM_RESYNC';
      threadId: string;
      messages: TalkMessage[];
      runs: TalkRun[];
    }
  | {
      type: 'MESSAGE_APPENDED';
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
      {snapshot.outputs.manifest.length > 0 ? (
        <div className="run-context-section">
          <strong>Outputs Manifest</strong>
          <ul>
            {snapshot.outputs.manifest.map((output) => (
              <li key={output.id}>
                <code>{output.id}</code> {output.title} · v{output.version} ·{' '}
                {output.contentLength} chars
              </li>
            ))}
          </ul>
          {snapshot.outputs.omittedCount > 0 ? (
            <p className="run-context-meta">
              {snapshot.outputs.omittedCount} additional outputs omitted from
              the default manifest.
            </p>
          ) : null}
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
    kind: 'loading',
    talk: null,
    errorMessage: null,
    selectedThreadId: null,
    messages: [],
    messageIds: new Set<string>(),
    messagesLoading: false,
    runsById: {},
    streamState: 'connecting',
    sendState: { status: 'idle' },
    liveResponsesByRunId: {},
    cancelState: { status: 'idle' },
    hasUnreadBelow: false,
    initialScrollPending: false,
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
    case 'BOOTSTRAP_LOADING':
      return {
        ...createInitialDetailState(),
        kind: 'loading',
      };
    case 'BOOTSTRAP_READY':
      return {
        kind: 'ready',
        talk: action.talk,
        errorMessage: null,
        selectedThreadId: null,
        messages: [],
        messageIds: new Set<string>(),
        messagesLoading: false,
        runsById: mapRunsById(action.runs),
        streamState: 'connecting',
        sendState: { status: 'idle' },
        liveResponsesByRunId: {},
        cancelState: { status: 'idle' },
        hasUnreadBelow: false,
        initialScrollPending: true,
      };
    case 'BOOTSTRAP_ERROR':
      return {
        ...createInitialDetailState(),
        kind: action.unavailable ? 'unavailable' : 'error',
        errorMessage: action.message,
        streamState: 'offline',
      };
    case 'TALK_UPDATED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        talk: action.talk,
      };
    case 'THREAD_MESSAGES_LOADING':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        selectedThreadId: action.threadId,
        messages: [],
        messageIds: new Set<string>(),
        messagesLoading: true,
        liveResponsesByRunId: {},
        hasUnreadBelow: false,
        initialScrollPending: false,
      };
    case 'THREAD_MESSAGES_LOADED':
      if (state.kind !== 'ready') return state;
      if (action.threadId !== state.selectedThreadId) return state;
      return {
        ...state,
        messages: action.messages,
        messageIds: new Set(action.messages.map((message) => message.id)),
        messagesLoading: false,
        liveResponsesByRunId: {},
        hasUnreadBelow: false,
        initialScrollPending: true,
      };
    case 'THREAD_MESSAGES_FAILED':
      if (state.kind !== 'ready') return state;
      if (action.threadId !== state.selectedThreadId) return state;
      return {
        ...state,
        messages: [],
        messageIds: new Set<string>(),
        messagesLoading: false,
        sendState: { status: 'error', error: action.message },
      };
    case 'RESET_FROM_RESYNC':
      if (state.kind !== 'ready') return state;
      if (action.threadId !== state.selectedThreadId) return state;
      return {
        ...state,
        messages: action.messages,
        messageIds: new Set(action.messages.map((message) => message.id)),
        messagesLoading: false,
        runsById: pruneEventRunCache(mapRunsById(action.runs)),
        liveResponsesByRunId: {},
        hasUnreadBelow: false,
        initialScrollPending: false,
      };
    case 'MESSAGE_APPENDED': {
      if (state.kind !== 'ready') return state;
      if (state.messageIds.has(action.message.id)) return state;

      const messages = [...state.messages, action.message];
      const messageIds = new Set(state.messageIds);
      messageIds.add(action.message.id);
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
        messages,
        messageIds,
        liveResponsesByRunId,
        hasUnreadBelow:
          state.initialScrollPending || action.wasNearBottom
            ? false
            : state.hasUnreadBelow || true,
      };
    }
    case 'RUN_STARTED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        runsById: withRun(state, action.runId, {
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
        }),
      };
    case 'RUN_QUEUED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        runsById: withRun(state, action.runId, {
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
        }),
      };
    case 'RUN_COMPLETED': {
      if (state.kind !== 'ready') return state;
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      delete liveResponsesByRunId[action.runId];
      return {
        ...state,
        liveResponsesByRunId,
        runsById: withRun(state, action.runId, {
          threadId: action.threadId || undefined,
          status: 'completed',
          triggerMessageId: action.triggerMessageId,
          executorAlias: action.executorAlias,
          executorModel: action.executorModel,
          completedAt: new Date().toISOString(),
          responseGroupId: action.responseGroupId,
          sequenceIndex: action.sequenceIndex,
        }),
      };
    }
    case 'RUN_FAILED': {
      if (state.kind !== 'ready') return state;
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
            errorMessage: action.errorMessage,
            startedAt: existing?.startedAt || Date.now(),
            terminalStatus: 'failed',
          },
        },
        runsById,
      };
    }
    case 'RUN_CANCELLED_BATCH': {
      if (state.kind !== 'ready' || action.runIds.length === 0) return state;
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      for (const runId of action.runIds) {
        delete liveResponsesByRunId[runId];
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
    case 'RESPONSE_STARTED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.event.runId]: {
            runId: action.event.runId,
            rawText: '',
            text: '',
            progressMessage: undefined,
            agentId: action.event.agentId,
            agentNickname: action.event.agentNickname,
            responseGroupId: action.event.responseGroupId ?? null,
            sequenceIndex: action.event.sequenceIndex ?? null,
            providerId: action.event.providerId,
            modelId: action.event.modelId,
            startedAt: Date.now(),
          },
        },
      };
    case 'RESPONSE_PROGRESS': {
      if (state.kind !== 'ready') return state;
      const existing = state.liveResponsesByRunId[action.event.runId];
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
            startedAt: existing?.startedAt || Date.now(),
            errorMessage: existing?.errorMessage,
            terminalStatus: existing?.terminalStatus,
          },
        },
      };
    }
    case 'RESPONSE_DELTA': {
      if (state.kind !== 'ready') return state;
      const existing = state.liveResponsesByRunId[action.event.runId];
      const rawText = `${existing?.rawText || ''}${action.event.deltaText}`;
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
            startedAt: existing?.startedAt || Date.now(),
            errorMessage: existing?.errorMessage,
            terminalStatus: existing?.terminalStatus,
          },
        },
      };
    }
    case 'RESPONSE_COMPLETED':
      return state;
    case 'RESPONSE_FAILED': {
      if (state.kind !== 'ready') return state;
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
            startedAt: existing?.startedAt || Date.now(),
            progressMessage: existing?.progressMessage,
            errorMessage: action.event.errorMessage,
            terminalStatus: 'failed',
          },
        },
      };
    }
    case 'RESPONSE_CANCELLED': {
      if (state.kind !== 'ready') return state;
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      delete liveResponsesByRunId[action.event.runId];
      return { ...state, liveResponsesByRunId };
    }
    case 'STREAM_CONNECTING':
      if (state.kind !== 'ready') return state;
      return { ...state, streamState: 'connecting' };
    case 'STREAM_LIVE':
      if (state.kind !== 'ready') return state;
      return { ...state, streamState: 'live' };
    case 'STREAM_RECONNECTING':
      if (state.kind !== 'ready') return state;
      return { ...state, streamState: 'reconnecting' };
    case 'STREAM_OFFLINE':
      if (state.kind !== 'ready') return state;
      return { ...state, streamState: 'offline' };
    case 'SEND_STARTED':
      if (state.kind !== 'ready') return state;
      return { ...state, sendState: { status: 'posting' } };
    case 'SEND_FAILED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        sendState: {
          status: 'error',
          error: action.message,
          lastDraft: action.lastDraft,
        },
      };
    case 'SEND_CLEARED':
      if (state.kind !== 'ready') return state;
      return { ...state, sendState: { status: 'idle' } };
    case 'CANCEL_STARTED':
      if (state.kind !== 'ready') return state;
      return { ...state, cancelState: { status: 'posting' } };
    case 'CANCEL_SUCCEEDED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        cancelState: { status: 'success', message: action.message },
      };
    case 'CANCEL_FAILED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        cancelState: { status: 'error', message: action.message },
      };
    case 'CLEAR_UNREAD':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        hasUnreadBelow: false,
        initialScrollPending: false,
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
  if (pathname === `${base}/jobs`) return 'jobs';
  if (pathname === `${base}/tools`) return 'tools';
  if (pathname === `${base}/context`) return 'context';
  if (pathname === `${base}/rules`) return 'rules';
  if (pathname === `${base}/state`) return 'state';
  if (pathname === `${base}/outputs`) return 'outputs';
  if (pathname === `${base}/channels`) return 'channels';
  if (pathname === `${base}/data-connectors`) return 'data-connectors';
  if (pathname === `${base}/runs`) return 'runs';
  return 'talk';
}

function formatToolAccessState(state: string): string {
  switch (state) {
    case 'available':
      return 'Available';
    case 'unavailable_due_to_route':
      return 'Route blocked';
    case 'unavailable_due_to_identity':
      return 'Needs Google account';
    case 'unavailable_due_to_pending_scopes':
      return 'Needs Google permissions';
    case 'unavailable_due_to_scope':
      return 'Scope expansion required';
    case 'unavailable_due_to_missing_resource':
      return 'Missing resource';
    case 'unavailable_due_to_config':
    default:
      return 'Disabled';
  }
}

// Keep this mapping in sync with src/clawrocket/web/routes/talk-tools.ts.
function requiredScopesForTool(toolId: string): string[] {
  switch (toolId) {
    case 'gmail_read':
      return ['gmail.readonly'];
    case 'gmail_send':
      return ['gmail.send'];
    case 'google_drive_search':
    case 'google_drive_read':
    case 'google_drive_list_folder':
      return ['drive.readonly'];
    case 'google_docs_read':
      return ['documents.readonly'];
    case 'google_docs_batch_update':
      return ['documents'];
    case 'google_sheets_read_range':
      return ['spreadsheets.readonly'];
    case 'google_sheets_batch_update':
      return ['spreadsheets'];
    default:
      return [];
  }
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
  return data.additionalProviders.filter((provider) => provider.hasCredential);
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
  aiAgents: AiAgentsPageData | null,
): boolean {
  const modelId = agent.modelId?.trim();
  if (!modelId) return false;

  const suggestions = getModelSuggestionsForSource({
    sourceKind: agent.sourceKind,
    providerId: agent.providerId,
    aiAgents,
  });
  return suggestions.some(
    (entry) => entry.modelId === modelId && entry.supportsVision,
  );
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

export function TalkDetailPage({
  onUnauthorized,
  titleOverride,
  renameDraft,
  onRenameDraftChange,
  onRenameDraftCancel,
  onRenameDraftCommit,
}: {
  onUnauthorized: () => void;
  titleOverride?: string | null;
  renameDraft: { talkId: string; draft: string } | null;
  onRenameDraftChange: (talkId: string, draft: string) => void;
  onRenameDraftCancel: (talkId: string) => void;
  onRenameDraftCommit: (talkId: string, draft: string) => Promise<void>;
}): JSX.Element {
  const { talkId = '' } = useParams<{ talkId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const currentTab = getTabFromPath(location.pathname, talkId);
  const locationParams = new URLSearchParams(location.search);
  const requestedThreadId = locationParams.get('thread')?.trim() || null;
  const googleToolsError =
    locationParams.get('googleToolsError')?.trim() || null;
  const [state, dispatch] = useReducer(
    detailReducer,
    undefined,
    createInitialDetailState,
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
  const threadSnapshotVersionRef = useRef(0);
  const deletedMessageIdsRef = useRef<Set<string>>(new Set());
  const threadStateRef = useRef<ThreadListState>(threadState);
  const searchQueryRef = useRef(searchQuery);
  const orchestrationMenuRef = useRef<HTMLDivElement | null>(null);
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
  const [talkTools, setTalkTools] = useState<TalkTools | null>(null);
  const [toolGrantDrafts, setToolGrantDrafts] = useState<
    Record<string, boolean>
  >({});
  const [toolStatus, setToolStatus] = useState<{
    status: 'idle' | 'loading' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });
  const [driveBindingDraft, setDriveBindingDraft] = useState<{
    bindingKind: 'google_drive_folder' | 'google_drive_file';
    externalId: string;
    displayName: string;
  }>({
    bindingKind: 'google_drive_folder',
    externalId: '',
    displayName: '',
  });
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
  const [projectPathDraft, setProjectPathDraft] = useState('');
  const [projectPathState, setProjectPathState] = useState<{
    status: 'idle' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });

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
  const [talkOutputs, setTalkOutputs] = useState<TalkOutputSummary[]>([]);
  const [talkOutputsLoaded, setTalkOutputsLoaded] = useState(false);
  const [talkOutputsStatus, setTalkOutputsStatus] = useState<{
    status: 'idle' | 'loading' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });
  const [selectedOutputId, setSelectedOutputId] = useState<string | null>(null);
  const [selectedOutput, setSelectedOutput] = useState<TalkOutput | null>(null);
  const [selectedOutputStatus, setSelectedOutputStatus] = useState<{
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
  const [outputTitleDraft, setOutputTitleDraft] = useState('');
  const [outputBodyDraft, setOutputBodyDraft] = useState('');
  const [goalDraft, setGoalDraft] = useState('');
  const [newRuleText, setNewRuleText] = useState('');
  const [addSourceUrl, setAddSourceUrl] = useState('');
  const [addSourceText, setAddSourceText] = useState('');
  const [addSourceTitle, setAddSourceTitle] = useState('');
  const [contextUploadingFiles, setContextUploadingFiles] = useState<
    Array<{
      localId: string;
      fileName: string;
      status: 'uploading' | 'done' | 'error';
      error?: string;
    }>
  >([]);
  const [contextDropActive, setContextDropActive] = useState(false);
  const contextFileInputRef = useRef<HTMLInputElement>(null);
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

  const isNearBottom = useCallback((): boolean => {
    const container = timelineRef.current;
    if (!container) return true;
    const distanceToBottom =
      container.scrollHeight - (container.scrollTop + container.clientHeight);
    return distanceToBottom <= SCROLL_STICK_THRESHOLD_PX;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    endRef.current?.scrollIntoView({ behavior, block: 'end' });
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
  }, []);

  const filterDeletedMessages = useCallback((messages: TalkMessage[]) => {
    if (deletedMessageIdsRef.current.size === 0) return messages;
    return messages.filter(
      (message) => !deletedMessageIdsRef.current.has(message.id),
    );
  }, []);

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
      try {
        const [threads, messages, runs] = await Promise.all([
          options?.refreshThreads === false
            ? Promise.resolve(null)
            : listTalkThreads(talkId),
          listTalkMessages(talkId, { threadId }),
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
        dispatch({
          type: 'RESET_FROM_RESYNC',
          threadId,
          messages: filterDeletedMessages(messages),
          runs,
        });
        autoStickToBottomRef.current = true;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
        }
      }
    },
    [filterDeletedMessages, handleUnauthorized, talkId],
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

  const loadOutputDetail = useCallback(
    async (outputId: string, options?: { showLoading?: boolean }) => {
      if (options?.showLoading) {
        setSelectedOutputStatus({ status: 'loading' });
      }
      const output = await getTalkOutput({ talkId, outputId });
      setSelectedOutputId(output.id);
      setSelectedOutput(output);
      setOutputTitleDraft(output.title);
      setOutputBodyDraft(output.contentMarkdown);
      setSelectedOutputStatus({ status: 'idle' });
      return output;
    },
    [talkId],
  );

  const refreshTalkOutputs = useCallback(
    async (options?: {
      showLoading?: boolean;
      preserveSelection?: boolean;
    }) => {
      if (options?.showLoading) {
        setTalkOutputsStatus({ status: 'loading' });
      }
      const outputs = await listTalkOutputs(talkId);
      setTalkOutputs(outputs);
      setTalkOutputsLoaded(true);
      setTalkOutputsStatus({ status: 'idle' });

      const preferredId = options?.preserveSelection ? selectedOutputId : null;
      const nextSelectedId =
        (preferredId &&
          outputs.some((output) => output.id === preferredId) &&
          preferredId) ||
        (selectedOutputId &&
          outputs.some((output) => output.id === selectedOutputId) &&
          selectedOutputId) ||
        outputs[0]?.id ||
        null;

      if (!nextSelectedId) {
        setSelectedOutputId(null);
        setSelectedOutput(null);
        setOutputTitleDraft('');
        setOutputBodyDraft('');
        setSelectedOutputStatus({ status: 'idle' });
        return outputs;
      }

      if (selectedOutput?.id === nextSelectedId) {
        return outputs;
      }

      await loadOutputDetail(nextSelectedId, { showLoading: false });
      return outputs;
    },
    [loadOutputDetail, selectedOutput?.id, selectedOutputId, talkId],
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
      const [jobs, outputs, attachedConnectors, bindings] = await Promise.all([
        listTalkJobs(talkId),
        listTalkOutputs(talkId),
        getTalkDataConnectors(talkId),
        listTalkChannels(talkId),
      ]);
      setTalkJobs(jobs);
      setTalkJobsLoaded(true);
      setTalkOutputs(outputs);
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

  const refreshTalkTools = useCallback(
    async (options?: { showLoading?: boolean }) => {
      if (options?.showLoading) {
        setToolStatus({ status: 'loading' });
      }
      const next = await getTalkTools(talkId);
      setTalkTools(next);
      setToolGrantDrafts(
        next.grants.reduce<Record<string, boolean>>((acc, grant) => {
          acc[grant.toolId] = grant.enabled;
          return acc;
        }, {}),
      );
      setToolStatus({ status: 'idle' });
    },
    [talkId],
  );

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'BOOTSTRAP_LOADING' });
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
    setTalkOutputs([]);
    setTalkOutputsLoaded(false);
    setTalkOutputsStatus({ status: 'idle' });
    setSelectedOutputId(null);
    setSelectedOutput(null);
    setSelectedOutputStatus({ status: 'idle' });
    setTalkJobs([]);
    setTalkJobsLoaded(false);
    setTalkJobsStatus({ status: 'idle' });
    setSelectedJobId(null);
    setSelectedJobRuns([]);
    setSelectedJobRunsStatus({ status: 'idle' });
    setCreatingJob(false);
    setJobDraft(buildDefaultJobDraft());
    setOutputTitleDraft('');
    setOutputBodyDraft('');
    setGoalDraft('');
    setNewRuleText('');
    setAddSourceTitle('');
    setAddSourceUrl('');
    setAddSourceText('');
    setChannelBindings([]);
    setChannelConnections([]);
    setChannelTargetInventory(buildEmptyChannelTargetInventory());
    setChannelDrafts({});
    setChannelFailuresByBindingId({});
    setChannelCreateDraft(buildDefaultChannelCreateDraft());
    setChannelTargetsLoading(false);
    setChannelStatus({ status: 'idle' });

    const load = async () => {
      try {
        const [talk, threads, runs, talkAgents] = await Promise.all([
          getTalk(talkId),
          listTalkThreads(talkId),
          getTalkRuns(talkId),
          getTalkAgents(talkId),
        ]);
        if (cancelled) return;
        const sortedThreads = sortThreads(threads);
        setAgents(talkAgents);
        setAgentDrafts(talkAgents);
        setTargetAgentIds(buildTargetSelection(talkAgents, []));
        setThreadState({ threads: sortedThreads, loading: false, error: null });
        dispatch({ type: 'BOOTSTRAP_READY', talk, runs });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          if (!cancelled) {
            dispatch({
              type: 'BOOTSTRAP_ERROR',
              unavailable: true,
              message: 'Talk not found',
            });
          }
          return;
        }
        if (!cancelled) {
          dispatch({
            type: 'BOOTSTRAP_ERROR',
            unavailable: false,
            message: err instanceof Error ? err.message : 'Failed to load talk',
          });
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (threadRefreshTimerRef.current) {
        clearTimeout(threadRefreshTimerRef.current);
        threadRefreshTimerRef.current = null;
      }
    };
  }, [handleUnauthorized, talkId]);

  useEffect(() => {
    if (threadState.loading) return;
    if (threadState.threads.length === 0) {
      setActiveThreadId(null);
      return;
    }
    const validThreadId =
      requestedThreadId &&
      threadState.threads.some((thread) => thread.id === requestedThreadId)
        ? requestedThreadId
        : threadState.threads[0]?.id || null;
    if (!validThreadId) return;
    if (requestedThreadId !== validThreadId) {
      navigate(buildThreadHref(talkId, validThreadId, currentTab), {
        replace: true,
      });
    }
    if (activeThreadId !== validThreadId) {
      setActiveThreadId(validThreadId);
    }
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

  useEffect(() => {
    if (state.kind !== 'ready' || !activeThreadId) return;
    const snapshotVersion = threadSnapshotVersionRef.current;
    let cancelled = false;
    dispatch({ type: 'THREAD_MESSAGES_LOADING', threadId: activeThreadId });
    listTalkMessages(talkId, { threadId: activeThreadId })
      .then((messages) => {
        if (
          cancelled ||
          activeThreadIdRef.current !== activeThreadId ||
          snapshotVersion !== threadSnapshotVersionRef.current
        ) {
          return;
        }
        dispatch({
          type: 'THREAD_MESSAGES_LOADED',
          threadId: activeThreadId,
          messages: filterDeletedMessages(messages),
        });
        requestAnimationFrame(() => {
          if (pendingComposerFocusRef.current) {
            pendingComposerFocusRef.current = false;
            textareaRef.current?.focus();
          }
          scrollToBottom('auto');
        });
      })
      .catch((err) => {
        if (cancelled) return;
        if (
          activeThreadIdRef.current !== activeThreadId ||
          snapshotVersion !== threadSnapshotVersionRef.current
        ) {
          return;
        }
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        dispatch({
          type: 'THREAD_MESSAGES_FAILED',
          threadId: activeThreadId,
          message:
            err instanceof Error
              ? err.message
              : 'Failed to load thread messages.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeThreadId,
    handleUnauthorized,
    filterDeletedMessages,
    scrollToBottom,
    state.kind,
    talkId,
  ]);

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
    if (state.kind !== 'ready') return;
    const stream = openTalkStream({
      talkId,
      onUnauthorized: handleUnauthorized,
      onMessageAppended: (event: MessageAppendedEvent) => {
        if (event.talkId !== talkId) return;
        if (deletedMessageIdsRef.current.has(event.messageId)) return;
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
          type: 'MESSAGE_APPENDED',
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
      onReplayGap: async () => {
        await resyncTalkState({ refreshThreads: true });
      },
      onStateChange: (streamState) => {
        switch (streamState) {
          case 'connecting':
            dispatch({ type: 'STREAM_CONNECTING' });
            break;
          case 'live':
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
    };
  }, [
    bumpThreadSummaryFromMessage,
    ensureKnownThread,
    handleUnauthorized,
    isNearBottom,
    rememberDeletedMessageIds,
    resyncTalkState,
    scheduleThreadListRefresh,
    state.kind,
    talkId,
  ]);

  useEffect(() => {
    if (state.kind !== 'ready' || !state.initialScrollPending) return;
    scrollToBottom('auto');
    dispatch({ type: 'CLEAR_UNREAD' });
  }, [scrollToBottom, state.initialScrollPending, state.kind]);

  useEffect(() => {
    if (state.kind !== 'ready' || state.initialScrollPending) return;
    if (!autoStickToBottomRef.current) return;
    autoStickToBottomRef.current = false;
    scrollToBottom('smooth');
    dispatch({ type: 'CLEAR_UNREAD' });
  }, [
    scrollToBottom,
    state.initialScrollPending,
    state.kind,
    state.messages.length,
  ]);

  const accessRole = state.kind === 'ready' ? state.talk?.accessRole : null;
  const canEditAgents =
    accessRole === 'owner' || accessRole === 'admin' || accessRole === 'editor';
  const canEditOutputs = canEditAgents;
  const canEditJobs = canEditAgents;
  const canManageTalkConnectors =
    accessRole === 'owner' || accessRole === 'admin';
  const canManageProjectPath = accessRole === 'owner' || accessRole === 'admin';
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
    state.kind === 'ready' && state.talk
      ? state.talk.orchestrationMode
      : 'ordered';
  const orchestrationModeLabel = getOrchestrationModeLabel(orchestrationMode);
  useEffect(() => {
    if (state.kind !== 'ready' || !state.talk) return;
    setProjectPathDraft(state.talk.projectPath ?? '');
  }, [state.kind, state.talk]);
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
            (agent) => !talkAgentSupportsVision(agent, aiAgentsData),
          ),
    [aiAgentsData, pendingImageAttachments.length, selectedTargetAgents],
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
      new Map(state.messages.map((message) => [message.id, message] as const)),
    [state.messages],
  );
  const sortedThreads = useMemo(
    () => sortThreads(threadState.threads),
    [threadState.threads],
  );
  const hasUnsavedOutputChanges = Boolean(
    selectedOutput &&
    (outputTitleDraft !== selectedOutput.title ||
      outputBodyDraft !== selectedOutput.contentMarkdown),
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
      if (state.kind !== 'ready' || !state.talk) {
        throw new Error('Talk not ready.');
      }
      try {
        const updated = await updateTalkThread({
          talkId: state.talk.id,
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
      if (state.kind !== 'ready' || !state.talk) return;
      const confirmed = window.confirm(
        `Delete "${formatThreadLabel(thread)}"? This will permanently remove the thread and its messages.`,
      );
      if (!confirmed) return;
      try {
        await deleteTalkThread({
          talkId: state.talk.id,
          threadId: thread.id,
        });
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
  const liveResponses = useMemo(
    () =>
      Object.values(state.liveResponsesByRunId).sort(
        (left, right) => left.startedAt - right.startedAt,
      ),
    [state.liveResponsesByRunId],
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
      note = 'Each agent in the latest ordered round finished and saved a response.';
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
        ...state.messages.map((message, index) => ({
          kind: 'message' as const,
          key: message.id,
          timestamp: Date.parse(message.createdAt) || 0,
          sortOrder: index,
          message,
        })),
        ...liveResponses.map((response, index) => {
          const run = state.runsById[response.runId];
          const runTimestamp = Date.parse(
            run?.startedAt || run?.createdAt || '',
          );
          return {
            kind: 'live-response' as const,
            key: response.runId,
            timestamp:
              Number.isFinite(runTimestamp) && runTimestamp > 0
                ? runTimestamp
                : response.startedAt,
            sortOrder: state.messages.length + index,
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
              sortOrder: state.messages.length + liveResponses.length + index,
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
      state.messages,
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
  const canEditHistory = useMemo(
    () =>
      state.kind === 'ready' &&
      !activeRound &&
      state.messages.some((message) => message.role !== 'system'),
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
  const missingGoogleScopes = useMemo(() => {
    if (!talkTools) return [] as string[];
    const currentScopes = new Set(talkTools.googleAccount.scopes);
    return Array.from(
      new Set(
        talkTools.grants
          .filter((grant) => grant.enabled)
          .flatMap((grant) => requiredScopesForTool(grant.toolId))
          .filter((scope) => !currentScopes.has(scope)),
      ),
    );
  }, [talkTools]);
  const hasUnsavedToolChanges = useMemo(() => {
    if (!talkTools) return false;
    return talkTools.grants.some(
      (grant) => (toolGrantDrafts[grant.toolId] ?? false) !== grant.enabled,
    );
  }, [talkTools, toolGrantDrafts]);

  const talkTabHref = `/app/talks/${talkId}`;
  const threadAwareTalkTabHref = activeThreadId
    ? buildThreadHref(talkId, activeThreadId)
    : talkTabHref;
  const agentsTabHref = activeThreadId
    ? buildThreadHref(talkId, activeThreadId, 'agents')
    : `/app/talks/${talkId}/agents`;
  const jobsTabHref = activeThreadId
    ? buildThreadHref(talkId, activeThreadId, 'jobs')
    : `/app/talks/${talkId}/jobs`;
  const toolsTabHref = activeThreadId
    ? buildThreadHref(talkId, activeThreadId, 'tools')
    : `/app/talks/${talkId}/tools`;
  const contextTabHref = activeThreadId
    ? buildThreadHref(talkId, activeThreadId, 'context')
    : `/app/talks/${talkId}/context`;
  const rulesTabHref = activeThreadId
    ? buildThreadHref(talkId, activeThreadId, 'rules')
    : `/app/talks/${talkId}/rules`;
  const stateTabHref = activeThreadId
    ? buildThreadHref(talkId, activeThreadId, 'state')
    : `/app/talks/${talkId}/state`;
  const outputsTabHref = activeThreadId
    ? buildThreadHref(talkId, activeThreadId, 'outputs')
    : `/app/talks/${talkId}/outputs`;
  const channelsTabHref = activeThreadId
    ? buildThreadHref(talkId, activeThreadId, 'channels')
    : `/app/talks/${talkId}/channels`;
  const connectorsTabHref = activeThreadId
    ? buildThreadHref(talkId, activeThreadId, 'data-connectors')
    : `/app/talks/${talkId}/data-connectors`;
  const runsTabHref = activeThreadId
    ? buildThreadHref(talkId, activeThreadId, 'runs')
    : `/app/talks/${talkId}/runs`;
  const settingsTabHref = contextTabHref;
  const manageAgentsHref = `/app/agents?returnTo=${encodeURIComponent(
    threadAwareTalkTabHref,
  )}&focus=providers`;
  const handleOpenRunHistory = useCallback(
    (runId: string) => {
      pendingRunHistoryScrollRef.current = runId;
      navigate(runsTabHref);
    },
    [navigate, runsTabHref],
  );
  const manageConnectorsHref = '/app/connectors';
  const isRenaming = renameDraft?.talkId === talkId;
  const isSettingsTab = isSettingsTabKey(currentTab);

  useEffect(() => {
    if (state.kind !== 'ready' || currentTab !== 'tools') return;

    let cancelled = false;
    setToolStatus((current) =>
      current.status === 'saving' ? current : { status: 'loading' },
    );

    const loadTools = async () => {
      try {
        const next = await getTalkTools(talkId);
        if (cancelled) return;
        setTalkTools(next);
        setToolGrantDrafts(
          next.grants.reduce<Record<string, boolean>>((acc, grant) => {
            acc[grant.toolId] = grant.enabled;
            return acc;
          }, {}),
        );
        setToolStatus({ status: 'idle' });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (!cancelled) {
          setToolStatus({
            status: 'error',
            message:
              err instanceof Error ? err.message : 'Failed to load Talk tools.',
          });
        }
      }
    };

    void loadTools();
    return () => {
      cancelled = true;
    };
  }, [currentTab, handleUnauthorized, state.kind, talkId]);

  useEffect(() => {
    if (currentTab !== 'tools' || !googleToolsError) return;
    setToolStatus({
      status: 'error',
      message: googleToolsError,
    });
  }, [currentTab, googleToolsError]);

  useEffect(() => {
    if (state.kind !== 'ready' || currentTab !== 'data-connectors') return;

    let cancelled = false;
    setConnectorState((current) =>
      current.status === 'saving' ? current : { status: 'loading' },
    );

    const loadConnectors = async () => {
      try {
        const [attached, allConnectors] = await Promise.all([
          getTalkDataConnectors(talkId),
          canManageTalkConnectors ? getDataConnectors() : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setTalkConnectors(attached);
        setOrgConnectors(allConnectors);
        setConnectorState({ status: 'idle' });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (!cancelled) {
          setConnectorState({
            status: 'error',
            message:
              err instanceof Error
                ? err.message
                : 'Failed to load data connectors.',
          });
        }
      }
    };

    void loadConnectors();
    return () => {
      cancelled = true;
    };
  }, [
    canManageTalkConnectors,
    currentTab,
    handleUnauthorized,
    state.kind,
    talkId,
  ]);

  useEffect(() => {
    if (currentTab !== 'data-connectors') return;
    if (
      availableConnectors.some(
        (connector) => connector.id === attachConnectorId,
      )
    ) {
      return;
    }
    setAttachConnectorId(availableConnectors[0]?.id || '');
  }, [attachConnectorId, availableConnectors, currentTab]);

  const reloadTalkChannels = useCallback(
    async (options?: { quiet?: boolean }) => {
      if (state.kind !== 'ready') return;
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
    [canBrowseChannelConnections, handleUnauthorized, state.kind, talkId],
  );

  useEffect(() => {
    if (state.kind !== 'ready' || currentTab !== 'channels') return;
    void reloadTalkChannels();
  }, [currentTab, reloadTalkChannels, state.kind]);

  useEffect(() => {
    if (state.kind !== 'ready' || currentTab !== 'channels') return;
    if (!canBrowseChannelConnections || !selectedChannelConnection) {
      setChannelTargetInventory(buildEmptyChannelTargetInventory());
      return;
    }

    let cancelled = false;
    setChannelTargetsLoading(true);

    const loadTargets = async () => {
      try {
        const inventory = await listChannelTargets({
          connectionId: selectedChannelConnection.id,
          query: channelTargetQuery.trim() || undefined,
          limit: selectedChannelPlatform === 'slack' ? 50 : 100,
          offset: 0,
          approval: selectedChannelPlatform === 'slack' ? 'all' : 'approved',
        });
        if (cancelled) return;
        setChannelTargetInventory(inventory);
        setChannelCreateDraft((current) => {
          const existingTarget = inventory.targets.find(
            (target) => buildChannelTargetKey(target) === current.targetKey,
          );
          return {
            ...current,
            platform: selectedChannelPlatform,
            connectionId: selectedChannelConnection.id,
            targetKey: existingTarget ? current.targetKey : '',
          };
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (!cancelled) {
          setChannelStatus({
            status: 'error',
            message:
              err instanceof Error
                ? err.message
                : 'Failed to load channel targets.',
          });
        }
      } finally {
        if (!cancelled) {
          setChannelTargetsLoading(false);
        }
      }
    };

    void loadTargets();
    return () => {
      cancelled = true;
    };
  }, [
    canBrowseChannelConnections,
    channelTargetQuery,
    currentTab,
    handleUnauthorized,
    selectedChannelConnection,
    selectedChannelPlatform,
    state.kind,
  ]);

  // Load Talk context once so Rules badges and context surfaces stay hydrated.
  useEffect(() => {
    if (state.kind !== 'ready') return;
    if (contextLoaded) return;

    let cancelled = false;

    const loadContext = async () => {
      try {
        await refreshContext({
          hydrateGoalDraft: true,
          showLoading: currentTab === 'context' || currentTab === 'rules',
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
  }, [
    contextLoaded,
    currentTab,
    handleUnauthorized,
    refreshContext,
    state.kind,
  ]);

  useEffect(() => {
    if (state.kind !== 'ready' || currentTab !== 'state') {
      return;
    }

    void refreshTalkStateEntries({ showLoading: !talkStateLoaded });
  }, [currentTab, refreshTalkStateEntries, state.kind, talkStateLoaded]);

  useEffect(() => {
    if (
      state.kind !== 'ready' ||
      currentTab !== 'outputs' ||
      talkOutputsLoaded
    ) {
      return;
    }

    let cancelled = false;

    const loadOutputs = async () => {
      try {
        await refreshTalkOutputs({ showLoading: true });
        if (cancelled) return;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (!cancelled) {
          setTalkOutputsStatus({
            status: 'error',
            message:
              err instanceof Error ? err.message : 'Failed to load reports.',
          });
        }
      }
    };

    void loadOutputs();
    return () => {
      cancelled = true;
    };
  }, [
    currentTab,
    handleUnauthorized,
    refreshTalkOutputs,
    state.kind,
    talkOutputsLoaded,
  ]);

  useEffect(() => {
    if (state.kind !== 'ready' || currentTab !== 'jobs' || talkJobsLoaded) {
      return;
    }

    let cancelled = false;

    const loadJobs = async () => {
      try {
        await refreshTalkJobs({ showLoading: true });
        if (cancelled) return;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (!cancelled) {
          setTalkJobsStatus({
            status: 'error',
            message:
              err instanceof Error ? err.message : 'Failed to load jobs.',
          });
        }
      }
    };

    void loadJobs();
    return () => {
      cancelled = true;
    };
  }, [
    currentTab,
    handleUnauthorized,
    refreshTalkJobs,
    state.kind,
    talkJobsLoaded,
  ]);

  useEffect(() => {
    if (state.kind !== 'ready' || currentTab !== 'context' || !contextLoaded) {
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
    state.kind,
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

  const handleAddUrlSource = async () => {
    const trimmedUrl = addSourceUrl.trim();
    if (!trimmedUrl) return;
    setContextStatus({ status: 'saving' });
    try {
      const source = await createTalkContextSource({
        talkId,
        sourceType: 'url',
        title: addSourceTitle.trim() || trimmedUrl,
        sourceUrl: trimmedUrl,
      });
      setContextSources((prev) => [...prev, source]);
      setAddSourceTitle('');
      setAddSourceUrl('');
      setContextStatus({ status: 'idle' });
    } catch (err) {
      setContextStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to add source.',
      });
    }
  };

  const handleAddTextSource = async () => {
    const trimmedText = addSourceText.trim();
    if (!trimmedText) return;
    setContextStatus({ status: 'saving' });
    try {
      const source = await createTalkContextSource({
        talkId,
        sourceType: 'text',
        title: addSourceTitle.trim() || 'Pasted text source',
        extractedText: trimmedText,
      });
      setContextSources((prev) => [...prev, source]);
      setAddSourceTitle('');
      setAddSourceText('');
      setContextStatus({ status: 'idle' });
    } catch (err) {
      setContextStatus({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to add text source.',
      });
    }
  };

  const handleContextFilesSelected = async (files: FileList | File[]) => {
    const fileArr = Array.from(files);
    if (fileArr.length === 0) return;

    const MAX_SIZE = 10 * 1024 * 1024;

    for (const file of fileArr) {
      const localId = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Client-side size check
      if (file.size > MAX_SIZE) {
        setContextUploadingFiles((prev) => [
          ...prev,
          {
            localId,
            fileName: file.name,
            status: 'error',
            error: 'File exceeds 10 MB limit',
          },
        ]);
        continue;
      }

      setContextUploadingFiles((prev) => [
        ...prev,
        { localId, fileName: file.name, status: 'uploading' },
      ]);

      try {
        const source = await uploadTalkContextSource(talkId, file);
        setContextSources((prev) => [...prev, source]);
        setContextUploadingFiles((prev) =>
          prev.map((f) =>
            f.localId === localId ? { ...f, status: 'done' as const } : f,
          ),
        );
        // Remove completed entry after a short delay
        setTimeout(() => {
          setContextUploadingFiles((prev) =>
            prev.filter((f) => f.localId !== localId),
          );
        }, 1500);
      } catch (err) {
        setContextUploadingFiles((prev) =>
          prev.map((f) =>
            f.localId === localId
              ? {
                  ...f,
                  status: 'error' as const,
                  error: err instanceof Error ? err.message : 'Upload failed',
                }
              : f,
          ),
        );
      }
    }
  };

  const handleDeleteSource = async (sourceId: string) => {
    try {
      await deleteTalkContextSource({ talkId, sourceId });
      setContextSources((prev) => prev.filter((s) => s.id !== sourceId));
    } catch {
      // silent
    }
  };

  const handleRetrySource = async (sourceId: string) => {
    try {
      const updated = await retryTalkContextSource({ talkId, sourceId });
      setContextSources((prev) =>
        prev.map((source) => (source.id === updated.id ? updated : source)),
      );
      setContextStatus({
        status: 'success',
        message: 'Retrying saved source fetch.',
      });
    } catch (err) {
      setContextStatus({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to retry saved source.',
      });
    }
  };

  const handleSelectOutput = useCallback(
    async (outputId: string) => {
      try {
        await loadOutputDetail(outputId, { showLoading: true });
        setTalkOutputsStatus({ status: 'idle' });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setSelectedOutputStatus({
          status: 'error',
          message:
            err instanceof Error ? err.message : 'Failed to load report.',
        });
      }
    },
    [handleUnauthorized, loadOutputDetail],
  );

  const handleCreateOutput = useCallback(async () => {
    if (!canEditOutputs) return;
    setTalkOutputsStatus({ status: 'saving' });
    try {
      const output = await createTalkOutput({
        talkId,
        title: 'Untitled Report',
        contentMarkdown: '',
      });
      setTalkOutputs((current) => [output, ...current]);
      setTalkOutputsLoaded(true);
      setSelectedOutputId(output.id);
      setSelectedOutput(output);
      setOutputTitleDraft(output.title);
      setOutputBodyDraft(output.contentMarkdown);
      setSelectedOutputStatus({ status: 'idle' });
      setTalkOutputsStatus({
        status: 'success',
        message: 'Report created.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setTalkOutputsStatus({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to create report.',
      });
    }
  }, [canEditOutputs, handleUnauthorized, talkId]);

  const handleSaveOutput = useCallback(async () => {
    if (!selectedOutput || !canEditOutputs) return;
    setTalkOutputsStatus({ status: 'saving' });
    try {
      const output = await patchTalkOutput({
        talkId,
        outputId: selectedOutput.id,
        expectedVersion: selectedOutput.version,
        title: outputTitleDraft,
        contentMarkdown: outputBodyDraft,
      });
      setSelectedOutput(output);
      setOutputTitleDraft(output.title);
      setOutputBodyDraft(output.contentMarkdown);
      setTalkOutputs((current) =>
        current
          .map((summary) => (summary.id === output.id ? output : summary))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      );
      setTalkOutputsStatus({
        status: 'success',
        message: 'Report saved.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setTalkOutputsStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to save report.',
      });
    }
  }, [
    canEditOutputs,
    handleUnauthorized,
    outputBodyDraft,
    outputTitleDraft,
    selectedOutput,
    talkId,
  ]);

  const handleDeleteOutput = useCallback(async () => {
    if (!selectedOutput || !canEditOutputs) return;
    const confirmed = window.confirm(
      `Delete "${selectedOutput.title}"? This cannot be undone.`,
    );
    if (!confirmed) return;

    setTalkOutputsStatus({ status: 'saving' });
    try {
      await deleteTalkOutput({ talkId, outputId: selectedOutput.id });
      const remaining = talkOutputs.filter(
        (output) => output.id !== selectedOutput.id,
      );
      setTalkOutputs(remaining);
      if (remaining.length > 0) {
        await loadOutputDetail(remaining[0]!.id, { showLoading: false });
      } else {
        setSelectedOutputId(null);
        setSelectedOutput(null);
        setOutputTitleDraft('');
        setOutputBodyDraft('');
        setSelectedOutputStatus({ status: 'idle' });
      }
      setTalkOutputsStatus({
        status: 'success',
        message: 'Report deleted.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setTalkOutputsStatus({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to delete report.',
      });
    }
  }, [
    canEditOutputs,
    handleUnauthorized,
    loadOutputDetail,
    selectedOutput,
    talkId,
    talkOutputs,
  ]);

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
      const reportPayload =
        jobDraft.deliverableKind === 'report' &&
        jobDraft.reportTargetMode === 'create'
          ? {
              title: jobDraft.createReportTitle.trim() || 'Untitled Report',
              contentMarkdown: jobDraft.createReportContentMarkdown,
            }
          : null;
      const reportOutputId =
        jobDraft.deliverableKind === 'report' &&
        jobDraft.reportTargetMode === 'existing'
          ? jobDraft.reportOutputId || null
          : null;

      const saved = creatingJob
        ? await createTalkJob({
            talkId,
            title: jobDraft.title,
            prompt: jobDraft.prompt,
            targetAgentId: jobDraft.targetAgentId,
            schedule,
            timezone: jobDraft.timezone,
            deliverableKind: jobDraft.deliverableKind,
            reportOutputId,
            createReport: reportPayload,
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
            deliverableKind: jobDraft.deliverableKind,
            reportOutputId,
            createReport: reportPayload,
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
    if (state.kind !== 'ready') return;
    if (activeRound) {
      setHistoryEditState({
        status: 'error',
        message:
          'Wait for the current round to finish or cancel it before editing history.',
      });
      return;
    }
    if (!state.messages.some((message) => message.role !== 'system')) {
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
      if (state.kind !== 'ready' || !state.talk) return;
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
          talkId: state.talk.id,
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

  const handleDraftChange = (value: string) => {
    setDraft(value);
    if (state.kind === 'ready' && state.sendState.status === 'error') {
      dispatch({ type: 'SEND_CLEARED' });
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
  }, [activeThreadId, currentTab, draft, resizeComposerTextarea, state.kind]);

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
    if (!state.talk) return;
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
        const result = await uploadTalkAttachment(state.talk!.id, file);
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
    if (currentTab !== 'talk') {
      dragCounterRef.current = 0;
      setIsDragOver(false);
      return;
    }

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
    if (state.kind === 'ready' && state.sendState.status === 'error') {
      dispatch({ type: 'SEND_CLEARED' });
    }
  };

  const queueTalkMessage = useCallback(
    async (input: {
      content: string;
      targetAgentIds: string[];
      attachmentIds?: string[];
    }) => {
      if (state.kind !== 'ready' || !state.talk || !activeThreadId) {
        throw new Error('Thread unavailable.');
      }

      const result = await sendTalkMessage({
        talkId: state.talk.id,
        content: input.content,
        targetAgentIds: input.targetAgentIds,
        attachmentIds: input.attachmentIds,
        threadId: activeThreadId,
      });
      const nearBottom = isNearBottom();
      dispatch({
        type: 'MESSAGE_APPENDED',
        wasNearBottom: nearBottom,
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
    [activeThreadId, isNearBottom, state.kind, state.talk],
  );

  const submitDraft = async () => {
    if (state.kind !== 'ready' || !state.talk || !activeThreadId) return;

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
      if (state.kind !== 'ready' || !state.talk || !activeThreadId) return;
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
      const triggerMessage = state.messages.find(
        (message) => message.id === run?.triggerMessageId && message.role === 'user',
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
      state.kind,
      state.messages,
      state.runsById,
      state.talk,
    ],
  );

  const handleSend = (event: FormEvent) => {
    event.preventDefault();
    void submitDraft();
  };

  const handleComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => {
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
    if (state.kind !== 'ready' || !state.talk || !activeThreadId) return;
    dispatch({ type: 'CANCEL_STARTED' });
    try {
      const result = await cancelTalkRuns(state.talk.id, activeThreadId);
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
      if (state.kind !== 'ready' || !state.talk) return;
      if (state.talk.orchestrationMode === nextMode) return;

      setOrchestrationState({ status: 'saving' });
      try {
        const updatedTalk = await patchTalkMetadata({
          talkId: state.talk.id,
          orchestrationMode: nextMode,
        });
        dispatch({ type: 'TALK_UPDATED', talk: updatedTalk });
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
    [handleUnauthorized, state],
  );

  const handleSaveProjectPath = useCallback(async () => {
    if (state.kind !== 'ready' || !state.talk || !canManageProjectPath) return;
    setProjectPathState({ status: 'saving' });
    try {
      const updatedTalk = await updateTalkProjectMount({
        talkId: state.talk.id,
        projectPath: projectPathDraft,
      });
      dispatch({ type: 'TALK_UPDATED', talk: updatedTalk });
      setProjectPathState({
        status: 'success',
        message: 'Project mount updated.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setProjectPathState({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to update the project mount.',
      });
    }
  }, [canManageProjectPath, handleUnauthorized, projectPathDraft, state]);

  const handleClearProjectPath = useCallback(async () => {
    if (state.kind !== 'ready' || !state.talk || !canManageProjectPath) return;
    setProjectPathState({ status: 'saving' });
    try {
      const updatedTalk = await clearTalkProjectMount(state.talk.id);
      dispatch({ type: 'TALK_UPDATED', talk: updatedTalk });
      setProjectPathState({
        status: 'success',
        message: 'Project mount cleared.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setProjectPathState({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to clear the project mount.',
      });
    }
  }, [canManageProjectPath, handleUnauthorized, state]);

  const handleCreateThread = useCallback(async () => {
    if (state.kind !== 'ready' || !state.talk) return;
    try {
      const nextThread = await createTalkThread({ talkId: state.talk.id });
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

  const handleSaveTalkTools = async () => {
    if (!canEditAgents || !talkTools) return;

    setToolStatus({ status: 'saving' });
    try {
      const next = await updateTalkTools({
        talkId,
        grants: talkTools.registry.map((entry) => ({
          toolId: entry.id,
          enabled: toolGrantDrafts[entry.id] ?? false,
        })),
      });
      setTalkTools(next);
      setToolGrantDrafts(
        next.grants.reduce<Record<string, boolean>>((acc, grant) => {
          acc[grant.toolId] = grant.enabled;
          return acc;
        }, {}),
      );
      setToolStatus({
        status: 'success',
        message: 'Talk tool grants updated.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setToolStatus({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to save Talk tools.',
      });
    }
  };

  const handleConnectGoogleAccount = async () => {
    setToolStatus({ status: 'saving' });
    try {
      const launch = await connectUserGoogleAccount({
        returnTo: toolsTabHref,
      });
      await launchGoogleAccountPopup(launch.authorizationUrl);
      await refreshTalkTools();
      setToolStatus({
        status: 'success',
        message: 'Google account connected for this user.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setToolStatus({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to connect Google account.',
      });
    }
  };

  const handleGrantGoogleScopes = async () => {
    if (!talkTools) return;
    const currentScopes = new Set(talkTools.googleAccount.scopes);
    const missingScopes = Array.from(
      new Set(
        talkTools.grants
          .filter((grant) => grant.enabled)
          .flatMap((grant) => requiredScopesForTool(grant.toolId))
          .filter((scope) => !currentScopes.has(scope)),
      ),
    );
    if (missingScopes.length === 0) return;

    setToolStatus({ status: 'saving' });
    try {
      const launch = await expandUserGoogleScopes({
        scopes: missingScopes,
        returnTo: toolsTabHref,
      });
      await launchGoogleAccountPopup(launch.authorizationUrl);
      await refreshTalkTools();
      setToolStatus({
        status: 'success',
        message: 'Google permissions updated.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setToolStatus({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to update Google permissions.',
      });
    }
  };

  const handleAddDriveBinding = async () => {
    if (!canEditAgents) return;
    if (
      !driveBindingDraft.externalId.trim() ||
      !driveBindingDraft.displayName.trim()
    ) {
      setToolStatus({
        status: 'error',
        message: 'Drive bindings require both a display name and resource id.',
      });
      return;
    }

    setToolStatus({ status: 'saving' });
    try {
      await createTalkGoogleDriveResource({
        talkId,
        kind: driveBindingDraft.bindingKind,
        externalId: driveBindingDraft.externalId.trim(),
        displayName: driveBindingDraft.displayName.trim(),
      });
      setDriveBindingDraft({
        bindingKind: 'google_drive_folder',
        externalId: '',
        displayName: '',
      });
      await refreshTalkTools();
      setToolStatus({
        status: 'success',
        message: 'Drive binding added to this Talk.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setToolStatus({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to add Drive binding.',
      });
    }
  };

  const handleOpenDrivePicker = async (mode: 'folder' | 'file') => {
    if (!canEditAgents) return;

    setToolStatus({ status: 'saving' });
    try {
      const session = await getGooglePickerSession();
      const selections = await openGoogleDrivePicker({ session, mode });
      if (selections.length === 0) {
        setToolStatus({ status: 'idle' });
        return;
      }

      await Promise.all(
        selections.map((selection) =>
          createTalkGoogleDriveResource({
            talkId,
            kind: selection.kind,
            externalId: selection.externalId,
            displayName: selection.displayName,
            metadata: selection.metadata,
          }),
        ),
      );

      await refreshTalkTools();
      setToolStatus({
        status: 'success',
        message:
          selections.length === 1
            ? 'Drive binding added to this Talk.'
            : `${selections.length} Drive bindings added to this Talk.`,
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setToolStatus({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to open Google Picker.',
      });
    }
  };

  const handleDeleteDriveBinding = async (bindingId: string) => {
    if (!canEditAgents) return;

    setToolStatus({ status: 'saving' });
    try {
      await deleteTalkResource({ talkId, resourceId: bindingId });
      await refreshTalkTools();
      setToolStatus({
        status: 'success',
        message: 'Drive binding removed from this Talk.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setToolStatus({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to remove Drive binding.',
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
    if (state.kind !== 'ready' || !state.talk || !canEditAgents) return;
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
        talkId: state.talk.id,
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

  if (state.kind === 'loading') {
    return <p className="page-state">Loading talk…</p>;
  }

  if (state.kind === 'unavailable') {
    return (
      <section className="page-state">
        <h2>Talk Unavailable</h2>
        <p>{state.errorMessage || 'Talk not found.'}</p>
        <Link to="/app/talks">Back to talks</Link>
      </section>
    );
  }

  if (state.kind === 'error' || !state.talk) {
    return (
      <section className="page-state">
        <h2>Talk Error</h2>
        <p>{state.errorMessage || 'Failed to load talk.'}</p>
        <Link to="/app/talks">Back to talks</Link>
      </section>
    );
  }

  const talk = state.talk;
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
                        to={jobsTabHref}
                        className={`talk-tab ${currentTab === 'jobs' ? 'talk-tab-active' : ''}`}
                      >
                        Jobs
                      </Link>
                      <Link
                        to={settingsTabHref}
                        className={`talk-tab ${isSettingsTab ? 'talk-tab-active' : ''}`}
                      >
                        Settings
                      </Link>
                      <Link
                        to={outputsTabHref}
                        className={`talk-tab ${currentTab === 'outputs' ? 'talk-tab-active' : ''}`}
                      >
                        Reports
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
                    <Link to="/app/talks" className="talk-page-back-link">
                      Back
                    </Link>
                  </div>
                  {isSettingsTab ? (
                    <div className="talk-subtabs-row">
                      <nav
                        className="talk-tabs talk-subtabs"
                        aria-label="Talk settings sections"
                      >
                        <Link
                          to={contextTabHref}
                          className={`talk-tab ${currentTab === 'context' ? 'talk-tab-active' : ''}`}
                        >
                          Context
                        </Link>
                        <Link
                          to={rulesTabHref}
                          className={`talk-tab ${currentTab === 'rules' ? 'talk-tab-active' : ''}`}
                        >
                          Rules
                          <span
                            className="talk-tab-badge"
                            aria-label={`${activeRuleCount} active rules`}
                          >
                            {activeRuleCount}
                          </span>
                        </Link>
                        <Link
                          to={toolsTabHref}
                          className={`talk-tab ${currentTab === 'tools' ? 'talk-tab-active' : ''}`}
                        >
                          Tools
                        </Link>
                        <Link
                          to={stateTabHref}
                          className={`talk-tab ${currentTab === 'state' ? 'talk-tab-active' : ''}`}
                        >
                          State
                        </Link>
                        <Link
                          to={channelsTabHref}
                          className={`talk-tab ${currentTab === 'channels' ? 'talk-tab-active' : ''}`}
                        >
                          Channels
                        </Link>
                        <Link
                          to={connectorsTabHref}
                          className={`talk-tab ${currentTab === 'data-connectors' ? 'talk-tab-active' : ''}`}
                        >
                          Data Connectors
                        </Link>
                      </nav>
                    </div>
                  ) : null}
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
              {canManageProjectPath ? (
                <div className="talk-llm-card">
                  <div className="connector-card-header">
                    <div>
                      <h3>Project Mount</h3>
                      <p className="talk-llm-meta">
                        Container-backed single-agent Talk runs can mount one
                        project directory read-only at `/workspace/project`.
                      </p>
                    </div>
                  </div>
                  <div className="connector-attach-row">
                    <label style={{ flex: 1 }}>
                      <span className="sr-only">Project path</span>
                      <input
                        type="text"
                        value={projectPathDraft}
                        onChange={(event) => {
                          setProjectPathDraft(event.target.value);
                          setProjectPathState({ status: 'idle' });
                        }}
                        placeholder="/absolute/path/to/project"
                        disabled={projectPathState.status === 'saving'}
                        style={{ width: '100%' }}
                      />
                    </label>
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => void handleSaveProjectPath()}
                      disabled={projectPathState.status === 'saving'}
                    >
                      {projectPathState.status === 'saving'
                        ? 'Saving…'
                        : 'Save Path'}
                    </button>
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => void handleClearProjectPath()}
                      disabled={
                        projectPathState.status === 'saving' ||
                        !talk.projectPath
                      }
                    >
                      Clear
                    </button>
                  </div>
                  <p className="talk-llm-meta">
                    Current mount:{' '}
                    {talk.projectPath
                      ? talk.projectPath
                      : 'No project path set'}
                  </p>
                  {projectPathState.status === 'error' ? (
                    <div
                      className="inline-banner inline-banner-error"
                      role="alert"
                    >
                      {projectPathState.message}
                    </div>
                  ) : null}
                  {projectPathState.status === 'success' ? (
                    <div
                      className="inline-banner inline-banner-success"
                      role="status"
                    >
                      {projectPathState.message}
                    </div>
                  ) : null}
                </div>
              ) : null}
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
                            {ra.name} ({ra.modelId})
                          </option>
                        ))}
                    </select>
                  </label>
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
                          {ra.name} ({ra.modelId})
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
                          A single-line goal for what this talk is about. Agents
                          see this every turn.
                        </p>
                      </div>
                    </div>
                    {canEditAgents ? (
                      <>
                        <div className="connector-attach-row">
                          <label style={{ flex: 1 }}>
                            <input
                              type="text"
                              maxLength={160}
                              value={goalDraft}
                              onChange={(e) => setGoalDraft(e.target.value)}
                              placeholder="e.g. Summarize Q4 earnings calls"
                              disabled={contextStatus.status === 'saving'}
                              style={{ width: '100%' }}
                            />
                          </label>
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() => void handleSaveGoal()}
                            disabled={contextStatus.status === 'saving'}
                          >
                            Save
                          </button>
                        </div>
                        <p className="talk-llm-meta">{goalDraft.length}/160</p>
                      </>
                    ) : (
                      <p className="talk-llm-meta">
                        {contextGoal?.goalText || <em>No goal set.</em>}
                      </p>
                    )}
                  </div>

                  {/* Saved Sources */}
                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Saved Sources</h3>
                        <p className="talk-llm-meta">
                          Files, URLs, and text snippets agents can reference.
                          Up to 20 sources.
                        </p>
                      </div>
                    </div>

                    {canEditAgents ? (
                      <>
                        <div
                          className={`context-source-dropzone${contextDropActive ? ' context-source-dropzone-active' : ''}`}
                          role="button"
                          tabIndex={0}
                          aria-label="Upload saved source files"
                          onClick={() => contextFileInputRef.current?.click()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              contextFileInputRef.current?.click();
                            }
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setContextDropActive(true);
                          }}
                          onDragLeave={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setContextDropActive(false);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setContextDropActive(false);
                            if (e.dataTransfer.files.length > 0)
                              void handleContextFilesSelected(
                                e.dataTransfer.files,
                              );
                          }}
                        >
                          <span>Drop files here or click to browse</span>
                          <span className="context-source-dropzone-hint">
                            PDF, DOCX, XLSX, text, code files up to 10 MB
                          </span>
                        </div>
                        <input
                          ref={contextFileInputRef}
                          type="file"
                          multiple
                          style={{ display: 'none' }}
                          accept=".pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.html,.json,.xml,.yaml,.yml,.py,.js,.ts,.jsx,.tsx,.java,.c,.h,.cpp,.hpp,.go,.rs,.sh,.sql,.rtf,.rb,.php,.swift,.kt,.lua,.r,.toml,.ini,.cfg,.log"
                          onChange={(e) => {
                            if (e.target.files && e.target.files.length > 0) {
                              void handleContextFilesSelected(e.target.files);
                              e.target.value = '';
                            }
                          }}
                        />
                      </>
                    ) : null}

                    {contextUploadingFiles.length > 0 ? (
                      <div className="context-source-upload-progress">
                        {contextUploadingFiles.map((f) => (
                          <div
                            key={f.localId}
                            className="context-source-upload-item"
                          >
                            <span>{f.fileName}</span>
                            {f.status === 'uploading' ? (
                              <span className="context-source-upload-status">
                                Uploading...
                              </span>
                            ) : f.status === 'error' ? (
                              <span
                                className="context-source-upload-status"
                                style={{ color: 'var(--danger-text, #a61b1b)' }}
                              >
                                {f.error || 'Failed'}
                              </span>
                            ) : (
                              <span
                                className="context-source-upload-status"
                                style={{ color: 'green' }}
                              >
                                Done
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {contextSources.length > 0 ? (
                      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {contextSources.map((source) => (
                          <li key={source.id} className="context-source-item">
                            <div className="context-source-item-row">
                              <span className="context-source-ref">
                                {source.sourceRef}
                              </span>
                              <span className="context-source-type-badge">
                                {source.sourceType === 'file'
                                  ? 'FILE'
                                  : source.sourceType === 'url'
                                    ? 'URL'
                                    : 'TEXT'}
                              </span>
                              <span style={{ flex: 1 }}>{source.title}</span>
                              {source.sourceType === 'file' &&
                              source.fileSize != null ? (
                                <span className="context-source-file-meta">
                                  {source.fileSize < 1024
                                    ? `${source.fileSize} B`
                                    : source.fileSize < 1024 * 1024
                                      ? `${(source.fileSize / 1024).toFixed(1)} KB`
                                      : `${(source.fileSize / (1024 * 1024)).toFixed(1)} MB`}
                                </span>
                              ) : null}
                              {source.fetchStrategy ? (
                                <span className="context-source-file-meta">
                                  via {source.fetchStrategy}
                                </span>
                              ) : null}
                              <span
                                style={{
                                  fontSize: '0.75rem',
                                  color:
                                    source.status === 'ready'
                                      ? 'green'
                                      : source.status === 'failed'
                                        ? 'red'
                                        : 'orange',
                                }}
                              >
                                {source.status}
                              </span>
                              {canEditAgents &&
                              source.sourceType === 'url' &&
                              source.status === 'failed' ? (
                                <button
                                  type="button"
                                  className="secondary-btn"
                                  onClick={() =>
                                    void handleRetrySource(source.id)
                                  }
                                >
                                  Retry
                                </button>
                              ) : null}
                              {canEditAgents ? (
                                <button
                                  type="button"
                                  className="secondary-btn"
                                  onClick={() =>
                                    void handleDeleteSource(source.id)
                                  }
                                  title="Remove source"
                                  style={{
                                    minWidth: '2rem',
                                    padding: '0.2rem 0.4rem',
                                  }}
                                >
                                  ×
                                </button>
                              ) : null}
                            </div>
                            {source.extractionError ? (
                              <p
                                style={{
                                  margin: '0.35rem 0 0 0',
                                  fontSize: '0.85rem',
                                  color: 'var(--danger-text, #a61b1b)',
                                }}
                              >
                                {source.extractionError}
                              </p>
                            ) : null}
                            {source.lastFetchedAt ? (
                              <p
                                style={{
                                  margin: '0.2rem 0 0 0',
                                  fontSize: '0.75rem',
                                  opacity: 0.65,
                                }}
                              >
                                Last fetched{' '}
                                {new Date(
                                  source.lastFetchedAt,
                                ).toLocaleString()}
                              </p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : contextUploadingFiles.length === 0 ? (
                      <p className="page-state">No sources yet.</p>
                    ) : null}

                    {canEditAgents ? (
                      <div style={{ marginTop: '0.75rem' }}>
                        <div
                          className="connector-attach-row"
                          style={{ marginBottom: '0.5rem' }}
                        >
                          <label style={{ flex: 1 }}>
                            <span className="settings-label">URL</span>
                            <input
                              type="url"
                              value={addSourceUrl}
                              onChange={(e) => setAddSourceUrl(e.target.value)}
                              placeholder="https://example.com/docs"
                              disabled={contextStatus.status === 'saving'}
                              style={{ width: '100%' }}
                            />
                          </label>
                          <label>
                            <span className="settings-label">
                              Title (optional)
                            </span>
                            <input
                              type="text"
                              value={addSourceTitle}
                              onChange={(e) =>
                                setAddSourceTitle(e.target.value)
                              }
                              placeholder="Source title"
                              disabled={contextStatus.status === 'saving'}
                              style={{ width: '100%' }}
                            />
                          </label>
                        </div>
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => void handleAddUrlSource()}
                          disabled={
                            contextStatus.status === 'saving' ||
                            !addSourceUrl.trim()
                          }
                        >
                          Add URL
                        </button>
                        <label
                          style={{ display: 'block', marginTop: '0.75rem' }}
                        >
                          <span className="settings-label">
                            Paste text snippet
                          </span>
                          <textarea
                            value={addSourceText}
                            onChange={(e) => setAddSourceText(e.target.value)}
                            placeholder="Paste notes, source excerpts, or working context here…"
                            rows={4}
                            disabled={contextStatus.status === 'saving'}
                            style={{ width: '100%', resize: 'vertical' }}
                          />
                        </label>
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => void handleAddTextSource()}
                          disabled={
                            contextStatus.status === 'saving' ||
                            !addSourceText.trim()
                          }
                          style={{ marginTop: '0.5rem' }}
                        >
                          Add Text
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {contextStatus.status === 'success' &&
                  contextStatus.message ? (
                    <p className="page-state">{contextStatus.message}</p>
                  ) : null}
                </>
              )}
            </section>
          ) : null}

          {currentTab === 'rules' ? (
            <section className="talk-tab-panel" aria-label="Talk rules">
              {contextStatus.status === 'loading' && !contextLoaded ? (
                <p className="page-state">Loading rules…</p>
              ) : contextStatus.status === 'error' && !contextLoaded ? (
                <p className="page-state error">{contextStatus.message}</p>
              ) : (
                <>
                  <div className="agents-panel-header">
                    <h2>Rules</h2>
                  </div>
                  <p className="policy-muted">
                    Rules are durable talk-level instructions. Agents see active
                    rules every turn in order.
                  </p>
                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Active Rules</h3>
                        <p className="talk-llm-meta">
                          Up to 8 active rules. Drag to reorder. Inactive rules
                          stay editable without affecting prompt injection.
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
                                        <input
                                          type="text"
                                          maxLength={240}
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
                                          onKeyDown={(event) => {
                                            if (event.key === 'Enter') {
                                              event.preventDefault();
                                              void handleSaveRuleText(rule);
                                            }
                                          }}
                                          disabled={
                                            contextStatus.status === 'saving'
                                          }
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
                          <input
                            type="text"
                            maxLength={240}
                            value={newRuleText}
                            onChange={(e) => setNewRuleText(e.target.value)}
                            placeholder="Add a rule…"
                            disabled={contextStatus.status === 'saving'}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void handleAddRule();
                            }}
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
                    {(contextStatus.status === 'success' ||
                      contextStatus.status === 'error') &&
                    contextStatus.message ? (
                      <div
                        className={`inline-banner ${
                          contextStatus.status === 'error'
                            ? 'inline-banner-error'
                            : 'inline-banner-success'
                        }`}
                        role={
                          contextStatus.status === 'error' ? 'alert' : 'status'
                        }
                        style={{ marginTop: '0.75rem' }}
                      >
                        {contextStatus.message}
                      </div>
                    ) : null}
                  </div>
                </>
              )}
            </section>
          ) : null}

          {currentTab === 'state' ? (
            <section className="talk-tab-panel" aria-label="Talk state">
              {talkStateStatus.status === 'loading' && !talkStateLoaded ? (
                <p className="page-state">Loading state…</p>
              ) : (
                <>
                  <div className="agents-panel-header">
                    <h2>State</h2>
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
                  <p className="policy-muted">
                    Structured Talk state entries. Agents read and write these
                    via compare-and-swap updates.
                  </p>
                  {talkStateEntries.length > 0 ? (
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
                </>
              )}
            </section>
          ) : null}

          {currentTab === 'outputs' ? (
            <section className="talk-tab-panel" aria-label="Talk reports">
              {talkOutputsStatus.status === 'loading' && !talkOutputsLoaded ? (
                <p className="page-state">Loading reports…</p>
              ) : talkOutputsStatus.status === 'error' && !talkOutputsLoaded ? (
                <p className="page-state error">{talkOutputsStatus.message}</p>
              ) : (
                <>
                  <div className="agents-panel-header">
                    <h2>Reports</h2>
                    {canEditOutputs ? (
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => void handleCreateOutput()}
                        disabled={talkOutputsStatus.status === 'saving'}
                      >
                        New Report
                      </button>
                    ) : null}
                  </div>
                  <p className="policy-muted">
                    Reports are durable talk-level artifacts. They are separate
                    from transcript messages and can be updated by users or Talk
                    agents.
                  </p>

                  <div className="talk-outputs-layout">
                    <aside
                      className="talk-outputs-list"
                      aria-label="Reports list"
                    >
                      {talkOutputs.length > 0 ? (
                        talkOutputs.map((output) => (
                          <button
                            key={output.id}
                            type="button"
                            className={`talk-output-list-item${
                              selectedOutputId === output.id
                                ? ' talk-output-list-item-active'
                                : ''
                            }`}
                            onClick={() => void handleSelectOutput(output.id)}
                          >
                            <strong>{output.title}</strong>
                            <span className="talk-llm-meta">
                              v{output.version} · {output.contentLength} chars
                            </span>
                            <span className="talk-llm-meta">
                              Updated {formatDateTime(output.updatedAt)}
                            </span>
                          </button>
                        ))
                      ) : (
                        <p className="page-state">No reports yet.</p>
                      )}
                    </aside>

                    <div className="talk-output-editor">
                      {selectedOutputStatus.status === 'loading' ? (
                        <p className="page-state">Loading report…</p>
                      ) : selectedOutputStatus.status === 'error' ? (
                        <p className="page-state error">
                          {selectedOutputStatus.message}
                        </p>
                      ) : selectedOutput ? (
                        <div className="talk-llm-card">
                          <div className="connector-card-header">
                            <div>
                              <h3>{selectedOutput.title}</h3>
                              <p className="talk-llm-meta">
                                Version {selectedOutput.version} · Updated{' '}
                                {formatDateTime(selectedOutput.updatedAt)}
                              </p>
                            </div>
                          </div>
                          <label style={{ display: 'block' }}>
                            <span className="settings-label">Title</span>
                            <input
                              type="text"
                              value={outputTitleDraft}
                              onChange={(event) =>
                                setOutputTitleDraft(event.target.value)
                              }
                              disabled={
                                !canEditOutputs ||
                                talkOutputsStatus.status === 'saving'
                              }
                              style={{ width: '100%' }}
                            />
                          </label>
                          <label
                            style={{ display: 'block', marginTop: '0.75rem' }}
                          >
                            <span className="settings-label">
                              Markdown Body
                            </span>
                            <textarea
                              value={outputBodyDraft}
                              onChange={(event) =>
                                setOutputBodyDraft(event.target.value)
                              }
                              rows={18}
                              disabled={
                                !canEditOutputs ||
                                talkOutputsStatus.status === 'saving'
                              }
                              style={{ width: '100%', resize: 'vertical' }}
                            />
                          </label>
                          <div
                            className="settings-button-row"
                            style={{ marginTop: '0.75rem' }}
                          >
                            {canEditOutputs ? (
                              <button
                                type="button"
                                className="secondary-btn"
                                onClick={() => void handleSaveOutput()}
                                disabled={
                                  talkOutputsStatus.status === 'saving' ||
                                  !hasUnsavedOutputChanges
                                }
                              >
                                {talkOutputsStatus.status === 'saving'
                                  ? 'Saving…'
                                  : 'Save Report'}
                              </button>
                            ) : null}
                            {canEditOutputs ? (
                              <button
                                type="button"
                                className="secondary-btn danger-btn"
                                onClick={() => void handleDeleteOutput()}
                                disabled={talkOutputsStatus.status === 'saving'}
                              >
                                Delete Report
                              </button>
                            ) : null}
                          </div>
                        </div>
                      ) : (
                        <p className="page-state">
                          Select an output to view its full contents.
                        </p>
                      )}
                    </div>
                  </div>

                  {talkOutputsStatus.status === 'success' &&
                  talkOutputsStatus.message ? (
                    <div
                      className="inline-banner inline-banner-success"
                      role="status"
                    >
                      {talkOutputsStatus.message}
                    </div>
                  ) : null}
                  {talkOutputsStatus.status === 'error' && talkOutputsLoaded ? (
                    <div
                      className="inline-banner inline-banner-danger"
                      role="alert"
                    >
                      {talkOutputsStatus.message}
                    </div>
                  ) : null}
                </>
              )}
            </section>
          ) : null}

          {currentTab === 'jobs' ? (
            <section className="talk-tab-panel" aria-label="Talk jobs">
              {talkJobsStatus.status === 'loading' && !talkJobsLoaded ? (
                <p className="page-state">Loading jobs…</p>
              ) : talkJobsStatus.status === 'error' && !talkJobsLoaded ? (
                <p className="page-state error">{talkJobsStatus.message}</p>
              ) : (
                <>
                  <div className="agents-panel-header">
                    <h2>Jobs</h2>
                    {canEditJobs ? (
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={handleCreateJobDraft}
                        disabled={talkJobsStatus.status === 'saving'}
                      >
                        New Job
                      </button>
                    ) : null}
                  </div>
                  <p className="policy-muted">
                    Jobs are scheduled Talk specialists. They run one selected
                    agent on a recurring cadence and deliver either to a thread
                    or a maintained report.
                  </p>

                  <div className="talk-outputs-layout">
                    <aside className="talk-outputs-list" aria-label="Jobs list">
                      {talkJobs.length > 0 ? (
                        talkJobs.map((job) => (
                          <button
                            key={job.id}
                            type="button"
                            className={`talk-output-list-item${
                              !creatingJob && selectedJobId === job.id
                                ? ' talk-output-list-item-active'
                                : ''
                            }`}
                            onClick={() => void handleSelectJob(job.id)}
                          >
                            <strong>{job.title}</strong>
                            <span className="talk-llm-meta">
                              {job.deliverableKind === 'report'
                                ? 'Report'
                                : 'Thread'}{' '}
                              · {job.status}
                            </span>
                            <span className="talk-llm-meta">
                              {formatTalkJobSchedule(job.schedule)}
                            </span>
                            {job.nextDueAt ? (
                              <span className="talk-llm-meta">
                                Next {formatDateTime(job.nextDueAt)}
                              </span>
                            ) : null}
                          </button>
                        ))
                      ) : (
                        <p className="page-state">No jobs yet.</p>
                      )}
                    </aside>

                    <div className="talk-output-editor">
                      {creatingJob || selectedJob ? (
                        <div className="talk-llm-card">
                          <div className="connector-card-header">
                            <div>
                              <h3>
                                {creatingJob
                                  ? 'New Job'
                                  : selectedJob?.title || 'Job'}
                              </h3>
                              {!creatingJob && selectedJob ? (
                                <p className="talk-llm-meta">
                                  Status {selectedJob.status} · Runs{' '}
                                  {selectedJob.runCount}
                                  {selectedJob.nextDueAt
                                    ? ` · Next ${formatDateTime(
                                        selectedJob.nextDueAt,
                                      )}`
                                    : ''}
                                </p>
                              ) : (
                                <p className="talk-llm-meta">
                                  Configure schedule, scope, agent, prompt, and
                                  deliverable.
                                </p>
                              )}
                            </div>
                          </div>

                          <label style={{ display: 'block' }}>
                            <span className="settings-label">Title</span>
                            <input
                              type="text"
                              value={jobDraft.title}
                              onChange={(event) =>
                                setJobDraft((current) => ({
                                  ...current,
                                  title: event.target.value,
                                }))
                              }
                              disabled={
                                !canEditJobs ||
                                talkJobsStatus.status === 'saving'
                              }
                              style={{ width: '100%' }}
                            />
                          </label>

                          <label
                            style={{ display: 'block', marginTop: '0.75rem' }}
                          >
                            <span className="settings-label">Target Agent</span>
                            <select
                              value={jobDraft.targetAgentId}
                              onChange={(event) =>
                                setJobDraft((current) => ({
                                  ...current,
                                  targetAgentId: event.target.value,
                                }))
                              }
                              disabled={
                                !canEditJobs ||
                                talkJobsStatus.status === 'saving'
                              }
                              style={{ width: '100%' }}
                            >
                              <option value="">Select an agent…</option>
                              {agents.map((agent) => (
                                <option key={agent.id} value={agent.id}>
                                  {agent.nickname}
                                  {agent.isPrimary ? ' (Primary)' : ''}
                                </option>
                              ))}
                            </select>
                          </label>

                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                              gap: '0.75rem',
                              marginTop: '0.75rem',
                            }}
                          >
                            <label style={{ display: 'block' }}>
                              <span className="settings-label">
                                Deliverable
                              </span>
                              <select
                                value={jobDraft.deliverableKind}
                                onChange={(event) =>
                                  setJobDraft((current) => ({
                                    ...current,
                                    deliverableKind: event.target.value as
                                      | 'thread'
                                      | 'report',
                                  }))
                                }
                                disabled={
                                  !canEditJobs ||
                                  talkJobsStatus.status === 'saving'
                                }
                                style={{ width: '100%' }}
                              >
                                <option value="thread">Thread</option>
                                <option value="report">Report</option>
                              </select>
                            </label>
                            <label style={{ display: 'block' }}>
                              <span className="settings-label">Timezone</span>
                              <input
                                type="text"
                                value={jobDraft.timezone}
                                onChange={(event) =>
                                  setJobDraft((current) => ({
                                    ...current,
                                    timezone: event.target.value,
                                  }))
                                }
                                disabled={
                                  !canEditJobs ||
                                  talkJobsStatus.status === 'saving'
                                }
                                style={{ width: '100%' }}
                              />
                            </label>
                          </div>

                          {jobDraft.deliverableKind === 'report' ? (
                            <div style={{ marginTop: '0.75rem' }}>
                              <label style={{ display: 'block' }}>
                                <span className="settings-label">
                                  Report Target
                                </span>
                                <select
                                  value={jobDraft.reportTargetMode}
                                  onChange={(event) =>
                                    setJobDraft((current) => ({
                                      ...current,
                                      reportTargetMode: event.target.value as
                                        | 'existing'
                                        | 'create',
                                    }))
                                  }
                                  disabled={
                                    !canEditJobs ||
                                    talkJobsStatus.status === 'saving'
                                  }
                                  style={{ width: '100%' }}
                                >
                                  <option value="existing">
                                    Existing output
                                  </option>
                                  <option value="create">Create report</option>
                                </select>
                              </label>
                              {jobDraft.reportTargetMode === 'existing' ? (
                                <label
                                  style={{
                                    display: 'block',
                                    marginTop: '0.5rem',
                                  }}
                                >
                                  <span className="settings-label">Output</span>
                                  <select
                                    value={jobDraft.reportOutputId}
                                    onChange={(event) =>
                                      setJobDraft((current) => ({
                                        ...current,
                                        reportOutputId: event.target.value,
                                      }))
                                    }
                                    disabled={
                                      !canEditJobs ||
                                      talkJobsStatus.status === 'saving'
                                    }
                                    style={{ width: '100%' }}
                                  >
                                    <option value="">Select an output…</option>
                                    {talkOutputs.map((output) => (
                                      <option key={output.id} value={output.id}>
                                        {output.title}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              ) : (
                                <>
                                  <label
                                    style={{
                                      display: 'block',
                                      marginTop: '0.5rem',
                                    }}
                                  >
                                    <span className="settings-label">
                                      New Report Title
                                    </span>
                                    <input
                                      type="text"
                                      value={jobDraft.createReportTitle}
                                      onChange={(event) =>
                                        setJobDraft((current) => ({
                                          ...current,
                                          createReportTitle: event.target.value,
                                        }))
                                      }
                                      disabled={
                                        !canEditJobs ||
                                        talkJobsStatus.status === 'saving'
                                      }
                                      style={{ width: '100%' }}
                                    />
                                  </label>
                                  <label
                                    style={{
                                      display: 'block',
                                      marginTop: '0.5rem',
                                    }}
                                  >
                                    <span className="settings-label">
                                      Initial Report Body
                                    </span>
                                    <textarea
                                      rows={4}
                                      value={
                                        jobDraft.createReportContentMarkdown
                                      }
                                      onChange={(event) =>
                                        setJobDraft((current) => ({
                                          ...current,
                                          createReportContentMarkdown:
                                            event.target.value,
                                        }))
                                      }
                                      disabled={
                                        !canEditJobs ||
                                        talkJobsStatus.status === 'saving'
                                      }
                                      style={{
                                        width: '100%',
                                        resize: 'vertical',
                                      }}
                                    />
                                  </label>
                                </>
                              )}
                            </div>
                          ) : null}

                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns:
                                jobDraft.scheduleKind === 'weekly'
                                  ? 'repeat(4, minmax(0, 1fr))'
                                  : 'repeat(2, minmax(0, 1fr))',
                              gap: '0.75rem',
                              marginTop: '0.75rem',
                            }}
                          >
                            <label style={{ display: 'block' }}>
                              <span className="settings-label">Schedule</span>
                              <select
                                value={jobDraft.scheduleKind}
                                onChange={(event) =>
                                  setJobDraft((current) => ({
                                    ...current,
                                    scheduleKind: event.target
                                      .value as TalkJobSchedule['kind'],
                                  }))
                                }
                                disabled={
                                  !canEditJobs ||
                                  talkJobsStatus.status === 'saving'
                                }
                                style={{ width: '100%' }}
                              >
                                <option value="weekly">Weekly</option>
                                <option value="hourly_interval">
                                  Hourly Interval
                                </option>
                              </select>
                            </label>
                            {jobDraft.scheduleKind === 'hourly_interval' ? (
                              <label style={{ display: 'block' }}>
                                <span className="settings-label">
                                  Every Hours
                                </span>
                                <input
                                  type="number"
                                  min={1}
                                  max={24}
                                  value={jobDraft.everyHours}
                                  onChange={(event) =>
                                    setJobDraft((current) => ({
                                      ...current,
                                      everyHours: Number(event.target.value),
                                    }))
                                  }
                                  disabled={
                                    !canEditJobs ||
                                    talkJobsStatus.status === 'saving'
                                  }
                                  style={{ width: '100%' }}
                                />
                              </label>
                            ) : (
                              <>
                                <label style={{ display: 'block' }}>
                                  <span className="settings-label">Hour</span>
                                  <input
                                    type="number"
                                    min={0}
                                    max={23}
                                    value={jobDraft.hour}
                                    onChange={(event) =>
                                      setJobDraft((current) => ({
                                        ...current,
                                        hour: Number(event.target.value),
                                      }))
                                    }
                                    disabled={
                                      !canEditJobs ||
                                      talkJobsStatus.status === 'saving'
                                    }
                                    style={{ width: '100%' }}
                                  />
                                </label>
                                <label style={{ display: 'block' }}>
                                  <span className="settings-label">Minute</span>
                                  <input
                                    type="number"
                                    min={0}
                                    max={59}
                                    value={jobDraft.minute}
                                    onChange={(event) =>
                                      setJobDraft((current) => ({
                                        ...current,
                                        minute: Number(event.target.value),
                                      }))
                                    }
                                    disabled={
                                      !canEditJobs ||
                                      talkJobsStatus.status === 'saving'
                                    }
                                    style={{ width: '100%' }}
                                  />
                                </label>
                                <div>
                                  <span className="settings-label">
                                    Weekdays
                                  </span>
                                  <div
                                    style={{
                                      display: 'flex',
                                      flexWrap: 'wrap',
                                      gap: '0.5rem',
                                      marginTop: '0.35rem',
                                    }}
                                  >
                                    {JOB_WEEKDAY_ORDER.map((weekday) => (
                                      <label key={weekday}>
                                        <input
                                          type="checkbox"
                                          checked={jobDraft.weekdays.includes(
                                            weekday,
                                          )}
                                          onChange={() =>
                                            handleToggleJobWeekday(weekday)
                                          }
                                          disabled={
                                            !canEditJobs ||
                                            talkJobsStatus.status === 'saving'
                                          }
                                        />{' '}
                                        {JOB_WEEKDAY_LABELS[weekday]}
                                      </label>
                                    ))}
                                  </div>
                                </div>
                              </>
                            )}
                          </div>

                          <label
                            style={{ display: 'block', marginTop: '0.75rem' }}
                          >
                            <span className="settings-label">Prompt</span>
                            <textarea
                              rows={8}
                              value={jobDraft.prompt}
                              onChange={(event) =>
                                setJobDraft((current) => ({
                                  ...current,
                                  prompt: event.target.value,
                                }))
                              }
                              disabled={
                                !canEditJobs ||
                                talkJobsStatus.status === 'saving'
                              }
                              style={{ width: '100%', resize: 'vertical' }}
                            />
                          </label>

                          <div style={{ marginTop: '0.75rem' }}>
                            <span className="settings-label">Scope</span>
                            <label
                              style={{
                                display: 'block',
                                marginTop: '0.35rem',
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={jobDraft.allowWeb}
                                onChange={(event) =>
                                  setJobDraft((current) => ({
                                    ...current,
                                    allowWeb: event.target.checked,
                                  }))
                                }
                                disabled={
                                  !canEditJobs ||
                                  talkJobsStatus.status === 'saving'
                                }
                              />{' '}
                              Allow web access
                            </label>
                            <div style={{ marginTop: '0.5rem' }}>
                              <div className="talk-llm-meta">
                                Data connectors
                              </div>
                              <div
                                style={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: '0.5rem',
                                  marginTop: '0.35rem',
                                }}
                              >
                                {talkConnectors.length > 0 ? (
                                  talkConnectors.map((connector) => (
                                    <label key={connector.id}>
                                      <input
                                        type="checkbox"
                                        checked={jobDraft.connectorIds.includes(
                                          connector.id,
                                        )}
                                        onChange={() =>
                                          handleToggleJobConnector(connector.id)
                                        }
                                        disabled={
                                          !canEditJobs ||
                                          talkJobsStatus.status === 'saving'
                                        }
                                      />{' '}
                                      {connector.name}
                                    </label>
                                  ))
                                ) : (
                                  <span className="talk-llm-meta">
                                    No attached data connectors
                                  </span>
                                )}
                              </div>
                            </div>
                            <div style={{ marginTop: '0.5rem' }}>
                              <div className="talk-llm-meta">
                                Channel bindings
                              </div>
                              <div
                                style={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: '0.5rem',
                                  marginTop: '0.35rem',
                                }}
                              >
                                {channelBindings.length > 0 ? (
                                  channelBindings.map((binding) => (
                                    <label key={binding.id}>
                                      <input
                                        type="checkbox"
                                        checked={jobDraft.channelBindingIds.includes(
                                          binding.id,
                                        )}
                                        onChange={() =>
                                          handleToggleJobChannelBinding(
                                            binding.id,
                                          )
                                        }
                                        disabled={
                                          !canEditJobs ||
                                          talkJobsStatus.status === 'saving'
                                        }
                                      />{' '}
                                      {binding.displayName}
                                    </label>
                                  ))
                                ) : (
                                  <span className="talk-llm-meta">
                                    No Talk channel bindings
                                  </span>
                                )}
                              </div>
                            </div>
                            <p
                              className="talk-llm-meta"
                              style={{ marginTop: '0.5rem' }}
                            >
                              {summarizeTalkJobScope(
                                draftToTalkJobScope(jobDraft),
                                talkConnectors,
                                channelBindings,
                              )}
                            </p>
                          </div>

                          <div
                            className="settings-button-row"
                            style={{ marginTop: '0.75rem' }}
                          >
                            {canEditJobs ? (
                              <button
                                type="button"
                                className="secondary-btn"
                                onClick={() => void handleSaveJob()}
                                disabled={
                                  talkJobsStatus.status === 'saving' ||
                                  !hasUnsavedJobChanges
                                }
                              >
                                {talkJobsStatus.status === 'saving'
                                  ? 'Saving…'
                                  : creatingJob
                                    ? 'Create Job'
                                    : 'Save Job'}
                              </button>
                            ) : null}
                            {!creatingJob && selectedJob ? (
                              <button
                                type="button"
                                className="secondary-btn"
                                onClick={() => void handleRunJobNow()}
                                disabled={talkJobsStatus.status === 'saving'}
                              >
                                Run Now
                              </button>
                            ) : null}
                            {!creatingJob &&
                            selectedJob?.status === 'active' ? (
                              <button
                                type="button"
                                className="secondary-btn"
                                onClick={() => void handlePauseJob()}
                                disabled={talkJobsStatus.status === 'saving'}
                              >
                                Pause
                              </button>
                            ) : null}
                            {!creatingJob &&
                            selectedJob &&
                            selectedJob.status !== 'active' ? (
                              <button
                                type="button"
                                className="secondary-btn"
                                onClick={() => void handleResumeJob()}
                                disabled={talkJobsStatus.status === 'saving'}
                              >
                                Resume
                              </button>
                            ) : null}
                            {!creatingJob && selectedJob ? (
                              <button
                                type="button"
                                className="secondary-btn danger-btn"
                                onClick={() => void handleDeleteJob()}
                                disabled={talkJobsStatus.status === 'saving'}
                              >
                                Delete Job
                              </button>
                            ) : null}
                            {!creatingJob && selectedJob ? (
                              selectedJob.deliverableKind === 'thread' ? (
                                <Link
                                  className="secondary-btn"
                                  to={buildThreadHref(
                                    talkId,
                                    selectedJob.threadId,
                                  )}
                                >
                                  Open Thread
                                </Link>
                              ) : (
                                <Link
                                  className="secondary-btn"
                                  to={outputsTabHref}
                                >
                                  Open Report
                                </Link>
                              )
                            ) : null}
                          </div>

                          {!creatingJob && selectedJob ? (
                            <div style={{ marginTop: '1rem' }}>
                              <h4 style={{ marginBottom: '0.5rem' }}>
                                Recent Runs
                              </h4>
                              {selectedJobRunsStatus.status === 'loading' ? (
                                <p className="page-state">Loading runs…</p>
                              ) : selectedJobRunsStatus.status === 'error' ? (
                                <p className="page-state error">
                                  {selectedJobRunsStatus.message}
                                </p>
                              ) : selectedJobRuns.length > 0 ? (
                                <div
                                  style={{
                                    display: 'grid',
                                    gap: '0.5rem',
                                  }}
                                >
                                  {selectedJobRuns.map((run) => (
                                    <div
                                      key={run.id}
                                      className="talk-output-list-item"
                                    >
                                      <strong>{run.status}</strong>
                                      <span className="talk-llm-meta">
                                        {formatDateTime(run.createdAt)}
                                      </span>
                                      {run.responseExcerpt ? (
                                        <span className="talk-llm-meta">
                                          {run.responseExcerpt}
                                        </span>
                                      ) : null}
                                      {run.errorMessage ? (
                                        <span className="talk-llm-meta">
                                          {run.errorMessage}
                                        </span>
                                      ) : null}
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="page-state">
                                  No runs yet for this job.
                                </p>
                              )}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <p className="page-state">
                          Select a job or create a new one.
                        </p>
                      )}
                    </div>
                  </div>

                  {talkJobsStatus.status === 'success' &&
                  talkJobsStatus.message ? (
                    <div
                      className="inline-banner inline-banner-success"
                      role="status"
                    >
                      {talkJobsStatus.message}
                    </div>
                  ) : null}
                  {talkJobsStatus.status === 'error' && talkJobsLoaded ? (
                    <div
                      className="inline-banner inline-banner-danger"
                      role="alert"
                    >
                      {talkJobsStatus.message}
                    </div>
                  ) : null}
                </>
              )}
            </section>
          ) : null}

          {currentTab === 'tools' ? (
            <section className="talk-tab-panel" aria-label="Talk tools">
              {toolStatus.status === 'loading' ? (
                <p className="page-state">Loading Talk tools…</p>
              ) : toolStatus.status === 'error' ? (
                <p className="page-state error">{toolStatus.message}</p>
              ) : talkTools ? (
                <>
                  <div className="agents-panel-header">
                    <h2>Tools</h2>
                  </div>
                  <p className="policy-muted">
                    Bind bounded resources, grant tool access for this Talk, and
                    inspect which agents can actually use those tools.
                  </p>

                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Capability Summary</h3>
                        <p className="talk-llm-meta">
                          Effective Talk-wide capability summary for the current
                          bindings and user identity.
                        </p>
                      </div>
                    </div>
                    {talkTools.summary.length > 0 ? (
                      <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                        {talkTools.summary.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="page-state">
                        No Talk tools are enabled yet.
                      </p>
                    )}
                    {talkTools.warnings.map((warning) => (
                      <div
                        key={warning}
                        className="inline-banner inline-banner-warning"
                        role="status"
                        style={{ marginTop: '0.75rem' }}
                      >
                        {warning}
                      </div>
                    ))}
                  </div>

                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Google Account</h3>
                        <p className="talk-llm-meta">
                          Google-scoped tools run as the triggering user.
                        </p>
                      </div>
                    </div>
                    <p className="talk-llm-meta">
                      {talkTools.googleAccount.connected
                        ? `Connected as ${talkTools.googleAccount.email || 'Unknown account'}`
                        : 'No Google account connected for this user.'}
                    </p>
                    {talkTools.googleAccount.scopes.length > 0 ? (
                      <p className="talk-llm-meta">
                        Scopes: {talkTools.googleAccount.scopes.join(', ')}
                      </p>
                    ) : null}
                    <div className="settings-button-row">
                      {canEditAgents && !talkTools.googleAccount.connected ? (
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => void handleConnectGoogleAccount()}
                          disabled={toolStatus.status === 'saving'}
                        >
                          Connect Google
                        </button>
                      ) : null}
                      {canEditAgents && missingGoogleScopes.length > 0 ? (
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => void handleGrantGoogleScopes()}
                          disabled={toolStatus.status === 'saving'}
                        >
                          Grant Google permissions
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Talk Grants</h3>
                        <p className="talk-llm-meta">
                          Enable or restrict built-in tool capabilities for this
                          Talk.
                        </p>
                      </div>
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns:
                          'repeat(auto-fit, minmax(220px, 1fr))',
                        gap: '0.75rem',
                      }}
                    >
                      {talkTools.registry.map((entry) => (
                        <label
                          key={entry.id}
                          className="talk-llm-card"
                          style={{ margin: 0 }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: '0.75rem',
                            }}
                          >
                            <strong>{entry.displayName}</strong>
                            <input
                              type="checkbox"
                              aria-label={entry.displayName}
                              checked={toolGrantDrafts[entry.id] ?? false}
                              disabled={
                                !canEditAgents || toolStatus.status === 'saving'
                              }
                              onChange={(event) =>
                                setToolGrantDrafts((current) => ({
                                  ...current,
                                  [entry.id]: event.target.checked,
                                }))
                              }
                            />
                          </div>
                          <p
                            className="talk-llm-meta"
                            style={{ marginBottom: 0 }}
                          >
                            {entry.description}
                          </p>
                        </label>
                      ))}
                    </div>
                    {canEditAgents ? (
                      <div
                        className="settings-button-row"
                        style={{ marginTop: '0.75rem' }}
                      >
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => void handleSaveTalkTools()}
                          disabled={
                            toolStatus.status === 'saving' ||
                            !hasUnsavedToolChanges
                          }
                        >
                          {toolStatus.status === 'saving'
                            ? 'Saving…'
                            : 'Save Tool Grants'}
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Bound Drive Resources</h3>
                        <p className="talk-llm-meta">
                          Agents may only search/read Drive, Docs, and Sheets
                          inside these bounds.
                        </p>
                      </div>
                    </div>
                    {talkTools.bindings.length > 0 ? (
                      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {talkTools.bindings.map((binding) => (
                          <li
                            key={binding.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.75rem',
                              padding: '0.45rem 0',
                              borderBottom: '1px solid var(--border, #e6e9ef)',
                            }}
                          >
                            <span
                              style={{
                                fontSize: '0.72rem',
                                textTransform: 'uppercase',
                                opacity: 0.6,
                              }}
                            >
                              {binding.kind === 'google_drive_folder'
                                ? 'Folder'
                                : binding.kind === 'google_drive_file'
                                  ? 'File'
                                  : binding.kind}
                            </span>
                            <strong style={{ flex: 1 }}>
                              {binding.displayName}
                            </strong>
                            <code>{binding.externalId}</code>
                            {canEditAgents ? (
                              <button
                                type="button"
                                className="secondary-btn"
                                onClick={() =>
                                  void handleDeleteDriveBinding(binding.id)
                                }
                                disabled={toolStatus.status === 'saving'}
                              >
                                Remove
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="page-state">
                        No Drive files or folders are bound to this Talk yet.
                      </p>
                    )}
                    {canEditAgents ? (
                      <div style={{ marginTop: '0.75rem' }}>
                        <div className="settings-button-row">
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() => void handleOpenDrivePicker('folder')}
                            disabled={
                              toolStatus.status === 'saving' ||
                              !talkTools.googleAccount.connected
                            }
                          >
                            Bind Folders
                          </button>
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() => void handleOpenDrivePicker('file')}
                            disabled={
                              toolStatus.status === 'saving' ||
                              !talkTools.googleAccount.connected
                            }
                          >
                            Bind Files
                          </button>
                        </div>
                        <p
                          className="talk-llm-meta"
                          style={{ marginTop: '0.5rem' }}
                        >
                          Use Google Picker for multi-select binding, or enter a
                          Drive id manually below.
                        </p>
                        <div className="connector-attach-row">
                          <label>
                            <span className="settings-label">Kind</span>
                            <select
                              value={driveBindingDraft.bindingKind}
                              onChange={(event) =>
                                setDriveBindingDraft((current) => ({
                                  ...current,
                                  bindingKind: event.target.value as
                                    | 'google_drive_folder'
                                    | 'google_drive_file',
                                }))
                              }
                              disabled={toolStatus.status === 'saving'}
                            >
                              <option value="google_drive_folder">
                                Folder
                              </option>
                              <option value="google_drive_file">File</option>
                            </select>
                          </label>
                          <label style={{ flex: 1 }}>
                            <span className="settings-label">Display Name</span>
                            <input
                              type="text"
                              value={driveBindingDraft.displayName}
                              onChange={(event) =>
                                setDriveBindingDraft((current) => ({
                                  ...current,
                                  displayName: event.target.value,
                                }))
                              }
                              placeholder="Accounting"
                              style={{ width: '100%' }}
                              disabled={toolStatus.status === 'saving'}
                            />
                          </label>
                        </div>
                        <label
                          style={{ display: 'block', marginTop: '0.5rem' }}
                        >
                          <span className="settings-label">Resource ID</span>
                          <input
                            type="text"
                            value={driveBindingDraft.externalId}
                            onChange={(event) =>
                              setDriveBindingDraft((current) => ({
                                ...current,
                                externalId: event.target.value,
                              }))
                            }
                            placeholder="drive-folder-id-or-file-id"
                            style={{ width: '100%' }}
                            disabled={toolStatus.status === 'saving'}
                          />
                        </label>
                        <div
                          className="settings-button-row"
                          style={{ marginTop: '0.75rem' }}
                        >
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() => void handleAddDriveBinding()}
                            disabled={toolStatus.status === 'saving'}
                          >
                            Add Drive Binding
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Effective Agent Access</h3>
                        <p className="talk-llm-meta">
                          Which agents can actually use the currently granted
                          tools on this Talk.
                        </p>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gap: '0.75rem' }}>
                      {talkTools.effectiveAccess.map((agent) => (
                        <article key={agent.agentId} className="talk-llm-card">
                          <div className="connector-card-header">
                            <div>
                              <h3>{agent.nickname}</h3>
                              <p className="talk-llm-meta">
                                {agent.modelId || 'No model selected'}
                              </p>
                            </div>
                          </div>
                          <div
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: '0.5rem',
                            }}
                          >
                            {agent.toolAccess.map((tool) => {
                              const entry = talkTools.registry.find(
                                (candidate) => candidate.id === tool.toolId,
                              );
                              if (!entry) return null;
                              return (
                                <span
                                  key={`${agent.agentId}:${tool.toolId}`}
                                  className="talk-agent-chip"
                                  title={tool.toolId}
                                >
                                  {entry.displayName}:{' '}
                                  {formatToolAccessState(tool.state)}
                                </span>
                              );
                            })}
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>

                  {toolStatus.status === 'success' ? (
                    <div
                      className="inline-banner inline-banner-success"
                      role="status"
                    >
                      {toolStatus.message}
                    </div>
                  ) : null}
                </>
              ) : null}
            </section>
          ) : null}

          {currentTab === 'channels' ? (
            <section className="talk-tab-panel" aria-label="Talk channels">
              <div className="agents-panel-header">
                <h2>Connected Channels</h2>
              </div>
              <p className="policy-muted">
                Bind this talk to external channels so inbound platform messages
                can create Talk turns and completed replies can be delivered
                back out. Slack workspaces still install in Connectors, but you
                can sync the selected Slack workspace here after inviting the
                app to a channel. Telegram still uses approved destinations from
                Connectors.
              </p>

              {channelStatus.status === 'error' ? (
                <div className="inline-banner inline-banner-error" role="alert">
                  {channelStatus.message}
                </div>
              ) : null}
              {channelStatus.status === 'success' ? (
                <div
                  className="inline-banner inline-banner-success"
                  role="status"
                >
                  {channelStatus.message}
                </div>
              ) : null}

              {canBrowseChannelConnections ? (
                <div className="talk-llm-card connector-attach-card">
                  <div className="connector-card-header">
                    <div>
                      <h3>Add Channel Binding</h3>
                      <p className="talk-llm-meta">
                        Slack channels are chosen here after sync. If you just
                        invited the app in Slack, use Sync Slack Channels below
                        to refresh this list. Telegram destinations still use
                        the approved list from Connectors.
                      </p>
                    </div>
                  </div>
                  {channelConnections.length === 0 ? (
                    <p className="page-state">
                      No channel connections are available in this runtime.
                    </p>
                  ) : (
                    <>
                      {availableChannelPlatforms.length > 1 ? (
                        <div className="connector-attach-row">
                          <label>
                            <span className="settings-label">Platform</span>
                            <select
                              value={selectedChannelPlatform}
                              onChange={(event) =>
                                setChannelCreateDraft((current) => ({
                                  ...current,
                                  platform: event.target
                                    .value as ChannelConnection['platform'],
                                  template:
                                    event.target.value === 'slack'
                                      ? current.template
                                      : 'blank',
                                  connectionId: '',
                                  targetKey: '',
                                  displayName: '',
                                }))
                              }
                              disabled={
                                channelStatus.status === 'saving' ||
                                channelTargetsLoading
                              }
                            >
                              {availableChannelPlatforms.map((platform) => (
                                <option key={platform} value={platform}>
                                  {formatChannelPlatform(platform)}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                      ) : null}
                      {selectedChannelPlatform === 'slack' &&
                      selectedPlatformConnections.length > 1 ? (
                        <div className="connector-attach-row">
                          <label style={{ flex: 1 }}>
                            <span className="settings-label">Workspace</span>
                            <select
                              value={selectedChannelConnection?.id || ''}
                              onChange={(event) =>
                                setChannelCreateDraft((current) => ({
                                  ...current,
                                  connectionId: event.target.value,
                                  targetKey: '',
                                  displayName: '',
                                }))
                              }
                              disabled={
                                channelStatus.status === 'saving' ||
                                channelTargetsLoading
                              }
                            >
                              {selectedPlatformConnections.map((connection) => (
                                <option
                                  key={connection.id}
                                  value={connection.id}
                                >
                                  {connection.displayName}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                      ) : null}
                      {selectedChannelPlatform === 'slack' &&
                      selectedChannelConnection ? (
                        <div className="talk-channel-workspace-summary">
                          <div>
                            <span className="settings-label">
                              Slack Workspace
                            </span>
                            <div className="talk-channel-workspace-summary-title">
                              <strong>
                                {selectedChannelConnection.displayName}
                              </strong>
                              <span
                                className={channelConnectionStatusClass(
                                  selectedChannelConnection.healthStatus,
                                )}
                              >
                                {formatChannelConnectionHealthStatus(
                                  selectedChannelConnection.healthStatus,
                                )}
                              </span>
                            </div>
                            <p className="talk-llm-meta">
                              {buildSlackWorkspaceSyncSummary(
                                selectedChannelConnection,
                              )}
                            </p>
                            {selectedChannelConnection.lastHealthError ? (
                              <p className="talk-llm-meta">
                                Last health error:{' '}
                                {selectedChannelConnection.lastHealthError}
                              </p>
                            ) : null}
                          </div>
                          <div className="talk-channel-workspace-summary-actions">
                            <button
                              type="button"
                              className="secondary-btn"
                              onClick={() =>
                                void handleSyncSelectedSlackWorkspace()
                              }
                              disabled={
                                channelTargetsLoading ||
                                channelStatus.status === 'saving' ||
                                channelSyncingConnectionId ===
                                  selectedChannelConnection.id
                              }
                            >
                              {channelSyncingConnectionId ===
                              selectedChannelConnection.id
                                ? 'Syncing…'
                                : 'Sync Slack Channels'}
                            </button>
                          </div>
                        </div>
                      ) : null}
                      <div className="connector-attach-row">
                        <label style={{ flex: 1 }}>
                          <span className="settings-label">
                            {selectedChannelPlatform === 'slack'
                              ? 'Browse synced Slack channels'
                              : 'Browse approved Telegram destinations'}
                          </span>
                          <input
                            type="text"
                            value={channelTargetQuery}
                            onChange={(event) =>
                              setChannelTargetQuery(event.target.value)
                            }
                            placeholder={
                              selectedChannelPlatform === 'slack'
                                ? 'Filter by workspace, channel, or ID'
                                : 'Filter approved Telegram destinations'
                            }
                            style={{ width: '100%' }}
                            disabled={
                              channelStatus.status === 'saving' ||
                              channelTargetsLoading
                            }
                          />
                        </label>
                      </div>
                      <div className="channel-target-picker">
                        <div
                          className="channel-target-picker-summary"
                          aria-live="polite"
                        >
                          {channelTargetsLoading
                            ? selectedChannelPlatform === 'slack'
                              ? 'Loading synced Slack channels…'
                              : 'Loading approved Telegram destinations…'
                            : channelTargetInventory.totalCount === 0
                              ? selectedChannelPlatform === 'slack'
                                ? 'No synced Slack channels yet. Sync the selected Slack workspace to refresh recent invites.'
                                : 'No approved Telegram destinations yet.'
                              : channelTargetInventory.hasMore
                                ? `Showing ${channelTargetOptions.length} of ${channelTargetInventory.totalCount} ${selectedChannelPlatform === 'slack' ? 'Slack channels' : 'Telegram destinations'}`
                                : `${channelTargetInventory.totalCount} ${selectedChannelPlatform === 'slack' ? 'Slack channel' : 'Telegram destination'}${channelTargetInventory.totalCount === 1 ? '' : 's'}`}
                        </div>
                        <div className="channel-target-picker-results">
                          {channelTargetsLoading ? (
                            <div className="channel-target-picker-empty">
                              {selectedChannelPlatform === 'slack'
                                ? 'Loading synced Slack channels…'
                                : 'Loading approved Telegram destinations…'}
                            </div>
                          ) : channelTargetOptions.length === 0 ? (
                            selectedChannelPlatform === 'slack' ? (
                              <div className="channel-target-picker-empty">
                                No synced Slack channels match this filter. Use{' '}
                                <strong>Sync Slack Channels</strong> to refresh
                                recent invites, or{' '}
                                <Link to="/app/connectors?tab=channel-connectors">
                                  Manage Connectors
                                </Link>{' '}
                                to sync channels or diagnose a missing private
                                channel.
                              </div>
                            ) : (
                              <div className="channel-target-picker-empty">
                                No approved Telegram destinations match this
                                filter.{' '}
                                <Link to="/app/connectors?tab=channel-connectors">
                                  Manage Connectors
                                </Link>
                                .
                              </div>
                            )
                          ) : (
                            channelTargetOptions.map((option) => {
                              const selected =
                                channelCreateDraft.targetKey === option.key;
                              const disabled =
                                option.requiresInvite ||
                                option.occupiedByThisTalk ||
                                option.occupiedByOtherTalk;
                              return (
                                <div
                                  key={option.key}
                                  className={`channel-target-picker-option${selected ? ' channel-target-picker-option-selected' : ''}${disabled ? ' channel-target-picker-option-disabled' : ''}`}
                                  role="button"
                                  tabIndex={disabled ? -1 : 0}
                                  aria-pressed={selected}
                                  aria-disabled={disabled}
                                  onClick={() => {
                                    if (
                                      disabled ||
                                      channelStatus.status === 'saving'
                                    ) {
                                      return;
                                    }
                                    setChannelCreateDraft((current) => ({
                                      ...current,
                                      platform: selectedChannelPlatform,
                                      connectionId: option.target.connectionId,
                                      targetKey: option.key,
                                      displayName:
                                        current.displayName ||
                                        !option.target.displayName
                                          ? current.displayName
                                          : option.target.displayName,
                                    }));
                                  }}
                                >
                                  <span className="channel-target-picker-option-title">
                                    {option.target.displayName}
                                  </span>
                                  <span className="channel-target-picker-option-meta">
                                    {option.metaLabel}
                                  </span>
                                  <div className="channel-target-picker-option-footer">
                                    <span
                                      className={`channel-target-picker-option-status${disabled ? ' channel-target-picker-option-status-disabled' : ''}`}
                                    >
                                      {option.occupancyLabel}
                                    </span>
                                    {option.openTalkHref ? (
                                      <Link
                                        className="channel-target-picker-option-link"
                                        to={option.openTalkHref}
                                        onClick={(event) =>
                                          event.stopPropagation()
                                        }
                                      >
                                        Open Talk
                                      </Link>
                                    ) : null}
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                        {channelTargetInventory.hasMore ? (
                          <div
                            className="settings-button-row"
                            style={{ marginTop: '0.75rem' }}
                          >
                            <button
                              type="button"
                              className="secondary-btn"
                              onClick={() =>
                                void handleLoadMoreChannelTargets()
                              }
                              disabled={
                                channelStatus.status === 'saving' ||
                                channelTargetsLoading
                              }
                            >
                              Load More
                            </button>
                          </div>
                        ) : null}
                      </div>
                      <div className="connector-attach-row">
                        <label style={{ flex: 1 }}>
                          <span className="settings-label">Display Name</span>
                          <input
                            type="text"
                            value={channelCreateDraft.displayName ?? ''}
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                displayName: event.target.value,
                              }))
                            }
                            placeholder={
                              selectedChannelTarget?.displayName ||
                              'Destination name'
                            }
                            disabled={channelStatus.status === 'saving'}
                          />
                        </label>
                        <label>
                          <span className="settings-label">
                            When to respond
                          </span>
                          <select
                            value={
                              channelCreateDraft.responseMode ?? 'mentions'
                            }
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                responseMode: event.target
                                  .value as TalkChannelBinding['responseMode'],
                              }))
                            }
                            disabled={channelStatus.status === 'saving'}
                          >
                            <option value="off">Off</option>
                            <option value="mentions">Mentions</option>
                            <option value="all">All messages</option>
                          </select>
                        </label>
                        <label>
                          <span className="settings-label">
                            Where to post reply
                          </span>
                          <select
                            value={channelCreateDraft.deliveryMode ?? 'reply'}
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                deliveryMode: event.target
                                  .value as TalkChannelBinding['deliveryMode'],
                              }))
                            }
                            disabled={channelStatus.status === 'saving'}
                          >
                            <option value="reply">Reply</option>
                            <option value="channel">Channel</option>
                          </select>
                        </label>
                      </div>
                      <div className="connector-attach-row">
                        <label>
                          <span className="settings-label">Responder</span>
                          <select
                            value={
                              channelCreateDraft.responderMode ?? 'primary'
                            }
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                responderMode: event.target
                                  .value as TalkChannelBinding['responderMode'],
                              }))
                            }
                            disabled={channelStatus.status === 'saving'}
                          >
                            <option value="primary">Primary agent</option>
                            <option value="agent">Specific agent</option>
                          </select>
                        </label>
                        {channelCreateDraft.responderMode === 'agent' ? (
                          <label style={{ flex: 1 }}>
                            <span className="settings-label">Agent</span>
                            <select
                              value={channelCreateDraft.responderAgentId ?? ''}
                              onChange={(event) =>
                                setChannelCreateDraft((current) => ({
                                  ...current,
                                  responderAgentId: event.target.value,
                                }))
                              }
                              disabled={channelStatus.status === 'saving'}
                            >
                              <option value="">Select an agent</option>
                              {effectiveAgents.map((agent) => (
                                <option key={agent.id} value={agent.id}>
                                  {buildAgentLabel(agent)}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                      </div>
                      <div className="connector-attach-row">
                        <label>
                          <span className="settings-label">Rate / min</span>
                          <input
                            type="number"
                            min={1}
                            value={
                              channelCreateDraft.inboundRateLimitPerMinute ?? ''
                            }
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                inboundRateLimitPerMinute: event.target.value,
                              }))
                            }
                            disabled={channelStatus.status === 'saving'}
                          />
                        </label>
                        <label>
                          <span className="settings-label">Queue Limit</span>
                          <input
                            type="number"
                            min={1}
                            value={channelCreateDraft.maxPendingEvents ?? ''}
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                maxPendingEvents: event.target.value,
                              }))
                            }
                            disabled={channelStatus.status === 'saving'}
                          />
                        </label>
                        <label>
                          <span className="settings-label">Overflow</span>
                          <select
                            value={
                              channelCreateDraft.overflowPolicy ?? 'drop_oldest'
                            }
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                overflowPolicy: event.target
                                  .value as TalkChannelBinding['overflowPolicy'],
                              }))
                            }
                            disabled={channelStatus.status === 'saving'}
                          >
                            <option value="drop_oldest">Drop oldest</option>
                            <option value="drop_newest">Drop newest</option>
                          </select>
                        </label>
                        <label>
                          <span className="settings-label">
                            Busy timeout (min)
                          </span>
                          <input
                            type="number"
                            min={1}
                            value={
                              channelCreateDraft.maxDeferredAgeMinutes ?? ''
                            }
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                maxDeferredAgeMinutes: event.target.value,
                              }))
                            }
                            disabled={channelStatus.status === 'saving'}
                          />
                        </label>
                      </div>
                      <div
                        className="talk-llm-card"
                        style={{ marginTop: '0.75rem' }}
                      >
                        <div className="connector-card-header">
                          <div>
                            <h4>Binding Instructions</h4>
                            <p className="talk-llm-meta">
                              Tell this binding what to do, when to reply, and
                              what state to keep.
                            </p>
                          </div>
                        </div>
                        <div className="connector-attach-row">
                          <label>
                            <span className="settings-label">Template</span>
                            <select
                              value={channelCreateDraft.template}
                              onChange={(event) =>
                                handleApplyCreateTemplate(
                                  event.target.value as InstructionTemplateKey,
                                )
                              }
                              disabled={channelStatus.status === 'saving'}
                            >
                              {createInstructionTemplateOptions.map(
                                (option) => (
                                  <option
                                    key={option.value}
                                    value={option.value}
                                  >
                                    {option.label}
                                  </option>
                                ),
                              )}
                            </select>
                          </label>
                          <label>
                            <span className="settings-label">Timezone</span>
                            <input
                              type="text"
                              value={channelCreateDraft.timezone}
                              onChange={(event) =>
                                setChannelCreateDraft((current) => ({
                                  ...current,
                                  timezone: event.target.value,
                                }))
                              }
                              placeholder="America/Los_Angeles"
                              disabled={channelStatus.status === 'saving'}
                            />
                          </label>
                          <label style={{ flex: 1 }}>
                            <span className="settings-label">
                              State namespace
                            </span>
                            <input
                              type="text"
                              value="Generated after the binding is created."
                              disabled
                            />
                          </label>
                        </div>
                        <label
                          style={{ display: 'block', marginTop: '0.75rem' }}
                        >
                          <span className="settings-label">Instructions</span>
                          <AutoGrowingTextarea
                            value={channelCreateDraft.instructions}
                            onChange={(event) => {
                              const nextValue = event.target.value;
                              setChannelCreateDraft((current) => ({
                                ...current,
                                instructions: nextValue,
                              }));
                              setChannelInstructionReviews((current) => ({
                                ...current,
                                [CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY]: {
                                  status: 'idle',
                                  review: null,
                                },
                              }));
                            }}
                            placeholder={BINDING_INSTRUCTIONS_PLACEHOLDER}
                            rows={10}
                            style={{
                              width: '100%',
                              resize: 'vertical',
                              fontStyle:
                                channelCreateDraft.instructions.length === 0
                                  ? 'italic'
                                  : 'normal',
                            }}
                            disabled={channelStatus.status === 'saving'}
                          />
                        </label>
                        <div
                          className={formatInstructionLintClassName(
                            createInstructionLint.status,
                          )}
                          role="status"
                          style={{ marginTop: '0.75rem' }}
                        >
                          <strong>
                            {formatInstructionLintTitle(
                              createInstructionLint.status,
                            )}
                          </strong>
                          <ul style={{ margin: '0.5rem 0 0 1rem' }}>
                            {createInstructionLint.messages.map((message) => (
                              <li key={message}>{message}</li>
                            ))}
                          </ul>
                        </div>
                        <div
                          className="settings-button-row"
                          style={{ marginTop: '0.75rem' }}
                        >
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() =>
                              void handleReviewBindingInstructions({
                                reviewKey:
                                  CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY,
                                platform:
                                  selectedChannelPlatform === 'telegram'
                                    ? 'telegram'
                                    : 'slack',
                                instructions: channelCreateDraft.instructions,
                                timezone: channelCreateDraft.timezone,
                                bindingLabel:
                                  channelCreateDraft.displayName.trim() ||
                                  selectedChannelTarget?.displayName ||
                                  null,
                              })
                            }
                            disabled={
                              channelStatus.status === 'saving' ||
                              channelInstructionReviews[
                                CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY
                              ]?.status === 'reviewing'
                            }
                          >
                            {channelInstructionReviews[
                              CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY
                            ]?.status === 'reviewing'
                              ? 'Reviewing…'
                              : 'Review Instructions'}
                          </button>
                        </div>
                        {channelInstructionReviews[
                          CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY
                        ]?.status === 'error' ? (
                          <div
                            className="inline-banner inline-banner-error"
                            role="alert"
                            style={{ marginTop: '0.75rem' }}
                          >
                            {
                              channelInstructionReviews[
                                CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY
                              ]?.message
                            }
                          </div>
                        ) : null}
                        {channelInstructionReviews[
                          CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY
                        ]?.status === 'ready' &&
                        channelInstructionReviews[
                          CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY
                        ]?.review ? (
                          <div
                            className="talk-llm-card"
                            style={{ marginTop: '0.75rem' }}
                          >
                            <strong>AI Review</strong>
                            {(
                              [
                                [
                                  'What is clear',
                                  channelInstructionReviews[
                                    CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY
                                  ]?.review?.strengths ?? [],
                                ],
                                [
                                  'What is missing',
                                  channelInstructionReviews[
                                    CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY
                                  ]?.review?.missing ?? [],
                                ],
                                [
                                  'What to remove or simplify',
                                  channelInstructionReviews[
                                    CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY
                                  ]?.review?.removeOrSimplify ?? [],
                                ],
                              ] as const
                            ).map(([heading, items]) =>
                              items.length > 0 ? (
                                <div
                                  key={heading}
                                  style={{ marginTop: '0.75rem' }}
                                >
                                  <strong>{heading}</strong>
                                  <ul style={{ margin: '0.35rem 0 0 1rem' }}>
                                    {items.map((item) => (
                                      <li key={item}>{item}</li>
                                    ))}
                                  </ul>
                                </div>
                              ) : null,
                            )}
                            {channelInstructionReviews[
                              CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY
                            ]?.review?.rewrittenInstructions ? (
                              <>
                                <label
                                  style={{
                                    display: 'block',
                                    marginTop: '0.75rem',
                                  }}
                                >
                                  <span className="settings-label">
                                    Suggested rewrite
                                  </span>
                                  <AutoGrowingTextarea
                                    readOnly
                                    value={
                                      channelInstructionReviews[
                                        CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY
                                      ]?.review?.rewrittenInstructions || ''
                                    }
                                    rows={10}
                                    style={{
                                      width: '100%',
                                      resize: 'vertical',
                                    }}
                                  />
                                </label>
                                <div
                                  className="settings-button-row"
                                  style={{ marginTop: '0.75rem' }}
                                >
                                  <button
                                    type="button"
                                    className="secondary-btn"
                                    onClick={() =>
                                      setChannelCreateDraft((current) => ({
                                        ...current,
                                        instructions:
                                          channelInstructionReviews[
                                            CREATE_CHANNEL_INSTRUCTION_REVIEW_KEY
                                          ]?.review?.rewrittenInstructions ||
                                          current.instructions,
                                      }))
                                    }
                                  >
                                    Apply Rewrite
                                  </button>
                                </div>
                              </>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      <div
                        className="settings-button-row"
                        style={{ marginTop: '0.75rem' }}
                      >
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => void handleCreateChannel()}
                          disabled={
                            channelStatus.status === 'saving' ||
                            !channelCreateDraft.targetKey ||
                            Boolean(selectedChannelTarget?.activeBindingTalkId)
                          }
                        >
                          {channelStatus.status === 'saving'
                            ? 'Saving…'
                            : 'Create Binding'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : canEditChannels ? (
                <div
                  className="inline-banner inline-banner-warning"
                  role="status"
                >
                  Only owners and admins can add new channel bindings. You can
                  still manage existing bindings below.
                </div>
              ) : null}

              {channelStatus.status === 'loading' ? (
                <p className="page-state">Loading channels…</p>
              ) : channelBindings.length === 0 ? (
                <p className="page-state">
                  No external channels are bound to this talk yet.
                </p>
              ) : (
                <div className="connector-card-list">
                  {channelBindings.map((binding) => {
                    const connection =
                      channelConnections.find(
                        (candidate) => candidate.id === binding.connectionId,
                      ) || null;
                    const workspaceSummary = buildBindingWorkspaceSummary(
                      binding,
                      connection,
                    );
                    const activitySummary =
                      buildBindingActivitySummary(binding);
                    const draft =
                      channelDrafts[binding.id] ||
                      buildChannelBindingDraft(binding);
                    const instructionLint = lintChannelInstructions({
                      instructions: draft.instructions,
                      stateNamespace: binding.stateNamespace,
                      timezone: draft.timezone,
                    });
                    const instructionReview = channelInstructionReviews[
                      binding.id
                    ] ?? {
                      status: 'idle',
                      review: null,
                    };
                    const templateOptions = getInstructionTemplateOptions(
                      binding.platform,
                    );
                    const bindingMemory =
                      channelBindingMemoryById[binding.id] ??
                      buildEmptyBindingMemoryPanelState(binding.stateNamespace);
                    const failures = channelFailuresByBindingId[binding.id] || {
                      ingress: [],
                      delivery: [],
                    };
                    return (
                      <article
                        key={binding.id}
                        className="talk-llm-card connector-card"
                      >
                        <div className="connector-card-header">
                          <div>
                            <h3>
                              [{formatChannelPlatform(binding.platform)}]{' '}
                              {binding.displayName}
                            </h3>
                            <p className="talk-llm-meta channel-diagnosis-headline">
                              <span
                                className={`channel-status-dot channel-status-${binding.diagnosis.status}`}
                                aria-label={binding.diagnosis.status}
                              />
                              {binding.diagnosis.headline}
                            </p>
                          </div>
                          <span
                            className={`talk-agent-chip ${
                              binding.diagnosis.status === 'ok'
                                ? 'talk-agent-chip-success'
                                : binding.diagnosis.status === 'warning'
                                  ? 'talk-agent-chip-warning'
                                  : binding.diagnosis.status === 'error' ||
                                      binding.diagnosis.status === 'quarantined'
                                    ? 'talk-agent-chip-error'
                                    : ''
                            }`}
                          >
                            {binding.diagnosis.status === 'paused'
                              ? 'Paused'
                              : binding.diagnosis.status === 'quarantined'
                                ? 'Quarantined'
                                : binding.active
                                  ? 'Active'
                                  : 'Inactive'}
                          </span>
                        </div>
                        {binding.diagnosis.detail ? (
                          <p
                            className="policy-muted"
                            style={{ margin: '0 0 8px' }}
                          >
                            {binding.diagnosis.detail}
                          </p>
                        ) : null}
                        {workspaceSummary ? (
                          <p
                            className="policy-muted"
                            style={{ margin: '0 0 8px' }}
                          >
                            {workspaceSummary}
                          </p>
                        ) : null}
                        {activitySummary.length > 0 ? (
                          <div
                            className="policy-muted"
                            style={{ margin: '0 0 8px' }}
                          >
                            {activitySummary.map((summary) => (
                              <p key={summary} style={{ margin: '0 0 4px' }}>
                                {summary}
                              </p>
                            ))}
                          </div>
                        ) : null}
                        {binding.diagnosis.action ? (
                          <div style={{ marginBottom: 8 }}>
                            <button
                              className="btn btn-sm"
                              disabled={
                                channelStatus.status === 'saving' ||
                                (channelTestStatus.bindingId === binding.id &&
                                  channelTestStatus.status === 'sending')
                              }
                              onClick={async () => {
                                if (binding.diagnosis.action?.type === 'test') {
                                  await handleTestChannel(binding, 'diagnosis');
                                  return;
                                }
                                try {
                                  if (
                                    binding.diagnosis.action?.type ===
                                    'unquarantine'
                                  ) {
                                    setChannelStatus({
                                      status: 'saving',
                                      message: 'Testing connection…',
                                    });
                                    await unquarantineTalkChannelBinding({
                                      talkId: binding.talkId,
                                      bindingId: binding.id,
                                    });
                                    setChannelStatus({
                                      status: 'success',
                                      message: 'Binding reconnected.',
                                    });
                                  } else if (
                                    binding.diagnosis.action?.type === 'retry'
                                  ) {
                                    setChannelStatus({
                                      status: 'saving',
                                      message: 'Retrying failures…',
                                    });
                                    await retryTalkChannelDeliveryFailuresCapped(
                                      {
                                        talkId: binding.talkId,
                                        bindingId: binding.id,
                                      },
                                    );
                                    setChannelStatus({
                                      status: 'success',
                                      message: 'Retried failed deliveries.',
                                    });
                                  }
                                  reloadTalkChannels();
                                } catch (err) {
                                  setChannelStatus({
                                    status: 'error',
                                    message:
                                      err instanceof Error
                                        ? err.message
                                        : 'Action failed.',
                                  });
                                }
                              }}
                            >
                              {binding.diagnosis.action.label}
                            </button>
                            {channelTestStatus.bindingId === binding.id &&
                            channelTestStatus.location === 'diagnosis' &&
                            channelTestStatus.status !== 'idle' ? (
                              <div
                                className={`inline-banner ${
                                  channelTestStatus.status === 'error'
                                    ? 'inline-banner-error'
                                    : channelTestStatus.status === 'success'
                                      ? 'inline-banner-success'
                                      : ''
                                }`}
                                role={
                                  channelTestStatus.status === 'error'
                                    ? 'alert'
                                    : 'status'
                                }
                                style={{ marginTop: 8 }}
                              >
                                {channelTestStatus.message}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        <div className="connector-meta-grid">
                          <div>
                            <strong>Connection</strong>
                            <p>{binding.connectionDisplayName}</p>
                          </div>
                          <div>
                            <strong>Pending</strong>
                            <p>{binding.pendingIngressCount}</p>
                          </div>
                          <div>
                            <strong>Waiting</strong>
                            <p>{binding.deferredIngressCount}</p>
                          </div>
                          <div>
                            <strong>Failed deliveries</strong>
                            <p>{binding.deadLetterCount}</p>
                          </div>
                          <div>
                            <strong>Unresolved inbound</strong>
                            <p>{binding.unresolvedIngressCount}</p>
                          </div>
                        </div>
                        <div className="talk-llm-card">
                          <div className="connector-card-header">
                            <div>
                              <h4>Binding Instructions</h4>
                              <p className="talk-llm-meta">
                                State namespace:{' '}
                                <code>{binding.stateNamespace}</code>
                              </p>
                            </div>
                          </div>
                          <div className="connector-attach-row">
                            <label>
                              <span className="settings-label">Template</span>
                              <select
                                value={draft.template}
                                onChange={(event) =>
                                  handleApplyChannelTemplate(
                                    binding,
                                    event.target
                                      .value as InstructionTemplateKey,
                                  )
                                }
                                disabled={
                                  !canEditChannels ||
                                  channelStatus.status === 'saving'
                                }
                              >
                                {templateOptions.map((option) => (
                                  <option
                                    key={option.value}
                                    value={option.value}
                                  >
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label style={{ flex: 1 }}>
                              <span className="settings-label">Timezone</span>
                              <input
                                type="text"
                                value={draft.timezone}
                                onChange={(event) =>
                                  handleChannelDraftChange(binding.id, {
                                    timezone: event.target.value,
                                  })
                                }
                                placeholder="America/Los_Angeles"
                                disabled={
                                  !canEditChannels ||
                                  channelStatus.status === 'saving'
                                }
                              />
                            </label>
                            <label style={{ flex: 1 }}>
                              <span className="settings-label">
                                State namespace
                              </span>
                              <input
                                type="text"
                                value={binding.stateNamespace}
                                disabled
                              />
                            </label>
                          </div>
                          <label
                            style={{ display: 'block', marginTop: '0.75rem' }}
                          >
                            <span className="settings-label">Instructions</span>
                            <AutoGrowingTextarea
                              value={draft.instructions}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  instructions: event.target.value,
                                })
                              }
                              rows={10}
                              style={{
                                width: '100%',
                                resize: 'vertical',
                                fontStyle:
                                  draft.instructions.length === 0
                                    ? 'italic'
                                    : 'normal',
                              }}
                              placeholder={BINDING_INSTRUCTIONS_PLACEHOLDER}
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            />
                          </label>
                          <div
                            className={formatInstructionLintClassName(
                              instructionLint.status,
                            )}
                            role="status"
                            style={{ marginTop: '0.75rem' }}
                          >
                            <strong>
                              {formatInstructionLintTitle(
                                instructionLint.status,
                              )}
                            </strong>
                            <ul style={{ margin: '0.5rem 0 0 1rem' }}>
                              {instructionLint.messages.map((message) => (
                                <li key={message}>{message}</li>
                              ))}
                            </ul>
                          </div>
                          <div
                            className="settings-button-row"
                            style={{ marginTop: '0.75rem' }}
                          >
                            <button
                              type="button"
                              className="secondary-btn"
                              onClick={() =>
                                void handleReviewBindingInstructions({
                                  reviewKey: binding.id,
                                  platform: binding.platform,
                                  instructions: draft.instructions,
                                  bindingId: binding.id,
                                  bindingLabel: binding.displayName,
                                  timezone: draft.timezone,
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving' ||
                                instructionReview.status === 'reviewing'
                              }
                            >
                              {instructionReview.status === 'reviewing'
                                ? 'Reviewing…'
                                : 'Review Instructions'}
                            </button>
                          </div>
                          {instructionReview.status === 'error' ? (
                            <div
                              className="inline-banner inline-banner-error"
                              role="alert"
                              style={{ marginTop: '0.75rem' }}
                            >
                              {instructionReview.message}
                            </div>
                          ) : null}
                          {instructionReview.status === 'ready' &&
                          instructionReview.review ? (
                            <div
                              className="talk-llm-card"
                              style={{ marginTop: '0.75rem' }}
                            >
                              <strong>AI Review</strong>
                              {(
                                [
                                  [
                                    'What is clear',
                                    instructionReview.review.strengths,
                                  ],
                                  [
                                    'What is missing',
                                    instructionReview.review.missing,
                                  ],
                                  [
                                    'What to remove or simplify',
                                    instructionReview.review.removeOrSimplify,
                                  ],
                                ] as const
                              ).map(([heading, items]) =>
                                items.length > 0 ? (
                                  <div
                                    key={heading}
                                    style={{ marginTop: '0.75rem' }}
                                  >
                                    <strong>{heading}</strong>
                                    <ul style={{ margin: '0.35rem 0 0 1rem' }}>
                                      {items.map((item) => (
                                        <li key={item}>{item}</li>
                                      ))}
                                    </ul>
                                  </div>
                                ) : null,
                              )}
                              {instructionReview.review
                                .rewrittenInstructions ? (
                                <>
                                  <label
                                    style={{
                                      display: 'block',
                                      marginTop: '0.75rem',
                                    }}
                                  >
                                    <span className="settings-label">
                                      Suggested rewrite
                                    </span>
                                    <AutoGrowingTextarea
                                      readOnly
                                      value={
                                        instructionReview.review
                                          .rewrittenInstructions
                                      }
                                      rows={10}
                                      style={{
                                        width: '100%',
                                        resize: 'vertical',
                                      }}
                                    />
                                  </label>
                                  <div
                                    className="settings-button-row"
                                    style={{ marginTop: '0.75rem' }}
                                  >
                                    <button
                                      type="button"
                                      className="secondary-btn"
                                      onClick={() =>
                                        handleChannelDraftChange(binding.id, {
                                          instructions:
                                            instructionReview.review
                                              ?.rewrittenInstructions || '',
                                        })
                                      }
                                      disabled={
                                        !canEditChannels ||
                                        channelStatus.status === 'saving'
                                      }
                                    >
                                      Apply Rewrite
                                    </button>
                                  </div>
                                </>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                        <div className="connector-attach-row">
                          <label style={{ flex: 1 }}>
                            <span className="settings-label">Display Name</span>
                            <input
                              type="text"
                              value={draft.displayName ?? ''}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  displayName: event.target.value,
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            />
                          </label>
                          <label>
                            <span className="settings-label">
                              When to respond
                            </span>
                            <select
                              value={draft.responseMode ?? 'mentions'}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  responseMode: event.target
                                    .value as TalkChannelBinding['responseMode'],
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            >
                              <option value="off">Off</option>
                              <option value="mentions">Mentions</option>
                              <option value="all">All messages</option>
                            </select>
                          </label>
                          <label>
                            <span className="settings-label">
                              Where to post reply
                            </span>
                            <select
                              value={draft.deliveryMode ?? 'reply'}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  deliveryMode: event.target
                                    .value as TalkChannelBinding['deliveryMode'],
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            >
                              <option value="reply">Reply</option>
                              <option value="channel">Channel</option>
                            </select>
                          </label>
                        </div>
                        <div className="connector-attach-row">
                          <label>
                            <span className="settings-label">Responder</span>
                            <select
                              value={draft.responderMode ?? 'primary'}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  responderMode: event.target
                                    .value as TalkChannelBinding['responderMode'],
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            >
                              <option value="primary">Primary agent</option>
                              <option value="agent">Specific agent</option>
                            </select>
                          </label>
                          {draft.responderMode === 'agent' ? (
                            <label style={{ flex: 1 }}>
                              <span className="settings-label">Agent</span>
                              <select
                                value={draft.responderAgentId ?? ''}
                                onChange={(event) =>
                                  handleChannelDraftChange(binding.id, {
                                    responderAgentId: event.target.value,
                                  })
                                }
                                disabled={
                                  !canEditChannels ||
                                  channelStatus.status === 'saving'
                                }
                              >
                                <option value="">Select an agent</option>
                                {effectiveAgents.map((agent) => (
                                  <option key={agent.id} value={agent.id}>
                                    {buildAgentLabel(agent)}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                          <label>
                            <span className="settings-label">Enabled</span>
                            <select
                              value={draft.active ? 'active' : 'inactive'}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  active: event.target.value === 'active',
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            >
                              <option value="active">Active</option>
                              <option value="inactive">Inactive</option>
                            </select>
                          </label>
                        </div>
                        <div className="connector-attach-row">
                          <label>
                            <span className="settings-label">Rate / min</span>
                            <input
                              type="number"
                              min={1}
                              value={draft.inboundRateLimitPerMinute ?? ''}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  inboundRateLimitPerMinute: event.target.value,
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            />
                          </label>
                          <label>
                            <span className="settings-label">Queue Limit</span>
                            <input
                              type="number"
                              min={1}
                              value={draft.maxPendingEvents ?? ''}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  maxPendingEvents: event.target.value,
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            />
                          </label>
                          <label>
                            <span className="settings-label">Overflow</span>
                            <select
                              value={draft.overflowPolicy ?? 'drop_oldest'}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  overflowPolicy: event.target
                                    .value as TalkChannelBinding['overflowPolicy'],
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            >
                              <option value="drop_oldest">Drop oldest</option>
                              <option value="drop_newest">Drop newest</option>
                            </select>
                          </label>
                          <label>
                            <span className="settings-label">
                              Busy timeout (min)
                            </span>
                            <input
                              type="number"
                              min={1}
                              value={draft.maxDeferredAgeMinutes ?? ''}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  maxDeferredAgeMinutes: event.target.value,
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            />
                          </label>
                        </div>
                        <div
                          className="talk-llm-card"
                          style={{ marginTop: '0.75rem' }}
                        >
                          <div className="connector-card-header">
                            <div>
                              <h4>Binding Memory</h4>
                              <p className="talk-llm-meta">
                                Inspect and correct state entries stored under{' '}
                                <code>{bindingMemory.stateNamespace}</code>.
                              </p>
                            </div>
                            <div className="settings-button-row">
                              <button
                                type="button"
                                className="secondary-btn"
                                onClick={() =>
                                  void handleLoadChannelBindingMemory(
                                    binding,
                                    true,
                                  )
                                }
                                disabled={
                                  channelStatus.status === 'saving' ||
                                  bindingMemory.status === 'loading' ||
                                  bindingMemory.status === 'saving'
                                }
                              >
                                {bindingMemory.status === 'loading'
                                  ? 'Loading…'
                                  : 'Refresh Memory'}
                              </button>
                            </div>
                          </div>
                          {bindingMemory.status === 'idle' ? (
                            <p className="talk-llm-meta">
                              Memory is loaded on demand for this binding.
                            </p>
                          ) : null}
                          {bindingMemory.errorMessage ? (
                            <div
                              className="inline-banner inline-banner-error"
                              role="alert"
                              style={{ marginBottom: '0.75rem' }}
                            >
                              {bindingMemory.errorMessage}
                            </div>
                          ) : null}
                          {bindingMemory.status !== 'idle' ? (
                            <>
                              {bindingMemory.entries.length > 0 ? (
                                <div
                                  style={{
                                    display: 'grid',
                                    gap: '0.75rem',
                                  }}
                                >
                                  {bindingMemory.entries.map((entry) => (
                                    <div
                                      key={entry.id}
                                      className="talk-llm-card"
                                    >
                                      <div className="connector-card-header">
                                        <div>
                                          <strong>{entry.keySuffix}</strong>
                                          <p className="talk-llm-meta">
                                            Version {entry.version} · Updated{' '}
                                            {formatDateTime(entry.updatedAt)}
                                          </p>
                                        </div>
                                      </div>
                                      <textarea
                                        readOnly
                                        value={formatJsonForStateEditor(
                                          entry.value,
                                        )}
                                        rows={6}
                                        style={{
                                          width: '100%',
                                          resize: 'vertical',
                                          fontFamily:
                                            'SFMono-Regular, Consolas, monospace',
                                        }}
                                      />
                                      <div
                                        className="settings-button-row"
                                        style={{ marginTop: '0.75rem' }}
                                      >
                                        <button
                                          type="button"
                                          className="secondary-btn"
                                          onClick={() =>
                                            void handleEditChannelBindingMemoryEntry(
                                              binding,
                                              entry,
                                            )
                                          }
                                          disabled={
                                            !canEditChannels ||
                                            channelStatus.status === 'saving' ||
                                            bindingMemory.status === 'saving'
                                          }
                                        >
                                          Edit
                                        </button>
                                        <button
                                          type="button"
                                          className="secondary-btn"
                                          onClick={() =>
                                            void handleDeleteChannelBindingMemoryEntry(
                                              binding,
                                              entry,
                                            )
                                          }
                                          disabled={
                                            !canEditChannels ||
                                            channelStatus.status === 'saving' ||
                                            bindingMemory.status === 'saving'
                                          }
                                        >
                                          Delete
                                        </button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="talk-llm-meta">
                                  No binding memory entries exist yet.
                                </p>
                              )}
                              {canEditChannels ? (
                                <div
                                  className="talk-llm-card"
                                  style={{ marginTop: '0.75rem' }}
                                >
                                  <strong>Add Memory Entry</strong>
                                  <label
                                    style={{
                                      display: 'block',
                                      marginTop: '0.75rem',
                                    }}
                                  >
                                    <span className="settings-label">
                                      Key suffix
                                    </span>
                                    <input
                                      type="text"
                                      value={bindingMemory.newKeySuffix}
                                      onChange={(event) =>
                                        handleChannelBindingMemoryDraftChange(
                                          binding.id,
                                          {
                                            newKeySuffix: event.target.value,
                                          },
                                        )
                                      }
                                      placeholder="tracker.asher"
                                      disabled={
                                        channelStatus.status === 'saving' ||
                                        bindingMemory.status === 'saving'
                                      }
                                      style={{ width: '100%' }}
                                    />
                                  </label>
                                  <label
                                    style={{
                                      display: 'block',
                                      marginTop: '0.75rem',
                                    }}
                                  >
                                    <span className="settings-label">
                                      JSON value
                                    </span>
                                    <textarea
                                      value={bindingMemory.newValueJson}
                                      onChange={(event) =>
                                        handleChannelBindingMemoryDraftChange(
                                          binding.id,
                                          {
                                            newValueJson: event.target.value,
                                          },
                                        )
                                      }
                                      rows={8}
                                      style={{
                                        width: '100%',
                                        resize: 'vertical',
                                        fontFamily:
                                          'SFMono-Regular, Consolas, monospace',
                                      }}
                                      disabled={
                                        channelStatus.status === 'saving' ||
                                        bindingMemory.status === 'saving'
                                      }
                                    />
                                  </label>
                                  <div
                                    className="settings-button-row"
                                    style={{ marginTop: '0.75rem' }}
                                  >
                                    <button
                                      type="button"
                                      className="secondary-btn"
                                      onClick={() =>
                                        void handleCreateChannelBindingMemoryEntry(
                                          binding,
                                        )
                                      }
                                      disabled={
                                        !canEditChannels ||
                                        channelStatus.status === 'saving' ||
                                        bindingMemory.status === 'saving'
                                      }
                                    >
                                      {bindingMemory.status === 'saving'
                                        ? 'Saving…'
                                        : 'Add Memory Entry'}
                                    </button>
                                  </div>
                                </div>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                        <div
                          className="settings-button-row"
                          style={{ marginTop: '0.75rem' }}
                        >
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() =>
                              void handleSaveChannelBinding(binding)
                            }
                            disabled={
                              !canEditChannels ||
                              channelStatus.status === 'saving'
                            }
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() =>
                              void handleTestChannel(binding, 'footer')
                            }
                            disabled={
                              channelStatus.status === 'saving' ||
                              (channelTestStatus.bindingId === binding.id &&
                                channelTestStatus.status === 'sending')
                            }
                          >
                            {channelTestStatus.bindingId === binding.id &&
                            channelTestStatus.location === 'footer' &&
                            channelTestStatus.status === 'sending'
                              ? 'Sending…'
                              : 'Test Send'}
                          </button>
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() =>
                              void handleDeleteChannelBinding(binding)
                            }
                            disabled={
                              !canEditChannels ||
                              channelStatus.status === 'saving'
                            }
                          >
                            Delete
                          </button>
                        </div>
                        {channelTestStatus.bindingId === binding.id &&
                        channelTestStatus.location === 'footer' &&
                        channelTestStatus.status !== 'idle' ? (
                          <div
                            className={`inline-banner ${
                              channelTestStatus.status === 'error'
                                ? 'inline-banner-error'
                                : channelTestStatus.status === 'success'
                                  ? 'inline-banner-success'
                                  : ''
                            }`}
                            role={
                              channelTestStatus.status === 'error'
                                ? 'alert'
                                : 'status'
                            }
                            style={{ marginTop: '0.75rem' }}
                          >
                            {channelTestStatus.message}
                          </div>
                        ) : null}

                        {failures.ingress.length > 0 ? (
                          <div style={{ marginTop: '1rem' }}>
                            <h4>Ingress Failures</h4>
                            <ul
                              style={{
                                listStyle: 'none',
                                padding: 0,
                                margin: '0.5rem 0 0 0',
                              }}
                            >
                              {failures.ingress.map((failure) => (
                                <li
                                  key={failure.id}
                                  style={{
                                    padding: '0.5rem 0',
                                    borderTop:
                                      '1px solid var(--border, #e6e9ef)',
                                  }}
                                >
                                  <p style={{ margin: 0, fontWeight: 600 }}>
                                    {formatChannelReasonCode(
                                      failure.reasonCode,
                                    )}
                                  </p>
                                  <p
                                    style={{
                                      margin: '0.25rem 0',
                                      opacity: 0.75,
                                    }}
                                  >
                                    {failure.senderName ||
                                      failure.senderId ||
                                      'Unknown sender'}{' '}
                                    · {formatDateTime(failure.createdAt)}
                                  </p>
                                  {failure.reasonDetail ? (
                                    <p style={{ margin: '0.25rem 0' }}>
                                      {failure.reasonDetail}
                                    </p>
                                  ) : null}
                                  <div className="settings-button-row">
                                    <button
                                      type="button"
                                      className="secondary-btn"
                                      onClick={() =>
                                        void handleRetryIngressFailure(
                                          binding.id,
                                          failure.id,
                                        )
                                      }
                                      disabled={
                                        channelStatus.status === 'saving'
                                      }
                                    >
                                      Retry
                                    </button>
                                    <button
                                      type="button"
                                      className="secondary-btn"
                                      onClick={() =>
                                        void handleDismissIngressFailure(
                                          binding.id,
                                          failure.id,
                                        )
                                      }
                                      disabled={
                                        channelStatus.status === 'saving'
                                      }
                                    >
                                      Dismiss
                                    </button>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {failures.delivery.length > 0 ? (
                          <div style={{ marginTop: '1rem' }}>
                            <h4>Delivery Failures</h4>
                            <ul
                              style={{
                                listStyle: 'none',
                                padding: 0,
                                margin: '0.5rem 0 0 0',
                              }}
                            >
                              {failures.delivery.map((failure) => (
                                <li
                                  key={failure.id}
                                  style={{
                                    padding: '0.5rem 0',
                                    borderTop:
                                      '1px solid var(--border, #e6e9ef)',
                                  }}
                                >
                                  <p style={{ margin: 0, fontWeight: 600 }}>
                                    {formatChannelReasonCode(
                                      failure.reasonCode,
                                    )}
                                  </p>
                                  <p
                                    style={{
                                      margin: '0.25rem 0',
                                      opacity: 0.75,
                                    }}
                                  >
                                    {formatDateTime(failure.createdAt)}
                                  </p>
                                  {failure.reasonDetail ? (
                                    <p style={{ margin: '0.25rem 0' }}>
                                      {failure.reasonDetail}
                                    </p>
                                  ) : null}
                                  <div className="settings-button-row">
                                    <button
                                      type="button"
                                      className="secondary-btn"
                                      onClick={() =>
                                        void handleRetryDeliveryFailure(
                                          binding.id,
                                          failure.id,
                                        )
                                      }
                                      disabled={
                                        channelStatus.status === 'saving'
                                      }
                                    >
                                      Retry
                                    </button>
                                    <button
                                      type="button"
                                      className="secondary-btn"
                                      onClick={() =>
                                        void handleDismissDeliveryFailure(
                                          binding.id,
                                          failure.id,
                                        )
                                      }
                                      disabled={
                                        channelStatus.status === 'saving'
                                      }
                                    >
                                      Dismiss
                                    </button>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}

          {currentTab === 'data-connectors' ? (
            <section
              className="talk-tab-panel"
              aria-label="Talk data connectors"
            >
              <div className="agents-panel-header">
                <h2>Data Connectors</h2>
                {canManageTalkConnectors ? (
                  <Link className="secondary-btn" to={manageConnectorsHref}>
                    Manage Data Connectors
                  </Link>
                ) : null}
              </div>
              <p className="policy-muted">
                Attach org-level data sources to this talk. Attached connectors
                are available as query and document tools during talk execution.
                Channel Bindings are configured separately for external message
                delivery.
              </p>

              {canManageTalkConnectors ? (
                <div className="talk-llm-card connector-attach-card">
                  <div className="connector-card-header">
                    <div>
                      <h3>Attach Connector</h3>
                      <p className="talk-llm-meta">
                        Only verified org-level connectors can be attached.
                      </p>
                    </div>
                  </div>
                  {availableConnectors.length === 0 ? (
                    <p className="page-state">
                      No verified connectors are available to attach. Connectors
                      must be enabled and have verified credentials.
                    </p>
                  ) : (
                    <div className="connector-attach-row">
                      <label>
                        <span className="settings-label">Connector</span>
                        <select
                          value={attachConnectorId}
                          onChange={(event) =>
                            setAttachConnectorId(event.target.value)
                          }
                          disabled={connectorState.status === 'saving'}
                        >
                          {availableConnectors.map((connector) => (
                            <option key={connector.id} value={connector.id}>
                              {connector.name} (
                              {formatConnectorKind(connector.connectorKind)})
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => void handleAttachConnector()}
                        disabled={
                          connectorState.status === 'saving' ||
                          !attachConnectorId
                        }
                      >
                        {connectorState.status === 'saving'
                          ? 'Saving…'
                          : 'Attach Connector'}
                      </button>
                    </div>
                  )}
                </div>
              ) : null}

              {connectorState.status === 'error' ? (
                <div className="inline-banner inline-banner-error" role="alert">
                  {connectorState.message}
                </div>
              ) : null}
              {connectorState.status === 'success' ? (
                <div
                  className="inline-banner inline-banner-success"
                  role="status"
                >
                  {connectorState.message}
                </div>
              ) : null}

              {talkConnectors.length === 0 ? (
                <p className="page-state">
                  No data connectors attached to this talk.
                </p>
              ) : (
                <div className="connector-card-list">
                  {talkConnectors.map((connector) => (
                    <article
                      key={connector.id}
                      className="talk-llm-card connector-card"
                    >
                      <div className="connector-card-header">
                        <div>
                          <h3>{connector.name}</h3>
                          <p className="talk-llm-meta">
                            {formatConnectorKind(connector.connectorKind)}
                          </p>
                        </div>
                        <span
                          className={connectorStatusClass(
                            connector.verificationStatus,
                          )}
                        >
                          {formatConnectorStatus(connector.verificationStatus)}
                        </span>
                      </div>
                      <div className="connector-meta-grid">
                        <div>
                          <strong>Credential</strong>
                          <p>
                            {connector.hasCredential ? 'Stored' : 'Missing'}
                          </p>
                        </div>
                        <div>
                          <strong>Attached</strong>
                          <p>{formatDateTime(connector.attachedAt)}</p>
                        </div>
                        <div>
                          <strong>Last verified</strong>
                          <p>{formatDateTime(connector.lastVerifiedAt)}</p>
                        </div>
                      </div>
                      {connector.lastVerificationError ? (
                        <div
                          className="inline-banner inline-banner-warning"
                          role="status"
                        >
                          {connector.lastVerificationError}
                        </div>
                      ) : null}
                      {canManageTalkConnectors ? (
                        <div className="settings-button-row">
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() =>
                              void handleDetachConnector(connector)
                            }
                            disabled={connectorState.status === 'saving'}
                          >
                            Detach
                          </button>
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
            </section>
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
                            onMouseDown={handleThreadSecondaryClick(thread.id)}
                            onContextMenu={handleThreadContextMenu(thread.id)}
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
                                thread.isPinned ? <ThreadPinIcon /> : undefined
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
                            onMouseDown={handleThreadSecondaryClick(thread.id)}
                            onContextMenu={handleThreadContextMenu(thread.id)}
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
                                thread.isPinned ? <ThreadPinIcon /> : undefined
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
                        Use <code>/edit</code> or the button here to remove old
                        messages from this thread.
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
                            aria-current={step.isCurrent ? 'step' : undefined}
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
                      retryRunState?.runId === latestOrderedRound.retryRunId &&
                      retryRunState.status === 'error' ? (
                        <p className="run-history-error">
                          {retryRunState.message}
                        </p>
                      ) : null}
                    </section>
                  ) : null}

                  <div className="timeline talk-thread-timeline">
                    {state.messagesLoading ? (
                      <p className="page-state">Loading thread…</p>
                    ) : !activeThread ? (
                      <p className="page-state">No thread selected.</p>
                    ) : talkTimeline.length === 0 ? (
                      <div className="talk-onboarding-banner">
                        <p>
                          This Talk is using the default agent with all tools
                          enabled.{' '}
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
                              ? orderedGroupSizesById[
                                  orderedRun.responseGroupId
                                ] ?? null
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
                                  {new Date(message.createdAt).toLocaleString()}
                                </time>
                              </header>
                              <p>
                                {message.role === 'assistant'
                                  ? stripInternalAssistantText(message.content)
                                  : message.content}
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
                                    run.browserBlock.updatedAt || run.createdAt,
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
                          <article
                            key={entry.key}
                            className={`message message-assistant message-live${
                              response.terminalStatus === 'failed'
                                ? ' message-error'
                                : ''
                            }`}
                          >
                            <header>
                              <strong>{label}</strong>
                              <time>
                                {response.terminalStatus === 'failed'
                                  ? 'Failed'
                                  : 'Streaming…'}
                              </time>
                            </header>
                            <p>
                              {response.text ||
                                response.progressMessage ||
                                'Thinking…'}
                            </p>
                            {response.errorMessage ? (
                              <p className="run-history-error">
                                {response.errorMessage}
                              </p>
                            ) : null}
                            {response.terminalStatus === 'failed' ? (
                              <ExecutionDecisionSummary
                                executionDecision={
                                  state.runsById[response.runId]
                                    ?.executionDecision
                                }
                              />
                            ) : null}
                            {response.terminalStatus === 'failed' ? (
                              <div className="run-history-links">
                                {canRetryAgent ? (
                                  <button
                                    type="button"
                                    className="run-history-link"
                                    onClick={() =>
                                      void handleRetryAgentRun(response.runId)
                                    }
                                    disabled={retryPosting}
                                  >
                                    {retryPosting
                                      ? 'Retrying…'
                                      : 'Retry agent'}
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className="run-history-link"
                                  onClick={() =>
                                    handleOpenRunHistory(response.runId)
                                  }
                                >
                                  Open Run History
                                </button>
                              </div>
                            ) : null}
                            {retryError ? (
                              <p className="run-history-error">{retryError}</p>
                            ) : null}
                          </article>
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
                            <span className="talk-status-primary">Primary</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                  <div className="composer-meta-row">
                    <p className="composer-target-help">{composerTargetHelp}</p>
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

                  <div className="composer-input-shell">
                    <textarea
                      ref={textareaRef}
                      value={draft}
                      onChange={(event) =>
                        handleDraftChange(event.target.value)
                      }
                      onKeyDown={handleComposerKeyDown}
                      placeholder="Send a message to this thread"
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
                        {canEditAgents ? (
                          <button
                            type="button"
                            className="composer-icon-btn composer-cancel-btn"
                            onClick={handleCancelRuns}
                            disabled={
                              state.cancelState.status === 'posting' ||
                              !activeRound
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
                      Wait for the current round to finish or cancel it before
                      sending another message.
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
          ) : null}
        </div>
      </div>
      <TalkHistoryEditor
        isOpen={historyEditorOpen}
        messages={state.messages}
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
    </section>
  );
}
