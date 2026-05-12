# PHASE 0P STOP GO

# Phase 0p — Stop/Go Memo

**Author:** Joseph Kim
**Written:** 2026-04-30 (before 0p code starts)
**Decision date:** 2026-05-18

## Hypothesis
A multi-LLM Editorial Room that operates with a specific workflow (Themes/Topics/Points - not just line edits) and in coordination with AI (panel discussion + Karpathy autoresearch/optimization) that creates dramatically more compelling and insightful content. The published pieces are significantly better than pieces I've published before (per my own read).

## What 0p ships
- A specified Deliverable.
- Three audience personas that will use a scoring system to score Theme, Topics, Points, and draft content created.
- One Theme page, hand-authored ("AI Impact on Game Dev").
- One Topic under it.
- Three Points under that Topic.
- One Piece taken end-to-end through the 6 visible UI phases: `01 SETUP → 02 THEME + TOPICS → 03 POINTS + OUTLINE → 04 DRAFT → 05 POLISH → 06 SHIP` (Outline assembly happens via the Outline tab inside the Points + Outline workspace, not a separate page).
- One ProposalCard accept/reject loop wired end-to-end.
- AutoNovel Mechanical scorer + AutoNovel Judge scorer running in Theme, Topic, Point, and Draft phases, producing a real ScoreResult I can read. Each persona will score and we will also show an aggregated score.
- Local-only. SQLite. Single user (me). No auth flows.

Out of scope: Panel Talk, Research stage, SSR scorer, suggestion anchoring
across re-runs, multi-piece portfolio dashboard, anything cloud.

## Go criteria — all must be true
1. Piece 1 ships in ≤ 5h of my hands-on time.
2. Pieces 2 and 3 each ship in ≤ 4h.
3. The Polish ScoreResult flags ≥ 1 issue I agree with on at least 2 of 3 pieces.
4. The Point Workshop produces ≥ 1 Point I keep that I would not have written
   on my own (my judgment, marked at the time).
5. My subjective rating of the published pieces is ≥ 7/10 each (rated on the
   day of ship, not retrospectively).
6. I want to start Piece 4. Not "should." Want.

## Stop criteria — any one true and I halt
1. Piece 1 takes > 8h hands-on.
2. I stop using the Point Workshop after Piece 1 because it slows me down.
3. ScoreResults are noise I ignore on every piece.
4. The 3-panel workspace is so clunky I'd rather draft in Obsidian.
5. By piece 3, my time is *increasing*, not decreasing.
6. I dread starting Piece 4.

## Ambiguous-zone protocol
If exactly one Go criterion is missed and the rest are met by ≥ 20%, I extend
0p by up to 16h to retry that one. If two or more Go criteria miss, no
extension — I stop and write a postmortem before deciding what to do next.

## What I'll learn either way
- Go: portfolio compounding is real for me on Themes I care about, and the
  Editorial Room shape (Setup-first, layered, multi-LLM Points) is worth
  productizing.
- Stop: either the substrate is wrong, the workflow is wrong, or my hypothesis
  about Layer-1-3 value was wrong. Each of those points to a different next
  move, and I'd rather know now than after Phase 1A.

— Joseph, 2026-04-30