// clawtalk Phase 5 (PR 2) — postgres port of talk-tools-accessors.
//
// Surfaces ported:
//   - talk_resource_bindings (RLS owner_id)
//   - user_google_credentials (RLS user_id; unique on user_id)
//   - google_oauth_link_requests (RLS user_id)
//
// Chassis cleanup: `talk_tool_grants` was removed from the postgres
// schema, so initializeTalkToolGrants / listTalkToolGrants /
// replaceTalkToolGrants are gone here. The BUILTIN_TALK_TOOLS catalog
// stays (pure metadata, no DB touch); route handlers still use it for
// the tool-permissions UI.

import { getDbPg } from '../../db.js';

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
    id: 'google_docs_create',
    family: 'google_docs',
    displayName: 'Google Docs Create',
    description: 'Create a new Google Doc and bind it to this Talk.',
    requiresBinding: false,
    defaultGrant: false,
    mutatesExternalState: true,
    sortOrder: 95,
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

// ---------------------------------------------------------------------------
// Records (API-facing, camelCase)
// ---------------------------------------------------------------------------

export interface TalkResourceBindingRecord {
  id: string;
  talkId: string;
  ownerId: string;
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

// ---------------------------------------------------------------------------
// Internal raw row shapes (postgres returns jsonb as parsed objects)
// ---------------------------------------------------------------------------

interface RawTalkResourceBindingRow {
  id: string;
  talk_id: string;
  owner_id: string;
  binding_kind: TalkResourceBindingKind;
  external_id: string;
  display_name: string;
  metadata_json: JsonMap | null;
  created_at: string;
  created_by: string | null;
}

interface RawUserGoogleCredentialRow {
  id: string;
  user_id: string;
  google_subject: string;
  email: string;
  display_name: string | null;
  scopes_json: string[];
  ciphertext: string;
  access_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RawGoogleOAuthLinkRequestRow {
  state_hash: string;
  user_id: string;
  scopes_json: string[];
  created_at: string;
}

function toTalkResourceBindingRecord(
  row: RawTalkResourceBindingRow,
): TalkResourceBindingRecord {
  return {
    id: row.id,
    talkId: row.talk_id,
    ownerId: row.owner_id,
    bindingKind: row.binding_kind,
    externalId: row.external_id,
    displayName: row.display_name,
    metadata: row.metadata_json,
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
    scopes: Array.isArray(row.scopes_json) ? row.scopes_json : [],
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
    scopes: Array.isArray(row.scopes_json) ? row.scopes_json : [],
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Talk resource bindings
// ---------------------------------------------------------------------------

export async function listTalkResourceBindings(
  talkId: string,
): Promise<TalkResourceBindingRecord[]> {
  const db = getDbPg();
  const rows = await db<RawTalkResourceBindingRow[]>`
    select id, talk_id, owner_id, binding_kind, external_id, display_name,
           metadata_json, created_at, created_by
    from public.talk_resource_bindings
    where talk_id = ${talkId}::uuid
    order by created_at asc, id asc
  `;
  return rows.map(toTalkResourceBindingRecord);
}

export async function createTalkResourceBinding(input: {
  ownerId: string;
  talkId: string;
  bindingKind: TalkResourceBindingKind;
  externalId: string;
  displayName: string;
  metadata?: JsonMap | null;
  createdBy?: string | null;
}): Promise<TalkResourceBindingRecord> {
  const db = getDbPg();
  // Migration 0018 widened the unique index to
  // (talk_id, binding_kind, external_id, owner_id). The 4-column
  // conflict target makes same-owner re-binds idempotent and lets two
  // users in the same talk each hold their own binding row to the
  // same external resource. The follow-up SELECT is RLS-scoped to
  // owner_id = auth.uid(), so it returns the caller's row even when
  // another user also has one.
  await db`
    insert into public.talk_resource_bindings
      (talk_id, owner_id, binding_kind, external_id, display_name,
       metadata_json, created_by)
    values
      (${input.talkId}::uuid, ${input.ownerId}::uuid, ${input.bindingKind},
       ${input.externalId}, ${input.displayName},
       ${input.metadata ? db.json(input.metadata as never) : null},
       ${input.createdBy ?? null}::uuid)
    on conflict (talk_id, binding_kind, external_id, owner_id) do nothing
  `;
  const rows = await db<RawTalkResourceBindingRow[]>`
    select id, talk_id, owner_id, binding_kind, external_id, display_name,
           metadata_json, created_at, created_by
    from public.talk_resource_bindings
    where talk_id = ${input.talkId}::uuid
      and binding_kind = ${input.bindingKind}
      and external_id = ${input.externalId}
    limit 1
  `;
  if (!rows[0]) {
    throw new Error('failed to load talk resource binding after insert');
  }
  return toTalkResourceBindingRecord(rows[0]);
}

export async function deleteTalkResourceBinding(
  talkId: string,
  bindingId: string,
): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    delete from public.talk_resource_bindings
    where talk_id = ${talkId}::uuid and id = ${bindingId}::uuid
    returning id
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// User Google credentials
// ---------------------------------------------------------------------------

export async function getUserGoogleCredential(): Promise<
  UserGoogleCredentialRecord | undefined
> {
  // Inside withUserContext, user_id = auth.uid() is enforced by RLS —
  // the SELECT scopes to the caller automatically. The sqlite-era
  // userId param is now redundant.
  const db = getDbPg();
  const rows = await db<RawUserGoogleCredentialRow[]>`
    select id, user_id, google_subject, email, display_name, scopes_json,
           ciphertext, access_expires_at, created_at, updated_at
    from public.user_google_credentials
    order by updated_at desc, created_at desc, id desc
    limit 1
  `;
  return rows[0] ? toUserGoogleCredentialRecord(rows[0]) : undefined;
}

export async function upsertUserGoogleCredential(input: {
  userId: string;
  googleSubject: string;
  email: string;
  displayName?: string | null;
  scopes: string[];
  ciphertext: string;
  accessExpiresAt?: string | null;
}): Promise<UserGoogleCredentialRecord> {
  const sortedScopes = Array.from(new Set(input.scopes)).sort();
  const db = getDbPg();
  await db`
    insert into public.user_google_credentials
      (user_id, google_subject, email, display_name, scopes_json,
       ciphertext, access_expires_at)
    values
      (${input.userId}::uuid, ${input.googleSubject}, ${input.email},
       ${input.displayName ?? null}, ${db.json(sortedScopes as never)},
       ${input.ciphertext}, ${input.accessExpiresAt ?? null})
    on conflict (user_id) do update set
      google_subject = excluded.google_subject,
      email = excluded.email,
      display_name = excluded.display_name,
      scopes_json = excluded.scopes_json,
      ciphertext = excluded.ciphertext,
      access_expires_at = excluded.access_expires_at,
      updated_at = now()
  `;
  const got = await getUserGoogleCredential();
  if (!got) {
    throw new Error('upsertUserGoogleCredential: missing row after upsert');
  }
  return got;
}

export async function deleteUserGoogleCredential(): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    delete from public.user_google_credentials
    returning id
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Google OAuth link requests
// ---------------------------------------------------------------------------

export async function createGoogleOAuthLinkRequest(input: {
  userId: string;
  stateHash: string;
  scopes: string[];
}): Promise<GoogleOAuthLinkRequestRecord> {
  const sortedScopes = Array.from(new Set(input.scopes)).sort();
  const db = getDbPg();
  await db`
    insert into public.google_oauth_link_requests
      (state_hash, user_id, scopes_json)
    values
      (${input.stateHash}, ${input.userId}::uuid,
       ${db.json(sortedScopes as never)})
    on conflict (state_hash) do update set
      user_id = excluded.user_id,
      scopes_json = excluded.scopes_json,
      created_at = now()
  `;
  const got = await getGoogleOAuthLinkRequest(input.stateHash);
  if (!got) {
    throw new Error('createGoogleOAuthLinkRequest: missing row after insert');
  }
  return got;
}

export async function getGoogleOAuthLinkRequest(
  stateHash: string,
): Promise<GoogleOAuthLinkRequestRecord | undefined> {
  const db = getDbPg();
  const rows = await db<RawGoogleOAuthLinkRequestRow[]>`
    select state_hash, user_id, scopes_json, created_at
    from public.google_oauth_link_requests
    where state_hash = ${stateHash}
    limit 1
  `;
  return rows[0] ? toGoogleOAuthLinkRequestRecord(rows[0]) : undefined;
}

export async function deleteGoogleOAuthLinkRequest(
  stateHash: string,
): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ state_hash: string }[]>`
    delete from public.google_oauth_link_requests
    where state_hash = ${stateHash}
    returning state_hash
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Talk active-tool families (migration 0030)
//
// `talks.active_tool_families_json` holds `Record<string, boolean>` keyed by
// family slug (vocabulary from TOOL_FAMILY_MAP in agent-accessors.ts). This
// is the per-Talk toggle layer that intersects with the agent capability
// ceiling at effective-tools-computation time. The migration inherits
// RLS from the existing `talks_owner` row policy.
// ---------------------------------------------------------------------------

export type TalkActiveToolFamilies = Record<string, boolean>;

interface ActiveFamiliesRow {
  active_tool_families_json: TalkActiveToolFamilies;
}

function normalizeActiveFamilies(value: unknown): TalkActiveToolFamilies {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: TalkActiveToolFamilies = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'boolean') out[key] = raw;
  }
  return out;
}

export async function getTalkActiveTools(
  talkId: string,
): Promise<TalkActiveToolFamilies> {
  const db = getDbPg();
  const rows = await db<ActiveFamiliesRow[]>`
    select active_tool_families_json
    from public.talks
    where id = ${talkId}::uuid
    limit 1
  `;
  if (!rows[0]) return {};
  return normalizeActiveFamilies(rows[0].active_tool_families_json);
}

export async function setTalkActiveTool(
  talkId: string,
  family: string,
  enabled: boolean,
): Promise<TalkActiveToolFamilies> {
  const db = getDbPg();
  const rows = await db<ActiveFamiliesRow[]>`
    update public.talks
    set active_tool_families_json = jsonb_set(
          coalesce(active_tool_families_json, '{}'::jsonb),
          array[${family}],
          to_jsonb(${enabled}::boolean)
        ),
        updated_at = now()
    where id = ${talkId}::uuid
    returning active_tool_families_json
  `;
  if (!rows[0]) {
    throw new Error(`setTalkActiveTool: talk ${talkId} not found`);
  }
  return normalizeActiveFamilies(rows[0].active_tool_families_json);
}

export async function getTalkAvailableFamilies(
  talkId: string,
): Promise<string[]> {
  const db = getDbPg();
  const rows = await db<{ family: string }[]>`
    select distinct kv.key as family
    from public.talk_agents ta
    join public.registered_agents ra on ra.id = ta.registered_agent_id
    cross join lateral jsonb_each(ra.tool_permissions_json) as kv
    where ta.talk_id = ${talkId}::uuid
      and kv.value = 'true'::jsonb
    order by kv.key asc
  `;
  return rows.map((r) => r.family);
}

/**
 * OR newly-added agents' `tool_permissions_json` into a Talk's
 * `active_tool_families_json`. Used by the Talk-create + Talk-agents-
 * update routes to keep the active set in sync with the assigned
 * agent set WITHOUT clobbering the user's deliberate toggle-offs.
 *
 * Behavior:
 *  - Only families where the agent has `true` in its capability map
 *    get OR'd in. False / absent values are no-ops.
 *  - The merge is in a single SQL statement — atomic per Talk row.
 *  - Pass an empty array and this is a no-op (returns current set).
 *
 * Removed agents do NOT pass through here; their toggle states are
 * preserved on `talks.active_tool_families_json` in case the agent is
 * re-added later.
 */
export async function mergeAgentToolsIntoTalkActive(
  talkId: string,
  newAgentIds: string[],
): Promise<TalkActiveToolFamilies> {
  const db = getDbPg();
  if (newAgentIds.length === 0) {
    return await getTalkActiveTools(talkId);
  }
  const rows = await db<ActiveFamiliesRow[]>`
    with addition as (
      select coalesce(
        jsonb_object_agg(kv.key, true) filter (where kv.value = 'true'::jsonb),
        '{}'::jsonb
      ) as families
      from public.registered_agents ra
      cross join lateral jsonb_each(ra.tool_permissions_json) as kv
      where ra.id in ${db(newAgentIds)}
    )
    update public.talks
    set active_tool_families_json =
          coalesce(active_tool_families_json, '{}'::jsonb)
          || (select families from addition),
        updated_at = now()
    where id = ${talkId}::uuid
    returning active_tool_families_json
  `;
  if (!rows[0]) {
    throw new Error(`mergeAgentToolsIntoTalkActive: talk ${talkId} not found`);
  }
  return normalizeActiveFamilies(rows[0].active_tool_families_json);
}
