# T-new-E — t2-t1 attribution (measurement-only plan)

**Status:** Plan, **r1 draft**.
**Tracking:** [[project-llm-turn-latency]].
**Branch (planning):** `docs/t-new-e-t2t1-attribution` (this doc).
**Branch (implementation, to be created):** `feature/t-new-e-instrumentation`.
**Estimated effort:** ~2 h human / ~1 h CC for instrumentation + bench. Follow-up plans (T-new-E1, E2, ...) handle the fixes.

---

## 1. Context

Post-T-new-C bench (n=3, haiku, single-agent, 2026-05-30) per-phase
breakdown — the surprise:

| Phase | Median | What it covers |
|---|---|---|
| t1-t0 | 3038 ms | HTTP `POST /chat` → 202 returned. **Optimized by T-new-A/A2/AR/C.** |
| **t2-t1** | **6571 ms** | **HTTP 202 returned → first `talk_response_started` WS event arrives at client. Untouched.** |
| t3-t2 | 709 ms | First WS event → first `talk_response_delta` (model TTFT-ish). |
| t4-t3 | 1 ms | First delta → completion (bench prompt is short, single emit). |

**t2-t1 is the largest single phase in the entire path** —
~2× t1-t0 and >6× t3-t2 — and no prior T-new lever has touched it.
What lives in t2-t1 is in §2.

This plan is **measurement-only**. Per
[[feedback-measure-before-locking-perf-plans]] the rule is: for a
~6.5 sec structural-unknown phase, deploy temp instrumentation +
measure prod BEFORE locking a fix design. T-new-E delivers the
attribution table; T-new-E1/E2/... pick up the dominant phase
and ship the lever(s).

---

## 2. Surface inventory — what runs in t2-t1

Pinned against current origin/main `696302d`. Path from `ctx.waitUntil(dispatchRunInProcess(...))` firing to the first `talk_response_started` event landing at the bench client:

| Phase | Code | Likely cost |
|---|---|---|
| E0 | `ctx.waitUntil` schedules `dispatchRunInProcess` (talks.ts:~2120 region) | scheduling delay (~ms) |
| E1 | `withRequestScopedDb` opens a fresh DB scope (`src/clawtalk/talks/dispatch-in-process.ts:55`) | Hyperdrive cold-connect possible (~50-300 ms) |
| E2 | `processTalkRunMessage` retry-emit branch (queue-consumer.ts:99-117) | 0 ms on first attempt (skipped) |
| E3 | `markRunRunning(runId)` (queue-consumer.ts:119) | 1 DB write (~125 ms) |
| E4 | `withUserContext` opens Postgres tx (queue-consumer.ts:153) | tx open (~125 ms) |
| E5 | `getTalkMessageById(trigger_message_id)` (queue-consumer.ts:163) | 1 DB read (~125 ms) |
| E6 | Cancel-poller setup (queue-consumer.ts:173-193) | sync (~ms) |
| E7 | `CleanTalkExecutor.execute(input, signal, emit)` entry | n/a (it's the wrapper) |
| E8 | `getTalkRunById(input.runId)` (new-executor.ts:2383) | 1 DB read (~125 ms) |
| E9 | `loadChannelTriggerContext({ triggerMessageId })` (new-executor.ts:2388) | DB reads (channel routing) |
| E10 | `resolveTalkAgent(talkId, targetAgentId)` (new-executor.ts:2392) | DB reads (agent + nickname) |
| E11 | `ensureRunnableModel(activeAgent)` (new-executor.ts:2404) | possibly model-lookup |
| E12 | `getModelContextWindow(activeAgent)` (new-executor.ts:2405) | possibly model-lookup |
| E13 | `buildTalkJobExecutionPolicy(input.jobId)` (new-executor.ts:2406) | DB read if jobId, else 0 |
| E14 | `planExecution(agent, requestedBy, planOpts)` (new-executor.ts:2414) | Effective-tools graph (codex C2: this is the ~435ms `preflight_iter_0`) |
| E15 | `loadChannelExecutionContext({ trigger, binding })` (new-executor.ts:2423) | DB reads |
| E16 | `loadTalkContext(talkId, ...)` (new-executor.ts:2443) | **Many DB reads (message history, threads, tools, content, etc.) — likely the fattest single phase.** |
| E17 | Prompt assembly (system + user prompt building) | sync compute (~ms-100ms) |
| E18 | LLM streaming connection open + 'started' event from provider | Anthropic API connect (~50-300 ms typical) |
| E19 | `emit({ type: 'talk_response_started', ... })` → outbox INSERT → notify queue push | 1 DB write + DO push |
| E20 | UserEventHub DO drain → WebSocket frame → client (= t2) | DO drain (~50-500 ms per T-new-B) |

Per [[feedback-verify-schema-facts-in-plan-gates]]: every file + line above round-tripped through grep against `696302d`. The cost-estimate column is a **prior**, not measurement; §3 measurement is what gives the real numbers.

### 2.1 Why this phase is unmeasured today

T7 inline executor SHIPPED 2026-05-27 (PR #463) replaced the queue dispatch with `ctx.waitUntil(dispatchRunInProcess(...))`. The T7 plan measured t3-t0 (integrated, before & after) and got a 2.7 sec drop, but did NOT publish a per-phase breakdown of what was left. Same for T-new-B (DO drain fix). So we know t2-t1 is 6.5 sec today but we don't know **which** phase inside the chain dominates.

The §2 inventory enumerates candidates from static analysis. Several are obvious suspects:
- **E16 `loadTalkContext`** — biggest surface (message history + threads + tools + content). Likely > 1 sec.
- **E14 `planExecution`** — codex C2 attributed ~435 ms per agent.
- **E10 `resolveTalkAgent`** — could be 2-3 RTs (agent + nickname).

But "likely" is not measurement.

---

## 3. Instrumentation strategy

Add temp `[t-new-e-meta]` probes at each E-phase boundary. Tag with the phase ID + ms delta + (optional) wire-statement count from a Proxy-wrap on `getDbPg()`.

```ts
// At E1 entry (dispatch-in-process.ts):
const tE1 = Date.now();
console.log('[t-new-e-meta]', { phase: 'E1:withRequestScopedDb-entry', runId, ms: 0 });

// At each E-phase boundary:
const tE3 = Date.now();
const claim = await markRunRunning(input.runId);
console.log('[t-new-e-meta]', { phase: 'E3:markRunRunning', runId: input.runId, ms: Date.now() - tE3 });

// ... per-phase
```

**Wire-statement counter (optional, codex consult r1 lesson from T-new-D).** Proxy-wrap `getDbPg()` once per request and log a per-phase `stmts` count alongside `ms`. Helps distinguish "this phase is slow because many DB reads" from "this phase is slow because one slow read".

**Deploy shape:**
- Temp commit on `feature/t-new-e-instrumentation` off main.
- Push, wait for deploy.
- Run n=10 bench (`CLAWTALK_BENCH_RUNS=10 latency-bench.ts --provider=haiku`).
- Read `[t-new-e-meta]` entries from wrangler tail or CF dashboard.
- Collect per-phase p50 + p90 + stmt-count into the §4 attribution table.
- **Revert the instrumentation commit.** It does NOT ship to main.

**Bandwidth note.** `console.log` adds Worker tail bandwidth. Joseph as solo user means the 10 bench runs + light normal traffic stays under quota (T-new-A / T-new-B / T-new-A2 all OK). Re-check after deploy that no quota warnings fire.

---

## 4. Attribution output (T-new-E deliverable)

The T-new-E PR opens with the instrumentation diff. After the bench runs, the table below fills in. Once filled, T-new-E commits the **revert** + the attribution table as a markdown artifact (this section), and the PR lands as docs-only (no production code change).

```
| Phase | p50 ms | p90 ms | stmts | Notes |
|---|---|---|---|---|
| E1 withRequestScopedDb | ? | ? | 0 | Hyperdrive cold? |
| E3 markRunRunning | ? | ? | 1 | |
| E4 withUserContext open | ? | ? | 1 | tx BEGIN |
| E5 getTalkMessageById | ? | ? | 1 | |
| E8 getTalkRunById | ? | ? | 1 | |
| E9 loadChannelTriggerContext | ? | ? | ? | |
| E10 resolveTalkAgent | ? | ? | ? | |
| E11 ensureRunnableModel | ? | ? | ? | |
| E12 getModelContextWindow | ? | ? | ? | |
| E13 buildTalkJobExecutionPolicy | ? | ? | ? | |
| E14 planExecution | ? | ? | ? | codex C2: ~435 ms prior |
| E15 loadChannelExecutionContext | ? | ? | ? | |
| E16 loadTalkContext | ? | ? | ? | likely fattest |
| E17 prompt assembly | ? | ? | 0 | sync |
| E18 LLM connect + first 'started' | ? | ? | 0 | provider-side |
| E19 outbox emit + notify push | ? | ? | 1 | |
| E20 DO drain + WS write | ? | ? | 0 | T-new-B: ~50-500 ms |
| **Total t2-t1** | **?** | **?** | **?** | Sum should reconcile to bench's ~6571 ms p50 |
```

After the table is filled, the **dominant phase becomes the next T-new-E1 plan target**. If no single phase dominates and the cost is distributed (e.g., E10 + E14 + E16 each at ~1-2 sec), T-new-E1 may be a multi-phase plan.

---

## 5. Risks and correctness

| Risk | Mitigation |
|---|---|
| Instrumentation overhead skews measurements | `Date.now()` deltas are ~µs cost; `console.log` is sync but small. Compared to a 6.5 sec phase, instrumentation noise is < 1 %. |
| Probes fire on non-bench user requests | Same — small. Joseph as solo user means total log volume stays under CF tail quota even with normal traffic. |
| `getDbPg()` Proxy wrap breaks something | Same Proxy-wrap pattern already used in [[T-new-C-ensure-default-agent]] test 2 (agent-registry.test.ts mockState). Proven harmless. |
| Revert step forgotten → instrumentation ships to prod | §6 D5 is explicit revert; CI on the revert commit catches typecheck regressions. |
| Bench doesn't trigger the inline path (falls back to queue) | dispatch-in-process.ts:71-97 fallback only fires on pre-claim error. Healthy bench requests stay on the inline path. Test 3 in T-new-A's plan demonstrated this. Confirm in §3 deploy by tailing for "falling back" log lines. |

---

## 6. Tasks

| Task | Files | Verify |
|---|---|---|
| **E-D1** Add `[t-new-e-meta]` probes to dispatch-in-process.ts, queue-consumer.ts, new-executor.ts | 3 files | typecheck passes |
| **E-D2** Push as temp commit on `feature/t-new-e-instrumentation`; deploy | n/a | deploy succeeds; logs visible |
| **E-D3** Run n=10 bench with SPA tabs closed; tail `[t-new-e-meta]` logs into a JSON | n/a | 10 runs captured |
| **E-D4** Compute p50 + p90 per phase; fill §4 table; commit it to the plan branch | docs/T-new-E-t2t1-attribution.md (this file) | table reconciles to bench t2-t1 ±10 % |
| **E-D5** Revert the instrumentation commit on the same branch | (revert of E-D1) | typecheck passes; deploy is no-op |
| **E-D6** Open the T-new-E plan PR (docs + revert only) | n/a | review-ready |
| **E-D7** Identify dominant phase, open T-new-E1 plan for the lever | n/a | follow-up plan exists |

No `MAX_QUERIES` or production code beyond instrumentation. The PR's ship state is **identical to pre-merge main** (instrumentation reverted). The plan doc + filled attribution table is the only durable artifact.

---

## 7. Out of scope

- **Any fix to t2-t1**. T-new-E is measurement. The fix lives in T-new-E1 (or further).
- **Pre-deploy attribution for t1-t0** (sendChatRoute path). T-new-A/A2/AR/C already did this via T-new-A §4.5.
- **Pre-deploy attribution for t3-t2** (~709 ms first event → first delta). Mostly model TTFT + DO event delivery; small absolute size, lower ROI.
- **Pre-deploy attribution for t4-t3** (~1 ms). Already known: bench prompt is short, single-emit.
- **The DO drain phase (E20)** isolated as its own measurement plan. T-new-B's data put p95 at 464 ms; that's bounded. If E20 dominates the t2-t1 attribution unexpectedly, a follow-up plan can revisit T-new-B's measurement assumptions.

---

## Revision history

- **r1 (this revision)** — initial draft. Documents t2-t1 = 6571 ms p50 finding from the 2026-05-30 baseline-pre-t-new-c bench. Lists E0-E20 phase candidates from static analysis of dispatch-in-process.ts / queue-consumer.ts / new-executor.ts. Measurement-only deliverable; follow-up plans (T-new-E1, ...) pick up the fix.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Consult | `/codex consult` | Plan-stage behavior + framework catches | 0 | **PENDING** | — |
| Karpathy Audit | `/karpathy-audit` (file mode) | Plan-stage style + four principles | 0 | **PENDING** | — |

- **VERDICT:** r1 draft. Double review (codex consult + karpathy) is the next step before this measurement plan is opened as a PR.
