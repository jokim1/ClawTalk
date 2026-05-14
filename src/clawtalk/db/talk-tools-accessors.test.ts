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

      // Second call with same (talkId, bindingKind, externalId) should
      // dedupe — return the existing row, not throw.
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
