// UserEventHub — per-user Durable Object that holds hibernating
// WebSocket connections and drains outbox notifies into live frames.
//
// Routing (F11): fetch only matches `/upgrade` and `/notify`.
//
// /upgrade:
//   • blockConcurrencyWhile (G5) wraps the whole accept-and-replay
//     so a concurrent /notify can't race the upgrade replay.
//   • F8 cap-in-DO (3 sockets/owner) + D8 cross-DO guard (header
//     userid must match the DO id name).
//   • acceptWebSocket + serializeAttachment (per-socket cursor, jwt
//     exp, topic, scope).
//   • Replay window: read outbox between (lastEventId, maxId] with
//     the D12 500-frame cap and F12 outbox-floor gap detection. All
//     DB ops wrapped in Promise.race against rejectAfter(5_000)
//     (G6) and the postgres client opens with statement_timeout=5s.
//
// /notify:
//   • blockConcurrencyWhile (F9) wraps the drain so two concurrent
//     /notify requests serialize. The drain runs to completion inside
//     the lock — drainOnce is bounded by postgres.statement_timeout
//     (5_000 ms per query), well under CF's 30s blockConcurrencyWhile
//     ceiling under measured load (p95 drain ≈ 460 ms). Pathological
//     backlog × slow-query conditions still rely on the alarm backstop
//     to recover.
//   • R8 JWT exp check per socket → close(4401) on expiry.
//   • R9 backpressure close on bufferedAmount > 1MB → close(1011).
//   • Drain loop (R5) keeps reading outbox until rows < limit, in
//     batches of 100. Per-socket cursor advances via
//     serializeAttachment.
//   • R4 setAlarm(now + 30_000) on every notify so a final-frame
//     loss has a catch-up path.
//
// alarm():
//   • Same drain loop as /notify (catch-up path).
//
// webSocketClose(): no-op (workerd reclaims the slot).

import postgres from 'postgres';

import {
  getOutboxEventsForTopics,
  getOutboxMaxEventIdForTopics,
  getOutboxMinEventIdForTopics,
} from '../db/accessors.js';
import { withDurableObjectScopedDb } from '../../db.js';
import {
  buildConversationRunEventFilter,
  buildTalkThreadEventFilter,
  type OutboxEventFilter,
} from './event-filters.js';

// ─── Cloudflare DO surface types (minimal local shims) ──────────────────

interface WebSocketLike {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
  readonly bufferedAmount: number;
}

interface DurableObjectStateLike {
  readonly id: { readonly name?: string };
  acceptWebSocket(ws: WebSocketLike, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocketLike[];
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  storage: {
    setAlarm(when: number | Date): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
}

// Cloudflare workerd globals — typed locally to avoid pulling in
// @cloudflare/workers-types for the whole repo.
declare const WebSocketPair: {
  new (): { 0: WebSocketLike; 1: WebSocketLike };
};

interface DoResponseInit extends ResponseInit {
  webSocket?: WebSocketLike;
}

export interface UserEventHubEnv {
  DB_EVENT_HUB_URL?: string;
}

// ─── Per-socket attachment (V4 §4b) ─────────────────────────────────────

export interface SocketAttachment {
  scope: 'user' | 'talk';
  userId: string;
  talkId: string | null;
  threadId: string | null;
  topic: string;
  jwtExp: number;
  connectedAtMs: number;
  cursor: number;
}

// ─── Tunables (V4 §4d budget) ───────────────────────────────────────────

const SOCKET_CAP_PER_OWNER = 3;
const REPLAY_FRAME_CAP = 500;
const REPLAY_BATCH_LIMIT = 100;
const DRAIN_BATCH_LIMIT = 100;
// Cap how many DRAIN_BATCH_LIMIT-sized batches one drain pass reads.
// Bounds blockConcurrencyWhile occupancy under pathological backlog ×
// slow-query conditions so we never trip CF's 30s reset ceiling. Excess
// rows defer to the alarm backstop. 10 × ~500ms/batch p95 = 5s budget,
// leaving 25s headroom.
const MAX_DRAIN_BATCHES_PER_CALL = 10;
const REPLAY_TIMEOUT_MS = 5_000;
const ALARM_BACKOFF_MS = 30_000;
const BACKPRESSURE_BYTES = 1_000_000;
const STATEMENT_TIMEOUT_MS = 5_000;

// ─── G6 helper: bounded promise race ────────────────────────────────────

function rejectAfter(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timeout: ${label}`)), ms),
  );
}

// ─── Header → attachment shape ──────────────────────────────────────────

function parseAttachmentFromHeaders(req: Request): SocketAttachment {
  const h = req.headers;
  const scopeRaw = h.get('x-clawtalk-scope');
  const scope: 'user' | 'talk' = scopeRaw === 'talk' ? 'talk' : 'user';
  const userId = h.get('x-clawtalk-userid') ?? '';
  const topic = h.get('x-clawtalk-topic') ?? '';
  const talkId = h.get('x-clawtalk-talk-id') || null;
  const threadId = h.get('x-clawtalk-thread-id') || null;
  const lastEventId = Number(h.get('x-clawtalk-last-event-id') ?? '0');
  const jwtExp = Number(h.get('x-clawtalk-jwt-exp') ?? '0');
  return {
    scope,
    userId,
    talkId,
    threadId,
    topic,
    jwtExp: Number.isFinite(jwtExp) ? jwtExp : 0,
    connectedAtMs: Date.now(),
    cursor: Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : 0,
  };
}

// ─── Scope-filter — drops outbox rows that don't match the socket ──────

export function buildAttachmentFilter(
  attachment: SocketAttachment,
): OutboxEventFilter {
  const filters: OutboxEventFilter[] = [];
  if (attachment.scope === 'talk') {
    filters.push(buildConversationRunEventFilter());
    if (attachment.threadId) {
      filters.push(buildTalkThreadEventFilter(attachment.threadId));
    }
  }
  if (filters.length === 0) return () => true;
  if (filters.length === 1) return filters[0]!;
  return (event) => filters.every((f) => f(event));
}

// ─── DO class ───────────────────────────────────────────────────────────

export class UserEventHub {
  private state: DurableObjectStateLike;
  private env: UserEventHubEnv;

  constructor(state: DurableObjectStateLike, env: UserEventHubEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/upgrade':
        return this.handleUpgrade(request);
      case '/notify':
        return this.handleNotify(request);
      case '/health':
        return new Response('ok', { status: 200 });
      default:
        return new Response('not found', { status: 404 });
    }
  }

  // ─── /upgrade ────────────────────────────────────────────────────────
  private async handleUpgrade(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }

    const attachment = parseAttachmentFromHeaders(req);
    if (!attachment.userId || !attachment.topic) {
      return new Response('missing auth headers', { status: 400 });
    }
    // D8 cross-DO guard: the Worker forwards by idFromName(userId);
    // the DO's own id.name must match the header userid.
    if (
      this.state.id.name !== undefined &&
      this.state.id.name !== attachment.userId
    ) {
      return new Response('cross-do mismatch', { status: 403 });
    }

    let response: Response | null = null;
    await this.state.blockConcurrencyWhile(async () => {
      // F8 cap-in-DO.
      if (this.state.getWebSockets().length >= SOCKET_CAP_PER_OWNER) {
        response = new Response('too many sockets', { status: 429 });
        return;
      }

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]] as [
        WebSocketLike,
        WebSocketLike,
      ];
      this.state.acceptWebSocket(server, [attachment.topic]);
      server.serializeAttachment(attachment);

      // Replay window with G6 timeout.
      try {
        await Promise.race([
          this.replayInto(server, attachment),
          rejectAfter(REPLAY_TIMEOUT_MS, 'replay_timeout'),
        ]);
      } catch (err) {
        // Don't throw out of blockConcurrencyWhile — would reset the DO.
        console.error('[user-event-hub] replay failed', err);
      }

      const init: DoResponseInit = {
        status: 101,
        webSocket: client,
      };
      response = new Response(null, init as ResponseInit);
    });
    return response ?? new Response('upgrade not produced', { status: 500 });
  }

  private async replayInto(
    server: WebSocketLike,
    attachment: SocketAttachment,
  ): Promise<void> {
    await this.withDoSql(async () => {
      const topic = attachment.topic;
      const minId = await getOutboxMinEventIdForTopics([topic]);
      const lastEventId = attachment.cursor;

      // F12 floor-check: cursor below retention floor → synthetic
      // replay_gap frame; skip the cursor ahead to minId.
      if (lastEventId > 0 && minId !== null && lastEventId < minId) {
        server.send(
          JSON.stringify({
            event: 'replay_gap',
            data: {
              reason: 'cursor_below_retention_floor',
              minEventId: minId,
            },
            id: minId,
          }),
        );
        attachment.cursor = minId;
        server.serializeAttachment(attachment);
        return;
      }

      const maxId = await getOutboxMaxEventIdForTopics([topic]);
      if (maxId === null || maxId <= lastEventId) {
        // Nothing to replay.
        return;
      }

      const filter = buildAttachmentFilter(attachment);
      let cursor = lastEventId;
      let sent = 0;

      while (sent < REPLAY_FRAME_CAP && cursor < maxId) {
        const batchSize = Math.min(REPLAY_BATCH_LIMIT, REPLAY_FRAME_CAP - sent);
        const rows = await getOutboxEventsForTopics([topic], cursor, batchSize);
        if (rows.length === 0) break;
        for (const row of rows) {
          if (filter(row)) {
            server.send(
              JSON.stringify({
                event: row.event_type,
                data: row.payload,
                id: row.event_id,
              }),
            );
            sent += 1;
            if (sent >= REPLAY_FRAME_CAP) break;
          }
          cursor = row.event_id;
        }
        if (rows.length < batchSize) break;
      }
      attachment.cursor = cursor;
      server.serializeAttachment(attachment);

      // D12 replay cap: if we hit the cap with more behind, emit a
      // synthetic replay_gap so the client knows it's missing rows.
      if (sent >= REPLAY_FRAME_CAP && cursor < maxId) {
        server.send(
          JSON.stringify({
            event: 'replay_gap',
            data: {
              reason: 'replay_cap_500_exceeded',
              remainingThroughEventId: maxId,
            },
            id: cursor,
          }),
        );
      }
    });
  }

  // ─── /notify ─────────────────────────────────────────────────────────
  private async handleNotify(_req: Request): Promise<Response> {
    // drainOnce must complete inside blockConcurrencyWhile — a lock
    // released with an orphan drainOnce racing the next handler's
    // drainOnce would corrupt per-socket attachment.cursor writes.
    await this.state.blockConcurrencyWhile(async () => {
      try {
        await this.drainOnce();
      } catch (err) {
        console.error('[user-event-hub] drain failed', err);
      }
    });
    // R4: schedule an alarm catch-up regardless of drain outcome —
    // if the drain succeeded, alarm fires on idle and is a no-op
    // (no new rows). If it failed, alarm retries in 30s.
    await this.state.storage.setAlarm(Date.now() + ALARM_BACKOFF_MS);
    return new Response(null, { status: 200 });
  }

  private async drainOnce(): Promise<void> {
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) return;

    // R8 JWT expiry sweep.
    const nowSec = Math.floor(Date.now() / 1000);
    const live: WebSocketLike[] = [];
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (!att) continue;
      if (att.jwtExp > 0 && att.jwtExp < nowSec) {
        ws.close(4401, 'token_expired');
        continue;
      }
      live.push(ws);
    }
    if (live.length === 0) return;

    // Aggregate the set of topics our live sockets care about, and
    // the floor cursor we need to read from.
    const topics = Array.from(
      new Set(
        live
          .map(
            (ws) =>
              (ws.deserializeAttachment() as SocketAttachment | null)?.topic,
          )
          .filter((t): t is string => typeof t === 'string'),
      ),
    );
    if (topics.length === 0) return;
    let sinceCursor = Math.min(
      ...live.map(
        (ws) => (ws.deserializeAttachment() as SocketAttachment).cursor,
      ),
    );

    await this.withDoSql(async () => {
      let batches = 0;
      while (true) {
        const rows = await getOutboxEventsForTopics(
          topics,
          sinceCursor,
          DRAIN_BATCH_LIMIT,
        );
        if (rows.length === 0) break;
        for (const row of rows) {
          for (const ws of live) {
            const att = ws.deserializeAttachment() as SocketAttachment;
            if (row.event_id <= att.cursor) continue;
            if (row.topic !== att.topic) continue;
            const filter = buildAttachmentFilter(att);
            if (!filter(row)) continue;
            if (ws.bufferedAmount > BACKPRESSURE_BYTES) {
              ws.close(1011, 'backpressure');
              continue;
            }
            try {
              ws.send(
                JSON.stringify({
                  event: row.event_type,
                  data: row.payload,
                  id: row.event_id,
                }),
              );
            } catch (err) {
              console.error('[user-event-hub] ws.send failed', err);
              continue;
            }
            att.cursor = row.event_id;
            ws.serializeAttachment(att);
          }
          sinceCursor = row.event_id;
        }
        batches += 1;
        if (rows.length < DRAIN_BATCH_LIMIT) break;
        if (batches >= MAX_DRAIN_BATCHES_PER_CALL) {
          console.warn(
            '[user-event-hub] drain hit MAX_DRAIN_BATCHES_PER_CALL; deferring remainder to alarm',
          );
          break;
        }
      }
    });
  }

  // ─── alarm() — catch-up path (R4) ────────────────────────────────────
  async alarm(): Promise<void> {
    // Same drainOnce-inside-blockConcurrencyWhile contract as handleNotify — see above.
    await this.state.blockConcurrencyWhile(async () => {
      try {
        await this.drainOnce();
      } catch (err) {
        console.error('[user-event-hub] alarm drain failed', err);
      }
    });
  }

  // ─── WebSocket lifecycle handlers ────────────────────────────────────
  async webSocketMessage(
    _ws: WebSocketLike,
    _message: string | ArrayBuffer,
  ): Promise<void> {
    // No-op — clients don't send messages; the DO only fans out.
  }

  async webSocketClose(
    _ws: WebSocketLike,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // No-op — workerd reclaims the slot. The next getWebSockets()
    // call won't return it.
  }

  async webSocketError(_ws: WebSocketLike, error: unknown): Promise<void> {
    console.error('[user-event-hub] ws error', error);
  }

  // ─── F5 per-drain postgres lifecycle ─────────────────────────────────
  private async withDoSql<T>(fn: () => Promise<T>): Promise<T> {
    const url = this.env.DB_EVENT_HUB_URL;
    if (!url) {
      throw new Error('DB_EVENT_HUB_URL is not set on the DO env');
    }
    // `connection.statement_timeout` is a postgres.js session parameter
    // — the typings don't enumerate every PG GUC, so we cast through
    // unknown to keep strict TS happy. The value is a string in
    // milliseconds per Postgres convention.
    const sql = postgres(url, {
      max: 1,
      fetch_types: true,
      idle_timeout: 5,
      connect_timeout: 10,
      prepare: false,
      connection: {
        statement_timeout: String(STATEMENT_TIMEOUT_MS),
      } as unknown as Record<string, string>,
    });
    try {
      return await withDurableObjectScopedDb(sql, fn);
    } finally {
      await sql.end({ timeout: 5 }).catch((err) => {
        console.error('[user-event-hub] sql.end failed', err);
      });
    }
  }
}
