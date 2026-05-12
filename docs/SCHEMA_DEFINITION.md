# Persona Schema Definition

**Owner:** Joseph
**Last updated:** 2026-04-30
**Companion docs:** `EDITORIAL_ROOM_CONTRACT.md`, `THEME_TOPIC_POINTS_DEFINITION.md`, `OPTIMIZATION_LOOP.md`, `SYNTHETICALRESEARCH_API_CHANGES.md`, `01_ARCHITECTURE.md` §15

> **Note on document state.** Planning-phase reference doc. The system is greenfield — schema fields, defaults, and the validation pipeline can change freely until the first production deployment.

---

## 1. Purpose

This document defines the canonical persona schema used by the GameMakers Content Factory. Personas are first-class substrate primitives (page_type=`persona`) and are the input that lets every scoring stage — Theme, Topic, Outline, Draft — produce numeric, optimizable signals about whether a given artifact serves the audience the publication actually has.

A persona is *not* a segment description, an ICP slide, or a marketing archetype. It is a concrete fictional individual with enough specificity that an LLM can roleplay them coherently across multiple turns, and enough structured data that a deterministic system can stratify, weight, and aggregate panel responses across them.

The schema is designed to satisfy three downstream consumers simultaneously:

1. **SSR** (Semantic Similarity Rating, Maier et al. 2025; Pichardo 2026) — embedding-based mapping from synthetic free-text responses to Likert distributions. SSR is the proven distributional method with ~90% test–retest correlation attainment in published validation, and it is the primary scoring path for Theme/Topic/Outline/Draft acceptance.
2. **Autonovel-style rubric judges** — Opus-class LLM critics that return per-criterion `{score, gap, fix, note}` objects with mandatory weakest-quote requirements. Used for criterion-level coaching and ship-gating.
3. **Counter-audience critics** — single-persona roleplay critics that read a draft as a specific reader and push back. Distinct from SSR in framing (read-and-pushback vs roleplay-as-respondent) and used during Polish.

If a future scorer shows up that needs a different persona shape, the schema is versioned (see §10).

---

## 2. Design constraints (where these fields come from)

### 2.1 SSR paper findings that bind the schema

- **Detailed persona conditioning is necessary, not optional.** Without rich demographic + behavioral conditioning, correlation attainment collapsed from ρ ≈ 92% to ρ ≈ 50% in the SSR paper's ablation. This means the canonical prose blob (`detailed_profile`) cannot be skipped or auto-generated from sparse fields.
- **Naturalistic, first-person, behavioral anchor language outperforms formal jargon by +29 percentage points** on exact-match accuracy. Anchors are NOT part of the persona — they're part of the scoring pipeline — but the persona's `voice_of_customer_quotes` field exists specifically to seed naturalistic anchors at the high end of the scale.
- **Asymmetric embedding** (anchors as `document`, responses as `query`) adds another +6 pp.
- **Min-max normalization with τ ≈ 0.15** is the validated softmax temperature.
- **Domain-specific anchor refinement matters.** Per-domain accuracy ranges 33–90%. Anchors must be authored per domain and per Likert family, not reused generically.
- **Cross-vendor embedding generalization holds.** OpenAI `text-embedding-3-small` reaches 77% exact match vs Voyage 3.5-lite's primary reference. Either is acceptable; choosing the same vendor as your generation model is methodologically suspect (see §2.2).

### 2.2 Self-rating-bias paper findings that bind the schema

- **Circularity bias.** When the same model both generates the free-text response and assigns the Likert rating, variance compresses by roughly 4× (σ² = 0.21 vs 0.87 for SSR). Consequence: the SSR pipeline must use **two different model families** — one for generation, a separate one for embedding-based mapping. If you skip this, distributional metrics are not transferable.
- **Removing question text from the rating prompt actually *improves* accuracy.** This is a control finding (rules out information-asymmetry as the explanation for SSR's lower accuracy than direct LLM rating). Operationally: keep anchor sets free of question-context strings. Don't prepend the survey question to anchor statements.

### 2.3 syntheticalresearch (current SSR implementation) constraints

- The actual SSR prompt template injects exactly **one persona field**: `detailed_profile`. Every other structured field on the persona record is metadata for filtering, sampling, UI, and import validation. Operationally this means the canonical prose blob is the binding contract — if you don't author it carefully, no amount of structured field richness saves you.
- The current TS implementation's structured fields are gaming-domain-specific (`platforms`, `favoriteGenres`, `currentGames`, `playMinutes`, `spendingTier`, `spendingBehavior`). For a non-fiction publication audience, those fields don't generalize; they should live in `cohort_tags` or a profile-type-specific extension, not in the canonical schema.

### 2.4 Autonovel rubric-judge constraints

- Autonovel's reader panel uses prose system prompts, not structured fields. The judge consumes free-form persona descriptions at T=0.7 and asks open questions, then mines disagreement.
- Autonovel's *evaluator* (`evaluate.py`) uses Opus 4.6 at T=0.3 and returns `{score, gap, fix, note}` per dimension. It expects the rubric criteria to be specified in the prompt, not derived from the persona. So the persona's role in autonovel-style scoring is to populate the audience-fit dimension with explicit per-persona criteria.
- This is why the schema has bullet-list `cared_about_criteria` and `triggers_to_close` fields. These are *directly readable* by rubric judges without prose-parsing.

### 2.5 Net design principles

1. **`detailed_profile` is the binding contract for SSR.** Author it once, by hand, in second-person prose, 150–300 words. All other structured fields exist to inform it, validate it, and stratify aggregations — they do not replace it.
2. **Bullet-list signals (`cared_about_criteria`, `triggers_to_close`, `unmet_needs`) are for rubric judges and counter-audience critics.** Not injected into SSR generation prompts (would over-coach the model). Are injected into autonovel-style judges (which want explicit criteria) and into counter-audience prompts.
3. **Quotes are anchor seeds.** `voice_of_customer_quotes` is naturalistic, first-person, behavioral language directly usable as anchor seeds at the high end of the appeal/value/likelihood Likert scales.
4. **Demographics are structured for stratification, not prose injection.** Age, income band, and role-to-topic are structured because they're stratification dimensions in panel aggregation. They are *also* mentioned in `detailed_profile` because the SSR pipeline only sees the prose.
5. **The schema is domain-extensible.** GameMakers needs different fields than a SaaS publication or a B2C lifestyle publication. We separate the canonical schema from domain extensions via `cohort_tags` and explicit profile-type extensions; domain-specific fields don't pollute the canonical schema.

---

## 3. Canonical schema (v1)

The canonical persona record is a `page` with `page_type=persona`. The full content_json shape:

```yaml
persona:

  # IDENTITY ─────────────────────────────────────────────────────────────
  page_id: persona.ankit_indie_dev          # required, globally unique
  display_name: "Ankit Reddy — indie technical co-founder"  # required
  scope: global                             # required: global | organization | personal
  status: active                            # required: active | dormant | archived

  # DEMOGRAPHICS (structured, used for stratification & weighting) ──────
  demographics:
    age: 33                                 # int | null
    gender: "male"                          # free text; nullable
                                            # NB: SSR paper shows gender pattern is NOT
                                            #     reliably replicated by LLMs — keep as
                                            #     metadata, do not over-rely
    location_country: "IN"                  # ISO 3166-1 alpha-2; nullable
    location_freeform: "Bangalore, India"   # text; what appears in detailed_profile
    occupation: "Technical co-founder, 6-person indie studio"
    income_band: comfortable                # 5-tier enum:
                                            #   struggling | tight | stable
                                            #   | comfortable | affluent
    role_to_topic: maker                    # 6-tier enum:
                                            #   maker | operator | observer
                                            #   | decision_maker | learner | hobbyist

  # CONTENT-DOMAIN BEHAVIOR (structured) ────────────────────────────────
  content_behavior:
    discovery_channels:                     # array of strings; how they find content
      - twitter_quote_tweets
      - whatsapp_forwards
      - substack_recco
    consumption_format:                     # array; how they consume
      - substack_post
      - podcast_walks
      - twitter_thread
    typical_session_minutes: 22             # int; approximate read-session length;
                                            # informs Topic length-fit scoring
    media_diet:                             # 3–8 named publications/people they
                                            # already read; informs Topic-competition
                                            # checks during Topic Workshop
      - "GamesIndustry.biz"
      - "Game Maker's Notebook (Brian Provinciano)"
      - "Jason Schreier"

  # SCORABLE SIGNALS (bullet lists) ─────────────────────────────────────
  # These ARE injected into rubric judges and counter-audience critics.
  # They are NOT injected into SSR generation prompts.

  cared_about_criteria:                     # 5–8 bullets
                                            # what makes them open / finish / forward
    - "Concrete operating impact with numbers from a named studio"
    - "Founder-eye-view, not analyst-deck framing"
    - "Honest takes on what AI tools break in a small-team workflow"
    - "Contract/term shifts in publishing — his next deal lives or dies on these"
    - "Survival economics of teams ≤ 10 people specifically"
    - "Pieces he can finish on a 22-minute auto ride"

  triggers_to_close:                        # 5–8 bullets
                                            # what closes the tab
    - "Opens with 'In recent years…'"
    - "Trade-press neutrality: 'experts disagree on whether…'"
    - "AAA-only framing — assumes 200-person teams"
    - "Words: 'leverage' as a verb, 'unlock,' 'the future of X'"
    - "More than 3 paragraphs before a concrete fact lands"
    - "Hedging that makes the piece say nothing"

  voice_of_customer_quotes:                 # 3–6 quotes
                                            # paraphrased lines they'd actually say
                                            # USE THESE AS ANCHOR SEEDS for high end of
                                            # appeal/value/likelihood Likert families
    - "I don't have time for a 4,000-word post about AI. Tell me what to change Monday."
    - "Half the AI takes I read are by people who haven't shipped since 2019."
    - "If you don't name a studio, I assume you're guessing."

  unmet_needs:                              # 3–5 bullets
                                            # what they wish someone covered
                                            # informs Topic generation Skill seeds
    - "Real before/after on AI-assisted asset pipelines, with hours/$ saved"
    - "What publishers are actually changing in indie deals right now"
    - "Honest writeups of small studios that died — the math, not the eulogy"

  # CANONICAL PROSE (the binding SSR contract) ──────────────────────────
  detailed_profile: |                       # 150–300 words, second-person, behavioral
                                            # THIS IS WHAT THE SSR LLM SEES.
                                            # Author by hand. Do not auto-generate.
    You are Ankit Reddy, a 33-year-old technical co-founder of Mossroot Games,
    a 6-person indie studio in Bangalore. You shipped one premium roguelite on
    Steam in 2024 (~38k units) and you are nine months from runway end on your
    second project. You are the engine and tools person; your co-founder runs
    design and business. You work from a co-working space in Indiranagar four
    days a week. You have a 2-year-old at home. You read on your phone during
    the auto ride. You follow ~200 game-dev accounts on Twitter and listen to
    Game Maker's Notebook on walks.

    Financially, you can pay your bills without problems and have some money
    left for occasional treats — but the studio's runway is the constraint
    that drives most of your decisions. You're rebuilding your content
    pipeline around gen-AI tools because you can't afford to hand-author
    another 200 biomes. You are talking to two publishers and you read every
    indie-deal-terms thread you see.

    You are tired but generous. You don't have time for theory. You want
    pieces that change what you do on Monday, written by people who have
    shipped recently, with named studios and real numbers in them.

  # COUNTER-AUDIENCE SEED (Polish-stage critic) ─────────────────────────
  counter_audience_prompt: |                # 80–150 words
                                            # used by factory_counter_audience Skill
                                            # role + posture + ask
    You are Ankit Reddy. You have nine months of runway and a 2-year-old at
    home. You read the following draft on the auto ride home. Push back on
    anything that assumes a team larger than yours, anything that hedges
    instead of taking a position, anything that makes a claim about indie
    economics without naming a studio or a number, and anything you couldn't
    act on by next Monday. Be specific. Quote the line you're objecting to.
    You are tired but generous.

  # SAMPLING / WEIGHTING (panel mechanics) ──────────────────────────────
  sampling:
    weight: 1.0                             # default 1.0; can over/under-weight
                                            # in panel aggregations
    n_samples_default: 8                    # SSR samples per (persona, asset) pair
                                            # at panel time; can be overridden by
                                            # the scoring_pipeline page
    temperature_override: null              # nullable float; null = use scorer default
                                            # (Claude Haiku gen at T=0.7 per SSR paper)
    cohort_tags:                            # array; for stratification & filtering
      - indie
      - small_studio_le_10
      - technical_founder
      - india
      - apac

  # METADATA ────────────────────────────────────────────────────────────
  meta:
    owner_user_id: <uuid>
    schema_version: 1
    created_at: 2026-04-30T00:00:00Z
    updated_at: 2026-04-30T00:00:00Z
    derived_from: null                      # optional page_id of source persona
                                            # (e.g., generic 'indie_dev_archetype'
                                            # → personalized 'ankit_indie_dev')
```

---

## 4. Field-by-field reference

### 4.1 Identity fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `page_id` | string | yes | Format: `persona.<slug>`. Globally unique. |
| `display_name` | string | yes | Human-readable. Always includes a name + role/identifier. |
| `scope` | enum | yes | `global` (substrate-default), `organization` (org-shared), `personal` (single user). |
| `status` | enum | yes | `active` (used in panels), `dormant` (excluded by default), `archived` (read-only). |

### 4.2 Demographics (structured)

| Field | Type | Required | Notes |
|---|---|---|---|
| `age` | int \| null | no | Drives age-stratified aggregation. Paper: age pattern *is* reliably replicated by LLMs. |
| `gender` | string \| null | no | Free text. Paper: gender patterns NOT reliably replicated — keep as metadata only, do not stratify panels on this without external validation. |
| `location_country` | ISO-3166 alpha-2 \| null | no | For region stratification. |
| `location_freeform` | string | yes if `location_country` set | This is the string that appears in `detailed_profile`. |
| `occupation` | string | yes | Drives role-to-topic relevance. |
| `income_band` | enum | yes | 5-tier: `struggling` \| `tight` \| `stable` \| `comfortable` \| `affluent`. Paper: income IS reliably replicated. Used for purchasing-decision-related Likert questions. |
| `role_to_topic` | enum | yes | 6-tier: `maker` \| `operator` \| `observer` \| `decision_maker` \| `learner` \| `hobbyist`. Drives Theme audience-fit scoring (does this Theme serve makers, decision-makers, or learners?). |

### 4.3 Content-domain behavior (structured)

| Field | Type | Required | Notes |
|---|---|---|---|
| `discovery_channels` | string[] | yes | 3–6 entries. Drives Topic seeding (where do we need this Topic to circulate?). |
| `consumption_format` | string[] | yes | 2–5 entries. Drives Piece-format choice (long-form post, podcast, thread, etc.). |
| `typical_session_minutes` | int | yes | Approximate read-session length. Drives Topic length-fit scoring. |
| `media_diet` | string[] | yes | 3–8 named publications / people. Drives Topic-competition check during Topic Workshop ("does this Topic exist in their existing diet?"). |

### 4.4 Scorable signals (bullet lists)

| Field | Type | Required | Notes |
|---|---|---|---|
| `cared_about_criteria` | string[] | yes | 5–8 bullets. What makes them open / finish / forward. **Injected into rubric judges.** Each bullet must be specific enough that a judge can mechanically check whether the artifact satisfies it. |
| `triggers_to_close` | string[] | yes | 5–8 bullets. What closes the tab. **Injected into rubric judges and counter-audience critics.** Highest-leverage field for Polish-stage critique. Bullets should name specific words, structures, or framings, not vague vibes. |
| `voice_of_customer_quotes` | string[] | yes | 3–6 quotes. Paraphrased lines they'd actually say. **Used as anchor seeds for the high end of appeal / value / likelihood Likert families** — directly addresses the SSR paper's naturalistic-anchor finding. |
| `unmet_needs` | string[] | yes | 3–5 bullets. What they wish someone covered. **Drives Topic generation Skill seeds** during Topic Workshop. |

### 4.5 Canonical prose

| Field | Type | Required | Notes |
|---|---|---|---|
| `detailed_profile` | string | yes | 150–300 words, second-person, behavioral. **THIS IS THE BINDING SSR CONTRACT** — it is the only persona field the SSR generation LLM actually sees. Must be authored by hand. Auto-generation from structured fields is forbidden initially (drift risk + loss of voice fidelity). |
| `counter_audience_prompt` | string | yes | 80–150 words. Used by `factory_counter_audience` Skill. Frames role + posture + ask. Distinct from `detailed_profile` because the counter-audience task is *read-and-pushback*, not *roleplay-as-respondent*. |

### 4.6 Sampling / weighting

| Field | Type | Default | Notes |
|---|---|---|---|
| `sampling.weight` | float | 1.0 | Multiplier in panel aggregations. Used to over/under-weight specific personas in a composite score. |
| `sampling.n_samples_default` | int | 8 | SSR samples per (persona, asset) pair. Can be overridden by the `scoring_pipeline` config. |
| `sampling.temperature_override` | float \| null | null | Per-persona generation temperature. Null = use scorer default (T=0.7 per SSR paper). |
| `sampling.cohort_tags` | string[] | [] | Used for stratification, filtering, and panel construction. |

### 4.7 Metadata

Standard substrate metadata.

---

## 5. How fields are consumed by each scorer type

| Scorer type | Fields consumed | Injection method | Why these fields |
|---|---|---|---|
| **SSR generation** | `detailed_profile` only | Direct prose injection into the SSR generation prompt template (per syntheticalresearch's actual code path) | SSR paper finding: detailed persona conditioning is the dominant factor. Adding bullet lists to the generation prompt over-coaches the model and degrades naturalness. |
| **SSR scoring (embedding map)** | None — scoring uses anchor statements, which live on the `scoring_pipeline` page, not the persona | N/A | Anchors are domain-specific and Likert-family-specific; they belong on the pipeline, not the persona. |
| **Autonovel-style rubric judge** | `cared_about_criteria`, `triggers_to_close`, `unmet_needs`, `display_name` (plus structured demographics fields when needed) | Bullet-list injection into the rubric prompt as the audience-fit criteria for that persona | Rubric judges expect explicit, mechanically-checkable criteria. Bullet lists are directly readable. |
| **Counter-audience critic** (`factory_counter_audience`) | `counter_audience_prompt`, `triggers_to_close` | `counter_audience_prompt` becomes the system prompt; `triggers_to_close` is appended as explicit "look for these" criteria | Counter-audience is a read-and-pushback task — needs role + posture + explicit objection criteria. |
| **Panel aggregation** | `demographics`, `sampling.weight`, `sampling.cohort_tags` | Used as stratification/weighting metadata; not in any LLM prompt | Aggregation across personas needs structured fields for cohort filtering and weighted means. |

---

## 6. Scoring at the four content layers

For every layer, the LLM sees `detailed_profile` (per SSR contract) + the artifact + a layer-specific question + naturalistic first-person anchors written for that semantic family. The bullet-list signals are injected into rubric judges only.

### 6.1 Theme

| Concern | Scoring mechanism |
|---|---|
| Persona-conditioned question | "Would you subscribe to a publication centered on this Theme? On a 1–5 scale, how useful would this Theme be in serving you over the next 18 months?" |
| SSR Likert family | `likelihood` (with `value` as a secondary signal) |
| Anchors live on | `scoring_pipeline.theme.anchors` |
| Rubric criteria (per `THEME_TOPIC_POINTS_DEFINITION.md`) | specificity, durability, POV-clarity, defensible exclusions, audience-fit |
| Aggregation | Mean SSR likelihood across all `active` personas, stratified by `role_to_topic`. Composite gate: rubric average + audience-fit SSR distribution. |

### 6.2 Topic

| Concern | Scoring mechanism |
|---|---|
| Persona-conditioned question | "Would you click and finish a piece with this angle? How likely are you to want to read it on a 1–5 scale?" |
| SSR Likert family | `likelihood` + `appeal` |
| Anchors live on | `scoring_pipeline.topic.anchors` |
| Rubric criteria | position-clarity, specificity, Theme-fit, disputability, persona likelihood-to-click |
| Aggregation | Mean SSR appeal/likelihood per persona; cohort-weighted composite. Gate fails if any single primary persona's likelihood < threshold. |

### 6.3 Outline

| Concern | Scoring mechanism |
|---|---|
| Persona-conditioned question | "After reading this outline, how confident are you that the finished piece will be useful to you?" |
| SSR Likert family | `likelihood` + `value` |
| Anchors live on | `scoring_pipeline.outline.anchors` |
| Rubric criteria | coverage of stated Topic, atomicity of Points (one-claim-per-Point), source diversity, counter-argument acknowledgment |
| Aggregation | Per-Point rubric scores aggregated to Outline-level + SSR confidence distribution. |

### 6.4 Draft

| Concern | Scoring mechanism |
|---|---|
| Persona-conditioned question | "Having read this draft, how valuable did you find it?" |
| SSR Likert family | `value` + `appeal` + `satisfaction` |
| Anchors live on | `scoring_pipeline.draft.anchors` |
| Rubric criteria | autonovel mechanical (`slop_penalty` 0–10) + autonovel judge (voice/specificity/show-not-tell/quotes-of-weakest-sentences) |
| Counter-audience pass | `factory_counter_audience` Skill runs once per primary persona; output is a list of objections quoted to lines |
| Aggregation | Composite of SSR draft-value distribution + autonovel mechanical penalty + autonovel rubric scores. Counter-audience objections do not gate ship but DO surface in the ProposalCard. |

---

## 7. Anchor families and how to write them

Anchors live on the `scoring_pipeline` page, not on the persona — but the persona's `voice_of_customer_quotes` is the seed material.

The SSR/bias papers establish 15 semantic families. The four GameMakers Editorial Room cares most about, in priority order:

1. **`likelihood`** — would the persona open / click / read / subscribe?
2. **`value`** — was it worth their time?
3. **`appeal`** — did the framing/voice/topic attract them?
4. **`satisfaction`** — having read it, are they glad they did?

For each Likert family, anchor sets must be:

- **First-person.** ("I'd…") not third-person ("They are likely to…").
- **Behavioral.** Describe what the person *does* or *feels*, not abstract evaluation. Compare:
  - Bad (formal jargon): *"I am very dissatisfied. The experience was poor."*
  - Good (naturalistic behavioral): *"Terrible. I was frustrated and angry the entire time, nothing worked right and I regret using this."*
- **Distinctive across scale points.** Adjacent anchors (e.g., 2 vs 3) must produce maximally different embeddings. The SSR API enforces this at AnchorSet creation time: sets with mean inter-anchor cosine similarity > 0.85 are rejected with a specific report of which anchor pairs are too similar. Within the acceptable range, the API's `draftAnchorSetFromPersona` helper grades quality (high ≤ 0.78, medium 0.78–0.85). See `SYNTHETICALRESEARCH_API_CHANGES.md` §4.3 (validation rules) and §10.3 (quality grading) for the full rubric.
- **Domain-naturalized.** GameMakers anchors should sound like a working game dev, not a survey respondent. Seed them from the persona panel's `voice_of_customer_quotes` and rewrite for each scale point.

### 7.1 Worked example — `likelihood` anchors for GameMakers Topic scoring

Authored against persona `ankit_indie_dev` voice. Domain: indie game dev publishing.

| Rating | Anchor (first-person, behavioral, naturalistic) |
|---|---|
| 1 | "Closed the tab. Nothing in the headline made me think this was for someone running a small studio." |
| 2 | "Skimmed the first paragraph and bounced. Felt like a take I've already read this week from someone who hasn't shipped recently." |
| 3 | "Read it but didn't forward it. Some of it landed; mostly it was hedged." |
| 4 | "Finished it on the auto ride. Sent the link to my co-founder with a one-line take. Saved one paragraph for the publishing call next week." |
| 5 | "Posted it in our studio Slack. Quoted the contract clause section in our deal-review doc. This is the take I wish I'd read three months ago." |

These five anchors live on `scoring_pipeline.topic.anchors.likelihood` and are scored against the synthetic response Ankit produces when SSR runs the Topic against him.

### 7.2 Anchor authoring rules

1. Author one anchor set per (Likert family, persona-cohort) — i.e., GameMakers indie-cohort `likelihood` anchors are different from GameMakers publisher-cohort `likelihood` anchors.
2. Per the SSR paper: average across 5–6 anchor sets per question for stable estimates.
3. Per the bias paper: do NOT prepend the survey question text to the anchor statement — it homogenizes embeddings and reduces accuracy by 17 pp.
4. Anchors are versioned with the `scoring_pipeline` page — bump pipeline `versioning.schema_version` when anchors change so historical runs remain reproducible.

---

## 8. Methodological guardrails (from the bias paper)

These are non-negotiable for the Editorial Room's distributional metrics to be transferable.

### 8.1 Two-model rule

The model that **generates** the synthetic free-text response and the model that **maps** that response to a Likert distribution must be in **different model families and from different vendors**.

| Pipeline stage | Default model | Why |
|---|---|---|
| Generation | Claude Haiku 4.5 (T=0.7, max 500 tokens) | Per SSR paper Section 3.6; matches validated baseline |
| Embedding (map) | OpenAI `text-embedding-3-small` (1536d) | Cross-vendor independence from Anthropic; matches SSR paper's cross-model validation case |

If you find yourself wanting to use Claude for both — STOP. The 4× variance compression renders distributional comparisons invalid.

### 8.2 No question text in anchors

Per the bias paper Experiment 3: prepending question text to anchor statements degrades accuracy by 17 percentage points (82% → 65% exact match). Anchors must be free-standing.

### 8.3 Asymmetric embedding (when supported)

Anchors as `document` type, responses as `query` type. This widens similarity spread and adds +6 pp accuracy. If using OpenAI `text-embedding-3-small` (which doesn't support asymmetric input_type), accept the 6 pp accuracy cost or switch to Voyage 3.5-lite.

### 8.4 Min-max + softmax

Per validated configuration: min-max normalize cosine similarities to [0, 1], then softmax with τ = 0.15 to convert to probability distribution. Argmax gives point estimate; full distribution gives confidence calibration.

### 8.5 Confidence reporting

Compute normalized Shannon entropy on the output distribution: c = 1 − H(p) / log₂(k). Surface `c` alongside the rating. Per the bias paper: predicted confidence correlates with actual accuracy (~50% accuracy at c < 0.3, ~90% at c > 0.7). Use `c` to gate downstream actions: don't auto-iterate Topics on low-confidence rejections.

### 8.6 Rubric-judge scores are not distributional

Autonovel-style LLM rubric scores can be used for **ranking** and **threshold-gating**, but not as substitutes for SSR distributions. The 4× variance compression applies. Specifically:

- A rubric score's *gap quote* is the actionable signal. The numeric is a flag.
- Composite scores in the `scoring_pipeline.aggregation` config must keep rubric and SSR contributions in separate tracks, not mean them naively.

---

## 9. Worked example — full Ankit persona

```yaml
# /seeds/personas/ankit_indie_dev.yaml
persona:
  page_id: persona.ankit_indie_dev
  display_name: "Ankit Reddy — indie technical co-founder"
  scope: global
  status: active

  demographics:
    age: 33
    gender: "male"
    location_country: "IN"
    location_freeform: "Bangalore, India"
    occupation: "Technical co-founder, 6-person indie studio (Mossroot Games)"
    income_band: comfortable
    role_to_topic: maker

  content_behavior:
    discovery_channels:
      - twitter_quote_tweets_from_indie_devs_he_follows
      - whatsapp_forwards_from_co_founder
      - substack_recco_on_slow_sundays
    consumption_format:
      - substack_post_phone
      - podcast_walks
      - twitter_thread
    typical_session_minutes: 22
    media_diet:
      - "GamesIndustry.biz"
      - "Game Maker's Notebook (Brian Provinciano)"
      - "Jason Schreier (Bloomberg)"
      - "Stephanie Sterling (Jimquisition)"
      - "The Game Production Newsletter (Lawrence)"

  cared_about_criteria:
    - "Concrete operating impact, ideally with numbers from a named studio"
    - "Founder-eye-view perspectives, not analyst-deck framings"
    - "Honest takes on what AI tools actually break in a small-team workflow"
    - "Contract / term shifts in publishing — his next deal lives or dies on these"
    - "Survival economics of teams ≤ 10 people specifically"
    - "Pieces he can finish on a 22-minute auto ride"
    - "Pieces that change what he does on Monday, not next quarter"

  triggers_to_close:
    - "Any piece that opens with 'In recent years…'"
    - "Trade-press neutrality: 'experts disagree on whether…'"
    - "AAA-only framing — if the piece assumes 200-person teams, he leaves"
    - "Words: 'leverage' as a verb, 'unlock,' 'the future of X', 'game-changer'"
    - "More than 3 paragraphs before a concrete fact lands"
    - "Hedging that makes the piece say nothing"
    - "Listicles where the items don't connect"

  voice_of_customer_quotes:
    - "I don't have time for a 4,000-word post about AI. Tell me what to change Monday."
    - "Half the AI takes I read are by people who haven't shipped a game since 2019."
    - "If you don't name a studio, I assume you're guessing."
    - "I read this on the auto ride home — it has to fit there or I won't finish it."

  unmet_needs:
    - "Real before/after on AI-assisted asset pipelines, with hours/$ saved"
    - "What publishers are actually changing in indie deals right now"
    - "How small studios are deciding which AI tools to bet on (or refuse)"
    - "Honest writeups of small studios that died — the math, not the eulogy"

  detailed_profile: |
    You are Ankit Reddy, a 33-year-old technical co-founder of Mossroot Games,
    a 6-person indie studio in Bangalore. You shipped one premium roguelite on
    Steam in 2024 (~38k units) and you are nine months from runway end on your
    second project. You are the engine and tools person; your co-founder runs
    design and business. You work from a co-working space in Indiranagar four
    days a week. You have a 2-year-old at home. You read on your phone during
    the auto ride. You follow ~200 game-dev accounts on Twitter and listen to
    Game Maker's Notebook on walks. A friend at Supermassive forwarded you a
    GameMakers piece six months ago and you've been reading since.

    Financially you can pay your bills without problems and have some money
    left for occasional treats — but the studio's runway is the constraint
    that drives most of your decisions. You're rebuilding your content
    pipeline around gen-AI tools because you can't afford to hand-author
    another 200 biomes. You are talking to two publishers and you read every
    indie-deal-terms thread you see.

    You are tired but generous. You don't have time for theory. You want
    pieces that change what you do on Monday, written by people who have
    shipped recently, with named studios and real numbers in them. You leave
    pieces that hedge or assume teams larger than yours. You forward pieces
    that name a contract clause or a P&L line.

  counter_audience_prompt: |
    You are Ankit Reddy. You have nine months of runway and a 2-year-old at
    home. You read the following draft on the auto ride home. Push back on
    anything that assumes a team larger than yours, anything that hedges
    instead of taking a position, anything that makes a claim about indie
    economics without naming a studio or a number, and anything you couldn't
    act on by next Monday. Be specific. Quote the line you're objecting to.
    You are tired but generous. You assume the author has good intent but you
    don't grade on effort.

  sampling:
    weight: 1.0
    n_samples_default: 8
    temperature_override: null
    cohort_tags:
      - indie
      - small_studio_le_10
      - technical_founder
      - india
      - apac
      - runway_constrained

  meta:
    schema_version: 1
    created_at: 2026-04-30T00:00:00Z
    updated_at: 2026-04-30T00:00:00Z
    derived_from: null
```

---

## 10. What we're not building yet

These were considered and explicitly excluded from initial scope.

| Excluded | Why |
|---|---|
| Domain-specific structured fields (`platforms`, `current_games`, `play_minutes`, etc. as in syntheticalresearch's gaming schema) | Don't generalize across publication domains. Use `cohort_tags` and reference them in `detailed_profile` prose if they matter for the specific domain. |
| Auto-generated `detailed_profile` from structured fields | Loses voice fidelity and creates drift between structured metadata and the only field SSR actually sees. Revisit only if the manual authoring burden becomes a bottleneck. |
| Persona "personality" Big-5 vectors or trait scores | Adds complexity without measurable accuracy benefit per the SSR paper. Personality flavor belongs in the prose, not the schema. |
| Multi-language `detailed_profile` variants | Out of initial scope. If/when needed, add `detailed_profile_<locale>` fields and key the SSR pipeline to locale. |
| "Generated" personas (LLM-built from a brief) | Persona authoring is explicitly manual. Auto-generated personas would likely be shallow on `voice_of_customer_quotes` and `triggers_to_close` — exactly the bullet-list fields that drive scoring accuracy — and the SSR/bias paper findings suggest shallow conditioning hurts correlation attainment. We don't ship a generation Skill for personas. |
| Per-persona favorite anchor sets | Anchors are pipeline-scoped, not persona-scoped. If a persona needs different anchors, that's a signal the cohort needs splitting, not that the persona needs custom anchors. |

---

## 11. References

- Maier, B. F. et al. *LLMs Reproduce Human Purchase Intent via Semantic Similarity Elicitation of Likert Ratings.* arXiv:2510.08338v3, Oct 2025. [SSR paper, primary methodology]
- Pichardo, E. V. *Measuring Self-Rating Bias in LLM-Generated Survey Data: A Semantic Similarity Framework for Independent Scale Mapping.* arXiv:2602.13862v2, Feb 2026. [Bias paper, calibration + circularity findings]
- syntheticalresearch repo: `/Users/josephkim/dev/syntheticalresearch/user-research/packages/ssr-core/src/prompts.ts` and `personas/types.ts`. [Reference SSR implementation]
- autonovel repo: `/Users/josephkim/dev/REFERENCE/autonovel/evaluate.py` and `reader_panel.py`. [Reference rubric-judge + reader-panel implementations]
- `EDITORIAL_ROOM_CONTRACT.md` §3 (persona schema in cross-repo contract).
- `01_ARCHITECTURE.md` §15 (scoring substrate, Scorer interface, pipeline composition).
- `THEME_TOPIC_POINTS_DEFINITION.md` (definitions of artifacts personas score against).
