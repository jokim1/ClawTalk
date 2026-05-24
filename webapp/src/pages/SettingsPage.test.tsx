import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { SettingsPage } from './SettingsPage';
import type {
  AgentProviderCard,
  AiAgentsPageData,
  RegisteredAgent,
  SessionUser,
} from '../lib/api';

describe('SettingsPage', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('defaults to the Profile section and shows the display-name editor', async () => {
    installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'My Profile' });
    expect(
      screen.getByRole('heading', { name: 'Personal Information' }),
    ).toBeTruthy();
  });

  it('opens the API Keys tab via ?tab=api-keys and renders both Workspace and Personal sections', async () => {
    installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=api-keys']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Workspace API Keys' });
    expect(
      screen.getByRole('heading', { name: 'Personal API Keys' }),
    ).toBeTruthy();
    // One card per provider in each section, so four providers means
    // eight cards total.
    expect(
      screen.getAllByRole('heading', { name: 'Claude (Anthropic)' }),
    ).toHaveLength(2);

    const anthropicCards = screen
      .getAllByRole('heading', { name: 'Claude (Anthropic)' })
      .map((heading) => heading.closest('article'))
      .filter((node): node is HTMLElement => node !== null);
    expect(anthropicCards).toHaveLength(2);
    for (const card of anthropicCards) {
      expect(within(card).getByPlaceholderText('sk-ant-...')).toBeTruthy();
      expect(
        within(card).getByRole('link', {
          name: /Get key from Anthropic Console/i,
        }),
      ).toBeTruthy();
    }
  });

  it('saves a Personal API key with scope=user', async () => {
    const user = userEvent.setup();
    const helpers = installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=api-keys']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Personal API Keys' });
    const personalSection = screen
      .getByRole('heading', { name: 'Personal API Keys' })
      .closest('section');
    if (!personalSection) throw new Error('Personal section not found');
    const anthropicCard = within(personalSection)
      .getByRole('heading', { name: 'Claude (Anthropic)' })
      .closest('article');
    if (!anthropicCard) throw new Error('Anthropic card not found');

    const input = within(anthropicCard).getByPlaceholderText('sk-ant-...');
    await user.type(input, 'sk-ant-test-key');
    await user.click(
      within(anthropicCard).getByRole('button', { name: 'Save' }),
    );

    expect(
      await screen.findByText(/Claude \(Anthropic\) credential saved\./),
    ).toBeTruthy();
    const calls = helpers.getProviderSaveCalls('provider.anthropic');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      providerId: 'provider.anthropic',
      apiKey: 'sk-ant-test-key',
      scope: 'user',
    });
  });

  it('saves a Workspace API key with scope=workspace as an admin', async () => {
    const user = userEvent.setup();
    const helpers = installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=api-keys']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Workspace API Keys' });
    const workspaceSection = screen
      .getByRole('heading', { name: 'Workspace API Keys' })
      .closest('section');
    if (!workspaceSection) throw new Error('Workspace section not found');
    const anthropicCard = within(workspaceSection)
      .getByRole('heading', { name: 'Claude (Anthropic)' })
      .closest('article');
    if (!anthropicCard) throw new Error('Anthropic card not found');

    const input = within(anthropicCard).getByPlaceholderText('sk-ant-...');
    await user.type(input, 'sk-ant-workspace-key');
    await user.click(
      within(anthropicCard).getByRole('button', { name: 'Save' }),
    );

    expect(
      await screen.findByText(
        /Claude \(Anthropic\) workspace credential saved\./,
      ),
    ).toBeTruthy();
    const calls = helpers.getProviderSaveCalls('provider.anthropic');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      providerId: 'provider.anthropic',
      apiKey: 'sk-ant-workspace-key',
      scope: 'workspace',
    });
  });

  it('opens the Agents tab and lists registered agents from the panel', async () => {
    installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=agents']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Registered Agents' });
    // Agent cards + the Main Agent section render after the async agents
    // fetch completes; the panel heading shows up first while the rest is
    // still loading, so wait for both pieces explicitly.
    expect(await screen.findByText('Claude Main')).toBeTruthy();
    expect(
      await screen.findByRole('heading', { name: 'Main Agent' }),
    ).toBeTruthy();
  });
});

function installSettingsFetch() {
  let snapshot = buildAiAgentsData();
  let registeredAgents = buildRegisteredAgents();
  let mainAgent: RegisteredAgent | null = registeredAgents[0] ?? null;
  const providerSaveCalls: Record<
    string,
    Array<{
      providerId: string;
      apiKey: string | null;
      scope: 'user' | 'workspace';
    }>
  > = {};

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

      if (url.endsWith('/api/v1/agents') && method === 'GET') {
        return jsonResponse(200, { ok: true, data: snapshot });
      }

      if (url.endsWith('/api/v1/registered-agents') && method === 'GET') {
        return jsonResponse(200, { ok: true, data: registeredAgents });
      }

      if (url.endsWith('/api/v1/registered-agents/main') && method === 'GET') {
        if (!mainAgent) {
          return jsonResponse(404, {
            ok: false,
            error: { code: 'not_found', message: 'No main agent' },
          });
        }
        return jsonResponse(200, { ok: true, data: mainAgent });
      }

      const providerSaveMatch = url.match(
        /\/api\/v1\/agents\/providers\/([^/?]+)$/,
      );
      if (providerSaveMatch && method === 'PUT') {
        const providerId = decodeURIComponent(providerSaveMatch[1]);
        const body = JSON.parse(String(init?.body || '{}')) as {
          providerId: string;
          apiKey: string | null;
          scope?: 'user' | 'workspace';
        };
        const scope = body.scope ?? 'user';
        providerSaveCalls[providerId] = providerSaveCalls[providerId] || [];
        providerSaveCalls[providerId].push({
          providerId: body.providerId,
          apiKey: body.apiKey,
          scope,
        });

        let next: AgentProviderCard | null = null;
        snapshot = {
          ...snapshot,
          additionalProviders: snapshot.additionalProviders.map((entry) => {
            if (entry.id !== providerId) return entry;
            if (scope === 'workspace') {
              next = {
                ...entry,
                workspaceHasCredential: body.apiKey !== null,
                workspaceCredentialHint: body.apiKey ? '••••test' : null,
                workspaceVerificationStatus: body.apiKey
                  ? 'verified'
                  : 'missing',
                workspaceLastVerifiedAt: body.apiKey
                  ? '2026-05-16T12:00:00.000Z'
                  : null,
                workspaceLastVerificationError: null,
              };
            } else {
              next = {
                ...entry,
                hasCredential: body.apiKey !== null,
                credentialHint: body.apiKey ? '••••test' : null,
                verificationStatus: body.apiKey ? 'verified' : 'missing',
                lastVerifiedAt: body.apiKey ? '2026-05-16T12:00:00.000Z' : null,
                lastVerificationError: null,
              };
            }
            return next;
          }),
        };
        return jsonResponse(200, { ok: true, data: { provider: next } });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }),
  );

  return {
    getProviderSaveCalls: (providerId: string) =>
      providerSaveCalls[providerId] || [],
  };
}

function buildSessionUser(overrides?: Partial<SessionUser>): SessionUser {
  return {
    id: 'user-1',
    email: 'owner@example.com',
    displayName: 'Owner',
    role: 'owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildAiAgentsData(): AiAgentsPageData {
  return {
    defaultClaudeModelId: 'claude-sonnet-4-6',
    claudeModelSuggestions: [
      {
        modelId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 8192,
      },
    ],
    additionalProviders: [
      {
        id: 'provider.anthropic',
        name: 'Claude (Anthropic)',
        providerKind: 'anthropic',
        credentialMode: 'api_key',
        apiFormat: 'anthropic_messages',
        baseUrl: 'https://api.anthropic.com',
        authScheme: 'x_api_key',
        enabled: true,
        hasCredential: false,
        credentialHint: null,
        verificationStatus: 'missing',
        lastVerifiedAt: null,
        lastVerificationError: null,
        workspaceHasCredential: false,
        workspaceCredentialHint: null,
        workspaceVerificationStatus: 'missing',
        workspaceLastVerifiedAt: null,
        workspaceLastVerificationError: null,
        hasPersonalSubscription: false,
        personalSubscriptionExpiresAt: null,
        hasWorkspaceSubscription: false,
        workspaceSubscriptionExpiresAt: null,
        modelSuggestions: [
          {
            modelId: 'claude-sonnet-4-6',
            displayName: 'Claude Sonnet 4.6',
            contextWindowTokens: 200000,
            defaultMaxOutputTokens: 8192,
          },
        ],
      },
      {
        id: 'provider.openai',
        name: 'OpenAI',
        providerKind: 'openai',
        credentialMode: 'api_key',
        apiFormat: 'openai_chat_completions',
        baseUrl: 'https://api.openai.com/v1',
        authScheme: 'bearer',
        enabled: true,
        hasCredential: false,
        credentialHint: null,
        verificationStatus: 'missing',
        lastVerifiedAt: null,
        lastVerificationError: null,
        workspaceHasCredential: false,
        workspaceCredentialHint: null,
        workspaceVerificationStatus: 'missing',
        workspaceLastVerifiedAt: null,
        workspaceLastVerificationError: null,
        hasPersonalSubscription: false,
        personalSubscriptionExpiresAt: null,
        hasWorkspaceSubscription: false,
        workspaceSubscriptionExpiresAt: null,
        modelSuggestions: [
          {
            modelId: 'gpt-5-mini',
            displayName: 'GPT-5 Mini',
            contextWindowTokens: 128000,
            defaultMaxOutputTokens: 4096,
          },
        ],
      },
      {
        id: 'provider.gemini',
        name: 'Google / Gemini',
        providerKind: 'gemini',
        credentialMode: 'api_key',
        apiFormat: 'openai_chat_completions',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        authScheme: 'bearer',
        enabled: true,
        hasCredential: false,
        credentialHint: null,
        verificationStatus: 'missing',
        lastVerifiedAt: null,
        lastVerificationError: null,
        workspaceHasCredential: false,
        workspaceCredentialHint: null,
        workspaceVerificationStatus: 'missing',
        workspaceLastVerifiedAt: null,
        workspaceLastVerificationError: null,
        hasPersonalSubscription: false,
        personalSubscriptionExpiresAt: null,
        hasWorkspaceSubscription: false,
        workspaceSubscriptionExpiresAt: null,
        modelSuggestions: [
          {
            modelId: 'gemini-2.5-flash',
            displayName: 'Gemini 2.5 Flash',
            contextWindowTokens: 1000000,
            defaultMaxOutputTokens: 8192,
          },
        ],
      },
      {
        id: 'provider.nvidia',
        name: 'NVIDIA Kimi2.5',
        providerKind: 'nvidia',
        credentialMode: 'api_key',
        apiFormat: 'openai_chat_completions',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        authScheme: 'bearer',
        enabled: true,
        hasCredential: false,
        credentialHint: null,
        verificationStatus: 'missing',
        lastVerifiedAt: null,
        lastVerificationError: null,
        workspaceHasCredential: false,
        workspaceCredentialHint: null,
        workspaceVerificationStatus: 'missing',
        workspaceLastVerifiedAt: null,
        workspaceLastVerificationError: null,
        hasPersonalSubscription: false,
        personalSubscriptionExpiresAt: null,
        hasWorkspaceSubscription: false,
        workspaceSubscriptionExpiresAt: null,
        modelSuggestions: [
          {
            modelId: 'moonshotai/kimi-k2.6',
            displayName: 'Kimi 2.6 (NVIDIA)',
            contextWindowTokens: 262144,
            defaultMaxOutputTokens: 16384,
          },
        ],
      },
    ],
  };
}

function buildRegisteredAgents(): RegisteredAgent[] {
  return [
    {
      id: 'agent-main',
      name: 'Claude Main',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissions: { web: true },
      personaRole: 'assistant',
      systemPrompt: null,
      description: null,
      enabled: true,
      createdAt: '2026-03-06T00:00:00.000Z',
      updatedAt: '2026-03-06T00:00:00.000Z',
      executionPreview: {
        surface: 'main',
        backend: 'direct_http',
        authPath: 'api_key',
        selectedMode: 'api',
        transport: 'direct',
        reasonCode: null,
        routeReason: 'normal',
        ready: true,
        message: 'Main will use Anthropic direct HTTP with an API key.',
      },
    },
  ];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ─── GoogleAccountSection (PR1, flag-gated) ─────────────────────────

describe('GoogleAccountSection (flag-gated)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function installToolsFetch(opts: { connected: boolean }) {
    const account = opts.connected
      ? {
          connected: true,
          email: 'tester@example.com',
          displayName: 'Tester',
          scopes: ['drive.readonly', 'documents'],
          accessExpiresAt: '2026-12-31T00:00:00.000Z',
        }
      : {
          connected: false,
          email: null,
          displayName: null,
          scopes: [],
          accessExpiresAt: null,
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

        if (url.endsWith('/api/v1/agents') && method === 'GET') {
          return jsonResponse(200, { ok: true, data: buildAiAgentsData() });
        }
        if (url.endsWith('/api/v1/registered-agents') && method === 'GET') {
          return jsonResponse(200, { ok: true, data: buildRegisteredAgents() });
        }
        if (
          url.endsWith('/api/v1/registered-agents/main') &&
          method === 'GET'
        ) {
          return jsonResponse(200, {
            ok: true,
            data: buildRegisteredAgents()[0],
          });
        }
        if (url.endsWith('/api/v1/web-search/providers') && method === 'GET') {
          return jsonResponse(200, {
            ok: true,
            data: { providers: [], activeProvider: null },
          });
        }
        if (url.endsWith('/api/v1/me/google-account') && method === 'GET') {
          return jsonResponse(200, {
            ok: true,
            data: { googleAccount: account },
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );
  }

  it('does NOT render the Google account section when the flag is unset', async () => {
    vi.stubEnv('VITE_GOOGLE_TOOLS_ENABLED', '');
    installToolsFetch({ connected: false });

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=tools']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    // The Tools section should render, but the Google account section
    // should NOT be present.
    await screen.findByRole('heading', { name: 'Tools' });
    expect(screen.queryByTestId('google-account-section')).toBeNull();
  });

  it('renders connect button when flag is on and account is disconnected', async () => {
    vi.stubEnv('VITE_GOOGLE_TOOLS_ENABLED', 'true');
    installToolsFetch({ connected: false });

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=tools']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    const section = await screen.findByTestId('google-account-section');
    expect(
      within(section).getByText(/No Google account connected/i),
    ).toBeTruthy();
    expect(
      within(section).getByRole('button', { name: /Connect Google account/i }),
    ).toBeTruthy();
    expect(
      within(section).queryByRole('button', { name: /Disconnect/i }),
    ).toBeNull();
  });

  it('renders disconnect button and email when flag is on and account is connected', async () => {
    vi.stubEnv('VITE_GOOGLE_TOOLS_ENABLED', 'true');
    installToolsFetch({ connected: true });

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=tools']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    const section = await screen.findByTestId('google-account-section');
    expect(within(section).getByText(/tester@example.com/)).toBeTruthy();
    expect(
      within(section).getByRole('button', { name: /Disconnect/i }),
    ).toBeTruthy();
    // Connect button should NOT be rendered when already connected (D4 UI gate)
    expect(
      within(section).queryByRole('button', {
        name: /Connect Google account/i,
      }),
    ).toBeNull();
  });

  // ─── Connectors tab ──────────────────────────────────────────────────

  it('Connectors tab: admin sees both sections with bound-talk counts and status pills', async () => {
    installConnectorsFetch({
      channels: [
        {
          id: 'ch-1',
          kind: 'slack',
          displayName: 'Eng Slack',
          config: { workspace_id: 'T123', channel_id: 'C123' },
          hasCredential: false,
          enabled: true,
          boundTalkCount: 2,
          createdAt: '2026-05-22T00:00:00Z',
          updatedAt: '2026-05-22T00:00:00Z',
          createdBy: null,
          updatedBy: null,
        },
      ],
      dataConnectors: [
        {
          id: 'dc-1',
          kind: 'posthog',
          displayName: 'Prod analytics',
          config: { project_id: '999', host: 'https://us.posthog.com' },
          hasCredential: true,
          enabled: true,
          boundTalkCount: 0,
          createdAt: '2026-05-22T00:00:00Z',
          updatedAt: '2026-05-22T00:00:00Z',
          createdBy: null,
          updatedBy: null,
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=connectors']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Channels available to talks' });
    expect(
      screen.getByRole('heading', { name: 'Data sources available to talks' }),
    ).toBeTruthy();
    expect(screen.getByText('Eng Slack')).toBeTruthy();
    expect(screen.getByText('Used by 2 talks')).toBeTruthy();
    // Slack channel has no credential → amber pill
    expect(screen.getByLabelText('Credential missing')).toBeTruthy();
    // PostHog has credential + enabled → Configuration only pill
    expect(screen.getByLabelText('Configuration only')).toBeTruthy();
  });

  it('Connectors tab: member sees rows but no Add/Edit/Delete affordances', async () => {
    installConnectorsFetch({
      channels: [
        {
          id: 'ch-1',
          kind: 'slack',
          displayName: 'Eng Slack',
          config: {},
          hasCredential: true,
          enabled: true,
          boundTalkCount: 0,
          createdAt: '2026-05-22T00:00:00Z',
          updatedAt: '2026-05-22T00:00:00Z',
          createdBy: null,
          updatedBy: null,
        },
      ],
      dataConnectors: [],
    });

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=connectors']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="member"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Channels available to talks' });
    expect(screen.queryByRole('button', { name: '+ Add channel' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit Slack/i })).toBeNull();
  });

  it('Connectors tab: Delete shows confirmation modal naming the bound talk count', async () => {
    const helpers = installConnectorsFetch({
      channels: [
        {
          id: 'ch-1',
          kind: 'slack',
          displayName: 'Eng Slack',
          config: {},
          hasCredential: true,
          enabled: true,
          boundTalkCount: 3,
          createdAt: '2026-05-22T00:00:00Z',
          updatedAt: '2026-05-22T00:00:00Z',
          createdBy: null,
          updatedBy: null,
        },
      ],
      dataConnectors: [],
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=connectors']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByText('Eng Slack');
    await user.click(
      screen.getByRole('button', {
        name: /Delete Slack\/Telegram channel: Eng Slack/,
      }),
    );

    expect(
      screen.getByRole('heading', { name: /Delete Eng Slack/ }),
    ).toBeTruthy();
    expect(
      screen.getByText(/removes this connector from 3 talks/),
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Delete connector' }));

    expect(helpers.getDeleteChannelCalls()).toContain('ch-1');
  });
});

type WorkspaceChannelFixture = {
  id: string;
  kind: 'slack' | 'telegram';
  displayName: string;
  config: Record<string, unknown>;
  hasCredential: boolean;
  enabled: boolean;
  boundTalkCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};

type WorkspaceDataConnectorFixture = {
  id: string;
  kind: 'posthog' | 'google_docs' | 'google_sheets';
  displayName: string;
  config: Record<string, unknown>;
  hasCredential: boolean;
  enabled: boolean;
  boundTalkCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};

function installConnectorsFetch(seed: {
  channels: WorkspaceChannelFixture[];
  dataConnectors: WorkspaceDataConnectorFixture[];
}) {
  let channels = [...seed.channels];
  let dataConnectors = [...seed.dataConnectors];
  const deleteChannelCalls: string[] = [];
  const deleteDataConnectorCalls: string[] = [];

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

      if (url.endsWith('/api/v1/workspace/channels') && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { channels },
        });
      }
      if (
        url.endsWith('/api/v1/workspace/data-connectors') &&
        method === 'GET'
      ) {
        return jsonResponse(200, {
          ok: true,
          data: { dataConnectors },
        });
      }
      if (
        url.endsWith('/api/v1/workspace/connectors/slack/installs') &&
        method === 'GET'
      ) {
        return jsonResponse(200, { ok: true, data: { installs: [] } });
      }
      const deleteChannelMatch = url.match(
        /\/api\/v1\/workspace\/channels\/([^/?]+)$/,
      );
      if (deleteChannelMatch && method === 'DELETE') {
        const id = decodeURIComponent(deleteChannelMatch[1]);
        deleteChannelCalls.push(id);
        channels = channels.filter((c) => c.id !== id);
        return jsonResponse(200, { ok: true, data: { deleted: true } });
      }
      const deleteDcMatch = url.match(
        /\/api\/v1\/workspace\/data-connectors\/([^/?]+)$/,
      );
      if (deleteDcMatch && method === 'DELETE') {
        const id = decodeURIComponent(deleteDcMatch[1]);
        deleteDataConnectorCalls.push(id);
        dataConnectors = dataConnectors.filter((d) => d.id !== id);
        return jsonResponse(200, { ok: true, data: { deleted: true } });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }),
  );

  return {
    getDeleteChannelCalls: () => deleteChannelCalls,
    getDeleteDataConnectorCalls: () => deleteDataConnectorCalls,
  };
}
