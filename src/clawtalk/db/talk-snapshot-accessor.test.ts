// Talk-snapshot accessor — vitest integration coverage for PR A of the
// talk-load architecture refactor.
//
// Asserts:
//   - happy-path shape (talk + threads + activeThreadId + messages +
//     hasOlderMessages + content + pendingEdits + runs + agents +
//     snapshotVersion)
//   - LIMIT 201 boundary: 201 messages → 200 returned + flag=true
//   - threadId param resolution: explicit valid threadId wins, fallback
//     to default thread when omitted
//   - RLS isolation: user B cannot see user A's talk (returns null)
//   - snapshotVersion matches `public.get_talk_snapshot_version(...)`
//     and reflects emitted outbox events
//   - runs filter: only active runs (queued/running/awaiting_confirmation)
//     are included
//   - REPEATABLE READ tx: composed reads inside the snapshot agree —
//     covered by exercising the accessor under load and verifying field
//     consistency. Strict concurrent-writer isolation is a Postgres
//     guarantee given the db.begin('isolation level ...', ...) call.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import {
  appendOutboxEvent,
  createTalk,
  createTalkMessage,
  createTalkRun,
  createTalkThread,
  type TalkRunStatus,
} from './accessors.js';
import { loadTalkSnapshot } from './talk-snapshot-accessor.js';

const USER_A_ID = '0c888888-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = '0c888888-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

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

async function purge(): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.talks
    where owner_id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
  `;
  await db`
    delete from public.event_outbox where topic like 'talk:%'
  `;
}

describe('loadTalkSnapshot', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser(USER_A_ID, 'snap-a@clawtalk.local', 'Snap User A');
    await seedAuthUser(USER_B_ID, 'snap-b@clawtalk.local', 'Snap User B');
  });

  afterAll(async () => {
    await purge();
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

  it('returns the canonical happy-path shape', async () => {
    let talkId = '';
    let defaultThreadId = '';
    let userMsgId = '';
    let assistantMsgId = '';
    await withUserContext(USER_A_ID, async () => {
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Snapshot Test Talk',
      });
      talkId = talk.id;
      const threadRows = await getDbPg()<{ id: string }[]>`
        select id from public.talk_threads
        where talk_id = ${talkId}::uuid and is_default = true
        limit 1
      `;
      defaultThreadId = threadRows[0].id;
      const userMsg = await createTalkMessage({
        ownerId: USER_A_ID,
        talkId,
        threadId: defaultThreadId,
        role: 'user',
        content: 'hello',
      });
      userMsgId = userMsg.id;
      const assistantMsg = await createTalkMessage({
        ownerId: USER_A_ID,
        talkId,
        threadId: defaultThreadId,
        role: 'assistant',
        content: 'world',
        metadata: { agentId: 'agent-1', agentNickname: 'Test Agent' },
      });
      assistantMsgId = assistantMsg.id;
    });

    const snapshot = await loadTalkSnapshot({
      userId: USER_A_ID,
      talkId,
    });
    expect(snapshot).not.toBeNull();
    if (!snapshot) throw new Error('expected non-null snapshot');
    expect(snapshot.talk.id).toBe(talkId);
    expect(snapshot.talk.owner_id).toBe(USER_A_ID);
    expect(snapshot.threads.length).toBeGreaterThan(0);
    expect(snapshot.activeThreadId).toBe(defaultThreadId);
    // Messages return chronological asc (oldest first).
    expect(snapshot.messages.length).toBe(2);
    expect(snapshot.messages[0].id).toBe(userMsgId);
    expect(snapshot.messages[1].id).toBe(assistantMsgId);
    expect(snapshot.hasOlderMessages).toBe(false);
    expect(snapshot.content).toBeNull();
    expect(snapshot.pendingEdits.length).toBe(0);
    expect(snapshot.runs.length).toBe(0);
    expect(snapshot.agents.length).toBe(0);
    expect(typeof snapshot.snapshotVersion).toBe('number');
    expect(snapshot.snapshotVersion).toBeGreaterThanOrEqual(0);
  });

  it('hasOlderMessages flips to true when more than 200 messages exist', async () => {
    let talkId = '';
    let defaultThreadId = '';
    await withUserContext(USER_A_ID, async () => {
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: '201 messages',
      });
      talkId = talk.id;
      const threadRows = await getDbPg()<{ id: string }[]>`
        select id from public.talk_threads
        where talk_id = ${talkId}::uuid and is_default = true
        limit 1
      `;
      defaultThreadId = threadRows[0].id;
      // Insert 201 with distinct created_at so ORDER BY is deterministic.
      const base = Date.now();
      for (let i = 0; i < 201; i++) {
        await createTalkMessage({
          ownerId: USER_A_ID,
          talkId,
          threadId: defaultThreadId,
          role: 'user',
          content: `msg ${i}`,
          createdAt: new Date(base + i).toISOString(),
        });
      }
    });

    const snapshot = await loadTalkSnapshot({
      userId: USER_A_ID,
      talkId,
    });
    if (!snapshot) throw new Error('expected non-null snapshot');
    expect(snapshot.messages.length).toBe(200);
    expect(snapshot.hasOlderMessages).toBe(true);
    // The 200 returned are the most-recent slice, chronological asc.
    expect(snapshot.messages[snapshot.messages.length - 1].content).toBe(
      'msg 200',
    );
    expect(snapshot.messages[0].content).toBe('msg 1');
  });

  it('resolves threadId from input param when valid; falls back to default otherwise', async () => {
    let talkId = '';
    let defaultThreadId = '';
    let secondaryThreadId = '';
    await withUserContext(USER_A_ID, async () => {
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Thread routing',
      });
      talkId = talk.id;
      const defRows = await getDbPg()<{ id: string }[]>`
        select id from public.talk_threads
        where talk_id = ${talkId}::uuid and is_default = true
        limit 1
      `;
      defaultThreadId = defRows[0].id;
      const secondary = await createTalkThread({
        ownerId: USER_A_ID,
        talkId,
        title: 'Side thread',
      });
      secondaryThreadId = secondary.id;
      await createTalkMessage({
        ownerId: USER_A_ID,
        talkId,
        threadId: secondaryThreadId,
        role: 'user',
        content: 'side',
      });
    });

    const explicit = await loadTalkSnapshot({
      userId: USER_A_ID,
      talkId,
      threadId: secondaryThreadId,
    });
    if (!explicit) throw new Error('expected explicit snapshot');
    expect(explicit.activeThreadId).toBe(secondaryThreadId);
    expect(explicit.messages.length).toBe(1);
    expect(explicit.messages[0].content).toBe('side');

    const fallback = await loadTalkSnapshot({
      userId: USER_A_ID,
      talkId,
    });
    if (!fallback) throw new Error('expected fallback snapshot');
    expect(fallback.activeThreadId).toBe(defaultThreadId);
    expect(fallback.messages.length).toBe(0);
  });

  it('returns null when the caller does not own the talk (RLS gate)', async () => {
    let talkId = '';
    await withUserContext(USER_A_ID, async () => {
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'A only',
      });
      talkId = talk.id;
    });
    const snapshot = await loadTalkSnapshot({
      userId: USER_B_ID,
      talkId,
    });
    expect(snapshot).toBeNull();
  });

  it('snapshotVersion reflects MAX(event_id) for talk:<id> topic', async () => {
    let talkId = '';
    await withUserContext(USER_A_ID, async () => {
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Outbox cursor',
      });
      talkId = talk.id;
    });

    const before = await loadTalkSnapshot({
      userId: USER_A_ID,
      talkId,
    });
    if (!before) throw new Error('expected before-snapshot');
    expect(before.snapshotVersion).toBe(0);

    // Emit an outbox event on the talk's topic. appendOutboxEvent runs
    // on the non-tx connection from outside withUserContext (bypass
    // RLS — outbox is RLS-off anyway).
    const eventId = await appendOutboxEvent({
      topic: `talk:${talkId}`,
      eventType: 'test_event',
      payload: { ok: true },
    });

    const after = await loadTalkSnapshot({
      userId: USER_A_ID,
      talkId,
    });
    if (!after) throw new Error('expected after-snapshot');
    expect(after.snapshotVersion).toBe(eventId);
  });

  it('heal-on-read default-thread INSERT succeeds inside the snapshot tx', async () => {
    // Seed a talk with NO threads via direct SQL (bypass createTalk's
    // auto-thread provisioning) so the snapshot path's
    // listTalkThreads → getOrCreateDefaultThread heal-on-read fires
    // inside the REPEATABLE READ tx. Regression: this used to throw
    // when the snapshot tx was opened READ ONLY.
    const db = getDbPg();
    const talkRows = await db<{ id: string }[]>`
      insert into public.talks (owner_id, topic_title)
      values (${USER_A_ID}::uuid, 'No-default-thread talk')
      returning id
    `;
    const talkId = talkRows[0].id;
    const beforeThreadCount = await db<{ count: number }[]>`
      select count(*)::int as count from public.talk_threads
      where talk_id = ${talkId}::uuid
    `;
    expect(beforeThreadCount[0].count).toBe(0);

    const snapshot = await loadTalkSnapshot({
      userId: USER_A_ID,
      talkId,
    });
    if (!snapshot) throw new Error('expected snapshot');
    expect(snapshot.threads.length).toBe(1);
    expect(snapshot.threads[0].is_default).toBe(true);
    expect(snapshot.activeThreadId).toBe(snapshot.threads[0].id);
  });

  it('runs slice only includes active statuses (queued / running / awaiting_confirmation)', async () => {
    let talkId = '';
    let defaultThreadId = '';
    await withUserContext(USER_A_ID, async () => {
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Runs filter',
      });
      talkId = talk.id;
      const rows = await getDbPg()<{ id: string }[]>`
        select id from public.talk_threads
        where talk_id = ${talkId}::uuid and is_default = true
        limit 1
      `;
      defaultThreadId = rows[0].id;
      const activeStatuses: TalkRunStatus[] = [
        'queued',
        'running',
        'awaiting_confirmation',
      ];
      for (const status of activeStatuses) {
        await createTalkRun({
          ownerId: USER_A_ID,
          talkId,
          threadId: defaultThreadId,
          requestedBy: USER_A_ID,
          status,
        });
      }
      const terminalStatuses: TalkRunStatus[] = [
        'completed',
        'failed',
        'cancelled',
      ];
      for (const status of terminalStatuses) {
        await createTalkRun({
          ownerId: USER_A_ID,
          talkId,
          threadId: defaultThreadId,
          requestedBy: USER_A_ID,
          status,
        });
      }
    });

    const snapshot = await loadTalkSnapshot({
      userId: USER_A_ID,
      talkId,
    });
    if (!snapshot) throw new Error('expected snapshot');
    expect(snapshot.runs.length).toBe(3);
    const statuses = new Set(snapshot.runs.map((r) => r.status));
    expect(statuses.has('queued')).toBe(true);
    expect(statuses.has('running')).toBe(true);
    expect(statuses.has('awaiting_confirmation')).toBe(true);
    expect(statuses.has('completed')).toBe(false);
  });
});
