import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadConfig() {
  vi.resetModules();
  return import('./config.js');
}

function applyValidPublicModeEnv(): void {
  vi.stubEnv('PUBLIC_MODE', 'true');
  vi.stubEnv('AUTH_DEV_MODE', 'false');
  vi.stubEnv('WEB_SECURE_COOKIES', 'true');
  vi.stubEnv('TRUSTED_PROXY_MODE', 'cloudflare');
  vi.stubEnv('CLAWTALK_PROVIDER_SECRET_KEY', 'test-provider-secret');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'test-client-id');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'test-client-secret');
  vi.stubEnv(
    'GOOGLE_OAUTH_REDIRECT_URI',
    'https://clawtalk.app/api/v1/auth/google/callback',
  );
  // PR2 C11: picker SDK env vars are required when public mode is on.
  vi.stubEnv('GOOGLE_PICKER_API_KEY', 'test-picker-key');
  vi.stubEnv('GOOGLE_PICKER_APP_ID', 'test-picker-app');
}

describe('clawtalk config public mode', () => {
  afterEach(() => {
    vi.unmock('../logger.js');
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('treats PUBLIC_MODE=true as public mode', async () => {
    vi.stubEnv('PUBLIC_MODE', 'true');

    const config = await loadConfig();

    expect(config.isPublicMode).toBe(true);
  });

  it('treats TRUSTED_PROXY_MODE alone as public mode', async () => {
    vi.stubEnv('TRUSTED_PROXY_MODE', 'cloudflare');

    const config = await loadConfig();

    expect(config.isPublicMode).toBe(true);
  });

  it('treats mixed signals with a trusted proxy as public mode', async () => {
    vi.stubEnv('PUBLIC_MODE', 'false');
    vi.stubEnv('TRUSTED_PROXY_MODE', 'caddy');
    vi.stubEnv(
      'GOOGLE_OAUTH_REDIRECT_URI',
      'http://127.0.0.1:3210/api/v1/auth/google/callback',
    );

    const config = await loadConfig();

    expect(config.isPublicMode).toBe(true);
  });

  it('treats a non-localhost redirect URI alone as public mode', async () => {
    vi.stubEnv(
      'GOOGLE_OAUTH_REDIRECT_URI',
      'https://clawtalk.app/api/v1/auth/google/callback',
    );

    const config = await loadConfig();

    expect(config.isPublicMode).toBe(true);
  });

  it('keeps local-only defaults out of public mode', async () => {
    const config = await loadConfig();

    expect(config.isPublicMode).toBe(false);
  });

  it('recognizes localhost redirect URIs as local', async () => {
    const config = await loadConfig();

    expect(config.isNonLocalhostRedirectUri('')).toBe(false);
    expect(
      config.isNonLocalhostRedirectUri(
        'http://localhost:3210/api/v1/auth/google/callback',
      ),
    ).toBe(false);
    expect(
      config.isNonLocalhostRedirectUri(
        'http://127.0.0.1:3210/api/v1/auth/google/callback',
      ),
    ).toBe(false);
    expect(
      config.isNonLocalhostRedirectUri(
        'http://[::1]:3210/api/v1/auth/google/callback',
      ),
    ).toBe(false);
  });

  it('recognizes public redirect URIs as public', async () => {
    const config = await loadConfig();

    expect(
      config.isNonLocalhostRedirectUri(
        'https://clawtalk.app/api/v1/auth/google/callback',
      ),
    ).toBe(true);
  });

  it('reports preflight guard errors for unsafe public mode config', async () => {
    vi.stubEnv('PUBLIC_MODE', 'true');

    const config = await loadConfig();

    expect(config.getPublicModeConfigErrors()).toEqual(
      expect.arrayContaining([
        'AUTH_DEV_MODE must be false when public mode is enabled',
        'WEB_SECURE_COOKIES must be true when public mode is enabled',
        'TRUSTED_PROXY_MODE must be set to cloudflare or caddy when public mode is enabled',
        'GOOGLE_OAUTH_CLIENT_ID must be set when public mode is enabled',
        'GOOGLE_OAUTH_CLIENT_SECRET must be set when public mode is enabled',
        'GOOGLE_OAUTH_REDIRECT_URI must be set to a non-localhost URL when public mode is enabled',
        // PR2 C11: picker SDK env vars must be set in public mode.
        'GOOGLE_PICKER_API_KEY and GOOGLE_PICKER_APP_ID must be set when public mode is enabled',
      ]),
    );
    expect(
      config
        .getPublicModeConfigErrors()
        .some((error) =>
          error.includes('CLAWTALK_PROVIDER_SECRET_KEY must be set'),
        ),
    ).toBe(true);
  });

  it('PR2 C11: reports an error when picker SDK env vars are missing in public mode', async () => {
    applyValidPublicModeEnv();
    // Override just the picker keys to empty so the rest of the
    // configuration remains valid — isolates the picker-config check.
    vi.stubEnv('GOOGLE_PICKER_API_KEY', '');
    vi.stubEnv('GOOGLE_PICKER_APP_ID', '');

    const config = await loadConfig();

    expect(config.getPublicModeConfigErrors()).toEqual([
      'GOOGLE_PICKER_API_KEY and GOOGLE_PICKER_APP_ID must be set when public mode is enabled',
    ]);
  });

  it('accepts a complete public mode config', async () => {
    applyValidPublicModeEnv();

    const config = await loadConfig();

    expect(config.getPublicModeConfigErrors()).toEqual([]);
  });

  it('requires initial owner email or an existing owner in public mode', async () => {
    applyValidPublicModeEnv();

    const config = await loadConfig();

    expect(config.getPublicModeDatabaseErrors(false)).toEqual([
      'INITIAL_OWNER_EMAIL must be set or an owner must already exist when public mode is enabled',
    ]);
  });

  it('accepts an existing owner for the post-db guard', async () => {
    applyValidPublicModeEnv();

    const config = await loadConfig();

    expect(config.getPublicModeDatabaseErrors(true)).toEqual([]);
  });

  it('accepts INITIAL_OWNER_EMAIL for the post-db guard', async () => {
    applyValidPublicModeEnv();
    vi.stubEnv('INITIAL_OWNER_EMAIL', 'owner@example.com');

    const config = await loadConfig();

    expect(config.getPublicModeDatabaseErrors(false)).toEqual([]);
  });

  it('rejects an invalid INITIAL_OWNER_EMAIL when no owner exists', async () => {
    applyValidPublicModeEnv();
    vi.stubEnv('INITIAL_OWNER_EMAIL', 'not-an-email');

    const config = await loadConfig();

    expect(config.getPublicModeDatabaseErrors(false)).toEqual([
      'INITIAL_OWNER_EMAIL must look like an email address when public mode is enabled and no owner exists',
    ]);
  });

  it('warns when TRUSTED_PROXY_MODE is invalid', async () => {
    const loggerWarn = vi.fn();
    vi.doMock('../logger.js', () => ({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: loggerWarn,
        error: vi.fn(),
        fatal: vi.fn(),
      },
    }));
    vi.stubEnv('TRUSTED_PROXY_MODE', 'cloudflrae');

    const config = await loadConfig();

    expect(config.TRUSTED_PROXY_MODE).toBe('none');
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0]?.[1]).toContain(
      'Unrecognized TRUSTED_PROXY_MODE value',
    );
  });
});
