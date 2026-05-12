import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserServiceMocks = vi.hoisted(() => ({
  service: {
    open: vi.fn(),
    snapshot: vi.fn(),
    act: vi.fn(),
    wait: vi.fn(),
    screenshot: vi.fn(),
    close: vi.fn(),
    recordRunSessionTouch: vi.fn(),
  },
}));

vi.mock('../browser/service.js', () => ({
  getBrowserService: () => browserServiceMocks.service,
}));

import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  createTalkRun,
  getTalkStateEntry,
  getTalkRunById,
  listTalkOutputs,
  upsertTalk,
  upsertUser,
} from '../db/index.js';
import { BrowserRunPausedError } from '../browser/run-paused-error.js';
import { executeBrowserTool } from './browser-tools.js';

const TALK_ID = 'talk-browser-tools';
const THREAD_ID = 'thread-browser-tools';

function createRun(runId: string): void {
  const now = new Date().toISOString();
  createTalkRun({
    id: runId,
    talk_id: TALK_ID,
    thread_id: THREAD_ID,
    requested_by: 'owner-1',
    status: 'running',
    trigger_message_id: null,
    target_agent_id: null,
    idempotency_key: null,
    response_group_id: null,
    sequence_index: null,
    executor_alias: null,
    executor_model: null,
    source_binding_id: null,
    source_external_message_id: null,
    source_thread_key: null,
    created_at: now,
    started_at: now,
    ended_at: null,
    cancel_reason: null,
  });
}

describe('browser-tools', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertTalk({
      id: TALK_ID,
      ownerId: 'owner-1',
      topicTitle: 'Browser Tool Tests',
    });

    browserServiceMocks.service.open.mockReset();
    browserServiceMocks.service.snapshot.mockReset();
    browserServiceMocks.service.act.mockReset();
    browserServiceMocks.service.wait.mockReset();
    browserServiceMocks.service.screenshot.mockReset();
    browserServiceMocks.service.close.mockReset();
    browserServiceMocks.service.recordRunSessionTouch.mockReset();
  });

  it('pauses the Talk run and records setup guidance when browser_open needs auth', async () => {
    createRun('run-browser-open');
    const onPageReady = vi.fn();
    browserServiceMocks.service.open.mockResolvedValue({
      status: 'needs_auth',
      siteKey: 'linkedin',
      accountLabel: null,
      sessionId: 'bs_linkedin',
      url: 'https://www.linkedin.com/checkpoint/challenge',
      title: 'LinkedIn Login',
      reusedSession: false,
      createdProfile: true,
      message:
        'This site requires interactive authentication for this profile.',
    });
    browserServiceMocks.service.screenshot.mockResolvedValue({
      status: 'ok',
      siteKey: 'linkedin',
      accountLabel: null,
      url: 'https://www.linkedin.com/checkpoint/challenge',
      title: 'LinkedIn Login',
      path: '/tmp/browser-blocked-open.png',
      contentType: 'image/png',
      content: Buffer.from('png'),
    });

    await expect(
      executeBrowserTool({
        toolName: 'browser_open',
        args: {
          siteKey: 'linkedin',
          url: 'https://www.linkedin.com/messaging/',
        },
        context: {
          signal: new AbortController().signal,
          runId: 'run-browser-open',
          userId: 'owner-1',
          talkId: TALK_ID,
          onPageReady,
        },
      }),
    ).rejects.toBeInstanceOf(BrowserRunPausedError);

    expect(getTalkStateEntry(TALK_ID, 'browser.profile')?.value).toMatchObject({
      siteKey: 'linkedin',
      accountLabel: null,
    });
    expect(getTalkStateEntry(TALK_ID, 'browser.last')?.value).toMatchObject({
      status: 'needs_auth',
      url: 'https://www.linkedin.com/checkpoint/challenge',
    });
    expect(getTalkStateEntry(TALK_ID, 'browser.pending')?.value).toMatchObject({
      reason: 'auth_required',
      siteKey: 'linkedin',
      actionSummary: 'Open https://www.linkedin.com/checkpoint/challenge',
    });
    expect(getTalkRunById('run-browser-open')?.status).toBe(
      'awaiting_confirmation',
    );
    expect(onPageReady).toHaveBeenCalledTimes(1);
    expect(listTalkOutputs(TALK_ID)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Browser auth required: linkedin',
        }),
      ]),
    );
  });

  it('reuses an existing trusted session without suggesting setup again when browser_open is still blocked', async () => {
    createRun('run-browser-open-reuse');
    browserServiceMocks.service.open.mockResolvedValue({
      status: 'needs_auth',
      siteKey: 'linkedin',
      accountLabel: null,
      sessionId: 'bs_linkedin',
      url: 'https://www.linkedin.com/checkpoint/challenge',
      title: 'Approve sign in',
      reusedSession: true,
      createdProfile: false,
      message:
        'LinkedIn is waiting for phone or app approval on a trusted device.',
    });
    browserServiceMocks.service.screenshot.mockResolvedValue({
      status: 'ok',
      siteKey: 'linkedin',
      accountLabel: null,
      url: 'https://www.linkedin.com/checkpoint/challenge',
      title: 'Approve sign in',
      path: '/tmp/browser-blocked-open-reuse.png',
      contentType: 'image/png',
      content: Buffer.from('png'),
    });

    await expect(
      executeBrowserTool({
        toolName: 'browser_open',
        args: {
          siteKey: 'linkedin',
          url: 'https://www.linkedin.com/messaging/',
        },
        context: {
          signal: new AbortController().signal,
          runId: 'run-browser-open-reuse',
          userId: 'owner-1',
          talkId: TALK_ID,
        },
      }),
    ).rejects.toBeInstanceOf(BrowserRunPausedError);

    expect(getTalkStateEntry(TALK_ID, 'browser.pending')?.value).toMatchObject({
      reason: 'auth_required',
      siteKey: 'linkedin',
      url: 'https://www.linkedin.com/checkpoint/challenge',
      setupCommand: null,
      message:
        'LinkedIn is waiting for phone or app approval on a trusted device.',
    });
    expect(getTalkRunById('run-browser-open-reuse')?.status).toBe(
      'awaiting_confirmation',
    );
  });

  it('emits periodic progress callbacks while a browser tool is still running', async () => {
    vi.useFakeTimers();
    createRun('run-browser-progress');
    const onProgress = vi.fn();
    browserServiceMocks.service.open.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              status: 'ok',
              siteKey: 'linkedin',
              accountLabel: null,
              sessionId: 'bs_linkedin_progress',
              url: 'https://www.linkedin.com/messaging/',
              title: 'LinkedIn Messaging',
              reusedSession: true,
              createdProfile: false,
              message: 'Opened existing session.',
            });
          }, 21_000);
        }),
    );

    const pending = executeBrowserTool({
      toolName: 'browser_open',
      args: {
        siteKey: 'linkedin',
        url: 'https://www.linkedin.com/messaging/',
      },
      context: {
        signal: new AbortController().signal,
        runId: 'run-browser-progress',
        userId: 'owner-1',
        talkId: TALK_ID,
        onProgress,
      },
    });

    await vi.advanceTimersByTimeAsync(21_000);
    await expect(pending).resolves.toEqual({
      result: expect.stringContaining('"status":"ok"'),
    });
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, 'Opening linkedin…');
    expect(onProgress).toHaveBeenNthCalledWith(2, 'Opening linkedin…');
    expect(onProgress).toHaveBeenNthCalledWith(3, 'Opening linkedin…');
    vi.useRealTimers();
  });

  it('uses fast-lane browser_open defaults and marks the page ready callback', async () => {
    createRun('run-browser-fast-open');
    const onPageReady = vi.fn();
    browserServiceMocks.service.open.mockResolvedValue({
      status: 'ok',
      siteKey: 'linkedin',
      accountLabel: null,
      sessionId: 'bs_linkedin_fast',
      url: 'https://www.linkedin.com/messaging/',
      title: 'LinkedIn Messaging',
      reusedSession: true,
      createdProfile: false,
      message: 'Browser session ready.',
    });

    await expect(
      executeBrowserTool({
        toolName: 'browser_open',
        args: {
          siteKey: 'linkedin',
          url: 'https://www.linkedin.com/messaging/',
        },
        context: {
          signal: new AbortController().signal,
          runId: 'run-browser-fast-open',
          userId: 'owner-1',
          talkId: TALK_ID,
          timeoutProfile: 'fast_lane',
          onPageReady,
        },
      }),
    ).resolves.toEqual({
      result: expect.stringContaining('"status":"ok"'),
    });

    expect(browserServiceMocks.service.open).toHaveBeenCalledWith({
      siteKey: 'linkedin',
      url: 'https://www.linkedin.com/messaging/',
      accountLabel: null,
      headed: false,
      userId: 'owner-1',
      runId: 'run-browser-fast-open',
      reuseSession: true,
      onPageReady: expect.any(Function),
      navigationTimeoutMs: 8000,
      retryOnInitialTimeout: true,
    });
    expect(onPageReady).toHaveBeenCalledTimes(1);
  });

  it('uses fast-lane action and wait timeouts when none are supplied', async () => {
    createRun('run-browser-fast-actions');
    browserServiceMocks.service.act.mockResolvedValue({
      status: 'ok',
      siteKey: 'linkedin',
      accountLabel: null,
      url: 'https://www.linkedin.com/feed/',
      title: 'LinkedIn',
      message: 'Browser action completed.',
    });
    browserServiceMocks.service.wait.mockResolvedValue({
      status: 'ok',
      siteKey: 'linkedin',
      accountLabel: null,
      url: 'https://www.linkedin.com/feed/',
      title: 'LinkedIn',
      message: 'Wait completed.',
    });

    await executeBrowserTool({
      toolName: 'browser_act',
      args: {
        sessionId: 'bs_linkedin_fast',
        action: 'click',
        target: 'button-1',
      },
      context: {
        signal: new AbortController().signal,
        runId: 'run-browser-fast-actions',
        userId: 'owner-1',
        timeoutProfile: 'fast_lane',
      },
    });
    await executeBrowserTool({
      toolName: 'browser_wait',
      args: {
        sessionId: 'bs_linkedin_fast',
        conditionType: 'load',
      },
      context: {
        signal: new AbortController().signal,
        runId: 'run-browser-fast-actions',
        userId: 'owner-1',
        timeoutProfile: 'fast_lane',
      },
    });

    expect(browserServiceMocks.service.act).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 5000,
      }),
      expect.anything(),
    );
    expect(browserServiceMocks.service.wait).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 5000,
      }),
    );
  });

  it('pauses the Talk run and records confirmation-required browser_act state', async () => {
    createRun('run-browser-act');
    browserServiceMocks.service.act.mockResolvedValue({
      status: 'awaiting_confirmation',
      siteKey: 'delta',
      accountLabel: null,
      url: 'https://www.delta.com/checkout/review',
      title: 'Review Trip',
      message: 'Action requires confirmation before proceeding.',
      riskReason: 'Target appears to be a likely final-action control.',
    });
    browserServiceMocks.service.screenshot.mockResolvedValue({
      status: 'ok',
      siteKey: 'delta',
      accountLabel: null,
      url: 'https://www.delta.com/checkout/review',
      title: 'Review Trip',
      path: '/tmp/browser-blocked-act.png',
      contentType: 'image/png',
      content: Buffer.from('png'),
    });

    await expect(
      executeBrowserTool({
        toolName: 'browser_act',
        args: {
          sessionId: 'bs_delta',
          action: 'click',
          target: 'e12',
        },
        context: {
          signal: new AbortController().signal,
          runId: 'run-browser-act',
          userId: 'owner-1',
          talkId: TALK_ID,
        },
      }),
    ).rejects.toBeInstanceOf(BrowserRunPausedError);

    expect(getTalkStateEntry(TALK_ID, 'browser.pending')?.value).toMatchObject({
      reason: 'confirmation_required',
      siteKey: 'delta',
      actionSummary: 'click target=e12',
      riskReason: 'Target appears to be a likely final-action control.',
    });
    expect(getTalkRunById('run-browser-act')?.status).toBe(
      'awaiting_confirmation',
    );
    expect(listTalkOutputs(TALK_ID)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Browser confirmation required: delta',
        }),
      ]),
    );
  });

  it('persists browser screenshots into Talk attachments when requested', async () => {
    createRun('run-browser-screenshot');
    browserServiceMocks.service.screenshot.mockResolvedValue({
      status: 'ok',
      siteKey: 'irs',
      accountLabel: null,
      url: 'https://www.irs.gov/forms',
      title: 'IRS Forms',
      path: '/tmp/browser-screenshot.png',
      contentType: 'image/png',
      content: Buffer.from('png-bytes'),
    });

    const result = await executeBrowserTool({
      toolName: 'browser_screenshot',
      args: {
        sessionId: 'bs_irs',
        saveToTalk: true,
        label: 'irs-form',
      },
      context: {
        signal: new AbortController().signal,
        runId: 'run-browser-screenshot',
        userId: 'owner-1',
        talkId: TALK_ID,
      },
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.result) as {
      artifact: { attachmentId: string; fileName: string };
    };
    expect(parsed.artifact.fileName).toBe('irs-form.png');

    const attachmentRow = getDb()
      .prepare(
        `SELECT mime_type, file_name, extraction_status FROM talk_message_attachments WHERE id = ?`,
      )
      .get(parsed.artifact.attachmentId) as
      | {
          mime_type: string;
          file_name: string;
          extraction_status: string;
        }
      | undefined;

    expect(attachmentRow).toEqual({
      mime_type: 'image/png',
      file_name: 'irs-form.png',
      extraction_status: 'ready',
    });
  });

  it('returns an error result when the browser tool signal is aborted mid-call', async () => {
    const controller = new AbortController();
    browserServiceMocks.service.open.mockImplementation(
      async () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => {
              reject(controller.signal.reason);
            },
            { once: true },
          );
        }),
    );

    const pending = executeBrowserTool({
      toolName: 'browser_open',
      args: {
        siteKey: 'linkedin',
        url: 'https://www.linkedin.com/feed/',
      },
      context: {
        signal: controller.signal,
        runId: 'run-browser-abort',
        userId: 'owner-1',
        talkId: TALK_ID,
      },
    });

    controller.abort(new Error('Container bridge client disconnected.'));

    await expect(pending).resolves.toEqual({
      result: JSON.stringify({
        status: 'error',
        message: 'Container bridge client disconnected.',
      }),
      isError: true,
    });
  });
});
