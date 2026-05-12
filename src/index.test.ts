import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('runAgent', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fails fast before starting the container when executor auth is blocked', async () => {
    const runContainerAgent = vi.fn();

    vi.doMock('./clawrocket/talks/executor-settings.js', () => ({
      getActiveExecutorSettingsService: () => ({
        getExecutionBlockedReason: () =>
          'Anthropic credentials are not configured for the selected core executor mode.',
      }),
    }));

    vi.doMock('./container-runner.js', async () => {
      const actual = await vi.importActual<
        typeof import('./container-runner.js')
      >('./container-runner.js');
      return {
        ...actual,
        runContainerAgent,
      };
    });

    const { runAgent } = await import('./index.js');

    const result = await runAgent(
      {
        name: 'Blocked Group',
        folder: 'blocked-group',
        trigger: '@blocked',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: false,
      },
      'Hello',
      'chat:blocked',
    );

    expect(result).toBe('error');
    expect(runContainerAgent).not.toHaveBeenCalled();
  });

  it('requires connected channels when web mode is disabled', async () => {
    const { shouldRequireConnectedChannels } = await import('./index.js');

    expect(shouldRequireConnectedChannels(false)).toBe(true);
  });

  it('allows web-only startup without connected channels when web mode is enabled', async () => {
    const { shouldRequireConnectedChannels } = await import('./index.js');

    expect(shouldRequireConnectedChannels(true)).toBe(false);
  });
});
