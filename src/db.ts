// clawtalk Phase 5 — Postgres data layer.
//
// Two execution modes share this code:
//
//   Node (`tsx src/server.ts`, local dev): single module-scoped
//   postgres.js client. Connections pooled in-client. tsx is a
//   long-lived process so this is fine.
//
//   Cloudflare Workers (`src/worker.ts`): per-request client via
//   `withRequestScopedDb`. Workers' I/O isolation rejects cross-request
//   sockets, so a module-scoped client throws on the second request.
//
// Per-user routes wrap accessor segments in `withUserContext(userId, fn)`
// which opens a transaction, downgrades to the `authenticated` role, and
// binds `request.jwt.claims->>'sub'` so `auth.uid()` returns the caller's
// userId. The 0002_rls_policies.sql migration enforces per-row ownership
// through these claims.
//
// Lookup chain in `getDbPg()`: userContext (inside withUserContext) →
// requestScoped (Worker) → nodeScoped (Node). Once inside a wrapped
// block, every accessor MUST use the tx — anything else silently bypasses
// RLS via the BYPASSRLS pooled connection.
//
// W7-evtsse adds three sibling ALS scopes opened inside
// `withRequestScopedDb`:
//   - `notifyQueueStorage` — bare `NotifyQueueEntry[]`. Producers push
//     entries via `emitOutboxEvent`; the scope owner (outermost
//     `withUserContext` or `withNotifyQueueScope`) flushes via
//     `flushNotifyQueue` after `db.begin` resolves.
//   - `outOfBandDbStorage` — lazy `OutOfBandSlot`. Streaming-emit
//     producers (G1) read it via `getOutOfBandSql()` to INSERT outbox
//     rows on a fresh auto-commit connection, sibling to the run's
//     surrounding tx.
//   - `streamingCoalesceStorage` — `Map<ownerId, PendingDrain>`.
//     Out-of-band notifies coalesce per (owner, ~50ms window). Owned
//     by `withRequestScopedDb`'s finally block (pending timers fired
//     synchronously on scope exit).

import { AsyncLocalStorage } from 'node:async_hooks';

import postgres from 'postgres';

export const DATABASE_URL_ENV = 'CLAWTALK_DATABASE_URL';
const LOCAL_FALLBACK_URL =
  'postgresql://postgres:postgres@127.0.0.1:54432/postgres';

let nodeScopedDb: postgres.Sql | null = null;

export type Sql = postgres.Sql;

// ─── DB-scope env bindings (minimal subset of Env) ──────────────────────
export interface DbScopeEnvBindings {
  DB_EVENT_HUB_URL?: string;
  USER_EVENT_HUB?: UserEventHubNamespace;
}

interface UserEventHubNamespace {
  idFromName(name: string): UserEventHubId;
  get(id: UserEventHubId): UserEventHubStub;
}
interface UserEventHubId {
  readonly __brand: 'UserEventHubId';
}
interface UserEventHubStub {
  fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>;
}

// ─── Notify queue entry (bare array on ALS) ─────────────────────────────
export interface NotifyQueueEntry {
  topic: string;
  eventId: number;
  ownerIds: string[];
}

// ─── Out-of-band sql slot (lazy) ────────────────────────────────────────
interface OutOfBandSlot {
  url: string;
  sql: postgres.Sql | null;
}

// ─── Streaming-coalesce per-owner pending drain ─────────────────────────
export interface PendingDrain {
  timer: ReturnType<typeof setTimeout> | null;
  entries: NotifyQueueEntry[];
}

// ─── ALS scopes ─────────────────────────────────────────────────────────

interface RequestScopedDbStore {
  sql: postgres.Sql;
  ctx: RequestExecutionContext | null;
  env: DbScopeEnvBindings | null;
}
const requestScopedDbStorage = new AsyncLocalStorage<RequestScopedDbStore>();

interface UserContextStore {
  tx: postgres.TransactionSql;
  userId: string;
}
const userContextStorage = new AsyncLocalStorage<UserContextStore>();

const notifyQueueStorage = new AsyncLocalStorage<NotifyQueueEntry[]>();
const outOfBandDbStorage = new AsyncLocalStorage<OutOfBandSlot>();
const streamingCoalesceStorage = new AsyncLocalStorage<
  Map<string, PendingDrain>
>();

function resolveDatabaseUrl(override?: string): string {
  return (
    override?.trim() ||
    process.env[DATABASE_URL_ENV]?.trim() ||
    LOCAL_FALLBACK_URL
  );
}

export function getDbPg(): Sql {
  const fromUserContext = userContextStorage.getStore();
  // TransactionSql is a structural subset of Sql (no .end, no listen, etc.)
  // but exposes the tagged-template query API every accessor uses. Cast
  // is safe in practice — the missing methods aren't called inside
  // withUserContext.
  if (fromUserContext) return fromUserContext.tx as unknown as Sql;
  const fromRequest = requestScopedDbStorage.getStore();
  if (fromRequest) return fromRequest.sql;
  if (!nodeScopedDb) throw new Error('Postgres database not initialized');
  return nodeScopedDb;
}

export function getCurrentNotifyQueue(): NotifyQueueEntry[] | null {
  return notifyQueueStorage.getStore() ?? null;
}

/**
 * Out-of-band sql for the G1 streaming-emit path. Opens a fresh
 * auto-commit connection on first call within a request scope so
 * streaming events can INSERT outbox rows without joining the run's
 * surrounding tx. In Node mode (no request scope), falls back to the
 * module-scoped client — there's no surrounding tx to escape there.
 */
export function getOutOfBandSql(): Sql {
  const slot = outOfBandDbStorage.getStore();
  if (!slot) {
    if (!nodeScopedDb) throw new Error('Postgres database not initialized');
    return nodeScopedDb;
  }
  if (!slot.sql) {
    slot.sql = postgres(slot.url, {
      max: 1,
      idle_timeout: 5,
      connect_timeout: 10,
      prepare: false,
    });
  }
  return slot.sql;
}

export function getStreamingCoalesceMap(): Map<string, PendingDrain> | null {
  return streamingCoalesceStorage.getStore() ?? null;
}

/**
 * Current user's id from the surrounding `withUserContext` scope.
 * Returns null outside a user context. Producers use this to fill
 * `ownerIds` on `emitOutboxEvent` for operations where the talk's
 * owner is by construction the requesting user (single-user-per-talk
 * model). Sharing will require a `talk_members` lookup instead.
 */
export function getCurrentUserId(): string | null {
  return userContextStorage.getStore()?.userId ?? null;
}

/**
 * Snapshot the current request scope's env + ctx. Used by the streaming
 * notify coalescer to schedule flushes via the same ctx.waitUntil()
 * the request handler will await on. Returns `{ env: null, ctx: null }`
 * outside any request scope.
 */
export function getRequestScopeEnvAndCtx(): {
  env: DbScopeEnvBindings | null;
  ctx: RequestExecutionContext | null;
} {
  const store = requestScopedDbStorage.getStore();
  return { env: store?.env ?? null, ctx: store?.ctx ?? null };
}

/**
 * Open a Postgres transaction, downgrade to `authenticated`, bind
 * `request.jwt.claims` so `auth.uid()` returns the caller's userId, and
 * run `fn` in an ALS scope where `getDbPg()` returns that transaction.
 *
 * Re-entrancy with the same userId reuses the outer transaction. Nested
 * calls with a different userId are a caller bug and throw synchronously
 * — cross-user nesting would silently leak data via the outer tx's claims.
 *
 * F7 outermost-owns-queue: when no outer notify queue exists (no
 * surrounding `withNotifyQueueScope` or `withUserContext`), this
 * function opens a fresh `NotifyQueueEntry[]` and flushes it after
 * `db.begin` resolves. The flush is forwarded to `ctx.waitUntil()`
 * when available so the HTTP response can return before notifies
 * complete.
 */
export async function withUserContext<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = userContextStorage.getStore();
  if (existing) {
    if (existing.userId !== userId) {
      throw new Error(
        `withUserContext re-entered with a different userId (outer=${existing.userId}, inner=${userId}); cross-user nesting is a caller bug`,
      );
    }
    return fn();
  }
  const requestScope = requestScopedDbStorage.getStore();
  const db = requestScope?.sql ?? nodeScopedDb;
  if (!db) throw new Error('Postgres database not initialized');
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });

  // F7: an outer queue (scheduler scope or wrapping request handler)
  // owns the flush. We just run inside the outer.
  const outerQueue = notifyQueueStorage.getStore();
  if (outerQueue) {
    return db.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claims', ${claims}, true)`;
      return userContextStorage.run({ tx, userId }, fn);
    }) as Promise<T>;
  }

  // Outermost — open a fresh queue and arrange post-commit flush.
  const queue: NotifyQueueEntry[] = [];
  return notifyQueueStorage.run(queue, () =>
    (
      db.begin(async (tx) => {
        await tx`set local role authenticated`;
        await tx`select set_config('request.jwt.claims', ${claims}, true)`;
        return userContextStorage.run({ tx, userId }, fn);
      }) as Promise<T>
    ).then((result) => {
      if (queue.length > 0) {
        const env = requestScope?.env ?? null;
        const ctx = requestScope?.ctx ?? null;
        const flush = flushNotifyQueue(queue, env).catch((err) => {
          console.error('[notify-queue] post-commit flush failed', err);
        });
        if (ctx) {
          ctx.waitUntil(flush);
        } else {
          flush.catch(() => {
            /* unhandled-rejection guard for Node fallback */
          });
        }
      }
      return result;
    }),
  );
}

// Node mode — call once at process boot. Idempotent.
export async function initPgDatabase(input?: { url?: string }): Promise<void> {
  if (nodeScopedDb) return;
  nodeScopedDb = postgres(resolveDatabaseUrl(input?.url), {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export async function closePgDatabase(): Promise<void> {
  if (!nodeScopedDb) return;
  const handle = nodeScopedDb;
  nodeScopedDb = null;
  await handle.end({ timeout: 5 });
}

// Minimal slice of Cloudflare's ExecutionContext — enough for waitUntil.
// Avoids importing @cloudflare/workers-types globals into modules that
// also need @types/node DOM types.
export interface RequestExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

function buildRequestPgClient(url: string): postgres.Sql {
  return postgres(url, {
    max: 1,
    fetch_types: true,
    idle_timeout: 5,
    connect_timeout: 10,
    prepare: false,
  });
}

/**
 * Workers mode — wrap a per-request unit of work. Creates a fresh
 * postgres.js client, opens the three sibling ALS scopes (out-of-band
 * sql for G1, streaming coalescer map for G7), runs `fn` inside the
 * full scope chain, and best-effort closes everything after `fn`
 * resolves. If `ctx` is provided, closes are forwarded via
 * `ctx.waitUntil()`.
 *
 * Streaming-coalesce drains with pending timers at scope exit are
 * flushed synchronously. The notify-queue scope is NOT opened here —
 * `withUserContext` and `withNotifyQueueScope` own that lifecycle so
 * the queue closes around the surrounding tx commit window.
 */
export async function withRequestScopedDb<T>(
  url: string,
  ctx: RequestExecutionContext | null,
  env: DbScopeEnvBindings | null,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const sql = buildRequestPgClient(url);
  const outOfBand: OutOfBandSlot = { url, sql: null };
  const streamingCoalesce = new Map<string, PendingDrain>();
  try {
    return await requestScopedDbStorage.run({ sql, ctx, env }, () =>
      outOfBandDbStorage.run(outOfBand, () =>
        streamingCoalesceStorage.run(streamingCoalesce, () => fn(sql)),
      ),
    );
  } catch (err) {
    console.error('[withRequestScopedDb] fn threw', describeError(err));
    throw err;
  } finally {
    const pendingFlushes: Promise<unknown>[] = [];
    for (const [ownerId, slot] of streamingCoalesce) {
      if (slot.timer) clearTimeout(slot.timer);
      if (slot.entries.length > 0) {
        const entries = slot.entries;
        slot.entries = [];
        slot.timer = null;
        const flush = flushNotifyQueueForOwner(ownerId, entries, env).catch(
          (err) => {
            console.error(
              '[withRequestScopedDb] streaming-coalesce exit-flush failed',
              describeError(err),
            );
          },
        );
        pendingFlushes.push(flush);
      }
    }
    const closeMain = sql.end({ timeout: 5 }).catch((err) => {
      console.error('[withRequestScopedDb] sql.end failed', describeError(err));
    });
    pendingFlushes.push(closeMain);
    if (outOfBand.sql) {
      const closeOob = outOfBand.sql.end({ timeout: 5 }).catch((err) => {
        console.error(
          '[withRequestScopedDb] out-of-band sql.end failed',
          describeError(err),
        );
      });
      pendingFlushes.push(closeOob);
    }
    const close = Promise.all(pendingFlushes);
    if (ctx) {
      ctx.waitUntil(close);
    } else {
      await close;
    }
  }
}

/**
 * Durable-Object mode — accessors invoked from inside a DO see the
 * caller-supplied `sql` via `getDbPg()`.
 */
export async function withDurableObjectScopedDb<T>(
  sql: postgres.Sql,
  fn: () => Promise<T>,
): Promise<T> {
  return await requestScopedDbStorage.run({ sql, ctx: null, env: null }, fn);
}

/**
 * Open a per-scheduler-tick `NotifyQueueEntry[]` for the duration of
 * `fn`, then flush exactly once via `ctx.waitUntil()`. Producers
 * inside `fn` push to the queue via `emitOutboxEvent`. Used by
 * `run-worker.processCycle` (G3) so cross-user scheduler emits don't
 * orphan when no surrounding `withUserContext` exists.
 *
 * Nested calls (e.g., a `withUserContext` opened inside this scope)
 * reuse the outer queue — outermost-owns-flush (F7).
 */
export async function withNotifyQueueScope<T>(
  env: DbScopeEnvBindings | null,
  ctx: RequestExecutionContext | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (notifyQueueStorage.getStore()) {
    return fn();
  }
  const queue: NotifyQueueEntry[] = [];
  try {
    return await notifyQueueStorage.run(queue, fn);
  } finally {
    if (queue.length > 0) {
      const flush = flushNotifyQueue(queue, env).catch((err) => {
        console.error('[notify-queue] scope flush failed', err);
      });
      if (ctx) {
        ctx.waitUntil(flush);
      } else {
        await flush;
      }
    }
  }
}

/**
 * Group `queue` entries by ownerId, then POST one batched notify per
 * owner to the UserEventHub DO. Each fan-out retries up to 3 times
 * on transient failure (D1: 100ms / 500ms / 2s backoff).
 *
 * No-ops when `env.USER_EVENT_HUB` is missing or the queue is empty.
 */
export async function flushNotifyQueue(
  queue: NotifyQueueEntry[],
  env: DbScopeEnvBindings | null,
): Promise<void> {
  if (!env?.USER_EVENT_HUB || queue.length === 0) return;
  const byOwner = new Map<string, NotifyQueueEntry[]>();
  for (const entry of queue) {
    for (const ownerId of entry.ownerIds) {
      const list = byOwner.get(ownerId) ?? [];
      list.push(entry);
      byOwner.set(ownerId, list);
    }
  }
  await Promise.all(
    [...byOwner.entries()].map(([ownerId, entries]) =>
      flushNotifyQueueForOwner(ownerId, entries, env),
    ),
  );
}

/**
 * Send one batched notify to the DO for `ownerId` containing
 * `entries`. 3x retry with 100ms / 500ms / 2s backoff per D1.
 * 200-class and 429 responses are terminal-success (429 = DO is full
 * for this owner; the producer can't help). Other 5xx + network
 * errors retry; if all attempts fail, the failure is logged and the
 * function resolves — the outbox row is durable, so a later DO
 * `alarm()` will catch up.
 */
export async function flushNotifyQueueForOwner(
  ownerId: string,
  entries: NotifyQueueEntry[],
  env: DbScopeEnvBindings | null,
): Promise<void> {
  if (!env?.USER_EVENT_HUB || entries.length === 0) return;
  const id = env.USER_EVENT_HUB.idFromName(ownerId);
  const stub = env.USER_EVENT_HUB.get(id);
  const body = JSON.stringify({
    entries: entries.map(({ topic, eventId }) => ({ topic, eventId })),
  });
  const delays = [100, 500, 2_000];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const req = new Request('http://hub/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      const res = await stub.fetch(req);
      if (res.ok || res.status === 429) return;
      lastErr = new Error(`notify ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < delays.length) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  console.error('[notify-queue] gave up after retries', { ownerId, lastErr });
}

function describeError(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== 'object') {
    return { value: String(err) };
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(err)) {
    const v = (err as Record<string, unknown>)[key];
    out[key] = typeof v === 'string' || typeof v === 'number' ? v : String(v);
  }
  if (err instanceof Error) {
    out.name = err.name;
    out.message = err.message;
    out.stack = err.stack?.split('\n').slice(0, 5).join(' | ');
  }
  return out;
}

export async function isPgDatabaseHealthy(): Promise<boolean> {
  const db =
    userContextStorage.getStore()?.tx ??
    requestScopedDbStorage.getStore()?.sql ??
    nodeScopedDb;
  if (!db) return false;
  try {
    const rows = await db`select 1 as ok`;
    return rows[0]?.ok === 1;
  } catch {
    return false;
  }
}
