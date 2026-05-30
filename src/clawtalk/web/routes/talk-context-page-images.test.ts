// Integration tests for the PDF page-image upload endpoint
// (POST .../context/sources/:sourceId/page-images/:index). Direct
// handler invocations against the live local supabase stack + a mock R2
// bucket. Covers happy/complete, validation × caps, non-JPEG, 404,
// not-a-PDF, cross-user RLS, idempotent double-submit, and a race.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withRequestScopedDb,
  type AttachmentBucketLike,
  type AttachmentBucketObjectBody,
} from '../../../db.js';
import {
  MAX_RASTER_IMAGE_BYTES,
  MAX_RASTER_PAGES,
} from '../../../shared/attachment-caps.js';
import type { AuthContext } from '../types.js';

import { uploadTalkContextSourcePageImageRoute } from './talk-context.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';

const USER_A = '0c333344-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = '0c333344-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TALK_A = '0c333344-cccc-cccc-cccc-ccccccccc0a1';
const TALK_B = '0c333344-cccc-cccc-cccc-ccccccccc0b1';
const PDF_SOURCE = '0c333344-dddd-dddd-dddd-ddddddddd0a1';
const TEXT_SOURCE = '0c333344-dddd-dddd-dddd-ddddddddd0a2';

const AUTH_A: AuthContext = {
  sessionId: 'sess-a',
  userId: USER_A,
  role: 'member',
  authType: 'cookie',
};
const AUTH_B: AuthContext = {
  sessionId: 'sess-b',
  userId: USER_B,
  role: 'member',
  authType: 'cookie',
};

// Minimal valid JPEG: SOI + APP0 + EOI. detectMime only needs FF D8 FF.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
// PNG magic bytes — a non-JPEG image that must be rejected.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
      store.set(key, { body, contentType: options?.httpMetadata?.contentType });
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

async function seedAuthUser(id: string, email: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${id}::uuid, ${email}::text, jsonb_build_object('full_name', ${email}::text))
    on conflict (id) do nothing
  `;
}

async function seedTalk(talkId: string, ownerId: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talks (id, owner_id, topic_title)
    values (${talkId}::uuid, ${ownerId}::uuid, 'Page Image Test Talk')
    on conflict (id) do nothing
  `;
}

async function seedSource(input: {
  id: string;
  talkId: string;
  ownerId: string;
  sourceRef: string;
  mimeType: string;
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talk_context_sources
      (id, talk_id, owner_id, source_ref, source_type, title, status,
       mime_type, file_name, storage_key)
    values
      (${input.id}::uuid, ${input.talkId}::uuid, ${input.ownerId}::uuid,
       ${input.sourceRef}, 'file', 'Test Source', 'ready',
       ${input.mimeType}, 'doc.pdf', ${`attachments/${input.talkId}/${input.id}.pdf`})
    on conflict (id) do nothing
  `;
}

async function reseed(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.talks where id in (${TALK_A}::uuid, ${TALK_B}::uuid)`;
  await seedTalk(TALK_A, USER_A);
  await seedTalk(TALK_B, USER_B);
  await seedSource({
    id: PDF_SOURCE,
    talkId: TALK_A,
    ownerId: USER_A,
    sourceRef: 'S1',
    mimeType: 'application/pdf',
  });
  await seedSource({
    id: TEXT_SOURCE,
    talkId: TALK_A,
    ownerId: USER_A,
    sourceRef: 'S2',
    mimeType: 'text/plain',
  });
}

function callUpload(
  bucket: AttachmentBucketLike,
  args: {
    auth: AuthContext;
    talkId: string;
    sourceId: string;
    index: string;
    total: string | undefined;
    data: Buffer;
  },
) {
  return withRequestScopedDb(TEST_DB_URL, null, { ATTACHMENTS: bucket }, () =>
    uploadTalkContextSourcePageImageRoute(args),
  );
}

async function dbPageCount(sourceId: string): Promise<number> {
  const db = getDbPg();
  const rows = await db<{ count: number }[]>`
    select count(*)::int as count from public.talk_context_source_pages
    where source_id = ${sourceId}::uuid
  `;
  return rows[0]?.count ?? 0;
}

async function dbExpectedPageCount(sourceId: string): Promise<number | null> {
  const db = getDbPg();
  const rows = await db<{ expected_page_count: number | null }[]>`
    select expected_page_count from public.talk_context_sources
    where id = ${sourceId}::uuid
  `;
  return rows[0]?.expected_page_count ?? null;
}

describe('uploadTalkContextSourcePageImageRoute', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser(USER_A, 'page-a@clawtalk.local');
    await seedAuthUser(USER_B, 'page-b@clawtalk.local');
  });

  afterAll(async () => {
    const db = getDbPg();
    await db`delete from public.talks where id in (${TALK_A}::uuid, ${TALK_B}::uuid)`;
    await db`delete from auth.users where id in (${USER_A}::uuid, ${USER_B}::uuid)`;
    await closePgDatabase();
  });

  beforeEach(async () => {
    await reseed();
  });

  it('uploads pages one at a time and reports completeness', async () => {
    const bucket = makeMockBucket();
    const r0 = await callUpload(bucket, {
      auth: AUTH_A,
      talkId: TALK_A,
      sourceId: PDF_SOURCE,
      index: '0',
      total: '2',
      data: JPEG,
    });
    expect(r0.statusCode).toBe(201);
    expect(r0.body.ok).toBe(true);
    expect(r0.body.ok && r0.body.data).toEqual({
      uploaded: 1,
      expected: 2,
      complete: false,
    });

    const r1 = await callUpload(bucket, {
      auth: AUTH_A,
      talkId: TALK_A,
      sourceId: PDF_SOURCE,
      index: '1',
      total: '2',
      data: JPEG,
    });
    expect(r1.body.ok && r1.body.data).toEqual({
      uploaded: 2,
      expected: 2,
      complete: true,
    });

    // R2 holds both pages as image/jpeg.
    expect(
      bucket.store.get(`attachments/${TALK_A}/${PDF_SOURCE}/page-0.jpg`)
        ?.contentType,
    ).toBe('image/jpeg');
    expect(
      bucket.store.has(`attachments/${TALK_A}/${PDF_SOURCE}/page-1.jpg`),
    ).toBe(true);
    // DB reflects the page set + expected count.
    expect(await dbPageCount(PDF_SOURCE)).toBe(2);
    expect(await dbExpectedPageCount(PDF_SOURCE)).toBe(2);
  });

  it('double-submit of the same page is idempotent (no dup)', async () => {
    const bucket = makeMockBucket();
    const args = {
      auth: AUTH_A,
      talkId: TALK_A,
      sourceId: PDF_SOURCE,
      index: '0',
      total: '2',
      data: JPEG,
    };
    await callUpload(bucket, args);
    const second = await callUpload(bucket, args);
    expect(second.statusCode).toBe(201);
    expect(second.body.ok && second.body.data.uploaded).toBe(1);
    expect(await dbPageCount(PDF_SOURCE)).toBe(1);
  });

  it('concurrent submits of the same page do not duplicate', async () => {
    const bucket = makeMockBucket();
    const args = {
      auth: AUTH_A,
      talkId: TALK_A,
      sourceId: PDF_SOURCE,
      index: '0',
      total: '3',
      data: JPEG,
    };
    const [a, b] = await Promise.all([
      callUpload(bucket, args),
      callUpload(bucket, args),
    ]);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(await dbPageCount(PDF_SOURCE)).toBe(1);
  });

  it('rejects an out-of-range page index', async () => {
    const bucket = makeMockBucket();
    const neg = await callUpload(bucket, {
      auth: AUTH_A,
      talkId: TALK_A,
      sourceId: PDF_SOURCE,
      index: '-1',
      total: '2',
      data: JPEG,
    });
    expect(neg.statusCode).toBe(400);
    expect(neg.body.ok === false && neg.body.error.code).toBe(
      'invalid_page_index',
    );

    const tooHigh = await callUpload(bucket, {
      auth: AUTH_A,
      talkId: TALK_A,
      sourceId: PDF_SOURCE,
      index: String(MAX_RASTER_PAGES),
      total: '2',
      data: JPEG,
    });
    expect(tooHigh.statusCode).toBe(400);
    expect(tooHigh.body.ok === false && tooHigh.body.error.code).toBe(
      'invalid_page_index',
    );
  });

  it('rejects index >= total', async () => {
    const bucket = makeMockBucket();
    const res = await callUpload(bucket, {
      auth: AUTH_A,
      talkId: TALK_A,
      sourceId: PDF_SOURCE,
      index: '3',
      total: '2',
      data: JPEG,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.ok === false && res.body.error.code).toBe(
      'page_index_out_of_range',
    );
  });

  it('rejects an invalid total', async () => {
    const bucket = makeMockBucket();
    const zero = await callUpload(bucket, {
      auth: AUTH_A,
      talkId: TALK_A,
      sourceId: PDF_SOURCE,
      index: '0',
      total: '0',
      data: JPEG,
    });
    expect(zero.body.ok === false && zero.body.error.code).toBe(
      'invalid_total',
    );

    const over = await callUpload(bucket, {
      auth: AUTH_A,
      talkId: TALK_A,
      sourceId: PDF_SOURCE,
      index: '0',
      total: String(MAX_RASTER_PAGES + 1),
      data: JPEG,
    });
    expect(over.body.ok === false && over.body.error.code).toBe(
      'invalid_total',
    );
  });

  it('rejects a page over the per-image byte cap', async () => {
    const bucket = makeMockBucket();
    const big = Buffer.alloc(MAX_RASTER_IMAGE_BYTES + 1);
    big[0] = 0xff;
    big[1] = 0xd8;
    big[2] = 0xff;
    const res = await callUpload(bucket, {
      auth: AUTH_A,
      talkId: TALK_A,
      sourceId: PDF_SOURCE,
      index: '0',
      total: '1',
      data: big,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.ok === false && res.body.error.code).toBe('page_too_large');
  });

  it('rejects an empty body and a non-JPEG image', async () => {
    const bucket = makeMockBucket();
    const empty = await callUpload(bucket, {
      auth: AUTH_A,
      talkId: TALK_A,
      sourceId: PDF_SOURCE,
      index: '0',
      total: '1',
      data: Buffer.alloc(0),
    });
    expect(empty.body.ok === false && empty.body.error.code).toBe('empty_page');

    const png = await callUpload(bucket, {
      auth: AUTH_A,
      talkId: TALK_A,
      sourceId: PDF_SOURCE,
      index: '0',
      total: '1',
      data: PNG,
    });
    expect(png.body.ok === false && png.body.error.code).toBe(
      'invalid_page_format',
    );
  });

  it('404s for a non-existent source', async () => {
    const bucket = makeMockBucket();
    const res = await callUpload(bucket, {
      auth: AUTH_A,
      talkId: TALK_A,
      sourceId: '0c333344-9999-9999-9999-999999999999',
      index: '0',
      total: '1',
      data: JPEG,
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a non-PDF source', async () => {
    const bucket = makeMockBucket();
    const res = await callUpload(bucket, {
      auth: AUTH_A,
      talkId: TALK_A,
      sourceId: TEXT_SOURCE,
      index: '0',
      total: '1',
      data: JPEG,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.ok === false && res.body.error.code).toBe('source_not_pdf');
  });

  it('does not let another user upload pages to a source they do not own', async () => {
    const bucket = makeMockBucket();
    const res = await callUpload(bucket, {
      auth: AUTH_B,
      talkId: TALK_A,
      sourceId: PDF_SOURCE,
      index: '0',
      total: '1',
      data: JPEG,
    });
    expect(res.statusCode).toBe(404);
    // Nothing was written for the cross-user attempt.
    expect(await dbPageCount(PDF_SOURCE)).toBe(0);
  });
});
