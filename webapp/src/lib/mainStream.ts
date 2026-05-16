/**
 * mainStream.ts — WebSocket streaming client for the Main (Nanoclaw)
 * channel.
 *
 * Subscribes to the user-scoped stream (`user:${userId}`) over
 * WebSocket via /api/v1/events?stream=1. After W7-evtsse F2 the
 * user-scope topic carries only user-scoped events (Main responses,
 * cross-talk sidebar notifications); per-talk events arrive on the
 * separate per-talk socket opened by TalkDetailPage. Reconnect /
 * backoff / replay-gap mechanics mirror talkStream.ts.
 */

import {
  WebSocketEventSource,
  type WebSocketEventSourceFrame,
  type WebSocketEventSourceLike,
  type WebSocketEventSourceOptions,
} from './websocketEventSource';

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

export type MainStreamTransportFactory = (
  url: string,
  options: WebSocketEventSourceOptions,
) => WebSocketEventSourceLike;

interface OpenMainStreamInput extends MainStreamCallbacks {
  createTransport?: MainStreamTransportFactory;
  probeSession?: () => Promise<boolean>;
  jitterMs?: (baseMs: number) => number;
}

export interface MainStreamHandle {
  close: () => void;
}

const BACKOFF_STEPS_MS = [500, 1000, 2000, 4000, 8000] as const;

export function openMainStream(input: OpenMainStreamInput): MainStreamHandle {
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
        const payload = parseFrame<MainMessageAppendedEvent>(frame);
        if (payload) input.onMessageAppended(payload);
        return;
      }
      case 'main_response_started': {
        const payload = parseFrame<MainResponseStartedEvent>(frame);
        if (payload) input.onResponseStarted?.(payload);
        return;
      }
      case 'main_response_delta': {
        const payload = parseFrame<MainResponseDeltaEvent>(frame);
        if (payload) input.onResponseDelta?.(payload);
        return;
      }
      case 'main_progress_update': {
        const payload = parseFrame<MainProgressUpdateEvent>(frame);
        if (payload) input.onProgressUpdate?.(payload);
        return;
      }
      case 'main_heartbeat': {
        const payload = parseFrame<MainHeartbeatEvent>(frame);
        if (payload) input.onHeartbeat?.(payload);
        return;
      }
      case 'main_response_completed': {
        const payload = parseFrame<MainResponseCompletedEvent>(frame);
        if (payload) input.onResponseCompleted?.(payload);
        return;
      }
      case 'main_response_failed': {
        const payload = parseFrame<MainResponseFailedEvent>(frame);
        if (payload) input.onResponseFailed?.(payload);
        return;
      }
      case 'main_run_queued': {
        const payload = parseFrame<MainRunEvent>(frame);
        if (payload) input.onRunQueued?.(payload);
        return;
      }
      case 'main_run_started': {
        const payload = parseFrame<MainRunEvent>(frame);
        if (payload) input.onRunStarted?.(payload);
        return;
      }
      case 'main_run_waiting_approval': {
        const payload = parseFrame<MainRunEvent>(frame);
        if (payload) input.onRunWaitingApproval?.(payload);
        return;
      }
      case 'main_run_completed': {
        const payload = parseFrame<MainRunEvent>(frame);
        if (payload) input.onRunCompleted?.(payload);
        return;
      }
      case 'main_run_failed': {
        const payload = parseFrame<MainRunEvent>(frame);
        if (payload) input.onRunFailed?.(payload);
        return;
      }
      case 'main_run_cancelled': {
        const payload = parseFrame<MainRunEvent>(frame);
        if (payload) input.onRunCancelled?.(payload);
        return;
      }
      case 'main_promotion_pending': {
        const payload = parseFrame<MainPromotionPendingEvent>(frame);
        if (payload) input.onPromotionPending?.(payload);
        return;
      }
      case 'browser_blocked': {
        const payload = parseFrame<MainBrowserBlockedEvent>(frame);
        if (payload) input.onBrowserBlocked?.(payload);
        return;
      }
      case 'browser_unblocked': {
        const payload = parseFrame<MainBrowserUnblockedEvent>(frame);
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

    const url = '/api/v1/events?stream=1';
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
