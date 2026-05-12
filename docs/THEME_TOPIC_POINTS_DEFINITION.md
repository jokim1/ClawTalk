# Theme / Topic / Point Definitions

**Owner:** Joseph
**Last updated:** 2026-04-30
**Companion docs:** `SCHEMA_DEFINITION.md`, `EDITORIAL_ROOM_CONTRACT.md`, `OPTIMIZATION_LOOP.md`, `01_ARCHITECTURE.md` §6 (page-type ontology), `02_HERO_APPLICATIONS.md` (Editorial Room workflow)

> **Note on document state.** Planning-phase reference doc. Definitions, tests, and scorable axes can change freely until first production deployment. The five tests per layer are the highest-leverage piece of this doc — get them wrong and downstream scoring is wrong; the rest of the doc is supporting structure.

---

## 1. Purpose

This document defines the three editorial-content layers — Theme, Topic, Point — that structure the Editorial Room. It exists for two reasons.

The first is human-tightness. Joseph and any future collaborator need to be able to look at a candidate Theme and know whether it is one. Vague hierarchy creates scope drift inside the Editorial Room: a Topic gets ambitious and starts claiming Theme status, or a Theme gets specific and degrades into a Topic. The tests in this document make those judgments mechanical.

The second is machine-tightness. Every layer is scored by both an SSR persona panel and an autonovel-style rubric judge. Those scorers need explicit criteria to score against. The "tests" sections below double as rubric criteria — the LLM judge prompt for Theme scoring literally references the five Theme tests in §3.2.

This is a reference doc, not a brief or a deck. Read it once end-to-end before authoring; refer back to the specific section when you're seeding or refining a layer.

---

## 2. The hierarchy at a glance

```
Theme              — multi-month editorial bet on a slice of audience attention
  └─ Topic         — a specific editorial angle inside a Theme; one Piece per Topic
       └─ Point    — a single sub-claim or sub-argument inside a Topic
```

| Layer | Cardinality | Time horizon | Scoring focus |
|---|---|---|---|
| Theme | 5–7 hand-seeded at launch; 5–10 active per publication at steady state | 6–24 months | Does this slice of attention deserve to be a publication-level bet? Does it serve named personas? |
| Topic | 4–12 per Theme over its lifetime; 1 per Piece | Days to weeks (one publish cycle) | Will the named personas open and finish a Piece on this angle? |
| Point | 3–7 per Piece | The lifetime of the Piece | Is this claim defensible, falsifiable, sourced, and Topic-fit? |

**One-Piece-per-Topic rule.** A Topic is the unit at which you commit to publishing a Piece. If you have two Pieces on the same Topic, either (a) the second one supersedes the first (treat as revision), or (b) one of them is actually a different Topic and you mis-tagged it. Don't let one Topic produce a series unless you've explicitly decided the Topic is itself a series.

**Hierarchy violations are real and expected.** A Topic that turns out to be a Theme is a discovery, not a bug — it means your Theme map needs refinement. The Editorial Room logs these promotions/demotions as audit events on the relevant pages.

---

## 3. Theme

### 3.1 Definition

A **Theme** is a multi-month editorial bet on a defensible slice of audience attention. It names *the kind of person you want to be the one who covers this*, on a horizon of roughly 6–24 months. A Theme is the unit at which you decide what GameMakers (or any publication) is and isn't.

A Theme is not a category, not a beat, not a topic-cluster, not an SEO target. It is a position you are taking on what your audience needs you, specifically, to be paying attention to over the next year-and-a-half.

### 3.2 Tests

A candidate Theme must pass all five tests. Failing any one disqualifies it.

| # | Test | Why it matters |
|---|---|---|
| 1 | **Subscription test.** A reader could subscribe to a hypothetical micro-publication called "Theme: X" and know within one paragraph what they'd get. | If the name is too vague, no reader can self-select. Themes that fail this read like categories. |
| 2 | **18-month test.** You can plausibly publish 8–20 distinct Pieces under this Theme over 18 months without it feeling repetitive or scope-drifting. | Themes shorter than 6 months are events or campaigns. Themes longer than 24 months become categories — they need re-scoping. |
| 3 | **Out-of-scope test.** You can name at least three things this Theme deliberately *doesn't* cover. | Themes without exclusions are too broad. Naming what's out is the highest-leverage scope-discipline action. |
| 4 | **POV test.** You can state, in one sentence, the non-obvious thing you believe about this Theme that holds it together. | A Theme without a POV is "I'll cover whatever happens here," which is a beat, not a Theme. |
| 5 | **Person test.** A specific named persona in your audience would actively *want* you to be the one covering this. ("Ankit would benefit if I'm the person who covers X.") | This is the highest-leverage test. If no named persona benefits from your specific take, the Theme fails regardless of how well it passes 1–4. |

### 3.3 Scorable axes (rubric judge)

Each axis 1–5; thresholds gate Theme acceptance.

| Axis | What scoring asks |
|---|---|
| `specificity` | How well does the Theme name a specific slice of attention? Penalize categorical names ("Games"); reward named-slice-with-angle names ("AI Impact on Game Dev"). |
| `durability_18mo` | Could you publish ~12 Pieces under this in 18 months without scope drift? Penalize event-bound or already-played-out themes. |
| `pov_clarity` | Is there a one-sentence non-obvious POV that holds the Theme together? Penalize beats and categories. |
| `defensible_exclusions` | Are there ≥ 3 things explicitly out-of-scope, named in the Theme page? Penalize themes with no exclusions. |
| `audience_fit_per_persona` | For each `active` persona: does the Theme serve them? Surfaced as per-persona scores, not just an average. |

### 3.4 SSR scoring (per persona)

| Concern | Value |
|---|---|
| Persona-conditioned question | "Would you subscribe to a publication centered on this Theme? On a 1–5 scale, how useful would this Theme be in serving you over the next 18 months?" |
| Likert family | `likelihood` (primary), `value` (secondary) |
| Anchors live on | `scoring_pipeline.theme.anchors` |
| Aggregation | Mean SSR likelihood across all `active` personas, stratified by `role_to_topic`. Surface per-persona distributions in the ProposalCard, not just a composite. |

### 3.5 Five examples

The first three pass all five tests. The last two fail and illustrate the failure mode.

#### Example 1 — `theme.ai_impact_gamedev` (PASS)

**Name:** AI Impact on Game Dev

| Test | Verdict | Reasoning |
|---|---|---|
| Subscription | ✓ | "Theme: AI Impact on Game Dev" — a reader knows immediately whether this is for them. |
| 18-month | ✓ | The operating-renegotiation window is real and ongoing through 2026–2027. |
| Out-of-scope | ✓ | Excludes runtime AI-as-NPCs, capability research, generic AI-ethics debate. |
| POV | ✓ | "The actual operating change — team shapes, publishing terms, what 'indie' means — is up for renegotiation in the next 18 months. Most coverage is doom or hype; this isn't." |
| Person | ✓ | Ankit, Ravi, Mei all want this slice covered by someone who reads contracts. |

#### Example 2 — `theme.founder_reality` (PASS)

**Name:** Founder Reality of Running a Studio

| Test | Verdict | Reasoning |
|---|---|---|
| Subscription | ✓ | "Theme: Founder Reality" — names the perspective. |
| 18-month | ✓ | Founder operations are perennially under-covered; durable for years. |
| Out-of-scope | ✓ | Excludes pure marketing tactics, capability/tech reviews, AAA-org studies. |
| POV | ✓ | "The parts of running a studio that founder-podcasts skip — payroll, contracts, the conversations no one wants to be quoted on." |
| Person | ✓ | First-time founders + studio leads (Ravi-shape) directly benefit. |

#### Example 3 — `theme.funding_publishing_mechanics` (PASS)

**Name:** Funding & Publishing Mechanics

| Test | Verdict | Reasoning |
|---|---|---|
| Subscription | ✓ | "Theme: Funding & Publishing Mechanics" — clear domain, clear value. |
| 18-month | ✓ | Deal terms, fund structures, and platform economics are durable through any market cycle. |
| Out-of-scope | ✓ | Excludes general business advice, founder-life content, capability reviews. |
| POV | ✓ | "The contract clauses, term-sheet shifts, and platform-economic moves that change who gets to ship — covered by someone who reads the actual paper." |
| Person | ✓ | Mei (publisher associate) + indie founders preparing deals all benefit. |

#### Example 4 — `theme.games` (FAIL — too broad)

**Name:** Games

| Test | Verdict | Reasoning |
|---|---|---|
| Subscription | ✗ | A reader cannot tell what they'd get. |
| 18-month | n/a | Could publish anything, which is the problem. |
| Out-of-scope | ✗ | Excludes nothing. |
| POV | ✗ | No POV is possible at this scope. |
| Person | ✗ | No persona benefits more than they would from any games publication. |

**Failure mode:** Category masquerading as Theme. Resolution: split into 4–6 actual Themes, each of which passes the tests.

#### Example 5 — `theme.unity_runtime_fee_2023` (FAIL — event-bound)

**Name:** The Unity Runtime Fee Crisis of 2023

| Test | Verdict | Reasoning |
|---|---|---|
| Subscription | ✓ | A reader could understand it. |
| 18-month | ✗ | Event has already played out; not durable. |
| Out-of-scope | ✓ | Could be specified. |
| POV | ✓ | A specific position is plausible. |
| Person | ✗ | Audience has moved on. |

**Failure mode:** This is a Topic, possibly a Point, masquerading as a Theme. It belongs *under* `theme.toolchain_pipeline` or `theme.founder_reality` as a Topic. Promote-back-up if and only if a future event makes the original event re-relevant in a durable way.

---

## 4. Topic

### 4.1 Definition

A **Topic** is a specific editorial angle inside a Theme. It is the unit at which you commit to publishing one Piece. A Topic takes one position or answers one question, and it can be defended as "I'm going to be the person who says X about Y, on the record."

A Topic is not a beat, a tag, a search term, or a content category. It is a position you are taking, in print, on a specific question.

### 4.2 Tests

| # | Test | Why it matters |
|---|---|---|
| 1 | **Headline test.** You can write a Substack post title that names a position, not just a category. | Topics with category-titles ("Studio operations") are not Topics — they're Theme fragments. |
| 2 | **One-position test.** You can state the Topic's argument in 1–3 sentences. Not a summary of multiple positions — your one position. | Topics that cover "the debate" are surveys, not editorial work. |
| 3 | **Theme-fit test.** It is unambiguously inside exactly one Theme (or you've decided it crosses two and named both). | Cross-Theme Topics are fine but must be explicit. Implicit cross-Theme is scope drift. |
| 4 | **Specificity test.** It names at least one of: a studio, a person, a number, a contract clause, a tool, a date, a specific decision. | Topics without specificity are abstract takes — readable but not memorable, not forward-able. |
| 5 | **Disagreement test.** A smart reader could plausibly disagree with the Topic's position. | Undisputable claims are facts, not Topics. |

### 4.3 Scorable axes (rubric judge)

| Axis | What scoring asks |
|---|---|
| `position_clarity` | Can the Topic's position be stated in 1–3 sentences? |
| `specificity` | Does the Topic name ≥ 1 of: studio, person, number, contract clause, tool, date, decision? |
| `theme_fit` | Does the Topic clearly belong to exactly one Theme (or two, explicitly)? |
| `disputability` | Could a smart reader plausibly disagree with the position? |
| `persona_likelihood_to_click` | Per-persona SSR `likelihood` distribution; surfaced individually, not averaged. |

### 4.4 SSR scoring (per persona)

| Concern | Value |
|---|---|
| Persona-conditioned question | "Would you click and finish a piece with this angle? How likely are you to want to read it on a 1–5 scale?" |
| Likert family | `likelihood` (primary), `appeal` (secondary) |
| Anchors live on | `scoring_pipeline.topic.anchors` |
| Aggregation | Mean SSR appeal/likelihood per persona; cohort-weighted composite. Hard gate: any *primary* persona's likelihood mean below threshold blocks Topic acceptance. |

### 4.5 Five examples

All under the Theme `theme.ai_impact_gamedev`. First three pass; last two fail.

#### Example 1 — `topic.embracer_writedown_indie_terms` (PASS)

**Title:** *How Embracer's $2.1B writedown changed indie publishing terms*

| Test | Verdict | Reasoning |
|---|---|---|
| Headline | ✓ | Names a number, names a publisher, names an effect. |
| One-position | ✓ | "Surviving studios are signing 2022-rate deals to keep going. The writedown shifted bargaining power away from studios in a way that's now locked in for 18+ months." |
| Theme-fit | ✓ | Clearly inside `theme.ai_impact_gamedev` (because the cost-savings argument that justifies the term shifts is AI-driven). Could also fit `theme.funding_publishing_mechanics` — explicit cross-Theme. |
| Specificity | ✓ | Studio: Embracer. Number: $2.1B. Date: Q[X] 2025. |
| Disputability | ✓ | A defender could argue the term shifts predate Embracer and would have happened anyway. |

#### Example 2 — `topic.six_person_studio_new_normal` (PASS)

**Title:** *The 6-person studio is the new 20-person studio: what AI-assisted pipelines actually changed in shipped 2025 indies*

| Test | Verdict | Reasoning |
|---|---|---|
| Headline | ✓ | Names a position (team-size compression). |
| One-position | ✓ | "Looking at 8–10 indie studios that shipped in 2025 with sub-10-person teams, the common pipeline change isn't 'AI-generated content' — it's AI-assisted *iteration*. The 6-person team is now where the 20-person team was three years ago." |
| Theme-fit | ✓ | Inside `theme.ai_impact_gamedev`. |
| Specificity | ✓ | Year: 2025. Studio-count: 8–10. Specific pipeline changes named. |
| Disputability | ✓ | A critic could argue these studios cherry-picked, or that the comparison to 2022 teams is wrong. |

#### Example 3 — `topic.ai_pl_loses_funding` (PASS)

**Title:** *Why the AI-art P&L wins on paper and loses at funding time*

| Test | Verdict | Reasoning |
|---|---|---|
| Headline | ✓ | Names a tension (cost-savings vs. funding-friction). |
| One-position | ✓ | "Studios using AI-generated art have demonstrably better cost structures, but are systematically harder to fund — because publishers and platform partners are pricing in legal/IP risk in ways that more than offset the savings. The P&L paradox is the real story." |
| Theme-fit | ✓ | Inside `theme.ai_impact_gamedev`; touches `theme.funding_publishing_mechanics`. |
| Specificity | ✓ | Names AI-art specifically; references publisher term sheets. |
| Disputability | ✓ | Defenders could argue the funding gap will close as legal frameworks mature. |

#### Example 4 — `topic.studio_operations` (FAIL — too broad)

**Title:** *Studio Operations*

| Test | Verdict | Reasoning |
|---|---|---|
| Headline | ✗ | No position; just a category. |
| One-position | ✗ | Could host 30 different positions. |
| Theme-fit | n/a | Could fit any of 3 Themes. |
| Specificity | ✗ | None. |
| Disputability | ✗ | A category isn't disputable. |

**Failure mode:** Theme-fragment masquerading as Topic. Resolution: pick a specific operational decision and the position you have on it.

#### Example 5 — `topic.embracer_writedown_fact` (FAIL — fact, not Topic)

**Title:** *Embracer wrote down $2.1B last quarter*

| Test | Verdict | Reasoning |
|---|---|---|
| Headline | ✓ | A reader knows what it's about. |
| One-position | ✗ | No position — just a fact. |
| Theme-fit | n/a | No editorial work yet. |
| Specificity | ✓ | Yes. |
| Disputability | ✗ | Facts aren't disputable. |

**Failure mode:** Fact mistaken for Topic. Resolution: ask "what does this fact *mean* or *imply*?" The answer is the Topic. (See Example 1 — the Topic is *what the Embracer fact implies about indie publishing terms*.)

---

## 5. Point

### 5.1 Definition

A **Point** is a single sub-claim within a Topic. A Piece argues a Topic by stacking Points. A Point is one assertion that has to be defended, ideally with one supporting example, one counter-argument addressed, and one source. A Piece typically has 3–7 Points.

A Point is not a fact, not a section header, not a paragraph, not a transition. It is a claim — a thing you are asserting, with evidence behind it.

### 5.2 Tests

| # | Test | Why it matters |
|---|---|---|
| 1 | **Single-sentence test.** The Point can be stated in one sentence. | If you need two sentences, you have two Points. |
| 2 | **Falsifier test.** You can state, in one sentence, the observation that would prove this Point wrong. | Unfalsifiable claims are rhetoric. Falsifiable claims are arguments. |
| 3 | **Source test.** At least one named source, study, document, person, number, or named studio could be cited in support. | "Everyone knows X" is folklore. A Point needs at least one citable artifact. |
| 4 | **Counter-argument test.** A reasonable critic would have at least one counter — and the Piece can state it. | Points without counters are either trivially true or rhetorically naive. |
| 5 | **Topic-fit test.** Removing this Point would weaken the Topic's argument. | If removing it makes no difference, cut it. |

### 5.3 Scorable axes (rubric judge)

| Axis | What scoring asks |
|---|---|
| `atomicity` | Single sentence? Single claim? |
| `falsifiability` | Is there a stated observation that would invalidate it? |
| `source_strength` | Named source, named study, named studio, named contract, named number — how many, and how strong? |
| `counter_argument_handled` | Does the Piece (in the Outline or Draft) acknowledge at least one counter? |
| `topic_fit` | Does removing this Point weaken the Topic's overall argument? |

### 5.4 SSR scoring (per persona)

Points are typically scored *aggregated* at the Outline or Draft level, not individually. But a per-Point persona-resonance check is available:

| Concern | Value |
|---|---|
| Persona-conditioned question | "If a piece you trusted made this Point, would you find it useful? On a 1–5 scale, how valuable would this specific claim be?" |
| Likert family | `value` |
| Anchors live on | `scoring_pipeline.point.anchors` |
| Use case | Optional. Run at Outline stage when you want per-Point persona feedback. Mandatory at Draft stage as a coverage check (every Point should have ≥ 1 persona who values it). |

### 5.5 Five examples

All under the Topic `topic.embracer_writedown_indie_terms`. First three pass; last two fail.

#### Example 1 — Point: deal-term lockdown (PASS)

**Statement:** *Indie publishers are using post-Embracer cash-pile pressure to lock studios into pre-2024 royalty splits while demanding 2026-cost content.*

| Test | Verdict | Reasoning |
|---|---|---|
| Single-sentence | ✓ | One sentence, one claim. |
| Falsifier | ✓ | "Show me three first-party indie deals signed in 2025 at improved royalty terms vs 2023." |
| Source | ✓ | Deal sheets from 5 named publishers (anonymized in print) + 3 founder interviews. |
| Counter | ✓ | "Publishers are also taking on more risk, so worse studio terms are fair." Piece acknowledges this in the second-to-last paragraph. |
| Topic-fit | ✓ | Direct claim about how the Embracer event changed indie publishing terms. Removing it removes the Topic's central evidence. |

#### Example 2 — Point: AI-cost clawback clause (PASS)

**Statement:** *Three of the five publishers I spoke to introduced "AI-cost-savings clawback" clauses in 2025 deals — explicit terms that reduce the studio's upside if AI tools are used to lower production cost.*

| Test | Verdict | Reasoning |
|---|---|---|
| Single-sentence | ✓ | One sentence, one specific finding. |
| Falsifier | ✓ | "Show me a 2025 indie deal contract without the clause from one of the named publishers." |
| Source | ✓ | Five publisher interviews, three confirmed clauses. |
| Counter | ✓ | "The clause is fair given lower production cost — publishers shouldn't subsidize cost-out gains." Piece names this counter. |
| Topic-fit | ✓ | Directly evidences the Topic's claim about term shifts; specific to the AI-cost argument. |

#### Example 3 — Point: two-tier indie market (PASS)

**Statement:** *The result is a two-tier indie market: studios with prior platform relationships keep old terms; new studios negotiate from a position that's worse than 2019.*

| Test | Verdict | Reasoning |
|---|---|---|
| Single-sentence | ✓ | One sentence, one synthesis claim. |
| Falsifier | ✓ | "Show me a 2025 first-time-studio deal at par with 2019 terms, from one of the major indie publishers." |
| Source | ✓ | Comparison across 8 named studios' deal histories. |
| Counter | ✓ | "This is a normal market correction; the 2019 terms were anomalous." Piece names this counter. |
| Topic-fit | ✓ | Ties Points 1 and 2 together into the Topic-level synthesis. |

#### Example 4 — Point: "AI is changing things" (FAIL — vague)

**Statement:** *AI is changing things.*

| Test | Verdict | Reasoning |
|---|---|---|
| Single-sentence | ✓ (technically) | One sentence. |
| Falsifier | ✗ | What would prove this wrong? Nothing. |
| Source | ✗ | Could be supported by anything or nothing. |
| Counter | ✗ | No one would seriously disagree. |
| Topic-fit | ✗ | Removing it has no effect. |

**Failure mode:** Empty rhetoric mistaken for claim. Resolution: ask "what specifically is changing, for whom, in what way?" The answer becomes a real Point.

#### Example 5 — Point: "Embracer wrote down $2.1B" (FAIL — fact, not Point)

**Statement:** *Embracer wrote down $2.1B last quarter.*

| Test | Verdict | Reasoning |
|---|---|---|
| Single-sentence | ✓ | Yes. |
| Falsifier | ✗ | Facts aren't falsifiable in the rhetorical sense — they're checkable. |
| Source | ✓ | Embracer Q[X] 2025 earnings release. |
| Counter | ✗ | No reasonable disagreement with the fact. |
| Topic-fit | ✗ (as a Point) | Belongs as evidence *inside* a Point, not as a standalone Point. |

**Failure mode:** Fact-as-Point confusion. Resolution: facts are evidence inside Points, not Points themselves. (See Example 1 — the Point is what the fact implies about deal terms.)

---

## 6. Edge cases and boundary issues

These come up in real authoring sessions. Documenting them so the answer doesn't have to be re-derived.

### 6.1 When a Topic feels Theme-sized

If a candidate Topic passes all five Topic tests *and* the 18-month Theme test (you can publish 8–20 Pieces under it), it's a Theme, not a Topic. Promote it. The original Topic-shaped artifact becomes one Topic under the new Theme.

### 6.2 When a Point feels Topic-sized

If a candidate Point passes all five Point tests *and* the One-position Topic test (you could write a whole Piece arguing it, with 3–7 sub-Points beneath it), it's a Topic that's been mis-tagged. Promote it. The original Topic becomes a Theme or a sibling Topic.

### 6.3 Cross-Theme Topics

A Topic that legitimately belongs to two Themes is fine but must be explicit. The Topic page declares both Themes in `theme_ids: [theme.X, theme.Y]`. Cohort weighting and persona panels run against both Theme audiences. Composite scores require passage on each Theme's audience independently.

### 6.4 Series under one Topic

If you find yourself wanting a series of Pieces under one Topic, the Topic is actually a Theme. Promote it, then split into actual Topics. Don't allow series-under-one-Topic — it breaks the one-Piece-per-Topic rule and creates audit confusion.

### 6.5 Dormant Themes

A Theme that scored well at adoption but produces no Pieces for 6+ months gets `status: dormant`. Dormant Themes are excluded from Theme audience-fit panels by default; reactivation requires a fresh Theme-test pass.

### 6.6 "Recurring" Topics (e.g., earnings-season recaps)

Periodic Topics (quarterly, annual) are real but should be authored as *Topic templates*, not as a single recurring Topic. Each instance gets its own Topic page with the period's specific position. The template is metadata; the Topic is per-instance.

### 6.7 Reactive Topics (news of the day)

Reactive Topics are fine. They still must pass the five Topic tests. The Disputability test (#5) is the most common failure for reactive pieces — "X happened" isn't a Topic; "what X means for Y" is.

---

## 7. How scoring uses these definitions

The five tests in §3.2, §4.2, §5.2 are not just human-readable rubrics — they are the literal criteria the autonovel-style rubric judges score against. The Theme rubric prompt includes the five Theme tests verbatim and asks for `{score, gap, fix, note}` per test. Same for Topic. Same for Point.

This is by design. Definition stability is what makes scoring stable. While the system is greenfield (no shipped Themes yet), the five-test definitions here can be freely revised. Once Themes are shipped and scored historically, redefining a layer would invalidate prior scores — at that point definition changes carry a real cost and we'll think hard before making them.

### 7.1 Optimization loop sketch

```
Theme proposal
  → Theme rubric judge (5 tests, gap+fix per axis)
  → Theme SSR persona panel (likelihood/value, per persona, with anchors)
  → composite score + per-axis gaps
  → if any axis fails: revise Theme, re-score (max N iterations)
  → if all gates pass: Theme accepted, status: active

Topic proposal (under accepted Theme)
  → Topic rubric judge (5 tests, gap+fix per axis)
  → Topic SSR persona panel (likelihood/appeal, per persona, with anchors)
  → composite + per-axis gaps + per-persona distributions
  → if any primary persona's likelihood < threshold OR any rubric axis fails: revise Topic
  → if gates pass: Topic accepted, status: ready_for_outline

Outline (under accepted Topic)
  → Per-Point rubric judge (5 tests per Point)
  → Topic-coverage check (do Points argue the Topic?)
  → SSR confidence panel
  → revise lowest-scoring Point or add missing-coverage Points
  → if gates pass: Outline accepted, status: ready_for_draft

Draft (from accepted Outline)
  → autonovel mechanical scorer (slop_penalty 0–10)
  → autonovel rubric judge (voice/specificity/show-not-tell/quotes)
  → SSR draft-value panel (per persona)
  → counter-audience critic (per primary persona, line-quoted objections)
  → composite ship gate
  → revise on lowest-scoring axis until gate passes or ship-with-known-flaws
```

Optimization is per-axis, not global. The lowest-scoring axis with the highest leverage (most personas affected, biggest score delta) is the next iteration target. The Editorial Room's UX surfaces this as a single "next thing to fix" recommendation; the user can override.

---

## 8. References

- `SCHEMA_DEFINITION.md` (persona schema; the input to Theme/Topic/Point scoring).
- `EDITORIAL_ROOM_CONTRACT.md` §3 (theme/topic/point/scoring_pipeline schemas in cross-repo contract).
- `01_ARCHITECTURE.md` §6 (page-type ontology) and §15 (scoring substrate).
- `02_HERO_APPLICATIONS.md` (Editorial Room workflow stages — Theme → Topic → Points → Outline → Draft).
- Maier, B. F. et al. *LLMs Reproduce Human Purchase Intent via Semantic Similarity Elicitation of Likert Ratings.* arXiv:2510.08338v3, Oct 2025. [SSR scoring methodology underpinning all four layers.]
- Pichardo, E. V. *Measuring Self-Rating Bias in LLM-Generated Survey Data.* arXiv:2602.13862v2, Feb 2026. [Anchor calibration findings underlying the per-layer scoring pipelines.]
- autonovel `evaluate.py` — reference rubric-judge implementation patterns (`{score, gap, fix, note}` shape, FINAL CHECK self-criticism, mandatory weakest-quote requirements).
