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

function buildEnv(): DispatchRunInProcessEnv {
  return {
    DB: { connectionString: 'postgresql://test' },
    DB_EVENT_HUB_URL: 'http://hub',
    USER_EVENT_HUB: {} as never,
    TALK_RUN_QUEUE: {} as never,
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

  it('catches processTalkRunMessage errors and logs them (never throws)', async () => {
    const boom = new Error('upstream exploded');
    vi.mocked(processTalkRunMessage).mockRejectedValueOnce(boom);

    await expect(
      dispatchRunInProcess({
        env: buildEnv(),
        ctx: buildCtx(),
        runId: 'run-fail',
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [logArg] = vi.mocked(logger.error).mock.calls[0]!;
    expect(logArg).toMatchObject({ err: boom, runId: 'run-fail' });
  });
});
