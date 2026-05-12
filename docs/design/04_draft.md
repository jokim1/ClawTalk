# Screen 04 — Draft

**Source design:** D3++ · "Optimize as a single unified action" (with D3+ as reference for the pre-unified action chip state)
**Phase:** 04 DRAFT
**Owner:** clawrocket
**Implementation target:** `webapp/src/pages/DraftWorkspacePage.tsx`
**Companion contracts:**
- `EDITORIAL_ROOM_CONTRACT.md` §3.4 (`draft` page), §4.3 (`DraftSegment`), §4.4 (`DiscussionSession`), §4.7 (`OptimizationRound`)
- `OPTIMIZATION_LOOP.md` §6.4 (Draft optimization), §10b (two-track scoring)
- `03_points_outline.md` (the upstream Points + Outline screen that feeds this draft)

---

## 0. What this screen is

The Draft workspace is where the approved Outline becomes prose. Per the design label: *"draft prose center · outline rail left · panel chat right · one fat OPTIMIZE button up top that is scope-aware."*

The Draft screen is structurally similar to a long-form editor (think: Notion / Substack composer) but with two non-obvious additions: (1) the **Outline rail on the left** doubles as a navigation map AND a per-segment score panel, and (2) the **Panel chat on the right** stays scoped to whatever segment the cursor is in.

**Critical design intent (from D3++ annotations):**

> *"OPTIMIZE = autoresearch + autonovel + multi-pass. one button, scope-aware. picks behavior from selection size."*

> *"popover previews what optimize will do AT THIS SCOPE. multi-pass researches + supporting + counter · proposes 2-3 alternatives. not a phase, just a heavier action."*

> *"scope chip top-right reflects it. no selection = whole draft."*

The unified `+ OPTIMIZE` action replaces the cluster of separate "researc.", "novel", "multi-pass", "alternatives" chips that earlier versions (D3, D3+) had. One button, one popover, one cost preview, one Run. Scope is detected from cursor selection.

---

## 1. Layout — three columns + top header + action toolbar

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ [ER] Editorial Room v0P    01 SETUP | … | 04 DRAFT | … | 06 SHIP    ⌘K OPTIMIZE DRAFT → SAVE │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ UNDER OUTLINE: How Embracer's $2.1B writedown changed indie publishing terms · 5 POINTS  │
│ 1,247 / 1,200–1,400 WORDS · 7.6 SSR · ✓ GATES · LAST AUTOSAVE 11:52    ← BACK            │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ FULL DRAFT ⌘D   POLISH ⌘P   EXPAND ⌘E   → CONTINUE ⌘\   ? MISSING ⌘M   ┃   + OPTIMIZE ⌘O    SCOPE: WHOLE DRAFT │
├──────────┬───────────────────────────────────────────────────────────┬─────────────────┤
│ OUTLINE  │ PARAGRAPH 3 OF 12 · POINT 1 · HOOK                        │ PANEL · @POINT 1│
│  · 5/5-7 │                                                           │     LAST 11:54  │
│          │ When Embracer wrote down $2.1B last quarter, the surviv-  │                 │
│ ◉01 HOOK │ ing indie studios noticed a different number first: the   │ A ANKIT         │
│   8.1    │ MG. Recoupment terms that would have been "competitive"   │ STRATEGIST      │
│   3 ¶    │ in 2022 are now the ceiling, not the floor. The writedown │ "the lede works.│
│ ◌02 ARG  │ itself isn't structural; the reclassification is.         │ but §2 needs a  │
│   7.6    │                                                           │ person — Ravi   │
│   3 ¶    │ For the studios that signed in 2024-2025, this isn't      │ called this in  │
│ ◌03 ARG  │ news. They lived through the conversion. But for anyone   │ POINTS too."    │
│   7.2    │ entering negotiations now, the deal shape has hardened    │ + JUMP TO §2    │
│   2 ¶    │ in ways that weren't visible when Embracer announced.     │                 │
│ ◌04 ARG  │                                                           │ R RAVI          │
│   6.8    │ █ ← CURSOR HERE                                           │ NARRATIVE       │
│   2 ¶    │                                                           │ "the second     │
│ ◌05 CLOSE│ The structural change has three components, and they      │ paragraph is    │
│   6.2    │ compound. First, MG itself has been reclassified as a     │ bloodless. who  │
│   2 ¶    │ conditional liability under post-Embracer accounting…     │ is signing?     │
│          │                                                           │ name them."     │
│ COUNTER  │                                                           │ + ADD A PERSON  │
│ ◌06 CTR  │ [continues for 12 paragraphs total]                       │                 │
│   3.4    │                                                           │ M MEI           │
│   1 ¶    │                                                           │ ANALYST         │
│          │                                                           │ "8-K cite is    │
│          │                                                           │ correct. ¶3 is  │
│          │                                                           │ where I'd put   │
│          │                                                           │ pp.14-16."      │
│          │                                                           │                 │
│          │                                                           │ ─── + ASK ───   │
└──────────┴───────────────────────────────────────────────────────────┴─────────────────┘
```

**Width allocations:**
- Left rail (Outline): ~210px fixed
- Center column (draft prose): flex 1 (~720–880px depending on viewport)
- Right rail (Panel chat): ~280px fixed

The layout is **same shape as Points + Outline state `a`** — same proportions, same header rhythm. By Draft phase the user should not have to re-learn a new layout; it's the same mental model with the substrate shifted from "notes about a Point" to "prose for the Outline."

---

## 2. Top header

Same `EditorialPhaseStripWithMeta` component as screens 01–03. `04 DRAFT` is the active pill. Right action: `OPTIMIZE DRAFT →` triggers the same optimize action as the toolbar `+ OPTIMIZE` button but with `scope = whole draft` always (independent of cursor selection).

---

## 3. Sub-meta bar

Single line below header.

| Element | Spec |
|---|---|
| Eyebrow | `UNDER OUTLINE:` (small caps muted) |
| Outline title | `How Embracer's $2.1B writedown changed indie publishing terms · 5 POINTS` (click navigates back to Points + Outline workspace with this Outline active) |
| Status pip | `1,247 / 1,200–1,400 WORDS · 7.6 SSR · ✓ GATES · LAST AUTOSAVE 11:52` (live word count vs setup target, current SSR aggregate, gate-pass indicator, autosave timestamp) |
| Right action | `← BACK` chip (returns to Points + Outline workspace) |

The word count uses the Setup-defined target range (`1,200–1,400 WORDS` from `01_setup.md` Deliverable section). Color thresholds: gray within range, amber when 0–10% over/under, red when >10% out of range.

**No target set (edge case).** When Setup hasn't defined a word target (incomplete Setup, deliverable type without a default range, Setup reset), render the status pip without the slash: `1,247 WORDS · ⚠ NO TARGET · 7.6 SSR · ✓ GATES · LAST AUTOSAVE 11:52`. The `⚠ NO TARGET` chip is clickable; click navigates to Setup → Deliverable section so the user can fill it in. We don't hard-block drafting — some workflows draft first and scope after — but we surface the missing signal because word-count target is a scoring input, not just decoration.

---

## 4. Action toolbar (the row D3++ unifies)

This is the row where D3++ diverges materially from D3+. Earlier versions had separate chips for "researc." (research), "novel" (autonovel), "multi-pass," and "alternatives." D3++ collapses all four into the single `+ OPTIMIZE` button with a scope-aware popover.

```
FULL DRAFT ⌘D   POLISH ⌘P   EXPAND ⌘E   → CONTINUE ⌘\   ? MISSING ⌘M   ┃   + OPTIMIZE ⌘O    SCOPE: WHOLE DRAFT
```

### 4.1 Quick-action chips (left side of separator)

| Chip | Shortcut | Action |
|---|---|---|
| `FULL DRAFT` | `⌘D` | Generate the entire draft from the Outline. Single-pass (autonovel only, no research, no multi-pass). Best when the Outline is solid and you just want to see prose. |
| `POLISH` | `⌘P` | Style/grammar/flow pass on the current scope (selection or whole draft). No new content — refines existing. |
| `EXPAND` | `⌘E` | Lengthens the current paragraph or selection. Good when a section feels too thin. |
| `→ CONTINUE` | `⌘\` | Generates the next paragraph(s) from the cursor position. Like autocomplete but paragraph-scale. |
| `? MISSING` | `⌘M` | Asks the panel: "what's missing from this section / draft?" Returns a list of suggestions, not prose. |

These are **single-purpose, fast** actions. They don't run the full Optimize pipeline. Each is a single LLM call (not multi-pass), uses cached anchors, and returns in <5 seconds for a paragraph-scale operation.

### 4.2 Separator

A subtle vertical divider (`┃` in the diagram) groups the quick-action chips on the left from the heavier Optimize action on the right.

### 4.3 The `+ OPTIMIZE` button (the headline change)

| Element | Spec |
|---|---|
| Visual | Accented button (red/brand accent, contrasts with the neutral quick-action chips). Slightly larger hit target than the quick-action chips. |
| Label | `+ OPTIMIZE` with `+` prefix indicating "additive / compound action" |
| Shortcut | `⌘O` opens the popover; `⌥↵` from inside the popover runs |
| Click behavior | Opens the popover (see §5). Does NOT immediately trigger optimization. |

### 4.4 Scope chip (right of OPTIMIZE)

| Element | Spec |
|---|---|
| Format | `SCOPE: <label>` where label depends on cursor selection |
| Labels | `WHOLE DRAFT` (no selection), `PARAGRAPH 3` (cursor is in a single paragraph), `§ POINT 2` (cursor spans a Point's segment), `SELECTION` (free-form text selection) |
| Click behavior | Click cycles the scope manually, in case the auto-detected scope is wrong. Order: `SELECTION → PARAGRAPH → POINT → WHOLE DRAFT → SELECTION` (skipping any not-applicable level). |
| Live update | Updates as the user moves cursor or changes selection. |

The chip is informational by default but interactively overridable. Annotation: *"scope chip top-right reflects it. no selection = whole draft."*

---

## 5. Optimize popover

Triggered by `+ OPTIMIZE` button or `⌘O`. Anchored to the button.

```
┌───────────────────────────────────────────────────────────────────┐
│ OPTIMIZE  · scope: WHOLE DRAFT                              ✕     │
├───────────────────────────────────────────────────────────────────┤
│ Multi-pass: research supporting + counter angles, propose 2–3     │
│ alternatives, panel-rate, return top.                             │
├───────────────────────────────────────────────────────────────────┤
│ STAGES                                                            │
│   ✓ AUTORESEARCH        gather supporting + counter sources       │
│   ✓ AUTONOVEL           draft 2–3 alternative versions            │
│   ✓ PANEL PASS          score with full panel + SSR               │
│   ✓ PROPOSE 2–3         pick top by aggregate; show side-by-side  │
├───────────────────────────────────────────────────────────────────┤
│ COST PREVIEW                                                      │
│   ≈28K TOKENS · 12S WALL · ≈$0.08                                 │
├───────────────────────────────────────────────────────────────────┤
│                                            CUSTOMIZE   RUN ⌥↵     │
└───────────────────────────────────────────────────────────────────┘
```

### 5.1 Header

| Element | Spec |
|---|---|
| Title | `OPTIMIZE` (caps) |
| Scope echo | `· scope: <CURRENT_SCOPE_LABEL>` (echoes the toolbar chip; popover is bound to scope at the moment it opens; if user re-selects after opening, scope updates live) |
| Close | `✕` top-right (or click outside to dismiss) |

### 5.2 Description line

One-sentence summary of what Optimize does at this scope. Examples:

| Scope | Description |
|---|---|
| `WHOLE DRAFT` | `Multi-pass: research supporting + counter angles, propose 2–3 alternatives, panel-rate, return top.` |
| `§ POINT 2` | `Multi-pass on Point 2 only: research counter angles, draft 2–3 alternatives for this Point's segment, panel-rate, return top.` |
| `PARAGRAPH 3` | `Targeted optimize on ¶3: 2–3 alternative phrasings, panel-rate, return top.` |
| `SELECTION` | `Optimize selection: 2–3 alternative phrasings of the highlighted text, panel-rate, return top.` |

The description is generated from the scope and the active stages. It's the **preview annotation says** *"popover previews what optimize will do AT THIS SCOPE."*

### 5.3 Stages list

Four stages, each with a checkmark indicator (✓ if active for this scope, ◌ if disabled / not applicable):

| Stage | What it does | When skipped |
|---|---|---|
| `AUTORESEARCH` | Gather supporting + counter sources via the autoresearch pipeline. Writes to the Sources rail (visible as new entries). | Skipped when scope = `SELECTION` if the selection is short (<50 words) — research overhead not worth it. User can re-enable in `CUSTOMIZE`. |
| `AUTONOVEL` | Draft 2–3 alternative versions of the scope's prose using autonovel. | Always active (this is the prose-generation core). |
| `PANEL PASS` | Score each alternative with the full panel + SSR per `OPTIMIZATION_LOOP.md` §6.4. | Always active for whole-draft and Point scope; user can disable for paragraph/selection scope to save tokens. |
| `PROPOSE 2–3` | Pick the top alternatives by aggregate score; render side-by-side for user to pick. | Always active when ≥2 alternatives are generated. |

Each stage row is **read-only by default** but `CUSTOMIZE` (see §5.5) opens an editor that lets the user toggle stages on/off and tune parameters per stage.

### 5.4 Cost preview

| Element | Spec |
|---|---|
| Token estimate | `≈28K TOKENS` (rounded; combines all stages' input + output tokens for the scope) |
| Wall time estimate | `12S WALL` (rounded; based on parallel stage execution where possible) |
| Dollar estimate | `≈$0.08` (rounded to nearest cent; uses the scoring/generation provider unit costs) |

Estimates update live as the user changes scope or customizes stages. The `≈` prefix is durable — these are estimates, not commitments. Final cost is recorded in the resulting `OptimizationRound` ledger entry.

### 5.5 Footer actions

| Button | Spec |
|---|---|
| `CUSTOMIZE` | Expands the popover (or transitions to a fuller modal) revealing the **full autoresearch + autonovel + panel-pass + propose stage configuration**: per-stage providers, anchor bundle override, gate thresholds, alt count (default 3, max 5), plus the autoresearch/autonovel loop knobs (search depth, source pool, novelty thresholds, etc. — pulled from `OPTIMIZATION_LOOP.md` and the autoresearch/autonovel repo configs). This is the debugging surface for bad Optimize runs — without it, you have no recourse other than re-running blind. **v0P state:** ship CUSTOMIZE functional if the stage config schema is pinned down by build time; otherwise visible-but-disabled with a "Coming soon" tooltip. We need it eventually — this is not a "maybe defer forever" item. |
| `RUN ⌥↵` | Primary action. Triggers `run_optimization` per `OPTIMIZATION_LOOP.md` §6.4 with the configured stages and scope. Popover closes; a progress indicator appears in the toolbar. |

The `⌥↵` (Option+Return) shortcut is intentionally **not** plain `↵` — Run is a non-trivial action and shouldn't fire on accidental Enter inside the popover.

### 5.6 During and after a Run

While Optimize is running:
- The toolbar `+ OPTIMIZE` button shows a spinner and the label changes to `OPTIMIZING… 7s` (live elapsed).
- The user can keep editing other parts of the draft (it's a background job).
- A small progress chip in the toolbar shows current stage: `AUTORESEARCH → AUTONOVEL → PANEL PASS → PROPOSE`.

After completion:
- The alternatives appear in a side-by-side panel in the center column (replaces the affected scope's region; **the original is always one of the alternatives** — i.e., even when the optimizer only returns 1 generated alternative, the panel shows 2 cards: original on the left, generated on the right).
- User picks one with click or arrow keys + `↵` to accept; `⌘Z` reverts to original.
- The mental model is consistent across alt counts: **Optimize proposes; user picks.** Inline-replace is never used — the post-Run UX is always the side-by-side commit gate.
- An `OptimizationRound` ledger entry is recorded (`OPTIMIZATION_LOOP.md` §4.7) with the picked outcome.

---

## 6. Left rail — Outline (with per-segment scores)

The Outline rail is the navigation map AND a per-segment score readout. Same data shape as the Points list in `03_points_outline.md` §4 but rendered draft-aware.

### 6.1 Structure

Tabs at top: `Outline · 5/5-7` | `Sources · 4` | `Versions · 3`

- `Outline` (default) — segment list keyed to Outline Points.
- `Sources` — same Sources rail as in screen 02, but now scoped to the Draft (cite-tracker view).
- `Versions` — draft snapshot history. Two snapshot tiers (see §10.4 for storage details):
  - **Named snapshots** (durable, never auto-pruned) — every Optimize run (pre + post), every manual save (`⌘S`), every phase entry/exit.
  - **Auto-snapshots** (last 20, FIFO prune) — captured every ~1 minute, only if a change occurred since last snapshot.
  - The `Versions · 3` badge counts named snapshots only. Autosaves live behind a `Show all autosaves` toggle so they don't pollute the visible list.

### 6.2 Outline segment cards

Each card represents a Point's prose segment in the draft.

| Element | Spec |
|---|---|
| Status indicator | `◉` filled (cursor is currently in this segment) / `◌` hollow (other segments) |
| Position number | `01`, `02`, … (matches Point order from screen 03) |
| Type label | `HOOK` / `ARG` (argument) / `CLOSE` / `CTR` (counter) |
| Score | Right-aligned aggregate, e.g., `8.1` |
| Paragraph count | `3 ¶` (small caps muted) — number of paragraphs allocated to this segment |
| Click behavior | Jumps cursor to first paragraph of that segment in the center column |
| Hover behavior | Reveals tooltip with per-persona breakdown: `A 9 · R 8 · M 7 · SSR 0.78 · ✓ GATES` |

**Visible segments in the design** (same data continuity from screen 03):
1. ◉ 01 HOOK · 8.1 · 3 ¶ (active — cursor here)
2. ◌ 02 ARGUMENT · 7.6 · 3 ¶
3. ◌ 03 ARGUMENT · 7.2 · 2 ¶
4. ◌ 04 ARGUMENT · 6.8 · 2 ¶
5. ◌ 05 CLOSE · 6.2 · 2 ¶

Below separator:
6. ◌ COUNTER 06 · 3.4 · 1 ¶ (red border / counter styling)

### 6.3 Counter-Point handling

Counter-Points are rendered as a separate sub-section (same as in screen 03) with a divider and red-border accent. Their prose appears in the draft at the location specified in the Outline (typically: after the relevant Argument, OR at the end as a "but consider…" section, depending on Outline structure).

---

## 7. Center column — Draft prose

The primary editing surface.

### 7.1 Active-paragraph header (sticky top)

| Element | Spec |
|---|---|
| Status line | `PARAGRAPH 3 OF 12 · POINT 1 · HOOK` (small caps muted; updates as cursor moves) |
| Right side | (reserved for future per-paragraph score badge, deferred) |

The header tells the user where they are in the document and which Point segment the cursor occupies. Critical for the "scope-aware OPTIMIZE" UX — user can verify the scope before triggering.

### 7.2 Prose editor

Standard rich-text editor surface. Markdown-friendly. Supports:
- Inline formatting: bold, italic, links, inline code
- Block elements: paragraph (default), blockquote (for pull-quotes from sources), horizontal rule (for section breaks)
- Citation markers: inline footnote-style links to Sources (e.g., `[¹]` linking to Source #1)

**No** heading hierarchy in the editor itself — the Outline IS the heading structure. The user doesn't write `## My Argument`; the system renders Outline structure as headings at export time.

### 7.3 Cursor + selection behaviors

| State | Visual cue |
|---|---|
| Cursor in paragraph | Soft highlight on current paragraph (subtle background tint) |
| Selection within one paragraph | Standard selection highlight |
| Selection spanning Outline boundaries | Standard selection + Scope chip updates to `SELECTION` (overrides Point/Paragraph scope) |
| Idle (no cursor / focus elsewhere) | No paragraph highlight |

### 7.4 Inline AI surfaces (deferred)

The current design doesn't show inline ghost text suggestions during editing. `→ CONTINUE` is the closest equivalent (manual trigger). Pure ghost-text autocomplete is **deliberately deferred from v0P** — see `docs/TODOS.md` (TD-ED-1) for the deferral rationale and the signal that would re-prioritize it.

---

## 8. Right rail — Panel chat (scoped to active segment)

### 8.1 Header

| Element | Spec |
|---|---|
| Title | `PANEL` |
| Scope eyebrow | `@POINT 1` (echoes the active segment from cursor position; updates live as cursor moves) |
| Last activity | `LAST 11:54` (right-aligned) |

### 8.2 Turns

Same `DiscussionTurn` shape as in screens 02 and 03, but here scoped to the **draft segment** the cursor is in (per `EDITORIAL_ROOM_CONTRACT.md` §4.4 with `phase='draft'`, `active_object_kind='draft_segment'`, `active_object_ref=<segment_id>`).

| Element | Spec |
|---|---|
| Avatar + name | E.g., `A ANKIT` |
| Role tag | E.g., `STRATEGIST` (small caps muted) |
| Body | Quoted turn content, ~3–4 lines per turn |
| Action chip (optional) | E.g., `+ JUMP TO §2` (jumps cursor in editor), `+ ADD A PERSON` (proposes a content edit) |

**Visible turns in the design** (sample, scoped to Point 1 / Hook):
1. **A ANKIT · STRATEGIST**: "the lede works. but §2 needs a person — Ravi called this in POINTS too." → `+ JUMP TO §2`
2. **R RAVI · NARRATIVE**: "the second paragraph is bloodless. who is signing? name them." → `+ ADD A PERSON`
3. **M MEI · ANALYST**: "8-K cite is correct. ¶3 is where I'd put pp.14-16."

### 8.3 Composer

Bottom of the rail: `─── + ASK ───` button, click to open inline composer. Same as in screens 02 and 03.

### 8.4 Continuity from Points + Outline

The user shouldn't feel a discontinuity in the panel conversation when advancing from Points + Outline (screen 03) to Draft (screen 04). But we don't want to drag the full Points-phase transcript into the Draft rail either — it adds query complexity, may anchor agents to old framing, and can mislead when the underlying Point has been heavily revised since.

**Approach: summary line, expandable.**

| Element | Spec |
|---|---|
| Position | Top of the panel rail, above the current draft-phase turns, with a subtle separator below |
| Format | One line: `Earlier in Points + Outline: panel debated 4 turns; resolved with "open with reclassification."` (small caps muted) |
| Expand affordance | Click line to expand into the prior phase's turns (faded styling to distinguish from current-phase turns); click again to collapse back |
| Source of summary | Computed **once** when the Points phase is closed (i.e., when the user advances to Draft), stored on the Outline page so the read stays a single-row lookup |
| Re-computation | Only re-runs if the Points-phase discussion materially changes after the user has advanced to Draft (rare; behind a "refresh summary" affordance in the expanded view) |
| Empty state | If no prior phase discussion exists for this Point, hide the line entirely (don't render an empty placeholder) |

This gives continuity without forcing agents to anchor on stale turns and without complicating the rail's primary read query.

---

## 9. State coverage

| Surface | Loading | Empty | Error | Success | Partial / degraded |
|---|---|---|---|---|---|
| **Outline rail** | Card skeletons | "No Outline yet — go back to Points + Outline" with `← BACK` | Inline retry | Cards visible with scores | Stale score (after Setup change): card border shows stale indicator |
| **Draft prose** | Skeleton paragraphs | "Empty draft — `FULL DRAFT ⌘D` to generate from Outline" with single CTA | Editor disabled with banner | Prose visible, cursor active | Paragraph-level partial: paragraph shows `LOCAL UNSAVED` badge |
| **Active-paragraph header** | n/a (lightweight) | n/a | n/a | Updates live with cursor | n/a |
| **Action toolbar** | All chips disabled with spinner | n/a (always rendered) | Toolbar visible with errored chip showing inline error | Chips active | Specific chip disabled if its provider is down (e.g., `EXPAND` disabled if autonovel is down; tooltip explains) |
| **Optimize popover** | "Estimating…" inside popover for ~500ms after open | n/a (popover requires button click) | Inline error in cost preview row, RUN button disabled | Cost preview + stages visible, RUN ready | Provider partial unavailability: stage row shows `(provider X down — fallback to Y)` |
| **During Run** | Toolbar shows `OPTIMIZING… <Ns>` spinner; stage progress chip | n/a | Run-failed banner with retry / view-logs | Side-by-side alternatives appear | Stage failure mid-run: returns whatever was completed; remaining stages marked as `SKIPPED` in the OptimizationRound ledger |
| **Panel chat** | Turn skeletons | "No discussion yet — `+ ASK` to start" | Per-turn error: agent-failed shows retry-individual-agent | Turns visible | Provider partial failure: turn shows `(MEI: failed)` inline |
| **Word count / SSR pip** | Spinner | n/a | Inline error with retry icon | Live count updates | Stale: shows last known value with `(STALE)` suffix; recompute kicks in within N seconds |

---

## 10. Data shapes

### 10.1 Reads

| Component | Reads from | Schema |
|---|---|---|
| Draft prose | rocketorchestra `draft` page, indexed by Outline | `EDITORIAL_ROOM_CONTRACT.md` §3.4 DraftCompiledTruth |
| Outline rail | rocketorchestra `outline` page (resolved via Draft → Outline reference) | §3.3 (Points + Outline) |
| Per-segment scores | clawrocket `score_snapshots` keyed by `draft_segment_id` + setup_version + scoring_pipeline_slug | §4.2 ScoreSnapshot |
| Word-count / SSR pip | Computed from current Draft content; SSR aggregate from latest `score_snapshots` | §3.4 + §4.2 |
| Sources tab | clawrocket `source_blocks` filtered by Outline ancestry | §4.6 SourceBlock |
| Versions tab | clawrocket `draft_versions` ledger | §4.3 DraftSegment versioning |
| Panel chat | clawrocket `discussion_sessions` with `talk_kind='editorial_scoped'`, `phase='draft'`, `active_object_kind='draft_segment'`, `active_object_ref=<segment_id>` | §4.4 DiscussionSession |
| Cost preview (popover) | Computed by `estimateOptimizationCost(scope, stages)` helper that calls into the scoring pipeline metadata (no LLM call — uses static unit costs + token estimates from anchor bundle metadata). Target accuracy: **±20%** vs actual cost. The helper uses static per-stage multipliers initially; after ~20 runs of a given stage, switches to learned multipliers from the `optimization_cost_calibration` ledger (per-stage preview-vs-actual deltas). Display: clean `≈$0.08` with `≈` prefix doing the "estimate" semantic work; error band shown only on hover. Drift >50% over preview is logged silently to the calibration ledger but not UI-surfaced at v0P. | n/a (helper) |
| Prior-phase discussion summary (panel rail §8.4) | One-row lookup on the Outline page: `outline.compiled_truth.prior_phase_discussion_summaries[<point_ref>]`. Computed once at Points-phase close. | `EDITORIAL_ROOM_CONTRACT.md` §3.3 (Outline) — new field, see open question §13 |

### 10.2 Writes

| Action | Writes to |
|---|---|
| Edit prose | Updates `draft.compiled_truth.body` on the affected segment. Autosave runs **every ~1 minute, only if changes occurred since last snapshot** (no autosave on idle). Increments page version on each save. |
| `FULL DRAFT ⌘D` | Triggers single-pass autonovel run. Replaces Draft body. Records as `OptimizationRound` with `stages = ['autonovel']`. |
| `POLISH ⌘P` | Single-pass polish on scope. `OptimizationRound` with `stages = ['polish']`. |
| `EXPAND ⌘E` | Single-pass expand on scope. `OptimizationRound` with `stages = ['expand']`. |
| `→ CONTINUE ⌘\` | Single-pass continue from cursor. Inserts paragraphs, doesn't replace. `OptimizationRound` with `stages = ['continue']`. |
| `? MISSING ⌘M` | Panel query, returns suggestions in chat (no draft mutation). Records `DiscussionTurn`. |
| `+ OPTIMIZE` | Opens popover (no write). |
| `RUN ⌥↵` (popover) | Triggers full `run_optimization` per `OPTIMIZATION_LOOP.md` §6.4. Records `OptimizationRound` + `optimization_trials` per `EDITORIAL_ROOM_CONTRACT.md` §4.7. |
| Pick alternative (post-Run side-by-side) | Mutates affected scope's `draft.compiled_truth.body`. Records the picked alternative's `optimization_trial_id` as the chosen outcome. Increments page version. |
| `⌘Z` after pick | Reverts to pre-Run state. Records as a "rollback" in the OptimizationRound ledger (doesn't delete the trial; marks outcome as `rejected`). |
| Send chat message | Creates `DiscussionTurn` in active session. Triggers `run_skill` for addressed agents. |
| Accept proposal chip (e.g., `+ JUMP TO §2`) | Triggers the proposed action: jumps cursor in editor (no draft mutation) or applies a content edit (draft mutation, recorded as `OptimizationRound` with `stages = ['proposal_apply']`). |

### 10.3 Scope detection rules (toolbar chip + popover)

```
if selection.exists and selection.spans_multiple_paragraphs:
    scope = SELECTION
elif selection.exists and selection.length_chars > 0:
    scope = SELECTION
elif cursor.in_paragraph:
    if paragraph.is_only_paragraph_of_segment:
        scope = POINT (single-paragraph segments collapse to Point scope)
    else:
        scope = PARAGRAPH
elif cursor.in_segment:  # cursor between paragraphs but in a known segment
    scope = POINT
else:
    scope = WHOLE_DRAFT
```

Manual override via clicking the SCOPE chip cycles to the next applicable level.

### 10.4 Versions tab — snapshot triggers and retention

The `Versions` tab in the left rail is a hybrid named + auto store.

| Tier | Trigger | Retention | Visible in main list |
|---|---|---|---|
| **Named** | Pre-Optimize-run, post-Optimize-run, manual save (`⌘S`), phase entry, phase exit | Durable, never auto-pruned | Yes (counts toward `Versions · N` badge) |
| **Auto** | Every ~1 minute, only if a change occurred since last snapshot | Last 20 per draft, FIFO prune | Hidden behind `Show all autosaves` toggle |

Storage shape: each row in `clawrocket.draft_versions` carries `snapshot_kind ∈ {named, auto}`, `trigger ∈ {pre_optimize, post_optimize, manual_save, phase_entry, phase_exit, autosave}`, `created_at`, full draft body or compressed diff (implementation choice — likely compressed diff against most recent named snapshot).

Storage cost is trivial: a 1,400-word draft is ~10KB plain text; 20 autosaves + ~10 named per draft ≈ 300KB; 1,000 drafts ≈ 300MB. Bounded retention via FIFO prune of auto-snapshots keeps growth in check.

**Restore semantics:** clicking a Versions row replaces the current draft body with the snapshot's content. Records the restore as a new manual_save snapshot (so the user can `⌘Z` the restore itself).

---

## 11. Visual + interaction style

(Inherits from `01_setup.md` §10, `02_theme_topics.md` §10, `03_points_outline.md` §11. Specifics for this screen:)

- **The OPTIMIZE button is the only accented button on the toolbar.** Everything else (FULL DRAFT, POLISH, EXPAND, CONTINUE, MISSING) is neutral. This visual hierarchy makes Optimize feel like the "main thing you do here," reinforcing the design intent. Other quick-action chips are convenience.
- **Cursor → scope live update is non-negotiable.** The scope chip must update within ~50ms of cursor movement. If it lags, users will trigger Optimize at the wrong scope and get unexpected results. Treat this as a perceived-performance metric, not a UX nice-to-have.
- **Side-by-side post-Run UI uses arrow-key navigation.** Don't require the user to mouse to pick an alternative. `←` / `→` cycle alternatives, `↵` accepts, `Esc` dismisses. Keyboard-first because the user just paid 12 seconds and ~$0.08 — they're focused.
- **Word count uses the Setup target range as the source of truth.** Don't render an unbounded count; always show `1,247 / 1,200–1,400 WORDS`. The slash + range frames the absolute number against the target.
- **Autosave is invisible but acknowledged.** `LAST AUTOSAVE 11:52` updates every save. No spinner, no toast, no fanfare — just a quiet timestamp. The user trusts autosave because they see it ticking.

---

## 12. Anti-patterns

- **Optimize is not a phase.** Don't add `OPTIMIZE` to the phase strip. It's an action that runs **within** the Draft phase. Annotation explicitly: *"not a phase, just a heavier action."*
- **Don't fragment Optimize back into separate buttons.** D3 and D3+ had this — separate "research," "novel," "multi-pass," "alternatives" chips. D3++ unifies them deliberately. Future versions should add stages to the popover, not split the button.
- **Quick-action chips don't run the full Optimize pipeline.** `EXPAND` is autonovel only — no research, no panel pass, no alternatives. If a user wants the heavier pipeline they click `+ OPTIMIZE`. Conflating these undermines the cost/speed tradeoff the design encodes.
- **Scope chip is informational, not modal.** Clicking it cycles scope but doesn't open a picker dialog. The chip itself is the picker.
- **Don't auto-trigger Optimize on idle.** No "looks like you stopped editing — should I optimize?" prompts. Optimize is user-triggered. Always.
- **Side-by-side alternatives don't auto-pick the highest-scoring.** Show all 2–3 to the user and let them pick. The aggregate score is a guide, not a verdict — the user reads them and decides.
- **Paragraph-level partial saves are not "alternative drafts."** A paragraph with `LOCAL UNSAVED` is just unsaved local edits. Don't conflate this state with the post-Optimize alternatives state.

---

## 13. Open questions

(Most of the original open questions were resolved during the spec walkthrough — see the decision rationale embedded in §3, §5.5, §5.6, §6.1, §7.4, §8.4, §10.1, §10.2, and §10.4. Remaining items below.)

1. **`CUSTOMIZE` build state at v0P.** The button is visible in the popover; whether it's functional or disabled-with-tooltip at v0P depends on whether the full autoresearch + autonovel + panel-pass + propose stage config schemas are pinned down by build time. Action: when implementing, peek at `OPTIMIZATION_LOOP.md` and the autoresearch / autonovel repo READMEs to enumerate the actual config keys; the right v0P answer falls out of that enumeration. We need it functional eventually — this is a "when" question, not "if."

2. **Outline schema field for prior-phase discussion summaries.** §8.4 stores a one-line summary of the Points-phase discussion on the Outline page (`outline.compiled_truth.prior_phase_discussion_summaries[<point_ref>]`). This is a new field on the Outline `compiled_truth` not currently spec'd in `EDITORIAL_ROOM_CONTRACT.md` §3.3. Add when making Outline schema updates.

3. **State-`b` drawer expand behavior** *(carried over from `03_points_outline.md` §13.3 — affects this screen's panel rail too if we add a parallel collapsed state).* Out of scope for the Draft screen as currently spec'd (panel rail is always visible here, not collapsible), but worth tracking if we ever consider parity with the Points + Outline collapse pattern.

---

## 14. Reference screenshots

- `04_draft_d3pp.png` — D3++ canonical version (the chosen direction with unified `+ OPTIMIZE` action and scope-aware popover)
- `04_draft_d3p.png` — D3+ (reference only, pre-unification — shows the separate "researc.", "novel", "multi-pass", "alternatives" chips that D3++ collapses; useful for understanding what was deliberately changed and why)
