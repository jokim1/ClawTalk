# Optimization Loop Specification

**Owner:** Joseph
**Last updated:** 2026-04-30
**Companion docs:** `EDITORIAL_ROOM_CONTRACT.md`, `SCHEMA_DEFINITION.md`, `THEME_TOPIC_POINTS_DEFINITION.md`, `SYNTHETICALRESEARCH_API_CHANGES.md`, `01_ARCHITECTURE.md` §15

> **Note on document state.** Planning-phase reference doc. Loop shape, gate thresholds, default configurations, and per-target-kind variants can change freely until first production deployment. Cost numbers in this doc are estimates for scoping purposes only.

---

## 1. Purpose

This document defines the **agentic optimization loop** that the Editorial Room runs over content artifacts (Themes, Topics, Points, Outlines, Drafts). The loop is the autoresearch pattern (Karpathy 2025) translated to editorial work: an agent generates candidates, scores them under a budget, mutates winners, and returns a top-K set for human selection.

The product motivation is direct. The Editorial Room is not a tool that scores one Topic and tells you whether it's good. It's a tool that, given a Theme and a persona panel, says *"here are 5 Topics scoring 90+ that would land with your audience — the 4 you already had ideas for, and 1 you didn't."* The interesting product is the search, not the scoring.

This spec separates concerns intentionally:

- **§3** establishes that the user-facing score (rich, multi-dimensional, the ProposalCard contents) is a different artifact from the optimization objective (the function the agent sorts candidates by). The two are designed independently and the user never sees the second one directly.
- **§4** addresses mode collapse — the failure mode where bounded search spaces produce homogenized output — which is the dominant risk in content optimization that doesn't exist in code optimization.
- **§5** defines the cost model and the user-facing controls that make full-search modes opt-in rather than implicit.
- **§6** covers per-target-kind variants. Theme generation uses a different loop than Topic optimization, which uses a different loop than Draft polish. Each variant has its own generation/mutation/diversity/gate strategy.
- **§7** defines the two Draft modes — targeted-axis (default, cheap) and full-search (opt-in, expensive) — and when each applies.

This spec is what the `factory_*_optimize` Skills implement. It is the binding contract for the agentic side of the Editorial Room.

---

## 2. The pattern

### 2.1 Autoresearch, translated to content

```
Karpathy autoresearch                   Editorial Room optimization
─────────────────────────              ─────────────────────────────
agent has sandbox to mutate code        agent has sandbox to mutate artifacts
  (one file: train.py)                    (one or more pages: Theme/Topic/...)
fixed time budget per experiment        fixed cost budget per round
  (5 min wallclock)                       (USD, with wallclock as secondary cap)
single objective metric                  multi-gate objective + ranked composite
  (val_bpb, lower is better)              (hard gates + per-axis ranking)
keep/revert decision                    accept-into-pool / reject decision
loop overnight                           loop until budget exhausted or convergence
return one improved model               return top-K candidates for user pick
```

The structural map is direct. The content adaptations matter:

1. **Multi-gate objective.** Karpathy's val_bpb is a known scalar. Editorial work isn't. We replace single-objective with hard gates (rubric tests must pass) plus a ranking function over the acceptable set (§3).
2. **Diversity preservation.** Karpathy's search space is unbounded; ours is bounded (~30–50 distinct Topics under one Theme). Mode collapse is real and must be addressed by construction (§4).
3. **Top-K return, not single-best.** Editorial sovereignty requires the human picks. The loop's output is a ranked list, not a winner. The user picks for reasons the agent cannot see.
4. **Cost transparency.** Karpathy's loop is "spend a GPU overnight, see what you get." Ours is paid-per-call and has to surface that to the user before launch (§5).

### 2.2 Generic loop pseudocode

```
function optimize(target_kind, parent_context, config, budget) -> OptimizationResult:
  acceptable = []
  iteration = 0
  cost_so_far = 0.0
  
  while cost_so_far < budget.usd_cap and iteration < config.max_iterations:
    iteration += 1
    
    if iteration == 1:
      # Seed generation: use parent context, persona unmet_needs,
      # optional PCP context, and explicit-diversity prompts
      proposals = agent.generate(
        kind=target_kind,
        parent=parent_context,
        seeds=collect_seeds(parent_context, config),
        diversity_strategy=config.diversity.generation,
        n=config.n_candidates_per_iter,
      )
    else:
      # Mutation: take winners + targeted variants
      winners = sort(acceptable, by=optimization_objective, desc)[:config.n_winners_carried]
      proposals = winners + agent.mutate(
        winners=winners,
        diversity_strategy=config.diversity.mutation,
        n=config.n_candidates_per_iter - len(winners),
      )
    
    for p in proposals:
      # Cheap gates first to avoid paying for SSR on rejects
      p.rubric = rubric_judge(p, criteria=config.gates.rubric)
      if not passes_hard_gates(p.rubric, config.gates.hard): continue
      if diversity_distance(p, acceptable) < config.diversity.min_distance: continue
      
      # SSR persona panel (the expensive call)
      p.ssr = ssr_panel(p, personas=config.personas, families=config.gates.ssr_families)
      if not passes_ssr_gates(p.ssr, config.gates.ssr): continue
      
      # Optional: counter-audience pass for Drafts
      if config.gates.counter_audience:
        p.counter_audience = counter_audience(p, personas=config.personas.primary)
      
      p.composite = composite_score(p, config.objective_weights)
      acceptable.append(p)
      cost_so_far += p.cost_usd
    
    if convergence_signal(acceptable, iteration): break
  
  return OptimizationResult(
    top_k = sort(acceptable, by=composite, desc)[:config.k_returned],
    rejected_summary = summarize_rejects(),
    cost_actual = cost_so_far,
    iterations = iteration,
    convergence_reason = convergence_reason,
  )
```

The shape is the same across target kinds. What varies is config: which gates apply, what `agent.generate/mutate` does, what counts as "diverse," and what cost defaults make sense. §6 covers each variant.

---

## 3. Two objectives: user-facing score vs. optimization function

These are separate artifacts. They are designed independently. The user never sees the optimization function directly.

### 3.1 User-facing score (ProposalCard contents)

The user-facing score exists to inform a *human decision* about a single artifact. Its job is **insight**. It is rich, multi-dimensional, and persona-stratified.

For each candidate in the returned top-K, the user sees:

```yaml
proposal_card:
  artifact:                      # the candidate Theme/Topic/Point/Outline/Draft
    page_id, content_summary, full_content
  
  rubric_scores:                  # per-axis from the rubric judge
    - axis: specificity
      score: 4
      gap: "Could name a contract clause specifically (e.g., 'AI-cost clawback')"
      fix: "Add the named clause from the writedown coverage"
      note: "..."
    - axis: disputability
      score: 5
      ...
    - ...
  
  ssr_distributions:              # per-persona, full PMFs
    - persona: persona.ankit_indie_dev
      family: likelihood
      pmf: [0.02, 0.05, 0.13, 0.42, 0.38]   # 1-5 scale
      mean: 4.09
      confidence: 0.78              # normalized Shannon entropy
      reasoning_quote: "I'd send this to my co-founder. Names a number, names a clause."
    - persona: persona.ravi_studio_lead
      family: likelihood
      pmf: [0.05, 0.12, 0.28, 0.40, 0.15]
      mean: 3.48
      confidence: 0.51
      reasoning_quote: "..."
    - ...
  
  counter_audience:               # for Drafts only
    - persona: persona.ankit_indie_dev
      objections:
        - quoted_line: "Most studios in 2025 are..."
          objection: "Which studios? You named one earlier — name three more."
        - ...
  
  comparable_history:             # ranked against user's past artifacts
    "This Topic scores higher than 73% of Topics you've shipped under this Theme."
    "Similar shape to: topic.embracer_writedown_indie_terms (shipped 2026-03-15)."
  
  diversity_position:             # where it sits in the candidate pool
    "This is the most novel candidate of the 5 returned (most distant in
     embedding space from other top-K results)."
  
  cost_so_far: $3.42              # for the whole optimization round
```

The ProposalCard is what the user reads to pick. It's intentionally information-dense — solo creators with a Theme to advance need *insight*, not a single number.

### 3.2 Optimization objective (internal)

The optimization objective is the function the agent uses to rank candidates *inside* a search loop. Its job is **ordering**. It is a pure function: given the same candidate, it returns the same scalar (or totally-orderable structure). It is not surfaced in the UI.

Shape:

```python
def optimization_objective(candidate, config) -> Optional[float]:
  # Hard gates: failing any returns None (candidate rejected)
  if candidate.rubric.specificity < config.gates.hard.rubric.specificity_min: return None
  if candidate.rubric.disputability < config.gates.hard.rubric.disputability_min: return None
  if candidate.rubric.theme_fit < config.gates.hard.rubric.theme_fit_min: return None
  
  for persona_id in config.personas.primary:
    if candidate.ssr[persona_id].likelihood.mean < config.gates.hard.ssr_likelihood_min: return None
  
  # Diversity gate (computed against the running acceptable pool)
  if candidate.diversity_distance < config.gates.hard.diversity_min: return None
  
  # Within the acceptable set, rank by weighted composite
  composite = (
      config.weights.ssr_likelihood       * mean_across_primary(candidate.ssr.likelihood)
    + config.weights.ssr_value             * mean_across_primary(candidate.ssr.value)
    + config.weights.rubric_composite      * mean(candidate.rubric)
    + config.weights.cohort_coverage       * cohort_coverage_score(candidate)
    - config.weights.cohort_underservice   * cohort_underservice_penalty(candidate)
    + config.weights.novelty               * novelty_bonus(candidate, acceptable_pool)
  )
  return composite
```

### 3.3 Why separation matters

Three concrete benefits of keeping these separate:

1. **Tunable independently.** As we learn what produces good search behavior, we tune the optimization objective. As we learn what insight users find useful, we tune the ProposalCard. Coupling them couples those decisions.

2. **Per-Skill optimization variants.** Topic-optimize might weight novelty heavier. Draft-polish might weight `slop_penalty` heavier. Heart's-Desire-script-optimize might weight `appeal` × `purchase_intent` heavily. Different per-Skill objective functions; same ProposalCard shape.

3. **Drop one without breaking the other.** If the user-facing score isn't landing — if users don't find the per-axis breakdown useful and just want the overall mean — we can simplify the ProposalCard without changing any optimization-loop code. And vice versa.

---

## 4. Diversity preservation (mode collapse)

### 4.1 The failure mode

Mode collapse is the situation where, over iterations, the agent converges on a small number of "shapes" that score well, and stops exploring the candidate space. The output gets less diverse. Top-K returns become 5 minor variations of one or two templates.

This is the dominant risk in editorial-content optimization that doesn't exist in code optimization, because content has bounded search space and novelty value (see §3 of `THEME_TOPIC_POINTS_DEFINITION.md`).

### 4.2 Mechanisms (in order of effectiveness)

These are implemented as defaults; (3) and (5) are tunable.

**(1) Cosine-distance diversity rejection.**
When adding a candidate to the acceptable pool, reject if **cosine distance** to any existing acceptable candidate's embedding falls below the diversity floor (default `0.4`, equivalently cosine similarity ≤ 0.6, in OpenAI text-embedding-3-small space). Cheap (one extra embedding call per candidate), well-understood, no LLM involvement. **User-configurable** in Settings → Optimization → Diversity floor — solo creators with bounded Theme spaces may want a stricter floor (0.5+) to force more range; high-volume publications with broader Theme spaces may relax to 0.3 to admit more candidates.

**(2) Cohort-targeted sub-loops.**
Run separate optimization sub-loops, one per primary persona cohort. Each sub-loop's output is added to a shared pool. This forces persona-coverage diversity by construction.

For example, with personas `[ankit_indie_dev, ravi_studio_lead, mei_publisher]`, run three sub-loops:
- Sub-loop A: candidates targeted at Ankit (tighten persona panel to `[ankit]`)
- Sub-loop B: candidates targeted at Ravi
- Sub-loop C: candidates targeted at Mei

Then merge the three pools and re-rank under the full persona panel for the final top-K. Cost: ~3× more LLM calls than a single combined loop, but you can lower per-cohort iterations (e.g., 1 iteration per cohort vs 3 iterations combined) to compensate.

**(3) Explicit-contrast mutation prompts (tunable).**
When mutating winners, condition some mutations on prompts like:
- *"Take the opposite position from this Topic."*
- *"Find the angle this Topic ignores."*
- *"Generate a candidate that targets [persona X], the cohort least represented in the current pool."*
- *"Generate a Topic that the dominant trade press would consider too contrarian to publish."*

Forces the agent to generate adversarial candidates instead of monotonic improvements. Fraction of mutations using contrast prompts is configurable (default `0.4`).

**(4) Anti-pattern penalties in optimization objective.**
The `novelty_bonus` term in §3.2 rewards candidates that are far from the existing acceptable pool in embedding space. Effectively a regularizer pushing the optimizer toward novelty over pure-score-maximization. Default weight: `+0.15` of the composite.

**(5) Reserved slots in top-K (tunable).**
Top-K return is not purely sorted by composite — reserve a fraction of slots for diversity. Default behavior with k=5:
- 3 slots: top-3 by composite
- 1 slot: highest-composite candidate from the persona-cohort least represented in the top-3
- 1 slot: highest-`novelty_bonus` candidate (most distant from top-3 in embedding space)

User can override per-Skill: "5 by score" or "3 by score + 2 for range."

### 4.3 Why this isn't optional

If mode collapse isn't addressed by construction:

1. *User-facing UX failure.* User clicks "find me 5 Topics," gets 5 same-shape Topics, feels the system isn't doing real work, stops using the feature.
2. *Editorial monoculture.* If a user adopts the system's outputs over time, their publication's Topic mix narrows. Every Piece has the same shape. Publication becomes formulaic.
3. *Persona over-fit.* Mode collapse tends to produce candidates that score well on the *most common* persona type. Edge personas get systematically under-served.
4. *The interesting work is filtered out.* The whole point of the agent surfacing artifacts the user hasn't thought of is *unlikeness* to their default. Mode collapse kills exactly that.

The mechanisms above are minimum-viable. We expect to learn what works in 0p and 1A and tune.

---

## 5. Cost guardrails and user controls

### 5.1 Cost model

Every optimization round has these cost components:

```
total_cost = (
    n_candidates_generated    × cost_per_generation       # agent.generate / agent.mutate
  + n_candidates_passing_rubric × cost_per_rubric_judge   # judge call per candidate that passes hard gates
  + n_candidates_passing_rubric × n_personas × n_ssr_samples × cost_per_ssr_sample
                                                          # SSR is the dominant cost in deep panels
  + (n_drafts × n_personas if counter_audience_enabled)   # for Drafts only
                              × cost_per_counter_audience_call
  + n_candidates_admitted × cost_per_embedding             # diversity rejection
)
```

Per-target-kind defaults are in §6. Rough order-of-magnitude numbers as of 2026-Q2 model pricing (for sanity-checking, NOT for billing — actual cost reports go off measured tokens):

| Operation | Approx cost |
|---|---|
| Topic generation (Claude Haiku, ~500 tokens out) | ~$0.001 per candidate |
| Rubric judge (Claude Opus, ~2K tokens in/out) | ~$0.04 per judgment |
| SSR generation sample (Claude Haiku, ~200 tokens out) | ~$0.0005 per sample |
| OpenAI embedding (text-embedding-3-small) | ~$0.00002 per text |
| Counter-audience critic (Claude Sonnet, ~2K in / 1K out) | ~$0.02 per critique |
| Full Draft generation (Claude Sonnet, 2K-word draft, ~5K tokens out) | ~$0.08 per draft |
| Full Draft regeneration (Claude Opus, 2K-word draft) | ~$1.50 per draft |

For Topic optimization with defaults (20 candidates, 3 personas, 8 SSR samples, 3 iterations): **~$2–$5 per round**.
For full-search Draft optimization on a 2K-word post (10 candidates, 3 personas, 5 samples, 2 iterations): **~$50–$200 per round**.
For Heart's-Desire script full-search (50 candidates of a 1K-word scene, 5 personas, 8 samples, 3 iterations, with branching coverage): **~$300–$1500 per round**.

These are estimates. The system reports actuals after each run and uses them to calibrate future estimates per (Skill, user) pair.

### 5.2 User-facing controls (mandatory)

Every optimization round exposes these controls:

| Control | Default | Range | Notes |
|---|---|---|---|
| `n_candidates` | per-Skill | 5–200 | Per-iteration candidate count |
| `n_iterations` | per-Skill | 1–10 | Higher = better convergence, higher cost |
| `n_personas` | all `active` primary | subset of panel | Reducing lowers cost linearly |
| `n_ssr_samples` | 8 | 4–16 | Per (persona, candidate) pair |
| `budget_usd` | per-Skill | user-set | Hard cap; aborts run if projected to exceed |
| `wallclock_cap_minutes` | per-Skill | user-set | Secondary cap |
| `diversity_strategy` | `default` | enum | `default` / `aggressive` / `minimal` |
| `top_k_returned` | 5 | 1–20 | Diminishing returns above 10 |

### 5.3 Pre-launch UX (mandatory)

Before kicking off any optimization round, the UI shows:

```
You're about to run: factory_topic_optimize
Theme: AI Impact on Game Dev
Personas: Ankit, Ravi, Mei (3 active primary)

Configuration:
  20 candidates × 3 iterations × 8 SSR samples × 3 personas
  Top 5 returned with diversity reservation

Estimated cost: $3.40 ± 30%   (based on 2 prior similar runs)
Estimated wallclock: 6m 15s

Budget cap: $5.00  [edit]
Wallclock cap: 15m  [edit]

[Start optimization]    [Edit configuration]    [Cancel]
```

For **`draft_fullsearch`** rounds specifically (regardless of cost estimate), an additional double-confirm modal. This is the only target kind that double-confirms — every other target kind shows the cost preview at launch and proceeds; users who want to constrain cost set a tighter `budget_usd` cap.

```
This run will cost approximately $180.

This is a "full-search Draft optimization" run, which generates and scores
multiple complete drafts. This mode is opt-in because of cost.

I understand this run is expected to cost ~$180 and may take ~25 minutes.

[ ] Confirm.    [Start]    [Reduce scope]    [Cancel]
```

### 5.4 Mid-run UX (mandatory)

Live progress including cost-so-far, projected-actual, and a "stop now" button. The button does not abort in-flight LLM calls; it stops the loop after the current candidate's gates resolve. Acceptable candidates so far are preserved in `acceptable_pool`.

### 5.5 Post-run reporting

Actuals saved per (Skill, user) for future estimate calibration:
- Wallclock actual
- Cost actual (per-call breakdown available on hover)
- Candidates generated / accepted / rejected (with reject-reason histogram)
- Top-K composite score range
- Convergence reason: `budget_hit` / `iteration_max` / `convergence_signal` / `user_stopped`

---

## 5b. Two modes per target kind: propose vs optimize

For Theme, Topic, Point, and Outline target kinds, the system ships **both** a single-call propose Skill and a multi-iteration optimize Skill. They coexist; the user picks per use case.

| Mode | Cost | Wallclock | Output | When |
|---|---|---|---|---|
| `factory_<kind>_propose` | ~$0.10–$0.50 | 5–15 sec | 3–8 candidates from one pass, no gates beyond the rubric judge | Quick ideation, low-stakes drafts, rapid iteration where the user is doing most of the editorial thinking |
| `factory_<kind>_optimize` | ~$1–$5 (Topic), more for Theme/Outline | 1–10 min | Top-K from a multi-iteration round with hard gates, diversity preservation, and persona-stratified scoring | Deliberate exploration of a Theme; surfacing candidates the user wouldn't have written; high-stakes positions |

The propose Skills are the path of least resistance — fast, cheap, low ceremony. The optimize Skills are the differentiated product. Both ship.

For Draft, the modes are different shapes (targeted-axis vs full-search) covered in §7.

---

## 6. Per-target-kind variants

Each target kind has its own optimize variant with config defaults tuned to its shape and stakes.

### 6.1 Theme generation (`factory_theme_propose_optimize`)

**Purpose.** Generate candidate Themes for the user's review. Editorial sovereignty applies: the user picks, possibly picking nothing. The agent's job is to surface candidates the user wouldn't have generated on their own.

**Inputs.**
```
publication_id
voice_id (optional; defaults to publication's primary voice)
persona_panel: persona_id[]
context:
  pcp_window: {from, to} | null      # optional PCP-context window
  pcp_types: string[] | null         # subset of 11 PCP types to include
  panel_seed: PanelSeed | null       # optional Panel-Talk-derived seed (per
                                     # 02_HERO_APPLICATIONS.md §2.7.5;
                                     # see EDITORIAL_ROOM_CONTRACT.md §6.1)
  seed_emphasis: 'pcp' | 'panel' | 'media_diet' | 'unmet_needs' | 'mixed'
  exclude_existing_themes: bool      # default true
config:
  n_candidates: int = 12
  n_iterations: int = 2
  n_personas: int = all active primary
  n_ssr_samples: int = 8
  budget_usd: float = 3.00 (default cap)
  diversity_strategy: 'aggressive'   # Theme search needs maximum diversity
  top_k_returned: int = 10
```

**Generation strategy.** The Skill prompt seeds candidate Themes from:
- Persona unmet_needs across the panel (collected and de-duplicated)
- Publication's voice page (Theme should be coverable in this voice)
- Existing Themes in the publication (excluded by name as anti-targets, "don't generate Themes already in the map")
- *Optional:* PCP context — calendar events, Linear tickets, recent Slack threads, work-this-week notes — within the requested window
- *Optional:* Panel-Talk seed — synthesis output, talking points, or dialectic results promoted from a panel via `panel_seed` (per `EDITORIAL_ROOM_CONTRACT.md` §6.1). The `panel_seed.treat_as` field tells the Skill whether to prefer Themes that *resolve* the panel disagreement (`synthesis`), *commit* to one pole (`thesis` or `antithesis`), or *open the question further* (`open_question`).

PCP context is a structured input to the Skill prompt:
```
USER'S RECENT CONTEXT (last 30 days):
  Calendar:
    - 2026-04-22: meeting with Hooded Horse re: indie deal terms (recurring)
    - 2026-04-15: GDC publishing panel attendance
  Linear:
    - LIL-431: "Spike: AI-cost clawback clauses in 2025 contracts"
  Slack DMs (relevant snippets):
    - 4 conversations re: Embracer writedown follow-on effects
  Work-this-week notes:
    - Drafting publishing-deal review checklist
```

The Skill is prompted to: *"Propose Themes that emerge naturally from the user's recent context AND extend their voice, but are not already in their Theme map. Bias toward Themes the user has been thinking about implicitly but hasn't explicitly chosen to cover."*

**Mutation strategy.** Iteration 2 mutations explicitly target:
- "Take a Theme adjacent to [winner], from a different angle"
- "Surface a Theme the user's PCP context implies but the user hasn't articulated"
- "Find the Theme contrarian to current trade-press consensus that this user could uniquely cover"

**Hard gates.** Per `THEME_TOPIC_POINTS_DEFINITION.md` §3.2:
- `rubric.specificity ≥ 3`
- `rubric.durability_18mo ≥ 3`
- `rubric.pov_clarity ≥ 3`
- `rubric.defensible_exclusions ≥ 3` (Skill must produce out-of-scope list)
- For each primary persona: `rubric.audience_fit ≥ 3`

**SSR gates.** *Soft only* for Theme — no SSR likelihood-mean threshold. Reason: Theme adoption is editorial, not consumer behavior. SSR distributions are surfaced for insight; they don't gate Theme acceptance.

**Top-K return.** Default 10 (more than other Skills) because Theme adoption is rare and the user needs range to react against.

**Provenance flag.** PCP-seeded Themes carry `derived_from_pcp: true` and surface their seed events in the ProposalCard. Default `scope: personal` until user explicitly promotes.

**Default cost.** ~$1–$3 per round.

**When to use.** Quarterly Theme refreshes; when the user explicitly requests "find me a Theme I'm missing"; never in the default Editorial Room flow (Theme search is a deliberate action, not background optimization).

### 6.2 Topic optimization (`factory_topic_optimize`)

**Purpose.** Given a Theme, generate top-K Topics scoring 90+ for user selection. This is the main-line product feature.

**Inputs.**
```
theme_id (parent)
persona_panel: persona_id[]
context:
  pcp_window, pcp_types, panel_seed, seed_emphasis    # optional, same shape as Theme (§6.1)
  existing_topics_to_exclude: topic_id[]
  competition_check: bool                # default true; checks media_diet for overlap
config:
  n_candidates: int = 20
  n_iterations: int = 3
  n_personas: int = all active primary
  n_ssr_samples: int = 8
  budget_usd: float = 5.00
  diversity_strategy: 'default'
  top_k_returned: int = 5
```

**Generation strategy.** Seeds:
- Theme's POV statement and out-of-scope list
- Persona unmet_needs filtered to this Theme's scope
- Optional PCP context
- Recent Topic history under this Theme (anti-targets)
- Optional: media_diet competition check — penalize Topics already covered by named publications in personas' media diets, surface this in ProposalCard

**Mutation strategy.** Standard mode:
- Take winners and mutate position (sharpen, contrarian, narrow, broaden)
- 40% of mutations use explicit-contrast prompts
- Cohort-targeted variants: separate sub-loop per primary persona

**Hard gates.** Per `THEME_TOPIC_POINTS_DEFINITION.md` §4.2:
- `rubric.position_clarity ≥ 3`
- `rubric.specificity ≥ 3`
- `rubric.theme_fit ≥ 4` (must be unambiguously inside this Theme)
- `rubric.disputability ≥ 3`
- For each primary persona: `ssr.likelihood.mean ≥ 3.5`

**Diversity gates.** `diversity_distance ≥ 0.4` (cosine in OpenAI text-embedding-3-small space).

**Top-K composition.** With `diversity_strategy=default`:
- 3 slots: top by composite
- 1 slot: top from least-represented persona cohort
- 1 slot: highest-novelty (most distant from top-3)

**Default cost.** ~$2–$5 per round.

**When to use.** Default mode for "I have a Theme, what should I write?"

### 6.3 Point optimization (`factory_point_optimize`)

**Purpose.** Given a Topic, generate top-K Points (sub-claims) for the user to assemble into an argument structure.

**Inputs.**
```
topic_id (parent)
persona_panel: persona_id[]
config:
  n_candidates: int = 25
  n_iterations: int = 2
  n_personas: int = all active primary
  n_ssr_samples: int = 6
  budget_usd: float = 4.00
  diversity_strategy: 'default'
  top_k_returned: int = 8         # more Points returned than Topics —
                                  # user assembles 3–7 from the pool
```

**Generation strategy.** Seeds:
- Topic's one-position statement
- Existing claims_ledger entries under this Theme (cite-able evidence)
- Optional: research stage outputs (named sources, contracts, numbers)
- Counter-arguments ("what would a defender of the opposite position say?")

**Mutation strategy.**
- Sharpen the falsifier on a winner
- Tighten the source on a winner
- Generate the counter-Point to a winner
- Tighten Topic-fit (remove broad-Point variants)

**Hard gates.** Per `THEME_TOPIC_POINTS_DEFINITION.md` §5.2:
- `rubric.atomicity ≥ 4` (Points must be one-sentence one-claim)
- `rubric.falsifiability ≥ 3` (a stated falsifier required)
- `rubric.source_strength ≥ 3` (≥1 named source/study/studio/number)
- `rubric.topic_fit ≥ 4`
- SSR `value` family per primary persona, soft threshold `mean ≥ 3.0` (Points individually score lower than Topics)

**Top-K composition.** With 8 returned, reserve 2 slots for counter-argument-Points (Points that argue *against* the Topic, surfaced so the user can decide whether to acknowledge them in the Piece).

**Default cost.** ~$1.50–$4 per round.

**When to use.** Default mode for "I have a Topic, what claims should I make?"

### 6.4 Outline optimization (`factory_outline_optimize`)

**Purpose.** Given a Topic and a candidate Point pool, generate top-K Outline structures (orderings + Point selections).

**Inputs.**
```
topic_id (parent)
point_pool: point_id[]              # the user-curated Points from §6.3
persona_panel: persona_id[]
config:
  n_candidates: int = 12
  n_iterations: int = 2
  n_ssr_samples: int = 6
  budget_usd: float = 2.50
  diversity_strategy: 'default'
  top_k_returned: int = 3
```

**Generation strategy.** Each candidate Outline is a structural permutation:
- Subset of point_pool (select 3–7 Points)
- Ordering (narrative arc)
- Section structure (where to break, how to title sections)

The generation is therefore *combinatorial* over a fixed Point pool — fewer creative-text tokens, more arrangement decisions. Cost is dominated by SSR scoring, not generation.

**Mutation strategy.**
- Re-order a winner
- Swap a Point for an unused pool Point
- Combine two Points into one section
- Split a Point's evidence across two sections

**Hard gates.**
- `rubric.coverage ≥ 4` (all selected Points appear in the outline)
- `rubric.arc_quality ≥ 3` (narrative progression makes sense)
- `rubric.opening_strength ≥ 3` (first section earns continued reading)
- `rubric.closing_strength ≥ 3` (final section earns the user's "what changes for me Monday")
- SSR `confidence` per primary persona, `mean ≥ 3.5`

**Default cost.** ~$1–$2.50 per round.

**When to use.** After Point selection, before drafting.

### 6.5 Draft polish — targeted-axis (`factory_draft_polish_optimize`)

**Purpose.** Default Draft optimization mode. Given a Draft, identify the lowest-scoring axis and generate small targeted fixes. This is autonovel's actual loop pattern, not full-search.

**Inputs.**
```
draft_id (parent)
persona_panel: persona_id[]
config:
  n_axis_per_round: int = 1            # one axis per polish round
  n_candidate_fixes_per_axis: int = 3  # generate 3 alternative fixes
  scope_per_fix: 'paragraph'           # 'sentence' | 'paragraph' | 'section'
                                       # determines mutation granularity
  n_personas: int = all active primary
  n_ssr_samples: int = 8
  budget_usd: float = 0.50             # per-axis; cheap because scope is small
  diversity_strategy: 'minimal'        # don't need diversity for targeted fixes
  top_k_returned: int = 3              # user picks 1 of 3
```

**Generation strategy.**
1. Score the existing Draft on all axes (rubric + SSR + counter-audience + slop_penalty)
2. Identify the axis with lowest score and highest leverage (most-personas-affected × score-delta-from-target)
3. Identify the *specific paragraph* (or sentence/section) most responsible for the low score, using the rubric judge's `weakest_moment` quote
4. Generate `n_candidate_fixes_per_axis` candidate replacements for that paragraph, keeping the rest of the Draft constant
5. Score each fix-Draft (re-run scoring; cheap because most of the Draft is unchanged and SSR is fast)
6. Return top-K fixes

**Mutation strategy.** Mutations target the specific axis:
- If axis is `prose_quality`: rephrase for sentence variety / vocabulary specificity
- If axis is `voice_adherence`: rewrite to match voice page's signature moves
- If axis is `specificity`: insert named studio / number / clause where vague
- If axis is `lore_integration`: connect to claims_ledger entries
- If axis is `slop_penalty`: replace tier-1/2/3 banned words

**Hard gates.** The fix must:
- Improve the targeted axis by ≥ 1.0 score points
- Not degrade any other axis by > 0.5 points
- Pass `slop_penalty ≤ original_slop_penalty`

**User flow.** User accepts/rejects each top-K fix. Accepted fix replaces paragraph in the canonical Draft. Loop runs again on the next-lowest axis. User stops when satisfied.

**Default cost.** ~$0.20–$0.50 per axis × 3–5 axes = ~$0.60–$2.50 for full polish on a 2000-word post.

**When to use.** Default Draft polish mode for posts, articles, blog content. The user does NOT need to opt in or double-confirm.

### 6.6 Draft full-search (`factory_draft_fullsearch_optimize`)

**Purpose.** Generate multiple complete Drafts of the same Topic, score each across personas, return top-K. This is the pattern Joseph specifically called out for **Heart's Desire game scripts** and other high-stakes long-form where full-search ROI justifies the cost.

This mode is **opt-in only** with an explicit double-confirm modal showing estimated cost.

**Inputs.**
```
topic_id, outline_id (parent context)
persona_panel: persona_id[]
config:
  n_candidates: int = user-set, default 5, max 50
  n_iterations: int = user-set, default 1, max 5
  n_personas: int = user-set, default 3, max all
  n_ssr_samples: int = user-set, default 8, max 16
  budget_usd: float = user-set, MANDATORY, no default
  diversity_strategy: user-set, default 'aggressive'
  top_k_returned: int = user-set, default 5
  voice_id, scoring_pipeline_id          # standard
  
  # Game-script-specific extensions (optional):
  branching_coverage: 'narrow' | 'wide' | 'exhaustive'
  player_choice_personas: persona_id[]   # extends panel with player personas
                                         # for choice-stage decisions
  monetization_stage_likert: 'purchase_intent' | null
                                         # for paid-choice scenes
```

**Generation strategy.**
- Each candidate is a complete Draft (article-length 1.5K–4K words; game scene 500–2K words)
- Generation uses Claude Sonnet by default, configurable to Opus for the highest-stakes runs
- Iteration 2+ uses winner-based mutation: take top-K winners and rewrite them with structural changes (different opening, different argument arc, different voice register)

**Hard gates.** All standard gates from §6.5 PLUS:
- `slop_penalty ≤ 2.0` (very tight slop tolerance for full-search)
- For each primary persona: `ssr.value.mean ≥ 4.0` (higher bar than polish mode)
- For game scripts: branching coverage check (every named choice has a follow-up scene candidate)

**SSR family for game scripts.** `appeal` × `purchase_intent` (when scenes contain monetized choices).

**Diversity strategy.** `aggressive` mandatory. Game scripts especially need range — 5 candidates that all open the same way is a dealbreaker for the use case (player-choice variability is the product).

**User flow before launch.** Mandatory double-confirm modal:
```
This run will cost approximately $245.
  - 10 candidates × 3000 words × Claude Sonnet generation
  - 5 personas × 8 SSR samples per candidate
  - 2 iterations
  - Diversity strategy: aggressive (3× sub-loop cost)

Wallclock estimate: ~32 minutes.
Budget cap: $300 (will abort if projected to exceed)

I understand this run is expected to cost ~$245 and may take ~32 minutes.

[ ] Confirm.    [Start]    [Reduce scope]    [Cancel]
```

**Default cost.** Highly variable.
- 2K-word post, 10 candidates, 3 personas, 5 samples, 2 iterations: ~$50–$200
- Heart's Desire scene (1.5K words), 50 candidates, 5 personas, 8 samples, 3 iterations, branching coverage: ~$300–$1500
- Heart's Desire full-act sweep (10 scenes × 50 candidates each): ~$3K–$15K (run only when warranted by published-revenue impact)

**When to use.**
- Heart's Desire scripts (Joseph's stated use case)
- Long-form anchor content where the Piece will be referenced for years
- A/B test setup for paid email courses, paid newsletters, or other high-LTV content
- *Not* for daily/weekly Substack posts. Default polish mode is correct there.

**Risks (surfaced in UX).**
- Goodhart's law on long-form content is severe. The agent will write to whatever the rubric weights highest.
- Voice homogenization: full-search across many candidates tends to produce voice-mean output. Mitigations: tighter `voice_adherence` gate, slop_penalty ceiling, mandatory `aggressive` diversity.
- Cost can compound. The budget cap is the primary safety. Mid-run actuals are visible.

---

## 7. Full-search vs. targeted-axis: when each applies

A decision table for when to use which Draft mode:

| Situation | Mode | Reason |
|---|---|---|
| Substack post, blog post, weekly newsletter | Targeted-axis | Cost. Polish is good enough; full-search is overkill. |
| Anchor article that will be referenced for years | Full-search opt-in | Quality matters more than cost. Worth the spend once. |
| Game-script scene (Heart's Desire) | Full-search opt-in (default) | Branching content where range is the product. ROI on player engagement justifies it. |
| Email course / paid newsletter content | Full-search opt-in | LTV per subscriber justifies high-cost optimization once. |
| Reactive news take | Targeted-axis | Time pressure. Polish in <1h beats search in 30m. |
| First Draft at all? | Neither | Optimization runs on a Draft that already exists. The first Draft is a generation Skill, not an optimization Skill. |

**Why targeted-axis is the default for posts.**

Targeted-axis is structurally aligned with how good editing actually works. A human editor doesn't rewrite 50 versions of a piece and pick the best. A human editor reads, identifies the weakest paragraph, suggests a fix, accepts or rejects, moves to the next weakest. That's what targeted-axis encodes.

Full-search is for situations where the *whole shape* matters and may be wrong, and exploring shape-space is worth more than tuning the existing shape.

---

## 8. Convergence and stopping

A round stops when any of:

1. **Budget exhausted.** `cost_so_far + projected_next_iteration_cost > budget_usd`. Round stops cleanly; existing acceptable_pool is preserved and returned.
2. **Iteration max hit.** `iteration > config.max_iterations`. Same as budget — clean stop.
3. **Wallclock cap hit.** Same as budget.
4. **Convergence signal.** Top-K composite scores haven't improved meaningfully in N iterations (default `N=2`, threshold `delta_composite < 0.05`). Indicates further iteration is wasted.
5. **User stops.** Stop button in mid-run UX. Loop completes the current candidate's gates, preserves acceptable_pool, returns.
6. **Empty acceptable set.** If after iteration 2 the acceptable_pool is empty (no candidate passed the hard gates), stop and return diagnostic. Either the Theme/Topic is too narrow, or the rubric thresholds are too tight, or the persona panel is mismatched. Diagnostic surfaces which gate is rejecting most candidates.

Convergence reason is reported in `OptimizationResult.convergence_reason` and surfaced in the post-run UI:

```
Round complete: convergence (top-3 composite stable for 2 iterations)
  Cost actual: $3.18  (estimate was $3.40, -6%)
  Wallclock:   5m 42s
  Acceptable pool: 14 / 60 generated (23.3%)
  Top-5 composite range: 4.21 — 4.78
  
Reject reasons (in 46 rejects):
  - 18 × specificity gate (named studio missing)
  - 12 × diversity rejection (too similar to existing acceptable)
  - 9  × disputability gate (no defensible counter-position)
  - 7  × persona likelihood < 3.5
```

---

## 9. What's NOT optimized

Editorial sovereignty defines a hard line. The following are *not* optimization targets:

1. **Theme adoption.** Agent suggests; user picks. No "best Theme" output that bypasses user judgment.
2. **Voice changes.** Voice is authored by the user. The optimizer respects voice as a constraint; it does not propose changes to voice pages.
3. **Persona definitions.** Personas are authored by the user. The optimizer scores against personas; it does not propose new personas or modify existing ones.
4. **Publication-level decisions.** Whether to publish a Piece, when to publish, where to cross-post, whom to send to. These are user decisions on the user's editorial calendar.
5. **Cross-Theme tradeoffs.** The optimizer doesn't decide that the user should cover Theme A instead of Theme B. Theme prioritization is a publication-level decision.
6. **Audience composition.** Who's in the persona panel is the user's call. The optimizer suggests new personas for the user to consider (in a separate Skill, not the main optimize loop), but never silently adds them.
7. **Score thresholds.** The user sets gate thresholds. The optimizer doesn't auto-tune them.

Any expansion of this list requires explicit product-level decision and is documented in v2.

---

## 10. Failure modes and mitigations

| Failure mode | Mitigation |
|---|---|
| Mode collapse (homogenized top-K) | §4 mechanisms; required by default |
| Goodhart's law (rubric-gaming) | Multi-gate (rubric + SSR + counter-audience + slop), all required to pass; no single composite that can be gamed |
| Cost runaway | Budget cap + mid-run actuals + abort-on-projection; double-confirm modal at high stakes |
| Empty acceptable pool | Diagnostic surfacing rejection-reason histogram; user can lower thresholds with explicit action |
| SSR distributional collapse | Two-vendor enforcement (per `SYNTHETICALRESEARCH_API_CHANGES.md` §5); cross-vendor embedding |
| Voice drift (full-search) | `voice_adherence` hard gate + `slop_penalty` ceiling; mandatory `aggressive` diversity in full-search mode |
| User confusion about top-K differences | ProposalCard surfaces *why each candidate is in top-K* — composite score, persona breakdown, position in diversity reservation, comparable history |
| Persona over-fit | Cohort-targeted sub-loops (§4.2-2) by default; per-persona SSR scores surfaced individually, not just averaged |
| User adopts low-confidence top-K | Confidence (Shannon-entropy) reported per persona; ProposalCard flags low-confidence selections |
| PCP-context overreach | `derived_from_pcp: true` flag; default `scope: personal`; provenance shown; user must explicitly promote |

---

## 10b. Two-track scoring: rubric judges and SSR are different signals

The optimization loop runs two scoring tracks in parallel: **rubric judges** (autonovel-style Opus critics that return per-axis `{score, gap, fix, weakest_quote}` structured critique) and **SSR persona panels** (embedding-based mapping of synthetic responses to Likert distributions). These are not redundant. They measure different things:

- **Rubric judges** measure *editorial quality against criteria the user defined* — voice match, specificity, falsifiability, structural quality. They produce actionable critique. The bias paper acknowledges that direct LLM rating can be more accurate at point-estimate prediction than embedding-based mapping. For "is this paragraph weak, and how do I fix it" — the rubric judge is the better tool.
- **SSR persona panels** measure *predicted distributional reception by named audience members* — would Ankit click? Would Mei find this useful? They produce calibrated probability distributions, independent from the generation channel (per `SYNTHETICALRESEARCH_API_CHANGES.md` §5). For "would this land with my audience" — SSR is the better tool because the embedding-based measurement channel doesn't inherit the generation model's biases.

**Disagreement between the two tracks is signal, not noise.** The interesting cases:

| Rubric judge says | SSR persona panel says | Interpretation |
|---|---|---|
| 8.5 / strong | High likelihood, high value | Confident green-light. Both signals align. |
| 8.5 / strong | Low likelihood, dubious | Editorial quality is high but the persona panel is unconvinced. Often signals: voice match strong but topic relevance weak, or specificity present but the named studios/numbers don't matter to the actual reader. **Surface this disagreement to the user prominently.** |
| 5 / mediocre | High likelihood, high value | Persona panel finds this interesting despite craft weakness. Often signals: a contrarian or unusual angle that lands emotionally even if it's not technically tight. The user should consider whether the rubric criteria are right. |
| 5 / mediocre | Low likelihood, dubious | Confident reject. Both signals align. |

The Editorial Room's ProposalCard surfaces this disagreement directly. When rubric and SSR diverge by more than a configured threshold (default: rubric composite > 7 AND SSR likelihood mean < 3.5, or vice versa), the candidate gets a `disagreement_flag` with the specific divergence pattern, and the UI shows both scores side-by-side with the disagreement explicitly named.

**Operationally:** SSR is a confidence-aware *validator* of editorial intent, not the optimizer's only objective. The rubric judge is where actionable revision suggestions come from; SSR is where audience-fit reality-checking comes from. Treating them as redundant (averaging them, or using only one) loses the specific information their disagreement carries.

---

## 11. Open questions and what we're not building yet

These are deliberately not resolved here. Each is a real product question worth coming back to when we have shipped enough to inform the answer.

- **Persona-panel optimization.** Should the system suggest persona-panel changes when it observes systematic under-fit? (e.g., "your Topics consistently fail to land with `mei_publisher` — consider revising her `triggers_to_close`"). Worth exploring once we have enough optimization-round history to detect under-fit reliably.
- **Cross-publication learning.** If the user runs multiple publications, can rejection patterns from one calibrate gates on another?
- **Auto-adopting Themes from PCP without explicit user action.** Tempting but violates editorial sovereignty (per §9). Stays opt-in.
- **Optimization across multiple Pieces simultaneously** (e.g., "given my next 5 Pieces under this Theme, optimize the *sequence*").
- **Real-time user feedback in-loop** (user thumbs up/down on candidates mid-iteration to steer the agent).
- **Score calibration against actual publish outcomes.** Once shipped Pieces have engagement data, calibrate SSR-predicted scores against reality.

---

## 12. References

- Karpathy, A. *autoresearch.* GitHub, March 2026. [Pattern source: agent-mutates-code, fixed budget, keep/revert, loop overnight.]
- Maier, B. F. et al. *LLMs Reproduce Human Purchase Intent via Semantic Similarity Elicitation of Likert Ratings.* arXiv:2510.08338v3, Oct 2025. [SSR scoring methodology underpinning all gates.]
- Pichardo, E. V. *Measuring Self-Rating Bias in LLM-Generated Survey Data.* arXiv:2602.13862v2, Feb 2026. [Two-vendor enforcement; min-max + softmax + τ; anchor calibration.]
- autonovel `evaluate.py`, `apply_cuts.py`, `gen_revision.py` — reference targeted-axis polish loop implementation.
- syntheticalresearch `packages/ssr-core/src/` — reference SSR implementation (currently being modified per `SYNTHETICALRESEARCH_API_CHANGES.md`).
- `THEME_TOPIC_POINTS_DEFINITION.md` — definitions of artifacts the loop optimizes; rubric tests are the hard gates.
- `SCHEMA_DEFINITION.md` — persona schema; personas are the panel the loop scores against.
- `EDITORIAL_ROOM_CONTRACT.md` §9 — RPC shape for optimization rounds.
- `01_ARCHITECTURE.md` §15 — pluggable Scorer substrate the loop runs on.
