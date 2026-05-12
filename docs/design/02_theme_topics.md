# Screen 02 — Theme + Topics (combined)

**Source design:** B++ · "Theme + Topics combined · fat AI panel"
**Phase:** 02 THEME + TOPICS
**Owner:** clawrocket
**Implementation target:** `webapp/src/pages/ThemeTopicsWorkspacePage.tsx`
**Companion contracts:**
- `EDITORIAL_ROOM_CONTRACT.md` §3.1 (`theme` page), §3.2 (`topic` page), §4.7 (`OptimizationRound`)
- `THEME_TOPIC_POINTS_DEFINITION.md` §3 (Theme tests + scorable axes), §4 (Topic)
- `OPTIMIZATION_LOOP.md` §6.1 (Theme generation), §6.2 (Topic optimization)
- `01_setup.md` (the upstream Setup that feeds this screen)

---

## 0. What this screen is

The combined Theme + Topics workspace is where editorial structure happens before drafting. Per the design label: *"narrow 2-col left (Themes → Topics) · center editorial detail · fat right AI panel with per-persona scores ON TOP and discussion below."*

Themes and Topics share one screen because the user's actual workflow is: pick a Theme → drill into its Topics → develop one specific Topic. Splitting them across two screens fragments that flow. The B++ pattern keeps both lists visible (left side) while the center column shows the active Topic in detail and the right rail shows the sources backing it.

**Critical design intent (from annotation):** *"Notes panel: typed boxes the user adds. NOT a discussion thread. Notes don't have fixed fields — they're note types. user adds whatever's useful."* And: *"AI panel debates the notes above — turns can @reference a note. note + debate is one substrate."*

The Notes are the durable artifact. The Panel Discussion is conversation about the notes. Together they form the editorial substrate for the Topic.

---

## 1. Layout — four columns + top header + setup chip bar

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ [ER] Editorial Room v0P    01 SETUP | 02 THEME+TOPICS | … | 06 SHIP    ⌘K OPTIMIZE THEMES→ SAVE │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ [A][R][M] 3 personas · 1k-1.4k words · indie devs · mid-career · SSR ≥ 0.6 · PMF ≥ 7 · edit setup │
├─────────┬──────────┬──────────────────────────────────────────────────┬──────────────────┤
│ THEMES  │ TOPICS · │ TOPIC  How Embracer's $2.1B writedown…    + POINT │ SOURCES · 4      │
│  · 6    │ UNDER AI │                              OPTIMIZE TOPIC →    │       + ADD     │
│         │ IMPACT   │ A ANKIT 9   R RAVI 9   M MEI 7   AGGREGATE 7.8   │ ┌──────────────┐ │
│ ┌─────┐ │   · 3    │ "lead with"  needs ppl  "verify"  SSR 0.78 ✓GATES│ │SRC #1 PRIMARY│ │
│ │AI   │ │          │                                                  │ │Embracer Q3   │ │
│ │Impct│ │ ┌──────┐ │ ONE-LINER                                        │ │8-K pp.14-16  │ │
│ │V4·3 │ │ │How   │ │ Surviving studios are signing 2022-rate deals    │ │MG reclass    │ │
│ │TOPCS│ │ │Embra…│ │ to keep going — Embracer's writedown shifted     │ │✓ CITED       │ │
│ │7.4  │ │ │7.8   │ │ bargaining power away from devs in a way that's  │ ├──────────────┤ │
│ │EDIT │ │ ├──────┤ │ locked in for 18+ months.                        │ │SRC #2 PRIMARY│ │
│ │OPT→ │ │ │6-pers│ │                                                  │ │Devolver Q4   │ │
│ ├─────┤ │ │studio│ │ NOTES · 5    +ANGLE +STAKE +THOUGHT +CONCERN +OTH│ │$5 conditional│ │
│ │Crtv │ │ │6.6   │ │ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐  │ │✓ CITED       │ │
│ │Brnt │ │ ├──────┤ │ │● ANGLE  DEB │ │● STAKE      │ │● THOUGHT    │  │ │! DISPUTED    │ │
│ │7.1  │ │ │Why AI│ │ │What changed │ │Mid-tier pays│ │The 'reverts │  │ ├──────────────┤ │
│ ├─────┤ │ │art   │ │ │in MG acctg —│ │; tiny indies│ │in 18 months'│  │ │SRC #3   ANEC │ │
│ │Indie│ │ │6.1   │ │ │your next    │ │get tailwind │ │counter is   │  │ │Annapurna stf │ │
│ │Econ │ │ └──────┘ │ │deal will be │ │             │ │publisher-   │  │ │background    │ │
│ │6.8  │ │          │ │different    │ │             │ │bias — flag  │  │ │contradicts $2│ │
│ ├─────┤ │ +PROPOSE │ └─────────────┘ └─────────────┘ │above        │  │ │✓ CITED       │ │
│ │Steam│ │  TOPICS  │ ┌─────────────┐ ┌─────────────┐ └─────────────┘  │ ├──────────────┤ │
│ │Disc │ │ (dashed) │ │● CONCERN  D │ │● THOUGHT    │                  │ │SRC #4    SEC │ │
│ │6.2  │ │          │ │Annapurna stf│ │Devolver Q4  │                  │ │Game Industry │ │
│ ├─────┤ │ ─────────│ │contradicts  │ │prelim ambig │                  │ │News · Apr    │ │
│ │Genre│ │ COUNTER  │ │filings:     │ │on cond. MGs │                  │ │2025 explainer│ │
│ │Cons │ │ TOPIC ·1 │ │VERIFY before│ │             │                  │ └──────────────┘ │
│ │6.6  │ │          │ │draft        │ │             │                  │                  │
│ ├─────┤ │ ┌──────┐ │ └─────────────┘ └─────────────┘                  │ DROP FILE OR     │
│ │Pub  │ │ │Why AI│ │                                                  │ PASTE URL        │
│ │Rels │ │ │tooling│ │                                                  │ (drop zone)      │
│ │5.4  │ │ │overhy│ │ PANEL DISCUSSION · 4 TURNS DEBATING NOTES ABOVE  │                  │
│ └─────┘ │ │5.8   │ │                                       LAST 11:47 │ INPUTS           │
│         │ └──────┘ │ A ANKIT  11:42  ↑ note: angle                    │ SETUP.AUDIENCE   │
│+PROPOSE │          │ The angle note is the load-bearing one. Lead     │ SETUP.LENGTH     │
│ THEMES  │          │ with the MG-as-conditional-liability framing.    │ THEME.AI_IMPACT  │
│         │          │                                                  │   _GAMEDEV       │
│         │          │ R RAVI   11:43  ↑ note: stake                    │ 0 PRIOR TOPICS   │
│         │          │ The stake is right but abstract. Add a           │   IN LINEAGE     │
│         │          │ thought-note: which specific solo dev got their  │                  │
│         │          │ deal repapered? That's the piece.                │                  │
│         │          │ PROPOSES: ADD: SOLO-DEV CASE STUDY               │                  │
│         │          │                                                  │                  │
│         │          │ M MEI    11:43  ↑ note: concern                  │                  │
│         │          │ Annapurna concern is a real falsifier — needs    │                  │
│         │          │ verification before this clears Polish. Flagged. │                  │
│         │          │                                                  │                  │
│         │          │ A ANKIT  11:47  ↑ note: stake  ↑ note: concern   │                  │
│         │          │ Agreed. If Annapurna's claim holds, the 'tiny    │                  │
│         │          │ indies tailwind' stake is wrong, not just incomp.│                  │
│         │          │                                                  │                  │
│         │          │ ┌──────────────────────────────────────────────┐ │                  │
│         │          │ │Ask the panel — or @reference a note above…   │ │                  │
│         │          │ │@ALL @A @R @M #NOTE                  SEND ⌥↵  │ │                  │
│         │          │ └──────────────────────────────────────────────┘ │                  │
└─────────┴──────────┴──────────────────────────────────────────────────┴──────────────────┘
```

**Width allocations** (inferred):
- Themes column: ~140px fixed
- Topics column: ~155px fixed
- Center detail: flex 1, min ~600px
- Sources rail: ~210px fixed
- Total min: ~1280px desktop. Sources rail collapses behind a toggle below 1280.

**Annotation:** *"4 cols: Themes · Topics · center · Sources rail"* — confirms the four-column layout. *"fat center detail"* — center column is intentionally wide.

---

## 2. Top header

Same `EditorialPhaseStripWithMeta` component as Setup. `02 THEME + TOPICS` is the active pill. The right-side action button changes per phase: `OPTIMIZE THEMES →` for this phase. Click triggers an optimization round on Themes (per `OPTIMIZATION_LOOP.md` §6.1) — opens the cost-preview modal first.

---

## 3. Setup chip bar (under header)

A horizontal strip showing the active Setup configuration as chips. Persistent across the workspace; gives the user constant awareness of what they configured upstream.

| Element | Spec |
|---|---|
| Persona avatars + count | `[A][R][M] 3 personas` — three monogram circles inline (same per-persona color tokens as elsewhere), then count text |
| Length chip | `1k-1.4k words` |
| Audience tag chip | `indie devs · mid-career` (pulled from persona cohort tags / shared cohort summary) |
| SSR threshold chip | `SSR ≥ 0.6` (the SSR likelihood gate threshold from scoring pipeline) |
| PMF threshold chip | `PMF ≥ 7` (PMF mean threshold) |
| `edit setup` button | Right-side; opens Setup screen as modal/side-sheet, NOT full navigation away (preserves workspace context) |

Visual: chips are monospaced uppercase with 6–8px radius, separator dots between groups. The `edit setup` action is a regular button at the right end.

**State change behavior:** if the user opens `edit setup` and changes any field, the chip bar updates live; on save, `setup_version` increments and dependent surfaces (Theme cards, Topic scores, etc.) mark stale until rescore.

---

## 4. Left rail — Themes column

Header: `THEMES · 6` (count of active Themes in the publication's library)

Stack of Theme cards, vertically scrollable. Each `ThemeCard`:

| Element | Spec |
|---|---|
| Name | Bold, ~14–16px, truncated with ellipsis after 2 lines (e.g., `AI Impact on Game Dev`) |
| Version + topic count | Small caps muted, e.g., `V4 · 3 TOPICS` |
| Score sparkline | Small inline graph showing score history (last N optimization rounds) — ~40px wide × 16px tall |
| Score number | Right-aligned, e.g., `7.4` (the Theme's most recent composite score) |
| Active state | Dark border / accent border / subtle background fill when this Theme is selected (drives the Topics column to its right) |
| Active actions (visible on selected Theme only) | `EDIT` and `OPTIMIZE →` chip buttons. EDIT opens Theme page editor; OPTIMIZE triggers `factory_theme_propose_optimize` round (per `OPTIMIZATION_LOOP.md` §6.1) |

**Visible Themes in the design** (sample data):
1. AI Impact on Game Dev — V4 · 3 TOPICS — 7.4 (active)
2. Creative Burnout — 7.1
3. Indie Economics 2025 — 6.8
4. Steam Discoverability — 6.2
5. Genre Consolidation — 6.6
6. Publisher Relations — 5.4

Footer: `+ PROPOSE THEMES` button (full-width, dashed border) — triggers `factory_theme_propose_optimize` (multi-iteration, with optional PCP context per `EDITORIAL_ROOM_CONTRACT.md` §6.1 SkillContext).

**Annotation:** *"Creative Burnout moves out of debate column"* — this appears to be a note about UX evolution (an older variant had Creative Burnout shown in the debate panel; B++ moves it back to the Themes list where it belongs).

**Sort order:** by score descending by default; user-pinnable to top. Inferred from "Pinned" semantics implied elsewhere in the doc set; confirm.

---

## 5. Left-center column — Topics under selected Theme

Header: `TOPICS · UNDER AI IMPACT  · 3` — count of Topics under the currently-selected Theme.

Stack of Topic cards, vertically scrollable. Each `TopicCard`:

| Element | Spec |
|---|---|
| Working title | Bold, ~13–14px, truncated to ~2 lines |
| Score sparkline | Smaller than Theme card's, inline |
| Score number | Right-aligned, e.g., `7.8` |
| Active state | Dark border when selected (drives the center detail panel) |

**Visible Topics in the design** (sample data, under "AI Impact on Game Dev"):
1. How Embracer's writedown change[d indie publishing terms] — 7.8 (active)
2. The 6-person studio is the new 20-[…] — 6.6
3. Why AI-art P&L wins on paper, lose[s at funding time] — 6.1

Footer button: `+ PROPOSE TOPICS` (dashed border, "slow path" — triggers single-call `factory_topic_propose` for quick ideation, NOT the multi-iteration optimize round).

**Counter-Topic section** (separator below the Topics list):
- Header: `COUNTER-TOPIC · 1` (in red accent)
- Counter-Topic card: same shape as Topic card but with red accent border
- Visible: `Why AI tooling is overhyped for solo[…]` — 5.8

Counter-Topics are explicitly-flagged contrarian Topics — they argue against the Theme's primary thesis. Used during optimization to preserve range.

---

## 6. Center column — Topic detail (the editorial substrate)

The fat center column. Contains the active Topic's working data: header, scores, one-liner, notes, and panel discussion.

### 6.1 Topic header

| Element | Spec |
|---|---|
| Eyebrow | `TOPIC` (small caps, dark fill chip) |
| Working title | Hand-feel serif, ~24–28px, e.g., `How Embracer's $2.1B writedown changed indie publishing terms` |
| Right action 1 | `+ POINT` chip button — adds a Point under this Topic (jumps to Points workspace with new Point pre-seeded) |
| Right action 2 | `OPTIMIZE TOPIC` chip button — triggers `factory_topic_optimize` round per `OPTIMIZATION_LOOP.md` §6.2 |

### 6.2 Per-persona score row (CRITICAL)

**Annotation:** *"per-persona score is the COLUMN HEADER. compact pills + aggregate. then one-liner directly under."*

This is a horizontal strip. Each primary persona has its own score column header. Columns:

| Persona | Score | Note (italic, small) |
|---|---|---|
| `A ANKIT` | `9` | `"lead with this"` |
| `R RAVI` | `9` | `needs a person` (+ flag indicator) |
| `M MEI` | `7` | `"verify Devolver $5"` |
| `AGGREGATE` | `7.8` | `SSR 0.78 · ✓ GATES` |

Each cell is compact — the avatar+name circle, the score number large, the qualitative note below. The `AGGREGATE` cell sits at the right and shows the rollup score, the SSR likelihood mean across primary personas, and a gate-pass indicator (`✓ GATES` = all hard gates passed).

**Score cell visual logic:**
- Score < 5: red accent
- Score 5–7: neutral
- Score 7+: green/positive accent
- "Needs a person" or similar verbal warnings sit in the note line, not as a separate badge

### 6.3 ONE-LINER

Header: `ONE-LINER` (small caps muted)

Body: the Topic's one-position thesis, ~2–3 lines max, italic. Example:
> *"Surviving studios are signing 2022-rate deals to keep going — Embracer's writedown shifted bargaining power away from devs in a way that's locked in for 18+ months."*

This is the Topic's `compiled_truth.thesis` per `EDITORIAL_ROOM_CONTRACT.md` §3.2. The one-liner is the binding test for "this is a Topic, not a category" (per `THEME_TOPIC_POINTS_DEFINITION.md` §4 Topic test #2: One-position test).

Hover/click: edit inline.

### 6.4 NOTES panel

**Annotation:** *"Notes panel: typed boxes the user adds. NOT a discussion thread. Notes don't have fixed fields — they're note types. user adds whatever's useful."*

Header: `NOTES · 5` (count) — followed by note-type chip buttons:
- `+ ANGLE` (green dot)
- `+ STAKE` (gray dot)
- `+ THOUGHT` (gray dot)
- `+ CONCERN` (red dot)
- `+ OTHER` (gray dot)

Click any chip to add a new note of that type. Notes render in a 2-column grid below.

Each `NoteCard`:

| Element | Spec |
|---|---|
| Type indicator | Colored dot + type label, e.g., `● ANGLE` |
| Status badge | `DEBATED` (small monospaced caps) when the panel discussion below has @-referenced this note. Optional. |
| Body text | The user's freeform note content, ~3 lines max with truncation |
| Hover/click | Expand to full content; edit inline |
| Type colors | ANGLE = green, STAKE = neutral gray, THOUGHT = neutral gray, CONCERN = red, OTHER = gray |

**Visible Notes in the design (sample):**
1. ● ANGLE (DEBATED): "What changed in MG accounting — and why your next deal will look different."
2. ● STAKE: "Mid-tier studios pay; tiny indies get a relative tailwind."
3. ● THOUGHT: "The 'reverts in 18 months' counter is publisher-bias — worth flagging up top."
4. ● CONCERN (DEBATED): "Annapurna staffer (background) contradicts publish filings: VERIFY before draft" (red border emphasizing concern severity)
5. ● THOUGHT: "Devolver Q4 prelim language is ambiguous on conditional MGs."

**Critical UX rule:** Notes are user-authored typed boxes. They are NOT auto-generated from the panel discussion. The user picks the type when adding, writes the content, and that's the durable artifact. The Panel Discussion (§6.5) debates these notes but the notes are independent objects.

**Storage:** Notes map to `point_note_blocks` per `EDITORIAL_ROOM_CONTRACT.md` §4.1, scoped to the Topic (not Point) at this layer. Note `type` enum: `angle | stake | thought | concern | other`. Promotion to `point_note_blocks` (Point-scoped) happens when the user moves a note into a Point's workspace.

### 6.5 PANEL DISCUSSION

**Annotation:** *"AI panel debates the notes above — turns can @reference a note. note + debate is one substrate."*

Header: `PANEL DISCUSSION · 4 TURNS DEBATING NOTES ABOVE` — and right-aligned `LAST 11:47` (timestamp of latest turn).

Discussion is a vertical chat-like list of turns. Each `DiscussionTurn`:

| Element | Spec |
|---|---|
| Avatar | Persona-color monogram circle |
| Name | Bold caps, e.g., `ANKIT` |
| Timestamp | Muted, monospaced, e.g., `11:42` |
| Note references | Inline chip showing which Note was @-referenced, e.g., `↑ note: angle` (clickable, scrolls to that note) — multiple references possible |
| Body | Free text, italic for emotional emphasis where appropriate |
| Proposes | Optional `PROPOSES: ADD: SOLO-DEV CASE STUDY` line (small caps, when the agent proposes a new Note or Point) |

**Visible turns in the design** (4 sample turns spanning ANKIT → RAVI → MEI → ANKIT). The 4th turn references TWO notes (`↑ note: stake ↑ note: concern`) — multi-reference is supported.

This Discussion is the Editorial Room's `editorial_scoped` Discussion per `EDITORIAL_ROOM_CONTRACT.md` §4.4. `talk_kind = 'editorial_scoped'`, scoped to the active Topic with `(piece_id, phase='theme_topic', active_object_kind='topic', active_object_ref=<topic_slug>)`. Hidden from normal Panel Talk lists.

### 6.6 Discussion input

Footer of the center column.

| Element | Spec |
|---|---|
| Input box | Full-width, single-line by default (expands to multi-line on focus). Placeholder: `Ask the panel — or @reference a note above…` |
| Mention chips (left) | `@ALL` `@A` `@R` `@M` `#NOTE` — click to insert a mention into the input. Mentions trigger which agents respond (`@A` = only Ankit-cohort agent), and `#NOTE` opens a picker to reference a specific Note. |
| Send button (right) | `SEND · ⌥↵` — chip-style with keyboard hint. Submitting triggers a panel turn. |

---

## 7. Right rail — Sources

**Annotation:** *"sources move to their own rail. reference material, not debate material."*

Header: `SOURCES · 4` (count) and `+ ADD` button (right).

Stack of `SourceCard`:

| Element | Spec |
|---|---|
| Source ID | `SRC #1`, `SRC #2`, … (monospaced caps, top-left) |
| Type badge | `PRIMARY`, `ANEC`, `SEC` (anecdotal, secondary, etc.) — top-right, monospaced caps |
| Source title | Bold, ~13px, e.g., `Embracer Q3 8-K` |
| Reference detail | Muted, ~12px, e.g., `pp.14-16, MG reclassification` |
| Status badges | `✓ CITED` (green check, when source is referenced in claims_ledger), `! DISPUTED` (red, when another source contradicts it) |

**Visible sources in the design**:
1. SRC #1 PRIMARY · Embracer Q3 8-K · pp.14-16, MG reclassification · ✓ CITED
2. SRC #2 PRIMARY · Devolver Q4 prelim · $5 conditional advances · ✓ CITED · ! DISPUTED
3. SRC #3 ANEC · Annapurna staffer · background, contradicts $2 · ✓ CITED
4. SRC #4 SEC · Game Industry News · Apr 2025 explainer

Below the cards: `DROP FILE OR PASTE URL` drop zone (dashed border) — drag a PDF/file or paste a URL to add as a source. Triggers `factory_claim_research` to extract claims from the source.

### 7.1 INPUTS section

Below sources, separated. Read-only listing of what's feeding the current view:
- `SETUP.AUDIENCE`
- `SETUP.LENGTH`
- `THEME.AI_IMPACT_GAMEDEV`
- `0 PRIOR TOPICS IN LINEAGE` (count of Topics that fed into this one — for novelty tracking)

---

## 8. State coverage

| Surface | Loading | Empty | Error | Success | Partial / degraded |
|---|---|---|---|---|---|
| **Setup chip bar** | Skeleton chips | Setup not yet complete: warning chip `complete setup to score` | Inline retry on chip-fetch failure | Full chips visible | Stale chip: data older than `setup_version` shows `STALE` indicator |
| **Themes column** | Card skeletons (~6) | "No Themes yet — `+ PROPOSE THEMES`" | Inline retry on themes load | Cards visible with scores | Theme score pending: card shows `…` instead of number; sparkline shows skeleton |
| **Topics column** | Card skeletons | "No Topics under this Theme — `+ PROPOSE TOPICS`" | Inline retry | Cards visible | Topic score stale (after Setup change): card border indicates stale |
| **Topic detail header** | Skeleton | "Pick a Topic to start" | Inline error | Title + score row visible | Score pending for some personas: those columns show `…` |
| **Notes panel** | Skeleton boxes (5) | "No notes yet — pick a type to start" with type chips highlighted | Save error inline | Notes visible | Local-unsaved note: `LOCAL` badge until persisted |
| **Panel Discussion** | Skeleton turns | "No discussion yet — ask the panel" | Per-turn error: failed agent shown with retry-individual-agent option | Turns visible | Provider partial failure: turn shows `(MEI: failed)` inline |
| **Sources rail** | Card skeletons (4) | "No sources yet — drop a file or paste a URL" | Source-load error inline | Sources visible | Source unverified: `UNVERIFIED` badge, dimmed |

---

## 9. Data shapes

### 9.1 Reads

| Component | Reads from | Schema |
|---|---|---|
| Themes column | rocketorchestra `theme` pages, scoped to publication | `EDITORIAL_ROOM_CONTRACT.md` §3.1 ThemeCompiledTruth |
| Topics column | rocketorchestra `topic` pages, filtered by `parent_theme_slug` | §3.2 TopicCompiledTruth |
| Topic header scores | clawrocket `score_snapshots`, keyed by Topic slug + setup_version + scoring_pipeline_slug | §4.2 ScoreSnapshot |
| Notes panel | clawrocket `point_note_blocks` (or Topic-scoped equivalent) | §4.1 PointNoteBlock |
| Panel Discussion | clawrocket `discussion_sessions` with `talk_kind='editorial_scoped'`, `phase='theme_topic'` | §4.4 DiscussionSession |
| Sources rail | rocketorchestra `claims_ledger` entries scoped to current Piece + this Topic | §3.8 ClaimsLedgerCompiledTruth |
| Setup chip bar | clawrocket `EditorialPiece.setup_state` | §2.1 SetupState |

### 9.2 Writes

| Action | Writes to |
|---|---|
| Add Theme via `+ PROPOSE THEMES` | Triggers `run_optimization` with `target_kind: theme`, returns `OptimizationRound` (§4.7). On user-pick from top-K, creates new `theme` page via `propose_update` flow (§3 of contract). |
| Add Topic | Same as Theme but `target_kind: topic`. |
| Edit Topic one-liner inline | Updates `topic.compiled_truth.thesis`. Increments page version. |
| Add Note | Inserts new `point_note_blocks` row scoped to active Topic. |
| Send Discussion message | Creates new `DiscussionTurn` in current `discussion_session`. Triggers `run_skill` for each addressed agent. |
| Add Source | If file/URL: triggers `factory_claim_research` Skill. Skill output proposes `claims_ledger` entries; user approves via inbox. |
| `OPTIMIZE TOPIC` action | Triggers `run_optimization` with `target_kind: topic`, parent = current Theme. |

### 9.3 Score row computation

The per-persona score header pulls from the latest non-stale `score_snapshot` for this Topic, where `selected_persona_slugs ⊇ [primary personas]`. Score numbers are the persona's SSR likelihood mean; the qualitative note (`"lead with this"` / `"verify Devolver $5"` / `needs a person`) is generated by the rubric judge or surfaced from counter-audience output.

`AGGREGATE` cell shows:
- Composite score: weighted mean of per-persona scores
- `SSR 0.78` — overall SSR confidence (across personas)
- `✓ GATES` — all hard gates pass; or `✗ GATES (specificity)` if a gate fails

---

## 10. Visual + interaction style

(See `01_setup.md` §10 for the canonical style notes; same rules apply.)

Specific to this screen:
- **Color tokens for note types:** ANGLE green, CONCERN red, others neutral gray. Same color used in the type chip dot, the note card border-left, and the type indicator within Discussion turns.
- **Persona colors recur** through Theme card scores, Topic card scores, score column headers, and Discussion avatars. Same color per persona slug across all surfaces.
- **Sparklines on Theme/Topic cards** are score history trends — last 5–10 optimization rounds. Use a faint line, no axes, just the trend shape.
- **Score row pills** are wider than other chips because they're the visual anchor of the screen. Score number is the largest text on screen besides the Topic title.

---

## 11. Anti-patterns

- **Notes are NOT a discussion thread.** Don't render them as a chat. Each note is a typed durable artifact.
- **Discussion is NOT note-storage.** The Panel Discussion contains commentary and proposals; the durable artifacts are the Notes (and any notes the user *promotes* from a discussion proposal).
- **Sources are reference material, not debate material.** Sources go in the right rail. Don't scatter source links into the Discussion panel.
- **Per-persona scores are column headers, not chips inline with the title.** They are the visual structure of the Topic detail. Compact pills + aggregate; that's the contract.
- **Score row note text is one line, not a tooltip.** "lead with this" / "verify Devolver $5" must be visible without hover. They are the human-readable signal of WHY the persona scored that way.
- **Don't show Theme score and Topic score in the same number space.** Theme cards show the Theme's composite (cross-Topic average); Topic cards show per-Topic. Visually distinguishable by layer.

---

## 12. Open questions

1. **Sparkline data source** — where do the historical scores come from? `optimization_trials` table per round, aggregated weekly? Confirm cadence and storage.
2. **Counter-Topics: separate page kind, or just `topic` with a `counter_topic: true` flag?** Implementation choice. Schema currently has `topic` only. If counter-Topics need different rubric criteria, may want a flag; otherwise just style differently.
3. **`STALE` indicator on chip bar** — does Setup change immediately stale all downstream chips, or only the affected ones (e.g., changing voice doesn't stale the persona chips)? Confirm fineness of staleness.
4. **`+ PROPOSE TOPICS` (single-call)** vs `OPTIMIZE TOPIC` (multi-iteration round) — UI clearly distinguishes them (dashed border for propose, primary button for optimize). Confirm the propose flow returns inline or opens its own modal.
5. **Note multi-reference in Discussion turn** — the design shows `↑ note: stake  ↑ note: concern`. Is the order meaningful, and can a turn reference 0 notes (pure conversation, no note tie-back)? Spec deferred.
6. **Score column headers when persona count > 3** — design shows 3 personas. What happens at max-3-initially limit per `EDITORIAL_ROOM_CONTRACT.md` §2.1 SetupState? Visual works at 3; confirm if 4 is intended for v1 or deferred.

---

## 13. Reference screenshots

- `02_theme_topics_bpp.png` — B++ design (the canvas-rendered wireframe with full annotations)
