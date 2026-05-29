> ⛔ **ARCHIVED — not current.** Code-accurate critique of the rebuild plan. Its conclusions (keep Workers; latency hotspots; agent-eval gate) are promoted into DECISIONS.md + ../engineering-notes.md.
>
> Retired 2026-05-28 during the docs restructure. See [../DOC-AUDIT.md](../DOC-AUDIT.md) and [../README.md](../README.md). Kept for historical reference only.

# ClawTalk V2 Rebuild Plan — Review and Restructure

Status: review draft
Date: 2026-05-28
Author: review pass against `docs/CLAWTALK_V2_REBUILD_PLAN.md` and the current `src/` + `webapp/`.

## TL;DR

The rebuild plan is a strong product/design spec but a weak engineering plan. Three problems dominate:

1. **It misdiagnoses where the latency comes from.** The plan reads as if minutes of latency are caused by users waiting in a queue behind background work. The current code already has a single-agent in-process bypass (`src/clawtalk/talks/dispatch-in-process.ts`), the executor already streams deltas, and cron is not in the interactive path. The real latency hotspots are (a) ordered-mode sibling serialization via 10-second `BlockedBySiblingError` retries, (b) tool-call loops that tear down and reopen the provider HTTP connection on every iteration up to 10 times, and (c) per-request postgres client construction with `fetch_types: true`. Rewriting the queue layer will not move TTFT. Fixing those three will.
2. **It throws out the Cloudflare Workers + Durable Object architecture without justifying it.** The plan recommends Next.js App Router + Node + Redis + WebSocket as the "stack matches the handoff package" choice. The current stack is Cloudflare Workers + Hono + Hyperdrive + a per-user Durable Object event hub with WebSocket Hibernation. The DO already does what the plan wants Redis to do, with lower latency and no separate process to manage. Switching is a regression dressed as modernization. The Salon design system is stack-agnostic and can be implemented in the existing Vite/React webapp.
3. **It treats the rebuild as greenfield, but the actual cost is concentrated in the 10,702-line `webapp/src/pages/TalkDetailPage.tsx`.** Frontend tech debt is real and worth tearing down. The backend is mostly fine. Calling the whole rebuild "aggressive greenfield" conflates a UI rewrite with a platform migration and makes the project bigger than it needs to be.

The remainder of this document is the evidence, the gaps, and a restructured phase plan that lands the same product faster and with less risk.

## 1. Latency: what is actually slow

The plan's Section 7 sets a sub-600ms TTFT target and a budget table, which is correct ambition. But its "send message path" reads as if the current product fails because user messages sit in a background queue behind unrelated work. That is not what the code does.

What the code actually does:

- `POST /api/v1/talks/:talkId/chat` writes the user message and N `talk_runs` in one Postgres transaction and returns 202 (`src/clawtalk/web/worker-app.ts:2297`, `src/clawtalk/web/routes/talks.ts:1845`).
- For **single-agent** turns, the route calls `dispatchRunInProcess` via `ctx.waitUntil` (`src/clawtalk/web/worker-app.ts:2337`). The queue is skipped entirely. This was the T7 mitigation from 2026-05-27.
- For **multi-agent** turns, the route sends one `TALK_RUN_QUEUE.send({ runId })` per run. `wrangler.toml:107-111` documents the observed cost: "~5s between POST /chat and queue consumer firing." That's seconds, not minutes.
- Cron (`* * * * *`) runs `processClaimableJobs` plus a `sweepStuckRunningRuns` that flips rows already `running` for over an hour (`src/clawtalk/talks/scheduler.ts:42, 59-67`). Interactive chat does not touch cron.
- The executor streams deltas through `streamLlmResponse` (`src/clawtalk/agents/llm-client.ts:1207`), each `text_delta` is mapped to `talk_response_delta` (`src/clawtalk/talks/new-executor.ts:240`), sanitized, written to `event_outbox`, and flushed to the per-user Durable Object via a 50ms coalescer (`src/clawtalk/talks/streaming-notify.ts:52`). The browser subscribes over WebSocket (`webapp/src/pages/TalkDetailPage.tsx:4455` → `webapp/src/lib/talkStream.ts:295`).

That path is not minutes. So where are the minutes coming from?

**Hotspot A — Ordered-mode sibling waits.** In ordered mode, all sibling runs get queued, but the consumer rejects any run whose lower-`sequence_index` siblings are unfinished by throwing `BlockedBySiblingError`. The worker handler retries with `delaySeconds: 10` (`src/worker.ts:271-272, 289`). With three ordered agents and 30s LLM latency each, the user pays roughly 30s + 10s + 30s + 10s + 30s ≈ 110s in observed clock time, where ~20s is pure retry-delay overhead. This is a real, fixable problem and the plan does not name it.

**Hotspot B — Tool-call loops.** `src/clawtalk/agents/agent-router.ts:448-695` runs `for (let iteration = 0; iteration < maxToolIterations; iteration++)` with `maxToolIterations = 10` (`agent-router.ts:444`). Each iteration opens a fresh `streamLlmResponse` HTTP request to the provider. Streaming output stays continuous to the browser, but every tool round-trip is a brand-new model TTFT. A pathological 10-iteration chain on a slow provider can easily run multiple minutes. This is the most plausible explanation for the "5+ minute" reports. The plan does not mention parallel tool calls, prompt caching, or speculative continuation — all of which exist in the major providers' 2026 APIs and would cut tool-loop latency 2–4x.

**Hotspot C — Per-request DB setup.** `withRequestScopedDb` constructs a fresh postgres.js client with `max: 1, fetch_types: true` per request (`src/db.ts:333-342`). `fetch_types: true` issues a `pg_catalog` query to fetch type OIDs on first use. Hyperdrive pools the TCP connection but each request still does this. On a chat endpoint that already serializes work in a transaction, this is measurable but not catastrophic; on the executor's hot path it adds up.

**Hotspot D — Provider TTFT and model choice.** Strategist defaults to `claude-opus-4.5`, Critic and Quant to `gpt-5-pro`, Researcher to `gemini-2.5-pro`. These are the slowest, most expensive models in each provider's lineup. None of the 2026-current fast paths (Claude Haiku 4.5, Gemini 2.5 Flash, GPT-5 Mini for non-critical roles) are wired in as default fast-path options. The agent definition is "one model per agent" rather than "two models per agent — interactive draft and full thinking." The plan's Section 10.6 acknowledges model-per-role but doesn't acknowledge model-per-turn.

### What the plan should say instead

Replace Section 7's framing. The interactive path is already fine. The latency work that needs doing is:

1. **Kill the 10s ordered-mode retry.** Replace `BlockedBySiblingError` + queue retry with Postgres `LISTEN/NOTIFY` (or a DO-fronted unlock signal). When run sequence_index `i` commits, immediately signal the worker holding `i+1`. Target: < 100ms unlock latency. Net savings: ~10s per sibling in ordered mode.
2. **Reshape the tool loop.** Parallel tool calls where the provider supports them (Anthropic and OpenAI both do as of 2026); cap iteration count at 5 for interactive turns and surface "agent escalated to deep think" as a visible state if more; enable Anthropic prompt caching on the full system prompt + context (cuts TTFT on the second and later iterations meaningfully); reuse the HTTP keep-alive connection across iterations where the provider client supports it.
3. **Add a fast-path model tier per agent.** Allow each agent to declare `interactiveModel` and `deepModel`. Use interactive by default for first response; let the agent escalate to deep when it self-identifies a hard problem. This is the single highest-leverage model latency win available and the plan does not propose it.
4. **Pre-warm the postgres client.** Either drop `fetch_types: true` (the codebase is small enough that hand-mapped types are tolerable) or keep a per-isolate cached type catalog. Removing the OID round-trip alone saves 30–80ms per request.
5. **Measure provider TTFT separately from app latency.** The plan's Section 7 table conflates the two. Instrument `llm_attempts.ttft` and surface it in a dashboard. Tell the user honestly when the model is slow vs. when the app is slow.

If those five changes land in the current codebase, you would likely be at sub-2s p50 TTFT before any rewrite begins.

## 2. Stack decision: do not migrate

The plan's Section 1 says the recommended stack is "Next.js App Router, React, Tailwind / Node.js, TypeScript, Fastify or Hono / Postgres / Redis plus WebSocket." Section 21 confirms separate API and worker processes.

Compared to what exists today:

| Concern | Current (CF Workers + DO + Hyperdrive) | Plan (Next.js + Fastify + Redis) |
|---|---|---|
| Edge latency to user | ~30–70ms global | 100–300ms depending on region |
| WebSocket coordination | Per-user Durable Object with Hibernation, sub-100ms wake | Redis pub/sub + WebSocket server you operate |
| DB connection pooling | Hyperdrive (managed) | PgBouncer or app-level pool you operate |
| Cold start | DO wakes in tens of ms; Worker isolates near-instant | Node process cold starts are seconds in serverless, "always-on" in K8s |
| Long-running streams | DO supports them natively | Long-lived WebSocket on a Node process you keep alive |
| Operational surface | One `wrangler deploy` | Multiple services, Redis, ingress, monitoring |
| Cost shape | Per-request and DO time, low at this scale | Always-on Node + Redis even with zero users |

The current architecture is the architecture you would build if you were starting today, given the product is realtime multi-agent streaming. Throwing it away has no payoff for ClawTalk's actual product needs and adds weeks of platform work that produce nothing the user sees.

The Salon design system, the new agent definition shape, the new Home page, the rewritten frontend — all of this can ship on the current backend with zero migration risk. The plan should make this explicit.

There is one legitimate reason to consider Next.js: server-rendered marketing/SEO surfaces. But Section 18 lists no public marketing pages; everything is behind auth. Vite + React is the right choice here.

**Recommendation:** keep Cloudflare Workers + Hono + Postgres + Durable Objects + Hyperdrive. Replace the "Stack" section of the plan with that decision and a one-paragraph rationale.

## 3. What the plan gets right

It is worth being explicit about the parts of the plan that should ship as written:

- **Product scope cuts.** Threads gone, multi-doc-per-Talk gone, branches gone, scheduled agent jobs gone, community marketplace gone. These are correct. The 01-product-spec.md and ARCHITECTURE-REVIEW.md docs already endorse this; the current webapp drifted from them and accumulated debt that the plan correctly proposes to delete.
- **Agent definition framework.** Section 10 is the most valuable single contribution. The `roleContract / methodology / outputContract / debatePolicy / toolPolicy / modelRationale / persona` split is genuinely better than what `shared/data.jsx` carries today. Make this the v2 data shape and migrate the seed.
- **Prompt snapshots per run.** `talk_agent_snapshots` carrying `system_prompt_snapshot` is the right call for debuggability and for not invalidating run history when an agent is edited.
- **Document/Talk link living on `documents.talk_id`.** Correct call. The current `talks.doc_id` is the wrong way around for the use cases.
- **Salon design tokens, Newsreader + Geist, the prototype as canonical UI reference.** All in good shape. `docs/02-visual-system.md` and `prototype/*.jsx` are real, complete, and portable.
- **Home/Curator/News privacy rule** (topic abstracts only sent to external news providers, never raw message content). Worth keeping verbatim.
- **Recommendation schema with provenance and structured action payloads.** Correct framing. Build this even if the cards are deterministic on day one.

## 4. Where the plan is underspecified

These are the sections that read fine at design level but cannot be implemented without more decisions:

**4.1 Run event protocol.** Section 8 lists event types (`run.status`, `run.delta`, etc.) and says "use monotonically increasing event ids so WebSocket reconnect can replay missed events." The current code already does this via `event_outbox` plus the DO's drain pipeline. The plan does not say whether to reuse `event_outbox` or build a new event log. It should pick one explicitly: reuse `event_outbox` and `streaming-notify.ts`, port them to the new schema if column names change.

**4.2 Cancellation semantics.** Section 8 says "aborts provider streams through AbortController" and gives a 2000–5000ms abort target. The current code's cancellation path is partially implemented and the agent-router tool loop has no cancellation checkpoint between iterations. Spec the cancellation contract per executor state: between iterations, mid-stream, in tool dispatch, in DB commit. Otherwise the cancellation budget is unmeetable.

**4.3 Connector inventory.** Section 11 says "Talk-scoped capability flags. Workspace-level defaults." It does not say which connectors are in scope for v1. The current code has Slack, Telegram, Google Drive/Docs/Sheets, PostHog, Gmail, Web Search, GitHub stubs. Roadmap.md flags some for deletion. The plan should publish a `keep / drop / defer` list for connectors and tools by name, mapped against the prototype's tool catalog in `prototype/tools.jsx`.

**4.4 Frontend salvage list.** The plan's Section 15 reads as if the webapp is greenfield. It is not. There are 36 component files (32K LOC) and many of them — `LiveResponsePanel.tsx`, `RegisteredAgentsPanel.tsx`, `ClawTalkSidebar.tsx`, `SavedSourcesPanel.tsx`, the rich-text TipTap extensions, `wsCacheRouter.ts`, `useTalkSnapshot` hook — are reusable. The plan should ship a per-file decision: rewrite, port-with-changes, keep-as-is, delete. Same for hooks and `webapp/src/lib/api.ts` (which is large but is the API client surface, not throwaway).

**4.5 Migration of existing data.** CLAUDE.md says treat existing local users and data as disposable. Fine for Joseph's local instance. But the new schema in Section 6 is a full redesign — there should be a one-line note in the plan saying "v1 ships with a single baseline migration; existing local schema is dropped; no data migration is performed." Otherwise reviewers will assume some preservation contract exists.

**4.6 Tool-call architecture.** Section 11 describes tools as toggles + connectors + context. It does not describe the runtime contract: do tools execute inline in the worker, in a sandbox, in the existing Cloudflare container path, or in a separate process? The current code has a complex tool execution model (`agent-router.ts`, `google-drive-tools.ts`, `tool-execution.ts`). The plan should pick a model: I'd recommend keeping the current in-worker execution model with the existing per-tool adapter layer, since it works and the queue/DO architecture already supports streaming progress.

**4.7 The Curator's actual job.** Section 16 says deterministic candidates first, model rerank later, but does not say what the model is for. Is it (a) reranking the deterministic list, (b) writing one-sentence why-lines, (c) generating "what should I do next" from raw signals? The right answer is probably (b) only for v1 — the model rewrites why-lines for higher-priority recommendations and never touches the ranking. State this.

**4.8 Acceptance gates.** Each phase has "exit criteria" prose but no measurable gate. Add a single CI/eval gate per phase: e.g., Phase 4 ships when a synthetic load test shows p50 TTFT < 1.5s with a fake provider and the cancellation tests pass within 1s. Without measurable gates, the phasing becomes "we'll know it's done when it feels done."

**4.9 Agent eval.** Section 10.5 names "agent_feedback_events" and Section 10.8 mentions A/B test hooks. There is no plan for **evaluating** whether the canonical agents actually produce differentiated outputs. The 5 system prompts in `docs/03-agents.md` have never been tested against each other. Before Phase 8 (Agents) closes, run an offline eval: same prompt to all 5 agents, see if the Critic actually critiques and the Researcher actually cites. If they don't, the prompts need rewriting, and that should happen before launch, not after. Consider the `ssr-consumer-research` skill or a custom eval harness for this.

**4.10 Threads removal as a migration, not a redesign.** Section 3 says "no Threads." The current webapp has `TalkHistoryEditor.tsx`, `ThreadContextMenu.tsx`, `ThreadRowTitleEditor.tsx`, `ThreadStartButton.tsx`, and a `talk_threads` migration (`0030_contents_html_and_threads.sql`). Treat thread removal as a discrete migration: drop the thread tables, delete the components, collapse the snapshot model. Put this in Phase 1.

**4.11 GitHub OAuth drift.** `docs/04-api-contracts.md` lists `/auth/github` endpoints. The rebuild plan only mentions Google and magic-link. Either bring GitHub forward or note explicitly that the API contract is amended.

**4.12 Model fallback chain.** Each agent has one `model` and one `defaultModel`. There is no spec for what happens when Anthropic returns 5xx mid-stream. Add a per-provider fallback ladder: e.g., Strategist tries `claude-opus-4.5` → `claude-sonnet-4.5` → `gpt-5-pro` with audit logging.

## 5. Restructured implementation plan

The plan's 12 phases can be tightened to a sequence that delivers user-visible value earlier and decouples the latency work from the UI work. The key insight: **the latency win does not require a rebuild, and the UI win does not require a backend rebuild.** Run them in parallel.

### Track A — Latency fixes in current code (weeks 1–3)

Goal: get p50 TTFT from "feels slow" to "feels normal" without touching any UI or schema.

1. Replace `BlockedBySiblingError` + 10s retry with Postgres `LISTEN/NOTIFY` unlock or a DO-mediated unlock signal. Verify with a 3-agent ordered Talk; sibling unlock latency should be < 100ms.
2. Cap tool-loop iterations at 5 for interactive turns; surface "deep thinking" state in the UI. Enable Anthropic prompt caching on the system prompt + assembled context manifest.
3. Add `interactiveModel` to agent definitions; default Strategist to `claude-sonnet-4.5` for first response, escalate to `claude-opus-4.5` only on tool loops > 2 iterations.
4. Drop `fetch_types: true` from the postgres client construction; hand-map the OIDs needed.
5. Instrument `llm_attempts.ttft` and add a Grafana-equivalent (CF Workers Analytics Engine or Logflare) view that separates provider TTFT from app TTFT.
6. Land a synthetic load test in CI that fails if p50 TTFT regresses past 1.5s.

Exit criteria: a 3-agent ordered Talk with one tool call per agent completes streaming in under 30s p50. Cancel intent visible within 1s.

### Track B — Frontend Salon rebuild on existing backend (weeks 1–6, parallel)

Goal: ship the Salon design system, kill the 10K-line TalkDetailPage, and remove Threads.

1. Phase B0: extract Salon tokens from `prototype/*.jsx` into `webapp/src/styles/salon.css` and ship a feature-flagged shell route at `/v2/*`.
2. Phase B1: port `prototype/shell.jsx`, `prototype/screens.jsx` (Home), and `prototype/agents.jsx` to TypeScript modules under `webapp/src/v2/`. Use the existing `useTalkSnapshot` + `wsCacheRouter` hooks. Reuse `LiveResponsePanel.tsx` for the run pill.
3. Phase B2: build the new Talk detail page from `prototype/screens.jsx` TalkDetail + `prototype/talk-dialogs.jsx`. Port what's salvageable from the current page (composer, draft, doc pane integration). Hard target: new Talk page is under 1,500 LOC.
4. Phase B3: delete thread UI components, drop the thread tables in a single migration. Collapse snapshot model. Cmd+K palette ported from `prototype/screens.jsx`.
5. Phase B4: Home Focus layout from `prototype/home-focus.jsx`. Deterministic recommendation candidates only. Stats from `llm_attempts` + `talks` queries.
6. Phase B5: News monitor with deterministic topic extraction, RSS + one web search API. Snooze / add-to-context actions wired to existing context source code.

Exit criteria: `/v2/home` is the new default. The old TalkDetailPage is deleted. Threads are gone end-to-end.

### Track C — Agent definition v2 (weeks 4–8, after Track A lands)

Goal: implement the agent definition framework from Section 10 of the plan, with eval gates.

1. Schema migration: add `role_contract`, `output_contract`, `debate_policy`, `tool_policy`, `model_rationale`, `interactive_model`, `deep_model`, `prompt_version` columns to `clawtalk_agents`.
2. Port canonical agent data from `shared/data.jsx` + `docs/03-agents.md` into a `packages/agents/src/defaults.ts` (or `src/clawtalk/agents/defaults.ts`) with a snapshot test that asserts seed parity.
3. Deterministic prompt assembly in the order Section 10.3 specifies. Per-run `system_prompt_snapshot` storage on `talk_runs`.
4. Agent feedback events table; add thumbs-up/down and category feedback in the UI's `LiveResponsePanel`.
5. **Offline agent eval**: run 30 prompts through all 5 agents using a held-out judge model; verify each role produces statistically distinct output. Block launch if Critic and Editor are indistinguishable.
6. Migrate the seed; reset Joseph's local workspace; re-seed.

Exit criteria: Agents page shows the v2 definition, persona-only edits don't change behavior, methodology edits do, prompt snapshots reproduce old runs.

### Track D — Documents + Pending Edits (weeks 6–9)

Goal: rationalize the doc/talk relationship.

1. Migration: move the link to `documents.talk_id` with a partial unique index. Drop `talks.doc_id`.
2. Keep TipTap as the editor. Add a "pending edit" tracker layer over the existing `rich-text/` extensions rather than rewriting in a controlled block editor. (The plan's "controlled block editor, not ProseMirror" recommendation throws out working code.)
3. Wire `doc.pending-edit` events through the existing outbox path.
4. Archive-with-linked-doc dialog from `prototype/talk-dialogs.jsx`.

### Track E — Polish, eval, launch (weeks 9–11)

Accessibility, responsive QA, error states, audit events for all mutations, latency dashboards. Final agent eval, final TTFT benchmark, final cancellation benchmark. Launch gate is the same as Track A's exit criteria but in production load.

### What is explicitly *not* in the rebuild

- No platform migration to Next.js + Node + Redis.
- No new monorepo split. Keep the current `src/` + `webapp/` shape.
- No Curator model rewrites in v1. Deterministic recommendations only; model usage is one why-line rewrite per active hero card, behind a flag.
- No marketplace, no thread features, no scheduled agent jobs, no async runs.

## 6. Open decisions for Joseph

These are the calls I cannot make for you. Each blocks a specific track.

1. **Latency target.** Is "p50 TTFT < 1.5s on a 3-agent ordered Talk" the right launch bar, or do you want tighter (e.g., < 800ms first-token from the lead agent)? This decides whether Track A is a 3-week or 6-week effort.
2. **Tool loop cap.** Capping at 5 iterations changes Researcher behavior on hard questions. Are you OK with "deep thinking" being a visible escalation rather than the default?
3. **Interactive vs deep model per agent.** Adding a second model per agent is a UX decision (does the user see which is which?) and a billing decision. Worth doing for sure, but you decide whether it's exposed in the agent profile.
4. **Salon scope.** The prototype has Tweaks (density, accent, home layout). Section 5 of the plan strips these. Final call: ship Salon-only, or keep Tweaks as a hidden dev flag?
5. **Stack.** Do you accept the recommendation to keep Cloudflare Workers + DO and not migrate to Next.js + Redis? If you want the migration anyway for non-technical reasons (e.g., team familiarity), say so and Track B becomes a Next.js port instead of a Salon port. The cost is roughly +4 weeks on Track B with no user-visible payoff.
6. **GitHub OAuth.** Bring forward from `docs/04-api-contracts.md` or drop?
7. **Connector keep/drop list.** Slack, Telegram, Drive/Docs/Sheets, PostHog, Gmail, Web Search, GitHub — name which survive v1.
8. **Agent eval bar.** What's the minimum agent differentiation that ships? Suggest: judge model rates 80% of role-tagged outputs correctly when blinded.

## 7. Summary recommendation

Treat the plan as a *product and design spec* that should land essentially unchanged, and an *engineering plan* that needs to be redrawn. The latency problem is solvable in the current backend in three weeks. The UI rewrite is solvable in the current frontend in six weeks. The platform migration is an expensive distraction.

If you want one sentence to drive the rebuild: **port the Salon prototype onto the existing Cloudflare backend, fix the three real latency hotspots, ship the v2 agent definition with an eval gate, and delete Threads.** Everything else is in service of that.
