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
  getUserGoogleCredential,
  listTalkResourceBindings,
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
