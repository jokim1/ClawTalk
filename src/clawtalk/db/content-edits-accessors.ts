// Typed accessors for the `content_edits` table (edit-log architecture
// per Section B of ~/.claude/plans/silly-gathering-charm.md).
//
// content_edits is the staging table for pending agent edits. body_markdown
// stays immutable until Accept; renderers compose body + pending edits via
// `composeBody` in the shared rich-text module. Accept materializes the
// edit into body_markdown + deletes the row (one CAS bump per call).
// Reject just deletes the row (no version bump — body wasn't touched).
//
// Caller contract: every function must run inside a
// `withUserContext(userId, ...)` block. RLS gates by the content's
// owner_id (see migration 0028).
//
// NOTE — this module references the `content_edits` table BY NAME. The
// table itself is created in commit 8 of the redesign single-PR. Until
// then, runtime tests are skipped (`it.skip`) — only typecheck is
// guaranteed green on commits 2-7. See plan Section H commit ordering.

import { getDbPg } from '../../db.js';
import {
  type ContentEditRow,
  type ContentEditKind,
  materializeEdits,
  computeAnchorMap,
  ensureAnchorIds,
  tiptapJsonToMarkdown,
  sanitizeMarkdown,
  sanitizeRichTextDocument,
  markdownToTiptapJson,
  stripAnchorCommentsFromMarkdown,
} from '../../shared/rich-text/index.js';
import { CONTENT_BODY_BYTE_LIMIT, type Content } from './content-accessors.js';
import { emitOutboxEvent } from '../talks/outbox-emit.js';

// ── Row shape (DB → TS) ───────────────────────────────────────────────

export interface ContentEditRecord {
  id: string;
  content_id: string;
  run_id: string;
  agent_id: string | null;
  agent_nickname: string | null;
  message_id: string | null;
  kind: ContentEditKind;
  base_content_version: number;
  target_anchor_id: string | null;
  new_markdown: string | null;
  new_html: string | null;
  rationale: string | null;
  created_at: string;
}

const EDIT_COLUMNS = `
  id, content_id, run_id, agent_id, agent_nickname,
  message_id, kind, base_content_version,
  target_anchor_id, new_markdown, new_html, rationale, created_at
`;

function toContentEdit(row: ContentEditRecord): ContentEditRow {
  return {
    id: row.id,
    contentId: row.content_id,
    runId: row.run_id,
    agentId: row.agent_id,
    agentNickname: row.agent_nickname,
    messageId: row.message_id,
    kind: row.kind,
    baseContentVersion: row.base_content_version,
    targetAnchorId: row.target_anchor_id,
    newMarkdown: row.new_markdown,
    newHtml: row.new_html ?? null,
    rationale: row.rationale,
    createdAt: row.created_at,
  };
}

interface ContentRecord {
  id: string;
  owner_id: string;
  talk_id: string;
  thread_id: string;
  body_markdown: string;
  body_html: string | null;
  body_version: number;
}

const CONTENT_MIN_COLUMNS = `
  id, owner_id, talk_id, thread_id, body_markdown, body_html, body_version
`;

// Loaded from content-accessors.ts to mirror its full toContent shape
// without circular imports — only used for the return value of the
// accept paths.
interface FullContentRecord extends ContentRecord {
  title: string;
  content_kind: string;
  content_format: 'markdown' | 'html';
  anchor_map_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  updated_by_run_id: string | null;
}

function rowToContent(row: FullContentRecord): Content {
  return {
    id: row.id,
    ownerId: row.owner_id,
    talkId: row.talk_id,
    threadId: row.thread_id,
    title: row.title,
    contentKind: row.content_kind,
    contentFormat: row.content_format,
    bodyMarkdown: row.body_markdown,
    bodyHtml: row.body_html,
    bodyVersion: row.body_version,
    anchorMap: (row.anchor_map_json ?? {}) as Content['anchorMap'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    updatedByRunId: row.updated_by_run_id,
  };
}

function byteLengthOf(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// ── Read ──────────────────────────────────────────────────────────────

export async function getPendingEditsByContent(
  contentId: string,
): Promise<ContentEditRow[]> {
  const db = getDbPg();
  const rows = await db<ContentEditRecord[]>`
    select ${db.unsafe(EDIT_COLUMNS)}
    from public.content_edits
    where content_id = ${contentId}::uuid
    order by created_at asc, id asc
  `;
  return rows.map(toContentEdit);
}

export async function getPendingEditById(
  editId: string,
): Promise<ContentEditRow | null> {
  const db = getDbPg();
  const rows = await db<ContentEditRecord[]>`
    select ${db.unsafe(EDIT_COLUMNS)}
    from public.content_edits
    where id = ${editId}::uuid
    limit 1
  `;
  return rows[0] ? toContentEdit(rows[0]) : null;
}

// ── Insert (apply) ────────────────────────────────────────────────────

export interface InsertPendingEditInput {
  contentId: string;
  runId: string;
  agentId: string | null;
  agentNickname: string | null;
  messageId: string | null;
  kind: ContentEditKind;
  baseContentVersion: number;
  targetAnchorId: string | null;
  newMarkdown: string | null;
  // Optional; populated by the apply handler for HTML-format docs.
  // Exactly one of newMarkdown / newHtml is non-null per row except
  // kind='delete' (both null) — the DB CHECK enforces it.
  newHtml?: string | null;
  rationale: string | null;
}

export async function insertPendingEdit(
  input: InsertPendingEditInput,
): Promise<ContentEditRow> {
  const db = getDbPg();
  const rows = await db<ContentEditRecord[]>`
    insert into public.content_edits
      (content_id, run_id, agent_id, agent_nickname, message_id,
       kind, base_content_version, target_anchor_id,
       new_markdown, new_html, rationale)
    values
      (${input.contentId}::uuid, ${input.runId},
       ${input.agentId}::uuid, ${input.agentNickname},
       ${input.messageId}::uuid, ${input.kind},
       ${input.baseContentVersion}, ${input.targetAnchorId},
       ${input.newMarkdown}, ${input.newHtml ?? null}, ${input.rationale})
    returning ${db.unsafe(EDIT_COLUMNS)}
  `;
  return toContentEdit(rows[0]);
}

export async function updatePendingEdit(input: {
  editId: string;
  kind: ContentEditKind;
  targetAnchorId: string | null;
  newMarkdown: string | null;
  newHtml?: string | null;
  rationale: string | null;
}): Promise<ContentEditRow | null> {
  const db = getDbPg();
  const rows = await db<ContentEditRecord[]>`
    update public.content_edits
    set kind = ${input.kind},
        target_anchor_id = ${input.targetAnchorId},
        new_markdown = ${input.newMarkdown},
        new_html = ${input.newHtml ?? null},
        rationale = ${input.rationale}
    where id = ${input.editId}::uuid
    returning ${db.unsafe(EDIT_COLUMNS)}
  `;
  return rows[0] ? toContentEdit(rows[0]) : null;
}

export async function deletePendingEdit(editId: string): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    delete from public.content_edits
    where id = ${editId}::uuid
    returning id
  `;
  return rows.length > 0;
}

export async function deletePendingEditsByRun(input: {
  contentId: string;
  runId: string;
}): Promise<string[]> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    delete from public.content_edits
    where content_id = ${input.contentId}::uuid
      and run_id = ${input.runId}
    returning id
  `;
  return rows.map((r) => r.id);
}

// ── Accept / Reject ───────────────────────────────────────────────────

export type AcceptPendingEditResult =
  | { kind: 'ok'; content: Content; editId: string; runId: string }
  | { kind: 'not_found' }
  | { kind: 'version_conflict'; currentVersion: number }
  | { kind: 'doc_size_limit'; wouldBeBytes: number }
  | { kind: 'anchor_missing'; anchorId: string };

/**
 * Materialize a single pending edit into body_markdown and delete the
 * row. CAS-bumped on body_version. No-op if the row is already gone
 * (sibling auto-accept may have cleared it).
 */
export async function acceptPendingEdit(input: {
  editId: string;
  userId: string;
  expectedContentVersion?: number;
}): Promise<AcceptPendingEditResult> {
  const db = getDbPg();

  const editRows = await db<ContentEditRecord[]>`
    select ${db.unsafe(EDIT_COLUMNS)}
    from public.content_edits
    where id = ${input.editId}::uuid
    limit 1
  `;
  const editRow = editRows[0];
  if (!editRow) return { kind: 'not_found' };
  const edit = toContentEdit(editRow);

  const contentRows = await db<FullContentRecord[]>`
    select ${db.unsafe(CONTENT_MIN_COLUMNS)},
           title, content_kind, content_format, anchor_map_json,
           created_at, updated_at, created_by_user_id,
           updated_by_user_id, updated_by_run_id
    from public.contents
    where id = ${edit.contentId}::uuid
    limit 1
  `;
  const content = contentRows[0];
  if (!content) return { kind: 'not_found' };

  if (
    input.expectedContentVersion !== undefined &&
    content.body_version !== input.expectedContentVersion
  ) {
    return {
      kind: 'version_conflict',
      currentVersion: content.body_version,
    };
  }

  const sanitized = sanitizePendingEdit(edit);
  if (sanitized === null) {
    // Empty after sanitize — treat as a silent reject (drop the row).
    await db`
      delete from public.content_edits where id = ${edit.id}::uuid
    `;
    return { kind: 'not_found' };
  }

  // Materialize the single edit into the body doc.
  const nextDoc = ensureAnchorIds(
    materializeEdits(content.body_markdown, [sanitized]),
  );
  const nextMarkdown = tiptapJsonToMarkdown(nextDoc);
  if (byteLengthOf(nextMarkdown) > CONTENT_BODY_BYTE_LIMIT) {
    return {
      kind: 'doc_size_limit',
      wouldBeBytes: byteLengthOf(nextMarkdown),
    };
  }
  const nextAnchorMap = await computeAnchorMap(nextDoc);

  const updatedRows = await db<FullContentRecord[]>`
    update public.contents
    set body_markdown = ${nextMarkdown},
        body_version = body_version + 1,
        anchor_map_json = ${db.json(nextAnchorMap as never)},
        updated_at = now(),
        updated_by_user_id = ${input.userId}::uuid,
        updated_by_run_id = null
    where id = ${content.id}::uuid
      and body_version = ${content.body_version}
    returning ${db.unsafe(CONTENT_MIN_COLUMNS)},
              title, content_kind, content_format, anchor_map_json,
              created_at, updated_at, created_by_user_id,
              updated_by_user_id, updated_by_run_id
  `;
  const updated = updatedRows[0];
  if (!updated) {
    const refetch = await db<{ body_version: number }[]>`
      select body_version from public.contents where id = ${content.id}::uuid
    `;
    return {
      kind: 'version_conflict',
      currentVersion: refetch[0]?.body_version ?? content.body_version,
    };
  }

  await db`
    delete from public.content_edits where id = ${edit.id}::uuid
  `;

  await emitOutboxEvent({
    topic: `talk:${updated.talk_id}`,
    eventType: 'content_edit_resolved',
    payload: {
      contentId: updated.id,
      runId: edit.runId,
      editIds: [edit.id],
      resolution: 'accepted',
      version: updated.body_version,
    },
    ownerIds: [updated.owner_id],
  });
  await emitOutboxEvent({
    topic: `talk:${updated.talk_id}`,
    eventType: 'content_updated',
    payload: {
      contentId: updated.id,
      version: updated.body_version,
      appliedAnchorIds: [],
    },
    ownerIds: [updated.owner_id],
  });

  return {
    kind: 'ok',
    content: rowToContent(updated),
    editId: edit.id,
    runId: edit.runId,
  };
}

export type RejectPendingEditResult =
  | { kind: 'ok'; editId: string; runId: string }
  | { kind: 'not_found' };

/**
 * Delete a single pending edit row without touching body_markdown. No
 * version bump (body unchanged).
 */
export async function rejectPendingEdit(input: {
  editId: string;
  userId: string;
}): Promise<RejectPendingEditResult> {
  const db = getDbPg();
  const editRows = await db<ContentEditRecord[]>`
    select ${db.unsafe(EDIT_COLUMNS)}
    from public.content_edits
    where id = ${input.editId}::uuid
    limit 1
  `;
  const editRow = editRows[0];
  if (!editRow) return { kind: 'not_found' };
  const edit = toContentEdit(editRow);

  const contentRows = await db<{ owner_id: string; talk_id: string }[]>`
    select owner_id, talk_id
    from public.contents
    where id = ${edit.contentId}::uuid
    limit 1
  `;
  const content = contentRows[0];
  if (!content) return { kind: 'not_found' };

  const deleted = await db<{ id: string }[]>`
    delete from public.content_edits
    where id = ${edit.id}::uuid
    returning id
  `;
  if (deleted.length === 0) return { kind: 'not_found' };

  await emitOutboxEvent({
    topic: `talk:${content.talk_id}`,
    eventType: 'content_edit_resolved',
    payload: {
      contentId: edit.contentId,
      runId: edit.runId,
      editIds: [edit.id],
      resolution: 'rejected',
    },
    ownerIds: [content.owner_id],
  });

  return { kind: 'ok', editId: edit.id, runId: edit.runId };
}

export type AcceptPendingRunResult =
  | {
      kind: 'ok';
      content: Content;
      runId: string;
      editIds: string[];
    }
  | { kind: 'not_found' }
  | { kind: 'version_conflict'; currentVersion: number }
  | { kind: 'doc_size_limit'; wouldBeBytes: number };

/**
 * Materialize ALL pending edits for a run into body_markdown (in
 * created_at order) and delete the rows. Single CAS bump for the entire
 * run. Empty run (no rows for that runId) returns not_found.
 */
export async function acceptPendingRun(input: {
  contentId: string;
  runId: string;
  userId: string;
  expectedContentVersion?: number;
}): Promise<AcceptPendingRunResult> {
  const db = getDbPg();

  const editRows = await db<ContentEditRecord[]>`
    select ${db.unsafe(EDIT_COLUMNS)}
    from public.content_edits
    where content_id = ${input.contentId}::uuid
      and run_id = ${input.runId}
    order by created_at asc, id asc
  `;
  if (editRows.length === 0) return { kind: 'not_found' };
  const edits = editRows.map(toContentEdit);

  const contentRows = await db<FullContentRecord[]>`
    select ${db.unsafe(CONTENT_MIN_COLUMNS)},
           title, content_kind, content_format, anchor_map_json,
           created_at, updated_at, created_by_user_id,
           updated_by_user_id, updated_by_run_id
    from public.contents
    where id = ${input.contentId}::uuid
    limit 1
  `;
  const content = contentRows[0];
  if (!content) return { kind: 'not_found' };

  if (
    input.expectedContentVersion !== undefined &&
    content.body_version !== input.expectedContentVersion
  ) {
    return {
      kind: 'version_conflict',
      currentVersion: content.body_version,
    };
  }

  const sanitizedEdits = edits
    .map(sanitizePendingEdit)
    .filter((e): e is ContentEditRow => e !== null);

  const nextDoc = ensureAnchorIds(
    materializeEdits(content.body_markdown, sanitizedEdits),
  );
  const nextMarkdown = tiptapJsonToMarkdown(nextDoc);
  if (byteLengthOf(nextMarkdown) > CONTENT_BODY_BYTE_LIMIT) {
    return {
      kind: 'doc_size_limit',
      wouldBeBytes: byteLengthOf(nextMarkdown),
    };
  }
  const nextAnchorMap = await computeAnchorMap(nextDoc);

  const updatedRows = await db<FullContentRecord[]>`
    update public.contents
    set body_markdown = ${nextMarkdown},
        body_version = body_version + 1,
        anchor_map_json = ${db.json(nextAnchorMap as never)},
        updated_at = now(),
        updated_by_user_id = ${input.userId}::uuid,
        updated_by_run_id = null
    where id = ${content.id}::uuid
      and body_version = ${content.body_version}
    returning ${db.unsafe(CONTENT_MIN_COLUMNS)},
              title, content_kind, content_format, anchor_map_json,
              created_at, updated_at, created_by_user_id,
              updated_by_user_id, updated_by_run_id
  `;
  const updated = updatedRows[0];
  if (!updated) {
    const refetch = await db<{ body_version: number }[]>`
      select body_version from public.contents where id = ${content.id}::uuid
    `;
    return {
      kind: 'version_conflict',
      currentVersion: refetch[0]?.body_version ?? content.body_version,
    };
  }

  await db`
    delete from public.content_edits
    where content_id = ${input.contentId}::uuid
      and run_id = ${input.runId}
  `;

  const editIds = edits.map((e) => e.id);
  await emitOutboxEvent({
    topic: `talk:${updated.talk_id}`,
    eventType: 'content_edit_resolved',
    payload: {
      contentId: updated.id,
      runId: input.runId,
      editIds,
      resolution: 'accepted',
      version: updated.body_version,
    },
    ownerIds: [updated.owner_id],
  });
  await emitOutboxEvent({
    topic: `talk:${updated.talk_id}`,
    eventType: 'content_updated',
    payload: {
      contentId: updated.id,
      version: updated.body_version,
      appliedAnchorIds: [],
    },
    ownerIds: [updated.owner_id],
  });

  return {
    kind: 'ok',
    content: rowToContent(updated),
    runId: input.runId,
    editIds,
  };
}

export type RejectPendingRunResult =
  | { kind: 'ok'; runId: string; editIds: string[] }
  | { kind: 'not_found' };

/**
 * Delete all pending edits for a run without touching body_markdown.
 * No CAS bump.
 */
export async function rejectPendingRun(input: {
  contentId: string;
  runId: string;
  userId: string;
}): Promise<RejectPendingRunResult> {
  const db = getDbPg();

  const contentRows = await db<{ owner_id: string; talk_id: string }[]>`
    select owner_id, talk_id
    from public.contents
    where id = ${input.contentId}::uuid
    limit 1
  `;
  const content = contentRows[0];
  if (!content) return { kind: 'not_found' };

  const deleted = await db<{ id: string }[]>`
    delete from public.content_edits
    where content_id = ${input.contentId}::uuid
      and run_id = ${input.runId}
    returning id
  `;
  if (deleted.length === 0) return { kind: 'not_found' };

  const editIds = deleted.map((r) => r.id);
  await emitOutboxEvent({
    topic: `talk:${content.talk_id}`,
    eventType: 'content_edit_resolved',
    payload: {
      contentId: input.contentId,
      runId: input.runId,
      editIds,
      resolution: 'rejected',
    },
    ownerIds: [content.owner_id],
  });

  return { kind: 'ok', runId: input.runId, editIds };
}

// ── Internal: sanitize agent-supplied markdown on accept ──────────────

/**
 * The agent's markdown was already sanitized by `applyContentEdit`
 * before insert, but re-strip + re-sanitize here in case anything else
 * managed to insert a row by hand. Returns null if the edit reduces to
 * nothing (empty body / empty payload) — caller treats that as a silent
 * row-drop.
 */
function sanitizePendingEdit(edit: ContentEditRow): ContentEditRow | null {
  if (edit.kind === 'delete') return edit;
  if (edit.newMarkdown === null) return null;

  const stripped = stripAnchorCommentsFromMarkdown(edit.newMarkdown);
  const sanitized = sanitizeMarkdown(stripped);
  const parsed = sanitizeRichTextDocument(markdownToTiptapJson(sanitized));
  if (parsed.content.length === 0) return null;

  return { ...edit, newMarkdown: sanitized };
}

// ── Re-exports for convenience ────────────────────────────────────────

export { materializeEdits };
