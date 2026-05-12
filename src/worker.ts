// clawtalk Phase 5 (PR 1) — Cloudflare Workers entry, foundation only.
//
// This file exists so `wrangler dev` boots and proves the
// Workers + Hyperdrive + Supabase wiring works end-to-end against the
// local supabase stack. PR 1 does NOT route the Hono app through the
// Worker yet — the running app is still served by `tsx src/server.ts`
// against SQLite. PR 2 swaps `getWorkerApp()` to return the real Hono
// app and deletes the SQLite path.
//
// What the foundation proves:
//   - wrangler.toml bindings resolve (ASSETS, DB, JWKS_CACHE, queues)
//   - postgres.js connects to local supabase via Hyperdrive
//     localConnectionString
//   - the per-request DB scope (withRequestScopedDb) wraps cleanly
//   - the assets binding serves the webapp SPA
//
// Request flow today:
//   /api/v1/health → JSON `{ok: true, data: {status: 'ok', db: <bool>}}`
//   everything else → env.ASSETS.fetch() (SPA fallback)
//
// Adding the full Hono app to this entry happens in PR 2.

import {
  type RequestExecutionContext,
  isPgDatabaseHealthy,
  withRequestScopedDb,
} from './db-pg.js';

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

async function handleHealthCheck(env: Env): Promise<Response> {
  const dbHealthy = await isPgDatabaseHealthy().catch(() => false);
  return jsonResponse({
    ok: true,
    data: {
      status: 'ok',
      db: dbHealthy,
      runtime: 'workers',
      supabaseProject: env.SUPABASE_PROJECT_URL,
    },
  });
}

async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/v1/health') {
    return handleHealthCheck(env);
  }
  // PR 1 foundation stop: every other /api/* route returns a placeholder
  // 501 until PR 2 wires the full Hono app through this Worker.
  return jsonResponse(
    {
      ok: false,
      error: {
        code: 'not_implemented_in_pr1',
        message:
          'This Worker is foundation-only. The live app still runs from src/server.ts (SQLite) until the PR 2 cutover.',
      },
    },
    { status: 501 },
  );
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
        handleApiRequest(request, env),
      );
    } catch (err) {
      console.error('Worker request failed', err);
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
