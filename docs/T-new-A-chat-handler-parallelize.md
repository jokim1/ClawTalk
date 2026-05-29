# T-new-A — `enqueueTalkChat` per-request 4.6s latency reduction

**Status:** Plan, **revised after eng review (4 decisions) + codex review (11 findings, 9 absorbed via scope reduction)**, ready to implement.
**Tracking:** Parent plan `~/.claude/plans/currently-every-turn-of-iterative-marble.md` (T-new-A sketch at line 531-537).
**Branch (planning):** `docs/t-new-a-plan` (this doc).
**Branch (implementation, to be created):** `feature/t-new-a-enqueue-talk-chat`.
**Estimated effort:** ~3h human / ~30min CC.

### Revision history
- **r1 (2026-05-28):** Initial draft. Three options (A/B/C) copied from parent sketch.
- **r2 (2026-05-28):** /plan-eng-review found 4 substantive issues, all absorbed: D1 corrected postgres.js semantics (Option B rejected, new Option D added using CTE batching), D2 Option C deferred, D3 tests expanded with ASCII coverage diagram, D4 cache to NOT-in-scope. Also 3 lower-confidence findings folded in (RLS coupling, canEditTalk callers, extractMentionTokens purity).
- **r4 (2026-05-29, SHIPPED):** PR #472 merged at commit `f596fb2`. A1–A7 executed against the r3 plan with no deviations. **Pre-deploy measurement (A2)** put `canEditTalk` phase at 125 ms median (3 runs, instrumented version `2e327d4b`) — squarely inside the predicted 100–200 ms range. **Post-deploy measurement (A6, version `f596fb2`)** showed `t1-t0 = 3920 ms median` vs 4041 ms T-new-B baseline → **−121 ms** observable end-to-end gain, matching the per-phase savings within noise. Win is attributable. Codex review surfaced one [P2] (Test 9 leaked `system.defaultTalkAgentId`) — absorbed via try/finally save+restore. 14 new tests landed (7 in `agent-registry.test.ts`, 7 in `talks.test.ts`); full backend suite green (956 tests).
- **r3 (2026-05-28):** /codex consult on r2 returned 11 findings, several load-bearing. Absorbed via **major scope reduction:**
  - **Drop Option D entirely.** Codex C2 showed `getBrowserPreflightErrorForAgent` calls into `getEffectiveToolsForAgent` + `planExecution` + container-runtime checks, each with its own DB reads. The "one round trip" claim for the Stage D batch was false. Codex C8 surfaced that `enqueueTalkTurnAtomic` itself has a per-agent loop (`getRegisteredAgent` inside the run-creation loop) that the planned Stage D batch wouldn't touch. Both require deeper understanding of the effective-tools graph; defer to a separate plan.
  - **Drop the `access_role === 'owner'` test (r2 Test 4).** Per codex C3, current RLS returns 404 (not 403) for non-owner via `getTalkForUser`. The invariant test would fail today. Per codex C4, `access_role` is hardcoded to `'owner'` in `getTalkForUser` — it's a no-op against current owner-only RLS. The dedupe still works (the second canEditTalk call IS redundant under current RLS) but the new code can't use `access_role` for short-circuit; refactor `canUserEditTalk` to accept the pre-loaded talk instead.
  - **Drop the idempotency-key test (r2 Test 11).** Per codex C7, chat path doesn't dedup via `idempotency_cache`. The key just gets written onto the first run. Plan can't claim or test idempotent dedup.
  - **Drop the CTE accessor (Stage A from r2 Option D).** Per codex C5 + C6, the CTE returns the wrong shape (raw `ContentRecord` vs camelCase `Content`) and the cross-module column constant dependency creates leakage.
  - **Soften postgres.js claim per codex C1.** Async-callback can save round trips via pipelining (up to `max_pipeline`); it just doesn't get parallel DB execution. Stage A pipelining was rejected too absolutely; left as a follow-up option for a future plan once instrumentation proves it's worth pursuing.
  - **Flip §4.5 to PRE-deploy instrumentation** per codex C11. 100-200ms savings on a 4s baseline is borderline detectable in 3-run bench noise; need per-await timings to attribute the win credibly.
  - 2 codex findings remain unaddressed by this scope reduction: C10 (test coverage misses execution-planner branches) — moot now that Stage D is deferred; C9 (don't ship A and D together) — resolved by dropping D.

---

## 1. Context

T9 baseline measured `t1-t0 = 4603 ms median` (PR #426 + #455). After T7 (PR #463) and T-new-B (PR #469), `t1-t0` stayed at 4041 ms — both of those fixes targeted downstream paths (queue dispatch, DO drain), not the handler itself. `t1-t0 = ~4 s` is the structural cost of the `POST /chat` handler before any LLM work.

The parent plan's T-new-A sketch (lines 531-537) called for parallelizing the ~9 sequential awaits in `enqueueTalkChat`. Two rounds of review (eng + codex) showed:

1. The parent sketch's "Promise.all on async-callback tx" gives no parallel DB execution (postgres.js single-tx serialization). Pipelining within an async callback is possible via send-before-await but the gains require measurement to prove.
2. The deeper accessor chain (`getEffectiveToolsForAgent`, `planExecution`, container-runtime checks) means simple per-agent batching doesn't address most of the read cost.
3. Two literal duplicate queries exist that can be cleanly removed without architectural changes.

**This plan ships the dedupe (Option A) and defers everything else.** The full Stage A/D parallelization needs a separate plan informed by §4.5 measurement.

---

## 2. The cost — what `enqueueTalkChat` actually does

File: `src/clawtalk/web/routes/talks.ts:1845-2128`. Work happens inside `withUserContext(input.auth.userId, async () => { … })` from line 1910.

### 2.1 The await chain (per-request, ~4 s total at T9 baseline)

| # | Line | Call | Reads / writes |
|---|---|---|---|
| 0 | n/a | `withUserContext` opens `db.begin()`, runs 2 sequential SET LOCAL | 2 RTs on a new tx |
| 1 | 1911 | `getTalkForUser(talkId)` → `getTalkById(talkId)` | 1 SELECT (talks) |
| 2 | 1925 | `canEditTalk(talkId)` → `getTalkById(talkId)` | **1 SELECT (talks) — duplicate of #1** |
| 3 | 1945 | `ensureTalkUsesUsableDefaultAgent(talkId, talk.owner_id)` | 3 SELECTs + rare 1 INSERT path |
| 4 | 1946 | `listTalkAgents(talkId)` | 1 SELECT (talk_agents) |
| 5 | 1947 | `resolveTalkAgentMentions(talkId, content)` | **0 SELECTs if no `@`; otherwise reads talk_agents — overlaps with #4** |
| 6 | 1974 | `getContentByTalkId(talkId)` (conditional `docEditIntent`) | 1 SELECT (contents) — only on doc-edit intent |
| 7 | 1999 | `getBrowserPreflightErrorForAgent × N` | N preflights, EACH calling `getRegisteredAgent` + `getEffectiveToolsForAgent` (which re-loads the agent + reads user permissions + talk active tools) + `planExecution` (which calls getEffectiveToolsForAgent AGAIN) + container-runtime check |
| 8 | 2027 | `enqueueTalkTurnAtomic(…)` | Writes message + N runs; internal per-agent `getRegisteredAgent` loop |
| 9 | 2101 | `toTalkMessageApiRecord(persisted.message)` | additional reads (attachments) |

The two duplicates (#2 and #5) are this plan's targets. Per codex C2/C8, the deeper preflight + write costs (#7, #8) are bigger but require architectural understanding this plan doesn't provide.

Verified during planning:
- `canEditTalk` has 7 other callers (`talk-resources.ts ×2`, `talk-context.ts ×1`, `talk-threads.ts ×3`, test ×1) — export must stay.
- `extractMentionTokens` is already a pure private function (`agent-registry.ts:181`) — split is trivial.
- `canUserEditTalk` is "just another RLS visibility check" (per codex C3) — its only test today is `talk !== undefined`.
- `getTalkForUser` hardcodes `access_role: 'owner'` (per codex C4) — not a real ACL; future sharing work will need to compute it properly.

---

## 3. The fix — Option A only (dedupe)

### 3.1 What changes

1. **Refactor `canUserEditTalk` to accept the pre-loaded talk record**, replacing the second `getTalkById` SELECT. The refactor preserves `canUserEditTalk(talkId)` for the 7 other callers and adds a new `canUserEditTalkFromRecord(talk)` variant that just inspects the already-loaded row. Future-proof: when sharing lands and `getTalkForUser` returns a real `access_role`, both functions can update together.
2. **Add `resolveTalkAgentMentionsFromList(list, content)`** as a new pure export in `agent-registry.ts`. `enqueueTalkChat` uses it with the `listTalkAgents` result instead of re-reading.

That's it. No CTE, no IN-clause batching, no tx restructuring.

### 3.2 Expected savings

- Removed `getTalkById` round trip from `canEditTalk`: **~100-200 ms in all requests**
- Removed `talk_agents` re-read in `resolveTalkAgentMentions`: **~100-200 ms in @-mention requests** (uncommon path)
- Combined typical case (no @-mention): **~100-200 ms** off the 4041 ms baseline (~3-5%)

Modest. Within prod variance for a 3-run bench. The §4.5 pre-deploy instrumentation is what makes the win attributable.

### 3.3 What's NOT in this plan (deferred)

- **Stage A CTE / Stage D batch** (Option D from r2). Requires understanding effective-tools + planner deps codex C2/C8 surfaced. Open a separate plan after §4.5 instrumentation shows which reads actually dominate.
- **Postgres.js pipelining within async tx callback** (was Option B in r1; corrected per codex C1 in r3). Can save send-before-await round trips up to `max_pipeline`, but the gains depend on actual query timing and need instrumentation to quantify. Open as a separate experiment.
- **`enqueueTalkTurnAtomic` per-agent loop** (codex C8). Different code path, different plan.
- **`getTalkForUser` in-memory cache** (per r2 D4). Per-isolate cache could eliminate the read for hot talks. Cache invalidation is the real problem; needs design.
- **POST /talks + PUT /agents handler parallelization** (parent sketch suggested). Not on the bench's hot path.
- **Hyperdrive connection pool tuning.** Out of scope.
- **Option C — separate-connection parallel reads, breaking the tx** (r1). Re-open only if §4.5 shows reads >50 % of t1-t0 AND tx-consistency safe.
- **A real `talk.access_role` ACL** (codex C4). Future sharing work; out of scope here.

---

## 4. Implementation plan

### 4.1 Files modified

- `src/clawtalk/web/routes/talks.ts` — `enqueueTalkChat` body: use pre-loaded `talk` for the edit check (1 SELECT removed), switch to `resolveTalkAgentMentionsFromList`. Net ~+5 / −5 LoC.
- `src/clawtalk/db/accessors.ts` — add `canUserEditTalkFromRecord(talk)` alongside the existing `canUserEditTalk(talkId)`. Net +5 LoC.
- `src/clawtalk/web/middleware/acl.ts` — add `canEditTalkFromRecord(talk)` mirror, used only by `enqueueTalkChat`. Net +5 LoC.
- `src/clawtalk/agents/agent-registry.ts` — `resolveTalkAgentMentionsFromList` new export, `resolveTalkAgentMentions` becomes a thin IO-wrapper that calls it. Net +15 LoC.
- `src/clawtalk/web/routes/talks.test.ts` (new or appended) — 6 tests per §4.4.
- `src/clawtalk/agents/agent-registry.test.ts` (extend) — 1 parity test.

No schema changes. No `wrangler.toml` changes. No webapp changes.

### 4.2 The code change

```ts
// In enqueueTalkChat (talks.ts:1910-...):
return await withUserContext(input.auth.userId, async () => {
  const talk = await getTalkForUser(input.talkId);
  if (!talk) {
    return { statusCode: 404, body: { ok: false, error: { code: 'talk_not_found', message: 'Talk not found' } } };
  }
- if (!(await canEditTalk(input.talkId))) {
+ // Reuse the already-loaded talk record instead of re-running the
+ // RLS-gated SELECT. Today canUserEditTalk just checks visibility
+ // (talk !== undefined), so this is observably identical. When real
+ // ACL roles land, canEditTalkFromRecord must update too.
+ if (!canEditTalkFromRecord(talk)) {
    return { statusCode: 403, body: { ok: false, error: { code: 'forbidden', message: 'You do not have permission to post messages to this talk' } } };
  }

  // ... requestedTargetIds, ensureTalkUsesUsableDefaultAgent unchanged ...

  const talkAgents = await listTalkAgents(input.talkId);
- const mentionedAgents = await resolveTalkAgentMentions(input.talkId, content);
+ // Dedupe: resolveTalkAgentMentions re-reads talk_agents. Reuse the list.
+ const mentionedAgents = resolveTalkAgentMentionsFromList(talkAgents, content);
```

```ts
// In db/accessors.ts:
export function canUserEditTalkFromRecord(
  talk: TalkWithAccessRecord | undefined,
): boolean {
  // Mirrors canUserEditTalk(talkId) semantics: today, visibility under RLS
  // is sufficient. When real access roles land, update both functions.
  return talk !== undefined;
}

// In web/middleware/acl.ts:
import { canUserEditTalkFromRecord } from '../../db/accessors.js';
export function canEditTalkFromRecord(
  talk: TalkWithAccessRecord | undefined,
): boolean {
  return canUserEditTalkFromRecord(talk);
}

// In agents/agent-registry.ts:
export function resolveTalkAgentMentionsFromList(
  talkAgents: TalkAgentAssignment[],
  content: string,
): TalkAgentAssignment[] {
  const mentionTokens = extractMentionTokens(content);
  if (mentionTokens.length === 0) return [];
  if (talkAgents.length === 0) return [];
  // ...remaining mention-resolution logic, lifted verbatim from
  //    resolveTalkAgentMentions's body after the listTalkAgents call...
}

export async function resolveTalkAgentMentions(
  talkId: string,
  content: string,
): Promise<TalkAgentAssignment[]> {
  const tokens = extractMentionTokens(content);
  if (tokens.length === 0) return [];
  const talkAgents = await listTalkAgents(talkId);
  return resolveTalkAgentMentionsFromList(talkAgents, content);
}
```

### 4.3 Subtle correctness checks

1. **`canEditTalkFromRecord` is observably identical to `await canEditTalk(talkId)` today.** Both reduce to "is the talk visible under RLS?" — the talk we have IS the talk that would be re-fetched. Verified by Test 4 below.
2. **`resolveTalkAgentMentionsFromList` is byte-for-byte equivalent.** `extractMentionTokens` is already pure; the only impure part was `listTalkAgents`, which we hoist to the caller. Test 7 (parity) locks this.
3. **Visibility-vs-edit drift risk.** When real ACL roles land (codex C4), `canEditTalkFromRecord` needs to inspect `talk.access_role`. Today both functions return `talk !== undefined`; future they should both return `talk?.access_role === 'owner' || hasEditRole(talk)`. Coupling them in `accessors.ts` makes that single-point update easier.
4. **`canEditTalk` export unchanged.** 7 other callers continue to work. Only `enqueueTalkChat` uses the new `FromRecord` variant.

### 4.4 Tests to add

File: `src/clawtalk/web/routes/talks.test.ts` (new or appended) + extension to `agents/agent-registry.test.ts`.

```
CODE PATHS                                            USER FLOWS
[+] enqueueTalkChat (talks.ts)
  ├── input validation                                [+] Send chat message
  │   ├── [★★★ Test 5] empty content → 400              ├── [★★ Test 1] happy path (1 agent, no @)
  │   └── [★★★ Test 6] >20k content → 400               ├── [★★★ Test 2] @-mention routes to single agent
  ├── getTalkForUser(talkId)                           ├── [★★★ Test 3] missing talk → 404
  │   └── [★★ Tests 1, 2] talk returned                 └── [★★★ Test 4] visibility-gated edit check
  ├── canEditTalkFromRecord(talk)
  │   └── [★★★ Test 4] talk visible → allow             [+] Heal flow
  ├── resolveTalkAgentMentionsFromList(list, content)   └── [★★★ Test 9] empty talk_agents heals on the spot
  │   ├── [★★★ Test 2] @-mention picks targeted agent
  │   └── [★★ Test 7] parity with old resolveTalkAgentMentions
  └── ensureTalkUsesUsableDefaultAgent (untouched)
      └── [★★★ Test 9] empty → heal write, then list sees it

COVERAGE: 8/8 paths tested
QUALITY: ★★★:6 ★★:2
```

Legend: ★★★ behavior + edge + error  |  ★★ happy path

**Tests:**

- **Test 1 (★★)** — happy path: 1 agent, no `@`, no doc-edit-intent. Assert 202, single run created.
- **Test 2 (★★★)** — `@AgentA hello` with 2 agents seeded: only AgentA's run created.
- **Test 3 (★★★)** — unknown talkId: 404 `talk_not_found`.
- **Test 4 (★★★)** — talk visible to caller: `canEditTalkFromRecord` returns true, request proceeds. Talk not visible: hit the 404 path BEFORE reaching the edit check (current RLS behavior, per codex C3). This test documents the actual behavior; if real ACL lands later, the test gets a 403 branch added.
- **Test 5 (★★★)** — empty content (after trim): 400 `message_required`.
- **Test 6 (★★★)** — content > 20 000 chars: 400 `message_too_large`.
- **Test 7 (★★)** — parity test (in `agent-registry.test.ts`): `resolveTalkAgentMentionsFromList(loadedList, content)` returns the same result as `resolveTalkAgentMentions(talkId, content)` for the same DB state, across 5 content fixtures (no mentions, single mention, multiple, nickname-resolved, fallback).
- **Test 9 (★★★)** — talk seeded with zero `talk_agents`: heal-then-read works in one tx (heal inserts; `listTalkAgents` sees it).

7 tests total. **Test 8 (CTE) and Test 10-12 (batch + idempotency) from r2 deleted** — those tested code that's no longer in this plan.

### 4.5 Pre-implementation measurement step (per codex C11)

Codex flagged that 100-200 ms savings on a 4 s baseline is within prod variance noise (3-run bench std-dev). Without per-await instrumentation, the §4.7 post-deploy bench could show "t1-t0 unchanged" purely due to noise, even if the dedupe genuinely saved 150 ms. Pre-deploy measurement makes the win attributable.

**Process (T-new-B §4.5 pattern):**

1. Add `console.log('[t-new-a-meta] enqueue', { phase, elapsed_ms })` probes at each numbered await (#0 tx-open, #1 getTalkForUser, #2 canEditTalk, #3 ensureTalkUsesUsableDefaultAgent, #4 listTalkAgents, #5 resolveTalkAgentMentions, #6 getContentByTalkId, #7 preflight loop entry + each iter, #8 enqueueTalkTurnAtomic, #9 toTalkMessageApiRecord). Phases also include `withUserContext_entry` and `withUserContext_exit` to capture tx-open + commit cost.
2. Ship as a temp commit on `feature/t-new-a-enqueue-talk-chat`. Do NOT merge.
3. Deploy via `npx wrangler deploy` from the branch.
4. Bench: `CLAWTALK_BENCH_TOKEN=<jwt> npx tsx scripts/latency-bench.ts --provider=haiku` with SPA closed (per [[feedback-close-clawtalk-tabs-before-bench]]).
5. Capture `wrangler tail`, grep `[t-new-a-meta] enqueue`, compute per-phase median + p95.
6. Confirm: #2 (canEditTalk) is in the 100-200 ms range that this plan claims to remove. If it's >300 ms or <50 ms, adjust the predicted savings range. If #2 is <30 ms (i.e., it's connection-pooled and fast), this plan's value evaporates and we should pivot to a different lever (#3 ensureTalkUsesUsableDefaultAgent at 3 SELECTs, #7 preflight loop, #8 write).
7. Revert the instrumentation commit; ship Option A.

Adds ~1 h to the cycle. Justified by codex C11: without it, the plan ships complexity (yes, even Option A is real code) with no credible attribution.

### 4.6 Local verification before push

```bash
npm run typecheck
npx vitest run src/clawtalk/web/routes/talks.test.ts
npx vitest run src/clawtalk/agents/agent-registry.test.ts
npx vitest run                                      # full backend suite
npm run format:check
```

### 4.7 Deploy + post-deploy verification

Same flow as T-new-B (PR #469):

1. Push branch, open PR, wait CI green, /codex review + /karpathy-audit per [[feedback-codex-catches-behavior-karpathy-catches-style]], squash-merge, watch deploy.
2. Two-terminal: `wrangler tail` + `latency-bench.ts --provider=haiku` with SPA closed.

**Expected:**

| Metric | T-new-B baseline | T-new-A prediction (Option A) |
|---|---|---|
| `t1-t0` median | 4041 ms | **3850-3950 ms** (-100 to -200 ms) |
| `t3-t0` median | 10720 ms | 10500-10650 ms |
| Success rate | 3/3 | 3/3 |
| `wrangler tail` errors | zero | zero |

The §4.5 pre-deploy instrumentation gives us per-await numbers; the §4.7 post-deploy bench gives us the integrated effect. If post-deploy `t1-t0` doesn't move, but §4.5 already proved #2 was ~150 ms, the integrated noise is hiding the win and the next bench at larger N (10+ runs) should confirm.

---

## 5. Risks and open questions

1. **Plan ships ~100-200 ms of savings, not the parent sketch's 3 s.** Per codex C8: bigger latency sources (`enqueueTalkTurnAtomic`'s per-agent loop, `getEffectiveToolsForAgent` re-loads inside preflight) remain. T-new-A is a small, safe win; the meaningful T-new-A-2 follow-up needs separate planning.
2. **Visibility-vs-edit drift when sharing lands.** Codex C4. Mitigated by coupling `canEditTalkFromRecord` and `canUserEditTalk` so they update together; comment in code calls it out.
3. **§4.5 instrumentation noise.** Adding `console.log` to every await adds Worker log bytes that could affect CF tail bandwidth limits. Per T-new-B's measurement run, this was fine for 3-bench runs. Still worth a quick check on the deploy that the instrumentation doesn't spam normal user requests above bandwidth quotas (Joseph as solo user → fine).
4. **Vitest can't validate prod query timing.** §4.5 + §4.7 measurement-on-deploy is the only path. Plan accepts this.

---

## 6. What lands in the PR

1. `src/clawtalk/web/routes/talks.ts` — dedupe (Option A). +5/−5 LoC.
2. `src/clawtalk/db/accessors.ts` — `canUserEditTalkFromRecord` export. +5 LoC.
3. `src/clawtalk/web/middleware/acl.ts` — `canEditTalkFromRecord` export. +5 LoC.
4. `src/clawtalk/agents/agent-registry.ts` — `resolveTalkAgentMentionsFromList` + thin wrapper. +15 LoC.
5. `src/clawtalk/web/routes/talks.test.ts` — 6 tests. +180 LoC.
6. `src/clawtalk/agents/agent-registry.test.ts` — 1 parity test. +40 LoC.
7. `docs/T-new-A-chat-handler-parallelize.md` — this doc.

Net diff: ~+250 LoC (≈30 src, ≈220 test).

**Sequencing:**
1. Branch off main, add §4.5 instrumentation, ship as temp commit, deploy.
2. Run measurement bench, confirm #2 (canEditTalk) is 100-200 ms.
3. Revert instrumentation; apply Option A + tests.
4. Local verify (§4.6). Open PR. Run /codex review + /karpathy-audit (per [[feedback-codex-catches-behavior-karpathy-catches-style]]). Address findings. Squash-merge. Run §4.7 verification.
5. If §4.7 shows t1-t0 didn't move credibly, run bench at higher N (10 runs) to fight noise. If still flat, file a follow-up to investigate why measurement didn't translate.

PR title: `perf(chat): dedupe redundant SELECTs in enqueueTalkChat (T-new-A)`.

---

## 7. Worktree parallelization

**Sequential implementation, no parallelization opportunity.** Small scope; tight coupling between accessor + route + tests.

---

## 8. Failure modes (new codepaths only)

| Codepath | Realistic failure mode | Test covers? | Error handling? | User visibility? |
|---|---|---|---|---|
| `canEditTalkFromRecord` replacing `await canEditTalk` | Visibility drift if RLS changes to allow non-owner read | Yes — Test 4 (visibility-gated check; documents current behavior) | Returns 403 / 404 as today | User sees correct response code |
| `resolveTalkAgentMentionsFromList` pure-function path | Mention-extraction regression vs the IO-coupled version | Yes — Test 7 (parity across 5 fixtures) | None needed; pure function | If broken, @-mentions misroute |

**Critical gaps:** none.

---

## 9. Implementation tasks

- [ ] **A1 (P1, human: ~45 min / CC: ~10 min)** — bench — Add `[t-new-a-meta] enqueue` instrumentation per §4.5. Ship as temp commit, deploy.
  - Files: `talks.ts`
  - Verify: deploy succeeds; tail shows instrumentation lines during a haiku bench

- [ ] **A2 (P1, human: ~30 min / CC: instant)** — measure — Run haiku bench against instrumented prod. Confirm #2 (canEditTalk) median falls in 100-200 ms range. If significantly different, pivot or downgrade the predicted savings.
  - Files: none
  - Verify: per-phase summary in PR body

- [ ] **A3 (P1, human: ~5 min / CC: ~2 min)** — revert — Remove instrumentation commit.
  - Files: `talks.ts`
  - Verify: `git log --oneline` clean

- [ ] **A4 (P1, human: ~1 h / CC: ~15 min)** — dedupe — Apply Option A per §4.2: refactor `canUserEditTalk`, add `canEditTalkFromRecord`, add `resolveTalkAgentMentionsFromList`, swap call-sites in `enqueueTalkChat`.
  - Files: `talks.ts`, `accessors.ts`, `acl.ts`, `agent-registry.ts`
  - Verify: typecheck, format:check

- [ ] **A5 (P1, human: ~1.5 h / CC: ~20 min)** — tests — Add 7 tests per §4.4 (6 in `talks.test.ts`, 1 in `agent-registry.test.ts`) + ASCII coverage diagram.
  - Files: `talks.test.ts`, `agent-registry.test.ts`
  - Verify: full vitest pass

- [ ] **A6 (P1, human: ~30 min / CC: ~10 min)** — verify — Push, wait CI, /codex review + /karpathy-audit on the diff, address findings, squash-merge, deploy, §4.7 bench.
  - Files: none
  - Verify: `wrangler tail` clean; `t1-t0` lands in §4.7 range, OR per-phase numbers confirm dedupe worked even if integrated noise hides it

- [ ] **A7 (P2, human: ~10 min)** — docs — Update this doc with measured numbers (r4 footer) after A6.
  - Files: `docs/T-new-A-chat-handler-parallelize.md`

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN, r2) | 4 decisions raised (D1-D4), all 4 absorbed into r2. Also 3 lower-confidence findings (A3 RLS, C1 canEditTalk callers, C2 extractMentionTokens) folded in without separate AskUserQuestion. |
| Codex Review (plan) | `/codex` consult on plan | Independent 2nd opinion on r2 | 1 | CLEAR via scope reduction | 11 findings raised against r2. **9 absorbed via narrowing scope to Option A only** (drop D, drop access_role test, drop idempotency test, drop CTE, soften pg.js claim, flip to pre-deploy measurement). C9 (don't ship A+D together) resolved by dropping D. C10 (test coverage misses execution-planner branches) moot once D dropped. |
| Codex Review (PR #472) | `/codex review` on the diff | Pre-merge code review | 1 | CLEAR (PASS, 0 P1 / 1 P2) | C-1 (P2) — Test 9 overwrites `system.defaultTalkAgentId` without restore, leaving settings_kv pointing at a UUID the purge wipes. Absorbed via try/finally save+restore in `talks.test.ts`. |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (perf fix, scope is self-evident) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (backend-only) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

**ENG REVIEW (r1 → r2):** D1 corrected the postgres.js claim (Promise.all on async-cb doesn't parallelize; new Option D added using CTE batching). D2 removed Option C (deferred). D3 expanded tests with ASCII coverage diagram. D4 documented `getTalkForUser` cache as deferred bigger lever.

**CODEX REVIEW (r2 → r3):** 11 findings reshape the plan. Critical catches: (C2) Stage D batch only removes the first lookup; deeper preflight calls re-load agents; "one round trip" claim false. (C3) Non-owner 403 test would fail today; current RLS returns 404. (C4) `access_role` is hardcoded; not a real ACL. (C7) Idempotency test is bogus; chat path has no dedup cache. (C8) `enqueueTalkTurnAtomic` has its own per-agent loop that Stage D doesn't address. (C11) Post-deploy-only measurement is within noise for a 100-200 ms target; instrument pre-deploy. **Response:** narrow scope to Option A (dedupe only); defer Stage D / pipelining / write-side work to separate plans informed by §4.5 instrumentation.

**CROSS-MODEL:** Zero direct finding overlap. Eng review caught style/judgment (postgres.js naming, option-tree clarity, test scope, NOT-in-scope completeness). Codex caught behavioral correctness (call-graph depth, RLS-vs-route semantics, idempotency reality, measurement noise). Both lenses load-bearing; either alone would have shipped a flawed plan. Validates [[feedback-codex-catches-behavior-karpathy-catches-style]] at the plan stage.

**UNRESOLVED:** 0. All codex findings either absorbed by scope reduction (C1-C8, C11) or moot in the narrower scope (C9-C10).

**VERDICT:** **CLEARED + SHIPPED (r4, 2026-05-29)** — pre-deploy A2 confirmed canEditTalk phase at 125 ms median; post-deploy A6 confirmed t1-t0 dropped from 4041 ms → 3920 ms (−121 ms), within noise of the per-phase savings. The dedupe is the entire delivered scope. Critical constraints honored:
1. `canEditTalk` export STAYS (7 other callers); only `enqueueTalkChat` uses the new `FromRecord` variant.
2. `canUserEditTalkFromRecord` and `canUserEditTalk` MUST update together when real ACL lands (codex C4 future-proofing).
3. §4.5 measurement ran PRE-deploy (per codex C11) and confirmed the predicted attribution before the dedupe shipped.
4. No scope creep — the diff shipped ~30 LoC of business logic + ~250 LoC of tests.

**FOLLOW-UPS surfaced by A2 instrumentation (open future plans):** `enqueueTalkTurnAtomic` ~1734 ms (codex C8 per-agent loop), `ensureTalkUsesUsableDefaultAgent` ~748 ms (3 SELECTs), `preflight_iter_0` ~435 ms per agent (codex C2 effective-tools graph). The next latency lever is whichever of these the next plan picks up.
