-- 0037_drop_agent_tool_permissions.sql
--
-- Tools become a property of the Talk only. The per-agent capability ceiling
-- (registered_agents.tool_permissions_json, added in 0001) is removed: the
-- effective per-turn set is now
--   talkActive ∩ (family is light) ∩ user_permission
-- with no per-agent layer. The Talk chip bar
-- (talks.active_tool_families_json, added in 0031) is the single editing
-- surface. Resolves the confusing two-surface (agent ceiling ∩ Talk chip)
-- model.
--
-- Heavy families (shell/filesystem/browser) no longer execute — the Claude
-- container chassis is gone — and are dropped from the chip bar, so we also
-- strip those now-inert keys from existing Talk rows. Existing LIGHT toggles
-- are preserved: no active Talk loses a working tool (0031 backfilled the set
-- from the old agent union, which included the dead heavy keys).
--
-- RLS: no policy change. registered_agents / talks keep their existing
-- owner-scoped policies (0002_rls_policies.sql).
--
-- Revert: re-add the column with
--   alter table public.registered_agents
--     add column tool_permissions_json jsonb not null default '{}'::jsonb;
-- Old per-agent values are unrecoverable (acceptable — sole-user repo, no
-- data-preservation requirement per CLAUDE.md). The heavy-key strip below is
-- likewise not reversible, but those keys were inert.

-- Drop the per-agent tool ceiling; tools are now a property of the Talk.
-- `if exists` matches the repo's drop-column convention (0015, 0024) for
-- replay/idempotency parity.
alter table public.registered_agents
  drop column if exists tool_permissions_json;

-- D7: strip now-dead heavy keys from existing Talks; preserve light toggles.
update public.talks
set active_tool_families_json =
  active_tool_families_json - 'shell' - 'filesystem' - 'browser'
where active_tool_families_json ?| array['shell', 'filesystem', 'browser'];
