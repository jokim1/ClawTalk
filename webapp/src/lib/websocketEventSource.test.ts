import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WebSocketEventSource,
  type WebSocketLike,
} from './websocketEventSource';

type Listeners = {
  open: Array<(ev: Event) => void>;
  message: Array<(ev: MessageEvent<string>) => void>;
  error: Array<(ev: Event) => void>;
  close: Array<(ev: CloseEvent) => void>;
};

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly listeners: Listeners = {
    open: [],
    message: [],
    error: [],
    close: [],
  };
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: 'open', listener: (ev: Event) => void): void;
  addEventListener(
    type: 'message',
    listener: (ev: MessageEvent<string>) => void,
  ): void;
  addEventListener(type: 'error', listener: (ev: Event) => void): void;
  addEventListener(type: 'close', listener: (ev: CloseEvent) => void): void;
  addEventListener(
    type: keyof Listeners,
    listener:
      | ((ev: Event) => void)
      | ((ev: MessageEvent<string>) => void)
      | ((ev: CloseEvent) => void),
  ): void {
    const bucket = this.listeners[type];
    (bucket as Array<typeof listener>).push(listener);
  }

  emitOpen(): void {
    for (const l of this.listeners.open) l(new Event('open'));
  }

  emitMessage(data: string): void {
    for (const l of this.listeners.message) {
      l({ data } as MessageEvent<string>);
    }
  }

  emitError(): void {
    for (const l of this.listeners.error) l(new Event('error'));
  }

  emitClose(code: number, reason = ''): void {
    for (const l of this.listeners.close) {
      l({ code, reason, wasClean: code === 1000 } as CloseEvent);
    }
  }
}

describe('WebSocketEventSource', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        protocol: 'https:',
        host: 'app.example.com',
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rewrites relative /api URL to wss with host', () => {
    new WebSocketEventSource('/api/v1/events?stream=1', {
      getLastEventId: () => 0,
      onMessage: vi.fn(),
      createWebSocket: (url) => new FakeWebSocket(url),
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.url).toBe(
      'wss://app.example.com/api/v1/events?stream=1',
    );
  });

  it('appends ?lastEventId on reconnect when cursor > 0', () => {
    let cursor = 0;
    const make = () =>
      new WebSocketEventSource('/api/v1/events?stream=1', {
        getLastEventId: () => cursor,
        onMessage: vi.fn(),
        createWebSocket: (url) => new FakeWebSocket(url),
      });

    make();
    expect(FakeWebSocket.instances[0]!.url).not.toContain('lastEventId');

    cursor = 42;
    make();
    expect(FakeWebSocket.instances[1]!.url).toContain('&lastEventId=42');
  });

  it('parses framed JSON and dispatches via onMessage', () => {
    const onMessage = vi.fn();
    new WebSocketEventSource('/api/v1/events?stream=1', {
      getLastEventId: () => 0,
      onMessage,
      createWebSocket: (url) => new FakeWebSocket(url),
    });

    FakeWebSocket.instances[0]!.emitMessage(
      JSON.stringify({
        event: 'talk_response_delta',
        data: { runId: 'run-1', deltaText: 'hello' },
        id: 7,
      }),
    );

    expect(onMessage).toHaveBeenCalledTimes(1);
    const frame = onMessage.mock.calls[0]![0];
    expect(frame.event).toBe('talk_response_delta');
    expect(frame.id).toBe(7);
    expect(JSON.parse(frame.data)).toEqual({
      runId: 'run-1',
      deltaText: 'hello',
    });
  });

  it('fires onError on unclean close', () => {
    const onError = vi.fn();
    new WebSocketEventSource('/api/v1/events?stream=1', {
      getLastEventId: () => 0,
      onMessage: vi.fn(),
      onError,
      createWebSocket: (url) => new FakeWebSocket(url),
    });

    FakeWebSocket.instances[0]!.emitClose(1006, 'abnormal');
    expect(onError).toHaveBeenCalledTimes(1);

    // Clean close → no error.
    onError.mockClear();
    new WebSocketEventSource('/api/v1/events?stream=1', {
      getLastEventId: () => 0,
      onMessage: vi.fn(),
      onError,
      createWebSocket: (url) => new FakeWebSocket(url),
    });
    FakeWebSocket.instances[1]!.emitClose(1000, 'ok');
    expect(onError).not.toHaveBeenCalled();
  });

  it('close() closes the underlying WebSocket with code 1000', () => {
    const adapter = new WebSocketEventSource('/api/v1/events?stream=1', {
      getLastEventId: () => 0,
      onMessage: vi.fn(),
      createWebSocket: (url) => new FakeWebSocket(url),
    });

    adapter.close();
    expect(FakeWebSocket.instances[0]!.close).toHaveBeenCalledWith(1000);
  });

  it('routes onError when frame is not valid JSON', () => {
    const onMessage = vi.fn();
    const onError = vi.fn();
    new WebSocketEventSource('/api/v1/events?stream=1', {
      getLastEventId: () => 0,
      onMessage,
      onError,
      createWebSocket: (url) => new FakeWebSocket(url),
    });

    FakeWebSocket.instances[0]!.emitMessage('not-json');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
  });
});
