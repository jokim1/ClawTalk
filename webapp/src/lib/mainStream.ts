/**
 * mainStream.ts — SSE streaming client for the Main (Nanoclaw) channel.
 *
 * Same reconnect/backoff/replay-gap patterns as talkStream.ts, but connects
 * to the user-scoped event endpoint (`/api/v1/events?stream=1`) and filters
 * for Main-channel event types:
 *   - message_appended  (shared with Talks — filtered by threadId / talkId===null)
 *   - main_response_started
 *   - main_response_delta
 *   - main_heartbeat
 *   - main_response_completed
 *   - main_response_failed
 */

export type MainStreamState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline';

export type MainMessageAppendedEvent = {
  talkId?: string | null;
  threadId: string;
  messageId: string;
  runId: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  createdBy: string | null;
  content?: string;
  createdAt?: string;
  agentId?: string | null;
};

export type MainResponseStartedEvent = {
  runId: string;
  threadId: string;
  agentId: string;
  agentName: string;
};

export type MainResponseDeltaEvent = {
  runId: string;
  threadId: string;
  text: string;
};

export type MainProgressUpdateEvent = {
  runId: string;
  threadId: string;
  message: string;
};

export type MainHeartbeatEvent = {
  runId: string;
  threadId: string;
  at: string;
};

export type MainResponseCompletedEvent = {
  runId: string;
  threadId: string;
  responseMessageId: string;
};

export type MainResponseFailedEvent = {
  runId: string;
  threadId: string;
  errorCode: string;
  errorMessage: string;
};

export type MainRunEvent = {
  runId: string;
  threadId: string;
  status?: string;
  triggerMessageId?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  responseMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
  cancelReason?: string | null;
  requestedToolFamilies?: string[];
  userVisibleSummary?: string | null;
  parentRunId?: string | null;
  createdAt?: string;
};

export type MainPromotionPendingEvent = {
  runId: string;
  threadId: string;
  requestedToolFamilies: string[];
  userVisibleSummary: string;
};

export type MainBrowserBlockedEvent = {
  runId: string;
  talkId?: string | null;
  threadId: string;
  browserBlock: {
    kind: 'auth_required' | 'confirmation_required' | 'human_step_required';
  };
};

export type MainBrowserUnblockedEvent = {
  runId: string;
  talkId?: string | null;
  threadId: string;
  browserResume?: {
    kind?:
      | 'auth_completed'
      | 'confirmation_approved'
      | 'confirmation_rejected'
      | 'human_step_completed';
  } | null;
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

interface MainStreamCallbacks {
  onMessageAppended: (event: MainMessageAppendedEvent) => void;
  onRunQueued?: (event: MainRunEvent) => void;
  onRunStarted?: (event: MainRunEvent) => void;
  onRunWaitingApproval?: (event: MainRunEvent) => void;
  onRunCompleted?: (event: MainRunEvent) => void;
  onRunFailed?: (event: MainRunEvent) => void;
  onRunCancelled?: (event: MainRunEvent) => void;
  onPromotionPending?: (event: MainPromotionPendingEvent) => void;
  onBrowserBlocked?: (event: MainBrowserBlockedEvent) => void;
  onBrowserUnblocked?: (event: MainBrowserUnblockedEvent) => void;
  onResponseStarted?: (event: MainResponseStartedEvent) => void;
  onProgressUpdate?: (event: MainProgressUpdateEvent) => void;
  onHeartbeat?: (event: MainHeartbeatEvent) => void;
  onResponseDelta?: (event: MainResponseDeltaEvent) => void;
  onResponseCompleted?: (event: MainResponseCompletedEvent) => void;
  onResponseFailed?: (event: MainResponseFailedEvent) => void;
  onReplayGap: () => void | Promise<void>;
  onStateChange?: (state: MainStreamState) => void;
  onUnauthorized: () => void;
}

interface OpenMainStreamInput extends MainStreamCallbacks {
  createEventSource?: (url: string) => EventSourceLike;
  probeSession?: () => Promise<boolean>;
  jitterMs?: (baseMs: number) => number;
}

export interface MainStreamHandle {
  close: () => void;
}

const BACKOFF_STEPS_MS = [500, 1000, 2000, 4000, 8000] as const;

export function openMainStream(input: OpenMainStreamInput): MainStreamHandle {
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

  const emitState = (state: MainStreamState) => {
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

    // Use the user-scoped event endpoint — Main events publish to user:${userId}
    const url = '/api/v1/events?stream=1';
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

    // Main channel events
    next.addEventListener('message_appended', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MainMessageAppendedEvent>(event);
      if (!payload) return;
      // Main subscribes to the user-scoped stream, which also includes Talk
      // events for accessible talks. Only forward true Main-channel messages.
      if (payload.threadId && !payload.talkId) {
        input.onMessageAppended(payload);
      }
    });

    next.addEventListener('main_response_started', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MainResponseStartedEvent>(event);
      if (!payload) return;
      input.onResponseStarted?.(payload);
    });

    next.addEventListener('main_response_delta', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MainResponseDeltaEvent>(event);
      if (!payload) return;
      input.onResponseDelta?.(payload);
    });

    next.addEventListener('main_progress_update', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MainProgressUpdateEvent>(event);
      if (!payload) return;
      input.onProgressUpdate?.(payload);
    });

    next.addEventListener('main_heartbeat', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MainHeartbeatEvent>(event);
      if (!payload) return;
      input.onHeartbeat?.(payload);
    });

    next.addEventListener('main_response_completed', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MainResponseCompletedEvent>(event);
      if (!payload) return;
      input.onResponseCompleted?.(payload);
    });

    next.addEventListener('main_response_failed', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MainResponseFailedEvent>(event);
      if (!payload) return;
      input.onResponseFailed?.(payload);
    });

    next.addEventListener('main_run_queued', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MainRunEvent>(event);
      if (!payload) return;
      input.onRunQueued?.(payload);
    });

    next.addEventListener('main_run_started', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MainRunEvent>(event);
      if (!payload) return;
      input.onRunStarted?.(payload);
    });

    next.addEventListener('main_run_waiting_approval', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MainRunEvent>(event);
      if (!payload) return;
      input.onRunWaitingApproval?.(payload);
    });

    next.addEventListener('main_run_completed', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MainRunEvent>(event);
      if (!payload) return;
      input.onRunCompleted?.(payload);
    });

    next.addEventListener('main_run_failed', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MainRunEvent>(event);
      if (!payload) return;
      input.onRunFailed?.(payload);
    });

    next.addEventListener('main_run_cancelled', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MainRunEvent>(event);
      if (!payload) return;
      input.onRunCancelled?.(payload);
    });

    next.addEventListener('main_promotion_pending', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MainPromotionPendingEvent>(event);
      if (!payload) return;
      input.onPromotionPending?.(payload);
    });

    next.addEventListener('browser_blocked', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MainBrowserBlockedEvent>(event);
      if (!payload) return;
      input.onBrowserBlocked?.(payload);
    });

    next.addEventListener('browser_unblocked', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MainBrowserUnblockedEvent>(event);
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
    return true;
  }
}
