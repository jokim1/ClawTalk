# T-new-A2 — `enqueueTalkTurnAtomic` per-request 1734 ms latency reduction

**Status:** Plan, **r2 draft**. r1 cleared by `/karpathy-audit diff` (4/4 coverage, 1 warning + 3 nits) but **r1 NOT cleared by `/codex` consult — 3 HIGH findings, verdict "do not ship as-is."** r2 absorbs both.
**Tracking:** [[project-llm-turn-latency]]. Next lever after T-new-A landed (`f596fb2`, −121 ms attributable).
**Branch (planning):** `docs/t-new-a2-plan` (this doc).
**Branch (implementation, to be created):** `feature/t-new-a2-enqueue-turn`.
**Estimated effort:** ~4h human / ~45 min CC. (Estimates carried from T-new-A pattern; A2 measurement may revise.)

### Revision history

- **r1 (2026-05-29):** Initial draft from the post-T-new-A A2 instrumentation. `enqueueTalkTurnAtomic` ran at 1734 ms median in the 3-run haiku bench (instrumented version `2e327d4b`). Codex C8 (T-new-A r3 review) flagged the per-agent loop as deferred work needing its own plan; this is that plan.
- **r2 (2026-05-29, this version):** Codex consult on r1 returned 7 findings (3 HIGH, 3 MEDIUM, 1 LOW) with verdict "do not ship as-is." Absorbed via:
  - **C-H1 (combined SELECT no-row behavior):** Defined explicit `EnqueueTurnContextNotFoundError` contract for the helper. Documented that thread resolution stays outside the combined SELECT — `resolveThreadIdForTalk` already runs first and validates visibility.
  - **C-H2 (active-round race):** Documented as out-of-scope (existing bug, not introduced by Option A); added to §5 risks.
  - **C-H3 (§4.5 gate invalid):** Reworked §4.5 entirely. Instrumentation now ALSO ships the proposed combined helper as a "shadow query" alongside the 3 old SELECTs, so the gate compares actual measured deltas instead of speculating from RT-count. Bench n=10 with warmup, not n=3.
  - **C-M1 (Promise.all pipelining overclaimed):** §3.4 softened. Option D becomes a measured hypothesis; the §4.5 instrumentation MUST capture pre-Promise.all vs post-Promise.all timing.
  - **C-M2 (outbox event ordering):** Added Test 4 (outbox event_id + notify-queue ordering preserved across Promise.all).
  - **C-M3 (Test 5 unimplementable):** Replaced. Use the existing attachment-validation throw path (accessors.ts:2404) as the post-Promise.all rollback trigger.
  - **C-M4 (C8 deferral not clean):** §4.5 extended — instrumentation now requires per-agent sub-phase breakdown AND a multi-agent N=3 bench run alongside N=1. Follow-up plan T-new-A2-followup gets filed with concrete measurement evidence when A2 completes.
  - **C-L1 (test overlap with existing accessors.test.ts:916):** Dropped redundant N=3 fan-out test. Focused new tests on CHANGED behavior only (combined helper no-row, ordering, rollback).
  - Karpathy diff audit also returned 1 WARNING (savings predictions not conditional on §4.5) and 3 NITs. Absorbed: §4.3 / §4.7 rewritten as conditional; PR title dropped from §6; §9 estimates annotated. NIT 2 (deferred-options verbosity) deferred to taste; left as-is for follow-up plan readers.

---

## 1. Context

After T-new-A shipped (PR #472, `f596fb2`), the A2 per-phase numbers placed `enqueueTalkTurnAtomic` at **1734 ms median (n=3 haiku)** — nearly half the entire 4123 ms instrumented t1-t0. The next biggest single phases were `ensureTalkUsesUsableDefaultAgent` (748 ms — 3 SELECTs) and `preflight_iter_0` (435 ms per agent). T-new-A2 targets the largest remaining lever.

The function lives at `src/clawtalk/db/accessors.ts:2223-2434`. It executes inside the `enqueueTalkChat` handler's `withUserContext` tx and does the full user-message + queued-runs + outbox write in one atomic block.

**Codex C8 from T-new-A r3 was explicit:** the per-agent loop calls `getRegisteredAgent` inside a sequential for-loop. Codex warned against shipping a "one round trip" claim for the loop without deeper understanding of the call graph. This plan provides that understanding.

---

## 2. The cost — what `enqueueTalkTurnAtomic` actually does

File: `src/clawtalk/db/accessors.ts:2223-2434`. The function runs inside the outer `withUserContext` tx; postgres.js serializes queries on the single tx connection.

### 2.1 The await chain (per single-agent /chat with no attachments, default thread)

| # | Line | Call | Reads / writes |
|---|---|---|---|
| 1 | 2256 | `resolveThreadIdForTalk({threadId: undefined})` → `getOrCreateDefaultThread` | 1 SELECT (talk_threads); 1 INSERT only on cold thread |
| 2 | 2265 | active-rounds count check | 1 SELECT (talk_runs) |
| 3 | 2288 | `createTalkMessage` | 1 INSERT (talk_messages) |
| 4 | 2300 | SELECT title from talk_threads | 1 SELECT (talk_threads) |
| 5 | 2305 | `maybePersistTalkThreadTitleFromMessages` | 1 SELECT (first user message); 0-1 UPDATE (talk_threads title) |
| 6 | 2317 | SELECT active_tool_families_json from talks | 1 SELECT (talks) |
| 7 | 2338 | per-agent loop body × N: `getRegisteredAgent` | N SELECTs (registered_agents) |
| 7b| 2342 | per-agent loop body × N: `resolveCredentialKindSnapshot` | 1-2 SELECTs each (llm_provider_secrets, workspace_provider_secrets) |
| 7c| 2344 | per-agent loop body × N: `createTalkRun` | N INSERTs (talk_runs) |
| 8 | 2362 | `touchTalkUpdatedAt` | 1 UPDATE (talks.updated_at) |
| 9 | 2363 | `emitOutboxEvent` for message_appended | 1 INSERT (event_outbox) |
| 10| 2378 | `emitOutboxEvent` loop × N for talk_run_queued | N INSERTs (event_outbox) |

For the single-agent bench (N=1, default thread exists, no attachments):
- Pre-loop: 5-6 RTs (steps 1-6)
- Per-agent loop: 3-4 RTs (steps 7-7c)
- Post-loop: 3 RTs (steps 8-10)
- **Total: ~11-13 sequential RTs inside the tx**

Plus the surrounding tx commit cost (not captured in §A2 phases).

### 2.2 What this means for the 1734 ms median

The arithmetic doesn't quite add up to a clean RT-cost per query (13 RTs × 130 ms ≈ 1700 ms only matches if every RT is slow, which Hyperdrive should not be). Two hypotheses:

1. **Cold-start dominates.** The first query on a fresh Hyperdrive connection inside the tx pays TCP+TLS+auth setup, and subsequent queries are fast. enqueueTalkTurnAtomic might be the first heavy work after the lighter pre-phases (which mostly hit cached connections from the read-only preflight path).
2. **Server-side query cost dominates.** RLS evaluation, JSONB serialization for `metadata_json`/`active_tool_families_snapshot`/`credential_kind_snapshot`/event_outbox.payload, the 25-column INSERT for talk_runs.

**Either way, the plan cannot speculate.** §4.5 pre-deploy instrumentation (sub-phase timings inside enqueueTalkTurnAtomic) is non-negotiable here. T-new-A validated 121 ms with the same pattern; T-new-A2 targets ~500-1000 ms of structural cost and needs the same attribution discipline.

### 2.3 What's invariant (cannot be moved)

- The entire function MUST stay atomic — rollback semantics protect against orphaned messages / runs / outbox rows. Splitting into multiple txs is out of scope.
- `createTalkMessage` MUST precede `createTalkRun` (FK: talk_runs.trigger_message_id → talk_messages.id).
- `resolveThreadIdForTalk` MUST precede everything (other tables need thread_id).
- The active-rounds count check MUST precede inserts (it gates the throw).
- The outbox emits MUST follow their referenced rows being committed in the same tx (consumers SELECT from talk_messages / talk_runs by event id).

---

## 3. Options

### 3.1 Option A — Combine pre-loop SELECTs (single-agent friendly)

Replace steps 2, 4, 6 (three independent SELECTs) with one CTE-style query that returns:
- talks.active_tool_families_json
- talk_threads.title
- (count of active talk_runs in this thread)

```sql
SELECT
  tk.active_tool_families_json,
  th.title,
  (SELECT count(*)::int FROM talk_runs
   WHERE talk_id = tk.id AND thread_id = th.id
     AND status IN ('queued', 'running', 'awaiting_confirmation')) AS active_count
FROM talks tk
JOIN talk_threads th ON th.talk_id = tk.id
WHERE tk.id = $1 AND th.id = $2
LIMIT 1
```

**Savings:** 2 sequential RTs per request, regardless of N. Concrete and N=1-friendly.

**Risks:** Changes the column shape returned to enqueueTalkTurnAtomic's middle section. Test coverage must lock the active-rounds-error path (Test 5 below).

### 3.2 Option B — Batch the per-agent loop (codex C8 target)

For N agents:
- One `SELECT ... FROM registered_agents WHERE id = ANY(${ids}::uuid[])` instead of N sequential SELECTs.
- One multi-row `INSERT INTO talk_runs VALUES (...), (...), ... RETURNING *` instead of N INSERTs.
- `resolveCredentialKindSnapshot` stays per-agent (different agents have different provider_ids), but the N calls run via `Promise.all` to pipeline inside the tx (postgres.js sends queries before awaiting; gains apply up to `max_pipeline`).

**Savings:** (N-1) × 2 RTs for the loop SELECT+INSERT pairs. **N=1 → 0 savings.** N=3 → 4 RTs. The bench is N=1, so Option B is a no-op on the headline number but reduces variance for multi-agent /chat (the user's actual workflow most days).

**Risks:** Multi-row INSERT to `talk_runs` is a 25-column statement. `RETURNING ${db.unsafe(TALK_RUN_COLUMNS)}` returns rows in INSERT order (postgres guarantee). Test 6 (multi-agent ordering) locks this.

**Codex C8 caveat:** `resolveCredentialKindSnapshot` is per-agent and may issue 1-2 SELECTs each. The Promise.all pipelining helps but the underlying query count stays the same. Option B does NOT eliminate the per-agent credential read — it only parallelizes it. If the credential SELECTs are the cost driver (vs. the run-creation INSERTs), gains are smaller than headline.

### 3.3 Option C — Defer cosmetic post-write to ctx.waitUntil

Move out of the critical path (to `ctx.waitUntil(...)` on the worker `ExecutionContext`):
- `touchTalkUpdatedAt` (step 8) — sidebar `updated_at` ordering. Cosmetic. Eventual consistency is fine.
- `maybePersistTalkThreadTitleFromMessages` (step 5) — thread title heal. Cosmetic. Eventual consistency is fine.

**Savings:** 1-3 RTs depending on whether title-heal fires.

**Risks:**
- `ctx.waitUntil` runs OUTSIDE the surrounding `withUserContext` tx. The deferred operations need their own scope (e.g., the out-of-band sql client per `appendOutboxEventOutsideTx`'s pattern). Adds complexity.
- If the deferred write fails after the response returns, the user sees no error but the title heal silently drops. **NEEDS:** retry policy or accepted-best-effort doc note.
- Splits "atomicity" — the function is no longer truly atomic for these cosmetic writes. Renaming may be required (`enqueueTalkTurnAtomic` no longer encompasses the full write set).
- Codex C1 (T-new-A r3) on durability: deferred operations off ctx.waitUntil have a 30s ceiling on the CF Worker free tier; longer on Paid. Title heal is fast, so OK.

### 3.4 Option D — Pipeline independent post-INSERT operations via Promise.all

After the agent loop, steps 8-10 are independent of each other:
- touchTalkUpdatedAt (UPDATE talks)
- emitOutboxEvent for message_appended (INSERT event_outbox)
- emitOutboxEvent loop for talk_run_queued × N (N INSERTs to event_outbox)

These can be sent via `await Promise.all([...])`. postgres.js pipelining behavior **inside an async tx callback hidden by withUserContext is less well-characterized than codex would like** (codex C-M1) — the postgres.js docs describe pipelining for `sql.begin` returning an array of query objects; we're inside an async callback. PostgreSQL pipeline mode still executes statements in send order on a single connection; errors abort later queued work but don't parallelize server execution.

**Status:** Measured hypothesis, not "well-understood" guaranteed savings. The §4.5 instrumentation MUST capture pre-Promise.all-shape vs post-Promise.all-shape timing to validate.

**Potential savings:** ~1 round-trip per request if pipelining materializes; otherwise zero.

**Risks:** Outbox event_id ordering — `event_outbox.event_id` is bigserial; if `message_appended` and `talk_run_queued` INSERTs go in send order they get monotonic IDs in JS-array order, but tests should LOCK this rather than rely on accidental correctness (codex C-M2). The async-callback contract preserves transactional atomicity even under Promise.all (postgres.js serializes on the underlying connection); Test 5 (rollback) confirms.

### 3.5 Combination matrix

| Option | N=1 saver | N≥2 saver | Risk | Codex-blocker concerns |
|---|---|---|---|---|
| A (pre-loop SELECT combine) | up to ~2 RTs (TBD §4.5) | up to ~2 RTs | Low — but C-H1 missing-row contract must be explicit | Existing active-round race (C-H2) preserved; documented |
| B (batch per-agent loop) | 0 | (N-1)×2 RTs if INSERTs dominate; less if cred SELECTs do | Medium — multi-row INSERT shape, C8 attribution incomplete | Per-agent cred SELECT still serial; needs §4.5 sub-phase to confirm |
| C (defer cosmetic to waitUntil) | ~1-3 RTs | ~1-3 RTs | High — atomicity scope shrinks; silent-drop risk | Naming, retry policy, CF 30s waitUntil ceiling |
| D (pipeline post-loop) | up to ~1 RT (TBD §4.5) | up to ~N RTs | Medium — pipelining behavior inside async-callback under-specified (C-M1); needs ordering test (C-M2) | Promise.all atomicity OK; ordering must be locked |

---

## 4. The fix — Option A + Option D (proposed)

### 4.1 Why this combination

- **Option A** is the only proposal that saves on the bench (N=1) without architectural risk. ~2 RTs.
- **Option D** complements A: low-risk, structurally correct, and benefits multi-agent fan-outs.
- **Option B is deferred.** The codex C8 caveat (per-agent credential SELECT is what dominates the loop, not the INSERT) means B's gain is unclear without §4.5 measurement. Multi-agent /chat is also rare in solo-user clawtalk.
- **Option C is deferred.** Atomicity-shrinking is a structural change that needs its own plan. The "ctx.waitUntil silent drop on title heal failure" is a real concern the dedupe plan shouldn't take on.

If §4.5 instrumentation reveals that the credential SELECTs (step 7b) dominate the per-agent loop, T-new-A2-followup can revisit B with Promise.all pipelining inside the loop body.

### 4.2 What changes

1. **`src/clawtalk/db/accessors.ts`** — new helper `loadEnqueueTurnContext(talkId, threadId): Promise<EnqueueTurnContext>` returns `{title, activeFamilies, activeCount}` in one SELECT. Net +25 LoC.
   - **No-row contract (per codex C-H1):** the helper takes a pre-resolved `threadId` (resolveThreadIdForTalk runs first and validates visibility, line 2256). If the combined SELECT returns no row anyway (race: talk deleted between resolveThreadIdForTalk and the combined SELECT), throw a new `EnqueueTurnContextNotFoundError`. enqueueTalkChat's outer catch maps this to 404 `talk_not_found` symmetric with the current behavior.
2. **`src/clawtalk/db/accessors.ts` — `enqueueTalkTurnAtomic`** swap call sites:
   - Replace the 3 separate SELECTs (steps 2, 4, 6) with one call to `loadEnqueueTurnContext`.
   - Move the post-loop sequential awaits (step 8 `touchTalkUpdatedAt`, step 9 `emitOutboxEvent` for message, step 10 `emitOutboxEvent` loop) into `await Promise.all([...])`. Net ≈ −10 / +5 LoC.
3. **`src/clawtalk/web/routes/talks.ts`** — add `EnqueueTurnContextNotFoundError` to the existing `try/catch` in `enqueueTalkChat` (around line 2050). Maps to 404 `talk_not_found`. Net +6 LoC.

No CTE for the agent loop, no batch INSERT to talk_runs, no ctx.waitUntil deferrals. Active-round race (C-H2) is preserved as-is (existing bug; out of scope here).

### 4.3 Expected savings (CONDITIONAL on §4.5 measurement)

The §4.5 measurement gate determines whether the structural-RT-count argument actually translates to measured time. Per codex C-H3, you can't assert "3 SELECTs ≥300 ms → Option A saves 300 ms" without measuring the combined query's actual cost.

**Conditional prediction:**

- **If §4.5 reveals the 3 pre-loop SELECTs cost (3 × RT) AND the combined SELECT costs ≈ 1 × RT:** Option A saves ~2 RTs. At ~80-150 ms/RT typical Hyperdrive, that's **~160-300 ms**.
- **If the combined SELECT costs significantly more server-side (subquery + join):** Savings shrink. Could be ~0 if combined cost ≈ 3 × old-RT.
- **If Option D's pipelining materializes inside async-callback:** Additional ~1 RT saved on N=1. If pipelining doesn't materialize: zero gain from D (still ship; no harm done).
- **Combined honest range:** ~0 ms (if both gates fail) to ~400 ms (if both gates pass). The plan is only worth shipping if §4.5 puts the combined gain ≥ 100 ms.

End-to-end t1-t0 prediction: 3920 ms → 3520-3800 ms IF gates pass; unchanged if not. The plan ships A+D regardless of gate outcome (they're observably correct, just possibly zero-saver); but A4 will document the measured gain honestly in the commit.

### 4.4 What's NOT in this plan (deferred)

- **Option B** (batch per-agent loop) — needs §4.5 attribution between getRegisteredAgent vs. resolveCredentialKindSnapshot vs. createTalkRun before locking the implementation shape.
- **Option C** (ctx.waitUntil cosmetic-defer) — atomicity rename + retry policy + silent-drop risk needs its own plan.
- **`ensureTalkUsesUsableDefaultAgent` ~748 ms** — separate plan; A2 surfaced it independently.
- **`preflight_iter_0` ~435 ms per agent** — codex C2 effective-tools graph; separate plan.
- **Hyperdrive connection pooling tuning** — out of scope.

### 4.5 Pre-deploy measurement — A/B/shadow-query strategy (REWRITTEN per codex C-H3 + C-M4)

Codex C-H3 flagged that the original "3 SELECTs ≥300 ms → ship A" gate is invalid: it proves the 3 SELECTs are expensive, not that the combined version is cheaper. The fix: ship the proposed combined helper AS A SHADOW QUERY during measurement, so we compare actual measured deltas instead of speculating.

**Three instrumentation commits land before the dedupe:**

1. **Sub-phase logging.** Wrap every await in enqueueTalkTurnAtomic with `console.log('[t-new-a2-meta] turn', { sub_phase, elapsed_ms })`. Sub-phase names:
   - `resolveThreadIdForTalk`, `activeRoundsCount`, `createTalkMessage`, `selectThreadTitle`, `maybePersistThreadTitle`, `selectActiveToolFamilies`
   - `agent_loop_iter_<i>_getRegisteredAgent`, `agent_loop_iter_<i>_resolveCredentialKindSnapshot`, `agent_loop_iter_<i>_createTalkRun`
   - `touchTalkUpdatedAt`, `emitMessageAppended`, `emitTalkRunQueued_<i>`, `enqueueTalkTurnAtomic_total`.

2. **Shadow combined-SELECT.** After step 6 in the existing flow, run `loadEnqueueTurnContext(talkId, threadId)` as a SHADOW query (result discarded). Log `[t-new-a2-meta] turn { sub_phase: 'shadowCombinedHelper', elapsed_ms }`. This gives the head-to-head comparison the gate needs: (sum of steps 2+4+6) vs shadowCombinedHelper.

3. **Pre-Promise.all-shape post-loop timing.** Log `[t-new-a2-meta] turn { sub_phase: 'postLoopSerial', elapsed_ms }` wrapping steps 8-10 as a group. Establishes the Option D baseline.

**Bench protocol (per codex C-H3 noise concern):**
- **n = 10 runs** (not 3). 3 warmup runs first; discard. Median + p95 on the trimmed 10.
- Single-agent **AND** N=3-agent benches (per codex C-M4 — C8 deferral only clean if we also have multi-agent attribution).
- SPA tabs closed per [[feedback-close-clawtalk-tabs-before-bench]].

**Decision gate (TWO sub-gates; both must pass for the corresponding option to ship a meaningful saving):**

| Gate | Triggers Option A | Triggers Option D |
|---|---|---|
| Option A worth shipping | `(median sum of selectThreadTitle + activeRoundsCount + selectActiveToolFamilies) − median shadowCombinedHelper ≥ 100 ms` | n/a |
| Option D worth shipping | n/a | `median postLoopSerial − measured post-Promise.all (via reverse-shadow: instrument both shapes in alternating requests) ≥ 50 ms` |

**Outcomes:**
- **Both gates pass:** Ship A + D as planned. Predicted savings hold.
- **Only A passes:** Ship A; drop D from the PR (code stays simpler). Open an issue noting D didn't pipeline as predicted.
- **Only D passes:** Ship D; drop A from the PR (the combined query was no faster). File a follow-up to investigate why.
- **Neither passes:** Don't ship this PR. Pivot to T-new-A2-followup based on which sub-phase dominated the 1734 ms.

**Per-agent attribution from the N=3 bench (codex C-M4 / C8 follow-up):**
After A2 completes, file `T-new-A2-followup` (or roll into T-new-A3) with the per-agent sub-phase numbers showing which of getRegisteredAgent vs resolveCredentialKindSnapshot vs createTalkRun dominates the loop. That data targets Option B's design.

Revert all 3 instrumentation commits before the dedupe ships. (Pattern: same `git revert` flow used in T-new-A's A3.)

### 4.6 Local verification before push

```bash
npm run typecheck
npx vitest run src/clawtalk/db/accessors.test.ts
npx vitest run src/clawtalk/web/routes/talks.test.ts
npx vitest run                                      # full backend suite
npm run format:check
```

### 4.7 Post-deploy verification (CONDITIONAL on §4.5 gate outcome)

Run the same n=10 haiku bench after A4 ships. The §4.5 measurement already established what to expect.

| Metric | T-new-A baseline | T-new-A2 prediction (if both §4.5 gates pass) |
|---|---|---|
| `t1-t0` median (haiku, n=10) | 3920 ms | savings between §4.5 measured (sum-old − combined-shadow) and §4.5 measured + (postLoopSerial − pipelined-shadow) |
| `t3-t0` median | 10628 ms | proportional to t1-t0 delta |
| Success rate | 10/10 | 10/10 |
| `wrangler tail` errors | zero | zero |

**If only one gate passed in §4.5,** the prediction shrinks to that gate's measured delta only. If neither passed, this section is moot — the plan was already pivoted (§4.5 "Neither passes" path).

If post-deploy median is significantly different from §4.5's prediction (>30% off), something changed between measurement and deploy. Investigate — don't paper over with "noise."

---

## 5. Risks and open questions

1. **The combined SELECT is shape-coupled to enqueueTalkTurnAtomic's middle section.** If a future change adds a fourth pre-loop read (e.g., a workspace-scope check), the helper must extend, not be bypassed. Mitigated by exporting it from accessors.ts alongside getTalkById, etc.
2. **No-row contract under race conditions (codex C-H1).** `loadEnqueueTurnContext` throws `EnqueueTurnContextNotFoundError` if talk+thread aren't both visible. Today this can only fire if the talk got deleted between `resolveThreadIdForTalk` (line 2256) and the combined SELECT (a few ms later, still inside the same tx). The route catch maps it to 404 `talk_not_found`. Test 2 locks this.
3. **Existing active-round race (codex C-H2) is preserved.** Lines 2265-2274 today: SELECT count then INSERT — two concurrent /chat requests on the same thread can both observe zero active runs and both succeed. **Out of scope** for this plan; existing bug. Fix is a tx-level advisory lock or a partial unique index, both of which need their own design plan.
4. **postgres.js pipelining under async-callback is under-specified (codex C-M1).** Option D's gain is gated on §4.5's measurement; if pipelining doesn't materialize, D is a no-op (still correct, just zero saver). Test 5 locks the rollback semantics either way.
5. **Outbox ordering under Promise.all (codex C-M2).** event_id ordering is preserved as long as Promise.all sends in JS array order, but Test 4 locks this rather than relying on accidental correctness.
6. **§4.5 instrumentation could discover the bottleneck is server-side, not RT count.** If a single INSERT/SELECT takes 500+ ms, the gates fail and the plan pivots (§4.5 "Neither passes" path). Fallback: file a postgres-side investigation plan.
7. **Codex C8's deeper concern is partially addressed.** §4.5's N=3 bench attribution (per codex C-M4) gives us per-agent sub-phase data. If the credential resolve dominates the loop, T-new-A2-followup gets filed with that evidence. This plan's A+D value-add is codex-orthogonal to C8.

---

## 6. What lands in the PR

1. `src/clawtalk/db/accessors.ts` — `loadEnqueueTurnContext(talkId, threadId)` export + `EnqueueTurnContextNotFoundError` + swap call sites in `enqueueTalkTurnAtomic`. Net +30 / −10 LoC.
2. `src/clawtalk/db/accessors.ts` — `enqueueTalkTurnAtomic` post-loop Promise.all wrapping. Net +5 LoC.
3. `src/clawtalk/web/routes/talks.ts` — `EnqueueTurnContextNotFoundError` mapped to 404 in `enqueueTalkChat` catch block. Net +6 LoC.
4. `src/clawtalk/db/accessors.test.ts` — extend with focused tests (see §7). Net ≈ +120 LoC.

Net diff: ~+150 LoC (≈40 src, ≈120 test).

**Sequencing:**
1. Branch off main, add §4.5 instrumentation (3 commits per §4.5), ship as a temp deploy.
2. Run n=10 haiku bench (single-agent AND N=3) against instrumented prod. Evaluate the §4.5 gates.
3. Revert all instrumentation commits.
4. Apply Options A + D + tests according to which gates passed.
5. Local verify (§4.6). Open PR. Run `/codex review` + `/karpathy-audit diff` per [[feedback-codex-catches-behavior-karpathy-catches-style]]. Address findings. Squash-merge. Run §4.7 verification.

PR title: TBD post-§4.5 (gate outcome determines which option(s) actually ship). Default if both pass: `perf(chat): combine pre-loop SELECTs + pipeline post-loop in enqueueTalkTurnAtomic (T-new-A2)`.

---

## 7. Tests

### 7.1 Test plan (rewritten per codex C-L1 / C-M2 / C-M3)

Existing `accessors.test.ts:916` already covers N=2 fan-out, outbox row counts, and active-round rejection. **New tests focus on CHANGED behavior only** — no redundant coverage.

5 tests in `src/clawtalk/db/accessors.test.ts`:

```
CODE PATHS                                            USER FLOWS
[+] enqueueTalkTurnAtomic (accessors.ts)
  ├── loadEnqueueTurnContext (new helper)
  │   ├── [★★ Test 1] explicit non-default thread       [+] Explicit thread
  │   │   resolves to the right context                   └── [★★ Test 1] non-default thread routes correctly
  │   └── [★★★ Test 2] missing talk → throws             [+] Race / deleted talk
  │       EnqueueTurnContextNotFoundError                 └── [★★★ Test 2] talk deleted between resolveThread
  │       (NOT generic postgres error)                       and combined SELECT → mapped 404
  ├── active-rounds check (unchanged shape)             [+] Active-round atomicity
  │   └── [★★★ Test 3] rejection writes nothing,          └── [★★★ Test 3] TalkActiveRoundError → zero outbox,
  │       even after Option A swap                            zero message, zero run
  ├── Promise.all post-loop
  │   └── [★★★ Test 4] outbox event_id ordering          [+] Outbox order under pipeline
  │       message_appended < talk_run_queued              └── [★★★ Test 4] event_id monotonic; notify queue
  │                                                          order preserved
  └── rollback after Promise.all
      └── [★★★ Test 5] invalid attachment rolls back       [+] Rollback after post-loop
          message + run + outbox (uses existing path 2404)  └── [★★★ Test 5] full tx rollback when post-Promise.all
                                                                throw fires
COVERAGE: 5 changed paths tested. Existing N=2 fan-out (test at :916) covers unchanged shape.
QUALITY: ★★★:4 ★★:1
```

Legend: ★★★ behavior + edge + error  |  ★★ happy path

**Tests:**

- **Test 1 (★★)** — explicit non-default thread: caller passes a non-default `threadId`. Assert the run lands on that thread; assert `loadEnqueueTurnContext` returns the correct title + activeFamilies for THAT thread, not the default one.
- **Test 2 (★★★)** — talk-deleted race: seed a talk, get a threadId via `resolveThreadIdForTalk`, then DELETE the talk row (simulating concurrent deletion), then call `enqueueTalkTurnAtomic` → assert it throws `EnqueueTurnContextNotFoundError`. NOT a generic postgres error. The route's catch path maps to 404.
- **Test 3 (★★★)** — existing queued run on the thread → `TalkActiveRoundError`. Assert ZERO message / run / outbox rows written despite Option A reshaping the active-rounds check. (Existing test at :916 covers the active-round rejection but doesn't explicitly assert zero side effects — this locks that under the new helper shape.)
- **Test 4 (★★★)** — outbox event ordering under Promise.all: seed a 2-agent /chat call. After the call returns, SELECT event_outbox rows by topic — assert `message_appended` has a LOWER event_id than EITHER `talk_run_queued` row. Then assert the notify queue (`getNotifyQueueForCurrentScope()` or equivalent) preserved the same order.
- **Test 5 (★★★)** — rollback after Promise.all: inject an INVALID attachment ID via the `attachmentIds: [...]` argument. The validation throw at line 2404 fires AFTER the Promise.all post-loop has already written outbox rows in-tx. Assert ZERO message + run + outbox rows after the tx rolls back. This is the only realistic "throw after Promise.all in-tx" path in the function.

### 7.2 Test discipline

- Use the existing `seedAuthUser` + `purge` helpers from `accessors.test.ts`.
- Each test runs inside `withUserContext(USER_ID, async () => {...})`.
- Test 2 uses `db\`delete from public.talks where id = ${talkId}\`` to simulate the race; postgres CASCADE wipes related rows.
- Test 5 uses a UUID that doesn't exist in `talk_message_attachments` as the `attachmentIds: [...]` element; the existing validation loop at line 2412 will throw `AttachmentValidationError` after the outbox INSERTs ran.

---

## 8. Failure modes (new codepaths only)

| Codepath | Realistic failure mode | Test covers? | Error handling? | User visibility? |
|---|---|---|---|---|
| `loadEnqueueTurnContext` combined SELECT | thread missing for given talkId | Test 1 covers the happy path; needs an additional cross-talk-thread fixture for the negative case | throws via not-found path | 404 talk_not_found bubbles to the route |
| Promise.all post-loop pipelining | one of the 3 awaits throws mid-Promise.all | Test 5 (rollback) | postgres.js fails the tx; outer withUserContext rolls back | User sees the original error code (no behavior change) |

**Critical gaps:** none — all new code paths have rollback or test coverage.

---

## 9. Implementation tasks

*Estimates carried from T-new-A pattern; n=10 bench + shadow-query setup adds ~30 min vs T-new-A's n=3. May revise after A2.*

- [ ] **A1 (P1, human: ~1 h / CC: ~25 min)** — bench instrumentation: Add the 3 instrumentation commits from §4.5 (sub-phase logging, shadow combined-SELECT, postLoopSerial timing). Ship as temp deploy via wrangler.
  - Files: `accessors.ts`
  - Verify: deploy succeeds; tail shows `[t-new-a2-meta] turn` lines during a haiku bench

- [ ] **A2 (P1, human: ~45 min / CC: instant)** — measure: Run n=10 haiku bench (single-agent AND N=3) against instrumented prod. Evaluate the §4.5 two-gate matrix.
  - Files: none
  - Verify: per-sub-phase median + p95 summary; gate verdict (A passes / D passes / both / neither) in PR body

- [ ] **A3 (P1, human: ~5 min / CC: ~3 min)** — revert: `git revert` the 3 instrumentation commits. Verify clean diff vs main.
  - Files: `accessors.ts`

- [ ] **A4 (P1, human: ~1.5 h / CC: ~25 min)** — apply per §4.5 gate outcome:
  - If A passed: add `loadEnqueueTurnContext` + `EnqueueTurnContextNotFoundError` + route catch mapping; swap pre-loop SELECTs.
  - If D passed: wrap post-loop awaits in `Promise.all`.
  - If neither: STOP. Pivot to T-new-A2-followup with measured evidence.
  - Files: `accessors.ts`, `talks.ts`
  - Verify: typecheck, format:check

- [ ] **A5 (P1, human: ~2 h / CC: ~30 min)** — tests: 5 tests per §7 (only tests for paths that actually changed).
  - Files: `accessors.test.ts`
  - Verify: full vitest pass

- [ ] **A6 (P1, human: ~45 min / CC: ~15 min)** — verify: Push, wait CI, `/codex review` + `/karpathy-audit diff`, address findings, squash-merge, deploy, §4.7 bench at n=10.
  - Files: none
  - Verify: `wrangler tail` clean; `t1-t0` lands in §4.7 range (which is now conditional on §4.5 outcome)

- [ ] **A7 (P2, human: ~15 min)** — docs: Update this doc with measured numbers (r3 footer) + file T-new-A2-followup with the C-M4 per-agent attribution evidence.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Consult (plan, r1) | `/codex` consult on r1 | Independent 2nd opinion | 1 | NOT CLEAR — absorbed via r2 | 7 findings (3 HIGH, 3 MED, 1 LOW), verdict "do not ship as-is". All 7 absorbed: C-H1 explicit no-row contract + EnqueueTurnContextNotFoundError; C-H2 active-round race documented as out-of-scope; C-H3 §4.5 reworked to shadow-query A/B + n=10; C-M1 Option D softened to measured hypothesis; C-M2 outbox ordering test added (Test 4); C-M3 Test 5 rewritten to use attachment-validation path; C-M4 §4.5 extended with N=3 bench + per-agent attribution; C-L1 dropped redundant N=3 fan-out test. |
| Karpathy Audit (diff, r1) | `/karpathy-audit diff` on r1 | Style lens + four principles | 1 | CLEAR (4/4 coverage) | 1 WARNING (§4.3/§4.7 savings predictions not conditional on §4.5 — fixed in r2 with conditional rewrite); 3 NITs (deferred options verbosity left as-is for follow-up readers; PR title dropped from §6; estimates annotated). |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | not run | This plan IS the architecture; codex consult covered the equivalent ground at higher rigor. |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (perf fix, scope self-evident) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (backend-only) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

**CODEX (r1 → r2):** 7 findings reshape the plan. Critical catches: (C-H1) combined SELECT silently changes missing-thread behavior — explicit error class added. (C-H2) active-round race is preserved by Option A — documented out of scope. (C-H3) original §4.5 gate didn't prove the combined query was faster, only that the old SELECTs were slow — reworked to shadow-query A/B with n=10. (C-M1) Promise.all pipelining inside async-callback is under-specified — softened from "well-understood" to "measured hypothesis." (C-M3) Test 5's rollback trigger was unimplementable as described — rewritten to use the existing attachment-validation path. **Response:** keep scope (A+D); add a real measurement gate that can FAIL the plan; tighten test discipline to changed behavior only.

**KARPATHY (r1 → r2):** 1 WARNING (savings predictions in §4.3/§4.7 not honestly conditional on §4.5 gate) absorbed via conditional rewrite. 3 NITs absorbed where actionable.

**CROSS-MODEL:** Codex caught behavioral correctness (SELECT no-row semantics, pipelining claims, test feasibility); Karpathy caught artifact-level honesty (the savings prediction was confident before the gate that validates it). Zero direct finding overlap. Validates [[feedback-codex-catches-behavior-karpathy-catches-style]] for plan-stage review too.

**UNRESOLVED:** 0. All codex findings absorbed; Karpathy NIT 2 (deferred-options verbosity) left as-is by taste (follow-up plan readers need the risk context).

**VERDICT:** **CLEARED (PLAN, r2)** — narrowed by codex's 3 HIGH findings into a plan with a real failure mode (the §4.5 gate can refuse the dedupe). Critical constraints to remember during implementation:
1. `loadEnqueueTurnContext` MUST throw `EnqueueTurnContextNotFoundError` (not a generic postgres error) when the combined SELECT returns no rows. Route catch maps to 404.
2. Active-round race (C-H2) is OUT OF SCOPE here. Document it in the commit message; don't try to fix it.
3. §4.5 instrumentation ships THREE commits: sub-phase logs, shadow combined-SELECT, postLoopSerial timing. Compare actual deltas, not absolute time of the OLD path.
4. Bench at n=10, not n=3. Include N=3 multi-agent run for C-M4 per-agent attribution.
5. If §4.5 "Neither passes" outcome: STOP at A3. Don't ship the dedupe; file T-new-A2-followup with measured evidence instead.
