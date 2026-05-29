// OAuth subscription flows for AI providers.
//
// Two flows wired through `/api/v1/agents/providers/:providerId/oauth/...`:
//
//   provider.anthropic       PKCE (user pastes {code}#{state} from
//                            console.anthropic.com back into the UI).
//   provider.openai_codex    Device-code (user types a code on
//                            auth.openai.com/codex/device; we poll).
//
// Both end up storing access_token + refresh_token + expires_at as
// `credential_kind='subscription'` rows in llm_provider_secrets. The
// credential resolver then reads + refreshes them lazily.

import { getDbPg, withUserContext } from '../../../db.js';
import {
  exchangeAnthropicAuthorizationCode,
  initiateAnthropicOauth,
} from '../../llm/anthropic-oauth.js';
import {
  exchangeOpenAiCodexAuthorizationCode,
  pollOpenAiCodexDeviceAuth,
  requestOpenAiCodexDeviceCode,
} from '../../llm/openai-codex-oauth.js';
import { encryptProviderSecret } from '../../llm/provider-secret-store.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

const ANTHROPIC_PROVIDER_ID = 'provider.anthropic';
const OPENAI_CODEX_PROVIDER_ID = 'provider.openai_codex';

function invalidInputResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 400,
    body: { ok: false, error: { code: 'invalid_input', message } },
  };
}

function notFoundResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 404,
    body: { ok: false, error: { code: 'not_found', message } },
  };
}

// ─── Subscription-credential storage helpers ──────────────────────

async function persistSubscriptionCredential(input: {
  providerId: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAtIso: string;
}): Promise<void> {
  const db = getDbPg();
  const encryptedAccess = await encryptProviderSecret({
    apiKey: input.accessToken,
  });
  const encryptedRefresh = await encryptProviderSecret({
    apiKey: input.refreshToken,
  });

  await db`
    insert into public.llm_provider_secrets (
      owner_id, provider_id, credential_kind, ciphertext,
      encrypted_refresh_token, expires_at
    )
    values (
      ${input.userId}::uuid, ${input.providerId}, 'subscription',
      ${encryptedAccess}, ${encryptedRefresh},
      ${input.expiresAtIso}::timestamptz
    )
    on conflict (owner_id, provider_id, credential_kind) do update set
      ciphertext = excluded.ciphertext,
      encrypted_refresh_token = excluded.encrypted_refresh_token,
      expires_at = excluded.expires_at,
      updated_at = now()
  `;
}

// ─── OAuth state CRUD ─────────────────────────────────────────────

async function insertPkceState(input: {
  providerId: string;
  state: string;
  userId: string;
  codeVerifier: string;
  expiresAtIso: string;
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.provider_oauth_states (
      provider_id, scope, flow_kind, state, user_id,
      code_verifier, expires_at
    )
    values (
      ${input.providerId}, 'user', 'pkce', ${input.state},
      ${input.userId}::uuid, ${input.codeVerifier},
      ${input.expiresAtIso}::timestamptz
    )
  `;
}

async function insertDeviceCodeState(input: {
  providerId: string;
  state: string;
  userId: string;
  deviceAuthId: string;
  userCode: string;
  expiresAtIso: string;
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.provider_oauth_states (
      provider_id, scope, flow_kind, state, user_id,
      device_auth_id, user_code, expires_at
    )
    values (
      ${input.providerId}, 'user', 'device_code', ${input.state},
      ${input.userId}::uuid, ${input.deviceAuthId}, ${input.userCode},
      ${input.expiresAtIso}::timestamptz
    )
  `;
}

interface LoadedOauthState {
  id: string;
  flow_kind: 'pkce' | 'device_code';
  code_verifier: string | null;
  device_auth_id: string | null;
  user_code: string | null;
  expires_at: string;
  consumed_at: string | null;
}

async function loadOauthState(input: {
  providerId: string;
  state: string;
}): Promise<LoadedOauthState | null> {
  const db = getDbPg();
  const rows = await db<LoadedOauthState[]>`
    select id, flow_kind, code_verifier, device_auth_id,
           user_code, expires_at::text as expires_at, consumed_at::text as consumed_at
    from public.provider_oauth_states
    where provider_id = ${input.providerId}
      and state = ${input.state}
    limit 1
  `;
  return rows[0] ?? null;
}

async function markOauthStateConsumed(id: string): Promise<void> {
  const db = getDbPg();
  await db`
    update public.provider_oauth_states
    set consumed_at = now()
    where id = ${id}::uuid
  `;
}

// ─── Anthropic PKCE flow ──────────────────────────────────────────

export interface AnthropicOauthCompleteBody {
  state?: unknown;
  code?: unknown;
}

export async function initiateAnthropicOauthRoute(auth: AuthContext): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ authorizationUrl: string; state: string }>;
}> {
  const result = await withUserContext(auth.userId, async () => {
    const init = await initiateAnthropicOauth();
    await insertPkceState({
      providerId: ANTHROPIC_PROVIDER_ID,
      state: init.state,
      userId: auth.userId,
      codeVerifier: init.codeVerifier,
      expiresAtIso: init.expiresAtIso,
    });
    return init;
  });
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        authorizationUrl: result.authorizationUrl,
        state: result.state,
      },
    },
  };
}

export async function completeAnthropicOauthRoute(
  auth: AuthContext,
  body: AnthropicOauthCompleteBody,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ expiresAt: string }>;
}> {
  const stateInput = typeof body.state === 'string' ? body.state.trim() : '';
  const codeInput = typeof body.code === 'string' ? body.code.trim() : '';
  if (!stateInput || !codeInput) {
    return invalidInputResponse('state and code are required.');
  }

  return withUserContext(auth.userId, async () => {
    const existing = await loadOauthState({
      providerId: ANTHROPIC_PROVIDER_ID,
      state: stateInput,
    });
    if (!existing) {
      return notFoundResponse('OAuth state not found.');
    }
    if (existing.consumed_at) {
      return invalidInputResponse('This OAuth link has already been used.');
    }
    if (Date.parse(existing.expires_at) <= Date.now()) {
      return invalidInputResponse('OAuth state expired. Start the flow again.');
    }
    if (existing.flow_kind !== 'pkce' || !existing.code_verifier) {
      return invalidInputResponse('OAuth state is not a PKCE flow.');
    }

    const tokens = await exchangeAnthropicAuthorizationCode({
      code: codeInput,
      codeVerifier: existing.code_verifier,
      state: stateInput,
    });

    await persistSubscriptionCredential({
      providerId: ANTHROPIC_PROVIDER_ID,
      userId: auth.userId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAtIso: tokens.expiresAtIso,
    });
    await markOauthStateConsumed(existing.id);

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: { expiresAt: tokens.expiresAtIso },
      },
    };
  });
}

// ─── OpenAI Codex device-code flow ────────────────────────────────

export interface OpenAiCodexOauthPollBody {
  state?: unknown;
}

export async function initiateOpenAiCodexOauthRoute(
  auth: AuthContext,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    state: string;
    userCode: string;
    verificationUrl: string;
    pollIntervalSeconds: number;
    expiresAt: string;
  }>;
}> {
  return withUserContext(auth.userId, async () => {
    const device = await requestOpenAiCodexDeviceCode();
    const state = crypto.randomUUID();
    await insertDeviceCodeState({
      providerId: OPENAI_CODEX_PROVIDER_ID,
      state,
      userId: auth.userId,
      deviceAuthId: device.deviceAuthId,
      userCode: device.userCode,
      expiresAtIso: device.expiresAtIso,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          state,
          userCode: device.userCode,
          verificationUrl: device.verificationUrl,
          pollIntervalSeconds: device.pollIntervalSeconds,
          expiresAt: device.expiresAtIso,
        },
      },
    };
  });
}

export async function pollOpenAiCodexOauthRoute(
  auth: AuthContext,
  body: OpenAiCodexOauthPollBody,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<
    | {
        status: 'authorized';
        expiresAt: string;
      }
    | { status: 'pending' }
  >;
}> {
  const stateInput = typeof body.state === 'string' ? body.state.trim() : '';
  if (!stateInput) {
    return invalidInputResponse('state is required.');
  }

  return withUserContext(auth.userId, async () => {
    const existing = await loadOauthState({
      providerId: OPENAI_CODEX_PROVIDER_ID,
      state: stateInput,
    });
    if (!existing) {
      return notFoundResponse('OAuth state not found.');
    }
    if (existing.consumed_at) {
      return invalidInputResponse('This OAuth link has already been used.');
    }
    if (Date.parse(existing.expires_at) <= Date.now()) {
      return invalidInputResponse('OAuth state expired. Start the flow again.');
    }
    if (
      existing.flow_kind !== 'device_code' ||
      !existing.device_auth_id ||
      !existing.user_code
    ) {
      return invalidInputResponse('OAuth state is not a device-code flow.');
    }

    const poll = await pollOpenAiCodexDeviceAuth({
      deviceAuthId: existing.device_auth_id,
      userCode: existing.user_code,
    });

    if (poll.status === 'pending') {
      return {
        statusCode: 200,
        body: { ok: true, data: { status: 'pending' } },
      };
    }
    if (
      poll.status === 'error' ||
      !poll.authorizationCode ||
      !poll.codeVerifier
    ) {
      return invalidInputResponse(
        poll.errorMessage ?? 'OpenAI device auth failed.',
      );
    }

    const tokens = await exchangeOpenAiCodexAuthorizationCode({
      authorizationCode: poll.authorizationCode,
      codeVerifier: poll.codeVerifier,
    });

    await persistSubscriptionCredential({
      providerId: OPENAI_CODEX_PROVIDER_ID,
      userId: auth.userId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAtIso: tokens.expiresAtIso,
    });
    await markOauthStateConsumed(existing.id);

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          status: 'authorized',
          expiresAt: tokens.expiresAtIso,
        },
      },
    };
  });
}
