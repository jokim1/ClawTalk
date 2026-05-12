import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { AiAgentsPage } from './AiAgentsPage';
import type {
  AiAgentsPageData,
  ExecutorSettings,
  RegisteredAgent,
  ExecutorStatus,
} from '../lib/api';

describe('AiAgentsPage', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the simplified Claude plus additional providers layout', async () => {
    const user = userEvent.setup();
    installAiAgentsFetch();

    render(
      <MemoryRouter initialEntries={['/app/agents']}>
        <AiAgentsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'AI Agents' });
    expect(
      screen.getByRole('heading', { name: 'Default Claude Agent' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'Additional Providers' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Every new talk starts with Claude as the default agent/i,
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText('Subscription')).toBeChecked();
    expect(screen.getByLabelText('API')).not.toBeChecked();
    expect(screen.getByText('Model for new talks')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Check host Claude login/i }),
    ).toBeNull();
    expect(screen.getByLabelText('Claude Code OAuth token')).toBeTruthy();
    expect(await screen.findByText(/Checked as user k1min8r/i)).toBeTruthy();

    const openAiCard = screen
      .getByRole('heading', { name: 'OpenAI' })
      .closest('article');
    if (!openAiCard) {
      throw new Error('Expected OpenAI provider card');
    }
    expect(
      within(openAiCard).getByRole('link', { name: 'Get key from OpenAI' }),
    ).toHaveAttribute('href', 'https://platform.openai.com/api-keys');

    const geminiCard = screen
      .getByRole('heading', { name: 'Google / Gemini' })
      .closest('article');
    if (!geminiCard) {
      throw new Error('Expected Gemini provider card');
    }
    expect(within(geminiCard).getByPlaceholderText('AIza...')).toBeTruthy();

    const nvidiaCard = screen
      .getByRole('heading', { name: 'NVIDIA Kimi2.5' })
      .closest('article');
    if (!nvidiaCard) {
      throw new Error('Expected NVIDIA provider card');
    }
    expect(
      within(nvidiaCard).getByRole('link', { name: 'Get key from NVIDIA' }),
    ).toHaveAttribute('href', 'https://build.nvidia.com/');
    expect(within(nvidiaCard).getByPlaceholderText('nvapi-...')).toBeTruthy();
    const nvidiaKeyInput = within(nvidiaCard).getByLabelText('API key');
    expect(nvidiaKeyInput).toHaveAttribute('type', 'password');
    await user.click(
      within(nvidiaCard).getByRole('button', {
        name: 'Show NVIDIA Kimi2.5 API key',
      }),
    );
    expect(nvidiaKeyInput).toHaveAttribute('type', 'text');
  });

  it('reports saved provider credentials honestly when verification does not pass', async () => {
    const user = userEvent.setup();
    installAiAgentsFetch();

    render(
      <MemoryRouter initialEntries={['/app/agents']}>
        <AiAgentsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'AI Agents' });

    const openAiCard = screen
      .getByRole('heading', { name: 'OpenAI' })
      .closest('article');
    if (!openAiCard) {
      throw new Error('Expected OpenAI provider card');
    }

    await user.type(within(openAiCard).getByLabelText('API key'), 'bad-token');
    await user.click(within(openAiCard).getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(
        'OpenAI credential saved. Verification status: invalid.',
      ),
    ).toBeTruthy();
  });

  it('shows NVIDIA as saved immediately while background verification runs', async () => {
    const user = userEvent.setup();
    installAiAgentsFetch();

    render(
      <MemoryRouter initialEntries={['/app/agents']}>
        <AiAgentsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'AI Agents' });

    const nvidiaCard = screen
      .getByRole('heading', { name: 'NVIDIA Kimi2.5' })
      .closest('article');
    if (!nvidiaCard) {
      throw new Error('Expected NVIDIA provider card');
    }

    await user.type(
      within(nvidiaCard).getByLabelText('API key'),
      'nvapi-test-key',
    );
    await user.click(within(nvidiaCard).getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(
        'NVIDIA Kimi2.5 credential saved. Verification is running in the background.',
      ),
    ).toBeTruthy();
    expect(within(nvidiaCard).getByText('Verifying…')).toBeTruthy();

    expect(
      await screen.findByText(
        'NVIDIA Kimi2.5 credential verified.',
        {},
        { timeout: 4_000 },
      ),
    ).toBeTruthy();
    expect(within(nvidiaCard).getByText('Verified')).toBeTruthy();
  });

  it('prefers manual token guidance when host import is unavailable', async () => {
    installAiAgentsFetch();

    render(
      <MemoryRouter initialEntries={['/app/agents']}>
        <AiAgentsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'AI Agents' });
    expect(
      await screen.findByText(
        /current authenticated state could not be imported automatically/i,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/^claude login$/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Import from host' }),
    ).toBeNull();
  });

  it('auto-verifies Claude after saving a manually pasted subscription token', async () => {
    const user = userEvent.setup();
    const helpers = installAiAgentsFetch();

    render(
      <MemoryRouter initialEntries={['/app/agents']}>
        <AiAgentsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'AI Agents' });
    await user.type(
      screen.getByLabelText('Claude Code OAuth token'),
      'oauth-token-test',
    );
    expect(
      screen.getByRole('button', { name: 'Save and verify Claude' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Verify subscription runtime' }),
    ).toBeNull();

    await user.click(
      screen.getByRole('button', { name: 'Save and verify Claude' }),
    );

    expect(
      await screen.findByText('Claude verification started.'),
    ).toBeTruthy();
    expect(helpers.getExecutorVerifyCalls()).toBe(1);
    expect(
      await screen.findByText('Verified', {}, { timeout: 4_000 }),
    ).toBeTruthy();
  });

  it('shows subscription runtime warnings without collapsing the badge to unavailable', async () => {
    installAiAgentsFetch({
      settings: {
        hasOauthToken: true,
        oauthTokenSource: 'stored',
        oauthTokenHint: 'Stored in settings',
        activeCredentialConfigured: true,
        verificationStatus: 'not_verified',
      },
      status: {
        executorAuthMode: 'subscription',
        activeCredentialConfigured: true,
        containerRuntimeAvailability: 'unavailable',
        verificationStatus: 'not_verified',
      },
    });

    render(
      <MemoryRouter initialEntries={['/app/agents']}>
        <AiAgentsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'AI Agents' });
    const claudeCard = screen.getByRole('heading', { name: 'Claude' }).closest(
      'article',
    );
    if (!claudeCard) {
      throw new Error('Expected Claude card');
    }

    expect(within(claudeCard).getByText('Not verified')).toBeTruthy();
    expect(within(claudeCard).queryByText('Unavailable')).toBeNull();
    expect(
      within(claudeCard).getByText(
        /Docker is currently unavailable, so verification and container-backed execution will fail/i,
      ),
    ).toBeTruthy();
  });

  it('shows a saved-but-not-verified notice when subscription verification cannot run', async () => {
    const user = userEvent.setup();
    const helpers = installAiAgentsFetch({
      status: {
        containerRuntimeAvailability: 'unavailable',
      },
    });

    render(
      <MemoryRouter initialEntries={['/app/agents']}>
        <AiAgentsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'AI Agents' });
    await user.type(
      screen.getByLabelText('Claude Code OAuth token'),
      'oauth-token-test',
    );
    await user.click(
      screen.getByRole('button', { name: 'Save and verify Claude' }),
    );

    expect(
      await screen.findByText(
        /Claude subscription saved, but verification could not run because the container runtime is unavailable or unhealthy/i,
      ),
    ).toBeTruthy();
    expect(helpers.getExecutorVerifyCalls()).toBe(1);
    expect(screen.getByText('Not verified')).toBeTruthy();
  });

  it('still renders invalid subscription verification results as invalid', async () => {
    installAiAgentsFetch({
      settings: {
        hasOauthToken: true,
        oauthTokenSource: 'stored',
        oauthTokenHint: 'Stored in settings',
        activeCredentialConfigured: true,
        verificationStatus: 'invalid',
        lastVerificationError:
          'Claude subscription authentication failed in the container runtime.',
      },
      status: {
        executorAuthMode: 'subscription',
        activeCredentialConfigured: true,
        verificationStatus: 'invalid',
        lastVerificationError:
          'Claude subscription authentication failed in the container runtime.',
      },
    });

    render(
      <MemoryRouter initialEntries={['/app/agents']}>
        <AiAgentsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'AI Agents' });
    const claudeCard = screen.getByRole('heading', { name: 'Claude' }).closest(
      'article',
    );
    if (!claudeCard) {
      throw new Error('Expected Claude card');
    }

    expect(within(claudeCard).getByText('Invalid')).toBeTruthy();
    expect(
      within(claudeCard).getByText(
        /Claude subscription authentication failed in the container runtime/i,
      ),
    ).toBeTruthy();
  });

  it('shows Main execution preview and blocks impossible main agent selections', async () => {
    const user = userEvent.setup();
    installAiAgentsFetch();

    render(
      <MemoryRouter initialEntries={['/app/agents']}>
        <AiAgentsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await user.click(
      await screen.findByRole('tab', { name: 'Registered Agents' }),
    );

    const mainSectionHeading = await screen.findByRole('heading', {
      name: 'Main Agent',
    });
    const mainSection = mainSectionHeading.closest('section');
    expect(mainSection).toBeTruthy();
    expect(
      within(mainSection as HTMLElement).getByText(
        'Main will use Claude subscription via the container runtime.',
      ),
    ).toBeTruthy();

    await user.selectOptions(
      screen.getByLabelText('Select main agent'),
      'agent-claude-light-broken',
    );
    expect(
      within(mainSection as HTMLElement).getByText(
        'No valid Main execution path is currently configured for this agent.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Set as Main Agent' }),
    ).toBeDisabled();
  });

  it('applies an obvious active state to the selected AI Agents tab', async () => {
    const user = userEvent.setup();
    installAiAgentsFetch();

    render(
      <MemoryRouter initialEntries={['/app/agents']}>
        <AiAgentsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    const providerTab = await screen.findByRole('tab', {
      name: 'Provider Setup',
    });
    const registeredAgentsTab = screen.getByRole('tab', {
      name: 'Registered Agents',
    });

    expect(providerTab).toHaveAttribute('aria-selected', 'true');
    expect(providerTab.className).toContain('talk-tab-active');
    expect(registeredAgentsTab).toHaveAttribute('aria-selected', 'false');
    expect(registeredAgentsTab.className).not.toContain('talk-tab-active');

    await user.click(registeredAgentsTab);

    expect(providerTab).toHaveAttribute('aria-selected', 'false');
    expect(providerTab.className).not.toContain('talk-tab-active');
    expect(registeredAgentsTab).toHaveAttribute('aria-selected', 'true');
    expect(registeredAgentsTab.className).toContain('talk-tab-active');
  });
  it('surfaces environment-backed Claude API credentials clearly', async () => {
    installAiAgentsFetch({
      settings: {
        executorAuthMode: 'api_key',
        authModeSource: 'inferred',
        hasApiKey: true,
        apiKeySource: 'env',
        apiKeyHint: 'Environment variable (ANTHROPIC_API_KEY)',
        activeCredentialConfigured: true,
        verificationStatus: 'invalid',
        lastVerificationError: 'Anthropic API error: Unauthorized',
      },
      status: {
        executorAuthMode: 'api_key',
        activeCredentialConfigured: true,
        verificationStatus: 'invalid',
        lastVerificationError: 'Anthropic API error: Unauthorized',
      },
    });

    render(
      <MemoryRouter initialEntries={['/app/agents']}>
        <AiAgentsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'AI Agents' });
    expect(screen.getByLabelText('API')).toBeChecked();
    expect(
      screen.getByText('Environment variable (ANTHROPIC_API_KEY)'),
    ).toBeTruthy();
    expect(
      screen.getByText(/Active Claude auth mode is inferred/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/This API key comes from the service environment/i),
    ).toBeTruthy();
  });
});

function installAiAgentsFetch(input?: {
  settings?: Partial<ExecutorSettings>;
  status?: Partial<ExecutorStatus>;
}) {
  let snapshot = buildAiAgentsData();
  let settings = {
    ...buildExecutorSettings(),
    ...input?.settings,
  };
  let status = {
    ...buildExecutorStatus(),
    ...input?.status,
  };
  let registeredAgents = buildRegisteredAgents();
  let mainAgent: RegisteredAgent | null = registeredAgents[0] ?? null;
  let nvidiaVerificationStage: 'idle' | 'verifying' | 'complete' = 'idle';
  let executorVerificationPending = false;
  let executorVerifyCalls = 0;

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
        if (nvidiaVerificationStage === 'complete') {
          snapshot = {
            ...snapshot,
            additionalProviders: snapshot.additionalProviders.map((provider) =>
              provider.id === 'provider.nvidia'
                ? {
                    ...provider,
                    hasCredential: true,
                    credentialHint: '••••X6za',
                    verificationStatus: 'verified',
                    lastVerifiedAt: '2026-03-06T20:28:56.000Z',
                    lastVerificationError: null,
                  }
                : provider,
            ),
          };
          nvidiaVerificationStage = 'idle';
        } else if (nvidiaVerificationStage === 'verifying') {
          nvidiaVerificationStage = 'complete';
        }
        return jsonResponse(200, { ok: true, data: snapshot });
      }

      if (url.endsWith('/api/v1/settings/executor') && method === 'GET') {
        return jsonResponse(200, { ok: true, data: settings });
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

      if (url.endsWith('/api/v1/registered-agents/main') && method === 'PUT') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          agentId?: string;
        };
        const nextMainAgent =
          registeredAgents.find((agent) => agent.id === body.agentId) ?? null;
        if (!nextMainAgent) {
          return jsonResponse(404, {
            ok: false,
            error: { code: 'not_found', message: 'No main agent' },
          });
        }
        mainAgent = nextMainAgent;
        return jsonResponse(200, { ok: true, data: mainAgent });
      }

      if (
        url.endsWith('/api/v1/settings/executor-status') &&
        method === 'GET'
      ) {
        if (executorVerificationPending) {
          executorVerificationPending = false;
          status = {
            ...status,
            verificationStatus: 'verified',
            activeCredentialConfigured: true,
            lastVerifiedAt: '2026-03-13T22:15:00.000Z',
            lastVerificationError: null,
          };
        }
        return jsonResponse(200, { ok: true, data: status });
      }

      if (url.endsWith('/api/v1/settings/executor') && method === 'PUT') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          string
        >;
        settings = {
          ...settings,
          executorAuthMode:
            body.executorAuthMode === 'api_key' ? 'api_key' : 'subscription',
          authModeSource: 'settings',
          hasApiKey: body.anthropicApiKey ? true : settings.hasApiKey,
          hasOauthToken: body.claudeOauthToken ? true : settings.hasOauthToken,
          apiKeySource: body.anthropicApiKey ? 'stored' : settings.apiKeySource,
          oauthTokenSource: body.claudeOauthToken
            ? 'stored'
            : settings.oauthTokenSource,
          activeCredentialConfigured:
            !!body.anthropicApiKey || !!body.claudeOauthToken
              ? true
              : settings.activeCredentialConfigured,
          apiKeyHint: body.anthropicApiKey
            ? 'Stored in settings'
            : settings.apiKeyHint,
          oauthTokenHint: body.claudeOauthToken
            ? 'Stored in settings'
            : settings.oauthTokenHint,
          verificationStatus:
            body.anthropicApiKey || body.claudeOauthToken
              ? 'not_verified'
              : settings.verificationStatus,
          lastVerifiedAt: body.anthropicApiKey || body.claudeOauthToken
            ? null
            : settings.lastVerifiedAt,
          lastVerificationError: body.anthropicApiKey || body.claudeOauthToken
            ? null
            : settings.lastVerificationError,
        };
        status = {
          ...status,
          executorAuthMode: settings.executorAuthMode,
          activeCredentialConfigured: settings.activeCredentialConfigured,
          verificationStatus:
            body.anthropicApiKey || body.claudeOauthToken
              ? 'not_verified'
              : status.verificationStatus,
          lastVerifiedAt: body.anthropicApiKey || body.claudeOauthToken
            ? null
            : status.lastVerifiedAt,
          lastVerificationError: body.anthropicApiKey || body.claudeOauthToken
            ? null
            : status.lastVerificationError,
        };
        return jsonResponse(200, { ok: true, data: settings });
      }

      if (
        url.endsWith('/api/v1/settings/executor/verify') &&
        method === 'POST'
      ) {
        executorVerifyCalls += 1;
        if (
          settings.executorAuthMode === 'subscription' &&
          status.containerRuntimeAvailability === 'unavailable'
        ) {
          status = {
            ...status,
            verificationStatus: 'not_verified',
            activeCredentialConfigured: true,
            lastVerificationError:
              'Claude subscription verification could not run because the container runtime is unavailable or unhealthy. Check Docker and try again.',
          };
          settings = {
            ...settings,
            verificationStatus: 'not_verified',
            activeCredentialConfigured: true,
            lastVerificationError:
              'Claude subscription verification could not run because the container runtime is unavailable or unhealthy. Check Docker and try again.',
          };
          return jsonResponse(200, {
            ok: true,
            data: {
              scheduled: false,
              code: 'runtime_unavailable',
              message:
                'Claude subscription verification could not run because the container runtime is unavailable or unhealthy. Check Docker and try again.',
            },
          });
        }
        status = {
          ...status,
          verificationStatus: 'verifying',
          activeCredentialConfigured: true,
        };
        executorVerificationPending = true;
        return jsonResponse(200, {
          ok: true,
          data: {
            scheduled: true,
            code: 'verification_scheduled',
            message: 'Claude verification started.',
          },
        });
      }

      if (
        url.endsWith('/api/v1/settings/executor/subscription-host-status') &&
        method === 'GET'
      ) {
        return jsonResponse(200, {
          ok: true,
          data: {
            serviceUser: 'k1min8r',
            serviceUid: 1000,
            serviceHomePath: '/home/k1min8r',
            runtimeContext: 'host',
            claudeCliInstalled: true,
            hostLoginDetected: true,
            serviceEnvOauthPresent: false,
            importAvailable: false,
            hostCredentialFingerprint: null,
            message:
              'Claude Code login was detected for this service user, but the current authenticated state could not be imported automatically. Use the advanced manual token flow with `claude setup-token`.',
            recommendedCommands: [
              'claude config set -g forceLoginMethod claudeai',
              'claude login',
            ],
          },
        });
      }

      if (
        url.endsWith('/api/v1/agents/providers/provider.openai') &&
        method === 'PUT'
      ) {
        snapshot = {
          ...snapshot,
          additionalProviders: snapshot.additionalProviders.map((provider) =>
            provider.id === 'provider.openai'
              ? {
                  ...provider,
                  hasCredential: true,
                  credentialHint: '••••bad',
                  verificationStatus: 'invalid',
                  lastVerificationError: 'Invalid API key.',
                }
              : provider,
          ),
        };
        const provider = snapshot.additionalProviders.find(
          (entry) => entry.id === 'provider.openai',
        );
        return jsonResponse(200, { ok: true, data: { provider } });
      }

      if (
        url.endsWith('/api/v1/agents/providers/provider.nvidia') &&
        method === 'PUT'
      ) {
        nvidiaVerificationStage = 'verifying';
        snapshot = {
          ...snapshot,
          additionalProviders: snapshot.additionalProviders.map((provider) =>
            provider.id === 'provider.nvidia'
              ? {
                  ...provider,
                  hasCredential: true,
                  credentialHint: '••••X6za',
                  verificationStatus: 'verifying',
                  lastVerificationError: null,
                }
              : provider,
          ),
        };
        const provider = snapshot.additionalProviders.find(
          (entry) => entry.id === 'provider.nvidia',
        );
        return jsonResponse(200, { ok: true, data: { provider } });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }),
  );

  return {
    getExecutorVerifyCalls: (): number => executorVerifyCalls,
  };
}

function buildAiAgentsData(): AiAgentsPageData {
  return {
    defaultClaudeModelId: 'claude-sonnet-4-5',
    claudeModelSuggestions: [
      {
        modelId: 'claude-opus-4-6',
        displayName: 'Claude Opus 4.6',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 4096,
      },
      {
        modelId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 4096,
      },
      {
        modelId: 'claude-sonnet-4-5',
        displayName: 'Claude Sonnet 4.5',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 4096,
      },
    ],
    additionalProviders: [
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
        modelSuggestions: [
          {
            modelId: 'moonshotai/kimi-k2.5',
            displayName: 'Kimi 2.5 (NVIDIA)',
            contextWindowTokens: 262144,
            defaultMaxOutputTokens: 16384,
          },
        ],
      },
    ],
  };
}

function buildExecutorSettings(): ExecutorSettings {
  return {
    configuredAliasMap: {},
    effectiveAliasMap: { Mock: 'mock' },
    defaultAlias: 'Mock',
    executorAuthMode: 'subscription',
    authModeSource: 'settings',
    hasApiKey: false,
    hasOauthToken: false,
    hasAuthToken: false,
    apiKeySource: null,
    oauthTokenSource: null,
    authTokenSource: null,
    apiKeyHint: null,
    oauthTokenHint: null,
    authTokenHint: null,
    activeCredentialConfigured: false,
    verificationStatus: 'missing',
    lastVerifiedAt: null,
    lastVerificationError: null,
    anthropicBaseUrl: 'https://api.anthropic.com',
    isConfigured: true,
    configVersion: 1,
    lastUpdatedAt: null,
    lastUpdatedBy: null,
    configErrors: [],
  };
}

function buildExecutorStatus(): ExecutorStatus {
  return {
    mode: 'real',
    restartSupported: false,
    pendingRestartReasons: [],
    activeRunCount: 0,
    containerRuntimeAvailability: 'ready',
    executorAuthMode: 'subscription',
    activeCredentialConfigured: false,
    verificationStatus: 'missing',
    lastVerifiedAt: null,
    lastVerificationError: null,
    hasProviderAuth: false,
    hasValidAliasMap: true,
    configVersion: 1,
    isConfigured: true,
    bootId: 'boot-test',
    configErrors: [],
  };
}

function buildRegisteredAgents(): RegisteredAgent[] {
  return [
    {
      id: 'agent-main-ready',
      name: 'Claude Main',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissions: { shell: true, web: true },
      personaRole: 'assistant',
      systemPrompt: null,
      enabled: true,
      createdAt: '2026-03-06T00:00:00.000Z',
      updatedAt: '2026-03-06T00:00:00.000Z',
      executionPreview: {
        surface: 'main',
        backend: 'container',
        authPath: 'subscription',
        selectedMode: 'subscription',
        transport: 'subscription',
        reasonCode: null,
        routeReason: 'normal',
        ready: true,
        message: 'Main will use Claude subscription via the container runtime.',
      },
    },
    {
      id: 'agent-claude-light-broken',
      name: 'Claude Broken',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissions: { web: true },
      personaRole: 'assistant',
      systemPrompt: null,
      enabled: true,
      createdAt: '2026-03-06T00:00:00.000Z',
      updatedAt: '2026-03-06T00:00:00.000Z',
      executionPreview: {
        surface: 'main',
        backend: null,
        authPath: null,
        selectedMode: null,
        transport: null,
        reasonCode: 'auth_mode_not_configured',
        routeReason: 'no_valid_path',
        ready: false,
        message:
          'No valid Main execution path is currently configured for this agent.',
      },
    },
  ];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}
