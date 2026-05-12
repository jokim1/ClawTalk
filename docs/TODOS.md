# TODOs — deferred items

**Owner:** Joseph
**Last updated:** 2026-05-02

This file collects items that have been considered and *deliberately deferred* until shipped product experience tells us whether they're worth doing. Each item names what it is, why it was deferred, and what signal would re-prioritize it.

This is not a wishlist or backlog of features that just haven't been picked up. Items here have been thought about and explicitly held — usually because the marginal value before real-world usage is low, and the cost of deciding wrong is real.

---

## Panel Talk — knowledge-creation framing

These are the items considered after studying Nonaka's SECI model and dialectical synthesis (see `02_HERO_APPLICATIONS.md` §2.7.5 for the work we *did* commit to). The dialectical synthesis Skill (`factory_panel_dialectic`) and the spiral-forward path (Promote-to-Editorial) are in scope for Phase 1B-PT. The items below are the framework-adjacent ideas we judged not worth investing in pre-shipping.

### TD-PT-1 — Externalizations as renamed first-class artifact

**What.** Rename the existing "Talking Points" tracker to "Externalizations" (or "Articulations") and reframe each entry as the durable knowledge artifact that captures *what got articulated through the dialogue* — distinct from the messages, which are the dialogue itself. Each entry would have:
- The tacit thing the user came in with (one sentence, user-authored at point of capture).
- What the dialogue forced into language (the actual articulated form).
- What surprised the user — what the panel made them realize they thought.
- Status: `holding` / `still-tacit` / `articulated` / `superseded`.

**Why deferred.** Mostly UX/copy work, low marginal value before we have real usage data. The current Talking Points feature is functionally correct; the rename and reframing improve positioning but don't unlock new product behavior.

**Signal to re-prioritize.** When users start treating Talking Points as the durable output of panel sessions (rather than as conversation summaries), revisit the rename to make the artifact framing explicit. If users *don't* treat them that way, the rename is solving the wrong problem and we should consider whether the artifact itself is right.

### TD-PT-2 — "Ba" framing for context modes

**What.** Rename or augment the in-app explanation of context modes (`persistent` / `editorial` / `incognito` / `momentary`) using Nonaka's "ba" (場) — shared context as a precondition for knowledge creation. Mapping:

- *Persistent (Dialoguing ba)* — for working through ideas you want to come back to.
- *Editorial (Systemizing ba)* — for combining articulated thoughts into shippable work.
- *Momentary (No ba)* — for quick consults you don't want to remember.
- *Incognito (Anti-ba)* — for explicit signaling that no shared context should accumulate.

**Why deferred.** Pure copy/positioning change. Doesn't touch any code. Useful conceptual hook for users who like frameworks; potentially confusing for users who don't. We don't know which group dominates yet.

**Signal to re-prioritize.** Once we have user research showing how people choose between context modes today and where confusion exists. If the modes feel like privacy switches and users pick wrong, "ba" framing might help. If users pick correctly already, the framing is overhead.

### TD-PT-3 — Phronesis as a quality metric for synthesizer outputs

**What.** Use Nonaka's framing of *phronesis* (practical wisdom) as the quality bar for `factory_panel_dialectic` outputs and for the existing `Synthesize` action. Synthesis quality wouldn't just be coherence — it would be whether the output *advances practical decision-making* (does the user know what to do next) and shows awareness of context (this advice for *this* situation, not a generic principle).

**Why deferred.** The concept is real but doesn't operationalize cleanly. "Did this advance practical decision-making" is hard to measure without adoption-rate data, and adoption rate is a noisy signal that won't be available until enough syntheses ship to grade. We'd be guessing what to optimize.

**Signal to re-prioritize.** Once we have ≥ 100 saved DialecticResults across real Panel Talk sessions and can grade them retroactively against "did the user act on this within 30 days," we have enough signal to define a phronesis-adjacent metric. Until then, the rubric judge's existing criteria are sufficient.

---

## Editorial Room — UX deferred

### TD-ED-1 — Inline ghost-text autocomplete in Draft editor

**What.** As the user types in the Draft prose editor (screen 04), an LLM streams a faded-grey suggested continuation inline (Cursor / Copilot / Gmail Smart Compose pattern). `Tab` accepts; keep typing to dismiss. Would coexist with the existing manual `→ CONTINUE ⌘\` button.

**Why deferred.** Three real costs that don't pencil out at v0P:

1. **Cost.** Ghost text fires on every typing pause (~500ms idle). Even with a small model, that's hundreds of inference calls per draft from ambient autocomplete alone.
2. **It pollutes the optimization signal.** If half the prose was suggested by ghost text, what is `+ OPTIMIZE` actually optimizing — the user's intent or the autocomplete model's prior?
3. **It conflicts with the panel-driven editorial model.** The whole D3++ design says editing is a deliberate act and the panel critiques what you wrote. Ghost text inserts an opinionated co-author that isn't on the panel and isn't accountable to the rubric.

The manual `→ CONTINUE ⌘\` button gives the speed-up when wanted without the cost or signal pollution. Also: pulling ghost text OUT later is harder than adding it later — once users get used to it, removing feels like a regression.

**Signal to re-prioritize.** After dogfooding v0P, if Joseph (or other early users) repeatedly find themselves wanting ambient autocomplete badly enough to accept the cost and signal-pollution tradeoffs. Specifically: (a) consistent unprompted requests for it across multiple drafting sessions, (b) evidence that `→ CONTINUE` is being used heavily enough that the manual-trigger friction matters, and (c) a clear answer to "how do we keep ghost text from polluting the Optimize signal?" — likely some form of provenance tracking on prose runs.

---

## Other deferred items

(This file is a living index. Add deferred items here as they come up across other workstreams. Keep entries focused: what, why deferred, signal to re-prioritize. Don't let it become a wishlist.)

### TD-OPT-1 — Persona-panel optimization

**What.** When the optimization loop observes systematic under-fit against a specific persona over multiple rounds, suggest changes to that persona's `triggers_to_close` / `cared_about_criteria` / `voice_of_customer_quotes` fields.

**Why deferred.** Requires enough optimization-round history to detect under-fit reliably (≥ 50 rounds against a given persona). Pre-implementation is too early.

**Signal to re-prioritize.** First user reports of "my Topics never land with persona X" after Phase 1A is dogfooded.

### TD-OPT-2 — Cross-publication learning

**What.** Use rejection patterns from one publication to calibrate optimization gates on another (for users running multiple publications).

**Why deferred.** Single-user, single-publication first. Cross-publication is a meaningful added complexity for a use case we haven't validated.

**Signal to re-prioritize.** When a user explicitly runs a second publication using the same substrate.

### TD-OPT-3 — Score calibration against actual publish outcomes

**What.** Once shipped Pieces accumulate engagement data (Substack opens, replies, forwards, share counts), calibrate SSR-predicted scores against real reception. Find which Likert families and which personas correlate with actual outcomes; adjust gate thresholds and scorer weights accordingly.

**Why deferred.** Need shipped pieces with engagement data first.

**Signal to re-prioritize.** ~12 published pieces with at least 4 weeks of engagement data each. Then run the calibration analysis.

### TD-OPT-4 — Hybrid SSR (anchor-based + lightweight learned mapping)

**What.** Per the SSR paper §5: combine SSR's anchor-based mapping with a small learned classifier that's trained on actual user feedback (was the score right? wrong?). Could improve accuracy without sacrificing methodological independence.

**Why deferred.** Requires labeled training data (hundreds of user feedback signals on score correctness). We don't have that yet, and gathering it is a separate workstream.

**Signal to re-prioritize.** When we have a substantial corpus of (predicted_pmf, actual_user_feedback) pairs from real usage.

---

## Cloud architecture — deferred from cloud port

Items captured during the `/plan-eng-review` of `docs/CLOUD_TARGET.md` on 2026-05-02. Each represents a decision held until shipped product experience tells us whether to commit.

### TD-CLOUD-1 — Heavy optimization Skills decision

**What.** Decide whether to build the heavy multi-iteration optimization Skills (`factory_topic_optimize`, `factory_point_optimize`, `factory_outline_optimize`, `factory_draft_polish_optimize`, `factory_draft_fullsearch_optimize`, `factory_theme_propose_optimize`) after v1 ships and you've used the cheap Skills (`factory_topic_propose`, `factory_opus_review`, `factory_adv_cut`, etc.) for ~30 days.

**Why deferred.** The kickoff doc's product pitch — "the interesting product is the search, not the scoring" (`OPTIMIZATION_LOOP.md` §1) — depends on heavy optimization. But heavy Skills need long-running compute that Workers can't host within timeouts (~480 LLM calls per round, 16-40 min wall time). Building them means committing to Cloudflare Durable Objects (newer Cloudflare-native primitive) or a sidecar service. Cheap Skills run in Workers and may be sufficient for daily editorial work. Deferred to learn which is true.

**Signal to re-prioritize.** After 30 days of dogfooding cheap Skills post Phase E1 ship: if you find yourself manually requesting "give me 3 more topic options" or "redo this with different angle" repeatedly, the agentic-search pattern is wanted and heavy optimization earns its keep. If cheap single-call proposals satisfy the workflow, drop heavy optimization permanently.

### TD-CLOUD-2 — rocketorchestra extraction trigger

**What.** Extract the page library (themes, topics, points, voice, persona, scorer configs, claims_ledger) out of editorialboard's Postgres into a thin shared service, if a real second consumer emerges.

**Why deferred.** Killed rocketorchestra during `/plan-eng-review` of `docs/CLOUD_TARGET.md` because there is currently zero production code using it and no committed second app to share context with. The kickoff doc envisioned multiple apps (Editorial Room + Panel Talk + …) sharing rocketorchestra as substrate, but Panel Talk isn't being built and the second-app justification is hypothetical. Page library lives inline in editorialboard's Postgres until a real second consumer materializes.

**Note (Codex outside-voice 2026-05-02):** embedding the page library directly in editorialboard's Postgres re-creates the same extraction problem we just solved with rocketorchestra. The right tradeoff today (no second consumer = no premature substrate), but explicitly acknowledged that it'll need re-solving if a second app emerges. The extraction is bounded — page library is ~7 tables and read-mostly — so a future extraction is a 1-day refactor, not a re-architecting.

**Signal to re-prioritize.** A second app commits to building (Panel Talk, a public Skills marketplace, a third-party MCP integration) and needs to read the same `voice/persona/theme/topic/point` content as editorialboard. Until then, premature extraction is the wrong tradeoff.

### TD-CLOUD-3 — Phase F production hardening

**What.** Production hardening items deferred from the initial cloud port to Phase F:
- Stripe integration + paywall + subscription billing
- Cloudflare Logpush to R2 for observability + log retention
- Sentry-style error tracking for opaque mid-stream LLM failures
- Rate limiting (Cloudflare WAF rules + per-user rate limits in Worker)
- Email vendor branding for Supabase Auth flows (custom templates, sending domain)
- Backup restore drill (verify `wrangler d1 export` / Supabase PITR works in a scratch project)
- Load test for Worker SSE concurrency budget under realistic editorial usage

**Why deferred.** Each is needed before commercializing as a SaaS subscription product, but none blocks dogfooding deploy in Phase E0/E1. Tracked here so they don't slip indefinitely between v1 launch and the first paying customer.

**Signal to re-prioritize.** Item-by-item:
- Stripe: when you have a user willing to pay
- Logpush + Sentry: when you've shipped to ≥1 external user and want failure visibility
- Rate limiting: before public launch (Phase E1)
- Email branding: before public launch (Phase E1)
- Backup drill: before any production data exists (Phase C, per A1.3 decision)
- Load test: before public launch (Phase E1)

Break into sub-TODOs as each becomes ready to work.

---

## Process

When you find yourself wanting to add a feature mid-conversation:
1. If it's clearly worth doing now, add it to the relevant doc.
2. If it's clearly never worth doing, drop it.
3. If you're not sure but suspect it's premature, add it here with the *signal that would change your mind*. The signal is what makes this useful — without it, the entry is just noise.

Items with no signal-to-re-prioritize line should be removed in the next review pass — they're either obvious yes or obvious no.

*End of TODOs.*
