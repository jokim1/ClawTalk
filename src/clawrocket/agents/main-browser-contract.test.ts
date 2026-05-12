import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetContainerRuntimeStatusForTests,
  _setContainerRuntimeStatusForTests,
} from '../../container-runtime.js';
import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  upsertSettingValue,
  upsertUser,
} from '../db/index.js';
import { createRegisteredAgent } from '../db/agent-accessors.js';
import { encryptProviderSecret } from '../llm/provider-secret-store.js';
import { resolveBrowserExecutionContract } from './main-browser-contract.js';

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
  status: 'verified' | 'not_verified' | 'invalid',
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

function buildBrowserAgent() {
  return createRegisteredAgent({
    name: 'Claude Browser Main',
    providerId: 'provider.anthropic',
    modelId: 'claude-sonnet-4-6',
    toolPermissionsJson: JSON.stringify({ browser: true }),
  });
}

describe('main-browser-contract', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetContainerRuntimeStatusForTests();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
  });

  it('returns browser_disabled when browser tooling is not enabled', () => {
    const agent = createRegisteredAgent({
      name: 'Claude Main',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    expect(resolveBrowserExecutionContract(agent, 'owner-1')).toMatchObject({
      browserEnabled: false,
      ready: false,
      reasonCode: 'browser_disabled',
      selectedMode: null,
      transport: null,
    });
  });

  it('returns ready direct execution for verified api-key mode', () => {
    const agent = buildBrowserAgent();
    seedAnthropicSecret();
    upsertProviderVerification('provider.anthropic', 'verified');
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'api_key',
      updatedBy: 'owner-1',
    });

    expect(resolveBrowserExecutionContract(agent, 'owner-1')).toMatchObject({
      browserEnabled: true,
      ready: true,
      selectedMode: 'api',
      transport: 'direct',
      reasonCode: null,
    });
  });

  it('returns api_missing when api-key mode has no credential', () => {
    const agent = buildBrowserAgent();
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'api_key',
      updatedBy: 'owner-1',
    });

    expect(resolveBrowserExecutionContract(agent, 'owner-1')).toMatchObject({
      browserEnabled: true,
      ready: false,
      selectedMode: 'api',
      transport: 'direct',
      reasonCode: 'api_missing',
    });
  });

  it('returns api_not_verified when api-key mode has an unverified key', () => {
    const agent = buildBrowserAgent();
    seedAnthropicSecret();
    upsertProviderVerification('provider.anthropic', 'invalid');
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'api_key',
      updatedBy: 'owner-1',
    });

    expect(resolveBrowserExecutionContract(agent, 'owner-1')).toMatchObject({
      browserEnabled: true,
      ready: false,
      selectedMode: 'api',
      transport: 'direct',
      reasonCode: 'api_not_verified',
    });
  });

  it('returns ready subscription execution when credentials, verification, and Docker are ready', () => {
    const agent = buildBrowserAgent();
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
    upsertSettingValue({
      key: 'executor.verificationStatus',
      value: 'verified',
      updatedBy: 'owner-1',
    });
    _setContainerRuntimeStatusForTests('ready');

    expect(resolveBrowserExecutionContract(agent, 'owner-1')).toMatchObject({
      browserEnabled: true,
      ready: true,
      selectedMode: 'subscription',
      transport: 'subscription',
      reasonCode: null,
    });
  });

  it('returns subscription_missing when subscription mode lacks credentials', () => {
    const agent = buildBrowserAgent();
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: 'owner-1',
    });
    upsertSettingValue({
      key: 'executor.verificationStatus',
      value: 'verified',
      updatedBy: 'owner-1',
    });

    expect(resolveBrowserExecutionContract(agent, 'owner-1')).toMatchObject({
      browserEnabled: true,
      ready: false,
      selectedMode: 'subscription',
      transport: 'subscription',
      reasonCode: 'subscription_missing',
    });
  });

  it('returns subscription_not_verified when executor verification is not ready', () => {
    const agent = buildBrowserAgent();
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
    upsertSettingValue({
      key: 'executor.verificationStatus',
      value: 'not_verified',
      updatedBy: 'owner-1',
    });

    expect(resolveBrowserExecutionContract(agent, 'owner-1')).toMatchObject({
      browserEnabled: true,
      ready: false,
      selectedMode: 'subscription',
      transport: 'subscription',
      reasonCode: 'subscription_not_verified',
    });
  });

  it('returns subscription_runtime_unavailable when Docker is down', () => {
    const agent = buildBrowserAgent();
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
    upsertSettingValue({
      key: 'executor.verificationStatus',
      value: 'verified',
      updatedBy: 'owner-1',
    });
    _setContainerRuntimeStatusForTests('unavailable');

    expect(resolveBrowserExecutionContract(agent, 'owner-1')).toMatchObject({
      browserEnabled: true,
      ready: false,
      selectedMode: 'subscription',
      transport: 'subscription',
      reasonCode: 'subscription_runtime_unavailable',
    });
  });
});
