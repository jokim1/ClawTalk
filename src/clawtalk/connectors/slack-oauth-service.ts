// Slack OAuth install service.
//
// Mirrors the structure of `google-oauth-service.ts`, with the simplifications
// that Slack's OAuth v2 install flow allows:
//   - No PKCE (Slack doesn't accept code_challenge for bot installs).
//   - No id_token / nonce verification (Slack doesn't issue OIDC tokens for
//     workspace installs — only the bot token and team metadata).
//   - State is a CSRF-only bind to the initiating admin user.
//
// Boundary contract:
//   - `startSlackInstall` runs inside `withUserContext(userId)` from an
//     authenticated admin route. RLS on `oauth_state` enforces
//     `user_id = auth.uid()` at INSERT.
//   - `completeSlackInstallCallback` runs from a PUBLIC callback route — Slack
//     redirects the browser directly with no clawtalk session cookies. The
//     pool runs as the BYPASSRLS `postgres` role so the state-claim DELETE
//     and the install UPSERT both run outside RLS. After the install row is
//     written we enter `withUserContext(installed_by)` for any follow-up
//     work (none in PR 1 — the picker is PR 2).
//
// nonce_hash and code_verifier_hash columns on `oauth_state` are NOT NULL
// (the schema was built around the Google PKCE/OIDC flow). For Slack we
// generate random placeholder hashes — they are written and ignored.

import { randomBytes, createHash } from 'crypto';

import { getDbPg } from '../../db.js';
import { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET } from '../config.js';
import { upsertWorkspaceSlackInstall } from '../db/slack-installs-accessors.js';

const PROVIDER = 'slack_app_install';
const STATE_TTL_MS = 10 * 60 * 1000;
const SLACK_AUTH_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access';

// Bot Token scopes requested up-front. Reinstalling later to add scopes is
// painful, so we ask for the full set the product is likely to need: read
// channels (for the PR 2 picker), post messages (outbound delivery), receive
// messages (inbound triggers), and resolve user identity for display.
export const SLACK_BOT_SCOPES: readonly string[] = [
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'chat:write',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'users:read',
];

export class SlackOAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'SlackOAuthError';
    this.code = code;
    this.status = status;
  }
}

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

export interface StartSlackInstallInput {
  userId: string;
  redirectUri: string;
  returnTo?: string | null;
}

export interface StartSlackInstallResult {
  authorizationUrl: string;
  expiresInSec: number;
}

export async function startSlackInstall(
  input: StartSlackInstallInput,
): Promise<StartSlackInstallResult> {
  if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
    throw new SlackOAuthError(
      'config_missing',
      'Slack OAuth client credentials are not configured on this server.',
      503,
    );
  }
  if (!input.redirectUri) {
    throw new SlackOAuthError(
      'config_missing',
      'SLACK_OAUTH_REDIRECT_URI is not configured.',
      503,
    );
  }

  const rawState = randomBase64Url(32);
  const stateHash = sha256Base64Url(rawState);
  // Unused-but-required-by-schema placeholders.
  const placeholderNonceHash = sha256Base64Url(randomBase64Url(16));
  const placeholderVerifierHash = sha256Base64Url(randomBase64Url(16));
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();

  const db = getDbPg();
  await db`
    insert into public.oauth_state
      (user_id, provider, state_hash, nonce_hash, code_verifier_hash,
       code_verifier, redirect_uri, return_to, expires_at)
    values
      (${input.userId}::uuid, ${PROVIDER}, ${stateHash}, ${placeholderNonceHash},
       ${placeholderVerifierHash}, null, ${input.redirectUri},
       ${input.returnTo ?? null}, ${expiresAt}::timestamptz)
  `;

  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    scope: SLACK_BOT_SCOPES.join(','),
    user_scope: '',
    redirect_uri: input.redirectUri,
    state: rawState,
  });

  return {
    authorizationUrl: `${SLACK_AUTH_URL}?${params.toString()}`,
    expiresInSec: Math.floor(STATE_TTL_MS / 1000),
  };
}

export interface CompleteSlackInstallCallbackInput {
  rawState: string;
  code: string | null;
  slackError: string | null;
}

export interface CompleteSlackInstallCallbackResult {
  status: 'success' | 'denied' | 'error';
  teamId?: string;
  teamName?: string;
  errorCode?: string;
  message?: string;
}

interface ClaimedStateRow {
  id: string;
  user_id: string;
  provider: string;
  redirect_uri: string;
  return_to: string | null;
  expires_at: string;
}

interface SlackOauthAccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id?: string; name?: string };
}

export async function completeSlackInstallCallback(
  input: CompleteSlackInstallCallbackInput,
): Promise<CompleteSlackInstallCallbackResult> {
  const stateHash = sha256Base64Url(input.rawState);
  const db = getDbPg();
  const claimed = await db<ClaimedStateRow[]>`
    delete from public.oauth_state
    where state_hash = ${stateHash}
      and provider = ${PROVIDER}
      and expires_at > now()
    returning id, user_id, provider, redirect_uri, return_to, expires_at
  `;
  if (claimed.length === 0) {
    return {
      status: 'error',
      errorCode: 'state_invalid_or_expired',
      message: 'Install link expired, try again.',
    };
  }
  const row = claimed[0];

  if (input.slackError === 'access_denied') {
    return {
      status: 'denied',
      errorCode: 'access_denied',
      message: 'You denied access to the Slack workspace.',
    };
  }
  if (input.slackError) {
    return {
      status: 'error',
      errorCode: 'slack_error',
      message: `Slack returned error: ${input.slackError}`,
    };
  }
  if (!input.code) {
    return {
      status: 'error',
      errorCode: 'missing_code',
      message: 'Could not complete install.',
    };
  }

  // Exchange the code for a bot token + team metadata.
  const body = new URLSearchParams({
    code: input.code,
    client_id: SLACK_CLIENT_ID,
    client_secret: SLACK_CLIENT_SECRET,
    redirect_uri: row.redirect_uri,
  });
  let tokenPayload: SlackOauthAccessResponse;
  try {
    const response = await fetch(SLACK_TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!response.ok) {
      return {
        status: 'error',
        errorCode: 'token_exchange_failed',
        message: `Slack token exchange failed: HTTP ${response.status}`,
      };
    }
    tokenPayload = (await response.json()) as SlackOauthAccessResponse;
  } catch (err) {
    return {
      status: 'error',
      errorCode: 'token_exchange_failed',
      message:
        err instanceof Error ? err.message : 'Slack token exchange failed.',
    };
  }

  if (!tokenPayload.ok) {
    return {
      status: 'error',
      errorCode: tokenPayload.error || 'slack_error',
      message: `Slack rejected install: ${tokenPayload.error || 'unknown'}.`,
    };
  }
  if (!tokenPayload.access_token || tokenPayload.token_type !== 'bot') {
    return {
      status: 'error',
      errorCode: 'invalid_token_response',
      message: 'Slack did not return a bot access token.',
    };
  }
  const teamId = tokenPayload.team?.id;
  const teamName = tokenPayload.team?.name;
  if (!teamId || !teamName) {
    return {
      status: 'error',
      errorCode: 'invalid_token_response',
      message: 'Slack did not return team metadata.',
    };
  }

  const grantedScopes = (tokenPayload.scope ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  await upsertWorkspaceSlackInstall({
    teamId,
    teamName,
    botUserId: tokenPayload.bot_user_id ?? null,
    appId: tokenPayload.app_id ?? null,
    botToken: tokenPayload.access_token,
    scopes: grantedScopes,
    installedBy: row.user_id,
  });

  return { status: 'success', teamId, teamName };
}
