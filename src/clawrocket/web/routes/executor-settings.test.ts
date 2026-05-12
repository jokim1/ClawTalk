import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import {
  _resetContainerRuntimeStatusForTests,
  _setContainerRuntimeStatusForTests,
} from '../../../container-runtime.js';
import { getDb } from '../../../db.js';
import {
  _initTestDatabase,
  getSettingValue,
  upsertSettingValue,
  upsertUser,
} from '../../db/index.js';
import { encryptProviderSecret } from '../../llm/provider-secret-store.js';
import { ExecutorSubscriptionHostAuthService } from '../../talks/executor-subscription-host-auth.js';
import type { AuthContext } from '../types.js';
import {
  _resetExecutorVerificationSingleFlightForTests,
  getExecutorStatusRoute,
  getExecutorSettingsRoute,
  importExecutorSubscriptionRoute,
  putExecutorSettingsRoute,
  verifyExecutorRoute,
} from './executor-settings.js';

const auth: AuthContext = {
  sessionId: 'session-1',
  userId: 'owner-1',
  role: 'owner',
  authType: 'bearer',
};

function seedAnthropicSecret(apiKey = 'sk-ant-test'): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO llm_provider_secrets (provider_id, ciphertext, updated_at, updated_by)
       VALUES ('provider.anthropic', ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET ciphertext = excluded.ciphertext,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(encryptProviderSecret({ apiKey }), now, auth.userId);
}

describe('executor-settings routes', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetExecutorVerificationSingleFlightForTests();
    _resetContainerRuntimeStatusForTests();
    _setContainerRuntimeStatusForTests('ready');
    upsertUser({
      id: auth.userId,
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
  });

  afterEach(() => {
    _resetExecutorVerificationSingleFlightForTests();
    _resetContainerRuntimeStatusForTests();
  });

  it('reports stale subscription configs as not_verified until runtime verification runs', () => {
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.verificationStatus',
      value: 'verified',
      updatedBy: auth.userId,
    });

    const result = getExecutorSettingsRoute(auth);
    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data.verificationStatus).toBe('not_verified');
    }
  });

  it('re-validates api_key mode before reporting verified and stores direct-http verification metadata', async () => {
    seedAnthropicSecret();
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'api_key',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.verificationStatus',
      value: 'verified',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.lastVerificationMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.lastVerificationMethod',
      value: 'subscription_container_runtime',
      updatedBy: auth.userId,
    });

    const staleResult = getExecutorSettingsRoute(auth);
    expect(staleResult.statusCode).toBe(200);
    expect(staleResult.body.ok).toBe(true);
    if (staleResult.body.ok) {
      expect(staleResult.body.data.verificationStatus).toBe('not_verified');
    }

    const verifyResult = await verifyExecutorRoute(auth, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    expect(verifyResult.statusCode).toBe(200);
    expect(verifyResult.body.ok).toBe(true);
    if (verifyResult.body.ok) {
      expect(verifyResult.body.data.code).toBe('verified');
    }
    expect(getSettingValue('executor.verificationStatus')).toBe('verified');
    expect(getSettingValue('executor.lastVerificationMode')).toBe('api_key');
    expect(getSettingValue('executor.lastVerificationMethod')).toBe(
      'anthropic_messages_direct_http',
    );
  });

  it('honors null clear semantics for executor credentials', () => {
    seedAnthropicSecret();
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.anthropicAuthToken',
      value: 'auth-token-123',
      updatedBy: auth.userId,
    });

    const result = putExecutorSettingsRoute(auth, {
      executorAuthMode: 'none',
      anthropicApiKey: null,
      claudeOauthToken: null,
      anthropicAuthToken: null,
    });

    expect(result.statusCode).toBe(200);
    expect(getSettingValue('executor.claudeOauthToken')).toBeNull();
    expect(getSettingValue('executor.anthropicAuthToken')).toBeNull();
    expect(
      getDb()
        .prepare(
          `SELECT 1 FROM llm_provider_secrets WHERE provider_id = 'provider.anthropic'`,
        )
        .get(),
    ).toBeUndefined();
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data.activeCredentialConfigured).toBe(false);
      expect(result.body.data.verificationStatus).toBe('missing');
    }
  });

  it('stores Anthropic API keys encrypted at rest', () => {
    const result = putExecutorSettingsRoute(auth, {
      executorAuthMode: 'api_key',
      anthropicApiKey: 'sk-ant-encrypted',
    });

    expect(result.statusCode).toBe(200);
    const row = getDb()
      .prepare(
        `SELECT ciphertext FROM llm_provider_secrets WHERE provider_id = 'provider.anthropic'`,
      )
      .get() as { ciphertext: string } | undefined;
    expect(row?.ciphertext).toBeTruthy();
    expect(row?.ciphertext.includes('sk-ant-encrypted')).toBe(false);
  });

  it('imports a host subscription credential only when the fingerprint matches', async () => {
    const hostAuthService = new ExecutorSubscriptionHostAuthService({
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-host-token',
      },
      serviceUser: 'owner',
      serviceHomePath: '/home/owner',
    });
    const probe = await hostAuthService.probeImportSource();
    expect(probe.hostCredentialFingerprint).toBeTruthy();

    const result = await importExecutorSubscriptionRoute(
      auth,
      {
        expectedFingerprint: probe.hostCredentialFingerprint,
      },
      { hostAuthService },
    );

    expect(result.statusCode).toBe(200);
    expect(getSettingValue('executor.authMode')).toBe('subscription');
    expect(getSettingValue('executor.claudeOauthToken')).toBe(
      'oauth-host-token',
    );
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data.status).toBe('imported');
      expect(result.body.data.settings.verificationStatus).toBe('not_verified');
    }
  });

  it('verifies subscription runtime and stores verified metadata', async () => {
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: auth.userId,
    });

    const result = await verifyExecutorRoute(auth, {
      verifySubscriptionRuntime: async () => ({
        status: 'verified',
        code: 'verified',
        message: 'Subscription runtime verified.',
      }),
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data.code).toBe('verified');
    }
    expect(getSettingValue('executor.verificationStatus')).toBe('verified');
    expect(getSettingValue('executor.lastVerificationMode')).toBe(
      'subscription',
    );
    expect(getSettingValue('executor.lastVerificationMethod')).toBe(
      'subscription_container_runtime',
    );
  });

  it('reports unverified subscription credentials honestly when Docker is unavailable', () => {
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: auth.userId,
    });
    _setContainerRuntimeStatusForTests('unavailable');

    const settings = getExecutorSettingsRoute(auth);
    expect(settings.statusCode).toBe(200);
    expect(settings.body.ok).toBe(true);
    if (settings.body.ok) {
      expect(settings.body.data.verificationStatus).toBe('not_verified');
      expect(settings.body.data.lastVerificationError).toBeNull();
    }

    const status = getExecutorStatusRoute(auth);
    expect(status.statusCode).toBe(200);
    expect(status.body.ok).toBe(true);
    if (status.body.ok) {
      expect(status.body.data.containerRuntimeAvailability).toBe('unavailable');
      expect(status.body.data.verificationStatus).toBe('not_verified');
      expect(status.body.data.lastVerificationError).toBeNull();
    }
  });

  it('keeps a previously verified subscription credential verified when Docker is unavailable', () => {
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.verificationStatus',
      value: 'verified',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.lastVerificationMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.lastVerificationMethod',
      value: 'subscription_container_runtime',
      updatedBy: auth.userId,
    });
    _setContainerRuntimeStatusForTests('unavailable');

    const settings = getExecutorSettingsRoute(auth);
    expect(settings.statusCode).toBe(200);
    expect(settings.body.ok).toBe(true);
    if (settings.body.ok) {
      expect(settings.body.data.verificationStatus).toBe('verified');
      expect(settings.body.data.lastVerificationError).toBeNull();
    }

    const status = getExecutorStatusRoute(auth);
    expect(status.statusCode).toBe(200);
    expect(status.body.ok).toBe(true);
    if (status.body.ok) {
      expect(status.body.data.containerRuntimeAvailability).toBe('unavailable');
      expect(status.body.data.verificationStatus).toBe('verified');
    }
  });

  it('normalizes persisted subscription unavailable status back to not_verified', () => {
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.verificationStatus',
      value: 'unavailable',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.lastVerificationMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.lastVerificationMethod',
      value: 'subscription_container_runtime',
      updatedBy: auth.userId,
    });

    const settings = getExecutorSettingsRoute(auth);
    expect(settings.statusCode).toBe(200);
    expect(settings.body.ok).toBe(true);
    if (settings.body.ok) {
      expect(settings.body.data.verificationStatus).toBe('not_verified');
    }
  });

  it('returns runtime_unavailable and persists not_verified when Docker is unavailable during subscription verification', async () => {
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: auth.userId,
    });
    _setContainerRuntimeStatusForTests('unavailable');

    const result = await verifyExecutorRoute(auth);

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data.code).toBe('runtime_unavailable');
      expect(result.body.data.message).toMatch(/verification could not run/i);
    }
    expect(getSettingValue('executor.verificationStatus')).toBe('not_verified');
    expect(getSettingValue('executor.lastVerificationMode')).toBe(
      'subscription',
    );
    expect(getSettingValue('executor.lastVerificationMethod')).toBe(
      'subscription_container_runtime',
    );
    expect(getSettingValue('executor.lastVerificationError')).toMatch(
      /container runtime is unavailable/i,
    );
  });

  it('persists invalid subscription verification results', async () => {
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: auth.userId,
    });

    const result = await verifyExecutorRoute(auth, {
      verifySubscriptionRuntime: async () => ({
        status: 'invalid',
        code: 'invalid_credential',
        message: 'Subscription rejected.',
      }),
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data.code).toBe('invalid_credential');
    }
    expect(getSettingValue('executor.verificationStatus')).toBe('invalid');
    expect(getSettingValue('executor.lastVerificationError')).toBe(
      'Subscription rejected.',
    );
  });

  it('persists rate-limited subscription verification results', async () => {
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: auth.userId,
    });

    const result = await verifyExecutorRoute(auth, {
      verifySubscriptionRuntime: async () => ({
        status: 'rate_limited',
        code: 'rate_limited',
        message: 'Usage limit hit.',
      }),
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data.code).toBe('rate_limited');
    }
    expect(getSettingValue('executor.verificationStatus')).toBe('rate_limited');
    expect(getSettingValue('executor.lastVerificationError')).toBe(
      'Usage limit hit.',
    );
  });

  it('deduplicates concurrent verification runs with a process-local lock', async () => {
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: auth.userId,
    });

    let release!: () => void;
    const firstPromise = verifyExecutorRoute(auth, {
      verifySubscriptionRuntime: async () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              status: 'verified',
              code: 'verified',
              message: 'Subscription runtime verified.',
            });
        }),
    });

    const second = await verifyExecutorRoute(auth, {
      verifySubscriptionRuntime: async () => ({
        status: 'verified',
        code: 'verified',
        message: 'unexpected',
      }),
    });

    expect(second.statusCode).toBe(200);
    expect(second.body.ok).toBe(true);
    if (second.body.ok) {
      expect(second.body.data.code).toBe('verification_in_progress');
    }

    release();
    await firstPromise;
  });
});
