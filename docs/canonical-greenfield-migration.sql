-- canonical-greenfield-migration.sql
--
-- REFERENCE COPY — NOT an active migration. This file does not auto-apply.
-- The executable migration lands in `supabase/migrations/0040_*.sql` (or higher)
-- when the §05 Phase 2–12 src/ rewrite is ready to cut over. Until then, this
-- file is the canonical source for what the greenfield migration looks like.
--
-- Why parked here: this migration drops 37 legacy tables in one CASCADE. The
-- src/ in main currently targets those tables; landing the migration without
-- the matching src/ rewrite breaks every accessor + route + test (verified
-- on 2026-05-30: 38/38 accessor tests fail, 21/30 google-drive tests fail).
-- Per Joseph's call, we hold the migration here as a docs-side reference
-- until impl is ready, rather than ship a broken main.
--
-- Validated against `supabase db reset --local` on 2026-05-30. Verified:
-- 62 final tables (50 greenfield + 12 kept), 2 views, 25 triggers,
-- 4 deferrable back-edge FKs, RLS policies generated for 39 member-write +
-- 8 admin-write tables. Per-test verification:
--   §14 #15 last-tab guard: PASS (rejects with CT001)
--   §14 #19 runs trigger=user invariant: PASS (CHECK rejects job_id)
--   §14 #23 home_inbox_items dedup: PASS (partial unique enforces; NULL ok)
--   Auth-bridge trigger (handle_new_auth_user): PASS after display_name→name
--
-- ClawTalk greenfield rebuild migration.
-- Per docs/05-build-plan.md Phase 1 + docs/11-data-model.md as the canonical schema source of truth.
--
-- This migration:
--   Step 1. Drops every superseded legacy table (§11 §11.1) — 37 tables.
--   Step 2. ALTERs the kept tables (§11 §1 users columns; §11 §4 llm_provider_models.capabilities_json + unique index).
--   Step 3. Defines trigger function bodies + RLS helpers.
--   Step 4. CREATEs the greenfield tables in dependency order (§11 §1–§10) with composite FKs, partial uniques.
--   Step 5. Creates the llm_models view.
--   Step 6. Wires per-table updated_at + business triggers.
--   Step 7. Enables RLS + creates policies per §11 §12.1/§12.2/§12.4.
--
-- Per CLAUDE.md "treat data as disposable", local users/talks/messages/runs/contents are wiped. Joseph's first
-- signin after this migration creates a fresh workspace + owner membership.

begin;

-- =============================================================================
-- STEP 1: Drop superseded legacy tables (§11 §11.1)
-- =============================================================================

drop table if exists
  public.content_edits,
  public.content_proposals,
  public.contents,
  public.talk_state_entries,
  public.talk_resource_bindings,
  public.talk_message_attachments,
  public.talk_outputs,
  public.talk_context_source_pages,
  public.talk_context_sources,
  public.talk_context_source_ref_counter,
  public.talk_context_summary,
  public.talk_context_goal,
  public.talk_context_rules,
  public.talk_channel_links,
  public.talk_data_connector_links,
  public.talk_members,
  public.talk_agents,
  public.talk_jobs,
  public.talk_messages,
  public.talk_runs,
  public.talk_threads,
  public.main_thread_summaries,
  public.main_threads,
  public.agent_fallback_steps,
  public.registered_agents,
  public.workspace_channels,
  public.workspace_data_connectors,
  public.workspace_slack_installs,
  public.user_invites,
  public.user_google_credentials,
  public.google_oauth_link_requests,
  public.oauth_state,
  public.user_tool_permissions,
  public.web_search_provider_secrets,
  public.web_search_providers,
  public.llm_attempts,
  public.talks,
  public.talk_folders
cascade;

-- =============================================================================
-- STEP 2: ALTER kept tables (§11 §1 users; §11 §4 llm_provider_models)
-- =============================================================================

-- Bring the kept users table in line with §11 §1: `(id, email, name, avatar_color, initials, created_at, updated_at)`.
-- The shipped schema has `display_name` (rename to `name`) plus several NanoClaw-era columns (`role`, `is_active`,
-- `last_login_at`, `preferred_web_search_provider_id`) that are superseded by workspace_members.role / RLS / and the
-- greenfield context model. Drop them.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='users' and column_name='display_name')
     and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='users' and column_name='name') then
    alter table public.users rename column display_name to name;
  end if;
end $$;

alter table public.users
  add column if not exists avatar_color text,
  add column if not exists initials text,
  add column if not exists updated_at timestamptz not null default now(),
  drop column if exists role,
  drop column if exists is_active,
  drop column if exists last_login_at,
  drop column if exists preferred_web_search_provider_id;

-- Update the auth-bridge trigger to use the renamed `name` column (it referenced `display_name`).
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, name, created_at)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(coalesce(new.email, ''), '@', 1), 'User'),
    coalesce(new.created_at, now())
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

alter table public.llm_provider_models
  add column if not exists capabilities_json jsonb not null default '{}';

-- Unique index on model_id (single-column) enables FKs from llm_models.id (a view)
-- without requiring the composite (provider_id, model_id) lookup. Assumes model_id
-- is globally unique across providers (true today; collision rejects at discovery time).
create unique index if not exists llm_provider_models_model_id_unique
  on public.llm_provider_models (model_id);

-- =============================================================================
-- STEP 3: Trigger function + RLS helper definitions (§11 §0 / §5 / §8 / §12)
-- =============================================================================

-- 3.1. Universal updated_at toucher (§11 §0)
create or replace function public.tg_touch_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- 3.2. Workspace membership helpers (§11 §12)
-- Use plpgsql (not language sql) so the table reference binds at execution time —
-- workspace_members is created later in this migration.
create or replace function public.is_workspace_member(ws uuid) returns boolean
  language plpgsql stable security definer set search_path = public as $$
declare
  found_row boolean;
begin
  select exists (
    select 1 from public.workspace_members
    where workspace_id = ws and user_id = auth.uid()
  ) into found_row;
  return found_row;
end;
$$;

create or replace function public.is_workspace_admin(ws uuid) returns boolean
  language plpgsql stable security definer set search_path = public as $$
declare
  found_row boolean;
begin
  select exists (
    select 1 from public.workspace_members
    where workspace_id = ws
      and user_id = auth.uid()
      and role in ('owner','admin')
  ) into found_row;
  return found_row;
end;
$$;

-- 3.3. doc_tabs last-tab guard (§11 §5)
create or replace function public.doc_tabs_block_last_delete() returns trigger
  language plpgsql as $$
declare
  remaining int;
begin
  select count(*) into remaining from public.doc_tabs
    where document_id = old.document_id and id <> old.id;
  if remaining = 0 then
    raise exception 'cannot delete the last tab of document %', old.document_id
      using errcode = 'CT001';
  end if;
  return old;
end;
$$;

-- 3.4. document_edits CAS bump on accept (§11 §5)
create or replace function public.document_edits_bump_versions_on_accept() returns trigger
  language plpgsql as $$
begin
  if new.status = 'accepted' and (old.status is distinct from 'accepted') then
    if new.op = 'insert' then
      update public.doc_tabs
        set list_version = list_version + 1
        where id = new.tab_id;
      update public.document_edits
        set status = 'superseded', resolved_at = now()
        where tab_id = new.tab_id
          and op = 'insert'
          and status = 'pending'
          and ((new.after_block_id is null and after_block_id is null)
               or after_block_id = new.after_block_id)
          and id <> new.id;
    elsif new.op in ('replace','delete') then
      update public.doc_blocks
        set version = version + 1
        where id = new.block_id;
      update public.document_edits
        set status = 'superseded', resolved_at = now()
        where block_id = new.block_id
          and op in ('replace','delete')
          and status = 'pending'
          and id <> new.id;
    end if;
    new.resolved_at := coalesce(new.resolved_at, now());
  end if;
  return new;
end;
$$;

-- 3.5. jobs agent-clear → blocked transition (§11 §8)
create or replace function public.set_job_blocked_agent_missing() returns trigger
  language plpgsql as $$
begin
  new.status := 'blocked';
  new.block_reason := 'agent_missing';
  new.next_due_at := null;
  new.claimed_at := null;
  return new;
end;
$$;

-- 3.6. jobs roster-invariant guard (§11 §8)
create or replace function public.jobs_require_agent_in_roster() returns trigger
  language plpgsql as $$
begin
  if new.agent_id is null then
    return new;  -- nullable agent_id is handled by set_job_blocked_agent_missing
  end if;
  perform 1 from public.talk_agents
    where workspace_id = new.workspace_id
      and talk_id = new.talk_id
      and agent_id = new.agent_id;
  if not found then
    raise exception 'job agent % is not in talk_agents for talk %', new.agent_id, new.talk_id
      using errcode = 'CT002';
  end if;
  return new;
end;
$$;

-- =============================================================================
-- STEP 4: Create greenfield tables in dependency order (§11 §1–§10)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- §1 Identity & tenancy
-- ---------------------------------------------------------------------------

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  owner_id uuid not null references public.users(id),
  plan text not null default 'team' check (plan in ('team','enterprise')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id)
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member','guest')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- ---------------------------------------------------------------------------
-- §2 Folders
-- ---------------------------------------------------------------------------

create table public.folders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null,
  sort_order int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create index on public.folders (workspace_id, sort_order);

-- ---------------------------------------------------------------------------
-- §3 Talks (talks first; talk_agents/messages/runs/etc. after §4 agents exist)
-- ---------------------------------------------------------------------------

create table public.talks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  folder_id uuid,
  sort_order int not null,
  title text not null,
  mode text not null default 'ordered' check (mode in ('ordered','parallel')),
  rounds_limit int not null default 3 check (rounds_limit in (1,2,3,5)),
  created_by uuid not null references public.users(id) on delete restrict,
  archived_at timestamptz,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, folder_id) references public.folders(workspace_id, id) on delete set null (folder_id)
);
create index on public.talks (workspace_id, folder_id, sort_order) where archived_at is null;

-- ---------------------------------------------------------------------------
-- §4 Agents (templates, agents, team_compositions, team_composition_agents)
-- ---------------------------------------------------------------------------

create table public.agent_role_templates (
  role_key text primary key
    check (role_key in ('strategist','critic','researcher','editor','quant','forge_rewriter','forge_critic')),
  default_name text not null,
  default_handle text not null,
  default_initials text not null,
  default_accent text not null,
  default_accent_dark text,
  default_model_id text references public.llm_provider_models(model_id),
  default_temperature numeric not null,
  job text not null,
  system_prompt text not null,
  method_default text[] not null,
  version int not null default 1,
  updated_at timestamptz not null default now()
);

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  role_key text not null references public.agent_role_templates(role_key),
  name text not null,
  handle text not null,
  initials text not null,
  accent text not null,
  accent_dark text,
  model_id text not null references public.llm_provider_models(model_id),
  default_model_id text not null references public.llm_provider_models(model_id),
  temperature numeric not null,
  persona text,
  focus text,
  method text[] not null default '{}',
  capabilities text[] not null default '{}',
  is_default boolean not null default false,
  is_custom boolean not null default false,
  is_system boolean not null default false,
  enabled boolean not null default true,
  created_from_template_version int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create index on public.agents (workspace_id) where is_system = false;

create table public.team_compositions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text,
  icon text,
  is_default boolean not null default false,
  runs_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table public.team_composition_agents (
  workspace_id uuid not null,
  team_id uuid not null,
  agent_id uuid not null,
  sort_order int,
  primary key (team_id, agent_id),
  foreign key (workspace_id, team_id)  references public.team_compositions(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_id) references public.agents(workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- §3 Talks continued: talk_agents (now agents exists)
-- ---------------------------------------------------------------------------

create table public.talk_agents (
  workspace_id uuid not null,
  talk_id uuid not null,
  agent_id uuid not null,
  sort_order int not null,
  added_at timestamptz not null default now(),
  primary key (talk_id, agent_id),
  unique (talk_id, sort_order),
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_id) references public.agents(workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- §4 talk_agent_snapshots (per-run frozen roster); referenced by messages.agent_snapshot_id
-- ---------------------------------------------------------------------------

create table public.talk_agent_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  talk_id uuid not null,
  snapshot_group_id uuid not null,
  source_agent_id uuid,
  role_key text not null,
  name text,
  handle text,
  initials text,
  accent text,
  accent_dark text,
  model_id text not null references public.llm_provider_models(model_id),
  temperature numeric not null,
  persona text,
  focus text,
  method text[],
  sort_order int not null,
  role_template_version int,
  global_policy_version int,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, talk_id, id),
  unique (workspace_id, talk_id, snapshot_group_id, id),
  unique (snapshot_group_id, source_agent_id),
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, source_agent_id) references public.agents(workspace_id, id) on delete set null (source_agent_id)
);
create index on public.talk_agent_snapshots (snapshot_group_id);

-- ---------------------------------------------------------------------------
-- §3 messages + runs (mutual references; back-edges deferred)
-- ---------------------------------------------------------------------------

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  talk_id uuid not null,
  round int not null,
  author_kind text not null check (author_kind in ('user','agent')),
  author_user_id uuid references public.users(id) on delete restrict,
  agent_snapshot_id uuid,
  run_id uuid,                                                       -- back-edge; FK added later deferrable
  body text,
  attachments_json jsonb not null default '[]',
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, talk_id, id),
  check (
    (author_kind = 'user'  and author_user_id is not null and agent_snapshot_id is null and run_id is null) or
    (author_kind = 'agent' and author_user_id is null     and agent_snapshot_id is not null and run_id is not null)
  ),
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, talk_id, agent_snapshot_id)
    references public.talk_agent_snapshots(workspace_id, talk_id, id)
);
create index on public.messages (talk_id, round, created_at);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  talk_id uuid not null,
  round int not null,
  run_kind text not null default 'conversation'
    check (run_kind in ('conversation','content_improvement')),
  snapshot_group_id uuid not null,
  agent_snapshot_id uuid not null,
  status text not null default 'queued'
    check (status in ('queued','running','awaiting','completed','failed','cancelled')),
  model_id text not null references public.llm_provider_models(model_id),
  requested_by uuid not null references public.users(id) on delete restrict,
  trigger_message_id uuid,                                           -- back-edge to messages; deferrable
  job_id uuid,                                                       -- forward FK to jobs; added later deferrable (jobs created in §8)
  trigger text not null default 'user' check (trigger in ('user','scheduler','manual')),
  scheduled_for timestamptz,
  response_group_id text not null
    check (length(response_group_id) between 1 and 64),
  sequence_index int not null check (sequence_index >= 0),
  prompt_snapshot_id uuid,                                           -- forward FK to run_prompt_snapshots; deferrable
  tokens_in int,
  tokens_out int,
  error_json jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, talk_id, id),
  check (
    (trigger = 'user'      and job_id is null and scheduled_for is null) or
    (trigger = 'scheduler' and job_id is not null and trigger_message_id is null and prompt_snapshot_id is not null and scheduled_for is not null) or
    (trigger = 'manual'    and job_id is not null and trigger_message_id is null and prompt_snapshot_id is not null and scheduled_for is null)
  ),
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, talk_id, snapshot_group_id, agent_snapshot_id)
    references public.talk_agent_snapshots(workspace_id, talk_id, snapshot_group_id, id)
);
create index on public.runs (talk_id, round);
create index on public.runs (status) where status in ('queued','running');
create index on public.runs (response_group_id, sequence_index);
create index on public.runs (job_id, created_at);

-- Partial unique: single-flight per job (one non-terminal run per job at a time)
create unique index runs_one_active_per_job
  on public.runs (job_id) where job_id is not null and status in ('queued','running','awaiting');

-- Partial unique: slot identity per (job, scheduled_for); prevents double-fire
create unique index runs_one_per_job_slot
  on public.runs (job_id, scheduled_for) where job_id is not null and scheduled_for is not null;

-- Back-edge FKs (deferrable) for cycles
alter table public.messages
  add constraint messages_run_id_fkey
  foreign key (workspace_id, talk_id, run_id)
  references public.runs(workspace_id, talk_id, id)
  deferrable initially deferred;

alter table public.runs
  add constraint runs_trigger_message_id_fkey
  foreign key (workspace_id, talk_id, trigger_message_id)
  references public.messages(workspace_id, talk_id, id)
  deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- §4 run_prompt_snapshots (one per run); back-edge to runs.prompt_snapshot_id deferred
-- ---------------------------------------------------------------------------

create table public.run_prompt_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id uuid not null,
  talk_id uuid not null,
  agent_snapshot_id uuid not null,
  model_id text not null references public.llm_provider_models(model_id),
  provider text not null,
  global_policy_version int,
  role_template_version int,
  prompt_assembly_version int,
  context_manifest_json jsonb,
  tool_manifest_json jsonb,
  prompt_hash text,
  prompt_text_redacted text,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, run_id),
  foreign key (workspace_id, run_id) references public.runs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_snapshot_id) references public.talk_agent_snapshots(workspace_id, id)
);

alter table public.runs
  add constraint runs_prompt_snapshot_id_fkey
  foreign key (workspace_id, prompt_snapshot_id)
  references public.run_prompt_snapshots(workspace_id, id)
  deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- §3 talk_reads (per-user read state)
-- ---------------------------------------------------------------------------

create table public.talk_reads (
  workspace_id uuid not null,
  talk_id uuid not null,
  user_id uuid not null,
  last_read_at timestamptz not null default now(),
  primary key (talk_id, user_id),
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id) references public.workspace_members(workspace_id, user_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- §4 agent_feedback_events
-- ---------------------------------------------------------------------------

create table public.agent_feedback_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  agent_id uuid,
  talk_id uuid,
  message_id uuid,
  kind text not null
    check (kind in ('useful','not_useful','too_verbose','off_role','missed_evidence','wrong_model','accepted_doc_edit','rejected_doc_edit','user_referenced_agent')),
  actor_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, agent_id)   references public.agents(workspace_id, id)   on delete cascade,
  foreign key (workspace_id, talk_id)    references public.talks(workspace_id, id)    on delete cascade,
  foreign key (workspace_id, message_id) references public.messages(workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- §4 llm_models view (over llm_provider_models)
-- ---------------------------------------------------------------------------

create view public.llm_models as
  select
    model_id              as id,
    provider_id           as provider,
    display_name,
    enabled,
    capabilities_json
  from public.llm_provider_models;

-- ---------------------------------------------------------------------------
-- §5 Documents (tabs, blocks, edits, coeditors)
-- ---------------------------------------------------------------------------

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  primary_talk_id uuid,
  folder_id uuid,
  title text not null,
  format text not null check (format in ('markdown','html')),
  word_count int not null default 0,
  last_edit_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, primary_talk_id) references public.talks(workspace_id, id) on delete set null (primary_talk_id),
  foreign key (workspace_id, folder_id) references public.folders(workspace_id, id) on delete set null (folder_id)
);
create unique index on public.documents (primary_talk_id) where primary_talk_id is not null;

create table public.doc_tabs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  title text not null,
  sort_order int not null,
  list_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, sort_order),
  unique (workspace_id, id),
  unique (workspace_id, document_id, id),
  foreign key (workspace_id, document_id) references public.documents(workspace_id, id) on delete cascade
);

create table public.doc_blocks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  tab_id uuid not null,
  sort_order int not null,
  version int not null default 1,
  kind text not null check (kind in ('h1','h2','p','li','meta','code')),
  text text not null default '',
  attrs_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tab_id, sort_order),
  unique (workspace_id, id),
  unique (workspace_id, document_id, id),
  unique (workspace_id, document_id, tab_id, id),
  foreign key (workspace_id, document_id, tab_id)
    references public.doc_tabs(workspace_id, document_id, id) on delete cascade
);
create index on public.doc_blocks (tab_id, sort_order);
create index on public.doc_blocks (document_id);

create table public.document_edits (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  tab_id uuid not null,
  block_id uuid,
  base_block_version int,
  base_list_version int,
  after_block_id uuid,
  proposed_by_agent_id uuid,
  proposed_by_run_id uuid,
  op text not null check (op in ('insert','replace','delete')),
  new_kind text,
  new_text text,
  new_attrs_json jsonb,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','superseded')),
  source text not null default 'agent' check (source in ('agent','forge','job')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check (
    (op = 'insert'  and block_id is null     and base_list_version  is not null and new_kind is not null and new_text is not null) or
    (op = 'replace' and block_id is not null and base_block_version is not null and new_text is not null) or
    (op = 'delete'  and block_id is not null and base_block_version is not null)
  ),
  foreign key (workspace_id, document_id) references public.documents(workspace_id, id) on delete cascade,
  foreign key (workspace_id, document_id, tab_id) references public.doc_tabs(workspace_id, document_id, id) on delete cascade,
  foreign key (workspace_id, document_id, tab_id, block_id)
    references public.doc_blocks(workspace_id, document_id, tab_id, id) on delete cascade,
  foreign key (workspace_id, document_id, tab_id, after_block_id)
    references public.doc_blocks(workspace_id, document_id, tab_id, id) on delete cascade,
  foreign key (workspace_id, proposed_by_agent_id) references public.agents(workspace_id, id) on delete set null (proposed_by_agent_id),
  foreign key (workspace_id, proposed_by_run_id) references public.runs(workspace_id, id) on delete set null (proposed_by_run_id)
);
create index on public.document_edits (document_id) where status = 'pending';

create table public.doc_tab_coeditors (
  workspace_id uuid not null,
  tab_id uuid not null,
  agent_id uuid not null,
  primary key (tab_id, agent_id),
  foreign key (workspace_id, tab_id) references public.doc_tabs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_id) references public.agents(workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- §6 Context, tools, connectors
-- ---------------------------------------------------------------------------

create table public.context_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  talk_id uuid not null,
  kind text not null check (kind in ('document','url','file','past_talk','rule','news')),
  name text not null,
  source_document_id uuid,
  source_talk_id uuid,
  payload_ref text,
  extracted_text text,
  summary text,
  meta_json jsonb not null default '{}',
  expected_page_count int,                     -- PDF page-rasterization: # page images expected; completeness = count(context_source_pages) = this. null for non-PDFs.
  include_in_prompt boolean not null default true,
  sort_order int,
  added_by_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (kind = 'document'  and source_document_id is not null and source_talk_id is null) or
    (kind = 'past_talk' and source_talk_id is not null     and source_document_id is null) or
    (kind in ('url','file','rule','news') and source_document_id is null and source_talk_id is null)
  ),
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, source_document_id) references public.documents(workspace_id, id) on delete cascade,
  foreign key (workspace_id, source_talk_id) references public.talks(workspace_id, id) on delete cascade,
  unique (workspace_id, id)
);

-- PDF page-rasterization: one row per page JPEG for vision-but-not-PDF models
-- (gpt-5-mini, gemini-2.5-flash, kimi-k2.6). Attached alongside extracted_text
-- (raster is pixels-only; the text keeps exact quotes). Per `11` §6 design note.
create table public.context_source_pages (
  workspace_id uuid not null,
  source_id uuid not null,
  page_index int not null check (page_index >= 0),
  byte_size int not null check (byte_size >= 0),
  payload_ref text not null,                   -- R2 key: attachments/{talk_id}/{source_id}/page-{page_index}.jpg
  created_at timestamptz not null default now(),
  primary key (source_id, page_index),
  foreign key (workspace_id, source_id) references public.context_sources(workspace_id, id) on delete cascade
);

create table public.talk_tools (
  workspace_id uuid not null,
  talk_id uuid not null,
  tool_id text not null,
  enabled boolean not null default false,
  primary key (talk_id, tool_id),
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade
);

create table public.connector_secrets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  enc_key_version int not null default 1,
  ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table public.connectors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  service text not null check (service in ('slack','gdrive','gmail','linear','github','notion')),
  authorized boolean not null default false,
  authorized_at timestamptz,
  secret_ref uuid,
  config_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, secret_ref) references public.connector_secrets(workspace_id, id) on delete set null (secret_ref)
);

create table public.connector_bindings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  connector_id uuid not null,
  talk_id uuid not null,
  target text,
  scope text[] not null default '{}',
  enabled boolean not null default true,
  unique (connector_id, talk_id),
  foreign key (workspace_id, connector_id) references public.connectors(workspace_id, id) on delete cascade,
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- §8 Jobs (before §7 home_inbox_items which references jobs)
-- ---------------------------------------------------------------------------

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  talk_id uuid not null,
  created_by uuid not null references public.users(id) on delete restrict,
  title text not null,
  prompt text not null,
  agent_id uuid,
  schedule_json jsonb not null,
  timezone text not null,
  emit_talk_message bool not null default true,
  emit_document_append bool not null default false,
  check (emit_talk_message or emit_document_append),
  source_scope_json jsonb not null default '{"allow_web":false,"tool_ids":[]}',
  status text not null default 'active' check (status in ('active','paused','blocked')),
  block_reason text
    check (block_reason is null or block_reason in ('agent_missing','model_disabled','no_primary_document','tool_not_enabled','connector_not_authorized')),
  catch_up text not null default 'skip' check (catch_up in ('skip','run_once')),
  next_due_at timestamptz,
  claimed_at timestamptz,
  archived_at timestamptz,
  last_run_at timestamptz,
  last_run_status text check (last_run_status is null or last_run_status in ('completed','failed')),
  run_count int not null default 0 check (run_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (archived_at is not null) or
    (status = 'active' and next_due_at is not null) or
    (status in ('paused','blocked') and next_due_at is null)
  ),
  unique (workspace_id, id),
  foreign key (workspace_id, talk_id)  references public.talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_id) references public.agents(workspace_id, id) on delete set null (agent_id)
);
create index on public.jobs (status, next_due_at) where status = 'active' and archived_at is null;

-- Now wire runs.job_id FK (jobs exists)
alter table public.runs
  add constraint runs_job_id_fkey
  foreign key (workspace_id, job_id) references public.jobs(workspace_id, id) on delete restrict;

-- RLS-preserving view for active jobs hot path
create view public.jobs_active with (security_invoker = true) as
  select * from public.jobs where archived_at is null;

-- ---------------------------------------------------------------------------
-- §7 Home (activity_events, home_inbox_items, recommendations, news, ranking, algorithms)
-- ---------------------------------------------------------------------------

create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_type text not null check (actor_type in ('user','agent','system','scheduler')),
  actor_id uuid,
  event_type text not null,
  talk_id uuid,
  document_id uuid,
  run_id uuid,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (workspace_id, talk_id)     references public.talks(workspace_id, id)     on delete cascade,
  foreign key (workspace_id, document_id) references public.documents(workspace_id, id) on delete cascade,
  foreign key (workspace_id, run_id)      references public.runs(workspace_id, id)      on delete cascade
);
create index on public.activity_events (workspace_id, created_at desc);

-- home_news_items: shared global pool — NO workspace_id
create table public.home_news_items (
  id uuid primary key default gen_random_uuid(),
  canonical_url text not null,
  title text not null,
  source text,
  source_domain text,
  published_at timestamptz,
  excerpt text,
  raw_provider_json jsonb,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (content_hash)
);
create index on public.home_news_items (published_at desc);

create table public.home_news_topics (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  talk_id uuid not null,
  summary text not null,
  mode text not null check (mode in ('work_context','topic_feed','balanced')),
  decision_type text not null check (decision_type in ('pricing','launch','research','hiring','product','technical','market','other')),
  keywords_json jsonb not null default '[]',
  entities_json jsonb not null default '[]',
  source_domains_json jsonb not null default '[]',
  negative_terms_json jsonb not null default '[]',
  freshness_horizon_days int not null default 14,
  sensitivity text not null default 'normal' check (sensitivity in ('normal','private','do_not_search')),
  confidence numeric,
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete cascade
);

create table public.home_news_matches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  news_item_id uuid not null references public.home_news_items(id) on delete cascade,
  topic_id uuid not null,
  talk_id uuid not null,
  matched_on_json jsonb not null default '{}',
  impact text not null check (impact in ('changes_assumption','adds_evidence','updates_competitor','introduces_risk','provides_tactic','topic_update','community_signal','background_only')),
  why_it_matters text,
  score numeric,
  confidence numeric,
  status text not null default 'active' check (status in ('active','snoozed','added_to_context','not_relevant','expired')),
  algorithm_version text,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, topic_id) references public.home_news_topics(workspace_id, id) on delete cascade,
  foreign key (workspace_id, talk_id)  references public.talks(workspace_id, id)             on delete cascade,
  unique (workspace_id, news_item_id, topic_id)
);
create index on public.home_news_matches (workspace_id, status, score desc);

create table public.home_inbox_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  type text not null check (type in (
    'agent_replied','round_completed','agent_asks_user','run_failed','doc_edits_ready',
    'connector_needs_auth','news_context_added','long_running_run','system_limit_reached',
    'forge_run_needs_review','job_output_ready','job_blocked'
  )),
  target_kind text check (target_kind in ('talk','document','connector','news','job','system')),
  target_json jsonb not null default '{}',
  talk_id uuid,
  document_id uuid,
  run_id uuid,
  tab_id uuid,
  news_item_id uuid,
  connector_id uuid,
  job_id uuid,
  ref_id uuid,
  severity text not null check (severity in ('info','action','blocking')),
  status text not null default 'unread' check (status in ('unread','read','resolved','dismissed','snoozed','expired')),
  title text not null,
  summary text,
  reason text,
  primary_action_json jsonb,
  secondary_actions_json jsonb not null default '[]',
  source_event_ids_json jsonb not null default '[]',
  group_key text,
  score numeric,
  algorithm_version text,
  snoozed_until timestamptz,
  resolved_at timestamptz,
  due_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, talk_id)     references public.talks(workspace_id, id)     on delete cascade,
  foreign key (workspace_id, document_id) references public.documents(workspace_id, id) on delete cascade,
  foreign key (workspace_id, run_id)      references public.runs(workspace_id, id)      on delete cascade,
  foreign key (workspace_id, document_id, tab_id)
    references public.doc_tabs(workspace_id, document_id, id) on delete cascade,
  foreign key (workspace_id, connector_id) references public.connectors(workspace_id, id) on delete cascade,
  foreign key (workspace_id, job_id)       references public.jobs(workspace_id, id)       on delete restrict,
  foreign key (news_item_id)               references public.home_news_items(id)           on delete cascade
);
create unique index home_inbox_items_dedup
  on public.home_inbox_items (workspace_id, type, ref_id) where ref_id is not null;
create index on public.home_inbox_items (workspace_id, status, created_at desc);

create table public.home_recommendation_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in (
    'setup','failed-run','unresolved','synthesis','pending-edit','doc','cross-link','tool',
    'news-context','agent-change','recap','archive-cleanup','forge-suggestion','job','prompt-suggestion'
  )),
  state_fingerprint text not null,
  provenance_json jsonb not null default '{}',
  action_json jsonb not null default '{}',
  features_json jsonb not null default '{}',
  confidence numeric,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (workspace_id, kind, state_fingerprint)
);

create table public.home_recommendations (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.home_recommendation_candidates(id) on delete set null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in (
    'setup','failed-run','unresolved','synthesis','pending-edit','doc','cross-link','tool',
    'news-context','agent-change','recap','archive-cleanup','forge-suggestion','job','prompt-suggestion'
  )),
  title text not null,
  why text,
  priority text not null check (priority in ('decide','improve','tidy')),
  score numeric,
  rank int,
  surface text not null default 'recommendations' check (surface in ('recommendations','news','inbox','search')),
  status text not null default 'active' check (status in ('active','dismissed','completed','expired','snoozed')),
  algorithm_version text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (workspace_id, id)
);
create index on public.home_recommendations (workspace_id, status, surface, rank);

create table public.home_recommendation_events (
  id bigserial primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  recommendation_id uuid not null references public.home_recommendations(id) on delete cascade,
  event_type text not null check (event_type in ('surfaced','clicked','dismissed','completed','expired')),
  position int,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on public.home_recommendation_events (workspace_id, created_at desc);

create table public.home_interaction_events (
  id bigserial primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  surface text not null check (surface in ('recommendations','news','inbox','search')),
  item_id uuid,
  event_type text not null,
  rank int,
  algorithm_version text,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on public.home_interaction_events (workspace_id, surface, created_at desc);

create table public.home_ranking_profiles (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  version int not null default 1,
  recommendation_kind_weights_json jsonb not null default '{}',
  recommendation_action_weights_json jsonb not null default '{}',
  news_source_weights_json jsonb not null default '{}',
  news_topic_weights_json jsonb not null default '{}',
  inbox_type_weights_json jsonb not null default '{}',
  cleanup_aggressiveness numeric not null default 0.5,
  novelty_preference numeric not null default 0.5,
  source_diversity_preference numeric not null default 0.5,
  news_exploration_rate numeric not null default 0.1,
  news_initial_page_size int not null default 8,
  news_next_page_size int not null default 6,
  news_target_pool_size int not null default 24,
  news_max_session_cards int not null default 40,
  news_mode_by_talk_id_json jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table public.home_optimization_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  surface text not null check (surface in ('recommendations','news','inbox','search')),
  status text not null default 'draft' check (status in ('draft','pending_review','accepted','rejected','applied')),
  problem_statement text not null,
  evidence_json jsonb not null default '{}',
  proposed_change text not null,
  affected_parameters_json jsonb not null default '{}',
  risk text not null default 'low' check (risk in ('low','medium','high')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table public.home_algorithm_versions (
  id uuid primary key default gen_random_uuid(),
  surface text not null check (surface in ('recommendations','news','inbox','search')),
  status text not null default 'draft' check (status in ('draft','staging','active','paused','retired')),
  description text,
  config_json jsonb not null default '{}',
  config_hash text not null,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  retired_at timestamptz,
  unique (surface, config_hash)
);

create table public.home_algorithm_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  surface text not null check (surface in ('recommendations','news','inbox','search')),
  algorithm_version_id uuid not null references public.home_algorithm_versions(id) on delete cascade,
  assignment_reason text not null check (assignment_reason in ('rollout','staging','control','experiment','forced')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (workspace_id, surface, ended_at)
);
create index on public.home_algorithm_assignments (algorithm_version_id);

create table public.home_activation_state (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  has_provider_access boolean not null default false,
  has_created_talk boolean not null default false,
  has_selected_team_or_agents boolean not null default false,
  has_sent_prompt boolean not null default false,
  has_completed_agent_run boolean not null default false,
  has_created_or_linked_document boolean not null default false,
  has_customized_agent boolean not null default false,
  has_added_context_or_news boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- ---------------------------------------------------------------------------
-- §9 Forge (SSR, audiences, improvement_runs, document_versions)
-- ---------------------------------------------------------------------------

create table public.ssr_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  ssr_org_id text not null,
  secret_ref uuid,
  scopes text[] not null,
  connected_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id),
  unique (workspace_id, id),
  foreign key (workspace_id, secret_ref) references public.connector_secrets(workspace_id, id) on delete set null (secret_ref)
);

create table public.forge_personas (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  ssr_id text not null,
  name text,
  title text,
  segment text,
  initials text,
  accent text,
  synced_at timestamptz,
  unique (workspace_id, ssr_id),
  unique (workspace_id, id)
);

create table public.forge_reference_sets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  ssr_id text not null,
  name text,
  version text,
  anchor_count int,
  synced_at timestamptz,
  unique (workspace_id, ssr_id),
  unique (workspace_id, id)
);

create table public.forge_questions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  ssr_id text not null,
  text text,
  synced_at timestamptz,
  unique (workspace_id, ssr_id),
  unique (workspace_id, id)
);

create table public.forge_audiences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  note text,
  reference_set_id uuid,
  question_id uuid,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, reference_set_id) references public.forge_reference_sets(workspace_id, id) on delete set null (reference_set_id),
  foreign key (workspace_id, question_id) references public.forge_questions(workspace_id, id) on delete set null (question_id)
);
create unique index forge_audiences_one_default_per_workspace
  on public.forge_audiences (workspace_id) where is_default;

create table public.forge_audience_personas (
  workspace_id uuid not null,
  audience_id uuid not null,
  persona_id uuid not null,
  sort_order int,
  added_at timestamptz not null default now(),
  primary key (audience_id, persona_id),
  foreign key (workspace_id, audience_id) references public.forge_audiences(workspace_id, id) on delete cascade,
  foreign key (workspace_id, persona_id) references public.forge_personas(workspace_id, id) on delete cascade
);

create table public.improvement_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  tab_id uuid,
  target_block_id uuid,
  talk_id uuid,
  owner_id uuid not null references public.users(id) on delete restrict,
  audience_id uuid,
  objective_json jsonb not null,
  search_config_json jsonb not null,
  target_score numeric,
  max_iterations int,
  budget_usd numeric,
  baseline_score numeric,
  status text not null default 'pending'
    check (status in ('pending','running','completed','plateaued','budget_exhausted','cancelled','failed')),
  stop_reason text,
  ssr_connection_id uuid,
  best_version_id uuid,                                              -- back-edge to document_versions; deferrable
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, document_id) references public.documents(workspace_id, id) on delete cascade,
  foreign key (workspace_id, document_id, tab_id)
    references public.doc_tabs(workspace_id, document_id, id) on delete cascade,
  foreign key (workspace_id, document_id, target_block_id)
    references public.doc_blocks(workspace_id, document_id, id) on delete cascade,
  foreign key (workspace_id, talk_id) references public.talks(workspace_id, id) on delete set null (talk_id),
  foreign key (workspace_id, audience_id) references public.forge_audiences(workspace_id, id) on delete set null (audience_id),
  foreign key (workspace_id, ssr_connection_id) references public.ssr_connections(workspace_id, id) on delete set null (ssr_connection_id)
);

create table public.improvement_run_held_out_personas (
  workspace_id uuid not null,
  run_id uuid not null,
  persona_id uuid not null,
  primary key (run_id, persona_id),
  foreign key (workspace_id, run_id) references public.improvement_runs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, persona_id) references public.forge_personas(workspace_id, id) on delete cascade
);

create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id uuid not null,
  iteration int not null,
  candidate_id text not null,
  parent_version_id uuid,
  body_markdown text not null,
  mutation_strategy text,
  composite_score numeric,
  held_out_score numeric,
  per_persona_json jsonb,
  ssr_job_id text,
  decision text check (decision in ('keep','discard','frontier','winner')),
  decision_reason text,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (run_id, candidate_id),
  foreign key (workspace_id, run_id) references public.improvement_runs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, parent_version_id) references public.document_versions(workspace_id, id) on delete set null (parent_version_id)
);

-- improvement_runs.best_version_id back-edge (deferrable cycle)
alter table public.improvement_runs
  add constraint improvement_runs_best_version_id_fkey
  foreign key (workspace_id, best_version_id) references public.document_versions(workspace_id, id)
  deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- §10 Audit & analytics
-- ---------------------------------------------------------------------------

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  actor_user_id uuid references public.users(id) on delete set null,
  entity_type text,
  entity_id uuid,
  action text,
  payload_json jsonb,
  created_at timestamptz not null default now()
);
create index on public.audit_events (workspace_id, created_at desc);
create index on public.audit_events (workspace_id, entity_type, entity_id, created_at desc);

-- =============================================================================
-- STEP 5: Updated_at touch triggers (per-table)
-- =============================================================================

create trigger touch_updated_at before update on public.users
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.workspaces
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.folders
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.talks
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.agent_role_templates
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.agents
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.team_compositions
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.documents
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.doc_tabs
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.doc_blocks
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.context_sources
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.connector_secrets
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.connectors
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.jobs
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.home_news_topics
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.home_inbox_items
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.home_ranking_profiles
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.home_activation_state
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.ssr_connections
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.forge_audiences
  for each row execute function public.tg_touch_updated_at();
create trigger touch_updated_at before update on public.improvement_runs
  for each row execute function public.tg_touch_updated_at();

-- =============================================================================
-- STEP 6: Business triggers
-- =============================================================================

-- Last-tab guard
create trigger doc_tabs_block_last_delete
  before delete on public.doc_tabs
  for each row execute function public.doc_tabs_block_last_delete();

-- Edit-CAS bump on accept
create trigger document_edits_bump_versions_on_accept
  before update on public.document_edits
  for each row execute function public.document_edits_bump_versions_on_accept();

-- Job agent-clear → blocked atomic
create trigger jobs_block_on_agent_clear
  before update of agent_id on public.jobs
  for each row when (new.agent_id is null and old.agent_id is not null)
  execute function public.set_job_blocked_agent_missing();

-- Jobs roster invariant
create trigger jobs_require_agent_in_roster
  before insert or update of talk_id, agent_id on public.jobs
  for each row execute function public.jobs_require_agent_in_roster();

-- =============================================================================
-- STEP 7: RLS enable + policies (§11 §12)
-- =============================================================================

-- Workspaces + members
alter table public.workspaces enable row level security;
create policy workspaces_read on public.workspaces
  for select using (public.is_workspace_member(id));
create policy workspaces_write on public.workspaces
  for all
  using       (public.is_workspace_admin(id))
  with check  (public.is_workspace_admin(id));

alter table public.workspace_members enable row level security;
create policy workspace_members_read on public.workspace_members
  for select using (user_id = auth.uid());
create policy workspace_members_write on public.workspace_members
  for all
  using       (public.is_workspace_admin(workspace_id))
  with check  (public.is_workspace_admin(workspace_id));

-- Member-write tables (the canonical pattern)
do $$
declare
  tbl text;
  member_write_tables text[] := array[
    'folders','talks','talk_agents','talk_tools','talk_reads','messages','runs',
    'talk_agent_snapshots','run_prompt_snapshots','context_sources','context_source_pages','agents','agent_feedback_events',
    'team_compositions','team_composition_agents','documents','doc_tabs','doc_blocks',
    'document_edits','doc_tab_coeditors','jobs','improvement_runs','document_versions',
    'improvement_run_held_out_personas','forge_audiences','forge_audience_personas',
    'forge_personas','forge_reference_sets','forge_questions','home_inbox_items','home_recommendations',
    'home_recommendation_candidates','home_recommendation_events','home_news_topics','home_news_matches',
    'home_interaction_events','home_activation_state','activity_events','audit_events'
  ];
begin
  foreach tbl in array member_write_tables loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('create policy %I_read on public.%I for select using (public.is_workspace_member(workspace_id))', tbl, tbl);
    execute format(
      'create policy %I_write on public.%I for all using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id))',
      tbl, tbl);
  end loop;
end $$;

-- Admin-write exception tables (member-read, admin-write)
do $$
declare
  tbl text;
  admin_write_tables text[] := array[
    'connectors','connector_bindings','connector_secrets','ssr_connections',
    'home_optimization_proposals','home_algorithm_versions','home_algorithm_assignments',
    'home_ranking_profiles'
  ];
begin
  foreach tbl in array admin_write_tables loop
    execute format('alter table public.%I enable row level security', tbl);
    -- home_algorithm_versions has no workspace_id (global table); skip member-read policy
    if tbl = 'home_algorithm_versions' then
      execute format('create policy %I_read on public.%I for select using (true)', tbl, tbl);
      execute format(
        'create policy %I_write on public.%I for all using (false) with check (false)',
        tbl, tbl);
    else
      execute format('create policy %I_read on public.%I for select using (public.is_workspace_member(workspace_id))', tbl, tbl);
      execute format(
        'create policy %I_write on public.%I for all using (public.is_workspace_admin(workspace_id)) with check (public.is_workspace_admin(workspace_id))',
        tbl, tbl);
    end if;
  end loop;
end $$;

-- Shared pool: home_news_items (no workspace_id)
alter table public.home_news_items enable row level security;
create policy home_news_items_read on public.home_news_items
  for select using (true);
-- No write policy → only service role (bypassrls) can insert/update

-- agent_role_templates: global runtime catalog (no workspace_id)
alter table public.agent_role_templates enable row level security;
create policy agent_role_templates_read on public.agent_role_templates
  for select using (true);
-- No write policy → only service role can update (versioning is admin/migration concern)

commit;

-- =============================================================================
-- END 0039_clawtalk_greenfield.sql
-- Per docs/05-build-plan.md Phase 1 Step 2: agent_role_templates seed runs in a follow-up
-- migration or in the POST /workspaces handler at workspace-creation time.
-- =============================================================================
