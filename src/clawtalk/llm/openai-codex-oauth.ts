// OpenAI Codex (ChatGPT Plus/Pro) device-code OAuth.
//
// Ported from hermes_cli/auth.py:_codex_device_code_login + refresh_codex_oauth_pure.
// Uses the public Codex OAuth client + the device-code grant so a
// cloud Worker can broker the auth without a local CLI install.
//
// Flow:
//   1. POST auth.openai.com/api/accounts/deviceauth/usercode →
//      { user_code, device_auth_id, interval }
//   2. Worker shows the user the URL + user_code; user signs in on
//      a separate device.
//   3. Worker polls auth.openai.com/api/accounts/deviceauth/token
//      with { device_auth_id, user_code } until 200 →
//      { authorization_code, code_verifier }.
//   4. Worker exchanges at auth.openai.com/oauth/token with
//      grant_type=authorization_code → access_token + refresh_token.
//   5. Worker refreshes lazily via the same endpoint with
//      grant_type=refresh_token.
//
// Caveats hermes flags:
//   * refresh_token_reused — OpenAI rotates the refresh token on each
//     refresh. If the user also runs the local Codex CLI / VS Code
//     extension, that other client's refresh invalidates ours and
//     vice versa. Mutual exclusion only — user has to pick one place.
//   * The inference endpoint is `chatgpt.com/backend-api/codex/*`,
//     NOT api.openai.com. The request shape is the Codex Responses
//     API; a dedicated adapter (TODO) will be needed before agents
//     can actually run against ChatGPT subscription credentials.

export const OPENAI_CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_CODEX_OAUTH_ISSUER = 'https://auth.openai.com';
export const OPENAI_CODEX_OAUTH_TOKEN_URL = `${OPENAI_CODEX_OAUTH_ISSUER}/oauth/token`;
export const OPENAI_CODEX_DEVICE_USERCODE_URL = `${OPENAI_CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`;
export const OPENAI_CODEX_DEVICE_TOKEN_URL = `${OPENAI_CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/token`;
export const OPENAI_CODEX_DEVICE_REDIRECT_URI = `${OPENAI_CODEX_OAUTH_ISSUER}/deviceauth/callback`;
// Where the user enters the device code in their browser.
export const OPENAI_CODEX_DEVICE_USER_URL = `${OPENAI_CODEX_OAUTH_ISSUER}/codex/device`;
export const OPENAI_CODEX_INFERENCE_BASE_URL =
  'https://chatgpt.com/backend-api/codex';

export interface OpenAiCodexDeviceCodeResult {
  userCode: string;
  deviceAuthId: string;
  pollIntervalSeconds: number;
  verificationUrl: string;
  expiresAtIso: string;
}

export interface OpenAiCodexPollResult {
  status: 'pending' | 'authorized' | 'error';
  authorizationCode?: string;
  codeVerifier?: string;
  errorMessage?: string;
}

export interface OpenAiCodexTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresAtIso: string;
}

const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;

export async function requestOpenAiCodexDeviceCode(): Promise<OpenAiCodexDeviceCodeResult> {
  const response = await fetch(OPENAI_CODEX_DEVICE_USERCODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: OPENAI_CODEX_OAUTH_CLIENT_ID }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `OpenAI device code request failed (${response.status})${
        errorText ? `: ${errorText.slice(0, 200)}` : ''
      }`,
    );
  }

  const payload = (await response.json()) as {
    user_code?: unknown;
    device_auth_id?: unknown;
    interval?: unknown;
  };
  const userCode =
    typeof payload.user_code === 'string' ? payload.user_code.trim() : '';
  const deviceAuthId =
    typeof payload.device_auth_id === 'string'
      ? payload.device_auth_id.trim()
      : '';
  if (!userCode || !deviceAuthId) {
    throw new Error('OpenAI device code response missing required fields');
  }
  const pollIntervalSeconds = Math.max(3, Number(payload.interval ?? 5));
  return {
    userCode,
    deviceAuthId,
    pollIntervalSeconds,
    verificationUrl: OPENAI_CODEX_DEVICE_USER_URL,
    expiresAtIso: new Date(Date.now() + DEVICE_CODE_TTL_MS).toISOString(),
  };
}

export async function pollOpenAiCodexDeviceAuth(input: {
  deviceAuthId: string;
  userCode: string;
}): Promise<OpenAiCodexPollResult> {
  const response = await fetch(OPENAI_CODEX_DEVICE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      device_auth_id: input.deviceAuthId,
      user_code: input.userCode,
    }),
  });

  if (response.status === 403 || response.status === 404) {
    return { status: 'pending' };
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    return {
      status: 'error',
      errorMessage: `OpenAI device auth poll failed (${response.status})${
        errorText ? `: ${errorText.slice(0, 200)}` : ''
      }`,
    };
  }

  const payload = (await response.json()) as {
    authorization_code?: unknown;
    code_verifier?: unknown;
  };
  const authorizationCode =
    typeof payload.authorization_code === 'string'
      ? payload.authorization_code.trim()
      : '';
  const codeVerifier =
    typeof payload.code_verifier === 'string'
      ? payload.code_verifier.trim()
      : '';
  if (!authorizationCode || !codeVerifier) {
    return {
      status: 'error',
      errorMessage:
        'OpenAI device auth response missing authorization_code or code_verifier',
    };
  }
  return { status: 'authorized', authorizationCode, codeVerifier };
}

export async function exchangeOpenAiCodexAuthorizationCode(input: {
  authorizationCode: string;
  codeVerifier: string;
}): Promise<OpenAiCodexTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.authorizationCode,
    redirect_uri: OPENAI_CODEX_DEVICE_REDIRECT_URI,
    client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
    code_verifier: input.codeVerifier,
  });

  const response = await fetch(OPENAI_CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `OpenAI Codex token exchange failed (${response.status})${
        errorText ? `: ${errorText.slice(0, 300)}` : ''
      }`,
    );
  }

  const payload = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  const accessToken =
    typeof payload.access_token === 'string'
      ? payload.access_token.trim()
      : '';
  const refreshToken =
    typeof payload.refresh_token === 'string'
      ? payload.refresh_token.trim()
      : '';
  if (!accessToken) {
    throw new Error('OpenAI Codex token exchange missing access_token');
  }
  if (!refreshToken) {
    throw new Error('OpenAI Codex token exchange missing refresh_token');
  }
  const expiresInSeconds = Math.max(1, Number(payload.expires_in ?? 3600));
  return {
    accessToken,
    refreshToken,
    expiresAtIso: new Date(
      Date.now() + expiresInSeconds * 1000,
    ).toISOString(),
  };
}

export async function refreshOpenAiCodexOauthToken(
  refreshToken: string,
): Promise<OpenAiCodexTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
  });

  const response = await fetch(OPENAI_CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    // Surface the rotation-conflict case explicitly so the caller can
    // tell the user to either disconnect from ClawTalk or stop using
    // the local Codex CLI on the same OpenAI account.
    if (errorText.includes('refresh_token_reused')) {
      throw new Error(
        'OpenAI Codex refresh token was already consumed by another client ' +
          '(Codex CLI or VS Code extension). Reconnect ChatGPT in Settings.',
      );
    }
    throw new Error(
      `OpenAI Codex token refresh failed (${response.status})${
        errorText ? `: ${errorText.slice(0, 300)}` : ''
      }`,
    );
  }

  const payload = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  const accessToken =
    typeof payload.access_token === 'string'
      ? payload.access_token.trim()
      : '';
  if (!accessToken) {
    throw new Error('OpenAI Codex token refresh missing access_token');
  }
  const nextRefresh =
    typeof payload.refresh_token === 'string' &&
    payload.refresh_token.trim()
      ? payload.refresh_token.trim()
      : refreshToken;
  const expiresInSeconds = Math.max(1, Number(payload.expires_in ?? 3600));
  return {
    accessToken,
    refreshToken: nextRefresh,
    expiresAtIso: new Date(
      Date.now() + expiresInSeconds * 1000,
    ).toISOString(),
  };
}

export function isOpenAiCodexCredentialExpiring(
  expiresAtIso: string | null,
  skewMs = 120_000,
): boolean {
  if (!expiresAtIso) return true;
  const expiryMs = Date.parse(expiresAtIso);
  if (Number.isNaN(expiryMs)) return true;
  return expiryMs <= Date.now() + skewMs;
}
