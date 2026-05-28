// Unit tests for the T7 in-process dispatcher. Verifies:
//   • the helper opens a request-scoped DB and forwards to
//     `processTalkRunMessage` with the expected `{runId, attempts:1,
//     maxRetries:3}` payload — the same payload the queue consumer
//     uses on first delivery (see src/worker.ts:queue()), so the
//     run executes under identical retry semantics.
//   • errors from `processTalkRunMessage` are caught and logged —
//     the helper is fire-and-forget from `ctx.waitUntil` and must
//     never throw past the caller.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.mock hoists. Declare both module mocks before any code that
// resolves them so the helper picks up the stubbed implementations.
vi.mock('../../db.js', () => ({
  withRequestScopedDb: vi.fn(async (_url, _ctx, _env, fn) => fn()),
}));
vi.mock('./queue-consumer.js', () => ({
  processTalkRunMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { withRequestScopedDb } from '../../db.js';
import { logger } from '../../logger.js';
import {
  dispatchRunInProcess,
  type DispatchRunInProcessEnv,
} from './dispatch-in-process.js';
import { processTalkRunMessage } from './queue-consumer.js';

function buildEnv(
  queueSend: (msg: unknown, opts?: unknown) => Promise<void> = async () => {},
): DispatchRunInProcessEnv {
  return {
    DB: { connectionString: 'postgresql://test' },
    DB_EVENT_HUB_URL: 'http://hub',
    USER_EVENT_HUB: {} as never,
    TALK_RUN_QUEUE: { send: queueSend } as never,
    ATTACHMENTS: {} as never,
  };
}

function buildCtx(): { waitUntil: (promise: Promise<unknown>) => void } {
  return { waitUntil: (_promise: Promise<unknown>): void => {} };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dispatchRunInProcess', () => {
  it('forwards to processTalkRunMessage with attempts=1 and maxRetries=3', async () => {
    await dispatchRunInProcess({
      env: buildEnv(),
      ctx: buildCtx(),
      runId: 'run-abc',
    });

    expect(processTalkRunMessage).toHaveBeenCalledTimes(1);
    expect(processTalkRunMessage).toHaveBeenCalledWith({
      runId: 'run-abc',
      attempts: 1,
      maxRetries: 3,
    });
  });

  it('opens withRequestScopedDb with the env.DB connection string', async () => {
    await dispatchRunInProcess({
      env: buildEnv(),
      ctx: buildCtx(),
      runId: 'run-xyz',
    });

    expect(withRequestScopedDb).toHaveBeenCalledTimes(1);
    const [url, , dbEnv] = vi.mocked(withRequestScopedDb).mock.calls[0]!;
    expect(url).toBe('postgresql://test');
    expect(dbEnv).toMatchObject({
      DB_EVENT_HUB_URL: 'http://hub',
    });
  });

  it('on processTalkRunMessage failure, falls back to TALK_RUN_QUEUE.send', async () => {
    const boom = new Error('upstream exploded');
    vi.mocked(processTalkRunMessage).mockRejectedValueOnce(boom);
    const sendSpy = vi.fn(async () => {});

    await expect(
      dispatchRunInProcess({
        env: buildEnv(sendSpy),
        ctx: buildCtx(),
        runId: 'run-fail',
      }),
    ).resolves.toBeUndefined();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      { runId: 'run-fail' },
      { contentType: 'json' },
    );
    expect(logger.error).toHaveBeenCalled();
    const firstLog = vi.mocked(logger.error).mock.calls[0]![0];
    expect(firstLog).toMatchObject({ err: boom, runId: 'run-fail' });
  });

  it('logs "stranded" when both in-process exec AND fallback queue.send fail', async () => {
    vi.mocked(processTalkRunMessage).mockRejectedValueOnce(
      new Error('exec fail'),
    );
    const sendBoom = new Error('queue down');
    const sendSpy = vi.fn(async () => {
      throw sendBoom;
    });

    await expect(
      dispatchRunInProcess({
        env: buildEnv(sendSpy),
        ctx: buildCtx(),
        runId: 'run-stranded',
      }),
    ).resolves.toBeUndefined();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    // Last error log mentions the stranded state explicitly.
    const calls = vi.mocked(logger.error).mock.calls;
    const lastMsg = calls[calls.length - 1]![1];
    expect(lastMsg).toContain('stranded');
  });

  it('logs "binding missing" when TALK_RUN_QUEUE is undefined', async () => {
    vi.mocked(processTalkRunMessage).mockRejectedValueOnce(
      new Error('exec fail'),
    );
    const env: DispatchRunInProcessEnv = {
      DB: { connectionString: 'postgresql://test' },
      DB_EVENT_HUB_URL: 'http://hub',
      USER_EVENT_HUB: {} as never,
      TALK_RUN_QUEUE: undefined,
      ATTACHMENTS: {} as never,
    };

    await expect(
      dispatchRunInProcess({ env, ctx: buildCtx(), runId: 'run-no-queue' }),
    ).resolves.toBeUndefined();

    const calls = vi.mocked(logger.error).mock.calls;
    const lastMsg = calls[calls.length - 1]![1];
    expect(lastMsg).toContain('binding missing');
  });
});
