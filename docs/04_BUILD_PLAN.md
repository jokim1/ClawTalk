# Build Plan — Engineering Execution

**Document type:** Engineering execution plan
**Last updated:** 2026-04-30
**Audience:** the human (Joseph) coordinating Claude Code sessions in `clawrocket` and `rocketorchestra`; not a Claude Code prompt
**Companion docs:**
- `01_ARCHITECTURE.md` — substrate spec (the *why*)
- `02_HERO_APPLICATIONS.md` — app spec (the *what users see*)
- `06_PHASE_1A_KICKOFF.md` — paste-ready prompt for Claude Code (the *how to start*)
- `EDITORIAL_ROOM_CONTRACT.md` — cross-repo schema and RPC contract
- `OPTIMIZATION_LOOP.md` — agentic optimization loop the build implements
- `SCHEMA_DEFINITION.md` — persona schema
- `THEME_TOPIC_POINTS_DEFINITION.md` — definitions of editorial layers
- `SYNTHETICALRESEARCH_API_CHANGES.md` — SSR API spec to implement

**Current authorized work.** The full product direction is Setup → Theme → Topic → Points → Research → Outline → Draft → Polish → Ship with agentic optimization rounds at every layer (per `OPTIMIZATION_LOOP.md`). The only authorized next implementation gate is local Phase 0p. Cloud migration, live Skills, and production hardening are blocked until Phase 0p stop/go metrics pass.

> **Note on document state.** Planning-phase doc. Phase scope, gate criteria, and per-phase test lists can change freely until first production deployment.

---

## 0. How this doc relates to everything else

`01_ARCHITECTURE.md` and `02_HERO_APPLICATIONS.md` are *reference* docs. They describe the substrate and the apps in full. They don't tell you what to commit on a Tuesday morning.

This doc fills that gap. It's the engineering execution plan: *for each phase, in each repo, what files change and what tests must pass before the phase ships.*

The kickoff prompt (`06_PHASE_1A_KICKOFF.md`) is what you paste into Claude Code to start work. It's derived from this build plan but designed to be self-sufficient — Claude Code shouldn't need to read this whole doc to start working.

---

## 1. Phase ladder summary

```
Phase 0 (decisions, no code)
    ↓
Phase 0p (ONLY AUTHORIZED NEXT BUILD: local Setup/portfolio + editor proof MVP, ~32-48h)
    ↓
0p stop/go decision
    ├── STOP/SIMPLIFY: collapse weak workflow parts and rerun 0p
    └── GO: authorize the smallest next productionization step
            ↓
Phase Pre-1 (blocked backlog: cloud/substrate minimum, ~110h)
    ↓
Phase 1A (production Editorial Room layered proof loop)
    ↓
Phase 1A.5 (Optimize Watcher + deeper scoring)
    ↓
Phase 1B (Editorial Stages 1, 2, 4)
    ↓
Phase 1B-PT (Panel Talk dialectical synthesis + spiral-forward to Editorial Room — see §7.5)
    ↓
Phase 1C (Editorial polish + scheduled briefs)
    ↓
Phase 2A (Panel Talk Core, slim MVP)
    ↓
Phase 2B (Panel Talk richness)
    ↓
Phase 3 (Personal context capture, broader page types)
    ↓
Phase 4 (Outbound exporters beyond Markdown/Drive)
    ↓
Phase 5 (Cross-app affordances)
```

This doc currently goes deep on Phase 0, 0p, Pre-1, and 1A. Only Phase 0p is an instruction to build now. Pre-1 and 1A are retained as planning inventory so the local proof loop does not paint the later architecture into a corner.

**Current execution mode:** hard 0p gate. Build the local proof MVP first, using fixture data and a fixture-first adapter boundary. Do not start Supabase/Auth/Cloud Run migration, the 116-table Postgres port, live multi-Skill scoring, live rocketorchestra dependency work, or production Draft/Polish/Ship implementation until the 0p stop/go metrics pass and Joseph explicitly authorizes the next gate.

---

## 2. Phase 0 — Lock decisions before any code

These decisions are locked. Re-deciding them mid-build is the path to scope creep and architectural drift. If a future situation argues for changing one, that's a deliberate amendment to this doc, not a quiet override.

| Decision | Locked value | Reference |
|---|---|---|
| Editor canonical format | Tiptap JSON + per-revision Markdown snapshot | `01_ARCHITECTURE.md` §6.1 |
| Production hosting target | eventual production clawrocket + rocketorchestra on Cloud Run; shared Supabase Postgres + GCP KMS; SQLite eliminated; unified `auth.users`. This is **not** authorized before the 0p stop/go decision. | `01_ARCHITECTURE.md` §2.5 + §3.0 |
| Provider model | BYOK first-class, subscription-compatible | `01_ARCHITECTURE.md` §3.0 |
| Context modes | Future Phase Pre-1 storage/runtime contract (`context_mode`, default `persistent`) after 0p passes; 0p proves the UI/contract with fixtures only | `01_ARCHITECTURE.md` §5.3 |
| Momentary panel semantics | Future Phase Pre-1 `talk_kind` substrate extension after 0p passes; deeper Panel Talk UX remains later | `01_ARCHITECTURE.md` §5.7 |
| Cross-app navigation v1 | Separate panel lists per app; "Recent Thinking" view is Phase 4+ | `02_HERO_APPLICATIONS.md` §0 |
| First proof loop | Editorial Room setup + portfolio workflow before Draft | `05_DESIGN_BRIEF.md` §2 |
| Setup ownership | clawrocket owns `EditorialPiece.setup_state` with `setup_version`; it stores refs to rocketorchestra voice/persona/scoring pages and clawrocket agent profiles. Setup changes stale dependent scores/proposals/draft briefs. | `/plan-eng-review` 2026-04-29 |
| Score ownership | clawrocket owns `score_snapshots` keyed by Piece, `setup_version`, object ref/content hash, scoring pipeline ref, and selected persona refs. rocketorchestra owns scorer configs and returns `ScoreResult`. | `/plan-eng-review` 2026-04-29 |
| LLM Discussion ownership | clawrocket owns `discussion_sessions` scoped to Piece/phase/object/setup version with `talk_kind='editorial_scoped'`; sessions reuse Talk/run infrastructure but are hidden from Panel Talk lists unless explicitly promoted. | `/plan-eng-review` 2026-04-29 |
| Point note ownership | clawrocket owns `point_note_blocks` scoped to Piece/point/setup version; notes promote to rocketorchestra `point` / `claims_ledger` via `propose_update` only when the user chooses. | `/plan-eng-review` 2026-04-29 |
| Incognito v1 guarantee | Local no-index + clawrocket-owned purge boundary; provider-side deletion is best-effort with audit and never promised as hard deletion | `01_ARCHITECTURE.md` §5.3 |
| First export targets | Markdown copy/download, Google Docs, and Substack-flavored Markdown | `02_HERO_APPLICATIONS.md` §10 |

Phase 0 produces this row of locked decisions. No engineering hours.

---

## 3. Phase 0p — Local proof MVP before cloud migration

**Goal:** Prove the two highest-risk Editorial Room loops locally before spending any Supabase/Auth/Cloud Run migration budget:

1. Setup + portfolio workflow: deliverable/audience/agent/scoring setup, Theme/Topic, Points/Notes, fixture LLM Discussion, and score-improvement proposals.
2. Draft editor contract: Tiptap JSON, Markdown snapshots, source-map feasibility, suggestions, revisions, and Substack-flavored Markdown export.

This is the real MVP gate, not optional prep. It must run on the current local clawrocket stack, with fixture data and a fixture-first adapter boundary. Live rocketorchestra calls are allowed only behind the same adapter as an optional toggle after the fixture path works. If either local loop fails here, simplify the product or contract before migrating infrastructure.

**Explicitly not in Phase 0p:**
- No Supabase/Auth/Cloud Run migration.
- No 116-table Postgres port.
- No live rocketorchestra dependency required for acceptance.
- No production multi-Skill scoring system.
- No production Draft/Polish/Ship implementation beyond the local editor/export contract proof.
- No fine-grained source-map expansion beyond what the fixture editor proof can verify; block-level anchors with honest stale behavior are acceptable for the 0p decision if span-level anchoring proves brittle.

### 3.1 In `clawrocket` (~32-48h, timeboxed)

| # | Task | Files / fixtures | Acceptance |
|---|---|---|---|
| 0p.c1 | Build the smallest local Setup/portfolio vertical slice | Local dev stack + fixture data + fixture adapter | User can select deliverable, voice/length/destination, audience personas, agent profiles, and scoring pipeline; then move through Theme/Topic and Points/Notes with fixture-backed data. No rocketorchestra call, cloud migration, or live Skill required |
| 0p.c2 | Freeze the executable cross-repo contract | `docs/EDITORIAL_ROOM_CONTRACT.md` + `docs/contracts/editorial-room/v0/*.schema.json` + fixture files | Contract specifies `SetupState`, `Theme`, `Topic`, `Point`, `PointNote`, `point_note_blocks`, note promotion payloads, `ScoreSnapshot`, `ScoreResult`, scoped `discussion_sessions`, LLM Discussion turn/proposal shapes, `MarkdownSourceMap`, `Suggestion[]`, `run_skill`, and `get_run` schema versions, required/nullable fields, idempotency replay behavior, stale revision/hash behavior, payload caps, and fixture locations in both repos. JSON Schemas are the canonical machine contract: every schema has `$id`, `schema_version`, required/nullable fields, payload caps where applicable, and `additionalProperties: false` unless the contract explicitly reserves an extension object. |
| 0p.c3 | Add shared proof-loop fixtures | Setup + portfolio fixture set; one GameMakers draft fixture; one Adversarial Cut response; one Opus Review response | Fixtures include setup selection, agent profiles, audience personas, scoring pipeline, theme/topic/point hierarchy, typed point notes, score snapshots/results in `pending` / `unknown` / `stale` / `partial` / `scored` states, LLM discussion proposals, partial-provider timeout/failure examples, cost/latency budget metadata, retained/rejected proposal outcomes, and draft suggestion fixtures with source-map refs. Every fixture validates against the versioned JSON Schema package; both clawrocket and rocketorchestra tests consume the same fixture files or a generated copy with checksum verification. |
| 0p.c3a | Source-map feasibility spike | `docs/EDITOR_SOURCE_MAP_SPIKE.md` + editor fixture tests | Verify the installed Tiptap Markdown path against official docs/package behavior, freeze the supported Markdown subset, and prove block-level anchors first. The 0p `MarkdownSourceMap` contract requires stable block IDs/content hashes, block Markdown ranges, and stale behavior. Span-level refs are optional until paragraph/list/table/code fixtures prove deterministic generation and re-resolution. |
| 0p.c4 | Local portfolio acceptance gate | Manual + automated fixture test | Joseph can choose setup, select a theme/topic, select one active point, add Thought / Claim / Evidence / Question / Counterpoint notes, run fixture `Find stronger topics` / `Improve toward score` / `Research this point`, and accept/edit/reject/park proposals without touching rocketorchestra. The discussion/proposal loop records which outputs are retained, estimated cost, elapsed latency, and partial-provider failures; one agent timeout/failure must leave a usable partial result and must not block accept/edit/reject/park. |
| 0p.c5 | Local editor acceptance gate | Manual + automated fixture test | Joseph can paste/load the fixture draft, render block-level anchored suggestions, accept one, reject one, edit one, see a new revision, mark stale suggestions safely, and export Substack-flavored Markdown locally; Substack fixture output preserves expected publish structure. Span-level suggestions are accepted in 0p only if the feasibility spike proves them stable. |
| 0p.c6 | Write the stop/go memo | `docs/PHASE_0P_STOP_GO.md` | Memo records pass/fail against the metrics below, product changes learned from dogfooding, which scope to simplify, and whether cloud migration is authorized, delayed, or killed |

### 3.2 Phase 0p verification

Before any Pre-1 or 1A work can be authorized:
- Run executable contract fixture/schema tests for setup, portfolio, `point_note_blocks`, note promotion payloads, `score_snapshots`, `ScoreResult`, scoped discussion sessions/proposals, `MarkdownSourceMap`, `Suggestion[]`, `run_skill`, and `get_run`; both repos must validate the shared fixtures against the same `docs/contracts/editorial-room/v0/*.schema.json` files before implementation can proceed.
- Run the source-map feasibility tests: Tiptap Markdown support verified, supported Markdown subset frozen, block-level anchors deterministic, stale/ambiguous block behavior correct, and span-level anchors explicitly marked supported or deferred.
- Run the local Setup/portfolio fixture test end-to-end in clawrocket.
- Run debate/proposal value tests: retained-output telemetry, per-action cost/latency budget checks, and partial-provider timeout/failure behavior.
- Run the local editor fixture test end-to-end in clawrocket.
- Run the Substack fixture output check for expected publish structure.
- Confirm no rocketorchestra call, Supabase migration, or Cloud Run deploy is required for either local acceptance gate.

### 3.3 Phase 0p stop/go metrics

Cloud migration is blocked until this decision is written down.

**GO only if all are true:**
- Joseph can complete the local Setup -> Theme -> Topic -> Points/Notes -> proposal action flow without manual DB edits, JSON edits, or a rocketorchestra/cloud dependency.
- Joseph can complete the local editor proof: load/paste a GameMakers draft, render fixture suggestions, accept/reject/edit them, create a new revision, mark stale suggestions safely, and export Substack-flavored Markdown.
- The workflow is worth using for the next real GameMakers piece: Joseph rates it at least 4/5 useful or explicitly says he would use it for the next article.
- At least one proposal or discussion output becomes a retained note/point improvement during the dogfood run; scoring states lead to a concrete action instead of decoration.
- Discussion/proposal actions stay within the Phase 0p budget recorded in `docs/PHASE_0P_STOP_GO.md` and show elapsed latency/cost honestly; partial provider failure degrades to a partial result with clear status instead of blocking the workflow.
- Boundary and performance tests pass for Setup stale cascades, Piece-local notes, hidden editorial discussions, and batched portfolio-board reads.

**SIMPLIFY and rerun 0p if any are true:**
- Setup feels like form-filling rather than sharpening the piece.
- Score badges do not change decisions.
- LLM Discussion produces structured noise, has no retained outputs, exceeds the 0p cost/latency budget, or blocks on a failed provider; replace it with narrower proposal actions.
- Source-map anchoring is brittle; fall back to block-level anchors plus honest stale behavior.
- Export is not used; keep Markdown copy/download and defer Google Docs/Substack refinements.

**STOP or delay cloud migration if the local loop does not improve writing throughput or decision quality.**

---

## 4. Phase Pre-1 — Blocked productionization backlog

This section is not the next implementation task. It is the productionization backlog to revisit only after `docs/PHASE_0P_STOP_GO.md` says GO.

Phase Pre-1 starts only after Phase 0p passes the stop/go metrics and Joseph explicitly authorizes cloud productionization.

### 4.1 In `rocketorchestra` (~22h)

| # | Task | Files / migrations | Acceptance |
|---|---|---|---|
| Pre-1.r1 | Add verified `provider_model_metadata` registry + maintenance path | New/extended migration + repository/API surface + `docs/PROVIDER_METADATA_PLAYBOOK.md` | Model rows include nullable `has_web_search`, `emits_citations`, and `context_window_tokens`; no model names are hardcoded from this plan; supported models are verified from official docs/API at implementation time; rows include `source_url`, `last_verified_at`, and `verified_by`; the playbook defines source priority, manual refresh command, stale threshold, reviewer owner, fallback semantics, and how to add/remove/deprecate models; unknown/stale metadata renders as unknown in UI |
| Pre-1.r2 | Mint scoped agent token for clawrocket | `src/rocketorchestra/api/agents.py` (extend only if current scopes are insufficient) | `POST /api/agents` returns `roc_<32B base64url>`; token is SHA-256 hashed; scopes include only the page-read, Skill-run, and run-poll capabilities needed by Phase 1A; denied over-scope/tool requests fail closed and write audit rows |
| Pre-1.r3 | Add/verify Skill MCP routes: `run_skill`, `get_run` | `src/rocketorchestra/mcp/tools.py` (extend) | Both tools listed in `get_manifest`; draft Skill inputs accept `schema_version`, idempotency key, target revision/hash, Markdown snapshot, and `MarkdownSourceMap`; payload caps enforced; per-tool capability audit log row written; rocketorchestra does **not** proxy draft writes (`list_drafts`, `get_draft`, and `propose_revision` remain clawrocket-owned) |
| Pre-1.r4 | Add Skill run idempotency schema | Migration + run dispatcher | Repeated `run_skill` calls with the same idempotency key return the same run or terminal result; duplicate jobs are not enqueued |
| Pre-1.r5 | Add scheduler lease acquire/release helper | Scheduler repository + tests | Single active scheduler lease per job; stale lease can be reclaimed; concurrent replicas do not double-run cron work |
| Pre-1.r6 | Add incognito-purge cron driver | Scheduler job + clawrocket internal client | Cron acquires a lease, calls clawrocket's internal purge endpoint, and records provider-deletion/audit work items; rocketorchestra never directly deletes clawrocket Talk rows |

### 4.2 In `clawrocket` (~88h, includes cloud migration)

**Cloud-migration tasks first (Pre-1.c0a–c0g) — blocked until Phase 0p GO:**

Repo survey note: as of 2026-04-29, `src/clawrocket/db/init.ts` contains 116 `CREATE TABLE` statements, not the earlier rough `~50` estimate. Cloud remains the likely production path because `rocketorchestra` already has Supabase Auth, asyncpg, KMS envelope vaulting, agent tokens, and Cloud Run Jobs infrastructure. It is not the next gate. The plan treats the clawrocket migration as a major productionization bet that must be earned by Phase 0p evidence.

| # | Task | Files / migrations | Acceptance |
|---|---|---|---|
| Pre-1.c0a | Add clawrocket's tables to rocketorchestra's existing Supabase project | Provision new schema or use shared `public` with `cw_` prefix on tables | Both repos can connect to the same Supabase URL with documented repo-specific config/secrets; Supabase `service_role` is treated as a global admin bypass, not app isolation; clawrocket can write a test row through the intended runtime path |
| Pre-1.c0b | Translate 116 SQLite tables from `src/clawrocket/db/init.ts` to Postgres | New folder: `clawrocket/supabase/migrations/cw_*.sql`, one per logical migration | All clawrocket-owned tables exist in Postgres; local auth/session tables are intentionally excluded or replaced by Supabase Auth; foreign keys validate; JSONB used for JSON columns; TIMESTAMPTZ for timestamps |
| Pre-1.c0b-1 | Define and pass migration behavior parity gate | Fixture suite comparing representative SQLite fixtures/routes against the Postgres port | Existing local SQLite data is disposable, but existing clawrocket behavior is not: IDs/foreign keys, ordering, defaults, nullable fields, JSON serialization, cascade behavior, transactional boundaries, idempotency, and error semantics match; any intentional behavior change is named in `docs/DB_OWNERSHIP.md` with the reason and affected routes |
| Pre-1.c0b-2 | Port and prove hot-path indexes | Postgres migrations + large-fixture query-plan tests | Required indexes exist for draft load, revision history, pending suggestions, accept/reject/edit reads, and RLS ownership checks; large-fixture query-plan checks prove those paths use the intended indexes |
| Pre-1.c0c | Replace `better-sqlite3` with `postgres.js`; convert sync DB accessors to async | Update `package.json`; rewrite `src/clawrocket/db/accessors.ts`, `src/clawrocket/db/talk-tools-accessors.ts`, and related DB callers | All existing test suites pass against the Postgres backend; no `better-sqlite3` import remains in src/; transaction boundaries remain explicit after async conversion |
| Pre-1.c0d | Replace clawrocket cookie/session auth with Supabase Auth (JWT + refresh) | Drop `users`, `web_sessions`, `oauth_state`, `device_auth_codes` tables; add `auth.users(id)` FK on remaining clawrocket-specific identity tables (`user_google_credentials`, etc.); implement HttpOnly cookie + JWT verifier + refresh flow matching rocketorchestra's pattern | Sign in via Supabase Auth from clawrocket; session persists; clawrocket recognizes the same user as rocketorchestra; Google OAuth link/export flows either preserve credential ownership through `auth.users(id)` or force an explicit reconnect with a clear UI state |
| Pre-1.c0d-1 | Define the Cloud/Auth/RLS access contract before rewriting handlers | `docs/DB_OWNERSHIP.md` + auth middleware tests | Supabase `service_role` is documented as a global RLS bypass, not an app-scoped user role; normal request handlers use user JWT/authenticated-role semantics or an explicit user-id guard if an internal service connection is unavoidable; service-role/admin credentials are limited to migrations, drift checks, and named internal jobs; cookie settings cover localhost, Cloud Run URLs, and custom domains with HttpOnly/Secure/SameSite, refresh rotation, CSRF, redirect allowlists, and `Cache-Control: no-store` on auth-dependent responses |
| Pre-1.c0e | Containerize clawrocket; deploy to Cloud Run | `Dockerfile` + cloudbuild.yaml or GitHub Actions; service named `clawrocket` in same GCP project as rocketorchestra | `https://clawrocket-<hash>-uc.a.run.app` (or custom domain) serves the webapp; cold-start works; logs visible in Cloud Logging |
| Pre-1.c0e-1 | Set explicit DB connection budget before deploy | Runtime DB config + `docs/DB_OWNERSHIP.md` | Runtime uses a documented Supabase connection mode; `postgres.js` has explicit pool `max`, idle/connect timeouts, and app name; Cloud Run max instances × pool size stays under the Supabase connection budget after reserving rocketorchestra/admin capacity; migration/admin scripts use a separate direct/admin connection; if using transaction pooler, prepared statements are disabled |
| Pre-1.c0e-2 | Add cloud cutover rollback, backup, and canary gate | Deploy scripts + `docs/DB_OWNERSHIP.md` / ops note | Before production traffic, run staging/preview smoke tests, take a Supabase backup or snapshot, prove restore into a scratch DB/project, document image rollback to the prior Cloud Run revision, and run canary checks for auth, draft load/save, Google OAuth reconnect/export, and rocketorchestra MCP health |
| Pre-1.c0f | Cross-repo verification | Manual end-to-end | Sign in once → both clawrocket and rocketorchestra recognize the user; clawrocket can call rocketorchestra MCP successfully via service-to-service or user JWT |
| Pre-1.c0g | Add shared Supabase DB ownership contract + drift gate | `docs/DB_OWNERSHIP.md` in both repos + CI migration check | Prefix/schema ownership documented; migration manifest records applied revisions per repo; CI blocks deploy when code references unapplied migrations; RLS tests run as anon/authenticated/service-role and prove service-role bypass is not used in request handlers |

**Substrate items (Pre-1.c1 onwards) — start after c0g passes:**

| # | Task | Files / migrations | Acceptance |
|---|---|---|---|
| Pre-1.c1 | Add `rocketorchestra_link` table + Settings UI | `clawrocket/supabase/migrations/cw_rocketorchestra_link.sql` + `webapp/src/pages/SettingsPage.tsx` | User can paste agent token + base URL; health probe shows green |
| Pre-1.c2 | Add `context_mode` to Talks | Postgres migration + Talk create/update routes | Existing talks default to `persistent`; incognito talks are excluded from capture, indexes, exporters, scheduled jobs, and panel-list queries |
| Pre-1.c3 | Add `talk_kind` substrate extension | Postgres migration + runtime discriminator | Supports normal, momentary, and editorial draft-oriented talks without overloading app-specific fields |
| Pre-1.c4 | Add `talk_output_revisions` table with `content_json` (JSONB), `content_md_snapshot` (TEXT), and `markdown_source_map` (JSONB) | `clawrocket/supabase/migrations/cw_talk_output_revisions.sql` | Schema matches `01_ARCHITECTURE.md` §6.1; source map is stored per revision with the Markdown snapshot; foreign key to `talk_outputs`; unique on `(output_id, revision_number)`; RLS enabled |
| Pre-1.c5 | Add `talk_output_suggestions` table | Same migration as c4 | Schema matches `01_ARCHITECTURE.md` §6.1; includes `schema_version`, `revision_id`, `target_content_hash`, `source_map_refs`, Markdown range, `anchor_quote`, `anchor_content_hash`, context fields, and anchor/status enums; RLS enabled |
| Pre-1.c6 | Add draft REST routes + external clawrocket MCP draft tools | `src/clawrocket/web/routes/drafts.ts` + clawrocket MCP route module | App can create/read/save drafts and append revisions/suggestions atomically; `list_drafts`, `get_draft`, and `propose_revision` are clawrocket-owned; `propose_revision` is idempotent and transactional |
| Pre-1.c6a | Add internal incognito purge endpoint | `POST /api/internal/incognito-purge` | Endpoint authenticates rocketorchestra's scheduler token, deletes/cleans clawrocket-owned Talk rows and indexes transactionally, and returns an audit summary; rocketorchestra never deletes clawrocket rows directly |
| Pre-1.c6b | Preflight the rocketboard port before copying code | `docs/ROCKETBOARD_PORT_NOTE.md` | Inventory donor Tiptap extensions, React/version assumptions, CSS/UI dependencies, storage/auth assumptions, Supabase/project-view bindings, unsupported imports, and package/version deltas against clawrocket; note what ports directly, what must be adapted, and what must not be imported |
| Pre-1.c7 | Port rocketboard's Tiptap foundation (`RichTextEditor.tsx`, `rich-text.ts`, `tiptap-to-markdown.ts`, `link-url.ts`, `prepare-content.ts`) | `webapp/src/features/editor/*` | Editor renders a Tiptap doc; serializes to markdown deterministically; round-trips JSON→md→JSON for the supported subset |
| Pre-1.c8 | Add Markdown→Tiptap adapter | `webapp/src/features/editor/markdown-to-tiptap.ts` (new) | Adapter uses Tiptap's official Markdown support first; add custom fallback only for unsupported constructs discovered by tests; common Markdown (headings, lists, code, tables, links) parses to valid Tiptap JSON; round-trip JSON→md→JSON is structurally identical for the supported subset |
| Pre-1.c8a | Add `MarkdownSourceMap` generator + suggestion anchor resolver | `webapp/src/features/editor/suggestion-anchors.ts` (new) | Generates deterministic `MarkdownSourceMap` from canonical Tiptap JSON + Markdown snapshot; stores it on each revision; caches source maps and resolved positions by `revision_id + content_hash`; resolves Skill-returned source-map refs back to ProseMirror positions for the source `revision_id` and `target_content_hash`; quote/hash/context fallback works only when unambiguous; ambiguous or stale anchors are marked `stale` instead of mutating the draft |
| Pre-1.c9 | Port rocketboard's `useDocumentHistory.ts` undo/redo hook | `webapp/src/features/editor/useDraftHistory.ts` | 80-step ring buffer over `{title, contentJson}`; ⌘+Z / ⌘+Shift+Z work in editor |
| Pre-1.c10 | Port rocketboard agent profile model | `agent_profiles` migration + `AgentProfileSwitcher.tsx` + `AgentProfileEditDialog.tsx` | Donor `ai_personas` schema becomes clawrocket `agent_profiles`; user-facing copy says agent/profile; `persona` stays reserved for rocketorchestra audience/persona pages |
| Pre-1.c11 | Port rocketboard 3-provider streaming parser logic | `webapp/src/features/talks/streaming-parsers.ts` | Anthropic, OpenAI, and Google delta parsers are covered by fixtures and used for per-column rendering without importing rocketboard |
| Pre-1.c12 | AutoNovel Mechanical scorer — TS port from `autonovel/evaluate.py:slop_score()` | `webapp/src/features/editor/mechanical-scorer.ts` | Freeze the scoring spec before porting; Tier1 banned words, tier2 clusters, tier3 fillers, em-dash density, sentence-length CV, transition-opener ratio all detected; runs in browser; matches Python behavior on a fixture corpus covering short drafts, long drafts, headings, lists, repeated phrases, hedges, weak verbs, code blocks, quotes, and near-threshold cases |

### 4.3 Phase Pre-1 cross-repo verification

Before production Phase 1A starts, after Phase 0p says GO:
- Run the full Phase 1A subset in `01_ARCHITECTURE.md §17`, including context-mode, incognito, provider-metadata, cron/idempotency, export, and drift-gate coverage.
- Run the migration behavior parity gate before Cloud Run deploy: representative SQLite fixtures/routes must match the Postgres port, and any intentional behavior change must be documented in `docs/DB_OWNERSHIP.md`.
- Run hot-path index/query-plan checks for draft load, revision history, pending suggestions, accept/reject/edit reads, and RLS ownership checks.
- Run the DB connection budget check: Cloud Run max instances × pool size plus rocketorchestra usage and reserved/admin capacity stays under the Supabase connection budget; transaction-pooler mode disables prepared statements if used.
- Run the shared Supabase drift gate in both repos; deploy is blocked unless both migration manifests match the target DB.
- Run RLS/user-isolation tests with anon, authenticated, and service-role credentials; application request paths must not depend on service-role bypass.
- Run the Cloud/Auth/RLS access-contract tests across localhost, Cloud Run URL, and custom-domain modes: cookies, refresh rotation, CSRF, redirect allowlists, cache/no-store, and service-role denial on normal request paths.
- Run provider metadata maintenance tests: seeded official-source rows render provenance, missing fields render unknown, metadata older than the stale threshold shows stale UI, the manual refresh command updates `last_verified_at` without dropping unknown fields, and deprecated/missing models fall back without blocking Skill dispatch.
- Run Google OAuth survival/reconnect tests after Supabase Auth migration: Google Picker, Google Docs export, missing/revoked credential state, and scope expansion.
- Run backup/restore, rollback, and canary checks before production traffic: restore to scratch DB/project, roll back to the prior Cloud Run revision, and smoke auth, draft load/save, export, and MCP health.
- Confirm clawrocket can mint an agent token, hit rocketorchestra MCP, and read a sample page.

---

## 5. Phase 1A — Editorial Room layered proof loop

**Goal:** Joseph takes a piece end-to-end through the layered flow: conceptually **Setup → Theme → Topic → Points → Research → Outline → Draft → Polish → Ship**, but the **visible UI consolidates these into 6 phase pills**: `01 SETUP | 02 THEME + TOPICS | 03 POINTS + OUTLINE | 04 DRAFT | 05 POLISH | 06 SHIP`. Theme + Topic share one screen (combined workspace, B++ four-column); Points + Outline share one screen (combined, PO5+ chevron-toggleable); Sources/Research is a tab inside the Points + Outline workspace. Setup defines the deliverable, voice/length/destination, audience personas, LLM agent profiles, and scoring system. Portfolio of themes/topics/points is real and persistent; each subsequent piece on the same theme reuses portfolio and ships faster. **Canonical UI specs: `design/01_setup.md` through `design/04_draft.md`.**

**Acceptance trajectory (revised v4):** time-to-first-piece is **3–5 hours** (you're investing in portfolio); time-to-fifth-piece on same theme is **~90 minutes**; time-to-tenth-piece is **45–60 min**. The single-piece speed target moves to "by piece 5," not "Phase 1A acceptance."

**Implementation gates after the scope challenge. Only the 0p row is authorized now; all later rows are blocked until `docs/PHASE_0P_STOP_GO.md` says GO.**

| Gate | Scope | Ship condition |
|---|---|---|
| 0p — Local proof MVP | Setup surface, Theme/Topic workspace, Points/Notes workspace, scoped fixture LLM Discussion, fixture score-improvement proposals, local editor/export contract, executable contracts, and stop/go memo | Joseph can validate the workflow and data shapes before live Skills, cloud migration, or production Draft/Polish are built |
| 1A-G1 — Live substrate + scoring proposals | Rocketorchestra page types, `run_skill` / `get_run`, Skill idempotency, clawrocket score snapshot persistence, and live proposal flows | Fixture-backed proposal actions can be swapped to live Skill results without changing UI contracts |
| 1A-G2 — Draft / Polish / Ship | Tiptap editor, source-map anchored suggestions, revision history, mechanical scorer, exports | The editor proof loop works against fixture or live Skill outputs and export fixtures |
| 1A-G3 — Full dogfood acceptance | End-to-end §5.3 flow including optimization rounds | Joseph publishes through the workflow without manual workarounds |

### 5.1 In `rocketorchestra` (~244h — original ~78h plus ~166h optimization-loop scope absorbed into 1A-G1)

| # | Task | Files | Acceptance |
|---|---|---|---|
| 1A.r0 | `theme` / `topic` / `point` page-type substrate | Postgres migrations + page validators + MCP page-tool support | Three new page kinds registered; `parent_theme_slug` (nullable, defaults `theme/misc`) on topic; `parent_topic_slug` (single, required) on point; conviction enum on point; novelty score field on topic; existing MCP page tools (`list_pages`, `get_page`, `query_context`, `propose_update`) work for all three new types; RLS enabled |
| 1A.r1 | `factory_topic_propose` Skill | `src/rocketorchestra/runtimes/factory_topic_propose.py` | Inputs: parent `theme` + `industry_signal` + `back_catalog`. Output: 3-5 candidate `topic` page proposals with thesis, why-now, novelty score. Contract test on fixture |
| 1A.r2 | `factory_point_propose` Skill (multi-LLM) | `src/rocketorchestra/runtimes/factory_point_propose.py` | Inputs: parent `topic` thesis + `voice`. Output: 4-8 candidate `point` entries from N agents. Each model proposes its own points; output is union with attribution. Contract test |
| 1A.r3 | `factory_point_debate` Skill (multi-LLM panel — centerpiece) | `src/rocketorchestra/runtimes/factory_point_debate.py` | Inputs: one `point` (claim + rationale) + parent topic + voice + audience personas (optional). Output: structured debate per agent — agree/disagree/refine, strongest counter-evidence, what would change a Skeptic's mind. The panel mechanic finally earns its keep. Contract test on fixture |
| 1A.r4 | `factory_claim_research` Skill | `src/rocketorchestra/runtimes/factory_claim_research.py` | Inputs: one `point` (claim). Output: proposed evidence — source URLs, quote candidates, supporting/contradicting back_catalog refs. Output flows into `claims_ledger` as proposed entries |
| 1A.r5 | `factory_outline_builder` Skill (chat-driven) | `src/rocketorchestra/runtimes/factory_outline_builder.py` | Inputs: thesis + locked points + voice + deliverable shape + chat history. Output: structured outline (sections, hook options, point-to-section mapping, payoff). Stateful — accepts incremental "user wants this section moved / this point promoted / this hook chosen" turns and re-emits the outline structure |
| 1A.r6 | `factory_argument_critic` Skill (layer-3 critic) | `src/rocketorchestra/runtimes/factory_argument_critic.py` | Inputs: thesis + draft + claims_ledger. Output: structured critique — weakest claim, missing premise, unsupported leap, alternative thesis. Source-map-anchored where claims map to draft passages |
| 1A.r7 | `factory_counter_audience` Skill (layer-3 critic) | `src/rocketorchestra/runtimes/factory_counter_audience.py` | Inputs: thesis + draft + persona ref (most-skeptical). Output: persona's predicted reaction — bounce points, evidence that would shift them. Source-map-anchored |
| 1A.r8 | `factory_claim_coverage` Skill (layer-3 audit) | `src/rocketorchestra/runtimes/factory_claim_coverage.py` | Inputs: draft + claims_ledger. Output: which approved claims appear, which don't, which contradict the ledger, which are stated unbacked. Source-map-anchored |
| 1A.r9 | Port `factory_opus_review` Skill — now a **polish** Skill | `src/rocketorchestra/runtimes/factory_opus_review.py` | Same as v3; reframed as Polish-stage skill. Persona-retargeted to industry editor + game-dev reader |
| 1A.r10 | Port `factory_adv_cut` Skill — now a **polish** Skill | `src/rocketorchestra/runtimes/factory_adv_cut.py` | Same as v3; Polish-stage. Categories: filler / repetition / hedge / weak_verb / tangent |
| 1A.r11 | Add `voice` page seed for the user (one hand-written page) | Manual content | One `voice/gamemakers-2026` page exists with detailed prose voice spec; authored by Joseph, not generated |
| 1A.r12 | Seed 5–7 `theme` pages by hand | Manual content + `theme/misc` default | 5–7 GameMakers themes ("AI Impact on Game Dev," "The Rise of Chinese Game Dev," "UGC Gaming Industry," "Battlepass Game Design," etc.) hand-authored by Joseph; `theme/misc` default exists for orphan topics |
| 1A.r13 | Add minimal `claims_ledger` schema | Migration + page association | Claims from points + drafts can be recorded with source, status, owning point/output; deeper scorer workflow extends in Phase 1A.5 |
| 1A.r14 | `factory_theme_propose_optimize` Skill — multi-iteration Theme search (per `OPTIMIZATION_LOOP.md` §6.1) | `src/rocketorchestra/runtimes/factory_theme_propose_optimize.py` | Inputs: publication_id + voice_id + persona_panel + optional `SkillContext` (`pcp_window`, `pcp_types`, `seed_emphasis`, `exclude_existing_themes`). Output: top-K of 10 candidate Themes with rubric breakdown + per-persona SSR distributions + `PcpProvenance` when applicable. Aggressive diversity strategy enforced. ~16h |
| 1A.r15 | `factory_topic_optimize` Skill (per `OPTIMIZATION_LOOP.md` §6.2) | `factory_topic_optimize.py` | Inputs: theme_id + persona panel + optional `SkillContext`. Output: top-5 Topics with rubric + SSR + diversity-reserved slots. Cohort-targeted sub-loops per primary persona. Hard gates: rubric.specificity ≥ 3, disputability ≥ 3, theme_fit ≥ 4; SSR likelihood mean ≥ 3.5 per primary persona. Coexists with `factory_topic_propose` (single-call cheap mode); see `OPTIMIZATION_LOOP.md` §5b. ~14h |
| 1A.r16 | `factory_point_optimize` Skill (per `OPTIMIZATION_LOOP.md` §6.3) | `factory_point_optimize.py` | Inputs: topic_id + persona panel. Output: top-8 Points with 2 slots reserved for counter-argument-Points. Rubric gates: atomicity ≥ 4, falsifiability ≥ 3, source_strength ≥ 3, topic_fit ≥ 4. Coexists with `factory_point_propose`. ~12h |
| 1A.r17 | `factory_outline_optimize` Skill (per `OPTIMIZATION_LOOP.md` §6.4) | `factory_outline_optimize.py` | Inputs: topic_id + user-curated point_pool. Output: top-3 Outline structures (Point subset + ordering + section structure). Combinatorial generation; cost dominated by SSR scoring. ~10h |
| 1A.r18 | `factory_draft_polish_optimize` Skill — targeted-axis (per `OPTIMIZATION_LOOP.md` §6.5) | `factory_draft_polish_optimize.py` | Identifies lowest-scoring axis, generates 3 paragraph-scoped candidate fixes, scores each, returns top-K of 3 fixes. Default mode for posts/articles. Per-axis cheap (~$0.20–$0.50). ~12h |
| 1A.r19 | `factory_draft_fullsearch_optimize` Skill — opt-in (per `OPTIMIZATION_LOOP.md` §6.6) | `factory_draft_fullsearch_optimize.py` | Multi-candidate full-Draft regeneration with mandatory aggressive diversity, `slop_penalty ≤ 2.0` hard gate, mandatory double-confirm before launch. Game-script-specific extensions (branching coverage, `purchase_intent` Likert family for monetized choices). ~18h |
| 1A.r20 | `run_optimization` + `get_optimization_round` + `cancel_optimization_round` RPCs (per `EDITORIAL_ROOM_CONTRACT.md` §6.6 + §6.7) | `src/rocketorchestra/api/optimization.py` + Cloud Run Job for the loop runner | Loop runner orchestrates the multi-stage pipeline (generate → mutate → rubric → SSR → counter-audience → rank), emits `OptimizationProgress` events, respects `budget_usd` cap with project-and-abort, enforces two-vendor rule at config validation. Setup change mid-round runs to completion under original `setup_version`; cancellation preserves `acceptable_pool` per §4.7. ~24h |
| 1A.r21 | SSR API rewrite per `SYNTHETICALRESEARCH_API_CHANGES.md` | `packages/ssr-core/*` (new TS package vendored or wired via MCP) | Eight capabilities: externalized prompt template (§3), first-class AnchorSet CRUD (§4), two-vendor enforcement (§5), min-max + softmax + τ=0.15 (§6), asymmetric embedding (§7), confidence scoring (§8), batched generation/embed/scoring (§9), `draftAnchorSetFromPersona` helper (§10). Methodology-validation tests against bias-paper pilot set (≥ 14/17 exact match) and expanded set (≥ 43/69). ~32h |
| 1A.r22 | AnchorBundle seeds for GameMakers domain | `seeds/anchor_bundles/gamemakers_default.{likelihood,value,appeal,satisfaction}.yaml` | Hand-authored multi-variant AnchorBundles per primary Likert family seeded from primary persona `voice_of_customer_quotes`. Each variant passes API §4.4 validation rules: first-person, behavioral, no question text, mean inter-anchor cosine ≤ 0.85, no verbatim cross-variant reuse. Bundles ship with 5 variants per Likert family for averaging stability. ~10h |
| 1A.r23 | BYOK lease batching for high-volume Skill calls | `src/rocketorchestra/api/distribute.py` | Optimization rounds (~480 calls/round) use a single batched lease per provider per round instead of per-call. Lease envelope encrypts a decrementing token bucket; rocketorchestra audits per-round call totals. ~10h |
| 1A.r24 | PCP-context resolution for Theme propose-optimize | `src/rocketorchestra/skills/pcp_context.py` | Reads PCP page library (calendar, linear, slack_dm, work_this_week, github_activity, manual_notes, etc.) for the requesting user, scoped to `pcp_window`. Filters to `pcp_types` if provided. Returns structured seed events for the Skill prompt with provenance metadata. RLS enforces per-user isolation; PCP-derived pages default to `scope: personal`. ~12h |

### 5.2 In `clawrocket` (~198h — original ~130h plus ~68h optimization-loop UX scope absorbed into 1A-G1)

The 6-pill phase strip drives **5 distinct surfaces**: Setup, Theme + Topics workspace (combined), Points + Outline workspace (combined; chevron-toggleable), Draft Editor, and Ship/Export — plus Polish as an editor mode-shift inside Draft. **The earlier "Outline Builder" page is folded into the Points + Outline workspace; do NOT build it as a separate page.** Canonical UI specs: `design/01_setup.md` through `design/04_draft.md`.

| # | Task | Files | Acceptance |
|---|---|---|---|
| 1A.c0 | Phase-aware workspace shell with **6-pill** compact top phase strip | `webapp/src/components/PhaseStrip.tsx` + `webapp/src/pages/EditorialRoomShell.tsx` | Strip shows 6 pills: `01 SETUP \| 02 THEME + TOPICS \| 03 POINTS + OUTLINE \| 04 DRAFT \| 05 POLISH \| 06 SHIP`. Active pill dark fill + light text; visible-but-not-active pills muted with status text. Click navigates to that phase's surface. Audience/agent controls and Skill triggers do NOT live in the phase strip. Canonical spec: `design/01_setup.md` §2 + §4. ~6h |
| 1A.c0a | **Setup surface** — define what "good" means | `webapp/src/pages/EditorialSetupPage.tsx` + setup state/types | Three-column layout per `design/01_setup.md`: Setup Sections rail (~210px, jumpable not strict-wizard) + Active Section workspace + Live Preview rail (~330px). Four sections: Deliverable, Audience, LLM Room, Scoring System. User selects deliverable type, voice, length target, destination, audience personas from library, LLM agent profiles from library, and scoring system. Setup context persists on the Piece and appears in a secondary context bar. Progress dots show what's done; sections jumpable in any order. ~14h |
| 1A.c1 | **Theme + Topics workspace (combined)** — four-column Themes / Topics / Center detail / Sources rail | `webapp/src/pages/ThemeTopicsWorkspacePage.tsx` + `discussion_sessions` migration | Canonical spec: `design/02_theme_topics.md`. Four columns: Themes (~140px) + Topics (~155px) + Center editorial detail + Sources rail (~210px). Themes panel has `+ THEME`; Topics panel has `+ TOPIC` and SELECT. Center detail shows active Topic's workspace (one-liner, Notes panel with typed boxes — angle/stake/thought/concern/other — and Panel Discussion). **Per-persona score row sits above the active Topic detail as column headers** (NOT inside individual Theme/Topic cards). Right rail Sources panel for citations. Notes are typed boxes (NOT a discussion thread); Panel Discussion debates the notes and turns can `@reference` a note. Counter-Topics get separate sub-section with red accent. The Panel Discussion binds to the active Topic ref/hash/setup version with `talk_kind='editorial_scoped'`, hidden from normal Panel Talk lists. The board read batches themes/topics plus score snapshots and active discussion metadata in one bounded request; no per-card score or discussion queries. ~26h |
| 1A.c2 | **Points + Outline workspace (combined; chevron-toggleable)** | `webapp/src/pages/PointsOutlineWorkspacePage.tsx` + `webapp/src/features/points/PointNotesView.tsx` + `point_note_blocks` migration | Canonical spec: `design/03_points_outline.md`. One mental model, two layout states: state `a` (default) Notes-as-right-rail + Discussion-in-center; state `b` Notes-as-center + Discussion collapsed to bottom drawer. Toggle via chevron on divider, `⌘]`/`⌘[`, or drag. Left rail tabs: `Points 8 \| Outline · 5/5-7 \| + POINT \| OPT...`. Center column shows active Point detail (claim + stake + per-persona score row + 4 NOTES badge). Note types: claim/evidence/thought/question/counter/other (one-letter codes T/C/E/Q/!/O). Counter notes have `PROMOTE ›` chip → elevates to Counter-Point. Counter-Points get separate sub-section with red accent. Notes stay clawrocket-local until explicitly promoted via `propose_update`. Annotation: "panel never disappears, just gets quieter." Points board reads batch points plus score snapshots, note counts/previews, and active discussion metadata; no per-point follow-up queries. ~32h |
| 1A.c3 | Score snapshots + score-improvement actions for themes/topics/points | `webapp/src/features/scoring/*` + `score_snapshots` migration + Skill dispatch integration | Per-object scores are cached as stale-aware snapshots keyed by Piece/setup/object/pipeline/personas. Add indexes for board reads over `piece_id`, `setup_version`, object ref/type/hash, scoring pipeline ref, and selected persona refs. Explicit actions such as `Find stronger topics`, `Improve toward score`, and `Research this point` return proposals; nothing auto-promotes or overwrites. ~16h |
| 1A.c4 | **Outline tab inside Points + Outline workspace (NOT a separate page)** | `webapp/src/features/outline/OutlinePanel.tsx` + `webapp/src/features/outline/OutlineChat.tsx` (rendered as a tab within `PointsOutlineWorkspacePage.tsx`) | Outline assembly is the `Outline · 5/5-7` tab in the left rail of the Points + Outline workspace. The `factory_outline_builder` Skill is invoked from a button in the Outline tab (or via Panel Discussion proposal chip) and updates the structured outline alongside Discussion. User can also direct-edit (drag-reorder Points in left rail, attach/detach Points, edit hook). Outline is the artifact; Discussion + Skill is the construction surface. **Do NOT build `OutlineBuilderPage.tsx` as a separate page.** ~12h (down from 20h since the page shell + chat shell already exist in c2). |
| 1A.c5 | **Draft Editor** | `webapp/src/pages/DraftWorkspacePage.tsx` | Canonical spec: `design/04_draft.md`. Three columns: Outline rail (left, ~210px, with per-segment scores and tabs `Outline \| Sources \| Versions`) + draft prose center (Tiptap, flex 1) + Panel chat right (~280px, scoped to active draft segment). **Action toolbar: quick-action chips** (`FULL DRAFT ⌘D`, `POLISH ⌘P`, `EXPAND ⌘E`, `→ CONTINUE ⌘\\`, `? MISSING ⌘M`) on the left, **unified `+ OPTIMIZE ⌘O` button** (accented) on the right with scope chip. Optimize button opens scope-aware popover (4 stages: AUTORESEARCH → AUTONOVEL → PANEL PASS → PROPOSE 2-3 + cost preview + CUSTOMIZE + RUN ⌥↵). Layer-1-3 Skills (Argument Critic, Counter-Audience, Claim Coverage) run as part of Optimize Panel Pass and via proposal chips inside Panel chat. Layer-4 polish skills (Adv Cut, Opus Review) appear when user enters Polish mode (1A.c6), NOT here. Inline mechanical scorer + voice-lock banner per v3 spec. Suggestion overlay + revision history per v3 spec. Autosave: every ~1 minute, only if changes occurred. Versions tab: hybrid named (durable) + auto (last 20 autosaves, FIFO prune). Sub-meta bar with `⚠ NO TARGET` chip when Setup target is missing. ~28h |
| 1A.c6 | **Polish stage** within editor | extends Skills rail | When user clicks "Send to Polish" from Draft, Skills rail switches mode: now shows `factory_adv_cut` and `factory_opus_review` as headline skills. Same suggestion overlay + revision history. The user still writes in the Tiptap editor; Polish is a *mode shift* not a separate surface. ~6h |
| 1A.c7 | **Ship/Export pane** | `webapp/src/features/editor/ExportPane.tsx` | Four exports: Markdown copy, Markdown download, Google Docs (via `user_google_credentials`), Substack-flavored Markdown. Destination-fidelity tests per v3. ~6h |
| 1A.c8 | Production Brief side rail — used in Draft and Polish | `webapp/src/features/brief/ProductionBriefRail.tsx` | Shows Deliverable + Voice + Audience + Scoring System + current Theme + Topic + selected Points/Notes + Outline summary. Click any item to navigate back to its source surface. ~12h |
| 1A.c9 | `optimization_rounds` table + persistence | `webapp/src/db/migrations/cw_*_optimization_rounds.sql` + `webapp/src/lib/optimizationRounds.ts` | Per `EDITORIAL_ROOM_CONTRACT.md` §4.7 with all nested types (`TopKCandidate`, `RubricScore`, `SsrPersonaResult`, `CounterAudienceResult`). Indexes on `piece_id` + `setup_version`. Stale flag set on Setup change per §1. ~10h |
| 1A.c10 | Optimize popover + cost preview + launch UX (inside Draft toolbar, not separate modal) | `webapp/src/components/optimization/OptimizePopover.tsx` + `OptimizeCustomizePanel.tsx` + `DoubleConfirmModal.tsx` | Canonical spec: `design/04_draft.md` §5. Popover shows scope echo, dynamic description, 4 stages, cost preview (`≈28K TOK · 12S · ≈$0.08`, ±20% target accuracy with learned multipliers after ~20 runs), `CUSTOMIZE` (full autoresearch/autonovel/panel-pass/propose stage config — providers, anchor bundle, gate thresholds, alt count, loop knobs), `RUN ⌥↵`. v0P state: ship CUSTOMIZE functional if config schema pinned by build time, else visible-but-disabled. Editable `n_candidates` / `n_iterations` / `n_personas` / `budget_usd`. Mandatory double-confirm modal **only** for `target_kind = "draft_fullsearch"` per `OPTIMIZATION_LOOP.md` §5.3 (fires AFTER `RUN ⌥↵`). Drift >50% over preview logged silently to calibration ledger but NOT UI-surfaced at v0P. ~14h |
| 1A.c11 | Mid-run progress UX (inline in Draft toolbar) | `webapp/src/components/optimization/RunProgressChip.tsx` + `ProgressDetailDrawer.tsx` | Canonical spec: `design/04_draft.md` §5.6. While Optimize runs: toolbar `+ OPTIMIZE` button shows spinner + label `OPTIMIZING… 7s`. Progress chip shows current stage (`AUTORESEARCH → AUTONOVEL → PANEL PASS → PROPOSE`). Click chip opens drawer with live cost-so-far, projected-actual, current iteration, current phase (`generating` / `rubric_judging` / `ssr_scoring` / `counter_audience` / `ranking` / `merging_subloops`), `partial_provider_failures` badge. User can keep editing other parts of draft (background job). **Cancel** button in drawer preserves `acceptable_pool_ids`; cancellation policy per `EDITORIAL_ROOM_CONTRACT.md` §4.7 (in-flight LLM calls allowed to complete; partially-scored candidates excluded from `partial_top_k`). ~10h |
| 1A.c12 | Top-K candidate display + ProposalCard contents | `webapp/src/components/optimization/TopKList.tsx` + `ProposalCard.tsx` (extend) + `ScoreBreakdown.tsx` | Per-candidate ProposalCard surfaces `rubric_scores` (per axis with gap quote and fix), `ssr_distributions` (full PMF per primary persona with confidence), `counter_audience` objections (Drafts only), `comparable_history`, `diversity_position`. Diversity-reserved slots labeled (`cohort-reservation` / `novelty-reservation`). User accepts from top-K (single-select for Topic/Outline; multi-select for Points). ~16h |
| 1A.c13 | Post-run report UX | `webapp/src/components/optimization/RunReport.tsx` + `RejectReasonHistogram.tsx` | Convergence reason, cost actual vs estimate, reject-reason histogram (e.g., "18× specificity_lt_3, 12× diversity_lt_0_4, 9× disputability_lt_3"). Useful for diagnosing tight gates / weak persona panels. ~6h |
| 1A.c14 | Settings → Optimization page | `webapp/src/pages/SettingsOptimizationPage.tsx` | User-configurable diversity floor (default 0.4 per `OPTIMIZATION_LOOP.md` §4.2), per-Skill default `n_candidates` / `n_iterations` / `budget_usd` / `top_k_returned`. Reset-to-documented-defaults button. ~6h |
| 1A.c15 | PCP-window selector UI in Theme search | `webapp/src/components/optimization/PcpContextSelector.tsx` + Theme-search launch flow | When launching `factory_theme_propose_optimize`, user can optionally enable PCP context, select window (last N days; default null = no PCP), select PCP types from {`calendar`, `linear`, `slack_dm`, `work_this_week`, `github_activity`, `manual_notes`}. `PcpProvenance` (per `EDITORIAL_ROOM_CONTRACT.md` §3.9) shown in resulting ProposalCards with seed-event summaries; `derived_from_pcp` Themes default `scope: personal` until explicit user promotion. ~8h |

### 5.3 Phase 1A acceptance criterion

**Joseph performs this end-to-end and it works:**

1. Open Editorial Room → Setup. Select Longform Post, `gamemakers-2026`, target length, destination, audience personas, LLM agent profiles, and scoring system.
2. Continue to Theme/Topic workspace. See 5–7 hand-seeded themes in the left panel and topics in the center panel.
3. Pick "AI Impact on Game Dev" → see its topic cards and score badges.
4. Click "+ Topic" → manually add "The New Role of the AI PM" with one-line thesis. Or run **"Optimize Topics"** → cost preview shows `~$3.40 ± 30%`, estimated wallclock `~6m`, `n_candidates=20 × n_iterations=3 × 3 personas × 8 SSR samples`. Confirm launch. Mid-run progress bar shows iteration count, current phase, and cost-so-far. Round completes; top-5 candidate display shows per-candidate composite score, per-persona SSR PMF (full distribution + confidence), rubric breakdown with gap quotes, and diversity-reservation labels (3 by composite + 1 cohort-reserved + 1 novelty-reserved). Joseph picks one; accepts. Reject-reason histogram in post-run report shows what didn't make it (e.g., "18× specificity_lt_3, 12× diversity_lt_0_4").
5. Select the topic → land on the Points workspace.
6. Click "Propose points" for fast ideation (single-call cheap mode) **or** "Optimize Points" for the multi-iteration round (top-8 with 2 counter-argument-Points reserved). LLM Discussion / point proposal flow returns candidate points across the selected agents.
7. Select one active point ("PMs become builders") → Notes panel is scoped to it; add Thought / Claim / Evidence / Question / Counterpoint notes.
8. Run "Research this point" or "Improve toward score" on weak points; accept, edit, park, or reject proposals. (Both single-call and optimization-round modes available per `OPTIMIZATION_LOOP.md` §5b.)
9. (Optional Research): for one point that needs sourcing, click "Research" → `factory_claim_research` proposes 3 source URLs + quotes → user approves.
10. Click "Build Outline" → land on Outline Builder. Chat with AI: "let's lead with X, structure body around Y and Z, end with the takeaway about W." Outline materializes alongside. User direct-edits to swap section order.
11. Click "Send to Draft" → Tiptap editor opens with outline + Production Brief context. Layer-1-3 Skills available in Skills rail.
12. Write the draft (or click "Generate first draft" if implemented in 1A — likely deferred to 1A.5).
13. Run "Argument Critic" — get structured critique. Address weakest items.
14. Run "Counter-Audience" with @Ankit-as-Skeptic persona — see predicted bounce points.
15. Run "Claim Coverage" — confirm draft uses the approved points/claims.
16. Click "Send to Polish" → Skills rail mode-shifts to layer-4. Run targeted-axis polish optimization (`factory_draft_polish_optimize`) — system identifies lowest-scoring axis, generates 3 paragraph-scoped fixes, scores each, returns top-3 fixes. Joseph accepts one; round runs again on the next axis. Total polish cost ~$1–$3 per piece. Adversarial Cut and Opus Review remain available as named single-call Skills inside the polish round. (Full-search Draft optimization is opt-in only and not used for posts.)
17. Click "Send to Ship" → export pane opens.
18. Click "Substack-flavored Markdown" → clipboard.
19. Paste into Substack, schedule, publish.

After publishing, the portfolio (themes/topics/points pages) persists. Next piece in the same theme reuses topic + points where applicable; only the new ones need fresh debate.

**If steps 1–19 work end-to-end without manual workarounds, Phase 1A ships.** Time-to-first-piece: 3–5 hours expected.

### 5.4 Phase 1A tests by gate

Before Phase 1A acceptance, these tests must pass in the same gate order as implementation:

**0p — Local proof MVP**
- Contract fixture/schema tests for `SetupState`, `Theme`, `Topic`, `Point`, `PointNote`, `point_note_blocks`, note promotion payloads, `ScoreSnapshot`, `ScoreResult`, `discussion_sessions`, LLM Discussion turns, and proposal cards.
- UI tests for Setup selection, setup context bar, persona/agent library picker states, theme/topic filtering, active point binding, typed note creation, `Add to Notes`, note promotion affordance, and proposal accept/edit/reject/park.
- Score-state tests for `pending`, `unknown`, `stale`, `partial`, and `scored`; cards never guess missing persona/model metadata.
- Boundary-invariant tests: changing Setup increments `setup_version` and marks dependent score snapshots, proposal runs, discussion sessions, and draft brief snapshots stale; `point_note_blocks` remain Piece-local until explicit `propose_update` promotion; `editorial_scoped` discussions never appear in normal Panel Talk lists.
- Debate/proposal kill-criteria tests: fixture LLM Discussion records retained vs rejected outputs, cost, latency, and partial-provider status; one failed/timed-out provider still returns a usable partial result and keeps proposal accept/edit/reject/park available.
- Portfolio-board performance tests: large fixtures with at least 100 topics and 500 points prove theme/topic/point boards use batched reads, fixed query counts, and indexes for `score_snapshots`, `discussion_sessions`, and `point_note_blocks`; no N+1 score, note, or discussion lookups.
- One E2E fixture flow: Setup → Theme → Topic → Points → add notes → run fixture score/proposal action → accept one proposal.

**1A-G1 — Live substrate + scoring proposals + optimization loop**
- Rocketorchestra page-type tests for `theme`, `topic`, `point`, `persona`, `scorer_config`, `scoring_pipeline`, and `optimization_rounds`.
- MCP contract tests: `run_skill` / `get_run` / `run_optimization` / `get_optimization_round` / `cancel_optimization_round` — manifest visibility, dispatch, scope checks, rate-limit categories, capability audit rows, payload caps, duplicate idempotency replay, stale result handling, provider-metadata fallback when cost/model facts are unknown or stale, and no clawrocket draft-write proxy tools.
- Skill contract/eval tests for **propose Skills** (`factory_topic_propose`, `factory_point_propose`, `factory_point_debate`, `factory_claim_research`, `factory_outline_builder`) including cost/latency metrics and partial-provider failure semantics.
- Skill contract/eval tests for **optimize Skills** (`factory_theme_propose_optimize`, `factory_topic_optimize`, `factory_point_optimize`, `factory_outline_optimize`, `factory_draft_polish_optimize`, `factory_draft_fullsearch_optimize`) including hard-gate enforcement, diversity rejection, top-K composition with reserved slots, multi-iteration mutation, convergence detection, budget-cap abort, and cost-so-far reporting.
- SSR API tests per `SYNTHETICALRESEARCH_API_CHANGES.md` §11: methodology validation against bias-paper pilot set (≥ 14/17 exact match) and expanded set (≥ 43/69), cross-vendor smoke test (Anthropic Haiku + OpenAI text-embedding-3-small), two-vendor enforcement (same-vendor rejected by default; `researchMode.allowSameVendor` proceeds with warning), AnchorSet authoring rule rejection (third-person, mean inter-anchor sim > 0.85, question-text-in-anchor), batch performance benchmark (480-call round under 90s).
- Optimization round lifecycle tests: setup_version mid-round behavior (round runs to completion under original; result marked stale per `EDITORIAL_ROOM_CONTRACT.md` §4.7); cancellation policy (in-flight LLM calls allowed to complete; partially-scored candidates excluded from `partial_top_k`); idempotency replay returns existing round.
- PCP-context-seed tests: `factory_theme_propose_optimize` with PCP window correctly filters by `pcp_types`, returns Themes with `derived_from_pcp: true` + populated `PcpProvenance` including `seed_events`. Cross-user RLS: PCP-derived `scope: personal` Themes invisible to other users.
- BYOK lease/audit tests for live Skill calls and for batched-lease primitive (1A.r23) under high-volume optimization rounds.

**1A-G2 — Draft / Polish / Ship**
- Migration tests for Pre-1 schemas (`context_mode`, `talk_kind`, `talk_output_revisions`, `talk_output_suggestions`, `claims_ledger`).
- Migration behavior parity tests, hot-path index/query-plan checks, DB connection budget checks, shared Supabase drift gate, RLS/user-isolation matrix, Supabase Auth cookie/refresh/cache/no-store/CSRF tests, Google OAuth reconnect/export tests, backup/restore, rollback, and canary checks.
- Rocketboard port preflight checks for unsupported imports, package/version deltas, storage/auth assumptions, CSS/UI dependencies, and Supabase/project-view bindings before copying donor code.
- Revision append/revert/proposal idempotency tests; suggestion accept/reject/edit/stale transaction tests with row lock/CAS and anchor revalidation; post-accept remaining-suggestion revalidation tests.
- Markdown snapshot + `MarkdownSourceMap` determinism and coverage tests for paragraphs, headings, lists, links, code, tables, blockquotes, and hard breaks.
- Skill polling/idempotency/stale-result UI tests: backoff, `Retry-After`, abort-on-unmount/navigation, hidden-tab slowdown, recoverable timeout, duplicate replay, and stale revision/hash result handling.
- Skill contract tests for `factory_opus_review`, `factory_adv_cut`, `factory_argument_critic`, `factory_counter_audience`, and `factory_claim_coverage`.
- Mechanical scorer fixture-parity tests against the AutoNovel corpus.
- Destination-fidelity Google Docs/Substack export fixture tests.
- Large-draft performance fixture: 10k words + 100 suggestions, no anchor/scoring work on the hot render path.

---

## 6. Cross-repo coordination for Phase 1A

Phase 1A has work in both repos. The sessions don't communicate directly; coordination is via these gates:

**Gate 0 (Phase 0p prerequisite): the executable cross-repo contract is frozen.**
Both repos consume the same `docs/EDITORIAL_ROOM_CONTRACT.md`, the same versioned JSON Schema package under `docs/contracts/editorial-room/v0/`, and the same shared fixtures for setup, portfolio, notes, scoring, scoped LLM Discussion sessions/proposals, `MarkdownSourceMap`, `Suggestion[]`, `run_skill`, and `get_run`. Until this contract is frozen and fixtures validate against the same schemas in both repos, neither side can ship code that proves cross-repo behavior. Clawrocket can build the local proof loop against fixtures; rocketorchestra can build Skills against the same schemas and fixtures.

**Gate 1 (early): clawrocket ships local Phase 0p against fixtures.**
Until the Setup/portfolio contract passes locally, do not spend implementation budget on live Skills, cloud migration, or Draft/Polish UI. This keeps the new Setup, scoring, agent profile, and point-note contracts honest before persistence hardens around them.

**Gate 2 (mid): rocketorchestra ships Pre-1.r1–r3 plus page/scoring/proposal contracts.**
Until provider metadata, scoped token, `run_skill` / `get_run`, `theme` / `topic` / `point`, scoring pipeline primitives, and proposal Skill contracts land, clawrocket cannot swap fixture proposal actions to live results.

**Gate 3 (late): Draft/Polish/Ship contracts land.**
Rocketorchestra must ship polish and draft-critic Skill contracts before end-to-end Draft/Polish Skill button testing. `voice/gamemakers-2026` must exist before voice-lock integration is complete.

**Pattern:** when one session is blocked on the other, switch sessions. Don't push past a gate with stubs that you'll forget to clean up.

---

## 7. Phase 1A.5 onwards — placeholder

Detailed work breakdowns for Phase 1A.5 and beyond will be added to this doc as Phase 1A nears completion. The high-level phase ladder in §1 is the agreed shape; the detailed per-task TODOs will land closer to when each phase starts to avoid scope drift.

---

## 7.5 Phase 1B-PT — Panel Talk dialectical synthesis + spiral-forward to Editorial Room

**Trigger to start:** Phase 1A is dogfooded and shipped (Joseph publishes a real GameMakers piece end-to-end through the Editorial Room workflow without manual workarounds).

**Goal:** make Panel Talk's value as a knowledge-creation surface explicit through two additions: (1) dialectical synthesis as a first-class operation distinct from summarization, and (2) a forward path that promotes panel insights into Editorial Room as Theme/Topic seeds. See `02_HERO_APPLICATIONS.md` §2.7.5 for the product framing and `EDITORIAL_ROOM_CONTRACT.md` §3.9.2 for the `PanelProvenance` schema.

This is the SECI-spiral-forward direction: panel dialogue produces externalized articulations → those articulations seed Editorial Room Theme/Topic search → resulting Pieces ship → published context flows back into the substrate. The two apps stop being "two tools" and start being "two phases of one knowledge cycle."

### 7.5.1 In `rocketorchestra` (~26h)

| # | Task | Files | Acceptance |
|---|---|---|---|
| 1B-PT.r1 | `factory_panel_dialectic` Skill | `src/rocketorchestra/runtimes/factory_panel_dialectic.py` | Inputs: source_panel_id + source_turn_ids + agent attribution preserved. Output: `DialecticResult` per `02_HERO_APPLICATIONS.md` §2.7.5 schema (thesis + antithesis + disagreement_kind + 0–3 synthesis_candidates + nullable aporia + new_question). Prompt actively resists compromise-style middle-grounding; aporia is a valid (often *better*) output than vague synthesis. Cost ~$0.05–$0.20 per call. Contract test on fixture covering: empirical disagreement → synthesis found, values disagreement → aporia, talking_past → reframe to new_question. ~14h |
| 1B-PT.r2 | Extend Theme/Topic optimize Skills to consume `panel_seed` | `factory_theme_propose_optimize.py`, `factory_topic_optimize.py` | Skills accept optional `SkillContext.panel_seed` (per `EDITORIAL_ROOM_CONTRACT.md` §6.1). When provided, Skill prompt incorporates the synthesis text (or aporia + new_question), uses thesis/antithesis as anti-targets, attaches `PanelProvenance` to resulting page records. `panel_seed.treat_as` field controls weighting (synthesis / thesis / antithesis / open_question). Contract test: panel_seed-driven Theme generation produces Themes with `derived_from_panel: true` + populated `PanelProvenance`. ~8h |
| 1B-PT.r3 | RLS guarantee for panel-derived pages | rocketorchestra access policies | Pages with `derived_from_panel: true` and `scope: personal` invisible to other users in same org. Panel content from `incognito` panels MUST NEVER appear in `PanelProvenance` (capture is suppressed at panel level per existing privacy contract). RLS test matrix: 4 modes × 2 users × 3 page types. ~4h |

### 7.5.2 In `clawrocket` (~22h)

| # | Task | Files | Acceptance |
|---|---|---|---|
| 1B-PT.c1 | `panel_dialectic_results` table + persistence | `webapp/src/db/migrations/cw_*_panel_dialectic_results.sql` + accessor | Per `DialecticResult` schema in `02_HERO_APPLICATIONS.md` §2.7.5. Indexed by `source_panel_id`. Each result is saveable as a Talking Point with `derived_from_dialectic: true` tag. ~6h |
| 1B-PT.c2 | `Find Synthesis` action UX | `webapp/src/components/panel/FindSynthesisAction.tsx` + `DialecticCard.tsx` | Action surfaces in right rail when sustained-disagreement heuristic triggers (≥ 2 agents holding distinguishable positions across ≥ 2 turns) and is also manually invokable on selected exchanges. Cost preview before launch. Result renders as `DialecticCard` with four collapsed-by-default sections (Thesis, Antithesis, Synthesis Candidates, New Question). Aporia rendered as its own labeled state when `synthesis_candidates` is empty. Distinct icon and copy from existing `Synthesize` action. ~10h |
| 1B-PT.c3 | `Promote to Editorial` action | `webapp/src/components/panel/PromoteToEditorialAction.tsx` | Available on Talking Points and DialecticResults. Click opens Editorial Room's Theme or Topic search with `SkillContext.panel_seed` pre-populated (panel_id + relevant turn_ids/talking_point_ids/dialectic_result_ids), originating panel linked as provenance, default `scope: personal` for resulting Theme/Topic. User selects Theme-search or Topic-search target; the search UI shows the seed events for review before launch. ~6h |

### 7.5.3 Phase 1B-PT acceptance criterion

**Joseph performs this end-to-end and it works:**

1. Open a Panel Talk session. Pick a topic where he expects models to disagree (e.g., "Should indie studios train internal small models instead of using frontier APIs?").
2. Run 3–5 turns. Two agents land on different positions; the disagreement persists across turns.
3. Right rail surfaces `Find Synthesis` action automatically. Click it.
4. `DialecticCard` renders: thesis (steelmanned), antithesis (steelmanned), disagreement_kind, 1–3 synthesis_candidates with practical implications, the new_question. Or, if no honest synthesis exists, aporia with `what_would_resolve`.
5. Joseph saves the dialectic result as a Talking Point.
6. Click `Promote to Editorial` → Editorial Room Theme search opens with the synthesis pre-loaded. Joseph reviews the seed events.
7. Run `factory_theme_propose_optimize` with the panel seed. Top-5 candidate Themes returned, each carrying `PanelProvenance` linking back to the panel.
8. Joseph picks one and adopts it. Theme starts at `scope: personal`; he promotes to `global` for the publication.

If 1–8 work without manual workarounds, Phase 1B-PT ships.

### 7.5.4 Phase 1B-PT tests

- `factory_panel_dialectic` contract/eval tests: empirical disagreement → synthesis found; values disagreement → aporia (with `what_would_resolve` line populated); talking_past → reframe to new_question; partial-provider failure does not corrupt structured output.
- Anti-failure-mode tests: Skill output rejected if `synthesis_candidates[i].framing` is just a midpoint of thesis/antithesis (specific anti-pattern check); Skill output rejected if either thesis or antithesis is strawmanned (sentiment match against original turn content).
- `panel_seed`-driven Theme/Topic optimize contract tests: resulting pages carry `PanelProvenance` with full `source_panel_id` + `source_turn_ids` + `seed_summary`; cross-user RLS verified.
- Panel-derived page promotion test: `scope: personal` → `scope: global` requires explicit user action; provenance preserved across promotion.
- Incognito-panel privacy test: `factory_panel_dialectic` rejects panels in `incognito` context_mode; if invoked anyway, no `PanelProvenance` is written.

---

## 8. How to start

Read `06_PHASE_1A_KICKOFF.md`. It contains paste-ready prompts for both Claude Code sessions. Pick the section matching the repo you're in, paste it, start working.

When Phase 1A is dogfooded and shipped, ping me and I'll add Phase 1A.5 detail to this doc + create `07_PHASE_1A.5_KICKOFF.md`.

---

*End of build plan v1.*

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 3 | ISSUES_FOUND | Outside voice found structural risks; accepted changes added the hard Phase 0p gate, executable JSON Schema contracts, source-map feasibility spike, debate/proposal kill criteria, and provider metadata maintenance path |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 4 | CLEAN | Latest pass: 12 issues reviewed, scope reduced, 0 unresolved decisions, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 3 | CLEAN | Latest score: 6.5/10 -> 9.0/10, 14 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** Outside voice ran through Codex and found plan-level issues; accepted recommendations were folded into this build plan and `06_PHASE_1A_KICKOFF.md`.
- **CROSS-MODEL:** Both reviews converged on the same core risks: local proof loop before cloud spend, executable cross-repo contracts, source-map anchoring feasibility, explicit Skill idempotency, RLS/auth specificity, provider metadata truthfulness, and LLM Discussion value gates.
- **UNRESOLVED:** 0
- **VERDICT:** ENG + DESIGN CLEARED — implement Phase 0p only. Cloud migration and live rocketorchestra work remain blocked until `docs/PHASE_0P_STOP_GO.md` says GO.
