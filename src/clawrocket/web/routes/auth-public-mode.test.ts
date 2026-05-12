import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';

describe('auth routes in public mode', () => {
  beforeEach(() => {
    _resetRateLimitStateForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function createPublicModeServer() {
    vi.resetModules();
    vi.stubEnv('PUBLIC_MODE', 'true');
    vi.stubEnv('TRUSTED_PROXY_MODE', 'cloudflare');

    const db = await import('../../db/index.js');
    db._initTestDatabase();
    const { createWebServer } = await import('../server.js');
    return createWebServer({
      host: '127.0.0.1',
      port: 0,
    });
  }

  it('disables device auth start in public mode', async () => {
    const server = await createPublicModeServer();

    const res = await server.request('/api/v1/auth/device/start', {
      method: 'POST',
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('device_auth_disabled');
  });

  it('disables device auth completion in public mode', async () => {
    const server = await createPublicModeServer();

    const res = await server.request('/api/v1/auth/device/complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        deviceCode: 'device-code',
        email: 'owner@example.com',
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('device_auth_disabled');
  });
});
