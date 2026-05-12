// clawtalk Phase 5 PR 2 — JWT-verifying auth middleware (cloud path).
//
// Sibling of the legacy `auth.ts` (hashes-an-opaque-cookie-and-looks-
// up-web_sessions). The caller swap will route every request handler
// through this module instead.
//
// Two operating modes:
//
//   Worker mode (production + `wrangler dev`): the runtime env exposes
//   `JWKS_CACHE` and `SUPABASE_PROJECT_URL`. We require a verified
//   `eb_at` cookie. Cookie-less, expired, or bad-signature requests
//   resolve to `unauthorized`. There is NO dev-stub path in this mode.
//
//   Node mode (`tsx src/server.ts`, vitest): the runtime has no JWKS
//   surface. We honor the `CLAWTALK_DEV_STUB_ENABLED` opt-in so
//   existing tests + local tsx bootstrap work without crafting real
//   ES256-signed JWTs. The gate is intentionally Node-only.
//
// Mirrors editorialroom's same-named module.

import { logger } from '../../../logger.js';
import { ACCESS_TOKEN_COOKIE, parseCookieHeader } from '../cookies.js';
import { AuthContext } from '../types.js';
import { type JwksEnv, verifyJwt } from './jwks.js';

export const DEV_USER_ID = '00000000-0000-0000-0000-000000000001';
export const DEV_USER_EMAIL = 'dev@clawtalk.local';
export const DEV_USER_DISPLAY_NAME = 'Dev User';

export type AuthFailureReason = 'expired' | 'invalid' | 'missing';

export type AuthOutcome =
  | { kind: 'authenticated'; auth: AuthContext }
  | { kind: 'unauthorized'; reason: AuthFailureReason };

export async function authenticateRequestPg(
  headers: {
    authorization?: string;
    cookie?: string;
  },
  env: JwksEnv | null,
): Promise<AuthOutcome> {
  if (env) {
    // Worker mode — strict JWT verification, no fallback.
    maybeWarnAboutWorkerDevStub();
    const ebAt = parseCookieHeader(headers.cookie)[ACCESS_TOKEN_COOKIE];
    if (!ebAt) return { kind: 'unauthorized', reason: 'missing' };
    const result = await verifyJwt(ebAt, env);
    if (result.kind === 'expired') {
      return { kind: 'unauthorized', reason: 'expired' };
    }
    if (result.kind !== 'verified') {
      return { kind: 'unauthorized', reason: 'invalid' };
    }
    return {
      kind: 'authenticated',
      auth: {
        sessionId: result.sessionId ?? `session-${result.sub}`,
        userId: result.sub,
        // Cloud-era role is always 'owner' from the verified claim's
        // POV — per-talk membership/admin is enforced at the DB layer
        // by RLS, not by a role string. Caller-swap sites that still
        // gate on `auth.role === 'admin'` need to migrate to RLS
        // queries instead.
        role: 'owner',
        authType: 'bearer',
      },
    };
  }

  // Node mode — no JWKS, no cryptographic verification.
  if (devStubEnabled()) {
    return {
      kind: 'authenticated',
      auth: {
        sessionId: 'dev-session',
        userId: DEV_USER_ID,
        role: 'owner',
        authType: 'bearer',
      },
    };
  }
  return { kind: 'unauthorized', reason: 'missing' };
}

/**
 * RFC 6750 §3 challenge header for a 401 response. Differentiates
 * expired from invalid so the SPA's refresh handler can decide
 * between silent refresh and re-sign-in.
 */
export function authChallengeHeader(reason: AuthFailureReason): string {
  if (reason === 'expired') {
    return 'Bearer error="invalid_token", error_description="expired"';
  }
  if (reason === 'invalid') {
    return 'Bearer error="invalid_token"';
  }
  return 'Bearer';
}

function devStubEnabled(): boolean {
  if (typeof process === 'undefined' || !process.env) return false;
  return process.env.CLAWTALK_DEV_STUB_ENABLED === 'true';
}

// Worker-mode safety alarm: warn-once if the dev-stub gate ever ends
// up set on a Worker. Worker mode never reaches the dev-stub branch
// (env is always non-null there), but a misconfiguration via
// wrangler.toml [vars] / Workers Secret would be a security issue.
let warnedAboutWorkerDevStub = false;

function maybeWarnAboutWorkerDevStub(): void {
  if (warnedAboutWorkerDevStub) return;
  if (!devStubEnabled()) return;
  warnedAboutWorkerDevStub = true;
  logger.warn(
    'SECURITY: CLAWTALK_DEV_STUB_ENABLED=true detected while Worker env is present. The dev-stub branch is unreachable in Worker mode (env is always non-null), so this has no effect on auth — but it indicates a misconfiguration. Production should not have this var set.',
  );
}

// Test-only: reset the warn-once latch.
export function _resetWorkerDevStubWarningForTests(): void {
  warnedAboutWorkerDevStub = false;
}

/**
 * Read JwksEnv off Hono's request context (`c.env`). Returns null in
 * Node mode where the bindings aren't present. Callers downgrade to
 * dev-stub when this returns null.
 */
export function extractJwksEnv(envIn: unknown): JwksEnv | null {
  if (!envIn || typeof envIn !== 'object') return null;
  const env = envIn as Record<string, unknown>;
  const projectUrl = env.SUPABASE_PROJECT_URL;
  const kv = env.JWKS_CACHE;
  if (
    typeof projectUrl !== 'string' ||
    projectUrl.length === 0 ||
    !kv ||
    typeof (kv as { get?: unknown }).get !== 'function' ||
    typeof (kv as { put?: unknown }).put !== 'function'
  ) {
    return null;
  }
  return {
    SUPABASE_PROJECT_URL: projectUrl,
    JWKS_CACHE: kv as JwksEnv['JWKS_CACHE'],
  };
}
