> **Status:** canonical (greenfield schema — the authoritative DB design). Build posture is [DECISIONS.md](./DECISIONS.md) D0 (greenfield); gating resolutions in D7. This doc owns the **tables**; [08-information-architecture.md](./08-information-architecture.md) owns IA rules/cardinalities, `06`/`07`/`09` own their domain behavior.
> Precedence + orientation: [README.md](./README.md) · decisions: [DECISIONS.md](./DECISIONS.md) · terms: [GLOSSARY.md](./GLOSSARY.md).

# ClawTalk — Canonical Data Model

A clean-slate schema for the rebuilt product. Designed for the canonical hierarchy

> **Workspace → Folder (optional) → Talk + Document (optional)** · multi-workspace · no Threads

on Postgres (Supabase) behind Cloudflare Workers ([DECISIONS](./DECISIONS.md) D1). Single source of truth for tables; behavior lives in the spec docs it cross-references.

It is **greenfield** (D0): names and shapes are designed for the new model, not inherited from the current `contents`/`talk_threads`/`registered_agents` tables. Where keeping existing infra is the *better* engineering choice (not just continuity), each section says so under **Reuse vs. rewrite** — corrected after the 2026-05-28 pressure test (D7), which found several earlier reuse claims false.

---

## 0. Conventions

- **PKs:** `id uuid primary key default gen_random_uuid()` (time-ordered v7 default if available). API exposes typed opaque IDs (`ws_`, `f_`, `t_`, `d_`, `a_`, …) derived from the uuid per `04` §0.
- **Tenancy:** every workspace-owned row carries `workspace_id uuid not null` — first column after `id`, leading column of most indexes. This **includes join tables** (`talk_agents`, `talk_tools`, `team_composition_agents`, `doc_tab_coeditors`, connector bindings) so RLS can predicate on them directly (D7).
- **Composite FKs for tenant integrity:** a child references its parent on `(workspace_id, parent_id)`, not just `parent_id`, so a row can't point across workspaces. Parents expose a `unique (workspace_id, id)` for the composite target. (Caught by D7: `workspace_id` alone, unenforced, isn't integrity.)
- **Timestamps:** `created_at`, `updated_at` (touch trigger), UTC `timestamptz`.
- **Soft-delete:** only where recovery is a product feature (Talks: `archived_at`). Else hard-delete via cascade (D0 — no "just in case" tombstones).
- **Enums:** Postgres `enum` for closed sets (roles, run status, mode); `text` + check for evolving sets.
- **Flexible payloads:** `jsonb` for genuinely open shapes (objective/search config, manifests, event payloads) — not as an escape hatch for known columns.
- **Ordering:** user-orderable lists use `sort_order int`, unique per parent bucket.
- **RLS:** every workspace-owned table has RLS on. Identity is **`auth.uid()`**, resolved from `request.jwt.claims->>'sub'`, which the existing `withUserContext` (`src/db.ts`) sets via `set_config('request.jwt.claims', …)` + `set local role authenticated`. **There is no `app.*` GUC.** Visibility predicate is workspace membership — see §12.

**Reuse vs. rewrite (global), corrected by D7.** *Keep* the Cloudflare platform (Workers / Queues / Durable Objects / Hyperdrive), the `event_outbox` → `UserEventHub` DO stream, and the LLM provider/model/secret tables (`llm_providers`, `llm_provider_models`, `llm_provider_secrets`, `workspace_provider_secrets` — these are **shared LLM keys**, not OAuth). *Rework* the run model + executor (the legacy `talk_runs` is thread/channel-entangled). *Do not reuse* `idempotency_cache` for Forge retries (it's an HTTP-response cache keyed `idempotency_key,user_id,method,path`) and *do not* route connector/SSR OAuth secrets through `workspace_provider_secrets` (LLM-key store) — both get their own stores below.

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
  role         workspace_role not null default 'member',   -- enum: owner|admin|member|guest
  created_at,
  primary key (workspace_id, user_id)
)
```

- `workspace_role` includes **`guest`** (the prototype's account switcher shows a Guest workspace) in addition to owner/admin/member.
- On signup: create the user, their first `workspace`, and an `owner` membership.
- `workspace_members` is the **RLS keystone** — every other policy joins through it (§12).
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
  mode talk_mode not null default 'ordered',                     -- enum: ordered|parallel
  rounds_limit int not null default 3,                           -- 1|2|3|5 in UI
  created_by uuid not null references users(id),
  archived_at timestamptz, last_activity_at timestamptz not null default now(),
  created_at, updated_at,
  unique (workspace_id, id),
  foreign key (workspace_id, folder_id) references folders(workspace_id, id) on delete set null
)

-- Current, editable roster (who's in the room now). Distinct from the per-run snapshot. (D7 / pressure-test P0-1)
talk_agents (
  workspace_id uuid not null, talk_id uuid not null, agent_id uuid not null,
  sort_order int not null, added_at timestamptz not null default now(),
  primary key (talk_id, agent_id),
  foreign key (workspace_id, talk_id) references talks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_id) references agents(workspace_id, id) on delete cascade
)

messages (
  id uuid pk, workspace_id uuid not null, talk_id uuid not null,
  round int not null,
  author_kind text not null check (author_kind in ('user','agent')),
  author_user_id    uuid references users(id),                   -- when user
  agent_snapshot_id uuid references talk_agent_snapshots(id),    -- when agent: immutable attribution (P1-5)
  run_id            uuid references runs(id),
  body text, attachments_json jsonb not null default '[]',
  created_at,
  foreign key (workspace_id, talk_id) references talks(workspace_id, id) on delete cascade
)

runs (                                                            -- clean: NO thread_id (D4/D7)
  id uuid pk, workspace_id uuid not null, talk_id uuid not null,
  round int not null,
  run_kind text not null default 'conversation'
    check (run_kind in ('conversation','content_improvement')),  -- extended for Forge (§9)
  agent_snapshot_id uuid not null references talk_agent_snapshots(id),
  status run_status not null default 'queued',                   -- enum: queued|running|awaiting|completed|failed|cancelled
  model_id text not null references llm_models(id),
  requested_by uuid not null references users(id),
  trigger_message_id uuid references messages(id),               -- the user turn that triggered this run
  response_group_id text not null, sequence_index int not null,  -- ordered/parallel sequencing the orchestrator needs
  prompt_snapshot_id uuid references run_prompt_snapshots(id),
  tokens_in int, tokens_out int, error_json jsonb,
  started_at, finished_at, created_at,
  foreign key (workspace_id, talk_id) references talks(workspace_id, id) on delete cascade
)

-- Per-user read state → unread is derived (P0-2). No `unread` column on talks.
talk_reads ( workspace_id uuid not null, talk_id uuid not null, user_id uuid not null,
  last_read_at timestamptz not null default now(),
  primary key (talk_id, user_id) )
```

Design notes:

- **Roster vs. snapshot (P0-1).** `talk_agents` = the live, editable roster (add/remove agent, composer targeting). `talk_agent_snapshots` (§4) = an immutable freeze taken per run. Both are needed; the earlier "snapshots *are* the roster" was wrong.
- **Rounds are derived** — `round int` on messages/runs; a round = the runs sharing `(talk_id, round)`. No `rounds` table.
- **Run model is clean (D7).** Dropped `thread_id` (threads eliminated), channel/source/transport columns, and the `instruction_review` kind; added `content_improvement`. Kept `response_group_id` + `sequence_index` + `requested_by` + `trigger_message_id` because the ordered/parallel orchestration genuinely uses them.
- **Unread (P0-2):** derived = messages in a talk newer than the caller's `talk_reads.last_read_at`; workspace badge = sum across the workspace's talks.
- **Message attribution (P1-5):** points at `talk_agent_snapshots`, so editing an agent later never rewrites historical attribution.
- Indexes: `talks(workspace_id, folder_id, sort_order) where archived_at is null`; `messages(talk_id, round, created_at)`; `runs(talk_id, round)`, `runs(status) where status in ('queued','running')`, `runs(response_group_id, sequence_index)`.
- **Reuse vs. rewrite.** Keep the queue + DO + cron *mechanism* and salvage the executor's latency/correctness *logic* (engineering-notes §2–3); the runs **table + executor data-access are reworked** to this shape (the legacy `talk_runs` can't be reused as-is — D7).

---

## 4. Agents

```sql
llm_models (                                  -- single catalog; one id (D7)
  id text pk,                                  -- 'claude-opus-4-6', 'gpt-5-pro', 'gemini-2.5-pro'
  provider text not null, display_name text not null,
  enabled boolean not null default true, capabilities_json jsonb not null default '{}'
)   -- SEEDED FROM llm_provider_models(provider_id, model_id); that table keeps its composite key as the provider-capability source.

agent_role_templates (                        -- DB table (D7), seeded from 03-agents.md prompts
  role_key text pk,                            -- strategist|critic|researcher|editor|quant
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
  id uuid pk, workspace_id uuid not null, talk_id uuid not null, source_agent_id uuid,
  role_key text not null, name text, handle text, initials text, accent text, accent_dark text,
  model_id text not null, temperature numeric not null, persona text, focus text, method text[],
  sort_order int not null, role_template_version int, global_policy_version int, created_at )

run_prompt_snapshots (                        -- exact prompt provenance per run (06 §3.5)
  id uuid pk, workspace_id uuid not null, run_id uuid not null, talk_id uuid not null,
  agent_snapshot_id uuid not null references talk_agent_snapshots(id),
  model_id text not null, provider text not null,
  global_policy_version int, role_template_version int, prompt_assembly_version int,
  context_manifest_json jsonb, tool_manifest_json jsonb, prompt_hash text, prompt_text_redacted text, created_at )

agent_feedback_events ( id uuid pk, workspace_id uuid not null, agent_id uuid, talk_id uuid, message_id uuid,
  kind text not null, actor_user_id uuid, created_at )
```

Design notes:

- **Model catalog (D7):** `llm_models` is the single source of truth (one `id`); seeded from `llm_provider_models(provider_id, model_id)`, which **keeps its composite key** as the provider-capability table. Agents/runs/templates FK to `llm_models.id`. Kills the model-ID drift.
- **Role templates as a DB table (D7):** `agents.role_key` is a real FK. Prompts are **seeded from `03-agents.md`** (still the version-controlled, reviewable, eval-tested source) and changed via versioned rows — feeds the `06` §14 prompt-improvement loop. Fix the "Samira" placeholder + `@strat` handle on seed.
- **Temperature** lives on the template (default) → `agents.temperature` (editable) → snapshot. Resolves the audit gap.
- **System agents (`is_system`)** carry Forge's rewriter + critic (D3); filtered from `GET /agents` and the roster at the query layer.
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
  foreign key (workspace_id, primary_talk_id) references talks(workspace_id, id) on delete set null,
  foreign key (workspace_id, folder_id)       references folders(workspace_id, id) on delete set null
)
create unique index on documents (primary_talk_id) where primary_talk_id is not null;   -- 0/1 primary doc per talk

doc_tabs (
  id uuid pk, workspace_id uuid not null, document_id uuid not null,
  title text not null, sort_order int not null, created_at, updated_at,
  unique (document_id, sort_order), unique (workspace_id, id),
  foreign key (workspace_id, document_id) references documents(workspace_id, id) on delete cascade
)

doc_blocks (
  id uuid pk, workspace_id uuid not null, document_id uuid not null, tab_id uuid not null,
  sort_order int not null, version int not null default 1,                 -- CAS for edit application
  kind text not null check (kind in ('h1','h2','p','li','meta','code')),
  text text not null default '', attrs_json jsonb not null default '{}', created_at, updated_at,
  unique (tab_id, sort_order),
  foreign key (workspace_id, tab_id) references doc_tabs(workspace_id, id) on delete cascade
)

document_edits (                              -- unified pending-edit model (replaces content_edits/proposals)
  id uuid pk, workspace_id uuid not null, document_id uuid not null, tab_id uuid not null,
  block_id uuid references doc_blocks(id) on delete cascade,            -- null = insert new block
  base_block_version int,                                              -- CAS: must match block.version on accept
  after_block_id uuid references doc_blocks(id),                       -- placement for inserts (real FK)
  proposed_by_agent_id uuid, proposed_by_run_id uuid references runs(id),
  op text not null check (op in ('insert','replace','delete')),
  new_kind text, new_text text, new_attrs_json jsonb,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','superseded')),
  source text not null default 'agent' check (source in ('agent','forge')),
  created_at, resolved_at,
  foreign key (workspace_id, document_id) references documents(workspace_id, id) on delete cascade
)

doc_tab_coeditors ( workspace_id uuid not null, tab_id uuid not null, agent_id uuid not null,
  primary key (tab_id, agent_id),
  foreign key (workspace_id, tab_id)  references doc_tabs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_id) references agents(workspace_id, id) on delete cascade )
```

Design notes:

- **Tabs are first-class** (`08` §3.5–3.6): every document has ≥1 tab (`Main`), blocks belong to a tab. Net-new in the DB.
- **Document invariants** are enforced, not just documented (P1): `≥1 tab` and `last-tab-can't-delete` via a `before delete` trigger on `doc_tabs` (reject if it's the document's last); `documents.folder_id` is materialized by the app on talk move/link (one transaction); `after_block_id` is a real FK.
- **Edit concurrency (P1-7):** `document_edits` carries `base_block_version`; accept is **CAS** — apply only if `doc_blocks.version` still matches, else mark `superseded`. The block's `version` bumps on every applied edit. Inline rendering of a pending edit interleaves `document_edits` rows (status `pending`) against `doc_blocks` by `after_block_id`/`block_id`.
- **`document_edits` unifies** today's `content_edits` + `content_proposals`; `source='forge'` lets a Forge winner land through the same accept path (no second write path).
- **Co-editors are per-tab** (`doc_tab_coeditors`) — matches the prototype (Draft vs Comp-table tabs have different editors). *(Default call on pressure-test #6; flip to per-document if you'd rather simplify.)*
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
  include_in_prompt boolean not null default true, sort_order int, added_by_user_id uuid, created_at, updated_at,
  foreign key (workspace_id, talk_id) references talks(workspace_id, id) on delete cascade
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
  secret_ref uuid references connector_secrets(id),         -- NOT workspace_provider_secrets (those are LLM keys)
  config_json jsonb not null default '{}', created_at, updated_at, unique (workspace_id, id)
)

connector_secrets ( id uuid pk, workspace_id uuid not null, enc_key_version int not null default 1,
  ciphertext text not null, created_at, updated_at )      -- new OAuth-token store, encrypted at rest (JIT decrypt)

connector_bindings (
  id uuid pk, workspace_id uuid not null, connector_id uuid not null, talk_id uuid not null,
  target text, scope text[] not null default '{}', enabled boolean not null default true,
  unique (connector_id, talk_id),
  foreign key (workspace_id, connector_id) references connectors(workspace_id, id) on delete cascade,
  foreign key (workspace_id, talk_id)      references talks(workspace_id, id) on delete cascade
)
```

- **Tool ↔ connector dependency (P1-11):** a tool (e.g. `gdrive-read`) requires its service connector (`gdrive`) authorized. This mapping is a **static code catalog** (`tool_id → required service`), not a table; the runtime gates a tool if its connector isn't authorized.
- **Connector/SSR secrets get their own store** (`connector_secrets`) — D7 corrected the false reuse of `workspace_provider_secrets` (which is LLM provider keys). Same encrypt-at-rest + JIT-decrypt pattern (engineering-notes §1).
- Primary document is projected into Context from `documents.primary_talk_id`, not stored as a `context_sources` row (`08` §3.9).

---

## 7. Home — inbox, recommendations, news

Three deterministic systems + a bounded optimizer (`07`). All workspace-scoped.

```sql
activity_events ( id, workspace_id, kind, talk_id, document_id, run_id, payload_json, created_at )

inbox_items (
  id uuid pk, workspace_id uuid not null,
  type text not null,   -- agent_replied|round_completed|agent_asks_user|run_failed|doc_edits_ready|connector_needs_auth|news_context_added|long_running_run|system_limit_reached|forge_run_needs_review
  target_kind text, target_id uuid, talk_id uuid, document_id uuid, run_id uuid, tab_id uuid,
  title text, summary text, reason text,
  severity text check (severity in ('info','action','blocking')),
  status text check (status in ('unread','read','resolved','dismissed','snoozed','expired')),
  group_key text, score numeric, algorithm_version text, due_at, expires_at, created_at, updated_at )

recommendations (
  id uuid pk, workspace_id uuid not null,
  kind text not null,   -- setup|failed-run|unresolved|synthesis|pending-edit|doc|cross-link|tool|news-context|agent-change|recap|archive-cleanup|forge-suggestion
  title text, why text, priority text check (priority in ('decide','improve','tidy')),
  score numeric, confidence numeric, provenance_json jsonb, action_json jsonb,   -- cross-link's 2nd talk lives in provenance_json
  status text check (status in ('active','dismissed','completed','expired','snoozed')),
  algorithm_version text, created_at, expires_at )

recommendation_candidates ( id, workspace_id, kind, features_json, created_at )
news_topics ( id, workspace_id, talk_id, mode, decision_type, sensitivity, abstract, keywords text[], entities text[], negative_terms text[], created_at, updated_at )
news_items   ( id, workspace_id, headline, source, url, excerpt, published_at, fetched_at )
news_matches ( id, workspace_id, news_item_id, topic_id, talk_id, impact, score, confidence, status, algorithm_version, created_at )
ranking_profiles ( id, workspace_id, weights_json, exploration_rate, updated_at )
optimization_proposals ( id, workspace_id, summary, diff_json, status, created_at )
algorithm_versions ( id, name, kind, active boolean, shadow boolean, created_at )
interaction_events ( id, workspace_id, surface, item_id, action, created_at )
```

- **Forge on Home:** `inbox_items.type = forge_run_needs_review` + `recommendations.kind = forge-suggestion` (resolves audit #4 — Home was Forge-blind).
- News privacy is structural: `news_topics` stores only abstract/keywords/entities/negative-terms; raw message/doc text never leaves (`07` §8.4). Use the `07` §8.10.1 implementation as the single authoritative scoring formula.
- Optimizer writes only `ranking_profiles` (bounded weights); structural changes go through `optimization_proposals` (admin-reviewed).
- **Reuse vs. rewrite.** Net-new (no Home tables today). Deterministic generators first; Curator model-copy is flagged polish.

---

## 8. Jobs (provisional — pending [DECISIONS](./DECISIONS.md) D6)

```sql
jobs ( id uuid pk, workspace_id uuid not null, talk_id uuid, kind text not null,
  schedule_cron text, next_run_at timestamptz, enabled boolean not null default true,
  output_target text check (output_target in ('talk_message','document_append')),   -- the open D6 question
  config_json jsonb not null default '{}', last_run_at, created_at, updated_at )
job_runs ( id, workspace_id, job_id, status, started_at, finished_at, error_json )
```

- **Do not build from this yet** — D6 runs a first-principles definition (read current `talk_jobs`/`scheduler.ts`/`job-accessors` for *requirements only*). `output_target` captures the open roadmap #7 question. Pacing reuses the cron `scheduler.ts` + Queues mechanism.

---

## 9. Forge — autonomous content improvement

```sql
ssr_connections (                             -- per workspace (D7); admin-managed
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  ssr_org_id text not null, secret_ref uuid references connector_secrets(id),    -- token in the connector secret store
  scopes text[] not null, connected_by uuid references users(id), created_at, updated_at, unique (workspace_id) )

-- Synced read-only SSR assets, cached per workspace (browsed in the Audiences page; refreshed from Synthetical)
forge_personas ( id uuid pk, workspace_id uuid not null, ssr_id text not null, name text, title text, segment text, initials text, accent text, synced_at, unique (workspace_id, ssr_id) )
forge_reference_sets ( id uuid pk, workspace_id uuid not null, ssr_id text not null, name text, version text, anchor_count int, synced_at, unique (workspace_id, ssr_id) )
forge_questions ( id uuid pk, workspace_id uuid not null, ssr_id text not null, text text, synced_at, unique (workspace_id, ssr_id) )

-- Saved audiences, composed IN ClawTalk (first-class — P0-3)
forge_audiences (
  id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null, note text,
  persona_ids uuid[] not null,                 -- → forge_personas.id
  reference_set_id uuid references forge_reference_sets(id),
  question_id uuid references forge_questions(id),
  created_at, updated_at, unique (workspace_id, id) )

improvement_runs (
  id uuid pk, workspace_id uuid not null,
  document_id uuid not null, tab_id uuid, target_block_id uuid,    -- scope: doc / tab / block (10's toggle); doc = both null
  talk_id uuid, owner_id uuid not null references users(id),
  audience_id uuid references forge_audiences(id),                 -- nullable: ad-hoc objective
  objective_json jsonb not null,                                   -- resolved persona_ids, reference_set_id, question_id, scoring_config, fitness
  search_config_json jsonb not null,                               -- beamN, beamK, mutations, plateau_epsilon  (P1-8)
  held_out_persona_ids uuid[],                                     -- persisted held-out set  (P1-8)
  target_score numeric, max_iterations int, budget_usd numeric,
  baseline_score numeric,
  status text not null default 'pending'
    check (status in ('pending','running','completed','plateaued','budget_exhausted','cancelled','failed')),
  stop_reason text,                                                -- human detail e.g. 'Plateaued at round 4'
  ssr_connection_id uuid references ssr_connections(id), best_version_id uuid,
  created_at, updated_at,
  foreign key (workspace_id, document_id) references documents(workspace_id, id) on delete cascade
)

document_versions (                           -- one per scored candidate
  id uuid pk, workspace_id uuid not null, run_id uuid not null references improvement_runs(id) on delete cascade,
  iteration int not null, candidate_id text not null, parent_version_id uuid references document_versions(id),  -- null = baseline
  body_markdown text not null, mutation_strategy text,
  composite_score numeric, held_out_score numeric,                -- 0–10 scale (see scales note)
  per_persona_json jsonb,                                          -- { personaId: { likert:int[5] (1–5), verbatim, score } }
  ssr_job_id text, decision text check (decision in ('keep','discard','frontier','winner')), decision_reason text, created_at )
```

Design notes:

- **Audiences + synced assets (P0-3):** `forge_audiences` is a first-class saved entity; personas/reference-sets/questions are **cached per workspace** from Synthetical (read-only, `synced_at`), so the Audiences page has real backing and runs can resolve a stable persona set even as the audience changes.
- **Score scales (P1-9):** composite/held-out/`feedback` scores are **0–10**; per-persona Likert distributions are **1–5** five-bucket arrays (their mean is 1–5). `per_persona_json` carries both; the SSR scale is 5-bucket (the prototype's `ssr-likert-4` label is wrong — treat as 5).
- **Run reproducibility (P1-8):** `search_config_json` (beam N/K, enabled mutations, plateau ε) and `held_out_persona_ids` persist on the run.
- **Scope** is tab/block-aware (`tab_id` + `target_block_id`); whole-doc = both null. Rewriter + critic are `is_system` agents (D3); the loop runs through the normal run path with `run_kind='content_improvement'`. Promotion reuses `document_edits` (`source='forge'`). Streaming reuses `event_outbox` (`improvement_round_scored` / `_version_kept` / `_run_finished`).
- Indexes: `improvement_runs(workspace_id, document_id)`, `document_versions(run_id)`.

---

## 10. Audit & analytics

```sql
audit_events ( id uuid pk, workspace_id uuid not null, actor_user_id uuid, entity_type text, entity_id uuid, action text, payload_json jsonb, created_at )
```

Append-only; every state mutation (`04` §16). Distinct from `activity_events` (Home feed). Partition by month if volume warrants.

---

## 11. Reused infrastructure (kept) — corrected by D7

**Kept (correct for the target):**
- **Cloudflare platform:** Workers, Queues (run dispatch), Durable Objects (`UserEventHub`), Hyperdrive, `scheduler.ts` cron.
- **Event delivery:** `event_outbox` → `UserEventHub` DO (WebSocket Hibernation). All streaming rides this.
- **LLM provider layer:** `llm_providers`, `llm_provider_models` (composite PK, seeds `llm_models`), `llm_provider_secrets`, `workspace_provider_secrets` — **shared LLM keys**, encrypted at rest, JIT decrypt.

**Explicitly NOT reused (D7 corrections):**
- `idempotency_cache` is an **HTTP-response cache** (`idempotency_key,user_id,method,path` → `status_code`/`response_body`) — *not* a Forge batch-retry store. Forge dedupes via the SSR `idempotency_key` it already sends per round + its own run/version records.
- `workspace_provider_secrets` is **LLM keys** — *not* connector/SSR OAuth. Those use the new `connector_secrets` (§6, §9).
- The legacy `talk_runs` + its executor data-access are **reworked** (thread/channel-entangled); only the orchestration *logic* is salvaged.

Everything else from the current schema (`contents`, `content_edits`, `content_proposals`, `talk_threads`, `main_threads`, `registered_agents`, `talk_agents` [old], `talk_folders`, `talk_outputs`, `talk_resource_bindings`, `talk_context_*`) is superseded.

---

## 12. RLS model — corrected (D7)

- Identity: **`auth.uid()`** = `request.jwt.claims->>'sub'`, set by `withUserContext` (`set_config('request.jwt.claims', …)` + `set local role authenticated`). **No `app.*` GUC.**
- Every workspace-owned table: `enable row level security`. Canonical visibility predicate (membership-based):

  ```sql
  using ( workspace_id in (select workspace_id from workspace_members where user_id = auth.uid()) )
  ```
- **Write policies** additionally gate on role where it matters (agent/connector/member admin actions require `role in ('owner','admin')` for that workspace).
- **Join tables carry `workspace_id`** (`talk_agents`, `talk_tools`, `team_composition_agents`, `doc_tab_coeditors`, `connector_bindings`) so the predicate applies directly — no fragile parent joins.
- **Composite FKs** prevent cross-workspace references (a child's `(workspace_id, parent_id)` must match the parent).
- `documents`/`doc_tabs`/`doc_blocks`/`document_edits` scope by `workspace_id` directly — a concrete win over the legacy contents-via-`talk_threads` RLS (D4).
- **System agents** (`is_system`) are readable by the runtime but filtered from user-facing reads at the query layer, not RLS.
- `workspace_members` itself: a member sees rows for workspaces they belong to; only owners/admins mutate memberships.

---

## 13. Open items

Resolved by D7: run model, RLS plumbing, model catalog, role-template storage, SSR scope, the false-reuse claims, and the P0 product-shape gaps (roster, unread, audiences, ordering). Remaining:

- **D6 jobs** — finalize §8 after the jobs review.
- **Score scale** — confirm composite 0–10 vs Likert 1–5 with SSR (assumed here; §9).
- **Per-tab vs per-document co-editors** — defaulted **per-tab** (§5); confirm or simplify.
- **SSR asset freshness** — defaulted **cache + sync** (§9); alternatively fetch-live each session.
- **API + 03 follow-ons** — add Forge endpoints + move-block endpoint to `04`, drop SSE; point `04` §14 at `llm_models`; seed role templates from `03` with the "Samira"/handle fixes.
