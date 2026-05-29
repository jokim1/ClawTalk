# ClawTalk — Engineering Notes

> **Status:** canonical (engineering reference) · **Last updated:** 2026-05-28
> Durable, hard-won engineering knowledge distilled from docs that were archived in the 2026-05-28 restructure. The originals live in [`archive/`](./archive/); line numbers there may be stale, so treat the code as truth and these as orientation. Stack decision is [DECISIONS.md](./DECISIONS.md) D1.

---

## 1. Architectural commitments (from `archive/ARCHITECTURE-REVIEW.md`)

These principles outlive any particular codebase and should hold for the current Workers runtime:

1. **The DB transcript is the single source of truth.** Execution surfaces are adapters over persisted state, not owners of it. Don't let an in-memory/runtime layer become authoritative.
2. **Execution is a stateless adapter.** Whatever runs a turn (worker, queue consumer) should be reconstructable from DB state; no hidden run state that can't be recovered.
3. **Per-agent execution routing.** Routing/credentials/tool-access are resolved per agent per run, not globally.
4. **Credential resolution is explicit (execution-resolver rationale).** OAuth/subscription tokens must **not** be sent as `x-api-key`; the resolver distinguishes credential modes. This is a real, easy-to-reintroduce bug — keep the distinction explicit. (See current `src/clawtalk/agents/` execution-resolver + migration `0032_agent_credential_mode.sql`.)
5. **Connector secrets decrypt just-in-time.** Ciphertext at rest; decrypt only at use; GET APIs expose only `hasCredential`, never the secret.

Tool **capability tiers** (what a tool is allowed to do) and the **capability-vs-effective-execution** distinction (an agent's declared capability is gated by the Talk's tools/connectors at runtime) are also worth preserving from that review.

---

## 2. Latency hotspots (from `archive/CLAWTALK_V2_REBUILD_PLAN_REVIEW.md`)

Identified against the real `src/`/`webapp/` — verify against current code before acting, but these were the concrete wins:

- **Ordered-mode sibling-wait retries.** Ordered runs were doing ~10s `BlockedBySiblingError` retry loops (around the worker dispatch path). Tighten the wait/notify instead of fixed-interval retry.
- **Tool-loop connection teardown.** Re-establishing connections each of up to ~10 tool-loop iterations (agent-router) — reuse the connection across the loop.
- **Per-request DB setup.** `fetch_types: true` (and similar) re-running per request in `db.ts` — cache/skip on the hot path.

The review's broader conclusions, now canonical: **keep Cloudflare Workers** (D1); the current webapp drifted from the Salon spec and should be brought back to it; several frontend pieces are worth salvaging rather than rewriting (e.g. live-response panel, ws cache router, talk-snapshot hook).

---

## 3. Offline agent eval gate (from the same review) — launch-blocking

The five system prompts in `03-agents.md` have **never been tested against each other** in a multi-agent run. Before launch, build an offline eval that runs the default team on representative prompts and checks role adherence, non-duplication, evidence discipline, and concision (the rubric in `06` §14.6 `AgentAuditResult`). Track this as a build-plan item (DOC-AUDIT #24).

---

## 4. Reusable schema & orchestration (from `archive/CLAWTALK_V2_REBUILD_PLAN.md`)

The rebuild plan's *stack* was rejected, but these engineering artifacts are still useful references when implementing:

- **Latency budget** with per-stage p50/p95 targets.
- **A full proposed Postgres schema**, including the Home subsystem tables (`home_inbox_items`, `home_recommendation_candidates`, `home_news_topics/items/matches`, `home_ranking_profiles`, `home_optimization_proposals`) and an index strategy — the most concrete materialization of `07`/`08` anywhere.
- **The run-orchestration state machine** (Ordered/Parallel rules, cancellation contract, run-event taxonomy) and a provider-interface signature.

Pull from these when fleshing out `04`/`05`/`07`; don't adopt their Next.js/Node/Redis assumptions.

---

## 5. claude-agent-sdk gotcha (from `archive/SDK_DEEP_DIVE.md`) — only if the SDK path returns

The current Talk runtime is **direct-HTTP / provider-routed** and does **not** use `@anthropic-ai/claude-agent-sdk`. If an agentic/tool-using execution mode ever reintroduces the SDK, the non-obvious, hard-won finding to remember:

- A **V1 string prompt** sets `isSingleUserTurn = true`, which **auto-closes stdin and kills agent-team subagents mid-research**. The fix is to pass an `AsyncIterable<SDKUserMessage>` (streaming input) instead of a string. V1 vs `unstable_v2_createSession` showed zero difference in turn behavior.

The archived doc has the full `query()` options table and message-type reference.
