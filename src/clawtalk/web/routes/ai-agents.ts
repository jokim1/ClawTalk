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
  discoverNvidiaModels,
  invalidateNvidiaDiscovery,
  type DiscoveryCacheLike,
  type DiscoveryResult,
} from '../../agents/nvidia-model-discovery.js';
import {
  discoverAnthropicModels,
  invalidateAnthropicDiscovery,
  isCurrentGenerationClaudeModel,
} from '../../agents/anthropic-model-discovery.js';
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
  hasPersonalSubscription: boolean;
  personalSubscriptionExpiresAt: string | null;
  modelSuggestions: Array<{
    modelId: string;
    displayName: string;
    contextWindowTokens: number;
    defaultMaxOutputTokens: number;
    supportsTools: boolean;
    supportsVision: boolean;
  }>;
  // Only populated for providers that support live model discovery
  // (NVIDIA today). Reflects the last call to the provider's /v1/models
  // endpoint using whichever credential the cards were built with.
  liveModelDiscovery?: {
    status: 'ok' | 'auth_error' | 'unavailable' | 'rate_limited';
    message?: string;
  };
};

export type AiAgentsPageData = {
  defaultClaudeModelId: string;
  claudeModelSuggestions: ClaudeModelSuggestion[];
  additionalProviders: AgentProviderCard[];
};

interface ProviderSecretBody {
  apiKey?: unknown;
  organizationId?: unknown;
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
const NVIDIA_PROVIDER_ID = 'provider.nvidia';
const ANTHROPIC_PROVIDER_ID = 'provider.anthropic';

/**
 * Return the Cloudflare Workers default Cache, or undefined in environments
 * (Node, tests) that don't expose it. `caches.default` is a Workers
 * extension; we keep the type loose (`unknown` → `DiscoveryCacheLike`) so
 * the project tsconfig doesn't need @cloudflare/workers-types just for
 * this one helper.
 */
function getDefaultCache(): DiscoveryCacheLike | undefined {
  const g = globalThis as typeof globalThis & {
    caches?: { default?: unknown };
  };
  return (g.caches?.default ?? undefined) as DiscoveryCacheLike | undefined;
}

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

async function buildAdditionalProviderCards(): Promise<AgentProviderCard[]> {
  const providerRows = await listAdditionalProviderRows();
  const modelsByProvider = await listAdditionalProviderModels();
  const secretsByProvider = await listProviderSecrets();
  const verificationsByProvider = await listProviderVerifications();
  const personalSubscriptionsByProvider =
    await listPersonalSubscriptionMetadata();

  // Live model discovery. With no credential at all (or an auth_error),
  // the card just shows the curated rows from llm_provider_models. NVIDIA
  // and Anthropic run in parallel — each is an independent, cached (~1h)
  // network call.
  //
  // Anthropic discovery makes a newly-released Claude model appear in the
  // picker automatically — no migration. It needs an Anthropic API key
  // (the subscription/OAuth token is scoped to /v1/messages); without one
  // it degrades to the curated rows.
  const credentialFor = (providerId: string): string | null =>
    secretsByProvider.get(providerId)?.apiKey ?? null;
  const nvidiaKey = credentialFor(NVIDIA_PROVIDER_ID);
  const anthropicKey = credentialFor(ANTHROPIC_PROVIDER_ID);
  const cache = getDefaultCache();
  const [nvidiaDiscovery, anthropicDiscovery] = await Promise.all([
    nvidiaKey ? discoverNvidiaModels(nvidiaKey, { cache }) : null,
    anthropicKey ? discoverAnthropicModels(anthropicKey, { cache }) : null,
  ]);

  // Discovery returns the RAW Claude list (authoritative — used for
  // retirement checks elsewhere). For the picker we hide superseded legacy
  // generations so the dropdown stays focused on the current line.
  const anthropicPickerDiscovery: DiscoveryResult | null =
    anthropicDiscovery && anthropicDiscovery.status === 'ok'
      ? {
          ...anthropicDiscovery,
          models: anthropicDiscovery.models.filter((m) =>
            isCurrentGenerationClaudeModel(m.modelId),
          ),
        }
      : anthropicDiscovery;

  const discoveryFor = (providerId: string): DiscoveryResult | null => {
    if (providerId === NVIDIA_PROVIDER_ID) return nvidiaDiscovery;
    if (providerId === ANTHROPIC_PROVIDER_ID) return anthropicPickerDiscovery;
    return null;
  };

  return providerRows.map((provider) => {
    const builtinProvider = BUILTIN_ADDITIONAL_PROVIDERS.find(
      (entry) => entry.id === provider.id,
    );
    const discovery = discoveryFor(provider.id);
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
    const hasCredential = !!secret;
    const verificationStatus: AdditionalProviderVerificationStatus =
      !hasCredential ? 'missing' : (verification?.status ?? 'not_verified');
    const credentialHint = secret ? maskApiKey(secret.apiKey) : null;

    const personalSubscription = personalSubscriptionsByProvider.get(
      provider.id,
    );

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
      hasPersonalSubscription: !!personalSubscription,
      personalSubscriptionExpiresAt: personalSubscription?.expiresAt ?? null,
      modelSuggestions: buildModelSuggestions(
        provider.id,
        modelsByProvider.get(provider.id) ?? [],
        discovery,
      ),
      ...(discovery
        ? {
            liveModelDiscovery: {
              status: discovery.status,
              ...(discovery.message ? { message: discovery.message } : {}),
            },
          }
        : {}),
    };
  });
}

/**
 * Curated DB models come first (they carry display name + capability
 * metadata); live-discovered models append on top, deduped against the
 * curated set by modelId. A discovered model uses the provider-supplied
 * displayName when present (Anthropic returns one) and falls back to the
 * raw modelId otherwise (NVIDIA's /v1/models has no friendly label).
 *
 * Exported for unit testing.
 */
export function buildModelSuggestions(
  providerId: string,
  curated: ProviderModelRow[],
  discovery: DiscoveryResult | null,
): AgentProviderCard['modelSuggestions'] {
  const seen = new Set<string>();
  const suggestions: AgentProviderCard['modelSuggestions'] = [];

  for (const model of curated) {
    seen.add(model.model_id);
    const capabilities = resolveModelCapabilities({
      providerId,
      modelId: model.model_id,
    });
    suggestions.push({
      modelId: model.model_id,
      displayName: model.display_name,
      contextWindowTokens: model.context_window_tokens,
      defaultMaxOutputTokens: model.default_max_output_tokens,
      supportsTools: capabilities.supports_tools,
      supportsVision: capabilities.supports_vision,
    });
  }

  if (discovery?.status === 'ok') {
    for (const live of discovery.models) {
      if (seen.has(live.modelId)) continue;
      seen.add(live.modelId);
      const capabilities = resolveModelCapabilities({
        providerId,
        modelId: live.modelId,
      });
      suggestions.push({
        modelId: live.modelId,
        displayName: live.displayName ?? live.modelId,
        contextWindowTokens: 0,
        defaultMaxOutputTokens: 0,
        supportsTools: capabilities.supports_tools,
        supportsVision: capabilities.supports_vision,
      });
    }
  }

  return suggestions;
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
    if (error.failureClass === 'blocked') {
      return {
        status: 'unavailable',
        lastVerifiedAt: null,
        lastError:
          'Blocked by Cloudflare bot-protection. This ChatGPT-subscription ' +
          'endpoint rejects server-side requests — use an OpenAI API key or ' +
          'another capable model.',
      };
    }
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
): Promise<void> {
  const provider = await getAdditionalProvider(providerId);
  if (!provider) {
    throw new Error(`Provider '${providerId}' is not supported.`);
  }

  // Subscription-only providers (Codex) skip the API-key verification
  // path entirely — the OAuth flow handles connect/refresh separately.
  if (providerId === CODEX_PROVIDER_ID) {
    await deleteProviderVerification(providerId);
    return;
  }

  const db = getDbPg();
  const secretRows = await db<Array<{ ciphertext: string }>>`
    select ciphertext from public.llm_provider_secrets
    where provider_id = ${providerId}
      and credential_kind = 'api_key'
  `;
  const secret = secretRows[0]
    ? await parseStoredSecret(secretRows[0].ciphertext)
    : null;
  if (!secret) {
    await deleteProviderVerification(providerId);
    return;
  }

  const model = await getPrimaryProviderModel(providerId);
  if (!model) {
    await upsertProviderVerification(ownerId, providerId, {
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
    await upsertProviderVerification(ownerId, providerId, {
      status: 'verified',
      lastVerifiedAt: new Date().toISOString(),
      lastError: null,
    });
  } catch (error) {
    await upsertProviderVerification(
      ownerId,
      providerId,
      mapVerificationFailure(error),
    );
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
      await db`
        delete from public.llm_provider_secrets
        where provider_id = ${providerId}
          and credential_kind = 'api_key'
      `;
      await deleteProviderVerification(providerId);
      return getProviderCardOrNotFound(providerId);
    }

    const ciphertext = await encryptProviderSecret({
      apiKey,
      ...(organizationId ? { organizationId } : {}),
    });
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

    await verifyProviderSecret(auth.userId, providerId);
    // Drop any cached discovery for this exact key so a freshly saved key
    // is reflected immediately. Handles the edge case where the user
    // re-pastes the same key after the provider invalidated it
    // server-side — without this, the stale "ok" cache hides the failure
    // for up to an hour.
    if (providerId === NVIDIA_PROVIDER_ID) {
      await invalidateNvidiaDiscovery(apiKey, getDefaultCache());
    } else if (providerId === ANTHROPIC_PROVIDER_ID) {
      await invalidateAnthropicDiscovery(apiKey, getDefaultCache());
    }
    return getProviderCardOrNotFound(providerId);
  });
}

export async function verifyAiProviderCredentialRoute(
  auth: AuthContext,
  providerId: string,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ provider: AgentProviderCard }>;
}> {
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

    await verifyProviderSecret(auth.userId, providerId);
    return getProviderCardOrNotFound(providerId);
  });
}
