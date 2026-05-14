// POST /api/v1/auth/refresh — clawtalk Phase 5 PR 2.
//
// Reads the eb_rt cookie (HttpOnly, Path=/api/v1/auth/refresh), calls
// Supabase's /auth/v1/token?grant_type=refresh_token, and on success
// sets a brand-new eb_at + eb_rt + eb_csrf trio. Single-use refresh:
// Supabase invalidates the outgoing refresh token server-side as soon
// as a new one is issued, so the SPA must always treat the previous
// pair as gone after a successful call.
//
// Failure responses emit RFC 6750 §3 `WWW-Authenticate` so the SPA
// can distinguish "refresh expired → re-sign-in" from "upstream down".
//
// CSRF: this route is exempt — there's no cookie/header pair to
// double-submit when eb_at is already expired. Origin check enforces
// same-origin parity with auth-callback.ts.

import { Context } from 'hono';

import { CLAWTALK_ALLOWED_ORIGINS, WEB_SECURE_COOKIES } from '../../config.js';
import {
  buildAuthCookie,
  buildCsrfCookie,
  buildRefreshCookie,
  generateCsrfToken,
  parseCookieHeader,
  REFRESH_TOKEN_COOKIE,
} from '../cookies.js';
import { authChallengeHeader } from '../middleware/auth.js';
import {
  callSupabaseAuthApi,
  extractSupabaseAuthEnv,
  type SupabaseAuthEnv,
} from '../middleware/supabase-api.js';
import { REFRESH_TOKEN_SHAPE } from './auth-callback.js';

const SUPABASE_REFRESH_PATH = '/auth/v1/token?grant_type=refresh_token';

interface RefreshSuccess {
  access_token: string;
  refresh_token: string;
}

export async function handleAuthRefresh(c: Context): Promise<Response> {
  const env = extractSupabaseAuthEnv(c.env);
  return handleAuthRefreshWithEnv(c, env);
}

// Exposed for unit tests so they can inject a fabricated env without
// having to thread Worker bindings through Hono.
export async function handleAuthRefreshWithEnv(
  c: Context,
  env: SupabaseAuthEnv | null,
): Promise<Response> {
  const origin = c.req.header('origin') ?? '';
  if (!origin || !CLAWTALK_ALLOWED_ORIGINS.includes(origin)) {
    return jsonError(403, 'forbidden_origin', 'Origin not allowed');
  }

  const cookies = parseCookieHeader(c.req.header('cookie'));
  const refreshToken = cookies[REFRESH_TOKEN_COOKIE];
  if (!refreshToken) {
    return unauthorized('missing', 'No refresh cookie present');
  }
  if (!REFRESH_TOKEN_SHAPE.test(refreshToken)) {
    return jsonError(400, 'invalid_input', 'refresh cookie shape invalid');
  }

  if (!env) {
    return jsonError(
      503,
      'service_unavailable',
      'Auth service is not configured',
    );
  }

  const result = await callSupabaseAuthApi(
    SUPABASE_REFRESH_PATH,
    { refresh_token: refreshToken },
    env,
  );

  if (result.kind === 'http_error') {
    // Supabase rejects the refresh token (reused, expired, unknown).
    if (result.status >= 400 && result.status < 500) {
      return unauthorized('expired', 'Refresh token rejected; sign in again');
    }
    return jsonError(502, 'upstream_error', 'Refresh provider unavailable');
  }
  if (result.kind === 'network_error' || result.kind === 'malformed') {
    return jsonError(502, 'upstream_error', 'Refresh provider unavailable');
  }

  const payload = parseRefreshSuccess(result.json);
  if (!payload) {
    return jsonError(502, 'upstream_error', 'Refresh response was malformed');
  }

  const csrfToken = generateCsrfToken();
  const headers = new Headers();
  headers.append(
    'Set-Cookie',
    buildAuthCookie(payload.access_token, { secure: WEB_SECURE_COOKIES }),
  );
  headers.append(
    'Set-Cookie',
    buildRefreshCookie(payload.refresh_token, { secure: WEB_SECURE_COOKIES }),
  );
  headers.append(
    'Set-Cookie',
    buildCsrfCookie(csrfToken, { secure: WEB_SECURE_COOKIES }),
  );
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 204, headers });
}

function parseRefreshSuccess(raw: unknown): RefreshSuccess | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.access_token !== 'string' || obj.access_token.length === 0) {
    return null;
  }
  if (typeof obj.refresh_token !== 'string' || obj.refresh_token.length === 0) {
    return null;
  }
  return {
    access_token: obj.access_token,
    refresh_token: obj.refresh_token,
  };
}

function unauthorized(
  reason: 'missing' | 'expired',
  message: string,
): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code: 'unauthorized', message },
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'www-authenticate': authChallengeHeader(reason),
      },
    },
  );
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
