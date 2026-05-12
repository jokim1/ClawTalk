import { getContainerRuntimeStatus } from '../../container-runtime.js';
import {
  TALK_EXECUTOR_ANTHROPIC_API_KEY,
  TALK_EXECUTOR_ANTHROPIC_AUTH_TOKEN,
  TALK_EXECUTOR_CLAUDE_OAUTH_TOKEN,
} from '../config.js';
import type { RegisteredAgentRecord } from '../db/agent-accessors.js';
import { getEffectiveToolsForAgent } from '../db/agent-accessors.js';
import { getSettingValue } from '../db/accessors.js';
import { getMainAgent } from './agent-registry.js';
import {
  getAnthropicApiKeyFromDb,
  getConfiguredExecutorAuthMode,
  getProviderVerificationStatus,
} from './execution-planner.js';

export type MainBrowserContractReasonCode =
  | 'no_main_agent'
  | 'browser_disabled'
  | 'auth_mode_not_configured'
  | 'api_missing'
  | 'api_not_verified'
  | 'subscription_missing'
  | 'subscription_not_verified'
  | 'subscription_runtime_unavailable';

export type MainBrowserContract = {
  browserEnabled: boolean;
  selectedMode: 'api' | 'subscription' | null;
  transport: 'direct' | 'subscription' | null;
  ready: boolean;
  reasonCode: MainBrowserContractReasonCode | null;
  message: string;
};

function buildBrowserContractMessage(
  reasonCode: MainBrowserContractReasonCode | null,
  selectedMode: MainBrowserContract['selectedMode'],
): string {
  switch (reasonCode) {
    case 'no_main_agent':
      return 'No Main agent is configured. Select a Main agent before using browser automation.';
    case 'browser_disabled':
      return 'Browser automation is disabled for the selected Main agent. Enable the browser tool in AI Agents before retrying.';
    case 'auth_mode_not_configured':
      return "Browser access is not configured for this agent. Configure the agent's execution credentials in AI Agents before retrying. For Claude agents, run `claude login` and import subscription auth, or add an Anthropic API key.";
    case 'api_missing':
      return 'Main browser runs are set to API mode, but no Anthropic API key is configured. Add an Anthropic API key and verify it before retrying.';
    case 'api_not_verified':
      return 'Main browser runs are set to API mode, but the Anthropic API key is not verified. Verify or refresh the key in AI Agents before retrying.';
    case 'subscription_missing':
      return 'Main browser runs are set to subscription mode, but no Claude subscription credential is configured. Run `claude login` and import subscription auth before retrying.';
    case 'subscription_not_verified':
      return 'Main browser runs are set to subscription mode, but the Claude subscription runtime is not verified. Verify the executor runtime in AI Agents before retrying.';
    case 'subscription_runtime_unavailable':
      return 'Claude container runtime is unavailable on this host. Start Docker before using subscription mode for browser runs.';
    default:
      return selectedMode === 'api'
        ? 'Browser automation is ready in API mode.'
        : selectedMode === 'subscription'
          ? 'Browser automation is ready in subscription mode.'
          : 'Browser automation is ready.';
  }
}

function getExecutorVerificationStatus():
  | 'missing'
  | 'not_verified'
  | 'verifying'
  | 'verified'
  | 'invalid'
  | 'unavailable'
  | 'rate_limited'
  | null {
  const status = getSettingValue('executor.verificationStatus')?.trim() || null;
  if (
    status === 'missing' ||
    status === 'not_verified' ||
    status === 'verifying' ||
    status === 'verified' ||
    status === 'invalid' ||
    status === 'unavailable' ||
    status === 'rate_limited'
  ) {
    return status;
  }
  return null;
}

function hasSubscriptionCredentialConfigured(): boolean {
  const storedOauth = getSettingValue('executor.claudeOauthToken')?.trim();
  const storedAuth = getSettingValue('executor.anthropicAuthToken')?.trim();
  const envOauth = TALK_EXECUTOR_CLAUDE_OAUTH_TOKEN.trim();
  const envAuth = TALK_EXECUTOR_ANTHROPIC_AUTH_TOKEN.trim();
  return Boolean(storedOauth || storedAuth || envOauth || envAuth);
}

function hasAnthropicApiKeyConfigured(): boolean {
  return Boolean(
    getAnthropicApiKeyFromDb() || TALK_EXECUTOR_ANTHROPIC_API_KEY.trim(),
  );
}

function browserContractResult(input: {
  browserEnabled: boolean;
  selectedMode: MainBrowserContract['selectedMode'];
  transport: MainBrowserContract['transport'];
  ready: boolean;
  reasonCode: MainBrowserContractReasonCode | null;
}): MainBrowserContract {
  return {
    ...input,
    message: buildBrowserContractMessage(input.reasonCode, input.selectedMode),
  };
}

export function resolveBrowserExecutionContract(
  agent: RegisteredAgentRecord | null | undefined,
  userId: string,
): MainBrowserContract {
  if (!agent) {
    return browserContractResult({
      browserEnabled: false,
      selectedMode: null,
      transport: null,
      ready: false,
      reasonCode: 'no_main_agent',
    });
  }

  const browserEnabled = getEffectiveToolsForAgent(agent.id, userId).some(
    (tool) => tool.toolFamily === 'browser' && tool.enabled,
  );
  if (!browserEnabled) {
    return browserContractResult({
      browserEnabled: false,
      selectedMode: null,
      transport: null,
      ready: false,
      reasonCode: 'browser_disabled',
    });
  }

  const authMode = getConfiguredExecutorAuthMode();
  if (authMode === 'api_key') {
    if (!hasAnthropicApiKeyConfigured()) {
      return browserContractResult({
        browserEnabled: true,
        selectedMode: 'api',
        transport: 'direct',
        ready: false,
        reasonCode: 'api_missing',
      });
    }
    if (getProviderVerificationStatus('provider.anthropic') !== 'verified') {
      return browserContractResult({
        browserEnabled: true,
        selectedMode: 'api',
        transport: 'direct',
        ready: false,
        reasonCode: 'api_not_verified',
      });
    }
    return browserContractResult({
      browserEnabled: true,
      selectedMode: 'api',
      transport: 'direct',
      ready: true,
      reasonCode: null,
    });
  }

  if (authMode === 'subscription') {
    if (!hasSubscriptionCredentialConfigured()) {
      return browserContractResult({
        browserEnabled: true,
        selectedMode: 'subscription',
        transport: 'subscription',
        ready: false,
        reasonCode: 'subscription_missing',
      });
    }
    if (getExecutorVerificationStatus() !== 'verified') {
      return browserContractResult({
        browserEnabled: true,
        selectedMode: 'subscription',
        transport: 'subscription',
        ready: false,
        reasonCode: 'subscription_not_verified',
      });
    }
    if (getContainerRuntimeStatus() !== 'ready') {
      return browserContractResult({
        browserEnabled: true,
        selectedMode: 'subscription',
        transport: 'subscription',
        ready: false,
        reasonCode: 'subscription_runtime_unavailable',
      });
    }
    return browserContractResult({
      browserEnabled: true,
      selectedMode: 'subscription',
      transport: 'subscription',
      ready: true,
      reasonCode: null,
    });
  }

  return browserContractResult({
    browserEnabled: true,
    selectedMode: null,
    transport: null,
    ready: false,
    reasonCode: 'auth_mode_not_configured',
  });
}

export function resolveMainBrowserContract(
  userId: string,
): MainBrowserContract {
  return resolveBrowserExecutionContract(getMainAgent(), userId);
}
