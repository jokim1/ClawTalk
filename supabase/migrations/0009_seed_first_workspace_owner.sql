-- 0009_seed_first_workspace_owner.sql
--
-- Bootstrap fix: the original schema (0001) defaults `users.role` to
-- 'member', and there's no automatic "first user becomes owner" path
-- in the auth-callback flow. On a single-user workspace that means
-- nobody can manage workspace settings — admin-only UI surfaces
-- (workspace API keys, etc.) are unreachable from the app.
--
-- This migration promotes the earliest-registered user to 'owner' but
-- ONLY when no owner/admin already exists. Idempotent: re-runs are
-- no-ops once an owner is established. Safe on multi-user workspaces
-- because the `not exists` guard prevents accidental promotion.

update public.users
set role = 'owner'
where role = 'member'
  and not exists (
    select 1 from public.users where role in ('owner', 'admin')
  )
  and id = (
    select id from public.users order by created_at asc limit 1
  );
