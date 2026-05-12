import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { DataConnectorsPage } from './DataConnectorsPage';
import type { ChannelConnection, ChannelTarget, DataConnector } from '../lib/api';

vi.mock('../lib/slackInstallPopup', () => ({
  launchSlackInstallPopup: vi.fn(async () => undefined),
}));

describe('DataConnectorsPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders connectors and creates a new PostHog connector', async () => {
    const user = userEvent.setup();
    installDataConnectorsFetch();

    render(
      <MemoryRouter initialEntries={['/app/connectors']}>
        <DataConnectorsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Connectors' });
    expect(screen.getByText('FTUE PostHog')).toBeTruthy();

    const addCard = screen
      .getByRole('heading', { name: 'Add Connector' })
      .closest('article');
    if (!addCard) {
      throw new Error('Expected Add Connector card');
    }

    await user.clear(within(addCard).getByLabelText('Name'));
    await user.type(within(addCard).getByLabelText('Name'), 'Economy PostHog');
    await user.click(
      within(addCard).getByRole('button', { name: 'Create Connector' }),
    );

    expect(await screen.findByText('Economy PostHog')).toBeTruthy();
    expect(screen.getByText('Economy PostHog connector created.')).toBeTruthy();
  });

  it('renders Docs-specific labels and creates a new Google Docs connector', async () => {
    const user = userEvent.setup();
    installDataConnectorsFetch();

    render(
      <MemoryRouter initialEntries={['/app/connectors']}>
        <DataConnectorsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Connectors' });
    const addCard = screen
      .getByRole('heading', { name: 'Add Connector' })
      .closest('article');
    if (!addCard) {
      throw new Error('Expected Add Connector card');
    }

    await user.selectOptions(within(addCard).getByLabelText('Kind'), 'google_docs');
    expect(within(addCard).getByLabelText('Document ID')).toBeTruthy();
    expect(within(addCard).getByLabelText('Document URL')).toBeTruthy();

    await user.clear(within(addCard).getByLabelText('Name'));
    await user.type(
      within(addCard).getByLabelText('Name'),
      'Depth Chart Doc',
    );
    await user.type(
      within(addCard).getByLabelText('Document ID'),
      'doc-depth-chart',
    );
    await user.type(
      within(addCard).getByLabelText('Document URL'),
      'https://docs.google.com/document/d/doc-depth-chart/edit',
    );
    await user.click(
      within(addCard).getByRole('button', { name: 'Create Connector' }),
    );

    expect(await screen.findByText('Depth Chart Doc')).toBeTruthy();
    expect(screen.getByText('Depth Chart Doc connector created.')).toBeTruthy();
  });

  it('saves a credential and deletes a connector', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    installDataConnectorsFetch();

    render(
      <MemoryRouter initialEntries={['/app/connectors']}>
        <DataConnectorsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Connectors' });
    const connectorCard = screen
      .getByRole('heading', { name: 'FTUE PostHog' })
      .closest('article');
    if (!connectorCard) {
      throw new Error('Expected FTUE PostHog card');
    }

    await user.type(
      within(connectorCard).getByLabelText('PostHog API Key'),
      'phc_new_key',
    );
    await user.click(
      within(connectorCard).getByRole('button', { name: 'Save API Key' }),
    );
    expect(
      await screen.findByText('FTUE PostHog credential saved.'),
    ).toBeTruthy();

    await user.click(
      within(connectorCard).getByRole('button', { name: 'Delete' }),
    );
    expect(
      await screen.findByText('FTUE PostHog connector deleted.'),
    ).toBeTruthy();
    expect(screen.queryByText('FTUE PostHog')).toBeNull();
  });

  it('saves a Google Sheets connector from the linked Google account', async () => {
    const user = userEvent.setup();
    installDataConnectorsFetch({
      googleAccount: {
        connected: true,
        email: 'owner@example.com',
        displayName: 'Owner',
        scopes: ['spreadsheets.readonly'],
        accessExpiresAt: null,
      },
      connectors: [
        {
          id: 'connector-sheets',
          name: 'Live Ops Sheet',
          connectorKind: 'google_sheets',
          config: {
            spreadsheetId: 'sheet-1',
            spreadsheetUrl:
              'https://docs.google.com/spreadsheets/d/sheet-1/edit',
          },
          discovered: null,
          enabled: true,
          hasCredential: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          attachedTalkCount: 1,
          createdAt: '2026-03-06T00:00:00.000Z',
          updatedAt: '2026-03-06T00:00:00.000Z',
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/app/connectors']}>
        <DataConnectorsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Connectors' });
    const connectorCard = screen
      .getByRole('heading', { name: 'Live Ops Sheet' })
      .closest('article');
    if (!connectorCard) {
      throw new Error('Expected Live Ops Sheet card');
    }

    expect(
      within(connectorCard).getByText('Connected as owner@example.com'),
    ).toBeTruthy();

    await user.click(
      within(connectorCard).getByRole('button', {
        name: 'Use Linked Google Account',
      }),
    );

    expect(
      await screen.findByText(
        'Live Ops Sheet credential saved from owner@example.com.',
      ),
    ).toBeTruthy();
  });

  it('saves a Google Docs connector from the linked Google account', async () => {
    const user = userEvent.setup();
    installDataConnectorsFetch({
      googleAccount: {
        connected: true,
        email: 'owner@example.com',
        displayName: 'Owner',
        scopes: ['documents'],
        accessExpiresAt: null,
      },
      connectors: [
        {
          id: 'connector-docs',
          name: 'Season Preview Doc',
          connectorKind: 'google_docs',
          config: {
            documentId: 'doc-1',
            documentUrl: 'https://docs.google.com/document/d/doc-1/edit',
          },
          discovered: null,
          enabled: true,
          hasCredential: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          attachedTalkCount: 0,
          createdAt: '2026-03-06T00:00:00.000Z',
          updatedAt: '2026-03-06T00:00:00.000Z',
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/app/connectors']}>
        <DataConnectorsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Connectors' });
    const connectorCard = screen
      .getByRole('heading', { name: 'Season Preview Doc' })
      .closest('article');
    if (!connectorCard) {
      throw new Error('Expected Season Preview Doc card');
    }

    expect(
      within(connectorCard).getByText('Connected as owner@example.com'),
    ).toBeTruthy();

    await user.click(
      within(connectorCard).getByRole('button', {
        name: 'Use Linked Google Account',
      }),
    );

    expect(
      await screen.findByText(
        'Season Preview Doc credential saved from owner@example.com.',
      ),
    ).toBeTruthy();
  });

  it('renders the Telegram connector on the Channel Connectors tab', async () => {
    installDataConnectorsFetch();

    render(
      <MemoryRouter initialEntries={['/app/connectors?tab=channel-connectors']}>
        <DataConnectorsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Connectors' });
    expect(
      await screen.findByRole('heading', { name: 'Connect Telegram Bot' }),
    ).toBeTruthy();
    expect(screen.getByText('Managed by environment')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Adopt into ClawTalk' }),
    ).toBeTruthy();
  });

  it('renders the Slack connector and saves Slack app config', async () => {
    const user = userEvent.setup();
    installDataConnectorsFetch();

    render(
      <MemoryRouter initialEntries={['/app/connectors?tab=channel-connectors']}>
        <DataConnectorsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Connect Slack App' });
    expect(
      screen.getByText((value) => value.includes('Events API status: Not ready')),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Install to Workspace' }),
    ).toBeDisabled();

    await user.type(screen.getByLabelText('Client ID'), '123456.7890');
    await user.type(screen.getByLabelText('Client Secret'), 'secret-1');
    await user.type(screen.getByLabelText('Signing Secret'), 'signing-1');
    await user.click(screen.getByRole('button', { name: 'Save Slack App' }));

    expect(
      await screen.findByText('Slack app configuration saved.'),
    ).toBeTruthy();
    expect(
      screen.getByText((value) => value.includes('Events API status: Ready')),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Install to Workspace' }),
    ).not.toBeDisabled();
    expect(screen.getByText('Acme Workspace')).toBeTruthy();
  });

  it('preserves unsaved Slack app drafts across background refreshes', async () => {
    const user = userEvent.setup();
    let intervalCallback: (() => void) | null = null;
    vi.spyOn(window, 'setInterval').mockImplementation(
      ((callback: TimerHandler) => {
        intervalCallback =
          typeof callback === 'function'
            ? (callback as () => void)
            : intervalCallback;
        return 1 as unknown as number;
      }) as typeof window.setInterval,
    );
    vi.spyOn(window, 'clearInterval').mockImplementation(() => {});
    installDataConnectorsFetch();

    render(
      <MemoryRouter initialEntries={['/app/connectors?tab=channel-connectors']}>
        <DataConnectorsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Connect Slack App' });

    const clientIdInput = screen.getByLabelText('Client ID');
    await user.type(clientIdInput, '123456.7890');
    expect(clientIdInput).toHaveValue('123456.7890');

    await act(async () => {
      await intervalCallback?.();
    });

    expect(screen.getByLabelText('Client ID')).toHaveValue('123456.7890');
  });

  it('shows synced Slack channels in the connectors inventory without requiring approval', async () => {
    installDataConnectorsFetch();

    render(
      <MemoryRouter initialEntries={['/app/connectors?tab=channel-connectors']}>
        <DataConnectorsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Connected Workspaces' });
    expect(await screen.findByText('#product-launch')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Synced Channels' })).toBeTruthy();
    expect(screen.getByText('Available')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});

function installDataConnectorsFetch(input?: {
  connectors?: DataConnector[];
  googleAccount?: {
    connected: boolean;
    email: string | null;
    displayName: string | null;
    scopes: string[];
    accessExpiresAt: string | null;
  };
  slackWorkspaces?: ChannelConnection[];
  slackTargetsByConnection?: Record<string, ChannelTarget[]>;
}) {
  let connectors: DataConnector[] = input?.connectors || [
    {
      id: 'connector-posthog',
      name: 'FTUE PostHog',
      connectorKind: 'posthog',
      config: {
        hostUrl: 'https://us.posthog.com',
        projectId: '12345',
      },
      discovered: null,
      enabled: true,
      hasCredential: true,
      verificationStatus: 'not_verified',
      lastVerifiedAt: null,
      lastVerificationError: null,
      attachedTalkCount: 2,
      createdAt: '2026-03-06T00:00:00.000Z',
      updatedAt: '2026-03-06T00:00:00.000Z',
    },
  ];
  let googleAccount = input?.googleAccount || {
    connected: false,
    email: null,
    displayName: null,
    scopes: [],
    accessExpiresAt: null,
  };
  let telegramConnector = {
    connection: {
      id: 'channel-conn:telegram:system',
      platform: 'telegram',
      connection_mode: 'system_managed',
      account_key: 'telegram:system',
      display_name: 'Telegram (System Managed)',
      enabled: 1,
      health_status: 'healthy',
      last_health_check_at: '2026-03-06T00:00:00.000Z',
      last_health_error: null,
      config_json: JSON.stringify({
        managedBy: 'runtime',
        platform: 'telegram',
        botUsername: 'clawtalk_bot',
        botDisplayName: 'ClawTalk',
      }),
      token_source: 'env',
      env_token_available: 1,
      has_stored_secret: 0,
      created_at: '2026-03-06T00:00:00.000Z',
      updated_at: '2026-03-06T00:00:00.000Z',
    },
    targets: [],
  };
  let slackConfig = {
    clientId: null as string | null,
    hasClientSecret: false,
    hasSigningSecret: false,
    redirectUrl: 'https://clawtalk.app/api/v1/channel-connectors/slack/oauth/callback',
    eventsApiUrl: null as string | null,
    eventsApiReady: false,
    oauthInstallReady: false,
    available: true,
    availabilityReason: null as string | null,
    updatedAt: null as string | null,
    updatedBy: null as string | null,
  };
  let slackWorkspaces: ChannelConnection[] =
    input?.slackWorkspaces || [
      {
        id: 'channel-conn:slack:acme',
        platform: 'slack',
        connectionMode: 'oauth_workspace',
        accountKey: 'slack:T123',
        displayName: 'Acme Workspace',
        enabled: true,
        healthStatus: 'healthy',
        lastHealthCheckAt: '2026-03-06T00:00:00.000Z',
        lastHealthError: null,
        config: {
          teamId: 'T123',
          teamUrl: 'acme.slack.com',
          botUserId: 'U999',
        },
        tokenSource: 'db',
        envTokenAvailable: false,
        hasStoredSecret: true,
        createdAt: '2026-03-06T00:00:00.000Z',
        updatedAt: '2026-03-06T00:00:00.000Z',
      },
    ];
  let slackTargetsByConnection: Record<string, ChannelTarget[]> =
    input?.slackTargetsByConnection || {
      'channel-conn:slack:acme': [
        {
          connectionId: 'channel-conn:slack:acme',
          targetKind: 'channel',
          targetId: 'slack:C123',
          displayName: '#product-launch',
          metadata: {
            channelName: 'product-launch',
            isPrivate: true,
          },
          approved: false,
          registeredAt: null,
          registeredBy: null,
          lastSeenAt: '2026-03-06T00:00:00.000Z',
          createdAt: '2026-03-06T00:00:00.000Z',
          updatedAt: '2026-03-06T00:00:00.000Z',
        },
      ],
    };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof request === 'string'
          ? request
          : request instanceof URL
            ? request.toString()
            : request instanceof Request
              ? request.url
              : String(request);
      const method = init?.method || 'GET';

      if (url.endsWith('/api/v1/data-connectors') && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { connectors },
        });
      }

      if (url.endsWith('/api/v1/me/google-account') && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { googleAccount },
        });
      }

      if (url.endsWith('/api/v1/channel-connectors/telegram') && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: telegramConnector,
        });
      }

      if (url.endsWith('/api/v1/channel-connectors/slack') && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: {
            config: slackConfig,
            workspaces: slackWorkspaces.map(toChannelConnectionApiRecord),
          },
        });
      }

      if (url.endsWith('/api/v1/channel-connectors/slack/config') && method === 'PUT') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          clientId?: string;
          clientSecret?: string;
          signingSecret?: string;
        };
        const hasClientSecret =
          Boolean(body.clientSecret?.trim()) || slackConfig.hasClientSecret;
        const hasSigningSecret =
          Boolean(body.signingSecret?.trim()) || slackConfig.hasSigningSecret;
        slackConfig = {
          ...slackConfig,
          clientId: body.clientId?.trim() || null,
          hasClientSecret,
          hasSigningSecret,
          eventsApiUrl: hasSigningSecret
            ? 'https://clawtalk.app/api/v1/channel-connectors/slack/events'
            : null,
          eventsApiReady: hasSigningSecret,
          oauthInstallReady:
            Boolean(body.clientId?.trim()) && hasClientSecret && hasSigningSecret,
          updatedAt: '2026-03-06T01:00:00.000Z',
          updatedBy: 'owner-1',
        };
        return jsonResponse(200, {
          ok: true,
          data: {
            config: slackConfig,
            workspaces: slackWorkspaces.map(toChannelConnectionApiRecord),
          },
        });
      }

      if (url.endsWith('/api/v1/channel-connectors/slack/config') && method === 'DELETE') {
        slackConfig = {
          ...slackConfig,
          clientId: null,
          hasClientSecret: false,
          hasSigningSecret: false,
          eventsApiUrl: null,
          eventsApiReady: false,
          oauthInstallReady: false,
          updatedAt: '2026-03-06T01:00:00.000Z',
          updatedBy: 'owner-1',
        };
        return jsonResponse(200, {
          ok: true,
          data: {
            config: slackConfig,
            workspaces: slackWorkspaces.map(toChannelConnectionApiRecord),
          },
        });
      }

      if (
        url.includes('/api/v1/channel-connections/') &&
        url.includes('/targets') &&
        method === 'GET'
      ) {
        const connectionId = decodeURIComponent(
          url.split('/api/v1/channel-connections/')[1]?.split('/targets')[0] ||
            '',
        );
        const parsed = new URL(url, 'http://localhost');
        const approval = parsed.searchParams.get('approval');
        let targets = slackTargetsByConnection[connectionId] || [];
        if (approval === 'approved') {
          targets = targets.filter((target) => target.approved);
        } else if (approval === 'discovered') {
          targets = targets.filter((target) => !target.approved);
        }
        return jsonResponse(200, {
          ok: true,
          data: {
            targets: targets.map(toChannelTargetApiRecord),
            totalCount: targets.length,
            hasMore: false,
            nextOffset: null,
          },
        });
      }

      if (
        url.includes('/api/v1/channel-connections/') &&
        url.endsWith('/targets/approve') &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body || '{}')) as {
          connectionId: string;
          targetKind: string;
          targetId: string;
          displayName?: string;
          metadata?: Record<string, unknown> | null;
        };
        const targets = slackTargetsByConnection[body.connectionId] || [];
        const updatedTarget: ChannelTarget = {
          connectionId: body.connectionId,
          targetKind: body.targetKind,
          targetId: body.targetId,
          displayName: body.displayName || body.targetId,
          metadata: body.metadata || null,
          approved: true,
          registeredAt: '2026-03-06T01:15:00.000Z',
          registeredBy: 'owner-1',
          lastSeenAt: '2026-03-06T00:00:00.000Z',
          createdAt: '2026-03-06T00:00:00.000Z',
          updatedAt: '2026-03-06T01:15:00.000Z',
        };
        slackTargetsByConnection[body.connectionId] = [
          ...targets.filter((target) => target.targetId !== body.targetId),
          updatedTarget,
        ];
        return jsonResponse(200, {
          ok: true,
          data: {
            target: toChannelTargetApiRecord(updatedTarget),
          },
        });
      }

      if (
        url.includes('/api/v1/channel-connections/') &&
        url.includes('/approval') &&
        method === 'DELETE'
      ) {
        const connectionId = decodeURIComponent(
          url.split('/api/v1/channel-connections/')[1]?.split('/targets/')[0] ||
            '',
        );
        const targetPath = url.split('/targets/')[1]?.split('/approval')[0] || '';
        const [, targetId] = targetPath.split('/').map((segment) =>
          decodeURIComponent(segment),
        );
        slackTargetsByConnection[connectionId] = (
          slackTargetsByConnection[connectionId] || []
        ).map((target) =>
          target.targetId === targetId
            ? {
                ...target,
                approved: false,
                registeredAt: null,
                registeredBy: null,
                updatedAt: '2026-03-06T01:20:00.000Z',
              }
            : target,
        );
        return jsonResponse(200, {
          ok: true,
          data: { removed: true, deactivatedBindingCount: 0 },
        });
      }

      if (url.endsWith('/api/v1/data-connectors') && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          name: string;
          connectorKind: DataConnector['connectorKind'];
          config?: Record<string, unknown>;
          enabled?: boolean;
        };
        const created: DataConnector = {
          id: `connector-${connectors.length + 1}`,
          name: body.name,
          connectorKind: body.connectorKind,
          config: body.config || {},
          discovered: null,
          enabled: body.enabled !== false,
          hasCredential: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          attachedTalkCount: 0,
          createdAt: '2026-03-06T01:00:00.000Z',
          updatedAt: '2026-03-06T01:00:00.000Z',
        };
        connectors = [created, ...connectors];
        return jsonResponse(201, {
          ok: true,
          data: { connector: created },
        });
      }

      if (
        url.includes('/api/v1/data-connectors/') &&
        url.endsWith('/credential') &&
        method === 'PUT'
      ) {
        const connectorId = url
          .split('/api/v1/data-connectors/')[1]
          ?.split('/credential')[0];
        const body = JSON.parse(String(init?.body || '{}')) as {
          apiKey?: string | null;
          useGoogleAccount?: boolean;
          clearCredential?: boolean;
        };
        connectors = connectors.map((connector) =>
          connector.id === connectorId
            ? {
                ...connector,
                hasCredential: body.clearCredential
                  ? false
                  : body.useGoogleAccount
                    ? true
                    : Boolean(body.apiKey),
                verificationStatus: body.clearCredential
                  ? 'missing'
                  : body.useGoogleAccount || body.apiKey
                    ? 'not_verified'
                    : 'missing',
                updatedAt: '2026-03-06T02:00:00.000Z',
              }
            : connector,
        );
        const updated = connectors.find(
          (connector) => connector.id === connectorId,
        );
        return jsonResponse(200, {
          ok: true,
          data: { connector: updated },
        });
      }

      if (url.includes('/api/v1/data-connectors/') && method === 'DELETE') {
        const connectorId = url.split('/api/v1/data-connectors/')[1];
        connectors = connectors.filter(
          (connector) => connector.id !== connectorId,
        );
        return jsonResponse(200, {
          ok: true,
          data: { deleted: true },
        });
      }

      throw new Error(`Unhandled request: ${method} ${url}`);
    }),
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function toChannelConnectionApiRecord(connection: ChannelConnection) {
  return {
    id: connection.id,
    platform: connection.platform,
    connection_mode: connection.connectionMode,
    account_key: connection.accountKey,
    display_name: connection.displayName,
    enabled: connection.enabled ? 1 : 0,
    health_status: connection.healthStatus,
    last_health_check_at: connection.lastHealthCheckAt,
    last_health_error: connection.lastHealthError,
    config_json: connection.config ? JSON.stringify(connection.config) : null,
    token_source: connection.tokenSource,
    env_token_available: connection.envTokenAvailable ? 1 : 0,
    has_stored_secret: connection.hasStoredSecret ? 1 : 0,
    created_at: connection.createdAt,
    updated_at: connection.updatedAt,
  };
}

function toChannelTargetApiRecord(target: ChannelTarget) {
  return {
    connection_id: target.connectionId,
    target_kind: target.targetKind,
    target_id: target.targetId,
    display_name: target.displayName,
    metadata_json: target.metadata ? JSON.stringify(target.metadata) : null,
    approved: target.approved ? 1 : 0,
    registered_at: target.registeredAt,
    registered_by: target.registeredBy,
    last_seen_at: target.lastSeenAt,
    created_at: target.createdAt,
    updated_at: target.updatedAt,
    active_binding_id: target.activeBindingId ?? null,
    active_binding_talk_id: target.activeBindingTalkId ?? null,
    active_binding_talk_title: target.activeBindingTalkTitle ?? null,
    active_binding_talk_accessible: target.activeBindingTalkAccessible ? 1 : 0,
  };
}
