import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  type DbScopeEnvBindings,
  type RequestExecutionContext,
  withRequestScopedDb,
  withUserContext,
} from '../../db.js';
import {
  createTalk,
  createTalkMessage,
  createTalkRun,
  getOrCreateDefaultThread,
  getOutboxEventsForTopics,
  getTalkRunById,
  markRunRunning,
  markTalkRunStatus,
} from '../db/accessors.js';
import type {
  TalkExecutor,
  TalkExecutorInput,
  TalkExecutorOutput,
  TalkExecutionEvent,
} from './executor.js';
import {
  BlockedBySiblingError,
  processDlqMessage,
  processTalkRunMessage,
} from './queue-consumer.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const OWNER_ID = '0c777777-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function seedAuthUser(id: string, email: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${id}::uuid, ${email}::text,
            jsonb_build_object('full_name', ${email}::text))
    on conflict (id) do nothing
  `;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.talks where owner_id = ${OWNER_ID}::uuid`;
  await db`delete from public.event_outbox where topic like 'talk:%'`;
}

beforeAll(async () => {
  await initPgDatabase({ url: TEST_DB_URL });
  await seedAuthUser(OWNER_ID, 'queue-consumer-test@clawtalk.test');
});

afterAll(async () => {
  await purge();
  await closePgDatabase();
});

beforeEach(async () => {
  await purge();
});

async function setupRun(opts?: {
  sequenceIndex?: number;
  responseGroupId?: string;
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  agentId?: string;
}): Promise<{ runId: string; talkId: string; messageId: string }> {
  return await withUserContext(OWNER_ID, async () => {
    const talk = await createTalk({
      ownerId: OWNER_ID,
      topicTitle: 'Queue Consumer Test Talk',
    });
    const threadId = await getOrCreateDefaultThread({
      talkId: talk.id,
      ownerId: OWNER_ID,
    });
    const message = await createTalkMessage({
      ownerId: OWNER_ID,
      talkId: talk.id,
      threadId,
      role: 'user',
      content: 'trigger me',
    });
    const run = await createTalkRun({
      ownerId: OWNER_ID,
      talkId: talk.id,
      threadId,
      requestedBy: OWNER_ID,
      status: opts?.status ?? 'queued',
      triggerMessageId: message.id,
      targetAgentId: opts?.agentId ?? null,
      responseGroupId: opts?.responseGroupId ?? null,
      sequenceIndex: opts?.sequenceIndex ?? null,
    });
    return { runId: run.id, talkId: talk.id, messageId: message.id };
  });
}

function makeMockCtx(): {
  ctx: RequestExecutionContext;
  drain: () => Promise<void>;
} {
  const promises: Array<Promise<unknown>> = [];
  return {
    ctx: { waitUntil: (p) => promises.push(p) },
    drain: async () => {
      await Promise.all(promises);
    },
  };
}

function makeMockExecutor(behavior: {
  output?: Partial<TalkExecutorOutput>;
  throwError?: Error;
  emitEvents?: TalkExecutionEvent[];
  waitFor?: Promise<unknown>;
}): TalkExecutor {
  return {
    async execute(
      _input: TalkExecutorInput,
      signal: AbortSignal,
      emit?: (event: TalkExecutionEvent) => void,
    ): Promise<TalkExecutorOutput> {
      for (const event of behavior.emitEvents ?? []) {
        emit?.(event);
      }
      if (behavior.waitFor) {
        await Promise.race([
          behavior.waitFor,
          new Promise((_, reject) => {
            const onAbort = () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
      }
      if (behavior.throwError) throw behavior.throwError;
      return {
        content: behavior.output?.content ?? 'mock response',
        metadataJson: behavior.output?.metadataJson ?? null,
        agentId: behavior.output?.agentId ?? null,
        agentNickname: behavior.output?.agentNickname ?? null,
        providerId: behavior.output?.providerId ?? null,
        modelId: behavior.output?.modelId ?? null,
        usage: behavior.output?.usage,
        responseSequenceInRun: behavior.output?.responseSequenceInRun ?? null,
      };
    },
  };
}

describe('markRunRunning', () => {
  it('queued → running emits talk_run_started', async () => {
    const { runId, talkId } = await setupRun();

    const result = await markRunRunning(runId);
    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed') return;
    expect(result.run.status).toBe('running');

    const events = await getOutboxEventsForTopics([`talk:${talkId}`], 0);
    const started = events.find((e) => e.event_type === 'talk_run_started');
    expect(started).toBeTruthy();
  });

  it('returns terminal for completed runs', async () => {
    const { runId } = await setupRun({ status: 'completed' });
    const result = await markRunRunning(runId);
    expect(result.status).toBe('terminal');
  });

  it('returns not_found for missing runs', async () => {
    const result = await markRunRunning('11111111-1111-1111-1111-111111111111');
    expect(result.status).toBe('not_found');
  });

  it('does not re-claim a running row (duplicate-delivery safety)', async () => {
    const { runId, talkId } = await setupRun();

    const first = await markRunRunning(runId);
    expect(first.status).toBe('claimed');
    const baselineCount = (
      await getOutboxEventsForTopics([`talk:${talkId}`], 0)
    ).filter((e) => e.event_type === 'talk_run_started').length;

    // A duplicate / redelivered message for an already-running row must NOT
    // re-claim — re-claiming would let the run execute twice. It returns
    // 'already_running' so the consumer acks, and emits no second start.
    const second = await markRunRunning(runId);
    expect(second.status).toBe('already_running');
    const afterCount = (
      await getOutboxEventsForTopics([`talk:${talkId}`], 0)
    ).filter((e) => e.event_type === 'talk_run_started').length;

    expect(afterCount).toBe(baselineCount);
  });

  it('blocks claim when a lower-sequence sibling is still active', async () => {
    const groupId = '0c777777-cccc-cccc-cccc-cccccccccccc';
    const first = await setupRun({
      sequenceIndex: 0,
      responseGroupId: groupId,
      status: 'queued',
    });
    const second = await setupRun({
      sequenceIndex: 1,
      responseGroupId: groupId,
      status: 'queued',
    });

    const firstClaim = await markRunRunning(first.runId);
    expect(firstClaim.status).toBe('claimed');

    const secondClaim = await markRunRunning(second.runId);
    expect(secondClaim.status).toBe('blocked_by_sibling');

    await markTalkRunStatus(first.runId, 'completed', {
      endedAt: new Date().toISOString(),
    });
    const secondClaimAfter = await markRunRunning(second.runId);
    expect(secondClaimAfter.status).toBe('claimed');
  });
});

describe('processTalkRunMessage', () => {
  it('runs the executor to completion and flips status to completed', async () => {
    const { runId, talkId } = await setupRun();
    const { ctx, drain } = makeMockCtx();

    const env: DbScopeEnvBindings = {};
    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await processTalkRunMessage({
        runId,
        executor: makeMockExecutor({ output: { content: 'all done' } }),
        cancelPollIntervalMs: 50_000,
      });
    });
    await drain();

    const run = await getTalkRunById(runId);
    expect(run?.status).toBe('completed');

    const events = await getOutboxEventsForTopics([`talk:${talkId}`], 0);
    const types = events.map((e) => e.event_type);
    expect(types).toContain('talk_run_started');
    expect(types).toContain('talk_run_completed');
  });

  it('throws BlockedBySiblingError when a sibling is still active', async () => {
    const groupId = '0c777777-dddd-dddd-dddd-dddddddddddd';
    const first = await setupRun({
      sequenceIndex: 0,
      responseGroupId: groupId,
    });
    const second = await setupRun({
      sequenceIndex: 1,
      responseGroupId: groupId,
    });
    void first;

    const { ctx } = makeMockCtx();
    const env: DbScopeEnvBindings = {};
    await expect(
      withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
        await processTalkRunMessage({
          runId: second.runId,
          executor: makeMockExecutor({ output: { content: 'should not run' } }),
        });
      }),
    ).rejects.toBeInstanceOf(BlockedBySiblingError);
  });

  it('returns without error when the run is already terminal', async () => {
    const { runId } = await setupRun({ status: 'completed' });
    const { ctx } = makeMockCtx();
    const env: DbScopeEnvBindings = {};
    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await processTalkRunMessage({
        runId,
        executor: makeMockExecutor({
          throwError: new Error('should not be called'),
        }),
      });
    });
  });

  it('acks without executing when the run is already running (duplicate delivery)', async () => {
    // Simulates a second at-least-once delivery (or sweep + promotion both
    // enqueuing the same runId) arriving while another invocation owns the
    // run. The executor must not fire — double-execution is the bug.
    const { runId } = await setupRun({ status: 'running' });
    const { ctx } = makeMockCtx();
    const env: DbScopeEnvBindings = {};
    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await processTalkRunMessage({
        runId,
        executor: makeMockExecutor({
          throwError: new Error('duplicate delivery must not execute'),
        }),
      });
    });
    // Untouched — still running, not flipped or failed by the duplicate.
    expect(await getTalkRunById(runId).then((r) => r?.status)).toBe('running');
  });

  it('aborts execution and ack-returns when status flips to cancelled mid-run', async () => {
    const { runId } = await setupRun();
    const { ctx, drain } = makeMockCtx();

    let releaseExecutor: () => void = () => {};
    const executorBlock = new Promise<void>((resolve) => {
      releaseExecutor = resolve;
    });

    const env: DbScopeEnvBindings = {};
    const runPromise = withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await processTalkRunMessage({
        runId,
        executor: makeMockExecutor({ waitFor: executorBlock }),
        cancelPollIntervalMs: 50,
      });
    });

    await new Promise((r) => setTimeout(r, 150));
    await markTalkRunStatus(runId, 'cancelled', {
      endedAt: new Date().toISOString(),
    });
    releaseExecutor();

    await expect(runPromise).resolves.toBeUndefined();
    await drain();

    const run = await getTalkRunById(runId);
    expect(run?.status).toBe('cancelled');
  });

  it('promotes the next ordered sibling after a run completes', async () => {
    const groupId = '0c999999-1111-1111-1111-111111111111';
    const first = await setupRun({
      sequenceIndex: 0,
      responseGroupId: groupId,
    });
    const second = await setupRun({
      sequenceIndex: 1,
      responseGroupId: groupId,
    });

    const dispatched: string[] = [];
    const { ctx, drain } = makeMockCtx();
    const env: DbScopeEnvBindings = {};
    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await processTalkRunMessage({
        runId: first.runId,
        executor: makeMockExecutor({ output: { content: 'step 0 done' } }),
        cancelPollIntervalMs: 50_000,
        dispatch: async ({ runId }) => {
          dispatched.push(runId);
        },
      });
    });
    await drain();

    expect(await getTalkRunById(first.runId).then((r) => r?.status)).toBe(
      'completed',
    );
    expect(dispatched).toEqual([second.runId]);
  });

  it('promotes the next ordered sibling even when the run FAILS (the bug fix)', async () => {
    const groupId = '0c999999-2222-2222-2222-222222222222';
    const first = await setupRun({
      sequenceIndex: 0,
      responseGroupId: groupId,
    });
    const second = await setupRun({
      sequenceIndex: 1,
      responseGroupId: groupId,
    });

    const dispatched: string[] = [];
    const { ctx, drain } = makeMockCtx();
    const env: DbScopeEnvBindings = {};
    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await processTalkRunMessage({
        runId: first.runId,
        executor: makeMockExecutor({
          throwError: new Error(
            'provider.nvidia upstream timed out (HTTP 524 <none>)',
          ),
        }),
        cancelPollIntervalMs: 50_000,
        dispatch: async ({ runId }) => {
          dispatched.push(runId);
        },
      });
    });
    await drain();

    // The failed step must not strand its siblings — the next one is woken.
    expect(await getTalkRunById(first.runId).then((r) => r?.status)).toBe(
      'failed',
    );
    expect(dispatched).toEqual([second.runId]);
  });

  it('does not promote when the finished run is the last ordered step', async () => {
    const groupId = '0c999999-3333-3333-3333-333333333333';
    // Lower sibling already terminal so the last step is claimable.
    await setupRun({
      sequenceIndex: 0,
      responseGroupId: groupId,
      status: 'completed',
    });
    const last = await setupRun({ sequenceIndex: 1, responseGroupId: groupId });

    const dispatched: string[] = [];
    const { ctx, drain } = makeMockCtx();
    const env: DbScopeEnvBindings = {};
    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await processTalkRunMessage({
        runId: last.runId,
        executor: makeMockExecutor({ output: { content: 'final step' } }),
        cancelPollIntervalMs: 50_000,
        dispatch: async ({ runId }) => {
          dispatched.push(runId);
        },
      });
    });
    await drain();

    expect(dispatched).toEqual([]);
  });

  it('does not promote for a non-ordered (panel/single) run', async () => {
    const { runId } = await setupRun(); // no responseGroupId, no sequenceIndex

    const dispatched: string[] = [];
    const { ctx, drain } = makeMockCtx();
    const env: DbScopeEnvBindings = {};
    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await processTalkRunMessage({
        runId,
        executor: makeMockExecutor({ output: { content: 'solo' } }),
        cancelPollIntervalMs: 50_000,
        dispatch: async ({ runId: nextId }) => {
          dispatched.push(nextId);
        },
      });
    });
    await drain();

    expect(dispatched).toEqual([]);
  });
});

describe('processDlqMessage', () => {
  it('flips a queued run to failed with dlq_exhausted and emits talk_run_failed', async () => {
    const { runId, talkId } = await setupRun({ status: 'queued' });

    await processDlqMessage({ runId });

    const run = await getTalkRunById(runId);
    expect(run?.status).toBe('failed');
    expect(run?.cancel_reason).toContain('dlq_exhausted');

    const events = await getOutboxEventsForTopics([`talk:${talkId}`], 0);
    const failed = events.find((e) => e.event_type === 'talk_run_failed');
    expect(failed).toBeTruthy();
    expect((failed?.payload as { errorCode?: string }).errorCode).toBe(
      'dlq_exhausted',
    );
  });

  it('flips a running run to failed', async () => {
    const { runId } = await setupRun({ status: 'running' });
    await processDlqMessage({ runId });
    const run = await getTalkRunById(runId);
    expect(run?.status).toBe('failed');
  });

  it('is a no-op on an already-terminal run', async () => {
    const { runId } = await setupRun({ status: 'completed' });
    await processDlqMessage({ runId });
    const run = await getTalkRunById(runId);
    expect(run?.status).toBe('completed');
  });

  it('is a no-op for a missing runId', async () => {
    await expect(
      processDlqMessage({ runId: '11111111-1111-1111-1111-111111111111' }),
    ).resolves.toBeUndefined();
  });
});
