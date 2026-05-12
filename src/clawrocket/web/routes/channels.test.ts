import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'crypto';

import * as slackConnector from '../../channels/slack-connector.js';
import * as telegramConnector from '../../channels/telegram-connector.js';
import { encryptChannelSecret } from '../../channels/channel-secret-store.js';
import { encryptChannelProviderSecret } from '../../channels/channel-provider-secret-store.js';
import { setTalkAgents } from '../../agents/agent-registry.js';
import {
  _initTestDatabase,
  createRegisteredAgent,
  ensureSystemManagedTelegramConnection,
  setChannelConnectionSecret,
  setChannelProviderConfig,
  setChannelProviderSecret,
  upsertChannelConnection,
  upsertChannelTarget,
  upsertTalk,
  upsertTalkMember,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { hashSessionToken } from '../../identity/session.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, type WebServerHandle } from '../server.js';
import { saveTelegramChannelConnectorTokenRoute } from './channels.js';

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

describe('talk channel routes', () => {
  let server: WebServerHandle;

  beforeEach(() => {
    _initTestDatabase();
    _resetRateLimitStateForTests();

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertUser({
      id: 'viewer-1',
      email: 'viewer@example.com',
      displayName: 'Viewer',
      role: 'member',
    });
    upsertTalk({
      id: 'talk-1',
      ownerId: 'owner-1',
      topicTitle: 'Channels Route Test',
    });
    upsertTalkMember({
      talkId: 'talk-1',
      userId: 'viewer-1',
      role: 'viewer',
    });
    const registeredAgent = createRegisteredAgent({
      name: 'Default Agent',
      providerId: 'openai',
      modelId: 'gpt-5-mini',
    });
    setTalkAgents('talk-1', [
      {
        id: registeredAgent.id,
        sourceKind: 'provider',
        providerId: 'openai',
        modelId: 'gpt-5-mini',
        nickname: 'Default Agent',
        nicknameMode: 'auto',
        personaRole: 'General',
        isPrimary: true,
        sortOrder: 0,
      },
    ]);

    upsertWebSession({
      id: 's-owner',
      userId: 'owner-1',
      accessTokenHash: hashSessionToken('owner-token'),
      refreshTokenHash: hashSessionToken('owner-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    upsertWebSession({
      id: 's-viewer',
      userId: 'viewer-1',
      accessTokenHash: hashSessionToken('viewer-token'),
      refreshTokenHash: hashSessionToken('viewer-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    ensureSystemManagedTelegramConnection();
    upsertChannelTarget({
      connectionId: 'channel-conn:telegram:system',
      targetKind: 'chat',
      targetId: 'tg:chat:123',
      displayName: 'Gamemakers Chat',
    });

    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
    });
  });

  it('lists talk channel bindings for authenticated talk members', async () => {
    const res = await server.request('/api/v1/talks/talk-1/channels', {
      method: 'GET',
      headers: authHeaders('owner-token'),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.talkId).toBe('talk-1');
    expect(body.data.bindings).toEqual([]);
  });

  it('returns 401 for unauthenticated channel list requests', async () => {
    const res = await server.request('/api/v1/talks/talk-1/channels', {
      method: 'GET',
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('unauthorized');
  });

  it('lists channel connections for owners', async () => {
    const res = await server.request('/api/v1/channel-connections', {
      method: 'GET',
      headers: authHeaders('owner-token'),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'channel-conn:telegram:system',
          platform: 'telegram',
        }),
      ]),
    );
  });

  it('forbids channel connection listing for non-admin talk members', async () => {
    const res = await server.request('/api/v1/channel-connections', {
      method: 'GET',
      headers: authHeaders('viewer-token'),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('forbidden');
  });

  it('lists cached channel targets for owners', async () => {
    const res = await server.request(
      '/api/v1/channel-connections/channel-conn%3Atelegram%3Asystem/targets?query=game',
      {
        method: 'GET',
        headers: authHeaders('owner-token'),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.targets).toEqual([
      expect.objectContaining({
        connection_id: 'channel-conn:telegram:system',
        target_id: 'tg:chat:123',
        display_name: 'Gamemakers Chat',
      }),
    ]);
  });

  it('lists the Telegram connector state for owners', async () => {
    const res = await server.request('/api/v1/channel-connectors/telegram', {
      method: 'GET',
      headers: authHeaders('owner-token'),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.connection).toEqual(
      expect.objectContaining({
        id: 'channel-conn:telegram:system',
        platform: 'telegram',
        token_source: 'missing',
      }),
    );
    expect(body.data.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_id: 'tg:chat:123',
          approved: 0,
        }),
      ]),
    );
  });

  it('lists the Slack connector state and workspace installs for owners', async () => {
    setChannelProviderConfig({
      platform: 'slack',
      configJson: JSON.stringify({ clientId: '123.456' }),
      updatedBy: 'owner-1',
    });
    setChannelProviderSecret({
      platform: 'slack',
      ciphertext: encryptChannelProviderSecret({
        kind: 'slack_app',
        clientSecret: 'client-secret',
        signingSecret: 'signing-secret',
      }),
      updatedBy: 'owner-1',
    });

    const res = await server.request('/api/v1/channel-connectors/slack', {
      method: 'GET',
      headers: authHeaders('owner-token'),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.config).toEqual(
      expect.objectContaining({
        clientId: '123.456',
        hasClientSecret: true,
        hasSigningSecret: true,
      }),
    );
    expect(body.data.workspaces).toEqual([]);
  });

  it('returns a clear error when Slack events are hit before the signing secret is saved', async () => {
    const res = await server.request(
      '/api/v1/channel-connectors/slack/events',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ type: 'url_verification', challenge: 'abc123' }),
      },
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('slack_events_not_ready');
  });

  it('accepts Slack url_verification after the signing secret is configured', async () => {
    const signingSecret = 'signing-secret';
    setChannelProviderSecret({
      platform: 'slack',
      ciphertext: encryptChannelProviderSecret({
        kind: 'slack_app',
        clientSecret: 'client-secret',
        signingSecret,
      }),
      updatedBy: 'owner-1',
    });

    const payload = JSON.stringify({
      type: 'url_verification',
      challenge: 'abc123',
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac('sha256', signingSecret)
      .update(`v0:${timestamp}:${payload}`)
      .digest('hex')}`;

    const res = await server.request(
      '/api/v1/channel-connectors/slack/events',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: payload,
      },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('returns public and private channel counts when syncing a Slack workspace', async () => {
    const slackConnection = upsertChannelConnection({
      platform: 'slack',
      connectionMode: 'oauth_workspace',
      accountKey: 'slack:T123',
      displayName: 'Acme Workspace',
      enabled: true,
      healthStatus: 'healthy',
      config: {
        teamId: 'T123',
        teamName: 'Acme Workspace',
        teamUrl: 'acme.slack.com',
      },
    });
    setChannelConnectionSecret({
      connectionId: slackConnection.id,
      ciphertext: encryptChannelSecret({
        kind: 'slack_bot',
        botToken: 'xoxb-test-token',
      }),
      updatedBy: 'owner-1',
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          channels: [
            {
              id: 'C123',
              name: 'general',
              is_private: false,
              is_member: true,
            },
            {
              id: 'C234',
              name: 'product-launch',
              is_private: true,
              is_member: true,
            },
          ],
          response_metadata: {
            next_cursor: '',
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    );

    const res = await server.request(
      `/api/v1/channel-connectors/slack/workspaces/${encodeURIComponent(slackConnection.id)}/sync`,
      {
        method: 'POST',
        headers: authHeaders('owner-token'),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      syncedCount: 2,
      publicCount: 1,
      privateCount: 1,
    });
    fetchSpy.mockRestore();
  });

  it('approves discovered telegram destinations through the connector route', async () => {
    const res = await server.request(
      '/api/v1/channel-connectors/telegram/targets/approve',
      {
        method: 'POST',
        headers: {
          ...authHeaders('owner-token'),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetKind: 'chat',
          targetId: 'tg:chat:123',
          displayName: 'Gamemakers Chat',
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.target).toEqual(
      expect.objectContaining({
        target_id: 'tg:chat:123',
        approved: 1,
        registered_by: 'owner-1',
      }),
    );

    const filtered = await server.request(
      '/api/v1/channel-connections/channel-conn%3Atelegram%3Asystem/targets?approval=approved',
      {
        method: 'GET',
        headers: authHeaders('owner-token'),
      },
    );
    expect(filtered.status).toBe(200);
    const filteredBody = (await filtered.json()) as any;
    expect(filteredBody.data.targets).toEqual([
      expect.objectContaining({
        target_id: 'tg:chat:123',
        approved: 1,
      }),
    ]);
  });

  it('rejects talk channel bindings for unapproved targets', async () => {
    const res = await server.request('/api/v1/talks/talk-1/channels', {
      method: 'POST',
      headers: {
        ...authHeaders('owner-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        connectionId: 'channel-conn:telegram:system',
        targetKind: 'chat',
        targetId: 'tg:chat:123',
        displayName: 'Gamemakers Chat',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('target_not_approved');
  });

  it('allows Slack talk channel bindings for discovered targets without approval', async () => {
    const slackConnection = upsertChannelConnection({
      platform: 'slack',
      connectionMode: 'oauth_workspace',
      accountKey: 'slack:T123',
      displayName: 'KimFamily',
      enabled: true,
      healthStatus: 'healthy',
      config: {
        teamId: 'T123',
        teamName: 'KimFamily',
        teamUrl: 'kimfamily-co.slack.com',
      },
    });
    upsertChannelTarget({
      connectionId: slackConnection.id,
      targetKind: 'channel',
      targetId: 'slack:C123',
      displayName: '#family-ops',
      metadataJson: JSON.stringify({ isPrivate: false, isMember: true }),
    });

    const res = await server.request('/api/v1/talks/talk-1/channels', {
      method: 'POST',
      headers: {
        ...authHeaders('owner-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        connectionId: slackConnection.id,
        targetKind: 'channel',
        targetId: 'slack:C123',
        displayName: '#family-ops',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.binding).toEqual(
      expect.objectContaining({
        connectionId: slackConnection.id,
        platform: 'slack',
        targetId: 'slack:C123',
      }),
    );
  });

  it('rejects Slack talk channel bindings when the app is not in the channel', async () => {
    const slackConnection = upsertChannelConnection({
      platform: 'slack',
      connectionMode: 'oauth_workspace',
      accountKey: 'slack:T123',
      displayName: 'KimFamily',
      enabled: true,
      healthStatus: 'healthy',
      config: {
        teamId: 'T123',
        teamName: 'KimFamily',
        teamUrl: 'kimfamily-co.slack.com',
      },
    });
    upsertChannelTarget({
      connectionId: slackConnection.id,
      targetKind: 'channel',
      targetId: 'slack:C123',
      displayName: '#general',
      metadataJson: JSON.stringify({ isPrivate: false, isMember: false }),
    });

    const res = await server.request('/api/v1/talks/talk-1/channels', {
      method: 'POST',
      headers: {
        ...authHeaders('owner-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        connectionId: slackConnection.id,
        targetKind: 'channel',
        targetId: 'slack:C123',
        displayName: '#general',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('slack_target_not_joined');
  });

  it('returns channel occupancy metadata and pagination for Slack targets', async () => {
    const slackConnection = upsertChannelConnection({
      platform: 'slack',
      connectionMode: 'oauth_workspace',
      accountKey: 'slack:T123',
      displayName: 'KimFamily',
      enabled: true,
      healthStatus: 'healthy',
      config: {
        teamId: 'T123',
        teamName: 'KimFamily',
        teamUrl: 'kimfamily-co.slack.com',
      },
    });
    upsertChannelTarget({
      connectionId: slackConnection.id,
      targetKind: 'channel',
      targetId: 'slack:C123',
      displayName: '#family-ops',
      metadataJson: JSON.stringify({ isPrivate: false }),
    });
    upsertChannelTarget({
      connectionId: slackConnection.id,
      targetKind: 'channel',
      targetId: 'slack:C124',
      displayName: '#parents-council',
      metadataJson: JSON.stringify({ isPrivate: true }),
    });

    const created = await server.request('/api/v1/talks/talk-1/channels', {
      method: 'POST',
      headers: {
        ...authHeaders('owner-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        connectionId: slackConnection.id,
        targetKind: 'channel',
        targetId: 'slack:C123',
        displayName: '#family-ops',
      }),
    });
    expect(created.status).toBe(201);

    const res = await server.request(
      `/api/v1/channel-connections/${encodeURIComponent(slackConnection.id)}/targets?limit=1&offset=0`,
      {
        method: 'GET',
        headers: authHeaders('owner-token'),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.totalCount).toBe(2);
    expect(body.data.hasMore).toBe(true);
    expect(body.data.nextOffset).toBe(1);
    expect(body.data.targets[0]).toEqual(
      expect.objectContaining({
        connection_id: slackConnection.id,
        active_binding_talk_id: 'talk-1',
        active_binding_talk_title: 'Channels Route Test',
        active_binding_talk_accessible: 1,
      }),
    );
  });

  it('creates Slack bindings with instructions and a derived state namespace', async () => {
    const slackConnection = upsertChannelConnection({
      platform: 'slack',
      connectionMode: 'oauth_workspace',
      accountKey: 'slack:T123',
      displayName: 'KimFamily',
      enabled: true,
      healthStatus: 'healthy',
      config: {
        teamId: 'T123',
        teamName: 'KimFamily',
      },
    });
    upsertChannelTarget({
      connectionId: slackConnection.id,
      targetKind: 'channel',
      targetId: 'slack:C123',
      displayName: '#general',
      metadataJson: JSON.stringify({ isMember: true }),
    });

    const res = await server.request('/api/v1/talks/talk-1/channels', {
      method: 'POST',
      headers: {
        ...authHeaders('owner-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        connectionId: slackConnection.id,
        targetKind: 'channel',
        targetId: 'slack:C123',
        displayName: '#general',
        responseMode: 'mentions',
        timezone: 'America/New_York',
        instructions:
          'Reply briefly when mentioned. Keep binding-owned state under the provided namespace.',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.binding).toEqual(
      expect.objectContaining({
        responseMode: 'mentions',
        timezone: 'America/New_York',
        instructions:
          'Reply briefly when mentioned. Keep binding-owned state under the provided namespace.',
      }),
    );
    expect(body.data.binding.stateNamespace).toMatch(
      /^channel\.binding_[^.]+\.$/,
    );
  });

  it('accepts instructions on Telegram bindings without special behavior modes', async () => {
    upsertChannelTarget({
      connectionId: 'channel-conn:telegram:system',
      targetKind: 'chat',
      targetId: 'tg:chat:123',
      displayName: 'Gamemakers Chat',
      approved: true,
      metadataJson: null,
    });

    const res = await server.request('/api/v1/talks/talk-1/channels', {
      method: 'POST',
      headers: {
        ...authHeaders('owner-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        connectionId: 'channel-conn:telegram:system',
        targetKind: 'chat',
        targetId: 'tg:chat:123',
        displayName: 'Gamemakers Chat',
        timezone: 'America/Los_Angeles',
        instructions: 'Reply only on direct asks.',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.binding).toEqual(
      expect.objectContaining({
        platform: 'telegram',
        timezone: 'America/Los_Angeles',
        instructions: 'Reply only on direct asks.',
      }),
    );
  });

  it('returns a conflict when a Slack channel is already bound to another talk', async () => {
    const registeredAgent = createRegisteredAgent({
      name: 'Slack Agent',
      providerId: 'openai',
      modelId: 'gpt-5-mini',
    });
    upsertTalk({
      id: 'talk-2',
      ownerId: 'owner-1',
      topicTitle: 'Family Announcements',
    });
    setTalkAgents('talk-2', [
      {
        id: registeredAgent.id,
        sourceKind: 'provider',
        providerId: 'openai',
        modelId: 'gpt-5-mini',
        nickname: 'Slack Agent',
        nicknameMode: 'auto',
        personaRole: 'General',
        isPrimary: true,
        sortOrder: 0,
      },
    ]);
    const slackConnection = upsertChannelConnection({
      platform: 'slack',
      connectionMode: 'oauth_workspace',
      accountKey: 'slack:T123',
      displayName: 'KimFamily',
      enabled: true,
      healthStatus: 'healthy',
      config: {
        teamId: 'T123',
        teamName: 'KimFamily',
        teamUrl: 'kimfamily-co.slack.com',
      },
    });
    upsertChannelTarget({
      connectionId: slackConnection.id,
      targetKind: 'channel',
      targetId: 'slack:C123',
      displayName: '#family-ops',
      metadataJson: JSON.stringify({ isPrivate: false }),
    });

    const first = await server.request('/api/v1/talks/talk-2/channels', {
      method: 'POST',
      headers: {
        ...authHeaders('owner-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        connectionId: slackConnection.id,
        targetKind: 'channel',
        targetId: 'slack:C123',
        displayName: '#family-ops',
      }),
    });
    expect(first.status).toBe(201);

    const second = await server.request('/api/v1/talks/talk-1/channels', {
      method: 'POST',
      headers: {
        ...authHeaders('owner-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        connectionId: slackConnection.id,
        targetKind: 'channel',
        targetId: 'slack:C123',
        displayName: '#family-ops',
      }),
    });

    expect(second.status).toBe(409);
    const body = (await second.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('target_already_bound');
    expect(body.error.message).toContain('Family Announcements');
    expect(body.error.details).toEqual(
      expect.objectContaining({
        talkId: 'talk-2',
        talkTitle: 'Family Announcements',
      }),
    );
  });

  it('discovers Slack targets from the diagnostic route without approving them', async () => {
    const slackConnection = upsertChannelConnection({
      platform: 'slack',
      connectionMode: 'oauth_workspace',
      accountKey: 'slack:T123',
      displayName: 'KimFamily',
      enabled: true,
      healthStatus: 'healthy',
      config: {
        teamId: 'T123',
        teamName: 'KimFamily',
        teamUrl: 'kimfamily-co.slack.com',
      },
    });
    const diagnoseSpy = vi
      .spyOn(slackConnector, 'diagnoseSlackTarget')
      .mockResolvedValue({
        ok: true,
        code: 'ok',
        message: 'Found channel',
        target: {
          ok: true,
          targetKind: 'channel',
          targetId: 'slack:C123',
          displayName: '#family-ops',
          metadata: { isPrivate: false },
        },
      });

    const res = await server.request(
      `/api/v1/channel-connectors/slack/workspaces/${encodeURIComponent(slackConnection.id)}/diagnose-target`,
      {
        method: 'POST',
        headers: {
          ...authHeaders('owner-token'),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ rawInput: 'C123' }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.target.targetId).toBe('slack:C123');

    const listed = await server.request(
      `/api/v1/channel-connections/${encodeURIComponent(slackConnection.id)}/targets?approval=discovered`,
      {
        method: 'GET',
        headers: authHeaders('owner-token'),
      },
    );
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as any;
    expect(listedBody.data.targets).toEqual([
      expect.objectContaining({
        target_id: 'slack:C123',
        approved: 0,
      }),
    ]);

    diagnoseSpy.mockRestore();
  });

  it('deactivates existing bindings when a telegram target is unapproved', async () => {
    await server.request(
      '/api/v1/channel-connectors/telegram/targets/approve',
      {
        method: 'POST',
        headers: {
          ...authHeaders('owner-token'),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetKind: 'chat',
          targetId: 'tg:chat:123',
          displayName: 'Gamemakers Chat',
        }),
      },
    );

    const created = await server.request('/api/v1/talks/talk-1/channels', {
      method: 'POST',
      headers: {
        ...authHeaders('owner-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        connectionId: 'channel-conn:telegram:system',
        targetKind: 'chat',
        targetId: 'tg:chat:123',
        displayName: 'Gamemakers Chat',
      }),
    });
    expect(created.status).toBe(201);

    const removed = await server.request(
      '/api/v1/channel-connectors/telegram/targets/chat/tg%3Achat%3A123/approval',
      {
        method: 'DELETE',
        headers: authHeaders('owner-token'),
      },
    );
    expect(removed.status).toBe(200);
    const removedBody = (await removed.json()) as any;
    expect(removedBody.data.deactivatedBindingCount).toBe(1);

    const bindings = await server.request('/api/v1/talks/talk-1/channels', {
      method: 'GET',
      headers: authHeaders('owner-token'),
    });
    expect(bindings.status).toBe(200);
    const bindingsBody = (await bindings.json()) as any;
    expect(bindingsBody.data.bindings).toEqual([
      expect.objectContaining({
        targetId: 'tg:chat:123',
        active: false,
      }),
    ]);
  });

  it('passes the validated bot identity through to the reload callback when saving a token', async () => {
    const validatedBot = {
      botUserId: 12345,
      botUsername: 'clawtalk_bot',
      botDisplayName: 'ClawTalk',
      canJoinGroups: true,
    };
    const probeSpy = vi
      .spyOn(telegramConnector, 'probeTelegramBotToken')
      .mockResolvedValue(validatedBot);
    const reloadConnector = vi.fn().mockResolvedValue(undefined);

    const result = await saveTelegramChannelConnectorTokenRoute({
      auth: {
        sessionId: 's-owner',
        userId: 'owner-1',
        role: 'owner',
        authType: 'bearer',
      },
      botToken: '12345:AAATESTTOKEN',
      reloadConnector,
    });

    expect(result.statusCode).toBe(200);
    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(reloadConnector).toHaveBeenCalledWith({
      validatedBot,
    });
  });
});
