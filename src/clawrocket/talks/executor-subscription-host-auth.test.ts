import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExecutorSubscriptionHostAuthService } from './executor-subscription-host-auth.js';

describe('ExecutorSubscriptionHostAuthService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prefers service-env oauth tokens as an importable host source', async () => {
    const service = new ExecutorSubscriptionHostAuthService({
      env: {
        USER: 'clawrocket',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-host-token',
      },
      serviceUser: 'clawrocket',
      serviceUid: 1001,
      serviceHomePath: '/srv/clawrocket',
      runCommand: vi.fn(async () => ({ stdout: '1.0.0', stderr: '' })),
    });

    const status = await service.getStatusView();
    const probe = await service.probeImportSource();

    expect(status.serviceEnvOauthPresent).toBe(true);
    expect(status.hostLoginDetected).toBe(true);
    expect(status.importAvailable).toBe(true);
    expect(status.hostCredentialFingerprint).toBeTruthy();
    expect(probe.importSource).toBe('service_env');
    expect(probe.importCredential).toBe('oauth-host-token');
  });

  it('reports missing Claude CLI cleanly', async () => {
    const service = new ExecutorSubscriptionHostAuthService({
      env: {
        USER: 'clawrocket',
      },
      serviceUser: 'clawrocket',
      serviceUid: 1001,
      serviceHomePath: '/srv/clawrocket',
      runCommand: vi.fn(async () => {
        const error = new Error('not found') as Error & { code?: string };
        error.code = 'ENOENT';
        throw error;
      }),
    });

    const status = await service.getStatusView();

    expect(status.claudeCliInstalled).toBe(false);
    expect(status.hostLoginDetected).toBe(false);
    expect(status.importAvailable).toBe(false);
    expect(status.message).toContain('CLI was not found');
  });

  it('detects logged-in Claude CLI state even when auto-import is unavailable', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '1.0.0', stderr: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'oauth',
          apiProvider: 'firstParty',
        }),
        stderr: '',
      });

    const service = new ExecutorSubscriptionHostAuthService({
      env: {
        USER: 'clawrocket',
      },
      serviceUser: 'clawrocket',
      serviceUid: 1001,
      serviceHomePath: '/srv/clawrocket',
      runCommand,
    });

    const status = await service.getStatusView();

    expect(status.claudeCliInstalled).toBe(true);
    expect(status.hostLoginDetected).toBe(true);
    expect(status.importAvailable).toBe(false);
    expect(status.message).toContain('could not be imported automatically');
  });

  it('times out stale host probes instead of hanging forever', async () => {
    vi.useFakeTimers();
    const service = new ExecutorSubscriptionHostAuthService({
      env: {
        USER: 'clawrocket',
      },
      serviceUser: 'clawrocket',
      serviceUid: 1001,
      serviceHomePath: '/srv/clawrocket',
      runCommand: vi.fn(
        async () =>
          await new Promise<{ stdout: string; stderr: string }>(() => {
            // Intentionally never resolves.
          }),
      ),
    });

    const promise = service.getStatusView();
    await vi.advanceTimersByTimeAsync(5_100);
    const status = await promise;

    expect(status.importAvailable).toBe(false);
    expect(status.message).toContain('timed out');
  });
});
