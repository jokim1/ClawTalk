-- clawtalk Phase 5 PR 2 — relax settings_kv + llm_ttft_stats so they're
-- writable from inside withUserContext (authenticated role).
--
-- Companion to 0003: extends the same posture to the two remaining
-- system-managed tables that the caller swap exercises from the
-- `authenticated` role.
--
-- Posture / precedent set by this migration:
--   - Coarse-grained system tables that aren't per-user data may stay
--     RLS-off and grant insert/update to `authenticated`. The "admin"
--     concept from the sqlite era (a role-string check at the route
--     handler) is gone in the cloud port. Any per-talk or per-user
--     authorization moves to RLS USING/WITH CHECK on the user-scoped
--     tables; system tables that never carried per-user rows in the
--     first place don't need a SECURITY DEFINER escape hatch just to
--     accept telemetry-style writes.
--   - settings_kv is system config (currently used by agent-registry
--     for main/default agent IDs). Granting select+insert+update lets
--     `getSettingValue` / `upsertSettingValue` / `deleteSettingValue`
--     run from inside withUserContext. The route layer decides who is
--     allowed to mutate which keys; the table is just storage.
--   - llm_ttft_stats accumulates per-(provider, model) timing
--     histograms for response-start timeout adaptation. Writes happen
--     mid-stream from llm-client.ts, deep inside withUserContext, and
--     the row keys (provider_id, model_id) are coarse-grained shared
--     state — there's no per-user data leak surface. 0002 already
--     granted select; this adds insert+update.

grant select, insert, update on public.settings_kv to authenticated;

grant insert, update on public.llm_ttft_stats to authenticated;
