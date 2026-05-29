# ClawTalk — Decision Log

> **Status:** canonical · **Last updated:** 2026-05-28
> Records resolved cross-cutting decisions so docs and agents don't relitigate them. When a doc conflicts with a decision here, this log wins. See [DOC-AUDIT.md](./DOC-AUDIT.md) for the issues that prompted them.

## D0 — Build posture: greenfield, not migration — ✅ Decided

**Decision.** ClawTalk is being **rebuilt greenfield**: new UI, new features, new architecture, **new schema**. We design the cleanest, most elegant model and build it directly. Existing tables, data, and code are **disposable** — there are no external users beyond Joseph, and this matches `CLAUDE.md`'s engineering defaults (no backward-compat scaffolding, no old+new code paths, treat stored data as disposable).

**This means:** no migration plans, no backfill/rescope steps, no preserving `contents`/`talk_threads`/`registered_agents`/`talk_folders` names or shapes. The current code is referenced only to understand requirements, then replaced. Every decision below is a clean-slate design choice, not a delta from today.

---

## D1 — Tech stack: Cloudflare Workers — ✅ Decided

**Decision.** Build on **Cloudflare Workers + Hono + Durable Objects + Hyperdrive + Cloudflare Queues**, with **Supabase Postgres**. (Same platform the repo runs on — this is the one piece of existing infra we keep, because it's the right target, not for continuity.)

**Rejected.** Next.js + Node + Redis + BullMQ/Sidekiq (from `README.md`, `05-build-plan.md`, archived rebuild plan). Run queues = CF Queues; websocket pub/sub = `UserEventHub` Durable Object; streaming transport = **WebSocket** (no SSE).

**Follow-ups.** Fix `README.md` §tech-stack and `05-build-plan.md` Phase 0 + Risk register (drop Redis/BullMQ); drop the SSE hedge in `04` §0.

---

## D2 — Data model: clean new schema on the canonical hierarchy — ✅ Decided

**Decision.** Design a fresh schema around the canonical hierarchy:

> **Workspace → Folder (optional) → Talk + Document (optional)** · multi-workspace · **no Threads.**

Use clean, direct names — `workspaces`, `workspace_members`, `folders`, `talks`, `documents` (+ `doc_tabs`, `doc_blocks`), `agents` — designed for the new model, not inherited from the current `contents`/`talk_threads`/`registered_agents` tables. The [GLOSSARY](./GLOSSARY.md) old→new mapping exists only to help read the code we're replacing.

**Forge artifact.** Forge (`09`/`10`) operates on the new `documents` model (the improvement run targets a Document / tab / block). Design its tables (`improvement_runs`, `document_versions` or similar) as part of the same clean schema.

---

## D3 — Forge agent roles: built-in system agents — ✅ Decided

**Decision.** Forge's **rewriter** and **critic** are **built-in system agents** in the new `agents` table, flagged as system-owned so they're **hidden from the workspace roster** and **not user-editable**. Forge invokes them internally.

**Rejected.** Reusing the user-facing Critic (couples Forge to an editable agent); making them first-class roster agents (needlessly expands the user-facing set).

**Follow-ups.** Define the system-agent flag + roster/`GET /agents` filter in `06`; write the rewriter/critic prompts.

---

## D4 — No Threads — ✅ Decided

**Decision.** The new model **has no Threads.** A Document attaches directly to a Talk (0 or 1 primary Document per Talk; supporting documents via Context). Threads simply don't exist in the new schema — there's nothing to "remove," we just don't build them.

---

## D5 — Multi-workspace is foundational — ✅ Decided

**Decision.** **Workspace** is the tenant root from day one: `workspaces` + `workspace_members` (owner/admin/member), with folders/talks/documents/agents scoped by `workspace_id`. Designed in from the start, not added later.

---

## D6 — Jobs: design clean — ✅ Decided

**Decision.** Full design in **[12-jobs.md](./12-jobs.md)**; schema in `11` §3/§4/§5/§7/§8. A **Job** = a saved scheduled run (prompt + one agent + schedule) that fires a normal `conversation` run on its Talk. Resolutions:

- **Output:** two booleans on `jobs` — `emit_talk_message bool` (default true; tagged-by-`job_id` agent message in the Talk) and `emit_document_append bool` (default false; proposes a pending `document_edits` row with `source='job'` on the Talk's primary Document via `documents.primary_talk_id`). CHECK `(emit_talk_message OR emit_document_append)`. Both can be set. All-or-nothing on missing primary doc: the whole job blocks (`block_reason='no_primary_document'`), the message target does not fire alone. **No `auto_accept` mode** — every job document append is review-gated, consistent with Forge's HITL principle.
- **Slot identity:** `runs.scheduled_for timestamptz` + partial unique `(job_id, scheduled_for)` makes "never fire the same slot twice" a Postgres invariant. Covers scheduler-tick races, queue at-least-once retries, and crash recovery without app-side coordination.
- **No triggering message row:** scheduler/manual runs leave `runs.trigger_message_id = NULL` and point at a fresh `run_prompt_snapshots` row (existing table in `11` §4 — reused unchanged) containing `prompt_text_redacted = jobs.prompt`. The executor reads the snapshot, not the live `jobs.prompt`, so editing mid-queue affects the NEXT fire only.
- **No threads:** the per-job dedicated thread is gone; scheduled turns are tagged in the Talk's main stream.
- **Workspace-scoped** (was per-user); scheduler runs with service-role auth, `runs.requested_by = jobs.created_by` for attribution only. Accessors scope by `workspace_id` explicitly.
- **Schedule:** `interval` / `daily` / `weekly`, IANA-tz. DST policy explicit: spring-forward gap skipped; fall-back overlap fires first UTC instant only (the scheduler explicitly skips the second occurrence — `unique(job_id, scheduled_for)` does not dedup it since the two are different UTC instants). Explicit `catch_up` (`skip` default; `run_once` for missed-slot replay). No raw cron in v1.
- **Robustness wins:** single-txn claim path (single-flight check → fire-time dependency check → roster freeze → INSERT runs + run_prompt_snapshots → advance `next_due_at` → clear `claimed_at` → COMMIT; dispatch outside the txn). No separate dropped-claim recovery needed (the single-txn model makes it unreachable). Sweep stuck `queued` (5min) AND `running` (1h). Atomic consumer claim (`update runs set status='running' where id=$1 and status='queued' returning *`) for at-least-once dedup. Source scope tightened to `{allow_web: bool, tool_ids: text[]}`, validated against `talk_tools.tool_id` at fire time.
- **Archive, not delete.** `jobs.archived_at` + `runs.job_id` FK `ON DELETE RESTRICT` preserves "history is runs filtered by job_id." UI "Delete" sets `archived_at`; hard delete is admin-only when `run_count = 0`. `jobs_active` view (`WITH (security_invoker = true)`) wraps the active filter for hot paths.
- **Inbox idempotency:** `inbox_items.ref_id uuid` + partial unique `(workspace_id, type, ref_id) where ref_id is not null`. `job_output_ready` (queue-emitted, at-least-once) sets `ref_id = run.id`; `job_blocked` (scheduler-emitted in the block txn, no retry surface) sets `ref_id = NULL` so each new block episode produces a distinct row.

**Follow-ups.** `source_scope_json.tool_ids` validation depends on `11` §6 tools model landing (hard prereq for impl). Scheduler-periodic recheck for blocked-job auto-unblock, notification surface for `job_blocked`, un-archive UI, and post-insert tab/anchor cascade behavior are tracked in `12-jobs.md §9`.

---

## D7 — Schema pressure-test resolutions — ✅ Decided

From the Codex review + prototype pressure-test of [11-data-model.md](./11-data-model.md) (2026-05-28). All verified against `src/` + migrations. These gate the schema patch and any migration generation.

- **Run model.** Clean greenfield `runs`: **no `thread_id`** (threads eliminated, D4), `run_kind` includes `content_improvement`, retain only the orchestration columns the loop actually needs (sequencing for ordered/parallel, `requested_by`, `trigger_message_id`). The executor/queue-consumer are **reworked** to this shape — salvage their latency/correctness *logic* (engineering-notes), not the legacy schema. Corrects the earlier overstated "reuse the executor as-is."
- **RLS (rewrites §0/§12).** Identity is `auth.uid()` via `request.jwt.claims->>'sub'` — the existing `withUserContext` plumbing. **There is no `app.*` GUC** (the doc's `app.user_id`/`app.workspace_id` was wrong). Policies are **workspace-membership based**: a row is visible iff `workspace_id in (select workspace_id from workspace_members where user_id = auth.uid())`. Every workspace-owned table — **including join tables** (`talk_tools`, `team_composition_agents`, `document_coeditors`, …) — carries `workspace_id`, with child↔parent integrity via **composite FKs**.
- **SSR scope.** Forge's Synthetical connection is **per workspace** (shared org binding + token, admin-managed). Resolves `09` §15.
- **Role templates.** A **DB table** (`agent_role_templates`; `agents.role_key` is a real FK), **seeded from the canonical prompts in `03-agents.md`** and changed via versioned rows (supports the `06` §14 prompt-improvement loop). The canonical prompt source stays version-controlled in `03`/seed so it's reviewable + testable; the table is the runtime source.
- **Model catalog.** Clean `llm_models(id text pk)` as the single catalog, **seeded from** `llm_provider_models(provider_id, model_id)` (which keeps its composite key as the provider-capability table). Agents/runs FK to `llm_models.id`.
- **False-reuse corrections.** `idempotency_cache` (HTTP-response cache, keyed `idempotency_key,user_id,method,path`) and `workspace_provider_secrets` (shared LLM keys, keyed by `provider_id`) are **not** reused for Forge batch retries / connector OAuth — each gets its own store.

**Mechanical follow-ons** (fall out of the above; apply during the schema patch): composite FKs + `workspace_id` on all join tables; restore run sequencing columns; add a `talk_agents` current-roster table distinct from `talk_agent_snapshots`; read-state table for unread; folder/Unfiled talk ordering; `forge_audiences` + synced-SSR-asset tables; persist Forge search config + held-out set on runs; document-invariant enforcement (≥1 tab, last-tab guard, `after_block_id` FK, edit CAS/version).

## How to use this log

- New cross-cutting decisions get an entry (`D<n>`), a status (✅ Decided / 🟡 Provisional / ⏳ Open), and follow-ups.
- Reference decisions by ID from other docs (e.g. "stack per DECISIONS D1").
- The canonical spec docs (`01`–`10`) describe the target product; treat them as the design source for the greenfield build, not as a description of current code.
