# T-new-A2 B-3 — collapse `resolveCredentialKindSnapshot` from 2 SELECTs to 1

**Status:** Plan, **r1 draft**.
**Tracking:** [[project-llm-turn-latency]], [[T-new-A2-enqueue-talk-turn-atomic]] (the C-M4 / C8 deferred work), [[T-new-A2-followup]] (measured per-iteration evidence).
**Branch (planning):** `docs/t-new-a2-b3-plan` (this doc).
**Branch (implementation, to be created):** `feature/t-new-a2-b3-credential-resolve`.
**Estimated effort:** ~3 h human / ~30 min CC. (Smaller than T-new-A2 — single function, no fan-out, no migration. Larger than the original T-new-A — measurement-first because the headline number is contested.)

---

## 1. Context

T-new-A2-followup logged `resolveCredentialKindSnapshot` at **~248 ms median per agent** (N=3 haiku bench, n=10 trimmed). The followup doc called this "~50 % of each iteration" and the "dominant remaining cost" — naming B-3 (collapse the 2 SELECTs to 1) as the recommended next plan.

But the followup measurement came from the bench scenario, where `bench-haiku` is a fresh agent with no provider secrets configured for the bench user. Re-reading `src/clawtalk/agents/execution-resolver.ts:336`:

```typescript
export async function resolveCredentialKindSnapshot(agent) {
  const personalRow = await db`select credential_kind from llm_provider_secrets where ...`;
  if (personalRow[0]) return personalRow[0].credential_kind;   // ← early return
  const workspaceRow = await db`select credential_kind from workspace_provider_secrets where ...`;
  // ... fallback or null
}
```

**The function is ALREADY 1 RT when a personal secret exists.** Both bench measurements showed 248 ms, which means the bench's user has no personal `llm_provider_secrets` row for `provider.anthropic` (or has a row whose `credential_kind` doesn't match the agent's `credential_mode`). In production, Joseph almost certainly has a personal Anthropic api_key — making the production hot path already 1 RT, with B-3 saving 0 ms.

This plan exists to either confirm or refute the followup doc's premise, and to ship the dedupe only if it's a real win.

---

## 2. The cost — what `resolveCredentialKindSnapshot` actually does

`src/clawtalk/agents/execution-resolver.ts:336-383`. Two `SELECT credential_kind FROM <secrets_table>` queries, with a CASE-based ORDER BY (api_key < subscription) and `LIMIT 1`. PK on both tables is `(owner_id, provider_id, credential_kind)` per migration `0010_oauth_subscription_credentials.sql`.

### 2.1 The two cost regimes

| Scenario | RTs | Cost |
|---|---|---|
| Personal secret exists for `(owner_id, provider_id)` with matching `credential_kind` | 1 | ~125 ms (1 Hyperdrive RT) |
| Personal secret missing or `credential_kind` mismatch; workspace secret may or may not exist | 2 | ~250 ms (2 Hyperdrive RTs) |
| The Anthropic-with-env-key fallback (line 374) | 0 (after the 2 RTs above) | same as above |

The bench measured ~248 ms → the bench setup falls into the second regime. Joseph's actual production /chat traffic likely falls into the first regime (Anthropic API key configured personally).

### 2.2 Why this matters for the plan

If production hits the 1-RT path: B-3 saves nothing on Joseph's real traffic. The plan should not ship.

If production hits the 2-RT path: B-3 saves 1 RT (~125 ms) per agent. At N=1 that's 125 ms; at N=3 that's 375 ms. Real win.

**The §4.5 measurement step is mandatory and gate-with-teeth.** Per [[feedback-measure-before-locking-perf-plans]] — the shadow-query gate pattern that worked in T-new-A2 applies here too.

---

## 3. Options

### 3.1 Option A — UNION ALL combined query (RECOMMENDED if §4.5 gate passes)

Single query covering both tables:

```sql
select credential_kind
from (
  select credential_kind, 0 as origin_priority
  from public.llm_provider_secrets
  where provider_id = ${providerId}
    and (${pinnedMode}::text is null
         or credential_kind = ${pinnedMode}::text)
  union all
  select credential_kind, 1 as origin_priority
  from public.workspace_provider_secrets
  where provider_id = ${providerId}
    and (${pinnedMode}::text is null
         or credential_kind = ${pinnedMode}::text)
) merged
order by
  origin_priority asc,
  case credential_kind
    when 'api_key' then 0
    when 'subscription' then 1
  end asc
limit 1
```

**Pros:**
- 1 RT regardless of which secret store has the row.
- Preserves the exact ordering: personal > workspace, api_key > subscription.

**Cons:**
- Two table scans (personal + workspace) in one query, instead of an early-return after personal hits. **For users who hit the 1-RT path today, this might be SLOWER server-side** (postgres has to evaluate both branches, even if the personal branch returns a row). Measurement required.
- Slightly more complex SQL.

### 3.2 Option B — Drop the workspace query entirely

Per [[project-personal-only-byok]] (PR #465, 2026-05-27): "stripped workspace API key surface; ClawTalk is personal-only until real org/workspace requirements arrive."

The workspace UI was stripped but the underlying `workspace_provider_secrets` table remains (migration 0008 wasn't reverted), and the executor + resolver still query it. If no production traffic depends on workspace secrets, we can drop the workspace fallback from the resolver entirely.

**Pros:**
- 1 RT always — same as Option A.
- Simpler code: −10 LoC instead of +5 LoC.
- No risk of being slower than current (Option A's table-scan worry).
- Aligns with the personal-only-byok memory's "do not reintroduce workspace_provider_*" guidance.

**Cons:**
- Quietly drops a code path. If Joseph has workspace secrets (from before the strip), affected agents would lose credentials and fail at run time.
- Per the memory, the table was NOT dropped — only the UI surface. Some grandfathered data may exist.
- Auditable verification needed: count rows in `workspace_provider_secrets` for Joseph's owner_id.

### 3.3 Option C — Add an index hint (REJECTED)

In theory, since the PK includes `credential_kind`, postgres could use a partial index. But the existing PK already covers it; the queries are already index lookups. The ~125 ms cost is network/protocol overhead, not server compute. Index hints save nothing.

### 3.4 Why the recommended choice depends on §4.5

If Joseph's `workspace_provider_secrets` has zero rows for his `owner_id`: Option B is strictly better (simpler, same perf, aligns with the personal-only direction). Just drop the workspace query.

If there are workspace rows: Option B would break those agents. Option A is the safe choice — but only if §4.5 confirms it's not slower than the current early-return path.

**The §4.5 step must answer two questions:**
1. Does Joseph's `workspace_provider_secrets` have any rows? (Single query, ~10 seconds to answer.)
2. Does Option A's UNION ALL query measure faster, slower, or equal to the current code in the production environment? (Shadow query for n=10 bench requests.)

---

## 4. The fix — gated by §4.5

### 4.1 Decision tree

```
§4.5 step 1: count workspace_provider_secrets where owner_id = <joseph>
├── 0 rows → Option B: drop workspace query. Net −10 LoC, 1 RT always.
│            Memory entry [[project-personal-only-byok]] backs this.
│
├── >0 rows → §4.5 step 2: shadow Option A's UNION ALL alongside current code.
│             Bench n=10 haiku, compare median(currentPath) vs median(unionAll).
│             ├── unionAll ≤ current + 30 ms → Option A. Ship.
│             └── unionAll > current + 30 ms → Don't ship. Plan terminates.
│                  (The two-branch table-scan slowed things down; not worth it.)
```

The 30 ms band is a "noise floor" — Hyperdrive p50 RT variance is ~10-20 ms; we want a real signal, not noise.

### 4.2 What changes (Option A)

1. **`src/clawtalk/agents/execution-resolver.ts` — `resolveCredentialKindSnapshot`**: replace the two `await db` calls with one UNION ALL query. Net ≈ +5 LoC.
2. **Tests** — verify the ORDER BY semantics still pick personal-api_key > personal-subscription > workspace-api_key > workspace-subscription. Net ~+80 LoC.

### 4.3 What changes (Option B)

1. **`src/clawtalk/agents/execution-resolver.ts` — `resolveCredentialKindSnapshot`**: delete the workspace SELECT entirely. Net ~−10 LoC.
2. **Tests** — verify the workspace-secret path is gone (any agent depending on workspace secrets returns null, which surfaces as a missing-credential error at run time per the resolver's contract). Net ~+30 LoC.

Note: `resolveSecret` (the run-time path, not the snapshot path) at execution-planner.ts:165 also queries workspace_provider_secrets. If Option B ships, `resolveSecret` should match — but that's a follow-up: this plan is scoped to the snapshot path only because that's what the per-agent loop hits.

### 4.4 Out of scope (explicit)

- **`resolveSecret` (execution-planner.ts:165) and other workspace_provider_secrets readers** — same workspace fallback shape, but in the run-time path. Separate plan if Option B ships.
- **B-1 / B-2 / B-4 from the followup doc** — B-1 (batch the per-agent loop SELECTs) is N≥2-only; B-2 (Promise.all credential resolve) was already shown unlikely to pipeline per T-new-A2 Option D; B-4 (denormalize credential snapshot) is architecturally larger.
- **`ensureTalkUsesUsableDefaultAgent` ~748 ms** — bigger N=1 lever, separate plan.
- **`getRegisteredAgent` ~125 ms per agent** — already 1 RT, no obvious dedupe available without batching across agents (B-1).

### 4.5 Pre-deploy measurement (the gate that can refuse the plan)

**Step 1 — count workspace rows for Joseph (~30 seconds):**
```bash
psql $PROD_DATABASE_URL -c "select count(*) from public.workspace_provider_secrets where owner_id = '<joseph-uuid>';"
```
Result: 0 → go to Option B. >0 → go to Step 2.

**Step 2 — shadow UNION ALL alongside current code (~20 min):**

Same pattern T-new-A2 §4.5 used: deploy an instrumented build that runs the current code for real AND shadows the UNION ALL query, logging per-call elapsed_ms for both. Run n=10 haiku bench at N=1 (single-agent) and N=3 (multi-agent). Compare:

| Sub-phase logged | Source |
|---|---|
| `resolveCredentialKindSnapshot_current` | the existing implementation |
| `resolveCredentialKindSnapshot_shadow_unionall` | the proposed query, result discarded |

Decision gate:
- median(shadow) − median(current) ≤ 30 ms → Option A passes. Ship the UNION ALL.
- median(shadow) − median(current) > 30 ms → Option A fails. Cancel. Document why (likely: the dual table scan is slower than early-return when personal hits).

The decision must hold at N=1 AND N=3 (the per-agent cost is what we're optimizing; both regimes matter).

**Per [[feedback-close-clawtalk-tabs-before-bench]]:** Joseph closes all clawtalk.app tabs before the bench. Per [[feedback-measure-before-locking-perf-plans]]: bench harness lives at `scripts/latency-bench.ts`; the bench JWT is the standard eb_at cookie.

### 4.6 Local verification before push

```bash
npm run typecheck
npx vitest run src/clawtalk/agents/execution-resolver.test.ts
npx vitest run                                      # full backend suite
npm run format:check
```

### 4.7 Post-deploy verification

- If Option A ships: re-run the haiku bench n=10 at N=1 and N=3. Compare median `agent_loop_iter_*_resolveCredentialKindSnapshot` to the §4.5 measurement. Should drop by the predicted ~125 ms per call.
- If Option B ships: same bench. Should drop by the predicted ~125 ms per call. Additionally, smoke-test any agent that depends on workspace secrets (per §4.5 step 1, none today — but worth checking the dashboard / wrangler tail for "PROVIDER_SECRET_MISSING" errors post-deploy).
- `wrangler tail` clean: no `ExecutionResolverError` regressions.

---

## 5. Risks and open questions

1. **Bench may not represent production.** This is the central concern that makes §4.5 mandatory. The followup doc treated the 248 ms measurement as the production cost, but the early-return path means production may already be 1 RT.
2. **Option A could be slower than current in the personal-hit case.** Two table scans in one query, even with `limit 1` after the union, may cost more than one table scan early-returning. §4.5 step 2 measures this directly.
3. **Option B silently drops workspace fallback.** If Joseph has workspace secrets (auditable via §4.5 step 1), Option B would break those agents at run time. The personal-only-byok memory says the UI was stripped but the table remains.
4. **Bench's owner is Joseph.** The "no personal secret for bench" hypothesis from §1 is testable directly — Joseph can `psql` his prod DB or run a quick auth'd `/api/v1/...` route to check what's in `llm_provider_secrets` for his Anthropic agents. If he has one configured, the bench's 248 ms measurement is mysterious and §4.5 needs to figure out why.
5. **`resolveSecret` (execution-planner.ts:165) and other readers stay on the current 2-RT shape.** If Option B ships here, the run-time path still pays 2 RTs. Per-call effect at /chat enqueue is what this plan targets, but the run-time disparity is worth a follow-up.

---

## 6. What lands in the PR

Depends on §4.5 outcome (see §4.1 decision tree). Both options are bounded to one src file + one test file:

- **Option A path:** `execution-resolver.ts` (+~5 LoC), `execution-resolver.test.ts` (+~80 LoC).
- **Option B path:** `execution-resolver.ts` (−~10 LoC), `execution-resolver.test.ts` (+~30 LoC for the "no workspace fallback" assertion + ~−20 LoC if there are existing workspace-tests to remove).

No migration. No schema change. No new exports.

**Sequencing:**
1. Branch off main, add §4.5 instrumentation per §4.5 (current path + shadow Option A query if going down that road).
2. Joseph runs Step 1 (count workspace rows) — gates which path.
3. If Step 2 needed: deploy instrumented build, n=10 bench, evaluate the 30 ms gate.
4. Revert §4.5 instrumentation. Apply A or B.
5. Local verify (§4.6). Open PR. Run `/codex review` + `/karpathy-audit diff` per [[feedback-codex-catches-behavior-karpathy-catches-style]]. Address findings. Squash-merge. Run §4.7 post-deploy bench.

---

## 7. Tests

The test count depends on which option ships. Both share the same regression coverage.

### 7.1 Option A tests (UNION ALL)

```
CODE PATHS                                            USER FLOWS
[+] resolveCredentialKindSnapshot
  ├── personal-api_key wins                            [+] Personal API key
  │   └── [★★ Test 1] returns 'api_key' when only        └── [★★ Test 1]
  │       personal api_key exists                          single secret path
  ├── personal-subscription wins                        [+] Personal subscription
  │   └── [★★ Test 2] returns 'subscription' when only   └── [★★ Test 2]
  │       personal subscription exists                     OAuth-only user
  ├── personal beats workspace                          [+] Mixed secrets
  │   └── [★★★ Test 3] returns personal credential       └── [★★★ Test 3] origin
  │       when both personal and workspace exist           priority preserved
  ├── api_key beats subscription                        [+] Multi-mode preference
  │   └── [★★★ Test 4] returns 'api_key' when both       └── [★★★ Test 4] api_key
  │       kinds exist (in same scope)                      preference preserved
  ├── pinnedMode filters                                [+] Pinned mode
  │   └── [★★★ Test 5] returns subscription when         └── [★★★ Test 5]
  │       pinned=subscription, ignoring api_key            pin overrides default
  └── empty result returns null                         [+] No credentials
      └── [★★ Test 6] returns null when both             └── [★★ Test 6] enq
          tables empty                                     stores null snapshot
COVERAGE: 6 tests; combined query semantics fully exercised.
QUALITY: ★★★:3 ★★:3
```

### 7.2 Option B tests (drop workspace)

Same first 4 tests; replace 5 with a single Test 5 that asserts the workspace fallback is gone — an agent with ONLY workspace secrets returns `null`. Test 6 unchanged.

### 7.3 Test discipline

- Tests use the existing `seedAuthUser` + provider-setup helpers from `agent-accessors.test.ts` and `execution-resolver.test.ts`.
- All tests run inside `withUserContext(USER_ID, ...)` so the queries are RLS-scoped (the existing test pattern).
- No new helpers needed.

---

## 8. Failure modes (changed paths only)

| Codepath | Realistic failure mode | Test covers? | Error handling? | User visibility? |
|---|---|---|---|---|
| Option A UNION ALL query | Postgres planner chooses a worse path than the two early-return queries | §4.5 gate refuses to ship | n/a — plan terminates | n/a |
| Option B drop workspace fallback | Joseph has grandfathered workspace secrets, agent loses credential | §4.5 step 1 audits this before code change | Resolver returns null → executor surfaces `PROVIDER_SECRET_MISSING` at run start | "No API credentials" error in the SPA |
| Either option's PR codex pass | Discriminated-union exhaustiveness if return type changes | Typecheck catches | n/a | n/a |

**Critical gaps:** none — §4.5 gate provides the structural safety net.

---

## 9. Implementation tasks

- [ ] **B3-1 (P1, human: ~10 min)** — Joseph runs `psql` Step 1 to count `workspace_provider_secrets` rows for his owner_id. Determines whether Option B is on the table.
  - Files: none
  - Verify: result captured in PR body / plan footer

- [ ] **B3-2 (P1, human: ~30 min / CC: ~15 min)** — IF Option A is the path: add §4.5 shadow instrumentation (current path + UNION ALL shadow query, per-call elapsed_ms logged) and deploy via `npx wrangler deploy` from the planning branch.
  - Files: `execution-resolver.ts`
  - Verify: tail shows both `_current` and `_shadow_unionall` log lines on bench traffic

- [ ] **B3-3 (P1, human: ~30 min / CC: instant)** — Bench n=10 at N=1 and N=3. Compute the 30 ms gate. Decide A / B / cancel.
  - Files: none
  - Verify: gate verdict written into PR description

- [ ] **B3-4 (P1, human: ~15 min / CC: ~5 min)** — Revert instrumentation (if any from B3-2).
  - Files: `execution-resolver.ts`
  - Verify: clean diff vs main

- [ ] **B3-5 (P1, human: ~30 min / CC: ~10 min)** — Apply the chosen option (A or B).
  - Files: `execution-resolver.ts`
  - Verify: typecheck + format:check clean

- [ ] **B3-6 (P1, human: ~45 min / CC: ~15 min)** — Add the tests from §7.1 or §7.2 depending on path.
  - Files: `execution-resolver.test.ts`
  - Verify: full vitest pass

- [ ] **B3-7 (P1, human: ~45 min / CC: ~15 min)** — Push, `/codex review` + `/karpathy-audit diff`, absorb findings, squash-merge, deploy, §4.7 verification.
  - Files: none
  - Verify: PR green, codex PASS, karpathy PASS, deploy.yml succeeds, post-deploy bench shows the predicted ~125 ms savings

- [ ] **B3-8 (P2, human: ~10 min)** — r2 footer + memory update.
  - Files: this doc, `project_llm_turn_latency` memory.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | not run | Will run on r1 before locking design. |
| Codex Consult (plan, r1) | `/codex` consult on r1 | Independent 2nd opinion | 0 | not run | Per [[feedback-codex-review-before-locking-cf-anthropic-decisions]] — run BEFORE AskUserQuestion answers lock the design. |
| Karpathy Audit (diff, r1) | `/karpathy-audit diff` on r1 | Style lens + four principles | 0 | not run | Will run on r1 alongside codex. |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (perf fix, scope self-evident) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (backend-only) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

**VERDICT (r1):** **DRAFT — pending review.** Plan ready for `/codex` consult + `/karpathy-audit diff`. Critical pre-implementation constraints:
1. §4.5 step 1 (workspace row count) MUST happen before any code change. The decision tree depends on its outcome.
2. The 30 ms gate band is a noise floor — actual Hyperdrive RT variance is ~10-20 ms; we want signal, not noise.
3. If §4.5 cancels the plan, file `T-new-A2-followup-r2.md` updating the followup doc's headline (the "~250 ms per agent" was a bench artifact). Don't silently drop the work.
4. `resolveSecret` (execution-planner.ts:165) is out of scope. If Option B ships, file a follow-up to align the run-time path.
