// Talk-scoped tool toggles — end-to-end coverage that proves the active
// set actually reaches every downstream consumer that gates on it.
//
// This is the load-bearing test for the
// currently-we-have-agents-squishy-dragon.md plan: filter placement
// changed from agent-router.ts to getEffectiveToolsForAgent so all three
// consumers (loadTalkContext prompt assembly, loadTalkContext context
// tools array, container path) see the same talk-filtered list. Without
// this test, regressions could leave disabled tools in the prompt body
// even when the LLM tool array hides them — invisible token waste.
//
// The container `getContainerAllowedTools(...)` consumer is currently a
// chassis-stub (new-executor.ts:117) that returns []. When the container
// path is reintroduced, extend this file with an assertion on that
// helper's output.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import { createTalkRun, getTalkRunById } from '../db/accessors.js';
import {
  createRegisteredAgent,
  getEffectiveToolsForAgent,
} from '../db/agent-accessors.js';
import { createContent } from '../db/content-accessors.js';
import { loadTalkContext } from './context-loader.js';

const USER_ID = '0c222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TALK_ID = '0c222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function seedAuthUser(): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${USER_ID}::uuid, 'tools-int@clawtalk.local',
            jsonb_build_object('full_name', 'Tools Integration'))
    on conflict (id) do nothing
  `;
}

async function seedTalk(active: Record<string, boolean>): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talks (id, owner_id, topic_title, active_tool_families_json)
    values (${TALK_ID}::uuid, ${USER_ID}::uuid, 'Tools Integration Talk',
            ${db.json(active as never)})
    on conflict (id) do update set active_tool_families_json = excluded.active_tool_families_json
  `;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  // Talk cascade clears talk_threads, talk_runs, talk_agents, contents.
  await db`delete from public.talks where id = ${TALK_ID}::uuid`;
  await db`delete from public.registered_agents where owner_id = ${USER_ID}::uuid`;
}

const FULL_CAPABILITY = {
  web: true,
  google_read: true,
  google_write: true,
  shell: true,
  filesystem: true,
  connectors: true,
};

describe('talk-scoped tool toggles — effective-tools pipeline', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser();
  });

  afterAll(async () => {
    const db = getDbPg();
    await purge();
    await db`delete from auth.users where id = ${USER_ID}::uuid`;
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purge();
  });

  it('web: false → web_search absent from contextTools AND web-freshness stanza absent from systemPrompt', async () => {
    await seedTalk({
      web: false,
      google_read: true,
      google_write: true,
    });

    await withUserContext(USER_ID, async () => {
      const agent = await createRegisteredAgent({
        ownerId: USER_ID,
        name: 'Capable Researcher',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
        toolPermissions: FULL_CAPABILITY,
      });

      const effectiveTools = await getEffectiveToolsForAgent(agent.id, {
        talkId: TALK_ID,
      });
      const webAccess = effectiveTools.find((t) => t.toolFamily === 'web');
      expect(webAccess?.enabled).toBe(false);

      const ctx = await loadTalkContext(TALK_ID, 8000, null, null, USER_ID, {
        effectiveTools,
      });

      const toolNames = ctx.contextTools.map((t) => t.name);
      expect(toolNames).not.toContain('web_search');
      expect(toolNames).not.toContain('web_fetch');
      expect(ctx.systemPrompt).not.toMatch(/web_search/);
      expect(ctx.systemPrompt).not.toMatch(/verify it with web_search/);
    });
  });

  it('google_read+google_write false → Bound Drive Resources prompt section omitted', async () => {
    await seedTalk({
      web: true,
      google_read: false,
      google_write: false,
    });

    await withUserContext(USER_ID, async () => {
      const agent = await createRegisteredAgent({
        ownerId: USER_ID,
        name: 'Capable',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
        toolPermissions: FULL_CAPABILITY,
      });

      const effectiveTools = await getEffectiveToolsForAgent(agent.id, {
        talkId: TALK_ID,
      });
      const ctx = await loadTalkContext(TALK_ID, 8000, null, null, USER_ID, {
        effectiveTools,
      });
      expect(ctx.systemPrompt).not.toMatch(/Bound Drive Resources/i);
      expect(ctx.systemPrompt).not.toMatch(/bound Google/i);
    });
  });

  it('ALWAYS_ALLOWED bypass holds: with all chips off + attached content, apply_content_edit is still in contextTools (PR #417 regression pin)', async () => {
    // Migration 0031 + filter intersection must NOT swallow the
    // ALWAYS_ALLOWED bypass. apply_content_edit is gated on `hasContent`,
    // not on any tool family, so toggling everything off must still
    // leave it exposed. If this test goes red the @doc edit-intent flow
    // is broken — Kimi 2.6 will resume chat-rewriting instead of editing.
    await seedTalk({});

    const db = getDbPg();
    const threadId = '0c222222-eeee-eeee-eeee-eeeeeeeeeeee';
    await db`
      insert into public.talk_threads (id, talk_id, owner_id)
      values (${threadId}::uuid, ${TALK_ID}::uuid, ${USER_ID}::uuid)
      on conflict (id) do nothing
    `;

    await withUserContext(USER_ID, async () => {
      const agent = await createRegisteredAgent({
        ownerId: USER_ID,
        name: 'No-tools Agent',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
        toolPermissions: FULL_CAPABILITY,
      });
      await createContent({
        ownerId: USER_ID,
        talkId: TALK_ID,
        threadId,
        title: 'Doc under test',
        createdByUserId: USER_ID,
      });

      const effectiveTools = await getEffectiveToolsForAgent(agent.id, {
        talkId: TALK_ID,
      });
      // Sanity: the filter actually disabled every family.
      for (const access of effectiveTools) {
        expect(access.enabled).toBe(false);
      }

      const ctx = await loadTalkContext(TALK_ID, 8000, null, null, USER_ID, {
        effectiveTools,
      });
      const toolNames = ctx.contextTools.map((t) => t.name);
      expect(toolNames).toContain('apply_content_edit');
      // Other ALWAYS_ALLOWED-style infrastructure tools are also present
      // independent of the filter.
      expect(toolNames).toContain('read_source');
      expect(toolNames).toContain('list_state');
    });
  });

  it('full active set → all enabled families produce their tool defs', async () => {
    await seedTalk({ web: true, google_read: true, google_write: true });

    await withUserContext(USER_ID, async () => {
      const agent = await createRegisteredAgent({
        ownerId: USER_ID,
        name: 'Full agent',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
        toolPermissions: FULL_CAPABILITY,
      });

      const effectiveTools = await getEffectiveToolsForAgent(agent.id, {
        talkId: TALK_ID,
      });
      const ctx = await loadTalkContext(TALK_ID, 8000, null, null, USER_ID, {
        effectiveTools,
      });
      const toolNames = ctx.contextTools.map((t) => t.name);
      expect(toolNames).toContain('web_search');
    });
  });

  it('activeFamilies snapshot path: passing snapshot instead of talkId disables web even when DB live state has web=true', async () => {
    // Pins the queue-snapshot escape hatch (T4 will use this for
    // multi-agent response groups). When `activeFamilies` is passed, the
    // accessor MUST use the explicit snapshot and ignore live state.
    await seedTalk({ web: true });

    await withUserContext(USER_ID, async () => {
      const agent = await createRegisteredAgent({
        ownerId: USER_ID,
        name: 'Snapshot agent',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
        toolPermissions: FULL_CAPABILITY,
      });
      const effectiveTools = await getEffectiveToolsForAgent(agent.id, {
        talkId: TALK_ID,
        activeFamilies: { web: false },
      });
      expect(effectiveTools.find((t) => t.toolFamily === 'web')?.enabled).toBe(
        false,
      );
    });
  });

  it('talk_runs.active_tool_families_snapshot: round-trips through createTalkRun + getTalkRunById and survives mid-flight Talk mutations', async () => {
    // The structural assertion for T4: the snapshot column actually
    // freezes per-run tool state. Mutating talks.active_tool_families_json
    // AFTER the run is created must not change what the run sees on
    // pickup. The executor reads from the snapshot and passes it as
    // `activeFamilies` to planExecution.
    await seedTalk({ web: true, gmail_read: true });

    const db = getDbPg();
    // talk_runs requires a real thread row.
    const threadId = '0c222222-cccc-cccc-cccc-cccccccccccc';
    await db`
      insert into public.talk_threads (id, talk_id, owner_id)
      values (${threadId}::uuid, ${TALK_ID}::uuid, ${USER_ID}::uuid)
      on conflict (id) do nothing
    `;

    const run = await withUserContext(USER_ID, async () => {
      return await createTalkRun({
        ownerId: USER_ID,
        talkId: TALK_ID,
        threadId,
        requestedBy: USER_ID,
        status: 'queued',
        activeToolFamiliesSnapshot: { web: true, gmail_read: true },
      });
    });
    expect(run.active_tool_families_snapshot).toEqual({
      web: true,
      gmail_read: true,
    });

    // User toggles web off AFTER the run was queued — simulates a chip
    // click while the response group is still in flight.
    await db`
      update public.talks
      set active_tool_families_json = '{"web": false}'::jsonb
      where id = ${TALK_ID}::uuid
    `;

    const refetched = await withUserContext(USER_ID, async () => {
      return await getTalkRunById(run.id);
    });
    expect(refetched?.active_tool_families_snapshot).toEqual({
      web: true,
      gmail_read: true,
    });

    // Snapshot routed through the accessor: web stays enabled for this
    // in-flight run even though live state has web=false.
    await withUserContext(USER_ID, async () => {
      const agent = await createRegisteredAgent({
        ownerId: USER_ID,
        name: 'Mid-flight agent',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
        toolPermissions: FULL_CAPABILITY,
      });
      const eff = await getEffectiveToolsForAgent(agent.id, {
        activeFamilies: refetched?.active_tool_families_snapshot ?? {},
      });
      expect(eff.find((t) => t.toolFamily === 'web')?.enabled).toBe(true);
    });
  });
});
