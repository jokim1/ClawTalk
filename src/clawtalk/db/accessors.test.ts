// clawtalk Phase 5 (PR 2) — end-to-end test for accessors-pg (slice 1).
//
// Covers talks, folders, members, threads. Messages/runs/outbox/atomic
// ops are in subsequent slices; their own test files will land alongside.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import {
  appendAssistantMessageWithOutbox,
  appendOutboxEvent,
  appendRuntimeTalkMessage,
  canUserAccessTalk,
  canUserEditTalk,
  cancelTalkRunsAtomic,
  claimQueuedTalkRuns,
  completeRunAndPromoteNextAtomic,
  countRunningTalkRuns,
  createTalk,
  createTalkFolder,
  createTalkMessage,
  createTalkRun,
  createTalkThread,
  deleteTalkFolderAndMoveTalksToTopLevel,
  deleteTalkForOwner,
  deleteTalkMember,
  deleteTalkMessagesAtomic,
  deleteTalkThread,
  enqueueTalkTurnAtomic,
  failInterruptedRunsOnStartup,
  failRunAndPromoteNextAtomic,
  getIdempotencyCache,
  getOrCreateDefaultThread,
  getOutboxEventsForTopics,
  getOutboxMaxEventIdForTopics,
  getOutboxMinEventIdForTopics,
  getRunningTalkRun,
  getTalkById,
  getTalkForUser,
  getTalkIdsAccessibleByUser,
  getTalkMessageById,
  getTalkRunById,
  getTalkRunSelectedMode,
  getTalkRunTaskType,
  hasActiveTalkRuns,
  listQueuedTalkRuns,
  listRunningTalkRuns,
  listTalkFoldersForOwner,
  listTalkMessages,
  listTalkRunsForTalk,
  listTalkSidebarTreeForUser,
  listTalksForUser,
  listTalkThreads,
  markTalkRunStatus,
  patchTalkMetadata,
  pruneEventOutbox,
  pruneIdempotencyCache,
  renameTalkFolder,
  reorderTalkSidebarItem,
  resolveThreadIdForTalk,
  saveIdempotencyCache,
  searchTalkMessages,
  setTalkRunExecutorProfile,
  setTalkRunMetadata,
  TalkActiveRoundError,
  touchTalkUpdatedAt,
  updateTalkProjectPath,
  updateTalkRunMetadata,
  updateTalkThreadMetadata,
  updateTalkThreadTitle,
  upsertTalk,
  upsertTalkMember,
} from './accessors.js';

const USER_A_ID = '0c555555-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = '0c555555-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

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
  // Cascade through talks deletes folders/members/threads/messages.
  await db`
    delete from public.talks
    where owner_id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
  `;
  await db`
    delete from public.talk_folders
    where owner_id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
  `;
  await db`
    delete from public.idempotency_cache
    where user_id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
  `;
  await db`
    delete from public.event_outbox
    where topic like 'test-acc-%' or topic like 'talk:%'
  `;
}

describe('accessors-pg slice 1: talks/folders/members/threads', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser(USER_A_ID, 'acc-a@clawtalk.local', 'Acc User A');
    await seedAuthUser(USER_B_ID, 'acc-b@clawtalk.local', 'Acc User B');
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

  // ── Talks ──────────────────────────────────────────────────────────

  it('createTalk: inserts, bumps sibling sort_order, auto-creates default thread', async () => {
    await withUserContext(USER_A_ID, async () => {
      const t1 = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'First',
      });
      expect(t1.sort_order).toBe(0);
      expect(t1.owner_id).toBe(USER_A_ID);
      expect(t1.status).toBe('active');

      const t2 = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Second',
      });
      expect(t2.sort_order).toBe(0);

      // First talk got bumped to 1.
      const t1Refetched = await getTalkById(t1.id);
      expect(t1Refetched?.sort_order).toBe(1);

      // Default thread auto-created.
      const threads = await listTalkThreads({
        talkId: t1.id,
        ownerId: USER_A_ID,
      });
      expect(threads.length).toBe(1);
      expect(threads[0].is_default).toBe(true);
    });
  });

  it('listTalksForUser: returns own talks, RLS hides cross-user', async () => {
    await withUserContext(USER_A_ID, async () => {
      await createTalk({ ownerId: USER_A_ID, topicTitle: 'A1' });
      await createTalk({ ownerId: USER_A_ID, topicTitle: 'A2' });
    });
    await withUserContext(USER_B_ID, async () => {
      await createTalk({ ownerId: USER_B_ID, topicTitle: 'B1' });
    });

    await withUserContext(USER_A_ID, async () => {
      const list = await listTalksForUser({});
      expect(list.length).toBe(2);
      expect(list.every((t) => t.owner_id === USER_A_ID)).toBe(true);
      expect(list.every((t) => t.access_role === 'owner')).toBe(true);
    });
    await withUserContext(USER_B_ID, async () => {
      const list = await listTalksForUser({});
      expect(list.length).toBe(1);
      expect(list[0].topic_title).toBe('B1');
    });
  });

  it('upsertTalk: creates on first call, bumps version on conflict', async () => {
    const id = '0c555555-1111-1111-1111-111111111111';
    await withUserContext(USER_A_ID, async () => {
      await upsertTalk({
        ownerId: USER_A_ID,
        id,
        topicTitle: 'V1',
      });
      const t1 = await getTalkById(id);
      expect(t1?.version).toBe(1);

      await upsertTalk({
        ownerId: USER_A_ID,
        id,
        topicTitle: 'V2',
      });
      const t2 = await getTalkById(id);
      expect(t2?.version).toBe(2);
      expect(t2?.topic_title).toBe('V2');
    });
  });

  it('patchTalkMetadata: title + orchestrationMode roundtrip; version bumps', async () => {
    await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Original',
      });
      const patched = await patchTalkMetadata({
        ownerId: USER_A_ID,
        talkId: t.id,
        title: 'Renamed',
        orchestrationMode: 'panel',
      });
      expect(patched?.topic_title).toBe('Renamed');
      expect(patched?.orchestration_mode).toBe('panel');
      expect(patched?.version).toBe(t.version + 1);

      // title=null clears.
      const cleared = await patchTalkMetadata({
        ownerId: USER_A_ID,
        talkId: t.id,
        title: null,
      });
      expect(cleared?.topic_title).toBeNull();
    });
  });

  it('updateTalkProjectPath + touchTalkUpdatedAt + delete', async () => {
    await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({ ownerId: USER_A_ID, topicTitle: 'P' });
      const updated = await updateTalkProjectPath({
        talkId: t.id,
        projectPath: '/local/repo',
      });
      expect(updated?.project_path).toBe('/local/repo');

      await touchTalkUpdatedAt(t.id);
      const touched = await getTalkById(t.id);
      // No strict assertion on the timestamp diff — just that the row
      // still exists and updated_at parses.
      expect(touched).toBeDefined();
      expect(Date.parse(touched!.updated_at)).toBeGreaterThan(0);

      expect(await deleteTalkForOwner({ talkId: t.id })).toBe(true);
      expect(await getTalkById(t.id)).toBeUndefined();
    });
  });

  it('getTalkForUser returns access_role: owner for own talks', async () => {
    await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({ ownerId: USER_A_ID, topicTitle: 'Mine' });
      const got = await getTalkForUser(t.id);
      expect(got?.access_role).toBe('owner');
    });
  });

  // ── Folders ────────────────────────────────────────────────────────

  it('folders: create, rename, list, delete moves talks to top-level', async () => {
    await withUserContext(USER_A_ID, async () => {
      const folder = await createTalkFolder({
        ownerId: USER_A_ID,
        title: 'My Projects',
      });
      expect(folder.sort_order).toBe(0);

      const renamed = await renameTalkFolder({
        id: folder.id,
        title: 'Renamed',
      });
      expect(renamed?.title).toBe('Renamed');

      const list = await listTalkFoldersForOwner();
      expect(list.length).toBe(1);
      expect(list[0].title).toBe('Renamed');

      // Create a talk inside the folder by direct update (folder-move
      // helper lands in the sidebar slice).
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'In Folder',
      });
      const db = getDbPg();
      await db`
        update public.talks set folder_id = ${folder.id}::uuid
        where id = ${talk.id}::uuid
      `;
      expect(
        await deleteTalkFolderAndMoveTalksToTopLevel({
          id: folder.id,
          ownerId: USER_A_ID,
        }),
      ).toBe(true);
      const reparented = await getTalkById(talk.id);
      expect(reparented?.folder_id).toBeNull();
    });
  });

  // ── Members ────────────────────────────────────────────────────────

  it('members: owner can manage their talk_members rows', async () => {
    const talkId = await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({ ownerId: USER_A_ID, topicTitle: 'Shared' });
      return t.id;
    });

    // Talk owner adds USER_B as a member. Note: the talk_members RLS
    // policy in 0002 is SELECT-only ("self or talk-owner-can-see"); it
    // doesn't have a WITH CHECK clause for inserts. INSERTs require the
    // separate per-action policy that 0002 doesn't ship yet. Until the
    // sharing feature lands its policy expansion, talk_members writes
    // would fail under RLS. Run this assertion with BYPASSRLS to verify
    // the SQL/shape works — when the policy ships, drop the bypass.
    const adminDb = getDbPg();
    await adminDb`
      insert into public.talk_members (talk_id, user_id, role)
      values (${talkId}::uuid, ${USER_B_ID}::uuid, 'editor')
      on conflict (talk_id, user_id) do update set role = excluded.role
    `;

    // Verify USER_A can see the member row through the SELECT policy.
    await withUserContext(USER_A_ID, async () => {
      const db = getDbPg();
      const rows = await db<{ user_id: string; role: string }[]>`
        select user_id, role from public.talk_members
        where talk_id = ${talkId}::uuid
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].user_id).toBe(USER_B_ID);
      expect(rows[0].role).toBe('editor');
    });
  });

  it('access helpers: canUserAccessTalk / canUserEditTalk reflect RLS', async () => {
    const talkId = await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({ ownerId: USER_A_ID, topicTitle: 'Owned' });
      return t.id;
    });

    await withUserContext(USER_A_ID, async () => {
      expect(await canUserAccessTalk(talkId)).toBe(true);
      expect(await canUserEditTalk(talkId)).toBe(true);
      const ids = await getTalkIdsAccessibleByUser();
      expect(ids).toContain(talkId);
    });
    await withUserContext(USER_B_ID, async () => {
      // RLS hides A's talk from B entirely.
      expect(await canUserAccessTalk(talkId)).toBe(false);
      expect(await canUserEditTalk(talkId)).toBe(false);
      const ids = await getTalkIdsAccessibleByUser();
      expect(ids).not.toContain(talkId);
    });
  });

  // ── Threads ────────────────────────────────────────────────────────

  it('threads: create non-default, default heal-on-read, update metadata, delete refuses default', async () => {
    await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({ ownerId: USER_A_ID, topicTitle: 'T' });
      // createTalk already provisioned the default thread.
      const initialThreads = await listTalkThreads({
        talkId: t.id,
        ownerId: USER_A_ID,
      });
      expect(initialThreads.length).toBe(1);
      const defaultThreadId = initialThreads[0].id;
      expect(initialThreads[0].is_default).toBe(true);

      // Add a non-default thread.
      const second = await createTalkThread({
        ownerId: USER_A_ID,
        talkId: t.id,
        title: 'Side branch',
      });
      expect(second.is_default).toBe(false);
      expect(second.title).toBe('Side branch');

      // Title update + pin.
      const updated = await updateTalkThreadMetadata({
        talkId: t.id,
        threadId: second.id,
        title: 'Renamed',
        pinned: true,
      });
      expect(updated?.title).toBe('Renamed');
      expect(updated?.is_pinned).toBe(true);

      // updateTalkThreadTitle wrapper.
      const titleOnly = await updateTalkThreadTitle({
        talkId: t.id,
        threadId: second.id,
        title: 'Title only',
      });
      expect(titleOnly?.title).toBe('Title only');

      // Delete non-default — ok.
      expect(
        await deleteTalkThread({ talkId: t.id, threadId: second.id }),
      ).toBe(true);

      // Delete default — refused.
      await expect(
        deleteTalkThread({ talkId: t.id, threadId: defaultThreadId }),
      ).rejects.toThrow(/Cannot delete the default thread/);

      // resolveThreadIdForTalk falls back to default.
      const resolved = await resolveThreadIdForTalk({
        talkId: t.id,
        ownerId: USER_A_ID,
      });
      expect(resolved).toBe(defaultThreadId);

      // getOrCreateDefaultThread idempotent.
      const def2 = await getOrCreateDefaultThread({
        talkId: t.id,
        ownerId: USER_A_ID,
      });
      expect(def2).toBe(defaultThreadId);
    });
  });

  // ── Messages ───────────────────────────────────────────────────────

  it('messages: create, list (ordered ascending), search, getById', async () => {
    await withUserContext(USER_A_ID, async () => {
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Msg Talk',
      });
      const threadId = await getOrCreateDefaultThread({
        talkId: talk.id,
        ownerId: USER_A_ID,
      });

      // Explicit timestamps so the ordering assertion isn't at the mercy
      // of UUID tiebreaking when same-tx inserts share a microsecond.
      const m1 = await createTalkMessage({
        ownerId: USER_A_ID,
        talkId: talk.id,
        threadId,
        role: 'user',
        content: 'hello world',
        createdBy: USER_A_ID,
        createdAt: '2026-05-12T00:00:01.000Z',
      });
      const m2 = await createTalkMessage({
        ownerId: USER_A_ID,
        talkId: talk.id,
        threadId,
        role: 'assistant',
        content: 'goodbye world',
        metadata: { agentNickname: 'Argus' },
        createdAt: '2026-05-12T00:00:02.000Z',
      });
      expect(m1.content).toBe('hello world');
      expect(m2.metadata_json).toEqual({ agentNickname: 'Argus' });

      const list = await listTalkMessages({ talkId: talk.id });
      // Ascending by created_at — m1 first, m2 second.
      expect(list.map((m) => m.id)).toEqual([m1.id, m2.id]);

      const fetched = await getTalkMessageById(m1.id);
      expect(fetched?.content).toBe('hello world');

      const search = await searchTalkMessages({
        talkId: talk.id,
        query: 'world',
      });
      expect(search.length).toBe(2);
      const hello = await searchTalkMessages({
        talkId: talk.id,
        query: 'hello',
      });
      expect(hello.map((r) => r.id)).toEqual([m1.id]);
      const none = await searchTalkMessages({
        talkId: talk.id,
        query: 'nope',
      });
      expect(none.length).toBe(0);
    });
  });

  // ── Runs ───────────────────────────────────────────────────────────

  it('runs: create + status transitions + listing helpers', async () => {
    await withUserContext(USER_A_ID, async () => {
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Run Talk',
      });
      const threadId = await getOrCreateDefaultThread({
        talkId: talk.id,
        ownerId: USER_A_ID,
      });
      const trigger = await createTalkMessage({
        ownerId: USER_A_ID,
        talkId: talk.id,
        threadId,
        role: 'user',
        content: 'go',
      });

      const r1 = await createTalkRun({
        ownerId: USER_A_ID,
        talkId: talk.id,
        threadId,
        requestedBy: USER_A_ID,
        status: 'queued',
        triggerMessageId: trigger.id,
        idempotencyKey: 'key-1',
      });
      expect(r1.status).toBe('queued');
      expect(r1.owner_id).toBe(USER_A_ID);

      const fetched = await getTalkRunById(r1.id);
      expect(fetched?.id).toBe(r1.id);

      expect((await listQueuedTalkRuns()).map((r) => r.id)).toContain(r1.id);
      expect(await countRunningTalkRuns()).toBe(0);
      expect(await hasActiveTalkRuns({ talkId: talk.id, threadId })).toBe(true);

      // Transition queued → running
      const started = await markTalkRunStatus(r1.id, 'running', {
        startedAt: new Date().toISOString(),
      });
      expect(started?.status).toBe('running');
      expect(started?.started_at).toBeTruthy();
      expect(await getRunningTalkRun(talk.id)).not.toBeNull();
      expect(await countRunningTalkRuns()).toBe(1);
      expect((await listRunningTalkRuns()).map((r) => r.id)).toContain(r1.id);

      // Executor profile + metadata set/merge.
      await setTalkRunExecutorProfile({
        runId: r1.id,
        executorAlias: 'direct_http',
        executorModel: 'claude-opus-4-7',
      });
      await setTalkRunMetadata(r1.id, { stage: 'thinking' });
      const merged = await updateTalkRunMetadata(r1.id, {
        executionDecision: { authPath: 'api_key', backend: 'direct_http' },
      });
      expect(merged?.executor_alias).toBe('direct_http');
      expect(merged?.metadata_json).toMatchObject({
        stage: 'thinking',
        executionDecision: { authPath: 'api_key', backend: 'direct_http' },
      });
      // Derivation helpers walk metadata for fallbacks.
      expect(getTalkRunTaskType(merged!)).toBe('chat');
      expect(getTalkRunSelectedMode(merged!)).toBe('api');

      // Transition running → completed
      const ended = await markTalkRunStatus(r1.id, 'completed', {
        endedAt: new Date().toISOString(),
      });
      expect(ended?.status).toBe('completed');
      expect(ended?.ended_at).toBeTruthy();
      expect(await countRunningTalkRuns()).toBe(0);
      expect(await hasActiveTalkRuns({ talkId: talk.id, threadId })).toBe(
        false,
      );

      // listTalkRunsForTalk returns most-recent first.
      const runs = await listTalkRunsForTalk(talk.id);
      expect(runs.length).toBe(1);
      expect(runs[0].id).toBe(r1.id);
    });
  });

  it('runs: cancel + cancel_reason recorded', async () => {
    await withUserContext(USER_A_ID, async () => {
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Cancel',
      });
      const threadId = await getOrCreateDefaultThread({
        talkId: talk.id,
        ownerId: USER_A_ID,
      });
      const run = await createTalkRun({
        ownerId: USER_A_ID,
        talkId: talk.id,
        threadId,
        requestedBy: USER_A_ID,
        status: 'queued',
      });
      const cancelled = await markTalkRunStatus(run.id, 'cancelled', {
        endedAt: new Date().toISOString(),
        cancelReason: 'user_requested',
      });
      expect(cancelled?.status).toBe('cancelled');
      expect(cancelled?.cancel_reason).toBe('user_requested');
    });
  });

  // ── Event outbox ───────────────────────────────────────────────────

  it('outbox: append/list, min/max, prune by retention + per-topic window', async () => {
    await withUserContext(USER_A_ID, async () => {
      const id1 = await appendOutboxEvent({
        topic: 'test-acc-1',
        eventType: 'tick',
        payload: { n: 1 },
      });
      const id2 = await appendOutboxEvent({
        topic: 'test-acc-1',
        eventType: 'tick',
        payload: { n: 2 },
      });
      const id3 = await appendOutboxEvent({
        topic: 'test-acc-2',
        eventType: 'tock',
        payload: { n: 3 },
      });
      expect(id2).toBeGreaterThan(id1);

      const events = await getOutboxEventsForTopics(
        ['test-acc-1', 'test-acc-2'],
        0,
      );
      const myIds = events
        .filter((e) => e.topic.startsWith('test-acc-'))
        .map((e) => e.event_id);
      expect(myIds).toEqual([id1, id2, id3]);
      expect(events[0].payload).toEqual({ n: 1 });

      const filtered = await getOutboxEventsForTopics(['test-acc-1'], id1);
      expect(filtered.map((e) => e.event_id)).toEqual([id2]);

      const min = await getOutboxMinEventIdForTopics(['test-acc-1']);
      const max = await getOutboxMaxEventIdForTopics(['test-acc-1']);
      expect(min).toBe(id1);
      expect(max).toBe(id2);
    });

    // pruneEventOutbox: retention=0 hours, keepRecent=1 → keeps only the
    // newest per topic, deletes the rest. State: test-acc-1 has 2 events,
    // test-acc-2 has 1 — exactly one deletion expected (id1 in
    // test-acc-1; test-acc-2's lone event is its own newest, kept).
    await withUserContext(USER_A_ID, async () => {
      const deleted = await pruneEventOutbox({
        nowMs: Date.now() + 86_400_000, // way in the future, everything is "stale"
        retentionHours: 0,
        keepRecentPerTopic: 1,
      });
      expect(deleted).toBe(1);
      const remaining = await getOutboxEventsForTopics(
        ['test-acc-1', 'test-acc-2'],
        0,
      );
      const accCount = remaining.filter((e) =>
        e.topic.startsWith('test-acc-'),
      ).length;
      expect(accCount).toBe(2); // one per topic
    });
  });

  // ── Idempotency cache ──────────────────────────────────────────────

  it('idempotency_cache: save / get with expiry / prune', async () => {
    await withUserContext(USER_A_ID, async () => {
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      await saveIdempotencyCache({
        userId: USER_A_ID,
        idempotencyKey: 'k1',
        method: 'POST',
        path: '/api/v1/talks',
        requestHash: 'hash-1',
        statusCode: 201,
        responseBody: '{"ok":true}',
        expiresAt,
      });
      const got = await getIdempotencyCache({
        idempotencyKey: 'k1',
        method: 'post',
        path: '/api/v1/talks',
      });
      expect(got?.status_code).toBe(201);
      expect(got?.method).toBe('POST'); // normalized to upper

      // Overwrite via re-save updates response.
      await saveIdempotencyCache({
        userId: USER_A_ID,
        idempotencyKey: 'k1',
        method: 'POST',
        path: '/api/v1/talks',
        requestHash: 'hash-1',
        statusCode: 200,
        responseBody: '{"updated":true}',
        expiresAt,
      });
      const got2 = await getIdempotencyCache({
        idempotencyKey: 'k1',
        method: 'POST',
        path: '/api/v1/talks',
      });
      expect(got2?.status_code).toBe(200);

      // Save an expired row, then prune.
      await saveIdempotencyCache({
        userId: USER_A_ID,
        idempotencyKey: 'k2',
        method: 'POST',
        path: '/api/v1/talks',
        requestHash: 'hash-2',
        statusCode: 200,
        responseBody: '{}',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      // Expired rows are filtered from get().
      expect(
        await getIdempotencyCache({
          idempotencyKey: 'k2',
          method: 'POST',
          path: '/api/v1/talks',
        }),
      ).toBeUndefined();
      const pruned = await pruneIdempotencyCache();
      expect(pruned).toBeGreaterThanOrEqual(1);
    });
  });

  it('idempotency_cache: cross-user RLS isolates rows', async () => {
    await withUserContext(USER_A_ID, async () => {
      await saveIdempotencyCache({
        userId: USER_A_ID,
        idempotencyKey: 'shared-key',
        method: 'POST',
        path: '/api/v1/talks',
        requestHash: 'A',
        statusCode: 201,
        responseBody: 'A response',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    await withUserContext(USER_B_ID, async () => {
      // Same key but different user — RLS hides A's row even though the
      // idempotency_key matches.
      expect(
        await getIdempotencyCache({
          idempotencyKey: 'shared-key',
          method: 'POST',
          path: '/api/v1/talks',
        }),
      ).toBeUndefined();
    });
  });

  // ── Atomic helpers (append assistant/runtime + outbox in one tx) ──

  it('appendAssistantMessageWithOutbox: writes message + outbox event atomically', async () => {
    await withUserContext(USER_A_ID, async () => {
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Atomic',
      });
      const threadId = await getOrCreateDefaultThread({
        talkId: talk.id,
        ownerId: USER_A_ID,
      });
      const trigger = await createTalkMessage({
        ownerId: USER_A_ID,
        talkId: talk.id,
        threadId,
        role: 'user',
        content: 'go',
      });
      const run = await createTalkRun({
        ownerId: USER_A_ID,
        talkId: talk.id,
        threadId,
        requestedBy: USER_A_ID,
        status: 'running',
        triggerMessageId: trigger.id,
      });
      const beforeMax = await getOutboxMaxEventIdForTopics([`talk:${talk.id}`]);

      const msg = await appendAssistantMessageWithOutbox({
        ownerId: USER_A_ID,
        talkId: talk.id,
        threadId,
        runId: run.id,
        content: 'thinking...',
        agentNickname: 'Argus',
        sequenceInRun: 0,
      });
      expect(msg.role).toBe('assistant');
      expect(msg.metadata_json).toMatchObject({ agentNickname: 'Argus' });

      const afterMax = await getOutboxMaxEventIdForTopics([`talk:${talk.id}`]);
      expect(afterMax).toBeGreaterThan(beforeMax ?? 0);

      const events = await getOutboxEventsForTopics(
        [`talk:${talk.id}`],
        beforeMax ?? 0,
      );
      const lastEvent = events[events.length - 1];
      expect(lastEvent.event_type).toBe('message_appended');
      expect(lastEvent.payload).toMatchObject({
        messageId: msg.id,
        role: 'assistant',
        agentNickname: 'Argus',
      });
    });
  });

  it('appendRuntimeTalkMessage: pulls actor info from metadata for the outbox event', async () => {
    await withUserContext(USER_A_ID, async () => {
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Runtime',
      });
      const threadId = await getOrCreateDefaultThread({
        talkId: talk.id,
        ownerId: USER_A_ID,
      });
      const trigger = await createTalkMessage({
        ownerId: USER_A_ID,
        talkId: talk.id,
        threadId,
        role: 'user',
        content: 'go',
      });
      const run = await createTalkRun({
        ownerId: USER_A_ID,
        talkId: talk.id,
        threadId,
        requestedBy: USER_A_ID,
        status: 'running',
        triggerMessageId: trigger.id,
      });
      const before = await getOutboxMaxEventIdForTopics([`talk:${talk.id}`]);
      await appendRuntimeTalkMessage({
        ownerId: USER_A_ID,
        talkId: talk.id,
        threadId,
        runId: run.id,
        role: 'tool',
        content: '{"tool":"web_fetch","result":"ok"}',
        metadata: { agentId: 'agent-1', agentNickname: 'Argus' },
        sequenceInRun: 1,
      });
      const events = await getOutboxEventsForTopics(
        [`talk:${talk.id}`],
        before ?? 0,
      );
      const lastEvent = events[events.length - 1];
      expect(lastEvent.event_type).toBe('message_appended');
      expect(lastEvent.payload).toMatchObject({
        role: 'tool',
        agentId: 'agent-1',
        agentNickname: 'Argus',
      });
    });
  });

  // ── enqueueTalkTurnAtomic ──────────────────────────────────────────

  it('enqueueTalkTurnAtomic: fans out N queued runs + outbox events; rejects concurrent rounds', async () => {
    const AGENT_1 = '0c555555-9999-9999-9999-000000000001';
    const AGENT_2 = '0c555555-9999-9999-9999-000000000002';

    const { talkId, threadId } = await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Turn',
      });
      const tid = await getOrCreateDefaultThread({
        talkId: t.id,
        ownerId: USER_A_ID,
      });
      return { talkId: t.id, threadId: tid };
    });

    const result = await withUserContext(USER_A_ID, async () => {
      return await enqueueTalkTurnAtomic({
        ownerId: USER_A_ID,
        talkId,
        threadId,
        userId: USER_A_ID,
        content: 'What should I read about ricin?',
        targetAgentIds: [AGENT_1, AGENT_2],
      });
    });
    expect(result.threadId).toBe(threadId);
    expect(result.message.role).toBe('user');
    expect(result.message.content).toMatch(/ricin/);
    expect(result.runs).toHaveLength(2);
    expect(result.runs.every((r) => r.status === 'queued')).toBe(true);
    expect(result.runs[0].response_group_id).toBe(
      result.runs[1].response_group_id,
    );
    expect(result.runs[0].target_agent_id).toBe(AGENT_1);
    expect(result.runs[1].target_agent_id).toBe(AGENT_2);

    // Title inferred from the message — the default thread starts with
    // title=null, heal-on-write should set it from the question.
    await withUserContext(USER_A_ID, async () => {
      const threads = await listTalkThreads({
        talkId,
        ownerId: USER_A_ID,
      });
      const def = threads.find((t) => t.id === threadId);
      expect(def?.title).toBeTruthy();
    });

    // Outbox events: 1 message_appended + 2 talk_run_queued.
    await withUserContext(USER_A_ID, async () => {
      const events = await getOutboxEventsForTopics([`talk:${talkId}`], 0);
      const byType = events.reduce<Record<string, number>>(
        (acc, e) => ({ ...acc, [e.event_type]: (acc[e.event_type] ?? 0) + 1 }),
        {},
      );
      expect(byType['message_appended']).toBeGreaterThanOrEqual(1);
      expect(byType['talk_run_queued']).toBe(2);
    });

    // Concurrent round rejected.
    await expect(
      withUserContext(USER_A_ID, async () => {
        await enqueueTalkTurnAtomic({
          ownerId: USER_A_ID,
          talkId,
          threadId,
          userId: USER_A_ID,
          content: 'second round before first finishes',
          targetAgentIds: [AGENT_1],
        });
      }),
    ).rejects.toBeInstanceOf(TalkActiveRoundError);
  });

  // ── Run lifecycle atomics ──────────────────────────────────────────

  it('claimQueuedTalkRuns → completeRunAndPromoteNextAtomic: queued→running→completed lifecycle', async () => {
    const AGENT_1 = '0c555555-aaaa-9999-9999-000000000001';

    const { talkId, threadId } = await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Lifecycle',
      });
      const tid = await getOrCreateDefaultThread({
        talkId: t.id,
        ownerId: USER_A_ID,
      });
      return { talkId: t.id, threadId: tid };
    });

    const turn = await withUserContext(USER_A_ID, async () => {
      return await enqueueTalkTurnAtomic({
        ownerId: USER_A_ID,
        talkId,
        threadId,
        userId: USER_A_ID,
        content: 'Tell me about pgvector',
        targetAgentIds: [AGENT_1],
      });
    });
    const runId = turn.runs[0].id;

    // claim
    const claimed = await withUserContext(USER_A_ID, async () => {
      return await claimQueuedTalkRuns(10);
    });
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(runId);
    expect(claimed[0].status).toBe('running');
    expect(claimed[0].started_at).toBeTruthy();

    // complete with response. agentId + providerId null here — AGENT_1
    // isn't a real registered_agents row and 'provider.anthropic' isn't
    // a real llm_providers row in this test (FK would reject); see
    // agent-accessors-pg.test.ts for FK-correct fixtures.
    const completed = await withUserContext(USER_A_ID, async () => {
      return await completeRunAndPromoteNextAtomic({
        ownerId: USER_A_ID,
        runId,
        responseContent: 'pgvector adds vector similarity to Postgres.',
        agentId: null,
        agentNickname: 'Argus',
        providerId: null,
        modelId: 'claude-opus-4-7',
        latencyMs: 1234,
        usage: { inputTokens: 50, outputTokens: 80 },
      });
    });
    expect(completed.applied).toBe(true);
    expect(completed.talkId).toBe(talkId);

    await withUserContext(USER_A_ID, async () => {
      const final = await getTalkRunById(runId);
      expect(final?.status).toBe('completed');
      expect(final?.ended_at).toBeTruthy();
      const messages = await listTalkMessages({ talkId });
      const assistant = messages.find((m) => m.role === 'assistant');
      expect(assistant?.run_id).toBe(runId);
      expect(assistant?.content).toMatch(/pgvector/);
      // llm_attempts row recorded.
      const db = getDbPg();
      const attempts = await db<{ status: string; model_id: string }[]>`
        select status, model_id from public.llm_attempts where run_id = ${runId}::uuid
      `;
      expect(attempts).toHaveLength(1);
      expect(attempts[0].status).toBe('success');
      // talk_run_completed event present.
      const events = await getOutboxEventsForTopics([`talk:${talkId}`], 0);
      expect(events.some((e) => e.event_type === 'talk_run_completed')).toBe(
        true,
      );
    });
  });

  it('failRunAndPromoteNextAtomic: queued→running→failed with reason recorded', async () => {
    const AGENT_1 = '0c555555-aaaa-9999-9999-000000000002';
    const { talkId, threadId } = await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({ ownerId: USER_A_ID, topicTitle: 'Fail' });
      return {
        talkId: t.id,
        threadId: await getOrCreateDefaultThread({
          talkId: t.id,
          ownerId: USER_A_ID,
        }),
      };
    });
    const runId = await withUserContext(USER_A_ID, async () => {
      const turn = await enqueueTalkTurnAtomic({
        ownerId: USER_A_ID,
        talkId,
        threadId,
        userId: USER_A_ID,
        content: 'fail me',
        targetAgentIds: [AGENT_1],
      });
      await claimQueuedTalkRuns(10);
      return turn.runs[0].id;
    });
    const failed = await withUserContext(USER_A_ID, async () => {
      return await failRunAndPromoteNextAtomic({
        runId,
        errorCode: 'provider_timeout',
        errorMessage: 'Anthropic API timed out after 60s',
      });
    });
    expect(failed.applied).toBe(true);

    await withUserContext(USER_A_ID, async () => {
      const final = await getTalkRunById(runId);
      expect(final?.status).toBe('failed');
      expect(final?.cancel_reason).toMatch(/provider_timeout/);
    });
  });

  it('cancelTalkRunsAtomic: cancels all queued + running on the thread', async () => {
    const AGENT_1 = '0c555555-aaaa-9999-9999-000000000003';
    const AGENT_2 = '0c555555-aaaa-9999-9999-000000000004';
    const { talkId, threadId, runIds } = await withUserContext(
      USER_A_ID,
      async () => {
        const t = await createTalk({
          ownerId: USER_A_ID,
          topicTitle: 'Cancel',
        });
        const tid = await getOrCreateDefaultThread({
          talkId: t.id,
          ownerId: USER_A_ID,
        });
        const turn = await enqueueTalkTurnAtomic({
          ownerId: USER_A_ID,
          talkId: t.id,
          threadId: tid,
          userId: USER_A_ID,
          content: 'cancel-target',
          targetAgentIds: [AGENT_1, AGENT_2],
        });
        return {
          talkId: t.id,
          threadId: tid,
          runIds: turn.runs.map((r) => r.id),
        };
      },
    );

    // Claim one (so it's 'running'), leave the other 'queued'. Both
    // should cancel.
    await withUserContext(USER_A_ID, async () => {
      await claimQueuedTalkRuns(1);
    });
    const result = await withUserContext(USER_A_ID, async () => {
      return await cancelTalkRunsAtomic({
        talkId,
        threadId,
        cancelledBy: USER_A_ID,
        ownerId: USER_A_ID,
      });
    });
    expect(result.cancelledRuns).toBe(2);
    expect(result.cancelledRunning).toBe(true);
    expect(result.cancelledRunIds.sort()).toEqual([...runIds].sort());

    await withUserContext(USER_A_ID, async () => {
      const final = await listTalkRunsForTalk(talkId);
      expect(final.every((r) => r.status === 'cancelled')).toBe(true);
    });
  });

  // ── Sidebar tree + reorder ─────────────────────────────────────────

  it('listTalkSidebarTreeForUser: groups talks under folders + emits per-talk metrics', async () => {
    const AGENT_1 = '0c555555-aaaa-9999-9999-000000000301';
    await withUserContext(USER_A_ID, async () => {
      const folder = await createTalkFolder({
        ownerId: USER_A_ID,
        title: 'Pinned',
      });
      const talkInFolder = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'In Folder',
      });
      const rootTalk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Root',
      });
      // Park the folder-resident talk inside the folder.
      const db = getDbPg();
      await db`
        update public.talks set folder_id = ${folder.id}::uuid
        where id = ${talkInFolder.id}::uuid
      `;
      // Seed metrics: 2 messages on rootTalk, an enqueued (queued) run.
      const rootTid = await getOrCreateDefaultThread({
        talkId: rootTalk.id,
        ownerId: USER_A_ID,
      });
      await createTalkMessage({
        ownerId: USER_A_ID,
        talkId: rootTalk.id,
        threadId: rootTid,
        role: 'user',
        content: 'one',
      });
      await createTalkMessage({
        ownerId: USER_A_ID,
        talkId: rootTalk.id,
        threadId: rootTid,
        role: 'assistant',
        content: 'two',
      });
      await enqueueTalkTurnAtomic({
        ownerId: USER_A_ID,
        talkId: rootTalk.id,
        threadId: rootTid,
        userId: USER_A_ID,
        content: 'live?',
        targetAgentIds: [AGENT_1],
      });

      const tree = await listTalkSidebarTreeForUser();
      expect(tree.folders).toHaveLength(1);
      expect(tree.folders[0].id).toBe(folder.id);
      // Root list excludes folder-resident talks.
      expect(tree.rootTalks.map((t) => t.id)).toContain(rootTalk.id);
      expect(tree.rootTalks.map((t) => t.id)).not.toContain(talkInFolder.id);
      // Folder map includes the folder-resident talk.
      expect(tree.talksByFolderId[folder.id].map((t) => t.id)).toContain(
        talkInFolder.id,
      );

      const rootTalkEntry = tree.rootTalks.find((t) => t.id === rootTalk.id)!;
      // enqueueTalkTurnAtomic adds a 3rd user message → message_count = 3.
      expect(rootTalkEntry.message_count).toBe(3);
      expect(rootTalkEntry.has_active_run).toBe(true);
      expect(rootTalkEntry.last_message_at).toBeTruthy();
    });
  });

  it('reorderTalkSidebarItem: moves a root talk into a folder + compacts', async () => {
    await withUserContext(USER_A_ID, async () => {
      const folder = await createTalkFolder({
        ownerId: USER_A_ID,
        title: 'Bucket',
      });
      const tA = await createTalk({ ownerId: USER_A_ID, topicTitle: 'A' });
      const tB = await createTalk({ ownerId: USER_A_ID, topicTitle: 'B' });
      const tC = await createTalk({ ownerId: USER_A_ID, topicTitle: 'C' });

      // Move tB into the folder at position 0.
      const ok = await reorderTalkSidebarItem({
        itemType: 'talk',
        itemId: tB.id,
        destinationFolderId: folder.id,
        destinationIndex: 0,
      });
      expect(ok).toBe(true);

      const tree = await listTalkSidebarTreeForUser();
      // tB is now in the folder.
      expect(tree.talksByFolderId[folder.id].map((t) => t.id)).toEqual([tB.id]);
      // Root list has only tA and tC (and the folder).
      const rootTalkIds = tree.rootTalks.map((t) => t.id);
      expect(rootTalkIds).toContain(tA.id);
      expect(rootTalkIds).toContain(tC.id);
      expect(rootTalkIds).not.toContain(tB.id);
    });
  });

  it('reorderTalkSidebarItem: rejects folder→folder destination', async () => {
    await withUserContext(USER_A_ID, async () => {
      const f1 = await createTalkFolder({ ownerId: USER_A_ID, title: 'F1' });
      const f2 = await createTalkFolder({ ownerId: USER_A_ID, title: 'F2' });
      const ok = await reorderTalkSidebarItem({
        itemType: 'folder',
        itemId: f1.id,
        destinationFolderId: f2.id,
        destinationIndex: 0,
      });
      expect(ok).toBe(false);
    });
  });

  it('patchTalkMetadata folderId: moves between folders + updates sort_order', async () => {
    await withUserContext(USER_A_ID, async () => {
      const folder = await createTalkFolder({
        ownerId: USER_A_ID,
        title: 'Box',
      });
      const t = await createTalk({ ownerId: USER_A_ID, topicTitle: 'Solo' });

      const moved = await patchTalkMetadata({
        ownerId: USER_A_ID,
        talkId: t.id,
        folderId: folder.id,
      });
      expect(moved?.folder_id).toBe(folder.id);
      expect(moved?.version).toBeGreaterThan(t.version);

      // Move back to top-level.
      const movedBack = await patchTalkMetadata({
        ownerId: USER_A_ID,
        talkId: t.id,
        folderId: null,
      });
      expect(movedBack?.folder_id).toBeNull();
    });
  });

  // ── deleteTalkMessagesAtomic ───────────────────────────────────────

  it('deleteTalkMessagesAtomic: deletes batch, NULLs trigger refs, emits outbox', async () => {
    const { talkId, threadId, msgIdA, msgIdB } = await withUserContext(
      USER_A_ID,
      async () => {
        const t = await createTalk({
          ownerId: USER_A_ID,
          topicTitle: 'EditHistory',
        });
        const tid = await getOrCreateDefaultThread({
          talkId: t.id,
          ownerId: USER_A_ID,
        });
        const a = await createTalkMessage({
          ownerId: USER_A_ID,
          talkId: t.id,
          threadId: tid,
          role: 'user',
          content: 'one',
        });
        const b = await createTalkMessage({
          ownerId: USER_A_ID,
          talkId: t.id,
          threadId: tid,
          role: 'assistant',
          content: 'two',
        });
        // Park a (completed) run whose trigger points at message A so we
        // can verify the trigger reference is NULLed on delete.
        await createTalkRun({
          ownerId: USER_A_ID,
          talkId: t.id,
          threadId: tid,
          requestedBy: USER_A_ID,
          status: 'completed',
          triggerMessageId: a.id,
        });
        return { talkId: t.id, threadId: tid, msgIdA: a.id, msgIdB: b.id };
      },
    );

    const result = await withUserContext(USER_A_ID, async () => {
      return await deleteTalkMessagesAtomic({
        talkId,
        threadId,
        messageIds: [msgIdA, msgIdB],
      });
    });
    expect(result.deletedCount).toBe(2);
    expect(result.deletedMessageIds.sort()).toEqual([msgIdA, msgIdB].sort());

    await withUserContext(USER_A_ID, async () => {
      // Messages gone.
      expect(await getTalkMessageById(msgIdA)).toBeUndefined();
      expect(await getTalkMessageById(msgIdB)).toBeUndefined();
      // Trigger reference cleared on parked run.
      const runs = await listTalkRunsForTalk(talkId);
      expect(runs.length).toBe(1);
      expect(runs[0].trigger_message_id).toBeNull();
      // talk_history_edited event emitted on the talk topic.
      const events = await getOutboxEventsForTopics([`talk:${talkId}`], 0);
      const edited = events.find((e) => e.event_type === 'talk_history_edited');
      expect(edited?.payload).toMatchObject({
        talkId,
        deletedCount: 2,
        threadIds: [threadId],
      });
    });
  });

  it('deleteTalkMessagesAtomic: refuses system messages', async () => {
    const { talkId, threadId, sysId } = await withUserContext(
      USER_A_ID,
      async () => {
        const t = await createTalk({ ownerId: USER_A_ID, topicTitle: 'Sys' });
        const tid = await getOrCreateDefaultThread({
          talkId: t.id,
          ownerId: USER_A_ID,
        });
        const sys = await createTalkMessage({
          ownerId: USER_A_ID,
          talkId: t.id,
          threadId: tid,
          role: 'system',
          content: 'system prompt',
        });
        return { talkId: t.id, threadId: tid, sysId: sys.id };
      },
    );

    await expect(
      withUserContext(USER_A_ID, async () => {
        await deleteTalkMessagesAtomic({
          talkId,
          threadId,
          messageIds: [sysId],
        });
      }),
    ).rejects.toThrow(/system messages cannot be deleted/);
  });

  it('deleteTalkMessagesAtomic: refuses while an active run exists on the thread', async () => {
    const AGENT_1 = '0c555555-aaaa-9999-9999-000000000099';
    const { talkId, threadId, msgId } = await withUserContext(
      USER_A_ID,
      async () => {
        const t = await createTalk({ ownerId: USER_A_ID, topicTitle: 'Busy' });
        const tid = await getOrCreateDefaultThread({
          talkId: t.id,
          ownerId: USER_A_ID,
        });
        const m = await createTalkMessage({
          ownerId: USER_A_ID,
          talkId: t.id,
          threadId: tid,
          role: 'user',
          content: 'in flight',
        });
        // enqueue + claim leaves status='running'.
        await enqueueTalkTurnAtomic({
          ownerId: USER_A_ID,
          talkId: t.id,
          threadId: tid,
          userId: USER_A_ID,
          content: 'go',
          targetAgentIds: [AGENT_1],
        });
        await claimQueuedTalkRuns(10);
        return { talkId: t.id, threadId: tid, msgId: m.id };
      },
    );

    await expect(
      withUserContext(USER_A_ID, async () => {
        await deleteTalkMessagesAtomic({
          talkId,
          threadId,
          messageIds: [msgId],
        });
      }),
    ).rejects.toBeInstanceOf(TalkActiveRoundError);
  });

  // ── failInterruptedRunsOnStartup ───────────────────────────────────

  it('failInterruptedRunsOnStartup: marks running runs failed and emits events', async () => {
    const AGENT_1 = '0c555555-aaaa-9999-9999-000000000201';
    const AGENT_2 = '0c555555-aaaa-9999-9999-000000000202';
    const { talkId, runIds } = await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'BootCleanup',
      });
      const tid = await getOrCreateDefaultThread({
        talkId: t.id,
        ownerId: USER_A_ID,
      });
      const turn = await enqueueTalkTurnAtomic({
        ownerId: USER_A_ID,
        talkId: t.id,
        threadId: tid,
        userId: USER_A_ID,
        content: 'startup',
        targetAgentIds: [AGENT_1, AGENT_2],
      });
      // Claim both so they're status='running' — simulates the state
      // that gets left behind when the worker process restarts.
      await claimQueuedTalkRuns(10);
      return { talkId: t.id, runIds: turn.runs.map((r) => r.id) };
    });

    // Runs as the postgres role outside withUserContext (boot cleanup).
    const result = await failInterruptedRunsOnStartup();
    expect(result.failedRunIds.sort()).toEqual([...runIds].sort());
    expect(result.promotedRunIds).toEqual([]);

    await withUserContext(USER_A_ID, async () => {
      const final = await listTalkRunsForTalk(talkId);
      expect(final.every((r) => r.status === 'failed')).toBe(true);
      expect(
        final.every((r) => r.cancel_reason === 'interrupted_by_restart'),
      ).toBe(true);
      const events = await getOutboxEventsForTopics([`talk:${talkId}`], 0);
      const failures = events.filter((e) => e.event_type === 'talk_run_failed');
      expect(failures.length).toBe(2);
      expect(failures[0].payload).toMatchObject({
        errorCode: 'interrupted_by_restart',
        talkId,
      });
    });
  });

  // ── RLS gates ──────────────────────────────────────────────────────

  it('RLS gate: cross-user reads and writes blocked', async () => {
    const talkId = await withUserContext(USER_A_ID, async () => {
      const t = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'A only',
      });
      return t.id;
    });

    await withUserContext(USER_B_ID, async () => {
      // Reads of A's talk return undefined under RLS.
      expect(await getTalkById(talkId)).toBeUndefined();
      // Updates affect zero rows.
      const patched = await patchTalkMetadata({
        ownerId: USER_B_ID,
        talkId,
        title: 'hijack',
      });
      expect(patched).toBeUndefined();
      // Delete returns false (USING filter).
      expect(await deleteTalkForOwner({ talkId })).toBe(false);
    });

    // INSERTs with ownerId=A while in B's context are rejected by WITH CHECK.
    await expect(
      withUserContext(USER_B_ID, async () => {
        await createTalk({ ownerId: USER_A_ID, topicTitle: 'hijack' });
      }),
    ).rejects.toThrow();
  });
});
