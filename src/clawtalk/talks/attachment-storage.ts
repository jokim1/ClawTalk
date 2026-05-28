import path from 'path';

import {
  getRequestScopeEnvAndCtx,
  type AttachmentBucketLike,
} from '../../db.js';

// ---------------------------------------------------------------------------
// Bucket resolution
// ---------------------------------------------------------------------------

/**
 * Pull the R2 bucket binding from the request-scoped env that
 * `withRequestScopedDb` populated. Each entrypoint that calls these
 * helpers (HTTP routes via worker.ts fetch handler, queue consumer via
 * the queue() handler, scheduler via scheduled()) must include
 * `ATTACHMENTS: env.ATTACHMENTS` in the env object it passes to
 * `withRequestScopedDb` — PR #454 added the binding to the queue path
 * after a missed scope caused chat-attachment vision to silently fail.
 *
 * Tests that exercise the storage adapter must pass the bucket via
 * `withRequestScopedDb(url, ctx, { ATTACHMENTS: mockBucket }, ...)`.
 */
function requireBucket(): AttachmentBucketLike {
  const { env } = getRequestScopeEnvAndCtx();
  const bucket = env?.ATTACHMENTS;
  if (!bucket) {
    throw new Error(
      'attachment-storage: ATTACHMENTS R2 binding missing from request scope',
    );
  }
  return bucket;
}

function extensionFromFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return ext || '.bin';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a raw file to the ATTACHMENTS R2 bucket. Returns the storage
 * key that should be saved in the `*.storage_key` columns.
 */
export async function saveAttachmentFile(
  attachmentId: string,
  talkId: string,
  content: Buffer,
  fileName: string,
  mimeType?: string,
): Promise<string> {
  const bucket = requireBucket();
  const ext = extensionFromFileName(fileName);
  const storageKey = `attachments/${talkId}/${attachmentId}${ext}`;
  // Slice the Buffer into a plain ArrayBuffer — R2 accepts ArrayBuffer
  // / ArrayBufferView, and a fresh slice avoids leaking the Buffer's
  // backing pool past the request boundary.
  const body = content.buffer.slice(
    content.byteOffset,
    content.byteOffset + content.byteLength,
  ) as ArrayBuffer;
  await bucket.put(storageKey, body, {
    httpMetadata: mimeType ? { contentType: mimeType } : undefined,
  });
  return storageKey;
}

/**
 * Load a raw file from R2 by its storage key. Throws if missing.
 */
export async function loadAttachmentFile(storageKey: string): Promise<Buffer> {
  const bucket = requireBucket();
  const obj = await bucket.get(storageKey);
  if (!obj) {
    throw new Error(`attachment-storage: object not found: ${storageKey}`);
  }
  const ab = await obj.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Delete a file from R2 by its storage key. R2.delete is idempotent —
 * missing keys do not throw.
 */
export async function deleteAttachmentFile(storageKey: string): Promise<void> {
  const bucket = requireBucket();
  await bucket.delete(storageKey);
}

/**
 * Check whether a file exists in R2 (via HEAD).
 */
export async function attachmentFileExists(
  storageKey: string,
): Promise<boolean> {
  const bucket = requireBucket();
  const head = await bucket.head(storageKey);
  return head !== null;
}
