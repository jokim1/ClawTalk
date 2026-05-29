# ClawTalk Docs Audit & Restructure Plan

**Date:** 2026-05-28 · **Scope:** every file in `/docs` (canonical `01–10` + README, the legacy `CLAWTALK_V2_*` / `ARCHITECTURE-REVIEW`, and the ClawRocket-era auxiliary docs).

**Purpose.** A pre-implementation pass to (a) catalog every doc and its currency, (b) list the inconsistencies and gaps we need to resolve before building, with special attention to the two newest features — **Forge** and **Document tabs** — and (c) recommend a restructure that makes the doc set legible to AI coding agents.

**How to read this.** Section 1 is the doc inventory. Section 2 is the prioritized issue checklist (this is the thing to work through). Sections 3–4 drill into Forge and Document tabs. Section 5 is the restructure proposal. Severity: **P0** blocks/derails implementation if unaddressed · **P1** will cause rework or confusion · **P2** nit/cleanup.

---

## 1. Doc inventory & currency

| Doc | Role | Verdict | Recommended action |
|---|---|---|---|
| `README.md` | Build-package index | Current, but stack section stale | Keep; fix stack (see #1) |
| `01-product-spec.md` | Canonical product behavior | Current | Keep; reconcile connectors/jobs (see #5, #6) |
| `02-visual-system.md` | Design tokens | Current | Keep; add Forge + doc-tab components (see #11, #15) |
| `03-agents.md` | Canonical agent default content | Current | Keep; fix "Samira", handle, temperature home (see #7–#9) |
| `04-api-contracts.md` | REST + WS contracts | Current | Keep; add Forge endpoints, move-block endpoint, drop SSE hedge (see #2, #13, #14) |
| `05-build-plan.md` | Build sequence | Current, but stack stale | Keep; fix Redis/BullMQ assumptions, slot Forge (see #1, #12) |
| `06-agent-system-design.md` | Agent architecture | Current | Keep; define Forge rewriter/critic roles, ModelId enum (see #9, #10, #13) |
| `07-homepage-system-design.md` | Home/Inbox/News/recs | Current | Keep; surface Forge on Home, fix News formula (see #4, nits) |
| `08-information-architecture.md` | Canonical IA + doc/tab model | Current (authoritative) | Keep; it is the source of truth for Document tabs |
| `09-autonomous-content-improvement-prd.md` | Forge PRD (what/why) | Draft | Reconcile vocabulary to canonical model (see #3) |
| `10-forge-design-handoff.md` | Forge design (how it looks) | Current | Keep; reconcile scope model with tabs (see #3c) |
| `roadmap.md` | Live shipped/in-flight tracker | **Current** | Keep; cross-link Forge; it overrides 01 on connectors/jobs |
| `CLAWTALK_V2_REBUILD_PLAN.md` | Engineering elaboration of 01–08 | Partially superseded | Extract schema/latency/orchestration → archive |
| `CLAWTALK_V2_REBUILD_PLAN_REVIEW.md` | Code-accurate critique of the above | **Current (most code-accurate)** | Promote stack decision + latency hotspots → archive |
| `ARCHITECTURE-REVIEW.md` | "ClawRocket" as-built review | Legacy | Lift 5 architectural commitments → archive |
| `SPEC.md` | "ClawRocket" impl spec | Legacy (SQLite/containers) | Archive |
| `REQUIREMENTS.md` | "ClawRocket" constraints | Legacy | Archive (lift "evergreen docs" principle) |
| `SDK_DEEP_DIVE.md` | claude-agent-sdk reverse-eng | Legacy but uniquely valuable | Archive, preserve verbatim |
| `SECURITY.md` | "ClawRocket" security model | Legacy (no RLS, SQLite) | Archive + rewrite fresh for Workers/RLS |
| `DEBUG_CHECKLIST.md` | "ClawRocket" ops runbook | Legacy (sqlite3/journalctl) | Delete or archive |
| `T-new-A-*.md`, `T-new-B-*.md` | Active agent task docs | Transient | Leave to their owners |

**Headline:** six docs (`SPEC`, `REQUIREMENTS`, `SDK_DEEP_DIVE`, `SECURITY`, `DEBUG_CHECKLIST`, `ARCHITECTURE-REVIEW`) describe a **dead architecture** — a product called "ClawRocket/Nanoclaw" on SQLite + Docker containers + Telegram/WhatsApp + systemd. The current repo is ClawTalk on Cloudflare Workers + Supabase Postgres. These are actively misleading if an agent reads them as current and are the single biggest hazard in the folder.

---

## 2. Prioritized issue checklist

### Cross-cutting (affects the whole build)

- [ ] **#1 (P0) — Tech-stack contradiction.** `README.md` (§"Tech stack") and `05-build-plan.md` Phase 0 recommend **Next.js + Node + Redis + BullMQ/Sidekiq**; `CLAWTALK_V2_REBUILD_PLAN.md` doubles down on Next.js/Node/Redis. But `CLAUDE.md`, the actual `src/`, and `CLAWTALK_V2_REBUILD_PLAN_REVIEW.md` are **Cloudflare Workers + Hono + Durable Objects + Hyperdrive + CF Queues** (no Redis, no BullMQ). Decide once, then fix README §tech-stack, 05 Phase 0 ("Provision Redis…"), and 05 Risk register ("Use BullMQ/Sidekiq"). Canonical answer per repo reality: **Workers.**
- [ ] **#2 (P1) — Streaming transport ambiguity.** `04-api-contracts.md` §0 hedges "REST + WebSocket (or Server-Sent Events)"; §9 then fully specifies **WebSocket**. Legacy `SPEC.md` says SSE. Repo uses the `UserEventHub` DO WebSocket. Drop the SSE hedge in 04 §0; state WebSocket as canonical.
- [ ] **#3 (P0) — Forge ↔ canonical data-model vocabulary fork.** See Section 3. The Forge PRD speaks "Content feature" (`contents`, `content_id`, `body_markdown`, `target_anchor_id`, `registered_agents`, `propose_content_append`) while 01/08 speak "Document" (`documents`, `doc_tabs`, `doc_blocks`, `agents`, `talk_agent_snapshots`). These must be reconciled before Forge is buildable.
- [ ] **#4 (P1) — Home does not surface Forge.** `07-homepage-system-design.md` has zero Forge awareness: no recommendation `kind`, no Inbox `type`, no action for "improvement run finished / winner needs review." Its `pending-edit` rec and `doc_edits_ready` inbox item assume *agent/Editor* edits, not Forge promotions. Add a Forge surfacing path (rec kind + inbox type) or explicitly defer it post-Home.
- [ ] **#5 (P1) — Connectors scope contradiction.** `01-product-spec.md` §1.8/§4.4 models **per-Talk** connector bindings; `roadmap.md` #5 moved connectors to **workspace-global** and is deleting the per-Talk panels. 01 is partially stale. Reconcile 01 (and 04 §11 `bindings[].talkId`) to the workspace-global model roadmap shipped.
- [ ] **#6 (P1) — Scheduled/async jobs: out-of-scope vs in-flight vs Forge-dependency.** `01-product-spec.md` §8 lists "Async / scheduled agent jobs" as **out of scope for v1**; `roadmap.md` #7 is **actively building** `talk_jobs` + scheduler; `09` Forge §13 **relies** on the cron scheduler for overnight pacing. Three docs, three positions. Decide the v1 stance and align 01.

### Agent system

- [ ] **#7 (P1) — "Samira" hardcoded in a canonical prompt.** `03-agents.md` §2.1 Strategist prompt says *"The user (Samira) is the asker."* Seeding rules say port prompts **verbatim**, so this ships a wrong/fictional username into production. Make the user name a template variable or remove it.
- [ ] **#8 (P2) — Agent handle drift.** Canonical handle is `@strat` (`03`, `01` §1.6); `06-agent-system-design.md` §7.1's room-roster skeleton uses `@strategy`. Fix the skeleton.
- [ ] **#9 (P1) — Per-agent temperature has no storage home.** `03-agents.md` assigns each agent a temperature (0.2–0.7); `06`'s `WorkspaceAgent`/`TalkAgentSnapshot`/`PATCH` models omit temperature and §4.7 forbids exposing it. Decide where the `03` temperatures live (role-template fixture vs `agents` column) and how they reach the run.
- [ ] **#10 (P1) — No `ModelId` source of truth.** `03` uses exact IDs (`claude-opus-4.5`, `claude-sonnet-4.5`, `gpt-5-pro`, `gemini-2.5-pro`); `01` §1.6 and `04` §14 use display labels ("Claude Opus"); `06` references a `ModelId` type it never defines; the live env is already on newer models (Opus 4.8). Define one model catalog/enum and point every doc at it.
- [ ] **#11 (P2) — Research crew == Hiring crew.** `03-agents.md` §4 gives both teams identical membership (Researcher · Critic · Editor). Confirm intended or differentiate.

### Forge (see Section 3 for detail)

- [ ] **#3a (P0)** Reconcile `contents`/`content_id` ↔ `documents`/`document_id` (and `target_anchor_id` ↔ `doc_blocks.id` / `doc_tabs.id`).
- [ ] **#3b (P0)** Define the Forge agent roles (rewriter, critic) within the `06` agent model — new `roleKey`s? hidden system agents outside the 5 defaults?
- [ ] **#3c (P1)** Reconcile Forge scope with Document tabs: `09` only knows whole-doc/block; `10` offers "whole doc / tab / title / section." Pick the scope unit and tie it to `doc_tabs`/`doc_blocks`.
- [ ] **#13 (P1)** Add Forge REST endpoints to `04` (start run, list runs, run detail, versions/gallery, promote winner). `09` lists only SSR MCP calls + two tables.
- [ ] **#12 (P1)** Slot Forge into `05-build-plan.md` (or explicitly mark it post-v1). `09` §13 has its own 5-phase plan; cross-link them.
- [ ] **#16 (P1)** Note the **unbuilt dependency**: Forge needs the Content feature, which `roadmap.md` #6 says is mid-build (PRs 2–6 remain). Forge cannot start until that lands.
- [ ] **#17 (P2)** Disambiguate from the `06` §14 "Prompt Improvement Loop." Both are "audit → propose diff → admin accept → versioned rollout," but one improves *agent prompts*, the other improves *document content*. Add a one-line cross-doc disclaimer in each.
- [ ] **#18 (P1)** Resolve `09` §15 blocking open questions before the config modal can be built: default objective, single-fitness-number choice, per-user vs per-workspace SSR org binding.

### Document tabs (see Section 4 — mostly already specified)

- [ ] **#14 (P2) — Missing "move block between tabs" endpoint.** `08` §6.3 requires it; `04` §8 lists tab create/rename/reorder/delete and block accept/reject but **not** move-block. Add it.
- [ ] **#19 (P2) — Co-editors: doc-level vs tab-level.** `01` `Doc.coEditorIds` is document-level; the prototype (`state.jsx` `CT_docTabs`) carries per-tab `coEditors`; `08` `doc_tabs` schema has no co-editor field. Pick one and align.
- [ ] **#15 (P2) — No visual spec for the tab strip.** `02-visual-system.md` §4 has no `DocTabStrip` component though it exists in the prototype (`documents.jsx`). Add it (and the Forge surfaces).
- [ ] **#20 (P2) — Delete-tab-with-pending-edits behavior.** `08` §6.3 says "fail or require confirmation"; `04` `DELETE …/tabs/:tabId` doesn't encode it. Specify the contract.

### Legacy cleanup

- [ ] **#21 (P1) — Archive the six ClawRocket-era docs.** Move `SPEC`, `REQUIREMENTS`, `SECURITY`, `DEBUG_CHECKLIST`, `SDK_DEEP_DIVE`, `ARCHITECTURE-REVIEW` to `docs/archive/` with a deprecation banner so no agent treats SQLite/containers/Telegram as current. Preserve `SDK_DEEP_DIVE` verbatim (uniquely valuable if the agent-SDK path returns).
- [ ] **#22 (P1) — Rewrite a current SECURITY doc.** There is no security doc for the Workers + Postgres-RLS + cookie/CSRF + provider-secret-encryption model (`04` only touches OAuth shapes; `SECURITY.md` is legacy). Real gap.
- [ ] **#23 (P2) — Capture the durable engineering knowledge before archiving.** Lift into a canonical engineering-notes doc: the 5 architectural commitments + execution-resolver credential rationale (`ARCHITECTURE-REVIEW`), the three latency hotspots + stack-decision table + frontend salvage list + agent-eval gate (`V2_REVIEW`), and the schema/latency-budget/orchestration-state-machine (`V2_REBUILD_PLAN`).
- [ ] **#24 (P1) — Offline agent eval gate.** `V2_REVIEW` §4.9 flags that the 5 system prompts in `03` have never been tested against each other — a launch-blocking concern absent from the canonical package. Add an eval task to `05`/`06`.

---

## 3. Forge — implementation-readiness gaps

`09` (PRD) is thorough on the *loop design* (population/beam search, SSR-as-oracle, stop conditions, Goodhart mitigations, P0/P1/P2). `10` (handoff) is a complete *visual/interaction* spec. What's missing is the **binding to the canonical product model** — Forge currently lives in a parallel vocabulary and isn't wired into the API, agent, Home, or build docs.

**a. Vocabulary / data-model fork (P0).** `09` is written against the `roadmap.md` "Content feature": `contents` table, `content_id`, `body_markdown`, `target_anchor_id`, `registered_agents`, `propose_content_append`, `PendingEditDocSurface`. The canonical product (01/08) calls these `documents`, `doc_tabs`, `doc_blocks`, `agents`, `talk_agent_snapshots`, and the pending-edit accept path in `04` §8. **Action:** decide whether "Content feature / `contents`" *is* the canonical Document, and either rename Forge's model to `documents`/`doc_blocks` or publish an explicit mapping table. This is the gating decision — every other Forge gap depends on it.

**b. Forge agent roles undefined in the agent system (P0).** `09` §9 says "add a **rewriter** + **critic** persona to `registered_agents`." But `06` defines exactly **5 fixed role templates** (Strategist/Critic/Researcher/Editor/Quant) and an architecture with no slot for ad-hoc roles. Are rewriter/critic new `roleKey`s? Hidden system agents outside the workspace roster? Reuse of the existing Critic? Specify in `06`.

**c. Scope vs Document tabs (P1).** `09`'s `content_improvement_runs.target_anchor_id` is "block being improved; null = whole doc" — **no tab concept**. `10` offers a scope toggle "whole doc / tab / title / section." Reconcile: add `target_tab_id` to the run model, and define what `content_versions.body_markdown` represents when scope = a tab vs a block vs the whole doc.

**d. No API surface (P1).** `04` has no Forge endpoints. Need: start run, list runs (+ filter by doc), run detail (chart/trust/leaderboard), list versions, promote winner, cancel run — plus the WS event types `09` §9 names (`improvement_round_scored`, `improvement_version_kept`, `improvement_run_finished`).

**e. Home surfacing (P1).** See #4. A finished Forge run with a winner "landing as a pending edit" needs an Inbox item and/or recommendation in `07`.

**f. Build sequencing + dependency (P1).** `05` doesn't mention Forge (README marks 09/10 "forward-looking"). That's fine, but (i) cross-link `09` §13's phase plan, and (ii) record that Forge is blocked on the Content feature (`roadmap` #6, PRs 2–6 open) and on `09` §15's open questions.

**g. Status.** `09` is still "Draft for review, not yet planned into `docs/plans/`." Promote it once #3a/#3b are resolved.

---

## 4. Document tabs — status: largely specified ✅

Unlike Forge, Document tabs is **already well documented** across the canonical set, so this is reconciliation, not authoring:

- **Data model:** `01` §1.5 (`Doc.tabs`, `DocTab`), `08` §3.5–3.6 + §5.5 `doc_tabs` + §5.6 `doc_blocks(tab_id)`.
- **IA / lifecycle / rules:** `08` §3.6 (default `Main` tab, last-tab-can't-delete, hide bar at one tab), §6.3 (tab actions), §7.5 (pane rules), §9 (create flow), §11 (nested tabs out of scope), §12 (unit + integration tests).
- **API:** `04` §8 (create/rename/reorder/delete tab; block accept/reject).
- **Streaming:** `04` §9 `doc.pending-edit` carries `tabId`; `07` Inbox `InboxTarget` carries `tabId?` and groups doc edits by tab.
- **Build:** `05` Phase 1 (tables + indexes) and Phase 6 (tab/block pending edits).
- **Prototype:** `state.jsx` (`CT_docTabs`, per-doc active tab) + `documents.jsx` (`DocTabStrip`, add/rename/delete).

**Remaining reconciliation items only:** #14 (add move-block endpoint), #19 (co-editor level), #15 (visual spec), #20 (delete-with-pending-edits contract). No new spec doc is needed — fold these fixes into `04` and `02`.

---

## 5. Recommended doc restructure (for AI-agent implementation)

The goal: an agent opening `/docs` should, within one file, know **what's canonical, what wins on conflict, and where each concern lives** — without reading a dead ClawRocket spec and building the wrong thing.

**5.1 Add status front-matter to every doc.** A short header block: `status: canonical | draft | archived`, `last-reviewed: <date>`, `supersedes:` / `superseded-by:`. Agents (and humans) can then trust or skip a file at a glance.

**5.2 Quarantine the legacy set.** Create `docs/archive/` and move the six ClawRocket docs there with a one-line banner ("Describes the retired ClawRocket/SQLite/container architecture; not current"). This single move removes most of the folder's contradiction risk.

**5.3 Add a precedence/"source of truth" section to the README.** State the conflict-resolution order explicitly:
- **Hierarchy / data model →** `08-information-architecture.md` wins.
- **UI / interaction →** the prototype (`ClawTalk Salon.html` + `prototype/*.jsx`) wins.
- **Stack / runtime →** `CLAUDE.md` + repo reality win (Cloudflare Workers), *not* the README's historical recommendation.
- **Shipped vs planned →** `roadmap.md` wins over `01` where they disagree (connectors, jobs).

**5.4 Add a canonical GLOSSARY.** One file mapping the vocabulary forks so they stop multiplying: Document = "Content feature"; `documents`/`doc_blocks` = `contents`/anchors; `agents`/`talk_agent_snapshots` = `registered_agents`; Parallel ≠ "Panel"; Threads = removed; Forge content-improvement ≠ agent prompt-improvement loop.

**5.5 Group the canonical set by concern (keep the numbers, add sections to the README index):**
- *Product & IA* — 01, 08
- *Design* — 02, 10, prototype
- *Agents* — 03, 06
- *Home* — 07
- *API & Build* — 04, 05
- *Feature PRDs* — 09 (Forge)
- *Planning* — roadmap
- *Engineering notes* (new) — distilled from V2_REVIEW + ARCHITECTURE-REVIEW commitments + SDK_DEEP_DIVE (#23)
- *Security* (new) — rewritten for Workers/RLS (#22)
- *Archive* — the six legacy docs

**5.6 Fold the V2 plan/review pair into canonical engineering docs, then archive them.** They're a plan+rebuttal that only make sense together; their durable content (stack decision, latency hotspots, schema, orchestration state machine, eval gate) belongs in `05`/the new engineering-notes doc, after which the originals can move to `archive/`.

---

### Suggested order of operations

1. Resolve the **P0 decisions** first — they unblock everything else: #1 (stack), #3a (Forge↔Document model), #3b (Forge agent roles).
2. Do the **restructure mechanics** (#21 archive, 5.1 front-matter, 5.3 precedence, 5.4 glossary) — cheap, high-leverage, stops agents reading dead docs.
3. Reconcile the **canonical inconsistencies** (#2, #5, #6, #7, #9, #10).
4. Close the **Forge wiring** (#3c, #13, #4, #12, #18) and the **Document-tabs nits** (#14, #15, #19, #20).
5. Backfill the **new docs** (#22 security, #23 engineering notes) and the **eval gate** (#24).
