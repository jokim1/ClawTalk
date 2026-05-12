# Editorial Room Contract

**Document type:** Cross-repo behavioral and schema contract for clawrocket and rocketorchestra
**Audience:** Both Claude Code sessions (clawrocket and rocketorchestra) plus the human reviewing them
**Last updated:** 2026-04-30
**Companion docs:**
- `01_ARCHITECTURE.md` — substrate spec
- `04_BUILD_PLAN.md` — engineering execution plan (§3 Phase 0p, §4 Phase Pre-1)
- `05_DESIGN_BRIEF.md` — UX brief
- `06_PHASE_1A_KICKOFF.md` — paste-ready Claude Code prompts
- `OPTIMIZATION_LOOP.md` — the agentic optimization loop these RPCs serve
- `SCHEMA_DEFINITION.md` — persona schema referenced from §3.5
- `THEME_TOPIC_POINTS_DEFINITION.md` — definitions referenced from §3.1–3.3
- `SYNTHETICALRESEARCH_API_CHANGES.md` — SSR API spec referenced from §6.6

> **Note on document state.** Planning-phase contract. The system is greenfield — schemas, RPC shapes, payload caps, and behavioral rules can change freely until both repos have implementations against this contract. The canonical machine contract is the JSON Schema bundle under `docs/contracts/editorial-room/*.schema.json`; this prose document is the human-readable specification of those schemas plus behavioral rules that aren't captured in JSON Schema.

---

## 0. Purpose and reading order

This contract defines every cross-repo data shape and behavioral rule that clawrocket and rocketorchestra both depend on. It is the single source of truth for:

- Schemas of objects that flow between the two repos (or that one repo writes and the other reads).
- Behavioral rules for replay, idempotency, staleness, and payload limits.
- Required fixture files that both repos test against.

The `schema_version` field on each cross-repo object exists as a CI gate during parallel implementation — it lets each repo verify it's reading payloads in the shape it expects. While the system is greenfield, schemas are revised in place (the doc and JSON Schema bundle update together).

**Reading order if you're new to this:**
1. Read `01_ARCHITECTURE.md §2` (page-type ontology) and §6.1 (editor storage) first.
2. Then read this contract end-to-end.
3. Then look at the JSON Schema files under `docs/contracts/editorial-room/`.
4. Then look at the fixture files under `tests/fixtures/editorial-room/` in either repo.

---

## 1. Ownership boundary

The contract is necessary because the same conversation about a Piece touches both repos. Ownership rules:

| Domain | Owned by | Notes |
|---|---|---|
| Editorial Piece state (per-piece transient) | clawrocket | `EditorialPiece.setup_state`, `setup_version`, `score_snapshots`, `discussion_sessions`, `point_note_blocks`, `talk_output_revisions`, `talk_output_suggestions` |
| Reusable context pages (portfolio-level) | rocketorchestra | `voice`, `persona`, `theme`, `topic`, `point`, `scoring_pipeline`, `anchor_bundle`, `iteration_config`, `claims_ledger` |
| Provider credentials | rocketorchestra | KMS-vaulted; clawrocket fetches per-call leases via `/api/distribute/fetch` |
| Skill execution | rocketorchestra | Cloud Run Jobs running `factory_*` runtimes |
| Editor / draft persistence | clawrocket | `talk_outputs` and revision history |
| LLM Discussion sessions | clawrocket | `talk_kind='editorial_scoped'`, hidden from Panel Talk lists |
| Authoring identity | shared `auth.users` | Both repos read the same Supabase Auth identity (post-Pre-1; in 0p, both use local fixture identity) |

**Hard rules:**
- rocketorchestra MUST NOT directly write or delete clawrocket-owned tables. Cross-repo mutations go through clawrocket's REST/MCP routes (e.g., the incognito-purge endpoint).
- clawrocket MUST NOT cache rocketorchestra page content outside the `score_snapshots` and `discussion_sessions` rows. Page reads go through MCP `get_page` / `query_context` at runtime.
- **Setup change ⇒ stale.** Any change to `EditorialPiece.setup_state` increments `setup_version`. All score_snapshots, proposal runs, and discussion_sessions tied to a prior `setup_version` are marked stale until recomputed.

---

## 2. Setup state (clawrocket-owned)

The Setup phase produces an `EditorialPiece.setup_state` object. This is the load-bearing context for every downstream stage.

### 2.1 SetupState shape

```typescript
type SetupState = {
  schema_version: "0";                    // contract version
  setup_version: number;                  // monotonic; increments on any change
  
  // Deliverable
  deliverable_type: "longform_post"      // post template (Phase 1A)
                  | "podcast_script"     // future
                  | "book_chapter"       // future
                  | "social_post"        // future
                  | "memo";              // future
  voice_page_slug: string;               // ref to rocketorchestra voice page (e.g., "voice/gamemakers-2026")
  length_target: {
    min_words: number;                   // e.g., 2000
    max_words: number;                   // e.g., 2500
  } | null;                              // null = no target
  destination: "substack_md"             // primary export target
             | "google_doc"
             | "plain_md"
             | "youtube_script"          // future
             | "other";
  
  // Audience: persona page slugs
  audience_persona_slugs: string[];      // ordered; min 1, max 3 initially
  
  // LLM agent profiles (clawrocket-owned)
  llm_room_agent_profile_ids: string[];  // ordered; min 2, max 6 initially
  
  // Scoring
  scoring_pipeline_slug: string;         // ref to rocketorchestra scoring_pipeline page
  
  // Metadata
  updated_at: string;                    // ISO timestamp
  updated_by_user_id: string;            // auth.users.id
};
```

### 2.2 Setup behavior rules

- **Required to enter Theme phase:** `voice_page_slug`, `audience_persona_slugs.length >= 1`, `llm_room_agent_profile_ids.length >= 2`, `scoring_pipeline_slug`.
- **Edit creates a new version:** any field change increments `setup_version`.
- **Stale propagation:** when `setup_version` changes, the system marks all dependent rows stale:
  - `score_snapshots WHERE setup_version != current` → stale; will be recomputed on next read or explicit refresh
  - `discussion_sessions WHERE setup_version != current` → marked stale; user is warned but session is preserved
  - Skill runs in flight that reference a prior `setup_version` complete normally; their results land as stale snapshots
- **No silent recompute:** stale rows are visible as stale in the UI; the user explicitly triggers recompute (or visits a surface that needs it and the UI auto-runs after the cost preview is shown).

### 2.3 JSON Schema location

`docs/contracts/editorial-room/v0/setup_state.schema.json`

---

## 3. Reusable context pages (rocketorchestra-owned)

These are pages with `kind` from a fixed enum. Each has `compiled_truth` (structured JSON) plus `timeline` (immutable evidence log) per the page model. Only the `compiled_truth` shape is contract-relevant here; the `timeline` shape is owned by rocketorchestra's page model.

### 3.1 `theme` page

Layer-1 page. Durable subject area.

```typescript
type ThemeCompiledTruth = {
  schema_version: "0";
  name: string;                          // "AI Impact on Game Dev"
  description: string;                   // 1-3 sentence prose
  status: "active" | "parked" | "archived";
  pinned: boolean;                       // for Theme Library sorting
  // Provenance (see §3.9). A theme may carry zero, one, or both:
  derived_from_pcp: boolean;             // true if generated by a Skill that consumed PCP context
  pcp_provenance: PcpProvenance | null;  // populated iff derived_from_pcp
  derived_from_panel: boolean;           // true if generated by a Skill that consumed panel seeds
  panel_provenance: PanelProvenance | null;  // populated iff derived_from_panel
  // Computed (not authored):
  topic_count: number | null;            // null if not yet computed
  last_activity_at: string | null;       // ISO timestamp of most recent topic update
};
```

Slug convention: `theme/<lowercase-hyphenated-name>` (e.g., `theme/ai-impact-on-game-dev`). Reserved slug: `theme/misc` for orphan topics.

**Default scope for PCP-derived themes:** when `derived_from_pcp = true`, the page is created with `scope: personal` and stays personal until the user explicitly promotes (see §3.9).

### 3.2 `topic` page

Layer-2 page. Specific angle within a theme.

```typescript
type TopicCompiledTruth = {
  schema_version: "0";
  parent_theme_slug: string;             // defaults to "theme/misc" if user doesn't pick
  working_title: string;                 // "The New Role of the AI PM"
  thesis: string;                        // one-line thesis (≤200 chars)
  why_now: string | null;                // optional: what makes this timely
  status: "active" | "parked" | "used" | "rejected";
  novelty_score: number | null;          // 0-1, computed against back_catalog
  novelty_score_basis: string | null;    // brief explanation if computed
  // Provenance (see §3.9). A topic may carry zero, one, or both:
  derived_from_pcp: boolean;
  pcp_provenance: PcpProvenance | null;
  derived_from_panel: boolean;
  panel_provenance: PanelProvenance | null;
  optimization_round_id: string | null;  // ULID of the optimization round that produced this topic, if any
  // Computed:
  point_count: number | null;
  last_activity_at: string | null;
};
```

Slug convention: `topic/<theme-slug-stripped>-<lowercase-hyphenated-title>`.

### 3.3 `point` page

Layer-3 page. Specific claim/argument within a topic.

```typescript
type PointCompiledTruth = {
  schema_version: "0";
  parent_topic_slug: string;             // single parent initially; multi-parent deferred
  claim: string;                         // one-line ("PMs become builders")
  rationale: string | null;              // free text; why this claim is true/interesting
  evidence: PointEvidence[];             // see 3.3.1
  status: "active" | "parked" | "merged" | "rejected";
  conviction: "low" | "medium" | "high"; // user's own confidence
  // Provenance (see §3.9). A point may carry zero, one, or both:
  derived_from_pcp: boolean;
  pcp_provenance: PcpProvenance | null;
  derived_from_panel: boolean;
  panel_provenance: PanelProvenance | null;
  optimization_round_id: string | null;  // ULID of the optimization round that produced this point, if any
  // Computed:
  last_activity_at: string | null;
};

type PointEvidence = {
  kind: "source_url"                     // external citation
      | "back_catalog_ref"               // ref to a published piece
      | "claim_ledger_ref"               // ref to claims_ledger entry
      | "quote";                         // inline quote with attribution
  url: string | null;
  ref_slug: string | null;               // for back_catalog_ref / claim_ledger_ref
  quote_text: string | null;
  quote_source: string | null;
  notes: string | null;
};
```

### 3.4 `voice` page

Already used by clawrocket and rocketorchestra. `compiled_truth` is the prose voice spec. The contract requires only that the page exists at the slug referenced in `SetupState.voice_page_slug`. Schema is loose; what matters is the prose content (which is loaded as system context for every Skill call).

### 3.5 `persona` page

Constructed audience target. `compiled_truth`:

```typescript
type PersonaCompiledTruth = {
  schema_version: "0";
  name: string;                          // "Ankit — solo indie dev"
  detailed_profile: string;              // 150-300 words, second-person, behavioral.
                                         // THIS is the binding SSR contract — it's the only
                                         // persona field SSR generation injects into the LLM
                                         // prompt. See SCHEMA_DEFINITION.md for canonical spec.
  cared_about_criteria: string[];        // bullet items
  triggers_to_close: string[];           // bullet items  
  triggers_to_share: string[];           // bullet items
  trust_signals: string[];               // bullet items
  voice_calibration: string | null;      // how this persona reacts to prose style
  // Optional structured metadata:
  archetype: string | null;              // e.g., "indie-dev-anxious"
  game_type_preference: string | null;
};
```

### 3.6 `scoring_pipeline` page

```typescript
type ScoringPipelineCompiledTruth = {
  schema_version: "0";
  slug: string;                          // "gamemakers_default"
  name: string;                          // "GameMakers Default"
  description: string;
  scorers: ScorerInPipeline[];           // ordered
  aggregation_rule: "weighted_mean" | "min" | "max" | "first" | "custom";
  on_gate_fail: "short_circuit_with_diagnostic" | "continue_with_warning";
};

type ScorerInPipeline = {
  scorer_id: string;                     // "autonovel_mechanical" | "autonovel_judge" | "ssr_core_local" | …
  role: "gate" | "score" | "diagnostic";
  weight: number | null;                 // for weighted_mean
  threshold: { score: string; direction: "score" | "penalty" } | null;  // for gates
  params: Record<string, unknown>;       // scorer-specific; see scorer_config schema
};
```

### 3.7 `iteration_config` page

```typescript
type IterationConfigCompiledTruth = {
  schema_version: "0";
  slug: string;                          // "newsletter_balanced" | …
  max_attempts: number;
  acceptance_criterion: string;          // e.g., "aggregate_score >= 4.0"
  plateau_check: { after_min_cycles: number; delta_threshold: number };
  on_plateau: "keep_best_so_far" | "discard";
  on_max_attempts: "keep_best_so_far" | "discard";
  cost_cap_usd: number | null;
};
```

### 3.8 `claims_ledger` page (per-Piece)

```typescript
type ClaimsLedgerCompiledTruth = {
  schema_version: "0";
  piece_id: string;                      // owning Piece (clawrocket FK)
  claims: ClaimEntry[];
};

type ClaimEntry = {
  id: string;                            // ULID
  kind: "sourced_fact" | "model_inference" | "counterargument" | "open_question" | "unsupported_claim" | "quote";
  statement: string;
  source_url: string | null;
  source_doc_ref: string | null;
  quote: string | null;
  timestamp: string | null;              // ISO; when the source was published if applicable
  confidence: "low" | "medium" | "high";
  approval_status: "pending" | "approved" | "rejected";
  evidence_log: EvidenceLogEntry[];
  last_verified_at: string | null;
};

type EvidenceLogEntry = {
  ts: string;
  actor: "user" | "agent";
  action: "added" | "approved" | "rejected" | "verified" | "edited";
  note: string | null;
};
```

### 3.9 Provenance shapes for derived pages

Two provenance shapes are defined: `PcpProvenance` (for PCP-derived pages) and `PanelProvenance` (for Panel-Talk-derived pages). Both follow the same pattern — explicit seed-event audit trail, default `scope: personal` until user promotes — and a `theme`/`topic`/`point` may carry zero, one, or both.

#### 3.9.1 `PcpProvenance`

Used by `theme`, `topic`, `point` pages when `derived_from_pcp = true`. Carries the seed events that produced the suggestion so the user can audit and decide on promotion.

```typescript
type PcpProvenance = {
  schema_version: "0";
  derived_at: string;                    // ISO timestamp the PCP-context was sampled
  source_skill: string;                  // e.g., "factory_theme_propose_optimize"
  source_run_id: string;                 // ULID of the run
  source_optimization_round_id: string | null;  // ULID of the round, if applicable
  pcp_window: { from: string; to: string };     // ISO interval the PCP context covered
  pcp_types_used: string[];              // subset of the 11 PCP types consumed
                                         // (e.g., ["calendar", "linear", "work_this_week"])
  seed_events: PcpSeedEvent[];           // the specific events surfaced as seeds; ≤10
  user_promoted_at: string | null;       // ISO timestamp when user changed scope from
                                         // 'personal' → 'organization' or 'global'; null
                                         // until promoted
  user_promoted_by_user_id: string | null;
};

type PcpSeedEvent = {
  pcp_type: string;                      // "calendar" | "linear" | "slack_dm" | "work_this_week" | …
  event_id: string;                      // canonical id within the PCP type
  timestamp: string;                     // ISO; when the event occurred
  summary: string;                       // ≤200 char human-readable summary surfaced in
                                         // the ProposalCard ("2026-04-22: meeting with
                                         // Hooded Horse re: indie deal terms")
  contributed_to: string[];              // which artifact-attributes this seed influenced
                                         // (e.g., ["theme.description", "theme.pov_clarity"])
};
```

**Privacy invariants:**
- PCP-derived pages default to `scope: personal` on creation. Promotion to `organization` or `global` is an explicit user action (`user_promoted_at` records it).
- `seed_events` are immutable once written. Editing the page does not change provenance — it bumps `last_activity_at` only.
- Cross-user visibility of PCP-derived pages requires explicit promotion. rocketorchestra MUST NOT serve PCP-derived pages with `scope: personal` to users other than the owning user, even if they are in the same organization.
- The `seed_events.summary` field is the only PCP content surfaced to the user. Raw PCP body content (calendar event description, full Slack message text, etc.) is NOT carried in `pcp_provenance` — only the summary line. Users wanting the raw event content navigate to the source PCP system.

#### 3.9.2 `PanelProvenance`

Used by `theme`, `topic`, `point` pages when `derived_from_panel = true`. Carries the panel turns, talking points, and dialectic results that seeded the page. See `02_HERO_APPLICATIONS.md` §2.7.5 for the Panel Talk dialectical-synthesis Skill that produces most panel-derived pages.

```typescript
type PanelProvenance = {
  schema_version: "0";
  derived_at: string;                    // ISO timestamp the panel context was sampled
  source_skill: string;                  // typically "factory_panel_dialectic" or
                                         // "factory_topic_optimize" / "factory_theme_propose_optimize"
                                         // when invoked with panel_seed
  source_run_id: string;                 // ULID of the run

  source_panel_id: string;               // the Panel Talk panel that produced the seeds
  source_turn_ids: string[];             // ≤ 20 specific turns that contributed
  source_talking_point_ids: string[];    // ≤ 10 talking points that contributed
  source_dialectic_result_ids: string[]; // ≤ 5 dialectic results that contributed

  seed_summary: string;                  // ≤ 500 char summary of what was promoted
                                         // (the synthesis text, or talking-point claim, or
                                         //  dialectic new_question — whichever drove the seed)

  user_promoted_at: string | null;       // ISO timestamp when user changed scope from
                                         // 'personal' → 'organization' or 'global'; null
                                         // until promoted
  user_promoted_by_user_id: string | null;
};
```

**Privacy invariants (parallel to PCP):**
- Panel-derived pages default to `scope: personal` on creation. Promotion is explicit user action.
- `source_turn_ids`, `source_talking_point_ids`, `source_dialectic_result_ids` are immutable once written.
- Cross-user visibility requires explicit promotion. Panel content from `incognito` panels MUST NEVER appear in `PanelProvenance` (capture is suppressed at panel level per existing privacy contract).
- `seed_summary` is the durable summary surfaced in the user's audit trail. Raw panel turn content lives in clawrocket panel storage; users wanting full transcript navigate via the `source_panel_id` link.

**A page may carry both provenance types.** A Theme generated by an optimize round that consumed both PCP context and panel seeds gets both `PcpProvenance` and `PanelProvenance` populated. The two are independent.

---

## 4. Per-Piece artifacts (clawrocket-owned)

### 4.1 `point_note_blocks`

Working notes scoped to a specific point within a Piece. Piece-local; promotion to durable `point` page evidence happens via explicit `propose_update`.

```typescript
type PointNoteBlock = {
  id: string;                            // ULID
  piece_id: string;
  point_ref: string;                     // slug of the point this note is about
  setup_version: number;                 // setup at time of writing
  type: "thought" | "claim" | "evidence" | "question" | "counterpoint";
  body_md: string;                       // freeform Markdown
  created_at: string;
  updated_at: string;
  created_by_user_id: string;
  promoted_to: { kind: "point" | "claim_ledger"; target_slug: string } | null;
};
```

Promotion payload (when user clicks "Promote to durable point"):

```typescript
type NotePromotionRequest = {
  schema_version: "0";
  note_id: string;
  promote_to: "point" | "claim_ledger";
  proposed_diff: { /* shape depends on target page kind */ };
  user_note: string | null;              // why this is being promoted
};
```

### 4.2 `score_snapshots`

Cached score results for objects (themes, topics, points) within a Piece.

```typescript
type ScoreSnapshot = {
  id: string;                            // ULID
  piece_id: string;
  setup_version: number;                 // staling key
  object_kind: "theme" | "topic" | "point";
  object_ref: string;                    // slug of the scored object
  object_content_hash: string;           // hash of the object's compiled_truth at score time
  scoring_pipeline_slug: string;
  selected_persona_slugs: string[];      // from setup_state.audience_persona_slugs
  result: ScoreResult;
  computed_at: string;
  cost_usd: number | null;
  is_stale: boolean;                     // true if setup_version or content_hash diverges
};
```

### 4.3 `ScoreResult` (returned by `factory_score` Skill)

```typescript
type ScoreResult = {
  schema_version: "0";
  scoring_pipeline_slug: string;
  aggregate_score: number | null;        // null if scorer is diagnostic-only or gated out
  score_scale: [number, number];         // e.g., [0, 10] or [1, 5]
  score_direction: "higher_better" | "lower_better";
  per_dimension: Record<string, number>; // e.g., { voice_match: 8.2, hook: 7.5 }
  per_persona: Record<string, number> | null;  // e.g., { ankit: 4.1, sarah: 3.6 }
  confidence: "absolute" | "relative-only" | "experimental";
  notes: string[];                       // diagnostic strings
  per_scorer_breakdown: ScorerOutput[];
  metadata: { cost_usd: number; latency_ms: number; models_used: string[] };
};

type ScorerOutput = {
  scorer_id: string;
  role: "gate" | "score" | "diagnostic";
  passed_gate: boolean | null;
  raw_score: number | null;
  scale: [number, number];
  notes: string[];
};
```

### 4.4 `discussion_sessions` (LLM Discussion panel)

Editorial-scoped sessions; NOT Panel Talk.

```typescript
type DiscussionSession = {
  id: string;                            // ULID
  piece_id: string;
  phase: "theme_topic" | "points" | "research" | "outline" | "draft" | "polish";
  active_object_kind: "theme" | "topic" | "point" | "draft" | "outline";
  active_object_ref: string;             // slug or revision_id
  active_object_content_hash: string;
  setup_version: number;                 // staling key
  talk_kind: "editorial_scoped";         // ALWAYS this; hidden from Panel Talk lists
  agent_profile_ids: string[];           // from setup_state.llm_room_agent_profile_ids
  turns: DiscussionTurn[];
  total_cost_usd: number;
  created_at: string;
  updated_at: string;
};

type DiscussionTurn = {
  id: string;
  user_message: string | null;           // null if turn is system-initiated (e.g., proposal action)
  initiator: "user" | "system";          // system means user clicked a proposal button
  initiated_action: ProposalActionKind | null;  // see 4.5
  agent_responses: AgentResponse[];
  proposals: ProposalCard[];             // structured proposals returned this turn
  retained_for_session: boolean;         // user-marked: "this turn produced something I kept"
  cost_usd: number;
  latency_ms: number;
  partial_provider_failures: string[];   // names of providers that failed; turn still completed with others
  created_at: string;
};

type AgentResponse = {
  agent_profile_id: string;
  provider_id: string;                   // e.g., "anthropic"
  model_id: string;                      // e.g., "claude-opus-4-7"
  text: string;                          // markdown
  citations: string[];                   // optional: source URLs the model emitted
  cost_usd: number;
  latency_ms: number;
  status: "completed" | "errored" | "timed_out";
  error_message: string | null;
};
```

### 4.5 `ProposalCard` (returned by Discussion turns or proposal Skills)

A discrete unit of agent-proposed change to a Piece-level object. The user accepts, edits, rejects, or parks each proposal individually.

```typescript
type ProposalCard = {
  id: string;                            // ULID
  schema_version: "0";
  source_run_id: string;                 // run that produced this proposal
  source_skill: string;                  // e.g., "factory_topic_propose", "factory_point_debate"
  proposal_kind: ProposalKind;
  target_object: { kind: "theme" | "topic" | "point" | "outline" | "draft"; ref: string | null };
  
  // The actual proposal:
  proposed_diff: ProposedDiff;
  rationale: string;                     // why the proposal makes sense
  agent_attribution: string[];           // which agent profile_ids contributed
  
  // User decision:
  status: "pending" | "accepted" | "edited" | "rejected" | "parked";
  user_edit: ProposedDiff | null;        // populated if status == 'edited'
  resolved_at: string | null;
  resolved_by_user_id: string | null;
  resolution_note: string | null;
};

type ProposalKind = 
    "create_theme"
  | "create_topic"
  | "create_point"
  | "edit_topic"
  | "edit_point"
  | "merge_points"
  | "park_point"
  | "promote_note_to_point"
  | "improve_toward_score"
  | "research_point"
  | "outline_section"
  | "outline_section_swap"
  | "outline_hook_choice";

type ProposedDiff = {
  // Discriminated by the parent ProposalCard.target_object.kind:
  // for theme: { name?, description?, status? }
  // for topic: { working_title?, thesis?, why_now?, status? }
  // for point: { claim?, rationale?, evidence_add?: PointEvidence[], evidence_remove?: string[], conviction?, status? }
  // for outline: { sections?: OutlineSection[]; hook_options?; payoff? }
  [field: string]: unknown;
};
```

### 4.6 `talk_output_revisions` (draft revisions)

Already specified in `01_ARCHITECTURE.md §6.1`. Shape repeated here for completeness:

```typescript
type TalkOutputRevision = {
  id: string;
  output_id: string;
  revision_number: number;
  content_json: TiptapDocument;          // canonical
  content_md_snapshot: string;           // derived
  markdown_source_map: MarkdownSourceMap;
  source_skill: "manual" | "draft" | "adv_cut" | "reader_panel" | "opus_review" | "optimize" | string;
  created_by_run_id: string | null;
  metrics_json: Record<string, unknown> | null;
  created_at: string;
};
```

### 4.7 `optimization_rounds`

A cached record of one optimization round (per `OPTIMIZATION_LOOP.md`). Owned by clawrocket because the round is scoped to a Piece (or to a Theme-search context), and its top-K is presented in the user's UI.

```typescript
type OptimizationRound = {
  id: string;                            // ULID
  schema_version: "0";
  
  // Identity
  piece_id: string | null;               // null for Theme-search rounds (no parent Piece)
  setup_version: number | null;          // null for Theme-search rounds
  target_kind: "theme" | "topic" | "point" | "outline" | "draft_polish" | "draft_fullsearch";
  parent_object: { kind: string; ref: string | null } | null;
                                         // e.g., { kind: "theme", ref: "theme/ai-impact-on-game-dev" }
                                         // null for top-level Theme search
  
  // Configuration (echoed from the run_optimization request)
  config: OptimizationConfig;            // see §6.6
  
  // Lifecycle
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "partial";
  convergence_reason: 
      "budget_hit" | "iteration_max" | "wallclock_cap"
    | "convergence_signal" | "user_stopped" | "empty_acceptable_pool"
    | "errored" | null;
  started_at: string;
  completed_at: string | null;
  
  // Results
  candidates_generated: number;
  candidates_accepted: number;
  acceptable_pool_ids: string[];         // ULIDs of all accepted candidates (full pool)
  top_k: TopKCandidate[];                // ranked top-K returned to user
  reject_reason_histogram: Record<string, number>;
                                         // e.g., { "specificity_lt_3": 18, "diversity_lt_0_4": 12, ... }
  
  // Cost
  cost_estimate_usd: number;             // pre-launch estimate
  cost_actual_usd: number;
  wallclock_actual_ms: number;
  
  // Provenance
  triggered_by_user_id: string;
  source_run_ids: string[];              // run_ids of every internal Skill call
};

type TopKCandidate = {
  rank: number;                          // 1-indexed
  rank_basis: "composite" | "cohort_reservation" | "novelty_reservation";
  candidate_id: string;                  // ULID; the candidate page (theme/topic/etc.) or revision
  candidate_kind: string;                // matches OptimizationRound.target_kind
  
  // Scoring breakdown (the user-facing ProposalCard inputs)
  rubric_scores: Record<string, RubricScore>;
                                         // keyed by axis: { specificity: {...}, disputability: {...}, ... }
  ssr_distributions: SsrPersonaResult[];
  counter_audience: CounterAudienceResult[] | null;  // for Drafts only
  comparable_history: string | null;     // human-readable comparison ("scores higher than 73% of...")
  diversity_position: string | null;     // "most novel of top-K" / "primary cohort" / etc.
  
  // Internal optimization values (NOT surfaced in UI, but stored for audit)
  composite_score: number;
  novelty_bonus: number;
  cohort_coverage_score: number;
};

type RubricScore = {
  axis: string;
  score: number;                         // typically 1-5
  scale: [number, number];
  gap: string | null;                    // "what's missing"
  fix: string | null;                    // "how to improve"
  weakest_quote: string | null;          // for Draft-level scoring
  note: string | null;
};

type SsrPersonaResult = {
  persona_slug: string;
  family: string;                        // "likelihood" | "value" | "appeal" | "satisfaction" | …
  pmf: number[];                         // probability mass function over the Likert scale
  scale: [number, number];               // e.g., [1, 5]
  mean: number;
  confidence: number;                    // normalized Shannon entropy [0,1]
  reasoning_quote: string | null;        // the synthetic free-text response
};

type CounterAudienceResult = {
  persona_slug: string;
  objections: CounterAudienceObjection[];
};

type CounterAudienceObjection = {
  quoted_line: string | null;            // the line in the draft being objected to
  objection: string;                     // the persona's objection
  severity: "minor" | "moderate" | "major";
};
```

**Companion table — `optimization_trials` (one row per candidate):**

The `optimization_rounds` row above preserves accepted/top-K results and reject-reason histograms. That's enough to display the round in the UI but **not enough to learn from or audit later** — you can't reconstruct what specific mutation strategies were tried, what gate each candidate failed, or which ancestor candidates produced which descendants.

For learning and audit, every candidate generated during a round is logged as an `optimization_trials` row:

```typescript
type OptimizationTrial = {
  id: string;                            // ULID
  schema_version: "0";
  round_id: string;                      // FK to optimization_rounds.id
  
  // Identity
  iteration: number;                     // which iteration of the round produced it
  candidate_index_in_iter: number;       // ordering within iteration
  candidate_kind: string;                // matches OptimizationRound.target_kind
  content_hash: string;                  // sha256 of the candidate's content
                                          // — same content across trials = same hash
  
  // Lineage (autoresearch-style)
  parent_trial_ids: string[];            // 0 for seed-iteration generation;
                                          // 1+ for mutation steps that descend from
                                          // earlier winners
  mutation_strategy: string | null;      // null for seed iteration; otherwise:
                                          //   "winner_carry_forward" | "sharpen" |
                                          //   "contrarian" | "narrow" | "broaden" |
                                          //   "cohort_targeted_<persona>" |
                                          //   "explicit_contrast" | …
  prompt_template_id: string;            // generation prompt template used
  prompt_template_version: string;       // template version (for reproducibility)
  
  // Gate results (the actual learning signal)
  rubric_scores: Record<string, RubricScore> | null;
                                          // null if rubric judgment was not run
                                          // (e.g., trial cancelled before scoring)
  rubric_gates_passed: Record<string, boolean>;
                                          // per-axis hard-gate pass/fail
  ssr_distributions: SsrPersonaResult[] | null;
                                          // null if SSR was not run (because rubric
                                          // gates failed and short-circuited it)
  ssr_gates_passed: Record<string, boolean>;
                                          // e.g., { ankit: true, ravi: false, mei: true }
  diversity_distance: number | null;     // cosine distance to prior acceptable pool
                                          // at the moment this trial was evaluated
  
  // Decision
  outcome: "accepted" | "rejected_rubric_gate" | "rejected_ssr_gate" 
         | "rejected_diversity" | "errored" | "cancelled";
  outcome_reason: string;                // human-readable; e.g.,
                                          //   "rubric.specificity=2 (< 3 min)"
                                          //   "ssr.likelihood.mean[ankit]=2.8 (< 3.5 min)"
                                          //   "diversity_distance=0.31 (< 0.4 min)"
  composite_score: number | null;        // null if rejected before scoring
                                          // populated for accepted trials
  
  // Cost / latency
  cost_usd: number;
  latency_ms: number;
  partial_provider_failures: string[];
  
  // Bookkeeping
  created_at: string;
};
```

This is the autoresearch innovation: the durable record is *every trial*, not just the winners. Use cases:
- **Learning.** Aggregate across rounds: which mutation strategies produce candidates that pass gates? Which gate axes reject the most? Are certain strategies cohort-specific?
- **Audit.** Reproduce a round's behavior exactly. Trace a winning Theme back through its mutation lineage to the seed candidate.
- **Debugging.** When a round produces unexpected results, trial-level data shows which gate or which mutation strategy went sideways.
- **Cost calibration.** Per-strategy cost actuals tune future cost estimates.

**Lifecycle behavior:**
- `optimization_rounds` rows are created on `run_optimization` request and updated as the round progresses.
- Status is polled by clawrocket via `get_optimization_round` (see §6.7).
- A round in status `running` can be cancelled via `cancel_optimization_round`. Cancellation completes the current candidate's gates, preserves `acceptable_pool_ids`, and sets `status = cancelled`, `convergence_reason = user_stopped`.
- Rounds are NEVER auto-deleted. Users can archive them, but the audit trail (cost actuals, reject histograms, top-K candidates) is preserved indefinitely for cost calibration and learning.
- **Setup change mid-round: the round runs to completion under the original `setup_version`.** Setup changes that arrive while a round is `running` do not abort the round, do not interrupt in-flight Skill calls, and do not mutate the round's stored config. The completed round's result is automatically marked stale (matching the standard staleness rules in §1) and the user is notified that they ran the round under a prior Setup. Cancellation by the user is the only way to stop a running round mid-flight.
- **Cancellation with partial scoring:** candidates whose rubric scoring was in-flight at cancel time are excluded from `partial_top_k`. Only candidates that completed all hard-gate scoring are eligible for the partial top-K. In-flight LLM calls already paid for are allowed to complete (since the cost is sunk) but their results are not used to admit new candidates after cancel.

### 4.8 `talk_output_suggestions`

```typescript
type TalkOutputSuggestion = {
  id: string;
  output_id: string;
  source_run_id: string;
  source_skill: string;
  schema_version: "0";
  target_revision_id: string;
  target_content_hash: string;
  source_map_refs: SourceMapRef[];
  markdown_range: { start: number; end: number };
  anchor_quote: string;
  anchor_content_hash: string;
  anchor_context_before: string | null;
  anchor_context_after: string | null;
  replacement_md: string | null;         // null = pure cut
  rationale: string;
  category: string;                      // see Suggestion type below
  status: "pending" | "accepted" | "rejected" | "edited" | "stale";
  resolved_at: string | null;
  resolved_by_user_id: string | null;
};
```

---

## 5. Editor anchor primitives

### 5.1 `MarkdownSourceMap`

```typescript
type MarkdownSourceMap = {
  schema_version: "0";
  revision_id: string;
  content_hash: string;
  blocks: SourceMapBlock[];
};

type SourceMapBlock = {
  block_id: string;                      // stable across save-cycles
  node_path: number[];                   // ProseMirror node path
  pm_range: { from: number; to: number };
  markdown_range: { start: number; end: number };
  normalized_text: string;
  text_hash: string;
  context_before: string;                // ≤80 chars
  context_after: string;                 // ≤80 chars
  spans?: SourceMapSpan[];               // optional initially; will become required when inline-mark suggestions need them
};

type SourceMapSpan = {
  span_id: string;
  pm_range: { from: number; to: number };
  markdown_range: { start: number; end: number };
  normalized_text: string;
  text_hash: string;
};
```

**Coverage rule:** block-level coverage is required for `paragraph`, `heading`, `bullet_list`, `ordered_list`, `code_block`, `blockquote`, `hard_break`. Span-level (`spans`) is optional initially. Span coverage will become required when inline-mark suggestions (`bold`, `italic`, `link`, `code`) ship.

### 5.2 `SourceMapRef`

```typescript
type SourceMapRef = {
  block_id: string;
  span_id: string | null;                // null = whole block
  text_hash: string;                     // for verification at resolve time
};
```

### 5.3 `Suggestion`

```typescript
type Suggestion = {
  schema_version: "0";
  revision_id: string;                   // the revision the Skill READ
  target_content_hash: string;           // hash of that revision's content_md_snapshot
  source_map_refs: SourceMapRef[];
  markdown_range: { start: number; end: number };
  anchor_quote: string;                  // exact text the range matched (fallback)
  anchor_content_hash: string;           // hash of source Markdown snapshot (fallback)
  anchor_context_before: string | null;
  anchor_context_after: string | null;
  replacement: string | null;            // null = pure cut
  rationale: string;
  category: SuggestionCategory;
  source_skill: string;
  source_run_id: string;
};

type SuggestionCategory = 
    "filler" | "repetition" | "hedge" | "weak_verb" | "tangent"  // adv_cut categories
  | "wording" | "structure" | "voice_drift"                      // opus_review categories
  | "missing_premise" | "weak_claim" | "unsupported_leap"        // argument_critic
  | "would_lose_persona" | "evidence_gap"                        // counter_audience
  | "claim_unbacked" | "claim_contradicts_ledger"                // claim_coverage
  | "other";
```

### 5.4 Suggestion resolution rules

When clawrocket receives `Suggestion[]` from a Skill run:

1. **Source-map first:** for each suggestion, attempt `source_map_refs[]` resolution against the `revision_id` the Skill named. If the source span resolves cleanly to ProseMirror positions in that revision, use those.
2. **Quote/hash fallback:** if source-map resolution fails (block_id missing, text_hash mismatch), attempt fallback via `anchor_quote` + `anchor_content_hash`. If unambiguous, use the resolved range.
3. **Stale otherwise:** if both fail, mark the suggestion `stale`. The user MUST rerun the Skill; clawrocket NEVER guesses.
4. **Accept revalidation:** when the user accepts/edits a suggestion, all OTHER pending suggestions from the SAME source_run_id must re-resolve against the NEW revision before accept is allowed. If their source span has shifted, mark them stale.

---

## 6. MCP RPC contract (run_skill / get_run)

### 6.1 `run_skill` input

```typescript
type RunSkillInput = {
  schema_version: "0";
  skill_slug: string;                    // "factory_opus_review", "factory_point_debate", …
  idempotency_key: string;               // (user_id, agent_id, skill_slug, target_revision_id, target_content_hash) hash
  
  // Identity
  piece_id: string;
  setup_version: number;
  
  // Inputs vary by skill but include:
  target_object: { kind: string; ref: string | null };
  target_revision_id: string | null;     // for draft skills
  target_content_hash: string | null;    // for draft skills
  
  // Skill-specific params (subset of allowed fields per skill)
  params: Record<string, unknown>;
  
  // Provider/model preferences
  agent_profile_ids: string[];           // for multi-LLM skills
  
  // Optional context (used by Theme/Topic propose Skills; null for everything else)
  context: SkillContext | null;
};

type SkillContext = {
  // PCP (personal-context primitive) windowing for Theme/Topic seeding
  pcp_window: { from: string; to: string } | null;   // ISO interval; null = no PCP
  pcp_types: string[] | null;            // subset of 11 PCP types; null = all available
                                         // (allowed: "calendar" | "linear" | "slack_dm"
                                         //  | "slack_channel" | "work_this_week"
                                         //  | "github_activity" | "asana" | "notion"
                                         //  | "browser_history_curated"
                                         //  | "voice_memo_transcripts" | "manual_notes")

  // Panel-Talk seeding (per 02_HERO_APPLICATIONS.md §2.7.5)
  panel_seed: PanelSeed | null;          // null = no panel-derived seeds

  seed_emphasis: "pcp" | "panel" | "media_diet" | "unmet_needs" | "mixed" | null;
                                         // null = mixed (default for Theme propose)
                                         // "panel" weights panel seeds heaviest

  // Existing-artifact exclusions (for novelty)
  exclude_existing_themes: boolean;      // default true for theme propose
  exclude_existing_topics: string[] | null;  // explicit topic refs to exclude
  
  // Competition check
  competition_check: boolean;            // default true; checks personas' media_diet
                                         // for Topic-overlap; surfaces in ProposalCard
};

type PanelSeed = {
  panel_id: string;                      // the source Panel Talk panel
  turn_ids: string[] | null;             // specific turns to consider; null = all
  talking_point_ids: string[] | null;    // saved talking points to seed from
  dialectic_result_ids: string[] | null; // saved dialectic outputs to seed from
  treat_as: "synthesis" | "thesis" | "antithesis" | "open_question";
                                         // how the Skill should weight the seed:
                                         // synthesis = prefer Themes/Topics that resolve the disagreement
                                         // thesis/antithesis = prefer Themes that take this side explicitly
                                         // open_question = prefer Themes that the dialectic's new_question opens
};
```

### 6.2 `run_skill` output

```typescript
type RunSkillOutput = {
  schema_version: "0";
  run_id: string;                        // ULID
  status: "queued" | "running" | "completed" | "failed";
  // For idempotency replays:
  is_replay: boolean;                    // true if this is the same run as a previous identical request
  result_url: string | null;             // present when status=completed; URL to fetch ScoreResult / Suggestion[] / ProposalCard[]
};
```

### 6.3 `get_run` input/output

```typescript
type GetRunInput = {
  schema_version: "0";
  run_id: string;
};

type GetRunOutput = {
  schema_version: "0";
  run_id: string;
  status: "queued" | "running" | "completed" | "failed" | "partial";
  progress: { current_step: string; pct: number } | null;
  result: SkillResult | null;            // present when status in {completed, partial}
  error: { code: string; message: string } | null;
  cost_so_far_usd: number;
  elapsed_ms: number;
  partial_provider_failures: string[];   // names of providers that errored but didn't kill the run
};

// Discriminated union by skill_slug:
type SkillResult = 
  | { kind: "score"; data: ScoreResult }
  | { kind: "suggestions"; data: Suggestion[] }
  | { kind: "proposals"; data: ProposalCard[] }
  | { kind: "discussion_turn"; data: DiscussionTurn }
  | { kind: "outline"; data: Outline }
  | { kind: "raw_text"; data: string };
```

### 6.4 Idempotency rules

- Same `idempotency_key` ⇒ same `run_id`. Replays return the existing run's status (queued/running/completed) without enqueueing a duplicate Cloud Run Job.
- The idempotency key is: `sha256(user_id|agent_id|skill_slug|target_revision_id|target_content_hash|setup_version|params_canonical_json)`. Both repos compute it deterministically.
- TTL: 24 hours. After TTL, the same key produces a fresh run.

### 6.5 Stale revision/hash behavior

- If `run_skill` receives a `target_revision_id` that no longer exists in clawrocket (deleted, archived), rocketorchestra returns `error.code = "revision_not_found"`.
- If `target_content_hash` mismatches the current hash of `target_revision_id`, rocketorchestra still runs the skill against the stale snapshot and returns the result with `metadata.target_was_stale = true`. clawrocket decides whether to surface the result (typically: yes if the user explicitly chose to score a prior revision; no with a "rerun against current" suggestion otherwise).

### 6.6 `run_optimization` (composes multiple skill calls server-side)

Optimization rounds are *not* a single skill — they wrap a multi-stage loop (generate → mutate → score → gate → rank) defined in `OPTIMIZATION_LOOP.md`. Wrapping the loop server-side keeps clawrocket's UI simple (one progress bar, one cost report) and centralizes the methodology guarantees (two-vendor enforcement, diversity bookkeeping, budget caps).

#### 6.6.1 `run_optimization` input

```typescript
type RunOptimizationInput = {
  schema_version: "0";
  
  // Idempotency
  idempotency_key: string;               // sha256(user_id|target_kind|parent_object_ref|setup_version|config_canonical_json)
  
  // Identity
  piece_id: string | null;               // null for Theme-search rounds
  setup_version: number | null;          // null for Theme-search rounds
  
  // Target
  target_kind: "theme" | "topic" | "point" | "outline" | "draft_polish" | "draft_fullsearch";
  parent_object: { kind: string; ref: string | null } | null;
                                         // e.g., { kind: "theme", ref: "theme/ai-impact-on-game-dev" }
                                         // for Topic optimization. null for top-level Theme search.
  
  // Configuration
  config: OptimizationConfig;
};

type OptimizationConfig = {
  schema_version: "0";
  
  // Persona panel
  // Defaults to SetupState.audience_persona_slugs for the parent Piece (per §2.1).
  // For Theme-search rounds (no parent Piece, piece_id=null), the user explicitly
  // selects from their full persona library at round-launch time.
  // Explicit override here lets the user temporarily widen the panel for one round
  // without changing Setup; the override is recorded in OptimizationRound.config
  // for audit but does NOT mutate SetupState.
  persona_slugs: string[];               // primary personas
  
  // Search shape
  n_candidates_per_iter: number;         // candidates generated per iteration
  n_iterations: number;                  // max iterations
  n_winners_carried: number;             // top-K winners that survive into iter 2+
                                         // (typically 5)
  n_ssr_samples: number;                 // SSR samples per (persona, candidate); default 8
  
  // Output
  top_k_returned: number;                // candidates returned to user
  
  // Diversity strategy
  diversity_strategy: "minimal" | "default" | "aggressive";
  diversity_min_distance: number;        // cosine distance threshold; default 0.4
                                         // (user-configurable per Settings → Optimization)
  cohort_targeted_subloops: boolean;     // run separate sub-loop per persona cohort
  contrast_mutation_fraction: number;    // 0.0-1.0; fraction of mutations using
                                         // explicit-contrast prompts (default 0.4)
  
  // Gates (config-overridable from per-target-kind defaults)
  gates: OptimizationGates;
  
  // Optimization weights
  objective_weights: ObjectiveWeights;
  
  // Cost / wallclock caps
  budget_usd: number;                    // hard cap; round aborts if projected > budget
  wallclock_cap_ms: number | null;       // optional; null = no wallclock cap
  
  // Convergence
  convergence_min_iters_for_signal: number; // default 2
  convergence_delta_threshold: number;       // default 0.05; min improvement to keep iterating
  
  // Optional skill context (for Theme/Topic; null otherwise)
  context: SkillContext | null;
  
  // Voice / scoring pipeline (resolved from setup_state when piece_id is set;
  // explicit when piece_id is null e.g. for Theme search)
  voice_slug: string;
  scoring_pipeline_slug: string;
};

type OptimizationGates = {
  rubric_min: Record<string, number>;    // per-axis hard gate; e.g., { specificity: 3, disputability: 3 }
  ssr_likelihood_min: number;            // per-primary-persona hard gate; default 3.5 for Topics
  diversity_min: number;                 // cosine distance from acceptable pool; default 0.4
  slop_penalty_max: number;              // max acceptable slop_penalty for Drafts; default 5.0
  ssr_value_min: number | null;          // per-primary-persona; null for Theme/Topic
};

type ObjectiveWeights = {
  ssr_likelihood_mean: number;           // typically 0.35
  ssr_value_mean: number;                // typically 0.20
  rubric_composite_mean: number;         // typically 0.30
  cohort_coverage: number;               // typically 0.05
  cohort_underservice_penalty: number;   // typically -0.05 (negative)
  novelty_bonus: number;                 // typically 0.15
};
```

#### 6.6.2 `run_optimization` output

```typescript
type RunOptimizationOutput = {
  schema_version: "0";
  round_id: string;                      // ULID of the OptimizationRound row in clawrocket
  status: "queued" | "running";          // returns immediately; clawrocket polls via get_optimization_round
  is_replay: boolean;                    // true if same idempotency key already in flight
  
  // Pre-launch estimates (populated immediately)
  cost_estimate_usd: number;
  cost_estimate_p10: number;             // 10th percentile of past similar runs
  cost_estimate_p90: number;             // 90th percentile
  wallclock_estimate_ms: number;
  
  // Confirmation requirements
  requires_double_confirm: boolean;      // true ONLY for target_kind = "draft_fullsearch"
                                         // every other target kind shows cost preview
                                         // at launch and proceeds without double-confirm.
                                         // Users constrain cost via budget_usd cap.
};
```

#### 6.6.3 Idempotency for optimization rounds

- Same `idempotency_key` ⇒ same `round_id`. The key is `sha256(user_id|target_kind|parent_object_ref|setup_version|config_canonical_json)`.
- Replays in `running` state return the existing round's progress.
- Replays in `completed` state return the existing top-K (no new run).
- TTL: 7 days (longer than `run_skill` because optimization rounds are expensive and users replay them deliberately).

#### 6.6.4 Two-vendor enforcement

Per `SYNTHETICALRESEARCH_API_CHANGES.md` §5: the optimization round MUST use different model families for generation and embedding. rocketorchestra rejects `run_optimization` requests where the resolved generation model and embedding model are from the same vendor with `error.code = "two_vendor_violation"`.

### 6.7 `get_optimization_round` and `cancel_optimization_round`

```typescript
type GetOptimizationRoundInput = {
  schema_version: "0";
  round_id: string;
};

type GetOptimizationRoundOutput = {
  schema_version: "0";
  round: OptimizationRound;              // see §4.7
  progress: OptimizationProgress | null; // populated while status=running
};

type OptimizationProgress = {
  current_iteration: number;             // 1-indexed
  candidates_generated_this_iter: number;
  candidates_accepted_so_far: number;
  cost_so_far_usd: number;
  cost_projected_usd: number;            // updated estimate based on rate
  current_phase: "generating" | "rubric_judging" | "ssr_scoring" 
               | "counter_audience" | "ranking" | "merging_subloops";
  partial_provider_failures: string[];   // surfaced for transparency
};

type CancelOptimizationRoundInput = {
  schema_version: "0";
  round_id: string;
  reason: string | null;
};

type CancelOptimizationRoundOutput = {
  schema_version: "0";
  round_id: string;
  status: "cancelled";
  acceptable_pool_preserved: boolean;    // always true; cancellation never throws away accepted candidates
  partial_top_k: TopKCandidate[];        // best-so-far top-K, ranked from accepted pool
};
```

**Cancellation semantics:**
- Cancellation completes the current candidate's gates. In-flight LLM calls are NOT aborted (they're already paid for) but no new ones are started.
- `acceptable_pool_ids` is preserved; the user can still see their best-so-far top-K via `partial_top_k`.
- A cancelled round is final — it cannot be resumed. To continue search, the user starts a new round (which will re-use idempotency cache for any candidates already scored within TTL).

---

## 7. Payload caps

Hard limits enforced by both repos:

| Field | Cap | Rationale |
|---|---|---|
| Markdown snapshot per revision | 500 KB | Substack pieces top out around 50 KB; 10× headroom |
| MarkdownSourceMap per revision | 1 MB | Larger because of normalized_text per block |
| Suggestion[] per Skill run | 200 suggestions | Adversarial Cut returns ~10-30; 200 is safety |
| Discussion turn agent response text | 200 KB | Long responses exist; 200 KB is generous |
| Persona detailed_profile | 4 KB | Canonical range is 150–300 words; cap is bytewise upper bound only |
| ProposalCard rationale | 4 KB | ~1000 words |
| Voice page compiled_truth | 16 KB | Voice specs can be detailed |

Repos MUST reject payloads exceeding these caps with `error.code = "payload_too_large"`.

---

## 8. Versioning rules

- **`schema_version`** appears on every contract object. Always `"0"` while the system is greenfield — it's a constant string acting as a CI gate so both repos verify they're reading payloads in the shape they expect. The string value will only ever change after first production deployment, when changing the shape carries a real cost; until then schemas are revised in place.
- **`setup_version`** is monotonic per-Piece. Increments on any SetupState change.
- **`content_hash`** is `sha256` of the canonical content (markdown snapshot for revisions; compiled_truth JSON for pages, computed with sorted keys).
- **`revision_id`** is a ULID. Every save creates a new revision.
- **Both repos MUST validate `schema_version` on every cross-repo payload and reject mismatches with `error.code = "schema_version_mismatch"`.**

---

## 9. Required fixtures

Both repos must include these fixtures and test against them in CI. Same fixture content in both repos (sync'd via the contract bundle).

### 9.1 Fixture files

Path: `tests/fixtures/editorial-room/v0/` in both repos.

| File | Purpose |
|---|---|
| `setup_state.minimal.json` | Smallest valid SetupState |
| `setup_state.full.json` | All optional fields populated |
| `theme.example.json` | Single example `theme` page compiled_truth |
| `topic.example.json` | Single example `topic` page (under the example theme) |
| `point.example.json` | Single example `point` page (under the example topic) |
| `point_with_evidence.example.json` | Point with all evidence kinds |
| `persona.ankit.json` | Full Ankit persona |
| `persona.sarah.json` | Full Sarah persona |
| `voice.gamemakers.json` | Voice page reference |
| `scoring_pipeline.gamemakers_default.json` | Default scoring pipeline |
| `claims_ledger.example.json` | Claims ledger with 3-5 entries across kinds |
| `point_note_blocks.example.json` | 3 notes of different types attached to one point |
| `score_snapshot.example.json` | One score snapshot tied to a topic |
| `discussion_session.example.json` | One discussion session with 2 turns and 1 proposal |
| `proposal_card.create_topic.json` | Proposal: create_topic |
| `proposal_card.improve_toward_score.json` | Proposal: improve_toward_score |
| `markdown_source_map.paragraphs.json` | Source map covering 5 paragraphs |
| `markdown_source_map.lists_tables.json` | Source map covering nested lists + a table |
| `suggestions.adv_cut.json` | 8 adversarial-cut suggestions across categories |
| `suggestions.opus_review.json` | 4 opus-review suggestions |
| `run_skill.input.score.json` | Sample run_skill input for a score skill |
| `run_skill.input.adv_cut.json` | Sample run_skill input for adv_cut |
| `get_run.output.completed.score.json` | Sample completed get_run for a score skill |
| `get_run.output.completed.suggestions.json` | Sample completed get_run for a suggestions skill |
| `get_run.output.partial.json` | Sample partial-provider-failure result |
| `pcp_provenance.example.json` | Full PCP provenance with 3 seed events across 2 PCP types |
| `theme.derived_from_pcp.json` | Theme with `derived_from_pcp=true` and full provenance |
| `optimization_config.topic_default.json` | Default config for Topic optimization |
| `optimization_config.draft_fullsearch.json` | Default config for full-search Draft optimization (Heart's Desire shape) |
| `optimization_round.completed.topic.json` | Completed Topic-optimize round with 14 acceptable, top-5 returned |
| `optimization_round.cancelled.json` | Cancelled round with partial_top_k populated |
| `run_optimization.input.topic.json` | Sample run_optimization input |
| `run_optimization.output.json` | Sample output with cost estimate and confirmation flags |
| `get_optimization_round.output.running.json` | Sample in-progress round with progress |
| `top_k_candidate.full.json` | Single top-K candidate with all scoring breakdowns |

### 9.2 Required tests against fixtures

Both repos must have:
- Schema validation tests: every fixture validates against the corresponding JSON Schema.
- Round-trip tests: serializing a fixture back to JSON produces byte-equivalent output (after key-sort normalization).
- Drift gate: CI fails if a fixture changes without a corresponding contract `schema_version` bump or a documented additive change.

---

## 10. JSON Schema bundle locations

Path: `docs/contracts/editorial-room/v0/`

| Schema file | Covers |
|---|---|
| `setup_state.schema.json` | SetupState |
| `theme.schema.json` | ThemeCompiledTruth |
| `topic.schema.json` | TopicCompiledTruth |
| `point.schema.json` | PointCompiledTruth + PointEvidence |
| `persona.schema.json` | PersonaCompiledTruth |
| `voice.schema.json` | Voice page (loose) |
| `scoring_pipeline.schema.json` | ScoringPipelineCompiledTruth + ScorerInPipeline |
| `iteration_config.schema.json` | IterationConfigCompiledTruth |
| `claims_ledger.schema.json` | ClaimsLedgerCompiledTruth + ClaimEntry |
| `point_note_block.schema.json` | PointNoteBlock |
| `score_snapshot.schema.json` | ScoreSnapshot |
| `score_result.schema.json` | ScoreResult + ScorerOutput |
| `discussion_session.schema.json` | DiscussionSession + DiscussionTurn + AgentResponse |
| `proposal_card.schema.json` | ProposalCard + ProposedDiff (oneOf by target_object.kind) |
| `talk_output_revision.schema.json` | TalkOutputRevision |
| `talk_output_suggestion.schema.json` | TalkOutputSuggestion |
| `markdown_source_map.schema.json` | MarkdownSourceMap + SourceMapBlock + SourceMapSpan |
| `suggestion.schema.json` | Suggestion + SourceMapRef |
| `run_skill.input.schema.json` | RunSkillInput |
| `run_skill.output.schema.json` | RunSkillOutput |
| `get_run.input.schema.json` | GetRunInput |
| `get_run.output.schema.json` | GetRunOutput + SkillResult discriminated union |
| `errors.schema.json` | Common error envelope (`{ code, message, details }`) |
| `pcp_provenance.schema.json` | PcpProvenance + PcpSeedEvent (§3.9) |
| `optimization_round.schema.json` | OptimizationRound + TopKCandidate + RubricScore + SsrPersonaResult + CounterAudienceResult (§4.7) |
| `optimization_config.schema.json` | OptimizationConfig + OptimizationGates + ObjectiveWeights (§6.6) |
| `run_optimization.input.schema.json` | RunOptimizationInput |
| `run_optimization.output.schema.json` | RunOptimizationOutput |
| `get_optimization_round.input.schema.json` | GetOptimizationRoundInput |
| `get_optimization_round.output.schema.json` | GetOptimizationRoundOutput + OptimizationProgress |
| `cancel_optimization_round.input.schema.json` | CancelOptimizationRoundInput |
| `cancel_optimization_round.output.schema.json` | CancelOptimizationRoundOutput |
| `skill_context.schema.json` | SkillContext (§6.1) |

Each schema MUST include:
- `$id` (canonical URL or path)
- `schema_version`
- `additionalProperties: false` unless explicitly documented otherwise
- All required fields explicitly listed
- Payload caps from §7 enforced via `maxLength` / `maxItems`

---

## 11. What we're not building yet

Each of these is a real product question. They're explicitly out of scope for the initial implementation; revisit when shipped behavior tells us we need them.

- **Multi-parent points** (a point belonging to multiple topics simultaneously). Single-parent for now.
- **Span-level source-map coverage** in MarkdownSourceMap. Block-level only at first; spans added when inline-mark suggestion targeting demands it.
- **Pieces that span multiple deliverable types** (e.g., one Piece producing both a blog post and a podcast). Single-deliverable per Piece.
- **Cross-Piece reuse of `ProposalCard`** (e.g., "this proposal applies to multiple pieces"). Per-Piece only.
- **Real-time collaborative editing** of any object. Single-user only.
- **Outline page schema** (the structured outline artifact). Initial implementation uses fixtures; full contract added once authoring patterns settle.
- **Cross-publication PCP context.** Only the user owning the publication contributes PCP. Shared org-level PCP feeds are deferred.
- **Auto-promotion of PCP-derived pages.** PCP-derived pages stay `scope: personal` until explicit user action — no silent promotion paths.
- **Resumable optimization rounds.** Cancelled rounds are final. Resume-from-checkpoint is deferred until cost data shows it's worth the implementation complexity.
- **Cross-round acceptable_pool reuse.** Each `run_optimization` starts fresh. Sharing acceptable pools across rounds is deferred.
- **Persona-panel optimization** (system-suggested changes to persona definitions based on observed under-fit). Persona authoring stays manual until we have enough optimization-round history to detect under-fit reliably.

---

*End of contract.*
