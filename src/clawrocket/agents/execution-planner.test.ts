import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  upsertSettingValue,
  upsertUser,
} from '../db/index.js';
import { encryptProviderSecret } from '../llm/provider-secret-store.js';
import {
  buildDefaultTalkToolPermissions,
  createRegisteredAgent,
  upsertUserToolPermission,
} from '../db/agent-accessors.js';
import {
  getContainerAllowedTools,
  planMainExecution,
  planExecution,
} from './execution-planner.js';

function seedAnthropicSecret(apiKey = 'sk-ant-test'): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO llm_provider_secrets (provider_id, ciphertext, updated_at, updated_by)
       VALUES ('provider.anthropic', ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET ciphertext = excluded.ciphertext,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(encryptProviderSecret({ apiKey }), now, 'owner-1');
}

function upsertProviderVerification(
  providerId: string,
  status: 'verified' | 'missing' | 'not_verified' | 'invalid' | 'unavailable',
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO llm_provider_verifications (
         provider_id, status, last_verified_at, last_error, updated_at
       ) VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         status = excluded.status,
         last_verified_at = excluded.last_verified_at,
         updated_at = excluded.updated_at`,
    )
    .run(providerId, status, status === 'verified' ? now : null, now);
}

describe('execution-planner', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
  });

  it('returns direct_http for light/API agents', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Research',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('direct_http');
    if (plan.backend === 'direct_http') {
      expect(plan.binding.providerConfig.providerId).toBe('provider.anthropic');
    }
  });

  it('defaults new agents to the Talk-safe direct profile when tool permissions are omitted', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Persona',
      providerId: 'provider.anthropic',
      modelId: 'claude-opus-4-6',
    });

    expect(JSON.parse(agent.tool_permissions_json)).toEqual(
      buildDefaultTalkToolPermissions(),
    );

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('direct_http');
  });

  it('returns container for heavy Claude-compatible agents without requiring a registered group', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Builder',
      providerId: 'provider.anthropic',
      modelId: 'claude-opus-4-6',
      toolPermissionsJson: JSON.stringify({ shell: true, filesystem: true }),
    });
    upsertUserToolPermission('owner-1', 'Bash', true, true);

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('container');
    if (plan.backend === 'container') {
      expect(plan.containerCredential.authMode).toBe('api_key');
      expect(plan.heavyToolFamilies).toEqual(['shell', 'filesystem']);
    }
  });

  it('routes verified Codex heavy agents through the host runtime', () => {
    upsertProviderVerification('provider.openai_codex', 'verified');
    const agent = createRegisteredAgent({
      name: 'Codex Builder',
      providerId: 'provider.openai_codex',
      modelId: 'gpt-5.4',
      toolPermissionsJson: JSON.stringify({
        shell: true,
        filesystem: true,
        browser: true,
        web: true,
      }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('host_codex');
    if (plan.backend === 'host_codex') {
      expect(plan.authPath).toBe('host_login');
      expect(plan.credentialSource).toBe('host_auth');
      expect(plan.heavyToolFamilies).toEqual(['shell', 'filesystem']);
    }
  });

  it('rejects Codex host execution until the provider is verified', () => {
    const agent = createRegisteredAgent({
      name: 'Codex Builder',
      providerId: 'provider.openai_codex',
      modelId: 'gpt-5.4',
      toolPermissionsJson: JSON.stringify({
        shell: true,
        filesystem: true,
      }),
    });

    expect(() => planExecution(agent, 'owner-1')).toThrowError(
      /codex host runtime is not verified/i,
    );
  });

  it('routes from effective user permissions rather than raw heavy tool flags', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Builder',
      providerId: 'provider.anthropic',
      modelId: 'claude-opus-4-6',
      toolPermissionsJson: JSON.stringify({ shell: true }),
    });

    upsertUserToolPermission('owner-1', 'Bash', false, false);
    upsertUserToolPermission('owner-1', 'Read', false, false);

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('direct_http');
    expect(
      plan.effectiveTools.find((tool) => tool.toolFamily === 'shell'),
    ).toMatchObject({
      enabled: false,
      requiresApproval: false,
      runtimeTools: ['Bash'],
    });
    expect(
      plan.effectiveTools.find((tool) => tool.toolFamily === 'filesystem'),
    ).toMatchObject({
      enabled: false,
      requiresApproval: false,
      runtimeTools: ['Read', 'Write', 'Edit', 'Glob'],
    });
  });

  it('routes browser-only agents through direct_http when direct credentials exist', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Browser',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ browser: true }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('direct_http');
  });

  it('routes browser + shell/filesystem Talk agents through the container runtime', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Browser Builder',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({
        browser: true,
        shell: true,
        filesystem: true,
      }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('container');
    if (plan.backend === 'container') {
      expect(plan.heavyToolFamilies).toEqual(['shell', 'filesystem']);
    }
  });

  it('routes browser-only agents through the container runtime when subscription mode is configured', () => {
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Browser',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ browser: true }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('container');
    if (plan.backend === 'container') {
      expect(plan.containerCredential.authMode).toBe('subscription');
      expect(plan.routeReason).toBe('subscription_fallback');
    }
  });

  it('keeps browser-enabled Main agents on direct_only policy', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Browser',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ browser: true }),
    });

    const plan = planMainExecution(agent, 'owner-1');
    expect(plan.policy).toBe('direct_only');
    expect(plan.directPlan?.backend).toBe('direct_http');
    expect(plan.containerPlan).toBeNull();
  });

  it('prefers direct Main execution for browser-enabled Anthropic agents when a verified API key exists even if subscription mode is configured globally', () => {
    seedAnthropicSecret();
    upsertProviderVerification('provider.anthropic', 'verified');
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: 'owner-1',
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Browser',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ browser: true }),
    });

    const plan = planMainExecution(agent, 'owner-1');
    expect(plan.policy).toBe('direct_only');
    expect(plan.directPlan?.backend).toBe('direct_http');
    expect(plan.directPlan?.credentialSource).toBe('db_secret');
    expect(plan.containerPlan?.containerCredential.authMode).toBe(
      'subscription',
    );
  });

  it('keeps browser in the direct Main parent and promotes only heavy tools', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Browser Builder Main',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({
        browser: true,
        shell: true,
        filesystem: true,
      }),
    });

    const plan = planMainExecution(agent, 'owner-1');
    expect(plan.policy).toBe('direct_with_promotion');
    expect(plan.directPlan?.backend).toBe('direct_http');
    expect(plan.containerPlan?.backend).toBe('container');
  });

  it('keeps subscription as the fallback path for heavy-tool Main runs while preferring a direct parent when a verified API key exists', () => {
    seedAnthropicSecret('sk-ant-stale');
    upsertProviderVerification('provider.anthropic', 'verified');
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: 'owner-1',
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Browser Builder Main',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({
        browser: true,
        shell: true,
        filesystem: true,
      }),
    });

    const plan = planMainExecution(agent, 'owner-1');
    expect(plan.policy).toBe('direct_with_promotion');
    expect(plan.directPlan?.backend).toBe('direct_http');
    expect(plan.containerPlan?.backend).toBe('container');
    expect(plan.containerPlan?.containerCredential.authMode).toBe(
      'subscription',
    );
  });

  it('falls back to subscription-only Main browser execution when the Anthropic API key is not verified', () => {
    seedAnthropicSecret('sk-ant-stale');
    upsertProviderVerification('provider.anthropic', 'invalid');
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: 'owner-1',
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Browser',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ browser: true }),
    });

    const plan = planMainExecution(agent, 'owner-1');
    expect(plan.policy).toBe('container_only');
    expect(plan.directPlan).toBeNull();
    expect(plan.containerPlan?.backend).toBe('container');
    expect(plan.containerPlan?.routeReason).toBe('subscription_fallback');
    expect(plan.containerPlan?.containerCredential.authMode).toBe(
      'subscription',
    );
  });

  it('rejects heavy-tool agents on providers that are not Claude-SDK compatible', () => {
    const agent = createRegisteredAgent({
      name: 'GPT Builder',
      providerId: 'provider.openai',
      modelId: 'gpt-5',
      toolPermissionsJson: JSON.stringify({ shell: true }),
    });

    expect(() => planExecution(agent, 'owner-1')).toThrowError(
      /not compatible with the Claude container runtime/i,
    );
  });

  it('uses executor subscription credentials for container execution when configured', () => {
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: 'owner-1',
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Shell',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ shell: true }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('container');
    if (plan.backend === 'container') {
      expect(plan.containerCredential.authMode).toBe('subscription');
      expect(plan.containerCredential.secrets.CLAUDE_CODE_OAUTH_TOKEN).toBe(
        'oauth-token-123',
      );
    }
  });

  it('falls back light Claude agents to subscription container execution on Main', () => {
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Light',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('container');
    expect(plan.routeReason).toBe('subscription_fallback');
    if (plan.backend === 'container') {
      expect(plan.containerCredential.authMode).toBe('subscription');
      expect(plan.heavyToolFamilies).toEqual([]);
    }
  });

  it('applies the same subscription fallback for single-agent Talk turns', () => {
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Light',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('container');
    expect(plan.routeReason).toBe('subscription_fallback');
  });

  it('prefers configured subscription mode over direct Anthropic HTTP for light Claude agents', () => {
    seedAnthropicSecret('sk-ant-stale');
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: 'owner-1',
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Light',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('container');
    expect(plan.routeReason).toBe('normal');
    if (plan.backend === 'container') {
      expect(plan.containerCredential.authMode).toBe('subscription');
      expect(plan.heavyToolFamilies).toEqual([]);
    }
  });

  it('does not silently fall back to subscription when api key mode is explicitly selected', () => {
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'api_key',
      updatedBy: 'owner-1',
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Light',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    expect(() => planExecution(agent, 'owner-1')).toThrowError(
      /Direct execution is unavailable|No Anthropic API key configured/i,
    );
  });

  it('allows subscription fallback for multi-agent Talk rounds', () => {
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Light',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('container');
    expect(plan.routeReason).toBe('subscription_fallback');
  });

  it('maps effective tools into the talk/main container profile', () => {
    const allowedTools = getContainerAllowedTools({
      effectiveTools: [
        {
          toolFamily: 'shell',
          runtimeTools: ['Bash'],
          enabled: true,
          requiresApproval: false,
        },
        {
          toolFamily: 'filesystem',
          runtimeTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
          enabled: true,
          requiresApproval: false,
        },
        {
          toolFamily: 'web',
          runtimeTools: ['web_search', 'web_fetch'],
          enabled: true,
          requiresApproval: false,
        },
        {
          toolFamily: 'browser',
          runtimeTools: ['browser_open'],
          enabled: true,
          requiresApproval: false,
        },
      ],
    });

    expect(allowedTools).toEqual(
      expect.arrayContaining([
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'mcp__nanoclaw__*',
      ]),
    );
  });
});
