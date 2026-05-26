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
import { createTalkRun } from '../../db/accessors.js';
import { getTalkActiveTools } from '../../db/talk-tools-accessors.js';
import type { AuthContext } from '../types.js';

import { getTalkToolsRoute, updateTalkToolRoute } from './talk-tools.js';
import { updateTalkAgentsRoute } from './talks.js';

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

async function seedAgent(
  agentId: string,
  ownerId: string,
  toolPermissions: Record<string, boolean>,
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.registered_agents
      (id, owner_id, name, provider_id, model_id, tool_permissions_json)
    values
      (${agentId}::uuid, ${ownerId}::uuid, 'route-test-agent',
       'provider.anthropic', 'claude-opus-4-7',
       ${db.json(toolPermissions as never)})
    on conflict (id) do nothing
  `;
  await db`
    insert into public.talk_agents (talk_id, owner_id, registered_agent_id)
    values (${TALK_A_ID}::uuid, ${ownerId}::uuid, ${agentId}::uuid)
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

  it('GET returns active + available for the caller-owned Talk', async () => {
    await seedTalk(TALK_A_ID, USER_A_ID, { web: true });
    await withUserContext(USER_A_ID, async () => {
      await seedAgent('0c777701-1111-1111-1111-111111111111', USER_A_ID, {
        web: true,
        google_read: true,
        filesystem: false,
      });
    });

    const result = await getTalkToolsRoute({
      auth: AUTH_A,
      talkId: TALK_A_ID,
    });
    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (!result.body.ok) return;
    expect(result.body.data.active).toEqual({ web: true });
    expect(result.body.data.available).toEqual(['google_read', 'web']);
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

  describe('Talk-agents diff (T6: OR-in newly added)', () => {
    const EDITOR_AGENT_ID = '0c777701-1111-1111-1111-eeeeeeeeeeee';
    const RESEARCHER_AGENT_ID = '0c777701-1111-1111-1111-rrrrrrrrrrrr'.replace(
      /[r]/g,
      '2',
    );

    async function buildAgentInput(input: {
      id: string;
      isLead: boolean;
    }): Promise<Record<string, unknown>> {
      return {
        id: input.id,
        sourceKind: 'provider',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
        role: 'assistant',
        isLead: input.isLead,
        displayOrder: 0,
      };
    }

    async function seedRegisteredAgent(
      id: string,
      tools: Record<string, boolean>,
    ): Promise<void> {
      const db = getDbPg();
      await db`
        insert into public.registered_agents
          (id, owner_id, name, provider_id, model_id, tool_permissions_json)
        values
          (${id}::uuid, ${USER_A_ID}::uuid, 'agent', 'provider.anthropic',
           'claude-opus-4-7', ${db.json(tools as never)})
        on conflict (id) do update set tool_permissions_json = excluded.tool_permissions_json
      `;
    }

    it('adding a Researcher OR-s their tools into the active set, preserving user toggle-offs', async () => {
      // Pre-state: Editor agent is on the Talk. Editor has gmail_read.
      // The user has explicitly disabled web (a toggle-off the route
      // must preserve).
      await seedTalk(TALK_A_ID, USER_A_ID, {
        gmail_read: true,
        web: false,
      });
      await seedRegisteredAgent(EDITOR_AGENT_ID, { gmail_read: true });
      await seedRegisteredAgent(RESEARCHER_AGENT_ID, { web: true });
      const db = getDbPg();
      await db`
        insert into public.talk_agents (talk_id, owner_id, registered_agent_id, is_primary, source_kind)
        values (${TALK_A_ID}::uuid, ${USER_A_ID}::uuid, ${EDITOR_AGENT_ID}::uuid, true, 'provider')
      `;

      // Send next agent set: keep Editor, add Researcher.
      const result = await updateTalkAgentsRoute({
        auth: AUTH_A,
        talkId: TALK_A_ID,
        agents: [
          await buildAgentInput({ id: EDITOR_AGENT_ID, isLead: true }),
          await buildAgentInput({
            id: RESEARCHER_AGENT_ID,
            isLead: false,
          }),
        ],
      });
      expect(result.statusCode).toBe(200);

      const active = await withUserContext(USER_A_ID, async () => {
        return await getTalkActiveTools(TALK_A_ID);
      });
      // web is OR'd in by Researcher (flipping the explicit false).
      // Editor's gmail_read was already in the active set — unchanged.
      expect(active).toEqual({ gmail_read: true, web: true });
    });

    it('resaving the same agent set does NOT re-OR-in (preserves deliberate toggle-offs)', async () => {
      await seedTalk(TALK_A_ID, USER_A_ID, { web: false });
      await seedRegisteredAgent(EDITOR_AGENT_ID, { web: true });
      const db = getDbPg();
      await db`
        insert into public.talk_agents (talk_id, owner_id, registered_agent_id, is_primary, source_kind)
        values (${TALK_A_ID}::uuid, ${USER_A_ID}::uuid, ${EDITOR_AGENT_ID}::uuid, true, 'provider')
      `;

      const result = await updateTalkAgentsRoute({
        auth: AUTH_A,
        talkId: TALK_A_ID,
        agents: [await buildAgentInput({ id: EDITOR_AGENT_ID, isLead: true })],
      });
      expect(result.statusCode).toBe(200);

      const active = await withUserContext(USER_A_ID, async () => {
        return await getTalkActiveTools(TALK_A_ID);
      });
      // Re-saving the same agent set — diff = no new agents — no OR-in.
      // The user's explicit `web: false` toggle-off is preserved.
      expect(active).toEqual({ web: false });
    });

    it('removing an agent leaves active_tool_families_json unchanged', async () => {
      await seedTalk(TALK_A_ID, USER_A_ID, {
        web: true,
        gmail_read: true,
      });
      await seedRegisteredAgent(EDITOR_AGENT_ID, { gmail_read: true });
      await seedRegisteredAgent(RESEARCHER_AGENT_ID, { web: true });
      const db = getDbPg();
      await db`
        insert into public.talk_agents (talk_id, owner_id, registered_agent_id, is_primary, source_kind)
        values
          (${TALK_A_ID}::uuid, ${USER_A_ID}::uuid, ${EDITOR_AGENT_ID}::uuid, true, 'provider'),
          (${TALK_A_ID}::uuid, ${USER_A_ID}::uuid, ${RESEARCHER_AGENT_ID}::uuid, false, 'provider')
      `;

      const result = await updateTalkAgentsRoute({
        auth: AUTH_A,
        talkId: TALK_A_ID,
        agents: [await buildAgentInput({ id: EDITOR_AGENT_ID, isLead: true })],
      });
      expect(result.statusCode).toBe(200);

      const active = await withUserContext(USER_A_ID, async () => {
        return await getTalkActiveTools(TALK_A_ID);
      });
      // The removed agent's capability stays in the active set so a
      // later re-add preserves the user's toggle state.
      expect(active).toEqual({ web: true, gmail_read: true });
    });
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
