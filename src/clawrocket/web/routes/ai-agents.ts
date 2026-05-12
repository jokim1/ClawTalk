import { getDb } from '../../../db.js';
import {
  BUILTIN_ADDITIONAL_PROVIDER_IDS,
  BUILTIN_ADDITIONAL_PROVIDERS,
} from '../../agents/builtin-additional-providers.js';
import {
  CodexHostStatusService,
  type CodexHostStatusView,
} from '../../agents/codex-host-runtime.js';
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

export type AgentProviderCard = {
  id: string;
  name: string;
  providerKind: 'openai' | 'gemini' | 'nvidia';
  apiFormat: 'openai_chat_completions';
  baseUrl: string;
  authScheme: 'bearer';
  enabled: boolean;
  credentialMode: 'api_key' | 'host_login';
  hasCredential: boolean;
  credentialHint: string | null;
  verificationStatus: AdditionalProviderVerificationStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  hostStatus?: CodexHostStatusView;
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
}

interface ProviderRow {
  id: string;
  name: string;
  provider_kind: 'openai' | 'gemini' | 'nvidia';
  api_format: 'openai_chat_completions';
  base_url: string;
  auth_scheme: 'bearer';
  enabled: number;
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

function providerPlaceholders(): string {
  return BUILTIN_ADDITIONAL_PROVIDER_IDS.map(() => '?').join(', ');
}

function maskApiKey(apiKey: string): string {
  return `••••${apiKey.slice(-4)}`;
}

function parseStoredSecret(ciphertext: string): LlmSecret | null {
  try {
    return decryptProviderSecret(ciphertext);
  } catch {
    return null;
  }
}

function getClaudeModelSuggestions(): ClaudeModelSuggestion[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT model_id, display_name, context_window_tokens,
              default_max_output_tokens
       FROM llm_provider_models
       WHERE provider_id = 'provider.anthropic' AND enabled = 1
       ORDER BY display_name ASC`,
    )
    .all() as Array<{
    model_id: string;
    display_name: string;
    context_window_tokens: number;
    default_max_output_tokens: number;
  }>;

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

function getSavedDefaultClaudeModelId(): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT value FROM settings_kv WHERE key = 'executor.defaultClaudeModel'`,
    )
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

function listAdditionalProviderRows(): ProviderRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, name, provider_kind, api_format, base_url, auth_scheme,
              enabled, response_start_timeout_ms, stream_idle_timeout_ms,
              absolute_timeout_ms
       FROM llm_providers
       WHERE enabled = 1 AND id IN (${providerPlaceholders()})`,
    )
    .all(...BUILTIN_ADDITIONAL_PROVIDER_IDS) as ProviderRow[];

  return rows.sort(
    (left, right) =>
      (BUILTIN_ADDITIONAL_PROVIDER_ORDER.get(left.id) ?? 999) -
      (BUILTIN_ADDITIONAL_PROVIDER_ORDER.get(right.id) ?? 999),
  );
}

function listAdditionalProviderModels(): Map<string, ProviderModelRow[]> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT provider_id, model_id, display_name, context_window_tokens,
              default_max_output_tokens, default_ttft_timeout_ms
       FROM llm_provider_models
       WHERE provider_id IN (${providerPlaceholders()}) AND enabled = 1
       ORDER BY provider_id ASC, display_name ASC`,
    )
    .all(...BUILTIN_ADDITIONAL_PROVIDER_IDS) as ProviderModelRow[];

  const byProvider = new Map<string, ProviderModelRow[]>();
  for (const row of rows) {
    const current = byProvider.get(row.provider_id) ?? [];
    current.push(row);
    byProvider.set(row.provider_id, current);
  }
  return byProvider;
}

function listProviderSecrets(): Map<string, LlmSecret | null> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT provider_id, ciphertext
       FROM llm_provider_secrets
       WHERE provider_id IN (${providerPlaceholders()})`,
    )
    .all(...BUILTIN_ADDITIONAL_PROVIDER_IDS) as Array<{
    provider_id: string;
    ciphertext: string;
  }>;

  return new Map(
    rows.map((row) => [row.provider_id, parseStoredSecret(row.ciphertext)]),
  );
}

function listProviderVerifications(): Map<string, ProviderVerificationRow> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT provider_id, status, last_verified_at, last_error
       FROM llm_provider_verifications
       WHERE provider_id IN (${providerPlaceholders()})`,
    )
    .all(...BUILTIN_ADDITIONAL_PROVIDER_IDS) as Array<{
    provider_id: string;
    status: AdditionalProviderVerificationStatus;
    last_verified_at: string | null;
    last_error: string | null;
  }>;

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
  const providerRows = listAdditionalProviderRows();
  const modelsByProvider = listAdditionalProviderModels();
  const secretsByProvider = listProviderSecrets();
  const verificationsByProvider = listProviderVerifications();
  const codexHostStatus = providerRows.some(
    (provider) => provider.id === CODEX_PROVIDER_ID,
  )
    ? await new CodexHostStatusService().getStatusView()
    : null;

  return providerRows.map((provider) => {
    const builtinProvider = BUILTIN_ADDITIONAL_PROVIDERS.find(
      (entry) => entry.id === provider.id,
    );
    const credentialMode = builtinProvider?.credentialMode ?? 'api_key';
    const secret = secretsByProvider.get(provider.id) ?? null;
    const verification = verificationsByProvider.get(provider.id);
    const hostStatus =
      provider.id === CODEX_PROVIDER_ID
        ? (codexHostStatus ?? undefined)
        : undefined;
    const hasCredential =
      credentialMode === 'host_login' ? !!hostStatus?.authenticated : !!secret;
    const verificationStatus: AdditionalProviderVerificationStatus =
      credentialMode === 'host_login'
        ? !hostStatus?.cliInstalled || !hostStatus?.sandboxAvailable
          ? 'unavailable'
          : !hostStatus.authenticated
            ? 'missing'
            : (verification?.status ?? 'not_verified')
        : !hasCredential
          ? 'missing'
          : (verification?.status ?? 'not_verified');
    const credentialHint =
      credentialMode === 'host_login'
        ? hostStatus?.authMode === 'chatgpt'
          ? 'ChatGPT login'
          : hostStatus?.authMode === 'apikey'
            ? 'API key login'
            : null
        : secret
          ? maskApiKey(secret.apiKey)
          : null;

    return {
      id: provider.id,
      name: provider.name,
      providerKind: provider.provider_kind,
      apiFormat: provider.api_format,
      baseUrl: provider.base_url,
      authScheme: provider.auth_scheme,
      enabled: provider.enabled === 1,
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
          : credentialMode === 'host_login'
            ? (hostStatus?.message ?? null)
            : null,
      hostStatus,
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
  const claudeModelSuggestions = getClaudeModelSuggestions();
  return {
    defaultClaudeModelId:
      getSavedDefaultClaudeModelId() ||
      claudeModelSuggestions[0]?.modelId ||
      'claude-sonnet-4-6',
    claudeModelSuggestions,
    additionalProviders: await buildAdditionalProviderCards(),
  };
}

function getAdditionalProvider(providerId: string): ProviderRow | null {
  if (!BUILTIN_ADDITIONAL_PROVIDER_IDS.includes(providerId)) {
    return null;
  }
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, name, provider_kind, api_format, base_url, auth_scheme,
              enabled, response_start_timeout_ms, stream_idle_timeout_ms,
              absolute_timeout_ms
       FROM llm_providers
       WHERE id = ? AND enabled = 1`,
    )
    .get(providerId) as ProviderRow | undefined;
  return row ?? null;
}

function getPrimaryProviderModel(providerId: string): ProviderModelRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT provider_id, model_id, display_name, context_window_tokens,
              default_max_output_tokens, default_ttft_timeout_ms
       FROM llm_provider_models
       WHERE provider_id = ? AND enabled = 1
       ORDER BY display_name ASC
       LIMIT 1`,
    )
    .get(providerId) as ProviderModelRow | undefined;
  return row ?? null;
}

function upsertProviderVerification(
  providerId: string,
  result: ProviderVerificationResult,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO llm_provider_verifications (
       provider_id, status, last_verified_at, last_error, updated_at
     )
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider_id) DO UPDATE SET
       status = excluded.status,
       last_verified_at = excluded.last_verified_at,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
  ).run(
    providerId,
    result.status,
    result.lastVerifiedAt,
    result.lastError,
    now,
  );
}

function deleteProviderVerification(providerId: string): void {
  getDb()
    .prepare(`DELETE FROM llm_provider_verifications WHERE provider_id = ?`)
    .run(providerId);
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

async function verifyProviderSecret(providerId: string): Promise<void> {
  const provider = getAdditionalProvider(providerId);
  if (!provider) {
    throw new Error(`Provider '${providerId}' is not supported.`);
  }

  if (providerId === CODEX_PROVIDER_ID) {
    const hostStatus = await new CodexHostStatusService().getStatusView();
    if (!hostStatus.cliInstalled || !hostStatus.sandboxAvailable) {
      upsertProviderVerification(providerId, {
        status: 'unavailable',
        lastVerifiedAt: null,
        lastError: hostStatus.message,
      });
      return;
    }
    if (!hostStatus.authenticated) {
      deleteProviderVerification(providerId);
      return;
    }
    upsertProviderVerification(providerId, {
      status: 'verified',
      lastVerifiedAt: new Date().toISOString(),
      lastError: null,
    });
    return;
  }

  const db = getDb();
  const secretRow = db
    .prepare(
      `SELECT ciphertext FROM llm_provider_secrets WHERE provider_id = ?`,
    )
    .get(providerId) as { ciphertext: string } | undefined;
  const secret = secretRow ? parseStoredSecret(secretRow.ciphertext) : null;
  if (!secret) {
    deleteProviderVerification(providerId);
    return;
  }

  const model = getPrimaryProviderModel(providerId);
  if (!model) {
    upsertProviderVerification(providerId, {
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
    upsertProviderVerification(providerId, {
      status: 'verified',
      lastVerifiedAt: new Date().toISOString(),
      lastError: null,
    });
  } catch (error) {
    upsertProviderVerification(providerId, mapVerificationFailure(error));
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

export async function getAiAgentsRoute(): Promise<{
  statusCode: number;
  body: ApiEnvelope<AiAgentsPageData>;
}> {
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: await buildAiAgentsPageData(),
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

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO settings_kv (key, value, updated_at, updated_by)
       VALUES ('executor.defaultClaudeModel', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(body.modelId, now, auth.userId);

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: await buildAiAgentsPageData(),
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
  if (!isAdminLike(auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to manage provider credentials.',
        },
      },
    };
  }

  if (!getAdditionalProvider(providerId)) {
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
            'Host-login providers do not accept API keys here. Use Verify after running the managed Codex login command.',
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

  const db = getDb();
  if (!apiKey) {
    db.prepare(`DELETE FROM llm_provider_secrets WHERE provider_id = ?`).run(
      providerId,
    );
    deleteProviderVerification(providerId);
    return getProviderCardOrNotFound(providerId);
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO llm_provider_secrets (provider_id, ciphertext, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(provider_id) DO UPDATE SET
       ciphertext = excluded.ciphertext,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(
    providerId,
    encryptProviderSecret({
      apiKey,
      ...(organizationId ? { organizationId } : {}),
    }),
    now,
    auth.userId,
  );

  await verifyProviderSecret(providerId);
  return getProviderCardOrNotFound(providerId);
}

export async function verifyAiProviderCredentialRoute(
  auth: AuthContext,
  providerId: string,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ provider: AgentProviderCard }>;
}> {
  if (!isAdminLike(auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to verify provider credentials.',
        },
      },
    };
  }

  if (!getAdditionalProvider(providerId)) {
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

  await verifyProviderSecret(providerId);
  return getProviderCardOrNotFound(providerId);
}
