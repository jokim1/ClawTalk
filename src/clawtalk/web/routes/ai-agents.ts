import { getDbPg, withUserContext } from '../../../db.js';
import {
  BUILTIN_ADDITIONAL_PROVIDER_IDS,
  BUILTIN_ADDITIONAL_PROVIDERS,
} from '../../agents/builtin-additional-providers.js';
import {
  LlmClientError,
  callLlm,
  type LlmProviderConfig,
  type LlmSecret,
} from '../../agents/llm-client.js';
import {
  decryptProviderSecret,
  encryptProviderSecret,
} from '../../llm/provider-secret-store.js';
import { resolveModelCapabilities } from '../../llm/capabilities.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

type AdditionalProviderVerificationStatus =
  | 'missing'
  | 'not_verified'
  | 'verifying'
  | 'verified'
  | 'invalid'
  | 'unavailable';

type ClaudeModelSuggestion = {
  modelId: string;
  displayName: string;
  contextWindowTokens: number;
  defaultMaxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
};

export type ProviderCredentialScope = 'user' | 'workspace';

export type AgentProviderCard = {
  id: string;
  name: string;
  providerKind: 'anthropic' | 'openai' | 'gemini' | 'nvidia';
  apiFormat: 'anthropic_messages' | 'openai_chat_completions';
  baseUrl: string;
  authScheme: 'x_api_key' | 'bearer';
  enabled: boolean;
  credentialMode: 'api_key' | 'subscription_only';
  hasCredential: boolean;
  credentialHint: string | null;
  verificationStatus: AdditionalProviderVerificationStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  // Workspace-shared credential (admin-managed). Visible to all
  // members; the executor falls back to this when the caller has no
  // personal credential of their own.
  workspaceHasCredential: boolean;
  workspaceCredentialHint: string | null;
  workspaceVerificationStatus: AdditionalProviderVerificationStatus;
  workspaceLastVerifiedAt: string | null;
  workspaceLastVerificationError: string | null;
  // OAuth subscription metadata. Either or both may be present
  // alongside api-key credentials — the resolver prefers api_key but
  // falls back to subscription when only the OAuth route is set.
  hasPersonalSubscription: boolean;
  personalSubscriptionExpiresAt: string | null;
  hasWorkspaceSubscription: boolean;
  workspaceSubscriptionExpiresAt: string | null;
  modelSuggestions: Array<{
    modelId: string;
    displayName: string;
    contextWindowTokens: number;
    defaultMaxOutputTokens: number;
    supportsTools: boolean;
    supportsVision: boolean;
  }>;
};

export type AiAgentsPageData = {
  defaultClaudeModelId: string;
  claudeModelSuggestions: ClaudeModelSuggestion[];
  additionalProviders: AgentProviderCard[];
};

interface ProviderSecretBody {
  apiKey?: unknown;
  organizationId?: unknown;
  scope?: unknown;
}

function parseScope(value: unknown): ProviderCredentialScope {
  return value === 'workspace' ? 'workspace' : 'user';
}

interface ProviderRow {
  id: string;
  name: string;
  provider_kind: 'anthropic' | 'openai' | 'gemini' | 'nvidia';
  api_format: 'anthropic_messages' | 'openai_chat_completions';
  base_url: string;
  auth_scheme: 'x_api_key' | 'bearer';
  enabled: boolean;
  response_start_timeout_ms: number | null;
  stream_idle_timeout_ms: number | null;
  absolute_timeout_ms: number | null;
}

interface ProviderModelRow {
  provider_id: string;
  model_id: string;
  display_name: string;
  context_window_tokens: number;
  default_max_output_tokens: number;
  default_ttft_timeout_ms: number | null;
}

interface ProviderVerificationRow {
  status: AdditionalProviderVerificationStatus;
  last_verified_at: string | null;
  last_error: string | null;
}

type ProviderVerificationResult = {
  status: 'verified' | 'invalid' | 'unavailable';
  lastVerifiedAt: string | null;
  lastError: string | null;
};

const CODEX_PROVIDER_ID = 'provider.openai_codex';

const PROVIDER_VERIFY_TIMEOUT_MS = 20_000;

const BUILTIN_ADDITIONAL_PROVIDER_ORDER = new Map(
  BUILTIN_ADDITIONAL_PROVIDERS.map((provider, index) => [provider.id, index]),
);

function isAdminLike(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

function maskApiKey(apiKey: string): string {
  return `••••${apiKey.slice(-4)}`;
}

async function parseStoredSecret(
  ciphertext: string,
): Promise<LlmSecret | null> {
  try {
    return await decryptProviderSecret(ciphertext);
  } catch {
    return null;
  }
}

async function getClaudeModelSuggestions(): Promise<ClaudeModelSuggestion[]> {
  const db = getDbPg();
  const rows = await db<
    Array<{
      model_id: string;
      display_name: string;
      context_window_tokens: number;
      default_max_output_tokens: number;
    }>
  >`
    select model_id, display_name, context_window_tokens,
           default_max_output_tokens
    from public.llm_provider_models
    where provider_id = 'provider.anthropic' and enabled = true
    order by display_name asc
  `;

  return rows.map((row) => {
    const capabilities = resolveModelCapabilities({
      providerId: 'provider.anthropic',
      modelId: row.model_id,
    });
    return {
      modelId: row.model_id,
      displayName: row.display_name,
      contextWindowTokens: row.context_window_tokens,
      defaultMaxOutputTokens: row.default_max_output_tokens,
      supportsTools: capabilities.supports_tools,
      supportsVision: capabilities.supports_vision,
    };
  });
}

async function getSavedDefaultClaudeModelId(): Promise<string | null> {
  const db = getDbPg();
  const rows = await db<Array<{ value: string | null }>>`
    select value from public.settings_kv
    where key = 'executor.defaultClaudeModel'
    limit 1
  `;
  return rows[0]?.value ?? null;
}

async function listAdditionalProviderRows(): Promise<ProviderRow[]> {
  const db = getDbPg();
  const rows = await db<ProviderRow[]>`
    select id, name, provider_kind, api_format, base_url, auth_scheme,
           enabled, response_start_timeout_ms, stream_idle_timeout_ms,
           absolute_timeout_ms
    from public.llm_providers
    where enabled = true and id = any(${BUILTIN_ADDITIONAL_PROVIDER_IDS})
  `;

  return rows.sort(
    (left, right) =>
      (BUILTIN_ADDITIONAL_PROVIDER_ORDER.get(left.id) ?? 999) -
      (BUILTIN_ADDITIONAL_PROVIDER_ORDER.get(right.id) ?? 999),
  );
}

async function listAdditionalProviderModels(): Promise<
  Map<string, ProviderModelRow[]>
> {
  const db = getDbPg();
  const rows = await db<ProviderModelRow[]>`
    select provider_id, model_id, display_name, context_window_tokens,
           default_max_output_tokens, default_ttft_timeout_ms
    from public.llm_provider_models
    where provider_id = any(${BUILTIN_ADDITIONAL_PROVIDER_IDS})
      and enabled = true
    order by provider_id asc, display_name asc
  `;

  const byProvider = new Map<string, ProviderModelRow[]>();
  for (const row of rows) {
    const current = byProvider.get(row.provider_id) ?? [];
    current.push(row);
    byProvider.set(row.provider_id, current);
  }
  return byProvider;
}

async function listProviderSecrets(): Promise<Map<string, LlmSecret | null>> {
  const db = getDbPg();
  const rows = await db<Array<{ provider_id: string; ciphertext: string }>>`
    select provider_id, ciphertext
    from public.llm_provider_secrets
    where provider_id = any(${BUILTIN_ADDITIONAL_PROVIDER_IDS})
      and credential_kind = 'api_key'
  `;

  const entries = await Promise.all(
    rows.map(
      async (row): Promise<[string, LlmSecret | null]> => [
        row.provider_id,
        await parseStoredSecret(row.ciphertext),
      ],
    ),
  );
  return new Map(entries);
}

async function listProviderVerifications(): Promise<
  Map<string, ProviderVerificationRow>
> {
  const db = getDbPg();
  const rows = await db<
    Array<{
      provider_id: string;
      status: AdditionalProviderVerificationStatus;
      last_verified_at: string | null;
      last_error: string | null;
    }>
  >`
    select provider_id, status, last_verified_at, last_error
    from public.llm_provider_verifications
    where provider_id = any(${BUILTIN_ADDITIONAL_PROVIDER_IDS})
      and credential_kind = 'api_key'
  `;

  return new Map(
    rows.map((row) => [
      row.provider_id,
      {
        status: row.status,
        last_verified_at: row.last_verified_at,
        last_error: row.last_error,
      },
    ]),
  );
}

async function listWorkspaceProviderSecrets(): Promise<
  Map<string, LlmSecret | null>
> {
  const db = getDbPg();
  const rows = await db<Array<{ provider_id: string; ciphertext: string }>>`
    select provider_id, ciphertext
    from public.workspace_provider_secrets
    where provider_id = any(${BUILTIN_ADDITIONAL_PROVIDER_IDS})
      and credential_kind = 'api_key'
  `;

  const entries = await Promise.all(
    rows.map(
      async (row): Promise<[string, LlmSecret | null]> => [
        row.provider_id,
        await parseStoredSecret(row.ciphertext),
      ],
    ),
  );
  return new Map(entries);
}

async function listPersonalSubscriptionMetadata(): Promise<
  Map<string, { expiresAt: string | null }>
> {
  const db = getDbPg();
  const rows = await db<
    Array<{ provider_id: string; expires_at: string | null }>
  >`
    select provider_id, expires_at::text as expires_at
    from public.llm_provider_secrets
    where credential_kind = 'subscription'
      and provider_id = any(${BUILTIN_ADDITIONAL_PROVIDER_IDS})
  `;
  return new Map(
    rows.map((row) => [row.provider_id, { expiresAt: row.expires_at }]),
  );
}

async function listWorkspaceSubscriptionMetadata(): Promise<
  Map<string, { expiresAt: string | null }>
> {
  const db = getDbPg();
  const rows = await db<
    Array<{ provider_id: string; expires_at: string | null }>
  >`
    select provider_id, expires_at::text as expires_at
    from public.workspace_provider_secrets
    where credential_kind = 'subscription'
      and provider_id = any(${BUILTIN_ADDITIONAL_PROVIDER_IDS})
  `;
  return new Map(
    rows.map((row) => [row.provider_id, { expiresAt: row.expires_at }]),
  );
}

async function listWorkspaceProviderVerifications(): Promise<
  Map<string, ProviderVerificationRow>
> {
  const db = getDbPg();
  const rows = await db<
    Array<{
      provider_id: string;
      status: AdditionalProviderVerificationStatus;
      last_verified_at: string | null;
      last_error: string | null;
    }>
  >`
    select provider_id, status, last_verified_at, last_error
    from public.workspace_provider_verifications
    where provider_id = any(${BUILTIN_ADDITIONAL_PROVIDER_IDS})
      and credential_kind = 'api_key'
  `;

  return new Map(
    rows.map((row) => [
      row.provider_id,
      {
        status: row.status,
        last_verified_at: row.last_verified_at,
        last_error: row.last_error,
      },
    ]),
  );
}

async function buildAdditionalProviderCards(): Promise<AgentProviderCard[]> {
  const providerRows = await listAdditionalProviderRows();
  const modelsByProvider = await listAdditionalProviderModels();
  const secretsByProvider = await listProviderSecrets();
  const verificationsByProvider = await listProviderVerifications();
  const workspaceSecretsByProvider = await listWorkspaceProviderSecrets();
  const workspaceVerificationsByProvider =
    await listWorkspaceProviderVerifications();
  const personalSubscriptionsByProvider =
    await listPersonalSubscriptionMetadata();
  const workspaceSubscriptionsByProvider =
    await listWorkspaceSubscriptionMetadata();

  return providerRows.map((provider) => {
    const builtinProvider = BUILTIN_ADDITIONAL_PROVIDERS.find(
      (entry) => entry.id === provider.id,
    );
    const credentialMode = builtinProvider?.credentialMode ?? 'api_key';
    // Subscription-only providers (e.g. ChatGPT Codex) have no API
    // key surface — the card hides the api-key field, and credential
    // state is carried entirely by the subscription metadata below.
    const secret =
      credentialMode === 'api_key'
        ? (secretsByProvider.get(provider.id) ?? null)
        : null;
    const verification =
      credentialMode === 'api_key'
        ? verificationsByProvider.get(provider.id)
        : undefined;
    const workspaceSecret =
      credentialMode === 'api_key'
        ? (workspaceSecretsByProvider.get(provider.id) ?? null)
        : null;
    const workspaceVerification =
      credentialMode === 'api_key'
        ? workspaceVerificationsByProvider.get(provider.id)
        : undefined;
    const hasCredential = !!secret;
    const verificationStatus: AdditionalProviderVerificationStatus =
      !hasCredential ? 'missing' : (verification?.status ?? 'not_verified');
    const credentialHint = secret ? maskApiKey(secret.apiKey) : null;

    const personalSubscription = personalSubscriptionsByProvider.get(
      provider.id,
    );
    const workspaceSubscription = workspaceSubscriptionsByProvider.get(
      provider.id,
    );

    const workspaceHasCredential = !!workspaceSecret;
    const workspaceVerificationStatus: AdditionalProviderVerificationStatus =
      !workspaceHasCredential
        ? 'missing'
        : (workspaceVerification?.status ?? 'not_verified');
    const workspaceCredentialHint = workspaceSecret
      ? maskApiKey(workspaceSecret.apiKey)
      : null;

    return {
      id: provider.id,
      name: provider.name,
      providerKind: provider.provider_kind,
      apiFormat: provider.api_format,
      baseUrl: provider.base_url,
      authScheme: provider.auth_scheme,
      enabled: provider.enabled,
      credentialMode,
      hasCredential,
      credentialHint,
      verificationStatus,
      lastVerifiedAt:
        verificationStatus === 'verified'
          ? (verification?.last_verified_at ?? null)
          : null,
      lastVerificationError:
        verificationStatus === 'invalid' || verificationStatus === 'unavailable'
          ? (verification?.last_error ?? null)
          : null,
      workspaceHasCredential,
      workspaceCredentialHint,
      workspaceVerificationStatus,
      workspaceLastVerifiedAt:
        workspaceVerificationStatus === 'verified'
          ? (workspaceVerification?.last_verified_at ?? null)
          : null,
      workspaceLastVerificationError:
        workspaceVerificationStatus === 'invalid' ||
        workspaceVerificationStatus === 'unavailable'
          ? (workspaceVerification?.last_error ?? null)
          : null,
      hasPersonalSubscription: !!personalSubscription,
      personalSubscriptionExpiresAt: personalSubscription?.expiresAt ?? null,
      hasWorkspaceSubscription: !!workspaceSubscription,
      workspaceSubscriptionExpiresAt: workspaceSubscription?.expiresAt ?? null,
      modelSuggestions: (modelsByProvider.get(provider.id) ?? []).map(
        (model) => {
          const capabilities = resolveModelCapabilities({
            providerId: provider.id,
            modelId: model.model_id,
          });
          return {
            modelId: model.model_id,
            displayName: model.display_name,
            contextWindowTokens: model.context_window_tokens,
            defaultMaxOutputTokens: model.default_max_output_tokens,
            supportsTools: capabilities.supports_tools,
            supportsVision: capabilities.supports_vision,
          };
        },
      ),
    };
  });
}

export async function buildAiAgentsPageData(): Promise<AiAgentsPageData> {
  const claudeModelSuggestions = await getClaudeModelSuggestions();
  const savedDefault = await getSavedDefaultClaudeModelId();
  return {
    defaultClaudeModelId:
      savedDefault || claudeModelSuggestions[0]?.modelId || 'claude-sonnet-4-6',
    claudeModelSuggestions,
    additionalProviders: await buildAdditionalProviderCards(),
  };
}

async function getAdditionalProvider(
  providerId: string,
): Promise<ProviderRow | null> {
  if (!BUILTIN_ADDITIONAL_PROVIDER_IDS.includes(providerId)) {
    return null;
  }
  const db = getDbPg();
  const rows = await db<ProviderRow[]>`
    select id, name, provider_kind, api_format, base_url, auth_scheme,
           enabled, response_start_timeout_ms, stream_idle_timeout_ms,
           absolute_timeout_ms
    from public.llm_providers
    where id = ${providerId} and enabled = true
  `;
  return rows[0] ?? null;
}

async function getPrimaryProviderModel(
  providerId: string,
): Promise<ProviderModelRow | null> {
  const db = getDbPg();
  const rows = await db<ProviderModelRow[]>`
    select provider_id, model_id, display_name, context_window_tokens,
           default_max_output_tokens, default_ttft_timeout_ms
    from public.llm_provider_models
    where provider_id = ${providerId} and enabled = true
    order by display_name asc
    limit 1
  `;
  return rows[0] ?? null;
}

async function upsertProviderVerification(
  ownerId: string,
  providerId: string,
  result: ProviderVerificationResult,
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.llm_provider_verifications (
      owner_id, provider_id, credential_kind, status,
      last_verified_at, last_error
    )
    values (
      ${ownerId}::uuid, ${providerId}, 'api_key', ${result.status},
      ${result.lastVerifiedAt}::timestamptz, ${result.lastError}
    )
    on conflict (owner_id, provider_id, credential_kind) do update set
      status = excluded.status,
      last_verified_at = excluded.last_verified_at,
      last_error = excluded.last_error,
      updated_at = now()
  `;
}

async function deleteProviderVerification(providerId: string): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.llm_provider_verifications
    where provider_id = ${providerId}
      and credential_kind = 'api_key'
  `;
}

async function upsertWorkspaceProviderVerification(
  providerId: string,
  result: ProviderVerificationResult,
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.workspace_provider_verifications (
      provider_id, credential_kind, status, last_verified_at, last_error
    )
    values (
      ${providerId}, 'api_key', ${result.status},
      ${result.lastVerifiedAt}::timestamptz, ${result.lastError}
    )
    on conflict (provider_id, credential_kind) do update set
      status = excluded.status,
      last_verified_at = excluded.last_verified_at,
      last_error = excluded.last_error,
      updated_at = now()
  `;
}

async function deleteWorkspaceProviderVerification(
  providerId: string,
): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.workspace_provider_verifications
    where provider_id = ${providerId}
      and credential_kind = 'api_key'
  `;
}

function buildProviderConfig(provider: ProviderRow): LlmProviderConfig {
  return {
    providerId: provider.id,
    baseUrl: provider.base_url,
    apiFormat: provider.api_format,
    authScheme: provider.auth_scheme,
    responseStartTimeoutMs: provider.response_start_timeout_ms ?? undefined,
    streamIdleTimeoutMs: provider.stream_idle_timeout_ms ?? undefined,
    absoluteTimeoutMs: provider.absolute_timeout_ms ?? undefined,
  };
}

function mapVerificationFailure(error: unknown): ProviderVerificationResult {
  if (error instanceof LlmClientError) {
    if (error.failureClass === 'auth') {
      return {
        status: 'invalid',
        lastVerifiedAt: null,
        lastError: 'Invalid API key.',
      };
    }
    if (error.failureClass === 'rate_limit') {
      return {
        status: 'unavailable',
        lastVerifiedAt: null,
        lastError: 'Provider verification was rate limited. Try again shortly.',
      };
    }
    if (error.failureClass === 'invalid_request') {
      return {
        status: 'unavailable',
        lastVerifiedAt: null,
        lastError:
          'Provider verification request was rejected by the upstream API.',
      };
    }
  }

  return {
    status: 'unavailable',
    lastVerifiedAt: null,
    lastError:
      'Provider verification failed due to a network or upstream error.',
  };
}

async function verifyProviderSecret(
  ownerId: string,
  providerId: string,
  scope: ProviderCredentialScope = 'user',
): Promise<void> {
  const provider = await getAdditionalProvider(providerId);
  if (!provider) {
    throw new Error(`Provider '${providerId}' is not supported.`);
  }

  const writeVerification = async (
    result: ProviderVerificationResult,
  ): Promise<void> => {
    if (scope === 'workspace') {
      await upsertWorkspaceProviderVerification(providerId, result);
    } else {
      await upsertProviderVerification(ownerId, providerId, result);
    }
  };

  const dropVerification = async (): Promise<void> => {
    if (scope === 'workspace') {
      await deleteWorkspaceProviderVerification(providerId);
    } else {
      await deleteProviderVerification(providerId);
    }
  };

  // Subscription-only providers (Codex) skip the API-key verification
  // path entirely — the OAuth flow handles connect/refresh separately.
  if (providerId === CODEX_PROVIDER_ID) {
    await dropVerification();
    return;
  }

  const db = getDbPg();
  const secretRows =
    scope === 'workspace'
      ? await db<Array<{ ciphertext: string }>>`
          select ciphertext from public.workspace_provider_secrets
          where provider_id = ${providerId}
            and credential_kind = 'api_key'
        `
      : await db<Array<{ ciphertext: string }>>`
          select ciphertext from public.llm_provider_secrets
          where provider_id = ${providerId}
            and credential_kind = 'api_key'
        `;
  const secret = secretRows[0]
    ? await parseStoredSecret(secretRows[0].ciphertext)
    : null;
  if (!secret) {
    await dropVerification();
    return;
  }

  const model = await getPrimaryProviderModel(providerId);
  if (!model) {
    await writeVerification({
      status: 'unavailable',
      lastVerifiedAt: null,
      lastError:
        'No enabled verification model is configured for this provider.',
    });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort('provider_verify_timeout');
  }, PROVIDER_VERIFY_TIMEOUT_MS);

  try {
    await callLlm(
      buildProviderConfig(provider),
      secret,
      model.model_id,
      [{ role: 'user', content: 'Reply with OK.' }],
      {
        maxOutputTokens: 16,
        signal: controller.signal,
      },
    );
    await writeVerification({
      status: 'verified',
      lastVerifiedAt: new Date().toISOString(),
      lastError: null,
    });
  } catch (error) {
    await writeVerification(mapVerificationFailure(error));
  } finally {
    clearTimeout(timer);
  }
}

async function getProviderCardOrNotFound(providerId: string): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ provider: AgentProviderCard }>;
}> {
  const provider = (await buildAdditionalProviderCards()).find(
    (entry) => entry.id === providerId,
  );
  if (!provider) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'not_found',
          message: `Provider '${providerId}' not found.`,
        },
      },
    };
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: { provider },
    },
  };
}

export async function getAiAgentsRoute(auth: AuthContext): Promise<{
  statusCode: number;
  body: ApiEnvelope<AiAgentsPageData>;
}> {
  const data = await withUserContext(auth.userId, () =>
    buildAiAgentsPageData(),
  );
  return {
    statusCode: 200,
    body: {
      ok: true,
      data,
    },
  };
}

export async function updateDefaultClaudeModelRoute(
  auth: AuthContext,
  body: { modelId?: unknown },
): Promise<{
  statusCode: number;
  body: ApiEnvelope<AiAgentsPageData>;
}> {
  if (!isAdminLike(auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to update Claude settings.',
        },
      },
    };
  }

  if (typeof body.modelId !== 'string' || !body.modelId.trim()) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'modelId is required.',
        },
      },
    };
  }

  const modelId = body.modelId;
  const data = await withUserContext(auth.userId, async () => {
    const db = getDbPg();
    await db`
      insert into public.settings_kv (key, value, updated_by)
      values ('executor.defaultClaudeModel', ${modelId},
              ${auth.userId}::uuid)
      on conflict (key) do update set
        value = excluded.value,
        updated_at = now(),
        updated_by = excluded.updated_by
    `;
    return buildAiAgentsPageData();
  });

  return {
    statusCode: 200,
    body: {
      ok: true,
      data,
    },
  };
}

export async function putAiProviderCredentialRoute(
  auth: AuthContext,
  providerId: string,
  body: ProviderSecretBody,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ provider: AgentProviderCard }>;
}> {
  const scope = parseScope(body.scope);
  if (scope === 'workspace' && !isAdminLike(auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message:
            'Only workspace admins can manage workspace-shared provider credentials.',
        },
      },
    };
  }

  return withUserContext(auth.userId, async () => {
    if (!(await getAdditionalProvider(providerId))) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'not_found',
            message: `Provider '${providerId}' not found.`,
          },
        },
      };
    }

    if (providerId === CODEX_PROVIDER_ID) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message:
              'ChatGPT Codex does not accept API keys. Use "Connect with ChatGPT" to authorize a subscription instead.',
          },
        },
      };
    }

    const apiKey =
      typeof body.apiKey === 'string' ? body.apiKey.trim() : body.apiKey;
    const organizationId =
      typeof body.organizationId === 'string'
        ? body.organizationId.trim() || undefined
        : undefined;

    if (apiKey !== null && apiKey !== undefined && typeof apiKey !== 'string') {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: 'apiKey must be a string or null.',
          },
        },
      };
    }

    const db = getDbPg();
    if (!apiKey) {
      if (scope === 'workspace') {
        await db`
          delete from public.workspace_provider_secrets
          where provider_id = ${providerId}
            and credential_kind = 'api_key'
        `;
        await deleteWorkspaceProviderVerification(providerId);
      } else {
        await db`
          delete from public.llm_provider_secrets
          where provider_id = ${providerId}
            and credential_kind = 'api_key'
        `;
        await deleteProviderVerification(providerId);
      }
      return getProviderCardOrNotFound(providerId);
    }

    const ciphertext = await encryptProviderSecret({
      apiKey,
      ...(organizationId ? { organizationId } : {}),
    });
    if (scope === 'workspace') {
      await db`
        insert into public.workspace_provider_secrets (
          provider_id, credential_kind, ciphertext, updated_by
        )
        values (
          ${providerId}, 'api_key', ${ciphertext}, ${auth.userId}::uuid
        )
        on conflict (provider_id, credential_kind) do update set
          ciphertext = excluded.ciphertext,
          updated_by = excluded.updated_by,
          updated_at = now()
      `;
    } else {
      await db`
        insert into public.llm_provider_secrets (
          owner_id, provider_id, credential_kind, ciphertext
        )
        values (
          ${auth.userId}::uuid, ${providerId}, 'api_key', ${ciphertext}
        )
        on conflict (owner_id, provider_id, credential_kind) do update set
          ciphertext = excluded.ciphertext,
          updated_at = now()
      `;
    }

    await verifyProviderSecret(auth.userId, providerId, scope);
    return getProviderCardOrNotFound(providerId);
  });
}

export async function verifyAiProviderCredentialRoute(
  auth: AuthContext,
  providerId: string,
  scope: ProviderCredentialScope = 'user',
): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ provider: AgentProviderCard }>;
}> {
  if (scope === 'workspace' && !isAdminLike(auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message:
            'Only workspace admins can verify workspace-shared provider credentials.',
        },
      },
    };
  }

  return withUserContext(auth.userId, async () => {
    if (!(await getAdditionalProvider(providerId))) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'not_found',
            message: `Provider '${providerId}' not found.`,
          },
        },
      };
    }

    await verifyProviderSecret(auth.userId, providerId, scope);
    return getProviderCardOrNotFound(providerId);
  });
}
