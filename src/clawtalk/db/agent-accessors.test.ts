// clawtalk Phase 5 (PR 2) — end-to-end test for agent-accessors-pg.
//
// Runs against a live local supabase stack (DB on 127.0.0.1:54432 — see
// supabase/config.toml + reference_deploy.md). The schema must already be
// applied via `supabase start` or `supabase db reset`.
//
// Test goal: prove the new postgres + RLS pattern works end-to-end before
// the broader PR 2 fan-out (porting the other 5 accessor files +
// rewiring every call site). The cross-user assertion at the bottom is
// the load-bearing security gate — RLS must filter user B out of user A's
// rows, even with the same Hyperdrive-pooled connection underneath.
//
// Setup mirrors editorialroom's rls-multi-user.test.ts pattern: seed two
// auth.users (postgres role bypasses RLS), use distinct UUIDs that won't
// collide with the dev fixture (00000000-...), and CASCADE-delete in
// afterAll so consecutive runs start clean.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import {
  createRegisteredAgent,
  deleteRegisteredAgent,
  getEffectiveToolsForAgent,
  getFallbackSteps,
  getRegisteredAgent,
  getRegisteredAgentSnapshot,
  getUserToolPermission,
  listEnabledAgents,
  listRegisteredAgents,
  listUserToolPermissions,
  setFallbackSteps,
  TOOL_FAMILY_MAP,
  updateRegisteredAgent,
  upsertUserToolPermission,
} from './agent-accessors.js';

const USER_A_ID = '0c111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = '0c111111-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FALLBACK_PROVIDER_ID = 'test.fallback-provider';
const FALLBACK_MODEL_ID = 'test.fallback-model';

async function seedAuthUser(
  id: string,
  email: string,
  displayName: string,
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (
      ${id}::uuid,
      ${email}::text,
      jsonb_build_object('full_name', ${displayName}::text)
    )
    on conflict (id) do nothing
  `;
}

async function seedFallbackProvider(): Promise<void> {
  const db = getDbPg();
  // agent_fallback_steps.provider_id has FK to llm_providers(id) and the
  // (provider_id, model_id) pair has FK to llm_provider_models. Both rows
  // must exist before setFallbackSteps can insert.
  await db`
    insert into public.llm_providers (id, name, provider_kind, api_format, base_url, auth_scheme)
    values (${FALLBACK_PROVIDER_ID}, 'Test Fallback Provider', 'custom', 'openai_chat_completions', 'mock://fallback', 'bearer')
    on conflict (id) do nothing
  `;
  await db`
    insert into public.llm_provider_models
      (provider_id, model_id, display_name, context_window_tokens, default_max_output_tokens)
    values
      (${FALLBACK_PROVIDER_ID}, ${FALLBACK_MODEL_ID}, 'Test Fallback Model', 32000, 2048)
    on conflict (provider_id, model_id) do nothing
  `;
}

async function purgeOwnerRows(): Promise<void> {
  // Cleanup runs as postgres role (BYPASSRLS). Deletes cascade from
  // registered_agents → agent_fallback_steps and talk_agents (set null).
  const db = getDbPg();
  await db`
    delete from public.registered_agents
    where owner_id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
  `;
  await db`
    delete from public.user_tool_permissions
    where user_id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
  `;
}

describe('agent-accessors-pg (postgres + RLS)', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser(USER_A_ID, 'rls-a@clawtalk.local', 'RLS User A');
    await seedAuthUser(USER_B_ID, 'rls-b@clawtalk.local', 'RLS User B');
    await seedFallbackProvider();
  });

  afterAll(async () => {
    const db = getDbPg();
    // Drop test users + provider so consecutive runs start clean. Users
    // cascade to public.users → registered_agents → agent_fallback_steps,
    // talk_*, etc.
    await db`
      delete from auth.users
      where id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
    `;
    await db`
      delete from public.llm_provider_models
      where provider_id = ${FALLBACK_PROVIDER_ID}
    `;
    await db`
      delete from public.llm_providers
      where id = ${FALLBACK_PROVIDER_ID}
    `;
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purgeOwnerRows();
  });

  it('schema preconditions: RLS enabled + policies present on agent tables', async () => {
    const db = getDbPg();
    const rows = await db<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('registered_agents', 'agent_fallback_steps', 'user_tool_permissions')
    `;
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
    }
    const policies = await db<{ tablename: string; policyname: string }[]>`
      select tablename, policyname
      from pg_policies
      where schemaname = 'public'
        and tablename in ('registered_agents', 'agent_fallback_steps', 'user_tool_permissions')
    `;
    const tablesWithPolicy = new Set(policies.map((p) => p.tablename));
    expect(tablesWithPolicy.has('registered_agents')).toBe(true);
    expect(tablesWithPolicy.has('agent_fallback_steps')).toBe(true);
    expect(tablesWithPolicy.has('user_tool_permissions')).toBe(true);
  });

  it('createRegisteredAgent stamps owner_id and returns the inserted row', async () => {
    const agent = await withUserContext(USER_A_ID, async () => {
      return await createRegisteredAgent({
        ownerId: USER_A_ID,
        name: 'Growth Analyst',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
        systemPrompt: 'Analyze trends.',
      });
    });
    expect(agent.owner_id).toBe(USER_A_ID);
    expect(agent.name).toBe('Growth Analyst');
    expect(agent.enabled).toBe(true);
    expect(agent.tool_permissions_json).toMatchObject({
      web: true,
      connectors: true,
    });
  });

  it('round-trips create → get → list → updates → delete inside withUserContext', async () => {
    const created = await withUserContext(USER_A_ID, async () => {
      const agent = await createRegisteredAgent({
        ownerId: USER_A_ID,
        name: 'Researcher',
        providerId: 'provider.anthropic',
        modelId: 'claude-haiku-4-5',
        personaRole: 'researcher',
        description: 'Cites sources for every claim.',
      });

      const fetched = await getRegisteredAgent(agent.id);
      expect(fetched?.id).toBe(agent.id);

      const snapshot = await getRegisteredAgentSnapshot(agent.id);
      expect(snapshot?.personaRole).toBe('researcher');
      expect(snapshot?.toolPermissions.web).toBe(true);

      const list = await listRegisteredAgents();
      expect(list.map((a) => a.id)).toContain(agent.id);

      const enabled = await listEnabledAgents();
      expect(enabled.map((a) => a.id)).toContain(agent.id);

      const updated = await updateRegisteredAgent(agent.id, {
        name: 'Researcher (renamed)',
        description: null,
        toolPermissions: {
          web: false,
          gmail_send: true,
        },
      });
      expect(updated?.name).toBe('Researcher (renamed)');
      expect(updated?.description).toBeNull();
      expect(updated?.tool_permissions_json.web).toBe(false);
      // gmail_send true implies gmail_read true (auto-dependency).
      expect(updated?.tool_permissions_json.gmail_read).toBe(true);
      expect(updated?.tool_permissions_json.gmail_send).toBe(true);

      return agent;
    });

    await withUserContext(USER_A_ID, async () => {
      const deleted = await deleteRegisteredAgent(created.id);
      expect(deleted).toBe(true);
      const after = await getRegisteredAgent(created.id);
      expect(after).toBeUndefined();
    });
  });

  it('fallback steps round-trip per agent', async () => {
    await withUserContext(USER_A_ID, async () => {
      const agent = await createRegisteredAgent({
        ownerId: USER_A_ID,
        name: 'With Fallbacks',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
      });
      expect(await getFallbackSteps(agent.id)).toEqual([]);

      await setFallbackSteps({
        ownerId: USER_A_ID,
        agentId: agent.id,
        steps: [
          { providerId: FALLBACK_PROVIDER_ID, modelId: FALLBACK_MODEL_ID },
        ],
      });
      const steps = await getFallbackSteps(agent.id);
      expect(steps).toEqual([
        {
          position: 1,
          providerId: FALLBACK_PROVIDER_ID,
          modelId: FALLBACK_MODEL_ID,
        },
      ]);

      // Replacement: setFallbackSteps([]) clears.
      await setFallbackSteps({
        ownerId: USER_A_ID,
        agentId: agent.id,
        steps: [],
      });
      expect(await getFallbackSteps(agent.id)).toEqual([]);
    });
  });

  it('user_tool_permissions upsert + read', async () => {
    await withUserContext(USER_A_ID, async () => {
      await upsertUserToolPermission({
        userId: USER_A_ID,
        toolId: 'Bash',
        allowed: false,
        requiresApproval: true,
      });
      const got = await getUserToolPermission('Bash');
      expect(got).toEqual({
        toolId: 'Bash',
        allowed: false,
        requiresApproval: true,
      });

      // Upsert again — should overwrite, not duplicate.
      await upsertUserToolPermission({
        userId: USER_A_ID,
        toolId: 'Bash',
        allowed: true,
        requiresApproval: false,
      });
      const all = await listUserToolPermissions();
      expect(all.length).toBe(1);
      expect(all[0]).toEqual({
        toolId: 'Bash',
        allowed: true,
        requiresApproval: false,
      });
    });
  });

  it('getEffectiveToolsForAgent composes agent + user permissions', async () => {
    await withUserContext(USER_A_ID, async () => {
      const agent = await createRegisteredAgent({
        ownerId: USER_A_ID,
        name: 'Tool Composer',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
        toolPermissions: { web: true, gmail_read: true },
      });
      await upsertUserToolPermission({
        userId: USER_A_ID,
        toolId: 'web_fetch',
        allowed: false,
        requiresApproval: false,
      });

      const eff = await getEffectiveToolsForAgent(agent.id);
      // Sanity: every family in the catalog shows up.
      expect(eff.length).toBe(Object.keys(TOOL_FAMILY_MAP).length);

      const web = eff.find((e) => e.toolFamily === 'web');
      // Agent allows web, but the user denies web_fetch — overall disabled.
      expect(web?.enabled).toBe(false);

      const gmailRead = eff.find((e) => e.toolFamily === 'gmail_read');
      expect(gmailRead?.enabled).toBe(true);
      expect(gmailRead?.runtimeTools).toContain('gmail_read');

      const shell = eff.find((e) => e.toolFamily === 'shell');
      expect(shell?.enabled).toBe(false); // not in the agent's permission map
    });
  });

  it('RLS gate: user B cannot see user A registered_agents', async () => {
    const agentA = await withUserContext(USER_A_ID, async () => {
      return await createRegisteredAgent({
        ownerId: USER_A_ID,
        name: 'A-only',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
      });
    });

    await withUserContext(USER_B_ID, async () => {
      const list = await listRegisteredAgents();
      expect(list.find((a) => a.id === agentA.id)).toBeUndefined();
      const direct = await getRegisteredAgent(agentA.id);
      expect(direct).toBeUndefined();
    });

    // Sanity: user A still sees their own row.
    await withUserContext(USER_A_ID, async () => {
      const direct = await getRegisteredAgent(agentA.id);
      expect(direct?.id).toBe(agentA.id);
    });
  });

  it('RLS gate: user B INSERT with ownerId=USER_A is rejected by WITH CHECK', async () => {
    await expect(
      withUserContext(USER_B_ID, async () => {
        await createRegisteredAgent({
          ownerId: USER_A_ID,
          name: 'attempted cross-user',
          providerId: 'provider.anthropic',
          modelId: 'claude-opus-4-7',
        });
      }),
    ).rejects.toThrow();
  });

  it('RLS gate: user B UPDATE on user A row reports zero affected (USING filter)', async () => {
    const agentA = await withUserContext(USER_A_ID, async () => {
      return await createRegisteredAgent({
        ownerId: USER_A_ID,
        name: 'A-only-update-target',
        providerId: 'provider.anthropic',
        modelId: 'claude-opus-4-7',
      });
    });

    // updateRegisteredAgent inside user B's context — RLS USING filters
    // out the row, so the UPDATE matches zero rows and returns undefined.
    const updated = await withUserContext(USER_B_ID, async () => {
      return await updateRegisteredAgent(agentA.id, { name: 'hijack' });
    });
    expect(updated).toBeUndefined();

    // Verify A's row is unchanged.
    await withUserContext(USER_A_ID, async () => {
      const refetched = await getRegisteredAgent(agentA.id);
      expect(refetched?.name).toBe('A-only-update-target');
    });
  });
});
