// clawtalk Phase 5 PR 2 — auth route tests.
//
// Covers auth-callback / auth-refresh / auth-logout. Sets up a tiny
// Hono app that mounts each route, then drives it via fetch().

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLAWTALK_ALLOWED_ORIGINS } from '../../config.js';
import { handleAuthCallback } from './auth-callback.js';
import { handleAuthLogoutWithEnv } from './auth-logout.js';
import { handleAuthRefresh, handleAuthRefreshWithEnv } from './auth-refresh.js';
import type { SupabaseAuthEnv } from '../middleware/supabase-api.js';

const VALID_ORIGIN = CLAWTALK_ALLOWED_ORIGINS[0] ?? 'http://localhost:5173';
const VALID_JWT =
  // header.payload.signature — shape-valid, not signature-valid (we
  // never verify in the callback; auth.ts verifies on the next request).
  'eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ' +
  '.eyJzdWIiOiJ4In0' +
  '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const VALID_RT = 'vlu4rmwiftyrabc123xyz';

function buildApp() {
  const app = new Hono();
  app.post('/api/v1/auth/callback', handleAuthCallback);
  app.post('/api/v1/auth/refresh', handleAuthRefresh);
  // logout/refresh-with-env are exercised through their _WithEnv
  // siblings directly so tests don't need to thread Worker bindings.
  return app;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── auth-callback ──────────────────────────────────────────────────

describe('POST /api/v1/auth/callback', () => {
  it('sets three cookies on a valid body + allowed origin', async () => {
    const app = buildApp();
    const res = await app.request('/api/v1/auth/callback', {
      method: 'POST',
      headers: {
        origin: VALID_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        accessToken: VALID_JWT,
        refreshToken: VALID_RT,
      }),
    });
    expect(res.status).toBe(204);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies).toHaveLength(3);
    expect(setCookies.some((c) => c.startsWith('eb_at='))).toBe(true);
    expect(setCookies.some((c) => c.startsWith('eb_rt='))).toBe(true);
    expect(setCookies.some((c) => c.startsWith('eb_csrf='))).toBe(true);
    // eb_at + eb_rt are HttpOnly; eb_csrf is not.
    expect(setCookies.find((c) => c.startsWith('eb_at'))).toMatch(/HttpOnly/);
    expect(setCookies.find((c) => c.startsWith('eb_csrf'))).not.toMatch(
      /HttpOnly/,
    );
  });

  it('rejects an unknown origin with 403', async () => {
    const app = buildApp();
    const res = await app.request('/api/v1/auth/callback', {
      method: 'POST',
      headers: {
        origin: 'https://attacker.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        accessToken: VALID_JWT,
        refreshToken: VALID_RT,
      }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a malformed JWT shape with 400', async () => {
    const app = buildApp();
    const res = await app.request('/api/v1/auth/callback', {
      method: 'POST',
      headers: {
        origin: VALID_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        accessToken: 'not-a-jwt',
        refreshToken: VALID_RT,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed refresh token shape with 400', async () => {
    const app = buildApp();
    const res = await app.request('/api/v1/auth/callback', {
      method: 'POST',
      headers: {
        origin: VALID_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        accessToken: VALID_JWT,
        refreshToken: '!!!',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a missing body field with 400', async () => {
    const app = buildApp();
    const res = await app.request('/api/v1/auth/callback', {
      method: 'POST',
      headers: {
        origin: VALID_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ accessToken: VALID_JWT }),
    });
    expect(res.status).toBe(400);
  });
});

// ── auth-refresh ───────────────────────────────────────────────────

const REFRESH_ENV: SupabaseAuthEnv = {
  SUPABASE_PROJECT_URL: 'https://test-project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'pk_test',
};

function newReq(opts: { cookie?: string; origin?: string }): Request {
  const headers = new Headers();
  if (opts.cookie) headers.set('cookie', opts.cookie);
  headers.set('origin', opts.origin ?? VALID_ORIGIN);
  return new Request('https://app.test/api/v1/auth/refresh', {
    method: 'POST',
    headers,
  });
}

async function callRefresh(
  req: Request,
  env: SupabaseAuthEnv | null,
): Promise<Response> {
  // Mount on a tiny Hono app so handleAuthRefreshWithEnv gets a
  // proper Context. Skips the c.env extraction (the _WithEnv variant
  // takes env directly).
  const app = new Hono();
  app.post('/api/v1/auth/refresh', (c) => handleAuthRefreshWithEnv(c, env));
  return app.fetch(req);
}

describe('POST /api/v1/auth/refresh', () => {
  it('rejects unknown origin with 403', async () => {
    const res = await callRefresh(
      newReq({ origin: 'https://attacker.example' }),
      REFRESH_ENV,
    );
    expect(res.status).toBe(403);
  });

  it('returns 401 when eb_rt cookie is missing', async () => {
    const res = await callRefresh(newReq({}), REFRESH_ENV);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('returns 400 when eb_rt cookie shape is invalid', async () => {
    const res = await callRefresh(newReq({ cookie: 'eb_rt=!!!' }), REFRESH_ENV);
    expect(res.status).toBe(400);
  });

  it('returns 503 when env is missing', async () => {
    const res = await callRefresh(
      newReq({ cookie: `eb_rt=${VALID_RT}` }),
      null,
    );
    expect(res.status).toBe(503);
  });

  it('on supabase 4xx → 401 expired + WWW-Authenticate', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    );
    const res = await callRefresh(
      newReq({ cookie: `eb_rt=${VALID_RT}` }),
      REFRESH_ENV,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/expired/);
  });

  it('on supabase network error → 502', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down');
    });
    const res = await callRefresh(
      newReq({ cookie: `eb_rt=${VALID_RT}` }),
      REFRESH_ENV,
    );
    expect(res.status).toBe(502);
  });

  it('on supabase success → 204 with new cookie trio', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            access_token: VALID_JWT,
            refresh_token: VALID_RT + '-new',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const res = await callRefresh(
      newReq({ cookie: `eb_rt=${VALID_RT}` }),
      REFRESH_ENV,
    );
    expect(res.status).toBe(204);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies).toHaveLength(3);
    expect(setCookies.find((c) => c.startsWith('eb_rt='))).toMatch(
      new RegExp(`eb_rt=${VALID_RT}-new`),
    );
  });
});

// ── auth-logout ────────────────────────────────────────────────────

async function callLogout(
  req: Request,
  env: SupabaseAuthEnv | null,
): Promise<Response> {
  const app = new Hono();
  app.post('/api/v1/auth/logout', (c) => handleAuthLogoutWithEnv(c, env));
  return app.fetch(req);
}

describe('POST /api/v1/auth/logout', () => {
  it('rejects unknown origin with 403', async () => {
    const req = new Request('https://app.test/api/v1/auth/logout', {
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
    });
    const res = await callLogout(req, REFRESH_ENV);
    expect(res.status).toBe(403);
  });

  it('clears cookies even when env is null (best-effort)', async () => {
    const req = new Request('https://app.test/api/v1/auth/logout', {
      method: 'POST',
      headers: { origin: VALID_ORIGIN },
    });
    const res = await callLogout(req, null);
    expect(res.status).toBe(204);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies).toHaveLength(3);
    for (const c of setCookies) {
      expect(c).toMatch(/Max-Age=0/);
    }
  });

  it('calls Supabase logout when env + access token are present', async () => {
    let calledWith: { url: string; auth: string | null } | null = null;
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calledWith = {
        url: String(url),
        auth: headers.get('authorization'),
      };
      return new Response(null, { status: 204 });
    });
    const req = new Request('https://app.test/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        origin: VALID_ORIGIN,
        cookie: `eb_at=${VALID_JWT}`,
      },
    });
    const res = await callLogout(req, REFRESH_ENV);
    expect(res.status).toBe(204);
    expect(calledWith).not.toBeNull();
    const captured = calledWith as unknown as {
      url: string;
      auth: string | null;
    };
    expect(captured.url).toMatch(/\/auth\/v1\/logout$/);
    expect(captured.auth).toBe(`Bearer ${VALID_JWT}`);
  });
});
