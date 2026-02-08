/**
 * Image Processing Service
 *
 * Processes local images for sending to the gateway:
 * - Validates file type and size
 * - Resizes large images (max 1568px longest side)
 * - Converts HEIC/WEBP/GIF to JPEG via macOS `sips`
 * - Returns base64-encoded data with metadata
 */

import { execFile } from 'node:child_process';
import { readFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PendingAttachment } from '../types.js';

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic']);
const NEEDS_CONVERSION = new Set(['.heic', '.webp', '.gif']);
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_DIMENSION = 1568; // Claude's recommended max for image input

function execFilePromise(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

/** Parse `sips -g` output like "  pixelWidth: 1920" */
function parseSipsProperty(output: string, property: string): number {
  const match = output.match(new RegExp(`${property}:\\s*(\\d+)`));
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Process a local image file for sending to the gateway.
 *
 * 1. Validates file exists and has a supported extension
 * 2. Gets dimensions via `sips`
 * 3. Resizes/converts if needed (HEIC/WEBP/GIF → JPEG, or >1568px)
 * 4. Returns PendingAttachment with base64 data
 */
export async function processImage(filePath: string): Promise<PendingAttachment> {
  // Expand ~ to home directory
  const resolved = filePath.startsWith('~/')
    ? join(process.env.HOME || '', filePath.slice(2))
    : filePath;

  // Validate extension
  const ext = extname(resolved).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported image format: ${ext}. Supported: jpg, png, gif, webp, heic`);
  }

  // Validate file exists and check size
  const fileStat = await stat(resolved).catch(() => null);
  if (!fileStat || !fileStat.isFile()) {
    throw new Error(`File not found: ${resolved}`);
  }
  if (fileStat.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${Math.round(fileStat.size / 1024 / 1024)}MB). Max: 20MB`);
  }

  // Get dimensions
  const sipsInfo = await execFilePromise('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', resolved]);
  const origWidth = parseSipsProperty(sipsInfo, 'pixelWidth');
  const origHeight = parseSipsProperty(sipsInfo, 'pixelHeight');
  if (!origWidth || !origHeight) {
    throw new Error('Could not read image dimensions');
  }

  const longestSide = Math.max(origWidth, origHeight);
  const needsResize = longestSide > MAX_DIMENSION;
  const needsConversion = NEEDS_CONVERSION.has(ext);

  let outputPath: string | null = null;

  try {
    if (needsResize || needsConversion) {
      // Process via sips: convert to JPEG and/or resize
      outputPath = join(tmpdir(), `clawtalk-${randomUUID()}.jpg`);
      const sipsArgs = ['-s', 'format', 'jpeg'];
      if (needsResize) {
        sipsArgs.push('-Z', String(MAX_DIMENSION));
      }
      sipsArgs.push(resolved, '--out', outputPath);
      await execFilePromise('sips', sipsArgs);

      // Read processed file
      const buffer = await readFile(outputPath);

      // Get final dimensions
      const finalInfo = await execFilePromise('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', outputPath]);
      const finalWidth = parseSipsProperty(finalInfo, 'pixelWidth');
      const finalHeight = parseSipsProperty(finalInfo, 'pixelHeight');

      return {
        filename: basename(resolved),
        mimeType: 'image/jpeg',
        width: finalWidth || origWidth,
        height: finalHeight || origHeight,
        sizeBytes: buffer.length,
        base64: buffer.toString('base64'),
      };
    }

    // No processing needed — read original file
    const buffer = await readFile(resolved);
    const mimeType = ext === '.png' ? 'image/png'
      : ext === '.gif' ? 'image/gif'
        : 'image/jpeg';

    return {
      filename: basename(resolved),
      mimeType,
      width: origWidth,
      height: origHeight,
      sizeBytes: buffer.length,
      base64: buffer.toString('base64'),
    };
  } finally {
    // Clean up temp file
    if (outputPath) {
      await unlink(outputPath).catch(() => {});
    }
  }
}
