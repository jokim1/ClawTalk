import { randomUUID } from 'crypto';

import { TIMEZONE } from '../../config.js';
import { getDb } from '../../db.js';

import {
  createTalkThread,
  createTalkMessage,
  createTalkRun,
  hasActiveTalkRuns,
  touchTalkUpdatedAt,
  resolveThreadIdForTalk,
} from './accessors.js';
import { forceDeleteTalkStateEntriesByPrefix } from './context-accessors.js';
import { resolvePrimaryAgent } from '../agents/agent-registry.js';

export type ChannelPlatform = 'telegram' | 'slack';
export type ChannelHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'disconnected'
  | 'error';
export type ChannelOverflowPolicy = 'drop_oldest' | 'drop_newest';
export type ChannelResponseMode = 'off' | 'mentions' | 'all';
export type ChannelResponderMode = 'primary' | 'agent';
export type ChannelDeliveryMode = 'reply' | 'channel';
export type ChannelThreadMode = 'conversation';
export type ChannelIngressStatus =
  | 'pending'
  | 'processing'
  | 'deferred'
  | 'completed'
  | 'dropped'
  | 'dead_letter';
export type ChannelDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'dead_letter';

export interface ChannelConnectionRecord {
  id: string;
  platform: ChannelPlatform;
  connection_mode: string;
  account_key: string;
  display_name: string;
  enabled: number;
  health_status: ChannelHealthStatus;
  last_health_check_at: string | null;
  last_health_error: string | null;
  consecutive_probe_failures: number;
  config_json: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface ChannelConnectionSecretRecord {
  connection_id: string;
  ciphertext: string;
  updated_at: string;
  updated_by: string | null;
}

export interface ChannelProviderConfigRecord {
  platform: ChannelPlatform;
  config_json: string;
  updated_at: string;
  updated_by: string | null;
}

export interface ChannelProviderSecretRecord {
  platform: ChannelPlatform;
  ciphertext: string;
  updated_at: string;
  updated_by: string | null;
}

export interface ChannelTargetRecord {
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
}

export interface ChannelTargetSearchPage {
  targets: ChannelTargetRecord[];
  totalCount: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export interface TalkChannelBindingRecord {
  id: string;
  talk_id: string;
  connection_id: string;
  target_kind: string;
  target_id: string;
  display_name: string;
  active: number;
  last_ingress_at: string | null;
  last_delivery_at: string | null;
  last_delivery_error_code: string | null;
  last_delivery_error_detail: string | null;
  last_delivery_error_at: string | null;
  health_quarantined: number;
  health_quarantine_code: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface TalkChannelPolicyRecord {
  binding_id: string;
  response_mode: ChannelResponseMode;
  responder_mode: ChannelResponderMode;
  responder_agent_id: string | null;
  delivery_mode: ChannelDeliveryMode;
  thread_mode: ChannelThreadMode;
  timezone: string;
  instructions: string | null;
  allowed_senders_json: string | null;
  inbound_rate_limit_per_minute: number;
  max_pending_events: number;
  overflow_policy: ChannelOverflowPolicy;
  max_deferred_age_minutes: number;
  updated_at: string;
  updated_by: string | null;
}

export interface TalkChannelBindingWithPolicyRecord
  extends TalkChannelBindingRecord, TalkChannelPolicyRecord {
  platform: ChannelPlatform;
  connection_mode: string;
  connection_display_name: string;
  connection_enabled: number;
  connection_health_status: ChannelHealthStatus;
  pending_ingress_count: number;
  deferred_ingress_count: number;
  dead_letter_count: number;
  unresolved_ingress_count: number;
  suppressed_reply_count: number;
  last_suppressed_at: string | null;
  last_suppression_reason: string | null;
  last_ingress_reason_code: string | null;
  last_delivery_reason_code: string | null;
}

type HydratedTalkChannelBindingRow = TalkChannelBindingWithPolicyRecord & {
  policy_updated_at: string;
  policy_updated_by: string | null;
};

export interface ChannelDeliveryBindingStateRecord {
  id: string;
  connection_id: string;
  active: number;
  connection_enabled: number;
  health_quarantined: number;
  connection_health_status: ChannelHealthStatus;
}

export interface ResolvedTalkChannelBindingRecord extends TalkChannelBindingWithPolicyRecord {
  config_json: string | null;
}

export interface ChannelIngressQueueRecord {
  id: string;
  binding_id: string;
  talk_id: string;
  connection_id: string;
  target_kind: string;
  target_id: string;
  platform_event_id: string;
  external_message_id: string | null;
  sender_id: string | null;
  sender_name: string | null;
  payload_json: string;
  status: ChannelIngressStatus;
  reason_code: string | null;
  reason_detail: string | null;
  dedupe_key: string;
  available_at: string;
  created_at: string;
  updated_at: string;
  attempt_count: number;
}

export interface ChannelDeliveryOutboxRecord {
  id: string;
  binding_id: string;
  talk_id: string;
  run_id: string;
  talk_message_id: string;
  target_kind: string;
  target_id: string;
  payload_json: string;
  status: ChannelDeliveryStatus;
  reason_code: string | null;
  reason_detail: string | null;
  dedupe_key: string;
  available_at: string;
  created_at: string;
  updated_at: string;
  attempt_count: number;
}

export interface TalkChannelThreadMapRecord {
  binding_id: string;
  source_thread_key: string;
  talk_thread_id: string;
  created_at: string;
  updated_at: string;
}

export function buildTalkChannelBindingStateNamespace(
  bindingId: string,
): string {
  return `channel.${bindingId}.`;
}

function getDefaultChannelBindingTimezone(): string {
  return TIMEZONE || 'UTC';
}

function normalizeChannelBindingTimezone(value?: string | null): string {
  const normalized = (value ?? getDefaultChannelBindingTimezone()).trim();
  if (!normalized) {
    throw new Error('channel_binding_timezone_invalid');
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date());
    return normalized;
  } catch {
    throw new Error('channel_binding_timezone_invalid');
  }
}

function normalizeTimestamp(value?: string | null): string {
  return value || new Date().toISOString();
}

function serializeJson(
  value: Record<string, unknown> | null | undefined,
): string | null {
  if (!value) return null;
  return JSON.stringify(value);
}

function parseJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseJsonMap(
  value: string | null | undefined,
): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function buildChannelConversationThreadTitle(input: {
  targetDisplayName?: string | null;
  senderName?: string | null;
  senderId?: string | null;
}): string | null {
  const target = (input.targetDisplayName || '').trim();
  const sender = (input.senderName || input.senderId || '').trim();
  if (!target && !sender) {
    return 'Channel conversation';
  }
  if (!target) return sender;
  if (!sender) return `${target} conversation`;
  return `${target} · ${sender}`;
}

export function ensureSystemManagedTelegramConnection(
  now?: string,
): ChannelConnectionRecord {
  const timestamp = normalizeTimestamp(now);
  const existing = getDb()
    .prepare(
      `
      SELECT *
      FROM channel_connections
      WHERE platform = 'telegram' AND account_key = 'telegram:system'
      LIMIT 1
    `,
    )
    .get() as ChannelConnectionRecord | undefined;

  const id = existing?.id || 'channel-conn:telegram:system';
  getDb()
    .prepare(
      `
      INSERT INTO channel_connections (
        id, platform, connection_mode, account_key, display_name, enabled,
        health_status, last_health_check_at, last_health_error, config_json,
        created_at, updated_at, created_by, updated_by
      ) VALUES (?, 'telegram', 'system_managed', 'telegram:system', ?, 1, 'healthy', NULL, NULL, ?, ?, ?, NULL, NULL)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        enabled = 1,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      id,
      'Telegram (System Managed)',
      JSON.stringify({ managedBy: 'runtime', platform: 'telegram' }),
      existing?.created_at || timestamp,
      timestamp,
    );

  return getChannelConnectionById(id)!;
}

export function getChannelConnectionById(
  connectionId: string,
): ChannelConnectionRecord | undefined {
  return getDb()
    .prepare(`SELECT * FROM channel_connections WHERE id = ?`)
    .get(connectionId) as ChannelConnectionRecord | undefined;
}

export function getChannelConnectionByPlatformAccount(input: {
  platform: ChannelPlatform;
  accountKey: string;
}): ChannelConnectionRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM channel_connections
      WHERE platform = ?
        AND account_key = ?
      LIMIT 1
    `,
    )
    .get(input.platform, input.accountKey) as
    | ChannelConnectionRecord
    | undefined;
}

export function upsertChannelConnection(input: {
  platform: ChannelPlatform;
  connectionMode: string;
  accountKey: string;
  displayName: string;
  enabled?: boolean;
  config?: Record<string, unknown> | null;
  createdBy?: string | null;
  updatedBy?: string | null;
  healthStatus?: ChannelHealthStatus;
  lastHealthCheckAt?: string | null;
  lastHealthError?: string | null;
  now?: string;
}): ChannelConnectionRecord {
  const now = normalizeTimestamp(input.now);
  const existing = getChannelConnectionByPlatformAccount({
    platform: input.platform,
    accountKey: input.accountKey,
  });
  const connectionId =
    existing?.id ||
    `channel-conn:${input.platform}:${randomUUID().replace(/-/g, '')}`;

  getDb()
    .prepare(
      `
      INSERT INTO channel_connections (
        id, platform, connection_mode, account_key, display_name, enabled,
        health_status, last_health_check_at, last_health_error, config_json,
        created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        connection_mode = excluded.connection_mode,
        display_name = excluded.display_name,
        enabled = excluded.enabled,
        health_status = excluded.health_status,
        last_health_check_at = excluded.last_health_check_at,
        last_health_error = excluded.last_health_error,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `,
    )
    .run(
      connectionId,
      input.platform,
      input.connectionMode,
      input.accountKey,
      input.displayName,
      input.enabled === false ? 0 : 1,
      input.healthStatus || existing?.health_status || 'healthy',
      input.lastHealthCheckAt ?? existing?.last_health_check_at ?? null,
      input.lastHealthError ?? existing?.last_health_error ?? null,
      serializeJson(input.config ?? null),
      existing?.created_at || now,
      now,
      existing?.created_by || input.createdBy || null,
      input.updatedBy || existing?.updated_by || input.createdBy || null,
    );

  return getChannelConnectionById(connectionId)!;
}

export function getChannelConnectionSecret(
  connectionId: string,
): ChannelConnectionSecretRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM channel_connection_secrets
      WHERE connection_id = ?
      LIMIT 1
    `,
    )
    .get(connectionId) as ChannelConnectionSecretRecord | undefined;
}

export function getChannelProviderConfig(
  platform: ChannelPlatform,
): ChannelProviderConfigRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM channel_provider_configs
      WHERE platform = ?
      LIMIT 1
    `,
    )
    .get(platform) as ChannelProviderConfigRecord | undefined;
}

export function setChannelProviderConfig(input: {
  platform: ChannelPlatform;
  configJson: string;
  updatedBy: string;
  now?: string;
}): ChannelProviderConfigRecord {
  const now = normalizeTimestamp(input.now);
  getDb()
    .prepare(
      `
      INSERT INTO channel_provider_configs (
        platform, config_json, updated_at, updated_by
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(platform) DO UPDATE SET
        config_json = excluded.config_json,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `,
    )
    .run(input.platform, input.configJson, now, input.updatedBy);
  return getChannelProviderConfig(input.platform)!;
}

export function deleteChannelProviderConfig(
  platform: ChannelPlatform,
): boolean {
  return (
    getDb()
      .prepare(`DELETE FROM channel_provider_configs WHERE platform = ?`)
      .run(platform).changes > 0
  );
}

export function getChannelProviderSecret(
  platform: ChannelPlatform,
): ChannelProviderSecretRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM channel_provider_secrets
      WHERE platform = ?
      LIMIT 1
    `,
    )
    .get(platform) as ChannelProviderSecretRecord | undefined;
}

export function setChannelProviderSecret(input: {
  platform: ChannelPlatform;
  ciphertext: string;
  updatedBy: string;
  now?: string;
}): ChannelProviderSecretRecord {
  const now = normalizeTimestamp(input.now);
  getDb()
    .prepare(
      `
      INSERT INTO channel_provider_secrets (
        platform, ciphertext, updated_at, updated_by
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(platform) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `,
    )
    .run(input.platform, input.ciphertext, now, input.updatedBy);
  return getChannelProviderSecret(input.platform)!;
}

export function deleteChannelProviderSecret(
  platform: ChannelPlatform,
): boolean {
  return (
    getDb()
      .prepare(`DELETE FROM channel_provider_secrets WHERE platform = ?`)
      .run(platform).changes > 0
  );
}

export function setChannelConnectionSecret(input: {
  connectionId: string;
  ciphertext: string;
  updatedBy: string;
}): ChannelConnectionSecretRecord | undefined {
  const connection = getChannelConnectionById(input.connectionId);
  if (!connection) return undefined;

  const now = normalizeTimestamp();
  getDb()
    .prepare(
      `
      INSERT INTO channel_connection_secrets (
        connection_id,
        ciphertext,
        updated_at,
        updated_by
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `,
    )
    .run(input.connectionId, input.ciphertext, now, input.updatedBy);

  getDb()
    .prepare(
      `
      UPDATE channel_connections
      SET updated_at = ?,
          updated_by = ?
      WHERE id = ?
    `,
    )
    .run(now, input.updatedBy, input.connectionId);

  return getChannelConnectionSecret(input.connectionId);
}

export function deleteChannelConnectionSecret(
  connectionId: string,
  updatedBy?: string | null,
): boolean {
  const result = getDb()
    .prepare(
      `
      DELETE FROM channel_connection_secrets
      WHERE connection_id = ?
    `,
    )
    .run(connectionId);

  if (result.changes > 0) {
    getDb()
      .prepare(
        `
        UPDATE channel_connections
        SET updated_at = ?,
            updated_by = ?
        WHERE id = ?
      `,
      )
      .run(normalizeTimestamp(), updatedBy ?? null, connectionId);
  }

  return result.changes > 0;
}

export function listChannelConnections(): ChannelConnectionRecord[] {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM channel_connections
      ORDER BY platform ASC, display_name ASC, created_at ASC
    `,
    )
    .all() as ChannelConnectionRecord[];
}

export function deleteChannelConnection(connectionId: string): boolean {
  return (
    getDb()
      .prepare(`DELETE FROM channel_connections WHERE id = ?`)
      .run(connectionId).changes > 0
  );
}

export function updateChannelConnectionConfig(input: {
  connectionId: string;
  config: Record<string, unknown> | null;
  updatedBy?: string | null;
  healthStatus?: ChannelHealthStatus;
  lastHealthCheckAt?: string | null;
  lastHealthError?: string | null;
}): ChannelConnectionRecord | undefined {
  const current = getChannelConnectionById(input.connectionId);
  if (!current) return undefined;
  const now = normalizeTimestamp();
  getDb()
    .prepare(
      `
      UPDATE channel_connections
      SET config_json = ?,
          health_status = ?,
          last_health_check_at = ?,
          last_health_error = ?,
          updated_at = ?,
          updated_by = ?
      WHERE id = ?
    `,
    )
    .run(
      serializeJson(input.config),
      input.healthStatus ?? current.health_status,
      input.lastHealthCheckAt === undefined
        ? current.last_health_check_at
        : input.lastHealthCheckAt,
      input.lastHealthError === undefined
        ? current.last_health_error
        : input.lastHealthError,
      now,
      input.updatedBy ?? current.updated_by,
      input.connectionId,
    );
  return getChannelConnectionById(input.connectionId);
}

export function upsertChannelTarget(input: {
  connectionId: string;
  targetKind: string;
  targetId: string;
  displayName: string;
  metadataJson?: string | null;
  approved?: boolean;
  registeredAt?: string | null;
  registeredBy?: string | null;
  lastSeenAt?: string;
}): void {
  const now = normalizeTimestamp(input.lastSeenAt);
  getDb()
    .prepare(
      `
      INSERT INTO channel_targets (
        connection_id, target_kind, target_id, display_name, metadata_json,
        approved, registered_at, registered_by, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, target_kind, target_id) DO UPDATE SET
        display_name = excluded.display_name,
        metadata_json = excluded.metadata_json,
        approved = MAX(channel_targets.approved, excluded.approved),
        registered_at = COALESCE(channel_targets.registered_at, excluded.registered_at),
        registered_by = COALESCE(channel_targets.registered_by, excluded.registered_by),
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      input.connectionId,
      input.targetKind,
      input.targetId,
      input.displayName,
      input.metadataJson || null,
      input.approved ? 1 : 0,
      input.registeredAt || null,
      input.registeredBy || null,
      now,
      now,
      now,
    );
}

export function getChannelTarget(input: {
  connectionId: string;
  targetKind: string;
  targetId: string;
}): ChannelTargetRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM channel_targets
      WHERE connection_id = ?
        AND target_kind = ?
        AND target_id = ?
      LIMIT 1
    `,
    )
    .get(input.connectionId, input.targetKind, input.targetId) as
    | ChannelTargetRecord
    | undefined;
}

export function approveChannelTarget(input: {
  connectionId: string;
  targetKind: string;
  targetId: string;
  displayName?: string | null;
  metadata?: Record<string, unknown> | null;
  registeredBy: string;
  now?: string;
}): ChannelTargetRecord {
  const timestamp = normalizeTimestamp(input.now);
  const existing = getChannelTarget(input);

  if (existing) {
    const nextDisplayName = input.displayName?.trim() || existing.display_name;
    const nextMetadata =
      input.metadata !== undefined
        ? serializeJson(input.metadata)
        : existing.metadata_json;
    getDb()
      .prepare(
        `
        UPDATE channel_targets
        SET display_name = ?,
            metadata_json = ?,
            approved = 1,
            registered_at = ?,
            registered_by = ?,
            updated_at = ?
        WHERE connection_id = ?
          AND target_kind = ?
          AND target_id = ?
      `,
      )
      .run(
        nextDisplayName,
        nextMetadata,
        timestamp,
        input.registeredBy,
        timestamp,
        input.connectionId,
        input.targetKind,
        input.targetId,
      );
    return getChannelTarget(input)!;
  }

  upsertChannelTarget({
    connectionId: input.connectionId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    displayName: input.displayName?.trim() || input.targetId,
    metadataJson: serializeJson(input.metadata),
    approved: true,
    registeredAt: timestamp,
    registeredBy: input.registeredBy,
    lastSeenAt: timestamp,
  });
  return getChannelTarget(input)!;
}

export function unapproveChannelTarget(input: {
  connectionId: string;
  targetKind: string;
  targetId: string;
  updatedBy?: string | null;
  now?: string;
}): { removed: boolean; deactivatedBindingCount: number } {
  const timestamp = normalizeTimestamp(input.now);
  const tx = getDb().transaction(() => {
    const targetResult = getDb()
      .prepare(
        `
        UPDATE channel_targets
        SET approved = 0,
            registered_at = NULL,
            registered_by = NULL,
            updated_at = ?
        WHERE connection_id = ?
          AND target_kind = ?
          AND target_id = ?
      `,
      )
      .run(timestamp, input.connectionId, input.targetKind, input.targetId);

    const bindingResult = getDb()
      .prepare(
        `
        UPDATE talk_channel_bindings
        SET active = 0,
            updated_at = ?,
            updated_by = COALESCE(?, updated_by)
        WHERE connection_id = ?
          AND target_kind = ?
          AND target_id = ?
          AND active = 1
      `,
      )
      .run(
        timestamp,
        input.updatedBy ?? null,
        input.connectionId,
        input.targetKind,
        input.targetId,
      );

    return {
      removed: targetResult.changes > 0,
      deactivatedBindingCount: bindingResult.changes,
    };
  });

  return tx();
}

export function searchChannelTargets(input: {
  connectionId: string;
  query?: string;
  limit?: number;
  offset?: number;
  approval?: 'all' | 'approved' | 'discovered';
}): ChannelTargetSearchPage {
  const query = input.query?.trim() || '';
  const escaped = query
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
  const like = `%${escaped}%`;
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const approval = input.approval || 'all';
  const approvalSql =
    approval === 'approved'
      ? 'AND ct.approved = 1'
      : approval === 'discovered'
        ? 'AND ct.approved = 0'
        : '';
  const querySql = query
    ? `
        AND (
          ct.display_name LIKE ? ESCAPE '\\'
          OR ct.target_id LIKE ? ESCAPE '\\'
        )
      `
    : '';
  const countRow = getDb()
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM channel_targets ct
      WHERE ct.connection_id = ?
      ${approvalSql}
      ${querySql}
    `,
    )
    .get(
      ...(query ? [input.connectionId, like, like] : [input.connectionId]),
    ) as { count: number } | undefined;
  const totalCount = countRow?.count || 0;
  const targets = getDb()
    .prepare(
      `
      SELECT
        ct.*,
        b.id AS active_binding_id,
        b.talk_id AS active_binding_talk_id,
        COALESCE(t.topic_title, '(Untitled Talk)') AS active_binding_talk_title
      FROM channel_targets ct
      LEFT JOIN talk_channel_bindings b
        ON b.connection_id = ct.connection_id
       AND b.target_kind = ct.target_kind
       AND b.target_id = ct.target_id
       AND b.active = 1
      LEFT JOIN talks t
        ON t.id = b.talk_id
      WHERE ct.connection_id = ?
      ${approvalSql}
      ${querySql}
      ORDER BY ct.last_seen_at DESC, ct.display_name ASC
      LIMIT ?
      OFFSET ?
    `,
    )
    .all(
      ...(query
        ? [input.connectionId, like, like, limit, offset]
        : [input.connectionId, limit, offset]),
    ) as ChannelTargetRecord[];
  const hasMore = offset + targets.length < totalCount;
  return {
    targets,
    totalCount,
    hasMore,
    nextOffset: hasMore ? offset + targets.length : null,
  };
}

const HYDRATED_TALK_CHANNEL_BINDING_SELECT = `
  SELECT
    b.*,
    p.binding_id,
    p.response_mode,
    p.responder_mode,
    p.responder_agent_id,
    p.delivery_mode,
    p.thread_mode,
    COALESCE(p.timezone, '${getDefaultChannelBindingTimezone().replace(/'/g, "''")}') AS timezone,
    p.instructions,
    p.allowed_senders_json,
    p.inbound_rate_limit_per_minute,
    p.max_pending_events,
    p.overflow_policy,
    p.max_deferred_age_minutes,
    p.updated_at AS policy_updated_at,
    p.updated_by AS policy_updated_by,
    c.platform,
    c.connection_mode,
    c.display_name AS connection_display_name,
    c.enabled AS connection_enabled,
    c.health_status AS connection_health_status,
    (
      SELECT COUNT(*)
      FROM channel_ingress_queue q
      WHERE q.binding_id = b.id AND q.status = 'pending'
    ) AS pending_ingress_count,
    (
      SELECT COUNT(*)
      FROM channel_ingress_queue q
      WHERE q.binding_id = b.id AND q.status = 'deferred'
    ) AS deferred_ingress_count,
    (
      SELECT COUNT(*)
      FROM channel_delivery_outbox q
      WHERE q.binding_id = b.id AND q.status = 'dead_letter'
    ) AS dead_letter_count,
    (
      SELECT COUNT(*)
      FROM channel_ingress_queue q
      WHERE q.binding_id = b.id AND q.status IN ('deferred', 'dead_letter')
    ) AS unresolved_ingress_count,
    (
      SELECT COUNT(*)
      FROM talk_runs r
      WHERE r.source_binding_id = b.id
        AND json_extract(r.metadata_json, '$.channelDelivery.suppressed') = 1
    ) AS suppressed_reply_count,
    (
      SELECT r.ended_at
      FROM talk_runs r
      WHERE r.source_binding_id = b.id
        AND json_extract(r.metadata_json, '$.channelDelivery.suppressed') = 1
      ORDER BY r.ended_at DESC
      LIMIT 1
    ) AS last_suppressed_at,
    (
      SELECT json_extract(r.metadata_json, '$.channelDelivery.suppressionReason')
      FROM talk_runs r
      WHERE r.source_binding_id = b.id
        AND json_extract(r.metadata_json, '$.channelDelivery.suppressed') = 1
      ORDER BY r.ended_at DESC
      LIMIT 1
    ) AS last_suppression_reason,
    (
      SELECT q.reason_code
      FROM channel_ingress_queue q
      WHERE q.binding_id = b.id
        AND q.status IN ('dropped', 'dead_letter')
      ORDER BY q.updated_at DESC
      LIMIT 1
    ) AS last_ingress_reason_code,
    (
      SELECT q.reason_code
      FROM channel_delivery_outbox q
      WHERE q.binding_id = b.id
        AND q.status = 'dead_letter'
      ORDER BY q.updated_at DESC
      LIMIT 1
    ) AS last_delivery_reason_code
  FROM talk_channel_bindings b
  JOIN talk_channel_policies p ON p.binding_id = b.id
  JOIN channel_connections c ON c.id = b.connection_id
`;

function queryHydratedTalkChannelBindings(
  whereClause: string,
  ...params: unknown[]
): HydratedTalkChannelBindingRow[] {
  return getDb()
    .prepare(
      `${HYDRATED_TALK_CHANNEL_BINDING_SELECT}
      ${whereClause}
    `,
    )
    .all(...params) as HydratedTalkChannelBindingRow[];
}

function hydrateTalkChannelBinding(
  bindingId: string,
): HydratedTalkChannelBindingRow | undefined {
  return queryHydratedTalkChannelBindings(
    `
      WHERE b.id = ?
      LIMIT 1
    `,
    bindingId,
  )[0];
}

function normalizeHydratedBinding(
  row: HydratedTalkChannelBindingRow | undefined,
): TalkChannelBindingWithPolicyRecord | undefined {
  if (!row) return undefined;
  const {
    policy_updated_at: _policyUpdatedAt,
    policy_updated_by: _policyUpdatedBy,
    ...binding
  } = row;
  return {
    ...binding,
  };
}

export function countRecentChannelIngressEvents(input: {
  bindingId: string;
  since: string;
}): number {
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM channel_ingress_queue
      WHERE binding_id = ?
        AND created_at >= ?
    `,
    )
    .get(input.bindingId, input.since) as { count: number } | undefined;
  return row?.count || 0;
}

export function listTalkChannelBindingsForTalk(
  talkId: string,
): TalkChannelBindingWithPolicyRecord[] {
  return queryHydratedTalkChannelBindings(
    `
      WHERE b.talk_id = ?
      ORDER BY b.created_at ASC
    `,
    talkId,
  )
    .map((row) => normalizeHydratedBinding(row))
    .filter((row): row is TalkChannelBindingWithPolicyRecord => Boolean(row));
}

export function getTalkChannelBindingById(
  bindingId: string,
): TalkChannelBindingWithPolicyRecord | undefined {
  return normalizeHydratedBinding(hydrateTalkChannelBinding(bindingId));
}

export function getTalkChannelThreadMap(input: {
  bindingId: string;
  sourceThreadKey: string;
}): TalkChannelThreadMapRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT binding_id, source_thread_key, talk_thread_id, created_at, updated_at
      FROM talk_channel_thread_map
      WHERE binding_id = ? AND source_thread_key = ?
      LIMIT 1
    `,
    )
    .get(input.bindingId, input.sourceThreadKey) as
    | TalkChannelThreadMapRecord
    | undefined;
}

function resolveOrCreateChannelConversationThread(input: {
  talkId: string;
  bindingId: string;
  sourceThreadKey?: string | null;
  metadataJson?: string | null;
  now: string;
}): string {
  if (!input.sourceThreadKey) {
    return resolveThreadIdForTalk(input.talkId, null);
  }

  const existing = getTalkChannelThreadMap({
    bindingId: input.bindingId,
    sourceThreadKey: input.sourceThreadKey,
  });
  if (existing) {
    getDb()
      .prepare(
        `
        UPDATE talk_channel_thread_map
        SET updated_at = ?
        WHERE binding_id = ? AND source_thread_key = ?
      `,
      )
      .run(input.now, input.bindingId, input.sourceThreadKey);
    return existing.talk_thread_id;
  }

  const metadata = parseJsonMap(input.metadataJson);
  const thread = createTalkThread({
    talkId: input.talkId,
    title: buildChannelConversationThreadTitle({
      targetDisplayName:
        typeof metadata?.targetDisplayName === 'string'
          ? metadata.targetDisplayName
          : null,
      senderName:
        typeof metadata?.senderName === 'string' ? metadata.senderName : null,
      senderId:
        typeof metadata?.senderId === 'string' ? metadata.senderId : null,
    }),
  });

  getDb()
    .prepare(
      `
      INSERT INTO talk_channel_thread_map (
        binding_id, source_thread_key, talk_thread_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `,
    )
    .run(
      input.bindingId,
      input.sourceThreadKey,
      thread.id,
      input.now,
      input.now,
    );

  return thread.id;
}

export function getChannelDeliveryBindingState(
  bindingId: string,
): ChannelDeliveryBindingStateRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT
        b.id,
        b.connection_id,
        b.active,
        c.enabled AS connection_enabled,
        b.health_quarantined,
        c.health_status AS connection_health_status
      FROM talk_channel_bindings b
      JOIN channel_connections c ON c.id = b.connection_id
      WHERE b.id = ?
      LIMIT 1
    `,
    )
    .get(bindingId) as ChannelDeliveryBindingStateRecord | undefined;
}

export function getResolvedTalkChannelBinding(input: {
  connectionId: string;
  targetKind: string;
  targetId: string;
}): ResolvedTalkChannelBindingRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT
        b.*,
        p.binding_id,
        p.response_mode,
        p.responder_mode,
        p.responder_agent_id,
        p.delivery_mode,
        p.thread_mode,
        COALESCE(p.timezone, '${getDefaultChannelBindingTimezone().replace(/'/g, "''")}') AS timezone,
        p.instructions,
        p.allowed_senders_json,
        p.inbound_rate_limit_per_minute,
        p.max_pending_events,
        p.overflow_policy,
        p.max_deferred_age_minutes,
        p.updated_at,
        p.updated_by,
        c.platform,
        c.connection_mode,
        c.display_name AS connection_display_name,
        c.enabled AS connection_enabled,
        c.health_status AS connection_health_status,
        c.config_json,
        0 AS pending_ingress_count,
        0 AS deferred_ingress_count,
        0 AS dead_letter_count,
        0 AS unresolved_ingress_count,
        0 AS suppressed_reply_count,
        NULL AS last_suppressed_at,
        NULL AS last_suppression_reason,
        NULL AS last_ingress_reason_code,
        NULL AS last_delivery_reason_code
      FROM talk_channel_bindings b
      JOIN talk_channel_policies p ON p.binding_id = b.id
      JOIN channel_connections c ON c.id = b.connection_id
      WHERE b.connection_id = ?
        AND b.target_kind = ?
        AND b.target_id = ?
        AND b.active = 1
      ORDER BY b.updated_at DESC, b.id DESC
      LIMIT 1
    `,
    )
    .get(input.connectionId, input.targetKind, input.targetId) as
    | ResolvedTalkChannelBindingRecord
    | undefined;
}

export function getActiveTalkChannelBindingOwner(input: {
  connectionId: string;
  targetKind: string;
  targetId: string;
}):
  | {
      id: string;
      talk_id: string;
      talk_title: string;
      display_name: string;
    }
  | undefined {
  return getDb()
    .prepare(
      `
      SELECT
        b.id,
        b.talk_id,
        COALESCE(t.topic_title, '(Untitled Talk)') AS talk_title,
        b.display_name
      FROM talk_channel_bindings b
      LEFT JOIN talks t ON t.id = b.talk_id
      WHERE b.connection_id = ?
        AND b.target_kind = ?
        AND b.target_id = ?
        AND b.active = 1
      ORDER BY b.updated_at DESC, b.id DESC
      LIMIT 1
    `,
    )
    .get(input.connectionId, input.targetKind, input.targetId) as
    | {
        id: string;
        talk_id: string;
        talk_title: string;
        display_name: string;
      }
    | undefined;
}

function resolveBindingResponderAgentId(
  talkId: string,
  responderMode: ChannelResponderMode,
  responderAgentId?: string | null,
): string {
  if (responderMode === 'agent' && responderAgentId) {
    const row = getDb()
      .prepare(
        `
        SELECT id
        FROM talk_agents
        WHERE talk_id = ? AND id = ?
        LIMIT 1
      `,
      )
      .get(talkId, responderAgentId) as { id: string } | undefined;
    if (row) return row.id;
  }
  const primary = resolvePrimaryAgent(talkId);
  if (!primary) {
    throw new Error('talk_primary_agent_missing');
  }
  return primary.id;
}

export function createTalkChannelBinding(input: {
  talkId: string;
  connectionId: string;
  targetKind: string;
  targetId: string;
  displayName: string;
  createdBy: string;
  responseMode?: ChannelResponseMode;
  responderMode?: ChannelResponderMode;
  responderAgentId?: string | null;
  deliveryMode?: ChannelDeliveryMode;
  threadMode?: ChannelThreadMode;
  timezone?: string | null;
  instructions?: string | null;
  allowedSendersJson?: string | null;
  inboundRateLimitPerMinute?: number;
  maxPendingEvents?: number;
  overflowPolicy?: ChannelOverflowPolicy;
  maxDeferredAgeMinutes?: number;
  now?: string;
}): TalkChannelBindingWithPolicyRecord {
  const now = normalizeTimestamp(input.now);
  const bindingId = `binding_${randomUUID()}`;
  const responseMode = input.responseMode || 'mentions';
  const responderMode = input.responderMode || 'primary';
  const responderAgentId = resolveBindingResponderAgentId(
    input.talkId,
    responderMode,
    input.responderAgentId,
  );
  const deliveryMode = input.deliveryMode || 'reply';
  const threadMode = input.threadMode || 'conversation';
  const timezone = normalizeChannelBindingTimezone(input.timezone);
  const inboundRateLimitPerMinute = Math.max(
    1,
    Math.floor(input.inboundRateLimitPerMinute ?? 10),
  );
  const maxPendingEvents = Math.max(
    1,
    Math.floor(input.maxPendingEvents ?? 20),
  );
  const maxDeferredAgeMinutes = Math.max(
    1,
    Math.floor(input.maxDeferredAgeMinutes ?? 10),
  );
  const overflowPolicy = input.overflowPolicy || 'drop_oldest';

  const tx = getDb().transaction(() => {
    getDb()
      .prepare(
        `
        INSERT INTO talk_channel_bindings (
          id, talk_id, connection_id, target_kind, target_id, display_name,
          active, created_at, updated_at, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `,
      )
      .run(
        bindingId,
        input.talkId,
        input.connectionId,
        input.targetKind,
        input.targetId,
        input.displayName,
        now,
        now,
        input.createdBy,
        input.createdBy,
      );

    getDb()
      .prepare(
        `
        INSERT INTO talk_channel_policies (
          binding_id, response_mode, responder_mode, responder_agent_id,
          delivery_mode, thread_mode, timezone, instructions, allowed_senders_json,
          inbound_rate_limit_per_minute, max_pending_events, overflow_policy,
          max_deferred_age_minutes, updated_at, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        bindingId,
        responseMode,
        responderMode,
        responderAgentId,
        deliveryMode,
        threadMode,
        timezone,
        input.instructions || null,
        input.allowedSendersJson || null,
        inboundRateLimitPerMinute,
        maxPendingEvents,
        overflowPolicy,
        maxDeferredAgeMinutes,
        now,
        input.createdBy,
      );
  });

  tx();
  return getTalkChannelBindingById(bindingId)!;
}

export function updateTalkChannelBinding(input: {
  bindingId: string;
  updatedBy: string;
  active?: boolean;
  displayName?: string;
  responseMode?: ChannelResponseMode;
  responderMode?: ChannelResponderMode;
  responderAgentId?: string | null;
  deliveryMode?: ChannelDeliveryMode;
  timezone?: string | null;
  instructions?: string | null;
  allowedSendersJson?: string | null;
  inboundRateLimitPerMinute?: number;
  maxPendingEvents?: number;
  overflowPolicy?: ChannelOverflowPolicy;
  maxDeferredAgeMinutes?: number;
  now?: string;
}): TalkChannelBindingWithPolicyRecord {
  const current = getTalkChannelBindingById(input.bindingId);
  if (!current) {
    throw new Error('talk_channel_binding_not_found');
  }
  const now = normalizeTimestamp(input.now);
  const nextActive =
    typeof input.active === 'boolean' ? (input.active ? 1 : 0) : current.active;
  const nextDisplayName = input.displayName?.trim() || current.display_name;
  const nextResponderMode = input.responderMode || current.responder_mode;
  const nextResponderAgentId = resolveBindingResponderAgentId(
    current.talk_id,
    nextResponderMode,
    input.responderAgentId === undefined
      ? current.responder_agent_id
      : input.responderAgentId,
  );
  const nextTimezone =
    input.timezone === undefined
      ? current.timezone
      : normalizeChannelBindingTimezone(input.timezone);

  const tx = getDb().transaction(() => {
    getDb()
      .prepare(
        `
        UPDATE talk_channel_bindings
        SET display_name = ?, active = ?, updated_at = ?, updated_by = ?
        WHERE id = ?
      `,
      )
      .run(nextDisplayName, nextActive, now, input.updatedBy, input.bindingId);

    getDb()
      .prepare(
        `
        UPDATE talk_channel_policies
        SET response_mode = ?,
            responder_mode = ?,
            responder_agent_id = ?,
            delivery_mode = ?,
            timezone = ?,
            instructions = ?,
            allowed_senders_json = ?,
            inbound_rate_limit_per_minute = ?,
            max_pending_events = ?,
            overflow_policy = ?,
            max_deferred_age_minutes = ?,
            updated_at = ?,
            updated_by = ?
        WHERE binding_id = ?
      `,
      )
      .run(
        input.responseMode || current.response_mode,
        nextResponderMode,
        nextResponderAgentId,
        input.deliveryMode || current.delivery_mode,
        nextTimezone,
        input.instructions === undefined
          ? current.instructions
          : input.instructions,
        input.allowedSendersJson === undefined
          ? current.allowed_senders_json
          : input.allowedSendersJson,
        Math.max(
          1,
          Math.floor(
            input.inboundRateLimitPerMinute ??
              current.inbound_rate_limit_per_minute,
          ),
        ),
        Math.max(
          1,
          Math.floor(input.maxPendingEvents ?? current.max_pending_events),
        ),
        input.overflowPolicy || current.overflow_policy,
        Math.max(
          1,
          Math.floor(
            input.maxDeferredAgeMinutes ?? current.max_deferred_age_minutes,
          ),
        ),
        now,
        input.updatedBy,
        input.bindingId,
      );

    if (current.active !== nextActive && nextActive === 0) {
      getDb()
        .prepare(
          `
          UPDATE channel_ingress_queue
          SET status = 'dropped',
              reason_code = 'binding_deactivated',
              reason_detail = 'Binding deactivated while ingress row was queued',
              updated_at = ?
          WHERE binding_id = ?
            AND status IN ('pending', 'deferred')
        `,
        )
        .run(now, input.bindingId);
      getDb()
        .prepare(
          `
          UPDATE channel_delivery_outbox
          SET status = 'dead_letter',
              reason_code = 'binding_deactivated',
              reason_detail = 'Binding deactivated before delivery attempt',
              updated_at = ?
          WHERE binding_id = ?
            AND status = 'pending'
        `,
        )
        .run(now, input.bindingId);
    }
  });

  tx();
  return getTalkChannelBindingById(input.bindingId)!;
}

export function deleteTalkChannelBinding(bindingId: string): void {
  const binding = getTalkChannelBindingById(bindingId);
  if (!binding) return;

  const tx = getDb().transaction(() => {
    forceDeleteTalkStateEntriesByPrefix(
      binding.talk_id,
      buildTalkChannelBindingStateNamespace(bindingId),
    );
    getDb()
      .prepare(`DELETE FROM talk_channel_bindings WHERE id = ?`)
      .run(bindingId);
  });

  tx();
}

export function enqueueChannelIngressEvent(input: {
  bindingId: string;
  talkId: string;
  connectionId: string;
  targetKind: string;
  targetId: string;
  platformEventId: string;
  externalMessageId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  payloadJson: string;
  dedupeKey: string;
  maxPendingEvents: number;
  overflowPolicy: ChannelOverflowPolicy;
  now?: string;
}):
  | { status: 'queued'; rowId: string; evictedRowId: string | null }
  | { status: 'duplicate'; rowId: string }
  | { status: 'dropped'; rowId: string; reasonCode: string } {
  const now = normalizeTimestamp(input.now);
  const rowId = `ingress_${randomUUID()}`;

  const tx = getDb().transaction(() => {
    const existing = getDb()
      .prepare(
        `SELECT id FROM channel_ingress_queue WHERE dedupe_key = ? LIMIT 1`,
      )
      .get(input.dedupeKey) as { id: string } | undefined;
    if (existing) {
      return { status: 'duplicate' as const, rowId: existing.id };
    }

    const backlog =
      (
        getDb()
          .prepare(
            `
            SELECT COUNT(*) AS count
            FROM channel_ingress_queue
            WHERE binding_id = ?
              AND status IN ('pending', 'deferred')
          `,
          )
          .get(input.bindingId) as { count: number } | undefined
      )?.count ?? 0;

    if (backlog >= input.maxPendingEvents) {
      if (input.overflowPolicy === 'drop_oldest') {
        const evictable = getDb()
          .prepare(
            `
            SELECT id
            FROM channel_ingress_queue
            WHERE binding_id = ?
              AND status IN ('pending', 'deferred')
            ORDER BY created_at ASC
            LIMIT 1
          `,
          )
          .get(input.bindingId) as { id: string } | undefined;
        if (evictable) {
          getDb()
            .prepare(
              `
              UPDATE channel_ingress_queue
              SET status = 'dropped',
                  reason_code = 'overflow_drop_oldest',
                  reason_detail = 'Dropped oldest queued ingress row to make room for a newer event',
                  updated_at = ?
              WHERE id = ?
            `,
            )
            .run(now, evictable.id);
          getDb()
            .prepare(
              `
              INSERT INTO channel_ingress_queue (
                id, binding_id, talk_id, connection_id, target_kind, target_id,
                platform_event_id, external_message_id, sender_id, sender_name,
                payload_json, status, reason_code, reason_detail, dedupe_key,
                available_at, created_at, updated_at, attempt_count
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?, ?, 0)
            `,
            )
            .run(
              rowId,
              input.bindingId,
              input.talkId,
              input.connectionId,
              input.targetKind,
              input.targetId,
              input.platformEventId,
              input.externalMessageId || null,
              input.senderId || null,
              input.senderName || null,
              input.payloadJson,
              input.dedupeKey,
              now,
              now,
              now,
            );
          return {
            status: 'queued' as const,
            rowId,
            evictedRowId: evictable.id,
          };
        }
        getDb()
          .prepare(
            `
            INSERT INTO channel_ingress_queue (
              id, binding_id, talk_id, connection_id, target_kind, target_id,
              platform_event_id, external_message_id, sender_id, sender_name,
              payload_json, status, reason_code, reason_detail, dedupe_key,
              available_at, created_at, updated_at, attempt_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dropped', 'overflow_no_evictable_row', 'Queue full and no pending/deferred row could be evicted', ?, ?, ?, ?, 0)
          `,
          )
          .run(
            rowId,
            input.bindingId,
            input.talkId,
            input.connectionId,
            input.targetKind,
            input.targetId,
            input.platformEventId,
            input.externalMessageId || null,
            input.senderId || null,
            input.senderName || null,
            input.payloadJson,
            input.dedupeKey,
            now,
            now,
            now,
          );
        return {
          status: 'dropped' as const,
          rowId,
          reasonCode: 'overflow_no_evictable_row',
        };
      }

      getDb()
        .prepare(
          `
          INSERT INTO channel_ingress_queue (
            id, binding_id, talk_id, connection_id, target_kind, target_id,
            platform_event_id, external_message_id, sender_id, sender_name,
            payload_json, status, reason_code, reason_detail, dedupe_key,
            available_at, created_at, updated_at, attempt_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dropped', 'overflow_drop_newest', 'Dropped newest ingress event because the binding backlog is full', ?, ?, ?, ?, 0)
        `,
        )
        .run(
          rowId,
          input.bindingId,
          input.talkId,
          input.connectionId,
          input.targetKind,
          input.targetId,
          input.platformEventId,
          input.externalMessageId || null,
          input.senderId || null,
          input.senderName || null,
          input.payloadJson,
          input.dedupeKey,
          now,
          now,
          now,
        );
      return {
        status: 'dropped' as const,
        rowId,
        reasonCode: 'overflow_drop_newest',
      };
    }

    getDb()
      .prepare(
        `
        INSERT INTO channel_ingress_queue (
          id, binding_id, talk_id, connection_id, target_kind, target_id,
          platform_event_id, external_message_id, sender_id, sender_name,
          payload_json, status, reason_code, reason_detail, dedupe_key,
          available_at, created_at, updated_at, attempt_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?, ?, 0)
      `,
      )
      .run(
        rowId,
        input.bindingId,
        input.talkId,
        input.connectionId,
        input.targetKind,
        input.targetId,
        input.platformEventId,
        input.externalMessageId || null,
        input.senderId || null,
        input.senderName || null,
        input.payloadJson,
        input.dedupeKey,
        now,
        now,
        now,
      );
    return { status: 'queued' as const, rowId, evictedRowId: null };
  });

  return tx();
}

export function resetChannelIngressProcessingOnStartup(now?: string): void {
  const currentNow = normalizeTimestamp(now);
  getDb()
    .prepare(
      `
      UPDATE channel_ingress_queue
      SET status = 'deferred',
          available_at = ?,
          updated_at = ?,
          reason_code = COALESCE(reason_code, 'expired_while_busy'),
          reason_detail = COALESCE(reason_detail, 'Recovered processing ingress row after restart')
      WHERE status = 'processing'
    `,
    )
    .run(currentNow, currentNow);
}

export function claimNextChannelIngressRow(
  now?: string,
): ChannelIngressQueueRecord | null {
  const currentNow = normalizeTimestamp(now);
  const tx = getDb().transaction(() => {
    const candidates = getDb()
      .prepare(
        `
        SELECT *
        FROM channel_ingress_queue
        WHERE status IN ('pending', 'deferred')
          AND available_at <= ?
        ORDER BY created_at ASC
        LIMIT 100
      `,
      )
      .all(currentNow) as ChannelIngressQueueRecord[];
    const seenTalkIds = new Set<string>();
    for (const candidate of candidates) {
      if (seenTalkIds.has(candidate.talk_id)) continue;
      seenTalkIds.add(candidate.talk_id);
      const updated = getDb()
        .prepare(
          `
          UPDATE channel_ingress_queue
          SET status = 'processing',
              updated_at = ?,
              attempt_count = attempt_count + 1
          WHERE id = ?
            AND status IN ('pending', 'deferred')
        `,
        )
        .run(currentNow, candidate.id);
      if (updated.changes !== 1) continue;
      return {
        ...candidate,
        status: 'processing' as const,
        updated_at: currentNow,
        attempt_count: candidate.attempt_count + 1,
      };
    }
    return null;
  });
  return tx();
}

export function markChannelIngressDeferred(input: {
  rowId: string;
  reasonDetail: string;
  availableAt: string;
  now?: string;
}): void {
  const now = normalizeTimestamp(input.now);
  getDb()
    .prepare(
      `
      UPDATE channel_ingress_queue
      SET status = 'deferred',
          reason_code = NULL,
          reason_detail = ?,
          available_at = ?,
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(input.reasonDetail, input.availableAt, now, input.rowId);
}

export function markChannelIngressCompleted(rowId: string, now?: string): void {
  const currentNow = normalizeTimestamp(now);
  getDb()
    .prepare(
      `
      UPDATE channel_ingress_queue
      SET status = 'completed',
          reason_code = NULL,
          reason_detail = NULL,
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(currentNow, rowId);
}

export function markChannelIngressTerminal(input: {
  rowId: string;
  status: 'dropped' | 'dead_letter';
  reasonCode: string;
  reasonDetail?: string | null;
  now?: string;
}): void {
  const now = normalizeTimestamp(input.now);
  getDb()
    .prepare(
      `
      UPDATE channel_ingress_queue
      SET status = ?,
          reason_code = ?,
          reason_detail = ?,
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(
      input.status,
      input.reasonCode,
      input.reasonDetail || null,
      now,
      input.rowId,
    );
}

export function listChannelIngressFailures(
  bindingId: string,
): ChannelIngressQueueRecord[] {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM channel_ingress_queue
      WHERE binding_id = ?
        AND status IN ('dropped', 'dead_letter')
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 100
    `,
    )
    .all(bindingId) as ChannelIngressQueueRecord[];
}

export function retryChannelIngressFailure(
  rowId: string,
  now?: string,
): ChannelIngressQueueRecord | null {
  const currentNow = normalizeTimestamp(now);
  const tx = getDb().transaction(() => {
    const row = getDb()
      .prepare(`SELECT * FROM channel_ingress_queue WHERE id = ? LIMIT 1`)
      .get(rowId) as ChannelIngressQueueRecord | undefined;
    if (!row) return null;
    getDb()
      .prepare(
        `
        UPDATE channel_ingress_queue
        SET status = 'pending',
            reason_code = NULL,
            reason_detail = NULL,
            available_at = ?,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(currentNow, currentNow, rowId);
    return {
      ...row,
      status: 'pending' as const,
      reason_code: null,
      reason_detail: null,
      available_at: currentNow,
      updated_at: currentNow,
    };
  });
  return tx();
}

export function deleteChannelIngressQueueRow(rowId: string): boolean {
  return (
    getDb().prepare(`DELETE FROM channel_ingress_queue WHERE id = ?`).run(rowId)
      .changes === 1
  );
}

export function enqueueChannelTurnAtomic(input: {
  talkId: string;
  messageId: string;
  runId: string;
  targetAgentId: string;
  content: string;
  metadataJson: string;
  externalCreatedAt: string;
  sourceBindingId: string;
  sourceExternalMessageId?: string | null;
  sourceThreadKey?: string | null;
  now?: string;
}):
  | { status: 'enqueued'; messageId: string; runId: string }
  | { status: 'thread_busy' }
  | { status: 'invalid_state'; code: string; message: string } {
  const now = normalizeTimestamp(input.now);
  const tx = getDb().transaction(() => {
    const binding = getDb()
      .prepare(
        `
        SELECT b.id, b.active, b.talk_id, p.responder_agent_id
        FROM talk_channel_bindings b
        JOIN talk_channel_policies p ON p.binding_id = b.id
        WHERE b.id = ?
        LIMIT 1
      `,
      )
      .get(input.sourceBindingId) as
      | {
          id: string;
          active: number;
          talk_id: string;
          responder_agent_id: string | null;
        }
      | undefined;
    if (!binding || binding.talk_id !== input.talkId) {
      return {
        status: 'invalid_state' as const,
        code: 'binding_not_found',
        message: 'Talk channel binding not found',
      };
    }
    if (binding.active !== 1) {
      return {
        status: 'invalid_state' as const,
        code: 'binding_inactive',
        message: 'Talk channel binding is inactive',
      };
    }

    const threadId = resolveOrCreateChannelConversationThread({
      talkId: input.talkId,
      bindingId: binding.id,
      sourceThreadKey: input.sourceThreadKey || null,
      metadataJson: input.metadataJson,
      now,
    });
    const active = hasActiveTalkRuns(input.talkId, threadId);
    if (active) {
      return { status: 'thread_busy' as const };
    }

    const agent = getDb()
      .prepare(
        `
        SELECT ra.id
        FROM talk_agents ta
        JOIN registered_agents ra ON ra.id = ta.registered_agent_id
        WHERE ta.talk_id = ? AND ra.id = ?
        LIMIT 1
      `,
      )
      .get(input.talkId, input.targetAgentId) as { id: string } | undefined;
    if (!agent) {
      return {
        status: 'invalid_state' as const,
        code: 'target_agent_not_found',
        message: 'Configured responder agent is not available on the talk',
      };
    }

    createTalkMessage({
      id: input.messageId,
      talkId: input.talkId,
      threadId,
      role: 'user',
      content: input.content,
      createdBy: null,
      createdAt: input.externalCreatedAt,
      metadataJson: input.metadataJson,
    });
    createTalkRun({
      id: input.runId,
      talk_id: input.talkId,
      thread_id: threadId,
      requested_by: 'system:channel-ingress',
      status: 'queued',
      run_kind: 'conversation',
      trigger_message_id: input.messageId,
      target_agent_id: input.targetAgentId,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      source_binding_id: input.sourceBindingId,
      source_external_message_id: input.sourceExternalMessageId || null,
      source_thread_key: input.sourceThreadKey || null,
      created_at: now,
      started_at: null,
      ended_at: null,
      cancel_reason: null,
    });
    touchTalkUpdatedAt(input.talkId, now);
    getDb()
      .prepare(
        `
        INSERT INTO event_outbox (topic, event_type, payload, created_at)
        VALUES (?, 'message_appended', ?, ?)
      `,
      )
      .run(
        `talk:${input.talkId}`,
        JSON.stringify({
          talkId: input.talkId,
          threadId,
          messageId: input.messageId,
          runId: null,
          role: 'user',
          createdBy: null,
          content: input.content,
          createdAt: input.externalCreatedAt,
          metadataJson: input.metadataJson,
        }),
        now,
      );
    getDb()
      .prepare(
        `
        INSERT INTO event_outbox (topic, event_type, payload, created_at)
        VALUES (?, 'talk_run_queued', ?, ?)
      `,
      )
      .run(
        `talk:${input.talkId}`,
        JSON.stringify({
          talkId: input.talkId,
          threadId,
          runId: input.runId,
          runKind: 'conversation',
          triggerMessageId: input.messageId,
          targetAgentId: input.targetAgentId,
          status: 'queued',
          executorAlias: null,
          executorModel: null,
        }),
        now,
      );

    return {
      status: 'enqueued' as const,
      messageId: input.messageId,
      runId: input.runId,
    };
  });
  return tx();
}

export function rollbackDeliveryAttemptCount(
  rowId: string,
  now?: string,
): void {
  const timestamp = normalizeTimestamp(now);
  getDb()
    .prepare(
      `
      UPDATE channel_delivery_outbox
      SET attempt_count = MAX(0, attempt_count - 1),
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(timestamp, rowId);
}

export function resetChannelDeliverySendingOnStartup(now?: string): void {
  const currentNow = normalizeTimestamp(now);
  getDb()
    .prepare(
      `
      UPDATE channel_delivery_outbox
      SET status = 'pending',
          updated_at = ?
      WHERE status = 'sending'
    `,
    )
    .run(currentNow);
}

export function claimNextChannelDeliveryRow(
  now?: string,
): ChannelDeliveryOutboxRecord | null {
  const currentNow = normalizeTimestamp(now);
  const tx = getDb().transaction(() => {
    const row = getDb()
      .prepare(
        `
        SELECT *
        FROM channel_delivery_outbox
        WHERE status = 'pending'
          AND available_at <= ?
        ORDER BY created_at ASC
        LIMIT 1
      `,
      )
      .get(currentNow) as ChannelDeliveryOutboxRecord | undefined;
    if (!row) return null;
    const updated = getDb()
      .prepare(
        `
        UPDATE channel_delivery_outbox
        SET status = 'sending',
            updated_at = ?,
            attempt_count = attempt_count + 1
        WHERE id = ? AND status = 'pending'
      `,
      )
      .run(currentNow, row.id);
    if (updated.changes !== 1) return null;
    return {
      ...row,
      status: 'sending' as const,
      updated_at: currentNow,
      attempt_count: row.attempt_count + 1,
    };
  });
  return tx();
}

export function markChannelDeliverySent(rowId: string, now?: string): void {
  const currentNow = normalizeTimestamp(now);
  getDb()
    .prepare(
      `
      UPDATE channel_delivery_outbox
      SET status = 'sent',
          reason_code = NULL,
          reason_detail = NULL,
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(currentNow, rowId);
}

export function markChannelDeliveryRetryOrDeadLetter(input: {
  rowId: string;
  availableAt?: string;
  reasonCode: string;
  reasonDetail?: string | null;
  deadLetter: boolean;
  now?: string;
}): void {
  const now = normalizeTimestamp(input.now);
  if (input.deadLetter) {
    getDb()
      .prepare(
        `
        UPDATE channel_delivery_outbox
        SET status = 'dead_letter',
            reason_code = ?,
            reason_detail = ?,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(input.reasonCode, input.reasonDetail || null, now, input.rowId);
    return;
  }
  getDb()
    .prepare(
      `
      UPDATE channel_delivery_outbox
      SET status = 'pending',
          reason_code = ?,
          reason_detail = ?,
          available_at = ?,
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(
      input.reasonCode,
      input.reasonDetail || null,
      input.availableAt || now,
      now,
      input.rowId,
    );
}

export function listChannelDeliveryFailures(
  bindingId: string,
): ChannelDeliveryOutboxRecord[] {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM channel_delivery_outbox
      WHERE binding_id = ?
        AND status = 'dead_letter'
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 100
    `,
    )
    .all(bindingId) as ChannelDeliveryOutboxRecord[];
}

export function retryChannelDeliveryFailure(
  rowId: string,
  now?: string,
): ChannelDeliveryOutboxRecord | null {
  const currentNow = normalizeTimestamp(now);
  const tx = getDb().transaction(() => {
    const row = getDb()
      .prepare(`SELECT * FROM channel_delivery_outbox WHERE id = ? LIMIT 1`)
      .get(rowId) as ChannelDeliveryOutboxRecord | undefined;
    if (!row) return null;
    getDb()
      .prepare(
        `
        UPDATE channel_delivery_outbox
        SET status = 'pending',
            reason_code = NULL,
            reason_detail = NULL,
            available_at = ?,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(currentNow, currentNow, rowId);
    return {
      ...row,
      status: 'pending' as const,
      reason_code: null,
      reason_detail: null,
      available_at: currentNow,
      updated_at: currentNow,
    };
  });
  return tx();
}

export function deleteChannelDeliveryOutboxRow(rowId: string): boolean {
  return (
    getDb()
      .prepare(`DELETE FROM channel_delivery_outbox WHERE id = ?`)
      .run(rowId).changes === 1
  );
}

// ---------------------------------------------------------------------------
// Quarantine helpers
// ---------------------------------------------------------------------------

export function quarantineBinding(
  bindingId: string,
  code: string,
  now?: string,
): void {
  const timestamp = normalizeTimestamp(now);
  getDb()
    .prepare(
      `
      UPDATE talk_channel_bindings
      SET health_quarantined = 1,
          health_quarantine_code = ?,
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(code, timestamp, bindingId);
}

export function clearBindingQuarantine(bindingId: string, now?: string): void {
  const timestamp = normalizeTimestamp(now);
  getDb()
    .prepare(
      `
      UPDATE talk_channel_bindings
      SET health_quarantined = 0,
          health_quarantine_code = NULL,
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(timestamp, bindingId);
}

// ---------------------------------------------------------------------------
// Binding delivery/ingress result helpers
// ---------------------------------------------------------------------------

export function updateBindingDeliveryResult(
  bindingId: string,
  result: {
    lastDeliveryAt?: string;
    errorCode?: string | null;
    errorDetail?: string | null;
    errorAt?: string | null;
  },
  now?: string,
): void {
  const timestamp = normalizeTimestamp(now);
  if (result.lastDeliveryAt) {
    // Successful delivery — clear error fields
    getDb()
      .prepare(
        `
        UPDATE talk_channel_bindings
        SET last_delivery_at = ?,
            last_delivery_error_code = NULL,
            last_delivery_error_detail = NULL,
            last_delivery_error_at = NULL,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(result.lastDeliveryAt, timestamp, bindingId);
  } else {
    // Failed delivery — record error
    getDb()
      .prepare(
        `
        UPDATE talk_channel_bindings
        SET last_delivery_error_code = ?,
            last_delivery_error_detail = ?,
            last_delivery_error_at = ?,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        result.errorCode || null,
        result.errorDetail || null,
        result.errorAt || timestamp,
        timestamp,
        bindingId,
      );
  }
}

export function updateBindingLastIngressAt(
  bindingId: string,
  ingressAt: string,
  now?: string,
): void {
  const timestamp = normalizeTimestamp(now);
  getDb()
    .prepare(
      `
      UPDATE talk_channel_bindings
      SET last_ingress_at = ?,
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(ingressAt, timestamp, bindingId);
}

// ---------------------------------------------------------------------------
// Connection probe result helper
// ---------------------------------------------------------------------------

export function updateConnectionProbeResult(
  connectionId: string,
  success: boolean,
  errorDetail?: string,
  now?: string,
): void {
  const timestamp = normalizeTimestamp(now);
  if (success) {
    getDb()
      .prepare(
        `
        UPDATE channel_connections
        SET health_status = 'healthy',
            consecutive_probe_failures = 0,
            last_health_check_at = ?,
            last_health_error = NULL,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(timestamp, timestamp, connectionId);
  } else {
    // Increment failures and derive status
    const current = getDb()
      .prepare(
        `SELECT consecutive_probe_failures FROM channel_connections WHERE id = ?`,
      )
      .get(connectionId) as { consecutive_probe_failures: number } | undefined;
    const failures = (current?.consecutive_probe_failures ?? 0) + 1;
    let healthStatus: ChannelHealthStatus;
    if (failures >= 3) {
      healthStatus = 'disconnected';
    } else {
      healthStatus = 'degraded';
    }
    getDb()
      .prepare(
        `
        UPDATE channel_connections
        SET health_status = ?,
            consecutive_probe_failures = ?,
            last_health_check_at = ?,
            last_health_error = ?,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        healthStatus,
        failures,
        timestamp,
        errorDetail || null,
        timestamp,
        connectionId,
      );
  }
}

// ---------------------------------------------------------------------------
// Age-capped retry helper for dead-lettered delivery rows
// ---------------------------------------------------------------------------

export function retryChannelDeliveryFailuresCapped(input: {
  bindingId: string;
  maxAgeMins?: number;
  maxCount?: number;
  now?: string;
}): { retried: number; tooOld: number; totalRemaining: number } {
  const currentNow = normalizeTimestamp(input.now);
  const maxAge = Math.max(1, Math.floor(input.maxAgeMins ?? 60));
  const maxCount = Math.max(1, Math.floor(input.maxCount ?? 10));
  const cutoff = new Date(
    new Date(currentNow).getTime() - maxAge * 60_000,
  ).toISOString();

  const tx = getDb().transaction(() => {
    const rows = getDb()
      .prepare(
        `
        SELECT id, created_at
        FROM channel_delivery_outbox
        WHERE binding_id = ?
          AND status = 'dead_letter'
        ORDER BY created_at DESC
      `,
      )
      .all(input.bindingId) as Array<{ id: string; created_at: string }>;

    let retried = 0;
    let tooOld = 0;
    for (const row of rows) {
      if (row.created_at < cutoff) {
        tooOld++;
        continue;
      }
      if (retried >= maxCount) break;
      getDb()
        .prepare(
          `
          UPDATE channel_delivery_outbox
          SET status = 'pending',
              reason_code = NULL,
              reason_detail = NULL,
              available_at = ?,
              updated_at = ?
          WHERE id = ?
        `,
        )
        .run(currentNow, currentNow, row.id);
      retried++;
    }
    const remaining =
      (
        getDb()
          .prepare(
            `
          SELECT COUNT(*) AS count
          FROM channel_delivery_outbox
          WHERE binding_id = ? AND status = 'dead_letter'
        `,
          )
          .get(input.bindingId) as { count: number }
      )?.count ?? 0;

    return { retried, tooOld, totalRemaining: remaining };
  });

  return tx();
}
