// clawtalk Phase 5 (PR 2) — end-to-end test for output-accessors-pg.
//
// talk_outputs is the deliverable artifact of a Talk (write-only by
// report jobs, hand-edited by users via the patch flow). The CAS round
// trip + RLS gate are the load-bearing assertions.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import {
  createTalkOutput,
  deleteTalkOutput,
  getTalkOutput,
  listTalkOutputs,
  patchTalkOutput,
  replaceJobReportOutput,
} from './output-accessors.js';

const USER_A_ID = '0c333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = '0c333333-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TALK_A_ID = '0c333333-cccc-cccc-cccc-ccccccccc0a1';
const TALK_B_ID = '0c333333-cccc-cccc-cccc-ccccccccc0b1';

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
    values (${talkId}::uuid, ${ownerId}::uuid, 'Output Test Talk')
    on conflict (id) do nothing
  `;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.talks where id in (${TALK_A_ID}::uuid, ${TALK_B_ID}::uuid)
  `;
  await seedTalk(TALK_A_ID, USER_A_ID);
  await seedTalk(TALK_B_ID, USER_B_ID);
}

describe('output-accessors-pg (postgres + RLS)', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser(USER_A_ID, 'out-a@clawtalk.local', 'Out User A');
    await seedAuthUser(USER_B_ID, 'out-b@clawtalk.local', 'Out User B');
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

  it('CRUD round-trip + list ordering', async () => {
    await withUserContext(USER_A_ID, async () => {
      const created = await createTalkOutput({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Report 1',
        contentMarkdown: '# Hello',
        createdByUserId: USER_A_ID,
      });
      expect(created.version).toBe(1);
      expect(created.contentLength).toBe('# Hello'.length);

      const fetched = await getTalkOutput(TALK_A_ID, created.id);
      expect(fetched?.title).toBe('Report 1');
      expect(fetched?.contentMarkdown).toBe('# Hello');

      const list = await listTalkOutputs(TALK_A_ID);
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(created.id);

      const deleted = await deleteTalkOutput(TALK_A_ID, created.id);
      expect(deleted).toBe(true);
      expect(await getTalkOutput(TALK_A_ID, created.id)).toBeUndefined();
    });
  });

  it('patch: CAS ok / conflict / not_found', async () => {
    const id = await withUserContext(USER_A_ID, async () => {
      const out = await createTalkOutput({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Iterating',
        contentMarkdown: 'v1',
      });
      return out.id;
    });

    // ok: version 1 → 2
    await withUserContext(USER_A_ID, async () => {
      const r = await patchTalkOutput({
        talkId: TALK_A_ID,
        outputId: id,
        expectedVersion: 1,
        contentMarkdown: 'v2',
        updatedByUserId: USER_A_ID,
      });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') throw new Error('unreachable');
      expect(r.output.version).toBe(2);
      expect(r.output.contentMarkdown).toBe('v2');
    });

    // conflict: expectedVersion still 1
    await withUserContext(USER_A_ID, async () => {
      const r = await patchTalkOutput({
        talkId: TALK_A_ID,
        outputId: id,
        expectedVersion: 1,
        contentMarkdown: 'v3-fail',
      });
      expect(r.kind).toBe('conflict');
      if (r.kind !== 'conflict') throw new Error('unreachable');
      expect(r.current.version).toBe(2);
    });

    // not_found: unknown id
    await withUserContext(USER_A_ID, async () => {
      const r = await patchTalkOutput({
        talkId: TALK_A_ID,
        outputId: '00000000-0000-0000-0000-000000000000',
        expectedVersion: 1,
        contentMarkdown: 'nope',
      });
      expect(r.kind).toBe('not_found');
    });
  });

  it('replaceJobReportOutput updates regardless of version', async () => {
    // talk_outputs.updated_by_run_id has FK → talk_runs(id), and
    // talk_runs needs a thread + the standard required columns.
    // Seed both via BYPASSRLS so the test owns concrete UUIDs.
    const runId = '0c333333-0000-0000-0000-000000000001';
    const threadId = '0c333333-0000-0000-0000-000000000002';
    const adminDb = getDbPg();
    await adminDb`
      insert into public.talk_threads (id, talk_id, owner_id, title)
      values (${threadId}::uuid, ${TALK_A_ID}::uuid, ${USER_A_ID}::uuid, 'thread')
      on conflict (id) do nothing
    `;
    await adminDb`
      insert into public.talk_runs
        (id, talk_id, owner_id, requested_by, status, thread_id)
      values (${runId}::uuid, ${TALK_A_ID}::uuid, ${USER_A_ID}::uuid,
              ${USER_A_ID}::uuid, 'completed', ${threadId}::uuid)
      on conflict (id) do nothing
    `;

    const id = await withUserContext(USER_A_ID, async () => {
      const out = await createTalkOutput({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'Daily Report',
        contentMarkdown: 'initial',
      });
      await patchTalkOutput({
        talkId: TALK_A_ID,
        outputId: out.id,
        expectedVersion: 1,
        contentMarkdown: 'user edit',
        updatedByUserId: USER_A_ID,
      });
      return out.id;
    });

    const replaced = await withUserContext(USER_A_ID, async () => {
      return await replaceJobReportOutput({
        talkId: TALK_A_ID,
        outputId: id,
        contentMarkdown: 'fresh report body',
        updatedByRunId: runId,
      });
    });
    expect(replaced?.version).toBe(3);
    expect(replaced?.contentMarkdown).toBe('fresh report body');
    expect(replaced?.updatedByUserId).toBeNull();
    expect(replaced?.updatedByRunId).toBe(runId);
  });

  it('RLS gate: user B cannot read or mutate user A output', async () => {
    const id = await withUserContext(USER_A_ID, async () => {
      const out = await createTalkOutput({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        title: 'A-only',
        contentMarkdown: 'private',
      });
      return out.id;
    });

    await withUserContext(USER_B_ID, async () => {
      expect(await getTalkOutput(TALK_A_ID, id)).toBeUndefined();
      expect((await listTalkOutputs(TALK_A_ID)).length).toBe(0);

      // Mutations against A's row filter to zero — patch returns
      // not_found (no row visible via RLS USING), delete returns false.
      const patched = await patchTalkOutput({
        talkId: TALK_A_ID,
        outputId: id,
        expectedVersion: 1,
        contentMarkdown: 'hijack',
      });
      expect(patched.kind).toBe('not_found');
      expect(await deleteTalkOutput(TALK_A_ID, id)).toBe(false);
    });

    // Sanity: A still owns + sees their row at version 1.
    await withUserContext(USER_A_ID, async () => {
      const refetched = await getTalkOutput(TALK_A_ID, id);
      expect(refetched?.version).toBe(1);
      expect(refetched?.contentMarkdown).toBe('private');
    });
  });

  it('RLS gate: user B INSERT with ownerId=USER_A rejected', async () => {
    await expect(
      withUserContext(USER_B_ID, async () => {
        await createTalkOutput({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          title: 'hijack',
          contentMarkdown: 'pwned',
        });
      }),
    ).rejects.toThrow();
  });
});
