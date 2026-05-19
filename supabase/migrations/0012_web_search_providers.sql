-- 0012_web_search_providers.sql
--
-- Web search providers (Tavily, Brave, Firecrawl) — the agent's
-- `web_search` tool routes to whichever provider the user has
-- selected as active. Per-user credentials only (no workspace
-- sharing in v1); each user picks a single active provider.
--
-- Mirrors the llm_providers / llm_provider_secrets shape so the
-- existing encrypted-secret-store and RLS conventions carry over.

-- ─── Catalog (global, system-managed) ──────────────────────────────
create table public.web_search_providers (
  id text primary key,
  name text not null,
  base_url text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

-- ─── Per-user credentials ──────────────────────────────────────────
create table public.web_search_provider_secrets (
  owner_id uuid not null references public.users(id) on delete cascade,
  provider_id text not null references public.web_search_providers(id) on delete cascade,
  enc_key_version integer not null default 1,
  ciphertext text not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, provider_id)
);
alter table public.web_search_provider_secrets enable row level security;

create policy web_search_provider_secrets_owner
  on public.web_search_provider_secrets
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

grant select, insert, update, delete
  on public.web_search_provider_secrets
  to authenticated;

-- ─── Per-user active picker ────────────────────────────────────────
-- Null means "no web search configured yet" — the tool returns a
-- helpful error instead of guessing a provider.
alter table public.users
  add column preferred_web_search_provider_id text
  references public.web_search_providers(id) on delete set null;

-- ─── Seed v1 providers ─────────────────────────────────────────────
insert into public.web_search_providers (id, name, base_url) values
  ('web_search.tavily',    'Tavily',    'https://api.tavily.com'),
  ('web_search.brave',     'Brave Search', 'https://api.search.brave.com'),
  ('web_search.firecrawl', 'Firecrawl', 'https://api.firecrawl.dev')
on conflict (id) do update set
  name = excluded.name,
  base_url = excluded.base_url,
  updated_at = now();
