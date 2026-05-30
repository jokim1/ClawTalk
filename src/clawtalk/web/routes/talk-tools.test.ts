// Route tests for /api/v1/talks/:talkId/tools (T5).
//
// Drives the exported `getTalkToolsRoute` / `updateTalkToolRoute`
// handlers directly. Full middleware coverage (auth, CSRF, rate-limit)
// is exercised in the Worker-app integration tests; this file focuses
// on:
//   - Happy path GET (active + available roundtrip)
//   - Happy path PATCH (state flip + outbox `talk_tools_changed` event)
//   - 400 on unknown family slug
//   - 404 when the Talk is not owned by the caller (RLS hides it)
//   - 404 when the Talk does not exist at all
//   - After PATCH, a subsequent createTalkRun snapshot reflects the
//     post-toggle active set (codex #10 sanity)

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../../db.js';
import { TALK_TOOL_FAMILIES } from '../../db/agent-accessors.js';
import { createTalkRun } from '../../db/accessors.js';
import { getTalkActiveTools } from '../../db/talk-tools-accessors.js';
import type { AuthContext } from '../types.js';

import { getTalkToolsRoute, updateTalkToolRoute } from './talk-tools.js';

const USER_A_ID = '0c777701-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = '0c777701-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TALK_A_ID = '0c777701-cccc-cccc-cccc-ccccccccc0a1';

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

async function seedTalk(
  talkId: string,
  ownerId: string,
  active: Record<string, boolean>,
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talks
      (id, owner_id, topic_title, active_tool_families_json)
    values
      (${talkId}::uuid, ${ownerId}::uuid, 'Tools Route Test',
       ${db.json(active as never)})
    on conflict (id) do update set
      active_tool_families_json = excluded.active_tool_families_json
  `;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.talks where id = ${TALK_A_ID}::uuid`;
  await db`delete from public.registered_agents where owner_id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)`;
}

describe('talk-tools route', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser(USER_A_ID, 'tools-route-a@clawtalk.local', 'Route A');
    await seedAuthUser(USER_B_ID, 'tools-route-b@clawtalk.local', 'Route B');
  });

  afterAll(async () => {
    const db = getDbPg();
    await purge();
    await db`
      delete from auth.users
      where id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
    `;
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purge();
  });

  it('GET returns active + the static light tool vocabulary for the caller-owned Talk', async () => {
    await seedTalk(TALK_A_ID, USER_A_ID, { web: true });

    const result = await getTalkToolsRoute({
      auth: AUTH_A,
      talkId: TALK_A_ID,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (!result.body.ok) return;
    expect(result.body.data.active).toEqual({ web: true });
    // `available` is the static light vocabulary now — no agent union, no heavy.
    expect(result.body.data.available).toEqual(TALK_TOOL_FAMILIES);
  });

  it('PATCH flips a single family + emits talk_tools_changed outbox event', async () => {
    await seedTalk(TALK_A_ID, USER_A_ID, { web: true });

    const db = getDbPg();
    const beforeRows = await db<{ count: number }[]>`
      select count(*)::int as count from public.event_outbox
      where event_type = 'talk_tools_changed'
    `;
    const beforeCount = beforeRows[0]?.count ?? 0;

    const result = await updateTalkToolRoute({
      auth: AUTH_A,
      talkId: TALK_A_ID,
      body: { family: 'web', enabled: false },
    });
    expect(result.statusCode).toBe(200);
    if (!result.body.ok) throw new Error('expected ok envelope');
    expect(result.body.data.active).toEqual({ web: false });

    // State actually persisted (sanity).
    const persisted = await withUserContext(USER_A_ID, async () => {
      return await getTalkActiveTools(TALK_A_ID);
    });
    expect(persisted).toEqual({ web: false });

    // Outbox event was emitted with the matching payload.
    const afterRows = await db<
      {
        count: number;
      }[]
    >`
      select count(*)::int as count from public.event_outbox
      where event_type = 'talk_tools_changed'
    `;
    expect((afterRows[0]?.count ?? 0) - beforeCount).toBe(1);
    const latest = await db<
      {
        payload: { talkId: string; active: Record<string, boolean> };
      }[]
    >`
      select payload from public.event_outbox
      where event_type = 'talk_tools_changed'
      order by event_id desc
      limit 1
    `;
    expect(latest[0]?.payload.talkId).toBe(TALK_A_ID);
    expect(latest[0]?.payload.active).toEqual({ web: false });
  });

  it('PATCH 400 on unknown family slug', async () => {
    await seedTalk(TALK_A_ID, USER_A_ID, {});
    const result = await updateTalkToolRoute({
      auth: AUTH_A,
      talkId: TALK_A_ID,
      body: { family: 'totally-not-a-family', enabled: true },
    });
    expect(result.statusCode).toBe(400);
    expect(result.body.ok).toBe(false);
    if (result.body.ok) return;
    expect(result.body.error.code).toBe('invalid_tool_toggle');
  });

  it('PATCH 400 on a heavy family slug (shell is not on the Talk bar)', async () => {
    await seedTalk(TALK_A_ID, USER_A_ID, {});
    const result = await updateTalkToolRoute({
      auth: AUTH_A,
      talkId: TALK_A_ID,
      body: { family: 'shell', enabled: true },
    });
    expect(result.statusCode).toBe(400);
    expect(result.body.ok).toBe(false);
    if (result.body.ok) return;
    expect(result.body.error.code).toBe('invalid_tool_toggle');
  });

  it('PATCH 400 on missing/invalid body shape', async () => {
    await seedTalk(TALK_A_ID, USER_A_ID, {});
    const noFamily = await updateTalkToolRoute({
      auth: AUTH_A,
      talkId: TALK_A_ID,
      body: { enabled: true } as unknown,
    });
    expect(noFamily.statusCode).toBe(400);

    const noEnabled = await updateTalkToolRoute({
      auth: AUTH_A,
      talkId: TALK_A_ID,
      body: { family: 'web' } as unknown,
    });
    expect(noEnabled.statusCode).toBe(400);
  });

  it('GET 404 when caller does not own the Talk (RLS hides it)', async () => {
    await seedTalk(TALK_A_ID, USER_A_ID, { web: true });
    const result = await getTalkToolsRoute({
      auth: AUTH_B,
      talkId: TALK_A_ID,
    });
    expect(result.statusCode).toBe(404);
  });

  it('PATCH 404 when caller does not own the Talk', async () => {
    await seedTalk(TALK_A_ID, USER_A_ID, { web: true });
    const result = await updateTalkToolRoute({
      auth: AUTH_B,
      talkId: TALK_A_ID,
      body: { family: 'web', enabled: false },
    });
    expect(result.statusCode).toBe(404);
  });

  it('GET 404 when the Talk does not exist at all', async () => {
    const result = await getTalkToolsRoute({
      auth: AUTH_A,
      talkId: '0c777701-eeee-eeee-eeee-eeeeeeeeeeee',
    });
    expect(result.statusCode).toBe(404);
  });

  it('after PATCH, a subsequently-created talk_run snapshots the post-toggle active set (codex #10 sanity)', async () => {
    await seedTalk(TALK_A_ID, USER_A_ID, { web: true });
    // Flip web off.
    await updateTalkToolRoute({
      auth: AUTH_A,
      talkId: TALK_A_ID,
      body: { family: 'web', enabled: false },
    });

    // Set up a thread row so the run insert satisfies its FK.
    const db = getDbPg();
    const threadId = '0c777701-dddd-dddd-dddd-dddddddddddd';
    await db`
      insert into public.talk_threads (id, talk_id, owner_id)
      values (${threadId}::uuid, ${TALK_A_ID}::uuid, ${USER_A_ID}::uuid)
      on conflict (id) do nothing
    `;

    // Read the post-toggle active set the same way enqueueTalkTurnAtomic
    // does, then pass it into createTalkRun.
    const rows = await db<
      {
        active_tool_families_json: Record<string, boolean>;
      }[]
    >`
      select active_tool_families_json
      from public.talks where id = ${TALK_A_ID}::uuid
    `;
    const snapshot = rows[0]?.active_tool_families_json ?? {};

    const run = await withUserContext(USER_A_ID, async () => {
      return await createTalkRun({
        ownerId: USER_A_ID,
        talkId: TALK_A_ID,
        threadId,
        requestedBy: USER_A_ID,
        status: 'queued',
        activeToolFamiliesSnapshot: snapshot,
      });
    });
    expect(run.active_tool_families_snapshot).toEqual({ web: false });
  });
});
