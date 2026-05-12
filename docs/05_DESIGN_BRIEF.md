# Design Brief — Editorial Room Phase 1A Layered Workflow

**Document type:** Design brief — paste-ready for Claude Design or implementation planning  
**Last updated:** 2026-04-30
**Audience:** designer and engineer iterating on the Phase 1A user-facing surface  

Phase 1A is a setup-first, portfolio-aware workflow: conceptually **Setup → Theme → Topic → Points → Research → Outline → Draft → Polish → Ship**, with the **visible UI consolidated into 6 phase pills**: `01 SETUP | 02 THEME + TOPICS | 03 POINTS + OUTLINE | 04 DRAFT | 05 POLISH | 06 SHIP`. Every layer surfaces agentic optimization rounds (per `OPTIMIZATION_LOOP.md`) as top-K candidate lists for the user to pick from.

**Note on document state.** This design brief is the high-level intent and rationale. **The canonical screen specs now live in `design/01_setup.md` through `design/04_draft.md`** — those files are the authoritative implementation contract. This brief is preserved for historical context and design rationale; if it conflicts with the `design/*.md` specs, the specs win.

**Companion docs:**
- **`design/01_setup.md`** — Setup screen (S2 layout) — **canonical UI spec**
- **`design/02_theme_topics.md`** — combined Theme + Topics workspace (B++ four-column) — **canonical UI spec**
- **`design/03_points_outline.md`** — combined Points + Outline workspace (PO5+ chevron-toggleable) — **canonical UI spec**
- **`design/04_draft.md`** — Draft editor with unified `+ OPTIMIZE` (D3++) — **canonical UI spec**
- `01_ARCHITECTURE.md` — substrate spec
- `02_HERO_APPLICATIONS.md` — full app spec
- `04_BUILD_PLAN.md` — engineering execution plan
- `06_PHASE_1A_KICKOFF.md` — implementation kickoff prompt
- `OPTIMIZATION_LOOP.md` — optimization round mechanics surfaced in the UI
- `THEME_TOPIC_POINTS_DEFINITION.md` — definitions of layers the workflow operates on
- `SCHEMA_DEFINITION.md` — persona schema for Setup-stage panel selection

> **Note on document state.** Planning-phase brief. UX patterns, screen flows, and component specifications can change freely until implementation begins.

---

## 0. What we're designing right now

The **Phase 1A Editorial Room workflow** for producing GameMakers content from structured thinking, not just polishing a draft.

The product flow is:

```
Setup → Theme → Topic → Points → Research → Outline → Draft → Polish → Ship
```

The first design target is the early workflow spine:

1. **Setup** — choose deliverable, voice/length/destination, audience personas, LLM room agent profiles, and scoring system.
2. **Theme / Topic workspace** — three panels: Themes, Topics, and reusable LLM Discussion.
3. **Points workspace** — three panels: Points, Notes for the active point, and reusable LLM Discussion.
4. **Later phases** — Research, Outline, Draft, Polish, and Ship inherit the same setup context and portfolio artifacts.

The core design decision from the review: **the right-side LLM Discussion panel is a reusable thinking tool across Theme, Topic, and Points.** It is not a generic bottom chatbot and it is not Panel Talk. It is a scoped discussion room attached to the active object.

Runtime rule: LLM Discussion is stored as a clawrocket-owned scoped discussion session, not as a normal saved Panel Talk. Each session is attached to `piece_id`, phase, active object ref, object content hash, and `setup_version`, with `talk_kind='editorial_scoped'`. It can reuse clawrocket Talk/run infrastructure for fan-out and streaming, but it is hidden from normal Panel Talk lists by default. Later, the user can explicitly promote/export a useful discussion.

Out of scope for Phase 1A:
- Direct Substack publishing. Phase 1A exports Substack-ready Markdown.
- Persistent Panel Talk sessions. The LLM Discussion panel can promote out later, but should not silently create Panel Talk state.
- Full Optimize Watcher automation. Phase 1A can expose score-improvement actions on themes/topics/points, but long autonomous loops are later unless explicitly built.
- Multi-user collaboration.
- Project-wide `DESIGN.md`. This brief remains the design source of truth until visual language stabilizes.

---

## 1. User goal for Phase 1A

> *"Help me turn a durable theme into a scored topic, a set of strong points, a usable outline, and finally a publishable GameMakers piece, with my voice intact and a clear audience target."*

Joseph is not asking the tool to write from nothing. The system should help him choose the right target, sharpen the argument portfolio, use LLMs as discussants, score what is promising, and preserve enough structure that the draft and outline stages have real inputs.

---

## 2. Information architecture

### 2.1 Phase strip

Use a compact top phase strip with **6 pills** (canonical: `design/01_setup.md` §2 + §4):

```
01 SETUP | 02 THEME + TOPICS | 03 POINTS + OUTLINE | 04 DRAFT | 05 POLISH | 06 SHIP
```

Rules:
- Target height: 44-52px.
- Active pill gets strongest treatment (dark fill + light text); inactive pills muted with status text.
- The phase strip is navigation and orientation, not a wizard checklist.
- Do not place audience or agent multiselect controls inside the phase strip.
- Conceptually the workflow has 9 stages (Setup → Theme → Topic → Points → Research → Outline → Draft → Polish → Ship) but Theme+Topic and Points+Outline are each consolidated into one screen because the user's actual workflow flows through them together. Sources/Research is a tab inside the Points + Outline workspace.

Directly below the phase strip, use a quieter **setup context bar**:

```
Longform Post · Voice: gamemakers-2026 · Audience: 2 · Agents: 4 · Score: GameMakers Default
```

Each item is clickable and returns to the relevant Setup section. This keeps the phase strip clean while making the scoring/audience/agent context visible.

### 2.2 Setup phase

Setup defines what "good" means before the user creates or scores themes/topics/points.

Required sections:

| Setup area | Behavior | Notes |
|---|---|---|
| Deliverable | Select one output type: Longform Post, Podcast Script, Book, Social Post, Memo, etc. | Deliverable is an output type, not a bundle of sub-deliverables. |
| Deliverable subfields | Voice, length target, destination/export target. | Example: `gamemakers-2026`, `2,000-2,500 words`, `Substack Markdown`. |
| Audience | `+ Add Audience` from a persona library. | Personas are built elsewhere; Setup selects existing personas. Do not show a giant multi-select by default. |
| LLM Room | `+ Add Agent` from an agent-profile library. | Agents are pre-defined profiles, not anonymous chips. |
| Scoring System | Select a scoring pipeline: GameMakers Default, AutoNovel, SSR, Custom Pipeline. | This drives scores shown later on themes/topics/points. |

Persistence rule: Setup state is owned by clawrocket on the Editorial Piece. It stores deliverable type, voice/length/destination, selected audience persona refs, selected LLM agent profile refs, scoring pipeline ref, and `setup_version`. The referenced libraries remain where they belong: audience personas and scoring pipeline pages in rocketorchestra; LLM agent profiles in clawrocket. Changing Setup increments `setup_version` and marks dependent scores, proposal runs, and draft brief snapshots stale until recomputed.

LLM agent profiles must display more than a name. Minimum agent card/profile row:

| Field | Example |
|---|---|
| Avatar | profile image or generated initials if no image exists |
| Name | `Opus47` |
| Short description | `Expert strategist` |
| Role | `Skeptic`, `Editor`, `Market Analyst`, etc. |
| Model/provider | read from server config, not hardcoded |
| Cost/status | available when known; render `unknown` if stale |

### 2.3 Theme / Topic workspace

Use exactly three primary panels on desktop:

```
┌───────────────┬──────────────────────────┬──────────────────────┐
│ Themes        │ Topics                   │ LLM Discussion       │
│ + Theme       │ + Topic        SELECT    │ Agent profiles       │
│ theme cards   │ topic cards + scores     │ scoped chat          │
└───────────────┴──────────────────────────┴──────────────────────┘
```

Rules:
- `+ Theme` belongs only in the Themes panel.
- `+ Topic` belongs only in the Topics panel.
- Selecting a theme filters the center Topics panel.
- Selecting a topic enables `SELECT`, which moves to Points.
- The right LLM Discussion panel discusses the active theme or topic.
- The right LLM Discussion panel binds to the active object. Switching objects loads that object's scoped discussion session or starts an empty one.
- Theme and Topic cards show score context derived from Setup: aggregate score plus selected audience/persona scores when available.
- Audience score visibility can be filtered from a compact control inside the card area or score popover, not the phase strip.

Card anatomy:

| Theme card | Topic card |
|---|---|
| Name | Working title |
| One-line description | One-line thesis |
| Topic count | Point count |
| Aggregate score | Aggregate score |
| Per-persona score badges | Per-persona score badges |
| Last activity | Novelty / confidence |

### 2.4 Points workspace

Use the same three-panel logic:

```
┌───────────────┬──────────────────────────┬──────────────────────┐
│ Points        │ Notes for active point   │ LLM Discussion       │
│ + Point       │ freeform typed blocks    │ Agent profiles       │
│ point cards   │ Add note                 │ Add to Notes         │
└───────────────┴──────────────────────────┴──────────────────────┘
```

Rules:
- One point is visibly active.
- The Notes panel title must reference the active point, e.g. `Notes for PMs become builders`.
- Notes should not be a rigid form with only `Claim / Rationale / Evidence / Questions` fields.
- Use **freeform note blocks with lightweight types**: Thought, Claim, Evidence, Question, Counterpoint.
- Notes are clawrocket-owned `point_note_blocks` scoped to Piece, point ref, and `setup_version`. They are fast working notes, not immediate context writes.
- LLMs should receive both the freeform note text and the type metadata. Humans get messy thinking; the system gets enough structure to build outlines and drafts.
- `Add to Notes` from LLM Discussion creates a new note block attached to the active point, never an unscoped global note.
- Durable promotion is explicit: a note can be promoted to the rocketorchestra `point` page or `claims_ledger` through `propose_update` only when the user chooses.

Point card anatomy:
- Claim/title
- Conviction: low / medium / high
- Aggregate score
- Per-persona score badges when available
- Evidence count
- Open question count
- Status: active / parked / promoted / rejected / merged

### 2.5 Score-improvement actions

Themes, topics, and points can be improved toward the selected scoring system, but the user must explicitly invoke the work.

Score persistence rule: visible theme/topic/point scores are clawrocket-owned `score_snapshots`, not fields on the reusable rocketorchestra pages. Each snapshot is keyed by Piece, `setup_version`, object ref, object content hash, scoring pipeline ref, and selected persona refs. Rocketorchestra owns scorer configuration and Skill execution, returns `ScoreResult`, and clawrocket stores the snapshot used by the UI. When Setup or the scored object changes, affected snapshots render stale until recomputed.

Allowed actions split into two modes (per `OPTIMIZATION_LOOP.md` §5b):

**Single-call cheap mode** (5–15 sec, ~$0.10–$0.50): the path of least resistance. Used for quick ideation when the user is doing most of the editorial thinking. Returns 3–8 candidates from one pass with rubric judgment only — no SSR persona panel, no diversity gates, no counter-audience. Results render as `ProposalCard`s the user accepts/edits/rejects/parks individually.

| Object | Single-call action | Output |
|---|---|---|
| Theme | `Propose themes` | 3–5 candidate themes with rubric breakdown |
| Topic | `Propose topics` | 3–5 candidate topics with thesis, why-now, novelty score |
| Topic | `Improve toward score` | rewritten thesis / sharper angle options |
| Point | `Propose points` (multi-LLM) | 4–8 candidate points from N agents (different models propose different points) |
| Point | `Research this point` | evidence, counter-evidence, source candidates |
| Point | `Find counterpoints` | objections and skeptic notes |

**Optimization-round mode** (1–10 min, ~$2–$5 per round for Topic): the differentiated product. Multi-iteration runs returning top-K candidates with full rubric breakdown, per-persona SSR distributions, diversity-reserved slots, and reject-reason reporting. See §3.X below for the four-state UX.

| Object | Optimization-round action | Output |
|---|---|---|
| Theme | `Optimize themes` (with optional PCP context seed) | top-10 candidates with rubric + per-persona SSR + `PcpProvenance` when PCP-seeded |
| Topic | `Optimize topics` | top-5 with rubric + SSR + cohort-targeted sub-loops |
| Point | `Optimize points` | top-8 with 2 counter-argument-Points reserved |
| Outline | `Optimize outline` | top-3 outline structures with combinatorial Point arrangements |
| Draft (Polish) | `Optimize polish` (targeted-axis, default) | top-3 paragraph-scoped fixes for the lowest-scoring axis |
| Draft (Full-search) | `Optimize draft` (opt-in, mandatory double-confirm) | top-K full-Draft regenerations; for game scripts and high-stakes long-form |

Design rule: never auto-rewrite or auto-promote. Proposed improvements appear as cards, notes, or suggestions that the user accepts, rejects, edits, or parks. The optimization round is a search; the user is the decider.

### 2.6 Draft, Polish, and Ship

The Draft editor remains a three-pane workspace, but it is downstream of Setup, Theme, Topic, Points, and Outline.

Draft layout:

```
┌────────────────────┬────────────────────────────────┬────────────────────┐
│  Production Brief  │       Tiptap Editor             │   Skills Rail      │
│  setup + portfolio │       prose surface             │   scoped workers   │
└────────────────────┴────────────────────────────────┴────────────────────┘
```

Rules:
- Production Brief shows Deliverable, Voice, Audience, Scoring System, Theme, Topic, selected Points, Outline, Claims, and Sources.
- Draft mode Skills should prioritize argument and coverage: Argument Critic, Counter-Audience, Claim Coverage.
- Polish mode Skills should prioritize line-level editing: Adversarial Cut, Opus Review.
- Suggestion popovers remain atomic: Accept, Reject, Edit. No `Apply all`.
- Ship provides copy/download/export, with Substack-flavored Markdown as the primary Phase 1A destination.

---

## 3. Interaction state coverage

Every visible feature needs explicit states. Empty states are product surfaces, not placeholders.

| Feature | Loading | Empty | Error | Success | Partial / degraded |
|---|---|---|---|---|---|
| Setup | Skeleton rows for deliverable/audience/agents/scoring. | Default deliverable selected; Audience and LLM Room show `+ Add` actions. | Failed library load stays inside that section with retry. | Setup context bar is populated and user can continue to Themes. | Missing scoring metadata renders `unknown`, never guessed. |
| Phase strip | Skeleton phase labels only if Piece state is loading. | New Piece starts at Setup. | Inline retry; keep current phase usable if content loaded. | Active phase and available next action are visible. | Optional/future phases show muted state, not hidden. |
| Setup context bar | Small skeleton chips. | Shows only completed fields; missing fields link back to Setup. | Failed field shows inline warning. | Deliverable, voice, audience count, agents count, and scoring system visible. | Stale provider/scoring data marked stale. |
| Themes panel | Card skeletons. | Warm empty state: `Create your first theme` plus `+ Theme`. | Error inside panel with retry. | Theme cards visible with topic counts and scores. | Scores can show pending/unknown without blocking selection. |
| Topics panel | Card skeletons scoped to active theme. | `No topics yet` with `+ Topic` and `Find stronger topics`. | Error inside panel with retry. | Topic cards visible with score badges and SELECT action. | Some persona scores missing; aggregate still shown if valid. |
| Points panel | Card skeletons scoped to selected topic. | `No points yet` with `+ Point` and `Propose points`. | Error inside panel with retry. | Active point highlighted; Notes panel is scoped to it. | Scores/evidence counts can lag with stale timestamp. |
| Notes panel | Skeleton note blocks for active point. | Freeform empty note area plus typed note buttons. | Failed save stays in Notes panel; local text preserved. | Note blocks saved with type metadata. | Unsynced notes are marked local until saved. |
| LLM Discussion | Agent profile skeletons, then streaming message blocks. | Empty panel explains what active object it is discussing. | Agent-specific failure remains in panel; partial results usable. | Responses can be added to notes/topic/point proposals. | Missing agents are labeled; no silent omission. |
| Score actions | Running state with cost/progress. | Idle action explains input/output. | Error stays on action card with retry/details. | Proposed improvements return as cards/notes/suggestions. | Partial score result labels missing personas. |
| Draft editor | Draft body skeleton. | Blank editor with Production Brief visible. | Save/load error in editor status strip; typed content preserved. | Autosaved status, current revision, and export readiness visible. | Offline/stale state marks export unavailable until synced. |
| Suggestion popover | Suggestions appear only after anchors resolve. | No suggestions means no marks. | Stale/ambiguous anchors visible but disabled. | Accept/Reject/Edit create revisions. | Remaining suggestions revalidate after any accepted edit. |
| Export / Ship | Destination checks run inside pane. | Export pane shows copy/download options and readiness notes. | Destination-specific errors with retry. | Copy/download succeeds with confirmation. | Direct publish appears disabled/future until connector exists. |
| Optimization round (pre-launch confirm) | — | — | Cost-estimate fetch failure shows "estimate unavailable" but Start remains available with explicit no-estimate warning. | Cost preview, wallclock estimate, and editable config visible; Start button armed. | Provider partial-availability shows badge in cost preview. |
| Optimization round (mid-run progress) | Skeleton bars during connect. | — | Loop runner hard error halts run, preserves acceptable pool, surfaces error code + retry. | Cost-so-far, projected, current iter, current phase, and Cancel always visible. | Partial-provider failures surface as a non-blocking badge; round continues with successful providers. |
| Optimization round (top-K display) | Card skeletons. | "No candidates passed gates" with reject-reason histogram (helps user diagnose tight gates). | Candidate-fetch error inside list with retry. | Top-K cards with rubric, SSR PMF, counter-audience (Drafts only), comparable history, diversity-position labels visible; Accept actions armed. | Some persona PMFs missing show as `pending` or `unknown` per persona; aggregate still computed if ≥ 1 primary persona has data. |
| Optimization round (cancelled / partial) | — | — | — | Same as completed top-K but explicitly labeled `Cancelled at iteration N`; partial pool selectable. | Partial-score candidates excluded from `partial_top_k` and surfaced separately as "Excluded due to incomplete scoring." |

### 3.X Optimization Rounds — four UX states (per `OPTIMIZATION_LOOP.md` §6)

Optimization rounds appear at every layer (Theme, Topic, Point, Outline, Draft polish, Draft full-search). Same four-state pattern; per-target-kind copy variation.

**State 1 — Pre-launch confirm.** `CostPreviewCard` shows estimated cost (with p10/p90 bands from past similar runs), wallclock estimate, and round configuration. User can edit `n_candidates`, `n_iterations`, `n_personas`, `budget_usd cap`. **For every target kind except `draft_fullsearch`:** user clicks `Start optimization` and the round launches immediately. **For `draft_fullsearch` only** (regardless of estimated cost): a mandatory double-confirm modal appears. Other target kinds skip double-confirm; users tighten cost via the `budget_usd` cap. The cost preview is also where users tune `n_candidates` etc. — these are not buried in Settings unless the user wants to change defaults.

**State 2 — Mid-run progress.** `RunProgressBar` shows live cost-so-far, projected-actual (continuously recalibrated as iterations complete), iteration count (`Iter 2 of 3`), and current phase (`generating` / `rubric_judging` / `ssr_scoring` / `counter_audience` / `ranking` / `merging_subloops`). `partial_provider_failures` surface as a non-blocking badge with a tooltip listing affected providers — the round continues. `Cancel` button is always visible. Cancellation routes to State 4.

**State 3 — Completed top-K.** Ranked list (default 5; 10 for Theme; 8 for Point; 3 for Outline; 3 for Draft polish). Each candidate is a `ProposalCard` showing:
- Composite score with per-axis breakdown.
- Per-axis rubric: `{score, gap, fix, weakest_quote}`. The `gap` and `fix` lines are the actionable handle for revision.
- Full SSR PMF per primary persona — bar chart with confidence (Shannon entropy) reported. Confidence < 0.3 is flagged visibly so users don't over-trust uncertain scores.
- Counter-audience objections (Drafts only) — line-quoted with severity (`minor` / `moderate` / `major`).
- `comparable_history` ("scores higher than 73% of your shipped Topics under this Theme").
- `diversity_position` (`most novel of top-5` / `cohort-reservation: ankit_indie_dev cohort` / `novelty-reservation`).

Below the top-K list: post-run report with convergence reason, cost actual vs estimate (delta surfaced), and `RejectReasonHistogram`. The histogram is critical for empty-result diagnosis: if all 60 candidates failed `specificity ≥ 3`, the user knows to lower the threshold or rewrite the persona panel. If most failed `diversity_distance ≥ 0.4`, the user knows the search converged on one shape.

**State 4 — Cancelled with partial pool.** Same shape as State 3 but explicitly labeled `Cancelled at iteration N`. Top-K is built from candidates that completed all hard-gate scoring before cancel; partially-scored candidates are excluded but surfaced separately with an "Excluded due to incomplete scoring" note. The user can still pick from the partial pool or re-launch with adjusted config (with idempotency cache reusing already-scored candidates within TTL).

**Cross-cutting visual rules:**
- ProposalCard SSR PMF chart: 5 vertical bars for the Likert scale; bar heights proportional to PMF; confidence bar below ranges 0–1. Color-encode primary persona; same persona = same color across all candidates in the round.
- Diversity-reservation labels are subtle (badge, not callout). They explain *why* a candidate is in top-K beyond raw composite score.
- Cost actuals vs estimates render as a tiny calibration delta on the post-run report — building user trust over time that the estimates are reliable.
- The `Cancel` button mid-run is non-destructive: copy reads "Stop and keep results so far," not "Abort." Reduces hesitation to cancel exploratory rounds.

### 3.Y PCP-context selector (Theme search only)

When launching `factory_theme_propose_optimize`, an optional `PcpContextSelector` lets the user enable PCP-seeded search:
- Window picker: `Last 7 days` / `Last 30 days` / `Last 90 days` / custom range / `None` (default — no PCP).
- PCP-type checkboxes: `calendar`, `linear`, `slack_dm`, `work_this_week`, `github_activity`, `manual_notes`. Default all enabled when window is set.
- A preview list shows the seed events that will be passed into the round prompt — Joseph can see exactly what context is being used before launching.
- Resulting Theme `ProposalCard`s show provenance: which seed events influenced which candidate, with `derived_from_pcp: true` flag and default `scope: personal`. Promotion to `organization` or `global` is an explicit user action with confirmation.

Privacy invariant: PCP content (raw calendar event descriptions, full Slack message text) is never carried into the durable Theme record — only short summaries via `seed_events.summary`. Users wanting raw content navigate to the source PCP system.

---

## 4. User journey and emotional arc

| Step | User does | User should feel | Design support |
|---|---|---|---|
| 1 | Starts a Piece | Oriented, not dropped into blank UI | Setup asks for deliverable, voice, audience, agents, scoring. |
| 2 | Picks or creates a theme | Like building a reusable portfolio | Themes panel shows topic count, scores, and last activity. |
| 3 | Chooses a topic | Clear about which angle is worth pursuing | Topics are scoped to active theme and scored against Setup. |
| 4 | Discusses topic with agents | Like using a focused room of collaborators | LLM Discussion is scoped to active theme/topic and shows real agent profiles. |
| 5 | Selects topic and builds points | In control of argument structure | Points panel and Notes panel bind clearly to active topic/point. |
| 6 | Captures messy thinking | Fast, not trapped in a form | Notes are freeform blocks with lightweight type metadata. |
| 7 | Improves score deliberately | Powerful but not autonomous | Score-improvement actions return proposals, never overwrite. |
| 8 | Builds outline | Has structured inputs | Outline consumes selected points, notes, scores, and evidence. |
| 9 | Drafts | Focused writing | Editor dominates; AI remains opt-in. |
| 10 | Polishes and ships | Editorially safe | Atomic suggestions, revisions, and Substack-ready export. |

Time-horizon design:
- **First 5 seconds:** user sees where they are in the workflow and what setup context is active.
- **First 5 minutes:** user understands how themes, topics, points, audience, agents, and scoring connect.
- **Fifth shipped piece:** the portfolio has enough reusable themes/topics/points that writing starts from accumulated thinking, not a blank prompt.

---

## 5. Visual specificity and anti-slop rules

Product class: app UI, not marketing page.

Required visual direction:
- Calm editorial workspace, not dashboard, chatbot, or CMS admin panel.
- Three-panel workspaces for Theme/Topic and Points.
- Cards only when the card is an object or action: deliverable, theme, topic, point, agent profile, worker action, suggestion.
- Agent profiles must include avatar, name, role/description, and model/provider status when available.
- Do not make the phase strip carry controls.
- No persistent bottom chat.
- No generic SaaS feature grid.
- No decorative blobs, emoji-as-UI, purple/blue gradients, or icon circles.
- Typography: compact sans for UI chrome; editorial body face for prose/draft surfaces.
- Color: warm white/off-white editor canvas, slightly cooler app chrome, near-black text, muted secondary gray, one restrained editorial accent.
- Radius: 6-8px for cards/popovers. Avoid large bubbly radius.

---

## 6. Responsive and accessibility specs

Desktop is the primary authoring mode, but layouts must degrade intentionally.

| Viewport | Layout | Behavior |
|---|---|---|
| ≥1440px | Full three-panel workspace | Panels visible side by side; LLM Discussion remains right panel. |
| 1180-1439px | Tighter three-panel workspace | Reduce panel metadata before reducing main content readability. |
| 900-1179px | Two-panel workspace | Active object panel + work panel visible; LLM Discussion becomes a drawer/tab. |
| 600-899px | Review/read posture | Cards and notes readable; LLM Discussion and setup libraries in drawers. |
| <600px | Read/review only | Show phase status, setup context, active object, notes/review actions. Heavy authoring can be discouraged. |

Accessibility rules:
- Keyboard focus order: phase strip → setup context bar → left panel → center panel → right LLM panel → phase actions.
- Every icon-only control needs accessible label and tooltip.
- Minimum target size: 44px for primary/touch controls; compact desktop controls can look smaller only if hit area remains 36-44px.
- Agent profile cards/rows must have readable text alternatives for avatars.
- Score badges cannot rely on color alone; include label or numeric text.
- Suggestion popovers and note type menus must be keyboard reachable and dismissible with Escape.
- Error text must be announced in-place for screen readers.
- Active phase and active point cannot rely only on color; use selected semantics, weight, outline, or label.
- Drawer and side sheet focus should trap while open and return focus to the invoking control.
- Reduced-motion mode disables decorative transitions and keeps functional state changes instant or near-instant.

---

## 7. Critical UX principles

1. **Setup defines good.** Deliverable, voice, audience, LLM room, and scoring system must exist before generated work is evaluated.
2. **Portfolio before prose.** Phase 1A creates reusable themes/topics/points before it asks the user to draft.
3. **Agents are people-shaped profiles.** The LLM Room shows avatars, names, roles, descriptions, and model/provider status. Anonymous model chips are not enough.
4. **Scores are context, not commands.** Theme/topic/point scores guide selection and improvement, but the user decides.
5. **Improve explicitly.** AutoResearch/AutoNovel-style actions are per-object commands, not background magic.
6. **Messy notes, structured metadata.** Notes stay freeform for the human and typed for the system.
7. **LLM Discussion is scoped.** It always knows the active theme/topic/point and writes back through explicit actions.
8. **Suggestions are atomic.** Accept/reject/edit per item. No global apply-all.
9. **The user can always write without AI.** Draft and notes remain usable without running Skills.
10. **AI generation never overwrites canonical work.** Proposed changes become notes, cards, suggestions, or revisions.
11. **Quiet by default.** Do not nag during thinking or writing.
12. **No generic bottom chat.** The discussion panel is a scoped work surface, not an assistant drawer glued to everything.

---

## 8. Required outputs for implementation design

Before implementation, produce specs or high-fidelity mockups for:

1. Setup screen with deliverable, voice/length/destination, audience, LLM Room, and scoring system.
2. Theme/Topic three-panel workspace with scoring badges and creation actions.
3. Points/Notes/LLM Discussion workspace with active point binding.
4. Agent profile card anatomy and add-agent library flow.
5. Add-audience library flow.
6. Theme/topic/point score badge and score-detail popover.
7. Per-object improvement action states: idle, running, partial, failed, proposed results.
8. Notes block model: Thought, Claim, Evidence, Question, Counterpoint.
9. Outline Builder consumption of points/notes/evidence/scores.
10. Draft Production Brief showing inherited setup and portfolio context.
11. Polish suggestion popover states.
12. Ship/export pane.
13. Responsive collapse behavior for all three-panel workspaces.
14. Accessibility states for active phase, active theme/topic/point, score badges, and LLM panel.

---

## 9. Engineering constraints to know about

- Theme, Topic, and Point pages live in rocketorchestra context pages; Drafts live in clawrocket-owned tables.
- Agent profiles and audience personas are library objects selected into a Piece; Setup should not become the full persona/agent editor.
- Scoring pipeline choice must be stored with the Piece and included in skill inputs.
- Scores may be stale or missing. UI renders stale/unknown honestly.
- Provider/model metadata comes from server config. Do not hardcode current model names into the client.
- All AI calls go through rocketorchestra's KMS-vaulted credentials. No client-side API keys.
- Draft editor is Tiptap. Suggestion overlay is a ProseMirror Decoration plugin.
- Markdown export is from a per-revision snapshot.
- Free-form AI output still becomes a suggestion, note, or proposal. It cannot mutate canonical content directly.

---

## 10. Review decisions and deferred scope

### Decisions made in this review

1. **Phase flow:** add Setup before Theme. Final flow: `Setup → Theme → Topic → Points → Research → Outline → Draft → Polish → Ship`.
2. **Setup scope:** Setup selects deliverable type, voice/length/destination, audience personas, LLM agent profiles, and scoring system.
3. **Deliverable model:** deliverables are output types such as Longform Post, Podcast Script, Book, Social Post, or Memo. Voice and length target are subfields.
4. **Audience model:** personas are defined elsewhere and added from a library with `+ Add Audience`.
5. **LLM Room model:** agents are defined elsewhere and added from a library with `+ Add Agent`. Agent rows/cards include avatar, name, short description, role, provider/model status.
6. **Header model:** phase strip stays clean. Setup context lives in a secondary context bar, not mixed into the phase strip.
7. **Theme/Topic IA:** desktop uses three panels: Themes, Topics, LLM Discussion.
8. **Creation controls:** `+ Theme` belongs in Themes; `+ Topic` belongs in Topics.
9. **Scoring:** themes, topics, and points should show aggregate and persona-specific scores when available.
10. **Score-improvement actions:** AutoResearch/AutoNovel-style generation is supported as explicit per-object actions.
11. **Points IA:** desktop uses three panels: Points, Notes for active point, LLM Discussion.
12. **Notes model:** notes are freeform blocks with lightweight types, not rigid form fields.
13. **Active binding:** the active point must be visibly selected and the Notes panel title must name it.
14. **Mockup direction:** round 4 is the approved structural direction, but the board variants represent different workflow screens, not mutually exclusive visual options.

### NOT in scope for Phase 1A

- Direct Substack publishing.
- Full autonomous optimize watcher.
- Persistent Panel Talk sessions.
- Full persona library editor.
- Full agent-profile library editor.
- Multi-user collaboration.
- Project-wide `DESIGN.md` extraction.

### What already exists

- `01_ARCHITECTURE.md` defines substrate/page types, Skill boundaries, provider metadata, and claims ledger concepts.
- `02_HERO_APPLICATIONS.md` defines the two-app product direction and broader Editorial Room lifecycle.
- `04_BUILD_PLAN.md` defines the Phase 1A layered implementation plan.
- gstack design artifacts contain the mockup rounds and feedback files for this review.

### Approved Mockups

| Screen/Section | Mockup Path | Direction | Notes |
|---|---|---|---|
| Setup | `/Users/josephkim/.gstack/projects/gamemakers-content-factory/designs/editorial-room-phase1a-20260429-212732/round4-A-setup-config-v2.png` | Setup as configuration | Passed quality gate; represents deliverable/audience/agents/scoring setup. |
| Theme/Topic Workspace | `/Users/josephkim/.gstack/projects/gamemakers-content-factory/designs/editorial-room-phase1a-20260429-212732/round4-B-topic-scored-v2.png` | Three-panel theme/topic workflow | Passed quality gate; represents Themes / Topics / LLM Discussion structure with score badges. |
| Points Workspace | `/Users/josephkim/.gstack/projects/gamemakers-content-factory/designs/editorial-room-phase1a-20260429-212732/round4-C-active-point-notes.png` | Points / Notes / LLM Discussion | Passed quality gate; represents active point binding and notes workflow. |

### TODO candidates

This docs workspace does not currently have a `TODOS.md`; carry these into implementation planning:

1. Define the agent-profile library UI and data contract.
2. Define the audience persona add flow and persona score display.
3. Define score calculation freshness and stale-score UI.
4. Define AutoResearch/AutoNovel action contracts for theme/topic/point improvement.
5. Define the typed freeform notes schema.
6. Extract a project-level `DESIGN.md` after this direction survives implementation dogfooding.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | ISSUES_FOUND | Prior outside voice found plan-level issues; fixes were applied in earlier planning docs |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 3 | CLEAN | Latest eng review clean; prior findings folded into build plan |
| Design Review | `/plan-design-review` | UI/UX gaps | 2 | CLEAN | score: 6.5/10 → 9.0/10, 14 decisions, 3 approved workflow mockups |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**UNRESOLVED:** 0 blocking design decisions. Remaining work is implementation-level detailing of agent libraries, scoring freshness, and typed notes.  
**VERDICT:** DESIGN REVIEW CLEARED for Phase 1A planning. Run `/plan-eng-review` again after this design update because Setup, scoring, and typed notes affect data contracts.

---

*End of Phase 1A design brief.*
