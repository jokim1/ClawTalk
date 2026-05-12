// clawtalk Phase 5 PR 2 — Workers Hono app factory.
//
// `getWorkerApp(env)` returns a Hono instance wired with the new
// cloud auth surface. It does NOT yet mount the full sqlite-era
// route surface — those routes live in `web/server.ts` and need
// the per-route caller swap (drop sqlite `*-accessors`, swap to
// `*-pg`, wrap in `withUserContext`) before they're cloud-ready.
//
// Mounted today:
//   GET  /api/v1/health             — postgres-backed health probe
//   POST /api/v1/auth/callback      — webapp hands over Supabase
//                                     access+refresh tokens, we set
//                                     eb_at/eb_rt/eb_csrf
//   POST /api/v1/auth/refresh       — eb_rt cookie → fresh trio via
//                                     Supabase /auth/v1/token
//   POST /api/v1/auth/logout        — best-effort Supabase logout +
//                                     always clear cookies
//   GET  /api/v1/_protected/whoami  — auth-middleware sanity probe.
//                                     Returns the resolved userId so
//                                     dev/QA can verify the JWT path
//                                     end-to-end against the wrangler
//                                     dev binding stack.
//
// Caller-swap follow-up: as each sqlite-era route is ported to
// `*-pg.ts` + `withUserContext`, it gets mounted here. Once every
// route is mounted, `web/server.ts` can shrink to just the Node-
// mode bootstrap (which itself goes away when src/db.ts is deleted).
//
// Auth middleware: applied to /api/v1/_protected/* (today) and will
// expand to /api/v1/talks, /api/v1/agents, etc. as those routes get
// caller-swapped. Public routes (`/api/v1/auth/*`, `/api/v1/health`)
// stay outside the middleware.

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';

import { isPgDatabaseHealthy } from '../../db-pg.js';
import {
  authChallengeHeader,
  authenticateRequestPg,
  extractJwksEnv,
} from './middleware/auth-pg.js';
import { handleAuthCallback } from './routes/auth-callback.js';
import { handleAuthLogout } from './routes/auth-logout.js';
import { handleAuthRefresh } from './routes/auth-refresh.js';
import { AuthContext } from './types.js';

export interface WorkerAppEnv {
  SUPABASE_PROJECT_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  JWKS_CACHE?: unknown;
}

// Hono variables we carry on Context. The auth middleware writes
// `auth` after a successful JWT verification; downstream handlers
// read it via `c.get('auth')`.
type Variables = {
  auth: AuthContext;
};

let cachedApp: Hono<{ Variables: Variables }> | null = null;

/**
 * Lazy-init the Hono app once per isolate. Workers cold-boot for
 * each isolate, but reused across requests, so amortizing the
 * Hono router construction across the isolate's lifetime is the
 * right shape — matches editorialroom's `getWorkerApp()`.
 */
export function getWorkerApp(): Hono<{ Variables: Variables }> {
  if (cachedApp) return cachedApp;
  cachedApp = buildApp();
  return cachedApp;
}

/** Test-only: drop the cached app so a fresh build can pick up
 * test-time module changes. */
export function _resetWorkerAppForTests(): void {
  cachedApp = null;
}

function buildApp(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  // ── Public surfaces ──────────────────────────────────────────
  app.get('/api/v1/health', handleHealth);
  app.post('/api/v1/auth/callback', handleAuthCallback);
  app.post('/api/v1/auth/refresh', handleAuthRefresh);
  app.post('/api/v1/auth/logout', handleAuthLogout);

  // ── Protected surfaces ───────────────────────────────────────
  // Caller-swapped routes will move under this guard as they
  // land. For now there's only the whoami sanity probe.
  app.use('/api/v1/_protected/*', requireAuthMiddleware);
  app.get('/api/v1/_protected/whoami', (c) => {
    const auth = c.get('auth');
    return c.json({
      ok: true,
      data: {
        userId: auth.userId,
        sessionId: auth.sessionId,
        role: auth.role,
        authType: auth.authType,
      },
    });
  });

  // 404 fallback for any other /api/v1/* path (every chassis-era
  // route returns 501 until the caller swap mounts it).
  app.all('/api/v1/*', (c) =>
    c.json(
      {
        ok: false,
        error: {
          code: 'not_implemented_in_worker',
          message:
            'This route is not yet wired through the Worker entry. PR 2 caller-swap is in progress.',
        },
      },
      501,
    ),
  );

  return app;
}

async function handleHealth(c: Context): Promise<Response> {
  const dbHealthy = await isPgDatabaseHealthy().catch(() => false);
  return c.json({
    ok: true,
    data: {
      status: 'ok',
      db: dbHealthy,
      runtime: 'workers',
    },
  });
}

/**
 * Hono middleware that verifies the eb_at cookie via Supabase JWKS
 * and attaches the resolved AuthContext to the request. Worker mode
 * (env has JWKS_CACHE + SUPABASE_PROJECT_URL) verifies cryptograph-
 * ically; Node mode (vitest, tsx local) falls back to the
 * CLAWTALK_DEV_STUB_ENABLED gate.
 */
const requireAuthMiddleware: MiddlewareHandler<{ Variables: Variables }> =
  async (c, next) => {
    const env = extractJwksEnv(c.env);
    const result = await authenticateRequestPg(
      {
        authorization: c.req.header('authorization'),
        cookie: c.req.header('cookie'),
      },
      env,
    );
    if (result.kind !== 'authenticated') {
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: 'unauthorized',
            message: 'Authentication is required',
          },
        }),
        {
          status: 401,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'www-authenticate': authChallengeHeader(result.reason),
          },
        },
      );
    }
    c.set('auth', result.auth);
    await next();
  };
