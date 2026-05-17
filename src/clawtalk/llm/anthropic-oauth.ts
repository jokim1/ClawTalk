// Anthropic OAuth subscription support (Claude Pro/Max).
//
// Ported from rocketboard's anthropic-auth.shared.ts + _shared/anthropic-auth.ts.
// Implements the public Claude Code OAuth client + PKCE flow, with the
// console.anthropic.com redirect URI that displays the code back to the
// user to paste into our UI.

export const ANTHROPIC_OAUTH_CLIENT_ID =
  '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const ANTHROPIC_OAUTH_AUTHORIZE_URL =
  'https://claude.ai/oauth/authorize';
// Anthropic's own console catches the OAuth redirect and displays the
// `{code}#{state}` blob for the user to paste back. Pattern shared
// with Claude Code, Hermes, pi-ai, OpenCode.
export const ANTHROPIC_OAUTH_REDIRECT_URI =
  'https://console.anthropic.com/oauth/code/callback';
export const ANTHROPIC_OAUTH_TOKEN_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
] as const;
export const ANTHROPIC_OAUTH_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
] as const;
export const ANTHROPIC_VERSION_HEADER = '2023-06-01';
// Claude Code release version; Anthropic's OAuth routing layer
// validates the user-agent format. Bump alongside Claude Code releases.
export const ANTHROPIC_CLAUDE_CODE_VERSION = '2.1.113';
// Required identity prefix on OAuth-backed requests. Without it
// Anthropic returns a minimal-body 429.
export const ANTHROPIC_CLAUDE_CODE_SYSTEM_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";
export const ANTHROPIC_COMMON_BETAS = [
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
] as const;
export const ANTHROPIC_OAUTH_ONLY_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
] as const;
export const ANTHROPIC_OAUTH_BETAS = [
  ...ANTHROPIC_COMMON_BETAS,
  ...ANTHROPIC_OAUTH_ONLY_BETAS,
] as const;

const STATE_TTL_MS = 10 * 60 * 1000;

export interface AnthropicOauthInitiateResult {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  expiresAtIso: string;
}

export interface AnthropicOauthTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresAtIso: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomUrlSafeString(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return toBase64Url(bytes).slice(0, byteLength);
}

export async function createPkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = randomUrlSafeString(64);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  const challenge = toBase64Url(new Uint8Array(digest));
  return { verifier, challenge };
}

export function buildAnthropicAuthorizeUrl(input: {
  codeChallenge: string;
  state: string;
}): string {
  const url = new URL(ANTHROPIC_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', ANTHROPIC_OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', ANTHROPIC_OAUTH_REDIRECT_URI);
  url.searchParams.set('scope', ANTHROPIC_OAUTH_SCOPES.join(' '));
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  return url.toString();
}

export async function initiateAnthropicOauth(): Promise<AnthropicOauthInitiateResult> {
  const pkce = await createPkcePair();
  const state = crypto.randomUUID();
  return {
    authorizationUrl: buildAnthropicAuthorizeUrl({
      codeChallenge: pkce.challenge,
      state,
    }),
    state,
    codeVerifier: pkce.verifier,
    expiresAtIso: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  };
}

export async function exchangeAnthropicAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  state: string;
}): Promise<AnthropicOauthTokenResponse> {
  // Anthropic's token endpoint requires JSON body with `state` alongside
  // the PKCE verifier. Form-urlencoded without `state` returns 400.
  const body = JSON.stringify({
    client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: ANTHROPIC_OAUTH_REDIRECT_URI,
    state: input.state,
  });

  let lastError: Error | null = null;
  for (const endpoint of ANTHROPIC_OAUTH_TOKEN_URLS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `claude-cli/${ANTHROPIC_CLAUDE_CODE_VERSION} (external, cli)`,
        },
        body,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        lastError = new Error(
          `Anthropic OAuth code exchange failed (${response.status})${
            errorText ? `: ${errorText.slice(0, 300)}` : ''
          }`,
        );
        continue;
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
      if (!accessToken || !refreshToken) {
        lastError = new Error(
          'Anthropic OAuth code exchange response was incomplete',
        );
        continue;
      }
      const expiresInSeconds = Math.max(1, Number(payload.expires_in ?? 3600));
      return {
        accessToken,
        refreshToken,
        expiresAtIso: new Date(
          Date.now() + expiresInSeconds * 1000,
        ).toISOString(),
      };
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error('Anthropic OAuth code exchange failed');
    }
  }

  throw lastError ?? new Error('Anthropic OAuth code exchange failed');
}

export async function refreshAnthropicOauthToken(
  refreshToken: string,
): Promise<AnthropicOauthTokenResponse> {
  const body = new URLSearchParams({
    client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  let lastError: Error | null = null;
  for (const endpoint of ANTHROPIC_OAUTH_TOKEN_URLS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': `claude-cli/${ANTHROPIC_CLAUDE_CODE_VERSION} (external, cli)`,
        },
        body: body.toString(),
      });

      if (!response.ok) {
        lastError = new Error(
          `Anthropic OAuth refresh failed (${response.status})`,
        );
        continue;
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
        lastError = new Error(
          'Anthropic OAuth refresh response missing access_token',
        );
        continue;
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
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error('Anthropic OAuth refresh failed');
    }
  }

  throw lastError ?? new Error('Anthropic OAuth refresh failed');
}

export function isAnthropicOauthCredentialExpiring(
  expiresAtIso: string | null,
  skewMs = 60_000,
): boolean {
  if (!expiresAtIso) return true;
  const expiryMs = Date.parse(expiresAtIso);
  if (Number.isNaN(expiryMs)) return true;
  return expiryMs <= Date.now() + skewMs;
}

/**
 * Build the Anthropic system prompt for an OAuth-backed request.
 * Anthropic requires the system to be a content-block array with the
 * Claude Code identity as the first block; otherwise the OAuth routing
 * layer returns a minimal-body 429.
 */
export function buildClaudeCodeSystemBlocks(
  userSystemText: string,
): Array<{ type: 'text'; text: string }> {
  const identity = {
    type: 'text' as const,
    text: ANTHROPIC_CLAUDE_CODE_SYSTEM_PREFIX,
  };
  if (!userSystemText.trim()) return [identity];
  return [identity, { type: 'text' as const, text: userSystemText }];
}
