// clawtalk Phase 5 (PR 2) — end-to-end test for context-accessors-pg.
//
// Mirrors agent-accessors-pg.test.ts. Seeds two users + a talk per user,
// exercises goal/rule/state/source CRUD inside withUserContext, asserts
// the cross-user RLS boundary. CAS round-trip on talk_state_entries is
// the load-bearing assertion — version drift must reject and return
// the current row.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import {
  createTalkContextRule,
  createTalkContextSource,
  deleteTalkContextRule,
  deleteTalkContextSource,
  deleteTalkStateEntry,
  forceDeleteTalkStateEntry,
  getActiveRuleCount,
  getTalkContext,
  getTalkContextSourceById,
  getTalkContextSourceCount,
  getTalkGoal,
  getTalkStateEntry,
  getTalkStateEntryCount,
  listTalkContextRules,
  listTalkContextSources,
  listTalkStateEntries,
  MAX_STATE_ENTRIES_PER_TALK,
  patchTalkContextRule,
  setTalkGoal,
  upsertTalkStateEntry,
} from './context-accessors.js';

const USER_A_ID = '0c222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = '0c222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TALK_A_ID = '0c222222-cccc-cccc-cccc-ccccccccc0a1';
const TALK_B_ID = '0c222222-cccc-cccc-cccc-ccccccccc0b1';

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
    values (${talkId}::uuid, ${ownerId}::uuid, 'Context Test Talk')
    on conflict (id) do nothing
  `;
}

async function purge(): Promise<void> {
  // Cleanup runs as postgres role (BYPASSRLS). Cascade-delete the talks;
  // talk_context_*, talk_state_entries, sources all cascade.
  const db = getDbPg();
  await db`
    delete from public.talks
    where id in (${TALK_A_ID}::uuid, ${TALK_B_ID}::uuid)
  `;
  await seedTalk(TALK_A_ID, USER_A_ID);
  await seedTalk(TALK_B_ID, USER_B_ID);
}

describe('context-accessors-pg (postgres + RLS)', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser(USER_A_ID, 'ctx-a@clawtalk.local', 'Ctx User A');
    await seedAuthUser(USER_B_ID, 'ctx-b@clawtalk.local', 'Ctx User B');
    await seedTalk(TALK_A_ID, USER_A_ID);
    await seedTalk(TALK_B_ID, USER_B_ID);
  });

  afterAll(async () => {
    const db = getDbPg();
    await db`
      delete from auth.users
      where id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
    `;
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purge();
  });

  it('schema: RLS enabled + policies present on context tables', async () => {
    const db = getDbPg();
    const tables = [
      'talk_context_goal',
      'talk_context_rules',
      'talk_context_sources',
      'talk_context_source_ref_counter',
      'talk_state_entries',
      'talk_message_attachments',
    ];
    const rows = await db<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ${db(tables)}
    `;
    expect(rows.length).toBe(tables.length);
    for (const row of rows) expect(row.relrowsecurity).toBe(true);
  });

  it('goal: upsert, idempotent overwrite, empty-text deletes', async () => {
    await withUserContext(USER_A_ID, async () => {
      const initial = await getTalkGoal(TALK_A_ID);
      expect(initial).toBeNull();

      const set1 = await setTalkGoal({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        goalText: 'Find three case studies',
        updatedBy: USER_A_ID,
      });
      expect(set1?.goalText).toBe('Find three case studies');

      const set2 = await setTalkGoal({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        goalText: 'Find five case studies',
        updatedBy: USER_A_ID,
      });
      expect(set2?.goalText).toBe('Find five case studies');

      const cleared = await setTalkGoal({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        goalText: '   ',
        updatedBy: USER_A_ID,
      });
      expect(cleared).toBeNull();
      expect(await getTalkGoal(TALK_A_ID)).toBeNull();
    });
  });

  it('rules: CRUD + active-count cap at 8', async () => {
    await withUserContext(USER_A_ID, async () => {
      const r1 = await createTalkContextRule({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        ruleText: 'Cite sources',
      });
      expect(r1.isActive).toBe(true);
      expect(r1.sortOrder).toBe(0);

      const r2 = await createTalkContextRule({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        ruleText: 'Use plain language',
      });
      expect(r2.sortOrder).toBe(1);

      expect(await getActiveRuleCount(TALK_A_ID)).toBe(2);

      const patched = await patchTalkContextRule({
        ruleId: r1.id,
        talkId: TALK_A_ID,
        isActive: false,
      });
      expect(patched?.isActive).toBe(false);
      expect(await getActiveRuleCount(TALK_A_ID)).toBe(1);

      const all = await listTalkContextRules(TALK_A_ID);
      expect(all.length).toBe(2);

      // Fill to the cap of 8 active rules.
      for (let i = 0; i < 7; i++) {
        await createTalkContextRule({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          ruleText: `Rule ${i}`,
        });
      }
      expect(await getActiveRuleCount(TALK_A_ID)).toBe(8);
      await expect(
        createTalkContextRule({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          ruleText: 'overflow',
        }),
      ).rejects.toThrow(/Maximum 8 active rules/);

      expect(await deleteTalkContextRule(r2.id, TALK_A_ID)).toBe(true);
      expect(await deleteTalkContextRule(r2.id, TALK_A_ID)).toBe(false);
    });
  });

  it('state: CAS upsert round-trip + version conflict', async () => {
    await withUserContext(USER_A_ID, async () => {
      const created = await upsertTalkStateEntry({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        key: 'summary',
        value: { mood: 'bullish' },
        expectedVersion: 0,
        updatedByUserId: USER_A_ID,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error('unreachable');
      expect(created.entry.version).toBe(1);
      expect(created.entry.value).toEqual({ mood: 'bullish' });

      const updated = await upsertTalkStateEntry({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        key: 'summary',
        value: { mood: 'neutral' },
        expectedVersion: 1,
        updatedByUserId: USER_A_ID,
      });
      expect(updated.ok).toBe(true);
      if (!updated.ok) throw new Error('unreachable');
      expect(updated.entry.version).toBe(2);

      const conflict = await upsertTalkStateEntry({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        key: 'summary',
        value: { mood: 'bearish' },
        expectedVersion: 1,
        updatedByUserId: USER_A_ID,
      });
      expect(conflict.ok).toBe(false);
      if (conflict.ok) throw new Error('unreachable');
      expect(conflict.current.version).toBe(2);
      expect(conflict.current.value).toEqual({ mood: 'neutral' });

      // Missing key + nonzero expectedVersion → throw.
      await expect(
        upsertTalkStateEntry({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          key: 'missing',
          value: 'nope',
          expectedVersion: 1,
        }),
      ).rejects.toThrow(/expectedVersion 0/i);

      // Delete with matching version succeeds.
      const got = await getTalkStateEntry(TALK_A_ID, 'summary');
      expect(got?.version).toBe(2);
      const del = await deleteTalkStateEntry({
        talkId: TALK_A_ID,
        key: 'summary',
        expectedVersion: 2,
      });
      expect(del.ok).toBe(true);

      // force-delete returns false on missing.
      expect(await forceDeleteTalkStateEntry(TALK_A_ID, 'never_existed')).toBe(
        false,
      );
    });
  });

  it('state: per-talk cap rejects overflow', async () => {
    await withUserContext(USER_A_ID, async () => {
      for (let i = 0; i < MAX_STATE_ENTRIES_PER_TALK; i++) {
        const r = await upsertTalkStateEntry({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          key: `key_${i}`,
          value: i,
          expectedVersion: 0,
        });
        expect(r.ok).toBe(true);
      }
      expect(await getTalkStateEntryCount(TALK_A_ID)).toBe(
        MAX_STATE_ENTRIES_PER_TALK,
      );
      await expect(
        upsertTalkStateEntry({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          key: 'one_too_many',
          value: 'x',
          expectedVersion: 0,
        }),
      ).rejects.toThrow(/Maximum.*state entries/i);
    });
  });

  it('sources: create allocates S1/S2 refs, count cap, listing', async () => {
    await withUserContext(USER_A_ID, async () => {
      const s1 = await createTalkContextSource({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        sourceType: 'text',
        title: 'Note 1',
        extractedText: 'hello world',
        createdBy: USER_A_ID,
      });
      expect(s1.sourceRef).toBe('S1');
      expect(s1.status).toBe('ready');
      expect(s1.extractedTextLength).toBe('hello world'.length);

      const s2 = await createTalkContextSource({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        sourceType: 'url',
        title: 'Paper 1',
        sourceUrl: 'https://example.com/paper',
        createdBy: USER_A_ID,
      });
      expect(s2.sourceRef).toBe('S2');
      expect(s2.status).toBe('pending');

      expect(await getTalkContextSourceCount(TALK_A_ID)).toBe(2);
      const list = await listTalkContextSources(TALK_A_ID);
      expect(list.map((s) => s.sourceRef)).toEqual(['S1', 'S2']);

      const byId = await getTalkContextSourceById(s1.id, TALK_A_ID);
      expect(byId?.title).toBe('Note 1');

      expect(await deleteTalkContextSource(s1.id, TALK_A_ID)).toBe(true);
      expect(await getTalkContextSourceCount(TALK_A_ID)).toBe(1);
    });
  });

  it('snapshot: getTalkContext composes goal + rules + sources', async () => {
    await withUserContext(USER_A_ID, async () => {
      await setTalkGoal({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        goalText: 'g',
        updatedBy: USER_A_ID,
      });
      await createTalkContextRule({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        ruleText: 'r',
      });
      await createTalkContextSource({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        sourceType: 'text',
        title: 't',
        extractedText: 'body',
        createdBy: USER_A_ID,
      });
      const snap = await getTalkContext(TALK_A_ID);
      expect(snap.goal?.goalText).toBe('g');
      expect(snap.rules.length).toBe(1);
      expect(snap.sources.length).toBe(1);
    });
  });

  it('RLS gate: user B cannot read user A talk context', async () => {
    await withUserContext(USER_A_ID, async () => {
      await setTalkGoal({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        goalText: 'A-only goal',
        updatedBy: USER_A_ID,
      });
      await createTalkContextRule({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        ruleText: 'A-only rule',
      });
      await upsertTalkStateEntry({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        key: 'a_state',
        value: 'secret',
        expectedVersion: 0,
      });
      await createTalkContextSource({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        sourceType: 'text',
        title: 'A-only source',
        extractedText: 'private',
        createdBy: USER_A_ID,
      });
    });

    await withUserContext(USER_B_ID, async () => {
      // User B passes A's talkId — RLS filters everything out.
      expect(await getTalkGoal(TALK_A_ID)).toBeNull();
      expect((await listTalkContextRules(TALK_A_ID)).length).toBe(0);
      expect((await listTalkStateEntries(TALK_A_ID)).length).toBe(0);
      expect((await listTalkContextSources(TALK_A_ID)).length).toBe(0);
    });
  });

  it('RLS gate: user B INSERT with ownerId=USER_A rejected by WITH CHECK', async () => {
    // Talk A is owned by A; talk_context_rules.owner_id WITH CHECK
    // forces it equal auth.uid(). User B claiming to write A's row
    // should be rejected.
    await expect(
      withUserContext(USER_B_ID, async () => {
        await createTalkContextRule({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          ruleText: 'hijack',
        });
      }),
    ).rejects.toThrow();
  });
});
