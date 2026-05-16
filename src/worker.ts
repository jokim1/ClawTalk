// clawtalk Phase 5 PR 2 — Cloudflare Workers entry.
//
// Delegates fetch handling to `getWorkerApp()` from
// `src/clawtalk/web/worker-app.ts`. That Hono app mounts the
// cloud-ready surface (health + auth callback/refresh/logout + an
// auth-protected sanity probe); any sqlite-era route that hasn't
// been caller-swapped yet returns 501 from the Hono catch-all.
//
// Request flow:
//   /api/*    → worker-app Hono router (with per-request DB scope)
//   non-/api  → env.ASSETS.fetch() (SPA fallback)
//
// Queue + scheduled handlers (Queues port U1 — scaffold):
//   queue()     dispatches each message through processTalkRunMessage.
//               U1's stub logs + acks; U3 replaces with real run exec.
//   scheduled() job-trigger scheduler stub. U4 wires the real
//               claimDueTalkJobs → dispatchRun loop.
//
// Both handlers ack-or-retry per Cloudflare Queues semantics: throw
// → retry (up to wrangler.toml's max_retries=3 then DLQ); return →
// ack.

import { type RequestExecutionContext, withRequestScopedDb } from './db.js';
import { getWorkerApp } from './clawtalk/web/worker-app.js';
import {
  BlockedBySiblingError,
  processTalkRunMessage,
} from './clawtalk/talks/queue-consumer.js';
import { runScheduledTick } from './clawtalk/talks/scheduler.js';

export { UserEventHub } from './clawtalk/talks/user-event-hub.js';

// Wrangler bindings declared in wrangler.toml. Workers Secrets (set via
// `wrangler secret put`) appear on the same env object — those modules
// that need them read via process.env thanks to nodejs_compat.
export interface Env {
  DB: { connectionString: string };
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  JWKS_CACHE: KVNamespace;
  TALK_RUN_QUEUE: Queue;
  USER_EVENT_HUB: UserEventHubNamespace;
  SUPABASE_PROJECT_URL: string;
  DB_EVENT_HUB_URL: string;
}

// Minimal KVNamespace + Queue types — pulled inline to avoid forcing
// every consumer module to import @cloudflare/workers-types globals.
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

interface Queue {
  send(
    message: unknown,
    options?: { contentType?: string; delaySeconds?: number },
  ): Promise<void>;
  sendBatch(messages: Array<{ body: unknown }>): Promise<void>;
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

interface QueueMessage {
  id: string;
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

interface MessageBatch {
  messages: QueueMessage[];
  ackAll(): void;
}

interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers || {}),
    },
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: RequestExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await withRequestScopedDb(
        env.DB.connectionString,
        ctx,
        {
          DB_EVENT_HUB_URL: env.DB_EVENT_HUB_URL,
          USER_EVENT_HUB: env.USER_EVENT_HUB,
          TALK_RUN_QUEUE: env.TALK_RUN_QUEUE,
        },
        async () => getWorkerApp().fetch(request, env),
      );
    } catch (err) {
      console.error(
        'Worker request failed',
        url.pathname,
        request.method,
        err instanceof Error ? err.name : typeof err,
        err instanceof Error ? err.message : String(err),
        err instanceof Error
          ? err.stack?.split('\n').slice(0, 5).join(' | ')
          : undefined,
      );
      return jsonResponse(
        {
          ok: false,
          error: { code: 'internal_error', message: 'Request failed' },
        },
        { status: 500 },
      );
    }
  },

  // Queue consumer — wired up in wrangler.toml [[queues.consumers]].
  // Each message is wrapped in its own withRequestScopedDb scope so
  // processTalkRunMessage's withUserContext, the streaming-coalesce
  // notifier, and the cooperative cancel poller all have working DB
  // access.
  //
  // Retry strategy:
  //   - BlockedBySiblingError: ordered sibling still active. Retry
  //     in 60s so the sibling has time to complete. Cloudflare Queues
  //     caps total retries via wrangler.toml [[queues.consumers]]
  //     max_retries=3 before DLQ.
  //   - Unexpected throw: retry in 30s.
  //   - Returned normally: ack.
  async queue(
    batch: MessageBatch,
    env: Env,
    ctx: RequestExecutionContext,
  ): Promise<void> {
    for (const message of batch.messages) {
      const body = message.body;
      if (!isRunMessageBody(body)) {
        console.warn(
          'queue message: invalid body shape, acking to DLQ',
          message.id,
        );
        message.ack();
        continue;
      }
      try {
        await withRequestScopedDb(
          env.DB.connectionString,
          ctx,
          {
            DB_EVENT_HUB_URL: env.DB_EVENT_HUB_URL,
            USER_EVENT_HUB: env.USER_EVENT_HUB,
            TALK_RUN_QUEUE: env.TALK_RUN_QUEUE,
          },
          async () => processTalkRunMessage({ runId: body.runId }),
        );
        message.ack();
      } catch (err) {
        if (err instanceof BlockedBySiblingError) {
          message.retry({ delaySeconds: 60 });
          continue;
        }
        console.error(
          'queue message: processTalkRunMessage threw',
          message.id,
          body.runId,
          err instanceof Error ? err.message : String(err),
        );
        message.retry({ delaySeconds: 30 });
      }
    }
  },

  // Cron trigger — fires every minute per wrangler.toml [triggers].
  // The tick claims due jobs, dispatches each to TALK_RUN_QUEUE, and
  // sweeps stuck running runs (status='running' AND started_at older
  // than 1h). Wrapped in ctx.waitUntil so the handler isn't capped at
  // the 30s default budget.
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: RequestExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runScheduledTick(env, ctx).catch((err) => {
        console.error(
          'scheduled tick failed',
          err instanceof Error ? err.message : String(err),
        );
      }),
    );
  },
};

function isRunMessageBody(body: unknown): body is { runId: string } {
  if (!body || typeof body !== 'object') return false;
  const candidate = body as { runId?: unknown };
  return typeof candidate.runId === 'string' && candidate.runId.length > 0;
}
