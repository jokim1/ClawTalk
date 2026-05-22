// Google account OAuth route handlers.
//
// JSON routes (/api/v1/me/google-account/*) return the standard
// { statusCode, body: ApiEnvelope<T> } shape. The popup callback at
// /api/v1/auth/google/callback returns an HTML Response directly because the
// page runs in the popup window and posts back to window.opener.
//
// All inline HTML interpolation flows through `htmlSafeJson()` (D3) to
// guarantee no user-controllable string can escape the <script> context.

import { withUserContext } from '../../../db.js';
import { GOOGLE_OAUTH_REDIRECT_URI } from '../../config.js';
import { getUserGoogleCredential } from '../../db/talk-tools-accessors.js';
import {
  GoogleOAuthError,
  completeGoogleOAuthCallback,
  disconnectGoogleAccount,
  ensureOidcScopes,
  startGoogleOAuth,
  validateRequestedScopes,
} from '../../identity/google-oauth-service.js';
import { decryptGoogleToolCredential } from '../../identity/google-tools-credential-store.js';
import { normalizeGoogleScopeAliases } from '../../identity/google-scopes.js';
import { ApiEnvelope, AuthContext } from '../types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface JsonRouteResult<T> {
  statusCode: number;
  body: ApiEnvelope<T>;
}

const DEFAULT_TOOL_SCOPES = ['drive.readonly', 'documents'];

function errorResult(
  statusCode: number,
  code: string,
  message: string,
): JsonRouteResult<never> {
  return { statusCode, body: { ok: false, error: { code, message } } };
}

function fromOAuthError(err: GoogleOAuthError): JsonRouteResult<never> {
  return errorResult(err.status, err.code, err.message);
}

// ---------------------------------------------------------------------------
// UserGoogleAccount projection
// ---------------------------------------------------------------------------

export interface UserGoogleAccount {
  connected: boolean;
  email: string | null;
  displayName: string | null;
  scopes: string[];
  accessExpiresAt: string | null;
}

const DISCONNECTED: UserGoogleAccount = {
  connected: false,
  email: null,
  displayName: null,
  scopes: [],
  accessExpiresAt: null,
};

// ---------------------------------------------------------------------------
// GET /api/v1/me/google-account
// ---------------------------------------------------------------------------

export async function getUserGoogleAccountRoute(
  auth: AuthContext,
): Promise<JsonRouteResult<{ googleAccount: UserGoogleAccount }>> {
  const cred = await withUserContext(auth.userId, () =>
    getUserGoogleCredential(),
  );
  if (!cred) {
    return {
      statusCode: 200,
      body: { ok: true, data: { googleAccount: DISCONNECTED } },
    };
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        googleAccount: {
          connected: true,
          email: cred.email,
          displayName: cred.displayName,
          scopes: normalizeGoogleScopeAliases(cred.scopes),
          accessExpiresAt: cred.accessExpiresAt,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// POST /api/v1/me/google-account/connect
// ---------------------------------------------------------------------------

export async function startConnectRoute(
  auth: AuthContext,
  body: { returnTo?: unknown; scopes?: unknown },
): Promise<
  JsonRouteResult<{ authorizationUrl: string; expiresInSec: number }>
> {
  let requested: string[];
  try {
    requested = validateRequestedScopes(
      Array.isArray(body.scopes)
        ? (body.scopes as unknown[]).filter(
            (s): s is string => typeof s === 'string',
          )
        : DEFAULT_TOOL_SCOPES,
    );
  } catch (err) {
    if (err instanceof GoogleOAuthError) return fromOAuthError(err);
    throw err;
  }
  const finalScopes = ensureOidcScopes(
    requested.length === 0 ? DEFAULT_TOOL_SCOPES : requested,
  );

  const returnTo =
    typeof body.returnTo === 'string' && body.returnTo.length > 0
      ? body.returnTo
      : null;

  try {
    const result = await withUserContext(auth.userId, () =>
      startGoogleOAuth({
        userId: auth.userId,
        scopes: finalScopes,
        redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
        returnTo,
      }),
    );
    return { statusCode: 200, body: { ok: true, data: result } };
  } catch (err) {
    if (err instanceof GoogleOAuthError) return fromOAuthError(err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/me/google-account/expand-scopes
// ---------------------------------------------------------------------------

export async function expandScopesRoute(
  auth: AuthContext,
  body: { returnTo?: unknown; scopes?: unknown },
): Promise<
  JsonRouteResult<{ authorizationUrl: string; expiresInSec: number }>
> {
  let requested: string[];
  try {
    requested = validateRequestedScopes(
      Array.isArray(body.scopes)
        ? (body.scopes as unknown[]).filter(
            (s): s is string => typeof s === 'string',
          )
        : [],
    );
  } catch (err) {
    if (err instanceof GoogleOAuthError) return fromOAuthError(err);
    throw err;
  }
  if (requested.length === 0) {
    return errorResult(
      400,
      'scopes_required',
      'scopes array must be non-empty.',
    );
  }

  const returnTo =
    typeof body.returnTo === 'string' && body.returnTo.length > 0
      ? body.returnTo
      : null;

  // Require existing credential; merge persisted aliases into the request
  // (C8: persisted scopes never shrink, even if user re-consents with fewer).
  try {
    const result = await withUserContext(auth.userId, async () => {
      const cred = await getUserGoogleCredential();
      if (!cred) {
        throw new GoogleOAuthError(
          'not_connected',
          'Google account is not connected. Connect first, then expand scopes.',
          403,
        );
      }
      const merged = Array.from(new Set([...cred.scopes, ...requested]));
      return startGoogleOAuth({
        userId: auth.userId,
        scopes: ensureOidcScopes(merged),
        redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
        returnTo,
      });
    });
    return { statusCode: 200, body: { ok: true, data: result } };
  } catch (err) {
    if (err instanceof GoogleOAuthError) return fromOAuthError(err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/me/google-account/disconnect
// ---------------------------------------------------------------------------

export async function disconnectGoogleAccountRoute(
  auth: AuthContext,
): Promise<JsonRouteResult<{ disconnected: boolean }>> {
  const removed = await withUserContext(auth.userId, () =>
    disconnectGoogleAccount(),
  );
  return {
    statusCode: 200,
    body: { ok: true, data: { disconnected: removed } },
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/auth/google/callback
// ---------------------------------------------------------------------------

/**
 * D3: serialize a JSON payload safely for embedding inside <script>...</script>.
 * `JSON.stringify` already escapes most special characters, but we still must
 * neutralize the three sequences that can break out of a script context:
 *   - `</`         → could close the script tag
 *   - U+2028/2029  → JavaScript treats these as line terminators
 *   - `&`          → defensive against HTML entity tricks in some browsers
 */
export function htmlSafeJson(payload: unknown): string {
  return JSON.stringify(payload)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(new RegExp('\\u2028', 'g'), '\\u2028')
    .replace(new RegExp('\\u2029', 'g'), '\\u2029');
}

function renderCallbackHtml(payload: {
  type: 'clawtalk:google-account-link';
  status: 'success' | 'error';
  message?: string | null;
}): string {
  const serialized = htmlSafeJson(payload);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Google connection</title></head>
<body>
<p>Closing window…</p>
<script>
(function () {
  var payload = ${serialized};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin);
    }
  } catch (e) {}
  setTimeout(function () { window.close(); }, 50);
})();
</script>
</body></html>`;
}

export async function handleGoogleCallback(rawQuery: {
  state: string | null;
  code: string | null;
  error: string | null;
}): Promise<{ html: string; statusCode: number }> {
  if (!rawQuery.state) {
    return {
      html: renderCallbackHtml({
        type: 'clawtalk:google-account-link',
        status: 'error',
        message: 'Connection link is invalid.',
      }),
      statusCode: 400,
    };
  }

  try {
    const result = await completeGoogleOAuthCallback({
      rawState: rawQuery.state,
      code: rawQuery.code,
      googleError: rawQuery.error,
    });
    if (result.status === 'success') {
      return {
        html: renderCallbackHtml({
          type: 'clawtalk:google-account-link',
          status: 'success',
        }),
        statusCode: 200,
      };
    }
    // 'denied' and 'error' both surface as `status: 'error'` to the opener
    // with a user-readable message. The error code is logged server-side via
    // the calling route (worker-app.ts attaches the logger).
    return {
      html: renderCallbackHtml({
        type: 'clawtalk:google-account-link',
        status: 'error',
        message: result.message ?? 'Could not complete connection.',
      }),
      statusCode: result.status === 'denied' ? 200 : 400,
    };
  } catch (err) {
    // Defensive: anything thrown out of completeGoogleOAuthCallback shows up
    // here. Don't leak the message to the popup (XSS surface mitigated, but
    // attacker-controllable strings should still not appear in the popup
    // verbatim).
    const code = err instanceof GoogleOAuthError ? err.code : 'callback_failed';
    return {
      html: renderCallbackHtml({
        type: 'clawtalk:google-account-link',
        status: 'error',
        message: 'Could not complete connection.',
      }),
      statusCode: err instanceof GoogleOAuthError ? err.status : 500,
    };
  }
}

// ---------------------------------------------------------------------------
// Decrypt helper exposed for tests
// ---------------------------------------------------------------------------

export function _decryptForTests(ciphertext: string) {
  return decryptGoogleToolCredential(ciphertext);
}
