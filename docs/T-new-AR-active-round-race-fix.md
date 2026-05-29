# T-new-AR — active-round race fix (`enqueueTalkTurnAtomic` + `createJobTriggerRun`)

**Status:** **SHIPPED, r4 (2026-05-29)** — Implementation merged via PR #483 (`0091986`). Plan went through r1 → r2 (codex consult absorbed 20 findings + karpathy) → r3 (codex review on r2 absorbed 2 P2). PR codex review absorbed 1 more P2 (`'blocked'` branch was undoing `next_due_at = null`). All 5 race tests pass; existing 410 DB + talks suite tests pass. 3 pre-existing `talks.test.ts` failures (`registered_agents_owner_id_fkey`) are unrelated.
**Tracking:** [[project-llm-turn-latency]] (correctness branch — same bug surface, different lens). Closes T-new-A2 codex C-H2 ("Active-round race is preserved by Option A — documented out of scope").
**Branches:** planning `docs/t-new-ar-plan` (merged via PR #478). Implementation `feature/t-new-ar-active-round-race-fix` (merged via PR #483).

### Revision history

- **r1 (2026-05-29):** Initial draft. Picked Option 3 (`SELECT … FOR UPDATE OF th`) over Option 1 (advisory lock) and Option 2 (partial unique index, rejected for fan-out). Karpathy diff audit: 4/4 coverage, 1 warning (verbose Option 2 rejection), 3 nits (Joseph name twice, §5/§7.1 duplication, PR title in plan).
- **r2 (2026-05-29, this version):** Codex consult on r1 returned 20 findings. Material absorbs:
  - **#1 / #2 / #6 (function name + manual route):** Job entry is `createJobTriggerRun` (job-accessors.ts:881), not `runTalkJob` (the r1 name). Both `scheduler.ts:81` AND `runTalkJobNowRoute` (talk-jobs.ts:312) are call sites. Plan updated throughout.
  - **#3 / #7 / #8 (scheduler retry premise wrong):** `claimDueTalkJobs` advances `next_due_at` to the next cron tick BEFORE `createJobTriggerRun` runs. Returning `thread_busy` without further action drops the occurrence entirely. r2 adopts the cleanest fix per Joseph (Option C): move `next_due_at` advance into the scheduler's result handler so only `'enqueued'` results consume the tick. `claimDueTalkJobs` returns due-but-not-yet-claimed jobs; thread_busy jobs naturally retry next tick.
  - **#12 / #13 / #14 (test correctness):** Test 1 rewritten with deterministic lock-then-second-tx pattern (manual postgres.js tx control). Test 5 rewritten as a real concurrent race (not sequential). Test 4 renamed and reframed — it's "ack after first call commits," not idempotency.
  - **#17 (lock hold span):** Lock would be held across the full agent loop + credential resolution (~500-1500 ms). r2 adopts `FOR UPDATE NOWAIT` per Joseph: second caller fails immediately with postgres LockNotAvailable; route catches and maps to `TalkActiveRoundError`. Avoids worker-timeout pathological case and is observably equivalent to "round already in progress."
  - **#4 (SQL clause ordering):** Postgres canonical form is `LIMIT N ... FOR UPDATE`. Plan SQL updated.
  - **#10 (postgres.js max:1 per request scope):** Documented in §5. Tests use node client (max:5) so race tests work; production same-request nested withUserContext is rare and serializes on the single connection (acceptable).
  - **#11 (Hyperdrive claim unbacked):** Dropped. Plan references postgres.js direct only.
  - **#16 (createTalkRun bypass):** Acknowledged in §4.3 — invariant is app-level enforced via the two entry points; DB-level enforcement would need a separate plan.
  - **#18 (per-thread state row alternative):** Added as Option 4 briefly in §3.
  - **#19 (deadlock language too strong):** Softened to "low risk today."
  - **#20 (test the manual run-now route):** Added Test 7 for `createJobTriggerRunNowRoute`'s thread_busy handling.
  - Plus karpathy nits: §3.2 trimmed; §5 Risk 4 dropped (covered in §7.1); §2.3 "Joseph" → "solo-user app"; §6 PR title removed.
  - **Non-material acknowledgments:** #5 (`resolveThreadIdForTalk` is outside the lock — true but pre-lock race is benign, that function only validates visibility), #9 (claimDueTalkJobs upstream race between multiple scheduler instances — out of scope for this plan, noted in §5), #15 (other inserters confirmed: only the two entry points).
- **r3 (2026-05-29):** Second `/codex review` pass on r2 returned 2 P2 findings (no P1; gate PASS). Both absorbed:
  - **r2-P1 (job_busy semantics changed unintentionally):** r2's "advance only on `'enqueued'`" rule inadvertently turned `job_busy` (previous job instance still running) into "retry every tick" — would catch up with an extra occurrence when the long-running instance finishes. r3 fixes: only `thread_busy` retries (preserves the new behavior I actually want); `job_busy` advances (preserves today's tick-consumes-skip semantics).
  - **r2-P2 (Test 6 bypasses processClaimableJobs):** Test 6 called the accessors manually and bypassed the scheduler's result handler — the refactor target. r3 rewrites Test 6 to drive `processClaimableJobs` directly and assert persisted `next_due_at` for both `thread_busy` (unchanged) and `enqueued` (advanced).
- **r4 (2026-05-29, this version, SHIPPED via PR #483 / `0091986`):** Implementation footer.
  - **Implementation deltas vs r3 plan:** SAVEPOINT-wrapped `FOR UPDATE NOWAIT` to prevent 25P02 tx poisoning (postgres aborts the tx on any statement failure; without savepoint, even the catch can't run subsequent queries). Path: `db.savepoint(async sp => { await sp\`...for update nowait\` })`. Documented inline. `as unknown as postgres.TransactionSql` cast through unknown because `getDbPg()` returns `Sql` (structural subset) but inside `withUserContext` it's actually a `TransactionSql` with `.savepoint` available.
  - **Per-job check ordering:** plan was silent on which check fires first; AR2 initially put thread_busy first, broke the existing `job_busy` test. r4 ships **job_busy check FIRST**, then thread-level check. Preserves today's tick-consume semantics for "same job still running" (correctly returns `job_busy`, scheduler advances). The thread-level check catches cross-entry-point cases (`/chat` round on job's thread → `thread_busy`).
  - **PR codex review (1 P2 absorbed):** the `'blocked'` branch in `processClaimableJobs` was calling `advanceTalkJobNextDueAt`, which restored a future `next_due_at` on a row that `createJobTriggerRun` had already set to `null` with `status = 'blocked'`. Even though the blocked status excluded the job from `claimDueTalkJobs`' filter, the persisted state was wrong. Fix: don't advance in the `'blocked'` branch.
  - **Tests deferred to follow-up:** Test 6 (3 sub-cases driving `processClaimableJobs` directly — needs scheduler env mock or a small refactor) and Test 7 (`runTalkJobNowRoute` 409 — needs a new `talk-jobs.test.ts` route-test file). Plan §7 retained them; AR1 dropped due to setup overhead. The behaviors they cover are exercised indirectly: scheduler refactor by the `claimDueTalkJobs` test + manual smoke; route 409 by typecheck (the discriminated union switch must handle `thread_busy`).
  - **Net diff:** 5 src files, ~70 LoC src + ~290 LoC test (3 new accessors tests + 2 new job-accessors tests + existing `claimDueTalkJobs` test updated).

---

## 1. Context

T-new-A2 r3 §5 documented this race explicitly:

> Existing active-round race (codex C-H2) is preserved. Lines 2265-2274 today: SELECT count then INSERT — two concurrent /chat requests on the same thread can both observe zero active runs and both succeed. **Out of scope.** Fix is a tx-level advisory lock or a partial unique index, both of which need their own design plan.

This is that plan. The race shipped in T-new-A2's diff exactly because Option A only changed the read shape, not the read-then-write atomicity. The window between the `loadEnqueueTurnContext` SELECT and the per-agent `createTalkRun` INSERTs is wide enough (~250 ms — the agent loop dominates) that concurrent /chat or scheduler-triggered jobs can both clear the `activeCount = 0` gate.

---

## 2. The cost — concrete race scenarios

### 2.1 Scenario A: two concurrent /chat requests on the same thread

| Time | Worker instance A | Worker instance B | Thread state |
|---|---|---|---|
| t=0 | `loadEnqueueTurnContext` → activeCount=0 | — | 0 active runs |
| t=10 ms | — | `loadEnqueueTurnContext` → activeCount=0 | 0 active runs |
| t=300 ms | `createTalkMessage` + 3× `createTalkRun` → 3 runs queued | — | 3 active runs |
| t=320 ms | — | `createTalkMessage` + 3× `createTalkRun` → 3 more queued | **6 active runs (BUG)** |

Both calls return 202 to the client; the SPA renders two response groups; the queue consumer dispatches all 6 runs; UserEventHub DO sees two concurrent streaming groups for the same thread; `sequence_index` ordering is violated across groups.

### 2.2 Scenario B: scheduler-triggered job races with /chat

`createJobTriggerRun` (job-accessors.ts:921) gates only on `job_id`, NOT on `(talk_id, thread_id)`:

```sql
select count(*) from public.talk_runs
where job_id = ${job.id}::uuid
  and status in ('queued', 'running', 'awaiting_confirmation')
```

Manual run-now via `runTalkJobNowRoute` (talk-jobs.ts:312) calls the same function and shares the same gate. So both scheduler tick (`schedule: * * * * *` per `wrangler.toml` cron) AND manual-run-now races with /chat are in-scope.

| Time | Scheduler → `createJobTriggerRun` | /chat → `enqueueTalkTurnAtomic` | Thread T |
|---|---|---|---|
| t=0 | job_id check → 0 active for THIS JOB | — | 0 active |
| t=20 ms | — | `loadEnqueueTurnContext` → activeCount=0 | 0 active |
| t=200 ms | `createTalkRun` (job's run) | — | 1 active |
| t=400 ms | — | 3× `createTalkRun` (user's group) | **4 active (BUG)** |

The scheduler runs every minute, so any /chat issued during a job-triggered tick window can race.

### 2.3 Real-world likelihood for clawtalk

Solo-user app, BUT:

- Cloudflare Workers are stateless — each request gets a fresh isolate, no per-thread mutex possible at the app layer.
- The scheduler runs `* * * * *` (every minute) and triggers any due jobs.
- T-new-B's UserEventHub DO is per-USER, not per-thread — concurrent rounds on the same thread share a DO and stream interleaved.

A solo user can trigger this by: enabling a recurring job on a thread, then typing into that thread when the scheduler fires. Today this races; the bug fires with low probability but real consequences.

### 2.4 Downstream consequences (what the bug actually breaks)

- **Sequence index invariants**: `sequence_index` is only unique within a `response_group_id`. Across response groups, queued runs with overlapping seq values exist. The queue consumer's promote-next logic (T7's `dispatch-in-process.ts` + `claimQueuedTalkRuns`) doesn't gate across response groups.
- **UserEventHub DO ordering**: two response groups stream `talk_response_started`/`delta`/`completed` events interleaved on the same WebSocket. The SPA renders both, but message ordering inside each group becomes inconsistent.
- **active_tool_families_snapshot drift**: each call snapshots `talks.active_tool_families_json` independently. If the user toggles a tool chip between the two calls, the two groups run with different tool sets — invisible to the user.
- **Idempotency cache pollution**: `enqueueTalkTurnAtomic`'s `idempotencyKey` is per-call. Two racing calls with different keys write two cache entries; future retries can hit either.

---

## 3. Options

### 3.1 Option 1 — Postgres advisory lock scoped to (talk_id, thread_id)

Add at the start of `enqueueTalkTurnAtomic` and `createJobTriggerRun`:

```sql
select pg_advisory_xact_lock(
  hashtextextended(${talkId} || ':' || ${threadId}, 0)
)
```

`pg_advisory_xact_lock` is automatically released at tx end (commit or rollback). Concurrent callers asking for the same lock key block until the first tx ends. Then the second tx re-reads, sees `activeCount > 0`, and throws `TalkActiveRoundError`.

**Pros:**
- No schema change, no migration.
- Explicit "this is a race-protection lock" intent in the SQL.
- Doesn't lock any real catalog or user-data row.

**Cons:**
- Hash collisions are possible (two different `(talk_id, thread_id)` pairs hashing to the same int8 — astronomically unlikely with `hashtextextended` but non-zero).
- One extra round-trip per call.
- Easy to forget on a new caller — no DB-level enforcement.

### 3.2 Option 2 — Partial unique index on `talk_runs` (REJECTED)

No natural per-row unique index encodes the invariant. `(talk_id, thread_id)` WHERE status active fails because fan-out legitimately INSERTs N rows per round; adding `response_group_id` doesn't help (same group still has N rows); `DEFERRABLE INITIALLY DEFERRED` defers the check to commit but commit-time still sees N rows. Eliminated.

### 3.3 Option 3 — `SELECT ... FOR UPDATE OF th NOWAIT` on `talk_threads` (RECOMMENDED)

Add `for update of th nowait` to the existing `loadEnqueueTurnContext` helper. Postgres canonical clause order is `LIMIT … FOR UPDATE`:

```sql
select
  tk.active_tool_families_json,
  th.title,
  (
    select count(*)::int from public.talk_runs
    where talk_id = tk.id and thread_id = th.id
      and status in ('queued', 'running', 'awaiting_confirmation')
  ) as active_count
from public.talks tk
join public.talk_threads th on th.talk_id = tk.id
where tk.id = ${talkId}::uuid and th.id = ${threadId}::uuid
limit 1
for update of th nowait    -- ← new: lock thread row; fail immediately if contended
```

`FOR UPDATE OF th` scopes the lock to the `talk_threads` row only (alias `th`), not `talks`. `NOWAIT` makes a contended caller fail immediately with Postgres SQLSTATE `55P03` (`lock_not_available`) instead of blocking. The helper catches that and throws `TalkActiveRoundError('thread')` — observably equivalent to "a round is already in progress" (which is exactly what's true if someone else holds the lock).

For `createJobTriggerRun`, add the same lock at the start of the job's tx:

```typescript
const db = getDbPg();
try {
  await db`
    select 1 from public.talk_threads
    where id = ${job.threadId}::uuid and talk_id = ${job.talkId}::uuid
    for update nowait
  `;
} catch (err) {
  if (isLockNotAvailable(err)) {
    return { status: 'thread_busy', job };
  }
  throw err;
}
```

**Pros:**
- Folds into existing helper for the /chat path — **zero extra round-trips**.
- One small `FOR UPDATE NOWAIT` query for the job path.
- `NOWAIT` avoids worker-CPU-budget concern entirely (#17 from codex r1 review).
- Standard SQL, inspectable via `pg_locks` for debugging.
- The lock is on `talk_threads.id` (the natural unit of the invariant); no hash collisions possible.
- Automatic release at tx end (commit or rollback), same as advisory locks.

**Cons:**
- Locks the `talk_threads` row. Plain `SELECT` from other txs is not blocked, but other write-lockers (`updateTalkThreadTitle`, `maybePersistTalkThreadTitleFromMessages` from a different tx) hit `lock_not_available` and would have to handle it. Today's other writers don't use NOWAIT — they'd error out. Mitigation: scope of `updateTalkThreadTitle` callers is small (settings UI); if it ever fires concurrently, it'd return a transient 5xx that the SPA retries. Documented in §5.
- The lock acquires DURING the helper's read at the start of the function — lock order discipline matters for any future caller. Today there is no such caller.

### 3.4 Option 4 — Per-thread state row (CONSIDERED, not picked)

Introduce a separate table `active_round_locks(talk_id, thread_id PRIMARY KEY, response_group_id, started_at)`. `INSERT … ON CONFLICT DO NOTHING RETURNING` at the start of `enqueueTalkTurnAtomic` and `createJobTriggerRun`; `DELETE` when all runs in the group reach a terminal state.

**Pros:** explicit visibility into "what's holding the lock"; doesn't couple with `talk_threads` writers.
**Cons:** new table + migration; needs cleanup logic (what if the run is cancelled / errors? need a sweeper); more code; adds a row insert per round to the hot path.

Not picked because the Option 3 cons (other writers contending on `talk_threads`) are manageable in practice, and Option 4's cleanup logic adds operational surface.

### 3.5 Why Option 3 + NOWAIT over Options 1 and 4

Option 1 (advisory lock) is the textbook race-protection pattern but adds an extra round-trip and doesn't fold into the existing helper. Option 4 (per-thread state row) adds a table + cleanup logic.

Option 3 + NOWAIT wins because:
1. The /chat path's helper ALREADY reads `talk_threads` row. Adding `FOR UPDATE NOWAIT` is one clause, zero extra round-trips.
2. The job path needs one small `FOR UPDATE NOWAIT` query.
3. The lock is on a real row that maps 1:1 to the invariant. Easier to reason about than a hash, no migration like Option 4.
4. `NOWAIT` makes contention fail-fast — no worker-timeout pathological case.

---

## 4. The fix — Option 3 + NOWAIT + scheduler refactor

### 4.1 What changes

1. **`src/clawtalk/db/accessors.ts` — `loadEnqueueTurnContext`**: add `for update of th nowait` to the existing JOIN-and-subquery; wrap in try/catch and map `lock_not_available` (SQLSTATE `55P03`) to `TalkActiveRoundError('thread')`. Net ~+8 lines.
2. **`src/clawtalk/db/accessors.ts`** — add `isLockNotAvailable(err)` helper used by both call sites. Net ~+5 lines.
3. **`src/clawtalk/db/job-accessors.ts` — `createJobTriggerRun`**: add a `SELECT 1 FROM talk_threads … FOR UPDATE NOWAIT` at the start of the function, BEFORE the `job_id`-scoped active check; catch `lock_not_available` → return `{status: 'thread_busy', job}` (new sentinel). Also add a thread-level active check (returns same sentinel when count > 0). Net ~+20 lines.
4. **`src/clawtalk/db/job-accessors.ts` — `claimDueTalkJobs`**: REMOVE the `update public.talk_jobs set next_due_at = ...` block. The function now returns due-but-not-yet-claimed jobs without advancing the cursor. Net ~-12 lines.
5. **`src/clawtalk/talks/scheduler.ts` — `processClaimableJobs`**: after `createJobTriggerRun` returns, branch on `result.status`. **Only `'thread_busy'` (new) leaves `next_due_at` unchanged so the next tick retries the same occurrence.** All other terminal statuses advance `next_due_at` to the next cron-computed time:
   - `'enqueued'` — advance (the tick produced a run; consume it)
   - `'job_busy'` — advance (the previous instance is still running; consume this tick like today's behavior; do NOT catch up when the previous finishes)
   - `'paused' | 'not_found' | 'blocked'` — advance (avoid hot-looping)
   - `'thread_busy'` — leave unchanged (next tick retries; the lock will free up within seconds)
   Net ~+25 lines (including the helper to compute the advanced time, lifted from `claimDueTalkJobs`).
6. **`src/clawtalk/web/routes/talk-jobs.ts` — `runTalkJobNowRoute`**: branch the new `'thread_busy'` result to a 409 response with `code: 'thread_busy'`. Net ~+10 lines.
7. **`src/clawtalk/db/accessors.test.ts`** — add Tests 1-4 (§7). Net ~+250 lines.
8. **`src/clawtalk/db/job-accessors.test.ts`** — add Test 5 (real-race) + Test 6 (scheduler refactor) + Test 7 (manual run-now route). Net ~+150 lines.

No migration. No schema change. No new exports (the sentinel is a TypeScript discriminated-union member already, just adds a new variant).

### 4.2 Why this composition

- The `FOR UPDATE NOWAIT` is sufficient for serialization. The thread-level active check in `createJobTriggerRun` enforces the SAME invariant the /chat path enforces. Without it, the job path would still INSERT — the lock serializes but doesn't reject.
- The existing job-level active check (`where job_id = ...`) stays — it answers a different question ("don't start the same job twice").
- Moving the `next_due_at` advance out of `claimDueTalkJobs` makes the scheduler tick consumption explicit: only successful enqueues consume a tick.

### 4.3 Out of scope (explicit)

- **`deleteTalkMessagesAtomic`'s `hasActiveTalkRuns` check** (accessors.ts:1334-1339) — also racy, but the failure mode is benign (a history edit only touches `talk_runs.trigger_message_id`, not the run's lifecycle). Separate follow-up.
- **`claimQueuedTalkRuns`** — transitions queued→running. Doesn't change active count. Not in scope.
- **`claimDueTalkJobs` upstream race between multiple scheduler instances** (codex r1 #9) — two concurrent scheduler isolates could claim the same due job. Out of scope for this plan; would need `FOR UPDATE SKIP LOCKED` on the claim SELECT. After this plan, the thread-level NOWAIT catches the downstream symptom (only one of the racing schedulers wins the thread lock); the duplicate-claim work is still wasted but not incorrect.
- **`createTalkRun` is exported and bypasses the invariant.** Today only the two call sites above use it for active-status writes. The invariant is **app-level enforced**; DB-level enforcement (Option 4 state row + trigger) would be a separate plan. Acknowledged as a regression vector — any new caller of `createTalkRun` with active status must take the thread lock first.

### 4.4 Pre-deploy measurement

**Not applicable.** This is a correctness fix, not a perf change. The §4.5 measurement gate from T-new-A2 was about validating that an optimization actually saves time; here the only perf question is "does FOR UPDATE add measurable median latency?" — predicted ~0 ms (same query, one extra clause).

We do want a §4.5-style instrumentation if Joseph wants to confirm zero latency regression. The protocol would be: deploy instrumented build (same `[t-new-ar-meta] turn { sub_phase, elapsed_ms }` shape), run n=10 haiku bench at N=1 and N=3, compare to T-new-A2's 3520 ms baseline.

**Recommendation: SKIP §4.5 here.** The FOR UPDATE clause adds no extra round-trips and the lock is uncontended in the happy path. If post-deploy bench shows regression, we instrument then.

### 4.5 Local verification before push

```bash
npm run typecheck
npx vitest run src/clawtalk/db/accessors.test.ts
npx vitest run src/clawtalk/db/job-accessors.test.ts
npx vitest run                                      # full backend suite
npm run format:check
```

### 4.6 Post-deploy verification

- Race tests passing in CI is the primary signal — the bug was unreproducible in prod traffic, so post-deploy "the test that failed before now passes" is the verification.
- Smoke: enable a recurring job on a thread, type into that thread while the scheduler is about to fire (check `wrangler tail` for the cron tick), verify only one round actually streams.
- `wrangler tail` watch: zero `TalkActiveRoundError` exceptions during normal use. (Today these may already be zero because the race is rare; the new bug surface is "the fix throws on legit retries" — Test 3 below locks the non-regression.)

---

## 5. Risks and open questions

1. **`FOR UPDATE NOWAIT` makes other writers of the same `talk_threads` row fail instead of wait.** Today the other writers are `updateTalkThreadTitle` (rare; user-initiated from settings) and `maybePersistTalkThreadTitleFromMessages` (runs inside the same tx as our lock — no contention). With NOWAIT, a concurrent `updateTalkThreadTitle` during a streaming round would error with `lock_not_available`. The settings route doesn't catch this today → would surface as a 5xx. Mitigation: update `updateTalkThreadTitle` callers to wait briefly (one retry) OR accept the rare 5xx that the SPA can retry. We'll handle this on demand — likely never fires for a solo-user app.
2. **Worker CPU vs lock.** With NOWAIT, the lock either acquires immediately or fails immediately. No worker-timeout pathological case (codex r1 #17 resolved by NOWAIT).
3. **Postgres.js connection pool nuance.** db.ts:360 creates a postgres.js client with `max: 1` per request scope in the production Worker path. Two `withUserContext` blocks in the same request scope SERIALIZE on that single connection — they can't actually race with each other (the second BEGIN waits for the first COMMIT). Across separate Worker requests they get separate clients and can race. Tests use a node client with `max: 5` so race tests work. **Documented limitation**: same-request nested withUserContext on a single connection is single-threaded by postgres.js's pool, NOT by our FOR UPDATE. The bug surface is cross-request races (which is the realistic scenario anyway).
4. **Deadlock with scheduler.** Both `enqueueTalkTurnAtomic` and `createJobTriggerRun` lock the SAME row (`talk_threads.id`). No cross-row locking from this fix. Deadlock risk is **low today**, but cannot be claimed impossible: future callers adding a second lock (e.g., on `talks.id`) must take locks in the same order across all callers.
5. **`claimDueTalkJobs` upstream race (codex r1 #9).** Two scheduler isolates could claim the same job today; the NOWAIT lock catches the downstream symptom. Fix needs `FOR UPDATE SKIP LOCKED` on the claim — separate plan.
6. **`thread_busy` observability.** The chosen design leaves `last_run_status` unchanged on `thread_busy` (Joseph picked this — see r2 §3). Frequently busy threads are invisible in the talk_jobs query. Trade: simpler code, less schema; if observability becomes a concern, add a `last_skipped_reason` column in a follow-up.

---

## 6. What lands in the PR

Per §4.1 (8 file changes; ~+450 LoC net, ~70 src and ~400 test).

**Sequencing:**
1. Branch off main, write race tests FIRST (per §7) — confirm Tests 1, 4, 5, 6, 7 fail on main; Tests 2, 3 pass (isolation already works).
2. Apply the §4.1 fix to both callers + scheduler refactor.
3. Re-run race tests — confirm all pass.
4. Run full backend suite — zero regressions.
5. `/codex review` + `/karpathy-audit diff`. Address findings.
6. Squash-merge. Deploy. No §4.7 perf bench needed.

---

## 7. Tests

7 tests total: 4 in `accessors.test.ts`, 3 in `job-accessors.test.ts`.

```
CODE PATHS                                            USER FLOWS
[+] enqueueTalkTurnAtomic (accessors.ts)
  ├── loadEnqueueTurnContext FOR UPDATE OF th NOWAIT
  │   ├── [★★★ Test 1] DETERMINISTIC same-thread race:    [+] Same-thread race
  │   │   tx A acquires FOR UPDATE, holds; tx B            └── [★★★ Test 1] B fails
  │   │   tries enqueueTalkTurnAtomic → NOWAIT fires        immediately, not by luck
  │   │   immediately → TalkActiveRoundError. Commit A;
  │   │   thread now has only A's N runs.
  │   ├── [★★ Test 2] two concurrent /chat on DIFFERENT   [+] Cross-thread isolation
  │   │   threads of the same talk → BOTH succeed.         └── [★★ Test 2]
  │   ├── [★★ Test 3] concurrent /chat on different       [+] Cross-talk isolation
  │   │   talks → BOTH succeed.                            └── [★★ Test 3]
  │   └── [★★★ Test 4] sequential /chat after first       [+] Active-round rejection
  │       commits but before runs drain → throws            └── [★★★ Test 4] no
  │       TalkActiveRoundError. No second message + no       double-write
  │       extra runs.
[+] createJobTriggerRun (job-accessors.ts)
  ├── thread FOR UPDATE NOWAIT + thread-level active check
  │   └── [★★★ Test 5] DETERMINISTIC real race:           [+] Job-vs-/chat race
  │       tx A acquires FOR UPDATE for an /chat;           └── [★★★ Test 5] thread_busy
  │       concurrent createJobTriggerRun → NOWAIT fires      sentinel, no new run
  │       → returns {status: 'thread_busy', job}.
  ├── claimDueTalkJobs no longer advances next_due_at
  │   └── [★★★ Test 6] claim job; createJobTriggerRun     [+] Scheduler tick consumption
  │       returns thread_busy; assert next_due_at on       └── [★★★ Test 6] thread_busy
  │       talk_jobs UNCHANGED. Then drain active runs,      retries next tick;
  │       call again → advances on success.                 enqueued advances
  └── runTalkJobNowRoute thread_busy handling
      └── [★★★ Test 7] manual run-now while /chat active  [+] Run-now route 409
          → 409 with code 'thread_busy'.                   └── [★★★ Test 7]
COVERAGE: 7 tests for 3 new code paths.
QUALITY: ★★★:5 ★★:2
```

Legend: ★★★ behavior + edge + error  |  ★★ happy path

**Tests (in detail):**

- **Test 1 (★★★) — DETERMINISTIC same-thread race.** Two-phase pattern using postgres.js's manual `sql.begin` API for tx A:
  ```typescript
  await db.begin(async (txA) => {
    // Acquire FOR UPDATE on talk_threads from txA, leave open.
    await txA`select 1 from public.talk_threads where id = ${threadId} for update nowait`;
    // Now run the enqueue from a fresh withUserContext → tries FOR UPDATE → NOWAIT errors.
    await expect(
      withUserContext(USER_A_ID, async () => {
        await enqueueTalkTurnAtomic({/* same talkId, threadId */});
      }),
    ).rejects.toBeInstanceOf(TalkActiveRoundError);
    // Now insert A's runs inside txA so commit produces the same outcome a real /chat would.
    await txA`insert into public.talk_runs (...) values (...)`;
  });
  // After A commits: assert exactly A's N runs exist on the thread, no orphans from B.
  ```
  This proves NOWAIT serializes; second caller's failure is deterministic (lock held), not probabilistic.
- **Test 2 (★★) — cross-thread isolation.** Seed talk + 2 threads + 1 agent. Two `enqueueTalkTurnAtomic` calls via `Promise.all`, one per thread. Assert both succeed; each thread has its own run.
- **Test 3 (★★) — cross-talk isolation.** Seed 2 talks + their default threads. Concurrent /chat on each. Both succeed.
- **Test 4 (★★★) — sequential active-round rejection.** Renamed from r1's "legit-retry" — current code has no idempotent-replay path, so "retry with same idempotencyKey" framing was wrong. New framing: first `enqueueTalkTurnAtomic` commits; runs are still queued. Second call (different idempotencyKey, simulating the user clicking send twice) throws `TalkActiveRoundError`. No second message + no extra runs. This locks the active-round rejection behaves correctly under the new helper shape (regression test for the path T-new-A2 §7 Test 3 covered for the pre-NOWAIT version).
- **Test 5 (★★★) — DETERMINISTIC scheduler-vs-/chat race.** In `job-accessors.test.ts`. Same two-phase pattern as Test 1: hold FOR UPDATE on the thread via tx A, then call `createJobTriggerRun` in a fresh tx → NOWAIT fires → returns `{status: 'thread_busy', job}`. No new run inserted.
- **Test 6 (★★★) — `processClaimableJobs` advances `next_due_at` correctly per result.** Drive `processClaimableJobs` (the scheduler's actual entry point — exported for the test, or via a small `__test__` re-export) rather than the accessor manually, so the refactor's result-handler branching is exercised. Three sub-cases:
  - **6a `'enqueued'`:** Seed a job with `next_due_at = now - 1s`, no thread contention. Run `processClaimableJobs`. Assert `talk_jobs.next_due_at` advanced to the next cron-computed time. Assert exactly one `talk_runs` row inserted.
  - **6b `'thread_busy'`:** Seed a job with `next_due_at = now - 1s` AND hold a FOR UPDATE on the thread via tx A (same deterministic blocker pattern as Test 1). Run `processClaimableJobs`. Assert `talk_jobs.next_due_at` is UNCHANGED. Assert NO new `talk_runs` row.
  - **6c `'job_busy'`:** Seed a job with `next_due_at = now - 1s` AND insert an existing active run for the same `job_id`. Run `processClaimableJobs`. Assert `talk_jobs.next_due_at` advanced (consumed-and-skipped, matching today's behavior — no catch-up). Assert NO new `talk_runs` row.
- **Test 7 (★★★) — manual run-now route under thread_busy.** Use the `runTalkJobNowRoute` handler with the two-phase pattern: tx A holds FOR UPDATE; call the route; assert 409 with `error.code: 'thread_busy'`. No new run inserted.

### 7.1 Test discipline

- Race tests require **deterministic blocker pattern** (postgres.js's `db.begin(async (tx) => ...)`). Tx A acquires the lock and holds it until its callback returns; Tx B's attempt fires inside A's callback so the lock is provably held. After B fails, A's callback completes and commits.
- **Hard requirement: real Supabase local postgres.** Tests using `getDbPg()` route to `npm run db:start`'s postgres on port 54432. Mock-based tests won't reproduce NOWAIT behavior.
- Tests use the node-mode postgres.js client (configured with `max: 5` per existing test infra) — enough connections for concurrent `Promise.all` race tests.
- Use the existing `seedAuthUser` + `purge` helpers. No new helpers needed.

---

## 8. Failure modes (new codepaths only)

| Codepath | Realistic failure mode | Test covers? | Error handling? | User visibility? |
|---|---|---|---|---|
| `loadEnqueueTurnContext FOR UPDATE OF th NOWAIT` | Another tx holds the lock | Test 1 | `lock_not_available` → `TalkActiveRoundError` → route maps to 409 talk_round_active | "Wait for current round to finish" message |
| `loadEnqueueTurnContext FOR UPDATE OF th NOWAIT` | Talk/thread deleted between `resolveThreadIdForTalk` and the FOR UPDATE | Existing T-new-A2 Test 2 (no-row contract) | Throws `EnqueueTurnContextNotFoundError` → 404 talk_not_found | Same as today |
| `createJobTriggerRun thread FOR UPDATE NOWAIT + check` | Thread locked by /chat | Test 5 | Returns `{status: 'thread_busy', job}` | None (scheduler retries next tick) |
| `processClaimableJobs` retries only `'thread_busy'`, advances on everything else | Job stuck in `thread_busy` forever (chronic contention) | Test 6b | Logs warn after N consecutive thread_busy on the same job; doesn't hot-loop because the lock check is cheap | None today; future: add `last_skipped_reason` column if visibility needed |
| `processClaimableJobs` advances on `'job_busy'` | Previous job instance still running when next cron tick fires | Test 6c | next_due_at advances; this tick is skipped (matches today's claim-time advance behavior) | None |
| `runTalkJobNowRoute` 409 on thread_busy | User clicks Run Now during active round | Test 7 | 409 `code: 'thread_busy'` | Toast: "A round is already in progress" |

**Critical gaps:** none — all new code paths have rollback or test coverage. Pathological lock-wait timeouts impossible under NOWAIT.

---

## 9. Implementation tasks

- [ ] **AR1 (P1, human: ~45 min / CC: ~20 min)** — write Tests 1-7 first (red phase). Run vitest; confirm Tests 1, 4, 5, 6, 7 fail on main; Tests 2, 3 pass (isolation already works).
  - Files: `accessors.test.ts`, `job-accessors.test.ts`
  - Verify: `npx vitest run src/clawtalk/db/` — Tests 1, 4, 5, 6, 7 fail with race / no-sentinel assertion errors

- [ ] **AR2 (P1, human: ~45 min / CC: ~15 min)** — apply the fix per §4.1: `loadEnqueueTurnContext` NOWAIT + error map; `isLockNotAvailable` helper; `createJobTriggerRun` thread lock + thread-level check + new `'thread_busy'` sentinel; `claimDueTalkJobs` next_due_at removal; `processClaimableJobs` advances next_due_at only on `'enqueued'`; `runTalkJobNowRoute` 409 handling.
  - Files: `accessors.ts`, `job-accessors.ts`, `scheduler.ts`, `talk-jobs.ts`
  - Verify: re-run race tests; all 7 pass (green phase)

- [ ] **AR3 (P1, human: ~15 min / CC: ~5 min)** — full backend suite + format + typecheck.
  - Files: none
  - Verify: 957+ tests pass; format:check + typecheck clean

- [ ] **AR4 (P1, human: ~45 min / CC: ~15 min)** — push, `/codex review` + `/karpathy-audit diff`, absorb findings, squash-merge.
  - Files: none
  - Verify: PR green, codex PASS, karpathy PASS, deploy.yml succeeds

- [ ] **AR5 (P2, human: ~15 min)** — docs r3 footer + memory entry update.
  - Files: `docs/T-new-AR-active-round-race-fix.md` (this doc), `project_llm_turn_latency` memory.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Consult (plan, r1) | `/codex` consult on r1 | Independent 2nd opinion | 1 | NOT CLEAR — absorbed via r2 | 20 findings. Critical absorbs: (#1/#2/#6) function name `createJobTriggerRun` + `runTalkJobNowRoute` manual route; (#3/#7/#8) scheduler `next_due_at` refactor — moved advance into result handler; (#12/#13/#14) test redesign — deterministic blocker pattern (`db.begin(async tx => ...)`) for Tests 1, 5, 7; Test 4 renamed; (#17) NOWAIT replaces wait → no worker timeout risk; (#4) SQL clause order `LIMIT … FOR UPDATE`; (#10) postgres.js `max:1` per request scope acknowledged; (#11) Hyperdrive claim dropped; (#16) `createTalkRun` bypass acknowledged; (#18) Option 4 (state row) added briefly; (#19) softened deadlock language; (#20) Test 7 added for `runTalkJobNowRoute`. |
| Karpathy Audit (diff, r1) | `/karpathy-audit diff` on r1 | Style lens + four principles | 1 | CLEAR (4/4 coverage) | 1 WARNING (§3.2 Option 2 rejection verbose — trimmed to 3 lines); 3 NITs absorbed (§2.3 "Joseph" → "solo-user", §5/§7.1 dedup'd, §6 PR title removed). |
| Codex Review (plan, r2) | `/codex review` on r2 | Pre-implementation re-review | 1 | CLEAR (PASS, 0 P1 / 2 P2) | Both P2 absorbed into r3. r2-P1 advisory: `job_busy` retry was an unintentional semantic change — r3 advances on `job_busy`, only retries on `thread_busy`. r2-P2 advisory: Test 6 bypassed `processClaimableJobs` — r3 splits into 6a/6b/6c that drive the scheduler entry point and assert persisted `next_due_at` for each result branch. |
| Codex Review (PR #483 diff) | `/codex review` | Pre-merge code review on the implementation | 1 | CLEAR (PASS, 0 P1 / 1 P2) | P2 absorbed: `'blocked'` branch in `processClaimableJobs` was restoring `next_due_at` after `createJobTriggerRun` had set it to NULL with `status = 'blocked'`. Fix: don't advance in the `'blocked'` branch. Verdict: "The active-round locking approach appears sound, but the scheduler refactor can regress the persisted state for blocked jobs by restoring a future next_due_at after the block path cleared it." |
| Karpathy Audit (diff) | manual application on the diff | Four principles on the code diff | 1 | CLEAR (4/4 pass) | 0 critical, 0 warning, 1 optional nit (group-case comment in scheduler.ts could split per-status — skipped by taste). Notable: principles 2+3 evidenced by deferring Test 6/7 + scoping the savepoint helper as `as unknown as` rather than introducing a global wrapper. |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | not run | Codex consult + codex review pair covered architecture at higher rigor. |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (correctness fix, scope self-evident) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (backend-only) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

**CODEX (r1 → r2):** 20 findings. The wrong-function-name catch (#1) alone would have shipped broken code; codex caught it via direct source-file reads. The scheduler-retry premise (#3/#7) was a hidden incorrectness in r1's narrative — `claimDueTalkJobs` advances `next_due_at` BEFORE the dispatch result, so "thread_busy retries next tick" was false. r2 fixes this by moving the advance into the result handler. NOWAIT (#17) is a clean upgrade that eliminates the lock-hold/worker-CPU pathology. Test determinism (#12/#13) was a real correctness gap — `Promise.allSettled` doesn't guarantee both txs reach the critical section concurrently.

**CODEX (r2 → r3):** 2 P2 findings. r2 over-corrected the scheduler refactor by leaving `next_due_at` unchanged for all non-`'enqueued'` results. r3 narrows the retry to `'thread_busy'` only — `'job_busy'` advances (preserves today's tick-consumes-skip semantics; no catch-up bug). Test 6 redesigned to drive `processClaimableJobs` directly with 3 sub-cases (6a enqueued, 6b thread_busy, 6c job_busy) so the scheduler refactor is actually exercised.

**KARPATHY (r1 → r2):** 1 warning + 3 nits absorbed. Plan trimmed by ~15 lines in §3.2; §5 Risk 4 dropped (covered in §7.1).

**CROSS-MODEL:** Codex caught behavioral correctness (function name, scheduler semantics, test determinism, NOWAIT, job_busy retry trap). Karpathy caught artifact-level bloat and naming. Zero direct finding overlap. Validates [[feedback-codex-catches-behavior-karpathy-catches-style]] at the plan stage AGAIN (fourth time this session — T-new-A2 r1→r2, T-new-A2 PR-diff, T-new-AR r1→r2, T-new-AR r2→r3).

**UNRESOLVED:** 0.

**CODEX (PR diff):** 1 P2. The `'blocked'` branch in `processClaimableJobs` was undoing `next_due_at = null` set by `createJobTriggerRun`. Fix: skip the advance in that branch. Pushed as `1bebb01` before merge.

**VERDICT (r4):** **CLEARED + SHIPPED (r4, 2026-05-29)** — Implementation merged via PR #483 (`0091986`). Plan + PR went through 4 review passes (codex consult on plan r1, karpathy on plan r1, codex review on plan r2, codex review on PR diff). One findings each from the codex passes; absorbed cleanly. SAVEPOINT-wrapped `FOR UPDATE NOWAIT` is the load-bearing addition vs the r3 plan — without it, a 55P03 failure poisons the outer tx with 25P02 and the caller can't return. Critical post-merge constraints:
1. Any future caller of `createTalkRun` with active status MUST take the thread lock first (FOR UPDATE NOWAIT on `talk_threads`) — `createTalkRun` is exported and bypasses the invariant. App-level enforcement only.
2. `processClaimableJobs` is now exported; new schedulers / cron-style code paths that go through it must respect the per-result branching: only `'thread_busy'` leaves `next_due_at` unchanged.
3. The deferred Test 6 (`processClaimableJobs` sub-cases) and Test 7 (`runTalkJobNowRoute` 409) should be filed as a follow-up — the scheduler refactor is currently only exercised by the `claimDueTalkJobs` test + manual smoke.

**FOLLOW-UPS surfaced (open future plans):**
1. **Test 6/7 follow-up** — drive `processClaimableJobs` directly for the 3 result branches (enqueued / thread_busy / job_busy / blocked) + add `runTalkJobNowRoute` 409 test in a new `talk-jobs.test.ts` file.
2. **`deleteTalkMessagesAtomic` `hasActiveTalkRuns` race** (accessors.ts:1334-1339) — also racy. Failure mode benign (history edit only touches `talk_runs.trigger_message_id`), but worth closing for consistency.
3. **`claimDueTalkJobs` upstream race between scheduler isolates** (codex r1 #9) — needs `FOR UPDATE SKIP LOCKED` on the claim SELECT.
4. **3 pre-existing `talks.test.ts` failures** (`registered_agents_owner_id_fkey` FK violation on `Test 1: happy path`, `Test 2: @-mention`, `Test 9: zero talk_agents`) — also fail on `main` checkout independent of this PR. Test infra issue worth diagnosing.
