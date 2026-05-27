// Talk-snapshot route — vitest coverage for PR A.
//
// Direct handler tests (skip the HTTP layer; auth context is passed in
// directly). Mirror the talk-resources.test.ts pattern: seed users +
// talks via getDbPg under the bypass-RLS role, then drive the route
// handler with an `AUTH_X` context object. The route itself opens
// `withUserContextIsolated` internally; we do not need to wrap calls.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../../db.js';
import { appendOutboxEvent, createTalkMessage } from '../../db/accessors.js';
import type { AuthContext } from '../types.js';
import { getTalkSnapshotRoute } from './talk-snapshot.js';

const USER_A_ID = '0c888889-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = '0c888889-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TALK_A_ID = '0c888889-cccc-cccc-cccc-ccccccccc0a1';

const AUTH_A: AuthContext = {
  sessionId: 'session-a',
  userId: USER_A_ID,
  role: 'owner',
  authType: 'cookie',
};
const AUTH_B: AuthContext = {
  sessionId: 'session-b',
  userId: USER_B_ID,
  role: 'owner',
  authType: 'cookie',
};

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
    values (${talkId}::uuid, ${ownerId}::uuid, 'Snapshot Route Test')
    on conflict (id) do nothing
  `;
  await db`
    insert into public.talk_threads (talk_id, owner_id, is_default)
    values (${talkId}::uuid, ${ownerId}::uuid, true)
    on conflict do nothing
  `;
}

async function resetTalk(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.talks where id = ${TALK_A_ID}::uuid`;
  await db`delete from public.event_outbox where topic = ${`talk:${TALK_A_ID}`}`;
}

beforeAll(async () => {
  await initPgDatabase();
  await seedAuthUser(USER_A_ID, 'snapr-a@clawtalk.local', 'SnapRoute A');
  await seedAuthUser(USER_B_ID, 'snapr-b@clawtalk.local', 'SnapRoute B');
});

afterAll(async () => {
  await resetTalk();
  const db = getDbPg();
  await db`
    delete from auth.users
    where id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
  `;
  await closePgDatabase();
});

beforeEach(async () => {
  await resetTalk();
  await seedTalk(TALK_A_ID, USER_A_ID);
});

describe('getTalkSnapshotRoute', () => {
  it('returns 200 + camelCase payload for the owner', async () => {
    let defaultThreadId = '';
    await withUserContext(USER_A_ID, async () => {
      const rows = await getDbPg()<{ id: string }[]>`
        select id from public.talk_threads
        where talk_id = ${TALK_A_ID}::uuid and is_default = true
        limit 1
      `;
      defaultThreadId = rows[0].id;
      await createTalkMessage({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        threadId: defaultThreadId,
        role: 'user',
        content: 'hello world',
      });
    });

    const result = await getTalkSnapshotRoute({
      auth: AUTH_A,
      talkId: TALK_A_ID,
    });
    expect(result.statusCode).toBe(200);
    if (!result.body.ok) throw new Error('expected ok');
    expect(result.body.data.talk.id).toBe(TALK_A_ID);
    expect(result.body.data.talk.ownerId).toBe(USER_A_ID);
    expect(result.body.data.activeThreadId).toBe(defaultThreadId);
    expect(result.body.data.messages.length).toBe(1);
    expect(result.body.data.messages[0].content).toBe('hello world');
    expect(result.body.data.hasOlderMessages).toBe(false);
    expect(typeof result.body.data.snapshotVersion).toBe('number');
    // Make sure we projected to camelCase (no snake_case leakage).
    expect(result.body.data.talk).not.toHaveProperty('owner_id');
    expect(result.body.data.talk).not.toHaveProperty('topic_title');
    expect(result.body.data.messages[0]).not.toHaveProperty('thread_id');
  });

  it('returns 404 when the caller is not the owner (RLS gate)', async () => {
    const result = await getTalkSnapshotRoute({
      auth: AUTH_B,
      talkId: TALK_A_ID,
    });
    expect(result.statusCode).toBe(404);
    if (result.body.ok) throw new Error('expected error');
    expect(result.body.error.code).toBe('talk_not_found');
  });

  it('returns 404 when the talk does not exist', async () => {
    const result = await getTalkSnapshotRoute({
      auth: AUTH_A,
      talkId: '00000000-0000-0000-0000-000000000404',
    });
    expect(result.statusCode).toBe(404);
  });

  it('honors the thread query param when provided', async () => {
    let defaultThreadId = '';
    let secondaryThreadId = '';
    await withUserContext(USER_A_ID, async () => {
      const def = await getDbPg()<{ id: string }[]>`
        select id from public.talk_threads
        where talk_id = ${TALK_A_ID}::uuid and is_default = true
        limit 1
      `;
      defaultThreadId = def[0].id;
      const secondaryRows = await getDbPg()<{ id: string }[]>`
        insert into public.talk_threads (talk_id, owner_id, title)
        values (${TALK_A_ID}::uuid, ${USER_A_ID}::uuid, 'Secondary')
        returning id
      `;
      secondaryThreadId = secondaryRows[0].id;
      await createTalkMessage({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        threadId: defaultThreadId,
        role: 'user',
        content: 'on default',
      });
      await createTalkMessage({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        threadId: secondaryThreadId,
        role: 'user',
        content: 'on secondary',
      });
    });

    const onSecondary = await getTalkSnapshotRoute({
      auth: AUTH_A,
      talkId: TALK_A_ID,
      threadId: secondaryThreadId,
    });
    expect(onSecondary.statusCode).toBe(200);
    if (!onSecondary.body.ok) throw new Error('expected ok');
    expect(onSecondary.body.data.activeThreadId).toBe(secondaryThreadId);
    expect(onSecondary.body.data.messages.length).toBe(1);
    expect(onSecondary.body.data.messages[0].content).toBe('on secondary');

    const onDefault = await getTalkSnapshotRoute({
      auth: AUTH_A,
      talkId: TALK_A_ID,
    });
    if (!onDefault.body.ok) throw new Error('expected ok');
    expect(onDefault.body.data.activeThreadId).toBe(defaultThreadId);
  });

  it('snapshotVersion advances after an outbox emit on the talk topic', async () => {
    const before = await getTalkSnapshotRoute({
      auth: AUTH_A,
      talkId: TALK_A_ID,
    });
    if (!before.body.ok) throw new Error('expected ok');
    const beforeVersion = before.body.data.snapshotVersion;

    const eventId = await appendOutboxEvent({
      topic: `talk:${TALK_A_ID}`,
      eventType: 'test_event',
      payload: { ok: true },
    });

    const after = await getTalkSnapshotRoute({
      auth: AUTH_A,
      talkId: TALK_A_ID,
    });
    if (!after.body.ok) throw new Error('expected ok');
    expect(after.body.data.snapshotVersion).toBeGreaterThan(beforeVersion);
    expect(after.body.data.snapshotVersion).toBe(eventId);
  });
});
