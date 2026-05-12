import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openTalkStream } from './talkStream';

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const existing = this.listeners.get(type) || [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  emitOpen(): void {
    this.onopen?.(new Event('open'));
  }

  emitError(): void {
    this.onerror?.(new Event('error'));
  }

  emitEvent(type: string, payload: unknown): void {
    const serialized = JSON.stringify(payload);
    const event = { data: serialized } as MessageEvent<string>;
    const listeners = this.listeners.get(type) || [];
    for (const listener of listeners) {
      listener(event);
    }
  }

  emitRaw(type: string): void {
    const event = { data: '{}' } as MessageEvent<string>;
    const listeners = this.listeners.get(type) || [];
    for (const listener of listeners) {
      listener(event);
    }
  }
}

describe('openTalkStream', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reconnects with backoff on transport failure when session is still valid', async () => {
    const onUnauthorized = vi.fn();
    const states: string[] = [];

    openTalkStream({
      talkId: 'talk-1',
      onUnauthorized,
      onReplayGap: vi.fn(),
      onMessageAppended: vi.fn(),
      onRunStarted: vi.fn(),
      onRunQueued: vi.fn(),
      onRunCompleted: vi.fn(),
      onRunFailed: vi.fn(),
      onRunCancelled: vi.fn(),
      onStateChange: (state) => states.push(state),
      createEventSource: (url) => new FakeEventSource(url),
      probeSession: vi.fn(async () => true),
      jitterMs: () => 0,
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    const first = FakeEventSource.instances[0];
    first.emitOpen();
    first.emitError();

    await vi.runAllTicks();
    expect(states).toContain('reconnecting');

    await vi.advanceTimersByTimeAsync(500);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('stops reconnecting and calls onUnauthorized when session probe returns unauthorized', async () => {
    const onUnauthorized = vi.fn();

    openTalkStream({
      talkId: 'talk-1',
      onUnauthorized,
      onReplayGap: vi.fn(),
      onMessageAppended: vi.fn(),
      onRunStarted: vi.fn(),
      onRunQueued: vi.fn(),
      onRunCompleted: vi.fn(),
      onRunFailed: vi.fn(),
      onRunCancelled: vi.fn(),
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

  it('invokes replay-gap callback and opens a fresh EventSource connection', async () => {
    const onReplayGap = vi.fn(async () => undefined);

    openTalkStream({
      talkId: 'talk-1',
      onUnauthorized: vi.fn(),
      onReplayGap,
      onMessageAppended: vi.fn(),
      onRunStarted: vi.fn(),
      onRunQueued: vi.fn(),
      onRunCompleted: vi.fn(),
      onRunFailed: vi.fn(),
      onRunCancelled: vi.fn(),
      createEventSource: (url) => new FakeEventSource(url),
      probeSession: vi.fn(async () => true),
      jitterMs: () => 0,
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    const first = FakeEventSource.instances[0];
    first.emitRaw('replay_gap');

    await vi.runAllTicks();

    expect(onReplayGap).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('closes externally and prevents further reconnect attempts', async () => {
    const handle = openTalkStream({
      talkId: 'talk-1',
      onUnauthorized: vi.fn(),
      onReplayGap: vi.fn(),
      onMessageAppended: vi.fn(),
      onRunStarted: vi.fn(),
      onRunQueued: vi.fn(),
      onRunCompleted: vi.fn(),
      onRunFailed: vi.fn(),
      onRunCancelled: vi.fn(),
      createEventSource: (url) => new FakeEventSource(url),
      probeSession: vi.fn(async () => true),
      jitterMs: () => 0,
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    const first = FakeEventSource.instances[0];

    handle.close();
    expect(first.close).toHaveBeenCalledTimes(1);

    first.emitError();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
