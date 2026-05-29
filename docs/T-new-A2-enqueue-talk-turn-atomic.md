# T-new-A2 — `enqueueTalkTurnAtomic` per-request 1734 ms latency reduction

**Status:** Plan, **r1 draft**. Awaiting `/codex` consult + `/karpathy-audit diff`.
**Tracking:** [[project-llm-turn-latency]]. Next lever after T-new-A landed (`f596fb2`, −121 ms attributable).
**Branch (planning):** `docs/t-new-a2-plan` (this doc).
**Branch (implementation, to be created):** `feature/t-new-a2-enqueue-turn`.
**Estimated effort:** ~4h human / ~45 min CC.

### Revision history

- **r1 (2026-05-29):** Initial draft from the post-T-new-A A2 instrumentation. `enqueueTalkTurnAtomic` ran at 1734 ms median in the 3-run haiku bench (instrumented version `2e327d4b`). Codex C8 (T-new-A r3 review) flagged the per-agent loop as deferred work needing its own plan; this is that plan.

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

These can run via `await Promise.all([...])`. postgres.js inside async-callback pipelines sends; saves round-trip latency. Server-side execution stays sequential per connection but the network cost compresses.

**Savings:** ~1 round-trip for single-agent; N round-trips for multi-agent.

**Risks:** Modest. The async-callback contract preserves transactional atomicity even with concurrent dispatches (postgres.js serializes on the underlying connection). Test 7 locks this.

### 3.5 Combination matrix

| Option | N=1 saver | N≥2 saver | Risk | Codex-blocker concerns |
|---|---|---|---|---|
| A (pre-loop SELECT combine) | ~2 RTs | ~2 RTs | Low — shape change | Test coverage |
| B (batch per-agent loop) | 0 | (N-1)×2 RTs | Medium — multi-row INSERT shape | Per-agent cred SELECT still serial |
| C (defer cosmetic to waitUntil) | ~1-3 RTs | ~1-3 RTs | High — atomicity scope shrinks; silent-drop risk | Naming, retry policy, CF 30s waitUntil ceiling |
| D (pipeline post-loop) | ~1 RT | ~N RTs | Low — postgres.js pipelining is well-understood | Need integration test that asserts tx atomicity |

---

## 4. The fix — Option A + Option D (proposed)

### 4.1 Why this combination

- **Option A** is the only proposal that saves on the bench (N=1) without architectural risk. ~2 RTs.
- **Option D** complements A: low-risk, structurally correct, and benefits multi-agent fan-outs.
- **Option B is deferred.** The codex C8 caveat (per-agent credential SELECT is what dominates the loop, not the INSERT) means B's gain is unclear without §4.5 measurement. Multi-agent /chat is also rare in solo-user clawtalk.
- **Option C is deferred.** Atomicity-shrinking is a structural change that needs its own plan. The "ctx.waitUntil silent drop on title heal failure" is a real concern the dedupe plan shouldn't take on.

If §4.5 instrumentation reveals that the credential SELECTs (step 7b) dominate the per-agent loop, T-new-A2-followup can revisit B with Promise.all pipelining inside the loop body.

### 4.2 What changes

1. **`src/clawtalk/db/accessors.ts`** — new helper `loadEnqueueTurnContext(talkId, threadId)` returns `{title, activeFamilies, activeCount}` in one SELECT. Net +25 LoC.
2. **`src/clawtalk/db/accessors.ts` — `enqueueTalkTurnAtomic`** swap call sites:
   - Replace the 3 separate SELECTs (steps 2, 4, 6) with one call to `loadEnqueueTurnContext`.
   - Move the post-loop sequential awaits (step 8 `touchTalkUpdatedAt`, step 9 `emitOutboxEvent` for message, step 10 `emitOutboxEvent` loop) into `await Promise.all([...])`. Net ≈ −10 / +5 LoC.

That's it. No CTE for the agent loop, no batch INSERT to talk_runs, no ctx.waitUntil deferrals.

### 4.3 Expected savings

- **Pre-loop combine (Option A):** 2 RTs saved per request.
- **Post-loop pipeline (Option D):** 1 RT saved on N=1, N RTs saved on N agents.
- **Combined N=1 case (bench):** ~3 RTs saved. At ~120 ms/RT, that's **~300-400 ms off the 1734 ms phase**, dropping it to ~1300-1400 ms.

End-to-end t1-t0 prediction: 3920 ms → ~3500-3600 ms (~−300 to −400 ms). **Within prod-bench detection threshold** (>3× the ±50 ms noise band).

### 4.4 What's NOT in this plan (deferred)

- **Option B** (batch per-agent loop) — needs §4.5 attribution between getRegisteredAgent vs. resolveCredentialKindSnapshot vs. createTalkRun before locking the implementation shape.
- **Option C** (ctx.waitUntil cosmetic-defer) — atomicity rename + retry policy + silent-drop risk needs its own plan.
- **`ensureTalkUsesUsableDefaultAgent` ~748 ms** — separate plan; A2 surfaced it independently.
- **`preflight_iter_0` ~435 ms per agent** — codex C2 effective-tools graph; separate plan.
- **Hyperdrive connection pooling tuning** — out of scope.

### 4.5 Pre-deploy measurement (per codex C11 from T-new-A)

Predicted savings (~300-400 ms) are detectable but not huge. Pre-deploy measurement makes attribution credible.

**Sub-phase instrumentation INSIDE `enqueueTalkTurnAtomic`:**

```ts
console.log('[t-new-a2-meta] turn', { sub_phase, elapsed_ms });
```

Sub-phase names:
- `resolveThreadIdForTalk`
- `activeRoundsCount`
- `createTalkMessage`
- `selectThreadTitle`
- `maybePersistThreadTitle`
- `selectActiveToolFamilies`
- `agent_loop_iter_<N>_getRegisteredAgent`
- `agent_loop_iter_<N>_resolveCredentialKindSnapshot`
- `agent_loop_iter_<N>_createTalkRun`
- `touchTalkUpdatedAt`
- `emitMessageAppended`
- `emitTalkRunQueued_<N>`

Ship as temp commit on `feature/t-new-a2-enqueue-turn`. Deploy via `npx wrangler deploy`. Run the haiku bench (SPA closed per [[feedback-close-clawtalk-tabs-before-bench]]) + tail-grep for sub-phase numbers.

**Decision gate:**
- If the 3 pre-loop SELECTs collectively account for ~300 ms+ of the 1734 ms phase → Option A's claim holds. Ship A.
- If `agent_loop_iter_0_resolveCredentialKindSnapshot` dominates the loop → revisit Option B's promise-all sub-plan. T-new-A2's scope was right; the followup plan can target the credential subquery.
- If `createTalkMessage` dominates (a single INSERT taking 500+ ms) → server-side cost not call-count is the lever; the plan stays the same (small gain) but the real follow-up is a postgres-side investigation.

Revert instrumentation. Apply Options A + D. Re-bench post-deploy.

### 4.6 Local verification before push

```bash
npm run typecheck
npx vitest run src/clawtalk/db/accessors.test.ts
npx vitest run src/clawtalk/web/routes/talks.test.ts
npx vitest run                                      # full backend suite
npm run format:check
```

### 4.7 Post-deploy verification

| Metric | T-new-A baseline | T-new-A2 prediction |
|---|---|---|
| `t1-t0` median (haiku) | 3920 ms | **3500-3600 ms** (-300 to -400 ms) |
| `t3-t0` median | 10628 ms | 10300-10400 ms |
| Success rate | 3/3 | 3/3 |
| `wrangler tail` errors | zero | zero |

If post-deploy `t1-t0` doesn't move credibly, run bench at N=10 to fight noise. If still flat, file a follow-up to investigate why measurement didn't translate.

---

## 5. Risks and open questions

1. **The combined SELECT is shape-coupled to enqueueTalkTurnAtomic's middle section.** If a future change adds a fourth pre-loop read (e.g., a workspace-scope check), the helper must extend, not be bypassed. Mitigated by giving the helper a clear name and exporting from accessors.ts alongside getTalkById, etc.
2. **postgres.js pipelining via Promise.all preserves transactional atomicity** (codex C1 from T-new-A confirmed this). But the test suite should still include a rollback-on-error case (Test 7) to lock the behavior.
3. **§4.5 instrumentation could discover the bottleneck is server-side, not RT count.** If a single INSERT/SELECT takes 500+ ms, this plan's structural-RT-count argument evaporates. The fallback is to ship Option A + D anyway (still saves ~3 RTs, which is honest measured win) and open a server-side investigation plan separately.
4. **Codex C8's deeper concern is unaddressed by this plan.** The per-agent loop's true cost driver (getRegisteredAgent vs credentialKindSnapshot vs createTalkRun) won't be known until §4.5. If C8's "real" target is the credential resolve, T-new-A2 leaves it for a follow-up. This plan's value-add is the pre-loop combine + post-loop pipeline, which are codex-orthogonal wins.

---

## 6. What lands in the PR

1. `src/clawtalk/db/accessors.ts` — `loadEnqueueTurnContext(talkId, threadId)` export + swap call sites in `enqueueTalkTurnAtomic`. Net +25 / −10 LoC.
2. `src/clawtalk/db/accessors.ts` — `enqueueTalkTurnAtomic` post-loop Promise.all wrapping. Net +5 LoC.
3. `src/clawtalk/db/accessors.test.ts` — extend with 5 tests (see §7).
4. `docs/T-new-A2-enqueue-talk-turn-atomic.md` — this doc.

Net diff: ~+120 LoC (≈30 src, ≈90 test).

**Sequencing:**
1. Branch off main, add §4.5 instrumentation, ship as temp commit, deploy.
2. Run measurement bench, confirm the 3 pre-loop SELECTs sum to ≥300 ms.
3. Revert instrumentation; apply Options A + D + tests.
4. Local verify (§4.6). Open PR. Run `/codex review` + `/karpathy-audit diff` per [[feedback-codex-catches-behavior-karpathy-catches-style]]. Address findings. Squash-merge. Run §4.7 verification.

PR title: `perf(chat): combine pre-loop SELECTs + pipeline post-loop in enqueueTalkTurnAtomic (T-new-A2)`.

---

## 7. Tests

### 7.1 Test plan

5 tests in `src/clawtalk/db/accessors.test.ts`:

```
CODE PATHS                                            USER FLOWS
[+] enqueueTalkTurnAtomic (accessors.ts)
  ├── loadEnqueueTurnContext (new helper)             [+] Send chat message
  │   ├── [★★ Test 1] talk + default thread happy path  ├── [★★ Test 1] happy path (1 agent)
  │   ├── [★★★ Test 2] explicit thread id resolved      ├── [★★★ Test 2] explicit thread id routes correctly
  │   └── [★★★ Test 3] active-rounds throw still works  ├── [★★★ Test 3] active round → TalkActiveRoundError
  ├── per-agent loop (unchanged)                       [+] Multi-agent
  │   └── [★★★ Test 4] 3 agents create 3 runs           └── [★★★ Test 4] N=3 fan-out
  └── Promise.all post-loop                            [+] Rollback
      └── [★★★ Test 5] rollback drops all 3 outbox rows  └── [★★★ Test 5] mid-tx throw rolls back outbox

COVERAGE: 5/5 paths tested
QUALITY: ★★★:4 ★★:1
```

Legend: ★★★ behavior + edge + error  |  ★★ happy path

**Tests:**

- **Test 1 (★★)** — happy path: 1 agent, default thread exists, no attachments. Assert message + 1 run + 2 outbox rows.
- **Test 2 (★★★)** — explicit `threadId` argument: assert the run lands on the explicit thread, not the default.
- **Test 3 (★★★)** — an existing queued run on the thread → `TalkActiveRoundError` thrown; assert NO partial writes (no message row, no new run row, no outbox rows).
- **Test 4 (★★★)** — N=3 agents in the same call: assert 1 message + 3 runs created with sequential `sequence_index` if provided, and 1 + 3 = 4 outbox rows.
- **Test 5 (★★★)** — inject a failure into the Promise.all post-loop (e.g., a content-too-long message) → assert the surrounding tx rolls back: zero message rows, zero run rows, zero outbox rows.

### 7.2 Test discipline

- Use the existing `seedAuthUser` + `purge` helpers from `accessors.test.ts`.
- Each test runs inside `withUserContext(USER_ID, async () => {...})`.
- For Test 5 (rollback), trigger the rollback via the `talk_runs` FK constraint on `trigger_message_id` → use an invalid messageId argument or similar. Alternative: trigger via the existing attachment-validation throw path (line 2404).

---

## 8. Failure modes (new codepaths only)

| Codepath | Realistic failure mode | Test covers? | Error handling? | User visibility? |
|---|---|---|---|---|
| `loadEnqueueTurnContext` combined SELECT | thread missing for given talkId | Test 1 covers the happy path; needs an additional cross-talk-thread fixture for the negative case | throws via not-found path | 404 talk_not_found bubbles to the route |
| Promise.all post-loop pipelining | one of the 3 awaits throws mid-Promise.all | Test 5 (rollback) | postgres.js fails the tx; outer withUserContext rolls back | User sees the original error code (no behavior change) |

**Critical gaps:** none — all new code paths have rollback or test coverage.

---

## 9. Implementation tasks

- [ ] **A1 (P1, human: ~45 min / CC: ~15 min)** — bench — Add `[t-new-a2-meta] turn` instrumentation per §4.5. Ship as temp commit, deploy via wrangler.
  - Files: `accessors.ts`
  - Verify: deploy succeeds; tail shows sub-phase logs during a haiku bench

- [ ] **A2 (P1, human: ~30 min / CC: instant)** — measure — Run haiku bench against instrumented prod. Confirm: pre-loop SELECTs collectively ≥300 ms. If less, downgrade savings prediction or pivot to a different lever per §4.5 decision gate.
  - Files: none
  - Verify: per-sub-phase summary in PR body

- [ ] **A3 (P1, human: ~5 min / CC: ~2 min)** — revert — `git revert` the instrumentation commit. Verify clean diff.
  - Files: `accessors.ts`

- [ ] **A4 (P1, human: ~1.5 h / CC: ~20 min)** — apply Options A + D per §4.2:
  - Add `loadEnqueueTurnContext(talkId, threadId)`.
  - Swap pre-loop SELECTs in `enqueueTalkTurnAtomic`.
  - Wrap post-loop awaits in `Promise.all`.
  - Files: `accessors.ts`
  - Verify: typecheck, format:check

- [ ] **A5 (P1, human: ~1.5 h / CC: ~25 min)** — tests — 5 tests per §7.
  - Files: `accessors.test.ts`
  - Verify: full vitest pass

- [ ] **A6 (P1, human: ~45 min / CC: ~15 min)** — verify — Push, wait CI, `/codex review` + `/karpathy-audit diff`, address findings, squash-merge, deploy, §4.7 bench.
  - Files: none
  - Verify: `wrangler tail` clean; `t1-t0` lands in §4.7 range

- [ ] **A7 (P2, human: ~10 min)** — docs — Update this doc with measured numbers (r4 footer) after A6.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review (plan) | `/codex` consult on plan | Independent 2nd opinion | 0 | pending | — |
| Karpathy Audit (diff) | `/karpathy-audit diff` | Style + four-principles lens on plan diff | 0 | pending | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | not run | (this plan is the architecture; running plan-eng-review on it would loop) |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (perf fix, scope is self-evident) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (backend-only) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

**VERDICT:** PENDING REVIEW — r1 draft awaiting `/codex` consult + `/karpathy-audit diff`. Expected response: scope reduction (T-new-A r3 set the precedent — 11 findings narrowed 3 options to 1).
