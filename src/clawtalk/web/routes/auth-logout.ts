// POST /api/v1/auth/logout — clawtalk Phase 5 PR 2.
//
// Best-effort logout: calls Supabase's /auth/v1/logout with the
// current access token so the server-side refresh session is killed,
// then clears the eb_at/eb_rt/eb_csrf cookies regardless of outcome.
// Even if the Supabase call fails (network down, upstream 5xx), we
// still clear cookies — the client wants out, so let them out.
//
// Mirrors editorialroom's same-named route.

import { Context } from 'hono';

import { CLAWTALK_ALLOWED_ORIGINS, WEB_SECURE_COOKIES } from '../../config.js';
import {
  ACCESS_TOKEN_COOKIE,
  clearAuthCookies,
  parseCookieHeader,
} from '../cookies.js';
import {
  callSupabaseAuthApi,
  extractSupabaseAuthEnv,
  type SupabaseAuthEnv,
} from '../middleware/supabase-api.js';

const SUPABASE_LOGOUT_PATH = '/auth/v1/logout';

export async function handleAuthLogout(c: Context): Promise<Response> {
  const env = extractSupabaseAuthEnv(c.env);
  return handleAuthLogoutWithEnv(c, env);
}

export async function handleAuthLogoutWithEnv(
  c: Context,
  env: SupabaseAuthEnv | null,
): Promise<Response> {
  const origin = c.req.header('origin') ?? '';
  if (!origin || !CLAWTALK_ALLOWED_ORIGINS.includes(origin)) {
    return jsonError(403, 'forbidden_origin', 'Origin not allowed');
  }

  const cookies = parseCookieHeader(c.req.header('cookie'));
  const accessToken = cookies[ACCESS_TOKEN_COOKIE];

  if (env && accessToken) {
    // Fire-and-forget the upstream logout. Any non-2xx is silently
    // ignored — local cookie clearing is what the client actually
    // needs to log out.
    await callSupabaseAuthApi(SUPABASE_LOGOUT_PATH, {}, env, {
      bearerToken: accessToken,
    });
  }

  const headers = new Headers();
  for (const c of clearAuthCookies({ secure: WEB_SECURE_COOKIES })) {
    headers.append('Set-Cookie', c);
  }
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 204, headers });
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
