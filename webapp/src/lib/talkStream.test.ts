import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openTalkStream } from './talkStream';
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

describe('openTalkStream', () => {
  beforeEach(() => {
    FakeTransport.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens a transport at /api/v1/talks/:id/events?stream=1', () => {
    openTalkStream({
      talkId: 'talk-1',
      onUnauthorized: vi.fn(),
      onReplayGap: vi.fn(),
      onMessageAppended: vi.fn(),
      onRunStarted: vi.fn(),
      onRunQueued: vi.fn(),
      onRunCompleted: vi.fn(),
      onRunFailed: vi.fn(),
      onRunCancelled: vi.fn(),
      createTransport: (url, options) => new FakeTransport(url, options),
      probeSession: vi.fn(async () => true),
      jitterMs: () => 0,
    });

    expect(FakeTransport.instances).toHaveLength(1);
    expect(FakeTransport.instances[0]!.url).toBe(
      '/api/v1/talks/talk-1/events?stream=1',
    );
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
      createTransport: (url, options) => new FakeTransport(url, options),
      probeSession: vi.fn(async () => true),
      jitterMs: () => 0,
    });

    expect(FakeTransport.instances).toHaveLength(1);
    const first = FakeTransport.instances[0]!;
    first.emitOpen();
    first.emitError();

    await vi.runAllTicks();
    expect(states).toContain('reconnecting');

    await vi.advanceTimersByTimeAsync(500);
    expect(FakeTransport.instances).toHaveLength(2);
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

  it('invokes replay-gap callback and opens a fresh transport', async () => {
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
      createTransport: (url, options) => new FakeTransport(url, options),
      probeSession: vi.fn(async () => true),
      jitterMs: () => 0,
    });

    expect(FakeTransport.instances).toHaveLength(1);
    const first = FakeTransport.instances[0]!;
    first.emitFrame('replay_gap', {});

    await vi.runAllTicks();

    expect(onReplayGap).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(FakeTransport.instances).toHaveLength(2);
  });

  it('keeps lastEventId after a replay_gap so the next connect paginates forward', async () => {
    openTalkStream({
      talkId: 'talk-1',
      onUnauthorized: vi.fn(),
      onReplayGap: vi.fn(async () => undefined),
      onMessageAppended: vi.fn(),
      onRunStarted: vi.fn(),
      onRunQueued: vi.fn(),
      onRunCompleted: vi.fn(),
      onRunFailed: vi.fn(),
      onRunCancelled: vi.fn(),
      createTransport: (url, options) => new FakeTransport(url, options),
      probeSession: vi.fn(async () => true),
      jitterMs: () => 0,
    });

    const first = FakeTransport.instances[0]!;
    // The DO sends 500 events ahead of a replay_gap (cap exceeded).
    // Simulate the last one landing here so lastEventId advances.
    first.emitFrame(
      'talk_run_started',
      {
        talkId: 'talk-1',
        runId: 'run-1',
        triggerMessageId: null,
        status: 'running',
      },
      500,
    );
    first.emitFrame('replay_gap', { reason: 'replay_cap_500_exceeded' });

    await vi.runAllTicks();

    expect(FakeTransport.instances).toHaveLength(2);
    const second = FakeTransport.instances[1]!;
    // Crucial: do NOT reset to 0. If we did, the DO would replay the
    // same first 500 events every reconnect and loop forever.
    expect(second.options.getLastEventId()).toBe(500);
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
      createTransport: (url, options) => new FakeTransport(url, options),
      probeSession: vi.fn(async () => true),
      jitterMs: () => 0,
    });

    expect(FakeTransport.instances).toHaveLength(1);
    const first = FakeTransport.instances[0]!;

    handle.close();
    expect(first.close).toHaveBeenCalledTimes(1);

    first.emitError();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(FakeTransport.instances).toHaveLength(1);
  });

  it('dispatches typed events to the right callbacks', () => {
    const onRunStarted = vi.fn();
    const onResponseDelta = vi.fn();

    openTalkStream({
      talkId: 'talk-1',
      onUnauthorized: vi.fn(),
      onReplayGap: vi.fn(),
      onMessageAppended: vi.fn(),
      onRunStarted,
      onRunQueued: vi.fn(),
      onRunCompleted: vi.fn(),
      onRunFailed: vi.fn(),
      onRunCancelled: vi.fn(),
      onResponseDelta,
      createTransport: (url, options) => new FakeTransport(url, options),
      probeSession: vi.fn(async () => true),
      jitterMs: () => 0,
    });

    const transport = FakeTransport.instances[0]!;
    transport.emitFrame(
      'talk_run_started',
      {
        talkId: 'talk-1',
        runId: 'run-1',
        triggerMessageId: null,
        status: 'running',
      },
      1,
    );
    transport.emitFrame(
      'talk_response_delta',
      { talkId: 'talk-1', runId: 'run-1', deltaText: 'hi' },
      2,
    );

    expect(onRunStarted).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', status: 'running' }),
    );
    expect(onResponseDelta).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', deltaText: 'hi' }),
    );
  });

  it('hoists lastEventId so reconnects resume from the latest frame (G4)', async () => {
    openTalkStream({
      talkId: 'talk-1',
      onUnauthorized: vi.fn(),
      onReplayGap: vi.fn(),
      onMessageAppended: vi.fn(),
      onRunStarted: vi.fn(),
      onRunQueued: vi.fn(),
      onRunCompleted: vi.fn(),
      onRunFailed: vi.fn(),
      onRunCancelled: vi.fn(),
      createTransport: (url, options) => new FakeTransport(url, options),
      probeSession: vi.fn(async () => true),
      jitterMs: () => 0,
    });

    const first = FakeTransport.instances[0]!;
    expect(first.options.getLastEventId()).toBe(0);

    first.emitFrame(
      'talk_run_started',
      {
        talkId: 'talk-1',
        runId: 'run-1',
        triggerMessageId: null,
        status: 'running',
      },
      10,
    );
    expect(first.options.getLastEventId()).toBe(10);

    first.emitError();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(500);

    expect(FakeTransport.instances).toHaveLength(2);
    const second = FakeTransport.instances[1]!;
    expect(second.options.getLastEventId()).toBe(10);
  });
});
