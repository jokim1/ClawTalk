import { randomUUID } from 'crypto';

import { getDb } from '../../db.js';
import type {
  ConnectorKind,
  DataConnectorRecord,
  DataConnectorSecretRecord,
  DataConnectorVerificationStatus,
  PersistedDataConnectorVerificationStatus,
} from '../connectors/types.js';

type JsonMap = Record<string, unknown>;

type RawConnectorRow = {
  id: string;
  name: string;
  connector_kind: ConnectorKind;
  config_json: string | null;
  discovered_json: string | null;
  enabled: number;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
  ciphertext: string | null;
  verification_status: PersistedDataConnectorVerificationStatus | null;
  last_verified_at: string | null;
  last_error: string | null;
  attached_talk_count: number;
};

type RawTalkConnectorRow = RawConnectorRow & {
  attached_at: string;
  attached_by: string | null;
};

export interface DataConnectorSnapshot {
  id: string;
  name: string;
  connectorKind: ConnectorKind;
  config: JsonMap | null;
  discovered: JsonMap | null;
  enabled: boolean;
  hasCredential: boolean;
  verificationStatus: DataConnectorVerificationStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  attachedTalkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TalkDataConnectorSnapshot extends DataConnectorSnapshot {
  attachedAt: string;
  attachedBy: string | null;
}

// Sensitive: ciphertext is returned here so the runtime layer can decrypt it
// just-in-time. Do not serialize these records to API responses or logs.
export interface TalkRunConnectorRecord extends DataConnectorSnapshot {
  ciphertext: string;
}

function parseJsonMap(value: string | null): JsonMap | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as JsonMap;
  } catch {
    return null;
  }
}

function serializeJsonMap(value: JsonMap | null | undefined): string | null {
  if (!value) return null;
  return JSON.stringify(value);
}

function deriveVerificationStatus(input: {
  ciphertext: string | null;
  verificationStatus: PersistedDataConnectorVerificationStatus | null;
}): DataConnectorVerificationStatus {
  if (!input.ciphertext) return 'missing';
  return input.verificationStatus || 'not_verified';
}

function toDataConnectorSnapshot(row: RawConnectorRow): DataConnectorSnapshot {
  return {
    id: row.id,
    name: row.name,
    connectorKind: row.connector_kind,
    config: parseJsonMap(row.config_json),
    discovered: parseJsonMap(row.discovered_json),
    enabled: row.enabled === 1,
    hasCredential: Boolean(row.ciphertext),
    verificationStatus: deriveVerificationStatus({
      ciphertext: row.ciphertext,
      verificationStatus: row.verification_status,
    }),
    lastVerifiedAt: row.last_verified_at,
    lastVerificationError: row.last_error,
    attachedTalkCount: Number(row.attached_talk_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTalkDataConnectorSnapshot(
  row: RawTalkConnectorRow,
): TalkDataConnectorSnapshot {
  return {
    ...toDataConnectorSnapshot(row),
    attachedAt: row.attached_at,
    attachedBy: row.attached_by,
  };
}

function listConnectorRows(): RawConnectorRow[] {
  return getDb()
    .prepare(
      `
      SELECT
        dc.id,
        dc.name,
        dc.connector_kind,
        dc.config_json,
        dc.discovered_json,
        dc.enabled,
        dc.created_at,
        dc.created_by,
        dc.updated_at,
        dc.updated_by,
        dcs.ciphertext,
        dcv.status AS verification_status,
        dcv.last_verified_at,
        dcv.last_error,
        COUNT(tdc.talk_id) AS attached_talk_count
      FROM data_connectors dc
      LEFT JOIN data_connector_secrets dcs
        ON dcs.connector_id = dc.id
      LEFT JOIN data_connector_verifications dcv
        ON dcv.connector_id = dc.id
      LEFT JOIN talk_data_connectors tdc
        ON tdc.connector_id = dc.id
      GROUP BY dc.id
      ORDER BY dc.updated_at DESC, dc.created_at DESC, dc.id DESC
    `,
    )
    .all() as RawConnectorRow[];
}

function getConnectorRowById(connectorId: string): RawConnectorRow | undefined {
  return getDb()
    .prepare(
      `
      SELECT
        dc.id,
        dc.name,
        dc.connector_kind,
        dc.config_json,
        dc.discovered_json,
        dc.enabled,
        dc.created_at,
        dc.created_by,
        dc.updated_at,
        dc.updated_by,
        dcs.ciphertext,
        dcv.status AS verification_status,
        dcv.last_verified_at,
        dcv.last_error,
        COUNT(tdc.talk_id) AS attached_talk_count
      FROM data_connectors dc
      LEFT JOIN data_connector_secrets dcs
        ON dcs.connector_id = dc.id
      LEFT JOIN data_connector_verifications dcv
        ON dcv.connector_id = dc.id
      LEFT JOIN talk_data_connectors tdc
        ON tdc.connector_id = dc.id
      WHERE dc.id = ?
      GROUP BY dc.id
      LIMIT 1
    `,
    )
    .get(connectorId) as RawConnectorRow | undefined;
}

function connectorHasCredential(connectorId: string): boolean {
  const row = getDb()
    .prepare(
      `
      SELECT 1
      FROM data_connector_secrets
      WHERE connector_id = ?
      LIMIT 1
    `,
    )
    .get(connectorId) as { 1: number } | undefined;
  return Boolean(row);
}

function markConnectorNeedsVerification(
  connectorId: string,
  now: string,
): void {
  getDb()
    .prepare(
      `
      INSERT INTO data_connector_verifications (
        connector_id,
        status,
        last_verified_at,
        last_error,
        updated_at
      )
      VALUES (?, 'not_verified', NULL, NULL, ?)
      ON CONFLICT(connector_id) DO UPDATE SET
        status = 'not_verified',
        last_verified_at = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at
    `,
    )
    .run(connectorId, now);
}

function clearConnectorVerification(connectorId: string): void {
  getDb()
    .prepare(
      `
      DELETE FROM data_connector_verifications
      WHERE connector_id = ?
    `,
    )
    .run(connectorId);
}

export function listDataConnectors(): DataConnectorSnapshot[] {
  return listConnectorRows().map(toDataConnectorSnapshot);
}

export function getDataConnectorById(
  connectorId: string,
): DataConnectorSnapshot | undefined {
  const row = getConnectorRowById(connectorId);
  return row ? toDataConnectorSnapshot(row) : undefined;
}

export function getDataConnectorRecordById(
  connectorId: string,
): DataConnectorRecord | undefined {
  return getDb()
    .prepare(`SELECT * FROM data_connectors WHERE id = ? LIMIT 1`)
    .get(connectorId) as DataConnectorRecord | undefined;
}

export function createDataConnector(input: {
  name: string;
  connectorKind: ConnectorKind;
  config?: JsonMap | null;
  enabled?: boolean;
  createdBy: string;
}): DataConnectorSnapshot {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO data_connectors (
        id,
        name,
        connector_kind,
        config_json,
        discovered_json,
        enabled,
        created_at,
        created_by,
        updated_at,
        updated_by
      )
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      id,
      input.name.trim(),
      input.connectorKind,
      serializeJsonMap(input.config ?? {}),
      input.enabled === false ? 0 : 1,
      now,
      input.createdBy,
      now,
      input.createdBy,
    );

  const created = getDataConnectorById(id);
  if (!created) {
    throw new Error(`Failed to create connector ${id}`);
  }
  return created;
}

export function patchDataConnector(input: {
  connectorId: string;
  name?: string;
  config?: JsonMap | null;
  enabled?: boolean;
  updatedBy: string;
}): DataConnectorSnapshot | undefined {
  const current = getDataConnectorRecordById(input.connectorId);
  if (!current) return undefined;

  const now = new Date().toISOString();
  const nextName = input.name !== undefined ? input.name.trim() : current.name;
  const nextConfigJson =
    input.config !== undefined
      ? serializeJsonMap(input.config)
      : current.config_json;
  const configChanged =
    input.config !== undefined && nextConfigJson !== current.config_json;
  const nextEnabled =
    input.enabled !== undefined ? (input.enabled ? 1 : 0) : current.enabled;

  getDb()
    .prepare(
      `
      UPDATE data_connectors
      SET name = ?,
          config_json = ?,
          discovered_json = ?,
          enabled = ?,
          updated_at = ?,
          updated_by = ?
      WHERE id = ?
    `,
    )
    .run(
      nextName,
      nextConfigJson,
      configChanged ? null : current.discovered_json,
      nextEnabled,
      now,
      input.updatedBy,
      input.connectorId,
    );

  if (configChanged) {
    if (connectorHasCredential(input.connectorId)) {
      markConnectorNeedsVerification(input.connectorId, now);
    } else {
      clearConnectorVerification(input.connectorId);
    }
  }

  return getDataConnectorById(input.connectorId);
}

export function patchDataConnectorDiscovery(
  connectorId: string,
  discovered: JsonMap | null,
): void {
  getDb()
    .prepare(
      `
      UPDATE data_connectors
      SET discovered_json = ?
      WHERE id = ?
    `,
    )
    .run(serializeJsonMap(discovered), connectorId);
}

export function deleteDataConnector(connectorId: string): boolean {
  const result = getDb()
    .prepare(
      `
      DELETE FROM data_connectors
      WHERE id = ?
    `,
    )
    .run(connectorId);
  return result.changes > 0;
}

export function getDataConnectorCredential(
  connectorId: string,
): DataConnectorSecretRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM data_connector_secrets
      WHERE connector_id = ?
      LIMIT 1
    `,
    )
    .get(connectorId) as DataConnectorSecretRecord | undefined;
}

export function setDataConnectorCredential(input: {
  connectorId: string;
  ciphertext: string;
  updatedBy: string;
}): DataConnectorSnapshot | undefined {
  const connector = getDataConnectorRecordById(input.connectorId);
  if (!connector) return undefined;

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO data_connector_secrets (
        connector_id,
        ciphertext,
        updated_at,
        updated_by
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT(connector_id) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `,
    )
    .run(input.connectorId, input.ciphertext, now, input.updatedBy);

  getDb()
    .prepare(
      `
      UPDATE data_connectors
      SET discovered_json = NULL,
          updated_at = ?,
          updated_by = ?
      WHERE id = ?
    `,
    )
    .run(now, input.updatedBy, input.connectorId);
  markConnectorNeedsVerification(input.connectorId, now);
  return getDataConnectorById(input.connectorId);
}

export function replaceDataConnectorCredentialCiphertext(input: {
  connectorId: string;
  ciphertext: string;
  updatedBy?: string | null;
}): void {
  const existing = getDataConnectorCredential(input.connectorId);
  if (!existing) {
    throw new Error(`connector credential not found: ${input.connectorId}`);
  }

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE data_connector_secrets
      SET ciphertext = ?,
          updated_at = ?,
          updated_by = ?
      WHERE connector_id = ?
    `,
    )
    .run(
      input.ciphertext,
      now,
      input.updatedBy ?? existing.updated_by,
      input.connectorId,
    );
}

export function deleteDataConnectorCredential(
  connectorId: string,
  updatedBy?: string | null,
): DataConnectorSnapshot | undefined {
  const connector = getDataConnectorRecordById(connectorId);
  if (!connector) return undefined;

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      DELETE FROM data_connector_secrets
      WHERE connector_id = ?
    `,
    )
    .run(connectorId);
  clearConnectorVerification(connectorId);
  getDb()
    .prepare(
      `
      UPDATE data_connectors
      SET discovered_json = NULL,
          updated_at = ?,
          updated_by = ?
      WHERE id = ?
    `,
    )
    .run(now, updatedBy ?? connector.updated_by, connectorId);
  return getDataConnectorById(connectorId);
}

export function upsertDataConnectorVerification(input: {
  connectorId: string;
  status: PersistedDataConnectorVerificationStatus;
  lastError?: string | null;
  lastVerifiedAt?: string | null;
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO data_connector_verifications (
        connector_id,
        status,
        last_verified_at,
        last_error,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(connector_id) DO UPDATE SET
        status = excluded.status,
        last_verified_at = excluded.last_verified_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      input.connectorId,
      input.status,
      input.lastVerifiedAt ?? null,
      input.lastError ?? null,
      now,
    );
}

export function attachDataConnectorToTalk(input: {
  talkId: string;
  connectorId: string;
  userId: string;
}): TalkDataConnectorSnapshot | undefined {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT OR IGNORE INTO talk_data_connectors (
        talk_id,
        connector_id,
        attached_at,
        attached_by
      )
      VALUES (?, ?, ?, ?)
    `,
    )
    .run(input.talkId, input.connectorId, now, input.userId);

  return listTalkDataConnectors(input.talkId).find(
    (connector) => connector.id === input.connectorId,
  );
}

export function detachDataConnectorFromTalk(
  talkId: string,
  connectorId: string,
): boolean {
  const result = getDb()
    .prepare(
      `
      DELETE FROM talk_data_connectors
      WHERE talk_id = ? AND connector_id = ?
    `,
    )
    .run(talkId, connectorId);
  return result.changes > 0;
}

export function listTalkDataConnectors(
  talkId: string,
): TalkDataConnectorSnapshot[] {
  const rows = getDb()
    .prepare(
      `
      SELECT
        dc.id,
        dc.name,
        dc.connector_kind,
        dc.config_json,
        dc.discovered_json,
        dc.enabled,
        dc.created_at,
        dc.created_by,
        dc.updated_at,
        dc.updated_by,
        dcs.ciphertext,
        dcv.status AS verification_status,
        dcv.last_verified_at,
        dcv.last_error,
        (
          SELECT COUNT(*)
          FROM talk_data_connectors AS all_tdc
          WHERE all_tdc.connector_id = dc.id
        ) AS attached_talk_count,
        tdc.attached_at,
        tdc.attached_by
      FROM talk_data_connectors tdc
      INNER JOIN data_connectors dc
        ON dc.id = tdc.connector_id
      LEFT JOIN data_connector_secrets dcs
        ON dcs.connector_id = dc.id
      LEFT JOIN data_connector_verifications dcv
        ON dcv.connector_id = dc.id
      WHERE tdc.talk_id = ?
      ORDER BY dc.name COLLATE NOCASE ASC, dc.id ASC
    `,
    )
    .all(talkId) as RawTalkConnectorRow[];
  return rows.map(toTalkDataConnectorSnapshot);
}

export function listConnectorsForTalkRun(
  talkId: string,
): TalkRunConnectorRecord[] {
  const rows = getDb()
    .prepare(
      `
      SELECT
        dc.id,
        dc.name,
        dc.connector_kind,
        dc.config_json,
        dc.discovered_json,
        dc.enabled,
        dc.created_at,
        dc.created_by,
        dc.updated_at,
        dc.updated_by,
        dcs.ciphertext,
        dcv.status AS verification_status,
        dcv.last_verified_at,
        dcv.last_error,
        (
          SELECT COUNT(*)
          FROM talk_data_connectors AS all_tdc
          WHERE all_tdc.connector_id = dc.id
        ) AS attached_talk_count
      FROM talk_data_connectors tdc
      INNER JOIN data_connectors dc
        ON dc.id = tdc.connector_id
      INNER JOIN data_connector_secrets dcs
        ON dcs.connector_id = dc.id
      LEFT JOIN data_connector_verifications dcv
        ON dcv.connector_id = dc.id
      WHERE tdc.talk_id = ?
        AND dc.enabled = 1
      ORDER BY dc.name COLLATE NOCASE ASC, dc.id ASC
    `,
    )
    .all(talkId) as RawConnectorRow[];

  return rows
    .filter((row) => Boolean(row.ciphertext))
    .map((row) => ({
      ...toDataConnectorSnapshot(row),
      ciphertext: row.ciphertext!,
    }));
}
