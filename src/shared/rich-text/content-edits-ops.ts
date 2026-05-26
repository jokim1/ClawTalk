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
  // For insert/replace: the new block markdown.
  // For bulk: the entire new body markdown.
  // For delete: null (no new content).
  newMarkdown: string | null;
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
