> **Status:** canonical (greenfield schema — the authoritative DB design). Build posture is [DECISIONS.md](./DECISIONS.md) D0 (greenfield); gating resolutions in D7. This doc owns the **tables**; [08-information-architecture.md](./08-information-architecture.md) owns IA rules/cardinalities, `06`/`07`/`09` own their domain behavior.
> Precedence + orientation: [README.md](./README.md) · decisions: [DECISIONS.md](./DECISIONS.md) · terms: [GLOSSARY.md](./GLOSSARY.md).

# ClawTalk — Canonical Data Model

A clean-slate schema for the rebuilt product. Designed for the canonical hierarchy

> **Workspace → Folder (optional) → Talk + Document (optional)** · multi-workspace · no Threads

on Postgres (Supabase) behind Cloudflare Workers ([DECISIONS](./DECISIONS.md) D1). Single source of truth for tables; behavior lives in the spec docs it cross-references.

It is **greenfield** (D0): names and shapes are designed for the new model, not inherited from the current `contents`/`talk_threads`/`registered_agents` tables. Where keeping existing infra is the _better_ engineering choice (not just continuity), each section says so under **Reuse vs. rewrite** — corrected after the 2026-05-28 pressure test (D7), which found several earlier reuse claims false.

---

## 0. Conventions

- **PKs:** `id uuid primary key default gen_random_uuid()` (time-ordered v7 default if available). API exposes typed opaque IDs (`ws_`, `f_`, `t_`, `d_`, `a_`, …) derived from the uuid per `04` §0.
- **Tenancy:** every workspace-owned row carries `workspace_id uuid not null` — first column after `id`, leading column of most indexes. This **includes join tables** (`talk_agents`, `talk_tools`, `team_composition_agents`, `doc_tab_coeditors`, connector bindings) so RLS can predicate on them directly (D7).
- **Composite FKs for tenant integrity:** a child references its parent on `(workspace_id, parent_id)`, not just `parent_id`, so a row can't point across workspaces. Parents expose a `unique (workspace_id, id)` for the composite target. (Caught by D7: `workspace_id` alone, unenforced, isn't integrity.)
- **`ON DELETE SET NULL` with composite FKs:** specify which columns get nulled, e.g. `on delete set null (folder_id)` (Postgres 15+). The default nulls _all_ FK columns, which fails because `workspace_id` is `NOT NULL`. Used in §2/§3/§5 for folder/document/talk reparenting.
- **DDL order + cycles:** several tables form FK cycles. The migration declares tables in dependency order, then adds back-edge FKs via `ALTER TABLE … ADD CONSTRAINT … DEFERRABLE INITIALLY DEFERRED`. The complete list of FKs that need `DEFERRABLE INITIALLY DEFERRED`:
  - `runs.trigger_message_id → messages` (back-edge of `messages.run_id → runs`).
  - `runs.prompt_snapshot_id → run_prompt_snapshots` (back-edge of `run_prompt_snapshots.run_id → runs`).
  - `improvement_runs.best_version_id → document_versions` (back-edge of `document_versions.run_id → improvement_runs`).
  - `talk_agents.agent_id → agents` (`agents` defined in §4, after `talk_agents` in §3).
  - `team_composition_agents.agent_id → agents` (`agents` defined in §4, after `team_compositions`).
  - `doc_tab_coeditors.agent_id → agents` (`agents` defined in §4, after `doc_tabs`/`doc_blocks` in §5).
  - `messages.agent_snapshot_id → talk_agent_snapshots` (snapshots defined in §4, after `messages` in §3).
  - `connectors.secret_ref → connector_secrets` (`connector_secrets` declared after `connectors` in §6).

  Multi-row inserts that need to write across a cycle wrap in a transaction with `SET CONSTRAINTS ALL DEFERRED`. The scheduler's claim path (`12-jobs.md` §5) and Forge's improvement-run-bootstrap path both rely on this.
- **Timestamps:** `created_at`, `updated_at`, UTC `timestamptz`. `updated_at` is maintained by a single shared trigger function applied to every table that has an `updated_at` column:

  ```sql
  create function tg_touch_updated_at() returns trigger
    language plpgsql as $$
  begin
    new.updated_at := now();
    return new;
  end;
  $$;

  -- One BEFORE UPDATE trigger per table with an updated_at column:
  --   create trigger touch_updated_at before update on <table>
  --     for each row execute function tg_touch_updated_at();
  -- The migration writes one such trigger per table; the per-table CREATE TRIGGER
  -- is omitted from §1–§10 for brevity.
  ```
- **Soft-delete:** only where recovery is a product feature (Talks: `archived_at`). Else hard-delete via cascade (D0 — no "just in case" tombstones).
- **Enums:** `text` + `CHECK` universally (closed and evolving sets alike). Postgres `enum` types are avoided so adding a new value is a plain migration, not `ALTER TYPE`. The trade-off is a slightly larger on-disk row and lookups that aren't ordinal; both are negligible at our target scale.
- **Flexible payloads:** `jsonb` for genuinely open shapes (objective/search config, manifests, event payloads) — not as an escape hatch for known columns.
- **Ordering:** user-orderable lists use `sort_order int`, unique per parent bucket.
- **RLS:** every workspace-owned table has RLS on. Identity is **`auth.uid()`**, resolved from `request.jwt.claims->>'sub'`, which the existing `withUserContext` (`src/db.ts`) sets via `set_config('request.jwt.claims', …)` + `set local role authenticated`. **There is no `app.*` GUC.** Visibility predicate is workspace membership — see §12.

**Reuse vs. rewrite (global), corrected by D7.** _Keep_ the Cloudflare platform (Workers / Queues / Durable Objects / Hyperdrive), the `event_outbox` → `UserEventHub` DO stream, and the LLM provider/model/secret tables (`llm_providers`, `llm_provider_models`, `llm_provider_secrets`, `workspace_provider_secrets` — these are **shared LLM keys**, not OAuth). _Rework_ the run model + executor (the legacy `talk_runs` is thread/channel-entangled). _Do not reuse_ `idempotency_cache` for Forge retries (it's an HTTP-response cache keyed `idempotency_key,user_id,method,path`) and _do not_ route connector/SSR OAuth secrets through `workspace_provider_secrets` (LLM-key store) — both get their own stores below.

**Migration approach (per D0).** The implementing migration script **drops every superseded table from §11 in dependency order, then creates the target schema below.** Local data IS lost — per `CLAUDE.md`, ClawTalk's local users and stored data are disposable by default; the only live user is Joseph and the only live data is dogfood. There is **no shadow-table, dual-write, or backfill phase.** The reused infrastructure (Cloudflare platform, `event_outbox`, LLM provider tables) is left untouched by the drop step. After the migration: Joseph re-OAuths Google/Anthropic providers (the keys in `workspace_provider_secrets` are preserved) and his first signin creates a fresh `workspace` + `owner` `workspace_members` row.

---

## 1. Identity & tenancy

```sql
users ( id uuid pk, email citext unique not null, name text not null, avatar_color text, initials text, created_at, updated_at )

workspaces (
  id uuid pk, name text not null, slug text unique,
  owner_id uuid not null references users(id),
  plan text not null default 'team' check (plan in ('team','enterprise')),
  created_at, updated_at,
  unique (id)                                   -- composite-FK target uses (id); workspace rows are the tenant root
)

workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  role         text not null default 'member' check (role in ('owner','admin','member','guest')),
  created_at,
  primary key (workspace_id, user_id)
)
```

- `workspace_role` includes **`guest`** (the prototype's account switcher shows a Guest workspace) in addition to owner/admin/member.
- On signup: create the user, their first `workspace`, and an `owner` membership.
- `workspace_members` is the **RLS keystone** — every other policy joins through it (§12). To avoid policy recursion (a `workspace_members` policy can't itself subselect from `workspace_members`), reads on `workspace_members` policy on `user_id = auth.uid()` directly; mutations go through a `security definer` helper. The same helper (`is_workspace_member(ws uuid)`) is used by other tables' policies so the membership lookup runs once, plan-cached, without recursion (§12).
- **User deletion semantics:** `users.id` is referenced by `workspaces.owner_id`, `workspace_members.user_id`, `talks.created_by`, `runs.requested_by`, `jobs.created_by`, `messages.author_user_id`, `improvement_runs.owner_id`, `agent_feedback_events.actor_user_id`, `talk_reads.user_id`, etc. Default is **`ON DELETE RESTRICT`** for ownership/authorship columns (reassign or anonymize first) and **`ON DELETE CASCADE`** for membership/read-state columns. The app exposes a "leave workspace" + "transfer ownership" flow; hard user delete is admin-only.
- **Reuse vs. rewrite.** `users` is kept. `workspaces` + `workspace_members` are net-new (today's app is user-owned, no tenant table — D5).

---

## 2. Organization — folders

```sql
folders (
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null, sort_order int not null,
  created_at, updated_at,
  unique (workspace_id, id)                      -- composite-FK target
)
```

- Flat, no nesting (`08` §3.2). Folder order: index `(workspace_id, sort_order)`.
- **Talk ordering lives on the talk** (`talks.sort_order`, §3) within its `(workspace_id, folder_id)` bucket — the sidebar (and Unfiled) is drag-orderable. Deleting a folder reparents its talks to Unfiled (`folder_id = null`).

---

## 3. Talks, messages, runs

```sql
talks (
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  folder_id uuid, sort_order int not null,                       -- ordering within folder / Unfiled bucket
  title text not null,
  mode text not null default 'ordered' check (mode in ('ordered','parallel')),
  rounds_limit int not null default 3 check (rounds_limit in (1,2,3,5)),
  created_by uuid not null references users(id) on delete restrict,
  archived_at timestamptz, last_activity_at timestamptz not null default now(),
  created_at, updated_at,
  unique (workspace_id, id),
  foreign key (workspace_id, folder_id) references folders(workspace_id, id) on delete set null (folder_id)
)

-- Current, editable roster (who's in the room now). Distinct from the per-run snapshot. (D7 / pressure-test P0-1)
talk_agents (
  workspace_id uuid not null, talk_id uuid not null, agent_id uuid not null,
  sort_order int not null, added_at timestamptz not null default now(),
  primary key (talk_id, agent_id), unique (talk_id, sort_order),
  foreign key (workspace_id, talk_id) references talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_id) references agents(workspace_id, id) on delete cascade
)

messages (
  id uuid pk, workspace_id uuid not null, talk_id uuid not null,
  round int not null,
  author_kind text not null check (author_kind in ('user','agent')),
  author_user_id    uuid references users(id) on delete restrict,   -- when user
  agent_snapshot_id uuid,                                            -- when agent: immutable attribution (P1-5)
  run_id            uuid,                                            -- composite FK below (back-edge, deferrable)
  body text, attachments_json jsonb not null default '[]',
  created_at,
  unique (workspace_id, id),                                         -- composite-FK target (agent_feedback_events)
  unique (workspace_id, talk_id, id),                                -- composite-FK target including talk_id (runs.trigger_message_id)
  check (
    (author_kind = 'user'  and author_user_id is not null and agent_snapshot_id is null and run_id is null) or
    (author_kind = 'agent' and author_user_id is null     and agent_snapshot_id is not null and run_id is not null)
  ),
  foreign key (workspace_id, talk_id)                       references talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, talk_id, agent_snapshot_id)    references talk_agent_snapshots(workspace_id, talk_id, id),
  foreign key (workspace_id, talk_id, run_id)               references runs(workspace_id, talk_id, id) deferrable initially deferred
)

runs (                                                            -- clean: NO thread_id (D4/D7)
  id uuid pk, workspace_id uuid not null, talk_id uuid not null,
  round int not null,
  run_kind text not null default 'conversation'
    check (run_kind in ('conversation','content_improvement')),  -- extended for Forge (§9)
  snapshot_group_id uuid not null,                               -- frozen roster group; full room = SELECT * FROM talk_agent_snapshots WHERE snapshot_group_id = …  (P0-1 / 06 §3.4)
  agent_snapshot_id uuid not null,                               -- the acting agent at this run (a row inside snapshot_group_id)
  status text not null default 'queued'
    check (status in ('queued','running','awaiting','completed','failed','cancelled')),
  model_id text not null references llm_models(id),
  requested_by uuid not null references users(id) on delete restrict,
  trigger_message_id uuid,                                       -- the user turn that triggered this run (composite FK below)
  job_id uuid,                                                   -- set when a scheduled Job fired this run (§8 / 12-jobs.md)
  trigger text not null default 'user' check (trigger in ('user','scheduler','manual')),
  scheduled_for timestamptz,                                     -- only set for trigger in ('scheduler','manual'); the immutable slot identity that powers (job_id, scheduled_for) dedup (12 §5)
  response_group_id text not null                               -- ordered/parallel sequencing key; spec'd as uuid::text from `gen_random_uuid()` (`12-jobs.md` §2)
    check (length(response_group_id) between 1 and 64),         -- defensive: keep noise out of the index
  sequence_index int not null check (sequence_index >= 0),
  prompt_snapshot_id uuid,
  tokens_in int, tokens_out int, error_json jsonb,
  started_at, finished_at, created_at,
  unique (workspace_id, id),                                     -- composite-FK target (run_prompt_snapshots, document_edits.proposed_by_run_id, etc.)
  unique (workspace_id, talk_id, id),                            -- composite-FK target including talk_id (messages.run_id)
  check (                                                        -- job-trigger invariant: no message-author trigger, prompt comes from a snapshot, slot identity only on scheduler (12 §2)
    (trigger = 'user'      and job_id is null and scheduled_for is null) or
    (trigger = 'scheduler' and job_id is not null and trigger_message_id is null and prompt_snapshot_id is not null and scheduled_for is not null) or
    (trigger = 'manual'    and job_id is not null and trigger_message_id is null and prompt_snapshot_id is not null and scheduled_for is null)
  ),
  foreign key (workspace_id, talk_id)                                          references talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, talk_id, snapshot_group_id, agent_snapshot_id)
    references talk_agent_snapshots(workspace_id, talk_id, snapshot_group_id, id),
  foreign key (workspace_id, talk_id, trigger_message_id)
    references messages(workspace_id, talk_id, id) deferrable initially deferred,
  foreign key (workspace_id, job_id)                                           references jobs(workspace_id, id) on delete restrict,  -- 12 §6: history is runs filtered by job_id; archive (not delete) is the UI path
  foreign key (workspace_id, prompt_snapshot_id)
    references run_prompt_snapshots(workspace_id, id) deferrable initially deferred
)
-- single-flight per job: only one nonterminal run per job at a time (P1, §8)
create unique index runs_one_active_per_job
  on runs (job_id) where job_id is not null and status in ('queued','running','awaiting');
-- slot dedup: each (job_id, scheduled_for) slot fires exactly once across scheduler-tick races and queue retries (12 §5)
create unique index runs_one_per_job_slot
  on runs (job_id, scheduled_for) where job_id is not null and scheduled_for is not null;

-- Per-user read state → unread is derived (P0-2). No `unread` column on talks.
talk_reads ( workspace_id uuid not null, talk_id uuid not null, user_id uuid not null,
  last_read_at timestamptz not null default now(),
  primary key (talk_id, user_id),
  foreign key (workspace_id, talk_id) references talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id) references workspace_members(workspace_id, user_id) on delete cascade )
-- NOTE: talk_reads.user_id FKs through `workspace_members` (not directly to `users`) — this is
-- intentional: a leave-workspace action wipes read-state for that workspace via the membership
-- cascade. The composite FK target `(workspace_id, user_id)` is the PK of `workspace_members`,
-- so no separate `unique (workspace_id, user_id)` is needed on the parent.
```

Design notes:

- **Roster vs. snapshot (P0-1).** `talk_agents` = the live, editable roster (add/remove agent, composer targeting). `talk_agent_snapshots` (§4) = an immutable freeze taken per run. Both are needed; the earlier "snapshots _are_ the roster" was wrong.
- **Roster freeze groups.** A run carries `snapshot_group_id` _and_ `agent_snapshot_id`. The full room at run time = all snapshots with that `snapshot_group_id`; the acting agent for the run is the one snapshot in that group whose id matches `agent_snapshot_id`. One group per logical roster freeze; runs in the same `(talk_id, round, response_group_id)` typically share a group. This makes the historical roster reconstructible without scanning snapshot timestamps.
- **Rounds are derived** — `round int` on messages/runs; a round = the runs sharing `(talk_id, round)`. No `rounds` table.
- **Run model is clean (D7).** Dropped `thread_id` (threads eliminated), channel/source/transport columns, and the `instruction_review` kind; added `content_improvement`. Kept `response_group_id` + `sequence_index` + `requested_by` + `trigger_message_id` because the ordered/parallel orchestration genuinely uses them.
- **Single-flight per job.** Partial unique on `runs(job_id)` for `status in ('queued','running','awaiting')` prevents two scheduler/manual races from creating concurrent nonterminal runs for the same job (`12-jobs.md` §5).
- **Slot identity per job-trigger run.** `scheduled_for timestamptz` is the immutable slot timestamp the scheduler computes per fire. The partial unique on `(job_id, scheduled_for)` makes "never fire the same slot twice" a Postgres invariant — covering scheduler-tick races, queue at-least-once retries, and dropped-claim recovery without app-side coordination (`12-jobs.md` §5). Manual `run-now` writes `scheduled_for=null` (no slot consumed).
- **Job-trigger invariant.** The CHECK in the runs body encodes `12-jobs.md` §2: scheduler/manual runs never carry a `trigger_message_id` (no `messages` row is written for the trigger), and they must point at a `run_prompt_snapshots` row (`prompt_snapshot_id is not null`) — so the executor reads an immutable snapshot of `jobs.prompt`, not the live row.
- **Scheduler authorization vs. attribution.** Scheduler-triggered runs are claimed and inserted under service-role auth (no `auth.uid()` — the scheduler isn't a user). `requested_by = jobs.created_by` for attribution only (so "who set this up" stays answerable in run-list UI and audit queries), not for authorization — accessors scope by `workspace_id` explicitly. The `requested_by` user may leave the workspace later; that doesn't break the run.
- **`runs.job_id` is `RESTRICT`.** History for a job is `runs filtered by job_id` (no separate `job_runs` ledger), so the FK must survive job-delete attempts. Hard delete is only allowed via an admin path when `run_count = 0`; the UI "Delete" action archives instead (`jobs.archived_at` in §8).
- **Index cost.** The composite-FK pattern adds 7–8 indexes per `runs` insert and 4 per `messages` insert (each `unique` = a B-tree index). Tenant integrity beats write cost at the foreseeable target (personal-only, one workspace), but revisit if write throughput becomes the binding constraint — relaxing the `(workspace_id, talk_id, id)` targets would lose the cross-Talk integrity codex flagged on 2026-05-29.
- **Unread (P0-2):** derived = messages in a talk newer than the caller's `talk_reads.last_read_at`; workspace badge = sum across the workspace's talks.
- **Message attribution (P1-5):** points at `talk_agent_snapshots`, so editing an agent later never rewrites historical attribution.
- Indexes: `talks(workspace_id, folder_id, sort_order) where archived_at is null`; `messages(talk_id, round, created_at)`; `runs(talk_id, round)`, `runs(status) where status in ('queued','running')`, `runs(response_group_id, sequence_index)`.
- **Reuse vs. rewrite.** Keep the queue + DO + cron _mechanism_ and salvage the executor's latency/correctness _logic_ (engineering-notes §2–3); the runs **table + executor data-access are reworked** to this shape (the legacy `talk_runs` can't be reused as-is — D7).

---

## 4. Agents

```sql
-- llm_models is a VIEW over the kept `llm_provider_models` table, not its own table.
-- Why a view: live model discovery (#484, the Anthropic + NVIDIA discovery path)
-- already writes to `llm_provider_models` automatically; projecting through a view
-- eliminates dual-write / drift entirely. Agents/runs/templates FK to llm_models.id
-- which is just `llm_provider_models.model_id` (globally unique in practice — each
-- provider's model_ids are namespaced 'claude-opus-4-6' / 'gpt-5-pro' / 'gemini-2.5-pro').
--
-- The migration extends `llm_provider_models` with `capabilities_json` (additive
-- ALTER TABLE; existing rows default to '{}'), then drops + recreates the view.

alter table public.llm_provider_models
  add column if not exists capabilities_json jsonb not null default '{}';

create view public.llm_models as
  select
    model_id              as id,
    provider_id           as provider,
    display_name,
    enabled,
    capabilities_json
  from public.llm_provider_models;

-- Foreign keys to llm_models.id (from agents.model_id, agent_role_templates.default_model_id,
-- agents.default_model_id, talk_agent_snapshots.model_id, run_prompt_snapshots.model_id,
-- runs.model_id) target `llm_provider_models(model_id)` directly. The view is a read
-- convenience; the FK references the underlying column via an explicit unique index:

create unique index llm_provider_models_model_id_unique
  on public.llm_provider_models (model_id);   -- enables FK on a single column from llm_models.id
-- NOTE: this assumes model_id is globally unique across providers, which is true today.
-- If a provider ships a model with a colliding model_id, the unique constraint will
-- reject the insert at discovery time — the operator must rename + retry. The collision
-- is a feature: it forces explicit namespacing before two providers can share a model_id.

agent_role_templates (                        -- DB table (D7), seeded from 03-agents.md prompts
  role_key text pk
    check (role_key in ('strategist','critic','researcher','editor','quant','forge_rewriter','forge_critic')),
  default_name, default_handle, default_initials, default_accent, default_accent_dark text,
  default_model_id text references llm_models(id),
  default_temperature numeric not null,
  job text not null, system_prompt text not null, method_default text[] not null,
  version int not null, updated_at
)

agents (
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  role_key text not null references agent_role_templates(role_key),
  name text not null, handle text not null, initials text not null,
  accent text not null, accent_dark text,
  model_id text not null references llm_models(id),
  default_model_id text not null references llm_models(id),
  temperature numeric not null,                -- editable; seeded from role template (resolves temperature-home)
  persona text, focus text, method text[] not null default '{}',
  capabilities text[] not null default '{}',
  is_default boolean not null default false, is_custom boolean not null default false,
  is_system boolean not null default false,    -- Forge rewriter/critic — hidden from roster (D3)
  enabled boolean not null default true, created_from_template_version int,
  created_at, updated_at,
  unique (workspace_id, id)                     -- composite-FK target for talk_agents / snapshots / coeditors
)

team_compositions ( id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null, description text, icon text, is_default boolean not null default false,
  runs_count int not null default 0, created_at, updated_at, unique (workspace_id, id) )

team_composition_agents (
  workspace_id uuid not null, team_id uuid not null, agent_id uuid not null, sort_order int,
  primary key (team_id, agent_id),
  foreign key (workspace_id, team_id)  references team_compositions(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_id) references agents(workspace_id, id) on delete cascade
)

talk_agent_snapshots (                        -- immutable per-run roster freeze (06 §3.4)
  id uuid pk, workspace_id uuid not null, talk_id uuid not null,
  snapshot_group_id uuid not null,              -- roster-freeze group (see §3 design notes)
  source_agent_id uuid,                         -- which live agent this snapshot was taken from (nullable: agent may be deleted later)
  role_key text not null, name text, handle text, initials text, accent text, accent_dark text,
  model_id text not null references llm_models(id),
  temperature numeric not null, persona text, focus text, method text[],
  sort_order int not null, role_template_version int, global_policy_version int, created_at,
  unique (workspace_id, id),                                             -- composite-FK target (messages.agent_snapshot_id loose, run_prompt_snapshots)
  unique (workspace_id, talk_id, id),                                    -- composite-FK target including talk_id (messages.agent_snapshot_id strict)
  unique (workspace_id, talk_id, snapshot_group_id, id),                 -- composite-FK target including group (runs.agent_snapshot_id — "acting agent is inside this run's frozen roster")
  unique (snapshot_group_id, source_agent_id),                           -- one snapshot per (group, source agent); NULLs are not deduped (Postgres semantic) — after the source agent is deleted, multiple snapshots in the same group can carry NULL source_agent_id, which is fine: the historical attribution lives in the snapshot's frozen fields, not in this FK.
  foreign key (workspace_id, talk_id)         references talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, source_agent_id) references agents(workspace_id, id) on delete set null (source_agent_id)
)
create index on talk_agent_snapshots (snapshot_group_id);

run_prompt_snapshots (                        -- exact prompt provenance per run (06 §3.5)
  id uuid pk, workspace_id uuid not null, run_id uuid not null, talk_id uuid not null,
  agent_snapshot_id uuid not null,
  model_id text not null references llm_models(id), provider text not null,
  global_policy_version int, role_template_version int, prompt_assembly_version int,
  context_manifest_json jsonb, tool_manifest_json jsonb, prompt_hash text, prompt_text_redacted text, created_at,
  unique (workspace_id, id),                    -- composite-FK target (runs.prompt_snapshot_id)
  unique (workspace_id, run_id),                -- one prompt snapshot per run
  foreign key (workspace_id, run_id)             references runs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, talk_id)            references talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_snapshot_id)  references talk_agent_snapshots(workspace_id, id)
)

agent_feedback_events (
  id uuid pk, workspace_id uuid not null, agent_id uuid, talk_id uuid, message_id uuid,
  kind text not null
    check (kind in ('useful','not_useful','too_verbose','off_role','missed_evidence','wrong_model','accepted_doc_edit','rejected_doc_edit','user_referenced_agent')),
  actor_user_id uuid references users(id) on delete set null, created_at,
  foreign key (workspace_id, agent_id)   references agents(workspace_id, id)   on delete cascade,
  foreign key (workspace_id, talk_id)    references talks(workspace_id, id)    on delete cascade,
  foreign key (workspace_id, message_id) references messages(workspace_id, id) on delete cascade
)
```

Design notes:

- **Model catalog (D7):** `llm_models` is the single source of truth (one `id`); seeded from `llm_provider_models(provider_id, model_id)`, which **keeps its composite key** as the provider-capability table. Agents/runs/templates FK to `llm_models.id`. Kills the model-ID drift.
- **Role templates as a DB table (D7):** `agents.role_key` is a real FK. Prompts are **seeded from `03-agents.md`** (still the version-controlled, reviewable, eval-tested source) and changed via versioned rows — feeds the `06` §14 prompt-improvement loop. Fix the "Samira" placeholder + `@strat` handle on seed.
- **Temperature** lives on the template (default) → `agents.temperature` (editable) → snapshot. Resolves the audit gap.
- **System agents (`is_system`)** carry Forge's rewriter + critic (D3); filtered from `GET /agents` and the roster at the query layer.
- **Index cost on snapshots.** `talk_agent_snapshots` carries 6 indexes per row (PK + 3 composite-FK targets + uniqueness on `(snapshot_group_id, source_agent_id)` + the `snapshot_group_id` lookup index). One row per agent per run = 3–6 rows per Talk turn at a typical roster size. Acceptable for the personal-only target; if write rate ever blows past ~10 turns/sec sustained, consider partitioning by month or relaxing the workspace-id-redundant targets.
- **`run_prompt_snapshots` is shared with jobs (`12-jobs.md` §2 / §5).** Scheduler-triggered runs and manual `run-now` runs reuse this table — no new table, no new column. The scheduler writes the snapshot in the same transaction as the `runs` INSERT (`12-jobs.md` §5 Path A): `prompt_text_redacted = jobs.prompt` (the immutable copy the executor reads), `model_id = <from the targeted agent's `talk_agent_snapshots` row>`, `provider = (SELECT provider FROM llm_models WHERE id = model_id)` (the snapshot row has no provider column; provider lives on `llm_models`). Optional provenance fields (`global_policy_version`, `role_template_version`, `context_manifest_json`, `tool_manifest_json`, `prompt_hash`) are left NULL by the scheduler; the executor or a follow-up backfill can populate them. The `runs.prompt_snapshot_id` FK is deferrable so the scheduler can insert `runs` first (referencing the future snapshot id) and `run_prompt_snapshots` second within the same txn.
- `06` §14.6 loop tables (`agent_audit_results`, `prompt_improvement_proposals`, `prompt_versions`) are deferred until that loop is built.

---

## 5. Documents — tabs & blocks

```sql
documents (
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  primary_talk_id uuid, folder_id uuid,
  title text not null, format text not null check (format in ('markdown','html')),
  word_count int not null default 0, last_edit_at timestamptz, created_at, updated_at,
  unique (workspace_id, id),
  foreign key (workspace_id, primary_talk_id) references talks(workspace_id, id) on delete set null (primary_talk_id),
  foreign key (workspace_id, folder_id)       references folders(workspace_id, id) on delete set null (folder_id)
)
create unique index on documents (primary_talk_id) where primary_talk_id is not null;   -- 0/1 primary doc per talk

doc_tabs (
  id uuid pk, workspace_id uuid not null, document_id uuid not null,
  title text not null, sort_order int not null,
  list_version int not null default 1,                                 -- CAS for placement/reorder edits (P1, §5 design notes)
  created_at, updated_at,
  unique (document_id, sort_order),
  unique (workspace_id, id),                                           -- composite-FK target (doc_blocks, document_edits)
  unique (workspace_id, document_id, id),                              -- composite-FK target for "block belongs to tab of same document"
  foreign key (workspace_id, document_id) references documents(workspace_id, id) on delete cascade
)

doc_blocks (
  id uuid pk, workspace_id uuid not null, document_id uuid not null, tab_id uuid not null,
  sort_order int not null, version int not null default 1,                 -- CAS for replace/delete edits
  kind text not null check (kind in ('h1','h2','p','li','meta','code')),
  text text not null default '', attrs_json jsonb not null default '{}', created_at, updated_at,
  unique (tab_id, sort_order),
  unique (workspace_id, id),                                              -- composite-FK target (loose; per-workspace)
  unique (workspace_id, document_id, id),                                 -- composite-FK target ("edit's block belongs to same document")
  unique (workspace_id, document_id, tab_id, id),                         -- composite-FK target including tab_id (document_edits — block must belong to edit's tab)
  foreign key (workspace_id, document_id, tab_id)
    references doc_tabs(workspace_id, document_id, id) on delete cascade  -- block's tab must belong to block's document
)

document_edits (                              -- unified pending-edit model (replaces content_edits/proposals)
  id uuid pk, workspace_id uuid not null, document_id uuid not null, tab_id uuid not null,
  block_id uuid,                                                       -- null = insert new block; composite FK below
  base_block_version int,                                              -- CAS: must match doc_blocks.version on accept (replace/delete)
  base_list_version  int,                                              -- CAS: must match doc_tabs.list_version on accept (insert placement)
  after_block_id uuid,                                                 -- placement for inserts; composite FK below
  proposed_by_agent_id uuid, proposed_by_run_id uuid,
  op text not null check (op in ('insert','replace','delete')),
  new_kind text, new_text text, new_attrs_json jsonb,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','superseded')),
  source text not null default 'agent' check (source in ('agent','forge','job')),   -- 'job' = §8 jobs append (P1)
  created_at, resolved_at,
  check (                                                              -- op-shape consistency
    (op = 'insert'  and block_id is null     and base_list_version  is not null and new_kind is not null and new_text is not null) or
    (op = 'replace' and block_id is not null and base_block_version is not null and new_text is not null) or
    (op = 'delete'  and block_id is not null and base_block_version is not null)
  ),
  foreign key (workspace_id, document_id)                       references documents(workspace_id, id)             on delete cascade,
  foreign key (workspace_id, document_id, tab_id)               references doc_tabs(workspace_id, document_id, id) on delete cascade,
  foreign key (workspace_id, document_id, tab_id, block_id)
    references doc_blocks(workspace_id, document_id, tab_id, id) on delete cascade,    -- block must belong to edit's tab
  foreign key (workspace_id, document_id, tab_id, after_block_id)
    references doc_blocks(workspace_id, document_id, tab_id, id) on delete cascade,    -- placement anchor must belong to edit's tab
  foreign key (workspace_id, proposed_by_agent_id)              references agents(workspace_id, id) on delete set null (proposed_by_agent_id),
  foreign key (workspace_id, proposed_by_run_id)                references runs(workspace_id, id)   on delete set null (proposed_by_run_id)
)

doc_tab_coeditors ( workspace_id uuid not null, tab_id uuid not null, agent_id uuid not null,
  primary key (tab_id, agent_id),
  foreign key (workspace_id, tab_id)  references doc_tabs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_id) references agents(workspace_id, id) on delete cascade )
```

Design notes:

- **Tabs are first-class** (`08` §3.5–3.6): every document has ≥1 tab (`Main`), blocks belong to a tab. Net-new in the DB.
- **Document invariants** are enforced, not just documented (P1): `≥1 tab` and `last-tab-can't-delete` via a `before delete` trigger on `doc_tabs` (reject if it's the document's last); `documents.folder_id` is materialized by the app on talk move/link (one transaction); `after_block_id` is a real FK.

  ```sql
  create function doc_tabs_block_last_delete() returns trigger
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

  create trigger doc_tabs_block_last_delete
    before delete on public.doc_tabs
    for each row execute function doc_tabs_block_last_delete();
  ```
- **Edit concurrency (P1-7) — CAS covers both shape changes.** Replace/delete check `base_block_version` against `doc_blocks.version`; inserts check `base_list_version` against `doc_tabs.list_version` (so a concurrent insert/reorder that already changed the placement bumps the tab's `list_version` and the late edit is marked `superseded`). On accept, the relevant version column bumps via the trigger below. Inline rendering of a pending edit interleaves `document_edits` rows (status `pending`) against `doc_blocks` by `after_block_id`/`block_id`.

  ```sql
  -- Fires when a document_edits row transitions to 'accepted'.
  -- For inserts: bumps the target tab's list_version, marks any other
  -- pending insert at the same anchor as 'superseded' (CAS loser).
  -- For replace/delete: bumps the target block's version, marks any other
  -- pending replace/delete on the same block as 'superseded' (CAS loser).
  create function document_edits_bump_versions_on_accept() returns trigger
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
            and (new.after_block_id is null and after_block_id is null
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

  create trigger document_edits_bump_versions_on_accept
    before update on public.document_edits
    for each row execute function document_edits_bump_versions_on_accept();
  ```
- **`document_edits` unifies** today's `content_edits` + `content_proposals`; `source='forge'` lets a Forge winner land and `source='job'` lets a §8 job append land through the same accept path (no second write path).
- **Job-emitted edit shape (`12-jobs.md` §3).** When a job with `emit_document_append=true` runs successfully, the executor INSERTs one `document_edits` row keyed to the Talk's primary Document (`SELECT * FROM documents WHERE primary_talk_id = job.talk_id`) and the primary tab of that document (lowest `doc_tabs.sort_order` for the document). Payload: `op='insert'`, `block_id=null`, `after_block_id=<last block of that tab by sort_order, or NULL if the tab is empty>`, `base_list_version=<that tab's current list_version at insert time>`, `new_kind='p'`, `new_text=<agent's reply content>`, `new_attrs_json=null`, `source='job'`, `proposed_by_run_id=<the run.id>`, `proposed_by_agent_id` set from the targeted snapshot's `source_agent_id` with a single retry-as-NULL on FK violation (the live agent may have been deleted between snapshot and edit insert). Satisfies the op-shape check at line 328. The edit is always pending; the Forge accept path (or a user) applies it — there is no `auto_accept` mode.
- **Primary Document per Talk is the existing `documents.primary_talk_id`** reverse FK plus the unique partial index above (0/1 primary doc per talk). `12-jobs.md` does NOT add a `talks.primary_document_id` column — the existing reverse FK is the single source of truth. Jobs with `emit_document_append=true` block (`status='blocked', block_reason='no_primary_document'`) when the SELECT returns zero rows.
- **Post-insert cascade is intentional silent loss.** `document_edits.tab_id` and `after_block_id` FKs are `ON DELETE CASCADE`. If a user deletes the target tab or anchor block between the executor's INSERT and a human accepting the edit, the pending row is cascaded out. The job spec accepts this as a feature — the user manually destroyed the target — and tracks revisit in `12-jobs.md §9`.
- **Co-editors are per-tab** (`doc_tab_coeditors`) — matches the prototype (Draft vs Comp-table tabs have different editors). _(Default call on pressure-test #6; flip to per-document if you'd rather simplify.)_
- `format` is `('markdown','html')` (plain-text deferred). `kind` includes `code` — the editor must render it (the prototype currently ignores `code`; small UI follow-on).
- Indexes: `doc_blocks(tab_id, sort_order)`, `doc_blocks(document_id)`; `document_edits(document_id) where status='pending'`.

---

## 6. Context, tools, connectors

```sql
context_sources (
  id uuid pk, workspace_id uuid not null, talk_id uuid not null,
  kind text not null check (kind in ('document','url','file','past_talk','rule','news')),  -- primary doc is projected, not stored
  name text not null, source_document_id uuid, source_talk_id uuid,
  payload_ref text, extracted_text text, summary text, meta_json jsonb not null default '{}',
  include_in_prompt boolean not null default true, sort_order int,
  added_by_user_id uuid references users(id) on delete set null,
  created_at, updated_at,
  check (                                      -- kind ↔ source columns consistent
    (kind = 'document'  and source_document_id is not null and source_talk_id is null) or
    (kind = 'past_talk' and source_talk_id is not null     and source_document_id is null) or
    (kind in ('url','file','rule','news') and source_document_id is null and source_talk_id is null)
  ),
  foreign key (workspace_id, talk_id)            references talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, source_document_id) references documents(workspace_id, id) on delete cascade,
  foreign key (workspace_id, source_talk_id)     references talks(workspace_id, id)     on delete cascade
)

talk_tools (                                  -- per-Talk tool toggles; workspace_id for RLS (D7)
  workspace_id uuid not null, talk_id uuid not null, tool_id text not null, enabled boolean not null default false,
  primary key (talk_id, tool_id),
  foreign key (workspace_id, talk_id) references talks(workspace_id, id) on delete cascade
)

connectors (                                  -- workspace-global OAuth wiring (roadmap #5)
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  service text not null check (service in ('slack','gdrive','gmail','linear','github','notion')),
  authorized boolean not null default false, authorized_at timestamptz,
  secret_ref uuid,                             -- NOT workspace_provider_secrets (those are LLM keys); composite FK below
  config_json jsonb not null default '{}', created_at, updated_at,
  unique (workspace_id, id),
  foreign key (workspace_id, secret_ref) references connector_secrets(workspace_id, id) on delete set null (secret_ref)
)

connector_secrets (
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  enc_key_version int not null default 1, ciphertext text not null, created_at, updated_at,
  unique (workspace_id, id)                    -- composite-FK target (connectors.secret_ref, ssr_connections.secret_ref)
)      -- new OAuth-token store, encrypted at rest (JIT decrypt)

connector_bindings (
  id uuid pk, workspace_id uuid not null, connector_id uuid not null, talk_id uuid not null,
  target text, scope text[] not null default '{}', enabled boolean not null default true,
  unique (connector_id, talk_id),
  foreign key (workspace_id, connector_id) references connectors(workspace_id, id) on delete cascade,
  foreign key (workspace_id, talk_id)      references talks(workspace_id, id) on delete cascade
)
```

- **Tool ↔ connector dependency (P1-11):** a tool (e.g. `gdrive-read`) requires its service connector (`gdrive`) authorized. This mapping is a **static code catalog** (`tool_id → required service`), not a table; the runtime gates a tool if its connector isn't authorized.
- **Jobs' `source_scope_json.tool_ids` (`12-jobs.md` §3 / §7) validates against `talk_tools` at fire time.** The `tool_id text` shape is the contract: `source_scope_json` is `{ allow_web: bool, tool_ids: text[] }`. The scheduler's fire-time dependency check (`12-jobs.md` §5 Path A step 2) verifies every `tool_ids` entry has a matching row in `talk_tools(workspace_id, talk_id, tool_id)` with `enabled = true`; any missing/disabled tool → `jobs.status='blocked', block_reason='tool_not_enabled'`. Validation is at fire time (not create time) because the Talk's tool roster can change after the job is created.
- **Connector/SSR secrets get their own store** (`connector_secrets`) — D7 corrected the false reuse of `workspace_provider_secrets` (which is LLM provider keys). Same encrypt-at-rest + JIT-decrypt pattern (engineering-notes §1).
- Primary document is projected into Context from `documents.primary_talk_id`, not stored as a `context_sources` row (`08` §3.9).

---

## 7. Home — inbox, recommendations, news

Three deterministic systems + a bounded optimizer (`07`). All workspace-scoped except `home_news_items` (a shared item pool — `07` §8.4 privacy claim depends on news items carrying no workspace context). The `home_` prefix on every table follows `07` §10's naming.

```sql
activity_events (
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  actor_type text not null check (actor_type in ('user','agent','system','scheduler')),
  actor_id uuid,
  event_type text not null,
  talk_id uuid, document_id uuid, run_id uuid,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (workspace_id, talk_id)     references talks(workspace_id, id)     on delete cascade,
  foreign key (workspace_id, document_id) references documents(workspace_id, id) on delete cascade,
  foreign key (workspace_id, run_id)      references runs(workspace_id, id)      on delete cascade
)
create index on activity_events (workspace_id, created_at desc);

home_inbox_items (
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  type text not null check (type in (
    'agent_replied','round_completed','agent_asks_user','run_failed','doc_edits_ready',
    'connector_needs_auth','news_context_added','long_running_run','system_limit_reached',
    'forge_run_needs_review','job_output_ready','job_blocked'
  )),
  target_kind text check (target_kind in ('talk','document','connector','news','job','system')),
  target_json jsonb not null default '{}',                   -- shape per `07` §6.5 InboxTarget union; resolved IDs below mirror it for index access
  talk_id uuid, document_id uuid, run_id uuid, tab_id uuid,  -- resolved FK columns the optimizer + queries index against
  news_item_id uuid, connector_id uuid, job_id uuid,
  ref_id uuid,                                                -- natural-dedup key for at-least-once emits (`12-jobs.md` §6); see partial unique below
  severity text not null check (severity in ('info','action','blocking')),
  status text not null default 'unread' check (status in ('unread','read','resolved','dismissed','snoozed','expired')),
  title text not null, summary text, reason text,
  primary_action_json jsonb,                                  -- one `InboxAction` (`07` §6.5)
  secondary_actions_json jsonb not null default '[]',
  source_event_ids_json jsonb not null default '[]',
  group_key text,
  score numeric, algorithm_version text,
  snoozed_until timestamptz, resolved_at timestamptz,
  due_at timestamptz, expires_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (workspace_id, talk_id)         references talks(workspace_id, id)         on delete cascade,
  foreign key (workspace_id, document_id)     references documents(workspace_id, id)     on delete cascade,
  foreign key (workspace_id, run_id)          references runs(workspace_id, id)          on delete cascade,
  foreign key (workspace_id, document_id, tab_id)
    references doc_tabs(workspace_id, document_id, id)        on delete cascade,
  foreign key (workspace_id, connector_id)    references connectors(workspace_id, id)    on delete cascade,
  foreign key (workspace_id, job_id)          references jobs(workspace_id, id)          on delete restrict,
  foreign key (news_item_id)                  references home_news_items(id)              on delete cascade
)
create unique index home_inbox_items_dedup
  on home_inbox_items (workspace_id, type, ref_id) where ref_id is not null;
create index on home_inbox_items (workspace_id, status, created_at desc);

home_recommendation_candidates (
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in (
    'setup','failed-run','unresolved','synthesis','pending-edit','doc','cross-link','tool',
    'news-context','agent-change','recap','archive-cleanup','forge-suggestion','job','prompt-suggestion'
  )),                                                         -- mirrors home_recommendations.kind
  state_fingerprint text not null,                            -- hash of the input state for idempotent re-generation
  provenance_json jsonb not null default '{}',
  action_json jsonb not null default '{}',
  features_json jsonb not null default '{}',
  confidence numeric,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (workspace_id, kind, state_fingerprint)              -- generator dedup
)

home_recommendations (
  id uuid pk,
  candidate_id uuid references home_recommendation_candidates(id) on delete set null,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in (
    'setup','failed-run','unresolved','synthesis','pending-edit','doc','cross-link','tool',
    'news-context','agent-change','recap','archive-cleanup','forge-suggestion','job','prompt-suggestion'
  )),
  title text not null, why text,
  priority text not null check (priority in ('decide','improve','tidy')),
  score numeric, rank int,
  surface text not null default 'recommendations' check (surface in ('recommendations','news','inbox','search')),
  status text not null default 'active' check (status in ('active','dismissed','completed','expired','snoozed')),
  algorithm_version text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (workspace_id, id)
)
create index on home_recommendations (workspace_id, status, surface, rank);

home_recommendation_events (
  id bigserial pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  recommendation_id uuid not null references home_recommendations(id) on delete cascade,
  event_type text not null check (event_type in ('surfaced','clicked','dismissed','completed','expired')),
  position int,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now()
)
create index on home_recommendation_events (workspace_id, created_at desc);

home_news_topics (
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  talk_id uuid not null,
  summary text not null,                                       -- safe abstract, 1–2 sentences; never raw message/doc text (`07` §8.4)
  mode text not null check (mode in ('work_context','topic_feed','balanced')),
  decision_type text not null check (decision_type in (
    'pricing','launch','research','hiring','product','technical','market','other'
  )),
  keywords_json jsonb not null default '[]',
  entities_json jsonb not null default '[]',
  source_domains_json jsonb not null default '[]',             -- read by `07` §8.10.1 lexical relevance
  negative_terms_json jsonb not null default '[]',
  freshness_horizon_days int not null default 14,              -- read by `07` §8.10.1 freshness
  sensitivity text not null default 'normal' check (sensitivity in ('normal','private','do_not_search')),
  confidence numeric,
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, talk_id) references talks(workspace_id, id) on delete cascade
)

home_news_items (
  id uuid pk,                                                  -- shared global pool; no workspace_id (`07` §8.4)
  canonical_url text not null,
  title text not null, source text, source_domain text,
  published_at timestamptz,
  excerpt text,
  raw_provider_json jsonb,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (content_hash)                                        -- dedup the global pool
)
create index on home_news_items (published_at desc);

home_news_matches (
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  news_item_id uuid not null references home_news_items(id) on delete cascade,
  topic_id uuid not null,
  talk_id uuid not null,
  matched_on_json jsonb not null default '{}',                 -- which keywords/entities/domains the match fired on
  impact text not null check (impact in (
    'changes_assumption','adds_evidence','updates_competitor','introduces_risk',
    'provides_tactic','topic_update','community_signal','background_only'
  )),
  why_it_matters text,
  score numeric, confidence numeric,
  status text not null default 'active' check (status in (
    'active','snoozed','added_to_context','not_relevant','expired'
  )),
  algorithm_version text,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, topic_id) references home_news_topics(workspace_id, id) on delete cascade,
  foreign key (workspace_id, talk_id)  references talks(workspace_id, id)            on delete cascade,
  unique (workspace_id, news_item_id, topic_id)                -- one match row per (item, topic) per workspace
)
create index on home_news_matches (workspace_id, status, score desc);

home_interaction_events (
  id bigserial pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  surface text not null check (surface in ('recommendations','news','inbox','search')),
  item_id uuid,                                                -- recommendation, inbox item, news match — surface determines table
  event_type text not null,                                    -- open enum: see `07` §9.6
  rank int,                                                    -- rank position at time of event (optimizer audit input)
  algorithm_version text,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now()
)
create index on home_interaction_events (workspace_id, surface, created_at desc);

home_ranking_profiles (
  workspace_id uuid pk references workspaces(id) on delete cascade,
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
)

home_optimization_proposals (
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  surface text not null check (surface in ('recommendations','news','inbox','search')),
  status text not null default 'draft' check (status in ('draft','pending_review','accepted','rejected','applied')),
  problem_statement text not null,
  evidence_json jsonb not null default '{}',
  proposed_change text not null,
  affected_parameters_json jsonb not null default '{}',
  risk text not null default 'low' check (risk in ('low','medium','high')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
)

home_algorithm_versions (
  id uuid pk,
  surface text not null check (surface in ('recommendations','news','inbox','search')),
  status text not null default 'draft' check (status in ('draft','staging','active','paused','retired')),
  description text,
  config_json jsonb not null default '{}',
  config_hash text not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  activated_at timestamptz, retired_at timestamptz,
  unique (surface, config_hash)
)

home_algorithm_assignments (
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  surface text not null check (surface in ('recommendations','news','inbox','search')),
  algorithm_version_id uuid not null references home_algorithm_versions(id) on delete cascade,
  assignment_reason text not null check (assignment_reason in ('rollout','staging','control','experiment','forced')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (workspace_id, surface, ended_at)                     -- at most one open assignment per (workspace, surface)
)
create index on home_algorithm_assignments (algorithm_version_id);

-- Activation state can be a materialized view or computed projection (`07` §10.14).
-- Spec'd as a table here for the simple path; switching to a view is a non-breaking change.
home_activation_state (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
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
)
```

Design notes:

- **Naming.** `home_` prefix follows `07` §10. `activity_events` is bare because it's a generic event stream (Inbox + activity rails read it) rather than a Home-only surface.
- **Forge on Home.** `home_inbox_items.type = 'forge_run_needs_review'` + `home_recommendations.kind = 'forge-suggestion'` (resolves DOC-AUDIT #4). `07` §6.6 must add a `forge_run_needs_review` subsection and `07` §7.6 must add the `forge-suggestion` generator (tracked as G-07.P0.3).
- **Inbox idempotency for jobs (`12-jobs.md` §6 Inbox surfacing).** `home_inbox_items.ref_id` is the natural-dedup key for at-least-once emits. `job_output_ready` is emitted by the queue consumer on successful run completion and sets `ref_id = run.id` — `home_inbox_items_dedup` (unique partial index on `(workspace_id, type, ref_id)`) suppresses replays. `job_blocked` is emitted by the scheduler **synchronously** in the same transaction as the `jobs.status='blocked'` transition (no queue, no retry surface) and sets `ref_id = NULL` — each block episode produces a distinct row (a job that blocks, unblocks via user edit, then blocks again writes two rows; this is intentional). Other producers may set `ref_id` for their own dedup needs; the constraint is per-type.
- **Type set (12 values).** The CHECK on `home_inbox_items.type` is the complete v1 set. `07` §6.5 `InboxItemType` ships only 10 (missing `forge_run_needs_review`, `job_output_ready`, `job_blocked` and still listing `job_needs_review`) — reconcile per G-07.P0.1.
- **Recommendation kind set (15 values).** Includes both `forge-suggestion` (D6/§9) and `job`+`prompt-suggestion` (per `07` §7.6). Reconciliation: `07` §7.6 is currently missing `forge-suggestion` — fix per G-07.P0.2.
- **News privacy is structural.** `home_news_topics` stores only `summary` (safe abstract) + `keywords_json`/`entities_json`/`source_domains_json`/`negative_terms_json` (`07` §8.4). Raw message/doc text never leaves the Talk. `home_news_items` is a shared global pool with no workspace_id and zero workspace-derived data; only the `home_news_matches` join carries the workspace association.
- **News scoring formula.** `07` §8.10.1 is the single authoritative scoring implementation. It reads `topic.source_domains_json` (lexical relevance) and `topic.freshness_horizon_days` (freshness) and `topic.confidence` — all present in `home_news_topics`. `07` §8.10.1 must be read as canonical; do NOT re-derive scoring elsewhere.
- **Optimizer constraints.** The bounded-update optimizer (`07` §9.6) writes only to `home_ranking_profiles` (16 structured columns, all with sensible defaults — no opaque blob). Structural strategy changes go through `home_optimization_proposals` → admin review → `home_algorithm_versions` row → `home_algorithm_assignments` row. The `home_algorithm_assignments` unique on `(workspace_id, surface, ended_at)` keeps at most one open assignment per (workspace, surface); a rollout is a new row with the prior row's `ended_at` set.
- **Per-workspace + percentage rollout.** `home_algorithm_assignments` is the mechanism. A staging rollout sets `assignment_reason='staging'` for a subset of workspaces; an experiment sets `'experiment'` for a percentage; `'forced'` overrides for admins.
- **Reuse vs. rewrite.** Net-new (no Home tables in shipped DB). Deterministic generators first; Curator model-copy is flagged polish in `07`.

---

## 8. Jobs

Scheduled single-agent prompts. Full model + behavior: **[12-jobs.md](./12-jobs.md)** (resolves [DECISIONS](./DECISIONS.md) D6). A Job fires a normal `conversation` run on its Talk (`runs.job_id` set, `runs.trigger='scheduler'`); **history is `runs` filtered by `job_id`** — no separate `job_runs` ledger.

```sql
jobs (
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  talk_id uuid not null, created_by uuid not null references users(id) on delete restrict,
  title text not null, prompt text not null,
  agent_id uuid,                                               -- the one agent; nullable so agent-delete → block, not FK failure (P1)
  schedule_json jsonb not null,                                -- {kind:'interval'|'daily'|'weekly', ...} — `12-jobs.md` §4
  timezone text not null,                                      -- IANA; wall-clock schedules are DST-safe per `12-jobs.md` §4 (DST policy)
  emit_talk_message bool not null default true,                -- post the reply as a normal agent message in the Talk (`12-jobs.md` §3)
  emit_document_append bool not null default false,            -- propose an `insert` document_edits row against the primary doc's primary tab (`12-jobs.md` §3)
  check (emit_talk_message or emit_document_append),           -- a job must produce at least one output (`12-jobs.md` §3)
  source_scope_json jsonb not null default '{"allow_web":false,"tool_ids":[]}',  -- typed: { allow_web: bool, tool_ids: text[] } — runs are read-only; validated against talk_tools at fire time (`12-jobs.md` §3 / §7 + §6)
  status text not null default 'active' check (status in ('active','paused','blocked')),
  block_reason text                                            -- known values: 'agent_missing' | 'model_disabled' | 'no_primary_document' | 'tool_not_enabled' | 'connector_not_authorized' (`12-jobs.md` §7)
    check (block_reason is null or block_reason in ('agent_missing','model_disabled','no_primary_document','tool_not_enabled','connector_not_authorized')),
  catch_up text not null default 'skip' check (catch_up in ('skip','run_once')),
  next_due_at timestamptz, claimed_at timestamptz,             -- lease for FOR UPDATE SKIP LOCKED claiming (`12-jobs.md` §5)
  archived_at timestamptz,                                     -- "Delete" in UI sets this; row stays for history (`12-jobs.md` §6 archive flow)
  last_run_at timestamptz,
  last_run_status text check (last_run_status is null or last_run_status in ('completed','failed')),  -- terminal-only per `12-jobs.md` §6 (no 'queued'/'running')
  run_count int not null default 0 check (run_count >= 0),
  created_at, updated_at,
  check (                                                      -- lifecycle invariant per `12-jobs.md` §6: archive is orthogonal to status
    (archived_at is not null) or
    (status = 'active' and next_due_at is not null) or
    (status in ('paused','blocked') and next_due_at is null)
  ),
  unique (workspace_id, id),
  foreign key (workspace_id, talk_id)  references talks(workspace_id, id)  on delete cascade,
  foreign key (workspace_id, agent_id) references agents(workspace_id, id) on delete set null (agent_id)
)

-- Agent delete → atomic transition to blocked (replaces the "status <> 'active' or agent_id is not null" check
-- constraint, which would fire and ABORT the FK SET NULL action before status could be updated).
create function set_job_blocked_agent_missing() returns trigger
  language plpgsql as $$
begin
  new.status := 'blocked';
  new.block_reason := 'agent_missing';
  new.next_due_at := null;
  new.claimed_at := null;
  return new;
end;
$$;

create trigger jobs_block_on_agent_clear
  before update of agent_id on jobs
  for each row when (new.agent_id is null and old.agent_id is not null)
  execute function set_job_blocked_agent_missing();

-- RLS-preserving view for active-job hot paths (`12-jobs.md` §6 archive flow). `security_invoker = true` (PG 15+)
-- makes the view evaluate RLS in the caller's identity, not the view owner's; without it the
-- view would silently bypass workspace scoping.
create view jobs_active with (security_invoker = true) as
  select * from jobs where archived_at is null;
```

- **Output via the unified edit path:** `document_append` proposes a `document_edits` row (`source='job'`), review-gated by default — no second write path, no autonomous overwrite (§5, `12` §3).
- **Agent lifecycle:** `agent_id` is nullable + `on delete set null (agent_id)`. The `BEFORE UPDATE` trigger above runs _inside_ the FK action's row update, so the `SET NULL` and the `status='blocked'` flip are atomic — no window where an active job has a null agent. (An earlier `check (status <> 'active' or agent_id is not null)` was wrong: it would abort the FK action instead of letting it complete.)
- **"Agent must be in the Talk roster"** is a runtime invariant. A `before insert or update` trigger on `jobs` looks up `talk_agents` for the same `(workspace_id, talk_id, agent_id)` and rejects the write if the agent isn't on the roster. The trigger fires on `INSERT` and on any `UPDATE` of `talk_id` or `agent_id`. It does NOT fire when the agent is later removed from `talk_agents` (that's a DELETE on a different table) — on roster removal the scheduler's fire-time dep check (`12-jobs.md` §5 step 2) flips the job to `status='blocked'`.

  ```sql
  create function jobs_require_agent_in_roster() returns trigger
    language plpgsql as $$
  begin
    if new.agent_id is null then
      return new;  -- agent_id null is handled by set_job_blocked_agent_missing
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

  create trigger jobs_require_agent_in_roster
    before insert or update of talk_id, agent_id on public.jobs
    for each row execute function jobs_require_agent_in_roster();
  ```
- **Single-flight per job** is enforced in §3 by `runs_one_active_per_job` (partial unique on `runs(job_id) where status in ('queued','running','awaiting')`) — schema-guaranteed, not prose-only.
- **Scheduler robustness** (`12` §5): single-txn claim path (`for update skip locked` → fire-time dependency check → roster freeze → INSERT `runs` + `run_prompt_snapshots` → advance `next_due_at` → clear `claimed_at` → COMMIT, then dispatch outside the txn). Slot identity is enforced by `runs_one_active_per_job` + `runs_one_per_job_slot` in §3 — both partial unique. Stuck sweep transitions `queued` (5min threshold) AND `running` (1h) → `failed` with `error_json={"code":"stuck_*_swept"}` and `finished_at = now`; `awaiting` is not swept. Reuses the cron `scheduler.ts` + Queues mechanism; the executor data-access is reworked with the new runs table.
- **Archive vs lifecycle (`12-jobs.md` §6).** `archived_at` is orthogonal to `status` — an archived row exits the active-job hot path (the `jobs_active` view filters it) but its run history (`runs filtered by job_id`) stays queryable forever. The UI "Delete" action sets `archived_at` + `next_due_at = null`; hard delete is restricted (an admin path requires `run_count = 0` and goes through `runs.job_id` `ON DELETE RESTRICT` — see §3).
- **Bookkeeping is terminal-only (`12-jobs.md` §6).** `last_run_at`, `last_run_status`, and `run_count` are written exclusively when a run reaches a terminal status (`completed`, `failed` — including stuck-swept runs, which ARE terminal `failed`). The scheduler does NOT touch them at run-insert time; in-flight state is observable via the `runs` table directly. Manual run-now follows the same rule.
- **Talk/workspace hard-delete interaction.** Postgres processes the cascade fan-out per parent row but does not guarantee a strict order between sibling cascade paths. `jobs.talk_id` cascades from `talks` and `runs.job_id` is `RESTRICT` to `jobs`; if a Talk delete reaches `jobs` before `runs.talk_id` (also cascade from `talks`) clears the dependent run rows, the RESTRICT will block the cascade. The intended product semantic is that Talks and Workspaces with surviving jobs are archived (`talks.archived_at`), not hard-deleted; the `RESTRICT` is the schema's pressure toward archive. Hard delete with surviving jobs requires the admin path to archive or hard-delete the jobs first (jobs with `run_count = 0` can be hard-deleted directly; jobs with history cannot).
- Indexes: `jobs(status, next_due_at) where status='active' and archived_at is null` (archive-aware claim hot path); `runs(job_id, created_at)`.

---

## 9. Forge — autonomous content improvement

```sql
ssr_connections (                             -- per workspace (D7); admin-managed
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  ssr_org_id text not null, secret_ref uuid,    -- token in the connector secret store; composite FK below
  scopes text[] not null, connected_by uuid references users(id) on delete set null,
  created_at, updated_at,
  unique (workspace_id),                        -- one SSR connection per workspace
  unique (workspace_id, id),                    -- composite-FK target (improvement_runs)
  foreign key (workspace_id, secret_ref) references connector_secrets(workspace_id, id) on delete set null (secret_ref)
)

-- Synced read-only SSR assets, cached per workspace (browsed in the Audiences page; refreshed from Synthetical)
forge_personas        ( id uuid pk, workspace_id uuid not null, ssr_id text not null,
                        name text, title text, segment text, initials text, accent text, synced_at,
                        unique (workspace_id, ssr_id), unique (workspace_id, id) )
forge_reference_sets  ( id uuid pk, workspace_id uuid not null, ssr_id text not null,
                        name text, version text, anchor_count int, synced_at,
                        unique (workspace_id, ssr_id), unique (workspace_id, id) )
forge_questions       ( id uuid pk, workspace_id uuid not null, ssr_id text not null, text text, synced_at,
                        unique (workspace_id, ssr_id), unique (workspace_id, id) )

-- Saved audiences, composed IN ClawTalk (first-class — P0-3)
forge_audiences (
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null, note text,
  reference_set_id uuid, question_id uuid,
  created_at, updated_at,
  unique (workspace_id, id),
  foreign key (workspace_id, reference_set_id) references forge_reference_sets(workspace_id, id) on delete set null (reference_set_id),
  foreign key (workspace_id, question_id)      references forge_questions(workspace_id, id)      on delete set null (question_id)
)

-- Audience ↔ personas as a real join table (uuid[] can't FK — P1)
forge_audience_personas (
  workspace_id uuid not null, audience_id uuid not null, persona_id uuid not null,
  sort_order int, added_at timestamptz not null default now(),
  primary key (audience_id, persona_id),
  foreign key (workspace_id, audience_id) references forge_audiences(workspace_id, id) on delete cascade,
  foreign key (workspace_id, persona_id)  references forge_personas(workspace_id, id)  on delete cascade
)

improvement_runs (
  id uuid pk, workspace_id uuid not null,
  document_id uuid not null, tab_id uuid, target_block_id uuid,    -- scope: doc / tab / block (10's toggle); doc = both null
  talk_id uuid, owner_id uuid not null references users(id) on delete restrict,
  audience_id uuid,                                                -- nullable: ad-hoc objective
  objective_json jsonb not null,                                   -- resolved persona_ids, reference_set_id, question_id, scoring_config, fitness
  search_config_json jsonb not null,                               -- beamN, beamK, mutations, plateau_epsilon  (P1-8)
  target_score numeric, max_iterations int, budget_usd numeric,
  baseline_score numeric,
  status text not null default 'pending'
    check (status in ('pending','running','completed','plateaued','budget_exhausted','cancelled','failed')),
  stop_reason text,                                                -- human detail e.g. 'Plateaued at round 4'
  ssr_connection_id uuid, best_version_id uuid,
  created_at, updated_at,
  unique (workspace_id, id),                                       -- composite-FK target (held-out join, document_versions)
  foreign key (workspace_id, document_id)       references documents(workspace_id, id)        on delete cascade,
  foreign key (workspace_id, document_id, tab_id)
    references doc_tabs(workspace_id, document_id, id)             on delete cascade,
  foreign key (workspace_id, document_id, target_block_id)
    references doc_blocks(workspace_id, document_id, id)           on delete cascade,
  foreign key (workspace_id, talk_id)            references talks(workspace_id, id)            on delete set null (talk_id),
  foreign key (workspace_id, audience_id)        references forge_audiences(workspace_id, id)  on delete set null (audience_id),
  foreign key (workspace_id, ssr_connection_id)  references ssr_connections(workspace_id, id)  on delete set null (ssr_connection_id),
  foreign key (workspace_id, best_version_id)
    references document_versions(workspace_id, id) deferrable initially deferred              -- back-edge to §9 table below
)

-- Held-out personas per run, persisted for reproducibility (uuid[] can't FK — P1)
improvement_run_held_out_personas (
  workspace_id uuid not null, run_id uuid not null, persona_id uuid not null,
  primary key (run_id, persona_id),
  foreign key (workspace_id, run_id)     references improvement_runs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, persona_id) references forge_personas(workspace_id, id)   on delete cascade
)

document_versions (                           -- one per scored candidate
  id uuid pk, workspace_id uuid not null, run_id uuid not null,
  iteration int not null, candidate_id text not null,
  parent_version_id uuid,                                          -- null = baseline; composite FK below (same workspace)
  body_markdown text not null, mutation_strategy text,
  composite_score numeric, held_out_score numeric,                -- 0–10 scale (see scales note)
  per_persona_json jsonb,                                          -- { personaId: { likert:int[5] (1–5), verbatim, score } }
  ssr_job_id text, decision text check (decision in ('keep','discard','frontier','winner')), decision_reason text, created_at,
  unique (workspace_id, id),                                       -- composite-FK target (improvement_runs.best_version_id, self-FK)
  unique (run_id, candidate_id),                                   -- one row per (run, candidate) — SSR result reproducibility
  foreign key (workspace_id, run_id)            references improvement_runs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, parent_version_id) references document_versions(workspace_id, id) on delete set null (parent_version_id)
)
```

Design notes:

- **Audiences + synced assets (P0-3):** `forge_audiences` is a first-class saved entity; personas/reference-sets/questions are **cached per workspace** from Synthetical (read-only, `synced_at`). Audience↔persona membership is the real join table `forge_audience_personas` (uuid[] arrays can't FK).
- **Score scales (P1-9):** composite/held-out/`feedback` scores are **0–10**; per-persona Likert distributions are **1–5** five-bucket arrays (their mean is 1–5). `per_persona_json` carries both; the SSR scale is 5-bucket (the prototype's `ssr-likert-4` label is wrong — treat as 5).
- **Run reproducibility (P1-8):** `search_config_json` (beam N/K, enabled mutations, plateau ε) persists on the run; the held-out persona set persists in `improvement_run_held_out_personas` (one row per persona, real FK to `forge_personas`).
- **SSR call idempotency:** each scored candidate is unique on `(run_id, candidate_id)`; the SSR `idempotency_key` ClawTalk sends per round (engineering-notes / `09` §7.2) is recoverable from `(run_id, iteration, candidate_id)`. A durable SSR request/result envelope (full request/response audit) is deferred — see §13.
- **Scope** is tab/block-aware (`tab_id` + `target_block_id`); whole-doc = both null. Rewriter + critic are `is_system` agents (D3); the loop runs through the normal run path with `run_kind='content_improvement'`. Promotion reuses `document_edits` (`source='forge'`). Streaming reuses `event_outbox` (`improvement_round_scored` / `_version_kept` / `_run_finished`).
- **Version body retention.** `document_versions.body_markdown` stores one full candidate body per scored attempt — fine for v1 (a Forge run produces 10s of candidates). Add retention (drop non-frontier bodies after run completes) or compression once Forge runs routinely produce 100+ candidates.
- Indexes: `improvement_runs(workspace_id, document_id)`, `document_versions(run_id)`.

---

## 10. Audit & analytics

```sql
audit_events (
  id uuid pk, workspace_id uuid not null,
  actor_user_id uuid references users(id) on delete set null,
  entity_type text, entity_id uuid, action text, payload_json jsonb, created_at
)
create index on audit_events (workspace_id, created_at desc);
create index on audit_events (workspace_id, entity_type, entity_id, created_at desc);
```

Append-only; every state mutation (`04` §16). Distinct from `activity_events` (Home feed). Partition by month once monthly volume crosses the partition threshold (rule of thumb: a few million events / month). `entity_id` is intentionally FK-less — it points at heterogeneous entities (talk, run, doc, agent, …).

---

## 11. Reused infrastructure (kept) — corrected by D7

**Kept (correct for the target):**

- **Cloudflare platform:** Workers, Queues (run dispatch), Durable Objects (`UserEventHub`), Hyperdrive, `scheduler.ts` cron.
- **Event delivery:** `event_outbox` → `UserEventHub` DO (WebSocket Hibernation). All streaming rides this.
- **LLM provider layer:** `llm_providers`, `llm_provider_models` (composite PK, seeds `llm_models`), `llm_provider_secrets`, `workspace_provider_secrets` — **shared LLM keys**, encrypted at rest, JIT decrypt.

**Explicitly NOT reused (D7 corrections):**

- `idempotency_cache` is an **HTTP-response cache** (`idempotency_key,user_id,method,path` → `status_code`/`response_body`) — _not_ a Forge batch-retry store. Forge dedupes via the SSR `idempotency_key` it already sends per round + its own run/version records.
- `workspace_provider_secrets` is **LLM keys** — _not_ connector/SSR OAuth. Those use the new `connector_secrets` (§6, §9).
- The legacy `talk_runs` + its executor data-access are **reworked** (thread/channel-entangled); only the orchestration _logic_ is salvaged.

Everything else from the current schema is superseded. The explicit drop list (every legacy table the greenfield migration removes) follows.

### 11.1 Drop list (greenfield migration step 1)

Run in a single transaction at the top of the migration. CASCADE handles intra-list FKs; the kept tables (above) have no FK dependency on any dropped table, so they're unaffected.

```sql
-- Kept tables not listed here. Reference: §11 kept list.
drop table if exists
  public.content_edits,
  public.content_proposals,
  public.contents,
  public.talk_state_entries,
  public.talk_resource_bindings,
  public.talk_message_attachments,
  public.talk_outputs,
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
```

The list reflects the migration snapshot at `0036_agent_model_auto_upgrade.sql`; any tables added between migration write-time and apply-time get added to this list.

**Kept tables** (do NOT drop): `users`, `event_outbox`, `idempotency_cache`, `settings_kv`, `provider_oauth_states`, `llm_providers`, `llm_provider_models`, `llm_provider_secrets`, `llm_provider_verifications`, `llm_ttft_stats`, `workspace_provider_secrets`, `workspace_provider_verifications`.

`users` is kept structurally but is `ALTER TABLE`'d in step 2 of the migration to add the columns §1 requires (`avatar_color`, `initials`) and drop any columns the new model doesn't use; existing rows are preserved.

---

## 12. RLS model — corrected (D7)

- Identity: **`auth.uid()`** = `request.jwt.claims->>'sub'`, set by `withUserContext` (`set_config('request.jwt.claims', …)` + `set local role authenticated`). **No `app.*` GUC.**
- **Membership helper (security definer).** A single function reads `workspace_members` once, bypasses RLS, and is reused by every policy:

  ```sql
  create function is_workspace_member(ws uuid) returns boolean
    language sql stable security definer set search_path = public as $$
      select exists (
        select 1 from workspace_members
        where workspace_id = ws and user_id = auth.uid()
      )
    $$;

  create function is_workspace_admin(ws uuid) returns boolean
    language sql stable security definer set search_path = public as $$
      select exists (
        select 1 from workspace_members
        where workspace_id = ws
          and user_id = auth.uid()
          and role in ('owner','admin')
      )
    $$;
  ```

  Both functions are `security definer` to bypass RLS recursion on `workspace_members` (a policy on table T can't safely subselect from T). The membership lookup runs once, plan-cached. `is_workspace_admin` returns true iff the caller is `owner` or `admin`; `member` and `guest` get false.

- Every workspace-owned table: `enable row level security`. Canonical visibility predicate:

  ```sql
  using ( is_workspace_member(workspace_id) )
  ```

- **Write-policy roles.** Most workspace writes (creating Talks/Documents/Agents/Jobs/messages, editing prompts, toggling tools, accepting `document_edits`) gate on `is_workspace_member`. Admin-only writes gate on `is_workspace_admin`: invite/remove members, update member roles, manage connectors (authorize/revoke), delete the workspace, transfer ownership, approve `home_optimization_proposals`, manage `home_algorithm_versions`/`home_algorithm_assignments`. The full policy text for each table is generated mechanically from this rule + the table's column set; the convention is documented in [the build plan](./05-build-plan.md).
- **`workspace_members` itself** uses non-recursive policies: `using (user_id = auth.uid())` for reads (a member sees their own memberships); `using (is_workspace_admin(workspace_id))` for writes.
- **Join tables carry `workspace_id`** (`talk_agents`, `talk_tools`, `team_composition_agents`, `doc_tab_coeditors`, `connector_bindings`, `talk_reads`, `forge_audience_personas`, `improvement_run_held_out_personas`) so the predicate applies directly — no fragile parent joins.
- **Composite FKs** prevent cross-workspace references (a child's `(workspace_id, parent_id)` must match the parent) on every snapshot/run/edit/Forge table that carries denormalized `workspace_id`.
- `documents`/`doc_tabs`/`doc_blocks`/`document_edits` scope by `workspace_id` directly — a concrete win over the legacy contents-via-`talk_threads` RLS (D4).
- **System agents** (`is_system`) are readable by the runtime but filtered from user-facing reads at the query layer, not RLS.

### 12.1 Canonical policy pattern (worked example)

Every workspace-owned table follows this pattern with the table name substituted. The example uses `talks`; the migration generates one block per workspace-owned table by substitution.

```sql
alter table public.talks enable row level security;

-- Read: any workspace member sees rows in their workspaces.
create policy talks_read on public.talks
  for select using ( is_workspace_member(workspace_id) );

-- Write: any workspace member can insert/update/delete content rows.
-- `with check` on insert/update prevents writing rows into workspaces the caller doesn't belong to.
create policy talks_write on public.talks
  for all
  using       ( is_workspace_member(workspace_id) )
  with check  ( is_workspace_member(workspace_id) );
```

Member-write applies to: `folders`, `talks`, `talk_agents`, `talk_tools`, `talk_reads`, `messages`, `runs`, `talk_agent_snapshots`, `run_prompt_snapshots`, `context_sources`, `agents` (non-system), `agent_feedback_events`, `team_compositions`, `team_composition_agents`, `documents`, `doc_tabs`, `doc_blocks`, `document_edits`, `doc_tab_coeditors`, `jobs`, `improvement_runs`, `document_versions`, `improvement_run_held_out_personas`, `forge_audiences`, `forge_audience_personas`, `home_inbox_items`, `home_recommendations`, `home_recommendation_candidates`, `home_recommendation_events`, `home_news_topics`, `home_news_matches`, `home_interaction_events`, `home_activation_state`, `activity_events`.

### 12.2 Admin-only write exceptions

Eight tables replace the member-write policy with an admin-write policy. The read policy stays `is_workspace_member`.

```sql
-- Replaces talks_write style for the six admin-managed tables.
-- (Example: workspace_members; the pattern is identical for the others.)
create policy workspace_members_write on public.workspace_members
  for all
  using       ( is_workspace_admin(workspace_id) )
  with check  ( is_workspace_admin(workspace_id) );
```

Apply to: `workspace_members`, `connectors`, `connector_bindings`, `connector_secrets`, `home_optimization_proposals`, `home_algorithm_versions`, `home_algorithm_assignments`, `home_ranking_profiles` (writes only — reads remain member).

The `workspace_members` read policy is the one exception to the standard read pattern (it can't recurse on itself):

```sql
create policy workspace_members_read on public.workspace_members
  for select using ( user_id = auth.uid() );
```

### 12.3 System-agent visibility on `agents`

`agents.is_system = true` rows (Forge rewriter/critic — D3) are filtered at the query layer (accessor / `GET /agents` handler), not in RLS. The RLS policy on `agents` is the standard member-read/member-write pattern; the runtime simply doesn't expose system rows to user surfaces.

### 12.4 Shared pool: `home_news_items`

`home_news_items` has no `workspace_id` (the global news pool — `07` §8.4 privacy). Two policies cover the shape: read open to any authenticated user (`using (true)`); writes restricted to service role (the news ingest worker). Standard member-read pattern does not apply.

```sql
alter table public.home_news_items enable row level security;
create policy home_news_items_read on public.home_news_items
  for select using ( true );
-- No write policy → only service role (which bypasses RLS) can insert/update.
```

### 12.5 Service-role bypass

Scheduler (`scheduler.ts`), queue consumer (`queue-consumer.ts`), outbox writers, Forge improvement-run executor, and news ingest all need to write across workspaces without a user identity. The mechanism: these paths connect to Postgres **without** the `set local role authenticated` swap that user-scoped requests perform via `withUserContext`. They run as the connection-owning role (configured with `bypassrls` in Supabase), so policies are skipped.

```sql
-- One-time setup; not part of the schema migration but enforced by ops:
-- The "service" role used by scheduler/consumer/outbox has bypassrls.
-- alter role app_service with bypassrls;   -- example; actual role name set in Supabase config
```

The application contract: any code path that needs to mutate cross-workspace state MUST run inside the service-role connection (Cloudflare Workers + Hyperdrive: the `DB` binding points at the service role; `withUserContext` is the per-request opt-IN to RLS-enforced identity). Code paths that handle user input MUST call `withUserContext(authUserId)` so RLS engages. Missing `withUserContext` on a user-input path is the bug to grep for.

### 12.6 Verification

§14 tests #1, #10, #11 cover the policy contract: cross-workspace insert/select rejection, membership predicate hides other workspaces, `workspace_members` non-recursive policy.

---

## 13. Open items

Resolved: D6 (§8 jobs finalized via `12-jobs.md`); D7 (run model, RLS plumbing, model catalog, role-template storage, SSR scope, false-reuse claims, P0 product-shape gaps); and a follow-on tenant-consistency pass on 2026-05-29 — `ON DELETE SET NULL` syntax, snapshot_group_id, doc-tab block consistency, edit CAS for inserts, jobs single-flight, Forge audience join tables, RLS membership helper.

Remaining (taste calls + follow-ups, not blockers):

- **Score scale** — confirm composite 0–10 vs Likert 1–5 with SSR (assumed here; §9).
- **Per-tab vs per-document co-editors** — defaulted **per-tab** (§5); confirm or simplify.
- **SSR asset freshness** — defaulted **cache + sync** (§9); alternatively fetch-live each session.
- **API + 03 follow-ons** — add Forge endpoints + move-block endpoint to `04`, drop SSE; point `04` §14 at `llm_models`; seed role templates from `03` with the "Samira"/handle fixes.

Remaining (deferred to dedicated reviews — these block parts of the schema):

- ~~**Home tables (§7) — schema-level expansion.**~~ **Closed 2026-05-29 (G-11.P0.3).** §7 absorbed the full `07` §10 column set: `home_inbox_items` with primary/secondary actions + source_event_ids + snoozed_until/resolved_at + the dedicated FK columns (`news_item_id`/`connector_id`/`job_id`) + uniform resolution columns (`talk_id`/`document_id`/`run_id`/`tab_id`) + `ref_id` dedup; `home_recommendation_candidates` with `state_fingerprint`/`provenance_json`/`action_json`/`features_json`/`confidence`/`expires_at`; `home_recommendations` with `candidate_id`/`rank`/`surface`; `home_recommendation_events`; expanded `home_news_topics` (`source_domains_json`/`freshness_horizon_days`/`confidence`); shared-pool `home_news_items` (no workspace_id); expanded `home_news_matches`; `home_interaction_events` with `event_type`/`rank`/`algorithm_version`/`metadata_json`; `home_ranking_profiles` with 16 structured columns (not opaque JSON); `home_optimization_proposals`; `home_algorithm_versions`+`home_algorithm_assignments` for per-workspace + percentage rollout; `home_activation_state`.
- **Durable SSR request/result envelope (§9).** Per-round idempotency is recoverable from `(run_id, iteration, candidate_id)` (good for reproducibility), but a full SSR request/response audit table would help debugging — defer until SSR contract details are nailed.

---

## 14. Verification — what proves the schema works

The spec asserts runtime invariants throughout. The migration is "done" only when every invariant below has a passing test. Each row is one negative test (the failure case the constraint is supposed to catch); a positive test for normal usage is implied.

| #   | Invariant                                                         | Section                | Negative test (must fail or be rejected)                                                                                                                                                         |
| --- | ----------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Composite FK blocks cross-workspace references                    | §0, §12                | Insert a child row with `workspace_id = A` referencing a parent row in workspace B → FK violation                                                                                                |
| 2   | Composite FK blocks cross-Talk references on runs/messages        | §3                     | Run in Talk A with `trigger_message_id` from a message in Talk B → FK violation                                                                                                                  |
| 3   | Composite FK blocks cross-Talk references on snapshot attribution | §3                     | Run in Talk A with `agent_snapshot_id` from a snapshot in Talk B → FK violation                                                                                                                  |
| 4   | Acting agent snapshot is inside the run's roster group            | §3                     | Run with `snapshot_group_id = G1` and `agent_snapshot_id` from a snapshot in `snapshot_group_id = G2` → FK violation                                                                             |
| 5   | Composite FK blocks cross-tab block references                    | §5                     | Pending edit with `tab_id = T1` and `block_id` from a block in `tab_id = T2` (same document) → FK violation                                                                                      |
| 6   | `base_block_version` CAS marks late edits superseded              | §5                     | Two concurrent replace edits for the same block; the second to commit is marked `superseded` rather than overwriting                                                                             |
| 7   | `base_list_version` CAS for inserts at `after_block_id`           | §5                     | Two concurrent insert edits at the same anchor; one wins, one is `superseded`; tab's `list_version` bumps once                                                                                   |
| 8   | Single-flight per job                                             | §3 partial unique + §8 | Two scheduler/manual races for the same job → exactly one queued run; second insert violates `runs_one_active_per_job`                                                                           |
| 9   | Job `agent-delete` flips status atomically                        | §8 trigger             | Delete an agent referenced by an active job → in the same transaction, the job's `status` is `blocked` and `block_reason = 'agent_missing'`                                                      |
| 10  | RLS membership predicate hides other workspaces                   | §12                    | Caller with `auth.uid()` in workspace A queries workspace B's rows → zero rows returned (not an error)                                                                                           |
| 11  | `workspace_members` policy avoids recursion                       | §1, §12                | A `workspace_members` read with no infinite-loop / no plan-error; verify with `EXPLAIN` that the policy uses `auth.uid()` directly, not the helper                                               |
| 12  | Snapshot group reconstruction                                     | §3, §4                 | Given a `runs.snapshot_group_id`, `SELECT * FROM talk_agent_snapshots WHERE snapshot_group_id = ?` returns the historical roster (count matches the live roster at the time the run was created) |
| 13  | `ON DELETE SET NULL (col)` syntax behaves correctly               | §0, §2, §5, §8, §9     | Delete a folder with linked Talks → talks' `folder_id` nulled, `workspace_id` unchanged (i.e., the per-column SET NULL works, not the default nulling of all FK columns)                         |
| 14  | Deferrable FK cycles permit multi-row insert                      | §0, §3                 | Within a transaction `SET CONSTRAINTS ALL DEFERRED`, insert a run + a triggering message that reference each other → both succeed; without `DEFERRED`, the second insert violates                |
| 15  | `doc_tabs` last-tab-can't-delete trigger                          | §5                     | Delete the only remaining tab of a document → trigger raises `CT001`; document with 2+ tabs allows tab delete (any non-last)                                                                       |
| 16  | `jobs` agent-must-be-in-roster trigger                            | §8                     | INSERT a `jobs` row with `agent_id` not present in `talk_agents` for the same `(workspace_id, talk_id)` → trigger raises `CT002`; INSERT with a matching roster row succeeds                       |
| 17  | `jobs` lifecycle CHECK invariant                                  | §8                     | Set `archived_at = null AND status = 'active' AND next_due_at = null` → CHECK rejects; (`archived_at not null`) variants always pass regardless of status/next_due_at                              |
| 18  | `runs.job_id` ON DELETE RESTRICT                                  | §3, §8                 | `DELETE FROM jobs WHERE id = J` where any `runs.job_id = J` exists → FK violation; archive path (`UPDATE jobs SET archived_at = now()`) succeeds in the same state                                  |
| 19  | `runs.trigger='user'` rejects job_id/scheduled_for                | §3                     | INSERT a run with `trigger='user'` and (`job_id` not null OR `scheduled_for` not null) → CHECK violation                                                                                           |
| 20  | `document_edits` accept bumps version                             | §5 trigger             | UPDATE a pending `document_edits` row to `status='accepted'` → trigger bumps `doc_blocks.version` (op='replace'/'delete') or `doc_tabs.list_version` (op='insert'); peer pending edits on the same target are marked `superseded` |
| 21  | `connectors.secret_ref` SET NULL on `connector_secrets` delete    | §6                     | Delete a `connector_secrets` row → the referencing `connectors.secret_ref` is nulled; `workspace_id` on `connectors` is unchanged (per-column SET NULL syntax)                                     |
| 22  | `improvement_runs ↔ document_versions` deferred-FK cycle          | §9                     | Within a transaction, INSERT `improvement_runs` (referencing a future `best_version_id`) + `document_versions` (referencing the new run) → both succeed; outside the transaction, the second insert violates |
| 23  | `home_inbox_items_dedup` partial unique                           | §7                     | Two INSERTs with the same `(workspace_id, type, ref_id)` and `ref_id IS NOT NULL` → second rejects; the same pair with `ref_id IS NULL` does NOT conflict (`job_blocked` writes distinct rows)        |
| 24  | `agents.is_system` query-layer filter                             | §4                     | `GET /agents` (without `?includeSystem=true`) returns only non-system rows; with the query param, system rows surface; PATCH/DELETE on a system row returns 403                                     |

The test suite lives alongside the migrations (Vitest + `pg-tap` style assertions, or raw SQL test files run against `supabase db reset`). Each migration commit that touches a constraint adds or updates the corresponding row above.

Two test types not in the table because they're integration-level rather than schema-level: **(a)** end-to-end Talk turn → run → message → outbox → DO stream (the queue/DO/Worker contract, not a schema invariant); **(b)** the `12-jobs.md` scheduler stale-lease sweep (claim crash recovery). Both live in `src/clawtalk/talks/*.test.ts` once the executor is reworked.
