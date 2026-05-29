> **Status:** canonical (greenfield schema — the authoritative DB design). Build posture is [DECISIONS.md](./DECISIONS.md) D0 (greenfield). This doc owns the **tables**; [08-information-architecture.md](./08-information-architecture.md) owns IA rules/cardinalities, `06`/`07`/`09` own their domain behavior.
> Precedence + orientation: [README.md](./README.md) · decisions: [DECISIONS.md](./DECISIONS.md) · terms: [GLOSSARY.md](./GLOSSARY.md).

# ClawTalk — Canonical Data Model

A clean-slate schema for the rebuilt product. Designed for the canonical hierarchy

> **Workspace → Folder (optional) → Talk + Document (optional)** · multi-workspace · no Threads

on Postgres (Supabase) behind Cloudflare Workers ([DECISIONS](./DECISIONS.md) D1). This is the single source of truth for tables; behavior lives in the spec docs it cross-references.

It is **greenfield** (D0): the names and shapes here are designed for the new model, not inherited from the current `contents`/`talk_threads`/`registered_agents` tables. Where keeping existing infra is the *better* engineering choice (not just continuity), this doc says so explicitly under **Reuse vs. rewrite** in each section.

---

## 0. Conventions

- **PKs:** `id uuid primary key default gen_random_uuid()` (use a v7/time-ordered default if available — index locality on insert). API exposes typed opaque IDs (`ws_`, `f_`, `t_`, `d_`, `a_`, …) derived from the uuid per `04-api-contracts.md` §0.
- **Tenancy:** every workspace-owned row carries `workspace_id uuid not null references workspaces(id) on delete cascade`. It is the first column after `id` and the leading column of most indexes.
- **Timestamps:** `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()` (touch via trigger). All UTC.
- **Soft-delete:** only where recovery is a product feature (Talks: `archived_at`). Everything else hard-deletes via cascade. No tombstones "just in case" (D0).
- **Enums:** Postgres `enum` types for closed sets that rarely change (roles, run status); `text` + check constraint for sets that evolve. Stated per-table below.
- **Flexible payloads:** `jsonb` for genuinely open shapes (objective configs, manifests, event payloads) — never as an escape hatch for columns we know.
- **Ordering:** user-orderable lists use `sort_order int` (gap-filled), unique per parent.
- **RLS:** every table has Row-Level Security on, scoped through workspace membership. The Worker sets the request's user/workspace via the existing `withUserContext` (`src/db.ts`) so policies read `current_setting('app.user_id')` / `app.workspace_id`. See §12.

**Reuse vs. rewrite (global).** Keep the platform-level infra — `withUserContext` RLS plumbing, the `event_outbox` → `UserEventHub` DO stream, Cloudflare Queues, `idempotency_cache`, and the LLM provider/secret tables (§11). These are correct and rebuilding them buys nothing. Rewrite everything product-shaped (talks/threads/contents/agents) to the model below.

---

## 1. Identity & tenancy

```sql
users (
  id            uuid pk,
  email         citext unique not null,
  name          text not null,
  avatar_color  text,
  initials      text,
  created_at, updated_at
)

workspaces (
  id            uuid pk,
  name          text not null,            -- 'Oxbow & Co.'
  slug          text unique,
  owner_id      uuid not null references users(id),
  plan          text not null default 'team'  check (plan in ('team','enterprise')),
  created_at, updated_at
)

workspace_members (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  role          workspace_role not null default 'member',  -- enum: owner|admin|member
  created_at,
  primary key (workspace_id, user_id)
)
```

- A user belongs to ≥1 workspace; on signup, create the user's first workspace and an `owner` membership.
- `workspace_role` is the RBAC root (`01` §1.1). Owners manage members + billing; admins manage agents/connectors; members use.
- **Reuse vs. rewrite.** `users` largely exists today and is fine to keep. `workspaces` + `workspace_members` are **new** (today's app is user-owned with no tenant table) — build them as the spine; everything else FKs to `workspace_id`.

---

## 2. Organization — folders

```sql
folders (
  id            uuid pk,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  title         text not null,
  sort_order    int not null,
  created_at, updated_at
)
```

- Flat, no nesting (`08` §3.2). A Talk has 0/1 folder; folderless Talks are **Unfiled** (a view, not a row).
- Index: `(workspace_id, sort_order)`.
- Delete: default reparents Talks to Unfiled (`folder_id = null`); destructive option archives contained Talks (handled in app, one transaction).

---

## 3. Talks, messages, runs

```sql
talks (
  id              uuid pk,
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  folder_id       uuid references folders(id) on delete set null,   -- null → Unfiled
  title           text not null,
  mode            talk_mode not null default 'ordered',  -- enum: ordered|parallel
  rounds_limit    int not null default 3,                -- 1|2|3|5 in UI
  created_by      uuid not null references users(id),
  archived_at     timestamptz,                           -- soft-delete (recoverable)
  last_activity_at timestamptz not null default now(),
  created_at, updated_at
)

messages (
  id            uuid pk,
  workspace_id  uuid not null,
  talk_id       uuid not null references talks(id) on delete cascade,
  round         int not null,
  author_kind   text not null check (author_kind in ('user','agent')),
  author_user_id  uuid references users(id),             -- when user
  agent_id        uuid references agents(id),            -- when agent (snapshot id, see §4)
  run_id          uuid references runs(id),              -- when agent
  body           text,                                   -- final committed text
  attachments_json jsonb not null default '[]',
  created_at
)

runs (
  id            uuid pk,
  workspace_id  uuid not null,
  talk_id       uuid not null references talks(id) on delete cascade,
  round         int not null,
  agent_snapshot_id uuid not null references talk_agent_snapshots(id),
  status        run_status not null default 'queued',    -- enum: queued|running|awaiting|completed|failed|cancelled
  model_id      text not null references llm_models(id),
  tokens_in     int, tokens_out int,
  prompt_snapshot_id uuid references run_prompt_snapshots(id),
  error_json    jsonb,
  started_at, finished_at, created_at
)
```

- **Rounds are derived, not a table** — `round int` on messages/runs is enough; a "round" is the set of agent runs sharing `(talk_id, round)`. Editor closes the round with a synthesis (`03-agents.md` §5). Avoids a near-empty `rounds` table.
- **Team membership** is the per-Talk agent snapshot set (§4) — no separate `talk.team[]` array; the snapshots *are* the roster.
- Tool toggles live on the Talk as `talk_tools` (§6), not a JSON blob, so they're queryable.
- Indexes: `talks(workspace_id, folder_id) where archived_at is null`; `messages(talk_id, round, created_at)`; `runs(talk_id, round)`, `runs(status) where status in ('queued','running')`.
- **Reuse vs. rewrite.** Streaming/event delivery reuses `event_outbox` + the `UserEventHub` DO (§11) — don't rebuild. The run orchestration logic in `src/clawtalk/talks/` (executor, queue-consumer, scheduler) is close to right; rewrite only the data shape (drop threads, snapshot model) and keep the proven queue/DO mechanics. Threads tables are **not** carried forward.

---

## 4. Agents

```sql
llm_models (                                   -- single model catalog (resolves audit #10)
  id            text pk,                        -- 'claude-opus-4-6', 'gpt-5-pro', 'gemini-2.5-pro'
  provider      text not null,                  -- 'anthropic'|'openai'|'google'|...
  display_name  text not null,
  enabled       boolean not null default true,
  capabilities_json jsonb not null default '{}' -- streaming, tools, grounding
)

agent_role_templates (                          -- the 5 fixed roles; code fixture OR table
  role_key      text pk,                         -- strategist|critic|researcher|editor|quant
  default_name, default_handle, default_initials, default_accent, default_accent_dark,
  default_model_id text references llm_models(id),
  default_temperature numeric not null,          -- temperature LIVES here + on agents (resolves audit #9)
  job           text not null,                   -- read-only role description
  system_prompt text not null,                   -- verbatim from 03-agents.md
  method_default text[] not null,
  version       int not null
)

agents (
  id            uuid pk,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  role_key      text not null references agent_role_templates(role_key),
  name          text not null,                   -- editable
  handle        text not null,                   -- '@strat'
  initials      text not null,
  accent        text not null, accent_dark text,
  model_id      text not null references llm_models(id),
  default_model_id text not null references llm_models(id),
  temperature   numeric not null,                -- editable; seeded from role template
  persona       text,                            -- editable
  focus         text,                            -- editable
  method        text[] not null default '{}',    -- editable
  capabilities  text[] not null default '{}',    -- gated by Talk tools at runtime
  is_default    boolean not null default false,  -- one of the 5 ship-with-app
  is_custom     boolean not null default false,  -- post-v1
  is_system     boolean not null default false,  -- Forge rewriter/critic etc. — hidden from roster (D3)
  enabled       boolean not null default true,
  created_from_template_version int,
  created_at, updated_at
)

team_compositions (
  id uuid pk, workspace_id uuid not null, name text not null, description text,
  is_default boolean not null default false, runs_count int not null default 0,
  created_at, updated_at
)
team_composition_agents ( team_id uuid, agent_id uuid, sort_order int, primary key (team_id, agent_id) )

talk_agent_snapshots (                           -- immutable per-run roster snapshot (06 §3.4)
  id uuid pk, workspace_id uuid not null, talk_id uuid not null references talks(id) on delete cascade,
  source_agent_id uuid references agents(id),
  role_key text not null, name text, handle text, initials text, accent text, accent_dark text,
  model_id text not null, temperature numeric not null,
  persona text, focus text, method text[],
  sort_order int not null, role_template_version int, global_policy_version int,
  created_at
)

run_prompt_snapshots (                           -- exact prompt provenance per run (06 §3.5)
  id uuid pk, workspace_id uuid not null, run_id uuid not null references runs(id) on delete cascade,
  talk_id uuid not null, agent_snapshot_id uuid not null references talk_agent_snapshots(id),
  model_id text not null, provider text not null,
  global_policy_version int, role_template_version int, prompt_assembly_version int,
  context_manifest_json jsonb, tool_manifest_json jsonb,
  prompt_hash text, prompt_text_redacted text,
  created_at
)

agent_feedback_events (
  id uuid pk, workspace_id uuid not null, agent_id uuid, talk_id uuid, message_id uuid,
  kind text not null,   -- useful|not_useful|too_verbose|off_role|missed_evidence|accepted_doc_edit|...
  actor_user_id uuid, created_at
)
```

Design notes (resolving audit findings):

- **Model catalog (`llm_models`) is the one source of truth** for model IDs; `agents`, `runs`, role templates all FK to it. Kills the display-label-vs-ID drift (audit #10). Seed from the live `llm_provider_models` content.
- **Temperature** has a home: a default on the role template, an editable value on `agents`, snapshotted on `talk_agent_snapshots` (resolves audit #9).
- **System agents (`is_system`)** carry Forge's rewriter + critic (D3); `GET /agents` and the roster filter `is_system = false`.
- The 5 role templates may be a **code fixture** rather than a table (06 §3.2 allows it). If a fixture, `agent_role_templates` is conceptual and `role_key` is a check-constrained enum on `agents`. Pick one in implementation; the prompt text ports verbatim from `03-agents.md` either way. (Fix the "Samira" placeholder + `@strat` handle from audit #7–#8 when seeding.)
- **Prompt-improvement loop tables** (`06` §14.6: `agent_audit_results`, `prompt_improvement_proposals`, `prompt_versions`) are deferred — add when that loop is built. Distinct from Forge (§9).

---

## 5. Documents — tabs & blocks

```sql
documents (
  id            uuid pk,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  primary_talk_id uuid references talks(id) on delete set null,   -- 0/1 primary Talk
  folder_id     uuid references folders(id) on delete set null,    -- materialized from primary Talk while linked
  title         text not null,
  format        text not null check (format in ('markdown','html')),
  word_count    int not null default 0,                            -- maintained on edit
  last_edit_at  timestamptz,
  created_at, updated_at,
  unique (primary_talk_id)                                          -- partial: where primary_talk_id is not null
)

doc_tabs (
  id            uuid pk,
  workspace_id  uuid not null,
  document_id   uuid not null references documents(id) on delete cascade,
  title         text not null,                                      -- 'Main' by default
  sort_order    int not null,
  created_at, updated_at,
  unique (document_id, sort_order)
)

doc_blocks (
  id            uuid pk,
  workspace_id  uuid not null,
  document_id   uuid not null references documents(id) on delete cascade,  -- denormalized for doc-wide ops
  tab_id        uuid not null references doc_tabs(id) on delete cascade,
  sort_order    int not null,
  kind          text not null check (kind in ('h1','h2','p','li','meta','code')),
  text          text not null default '',
  attrs_json    jsonb not null default '{}',
  created_at, updated_at,
  unique (tab_id, sort_order)
)

document_edits (                               -- unified pending-edit model (replaces content_edits/proposals split)
  id            uuid pk,
  workspace_id  uuid not null,
  document_id   uuid not null references documents(id) on delete cascade,
  tab_id        uuid not null references doc_tabs(id) on delete cascade,
  block_id      uuid references doc_blocks(id) on delete cascade,   -- null = new block
  proposed_by_agent_id uuid references agents(id),
  proposed_by_run_id   uuid references runs(id),
  op            text not null check (op in ('insert','replace','delete')),
  new_kind      text, new_text text, new_attrs_json jsonb, after_block_id uuid,
  status        text not null default 'pending' check (status in ('pending','accepted','rejected','superseded')),
  source        text not null default 'agent' check (source in ('agent','forge')),  -- Forge promotes via this path too
  created_at, resolved_at
)

document_coeditors ( document_id uuid, agent_id uuid, primary key (document_id, agent_id) )
```

Design notes:

- **Tabs are first-class** (`08` §3.5–3.6): every document has ≥1 tab (`Main`), blocks belong to a tab, the last tab can't be deleted. This is the Document-tabs feature — specified in `08`, designed here, **net-new in the DB**.
- **`document_edits` unifies** today's `content_edits` + `content_proposals` into one pending-edit table with `status` + `op`. `source` distinguishes agent edits from **Forge** promotions, so the Forge "set winner" lands through the same accept path (no second write path; satisfies `09` §8 + audit #3a).
- **Co-editors are document-level** (`document_coeditors`), resolving the doc-vs-tab ambiguity (audit #19) — the prototype's per-tab list collapses to per-document.
- Move-block-between-tabs is `update doc_blocks set tab_id, sort_order` (the endpoint missing from `04` — audit #14).
- `word_count` maintained across tabs on edit (matches prototype `CT_docWordCount`).
- Indexes: `documents(workspace_id, primary_talk_id)`; `doc_blocks(tab_id, sort_order)`, `doc_blocks(document_id)`; `document_edits(document_id) where status='pending'`.

---

## 6. Context, tools, connectors

```sql
context_sources (
  id uuid pk, workspace_id uuid not null, talk_id uuid not null references talks(id) on delete cascade,
  kind text not null check (kind in ('document','url','file','past_talk','rule','news')),  -- primary doc is projected, not stored here
  name text not null,
  source_document_id uuid references documents(id), source_talk_id uuid references talks(id),
  payload_ref text, extracted_text text, summary text, meta_json jsonb not null default '{}',
  include_in_prompt boolean not null default true, sort_order int,
  added_by_user_id uuid, created_at, updated_at
)

talk_tools (                                   -- per-Talk tool toggles (queryable, not a blob)
  talk_id uuid not null references talks(id) on delete cascade,
  tool_id text not null,                        -- web-search|web-fetch|news-monitor|gdrive-read|...
  enabled boolean not null default false,
  primary key (talk_id, tool_id)
)

connectors (                                   -- workspace-global OAuth wiring (per roadmap #5)
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  service text not null check (service in ('slack','gdrive','gmail','linear','github','notion')),
  authorized boolean not null default false, authorized_at timestamptz,
  secret_ref text,                              -- → provider secret store (§11), never the token itself
  config_json jsonb not null default '{}',
  created_at, updated_at
)

connector_bindings (                           -- which Talk uses a connector + target
  id uuid pk, workspace_id uuid not null,
  connector_id uuid not null references connectors(id) on delete cascade,
  talk_id uuid not null references talks(id) on delete cascade,
  target text,                                  -- '#pricing', '/drive/folder', 'TEAM-123'
  scope text[] not null default '{}', enabled boolean not null default true,
  unique (connector_id, talk_id)
)
```

- **Primary document is not a `context_sources` row** — it's projected into the Context API from `documents.primary_talk_id` (`08` §3.9).
- **Connectors are workspace-global** with per-Talk bindings (resolves the per-Talk-vs-workspace conflict, audit #5; matches roadmap #5). Tools (capabilities) stay per-Talk via `talk_tools`.
- **Reuse vs. rewrite.** The connector OAuth/secret plumbing (`workspace_provider_secrets`, encrypted-at-rest, JIT decrypt; engineering-notes §1) is good — keep it as the `secret_ref` target. The per-Talk connector *panels/tables* being removed in roadmap #5 are superseded by this shape.

---

## 7. Home — inbox, recommendations, news

Home is three deterministic systems + a bounded optimizer (`07-homepage-system-design.md`). Tables (clean version of `07` §10):

```sql
activity_events ( id, workspace_id, kind, talk_id, document_id, run_id, payload_json, created_at )

inbox_items (
  id uuid pk, workspace_id uuid not null,
  type text not null,                 -- agent_replied|round_completed|agent_asks_user|run_failed|doc_edits_ready|connector_needs_auth|news_context_added|long_running_run|system_limit_reached|forge_run_needs_review
  target_kind text, target_id uuid, talk_id uuid, document_id uuid, run_id uuid, tab_id uuid,
  title text, summary text, reason text,
  severity text check (severity in ('info','action','blocking')),
  status text check (status in ('unread','read','resolved','dismissed','snoozed','expired')),
  group_key text, score numeric, algorithm_version text,
  due_at, expires_at, created_at, updated_at
)

recommendations (
  id uuid pk, workspace_id uuid not null,
  kind text not null,                 -- setup|failed-run|unresolved|synthesis|pending-edit|doc|cross-link|tool|news-context|agent-change|recap|archive-cleanup|forge-suggestion
  title text, why text, priority text check (priority in ('decide','improve','tidy')),
  score numeric, confidence numeric, provenance_json jsonb, action_json jsonb,
  status text check (status in ('active','dismissed','completed','expired','snoozed')),
  algorithm_version text, created_at, expires_at
)
recommendation_candidates ( id, workspace_id, kind, features_json, created_at )

news_topics ( id, workspace_id, talk_id, mode, decision_type, sensitivity, abstract, keywords text[], entities text[], negative_terms text[], created_at, updated_at )
news_items   ( id, workspace_id, headline, source, url, excerpt, published_at, fetched_at )
news_matches ( id, workspace_id, news_item_id, topic_id, talk_id, impact, score, confidence, status, algorithm_version, created_at )

ranking_profiles      ( id, workspace_id, weights_json, exploration_rate, updated_at )
optimization_proposals ( id, workspace_id, summary, diff_json, status, created_at )
algorithm_versions    ( id, name, kind, active boolean, shadow boolean, created_at )
interaction_events    ( id, workspace_id, surface, item_id, action, created_at )
```

Design notes:

- **New: `inbox_items.type = forge_run_needs_review`** and **`recommendations.kind = forge-suggestion`** wire Forge into Home (resolves audit #4 — Home was Forge-blind). A finished Forge run with a winner raises an inbox item that deep-links to the version gallery.
- News privacy contract is structural: `news_topics` stores only abstract/keywords/entities/negative-terms; raw message/doc text never leaves (`07` §8.4).
- Optimizer writes only `ranking_profiles` (bounded weight tuning); structural changes go through `optimization_proposals` (admin-reviewed). Single News scoring formula — use the `07` §8.10.1 implementation as authoritative (audit nit).
- **Reuse vs. rewrite.** This is net-new (no Home tables today). Build deterministic generators first; the Curator/model copy layer is polish behind a flag (`07` §15, `05` Phase 10).

---

## 8. Jobs (provisional — pending [DECISIONS](./DECISIONS.md) D6 design pass)

Scheduled/recurring work is in scope but the model needs a first-principles definition (D6). Proposed clean shape, **not final**:

```sql
jobs (
  id uuid pk, workspace_id uuid not null, talk_id uuid references talks(id) on delete cascade,
  kind text not null,                 -- e.g. 'recurring_prompt'
  schedule_cron text, next_run_at timestamptz, enabled boolean not null default true,
  output_target text check (output_target in ('talk_message','document_append')),  -- the open D6 question
  config_json jsonb not null default '{}',
  last_run_at, created_at, updated_at
)
job_runs ( id, workspace_id, job_id, status, started_at, finished_at, error_json )
```

- The open question (roadmap #7): a job's output lands as a **Talk message** or **appends to a Document** — `output_target` captures the choice; D6 decides the default and whether both are needed.
- **Do not build from this table yet** — it's a placeholder so the schema is complete. Run the D6 review (read current `talk_jobs`/`scheduler.ts`/`job-accessors` for *requirements only*) then finalize.
- Pacing reuses the cron `scheduler.ts` + Queues mechanics (keep the mechanism, redefine the model).

---

## 9. Forge — autonomous content improvement

Forge (`09`/`10`) optimizes a Document toward an SSR-scored bar. Tables:

```sql
ssr_connections (                              -- Synthetical org binding + token (per user or workspace — 09 §15 open)
  id uuid pk, workspace_id uuid not null, owner_user_id uuid,
  ssr_org_id text not null, secret_ref text not null,   -- token in provider secret store (§11)
  scopes text[] not null, created_at, updated_at
)

improvement_runs (
  id uuid pk, workspace_id uuid not null,
  document_id   uuid not null references documents(id) on delete cascade,
  tab_id        uuid references doc_tabs(id),            -- scope: tab (10's whole-doc/tab/section toggle)
  target_block_id uuid references doc_blocks(id),        -- scope: block; null+null = whole doc
  talk_id       uuid references talks(id), owner_id uuid not null references users(id),
  objective_json jsonb not null,                         -- persona_ids, reference_set_ids, survey_question, scoring_config, fitness
  target_score numeric, max_iterations int, budget_usd numeric, plateau_epsilon numeric,
  baseline_score numeric,
  status text not null default 'pending'
    check (status in ('pending','running','completed','plateaued','budget_exhausted','cancelled','failed')),
  ssr_connection_id uuid references ssr_connections(id),
  best_version_id uuid,
  created_at, updated_at
)

document_versions (                            -- one per scored candidate
  id uuid pk, workspace_id uuid not null,
  run_id uuid not null references improvement_runs(id) on delete cascade,
  iteration int not null, candidate_id text not null,     -- round-tripped to SSR
  parent_version_id uuid references document_versions(id),
  body_markdown text not null, mutation_strategy text,
  composite_score numeric, held_out_score numeric,         -- trust signal (09 §10)
  per_persona_json jsonb, ssr_job_id text,
  decision text check (decision in ('keep','discard','frontier','winner')), decision_reason text,
  created_at
)
```

Design notes (resolves audit #3a/#3c/#13):

- **Scope is tab/block-aware** (`tab_id` + `target_block_id`), reconciling `10`'s "whole doc / tab / section" toggle with the document model. Whole-doc = both null.
- **Rewriter + critic are `is_system` agents** in `agents` (D3); the loop runs through the normal run/executor path with `run_kind = 'content_improvement'`.
- **Promotion reuses `document_edits`** with `source='forge'` — the winning version lands as a pending edit through the same accept path (no autonomous overwrite; `09` Goal 4).
- **Streaming** reuses `event_outbox` with event types `improvement_round_scored` / `improvement_version_kept` / `improvement_run_finished`.
- ClawTalk owns the loop; SSR owns the score (`09` §5.1) — no scoring math in these tables, only results.

---

## 10. Audit & analytics

```sql
audit_events ( id uuid pk, workspace_id uuid not null, actor_user_id uuid, entity_type text, entity_id uuid, action text, payload_json jsonb, created_at )
```

Log every state mutation (`04` §16). Append-only; partition by month if volume warrants. Distinct from `activity_events` (which feeds Home).

---

## 11. Reused infrastructure (keep as-is)

These existing tables/mechanisms are correct for the target and are **kept** (not rewritten) — the one place continuity *is* the right call:

- **LLM provider layer:** `llm_providers`, `llm_provider_models` (→ seed `llm_models`), `llm_provider_secrets`, `workspace_provider_secrets`, verifications. Encrypted-at-rest secrets, JIT decrypt (engineering-notes §1).
- **Event delivery:** `event_outbox` → `UserEventHub` Durable Object (WebSocket Hibernation). All streaming (runs, Forge, Home badges) rides this.
- **Idempotency:** `idempotency_cache` for at-least-once queue/SSR retries.
- **Queues + cron:** Cloudflare Queues (run dispatch) + `scheduler.ts` (cron tick, stuck-run sweep, job pacing).

Everything else from the current schema (`contents`, `content_edits`, `content_proposals`, `talk_threads`, `main_threads`, `registered_agents`, `talk_agents`, `talk_folders`, `talk_outputs`, `talk_resource_bindings`, `talk_context_*`) is **superseded** by the tables above.

---

## 12. RLS model

- Every workspace-owned table: `enable row level security`. Policy: the row's `workspace_id` must be in the caller's workspace memberships, set by `withUserContext` (`app.user_id` / `app.workspace_id` GUCs).
- Write policies additionally check role where it matters (e.g., agent/connector/member admin actions require `admin`/`owner`).
- `documents`/`doc_tabs`/`doc_blocks`/`document_edits` inherit workspace scoping directly (no thread join — a concrete win over today's contents-via-`talk_threads` RLS; engineering-notes / D4).
- System agents (`is_system`) are readable by the runtime but filtered from user-facing reads at the query layer, not RLS.

---

## 13. Open items feeding back to other docs

- **D6 jobs** — finalize §8 after the jobs review.
- **`09` §15** — per-user vs per-workspace `ssr_connections` scope; default fitness; default objective. Blocks the Forge config modal.
- **Model catalog** — seed `llm_models` and point `03`/`04` §14 at it (audit #10).
- **API** — add Forge endpoints + move-block endpoint to `04` (audit #13/#14); drop SSE.
- **Role templates** — decide table vs code fixture (§4); port `03` prompts verbatim with the "Samira"/handle fixes.
