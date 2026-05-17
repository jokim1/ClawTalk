-- 0010_oauth_subscription_credentials.sql
--
-- Adds OAuth-subscription credential support for Anthropic (Claude
-- Pro/Max) and OpenAI Codex (ChatGPT Plus/Pro). Both flows store an
-- access_token + refresh_token + expires_at; the access token is
-- short-lived and gets refreshed lazily on read.
--
-- Precedence model unchanged from PR #327: personal > workspace > env.
-- A user can hold BOTH `api_key` and `subscription` credentials for the
-- same provider — the resolver picks whichever the active agent /
-- request asks for (default: api_key first, fall back to subscription).
--
-- New PKCE/device-code state table covers both flow shapes:
-- - Anthropic: web PKCE flow with user pasting a `{code}#{state}` blob
--   from console.anthropic.com back into the UI.
-- - OpenAI Codex: device-code flow where the backend polls
--   auth.openai.com until the user signs in on a separate device.

-- ── llm_provider_secrets gains credential_kind + OAuth fields ──────
alter table public.llm_provider_secrets
  add column credential_kind text not null default 'api_key'
    check (credential_kind in ('api_key', 'subscription')),
  add column encrypted_refresh_token text,
  add column expires_at timestamptz;

alter table public.llm_provider_secrets
  drop constraint llm_provider_secrets_pkey;

alter table public.llm_provider_secrets
  add constraint llm_provider_secrets_pkey
    primary key (owner_id, provider_id, credential_kind);

-- Same shape for workspace-scoped secrets.
alter table public.workspace_provider_secrets
  add column credential_kind text not null default 'api_key'
    check (credential_kind in ('api_key', 'subscription')),
  add column encrypted_refresh_token text,
  add column expires_at timestamptz;

alter table public.workspace_provider_secrets
  drop constraint workspace_provider_secrets_pkey;

alter table public.workspace_provider_secrets
  add constraint workspace_provider_secrets_pkey
    primary key (provider_id, credential_kind);

-- ── Verification rows: separate status per credential kind ─────────
alter table public.llm_provider_verifications
  add column credential_kind text not null default 'api_key'
    check (credential_kind in ('api_key', 'subscription'));

alter table public.llm_provider_verifications
  drop constraint llm_provider_verifications_pkey;

alter table public.llm_provider_verifications
  add constraint llm_provider_verifications_pkey
    primary key (owner_id, provider_id, credential_kind);

alter table public.workspace_provider_verifications
  add column credential_kind text not null default 'api_key'
    check (credential_kind in ('api_key', 'subscription'));

alter table public.workspace_provider_verifications
  drop constraint workspace_provider_verifications_pkey;

alter table public.workspace_provider_verifications
  add constraint workspace_provider_verifications_pkey
    primary key (provider_id, credential_kind);

-- ── OAuth state table (per-user) ───────────────────────────────────
-- One row per in-flight OAuth attempt. Cleaned up by `consumed_at` and
-- the natural expires_at horizon (~10 min). Carries both PKCE
-- (code_verifier + state) and device-code (device_auth_id + user_code)
-- shapes; flow_kind disambiguates.
create table public.provider_oauth_states (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null
    references public.llm_providers(id) on delete cascade,
  scope text not null
    check (scope in ('user', 'workspace')),
  flow_kind text not null
    check (flow_kind in ('pkce', 'device_code')),
  state text not null,
  user_id uuid not null
    references public.users(id) on delete cascade,
  code_verifier text,
  device_auth_id text,
  user_code text,
  return_path text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider_id, state)
);

create index provider_oauth_states_user_idx
  on public.provider_oauth_states (user_id, created_at desc);
create index provider_oauth_states_expires_idx
  on public.provider_oauth_states (provider_id, expires_at desc);

alter table public.provider_oauth_states enable row level security;

create policy provider_oauth_states_owner on public.provider_oauth_states
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete
  on public.provider_oauth_states
  to authenticated;

-- ── Repurpose provider.openai_codex for ChatGPT subscription ───────
-- The original provider.openai_codex row was a chassis-era host-login
-- provider (base_url `codex://host-runtime`, never reachable from a
-- Worker). We replace it with the live ChatGPT Codex backend so users
-- can connect a Plus/Pro subscription via the device-code flow.
insert into public.llm_providers (
  id, name, provider_kind, api_format, base_url, auth_scheme,
  enabled, response_start_timeout_ms, stream_idle_timeout_ms,
  absolute_timeout_ms
) values (
  'provider.openai_codex',
  'ChatGPT Codex (Subscription)',
  'openai',
  'openai_chat_completions',
  'https://chatgpt.com/backend-api/codex',
  'bearer',
  true,
  120000,
  60000,
  1800000
)
on conflict (id) do update set
  name = excluded.name,
  provider_kind = excluded.provider_kind,
  api_format = excluded.api_format,
  base_url = excluded.base_url,
  auth_scheme = excluded.auth_scheme,
  enabled = excluded.enabled,
  response_start_timeout_ms = excluded.response_start_timeout_ms,
  stream_idle_timeout_ms = excluded.stream_idle_timeout_ms,
  absolute_timeout_ms = excluded.absolute_timeout_ms,
  updated_at = now();

insert into public.llm_provider_models (
  provider_id, model_id, display_name, context_window_tokens,
  default_max_output_tokens, default_ttft_timeout_ms, enabled
) values
  ('provider.openai_codex', 'gpt-5.4', 'GPT-5.4',
   128000, 8192, 60000, true),
  ('provider.openai_codex', 'gpt-5.3-codex', 'GPT-5.3 Codex',
   400000, 128000, 45000, true)
on conflict (provider_id, model_id) do update set
  display_name = excluded.display_name,
  context_window_tokens = excluded.context_window_tokens,
  default_max_output_tokens = excluded.default_max_output_tokens,
  default_ttft_timeout_ms = excluded.default_ttft_timeout_ms,
  enabled = excluded.enabled,
  updated_at = now();
