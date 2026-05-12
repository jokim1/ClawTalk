# Screen 03 — Points + Outline

**Source design:** PO5+ (chosen direction) — two states `a` (collapsed, default) and `b` (expanded), toggleable via chevron on the divider
**Phase:** 03 POINTS + OUTLINE
**Owner:** clawrocket
**Implementation target:** `webapp/src/pages/PointsOutlineWorkspacePage.tsx`
**Companion contracts:**
- `EDITORIAL_ROOM_CONTRACT.md` §3.3 (`point` page), §4.1 (`PointNoteBlock`), §4.4 (`DiscussionSession`)
- `THEME_TOPIC_POINTS_DEFINITION.md` §5 (Point definition + tests)
- `OPTIMIZATION_LOOP.md` §6.3 (Point optimization)

---

## 0. What this screen is

The Points + Outline workspace is where a Topic gets decomposed into 3–7 Points (per `THEME_TOPIC_POINTS_DEFINITION.md` §5) and assembled into an Outline. Per the design label: *"PO5 with a chevron toggle on the divider. Default = notes-as-rail; click ‹ (or ⌘]) and notes take the center while Discussion collapses to a quiet bottom drawer. One mental model."*

The screen has **one mental model** — Points list on the left, active-Point detail in the middle, Notes and Discussion related to the active Point — but **two layout states** that adapt to which surface the user wants in focus:

- **PO5+ a (default):** Notes are a quiet right rail; Discussion takes the main center. Use this when the user is actively debating Points with the panel.
- **PO5+ b (expanded):** Notes take the center; Discussion collapses to a quiet bottom drawer that never disappears. Use this when the user is heads-down editing notes.

The toggle is a single chevron on the divider between center and right rail. Click `‹` (or press `⌘]` / drag divider) to expand notes to center. Click `›` (or `⌘[` / drag) to collapse back.

**Critical design intent (from annotations):** *"panel never disappears, just gets quieter"* — even in expanded mode, the panel is reachable via the bottom drawer. The user can always see the latest Discussion turn summarized in a single line.

---

## 1. Layout — same shell, two states (chevron-toggleable)

### 1.1 Common shell (both states)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [ER] Editorial Room v0P    01 SETUP | … | 03 POINTS + OUTLINE | … | 06 SHIP    ⌘K OPTIMIZE POINTS → SAVE │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ UNDER TOPIC: How Embracer's $2.1B writedown changed indie publishing terms          │
│ 5 POINTS · 1 COUNTER · 2 REJECTED · DRAG TO REORDER                       ← BACK    │
├─────────────────┬────────────────────────────────────────────────────────────────────┤
│ Points · Outline│           [center column varies by state — see 1.2 / 1.3]          │
│ tabs            │                                                                    │
│                 │                                                                    │
│ 01 HOOK    8.1  │                                                                    │
│ 02 ARG     7.6  │                                                                    │
│ 03 ARG     7.2  │                                                                    │
│   (active)      │                                                                    │
│ 04 ARG     6.8  │                                                                    │
│ 05 CLOSE   6.2  │                                                                    │
│                 │                                                                    │
│ COUNTER-POINTS  │                                                                    │
│ 06 COUNTER 3.4  │                                                                    │
└─────────────────┴────────────────────────────────────────────────────────────────────┘
```

**Width allocations:**
- Left rail (Points/Outline): ~210px fixed
- Right side (center + notes + drawer): flex 1, layout adapts to state

### 1.2 State `a` — COLLAPSED (default)

Notes-as-right-rail, Discussion-in-center.

```
┌─────────────┬──────────────────────────────────────────────────┬────────────────┐
│ Points list │ POINT 1 · HOOK  · SCOPED TO → DEBATE ACTIVE      │ NOTES · 4      │
│ (see 1.1)   │                                                  │      ↓ CHRONO  │
│             │ A ANKIT 8   R RAVI 8   M MEI 8   8.1 SSR 0.81 ✓G │                │
│             │ "lead-with"  "make deal-shape"  "8-K supports"   │ T C E Q O … +  │
│             │                                                  │                │
│             │ CLAIM                                            │ ┌────────────┐ │
│             │ Deal-term lockdown: 2022-rate MGs are now the    │ │C·CLAIM 11:32│ │
│             │ ceiling, not the floor.                          │ │MG itself is│ │
│             │                                                  │ │now reclass.│ │
│             │ STAKE: Hook — open with reclassification.        │ │as cond.    │ │
│             │                              4 NOTES             │ │liability…  │ │
│             │                                                  │ ├────────────┤ │
│             │ PANEL DISCUSSION · 4 TURNS                       │ │E·EVIDENCE  │ │
│             │                  LAST 11:47  @ALL @A @R @M       │ │11:38       │ │
│             │                                                  │ │Embracer Q3 │ │
│             │ A ANKIT · STRATEGIST                             │ │8-K pp.14-16│ │
│             │ The reclassification is the right load-bearing   │ │explicit re-│ │
│             │ hook. Make sure §1 names it explicitly — readers │ │class. lang.│ │
│             │ will skim the others.                            │ ├────────────┤ │
│             │ + OPEN WITH THE RECLASSIFICATION                 │ │!·COUNTER   │ │
│             │                                                  │ │PROMOTE › 11│ │
│             │ R RAVI · NARRATIVE                               │ │:41         │ │
│             │ Pushing back: I want a person in this paragraph. │ │Annapurna   │ │
│             │ The reclassification is correct but bloodless.   │ │staffer:    │ │
│             │ The Annapurna note is the human edge — use it.   │ │this is     │ │
│             │                                                  │ │overstated  │ │
│             │ M MEI · ANALYST                                  │ ├────────────┤ │
│             │ Devolver prelim $5 is ambiguous — I'd cite       │ │Q·QUESTION  │ │
│             │ Embracer 8-K only and add Devolver as 'see also' │ │11:43       │ │
│             │ + DOWNGRADE DEVOLVER TO SEE-ALSO                 │ │Holds for   │ │
│             │                                                  │ │sub-$200K MG│ │
│             │ A ANKIT · STRATEGIST                             │ │deals, or   │ │
│             │ Ravi's right that this needs a person. But       │ │only mid-   │ │
│             │ promote that note as a Counter, not as the lead  │ │tier?       │ │
│             │ — the lead is the deal shape.                    │ │            │ │
│             │ + PROMOTE ANNAPURNA NOTE → COUNTER               │ │+ NOTE ·    │ │
│             │                                                  │ │PICK TYPE   │ │
│             │                                              ‹   │ │ABOVE       │ │
│             │                                          (chevron│ │            │ │
│             │                                          on divider)│            │ │
└─────────────┴──────────────────────────────────────────────────┴────────────────┘
```

Width: center ~620px, right rail ~260px.

### 1.3 State `b` — EXPANDED (notes-as-center, discussion-in-drawer)

```
┌─────────────┬──────────────────────────────────────────────────────────────┐
│ Points list │ POINT 1 · HOOK  · SCOPED TO → DEBATE ACTIVE                  │
│ (see 1.1)   │ A ANKIT 8   R RAVI 8   M MEI 8   8.1 SSR 0.81 ✓ GATES        │
│             │                                                              │
│             │ CLAIM   Deal-term lockdown: 2022-rate MGs are now ceiling.   │
│             │ STAKE   Hook — open with reclassification.    3 NOTES        │
│             │                                                              │
│             │ NOTES EXPANDED · DISCUSSION IN DRAWER BELOW    › COLLAPSE TO │
│             │                                                  RAIL · ⌘[  │
│             │ NOTES · 4 TYPING LAYER · SCOPED TO POINT 1                   │
│             │                                          FILTER: T C E Q O +│
│             │                                                              │
│             │ ┌──────────────────────────────────────────────────────────┐ │
│             │ │C · CLAIM                                       11:32     │ │
│             │ │MG itself is now reclassified as a conditional liability  │ │
│             │ │under the post-Embracer accounting framework. That's the  │ │
│             │ │structural change, not the writedown itself.              │ │
│             │ ├──────────────────────────────────────────────────────────┤ │
│             │ │E · EVIDENCE                                    11:38     │ │
│             │ │Embracer Q3 8-K · pp.14-16: explicit reclassification     │ │
│             │ │language. Devolver Q4 prelim $5 echoes the change.        │ │
│             │ │Take-Two K-1 silent (different acct treatment).           │ │
│             │ ├──────────────────────────────────────────────────────────┤ │
│             │ │! · COUNTER                          PROMOTE ›  11:41     │ │
│             │ │Annapurna staffer (background): this is overstated —      │ │
│             │ │they're still signing pre-Embracer-shape deals at unchang.│ │
│             │ │MG ratios. The reclassification may not be universal.     │ │
│             │ ├──────────────────────────────────────────────────────────┤ │
│             │ │Q · QUESTION                                    11:43     │ │
│             │ │Does this hold for sub-$200K MG deals, or only mid-tier   │ │
│             │ │where Embracer was active? Worth a sidebar to a small-    │ │
│             │ │studio publisher.                                         │ │
│             │ └──────────────────────────────────────────────────────────┘ │
│             │                                                              │
│             │ + NEW NOTE · PICK A TYPE ABOVE                               │
│             │                                                              │
│             ├──────────────────────────────────────────────────────────────┤
│             │ ▼ PANEL DISCUSSION · scoped to Point 1 · last turn 11:47    │
│             │   "Ravi's right that this needs a person… ⌘O to expand"     │
└─────────────┴──────────────────────────────────────────────────────────────┘
```

Width: center now ~880px (was center + right combined). Drawer: full center-width, ~80px tall when collapsed (1-line summary), expandable to original Discussion height on click.

---

## 2. Top header

Same `EditorialPhaseStripWithMeta` component. `03 POINTS + OUTLINE` is the active pill. Right action: `OPTIMIZE POINTS →` triggers `factory_point_optimize` round per `OPTIMIZATION_LOOP.md` §6.3.

---

## 3. Sub-meta bar

Single line below header.

| Element | Spec |
|---|---|
| Eyebrow | `UNDER TOPIC:` (small caps muted) |
| Topic title | `How Embracer's $2.1B writedown changed indie publishing terms` (full title; click navigates back to Theme/Topics workspace with this Topic active) |
| Status pip | `5 POINTS · 1 COUNTER · 2 REJECTED · DRAG TO REORDER` (count of Points by status; reorder hint) |
| Right action | `← BACK` chip (returns to Theme/Topics workspace) |

The "DRAG TO REORDER" hint indicates Points are reorderable in the left rail. Reordering changes their Outline position.

---

## 4. Left rail — Points list (with Outline tab)

Tabs at top: `Points 8` | `Outline · 5/5-7` | `+ POINT` | `OPT...`

The `Points` tab shows ALL Points (active + parked + rejected); the `Outline` tab shows just the Points selected for the Outline (the assembly view, e.g., "5 of 5–7 in outline"). Default tab: `Points`.

`+ POINT` adds a new blank Point. `OPT...` (truncated; probably `OPTIONS` or `OPTIMIZE`) — confirm intended action.

### 4.1 Point card structure

Each Point in the list:

| Element | Spec |
|---|---|
| Position number | `01`, `02`, `03`, … (monospaced caps; reflects Outline order) |
| Type label | `HOOK` / `ARGUMENT` / `CLOSE` / `COUNTER` (small caps, color-coded by type) |
| Score | Right-aligned, e.g., `8.1` |
| Claim line (1) | Bold, ~13px, e.g., `Deal-term lockdown: 2022-rate MGs are now the ceiling, not the floor.` |
| Stake line (2) | Italic, smaller, e.g., `Hook — open with reclassification.` |
| Note count | Footer-left, `4 NOTES` (small caps muted; click jumps to Notes panel scoped to this Point) |
| Active state | Red border (or accent border) when this Point is the one being detailed in the center |
| Drag handle | Hover-revealed left edge handle for reordering |

**Visible Points in the design** (sample data, under "How Embracer's writedown…"):
1. 01 HOOK · 8.1 · "Deal-term lockdown: 2022-rate MGs are now the ceiling, not the floor." · "Hook — open with reclassification." · 4 NOTES
2. 02 ARGUMENT · 7.6 · "MG-as-conditional-liability is the load-bearing accounting change." · "The accounting that holds the lockdown in place." · 3 NOTES
3. 03 ARGUMENT · 7.2 · "Mid-tier studios pay; sub-10-person studios get a tailwind." · "Stakes paragraph — name the cohort split." (active)
4. 04 ARGUMENT · 6.8 · "The 18-month lock-in is structural, not cyclical." · "Counter the cyclical read." · 2 NOTES
5. 05 CLOSE · 6.2 · "Recoupment-rate creep is the next shoe to drop." · "Forward-looking close." · 1 NOTE

Below the main list, separator + heading `COUNTER-POINTS · 1`:
6. 06 COUNTER · 3.4 · "Embracer's writedown is a one-off; nothing structural changed." · (red border — counter-Point styling)

### 4.2 Drag-to-reorder

Vertical drag with subtle insert-line indicator. Reordering updates Outline order. The position number (`01`, `02`, …) updates live. Counter-Points are in their own section and don't share order with main Points.

---

## 5. Center column — Active Point detail

Renders the Point currently selected in the left rail. Shape is similar to the Topic-detail center column from `02_theme_topics.md` but scoped to a Point.

### 5.1 Point header

| Element | Spec |
|---|---|
| Eyebrow | `POINT 1 · HOOK · SCOPED TO → DEBATE ACTIVE` (status indicator: this Point's discussion is currently in active debate) |

### 5.2 Per-persona score row

Same shape as the Topic score row in `02_theme_topics.md` §6.2. Persona avatar + name + score + qualitative note. Right-side: aggregate score + SSR confidence + gates pass.

Visible (Point 1 sample):
| Persona | Score | Note |
|---|---|---|
| `A ANKIT` | `8` | `lead-with material — strongest hook` |
| `R RAVI` | `8` | `Make the deal-shape concrete.` |
| `M MEI` | `8` | `8-K supports it cleanly. Cite pp.14-16.` |
| `AGGREGATE` | `8.1` | `SSR 0.81 · ✓ GATES` |

### 5.3 Claim + Stake

Two-line structure showing the Point's binding content per `EDITORIAL_ROOM_CONTRACT.md` §3.3 PointCompiledTruth:

| Element | Spec |
|---|---|
| `CLAIM` | Bold serif, the Point's `claim` field (one-sentence assertion). E.g., `Deal-term lockdown: 2022-rate MGs are now the ceiling, not the floor.` |
| `STAKE` | Italic, the Point's `rationale` (what it argues / why it matters). E.g., `Hook — open with reclassification.` |
| Notes count | `4 NOTES` (right-aligned next to STAKE). Click toggles the right-rail Notes filter to "scoped to Point 1." |

Click either line to edit inline.

### 5.4 (State `a` only) PANEL DISCUSSION

In state `a`, Discussion takes the main center area below the Claim/Stake.

**Annotation:** *"Discussion is the main center. Make sure (panel discussion comes 1st under the title)"* — Discussion is the primary editorial activity in this state.

Header: `PANEL DISCUSSION · 4 TURNS` and right-aligned timestamp + mention chips: `LAST 11:47  @ALL @A @R @M`

Discussion turns render as in `02_theme_topics.md` §6.5: avatar, name + role tag, body, optional `+ ACTION` proposal chip.

**Visible turns in the design** (4 sample turns, all scoped to Point 1):
1. **A ANKIT · STRATEGIST**: "The reclassification is the right load-bearing hook. Make sure §1 names it explicitly — readers will skim the others." → `+ OPEN WITH THE RECLASSIFICATION`
2. **R RAVI · NARRATIVE**: "Pushing back: I want a person in this paragraph. The reclassification is correct but bloodless. The Annapurna note is the human edge — use it."
3. **M MEI · ANALYST**: "Devolver prelim $5 is ambiguous — I'd cite Embracer 8-K only and add Devolver as 'see also'." → `+ DOWNGRADE DEVOLVER TO SEE-ALSO`
4. **A ANKIT · STRATEGIST**: "Ravi's right that this needs a person. But promote that note as a Counter, not as the lead — the lead is the deal shape." → `+ PROMOTE ANNAPURNA NOTE → COUNTER`

**Role tag** after persona name (e.g., `STRATEGIST`, `NARRATIVE`, `ANALYST`) is the agent's stance/role in the panel — pulled from `agent_profile.stance` per `EDITORIAL_ROOM_CONTRACT.md` discussion turn shape.

**Proposal chips** (`+ OPEN WITH THE RECLASSIFICATION`, `+ DOWNGRADE DEVOLVER TO SEE-ALSO`, `+ PROMOTE ANNAPURNA NOTE → COUNTER`) are agent-proposed actions. Click accepts the proposal — applies the suggested change to the Point or note structure. `proposal_kind` per `EDITORIAL_ROOM_CONTRACT.md` §4.5 ProposalCard.

### 5.5 (State `b` only) NOTES taking center

When chevron-toggled to state `b`, the Discussion is replaced by the Notes panel in expanded form. See §7.

---

## 6. Right rail — Notes (state `a` only) / NOT visible in state `b`

**Annotation (state `a`):** *"Notes are a quiet right rail. compact cards · always visible."*

Header: `NOTES · 4` with sort indicator `↓ CHRONO` (sorted chronologically, descending). Right of the count: filter chips for note types — `T  C  E  Q  O  …  +` (compact one-letter codes; click toggles filter). The `+` button adds a new note (opens type picker).

Stack of `NoteCard` (compact form):

| Element | Spec |
|---|---|
| Type indicator | One-letter code in a small pill: `C` (Claim), `E` (Evidence), `T` (Thought), `Q` (Question), `O` (Other), `!` (Counter) — color-coded by type |
| Type label + timestamp | E.g., `C · CLAIM   11:32` (small caps, monospaced timestamp) |
| Promote indicator | Counter-type notes have a `PROMOTE ›` chip on the same line (allows promoting the note to a Counter-Point) |
| Body | Note content, ~3 lines max with truncation |
| Active note | Red border on the note that's currently being referenced in Discussion; e.g., the COUNTER note in this design has red border because it's the subject of debate |

**Visible notes in the design (state `a` compact form):**
1. `C · CLAIM` 11:32 — "MG itself is now reclassified as a conditional liability under the post-Embracer framework."
2. `E · EVIDENCE` 11:38 — "Embracer Q3 8-K · pp.14-16: explicit reclassification language. Devolver Q4 prelim $5 echoes."
3. `! · COUNTER  PROMOTE ›` 11:41 — "Annapurna staffer (background): this is overstated — still signing pre-Embracer-shape deals." (red border)
4. `Q · QUESTION` 11:43 — "Holds for sub-$200K MG deals, or only mid-tier where Embracer was active?"

Footer: `+ NOTE · PICK A TYPE ABOVE` (dashed border button — click and then pick one of the type chips above to instantiate).

Notes here are scoped to the active Point (changes when user picks a different Point in the left rail). Storage: `point_note_blocks` per `EDITORIAL_ROOM_CONTRACT.md` §4.1 with `point_ref = <active_point_slug>`.

---

## 7. Center column expanded (state `b`) — Notes-as-center + Discussion drawer

**Annotation (state `b`):** *"Notes now takes the FULL center"* and *"compact cards still — but more breathing room — not identical to PO4. shape adapts to the room it has."*

When chevron toggles to expanded:

### 7.1 Header changes

After the Claim/Stake row (still visible at top), the center transitions:

| Element | Spec |
|---|---|
| Status banner | `NOTES EXPANDED · DISCUSSION IN DRAWER BELOW` (small caps muted, full-width line) |
| Right action | `› COLLAPSE TO RAIL · ⌘[` chip button (chevron flipped — clicks return to state `a`) |
| Notes section header | `NOTES · 4 TYPING LAYER · SCOPED TO POINT 1` (note the explicit "scoped to Point 1" label — clearer in expanded form) |
| Filter row | `FILTER: T  C  E  Q  O  +` chip filters (same as right rail in state `a`) |

### 7.2 Note cards (expanded)

Same data as state `a` notes but rendered with **more breathing room**:
- Larger padding inside cards
- Body text shows full content (no truncation)
- Cards span full center width
- Vertical stack with subtle separator

The annotation explicitly says *"compact cards still — but more breathing room — not identical to PO4. shape adapts to the room it has."* Don't render notes as a different visual shape; render them as the same card pattern with a different padding/typography density.

**Visible notes (state `b` expanded form, same content with more text visible):**
1. `C · CLAIM  11:32` — "MG itself is now reclassified as a conditional liability under the post-Embracer accounting framework. That's the structural change, not the writedown itself."
2. `E · EVIDENCE  11:38` — "Embracer Q3 8-K · pp.14-16: explicit reclassification language. Devolver Q4 prelim $5 echoes the change. Take-Two K-1 silent (different acct treatment)."
3. `! · COUNTER  PROMOTE ›  11:41` — "Annapurna staffer (background): this is overstated — they're still signing pre-Embracer-shape deals at unchanged MG ratios. The reclassification may not be universal." (red border maintained)
4. `Q · QUESTION  11:43` — "Does this hold for sub-$200K MG deals, or only mid-tier where Embracer was active? Worth a sidebar to a small-studio publisher."

Footer: `+ NEW NOTE · PICK A TYPE ABOVE` (full-width dashed button).

### 7.3 Discussion drawer (bottom)

**Annotation:** *"Discussion collapsed to a quiet bottom drawer. still scoped to the active Point. 1-line summary visible · click to expand. panel never disappears, just gets quieter."*

A horizontal bar fixed to the bottom of the center column.

| Element | Spec |
|---|---|
| Expand chevron | `▼` (clicks expand the drawer back to full Discussion view, while keeping notes visible if vertical space allows; or animate the column back to state `a` layout) |
| Status line | `PANEL DISCUSSION · scoped to Point 1 · last turn 11:47` (small caps muted) |
| Latest turn summary | Italic, single-line truncation, e.g., `"Ravi's right that this needs a person… ⌘O to expand"` |

The drawer is ~60–80px tall when collapsed (showing one line). Click anywhere on the drawer expands it (or returns to state `a` layout — implementation choice; see open question §13.3).

The keyboard hint `⌘O` opens the Discussion (alternative to clicking).

---

## 8. Chevron toggle (the divider control)

**Annotation:** *"the divider has a chevron. click to expand notes to center. or ⌘] / drag the divider"* (state `a`) and *"chevron flipped: click to collapse back to rail. or ⌘[ / drag the divider"* (state `b`).

Implementation:

| Element | Spec |
|---|---|
| Position | Vertical divider line between center column and right rail (state `a`) / between Notes-center and (notional) right edge (state `b`) |
| Chevron | Small button overlapping the divider, vertically centered (mid-height) |
| State `a` icon | `‹` (points left → click expands left, i.e., notes take center) |
| State `b` icon | `›` (points right → click collapses notes back to right rail) |
| Keyboard | `⌘]` toggles to state `b` from state `a`; `⌘[` toggles back to state `a` from state `b` |
| Drag | Click + drag the divider horizontally to gradually grow/shrink the notes column. Beyond a width threshold (e.g., notes width > center width), snap to state `b`. Below threshold, snap to state `a`. |
| Animation | Smooth 200ms ease as widths change |

The toggle is a **layout state**, not a separate route. The data on screen (active Point, notes, Discussion turns) is identical in both states — only the visual prominence changes. State persists per-user as a UI preference (recall on next visit).

---

## 9. State coverage

(Both layout states share the same loading/empty/error/success/partial behavior on individual components.)

| Surface | Loading | Empty | Error | Success | Partial / degraded |
|---|---|---|---|---|---|
| **Points list (left)** | Card skeletons | "No Points yet — `+ POINT` to start" | Inline retry | Cards visible with scores | Stale score (after Setup change): card border shows stale indicator |
| **Active Point detail** | Skeleton heading + score row | "Pick a Point to start" | Inline error | Heading + scores + claim/stake visible | Some persona scores pending (`…` in cell) |
| **Notes (state `a` rail)** | Compact card skeletons | "No notes yet — `+` then pick a type" | Inline retry | Notes visible | Local-unsaved note: `LOCAL` badge |
| **Notes (state `b` center)** | Expanded card skeletons | Same empty as state `a` but full-width | Same | Same | Same |
| **Panel Discussion (state `a` center)** | Turn skeletons | "No discussion yet — ask the panel" | Per-turn error: agent-failed shows retry-individual-agent | Turns visible | Provider partial failure: turn shows `(MEI: failed)` inline |
| **Discussion drawer (state `b`)** | "Loading panel…" placeholder | "No discussion yet" with hint to open and ask | Inline error | Latest-turn summary visible | Stale: drawer shows `STALE` indicator |
| **Chevron divider** | n/a | n/a | n/a | Always reachable | If layout-state save fails, drawer state defaults to last-known good |

---

## 10. Data shapes

### 10.1 Reads

| Component | Reads from | Schema |
|---|---|---|
| Points list | rocketorchestra `point` pages, filtered by `parent_topic_slug` | `EDITORIAL_ROOM_CONTRACT.md` §3.3 PointCompiledTruth |
| Active Point detail | Same as above for the selected Point | §3.3 |
| Per-persona score row | clawrocket `score_snapshots`, keyed by Point slug + setup_version + scoring_pipeline_slug | §4.2 ScoreSnapshot |
| Notes (both states) | clawrocket `point_note_blocks`, scoped to active point | §4.1 PointNoteBlock |
| Panel Discussion | clawrocket `discussion_sessions` with `talk_kind='editorial_scoped'`, `phase='points'`, `active_object_kind='point'`, `active_object_ref=<point_slug>` | §4.4 DiscussionSession |

### 10.2 Writes

| Action | Writes to |
|---|---|
| `+ POINT` | Creates new `point` page via `propose_update`. New Point appears in left rail. |
| `OPTIMIZE POINTS →` | Triggers `run_optimization` with `target_kind: point`, parent = current Topic. Top-K returned for user pick. |
| Drag-reorder Points | Updates each Point's `outline_position` field (or analogous; exact field deferred). |
| Add Note (any state) | Inserts new `point_note_blocks` row scoped to active Point with `type` set to picked note type. |
| Edit Claim/Stake inline | Updates `point.compiled_truth.claim` / `rationale`. Increments page version. |
| Send Discussion message | Creates `DiscussionTurn` in active session. Triggers `run_skill` for addressed agents. |
| Accept proposal chip (e.g., `+ PROMOTE ANNAPURNA NOTE → COUNTER`) | Triggers the proposed action: in this case, mutates the note's `type` to `counter` AND marks the note as promoted to Counter-Point candidate. ProposalCard recorded per §4.5. |
| Toggle chevron / drag divider | Writes to user UI prefs (per-user, not per-Piece): `editorial_room.points_outline.layout_state = 'a' | 'b'` and `notes_pane_width = <px>`. |

### 10.3 Counter-Point promotion

Notes of type `! · COUNTER` have a `PROMOTE ›` chip. Click promotes the note into a full Counter-Point (`point` page with `kind: counter` or analogous). This is the path from "the panel raised a counter to my Point" → "I'm going to argue against this Counter explicitly in the Outline."

---

## 11. Visual + interaction style

(Inherits from `01_setup.md` §10 and `02_theme_topics.md` §10. Specifics for this screen:)

- **Note type colors are durable** across both states. `C` blue (Claim), `E` green (Evidence), `T` neutral (Thought), `Q` purple (Question), `!` red (Counter), `O` gray (Other). Colors stay consistent in compact (state `a`) and expanded (state `b`) cards. Confirm with palette.
- **The chevron control is small but discoverable.** Use a slightly accented background on the divider so the user notices the chevron exists. The drag affordance kicks in on hover (cursor changes to `col-resize`).
- **Drawer animation matters.** State transition `a → b` and `b → a` should be a smooth 200ms ease. Janky transitions undermine the "one mental model, two adapted layouts" framing.
- **Active Point border is the primary visual anchor.** When the user looks at the Points list, the active Point should be unmistakable (red border, slightly heavier weight, possibly a left-edge accent stripe).

---

## 12. Anti-patterns

- **The chevron is a layout toggle, not a navigation.** Don't route to a different page when the user clicks the chevron. Same data, same scope, just different prominence.
- **Notes don't become Discussion when expanded.** The note cards remain note cards. Don't collapse them into a chat-like list when the column gets wider.
- **Discussion drawer never disappears.** Even at `display: none`-equivalent depths, the drawer summary stays visible. Annotation explicitly: *"panel never disappears, just gets quieter."*
- **Note types are not free-form.** The user picks from the fixed enum (`angle/stake/thought/concern/other` for Topic notes; `claim/evidence/thought/question/counter/other` for Point notes). If users need a type that doesn't exist, they pick `OTHER` and add to the body. **Don't add a "custom type" field.**
- **Counter-Points are visually distinct, not buried.** They get their own section in the Points list with a divider. Red accent on the card. Don't mix them into the main Points list as just-another-Point.
- **Drag-reorder is for Outline order, not type changes.** Dragging an ARGUMENT card doesn't turn it into a HOOK because it's now first. The position number updates but the TYPE label stays.

---

## 13. Open questions

1. **`OPT...` button in left rail tabs** — what's the intended action? Optimize points (same as the header `OPTIMIZE POINTS →` button)? Options menu (settings, filters, sorting)? Confirm and rename.
2. **Counter-Point as `point.kind = 'counter'` vs separate page type?** Schema currently has `point` only (`EDITORIAL_ROOM_CONTRACT.md` §3.3). If counter-Points need different rubric criteria, may want a `kind` field on point. Confirm.
3. **State-`b` drawer expand behavior** — when user clicks the drawer to expand, does it (a) animate up to take half the column (notes shrink), or (b) snap back to state `a` layout? Current spec leans toward (b) for simplicity; (a) is more nuanced. Confirm.
4. **`SCOPED TO → DEBATE ACTIVE` status indicator** — what triggers `DEBATE ACTIVE`? Recent turn within N minutes? An agent-flagged "still discussing"? Confirm semantic.
5. **Note multi-select for batch operations** — design doesn't show a multi-select state. Likely deferred. Confirm.
6. **Tab `Outline · 5/5-7`** — the `5/5-7` notation means "5 in outline, target 5–7." When the user has fewer than 5, the tab says `3/5-7`. When they have 7, `7/5-7`. When they have 8 (over target), `8/5-7` with warning indicator? Clarify.

---

## 14. Reference screenshots

- `03_points_outline_po5p.png` — single image containing both states `a` (left) and `b` (right) side-by-side
