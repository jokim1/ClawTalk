// Route-level tests for slack-channels (PR 2 picker).
//
// Covers admin gating, install/credential validation, alreadyAdded
// deduplication, and the Slack API error path mapping. The actual Slack
// fetch is mocked; the DB accessors are mocked. No live Postgres or
// network connection required.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../db.js')>('../../../db.js');
  return {
    ...actual,
    withUserContext: async <T>(_userId: string, fn: () => Promise<T>) => fn(),
  };
});

vi.mock('../../connectors/slack-client.js', () => ({
  SlackApiError: class extends Error {
    slackError: string;
    httpStatus: number;
    constructor(slackError: string, message: string, httpStatus = 400) {
      super(message);
      this.slackError = slackError;
      this.httpStatus = httpStatus;
    }
  },
  listSlackConversations: vi.fn(),
}));

vi.mock('../../db/connectors-accessors.js', () => ({
  createWorkspaceChannel: vi.fn(),
  listWorkspaceChannels: vi.fn(),
}));

vi.mock('../../db/slack-installs-accessors.js', () => ({
  decryptWorkspaceSlackInstallToken: vi.fn(),
  getWorkspaceSlackInstall: vi.fn(),
}));

import {
  bulkAddSlackChannelsRoute,
  listSlackInstallChannelsRoute,
} from './slack-channels.js';
import {
  SlackApiError,
  listSlackConversations,
} from '../../connectors/slack-client.js';
import {
  createWorkspaceChannel,
  listWorkspaceChannels,
} from '../../db/connectors-accessors.js';
import {
  decryptWorkspaceSlackInstallToken,
  getWorkspaceSlackInstall,
} from '../../db/slack-installs-accessors.js';
import type { AuthContext } from '../types.js';

const ADMIN: AuthContext = {
  sessionId: 's',
  userId: '11111111-1111-1111-1111-111111111111',
  role: 'owner',
  authType: 'cookie',
};
const MEMBER: AuthContext = { ...ADMIN, role: 'member' };

const listChannelsMock = vi.mocked(listSlackConversations);
const listWorkspaceChannelsMock = vi.mocked(listWorkspaceChannels);
const createWorkspaceChannelMock = vi.mocked(createWorkspaceChannel);
const getInstallMock = vi.mocked(getWorkspaceSlackInstall);
const decryptTokenMock = vi.mocked(decryptWorkspaceSlackInstallToken);

const FAKE_INSTALL = {
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
};

beforeEach(() => {
  listChannelsMock.mockReset();
  listWorkspaceChannelsMock.mockReset();
  createWorkspaceChannelMock.mockReset();
  getInstallMock.mockReset();
  decryptTokenMock.mockReset();
});

afterEach(() => {
  listChannelsMock.mockReset();
  listWorkspaceChannelsMock.mockReset();
  createWorkspaceChannelMock.mockReset();
  getInstallMock.mockReset();
  decryptTokenMock.mockReset();
});

describe('listSlackInstallChannelsRoute', () => {
  it('returns 403 for non-admins', async () => {
    const result = await listSlackInstallChannelsRoute({
      auth: MEMBER,
      teamId: 'T01',
    });
    expect(result.statusCode).toBe(403);
    expect(getInstallMock).not.toHaveBeenCalled();
  });

  it('returns 404 when install is missing', async () => {
    getInstallMock.mockResolvedValueOnce(null);
    const result = await listSlackInstallChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
    });
    expect(result.statusCode).toBe(404);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('install_not_found');
  });

  it('returns 409 when credential is missing', async () => {
    getInstallMock.mockResolvedValueOnce(FAKE_INSTALL);
    decryptTokenMock.mockResolvedValueOnce(null);
    const result = await listSlackInstallChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
    });
    expect(result.statusCode).toBe(409);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('install_credential_missing');
  });

  it('maps token_revoked SlackApiError to 401', async () => {
    getInstallMock.mockResolvedValueOnce(FAKE_INSTALL);
    decryptTokenMock.mockResolvedValueOnce('xoxb-token');
    listChannelsMock.mockRejectedValueOnce(
      new SlackApiError('token_revoked', 'token revoked', 401),
    );
    const result = await listSlackInstallChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
    });
    expect(result.statusCode).toBe(401);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('slack_token_revoked');
  });

  it('returns sorted channels with alreadyAdded flag', async () => {
    getInstallMock.mockResolvedValueOnce(FAKE_INSTALL);
    decryptTokenMock.mockResolvedValueOnce('xoxb-token');
    listChannelsMock.mockResolvedValueOnce([
      {
        id: 'C2',
        name: 'random',
        is_private: false,
        is_member: true,
        num_members: 30,
      },
      {
        id: 'C1',
        name: 'general',
        is_private: false,
        is_member: true,
        num_members: 50,
      },
    ]);
    listWorkspaceChannelsMock.mockResolvedValueOnce([
      {
        id: 'row-1',
        kind: 'slack',
        display_name: 'General',
        config_json: { workspace_id: 'T01', channel_id: 'C1' },
        has_credential: false,
        enc_key_version: 1,
        enabled: true,
        created_at: '2026-05-24T00:00:00Z',
        updated_at: '2026-05-24T00:00:00Z',
        created_by: null,
        updated_by: null,
        bound_talk_count: 0,
      },
    ]);
    const result = await listSlackInstallChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
    });
    expect(result.statusCode).toBe(200);
    if (!result.body.ok) throw new Error('expected ok');
    const channels = result.body.data.channels;
    expect(channels).toHaveLength(2);
    expect(channels[0]).toMatchObject({ id: 'C1', alreadyAdded: true });
    expect(channels[1]).toMatchObject({ id: 'C2', alreadyAdded: false });
  });
});

describe('bulkAddSlackChannelsRoute', () => {
  it('returns 403 for non-admins', async () => {
    const result = await bulkAddSlackChannelsRoute({
      auth: MEMBER,
      teamId: 'T01',
      body: { channels: [{ channelId: 'C1', channelName: 'general' }] },
    });
    expect(result.statusCode).toBe(403);
    expect(createWorkspaceChannelMock).not.toHaveBeenCalled();
  });

  it('returns 400 when channels array is empty', async () => {
    const result = await bulkAddSlackChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
      body: { channels: [] },
    });
    expect(result.statusCode).toBe(400);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('channels_required');
  });

  it('returns 400 when a channel entry is missing channelId', async () => {
    const result = await bulkAddSlackChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
      body: { channels: [{ channelName: 'general' }] as never },
    });
    expect(result.statusCode).toBe(400);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('invalid_channel_entry');
  });

  it('returns 404 when install is missing', async () => {
    getInstallMock.mockResolvedValueOnce(null);
    const result = await bulkAddSlackChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
      body: { channels: [{ channelId: 'C1', channelName: 'general' }] },
    });
    expect(result.statusCode).toBe(404);
  });

  it('skips already-added channels and creates the rest', async () => {
    getInstallMock.mockResolvedValueOnce(FAKE_INSTALL);
    listWorkspaceChannelsMock.mockResolvedValueOnce([
      {
        id: 'row-existing',
        kind: 'slack',
        display_name: 'General',
        config_json: { workspace_id: 'T01', channel_id: 'C1' },
        has_credential: false,
        enc_key_version: 1,
        enabled: true,
        created_at: '2026-05-24T00:00:00Z',
        updated_at: '2026-05-24T00:00:00Z',
        created_by: null,
        updated_by: null,
        bound_talk_count: 0,
      },
    ]);
    createWorkspaceChannelMock.mockResolvedValueOnce({
      id: 'row-new',
      kind: 'slack',
      display_name: 'random',
      config_json: {
        workspace_id: 'T01',
        channel_id: 'C2',
        channel_name: 'random',
        is_private: false,
      },
      has_credential: false,
      enc_key_version: 1,
      enabled: true,
      created_at: '2026-05-24T00:00:00Z',
      updated_at: '2026-05-24T00:00:00Z',
      created_by: null,
      updated_by: null,
      bound_talk_count: 0,
    });

    const result = await bulkAddSlackChannelsRoute({
      auth: ADMIN,
      teamId: 'T01',
      body: {
        channels: [
          { channelId: 'C1', channelName: 'general' },
          { channelId: 'C2', channelName: 'random' },
        ],
      },
    });
    expect(result.statusCode).toBe(201);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.created).toHaveLength(1);
    expect(result.body.data.created[0]).toMatchObject({
      channelId: 'C2',
      displayName: 'random',
    });
    expect(createWorkspaceChannelMock).toHaveBeenCalledTimes(1);
  });
});
