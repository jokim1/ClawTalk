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
// Queue consumer still acks every message (placeholder). The talk-
// run-via-queues port lands as its own slice after the route caller-
// swap finishes.

import { type RequestExecutionContext, withRequestScopedDb } from './db.js';
import { getWorkerApp } from './clawtalk/web/worker-app.js';

// Wrangler bindings declared in wrangler.toml. Workers Secrets (set via
// `wrangler secret put`) appear on the same env object — those modules
// that need them read via process.env thanks to nodejs_compat.
export interface Env {
  DB: { connectionString: string };
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  JWKS_CACHE: KVNamespace;
  TALK_RUN_QUEUE: Queue;
  SUPABASE_PROJECT_URL: string;
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
  send(message: unknown): Promise<void>;
  sendBatch(messages: Array<{ body: unknown }>): Promise<void>;
}

interface MessageBatch {
  messages: Array<{ id: string; body: unknown; ack(): void; retry(): void }>;
  ackAll(): void;
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
      return await withRequestScopedDb(env.DB.connectionString, ctx, async () =>
        getWorkerApp().fetch(request, env),
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
  // PR 1 acks every message immediately (foundation only). PR 2 replaces
  // this with the real talk-run worker that dispatches multi-agent runs.
  async queue(batch: MessageBatch, _env: Env, _ctx: RequestExecutionContext) {
    for (const message of batch.messages) {
      console.log('queue message received (PR 1 placeholder ack)', message.id);
      message.ack();
    }
  },
};
