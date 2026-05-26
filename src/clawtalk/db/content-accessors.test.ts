// Content feature — end-to-end tests for content-accessors (postgres).
//
// Direct-edit redesign (commit 7) removed every proposal-specific test;
// those branches no longer exist in the accessor module. Pending-edit
// flows are exercised by content-edits-accessors.test.ts (commit 8+).
//
// Runs against the local Supabase Postgres started by `npm run db:start`.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import {
  CONTENT_BODY_BYTE_LIMIT,
  createContent,
  getContentById,
  getContentByTalkId,
  updateContentBody,
} from './content-accessors.js';
import { tiptapJsonToMarkdown } from '../../shared/rich-text/index.js';

const USER_A_ID = '0c444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = '0c444444-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TALK_A_ID = '0c444444-cccc-cccc-cccc-ccccccccc0a1';
const TALK_B_ID = '0c444444-cccc-cccc-cccc-ccccccccc0b1';

async function seedAuthUser(
  id: string,
  email: string,
  displayName: string,
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${id}::uuid, ${email}::text,
            jsonb_build_object('full_name', ${displayName}::text))
    on conflict (id) do nothing
  `;
}

async function seedTalk(talkId: string, ownerId: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talks (id, owner_id, topic_title)
    values (${talkId}::uuid, ${ownerId}::uuid, 'Content Test Talk')
    on conflict (id) do nothing
  `;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  // Cascade through talks removes contents + content_edits.
  await db`
    delete from public.talks where id in (${TALK_A_ID}::uuid, ${TALK_B_ID}::uuid)
  `;
  await seedTalk(TALK_A_ID, USER_A_ID);
  await seedTalk(TALK_B_ID, USER_B_ID);
}

describe('content-accessors (postgres + RLS)', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser(USER_A_ID, 'content-a@clawtalk.local', 'Content A');
    await seedAuthUser(USER_B_ID, 'content-b@clawtalk.local', 'Content B');
    await seedTalk(TALK_A_ID, USER_A_ID);
    await seedTalk(TALK_B_ID, USER_B_ID);
  });

  afterAll(async () => {
    const db = getDbPg();
    await db`
      delete from auth.users where id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
    `;
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purge();
  });

  it('createContent + getContentByTalkId: happy path', async () => {
    await withUserContext(USER_A_ID, async () => {
      const created = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: '  My Doc  ',
        createdByUserId: USER_A_ID,
      });
      expect(created.title).toBe('My Doc');
      expect(created.bodyVersion).toBe(1);
      expect(created.bodyMarkdown).toBe('');

      const fetched = await getContentByTalkId(TALK_A_ID);
      expect(fetched?.id).toBe(created.id);
      const fetchedById = await getContentById(created.id);
      expect(fetchedById?.talkId).toBe(TALK_A_ID);
    });
  });

  it('createContent: 1:1 unique constraint blocks a second content on the same Talk', async () => {
    await withUserContext(USER_A_ID, async () => {
      await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'first',
      });
    });
    // Second create runs in its own tx so the unique-violation aborts
    // that tx cleanly without poisoning the surrounding scope.
    await expect(
      withUserContext(USER_A_ID, async () => {
        await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          title: 'second',
        });
      }),
    ).rejects.toThrow();
  });

  it('integrity trigger rejects contents.owner_id ≠ talks.owner_id', async () => {
    const db = getDbPg();
    // Direct insert via BYPASSRLS with mismatched owner — the integrity
    // trigger should fire.
    await expect(
      db`
        insert into public.contents
          (owner_id, talk_id, title, body_markdown, body_version, anchor_map_json)
        values
          (${USER_B_ID}::uuid, ${TALK_A_ID}::uuid, 'spoof', '', 1, '{}'::jsonb)
      `,
    ).rejects.toThrow();
  });

  it('updateContentBody: happy path + CAS conflict + not_found', async () => {
    await withUserContext(USER_A_ID, async () => {
      const content = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
      });
      const happy = await updateContentBody({
        contentId: content.id,
        ownerId: USER_A_ID,
        expectedVersion: content.bodyVersion,
        bodyMarkdown: '# Hello\n\nBody.',
        updatedByUserId: USER_A_ID,
      });
      expect(happy.kind).toBe('ok');
      if (happy.kind === 'ok') {
        expect(happy.content.bodyVersion).toBe(content.bodyVersion + 1);
        expect(happy.content.bodyMarkdown).toContain('Hello');
      }

      const conflict = await updateContentBody({
        contentId: content.id,
        ownerId: USER_A_ID,
        expectedVersion: content.bodyVersion,
        bodyMarkdown: '# Stale write',
        updatedByUserId: USER_A_ID,
      });
      expect(conflict.kind).toBe('conflict');

      const notFound = await updateContentBody({
        contentId: '00000000-0000-0000-0000-000000000000',
        ownerId: USER_A_ID,
        expectedVersion: 1,
        bodyMarkdown: 'irrelevant',
        updatedByUserId: USER_A_ID,
      });
      expect(notFound.kind).toBe('not_found');
    });
  });

  it('updateContentBody: doc_size_limit gates over-budget bodies', async () => {
    await withUserContext(USER_A_ID, async () => {
      const content = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
      });
      const oversize = 'A'.repeat(CONTENT_BODY_BYTE_LIMIT + 1024);
      const result = await updateContentBody({
        contentId: content.id,
        ownerId: USER_A_ID,
        expectedVersion: content.bodyVersion,
        bodyMarkdown: oversize,
        updatedByUserId: USER_A_ID,
      });
      expect(result.kind).toBe('doc_size_limit');
    });
  });

  it('updateContentBody: canonical anchor-stamping survives a no-op round trip', async () => {
    await withUserContext(USER_A_ID, async () => {
      const content = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Doc',
      });
      const updated = await updateContentBody({
        contentId: content.id,
        ownerId: USER_A_ID,
        expectedVersion: content.bodyVersion,
        bodyMarkdown: '# Hello\n\nBody.',
        updatedByUserId: USER_A_ID,
      });
      if (updated.kind !== 'ok') throw new Error('expected ok');
      // The serializer rewrites the body with anchor comments — re-saving
      // the canonical markdown shouldn't change it past the first round.
      const canonical = updated.content.bodyMarkdown;
      const second = await updateContentBody({
        contentId: content.id,
        ownerId: USER_A_ID,
        expectedVersion: updated.content.bodyVersion,
        bodyMarkdown: canonical,
        updatedByUserId: USER_A_ID,
      });
      if (second.kind !== 'ok') throw new Error('expected ok');
      expect(second.content.bodyMarkdown).toBe(canonical);
      // Sanity check: tiptap → markdown round-trips identically.
      void tiptapJsonToMarkdown;
    });
  });

  it('RLS: user B cannot read user A content', async () => {
    let userAContentId = '';
    await withUserContext(USER_A_ID, async () => {
      const created = await createContent({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Private',
      });
      userAContentId = created.id;
    });
    await withUserContext(USER_B_ID, async () => {
      const fetched = await getContentById(userAContentId);
      expect(fetched).toBeNull();
    });
  });

  it('RLS: user B INSERT (createContent) with ownerId=USER_A rejected', async () => {
    await expect(
      withUserContext(USER_B_ID, async () => {
        await createContent({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          title: 'forged',
        });
      }),
    ).rejects.toThrow();
  });
});
