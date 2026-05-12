import { randomUUID } from 'crypto';

import {
  approveChannelTarget,
  appendOutboxEvent,
  buildTalkChannelBindingStateNamespace,
  clearBindingQuarantine,
  createTalkChannelBinding,
  createTalkRun,
  deleteChannelProviderConfig,
  deleteChannelProviderSecret,
  deleteChannelConnectionSecret,
  deleteChannelDeliveryOutboxRow,
  deleteChannelIngressQueueRow,
  deleteTalkChannelBinding,
  ensureSystemManagedTelegramConnection,
  getActiveTalkChannelBindingOwner,
  getChannelConnectionByPlatformAccount,
  getChannelTarget,
  getChannelConnectionById,
  getTalkChannelBindingById,
  getTalkStateEntry,
  listTalkStateEntriesByPrefix,
  listChannelConnections,
  listChannelDeliveryFailures,
  listChannelIngressFailures,
  listTalkChannelBindingsForTalk,
  markTalkRunStatus,
  quarantineBinding,
  retryChannelDeliveryFailure,
  retryChannelDeliveryFailuresCapped,
  retryChannelIngressFailure,
  searchChannelTargets,
  setTalkRunMetadataJson,
  setChannelProviderConfig,
  setChannelProviderSecret,
  setChannelConnectionSecret,
  unapproveChannelTarget,
  upsertChannelTarget,
  upsertTalkStateEntry,
  updateChannelConnectionConfig,
  updateBindingDeliveryResult,
  updateConnectionProbeResult,
  updateTalkChannelBinding,
  deleteTalkStateEntry,
} from '../../db/index.js';
import {
  diagnoseBinding,
  type BindingDiagnosis,
} from '../../channels/channel-diagnosis.js';
import { ChannelDeliveryError } from '../../channels/channel-errors.js';
import { encryptChannelSecret } from '../../channels/channel-secret-store.js';
import { encryptChannelProviderSecret } from '../../channels/channel-provider-secret-store.js';
import {
  completeSlackOAuthInstall,
  diagnoseSlackTarget,
  disconnectSlackWorkspace,
  getSlackProviderConfigState,
  getSlackProviderSecretPayload,
  startSlackOAuthInstall,
  syncSlackWorkspaceTargets,
  verifySlackRequestSignature,
} from '../../channels/slack-connector.js';
import {
  probeTelegramBotToken,
  resolveTelegramCredential,
  resolveTelegramTargetInput,
  type TelegramBotIdentity,
  type TelegramTokenSource,
} from '../../channels/telegram-connector.js';
import { executeWithAgent } from '../../agents/agent-router.js';
import { resolvePrimaryAgent } from '../../agents/agent-registry.js';
import { resolveThreadIdForTalk } from '../../db/accessors.js';
import { validateStateKey } from '../../db/context-accessors.js';
import { canEditTalk } from '../middleware/acl.js';
import { ApiEnvelope, AuthContext } from '../types.js';
import { getTalkForUser } from '../../db/index.js';
import type { SlackEventEnvelope } from '../../../channels/slack.js';

export interface TalkChannelBindingApiRecord {
  id: string;
  talkId: string;
  connectionId: string;
  platform: 'telegram' | 'slack';
  connectionDisplayName: string;
  connectionHealthStatus: string;
  targetKind: string;
  targetId: string;
  displayName: string;
  active: boolean;
  responseMode: 'off' | 'mentions' | 'all';
  responderMode: 'primary' | 'agent';
  responderAgentId: string | null;
  deliveryMode: 'reply' | 'channel';
  timezone: string;
  instructions: string | null;
  stateNamespace: string;
  inboundRateLimitPerMinute: number;
  maxPendingEvents: number;
  overflowPolicy: 'drop_oldest' | 'drop_newest';
  maxDeferredAgeMinutes: number;
  pendingIngressCount: number;
  deferredIngressCount: number;
  deadLetterCount: number;
  unresolvedIngressCount: number;
  suppressedReplyCount: number;
  lastSuppressedAt: string | null;
  lastSuppressionReason: string | null;
  lastIngressAt: string | null;
  lastDeliveryAt: string | null;
  lastIngressReasonCode: string | null;
  lastDeliveryReasonCode: string | null;
  healthQuarantined: boolean;
  healthQuarantineCode: string | null;
  diagnosis: BindingDiagnosis;
}

export interface TalkChannelBindingStateEntryApiRecord {
  id: string;
  key: string;
  keySuffix: string;
  value: unknown;
  version: number;
  updatedAt: string;
  updatedByUserId: string | null;
  updatedByRunId: string | null;
}

export interface ChannelInstructionReviewApiRecord {
  strengths: string[];
  missing: string[];
  removeOrSimplify: string[];
  rewrittenInstructions: string | null;
}

export interface ChannelConnectionApiRecord {
  id: string;
  platform: 'telegram' | 'slack';
  connection_mode: string;
  account_key: string;
  display_name: string;
  enabled: number;
  health_status: string;
  last_health_check_at: string | null;
  last_health_error: string | null;
  consecutive_probe_failures: number;
  config_json: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  token_source: TelegramTokenSource | null;
  env_token_available: number;
  has_stored_secret: number;
}

export interface SlackProviderConfigApiRecord {
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

export interface ChannelTargetApiRecord {
  connection_id: string;
  target_kind: string;
  target_id: string;
  display_name: string;
  metadata_json: string | null;
  approved: number;
  registered_at: string | null;
  registered_by: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  active_binding_id: string | null;
  active_binding_talk_id: string | null;
  active_binding_talk_title: string | null;
  active_binding_talk_accessible: number;
}

const manualIngressRetryTimestamps = new Map<string, number[]>();
const recentSlackEventReceipts = new Map<string, number>();
const MAX_RECENT_SLACK_EVENT_RECEIPTS = 10_000;

function canManageConnections(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin';
}

function notFound(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 404,
    body: {
      ok: false,
      error: {
        code: 'not_found',
        message,
      },
    },
  };
}

function forbidden(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 403,
    body: {
      ok: false,
      error: {
        code: 'forbidden',
        message,
      },
    },
  };
}

function trimManualRetryTimestamps(bindingId: string, nowMs: number): number[] {
  const recent =
    manualIngressRetryTimestamps
      .get(bindingId)
      ?.filter((timestamp) => nowMs - timestamp < 60_000) || [];
  if (recent.length === 0) {
    manualIngressRetryTimestamps.delete(bindingId);
    return [];
  }
  manualIngressRetryTimestamps.set(bindingId, recent);
  return recent;
}

function trimRecentSlackEventReceipts(nowMs: number): void {
  for (const [key, observedAt] of recentSlackEventReceipts) {
    if (nowMs - observedAt > 15 * 60_000) {
      recentSlackEventReceipts.delete(key);
    }
  }
}

function enforceRecentSlackEventReceiptCap(): void {
  while (recentSlackEventReceipts.size >= MAX_RECENT_SLACK_EVENT_RECEIPTS) {
    const oldestKey = recentSlackEventReceipts.keys().next().value;
    if (!oldestKey) break;
    recentSlackEventReceipts.delete(oldestKey);
  }
}

function markRecentSlackEventReceipt(
  dedupeKey: string,
  nowMs: number,
): boolean {
  trimRecentSlackEventReceipts(nowMs);
  if (recentSlackEventReceipts.has(dedupeKey)) {
    return false;
  }
  enforceRecentSlackEventReceiptCap();
  recentSlackEventReceipts.set(dedupeKey, nowMs);
  return true;
}

function toBindingApiRecord(
  record: ReturnType<typeof listTalkChannelBindingsForTalk>[number],
): TalkChannelBindingApiRecord {
  return {
    id: record.id,
    talkId: record.talk_id,
    connectionId: record.connection_id,
    platform: record.platform,
    connectionDisplayName: record.connection_display_name,
    connectionHealthStatus: record.connection_health_status,
    targetKind: record.target_kind,
    targetId: record.target_id,
    displayName: record.display_name,
    active: record.active === 1,
    responseMode: record.response_mode,
    responderMode: record.responder_mode,
    responderAgentId: record.responder_agent_id,
    deliveryMode: record.delivery_mode,
    timezone: record.timezone,
    instructions: record.instructions,
    stateNamespace: buildTalkChannelBindingStateNamespace(record.id),
    inboundRateLimitPerMinute: record.inbound_rate_limit_per_minute,
    maxPendingEvents: record.max_pending_events,
    overflowPolicy: record.overflow_policy,
    maxDeferredAgeMinutes: record.max_deferred_age_minutes,
    pendingIngressCount: record.pending_ingress_count,
    deferredIngressCount: record.deferred_ingress_count,
    deadLetterCount: record.dead_letter_count,
    unresolvedIngressCount: record.unresolved_ingress_count,
    suppressedReplyCount: record.suppressed_reply_count,
    lastSuppressedAt: record.last_suppressed_at,
    lastSuppressionReason: record.last_suppression_reason,
    lastIngressAt: record.last_ingress_at,
    lastDeliveryAt: record.last_delivery_at,
    lastIngressReasonCode: record.last_ingress_reason_code,
    lastDeliveryReasonCode: record.last_delivery_reason_code,
    healthQuarantined: record.health_quarantined === 1,
    healthQuarantineCode: record.health_quarantine_code,
    diagnosis: diagnoseBinding({
      active: record.active,
      healthQuarantined: record.health_quarantined,
      healthQuarantineCode: record.health_quarantine_code,
      connectionHealthStatus: record.connection_health_status,
      deadLetterCount: record.dead_letter_count,
      unresolvedIngressCount: record.unresolved_ingress_count,
      responseMode: record.response_mode,
      lastIngressAt: record.last_ingress_at,
      lastDeliveryAt: record.last_delivery_at,
    }),
  };
}

function parseTargetMetadata(
  metadataJson: string | null,
): Record<string, unknown> | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readMetadataBoolean(
  metadata: Record<string, unknown> | null,
  key: string,
): boolean | null {
  const value = metadata?.[key];
  return typeof value === 'boolean' ? value : null;
}

function formatChannelTestSendError(
  platform: 'telegram' | 'slack',
  error: unknown,
): string {
  if (platform === 'slack') {
    if (error instanceof ChannelDeliveryError) {
      switch (error.code) {
        case 'not_in_channel':
          return 'Slack app is not in this channel yet. In Slack, open the channel and run /invite @YourAppName, then sync channels again.';
        case 'channel_not_found':
          return 'Slack could not find this channel. Sync channels again in Connectors and try again.';
        case 'invalid_auth':
          return 'Slack workspace authorization is no longer valid. Reconnect the workspace in Connectors and try again.';
        case 'rate_limited':
          return 'Slack rate-limited the test send. Try again in a moment.';
        default:
          break;
      }
    }
    if (
      error instanceof Error &&
      error.message.startsWith('No runtime for channel connection')
    ) {
      return 'Slack workspace is not connected right now. Check Connectors and try again.';
    }
  }
  return error instanceof Error ? error.message : 'Channel test send failed';
}

function toSlackProviderConfigApiRecord(input: {
  requestOrigin?: string | null;
}): SlackProviderConfigApiRecord {
  const state = getSlackProviderConfigState({
    requestOrigin: input.requestOrigin,
  });
  return {
    clientId: state.clientId,
    hasClientSecret: state.hasClientSecret,
    hasSigningSecret: state.hasSigningSecret,
    redirectUrl: state.redirectUrl,
    eventsApiUrl: state.eventsApiUrl,
    eventsApiReady: state.eventsApiReady,
    oauthInstallReady: state.oauthInstallReady,
    available: state.available,
    availabilityReason: state.availabilityReason,
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy,
  };
}

function toChannelTargetApiRecord(
  auth: AuthContext,
  record: ReturnType<typeof searchChannelTargets>['targets'][number],
): ChannelTargetApiRecord {
  const talkAccessible = record.active_binding_talk_id
    ? Boolean(getTalkForUser(record.active_binding_talk_id, auth.userId))
    : false;
  return {
    ...record,
    active_binding_talk_accessible: talkAccessible ? 1 : 0,
  };
}

function toChannelConnectionApiRecord(
  record: ReturnType<typeof listChannelConnections>[number],
): ChannelConnectionApiRecord {
  const telegramCredential =
    record.platform === 'telegram' &&
    record.account_key === 'telegram:system' &&
    record.connection_mode === 'system_managed'
      ? resolveTelegramCredential()
      : null;
  return {
    ...record,
    token_source: telegramCredential?.tokenSource || null,
    env_token_available: telegramCredential?.envTokenAvailable ? 1 : 0,
    has_stored_secret: telegramCredential?.hasStoredSecret ? 1 : 0,
  };
}

function buildBindingStateKey(bindingId: string, keySuffix: string): string {
  const suffix = keySuffix.trim();
  if (!suffix) {
    throw new Error('State key suffix is required.');
  }
  const normalizedFullKey = validateStateKey(
    `${buildTalkChannelBindingStateNamespace(bindingId)}${suffix}`,
  );
  const prefix = buildTalkChannelBindingStateNamespace(bindingId);
  if (!normalizedFullKey.startsWith(prefix)) {
    throw new Error('State key must stay inside the binding namespace.');
  }
  return normalizedFullKey;
}

function toBindingStateApiRecord(input: {
  bindingId: string;
  entry: ReturnType<typeof listTalkStateEntriesByPrefix>[number];
}): TalkChannelBindingStateEntryApiRecord {
  const prefix = buildTalkChannelBindingStateNamespace(input.bindingId);
  return {
    ...input.entry,
    keySuffix: input.entry.key.startsWith(prefix)
      ? input.entry.key.slice(prefix.length)
      : input.entry.key,
  };
}

function parseInstructionReviewResponse(
  content: string,
): ChannelInstructionReviewApiRecord {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const readStringList = (key: string): string[] =>
      Array.isArray(parsed[key])
        ? parsed[key].filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : [];
    return {
      strengths: readStringList('strengths'),
      missing: readStringList('missing'),
      removeOrSimplify: readStringList('removeOrSimplify'),
      rewrittenInstructions:
        typeof parsed.rewrittenInstructions === 'string'
          ? parsed.rewrittenInstructions
          : null,
    };
  } catch {
    return {
      strengths: [],
      missing: ['The review model returned an invalid response format.'],
      removeOrSimplify: [],
      rewrittenInstructions: null,
    };
  }
}

export function listChannelConnectionsRoute(input: { auth: AuthContext }) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        connections: listChannelConnections().map(toChannelConnectionApiRecord),
      },
    } satisfies ApiEnvelope<{ connections: ChannelConnectionApiRecord[] }>,
  };
}

export function listChannelTargetsRoute(input: {
  auth: AuthContext;
  connectionId: string;
  query?: string;
  limit?: number;
  offset?: number;
  approval?: 'all' | 'approved' | 'discovered';
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden('You do not have permission to browse channel targets.');
  }
  const connection = getChannelConnectionById(input.connectionId);
  if (!connection) {
    return notFound('Channel connection not found.');
  }
  const page = searchChannelTargets({
    connectionId: input.connectionId,
    query: input.query,
    limit: input.limit,
    offset: input.offset,
    approval: input.approval,
  });
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        connection,
        targets: page.targets.map((target) =>
          toChannelTargetApiRecord(input.auth, target),
        ),
        totalCount: page.totalCount,
        hasMore: page.hasMore,
        nextOffset: page.nextOffset,
      },
    },
  };
}

export function getTelegramChannelConnectorRoute(input: { auth: AuthContext }) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  const connection = ensureSystemManagedTelegramConnection();
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        connection: toChannelConnectionApiRecord(connection),
        targets: searchChannelTargets({
          connectionId: connection.id,
          limit: 200,
          approval: 'all',
        }).targets.map((target) =>
          toChannelTargetApiRecord(input.auth, target),
        ),
      },
    },
  };
}

export async function validateTelegramChannelConnectorRoute(input: {
  auth: AuthContext;
  botToken: string;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  const token = input.botToken.trim();
  if (!token) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'missing_bot_token',
          message: 'Bot token is required.',
        },
      },
    };
  }

  try {
    const bot = await probeTelegramBotToken(token);
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: { bot },
      },
    };
  } catch (error) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_bot_token',
          message:
            error instanceof Error
              ? error.message
              : 'Telegram bot validation failed.',
        },
      },
    };
  }
}

export async function saveTelegramChannelConnectorTokenRoute(input: {
  auth: AuthContext;
  botToken: string;
  reloadConnector?: (input?: {
    validatedBot?: TelegramBotIdentity;
  }) => Promise<void>;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  const token = input.botToken.trim();
  if (!token) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'missing_bot_token',
          message: 'Bot token is required.',
        },
      },
    };
  }
  let validatedBot: TelegramBotIdentity;
  try {
    validatedBot = await probeTelegramBotToken(token);
  } catch (error) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_bot_token',
          message:
            error instanceof Error
              ? error.message
              : 'Telegram bot validation failed.',
        },
      },
    };
  }

  const connection = ensureSystemManagedTelegramConnection();
  setChannelConnectionSecret({
    connectionId: connection.id,
    ciphertext: encryptChannelSecret({
      kind: 'telegram_bot',
      botToken: token,
    }),
    updatedBy: input.auth.userId,
  });
  await input.reloadConnector?.({ validatedBot });
  return getTelegramChannelConnectorRoute({ auth: input.auth });
}

export async function deleteTelegramChannelConnectorTokenRoute(input: {
  auth: AuthContext;
  reloadConnector?: (input?: {
    validatedBot?: TelegramBotIdentity;
  }) => Promise<void>;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  const connection = ensureSystemManagedTelegramConnection();
  deleteChannelConnectionSecret(connection.id, input.auth.userId);
  await input.reloadConnector?.();
  return getTelegramChannelConnectorRoute({ auth: input.auth });
}

export async function adoptTelegramEnvTokenRoute(input: {
  auth: AuthContext;
  reloadConnector?: (input?: {
    validatedBot?: TelegramBotIdentity;
  }) => Promise<void>;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  const credential = resolveTelegramCredential();
  if (credential.tokenSource !== 'env' || !credential.token) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'env_token_not_available',
          message: 'No environment-managed Telegram bot token is available.',
        },
      },
    };
  }

  const connection = ensureSystemManagedTelegramConnection();
  setChannelConnectionSecret({
    connectionId: connection.id,
    ciphertext: encryptChannelSecret({
      kind: 'telegram_bot',
      botToken: credential.token,
    }),
    updatedBy: input.auth.userId,
  });
  await input.reloadConnector?.();
  return getTelegramChannelConnectorRoute({ auth: input.auth });
}

export async function approveTelegramTargetRoute(input: {
  auth: AuthContext;
  rawInput?: string;
  targetKind?: string;
  targetId?: string;
  displayName?: string | null;
  reloadConnector?: () => Promise<void>;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  const connection = ensureSystemManagedTelegramConnection();
  let resolved:
    | {
        targetKind: string;
        targetId: string;
        displayName: string;
        metadata: Record<string, unknown> | null;
      }
    | undefined;

  if (input.rawInput?.trim()) {
    const credential = resolveTelegramCredential();
    if (!credential.token) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'telegram_not_configured',
            message:
              'Configure a Telegram bot token before adding destinations.',
          },
        },
      };
    }
    try {
      const target = await resolveTelegramTargetInput({
        botToken: credential.token,
        rawInput: input.rawInput,
      });
      resolved = {
        targetKind: target.targetKind,
        targetId: target.targetId,
        displayName: target.displayName,
        metadata: target.metadata,
      };
    } catch (error) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_target',
            message:
              error instanceof Error
                ? error.message
                : 'Telegram destination could not be resolved.',
          },
        },
      };
    }
  } else if (input.targetKind && input.targetId) {
    const existing = getChannelTarget({
      connectionId: connection.id,
      targetKind: input.targetKind,
      targetId: input.targetId,
    });
    resolved = {
      targetKind: input.targetKind,
      targetId: input.targetId,
      displayName:
        input.displayName?.trim() || existing?.display_name || input.targetId,
      metadata: parseTargetMetadata(existing?.metadata_json || null),
    };
  }

  if (!resolved) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'missing_target',
          message: 'Telegram destination is required.',
        },
      },
    };
  }

  const target = approveChannelTarget({
    connectionId: connection.id,
    targetKind: resolved.targetKind,
    targetId: resolved.targetId,
    displayName: input.displayName?.trim() || resolved.displayName,
    metadata: resolved.metadata,
    registeredBy: input.auth.userId,
  });
  await input.reloadConnector?.();
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: { target },
    },
  };
}

export function unapproveTelegramTargetRoute(input: {
  auth: AuthContext;
  targetKind: string;
  targetId: string;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  const connection = ensureSystemManagedTelegramConnection();
  const result = unapproveChannelTarget({
    connectionId: connection.id,
    targetKind: input.targetKind,
    targetId: input.targetId,
    updatedBy: input.auth.userId,
  });
  if (!result.removed) {
    return notFound('Telegram destination not found.');
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        removed: true,
        deactivatedBindingCount: result.deactivatedBindingCount,
      },
    },
  };
}

export function getSlackChannelConnectorRoute(input: {
  auth: AuthContext;
  requestOrigin?: string | null;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        config: toSlackProviderConfigApiRecord({
          requestOrigin: input.requestOrigin,
        }),
        workspaces: listChannelConnections()
          .filter((connection) => connection.platform === 'slack')
          .map(toChannelConnectionApiRecord),
      },
    },
  };
}

export function saveSlackProviderConfigRoute(input: {
  auth: AuthContext;
  requestOrigin?: string | null;
  clientId: string;
  clientSecret?: string | null;
  signingSecret?: string | null;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  const clientId = input.clientId.trim();
  if (!clientId) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'missing_client_id',
          message: 'Slack client ID is required.',
        },
      },
    };
  }

  const existingSecrets = getSlackProviderSecretPayload();
  const nextClientSecret =
    input.clientSecret?.trim() || existingSecrets?.clientSecret || '';
  const nextSigningSecret =
    input.signingSecret?.trim() || existingSecrets?.signingSecret || '';

  setChannelProviderConfig({
    platform: 'slack',
    configJson: JSON.stringify({ clientId }),
    updatedBy: input.auth.userId,
  });

  if (nextClientSecret || nextSigningSecret) {
    setChannelProviderSecret({
      platform: 'slack',
      ciphertext: encryptChannelProviderSecret({
        kind: 'slack_app',
        clientSecret: nextClientSecret,
        signingSecret: nextSigningSecret,
      }),
      updatedBy: input.auth.userId,
    });
  }

  return getSlackChannelConnectorRoute({
    auth: input.auth,
    requestOrigin: input.requestOrigin,
  });
}

export function clearSlackProviderConfigRoute(input: {
  auth: AuthContext;
  requestOrigin?: string | null;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  deleteChannelProviderConfig('slack');
  deleteChannelProviderSecret('slack');
  return getSlackChannelConnectorRoute({
    auth: input.auth,
    requestOrigin: input.requestOrigin,
  });
}

export async function startSlackOAuthInstallRoute(input: {
  auth: AuthContext;
  requestOrigin?: string | null;
  returnTo?: string | null;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  try {
    const result = await startSlackOAuthInstall({
      auth: input.auth,
      requestOrigin: input.requestOrigin,
      returnTo: input.returnTo,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: result,
      },
    };
  } catch (error) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'slack_oauth_unavailable',
          message:
            error instanceof Error ? error.message : 'Slack install failed.',
        },
      },
    };
  }
}

export async function completeSlackOAuthInstallRoute(input: {
  auth: AuthContext;
  requestOrigin?: string | null;
  state: string;
  code: string;
  reloadConnection?: (connectionId: string) => Promise<void>;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  try {
    const result = await completeSlackOAuthInstall({
      state: input.state,
      code: input.code,
      auth: input.auth,
      requestOrigin: input.requestOrigin,
    });
    await input.reloadConnection?.(result.connectionId);
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: result,
      },
    };
  } catch (error) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'slack_oauth_failed',
          message:
            error instanceof Error
              ? error.message
              : 'Slack OAuth callback failed.',
        },
      },
    };
  }
}

export async function syncSlackWorkspaceRoute(input: {
  auth: AuthContext;
  connectionId: string;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  const connection = getChannelConnectionById(input.connectionId);
  if (!connection || connection.platform !== 'slack') {
    return notFound('Slack workspace not found.');
  }
  try {
    const result = await syncSlackWorkspaceTargets({
      connectionId: input.connectionId,
    });
    updateChannelConnectionConfig({
      connectionId: input.connectionId,
      config: {
        ...(parseTargetMetadata(connection.config_json) || {}),
        lastSyncedAt: new Date().toISOString(),
        lastSyncTotalCount: result.syncedCount,
        lastSyncPublicCount: result.publicCount,
        lastSyncPrivateCount: result.privateCount,
      },
      updatedBy: input.auth.userId,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: result,
      },
    };
  } catch (error) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'slack_sync_failed',
          message:
            error instanceof Error ? error.message : 'Slack sync failed.',
        },
      },
    };
  }
}

export async function disconnectSlackWorkspaceRoute(input: {
  auth: AuthContext;
  connectionId: string;
  disconnectConnection?: (connectionId: string) => Promise<void>;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  const connection = getChannelConnectionById(input.connectionId);
  if (!connection || connection.platform !== 'slack') {
    return notFound('Slack workspace not found.');
  }
  await input.disconnectConnection?.(input.connectionId);
  const deleted = await disconnectSlackWorkspace({
    connectionId: input.connectionId,
  });
  return {
    statusCode: deleted ? 200 : 404,
    body: deleted
      ? {
          ok: true,
          data: { deleted: true },
        }
      : {
          ok: false,
          error: {
            code: 'not_found',
            message: 'Slack workspace not found.',
          },
        },
  };
}

export async function diagnoseSlackWorkspaceTargetRoute(input: {
  auth: AuthContext;
  connectionId: string;
  rawInput: string;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  const connection = getChannelConnectionById(input.connectionId);
  if (!connection || connection.platform !== 'slack') {
    return notFound('Slack workspace not found.');
  }
  try {
    const result = await diagnoseSlackTarget({
      connectionId: input.connectionId,
      rawInput: input.rawInput,
    });
    if (result.ok && result.target) {
      upsertChannelTarget({
        connectionId: input.connectionId,
        targetKind: result.target.targetKind,
        targetId: result.target.targetId,
        displayName: result.target.displayName,
        metadataJson: JSON.stringify(result.target.metadata || {}),
      });
    }
    return {
      statusCode: result.ok ? 200 : 400,
      body: result.ok
        ? {
            ok: true,
            data: result,
          }
        : {
            ok: false,
            error: {
              code: result.code,
              message: result.message,
            },
          },
    };
  } catch (error) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'slack_target_check_failed',
          message:
            error instanceof Error
              ? error.message
              : 'Slack channel lookup failed.',
        },
      },
    };
  }
}

export function approveChannelTargetRoute(input: {
  auth: AuthContext;
  connectionId: string;
  targetKind: string;
  targetId: string;
  displayName?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  const connection = getChannelConnectionById(input.connectionId);
  if (!connection) {
    return notFound('Channel connection not found.');
  }
  const existing = getChannelTarget({
    connectionId: input.connectionId,
    targetKind: input.targetKind,
    targetId: input.targetId,
  });
  const target = approveChannelTarget({
    connectionId: input.connectionId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    displayName:
      input.displayName?.trim() || existing?.display_name || input.targetId,
    metadata:
      input.metadata ??
      parseTargetMetadata(existing?.metadata_json || null) ??
      null,
    registeredBy: input.auth.userId,
  });
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: { target },
    },
  };
}

export function unapproveChannelTargetRoute(input: {
  auth: AuthContext;
  connectionId: string;
  targetKind: string;
  targetId: string;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  const connection = getChannelConnectionById(input.connectionId);
  if (!connection) {
    return notFound('Channel connection not found.');
  }
  const result = unapproveChannelTarget({
    connectionId: input.connectionId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    updatedBy: input.auth.userId,
  });
  if (!result.removed) {
    return notFound('Channel destination not found.');
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        removed: true,
        deactivatedBindingCount: result.deactivatedBindingCount,
      },
    },
  };
}

export async function handleSlackEventsRoute(input: {
  rawBody: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  enqueueEvent?: (connectionId: string, event: SlackEventEnvelope) => void;
}) {
  const secrets = getSlackProviderSecretPayload();
  const signingSecret = secrets?.signingSecret.trim() || '';
  if (!signingSecret) {
    return {
      statusCode: 503,
      body: {
        ok: false,
        error: {
          code: 'slack_events_not_ready',
          message:
            'Slack signing secret is not configured yet. Save it before using the Events API URL.',
        },
      },
    };
  }

  try {
    verifySlackRequestSignature({
      rawBody: input.rawBody,
      timestampHeader: input.timestampHeader,
      signatureHeader: input.signatureHeader,
      signingSecret,
    });
  } catch (error) {
    return {
      statusCode: 401,
      body: {
        ok: false,
        error: {
          code: 'invalid_slack_signature',
          message:
            error instanceof Error
              ? error.message
              : 'Slack request verification failed.',
        },
      },
    };
  }

  let payload: SlackEventEnvelope;
  try {
    payload = JSON.parse(input.rawBody) as SlackEventEnvelope;
  } catch {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_json',
          message: 'Slack payload is not valid JSON.',
        },
      },
    };
  }

  if (payload.type === 'url_verification') {
    return {
      statusCode: 200,
      body: {
        challenge:
          typeof (payload as Record<string, unknown>).challenge === 'string'
            ? (payload as Record<string, unknown>).challenge
            : '',
      },
    };
  }

  const teamId = typeof payload.team_id === 'string' ? payload.team_id : '';
  const eventId = typeof payload.event_id === 'string' ? payload.event_id : '';
  if (!teamId || !eventId) {
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: { accepted: true },
      },
    };
  }

  const dedupeKey = `slack:${teamId}:${eventId}`;
  const accepted = markRecentSlackEventReceipt(dedupeKey, Date.now());
  if (!accepted) {
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: { accepted: true, duplicate: true },
      },
    };
  }

  const connection = getChannelConnectionByPlatformAccount({
    platform: 'slack',
    accountKey: `slack:${teamId}`,
  });
  if (connection) {
    input.enqueueEvent?.(connection.id, payload);
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: { accepted: true },
    },
  };
}

export function listTalkChannelsRoute(input: {
  auth: AuthContext;
  talkId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        bindings: listTalkChannelBindingsForTalk(input.talkId).map(
          toBindingApiRecord,
        ),
      },
    },
  };
}

export function createTalkChannelRoute(input: {
  auth: AuthContext;
  talkId: string;
  connectionId: string;
  targetKind: string;
  targetId: string;
  displayName: string;
  responseMode?: 'off' | 'mentions' | 'all';
  responderMode?: 'primary' | 'agent';
  responderAgentId?: string | null;
  deliveryMode?: 'reply' | 'channel';
  timezone?: string | null;
  instructions?: string | null;
  inboundRateLimitPerMinute?: number;
  maxPendingEvents?: number;
  overflowPolicy?: 'drop_oldest' | 'drop_newest';
  maxDeferredAgeMinutes?: number;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to edit channels for this talk.',
    );
  }
  const connection = getChannelConnectionById(input.connectionId);
  if (!connection) {
    return notFound('Channel connection not found.');
  }
  const target = getChannelTarget({
    connectionId: input.connectionId,
    targetKind: input.targetKind,
    targetId: input.targetId,
  });
  if (!target) {
    return notFound('Channel target not found.');
  }
  if (connection.platform !== 'slack' && target.approved !== 1) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'target_not_approved',
          message: 'Only approved channel destinations can be bound to a Talk.',
        },
      },
    };
  }
  const targetMetadata = parseTargetMetadata(target.metadata_json);
  if (
    connection.platform === 'slack' &&
    readMetadataBoolean(targetMetadata, 'isMember') === false
  ) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'slack_target_not_joined',
          message:
            'Invite the Slack app to this channel first, then sync channels again before binding it to a Talk.',
        },
      },
    };
  }
  const existingBinding = getActiveTalkChannelBindingOwner({
    connectionId: input.connectionId,
    targetKind: input.targetKind,
    targetId: input.targetId,
  });
  if (existingBinding) {
    const message =
      existingBinding.talk_id === input.talkId
        ? `${target.display_name} is already bound to this talk.`
        : `${target.display_name} is already bound to ${existingBinding.talk_title}.`;
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'target_already_bound',
          message,
          details: {
            bindingId: existingBinding.id,
            talkId: existingBinding.talk_id,
            talkTitle: existingBinding.talk_title,
          },
        },
      },
    };
  }

  let binding;
  try {
    binding = createTalkChannelBinding({
      talkId: input.talkId,
      connectionId: input.connectionId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      displayName: input.displayName.trim() || input.targetId,
      createdBy: input.auth.userId,
      responseMode: input.responseMode,
      responderMode: input.responderMode,
      responderAgentId: input.responderAgentId,
      deliveryMode: input.deliveryMode,
      timezone: input.timezone,
      instructions: input.instructions,
      inboundRateLimitPerMinute: input.inboundRateLimitPerMinute,
      maxPendingEvents: input.maxPendingEvents,
      overflowPolicy: input.overflowPolicy,
      maxDeferredAgeMinutes: input.maxDeferredAgeMinutes,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'channel_binding_timezone_invalid'
    ) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_timezone',
            message: 'Binding timezone must be a valid IANA timezone.',
          },
        },
      };
    }
    if (
      error instanceof Error &&
      (error.message.includes(
        'idx_talk_channel_bindings_active_target_unique',
      ) ||
        error.message.includes(
          'UNIQUE constraint failed: talk_channel_bindings.connection_id, talk_channel_bindings.target_kind, talk_channel_bindings.target_id',
        ))
    ) {
      const conflictingBinding = getActiveTalkChannelBindingOwner({
        connectionId: input.connectionId,
        targetKind: input.targetKind,
        targetId: input.targetId,
      });
      const message = conflictingBinding
        ? `${target.display_name} is already bound to ${conflictingBinding.talk_title}.`
        : `${target.display_name} is already bound to another talk.`;
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'target_already_bound',
            message,
            details: conflictingBinding
              ? {
                  bindingId: conflictingBinding.id,
                  talkId: conflictingBinding.talk_id,
                  talkTitle: conflictingBinding.talk_title,
                }
              : undefined,
          },
        },
      };
    }
    throw error;
  }

  return {
    statusCode: 201,
    body: {
      ok: true,
      data: {
        binding: toBindingApiRecord(binding),
      },
    },
  };
}

export function patchTalkChannelRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  active?: boolean;
  displayName?: string;
  responseMode?: 'off' | 'mentions' | 'all';
  responderMode?: 'primary' | 'agent';
  responderAgentId?: string | null;
  deliveryMode?: 'reply' | 'channel';
  timezone?: string | null;
  instructions?: string | null;
  inboundRateLimitPerMinute?: number;
  maxPendingEvents?: number;
  overflowPolicy?: 'drop_oldest' | 'drop_newest';
  maxDeferredAgeMinutes?: number;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to edit channels for this talk.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  let updated;
  try {
    updated = updateTalkChannelBinding({
      bindingId: input.bindingId,
      updatedBy: input.auth.userId,
      active: input.active,
      displayName: input.displayName,
      responseMode: input.responseMode,
      responderMode: input.responderMode,
      responderAgentId: input.responderAgentId,
      deliveryMode: input.deliveryMode,
      timezone: input.timezone,
      instructions: input.instructions,
      inboundRateLimitPerMinute: input.inboundRateLimitPerMinute,
      maxPendingEvents: input.maxPendingEvents,
      overflowPolicy: input.overflowPolicy,
      maxDeferredAgeMinutes: input.maxDeferredAgeMinutes,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'channel_binding_timezone_invalid'
    ) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_timezone',
            message: 'Binding timezone must be a valid IANA timezone.',
          },
        },
      };
    }
    throw error;
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        binding: toBindingApiRecord(updated),
      },
    },
  };
}

export function deleteTalkChannelRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to edit channels for this talk.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  deleteTalkChannelBinding(input.bindingId);
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        deleted: true,
      },
    },
  };
}

export function listTalkChannelBindingStateRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  const entries = listTalkStateEntriesByPrefix(
    input.talkId,
    buildTalkChannelBindingStateNamespace(binding.id),
  ).map((entry) => toBindingStateApiRecord({ bindingId: binding.id, entry }));
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        bindingId: binding.id,
        stateNamespace: buildTalkChannelBindingStateNamespace(binding.id),
        entries,
      },
    },
  };
}

export function upsertTalkChannelBindingStateRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  keySuffix: string;
  value: unknown;
  expectedVersion: number;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to edit channel memory for this talk.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }

  try {
    const key = buildBindingStateKey(binding.id, input.keySuffix);
    const result = upsertTalkStateEntry({
      talkId: input.talkId,
      key,
      value: input.value,
      expectedVersion: input.expectedVersion,
      updatedByUserId: input.auth.userId,
    });
    if (!result.ok) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'state_version_conflict',
            message: 'Channel memory changed before this save completed.',
            details: {
              current: toBindingStateApiRecord({
                bindingId: binding.id,
                entry: result.current,
              }),
            },
          },
        },
      };
    }
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          entry: toBindingStateApiRecord({
            bindingId: binding.id,
            entry: result.entry,
          }),
        },
      },
    };
  } catch (error) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_binding_state',
          message:
            error instanceof Error
              ? error.message
              : 'Binding state entry is invalid.',
        },
      },
    };
  }
}

export function deleteTalkChannelBindingStateRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  keySuffix: string;
  expectedVersion: number;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to edit channel memory for this talk.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }

  try {
    const key = buildBindingStateKey(binding.id, input.keySuffix);
    const existing = getTalkStateEntry(input.talkId, key);
    if (!existing) {
      return notFound('Binding memory entry not found.');
    }
    const result = deleteTalkStateEntry({
      talkId: input.talkId,
      key,
      expectedVersion: input.expectedVersion,
    });
    if (!result.ok) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'state_version_conflict',
            message: 'Channel memory changed before this delete completed.',
            details: {
              current: toBindingStateApiRecord({
                bindingId: binding.id,
                entry: result.current,
              }),
            },
          },
        },
      };
    }
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          deleted: true,
          keySuffix: existing.key.slice(
            buildTalkChannelBindingStateNamespace(binding.id).length,
          ),
        },
      },
    };
  } catch (error) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_binding_state',
          message:
            error instanceof Error
              ? error.message
              : 'Binding state entry is invalid.',
        },
      },
    };
  }
}

export async function reviewTalkChannelInstructionsRoute(input: {
  auth: AuthContext;
  talkId: string;
  platform: 'slack' | 'telegram';
  instructions: string;
  bindingId?: string | null;
  bindingLabel?: string | null;
  timezone?: string | null;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to review channel instructions for this talk.',
    );
  }
  const agent = resolvePrimaryAgent(input.talkId);
  if (!agent) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'talk_primary_agent_missing',
          message: 'This talk does not have a primary agent configured yet.',
        },
      },
    };
  }

  const now = new Date().toISOString();
  const runId = `run_${randomUUID()}`;
  const threadId = resolveThreadIdForTalk(input.talkId, null);
  createTalkRun({
    id: runId,
    talk_id: input.talkId,
    thread_id: threadId,
    requested_by: input.auth.userId,
    status: 'running',
    run_kind: 'instruction_review',
    trigger_message_id: null,
    idempotency_key: null,
    executor_alias: null,
    executor_model: null,
    created_at: now,
    started_at: now,
    ended_at: null,
    cancel_reason: null,
    metadata_json: JSON.stringify({
      kind: 'instruction_review',
      platform: input.platform,
      bindingId: input.bindingId ?? null,
      bindingLabel: input.bindingLabel ?? null,
      timezone: input.timezone ?? null,
    }),
  });
  appendOutboxEvent({
    topic: `talk:${input.talkId}`,
    eventType: 'talk_run_started',
    payload: JSON.stringify({
      talkId: input.talkId,
      threadId,
      runId,
      runKind: 'instruction_review',
      status: 'running',
      executorAlias: null,
      executorModel: null,
    }),
  });

  try {
    const result = await executeWithAgent(
      agent.id,
      {
        systemPrompt: [
          'You critique channel binding instructions for a messaging assistant.',
          'Respond with a single JSON object and no surrounding prose.',
          'Return keys: strengths, missing, removeOrSimplify, rewrittenInstructions.',
          'Each of strengths, missing, and removeOrSimplify must be arrays of concise strings.',
          'rewrittenInstructions must be either a complete improved instructions draft string or null.',
          'Focus on clarity, reply-vs-silence rules, stable identity hints, state key strategy, timezone/date rules, and avoiding irrelevant detail.',
        ].join('\n'),
        contextTools: [],
        connectorTools: [],
        history: [],
      },
      [
        `Platform: ${input.platform}`,
        input.bindingLabel ? `Binding label: ${input.bindingLabel}` : null,
        input.timezone ? `Binding timezone: ${input.timezone}` : null,
        input.bindingId
          ? `Binding state namespace: ${buildTalkChannelBindingStateNamespace(input.bindingId)}`
          : null,
        'Instructions to review:',
        input.instructions.trim(),
      ]
        .filter(Boolean)
        .join('\n\n'),
      {
        runId,
        userId: input.auth.userId,
        alwaysAllowedContextToolNames: [],
        maxToolIterations: 1,
      },
    );

    const review = parseInstructionReviewResponse(result.content);
    const endedAt = new Date().toISOString();
    setTalkRunMetadataJson(
      runId,
      JSON.stringify({
        kind: 'instruction_review',
        platform: input.platform,
        bindingId: input.bindingId ?? null,
        bindingLabel: input.bindingLabel ?? null,
        timezone: input.timezone ?? null,
        review,
        usage: result.usage ?? null,
        providerId: result.providerId,
        modelId: result.modelId,
        rawOutput: result.content,
      }),
    );
    markTalkRunStatus(runId, 'completed', endedAt, null);
    appendOutboxEvent({
      topic: `talk:${input.talkId}`,
      eventType: 'talk_run_completed',
      payload: JSON.stringify({
        talkId: input.talkId,
        threadId,
        runId,
        runKind: 'instruction_review',
        triggerMessageId: null,
        responseMessageId: null,
        responseGroupId: null,
        sequenceIndex: null,
        executorAlias: null,
        executorModel: null,
      }),
    });

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          review,
        },
      },
    };
  } catch (error) {
    const endedAt = new Date().toISOString();
    const message =
      error instanceof Error ? error.message : 'Instruction review failed.';
    setTalkRunMetadataJson(
      runId,
      JSON.stringify({
        kind: 'instruction_review',
        platform: input.platform,
        bindingId: input.bindingId ?? null,
        bindingLabel: input.bindingLabel ?? null,
        timezone: input.timezone ?? null,
        error: message,
      }),
    );
    markTalkRunStatus(
      runId,
      'failed',
      endedAt,
      `instruction_review: ${message}`,
    );
    appendOutboxEvent({
      topic: `talk:${input.talkId}`,
      eventType: 'talk_run_failed',
      payload: JSON.stringify({
        talkId: input.talkId,
        threadId,
        runId,
        runKind: 'instruction_review',
        triggerMessageId: null,
        responseGroupId: null,
        sequenceIndex: null,
        errorCode: 'instruction_review_failed',
        errorMessage: message,
        executorAlias: null,
        executorModel: null,
      }),
    });
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'instruction_review_failed',
          message,
        },
      },
    };
  }
}

export function listTalkChannelIngressFailuresRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to view channel failures for this talk.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        failures: listChannelIngressFailures(input.bindingId),
      },
    },
  };
}

export function retryTalkChannelIngressFailureRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  rowId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to retry channel ingress failures.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  const now = Date.now();
  const recent = trimManualRetryTimestamps(input.bindingId, now);
  if (recent.length >= 5) {
    return {
      statusCode: 429,
      body: {
        ok: false,
        error: {
          code: 'retry_rate_limited',
          message:
            'Too many manual retries for this binding. Try again shortly.',
        },
      },
    };
  }
  const retried = retryChannelIngressFailure(input.rowId);
  if (!retried) {
    return notFound('Channel ingress failure not found.');
  }
  recent.push(now);
  manualIngressRetryTimestamps.set(input.bindingId, recent);
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        retried: true,
      },
    },
  };
}

export function deleteTalkChannelIngressFailureRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  rowId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to dismiss channel ingress failures.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  const deleted = deleteChannelIngressQueueRow(input.rowId);
  if (!deleted) {
    return notFound('Channel ingress failure not found.');
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        deleted: true,
      },
    },
  };
}

export function listTalkChannelDeliveryFailuresRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to view channel delivery failures.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        failures: listChannelDeliveryFailures(input.bindingId),
      },
    },
  };
}

export function retryTalkChannelDeliveryFailureRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  rowId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to retry channel delivery failures.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  const retried = retryChannelDeliveryFailure(input.rowId);
  if (!retried) {
    return notFound('Channel delivery failure not found.');
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        retried: true,
      },
    },
  };
}

export function deleteTalkChannelDeliveryFailureRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  rowId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to dismiss channel delivery failures.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  const deleted = deleteChannelDeliveryOutboxRow(input.rowId);
  if (!deleted) {
    return notFound('Channel delivery failure not found.');
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        deleted: true,
      },
    },
  };
}

export function testTalkChannelBindingRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  sendTestMessage?: (bindingId: string, text: string) => Promise<void>;
}) {
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to test this talk channel binding.',
    );
  }
  if (!input.sendTestMessage) {
    return {
      statusCode: 501,
      body: {
        ok: false,
        error: {
          code: 'channel_test_unavailable',
          message: 'Test-send is not available in this runtime.',
        },
      },
    };
  }
  return input
    .sendTestMessage(input.bindingId, 'This is a test from ClawRocket.')
    .then(() => {
      // A successful test send proves the binding and connection work.
      // Update last_delivery_at so diagnosis moves out of "No activity yet",
      // and reset the connection probe state so the delivery worker stops
      // deferring for connection_unreachable.
      updateBindingDeliveryResult(input.bindingId, {
        lastDeliveryAt: new Date().toISOString(),
      });
      updateConnectionProbeResult(binding.connection_id, true);
      return {
        statusCode: 200,
        body: {
          ok: true,
          data: {
            sent: true,
          },
        },
      };
    })
    .catch((error: unknown) => ({
      statusCode: 502,
      body: {
        ok: false,
        error: {
          code: 'channel_test_failed',
          message: formatChannelTestSendError(binding.platform, error),
        },
      },
    }));
}

export async function unquarantineTalkChannelBindingRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  sendTestMessage?: (bindingId: string, text: string) => Promise<void>;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to unquarantine this binding.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  if (!input.sendTestMessage) {
    return {
      statusCode: 501,
      body: {
        ok: false,
        error: {
          code: 'channel_test_unavailable',
          message: 'Test-send is not available in this runtime.',
        },
      },
    };
  }

  try {
    await input.sendTestMessage(
      input.bindingId,
      'This is a test from ClawRocket — reconnecting channel.',
    );
    clearBindingQuarantine(input.bindingId);
    updateBindingDeliveryResult(input.bindingId, {
      lastDeliveryAt: new Date().toISOString(),
    });
    // A successful send proves the connection is reachable — reset probe state
    // so the delivery worker stops deferring and diagnosis shows healthy.
    updateConnectionProbeResult(binding.connection_id, true);
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: { unquarantined: true },
      },
    };
  } catch (error) {
    const code =
      error instanceof ChannelDeliveryError
        ? error.code
        : error && typeof error === 'object' && 'code' in error
          ? String((error as { code: string }).code)
          : 'test_failed';
    const message = formatChannelTestSendError(binding.platform, error);
    const errorAt = new Date().toISOString();
    quarantineBinding(input.bindingId, code);
    updateBindingDeliveryResult(input.bindingId, {
      errorCode: code,
      errorDetail: message,
      errorAt,
    });
    return {
      statusCode: 502,
      body: {
        ok: false,
        error: { code, message },
      },
    };
  }
}

export function retryTalkChannelDeliveryFailuresCappedRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  maxAgeMins?: number;
  maxCount?: number;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden('You do not have permission to retry delivery failures.');
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  const result = retryChannelDeliveryFailuresCapped({
    bindingId: input.bindingId,
    maxAgeMins: input.maxAgeMins,
    maxCount: input.maxCount,
  });
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: result,
    },
  };
}
