// clawtalk Phase 5 (PR 2) — postgres port of context-accessors.
//
// Surfaces: talk_context_goal, talk_context_rules, talk_state_entries,
// talk_context_sources (+ ref counter), talk_message_attachments, plus
// the composite snapshot/prompt-assembly helpers.
//
// Every per-user table has RLS on owner_id (or analogous identity). The
// talk_context_source_ref_counter table is the exception: its policy
// walks the FK to public.talks(owner_id = auth.uid()), so the counter
// row doesn't carry owner_id of its own. Callers MUST wrap calls in
// `withUserContext(userId, async () => ...)` or RLS short-circuits via
// the BYPASSRLS pooled connection (gotcha #2 from editorialroom).
//
// Writes that need owner_id in the INSERT VALUES take an explicit
// `ownerId` param (RLS WITH CHECK requires it equals auth.uid()).
// Updates/reads/deletes filtered by RLS USING drop the redundant userId
// param the sqlite-era API carried.
//
// Schema differences vs sqlite:
//   - is_active / is_truncated / enabled are booleans (not 0/1).
//   - value_json + metadata_json are jsonb (postgres.js parses on read,
//     accepts an object via db.json() on write).
//   - IDs are uuid; integer literals need ::uuid casts at parameter sites.
//   - talk_message_attachments.file_size + mime_type are nullable in
//     pg; the API still requires them — kept the param shapes.

import { getDbPg, type Sql } from '../../db.js';

// ---------------------------------------------------------------------------
// State entry limits + key validation (carried over verbatim — DB-agnostic)
// ---------------------------------------------------------------------------

export const MAX_STATE_ENTRIES_PER_TALK = 30;
export const MAX_STATE_KEY_LENGTH = 80;
export const MAX_STATE_VALUE_BYTES = 20_000;
export const STATE_KEY_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/;

export function validateStateKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error('State key is required');
  }
  if (trimmed.length > MAX_STATE_KEY_LENGTH) {
    throw new Error(
      `State key exceeds ${MAX_STATE_KEY_LENGTH}-character limit`,
    );
  }
  if (!STATE_KEY_PATTERN.test(trimmed)) {
    throw new Error(
      'State key must contain only letters, digits, underscores, dots, colons, or hyphens, and must start with a letter, digit, or underscore.',
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextSourceType = 'url' | 'file' | 'text';
export type ContextSourceStatus = 'pending' | 'ready' | 'failed';
export type ContextSourceFetchStrategy = 'http' | 'browser' | 'managed';

export interface TalkGoalRecord {
  talk_id: string;
  owner_id: string;
  goal_text: string;
  updated_at: string;
  updated_by: string | null;
}

export interface TalkContextRuleRecord {
  id: string;
  talk_id: string;
  owner_id: string;
  rule_text: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface TalkContextSourceRecord {
  id: string;
  talk_id: string;
  owner_id: string;
  source_ref: string;
  source_type: ContextSourceType;
  title: string;
  note: string | null;
  sort_order: number;
  status: ContextSourceStatus;
  source_url: string | null;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  storage_key: string | null;
  extracted_text: string | null;
  extracted_at: string | null;
  last_fetched_at: string | null;
  extraction_error: string | null;
  fetch_strategy: ContextSourceFetchStrategy | null;
  is_truncated: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface TalkStateEntryRecord {
  id: string;
  talk_id: string;
  owner_id: string;
  key: string;
  value_json: unknown;
  version: number;
  updated_at: string;
  updated_by_user_id: string | null;
  updated_by_run_id: string | null;
}

// ---------------------------------------------------------------------------
// Snapshot types (API-facing)
// ---------------------------------------------------------------------------

export interface GoalSnapshot {
  goalText: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface ContextRuleSnapshot {
  id: string;
  ruleText: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContextSourceSnapshot {
  id: string;
  sourceRef: string;
  sourceType: ContextSourceType;
  title: string;
  note: string | null;
  sortOrder: number;
  status: ContextSourceStatus;
  sourceUrl: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  extractedTextLength: number | null;
  extractedAt: string | null;
  lastFetchedAt: string | null;
  extractionError: string | null;
  fetchStrategy: ContextSourceFetchStrategy | null;
  isTruncated: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export interface ContextSourceWithContent extends ContextSourceSnapshot {
  extractedText: string | null;
}

export interface TalkContextSnapshot {
  goal: GoalSnapshot | null;
  rules: ContextRuleSnapshot[];
  sources: ContextSourceSnapshot[];
}

export interface TalkStateEntrySnapshot {
  id: string;
  key: string;
  value: unknown;
  version: number;
  updatedAt: string;
  updatedByUserId: string | null;
  updatedByRunId: string | null;
}

export type TalkStateWriteResult =
  | { ok: true; entry: TalkStateEntrySnapshot }
  | { ok: false; current: TalkStateEntrySnapshot };

export type TalkStateDeleteResult =
  | { ok: true; deleted: true }
  | { ok: false; current: TalkStateEntrySnapshot };

// ---------------------------------------------------------------------------
// Snapshot conversions
// ---------------------------------------------------------------------------

function toRuleSnapshot(row: TalkContextRuleRecord): ContextRuleSnapshot {
  return {
    id: row.id,
    ruleText: row.rule_text,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSourceSnapshot(row: TalkContextSourceRecord): ContextSourceSnapshot {
  return {
    id: row.id,
    sourceRef: row.source_ref,
    sourceType: row.source_type,
    title: row.title,
    note: row.note,
    sortOrder: row.sort_order,
    status: row.status,
    sourceUrl: row.source_url,
    fileName: row.file_name,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    extractedTextLength: row.extracted_text?.length ?? null,
    extractedAt: row.extracted_at,
    lastFetchedAt: row.last_fetched_at,
    extractionError: row.extraction_error,
    fetchStrategy: row.fetch_strategy,
    isTruncated: row.is_truncated,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

function toSourceWithContent(
  row: TalkContextSourceRecord,
): ContextSourceWithContent {
  return { ...toSourceSnapshot(row), extractedText: row.extracted_text };
}

function toStateSnapshot(row: TalkStateEntryRecord): TalkStateEntrySnapshot {
  // jsonb round-trips cleanly via postgres.js — strings come back as
  // strings, objects as objects. No try/JSON.parse fallback needed (that
  // was a sqlite-era artifact when value_json was a TEXT column).
  return {
    id: row.id,
    key: row.key,
    value: row.value_json,
    version: row.version,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id,
    updatedByRunId: row.updated_by_run_id,
  };
}

// ---------------------------------------------------------------------------
// Goal accessors
// ---------------------------------------------------------------------------

export async function getTalkGoal(
  talkId: string,
): Promise<GoalSnapshot | null> {
  const db = getDbPg();
  const rows = await db<TalkGoalRecord[]>`
    select talk_id, owner_id, goal_text, updated_at, updated_by
    from public.talk_context_goal
    where talk_id = ${talkId}::uuid
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    goalText: row.goal_text,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export async function setTalkGoal(input: {
  ownerId: string;
  talkId: string;
  goalText: string;
  updatedBy: string;
}): Promise<GoalSnapshot | null> {
  const text = input.goalText.replace(/[\r\n]/g, '').trim();
  const db = getDbPg();
  if (!text) {
    await db`
      delete from public.talk_context_goal where talk_id = ${input.talkId}::uuid
    `;
    return null;
  }
  if (text.length > 160) {
    throw new Error('Goal text exceeds 160-character limit');
  }
  await db`
    insert into public.talk_context_goal
      (talk_id, owner_id, goal_text, updated_by)
    values
      (${input.talkId}::uuid, ${input.ownerId}::uuid, ${text},
       ${input.updatedBy}::uuid)
    on conflict (talk_id) do update set
      goal_text = excluded.goal_text,
      updated_at = now(),
      updated_by = excluded.updated_by
  `;
  return await getTalkGoal(input.talkId);
}

// ---------------------------------------------------------------------------
// Rule accessors
// ---------------------------------------------------------------------------

export async function listTalkContextRules(
  talkId: string,
): Promise<ContextRuleSnapshot[]> {
  const db = getDbPg();
  const rows = await db<TalkContextRuleRecord[]>`
    select id, talk_id, owner_id, rule_text, sort_order, is_active,
           created_at, updated_at
    from public.talk_context_rules
    where talk_id = ${talkId}::uuid
    order by sort_order asc, created_at asc
  `;
  return rows.map(toRuleSnapshot);
}

export async function getActiveRuleCount(talkId: string): Promise<number> {
  const db = getDbPg();
  const rows = await db<{ count: number }[]>`
    select count(*)::int as count
    from public.talk_context_rules
    where talk_id = ${talkId}::uuid and is_active = true
  `;
  return rows[0]?.count ?? 0;
}

export async function createTalkContextRule(input: {
  ownerId: string;
  talkId: string;
  ruleText: string;
}): Promise<ContextRuleSnapshot> {
  const text = input.ruleText.trim();
  if (!text) throw new Error('Rule text is required');
  if (text.length > 240)
    throw new Error('Rule text exceeds 240-character limit');

  const activeCount = await getActiveRuleCount(input.talkId);
  if (activeCount >= 8) {
    throw new Error('Maximum 8 active rules per talk');
  }

  const db = getDbPg();
  const maxOrder = await db<{ max_order: number }[]>`
    select coalesce(max(sort_order), -1)::int as max_order
    from public.talk_context_rules
    where talk_id = ${input.talkId}::uuid
  `;
  const rows = await db<TalkContextRuleRecord[]>`
    insert into public.talk_context_rules
      (talk_id, owner_id, rule_text, sort_order, is_active)
    values
      (${input.talkId}::uuid, ${input.ownerId}::uuid, ${text},
       ${(maxOrder[0]?.max_order ?? -1) + 1}, true)
    returning id, talk_id, owner_id, rule_text, sort_order, is_active,
              created_at, updated_at
  `;
  return toRuleSnapshot(rows[0]);
}

export async function patchTalkContextRule(input: {
  ruleId: string;
  talkId: string;
  ruleText?: string;
  isActive?: boolean;
  sortOrder?: number;
}): Promise<ContextRuleSnapshot | undefined> {
  const db = getDbPg();
  const existingRows = await db<TalkContextRuleRecord[]>`
    select id, talk_id, owner_id, rule_text, sort_order, is_active,
           created_at, updated_at
    from public.talk_context_rules
    where id = ${input.ruleId}::uuid and talk_id = ${input.talkId}::uuid
    limit 1
  `;
  const existing = existingRows[0];
  if (!existing) return undefined;

  let nextText = existing.rule_text;
  let nextActive = existing.is_active;
  let nextOrder = existing.sort_order;

  if (input.ruleText !== undefined) {
    nextText = input.ruleText.trim();
    if (!nextText) throw new Error('Rule text is required');
    if (nextText.length > 240)
      throw new Error('Rule text exceeds 240-character limit');
  }
  if (input.isActive !== undefined) {
    if (input.isActive && !existing.is_active) {
      const activeCount = await getActiveRuleCount(input.talkId);
      if (activeCount >= 8) {
        throw new Error('Maximum 8 active rules per talk');
      }
    }
    nextActive = input.isActive;
  }
  if (input.sortOrder !== undefined) nextOrder = input.sortOrder;

  const rows = await db<TalkContextRuleRecord[]>`
    update public.talk_context_rules
    set rule_text = ${nextText},
        is_active = ${nextActive},
        sort_order = ${nextOrder},
        updated_at = now()
    where id = ${input.ruleId}::uuid
    returning id, talk_id, owner_id, rule_text, sort_order, is_active,
              created_at, updated_at
  `;
  return rows[0] ? toRuleSnapshot(rows[0]) : undefined;
}

export async function deleteTalkContextRule(
  ruleId: string,
  talkId: string,
): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    delete from public.talk_context_rules
    where id = ${ruleId}::uuid and talk_id = ${talkId}::uuid
    returning id
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// State accessors
// ---------------------------------------------------------------------------

export async function listTalkStateEntries(
  talkId: string,
): Promise<TalkStateEntrySnapshot[]> {
  const db = getDbPg();
  const rows = await db<TalkStateEntryRecord[]>`
    select id, talk_id, owner_id, key, value_json, version, updated_at,
           updated_by_user_id, updated_by_run_id
    from public.talk_state_entries
    where talk_id = ${talkId}::uuid
    order by updated_at desc, key asc
  `;
  return rows.map(toStateSnapshot);
}

export async function listTalkStateEntriesByPrefix(
  talkId: string,
  prefix: string,
): Promise<TalkStateEntrySnapshot[]> {
  const normalized = validateStateKey(prefix);
  const entries = await listTalkStateEntries(talkId);
  return entries.filter((entry) => entry.key.startsWith(normalized));
}

export async function getTalkStateEntry(
  talkId: string,
  key: string,
): Promise<TalkStateEntrySnapshot | undefined> {
  const db = getDbPg();
  const rows = await db<TalkStateEntryRecord[]>`
    select id, talk_id, owner_id, key, value_json, version, updated_at,
           updated_by_user_id, updated_by_run_id
    from public.talk_state_entries
    where talk_id = ${talkId}::uuid and key = ${key}
    limit 1
  `;
  return rows[0] ? toStateSnapshot(rows[0]) : undefined;
}

export async function getTalkStateEntryCount(talkId: string): Promise<number> {
  const db = getDbPg();
  const rows = await db<{ count: number }[]>`
    select count(*)::int as count
    from public.talk_state_entries
    where talk_id = ${talkId}::uuid
  `;
  return rows[0]?.count ?? 0;
}

export async function upsertTalkStateEntry(input: {
  ownerId: string;
  talkId: string;
  key: string;
  value: unknown;
  expectedVersion: number;
  updatedByUserId?: string | null;
  updatedByRunId?: string | null;
}): Promise<TalkStateWriteResult> {
  const key = validateStateKey(input.key);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error('expectedVersion must be a non-negative integer');
  }
  // Byte-cap matches the API contract: payload must be ≤ 20 KB encoded.
  const valueJson = JSON.stringify(input.value ?? null);
  if (Buffer.byteLength(valueJson, 'utf8') > MAX_STATE_VALUE_BYTES) {
    throw new Error('State value exceeds 20 KB limit');
  }
  const value = input.value ?? null;

  const db: Sql = getDbPg();
  const existingRows = await db<TalkStateEntryRecord[]>`
    select id, talk_id, owner_id, key, value_json, version, updated_at,
           updated_by_user_id, updated_by_run_id
    from public.talk_state_entries
    where talk_id = ${input.talkId}::uuid and key = ${key}
    limit 1
  `;
  const existing = existingRows[0];

  if (!existing) {
    if (input.expectedVersion !== 0) {
      throw new Error(
        `State entry "${key}" does not exist. Create it with expectedVersion 0.`,
      );
    }
    const count = await getTalkStateEntryCount(input.talkId);
    if (count >= MAX_STATE_ENTRIES_PER_TALK) {
      throw new Error(
        `Maximum ${MAX_STATE_ENTRIES_PER_TALK} state entries per talk`,
      );
    }
    const inserted = await db<TalkStateEntryRecord[]>`
      insert into public.talk_state_entries
        (talk_id, owner_id, key, value_json, version,
         updated_by_user_id, updated_by_run_id)
      values
        (${input.talkId}::uuid, ${input.ownerId}::uuid, ${key},
         ${db.json(value as never)}, 1,
         ${input.updatedByUserId ?? null}::uuid,
         ${input.updatedByRunId ?? null}::uuid)
      returning id, talk_id, owner_id, key, value_json, version, updated_at,
                updated_by_user_id, updated_by_run_id
    `;
    return { ok: true, entry: toStateSnapshot(inserted[0]) };
  }

  if (existing.version !== input.expectedVersion) {
    return { ok: false, current: toStateSnapshot(existing) };
  }

  const updated = await db<TalkStateEntryRecord[]>`
    update public.talk_state_entries
    set value_json = ${db.json(value as never)},
        version = version + 1,
        updated_at = now(),
        updated_by_user_id = ${input.updatedByUserId ?? null}::uuid,
        updated_by_run_id = ${input.updatedByRunId ?? null}::uuid
    where id = ${existing.id}::uuid and version = ${input.expectedVersion}
    returning id, talk_id, owner_id, key, value_json, version, updated_at,
              updated_by_user_id, updated_by_run_id
  `;
  return { ok: true, entry: toStateSnapshot(updated[0]) };
}

export async function deleteTalkStateEntry(input: {
  talkId: string;
  key: string;
  expectedVersion: number;
}): Promise<TalkStateDeleteResult> {
  const key = validateStateKey(input.key);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error('expectedVersion must be a non-negative integer');
  }
  const db = getDbPg();
  const existingRows = await db<TalkStateEntryRecord[]>`
    select id, talk_id, owner_id, key, value_json, version, updated_at,
           updated_by_user_id, updated_by_run_id
    from public.talk_state_entries
    where talk_id = ${input.talkId}::uuid and key = ${key}
    limit 1
  `;
  const existing = existingRows[0];
  if (!existing) throw new Error(`State entry "${key}" does not exist.`);
  if (existing.version !== input.expectedVersion) {
    return { ok: false, current: toStateSnapshot(existing) };
  }
  await db`
    delete from public.talk_state_entries
    where id = ${existing.id}::uuid and version = ${input.expectedVersion}
  `;
  return { ok: true, deleted: true };
}

export async function forceDeleteTalkStateEntry(
  talkId: string,
  key: string,
): Promise<boolean> {
  const validatedKey = validateStateKey(key);
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    delete from public.talk_state_entries
    where talk_id = ${talkId}::uuid and key = ${validatedKey}
    returning id
  `;
  return rows.length > 0;
}

export async function forceDeleteTalkStateEntriesByPrefix(
  talkId: string,
  prefix: string,
): Promise<number> {
  const validatedPrefix = validateStateKey(prefix);
  const db = getDbPg();
  const escaped = validatedPrefix.replace(/[\\%_]/g, '\\$&');
  const rows = await db<{ id: string }[]>`
    delete from public.talk_state_entries
    where talk_id = ${talkId}::uuid
      and key like ${escaped + '%'}
    returning id
  `;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Source ref counter
// ---------------------------------------------------------------------------

async function allocateSourceRef(talkId: string): Promise<string> {
  const db = getDbPg();
  // RETURNING gives the value BEFORE the UPDATE applies, so we use a CTE
  // pattern: upsert, then return the pre-increment value. Postgres's
  // `insert ... on conflict do update returning` returns the NEW row, so
  // we compute the next number client-side via a SELECT first.
  const rows = await db<{ next_ref_number: number }[]>`
    select next_ref_number
    from public.talk_context_source_ref_counter
    where talk_id = ${talkId}::uuid
    limit 1
  `;
  const nextNumber = rows[0]?.next_ref_number ?? 1;
  await db`
    insert into public.talk_context_source_ref_counter
      (talk_id, next_ref_number)
    values (${talkId}::uuid, ${nextNumber + 1})
    on conflict (talk_id) do update set
      next_ref_number = excluded.next_ref_number
  `;
  return `S${nextNumber}`;
}

// ---------------------------------------------------------------------------
// Source accessors
// ---------------------------------------------------------------------------

const SOURCE_COLUMNS = `id, talk_id, owner_id, source_ref, source_type, title,
  note, sort_order, status, source_url, file_name, file_size, mime_type,
  storage_key, extracted_text, extracted_at, last_fetched_at, extraction_error,
  fetch_strategy, is_truncated, created_at, updated_at, created_by`;

export async function listTalkContextSources(
  talkId: string,
): Promise<ContextSourceSnapshot[]> {
  const db = getDbPg();
  const rows = await db<TalkContextSourceRecord[]>`
    select id, talk_id, owner_id, source_ref, source_type, title, note,
           sort_order, status, source_url, file_name, file_size, mime_type,
           storage_key, extracted_text, extracted_at, last_fetched_at,
           extraction_error, fetch_strategy, is_truncated, created_at,
           updated_at, created_by
    from public.talk_context_sources
    where talk_id = ${talkId}::uuid
    order by sort_order asc, created_at asc
  `;
  return rows.map(toSourceSnapshot);
}

export async function getTalkContextSourceCount(
  talkId: string,
): Promise<number> {
  const db = getDbPg();
  const rows = await db<{ count: number }[]>`
    select count(*)::int as count
    from public.talk_context_sources
    where talk_id = ${talkId}::uuid
  `;
  return rows[0]?.count ?? 0;
}

export async function getTalkContextSourceById(
  sourceId: string,
  talkId: string,
): Promise<ContextSourceSnapshot | undefined> {
  const db = getDbPg();
  const rows = await db<TalkContextSourceRecord[]>`
    select id, talk_id, owner_id, source_ref, source_type, title, note,
           sort_order, status, source_url, file_name, file_size, mime_type,
           storage_key, extracted_text, extracted_at, last_fetched_at,
           extraction_error, fetch_strategy, is_truncated, created_at,
           updated_at, created_by
    from public.talk_context_sources
    where id = ${sourceId}::uuid and talk_id = ${talkId}::uuid
    limit 1
  `;
  return rows[0] ? toSourceSnapshot(rows[0]) : undefined;
}

export async function getTalkContextSourceByRef(
  sourceRef: string,
  talkId: string,
): Promise<ContextSourceWithContent | undefined> {
  const db = getDbPg();
  const rows = await db<TalkContextSourceRecord[]>`
    select id, talk_id, owner_id, source_ref, source_type, title, note,
           sort_order, status, source_url, file_name, file_size, mime_type,
           storage_key, extracted_text, extracted_at, last_fetched_at,
           extraction_error, fetch_strategy, is_truncated, created_at,
           updated_at, created_by
    from public.talk_context_sources
    where source_ref = ${sourceRef} and talk_id = ${talkId}::uuid
    limit 1
  `;
  return rows[0] ? toSourceWithContent(rows[0]) : undefined;
}

export async function createTalkContextSource(input: {
  ownerId: string;
  talkId: string;
  sourceType: ContextSourceType;
  title: string;
  note?: string | null;
  sourceUrl?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  mimeType?: string | null;
  storageKey?: string | null;
  extractedText?: string | null;
  extractionError?: string | null;
  createdBy: string;
}): Promise<ContextSourceSnapshot> {
  const count = await getTalkContextSourceCount(input.talkId);
  if (count >= 20) {
    throw new Error('Maximum 20 saved sources per talk');
  }

  const title = input.title.trim();
  if (!title) throw new Error('Source title is required');
  const sourceRef = await allocateSourceRef(input.talkId);

  let status: ContextSourceStatus = 'pending';
  let extractedText: string | null = null;
  let isTruncated = false;
  let extractedAt: string | null = null;
  if (input.sourceType === 'text' || input.sourceType === 'file') {
    extractedText = input.extractedText ?? null;
    if (extractedText !== null) {
      if (extractedText.length > 50_000) {
        extractedText = extractedText.slice(0, 50_000);
        isTruncated = true;
      }
      status = 'ready';
      extractedAt = new Date().toISOString();
    } else if (input.sourceType === 'file') {
      status = input.extractionError ? 'failed' : 'ready';
      extractedAt = new Date().toISOString();
    }
  }

  const db = getDbPg();
  const maxOrder = await db<{ max_order: number }[]>`
    select coalesce(max(sort_order), -1)::int as max_order
    from public.talk_context_sources
    where talk_id = ${input.talkId}::uuid
  `;
  const rows = await db<TalkContextSourceRecord[]>`
    insert into public.talk_context_sources
      (talk_id, owner_id, source_ref, source_type, title, note, sort_order,
       status, source_url, file_name, file_size, mime_type, storage_key,
       extracted_text, extracted_at, extraction_error, is_truncated,
       created_by)
    values
      (${input.talkId}::uuid, ${input.ownerId}::uuid, ${sourceRef},
       ${input.sourceType}, ${title}, ${input.note?.trim() || null},
       ${(maxOrder[0]?.max_order ?? -1) + 1}, ${status},
       ${input.sourceUrl ?? null}, ${input.fileName ?? null},
       ${input.fileSize ?? null}, ${input.mimeType ?? null},
       ${input.storageKey ?? null}, ${extractedText}, ${extractedAt},
       ${input.extractionError ?? null}, ${isTruncated},
       ${input.createdBy}::uuid)
    returning id, talk_id, owner_id, source_ref, source_type, title, note,
              sort_order, status, source_url, file_name, file_size, mime_type,
              storage_key, extracted_text, extracted_at, last_fetched_at,
              extraction_error, fetch_strategy, is_truncated, created_at,
              updated_at, created_by
  `;
  return toSourceSnapshot(rows[0]);
}

export async function patchTalkContextSource(input: {
  sourceId: string;
  talkId: string;
  title?: string;
  note?: string | null;
  sortOrder?: number;
  extractedText?: string | null;
}): Promise<ContextSourceSnapshot | undefined> {
  const db = getDbPg();
  const existingRows = await db<TalkContextSourceRecord[]>`
    select id, talk_id, owner_id, source_ref, source_type, title, note,
           sort_order, status, source_url, file_name, file_size, mime_type,
           storage_key, extracted_text, extracted_at, last_fetched_at,
           extraction_error, fetch_strategy, is_truncated, created_at,
           updated_at, created_by
    from public.talk_context_sources
    where id = ${input.sourceId}::uuid and talk_id = ${input.talkId}::uuid
    limit 1
  `;
  const existing = existingRows[0];
  if (!existing) return undefined;

  let nextTitle = existing.title;
  let nextNote = existing.note;
  let nextOrder = existing.sort_order;
  if (input.title !== undefined) {
    nextTitle = input.title.trim();
    if (!nextTitle) throw new Error('Source title is required');
  }
  if (input.note !== undefined) nextNote = input.note?.trim() || null;
  if (input.sortOrder !== undefined) nextOrder = input.sortOrder;

  if (input.extractedText !== undefined && existing.source_type === 'text') {
    let text = input.extractedText;
    let isTruncated = false;
    if (text && text.length > 50_000) {
      text = text.slice(0, 50_000);
      isTruncated = true;
    }
    const rows = await db<TalkContextSourceRecord[]>`
      update public.talk_context_sources
      set title = ${nextTitle},
          note = ${nextNote},
          sort_order = ${nextOrder},
          extracted_text = ${text},
          extracted_at = now(),
          is_truncated = ${isTruncated},
          status = 'ready',
          updated_at = now()
      where id = ${input.sourceId}::uuid
      returning id, talk_id, owner_id, source_ref, source_type, title, note,
                sort_order, status, source_url, file_name, file_size, mime_type,
                storage_key, extracted_text, extracted_at, last_fetched_at,
                extraction_error, fetch_strategy, is_truncated, created_at,
                updated_at, created_by
    `;
    return rows[0] ? toSourceSnapshot(rows[0]) : undefined;
  }

  const rows = await db<TalkContextSourceRecord[]>`
    update public.talk_context_sources
    set title = ${nextTitle},
        note = ${nextNote},
        sort_order = ${nextOrder},
        updated_at = now()
    where id = ${input.sourceId}::uuid
    returning id, talk_id, owner_id, source_ref, source_type, title, note,
              sort_order, status, source_url, file_name, file_size, mime_type,
              storage_key, extracted_text, extracted_at, last_fetched_at,
              extraction_error, fetch_strategy, is_truncated, created_at,
              updated_at, created_by
  `;
  return rows[0] ? toSourceSnapshot(rows[0]) : undefined;
}

export async function updateSourceExtraction(input: {
  sourceId: string;
  extractedText: string | null;
  extractionError: string | null;
  mimeType?: string | null;
  fetchStrategy?: ContextSourceFetchStrategy | null;
  fetchedAt?: string | null;
}): Promise<void> {
  const db = getDbPg();
  const fetchedAt = input.fetchedAt ?? new Date().toISOString();

  if (input.extractionError) {
    await db`
      update public.talk_context_sources
      set extraction_error = ${input.extractionError},
          last_fetched_at = ${fetchedAt},
          fetch_strategy = coalesce(${input.fetchStrategy ?? null}, fetch_strategy),
          status = case when extracted_text is not null then status else 'failed' end,
          updated_at = now()
      where id = ${input.sourceId}::uuid
    `;
    return;
  }

  let text = input.extractedText;
  let isTruncated = false;
  if (text && text.length > 50_000) {
    text = text.slice(0, 50_000);
    isTruncated = true;
  }

  await db`
    update public.talk_context_sources
    set extracted_text = ${text},
        extracted_at = now(),
        last_fetched_at = ${fetchedAt},
        extraction_error = null,
        fetch_strategy = coalesce(${input.fetchStrategy ?? null}, fetch_strategy),
        is_truncated = ${isTruncated},
        status = 'ready',
        mime_type = coalesce(${input.mimeType ?? null}, mime_type),
        updated_at = now()
    where id = ${input.sourceId}::uuid
  `;
}

export async function markTalkContextSourcePending(
  sourceId: string,
  talkId: string,
): Promise<ContextSourceSnapshot | undefined> {
  const db = getDbPg();
  const rows = await db<TalkContextSourceRecord[]>`
    update public.talk_context_sources
    set status = 'pending',
        extraction_error = null,
        updated_at = now()
    where id = ${sourceId}::uuid and talk_id = ${talkId}::uuid
    returning id, talk_id, owner_id, source_ref, source_type, title, note,
              sort_order, status, source_url, file_name, file_size, mime_type,
              storage_key, extracted_text, extracted_at, last_fetched_at,
              extraction_error, fetch_strategy, is_truncated, created_at,
              updated_at, created_by
  `;
  return rows[0] ? toSourceSnapshot(rows[0]) : undefined;
}

export async function getContextSourceWithContent(
  sourceId: string,
  talkId: string,
): Promise<ContextSourceWithContent | undefined> {
  const db = getDbPg();
  const rows = await db<TalkContextSourceRecord[]>`
    select id, talk_id, owner_id, source_ref, source_type, title, note,
           sort_order, status, source_url, file_name, file_size, mime_type,
           storage_key, extracted_text, extracted_at, last_fetched_at,
           extraction_error, fetch_strategy, is_truncated, created_at,
           updated_at, created_by
    from public.talk_context_sources
    where id = ${sourceId}::uuid and talk_id = ${talkId}::uuid
    limit 1
  `;
  return rows[0] ? toSourceWithContent(rows[0]) : undefined;
}

export async function getContextSourceStorageKey(
  sourceId: string,
  talkId: string,
): Promise<string | null> {
  const db = getDbPg();
  const rows = await db<{ storage_key: string | null }[]>`
    select storage_key
    from public.talk_context_sources
    where id = ${sourceId}::uuid and talk_id = ${talkId}::uuid
    limit 1
  `;
  return rows[0]?.storage_key ?? null;
}

export async function deleteTalkContextSource(
  sourceId: string,
  talkId: string,
): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    delete from public.talk_context_sources
    where id = ${sourceId}::uuid and talk_id = ${talkId}::uuid
    returning id
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Message attachments
// ---------------------------------------------------------------------------

export type AttachmentExtractionStatus = 'pending' | 'ready' | 'failed';

export interface MessageAttachmentRecord {
  id: string;
  message_id: string | null;
  talk_id: string;
  owner_id: string;
  file_name: string;
  file_size: number | null;
  mime_type: string | null;
  storage_key: string;
  extracted_text: string | null;
  extraction_status: AttachmentExtractionStatus;
  extraction_error: string | null;
  created_at: string;
  created_by: string | null;
}

export interface AttachmentSnapshot {
  id: string;
  messageId: string | null;
  fileName: string;
  fileSize: number | null;
  mimeType: string | null;
  extractionStatus: AttachmentExtractionStatus;
  extractionError: string | null;
  extractedTextLength: number | null;
  createdAt: string;
}

function toAttachmentSnapshot(
  row: MessageAttachmentRecord,
): AttachmentSnapshot {
  return {
    id: row.id,
    messageId: row.message_id,
    fileName: row.file_name,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    extractionStatus: row.extraction_status,
    extractionError: row.extraction_error,
    extractedTextLength: row.extracted_text?.length ?? null,
    createdAt: row.created_at,
  };
}

export async function createMessageAttachment(input: {
  ownerId: string;
  id?: string;
  talkId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  storageKey: string;
  createdBy: string;
}): Promise<AttachmentSnapshot> {
  const db = getDbPg();
  // id is optional now (was required in sqlite). When provided, callers
  // (executor pre-generated ids for streaming) still get the same shape.
  const rows = input.id
    ? await db<MessageAttachmentRecord[]>`
        insert into public.talk_message_attachments
          (id, talk_id, owner_id, file_name, file_size, mime_type,
           storage_key, extraction_status, created_by)
        values
          (${input.id}::uuid, ${input.talkId}::uuid, ${input.ownerId}::uuid,
           ${input.fileName}, ${input.fileSize}, ${input.mimeType},
           ${input.storageKey}, 'pending', ${input.createdBy}::uuid)
        returning id, message_id, talk_id, owner_id, file_name, file_size,
                  mime_type, storage_key, extracted_text, extraction_status,
                  extraction_error, created_at, created_by
      `
    : await db<MessageAttachmentRecord[]>`
        insert into public.talk_message_attachments
          (talk_id, owner_id, file_name, file_size, mime_type, storage_key,
           extraction_status, created_by)
        values
          (${input.talkId}::uuid, ${input.ownerId}::uuid, ${input.fileName},
           ${input.fileSize}, ${input.mimeType}, ${input.storageKey},
           'pending', ${input.createdBy}::uuid)
        returning id, message_id, talk_id, owner_id, file_name, file_size,
                  mime_type, storage_key, extracted_text, extraction_status,
                  extraction_error, created_at, created_by
      `;
  return toAttachmentSnapshot(rows[0]);
}

export async function linkAttachmentToMessage(
  attachmentId: string,
  messageId: string,
  talkId: string,
): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    update public.talk_message_attachments
    set message_id = ${messageId}::uuid
    where id = ${attachmentId}::uuid
      and talk_id = ${talkId}::uuid
      and message_id is null
    returning id
  `;
  return rows.length > 0;
}

export async function listMessageAttachments(
  messageId: string,
): Promise<AttachmentSnapshot[]> {
  const db = getDbPg();
  const rows = await db<MessageAttachmentRecord[]>`
    select id, message_id, talk_id, owner_id, file_name, file_size, mime_type,
           storage_key, extracted_text, extraction_status, extraction_error,
           created_at, created_by
    from public.talk_message_attachments
    where message_id = ${messageId}::uuid
    order by created_at asc
  `;
  return rows.map(toAttachmentSnapshot);
}

export async function listMessageAttachmentRecords(
  messageId: string,
): Promise<MessageAttachmentRecord[]> {
  const db = getDbPg();
  return await db<MessageAttachmentRecord[]>`
    select id, message_id, talk_id, owner_id, file_name, file_size, mime_type,
           storage_key, extracted_text, extraction_status, extraction_error,
           created_at, created_by
    from public.talk_message_attachments
    where message_id = ${messageId}::uuid
    order by created_at asc
  `;
}

export async function listTalkAttachments(
  talkId: string,
): Promise<AttachmentSnapshot[]> {
  const db = getDbPg();
  const rows = await db<MessageAttachmentRecord[]>`
    select id, message_id, talk_id, owner_id, file_name, file_size, mime_type,
           storage_key, extracted_text, extraction_status, extraction_error,
           created_at, created_by
    from public.talk_message_attachments
    where talk_id = ${talkId}::uuid and message_id is not null
    order by created_at asc
  `;
  return rows.map(toAttachmentSnapshot);
}

export async function getMessageAttachmentById(
  attachmentId: string,
  talkId: string,
): Promise<MessageAttachmentRecord | null> {
  const db = getDbPg();
  const rows = await db<MessageAttachmentRecord[]>`
    select id, message_id, talk_id, owner_id, file_name, file_size, mime_type,
           storage_key, extracted_text, extraction_status, extraction_error,
           created_at, created_by
    from public.talk_message_attachments
    where id = ${attachmentId}::uuid and talk_id = ${talkId}::uuid
    limit 1
  `;
  return rows[0] ?? null;
}

export async function updateAttachmentExtraction(input: {
  attachmentId: string;
  extractedText?: string | null;
  extractionError?: string | null;
  extractionStatus: 'ready' | 'failed';
}): Promise<void> {
  let text = input.extractedText ?? null;
  if (text && text.length > 50_000) text = text.slice(0, 50_000);
  const db = getDbPg();
  await db`
    update public.talk_message_attachments
    set extracted_text = ${text},
        extraction_error = ${input.extractionError ?? null},
        extraction_status = ${input.extractionStatus}
    where id = ${input.attachmentId}::uuid
  `;
}

export async function deleteUnlinkedAttachments(
  talkId: string,
  olderThanIso: string,
): Promise<number> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    delete from public.talk_message_attachments
    where talk_id = ${talkId}::uuid
      and message_id is null
      and created_at < ${olderThanIso}::timestamptz
    returning id
  `;
  return rows.length;
}

/**
 * Cross-talk admin sweep. MUST run outside `withUserContext` — under the
 * postgres BYPASSRLS pool — or RLS scopes the delete to one user's
 * attachments and silently underdeletes. The PR-2-era nightly cron will
 * invoke this directly from the worker entrypoint, not from a request
 * handler.
 */
export async function pruneOrphanAttachments(olderThanIso: string): Promise<{
  count: number;
  storageKeys: string[];
}> {
  const db = getDbPg();
  const rows = await db<{ storage_key: string }[]>`
    delete from public.talk_message_attachments
    where message_id is null
      and created_at < ${olderThanIso}::timestamptz
    returning storage_key
  `;
  return { count: rows.length, storageKeys: rows.map((r) => r.storage_key) };
}

export async function listMessageAttachmentsForPrompt(
  messageId: string,
): Promise<
  Array<{
    id: string;
    fileName: string;
    mimeType: string | null;
    fileSize: number | null;
    extractedText: string | null;
    extractionStatus: AttachmentExtractionStatus;
  }>
> {
  const db = getDbPg();
  const rows = await db<
    Array<{
      id: string;
      file_name: string;
      mime_type: string | null;
      file_size: number | null;
      extracted_text: string | null;
      extraction_status: AttachmentExtractionStatus;
    }>
  >`
    select id, file_name, mime_type, file_size, extracted_text, extraction_status
    from public.talk_message_attachments
    where message_id = ${messageId}::uuid
    order by created_at asc
  `;
  return rows.map((r) => ({
    id: r.id,
    fileName: r.file_name,
    mimeType: r.mime_type,
    fileSize: r.file_size,
    extractedText: r.extracted_text,
    extractionStatus: r.extraction_status,
  }));
}

// ---------------------------------------------------------------------------
// Composite snapshot + prompt assembly
// ---------------------------------------------------------------------------

export async function getTalkContext(
  talkId: string,
): Promise<TalkContextSnapshot> {
  const [goal, rules, sources] = await Promise.all([
    getTalkGoal(talkId),
    listTalkContextRules(talkId),
    listTalkContextSources(talkId),
  ]);
  return { goal, rules, sources };
}

export interface TalkContextForPrompt {
  goalText: string | null;
  activeRules: string[];
  sources: Array<{
    sourceRef: string;
    sourceType: ContextSourceType;
    title: string;
    note: string | null;
    status: ContextSourceStatus;
    extractedText: string | null;
    sortOrder: number;
  }>;
}

export async function getTalkContextForPrompt(
  talkId: string,
): Promise<TalkContextForPrompt> {
  const db = getDbPg();
  const [goal, rules, sources] = await Promise.all([
    getTalkGoal(talkId),
    db<{ rule_text: string }[]>`
      select rule_text
      from public.talk_context_rules
      where talk_id = ${talkId}::uuid and is_active = true
      order by sort_order asc, created_at asc
    `,
    db<
      Array<{
        source_ref: string;
        source_type: ContextSourceType;
        title: string;
        note: string | null;
        status: ContextSourceStatus;
        extracted_text: string | null;
        sort_order: number;
      }>
    >`
      select source_ref, source_type, title, note, status, extracted_text, sort_order
      from public.talk_context_sources
      where talk_id = ${talkId}::uuid
      order by sort_order asc, created_at asc
    `,
  ]);
  return {
    goalText: goal?.goalText ?? null,
    activeRules: rules.map((r) => r.rule_text),
    sources: sources.map((s) => ({
      sourceRef: s.source_ref,
      sourceType: s.source_type,
      title: s.title,
      note: s.note,
      status: s.status,
      extractedText: s.extracted_text,
      sortOrder: s.sort_order,
    })),
  };
}
