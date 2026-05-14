// clawtalk Phase 5 (PR 2) — postgres talk_agents CRUD that previously
// lived as inline SQL inside src/clawtalk/agents/agent-registry.ts.
//
// Every function is async and runs against postgres.js via `getDbPg()`. Per
// supabase/migrations/0002_rls_policies.sql, `talk_agents` has RLS
// `using/with check (owner_id = auth.uid())` — so callers MUST wrap each
// call in `withUserContext(userId, async () => ...)`. Outside that scope
// `getDbPg()` returns the BYPASSRLS pooled connection and silently
// short-circuits ownership checks.
//
// Signature changes vs the sqlite version (agent-registry.ts):
//   - `setTalkAgents` takes an explicit `ownerId` param. RLS WITH CHECK
//     enforces it must equal `auth.uid()`; making it explicit keeps the
//     call site honest about the owner identity it's writing.
//   - Assignment IDs are bare uuid (no `ta_` prefix). The schema defaults
//     `id` to `gen_random_uuid()`, so inserts omit the column and let the
//     database fill it.
//   - `is_primary` is a JS boolean (not 0/1). The schema's `boolean not
//     null default false` column round-trips natively via postgres.js.
//   - SELECT shapes alias columns and the internal row interfaces stay
//     snake_case; the exported JS-side interfaces (TalkAgentAssignment,
//     TalkAgentRow) keep the camelCase shape callers already use.
//
// Callers (currently agent-registry.ts) will swap from the sqlite inline
// SQL to these helpers in Wave 2 / U2-ar.
//
// Reference: agent-registry.ts inline SQL at lines 124 (listTalkAgents),
// 168 (resolvePrimaryAgent), 193 (resolveAgentByName), 335 (setTalkAgents),
// 376 (pruneDeletedTalkAgentAssignments), 413 (getTalkAgentRows).

import { getDbPg, type Sql } from '../../db.js';
import type { RegisteredAgentRecord } from './agent-accessors.js';

// ---------------------------------------------------------------------------
// Exported JS-side interfaces (camelCase — keep the shape callers already
// consume from agent-registry.ts)
// ---------------------------------------------------------------------------

export interface TalkAgentAssignment {
  assignmentId: string;
  agentId: string;
  agentName: string;
  nickname: string;
  personaRole: string | null;
  isPrimary: boolean;
  sortOrder: number;
}

export interface TalkAgentInput {
  /** Registered-agent FK. The schema-level PK is server-generated. */
  id: string;
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  modelId: string;
  nickname: string | null;
  nicknameMode: 'auto' | 'custom';
  personaRole: string;
  isPrimary: boolean;
  sortOrder: number;
}

export interface TalkAgentRow {
  id: string;
  talkId: string;
  registeredAgentId: string | null;
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  modelId: string | null;
  nickname: string | null;
  nicknameMode: 'auto' | 'custom';
  personaRole: string | null;
  isPrimary: boolean;
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// Internal snake_case row shapes (match the SELECT lists below)
// ---------------------------------------------------------------------------

interface TalkAgentAssignmentRow {
  assignment_id: string;
  agent_id: string;
  agent_name: string;
  nickname: string;
  persona_role: string | null;
  is_primary: boolean;
  sort_order: number;
}

interface TalkAgentRowRecord {
  id: string;
  talk_id: string;
  registered_agent_id: string | null;
  source_kind: 'claude_default' | 'provider';
  provider_id: string | null;
  model_id: string | null;
  nickname: string | null;
  nickname_mode: 'auto' | 'custom';
  persona_role: string | null;
  is_primary: boolean;
  sort_order: number;
}

interface TalkAgentPruneRow {
  id: string;
  is_primary: boolean;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List agents assigned to a Talk, ordered by sort_order.
 * Only returns enabled agents — disabled agents are silently excluded.
 */
export async function listTalkAgents(
  talkId: string,
): Promise<TalkAgentAssignment[]> {
  const db: Sql = getDbPg();
  const rows = await db<TalkAgentAssignmentRow[]>`
    select
      ta.id as assignment_id,
      ta.registered_agent_id as agent_id,
      ra.name as agent_name,
      coalesce(ta.nickname, ra.name, 'Agent') as nickname,
      ta.persona_role,
      ta.is_primary,
      ta.sort_order
    from public.talk_agents ta
    join public.registered_agents ra on ra.id = ta.registered_agent_id
    where ta.talk_id = ${talkId}::uuid
      and ra.enabled = true
    order by ta.sort_order asc
  `;
  return rows.map((row) => ({
    assignmentId: row.assignment_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    nickname: row.nickname,
    personaRole: row.persona_role,
    isPrimary: row.is_primary,
    sortOrder: row.sort_order,
  }));
}

/**
 * Resolve the primary agent for a Talk.
 * Returns the agent marked as primary, or the first assigned agent.
 * Only considers enabled agents — disabled agents are skipped.
 */
export async function resolvePrimaryAgent(
  talkId: string,
): Promise<RegisteredAgentRecord | undefined> {
  const db = getDbPg();
  const rows = await db<RegisteredAgentRecord[]>`
    select ra.id, ra.owner_id, ra.name, ra.provider_id, ra.model_id,
           ra.tool_permissions_json, ra.persona_role, ra.system_prompt,
           ra.description, ra.enabled, ra.created_at, ra.updated_at
    from public.talk_agents ta
    join public.registered_agents ra on ra.id = ta.registered_agent_id
    where ta.talk_id = ${talkId}::uuid
      and ra.enabled = true
    order by ta.is_primary desc, ta.sort_order asc
    limit 1
  `;
  return rows[0];
}

/**
 * Resolve a specific agent for a Talk by @mention name.
 * Used for explicit @agent routing.
 * Only considers enabled agents — disabled agents are not routable.
 */
export async function resolveAgentByName(
  talkId: string,
  agentName: string,
): Promise<RegisteredAgentRecord | undefined> {
  const db = getDbPg();
  const rows = await db<RegisteredAgentRecord[]>`
    select ra.id, ra.owner_id, ra.name, ra.provider_id, ra.model_id,
           ra.tool_permissions_json, ra.persona_role, ra.system_prompt,
           ra.description, ra.enabled, ra.created_at, ra.updated_at
    from public.talk_agents ta
    join public.registered_agents ra on ra.id = ta.registered_agent_id
    where ta.talk_id = ${talkId}::uuid
      and (
        lower(coalesce(ta.nickname, '')) = lower(${agentName})
        or lower(ra.name) = lower(${agentName})
      )
      and ra.enabled = true
    limit 1
  `;
  return rows[0];
}

/**
 * Load all talk_agents for a Talk, ordered by sort_order.
 *
 * Runs the prune pass first so the returned rows always satisfy the
 * "exactly one primary among non-null FKs" invariant the UI relies on.
 */
export async function getTalkAgentRows(
  talkId: string,
): Promise<TalkAgentRow[]> {
  await pruneDeletedTalkAgentAssignments(talkId);
  const db = getDbPg();
  const rows = await db<TalkAgentRowRecord[]>`
    select
      id, talk_id, registered_agent_id,
      source_kind, provider_id, model_id,
      nickname, nickname_mode,
      persona_role, is_primary, sort_order
    from public.talk_agents
    where talk_id = ${talkId}::uuid
    order by sort_order asc, created_at asc
  `;
  return rows.map((row) => ({
    id: row.id,
    talkId: row.talk_id,
    registeredAgentId: row.registered_agent_id,
    sourceKind: row.source_kind,
    providerId: row.provider_id,
    modelId: row.model_id,
    nickname: row.nickname,
    nicknameMode: row.nickname_mode,
    personaRole: row.persona_role,
    isPrimary: row.is_primary,
    sortOrder: row.sort_order,
  }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Replace all talk_agents for a Talk in a single transaction.
 *
 * Deletes existing rows and inserts the new set. Full replace — partial
 * updates are not supported (the frontend always sends the full list).
 *
 * `input.ownerId` is the owner of the Talk. RLS WITH CHECK enforces it
 * equals `auth.uid()`; passing it explicitly keeps the call site honest.
 * The PK is server-generated (`gen_random_uuid()` default), so each row
 * gets a fresh assignment id.
 */
export async function setTalkAgents(input: {
  talkId: string;
  ownerId: string;
  agents: TalkAgentInput[];
}): Promise<void> {
  const { talkId, ownerId, agents } = input;
  const db = getDbPg();
  // No inner db.begin() — getDbPg() returns the outer withUserContext
  // transaction (a TransactionSql, no .begin method) in Worker mode.
  // The outer transaction already provides delete+insert atomicity.
  await db`delete from public.talk_agents where talk_id = ${talkId}::uuid`;
  for (const agent of agents) {
    await db`
      insert into public.talk_agents (
        talk_id, owner_id, registered_agent_id,
        source_kind, provider_id, model_id,
        nickname, nickname_mode,
        persona_role, is_primary, sort_order
      ) values (
        ${talkId}::uuid, ${ownerId}::uuid, ${agent.id}::uuid,
        ${agent.sourceKind}, ${agent.providerId}, ${agent.modelId},
        ${agent.nickname}, ${agent.nicknameMode},
        ${agent.personaRole}, ${agent.isPrimary}, ${agent.sortOrder}
      )
    `;
  }
}

/**
 * Drop assignments whose registered_agent_id FK was nulled by an agent
 * delete (cascade from `on delete set null`), then heal the
 * "exactly one primary" invariant if the surviving rows broke it.
 */
export async function pruneDeletedTalkAgentAssignments(
  talkId: string,
): Promise<void> {
  const db = getDbPg();
  // No inner db.begin() — see setTalkAgents above. The outer
  // withUserContext transaction wraps the delete+heal sequence.
  await db`
    delete from public.talk_agents
    where talk_id = ${talkId}::uuid
      and registered_agent_id is null
  `;

  const remaining = await db<TalkAgentPruneRow[]>`
    select id, is_primary
    from public.talk_agents
    where talk_id = ${talkId}::uuid
    order by sort_order asc, created_at asc
  `;
  if (remaining.length === 0) return;

  const primaryCount = remaining.filter((row) => row.is_primary).length;
  if (primaryCount === 1) return;

  const nextPrimaryId = remaining[0]!.id;
  await db`
    update public.talk_agents
    set is_primary = case when id = ${nextPrimaryId}::uuid then true else false end
    where talk_id = ${talkId}::uuid
  `;
}
