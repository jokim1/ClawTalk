import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTalk,
  getUserGoogleCredential,
  listTalkResourceBindings,
  listTalkToolGrants,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import * as googleToolsService from '../../identity/google-tools-service.js';
import { hashSessionToken } from '../../identity/session.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, type WebServerHandle } from '../server.js';

describe('talk tools routes', () => {
  let server: WebServerHandle;

  beforeEach(() => {
    _initTestDatabase();
    _resetRateLimitStateForTests();
    vi.restoreAllMocks();

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertWebSession({
      id: 'session-owner',
      userId: 'owner-1',
      accessTokenHash: hashSessionToken('owner-token'),
      refreshTokenHash: hashSessionToken('owner-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    createTalk({
      id: 'talk-owner',
      ownerId: 'owner-1',
      topicTitle: 'Accounting',
    });

    server = createWebServer({ host: '127.0.0.1', port: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes talk tools, updates grants, and manages bound Drive resources', async () => {
    const initialRes = await server.request('/api/v1/talks/talk-owner/tools', {
      headers: { Authorization: 'Bearer owner-token' },
    });
    expect(initialRes.status).toBe(200);
    const initialBody = (await initialRes.json()) as any;
    expect(initialBody.data.summary).toContain(
      'Google Drive unavailable — bind a file or folder to enable',
    );

    const updateRes = await server.request(
      '/api/v1/talks/talk-owner/tools/grants',
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grants: [
            { toolId: 'gmail_send', enabled: true },
            { toolId: 'web_search', enabled: true },
          ],
        }),
      },
    );
    expect(updateRes.status).toBe(200);
    const updatedBody = (await updateRes.json()) as any;
    expect(
      updatedBody.data.grants.find(
        (grant: any) => grant.toolId === 'gmail_send',
      )?.enabled,
    ).toBe(true);
    expect(listTalkToolGrants('talk-owner')).toHaveLength(
      updatedBody.data.grants.length,
    );

    const bindRes = await server.request('/api/v1/talks/talk-owner/resources', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'google_drive_folder',
        externalId: 'folder-123',
        displayName: 'Accounting',
      }),
    });
    expect(bindRes.status).toBe(201);

    const duplicateRes = await server.request(
      '/api/v1/talks/talk-owner/resources',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'google_drive_folder',
          externalId: 'folder-123',
          displayName: 'Accounting',
        }),
      },
    );
    expect(duplicateRes.status).toBe(201);
    expect(listTalkResourceBindings('talk-owner')).toHaveLength(1);

    const unsupportedRes = await server.request(
      '/api/v1/talks/talk-owner/resources',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'saved_source',
          externalId: 'src-1',
          displayName: 'Saved source',
        }),
      },
    );
    expect(unsupportedRes.status).toBe(400);
    const unsupportedBody = (await unsupportedRes.json()) as any;
    expect(unsupportedBody.error.code).toBe('unsupported_resource_kind');

    const listRes = await server.request('/api/v1/talks/talk-owner/resources', {
      headers: { Authorization: 'Bearer owner-token' },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as any;
    expect(listBody.data.bindings).toHaveLength(1);
    expect(listBody.data.bindings[0].kind).toBe('google_drive_folder');

    const deleteRes = await server.request(
      `/api/v1/talks/talk-owner/resources/${encodeURIComponent(
        listBody.data.bindings[0].id,
      )}`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer owner-token' },
      },
    );
    expect(deleteRes.status).toBe(200);
    expect(listTalkResourceBindings('talk-owner')).toHaveLength(0);
  });

  it('links a Google account through the popup callback flow and stores granted scopes', async () => {
    const connectRes = await server.request(
      '/api/v1/me/google-account/connect',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          returnTo: '/app/talks/talk-owner/tools',
        }),
      },
    );
    expect(connectRes.status).toBe(200);
    const connectBody = (await connectRes.json()) as any;
    const connectUrl = new URL(connectBody.data.authorizationUrl);
    expect(connectUrl.origin).toBe('http://127.0.0.1:3210');
    expect(connectUrl.pathname).toBe('/api/v1/auth/google/callback');
    const connectState = connectUrl.searchParams.get('state');
    expect(connectState).toBeTruthy();

    const callbackRes = await server.request(
      `/api/v1/auth/google/callback?state=${encodeURIComponent(
        connectState!,
      )}&email=owner@example.com&name=Owner`,
      {
        headers: { accept: 'text/html' },
      },
    );
    expect(callbackRes.status).toBe(200);
    expect(callbackRes.headers.get('content-type')).toContain('text/html');
    const html = await callbackRes.text();
    expect(html).toContain('clawrocket:google-account-link');
    expect(getUserGoogleCredential('owner-1')?.email).toBe('owner@example.com');
    expect(getUserGoogleCredential('owner-1')?.scopes).toEqual([]);

    const expandRes = await server.request(
      '/api/v1/me/google-account/expand-scopes',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          scopes: ['drive.readonly'],
          returnTo: '/app/talks/talk-owner/tools',
        }),
      },
    );
    expect(expandRes.status).toBe(200);
    const expandBody = (await expandRes.json()) as any;
    const expandUrl = new URL(expandBody.data.authorizationUrl);
    expect(expandUrl.origin).toBe('http://127.0.0.1:3210');
    expect(expandUrl.pathname).toBe('/api/v1/auth/google/callback');
    const expandState = expandUrl.searchParams.get('state');
    expect(expandState).toBeTruthy();

    const expandCallbackRes = await server.request(
      `/api/v1/auth/google/callback?state=${encodeURIComponent(
        expandState!,
      )}&email=owner@example.com&name=Owner`,
      {
        headers: { accept: 'application/json' },
      },
    );
    expect(expandCallbackRes.status).toBe(200);

    const accountRes = await server.request('/api/v1/me/google-account', {
      headers: { Authorization: 'Bearer owner-token' },
    });
    expect(accountRes.status).toBe(200);
    const accountBody = (await accountRes.json()) as any;
    expect(accountBody.data.googleAccount.connected).toBe(true);
    expect(accountBody.data.googleAccount.scopes).toContain('drive.readonly');
  });

  it('returns a no-store picker token only when picker session creation succeeds', async () => {
    const pickerSpy = vi
      .spyOn(googleToolsService, 'buildGooglePickerSession')
      .mockResolvedValue({
        oauthToken: 'picker-oauth-token',
        developerKey: 'picker-dev-key',
        appId: 'picker-app-id',
      });

    const res = await server.request('/api/v1/me/google-account/picker-token', {
      headers: { Authorization: 'Bearer owner-token' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as any;
    expect(body.data.oauthToken).toBe('picker-oauth-token');
    expect(body.data.developerKey).toBe('picker-dev-key');
    expect(body.data.appId).toBe('picker-app-id');
    expect(pickerSpy).toHaveBeenCalledWith('owner-1');
  });

  it('surfaces picker session errors with their route status', async () => {
    vi.spyOn(googleToolsService, 'buildGooglePickerSession').mockRejectedValue(
      new googleToolsService.GoogleToolCredentialError(
        'google_picker_not_configured',
        'Google Picker is not configured on this server.',
        503,
      ),
    );

    const res = await server.request('/api/v1/me/google-account/picker-token', {
      headers: { Authorization: 'Bearer owner-token' },
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('google_picker_not_configured');
  });

  it('preserves the normal login callback flow when no google link request exists', async () => {
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
    expect(callbackBody.data.user.email).toBe('owner@example.com');
    expect(callbackRes.headers.get('set-cookie')).toContain('cr_access_token=');
  });
});
