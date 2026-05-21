import { describe, expect, it } from 'vitest';

import {
  type AttachmentBucketLike,
  type AttachmentBucketObjectBody,
  type DbScopeEnvBindings,
  withRequestScopedDb,
} from '../../db.js';
import {
  attachmentFileExists,
  deleteAttachmentFile,
  loadAttachmentFile,
  saveAttachmentFile,
} from './attachment-storage.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';

function makeMockBucket(): AttachmentBucketLike & {
  store: Map<string, { body: Buffer; contentType?: string }>;
} {
  const store = new Map<string, { body: Buffer; contentType?: string }>();
  return {
    store,
    async put(key, value, options) {
      const body =
        value instanceof ArrayBuffer
          ? Buffer.from(value)
          : ArrayBuffer.isView(value)
            ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
            : Buffer.from(String(value));
      store.set(key, {
        body,
        contentType: options?.httpMetadata?.contentType,
      });
      return { key, size: body.byteLength };
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      const buf = entry.body;
      const ab = buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer;
      const obj: AttachmentBucketObjectBody = {
        key,
        size: buf.byteLength,
        httpMetadata: entry.contentType
          ? { contentType: entry.contentType }
          : undefined,
        arrayBuffer: async () => ab,
      };
      return obj;
    },
    async delete(key) {
      store.delete(key);
    },
    async head(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return { key, size: entry.body.byteLength };
    },
  };
}

function envWithBucket(bucket: AttachmentBucketLike): DbScopeEnvBindings {
  return { ATTACHMENTS: bucket };
}

describe('attachment-storage (R2)', () => {
  it('round-trips a file through put / get / head / delete', async () => {
    const bucket = makeMockBucket();
    const payload = Buffer.from('hello clawtalk attachments');

    await withRequestScopedDb(
      TEST_DB_URL,
      null,
      envWithBucket(bucket),
      async () => {
        const storageKey = await saveAttachmentFile(
          'attach-1',
          'talk-abc',
          payload,
          'note.txt',
          'text/plain',
        );

        expect(storageKey).toBe('attachments/talk-abc/attach-1.txt');
        expect(bucket.store.has(storageKey)).toBe(true);
        expect(bucket.store.get(storageKey)?.contentType).toBe('text/plain');

        expect(await attachmentFileExists(storageKey)).toBe(true);

        const loaded = await loadAttachmentFile(storageKey);
        expect(loaded.toString('utf-8')).toBe('hello clawtalk attachments');

        await deleteAttachmentFile(storageKey);
        expect(await attachmentFileExists(storageKey)).toBe(false);
      },
    );
  });

  it('throws on load of a missing key', async () => {
    const bucket = makeMockBucket();
    await withRequestScopedDb(
      TEST_DB_URL,
      null,
      envWithBucket(bucket),
      async () => {
        await expect(
          loadAttachmentFile('attachments/talk-xyz/missing.bin'),
        ).rejects.toThrow(/not found/);
      },
    );
  });

  it('delete is idempotent on missing keys', async () => {
    const bucket = makeMockBucket();
    await withRequestScopedDb(
      TEST_DB_URL,
      null,
      envWithBucket(bucket),
      async () => {
        await expect(
          deleteAttachmentFile('attachments/talk-xyz/never-there.bin'),
        ).resolves.toBeUndefined();
      },
    );
  });

  it('falls back to .bin extension when fileName lacks one', async () => {
    const bucket = makeMockBucket();
    await withRequestScopedDb(
      TEST_DB_URL,
      null,
      envWithBucket(bucket),
      async () => {
        const key = await saveAttachmentFile(
          'attach-2',
          'talk-def',
          Buffer.from('binary'),
          'no-extension',
        );
        expect(key).toBe('attachments/talk-def/attach-2.bin');
      },
    );
  });

  it('throws if the R2 binding is missing from the request scope', async () => {
    await withRequestScopedDb(TEST_DB_URL, null, {}, async () => {
      await expect(
        saveAttachmentFile('x', 'y', Buffer.from(''), 'z.txt'),
      ).rejects.toThrow(/ATTACHMENTS R2 binding missing/);
    });
  });
});
