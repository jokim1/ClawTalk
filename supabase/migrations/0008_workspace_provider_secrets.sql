-- 0008_workspace_provider_secrets.sql
--
-- Workspace-shared API credentials. Today every user must add their own
-- per-provider API key in `llm_provider_secrets`. This migration adds a
-- second table that holds keys owned by the workspace itself — admins
-- set them once and every member can execute against them.
--
-- Precedence (enforced at the application layer in execution-planner
-- and verifyProviderSecret): personal key > workspace key > env var.
--
-- RLS shape:
--   - SELECT: any authenticated user, so the executor can pick the key
--     up regardless of which member triggered the run.
--   - INSERT/UPDATE/DELETE: only owner/admin roles. We check this via a
--     SECURITY DEFINER helper because the policy expression can't
--     itself read `public.users` (RLS-protected on that table).

create or replace function public.current_user_is_workspace_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role in ('owner', 'admin')
     from public.users
     where id = auth.uid()),
    false
  );
$$;

revoke all on function public.current_user_is_workspace_admin() from public;
grant execute on function public.current_user_is_workspace_admin()
  to authenticated;

-- ── Workspace-shared API key storage ───────────────────────────────
create table public.workspace_provider_secrets (
  provider_id text primary key
    references public.llm_providers(id) on delete cascade,
  enc_key_version integer not null default 1,
  ciphertext text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null
);
alter table public.workspace_provider_secrets enable row level security;

create policy workspace_provider_secrets_read
  on public.workspace_provider_secrets
  for select to authenticated
  using (true);

create policy workspace_provider_secrets_write
  on public.workspace_provider_secrets
  for all to authenticated
  using (public.current_user_is_workspace_admin())
  with check (public.current_user_is_workspace_admin());

grant select, insert, update, delete
  on public.workspace_provider_secrets
  to authenticated;

-- ── Workspace credential verification status ──────────────────────
-- Mirrors `llm_provider_verifications` but for the workspace row.
create table public.workspace_provider_verifications (
  provider_id text primary key
    references public.llm_providers(id) on delete cascade,
  status text not null
    check (status in (
      'missing', 'not_verified', 'verifying',
      'verified', 'invalid', 'unavailable'
    )),
  last_verified_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
alter table public.workspace_provider_verifications enable row level security;

create policy workspace_provider_verifications_read
  on public.workspace_provider_verifications
  for select to authenticated
  using (true);

create policy workspace_provider_verifications_write
  on public.workspace_provider_verifications
  for all to authenticated
  using (public.current_user_is_workspace_admin())
  with check (public.current_user_is_workspace_admin());

grant select, insert, update, delete
  on public.workspace_provider_verifications
  to authenticated;
