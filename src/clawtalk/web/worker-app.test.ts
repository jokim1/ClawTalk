// clawtalk Phase 5 PR 2 — worker-app smoke tests.
//
// End-to-end exercise of the Hono app the Worker entry delegates to.
// Mints real ES256 JWTs against a stubbed JWKS, attaches them as
// the eb_at cookie, and asserts the auth-protected route reads back
// the verified userId. Mirrors the JWKS test setup.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK, KeyLike } from 'jose';

import { initPgDatabase } from '../../db.js';
import { CLAWTALK_ALLOWED_ORIGINS } from '../config.js';
import { ACCESS_TOKEN_COOKIE } from './cookies.js';
import { _resetWorkerAppForTests, getWorkerApp } from './worker-app.js';

const PROJECT_URL = 'https://test-project.supabase.co';
const ISSUER = `${PROJECT_URL}/auth/v1`;
const JWKS_URL = `${PROJECT_URL}/auth/v1/.well-known/jwks.json`;
const KID = 'worker-app-key';
const VALID_ORIGIN = CLAWTALK_ALLOWED_ORIGINS[0] ?? 'http://localhost:5173';
const VALID_JWT_SHAPE =
  'eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ' +
  '.eyJzdWIiOiJ4In0' +
  '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const VALID_RT = 'vlu4rmwiftyrabc123xyz';

let privateKey: KeyLike;
let publicJwk: JWK;
const kvStore = new Map<string, string>();

const fakeKv = {
  async get(key: string, type?: 'json' | 'text'): Promise<unknown> {
    const val = kvStore.get(key);
    if (val === undefined) return null;
    if (type === 'json') return JSON.parse(val);
    return val;
  },
  async put(key: string, value: string): Promise<void> {
    kvStore.set(key, value);
  },
};

function envForWorker(): Record<string, unknown> {
  return {
    SUPABASE_PROJECT_URL: PROJECT_URL,
    SUPABASE_PUBLISHABLE_KEY: 'pk_test',
    JWKS_CACHE: fakeKv,
  };
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
  await initPgDatabase();
  const kp = await generateKeyPair('ES256', { extractable: true });
  privateKey = kp.privateKey;
  publicJwk = await exportJWK(kp.publicKey);
  publicJwk.kid = KID;
  publicJwk.use = 'sig';
  publicJwk.alg = 'ES256';
});

afterAll(async () => {
  _resetWorkerAppForTests();
});

beforeEach(() => {
  kvStore.clear();
  // Prime the JWKS cache so verifyJwt doesn't have to fetch.
  kvStore.set('supabase-jwks-v1', JSON.stringify({ keys: [publicJwk] }));
  _resetWorkerAppForTests();
  vi.stubGlobal('fetch', async (url: string | URL) => {
    // The worker-app shouldn't reach the JWKS endpoint (cache primed),
    // but if it does, return a valid response so the test still drives.
    if (String(url) === JWKS_URL) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
      });
    }
    return new Response('not stubbed', { status: 599 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('worker-app — public routes', () => {
  it('GET /api/v1/health returns 200 with status ok', async () => {
    const app = getWorkerApp();
    const res = await app.request(
      new Request('https://app.test/api/v1/health'),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { status: string; runtime: string; db: boolean };
    };
    expect(body).toMatchObject({
      ok: true,
      data: { status: 'ok', runtime: 'workers' },
    });
    expect(typeof body.data.db).toBe('boolean');
  });

  it('POST /api/v1/auth/callback sets eb_at/eb_rt/eb_csrf', async () => {
    const app = getWorkerApp();
    const res = await app.request(
      new Request('https://app.test/api/v1/auth/callback', {
        method: 'POST',
        headers: {
          origin: VALID_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          accessToken: VALID_JWT_SHAPE,
          refreshToken: VALID_RT,
        }),
      }),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(204);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies).toHaveLength(3);
    expect(setCookies.some((c) => c.startsWith('eb_at='))).toBe(true);
    expect(setCookies.some((c) => c.startsWith('eb_rt='))).toBe(true);
    expect(setCookies.some((c) => c.startsWith('eb_csrf='))).toBe(true);
  });

  it('GET /api/v1/_unmapped returns 501 catch-all for unported routes', async () => {
    const app = getWorkerApp();
    // Use a chassis-removed path that hasn't (and won't) be mounted —
    // /api/v1/browser/* sits outside the auth-gated namespaces, so
    // the catch-all is the first matcher to fire.
    const res = await app.request(
      new Request('https://app.test/api/v1/browser/profiles'),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_implemented_in_worker');
  });
});

describe('worker-app — auth-protected routes', () => {
  it('GET /api/v1/_protected/whoami returns userId when eb_at verifies', async () => {
    const app = getWorkerApp();
    const userId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const jwt = await mintJwt({ sub: userId });
    const res = await app.request(
      new Request('https://app.test/api/v1/_protected/whoami', {
        headers: { cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}` },
      }),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      data: { userId, authType: 'bearer', role: 'owner' },
    });
  });

  it('returns 401 with WWW-Authenticate: Bearer when eb_at is missing', async () => {
    const app = getWorkerApp();
    const res = await app.request(
      new Request('https://app.test/api/v1/_protected/whoami'),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('returns 401 with expired challenge when eb_at is past exp', async () => {
    const app = getWorkerApp();
    const jwt = await mintJwt({ expSeconds: -60 });
    const res = await app.request(
      new Request('https://app.test/api/v1/_protected/whoami', {
        headers: { cookie: `${ACCESS_TOKEN_COOKIE}=${jwt}` },
      }),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/expired/);
  });

  it('returns 401 invalid when eb_at is junk', async () => {
    const app = getWorkerApp();
    const res = await app.request(
      new Request('https://app.test/api/v1/_protected/whoami', {
        headers: { cookie: `${ACCESS_TOKEN_COOKIE}=not-a-jwt` },
      }),
      undefined,
      envForWorker(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/invalid_token/);
  });
});
