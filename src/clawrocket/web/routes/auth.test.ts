import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from '../../db/index.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, WebServerHandle } from '../server.js';

describe('auth routes (phase 1)', () => {
  let server: WebServerHandle;

  beforeEach(async () => {
    _initTestDatabase();
    _resetRateLimitStateForTests();
    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
    });
  });

  it('returns frontend-safe auth config without authentication', async () => {
    const res = await server.request('/api/v1/auth/config');
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(typeof body.data.devMode).toBe('boolean');
  });

  it('uses a local callback URI for loopback auth start requests', async () => {
    const startRes = await server.request('/api/v1/auth/google/start', {
      method: 'POST',
    });
    expect(startRes.status).toBe(200);

    const startBody = (await startRes.json()) as any;
    const authorizationUrl = new URL(startBody.data.authorizationUrl);
    expect(authorizationUrl.origin).toBe('http://127.0.0.1:3210');
    expect(authorizationUrl.pathname).toBe('/api/v1/auth/google/callback');
  });

  it('supports owner-claim on first OAuth callback and /session/me', async () => {
    const startRes = await server.request('/api/v1/auth/google/start', {
      method: 'POST',
    });
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as any;
    const state = startBody.data.state as string;

    const callbackRes = await server.request(
      `/api/v1/auth/google/callback?state=${encodeURIComponent(
        state,
      )}&email=owner@example.com&name=Owner`,
      {
        headers: {
          Accept: 'application/json',
        },
      },
    );
    expect(callbackRes.status).toBe(200);
    const callbackBody = (await callbackRes.json()) as any;
    expect(callbackBody.data.user.role).toBe('owner');

    const cookies = getCookieHeader(callbackRes);
    expect(cookies).toContain('cr_access_token=');

    const meRes = await server.request('/api/v1/session/me', {
      headers: {
        Cookie: cookies,
      },
    });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as any;
    expect(meBody.data.user.email).toBe('owner@example.com');
  });

  it('redirects browser callback requests to /app/talks after setting cookies', async () => {
    const startRes = await server.request('/api/v1/auth/google/start', {
      method: 'POST',
    });
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as any;
    const state = startBody.data.state as string;

    const callbackRes = await server.request(
      `/api/v1/auth/google/callback?state=${encodeURIComponent(
        state,
      )}&email=owner@example.com&name=Owner`,
      {
        headers: {
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      },
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get('location')).toBe('/app/talks');
    expect(callbackRes.headers.get('cache-control')).toBe('no-store');

    const cookies = getCookieHeader(callbackRes);
    expect(cookies).toContain('cr_access_token=');
    expect(cookies).toContain('cr_refresh_token=');
    expect(cookies).toContain('cr_csrf_token=');

    const meRes = await server.request('/api/v1/session/me', {
      headers: {
        Cookie: cookies,
      },
    });
    expect(meRes.status).toBe(200);
  });

  it('redirects browser callback requests to returnTo from start payload', async () => {
    const startRes = await server.request('/api/v1/auth/google/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ returnTo: '/app/talks/talk-42?view=latest#tail' }),
    });
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as any;
    const state = startBody.data.state as string;

    const callbackRes = await server.request(
      `/api/v1/auth/google/callback?state=${encodeURIComponent(
        state,
      )}&email=owner@example.com&name=Owner`,
      {
        headers: {
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      },
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get('location')).toBe(
      '/app/talks/talk-42?view=latest#tail',
    );
  });

  it('falls back to /app/talks when returnTo is unsafe', async () => {
    const unsafeReturnToCases = [
      '//evil.com',
      '/\\evil.com',
      '/app/talks%0d%0aX-Injected: yes',
    ];

    for (const returnTo of unsafeReturnToCases) {
      const startRes = await server.request('/api/v1/auth/google/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ returnTo }),
      });
      expect(startRes.status).toBe(200);
      const startBody = (await startRes.json()) as any;
      const state = startBody.data.state as string;

      const callbackRes = await server.request(
        `/api/v1/auth/google/callback?state=${encodeURIComponent(
          state,
        )}&email=owner@example.com&name=Owner`,
        {
          headers: {
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        },
      );
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get('location')).toBe('/app/talks');
    }
  });

  it('requires invite for second account and allows login after invite', async () => {
    const ownerCtx = await loginViaDevCallback(
      server,
      'owner@example.com',
      'Owner',
    );

    const startRes = await server.request('/api/v1/auth/google/start', {
      method: 'POST',
    });
    const startBody = (await startRes.json()) as any;
    const blockedRes = await server.request(
      `/api/v1/auth/google/callback?state=${encodeURIComponent(
        startBody.data.state,
      )}&email=member@example.com&name=Member`,
      {
        headers: {
          Accept: 'application/json',
        },
      },
    );
    expect(blockedRes.status).toBe(403);

    const inviteRes = await server.request('/api/v1/settings/users/invite', {
      method: 'POST',
      headers: {
        Cookie: ownerCtx.cookies,
        'Content-Type': 'application/json',
        'X-CSRF-Token': ownerCtx.csrfToken,
      },
      body: JSON.stringify({ email: 'member@example.com', role: 'member' }),
    });
    expect(inviteRes.status).toBe(200);

    const startRes2 = await server.request('/api/v1/auth/google/start', {
      method: 'POST',
    });
    const startBody2 = (await startRes2.json()) as any;
    const allowedRes = await server.request(
      `/api/v1/auth/google/callback?state=${encodeURIComponent(
        startBody2.data.state,
      )}&email=member@example.com&name=Member`,
      {
        headers: {
          Accept: 'application/json',
        },
      },
    );
    expect(allowedRes.status).toBe(200);
    const allowedBody = (await allowedRes.json()) as any;
    expect(allowedBody.data.user.role).toBe('member');
  });

  it('refreshes and logs out sessions', async () => {
    const ownerCtx = await loginViaDevCallback(
      server,
      'owner@example.com',
      'Owner',
    );

    const refreshRes = await server.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: {
        Cookie: ownerCtx.cookies,
      },
    });
    expect(refreshRes.status).toBe(200);
    const refreshedCookies = getCookieHeader(refreshRes);
    expect(refreshedCookies).toContain('cr_access_token=');
    const refreshedAccessToken =
      getCookieValue(refreshedCookies, 'cr_access_token') ||
      ownerCtx.accessToken;

    const logoutRes = await server.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${refreshedAccessToken}`,
      },
    });
    expect(logoutRes.status).toBe(200);

    const meRes = await server.request('/api/v1/session/me', {
      headers: {
        Authorization: `Bearer ${refreshedAccessToken}`,
      },
    });
    expect(meRes.status).toBe(401);
  });

  it('supports device flow completion for existing user', async () => {
    await loginViaDevCallback(server, 'owner@example.com', 'Owner');

    const startRes = await server.request('/api/v1/auth/device/start', {
      method: 'POST',
    });
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as any;

    const completeRes = await server.request('/api/v1/auth/device/complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        deviceCode: startBody.data.deviceCode,
        email: 'owner@example.com',
      }),
    });

    expect(completeRes.status).toBe(200);
    const completeBody = (await completeRes.json()) as any;
    expect(completeBody.data.accessToken).toBeTruthy();
    expect(completeBody.data.user.email).toBe('owner@example.com');
  });

  it('rate limits refresh attempts and returns retry-after', async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await server.request('/api/v1/auth/refresh', {
        method: 'POST',
        headers: {
          'X-Forwarded-For': '1.2.3.4',
          'X-Refresh-Token': `invalid-refresh-${i}`,
        },
      });
      expect(res.status).toBe(401);
    }

    const limited = await server.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: {
        'X-Forwarded-For': '1.2.3.4',
        'X-Refresh-Token': 'invalid-refresh-over-limit',
      },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  it('rate limits device completion attempts and returns retry-after', async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await server.request('/api/v1/auth/device/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '5.6.7.8',
        },
        body: JSON.stringify({
          deviceCode: `invalid-device-${i}`,
          email: 'owner@example.com',
        }),
      });
      expect(res.status).toBe(401);
    }

    const limited = await server.request('/api/v1/auth/device/complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '5.6.7.8',
      },
      body: JSON.stringify({
        deviceCode: 'invalid-device-over-limit',
        email: 'owner@example.com',
      }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });
});

async function loginViaDevCallback(
  server: WebServerHandle,
  email: string,
  name: string,
): Promise<{ cookies: string; csrfToken: string; accessToken: string }> {
  const startRes = await server.request('/api/v1/auth/google/start', {
    method: 'POST',
  });
  const startBody = (await startRes.json()) as any;
  const state = startBody.data.state as string;

  const callbackRes = await server.request(
    `/api/v1/auth/google/callback?state=${encodeURIComponent(
      state,
    )}&email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`,
    {
      headers: {
        Accept: 'application/json',
      },
    },
  );
  if (callbackRes.status !== 200) {
    throw new Error(`Login failed: ${callbackRes.status}`);
  }

  const cookies = getCookieHeader(callbackRes);
  return {
    cookies,
    csrfToken: getCookieValue(cookies, 'cr_csrf_token') || '',
    accessToken: getCookieValue(cookies, 'cr_access_token') || '',
  };
}

function getCookieHeader(res: Response): string {
  const anyHeaders = res.headers as any;
  const setCookies: string[] =
    typeof anyHeaders.getSetCookie === 'function'
      ? anyHeaders.getSetCookie()
      : [res.headers.get('set-cookie') || ''];

  return setCookies
    .filter(Boolean)
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

function getCookieValue(
  cookieHeader: string,
  name: string,
): string | undefined {
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) return rawValue.join('=');
  }
  return undefined;
}
