> **Status:** draft PRD (Forge — what/why). Uses the **shipped** `contents`/`registered_agents` vocabulary, which matches the live DB (DECISIONS D2). Blocked on the Content feature + open questions in §15.
> Precedence + orientation: [README.md](./README.md) · decisions: [DECISIONS.md](./DECISIONS.md) · terms: [GLOSSARY.md](./GLOSSARY.md).

# PRD: Autonomous Content Improvement ("Forge")

> **Status:** Draft for review. Not yet planned into `docs/plans/`.
> **Author:** drafted with Claude, 2026-05-28.
> **Depends on:** the **Content feature** (roadmap #6 — long-form documents 1:1 attached to Talks; PR #385 shipped schema + `src/shared/rich-text/` + accessors + API). This PRD assumes `contents` + the proposal/edit surface exist.
> **External dependency:** the **Synthetical / SSR platform** (`syntheticalresearch.com`) as a scoring oracle, reached over its MCP server / `/api/scoring-jobs` HTTP endpoint. ClawTalk does **not** import SSR code.

---

## 1. Problem statement

ClawTalk users produce long-form content (a Talk's attached document — a concept, brief, chapter, character design, landing-page copy) but have no objective, repeatable way to make it *measurably* better. Today "is this good?" is a vibe call, and improving a draft means manually re-prompting an agent and eyeballing the result. There's no defined target, no record of what was tried, and no evidence that version N+1 is actually better than version N rather than just different.

Joseph has already built the missing measurement layer separately: the SSR (Semantic Similarity Rating) platform rates content against synthetic personas on a Likert scale, calibrated to ~90% correlation with human test-retest reliability. The opportunity is to close the loop — let a ClawTalk agent **autonomously iterate on a document until a scored quality bar is met**, the way Karpathy's `autoresearch` drives `train.py` toward lower `val_bpb` overnight, and the way NousResearch's `autonovel` drives a manuscript toward a higher judge score.

The cost of not solving it: the SSR investment stays a manual, one-off testing tool instead of a generative engine, and ClawTalk's document feature stays a place to *write* content rather than a place to *optimize* it — which is the more defensible product.

---

## 2. Goals

1. **Close the generate→score→improve loop inside ClawTalk.** A user selects a document (or a block within it), defines what "good" means, hits one button, and walks away; the system returns measurably-improved versions with evidence. Success = a run reliably ends with a winning version whose SSR composite score beats the baseline by a meaningful margin on a held-out persona set.
2. **Make "better" explicit and defensible, not vibe-based.** Every version carries a numeric fitness score and the per-persona evidence behind it. Success = for any accepted version, the user can see *why* it scored higher.
3. **Reuse SSR as the oracle; do not rebuild scoring.** The loop calls the existing SSR MCP contract. Success = zero scoring math lives in ClawTalk; the SSR API is the only source of audience-appeal scores.
4. **Keep a human in the loop at acceptance.** The loop runs unattended, but a person chooses the winner from a reviewable version gallery before it touches the canonical document. Success = no autonomous overwrite of a user's document.
5. **Bound cost and time.** Every run has a hard budget (USD) and iteration/wall-clock cap. Success = runs never exceed the configured `budget_usd` or `max_iterations`.

---

## 3. Non-goals

- **Rebuilding or forking the SSR algorithm in ClawTalk.** SSR stays the system of record for scoring; we integrate over its API. (Too much duplication; SSR is actively developed.)
- **Real-world validation (ad tests, store tests, live playtests).** SSR's own docs call persona appeal a *screening* metric, not launch truth. Promoting a winner to real validation is a separate initiative.
- **Auto-applying the winning version to the document.** Deliberately deferred — the proxy metric isn't trustworthy enough to overwrite a user's work unattended (see §10, Goodhart risk).
- **Generating non-text candidates (images, video, playable ads).** SSR supports image assets, but v1 optimizes text only. Multimodal is a v2 consideration.
- **A general-purpose A/B experimentation platform.** This optimizes one document toward one objective; it is not a framework for arbitrary experiments.

---

## 4. User stories

Ordered by priority.

- As a **content owner**, I want to select my document and start an improvement run with a target score and budget, so that I get better drafts without babysitting the agent.
- As a **content owner**, I want to define "good" by picking SSR personas, a reference set, and a survey question, so that the loop optimizes for *my* audience rather than a generic notion of quality.
- As a **content owner**, I want to watch iterations stream in with their scores while the run is going, so that I can tell it's working and cancel if it's going sideways.
- As a **content owner**, I want to review a gallery of scored versions with diffs against my current draft and pick the winner, so that I stay in control of what lands in my document.
- As a **content owner**, I want to improve just a selected block (e.g. the opening hook) rather than the whole doc, so that I can target the weakest part without rewriting everything.
- As a **content owner**, I want the run to stop on its own when it hits my target, plateaus, or burns the budget, so that I don't pay for diminishing returns.
- As a **skeptical reviewer**, I want the winner re-scored against personas the loop never optimized against, so that I can trust the gain is real and not overfit.

---

## 5. The loop

### 5.1 Division of responsibility — the central decision

The most important architectural fact comes from the SSR repo itself: the SSR platform deliberately **stops at being the fitness function.** Its MCP tools (`run_scoring_batch` is described in-code as *"the autoresearch agent's primary surface for scoring a batch of candidates"*) score candidates and return numbers; the *loop* that proposes and mutates candidates is explicitly the client's job, and the candidate schema already ships lineage fields (`parent_candidate_id`, `iteration`, `parent_research_run_id`) flagged as *"Forward-compat for Phase 2 mutation lineage."*

Therefore:

> **ClawTalk owns the loop (propose, mutate, keep/discard, stop). Synthetical owns the score.**

ClawTalk already has every primitive the loop needs (queue, executor, cron scheduler, per-user event hub, agents, content store). We do not need new loop infrastructure — we orchestrate over what exists.

### 5.2 Population-based search, not linear iteration

`autoresearch` and `autonovel` iterate one candidate at a time (commit → reset / keep → revert). That suits a single expensive evaluation per step. But `run_scoring_batch` scores **up to 200 candidates against up to 50 personas in a single batch**, under one `budget_usd` cap. That economics argues for **beam / evolutionary search per round** rather than single-candidate hill-climbing:

1. **Seed.** Baseline = the current document/block. Generate *N* candidate rewrites, each from a different mutation strategy (change the hook, the framing, the tone, the structure, the opening 15 seconds — the mutation menu from the SSR market-test PRD §8.3).
2. **Materialize.** `create_candidate_assets` for all *N* (preserves a client `candidate_id` → `asset_id` map).
3. **Score.** One `run_scoring_batch` over all *N* against the chosen `persona_ids` + `reference_set_ids` + `survey_question`, with `budget_usd`.
4. **Poll.** `get_scoring_batch` on the 30s cadence until terminal; read the `result_envelope` (rankings + per-candidate composite scores).
5. **Select + critique.** Keep top-*k* by fitness as parents. A ClawTalk **critic agent** reads each parent's *qualitative* persona feedback (`RawResponse.llmResponse` / `feedback[][]`) and emits a concrete revision brief — *what to change next*.
6. **Mutate.** The **rewriter agent** produces the next round's *N* candidates from the parents + briefs. Record lineage (`parent_candidate_id`, `iteration`).
7. **Repeat** until a stop condition fires.
8. **Report.** Rank all versions across all rounds; present the gallery.

### 5.3 Why two scorers (fitness vs. direction)

This is the key lesson from `autonovel`: **a score tells you *whether* a version is better; it does not tell the rewriter *how* to improve.** `autonovel` pairs a numeric judge with a rubric that does mandatory gap-finding ("quote the single weakest moment, say how to fix it"). If we feed only SSR's scalar back into the loop, the rewriter mutates blind and plateaus fast.

So the loop runs two scorers with distinct jobs:

| Scorer | Role | Source | Drives |
|---|---|---|---|
| **SSR persona scoring** | **Fitness** — the objective function | Synthetical API (composite impact / weighted blend) | keep/discard, stop condition, the gallery ranking |
| **LLM-judge critic** | **Direction** — actionable revision briefs | a ClawTalk critic agent reading SSR's qualitative persona feedback | what the rewriter changes next round |
| **Deterministic pre-filter** *(optional, P1)* | cheap rejection before paying for SSR | local checks: length, required keywords, AI-slop regex (à la `autonovel`'s tiers) | drops obviously-bad candidates pre-scoring |

### 5.4 Stop conditions

The run ends when **any** fires (mirroring `autonovel`'s thresholds + budget):

- **Target reached:** best composite score ≥ user's target.
- **Max iterations:** configured round cap.
- **Plateau:** best score improves by < ε for 2 consecutive rounds.
- **Budget:** projected SSR spend reaches the `budget_usd` cap (SSR halts a batch at 95% of budget; ClawTalk stops dispatching new rounds).
- **Cancel:** user cancels (propagates to `cancel_scoring_batch`).

---

## 6. Defining "good": objective configuration

A run's objective is the SSR scoring config plus a fitness definition. v1 surfaces:

- **`persona_ids`** (1–50) — the synthetic audience. *This is how the user says who they're optimizing for.*
- **`reference_set_ids`** (1–10) — the Likert anchor statements that calibrate the scale.
- **`survey_question`** — e.g. "How likely are you to keep reading this?" / "How likely are you to download this game?"
- **`scoring_config`** — `selected_model`, `embedding_model`, `samples_per_response`, optional `prompt_template_id`, `pmf_temperature`.
- **Fitness** — v1 default: the SSR **composite impact score** per candidate. (The SSR market-test PRD's weighted `MarketabilityScore` blend is a v2 option once those sub-metrics are exposed per candidate.)

The user picks personas/reference sets from their *existing* Synthetical org assets — ClawTalk lists them via the SSR MCP read tools (`list_personas`, `list_reference_sets` / `list_reference_bundles`). We do not author personas in ClawTalk in v1.

---

## 7. Synthetical integration contract

### 7.1 Connection

Synthetical's MCP server is OAuth-protected and org-scoped. ClawTalk stores, per user (or per workspace), an SSR OAuth token + `organization_id`, in the existing LLM secret store pattern (`src/clawtalk/llm/`). All scoring calls are scoped to that org. Required scopes: `assets:write` (create candidates), `tests:run` (run batches), `tests:read` (poll), plus reads for persona/reference listing.

### 7.2 Call sequence (per round)

```
create_candidate_assets({ candidates: [{ candidate_id, name, content }] })
        → returns candidate_id → asset_id map (partial-failure tolerant)
run_scoring_batch({
        organization_id, idempotency_key,           # idempotent per (org,key) for 24h
        candidates: [{ candidate_id, asset_id, parent_candidate_id?, iteration? }],
        persona_ids, reference_set_ids,
        scoring_config: { selected_model, embedding_model, samples_per_response, survey_question },
        budget_usd
})      → { job_id, status: "pending", next_action }     # async by default
get_scoring_batch({ id: job_id })                          # poll every ~30s
        → terminal: { status: "completed"|"partial", result_envelope }
```

`result_envelope` carries rankings, per-candidate composite scores, and a methodology block (reference bundle/version, persona versions, content hash) for reproducibility. ClawTalk reads composite + per-persona breakdown + qualitative feedback from it.

### 7.3 Idempotency & cost

- `idempotency_key` per (org, round) so a retried dispatch doesn't double-charge.
- `estimate_scoring_batch` before a run to show the user a projected cost range; gate start on their budget.
- A 200-candidate × 5-persona × 5-sample batch runs ~25 min and costs real money — design the loop to **generate many candidates per round** to amortize latency, and keep rounds modest in v1 (e.g. N=8, k=3).

---

## 8. Data model

Build on the existing `contents` table; add two tables.

**`content_improvement_runs`** — one per loop invocation:

| Column | Purpose |
|---|---|
| `id` | run id |
| `content_id` | the document being improved |
| `target_anchor_id` (nullable) | block being improved; null = whole doc |
| `owner_id`, `talk_id` | scoping |
| `objective_json` | persona_ids, reference_set_ids, survey_question, scoring_config, fitness def |
| `target_score`, `max_iterations`, `budget_usd`, `plateau_epsilon` | stop conditions |
| `baseline_score` (nullable) | score of the starting content |
| `status` | `pending`/`running`/`completed`/`plateaued`/`budget_exhausted`/`cancelled`/`failed` |
| `ssr_org_id` | which Synthetical org scored it |
| `best_version_id` (nullable) | current leader |
| timestamps | |

**`content_versions`** — one per candidate ever scored:

| Column | Purpose |
|---|---|
| `id` | version id |
| `run_id` | parent run |
| `iteration` | round number |
| `candidate_id` | stable id round-tripped to SSR |
| `parent_version_id` (nullable) | evolutionary lineage |
| `body_markdown` | the candidate text |
| `mutation_strategy` | which mutation produced it |
| `composite_score` (nullable) | SSR fitness |
| `per_persona_json` | breakdown + qualitative feedback |
| `ssr_job_id` | scoring batch that produced the score |
| `decision` | `keep`/`discard`/`frontier`/`winner` |
| `decision_reason` | critic/loop rationale |

(The schema intentionally mirrors the SSR market-test PRD's variant/score shapes so the two systems' records line up.) Acceptance reuses the existing Content edit/promotion path: materialize the chosen `content_versions.body_markdown` into `contents` via the existing CAS `patchContent` / proposal-accept flow — no new write path.

---

## 9. Reuse map — ClawTalk primitives

Almost nothing is new infrastructure.

| Need | Reuse (exists today) | New |
|---|---|---|
| Generate candidates | `llm-client` / `executeWithAgent`; `registered_agents` (add a **rewriter** + **critic** persona) | rewriter/critic system prompts |
| Score | — | SSR connector (token store + the 3 MCP calls + polling) |
| Run the loop | queue + `CleanTalkExecutor` + `response_group_id`/`sequence_index` for rounds; `scheduler.ts` cron to pace overnight runs & sweep stuck jobs | `run_kind: 'content_improvement'` + an orchestrator that dispatches the next round on completion |
| Store versions | `contents` | `content_improvement_runs`, `content_versions` (+ accessors) |
| Stream progress | `UserEventHub` outbox → WebSocket; generic event types | event types `improvement_round_scored`, `improvement_version_kept`, `improvement_run_finished` |
| Review & accept | `PendingEditDocSurface` accept/reject; CAS `patchContent` | a **version-gallery** view (diff + scores + pick winner) |

---

## 10. Risks

**Goodhart / reward hacking — the headline risk.** Optimizing text to maximize a persona-panel Likert score will, given enough iterations, drift toward gaming *those personas* rather than producing genuinely better content. SSR's own docs explicitly call persona appeal a **screening metric, not launch truth.** Mitigations, built in from v1:

- **Held-out validation personas.** Re-score the winner against a persona set the loop never optimized against; surface that score in the gallery as the trust signal.
- **Saturation watch.** Plateau/saturation is treated as a stop, not a reason to push harder.
- **Pairwise/KS sanity check.** Use SSR's pairwise comparison / KS-distance to confirm distributions are genuinely separating, not just nudging means.
- **Human acceptance gate.** No autonomous overwrite (Goal 4).

**Context loss on block-level edits.** Optimizing a fragment out of context can make it locally appealing but globally incoherent (the `autonovel` "canon" lesson). Mitigation: when improving a block, pass the surrounding document as read-only context to both rewriter and critic; consider scoring the candidate *spliced into the full doc* rather than in isolation.

**Cost/latency surprise.** Batches are minutes-long and metered. Mitigation: mandatory `estimate_scoring_batch` + visible budget + hard `budget_usd` cap + conservative default N/k.

**SSR availability / partial failures.** Scoring is a network dependency that can return `partial` or degrade (image fallbacks, etc.). Mitigation: treat `partial` as usable (score what scored), surface degradations, make rounds resumable via idempotency keys.

---

## 11. UX surface

- **Entry:** "Improve with Synthetical" action on the document pane and on a text selection (block-level).
- **Config modal:** pick personas + reference set + survey question (from the user's SSR org), set target score / max iterations / budget; show the cost estimate before "Start."
- **Live run:** progress panel streaming each round's candidates and scores; cancel button.
- **Version gallery:** all scored versions ranked by fitness, each with a diff against the current draft, composite score, held-out score, and the persona feedback that drove it; "Set as document" promotes the chosen version through the existing accept path.

---

## 12. Requirements

**P0 — must have (the thin vertical slice):**

- [ ] SSR connector: store org token; call `create_candidate_assets`, `run_scoring_batch`, `get_scoring_batch` with polling and error/`partial` handling.
- [ ] `content_improvement_runs` + `content_versions` tables + accessors.
- [ ] Single-round loop: select a block/doc → generate *N* candidates (one rewriter agent) → score against one persona set + reference set → store versions with scores.
- [ ] Version gallery: list scored versions with diffs + scores; pick one → promote via existing Content accept path.
- [ ] Config modal with cost estimate and a hard budget cap.
- [ ] Stop on max-iterations and budget.

**P1 — should have (the real loop):**

- [ ] Multi-round beam search with top-*k* parent selection and lineage.
- [ ] Critic agent producing revision briefs from SSR qualitative feedback.
- [ ] Target-score and plateau stop conditions.
- [ ] Live streaming of rounds via the event hub.
- [ ] Held-out validation persona re-scoring of the winner.
- [ ] Overnight pacing via the cron scheduler (one round per tick) + stuck-run sweep.

**P2 — future considerations (design for, don't build):**

- [ ] Deterministic pre-filter scorer.
- [ ] Weighted multi-metric fitness (SSR `MarketabilityScore` blend) once sub-metrics are exposed per candidate.
- [ ] Multimodal candidates (image/video).
- [ ] Promote winner to real-world validation (ad/store/playtest handoff).
- [ ] Authoring/versioning personas from inside ClawTalk.

---

## 13. Phased build plan

- **Phase 0 — Access verification.** Confirm SSR OAuth flow + scopes from ClawTalk's environment; list personas/reference sets for the org; run one `estimate_scoring_batch` round-trip end to end.
- **Phase 1 — Thin vertical slice (P0).** The simplest end-to-end: one block → 3 candidates → one scored batch → gallery → accept. Proves auth, connector, tables, and the accept path on one spine.
- **Phase 2 — The loop (P1).** Beam search, critic-driven mutation, lineage, target/plateau stops, live streaming.
- **Phase 3 — Trust & overnight (P1).** Held-out validation scoring, cron pacing, budget polish, cancel/resume.
- **Phase 4 — Richer fitness & multimodal (P2).** Weighted blend, pre-filters, image candidates.

---

## 14. Success metrics

**Leading:**

- *Score lift:* median (winner composite − baseline composite) per completed run. Target: a meaningful positive lift on the held-out persona set (set concrete threshold after Phase 1 baseline data).
- *Activation:* % of started runs that reach a gallery with ≥1 version scored above baseline.
- *Acceptance:* % of completed runs where the user promotes a version.
- *Budget adherence:* % of runs that finish at or under configured budget (target 100%).

**Lagging:**

- *Overfit gap:* mean (optimized-persona score − held-out score) for winners; rising gap signals Goodhart drift to watch.
- *Repeat use:* % of users who run improvement more than once.

---

## 15. Open questions

- **(Joseph / product)** Default objective for v1 — concept-appeal style (personas + survey question only), matching the SSR PRD's recommended starting point "A"? *Blocking for the config modal defaults.*
- **(Joseph / SSR)** Is the per-candidate **composite impact score** the right single fitness number for v1, or should ClawTalk compute its own blend? *Blocking for the fitness definition.*
- **(eng)** Per-user vs. per-workspace SSR org binding and token storage location. *Blocking for the connector.*
- **(eng)** Block-level scoring: score the fragment in isolation, or spliced into the full document? *Non-blocking; affects quality, can settle in Phase 2.*
- **(eng)** Loop orchestration: self-dispatch next round on completion (queue) vs. cron-paced (scheduler)? Cron is more "overnight," queue is faster. *Non-blocking; can support both.*
- **(product)** Should an improvement run also post a summary into the Talk thread (ties into the open Jobs re-architecture, roadmap #7)? *Non-blocking.*
