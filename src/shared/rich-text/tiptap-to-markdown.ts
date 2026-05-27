// Tiptap JSON → Markdown serializer.
//
// Emits GitHub-Flavored Markdown for the supported subset plus our
// anchor-comment convention. Each block-level node is preceded by
// `<!-- anchor:ID -->` when its `attrs.dataAnchorId` is set, persisting
// stable block identity in the canonical markdown. The complementary
// parser in markdown-to-tiptap.ts reads these comments back.
//
// Supported (round-trip lossless):
//   nodes: paragraph, heading, blockquote, bulletList, orderedList,
//          listItem, codeBlock, horizontalRule, hardBreak
//   marks: bold, italic, strike, code, link, underline, highlight
//
// Degrades predictably (NOT round-tripped):
//   - textAlign attribute (presentation-only; reset on parse)
//   - any unknown node/mark — emitted as plain inline text or skipped
//
// Inline-mark precedence is fixed at parse time, not serialize time;
// the serializer mirrors whatever order the Tiptap doc presents.

import {
  ANCHOR_ATTR_KEY,
  type RichTextDocument,
  type RichTextMark,
  type RichTextNode,
} from './types.js';

export function tiptapJsonToMarkdown(
  doc: RichTextDocument | RichTextNode | null | undefined,
): string {
  if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return '';

  const parts: string[] = [];
  for (const node of doc.content) {
    const rendered = renderBlockNode(node, 0);
    if (rendered === null) continue;

    const anchorId =
      typeof node.attrs?.[ANCHOR_ATTR_KEY] === 'string'
        ? (node.attrs[ANCHOR_ATTR_KEY] as string)
        : null;
    if (anchorId) {
      parts.push(`<!-- anchor:${anchorId} -->\n${rendered}`);
    } else {
      parts.push(rendered);
    }
  }
  return parts.join('\n\n');
}

function renderBlockNode(node: RichTextNode, depth: number): string | null {
  switch (node.type) {
    case 'paragraph':
      return renderInlineContent(node.content);
    case 'heading': {
      const level = clampHeadingLevel(node.attrs?.level);
      return `${'#'.repeat(level)} ${renderInlineContent(node.content)}`;
    }
    case 'blockquote': {
      const inner = (node.content ?? [])
        .map((child) => renderBlockNode(child, depth) ?? '')
        .filter((s) => s.length > 0)
        .join('\n\n');
      return inner
        .split('\n')
        .map((line) => (line.length > 0 ? `> ${line}` : '>'))
        .join('\n');
    }
    case 'bulletList':
      return renderList(node.content, depth, 'bullet');
    case 'orderedList':
      return renderList(node.content, depth, 'ordered');
    case 'codeBlock': {
      const language =
        typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      const code = renderPlainTextContent(node.content);
      return `\`\`\`${language}\n${code}\n\`\`\``;
    }
    case 'horizontalRule':
      return '---';
    case 'hardBreak':
      return '';
    case 'image': {
      // Top-level (block) image. Tiptap's Image extension is block by
      // default — a Google-Docs paste of a standalone `<img>` lands as
      // its own block node, NOT inside a paragraph. Without this case
      // the default branch hit `renderInlineContent(node.content)`
      // which returned `''` for a leaf node and silently dropped the
      // image from the saved markdown. Inline images inside paragraphs
      // are handled by renderInlineContent's image case as well.
      const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
      if (src.length === 0) return null;
      const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
      return `![${alt}](${src})`;
    }
    default:
      // Unknown block — degrade to plain text so user content is not lost.
      return renderInlineContent(node.content);
  }
}

function renderList(
  items: RichTextNode[] | undefined,
  depth: number,
  kind: 'bullet' | 'ordered',
): string {
  if (!items || items.length === 0) return '';
  return items
    .map((item, index) => {
      const indent = '  '.repeat(depth);
      const prefix = kind === 'ordered' ? `${index + 1}. ` : '- ';
      const body = renderListItemContent(item.content, depth);
      // Indent continuation lines inside multi-paragraph items.
      const lines = body.split('\n');
      return lines
        .map((line, idx) =>
          idx === 0
            ? `${indent}${prefix}${line}`
            : `${indent}${' '.repeat(prefix.length)}${line}`,
        )
        .join('\n');
    })
    .join('\n');
}

function renderListItemContent(
  content: RichTextNode[] | undefined,
  depth: number,
): string {
  if (!content || content.length === 0) return '';
  const parts: string[] = [];
  for (const child of content) {
    if (child.type === 'paragraph') {
      parts.push(renderInlineContent(child.content));
    } else if (child.type === 'bulletList' || child.type === 'orderedList') {
      parts.push(
        '\n' +
          renderList(
            child.content,
            depth + 1,
            child.type === 'bulletList' ? 'bullet' : 'ordered',
          ),
      );
    } else {
      const rendered = renderBlockNode(child, depth);
      if (rendered !== null && rendered.length > 0) parts.push(rendered);
    }
  }
  return parts.join('\n');
}

function renderInlineContent(content: RichTextNode[] | undefined): string {
  if (!content) return '';
  return content
    .map((node) => {
      if (node.type === 'text') return applyMarks(node.text ?? '', node.marks);
      if (node.type === 'hardBreak') return '  \n';
      if (node.type === 'image') {
        const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
        const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
        if (src.length === 0) return '';
        return `![${alt}](${src})`;
      }
      // Nested inline: recurse.
      return renderInlineContent(node.content);
    })
    .join('');
}

function renderPlainTextContent(content: RichTextNode[] | undefined): string {
  if (!content) return '';
  return content
    .map((node) => {
      if (node.type === 'text') return node.text ?? '';
      if (node.type === 'hardBreak') return '\n';
      return renderPlainTextContent(node.content);
    })
    .join('');
}

function applyMarks(text: string, marks: RichTextMark[] | undefined): string {
  if (!marks || marks.length === 0) return text;
  let out = text;
  // Apply innermost-to-outermost: code first (no nesting inside), then
  // text styling. Link wraps last so its brackets stay outermost.
  const ordered = orderMarks(marks);
  for (const mark of ordered) {
    out = applyMark(out, mark);
  }
  return out;
}

function orderMarks(marks: RichTextMark[]): RichTextMark[] {
  // Stable order: code (innermost) → bold → italic → strike → underline
  // → highlight → link (outermost). Anything not in this list keeps
  // input order at the end.
  const priority: Record<string, number> = {
    code: 0,
    bold: 1,
    italic: 2,
    strike: 3,
    underline: 4,
    highlight: 5,
    link: 6,
  };
  return [...marks].sort((a, b) => {
    const ap = priority[a.type] ?? 100;
    const bp = priority[b.type] ?? 100;
    return ap - bp;
  });
}

function applyMark(text: string, mark: RichTextMark): string {
  switch (mark.type) {
    case 'bold':
      return `**${text}**`;
    case 'italic':
      return `*${text}*`;
    case 'strike':
      return `~~${text}~~`;
    case 'code':
      return `\`${text}\``;
    case 'underline':
      return `<u>${text}</u>`;
    case 'highlight':
      return `==${text}==`;
    case 'link': {
      const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';
      const safeHref = href
        .replace(/ /g, '%20')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29');
      return `[${text}](${safeHref})`;
    }
    default:
      return text;
  }
}

function clampHeadingLevel(value: unknown): number {
  const n = typeof value === 'number' ? value : 1;
  if (!Number.isFinite(n)) return 1;
  return Math.min(6, Math.max(1, Math.floor(n)));
}
