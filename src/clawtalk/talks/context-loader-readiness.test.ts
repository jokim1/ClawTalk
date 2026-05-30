// Integration tests for fetchSources readiness with rasterized PDF pages.
//
// A PDF must stay visible to consumption when it has EITHER extracted
// text (status='ready') OR a complete page set. A text-extraction
// failure must not hide a PDF the model can still read via page images
// (Codex #12). The join also surfaces page_image_count + total bytes so
// the consumer can budget the payload without a second query.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  deleteAuthUsers,
  getDbPg,
  initPgDatabase,
  purgeUserData,
  seedAuthUser,
  seedTalk,
  withUserContext,
} from '../db/test-helpers.js';

import { fetchSources, isPageSetComplete } from './context-loader.js';

const USER = '0c333355-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TALK = '0c333355-cccc-cccc-cccc-ccccccccc0a1';

// One source id per readiness scenario.
const READY_PDF = '0c333355-dddd-dddd-dddd-ddddddddd001';
const READY_TEXT = '0c333355-dddd-dddd-dddd-ddddddddd002';
const FAILED_COMPLETE = '0c333355-dddd-dddd-dddd-ddddddddd003';
const FAILED_INCOMPLETE = '0c333355-dddd-dddd-dddd-ddddddddd004';
const FAILED_NOPAGES = '0c333355-dddd-dddd-dddd-ddddddddd005';
const READY_WITH_PAGES = '0c333355-dddd-dddd-dddd-ddddddddd006';

async function seedSource(input: {
  id: string;
  sourceRef: string;
  mimeType: string;
  status: string;
  expectedPageCount: number | null;
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talk_context_sources
      (id, talk_id, owner_id, source_ref, source_type, title, status,
       mime_type, file_name, storage_key, expected_page_count)
    values
      (${input.id}::uuid, ${TALK}::uuid, ${USER}::uuid, ${input.sourceRef},
       'file', 'Readiness Source', ${input.status}, ${input.mimeType},
       'doc.pdf', ${`attachments/${TALK}/${input.id}.pdf`},
       ${input.expectedPageCount})
    on conflict (id) do nothing
  `;
}

async function seedPage(
  sourceId: string,
  pageIndex: number,
  byteSize: number,
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talk_context_source_pages
      (source_id, page_index, byte_size, owner_id)
    values (${sourceId}::uuid, ${pageIndex}, ${byteSize}, ${USER}::uuid)
    on conflict (source_id, page_index) do nothing
  `;
}

describe('fetchSources readiness with page images', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser({ id: USER, email: 'readiness@clawtalk.local' });
  });

  afterAll(async () => {
    await purgeUserData([USER]);
    await deleteAuthUsers([USER]);
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purgeUserData([USER]);
    await seedTalk({ ownerId: USER, talkId: TALK });
    await seedSource({
      id: READY_PDF,
      sourceRef: 'S1',
      mimeType: 'application/pdf',
      status: 'ready',
      expectedPageCount: null,
    });
    await seedSource({
      id: READY_TEXT,
      sourceRef: 'S2',
      mimeType: 'text/plain',
      status: 'ready',
      expectedPageCount: null,
    });
    await seedSource({
      id: FAILED_COMPLETE,
      sourceRef: 'S3',
      mimeType: 'application/pdf',
      status: 'failed',
      expectedPageCount: 2,
    });
    await seedPage(FAILED_COMPLETE, 0, 100);
    await seedPage(FAILED_COMPLETE, 1, 200);
    await seedSource({
      id: FAILED_INCOMPLETE,
      sourceRef: 'S4',
      mimeType: 'application/pdf',
      status: 'failed',
      expectedPageCount: 2,
    });
    await seedPage(FAILED_INCOMPLETE, 0, 100);
    await seedSource({
      id: FAILED_NOPAGES,
      sourceRef: 'S5',
      mimeType: 'application/pdf',
      status: 'failed',
      expectedPageCount: null,
    });
    await seedSource({
      id: READY_WITH_PAGES,
      sourceRef: 'S6',
      mimeType: 'application/pdf',
      status: 'ready',
      expectedPageCount: 1,
    });
    await seedPage(READY_WITH_PAGES, 0, 500);
  });

  it('includes ready sources and raster-only PDFs, hides incomplete ones', async () => {
    await withUserContext(USER, async () => {
      const refs = (await fetchSources(getDbPg(), TALK)).map(
        (r) => r.source_ref,
      );
      expect(refs).toContain('S1'); // ready PDF
      expect(refs).toContain('S2'); // ready text
      expect(refs).toContain('S3'); // failed extraction, complete pages
      expect(refs).toContain('S6'); // ready + pages
      expect(refs).not.toContain('S4'); // failed, incomplete pages
      expect(refs).not.toContain('S5'); // failed, no pages
    });
  });

  it('surfaces page_image_count and total bytes from the join', async () => {
    await withUserContext(USER, async () => {
      const rows = await fetchSources(getDbPg(), TALK);
      const s3 = rows.find((r) => r.source_ref === 'S3');
      expect(s3?.page_image_count).toBe(2);
      expect(s3?.page_image_total_bytes).toBe(300);
      expect(s3?.expected_page_count).toBe(2);
      expect(isPageSetComplete(s3!)).toBe(true);

      // A ready PDF with no rasterized pages reports zero, not null.
      const s1 = rows.find((r) => r.source_ref === 'S1');
      expect(s1?.page_image_count).toBe(0);
      expect(s1?.page_image_total_bytes).toBe(0);
      expect(isPageSetComplete(s1!)).toBe(false);
    });
  });
});
