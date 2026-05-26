// Content feature — typed accessors for the `contents` and
// `content_proposals` tables.
//
// Caller contract: every function below must run inside a
// `withUserContext(userId, ...)` block. RLS on both tables gates by
// `owner_id = auth.uid()`; the surrounding `withRequestScopedDb`
// scope opens the notify queue so outbox emits get flushed
// post-commit.
//
// The accept/update paths route the body through the shared
// `src/shared/rich-text/` module: markdown → Tiptap JSON → AST
// mutation → markdown. The anchor map is recomputed from the
// resulting JSON; the body and the map always ship together.

import { getDbPg } from '../../db.js';
import {
  type AnchorMap,
  type RichTextDocument,
  type RichTextNode,
  computeAnchorMap,
  ensureAnchorIds,
  markdownToTiptapJson,
  plainTextOf,
  sanitizeMarkdown,
  sanitizeRichTextDocument,
  tiptapJsonToMarkdown,
} from '../../shared/rich-text/index.js';
import { emitOutboxEvent } from '../talks/outbox-emit.js';

export const CONTENT_BODY_BYTE_LIMIT = 512_000;

export interface ContentRecord {
  id: string;
  owner_id: string;
  talk_id: string;
  title: string;
  content_kind: string;
  content_format: string;
  body_markdown: string;
  body_version: number;
  anchor_map_json: AnchorMap;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  updated_by_run_id: string | null;
}

export interface Content {
  id: string;
  ownerId: string;
  talkId: string;
  title: string;
  contentKind: string;
  contentFormat: string;
  bodyMarkdown: string;
  bodyVersion: number;
  anchorMap: AnchorMap;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  updatedByRunId: string | null;
}

function toContent(row: ContentRecord): Content {
  return {
    id: row.id,
    ownerId: row.owner_id,
    talkId: row.talk_id,
    title: row.title,
    contentKind: row.content_kind,
    contentFormat: row.content_format,
    bodyMarkdown: row.body_markdown,
    bodyVersion: row.body_version,
    anchorMap: row.anchor_map_json ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    updatedByRunId: row.updated_by_run_id,
  };
}

function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new Error('Content title is required');
  return trimmed;
}

function byteLengthOf(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function nodeIsEmpty(node: RichTextNode | undefined): boolean {
  if (!node) return true;
  const text = plainTextOf(node).trim();
  if (text.length > 0) return false;
  // hr / empty paragraph after sanitize still counts as a real block if
  // structurally distinct, but for our "no-op proposal" guard we treat
  // a doc whose blocks all produce no plain text as empty.
  return true;
}

function documentIsEmpty(doc: RichTextDocument): boolean {
  const blocks = doc.content ?? [];
  if (blocks.length === 0) return true;
  return blocks.every(nodeIsEmpty);
}

// ── content CRUD ─────────────────────────────────────────────────

export async function createContent(input: {
  ownerId: string;
  talkId: string;
  title: string;
  createdByUserId?: string | null;
}): Promise<Content> {
  const title = normalizeTitle(input.title);
  const db = getDbPg();
  const rows = await db<ContentRecord[]>`
    insert into public.contents
      (owner_id, talk_id, title, content_kind, content_format,
       body_markdown, body_version, anchor_map_json,
       created_by_user_id, updated_by_user_id, updated_by_run_id)
    values
      (${input.ownerId}::uuid, ${input.talkId}::uuid, ${title},
       'document', 'markdown',
       '', 1, '{}'::jsonb,
       ${input.createdByUserId ?? null}::uuid,
       ${input.createdByUserId ?? null}::uuid,
       null)
    returning id, owner_id, talk_id, title, content_kind, content_format,
              body_markdown, body_version, anchor_map_json,
              created_at, updated_at,
              created_by_user_id, updated_by_user_id, updated_by_run_id
  `;
  return toContent(rows[0]);
}

export interface ContentSidebarRecord {
  id: string;
  talk_id: string;
  title: string;
  updated_at: string;
}

export async function listContentsForSidebar(): Promise<
  ContentSidebarRecord[]
> {
  const db = getDbPg();
  const rows = await db<ContentSidebarRecord[]>`
    select id, talk_id, title, updated_at
    from public.contents
    order by updated_at desc, id
  `;
  return rows;
}

export async function getContentByTalkId(
  talkId: string,
): Promise<Content | null> {
  const db = getDbPg();
  const rows = await db<ContentRecord[]>`
    select id, owner_id, talk_id, title, content_kind, content_format,
           body_markdown, body_version, anchor_map_json,
           created_at, updated_at,
           created_by_user_id, updated_by_user_id, updated_by_run_id
    from public.contents
    where talk_id = ${talkId}::uuid
    limit 1
  `;
  return rows[0] ? toContent(rows[0]) : null;
}

export async function getContentById(
  contentId: string,
): Promise<Content | null> {
  const db = getDbPg();
  const rows = await db<ContentRecord[]>`
    select id, owner_id, talk_id, title, content_kind, content_format,
           body_markdown, body_version, anchor_map_json,
           created_at, updated_at,
           created_by_user_id, updated_by_user_id, updated_by_run_id
    from public.contents
    where id = ${contentId}::uuid
    limit 1
  `;
  return rows[0] ? toContent(rows[0]) : null;
}

export type UpdateContentResult =
  | { kind: 'ok'; content: Content }
  | { kind: 'conflict'; current: Content }
  | { kind: 'not_found' }
  | { kind: 'doc_size_limit'; wouldBeBytes: number };

export async function updateContentBody(input: {
  contentId: string;
  ownerId: string;
  expectedVersion: number;
  bodyMarkdown: string;
  title?: string;
  updatedByUserId?: string | null;
  updatedByRunId?: string | null;
}): Promise<UpdateContentResult> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error('expectedVersion must be a positive integer');
  }

  const sanitized = sanitizeMarkdown(input.bodyMarkdown);
  if (byteLengthOf(sanitized) > CONTENT_BODY_BYTE_LIMIT) {
    return {
      kind: 'doc_size_limit',
      wouldBeBytes: byteLengthOf(sanitized),
    };
  }

  // Parse → re-stamp anchors → re-serialize so the markdown reflects
  // the canonical anchored shape regardless of what the client sent.
  const parsed = sanitizeRichTextDocument(markdownToTiptapJson(sanitized));
  const stamped = ensureAnchorIds(parsed);
  const canonicalMarkdown = tiptapJsonToMarkdown(stamped);
  if (byteLengthOf(canonicalMarkdown) > CONTENT_BODY_BYTE_LIMIT) {
    return {
      kind: 'doc_size_limit',
      wouldBeBytes: byteLengthOf(canonicalMarkdown),
    };
  }
  const anchorMap = await computeAnchorMap(stamped);

  const db = getDbPg();
  const existingRows = await db<ContentRecord[]>`
    select id, owner_id, talk_id, title, content_kind, content_format,
           body_markdown, body_version, anchor_map_json,
           created_at, updated_at,
           created_by_user_id, updated_by_user_id, updated_by_run_id
    from public.contents
    where id = ${input.contentId}::uuid
    limit 1
  `;
  const existing = existingRows[0];
  if (!existing) return { kind: 'not_found' };
  if (existing.body_version !== input.expectedVersion) {
    return { kind: 'conflict', current: toContent(existing) };
  }

  const nextTitle =
    input.title !== undefined ? normalizeTitle(input.title) : existing.title;

  const updatedRows = await db<ContentRecord[]>`
    update public.contents
    set body_markdown = ${canonicalMarkdown},
        body_version = body_version + 1,
        anchor_map_json = ${db.json(anchorMap as never)},
        title = ${nextTitle},
        updated_at = now(),
        updated_by_user_id = ${input.updatedByUserId ?? null}::uuid,
        updated_by_run_id = ${input.updatedByRunId ?? null}::uuid
    where id = ${input.contentId}::uuid
      and body_version = ${input.expectedVersion}
    returning id, owner_id, talk_id, title, content_kind, content_format,
              body_markdown, body_version, anchor_map_json,
              created_at, updated_at,
              created_by_user_id, updated_by_user_id, updated_by_run_id
  `;
  const updated = updatedRows[0];
  if (!updated) {
    // CAS lost. Refetch for the caller.
    const refetch = await db<ContentRecord[]>`
      select id, owner_id, talk_id, title, content_kind, content_format,
             body_markdown, body_version, anchor_map_json,
             created_at, updated_at,
             created_by_user_id, updated_by_user_id, updated_by_run_id
      from public.contents
      where id = ${input.contentId}::uuid
      limit 1
    `;
    if (!refetch[0]) return { kind: 'not_found' };
    return { kind: 'conflict', current: toContent(refetch[0]) };
  }

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

  return { kind: 'ok', content: toContent(updated) };
}
