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

## D6 — Jobs: design clean — ⏳ Open (needs a design pass)

**Decision.** Scheduled jobs are in scope, but the model needs a proper, first-class definition before building — including how a job's output lands (into a Talk vs appended to a Document). **Next action:** read the current `talk_jobs`/`scheduler.ts`/`job-accessors` *only to extract the requirements*, then design the clean version. No obligation to preserve the existing shape.

---

## How to use this log

- New cross-cutting decisions get an entry (`D<n>`), a status (✅ Decided / 🟡 Provisional / ⏳ Open), and follow-ups.
- Reference decisions by ID from other docs (e.g. "stack per DECISIONS D1").
- The canonical spec docs (`01`–`10`) describe the target product; treat them as the design source for the greenfield build, not as a description of current code.
