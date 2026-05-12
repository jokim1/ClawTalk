import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../../db.js';

const browserServiceMocks = vi.hoisted(() => ({
  service: {
    getSessionStatus: vi.fn(),
    getSessionTouchedRunIds: vi.fn(),
    close: vi.fn(),
    resumeTakeover: vi.fn(),
  },
}));

vi.mock('../../browser/service.js', () => ({
  getBrowserService: () => browserServiceMocks.service,
}));

import {
  _initTestDatabase,
  enqueueMainTurnAtomic,
  getTalkRunById,
  upsertUser,
  updateTalkRunMetadata,
} from '../../db/index.js';
import {
  cancelConflictingBrowserRunRoute,
  createBrowserProfileRoute,
  deleteBrowserProfileRoute,
  discoverChromeSubprofiles,
  discoverChromeSubprofilesRoute,
  discoverChromeUserDataDirectories,
  discoverChromeUserDataDirectoriesRoute,
  getBrowserSessionStatusRoute,
  listBrowserProfilesRoute,
  releaseBrowserProfileSessionsRoute,
  resumeBrowserBlockedRunRoute,
} from './browser.js';
import type { AuthContext } from '../types.js';

function makeAuth(
  userId: string,
  role: AuthContext['role'] = 'owner',
): AuthContext {
  return {
    userId,
    sessionId: `session-${userId}`,
    role,
    authType: 'cookie',
  };
}

describe('browser routes', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'user-a',
      email: 'a@example.com',
      displayName: 'User A',
      role: 'owner',
    });
    upsertUser({
      id: 'user-b',
      email: 'b@example.com',
      displayName: 'User B',
      role: 'owner',
    });

    browserServiceMocks.service.getSessionStatus.mockReset();
    browserServiceMocks.service.getSessionTouchedRunIds.mockReset();
    browserServiceMocks.service.close.mockReset();
    browserServiceMocks.service.resumeTakeover.mockReset();
    browserServiceMocks.service.resumeTakeover.mockResolvedValue(undefined);
  });

  it('returns browser session status for an authorized Main run owner', async () => {
    const runId = 'run-main-browser';
    enqueueMainTurnAtomic({
      threadId: 'thread-main-browser',
      userId: 'user-a',
      content: 'Check LinkedIn',
      messageId: 'msg-main-browser',
      runId,
    });

    browserServiceMocks.service.getSessionStatus.mockResolvedValue({
      sessionId: 'session-1',
      siteKey: 'linkedin',
      accountLabel: null,
      headed: false,
      state: 'blocked',
      owner: 'agent',
      blockedKind: 'auth_required',
      blockedMessage: 'Authenticate to continue.',
      currentUrl: 'https://www.linkedin.com/checkpoint/challenge',
      currentTitle: 'Approve sign in',
      lastUpdatedAt: new Date().toISOString(),
    });
    browserServiceMocks.service.getSessionTouchedRunIds.mockReturnValue([
      runId,
    ]);

    const result = await getBrowserSessionStatusRoute({
      auth: makeAuth('user-a'),
      sessionId: 'session-1',
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data).toMatchObject({
        sessionId: 'session-1',
        state: 'blocked',
        blockedKind: 'auth_required',
      });
    }
  });

  it('rejects browser session status for a different user', async () => {
    const runId = 'run-main-browser';
    enqueueMainTurnAtomic({
      threadId: 'thread-main-browser',
      userId: 'user-a',
      content: 'Check LinkedIn',
      messageId: 'msg-main-browser',
      runId,
    });

    browserServiceMocks.service.getSessionStatus.mockResolvedValue({
      sessionId: 'session-1',
      siteKey: 'linkedin',
      accountLabel: null,
      headed: false,
      state: 'blocked',
      owner: 'agent',
      blockedKind: 'auth_required',
      blockedMessage: 'Authenticate to continue.',
      currentUrl: 'https://www.linkedin.com/checkpoint/challenge',
      currentTitle: 'Approve sign in',
      lastUpdatedAt: new Date().toISOString(),
    });
    browserServiceMocks.service.getSessionTouchedRunIds.mockReturnValue([
      runId,
    ]);

    const result = await getBrowserSessionStatusRoute({
      auth: makeAuth('user-b'),
      sessionId: 'session-1',
    });

    expect(result.statusCode).toBe(404);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error.code).toBe('browser_session_not_found');
    }
  });

  it('defers resume when another main run is queued', async () => {
    const pausedRunId = 'run-paused';
    enqueueMainTurnAtomic({
      threadId: 'thread-main-browser',
      userId: 'user-a',
      content: 'Check LinkedIn',
      messageId: 'msg-main-browser',
      runId: pausedRunId,
    });
    updateTalkRunMetadata(pausedRunId, (current) => ({
      ...current,
      browserBlock: {
        kind: 'auth_required',
        sessionId: 'session-1',
        siteKey: 'linkedin',
        accountLabel: null,
        url: 'https://www.linkedin.com/login',
        title: 'LinkedIn Login',
        message: 'Authenticate to continue.',
        riskReason: null,
        setupCommand: null,
        artifacts: [],
        confirmationId: null,
        pendingToolCall: null,
        createdAt: '2026-03-21T20:00:00.000Z',
        updatedAt: '2026-03-21T20:00:00.000Z',
      },
    }));
    getDb()
      .prepare(
        `UPDATE talk_runs SET status = 'awaiting_confirmation' WHERE id = ?`,
      )
      .run(pausedRunId);

    enqueueMainTurnAtomic({
      threadId: 'thread-main-browser',
      userId: 'user-a',
      content: 'Second message',
      messageId: 'msg-main-browser-2',
      runId: 'run-queued',
    });

    const result = await resumeBrowserBlockedRunRoute({
      auth: makeAuth('user-a'),
      runId: pausedRunId,
      note: null,
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data.queueState).toBe('deferred');
    }
    const pausedRun = getTalkRunById(pausedRunId);
    expect(pausedRun?.status).toBe('awaiting_confirmation');
    const metadata = JSON.parse(pausedRun?.metadata_json || '{}') as {
      browserBlock?: unknown;
      resumeRequestedAt?: string;
    };
    expect(metadata.resumeRequestedAt).toBeTruthy();
    expect(metadata.browserBlock).toBeTruthy();
  });

  it('cancels the conflicting browser run and queues the waiting run', async () => {
    const ownerRunId = 'run-owner';
    enqueueMainTurnAtomic({
      threadId: 'thread-main-browser',
      userId: 'user-a',
      content: 'Open LinkedIn',
      messageId: 'msg-main-browser',
      runId: ownerRunId,
    });
    updateTalkRunMetadata(ownerRunId, (current) => ({
      ...current,
      browserBlock: {
        kind: 'auth_required',
        sessionId: 'session-1',
        siteKey: 'linkedin',
        accountLabel: null,
        url: 'https://www.linkedin.com/login',
        title: 'LinkedIn Login',
        message: 'Authenticate to continue.',
        riskReason: null,
        setupCommand: null,
        artifacts: [],
        confirmationId: null,
        pendingToolCall: null,
        createdAt: '2026-03-21T20:00:00.000Z',
        updatedAt: '2026-03-21T20:00:00.000Z',
      },
    }));
    getDb()
      .prepare(
        `UPDATE talk_runs SET status = 'awaiting_confirmation' WHERE id = ?`,
      )
      .run(ownerRunId);

    enqueueMainTurnAtomic({
      threadId: 'thread-main-browser',
      userId: 'user-a',
      content: 'Try again',
      messageId: 'msg-main-browser-2',
      runId: 'run-waiting',
    });
    updateTalkRunMetadata('run-waiting', (current) => ({
      ...current,
      browserBlock: {
        kind: 'session_conflict',
        sessionId: 'session-1',
        siteKey: 'linkedin',
        accountLabel: null,
        conflictingRunId: ownerRunId,
        conflictingSessionId: 'session-1',
        conflictingRunSummary: 'Open LinkedIn',
        url: 'https://www.linkedin.com/login',
        title: 'LinkedIn Login',
        message:
          'Another paused browser task already owns the LinkedIn session.',
        riskReason: 'session_conflict',
        setupCommand: null,
        artifacts: [],
        confirmationId: null,
        pendingToolCall: null,
        createdAt: '2026-03-21T20:01:00.000Z',
        updatedAt: '2026-03-21T20:01:00.000Z',
      },
    }));
    getDb()
      .prepare(
        `UPDATE talk_runs SET status = 'awaiting_confirmation' WHERE id = ?`,
      )
      .run('run-waiting');

    const result = await cancelConflictingBrowserRunRoute({
      auth: makeAuth('user-a'),
      runId: 'run-waiting',
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(getTalkRunById(ownerRunId)?.status).toBe('cancelled');
    expect(getTalkRunById('run-waiting')?.status).toBe('queued');
  });

  it('discovers Chrome user data directories for the current platform', () => {
    const discovery = discoverChromeUserDataDirectories({
      platform: 'darwin',
      homeDir: '/Users/alice',
      isDirectory: (targetPath) =>
        targetPath ===
          '/Users/alice/Library/Application Support/Google/Chrome' ||
        targetPath === '/Users/alice/Library/Application Support/Chromium',
    });

    expect(discovery).toEqual({
      platform: 'darwin',
      defaultPathHint: '/Users/alice/Library/Application Support/Google/Chrome',
      candidates: [
        {
          id: 'google-chrome',
          label: 'Google Chrome',
          path: '/Users/alice/Library/Application Support/Google/Chrome',
          preferred: true,
        },
        {
          id: 'chromium',
          label: 'Chromium',
          path: '/Users/alice/Library/Application Support/Chromium',
          preferred: false,
        },
      ],
    });
  });

  it('discovers Chrome subprofiles from Local State metadata', () => {
    const userDataDir =
      '/Users/alice/Library/Application Support/Google/Chrome';
    const discovery = discoverChromeSubprofiles({
      userDataDir,
      isDirectory: (targetPath) =>
        targetPath === path.join(userDataDir, 'Default') ||
        targetPath === path.join(userDataDir, 'Profile 4'),
      pathExists: (targetPath) => targetPath.endsWith('/Preferences'),
      readDirNames: () => ['Default', 'Profile 4', 'System Profile'],
      readFile: () =>
        JSON.stringify({
          profile: {
            last_used: 'Profile 4',
            info_cache: {
              Default: {
                name: 'Person 1',
                gaia_name: 'Alice Example',
                user_name: 'alice@gmail.com',
                is_using_default_name: true,
              },
              'Profile 4': {
                name: 'Work',
                gaia_name: 'Alice Example',
                user_name: 'alice@work.com',
                is_using_default_name: false,
              },
            },
          },
        }),
    });

    expect(discovery).toEqual({
      userDataDir,
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
    });
  });

  it('restricts Chrome path discovery to the owner role', () => {
    const result = discoverChromeUserDataDirectoriesRoute({
      auth: makeAuth('user-a', 'admin'),
    });

    expect(result.statusCode).toBe(403);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error.code).toBe('forbidden');
    }
  });

  it('restricts Chrome subprofile discovery to the owner role', () => {
    const result = discoverChromeSubprofilesRoute({
      auth: makeAuth('user-a', 'admin'),
      userDataDir: '/Users/alice/Library/Application Support/Google/Chrome',
    });

    expect(result.statusCode).toBe(403);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error.code).toBe('forbidden');
    }
  });

  it('stores a selected Chrome subprofile directory on create', () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'clawrocket-browser-route-'),
    );
    const chromeUserDataDir = path.join(tempRoot, 'Chrome');
    fs.mkdirSync(path.join(chromeUserDataDir, 'Profile 4'), {
      recursive: true,
    });

    const result = createBrowserProfileRoute({
      auth: makeAuth('user-a'),
      siteKey: 'linkedin',
      connectionMode: 'chrome_profile',
      connectionConfig: {
        chromeProfilePath: chromeUserDataDir,
        profileDirectory: 'Profile 4',
      },
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data.profile.connectionConfig).toEqual({
        mode: 'chrome_profile',
        chromeProfilePath: chromeUserDataDir,
        profileDirectory: 'Profile 4',
      });
    }
  });

  it('rejects duplicate add requests for an existing browser profile', () => {
    const created = createBrowserProfileRoute({
      auth: makeAuth('user-a'),
      siteKey: 'linkedin',
    });

    expect(created.statusCode).toBe(200);
    expect(created.body.ok).toBe(true);

    const result = createBrowserProfileRoute({
      auth: makeAuth('user-a'),
      siteKey: 'linkedin',
      connectionMode: 'chrome_profile',
    });

    expect(result.statusCode).toBe(409);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error.code).toBe('profile_exists');
      expect(result.body.error.message).toContain(
        'A browser profile for linkedin already exists and is using Managed.',
      );
      expect(result.body.error.message).toContain('Use Edit to change it');
    }
  });

  it('lists browser profiles with in-use session state', () => {
    const created = createBrowserProfileRoute({
      auth: makeAuth('user-a'),
      siteKey: 'linkedin',
    });

    expect(created.body.ok).toBe(true);
    if (!created.body.ok) {
      throw new Error('Expected profile creation to succeed');
    }

    getDb()
      .prepare(
        `
        INSERT INTO browser_sessions (
          id, user_id, profile_id, profile_key, site_key, account_label,
          state, blocked_reason, owner_run_id, last_seen_at, last_live_context_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        'bs-linkedin-active',
        'user-a',
        created.body.data.profile.id,
        'linkedin',
        'linkedin',
        null,
        'blocked',
        'phone_approval',
        null,
        '2026-03-27T22:10:00.000Z',
        '2026-03-27T22:10:00.000Z',
        '2026-03-27T22:10:00.000Z',
        '2026-03-27T22:10:00.000Z',
      );

    const result = listBrowserProfilesRoute({
      auth: makeAuth('user-a'),
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data.profiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: created.body.data.profile.id,
            inUseSessionCount: 1,
            currentSessionState: 'blocked',
          }),
        ]),
      );
    }
  });

  it('deletes a browser profile when it is not in use', () => {
    const created = createBrowserProfileRoute({
      auth: makeAuth('user-a'),
      siteKey: 'linkedin',
    });

    expect(created.body.ok).toBe(true);
    if (!created.body.ok) {
      throw new Error('Expected profile creation to succeed');
    }

    const result = deleteBrowserProfileRoute({
      auth: makeAuth('user-a'),
      profileId: created.body.data.profile.id,
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data).toEqual({
        profileId: created.body.data.profile.id,
      });
    }
  });

  it('rejects deleting a browser profile while it still has nonterminal sessions', () => {
    const created = createBrowserProfileRoute({
      auth: makeAuth('user-a'),
      siteKey: 'linkedin',
    });

    expect(created.body.ok).toBe(true);
    if (!created.body.ok) {
      throw new Error('Expected profile creation to succeed');
    }

    getDb()
      .prepare(
        `
        INSERT INTO browser_sessions (
          id, user_id, profile_id, profile_key, site_key, account_label,
          state, blocked_reason, owner_run_id, last_seen_at, last_live_context_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        'bs-linkedin-open',
        'user-a',
        created.body.data.profile.id,
        'linkedin',
        'linkedin',
        null,
        'active',
        null,
        null,
        '2026-03-27T22:15:00.000Z',
        '2026-03-27T22:15:00.000Z',
        '2026-03-27T22:15:00.000Z',
        '2026-03-27T22:15:00.000Z',
      );

    const result = deleteBrowserProfileRoute({
      auth: makeAuth('user-a'),
      profileId: created.body.data.profile.id,
    });

    expect(result.statusCode).toBe(409);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error.code).toBe('active_session_exists');
    }
  });

  it('releases stale blocking sessions for a browser profile', async () => {
    const created = createBrowserProfileRoute({
      auth: makeAuth('user-a'),
      siteKey: 'linkedin',
    });

    expect(created.body.ok).toBe(true);
    if (!created.body.ok) {
      throw new Error('Expected profile creation to succeed');
    }

    getDb()
      .prepare(
        `
        INSERT INTO browser_sessions (
          id, user_id, profile_id, profile_key, site_key, account_label,
          state, blocked_reason, owner_run_id, last_seen_at, last_live_context_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        'bs-linkedin-stale',
        'user-a',
        created.body.data.profile.id,
        'linkedin',
        'linkedin',
        null,
        'blocked',
        'login_required',
        null,
        '2026-03-27T21:50:00.000Z',
        '2026-03-27T21:50:00.000Z',
        '2026-03-27T21:50:00.000Z',
        '2026-03-27T21:50:00.000Z',
      );

    browserServiceMocks.service.getSessionStatus.mockResolvedValue(null);

    const result = await releaseBrowserProfileSessionsRoute({
      auth: makeAuth('user-a'),
      profileId: created.body.data.profile.id,
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data).toEqual({
        releasedCount: 1,
        liveReleasedCount: 0,
        staleReleasedCount: 1,
      });
    }

    const session = getDb()
      .prepare(
        `SELECT state, last_live_context_at FROM browser_sessions WHERE id = ?`,
      )
      .get('bs-linkedin-stale') as
      | { state: string; last_live_context_at: string | null }
      | undefined;
    expect(session).toEqual({
      state: 'disconnected',
      last_live_context_at: null,
    });
  });

  it('closes live blocking sessions for a browser profile', async () => {
    const created = createBrowserProfileRoute({
      auth: makeAuth('user-a'),
      siteKey: 'linkedin',
    });

    expect(created.body.ok).toBe(true);
    if (!created.body.ok) {
      throw new Error('Expected profile creation to succeed');
    }

    getDb()
      .prepare(
        `
        INSERT INTO browser_sessions (
          id, user_id, profile_id, profile_key, site_key, account_label,
          state, blocked_reason, owner_run_id, last_seen_at, last_live_context_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        'bs-linkedin-live',
        'user-a',
        created.body.data.profile.id,
        'linkedin',
        'linkedin',
        null,
        'takeover',
        'manual_takeover',
        null,
        '2026-03-27T22:00:00.000Z',
        '2026-03-27T22:00:00.000Z',
        '2026-03-27T22:00:00.000Z',
        '2026-03-27T22:00:00.000Z',
      );

    browserServiceMocks.service.getSessionStatus.mockResolvedValue({
      sessionId: 'bs-linkedin-live',
      siteKey: 'linkedin',
      accountLabel: null,
      headed: true,
      state: 'takeover',
      owner: 'user',
      blockedKind: null,
      blockedMessage: null,
      currentUrl: 'https://www.linkedin.com/feed/',
      currentTitle: 'LinkedIn',
      lastUpdatedAt: '2026-03-27T22:00:00.000Z',
    });
    browserServiceMocks.service.close.mockResolvedValue({
      status: 'ok',
      siteKey: 'linkedin',
      accountLabel: null,
      message: 'Browser session closed.',
    });

    const result = await releaseBrowserProfileSessionsRoute({
      auth: makeAuth('user-a'),
      profileId: created.body.data.profile.id,
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data).toEqual({
        releasedCount: 1,
        liveReleasedCount: 1,
        staleReleasedCount: 0,
      });
    }
    expect(browserServiceMocks.service.close).toHaveBeenCalledWith({
      sessionId: 'bs-linkedin-live',
      userId: 'user-a',
    });
  });
});
