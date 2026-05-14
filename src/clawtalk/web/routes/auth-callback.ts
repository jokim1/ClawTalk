// POST /api/v1/auth/callback — clawtalk Phase 5 PR 2 cookie-set endpoint.
//
// The webapp signs in to Supabase Auth client-side
// (`signInWithOAuth({ provider: 'google' })`), then hands the
// resulting `accessToken` + `refreshToken` to this endpoint, which
// translates them into HttpOnly `eb_at` / `eb_rt` cookies plus a
// fresh `eb_csrf` token.
//
// CSRF: this route is exempt — there is no cookie pair yet to
// double-submit against. We compensate with an Origin check + JWT
// shape regex + per-IP rate limit.
//
// Mirrors editorialroom's same-named route.

import { Context } from 'hono';

import { CLAWTALK_ALLOWED_ORIGINS, WEB_SECURE_COOKIES } from '../../config.js';
import {
  buildAuthCookie,
  buildCsrfCookie,
  buildRefreshCookie,
  generateCsrfToken,
} from '../cookies.js';

// Supabase refresh tokens are opaque (not JWTs) — typically 12–40
// chars of `[a-z0-9]`. We only gate against obvious garbage,
// injection, or absurd lengths; Supabase ultimately validates the
// refresh token when we hand it back to its token endpoint.
export const REFRESH_TOKEN_SHAPE = /^[A-Za-z0-9_.-]{8,512}$/;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

interface CallbackBody {
  accessToken: string;
  refreshToken: string;
}

export async function handleAuthCallback(c: Context): Promise<Response> {
  const origin = c.req.header('origin') ?? '';
  if (!origin || !CLAWTALK_ALLOWED_ORIGINS.includes(origin)) {
    return jsonError(403, 'forbidden_origin', 'Origin not allowed');
  }

  const body = await parseBody(c);
  if (!body) {
    return jsonError(
      400,
      'invalid_input',
      'Body must be { accessToken, refreshToken }',
    );
  }
  if (!JWT_SHAPE.test(body.accessToken)) {
    return jsonError(400, 'invalid_input', 'accessToken shape invalid');
  }
  if (!REFRESH_TOKEN_SHAPE.test(body.refreshToken)) {
    return jsonError(400, 'invalid_input', 'refreshToken shape invalid');
  }

  const csrfToken = generateCsrfToken();
  const headers = new Headers();
  headers.append(
    'Set-Cookie',
    buildAuthCookie(body.accessToken, { secure: WEB_SECURE_COOKIES }),
  );
  headers.append(
    'Set-Cookie',
    buildRefreshCookie(body.refreshToken, { secure: WEB_SECURE_COOKIES }),
  );
  headers.append(
    'Set-Cookie',
    buildCsrfCookie(csrfToken, { secure: WEB_SECURE_COOKIES }),
  );
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 204, headers });
}

async function parseBody(c: Context): Promise<CallbackBody | null> {
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.accessToken !== 'string') return null;
  if (typeof obj.refreshToken !== 'string') return null;
  return { accessToken: obj.accessToken, refreshToken: obj.refreshToken };
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
