> **Status:** draft PRD (Forge — what/why). Uses the canonical greenfield vocabulary (`documents`/`agents`/`document_edits`/`improvement_runs`/`document_versions`) per §11 §9. Open questions in §15.
> Precedence + orientation: [README.md](./README.md) · decisions: [DECISIONS.md](./DECISIONS.md) · terms: [GLOSSARY.md](./GLOSSARY.md).

# PRD: Autonomous Content Improvement ("Forge")

> **Status:** Draft for review. Not yet planned into `docs/plans/`.
> **Author:** drafted with Claude, 2026-05-28.
> **Depends on:** the **Document feature** — long-form documents 1:1 attached to Talks (`documents` + tabs + blocks + `document_edits`, §11 §5).
> **External dependency:** the **Synthetical / SSR platform** (`syntheticalresearch.com`) as a scoring oracle, reached over its MCP server / `/api/scoring-jobs` HTTP endpoint. ClawTalk does **not** import SSR code.

---

## 1. Problem statement

ClawTalk users produce long-form content (a Talk's attached document — a concept, brief, chapter, character design, landing-page copy) but have no objective, repeatable way to make it *measurably* better. Today "is this good?" is a vibe call, and improving a draft means manually re-prompting an agent and eyeballing the result. There's no defined target, no record of what was tried, and no evidence that version N+1 is actually better than version N rather than just different.

Joseph has already built the missing measurement layer separately: the SSR (Semantic Similarity Rating) platform rates content against synthetic personas on a Likert scale, calibrated to ~90% correlation with human test-retest reliability. The opportunity is to close the loop — let a ClawTalk agent **autonomously iterate on a document until a scored quality bar is met**, the way Karpathy's `autoresearch` drives `train.py` toward lower `val_bpb` overnight, and the way NousResearch's `autonovel` drives a manuscript toward a higher judge score.

The cost of not solving it: the SSR investment stays a manual, one-off testing tool instead of a generative engine, and ClawTalk's document feature stays a place to *write* documents rather than a place to *optimize* them — which is the more defensible product.

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

ClawTalk already has every primitive the loop needs (queue, executor, cron scheduler, per-user event hub, agents, documents store). We do not need new loop infrastructure — we orchestrate over what exists.

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

Synthetical's MCP server is OAuth-protected and org-scoped. ClawTalk stores, **per workspace** (DECISIONS D7; one `ssr_connections` row per workspace, §11 §9), an SSR OAuth token + `organization_id`. The token is stored in `connector_secrets` per §11 §6/§9 — the same encrypt-at-rest + JIT-decrypt pattern as Slack/Drive/Gmail/Linear/GitHub. **NOT** `workspace_provider_secrets` (which is LLM keys per D7). All scoring calls are scoped to the connection's org. Required scopes: `assets:write` (create candidates), `tests:run` (run batches), `tests:read` (poll), plus reads for persona/reference listing.

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

Forge schema is owned by §11 §9. Read that for the canonical tables: `improvement_runs`, `document_versions`, `forge_audiences`, `forge_audience_personas`, `improvement_run_held_out_personas`, `ssr_connections`, `forge_personas`, `forge_reference_sets`, `forge_questions`. Scope is `(document_id, tab_id, target_block_id)` on `improvement_runs` (whole-doc = both null; tab-scoped = `tab_id` only; block-scoped = both). Acceptance lands the chosen `document_versions` body as a `document_edits` row with `source='forge'` going through the standard accept path — no separate write path (§11 §5).

---

## 9. Reuse map — ClawTalk primitives

Almost nothing is new infrastructure.

| Need | Reuse (exists today) | New |
|---|---|---|
| Generate candidates | `llm-client` / `executeWithAgent`; `agents` (a **rewriter** + **critic** marked `is_system=true` per §11 §4 D3) | rewriter/critic system prompts (role templates per §06) |
| Score | — | SSR connector (`connector_secrets` token store + the 3 MCP calls + polling) |
| Run the loop | queue + executor + `response_group_id`/`sequence_index` for rounds; `scheduler.ts` cron to pace overnight runs & sweep stuck jobs | `run_kind='content_improvement'` (already in §11 §3 `runs.run_kind` CHECK) + an orchestrator that dispatches the next round on completion |
| Store versions | `documents` | `improvement_runs`, `document_versions` (+ accessors) — §11 §9 |
| Stream progress | `UserEventHub` outbox → WebSocket; generic event types | event types `improvement_round_scored`, `improvement_version_kept`, `improvement_run_finished` |
| Review & accept | `document_edits` accept/reject path (§11 §5) | a **version-gallery** view (diff + scores + pick winner) |

### 9.1 Audience asset sync source

`forge_audiences` is composed in-app, but the personas / reference sets / survey questions it references are **synced read-only** from Synthetical (`forge_personas`, `forge_reference_sets`, `forge_questions` — each carries `ssr_id` + `synced_at`). The sync source is the SSR MCP read tools listed in §7.1 (`list_personas`, `list_reference_sets` / `list_reference_bundles`, `list_questions`). A workspace admin triggers a refresh from the Forge **Audiences** page (§10 sub-nav); cadence is **on-demand, manual re-sync** — no background poller in v1. Each successful sync upserts by `(workspace_id, ssr_id)` and bumps `synced_at`.

### 9.2 Held-out validation

The loop's headline risk is Goodhart drift against the in-pool personas (§10). The mitigation is a held-out persona split that is **fixed at run-start, scored every iteration, and used as the overfit stop signal.** Tables: `document_versions.held_out_score numeric` + the `improvement_run_held_out_personas` join table (§11 §9).

- **Seeding (run-start, Phase 1 of §13).** When the executor materializes the run, it selects **~20%** of the audience's personas at random and writes them into `improvement_run_held_out_personas`. They are **excluded** from every per-iteration `run_scoring_batch` call. The split is reproducible: `improvement_run_held_out_personas` is the seed; **no re-randomization mid-run** (a resumed or restarted-from-cancel run reads the existing rows).
- **Per-iteration scoring.** After each `document_versions` row is scored against the in-pool personas and its `composite_score` lands, the executor issues a **second** `run_scoring_batch` against the held-out persona set and stores the average in `document_versions.held_out_score`.
- **Trust signal.** When `composite_score` (in-pool) tracks `held_out_score` (out-of-pool) within **±0.3**, the iteration is generalizing — keep going. When in-pool keeps climbing but `held_out_score` flatlines or drops across two consecutive rounds, Forge has overfit: `improvement_runs.stop_reason = 'overfit_held_out_divergence'` fires and the run terminates (parallel to the plateau stop in §5.4).
- **Surface.** The gallery (§11) shows both numbers per version so the user can see the in-pool vs. held-out gap before promoting.

Cross-ref §11 §9 for column/constraint definitions.

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

- [ ] SSR connector: store org token in `connector_secrets` (§11 §6); call `create_candidate_assets`, `run_scoring_batch`, `get_scoring_batch` with polling and error/`partial` handling.
- [ ] `improvement_runs` + `document_versions` tables + accessors (§11 §9).
- [ ] Single-round loop: select a block/doc → generate *N* candidates (one rewriter agent) → score against one persona set + reference set → store versions with scores.
- [ ] Version gallery: list scored versions with diffs + scores; pick one → promote by inserting a `document_edits` row with `source='forge'` (§11 §5) for human accept.
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

Each phase annotated with the §11 §9 tables it touches.

- **Phase 0 — Access verification.** Confirm SSR OAuth flow + scopes from ClawTalk's environment; list personas/reference sets for the org; run one `estimate_scoring_batch` round-trip end to end. Schema touch: `ssr_connections` row INSERT (one per workspace per D7) + initial sync upserts into `forge_personas` / `forge_reference_sets` / `forge_questions` (by `(workspace_id, ssr_id)`). No `improvement_runs` row yet.
- **Phase 1 — Thin vertical slice (P0) — baseline.** The simplest end-to-end: one block → 3 candidates → one scored batch → gallery → accept. Proves auth, connector, tables, and the accept path on one spine. Schema touch: **`improvement_runs`** row INSERT (`status='pending'` → `'running'`); held-out split written to `improvement_run_held_out_personas` (~20% of the audience, per §9.2); baseline **`document_versions`** row INSERT (`iteration=0`, `candidate_id='baseline'`, `parent_version_id=NULL`); `improvement_runs.baseline_score` populated once the baseline is scored.
- **Phase 2 — The loop (P1) — beam search.** Beam search, critic-driven mutation, lineage, target/plateau stops, live streaming. Schema touch: per-round `document_versions` rows per candidate (`iteration=N`, `parent_version_id` linking back to the kept parent, `mutation_strategy`, `per_persona_json`); `ssr_job_id` populated from `run_scoring_batch` so polling can resume.
- **Phase 3 — Trust & overnight (P1) — held-out + cron.** Held-out validation scoring, cron pacing, budget polish, cancel/resume. Schema touch: `document_versions.held_out_score` written every iteration alongside `composite_score` (per §9.2); `improvement_runs.baseline_score` re-read for divergence checks; `improvement_runs.stop_reason = 'overfit_held_out_divergence'` when the in-pool vs. out-of-pool gap blows the ±0.3 band for 2 consecutive rounds.
- **Phase 4 — Promotion (P1) — gallery accept.** Promote the winner through the existing accept path. Schema touch: `improvement_runs.best_version_id` set (deferred FK to `document_versions`); `improvement_runs.status='completed'` + `stop_reason` (one of `target_reached` / `max_iterations` / `plateau` / `budget` / `overfit_held_out_divergence`); a `document_edits` row inserted with `source='forge'` and `proposed_by_run_id=improvement_run_id` so the standard human accept path lands the chosen version into `documents` (§11 §5).
- **Phase 5 — Cancel / cleanup.** User-initiated cancel and partial-failure teardown. Schema touch: `improvement_runs.status='cancelled'` + `stop_reason` (typically `user_cancel`); `cancel_scoring_batch` propagated to SSR; `document_versions` rows preserved (gallery still browsable; user can promote a non-terminal version).
- **Phase 6 — Richer fitness & multimodal (P2).** Weighted blend, pre-filters, image candidates. (No new §11 §9 tables in v1; `document_versions.fitness_json` extension TBD.)

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

- **(Joseph / product) RESOLVED 2026-05-30.** Default objective is the **workspace default audience**. `forge_audiences.is_default boolean` (§11 §9) marks at most one audience per workspace as the default (partial unique index enforces 0-or-1). "Improve this doc" projects `improvement_runs.objective_json` from that audience (persona_ids + reference_set_id + question_id). In a workspace with no audiences, the action redirects to the Audiences page to create one before proceeding. The config modal also offers a "copy from recent run" helper for ad-hoc overrides.
- **(Joseph / SSR) RESOLVED 2026-05-30.** Use the SSR-returned `composite_score` as the single fitness number for v1; no ClawTalk-side blend. The §10 trust panel exposes `per_persona_json` for diagnostic detail and `held_out_score` (§11 §9 `document_versions`) for overfit detection. Schema is already wired (`document_versions.composite_score numeric`). Revisit only if a real composite-misranking case surfaces post-launch — then a ClawTalk-side weighted blend can be added without schema changes via a `scoring_config` field already present on `improvement_runs.objective_json`.
- **(eng) RESOLVED.** SSR org binding is **per workspace** (one `ssr_connections` row per workspace, §11 §9) and the token lives in `connector_secrets` (D7 + §11 §6). No per-user binding.
- **(eng)** Block-level scoring: score the fragment in isolation, or spliced into the full document? *Non-blocking; affects quality, can settle in Phase 2.*
- **(eng)** Loop orchestration: self-dispatch next round on completion (queue) vs. cron-paced (scheduler)? Cron is more "overnight," queue is faster. *Non-blocking; can support both.*
- **(product)** Should an improvement run also post a summary into the Talk thread (ties into the open Jobs re-architecture, roadmap #7)? *Non-blocking.*
