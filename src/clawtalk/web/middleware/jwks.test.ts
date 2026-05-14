// clawtalk Phase 5 PR 2 — JWKS verifier tests.
//
// Generates an ES256 keypair in-process, mints test JWTs with the
// private key, and exposes the public key as JWKS via a fake KV +
// fake fetch. Covers cache hit / cold fetch / kid rotation / fetch
// failure paths.

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

import { type JwksEnv, type JwksKvNamespace, verifyJwt } from './jwks.js';

const PROJECT_URL = 'https://test-project.supabase.co';
const ISSUER = `${PROJECT_URL}/auth/v1`;
const JWKS_URL = `${PROJECT_URL}/auth/v1/.well-known/jwks.json`;
const KID_PRIMARY = 'test-key-1';
const KID_SECONDARY = 'test-key-2';

let primaryPrivateKey: KeyLike;
let primaryPublicJwk: JWK;
let secondaryPrivateKey: KeyLike;
let secondaryPublicJwk: JWK;

class FakeKv implements JwksKvNamespace {
  private store = new Map<string, string>();
  putCount = 0;

  async get(key: string, type?: 'json' | 'text'): Promise<unknown> {
    const val = this.store.get(key);
    if (val === undefined) return null;
    if (type === 'json') return JSON.parse(val);
    return val;
  }

  async put(
    key: string,
    value: string,
    _opts?: { expirationTtl?: number },
  ): Promise<void> {
    this.store.set(key, value);
    this.putCount += 1;
  }

  primeWith(jwks: JSONWebKeySet): void {
    this.store.set('supabase-jwks-v1', JSON.stringify(jwks));
  }

  has(key: string): boolean {
    return this.store.has(key);
  }
}

interface FetchState {
  body: JSONWebKeySet | null;
  status: number;
  failures: number;
  callCount: number;
}

const fetchState: FetchState = {
  body: null,
  status: 200,
  failures: 0,
  callCount: 0,
};

function setJwksResponse(jwks: JSONWebKeySet): void {
  fetchState.body = jwks;
  fetchState.status = 200;
  fetchState.failures = 0;
}

function jwksOf(jwks: JWK[]): JSONWebKeySet {
  return { keys: jwks };
}

async function mintJwt(input: {
  privateKey: KeyLike;
  kid: string;
  sub?: string;
  sessionId?: string;
  email?: string;
  expSeconds?: number;
  issuer?: string;
}): Promise<string> {
  return await new SignJWT({
    session_id: input.sessionId ?? 'session-test',
    email: input.email ?? 'user@test.example',
  })
    .setProtectedHeader({ alg: 'ES256', kid: input.kid })
    .setIssuedAt()
    .setIssuer(input.issuer ?? ISSUER)
    .setSubject(input.sub ?? '00000000-0000-0000-0000-0000000000aa')
    .setExpirationTime(
      input.expSeconds === undefined
        ? '1h'
        : Math.floor(Date.now() / 1000) + input.expSeconds,
    )
    .sign(input.privateKey);
}

function buildEnv(kv: JwksKvNamespace = new FakeKv()): JwksEnv {
  return { JWKS_CACHE: kv, SUPABASE_PROJECT_URL: PROJECT_URL };
}

beforeAll(async () => {
  const primary = await generateKeyPair('ES256', { extractable: true });
  primaryPrivateKey = primary.privateKey;
  primaryPublicJwk = await exportJWK(primary.publicKey);
  primaryPublicJwk.kid = KID_PRIMARY;
  primaryPublicJwk.use = 'sig';
  primaryPublicJwk.alg = 'ES256';

  const secondary = await generateKeyPair('ES256', { extractable: true });
  secondaryPrivateKey = secondary.privateKey;
  secondaryPublicJwk = await exportJWK(secondary.publicKey);
  secondaryPublicJwk.kid = KID_SECONDARY;
  secondaryPublicJwk.use = 'sig';
  secondaryPublicJwk.alg = 'ES256';
});

beforeEach(() => {
  fetchState.body = jwksOf([primaryPublicJwk]);
  fetchState.status = 200;
  fetchState.failures = 0;
  fetchState.callCount = 0;

  vi.stubGlobal('fetch', async (url: string | URL) => {
    fetchState.callCount += 1;
    expect(String(url)).toBe(JWKS_URL);
    if (fetchState.failures > 0) {
      fetchState.failures -= 1;
      return new Response('boom', { status: fetchState.status });
    }
    if (!fetchState.body) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(fetchState.body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifyJwt — happy path', () => {
  it('verifies a well-formed JWT with cached JWKS, no fetch needed', async () => {
    const kv = new FakeKv();
    kv.primeWith(jwksOf([primaryPublicJwk]));
    const env = buildEnv(kv);
    const jwt = await mintJwt({
      privateKey: primaryPrivateKey,
      kid: KID_PRIMARY,
      sub: '11111111-1111-1111-1111-111111111111',
      sessionId: 'session-aaaa',
      email: 'aa@test.example',
    });
    const result = await verifyJwt(jwt, env);
    if (result.kind !== 'verified') {
      throw new Error(`expected verified, got ${result.kind}`);
    }
    expect(result.sub).toBe('11111111-1111-1111-1111-111111111111');
    expect(result.sessionId).toBe('session-aaaa');
    expect(result.email).toBe('aa@test.example');
    expect(fetchState.callCount).toBe(0);
  });

  it('fetches JWKS on cold cache and writes back to KV', async () => {
    const kv = new FakeKv();
    const env = buildEnv(kv);
    const jwt = await mintJwt({
      privateKey: primaryPrivateKey,
      kid: KID_PRIMARY,
    });
    const result = await verifyJwt(jwt, env);
    expect(result.kind).toBe('verified');
    expect(fetchState.callCount).toBe(1);
    expect(kv.has('supabase-jwks-v1')).toBe(true);
    expect(kv.putCount).toBe(1);
  });
});

describe('verifyJwt — kid rotation', () => {
  it('refetches when cached JWKS misses the kid, then succeeds', async () => {
    const kv = new FakeKv();
    // Prime cache with only the secondary key.
    kv.primeWith(jwksOf([secondaryPublicJwk]));
    // Endpoint returns both keys after rotation.
    setJwksResponse(jwksOf([primaryPublicJwk, secondaryPublicJwk]));

    const jwt = await mintJwt({
      privateKey: primaryPrivateKey,
      kid: KID_PRIMARY,
    });
    const result = await verifyJwt(jwt, buildEnv(kv));
    expect(result.kind).toBe('verified');
    // Single retry — refetched once after the kid miss.
    expect(fetchState.callCount).toBe(1);
  });

  it('returns invalid when kid is still missing after refetch', async () => {
    const kv = new FakeKv();
    kv.primeWith(jwksOf([secondaryPublicJwk]));
    // Endpoint also doesn't know about the kid the JWT was signed with.
    setJwksResponse(jwksOf([secondaryPublicJwk]));

    const jwt = await mintJwt({
      privateKey: primaryPrivateKey,
      kid: KID_PRIMARY,
    });
    const result = await verifyJwt(jwt, buildEnv(kv));
    expect(result.kind).toBe('invalid');
  });
});

describe('verifyJwt — failure modes', () => {
  it('returns expired for a JWT past its exp', async () => {
    const kv = new FakeKv();
    kv.primeWith(jwksOf([primaryPublicJwk]));
    const jwt = await mintJwt({
      privateKey: primaryPrivateKey,
      kid: KID_PRIMARY,
      expSeconds: -60,
    });
    const result = await verifyJwt(jwt, buildEnv(kv));
    expect(result.kind).toBe('expired');
  });

  it('returns invalid for a JWT with the wrong issuer', async () => {
    const kv = new FakeKv();
    kv.primeWith(jwksOf([primaryPublicJwk]));
    const jwt = await mintJwt({
      privateKey: primaryPrivateKey,
      kid: KID_PRIMARY,
      issuer: 'https://attacker.example/auth/v1',
    });
    const result = await verifyJwt(jwt, buildEnv(kv));
    expect(result.kind).toBe('invalid');
  });

  it('returns invalid when JWKS fetch fails on cold cache', async () => {
    const kv = new FakeKv();
    fetchState.body = null;
    const jwt = await mintJwt({
      privateKey: primaryPrivateKey,
      kid: KID_PRIMARY,
    });
    const result = await verifyJwt(jwt, buildEnv(kv));
    expect(result.kind).toBe('invalid');
  });

  it('returns invalid when JWT signature is forged', async () => {
    const kv = new FakeKv();
    // Cache only the primary key — but mint with the secondary's
    // private key carrying the primary's kid (signature won't match).
    kv.primeWith(jwksOf([primaryPublicJwk]));
    const jwt = await mintJwt({
      privateKey: secondaryPrivateKey,
      kid: KID_PRIMARY,
    });
    const result = await verifyJwt(jwt, buildEnv(kv));
    expect(result.kind).toBe('invalid');
  });
});
