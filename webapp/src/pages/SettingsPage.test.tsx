import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsPage } from './SettingsPage';

describe('SettingsPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders config errors and pending restart reasons from the settings endpoints', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: { Gemini: 'gemini-pro' },
          effectiveAliasMap: { Mock: 'default', Gemini: 'gemini-pro' },
          defaultAlias: 'Gemini',
          executorAuthMode: 'api_key',
          hasApiKey: true,
          hasOauthToken: false,
          hasAuthToken: false,
          activeCredentialConfigured: true,
          verificationStatus: 'verified',
          lastVerifiedAt: '2026-03-05T12:00:00.000Z',
          lastVerificationError: null,
          anthropicBaseUrl: 'https://api.example.test',
          isConfigured: true,
          configVersion: 1,
          lastUpdatedAt: '2026-03-05T12:00:00.000Z',
          lastUpdatedBy: { id: 'owner-1', displayName: 'Owner' },
          configErrors: ['Alias map must be valid JSON'],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          mode: 'mock',
          restartSupported: true,
          pendingRestartReasons: ['Alias model map changed'],
          activeRunCount: 2,
          containerRuntimeAvailability: 'ready',
          executorAuthMode: 'api_key',
          activeCredentialConfigured: true,
          verificationStatus: 'verified',
          lastVerifiedAt: '2026-03-05T12:00:00.000Z',
          lastVerificationError: null,
          hasProviderAuth: true,
          hasValidAliasMap: false,
          configVersion: 1,
          isConfigured: true,
          bootId: 'boot-1',
          configErrors: ['Alias map must be valid JSON'],
        },
      }),
    ]);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="owner" />);

    await screen.findByRole('heading', { name: 'Executor Settings' });
    expect(
      await screen.findByText('Configuration errors detected.'),
    ).toBeTruthy();
    expect(await screen.findByText('Alias model map changed')).toBeTruthy();
    expect(
      (await screen.findAllByText('Active auth mode')).length,
    ).toBeGreaterThan(0);
    expect(
      await screen.findByRole('button', {
        name: 'Restart ClawRocket Service',
      }),
    ).toBeTruthy();
  });

  it('shows owner-only restart guidance for admin users', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: {},
          effectiveAliasMap: { Mock: 'default' },
          defaultAlias: 'Mock',
          executorAuthMode: 'none',
          hasApiKey: false,
          hasOauthToken: false,
          hasAuthToken: false,
          activeCredentialConfigured: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          anthropicBaseUrl: '',
          isConfigured: false,
          configVersion: 0,
          lastUpdatedAt: null,
          lastUpdatedBy: null,
          configErrors: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          mode: 'mock',
          restartSupported: true,
          pendingRestartReasons: ['Default alias changed from Mock to Gemini'],
          activeRunCount: 0,
          containerRuntimeAvailability: 'ready',
          executorAuthMode: 'none',
          activeCredentialConfigured: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          hasProviderAuth: false,
          hasValidAliasMap: true,
          configVersion: 0,
          isConfigured: false,
          bootId: 'boot-2',
          configErrors: [],
        },
      }),
    ]);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="admin" />);

    await screen.findByRole('heading', { name: 'Executor Settings' });
    expect(
      (
        await screen.findAllByText(
          'Only the account owner can restart the service.',
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole('button', { name: 'Restart ClawRocket Service' }),
    ).toBeNull();
  });

  it('surfaces environment-managed executor credentials honestly', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: {},
          effectiveAliasMap: {},
          defaultAlias: 'Mock',
          executorAuthMode: 'api_key',
          authModeSource: 'inferred',
          hasApiKey: true,
          hasOauthToken: false,
          hasAuthToken: false,
          apiKeySource: 'env',
          oauthTokenSource: null,
          authTokenSource: null,
          apiKeyHint: 'Environment variable (ANTHROPIC_API_KEY)',
          oauthTokenHint: null,
          authTokenHint: null,
          activeCredentialConfigured: true,
          verificationStatus: 'invalid',
          lastVerifiedAt: null,
          lastVerificationError: 'Anthropic API error: Unauthorized',
          anthropicBaseUrl: 'https://api.anthropic.com',
          isConfigured: true,
          configVersion: 1,
          lastUpdatedAt: null,
          lastUpdatedBy: null,
          configErrors: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          mode: 'real',
          restartSupported: false,
          pendingRestartReasons: [],
          activeRunCount: 0,
          containerRuntimeAvailability: 'ready',
          executorAuthMode: 'api_key',
          activeCredentialConfigured: true,
          verificationStatus: 'invalid',
          lastVerifiedAt: null,
          lastVerificationError: 'Anthropic API error: Unauthorized',
          hasProviderAuth: true,
          hasValidAliasMap: true,
          configVersion: 1,
          isConfigured: true,
          bootId: 'boot-env',
          configErrors: [],
        },
      }),
    ]);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="owner" />);

    await screen.findByRole('heading', { name: 'Executor Settings' });
    expect(await screen.findByText('Environment-managed')).toBeTruthy();
    expect(
      await screen.findByText('Environment variable (ANTHROPIC_API_KEY)'),
    ).toBeTruthy();
    expect(
      await screen.findByText(/active claude auth mode is being inferred/i),
    ).toBeTruthy();
  });

  it('shows container runtime health separately from subscription verification status', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: {},
          effectiveAliasMap: {},
          defaultAlias: 'Mock',
          executorAuthMode: 'subscription',
          authModeSource: 'settings',
          hasApiKey: false,
          hasOauthToken: true,
          hasAuthToken: false,
          apiKeySource: null,
          oauthTokenSource: 'stored',
          authTokenSource: null,
          apiKeyHint: null,
          oauthTokenHint: 'Stored in settings',
          authTokenHint: null,
          activeCredentialConfigured: true,
          verificationStatus: 'not_verified',
          lastVerifiedAt: null,
          lastVerificationError:
            'Claude subscription verification could not run because the container runtime is unavailable or unhealthy. Check Docker and try again.',
          anthropicBaseUrl: 'https://api.anthropic.com',
          isConfigured: true,
          configVersion: 1,
          lastUpdatedAt: null,
          lastUpdatedBy: null,
          configErrors: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          mode: 'real',
          restartSupported: false,
          pendingRestartReasons: [],
          activeRunCount: 0,
          containerRuntimeAvailability: 'unavailable',
          executorAuthMode: 'subscription',
          activeCredentialConfigured: true,
          verificationStatus: 'not_verified',
          lastVerifiedAt: null,
          lastVerificationError:
            'Claude subscription verification could not run because the container runtime is unavailable or unhealthy. Check Docker and try again.',
          hasProviderAuth: true,
          hasValidAliasMap: true,
          configVersion: 1,
          isConfigured: true,
          bootId: 'boot-subscription-runtime',
          configErrors: [],
        },
      }),
    ]);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="owner" />);

    await screen.findByRole('heading', { name: 'Executor Settings' });
    expect(await screen.findByText('Container runtime')).toBeTruthy();
    expect(await screen.findByText('Not verified')).toBeTruthy();
    expect(await screen.findByText(/Runtime note:/i)).toBeTruthy();
    expect(
      await screen.findByText(
        /Docker \/ the container runtime is currently unavailable/i,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Verification note:/i)).toBeNull();
  });

  it('auto-discovers Chrome user data directories for browser profiles', async () => {
    const user = userEvent.setup();
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: {},
          effectiveAliasMap: {},
          defaultAlias: 'Mock',
          executorAuthMode: 'none',
          hasApiKey: false,
          hasOauthToken: false,
          hasAuthToken: false,
          activeCredentialConfigured: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          anthropicBaseUrl: '',
          isConfigured: false,
          configVersion: 0,
          lastUpdatedAt: null,
          lastUpdatedBy: null,
          configErrors: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          mode: 'mock',
          restartSupported: false,
          pendingRestartReasons: [],
          activeRunCount: 0,
          containerRuntimeAvailability: 'ready',
          executorAuthMode: 'none',
          activeCredentialConfigured: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          hasProviderAuth: false,
          hasValidAliasMap: true,
          configVersion: 0,
          isConfigured: false,
          bootId: 'boot-browser-detect',
          configErrors: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          profiles: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          platform: 'darwin',
          defaultPathHint:
            '/Users/alice/Library/Application Support/Google/Chrome',
          candidates: [
            {
              id: 'google-chrome',
              label: 'Google Chrome',
              path: '/Users/alice/Library/Application Support/Google/Chrome',
              preferred: true,
            },
          ],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          userDataDir:
            '/Users/alice/Library/Application Support/Google/Chrome',
          localStateFound: true,
          candidates: [
            {
              directoryName: 'Profile 4',
              displayName: 'Work',
              email: 'alice@work.com',
              fullName: 'Alice Example',
              kind: 'profile',
              preferred: true,
              lastUsed: true,
              path: '/Users/alice/Library/Application Support/Google/Chrome/Profile 4',
            },
            {
              directoryName: 'Default',
              displayName: 'Alice Example',
              email: 'alice@gmail.com',
              fullName: 'Alice Example',
              kind: 'default',
              preferred: false,
              lastUsed: false,
              path: '/Users/alice/Library/Application Support/Google/Chrome/Default',
            },
          ],
        },
      }),
    ]);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="owner" />);

    await screen.findByRole('heading', { name: 'Browser Profiles' });
    await user.click(screen.getByRole('button', { name: 'Add Profile' }));
    await user.click(screen.getByLabelText('Chrome Profile'));

    expect(
      await screen.findByDisplayValue(
        '/Users/alice/Library/Application Support/Google/Chrome',
      ),
    ).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: 'Use Google Chrome' }),
    ).toBeTruthy();
    expect(
      (
        await screen.findByRole('combobox')
      ) as HTMLSelectElement,
    ).toHaveValue('Profile 4');
    expect(screen.getByText(/Selected subprofile:/i)).toBeTruthy();
  });

  it('warns when Add Browser Profile matches an existing profile', async () => {
    const user = userEvent.setup();
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: {},
          effectiveAliasMap: {},
          defaultAlias: 'Mock',
          executorAuthMode: 'none',
          hasApiKey: false,
          hasOauthToken: false,
          hasAuthToken: false,
          activeCredentialConfigured: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          anthropicBaseUrl: '',
          isConfigured: false,
          configVersion: 0,
          lastUpdatedAt: null,
          lastUpdatedBy: null,
          configErrors: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          mode: 'mock',
          restartSupported: false,
          pendingRestartReasons: [],
          activeRunCount: 0,
          containerRuntimeAvailability: 'ready',
          executorAuthMode: 'none',
          activeCredentialConfigured: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          hasProviderAuth: false,
          hasValidAliasMap: true,
          configVersion: 0,
          isConfigured: false,
          bootId: 'boot-browser-duplicate',
          configErrors: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          profiles: [
            {
              id: 'bp-linkedin',
              siteKey: 'linkedin',
              accountLabel: null,
              connectionMode: 'managed',
              connectionConfig: { mode: 'managed' },
              createdAt: '2026-03-27T21:40:00.000Z',
              updatedAt: '2026-03-27T21:40:00.000Z',
              lastUsedAt: null,
              inUseSessionCount: 0,
              currentSessionState: null,
            },
          ],
        },
      }),
    ]);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="owner" />);

    await screen.findByRole('heading', { name: 'Browser Profiles' });
    await user.click(screen.getByRole('button', { name: 'Add Profile' }));
    await user.type(
      screen.getByPlaceholderText('Site key (e.g. linkedin)'),
      'linkedin',
    );

    expect(
      await screen.findByText(/This matches existing profile/i),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('renders browser profile create failures as an error banner', async () => {
    const user = userEvent.setup();
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: {},
          effectiveAliasMap: {},
          defaultAlias: 'Mock',
          executorAuthMode: 'none',
          hasApiKey: false,
          hasOauthToken: false,
          hasAuthToken: false,
          activeCredentialConfigured: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          anthropicBaseUrl: '',
          isConfigured: false,
          configVersion: 0,
          lastUpdatedAt: null,
          lastUpdatedBy: null,
          configErrors: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          mode: 'mock',
          restartSupported: false,
          pendingRestartReasons: [],
          activeRunCount: 0,
          containerRuntimeAvailability: 'ready',
          executorAuthMode: 'none',
          activeCredentialConfigured: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          hasProviderAuth: false,
          hasValidAliasMap: true,
          configVersion: 0,
          isConfigured: false,
          bootId: 'boot-browser-error',
          configErrors: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          profiles: [],
        },
      }),
      jsonResponse(409, {
        ok: false,
        error: {
          code: 'profile_exists',
          message:
            'A browser profile for github already exists and is using Managed.',
        },
      }),
    ]);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="owner" />);

    await screen.findByRole('heading', { name: 'Browser Profiles' });
    await user.click(screen.getByRole('button', { name: 'Add Profile' }));
    await user.type(
      screen.getByPlaceholderText('Site key (e.g. linkedin)'),
      'github',
    );
    await user.click(screen.getByRole('button', { name: 'Create' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'A browser profile for github already exists and is using Managed.',
    );
    expect(alert).toHaveClass('settings-banner-error');
  });

  it('releases blocking sessions from the browser profile edit form', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          data: {
            configuredAliasMap: {},
            effectiveAliasMap: {},
            defaultAlias: 'Mock',
            executorAuthMode: 'none',
            hasApiKey: false,
            hasOauthToken: false,
            hasAuthToken: false,
            activeCredentialConfigured: false,
            verificationStatus: 'missing',
            lastVerifiedAt: null,
            lastVerificationError: null,
            anthropicBaseUrl: '',
            isConfigured: false,
            configVersion: 0,
            lastUpdatedAt: null,
            lastUpdatedBy: null,
            configErrors: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          data: {
            mode: 'mock',
            restartSupported: false,
            pendingRestartReasons: [],
            activeRunCount: 0,
            containerRuntimeAvailability: 'ready',
            executorAuthMode: 'none',
            activeCredentialConfigured: false,
            verificationStatus: 'missing',
            lastVerifiedAt: null,
            lastVerificationError: null,
            hasProviderAuth: false,
            hasValidAliasMap: true,
            configVersion: 0,
            isConfigured: false,
            bootId: 'boot-browser-release',
            configErrors: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          data: {
            profiles: [
              {
                id: 'bp-linkedin',
                siteKey: 'linkedin',
                accountLabel: null,
                connectionMode: 'managed',
                connectionConfig: { mode: 'managed' },
                createdAt: '2026-03-27T21:40:00.000Z',
                updatedAt: '2026-03-27T21:40:00.000Z',
                lastUsedAt: null,
                inUseSessionCount: 1,
                currentSessionState: 'blocked',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          data: {
            releasedCount: 1,
            liveReleasedCount: 0,
            staleReleasedCount: 1,
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="owner" />);

    await screen.findByRole('heading', { name: 'Browser Profiles' });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(
      screen.getByRole('button', { name: 'Disconnect Blocking Sessions' }),
    );

    expect(
      await screen.findByText(
        'Disconnected 1 blocking browser session. Save again to apply the new connection mode.',
      ),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/browser/profiles/bp-linkedin/release-sessions',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('shows profile usage and deletes a browser profile from the edit form', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          data: {
            configuredAliasMap: {},
            effectiveAliasMap: {},
            defaultAlias: 'Mock',
            executorAuthMode: 'none',
            hasApiKey: false,
            hasOauthToken: false,
            hasAuthToken: false,
            activeCredentialConfigured: false,
            verificationStatus: 'missing',
            lastVerifiedAt: null,
            lastVerificationError: null,
            anthropicBaseUrl: '',
            isConfigured: false,
            configVersion: 0,
            lastUpdatedAt: null,
            lastUpdatedBy: null,
            configErrors: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          data: {
            mode: 'mock',
            restartSupported: false,
            pendingRestartReasons: [],
            activeRunCount: 0,
            containerRuntimeAvailability: 'ready',
            executorAuthMode: 'none',
            activeCredentialConfigured: false,
            verificationStatus: 'missing',
            lastVerifiedAt: null,
            lastVerificationError: null,
            hasProviderAuth: false,
            hasValidAliasMap: true,
            configVersion: 0,
            isConfigured: false,
            bootId: 'boot-browser-delete',
            configErrors: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          data: {
            profiles: [
              {
                id: 'bp-linkedin',
                siteKey: 'linkedin',
                accountLabel: null,
                connectionMode: 'managed',
                connectionConfig: { mode: 'managed' },
                createdAt: '2026-03-27T21:40:00.000Z',
                updatedAt: '2026-03-27T21:40:00.000Z',
                lastUsedAt: '2026-03-27T22:45:00.000Z',
                inUseSessionCount: 1,
                currentSessionState: 'active',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          data: { profileId: 'bp-linkedin' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          data: {
            profiles: [],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="owner" />);

    await screen.findByRole('heading', { name: 'Browser Profiles' });
    expect(screen.getByText('In Use')).toBeTruthy();
    expect(screen.getByText(/Last used:/i)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Delete Profile' }));

    expect(await screen.findByText('Browser profile deleted.')).toBeTruthy();
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      '/api/v1/browser/profiles/bp-linkedin',
      expect.objectContaining({
        method: 'DELETE',
      }),
    );
  });
});

function mockFetch(responses: Response[]): void {
  const queue = [...responses];
  vi.stubGlobal('fetch', async () => {
    const next = queue.shift();
    if (!next) {
      throw new Error('No mocked response left for fetch()');
    }
    return next;
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}
