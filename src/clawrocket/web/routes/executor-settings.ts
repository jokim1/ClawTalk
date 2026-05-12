import { createHash, randomUUID } from 'crypto';

import {
  getContainerRuntimeStatus,
  type ContainerRuntimeStatus,
} from '../../../container-runtime.js';
import { getDb } from '../../../db.js';
import { executeContainerAgentTurn } from '../../agents/container-turn-executor.js';
import {
  resolveContainerCredential,
  type ContainerCredentialConfig,
} from '../../agents/execution-planner.js';
import {
  deleteSettingValue,
  getSettingValue,
  getUserById,
  upsertSettingValue,
} from '../../db/accessors.js';
import type { RegisteredAgentRecord } from '../../db/agent-accessors.js';
import type { AuthContext, ApiEnvelope } from '../types.js';
import {
  ExecutorSubscriptionHostAuthService,
  type SubscriptionHostStatusView,
} from '../../talks/executor-subscription-host-auth.js';
import {
  TALK_EXECUTOR_ANTHROPIC_API_KEY,
  TALK_EXECUTOR_ANTHROPIC_AUTH_TOKEN,
  TALK_EXECUTOR_ANTHROPIC_BASE_URL,
  TALK_EXECUTOR_CLAUDE_OAUTH_TOKEN,
} from '../../config.js';
import {
  decryptProviderSecret,
  encryptProviderSecret,
} from '../../llm/provider-secret-store.js';

export type ExecutorAuthMode =
  | 'subscription'
  | 'api_key'
  | 'advanced_bearer'
  | 'none';

export type ExecutorVerificationStatus =
  | 'missing'
  | 'not_verified'
  | 'verifying'
  | 'verified'
  | 'invalid'
  | 'unavailable'
  | 'rate_limited';

export type ExecutorCredentialSource = 'stored' | 'env' | null;
export type ExecutorAuthModeSource = 'settings' | 'inferred';

export interface ExecutorSettingsData {
  configuredAliasMap: Record<string, string>;
  effectiveAliasMap: Record<string, string>;
  defaultAlias: string;
  executorAuthMode: ExecutorAuthMode;
  authModeSource: ExecutorAuthModeSource;
  hasApiKey: boolean;
  hasOauthToken: boolean;
  hasAuthToken: boolean;
  apiKeySource: ExecutorCredentialSource;
  oauthTokenSource: ExecutorCredentialSource;
  authTokenSource: ExecutorCredentialSource;
  apiKeyHint: string | null;
  oauthTokenHint: string | null;
  authTokenHint: string | null;
  activeCredentialConfigured: boolean;
  verificationStatus: ExecutorVerificationStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  anthropicBaseUrl: string;
  isConfigured: boolean;
  configVersion: number;
  lastUpdatedAt: string | null;
  lastUpdatedBy: {
    type: 'user';
    userId: string;
    displayName: string | null;
  } | null;
  configErrors: string[];
}

export interface ExecutorStatusData {
  mode: 'real' | 'mock';
  restartSupported: boolean;
  pendingRestartReasons: string[];
  activeRunCount: number;
  containerRuntimeAvailability: ContainerRuntimeStatus;
  executorAuthMode: ExecutorAuthMode;
  activeCredentialConfigured: boolean;
  verificationStatus: ExecutorVerificationStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  hasProviderAuth: boolean;
  hasValidAliasMap: boolean;
  configVersion: number;
  isConfigured: boolean;
  bootId: string;
  configErrors: string[];
}

export interface ExecutorSubscriptionImportResult {
  status: 'imported' | 'no_change';
  settings: ExecutorSettingsData;
}

export interface ExecutorVerificationResponse {
  scheduled: boolean;
  code: string;
  message: string;
}

export interface ExecutorAuthState {
  executorAuthMode: ExecutorAuthMode;
  authModeSource: ExecutorAuthModeSource;
  hasApiKey: boolean;
  hasOauthToken: boolean;
  hasAuthToken: boolean;
  apiKeySource: ExecutorCredentialSource;
  oauthTokenSource: ExecutorCredentialSource;
  authTokenSource: ExecutorCredentialSource;
  activeCredentialConfigured: boolean;
  verificationStatus: ExecutorVerificationStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  authTokenHint: string | null;
  apiKeyHint: string | null;
  oauthTokenHint: string | null;
}

export interface PutExecutorSettingsBody {
  executorAuthMode?: string;
  anthropicApiKey?: string | null;
  claudeOauthToken?: string | null;
  anthropicAuthToken?: string | null;
  anthropicBaseUrl?: string | null;
  aliasModelMap?: Record<string, string>;
  defaultAlias?: string;
}

interface VerificationMetadata {
  lastVerificationMode: string | null;
  lastVerificationMethod: string | null;
}

interface EffectiveExecutorCredentialState {
  apiKey: string | null;
  apiKeySource: ExecutorCredentialSource;
  oauthToken: string | null;
  oauthTokenSource: ExecutorCredentialSource;
  authToken: string | null;
  authTokenSource: ExecutorCredentialSource;
}

type SubscriptionVerificationResult =
  | {
      status: 'verified';
      code: string;
      message: string;
    }
  | {
      status: 'invalid' | 'unavailable' | 'rate_limited';
      code: string;
      message: string;
    };

type ApiKeyVerificationResult =
  | {
      status: 'verified';
      code: string;
      message: string;
    }
  | {
      status: 'missing' | 'invalid' | 'unavailable' | 'rate_limited';
      code: string;
      message: string;
    };

const VERIFY_LOCK_KEY = 'executor-subscription-verify';
const VERIFY_TIMEOUT_MS = 30_000;
const SUBSCRIPTION_VERIFY_METHOD = 'subscription_container_runtime';
const API_KEY_VERIFY_METHOD = 'anthropic_messages_direct_http';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
const VERIFY_PROMPT = 'Respond with a short acknowledgement.';
const SUBSCRIPTION_RUNTIME_UNAVAILABLE_MESSAGE =
  'Claude subscription verification could not run because the container runtime is unavailable or unhealthy. Check Docker and try again.';
const verificationLocks = new Set<string>();

function getAnthropicSecretRow():
  | {
      ciphertext: string;
      updated_at: string | null;
      updated_by: string | null;
    }
  | undefined {
  return getDb()
    .prepare(
      `SELECT ciphertext, updated_at, updated_by
       FROM llm_provider_secrets
       WHERE provider_id = 'provider.anthropic'
       LIMIT 1`,
    )
    .get() as
    | {
        ciphertext: string;
        updated_at: string | null;
        updated_by: string | null;
      }
    | undefined;
}

function getAnthropicApiKey(): string | null {
  const row = getAnthropicSecretRow();
  if (!row?.ciphertext) return null;
  try {
    return decryptProviderSecret(row.ciphertext).apiKey.trim();
  } catch {
    return null;
  }
}

function getEffectiveExecutorCredentialState(): EffectiveExecutorCredentialState {
  const storedApiKey = getAnthropicApiKey();
  const envApiKey = TALK_EXECUTOR_ANTHROPIC_API_KEY.trim() || null;
  const storedOauthToken =
    getSettingValue('executor.claudeOauthToken')?.trim() || null;
  const envOauthToken = TALK_EXECUTOR_CLAUDE_OAUTH_TOKEN.trim() || null;
  const storedAuthToken =
    getSettingValue('executor.anthropicAuthToken')?.trim() || null;
  const envAuthToken = TALK_EXECUTOR_ANTHROPIC_AUTH_TOKEN.trim() || null;

  return {
    apiKey: storedApiKey || envApiKey,
    apiKeySource: storedApiKey ? 'stored' : envApiKey ? 'env' : null,
    oauthToken: storedOauthToken || envOauthToken,
    oauthTokenSource: storedOauthToken
      ? 'stored'
      : envOauthToken
        ? 'env'
        : null,
    authToken: storedAuthToken || envAuthToken,
    authTokenSource: storedAuthToken ? 'stored' : envAuthToken ? 'env' : null,
  };
}

function describeCredentialSource(input: {
  source: ExecutorCredentialSource;
  envVar: string;
}): string | null {
  if (input.source === 'stored') {
    return 'Stored in settings';
  }
  if (input.source === 'env') {
    return `Environment variable (${input.envVar})`;
  }
  return null;
}

function readExecutorVerificationMetadata(): VerificationMetadata {
  return {
    lastVerificationMode: getSettingValue('executor.lastVerificationMode'),
    lastVerificationMethod: getSettingValue('executor.lastVerificationMethod'),
  };
}

function getConfiguredExecutorAuthMode(): ExecutorAuthMode | null {
  const configuredMode = (getSettingValue('executor.authMode')?.trim() ||
    '') as ExecutorAuthMode | '';
  if (
    configuredMode === 'subscription' ||
    configuredMode === 'api_key' ||
    configuredMode === 'advanced_bearer' ||
    configuredMode === 'none'
  ) {
    return configuredMode;
  }
  return null;
}

function inferExecutorAuthMode(input: {
  hasApiKey: boolean;
  hasOauthToken: boolean;
  hasAuthToken: boolean;
}): ExecutorAuthMode {
  const configuredMode = getConfiguredExecutorAuthMode();
  if (configuredMode) return configuredMode;

  if (input.hasApiKey) return 'api_key';
  if (input.hasOauthToken || input.hasAuthToken) return 'subscription';
  return 'none';
}

function computeActiveCredentialConfigured(input: {
  mode: ExecutorAuthMode;
  hasApiKey: boolean;
  hasOauthToken: boolean;
  hasAuthToken: boolean;
}): boolean {
  switch (input.mode) {
    case 'api_key':
      return input.hasApiKey;
    case 'subscription':
      return input.hasOauthToken || input.hasAuthToken;
    case 'advanced_bearer':
      return input.hasAuthToken;
    default:
      return false;
  }
}

function computeVerificationStatus(input: {
  mode: ExecutorAuthMode;
  activeCredentialConfigured: boolean;
  storedStatus: string | null;
  metadata: VerificationMetadata;
}): ExecutorVerificationStatus {
  if (!input.activeCredentialConfigured) {
    return 'missing';
  }

  if (input.mode === 'subscription') {
    if (
      input.metadata.lastVerificationMode !== 'subscription' ||
      input.metadata.lastVerificationMethod !== SUBSCRIPTION_VERIFY_METHOD
    ) {
      return 'not_verified';
    }
  }

  if (input.mode === 'api_key') {
    if (
      input.metadata.lastVerificationMode !== 'api_key' ||
      input.metadata.lastVerificationMethod !== API_KEY_VERIFY_METHOD
    ) {
      return 'not_verified';
    }
  }

  if (!input.storedStatus) {
    return 'not_verified';
  }

  switch (input.storedStatus) {
    case 'missing':
    case 'not_verified':
    case 'verifying':
    case 'verified':
    case 'invalid':
    case 'rate_limited':
      return input.storedStatus;
    case 'unavailable':
      return input.mode === 'subscription' ? 'not_verified' : 'unavailable';
    default:
      return 'not_verified';
  }
}

function getLastUpdatedActor(): {
  type: 'user';
  userId: string;
  displayName: string | null;
} | null {
  const row = getDb()
    .prepare(
      `
      SELECT updated_by
      FROM settings_kv
      WHERE key IN (
        'executor.authMode',
        'executor.claudeOauthToken',
        'executor.anthropicAuthToken',
        'executor.verificationStatus'
      )
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    )
    .get() as { updated_by: string | null } | undefined;

  if (!row?.updated_by) {
    const apiKeyRow = getAnthropicSecretRow();
    if (!apiKeyRow?.updated_by) return null;
    const user = getUserById(apiKeyRow.updated_by);
    return {
      type: 'user',
      userId: apiKeyRow.updated_by,
      displayName: user?.display_name ?? null,
    };
  }

  const user = getUserById(row.updated_by);
  return {
    type: 'user',
    userId: row.updated_by,
    displayName: user?.display_name ?? null,
  };
}

export function getExecutorAuthState(): ExecutorAuthState {
  const credentials = getEffectiveExecutorCredentialState();
  const hasApiKey = Boolean(credentials.apiKey);
  const hasOauthToken = Boolean(credentials.oauthToken);
  const hasAuthToken = Boolean(credentials.authToken);
  const configuredAuthMode = getConfiguredExecutorAuthMode();
  const executorAuthMode = inferExecutorAuthMode({
    hasApiKey,
    hasOauthToken,
    hasAuthToken,
  });
  const activeCredentialConfigured = computeActiveCredentialConfigured({
    mode: executorAuthMode,
    hasApiKey,
    hasOauthToken,
    hasAuthToken,
  });
  const metadata = readExecutorVerificationMetadata();
  const verificationStatus = computeVerificationStatus({
    mode: executorAuthMode,
    activeCredentialConfigured,
    storedStatus: getSettingValue('executor.verificationStatus'),
    metadata,
  });

  return {
    executorAuthMode,
    authModeSource: configuredAuthMode ? 'settings' : 'inferred',
    hasApiKey,
    hasOauthToken,
    hasAuthToken,
    apiKeySource: credentials.apiKeySource,
    oauthTokenSource: credentials.oauthTokenSource,
    authTokenSource: credentials.authTokenSource,
    activeCredentialConfigured,
    verificationStatus,
    lastVerifiedAt: getSettingValue('executor.lastVerifiedAt'),
    lastVerificationError: getSettingValue('executor.lastVerificationError'),
    apiKeyHint: describeCredentialSource({
      source: credentials.apiKeySource,
      envVar: 'ANTHROPIC_API_KEY',
    }),
    oauthTokenHint: describeCredentialSource({
      source: credentials.oauthTokenSource,
      envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
    }),
    authTokenHint: describeCredentialSource({
      source: credentials.authTokenSource,
      envVar: 'ANTHROPIC_AUTH_TOKEN',
    }),
  };
}

function baseExecutorSettingsData(): ExecutorSettingsData {
  const authState = getExecutorAuthState();
  const updatedAt =
    getSettingValue('executor.lastVerifiedAt') ||
    getSettingValue('executor.updatedAt');

  return {
    configuredAliasMap: {},
    effectiveAliasMap: {},
    defaultAlias: 'claude-sonnet-4-6',
    executorAuthMode: authState.executorAuthMode,
    authModeSource: authState.authModeSource,
    hasApiKey: authState.hasApiKey,
    hasOauthToken: authState.hasOauthToken,
    hasAuthToken: authState.hasAuthToken,
    apiKeySource: authState.apiKeySource,
    oauthTokenSource: authState.oauthTokenSource,
    authTokenSource: authState.authTokenSource,
    apiKeyHint: authState.apiKeyHint,
    oauthTokenHint: authState.oauthTokenHint,
    authTokenHint: authState.authTokenHint,
    activeCredentialConfigured: authState.activeCredentialConfigured,
    verificationStatus: authState.verificationStatus,
    lastVerifiedAt: authState.lastVerifiedAt,
    lastVerificationError: authState.lastVerificationError,
    anthropicBaseUrl:
      TALK_EXECUTOR_ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    isConfigured: authState.activeCredentialConfigured,
    configVersion: 1,
    lastUpdatedAt: updatedAt,
    lastUpdatedBy: getLastUpdatedActor(),
    configErrors: [],
  };
}

export function buildExecutorSettingsData(): ExecutorSettingsData {
  return baseExecutorSettingsData();
}

export function buildExecutorStatusData(): ExecutorStatusData {
  const authState = getExecutorAuthState();
  const containerRuntimeAvailability = getContainerRuntimeStatus();
  return {
    mode: 'real',
    restartSupported: false,
    pendingRestartReasons: [],
    activeRunCount: 0,
    containerRuntimeAvailability,
    executorAuthMode: authState.executorAuthMode,
    activeCredentialConfigured: authState.activeCredentialConfigured,
    verificationStatus: authState.verificationStatus,
    lastVerifiedAt: authState.lastVerifiedAt,
    lastVerificationError: authState.lastVerificationError,
    hasProviderAuth: authState.activeCredentialConfigured,
    hasValidAliasMap: true,
    configVersion: 1,
    isConfigured: authState.activeCredentialConfigured,
    bootId: 'web',
    configErrors: [],
  };
}

function resetVerificationState(updatedBy: string): void {
  upsertSettingValue({
    key: 'executor.verificationStatus',
    value: 'not_verified',
    updatedBy,
  });
  upsertSettingValue({
    key: 'executor.lastVerifiedAt',
    value: null,
    updatedBy,
  });
  upsertSettingValue({
    key: 'executor.lastVerificationError',
    value: null,
    updatedBy,
  });
  upsertSettingValue({
    key: 'executor.lastVerificationMode',
    value: null,
    updatedBy,
  });
  upsertSettingValue({
    key: 'executor.lastVerificationMethod',
    value: null,
    updatedBy,
  });
}

function setVerificationResult(input: {
  updatedBy: string;
  status: ExecutorVerificationStatus;
  lastVerificationError: string | null;
  lastVerificationMode: ExecutorAuthMode | null;
  lastVerificationMethod: string | null;
}): void {
  const now = new Date().toISOString();
  upsertSettingValue({
    key: 'executor.verificationStatus',
    value: input.status,
    updatedBy: input.updatedBy,
  });
  upsertSettingValue({
    key: 'executor.lastVerifiedAt',
    value: input.status === 'verified' ? now : null,
    updatedBy: input.updatedBy,
  });
  upsertSettingValue({
    key: 'executor.lastVerificationError',
    value: input.lastVerificationError,
    updatedBy: input.updatedBy,
  });
  upsertSettingValue({
    key: 'executor.lastVerificationMode',
    value: input.lastVerificationMode,
    updatedBy: input.updatedBy,
  });
  upsertSettingValue({
    key: 'executor.lastVerificationMethod',
    value: input.lastVerificationMethod,
    updatedBy: input.updatedBy,
  });
}

function clearAnthropicApiKey(userId: string): void {
  getDb()
    .prepare(
      `DELETE FROM llm_provider_secrets WHERE provider_id = 'provider.anthropic'`,
    )
    .run();
  upsertSettingValue({
    key: 'executor.updatedAt',
    value: new Date().toISOString(),
    updatedBy: userId,
  });
}

function saveAnthropicApiKey(apiKey: string, userId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO llm_provider_secrets (provider_id, ciphertext, updated_at, updated_by)
       VALUES ('provider.anthropic', ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET ciphertext = excluded.ciphertext,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(encryptProviderSecret({ apiKey }), now, userId);
  upsertSettingValue({
    key: 'executor.updatedAt',
    value: now,
    updatedBy: userId,
  });
}

export function putExecutorSettingsRoute(
  auth: AuthContext,
  body: PutExecutorSettingsBody,
): {
  statusCode: number;
  body: ApiEnvelope<ExecutorSettingsData>;
} {
  try {
    const userId = auth.userId;
    const normalizedMode =
      typeof body.executorAuthMode === 'string'
        ? (body.executorAuthMode.trim() as ExecutorAuthMode)
        : null;

    if (
      normalizedMode &&
      !['subscription', 'api_key', 'advanced_bearer', 'none'].includes(
        normalizedMode,
      )
    ) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: 'Invalid executor auth mode.',
          },
        },
      };
    }

    if (normalizedMode) {
      upsertSettingValue({
        key: 'executor.authMode',
        value: normalizedMode,
        updatedBy: userId,
      });
    }

    let credentialsChanged = false;

    if (body.anthropicApiKey === null) {
      clearAnthropicApiKey(userId);
      credentialsChanged = true;
    } else if (
      typeof body.anthropicApiKey === 'string' &&
      body.anthropicApiKey.trim()
    ) {
      saveAnthropicApiKey(body.anthropicApiKey.trim(), userId);
      credentialsChanged = true;
    }

    if (body.claudeOauthToken === null) {
      deleteSettingValue('executor.claudeOauthToken');
      credentialsChanged = true;
    } else if (
      typeof body.claudeOauthToken === 'string' &&
      body.claudeOauthToken.trim()
    ) {
      upsertSettingValue({
        key: 'executor.claudeOauthToken',
        value: body.claudeOauthToken.trim(),
        updatedBy: userId,
      });
      credentialsChanged = true;
    }

    if (body.anthropicAuthToken === null) {
      deleteSettingValue('executor.anthropicAuthToken');
      credentialsChanged = true;
    } else if (
      typeof body.anthropicAuthToken === 'string' &&
      body.anthropicAuthToken.trim()
    ) {
      upsertSettingValue({
        key: 'executor.anthropicAuthToken',
        value: body.anthropicAuthToken.trim(),
        updatedBy: userId,
      });
      credentialsChanged = true;
    }

    if (credentialsChanged || normalizedMode) {
      resetVerificationState(userId);
    }

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: buildExecutorSettingsData(),
      },
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to save executor settings: ${String(error)}`,
        },
      },
    };
  }
}

export async function getExecutorSubscriptionHostStatusRoute(
  auth: AuthContext,
  deps?: {
    hostAuthService?: ExecutorSubscriptionHostAuthService;
  },
): Promise<{
  statusCode: number;
  body: ApiEnvelope<SubscriptionHostStatusView>;
}> {
  try {
    const hostAuthService =
      deps?.hostAuthService || new ExecutorSubscriptionHostAuthService();
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: await hostAuthService.getStatusView(),
      },
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to probe subscription host status: ${String(error)}`,
        },
      },
    };
  }
}

export async function importExecutorSubscriptionRoute(
  auth: AuthContext,
  body: unknown,
  deps?: {
    hostAuthService?: ExecutorSubscriptionHostAuthService;
  },
): Promise<{
  statusCode: number;
  body: ApiEnvelope<ExecutorSubscriptionImportResult>;
}> {
  try {
    const parsed = body as Record<string, unknown> | null;
    const expectedFingerprint =
      parsed && typeof parsed.expectedFingerprint === 'string'
        ? parsed.expectedFingerprint.trim()
        : '';

    if (!expectedFingerprint) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: 'expectedFingerprint is required.',
          },
        },
      };
    }

    const hostAuthService =
      deps?.hostAuthService || new ExecutorSubscriptionHostAuthService();
    const probe = await hostAuthService.probeImportSource();

    if (probe.importSource !== 'service_env' || !probe.importCredential) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'unsupported_import_source',
            message: 'This host login cannot be imported automatically.',
          },
        },
      };
    }

    const actualFingerprint =
      probe.hostCredentialFingerprint ||
      createHash('sha256')
        .update(
          JSON.stringify({
            source: probe.importSource,
            credential: probe.importCredential,
          }),
        )
        .digest('hex');

    if (actualFingerprint !== expectedFingerprint) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'host_state_changed',
            message:
              'The host Claude credential changed since the last probe. Refresh and try again.',
          },
        },
      };
    }

    const existing = getSettingValue('executor.claudeOauthToken');
    const status =
      existing === probe.importCredential ? 'no_change' : 'imported';

    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: probe.importCredential,
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    resetVerificationState(auth.userId);

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          status,
          settings: buildExecutorSettingsData(),
        },
      },
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to import subscription credential: ${String(error)}`,
        },
      },
    };
  }
}

async function verifyAnthropicApiKeyViaHttp(
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<ApiKeyVerificationResult> {
  try {
    const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: DEFAULT_CLAUDE_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    if (response.ok) {
      return {
        status: 'verified',
        code: 'verified',
        message: 'Anthropic API key verified for direct Claude execution.',
      };
    }

    if (response.status === 429) {
      return {
        status: 'rate_limited',
        code: 'rate_limited',
        message:
          'Anthropic accepted the API key, but the account is currently rate limited.',
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        status: 'invalid',
        code: 'invalid_credential',
        message: 'Anthropic rejected the stored API key.',
      };
    }

    return {
      status: 'unavailable',
      code: 'provider_unavailable',
      message:
        'Anthropic direct verification failed for an operational reason. Try again shortly.',
    };
  } catch (error) {
    return {
      status: 'unavailable',
      code: 'provider_unavailable',
      message: `Anthropic verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function classifySubscriptionRuntimeFailure(
  message: string,
): SubscriptionVerificationResult {
  const normalized = message.toLowerCase();
  if (
    normalized.includes('rate limit') ||
    normalized.includes('too many requests') ||
    normalized.includes('quota') ||
    normalized.includes('usage limit')
  ) {
    return {
      status: 'rate_limited',
      code: 'rate_limited',
      message:
        'Claude subscription credentials are valid, but the account is currently rate limited.',
    };
  }

  if (
    normalized.includes('unauthorized') ||
    normalized.includes('authentication') ||
    normalized.includes('invalid token') ||
    normalized.includes('subscription required') ||
    normalized.includes('not subscribed') ||
    normalized.includes('plan required') ||
    normalized.includes('payment required') ||
    normalized.includes('upgrade your plan') ||
    normalized.includes('no active subscription') ||
    normalized.includes('login') ||
    normalized.includes('401') ||
    normalized.includes('402') ||
    normalized.includes('403')
  ) {
    return {
      status: 'invalid',
      code: 'invalid_credential',
      message:
        'Claude subscription authentication failed in the container runtime.',
    };
  }

  return {
    status: 'unavailable',
    code: 'runtime_unavailable',
    message:
      'Claude subscription credentials are stored, but the container runtime is unavailable or unhealthy. Check Docker and try again.',
  };
}

async function verifySubscriptionRuntimeDefault(input: {
  userId: string;
  containerCredential: ContainerCredentialConfig;
  defaultModelId: string;
}): Promise<SubscriptionVerificationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  const syntheticAgent: RegisteredAgentRecord = {
    id: 'executor.verify.subscription',
    name: 'Executor Verification',
    provider_id: 'provider.anthropic',
    model_id: input.defaultModelId,
    tool_permissions_json: '{}',
    persona_role: null,
    system_prompt: null,
    enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  try {
    const result = await executeContainerAgentTurn({
      runId: `verify-${randomUUID()}`,
      userId: input.userId,
      agent: syntheticAgent,
      promptLabel: 'main',
      userMessage: VERIFY_PROMPT,
      signal: controller.signal,
      allowedTools: [],
      context: {
        systemPrompt:
          'This is an executor verification probe. Answer the user briefly.',
        history: [],
      },
      modelContextWindow: 200_000,
      containerCredential: input.containerCredential,
      threadId: `verify-${randomUUID()}`,
      projectMountHostPath: null,
    });

    if (result.content.trim().length > 0) {
      return {
        status: 'verified',
        code: 'verified',
        message:
          'Claude subscription runtime verified successfully for Main and single-agent Talk execution.',
      };
    }

    return {
      status: 'unavailable',
      code: 'runtime_unavailable',
      message:
        'Claude subscription runtime returned no response. Check Docker and try again.',
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.includes('aborted'))
    ) {
      return {
        status: 'unavailable',
        code: 'runtime_timeout',
        message:
          'Claude subscription verification timed out waiting for the container runtime.',
      };
    }
    return classifySubscriptionRuntimeFailure(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyExecutorRoute(
  auth: AuthContext,
  deps?: {
    fetchImpl?: typeof fetch;
    verifySubscriptionRuntime?: (input: {
      userId: string;
      containerCredential: ContainerCredentialConfig;
      defaultModelId: string;
    }) => Promise<SubscriptionVerificationResult>;
  },
): Promise<{
  statusCode: number;
  body: ApiEnvelope<ExecutorVerificationResponse>;
}> {
  const authState = getExecutorAuthState();
  const userId = auth.userId;

  if (verificationLocks.has(VERIFY_LOCK_KEY)) {
    upsertSettingValue({
      key: 'executor.verificationStatus',
      value: 'verifying',
      updatedBy: userId,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          scheduled: false,
          code: 'verification_in_progress',
          message: 'Verification is already running.',
        },
      },
    };
  }

  if (!authState.activeCredentialConfigured) {
    setVerificationResult({
      updatedBy: userId,
      status: 'missing',
      lastVerificationError: 'No active Claude credential is configured.',
      lastVerificationMode: authState.executorAuthMode,
      lastVerificationMethod: null,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          scheduled: false,
          code: 'no_credential',
          message: 'No active Claude credential is configured.',
        },
      },
    };
  }

  verificationLocks.add(VERIFY_LOCK_KEY);
  upsertSettingValue({
    key: 'executor.verificationStatus',
    value: 'verifying',
    updatedBy: userId,
  });

  try {
    if (authState.executorAuthMode === 'api_key') {
      const apiKey = getEffectiveExecutorCredentialState().apiKey;
      if (!apiKey) {
        setVerificationResult({
          updatedBy: userId,
          status: 'missing',
          lastVerificationError: 'No Anthropic API key is configured.',
          lastVerificationMode: 'api_key',
          lastVerificationMethod: API_KEY_VERIFY_METHOD,
        });
        return {
          statusCode: 200,
          body: {
            ok: true,
            data: {
              scheduled: false,
              code: 'no_credential',
              message: 'No Anthropic API key is configured.',
            },
          },
        };
      }

      const result = await verifyAnthropicApiKeyViaHttp(
        apiKey,
        deps?.fetchImpl || fetch,
      );
      setVerificationResult({
        updatedBy: userId,
        status: result.status,
        lastVerificationError:
          result.status === 'verified' ? null : result.message,
        lastVerificationMode: 'api_key',
        lastVerificationMethod: API_KEY_VERIFY_METHOD,
      });
      return {
        statusCode: 200,
        body: {
          ok: true,
          data: {
            scheduled: false,
            code: result.code,
            message: result.message,
          },
        },
      };
    }

    if (authState.executorAuthMode === 'subscription') {
      let containerCredential: ContainerCredentialConfig;
      try {
        containerCredential = resolveContainerCredential({
          preferredAuthMode: 'subscription',
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'No subscription credential is configured.';
        setVerificationResult({
          updatedBy: userId,
          status: 'missing',
          lastVerificationError: message,
          lastVerificationMode: 'subscription',
          lastVerificationMethod: SUBSCRIPTION_VERIFY_METHOD,
        });
        return {
          statusCode: 200,
          body: {
            ok: true,
            data: {
              scheduled: false,
              code: 'no_credential',
              message,
            },
          },
        };
      }

      if (getContainerRuntimeStatus({ refresh: true }) === 'unavailable') {
        setVerificationResult({
          updatedBy: userId,
          status: 'not_verified',
          lastVerificationError: SUBSCRIPTION_RUNTIME_UNAVAILABLE_MESSAGE,
          lastVerificationMode: 'subscription',
          lastVerificationMethod: SUBSCRIPTION_VERIFY_METHOD,
        });
        return {
          statusCode: 200,
          body: {
            ok: true,
            data: {
              scheduled: false,
              code: 'runtime_unavailable',
              message: SUBSCRIPTION_RUNTIME_UNAVAILABLE_MESSAGE,
            },
          },
        };
      }

      const result = await (
        deps?.verifySubscriptionRuntime || verifySubscriptionRuntimeDefault
      )({
        userId,
        containerCredential,
        defaultModelId:
          getSettingValue('executor.defaultClaudeModel') ||
          DEFAULT_CLAUDE_MODEL,
      });

      setVerificationResult({
        updatedBy: userId,
        status:
          result.status === 'unavailable' ? 'not_verified' : result.status,
        lastVerificationError:
          result.status === 'verified' ? null : result.message,
        lastVerificationMode: 'subscription',
        lastVerificationMethod: SUBSCRIPTION_VERIFY_METHOD,
      });
      return {
        statusCode: 200,
        body: {
          ok: true,
          data: {
            scheduled: false,
            code: result.code,
            message: result.message,
          },
        },
      };
    }

    setVerificationResult({
      updatedBy: userId,
      status: 'not_verified',
      lastVerificationError:
        'Verification is not supported for the current executor auth mode.',
      lastVerificationMode: authState.executorAuthMode,
      lastVerificationMethod: null,
    });
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'unsupported_mode',
          message:
            'Verification is not supported for the current executor auth mode.',
        },
      },
    };
  } finally {
    verificationLocks.delete(VERIFY_LOCK_KEY);
  }
}

export function getExecutorSettingsRoute(_auth: AuthContext): {
  statusCode: number;
  body: ApiEnvelope<ExecutorSettingsData>;
} {
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: buildExecutorSettingsData(),
    },
  };
}

export function getExecutorStatusRoute(_auth: AuthContext): {
  statusCode: number;
  body: ApiEnvelope<ExecutorStatusData>;
} {
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: buildExecutorStatusData(),
    },
  };
}

export function _resetExecutorVerificationSingleFlightForTests(): void {
  verificationLocks.clear();
}
