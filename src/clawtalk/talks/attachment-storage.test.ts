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
  deletePageImages,
  loadAttachmentFile,
  loadPageImage,
  pageImageStorageKey,
  saveAttachmentFile,
  savePageImage,
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

describe('attachment-storage — PDF page images', () => {
  it('builds a deterministic 0-based page key', () => {
    expect(pageImageStorageKey('talk-1', 'src-9', 0)).toBe(
      'attachments/talk-1/src-9/page-0.jpg',
    );
    expect(pageImageStorageKey('talk-1', 'src-9', 12)).toBe(
      'attachments/talk-1/src-9/page-12.jpg',
    );
  });

  it('round-trips a page image as image/jpeg', async () => {
    const bucket = makeMockBucket();
    // Minimal JPEG SOI + EOI marker bytes.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    await withRequestScopedDb(
      TEST_DB_URL,
      null,
      envWithBucket(bucket),
      async () => {
        const key = await savePageImage('talk-1', 'src-9', 3, jpeg);
        expect(key).toBe('attachments/talk-1/src-9/page-3.jpg');
        expect(bucket.store.get(key)?.contentType).toBe('image/jpeg');

        const loaded = await loadPageImage('talk-1', 'src-9', 3);
        expect(Buffer.compare(loaded, jpeg)).toBe(0);
      },
    );
  });

  it('throws on load of a missing page', async () => {
    const bucket = makeMockBucket();
    await withRequestScopedDb(
      TEST_DB_URL,
      null,
      envWithBucket(bucket),
      async () => {
        await expect(loadPageImage('talk-1', 'src-9', 99)).rejects.toThrow(
          /page image not found/,
        );
      },
    );
  });

  it('deletes page images by known indices and is idempotent', async () => {
    const bucket = makeMockBucket();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    await withRequestScopedDb(
      TEST_DB_URL,
      null,
      envWithBucket(bucket),
      async () => {
        await savePageImage('talk-1', 'src-9', 0, jpeg);
        await savePageImage('talk-1', 'src-9', 1, jpeg);
        expect(bucket.store.size).toBe(2);

        // Delete a set that includes one never-written index (page 5) —
        // must not throw.
        await deletePageImages('talk-1', 'src-9', [0, 1, 5]);
        expect(bucket.store.size).toBe(0);

        // Empty list is a no-op.
        await expect(
          deletePageImages('talk-1', 'src-9', []),
        ).resolves.toBeUndefined();
      },
    );
  });
});
