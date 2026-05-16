import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openMainStream } from './mainStream';
import type {
  WebSocketEventSourceFrame,
  WebSocketEventSourceOptions,
} from './websocketEventSource';

class FakeTransport {
  static instances: FakeTransport[] = [];

  readonly url: string;
  readonly options: WebSocketEventSourceOptions;
  close = vi.fn();

  constructor(url: string, options: WebSocketEventSourceOptions) {
    this.url = url;
    this.options = options;
    FakeTransport.instances.push(this);
  }

  emitOpen(): void {
    this.options.onOpen?.();
  }

  emitError(): void {
    this.options.onError?.(new Event('error'));
  }

  emitFrame(event: string, payload: unknown, id = 1): void {
    const frame: WebSocketEventSourceFrame = {
      event,
      data: JSON.stringify(payload),
      id,
    };
    this.options.onMessage(frame);
  }
}

describe('openMainStream', () => {
  beforeEach(() => {
    FakeTransport.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens a transport at /api/v1/events?stream=1', () => {
    openMainStream({
      onMessageAppended: vi.fn(),
      onReplayGap: vi.fn(),
      onUnauthorized: vi.fn(),
      createTransport: (url, options) => new FakeTransport(url, options),
      probeSession: vi.fn(async () => true),
      jitterMs: () => 0,
    });

    expect(FakeTransport.instances).toHaveLength(1);
    expect(FakeTransport.instances[0]!.url).toBe('/api/v1/events?stream=1');
  });

  it('forwards Main message_appended events', () => {
    const onMessageAppended = vi.fn();

    openMainStream({
      onMessageAppended,
      onReplayGap: vi.fn(),
      onUnauthorized: vi.fn(),
      createTransport: (url, options) => new FakeTransport(url, options),
      probeSession: vi.fn(async () => true),
      jitterMs: () => 0,
    });

    FakeTransport.instances[0]!.emitFrame(
      'message_appended',
      {
        threadId: '78fc5d1e-e7e9-4d65-a82d-352c89eba992',
        messageId: 'msg_1',
        runId: null,
        role: 'user',
        createdBy: 'user-1',
        content: 'hello',
        createdAt: '2026-03-18T12:00:00.000Z',
      },
      1,
    );

    expect(onMessageAppended).toHaveBeenCalledTimes(1);
    expect(onMessageAppended).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: '78fc5d1e-e7e9-4d65-a82d-352c89eba992',
      }),
    );
  });

  it('stops reconnecting and calls onUnauthorized when session probe returns unauthorized', async () => {
    const onUnauthorized = vi.fn();

    openMainStream({
      onMessageAppended: vi.fn(),
      onReplayGap: vi.fn(),
      onUnauthorized,
      createTransport: (url, options) => new FakeTransport(url, options),
      probeSession: vi.fn(async () => false),
      jitterMs: () => 0,
    });

    expect(FakeTransport.instances).toHaveLength(1);
    FakeTransport.instances[0]!.emitError();

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(FakeTransport.instances).toHaveLength(1);
  });

  it('forwards main_heartbeat events', () => {
    const onHeartbeat = vi.fn();

    openMainStream({
      onMessageAppended: vi.fn(),
      onHeartbeat,
      onReplayGap: vi.fn(),
      onUnauthorized: vi.fn(),
      createTransport: (url, options) => new FakeTransport(url, options),
      probeSession: vi.fn(async () => true),
      jitterMs: () => 0,
    });

    FakeTransport.instances[0]!.emitFrame(
      'main_heartbeat',
      {
        runId: 'run_1',
        threadId: 'thread_1',
        at: '2026-03-21T22:40:00.000Z',
      },
      1,
    );

    expect(onHeartbeat).toHaveBeenCalledTimes(1);
    expect(onHeartbeat).toHaveBeenCalledWith({
      runId: 'run_1',
      threadId: 'thread_1',
      at: '2026-03-21T22:40:00.000Z',
    });
  });
});
