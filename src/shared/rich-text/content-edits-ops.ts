// Render-time + apply-time composer for the content_edits log.
//
// The edit-log architecture (plan section B) keeps `contents.body_markdown`
// immutable until accept. Pending agent edits live as rows in
// `content_edits`; the renderer composes body + pending edits into a
// single annotated Tiptap document at read time. The same composer is
// also the materialize step for accept: feed it the pending edit(s) and
// it returns a plain Tiptap doc that can be re-serialized to markdown.
//
// "Compose" vs "materialize":
//   - composeBody(body, edits) → annotated doc with data-pending-* attrs
//     marking each block as insert/replace/delete/bulk for visual diff
//     rendering. The wrapper for replace carries the prior block as a
//     non-editable child so the diff-inline view can strike it through.
//   - materializeEdits(body, edits) → plain doc with no pending markers.
//     This is what gets re-serialized into body_markdown on accept.
//
// Lives in src/shared so both worker accept paths and browser render
// paths use the exact same logic. No DB / no network — pure data ops.

import {
  ANCHOR_ATTR_KEY,
  type RichTextDocument,
  type RichTextNode,
} from './types.js';
import {
  findBlockIndexByAnchor,
  freshAnchorId,
  getAnchorId,
} from './anchor-ops.js';
import { markdownToTiptapJson } from './markdown-to-tiptap.js';
import { parseHTML } from 'linkedom';
import {
  BLOCK_ELIGIBLE_TAGS,
  insertAnchors as insertHtmlAnchors,
} from './html-anchors.js';

// ── Edit row shape (mirror of content_edits) ─────────────────────────

export type ContentEditKind = 'insert' | 'replace' | 'delete' | 'bulk';

export interface ContentEditRow {
  id: string;
  contentId: string;
  runId: string;
  agentId: string | null;
  agentNickname: string | null;
  messageId: string | null;
  kind: ContentEditKind;
  baseContentVersion: number;
  // For replace/delete: the anchor to act on.
  // For insert: the anchor to insert AFTER (null = prepend at top).
  // For bulk: null (the whole body is replaced).
  targetAnchorId: string | null;
  // For markdown docs (parent content_format='markdown'): the new block
  // markdown. For insert/replace; the entire new body for bulk; null
  // for delete.
  newMarkdown: string | null;
  // For HTML docs (parent content_format='html'): the new block HTML.
  // Exactly one of newMarkdown / newHtml is non-null per row (except
  // kind='delete', where both are null). The DB CHECK constraint in
  // migration 0030 enforces this; consumers branch on the parent
  // content's format to know which field to read.
  newHtml: string | null;
  rationale: string | null;
  createdAt: string;
}

// ── Pending markers on rendered nodes ────────────────────────────────

// These attribute keys land on Tiptap nodes only in the composed
// render output — never serialized back to markdown.
export const PENDING_KIND_ATTR = 'dataPendingKind' as const;
export const PENDING_EDIT_ID_ATTR = 'dataPendingEditId' as const;

export type PendingMarkerKind = ContentEditKind;

// The decorative wrapper node for replaces. Carries the prior block (as
// gray-strikethrough, non-editable) followed by the new block (red,
// editable). Lives ONLY in the rendered doc — never serialized to
// markdown, never round-tripped through anchor-ops. The Tiptap extension
// in webapp registers this node type.
export const PENDING_REPLACE_WRAPPER_TYPE = 'pendingReplaceWrapper' as const;

// ── Composer ─────────────────────────────────────────────────────────

export interface ComposeBodyOptions {
  // When set, anchors stamped on freshly-parsed pending-insert content
  // use this generator. Lets tests inject deterministic IDs.
  generate?: () => string;
}

/**
 * Compose body_markdown + pending edits into a single annotated Tiptap
 * document for rendering. Edits applied in created_at order (caller's
 * responsibility to pass them sorted).
 *
 * Annotation conventions:
 *   - kind=insert: parsed new_markdown nodes get
 *     attrs.dataPendingKind='insert' + attrs.dataPendingEditId=editId.
 *     Spliced AFTER targetAnchorId (or prepended if null).
 *   - kind=replace: original body block at targetAnchorId is wrapped in
 *     a pendingReplaceWrapper node whose `prior` child is the body's
 *     block (gray-strike, non-editable) and whose `new` children are the
 *     parsed new_markdown nodes (red, editable). Wrapper carries the
 *     editId so click handlers can route correctly.
 *   - kind=delete: original body block at targetAnchorId gets attrs
 *     dataPendingKind='delete' + dataPendingEditId=editId. Body's block
 *     stays in place (struck-through red on render).
 *   - kind=bulk: entire doc.content is replaced with parsed new_markdown
 *     nodes; each block gets dataPendingKind='insert' + dataPendingEditId
 *     (banner-only controls per plan D10).
 *
 * Edits referencing a missing target_anchor_id are SKIPPED silently and
 * collected on the returned `skippedEditIds` list. The render still
 * succeeds; the caller can surface a toast if it cares.
 */
export interface ComposeBodyResult {
  doc: RichTextDocument;
  skippedEditIds: string[];
}

export function composeBody(
  bodyMarkdown: string,
  edits: ContentEditRow[],
  options: ComposeBodyOptions = {},
): ComposeBodyResult {
  const baseDoc = markdownToTiptapJson(bodyMarkdown);

  if (edits.length === 0) {
    return { doc: baseDoc, skippedEditIds: [] };
  }

  // A bulk row supersedes every other edit in the same run (per
  // collapsing semantics — bulk + other-in-same-run isn't allowed by
  // the apply handler, but be defensive on the read path).
  const bulk = edits.find((e) => e.kind === 'bulk');
  if (bulk) {
    if (bulk.newMarkdown === null) {
      return { doc: baseDoc, skippedEditIds: [bulk.id] };
    }
    const parsed = markdownToTiptapJson(bulk.newMarkdown);
    const annotated = parsed.content.map((node) =>
      annotateNode(node, 'insert', bulk.id),
    );
    return {
      doc: { type: 'doc', content: annotated },
      skippedEditIds: [],
    };
  }

  let doc = baseDoc;
  const skipped: string[] = [];
  const generate = options.generate ?? freshAnchorId;

  for (const edit of edits) {
    const next = applyOne(doc, edit, generate);
    if (next === null) {
      skipped.push(edit.id);
      continue;
    }
    doc = next;
  }

  return { doc, skippedEditIds: skipped };
}

function applyOne(
  doc: RichTextDocument,
  edit: ContentEditRow,
  generate: () => string,
): RichTextDocument | null {
  switch (edit.kind) {
    case 'insert': {
      if (edit.newMarkdown === null) return null;
      const insertedNodes = markdownToTiptapJson(edit.newMarkdown).content.map(
        (node) =>
          annotateNode(stampAnchorIfMissing(node, generate), 'insert', edit.id),
      );
      const content = [...doc.content];
      let insertIdx: number;
      if (edit.targetAnchorId === null) {
        insertIdx = 0;
      } else {
        const found = findBlockIndexByAnchor(doc, edit.targetAnchorId);
        if (found === -1) return null;
        insertIdx = found + 1;
      }
      content.splice(insertIdx, 0, ...insertedNodes);
      return { ...doc, content };
    }
    case 'replace': {
      if (edit.newMarkdown === null) return null;
      if (edit.targetAnchorId === null) return null;
      const idx = findBlockIndexByAnchor(doc, edit.targetAnchorId);
      if (idx === -1) return null;
      const priorBlock = doc.content[idx];
      const newBlocks = markdownToTiptapJson(edit.newMarkdown).content.map(
        (node) => stampAnchorIfMissing(node, generate),
      );
      const wrapper: RichTextNode = {
        type: PENDING_REPLACE_WRAPPER_TYPE,
        attrs: {
          [PENDING_EDIT_ID_ATTR]: edit.id,
          [PENDING_KIND_ATTR]: 'replace',
          // Keep the body's anchor on the wrapper so PendingChangeGutter
          // can find a stable identifier when positioning.
          [ANCHOR_ATTR_KEY]: edit.targetAnchorId,
        },
        content: [
          {
            ...priorBlock,
            attrs: { ...(priorBlock.attrs ?? {}), role: 'prior' },
          },
          ...newBlocks.map((node) => ({
            ...node,
            attrs: { ...(node.attrs ?? {}), role: 'new' },
          })),
        ],
      };
      const content = [...doc.content];
      content.splice(idx, 1, wrapper);
      return { ...doc, content };
    }
    case 'delete': {
      if (edit.targetAnchorId === null) return null;
      const idx = findBlockIndexByAnchor(doc, edit.targetAnchorId);
      if (idx === -1) return null;
      const target = doc.content[idx];
      const content = [...doc.content];
      content[idx] = annotateNode(target, 'delete', edit.id);
      return { ...doc, content };
    }
    case 'bulk': {
      if (edit.newMarkdown === null) return null;
      const parsed = markdownToTiptapJson(edit.newMarkdown);
      const annotated = parsed.content.map((node) =>
        annotateNode(stampAnchorIfMissing(node, generate), 'insert', edit.id),
      );
      return { ...doc, content: annotated };
    }
  }
}

function annotateNode(
  node: RichTextNode,
  kind: PendingMarkerKind,
  editId: string,
): RichTextNode {
  return {
    ...node,
    attrs: {
      ...(node.attrs ?? {}),
      [PENDING_KIND_ATTR]: kind,
      [PENDING_EDIT_ID_ATTR]: editId,
    },
  };
}

function stampAnchorIfMissing(
  node: RichTextNode,
  generate: () => string,
): RichTextNode {
  if (typeof node.attrs?.[ANCHOR_ATTR_KEY] === 'string') return node;
  return {
    ...node,
    attrs: { ...(node.attrs ?? {}), [ANCHOR_ATTR_KEY]: generate() },
  };
}

// ── Materialize (accept path) ────────────────────────────────────────

/**
 * Apply pending edits to a body document, producing the *accepted* doc
 * with no pending markers. Used by:
 *   - Per-edit Accept (call with one edit).
 *   - Per-run Accept (call with all edits for the run in created_at order).
 *   - Auto-accept-prior on new run start (call with the prior run's edits).
 *
 * Missing target_anchor_id is treated as a no-op for that edit (caller
 * decides whether that's worth surfacing). Bulk fully replaces content.
 */
export function materializeEdits(
  bodyMarkdown: string,
  edits: ContentEditRow[],
  options: ComposeBodyOptions = {},
): RichTextDocument {
  const generate = options.generate ?? freshAnchorId;
  let doc = markdownToTiptapJson(bodyMarkdown);

  for (const edit of edits) {
    const next = materializeOne(doc, edit, generate);
    if (next !== null) doc = next;
  }

  return doc;
}

function materializeOne(
  doc: RichTextDocument,
  edit: ContentEditRow,
  generate: () => string,
): RichTextDocument | null {
  switch (edit.kind) {
    case 'insert': {
      if (edit.newMarkdown === null) return null;
      const insertedNodes = markdownToTiptapJson(edit.newMarkdown).content.map(
        (node) => stampAnchorIfMissing(node, generate),
      );
      const content = [...doc.content];
      let insertIdx: number;
      if (edit.targetAnchorId === null) {
        insertIdx = 0;
      } else {
        const found = findBlockIndexByAnchor(doc, edit.targetAnchorId);
        if (found === -1) return null;
        insertIdx = found + 1;
      }
      content.splice(insertIdx, 0, ...insertedNodes);
      return { ...doc, content };
    }
    case 'replace': {
      if (edit.newMarkdown === null) return null;
      if (edit.targetAnchorId === null) return null;
      const idx = findBlockIndexByAnchor(doc, edit.targetAnchorId);
      if (idx === -1) return null;
      const targetAnchor = edit.targetAnchorId;
      const parsedNodes = markdownToTiptapJson(edit.newMarkdown).content;
      const replacementNodes = parsedNodes.map((node, i) => {
        // Single-node replacements inherit the target anchor; multi-node
        // get fresh IDs.
        const inheritedAnchor =
          i === 0 && parsedNodes.length === 1 ? targetAnchor : generate();
        return {
          ...node,
          attrs: { ...(node.attrs ?? {}), [ANCHOR_ATTR_KEY]: inheritedAnchor },
        };
      });
      const content = [...doc.content];
      content.splice(idx, 1, ...replacementNodes);
      return { ...doc, content };
    }
    case 'delete': {
      if (edit.targetAnchorId === null) return null;
      const idx = findBlockIndexByAnchor(doc, edit.targetAnchorId);
      if (idx === -1) return null;
      const content = [...doc.content];
      content.splice(idx, 1);
      return { ...doc, content };
    }
    case 'bulk': {
      if (edit.newMarkdown === null) return null;
      const parsed = markdownToTiptapJson(edit.newMarkdown);
      // Bulk drops every anchor and gets fresh stamps on accept — body
      // shape is fully replaced.
      const cleaned = parsed.content.map((node) => {
        const attrs = { ...(node.attrs ?? {}) };
        delete attrs[ANCHOR_ATTR_KEY];
        return { ...node, attrs: { ...attrs, [ANCHOR_ATTR_KEY]: generate() } };
      });
      return { ...doc, content: cleaned };
    }
  }
}

// ── Run-level helpers ────────────────────────────────────────────────

export function listPendingRunIds(edits: ContentEditRow[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const edit of edits) {
    if (seen.has(edit.runId)) continue;
    seen.add(edit.runId);
    ordered.push(edit.runId);
  }
  return ordered;
}

export function groupEditsByRun(
  edits: ContentEditRow[],
): Map<string, ContentEditRow[]> {
  const map = new Map<string, ContentEditRow[]>();
  for (const edit of edits) {
    const list = map.get(edit.runId);
    if (list) list.push(edit);
    else map.set(edit.runId, [edit]);
  }
  return map;
}

export interface PendingRunSummary {
  runId: string;
  agentId: string | null;
  agentNickname: string | null;
  rationale: string | null;
  counts: {
    insert: number;
    replace: number;
    delete: number;
    bulk: number;
    total: number;
  };
}

/**
 * Banner-facing summary of a pending run. `rationale` picks the latest
 * non-null value across the run's edits (the agent may set it on any
 * call within the run; the most recent intent wins).
 */
export function getPendingRunSummary(
  edits: ContentEditRow[],
  runId: string,
): PendingRunSummary | null {
  const forRun = edits.filter((e) => e.runId === runId);
  if (forRun.length === 0) return null;

  const counts = {
    insert: 0,
    replace: 0,
    delete: 0,
    bulk: 0,
    total: forRun.length,
  };
  let agentId: string | null = null;
  let agentNickname: string | null = null;
  let rationale: string | null = null;

  for (const edit of forRun) {
    counts[edit.kind] += 1;
    if (edit.agentId !== null) agentId = edit.agentId;
    if (edit.agentNickname !== null) agentNickname = edit.agentNickname;
    if (edit.rationale !== null) rationale = edit.rationale;
  }

  return { runId, agentId, agentNickname, rationale, counts };
}

// Re-export the body-anchor lookup so consumers that just need "is this
// anchor still in the doc" don't have to import from anchor-ops too.
export { getAnchorId };

// ── HTML compose + materialize (PR B) ────────────────────────────────
//
// Sibling of the markdown composer above, operating on `body_html` and
// `new_html` instead of body_markdown / new_markdown. Block targeting
// is by `data-anchor-id` (see html-anchors.ts); pending markers land
// as `data-pending-kind` / `data-pending-edit-id` / `data-pending-role`
// attributes on the affected top-level blocks.
//
// The HTML path uses linkedom for DOM mutation so it stays
// Workers-compatible. The markdown path above is bit-for-bit unchanged.

export const PENDING_KIND_HTML_ATTR = 'data-pending-kind' as const;
export const PENDING_EDIT_ID_HTML_ATTR = 'data-pending-edit-id' as const;
export const PENDING_ROLE_HTML_ATTR = 'data-pending-role' as const;
const HTML_ANCHOR_ATTR = 'data-anchor-id';

export interface HtmlComposeError {
  ok: false;
  error: 'html_parse_failed';
  message: string;
}

export interface HtmlComposeSuccess {
  ok: true;
  html: string;
  skippedEditIds: string[];
}

export type ComposeBodyHtmlResult = HtmlComposeSuccess | HtmlComposeError;

export interface MaterializeEditsHtmlSuccess {
  ok: true;
  html: string;
}

export type MaterializeEditsHtmlResult =
  | MaterializeEditsHtmlSuccess
  | HtmlComposeError;

// Slim narrowing for linkedom DOM nodes — we only touch the
// element/parent surface, no need for global DOM lib types.
interface HtmlElementLike {
  tagName: string | null;
  children: HtmlElementLike[];
  parentNode: HtmlElementLike | null;
  nextSibling: HtmlElementLike | null;
  innerHTML: string;
  outerHTML: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild(child: HtmlElementLike): HtmlElementLike;
  insertBefore(
    newNode: HtmlElementLike,
    refNode: HtmlElementLike | null,
  ): HtmlElementLike;
  removeChild(child: HtmlElementLike): HtmlElementLike;
  replaceChild(
    newNode: HtmlElementLike,
    oldNode: HtmlElementLike,
  ): HtmlElementLike;
}

interface HtmlDocumentLike {
  body: HtmlElementLike;
  createElement(tag: string): HtmlElementLike;
}

function tagOf(element: HtmlElementLike): string {
  return (element.tagName ?? '').toLowerCase();
}

function isBlockEligible(element: HtmlElementLike): boolean {
  return BLOCK_ELIGIBLE_TAGS.has(tagOf(element));
}

function parseHtmlDocument(
  html: string,
): { ok: true; document: HtmlDocumentLike } | HtmlComposeError {
  if (typeof html !== 'string') {
    return {
      ok: false,
      error: 'html_parse_failed',
      message: 'HTML payload must be a string.',
    };
  }
  try {
    const { document } = parseHTML(
      `<!doctype html><html><head></head><body>${html}</body></html>`,
    );
    if (!document.body) {
      return {
        ok: false,
        error: 'html_parse_failed',
        message: 'Parsed HTML has no <body>.',
      };
    }
    return { ok: true, document: document as unknown as HtmlDocumentLike };
  } catch (err) {
    return {
      ok: false,
      error: 'html_parse_failed',
      message:
        err instanceof Error
          ? err.message
          : 'Unknown HTML parse error from linkedom.',
    };
  }
}

function stampMissingTopLevelAnchors(
  root: HtmlElementLike,
  generate: () => string,
): void {
  for (const child of [...root.children]) {
    if (!isBlockEligible(child)) continue;
    const existing = child.getAttribute(HTML_ANCHOR_ATTR);
    if (typeof existing === 'string' && existing.length > 0) continue;
    child.setAttribute(HTML_ANCHOR_ATTR, generate());
  }
}

function findTopLevelBlockByAnchor(
  root: HtmlElementLike,
  anchorId: string,
): HtmlElementLike | null {
  for (const child of root.children) {
    if (child.getAttribute(HTML_ANCHOR_ATTR) === anchorId) return child;
  }
  return null;
}

function parsePayloadBlocks(
  doc: HtmlDocumentLike,
  payload: string,
): HtmlElementLike[] {
  const wrapper = doc.createElement('div');
  wrapper.innerHTML = payload;
  return [...wrapper.children];
}

function annotateBlock(
  block: HtmlElementLike,
  kind: ContentEditKind,
  editId: string,
  role?: 'prior' | 'new',
): void {
  block.setAttribute(PENDING_KIND_HTML_ATTR, kind);
  block.setAttribute(PENDING_EDIT_ID_HTML_ATTR, editId);
  if (role) block.setAttribute(PENDING_ROLE_HTML_ATTR, role);
}

function stampPayloadAnchors(
  blocks: HtmlElementLike[],
  generate: () => string,
  inheritFirst: string | null,
): void {
  blocks.forEach((block, index) => {
    if (!isBlockEligible(block)) return;
    if (index === 0 && inheritFirst !== null && blocks.length === 1) {
      block.setAttribute(HTML_ANCHOR_ATTR, inheritFirst);
      return;
    }
    if (!block.getAttribute(HTML_ANCHOR_ATTR)) {
      block.setAttribute(HTML_ANCHOR_ATTR, generate());
    }
  });
}

function insertBlocksAfter(
  root: HtmlElementLike,
  blocks: HtmlElementLike[],
  target: HtmlElementLike | null,
): void {
  // target=null means prepend at top. Otherwise insert each block right
  // after target, walking a moving cursor so the blocks land in input
  // order.
  let cursor: HtmlElementLike | null = target;
  for (const block of blocks) {
    if (cursor === null) {
      const firstChild = root.children[0] ?? null;
      root.insertBefore(block, firstChild);
    } else {
      root.insertBefore(block, cursor.nextSibling);
    }
    cursor = block;
  }
}

function clearRoot(root: HtmlElementLike): void {
  while (root.children.length > 0) {
    root.removeChild(root.children[0]);
  }
}

/**
 * Compose body_html + pending edits into an annotated HTML body for
 * rendering. Top-level blocks targeted by edits gain
 * `data-pending-kind` + `data-pending-edit-id`, with replace splitting
 * into `data-pending-role="prior"` + `data-pending-role="new"`
 * siblings. Bulk supersedes other edits (same contract as markdown).
 *
 * Returns a structured parse-error envelope when linkedom can't parse
 * either the base body or any edit payload — caller surfaces to the
 * agent for retry rather than 500ing.
 */
export function composeBodyHtml(
  bodyHtml: string,
  edits: ContentEditRow[],
  options: ComposeBodyOptions = {},
): ComposeBodyHtmlResult {
  const parsed = parseHtmlDocument(bodyHtml);
  if (!parsed.ok) return parsed;
  const doc = parsed.document;
  const root = doc.body;
  const generate = options.generate ?? freshAnchorId;

  stampMissingTopLevelAnchors(root, generate);

  if (edits.length === 0) {
    return { ok: true, html: root.innerHTML, skippedEditIds: [] };
  }

  const bulk = edits.find((e) => e.kind === 'bulk');
  if (bulk) {
    if (bulk.newHtml === null) {
      return { ok: true, html: root.innerHTML, skippedEditIds: [bulk.id] };
    }
    clearRoot(root);
    const blocks = parsePayloadBlocks(doc, bulk.newHtml);
    stampPayloadAnchors(blocks, generate, null);
    for (const block of blocks) {
      if (isBlockEligible(block)) annotateBlock(block, 'insert', bulk.id);
      root.appendChild(block);
    }
    return { ok: true, html: root.innerHTML, skippedEditIds: [] };
  }

  const skipped: string[] = [];
  for (const edit of edits) {
    const ok = applyOneHtmlCompose(doc, root, edit, generate);
    if (!ok) skipped.push(edit.id);
  }
  return { ok: true, html: root.innerHTML, skippedEditIds: skipped };
}

function applyOneHtmlCompose(
  doc: HtmlDocumentLike,
  root: HtmlElementLike,
  edit: ContentEditRow,
  generate: () => string,
): boolean {
  switch (edit.kind) {
    case 'insert': {
      if (edit.newHtml === null) return false;
      let target: HtmlElementLike | null = null;
      if (edit.targetAnchorId !== null) {
        target = findTopLevelBlockByAnchor(root, edit.targetAnchorId);
        if (target === null) return false;
      }
      const blocks = parsePayloadBlocks(doc, edit.newHtml);
      stampPayloadAnchors(blocks, generate, null);
      for (const block of blocks) {
        if (isBlockEligible(block)) annotateBlock(block, 'insert', edit.id);
      }
      insertBlocksAfter(root, blocks, target);
      return true;
    }
    case 'replace': {
      if (edit.newHtml === null) return false;
      if (edit.targetAnchorId === null) return false;
      const target = findTopLevelBlockByAnchor(root, edit.targetAnchorId);
      if (target === null) return false;
      annotateBlock(target, 'replace', edit.id, 'prior');
      const blocks = parsePayloadBlocks(doc, edit.newHtml);
      stampPayloadAnchors(blocks, generate, null);
      for (const block of blocks) {
        if (isBlockEligible(block)) {
          annotateBlock(block, 'replace', edit.id, 'new');
        }
      }
      insertBlocksAfter(root, blocks, target);
      return true;
    }
    case 'delete': {
      if (edit.targetAnchorId === null) return false;
      const target = findTopLevelBlockByAnchor(root, edit.targetAnchorId);
      if (target === null) return false;
      annotateBlock(target, 'delete', edit.id);
      return true;
    }
    case 'bulk': {
      // Bulk handled by the dispatcher; should never route through here.
      return false;
    }
  }
}

/**
 * Materialize a sequence of pending HTML edits into a clean HTML body.
 * No pending markers in the output — the result is what gets persisted
 * on accept (after the caller re-stamps anchors via `insertAnchors`
 * + runs `sanitizeHtmlServer`).
 *
 * Missing target anchors are silent no-ops per edit (same contract as
 * the markdown materializer).
 */
export function materializeEditsHtml(
  bodyHtml: string,
  edits: ContentEditRow[],
  options: ComposeBodyOptions = {},
): MaterializeEditsHtmlResult {
  const parsed = parseHtmlDocument(bodyHtml);
  if (!parsed.ok) return parsed;
  const doc = parsed.document;
  const root = doc.body;
  const generate = options.generate ?? freshAnchorId;

  stampMissingTopLevelAnchors(root, generate);

  for (const edit of edits) {
    applyOneHtmlMaterialize(doc, root, edit, generate);
  }

  return { ok: true, html: root.innerHTML };
}

function applyOneHtmlMaterialize(
  doc: HtmlDocumentLike,
  root: HtmlElementLike,
  edit: ContentEditRow,
  generate: () => string,
): void {
  switch (edit.kind) {
    case 'insert': {
      if (edit.newHtml === null) return;
      let target: HtmlElementLike | null = null;
      if (edit.targetAnchorId !== null) {
        target = findTopLevelBlockByAnchor(root, edit.targetAnchorId);
        if (target === null) return;
      }
      const blocks = parsePayloadBlocks(doc, edit.newHtml);
      stampPayloadAnchors(blocks, generate, null);
      insertBlocksAfter(root, blocks, target);
      return;
    }
    case 'replace': {
      if (edit.newHtml === null) return;
      if (edit.targetAnchorId === null) return;
      const target = findTopLevelBlockByAnchor(root, edit.targetAnchorId);
      if (target === null) return;
      const blocks = parsePayloadBlocks(doc, edit.newHtml);
      stampPayloadAnchors(blocks, generate, edit.targetAnchorId);
      const [first, ...rest] = blocks;
      if (first) {
        root.replaceChild(first, target);
        insertBlocksAfter(root, rest, first);
      } else {
        root.removeChild(target);
      }
      return;
    }
    case 'delete': {
      if (edit.targetAnchorId === null) return;
      const target = findTopLevelBlockByAnchor(root, edit.targetAnchorId);
      if (target === null) return;
      root.removeChild(target);
      return;
    }
    case 'bulk': {
      if (edit.newHtml === null) return;
      clearRoot(root);
      const blocks = parsePayloadBlocks(doc, edit.newHtml);
      // Bulk gets fresh anchors on accept to mirror the markdown path.
      for (const block of blocks) {
        if (isBlockEligible(block)) {
          block.setAttribute(HTML_ANCHOR_ATTR, generate());
        }
        root.appendChild(block);
      }
      return;
    }
  }
}

// The idempotent stamp function from html-anchors is the canonical
// outline-build pre-step (re-stamp anchors before extracting). Re-export
// so callers can pull both compose + stamp from the same barrel.
export { insertHtmlAnchors };
