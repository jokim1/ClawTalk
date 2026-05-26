-- 0031_talk_active_tool_families.sql
--
-- Talk-scoped tool toggles (plan:
-- currently-we-have-agents-squishy-dragon.md). Splits "what an agent
-- CAN use" (registered_agents.tool_permissions_json — capability
-- ceiling) from "what's ON right now" (talks.active_tool_families_json
-- — toggleable per Talk).
--
-- Effective per-turn tool set =
--   ALWAYS_ALLOWED_CONTEXT_TOOLS
--     ∪ (agent_capability ∩ talk_active ∩ user_permission)
--
-- The column stores `Record<string, boolean>` keyed by family slug
-- (same vocabulary as TOOL_FAMILY_MAP in
-- src/clawtalk/db/agent-accessors.ts). `{}` means "nothing active
-- beyond the always-allowed bypass"; `{"web": true}` activates the
-- web family.
--
-- RLS: column inherits the existing `talks_owner` / `talk_runs_owner`
-- row policies (supabase/migrations/0002_rls_policies.sql). No
-- separate policy.

alter table public.talks
  add column active_tool_families_json jsonb not null default '{}'::jsonb;

-- Per-run snapshot of the active set captured at run-creation time. The
-- queue consumer reads from this column instead of live state so a user
-- toggling between two agents in the same response group doesn't change
-- tools mid-response. Nullable for backward-compat with rows created
-- before this column existed; consumers fall back to live read when
-- null.
alter table public.talk_runs
  add column active_tool_families_snapshot jsonb;

-- Backfill: for each existing Talk, set the active set to the union of
-- its assigned agents' enabled families. Talks with zero agents (or
-- whose agents have no enabled families) keep the `'{}'::jsonb`
-- default, which is the correct behaviour — the chip bar is empty
-- until an agent is added.
with talk_families as (
  select distinct ta.talk_id, kv.key as family
  from public.talk_agents ta
  join public.registered_agents ra on ra.id = ta.registered_agent_id
  cross join lateral jsonb_each(ra.tool_permissions_json) as kv
  where kv.value = 'true'::jsonb
),
talk_unions as (
  select talk_id, jsonb_object_agg(family, true) as active
  from talk_families
  group by talk_id
)
update public.talks t
set active_tool_families_json = tu.active
from talk_unions tu
where tu.talk_id = t.id;
