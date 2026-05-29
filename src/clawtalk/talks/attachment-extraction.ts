import path from 'path';

import { extractTextFromHtml } from './source-ingestion.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EXTRACTED_CHARS = 50_000;
const TRUNCATION_MARKER = '\n\n[…truncated — content exceeds extraction limit]';

// ---------------------------------------------------------------------------
// MIME type allow-list
// ---------------------------------------------------------------------------

export const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  // Text-based (existing)
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  // NEW: RTF
  'text/rtf',
  'application/rtf',
  // NEW: Code / structured data (treated as plain text)
  'text/xml',
  'application/json',
  'application/xml',
  'text/yaml',
  'text/x-yaml',
  'application/x-yaml',
  'text/x-python',
  'text/x-java',
  'text/javascript',
  'application/javascript',
  'text/typescript',
  'text/x-c',
  'text/x-c++',
  'text/x-go',
  'text/x-rust',
  'text/x-shellscript',
  'text/x-sql',
  // Documents (existing + PPTX)
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export const ALLOWED_IMAGE_ATTACHMENT_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export const ALLOWED_UPLOAD_ATTACHMENT_MIME_TYPES = new Set([
  ...ALLOWED_ATTACHMENT_MIME_TYPES,
  ...ALLOWED_IMAGE_ATTACHMENT_MIME_TYPES,
]);

const SUPPORTED_ATTACHMENT_EXTENSION_MIME_MAP: Record<string, string> = {
  // Text-based
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.rtf': 'text/rtf',
  // Code / structured data
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.py': 'text/x-python',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.jsx': 'text/javascript',
  '.tsx': 'text/typescript',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.hpp': 'text/x-c++',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.sql': 'text/x-sql',
  '.rb': 'text/plain',
  '.php': 'text/plain',
  '.swift': 'text/plain',
  '.kt': 'text/plain',
  '.lua': 'text/plain',
  '.r': 'text/plain',
  '.toml': 'text/plain',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.env': 'text/plain',
  '.log': 'text/plain',
  // Documents
  '.pdf': 'application/pdf',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Images recognized by the current Talk UI
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25 MB
export const MAX_IMAGE_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

function normalizeMimeType(mimeType: string | null | undefined): string | null {
  const trimmed = mimeType?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

export function isImageAttachmentMimeType(mimeType: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  return normalized
    ? ALLOWED_IMAGE_ATTACHMENT_MIME_TYPES.has(normalized)
    : false;
}

export function inferSupportedAttachmentMimeType(
  fileName: string,
  providedMimeType?: string | null,
): string | null {
  const normalized = normalizeMimeType(providedMimeType);
  if (normalized && ALLOWED_UPLOAD_ATTACHMENT_MIME_TYPES.has(normalized)) {
    return normalized;
  }

  const ext = path.extname(fileName).toLowerCase();
  if (ext) {
    const inferred = SUPPORTED_ATTACHMENT_EXTENSION_MIME_MAP[ext];
    if (inferred) return inferred;
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class AttachmentExtractionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AttachmentExtractionError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Truncation helper
// ---------------------------------------------------------------------------

function truncate(text: string): string {
  if (text.length <= MAX_EXTRACTED_CHARS) return text;
  return text.slice(0, MAX_EXTRACTED_CHARS) + TRUNCATION_MARKER;
}

// ---------------------------------------------------------------------------
// NUL byte sanitization
// ---------------------------------------------------------------------------

const NULL_BYTE = String.fromCharCode(0);

/**
 * Postgres `text`/`varchar` columns reject NUL (U+0000) outright —
 * `invalid byte sequence for encoding "UTF8": 0x00`. `unpdf` (and other
 * extractors) can emit NUL where they fail to map a glyph — observed on
 * Substack-exported PDFs, which encoded "(" and "-" as NUL — so we strip it
 * from every extraction result before it can reach the DB. Mildly lossy
 * (the unmapped glyph is dropped) but it's the only safe option for text
 * storage; the alternative is the hard upload failure we're fixing here.
 */
export function stripNullBytes(text: string): string {
  return text.includes(NULL_BYTE) ? text.split(NULL_BYTE).join('') : text;
}

// ---------------------------------------------------------------------------
// Text-based extraction (plain text, markdown, CSV)
// ---------------------------------------------------------------------------

function extractTextDirect(buffer: Buffer): string {
  return truncate(buffer.toString('utf-8'));
}

// ---------------------------------------------------------------------------
// HTML extraction
// ---------------------------------------------------------------------------

function extractHtml(buffer: Buffer): string {
  const html = buffer.toString('utf-8');
  const text = extractTextFromHtml(html);
  return truncate(text);
}

// ---------------------------------------------------------------------------
// PDF extraction (lazy-loaded)
// ---------------------------------------------------------------------------

async function extractPdf(buffer: Buffer, fileName: string): Promise<string> {
  try {
    // unpdf is a serverless-runtime fork of pdfjs that strips the
    // browser DOM globals (DOMMatrix, Path2D, ImageData) the upstream
    // pdfjs-dist references. Works on Workers under nodejs_compat,
    // unlike pdf-parse@2 (which transitively pulled in pdfjs-dist@5
    // and threw "DOMMatrix is not defined" on the isolate).
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    const merged = (Array.isArray(text) ? text.join('\n\n') : text).trim();
    if (!merged || merged.length < 10) {
      return `[Scanned PDF — no extractable text layer found in "${fileName}". OCR is not currently supported.]`;
    }
    return truncate(merged);
  } catch (err) {
    throw new AttachmentExtractionError(
      'pdf_extraction_failed',
      `Failed to extract text from PDF "${fileName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// DOCX extraction (lazy-loaded)
// ---------------------------------------------------------------------------

async function extractDocx(buffer: Buffer, fileName: string): Promise<string> {
  try {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value?.trim();
    if (!text) {
      return `[Empty DOCX document: "${fileName}"]`;
    }
    return truncate(text);
  } catch (err) {
    throw new AttachmentExtractionError(
      'docx_extraction_failed',
      `Failed to extract text from DOCX "${fileName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Excel extraction (lazy-loaded)
// ---------------------------------------------------------------------------
//
// Uses SheetJS (`xlsx`) rather than ExcelJS. On a real 2 MB financial-statement
// spreadsheet (20 sheets, ~2.4 MB calcChain.xml, 7.5 MB largest sheet XML),
// ExcelJS allocated ~190 MB of JS heap during `xlsx.load()`, exceeding the
// Cloudflare Workers 128 MB per-isolate cap and producing a 503 when the
// runtime killed the isolate. SheetJS parses the same file with ~18 MB of
// additional heap and finishes in ~350 ms locally, so the upload completes
// within Worker limits.

const MAX_EXCEL_SHEETS = 10;

async function extractExcel(buffer: Buffer, fileName: string): Promise<string> {
  try {
    const XLSX = await import('xlsx');
    // Disable formula/style/date parsing — we only want cell values for text
    // extraction, and skipping these flags cuts another ~30% off heap usage.
    const workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellFormula: false,
      cellStyles: false,
      cellDates: false,
    });

    const sheetNames = workbook.SheetNames;
    if (sheetNames.length === 0) {
      return `[Empty spreadsheet: "${fileName}"]`;
    }

    const parts: string[] = [];
    let sheetCount = 0;

    for (const name of sheetNames) {
      if (sheetCount >= MAX_EXCEL_SHEETS) {
        parts.push(
          `\n[…${sheetNames.length - MAX_EXCEL_SHEETS} additional sheet(s) omitted]`,
        );
        break;
      }

      const sheet = workbook.Sheets[name];
      if (!sheet) {
        sheetCount += 1;
        continue;
      }

      parts.push(`\n## Sheet: ${name}\n`);

      // sheet_to_json with header:1 yields a 2-D array of cell values, which
      // gives us full control over the markdown table formatting (matching
      // the prior ExcelJS-based output: `| ... | ... |` rows with a `---`
      // separator under the first row).
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        defval: '',
        blankrows: false,
        raw: true,
      });

      rows.forEach((row, idx) => {
        const cells = row.map((v) => (v == null ? '' : String(v)));
        parts.push(`| ${cells.join(' | ')} |`);
        if (idx === 0) {
          parts.push(`| ${cells.map(() => '---').join(' | ')} |`);
        }
      });

      sheetCount += 1;
    }

    const text = parts.join('\n').trim();
    if (!text) {
      return `[Empty spreadsheet: "${fileName}"]`;
    }
    return truncate(text);
  } catch (err) {
    throw new AttachmentExtractionError(
      'excel_extraction_failed',
      `Failed to extract data from spreadsheet "${fileName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// PPTX extraction (lazy-loaded)
// ---------------------------------------------------------------------------

const MAX_PPTX_SLIDES = 100;

async function extractPptx(buffer: Buffer, fileName: string): Promise<string> {
  try {
    const JSZip = await import('jszip');
    const zip = await JSZip.default.loadAsync(buffer);

    // Collect slide entries sorted numerically (slide1.xml, slide2.xml, …)
    const slideEntries: Array<{ num: number; path: string }> = [];
    zip.forEach((relativePath) => {
      const match = relativePath.match(/^ppt\/slides\/slide(\d+)\.xml$/);
      if (match) {
        slideEntries.push({ num: parseInt(match[1], 10), path: relativePath });
      }
    });
    slideEntries.sort((a, b) => a.num - b.num);

    if (slideEntries.length === 0) {
      return `[Empty PPTX presentation: "${fileName}"]`;
    }

    const parts: string[] = [];

    for (const entry of slideEntries.slice(0, MAX_PPTX_SLIDES)) {
      const xml = await zip.file(entry.path)!.async('string');
      // Extract text runs (<a:t> elements) from the slide XML
      const textRuns = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(
        (m) => m[1],
      );
      if (textRuns.length > 0) {
        parts.push(`\n--- Slide ${entry.num} ---\n`);
        parts.push(textRuns.join(' '));
      }
    }

    if (slideEntries.length > MAX_PPTX_SLIDES) {
      parts.push(
        `\n[…${slideEntries.length - MAX_PPTX_SLIDES} additional slide(s) omitted]`,
      );
    }

    // Also attempt to extract speaker notes
    const noteEntries: Array<{ num: number; path: string }> = [];
    zip.forEach((relativePath) => {
      const match = relativePath.match(
        /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/,
      );
      if (match) {
        noteEntries.push({ num: parseInt(match[1], 10), path: relativePath });
      }
    });
    noteEntries.sort((a, b) => a.num - b.num);

    if (noteEntries.length > 0) {
      parts.push('\n\n--- Speaker Notes ---\n');
      for (const entry of noteEntries.slice(0, MAX_PPTX_SLIDES)) {
        const xml = await zip.file(entry.path)!.async('string');
        const textRuns = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(
          (m) => m[1],
        );
        if (textRuns.length > 0) {
          parts.push(`Note (slide ${entry.num}): ${textRuns.join(' ')}`);
        }
      }
    }

    const text = parts.join('\n').trim();
    if (!text) {
      return `[Empty PPTX presentation: "${fileName}"]`;
    }
    return truncate(text);
  } catch (err) {
    throw new AttachmentExtractionError(
      'pptx_extraction_failed',
      `Failed to extract text from PPTX "${fileName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// RTF extraction
// ---------------------------------------------------------------------------

function extractRtf(buffer: Buffer): string {
  const raw = buffer.toString('utf-8');

  let text = raw
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\u(\d+)\??/g, (_m, code) =>
      String.fromCodePoint(parseInt(code, 10)),
    )
    .replace(/\\par\b/g, '\n')
    .replace(/\\line\b/g, '\n')
    .replace(/\\tab\b/g, '\t')
    .replace(
      /\{\\(?:fonttbl|colortbl|stylesheet|info|pict|object)\b[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g,
      '',
    )
    .replace(/\\[a-z]+\d*\s?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');

  text = text.trim();
  if (!text) return '[Empty RTF document]';
  return truncate(text);
}

// ---------------------------------------------------------------------------
// Code MIME types set
// ---------------------------------------------------------------------------

const CODE_MIME_TYPES = new Set([
  'text/xml',
  'application/json',
  'application/xml',
  'text/yaml',
  'text/x-yaml',
  'application/x-yaml',
  'text/x-python',
  'text/x-java',
  'text/javascript',
  'application/javascript',
  'text/typescript',
  'text/x-c',
  'text/x-c++',
  'text/x-go',
  'text/x-rust',
  'text/x-shellscript',
  'text/x-sql',
]);

// ---------------------------------------------------------------------------
// Router: dispatch to the appropriate extractor
// ---------------------------------------------------------------------------

export async function extractAttachmentText(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<string> {
  // Single sanitization chokepoint: every branch in the router below
  // flows through here, so NUL bytes are stripped before extracted text
  // can reach a Postgres text column (see stripNullBytes).
  return stripNullBytes(
    await routeAttachmentExtraction(buffer, mimeType, fileName),
  );
}

async function routeAttachmentExtraction(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<string> {
  switch (mimeType) {
    case 'text/plain':
    case 'text/markdown':
    case 'text/csv':
      return extractTextDirect(buffer);

    case 'text/html':
      return extractHtml(buffer);

    case 'text/rtf':
    case 'application/rtf':
      return extractRtf(buffer);

    case 'application/pdf':
      return extractPdf(buffer, fileName);

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractDocx(buffer, fileName);

    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return extractExcel(buffer, fileName);

    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return extractPptx(buffer, fileName);

    default:
      if (CODE_MIME_TYPES.has(mimeType)) {
        return extractTextDirect(buffer);
      }
      // Best-effort: treat as UTF-8 text
      return truncate(buffer.toString('utf-8'));
  }
}
