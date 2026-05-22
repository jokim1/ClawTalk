// Google Tools OAuth service.
//
// Provides the PKCE start + callback flow used by /api/v1/me/google-account/*
// routes. The OAuth state lives in the `oauth_state` table (provider scope =
// 'google_tools'); credentials live encrypted in `user_google_credentials`.
//
// Boundary contract:
//   - `startGoogleOAuth` must be called from inside `withUserContext(userId)`.
//     RLS on `oauth_state` enforces user_id = auth.uid() at INSERT time.
//   - `completeGoogleOAuthCallback` is called from a PUBLIC callback route
//     (no auth.uid()). The connection pool is the BYPASSRLS `postgres` role,
//     so the atomic state claim runs without an RLS scope. After claiming
//     the row, the helper itself enters `withUserContext(claimed.user_id)`
//     before any credential write happens.
//
// Hash semantics (D2 + C4):
//   state_hash         = sha256(raw_state)
//   nonce_hash         = sha256(raw_nonce)
//   code_verifier_hash = sha256(raw_code_verifier)   (audit / defense-in-depth)
//   code_verifier      = raw_code_verifier            (PKCE token exchange needs raw)
// URLs carry the raw values; storage carries the hashes.

import { randomBytes, createHash } from 'crypto';

import { createRemoteJWKSet, jwtVerify } from 'jose';

import { getDbPg, withUserContext } from '../../db.js';
import {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
} from '../config.js';
import {
  deleteUserGoogleCredential,
  getUserGoogleCredential,
  upsertUserGoogleCredential,
  type UserGoogleCredentialRecord,
} from '../db/talk-tools-accessors.js';

import {
  decryptGoogleToolCredential,
  encryptGoogleToolCredential,
  type GoogleToolCredentialPayload,
} from './google-tools-credential-store.js';
import {
  expandGoogleScopeAliases,
  normalizeGoogleScopeAliases,
} from './google-scopes.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER = 'google_tools';
const STATE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUER = 'https://accounts.google.com';

// C3: OIDC scopes are mandatory — Google does not return an id_token
// without them, and we need the id_token for nonce verification + sub/email
// extraction. ensureOidcScopes() always merges these into the request.
const OIDC_SCOPES = ['openid', 'email', 'profile'] as const;

// C7: scope allowlist. Any alias outside this set → 400 from
// validateRequestedScopes. Prevents authenticated users from coercing the
// OAuth client into Gmail / arbitrary Google scopes.
const ALLOWED_SCOPE_ALIASES = new Set<string>([
  'openid',
  'email',
  'profile',
  'drive.readonly',
  'documents',
  'documents.readonly',
  'spreadsheets',
  'spreadsheets.readonly',
]);

// JWKS singleton — `jose` handles fetch + TTL caching internally.
const googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GoogleOAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'GoogleOAuthError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomBase64Url(byteLen: number): string {
  return base64url(randomBytes(byteLen));
}

function sha256Base64Url(input: string): string {
  return base64url(createHash('sha256').update(input).digest());
}

// ---------------------------------------------------------------------------
// Scope validation (C3 + C7)
// ---------------------------------------------------------------------------

export function validateRequestedScopes(
  scopes: string[] | undefined,
): string[] {
  const cleaned = (scopes ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const scope of cleaned) {
    if (!ALLOWED_SCOPE_ALIASES.has(scope)) {
      throw new GoogleOAuthError(
        'invalid_scope',
        `Scope '${scope}' is not allowed.`,
        400,
      );
    }
  }
  return cleaned;
}

export function ensureOidcScopes(scopes: string[]): string[] {
  const set = new Set(scopes);
  for (const oidc of OIDC_SCOPES) set.add(oidc);
  return Array.from(set);
}

// ---------------------------------------------------------------------------
// Identity / auth-url result types
// ---------------------------------------------------------------------------

export interface StartGoogleOAuthInput {
  userId: string;
  scopes: string[]; // alias form; OIDC scopes added by caller via ensureOidcScopes
  redirectUri: string;
  returnTo?: string | null;
}

export interface StartGoogleOAuthResult {
  authorizationUrl: string;
  expiresInSec: number;
}

export interface CompleteGoogleOAuthCallbackInput {
  rawState: string;
  code: string | null;
  googleError: string | null;
}

export interface CompleteGoogleOAuthCallbackResult {
  status: 'success' | 'denied' | 'error';
  errorCode?: string;
  message?: string;
}

interface GoogleIdentity {
  googleSubject: string;
  email: string;
  displayName: string | null;
  accessToken: string;
  refreshToken: string | null;
  scopes: string[]; // full URL form
  tokenType: string;
  expiresInSec: number;
}

// ---------------------------------------------------------------------------
// startGoogleOAuth
// ---------------------------------------------------------------------------

export async function startGoogleOAuth(
  input: StartGoogleOAuthInput,
): Promise<StartGoogleOAuthResult> {
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new GoogleOAuthError(
      'config_missing',
      'Google OAuth client credentials are not configured on this server.',
      503,
    );
  }
  if (!input.redirectUri) {
    throw new GoogleOAuthError(
      'config_missing',
      'GOOGLE_OAUTH_REDIRECT_URI is not configured.',
      503,
    );
  }

  const rawState = randomBase64Url(32);
  const rawNonce = randomBase64Url(32);
  const rawCodeVerifier = randomBase64Url(64);
  const stateHash = sha256Base64Url(rawState);
  const nonceHash = sha256Base64Url(rawNonce);
  const codeVerifierHash = sha256Base64Url(rawCodeVerifier);
  const codeChallenge = sha256Base64Url(rawCodeVerifier);
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();

  const db = getDbPg();
  await db`
    insert into public.oauth_state
      (user_id, provider, state_hash, nonce_hash, code_verifier_hash,
       code_verifier, redirect_uri, return_to, expires_at)
    values
      (${input.userId}::uuid, ${PROVIDER}, ${stateHash}, ${nonceHash},
       ${codeVerifierHash}, ${rawCodeVerifier}, ${input.redirectUri},
       ${input.returnTo ?? null}, ${expiresAt}::timestamptz)
  `;

  const scopeUrls = expandGoogleScopeAliases(input.scopes);
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    scope: scopeUrls.join(' '),
    state: rawState,
    nonce: rawNonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });

  return {
    authorizationUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`,
    expiresInSec: Math.floor(STATE_TTL_MS / 1000),
  };
}

// ---------------------------------------------------------------------------
// completeGoogleOAuthCallback
// ---------------------------------------------------------------------------

interface ClaimedStateRow {
  id: string;
  user_id: string;
  provider: string;
  state_hash: string;
  nonce_hash: string;
  code_verifier: string | null;
  redirect_uri: string;
  return_to: string | null;
  expires_at: string;
}

export async function completeGoogleOAuthCallback(
  input: CompleteGoogleOAuthCallbackInput,
): Promise<CompleteGoogleOAuthCallbackResult> {
  // D2 + C4 + C5: atomic claim, hashed state, provider-scoped.
  // The callback has no auth.uid(); BYPASSRLS connection lets the DELETE run.
  const stateHash = sha256Base64Url(input.rawState);
  const db = getDbPg();
  const claimed = await db<ClaimedStateRow[]>`
    delete from public.oauth_state
    where state_hash = ${stateHash}
      and provider = ${PROVIDER}
      and expires_at > now()
    returning id, user_id, provider, state_hash, nonce_hash,
              code_verifier, redirect_uri, return_to, expires_at
  `;
  if (claimed.length === 0) {
    return {
      status: 'error',
      errorCode: 'state_invalid_or_expired',
      message: 'Connection link expired, try again.',
    };
  }
  const row = claimed[0];

  // Handle Google's ?error=access_denied path AFTER the claim (D5: state row
  // is consumed even on denial, so it can't be replayed).
  if (input.googleError === 'access_denied') {
    return {
      status: 'denied',
      errorCode: 'access_denied',
      message: 'You denied access to Google.',
    };
  }
  if (input.googleError) {
    return {
      status: 'error',
      errorCode: 'google_error',
      message: `Google returned error: ${input.googleError}`,
    };
  }
  if (!input.code) {
    return {
      status: 'error',
      errorCode: 'missing_code',
      message: 'Could not complete connection.',
    };
  }
  if (!row.code_verifier) {
    // Stored state has no code_verifier — defensive; shouldn't happen for
    // rows we wrote.
    return {
      status: 'error',
      errorCode: 'state_corrupt',
      message: 'Could not complete connection.',
    };
  }

  // C2: enter withUserContext for the credential persistence half of the
  // flow. The token exchange + id_token verify can run outside (no DB), but
  // we wrap the whole thing for simplicity and so logs carry the user id.
  return withUserContext(row.user_id, async () => {
    const identity = await exchangeCodeForIdentity({
      code: input.code as string,
      codeVerifier: row.code_verifier as string,
      redirectUri: row.redirect_uri,
      expectedNonceHash: row.nonce_hash,
    });
    await persistGoogleOAuthIdentity({ userId: row.user_id, identity });
    return { status: 'success' as const };
  });
}

async function exchangeCodeForIdentity(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  expectedNonceHash: string;
}): Promise<GoogleIdentity> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new GoogleOAuthError(
      'token_exchange_failed',
      `Token exchange failed: HTTP ${response.status}`,
      502,
    );
  }
  const tokenPayload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
  if (
    !tokenPayload.access_token ||
    typeof tokenPayload.access_token !== 'string'
  ) {
    throw new GoogleOAuthError(
      'token_exchange_failed',
      'Google did not return an access_token.',
      502,
    );
  }
  if (!tokenPayload.id_token) {
    // C3: this means OIDC scopes were not in the request — should never
    // happen because ensureOidcScopes() runs server-side. Defensive guard.
    throw new GoogleOAuthError(
      'id_token_missing',
      'Google did not return an id_token (OIDC scopes missing).',
      502,
    );
  }

  // D1: jose for signature + claim verification. Throws on any check failure
  // (alg confusion, expired, wrong issuer, wrong audience).
  const { payload: idPayload } = await jwtVerify(
    tokenPayload.id_token,
    googleJwks,
    {
      issuer: [GOOGLE_ISSUER, 'accounts.google.com'],
      audience: GOOGLE_OAUTH_CLIENT_ID,
      algorithms: ['RS256'],
    },
  );

  // C4: hash the returned nonce claim and compare against stored nonce_hash.
  // Direction matches startGoogleOAuth: stored is sha256(raw_nonce).
  if (typeof idPayload.nonce !== 'string') {
    throw new GoogleOAuthError(
      'id_token_invalid',
      'id_token missing nonce claim.',
      401,
    );
  }
  if (sha256Base64Url(idPayload.nonce) !== input.expectedNonceHash) {
    throw new GoogleOAuthError(
      'id_token_invalid',
      'id_token nonce did not match stored value.',
      401,
    );
  }
  if (typeof idPayload.sub !== 'string' || !idPayload.sub) {
    throw new GoogleOAuthError(
      'id_token_invalid',
      'id_token missing sub claim.',
      401,
    );
  }
  if (typeof idPayload.email !== 'string' || !idPayload.email) {
    throw new GoogleOAuthError(
      'id_token_invalid',
      'id_token missing email claim.',
      401,
    );
  }

  const grantedScopeUrls = (tokenPayload.scope ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    googleSubject: idPayload.sub,
    email: idPayload.email,
    displayName:
      typeof idPayload.name === 'string' && idPayload.name.length > 0
        ? idPayload.name
        : null,
    accessToken: tokenPayload.access_token,
    refreshToken: tokenPayload.refresh_token ?? null,
    scopes: grantedScopeUrls,
    tokenType: tokenPayload.token_type || 'Bearer',
    expiresInSec: tokenPayload.expires_in ?? 3600,
  };
}

// ---------------------------------------------------------------------------
// persistGoogleOAuthIdentity — internal (callable from completeGoogleOAuthCallback)
// ---------------------------------------------------------------------------

export async function persistGoogleOAuthIdentity(input: {
  userId: string;
  identity: GoogleIdentity;
}): Promise<UserGoogleCredentialRecord> {
  // Caller is responsible for being inside withUserContext(userId).
  const existing = await getUserGoogleCredential();
  let priorRefreshToken: string | null = null;
  let priorScopeAliases: string[] = [];
  if (existing) {
    try {
      const decoded = decryptGoogleToolCredential(existing.ciphertext);
      priorRefreshToken = decoded.refreshToken ?? null;
      priorScopeAliases = existing.scopes;
    } catch {
      // Corrupt ciphertext on file; treat as no prior credential.
    }
  }

  // C8: union persisted scopes with newly granted. Never shrink.
  const grantedAliases = normalizeGoogleScopeAliases(input.identity.scopes);
  const mergedAliases = Array.from(
    new Set([...priorScopeAliases, ...grantedAliases]),
  ).sort();
  const mergedScopeUrls = expandGoogleScopeAliases(mergedAliases);

  const refreshToken =
    input.identity.refreshToken ?? priorRefreshToken ?? undefined;

  const expiryDate = new Date(
    Date.now() + input.identity.expiresInSec * 1000,
  ).toISOString();

  const payload: GoogleToolCredentialPayload = {
    kind: 'google_tools',
    accessToken: input.identity.accessToken,
    refreshToken,
    expiryDate,
    scopes: mergedScopeUrls,
    tokenType: input.identity.tokenType,
  };
  const ciphertext = encryptGoogleToolCredential(payload);

  return upsertUserGoogleCredential({
    userId: input.userId,
    googleSubject: input.identity.googleSubject,
    email: input.identity.email,
    displayName: input.identity.displayName,
    scopes: mergedAliases,
    ciphertext,
    accessExpiresAt: expiryDate,
  });
}

// ---------------------------------------------------------------------------
// disconnect — thin wrapper so the route doesn't import the accessor twice
// ---------------------------------------------------------------------------

export async function disconnectGoogleAccount(): Promise<boolean> {
  return deleteUserGoogleCredential();
}
