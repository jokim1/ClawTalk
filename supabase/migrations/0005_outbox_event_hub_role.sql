-- clawtalk W7-evtsse — dedicated Postgres LOGIN role for the
-- UserEventHub Durable Object.
--
-- The DO reads `event_outbox` via this narrowly-scoped role
-- (`clawtalk_event_hub`) instead of `authenticated`. Two reasons:
--
--   1. RLS-off tables read via `authenticated` would surface to ANY
--      logged-in user that gets a JWT. A dedicated role narrows the
--      blast radius if the DO's connection string ever leaks.
--   2. Migration 0006 (applied AFTER the DO is verified working in
--      production) revokes `SELECT ON event_outbox FROM authenticated`
--      so the only path that reads the outbox is the DO.
--
-- IMPORTANT: this migration creates the role but DOES NOT set a
-- password — the password is set out-of-band via the Supabase
-- dashboard (Database → Roles) or by running
--
--   ALTER ROLE clawtalk_event_hub PASSWORD '<secret>';
--
-- as a superuser. After setting the password, the wrangler secret
-- DB_EVENT_HUB_URL is set with the full connection string:
--
--   postgres://clawtalk_event_hub:<password>@<host>:<port>/postgres
--
-- The predeploy gate (`scripts/verify-deploy-secrets.sh`) blocks
-- migration 0006 from applying if DB_EVENT_HUB_URL is unset.
--
-- The role itself has only `LOGIN` and `SELECT ON event_outbox`. It
-- intentionally does NOT have BYPASSRLS — event_outbox is RLS-off so
-- BYPASSRLS is unnecessary, and the principle of least authority is
-- worth preserving for future schema additions.

do $$
begin
  if not exists (
    select 1 from pg_roles where rolname = 'clawtalk_event_hub'
  ) then
    create role clawtalk_event_hub with login;
  end if;
end$$;

grant select on public.event_outbox to clawtalk_event_hub;
