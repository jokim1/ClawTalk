import fs from 'fs/promises';
import path from 'path';

import { STORE_DIR } from '../../config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ATTACHMENTS_DIR = path.join(STORE_DIR, 'attachments');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extensionFromFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return ext || '.bin';
}

function storageKeyToPath(storageKey: string): string {
  return path.join(STORE_DIR, storageKey);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a raw file to disk. Returns the storage key (relative to STORE_DIR)
 * that should be saved in the `talk_message_attachments.storage_key` column.
 */
export async function saveAttachmentFile(
  attachmentId: string,
  talkId: string,
  content: Buffer,
  fileName: string,
): Promise<string> {
  const ext = extensionFromFileName(fileName);
  const dir = path.join(ATTACHMENTS_DIR, talkId);
  await fs.mkdir(dir, { recursive: true });

  const storageKey = `attachments/${talkId}/${attachmentId}${ext}`;
  const filePath = path.join(STORE_DIR, storageKey);
  await fs.writeFile(filePath, content);
  return storageKey;
}

/**
 * Load a raw file from disk by its storage key.
 */
export async function loadAttachmentFile(storageKey: string): Promise<Buffer> {
  const filePath = storageKeyToPath(storageKey);
  return fs.readFile(filePath);
}

/**
 * Delete a file from disk by its storage key. Silently ignores missing files.
 */
export async function deleteAttachmentFile(storageKey: string): Promise<void> {
  const filePath = storageKeyToPath(storageKey);
  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Check whether a file exists on disk.
 */
export async function attachmentFileExists(
  storageKey: string,
): Promise<boolean> {
  const filePath = storageKeyToPath(storageKey);
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
