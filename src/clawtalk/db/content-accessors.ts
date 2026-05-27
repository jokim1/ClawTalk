// Content feature — typed accessors for the `contents` and
// `content_edits` tables.
//
// Caller contract: every function below must run inside a
// `withUserContext(userId, ...)` block. RLS on both tables gates by
// thread-owner = auth.uid() (joined via talk_threads); the surrounding
// `withRequestScopedDb` scope opens the notify queue so outbox emits
// get flushed post-commit.
//
// The accept/update paths route the markdown body through the shared
// `src/shared/rich-text/` module: markdown → Tiptap JSON → AST
// mutation → markdown. The anchor map is recomputed from the
// resulting JSON. For HTML content the writer runs the shared
// `sanitizeHtmlServer`, stamps anchors via `insertAnchors`, and
// extracts an outline-derived anchor map so HTML edits can resolve
// `target_anchor_id` against the same `anchor_map_json` column the
// markdown path uses (PR B).

import { getDbPg } from '../../db.js';
import {
  type AnchorEntry,
  type AnchorMap,
  type RichTextDocument,
  type RichTextNode,
  computeAnchorMap,
  ensureAnchorIds,
  extractOutline,
  insertAnchors,
  markdownToTiptapJson,
  plainTextOf,
  sanitizeHtmlServer,
  sanitizeMarkdown,
  sanitizeRichTextDocument,
  sha256Hex,
  tiptapJsonToMarkdown,
} from '../../shared/rich-text/index.js';
import { emitOutboxEvent } from '../talks/outbox-emit.js';

// 10 MB — enough for ~20 medium-sized inline base64 images that arrive
// from a Google Docs paste. Postgres TEXT handles this fine; the LLM
// outline path already truncates to its own 20 KB budget so a large
// body doesn't blow the agent context. v2 follow-up: upload image data
// URLs to R2 on paste so the body stays text-only.
export const CONTENT_BODY_BYTE_LIMIT = 10_000_000;

export type ContentFormat = 'markdown' | 'html';

const CONTENT_RECORD_COLUMNS = `
  id, owner_id, talk_id, thread_id, title, content_kind, content_format,
  body_markdown, body_html, body_version, anchor_map_json,
  created_at, updated_at,
  created_by_user_id, updated_by_user_id, updated_by_run_id
`;

export interface ContentRecord {
  id: string;
  owner_id: string;
  talk_id: string;
  thread_id: string;
  title: string;
  content_kind: string;
  content_format: ContentFormat;
  body_markdown: string;
  body_html: string | null;
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
  threadId: string;
  title: string;
  contentKind: string;
  contentFormat: ContentFormat;
  bodyMarkdown: string;
  bodyHtml: string | null;
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
    threadId: row.thread_id,
    title: row.title,
    contentKind: row.content_kind,
    contentFormat: row.content_format,
    bodyMarkdown: row.body_markdown,
    bodyHtml: row.body_html,
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

function isValidFormat(format: unknown): format is ContentFormat {
  return format === 'markdown' || format === 'html';
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

const HTML_ANCHOR_PREVIEW_MAX = 60;

/**
 * Build the `anchor_map_json` payload for an HTML body. Walks the
 * top-level blocks via the shared outline extractor and produces the
 * same `AnchorEntry` shape the markdown path uses — kind=tag,
 * sort_order=index, preview=first 60 chars of plain text,
 * content_hash=SHA-256(plain text).
 *
 * Caller contract: `html` must already have anchors stamped (use
 * `insertAnchors` before calling this). Returns `null` when the HTML
 * fails to parse — caller surfaces as a save-time error.
 */
export async function computeHtmlAnchorMap(
  html: string,
): Promise<AnchorMap | null> {
  const outline = extractOutline(html);
  if (!outline.ok) return null;
  const map: AnchorMap = {};
  for (let i = 0; i < outline.value.length; i++) {
    const entry = outline.value[i];
    const preview = entry.textExcerpt.slice(0, HTML_ANCHOR_PREVIEW_MAX);
    const contentHash = await sha256Hex(entry.textExcerpt);
    const anchorEntry: AnchorEntry = {
      kind: entry.tag,
      sort_order: i,
      preview,
      content_hash: contentHash,
    };
    map[entry.anchorId] = anchorEntry;
  }
  return map;
}

// ── content CRUD ─────────────────────────────────────────────────

export async function createContent(input: {
  ownerId: string;
  talkId: string;
  threadId: string;
  title: string;
  format?: ContentFormat;
  createdByUserId?: string | null;
}): Promise<Content> {
  const title = normalizeTitle(input.title);
  const format: ContentFormat = input.format ?? 'markdown';
  if (!isValidFormat(format)) {
    throw new Error(`Invalid content format: ${String(input.format)}`);
  }
  // For markdown docs we keep the existing default — body_markdown='',
  // body_html=null. For HTML docs we set body_html='' (the
  // body-matches-format CHECK requires it to be non-null when
  // content_format='html'). body_markdown stays at its default ''.
  const initialMarkdown = '';
  const initialHtml: string | null = format === 'html' ? '' : null;
  const db = getDbPg();
  const rows = await db<ContentRecord[]>`
    insert into public.contents
      (owner_id, talk_id, thread_id, title, content_kind, content_format,
       body_markdown, body_html, body_version, anchor_map_json,
       created_by_user_id, updated_by_user_id, updated_by_run_id)
    values
      (${input.ownerId}::uuid, ${input.talkId}::uuid,
       ${input.threadId}::uuid, ${title},
       'document', ${format},
       ${initialMarkdown}, ${initialHtml}, 1, '{}'::jsonb,
       ${input.createdByUserId ?? null}::uuid,
       ${input.createdByUserId ?? null}::uuid,
       null)
    returning ${db.unsafe(CONTENT_RECORD_COLUMNS)}
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

/**
 * Look up the content row attached to a thread. Each thread can host
 * at most one content row (unique index on `contents.thread_id`).
 */
export async function getContentByThreadId(
  threadId: string,
): Promise<Content | null> {
  const db = getDbPg();
  const rows = await db<ContentRecord[]>`
    select ${db.unsafe(CONTENT_RECORD_COLUMNS)}
    from public.contents
    where thread_id = ${threadId}::uuid
    limit 1
  `;
  return rows[0] ? toContent(rows[0]) : null;
}

/**
 * Thin shim: resolve to the talk's default thread and look up the
 * content row attached to it. This is the legacy entrypoint that
 * predates the thread move — callers that don't yet know which thread
 * to ask about route through here. New callers should use
 * `getContentByThreadId` directly.
 */
export async function getContentByTalkId(
  talkId: string,
): Promise<Content | null> {
  const db = getDbPg();
  const rows = await db<ContentRecord[]>`
    select ${db.unsafe(CONTENT_RECORD_COLUMNS)}
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
    select ${db.unsafe(CONTENT_RECORD_COLUMNS)}
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
  | { kind: 'format_mismatch'; format: ContentFormat }
  | { kind: 'doc_size_limit'; wouldBeBytes: number };

/**
 * Update the body of an existing content row.
 *
 * For markdown content: pass `bodyMarkdown`. The body is sanitized,
 * round-tripped through the Tiptap AST, anchor-stamped, and persisted.
 * For HTML content: pass `bodyHtml`. The body is sanitized via the
 * shared server allowlist (storage truth) and persisted as-is.
 * `anchor_map_json` stays at `{}` for HTML rows in PR A — server-side
 * HTML anchor stamping lands in PR B (plan T13).
 *
 * Passing the wrong body kind for the row's format returns
 * `format_mismatch`. Passing neither leaves the body unchanged.
 */
export async function updateContentBody(input: {
  contentId: string;
  ownerId: string;
  expectedVersion: number;
  bodyMarkdown?: string;
  bodyHtml?: string;
  title?: string;
  updatedByUserId?: string | null;
  updatedByRunId?: string | null;
}): Promise<UpdateContentResult> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error('expectedVersion must be a positive integer');
  }

  const db = getDbPg();
  const existingRows = await db<ContentRecord[]>`
    select ${db.unsafe(CONTENT_RECORD_COLUMNS)}
    from public.contents
    where id = ${input.contentId}::uuid
    limit 1
  `;
  const existing = existingRows[0];
  if (!existing) return { kind: 'not_found' };

  const wantsMarkdown = typeof input.bodyMarkdown === 'string';
  const wantsHtml = typeof input.bodyHtml === 'string';

  // Format-mismatch guard: a caller sending the wrong body shape for
  // the row's format gets a 400-like rejection. Returning early keeps
  // the body untouched so a misrouted PATCH can't drop content.
  if (existing.content_format === 'markdown' && wantsHtml && !wantsMarkdown) {
    return { kind: 'format_mismatch', format: existing.content_format };
  }
  if (existing.content_format === 'html' && wantsMarkdown && !wantsHtml) {
    return { kind: 'format_mismatch', format: existing.content_format };
  }

  let nextMarkdown = existing.body_markdown;
  let nextHtml = existing.body_html;
  let nextAnchorMap: AnchorMap = existing.anchor_map_json ?? {};

  if (existing.content_format === 'markdown' && wantsMarkdown) {
    const sanitized = sanitizeMarkdown(input.bodyMarkdown as string);
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
    nextMarkdown = canonicalMarkdown;
    nextAnchorMap = await computeAnchorMap(stamped);
  } else if (existing.content_format === 'html' && wantsHtml) {
    // Sanitize first (storage truth = sanitized), then stamp anchors
    // on every top-level block so the AI sees a stable outline next
    // turn, then compute the anchor_map_json sidecar from the stamped
    // HTML so server-side validators can resolve `target_anchor_id`
    // without re-parsing the body.
    const { clean } = sanitizeHtmlServer(input.bodyHtml as string);
    if (byteLengthOf(clean) > CONTENT_BODY_BYTE_LIMIT) {
      return {
        kind: 'doc_size_limit',
        wouldBeBytes: byteLengthOf(clean),
      };
    }
    const stamped = insertAnchors(clean);
    if (!stamped.ok) {
      // Defensive — sanitize-html returns valid HTML, so linkedom
      // should always parse it. Fall back to the unsstamped clean
      // string so a malformed-output edge case still persists rather
      // than dropping the user's edit.
      nextHtml = clean;
    } else {
      if (byteLengthOf(stamped.value) > CONTENT_BODY_BYTE_LIMIT) {
        return {
          kind: 'doc_size_limit',
          wouldBeBytes: byteLengthOf(stamped.value),
        };
      }
      nextHtml = stamped.value;
      const computed = await computeHtmlAnchorMap(stamped.value);
      if (computed !== null) nextAnchorMap = computed;
    }
  }

  if (existing.body_version !== input.expectedVersion) {
    return { kind: 'conflict', current: toContent(existing) };
  }

  const nextTitle =
    input.title !== undefined ? normalizeTitle(input.title) : existing.title;

  const updatedRows = await db<ContentRecord[]>`
    update public.contents
    set body_markdown = ${nextMarkdown},
        body_html = ${nextHtml},
        body_version = body_version + 1,
        anchor_map_json = ${db.json(nextAnchorMap as never)},
        title = ${nextTitle},
        updated_at = now(),
        updated_by_user_id = ${input.updatedByUserId ?? null}::uuid,
        updated_by_run_id = ${input.updatedByRunId ?? null}::uuid
    where id = ${input.contentId}::uuid
      and body_version = ${input.expectedVersion}
    returning ${db.unsafe(CONTENT_RECORD_COLUMNS)}
  `;
  const updated = updatedRows[0];
  if (!updated) {
    // CAS lost. Refetch for the caller.
    const refetch = await db<ContentRecord[]>`
      select ${db.unsafe(CONTENT_RECORD_COLUMNS)}
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
      format: updated.content_format,
      appliedAnchorIds: [],
    },
    ownerIds: [updated.owner_id],
  });

  return { kind: 'ok', content: toContent(updated) };
}
