import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openMainStream } from './mainStream';

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<
    string,
    Array<(event: MessageEvent<string>) => void>
  >();
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void {
    const existing = this.listeners.get(type) || [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  emitEvent(type: string, payload: unknown): void {
    const serialized = JSON.stringify(payload);
    const event = { data: serialized } as MessageEvent<string>;
    const listeners = this.listeners.get(type) || [];
    for (const listener of listeners) {
      listener(event);
    }
  }

  emitError(): void {
    this.onerror?.(new Event('error'));
  }
}

describe('openMainStream', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ignores talk message_appended events that leak into the user-scoped stream', () => {
    const onMessageAppended = vi.fn();

    openMainStream({
      onMessageAppended,
      onReplayGap: vi.fn(),
      onUnauthorized: vi.fn(),
      createEventSource: (url) => new FakeEventSource(url),
      probeSession: vi.fn(async () => true),
      jitterMs: () => 0,
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0].emitEvent('message_appended', {
      talkId: 'talk-cal',
      threadId: 'thread_123',
      messageId: 'msg_1',
      runId: null,
      role: 'user',
      createdBy: 'user-1',
      content: 'hello',
      createdAt: '2026-03-18T12:00:00.000Z',
    });

    expect(onMessageAppended).not.toHaveBeenCalled();
  });

  it('forwards real Main message_appended events', () => {
    const onMessageAppended = vi.fn();

    openMainStream({
      onMessageAppended,
      onReplayGap: vi.fn(),
      onUnauthorized: vi.fn(),
      createEventSource: (url) => new FakeEventSource(url),
      probeSession: vi.fn(async () => true),
      jitterMs: () => 0,
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0].emitEvent('message_appended', {
      threadId: '78fc5d1e-e7e9-4d65-a82d-352c89eba992',
      messageId: 'msg_1',
      runId: null,
      role: 'user',
      createdBy: 'user-1',
      content: 'hello',
      createdAt: '2026-03-18T12:00:00.000Z',
    });

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
      createEventSource: (url) => new FakeEventSource(url),
      probeSession: vi.fn(async () => false),
      jitterMs: () => 0,
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0].emitError();

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('forwards main_heartbeat events', () => {
    const onHeartbeat = vi.fn();

    openMainStream({
      onMessageAppended: vi.fn(),
      onHeartbeat,
      onReplayGap: vi.fn(),
      onUnauthorized: vi.fn(),
      createEventSource: (url) => new FakeEventSource(url),
      probeSession: vi.fn(async () => true),
      jitterMs: () => 0,
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0].emitEvent('main_heartbeat', {
      runId: 'run_1',
      threadId: 'thread_1',
      at: '2026-03-21T22:40:00.000Z',
    });

    expect(onHeartbeat).toHaveBeenCalledTimes(1);
    expect(onHeartbeat).toHaveBeenCalledWith({
      runId: 'run_1',
      threadId: 'thread_1',
      at: '2026-03-21T22:40:00.000Z',
    });
  });
});
