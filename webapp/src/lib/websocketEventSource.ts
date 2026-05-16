// WebSocket adapter that wears an EventSource-shaped face for the
// talkStream / mainStream wrappers. The Worker → UserEventHub DO
// pipeline sends framed events as `{event, data, id}` JSON messages
// over WebSocket Hibernation (W7 U3/U4); this adapter turns each
// message into a wrapper-friendly dispatch callback.
//
// Cursor state lives in the wrapper (G4). The adapter reads via the
// `getLastEventId` callback when constructing the reconnect URL and
// is otherwise stateless — fresh adapter per reconnect, no carry-over.

export interface WebSocketEventSourceFrame {
  event: string;
  data: string;
  id: number;
}

export interface WebSocketLike {
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open',
    listener: (event: Event) => void,
  ): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<string>) => void,
  ): void;
  addEventListener(
    type: 'error',
    listener: (event: Event) => void,
  ): void;
  addEventListener(
    type: 'close',
    listener: (event: CloseEvent) => void,
  ): void;
}

export interface WebSocketEventSourceOptions {
  getLastEventId: () => number;
  onMessage: (frame: WebSocketEventSourceFrame) => void;
  onOpen?: () => void;
  onError?: (err?: unknown) => void;
  createWebSocket?: (url: string) => WebSocketLike;
}

export interface WebSocketEventSourceLike {
  close(): void;
}

export class WebSocketEventSource implements WebSocketEventSourceLike {
  private ws: WebSocketLike | null = null;

  constructor(
    private readonly url: string,
    private readonly options: WebSocketEventSourceOptions,
  ) {
    this.open();
  }

  private open(): void {
    const lastEventId = this.options.getLastEventId();
    const wsUrl = buildWebSocketUrl(this.url, lastEventId);
    const factory =
      this.options.createWebSocket ??
      ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
    const ws = factory(wsUrl);
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.options.onOpen?.();
    });

    ws.addEventListener('message', (event: MessageEvent<string>) => {
      if (this.ws !== ws) return;
      let parsed: { event?: unknown; data?: unknown; id?: unknown };
      try {
        parsed = JSON.parse(event.data) as typeof parsed;
      } catch (err) {
        this.options.onError?.(err);
        return;
      }
      if (
        typeof parsed.event !== 'string' ||
        typeof parsed.id !== 'number' ||
        !Number.isFinite(parsed.id)
      ) {
        this.options.onError?.(new Error('invalid_event_frame'));
        return;
      }
      this.options.onMessage({
        event: parsed.event,
        data: JSON.stringify(parsed.data ?? null),
        id: parsed.id,
      });
    });

    ws.addEventListener('error', (event: Event) => {
      if (this.ws !== ws) return;
      this.options.onError?.(event);
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      if (this.ws !== ws) return;
      if (event.code === 1000) return;
      this.options.onError?.(event);
    });
  }

  close(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.close(1000);
  }
}

function buildWebSocketUrl(url: string, lastEventId: number): string {
  let base = url;
  if (base.startsWith('http://')) {
    base = 'ws://' + base.slice('http://'.length);
  } else if (base.startsWith('https://')) {
    base = 'wss://' + base.slice('https://'.length);
  } else if (base.startsWith('/')) {
    const loc = typeof window !== 'undefined' ? window.location : null;
    const proto = loc && loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = loc ? loc.host : 'localhost';
    base = `${proto}//${host}${base}`;
  }
  if (lastEventId > 0) {
    const sep = base.includes('?') ? '&' : '?';
    base = `${base}${sep}lastEventId=${lastEventId}`;
  }
  return base;
}
