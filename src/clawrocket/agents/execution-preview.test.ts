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
import { buildMainExecutionPreview } from './execution-preview.js';

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

function seedProviderVerification(providerId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO llm_provider_verifications (
         provider_id, status, last_verified_at, last_error, updated_at
       ) VALUES (?, 'verified', ?, NULL, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         status = excluded.status,
         last_verified_at = excluded.last_verified_at,
         updated_at = excluded.updated_at`,
    )
    .run(providerId, now, now);
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

describe('execution-preview', () => {
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

  it('marks subscription-backed container routes as unavailable when Docker is unavailable', () => {
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
    _setContainerRuntimeStatusForTests('unavailable');

    const agent = createRegisteredAgent({
      name: 'Claude Main',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    expect(buildMainExecutionPreview(agent, 'owner-1')).toMatchObject({
      ready: false,
      routeReason: 'no_valid_path',
      backend: null,
      authPath: null,
    });
    expect(buildMainExecutionPreview(agent, 'owner-1').message).toMatch(
      /container runtime is unavailable/i,
    );
  });

  it('keeps direct HTTP Claude routes available when Docker is unavailable', () => {
    seedAnthropicSecret();
    _setContainerRuntimeStatusForTests('unavailable');

    const agent = createRegisteredAgent({
      name: 'Claude Main',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    expect(buildMainExecutionPreview(agent, 'owner-1')).toMatchObject({
      ready: true,
      backend: 'direct_http',
      authPath: 'api_key',
    });
  });

  it('marks mixed browser and heavy-tool Main routes as ready via promotion', () => {
    seedAnthropicSecret();

    const agent = createRegisteredAgent({
      name: 'Claude Browser Builder Main',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({
        web: true,
        shell: true,
        filesystem: true,
      }),
    });

    expect(buildMainExecutionPreview(agent, 'owner-1')).toMatchObject({
      ready: true,
      backend: 'direct_http',
      authPath: 'api_key',
      routeReason: 'direct_with_promotion',
    });
    expect(buildMainExecutionPreview(agent, 'owner-1').message).toMatch(
      /promote shell\/filesystem work into a background container run/i,
    );
  });

  it('shows browser-enabled Claude Main routes as direct fast-lane when a verified API key exists', () => {
    seedAnthropicSecret('sk-ant-verified');
    seedProviderVerification('provider.anthropic');
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'api_key',
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

    expect(buildMainExecutionPreview(agent, 'owner-1')).toMatchObject({
      ready: true,
      backend: 'direct_http',
      authPath: 'api_key',
      selectedMode: 'api',
      transport: 'direct',
      reasonCode: null,
      routeReason: 'normal',
    });
    expect(buildMainExecutionPreview(agent, 'owner-1').message).toMatch(
      /browser automation is ready in api mode/i,
    );
  });

  it('shows browser-enabled Claude Main routes as subscription-ready when executor verification passes', () => {
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

    const agent = createRegisteredAgent({
      name: 'Claude Browser Main',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ browser: true }),
    });

    expect(buildMainExecutionPreview(agent, 'owner-1')).toMatchObject({
      ready: true,
      backend: 'container',
      authPath: 'subscription',
      selectedMode: 'subscription',
      transport: 'subscription',
      reasonCode: null,
      routeReason: 'normal',
    });
    expect(buildMainExecutionPreview(agent, 'owner-1').message).toMatch(
      /browser automation is ready in subscription mode/i,
    );
  });

  it('shows browser-enabled Claude Main routes as misconfigured when subscription runtime is unavailable', () => {
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

    const agent = createRegisteredAgent({
      name: 'Claude Browser Main',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ browser: true }),
    });

    expect(buildMainExecutionPreview(agent, 'owner-1')).toMatchObject({
      ready: false,
      backend: 'container',
      authPath: 'subscription',
      selectedMode: 'subscription',
      transport: 'subscription',
      reasonCode: 'subscription_runtime_unavailable',
      routeReason: 'no_valid_path',
    });
    expect(buildMainExecutionPreview(agent, 'owner-1').message).toMatch(
      /container runtime is unavailable/i,
    );
  });

  it('marks verified Codex host routes as ready', () => {
    seedProviderVerification('provider.openai_codex');
    const agent = createRegisteredAgent({
      name: 'Codex Main',
      providerId: 'provider.openai_codex',
      modelId: 'gpt-5.4',
      toolPermissionsJson: JSON.stringify({
        shell: true,
        filesystem: true,
        web: true,
      }),
    });

    expect(buildMainExecutionPreview(agent, 'owner-1')).toMatchObject({
      ready: true,
      backend: 'host_codex',
      authPath: 'host_login',
      routeReason: 'host_only',
    });
    expect(buildMainExecutionPreview(agent, 'owner-1').message).toMatch(
      /codex host runtime/i,
    );
  });
});
