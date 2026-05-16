// UserEventHub unit tests. Drives the DO class with a MockDurableObjectState
// and MockWebSocket against the live local Supabase. Requires:
//   - `supabase status` running on 127.0.0.1:54432
//
// We point `DB_EVENT_HUB_URL` at the *admin* connection string for the
// tests, NOT the `clawtalk_event_hub` role. The role grant + password
// flow is a production deployment concern (see migrations 0005/0006 +
// the predeploy gate); these tests exercise the DO's READ/FILTER/SEND/
// CURSOR logic, which is independent of which login role runs the SELECT.
// CI doesn't have the role's password set (the migration deliberately
// omits it for security), and adding a test-only ALTER ROLE step here
// is more brittle than just sidestepping the role entirely.
//
// `WebSocketPair` and Response.webSocket are Cloudflare workerd globals,
// so the upgrade-handshake parts (101 returns, WS handshake) are not
// exercised here — those are validated by the U0 prototype's e2e tests.
// What we test here is the OUTBOX READ + FILTER + SEND + CURSOR logic
// inside replayInto + drainOnce.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import { closePgDatabase, initPgDatabase } from '../../db.js';
import { appendOutboxEvent } from '../db/accessors.js';
import {
  buildAttachmentFilter,
  type SocketAttachment,
  UserEventHub,
  type UserEventHubEnv,
} from './user-event-hub.js';

const ADMIN_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';

const TEST_TOPIC_PREFIX = 'do-test-';
const TEST_USER = '00000000-0000-0000-0000-0000000000a3';

// ─── Mock WebSocket ────────────────────────────────────────────────────

class MockWebSocket {
  attachment: SocketAttachment | null = null;
  sent: Array<{ event: string; data: unknown; id: number }> = [];
  closed: { code?: number; reason?: string } | null = null;
  bufferedAmount = 0;

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value as SocketAttachment;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  setBackpressure(bytes: number): void {
    this.bufferedAmount = bytes;
  }

  setJwtExpired(): void {
    if (!this.attachment) return;
    this.attachment = { ...this.attachment, jwtExp: 1 }; // far in the past
  }
}

// ─── Mock DurableObjectState ───────────────────────────────────────────

class MockDurableObjectState {
  readonly id: { readonly name?: string };
  alarms: Array<number | Date> = [];
  blockConcurrencyWhileCalls = 0;
  blockConcurrencyWhileActive = 0;
  blockConcurrencyWhileMaxConcurrent = 0;

  private sockets: MockWebSocket[] = [];
  // Workerd's blockConcurrencyWhile serializes overlapping calls
  // (the lock is "the next caller waits until the prior fn() resolves").
  // We emulate that with a chained-promise queue so the F9 test can
  // observe actual serialization.
  private mutex: Promise<unknown> = Promise.resolve();

  constructor(name = TEST_USER) {
    this.id = { name };
  }

  attach(ws: MockWebSocket): void {
    this.sockets.push(ws);
  }

  acceptWebSocket(_ws: never): void {
    // Tests bypass the upgrade flow.
  }

  getWebSockets(_tag?: string): MockWebSocket[] {
    return this.sockets.filter((ws) => ws.closed === null);
  }

  async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    this.blockConcurrencyWhileCalls += 1;
    const next = this.mutex.then(async () => {
      this.blockConcurrencyWhileActive += 1;
      this.blockConcurrencyWhileMaxConcurrent = Math.max(
        this.blockConcurrencyWhileMaxConcurrent,
        this.blockConcurrencyWhileActive,
      );
      try {
        return await fn();
      } finally {
        this.blockConcurrencyWhileActive -= 1;
      }
    });
    this.mutex = next.catch(() => undefined);
    return next as Promise<T>;
  }

  storage = {
    setAlarm: async (when: number | Date): Promise<void> => {
      this.alarms.push(when);
    },
    deleteAlarm: async (): Promise<void> => {
      this.alarms = [];
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

let nextTopicSeq = 0;
function uniqueTopic(): string {
  return `${TEST_TOPIC_PREFIX}${++nextTopicSeq}-${crypto.randomUUID()}`;
}

function makeAttachment(input: {
  scope: 'user' | 'talk';
  topic: string;
  threadId?: string | null;
  cursor?: number;
  jwtExpSec?: number;
}): SocketAttachment {
  return {
    scope: input.scope,
    userId: TEST_USER,
    talkId: input.scope === 'talk' ? 'talk-fixture' : null,
    threadId: input.threadId ?? null,
    topic: input.topic,
    cursor: input.cursor ?? 0,
    jwtExp: input.jwtExpSec ?? Math.floor(Date.now() / 1000) + 3600,
    connectedAtMs: Date.now(),
  };
}

async function seedOutbox(
  topic: string,
  events: Array<{ event_type: string; payload: Record<string, unknown> }>,
): Promise<number[]> {
  const ids: number[] = [];
  for (const ev of events) {
    const id = await appendOutboxEvent({
      topic,
      eventType: ev.event_type,
      payload: ev.payload,
    });
    ids.push(id);
  }
  return ids;
}

async function pruneTestRows(): Promise<void> {
  const adminSql = postgres(ADMIN_DB_URL, { max: 1, prepare: false });
  try {
    await adminSql`delete from public.event_outbox where topic like ${TEST_TOPIC_PREFIX + '%'}`;
  } finally {
    await adminSql.end({ timeout: 1 });
  }
}

// ─── Test setup ────────────────────────────────────────────────────────

beforeAll(async () => {
  await initPgDatabase({ url: ADMIN_DB_URL });
  await pruneTestRows();
});

afterEach(async () => {
  await pruneTestRows();
});

afterAll(async () => {
  await closePgDatabase();
});

const ENV: UserEventHubEnv = { DB_EVENT_HUB_URL: ADMIN_DB_URL };

function createHub(state: MockDurableObjectState): UserEventHub {
  // The DO class accepts our MockDurableObjectState through the
  // structural `DurableObjectStateLike` typing.
  return new UserEventHub(state as never, ENV);
}

// ─── Filter tests (pure) ───────────────────────────────────────────────

describe('buildAttachmentFilter', () => {
  it('user-scope: matches everything (no filter)', () => {
    const att = makeAttachment({ scope: 'user', topic: 'user:abc' });
    const filter = buildAttachmentFilter(att);
    expect(
      filter({
        event_id: 1,
        topic: 'user:abc',
        event_type: 'message_appended',
        payload: { runKind: 'job', threadId: 'unrelated' },
        created_at: '',
      }),
    ).toBe(true);
  });

  it('talk-scope without threadId: conversation-run filter only', () => {
    const att = makeAttachment({ scope: 'talk', topic: 'talk:t1' });
    const filter = buildAttachmentFilter(att);
    expect(
      filter({
        event_id: 1,
        topic: 'talk:t1',
        event_type: 'talk_run_started',
        payload: { runKind: 'job' },
        created_at: '',
      }),
    ).toBe(false);
    expect(
      filter({
        event_id: 1,
        topic: 'talk:t1',
        event_type: 'talk_run_started',
        payload: { runKind: 'conversation' },
        created_at: '',
      }),
    ).toBe(true);
  });

  it('talk-scope with threadId: also applies thread filter', () => {
    const att = makeAttachment({
      scope: 'talk',
      topic: 'talk:t1',
      threadId: 'thread-A',
    });
    const filter = buildAttachmentFilter(att);
    expect(
      filter({
        event_id: 1,
        topic: 'talk:t1',
        event_type: 'talk_response_delta',
        payload: { threadId: 'thread-A' },
        created_at: '',
      }),
    ).toBe(true);
    expect(
      filter({
        event_id: 1,
        topic: 'talk:t1',
        event_type: 'talk_response_delta',
        payload: { threadId: 'thread-B' },
        created_at: '',
      }),
    ).toBe(false);
  });
});

// ─── drainOnce — fan-out + cursor + lifecycle ─────────────────────────

describe('drainOnce via /notify', () => {
  it('fans out 3 events to 3 sockets on same topic; advances each cursor', async () => {
    const state = new MockDurableObjectState();
    const topic = uniqueTopic();
    const ids = await seedOutbox(topic, [
      { event_type: 'message_appended', payload: { i: 1 } },
      { event_type: 'message_appended', payload: { i: 2 } },
      { event_type: 'message_appended', payload: { i: 3 } },
    ]);
    const sockets = [
      new MockWebSocket(),
      new MockWebSocket(),
      new MockWebSocket(),
    ];
    for (const ws of sockets) {
      ws.serializeAttachment(makeAttachment({ scope: 'user', topic }));
      state.attach(ws);
    }

    const hub = createHub(state);
    const res = await hub.fetch(
      new Request('http://hub/notify', { method: 'POST' }),
    );
    expect(res.status).toBe(200);

    for (const ws of sockets) {
      expect(ws.sent.map((m) => m.id)).toEqual(ids);
      expect(ws.attachment?.cursor).toBe(ids[2]);
    }
    // R4: every notify schedules an alarm 30s out.
    expect(state.alarms).toHaveLength(1);
  });

  it('drains a large backlog in batches (R5 — reads until rows < limit)', async () => {
    const state = new MockDurableObjectState();
    const topic = uniqueTopic();
    const events = Array.from({ length: 250 }, (_, i) => ({
      event_type: 'message_appended',
      payload: { i },
    }));
    const ids = await seedOutbox(topic, events);

    const ws = new MockWebSocket();
    ws.serializeAttachment(makeAttachment({ scope: 'user', topic }));
    state.attach(ws);

    const hub = createHub(state);
    await hub.fetch(new Request('http://hub/notify', { method: 'POST' }));
    expect(ws.sent).toHaveLength(250);
    expect(ws.sent[0]!.id).toBe(ids[0]);
    expect(ws.sent[249]!.id).toBe(ids[249]);
  });

  it('closes socket on JWT expiry (R8) before drain', async () => {
    const state = new MockDurableObjectState();
    const topic = uniqueTopic();
    await seedOutbox(topic, [{ event_type: 'message_appended', payload: {} }]);

    const expiredWs = new MockWebSocket();
    expiredWs.serializeAttachment(
      makeAttachment({ scope: 'user', topic, jwtExpSec: 1 }),
    );
    const liveWs = new MockWebSocket();
    liveWs.serializeAttachment(makeAttachment({ scope: 'user', topic }));
    state.attach(expiredWs);
    state.attach(liveWs);

    const hub = createHub(state);
    await hub.fetch(new Request('http://hub/notify', { method: 'POST' }));
    expect(expiredWs.closed?.code).toBe(4401);
    expect(liveWs.sent).toHaveLength(1);
  });

  it('closes socket on backpressure (R9 — bufferedAmount > 1MB)', async () => {
    const state = new MockDurableObjectState();
    const topic = uniqueTopic();
    await seedOutbox(topic, [{ event_type: 'message_appended', payload: {} }]);

    const slowWs = new MockWebSocket();
    slowWs.setBackpressure(2_000_000);
    slowWs.serializeAttachment(makeAttachment({ scope: 'user', topic }));
    state.attach(slowWs);

    const hub = createHub(state);
    await hub.fetch(new Request('http://hub/notify', { method: 'POST' }));
    expect(slowWs.closed?.code).toBe(1011);
    expect(slowWs.sent).toHaveLength(0);
  });

  it('respects per-socket cursor (skip rows with event_id ≤ cursor)', async () => {
    const state = new MockDurableObjectState();
    const topic = uniqueTopic();
    const ids = await seedOutbox(topic, [
      { event_type: 'message_appended', payload: { i: 1 } },
      { event_type: 'message_appended', payload: { i: 2 } },
      { event_type: 'message_appended', payload: { i: 3 } },
    ]);

    // Socket has already seen ids[0], wants only ids[1]+.
    const ws = new MockWebSocket();
    ws.serializeAttachment(
      makeAttachment({ scope: 'user', topic, cursor: ids[0] }),
    );
    state.attach(ws);

    const hub = createHub(state);
    await hub.fetch(new Request('http://hub/notify', { method: 'POST' }));
    expect(ws.sent.map((m) => m.id)).toEqual([ids[1], ids[2]]);
  });

  it('thread filter: talk-scope socket with threadId only sees matching rows', async () => {
    const state = new MockDurableObjectState();
    const topic = uniqueTopic();
    const allIds = await seedOutbox(topic, [
      {
        event_type: 'talk_response_delta',
        payload: { threadId: 'thread-A', i: 1 },
      },
      {
        event_type: 'talk_response_delta',
        payload: { threadId: 'thread-B', i: 2 },
      },
      {
        event_type: 'talk_response_delta',
        payload: { threadId: 'thread-A', i: 3 },
      },
    ]);

    const ws = new MockWebSocket();
    ws.serializeAttachment(
      makeAttachment({ scope: 'talk', topic, threadId: 'thread-A' }),
    );
    state.attach(ws);

    const hub = createHub(state);
    await hub.fetch(new Request('http://hub/notify', { method: 'POST' }));
    expect(ws.sent.map((m) => m.id)).toEqual([allIds[0], allIds[2]]);
  });
});

// ─── handleNotify behavior ─────────────────────────────────────────────

describe('handleNotify', () => {
  it('schedules alarm 30s out on every notify (R4)', async () => {
    const state = new MockDurableObjectState();
    const hub = createHub(state);
    const before = Date.now();
    await hub.fetch(new Request('http://hub/notify', { method: 'POST' }));
    expect(state.alarms).toHaveLength(1);
    const scheduled = state.alarms[0] as number;
    expect(scheduled).toBeGreaterThanOrEqual(before + 30_000 - 100);
    expect(scheduled).toBeLessThanOrEqual(before + 30_000 + 1_000);
  });

  it('blockConcurrencyWhile serializes two parallel /notify (F9)', async () => {
    const state = new MockDurableObjectState();
    const hub = createHub(state);
    await Promise.all([
      hub.fetch(new Request('http://hub/notify', { method: 'POST' })),
      hub.fetch(new Request('http://hub/notify', { method: 'POST' })),
    ]);
    expect(state.blockConcurrencyWhileCalls).toBeGreaterThanOrEqual(2);
    // Both must serialize — max concurrent should never exceed 1
    // (our mock counts overlapping entries by waiting for fn() to resolve).
    expect(state.blockConcurrencyWhileMaxConcurrent).toBe(1);
  });
});

// ─── alarm() catch-up ──────────────────────────────────────────────────

describe('alarm()', () => {
  it('drains pending events on alarm fire', async () => {
    const state = new MockDurableObjectState();
    const topic = uniqueTopic();
    const ws = new MockWebSocket();
    ws.serializeAttachment(makeAttachment({ scope: 'user', topic }));
    state.attach(ws);

    // No events when /notify fires — drain finds nothing.
    const hub = createHub(state);
    await hub.fetch(new Request('http://hub/notify', { method: 'POST' }));
    expect(ws.sent).toHaveLength(0);

    // A late event arrives AFTER the drain. Alarm should catch it.
    await seedOutbox(topic, [
      { event_type: 'message_appended', payload: { late: true } },
    ]);
    await hub.alarm();
    expect(ws.sent).toHaveLength(1);
  });
});

// ─── /upgrade — only the testable bits without WebSocketPair ──────────

describe('handleUpgrade pre-accept guards', () => {
  it('returns 426 when not a WebSocket upgrade', async () => {
    const state = new MockDurableObjectState();
    const hub = createHub(state);
    const res = await hub.fetch(
      new Request('http://hub/upgrade', { method: 'GET' }),
    );
    expect(res.status).toBe(426);
  });

  it('returns 400 when auth headers are missing', async () => {
    const state = new MockDurableObjectState();
    const hub = createHub(state);
    const res = await hub.fetch(
      new Request('http://hub/upgrade', {
        method: 'GET',
        headers: { Upgrade: 'websocket' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 403 on cross-DO id mismatch (D8)', async () => {
    const state = new MockDurableObjectState('user-A');
    const hub = createHub(state);
    const res = await hub.fetch(
      new Request('http://hub/upgrade', {
        method: 'GET',
        headers: {
          Upgrade: 'websocket',
          'x-clawtalk-userid': 'user-B',
          'x-clawtalk-topic': 'user:user-B',
          'x-clawtalk-scope': 'user',
        },
      }),
    );
    expect(res.status).toBe(403);
  });
});

// ─── fetch routing ─────────────────────────────────────────────────────

describe('fetch routing (F11)', () => {
  it('only /upgrade and /notify match — others are 404', async () => {
    const state = new MockDurableObjectState();
    const hub = createHub(state);
    const res = await hub.fetch(
      new Request('http://hub/not-a-route', { method: 'GET' }),
    );
    expect(res.status).toBe(404);
  });
});
