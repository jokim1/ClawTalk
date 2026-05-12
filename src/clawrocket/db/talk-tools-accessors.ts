import { randomUUID } from 'crypto';

import { getDb } from '../../db.js';

type JsonMap = Record<string, unknown>;

export type TalkToolFamily =
  | 'saved_sources'
  | 'attachments'
  | 'web'
  | 'gmail'
  | 'google_drive'
  | 'google_docs'
  | 'google_sheets'
  | 'data_connectors';

export type TalkResourceBindingKind =
  | 'google_drive_folder'
  | 'google_drive_file'
  | 'data_connector'
  | 'saved_source'
  | 'message_attachment';

export interface BuiltinTalkToolDefinition {
  id: string;
  family: TalkToolFamily;
  displayName: string;
  description: string | null;
  requiresBinding: boolean;
  defaultGrant: boolean;
  mutatesExternalState: boolean;
  sortOrder: number;
}

export const BUILTIN_TALK_TOOLS: ReadonlyArray<BuiltinTalkToolDefinition> = [
  {
    id: 'saved_sources',
    family: 'saved_sources',
    displayName: 'Saved Sources',
    description: 'Read saved Talk sources.',
    requiresBinding: false,
    defaultGrant: true,
    mutatesExternalState: false,
    sortOrder: 10,
  },
  {
    id: 'attachments',
    family: 'attachments',
    displayName: 'Message Attachments',
    description: 'Read attached Talk files.',
    requiresBinding: false,
    defaultGrant: true,
    mutatesExternalState: false,
    sortOrder: 20,
  },
  {
    id: 'web_search',
    family: 'web',
    displayName: 'Web Search',
    description: 'Search the public web.',
    requiresBinding: false,
    defaultGrant: true,
    mutatesExternalState: false,
    sortOrder: 30,
  },
  {
    id: 'web_fetch',
    family: 'web',
    displayName: 'Web Fetch',
    description: 'Fetch public web pages.',
    requiresBinding: false,
    defaultGrant: true,
    mutatesExternalState: false,
    sortOrder: 40,
  },
  {
    id: 'gmail_read',
    family: 'gmail',
    displayName: 'Gmail Read',
    description: 'Search and read mailbox content.',
    requiresBinding: false,
    defaultGrant: false,
    mutatesExternalState: false,
    sortOrder: 50,
  },
  {
    id: 'gmail_send',
    family: 'gmail',
    displayName: 'Gmail Send',
    description: 'Draft and send email.',
    requiresBinding: false,
    defaultGrant: false,
    mutatesExternalState: true,
    sortOrder: 60,
  },
  {
    id: 'google_drive_search',
    family: 'google_drive',
    displayName: 'Google Drive Search',
    description: 'Search within bound Google Drive resources.',
    requiresBinding: true,
    defaultGrant: true,
    mutatesExternalState: false,
    sortOrder: 70,
  },
  {
    id: 'google_drive_read',
    family: 'google_drive',
    displayName: 'Google Drive Read',
    description: 'Read bound Google Drive files.',
    requiresBinding: true,
    defaultGrant: true,
    mutatesExternalState: false,
    sortOrder: 80,
  },
  {
    id: 'google_drive_list_folder',
    family: 'google_drive',
    displayName: 'Google Drive List Folder',
    description: 'List bound Google Drive folders.',
    requiresBinding: true,
    defaultGrant: true,
    mutatesExternalState: false,
    sortOrder: 90,
  },
  {
    id: 'google_docs_read',
    family: 'google_docs',
    displayName: 'Google Docs Read',
    description: 'Read bound Google Docs.',
    requiresBinding: true,
    defaultGrant: false,
    mutatesExternalState: false,
    sortOrder: 100,
  },
  {
    id: 'google_docs_batch_update',
    family: 'google_docs',
    displayName: 'Google Docs Update',
    description: 'Update bound Google Docs.',
    requiresBinding: true,
    defaultGrant: false,
    mutatesExternalState: true,
    sortOrder: 110,
  },
  {
    id: 'google_sheets_read_range',
    family: 'google_sheets',
    displayName: 'Google Sheets Read',
    description: 'Read bound Google Sheets.',
    requiresBinding: true,
    defaultGrant: false,
    mutatesExternalState: false,
    sortOrder: 120,
  },
  {
    id: 'google_sheets_batch_update',
    family: 'google_sheets',
    displayName: 'Google Sheets Update',
    description: 'Update bound Google Sheets.',
    requiresBinding: true,
    defaultGrant: false,
    mutatesExternalState: true,
    sortOrder: 130,
  },
  {
    id: 'data_connectors',
    family: 'data_connectors',
    displayName: 'Data Connectors',
    description: 'Use attached Talk data connectors.',
    requiresBinding: false,
    defaultGrant: true,
    mutatesExternalState: false,
    sortOrder: 140,
  },
];

export interface TalkToolGrantRecord {
  talkId: string;
  toolId: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export interface TalkResourceBindingRecord {
  id: string;
  talkId: string;
  bindingKind: TalkResourceBindingKind;
  externalId: string;
  displayName: string;
  metadata: JsonMap | null;
  createdAt: string;
  createdBy: string | null;
}

export interface UserGoogleCredentialRecord {
  id: string;
  userId: string;
  googleSubject: string;
  email: string;
  displayName: string | null;
  scopes: string[];
  ciphertext: string;
  accessExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoogleOAuthLinkRequestRecord {
  stateHash: string;
  userId: string;
  scopes: string[];
  createdAt: string;
}

type RawTalkToolGrantRow = {
  talk_id: string;
  tool_id: string;
  enabled: number;
  updated_at: string;
  updated_by: string | null;
};

type RawTalkResourceBindingRow = {
  id: string;
  talk_id: string;
  binding_kind: TalkResourceBindingKind;
  external_id: string;
  display_name: string;
  metadata_json: string | null;
  created_at: string;
  created_by: string | null;
};

type RawUserGoogleCredentialRow = {
  id: string;
  user_id: string;
  google_subject: string;
  email: string;
  display_name: string | null;
  scopes_json: string;
  ciphertext: string;
  access_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

type RawGoogleOAuthLinkRequestRow = {
  state_hash: string;
  user_id: string;
  scopes_json: string;
  created_at: string;
};

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
  return value ? JSON.stringify(value) : null;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function serializeStringArray(value: string[]): string {
  return JSON.stringify(value);
}

function toTalkToolGrantRecord(row: RawTalkToolGrantRow): TalkToolGrantRecord {
  return {
    talkId: row.talk_id,
    toolId: row.tool_id,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function toTalkResourceBindingRecord(
  row: RawTalkResourceBindingRow,
): TalkResourceBindingRecord {
  return {
    id: row.id,
    talkId: row.talk_id,
    bindingKind: row.binding_kind,
    externalId: row.external_id,
    displayName: row.display_name,
    metadata: parseJsonMap(row.metadata_json),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function toUserGoogleCredentialRecord(
  row: RawUserGoogleCredentialRow,
): UserGoogleCredentialRecord {
  return {
    id: row.id,
    userId: row.user_id,
    googleSubject: row.google_subject,
    email: row.email,
    displayName: row.display_name,
    scopes: parseStringArray(row.scopes_json),
    ciphertext: row.ciphertext,
    accessExpiresAt: row.access_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toGoogleOAuthLinkRequestRecord(
  row: RawGoogleOAuthLinkRequestRow,
): GoogleOAuthLinkRequestRecord {
  return {
    stateHash: row.state_hash,
    userId: row.user_id,
    scopes: parseStringArray(row.scopes_json),
    createdAt: row.created_at,
  };
}

export function initializeTalkToolGrants(
  talkId: string,
  updatedBy?: string | null,
): void {
  const now = new Date().toISOString();
  const insert = getDb().prepare(
    `
      INSERT INTO talk_tool_grants (
        talk_id,
        tool_id,
        enabled,
        updated_at,
        updated_by
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(talk_id, tool_id) DO NOTHING
    `,
  );
  const tx = getDb().transaction(() => {
    BUILTIN_TALK_TOOLS.forEach((tool) => {
      insert.run(
        talkId,
        tool.id,
        tool.defaultGrant ? 1 : 0,
        now,
        updatedBy ?? null,
      );
    });
  });
  tx();
}

export function listTalkToolGrants(talkId: string): TalkToolGrantRecord[] {
  return (
    getDb()
      .prepare(
        `
        SELECT *
        FROM talk_tool_grants
        WHERE talk_id = ?
        ORDER BY tool_id ASC
      `,
      )
      .all(talkId) as RawTalkToolGrantRow[]
  ).map(toTalkToolGrantRecord);
}

export function replaceTalkToolGrants(input: {
  talkId: string;
  grants: Array<{ toolId: string; enabled: boolean }>;
  updatedBy?: string | null;
}): TalkToolGrantRecord[] {
  const now = new Date().toISOString();
  const clear = getDb().prepare(
    `DELETE FROM talk_tool_grants WHERE talk_id = ?`,
  );
  const insert = getDb().prepare(
    `
      INSERT INTO talk_tool_grants (
        talk_id,
        tool_id,
        enabled,
        updated_at,
        updated_by
      )
      VALUES (?, ?, ?, ?, ?)
    `,
  );
  const tx = getDb().transaction(() => {
    clear.run(input.talkId);
    input.grants.forEach((grant) => {
      insert.run(
        input.talkId,
        grant.toolId,
        grant.enabled ? 1 : 0,
        now,
        input.updatedBy ?? null,
      );
    });
  });
  tx();
  return listTalkToolGrants(input.talkId);
}

export function listTalkResourceBindings(
  talkId: string,
): TalkResourceBindingRecord[] {
  return (
    getDb()
      .prepare(
        `
        SELECT *
        FROM talk_resource_bindings
        WHERE talk_id = ?
        ORDER BY created_at ASC, id ASC
      `,
      )
      .all(talkId) as RawTalkResourceBindingRow[]
  ).map(toTalkResourceBindingRecord);
}

export function createTalkResourceBinding(input: {
  talkId: string;
  bindingKind: TalkResourceBindingKind;
  externalId: string;
  displayName: string;
  metadata?: JsonMap | null;
  createdBy?: string | null;
}): TalkResourceBindingRecord {
  const existing = getDb()
    .prepare(
      `
      SELECT *
      FROM talk_resource_bindings
      WHERE talk_id = ?
        AND binding_kind = ?
        AND external_id = ?
      LIMIT 1
    `,
    )
    .get(input.talkId, input.bindingKind, input.externalId) as
    | RawTalkResourceBindingRow
    | undefined;
  if (existing) {
    return toTalkResourceBindingRecord(existing);
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO talk_resource_bindings (
        id,
        talk_id,
        binding_kind,
        external_id,
        display_name,
        metadata_json,
        created_at,
        created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      id,
      input.talkId,
      input.bindingKind,
      input.externalId,
      input.displayName,
      serializeJsonMap(input.metadata),
      now,
      input.createdBy ?? null,
    );

  const row = getDb()
    .prepare(`SELECT * FROM talk_resource_bindings WHERE id = ? LIMIT 1`)
    .get(id) as RawTalkResourceBindingRow | undefined;
  if (!row) {
    throw new Error(`failed to load talk resource binding ${id}`);
  }
  return toTalkResourceBindingRecord(row);
}

export function deleteTalkResourceBinding(
  talkId: string,
  bindingId: string,
): boolean {
  const result = getDb()
    .prepare(
      `
      DELETE FROM talk_resource_bindings
      WHERE talk_id = ? AND id = ?
    `,
    )
    .run(talkId, bindingId);
  return result.changes > 0;
}

export function getUserGoogleCredential(
  userId: string,
): UserGoogleCredentialRecord | undefined {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM user_google_credentials
      WHERE user_id = ?
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `,
    )
    .get(userId) as RawUserGoogleCredentialRow | undefined;
  return row ? toUserGoogleCredentialRecord(row) : undefined;
}

export function upsertUserGoogleCredential(input: {
  userId: string;
  googleSubject: string;
  email: string;
  displayName?: string | null;
  scopes: string[];
  ciphertext: string;
  accessExpiresAt?: string | null;
}): UserGoogleCredentialRecord {
  const now = new Date().toISOString();
  const existing = getUserGoogleCredential(input.userId);
  const id = existing?.id || randomUUID();

  getDb()
    .prepare(
      `
      INSERT INTO user_google_credentials (
        id,
        user_id,
        google_subject,
        email,
        display_name,
        scopes_json,
        ciphertext,
        access_expires_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        google_subject = excluded.google_subject,
        email = excluded.email,
        display_name = excluded.display_name,
        scopes_json = excluded.scopes_json,
        ciphertext = excluded.ciphertext,
        access_expires_at = excluded.access_expires_at,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      id,
      input.userId,
      input.googleSubject,
      input.email,
      input.displayName ?? null,
      serializeStringArray(Array.from(new Set(input.scopes)).sort()),
      input.ciphertext,
      input.accessExpiresAt ?? null,
      existing?.createdAt ?? now,
      now,
    );

  return getUserGoogleCredential(input.userId)!;
}

export function deleteUserGoogleCredential(userId: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM user_google_credentials WHERE user_id = ?`)
    .run(userId);
  return result.changes > 0;
}

export function createGoogleOAuthLinkRequest(input: {
  stateHash: string;
  userId: string;
  scopes: string[];
}): GoogleOAuthLinkRequestRecord {
  const createdAt = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO google_oauth_link_requests (
        state_hash,
        user_id,
        scopes_json,
        created_at
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT(state_hash) DO UPDATE SET
        user_id = excluded.user_id,
        scopes_json = excluded.scopes_json,
        created_at = excluded.created_at
    `,
    )
    .run(
      input.stateHash,
      input.userId,
      serializeStringArray(Array.from(new Set(input.scopes)).sort()),
      createdAt,
    );

  return getGoogleOAuthLinkRequest(input.stateHash)!;
}

export function getGoogleOAuthLinkRequest(
  stateHash: string,
): GoogleOAuthLinkRequestRecord | undefined {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM google_oauth_link_requests
      WHERE state_hash = ?
      LIMIT 1
    `,
    )
    .get(stateHash) as RawGoogleOAuthLinkRequestRow | undefined;
  return row ? toGoogleOAuthLinkRequestRecord(row) : undefined;
}

export function deleteGoogleOAuthLinkRequest(stateHash: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM google_oauth_link_requests WHERE state_hash = ?`)
    .run(stateHash);
  return result.changes > 0;
}
