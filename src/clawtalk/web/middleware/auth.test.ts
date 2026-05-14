// clawtalk Phase 5 PR 2 — auth middleware + CSRF tests.
//
// Covers:
//   - authenticateRequestPg in Worker mode (verifies signed JWT via
//     stubbed JWKS) and Node mode (dev-stub gate).
//   - csrf-pg.ts double-submit validation.
//   - cookies.ts builders / parser.
//
// JWKS verification path itself is already covered in jwks.test.ts;
// here we just confirm the middleware wires through correctly.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK, JSONWebKeySet, KeyLike } from 'jose';

import {
  ACCESS_TOKEN_COOKIE,
  CSRF_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  buildAuthCookie,
  buildCsrfCookie,
  buildRefreshCookie,
  clearAuthCookies,
  generateCsrfToken,
  parseCookieHeader,
} from '../cookies.js';
import {
  _resetWorkerDevStubWarningForTests,
  authChallengeHeader,
  authenticateRequestPg,
  extractJwksEnv,
} from './auth.js';
import { validateCsrfTokenPg } from './csrf.js';
import type { JwksEnv, JwksKvNamespace } from './jwks.js';

const PROJECT_URL = 'https://test-project.supabase.co';
const ISSUER = `${PROJECT_URL}/auth/v1`;
const JWKS_URL = `${PROJECT_URL}/auth/v1/.well-known/jwks.json`;
const KID = 'auth-mw-key';

let privateKey: KeyLike;
let publicJwk: JWK;

class FakeKv implements JwksKvNamespace {
  private store = new Map<string, string>();
  async get(key: string, type?: 'json' | 'text'): Promise<unknown> {
    const val = this.store.get(key);
    if (val === undefined) return null;
    if (type === 'json') return JSON.parse(val);
    return val;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  primeWith(jwks: JSONWebKeySet): void {
    this.store.set('supabase-jwks-v1', JSON.stringify(jwks));
  }
}

function buildEnv(kv: JwksKvNamespace = new FakeKv()): JwksEnv {
  return { JWKS_CACHE: kv, SUPABASE_PROJECT_URL: PROJECT_URL };
}

async function mintJwt(opts?: {
  sub?: string;
  expSeconds?: number;
}): Promise<string> {
  return await new SignJWT({
    session_id: 'session-x',
    email: 'x@test.example',
  })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setSubject(opts?.sub ?? '00000000-0000-0000-0000-0000000000aa')
    .setExpirationTime(
      opts?.expSeconds === undefined
        ? '1h'
        : Math.floor(Date.now() / 1000) + opts.expSeconds,
    )
    .sign(privateKey);
}

beforeAll(async () => {
  const kp = await generateKeyPair('ES256', { extractable: true });
  privateKey = kp.privateKey;
  publicJwk = await exportJWK(kp.publicKey);
  publicJwk.kid = KID;
  publicJwk.use = 'sig';
  publicJwk.alg = 'ES256';
});

beforeEach(() => {
  delete process.env.CLAWTALK_DEV_STUB_ENABLED;
  _resetWorkerDevStubWarningForTests();
  vi.stubGlobal('fetch', async (url: string | URL) => {
    expect(String(url)).toBe(JWKS_URL);
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── cookies.ts ─────────────────────────────────────────────────────

describe('cookies', () => {
  it('parseCookieHeader: decodes encoded values + ignores empty parts', () => {
    expect(parseCookieHeader('eb_at=abc; eb_csrf=de%20f')).toEqual({
      eb_at: 'abc',
      eb_csrf: 'de f',
    });
    expect(parseCookieHeader(undefined)).toEqual({});
  });

  it('build*Cookie: secure flag on/off; path is per-cookie', () => {
    expect(buildAuthCookie('jwt', { secure: true })).toMatch(
      /^eb_at=jwt; Path=\/; Max-Age=\d+; SameSite=Lax; HttpOnly; Secure$/,
    );
    expect(buildRefreshCookie('rt', { secure: false })).toMatch(
      /^eb_rt=rt; Path=\/api\/v1\/auth\/refresh; Max-Age=\d+; SameSite=Strict; HttpOnly$/,
    );
    expect(buildCsrfCookie('csrf', { secure: true })).toMatch(
      /^eb_csrf=csrf; Path=\/; Max-Age=\d+; SameSite=Lax; Secure$/,
    );
    // eb_csrf is intentionally NOT HttpOnly (SPA reads it).
    expect(buildCsrfCookie('x', { secure: true })).not.toMatch(/HttpOnly/);
  });

  it('clearAuthCookies: three Max-Age=0 cookies, paths match builders', () => {
    const cleared = clearAuthCookies({ secure: false });
    expect(cleared).toHaveLength(3);
    expect(cleared[0]).toMatch(/^eb_at=; .*Max-Age=0/);
    expect(cleared[1]).toMatch(/^eb_rt=; .*Path=\/api\/v1\/auth\/refresh/);
    expect(cleared[2]).toMatch(/^eb_csrf=;/);
  });

  it('generateCsrfToken: base64url, 43 chars (32 bytes encoded)', () => {
    const t = generateCsrfToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateCsrfToken()).not.toBe(t);
  });
});

// ── authenticateRequestPg ──────────────────────────────────────────

describe('authenticateRequestPg — Worker mode', () => {
  it('returns authenticated when eb_at verifies', async () => {
    const kv = new FakeKv();
    kv.primeWith({ keys: [publicJwk] });
    const env = buildEnv(kv);
    const jwt = await mintJwt({
      sub: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    const result = await authenticateRequestPg(
      { cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}` },
      env,
    );
    if (result.kind !== 'authenticated') {
      throw new Error(`expected authenticated, got ${result.kind}`);
    }
    expect(result.auth.userId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(result.auth.role).toBe('owner');
    expect(result.auth.authType).toBe('bearer');
  });

  it('returns unauthorized.missing when eb_at cookie is absent', async () => {
    const env = buildEnv();
    const result = await authenticateRequestPg({ cookie: '' }, env);
    expect(result).toEqual({ kind: 'unauthorized', reason: 'missing' });
  });

  it('returns unauthorized.expired for an expired JWT', async () => {
    const kv = new FakeKv();
    kv.primeWith({ keys: [publicJwk] });
    const env = buildEnv(kv);
    const jwt = await mintJwt({ expSeconds: -60 });
    const result = await authenticateRequestPg(
      { cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}` },
      env,
    );
    expect(result).toEqual({ kind: 'unauthorized', reason: 'expired' });
  });

  it('returns unauthorized.invalid for a bogus cookie', async () => {
    const env = buildEnv();
    const result = await authenticateRequestPg(
      { cookie: `${ACCESS_TOKEN_COOKIE}=not-a-jwt-at-all` },
      env,
    );
    expect(result).toEqual({ kind: 'unauthorized', reason: 'invalid' });
  });
});

describe('authenticateRequestPg — Node mode (env=null)', () => {
  it('grants dev-stub auth when CLAWTALK_DEV_STUB_ENABLED=true', async () => {
    process.env.CLAWTALK_DEV_STUB_ENABLED = 'true';
    const result = await authenticateRequestPg({ cookie: '' }, null);
    if (result.kind !== 'authenticated') {
      throw new Error(`expected authenticated, got ${result.kind}`);
    }
    expect(result.auth.userId).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('returns unauthorized.missing when dev-stub is off', async () => {
    const result = await authenticateRequestPg(
      { cookie: 'eb_at=anything' },
      null,
    );
    expect(result).toEqual({ kind: 'unauthorized', reason: 'missing' });
  });
});

describe('authChallengeHeader', () => {
  it('emits expired vs invalid vs missing forms', () => {
    expect(authChallengeHeader('expired')).toMatch(/expired/);
    expect(authChallengeHeader('invalid')).toMatch(/invalid_token/);
    expect(authChallengeHeader('missing')).toBe('Bearer');
  });
});

describe('extractJwksEnv', () => {
  it('returns null when bindings are missing', () => {
    expect(extractJwksEnv(null)).toBeNull();
    expect(extractJwksEnv({})).toBeNull();
    expect(extractJwksEnv({ SUPABASE_PROJECT_URL: 'https://x' })).toBeNull();
  });

  it('returns env when SUPABASE_PROJECT_URL + JWKS_CACHE are present', () => {
    const kv = new FakeKv();
    const got = extractJwksEnv({
      SUPABASE_PROJECT_URL: 'https://x',
      JWKS_CACHE: kv,
    });
    expect(got?.SUPABASE_PROJECT_URL).toBe('https://x');
  });
});

// ── validateCsrfTokenPg ────────────────────────────────────────────

describe('validateCsrfTokenPg', () => {
  it('skips validation for GET/HEAD/OPTIONS', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(
        validateCsrfTokenPg({
          method,
          authType: 'cookie',
          cookieHeader: '',
        }),
      ).toEqual({ ok: true });
    }
  });

  it('skips validation for bearer auth (no CSRF for API clients)', () => {
    expect(
      validateCsrfTokenPg({
        method: 'POST',
        authType: 'bearer',
        cookieHeader: '',
      }),
    ).toEqual({ ok: true });
  });

  it('rejects when CSRF cookie is missing', () => {
    expect(
      validateCsrfTokenPg({
        method: 'POST',
        authType: 'cookie',
        cookieHeader: '',
        csrfHeader: 'whatever',
      }),
    ).toEqual({ ok: false, reason: 'Missing CSRF cookie' });
  });

  it('rejects when X-CSRF-Token header is missing', () => {
    expect(
      validateCsrfTokenPg({
        method: 'POST',
        authType: 'cookie',
        cookieHeader: `${CSRF_TOKEN_COOKIE}=abc`,
      }),
    ).toEqual({ ok: false, reason: 'Missing X-CSRF-Token header' });
  });

  it('rejects when tokens mismatch', () => {
    expect(
      validateCsrfTokenPg({
        method: 'POST',
        authType: 'cookie',
        cookieHeader: `${CSRF_TOKEN_COOKIE}=abc`,
        csrfHeader: 'xyz',
      }),
    ).toEqual({ ok: false, reason: 'CSRF token mismatch' });
  });

  it('passes when tokens match', () => {
    expect(
      validateCsrfTokenPg({
        method: 'PATCH',
        authType: 'cookie',
        cookieHeader: `${REFRESH_TOKEN_COOKIE}=foo; ${CSRF_TOKEN_COOKIE}=abc`,
        csrfHeader: 'abc',
      }),
    ).toEqual({ ok: true });
  });
});
