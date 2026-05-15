import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import {
  closePgDatabase,
  type DbScopeEnvBindings,
  flushNotifyQueue,
  flushNotifyQueueForOwner,
  getCurrentNotifyQueue,
  getDbPg,
  getOutOfBandSql,
  initPgDatabase,
  type NotifyQueueEntry,
  type RequestExecutionContext,
  type Sql,
  withDurableObjectScopedDb,
  withNotifyQueueScope,
  withRequestScopedDb,
} from './db.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';

beforeAll(async () => {
  await initPgDatabase({ url: TEST_DB_URL });
});

afterAll(async () => {
  await closePgDatabase();
});

function makeMockEventHub(): {
  env: DbScopeEnvBindings;
  fetchCalls: Array<{ url: string; body: string; ownerId: string }>;
  responses: Array<Response | Error>;
} {
  const fetchCalls: Array<{ url: string; body: string; ownerId: string }> = [];
  const responses: Array<Response | Error> = [];
  const namespace = {
    idFromName: (name: string) =>
      ({ __brand: 'UserEventHubId' as const, __name: name }) as never,
    get: (id: never) => ({
      fetch: async (input: Request | URL | string) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const body =
          input instanceof Request ? await input.text() : '<no body>';
        fetchCalls.push({
          url,
          body,
          ownerId: (id as unknown as { __name: string }).__name,
        });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next ?? new Response(null, { status: 200 });
      },
    }),
  };
  return { env: { USER_EVENT_HUB: namespace }, fetchCalls, responses };
}

describe('requestScopedDbStorage shape', () => {
  it('carries { sql, ctx, env } through getDbPg() correctly', async () => {
    const env: DbScopeEnvBindings = { DB_EVENT_HUB_URL: 'env-marker-url' };
    await withRequestScopedDb(TEST_DB_URL, null, env, async (sql) => {
      expect(getDbPg()).toBe(sql);
      const oob = getOutOfBandSql();
      expect(oob).not.toBe(sql);
    });
  });
});

describe('getCurrentNotifyQueue', () => {
  it('returns null outside any scope', () => {
    expect(getCurrentNotifyQueue()).toBeNull();
  });

  it('returns a bare NotifyQueueEntry[] inside withNotifyQueueScope', async () => {
    let inside: unknown = null;
    await withNotifyQueueScope(null, null, async () => {
      inside = getCurrentNotifyQueue();
    });
    expect(Array.isArray(inside)).toBe(true);
    expect((inside as unknown[]).length).toBe(0);
  });
});

describe('withDurableObjectScopedDb', () => {
  it('lets getDbPg() see the caller-provided sql', async () => {
    const sql = postgres(TEST_DB_URL, { max: 1, prepare: false });
    try {
      let inside: Sql | null = null;
      await withDurableObjectScopedDb(sql, async () => {
        inside = getDbPg();
      });
      expect(inside).toBe(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('withRequestScopedDb', () => {
  it('works with ctx=null and env=null (node fallback path)', async () => {
    let rowsObserved: { ok: number }[] | null = null;
    await withRequestScopedDb(TEST_DB_URL, null, null, async (sql) => {
      rowsObserved = await sql<{ ok: number }[]>`select 1 as ok`;
    });
    expect(rowsObserved).toEqual([{ ok: 1 }]);
  });
});

describe('withNotifyQueueScope', () => {
  it('opens a queue inside fn and flushes once via ctx.waitUntil (G3)', async () => {
    const waitUntilCalls: Promise<unknown>[] = [];
    const ctx: RequestExecutionContext = {
      waitUntil: (p) => {
        waitUntilCalls.push(p);
      },
    };
    const { env, fetchCalls } = makeMockEventHub();
    let observedQueue: unknown = 'unset';
    await withNotifyQueueScope(env, ctx, async () => {
      observedQueue = getCurrentNotifyQueue();
      (observedQueue as NotifyQueueEntry[]).push({
        topic: 'talk:t1',
        eventId: 7,
        ownerIds: ['user-A'],
      });
    });
    expect(Array.isArray(observedQueue)).toBe(true);
    expect(getCurrentNotifyQueue()).toBeNull();
    expect(waitUntilCalls).toHaveLength(1);
    await waitUntilCalls[0];
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.ownerId).toBe('user-A');
    expect(JSON.parse(fetchCalls[0]!.body)).toEqual({
      entries: [{ topic: 'talk:t1', eventId: 7 }],
    });
  });

  it('treats nested scopes as pass-through (F7 — outermost owns the queue)', async () => {
    const { env, fetchCalls } = makeMockEventHub();
    let outerQueue: unknown = null;
    let innerQueue: unknown = null;
    await withNotifyQueueScope(env, null, async () => {
      outerQueue = getCurrentNotifyQueue();
      (outerQueue as NotifyQueueEntry[]).push({
        topic: 'talk:t1',
        eventId: 1,
        ownerIds: ['user-A'],
      });
      await withNotifyQueueScope(env, null, async () => {
        innerQueue = getCurrentNotifyQueue();
        (innerQueue as NotifyQueueEntry[]).push({
          topic: 'talk:t1',
          eventId: 2,
          ownerIds: ['user-A'],
        });
      });
    });
    expect(innerQueue).toBe(outerQueue);
    expect(fetchCalls).toHaveLength(1);
    expect(JSON.parse(fetchCalls[0]!.body)).toEqual({
      entries: [
        { topic: 'talk:t1', eventId: 1 },
        { topic: 'talk:t1', eventId: 2 },
      ],
    });
  });
});

describe('getOutOfBandSql', () => {
  it('returns a separate sql from getDbPg() inside withRequestScopedDb (G1)', async () => {
    await withRequestScopedDb(TEST_DB_URL, null, null, async (sql) => {
      const oob = getOutOfBandSql();
      expect(oob).not.toBe(sql);
      const mainRows = await sql<{ tag: string }[]>`select 'main' as tag`;
      const oobRows = await oob<{ tag: string }[]>`select 'oob' as tag`;
      expect(mainRows).toEqual([{ tag: 'main' }]);
      expect(oobRows).toEqual([{ tag: 'oob' }]);
    });
  });

  it('falls back to nodeScopedDb outside any scope (Node mode)', async () => {
    const oob = getOutOfBandSql();
    const rows = await oob<{ ok: number }[]>`select 1 as ok`;
    expect(rows).toEqual([{ ok: 1 }]);
  });
});

describe('flushNotifyQueue', () => {
  it('groups by ownerId; one POST per owner', async () => {
    const { env, fetchCalls } = makeMockEventHub();
    const queue: NotifyQueueEntry[] = [
      { topic: 'talk:t1', eventId: 1, ownerIds: ['user-A'] },
      { topic: 'talk:t1', eventId: 2, ownerIds: ['user-A', 'user-B'] },
      { topic: 'user:user-B', eventId: 3, ownerIds: ['user-B'] },
    ];
    await flushNotifyQueue(queue, env);
    expect(fetchCalls).toHaveLength(2);
    const ownerToBody = new Map(
      fetchCalls.map((c) => [c.ownerId, JSON.parse(c.body)]),
    );
    expect(ownerToBody.get('user-A')).toEqual({
      entries: [
        { topic: 'talk:t1', eventId: 1 },
        { topic: 'talk:t1', eventId: 2 },
      ],
    });
    expect(ownerToBody.get('user-B')).toEqual({
      entries: [
        { topic: 'talk:t1', eventId: 2 },
        { topic: 'user:user-B', eventId: 3 },
      ],
    });
  });

  it('retries on 500 then succeeds (D1)', async () => {
    const { env, fetchCalls, responses } = makeMockEventHub();
    responses.push(new Response(null, { status: 500 }));
    responses.push(new Response(null, { status: 200 }));
    const t0 = Date.now();
    await flushNotifyQueueForOwner(
      'user-X',
      [{ topic: 'talk:t1', eventId: 1, ownerIds: ['user-X'] }],
      env,
    );
    const elapsed = Date.now() - t0;
    expect(fetchCalls).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });

  it('429 is terminal-success (no retry)', async () => {
    const { env, fetchCalls, responses } = makeMockEventHub();
    responses.push(new Response(null, { status: 429 }));
    await flushNotifyQueueForOwner(
      'user-X',
      [{ topic: 'talk:t1', eventId: 1, ownerIds: ['user-X'] }],
      env,
    );
    expect(fetchCalls).toHaveLength(1);
  });

  it('no-ops when env.USER_EVENT_HUB is missing', async () => {
    await flushNotifyQueue(
      [{ topic: 'talk:t1', eventId: 1, ownerIds: ['user-A'] }],
      null,
    );
  });

  it('no-ops when the queue is empty', async () => {
    const { env, fetchCalls } = makeMockEventHub();
    await flushNotifyQueue([], env);
    expect(fetchCalls).toHaveLength(0);
  });
});
