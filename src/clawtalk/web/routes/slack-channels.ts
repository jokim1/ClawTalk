// Slack channel picker routes (PR 2).
//
// PR 1 landed the workspace install flow. This file ships the picker on top
// of it: given an installed workspace, list its Slack channels and bulk-add
// them as `workspace_channels` rows so they appear in the existing Talk
// connector picker.

import { withUserContext } from '../../../db.js';
import { listSlackConversations } from '../../connectors/slack-client.js';
import {
  createWorkspaceChannel,
  listWorkspaceChannels,
} from '../../db/connectors-accessors.js';
import {
  decryptWorkspaceSlackInstallToken,
  getWorkspaceSlackInstall,
} from '../../db/slack-installs-accessors.js';
import { SlackApiError } from '../../connectors/slack-client.js';
import { ApiEnvelope, AuthContext } from '../types.js';

interface JsonRouteResult<T> {
  statusCode: number;
  body: ApiEnvelope<T>;
}

function errorResult(
  statusCode: number,
  code: string,
  message: string,
): JsonRouteResult<never> {
  return { statusCode, body: { ok: false, error: { code, message } } };
}

function isAdminLike(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

function forbiddenAdminResponse(): JsonRouteResult<never> {
  return errorResult(
    403,
    'forbidden',
    'Only workspace admins can manage Slack channels.',
  );
}

// ---------------------------------------------------------------------------
// GET /api/v1/workspace/connectors/slack/installs/:teamId/channels
// ---------------------------------------------------------------------------

export interface ApiSlackChannelOption {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  numMembers: number | null;
  topic: string | null;
  alreadyAdded: boolean;
}

export async function listSlackInstallChannelsRoute(input: {
  auth: AuthContext;
  teamId: string;
}): Promise<JsonRouteResult<{ channels: ApiSlackChannelOption[] }>> {
  if (!isAdminLike(input.auth.role)) return forbiddenAdminResponse();

  return withUserContext(input.auth.userId, async () => {
    const install = await getWorkspaceSlackInstall(input.teamId);
    if (!install) {
      return errorResult(
        404,
        'install_not_found',
        'Slack workspace is not connected.',
      );
    }
    const token = await decryptWorkspaceSlackInstallToken(input.teamId);
    if (!token) {
      return errorResult(
        409,
        'install_credential_missing',
        'Slack workspace credential is missing; reconnect the workspace.',
      );
    }

    let slackChannels;
    try {
      slackChannels = await listSlackConversations({ token });
    } catch (err) {
      if (err instanceof SlackApiError) {
        return errorResult(
          err.slackError === 'token_revoked' ||
            err.slackError === 'invalid_auth'
            ? 401
            : 502,
          `slack_${err.slackError}`,
          err.message,
        );
      }
      throw err;
    }

    // Build the already-added set: any workspace_channels row with kind=slack
    // and config_json.workspace_id === teamId.
    const existing = await listWorkspaceChannels();
    const alreadyAddedChannelIds = new Set<string>();
    for (const row of existing) {
      if (row.kind !== 'slack') continue;
      const cfg = row.config_json as Record<string, unknown>;
      if (cfg.workspace_id !== input.teamId) continue;
      if (typeof cfg.channel_id === 'string') {
        alreadyAddedChannelIds.add(cfg.channel_id);
      }
    }

    const channels: ApiSlackChannelOption[] = slackChannels
      .map((c) => ({
        id: c.id,
        name: c.name,
        isPrivate: Boolean(c.is_private),
        isMember: Boolean(c.is_member),
        numMembers: typeof c.num_members === 'number' ? c.num_members : null,
        topic: c.topic?.value || null,
        alreadyAdded: alreadyAddedChannelIds.has(c.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { statusCode: 200, body: { ok: true, data: { channels } } };
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/workspace/connectors/slack/installs/:teamId/channels
// ---------------------------------------------------------------------------

interface BulkAddChannelInput {
  channelId: string;
  channelName: string;
  isPrivate?: boolean;
  displayName?: string;
}

interface ApiCreatedSlackChannel {
  id: string;
  channelId: string;
  displayName: string;
}

function isBulkAddChannelInput(value: unknown): value is BulkAddChannelInput {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.channelId === 'string' &&
    v.channelId.length > 0 &&
    typeof v.channelName === 'string' &&
    v.channelName.length > 0
  );
}

export async function bulkAddSlackChannelsRoute(input: {
  auth: AuthContext;
  teamId: string;
  body: { channels?: unknown };
}): Promise<JsonRouteResult<{ created: ApiCreatedSlackChannel[] }>> {
  if (!isAdminLike(input.auth.role)) return forbiddenAdminResponse();

  const rawChannels = Array.isArray(input.body.channels)
    ? (input.body.channels as unknown[])
    : null;
  if (!rawChannels || rawChannels.length === 0) {
    return errorResult(
      400,
      'channels_required',
      'channels must be a non-empty array.',
    );
  }
  const cleaned: BulkAddChannelInput[] = [];
  for (const entry of rawChannels) {
    if (!isBulkAddChannelInput(entry)) {
      return errorResult(
        400,
        'invalid_channel_entry',
        'Each channel needs channelId + channelName strings.',
      );
    }
    cleaned.push(entry);
  }

  return withUserContext(input.auth.userId, async () => {
    const install = await getWorkspaceSlackInstall(input.teamId);
    if (!install) {
      return errorResult(
        404,
        'install_not_found',
        'Slack workspace is not connected.',
      );
    }

    // Deduplicate against existing slack channels for this workspace so
    // the picker's alreadyAdded flag isn't the only line of defense.
    const existing = await listWorkspaceChannels();
    const alreadyAddedChannelIds = new Set<string>();
    for (const row of existing) {
      if (row.kind !== 'slack') continue;
      const cfg = row.config_json as Record<string, unknown>;
      if (cfg.workspace_id !== input.teamId) continue;
      if (typeof cfg.channel_id === 'string') {
        alreadyAddedChannelIds.add(cfg.channel_id);
      }
    }

    const created: ApiCreatedSlackChannel[] = [];
    for (const entry of cleaned) {
      if (alreadyAddedChannelIds.has(entry.channelId)) continue;
      const displayName = (entry.displayName || entry.channelName).trim();
      const row = await createWorkspaceChannel({
        kind: 'slack',
        displayName: displayName || entry.channelName,
        config: {
          workspace_id: input.teamId,
          channel_id: entry.channelId,
          channel_name: entry.channelName,
          is_private: Boolean(entry.isPrivate),
        },
        createdBy: input.auth.userId,
      });
      created.push({
        id: row.id,
        channelId: entry.channelId,
        displayName: row.display_name,
      });
    }

    return { statusCode: 201, body: { ok: true, data: { created } } };
  });
}
