/**
 * File Processing Service
 *
 * Unified file processing for attachments:
 * - Images: delegates to processImage() for base64 encoding
 * - PDFs: extracts text via macOS Quartz/PDFDocument
 * - Text files: reads as UTF-8
 *
 * Also provides file path detection for inline message scanning.
 */

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { processImage } from './image.js';
import type { PendingAttachment } from '../types.js';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic']);
const PDF_EXTENSIONS = new Set(['.pdf']);
const DOCX_EXTENSIONS = new Set(['.docx', '.doc', '.rtf']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.log', '.vtt', '.srt', '.json', '.xml']);
const MAX_TEXT_SIZE = 512 * 1024; // 512KB max for text files
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB max for file uploads

export type ProcessedFile =
  | { type: 'image'; attachment: PendingAttachment }
  | { type: 'document'; text: string; filename: string; sizeBytes: number; pageCount?: number };

function resolvePath(filePath: string): string {
  return filePath.startsWith('~/')
    ? join(process.env.HOME || '', filePath.slice(2))
    : filePath;
}

function getSupportedExtensions(): string[] {
  return [...IMAGE_EXTENSIONS, ...PDF_EXTENSIONS, ...DOCX_EXTENSIONS, ...TEXT_EXTENSIONS];
}

export function isSupportedFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) || PDF_EXTENSIONS.has(ext) || DOCX_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext);
}

/**
 * Process a local file for sending to the gateway.
 * Returns image attachment data or extracted document text.
 */
export async function processFile(filePath: string): Promise<ProcessedFile> {
  const resolved = resolvePath(filePath);
  const ext = extname(resolved).toLowerCase();

  if (IMAGE_EXTENSIONS.has(ext)) {
    // processImage does its own ~ expansion
    const attachment = await processImage(filePath);
    return { type: 'image', attachment };
  }

  if (PDF_EXTENSIONS.has(ext)) {
    return await extractPdfText(resolved);
  }

  if (DOCX_EXTENSIONS.has(ext)) {
    return await extractDocxText(resolved);
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    return await readTextFile(resolved);
  }

  const supported = getSupportedExtensions().map(e => e.slice(1)).join(', ');
  throw new Error(`Unsupported file type: ${ext}. Supported: ${supported}`);
}

/**
 * Extract text from a PDF.
 *
 * Uses pdftotext (poppler) as primary method, falls back to
 * macOS Quartz/PDFDocument via Python 3 if pdftotext is not available.
 */
async function extractPdfText(filePath: string): Promise<ProcessedFile> {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) throw new Error(`File not found: ${filePath}`);

  // Try pdftotext first (from poppler, commonly available via brew)
  try {
    const result = await extractWithPdftotext(filePath);
    return { ...result, sizeBytes: fileStat.size, filename: basename(filePath) };
  } catch {
    // pdftotext not available or failed — try PyObjC fallback
  }

  try {
    const result = await extractWithQuartz(filePath);
    return { ...result, sizeBytes: fileStat.size, filename: basename(filePath) };
  } catch {
    // PyObjC also failed
  }

  throw new Error('PDF extraction requires pdftotext (brew install poppler) or macOS Python with PyObjC');
}

function execFilePromise(cmd: string, args: string[], opts?: { timeout?: number; maxBuffer?: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve({ stdout, stderr });
    });
  });
}

async function extractWithPdftotext(filePath: string): Promise<{ type: 'document'; text: string; pageCount?: number }> {
  // Extract text: pdftotext <file> - (output to stdout)
  const { stdout: text } = await execFilePromise('pdftotext', [filePath, '-']);
  if (!text.trim()) throw new Error('No text content');

  // Get page count via pdfinfo
  let pageCount: number | undefined;
  try {
    const { stdout: info } = await execFilePromise('pdfinfo', [filePath]);
    const match = info.match(/Pages:\s+(\d+)/);
    if (match) pageCount = parseInt(match[1], 10);
  } catch { /* pdfinfo not critical */ }

  return { type: 'document', text: text.trim(), pageCount };
}

async function extractWithQuartz(filePath: string): Promise<{ type: 'document'; text: string; pageCount?: number }> {
  const pythonScript = `
import sys
try:
    from Quartz import PDFDocument
    from Foundation import NSURL
except ImportError:
    sys.exit(2)
url = NSURL.fileURLWithPath_(sys.argv[1])
doc = PDFDocument.alloc().initWithURL_(url)
if not doc:
    sys.exit(1)
text = doc.string()
if not text or not text.strip():
    sys.exit(1)
sys.stdout.write(str(doc.pageCount()) + '\\n')
sys.stdout.write(text)
`.trim();

  const { stdout } = await execFilePromise('/usr/bin/python3', ['-c', pythonScript, filePath]);
  const lines = stdout.split('\n');
  const pageCount = parseInt(lines[0], 10) || undefined;
  const text = lines.slice(1).join('\n').trim();
  if (!text) throw new Error('No text content');

  return { type: 'document', text, pageCount };
}

/**
 * Extract text from a Word document (.docx, .doc) or RTF file.
 *
 * Uses macOS textutil which natively handles these formats.
 */
async function extractDocxText(filePath: string): Promise<ProcessedFile> {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) throw new Error(`File not found: ${filePath}`);

  try {
    const { stdout: text } = await execFilePromise('textutil', ['-convert', 'txt', '-stdout', filePath]);
    if (!text.trim()) throw new Error('No text content extracted');

    return {
      type: 'document',
      text: text.trim(),
      filename: basename(filePath),
      sizeBytes: fileStat.size,
    };
  } catch {
    throw new Error('Document extraction requires macOS textutil (built-in). Supported: .docx, .doc, .rtf');
  }
}

/**
 * Read a text file as UTF-8.
 */
async function readTextFile(filePath: string): Promise<ProcessedFile> {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) throw new Error(`File not found: ${filePath}`);
  if (fileStat.size > MAX_TEXT_SIZE) {
    throw new Error(`File too large (${Math.round(fileStat.size / 1024)}KB). Max: 512KB`);
  }

  const text = await readFile(filePath, 'utf-8');
  return {
    type: 'document',
    text,
    filename: basename(filePath),
    sizeBytes: fileStat.size,
  };
}

/**
 * Read any file as raw binary for upload to the gateway.
 * Returns base64-encoded data, filename, and size.
 * Works with any file type, not just supported extensions.
 */
export async function readFileForUpload(filePath: string): Promise<{
  filename: string;
  base64: string;
  sizeBytes: number;
}> {
  const resolved = resolvePath(filePath);
  const fileStat = await stat(resolved).catch(() => null);
  if (!fileStat?.isFile()) throw new Error(`File not found: ${filePath}`);
  if (fileStat.size > MAX_UPLOAD_SIZE) {
    throw new Error(`File too large (${Math.round(fileStat.size / 1024 / 1024)}MB). Max: 50MB`);
  }

  const buffer = await readFile(resolved);
  return {
    filename: basename(resolved),
    base64: buffer.toString('base64'),
    sizeBytes: fileStat.size,
  };
}

/**
 * Detect file paths in a user message.
 *
 * Matches absolute paths (/...) and home-relative paths (~/)
 * with supported file extensions. Handles escaped spaces (\ ).
 *
 * Returns matches with the unescaped path and position in the original string.
 * Callers should verify the file exists before processing.
 */
export function detectFilePaths(message: string): Array<{ path: string; start: number; end: number }> {
  const exts = getSupportedExtensions().map(e => e.slice(1)).join('|');
  // Match paths starting with / or ~/ , allowing spaces (but not newlines) and backslash-escaped characters
  // Lookbehind: whitespace, start of string, or punctuation (handles "well./Users/..." case)
  const pathRegex = new RegExp(
    `(?<=\\s|^|[.,;:!?)])((?:~\\/|\\/(?!\\/))(?:[^\\n\\r\\\\]|\\\\.)*\\.(?:${exts}))(?=\\s|$|[)\\]}>",;:!?'])`,
    'gi',
  );

  const results: Array<{ path: string; start: number; end: number }> = [];
  let match;

  while ((match = pathRegex.exec(message)) !== null) {
    const rawPath = match[1];
    // Unescape backslash-spaces → regular spaces
    const cleanPath = rawPath.replace(/\\ /g, ' ');
    results.push({
      path: cleanPath,
      start: match.index,
      end: match.index + rawPath.length,
    });
  }

  return results;
}
