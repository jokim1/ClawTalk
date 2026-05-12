import type { BrowserBlock, BrowserResume } from './api';

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

interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener: (
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ) => void;
  close: () => void;
}

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

interface OpenTalkStreamInput extends TalkStreamCallbacks {
  talkId: string;
  createEventSource?: (url: string) => EventSourceLike;
  probeSession?: () => Promise<boolean>;
  jitterMs?: (baseMs: number) => number;
}

export interface TalkStreamHandle {
  close: () => void;
}

const BACKOFF_STEPS_MS = [500, 1000, 2000, 4000, 8000] as const;

export function openTalkStream(input: OpenTalkStreamInput): TalkStreamHandle {
  let source: EventSourceLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let stopped = false;
  let handlingReplayGap = false;

  const createEventSource =
    input.createEventSource ||
    ((url: string) => new EventSource(url) as unknown as EventSourceLike);
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

  const parse = <T>(event: MessageEvent<string>): T | null => {
    try {
      return JSON.parse(event.data) as T;
    } catch {
      return null;
    }
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
        openConnection('connecting');
      })
      .catch(() => {
        handlingReplayGap = false;
        if (!stopped) {
          scheduleReconnect();
        }
      });
  };

  const openConnection = (state: 'connecting' | 'reconnecting') => {
    if (stopped) return;
    clearReconnectTimer();
    closeSource();
    emitState(state);

    const url = `/api/v1/talks/${encodeURIComponent(input.talkId)}/events?stream=1`;
    const next = createEventSource(url);
    source = next;

    next.onopen = () => {
      reconnectAttempt = 0;
      emitState('live');
    };

    next.onerror = () => {
      if (next !== source) return;
      handleTransportError();
    };

    next.addEventListener('message_appended', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MessageAppendedEvent>(event);
      if (!payload) return;
      input.onMessageAppended(payload);
    });

    next.addEventListener('talk_run_started', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkRunStartedEvent>(event);
      if (!payload) return;
      input.onRunStarted(payload);
    });

    next.addEventListener('talk_run_queued', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkRunStartedEvent>(event);
      if (!payload) return;
      input.onRunQueued(payload);
    });

    next.addEventListener('talk_run_completed', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkRunCompletedEvent>(event);
      if (!payload) return;
      input.onRunCompleted(payload);
    });

    next.addEventListener('talk_response_started', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkResponseStartedEvent>(event);
      if (!payload) return;
      input.onResponseStarted?.(payload);
    });

    next.addEventListener('talk_response_delta', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkResponseDeltaEvent>(event);
      if (!payload) return;
      input.onResponseDelta?.(payload);
    });

    next.addEventListener('talk_progress_update', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkProgressUpdateEvent>(event);
      if (!payload) return;
      input.onProgressUpdate?.(payload);
    });

    next.addEventListener('talk_response_usage', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkResponseUsageEvent>(event);
      if (!payload) return;
      input.onResponseUsage?.(payload);
    });

    next.addEventListener('talk_response_completed', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkResponseTerminalEvent>(event);
      if (!payload) return;
      input.onResponseCompleted?.(payload);
    });

    next.addEventListener('talk_response_failed', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkResponseTerminalEvent>(event);
      if (!payload) return;
      input.onResponseFailed?.(payload);
    });

    next.addEventListener('talk_response_cancelled', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkResponseTerminalEvent>(event);
      if (!payload) return;
      input.onResponseCancelled?.(payload);
    });

    next.addEventListener('talk_run_failed', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkRunFailedEvent>(event);
      if (!payload) return;
      input.onRunFailed(payload);
    });

    next.addEventListener('talk_run_cancelled', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkRunCancelledEvent>(event);
      if (!payload) return;
      input.onRunCancelled(payload);
    });

    next.addEventListener('talk_history_edited', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkHistoryEditedEvent>(event);
      if (!payload) return;
      input.onHistoryEdited?.(payload);
    });

    next.addEventListener('browser_blocked', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkBrowserBlockedEvent>(event);
      if (!payload) return;
      input.onBrowserBlocked?.(payload);
    });

    next.addEventListener('browser_unblocked', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkBrowserUnblockedEvent>(event);
      if (!payload) return;
      input.onBrowserUnblocked?.(payload);
    });

    next.addEventListener('replay_gap', () => {
      if (next !== source || stopped) return;
      handleReplayGap();
    });
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
    // Treat transport errors as transient and let reconnect backoff handle it.
    return true;
  }
}
