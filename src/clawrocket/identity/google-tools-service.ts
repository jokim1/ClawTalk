import {
  GOOGLE_PICKER_API_KEY,
  GOOGLE_PICKER_APP_ID,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
} from '../config.js';
import {
  deleteUserGoogleCredential,
  getUserGoogleCredential,
  upsertUserGoogleCredential,
} from '../db/index.js';

import type { GoogleOAuthIdentity } from './auth-service.js';
import {
  decryptGoogleToolCredential,
  encryptGoogleToolCredential,
  type GoogleToolCredentialPayload,
} from './google-tools-credential-store.js';
import { normalizeGoogleScopeAliases } from './google-scopes.js';

const GOOGLE_REFRESH_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REFRESH_SKEW_MS = 60_000;

const refreshInFlight = new Map<string, Promise<GoogleToolCredentialPayload>>();

export class GoogleToolCredentialError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

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
  const granted = new Set(normalizeGoogleScopeAliases(payload.scopes));
  const missing = normalizeGoogleScopeAliases(requiredScopes).filter(
    (scope) => !granted.has(scope),
  );
  if (missing.length > 0) {
    throw new GoogleToolCredentialError(
      'google_scopes_missing',
      `Google account is missing required scopes: ${missing.join(', ')}`,
      400,
    );
  }
}

function parseRefreshPayload(payload: unknown): {
  accessToken: string;
  refreshToken: string | null;
  expiryDate: string | null;
  scopes: string[];
  tokenType: string | null;
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new GoogleToolCredentialError(
      'google_refresh_failed',
      'Google refresh response was not a JSON object.',
      502,
    );
  }
  const map = payload as Record<string, unknown>;
  const accessToken =
    typeof map.access_token === 'string' ? map.access_token : null;
  if (!accessToken) {
    throw new GoogleToolCredentialError(
      'google_refresh_failed',
      'Google refresh response did not include access_token.',
      502,
    );
  }
  const expiresIn =
    typeof map.expires_in === 'number' && Number.isFinite(map.expires_in)
      ? map.expires_in
      : 3600;
  return {
    accessToken,
    refreshToken:
      typeof map.refresh_token === 'string' ? map.refresh_token : null,
    expiryDate: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scopes:
      typeof map.scope === 'string'
        ? normalizeGoogleScopeAliases(
            map.scope
              .split(/\s+/)
              .map((scope) => scope.trim())
              .filter(Boolean),
          )
        : [],
    tokenType: typeof map.token_type === 'string' ? map.token_type : null,
  };
}

function persistCredential(
  userId: string,
  existing: ReturnType<typeof getUserGoogleCredential>,
  payload: GoogleToolCredentialPayload,
): void {
  if (!existing) {
    throw new GoogleToolCredentialError(
      'google_account_not_connected',
      'Google account is not connected.',
      404,
    );
  }
  upsertUserGoogleCredential({
    userId,
    googleSubject: existing.googleSubject,
    email: existing.email,
    displayName: existing.displayName,
    scopes: normalizeGoogleScopeAliases(payload.scopes),
    ciphertext: encryptGoogleToolCredential(payload),
    accessExpiresAt: payload.expiryDate ?? null,
  });
}

async function performRefresh(
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
    if (response.status === 400 || response.status === 401) {
      deleteUserGoogleCredential(userId);
      throw new GoogleToolCredentialError(
        'google_reauth_required',
        'Google tools credential was revoked or expired and must be reconnected.',
        401,
      );
    }
    throw new GoogleToolCredentialError(
      'google_refresh_failed',
      `Google token refresh failed with HTTP ${response.status}.`,
      502,
    );
  }

  const refreshed = parseRefreshPayload(await response.json());
  const existing = getUserGoogleCredential(userId);
  const merged: GoogleToolCredentialPayload = {
    kind: 'google_tools',
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken || payload.refreshToken,
    expiryDate: refreshed.expiryDate,
    scopes:
      refreshed.scopes.length > 0
        ? refreshed.scopes
        : normalizeGoogleScopeAliases(payload.scopes),
    tokenType: refreshed.tokenType || payload.tokenType || 'Bearer',
  };
  persistCredential(userId, existing, merged);
  return merged;
}

async function refreshCredentialIfNeeded(
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

export function persistGoogleOAuthIdentity(
  userId: string,
  identity: GoogleOAuthIdentity,
): void {
  const existing = getUserGoogleCredential(userId);
  let previous: GoogleToolCredentialPayload | null = null;
  if (existing) {
    try {
      previous = decryptGoogleToolCredential(existing.ciphertext);
    } catch {
      previous = null;
    }
  }
  const payload: GoogleToolCredentialPayload = {
    kind: 'google_tools',
    accessToken: identity.accessToken,
    refreshToken: identity.refreshToken || previous?.refreshToken,
    expiryDate: identity.accessExpiresAt,
    scopes: normalizeGoogleScopeAliases(identity.scopes),
    tokenType: identity.tokenType,
  };
  upsertUserGoogleCredential({
    userId,
    googleSubject: identity.googleSubject,
    email: identity.email,
    displayName: identity.displayName,
    scopes: payload.scopes,
    ciphertext: encryptGoogleToolCredential(payload),
    accessExpiresAt: payload.expiryDate ?? null,
  });
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
  const credential = getUserGoogleCredential(input.userId);
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
    deleteUserGoogleCredential(input.userId);
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
  if (!GOOGLE_PICKER_API_KEY || !GOOGLE_PICKER_APP_ID) {
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
