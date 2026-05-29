// clawtalk Phase 5 (PR 2) — postgres agent-accessors.
//
// Every function is async and runs against postgres.js via `getDbPg()`. Per
// supabase/migrations/0002_rls_policies.sql, every per-user table here has
// RLS `using/with check (owner_id = auth.uid())` — so callers MUST wrap
// each call in `withUserContext(userId, async () => ...)`. Outside that
// scope `getDbPg()` returns the BYPASSRLS pooled connection and silently
// short-circuits ownership checks (gotcha #2 from the editorialroom port
// — see project_phase5_pr2_plan.md).
//
// Signature changes vs the sqlite version:
//   - Writes that need owner_id / user_id in their INSERT VALUES take an
//     explicit ownerId / userId param (RLS WITH CHECK enforces it equals
//     auth.uid(); the parameter makes the call site explicit rather than
//     hidden behind a SQL subquery).
//   - Reads, UPDATEs, and DELETEs filtered by RLS USING drop the
//     redundant userId param the old API carried (sqlite single-tenant
//     era).
//   - tool_permissions_json is now jsonb — postgres.js returns it as a
//     parsed object, so the record shape carries Record<string, boolean>
//     instead of a JSON string.
//   - `enabled` is boolean (not 0/1).
//
// This file is the proof-of-concept landing in the first commit of PR 2.
// Callers (route handlers, agent-registry, agent-router, executors) still
// import the sqlite agent-accessors.ts; the swap happens in the fan-out
// commits after this pattern is verified end-to-end against `supabase
// start`.

import { getDbPg, getOutOfBandSql, type Sql } from '../../db.js';

// ---------------------------------------------------------------------------
// Tool Capability Mapping (carried over verbatim from agent-accessors.ts —
// the catalog is independent of the persistence layer)
// ---------------------------------------------------------------------------

export const TOOL_FAMILY_MAP: Record<string, string[]> = {
  shell: ['Bash'],
  filesystem: ['Read', 'Write', 'Edit', 'Glob'],
  web: ['web_fetch', 'web_search'],
  browser: [
    'browser_open',
    'browser_snapshot',
    'browser_act',
    'browser_wait',
    'browser_screenshot',
    'browser_close',
  ],
  connectors: [],
  google_read: [
    'GoogleDriveRead',
    'GoogleDocsRead',
    'google_drive_search',
    'google_drive_read',
    'google_drive_list_folder',
    'google_docs_read',
    'google_sheets_read_range',
  ],
  google_write: [
    'GoogleDriveWrite',
    'GoogleDocsWrite',
    'google_docs_create',
    'google_docs_batch_update',
    'google_sheets_batch_update',
  ],
  gmail_read: ['GmailRead', 'GmailSearch', 'gmail_read'],
  gmail_send: ['GmailSend', 'gmail_send'],
  messaging: ['DiscordSend', 'SlackSend'],
};

export function buildDefaultTalkToolPermissions(): Record<string, boolean> {
  return {
    web: true,
    connectors: true,
    google_read: true,
    google_write: true,
    gmail_read: true,
    gmail_send: true,
    messaging: true,
  };
}

export const AUTO_IMPLIED_DEPENDENCIES: Array<[string, string]> = [
  ['shell', 'filesystem'],
  ['gmail_send', 'gmail_read'],
];

export function validateToolPermissions(value: unknown): {
  valid: boolean;
  error?: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      valid: false,
      error: 'tool_permissions must be a JSON object',
    };
  }
  const obj = value as Record<string, unknown>;
  const knownFamilies = Object.keys(TOOL_FAMILY_MAP);
  for (const key of Object.keys(obj)) {
    if (!knownFamilies.includes(key)) {
      return {
        valid: false,
        error: `Unknown tool family: ${key}. Valid families are: ${knownFamilies.join(', ')}`,
      };
    }
    if (typeof obj[key] !== 'boolean') {
      return {
        valid: false,
        error: `Value for ${key} must be boolean, got ${typeof obj[key]}`,
      };
    }
  }
  return { valid: true };
}

export function applyToolDependencies(
  permissions: Record<string, boolean>,
): Record<string, boolean> {
  const result = { ...permissions };
  for (const [left, right] of AUTO_IMPLIED_DEPENDENCIES) {
    if (result[left] === true && result[right] !== true) {
      result[right] = true;
    }
    if (result[right] === false && result[left] !== false) {
      result[left] = false;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Record + snapshot types
// ---------------------------------------------------------------------------

export type RegisteredAgentCredentialMode = 'api_key' | 'subscription';

export interface RegisteredAgentRecord {
  id: string;
  owner_id: string;
  name: string;
  provider_id: string;
  model_id: string;
  tool_permissions_json: Record<string, boolean>;
  persona_role: string | null;
  system_prompt: string | null;
  description: string | null;
  enabled: boolean;
  // NULL = auto (resolver walks personal/workspace × api_key/subscription
  // precedence). Non-null pins the agent to a specific credential kind.
  // See execution-resolver.ts:resolveSecret.
  credential_mode: RegisteredAgentCredentialMode | null;
  // Retired-model auto-upgrade trail. Non-null `from` = the agent was moved
  // off a retired model; the UI shows a badge until acknowledged.
  model_auto_upgraded_from: string | null;
  model_auto_upgraded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentFallbackStepRecord {
  agent_id: string;
  position: number;
  provider_id: string;
  model_id: string;
  owner_id: string;
}

export interface UserToolPermissionRecord {
  user_id: string;
  tool_id: string;
  allowed: boolean;
  requires_approval: boolean;
  updated_at: string;
}

export interface RegisteredAgentSnapshot {
  id: string;
  name: string;
  providerId: string;
  modelId: string;
  toolPermissions: Record<string, boolean>;
  personaRole: string | null;
  systemPrompt: string | null;
  description: string | null;
  enabled: boolean;
  credentialMode: RegisteredAgentCredentialMode | null;
  modelAutoUpgradedFrom: string | null;
  modelAutoUpgradedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentFallbackStep {
  position: number;
  providerId: string;
  modelId: string;
}

export interface UserToolPermission {
  toolId: string;
  allowed: boolean;
  requiresApproval: boolean;
}

export function toAgentSnapshot(
  record: RegisteredAgentRecord,
): RegisteredAgentSnapshot {
  return {
    id: record.id,
    name: record.name,
    providerId: record.provider_id,
    modelId: record.model_id,
    toolPermissions: record.tool_permissions_json,
    personaRole: record.persona_role,
    systemPrompt: record.system_prompt,
    description: record.description,
    enabled: record.enabled,
    credentialMode: record.credential_mode,
    modelAutoUpgradedFrom: record.model_auto_upgraded_from,
    modelAutoUpgradedAt: record.model_auto_upgraded_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function toUserToolPermission(
  record: UserToolPermissionRecord,
): UserToolPermission {
  return {
    toolId: record.tool_id,
    allowed: record.allowed,
    requiresApproval: record.requires_approval,
  };
}

// ---------------------------------------------------------------------------
// Registered Agents CRUD
// ---------------------------------------------------------------------------

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getRegisteredAgent(
  agentId: string,
): Promise<RegisteredAgentRecord | undefined> {
  // Short-circuit non-UUID input so legacy slug-style identifiers
  // (e.g. the sqlite-era 'agent.talk' fallback ID) don't pollute the
  // current transaction with a postgres 22P02 cast error.
  if (!UUID_REGEX.test(agentId)) return undefined;
  const db: Sql = getDbPg();
  const rows = await db<RegisteredAgentRecord[]>`
    select id, owner_id, name, provider_id, model_id,
           tool_permissions_json, persona_role, system_prompt,
           description, enabled, credential_mode,
           model_auto_upgraded_from, model_auto_upgraded_at,
           created_at, updated_at
    from public.registered_agents
    where id = ${agentId}::uuid
    limit 1
  `;
  return rows[0];
}

export async function getRegisteredAgentSnapshot(
  agentId: string,
): Promise<RegisteredAgentSnapshot | undefined> {
  const record = await getRegisteredAgent(agentId);
  return record ? toAgentSnapshot(record) : undefined;
}

export async function listRegisteredAgents(): Promise<RegisteredAgentRecord[]> {
  const db = getDbPg();
  return await db<RegisteredAgentRecord[]>`
    select id, owner_id, name, provider_id, model_id,
           tool_permissions_json, persona_role, system_prompt,
           description, enabled, credential_mode,
           model_auto_upgraded_from, model_auto_upgraded_at,
           created_at, updated_at
    from public.registered_agents
    order by created_at asc
  `;
}

export async function listEnabledAgents(): Promise<RegisteredAgentRecord[]> {
  const db = getDbPg();
  return await db<RegisteredAgentRecord[]>`
    select id, owner_id, name, provider_id, model_id,
           tool_permissions_json, persona_role, system_prompt,
           description, enabled, credential_mode,
           model_auto_upgraded_from, model_auto_upgraded_at,
           created_at, updated_at
    from public.registered_agents
    where enabled = true
    order by created_at asc
  `;
}

export async function createRegisteredAgent(params: {
  ownerId: string;
  name: string;
  providerId: string;
  modelId: string;
  toolPermissions?: Record<string, boolean>;
  personaRole?: string | null;
  systemPrompt?: string | null;
  description?: string | null;
  credentialMode?: RegisteredAgentCredentialMode | null;
}): Promise<RegisteredAgentRecord> {
  const toolPermissions =
    params.toolPermissions ?? buildDefaultTalkToolPermissions();
  const validation = validateToolPermissions(toolPermissions);
  if (!validation.valid) {
    throw new Error(`Invalid tool permissions: ${validation.error}`);
  }
  const normalized = applyToolDependencies(toolPermissions);

  const db = getDbPg();
  const rows = await db<RegisteredAgentRecord[]>`
    insert into public.registered_agents
      (owner_id, name, provider_id, model_id, tool_permissions_json,
       persona_role, system_prompt, description, enabled, credential_mode)
    values
      (${params.ownerId}::uuid, ${params.name}, ${params.providerId},
       ${params.modelId}, ${db.json(normalized as never)},
       ${params.personaRole ?? null}, ${params.systemPrompt ?? null},
       ${params.description ?? null}, true,
       ${params.credentialMode ?? null})
    returning id, owner_id, name, provider_id, model_id,
              tool_permissions_json, persona_role, system_prompt,
              description, enabled, credential_mode,
              model_auto_upgraded_from, model_auto_upgraded_at,
              created_at, updated_at
  `;
  if (!rows[0]) {
    throw new Error('Failed to create agent');
  }
  return rows[0];
}

export async function updateRegisteredAgent(
  agentId: string,
  updates: Partial<{
    name: string;
    providerId: string;
    modelId: string;
    toolPermissions: Record<string, boolean>;
    personaRole: string | null;
    systemPrompt: string | null;
    description: string | null;
    enabled: boolean;
    credentialMode: RegisteredAgentCredentialMode | null;
  }>,
): Promise<RegisteredAgentRecord | undefined> {
  let normalizedToolPermissions: Record<string, boolean> | undefined;
  if (updates.toolPermissions !== undefined) {
    const validation = validateToolPermissions(updates.toolPermissions);
    if (!validation.valid) {
      throw new Error(`Invalid tool permissions: ${validation.error}`);
    }
    normalizedToolPermissions = applyToolDependencies(updates.toolPermissions);
  }

  // postgres.js doesn't have an Edit-clauses-as-array builder, so each
  // optional update is its own COALESCE column expression. Passing
  // `null`-tagged placeholder values means "leave unchanged" — the
  // sentinel is the explicit { name: 'name' | null } shape from the
  // updates object. Approach lifted from editorialroom's
  // editorial-piece-meta updater.
  const db = getDbPg();
  const rows = await db<RegisteredAgentRecord[]>`
    update public.registered_agents set
      name = coalesce(${updates.name ?? null}, name),
      provider_id = coalesce(${updates.providerId ?? null}, provider_id),
      model_id = coalesce(${updates.modelId ?? null}, model_id),
      tool_permissions_json = coalesce(
        ${
          normalizedToolPermissions !== undefined
            ? db.json(normalizedToolPermissions as never)
            : null
        },
        tool_permissions_json
      ),
      persona_role = case when ${updates.personaRole !== undefined}::boolean
        then ${updates.personaRole ?? null} else persona_role end,
      system_prompt = case when ${updates.systemPrompt !== undefined}::boolean
        then ${updates.systemPrompt ?? null} else system_prompt end,
      description = case when ${updates.description !== undefined}::boolean
        then ${updates.description ?? null} else description end,
      enabled = coalesce(${updates.enabled ?? null}, enabled),
      credential_mode = case when ${updates.credentialMode !== undefined}::boolean
        then ${updates.credentialMode ?? null} else credential_mode end,
      -- A deliberate model change (incl. accepting an "update available")
      -- acknowledges any pending auto-upgrade badge, so clear it.
      model_auto_upgraded_from = case when ${updates.modelId !== undefined}::boolean
        then null else model_auto_upgraded_from end,
      model_auto_upgraded_at = case when ${updates.modelId !== undefined}::boolean
        then null else model_auto_upgraded_at end,
      updated_at = now()
    where id = ${agentId}::uuid
    returning id, owner_id, name, provider_id, model_id,
              tool_permissions_json, persona_role, system_prompt,
              description, enabled, credential_mode,
              model_auto_upgraded_from, model_auto_upgraded_at,
              created_at, updated_at
  `;
  return rows[0];
}

/**
 * Auto-upgrade an agent off a retired model. Sets the new model_id and
 * records the trail (from + timestamp) so the UI can surface a notice.
 * Idempotent on the target: re-running with the same fromModel keeps the
 * badge. No-op if the agent's current model already differs from
 * `fromModel` (someone changed it first — avoids clobbering a concurrent
 * edit). Returns the updated record, or undefined if no row matched.
 */
export async function autoUpgradeAgentModel(
  agentId: string,
  fromModel: string,
  toModel: string,
): Promise<RegisteredAgentRecord | undefined> {
  if (!UUID_REGEX.test(agentId)) return undefined;
  const db = getDbPg();
  const rows = await db<RegisteredAgentRecord[]>`
    update public.registered_agents set
      model_id = ${toModel},
      model_auto_upgraded_from = ${fromModel},
      model_auto_upgraded_at = now(),
      updated_at = now()
    where id = ${agentId}::uuid and model_id = ${fromModel}
    returning id, owner_id, name, provider_id, model_id,
              tool_permissions_json, persona_role, system_prompt,
              description, enabled, credential_mode,
              model_auto_upgraded_from, model_auto_upgraded_at,
              created_at, updated_at
  `;
  return rows[0];
}

/**
 * Out-of-band variant of `autoUpgradeAgentModel` for the run-time safety net
 * (runtime-model-guard.ts). Identical guarded UPDATE, but runs on the request
 * scope's fresh auto-commit connection (`getOutOfBandSql()`) instead of the
 * surrounding transaction.
 *
 * WHY out-of-band: the swap happens deep inside a Talk run, whose
 * `withUserContext` transaction stays open for the whole multi-minute LLM
 * stream. An in-transaction UPDATE would hold the `registered_agents` row lock
 * until the run commits, so a concurrent run / page-load auto-upgrade / manual
 * edit on the SAME agent would block behind the stream (e.g. opening AI Agents
 * would hang). The auto-commit connection releases the row lock immediately;
 * the run's transaction only ever SELECTed the agent, so it holds no lock.
 *
 * RLS: `getOutOfBandSql()` is the BYPASSRLS pooled role (no `set local role
 * authenticated`), so this does NOT enforce `owner_id = auth.uid()`. Callers
 * MUST pass an `agentId` they already loaded under their own RLS context (the
 * guard loads it via getRegisteredAgent inside the run's user context), so the
 * id is provably the caller's own agent — the guarded `where` clause then only
 * ever touches that one authorized row.
 *
 * The predicate guards on BOTH `provider_id` and `model_id` (the values the
 * caller loaded). If a concurrent edit changed EITHER between the load and
 * this write — including a provider-only switch that leaves model_id intact —
 * the update matches no row and returns undefined, so the caller reloads and
 * adopts the new config instead of clobbering it (e.g. writing a Claude model
 * onto an agent the user just repointed to another provider).
 */
export async function autoUpgradeAgentModelOutsideTx(
  agentId: string,
  expectedProviderId: string,
  fromModel: string,
  toModel: string,
): Promise<RegisteredAgentRecord | undefined> {
  if (!UUID_REGEX.test(agentId)) return undefined;
  const db = getOutOfBandSql();
  const rows = await db<RegisteredAgentRecord[]>`
    update public.registered_agents set
      model_id = ${toModel},
      model_auto_upgraded_from = ${fromModel},
      model_auto_upgraded_at = now(),
      updated_at = now()
    where id = ${agentId}::uuid
      and provider_id = ${expectedProviderId}
      and model_id = ${fromModel}
    returning id, owner_id, name, provider_id, model_id,
              tool_permissions_json, persona_role, system_prompt,
              description, enabled, credential_mode,
              model_auto_upgraded_from, model_auto_upgraded_at,
              created_at, updated_at
  `;
  return rows[0];
}

/**
 * Dismiss the auto-upgrade badge for an agent (user acknowledged it).
 * Clears the trail without touching the model.
 */
export async function clearAgentModelUpgradeNotice(
  agentId: string,
): Promise<boolean> {
  if (!UUID_REGEX.test(agentId)) return false;
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    update public.registered_agents set
      model_auto_upgraded_from = null,
      model_auto_upgraded_at = null
    where id = ${agentId}::uuid and model_auto_upgraded_from is not null
    returning id
  `;
  return rows.length > 0;
}

/**
 * Delete a registered agent. The talk_agents → registered_agents FK has
 * `on delete set null` in 0001_init_clawtalk_schema.sql, so we don't need
 * an explicit detach step — the FK cascade handles it.
 */
export async function deleteRegisteredAgent(agentId: string): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    delete from public.registered_agents
    where id = ${agentId}::uuid
    returning id
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Agent fallback steps
// ---------------------------------------------------------------------------

export async function getFallbackSteps(
  agentId: string,
): Promise<AgentFallbackStep[]> {
  const db = getDbPg();
  const rows = await db<AgentFallbackStepRecord[]>`
    select agent_id, position, provider_id, model_id, owner_id
    from public.agent_fallback_steps
    where agent_id = ${agentId}::uuid
    order by position asc
  `;
  return rows.map((r) => ({
    position: r.position,
    providerId: r.provider_id,
    modelId: r.model_id,
  }));
}

export async function setFallbackSteps(params: {
  ownerId: string;
  agentId: string;
  steps: Array<{ providerId: string; modelId: string }>;
}): Promise<void> {
  const db = getDbPg();
  await db`
    delete from public.agent_fallback_steps
    where agent_id = ${params.agentId}::uuid
  `;
  for (let i = 0; i < params.steps.length; i++) {
    const step = params.steps[i];
    await db`
      insert into public.agent_fallback_steps
        (agent_id, position, provider_id, model_id, owner_id)
      values
        (${params.agentId}::uuid, ${i + 1}, ${step.providerId},
         ${step.modelId}, ${params.ownerId}::uuid)
    `;
  }
}

// ---------------------------------------------------------------------------
// User tool permissions
// ---------------------------------------------------------------------------

export async function getUserToolPermission(
  toolId: string,
): Promise<UserToolPermission | undefined> {
  const db = getDbPg();
  const rows = await db<UserToolPermissionRecord[]>`
    select user_id, tool_id, allowed, requires_approval, updated_at
    from public.user_tool_permissions
    where tool_id = ${toolId}
    limit 1
  `;
  return rows[0] ? toUserToolPermission(rows[0]) : undefined;
}

export async function listUserToolPermissions(): Promise<UserToolPermission[]> {
  const db = getDbPg();
  const rows = await db<UserToolPermissionRecord[]>`
    select user_id, tool_id, allowed, requires_approval, updated_at
    from public.user_tool_permissions
    order by tool_id asc
  `;
  return rows.map(toUserToolPermission);
}

export async function upsertUserToolPermission(params: {
  userId: string;
  toolId: string;
  allowed: boolean;
  requiresApproval: boolean;
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.user_tool_permissions
      (user_id, tool_id, allowed, requires_approval)
    values
      (${params.userId}::uuid, ${params.toolId}, ${params.allowed},
       ${params.requiresApproval})
    on conflict (user_id, tool_id) do update set
      allowed = excluded.allowed,
      requires_approval = excluded.requires_approval,
      updated_at = now()
  `;
}

// ---------------------------------------------------------------------------
// Effective tools computation
// ---------------------------------------------------------------------------

export interface EffectiveToolAccess {
  toolFamily: string;
  runtimeTools: string[];
  enabled: boolean;
  requiresApproval: boolean;
}

/**
 * Compute effective tools for an agent given the *caller's* permissions.
 * Inside withUserContext the auth.uid() bound to the tx is implicitly the
 * permissions owner — no userId param needed.
 *
 * `opts.talkId` adds the Talk-active intersection: a tool family is enabled
 * only if the agent has the capability AND the Talk currently has the family
 * toggled on. Live read from `talks.active_tool_families_json`. Pass
 * `opts.activeFamilies` instead to use an explicit snapshot (e.g. queue
 * consumer reading from the enqueued message — keeps a multi-agent response
 * group on a frozen tool set even if the user toggles mid-stream). Pass
 * neither for settings-side calls that just want the agent ∩ user view.
 *
 * Connectors note: the `connectors` family has no runtime tool ids, so the
 * user-permission per-tool loop is a no-op for it. Connector access is
 * effectively gated only on agent ∩ talk-active (no per-tool user check).
 *
 * The ALWAYS_ALLOWED bypass (agent-router.ts:137) layers ABOVE this result —
 * tools in that set are NEVER filtered out by this function, since this
 * function returns family-level enabled flags and the bypass applies after
 * the tool-list is assembled downstream.
 */
export async function getEffectiveToolsForAgent(
  agentId: string,
  opts?: {
    talkId?: string;
    activeFamilies?: Record<string, boolean>;
  },
): Promise<EffectiveToolAccess[]> {
  const agent = await getRegisteredAgent(agentId);
  if (!agent) return [];

  const agentPermissions = agent.tool_permissions_json;
  const userPermissions = await listUserToolPermissions();
  const userPermissionMap = new Map(userPermissions.map((p) => [p.toolId, p]));

  const talkActive = await resolveActiveFamilies(opts);

  const result: EffectiveToolAccess[] = [];
  for (const [family, tools] of Object.entries(TOOL_FAMILY_MAP)) {
    const agentEnabled = agentPermissions[family] === true;
    const runtimeTools = tools.length > 0 ? [...tools] : [];

    // Agent ∩ talk active. When talkActive is null the call is settings-side
    // (no Talk context) and the intersection collapses to agentEnabled.
    const talkEnabled =
      talkActive === null ? true : talkActive[family] === true;
    let enabled = agentEnabled && talkEnabled;
    let requiresApproval = false;
    if (enabled && runtimeTools.length > 0) {
      for (const tool of runtimeTools) {
        const userPerm = userPermissionMap.get(tool);
        if (userPerm && !userPerm.allowed) {
          enabled = false;
          break;
        }
        if (userPerm && userPerm.requiresApproval) {
          requiresApproval = true;
        }
      }
    }
    result.push({
      toolFamily: family,
      runtimeTools,
      enabled,
      requiresApproval,
    });
  }
  return result;
}

async function resolveActiveFamilies(opts?: {
  talkId?: string;
  activeFamilies?: Record<string, boolean>;
}): Promise<Record<string, boolean> | null> {
  // Explicit snapshot wins (queue consumer reading enqueued message).
  if (opts?.activeFamilies !== undefined) return opts.activeFamilies;
  if (!opts?.talkId) return null;
  const db = getDbPg();
  const rows = await db<
    { active_tool_families_json: Record<string, boolean> }[]
  >`
    select active_tool_families_json
    from public.talks
    where id = ${opts.talkId}::uuid
    limit 1
  `;
  if (!rows[0]) return {};
  const raw = rows[0].active_tool_families_json;
  if (!raw || typeof raw !== 'object') return {};
  return raw;
}

// ---------------------------------------------------------------------------
// Message persistence (unified talk_messages table)
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export async function createMessage(input: {
  ownerId: string;
  id?: string;
  talkId?: string | null;
  threadId: string;
  role: MessageRole;
  content: string;
  agentId?: string | null;
  createdBy?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  const db = getDbPg();
  // id defaults to gen_random_uuid() server-side when caller doesn't pass
  // one. Some callers (executor streaming) pre-generate the id to thread
  // through events before insert — preserve that capability.
  if (input.id) {
    await db`
      insert into public.talk_messages
        (id, talk_id, thread_id, owner_id, role, content, agent_id,
         created_by, metadata_json)
      values
        (${input.id}::uuid, ${input.talkId ?? null}::uuid,
         ${input.threadId}::uuid, ${input.ownerId}::uuid, ${input.role},
         ${input.content}, ${input.agentId ?? null}::uuid,
         ${input.createdBy ?? null}::uuid,
         ${input.metadata ? db.json(input.metadata as never) : null})
    `;
  } else {
    await db`
      insert into public.talk_messages
        (talk_id, thread_id, owner_id, role, content, agent_id,
         created_by, metadata_json)
      values
        (${input.talkId ?? null}::uuid, ${input.threadId}::uuid,
         ${input.ownerId}::uuid, ${input.role}, ${input.content},
         ${input.agentId ?? null}::uuid, ${input.createdBy ?? null}::uuid,
         ${input.metadata ? db.json(input.metadata as never) : null})
    `;
  }
}

// ---------------------------------------------------------------------------
// LLM attempt tracking
// ---------------------------------------------------------------------------

export type LlmAttemptStatus = 'success' | 'failed' | 'skipped' | 'cancelled';

export async function createLlmAttempt(input: {
  ownerId: string;
  runId: string;
  talkId?: string | null;
  agentId?: string | null;
  providerId?: string | null;
  modelId: string;
  status: LlmAttemptStatus;
  failureClass?: string | null;
  latencyMs?: number | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCostUsd?: number | null;
}): Promise<number> {
  const db = getDbPg();
  const rows = await db<{ id: number }[]>`
    insert into public.llm_attempts
      (run_id, talk_id, owner_id, agent_id, provider_id, model_id, status,
       failure_class, latency_ms, input_tokens, cached_input_tokens,
       output_tokens, estimated_cost_usd)
    values
      (${input.runId}::uuid, ${input.talkId ?? null}::uuid,
       ${input.ownerId}::uuid, ${input.agentId ?? null}::uuid,
       ${input.providerId ?? null}, ${input.modelId}, ${input.status},
       ${input.failureClass ?? null}, ${input.latencyMs ?? null},
       ${input.inputTokens ?? null}, ${input.cachedInputTokens ?? null},
       ${input.outputTokens ?? null}, ${input.estimatedCostUsd ?? null})
    returning id
  `;
  return rows[0].id;
}
