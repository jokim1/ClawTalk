# Architecture & Substrate Specification

**Document type:** Engineering handoff — substrate / capability layer
**Last updated:** 2026-04-30
**Companion docs:**
- `02_HERO_APPLICATIONS.md` — the user-facing apps that consume this substrate
- `EDITORIAL_ROOM_CONTRACT.md` — cross-repo schema and RPC contract
- `OPTIMIZATION_LOOP.md` — agentic optimization loop the substrate enables
- `SCHEMA_DEFINITION.md` — persona schema referenced from §2.1.B
- `THEME_TOPIC_POINTS_DEFINITION.md` — definitions of editorial layers referenced from §2.1.B
- `SYNTHETICALRESEARCH_API_CHANGES.md` — SSR API spec referenced from §15

**Reader:** an engineer (or Claude Code session) who will implement against this spec.

> **Note on document state.** Planning-phase reference doc. The system is greenfield — substrate primitives, page types, scoring pipelines, and runtime contracts can change freely until first production deployment. This doc has gone through many internal iterations to converge on the substrate shape; what's preserved here is the current consensus, not a sequence of versions to migrate between.

---

## 0. Purpose

This document specifies the **shared substrate** that every hero application sits on top of. It does not describe any user-facing screens. Read it as: *"What capabilities are available to apps, what contracts do they obey, and what's already shipped vs. what's net-new work."*

The substrate is composed of **two runtime repos** plus one **donor codebase** we mine for patterns:

- **clawrocket** *(runtime, repo #1)* — TypeScript web/API surface (multi-agent runtime + persistence + streaming). Deployed.
- **rocketorchestra** *(runtime, repo #2)* — Python GCP backbone (context + credentials + scheduled jobs + MCP). Deployed.
- **autonovel** *(donor, not a runtime)* — read-only pattern library. We port specific files (`run_pipeline.py` state machine, `evaluate.py` scorer, `review.py` dual-persona Opus loop, `adversarial_edit.py` cut-and-classify, `reader_panel.py` 4-persona rubric, `gen_audiobook_*.py`) into rocketorchestra `factory_*` runtimes. Treat it like a reference manual we copy from once and never re-sync.
- **rocketboard** *(donor, not a runtime)* — read-only source for the Tiptap editor foundation, the agent profile model (donor `ai_personas` table + `PersonaSwitcher` + BYOK Anthropic OAuth flow + 3-provider streaming chat repository), the document persistence schema as a template, the undo/redo hook, and the kanban view. We port specific modules (see §14) into clawrocket. We don't add rocketboard as a dependency, fork it, or track its main branch. In this project, "persona" is reserved for rocketorchestra audience/persona pages; clawrocket model slots are "agent profiles."
- (autoresearch is excluded entirely — it's an LLM-pretraining harness, not a content tool. rocketboard-legacy is also excluded — the active rocketboard supersedes it.)

**Net runtime surface: 2 repos, 2 deployments, 1 contract between them. Two donor codebases (autonovel, rocketboard) port-once into the runtime repos.**

Hero apps live on top of this substrate. Apps SHALL NOT replicate substrate capabilities. If an app needs a capability the substrate doesn't have, the substrate gets extended, not the app.

---

## 1. Layer model

```
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 5 — HERO APPLICATIONS                                        │
│  Panel Talk · Editorial Workspace · (future apps)                   │
│  See 02_HERO_APPLICATIONS.md                                        │
└─────────────────────────────────────────────────────────────────────┘
                                │ HTTP + SSE
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 4 — APPLICATION SHELL (clawrocket web + API)                 │
│  • Hono API (routes per app)                                        │
│  • React webapp (per-app pages)                                     │
│  • Supabase Postgres (apps' working state, shared project)          │
└─────────────────────────────────────────────────────────────────────┘
                                │ MCP + REST + Bearer
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 3 — DOMAIN PRIMITIVES (substrate-shipped, app-shared)        │
│  Talks · Drafts · Suggestions · Sources · Skills · Briefs · Panels  │
└─────────────────────────────────────────────────────────────────────┘
                                │
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 2 — SUBSTRATE SERVICES (rocketorchestra, GCP)                │
│  Context · Credentials · Scheduler · Job Runner · Inbox · Triggers  │
└─────────────────────────────────────────────────────────────────────┘
                                │ KMS-vaulted keys
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 1 — PROVIDERS (BYOK)                                         │
│  Anthropic · OpenAI · Google · DeepSeek · ElevenLabs · fal.ai       │
└─────────────────────────────────────────────────────────────────────┘
```

**Rules:**
1. Apps (L5) talk to substrate services (L2) only via the application shell (L4) and the documented MCP tool catalog (§9).
2. Provider keys (L1) NEVER leave L2. L4/L5 fetch a per-call lease via `/api/distribute/fetch`.
3. Domain primitives (L3) are the contract. Add new primitives by extending the substrate, not by inventing app-local types.
4. The substrate is single-user for v1. Multi-tenant is explicit non-goal until the substrate hits feature stability.
5. Editorial workflow state is app-owned. clawrocket owns `EditorialPiece.setup_state`, `setup_version`, `score_snapshots`, scoped `discussion_sessions`, and `point_note_blocks`; rocketorchestra owns reusable context pages referenced by that state (`voice`, `persona`, `scoring_pipeline`, `theme`, `topic`, `point`) plus scorer definitions and Skill execution. Do not create a parallel rocketorchestra `piece` page for transient workflow state.

---

## 2. The Context Layer

**What it is:** a typed, indexed, MCP-readable knowledge graph of everything that grounds generation — *both* the user's general personal context (who they are, what they're working on, what they've decided) *and* the domain-specific context for whichever apps they're using. Lives in rocketorchestra Postgres. Already shipped; Content Factory adds new page types alongside the existing ones, doesn't replace them.

**The framing that matters:** rocketorchestra's purpose, per `aicontrolplane-strategy.md`, is to eliminate the cold-start tax across all AI agent platforms. Every Panel Talk debate and every Editorial Room piece starts grounded in the user's accumulated knowledge — not from a blank prompt. And every meaningful insight that surfaces in those apps can flow *back* into context as a durable update, so the system gets smarter as the user works in it.

### 2.1 Page-type ontology

A `page` is a typed, slug-addressable document with `compiled_truth` (structured JSON that renders to markdown) plus an immutable `timeline` (append-only evidence log). The substrate ships page types in three families:

#### 2.1.A Personal context (general — used by every app)

The 11 page types from `rocketorchestra/docs/PERSONALCONTEXT-PRD.md` v3.5. These are not editorial-specific — they describe the user's life, work, and accumulated knowledge. Every app that grounds in context can read them.

| Page type | Purpose | Author |
| --- | --- | --- |
| `identity` | Who the user is — anchor facts, role, primary affiliations. One per user. | Manual seed; rarely changes |
| `project` | Active projects the user is involved with (e.g., LILA BLACK, Heart's Desire, Fotogenic, GameMakers). Status, stakeholders, current state. | Manual + agent-proposed from conversations |
| `company` | Companies the user works with, owns, or writes about (Lila Games, GameMakers Inc., peer studios, customer companies). | Manual + agent-proposed |
| `person` | Real people the user works with or thinks about. **Distinct from ****`persona`**** — ****`person`**** is a real human, ****`persona`**** is a constructed audience target.** A `persona` may reference a `person` page when modeled on a real one. | Manual + agent-proposed |
| `decision` | Decisions made, with rationale, alternatives considered, who was involved, when. The durable record of "we already settled X." | Manual + agent-proposed (especially from Panel Talk convergence outlines) |
| `preference` | How the user works — communication style, tools they prefer, patterns to avoid (e.g., "Joseph prefers fastest clean path on legal disputes"). Lets agents act in the user's voice without re-asking. | Manual + agent-proposed |
| `domain` | Subject-matter knowledge the user owns: game economics, indie UA, AI in games, monetization design. Curated; the user's earned takes. | Manual + agent-proposed (especially from accepted `claims_ledger` entries) |
| `goal` | Personal/professional goals with status and milestones. | Manual; rare agent updates |
| `tool` | Tools and stacks the user uses (clawrocket, rocketorchestra, Claude Code, ElevenLabs). Helps agents know what's at hand. | Manual |
| `relationship` | Edges between persons (works-with, mentor-of, reports-to). | Manual + agent-proposed |
| `event` | Notable past events that explain present state — a launch, a funding round, a key conversation, a layoff at a studio Joseph is writing about. | Manual + agent-proposed |

#### 2.1.B Content Factory domain — used by Editorial Room

Domain-specific pages for the Editorial workflow. These compose with personal context (e.g., `voice` is shaped by `identity` and `preference`; `back_catalog` cross-references `domain` pages for accumulated takes).

| Page type | Purpose | Author |
| --- | --- | --- |
| `voice` | Tone, vocabulary do/don't, hedge patterns, signature moves. *How* GameMakers writes. | Joseph (manual seed) + `voice_drift_check` agent (proposes diffs) |
| `theme` | **Layer 1** — broad, durable subject area Joseph writes about over time. Examples: "AI Impact on Game Dev," "The Rise of Chinese Game Dev," "UGC Gaming Industry," "Battlepass Game Design," "Misc" (default catch-all for orphan topics). Each theme has child topics. Initial implementation ships with 5–7 hand-seeded themes; agentic `factory_theme_propose_optimize` (per `OPTIMIZATION_LOOP.md` §6.1) generates candidates the user picks from. **See ****`THEME_TOPIC_POINTS_DEFINITION.md`**** §3 for the binding definition, five-test rubric, and scorable axes used by the optimization loop.** | Manual seed; agent-suggested via `factory_theme_propose_optimize` (with optional PCP context seeding) |
| `topic` | **Layer 2** — specific angle within a theme. Examples (under "AI Impact on Game Dev"): "The New Role of the AI PM," "How Game Studios Need to Change in the Age of AI," "The Mass Unemployment coming to the Gaming Industry." Has `parent_theme_slug` (defaults to `theme/misc` if user doesn't pick one), one-line thesis, child points, novelty score against `back_catalog`, status (`active` / `parked` / `used`). **See ****`THEME_TOPIC_POINTS_DEFINITION.md`**** §4 for the binding definition, five-test rubric, and scorable axes.** | Manual + `factory_topic_optimize` (per `OPTIMIZATION_LOOP.md` §6.2) |
| `point` | **Layer 3** — specific claim/argument within a topic. Examples (under "The New Role of the AI PM"): "PMs become builders — they need technical depth," "Artifacts shift PRDs → Prototypes," "PMs become orchestrators." Has `parent_topic_slug` (single parent), claim (one-line), rationale (free text), evidence (claims_ledger refs / source URLs), status (`active` / `parked` / `merged` / `rejected`), conviction (`low` / `medium` / `high` — user's own confidence). The unit of multi-LLM panel debate. **See ****`THEME_TOPIC_POINTS_DEFINITION.md`**** §5 for the binding definition, five-test rubric, and scorable axes.** | Manual + `factory_point_optimize` + `factory_point_debate` (multi-LLM disagreement-finder) |
| `audience` | Reader segments: indie devs, AAA producers, biz/exec, students, students-going-into-gamedev. | Manual |
| `back_catalog` | One row per published piece — title, URL, date, themes, hook, payoff, lessons. | `back_catalog_indexer` (RSS poll) |
| `industry_signal` | Ingested events worth reacting to (layoffs, releases, trends). 14-day TTL hint. | `industry_pulse` agent |
| `reader_signal` | Reader emails / comments worth responding to. | `gmail_reader_inbox` trigger |
| `episode_bible` | Long-running show metadata: host persona, recurring guests, segment structure. | Manual |
| `claims_ledger` | **Core infrastructure, not just a Stage 2 UI.** Per-piece structured ledger of every claim, with provenance. Each entry is `{ kind, statement, source_url, source_doc_ref, quote, timestamp, confidence, approval_status, evidence_log, last_verified_at }` where `kind ∈ { sourced_fact \ | model_inference \ | counterargument \ | open_question \ | unsupported_claim \ | quote }`. The user cannot reach Stage 3 (Draft) without seeing the ledger. Approval status gates which entries flow into draft generation as factual context. | Auto-populated by `factory_research_brief`; user-approved per entry |
| `interview_transcript` | **NEW.** Riverside / podcast recording transcripts with speaker labels and timecodes. | Manual upload + auto-extract |

#### 2.1.C Cross-app infrastructure types — used by every app

These pages parameterize the substrate's pluggable layers. Apps reference them; users edit them.

| Page type | Purpose | Author |
| --- | --- | --- |
| `persona` | **Substrate primitive used by all apps.** A named, *constructed* audience definition with detailed_profile (the binding free-text blob the LLM sees in SSR scoring), structured demographic/behavioral context, cared_about_criteria, triggers_to_close, voice_of_customer_quotes (used as anchor seeds), unmet_needs, counter_audience_prompt, sampling weight + cohort tags. Referenced as: an audience target in Editorial Room, a panelist in Panel Talk, a scoring rubric in any scorer. **Distinct from ****`person`** (real human) — a `persona` may reference a `person` when modeled on a real one. **One persona definition, many uses.** **See ****`SCHEMA_DEFINITION.md`**** for the binding schema (canonical fields, validation rules, paper-derived design constraints), worked example, and how each scorer type consumes which fields.** | Manual + agent-proposed via inbox |
| `scorer_config` | One configured instance of a Scorer (built-in or external), with parameters (threshold, model choice, banned-word list, etc.). See §15. | Manual + agent-proposed |
| `scoring_pipeline` | A named sequence of `scorer_config` refs with role assignments (gate / score / diagnostic) and an aggregation rule. The default GameMakers pipeline runs AutoNovel Mechanical → AutoNovel Judge → optional SSR. See §15. | Manual; ships with sensible defaults |
| `anchor_bundle` | Versioned, immutable bundle of Likert anchor variants used by SSR-style scorers. Each bundle is keyed by `(domain, likert_family, persona_cohort_tags)` and contains 1–N independently-worded anchor variants whose PMFs are averaged for stability (per Maier et al. 2025). e.g., 5 variants of "1: I'd close this immediately. … 5: I'd share this and quote it this week." See `SYNTHETICALRESEARCH_API_CHANGES.md` §4 for the full schema. **Renamed from `reference_set`.** | Manual; ships with editorial defaults |
| `iteration_config` | Parameters for the iteration loop runtime (max_attempts, acceptance_criterion, plateau_check, on_failure). Defaults mirror autonovel's working numbers. Editable per-piece or per-channel. See §15. | Manual; ships with sensible defaults |
| `external_export_target` | Configuration for an outbound export adapter — e.g., "Markdown dump to ~/Documents/context-mirror," "Google Drive folder X," "Obsidian vault Y," "future gbrain MCP." See §16. | Manual |

### 2.2 The MCP read interface

Apps query the context layer through the rocketorchestra MCP server (`/mcp`, JSON-RPC). The tools shipped today:

| Tool | Status | Use |
| --- | --- | --- |
| `get_manifest` | shipped | Bootstrap: tells the agent what scopes/tools/page types exist. |
| `list_pages` | shipped | Scope-filtered enumeration (e.g., all `themes` pages). |
| `get_page` | shipped | Fetch by slug, RLS-checked. |
| `query_context` | shipped | Postgres FTS over `content_chunks`. Vector fusion deferred. |
| `gmail_read_message` | shipped | Walk Gmail history from a webhook trigger context. |
| `propose_update` | shipped | Queue a diff in `pending_writes` (the inbox flow). |

**New tools required by the Content Factory:**

| Tool | Purpose | Owner repo |
| --- | --- | --- |
| `list_drafts(channel?, status?)` | Enumerate `talk_outputs` filtered by channel / status. | clawrocket-side MCP route |
| `get_draft(id)` | Return a draft + current revision content. | clawrocket-side |
| `propose_revision(draft_id, content_json, content_md_snapshot, markdown_source_map, source_skill, idempotency_key)` | Append a new revision atomically (idempotent on key/hash). This is clawrocket-only and is never proxied through rocketorchestra. | clawrocket-side |
| `run_skill(skill, inputs)` | Fire-and-forget enqueue of a `factory_*` runtime; draft Skill inputs include Markdown snapshot + `MarkdownSourceMap`; returns `run_id`. | rocketorchestra |
| `get_run(run_id)` | Stream-friendly run status (delegates to `runs` + `run_events`). Draft Skill runs return source-map-anchored suggestions; clawrocket persists them. | rocketorchestra |
| `record_panel(talk_id, prompt, responses)` | Persist a Panel turn for later reference. | clawrocket-side |

**Why "clawrocket-side MCP" exists:** drafts live in clawrocket's tables in the shared Supabase Postgres project (per the strategy decision — the system that owns the lifecycle owns the storage). Tables are scoped by clawrocket's schema/prefix; identity is unified via the shared `auth.users` table (see §3.1). For external agents (Claude Code, future Cowork integrations) to query drafts, clawrocket must expose its own MCP endpoint. This is a small router around existing accessors, not a new service.

**Score snapshot boundary:** rocketorchestra owns `scorer_config`, `scoring_pipeline`, scorer implementations, and `factory_score` execution. clawrocket owns the score results shown inside a Piece. Store them as `score_snapshots` keyed by `piece_id`, `setup_version`, object ref, object content hash, scoring pipeline ref, selected persona refs, and score-run id. A Setup change or object content-hash change marks dependent snapshots stale; rocketorchestra pages never store Piece-specific scores as canonical page fields.

**Editorial discussion boundary:** the right-side LLM Discussion in Editorial Room is not a normal Panel Talk session. clawrocket stores it as `discussion_sessions` keyed by `piece_id`, phase, object ref, object content hash, and `setup_version`, with `talk_kind='editorial_scoped'`. It can reuse Talk/run fan-out, response grouping, and streaming, but it is excluded from normal Panel Talk lists, panel indexes, and cross-panel references unless the user explicitly promotes or exports it. In Phase 0p, LLM Discussion is provisional: every run records retained/rejected outcomes, cost, latency, and partial-provider status. If dogfooding does not retain its output as notes or point improvements within budget, the app collapses it into narrower proposal buttons.

**Point notes boundary:** working notes are clawrocket-owned `point_note_blocks`, keyed by `piece_id`, `point_ref`, and `setup_version`, with lightweight type metadata (`thought`, `claim`, `evidence`, `question`, `counterpoint`). They are fast Piece-local drafting inputs. Durable promotion to a rocketorchestra `point` page or `claims_ledger` entry happens only through the existing `propose_update` approval flow when the user chooses.

### 2.3 The inbox / propose_update flow

This is the substrate's protocol for "agent suggests a change to a page; human approves." Already shipped in rocketorchestra. Apps use it for any agent-driven update to a `voice`, `themes`, `episode_bible`, `claims_ledger`, etc.

**Contract:**
1. Agent calls `propose_update(page_slug, diff)` → row written to `pending_writes`.
2. App surfaces pending writes in an inbox UI.
3. Human approves or rejects.
4. On approve: a single transaction merges the diff into `pages.compiled_truth`, recomputes `content_hash`, marks proposal decided, re-indexes via `ChunkingService`. Loop-prevention via `pages.last_write_origin = 'agent-approval'`.

Apps SHALL use this flow for any context-layer write. Direct mutation of `pages` from app code is forbidden.

### 2.4 Bidirectional context flow — apps both consume and produce

The substrate's whole point is that context flows in *both* directions:

**Apps → Context (capture).** Every app exposes a "Save to Context" affordance on relevant artifacts. The action calls `propose_update` with a structured diff against a target page (or proposes a new page). The user reviews via the inbox and approves. Explicit examples:

- **Panel Talk:** "Save to Context" on any user contribution, model column, synthesis, or convergence outline. Auto-suggests a target page by similarity (e.g., a Panel about your son routes to the relevant `person` page; a Panel about a code architecture decision routes to a new `decision` page). User can override the target or create a new page.
- **Editorial Room:** at Stage 4 Approve, accepted `claims_ledger` entries can promote to durable `domain` pages so the user's accumulated takes on a topic flow into context. `back_catalog` entries (one per published piece) already populate via the existing pipeline.
- **Both apps in ****`Incognito`**** mode:** capture is suppressed. The user explicitly opted into a no-record session; the substrate respects that. An Incognito panel never proposes context updates.

**Context → Apps (grounding).** Every app that runs in `Persistent` or `Editorial` context mode can load relevant pages as system context for its LLM calls. The substrate handles relevance ranking (FTS over `content_chunks`, with vector fusion when configured); apps just declare which page types they want grounded. Persistent panels can attach context pages explicitly (chip selector at panel creation or on demand); Editorial panels auto-ground in the active piece's editorial pages.

**Why this matters:** without capture, every Panel and every Piece starts cold relative to *itself a week ago* — the user re-explains. With capture (and human approval gating), the system's understanding of the user accumulates across conversations. This is the cold-start-tax-elimination story `aicontrolplane-strategy.md` is built around. The Content Factory is one of the first apps to actually fund that loop.

**Privacy posture:** capture is opt-in per page type and per app. Sensitive page types (`person` entries about family, `event` entries marked private) can be flagged "no auto-propose" so agents can read but not propose updates. The user always has the inbox veto.

---

## 2.5 Deployment topology — both repos cloud-hosted, shared Supabase

Both runtime repos deploy identically: **Cloud Run + Supabase Postgres + GCP KMS.** No local-only path; no Ubuntu host SPOF; no SQLite. The earlier strategy of running clawrocket on `systemd --user` was a v0 holdover that's been resolved in favor of consistent cloud deployment.

```
                      ┌─────────────────────┐
                      │  Cloud Run          │
                      │  (us-central1)      │
                      │  ┌───────────────┐  │
                      │  │  clawrocket   │  │  TypeScript / Hono / React
                      │  │  service      │  │  postgres.js / Supabase Auth
                      │  └───────────────┘  │
                      │  ┌───────────────┐  │
                      │  │ rocketorch.   │  │  Python / FastAPI / asyncpg
                      │  │ service       │  │  Supabase Auth + KMS vault
                      │  └───────────────┘  │
                      │  ┌───────────────┐  │
                      │  │ rocketorch.   │  │
                      │  │ goal-runner   │  │  Cloud Run Jobs (factory_*)
                      │  └───────────────┘  │
                      └──────────┬──────────┘
                                 │
                ┌────────────────▼─────────────────┐
                │  Supabase Postgres               │
                │  (one project, shared)           │
                │                                  │
                │  auth.users  ← shared identity   │
                │  rocketorchestra.* tables        │
                │  clawrocket.* tables             │
                │  pgvector + pg_cron + RLS        │
                └──────────────────────────────────┘
                                 │
                                 │  KMS-vaulted secrets
                ┌────────────────▼─────────────────┐
                │  GCP KMS                         │
                │  (rocketorchestra-kms keyring)   │
                └──────────────────────────────────┘
```

**Why one shared Supabase project, not two:**
- **Unified identity:** `auth.users` is the single source of truth for who a user is. Both apps consume it. No identity sync, no agent-token-as-identity-bridge between the two repos.
- **Cross-repo joins are possible** when needed (e.g., a clawrocket draft references a rocketorchestra `back_catalog` page by user_id; both rows live in the same DB).
- **One Supabase plan, one billing surface, one operational story.**
- **One auth flow:** sign in once, both apps recognize the user.

**Schema isolation between repos:** the two repos own different table prefixes/namespaces. Migrations from each repo only touch its own tables (clawrocket can't ALTER rocketorchestra's tables and vice versa). Migration discipline is enforced by repo-scoped migration paths (e.g., `clawrocket/supabase/migrations/cw_*.sql` vs. `rocketorchestra/supabase/migrations/ro_*.sql`).

**RLS posture:** RLS is enabled on every multi-tenant table in both repos. Supabase `service_role` is a global RLS bypass, not an app-scoped user role. Normal request handlers must use user JWT/authenticated-role semantics where possible; if an internal service connection is unavoidable, every query must carry an explicit user-id guard and tests must prove user A cannot read or mutate user B's rows. Service-role/admin credentials are reserved for migrations, drift checks, and named internal jobs.

**What this means for Phase Pre-1:** clawrocket's existing SQLite schema gets translated to Postgres migrations. A 2026-04-29 repo survey counted 116 `CREATE TABLE` statements in `src/clawrocket/db/init.ts`, so this is a real migration, not a small dialect swap. `better-sqlite3` is replaced with `postgres.js` (or `kysely`); sync DB accessors become async. clawrocket's local cookie sessions are replaced with Supabase Auth (JWT in HttpOnly cookie, refresh-on-expired pattern that rocketorchestra already implements). Existing clawrocket SQLite data is **not** migrated — Joseph's call is to nuke it (the existing development data isn't load-bearing). Existing behavior, Google OAuth ownership, and Google Docs/Picker flows are load-bearing and must survive or force a clear reconnect state.

---

## 3. The Credential & Provider Layer

**What it is:** every provider API key lives in rocketorchestra's KMS-envelope vault. Apps fetch a per-call lease through `/api/distribute/fetch`. **Keys never persist outside the credential substrate.** Direct leases may enter app process memory transiently for the duration of a single call, but are never written to disk, logs, telemetry, or any other persistent surface.

### 3.0 Business model — BYOK as first-class

The product's gross-margin design assumes **users bring their own provider keys** for model usage and subscribe to the app for everything else: workflow primitives, multi-agent orchestration, scoring, scheduled jobs, context layer, exports, and UX. This avoids the company carrying unpredictable LLM-spend risk and matches power-user expectations — people who care about multi-model workflows usually already have preferred provider accounts.

Implications baked into the substrate:
- The credential vault is purpose-built for BYOK (already shipped).
- Provider routing, fallback steps, and metadata work with user-supplied keys.
- Per-provider budget estimates and usage accounting accumulate in `runs.cost_usd` and per-runtime `daily_budget_usd` caps.
- Platform-managed model bundles (where the app supplies model usage) are *possible later* (proxy mode), but are **not** assumed in the v1 architecture.

This is a product-level decision, not just an implementation detail. It shapes which substrate features are necessary (BYOK vault, lease endpoint, transparent cost surface) vs. nice-to-have (proxy mode, quota enforcement).

### 3.1 Encryption model

Per-user 32-byte DEK (data encryption key) wrapped by GCP KMS KEK. AES-256-GCM with random 12-byte nonce per ciphertext. `key_version` field on every encrypted payload for rotation. Stored in `ai_api_keys.encrypted_payload` JSONB.

The vault is implemented in `rocketorchestra/src/rocketorchestra/{crypto/envelope.py,crypto/gcp.py,credentials/vault.py}`. Test path uses `FakeKMS`; production path uses the real GCP KMS client.

### 3.2 The distribute_fetch protocol

Any app or agent that needs to call a provider on the user's behalf fetches a lease:

```
POST /api/distribute/fetch
Authorization: Bearer <install_token>
Body: { provider: "anthropic", scope: "messages:create" }
→ 200 { key: "sk-ant-...", expires_at: ..., audit_id: ... }
```

The key is short-lived in app memory; apps SHALL not persist it. Every fetch is audit-logged with the install-token identity and the calling context.

### 3.3 Provider routing & fallbacks

Apps SHOULD declare a *provider route* (sequence of provider+model fallbacks) per skill or per Talk agent slot. clawrocket already supports this via `agent_fallback_steps` table. The substrate's responsibility: surface rate-limit headers (already wired for Anthropic via `anthropic-ratelimit.ts` lookalike) and let routing fall through automatically on 429s.

### 3.4 Cost ceiling

Each `runtime` has a `daily_budget_usd` (extension to existing `runtimes` table). Cloud Run Jobs check budget pre-flight; warn at 80%, halt at 100%. Per-Skill cost reporting flows back to `runs.cost_usd` (already exists).

---

## 4. The Skill / Pipeline Layer

**What it is:** named, parameterized generation pipelines, each backed by a `runtime` row in rocketorchestra of kind `factory_*`. Invokable on-demand from apps (`run_skill` MCP tool) or from cron (`agent_schedules`).

### 4.1 Skill catalog (v1)

Each row is a Cloud Run Job that reads typed inputs, calls providers using KMS-vaulted keys, and writes typed outputs. All Skills share the same shape so they're swappable and testable in isolation.

| Skill | Source pattern | Inputs | Outputs | Estimated cost/run |
| --- | --- | --- | --- | --- |
| `factory_theme_propose` | new — back-catalog scan + voice match | `back_catalog` (last 12 months) + `voice` | proposed `theme` page entries: name, description, evidence-from-back-catalog. User accepts/edits/rejects. **Phase 1A.5+** (manual seed in 1A) | ~$0.30 |
| `factory_topic_propose` | new | parent `theme` + `industry_signal` (last 14 days) + `back_catalog` (last 90 days for theme) | candidate `topic` entries: thesis, why-now, novelty-against-back-catalog | ~$0.20 |
| `factory_point_propose` | new — multi-LLM | parent `topic` thesis + `voice` | 4-8 candidate `point` entries from N agents (different models propose different points). User curates. | ~$0.30 |
| `factory_point_debate` | new — multi-LLM panel | one `point` (claim + rationale) + parent topic + voice + audience personas | structured debate: each agent's position on the point (agree / disagree / refine), strongest counter-evidence, what would change a Skeptic's mind, plus cost/latency/provider-status metadata. The panel only graduates past 0p if dogfooding retains its output as notes or point improvements. | ~$0.40 per point |
| `factory_claim_research` | new | one `point` (claim) | proposed evidence: source URLs, quote candidates, supporting/contradicting back_catalog refs. Output flows into `claims_ledger` as proposed entries. | ~$0.30 |
| `factory_outline_builder` | new — chat-driven | thesis + locked points + voice + deliverable shape | structured outline (sections, hook options, point-to-section mapping, payoff). Built via chat-with-AI side panel materializing the structured outline artifact. | ~$0.20 |
| `factory_argument_critic` | new — layer-3 critic | thesis + draft + claims_ledger | structured critique: weakest claim, missing premise, unsupported leap, alternative thesis | ~$0.20 |
| `factory_counter_audience` | new — layer-3 critic | thesis + draft + persona ref (most-skeptical persona) | what would Ankit-as-Skeptic say? where would they bounce? what evidence would change their mind? | ~$0.25 |
| `factory_claim_coverage` | new — layer-3 audit | draft + claims_ledger | which approved claims appear in the draft, which don't, which contradict the ledger, which are stated without claim backing | ~$0.15 |
| `factory_idea_generator` | `seed.py`-like | `voice` + `theme`/`topic`/`back_catalog` (30d) + `industry_signal` (7d) + `reader_signal` (14d) | 5 candidate angles → proposed `topic` entries (post-v11 the output flows into the topic layer, not a single `themes` page) | ~$0.40 |
| `factory_research_brief` | new (no autonovel analog) | one selected angle | research summary + `claims_ledger` page (sourced facts / inferences / open questions / counterarguments / sources) | ~$0.30 |
| `factory_outline` | `gen_outline.py` retargeted | research brief + `voice` | per-format outline (newsletter / podcast / YouTube) with section-level claims and hook options | ~$0.20 |
| `factory_draft` | `draft_chapter.py` | outline + `voice` + `back_catalog` (anchors) | new `talk_outputs` row with v1 content (`source_skill = 'draft'`) | ~$0.10 |
| `factory_adv_cut` | `adversarial_edit.py` + `apply_cuts.py` | current draft revision Markdown + `MarkdownSourceMap`; target word delta (default −15%) | Source-map-anchored `Suggestion[]` rendered inline as accept/reject popovers | ~$0.05 |
| `factory_reader_panel` | `reader_panel.py` | current draft + `audience` | one-page report scoring voice / hook / payoff / credibility, four personas | ~$0.20 |
| `factory_opus_review` | `review.py` | current draft revision Markdown + `MarkdownSourceMap` | structured source-map-anchored `Suggestion[]` (range + rationale + replacement); loops until stars ≥ 4.5 with no qualified hedges | ~$0.15 |
| `factory_voice_drift_check` | `evaluate.py` | last 4 published `back_catalog` pieces + `voice` | `voice_drift_report` page with severity dot | ~$0.10 |
| `factory_podcast_script` | `gen_audiobook_script.py` | finished newsletter draft + `episode_bible` | speaker-attributed JSON in storage; markdown preview | ~$0.05 |
| `factory_audio` | `gen_audiobook.py` | podcast script + voice mapping | MP3 in Cloud Storage | ~$3.00 (ElevenLabs) |
| `factory_thumbnail` | `gen_art_directions.py` + `gen_art.py` | title + one-sentence hook | 4 thumbnail concepts (fal.ai) | ~$0.40 |
| `factory_pipeline` | `run_pipeline.py` | a DAG spec referencing other Skills | composed multi-stage runs, resumable from `run_events` | sum of children |
| `factory_score` | new — eval-agnostic dispatcher | (asset, scoring_pipeline_ref, target_personas[], anchor_bundle_ref) | structured `ScoreResult` with per-scorer breakdown, per-persona scores (when applicable), aggregate score, confidence; written to `talk_output_revisions.metrics_json` | varies — depends on configured pipeline (~$0–$0.50 typical) |
| `factory_iterate_to_score` | autonovel `run_pipeline.py` shape, parameterized | (draft, scoring_pipeline_ref, iteration_config_ref) | best variant after iteration; full revision history in `talk_output_revisions`; loop terminates on threshold met / plateau / max attempts | sum of `factory_draft` + `factory_score` per attempt |
| `factory_panel_dialectic` | new — Panel Talk synthesis (per `02_HERO_APPLICATIONS.md` §2.7.5) | source_panel_id + source_turn_ids (with agent attribution preserved) | structured `DialecticResult`: thesis + antithesis (both steelmanned) + disagreement_kind + 0–3 synthesis_candidates with practical implications + nullable aporia + new_question. Resists compromise-style middle-grounding; aporia is a valid (often better) output than vague synthesis. **Phase 1B-PT.** | ~$0.05–$0.20 per call |

### 4.2 Skill contract (the part Booch was right about)

Every Skill SHALL be defined by a typed input/output schema (Pydantic models in rocketorchestra; Zod in clawrocket). Schema is versioned. Contract tests run in CI: a fixture input produces a structurally valid output, regardless of provider response variation.

Skills are NOT prompts. A Skill is `{schema_in, prompt_template, provider_route, schema_out, validators, post_processors}`. Prompt edits bump a `prompt_version`. Schema changes bump a `runtime_version`. Apps see only the `runtime` slug; the implementation is private to the Skill.

### 4.3 The agent-loop pattern (from autonovel/autoresearch)

For Skills that do iterative refinement (`factory_opus_review`, `factory_adv_cut`), the pattern is:

1. Run the Skill, get a result, score it.
2. Keep (write a new revision row) or discard (no revision written).
3. If kept and score below target, loop. If discarded twice consecutively, stop.

The substrate provides resumable job state via `goal_state` + `run_events` (already shipped). A pipeline that crashes mid-loop resumes from the last checkpoint. This is the autonovel `run_pipeline.py` shape, ported.

### 4.4 What we do NOT port from autonovel

- World-building / characters / outline-as-fiction: replaced by `themes` + `claims_ledger` + per-format `factory_outline`.
- ANTI-SLOP word lists targeted at fiction tells: replaced by industry-commentary slop list (TBD; first cut: empty business jargon, "landscape is evolving", LinkedIn-voice phrasings).
- Reader-panel personas (Sanderson / Le Guin / Jemisin / Hobb): replaced by `audience`-driven personas.
- Foreshadowing-ledger math, MYSTERY.md, chapter regex: deleted.
- LaTeX typesetting: not relevant.

---

## 5. The Multi-Agent Orchestration Layer

**What it is:** clawrocket's existing Talk runtime, extended with privacy modes, provider transparency metadata, and a momentary-fan-out primitive. Multi-agent fan-out, four orchestration modes, per-agent SSE streaming.

### 5.1 Orchestration modes

The substrate ships four modes:

- **Targeted** — one agent, conventional chat. Default.
- **Ordered** — N agents in sequence. Each later agent sees prior outputs as attributed user-context. Final agent flagged `isSynthesis` to consolidate.
- **Panel** — N agents in parallel, all receiving the same prompt + context. Independent SSE streams render as a column triptych.
- **Momentary** — *(NEW)* one-shot panel fan-out without creating a saved Talk. Used by Editorial Room to consult N models on a paragraph without opening Panel Talk. Implemented as `enqueueTalkTurnAtomic` with `talk_kind = 'momentary'` and `context_mode = 'incognito'` (1-hour auto-purge).

Existing implementation: `talks/run-worker.ts` + `talks/new-executor.ts:CleanTalkExecutor` (2,309 LOC). `enqueueTalkTurnAtomic` (in `db/accessors.ts`) creates N runs in one DB tx with shared `response_group_id` + per-agent `sequence_index`. The Momentary mode reuses this primitive end-to-end.

### 5.2 The Talk model

A Talk is an opaque conversation surface with: `talk_kind`, one or more `talk_agents` (each = `{provider, model, role, system_prompt}`), context bindings (`talk_context_*` tables), context mode, and zero or more bound outputs (`talk_outputs`).

**`talk_kind`**** values:**
- `chat` (existing) — default conversational Talk.
- `panel` (NEW) — Panel Talk sessions. Mode is set by the `context_mode` column (defaults to `persistent`; `incognito` when user opts in).
- `editorial` (NEW) — Editorial Room Stage-3 draft Talks.
- `momentary` (NEW) — one-shot fan-outs from Editorial Room consultations; auto-purge on session close or after 1 hour. Always has `context_mode = 'incognito'`.

### 5.3 Context modes

A column on `talks`: `context_mode` ∈ `{persistent, incognito, editorial, momentary}`. The substrate enforces contract guarantees per mode — not just UX hints. **These contracts are tested as code (see §17).**

| Mode | Saved | Indexed | Context grounding | Capture to context | Visible in panel list | Purge |
| --- | --- | --- | --- | --- | --- | --- |
| `persistent` *(default)* | yes | yes | optional (user-attached pages) | user-approved via inbox | yes | user delete only |
| `incognito` | temporary | **no** | **no** | **no** | **no** | TTL purge (default 7 days) |
| `editorial` | yes | scoped to piece | auto: voice + themes + claims_ledger | user-approved via inbox | yes (per panel-list policy) | user delete / archive |
| `momentary` | temporary unless saved | no | selected local context only | no | no | short TTL (1 hour) |

**Why Persistent is the default:** the cold-start-tax-elimination story (per `aicontrolplane-strategy.md`) requires panels to be persistent and accumulating. Defaulting to Incognito would undermine the core value prop. Most users — based on months of clawtalk/clawrocket use — never want their conversations purged. Incognito exists for the specific situation; persistence is the norm.

**Incognito v1 is local no-index only.** The substrate guarantees no embedding, no search index, no capture-to-context, no presence in the panel list, no inclusion in scheduled jobs or export jobs. It does **not** promise provider-side deletion (Anthropic API doesn't support per-conversation deletion; OpenAI has it for some plans; Google has it via Pub/Sub for Vertex). The retention-class badge on each provider tells the user what each model does with API content. Where provider deletion APIs exist, the substrate fires them best-effort and records audit results — but the product copy is honest: "local no-index" is the guarantee; provider-side deletion is best-effort.

### 5.4 Agent definition

The substrate already ships `registered_agents` + `agent_fallback_steps`. A `talk_agents` row binds a registered agent to a specific Talk with optional override of system prompt and tool grants.

Two preset libraries seed at install:
- **General presets** (Panel Talk default library): General Reasoning Quartet, Devil's Advocate, Steelman/Strawman Pair, Code Review Quartet, Personal Finance Council, Career Coach Quartet, Sports Analyst Pair, Parenting Counsel, Founder's Roundtable, Academic Review.
- **Editorial presets** (Editorial Room): Editor-in-Chief, Market Analyst, Developer Advocate, Monetization Strategist, Platform Analyst, Skeptical Contrarian, Newsletter Editor, Podcast Producer, YouTube Packaging Editor, Research Librarian, Final Synthesizer.

Both libraries are rows in `registered_agents` with tagged `library` field; `panel_presets` rows reference them as N-tuples.

### 5.5 Provider transparency metadata (NEW)

The substrate maintains a metadata sheet describing each `(provider, model)` pair on dimensions the apps need to surface:

```sql
CREATE TABLE provider_model_metadata (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  knowledge_cutoff_date TEXT,                  -- ISO date or null if unknown
  has_web_search BOOLEAN,                       -- null = unknown / not verified
  emits_citations BOOLEAN,                      -- null = unknown / not verified
  retention_class TEXT NOT NULL,               -- 'no_training' | 'opt_out_training' | 'default_training' | 'unknown'
  retention_days INTEGER,                       -- provider's default retention or null
  context_window_tokens INTEGER,                -- null = unknown / not verified
  source_url TEXT,                              -- link to provider's terms/page that documents this
  last_verified_at TEXT NOT NULL,
  verified_by TEXT,                             -- maintainer identity for the last verification
  PRIMARY KEY (provider_id, model_id)
);
```

The sheet is updated by a substrate maintainer (or a periodic job that reads official provider docs/APIs). Apps render the values as badges; they MUST NOT hardcode provider classifications in copy. Model rows are discovered at implementation time from official provider sources, not from this plan. Unknown or undocumented fields are stored as `null` or `retention_class='unknown'` and rendered as "unknown", not guessed. **Stale-metadata UX:** if `last_verified_at` is older than 60 days, the badge surfaces a small "metadata may be stale, last verified MM/YYYY" indicator. Hard-coding "OpenAI doesn't train on API content" in app prose is forbidden — the badge always reads from this table.

Pre-1 must also ship `docs/PROVIDER_METADATA_PLAYBOOK.md`. The playbook defines source priority, the manual refresh command, stale threshold, reviewer owner, add/remove/deprecate model process, and fallback semantics. Missing, stale, or deprecated metadata never blocks Skill dispatch and never becomes a confident UI claim; the app shows unknown/stale cost/privacy/search/citation facts and lets the user decide whether to proceed.

### 5.6 Streaming contract

Every agent response emits SSE events tagged with `responseGroupId`, `sequenceIndex`, `agentId`, `agentNickname`, `routeStepPosition`, `providerId`, `modelId`, `latencyMs`, `tokensIn`, `tokensOut`, `costUsd`. Apps render columns by demuxing on `responseGroupId` + `sequenceIndex`. Per-agent metadata (knowledge cutoff, retention class) is fetched from `provider_model_metadata` and rendered alongside. Streaming itself is shipped; metadata fetch is the new layer.

### 5.7 Incognito-purge job

A substrate cron in rocketorchestra runs daily, but clawrocket owns the Talk-delete transaction. The flow:
- Rocketorchestra acquires the `incognito_purge` lease and calls clawrocket `POST /api/internal/incognito-purge` with an idempotency key for the scheduled window.
- Clawrocket deletes Talks where `context_mode = 'incognito'` past their TTL (default 7 days).
- Clawrocket deletes `momentary` Talks (always Incognito) past their 1-hour TTL.
- Clawrocket transactionally deletes owned rows such as `talk_messages`, `talk_runs`, `talk_outputs`, `talk_output_revisions`, suggestion rows, search/index rows, and panel-list visibility rows.
- Clawrocket returns provider deletion/audit work items for model calls associated with purged Talks.
- Rocketorchestra best-effort fires provider deletion APIs where available (Anthropic doesn't support per-conversation deletion; OpenAI does for some plans; Google has Pub/Sub-based deletion paths for Vertex). It records best-effort outcomes in an audit log.
- User-triggered "Purge Now" reuses the same clawrocket endpoint, scoped to a single Talk.

Persistent Talks are NEVER auto-purged. They live until the user explicitly deletes them.

---

## 6. The Editor / Document Layer

**What it is:** versioned text artifacts with AI-suggestion overlay. Lives in clawrocket. **Largest piece of net-new work.**

### 6.1 Storage model

**Persistence layer:** Postgres (Supabase, shared project with rocketorchestra — see §2.5). All clawrocket tables live alongside rocketorchestra tables in the same DB; identity is unified via `auth.users`. The existing clawrocket SQLite schema is migrated to Postgres in Phase Pre-1; `better-sqlite3` is replaced with `postgres.js`. JSON columns become `JSONB`; ULIDs become `TEXT` (or `UUID` where appropriate); timestamps become `TIMESTAMPTZ`.

**Shared DB ownership contract:** the shared Supabase project is one database with two migration owners. Rocketorchestra owns its existing tables and migrations. Clawrocket owns either the `clawrocket` schema or every `cw_*` table in `public`; pick one convention before writing migrations and document it in `docs/DB_OWNERSHIP.md` in both repos. Each repo maintains a migration manifest that records the migrations it expects in the target DB. CI must compare the manifest against the target Supabase project and block deploy when code references tables, columns, functions, or policies that are not applied yet. RLS/user-isolation tests must run with anon, authenticated, and service-role credentials; request handlers must not rely on service-role RLS bypass for normal user data access.

Drafts extend the existing (now Postgres-flavored) `talk_outputs` table:

**Canonical format decision:** the canonical editor state is **structured document JSON** (Tiptap/ProseMirror schema, stored as JSONB). On every save, we also generate a **clean Markdown snapshot** (TEXT) that becomes the AI-facing projection (system prompts, exports, diffs). This avoids dual sources of truth — Markdown is always derived from JSON; never the other way.

```sql
-- After Phase Pre-1 migration: clawrocket tables in Postgres (Supabase).
-- existing clawrocket talk_outputs (translated from SQLite to Postgres):
CREATE TABLE talk_outputs (
  id TEXT PRIMARY KEY,
  talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content_markdown TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- EXTEND talk_outputs with the columns drafts need:
ALTER TABLE talk_outputs ADD COLUMN output_type TEXT NOT NULL DEFAULT 'newsletter';
  -- 'newsletter' | 'podcast_script' | 'youtube_script' | 'short_social' | 'note'
ALTER TABLE talk_outputs ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
  -- 'draft' | 'reviewing' | 'ready' | 'approved' | 'archived'
ALTER TABLE talk_outputs ADD COLUMN current_revision_id TEXT;
ALTER TABLE talk_outputs ADD COLUMN voice_page_slug TEXT;
ALTER TABLE talk_outputs ADD COLUMN claims_ledger_page_slug TEXT;

-- NEW: revisions as separate table
-- canonical = content_json (Tiptap doc); content_md_snapshot is a derived projection
CREATE TABLE talk_output_revisions (
  id TEXT PRIMARY KEY,
  output_id TEXT REFERENCES talk_outputs(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  content_json JSONB NOT NULL,           -- canonical: Tiptap/ProseMirror document JSON
  content_md_snapshot TEXT NOT NULL,     -- derived: clean Markdown rendered from content_json at save time
  markdown_source_map JSONB NOT NULL,     -- derived: stable Tiptap/ProseMirror ↔ Markdown source map for this snapshot
  source_skill TEXT NOT NULL,            -- 'manual' | 'draft' | 'adv_cut' | 'reader_panel' | 'opus_review' | 'optimize'
  created_by_run_id TEXT,
  metrics_json JSONB,                     -- slop score, length, est. read time, scoring pipeline result
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (output_id, revision_number)
);
ALTER TABLE talk_output_revisions ENABLE ROW LEVEL SECURITY;

-- NEW: pending suggestions from a Skill run
CREATE TABLE talk_output_suggestions (
  id TEXT PRIMARY KEY,
  output_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES talk_output_revisions(id) ON DELETE CASCADE,
  source_run_id TEXT NOT NULL,       -- which Skill run produced this
  source_skill TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  target_content_hash TEXT NOT NULL,
  source_map_refs JSONB NOT NULL,     -- block/span refs into revision.markdown_source_map
  markdown_range_start INTEGER NOT NULL,
  markdown_range_end INTEGER NOT NULL,
  anchor_quote TEXT NOT NULL,
  anchor_content_hash TEXT NOT NULL,
  anchor_context_before TEXT,
  anchor_context_after TEXT,
  anchor_status TEXT NOT NULL DEFAULT 'current', -- 'current' | 'stale' | 'ambiguous'
  replacement_md TEXT,                -- null = pure cut
  rationale TEXT NOT NULL,
  category TEXT,                      -- 'filler' | 'repetition' | 'hedge' | 'weak_verb' | 'tangent' | ...
  status TEXT NOT NULL,               -- 'pending' | 'accepted' | 'rejected' | 'edited' | 'stale'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id)
);
```

Drafts are addressable: `/api/v1/drafts/:id` returns `{output, current_revision, pending_suggestions, metrics}`. Saving from the editor writes a new revision row with Markdown snapshot + source map; suggestions auto-invalidate when the source-map refs, revision hash, and fallback anchors no longer resolve cleanly.

### 6.2 Editor technology

Tiptap (ProseMirror-based) with a custom suggestion mark/decoration plugin. Source-of-truth is `content_json`; Markdown and `markdown_source_map` are derived projections stored per revision and used for AI prompts, exports, diffs, and anchored Skill suggestions. **Decision rationale:** the Tiptap+suggestion-decoration pattern is well-trodden (Notion, Linear, Cal.com, Type.ai all use it); rolling our own ProseMirror schema is yes-and-no work; rolling our own non-ProseMirror editor is a year of bugs we don't need.

### 6.3 The Suggestion contract

Every Skill that proposes changes returns `Suggestion[]` rows that conform to:

**Phase 0p anchoring rule:** block-level anchors are mandatory; span-level anchors are optional until `docs/EDITOR_SOURCE_MAP_SPIKE.md` proves them stable for the supported Markdown subset. The source map schema may include `spans`, but 0p acceptance cannot depend on them. If span anchoring is brittle, keep block refs plus honest stale behavior and defer span-level precision.

```typescript
type MarkdownSourceMap = {
  schema_version: string;
  revision_id: string;
  content_hash: string;
  blocks: Array<{
    block_id: string;
    node_path: number[];
    pm_range: { from: number; to: number };
    markdown_range: { start: number; end: number };
    normalized_text: string;
    text_hash: string;
    context_before: string;
    context_after: string;
    spans?: Array<{
      span_id: string;
      pm_range: { from: number; to: number };
      markdown_range: { start: number; end: number };
      normalized_text: string;
      text_hash: string;
    }>;
  }>;
};

type SourceMapRef = {
  block_id: string;
  span_id?: string;
  text_hash: string;
};

type Suggestion = {
  schema_version: string;
  revision_id: string;                     // revision the Skill read
  target_content_hash: string;             // hash of the exact Markdown snapshot/source map the Skill read
  source_map_refs: SourceMapRef[];          // primary anchor path into MarkdownSourceMap
  markdown_range: { start: number; end: number };
  anchor_quote: string;                    // fallback exact text the range matched
  anchor_content_hash: string;             // fallback hash of the source Markdown snapshot
  anchor_context_before?: string;
  anchor_context_after?: string;
  replacement: string | null;              // null = pure cut
  rationale: string;
  category: SuggestionCategory;
  source_skill: string;
  source_run_id: string;
};
```

Skills receive the Markdown snapshot plus the exact `MarkdownSourceMap` stored on that revision. On ingest, clawrocket first resolves each returned `source_map_refs` entry back to ProseMirror positions for the named `revision_id` and `target_content_hash`. In 0p, returned refs must work at block level; span refs are accepted only for constructs covered by the feasibility fixtures. Source maps and resolved positions are cached by `revision_id + content_hash` so large drafts do not repeatedly pay the same resolution cost. If the current draft has moved on, clawrocket may use the stored source map plus `anchor_quote` / `anchor_content_hash` / context fallback to remap only when the match is unambiguous. Otherwise the suggestion is marked stale and the user must rerun the Skill. The editor renders each resolvable suggestion as a hover popover with [Accept] [Reject] [Edit].

Accepting or editing one suggestion creates a new revision. Before any remaining suggestion from that same Skill run can be accepted, clawrocket re-resolves it against the latest revision and proves the expected source span is unchanged. If revalidation fails, the remaining suggestion is marked stale and the user must rerun the Skill. There is **no global "apply all"** — the user clicks through. This is editorial discipline, not laziness; it's the Martin/Booch alignment from the strategy doc.

### 6.4 Inline mechanical scorer

`evaluate.py`-equivalent mechanical scoring (banned-word matches, sentence-opener repetition, hedge density) runs on save and debounced idle work, never every keystroke/render. Large drafts use `requestIdleCallback`, a Web Worker, or a save-only fallback so scoring stays off the hot render path. Findings render as red/yellow underlines with rule name on hover. Threshold configurable per draft. Implemented as a TypeScript port of the autonovel scorer logic, not a network call — runs in the browser for instant feedback. Freeze the scoring spec before porting, then prove TypeScript/Python parity on short drafts, long drafts, headings, lists, repeated phrases, hedges, weak verbs, code blocks, quotes, and near-threshold cases.

### 6.5 Voice lock

A banner at the top of the editor shows the current target `voice` page (e.g., `voice: gamemakers-2026`). Clicking opens the voice page in a sidesheet. The voice page is loaded as system context for every Skill call originating from the editor. This is the "voice protection" mechanism the strategy doc treats as load-bearing.

---

## 7. The Trigger Layer

**What it is:** the substrate decides when scheduled or event-driven Skills fire. Already shipped.

### 7.1 Cron triggers

`agent_schedules` table holds cron expressions tied to `goal_id`. Fires via in-process asyncio tick loop in rocketorchestra (single-replica; acknowledged tech debt — see strategy doc §6.3 Booch dissent).

**Idempotency from day one — non-negotiable for v1.** Single-replica cron is acceptable for single-user, but cron jobs MUST be idempotent so a manual replay or accidental double-fire produces the same outcome as a single fire. Schema additions:

```sql
ALTER TABLE agent_schedules ADD COLUMN last_attempted_run_id TEXT;
ALTER TABLE agent_schedules ADD COLUMN last_successful_run_id TEXT;
ALTER TABLE agent_schedules ADD COLUMN last_attempted_at TEXT;
ALTER TABLE agent_schedules ADD COLUMN last_successful_at TEXT;
ALTER TABLE agent_schedules ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_schedules ADD COLUMN cost_cap_usd_per_run NUMERIC;
ALTER TABLE agent_schedules ADD COLUMN active_lease_token TEXT;       -- prevents double-fire on multi-replica scaleout (future-proof)
ALTER TABLE agent_schedules ADD COLUMN active_lease_expires_at TEXT;

ALTER TABLE runs ADD COLUMN idempotency_key TEXT UNIQUE;              -- (schedule_id, scheduled_for) tuple as default
```

The runtime acquires a lease before firing; if a lease is already active (and not expired), the scheduler skips. Idempotency keys ensure a replay against the same `(schedule_id, scheduled_for)` is a no-op rather than a duplicate. The UI exposes manual replay and shows last successful / last attempted / consecutive-failure-count per schedule.

Default schedules for v1:
- `factory_idea_generator` — `0 6 * * 1` (Monday 06:00 host TZ)
- `factory_voice_drift_check` — `0 17 * * 5` (Friday 17:00)
- `industry_pulse` — `0 5 * * *` (daily 05:00)
- `back_catalog_indexer` — `0 2 * * *` (daily 02:00)
- `incognito_purge` — `0 3 * * *` (daily 03:00) — triggers clawrocket's internal purge endpoint for Talks where `context_mode = 'incognito'` past TTL (Persistent talks never touched)

### 7.2 Webhook triggers

Already shipped: Slack Events (HMAC-v0), Gmail Pub/Sub (JWT JWKS). Use cases:
- `gmail_reader_inbox` — incoming reader email → propose entry to `reader_signal` page.
- Future: Slack message in `#ideas` channel → propose to `themes` backlog.

Webhook dedup table prevents at-least-once doubles.

### 7.3 Manual triggers

Apps fire Skills on-demand via `run_skill(skill, inputs)` MCP tool. Returns a `run_id`; app polls `get_run(run_id)` for status + streaming output. For draft workflows, inputs include the revision's Markdown snapshot + `MarkdownSourceMap`, and rocketorchestra returns source-map-anchored suggestions only. Clawrocket is the sole draft write authority: it validates `revision_id` + `target_content_hash`, writes `talk_output_suggestions`, and appends `talk_output_revisions` in local transactions after the run completes.

---

## 8. Observability & cost reporting

Every Skill run writes:
- `runs` row: `{run_id, runtime, status, started_at, finished_at, cost_usd}`.
- `run_events` rows: per-stage events (started, stage_complete, errored, retried).
- `runs.metrics_json`: tokens in/out per provider, latency, retry count.

Apps SHALL show per-Skill cost in the UI and have a daily/monthly aggregate view (per-Skill efficacy is what Vo was right about in the strategy doc panel).

---

## 9. Integration contract — how apps talk to the substrate

The substrate exposes three contract surfaces. Apps consume all three; substrate evolves them with semver discipline.

### 9.1 MCP (JSON-RPC over HTTPS)

Endpoint: `https://rocketorchestra.com/mcp` (or self-hosted equivalent).
Auth: Bearer agent token (`roc_<base64-32B>`), SHA-256 hashed in DB.
Tools: enumerated in §2.2.
Per-tool capability audit log (already shipped).

### 9.2 REST (HTTPS + Bearer)

For non-tool-call operations: agent-token mint, clawrocket-owned draft CRUD, distribute_fetch. Rocketorchestra may read draft snapshots supplied by clawrocket as Skill input, but it must not proxy draft writes.
Endpoints documented in `rocketorchestra/docs/DISTRIBUTE.md` (existing) and clawrocket API reference (extend for new draft routes).

### 9.3 SSE (HTTPS)

For streaming Talk turns and Skill runs. clawrocket already exposes per-Talk event streams; rocketorchestra extends with per-`run_id` event streams for long Skills.

---

## 10. What's already shipped vs. net-new

To make scoping crisp:

| Capability | Status | Owner |
| --- | --- | --- |
| Multi-agent fan-out (Ordered + Panel) | shipped | clawrocket |
| Per-agent SSE streaming | shipped | clawrocket |
| Provider key vault (KMS envelope) | shipped | rocketorchestra |
| `/api/distribute/fetch` lease endpoint | shipped | rocketorchestra |
| Page model + compiled_truth + timeline | shipped | rocketorchestra |
| MCP read tools (5 of them) | shipped | rocketorchestra |
| Cloud Run Jobs dispatcher (`runs/dispatcher.py`) | shipped | rocketorchestra |
| Cron scheduler (single-replica) | shipped | rocketorchestra |
| Slack + Gmail webhook ingest | shipped | rocketorchestra |
| Inbox / propose_update flow | shipped | rocketorchestra |
| Modal embeddings | shipped | rocketorchestra |
| `talk_outputs` table | shipped (in SQLite — migrates to Postgres in Phase Pre-1) | clawrocket |
| **clawrocket Postgres migration** — translate 116 SQLite tables to Postgres schema; replace `better-sqlite3` with `postgres.js`; convert sync→async accessors; deploy to Cloud Run; share Supabase project with rocketorchestra | **NEW (Phase Pre-1)** | clawrocket |
| **clawrocket Auth → Supabase Auth migration** — replace local cookie sessions with Supabase JWT; consolidate `auth.users` shared with rocketorchestra; preserve clawrocket's CSRF middleware | **NEW (Phase Pre-1)** | clawrocket |
| Tiptap rich-text foundation (links, tables, lists, BubbleMenu, JSONB-safe serializer, tiptap→markdown) | **PORT from rocketboard** | clawrocket |
| 80-step undo/redo hook (`useDocumentHistory`) | **PORT from rocketboard** | clawrocket |
| Document persistence schema template (`documents` + `document_versions` shape, optimistic concurrency) | **PORT from rocketboard** | clawrocket |
| Agent profile model (`agent_profiles` table, ported from rocketboard `ai_personas`; `AgentProfileSwitcher`, `AgentProfileEditDialog`, BYOK + Anthropic OAuth subscription) | **PORT from rocketboard** | clawrocket |
| 3-provider streaming chat repository (Anthropic + OpenAI + Google delta parsers) | **PORT from rocketboard** | clawrocket |
| Kanban view (dnd-kit + TanStack Virtual) — for Idea Backlog | **PORT from rocketboard** | clawrocket |
| Markdown→Tiptap adapter (rocketboard has tiptap→markdown only — one direction) | **NEW** | clawrocket |
| AI suggestion overlay (ProseMirror Decorations + accept/reject popovers) | **NEW** | clawrocket |
| Voice-lock banner | **NEW** | clawrocket |
| Inline mechanical scorer (TypeScript port of `evaluate.py`) | **NEW** | clawrocket |
| Range-anchored panel consultations ("Consult Panel on this paragraph") | **NEW** | clawrocket |
| Sources as first-class entities (richer than rocketboard's file attachments) | **NEW** | clawrocket |
| Idea entity + Idea Backlog data model (kanban view ports; the data shape doesn't) | **NEW** | clawrocket |
| `talk_output_revisions` + `talk_output_suggestions` tables | **NEW** | clawrocket |
| New MCP tools: clawrocket owns `list_drafts`, `get_draft`, `propose_revision`; rocketorchestra owns `run_skill`, `get_run`, `record_panel` | **NEW** | both repos, split by write authority |
| `factory_*` Skill runtimes (12 of them) | **NEW** | rocketorchestra |
| Skill contract testing harness | **NEW** | rocketorchestra |
| Page types: `claims_ledger`, `interview_transcript` | **NEW** | rocketorchestra |
| Cost ceiling per `runtime.daily_budget_usd` | **NEW** | rocketorchestra |
| ClawRocket-side MCP server (for external agents to query drafts) | **NEW** | clawrocket |
| Context modes (`persistent` default / `incognito` opt-in / `editorial`) on Talks | **NEW** | clawrocket |
| `talk_kind` extensions (`panel`, `momentary`) | **NEW** | clawrocket |
| `panel_presets` table + general + editorial preset libraries (built on top of `agent_profiles` port) | **NEW** | clawrocket |
| `provider_model_metadata` table + maintenance job | **NEW** | rocketorchestra |
| Incognito-purge cron + best-effort provider deletion (Persistent talks never auto-purged) | **NEW** | both repos |
| "Private mode" provider filtering (excludes training-on-content providers) | **NEW** | clawrocket |
| `panel_points` table (Talking Points: text, status, source, resolution note) | **NEW** | clawrocket |
| Points-tracker UI (right rail, manual close, synthesizer-proposed points) | **NEW** | clawrocket |
| `convergence_outline` Skill (points → structured outline JSON) | **NEW** | rocketorchestra |
| Output adapter dispatcher (`output_to_destination(panel, destination, template)`) | **NEW** | clawrocket |
| Output templates (talking-points-list, engineering-memo, blog-post-draft-seed, decision-memo, meeting-prep-doc) | **NEW** | rocketorchestra (template prompts + schemas) |
| Google Docs integration (write doc to user's Drive on output) | **PORT from rocketboard** + adapt to use existing `user_google_credentials` | clawrocket |
| `Scorer` interface + scoring pipeline executor (composable, gate / score / diagnostic roles) | **NEW** | rocketorchestra |
| `iteration_config` runtime + plateau detection | **NEW** | rocketorchestra |
| AutoNovel Mechanical scorer (TS port — runs in browser, free, instant) | **NEW** (port from `autonovel/evaluate.py:slop_score()`) | clawrocket |
| AutoNovel Judge scorer (LLM rubric) | **NEW** (port from `autonovel/evaluate.py` LLM judge) | rocketorchestra |
| SSR scorer (vendored ssr-core) | **PORT from syntheticalresearch** (vendor `packages/ssr-core` only, ~735 LOC; no SaaS dependency) | rocketorchestra |
| `persona` page type as substrate primitive (with 5 GameMakers starter personas seeded) | **NEW** | rocketorchestra |
| `scorer_config`, `scoring_pipeline`, `anchor_bundle`, `iteration_config` page types | **NEW** | rocketorchestra |
| Scorer Library UI (browse / clone / edit scorers; configure pipelines per channel) | **NEW** | clawrocket |
| Default GameMakers scoring pipeline + 3 anchor_bundles (newsletter / podcast / youtube anchors) | **NEW** (seed data) | rocketorchestra |
| 11 personal context page types (`identity`, `project`, `company`, `person`, `decision`, `preference`, `domain`, `goal`, `tool`, `relationship`, `event`) | **NEW** schemas + validators | rocketorchestra |
| Personal context grounding in apps (Grounded mode loads `person`/`project`/`decision`/etc. as system context for LLMs) | **NEW** | both repos |
| "Save to Context" action in Panel Talk and Editorial Room (dispatches existing `propose_update` flow) | **NEW** UI surface | clawrocket |
| `factory_propose_context_update` Skill — agent reads conversation/draft, suggests page diff for inbox approval | **NEW** | rocketorchestra |
| Outbound exporter abstraction + 3 v1 adapters (Markdown dump, Google Drive folder, Obsidian vault) | **NEW** (Markdown adapter is trivial; Drive reuses existing `user_google_credentials`; Obsidian is filesystem write) | both repos |
| Context Library page (browse all personal context, not just editorial-domain) | **NEW** | clawrocket |
| `external_export_target` page type + scheduled `context_export` cron | **NEW** | rocketorchestra |

Three columns now: **shipped** is leverage you already have running, **PORT from rocketboard** is leverage you own but live in another repo (one-shot copy), **NEW** is genuinely net-new work. The PORT column saves ~25 hours off the previous estimate; see §14 for the exact module list.

---

## 11. Out of scope for substrate v1

- Multi-tenant or team collaboration. Single user; defer indefinitely.
- Real-time collaborative editing in the Tiptap pane (CRDTs). Single-user.
- Direct platform publishing (Substack, Spotify, YouTube CMS). Manual paste-and-go.
- Mobile UX. Read-only mobile via existing webapp responsive shim only.
- Offline / local-only generation. Network is assumed up.
- A general-purpose RAG vector search across user files (the page model + FTS is enough for v1).
- Cowork compatibility shim. Wait for an Anthropic stable extension point.

---

## 12. Migration & rollout order

The rollout principle: **substrate-minimum-before-apps + substrate-behind-workflows.** Some substrate must ship before any app can run; everything else gets justified by a workflow already in use. The first proof loop is **Editorial Room Stage 3** — that scopes which substrate features are necessary in early phases vs. deferred.

### Phase 0 — Lock decisions and contracts (no code)

Before any implementation phase, lock these decisions explicitly so they don't drift mid-build:

- ✅ **Editor canonical format:** structured JSON (Tiptap/ProseMirror) + per-revision Markdown snapshot (§6.1).
- ✅ **Both runtime repos cloud-hosted** (Cloud Run + shared Supabase Postgres + GCP KMS) per §2.5. SQLite eliminated. Local export adapters preserve sovereignty (§16).
- ✅ **Shared Supabase project** for both repos with unified `auth.users`. Schema isolation by table prefix per repo.
- ✅ **BYOK first-class, subscription-compatible** business model (§3.0).
- ✅ **Context mode contracts** ship in Phase Pre-1 as storage/runtime behavior (`context_mode`, default `persistent`).
- ✅ **Momentary panel substrate** ships in Phase Pre-1 via `talk_kind`; deeper Panel Talk UX remains later.
- ✅ **App navigation separate initially** — Panel Talk and Editorial Room have separate panel lists; consider a substrate-level "Recent Thinking" view later if signal warrants it.
- ✅ **First proof loop:** Editorial Room Stage 3.
- ✅ **Incognito v1 = local no-index plus clawrocket-owned purge boundary;** provider-side deletion is best-effort with audit, not promised (§5.3).
- ✅ **First export targets for Phase 1A:** Markdown copy/download, Google Docs, and Substack-flavored Markdown.

Phase 0 is a documentation phase that produces a "decisions.md" alongside this architecture spec; it has no engineering hours of its own beyond review time.

### Phase 0p — Local proof MVP before cloud migration

Before the cloud/auth migration starts, prove the high-risk Editorial Room interactions locally in clawrocket. This is the only authorized next build gate: if the local Setup/portfolio loop or local editor/export contract fails, simplify the product or contract before migrating infrastructure.

**0p work:**

1. **Local Setup/portfolio vertical slice** — using the current clawrocket local dev stack and fixture data, prove Setup, Theme/Topic, Points/Notes, fixture LLM Discussion, score states, point-note boundaries, and proposal accept/edit/reject/park without touching rocketorchestra or cloud infrastructure. The fixture Discussion/proposal loop must prove retained output, cost/latency visibility, and clean partial-provider failure behavior.
2. **Local editor/export contract** — using existing persistence where possible, prove Tiptap draft editing, Markdown snapshot generation with block-level `MarkdownSourceMap`, anchor resolver, fixture/mocked Skill suggestions, suggestion overlay, accept/reject/edit, revision append, stale behavior, and Substack-flavored Markdown copy/download. Run a source-map feasibility spike before requiring span-level anchoring: verify installed Tiptap Markdown support, freeze the supported Markdown subset, and graduate span refs only after fixtures prove deterministic generation and re-resolution.
3. **Fixture-first adapter boundary** — the local proof uses fixtures first; an optional live adapter can be added later only if it conforms to the same schemas and is not required for acceptance.
4. **Executable cross-repo contract** — add `docs/EDITORIAL_ROOM_CONTRACT.md` plus versioned JSON Schemas under `docs/contracts/editorial-room/v0/*.schema.json` for Setup/portfolio objects, score results, discussion/proposal payloads, `MarkdownSourceMap`, `Suggestion[]`, `run_skill`, and `get_run`. The schemas are the canonical machine contract. They define `$id`, `schema_version`, required/nullable fields, idempotency replay behavior, stale revision/hash behavior, payload caps, source-map anchor semantics, and explicit extension points. Shared fixtures must validate against the same schema files in clawrocket and rocketorchestra.
5. **Stop/go memo** — write `docs/PHASE_0P_STOP_GO.md` before any cloud migration starts. GO requires the local portfolio and editor flows to work without manual DB/JSON edits or cloud dependencies, Joseph to rate the workflow worth using for the next real piece, at least one retained proposal/discussion output, cost/latency and partial-provider tests passing, and boundary/performance tests passing.

### Substrate minimum-before-apps (Phase Pre-1)

These substrate items are blocked productionization backlog. They must not start until Phase 0p passes the stop/go metrics and Joseph explicitly authorizes cloud productionization. Everything else is deferred until a workflow demands it.

**Cloud-migration tasks (clawrocket — load-bearing prerequisite for everything below):**

A. **Provision shared Supabase project** for both repos OR add clawrocket's tables to rocketorchestra's existing Supabase project. Decision: share rocketorchestra's existing project to keep operational surface small. ~2h.
B. **Write the shared DB ownership contract and drift gate.** `docs/DB_OWNERSHIP.md` in both repos defines schema/prefix ownership, migration owner, manifest format, deploy order, and RLS test matrix. CI blocks deploy if either repo's manifest is ahead of the target DB. ~4h.
C. **Translate clawrocket's SQLite migrations to Postgres.** 116 tables in `db/init.ts` get rewritten as Postgres migrations under `clawrocket/supabase/migrations/cw_*.sql`. Local auth/session tables are intentionally excluded or replaced by Supabase Auth. JSONB for JSON columns; TIMESTAMPTZ for timestamps; UUID where appropriate; text-array types for what was JSON arrays in SQLite. ~14h.
C-1. **Define and pass a migration behavior parity gate.** Existing local SQLite data is disposable, but existing clawrocket behavior is not. Representative SQLite fixtures/routes must match the Postgres port for IDs/foreign keys, ordering, defaults, nullable fields, JSON serialization, cascade behavior, transactional boundaries, idempotency, and error semantics. Any intentional behavior change must be named in `docs/DB_OWNERSHIP.md` with the reason and affected routes. ~2h.
C-2. **Port and prove hot-path indexes.** Add Postgres indexes for draft load, revision history, pending suggestions, accept/reject/edit reads, and RLS ownership checks. Migration tests assert the required indexes exist, and large-fixture query-plan checks prove those paths use the intended indexes. ~2h.
D. **Replace ****`better-sqlite3`**** with ****`postgres.js`** (or `kysely`); convert DB accessors and callers from sync to async. Preserve transactional semantics explicitly during the conversion. ~18h.
E. **Replace clawrocket local-cookie auth with Supabase Auth.** Drop `users`, `web_sessions`, `oauth_state`, `device_auth_codes` tables (Supabase Auth provides these). Keep `user_google_credentials` etc. as clawrocket-specific tables that FK to `auth.users(id)`. Implement HttpOnly-cookie + JWT + refresh-on-expired pattern that rocketorchestra already uses. CSRF middleware stays. Google OAuth linking, Picker, and Google Docs export either preserve credential ownership through `auth.users(id)` or show an explicit reconnect state. ~12h.
E-1. **Define the Cloud/Auth/RLS access contract before rewriting handlers.** Local dev and CI run against a Supabase-compatible Postgres with the `auth` schema and seeded `auth.users`. Supabase `service_role` is a global RLS bypass, not an app-scoped user role; normal request handlers must not depend on it for user reads/writes. Document localhost, Cloud Run URL, and custom-domain cookie behavior: HttpOnly, Secure in deployed environments, SameSite, refresh rotation, CSRF, redirect allowlists, and `Cache-Control: no-store` on auth-dependent responses. ~4h.
F. **Containerize clawrocket and deploy to Cloud Run.** Dockerfile, cloudbuild.yaml or GitHub Actions, environment plumbing. Pattern follows rocketorchestra's existing deploy. ~4h.
F-1. **Set an explicit DB connection budget before deploy.** Runtime Postgres access must use a documented Supabase connection mode and explicit `postgres.js` pool settings (`max`, idle/connect timeouts, application name). Cloud Run max instances × runtime pool size must stay under the Supabase connection budget after reserving rocketorchestra, migration/admin, and Supabase-managed capacity. Migration/drift/admin scripts use a separate direct/admin connection. If the Supabase transaction pooler is used, disable prepared statements for `postgres.js`. ~1h.
F-2. **Add cloud cutover rollback, backup, and canary gate.** Before production traffic, run staging/preview smoke tests, take a Supabase backup or snapshot, prove restore into a scratch DB/project, document image rollback to the prior Cloud Run revision, and run canary checks for auth, draft load/save, Google OAuth reconnect/export, and rocketorchestra MCP health. ~4h.
G. **Cross-repo auth + deploy verification** — sign in once via Supabase Auth, both apps recognize the user; both services healthy in Cloud Run; shared Postgres reachable from both; drift gate, RLS matrix, Google OAuth reconnect/export smoke, and canary checks pass in both repos. ~3h.

Cloud-migration subtotal: **\~65h.**

**Full Phase 1A substrate items proper:**

1. **clawrocket × rocketorchestra glue** — verified provider/model metadata; agent-token settings only if current scopes are insufficient; rocketorchestra Skill MCP routes (`run_skill` / `get_run`); clawrocket draft REST routes and clawrocket-owned MCP draft tools (`list_drafts`, `get_draft`, `propose_revision`). Draft writes stay in clawrocket transactions. ~7h.
2. **Talk privacy/runtime substrate** — `context_mode`, `talk_kind`, incognito non-leakage rules, and clawrocket-owned internal purge endpoint called by rocketorchestra scheduler. ~6h.
3. **Draft revision schema** — `talk_output_revisions` with `content_json` (JSONB) + `content_md_snapshot` (TEXT) + `markdown_source_map` (JSONB), plus `talk_output_suggestions` with revision-scoped source-map refs, fallback anchor fields, and stale/ambiguous statuses. ~6h.
4. **Rocketboard editor + agent profile + streaming parser ports** — first write the rocketboard port preflight note, then port the Tiptap foundation, stable JSON serializer, tiptap→Markdown serializer, prepare-content/link helpers, 80-step undo/redo hook, `agent_profiles`, and Anthropic/OpenAI/Google streaming parsers. ~10h.
5. **Markdown↔JSON layer** — Markdown→Tiptap adapter; tiptap→Markdown snapshot generator; deterministic round-trip tests. ~3h.
6. **Suggestion anchor resolver** — deterministic `MarkdownSourceMap` generation from canonical Tiptap JSON + Markdown snapshot; source-map ref resolution back to ProseMirror positions; stale/ambiguous fallback behavior. ~3h.
7. **AutoNovel Mechanical scorer** — TS port from `evaluate.py:slop_score()`, runs in browser; the editor's inline scorer is needed in Phase 1A. ~4h.
8. **rocketorchestra scheduler/idempotency support** — Skill run idempotency, scheduler leases, and incognito-purge cron driver. ~6h.

Full Phase 1A substrate subtotal: ~45h.

**Full Phase Pre-1 total if authorized: \~110h** (65h cloud migration + 45h substrate items). The local proof MVP is the gate before this work; once 0p says GO, tasks A-G gate production deployment. Substrate items can run in parallel after the cloud-migration gate is green.

### Substrate-behind-workflows (Phase 1A onwards)

The remaining substrate ships *as the apps demand it.* See `02_HERO_APPLICATIONS.md` §10 for the app phases. Substrate adds per phase:

| App phase | Substrate added |
| --- | --- |
| **Phase 0p** Local proof MVP | Setup/portfolio fixtures, local proof UI, fixture-first adapter, executable Editorial Room contract, versioned JSON Schema package under `docs/contracts/editorial-room/v0/`, shared `MarkdownSourceMap` / `Suggestion[]` / `run_skill` / `get_run` fixtures, local clawrocket proof-loop tests, and `docs/PHASE_0P_STOP_GO.md` |
| **Phase 1A** Editorial Room layered proof loop (6 visible UI phase pills: `01 SETUP \| 02 THEME + TOPICS \| 03 POINTS + OUTLINE \| 04 DRAFT \| 05 POLISH \| 06 SHIP`; conceptually 9 stages — Theme+Topic combined, Points+Outline combined, Sources/Research as a tab inside Points + Outline) | `theme`/`topic`/`point` page types + 5-7 hand-seeded themes; layer-1-3 Skills (`factory_topic_propose`, `factory_point_propose`, `factory_point_debate`, `factory_claim_research`, `factory_outline_builder`, `factory_argument_critic`, `factory_counter_audience`, `factory_claim_coverage`); polish Skills (`factory_opus_review`, `factory_adv_cut`); voice page seed; minimal `claims_ledger`; draft revision/suggestion substrate; provider metadata; incognito purge boundary; Markdown copy/download; Google Docs; Substack-flavored Markdown adapter |
| **Phase 1A.5** Set Targets + Optimize Watcher | Persona/audience substrate + 5 starter personas; anchor_bundle page type + 1 newsletter default; `Scorer` interface + AutoNovel Judge; `iteration_config` page type + 1 default; `factory_score` + `factory_iterate_to_score` Skills; `factory_research_brief` + `factory_outline` Skills; `factory_draft` / `factory_revision` |
| **Phase 1B** Editorial Stages 1, 2, 4 | `factory_idea_generator` Skill; `industry_signal` + `reader_signal` + `back_catalog` page types; `factory_reader_panel` Skill; reader-signal Gmail trigger |
| **Phase 1C** Editorial polish | `factory_voice_drift_check` Skill; SSR scorer (vendored `ssr-core`); broader scoring pipeline flexibility; remaining 2 anchor_bundles (podcast, youtube) |
| **Phase 2A** Panel Talk Core | Panel Talk MVP per `02_HERO_APPLICATIONS.md` §10 (slim scope) |
| **Phase 2B** Panel Talk richness | Talking points lifecycle, convergence outline Skill, output destinations beyond Markdown, `panel_presets` library expansion |
| **Phase 3** Personal context | 11 PCP page types (rolled in incrementally — `voice` + `themes` + `back_catalog` + `claims_ledger` already in earlier phases; add `person` + `decision` + `preference` + `domain` here, others later); `factory_propose_context_update` Skill; "Save to Context" UX |
| **Phase 4** Exporters | Markdown dump adapter (always-available, ships with 1A); Google Drive if not pulled forward after dogfooding; Obsidian vault adapter; `external_export_target` page type; `context_export` cron |

This is meaningfully different from prior versions of this rollout. The earlier ordering shipped substrate ahead of apps; this ordering ships only what the next app phase needs.

**Substrate-only effort to support full production Phase 1A if authorized:** ~45h Pre-1 substrate + ~24h embedded in Phase 1A (`theme`/`topic`/`point` page-type substrate, layer-1-3 Skill ports, claims_ledger schema) = **\~69h substrate, plus the one-time clawrocket cloud/auth migration gate (\~65h).** This is not the current gate. Phase 1A app work (5 surfaces + Polish + Ship) is ~140h on top — see `04_BUILD_PLAN.md` §4 for the breakdown. **Production Phase 1A total: \~244h of focused engineering** (~65h cloud migration + ~69h substrate + ~110h app work). Realistic timeline if 0p says GO: ~6 weeks.

**Phase 1A acceptance criterion (revised v11):** Joseph takes a piece end-to-end through Theme → Topic → Points (multi-LLM debate) → Outline → Draft → Polish → Ship, and the portfolio (themes/topics/points pages) is real and persistent. **Time-to-first-piece: 3-5 hours expected, not 90 minutes.** That's the cost of investing in portfolio. Time-to-fifth-piece-on-same-theme drops back to ~90 minutes because portfolio compounds (existing points get reused, only the new ones need fresh debate). The yardstick is a *trajectory*, not a single number — see `02_HERO_APPLICATIONS.md` §10 for the full table.

---

## 13. Glossary

### Agents, profiles, personas — the disambiguation that matters most

- **Agent (in this stack)** — a `(provider, model, role, system_prompt)` slot inside a Talk. Not an autonomous worker. Autonomous workers are *scheduled context agents* in rocketorchestra cron.
- **Agent profile** — a saved configuration of an agent slot: `(provider, model, system_prompt, focus_area, surface, accent_color, …)`. Lives in clawrocket's `agent_profiles` table (donor: rocketboard's `ai_personas` schema, renamed to disambiguate). Use "agent profile" or "profile" in user-facing copy when referring to model presets.
- **Persona** — a *constructed audience target* for editorial work. Lives in rocketorchestra `pages` of type `persona` (e.g., Ankit-the-indie-dev, Sarah-the-AAA-producer). Used by Editorial Room as scoring rubrics and target audiences. **Distinct from ****`person`** (a real human like a co-founder or family member, also a page type). A persona MAY reference a `person` page when modeled on someone real.
- **Person** — a real human the user works with or thinks about. Page type in rocketorchestra. Distinct from `persona` (constructed) and `agent_profile` (model preset).

### Talks, Drafts, and editorial primitives

- **Talk** — a clawrocket conversation surface. Has a `talk_kind`, one or more `talk_agents`, a `context_mode`, and zero or more bound `talk_outputs`.
- **Draft** — a `talk_outputs` row plus its revisions. Canonical state is `content_json` (Tiptap JSONB); each save also stores a derived `content_md_snapshot` (Markdown TEXT) and a `markdown_source_map` (JSONB). Lives in clawrocket-owned tables in the shared Supabase Postgres.
- **Revision** — a `talk_output_revisions` row. Every meaningful save and every accepted Skill suggestion creates a new revision. Revisions are append-only; revert creates a new revision pointing at prior content.
- **Suggestion** — a typed proposal to mutate a draft range. Anchored to the source revision via `revision_id` + `target_content_hash` + `source_map_refs[]` + fallback (`anchor_quote`, `anchor_content_hash`, before/after context). Stale or ambiguous suggestions are marked `stale` and require rerun, never silently re-targeted. Rendered in the editor as accept/reject/edit popovers; accept creates a new revision.
- **MarkdownSourceMap** *(audit-introduced)* — the per-revision substrate that anchors Skill suggestions across edits. Records, for every addressable block/span in a draft: stable block IDs, ProseMirror path/position ranges, Markdown character-offset ranges, normalized text, content hashes, and before/after context. Generated deterministically from the canonical Tiptap JSON + Markdown snapshot at save time. Cached by `revision_id + content_hash`.
- **Source map ref** — a Skill-returned reference into a `MarkdownSourceMap`. Shape: `{ block_id, span_id?, text_hash }`. Resolved back to ProseMirror positions at the named `revision_id`.
- **Anchor stale state** — the marker used when a suggestion's source span no longer matches the current draft. Stale suggestions are visible but cannot be accepted; the user must rerun the Skill.

### Pages and substrate

- **Page** — a typed, slug-addressable rocketorchestra document with `compiled_truth` (structured JSON) plus immutable `timeline` (append-only evidence log).
- **Theme** *(layer 1)* — broad durable subject area Joseph writes about over time. Initial implementation has 5–7 hand-seeded themes plus a default `theme/misc` for orphan topics; steady-state population grows to 5–10 active per publication. See `THEME_TOPIC_POINTS_DEFINITION.md` §3 for the binding definition and scorable axes.
- **Topic** *(layer 2)* — specific angle within a theme. Has `parent_theme_slug`, one-line thesis, child points, novelty score against `back_catalog`. See `THEME_TOPIC_POINTS_DEFINITION.md` §4 for the binding definition.
- **Point** *(layer 3)* — specific claim/argument within a topic. Has `parent_topic_slug` (single parent initially), claim, rationale, evidence, status, conviction. The unit of multi-LLM panel debate. See `THEME_TOPIC_POINTS_DEFINITION.md` §5 for the binding definition and scorable axes.
- **Production Brief** — the per-Piece composition surface where Theme + Topic + Points + Audience + Voice + Outline come together. Distinct from the substrate `pages`; the Piece references substrate pages but the Brief is per-Piece.
- **Brief** *(scheduled-agent output)* — output of a scheduled `*_ideas` agent. Lives as a child page under a `theme` parent. Distinct from "Production Brief" above.
- **Voice page** — the canonical specification of *how* this user writes. The most important page in the system.
- **Inbox** — rocketorchestra's existing approve/reject queue for `propose_update` diffs to pages. NOT to be confused with "Idea Backlog" in Editorial Room.

### Panel Talk concepts

- **Panel Turn** — one user message fanned out to N agents; rendered as a column triptych in the transcript.
- **Synthesis** — a final consolidation step in Ordered mode (or on demand in Panel mode) where one agent merges prior outputs into a single response.
- **Talking Point** — a tracked claim within a Panel debate. Status: `Active | Closed - Agreed | Closed - Disagreed | Parked`. Status is set by the user, never automatically.
- **Convergence** — the user-triggered moment a Panel produces a structured outline of where the conversation landed. Never required; many Panels end without it.
- **Optimize Watcher** — the Editorial Room Stage 3.5 surface where a draft is iterated against a scoring pipeline + persona targets until threshold/plateau/max attempts.

### Privacy / mode contracts

- **Context mode** — `persistent` (default — saved, indexed, can attach context pages, can capture to context), `incognito` (opt-in — not indexed, auto-purge after TTL, no grounding, no capture, not visible in panel list), `editorial` (auto-grounds on `voice` + active `themes` + `claims_ledger`), or `momentary` (one-shot fan-out from Editorial Room consultation; always incognito-equivalent; 1-hour TTL). Per-Talk privacy posture; tested as code in §17.
- **Momentary fan-out** — a one-shot `enqueueTalkTurnAtomic` invocation that does not create a persistent Talk. Used by Editorial Room to consult N models on a paragraph without opening Panel Talk.
- **Private mode** — a per-Panel toggle that filters out providers with training-on-content default terms. Independent of the persistent/incognito axis.
- **Provider transparency metadata** — substrate-maintained sheet of `(provider, model)` properties: knowledge cutoff, web search availability, retention class, retention days, context window. Surfaced as badges in apps. UI never hardcodes provider claims in copy.

### Scoring substrate

- **Scorer** — a pluggable evaluator with a typed `evaluate(input, params) → ScoreResult` interface. v1 ships three: AutoNovel Mechanical, AutoNovel Judge, SSR (vendored from syntheticalresearch).
- **Scoring pipeline** — a named sequence of `scorer_config` refs with role assignments (gate / score / diagnostic) and an aggregation rule. The default GameMakers pipeline runs Mechanical → Judge.
- **Reference set** — Likert anchor statements used by SSR-style scorers. e.g., "1: I'd close this immediately. … 5: I'd share this and quote it this week." Different sets per channel.
- **Iteration config** — parameters for the iterate-to-score loop (max_attempts, acceptance_criterion, plateau_check, on_failure). Defaults ship per-channel (newsletter / podcast / youtube).

### Skill execution and ops

- **Skill** — a typed, named, parameterized generation pipeline. Backed by a `runtime` row of kind `factory_*` in rocketorchestra. Invoked via `run_skill` MCP tool.
- **Schema version** — the `Suggestion`/`MarkdownSourceMap` shape version a Skill produces and clawrocket consumes. Frozen in `docs/EDITORIAL_ROOM_CONTRACT.md` and the matching `docs/contracts/editorial-room/v0/*.schema.json` package. Drift is caught by validating shared fixtures against the same schemas in both repos.
- **Idempotency key** — the `(schedule_id, scheduled_for)` or `(user, agent, skill, target_revision_id, target_content_hash)` tuple that makes a `run_skill` replay-safe. Same key returns the same queued/running/terminal run; never enqueues a duplicate Cloud Run Job.
- **Phase 0p** *(audit-introduced)* — the local proof MVP that validates Setup/portfolio, scoring/proposal contracts, point-note boundaries, editor/anchor/revision behavior, and export in clawrocket before any Supabase/Auth/Cloud Run migration cost is paid. A gate, not optional prep.

### Cross-repo discipline

- **DB ownership contract** *(audit-introduced)* — the agreement, documented in `docs/DB_OWNERSHIP.md` in both repos, that defines schema/prefix ownership, migration manifest format, deploy order, drift gate, and RLS test matrix in the shared Supabase project. CI blocks deploy when either repo's manifest is ahead of the target DB.
- **Migration behavior parity gate** *(audit-introduced)* — pre-deploy fixture suite proving representative SQLite fixtures/routes match the Postgres port for IDs, foreign keys, ordering, defaults, nullable fields, JSON serialization, cascade behavior, transactional boundaries, idempotency, and error semantics. Any intentional behavior change is documented.
- **Cutover rollback / canary gate** *(audit-introduced)* — pre-production-traffic checks: staging smoke, Supabase backup + restore-into-scratch proof, Cloud Run image rollback documentation, canary checks for auth / draft load-save / Google OAuth reconnect-export / rocketorchestra MCP health.
- **Connection budget** *(audit-introduced)* — the documented per-repo Postgres connection pool sizing such that Cloud Run max instances × pool size + rocketorchestra usage + admin/migration capacity stays under the Supabase budget.

---

## 14. Code mined from rocketboard — exact port list

This section lists every module/file ported from `/Users/josephkim/dev/rocketboard/` into clawrocket, with target rename and any adaptation notes. Treat this as a port checklist, not a coupling — once these files land in clawrocket, rocketboard is no longer a dependency.

**Port preflight gate:** before copying any rocketboard code, write `docs/ROCKETBOARD_PORT_NOTE.md`. Inventory the donor files' Tiptap extensions, React/version assumptions, CSS/UI dependencies, storage/auth assumptions, Supabase/project-view bindings, unsupported imports, and package/version deltas against clawrocket. The note must state what ports directly, what must be adapted, and what must not be imported.

### 14.1 Rich-text editor foundation

| Source | Target in clawrocket | Notes |
| --- | --- | --- |
| `src/features/rich-text/RichTextEditor.tsx` | `webapp/src/features/editor/DraftEditor.tsx` | Rename component to `DraftEditor`. Keep StarterKit (with undo/redo disabled), Link, Placeholder, TaskList, TaskItem, Table, BubbleMenu. Drop `Document` extension override if present (Tiptap 3 default works). |
| `src/features/rich-text/rich-text.ts` | `webapp/src/features/editor/document-shape.ts` | Stable-key serializer for JSONB equality. Critical — don't skip. |
| `src/features/rich-text/tiptap-to-markdown.ts` | `webapp/src/features/editor/tiptap-to-markdown.ts` | Hand-rolled GFM serializer. Port verbatim. |
| `src/features/rich-text/link-url.ts` | `webapp/src/features/editor/link-url.ts` | URL allow-list, autolink heuristics. |
| `src/features/rich-text/prepare-content.ts` | `webapp/src/features/editor/prepare-content.ts` | The markdown-inflate-to-JSON path; adapt to use the new Markdown→Tiptap adapter (§14.7). |

### 14.2 Document persistence

| Source | Target in clawrocket | Notes |
| --- | --- | --- |
| `supabase/migrations/00000000000004_documents.sql` (`documents` table shape) | new Postgres migration creating `talk_outputs` extensions + `talk_output_revisions` | Drop the project_view_id FK (drafts are top-level in Editorial Room). Keep optimistic-concurrency `version` integer + `expected_version` RPC pattern. |
| `src/features/documents/useDocumentHistory.ts` | `webapp/src/features/editor/useDraftHistory.ts` | 80-step ring buffer over `{title, contentJson}`. Direct port; rename interface fields from "document" to "draft". |
| `src/features/documents/documents.repository.ts` | `webapp/src/features/editor/drafts.repository.ts` | Heavy adaptation: replace Supabase RPC calls with clawrocket REST endpoints; drop Realtime subscription paths. |

### 14.3 Agent profile model

| Source | Target in clawrocket | Notes |
| --- | --- | --- |
| `supabase/migrations/*ai_personas*.sql` | new Postgres migration creating `agent_profiles` in clawrocket's repo (same dialect as rocketboard's source) | Schema ports cleanly: `(name, slug, provider, model, primary/fallback credential, system_prompt, focus_area, accent_color, is_enabled, is_default)`. Add `surface` enum column with values `'panel' | 'editorial' | 'global'` (rocketboard has `'notes' | 'project' | 'wiki' | 'card' | 'global'`; replace with our values). Do not call this table `ai_personas` in clawrocket; reserve `persona` for rocketorchestra audience/persona pages. |
| `src/features/ai/PersonaSwitcher.tsx` | `webapp/src/features/agents/AgentProfileSwitcher.tsx` | UI ports nearly verbatim; rename user-facing labels from persona to agent/profile where needed. |
| `src/features/ai/PersonaEditDialog.tsx` | `webapp/src/features/agents/AgentProfileEditDialog.tsx` | Same. |
| `src/features/ai/ApiKeyProviderCard.tsx` + BYOK Anthropic OAuth subscription flow | `webapp/src/features/credentials/ApiKeyProviderCard.tsx` | Adapt to fetch/store via rocketorchestra's `/api/distribute/fetch` instead of direct Supabase. The Anthropic OAuth subscription support is the unique value here — don't lose it. |

### 14.4 Streaming chat repository

| Source | Target in clawrocket | Notes |
| --- | --- | --- |
| `src/features/ai/ai-chat.repository.ts` (3-provider delta parsers: Anthropic, OpenAI, Google) | `webapp/src/features/talks/streaming-parsers.ts` | Port the parser logic only. The repository wrapping (Supabase, edge functions) doesn't apply — clawrocket already streams via SSE from its own backend. Use these parsers for the per-column rendering in Panel Talk and the side-sheet in Editorial Room. |

### 14.5 Kanban view (for Idea Backlog)

| Source | Target in clawrocket | Notes |
| --- | --- | --- |
| `src/features/shell/views/BoardView.tsx` (dnd-kit + TanStack Virtual) | `webapp/src/features/ideas/IdeaBacklogBoard.tsx` | Generic over `lane`/`task` types. Strip rocketboard-specific lane logic; instantiate with Idea cards. The drag-overlay + virtualization is the time-saver. |

### 14.5b ssr-core — vendored from syntheticalresearch

Joseph's syntheticalresearch repo (`/Users/josephkim/dev/syntheticalresearch/user-research/packages/ssr-core/`) contains the SSR (Semantic Similarity Rating) algorithm in a clean, framework-free TypeScript package. We vendor it as the implementation of one specific Scorer (`ssr_core_local`) — not as a wholesale dependency on the syntheticalresearch product.

| Source | Target in rocketorchestra | Notes |
| --- | --- | --- |
| `packages/ssr-core/src/types.ts` | `src/rocketorchestra/scorers/ssr/types.py` (translated to Pydantic) | ~140 LOC. Types only. |
| `packages/ssr-core/src/math.ts` | `src/rocketorchestra/scorers/ssr/math.py` | ~330 LOC. Cosine similarity, min-shift PMF normalization, Welch's t-test, Cohen's d, 95% CI. Translate from TS to Python; verify with parity tests against the original. |
| `packages/ssr-core/src/prompts.ts` | `src/rocketorchestra/scorers/ssr/prompts.py` | ~80 LOC. Persona-roleplay prompt template. |
| `packages/ssr-core/src/aggregation.ts` | `src/rocketorchestra/scorers/ssr/aggregation.py` | ~180 LOC. Per-persona × asset aggregation, significance computation. |
| (new file) | `src/rocketorchestra/scorers/ssr/executor.py` | ~150 LOC of new code. Replaces syntheticalresearch's Express+Supabase executor with a Cloud Run Job that calls Anthropic/OpenAI directly via the existing KMS-vaulted keys, caches reference-statement embeddings persistently, returns a `ScoreResult` that conforms to the Scorer interface (§15). |

**Why translate to Python rather than keep TS:** rocketorchestra is Python and the scoring runs as Cloud Run Jobs there. Keeping the two-file boundary (TS in clawrocket → Python in rocketorchestra) preserves the layer model.

**License compatibility:** the syntheticalresearch repo is Joseph's own (he wrote v1 of it); reuse is fine. Vendor with attribution comment at file top citing the upstream.

**Math gaps acknowledged in the upstream repo (****`docs/strategy/ssr-math-fixes.md`****):** for *relative* scoring (variant A vs. variant B in an iteration loop, where we only need monotonicity), these gaps don't matter. For *absolute* score interpretation (e.g., "this draft is a 3.7/5") they do. The Scorer interface marks the SSR scorer's output as `confidence: 'relative-only'` until the gaps are fixed in the upstream.

**Future:** once syntheticalresearch ships a hosted MCP, add `ssr_core_remote` as a separate Scorer that calls their MCP. Both can coexist; users pick which they want.

### 14.6 Google Docs integration (for Panel Talk output destination)

Rocketboard has a working Google Docs export integration. Panel Talk's "Output to Google Doc" destination uses the same surface.

| Source | Target in clawrocket | Notes |
| --- | --- | --- |
| Rocketboard's Google Docs write path (locate via `/Users/josephkim/dev/rocketboard/src/features/*` — likely `documents` or a `google-docs` module; verify before porting) | `webapp/src/features/output/google-docs-adapter.ts` | Adapt to use clawrocket's existing `user_google_credentials` table (already shipped) instead of rocketboard's Supabase-backed credential model. The OAuth scopes needed are `https://www.googleapis.com/auth/drive.file` and `https://www.googleapis.com/auth/documents`. Add new scopes to existing OAuth flow if not already granted. |
| (related) Rocketboard's Google Docs URL canonicalization helpers | `webapp/src/features/output/google-doc-url.ts` | Useful for displaying "Open in Google Docs" links in the Panel after output. |

Confirm the rocketboard module path before porting — the survey indicated `google-docs.ts` exists in `clawtalkgateway` (1,090 LOC), and rocketboard inherits some patterns from that lineage; the cleaner version may live in either repo. **Spend 30 min comparing both before picking the source.**

### 14.6 What we don't port

- **Document comments** (`document_comments` table). Document-scoped, not range-anchored. Editorial Room needs range-anchored suggestions — different shape. Skip.
- **Attachments** (`attachments` with single-parent FK). Rocketboard's attachment model is too narrow for Editorial Room's `Sources` (which needs RSS feeds, transcripts, web URLs as first-class). Build Sources fresh.
- **Document presence** (`document_presence`). Multi-user editing not in initial scope.
- **Wiki, notes, projects, initiatives, github, canvas, super-admin, billing, plans, releases.** All are rocketboard product surfaces orthogonal to Editorial Room. Don't drag them in.
- **Supabase realtime, edge functions, RLS policies, MCP server in ****`packages/mcp-server`****.** clawrocket has its own SSE, its own auth, its own MCP routes; don't mix.

### 14.7 Net-new even after the port

The port saves ~25 hours of editor foundation work but does NOT cover these — these stay as net-new work:

- **Markdown→Tiptap adapter.** Rocketboard has tiptap→markdown only. First verify the installed Tiptap Markdown support against official docs/package behavior and freeze the supported Markdown subset in `docs/EDITOR_SOURCE_MAP_SPIKE.md`. Use Tiptap's official Markdown support first behind `markdown-to-tiptap.ts`; add custom fallback code only for supported constructs that the official path cannot parse correctly. ~5 hours.
- **AI suggestion overlay.** ProseMirror `Decoration` + a `pendingSuggestions` plugin + accept/reject popover UI + range-tracking when document mutates. The actually-novel UX of Editorial Room. ~12 hours.
- **Voice-lock banner.** ~2 hours.
- **Inline mechanical scorer.** TypeScript port of `evaluate.py` rules; runs in browser. ~6 hours.
- **Range-anchored "Consult Panel"** side-sheet. ~4 hours.
- **Sources data model + ingestion adapters** (RSS, YouTube transcript, Google Doc, uploaded PDF, manual notes). ~15 hours.

### 14.8 Two cross-cutting decisions to make before porting

These are not technical questions — they're decisions Joseph should make explicitly because they shape the port scope:

1. **Storage canonical format.** Rocketboard stores `content_md` text canonically and inflates to Tiptap JSON in the client. For Editorial Room, recommend **Tiptap JSON canonical**, with markdown serialized on demand for export. Reason: range-anchored AI suggestions are unstable under markdown round-trips. This means the Markdown→Tiptap adapter (§14.7) is mandatory; the rocketboard storage shape gets inverted.
2. **Persistence backend (resolved in v9):** clawrocket migrates to Supabase Postgres in Phase Pre-1. Rocketboard's Supabase patterns now port directly into clawrocket — no SQLite-vs-Postgres dialect translation needed. Realtime is still excluded for v1 (single-user; no realtime collab needed yet); RLS and Postgres-specific features (JSONB, array types) port cleanly.

---

## 15. Scoring substrate — pluggable by design

The substrate ships scoring as a fully composable, configurable, swappable system. Default-invisible to casual users; full-control for power users. Implementation details:

### 15.1 The `Scorer` interface

```python
class Scorer(Protocol):
    id: str                          # 'autonovel_mechanical', 'autonovel_judge', 'ssr_core_local', 'llm_judge', 'syntheticalresearch_mcp', ...
    name: str                        # user-facing display name
    description: str                 # what it measures, when to use it
    cost_class: Literal['free', 'low', 'medium', 'high']
    speed_class: Literal['instant', 'fast', 'slow']
    parameters: ScorerParameterSchema   # both common (visible) and advanced (collapsed)

    def evaluate(
        input: ScorerInput,           # asset + optional personas[] + optional anchor_bundle
        params: dict,
    ) -> ScoreResult
```

`ScoreResult` is a structured payload:

```python
class ScoreResult:
    aggregate_score: float | None           # single number (or null if scorer is diagnostic-only)
    score_scale: tuple[float, float]        # e.g., (0, 10) or (1, 5) — needed for cross-scorer comparison
    score_direction: Literal['higher_better', 'lower_better']  # mechanical scorers are penalty-shaped
    per_dimension: dict[str, float]         # e.g., {voice_match: 8.2, hook: 7.5, payoff: 6.0}
    per_persona: dict[str, float] | None    # e.g., {ankit: 4.2, sarah: 3.6}
    confidence: Literal['absolute', 'relative-only', 'experimental']
    notes: list[str]                        # diagnostic strings (e.g., reader_panel disagreements)
    raw_data: dict                          # everything the UI might want to drill into
    metadata: ScoreRunMetadata              # cost, latency, model used, etc.
```

### 15.2 Pipelines — composing scorers

A `scoring_pipeline` page describes a named pipeline of scorers. Each scorer in the pipeline has a role:

- **`gate`** — fail-fast filter; if the scorer's result fails its threshold, later scorers don't run. Saves cost. Mechanical scorers (free, instant) make natural gates.
- **`score`** — produces a numeric score; the pipeline's `aggregation_rule` (weighted_mean / min / max / first / custom) combines all `score`-role scorers into a single aggregate.
- **`diagnostic`** — runs but doesn't aggregate. Output goes to `notes` and `per_dimension`. Reader-panel-style consensus belongs here.

The default GameMakers pipeline (seeded at install):

```
pipeline: gamemakers_default
  scorers:
    - { id: autonovel_mechanical,  role: gate,  threshold: { score: '<3.0', direction: 'penalty' } }
    - { id: autonovel_judge,       role: score, weight: 1.0 }
  aggregation_rule: weighted_mean
  on_gate_fail: 'short_circuit_with_diagnostic'
```

Users can clone, edit, or replace this. Audience-targeted iteration uses a different pipeline:

```
pipeline: audience_targeted_iteration
  scorers:
    - { id: autonovel_mechanical,  role: gate,  threshold: { score: '<3.5', direction: 'penalty' } }
    - { id: ssr_core_local,        role: score, weight: 1.0, params: { samples_per_response: 3, personas: [ankit, sarah] } }
    - { id: autonovel_judge,       role: diagnostic }
  aggregation_rule: min_across_personas    # don't lose any audience
```

### 15.3 The iteration_config

A `iteration_config` page parameterizes the loop runtime:

```yaml
max_attempts: 5
acceptance_criterion: 'aggregate_score >= 4.0'
plateau_check:
  after_min_cycles: 3
  delta_threshold: 0.3
on_plateau: 'keep_best_so_far'
on_max_attempts: 'keep_best_so_far'
significance_test: 'welch_t_p_lt_0.1'      # only used if scorer supports it (SSR does)
```

**Defaults ship per-channel.** Different channels have different cost / quality / time tradeoffs, so v1 ships three pre-configured defaults:

| Channel | Default `iteration_config` | Rationale |
| --- | --- | --- |
| `newsletter` | max_attempts: 5, threshold: 4.0, plateau_delta: 0.3, after_min_cycles: 3 | Mirrors autonovel's working values. The flagship channel — moderate cost, strong target. |
| `podcast_script` | max_attempts: 3, threshold: 3.8, plateau_delta: 0.4, after_min_cycles: 2 | Audio production cost is downstream-heavy (ElevenLabs); fewer iterations on the script. |
| `youtube_script` | max_attempts: 4, threshold: 4.0, plateau_delta: 0.3, after_min_cycles: 2 | Hook-and-retention sensitivity matters more than fine-grained prose; iteration on hook only. |

Numbers mirror autonovel's working values (`MAX_FOUNDATION_ITERS=20`, `PLATEAU_DELTA=0.3`, etc.) where they apply. Per-piece overrides are pages — same edit flow as everything else. Users who want one global config instead of per-channel can simply edit all three to the same values.

### 15.4 Three built-in scorers shipped at v1

**1. AutoNovel Mechanical** — `autonovel/evaluate.py:slop_score()` ported to TypeScript. Runs in the browser on every save; no LLM call. Returns a 0–10 *penalty* with per-dimension breakdown (tier1 banned words, tier2 clusters, tier3 fillers, em-dash density, sentence-length CV, transition-opener ratio, fiction-AI-tells, structural-tics). Word lists are retargeted from fiction tells to game-industry commentary tells. Common params: list of word-list pages to enforce. Advanced params: per-rule weight overrides.

**2. AutoNovel Judge** — `autonovel/evaluate.py` LLM judge ported to a Cloud Run Job. Sends asset + optional context to Opus (default) with rubric prompt. Returns 0–10 `overall_score` with structured weakness fields (`weakest_moment`, `voice_match`, `hook_quality`, `payoff`, etc.). Common params: rubric_page_ref. Advanced params: model_id, temperature, max_tokens.

**3. SSR** — implemented per `SYNTHETICALRESEARCH_API_CHANGES.md` (eight named capabilities including externalized prompt templates, first-class anchor sets, two-vendor enforcement, min-max + softmax with τ, asymmetric embedding, confidence scoring, batched interfaces, anchor authoring helper). Persona-Likert scoring with significance testing. Common params: persona_refs[], anchor_set_ref, samples_per_response (1–5, default 2). Advanced params: embedding_model, generation_model, temperature, retry_policy.

### 15.5 Three levels of user complexity

Match the "default invisibility, escape hatch to power" pattern:

**Level 0 — invisible.** User clicks "Score draft." System uses the user's default `scoring_pipeline` (initially `gamemakers_default`). One aggregate number rendered as a color band (red / yellow / green vs. baseline). User does not see scorers, configs, or pipelines.

**Level 1 — per-piece config.** User clicks "..." next to score, sees the active pipeline expanded: which scorers ran, what each contributed, what the threshold is. Toggles individual scorers on/off, swaps a different pipeline preset, raises/lowers threshold. Saves as override for this piece. No internals visible.

**Level 2 — Scorer Library.** Dedicated page in the substrate (Settings → Scorers). Users browse all available scorers (built-in + external + clones), edit parameters, clone-and-customize, save as named variants. Build new pipelines. Edit anchor_bundles. Edit iteration_configs.

### 15.6 What apps see vs. what apps don't

Apps see only the *runtime* slugs: `factory_score`, `factory_iterate_to_score`. They pass `(asset, scoring_pipeline_ref)` and get back a `ScoreResult`. They never know which scorers ran, which models were called, which embeddings were cached.

This means: changing a scorer, swapping a backend, adding a new built-in scorer, adopting the syntheticalresearch MCP later — none of these changes touch the app code. The pipeline page changes; the apps just keep calling `factory_score`.

### 15.7 What we resist

- **More than 3 scorers shipped at launch.** Decision burden kills adoption. AutoNovel Mechanical + AutoNovel Judge + SSR is the initial set. Add more once we know which patterns get used.
- **Auto-aggregating scores from incompatible scorers.** Mechanical penalty (lower = better) and SSR Likert (higher = better) live in different score spaces. The pipeline definition's `aggregation_rule` says how to combine them or whether to keep them separate. Never silently merge.
- **Hidden cost.** Every scorer run shows a cost preview before running. Power users override the warning; defaults trip an "expensive" warning when first using a paid scorer.

### 15.8 Methodological guardrails (binding)

Per `SYNTHETICALRESEARCH_API_CHANGES.md` §5: SSR scoring requires **two different vendor families** for the generation model and the embedding model. Same-vendor produces ~4× variance compression and invalidates distributional comparisons. The substrate enforces this at the SSR scorer's config-validation layer; same-vendor configurations error by default. A research-mode flag exists for benchmark/calibration runs but tags outputs with a methodology warning.

Other binding methodology rules from `SYNTHETICALRESEARCH_API_CHANGES.md`:
- Naturalistic, first-person, behavioral anchor language — formal jargon costs 29 pp accuracy.
- Asymmetric embedding (anchors as `document`, responses as `query`) when the embedding provider supports it (+6 pp).
- Min-max normalization → softmax with τ ≈ 0.15 (cross-validated).
- Confidence reporting via normalized Shannon entropy on the output distribution; well-calibrated against actual accuracy.

### 15.9 Optimization loop wraps the scoring substrate

The agentic optimization loop (`OPTIMIZATION_LOOP.md`) composes the scoring substrate into multi-iteration search rounds. Every optimization round is one or more passes through generation → mechanical-gate → rubric-judge → SSR-panel → counter-audience-critic, scored against the pipeline, ranked under the loop's optimization objective.

The loop uses the substrate; the substrate doesn't know about the loop. A `factory_score` call works the same whether it's invoked once by a user clicking "Score draft" or 480 times by a `run_optimization` round. Pluggability of scorers, pipelines, and iteration configs is what makes the loop possible without inventing app-local types.
- **Mystery scores.** When the UI shows an aggregate, hovering reveals which scorers contributed and at what weight. No black-box numbers.
- **Forced calibration claims.** SSR's "90% human correlation" comes from the paper, not from internal validation. Display SSR scores as `confidence: relative-only` until the upstream math gaps are fixed and we run our own calibration. Don't promise precision we haven't earned.

### 15.8 Rewrite modes — aggressive in generation, conservative in applying

Optimize and any AI-driven revision MUST be conservative in *applying* changes, even when the system is aggressive in *generating* candidates. Rule: **AI generation never overwrites the canonical draft.** Every generated variant lands as a new revision row; the user explicitly accepts to advance.

The substrate exposes five rewrite modes. Apps pick which to expose to which user — Editorial Room v1 ships Suggest-only and Optimize-loop; the others are phase-2.

| Mode | What runs | What it produces |
| --- | --- | --- |
| **Suggest only** | One scorer / reviewer pass | `Suggestion[]` rendered inline as accept/reject popovers; nothing is written until the user accepts |
| **Rewrite selected passage** | Targeted revision Skill on a user-selected range | A new revision with the rewritten passage; user can revert or accept |
| **Generate full-draft candidate** | `factory_draft` re-runs against the same outline + voice + claims | A new revision; previous revision preserved; user picks |
| **Optimize loop** | Iterate-to-score: revise → score → keep-best → repeat until threshold/plateau/max | Multiple new revisions; user picks any (typically the best-scoring) |
| **Autonomous-until-cap** | Same as Optimize loop, but runs unattended until threshold OR cost cap OR plateau hits | Background notification when complete; user reviews the result asynchronously |

In all five modes: every candidate is a new `talk_output_revision` row with its own diff, scoring breakdown, and cost. Revision history is lossless. The user can always revert to any prior revision.

---

## 16. Outbound exporters — context portability

Personal context is valuable precisely because it accumulates over time. That value evaporates if the user can only access it through this product. Lock-in by accidental design is a slow betrayal of the user's investment in their own context.

The substrate ships an exporter abstraction so users can mirror their context to wherever they want to keep it.

### 16.1 The `Exporter` interface

```python
class Exporter(Protocol):
    id: str                   # 'markdown_dump' | 'google_drive_folder' | 'obsidian_vault' | 'gbrain_mcp' | 'membase_mcp' | 'notion_api' | 'custom_mcp'
    name: str                 # user-facing display name
    capabilities: ExporterCapabilities  # which page types it supports, whether it does updates vs. only creates, idempotency model

    def push(page: Page) -> ExportResult
    def push_bulk(pages: list[Page]) -> ExportResult
    def health_check() -> HealthStatus
```

`ExportResult` is structured: `{ status, target_url, target_id, conflicts, warnings }`. Idempotent on `(exporter_id, page_slug)` so re-export doesn't duplicate.

### 16.2 v1 adapters (ship-by-default)

Three adapters that don't depend on external partnerships:

**1. Markdown dump.** Writes each page to a configured folder as `<slug>.md` with YAML frontmatter (page type, slug, last-updated, source URL). Lossless. Always works. Archival-grade. Default target: `~/Documents/rocketorchestra-context-mirror/`. The least exciting and most important adapter — it's the user's escape hatch.

**2. Google Drive folder.** Same shape as Markdown dump, but lands in a user-picked Drive folder. Reuses the existing `user_google_credentials` from clawrocket and the Drive scopes already granted. Each page becomes a Google Doc (auto-converted from markdown) or a `.md` file (user choice).

**3. Obsidian vault.** Filesystem write to a configured Obsidian vault path. Uses Obsidian conventions: tags (from page metadata), `[[wiki-style links]]` (when pages reference other pages), folder structure mirroring page-type. Useful for users who already live in Obsidian.

### 16.3 Future adapters (added when targets are ready)

| Adapter | Status |
| --- | --- |
| `gbrain_mcp` | If gbrain ships an import API or MCP, write a thin adapter. Same shape as v1. |
| `membase_mcp` | Same. |
| `notion_api` | Page-tree mirror via Notion API. Page type determines parent database. |
| `custom_mcp` | Generic adapter that calls any MCP `propose_update`-shaped tool. Lets users self-host arbitrary targets without the substrate having to know about them. |

### 16.4 What's in scope and what isn't

**In scope for v1:**
- One-way export. Source-of-truth is rocketorchestra; external targets are *reflections.*
- Per-target page-type filtering (e.g., "only export `domain` and `decision` pages to my work Obsidian vault").
- Ad-hoc "Export now" action and scheduled `context_export` cron (default daily at 04:00).
- Conflict warnings on re-export (e.g., "your Obsidian copy of `decision/auth-rewrite` was edited externally on 2026-04-25; overwrite?"). Default: warn, don't overwrite.

**Explicitly out of scope for v1:**
- **Two-way sync.** Two-way sync introduces conflict resolution as a product surface; it's its own product.
- **Live mirroring.** Updates happen on the cron tick or on user "Export now"; no realtime.
- **Cross-instance federation.** No "follow another user's context" features. Personal context is personal.

### 16.5 Why this matters for trust

A user with 6 months of accumulated context shouldn't fear that switching tools means losing it. The Markdown dump adapter is the proof: every page is recoverable as a portable plain-text artifact, automatically, on a schedule the user controls. This is the Bitwarden model — host it, but make exit trivial. The user owns their context whether or not they keep using this product.

---

## 17. Testing requirements

The substrate's behavioral guarantees are only real if they're enforced in code. This is the full architecture test matrix; each phase runs the subset that applies to the work it actually ships. Full Phase 1A includes the tests for context modes, incognito purge boundary, provider metadata, Skill idempotency, streaming parser ports, and Google Docs export.

**Full Phase 1A required tests:**
- Executable contract fixture/schema tests for `MarkdownSourceMap`, `Suggestion[]`, `run_skill`, and `get_run`; both repos validate the shared fixture corpus against the same versioned JSON Schemas under `docs/contracts/editorial-room/v0/`.
- Local proof-loop fixture test before cloud migration.
- Migration behavior parity gate comparing representative SQLite fixtures/routes against the Postgres port for IDs/foreign keys, ordering, defaults, nullability, JSON serialization, cascade behavior, transactions, idempotency, and error semantics.
- Cloud/Auth/RLS access-contract tests across localhost, Cloud Run URL, and custom-domain modes, including service-role bypass denial on normal request paths.
- Google OAuth survival/reconnect tests for Google Picker and Google Docs export after Supabase Auth migration.
- Backup/restore, rollback, and canary checks for the Cloud Run/Supabase cutover.
- Hot-path index/query-plan checks for draft load, revision history, pending suggestions, accept/reject/edit reads, and RLS ownership checks using large fixtures.
- DB connection budget check proving Cloud Run max instances × pool size plus rocketorchestra usage and reserved/admin capacity stays under the Supabase connection budget; transaction-pooler mode disables prepared statements if used.
- Shared Supabase drift gate in both repos.
- RLS/user-isolation matrix with anon, authenticated, and service-role credentials.
- Supabase Auth cookie, refresh-on-expired, cache/no-store, and CSRF tests in clawrocket.
- Migration tests for `context_mode`, `talk_kind`, `talk_output_revisions` including `markdown_source_map`, `talk_output_suggestions` including `source_map_refs`, and minimal `claims_ledger`.
- Provider/model metadata tests for unknown fields, stale metadata, implementation-time verification provenance, refresh playbook/command behavior, deprecated/missing model fallback, and UI states that never convert unknowns into confident policy claims.
- Scoped agent-token hash/scope/audit-denial tests: token stored only as a SHA-256 hash, allowed scopes limited to page-read/Skill-run/run-poll, and denied over-scope/tool requests fail closed with audit rows.
- `voice/gamemakers-2026` seed/stub existence check and minimal claims-ledger usability test: claims can be recorded with claim text, source, status, owning page/output, and timestamps for the proof-loop draft.
- Scheduler lease/idempotency tests for Skill runs and incognito purge cron.
- Incognito non-leakage and purge-boundary tests (rocketorchestra trigger → clawrocket purge endpoint; no direct cross-repo row deletion).
- BYOK lease/audit tests for the Skill call path.
- Streaming parser fixture tests for Anthropic, OpenAI, and Google parser ports.
- Rocketboard port preflight checks for unsupported imports, package/version deltas, storage/auth assumptions, CSS/UI dependencies, and Supabase/project-view bindings before copying donor code.
- Revision append/revert transaction tests, including concurrent accept/edit conflict behavior.
- Post-accept remaining-suggestion revalidation tests: accepting or editing one suggestion creates a new revision; every remaining suggestion from the same Skill run must re-resolve against the latest revision and prove the expected source span is unchanged, otherwise it is marked stale and requires a rerun.
- `MarkdownSourceMap` generation tests for paragraphs, headings, lists, links, code, tables, blockquotes, and hard breaks.
- Suggestion anchor resolver tests for current, stale, and ambiguous anchors using source-map refs first and quote/hash/context fallback only when unambiguous.
- Markdown snapshot + source-map determinism and JSON → Markdown → JSON round-trip tests for the supported subset.
- Unsupported Markdown fallback fixtures: unsupported constructs preserve visible text where possible, degrade predictably, and must get fixture coverage before special-case support is added.
- Mechanical scorer fixture-parity tests against the AutoNovel corpus, covering short drafts, long drafts, headings, lists, repeated phrases, hedges, weak verbs, code blocks, quotes, and near-threshold cases.
- Rocketorchestra MCP contract tests: `run_skill`/`get_run` appear in the manifest, dispatch correctly, enforce explicit scope checks, apply rate-limit categories, write capability audit rows, enforce payload caps for draft Markdown and `MarkdownSourceMap`, replay duplicate idempotency keys without enqueueing duplicate Cloud Run Jobs, return stale revision/hash results safely, and expose no clawrocket draft-write proxy tools (`list_drafts`, `get_draft`, `propose_revision`).
- Skill polling/idempotency/stale-result UI tests against fixture or live `run_skill`/`get_run`: backoff, `Retry-After`, abort-on-unmount/navigation, hidden-tab slowdown, recoverable timeout state, duplicate idempotency replay, and stale revision/hash result handling.
- Contract/eval tests for `factory_opus_review` and `factory_adv_cut` returning structurally valid source-map-anchored `Suggestion[]`.
- Destination-fidelity Google Docs/Substack export fixture tests for headings, lists, links, tables, code, blockquotes, hard breaks, and spacing using controlled credentials/mocks.
- One E2E proof-loop test: paste draft → run Skill → poll run → persist suggestions → accept/edit/reject → new revision → Google Docs + Substack-flavored Markdown export.
- Large-draft performance fixture (10k words + 100 suggestions) proving anchor resolution/scoring stay off the hot render path, including source-map/resolved-position caching by `revision_id + content_hash`, scorer scheduling via debounced idle work, `requestIdleCallback`, Web Worker, or save-only fallback, and decoration-map rebuild assertions that cursor movement, hover, unrelated editor state changes, and ordinary typing do not rebuild decorations unless the source revision/content hash/suggestion set changes.

**Full architecture matrix for later phases:**

**Schema construction tests (greenfield):**
- Schema-creation test for `talks` with `talk_kind` and `context_mode` columns.
- Schema-creation test for `talk_output_revisions` with `content_json` + `content_md_snapshot` + `markdown_source_map` columns.
- Schema-creation test for `agent_schedules` with idempotency columns.

**Privacy contracts (per §5.3 mode table):**
- Incognito Talks cannot enter the embedding index.
- Incognito Talks cannot be returned by `query_context`.
- Incognito Talks cannot trigger `propose_update` (capture suppressed).
- Incognito Talks are not returned by panel-list queries.
- Incognito Talks are not picked up by scheduled jobs (idea generation, voice drift, etc.).
- Incognito Talks are excluded from outbound exporters.
- Momentary Talk TTL purge runs and removes raw transcripts past 1-hour TTL.
- Incognito purge boundary: rocketorchestra trigger calls clawrocket purge endpoint; rocketorchestra never directly deletes clawrocket Talk rows.

**Multi-agent runtime:**
- SSE demux test: `responseGroupId` + `sequenceIndex` correctly route streaming chunks to the right column.
- Ordered mode: phase-N agent receives prior outputs as attributed user-context.
- Panel mode: independent SSE streams; one column erroring doesn't block others.
- Targeted-mode reply addresses only the specified agent.

**Editor:**
- Suggestion range anchors survive subsequent edits (anchoring fallback to quote/hash when ranges shift).
- Markdown snapshot generation from canonical document JSON is deterministic and idempotent.
- Round-trip JSON → markdown → JSON preserves structure for the supported subset.

**Skills and pipelines:**
- Each Skill has a contract test: fixture input produces a structurally valid output, regardless of provider response variation.
- Scoring pipeline contract tests: each scorer's `evaluate()` returns a `ScoreResult` matching the schema; aggregate-rule combiners produce expected values from per-scorer fixtures.
- Optimize loop stop conditions: threshold met, plateau detected, max attempts hit, max cost hit, user-stop — each path tested independently.
- Multi-agent proposal/debate Skills: fixture tests cover retained vs rejected outputs, cost/latency metadata, one-provider timeout/failure, over-budget status, and usable partial results.
- Claims ledger: provenance fields validated; an entry with `kind='sourced_fact'` requires `source_url` or `source_doc_ref`.

**Credentials and providers:**
- BYOK lease audit: every `/api/distribute/fetch` call writes an audit entry with the install-token identity and call context.
- Provider metadata staleness: badges show "may be stale" when `last_verified_at` > 60 days.
- Provider metadata unknowns: undocumented/null fields render as "unknown" and never as confident policy claims.
- Provider metadata maintenance: manual refresh updates `last_verified_at` and provenance without dropping unknown fields; deprecated/missing models fall back to unknown/stale UI while Skill dispatch remains available.

**Cron and idempotency:**
- A scheduled job fired twice with the same `(schedule_id, scheduled_for)` is a no-op the second time.
- Lease acquisition prevents concurrent fires.
- Manual replay of a failed run executes the run; replay of a successful run is a no-op.
- Cost-cap-per-run halts a job mid-execution when the cap is hit.

**Exports:**
- Markdown dump produces lossless round-trippable files for all page types.
- Google Drive adapter writes against the user's `user_google_credentials` and produces the expected document.
- Export profile snapshots: Substack-flavored Markdown, MDX, Google Doc, plain Markdown each render their format-specific shape.

**Skill contract regression:** when a Skill's prompt changes, its contract test must still pass against the canonical fixture. Prompt drift that breaks the contract is caught in CI, not in production.

---

*End of architecture spec.*
