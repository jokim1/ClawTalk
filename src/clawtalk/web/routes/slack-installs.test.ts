// Route-level tests for slack-installs.
//
// Covers the parts of the route module that don't require a live Postgres
// connection — the htmlSafeJson helper (XSS regression guard), the bare
// callback paths (no state → invalid response), and admin-gating on the
// start/delete routes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../db.js')>('../../../db.js');
  return {
    ...actual,
    withUserContext: async <T>(_userId: string, fn: () => Promise<T>) => fn(),
  };
});

vi.mock('../../connectors/slack-oauth-service.js', () => ({
  SlackOAuthError: class extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status = 400) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  completeSlackInstallCallback: vi.fn(),
  startSlackInstall: vi.fn(),
}));

vi.mock('../../db/slack-installs-accessors.js', () => ({
  deleteWorkspaceSlackInstall: vi.fn(),
  listWorkspaceSlackInstalls: vi.fn(),
}));

import {
  deleteWorkspaceSlackInstallRoute,
  handleSlackCallback,
  htmlSafeJson,
  listWorkspaceSlackInstallsRoute,
  startSlackInstallRoute,
} from './slack-installs.js';
import {
  completeSlackInstallCallback,
  startSlackInstall,
} from '../../connectors/slack-oauth-service.js';
import {
  deleteWorkspaceSlackInstall,
  listWorkspaceSlackInstalls,
} from '../../db/slack-installs-accessors.js';
import type { AuthContext } from '../types.js';

const ADMIN_AUTH: AuthContext = {
  sessionId: 'session-1',
  userId: '11111111-1111-1111-1111-111111111111',
  role: 'owner',
  authType: 'cookie',
};

const MEMBER_AUTH: AuthContext = {
  ...ADMIN_AUTH,
  role: 'member',
};

const startMock = vi.mocked(startSlackInstall);
const completeMock = vi.mocked(completeSlackInstallCallback);
const listMock = vi.mocked(listWorkspaceSlackInstalls);
const deleteMock = vi.mocked(deleteWorkspaceSlackInstall);

beforeEach(() => {
  startMock.mockReset();
  completeMock.mockReset();
  listMock.mockReset();
  deleteMock.mockReset();
});

afterEach(() => {
  startMock.mockReset();
  completeMock.mockReset();
  listMock.mockReset();
  deleteMock.mockReset();
});

describe('htmlSafeJson (XSS regression guard)', () => {
  it('escapes </ so the payload cannot close a <script> tag', () => {
    const out = htmlSafeJson({
      type: 'clawtalk:slack-workspace-install',
      status: 'error',
      message: '</script><script>alert(1)</script>',
    });
    expect(out).not.toContain('</script><script>');
    expect(out).toContain('\\u003c');
  });

  it('escapes ampersands and JS line terminators', () => {
    const out = htmlSafeJson({ message: 'a & b c d' });
    expect(out).toContain('\\u0026');
    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
    expect(out).not.toMatch(new RegExp('[\\u2028\\u2029]'));
  });
});

describe('handleSlackCallback', () => {
  it('returns 400 + error popup when state is missing', async () => {
    const result = await handleSlackCallback({
      state: null,
      code: null,
      error: null,
    });
    expect(result.statusCode).toBe(400);
    expect(result.html).toContain('clawtalk:slack-workspace-install');
    expect(result.html).toContain('"status":"error"');
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('returns 200 + success popup on successful completion', async () => {
    completeMock.mockResolvedValueOnce({
      status: 'success',
      teamId: 'T01ABCDE',
      teamName: 'Eng',
    });
    const result = await handleSlackCallback({
      state: 'raw',
      code: 'c',
      error: null,
    });
    expect(result.statusCode).toBe(200);
    expect(result.html).toContain('"status":"success"');
    expect(result.html).toContain('"teamName":"Eng"');
  });

  it('renders the error message verbatim on failed completion (escaped)', async () => {
    completeMock.mockResolvedValueOnce({
      status: 'error',
      errorCode: 'state_invalid_or_expired',
      message: 'Install link expired, try again.',
    });
    const result = await handleSlackCallback({
      state: 'raw',
      code: 'c',
      error: null,
    });
    expect(result.statusCode).toBe(400);
    expect(result.html).toContain('Install link expired');
  });
});

describe('admin gating', () => {
  it('startSlackInstallRoute returns 403 for non-admins', async () => {
    const result = await startSlackInstallRoute(MEMBER_AUTH, {});
    expect(result.statusCode).toBe(403);
    expect(result.body.ok).toBe(false);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('deleteWorkspaceSlackInstallRoute returns 403 for non-admins', async () => {
    const result = await deleteWorkspaceSlackInstallRoute({
      auth: MEMBER_AUTH,
      teamId: 'T01',
    });
    expect(result.statusCode).toBe(403);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('listWorkspaceSlackInstallsRoute returns the installs for any authed user', async () => {
    listMock.mockResolvedValueOnce([
      {
        team_id: 'T01',
        team_name: 'Eng',
        bot_user_id: 'U1',
        app_id: 'A1',
        scopes: ['channels:read'],
        enc_key_version: 1,
        installed_by: 'user-1',
        installed_at: '2026-05-24T00:00:00Z',
        updated_at: '2026-05-24T00:00:00Z',
        bound_channel_count: 0,
      },
    ]);
    const result = await listWorkspaceSlackInstallsRoute(MEMBER_AUTH);
    expect(result.statusCode).toBe(200);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.installs).toHaveLength(1);
    expect(result.body.data.installs[0]).toMatchObject({
      teamId: 'T01',
      teamName: 'Eng',
      boundChannelCount: 0,
    });
  });
});

describe('deleteWorkspaceSlackInstallRoute', () => {
  it('returns 404 when the install does not exist', async () => {
    deleteMock.mockResolvedValueOnce(false);
    const result = await deleteWorkspaceSlackInstallRoute({
      auth: ADMIN_AUTH,
      teamId: 'T-missing',
    });
    expect(result.statusCode).toBe(404);
  });

  it('returns 200 with deleted=true on success', async () => {
    deleteMock.mockResolvedValueOnce(true);
    const result = await deleteWorkspaceSlackInstallRoute({
      auth: ADMIN_AUTH,
      teamId: 'T01',
    });
    expect(result.statusCode).toBe(200);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.deleted).toBe(true);
    expect(deleteMock).toHaveBeenCalledWith('T01');
  });
});
