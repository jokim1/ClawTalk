// Conversion + clipboard + file-download helpers used by the
// Copy / Export menu. The doc may be authored as markdown or HTML;
// users want to copy/export it AS any of the three formats
// (HTML / Markdown / Plain text).
//
// Conversion matrix (see plan):
//   md  → html: marked.parse()
//   md  → md  : raw body_markdown
//   md  → txt : strip-md
//   html→ html: raw body_html (already server-sanitized)
//   html→ md  : turndown(body_html)
//   html→ txt : strip-tags
//
// Clipboard writes for "Copy as HTML" set BOTH text/html and
// text/plain MIMEs so rich-text destinations (Google Docs, Substack)
// preserve formatting and plain-text destinations get a graceful
// fallback. Markdown / Plain copy use the simpler writeText path.

import { marked } from 'marked';
import TurndownService from 'turndown';

export type DocFormat = 'markdown' | 'html';

export interface DocSource {
  format: DocFormat;
  bodyMarkdown: string | null;
  bodyHtml: string | null;
}

// Configure turndown once. ATX headings (`# h1`) match the rest of
// clawtalk's markdown surface; bullet marker `-` matches the existing
// serializer output.
const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});

// Configure marked for synchronous string output without extensions.
// `breaks: false` matches CommonMark; `gfm: true` matches the markdown
// surface most users (and clawtalk's parser) treat as default.
marked.setOptions({ gfm: true, breaks: false });

export function renderHtml(src: DocSource): string {
  if (src.format === 'html') return src.bodyHtml ?? '';
  const md = src.bodyMarkdown ?? '';
  if (md.trim() === '') return '';
  // marked.parse is synchronous when no async extensions are
  // registered; cast to string for the caller.
  return marked.parse(md, { async: false }) as string;
}

export function renderMarkdown(src: DocSource): string {
  if (src.format === 'markdown') return src.bodyMarkdown ?? '';
  const html = src.bodyHtml ?? '';
  if (html.trim() === '') return '';
  return turndown.turndown(html);
}

export function renderPlainText(src: DocSource): string {
  if (src.format === 'markdown') return stripMarkdown(src.bodyMarkdown ?? '');
  return stripHtmlTags(src.bodyHtml ?? '');
}

// Tiny markdown→plain pass: strip leading bullets/heading marks,
// inline `code` / *bold* / _italic_ / [link](url) syntax, then
// collapse extra whitespace. Not a full parse — pragmatic enough for
// "paste somewhere that doesn't render markdown".
export function stripMarkdown(input: string): string {
  let text = input;
  // Fenced code blocks: drop fences, keep content
  text = text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```[^\n]*\n?/, '').replace(/```$/, ''),
  );
  // Images ![alt](url) → alt
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  // Links [text](url) → text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Headings, blockquotes, list markers at line start
  text = text.replace(/^[\s]{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^>\s?/gm, '');
  text = text.replace(/^[\s]*[-*+]\s+/gm, '');
  text = text.replace(/^[\s]*\d+\.\s+/gm, '');
  // Inline marks
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/_([^_]+)_/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');
  text = text.replace(/`([^`]+)`/g, '$1');
  // Horizontal rules
  text = text.replace(/^[\s]*(?:-{3,}|\*{3,}|_{3,})[\s]*$/gm, '');
  // Collapse 3+ newlines to 2
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

// Tiny HTML→plain pass: drop tags, decode the few entities that show
// up commonly, then collapse whitespace.
export function stripHtmlTags(input: string): string {
  let text = input;
  // Replace block-level closers with line breaks so paragraphs stay
  // separated when tags vanish.
  text = text.replace(
    /<\/(?:p|h[1-6]|li|blockquote|pre|tr|div|figcaption)>/gi,
    '\n',
  );
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(?:thead|tbody|tfoot|table)>/gi, '\n\n');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse repeated newlines + trailing whitespace
  text = text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

// ---- Clipboard ---------------------------------------------------

export async function clipboardCopyHtml(src: DocSource): Promise<void> {
  const html = renderHtml(src);
  const plain = renderPlainText(src);
  // Older browsers / test envs may not have ClipboardItem. Fall back
  // to writeText so the caller can still ship plain content rather
  // than failing the whole copy.
  if (typeof ClipboardItem === 'function') {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(plain);
}

export async function clipboardCopyMarkdown(src: DocSource): Promise<void> {
  await navigator.clipboard.writeText(renderMarkdown(src));
}

export async function clipboardCopyPlain(src: DocSource): Promise<void> {
  await navigator.clipboard.writeText(renderPlainText(src));
}

// ---- File download -----------------------------------------------

// Sanitize a doc title into a filename root. Replaces filesystem-
// hostile chars with `-`, collapses runs, strips leading/trailing
// dashes, falls back to "document" if the result is empty.
export function sanitizeFilename(input: string): string {
  const trimmed = (input ?? '').trim();
  if (trimmed === '') return 'document';
  const cleaned = trimmed
    .replace(/[\\/:*?"<>|\n\r\t]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'document' : cleaned;
}

interface DownloadOpts {
  filenameBase: string;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // Some browsers require the anchor to be in the DOM for the
    // synthetic click to fire reliably.
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Defer revoke so the download has time to start. 0ms is
    // sufficient in practice; we use a short timeout to avoid
    // revoking too early in jsdom.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function downloadAsHtml(src: DocSource, opts: DownloadOpts): void {
  const body = renderHtml(src);
  const blob = new Blob([body], { type: 'text/html;charset=utf-8' });
  triggerDownload(blob, `${sanitizeFilename(opts.filenameBase)}.html`);
}

export function downloadAsMarkdown(src: DocSource, opts: DownloadOpts): void {
  const body = renderMarkdown(src);
  const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' });
  triggerDownload(blob, `${sanitizeFilename(opts.filenameBase)}.md`);
}

export function downloadAsPlain(src: DocSource, opts: DownloadOpts): void {
  const body = renderPlainText(src);
  const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, `${sanitizeFilename(opts.filenameBase)}.txt`);
}

// True when both bodies are empty/whitespace; the menu uses this to
// disable copy/export.
export function isDocEmpty(src: DocSource): boolean {
  if (src.format === 'markdown') {
    return (src.bodyMarkdown ?? '').trim() === '';
  }
  return (src.bodyHtml ?? '').trim() === '';
}
