import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthContext } from '../types.js';

const auth: AuthContext = {
  sessionId: 'session-1',
  userId: 'owner-1',
  role: 'owner',
  authType: 'bearer',
};

describe('executor-settings env credential support', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('surfaces an env Anthropic API key in executor settings and verifies it', async () => {
    vi.resetModules();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env-test');

    const db = await import('../../db/index.js');
    db._initTestDatabase();
    db.upsertUser({
      id: auth.userId,
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });

    const routes = await import('./executor-settings.js');

    const settings = routes.getExecutorSettingsRoute(auth);
    expect(settings.statusCode).toBe(200);
    expect(settings.body.ok).toBe(true);
    if (!settings.body.ok) throw new Error('Expected ok settings response');
    expect(settings.body.data.executorAuthMode).toBe('api_key');
    expect(settings.body.data.authModeSource).toBe('inferred');
    expect(settings.body.data.hasApiKey).toBe(true);
    expect(settings.body.data.apiKeySource).toBe('env');
    expect(settings.body.data.apiKeyHint).toBe(
      'Environment variable (ANTHROPIC_API_KEY)',
    );

    const verify = await routes.verifyExecutorRoute(auth, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.body.ok).toBe(true);
    if (!verify.body.ok) throw new Error('Expected ok verification response');
    expect(verify.body.data.code).toBe('verified');
  });

  it('infers subscription mode from env Claude subscription credentials', async () => {
    vi.resetModules();
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-env-test');

    const db = await import('../../db/index.js');
    db._initTestDatabase();
    db.upsertUser({
      id: auth.userId,
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });

    const routes = await import('./executor-settings.js');

    const settings = routes.getExecutorSettingsRoute(auth);
    expect(settings.statusCode).toBe(200);
    expect(settings.body.ok).toBe(true);
    if (!settings.body.ok) throw new Error('Expected ok settings response');
    expect(settings.body.data.executorAuthMode).toBe('subscription');
    expect(settings.body.data.authModeSource).toBe('inferred');
    expect(settings.body.data.hasOauthToken).toBe(true);
    expect(settings.body.data.oauthTokenSource).toBe('env');
    expect(settings.body.data.oauthTokenHint).toBe(
      'Environment variable (CLAUDE_CODE_OAUTH_TOKEN)',
    );
  });
});
