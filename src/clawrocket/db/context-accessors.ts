import { randomUUID } from 'crypto';

import { getDb } from '../../db.js';
import { logger } from '../../logger.js';

// ---------------------------------------------------------------------------
// State entry limits
// ---------------------------------------------------------------------------

export const MAX_STATE_ENTRIES_PER_TALK = 30;
export const MAX_STATE_KEY_LENGTH = 80;
export const MAX_STATE_VALUE_BYTES = 20_000; // 20 KB
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
  goal_text: string;
  updated_at: string;
  updated_by: string | null;
}

export interface TalkContextRuleRecord {
  id: string;
  talk_id: string;
  rule_text: string;
  sort_order: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface TalkContextSourceRecord {
  id: string;
  talk_id: string;
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
  is_truncated: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface TalkStateEntryRecord {
  id: string;
  talk_id: string;
  key: string;
  value_json: string;
  version: number;
  updated_at: string;
  updated_by_user_id: string | null;
  updated_by_run_id: string | null;
}

// ---------------------------------------------------------------------------
// Snapshot types (API-facing, camelCase)
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
  | {
      ok: true;
      entry: TalkStateEntrySnapshot;
    }
  | {
      ok: false;
      current: TalkStateEntrySnapshot;
    };

export type TalkStateDeleteResult =
  | { ok: true; deleted: true }
  | { ok: false; current: TalkStateEntrySnapshot };

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

function toRuleSnapshot(row: TalkContextRuleRecord): ContextRuleSnapshot {
  return {
    id: row.id,
    ruleText: row.rule_text,
    sortOrder: row.sort_order,
    isActive: row.is_active === 1,
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
    isTruncated: row.is_truncated === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

function toSourceWithContent(
  row: TalkContextSourceRecord,
): ContextSourceWithContent {
  return {
    ...toSourceSnapshot(row),
    extractedText: row.extracted_text,
  };
}

function parseStateValue(valueJson: string, key?: string): unknown {
  try {
    return JSON.parse(valueJson);
  } catch {
    logger.warn(
      { key, byteLength: Buffer.byteLength(valueJson, 'utf8') },
      'Corrupt state JSON',
    );
    return valueJson;
  }
}

function toStateSnapshot(row: TalkStateEntryRecord): TalkStateEntrySnapshot {
  return {
    id: row.id,
    key: row.key,
    value: parseStateValue(row.value_json, row.key),
    version: row.version,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id,
    updatedByRunId: row.updated_by_run_id,
  };
}

// ---------------------------------------------------------------------------
// Goal accessors
// ---------------------------------------------------------------------------

export function getTalkGoal(talkId: string): GoalSnapshot | null {
  const row = getDb()
    .prepare(`SELECT * FROM talk_context_goal WHERE talk_id = ? LIMIT 1`)
    .get(talkId) as TalkGoalRecord | undefined;
  if (!row) return null;
  return {
    goalText: row.goal_text,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export function setTalkGoal(input: {
  talkId: string;
  goalText: string;
  updatedBy: string;
}): GoalSnapshot | null {
  const text = input.goalText.replace(/[\r\n]/g, '').trim();
  if (!text) {
    getDb()
      .prepare(`DELETE FROM talk_context_goal WHERE talk_id = ?`)
      .run(input.talkId);
    return null;
  }
  if (text.length > 160) {
    throw new Error('Goal text exceeds 160-character limit');
  }

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO talk_context_goal (talk_id, goal_text, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(talk_id) DO UPDATE SET
        goal_text = excluded.goal_text,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `,
    )
    .run(input.talkId, text, now, input.updatedBy);
  return getTalkGoal(input.talkId);
}

// ---------------------------------------------------------------------------
// Rule accessors
// ---------------------------------------------------------------------------

export function listTalkContextRules(talkId: string): ContextRuleSnapshot[] {
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM talk_context_rules
      WHERE talk_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `,
    )
    .all(talkId) as TalkContextRuleRecord[];
  return rows.map(toRuleSnapshot);
}

export function getActiveRuleCount(talkId: string): number {
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM talk_context_rules
      WHERE talk_id = ? AND is_active = 1
    `,
    )
    .get(talkId) as { count: number };
  return row.count;
}

export function createTalkContextRule(input: {
  talkId: string;
  ruleText: string;
}): ContextRuleSnapshot {
  const text = input.ruleText.trim();
  if (!text) throw new Error('Rule text is required');
  if (text.length > 240)
    throw new Error('Rule text exceeds 240-character limit');

  const activeCount = getActiveRuleCount(input.talkId);
  if (activeCount >= 8) {
    throw new Error('Maximum 8 active rules per talk');
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  // Insert at end of list
  const maxOrder = getDb()
    .prepare(
      `SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM talk_context_rules WHERE talk_id = ?`,
    )
    .get(input.talkId) as { max_order: number };

  getDb()
    .prepare(
      `
      INSERT INTO talk_context_rules (id, talk_id, rule_text, sort_order, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `,
    )
    .run(id, input.talkId, text, maxOrder.max_order + 1, now, now);

  const row = getDb()
    .prepare(`SELECT * FROM talk_context_rules WHERE id = ?`)
    .get(id) as TalkContextRuleRecord;
  return toRuleSnapshot(row);
}

export function patchTalkContextRule(input: {
  ruleId: string;
  talkId: string;
  ruleText?: string;
  isActive?: boolean;
  sortOrder?: number;
}): ContextRuleSnapshot | undefined {
  const existing = getDb()
    .prepare(`SELECT * FROM talk_context_rules WHERE id = ? AND talk_id = ?`)
    .get(input.ruleId, input.talkId) as TalkContextRuleRecord | undefined;
  if (!existing) return undefined;

  const now = new Date().toISOString();
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
    const willActivate = input.isActive && existing.is_active === 0;
    if (willActivate) {
      const activeCount = getActiveRuleCount(input.talkId);
      if (activeCount >= 8) {
        throw new Error('Maximum 8 active rules per talk');
      }
    }
    nextActive = input.isActive ? 1 : 0;
  }

  if (input.sortOrder !== undefined) {
    nextOrder = input.sortOrder;
  }

  getDb()
    .prepare(
      `
      UPDATE talk_context_rules
      SET rule_text = ?, is_active = ?, sort_order = ?, updated_at = ?
      WHERE id = ?
    `,
    )
    .run(nextText, nextActive, nextOrder, now, input.ruleId);

  const row = getDb()
    .prepare(`SELECT * FROM talk_context_rules WHERE id = ?`)
    .get(input.ruleId) as TalkContextRuleRecord;
  return toRuleSnapshot(row);
}

export function deleteTalkContextRule(ruleId: string, talkId: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM talk_context_rules WHERE id = ? AND talk_id = ?`)
    .run(ruleId, talkId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// State accessors
// ---------------------------------------------------------------------------

export function listTalkStateEntries(talkId: string): TalkStateEntrySnapshot[] {
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM talk_state_entries
      WHERE talk_id = ?
      ORDER BY updated_at DESC, key ASC
    `,
    )
    .all(talkId) as TalkStateEntryRecord[];
  return rows.map(toStateSnapshot);
}

export function listTalkStateEntriesByPrefix(
  talkId: string,
  prefix: string,
): TalkStateEntrySnapshot[] {
  const normalizedPrefix = validateStateKey(prefix);
  return listTalkStateEntries(talkId).filter((entry) =>
    entry.key.startsWith(normalizedPrefix),
  );
}

export function getTalkStateEntry(
  talkId: string,
  key: string,
): TalkStateEntrySnapshot | undefined {
  const row = getDb()
    .prepare(
      `
      SELECT * FROM talk_state_entries
      WHERE talk_id = ? AND key = ?
      LIMIT 1
    `,
    )
    .get(talkId, key) as TalkStateEntryRecord | undefined;
  return row ? toStateSnapshot(row) : undefined;
}

export function getTalkStateEntryCount(talkId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM talk_state_entries WHERE talk_id = ?`,
    )
    .get(talkId) as { count: number };
  return row.count;
}

export function upsertTalkStateEntry(input: {
  talkId: string;
  key: string;
  value: unknown;
  expectedVersion: number;
  updatedByUserId?: string | null;
  updatedByRunId?: string | null;
}): TalkStateWriteResult {
  const key = validateStateKey(input.key);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error('expectedVersion must be a non-negative integer');
  }

  const valueJson = JSON.stringify(input.value ?? null);
  if (Buffer.byteLength(valueJson, 'utf8') > MAX_STATE_VALUE_BYTES) {
    throw new Error('State value exceeds 20 KB limit');
  }

  const existingRow = getDb()
    .prepare(
      `
      SELECT * FROM talk_state_entries
      WHERE talk_id = ? AND key = ?
      LIMIT 1
    `,
    )
    .get(input.talkId, key) as TalkStateEntryRecord | undefined;

  const now = new Date().toISOString();

  if (!existingRow) {
    if (input.expectedVersion !== 0) {
      throw new Error(
        `State entry "${key}" does not exist. Create it with expectedVersion 0.`,
      );
    }

    const count = getTalkStateEntryCount(input.talkId);
    if (count >= MAX_STATE_ENTRIES_PER_TALK) {
      throw new Error(
        `Maximum ${MAX_STATE_ENTRIES_PER_TALK} state entries per talk`,
      );
    }

    const id = randomUUID();
    getDb()
      .prepare(
        `
        INSERT INTO talk_state_entries (
          id, talk_id, key, value_json, version, updated_at,
          updated_by_user_id, updated_by_run_id
        )
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      `,
      )
      .run(
        id,
        input.talkId,
        key,
        valueJson,
        now,
        input.updatedByUserId ?? null,
        input.updatedByRunId ?? null,
      );

    const created = getDb()
      .prepare(`SELECT * FROM talk_state_entries WHERE id = ?`)
      .get(id) as TalkStateEntryRecord;
    return { ok: true, entry: toStateSnapshot(created) };
  }

  if (existingRow.version !== input.expectedVersion) {
    return { ok: false, current: toStateSnapshot(existingRow) };
  }

  getDb()
    .prepare(
      `
      UPDATE talk_state_entries
      SET value_json = ?,
          version = version + 1,
          updated_at = ?,
          updated_by_user_id = ?,
          updated_by_run_id = ?
      WHERE id = ? AND version = ?
    `,
    )
    .run(
      valueJson,
      now,
      input.updatedByUserId ?? null,
      input.updatedByRunId ?? null,
      existingRow.id,
      input.expectedVersion,
    );

  const updated = getDb()
    .prepare(`SELECT * FROM talk_state_entries WHERE id = ?`)
    .get(existingRow.id) as TalkStateEntryRecord;
  return { ok: true, entry: toStateSnapshot(updated) };
}

export function deleteTalkStateEntry(input: {
  talkId: string;
  key: string;
  expectedVersion: number;
}): TalkStateDeleteResult {
  const key = validateStateKey(input.key);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error('expectedVersion must be a non-negative integer');
  }

  const existingRow = getDb()
    .prepare(
      `
      SELECT * FROM talk_state_entries
      WHERE talk_id = ? AND key = ?
      LIMIT 1
    `,
    )
    .get(input.talkId, key) as TalkStateEntryRecord | undefined;

  if (!existingRow) {
    throw new Error(`State entry "${key}" does not exist.`);
  }

  if (existingRow.version !== input.expectedVersion) {
    return { ok: false, current: toStateSnapshot(existingRow) };
  }

  getDb()
    .prepare(`DELETE FROM talk_state_entries WHERE id = ? AND version = ?`)
    .run(existingRow.id, input.expectedVersion);

  return { ok: true, deleted: true };
}

export function forceDeleteTalkStateEntry(
  talkId: string,
  key: string,
): boolean {
  const validatedKey = validateStateKey(key);
  const result = getDb()
    .prepare(`DELETE FROM talk_state_entries WHERE talk_id = ? AND key = ?`)
    .run(talkId, validatedKey);
  return result.changes > 0;
}

export function forceDeleteTalkStateEntriesByPrefix(
  talkId: string,
  prefix: string,
): number {
  const validatedPrefix = validateStateKey(prefix);
  const result = getDb()
    .prepare(
      `DELETE FROM talk_state_entries WHERE talk_id = ? AND key LIKE ? ESCAPE '\\'`,
    )
    .run(talkId, `${validatedPrefix.replace(/[\\%_]/g, '\\$&')}%`);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Source ref counter
// ---------------------------------------------------------------------------

function allocateSourceRef(talkId: string): string {
  const row = getDb()
    .prepare(
      `SELECT next_ref_number FROM talk_context_source_ref_counter WHERE talk_id = ?`,
    )
    .get(talkId) as { next_ref_number: number } | undefined;

  const nextNumber = row?.next_ref_number ?? 1;

  getDb()
    .prepare(
      `
      INSERT INTO talk_context_source_ref_counter (talk_id, next_ref_number)
      VALUES (?, ?)
      ON CONFLICT(talk_id) DO UPDATE SET
        next_ref_number = excluded.next_ref_number
    `,
    )
    .run(talkId, nextNumber + 1);

  return `S${nextNumber}`;
}

// ---------------------------------------------------------------------------
// Source accessors
// ---------------------------------------------------------------------------

export function listTalkContextSources(
  talkId: string,
): ContextSourceSnapshot[] {
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM talk_context_sources
      WHERE talk_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `,
    )
    .all(talkId) as TalkContextSourceRecord[];
  return rows.map(toSourceSnapshot);
}

export function getTalkContextSourceCount(talkId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM talk_context_sources WHERE talk_id = ?`,
    )
    .get(talkId) as { count: number };
  return row.count;
}

export function getTalkContextSourceById(
  sourceId: string,
  talkId: string,
): ContextSourceSnapshot | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM talk_context_sources WHERE id = ? AND talk_id = ?`)
    .get(sourceId, talkId) as TalkContextSourceRecord | undefined;
  return row ? toSourceSnapshot(row) : undefined;
}

export function getTalkContextSourceByRef(
  sourceRef: string,
  talkId: string,
): ContextSourceWithContent | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM talk_context_sources WHERE source_ref = ? AND talk_id = ?`,
    )
    .get(sourceRef, talkId) as TalkContextSourceRecord | undefined;
  return row ? toSourceWithContent(row) : undefined;
}

export function createTalkContextSource(input: {
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
}): ContextSourceSnapshot {
  const count = getTalkContextSourceCount(input.talkId);
  if (count >= 20) {
    throw new Error('Maximum 20 saved sources per talk');
  }

  const id = randomUUID();
  const sourceRef = allocateSourceRef(input.talkId);
  const now = new Date().toISOString();
  const title = input.title.trim();
  if (!title) throw new Error('Source title is required');

  // Determine initial status
  let status: ContextSourceStatus = 'pending';
  let extractedText: string | null = null;
  let isTruncated = 0;
  let extractedAt: string | null = null;

  if (input.sourceType === 'text' || input.sourceType === 'file') {
    // Text and file sources with provided content are immediately ready
    extractedText = input.extractedText ?? null;
    if (extractedText !== null) {
      if (extractedText.length > 50_000) {
        extractedText = extractedText.slice(0, 50_000);
        isTruncated = 1;
      }
      status = 'ready';
      extractedAt = now;
    } else if (input.sourceType === 'file') {
      status = input.extractionError ? 'failed' : 'ready';
      extractedAt = now;
    }
  }

  // Insert at end
  const maxOrder = getDb()
    .prepare(
      `SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM talk_context_sources WHERE talk_id = ?`,
    )
    .get(input.talkId) as { max_order: number };

  getDb()
    .prepare(
      `
      INSERT INTO talk_context_sources (
        id, talk_id, source_ref, source_type, title, note,
        sort_order, status, source_url, file_name, file_size,
        mime_type, storage_key, extracted_text, extracted_at,
        last_fetched_at, extraction_error, fetch_strategy, is_truncated,
        created_at, updated_at, created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?)
    `,
    )
    .run(
      id,
      input.talkId,
      sourceRef,
      input.sourceType,
      title,
      input.note?.trim() || null,
      maxOrder.max_order + 1,
      status,
      input.sourceUrl ?? null,
      input.fileName ?? null,
      input.fileSize ?? null,
      input.mimeType ?? null,
      input.storageKey ?? null,
      extractedText,
      extractedAt,
      input.extractionError ?? null,
      isTruncated,
      now,
      now,
      input.createdBy,
    );

  const row = getDb()
    .prepare(`SELECT * FROM talk_context_sources WHERE id = ?`)
    .get(id) as TalkContextSourceRecord;
  return toSourceSnapshot(row);
}

export function patchTalkContextSource(input: {
  sourceId: string;
  talkId: string;
  title?: string;
  note?: string | null;
  sortOrder?: number;
  extractedText?: string | null;
}): ContextSourceSnapshot | undefined {
  const existing = getDb()
    .prepare(`SELECT * FROM talk_context_sources WHERE id = ? AND talk_id = ?`)
    .get(input.sourceId, input.talkId) as TalkContextSourceRecord | undefined;
  if (!existing) return undefined;

  const now = new Date().toISOString();
  let nextTitle = existing.title;
  let nextNote = existing.note;
  let nextOrder = existing.sort_order;

  if (input.title !== undefined) {
    nextTitle = input.title.trim();
    if (!nextTitle) throw new Error('Source title is required');
  }
  if (input.note !== undefined) {
    nextNote = input.note?.trim() || null;
  }
  if (input.sortOrder !== undefined) {
    nextOrder = input.sortOrder;
  }

  // For text sources, allow inline content editing
  if (input.extractedText !== undefined && existing.source_type === 'text') {
    let text = input.extractedText;
    let isTruncated = 0;
    if (text && text.length > 50_000) {
      text = text.slice(0, 50_000);
      isTruncated = 1;
    }
    getDb()
      .prepare(
        `
        UPDATE talk_context_sources
        SET title = ?, note = ?, sort_order = ?, extracted_text = ?,
            extracted_at = ?, is_truncated = ?, status = 'ready', updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        nextTitle,
        nextNote,
        nextOrder,
        text,
        now,
        isTruncated,
        now,
        input.sourceId,
      );
  } else {
    getDb()
      .prepare(
        `
        UPDATE talk_context_sources
        SET title = ?, note = ?, sort_order = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(nextTitle, nextNote, nextOrder, now, input.sourceId);
  }

  const row = getDb()
    .prepare(`SELECT * FROM talk_context_sources WHERE id = ?`)
    .get(input.sourceId) as TalkContextSourceRecord;
  return toSourceSnapshot(row);
}

export function updateSourceExtraction(input: {
  sourceId: string;
  extractedText: string | null;
  extractionError: string | null;
  mimeType?: string | null;
  fetchStrategy?: ContextSourceFetchStrategy | null;
  fetchedAt?: string | null;
}): void {
  const now = new Date().toISOString();
  const fetchedAt = input.fetchedAt ?? now;

  if (input.extractionError) {
    // Failed extraction — keep last-good content if it exists
    getDb()
      .prepare(
        `
        UPDATE talk_context_sources
        SET extraction_error = ?,
            last_fetched_at = ?,
            fetch_strategy = COALESCE(?, fetch_strategy),
            status = CASE WHEN extracted_text IS NOT NULL THEN status ELSE 'failed' END,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        input.extractionError,
        fetchedAt,
        input.fetchStrategy ?? null,
        now,
        input.sourceId,
      );
    return;
  }

  let text = input.extractedText;
  let isTruncated = 0;
  if (text && text.length > 50_000) {
    text = text.slice(0, 50_000);
    isTruncated = 1;
  }

  getDb()
    .prepare(
      `
      UPDATE talk_context_sources
      SET extracted_text = ?,
          extracted_at = ?,
          last_fetched_at = ?,
          extraction_error = NULL,
          fetch_strategy = COALESCE(?, fetch_strategy),
          is_truncated = ?,
          status = 'ready',
          mime_type = COALESCE(?, mime_type),
          updated_at = ?
      WHERE id = ?
      `,
    )
    .run(
      text,
      now,
      fetchedAt,
      input.fetchStrategy ?? null,
      isTruncated,
      input.mimeType ?? null,
      now,
      input.sourceId,
    );
}

export function markTalkContextSourcePending(
  sourceId: string,
  talkId: string,
): ContextSourceSnapshot | undefined {
  const existing = getDb()
    .prepare(`SELECT * FROM talk_context_sources WHERE id = ? AND talk_id = ?`)
    .get(sourceId, talkId) as TalkContextSourceRecord | undefined;
  if (!existing) return undefined;

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE talk_context_sources
      SET status = 'pending',
          extraction_error = NULL,
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(now, sourceId);

  const row = getDb()
    .prepare(`SELECT * FROM talk_context_sources WHERE id = ?`)
    .get(sourceId) as TalkContextSourceRecord;
  return toSourceSnapshot(row);
}

export function getContextSourceWithContent(
  sourceId: string,
  talkId: string,
): ContextSourceWithContent | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM talk_context_sources WHERE id = ? AND talk_id = ?`)
    .get(sourceId, talkId) as TalkContextSourceRecord | undefined;
  return row ? toSourceWithContent(row) : undefined;
}

export function getContextSourceStorageKey(
  sourceId: string,
  talkId: string,
): string | null {
  const row = getDb()
    .prepare(
      `SELECT storage_key FROM talk_context_sources WHERE id = ? AND talk_id = ?`,
    )
    .get(sourceId, talkId) as { storage_key: string | null } | undefined;
  return row?.storage_key ?? null;
}

export function deleteTalkContextSource(
  sourceId: string,
  talkId: string,
): boolean {
  const result = getDb()
    .prepare(`DELETE FROM talk_context_sources WHERE id = ? AND talk_id = ?`)
    .run(sourceId, talkId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Message attachment types
// ---------------------------------------------------------------------------

export type AttachmentExtractionStatus = 'pending' | 'ready' | 'failed';

export interface MessageAttachmentRecord {
  id: string;
  message_id: string | null;
  talk_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
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
  fileSize: number;
  mimeType: string;
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

// ---------------------------------------------------------------------------
// Message attachment accessors
// ---------------------------------------------------------------------------

export function createMessageAttachment(input: {
  id: string;
  talkId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  storageKey: string;
  createdBy: string;
}): AttachmentSnapshot {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO talk_message_attachments (
        id, message_id, talk_id, file_name, file_size,
        mime_type, storage_key, extraction_status, created_at, created_by
      )
      VALUES (?, NULL, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `,
    )
    .run(
      input.id,
      input.talkId,
      input.fileName,
      input.fileSize,
      input.mimeType,
      input.storageKey,
      now,
      input.createdBy,
    );

  const row = getDb()
    .prepare(`SELECT * FROM talk_message_attachments WHERE id = ?`)
    .get(input.id) as MessageAttachmentRecord;
  return toAttachmentSnapshot(row);
}

export function linkAttachmentToMessage(
  attachmentId: string,
  messageId: string,
  talkId: string,
): boolean {
  const result = getDb()
    .prepare(
      `
      UPDATE talk_message_attachments
      SET message_id = ?
      WHERE id = ? AND talk_id = ? AND message_id IS NULL
    `,
    )
    .run(messageId, attachmentId, talkId);
  return result.changes > 0;
}

export function listMessageAttachments(
  messageId: string,
): AttachmentSnapshot[] {
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM talk_message_attachments
      WHERE message_id = ?
      ORDER BY created_at ASC
    `,
    )
    .all(messageId) as MessageAttachmentRecord[];
  return rows.map(toAttachmentSnapshot);
}

export function listMessageAttachmentRecords(
  messageId: string,
): MessageAttachmentRecord[] {
  return getDb()
    .prepare(
      `
      SELECT * FROM talk_message_attachments
      WHERE message_id = ?
      ORDER BY created_at ASC
    `,
    )
    .all(messageId) as MessageAttachmentRecord[];
}

export function listTalkAttachments(talkId: string): AttachmentSnapshot[] {
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM talk_message_attachments
      WHERE talk_id = ? AND message_id IS NOT NULL
      ORDER BY created_at ASC
    `,
    )
    .all(talkId) as MessageAttachmentRecord[];
  return rows.map(toAttachmentSnapshot);
}

export function getMessageAttachmentById(
  attachmentId: string,
  talkId: string,
): MessageAttachmentRecord | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM talk_message_attachments WHERE id = ? AND talk_id = ?`,
    )
    .get(attachmentId, talkId) as MessageAttachmentRecord | undefined;
  return row ?? null;
}

export function updateAttachmentExtraction(input: {
  attachmentId: string;
  extractedText?: string | null;
  extractionError?: string | null;
  extractionStatus: 'ready' | 'failed';
}): void {
  let text = input.extractedText ?? null;
  if (text && text.length > 50_000) {
    text = text.slice(0, 50_000);
  }

  getDb()
    .prepare(
      `
      UPDATE talk_message_attachments
      SET extracted_text = ?,
          extraction_error = ?,
          extraction_status = ?
      WHERE id = ?
    `,
    )
    .run(
      text,
      input.extractionError ?? null,
      input.extractionStatus,
      input.attachmentId,
    );
}

export function deleteUnlinkedAttachments(
  talkId: string,
  olderThanIso: string,
): number {
  const result = getDb()
    .prepare(
      `
      DELETE FROM talk_message_attachments
      WHERE talk_id = ? AND message_id IS NULL AND created_at < ?
    `,
    )
    .run(talkId, olderThanIso);
  return result.changes;
}

/**
 * Delete orphan attachments across ALL talks that were uploaded but never
 * linked to a message. Returns the storage keys of deleted rows so the
 * caller can remove the corresponding files from disk.
 *
 * Uses DELETE ... RETURNING so the key collection and row deletion are a
 * single atomic statement — no race with a concurrent link operation.
 */
export function pruneOrphanAttachments(olderThanIso: string): {
  count: number;
  storageKeys: string[];
} {
  const deleted = getDb()
    .prepare(
      `
      DELETE FROM talk_message_attachments
      WHERE message_id IS NULL AND created_at < ?
      RETURNING storage_key
    `,
    )
    .all(olderThanIso) as Array<{ storage_key: string }>;

  return {
    count: deleted.length,
    storageKeys: deleted.map((r) => r.storage_key),
  };
}

export function listMessageAttachmentsForPrompt(messageId: string): Array<{
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  extractedText: string | null;
  extractionStatus: AttachmentExtractionStatus;
}> {
  const rows = getDb()
    .prepare(
      `
      SELECT id, file_name, mime_type, file_size, extracted_text, extraction_status
      FROM talk_message_attachments
      WHERE message_id = ?
      ORDER BY created_at ASC
    `,
    )
    .all(messageId) as Array<{
    id: string;
    file_name: string;
    mime_type: string;
    file_size: number;
    extracted_text: string | null;
    extraction_status: AttachmentExtractionStatus;
  }>;
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
// Full context snapshot (for the GET /context endpoint)
// ---------------------------------------------------------------------------

export function getTalkContext(talkId: string): TalkContextSnapshot {
  return {
    goal: getTalkGoal(talkId),
    rules: listTalkContextRules(talkId),
    sources: listTalkContextSources(talkId),
  };
}

// ---------------------------------------------------------------------------
// Prompt assembly helpers — used by context-assembler, not by API routes
// ---------------------------------------------------------------------------

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

export function getTalkContextForPrompt(talkId: string): TalkContextForPrompt {
  const goal = getTalkGoal(talkId);

  const rules = getDb()
    .prepare(
      `
      SELECT rule_text
      FROM talk_context_rules
      WHERE talk_id = ? AND is_active = 1
      ORDER BY sort_order ASC, created_at ASC
    `,
    )
    .all(talkId) as Array<{ rule_text: string }>;

  const sources = getDb()
    .prepare(
      `
      SELECT source_ref, source_type, title, note, status, extracted_text, sort_order
      FROM talk_context_sources
      WHERE talk_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `,
    )
    .all(talkId) as Array<{
    source_ref: string;
    source_type: ContextSourceType;
    title: string;
    note: string | null;
    status: ContextSourceStatus;
    extracted_text: string | null;
    sort_order: number;
  }>;

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
