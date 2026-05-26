// clawtalk Phase 5 (PR 2) — end-to-end test for talk-tools-accessors-pg.
//
// Covers talk_resource_bindings, user_google_credentials,
// google_oauth_link_requests. The chassis-removed talk_tool_grants
// surface was dropped — no test for it.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import {
  createGoogleOAuthLinkRequest,
  createTalkResourceBinding,
  deleteGoogleOAuthLinkRequest,
  deleteTalkResourceBinding,
  deleteUserGoogleCredential,
  getGoogleOAuthLinkRequest,
  getTalkActiveTools,
  getTalkAvailableFamilies,
  getUserGoogleCredential,
  listTalkResourceBindings,
  mergeAgentToolsIntoTalkActive,
  setTalkActiveTool,
  upsertUserGoogleCredential,
} from './talk-tools-accessors.js';

const USER_A_ID = '0c444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = '0c444444-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TALK_A_ID = '0c444444-cccc-cccc-cccc-ccccccccc0a1';

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
    values (${talkId}::uuid, ${ownerId}::uuid, 'Tools Test Talk')
    on conflict (id) do nothing
  `;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.talks where id = ${TALK_A_ID}::uuid`;
  await seedTalk(TALK_A_ID, USER_A_ID);
  await db`
    delete from public.user_google_credentials
    where user_id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
  `;
  await db`
    delete from public.google_oauth_link_requests
    where user_id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
  `;
}

describe('talk-tools-accessors-pg (postgres + RLS)', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser(USER_A_ID, 'tools-a@clawtalk.local', 'Tools User A');
    await seedAuthUser(USER_B_ID, 'tools-b@clawtalk.local', 'Tools User B');
    await seedTalk(TALK_A_ID, USER_A_ID);
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

  it('resource bindings: create + dedupe-on-conflict + list + delete', async () => {
    await withUserContext(USER_A_ID, async () => {
      const created = await createTalkResourceBinding({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        bindingKind: 'google_drive_folder',
        externalId: 'folder-123',
        displayName: 'Project Docs',
        metadata: { driveId: 'abc' },
        createdBy: USER_A_ID,
      });
      expect(created.bindingKind).toBe('google_drive_folder');
      expect(created.metadata).toEqual({ driveId: 'abc' });

      // Same (talkId, bindingKind, externalId, owner) is idempotent under
      // the 4-column conflict target — dedupes to the original row.
      const dedup = await createTalkResourceBinding({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        bindingKind: 'google_drive_folder',
        externalId: 'folder-123',
        displayName: 'Project Docs (renamed in second call — ignored)',
        createdBy: USER_A_ID,
      });
      expect(dedup.id).toBe(created.id);

      const list = await listTalkResourceBindings(TALK_A_ID);
      expect(list.length).toBe(1);

      expect(await deleteTalkResourceBinding(TALK_A_ID, created.id)).toBe(true);
      expect((await listTalkResourceBindings(TALK_A_ID)).length).toBe(0);
    });
  });

  it('C2: two users binding the same external_id to the same talk each get their own row', async () => {
    // Pre-0018, the 3-column unique index (talk_id, binding_kind,
    // external_id) made B's INSERT silently swallowed by ON CONFLICT
    // DO NOTHING, then B's RLS-scoped follow-up SELECT returned zero
    // rows and the accessor threw. Migration 0018 widened the index
    // to include owner_id, matching the RLS scope.
    const EXTERNAL_ID = 'shared-folder-x';

    await withUserContext(USER_A_ID, async () => {
      const createdByA = await createTalkResourceBinding({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        bindingKind: 'google_drive_folder',
        externalId: EXTERNAL_ID,
        displayName: 'A view of shared folder',
        createdBy: USER_A_ID,
      });
      expect(createdByA.ownerId).toBe(USER_A_ID);
      expect((await listTalkResourceBindings(TALK_A_ID)).length).toBe(1);
    });

    await withUserContext(USER_B_ID, async () => {
      const createdByB = await createTalkResourceBinding({
        ownerId: USER_B_ID,
        talkId: TALK_A_ID,
        bindingKind: 'google_drive_folder',
        externalId: EXTERNAL_ID,
        displayName: 'B view of shared folder',
        createdBy: USER_B_ID,
      });
      expect(createdByB.ownerId).toBe(USER_B_ID);
      expect(createdByB.displayName).toBe('B view of shared folder');
      // B's RLS-scoped list returns only B's row.
      const bList = await listTalkResourceBindings(TALK_A_ID);
      expect(bList.length).toBe(1);
      expect(bList[0].ownerId).toBe(USER_B_ID);

      // Same-owner re-bind by B is still idempotent.
      const dedup = await createTalkResourceBinding({
        ownerId: USER_B_ID,
        talkId: TALK_A_ID,
        bindingKind: 'google_drive_folder',
        externalId: EXTERNAL_ID,
        displayName: 'B view (second call ignored)',
        createdBy: USER_B_ID,
      });
      expect(dedup.id).toBe(createdByB.id);
    });

    // Cross-check from the DB level: both rows actually exist.
    const db = getDbPg();
    const rows = await db<{ owner_id: string }[]>`
      select owner_id
      from public.talk_resource_bindings
      where talk_id = ${TALK_A_ID}::uuid
        and binding_kind = 'google_drive_folder'
        and external_id = ${EXTERNAL_ID}
      order by owner_id
    `;
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.owner_id).sort()).toEqual(
      [USER_A_ID, USER_B_ID].sort(),
    );
  });

  it('user_google_credentials: upsert + read + delete + scopes dedupe', async () => {
    await withUserContext(USER_A_ID, async () => {
      const first = await upsertUserGoogleCredential({
        userId: USER_A_ID,
        googleSubject: 'sub-1',
        email: 'a@gmail.com',
        scopes: ['drive.readonly', 'gmail.readonly', 'drive.readonly'],
        ciphertext: 'cipher-v1',
      });
      // Scopes deduped + sorted.
      expect(first.scopes).toEqual(['drive.readonly', 'gmail.readonly']);

      const updated = await upsertUserGoogleCredential({
        userId: USER_A_ID,
        googleSubject: 'sub-1',
        email: 'a@gmail.com',
        scopes: ['drive.readonly', 'docs'],
        ciphertext: 'cipher-v2',
      });
      expect(updated.ciphertext).toBe('cipher-v2');
      expect(updated.scopes).toEqual(['docs', 'drive.readonly']);

      const got = await getUserGoogleCredential();
      expect(got?.ciphertext).toBe('cipher-v2');

      expect(await deleteUserGoogleCredential()).toBe(true);
      expect(await getUserGoogleCredential()).toBeUndefined();
    });
  });

  it('oauth link request: idempotent state_hash + read + delete', async () => {
    await withUserContext(USER_A_ID, async () => {
      const created = await createGoogleOAuthLinkRequest({
        userId: USER_A_ID,
        stateHash: 'state-hash-1',
        scopes: ['drive.readonly'],
      });
      expect(created.scopes).toEqual(['drive.readonly']);

      // Idempotent on state_hash — same key, new scopes overwrite.
      const overwritten = await createGoogleOAuthLinkRequest({
        userId: USER_A_ID,
        stateHash: 'state-hash-1',
        scopes: ['drive.readonly', 'docs'],
      });
      expect(overwritten.scopes).toEqual(['docs', 'drive.readonly']);

      const got = await getGoogleOAuthLinkRequest('state-hash-1');
      expect(got?.userId).toBe(USER_A_ID);

      expect(await deleteGoogleOAuthLinkRequest('state-hash-1')).toBe(true);
      expect(await getGoogleOAuthLinkRequest('state-hash-1')).toBeUndefined();
    });
  });

  it('RLS gate: user B cannot see user A talk bindings or credentials', async () => {
    await withUserContext(USER_A_ID, async () => {
      await createTalkResourceBinding({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        bindingKind: 'saved_source',
        externalId: 'src-1',
        displayName: 'A only',
        createdBy: USER_A_ID,
      });
      await upsertUserGoogleCredential({
        userId: USER_A_ID,
        googleSubject: 'a-sub',
        email: 'a@gmail.com',
        scopes: ['drive.readonly'],
        ciphertext: 'A cipher',
      });
      await createGoogleOAuthLinkRequest({
        userId: USER_A_ID,
        stateHash: 'a-hash',
        scopes: ['drive.readonly'],
      });
    });

    await withUserContext(USER_B_ID, async () => {
      expect((await listTalkResourceBindings(TALK_A_ID)).length).toBe(0);
      expect(await getUserGoogleCredential()).toBeUndefined();
      // state_hash IS the lookup key but RLS still filters by user_id.
      expect(await getGoogleOAuthLinkRequest('a-hash')).toBeUndefined();
    });
  });

  it('RLS gate: cross-user writes rejected by WITH CHECK', async () => {
    await expect(
      withUserContext(USER_B_ID, async () => {
        await createTalkResourceBinding({
          ownerId: USER_A_ID,
          talkId: TALK_A_ID,
          bindingKind: 'saved_source',
          externalId: 'hijack',
          displayName: 'pwned',
          createdBy: USER_B_ID,
        });
      }),
    ).rejects.toThrow();

    await expect(
      withUserContext(USER_B_ID, async () => {
        await upsertUserGoogleCredential({
          userId: USER_A_ID,
          googleSubject: 'hijack',
          email: 'a@gmail.com',
          scopes: [],
          ciphertext: 'pwned',
        });
      }),
    ).rejects.toThrow();
  });
});

// ----------------------------------------------------------------------------
// Talk active-tool families (migration 0031)
// ----------------------------------------------------------------------------

describe('talk active-tool families (postgres + RLS)', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser(USER_A_ID, 'tools-a@clawtalk.local', 'Tools User A');
    await seedTalk(TALK_A_ID, USER_A_ID);
  });

  afterAll(async () => {
    const db = getDbPg();
    await db`delete from auth.users where id = ${USER_A_ID}::uuid`;
    await closePgDatabase();
  });

  beforeEach(async () => {
    const db = getDbPg();
    // Reset the Talk to default '{}' active_tool_families_json and drop any
    // agents seeded by a prior test. Cascade clears talk_agents.
    await db`delete from public.talks where id = ${TALK_A_ID}::uuid`;
    await seedTalk(TALK_A_ID, USER_A_ID);
    await db`delete from public.registered_agents where owner_id = ${USER_A_ID}::uuid`;
  });

  async function seedAgent(
    id: string,
    name: string,
    toolPermissions: Record<string, boolean>,
  ): Promise<void> {
    const db = getDbPg();
    await db`
      insert into public.registered_agents
        (id, owner_id, name, provider_id, model_id, tool_permissions_json)
      values
        (${id}::uuid, ${USER_A_ID}::uuid, ${name}, 'provider.anthropic',
         'claude-opus-4-7', ${db.json(toolPermissions as never)})
    `;
    await db`
      insert into public.talk_agents (talk_id, owner_id, registered_agent_id)
      values (${TALK_A_ID}::uuid, ${USER_A_ID}::uuid, ${id}::uuid)
    `;
  }

  it('getTalkActiveTools: returns {} for a freshly-created Talk', async () => {
    await withUserContext(USER_A_ID, async () => {
      const active = await getTalkActiveTools(TALK_A_ID);
      expect(active).toEqual({});
    });
  });

  it('setTalkActiveTool: flips a single key, leaves siblings untouched', async () => {
    await withUserContext(USER_A_ID, async () => {
      const afterWeb = await setTalkActiveTool(TALK_A_ID, 'web', true);
      expect(afterWeb).toEqual({ web: true });

      const afterDrive = await setTalkActiveTool(
        TALK_A_ID,
        'google_read',
        true,
      );
      expect(afterDrive).toEqual({ web: true, google_read: true });

      const afterWebOff = await setTalkActiveTool(TALK_A_ID, 'web', false);
      expect(afterWebOff).toEqual({ web: false, google_read: true });

      // Reading separately matches the last set state.
      const fetched = await getTalkActiveTools(TALK_A_ID);
      expect(fetched).toEqual({ web: false, google_read: true });
    });
  });

  it('setTalkActiveTool: throws when the Talk does not exist', async () => {
    const MISSING_ID = '0c444444-eeee-eeee-eeee-eeeeeeeeeeee';
    await withUserContext(USER_A_ID, async () => {
      await expect(setTalkActiveTool(MISSING_ID, 'web', true)).rejects.toThrow(
        /not found/,
      );
    });
  });

  it('getTalkAvailableFamilies: union of assigned agents (true keys only)', async () => {
    await withUserContext(USER_A_ID, async () => {
      await seedAgent('0c444444-1111-1111-1111-aaaaaaaaaaaa', 'researcher', {
        web: true,
        google_read: true,
        filesystem: false,
      });
      await seedAgent('0c444444-2222-2222-2222-aaaaaaaaaaaa', 'editor', {
        shell: true,
        google_read: true,
      });

      const families = await getTalkAvailableFamilies(TALK_A_ID);
      // Sorted by key, deduped, `false` values excluded.
      expect(families).toEqual(['google_read', 'shell', 'web']);
    });
  });

  it('getTalkAvailableFamilies: returns [] for a Talk with no agents', async () => {
    await withUserContext(USER_A_ID, async () => {
      const families = await getTalkAvailableFamilies(TALK_A_ID);
      expect(families).toEqual([]);
    });
  });

  it('mergeAgentToolsIntoTalkActive: empty agent list is a no-op', async () => {
    await withUserContext(USER_A_ID, async () => {
      await setTalkActiveTool(TALK_A_ID, 'web', true);
      const result = await mergeAgentToolsIntoTalkActive(TALK_A_ID, []);
      expect(result).toEqual({ web: true });
    });
  });

  it('mergeAgentToolsIntoTalkActive: ORs new agent capabilities in, leaves existing true/false untouched', async () => {
    await withUserContext(USER_A_ID, async () => {
      // Pre-existing state: web is explicitly disabled, google_read is on.
      await setTalkActiveTool(TALK_A_ID, 'web', false);
      await setTalkActiveTool(TALK_A_ID, 'google_read', true);

      await seedAgent('0c444444-3333-3333-3333-aaaaaaaaaaaa', 'newagent', {
        web: true,
        gmail_read: true,
        filesystem: false,
      });

      const merged = await mergeAgentToolsIntoTalkActive(TALK_A_ID, [
        '0c444444-3333-3333-3333-aaaaaaaaaaaa',
      ]);
      // OR semantics on true keys: web flips back to true (added by agent).
      // gmail_read newly added (true). filesystem stays absent (not true on agent).
      // google_read stays true (preserved).
      expect(merged).toEqual({
        web: true,
        google_read: true,
        gmail_read: true,
      });
    });
  });

  it('mergeAgentToolsIntoTalkActive: unknown agent IDs are silently skipped', async () => {
    await withUserContext(USER_A_ID, async () => {
      await setTalkActiveTool(TALK_A_ID, 'web', true);
      const merged = await mergeAgentToolsIntoTalkActive(TALK_A_ID, [
        '0c444444-9999-9999-9999-aaaaaaaaaaaa',
      ]);
      expect(merged).toEqual({ web: true });
    });
  });
});
