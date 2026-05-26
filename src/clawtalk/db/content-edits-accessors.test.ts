// content_edits accessor + apply handler — postgres + RLS tests.
//
// Runs against the local Supabase Postgres started by `npm run db:start`.
// Migration 0028 (commit 8 of the direct-edit redesign) created the
// `content_edits` table the suite exercises.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import { createContent, updateContentBody } from './content-accessors.js';
import {
  acceptPendingEdit,
  acceptPendingRun,
  getPendingEditsByContent,
  insertPendingEdit,
  rejectPendingEdit,
  rejectPendingRun,
} from './content-edits-accessors.js';
import { executeApplyContentEdit } from '../talks/content-apply-handler.js';

const USER_A_ID = '0c888888-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = '0c888888-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TALK_A_ID = '0c888888-cccc-cccc-cccc-ccccccccc0a1';
const TALK_B_ID = '0c888888-cccc-cccc-cccc-ccccccccc0b1';

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
    values (${talkId}::uuid, ${ownerId}::uuid, 'Content Edits Test Talk')
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

async function seedDoc(
  ownerId: string,
  talkId: string,
): Promise<{
  contentId: string;
  bodyVersion: number;
  anchors: { h1: string; p1: string; p2: string };
}> {
  return await withUserContext(ownerId, async () => {
    const created = await createContent({
      ownerId,
      talkId,
      title: 'Edit Doc',
      createdByUserId: ownerId,
    });
    const updated = await updateContentBody({
      contentId: created.id,
      ownerId,
      expectedVersion: created.bodyVersion,
      bodyMarkdown:
        '<!-- anchor:h1 -->\n# Title\n\n<!-- anchor:p1 -->\nFirst paragraph.\n\n<!-- anchor:p2 -->\nSecond paragraph.',
      updatedByUserId: ownerId,
    });
    if (updated.kind !== 'ok') throw new Error('expected ok updateContentBody');
    return {
      contentId: created.id,
      bodyVersion: updated.content.bodyVersion,
      anchors: { h1: 'h1', p1: 'p1', p2: 'p2' },
    };
  });
}

describe('content-edits-accessors (postgres + RLS)', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser(USER_A_ID, 'edits-a@clawtalk.local', 'Edits A');
    await seedAuthUser(USER_B_ID, 'edits-b@clawtalk.local', 'Edits B');
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

  it('insertPendingEdit + getPendingEditsByContent: round-trip basics', async () => {
    const { contentId, bodyVersion, anchors } = await seedDoc(
      USER_A_ID,
      TALK_A_ID,
    );
    await withUserContext(USER_A_ID, async () => {
      await insertPendingEdit({
        contentId,
        runId: 'run-1',
        agentId: null,
        agentNickname: 'Tester',
        messageId: null,
        kind: 'insert',
        baseContentVersion: bodyVersion,
        targetAnchorId: anchors.p1,
        newMarkdown: 'Inserted block.',
        rationale: 'first thought',
      });
      const list = await getPendingEditsByContent(contentId);
      expect(list.length).toBe(1);
      expect(list[0].kind).toBe('insert');
      expect(list[0].targetAnchorId).toBe(anchors.p1);
      expect(list[0].newMarkdown).toBe('Inserted block.');
      expect(list[0].agentNickname).toBe('Tester');
    });
  });

  it('acceptPendingEdit materializes the edit and CAS-bumps body_version', async () => {
    const { contentId, bodyVersion, anchors } = await seedDoc(
      USER_A_ID,
      TALK_A_ID,
    );
    await withUserContext(USER_A_ID, async () => {
      const inserted = await insertPendingEdit({
        contentId,
        runId: 'run-1',
        agentId: null,
        agentNickname: null,
        messageId: null,
        kind: 'replace',
        baseContentVersion: bodyVersion,
        targetAnchorId: anchors.p1,
        newMarkdown: 'Replaced.',
        rationale: null,
      });
      const accepted = await acceptPendingEdit({
        editId: inserted.id,
        userId: USER_A_ID,
        expectedContentVersion: bodyVersion,
      });
      expect(accepted.kind).toBe('ok');
      if (accepted.kind !== 'ok') throw new Error('unreachable');
      expect(accepted.content.bodyVersion).toBe(bodyVersion + 1);
      expect(accepted.content.bodyMarkdown).toContain('Replaced.');
      expect(accepted.content.bodyMarkdown).not.toContain('First paragraph.');
      const remaining = await getPendingEditsByContent(contentId);
      expect(remaining.length).toBe(0);
    });
  });

  it('rejectPendingEdit deletes the row without touching body', async () => {
    const { contentId, bodyVersion, anchors } = await seedDoc(
      USER_A_ID,
      TALK_A_ID,
    );
    await withUserContext(USER_A_ID, async () => {
      const inserted = await insertPendingEdit({
        contentId,
        runId: 'run-1',
        agentId: null,
        agentNickname: null,
        messageId: null,
        kind: 'insert',
        baseContentVersion: bodyVersion,
        targetAnchorId: anchors.p1,
        newMarkdown: 'Insert me.',
        rationale: null,
      });
      const rejected = await rejectPendingEdit({
        editId: inserted.id,
        userId: USER_A_ID,
      });
      expect(rejected.kind).toBe('ok');
      const remaining = await getPendingEditsByContent(contentId);
      expect(remaining.length).toBe(0);
      const sql = getDbPg();
      const refreshed = await sql<{ body_version: number }[]>`
        select body_version from public.contents where id = ${contentId}::uuid
      `;
      expect(refreshed[0].body_version).toBe(bodyVersion);
    });
  });

  it('acceptPendingRun materializes all run edits in created_at order', async () => {
    const { contentId, bodyVersion, anchors } = await seedDoc(
      USER_A_ID,
      TALK_A_ID,
    );
    await withUserContext(USER_A_ID, async () => {
      await insertPendingEdit({
        contentId,
        runId: 'run-1',
        agentId: null,
        agentNickname: null,
        messageId: null,
        kind: 'insert',
        baseContentVersion: bodyVersion,
        targetAnchorId: anchors.p1,
        newMarkdown: 'First insert.',
        rationale: null,
      });
      await insertPendingEdit({
        contentId,
        runId: 'run-1',
        agentId: null,
        agentNickname: null,
        messageId: null,
        kind: 'replace',
        baseContentVersion: bodyVersion,
        targetAnchorId: anchors.p2,
        newMarkdown: 'Replaced second.',
        rationale: null,
      });
      const accepted = await acceptPendingRun({
        contentId,
        runId: 'run-1',
        userId: USER_A_ID,
        expectedContentVersion: bodyVersion,
      });
      expect(accepted.kind).toBe('ok');
      if (accepted.kind !== 'ok') throw new Error('unreachable');
      expect(accepted.content.bodyVersion).toBe(bodyVersion + 1);
      expect(accepted.content.bodyMarkdown).toContain('First insert.');
      expect(accepted.content.bodyMarkdown).toContain('Replaced second.');
      expect(accepted.content.bodyMarkdown).not.toContain('Second paragraph.');
      const remaining = await getPendingEditsByContent(contentId);
      expect(remaining.length).toBe(0);
    });
  });

  it('rejectPendingRun deletes all run rows without touching body', async () => {
    const { contentId, bodyVersion, anchors } = await seedDoc(
      USER_A_ID,
      TALK_A_ID,
    );
    await withUserContext(USER_A_ID, async () => {
      for (let i = 0; i < 3; i++) {
        await insertPendingEdit({
          contentId,
          runId: 'run-1',
          agentId: null,
          agentNickname: null,
          messageId: null,
          kind: 'insert',
          baseContentVersion: bodyVersion,
          targetAnchorId: anchors.p1,
          newMarkdown: `Block ${i}.`,
          rationale: null,
        });
      }
      const rejected = await rejectPendingRun({
        contentId,
        runId: 'run-1',
        userId: USER_A_ID,
      });
      expect(rejected.kind).toBe('ok');
      if (rejected.kind !== 'ok') throw new Error('unreachable');
      expect(rejected.editIds.length).toBe(3);
      const remaining = await getPendingEditsByContent(contentId);
      expect(remaining.length).toBe(0);
    });
  });

  it('acceptPendingEdit returns version_conflict when expectedContentVersion is stale', async () => {
    const { contentId, bodyVersion, anchors } = await seedDoc(
      USER_A_ID,
      TALK_A_ID,
    );
    await withUserContext(USER_A_ID, async () => {
      const inserted = await insertPendingEdit({
        contentId,
        runId: 'run-1',
        agentId: null,
        agentNickname: null,
        messageId: null,
        kind: 'insert',
        baseContentVersion: bodyVersion,
        targetAnchorId: anchors.p1,
        newMarkdown: 'X',
        rationale: null,
      });
      const conflict = await acceptPendingEdit({
        editId: inserted.id,
        userId: USER_A_ID,
        expectedContentVersion: bodyVersion - 1,
      });
      expect(conflict.kind).toBe('version_conflict');
    });
  });

  it('acceptPendingEdit returns not_found when the row is already gone', async () => {
    await withUserContext(USER_A_ID, async () => {
      const result = await acceptPendingEdit({
        editId: '00000000-0000-0000-0000-000000000000',
        userId: USER_A_ID,
      });
      expect(result.kind).toBe('not_found');
    });
  });

  it('executeApplyContentEdit: auto-accept-prior on a different runId materializes + inserts new in one shot', async () => {
    const { contentId, bodyVersion, anchors } = await seedDoc(
      USER_A_ID,
      TALK_A_ID,
    );
    await withUserContext(USER_A_ID, async () => {
      // Prior pending run.
      await insertPendingEdit({
        contentId,
        runId: 'run-1',
        agentId: null,
        agentNickname: null,
        messageId: null,
        kind: 'replace',
        baseContentVersion: bodyVersion,
        targetAnchorId: anchors.p1,
        newMarkdown: 'Prior replace.',
        rationale: null,
      });
      // New run lands; the handler auto-accepts run-1 then inserts run-2.
      const result = await executeApplyContentEdit({
        talkId: TALK_A_ID,
        userId: USER_A_ID,
        runId: 'run-2',
        agentId: null,
        agentNickname: 'Agent',
        messageId: null,
        args: {
          kind: 'append',
          anchor: anchors.p2,
          markdown: 'Run 2 inserts.',
        },
      });
      expect(result.isError).toBeUndefined();
      const pending = await getPendingEditsByContent(contentId);
      // Only run-2 should remain pending; run-1 was materialized.
      expect(pending.length).toBe(1);
      expect(pending[0].runId).toBe('run-2');
      const sql = getDbPg();
      const fetched = await sql<
        { body_markdown: string; body_version: number }[]
      >`
        select body_markdown, body_version
        from public.contents where id = ${contentId}::uuid
      `;
      expect(fetched[0].body_markdown).toContain('Prior replace.');
      expect(fetched[0].body_version).toBe(bodyVersion + 1);
    });
  });

  it('executeApplyContentEdit: same-run repeat replace collapses into one row', async () => {
    const { contentId, anchors } = await seedDoc(USER_A_ID, TALK_A_ID);
    await withUserContext(USER_A_ID, async () => {
      await executeApplyContentEdit({
        talkId: TALK_A_ID,
        userId: USER_A_ID,
        runId: 'run-1',
        agentId: null,
        agentNickname: null,
        messageId: null,
        args: { kind: 'replace', anchor: anchors.p1, markdown: 'v1' },
      });
      await executeApplyContentEdit({
        talkId: TALK_A_ID,
        userId: USER_A_ID,
        runId: 'run-1',
        agentId: null,
        agentNickname: null,
        messageId: null,
        args: { kind: 'replace', anchor: anchors.p1, markdown: 'v2' },
      });
      const pending = await getPendingEditsByContent(contentId);
      expect(pending.length).toBe(1);
      expect(pending[0].kind).toBe('replace');
      expect(pending[0].newMarkdown).toBe('v2');
    });
  });

  it('executeApplyContentEdit: anchor_missing on replace/delete returns isError', async () => {
    await seedDoc(USER_A_ID, TALK_A_ID);
    await withUserContext(USER_A_ID, async () => {
      const result = await executeApplyContentEdit({
        talkId: TALK_A_ID,
        userId: USER_A_ID,
        runId: 'run-1',
        agentId: null,
        agentNickname: null,
        messageId: null,
        args: {
          kind: 'replace',
          anchor: 'nope',
          markdown: 'never lands',
        },
      });
      expect(result.isError).toBe(true);
      expect(result.result).toContain('anchor');
    });
  });

  it('executeApplyContentEdit: bulk -> non-bulk in same run is rejected', async () => {
    await seedDoc(USER_A_ID, TALK_A_ID);
    await withUserContext(USER_A_ID, async () => {
      await executeApplyContentEdit({
        talkId: TALK_A_ID,
        userId: USER_A_ID,
        runId: 'run-1',
        agentId: null,
        agentNickname: null,
        messageId: null,
        args: { kind: 'bulk', markdown: '# Bulk\n\nNew body.' },
      });
      const result = await executeApplyContentEdit({
        talkId: TALK_A_ID,
        userId: USER_A_ID,
        runId: 'run-1',
        agentId: null,
        agentNickname: null,
        messageId: null,
        args: { kind: 'replace', anchor: 'p1', markdown: 'fails' },
      });
      expect(result.isError).toBe(true);
    });
  });

  it('RLS: user B cannot read user A pending edits', async () => {
    const { contentId, bodyVersion, anchors } = await seedDoc(
      USER_A_ID,
      TALK_A_ID,
    );
    await withUserContext(USER_A_ID, async () => {
      await insertPendingEdit({
        contentId,
        runId: 'run-1',
        agentId: null,
        agentNickname: null,
        messageId: null,
        kind: 'insert',
        baseContentVersion: bodyVersion,
        targetAnchorId: anchors.p1,
        newMarkdown: 'Private.',
        rationale: null,
      });
    });
    await withUserContext(USER_B_ID, async () => {
      const fromOther = await getPendingEditsByContent(contentId);
      expect(fromOther.length).toBe(0);
    });
  });
});
