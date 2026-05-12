import crypto from 'crypto';

import {
  createOAuthState,
  consumeOAuthStateByHash,
  deleteChannelConnection,
  deleteChannelConnectionSecret,
  getChannelConnectionById,
  getChannelConnectionSecret,
  getChannelProviderConfig,
  getChannelProviderSecret,
  getChannelTarget,
  searchChannelTargets,
  setChannelConnectionSecret,
  upsertChannelConnection,
  upsertChannelTarget,
} from '../db/index.js';
import { hashOpaqueToken } from '../security/hash.js';
import { isNonLocalhostRedirectUri } from '../config.js';
import type { AuthContext } from '../web/types.js';
import {
  decryptChannelSecret,
  encryptChannelSecret,
} from './channel-secret-store.js';
import {
  decryptChannelProviderSecret,
  encryptChannelProviderSecret,
  type ChannelProviderSecretPayload,
} from './channel-provider-secret-store.js';
import { slackApiRequest } from '../../channels/slack-api.js';

type JsonMap = Record<string, unknown>;

export interface SlackProviderConfigState {
  clientId: string | null;
  hasClientSecret: boolean;
  hasSigningSecret: boolean;
  redirectUrl: string | null;
  eventsApiUrl: string | null;
  eventsApiReady: boolean;
  oauthInstallReady: boolean;
  available: boolean;
  availabilityReason: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SlackWorkspaceIdentity {
  teamId: string;
  teamName: string | null;
  teamUrl: string | null;
  botUserId: string | null;
  botUserName: string | null;
  scopeSet: string[];
}

export interface SlackWorkspaceCredential {
  connectionId: string;
  botToken: string;
}

export interface SlackTargetResolutionResult {
  ok: true;
  targetKind: 'channel';
  targetId: string;
  displayName: string;
  metadata: Record<string, unknown>;
}

export interface SlackTargetDiagnosticResult {
  ok: boolean;
  code: 'ok' | 'not_in_channel' | 'channel_not_found' | 'invalid_input';
  message: string;
  target?: SlackTargetResolutionResult;
}

export interface SlackRecentConversationContext {
  mode: 'thread' | 'channel' | 'skipped' | 'unavailable';
  lines: string[];
  unavailableReason: string | null;
}

type SlackApiResponse<T extends Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; error?: string };

type SlackHistoryMessage = {
  ts?: string;
  text?: string;
  user?: string;
  username?: string;
  subtype?: string;
  bot_id?: string;
  bot_profile?: {
    name?: string;
  };
};

function randomOpaque(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function normalizeSlackProviderConfig(raw: unknown): {
  clientId: string | null;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { clientId: null };
  }
  const rawClientId = (raw as JsonMap).clientId;
  const clientId = typeof rawClientId === 'string' ? rawClientId.trim() : '';
  return {
    clientId: clientId || null,
  };
}

function resolveRequestBaseUrl(requestOrigin?: string | null): string | null {
  const candidate = (requestOrigin || '').trim();
  if (!candidate) return null;
  if (!isNonLocalhostRedirectUri(candidate)) return null;
  return candidate.replace(/\/$/, '');
}

export function buildSlackConnectorRedirectUrl(baseUrl: string): string {
  return `${baseUrl}/api/v1/channel-connectors/slack/oauth/callback`;
}

export function buildSlackConnectorEventsUrl(baseUrl: string): string {
  return `${baseUrl}/api/v1/channel-connectors/slack/events`;
}

export function getSlackProviderConfigState(input?: {
  requestOrigin?: string | null;
}): SlackProviderConfigState {
  const record = getChannelProviderConfig('slack');
  const config = normalizeSlackProviderConfig(
    record?.config_json ? JSON.parse(record.config_json) : null,
  );
  let hasClientSecret = false;
  let hasSigningSecret = false;
  const secretRecord = getChannelProviderSecret('slack');
  if (secretRecord?.ciphertext) {
    try {
      const payload = decryptChannelProviderSecret(secretRecord.ciphertext);
      hasClientSecret = Boolean(payload.clientSecret.trim());
      hasSigningSecret = Boolean(payload.signingSecret.trim());
    } catch {
      hasClientSecret = false;
      hasSigningSecret = false;
    }
  }

  const baseUrl = resolveRequestBaseUrl(input?.requestOrigin);
  const available = Boolean(baseUrl);
  const availabilityReason = available
    ? null
    : 'Slack requires a publicly reachable HTTPS ClawTalk URL.';

  return {
    clientId: config.clientId,
    hasClientSecret,
    hasSigningSecret,
    redirectUrl: baseUrl ? buildSlackConnectorRedirectUrl(baseUrl) : null,
    eventsApiUrl: baseUrl ? buildSlackConnectorEventsUrl(baseUrl) : null,
    eventsApiReady: Boolean(baseUrl && hasSigningSecret),
    oauthInstallReady: Boolean(baseUrl && config.clientId && hasClientSecret),
    available,
    availabilityReason,
    updatedAt: record?.updated_at || secretRecord?.updated_at || null,
    updatedBy: record?.updated_by || secretRecord?.updated_by || null,
  };
}

export function buildSlackProviderSecretPayload(input: {
  clientSecret: string;
  signingSecret: string;
}): ChannelProviderSecretPayload {
  return {
    kind: 'slack_app',
    clientSecret: input.clientSecret.trim(),
    signingSecret: input.signingSecret.trim(),
  };
}

export function getSlackProviderSecretPayload(): ChannelProviderSecretPayload | null {
  const record = getChannelProviderSecret('slack');
  if (!record?.ciphertext) return null;
  return decryptChannelProviderSecret(record.ciphertext);
}

export function encryptSlackProviderSecret(input: {
  clientSecret: string;
  signingSecret: string;
}): string {
  return encryptChannelProviderSecret(buildSlackProviderSecretPayload(input));
}

export function resolveSlackWorkspaceCredential(
  connectionId: string,
): SlackWorkspaceCredential | null {
  const secret = getChannelConnectionSecret(connectionId);
  if (!secret?.ciphertext) return null;
  const payload = decryptChannelSecret(secret.ciphertext);
  if (payload.kind !== 'slack_bot') return null;
  return {
    connectionId,
    botToken: payload.botToken.trim(),
  };
}

function normalizeScopeSet(input: string | null | undefined): string[] {
  return (input || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function parseSlackChannelId(targetId: string): string | null {
  const trimmed = targetId.trim();
  if (!trimmed.startsWith('slack:')) return null;
  const channelId = trimmed.slice('slack:'.length).trim();
  return channelId || null;
}

function truncateSlackHistoryText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function formatSlackHistorySpeaker(message: SlackHistoryMessage): string {
  if (message.bot_profile?.name?.trim()) return message.bot_profile.name.trim();
  if (message.username?.trim()) return message.username.trim();
  if (message.user?.trim()) return `Slack user ${message.user.trim()}`;
  if (message.bot_id?.trim()) return `Slack bot ${message.bot_id.trim()}`;
  if (message.subtype?.trim()) return `Slack ${message.subtype.trim()}`;
  return 'Slack message';
}

function buildSlackHistoryLines(input: {
  messages: SlackHistoryMessage[] | undefined;
  excludeTs?: string | null;
  maxMessages: number;
  maxCharsPerMessage: number;
}): string[] {
  const messages = (input.messages || [])
    .filter(
      (message) => typeof message.text === 'string' && message.text.trim(),
    )
    .filter((message) => message.ts !== input.excludeTs)
    .sort((a, b) =>
      String(a.ts || '').localeCompare(String(b.ts || ''), undefined, {
        numeric: true,
      }),
    )
    .slice(-input.maxMessages);
  return messages.map((message) => {
    const speaker = formatSlackHistorySpeaker(message);
    const text = truncateSlackHistoryText(
      message.text || '',
      input.maxCharsPerMessage,
    );
    return `- ${speaker}: ${text}`;
  });
}

export async function probeSlackBotToken(
  botToken: string,
): Promise<SlackWorkspaceIdentity> {
  const result = await slackApiRequest<
    SlackApiResponse<{
      team: string;
      team_id: string;
      url?: string;
      bot_id?: string;
      user_id?: string;
    }>
  >({
    botToken,
    url: 'https://slack.com/api/auth.test',
  });
  if (!result.ok) {
    throw new Error(result.error || 'Slack bot token is invalid');
  }
  return {
    teamId: result.team_id,
    teamName: result.team || null,
    teamUrl: result.url || null,
    botUserId: result.user_id || null,
    botUserName: null,
    scopeSet: [],
  };
}

export async function startSlackOAuthInstall(input: {
  auth: AuthContext;
  requestOrigin?: string | null;
  returnTo?: string | null;
}): Promise<{ authorizationUrl: string; expiresInSec: number }> {
  const state = getSlackProviderConfigState({
    requestOrigin: input.requestOrigin,
  });
  if (!state.available || !state.redirectUrl) {
    throw new Error(state.availabilityReason || 'Slack is unavailable.');
  }
  if (!state.clientId || !state.hasClientSecret) {
    throw new Error('Slack OAuth install is not ready yet.');
  }
  const redirectUrl = state.redirectUrl;
  const clientId = state.clientId;

  const rawState = randomOpaque(24);
  const nonce = randomOpaque(24);
  const codeVerifier = randomOpaque(24);
  const expiresInSec = 600;
  const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();

  createOAuthState({
    id: crypto.randomUUID(),
    provider: 'slack',
    stateHash: hashOpaqueToken(rawState),
    nonceHash: hashOpaqueToken(nonce),
    codeVerifierHash: hashOpaqueToken(codeVerifier),
    redirectUri: redirectUrl,
    returnTo: input.returnTo || undefined,
    requestedByUserId: input.auth.userId,
    requestedBySessionId: input.auth.sessionId,
    expiresAt,
  });

  const params = new URLSearchParams({
    client_id: clientId,
    scope: [
      'app_mentions:read',
      'channels:history',
      'channels:read',
      'chat:write',
      'groups:history',
      'groups:read',
      'users:read',
    ].join(','),
    redirect_uri: redirectUrl,
    state: rawState,
  });

  return {
    authorizationUrl: `https://slack.com/oauth/v2/authorize?${params.toString()}`,
    expiresInSec,
  };
}

export async function completeSlackOAuthInstall(input: {
  state: string;
  code: string;
  auth: AuthContext;
  requestOrigin?: string | null;
}): Promise<{
  connectionId: string;
  workspace: SlackWorkspaceIdentity;
}> {
  const stateRecord = consumeOAuthStateByHash(hashOpaqueToken(input.state));
  if (!stateRecord) {
    throw new Error('Slack OAuth state is invalid or expired.');
  }
  if (stateRecord.provider !== 'slack') {
    throw new Error('Slack OAuth state is invalid.');
  }
  if (
    stateRecord.requested_by_user_id &&
    stateRecord.requested_by_user_id !== input.auth.userId
  ) {
    throw new Error('Slack OAuth callback did not match the initiating user.');
  }
  if (
    stateRecord.requested_by_session_id &&
    stateRecord.requested_by_session_id !== input.auth.sessionId
  ) {
    throw new Error(
      'Slack OAuth callback did not match the initiating browser session.',
    );
  }

  const providerState = getSlackProviderConfigState({
    requestOrigin: input.requestOrigin,
  });
  const secrets = getSlackProviderSecretPayload();
  if (!providerState.clientId || !providerState.redirectUrl || !secrets) {
    throw new Error('Slack app credentials are not configured.');
  }
  const redirectUrl = providerState.redirectUrl;
  const clientId = providerState.clientId;

  const response = await slackApiRequest<
    SlackApiResponse<{
      access_token: string;
      scope: string;
      team: { id: string; name?: string };
      bot_user_id?: string;
    }>
  >({
    url: 'https://slack.com/api/oauth.v2.access',
    method: 'POST',
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: secrets.clientSecret,
      code: input.code,
      redirect_uri: redirectUrl,
    }),
  });

  if (!response.ok) {
    throw new Error(response.error || 'Slack OAuth exchange failed.');
  }

  const workspace = await probeSlackBotToken(response.access_token);
  workspace.botUserId = response.bot_user_id || workspace.botUserId;
  workspace.scopeSet = normalizeScopeSet(response.scope);
  workspace.teamName = response.team?.name || workspace.teamName;
  workspace.teamId = response.team?.id || workspace.teamId;

  const connection = upsertChannelConnection({
    platform: 'slack',
    connectionMode: 'oauth_workspace',
    accountKey: `slack:${workspace.teamId}`,
    displayName: workspace.teamName
      ? `Slack (${workspace.teamName})`
      : `Slack (${workspace.teamId})`,
    config: {
      teamId: workspace.teamId,
      teamName: workspace.teamName,
      teamUrl: workspace.teamUrl,
      botUserId: workspace.botUserId,
      botUserName: workspace.botUserName,
      scopeSet: workspace.scopeSet,
      installedBy: input.auth.userId,
    },
    createdBy: input.auth.userId,
    updatedBy: input.auth.userId,
    healthStatus: 'healthy',
    lastHealthCheckAt: new Date().toISOString(),
    lastHealthError: null,
  });

  setChannelConnectionSecret({
    connectionId: connection.id,
    ciphertext: encryptChannelSecret({
      kind: 'slack_bot',
      botToken: response.access_token,
    }),
    updatedBy: input.auth.userId,
  });

  return {
    connectionId: connection.id,
    workspace,
  };
}

export function verifySlackRequestSignature(input: {
  rawBody: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  signingSecret: string;
  nowMs?: number;
}): void {
  const timestamp = Number(input.timestampHeader || '');
  if (!Number.isFinite(timestamp)) {
    throw new Error('Missing Slack request timestamp.');
  }

  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - timestamp * 1000) > 5 * 60 * 1000) {
    throw new Error('Slack request timestamp is too old.');
  }

  const base = `v0:${timestamp}:${input.rawBody}`;
  const computed = `v0=${crypto
    .createHmac('sha256', input.signingSecret)
    .update(base)
    .digest('hex')}`;
  const expected = Buffer.from(computed, 'utf8');
  const received = Buffer.from(input.signatureHeader || '', 'utf8');
  if (
    expected.length !== received.length ||
    !crypto.timingSafeEqual(expected, received)
  ) {
    throw new Error('Slack request signature is invalid.');
  }
}

function normalizeSlackChannelId(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  if (/^[CG][A-Z0-9]+$/.test(upper)) {
    return upper;
  }
  const match = trimmed.match(/\/archives\/([CG][A-Z0-9]+)/i);
  return match?.[1]?.toUpperCase() || null;
}

export async function syncSlackWorkspaceTargets(input: {
  connectionId: string;
}): Promise<{
  syncedCount: number;
  publicCount: number;
  privateCount: number;
}> {
  const credential = resolveSlackWorkspaceCredential(input.connectionId);
  const connection = getChannelConnectionById(input.connectionId);
  if (!credential || !connection || connection.platform !== 'slack') {
    throw new Error('Slack workspace is not configured.');
  }

  let cursor = '';
  let syncedCount = 0;
  let publicCount = 0;
  let privateCount = 0;

  do {
    const params = new URLSearchParams({
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '200',
    });
    if (cursor) params.set('cursor', cursor);
    const response = await slackApiRequest<
      SlackApiResponse<{
        channels: Array<{
          id: string;
          name: string;
          is_private?: boolean;
          is_member?: boolean;
          is_archived?: boolean;
        }>;
        response_metadata?: { next_cursor?: string };
      }>
    >({
      botToken: credential.botToken,
      url: `https://slack.com/api/conversations.list?${params.toString()}`,
    });
    if (!response.ok) {
      throw new Error(response.error || 'Failed to sync Slack channels.');
    }

    for (const channel of response.channels || []) {
      syncedCount += 1;
      if (channel.is_private) {
        privateCount += 1;
      } else {
        publicCount += 1;
      }
      upsertChannelTarget({
        connectionId: input.connectionId,
        targetKind: 'channel',
        targetId: `slack:${channel.id}`,
        displayName: `#${channel.name}`,
        metadataJson: JSON.stringify({
          channelId: channel.id,
          channelName: channel.name,
          isPrivate: Boolean(channel.is_private),
          isMember: Boolean(channel.is_member),
          isArchived: Boolean(channel.is_archived),
        }),
      });
    }

    cursor = response.response_metadata?.next_cursor || '';
  } while (cursor);

  return { syncedCount, publicCount, privateCount };
}

export async function fetchSlackRecentConversationContext(input: {
  connectionId: string;
  targetId: string;
  sourceThreadKey?: string | null;
  externalMessageId?: string | null;
  directMention: boolean;
  maxMessages?: number;
  maxCharsPerMessage?: number;
}): Promise<SlackRecentConversationContext> {
  const channelId = parseSlackChannelId(input.targetId);
  if (!channelId) {
    return {
      mode: 'unavailable',
      lines: [],
      unavailableReason: 'Slack target ID is invalid.',
    };
  }

  const isThreadReply =
    Boolean(input.sourceThreadKey) &&
    input.sourceThreadKey !== input.externalMessageId;
  if (!isThreadReply && !input.directMention) {
    return {
      mode: 'skipped',
      lines: [],
      unavailableReason: null,
    };
  }

  const credential = resolveSlackWorkspaceCredential(input.connectionId);
  if (!credential) {
    return {
      mode: 'unavailable',
      lines: [],
      unavailableReason: 'Slack workspace credential is unavailable.',
    };
  }

  const maxMessages = Math.max(1, Math.min(10, input.maxMessages ?? 10));
  const maxCharsPerMessage = Math.max(
    50,
    Math.min(300, input.maxCharsPerMessage ?? 300),
  );
  const limit = String(maxMessages + 1);

  try {
    if (isThreadReply) {
      const response = await slackApiRequest<
        SlackApiResponse<{
          messages: SlackHistoryMessage[];
        }>
      >({
        botToken: credential.botToken,
        url: `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(channelId)}&ts=${encodeURIComponent(input.sourceThreadKey || '')}&limit=${encodeURIComponent(limit)}`,
      });
      if (!response.ok) {
        return {
          mode: 'unavailable',
          lines: [],
          unavailableReason:
            response.error || 'Slack thread history could not be loaded.',
        };
      }
      return {
        mode: 'thread',
        lines: buildSlackHistoryLines({
          messages: response.messages,
          excludeTs: input.externalMessageId,
          maxMessages,
          maxCharsPerMessage,
        }),
        unavailableReason: null,
      };
    }

    const response = await slackApiRequest<
      SlackApiResponse<{
        messages: SlackHistoryMessage[];
      }>
    >({
      botToken: credential.botToken,
      url: `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channelId)}&limit=${encodeURIComponent(limit)}`,
    });
    if (!response.ok) {
      return {
        mode: 'unavailable',
        lines: [],
        unavailableReason:
          response.error || 'Slack channel history could not be loaded.',
      };
    }
    return {
      mode: 'channel',
      lines: buildSlackHistoryLines({
        messages: response.messages,
        excludeTs: input.externalMessageId,
        maxMessages,
        maxCharsPerMessage,
      }),
      unavailableReason: null,
    };
  } catch (error) {
    return {
      mode: 'unavailable',
      lines: [],
      unavailableReason:
        error instanceof Error
          ? error.message
          : 'Slack history could not be loaded.',
    };
  }
}

export async function diagnoseSlackTarget(input: {
  connectionId: string;
  rawInput: string;
}): Promise<SlackTargetDiagnosticResult> {
  const channelId = normalizeSlackChannelId(input.rawInput);
  if (!channelId) {
    return {
      ok: false,
      code: 'invalid_input',
      message: 'Use a Slack channel URL or channel ID such as C12345678.',
    };
  }

  const credential = resolveSlackWorkspaceCredential(input.connectionId);
  if (!credential) {
    throw new Error('Slack workspace is not configured.');
  }

  const response = await slackApiRequest<
    SlackApiResponse<{
      channel: {
        id: string;
        name: string;
        is_private?: boolean;
        is_member?: boolean;
        is_archived?: boolean;
      };
    }>
  >({
    botToken: credential.botToken,
    url: `https://slack.com/api/conversations.info?channel=${encodeURIComponent(channelId)}`,
  });

  if (!response.ok) {
    if (response.error === 'not_in_channel') {
      return {
        ok: false,
        code: 'not_in_channel',
        message:
          'The Slack app is not in that private channel yet. In Slack, run /invite @YourAppName and sync again.',
      };
    }
    if (response.error === 'channel_not_found') {
      return {
        ok: false,
        code: 'channel_not_found',
        message: 'Slack could not find that channel.',
      };
    }
    throw new Error(response.error || 'Slack channel lookup failed.');
  }

  const channel = response.channel;
  const target = {
    ok: true as const,
    targetKind: 'channel' as const,
    targetId: `slack:${channel.id}`,
    displayName: `#${channel.name}`,
    metadata: {
      channelId: channel.id,
      channelName: channel.name,
      isPrivate: Boolean(channel.is_private),
      isMember: Boolean(channel.is_member),
      isArchived: Boolean(channel.is_archived),
    },
  };
  return {
    ok: true,
    code: 'ok',
    message: 'Slack channel found.',
    target,
  };
}

export async function disconnectSlackWorkspace(input: {
  connectionId: string;
}): Promise<boolean> {
  deleteChannelConnectionSecret(input.connectionId);
  return deleteChannelConnection(input.connectionId);
}

export function listSlackWorkspaceTargets(input: {
  connectionId: string;
  approval?: 'all' | 'approved' | 'discovered';
  query?: string;
  limit?: number;
}) {
  return searchChannelTargets(input);
}

export function getSlackTarget(connectionId: string, targetId: string) {
  return getChannelTarget({
    connectionId,
    targetKind: 'channel',
    targetId,
  });
}
