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

export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB
export const MAX_IMAGE_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5 MB
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
    // Dynamic import so the dependency is optional at module load time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParseMod = await import('pdf-parse');
    const pdfParse = (pdfParseMod as any).default ?? pdfParseMod;
    const data = await pdfParse(buffer, { max: 0 }); // max: 0 → all pages
    const text = data.text?.trim();
    if (!text || text.length < 10) {
      return `[Scanned PDF — no extractable text layer found in "${fileName}". OCR is not currently supported.]`;
    }
    return truncate(text);
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

const MAX_EXCEL_SHEETS = 10;

async function extractExcel(buffer: Buffer, fileName: string): Promise<string> {
  try {
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);

    const parts: string[] = [];
    let sheetCount = 0;

    for (const worksheet of workbook.worksheets) {
      if (sheetCount >= MAX_EXCEL_SHEETS) {
        parts.push(
          `\n[…${workbook.worksheets.length - MAX_EXCEL_SHEETS} additional sheet(s) omitted]`,
        );
        break;
      }

      parts.push(`\n## Sheet: ${worksheet.name}\n`);

      worksheet.eachRow((row, rowNumber) => {
        const cells = (row.values as unknown[])
          .slice(1) // ExcelJS row.values is 1-indexed, index 0 is empty
          .map((v) => {
            if (v === null || v === undefined) return '';
            if (
              typeof v === 'object' &&
              'result' in (v as Record<string, unknown>)
            ) {
              return String((v as { result: unknown }).result ?? '');
            }
            return String(v);
          });
        parts.push(`| ${cells.join(' | ')} |`);

        // Add header separator after first row
        if (rowNumber === 1) {
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
