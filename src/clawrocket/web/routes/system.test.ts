import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { hashSessionToken } from '../../identity/session.js';
import { noopKeychainBridge } from '../../secrets/keychain.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, WebServerHandle } from '../server.js';
import { healthResponse } from './system.js';

describe('system routes', () => {
  let server: WebServerHandle;

  beforeEach(async () => {
    _initTestDatabase();
    _resetRateLimitStateForTests();

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertWebSession({
      id: 'session-1',
      userId: 'owner-1',
      accessTokenHash: hashSessionToken('token-owner-1'),
      refreshTokenHash: hashSessionToken('refresh-owner-1'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
      keychain: noopKeychainBridge,
    });
  });

  afterEach(async () => {
    await server?.stop();
  });

  it('serves shallow health without auth', async () => {
    const res = await server.request('/api/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('ok');
  });

  it('serves deep status with auth', async () => {
    const res = await server.request('/api/v1/status', {
      headers: {
        Authorization: 'Bearer token-owner-1',
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.db).toBe('ok');
    expect(body.data.keychain).toBe('ok');
  });

  it('returns db_unavailable when health check fails', async () => {
    const failed = await healthResponse(() => false);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('db_unavailable');
    }
  });

  it('serves SPA index fallback with CSP from configured dist directory', async () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawrocket-web-'));
    try {
      fs.writeFileSync(
        path.join(distDir, 'index.html'),
        '<!doctype html><html><body><div id="root"></div></body></html>',
      );
      fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
      fs.writeFileSync(
        path.join(distDir, 'assets', 'app-abc123.js'),
        'console.log(1);',
      );
      fs.writeFileSync(path.join(distDir, 'robots.txt'), 'User-agent: *');

      const webServer = createWebServer({
        host: '127.0.0.1',
        port: 0,
        keychain: noopKeychainBridge,
        webAppDistDir: distDir,
      });

      const routeRes = await webServer.request('/app/talks');
      expect(routeRes.status).toBe(200);
      expect(routeRes.headers.get('content-type')).toContain('text/html');
      expect(routeRes.headers.get('cache-control')).toBe('no-cache');
      const csp = routeRes.headers.get('content-security-policy');
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self' https://apis.google.com");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain(
        "img-src 'self' data: https://*.googleusercontent.com https://*.gstatic.com https://www.google.com",
      );
      expect(csp).toContain(
        "connect-src 'self' https://apis.google.com https://www.googleapis.com https://content.googleapis.com https://docs.google.com",
      );
      expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
      expect(csp).toContain(
        "frame-src 'self' https://accounts.google.com https://docs.google.com https://drive.google.com https://*.googleusercontent.com",
      );

      const assetRes = await webServer.request('/assets/app-abc123.js');
      expect(assetRes.status).toBe(200);
      expect(assetRes.headers.get('content-type')).toContain(
        'application/javascript',
      );
      expect(assetRes.headers.get('cache-control')).toBe(
        'public, max-age=31536000, immutable',
      );

      const plainStaticRes = await webServer.request('/robots.txt');
      expect(plainStaticRes.status).toBe(200);
      expect(plainStaticRes.headers.get('cache-control')).toBe(
        'public, max-age=3600',
      );
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  it('returns 404 for SPA routes when dist directory is unavailable', async () => {
    const missingDir = path.join(
      os.tmpdir(),
      `clawrocket-web-missing-${Date.now()}`,
    );
    const webServer = createWebServer({
      host: '127.0.0.1',
      port: 0,
      keychain: noopKeychainBridge,
      webAppDistDir: missingDir,
    });

    const res = await webServer.request('/app/talks');
    expect(res.status).toBe(404);
  });
});
