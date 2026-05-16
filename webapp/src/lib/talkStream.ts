import type { BrowserBlock, BrowserResume } from './api';
import {
  WebSocketEventSource,
  type WebSocketEventSourceFrame,
  type WebSocketEventSourceLike,
  type WebSocketEventSourceOptions,
} from './websocketEventSource';

export type TalkStreamState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline';

export type MessageAppendedEvent = {
  talkId: string;
  threadId?: string | null;
  messageId: string;
  runId: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  createdBy: string | null;
  content?: string;
  createdAt?: string;
  agentId?: string | null;
  agentNickname?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type TalkRunStartedEvent = {
  talkId: string;
  threadId?: string | null;
  runId: string;
  runKind?: 'conversation' | 'instruction_review';
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
  triggerMessageId: string | null;
  status: 'running' | 'queued';
  executorAlias?: string | null;
  executorModel?: string | null;
};

export type TalkRunCompletedEvent = {
  talkId: string;
  threadId?: string | null;
  runId: string;
  runKind?: 'conversation' | 'instruction_review';
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
  triggerMessageId: string | null;
  responseMessageId: string | null;
  executorAlias?: string | null;
  executorModel?: string | null;
};

export type TalkResponseStartedEvent = {
  talkId: string;
  threadId?: string | null;
  runId: string;
  agentId?: string | null;
  agentNickname?: string | null;
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
  routeStepPosition?: number | null;
  providerId?: string | null;
  modelId?: string | null;
};

export type TalkResponseDeltaEvent = {
  talkId: string;
  threadId?: string | null;
  runId: string;
  agentId?: string | null;
  agentNickname?: string | null;
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
  deltaText: string;
  routeStepPosition?: number | null;
  providerId?: string | null;
  modelId?: string | null;
};

export type TalkProgressUpdateEvent = {
  talkId: string;
  threadId?: string | null;
  runId: string;
  agentId?: string | null;
  agentNickname?: string | null;
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
  routeStepPosition?: number | null;
  providerId?: string | null;
  modelId?: string | null;
  message: string;
};

export type TalkResponseUsageEvent = {
  talkId: string;
  threadId?: string | null;
  runId: string;
  agentId?: string | null;
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
  };
  routeStepPosition?: number | null;
  providerId?: string | null;
  modelId?: string | null;
};

export type TalkResponseTerminalEvent = {
  talkId: string;
  threadId?: string | null;
  runId: string;
  agentId?: string | null;
  agentNickname?: string | null;
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
  routeStepPosition?: number | null;
  providerId?: string | null;
  modelId?: string | null;
  errorCode?: string;
  errorMessage?: string;
};

export type TalkRunFailedEvent = {
  talkId: string;
  threadId?: string | null;
  runId: string;
  runKind?: 'conversation' | 'instruction_review';
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
  triggerMessageId: string | null;
  errorCode: string;
  errorMessage: string;
  executorAlias?: string | null;
  executorModel?: string | null;
};

export type TalkRunCancelledEvent = {
  talkId: string;
  threadIds?: string[];
  cancelledBy: string;
  runIds: string[];
};

export type TalkHistoryEditedEvent = {
  talkId: string;
  threadIds?: string[];
  deletedCount: number;
  deletedMessageIds: string[];
  editedAt: string;
};

export type TalkBrowserBlockedEvent = {
  talkId: string;
  threadId?: string | null;
  runId: string;
  browserBlock: BrowserBlock;
};

export type TalkBrowserUnblockedEvent = {
  talkId: string;
  threadId?: string | null;
  runId: string;
  browserResume?: BrowserResume | null;
};

interface TalkStreamCallbacks {
  onMessageAppended: (event: MessageAppendedEvent) => void;
  onRunStarted: (event: TalkRunStartedEvent) => void;
  onRunQueued: (event: TalkRunStartedEvent) => void;
  onResponseStarted?: (event: TalkResponseStartedEvent) => void;
  onProgressUpdate?: (event: TalkProgressUpdateEvent) => void;
  onResponseDelta?: (event: TalkResponseDeltaEvent) => void;
  onResponseUsage?: (event: TalkResponseUsageEvent) => void;
  onResponseCompleted?: (event: TalkResponseTerminalEvent) => void;
  onResponseFailed?: (event: TalkResponseTerminalEvent) => void;
  onResponseCancelled?: (event: TalkResponseTerminalEvent) => void;
  onRunCompleted: (event: TalkRunCompletedEvent) => void;
  onRunFailed: (event: TalkRunFailedEvent) => void;
  onRunCancelled: (event: TalkRunCancelledEvent) => void;
  onHistoryEdited?: (event: TalkHistoryEditedEvent) => void;
  onBrowserBlocked?: (event: TalkBrowserBlockedEvent) => void;
  onBrowserUnblocked?: (event: TalkBrowserUnblockedEvent) => void;
  onReplayGap: () => void | Promise<void>;
  onStateChange?: (state: TalkStreamState) => void;
  onUnauthorized: () => void;
}

export type TalkStreamTransportFactory = (
  url: string,
  options: WebSocketEventSourceOptions,
) => WebSocketEventSourceLike;

interface OpenTalkStreamInput extends TalkStreamCallbacks {
  talkId: string;
  createTransport?: TalkStreamTransportFactory;
  probeSession?: () => Promise<boolean>;
  jitterMs?: (baseMs: number) => number;
}

export interface TalkStreamHandle {
  close: () => void;
}

const BACKOFF_STEPS_MS = [500, 1000, 2000, 4000, 8000] as const;

export function openTalkStream(input: OpenTalkStreamInput): TalkStreamHandle {
  let source: WebSocketEventSourceLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let stopped = false;
  let handlingReplayGap = false;
  let lastEventId = 0;

  const createTransport =
    input.createTransport ??
    ((url: string, options: WebSocketEventSourceOptions) =>
      new WebSocketEventSource(url, options));
  const probeSession = input.probeSession || defaultSessionProbe;
  const jitterMs = input.jitterMs || defaultJitterMs;

  const emitState = (state: TalkStreamState) => {
    input.onStateChange?.(state);
  };

  const clearReconnectTimer = () => {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const closeSource = () => {
    if (!source) return;
    source.close();
    source = null;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearReconnectTimer();
    closeSource();
    emitState('offline');
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    clearReconnectTimer();
    emitState('reconnecting');

    const baseDelay =
      BACKOFF_STEPS_MS[Math.min(reconnectAttempt, BACKOFF_STEPS_MS.length - 1)];
    reconnectAttempt += 1;
    const delay = baseDelay + Math.max(0, jitterMs(baseDelay));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openConnection('reconnecting');
    }, delay);
  };

  const handleUnauthorized = () => {
    stop();
    input.onUnauthorized();
  };

  const handleTransportError = () => {
    if (stopped || handlingReplayGap) return;
    closeSource();

    void probeSession()
      .then((authorized) => {
        if (stopped) return;
        if (!authorized) {
          handleUnauthorized();
          return;
        }
        scheduleReconnect();
      })
      .catch(() => {
        if (!stopped) {
          scheduleReconnect();
        }
      });
  };

  const handleReplayGap = () => {
    if (stopped || handlingReplayGap) return;
    handlingReplayGap = true;
    clearReconnectTimer();
    closeSource();
    emitState('reconnecting');

    void Promise.resolve(input.onReplayGap())
      .then(() => {
        if (stopped) return;
        reconnectAttempt = 0;
        handlingReplayGap = false;
        lastEventId = 0;
        openConnection('connecting');
      })
      .catch(() => {
        handlingReplayGap = false;
        if (!stopped) {
          scheduleReconnect();
        }
      });
  };

  const parseFrame = <T>(frame: WebSocketEventSourceFrame): T | null => {
    try {
      return JSON.parse(frame.data) as T;
    } catch {
      return null;
    }
  };

  const dispatch = (frame: WebSocketEventSourceFrame): void => {
    switch (frame.event) {
      case 'message_appended': {
        const payload = parseFrame<MessageAppendedEvent>(frame);
        if (payload) input.onMessageAppended(payload);
        return;
      }
      case 'talk_run_started': {
        const payload = parseFrame<TalkRunStartedEvent>(frame);
        if (payload) input.onRunStarted(payload);
        return;
      }
      case 'talk_run_queued': {
        const payload = parseFrame<TalkRunStartedEvent>(frame);
        if (payload) input.onRunQueued(payload);
        return;
      }
      case 'talk_run_completed': {
        const payload = parseFrame<TalkRunCompletedEvent>(frame);
        if (payload) input.onRunCompleted(payload);
        return;
      }
      case 'talk_response_started': {
        const payload = parseFrame<TalkResponseStartedEvent>(frame);
        if (payload) input.onResponseStarted?.(payload);
        return;
      }
      case 'talk_response_delta': {
        const payload = parseFrame<TalkResponseDeltaEvent>(frame);
        if (payload) input.onResponseDelta?.(payload);
        return;
      }
      case 'talk_progress_update': {
        const payload = parseFrame<TalkProgressUpdateEvent>(frame);
        if (payload) input.onProgressUpdate?.(payload);
        return;
      }
      case 'talk_response_usage': {
        const payload = parseFrame<TalkResponseUsageEvent>(frame);
        if (payload) input.onResponseUsage?.(payload);
        return;
      }
      case 'talk_response_completed': {
        const payload = parseFrame<TalkResponseTerminalEvent>(frame);
        if (payload) input.onResponseCompleted?.(payload);
        return;
      }
      case 'talk_response_failed': {
        const payload = parseFrame<TalkResponseTerminalEvent>(frame);
        if (payload) input.onResponseFailed?.(payload);
        return;
      }
      case 'talk_response_cancelled': {
        const payload = parseFrame<TalkResponseTerminalEvent>(frame);
        if (payload) input.onResponseCancelled?.(payload);
        return;
      }
      case 'talk_run_failed': {
        const payload = parseFrame<TalkRunFailedEvent>(frame);
        if (payload) input.onRunFailed(payload);
        return;
      }
      case 'talk_run_cancelled': {
        const payload = parseFrame<TalkRunCancelledEvent>(frame);
        if (payload) input.onRunCancelled(payload);
        return;
      }
      case 'talk_history_edited': {
        const payload = parseFrame<TalkHistoryEditedEvent>(frame);
        if (payload) input.onHistoryEdited?.(payload);
        return;
      }
      case 'browser_blocked': {
        const payload = parseFrame<TalkBrowserBlockedEvent>(frame);
        if (payload) input.onBrowserBlocked?.(payload);
        return;
      }
      case 'browser_unblocked': {
        const payload = parseFrame<TalkBrowserUnblockedEvent>(frame);
        if (payload) input.onBrowserUnblocked?.(payload);
        return;
      }
      case 'replay_gap': {
        handleReplayGap();
        return;
      }
      default:
        return;
    }
  };

  const openConnection = (state: 'connecting' | 'reconnecting') => {
    if (stopped) return;
    clearReconnectTimer();
    closeSource();
    emitState(state);

    const url = `/api/v1/talks/${encodeURIComponent(input.talkId)}/events?stream=1`;
    let next: WebSocketEventSourceLike | null = null;
    next = createTransport(url, {
      getLastEventId: () => lastEventId,
      onOpen: () => {
        if (next !== source) return;
        reconnectAttempt = 0;
        emitState('live');
      },
      onError: () => {
        if (next !== source) return;
        handleTransportError();
      },
      onMessage: (frame) => {
        if (next !== source || stopped) return;
        if (frame.id > lastEventId) lastEventId = frame.id;
        dispatch(frame);
      },
    });
    source = next;
  };

  openConnection('connecting');

  return {
    close: stop,
  };
}

function defaultJitterMs(baseMs: number): number {
  const jitterCap = Math.max(0, Math.floor(baseMs * 0.2));
  if (jitterCap === 0) return 0;
  return Math.floor(Math.random() * (jitterCap + 1));
}

async function defaultSessionProbe(): Promise<boolean> {
  try {
    const response = await fetch('/api/v1/session/me', {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: 'application/json',
      },
    });
    return response.status !== 401;
  } catch {
    return true;
  }
}
