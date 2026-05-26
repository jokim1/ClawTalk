// HTML anchor management for the hybrid MD+HTML content surface.
//
// PR B companion to html-sanitize-server.ts. Every top-level block in
// an HTML doc carries a `data-anchor-id` so the agent's
// `apply_content_edit` calls can target a specific block, the same way
// markdown anchors live in `<!-- anchor:xyz -->` comments. Inserting,
// stripping, and outline-extracting all share a single linkedom-backed
// parse so the three operations stay consistent.
//
// Block-level only (matches the markdown model): top-level direct
// children of <body> whose tagName is one of BLOCK_ELIGIBLE_TAGS get a
// stamp on first save; nested elements are ignored. Existing anchor IDs
// are preserved (idempotent re-run) so user edits don't reshuffle the
// outline the AI is targeting.
//
// All three entry points return structured errors instead of throwing
// when linkedom can't parse the input (T13 in the plan). The caller
// surfaces those to the agent for retry — never a 500.
//
// Workers-compatible: linkedom ships its own DOM and has no Node deps.

import { parseHTML } from 'linkedom';

import { freshAnchorId } from './anchor-ops.js';

// Block elements eligible for top-level anchor stamping. Mirrors the
// plan's anchor model — anything outside this set is left alone (the
// HTML editor's authoring surface accepts richer structure, but only
// these blocks can be addressed by the agent).
export const BLOCK_ELIGIBLE_TAGS: ReadonlySet<string> = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'ul',
  'ol',
  'table',
  'blockquote',
  'pre',
  'figure',
  'section',
  'div',
]);

const ANCHOR_ATTRIBUTE = 'data-anchor-id';
const OUTLINE_TEXT_LIMIT = 80;

// Shape of the structured error returned by all three functions when
// linkedom fails to parse the input. The caller (content-apply-handler)
// turns this into a tool-call error so the AI retries with a clean
// payload.
export interface HtmlParseError {
  ok: false;
  error: 'html_parse_failed';
  message: string;
}

export interface HtmlAnchorSuccess<T> {
  ok: true;
  value: T;
}

export type HtmlAnchorResult<T> = HtmlAnchorSuccess<T> | HtmlParseError;

export interface HtmlOutlineEntry {
  anchorId: string;
  tag: string;
  textExcerpt: string;
}

interface ParsedFragment {
  document: ReturnType<typeof parseHTML>['document'];
  // Root container whose children we treat as top-level blocks. With
  // linkedom this is always document.body once parseHTML has hung the
  // input under a synthetic <body>.
  root: Element;
}

function parseFragment(html: string): HtmlAnchorResult<ParsedFragment> {
  if (typeof html !== 'string') {
    return {
      ok: false,
      error: 'html_parse_failed',
      message: 'HTML payload must be a string.',
    };
  }
  try {
    // linkedom's parseHTML is forgiving — it wraps fragments under a
    // synthetic <body>. We force a full-document shell so the wrapping
    // step is deterministic regardless of whether the caller already
    // supplied a doctype/html/body envelope. Inputs that already
    // contain <body> end up with the inner body wrapped under the
    // outer one (which linkedom normalizes silently); the outline pass
    // still walks the outermost body's children, which is what we want.
    const { document } = parseHTML(
      `<!doctype html><html><head></head><body>${html}</body></html>`,
    );
    const root = document.body;
    if (!root) {
      return {
        ok: false,
        error: 'html_parse_failed',
        message: 'Parsed HTML has no <body>.',
      };
    }
    return { ok: true, value: { document, root: root as unknown as Element } };
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

function tagNameOf(element: Element): string {
  // linkedom keeps tag case as parsed; lowercase for matching.
  return (element.tagName ?? '').toLowerCase();
}

function topLevelBlockChildren(root: Element): Element[] {
  const out: Element[] = [];
  const children = (root as unknown as { children: Element[] }).children ?? [];
  for (const child of children) {
    if (!child || typeof tagNameOf(child) !== 'string') continue;
    if (BLOCK_ELIGIBLE_TAGS.has(tagNameOf(child))) out.push(child);
  }
  return out;
}

// ── insertAnchors ──────────────────────────────────────────────────────

/**
 * Walk the top-level blocks of `html` and ensure each one has a
 * `data-anchor-id` attribute. Existing IDs are preserved (idempotent
 * re-run); missing IDs get a fresh stamp via `freshAnchorId` (or the
 * caller's generator, for tests).
 *
 * Returns the serialized body inner HTML on success — no doctype,
 * no <html>/<body> wrappers. On parse failure returns the structured
 * error so callers can surface it to the AI.
 */
export function insertAnchors(
  html: string,
  options: { generate?: () => string } = {},
): HtmlAnchorResult<string> {
  const parsed = parseFragment(html);
  if (!parsed.ok) return parsed;
  const generate = options.generate ?? freshAnchorId;

  for (const block of topLevelBlockChildren(parsed.value.root)) {
    const existing = block.getAttribute(ANCHOR_ATTRIBUTE);
    if (typeof existing === 'string' && existing.length > 0) continue;
    block.setAttribute(ANCHOR_ATTRIBUTE, generate());
  }

  return {
    ok: true,
    value: (parsed.value.root as unknown as { innerHTML: string }).innerHTML,
  };
}

// ── stripAnchors ───────────────────────────────────────────────────────

/**
 * Remove only `data-anchor-id` attributes from `html`. All other
 * attributes — class, style, custom data-*, etc. — are preserved
 * verbatim. Useful for export paths that want a clean view of the doc
 * without any server-managed metadata.
 */
export function stripAnchors(html: string): HtmlAnchorResult<string> {
  const parsed = parseFragment(html);
  if (!parsed.ok) return parsed;

  // strip on top-level AND nested — the contract is "no anchor attrs in
  // the output". Iterating via the document walker keeps it O(n).
  const nodes = (
    parsed.value.document as unknown as {
      querySelectorAll: (sel: string) => Iterable<Element>;
    }
  ).querySelectorAll(`[${ANCHOR_ATTRIBUTE}]`);
  for (const node of nodes) {
    node.removeAttribute(ANCHOR_ATTRIBUTE);
  }

  return {
    ok: true,
    value: (parsed.value.root as unknown as { innerHTML: string }).innerHTML,
  };
}

// ── extractOutline ─────────────────────────────────────────────────────

/**
 * Return one entry per top-level block: `{anchorId, tag, textExcerpt}`.
 *
 * Blocks without an anchor are SKIPPED — callers that want a guaranteed
 * outline after an edit cycle should pipe their HTML through
 * `insertAnchors` first (the context-loader already does this so the
 * AI sees fresh anchors even if a recent user-edit stripped some).
 *
 * `textExcerpt` is the first 80 characters of the block's plain text
 * with whitespace collapsed and entities decoded (linkedom does the
 * decoding for us at parse time). Longer text is truncated with an
 * ellipsis. Empty blocks yield `''`.
 */
export function extractOutline(
  html: string,
): HtmlAnchorResult<HtmlOutlineEntry[]> {
  const parsed = parseFragment(html);
  if (!parsed.ok) return parsed;

  const entries: HtmlOutlineEntry[] = [];
  for (const block of topLevelBlockChildren(parsed.value.root)) {
    const anchorId = block.getAttribute(ANCHOR_ATTRIBUTE);
    if (typeof anchorId !== 'string' || anchorId.length === 0) continue;
    const tag = tagNameOf(block);
    const raw =
      (block as unknown as { textContent: string | null }).textContent ?? '';
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    const textExcerpt =
      collapsed.length > OUTLINE_TEXT_LIMIT
        ? `${collapsed.slice(0, OUTLINE_TEXT_LIMIT).trimEnd()}…`
        : collapsed;
    entries.push({ anchorId, tag, textExcerpt });
  }

  return { ok: true, value: entries };
}

// Minimal Element interface narrowing — linkedom returns full DOM-shape
// objects, but we only need this slim contract. Declaring it locally
// keeps the file free of a global DOM lib dep.
interface Element {
  tagName: string | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}
