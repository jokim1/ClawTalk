import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  type DbScopeEnvBindings,
  getDbPg,
  initPgDatabase,
  type RequestExecutionContext,
  withNotifyQueueScope,
  withRequestScopedDb,
  withUserContext,
} from '../../db.js';
import { getOutboxEventsForTopics } from '../db/accessors.js';
import { emitOutboxEvent, emitOutboxEventOutsideTx } from './outbox-emit.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const OUTBOX_TOPIC_PREFIXES = ['talk-', 'talk-streaming-', 'startup-'];

beforeAll(async () => {
  await initPgDatabase({ url: TEST_DB_URL });
});

afterAll(async () => {
  // Sweep any rows this suite inserted so neighboring tests (e.g.
  // accessors.test.ts's prune assertions) see a clean event_outbox.
  const db = getDbPg();
  for (const prefix of OUTBOX_TOPIC_PREFIXES) {
    await db`delete from public.event_outbox where topic like ${prefix + '%'}`;
  }
  await closePgDatabase();
});

interface MockHub {
  env: DbScopeEnvBindings;
  fetchCalls: Array<{ ownerId: string; body: string }>;
  responses: Array<Response | Error>;
}

function makeMockEventHub(): MockHub {
  const fetchCalls: MockHub['fetchCalls'] = [];
  const responses: MockHub['responses'] = [];
  const namespace = {
    idFromName: (name: string) =>
      ({ __brand: 'UserEventHubId' as const, __name: name }) as never,
    get: (id: never) => ({
      fetch: async (input: Request | URL | string) => {
        const body =
          input instanceof Request ? await input.text() : '<no body>';
        fetchCalls.push({
          ownerId: (id as unknown as { __name: string }).__name,
          body,
        });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next ?? new Response(null, { status: 200 });
      },
    }),
  };
  return { env: { USER_EVENT_HUB: namespace }, fetchCalls, responses };
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

function uniqueTopic(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function uniqueUserId(): string {
  return crypto.randomUUID();
}

describe('emitOutboxEvent (in-tx path)', () => {
  it('fires the notify only AFTER withUserContext db.begin resolves (G1 in-tx)', async () => {
    const { env, fetchCalls } = makeMockEventHub();
    const { ctx, drain } = makeMockCtx();
    const userId = uniqueUserId();
    const topic = uniqueTopic('talk');

    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await withUserContext(userId, async () => {
        await emitOutboxEvent({
          topic,
          eventType: 'talk_run_queued',
          payload: { sentinel: 'mid-tx' },
          ownerIds: [userId],
        });
        // Inside the tx, notify must NOT have fired yet.
        expect(fetchCalls).toHaveLength(0);
      });
    });
    // After db.begin resolves, the flush is scheduled via ctx.waitUntil.
    // We drain it to assert the post-commit notify fired exactly once.
    await drain();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.ownerId).toBe(userId);
    expect(JSON.parse(fetchCalls[0]!.body).entries).toHaveLength(1);
    expect(JSON.parse(fetchCalls[0]!.body).entries[0].topic).toBe(topic);
  });

  it('batches two emits to one owner into one fetch (D4 + queue mechanics)', async () => {
    const { env, fetchCalls } = makeMockEventHub();
    const { ctx, drain } = makeMockCtx();
    const userId = uniqueUserId();
    const topic = uniqueTopic('talk');

    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await withUserContext(userId, async () => {
        await emitOutboxEvent({
          topic,
          eventType: 'message_appended',
          payload: { i: 1 },
          ownerIds: [userId],
        });
        await emitOutboxEvent({
          topic,
          eventType: 'message_appended',
          payload: { i: 2 },
          ownerIds: [userId],
        });
      });
    });
    await drain();
    expect(fetchCalls).toHaveLength(1);
    const parsed = JSON.parse(fetchCalls[0]!.body);
    expect(parsed.entries).toHaveLength(2);
  });

  it('emits with two different owners → two POSTs at flush time', async () => {
    const { env, fetchCalls } = makeMockEventHub();
    const { ctx, drain } = makeMockCtx();
    const userA = uniqueUserId();
    const userB = uniqueUserId();
    const topic = uniqueTopic('talk');

    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await withUserContext(userA, async () => {
        await emitOutboxEvent({
          topic,
          eventType: 'message_appended',
          payload: { sentinel: 'shared' },
          // Single emit, two owners → fans out at flush time.
          ownerIds: [userA, userB],
        });
      });
    });
    await drain();
    expect(fetchCalls).toHaveLength(2);
    const owners = new Set(fetchCalls.map((c) => c.ownerId));
    expect(owners).toEqual(new Set([userA, userB]));
  });

  it('notify failure does NOT roll back the outbox INSERT', async () => {
    const { env, fetchCalls, responses } = makeMockEventHub();
    const { ctx, drain } = makeMockCtx();
    const userId = uniqueUserId();
    const topic = uniqueTopic('talk');
    // All 4 attempts (initial + 3 retries) fail.
    responses.push(new Response(null, { status: 500 }));
    responses.push(new Response(null, { status: 500 }));
    responses.push(new Response(null, { status: 500 }));
    responses.push(new Response(null, { status: 500 }));

    let eventId: number | null = null;
    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await withUserContext(userId, async () => {
        eventId = await emitOutboxEvent({
          topic,
          eventType: 'talk_run_failed',
          payload: { sentinel: 'durable' },
          ownerIds: [userId],
        });
      });
    });
    await drain();
    // Notify retried + ultimately failed.
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    // INSERT is durable — the row exists in the outbox.
    expect(eventId).not.toBeNull();
    const rows = await getOutboxEventsForTopics([topic], 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe(eventId);
  });

  it('without a queue scope: INSERT still lands (no notify path remaining)', async () => {
    // After U6 the Node-mode in-process SSE notifier is gone; there is
    // no scope-less notify path. The outbox INSERT must still succeed
    // — a missing scope is a caller bug, not a data-loss bug.
    const topic = uniqueTopic('startup');
    const eventId = await emitOutboxEvent({
      topic,
      eventType: 'talk_run_failed',
      payload: { sentinel: 'startup' },
      ownerIds: [],
    });
    expect(eventId).toBeGreaterThan(0);
    const rows = await getOutboxEventsForTopics([topic], 0);
    expect(rows).toHaveLength(1);
  });

  it('reuses the outer queue across nested withUserContext (F7)', async () => {
    const { env, fetchCalls } = makeMockEventHub();
    const { ctx, drain } = makeMockCtx();
    const userId = uniqueUserId();
    const topic = uniqueTopic('talk');

    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await withUserContext(userId, async () => {
        await emitOutboxEvent({
          topic,
          eventType: 'message_appended',
          payload: { i: 1 },
          ownerIds: [userId],
        });
        await withUserContext(userId, async () => {
          // Same userId; reuses outer tx + outer queue.
          await emitOutboxEvent({
            topic,
            eventType: 'message_appended',
            payload: { i: 2 },
            ownerIds: [userId],
          });
        });
      });
    });
    await drain();
    // One flush, two entries.
    expect(fetchCalls).toHaveLength(1);
    expect(JSON.parse(fetchCalls[0]!.body).entries).toHaveLength(2);
  });

  it('withNotifyQueueScope wrap + nested withUserContext: outer owns flush (G3)', async () => {
    const { env, fetchCalls } = makeMockEventHub();
    const { ctx, drain } = makeMockCtx();
    const userA = uniqueUserId();
    const userB = uniqueUserId();
    const topic = uniqueTopic('talk');

    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await withNotifyQueueScope(env, ctx, async () => {
        await withUserContext(userA, async () => {
          await emitOutboxEvent({
            topic,
            eventType: 'talk_run_started',
            payload: { i: 'A' },
            ownerIds: [userA],
          });
        });
        await withUserContext(userB, async () => {
          await emitOutboxEvent({
            topic,
            eventType: 'talk_run_started',
            payload: { i: 'B' },
            ownerIds: [userB],
          });
        });
      });
    });
    await drain();
    expect(fetchCalls).toHaveLength(2);
    const owners = new Set(fetchCalls.map((c) => c.ownerId));
    expect(owners).toEqual(new Set([userA, userB]));
  });
});

describe('emitOutboxEventOutsideTx (G1 streaming path)', () => {
  it('INSERT is visible from a separate connection BEFORE the outer tx commits', async () => {
    // The acceptance test for G1: streaming events committed via the
    // out-of-band sql must be visible mid-run, not at run end.
    const { env } = makeMockEventHub();
    const userId = uniqueUserId();
    const topic = uniqueTopic('talk-streaming');
    let oobEventId: number | null = null;
    let oobRowSeenMidTx = false;

    await withRequestScopedDb(TEST_DB_URL, null, env, async () => {
      await withUserContext(userId, async () => {
        oobEventId = await emitOutboxEventOutsideTx({
          topic,
          eventType: 'talk_response_delta',
          payload: { i: 1 },
          ownerIds: [userId],
        });
        // SELECT via the module-scoped sql (separate connection from
        // the userContext tx). The OOB row must be visible.
        const rows = await getOutboxEventsForTopics([topic], 0);
        oobRowSeenMidTx = rows.some((r) => r.event_id === oobEventId);
      });
    });
    expect(oobEventId).not.toBeNull();
    expect(oobRowSeenMidTx).toBe(true);
  });

  it('coalesces multiple rapid emits into one fetch within ~50ms (G7)', async () => {
    const { env, fetchCalls } = makeMockEventHub();
    const { ctx, drain } = makeMockCtx();
    const userId = uniqueUserId();
    const topic = uniqueTopic('talk-streaming');

    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      // Emit 10 streaming events back-to-back. The G7 coalescer should
      // batch them into one drain at ~50ms after the first emit.
      for (let i = 0; i < 10; i++) {
        await emitOutboxEventOutsideTx({
          topic,
          eventType: 'talk_response_delta',
          payload: { i },
          ownerIds: [userId],
        });
      }
      // Wait past the 50ms debounce window so the timer fires.
      await new Promise((r) => setTimeout(r, 100));
    });
    await drain();
    // Expect one fetch with 10 entries (one window catches them all).
    expect(fetchCalls).toHaveLength(1);
    const entries = JSON.parse(fetchCalls[0]!.body).entries;
    expect(entries).toHaveLength(10);
  });

  it('scope-exit flushes pending streaming-coalesce timers synchronously', async () => {
    const { env, fetchCalls } = makeMockEventHub();
    const { ctx, drain } = makeMockCtx();
    const userId = uniqueUserId();
    const topic = uniqueTopic('talk-streaming');

    await withRequestScopedDb(TEST_DB_URL, ctx, env, async () => {
      await emitOutboxEventOutsideTx({
        topic,
        eventType: 'talk_response_delta',
        payload: { i: 0 },
        ownerIds: [userId],
      });
      // Exit IMMEDIATELY — before the 50ms timer fires.
    });
    await drain();
    // The withRequestScopedDb finally block must clear the pending
    // timer + flush the entries synchronously so no notify orphans.
    expect(fetchCalls).toHaveLength(1);
    expect(JSON.parse(fetchCalls[0]!.body).entries).toHaveLength(1);
  });
});
