// Markdown → Tiptap JSON parser.
//
// Handles the supported subset locked in the plan: paragraphs,
// headings (H1–H6), blockquotes, bullet/ordered lists with one level
// of nesting, fenced code blocks, horizontal rules, plus the inline
// marks bold/italic/strike/code/link/underline/highlight and hard
// breaks. Anchor IDs persisted as `<!-- anchor:XXXX -->` HTML comments
// before each block are restored onto the next block node's
// `attrs.dataAnchorId`.
//
// Hand-written rather than pulling in marked/markdown-it because we
// need bidirectional fidelity with the serializer in this directory,
// not CommonMark conformance. Bringing in a generic markdown library
// would mean a custom AST→Tiptap mapping layer anyway and bigger
// worker bundles for no upside on round-trip stability.
//
// What this parser is NOT:
//   - A CommonMark-conformant parser (no setext headings, no link
//     references, no autolinks, no entity decoding beyond what marks
//     and inline elements require).
//   - A safe HTML parser. Raw HTML other than our recognized
//     `<u>...</u>` underline tag and `<!-- anchor:... -->` comments
//     is treated as literal text. The sanitize module trims dangerous
//     constructs upstream of parse.

import {
  ANCHOR_ATTR_KEY,
  type RichTextDocument,
  type RichTextMark,
  type RichTextNode,
} from './types.js';

const ANCHOR_LINE_RE = /^<!--\s*anchor:([A-Za-z0-9_-]+)\s*-->\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^```(\S*)\s*$/;
const HR_RE = /^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/;
const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d+)\.\s+(.*)$/;

export function markdownToTiptapJson(markdown: string): RichTextDocument {
  const normalized = (markdown ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const blocks = parseBlocks(lines, 0, lines.length, 0);
  return {
    type: 'doc',
    content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }],
  };
}

function parseBlocks(
  lines: string[],
  start: number,
  end: number,
  listIndent: number,
): RichTextNode[] {
  const blocks: RichTextNode[] = [];
  let pendingAnchor: string | null = null;
  let i = start;

  while (i < end) {
    const line = lines[i];

    const anchorMatch = line.match(ANCHOR_LINE_RE);
    if (anchorMatch) {
      pendingAnchor = anchorMatch[1];
      i++;
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(
        attachAnchor(
          {
            type: 'heading',
            attrs: { level },
            content: parseInline(headingMatch[2]),
          },
          pendingAnchor,
        ),
      );
      pendingAnchor = null;
      i++;
      continue;
    }

    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const language = fenceMatch[1];
      const codeLines: string[] = [];
      i++;
      while (i < end && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < end) i++; // consume closing fence
      const node: RichTextNode = {
        type: 'codeBlock',
        attrs: language ? { language } : {},
      };
      if (codeLines.length > 0) {
        node.content = [{ type: 'text', text: codeLines.join('\n') }];
      }
      blocks.push(attachAnchor(node, pendingAnchor));
      pendingAnchor = null;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push(attachAnchor({ type: 'horizontalRule' }, pendingAnchor));
      pendingAnchor = null;
      i++;
      continue;
    }

    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < end && lines[i].startsWith('>')) {
        // strip one level of "> " (or just ">") prefix
        const stripped = lines[i].replace(/^>\s?/, '');
        quoteLines.push(stripped);
        i++;
      }
      const inner = parseBlocks(quoteLines, 0, quoteLines.length, 0);
      blocks.push(
        attachAnchor({ type: 'blockquote', content: inner }, pendingAnchor),
      );
      pendingAnchor = null;
      continue;
    }

    const bulletMatch = line.match(BULLET_RE);
    const orderedMatch = line.match(ORDERED_RE);
    if (
      (bulletMatch && bulletMatch[1].length === listIndent) ||
      (orderedMatch && orderedMatch[1].length === listIndent)
    ) {
      const kind: 'bullet' | 'ordered' = bulletMatch ? 'bullet' : 'ordered';
      const { node, consumed } = parseList(lines, i, end, listIndent, kind);
      blocks.push(attachAnchor(node, pendingAnchor));
      pendingAnchor = null;
      i += consumed;
      continue;
    }

    // Paragraph: consecutive non-blank, non-block-start lines.
    const paraLines: string[] = [];
    while (i < end && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push(
        attachAnchor(
          {
            type: 'paragraph',
            content: parseInline(paraLines.join('\n')),
          },
          pendingAnchor,
        ),
      );
      pendingAnchor = null;
    }
  }

  return blocks;
}

function isBlockStart(line: string): boolean {
  return (
    ANCHOR_LINE_RE.test(line) ||
    HEADING_RE.test(line) ||
    FENCE_RE.test(line) ||
    HR_RE.test(line) ||
    line.startsWith('>') ||
    BULLET_RE.test(line) ||
    ORDERED_RE.test(line)
  );
}

function parseList(
  lines: string[],
  start: number,
  end: number,
  baseIndent: number,
  kind: 'bullet' | 'ordered',
): { node: RichTextNode; consumed: number } {
  const items: RichTextNode[] = [];
  let i = start;

  while (i < end) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const m =
      kind === 'bullet' ? line.match(BULLET_RE) : line.match(ORDERED_RE);
    if (!m || m[1].length !== baseIndent) break;

    const firstBody = m[3];
    const bodyLines: string[] = [firstBody];
    i++;

    // Collect continuation / nested lines belonging to this item.
    while (i < end) {
      const next = lines[i];
      if (next.trim() === '') {
        // Blank line could still belong to this item if followed by
        // indented content. Peek: if next non-blank line is indented
        // deeper, keep accumulating; else stop.
        let j = i + 1;
        while (j < end && lines[j].trim() === '') j++;
        if (j < end) {
          const peek = lines[j];
          if (peek.startsWith(' '.repeat(baseIndent + 2))) {
            bodyLines.push('');
            i++;
            continue;
          }
        }
        break;
      }
      const nextBullet = next.match(BULLET_RE);
      const nextOrdered = next.match(ORDERED_RE);
      const sameLevelBullet = nextBullet && nextBullet[1].length === baseIndent;
      const sameLevelOrdered =
        nextOrdered && nextOrdered[1].length === baseIndent;
      if (sameLevelBullet || sameLevelOrdered) break;

      // Lines indented at least baseIndent+2 belong to this item.
      if (next.startsWith(' '.repeat(baseIndent + 2))) {
        bodyLines.push(next.slice(baseIndent + 2));
        i++;
        continue;
      }
      // Non-indented continuation (lazy continuation paragraph).
      if (!isBlockStart(next)) {
        bodyLines.push(next);
        i++;
        continue;
      }
      break;
    }

    const itemContent = parseListItemBody(bodyLines);
    items.push({ type: 'listItem', content: itemContent });
  }

  return {
    node: {
      type: kind === 'bullet' ? 'bulletList' : 'orderedList',
      content: items,
    },
    consumed: i - start,
  };
}

function parseListItemBody(bodyLines: string[]): RichTextNode[] {
  // Wrap the first contiguous run of non-block-start, non-blank lines
  // into a paragraph; recurse into the rest for nested lists / blocks.
  const firstParaLines: string[] = [];
  let i = 0;
  while (
    i < bodyLines.length &&
    bodyLines[i].trim() !== '' &&
    !isBlockStart(bodyLines[i])
  ) {
    firstParaLines.push(bodyLines[i]);
    i++;
  }
  const result: RichTextNode[] = [];
  if (firstParaLines.length > 0) {
    result.push({
      type: 'paragraph',
      content: parseInline(firstParaLines.join('\n')),
    });
  }
  if (i < bodyLines.length) {
    const rest = bodyLines.slice(i);
    const nested = parseBlocks(rest, 0, rest.length, 0);
    for (const node of nested) result.push(node);
  }
  return result;
}

function attachAnchor(
  node: RichTextNode,
  anchorId: string | null,
): RichTextNode {
  if (!anchorId) return node;
  return {
    ...node,
    attrs: { ...(node.attrs ?? {}), [ANCHOR_ATTR_KEY]: anchorId },
  };
}

// ── Inline parser ─────────────────────────────────────────────────

export function parseInline(text: string): RichTextNode[] {
  const nodes: RichTextNode[] = [];
  let buf = '';
  let pos = 0;

  const flush = () => {
    if (buf.length > 0) {
      nodes.push({ type: 'text', text: buf });
      buf = '';
    }
  };

  while (pos < text.length) {
    const rest = text.slice(pos);

    // hard break: two trailing spaces before newline
    if (rest.startsWith('  \n')) {
      flush();
      nodes.push({ type: 'hardBreak' });
      pos += 3;
      continue;
    }

    // code span
    if (rest[0] === '`') {
      const close = rest.indexOf('`', 1);
      if (close > 1) {
        flush();
        nodes.push({
          type: 'text',
          text: rest.slice(1, close),
          marks: [{ type: 'code' }],
        });
        pos += close + 1;
        continue;
      }
    }

    // image ![alt](url) — must come BEFORE link so the leading `!` is
    // handled. Images are inline nodes (Tiptap models them this way),
    // not blocks, so they live alongside text inside paragraphs.
    if (rest[0] === '!' && rest[1] === '[') {
      const imgMatch = matchLink(rest.slice(1));
      if (imgMatch) {
        flush();
        const attrs: Record<string, string> = { src: imgMatch.href };
        if (imgMatch.text.length > 0) attrs.alt = imgMatch.text;
        nodes.push({ type: 'image', attrs });
        pos += imgMatch.consumed + 1; // +1 for the leading `!`
        continue;
      }
    }

    // link [text](url)
    if (rest[0] === '[') {
      const linkMatch = matchLink(rest);
      if (linkMatch) {
        flush();
        const inner = parseInline(linkMatch.text);
        for (const node of inner) {
          nodes.push(
            addMark(node, { type: 'link', attrs: { href: linkMatch.href } }),
          );
        }
        pos += linkMatch.consumed;
        continue;
      }
    }

    // delimiter-paired marks
    const delim = tryDelimitedMark(rest);
    if (delim) {
      flush();
      const inner = parseInline(delim.inner);
      for (const node of inner) {
        nodes.push(addMark(node, delim.mark));
      }
      pos += delim.consumed;
      continue;
    }

    // Escape: backslash + ASCII punctuation passes literal
    if (rest[0] === '\\' && rest.length > 1) {
      buf += rest[1];
      pos += 2;
      continue;
    }

    buf += rest[0];
    pos++;
  }

  flush();
  return nodes;
}

function matchLink(
  text: string,
): { text: string; href: string; consumed: number } | null {
  if (text[0] !== '[') return null;
  let depth = 1;
  let i = 1;
  while (i < text.length && depth > 0) {
    if (text[i] === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (text[i] === '[') depth++;
    else if (text[i] === ']') depth--;
    if (depth === 0) break;
    i++;
  }
  if (depth !== 0) return null;
  const closeBracket = i;
  if (text[closeBracket + 1] !== '(') return null;
  const closeParen = text.indexOf(')', closeBracket + 2);
  if (closeParen === -1) return null;
  return {
    text: text.slice(1, closeBracket),
    href: text.slice(closeBracket + 2, closeParen),
    consumed: closeParen + 1,
  };
}

interface DelimitedMatch {
  inner: string;
  mark: RichTextMark;
  consumed: number;
}

const DELIMITERS: Array<{ open: string; close: string; mark: RichTextMark }> = [
  { open: '**', close: '**', mark: { type: 'bold' } },
  { open: '~~', close: '~~', mark: { type: 'strike' } },
  { open: '==', close: '==', mark: { type: 'highlight' } },
  { open: '<u>', close: '</u>', mark: { type: 'underline' } },
  { open: '*', close: '*', mark: { type: 'italic' } },
];

function tryDelimitedMark(text: string): DelimitedMatch | null {
  for (const d of DELIMITERS) {
    if (!text.startsWith(d.open)) continue;
    const after = text.slice(d.open.length);
    // Find closing delim; must have at least one char of inner content.
    let searchFrom = 0;
    let closeIdx = -1;
    while (searchFrom < after.length) {
      const idx = after.indexOf(d.close, searchFrom);
      if (idx === -1) break;
      // skip escaped close: not supported uniformly, but for `*` keep
      // it simple — first occurrence wins.
      closeIdx = idx;
      break;
    }
    if (closeIdx <= 0) continue;
    return {
      inner: after.slice(0, closeIdx),
      mark: d.mark,
      consumed: d.open.length + closeIdx + d.close.length,
    };
  }
  return null;
}

function addMark(node: RichTextNode, mark: RichTextMark): RichTextNode {
  // Outer mark goes at the end of the marks list (inside-out per the
  // serializer ordering — bold first, link last).
  const marks = [...(node.marks ?? []), mark];
  return { ...node, marks };
}
