// clawtalk Phase 5 PR 2 — JWKS-cached JWT verification for Supabase.
//
// Mirrors editorialroom's same-named module. Supabase signs `eb_at`
// access tokens with ES256 against the project's JWKS; we cache the
// JWKS in the `JWKS_CACHE` KV binding (1h TTL) for cross-isolate
// persistence and verify each request locally (no per-request fetch
// round-trip).
//
// Cache miss / `kid` rotation: re-fetch JWKS, write to KV, retry
// verification once. After one retry, give up — caller maps to 401.
//
// Failure modes are surfaced via the `kind` discriminator on
// VerifyResult so the auth middleware can emit
// `WWW-Authenticate: Bearer error="invalid_token",
// error_description="expired"` on expired tokens (triggers refresh
// rotation in the SPA fetch wrapper).

import { createLocalJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import type { JSONWebKeySet, JWTPayload } from 'jose';

const JWKS_CACHE_KEY = 'supabase-jwks-v1';
const JWKS_TTL_SECONDS = 3600;
const JWKS_FETCH_TIMEOUT_MS = 5000;

// Minimal duck-typed surface of Cloudflare's `KVNamespace`. The
// runtime binding from `wrangler.toml` ([[kv_namespaces]] / id
// to be patched in by Joseph at deploy time) satisfies this
// structurally; tests pass an in-memory Map-backed fake.
export interface JwksKvNamespace {
  get(key: string, type: 'json'): Promise<unknown>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

export interface JwksEnv {
  JWKS_CACHE: JwksKvNamespace;
  SUPABASE_PROJECT_URL: string;
}

export type VerifyResult =
  | {
      kind: 'verified';
      sub: string;
      sessionId: string | null;
      email: string | null;
    }
  | { kind: 'expired' }
  | { kind: 'invalid' };

/**
 * Verify a Supabase-issued ES256 JWT against the project JWKS.
 * Returns a verified result with the `sub` claim, or one of the
 * non-verified shapes for caller-side 401 handling.
 */
export async function verifyJwt(
  jwt: string,
  env: JwksEnv,
): Promise<VerifyResult> {
  const baseUrl = env.SUPABASE_PROJECT_URL.replace(/\/$/, '');
  const jwksUrl = `${baseUrl}/auth/v1/.well-known/jwks.json`;
  const issuer = `${baseUrl}/auth/v1`;

  let jwks = await readJwksFromCache(env.JWKS_CACHE);
  if (!jwks) {
    jwks = await fetchJwks(jwksUrl);
    if (!jwks) return { kind: 'invalid' };
    await writeJwksToCache(env.JWKS_CACHE, jwks);
  }

  const first = await tryVerify(jwt, jwks, issuer);
  if (first.kind !== 'kid_miss') return first;

  // kid not in the cached set → likely rotation. Re-fetch + retry.
  const fresh = await fetchJwks(jwksUrl);
  if (!fresh) return { kind: 'invalid' };
  await writeJwksToCache(env.JWKS_CACHE, fresh);

  const second = await tryVerify(jwt, fresh, issuer);
  return second.kind === 'kid_miss' ? { kind: 'invalid' } : second;
}

type AttemptResult = VerifyResult | { kind: 'kid_miss' };

async function tryVerify(
  jwt: string,
  jwks: JSONWebKeySet,
  issuer: string,
): Promise<AttemptResult> {
  try {
    const keySet = createLocalJWKSet(jwks);
    const { payload } = await jwtVerify(jwt, keySet, {
      issuer,
      algorithms: ['ES256'],
    });
    return claimsToResult(payload);
  } catch (err) {
    if (err instanceof joseErrors.JWKSNoMatchingKey) {
      return { kind: 'kid_miss' };
    }
    if (err instanceof joseErrors.JWTExpired) {
      return { kind: 'expired' };
    }
    return { kind: 'invalid' };
  }
}

function claimsToResult(payload: JWTPayload): VerifyResult {
  const sub = typeof payload.sub === 'string' ? payload.sub : null;
  if (!sub) return { kind: 'invalid' };
  const sessionId =
    typeof payload['session_id'] === 'string'
      ? (payload['session_id'] as string)
      : null;
  const email =
    typeof payload['email'] === 'string' ? (payload['email'] as string) : null;
  return { kind: 'verified', sub, sessionId, email };
}

async function readJwksFromCache(
  kv: JwksKvNamespace,
): Promise<JSONWebKeySet | null> {
  try {
    const cached = await kv.get(JWKS_CACHE_KEY, 'json');
    if (
      cached &&
      typeof cached === 'object' &&
      Array.isArray((cached as { keys?: unknown }).keys)
    ) {
      return cached as JSONWebKeySet;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeJwksToCache(
  kv: JwksKvNamespace,
  jwks: JSONWebKeySet,
): Promise<void> {
  try {
    await kv.put(JWKS_CACHE_KEY, JSON.stringify(jwks), {
      expirationTtl: JWKS_TTL_SECONDS,
    });
  } catch {
    // Cache write failures are non-fatal — verification still
    // succeeded for this request; the next request will re-fetch.
  }
}

async function fetchJwks(url: string): Promise<JSONWebKeySet | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), JWKS_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (
      !body ||
      typeof body !== 'object' ||
      !Array.isArray((body as { keys?: unknown }).keys)
    ) {
      return null;
    }
    return body as JSONWebKeySet;
  } catch {
    return null;
  }
}
