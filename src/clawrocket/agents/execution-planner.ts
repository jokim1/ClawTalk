import { getDb } from '../../db.js';
import {
  getEffectiveToolsForAgent,
  type EffectiveToolAccess,
  type RegisteredAgentRecord,
} from '../db/agent-accessors.js';
import { getSettingValue } from '../db/accessors.js';
import { decryptProviderSecret } from '../llm/provider-secret-store.js';
import type { LlmProviderRecord } from '../llm/types.js';
import {
  resolveExecution,
  type ExecutionBinding,
  type ExecutionResolverError,
} from './execution-resolver.js';
import {
  TALK_EXECUTOR_ANTHROPIC_API_KEY,
  TALK_EXECUTOR_ANTHROPIC_AUTH_TOKEN,
  TALK_EXECUTOR_CLAUDE_OAUTH_TOKEN,
} from '../config.js';

export const EXECUTOR_MAIN_PROJECT_PATH_KEY = 'executor.mainProjectPath';

export type ExecutionBackend = 'direct_http' | 'container' | 'host_codex';
export type ExecutionRouteReason =
  | 'normal'
  | 'subscription_fallback'
  | 'browser_fast_lane';
export type ExecutionCredentialSource =
  | 'db_secret'
  | 'env'
  | 'oauth_token'
  | 'auth_token'
  | 'host_auth'
  | 'missing';

export interface ContainerCredentialConfig {
  authMode: 'api_key' | 'subscription';
  credentialSource: ExecutionCredentialSource;
  secrets: Record<string, string>;
}

export interface DirectHttpExecutionPlan {
  backend: 'direct_http';
  routeReason: ExecutionRouteReason;
  authPath: 'api_key';
  credentialSource: ExecutionCredentialSource;
  effectiveTools: EffectiveToolAccess[];
  providerId: string;
  modelId: string;
  binding: ExecutionBinding;
}

export interface ContainerExecutionPlan {
  backend: 'container';
  routeReason: ExecutionRouteReason;
  effectiveTools: EffectiveToolAccess[];
  providerId: string;
  modelId: string;
  heavyToolFamilies: string[];
  containerCredential: ContainerCredentialConfig;
}

export interface HostCodexExecutionPlan {
  backend: 'host_codex';
  routeReason: 'normal';
  authPath: 'host_login';
  credentialSource: 'host_auth';
  effectiveTools: EffectiveToolAccess[];
  providerId: string;
  modelId: string;
  heavyToolFamilies: string[];
}

export type ExecutionPlan =
  | DirectHttpExecutionPlan
  | ContainerExecutionPlan
  | HostCodexExecutionPlan;

export type MainExecutionPolicy =
  | 'direct_only'
  | 'direct_with_promotion'
  | 'container_only'
  | 'host_codex_only';

export interface MainExecutionPlan {
  policy: MainExecutionPolicy;
  effectiveTools: EffectiveToolAccess[];
  heavyToolFamilies: string[];
  directPlan: DirectHttpExecutionPlan | null;
  containerPlan: ContainerExecutionPlan | null;
  hostCodexPlan: HostCodexExecutionPlan | null;
}

export class ExecutionPlannerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'CONTAINER_BROWSER_REQUIRES_SHELL'
      | 'CONTAINER_PROVIDER_INCOMPATIBLE'
      | 'CONTAINER_CREDENTIAL_MISSING'
      | 'CODEX_HOST_UNAVAILABLE'
      | 'CODEX_REQUIRES_HEAVY_TOOLS'
      | 'CODEX_UNSUPPORTED_TOOLS'
      | 'DIRECT_EXECUTION_UNAVAILABLE',
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ExecutionPlannerError';
  }
}

const BASE_CONTAINER_ALLOWED_TOOLS = [
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
] as const;

function getProviderRecord(providerId: string): LlmProviderRecord | undefined {
  return getDb()
    .prepare(`SELECT * FROM llm_providers WHERE id = ? LIMIT 1`)
    .get(providerId) as LlmProviderRecord | undefined;
}

export function getProviderVerificationStatus(
  providerId: string,
):
  | 'missing'
  | 'not_verified'
  | 'verifying'
  | 'verified'
  | 'invalid'
  | 'unavailable'
  | null {
  const row = getDb()
    .prepare(
      `SELECT status FROM llm_provider_verifications WHERE provider_id = ? LIMIT 1`,
    )
    .get(providerId) as { status: string } | undefined;
  if (!row?.status) return null;
  if (
    row.status === 'missing' ||
    row.status === 'not_verified' ||
    row.status === 'verifying' ||
    row.status === 'verified' ||
    row.status === 'invalid' ||
    row.status === 'unavailable'
  ) {
    return row.status;
  }
  return null;
}

export function getAnthropicApiKeyFromDb(): string | null {
  const row = getDb()
    .prepare(
      `SELECT ciphertext FROM llm_provider_secrets WHERE provider_id = 'provider.anthropic' LIMIT 1`,
    )
    .get() as { ciphertext: string } | undefined;
  if (!row?.ciphertext) {
    return null;
  }

  try {
    return decryptProviderSecret(row.ciphertext).apiKey.trim();
  } catch {
    return null;
  }
}

export function getConfiguredExecutorAuthMode():
  | 'subscription'
  | 'api_key'
  | 'advanced_bearer'
  | 'none'
  | null {
  const mode = getSettingValue('executor.authMode')?.trim() || '';
  if (
    mode === 'subscription' ||
    mode === 'api_key' ||
    mode === 'advanced_bearer' ||
    mode === 'none'
  ) {
    return mode;
  }
  return null;
}

export function resolveContainerCredential(input?: {
  preferredAuthMode?: 'api_key' | 'subscription';
}): ContainerCredentialConfig {
  const configuredAuthMode = getConfiguredExecutorAuthMode() || undefined;
  const dbOauth = getSettingValue('executor.claudeOauthToken')?.trim() || null;
  const dbAuth = getSettingValue('executor.anthropicAuthToken')?.trim() || null;
  const envOauth = TALK_EXECUTOR_CLAUDE_OAUTH_TOKEN.trim() || null;
  const envAuth = TALK_EXECUTOR_ANTHROPIC_AUTH_TOKEN.trim() || null;
  const apiKey = getAnthropicApiKeyFromDb() || TALK_EXECUTOR_ANTHROPIC_API_KEY;
  const normalizedApiKey = apiKey?.trim() || null;

  const inferredAuthMode =
    input?.preferredAuthMode ||
    configuredAuthMode ||
    (normalizedApiKey
      ? 'api_key'
      : dbOauth || envOauth || dbAuth || envAuth
        ? 'subscription'
        : 'none');

  if (inferredAuthMode === 'api_key') {
    if (!normalizedApiKey) {
      throw new ExecutionPlannerError(
        'Claude container execution requires an Anthropic API key in executor settings or env.',
        'CONTAINER_CREDENTIAL_MISSING',
      );
    }
    return {
      authMode: 'api_key',
      credentialSource: getAnthropicApiKeyFromDb() ? 'db_secret' : 'env',
      secrets: {
        ANTHROPIC_API_KEY: normalizedApiKey,
      },
    };
  }

  if (inferredAuthMode === 'subscription') {
    const secrets: Record<string, string> = {};
    const oauthToken = dbOauth || envOauth;
    if (oauthToken) {
      secrets.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    }
    const authToken = dbAuth || envAuth;
    if (authToken) {
      secrets.ANTHROPIC_AUTH_TOKEN = authToken;
    }
    if (Object.keys(secrets).length === 0) {
      throw new ExecutionPlannerError(
        'Claude container execution requires an executor OAuth/auth token when subscription mode is selected.',
        'CONTAINER_CREDENTIAL_MISSING',
      );
    }
    return {
      authMode: 'subscription',
      credentialSource: oauthToken ? 'oauth_token' : 'auth_token',
      secrets,
    };
  }

  throw new ExecutionPlannerError(
    'Container execution is not configured. Set executor Claude credentials before routing heavy-tool agents to the container backend.',
    'CONTAINER_CREDENTIAL_MISSING',
  );
}

function resolveHeavyToolFamilies(
  effectiveTools: EffectiveToolAccess[],
): string[] {
  const enabled = new Set(
    effectiveTools
      .filter((tool) => tool.enabled)
      .map((tool) => tool.toolFamily),
  );

  const heavyFamilies: string[] = [];
  if (enabled.has('shell')) heavyFamilies.push('shell');
  if (enabled.has('filesystem')) heavyFamilies.push('filesystem');
  return heavyFamilies;
}

function hasEnabledToolFamily(
  effectiveTools: EffectiveToolAccess[],
  family: string,
): boolean {
  return effectiveTools.some(
    (tool) => tool.toolFamily === family && tool.enabled,
  );
}

function getUnsupportedCodexToolFamilies(
  effectiveTools: EffectiveToolAccess[],
): string[] {
  const unsupported = new Set<string>();
  for (const tool of effectiveTools) {
    if (!tool.enabled) continue;
    if (
      tool.toolFamily === 'shell' ||
      tool.toolFamily === 'filesystem' ||
      tool.toolFamily === 'web' ||
      tool.toolFamily === 'browser'
    ) {
      continue;
    }
    unsupported.add(tool.toolFamily);
  }
  return Array.from(unsupported);
}

function resolveCodexHostExecutionPlan(input: {
  agent: RegisteredAgentRecord;
  effectiveTools: EffectiveToolAccess[];
  heavyToolFamilies: string[];
}): HostCodexExecutionPlan {
  const shellEnabled = hasEnabledToolFamily(input.effectiveTools, 'shell');
  const filesystemEnabled = hasEnabledToolFamily(
    input.effectiveTools,
    'filesystem',
  );
  if (!shellEnabled || !filesystemEnabled) {
    throw new ExecutionPlannerError(
      'Codex host execution requires both shell and filesystem tools to be enabled for this agent.',
      'CODEX_REQUIRES_HEAVY_TOOLS',
      {
        providerId: input.agent.provider_id,
        shellEnabled,
        filesystemEnabled,
      },
    );
  }

  const unsupportedFamilies = getUnsupportedCodexToolFamilies(
    input.effectiveTools,
  );
  if (unsupportedFamilies.length > 0) {
    throw new ExecutionPlannerError(
      `Codex host execution does not support these enabled tool families: ${unsupportedFamilies.join(', ')}.`,
      'CODEX_UNSUPPORTED_TOOLS',
      {
        providerId: input.agent.provider_id,
        unsupportedFamilies,
      },
    );
  }

  const verificationStatus = getProviderVerificationStatus(
    input.agent.provider_id,
  );
  if (verificationStatus !== 'verified') {
    throw new ExecutionPlannerError(
      'Codex host runtime is not verified. Verify the OpenAI Codex host provider from AI Agents before using this agent.',
      'CODEX_HOST_UNAVAILABLE',
      {
        providerId: input.agent.provider_id,
        verificationStatus,
      },
    );
  }

  return {
    backend: 'host_codex',
    routeReason: 'normal',
    authPath: 'host_login',
    credentialSource: 'host_auth',
    effectiveTools: input.effectiveTools,
    providerId: input.agent.provider_id,
    modelId: input.agent.model_id,
    heavyToolFamilies: input.heavyToolFamilies,
  };
}

function isContainerCompatibleProvider(
  provider: LlmProviderRecord | undefined,
): boolean {
  return Boolean(
    provider &&
    provider.api_format === 'anthropic_messages' &&
    provider.core_compatibility === 'claude_sdk_proxy',
  );
}

export function getContainerAllowedTools(input: {
  effectiveTools: EffectiveToolAccess[];
  includeConnectorTools?: boolean;
}): string[] {
  const enabled = new Set(
    input.effectiveTools
      .filter((tool) => tool.enabled)
      .map((tool) => tool.toolFamily),
  );
  const allowed = new Set<string>(BASE_CONTAINER_ALLOWED_TOOLS);

  if (enabled.has('shell')) {
    allowed.add('Bash');
    allowed.add('Read');
    allowed.add('Glob');
    allowed.add('Grep');
  }

  if (enabled.has('filesystem')) {
    allowed.add('Read');
    allowed.add('Glob');
    allowed.add('Grep');
    allowed.add('Write');
    allowed.add('Edit');
  }

  if (enabled.has('web')) {
    allowed.add('WebSearch');
    allowed.add('WebFetch');
  }

  if (enabled.has('browser') || input.includeConnectorTools) {
    allowed.add('mcp__nanoclaw__*');
  }

  return Array.from(allowed);
}

function tryResolveDirectExecutionPlan(input: {
  agent: RegisteredAgentRecord;
  effectiveTools: EffectiveToolAccess[];
  provider: LlmProviderRecord | undefined;
  configuredAuthMode: ReturnType<typeof getConfiguredExecutorAuthMode>;
  allowAnthropicDirectWhenSubscriptionMode?: boolean;
}): DirectHttpExecutionPlan | null {
  if (
    input.agent.provider_id === 'provider.anthropic' &&
    input.configuredAuthMode === 'subscription' &&
    input.allowAnthropicDirectWhenSubscriptionMode !== true
  ) {
    return null;
  }

  if (
    input.agent.provider_id === 'provider.anthropic' &&
    input.configuredAuthMode === 'subscription' &&
    input.allowAnthropicDirectWhenSubscriptionMode === true
  ) {
    const verificationStatus = getProviderVerificationStatus(
      input.agent.provider_id,
    );
    if (verificationStatus !== 'verified') {
      return null;
    }
  }

  try {
    const binding = resolveExecution(input.agent);
    return {
      backend: 'direct_http',
      routeReason: 'normal',
      authPath: 'api_key',
      credentialSource:
        input.agent.provider_id === 'provider.anthropic'
          ? getAnthropicApiKeyFromDb()
            ? 'db_secret'
            : TALK_EXECUTOR_ANTHROPIC_API_KEY
              ? 'env'
              : 'missing'
          : 'db_secret',
      effectiveTools: input.effectiveTools,
      providerId: input.agent.provider_id,
      modelId: input.agent.model_id,
      binding,
    };
  } catch (error) {
    const resolverError = error as ExecutionResolverError;
    if (
      resolverError?.code === 'ANTHROPIC_REQUIRES_API_KEY' &&
      isContainerCompatibleProvider(input.provider) &&
      input.configuredAuthMode !== 'api_key'
    ) {
      return null;
    }
    throw new ExecutionPlannerError(
      resolverError.message || 'Direct execution is unavailable.',
      'DIRECT_EXECUTION_UNAVAILABLE',
      {
        resolverCode:
          resolverError && typeof resolverError === 'object'
            ? resolverError.code
            : undefined,
      },
    );
  }
}

function tryResolveContainerExecutionPlan(input: {
  agent: RegisteredAgentRecord;
  effectiveTools: EffectiveToolAccess[];
  heavyToolFamilies: string[];
  provider: LlmProviderRecord | undefined;
  configuredAuthMode: ReturnType<typeof getConfiguredExecutorAuthMode>;
}): ContainerExecutionPlan | null {
  if (!isContainerCompatibleProvider(input.provider)) {
    if (input.heavyToolFamilies.length > 0) {
      throw new ExecutionPlannerError(
        `Agent ${input.agent.name} requires heavy tools, but provider ${input.agent.provider_id} is not compatible with the Claude container runtime.`,
        'CONTAINER_PROVIDER_INCOMPATIBLE',
        {
          providerId: input.agent.provider_id,
          apiFormat: input.provider?.api_format ?? null,
          coreCompatibility: input.provider?.core_compatibility ?? null,
        },
      );
    }
    return null;
  }

  const preferredAuthMode =
    input.heavyToolFamilies.length === 0 &&
    input.agent.provider_id === 'provider.anthropic' &&
    input.configuredAuthMode !== 'api_key'
      ? 'subscription'
      : undefined;

  try {
    return {
      backend: 'container',
      routeReason:
        preferredAuthMode === 'subscription'
          ? 'subscription_fallback'
          : 'normal',
      effectiveTools: input.effectiveTools,
      providerId: input.agent.provider_id,
      modelId: input.agent.model_id,
      heavyToolFamilies: input.heavyToolFamilies,
      containerCredential: resolveContainerCredential(
        preferredAuthMode ? { preferredAuthMode } : undefined,
      ),
    };
  } catch (error) {
    if (error instanceof ExecutionPlannerError) {
      if (input.heavyToolFamilies.length > 0) {
        throw error;
      }
      return null;
    }
    throw error;
  }
}

export function planExecution(
  agent: RegisteredAgentRecord,
  userId: string,
): ExecutionPlan {
  const effectiveTools = getEffectiveToolsForAgent(agent.id, userId);
  const browserEnabled = effectiveTools.some(
    (tool) => tool.toolFamily === 'browser' && tool.enabled,
  );
  const heavyToolFamilies = resolveHeavyToolFamilies(effectiveTools);
  const provider = getProviderRecord(agent.provider_id);
  const configuredAuthMode = getConfiguredExecutorAuthMode();

  if (agent.provider_id === 'provider.openai_codex') {
    return resolveCodexHostExecutionPlan({
      agent,
      effectiveTools,
      heavyToolFamilies,
    });
  }

  if (browserEnabled) {
    const directPlan = tryResolveDirectExecutionPlan({
      agent,
      effectiveTools,
      provider,
      configuredAuthMode,
    });
    const shouldPreferSubscriptionContainer =
      agent.provider_id === 'provider.anthropic' &&
      configuredAuthMode === 'subscription';
    const containerPlan = tryResolveContainerExecutionPlan({
      agent,
      effectiveTools,
      heavyToolFamilies,
      provider,
      configuredAuthMode,
    });

    if (heavyToolFamilies.length > 0) {
      if (containerPlan) return containerPlan;
      if (directPlan) return directPlan;
      throw new ExecutionPlannerError(
        'Container execution is not configured for this agent.',
        'CONTAINER_CREDENTIAL_MISSING',
      );
    }

    if (shouldPreferSubscriptionContainer && containerPlan) {
      return {
        ...containerPlan,
        routeReason: 'normal',
      };
    }
    if (shouldPreferSubscriptionContainer && !containerPlan) {
      throw new ExecutionPlannerError(
        'Container execution is not configured for this agent.',
        'CONTAINER_CREDENTIAL_MISSING',
      );
    }
    if (directPlan) {
      return directPlan;
    }
    if (containerPlan) {
      return containerPlan;
    }
    throw new ExecutionPlannerError(
      'Direct execution is unavailable.',
      'DIRECT_EXECUTION_UNAVAILABLE',
    );
  }
  if (
    heavyToolFamilies.length === 0 &&
    agent.provider_id === 'provider.anthropic' &&
    isContainerCompatibleProvider(provider) &&
    configuredAuthMode === 'subscription'
  ) {
    const containerPlan = tryResolveContainerExecutionPlan({
      agent,
      effectiveTools,
      heavyToolFamilies: [],
      provider,
      configuredAuthMode,
    });
    if (containerPlan) {
      return {
        ...containerPlan,
        routeReason: 'normal',
      };
    }
  }

  if (heavyToolFamilies.length === 0) {
    const directPlan = tryResolveDirectExecutionPlan({
      agent,
      effectiveTools,
      provider,
      configuredAuthMode,
    });
    if (directPlan) return directPlan;

    const containerPlan = tryResolveContainerExecutionPlan({
      agent,
      effectiveTools,
      heavyToolFamilies: [],
      provider,
      configuredAuthMode,
    });
    if (containerPlan) return containerPlan;

    throw new ExecutionPlannerError(
      'Direct execution is unavailable.',
      'DIRECT_EXECUTION_UNAVAILABLE',
    );
  }

  const containerPlan = tryResolveContainerExecutionPlan({
    agent,
    effectiveTools,
    heavyToolFamilies,
    provider,
    configuredAuthMode,
  });
  if (!containerPlan) {
    throw new ExecutionPlannerError(
      'Container execution is not configured for this agent.',
      'CONTAINER_CREDENTIAL_MISSING',
    );
  }
  return containerPlan;
}

export function planMainExecution(
  agent: RegisteredAgentRecord,
  userId: string,
): MainExecutionPlan {
  const effectiveTools = getEffectiveToolsForAgent(agent.id, userId);
  const browserEnabled = effectiveTools.some(
    (tool) => tool.toolFamily === 'browser' && tool.enabled,
  );
  const heavyToolFamilies = resolveHeavyToolFamilies(effectiveTools);
  const provider = getProviderRecord(agent.provider_id);
  const configuredAuthMode = getConfiguredExecutorAuthMode();

  if (agent.provider_id === 'provider.openai_codex') {
    return {
      policy: 'host_codex_only',
      effectiveTools,
      heavyToolFamilies,
      directPlan: null,
      containerPlan: null,
      hostCodexPlan: resolveCodexHostExecutionPlan({
        agent,
        effectiveTools,
        heavyToolFamilies,
      }),
    };
  }

  let directPlan: DirectHttpExecutionPlan | null = null;
  try {
    directPlan = tryResolveDirectExecutionPlan({
      agent,
      effectiveTools,
      provider,
      configuredAuthMode,
      allowAnthropicDirectWhenSubscriptionMode: browserEnabled,
    });
  } catch (error) {
    if (
      !(error instanceof ExecutionPlannerError) ||
      error.code !== 'DIRECT_EXECUTION_UNAVAILABLE'
    ) {
      throw error;
    }
  }
  const containerPlan = tryResolveContainerExecutionPlan({
    agent,
    effectiveTools,
    heavyToolFamilies,
    provider,
    configuredAuthMode,
  });

  if (browserEnabled && heavyToolFamilies.length === 0) {
    if (directPlan) {
      return {
        policy: 'direct_only',
        effectiveTools,
        heavyToolFamilies,
        directPlan,
        containerPlan,
        hostCodexPlan: null,
      };
    }
    if (containerPlan) {
      return {
        policy: 'container_only',
        effectiveTools,
        heavyToolFamilies,
        directPlan: null,
        containerPlan,
        hostCodexPlan: null,
      };
    }
    throw new ExecutionPlannerError(
      'No valid Main execution path is currently configured for this agent.',
      'DIRECT_EXECUTION_UNAVAILABLE',
    );
  }

  if (heavyToolFamilies.length === 0) {
    if (directPlan) {
      return {
        policy: 'direct_only',
        effectiveTools,
        heavyToolFamilies,
        directPlan,
        containerPlan,
        hostCodexPlan: null,
      };
    }
    if (containerPlan) {
      return {
        policy: 'container_only',
        effectiveTools,
        heavyToolFamilies,
        directPlan: null,
        containerPlan,
        hostCodexPlan: null,
      };
    }
    throw new ExecutionPlannerError(
      'No valid Main execution path is currently configured for this agent.',
      'DIRECT_EXECUTION_UNAVAILABLE',
    );
  }

  if (directPlan && containerPlan) {
    return {
      policy: 'direct_with_promotion',
      effectiveTools,
      heavyToolFamilies,
      directPlan,
      containerPlan,
      hostCodexPlan: null,
    };
  }

  if (containerPlan) {
    return {
      policy: 'container_only',
      effectiveTools,
      heavyToolFamilies,
      directPlan,
      containerPlan,
      hostCodexPlan: null,
    };
  }

  if (directPlan) {
    return {
      policy: 'direct_only',
      effectiveTools,
      heavyToolFamilies,
      directPlan,
      containerPlan: null,
      hostCodexPlan: null,
    };
  }

  throw new ExecutionPlannerError(
    'No valid Main execution path is currently configured for this agent.',
    'DIRECT_EXECUTION_UNAVAILABLE',
  );
}
