import { describe, expect, it, vi } from 'vitest';

const executeBrowserToolMock = vi.hoisted(() => vi.fn());

vi.mock('../tools/browser-tools.js', () => ({
  executeBrowserTool: executeBrowserToolMock,
}));

import {
  executeBrowserBridgeRequest,
  registerBrowserBridgeRunAbort,
  subscribeBrowserBridgeRunEvents,
  unregisterBrowserBridgeRunAbort,
} from './bridge.js';
import { BrowserRunPausedError } from './run-paused-error.js';

describe('browser bridge request handler', () => {
  it('returns an error payload when the bridge signal is aborted mid-request', async () => {
    const controller = new AbortController();
    executeBrowserToolMock.mockImplementation(
      async (input: { context: { signal: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          input.context.signal.addEventListener(
            'abort',
            () => {
              reject(
                input.context.signal.reason instanceof Error
                  ? input.context.signal.reason
                  : new Error(String(input.context.signal.reason)),
              );
            },
            { once: true },
          );
        }),
    );

    const pending = executeBrowserBridgeRequest({
      request: {
        requestId: 'bridge_abort_1',
        toolName: 'browser_open',
        args: {
          siteKey: 'linkedin',
          url: 'https://www.linkedin.com/feed/',
        },
        context: {
          runId: 'run-bridge',
          userId: 'owner-1',
          talkId: 'talk-1',
        },
      },
      signal: controller.signal,
    });
    controller.abort(new Error('Browser bridge client disconnected.'));

    await expect(pending).resolves.toEqual({
      requestId: 'bridge_abort_1',
      result: JSON.stringify({
        status: 'error',
        message: 'Browser bridge client disconnected.',
      }),
      isError: true,
    });
  });

  it('aborts the registered container run when a browser tool pauses the run', async () => {
    const abortSpy = vi.fn();
    registerBrowserBridgeRunAbort('run-paused', abortSpy);
    executeBrowserToolMock.mockRejectedValue(
      new BrowserRunPausedError('run-paused', {
        kind: 'auth_required',
        sessionId: 'bs_linkedin',
        siteKey: 'linkedin',
        accountLabel: null,
        url: 'https://www.linkedin.com/checkpoint/challenge',
        title: 'LinkedIn Login',
        message: 'This site requires interactive authentication.',
        riskReason: null,
        setupCommand:
          "npx tsx src/clawrocket/browser/setup.ts --site 'linkedin'",
        artifacts: [],
        confirmationId: null,
        pendingToolCall: {
          toolName: 'browser_open',
          args: {
            siteKey: 'linkedin',
            url: 'https://www.linkedin.com/messaging/',
          },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    await expect(
      executeBrowserBridgeRequest({
        request: {
          requestId: 'bridge_pause_1',
          toolName: 'browser_open',
          args: {
            siteKey: 'linkedin',
            url: 'https://www.linkedin.com/messaging/',
          },
          context: {
            runId: 'run-paused',
            userId: 'owner-1',
            talkId: 'talk-1',
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();

    expect(abortSpy).toHaveBeenCalledTimes(1);
    unregisterBrowserBridgeRunAbort('run-paused');
  });

  it('emits bridge activity and page-ready events and passes the timeout profile through', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBrowserBridgeRunEvents('run-events', listener);
    executeBrowserToolMock.mockImplementation(async (input) => {
      input.context.onPageReady?.();
      return {
        result: JSON.stringify({ status: 'ok' }),
      };
    });

    await expect(
      executeBrowserBridgeRequest({
        request: {
          requestId: 'bridge_events_1',
          toolName: 'browser_open',
          args: {
            siteKey: 'linkedin',
            url: 'https://www.linkedin.com/feed/',
          },
          context: {
            runId: 'run-events',
            userId: 'owner-1',
            talkId: 'talk-1',
            timeoutProfile: 'fast_lane',
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      requestId: 'bridge_events_1',
      result: JSON.stringify({ status: 'ok' }),
    });

    expect(executeBrowserToolMock).toHaveBeenCalledWith({
      toolName: 'browser_open',
      args: {
        siteKey: 'linkedin',
        url: 'https://www.linkedin.com/feed/',
      },
      context: {
        signal: expect.any(AbortSignal),
        runId: 'run-events',
        userId: 'owner-1',
        talkId: 'talk-1',
        timeoutProfile: 'fast_lane',
        onPageReady: expect.any(Function),
      },
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, {
      type: 'activity',
      runId: 'run-events',
      toolName: 'browser_open',
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      type: 'page_ready',
      runId: 'run-events',
      currentStep: 'Reading page access…',
    });
    unsubscribe();
  });

  it('emits page_ready before aborting a needs-auth browser_open run', async () => {
    const listener = vi.fn();
    const abortSpy = vi.fn();
    const unsubscribe = subscribeBrowserBridgeRunEvents(
      'run-needs-auth',
      listener,
    );
    registerBrowserBridgeRunAbort('run-needs-auth', abortSpy);
    executeBrowserToolMock.mockImplementation(async (input) => {
      input.context.onPageReady?.();
      throw new BrowserRunPausedError('run-needs-auth', {
        kind: 'auth_required',
        sessionId: 'bs_linkedin_auth',
        siteKey: 'linkedin',
        accountLabel: null,
        url: 'https://www.linkedin.com/checkpoint/challenge',
        title: 'LinkedIn Login',
        message: 'This site requires interactive authentication.',
        riskReason: null,
        setupCommand:
          "npx tsx src/clawrocket/browser/setup.ts --site 'linkedin'",
        artifacts: [],
        confirmationId: null,
        pendingToolCall: {
          toolName: 'browser_open',
          args: {
            siteKey: 'linkedin',
            url: 'https://www.linkedin.com/messaging/',
          },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    await expect(
      executeBrowserBridgeRequest({
        request: {
          requestId: 'bridge_needs_auth_1',
          toolName: 'browser_open',
          args: {
            siteKey: 'linkedin',
            url: 'https://www.linkedin.com/messaging/',
          },
          context: {
            runId: 'run-needs-auth',
            userId: 'owner-1',
            talkId: 'talk-1',
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, {
      type: 'activity',
      runId: 'run-needs-auth',
      toolName: 'browser_open',
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      type: 'page_ready',
      runId: 'run-needs-auth',
      currentStep: 'Reading page access…',
    });
    expect(abortSpy).toHaveBeenCalledTimes(1);

    unsubscribe();
    unregisterBrowserBridgeRunAbort('run-needs-auth');
  });

  it('emits page_ready before aborting a human-step browser_open run', async () => {
    const listener = vi.fn();
    const abortSpy = vi.fn();
    const unsubscribe = subscribeBrowserBridgeRunEvents(
      'run-human-step',
      listener,
    );
    registerBrowserBridgeRunAbort('run-human-step', abortSpy);
    executeBrowserToolMock.mockImplementation(async (input) => {
      input.context.onPageReady?.();
      throw new BrowserRunPausedError('run-human-step', {
        kind: 'human_step_required',
        sessionId: 'bs_linkedin_human',
        siteKey: 'linkedin',
        accountLabel: null,
        url: 'https://www.linkedin.com/checkpoint/challenge',
        title: 'LinkedIn Security Check',
        message: 'Complete the manual browser verification step.',
        riskReason: null,
        setupCommand:
          "npx tsx src/clawrocket/browser/setup.ts --site 'linkedin'",
        artifacts: [],
        confirmationId: null,
        pendingToolCall: {
          toolName: 'browser_open',
          args: {
            siteKey: 'linkedin',
            url: 'https://www.linkedin.com/messaging/',
          },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    await expect(
      executeBrowserBridgeRequest({
        request: {
          requestId: 'bridge_human_step_1',
          toolName: 'browser_open',
          args: {
            siteKey: 'linkedin',
            url: 'https://www.linkedin.com/messaging/',
          },
          context: {
            runId: 'run-human-step',
            userId: 'owner-1',
            talkId: 'talk-1',
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, {
      type: 'activity',
      runId: 'run-human-step',
      toolName: 'browser_open',
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      type: 'page_ready',
      runId: 'run-human-step',
      currentStep: 'Reading page access…',
    });
    expect(abortSpy).toHaveBeenCalledTimes(1);

    unsubscribe();
    unregisterBrowserBridgeRunAbort('run-human-step');
  });
});
