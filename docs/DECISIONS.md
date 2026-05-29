# ClawTalk — Decision Log

> **Status:** canonical · **Last updated:** 2026-05-28
> Records resolved cross-cutting decisions so docs and agents don't relitigate them. When a doc conflicts with a decision here, this log wins. See [DOC-AUDIT.md](./DOC-AUDIT.md) for the issues that prompted them.

---

## D1 — Tech stack: Cloudflare Workers (P0 #1) — ✅ Decided

**Decision.** The canonical runtime is **Cloudflare Workers + Hono + Durable Objects + Hyperdrive + Cloudflare Queues**, with **Supabase Postgres**. This is what the repo already runs (`CLAUDE.md`, `src/worker.ts`, `wrangler.toml`).

**Rejected.** The Next.js + Node + Redis + BullMQ/Sidekiq stack recommended by `README.md`, `05-build-plan.md` Phase 0, and the archived `CLAWTALK_V2_REBUILD_PLAN.md`. No platform migration. The archived `CLAWTALK_V2_REBUILD_PLAN_REVIEW.md` reached the same conclusion against the real codebase.

**Follow-ups.** Fix `README.md` §tech-stack; fix `05-build-plan.md` Phase 0 ("Provision Redis…") and its Risk register ("Use BullMQ/Sidekiq"); there is no Redis — run queues are CF Queues, websocket pub/sub is the `UserEventHub` Durable Object. Streaming transport is **WebSocket** (not SSE) — drop the SSE hedge in `04-api-contracts.md` §0.

---

## D2 — Document/agent vocabulary: orient to shipped names (P0 #3a) — 🟡 Provisional, pending naming review

**Decision (direction).** Treat the **live database schema as canonical** and align the docs to it, rather than migrating the DB to the greenfield `documents`/`agents` model in `01`/`08`. This matches the incremental-on-existing stance of the (archived) V2 review. The Forge PRD (`09`) already uses the shipped vocabulary and does **not** need rewriting.

**Why this reframes the audit.** The audit (doc-only) assumed `01`/`08` were canonical and `09` was drifting. The codebase shows the opposite: the live schema is `contents` / `registered_agents` / `talk_agents`, and `01`/`08`'s `documents` model is an unbuilt target. So we align docs → shipped names, not code → docs.

**Open — needs Joseph's review before finalizing.** Confirm each canonical name below, and the three behavior questions, then this decision flips to ✅ and the doc edits (rename references in `01`/`08`/`02`) proceed.

### Naming review (confirm or override)

| Concept | Live DB name (migrations ≤0033) | Spec name (01/08) | Proposed canonical | Confirm? |
|---|---|---|---|---|
| Editable artifact | `contents` | `documents` | **`contents`** | ☐ |
| Pending agent edits | `content_edits` | doc blocks `pending` | **`content_edits`** | ☐ |
| Edit proposals | `content_proposals` | (accept/reject path) | **`content_proposals`** | ☐ |
| Reasoning agent record | `registered_agents` | `agents` | **`registered_agents`** | ☐ |
| Per-Talk agent roster | `talk_agents` | `talk_agent_snapshots` | **`talk_agents`** | ☐ |
| Talk grouping | `talk_folders` | `folders` | **`talk_folders`** | ☐ |
| Document sections (tabs) | *(none — unbuilt)* | `doc_tabs` / `doc_blocks` | **add to `contents`** | ☐ |

### Behavior questions raised by the schema

- **Threads.** `talk_threads` still exists; `01` §1.4 says remove threads. Confirm: drop `talk_threads` (align to spec) or keep it?  ☐
- **Scheduled jobs.** `talk_jobs` exists and `roadmap.md` #7 is actively building it; `01` §8 lists scheduled jobs as out-of-scope-v1. Confirm: scheduled jobs are **in** scope (align `01` to reality)?  ☐
- **Workspaces.** `workspaces`/`folders` per `01` are not in migrations ≤0033 — verify whether a `workspaces` table exists in earlier migrations or whether the workspace layer is still unbuilt.  ☐

---

## D3 — Forge agent roles: built-in system agents (P0 #3b) — ✅ Decided

**Decision.** Forge's **rewriter** and **critic** are **built-in system agents** stored in `registered_agents`, flagged so they are **not shown in the normal workspace roster** and **not user-editable**. Forge invokes them internally via the existing `executeWithAgent` path.

**Rejected.** (a) Reusing the user-facing Critic — couples Forge to a user-editable agent. (b) Making them first-class roster agents — expands the user-facing agent set and editable-fields surface for no benefit.

**Follow-ups.** Define the "system agent" flag + filter in `06-agent-system-design.md`; specify the rewriter/critic prompts; ensure they're excluded from the Agents page and `GET /agents`.

---

## How to use this log

- New cross-cutting decisions get an entry (`D<n>`), a status (✅ Decided / 🟡 Provisional / ⏳ Open), and follow-ups.
- Reference decisions by ID from other docs (e.g. "stack per DECISIONS D1").
- When D2 is finalized, apply the rename/alignment edits and update the canonical docs' status banners.
