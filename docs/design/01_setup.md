# Screen 01 — Setup

**Source designs:** S2 (primary layout) + S1 (production-sheet reference for filled-in configuration detail)
**Phase:** 01 SETUP — entry point of the Editorial Room workflow
**Owner:** clawrocket
**Implementation target:** `webapp/src/pages/EditorialSetupPage.tsx`
**Companion contracts:**
- `EDITORIAL_ROOM_CONTRACT.md` §2 (`SetupState` schema)
- `02_HERO_APPLICATIONS.md` §2.X (Optimization Round UX patterns — surfaces from Setup)
- `05_DESIGN_BRIEF.md` §3 (state coverage table)

---

## 0. What this screen is

Setup is the entry point of every Editorial Piece. Before any Theme/Topic/Point/Draft work happens, the user defines four things:
1. **Deliverable** — what's being produced (longform post, podcast, etc.) + voice + length + destination + cadence
2. **Audience** — which personas score every layer downstream
3. **LLM Room** — which agent profiles critique, propose, and score during the run
4. **Scoring System** — which scoring pipeline (with weights and budget caps) governs gates

Setup is mandatory but cheap. The S2 design uses a sectioned wizard with a left-rail progress map that's **jumpable, not strict** — the user can jump to any section in any order. Each Setup change increments `setup_version` and stales dependent score snapshots (per `EDITORIAL_ROOM_CONTRACT.md` §1).

The S1 design (production-sheet) is the alternate fully-rendered view used for review or display once Setup is complete; the active editing flow uses S2.

---

## 1. Layout — three columns + top header

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  [ER] Editorial Room v0P    01 SETUP | 02 THEME+TOPICS | … | 06 SHIP    ⌘K HISTORY SAVE │
├───────────────────────────────────────────────────────────────────────────────┤
│ SETUP · Untitled Piece — new · 2/4 SECTIONS · 2 OF 4 DONE · AUDIENCE OPEN  ↻ CLONE FROM PRIOR PIECE  LOAD PRESET │
├──────────────────┬─────────────────────────────────────────────┬────────────────┤
│ SETUP SECTIONS   │ SECTION 02 · OF 04                          │ LIVE PREVIEW   │
│                  │ Who is this for?                            │ How this Setup │
│ ● Deliverable    │ Add personas from your library. Each one    │ surfaces       │
│   longform·2.5k  │ becomes a scoring perspective at every      │ downstream.    │
│   substack       │ layer.                                      │                │
│                  │                              [← DELIVERABLE │ ┌────────────┐ │
│ ● Audience  [02] │                              [LLM ROOM →   ]│ │CONTEXT BAR │ │
│   2 of 3 added · │                                             │ │THEME PHASE │ │
│   1 missing      │ SELECTED · 2                                │ │LONGFORM A R│ │
│   cohort         │                                             │ │+1? SCORING │ │
│                  │ ┌─────────────────────────────────────────┐ │ │NOT SET     │ │
│ ○ LLM Room       │ │ A Ankit Sharma  indie_dev_economics  …  │ │ └────────────┘ │
│   not yet        │ │   indie dev · solo · Bangalore  PRIMARY │ │ ┌────────────┐ │
│   assembled      │ │              EDIT WEIGHT · REMOVE       │ │ │THEME CARD  │ │
│                  │ └─────────────────────────────────────────┘ │ │WITH SCORES │ │
│ ○ Scoring        │ ┌─────────────────────────────────────────┐ │ │Deal-term   │ │
│   not yet        │ │ R Ravi Mehra  studio_operator  …        │ │ │shifts in…  │ │
│   selected       │ │   studio lead · 14 ppl · Mumbai  PRIMARY│ │ │A 7.4  R 3.8│ │
│                  │ │              EDIT WEIGHT · REMOVE       │ │ │(3rd score  │ │
│ ─────────────────│ └─────────────────────────────────────────┘ │ │when 3rd    │ │
│ OR LOAD PRESET   │                                             │ │persona     │ │
│                  │ ADD FROM PERSONA LIBRARY                    │ │added)      │ │
│ ◇ GameMakers     │ 12 personas in library · suggested by       │ └────────────┘ │
│   default        │ deliverable + theme tag                     │ ┌────────────┐ │
│ ◇ AutoNovel      │ [search personas…]              [FILTERS]   │ │SETUP IMPACT│ │
│   research       │                                             │ │•every Theme│ │
│ ◇ Memo · short   │ ┌──────────┐ ┌──────────┐ ┌──────────┐      │ │ /Topic gets│ │
│   form           │ │● SUGGESTED│ │Sarah Chen│ │Diego R.  │      │ │ a per-     │ │
│                  │ │Mei Tanaka │ │solo jrnl │ │QA lead   │      │ │ persona    │ │
│ + save current   │ │publisher  │ │ex-PCG    │ │4-yr ten. │      │ │ score col  │ │
│   as preset      │ │BD · Tokyo │ │trade_pres│ │studio_ops│      │ │•cohort-    │ │
│                  │ │"If you    │ │"I don't  │ │"I want to│      │ │ targeted   │ │
│                  │ │can't…"    │ │quote…"   │ │know what…│      │ │ sub-loops  │ │
│                  │ │LAST EDIT 3D│LAST EDIT 3D│LAST EDIT 3D│     │ │•counter-   │ │
│                  │ │      + ADD│ │     + ADD│ │     + ADD│      │ │ audience   │ │
│                  │ └──────────┘ └──────────┘ └──────────┘      │ │ at Polish  │ │
│                  │ (3 more cards: Yuki, Priya, Jonas)          │ │•cost ≈     │ │
│                  │                                             │ │ $2.10 per  │ │
│                  │ Mei is suggested — your deliverable tags    │ │ Topic round│ │
│                  │ include publishing_economics and your       │ │ (3 person.)│ │
│                  │ library has a publisher_bd persona.         │ └────────────┘ │
│                  │                       + NEW PERSONA · ADD   │                │
│                  │                       SUGGESTED · ⌘↵        │ AUTO-SAVED 12S │
│                  │                                             │ AGO · DIFF VS. │
│                  │                                             │ PRESET         │
└──────────────────┴─────────────────────────────────────────────┴────────────────┘
```

**Width allocations** (inferred from design proportions; refine to actual breakpoints):
- Left rail (Setup Sections + Presets): ~210px fixed
- Right rail (Live Preview): ~330px fixed
- Center (Active Section workspace): flex 1, min ~720px
- Total min canvas: ~1280px desktop. Below that, the Live Preview rail collapses behind a toggle button.

---

## 2. Top header

Single component: `EditorialPhaseStripWithMeta`. Used across all six phases (01 Setup → 06 Ship).

| Element | Spec |
|---|---|
| `[ER]` logo | Square, ~32×32px, monospaced "ER" in app accent color. Click → returns to publication home. |
| `Editorial Room v0P` wordmark | Italic serif (matches app body face). "v0P" in small caps next to wordmark indicates pre-production phase build. |
| Phase strip | Six pills inline. Active phase has dark fill + light text; inactive phases muted with status text. Click navigates to that phase's surface. Order: `01 SETUP` `02 THEME + TOPICS` `03 POINTS + OUTLINE` `04 DRAFT` `05 POLISH` `06 SHIP`. |
| `⌘K` button | Keyboard shortcut launcher (command palette). Reserved hotkey. |
| `HISTORY` button | Opens the Piece's revision-history side panel. Reads `talk_output_revisions`. |
| `SAVE` button | Manual save trigger; auto-save runs in background per `AUTO-SAVED 12S AGO` indicator in right rail. Saves trigger `setup_version` increment when SetupState changes. |

**Anti-pattern callout (from voice page):** the phase strip MUST NOT carry workflow controls (audience/agent pickers, Skill triggers). It is purely navigation.

---

## 3. Meta bar (under header)

Single line. Left side describes the Piece's setup status; right side has cross-Piece actions.

| Element | Spec |
|---|---|
| Phase prefix | `SETUP` (current phase, all caps small) |
| Piece title | `Untitled Piece — new` (editable inline; clicks open inline rename) — italic, slightly larger. |
| Status pip 1 | `2/4 SECTIONS` (count of completed Setup sections) |
| Status pip 2 | `2 OF 4 DONE` (more verbose, redundant with above — likely consolidate to one in implementation) |
| Status pip 3 | `AUDIENCE OPEN` (which section is currently being edited) |
| Right action 1 | `↻ CLONE FROM PRIOR PIECE` button (chip-style with bracket border). Opens picker of user's prior Pieces; copies their SetupState into this Piece. |
| Right action 2 | `LOAD PRESET` button (chip-style). Opens preset library (same as left-rail preset section but as a modal). |

Pip text uses the monospaced uppercase chip style that recurs throughout the design.

**Inferred** (not 100% from screenshot): redundancy between `2/4 SECTIONS` and `2 OF 4 DONE` may be intentional (counter + label) or a draft artifact. Implement as one combined indicator: `2 OF 4 SECTIONS DONE` and confirm against rendering.

---

## 4. Left rail — Setup Sections + Presets

Fixed-width sidebar, ~210px, full-height of viewport below header.

### 4.1 Setup Sections list

Top of rail. Header label: `SETUP SECTIONS` (small caps, muted).

Four section rows, vertically stacked. Each row is clickable to jump to that section's editing view.

| State icon | Section name | Status sub-line |
|---|---|---|
| ● filled black dot | `Deliverable` | `longform · 2.5k · substack` (configured summary) |
| ● filled red dot with `[02]` indicator | `Audience` | `2 of 3 added · 1 missing cohort` (in-progress with warning) |
| ○ empty dot (outline) | `LLM Room` | `not yet assembled` (not started) |
| ○ empty dot (outline) | `Scoring` | `not yet selected` (not started) |

**Annotation:** *"progress dots show what's done. jumpable; not strict wizard."* The user can click any section in any order. There's no "complete previous to unlock next" gating.

**State semantics:**
- `not started` — empty outline circle
- `in progress with issue` — filled red dot with section number badge
- `in progress` — filled neutral/gray dot
- `complete` — filled black dot
- `complete with auto-changes` — filled black dot + small indicator

The active section shows hover/selected styling (probably a subtle background fill or left-border accent).

### 4.2 Preset section

Below sections, after a thin separator.

Header: `OR LOAD PRESET` (small caps, muted).

Preset rows:
| Preset name | Sub-line |
|---|---|
| `GameMakers default` | `3 personas · A R M panel · default scoring` |
| `AutoNovel research` | `5 personas · 4-agent panel · novelty-weighted` |
| `Memo · short form` | `1 persona · 1 agent · rubric-only` |

Each row has a `◇` left marker.

Footer button: `+ save current as preset` (full-width, chip-style border). Saves current SetupState as a reusable preset. Disabled until at least one section is configured.

---

## 5. Center — Active Section workspace

Flex-1 width. Renders the currently-active Setup section. Layout below shows **Section 02 · Audience** (the section open in the S2 design).

### 5.1 Section header

| Element | Spec |
|---|---|
| Eyebrow | `SECTION 02 · OF 04` (small caps, muted) |
| Heading | `Who is this for?` (large hand-feel serif, ~36–44px) |
| Subhead | `Add personas from your library. Each one becomes a scoring perspective at every layer.` (italic, muted, ~16px) |
| Right-side nav | `← DELIVERABLE` and `LLM ROOM →` chip buttons. Jump to prev/next section. Match the same chip style used in the meta bar. |

The hand-feel serif heading is a recurring pattern across all editorial-content surfaces (used in Theme cards, Topic detail, Draft heading too). Use the same face throughout.

### 5.2 Selected personas list

Header line: `SELECTED · 2` (small caps).

For each selected persona, render a `SelectedPersonaRow` card:

| Element | Spec |
|---|---|
| Avatar | Circle, ~32px, monogram letter (A/R/M) on persona-color fill. Color is per-persona, recurs in every other surface (column headers in Theme/Topic, panel chat avatars, etc.) |
| Name | Bold, ~16px |
| Sub-title | `indie dev · solo · Bangalore` — pulls from persona's `demographics.occupation` + `demographics.location_freeform`. Muted. |
| Cohort tag | `indie_dev_economics` — monospaced, in a chip with bracket border. Uses persona's `cohort_tags[0]` or a primary tag. |
| Weight | `PRIMARY` chip — small caps, accent color border. |
| Action: `EDIT WEIGHT` | Chip button. Opens inline weight editor (probably PRIMARY/SECONDARY/COUNTER toggle plus numeric weight 0.0–1.0). |
| Action: `REMOVE` | Chip button. Removes from `audience_persona_slugs` array. Confirms before remove if there's downstream score history. |

**Layout:** rows full-width, vertical stack with subtle separator between. Hover state subtle.

### 5.3 Persona library picker

Below the selected list.

Header: `ADD FROM PERSONA LIBRARY`
Sub-line: `12 personas in library · suggested by deliverable + theme tag`

Toolbar:
- Search input: placeholder `search personas…`, full-width minus filter button
- `FILTERS` chip button (right). Opens filter drawer (cohort_tags, role_to_topic, location, etc.)

**Card grid:** 3 columns × 2 rows = 6 cards visible. Each `PersonaLibraryCard`:

| Element | Spec |
|---|---|
| Suggested badge | When system has flagged this persona as a fit: red dot + `SUGGESTED` label in red, top-left corner. Yellow-dot variant for soft-suggestion. |
| Name | Bold, ~16px |
| Sub-title | `publisher BD · Tokyo` (occupation + location) |
| Cohort tag | Monospaced chip, e.g., `publisher_bd` |
| Quote | One italic line in handwritten/serif style, ~13px, ~2 lines max with truncation. Pulled from `voice_of_customer_quotes[0]`. |
| `LAST EDIT · 3D` | Footer-left, muted, monospaced |
| `+ ADD` | Footer-right, chip button. Adds persona to `audience_persona_slugs`. |

When the persona is suggested and not yet added, the `+ ADD` button has the same accent treatment as the `SUGGESTED` badge.

**Annotation:** *"suggested persona has a yellow dot. system uses deliverable tags to recommend who's missing."*

### 5.4 Section footer

| Element | Spec |
|---|---|
| Suggestion explanation | `Mei is suggested — your deliverable tags include publishing_economics and your library has a publisher_bd persona.` (small italic) |
| `+ NEW PERSONA` | Chip button. Opens persona-creation modal (or routes to substrate persona authoring surface). |
| `ADD SUGGESTED · ⌘↵` | Primary action button. Adds the suggested persona (Mei) to the panel. Keyboard hint shown inline. |

---

## 6. Right rail — Live Preview

Fixed-width, ~330px. Header label: `LIVE PREVIEW` with sub-line `How this Setup surfaces downstream.`

**Annotation:** *"live preview shows downstream surfaces. setup → context bar; theme cards → scoring. 'see what you're configuring.'"*

Three preview cards stacked vertically, each rendering a tiny mockup of a downstream surface so the user knows what they're committing to.

### 6.1 Card: CONTEXT BAR · THEME PHASE

Tiny mockup of how the Theme-phase context bar will look once Setup is complete.

Content (mock):
```
LONGFORM   [A] [R]  +1?   SCORING NOT SET
  ·2.5K
```

Where `+1?` is a placeholder for the missing third persona, and `SCORING NOT SET` reflects that section 04 hasn't been completed. The preview updates live as Setup changes.

### 6.2 Card: THEME CARD · WITH SCORES

Tiny mockup of a Theme card as it'll appear in Theme/Topic workspace.

Content:
```
Deal-term shifts in indie publishing
[A] 7.4   [R] 3.8
(third score will appear when 3rd persona added)
```

The Theme name is sample/dummy; scores are sample. The preview shows how per-persona score columns render (column count grows with persona count).

### 6.3 Card: SETUP IMPACT (red-bordered callout)

Bullet list of what choices imply:

- every Theme/Topic gets a per-persona score column
- cohort-targeted sub-loops in optimization
- counter-audience pass at Polish (drafts only)
- cost ≈ $2.10 per Topic round (3 personas)

**Interaction:** the cost-estimate updates dynamically as the user changes persona count, samples-per-call config, etc. (Inferred — not visible in static screenshot but consistent with design intent.)

### 6.4 Footer

Bottom-right of rail:
- `AUTO-SAVED 12S AGO` (muted, monospaced)
- `DIFF VS. PRESET` chip button. Opens diff view comparing current SetupState to the loaded preset (if any). Disabled when no preset loaded.

---

## 7. State coverage (all 5 states per `05_DESIGN_BRIEF.md` §3)

| Surface | Loading | Empty | Error | Success | Partial / degraded |
|---|---|---|---|---|---|
| **Phase strip** | Skeleton phase labels | New Piece starts at Setup | Inline retry; keep current phase usable | Active phase visible, available next visible | Optional/future phases muted |
| **Meta bar** | Skeleton chips | Title `Untitled Piece — new`; section count `0/4` | Inline error chip with retry | Full title + counts visible | Stale provider data marked stale |
| **Left rail Setup Sections** | Skeleton list | Default state (4 sections, all not-started) | Section row error inline, retry | All section rows visible with correct state icons | Stale section status (e.g., persona library failed to count) marked unknown |
| **Left rail Presets** | Skeleton preset rows | "No saved presets yet" if user has none | Inline retry on preset-load failure | All preset rows visible | — |
| **Active section header** | Skeleton heading | First-visit copy (varies per section) | Section error inline | Heading + subhead populated | — |
| **Selected personas list** | Skeleton rows | "No personas added yet — pick from the library below" | Per-row error: failed to load persona detail (show row with error chip) | Rows render with full data | Persona referenced but missing from library: render with `MISSING` badge and `RESOLVE` action |
| **Persona library picker** | Card skeletons (6 boxes) | "No personas in library — create one" with `+ NEW PERSONA` highlighted | Library load failed: full-width error with retry | 6+ cards visible, search functional | Some personas missing metadata (no quote, no last_edit) — render gracefully without breaking layout |
| **Live Preview rail** | Card skeletons (3 boxes) | Empty cards with "Configure section X to see preview" copy | Preview render failed: card-scope error | All 3 cards populated with live data | Card data partially stale (e.g., cost estimate uncalibrated): show with `EST.` prefix |

---

## 8. Data shapes (cross-references)

The Setup screen reads/writes `EditorialPiece.setup_state` per `EDITORIAL_ROOM_CONTRACT.md` §2. The full `SetupState` type:

```typescript
type SetupState = {
  schema_version: "0";
  setup_version: number;                  // monotonic; increments on any change
  deliverable_type: "longform_post" | "podcast_script" | "book_chapter" | "social_post" | "memo";
  voice_page_slug: string;
  length_target: { min_words: number; max_words: number; } | null;
  destination: "substack_md" | "google_doc" | "plain_md" | "youtube_script" | "other";
  audience_persona_slugs: string[];       // ordered; min 1, max 3 initially
  llm_room_agent_profile_ids: string[];   // ordered; min 2, max 6 initially
  scoring_pipeline_slug: string;
  updated_at: string;
  updated_by_user_id: string;
};
```

**Per-section data sources:**
- **Section 01 Deliverable:** writes `deliverable_type`, `voice_page_slug`, `length_target`, `destination`. Voice page reads from rocketorchestra (`get_page` MCP) — voice slug is freely typeable but should autocomplete from the user's voice library.
- **Section 02 Audience:** writes `audience_persona_slugs[]`. Persona library reads from rocketorchestra. Each persona's `voice_of_customer_quotes[0]`, `demographics.occupation`, `demographics.location_freeform`, `cohort_tags[0]` populate the library card.
- **Section 03 LLM Room:** writes `llm_room_agent_profile_ids[]`. Agent profile library reads from clawrocket-local agent profile store (the rocketboard `ai_personas` port).
- **Section 04 Scoring System:** writes `scoring_pipeline_slug`. Pipeline reads from rocketorchestra.

**Setup change → setup_version increment → stale propagation** per §1 of the contract. Marks dependent rows stale: `score_snapshots`, `discussion_sessions`, `optimization_rounds`, `talk_output_revisions.metrics_json`. Stale rows render visibly stale; user explicitly triggers recompute.

---

## 9. Configuration sections — pulled from S1 reference for Sections 1, 3, 4

S2 shows Section 02 (Audience) in detail. S1 shows the full Setup as a production-sheet so it reveals what Sections 1, 3, 4 contain when configured. Pull these section structures from S1 into the S2 active-section workspace:

### Section 01 · Deliverable

Field columns (renders as a horizontal labeled-input grid, not a wizard list):
| Field | Type | Source |
|---|---|---|
| `TYPE` | enum | `deliverable_type` (Longform Post / Podcast Script / Book Chapter / Social Post / Memo) |
| `VOICE` | slug picker | autocomplete from voice library; default `gamemakers-2026` |
| `LENGTH` | range pair | `length_target.min_words` / `max_words`, e.g., `2,000 – 2,500 words` |
| `DESTINATION` | enum | `destination` field; show `Substack · Markdown export` for `substack_md` |
| `CADENCE` | text | display-only metadata, not part of `SetupState` (inferred — confirm) |

Below the field row: `VOICE RULES` row showing the Voice page's signature moves as inline chips (e.g., `declarative`, `no first-person plural`, `numbers > adjectives`, `cite primary sources`, `no clickbait headlines`) plus a `+ RULE` button to add ad-hoc per-piece overrides. Right side: `VIEW VOICE PAGE →` button (opens voice page in a side sheet).

**Annotation:** *"masthead · newspaper feel. setup_v3 = step 4. brief."*

### Section 03 · LLM Room

Renders as a row-per-agent table. Each `LLMRoomAgentRow`:
| Element | Spec |
|---|---|
| Avatar | Persona-style monogram circle (A/R/M with color), but for the agent profile, not audience persona |
| Name + sub-title | e.g., `Argus` / `argument critic` |
| Model + Provider | `CLAUDE-OPUS-4 · ANTHROPIC` (monospaced, in chip) |
| Stance | One italic line, e.g., `hostile to weak claims · steelmans counters` |
| Cost | `~$0.04/TURN` (right-aligned, monospaced) |
| Row actions | Three-dot menu (edit, remove) |

Footer line: `3 ACTIVE · ALL PROFILES FROM AGENT-PROFILE LIBRARY · EST. ~$0.07 PER PANEL TURN`

Bottom-right buttons: `+ ADD AGENT` and `BROWSE LIBRARY`.

**Annotation:** *"agent has surface model + stance + per-turn cost. not anonymous chips."* — agents are presented as named, distinguishable, with explicit cost. They are not opaque "AI agent #1, AI agent #2" chips.

### Section 04 · Scoring System

Three-column layout (per the annotation `"scoring as 3 columns: pipeline · weighted scorers · budget caps. weights tunable inline."`):

**Column 1 — PIPELINE**
- Label `PIPELINE`
- Picker showing current pipeline slug, e.g., `gamemakers_default`
- Click opens pipeline-picker dropdown / library

**Column 2 — SCORERS · WEIGHTS TUNABLE**
- Header: `SCORERS · WEIGHTS TUNABLE`
- Per-scorer row:
  - Scorer name (left) — e.g., `RUBRIC JUDGE`
  - Bar (visual weight indicator, draggable) — actual weight visualized as a horizontal bar fill
  - Numeric weight (right) — e.g., `×0.40`
  - Inline description (italic) — e.g., `Opus · 6 axes · stance / claim / source / voice / risk / fit`
- Default scorers visible in S1: `RUBRIC JUDGE` (×0.40), `SSR PANEL` (×0.40), `VOICE DRIFT` (×0.20), `COUNTER-AUDIENCE` (×0.00)
- Bar drag adjusts weight; weights normalize to sum to 1.0 across `role: score` scorers (per `EDITORIAL_ROOM_CONTRACT.md` §3.6 ScoringPipelineCompiledTruth)
- `COUNTER-AUDIENCE` shown with `×0.00` and inline note `Drafts only · disabled at Theme/Topic · auto-on at Polish` — confirms scorer can be configured to zero at certain phases

**Column 3 — BUDGET CAPS**
- Header: `BUDGET CAPS`
- Per-cap rows:
  - `PER TOPIC OPTIM.` `$5.00`
  - `PER DRAFT OPTIM.` `$50.00`
  - `PER POLISH ROUND` `$0.50`
  - `HARD WALLCLOCK` `10 MIN`
- Each value is editable inline. Hard caps for `OPTIMIZATION_LOOP.md` §5 cost guardrails.

---

## 10. Visual + interaction style

The whole design is hand-annotated wireframe style ("balsamiq-ish low-fi"). The implementation should use Tailwind utilities to approximate the look without trying to literally replicate the hand-drawn feel — that's a stylistic placeholder. Production styling rules per `05_DESIGN_BRIEF.md` §5:

- Calm editorial workspace, not dashboard.
- Compact sans for UI chrome (button labels, chip text).
- Editorial body face for headings (`Who is this for?`) and quote text — recommend matching the Voice page style.
- Monospaced (small caps) for chips, status pips, and metadata: `LONGFORM`, `2/4 SECTIONS`, `PRIMARY`, `+ ADD`, etc.
- 6–8px radius on cards and buttons. No bubbly radius.
- Warm white / off-white canvas background. App chrome slightly cooler.
- One restrained editorial accent color (red appears in the wireframe — likely intentional; confirm against final palette).

**Inferences flagged:**
- Exact pixel widths for left/right rails are inferred from canvas proportions; refine to the chosen breakpoint system.
- Color tokens (red accent for warnings/suggestions, color per persona) are inferred — production styling should formalize the palette.
- Specific Tailwind classes are not in the wireframe; the .md describes intent, the engineer maps to actual classes.

---

## 11. Anti-patterns (captured from annotations)

- **Phase strip is navigation only.** Do not put audience pickers, agent controls, or Skill triggers in the phase strip.
- **Setup is jumpable, not a strict wizard.** The user picks any section, in any order. No "complete previous to unlock next" gating.
- **Defaults must be explicit, not opaque.** The S0 fast-path card lists exactly what the GameMakers default contains (`Longform Post · 2.5k words · Substack export · Audience: Ankit, Ravi, Mei (3 personas) · LLM Panel: ARM agents on Opus/Sonnet/Gemini · Scoring: GameMakers Default pipeline (rubric + SSR + voice)`) so the user knows what they're agreeing to. **Do not** show a `Use defaults` button without listing the values.
- **Suggested personas show a yellow/red dot, not silently appear.** The system uses deliverable tags to recommend a missing cohort, but the user always sees and accepts.
- **LLM agents are named with surface model + stance + cost.** Not anonymous chips. The user always sees which model is on the panel.
- **Setup change stales dependent state.** The UI must indicate when a Setup change has invalidated downstream snapshots; never auto-recompute silently.

---

## 12. Open questions / things to confirm

1. **Cadence field on Section 01 Deliverable** — visible in S1 but not in `SetupState` schema (`EDITORIAL_ROOM_CONTRACT.md` §2). Either add to `SetupState` or treat as display-only metadata. Confirm before implementing.
2. **`2/4 SECTIONS` vs `2 OF 4 DONE`** redundancy in meta bar — likely consolidate to one indicator. Confirm intent.
3. **Live Preview's CONTEXT BAR card** rendering style — is it a literal mini-mockup (small-scale render of the actual context bar component) or a pictogram? Implementation-wise, mini-mockup is more useful but more work.
4. **Persona-color tokens** — each persona has a recurring color (A green, R brown, M blue). Defined where? Probably auto-generated from persona slug or user-pickable in persona authoring. Confirm.
5. **Preset diff rendering** (`DIFF VS. PRESET` action) — what does the diff view show? Likely a modal listing changed fields. Spec deferred until needed.

---

## 13. Reference screenshots

- `01_setup_s2.png` — S2 layout (primary; this spec is built against it)
- `01_setup_s1.png` — S1 production-sheet (configuration-detail reference for sections 1, 3, 4)
