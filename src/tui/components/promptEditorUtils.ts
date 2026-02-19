import { preWrapText } from '../lineCount.js';

export interface VisualLine {
  text: string;
  start: number;
  end: number;
}

export interface VisualLayout {
  lines: VisualLine[];
  cursorRow: number;
  cursorCol: number;
}

const ANSI_ESCAPE_RE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|[@-_])/g;

export function sanitizePromptInput(raw: string): string {
  return raw
    .replace(/\u001b\[200~/g, '')
    .replace(/\u001b\[201~/g, '')
    .replace(ANSI_ESCAPE_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

export function wrapForTerminal(text: string, width: number): string[] {
  const normalized = sanitizePromptInput(text);
  if (!normalized) return [''];
  if (width <= 0) return [normalized];
  const wrapped = preWrapText(normalized, width);
  return wrapped.split('\n');
}

export function buildVisualLayout(text: string, cursor: number, width: number): VisualLayout {
  const normalized = sanitizePromptInput(text);
  const safeCursor = Math.max(0, Math.min(cursor, normalized.length));
  const safeWidth = Math.max(1, width);

  const lines: VisualLine[] = [];
  let lineStart = 0;
  let visualWidth = 0;

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === '\n') {
      lines.push({ text: normalized.slice(lineStart, i), start: lineStart, end: i });
      lineStart = i + 1;
      visualWidth = 0;
      continue;
    }
    visualWidth += 1;
    if (visualWidth >= safeWidth) {
      lines.push({ text: normalized.slice(lineStart, i + 1), start: lineStart, end: i + 1 });
      lineStart = i + 1;
      visualWidth = 0;
    }
  }

  if (lineStart <= normalized.length) {
    lines.push({ text: normalized.slice(lineStart), start: lineStart, end: normalized.length });
  }
  if (lines.length === 0) {
    lines.push({ text: '', start: 0, end: 0 });
  }

  let cursorRow = lines.length - 1;
  let cursorCol = lines[cursorRow].end - lines[cursorRow].start;
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row];
    if (safeCursor >= line.start && safeCursor <= line.end) {
      cursorRow = row;
      cursorCol = Math.max(0, safeCursor - line.start);
      break;
    }
  }

  return { lines, cursorRow, cursorCol };
}

export function moveCursorByVisualRow(
  text: string,
  cursor: number,
  width: number,
  direction: -1 | 1,
  preferredCol?: number | null,
): { cursor: number; preferredCol: number | null } {
  const layout = buildVisualLayout(text, cursor, width);
  const targetRow = layout.cursorRow + direction;
  if (targetRow < 0 || targetRow >= layout.lines.length) {
    return { cursor, preferredCol: preferredCol ?? null };
  }
  const preferred = preferredCol ?? layout.cursorCol;
  const line = layout.lines[targetRow];
  const nextCursor = Math.min(line.start + preferred, line.end);
  return { cursor: nextCursor, preferredCol: preferred };
}

export function computeVisibleWindow(
  rowCount: number,
  cursorRow: number,
  maxVisibleLines: number,
): { start: number; end: number } {
  if (rowCount <= 0 || maxVisibleLines <= 0) return { start: 0, end: 0 };
  if (rowCount <= maxVisibleLines) return { start: 0, end: rowCount };

  const half = Math.floor(maxVisibleLines / 2);
  let start = Math.max(0, cursorRow - half);
  let end = start + maxVisibleLines;
  if (end > rowCount) {
    end = rowCount;
    start = Math.max(0, end - maxVisibleLines);
  }
  return { start, end };
}
