// Google tools credential service.
//
// This module is the single entry point for any Worker code that needs a live
// Google access token (Drive, Docs, Picker). It owns:
//   - decrypting the stored credential
//   - refreshing access tokens against oauth2.googleapis.com
//   - enforcing the required-scope contract for each tool call
//   - building Picker SDK session payloads (oauthToken + developerKey + appId)
//
// Boundary contract:
//   Callers MUST be inside `withUserContext(userId)` before invoking any of
//   the exported functions. The underlying accessors
//   (`getUserGoogleCredential`, `upsertUserGoogleCredential`,
//   `deleteUserGoogleCredential`) rely on the request-scoped pg session
//   variable for RLS. This matches the contract documented on
//   `persistGoogleOAuthIdentity` in google-oauth-service.ts.
//
// D1 — per-isolate refresh dedup:
//   `refreshInFlight` is a module-level Map<userId, Promise>. Two concurrent
//   callers in the same isolate for the same user share a single refresh
//   Promise; the network round-trip and DB write only happen once.
//   Cross-isolate races are accepted as harmless — Google's token endpoint
//   handles duplicate refresh_token requests idempotently within its window.
//
// Storage shape:
//   - DB row `scopes_json`: alias form (e.g. 'drive.readonly', 'documents').
//   - Ciphertext payload `scopes`: URL form
//     (e.g. 'https://www.googleapis.com/auth/drive.readonly'). Matches the
//     convention established by `persistGoogleOAuthIdentity`.
//   `normalizeGoogleScopeAliases` collapses either form to aliases, so the
//   scope assertion is resilient to either storage form. We pick a convention
//   anyway so future code is easy to reason about.

import {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_PICKER_API_KEY,
  GOOGLE_PICKER_APP_ID,
} from '../config.js';
import {
  deleteUserGoogleCredential,
  getUserGoogleCredential,
  upsertUserGoogleCredential,
} from '../db/talk-tools-accessors.js';

import {
  decryptGoogleToolCredential,
  encryptGoogleToolCredential,
  type GoogleToolCredentialPayload,
} from './google-tools-credential-store.js';
import {
  GoogleToolCredentialError,
  type GoogleToolErrorCode,
} from './google-tools-errors.js';
import {
  expandImpliedScopes,
  normalizeGoogleScopeAliases,
} from './google-scopes.js';

export { GoogleToolCredentialError, type GoogleToolErrorCode };

const GOOGLE_REFRESH_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REFRESH_SKEW_MS = 60_000;

const refreshInFlight = new Map<string, Promise<GoogleToolCredentialPayload>>();

function isExpired(payload: GoogleToolCredentialPayload): boolean {
  if (!payload.expiryDate) return false;
  const expiresAt = Date.parse(payload.expiryDate);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt <= Date.now() + GOOGLE_REFRESH_SKEW_MS;
}

function assertRequiredScopes(
  payload: GoogleToolCredentialPayload,
  requiredScopes: string[],
): void {
  // Expand granted aliases by Google's scope hierarchy: a parent scope
  // (e.g. `spreadsheets`) covers its readonly child (`spreadsheets.readonly`).
  // Without this widening, a user who consented to `spreadsheets` for write
  // tools would fail the scope check for `spreadsheets.readonly` on a read
  // tool — even though the parent scope is strictly more permissive.
  const granted = new Set(
    expandImpliedScopes(normalizeGoogleScopeAliases(payload.scopes)),
  );
  const required = normalizeGoogleScopeAliases(requiredScopes);
  const missing = required.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    throw new GoogleToolCredentialError(
      'google_scopes_missing',
      `Google account is missing required scopes: ${missing.join(', ')}`,
      400,
      { missingScopes: missing },
    );
  }
}

function parseRefreshPayload(payload: unknown): {
  accessToken: string;
  refreshToken: string | null;
  expiryDate: string;
  scopeUrls: string[];
  tokenType: string | null;
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new GoogleToolCredentialError(
      'token_exchange_failed',
      'Google refresh response was not a JSON object.',
      502,
    );
  }
  const map = payload as Record<string, unknown>;
  const accessToken =
    typeof map.access_token === 'string' ? map.access_token : null;
  if (!accessToken) {
    throw new GoogleToolCredentialError(
      'token_exchange_failed',
      'Google refresh response did not include access_token.',
      502,
    );
  }
  const expiresIn =
    typeof map.expires_in === 'number' && Number.isFinite(map.expires_in)
      ? map.expires_in
      : 3600;
  const scopeUrls =
    typeof map.scope === 'string'
      ? map.scope
          .split(/\s+/)
          .map((scope) => scope.trim())
          .filter(Boolean)
      : [];
  return {
    accessToken,
    refreshToken:
      typeof map.refresh_token === 'string' ? map.refresh_token : null,
    expiryDate: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scopeUrls,
    tokenType: typeof map.token_type === 'string' ? map.token_type : null,
  };
}

export async function performRefresh(
  userId: string,
  payload: GoogleToolCredentialPayload,
): Promise<GoogleToolCredentialPayload> {
  if (!payload.refreshToken) {
    throw new GoogleToolCredentialError(
      'google_reauth_required',
      'Google tools credential has expired and must be reconnected.',
      401,
    );
  }
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new GoogleToolCredentialError(
      'google_refresh_unavailable',
      'Google OAuth client credentials are not configured.',
      503,
    );
  }

  const body = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: payload.refreshToken,
  });

  const response = await fetch(GOOGLE_REFRESH_ENDPOINT, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    // Google returns 400 invalid_grant (refresh_token revoked / expired) or
    // 401 (client revoked). Either way the stored credential is unusable —
    // drop it so the next caller sees google_account_not_connected and we
    // surface a clean reconnect prompt to the user.
    if (response.status === 400 || response.status === 401) {
      await deleteUserGoogleCredential();
      throw new GoogleToolCredentialError(
        'google_reauth_required',
        'Google tools credential was revoked or expired and must be reconnected.',
        401,
      );
    }
    throw new GoogleToolCredentialError(
      'token_exchange_failed',
      `Google token refresh failed with HTTP ${response.status}.`,
      502,
    );
  }

  const refreshed = parseRefreshPayload(await response.json());
  const existing = await getUserGoogleCredential();
  if (!existing) {
    throw new GoogleToolCredentialError(
      'google_account_not_connected',
      'Google account is not connected.',
      404,
    );
  }

  // Google's refresh response usually omits refresh_token (only the original
  // exchange returns one). Preserve the prior refresh_token so the next
  // refresh still works.
  const refreshToken = refreshed.refreshToken ?? payload.refreshToken;
  // Refresh response often omits scope too; preserve prior scope set so
  // assertRequiredScopes doesn't start failing after a successful refresh.
  const scopeUrls =
    refreshed.scopeUrls.length > 0 ? refreshed.scopeUrls : payload.scopes;

  const merged: GoogleToolCredentialPayload = {
    kind: 'google_tools',
    accessToken: refreshed.accessToken,
    refreshToken,
    expiryDate: refreshed.expiryDate,
    scopes: scopeUrls,
    tokenType: refreshed.tokenType ?? payload.tokenType ?? 'Bearer',
  };

  await upsertUserGoogleCredential({
    userId,
    googleSubject: existing.googleSubject,
    email: existing.email,
    displayName: existing.displayName,
    scopes: normalizeGoogleScopeAliases(scopeUrls),
    ciphertext: encryptGoogleToolCredential(merged),
    accessExpiresAt: merged.expiryDate,
  });

  return merged;
}

export async function refreshCredentialIfNeeded(
  userId: string,
  payload: GoogleToolCredentialPayload,
): Promise<GoogleToolCredentialPayload> {
  if (!isExpired(payload)) return payload;

  const existing = refreshInFlight.get(userId);
  if (existing) return existing;

  const refreshPromise = performRefresh(userId, payload).finally(() => {
    refreshInFlight.delete(userId);
  });
  refreshInFlight.set(userId, refreshPromise);
  return refreshPromise;
}

export async function getValidGoogleToolAccessToken(input: {
  userId: string;
  requiredScopes: string[];
}): Promise<{
  accessToken: string;
  scopes: string[];
  email: string;
  displayName: string | null;
}> {
  const credential = await getUserGoogleCredential();
  if (!credential) {
    throw new GoogleToolCredentialError(
      'google_account_not_connected',
      'Google account is not connected.',
      404,
    );
  }

  let payload: GoogleToolCredentialPayload;
  try {
    payload = decryptGoogleToolCredential(credential.ciphertext);
  } catch {
    // Corrupt ciphertext (encryption secret rotated, manual tamper, etc.).
    // Drop the credential so the user is prompted to reconnect.
    await deleteUserGoogleCredential();
    throw new GoogleToolCredentialError(
      'google_reauth_required',
      'Stored Google credential is invalid and must be reconnected.',
      401,
    );
  }

  payload = await refreshCredentialIfNeeded(input.userId, payload);
  assertRequiredScopes(payload, input.requiredScopes);

  return {
    accessToken: payload.accessToken,
    scopes: normalizeGoogleScopeAliases(payload.scopes),
    email: credential.email,
    displayName: credential.displayName,
  };
}

export async function buildGooglePickerSession(userId: string): Promise<{
  oauthToken: string;
  developerKey: string;
  appId: string;
}> {
  // C11: refuse to mint a picker session if the picker SDK env is empty.
  // Without these the frontend can't open the Google Picker at all, so we
  // surface the misconfiguration as a typed error instead of returning a
  // half-broken session payload.
  if (!GOOGLE_PICKER_API_KEY.trim() || !GOOGLE_PICKER_APP_ID.trim()) {
    throw new GoogleToolCredentialError(
      'google_picker_not_configured',
      'Google Picker is not configured on this server.',
      503,
    );
  }

  const token = await getValidGoogleToolAccessToken({
    userId,
    requiredScopes: ['drive.readonly'],
  });

  return {
    oauthToken: token.accessToken,
    developerKey: GOOGLE_PICKER_API_KEY,
    appId: GOOGLE_PICKER_APP_ID,
  };
}
