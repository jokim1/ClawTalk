# T-new-C — `ensureTalkUsesUsableDefaultAgent` happy-path early-exit

**Status:** Plan, **r5 draft**.
**Tracking:** [[project-llm-turn-latency]], [[T-new-A-chat-handler-parallelize]] (the §4.5 attribution that surfaced this).
**Branch (planning):** `docs/t-new-c-ensure-default-agent` (this doc).
**Branch (implementation, to be created):** `feature/t-new-c-ensure-default-agent`.
**Estimated effort:** ~4 h human / ~3 h CC (revised at r4 after absorbing the route-test gap; see §6).

---

## Revision history

- **r1 (2026-05-29)** — initial draft. Codex returned 2 P1 + 5 P2 (`.codex-r1-findings.txt`). Karpathy returned 1 critical + 2 warning + 1 nit. Critical overlap on the gate-equivalence claim; complementary on enabled-semantics, RLS reference, failure surface, call multiplicity, "99%" hand-wave.
- **r2 (2026-05-29)** — absorbed r1: widened gate to `orphanCount = 0`; dropped "usable" terminology; fixed RLS reference; replaced "99%" with measurement-validated framing; added §2.3 route multiplicity table; deferred redundant-inner-call removal. Codex r2 returned 0 P1 + 3 P2; karpathy r2 returned 0 critical + 2 warning + 1 nit (100% overlap with codex). Raw: `.codex-r2-findings.txt`.
- **r3 (2026-05-29)** — absorbed r2: wrapped snapshot in try/catch; rewrote §7 to use real bench interface; baseline measured at C5; §4.1 added N-active row; dropped "strictly tighter" claim. Codex consult r3 + karpathy r3 both PASS clean. `/codex review` (the formal PR-stage review against the diff): GATE PASS with 0 P1 + 3 P2 advisories.
- **r4 (2026-05-29)** — absorbed `/codex review` r3 P2s: Test 2 query-counter strategy; Test 3 4 new route tests; §6 estimate bumped to ~4h; §8 row #1 tightened.
- **r5 (this revision)** — absorbs `/codex review` r4 P2s (all polish, no behavior):
  - Top-level **Estimated effort** updated to ~4 h / ~3 h (r4 P2 #1 — summary was stale).
  - §3.1 code comment renamed `// activeCount > 0: at least one usable assignment` → `// activeCount > 0: at least one assigned row (non-null FK)` (r4 P2 #2 — preserves r3's narrowed "assigned-agent shape" framing).
  - §6 C3 verify-row updated to match Test 1's actual case count (r4 P2 #3 — Test 1 lists explicit cases, C3 matches).

---

## 1. Context

T-new-A's §4.5 attribution surfaced `ensureTalkUsesUsableDefaultAgent` at **~748 ms median** per call. The function is invoked from four hot-path routes (`src/clawtalk/web/routes/talks.ts:644, 1231, 1270, 1952`) — every `GET /talks/:id`, every `GET /talks/:id/agents`, every `POST /talks/:id/chat`. So this cost lands on essentially every authenticated talk-related request.

The function is a "best-effort healing" fixup: it ensures a talk has at least one assigned agent (the default), and that exactly one of them is marked `is_primary`. In steady state most talks already have healthy agent assignments, so the heal path is rarely taken — yet the full SELECT chain runs every time, on the apparent-happy-path, just to confirm there's nothing to heal. The proportion of calls that hit the early-exit gate is unknown at plan time and validated by the §7 post-deploy bench.

**The lever:** answer the healthy-state question with a single cheap SELECT, and skip the rest of the chain when the talk is already healthy.

This plan is plan-only. No code changes during planning. Implementation lives behind r-N codex+karpathy review per [[feedback-codex-catches-behavior-karpathy-catches-style]].

---

## 2. Surface inventory

### 2.1 The function (confirmed against current main `af4206b`)

`src/clawtalk/agents/agent-registry.ts:255-295` — `ensureTalkUsesUsableDefaultAgent(talkId, ownerId)`.

```ts
export async function ensureTalkUsesUsableDefaultAgent(
  talkId: string,
  ownerId: string,
): Promise<void> {
  let defaultTalkAgentId: string;
  try {
    defaultTalkAgentId = await getDefaultTalkAgentId();          // SELECTs 1-2
  } catch {
    return;
  }
  const defaultTalkAgent = await getRegisteredAgent(defaultTalkAgentId); // SELECT 3
  if (!defaultTalkAgent || defaultTalkAgent.enabled !== true) {
    return;
  }
  const rows = await getTalkAgentRows(talkId);                   // DELETE + SELECTs 4-5
  if (rows.length === 0) {
    await setTalkAgents({ talkId, ownerId, agents: [{ ... }] });
    return;
  }
}
```

### 2.2 The function-level round-trip chain (apparent-happy-path)

Following the call chain into the accessors:

1. `getDefaultTalkAgentId()` (`agent-registry.ts:86`):
   - **SELECT** `settings_kv` for `system.defaultTalkAgentId` (via `getSettingValue`, `accessors.ts:3283`).
   - **SELECT** `registered_agents` for the candidate (via `getRegisteredAgent`, `agent-accessors.ts:244`).
2. Outer caller line 269: **SELECT** `registered_agents` AGAIN with the same ID — **redundant** with step 1's SELECT in the candidate-enabled branch; only meaningful in the main-agent-fallback branch.
3. `getTalkAgentRows(talkId)` (`talk-agents.ts:225`):
   - Internally calls `pruneDeletedTalkAgentAssignments(talkId)` (`talk-agents.ts:303`):
     - **DELETE** `talk_agents where registered_agent_id IS NULL` (no-op on healthy talks, but the round-trip still happens).
     - **SELECT** `talk_agents` for remaining rows (the prune's primary-count check).
     - Optional **UPDATE** if primary count != 1 (heal path only).
   - Then **SELECT** `talk_agents` for the actual returned rows.

**Round-trip count per function call on the apparent-happy-path: 6** (3 settings/registered_agents SELECTs + 1 DELETE + 2 talk_agents SELECTs). At Joseph's measured ~125 ms p50 per Hyperdrive round trip, that's ~750 ms — matching T-new-A's attribution.

### 2.3 Function calls per route — the multiplicity surprise

The function isn't called once per request — it's called **N times** depending on the route:

| Route | Direct call site | Indirect calls (via `listEffectiveTalkAgents` line 644 or `toTalkApiRecord` line 273) | Total per request |
|---|---|---|---|
| `POST /talks/:id/chat` (`sendChatRoute`) | talks.ts:1952 | none | **1×** |
| `GET /talks/:id` (`getTalkRoute`) | talks.ts:1231 | `toTalkApiRecord` at line 1238 (1 call) | **2×** |
| `GET /talks/:id/agents` (`listTalkAgentsRoute`) | talks.ts:1270 | `listEffectiveTalkAgents` at line 1278 (1 call) | **2×** |
| `GET /talks` (`listTalksRoute`) | none | `toTalkApiRecord` per talk at line 686 — runs once per talk in the list | **N×** (one per talk) |

So per-route savings scale by multiplicity. A 50-talk list view today eats 50 × ~750 ms = ~37 s of `ensureTalkUsesUsableDefaultAgent` cost; even amortized over Hyperdrive concurrency that's a large structural inefficiency.

The multiplicity itself is a separate (and arguably larger) lever — the redundant inner calls inside `listEffectiveTalkAgents` and `toTalkApiRecord` are likely unintended. This plan does NOT fix them (§3.3 deferral); it makes each call cheaper on the apparent-happy-path, which compounds across the multiplicity.

Per [[feedback-verify-schema-facts-in-plan-gates]] — every identifier above round-tripped through grep against current main (`af4206b`).

---

## 3. The fix — early-exit on healthy state

### 3.1 What changes

Add a single cheap accessor that answers "is this talk's agent set already healthy?" in 1 RT, and gate the rest of `ensureTalkUsesUsableDefaultAgent` behind it. The snapshot answers the **assigned-agent shape** question (count + primary marker + orphan presence) — NOT the "is the assigned agent's registered_agents row enabled" question, which today's code also doesn't truly verify for assigned agents (it verifies only the default-agent fallback). Terminology kept narrow on purpose: "assigned-agent shape" instead of "usable agent" to avoid the codex P1 #2 overstatement.

**New accessor** in `src/clawtalk/db/talk-agents.ts`:

```ts
export async function getTalkAgentsHealthSnapshot(
  talkId: string,
): Promise<{
  activeCount: number;   // rows with non-null registered_agent_id
  primaryCount: number;  // rows where is_primary = true (regardless of FK)
  orphanCount: number;   // rows with null registered_agent_id (prune target)
}> {
  const db = getDbPg();
  const rows = await db<Array<{
    active_count: string; primary_count: string; orphan_count: string;
  }>>`
    select
      count(*) filter (where registered_agent_id is not null) as active_count,
      coalesce(sum((is_primary)::int), 0)                     as primary_count,
      count(*) filter (where registered_agent_id is null)     as orphan_count
    from public.talk_agents
    where talk_id = ${talkId}::uuid
  `;
  return {
    activeCount: Number(rows[0]?.active_count ?? 0),
    primaryCount: Number(rows[0]?.primary_count ?? 0),
    orphanCount: Number(rows[0]?.orphan_count ?? 0),
  };
}
```

**Rewritten `ensureTalkUsesUsableDefaultAgent`**:

```ts
export async function ensureTalkUsesUsableDefaultAgent(
  talkId: string,
  ownerId: string,
): Promise<void> {
  // Cheap shape check: 1 RT instead of 6 in steady state.
  // Conditions match the post-prune invariant in talk-agents.ts:303-332:
  // - activeCount > 0: at least one assigned row (non-null FK; does NOT verify
  //   the referenced registered_agent is enabled — that's out of scope here)
  // - primaryCount = 1: post-prune primary invariant holds
  // - orphanCount = 0: prune would have been a no-op (no null-FK rows to delete)
  // On snapshot error, fall through to the heal path's existing swallow on
  // getDefaultTalkAgentId — preserves the function's best-effort contract.
  let health: { activeCount: number; primaryCount: number; orphanCount: number };
  try {
    health = await getTalkAgentsHealthSnapshot(talkId);
  } catch {
    health = { activeCount: 0, primaryCount: 0, orphanCount: 1 }; // force heal
  }
  if (
    health.activeCount > 0 &&
    health.primaryCount === 1 &&
    health.orphanCount === 0
  ) {
    return;
  }
  // Heal path: existing logic unchanged.
  let defaultTalkAgentId: string;
  try {
    defaultTalkAgentId = await getDefaultTalkAgentId();
  } catch {
    return;
  }
  const defaultTalkAgent = await getRegisteredAgent(defaultTalkAgentId);
  if (!defaultTalkAgent || defaultTalkAgent.enabled !== true) {
    return;
  }
  const rows = await getTalkAgentRows(talkId);
  if (rows.length === 0) {
    await setTalkAgents({ talkId, ownerId, agents: [{ /* unchanged */ }] });
    return;
  }
}
```

### 3.2 Expected savings

- **Healthy-shape path** (activeCount > 0, primaryCount = 1, orphanCount = 0): 6 RT → 1 RT = **~625 ms saved per function call.**
- **Heal-shape path** (any condition fails): 6 RT → 7 RT = **~125 ms regression per function call.** Acceptable — heal is not on the steady-state user path.

The proportion of calls in each bucket is unknown at plan time. The §7 post-deploy bench is the validation gate. If healthy-shape covers ≥80 % of calls, structural saving carries through. If <50 %, file `T-new-C-followup.md` per §7.

Per-route savings compound by §2.3 multiplicity. The bench reports both function-level (per-call saving) and route-level (per-request saving) deltas to keep the prediction honest.

### 3.3 What's NOT in this plan (deferred)

- **Dedupe `getDefaultTalkAgentId` → return the agent record, not just the ID.** Would save 1 more RT on the heal path. Deferred — heal is rare; touches `getDefaultTalkAgentId`'s API contract.
- **Remove redundant inner calls** to `ensureTalkUsesUsableDefaultAgent` inside `listEffectiveTalkAgents:644` and `toTalkApiRecord:273`. These are the source of the §2.3 multiplicity and almost certainly the bigger lever in absolute terms (N×-amplified on `listTalksRoute`). Separate plan — needs care because the inner calls were added defensively; removing them shifts responsibility to every route caller.
- **Pre-deploy instrumentation gate** (per [[feedback-measure-before-locking-perf-plans]]). Predicted win is ~625 ms per call (well above the 200 ms threshold), and T-new-A's §4.5 already attributed the function. Post-deploy bench validates.
- **Tighten `pruneDeletedTalkAgentAssignments`** to short-circuit when no work is needed. Separate accessor with separate callers; out of this scope.
- **Filter `getRegisteredAgent` by `enabled = true`** to match the snapshot semantics (codex P1 #2 secondary). Out of scope — that's a behavioral change in `getRegisteredAgent` itself, not just here.

---

## 4. Risks and correctness

### 4.1 Gate equivalence — three-field check

The gate `activeCount > 0 AND primaryCount = 1 AND orphanCount = 0` matches the post-prune healthy invariant that `pruneDeletedTalkAgentAssignments` + the function's own `rows.length === 0` check together produce:

| Talk state | activeCount | primaryCount | orphanCount | Gate verdict | Existing-code behavior |
|---|---|---|---|---|---|
| 1 active primary, no orphans | 1 | 1 | 0 | **HEALTHY** | prune no-op, function early-returns | ✅ equivalent |
| **N** active rows, **exactly 1 primary**, no orphans (multi-agent steady state) | N | 1 | 0 | **HEALTHY** | prune no-op, function early-returns | ✅ equivalent |
| 1 active non-primary, no orphans | 1 | 0 | 0 | HEAL | prune updates primary on surviving row | ✅ heal path runs |
| 2 active rows, 0 primary | 2 | 0 | 0 | HEAL | prune updates first row to primary | ✅ heal path runs |
| 2 active rows, 2 primary (invariant broken) | 2 | 2 | 0 | HEAL | prune updates first row, demotes others | ✅ heal path runs |
| 1 active primary + 1 orphan | 1 | 1 | 1 | HEAL | prune deletes orphan, no UPDATE needed | ✅ heal path runs |
| 1 active non-primary + 1 orphan primary (codex r1 P1 #1 case b) | 1 | 1 | 1 | HEAL | prune deletes orphan + UPDATEs survivor primary | ✅ heal path runs |
| 0 active, 1+ orphans | 0 | * | ≥1 | HEAL | prune deletes orphans + heal-from-default | ✅ heal path runs |
| 0 active, 0 orphans (empty) | 0 | 0 | 0 | HEAL | prune no-op, heal-from-default | ✅ heal path runs |

The gate is **equivalent** to the post-prune predicate: every state that the existing code modifies routes to the heal path; every state that the existing code leaves alone routes to early-exit. The cost on the heal-path side is one extra SELECT (the snapshot) that we then re-derive via `getTalkAgentRows`. Acceptable — heal is not on the steady-state user path.

### 4.2 Snapshot SELECT failure surface — preserved swallow

Today's `ensureTalkUsesUsableDefaultAgent` swallows `getDefaultTalkAgentId()` errors via `try { ... } catch { return }`. The function is best-effort healing; a DB error on the read path silently no-ops rather than failing the route.

r3 preserves that contract: the snapshot SELECT is wrapped in try/catch and falls through to the heal path on error (which itself swallows). Net behavioral change vs main: zero — the failure surface of `ensureTalkUsesUsableDefaultAgent` is exactly what it is today. The earlier r2 framing ("accept the more honest failure") was rejected — turning a perf optimization into a behavior change wasn't justified.

If a future PR wants to surface DB read errors instead of swallowing them, it should land as its own behavioral-change PR with appropriate route-handler error mapping; not folded into a perf lever.

### 4.3 RLS surface

`talk_agents` RLS lives in `supabase/migrations/0002_rls_policies.sql:105-116`, owner-scoped: `talk_agents_owner using (owner_id = auth.uid())`. The new snapshot SELECT runs inside `withUserContext(auth.uid())`, so it inherits owner-id RLS the same way the existing `getTalkAgentRows` does. Filtering by `talk_id` alone is correct — owner-scope is added by Postgres at policy-application time. (r1 incorrectly cited migration `0001`; fixed.)

### 4.4 Concurrent mutation between snapshot and heal

If another request mutates `talk_agents` between the snapshot SELECT and a subsequent `setTalkAgents` write in this same request:

- The heal path still re-reads via `getTalkAgentRows` BEFORE writing — so the writer sees the latest state.
- `setTalkAgents` is full-replace ([[feedback-settalkagents-full-replace]]); last writer wins.
- The healthy-shape early-exit could skip a prune that the *current* code would have performed if a concurrent insert lands between snapshot and the existing `getTalkAgentRows` call. The window is ~1 RT (the gap between SELECT and the next operation). Benign in practice — the next request's `ensureTalkUsesUsableDefaultAgent` or `getTalkAgentRows` call will catch it (`getTalkAgentRows` is called from many non-`ensure` paths).

Net: race surface is **slightly different but not strictly worse**. The previous plan claim "preserves the existing race" was overbroad (codex P2 #2); corrected here.

### 4.5 What could break a previously-healthy talk's read

Postgres.js coerces `count(*) FILTER (...)` and `coalesce(sum(...))` to strings (the BigInt-as-string pattern). `Number(rows[0]?.active_count ?? 0)` produces:
- `"1"` → `1` ✓
- `"0"` → `0` ✓
- `undefined` (snapshot returned empty array — impossible for an aggregation without GROUP BY) → `0` ✓
- `null` (theoretical) → `0` ✓ via the `?? 0` guard

This pattern is the same one already used by `loadEnqueueTurnContext` and other accessors. Codex confirmed correctness (P2 #1).

---

## 5. Tests

Three test files touched:

### Test 1 — `src/clawtalk/db/talk-agents.test.ts` (new)

`getTalkAgentsHealthSnapshot` returns correct counts across these fixtures (one case per healthy/heal-routing decision the gate must make, drawn from §4.1's 9-row table — heal-routing cases collapse to one representative apiece since the snapshot return shape, not the gate verdict, is what's under test here):

1. **empty `talk_agents`** → `{ activeCount: 0, primaryCount: 0, orphanCount: 0 }`
2. **1 active primary row** → `{ activeCount: 1, primaryCount: 1, orphanCount: 0 }` (healthy)
3. **1 active non-primary row** → `{ activeCount: 1, primaryCount: 0, orphanCount: 0 }` (heal-routing)
4. **2 active rows, exactly 1 primary** → `{ activeCount: 2, primaryCount: 1, orphanCount: 0 }` (multi-agent healthy)
5. **2 active rows, 2 primary (invariant broken)** → `{ activeCount: 2, primaryCount: 2, orphanCount: 0 }` (heal-routing)
6. **1 active primary + 1 null-FK orphan** → `{ activeCount: 1, primaryCount: 1, orphanCount: 1 }` (heal-routing — orphan blocks healthy)
7. **1 null-FK orphan only** → `{ activeCount: 0, primaryCount: 0, orphanCount: 1 }`

Use the `seedAuthUser` + `withUserContext` pattern from `accessors.test.ts:84-96, 119-141`. 7 cases total.

### Test 2 — `src/clawtalk/agents/agent-registry.test.ts` (extend)

`ensureTalkUsesUsableDefaultAgent` gating behavior. **Important:** `ensureTalkUsesUsableDefaultAgent` calls `getDefaultTalkAgentId` / `getRegisteredAgent` / `getTalkAgentRows` via lexical bindings within the same module. `vi.spyOn` on imported bindings won't observe those calls — the bindings were captured at module-load time before any spy could attach. Assert gating via **DB-state post-conditions** + a **query counter** that wraps the test's `getDbPg()` (a per-test counter installed in the `beforeEach`).

- **Healthy-shape gate hit:** seed talk with 1 active primary row + 0 orphans → call → assert (a) query counter shows exactly 1 SELECT against `talk_agents` during the call (the snapshot), zero against `settings_kv`, zero INSERTs/UPDATEs/DELETEs on `talk_agents`; (b) talk's `talk_agents` rows unchanged (post-condition).
- **Orphan-present heal:** seed talk with 1 active primary + 1 orphan → call → assert (a) snapshot SELECT fires, then heal path runs (prune deletes orphan); (b) orphan row gone from `talk_agents`.
- **Empty-agents heal:** seed talk with 0 rows → call → assert default agent was set (post-condition: 1 active primary row exists after the call).
- **Broken-primary heal:** seed talk with 2 active rows + 0 primary → call → assert prune fixed primary (post-condition: exactly 1 row has `is_primary = true`).
- **Snapshot SELECT throws → swallow → heal fallback:** mock `getTalkAgentsHealthSnapshot` to throw → call → assert no exception propagates AND heal path was attempted (talk state matches what heal would produce).

### Test 3 — `src/clawtalk/web/routes/talks.test.ts` (NEW route tests)

`talks.test.ts` today only tests `enqueueTalkChat` — there is NO existing happy-path coverage for the four call sites in §2.3. C-impl must ADD these tests so the §7 success criteria are validated at the route boundary, not just the function boundary.

- **sendChatRoute happy path:** POST `/talks/:id/chat` with a healthy talk → asserts response shape, no 500, healthy gate hit (DB-state unchanged).
- **getTalkRoute happy path:** GET `/talks/:id` with a healthy talk → asserts response includes talk record + agent shape; `ensureTalkUsesUsableDefaultAgent` is called twice (direct + via `toTalkApiRecord`), both gate hits.
- **listTalkAgentsRoute happy path:** GET `/talks/:id/agents` with a healthy talk → asserts agent list shape; same double-call pattern.
- **listTalksRoute happy path with N talks:** GET `/talks` with N=3 healthy talks → asserts list shape; `ensureTalkUsesUsableDefaultAgent` is called N times (via `toTalkApiRecord` per talk).

---

## 6. Implementation tasks

**Total estimated effort: ~4 h human / ~3 h CC** (up from r3's ~2 h after absorbing P2 #2's route-test gap — those 4 new route tests in `talks.test.ts` are a real C-impl cost, not regression coverage).

| Task | Files | Verify |
|---|---|---|
| **C1** Add `getTalkAgentsHealthSnapshot` accessor | `src/clawtalk/db/talk-agents.ts` (~30 LoC) | Test 1 passes |
| **C2** Rewrite `ensureTalkUsesUsableDefaultAgent` with snapshot gate + try/catch | `src/clawtalk/agents/agent-registry.ts:255` (gate added; existing logic preserved behind gate) | Test 2 passes |
| **C3** Backend tests | `src/clawtalk/db/talk-agents.test.ts` (new — Test 1) + `src/clawtalk/agents/agent-registry.test.ts` (extend — Test 2, includes the query-counter helper) | `npm run test` passes (existing + 7 Test 1 cases + 5 Test 2 cases) |
| **C4** Route tests (NEW per P2 #2 absorption) | `src/clawtalk/web/routes/talks.test.ts` (extend — Test 3's 4 cases: sendChatRoute / getTalkRoute / listTalkAgentsRoute / listTalksRoute happy paths) | `npm run test` passes; route gate-hit counts match §2.3 multiplicity |
| **C5** Push PR. Run `/codex review` + `/karpathy-audit diff` on diff. Absorb findings. | n/a | both PASS clean |
| **C6** Deploy. Function-level bench + sendChatRoute bench per §7. | n/a | targets met |

---

## 7. Post-deploy verification

Per [[feedback-measure-before-locking-perf-plans]]: T-new-A's §4.5 attribution already gave the 748 ms baseline for the function. The bench validates that savings materialize at function-level (per-call) and on the latency-sensitive `sendChatRoute` (1× call).

**Bench command** (SPA tabs closed per [[feedback-close-clawtalk-tabs-before-bench]]):

```
CLAWTALK_BENCH_TOKEN=<fresh eb_at JWT> npx tsx scripts/latency-bench.ts --provider=haiku
```

This is the existing `/chat`-only harness (the script does not have a `--route` flag — confirmed against `scripts/latency-bench.ts:719-735`). It measures `sendChatRoute`'s t1-t0.

**Pre-T-new-C baseline measurement (C5 step):** run the bench command above on `main` BEFORE merging T-new-C. Record the t1-t0 median as `BASELINE_MS`. Asserting "post-T-new-A 3920 ms" at plan-time was stale — T-new-A2 also shipped (−273 ms) so the real baseline is somewhere around 3520 ms but should be re-measured rather than assumed.

**Success criteria**:

1. **Function-level instrumentation** — add a one-call timer around `ensureTalkUsesUsableDefaultAgent` for the duration of C5 (removed after deploy verification). Healthy-shape median ≤200 ms (vs ~750 ms pre-T-new-C). If ≥500 ms saving, structural claim holds.
2. **`sendChatRoute` t1-t0 median** ≥500 ms drop vs `BASELINE_MS` measured at C5.
3. **Zero new error classes** in 24h prod logs after deploy. Snapshot SELECT failures are swallowed by §4.2's try/catch, so the "no new 500s" check is a regression on the broader read path, not on snapshot specifically.

`getTalkRoute` and `listTalksRoute` are not benched directly (the harness doesn't drive them). Their savings are inferred: per-call function-level saving × §2.3 multiplicity. Verifying them empirically would require a bench-script extension and is out of scope for this lever.

**Failure-branch decisions:**

- If function-level shows ≥500 ms but `sendChatRoute` shows <300 ms: the structural saving exists but is masked by other phases (likely the same `enqueueTalkTurnAtomic` ~1734 ms surfaced by T-new-A). Acceptable; file `T-new-C-followup.md` noting the gap.
- If function-level shows <300 ms: gate is firing less than expected. Log `getTalkAgentsHealthSnapshot` outcomes for 24h and reframe — the healthy-shape proportion was wrong, not the structural lever.

---

## 8. Failure modes (new code paths only)

| Failure | Behavior | Recovery |
|---|---|---|
| `getTalkAgentsHealthSnapshot` SELECT throws | Caught by §4.2's try/catch around the snapshot call only. Falls through to the existing heal path, which has its own `try { getDefaultTalkAgentId } catch { return }` swallow. **However:** the try/catch covers ONLY the snapshot SELECT itself. If snapshot succeeds and the heal path runs, later throws from `getRegisteredAgent`, `getTalkAgentRows`, or `setTalkAgents` still propagate to the caller exactly as they do on `main` today — no new 500 surface, but also no new safety vs today. | n/a — matches today's failure surface for the heal path. |
| `postgres.js` coerces counts as strings | `Number(rows[0]?.active_count ?? 0)` handles correctly (§4.5). | n/a |
| Snapshot reads stale row count under concurrent mutation | Slightly different race than today's; §4.4 argues benign. | Next request's call catches it. |
| Snapshot SQL accidentally OR-s `is_primary` against null-FK rows | `(is_primary)::int` over a NULL `is_primary` yields NULL; `sum(NULL) = NULL`; `coalesce(..., 0) = 0` makes the gate refuse healthy → routes to heal. Harmless mis-classification. | n/a |

---

## 9. Out of scope

- Dedupe `getDefaultTalkAgentId` to return the agent record (deferred — §3.3).
- Inline heal-path write into snapshot transaction (deferred — §3.3).
- `pruneDeletedTalkAgentAssignments` redesign (out of scope — shared accessor).
- `getRegisteredAgent` enabled-filter tightening (out of scope — separate behavioral change).
- Redundant-inner-call removal in `listEffectiveTalkAgents` + `toTalkApiRecord` (§3.3 — separate plan, likely a bigger lever).

---

## GSTACK REVIEW REPORT

| Review | Method | What it checked | Findings | Verdict | Notes |
|---|---|---|---|---|---|
| Codex consult (r1) | `/codex consult` | Behavior + framework-specific (gate equivalence, postgres.js coercion, RLS, race, route multiplicity, failure surface) | 2 P1 + 5 P2 | NOT CLEAR → r2 | Counterexamples on the gate, double-call on `listTalkAgentsRoute`, RLS reference accuracy. All absorbed. `.codex-r1-findings.txt`. |
| Karpathy audit (r1) | `/karpathy-audit` against the plan | Style + four principles (coverage + quality) | 4/4 coverage; 1 critical + 2 warning + 1 nit | NOT CLEAR → r2 | Critical (orphan-row case) overlapped with codex P1; W1 (99% hand-wave), W2 (§4.6 stale ref) absorbed. NIT (coalesce) skipped — left as-is. |
| Codex consult (r2) | `/codex consult` | Re-verify gate equivalence, multiplicity, failure-surface decision | 0 P1 + 3 P2 | NOT CLEAR → r3 | Invalid bench flags (script doesn't have `--route`), stale baseline (3920 ms is pre-T-new-A2), §4.1 missing N-active row + "strictly tighter" claim. All absorbed. `.codex-r2-findings.txt`. |
| Karpathy audit (r2) | `/karpathy-audit` against the plan | Style + four principles re-check | 4/4 coverage; 0 critical + 2 warning + 1 nit | NOT CLEAR → r3 | 100 % overlap with codex r2 (W1 invalid-bench, W2 strictly-tighter, NIT failure-surface framing). Rising overlap per [[feedback-codex-catches-behavior-karpathy-catches-style]] — plan converging. |
| Codex consult (r3) | `/codex consult` | Re-verify swallow wrap, fixed bench commands, equivalence table | 0 P1 + 0 P2 | **PASS clean** | "r3 PASS clean." Verified: try/catch fallback routes correctly to heal; §4.1 complete; §7 runnable. |
| Karpathy audit (r3) | `/karpathy-audit` | Re-verify style on r3 | 4/4 coverage; 0 critical + 0 warning + 1 nit | **PASS clean** | Single optional nit on §7 instrumentation specificity. Coverage and structural quality clean. |
| Codex review (r3 diff) | `/codex review` against the branch diff | Formal PR-stage review with `high` reasoning + Codex's review-mode tuning | 0 P1 + 3 P2 | **GATE PASS** | All 3 P2 advisory: (a) Test 2 ESM spy strategy false-negative risk; (b) Test 3 assumed talks.test.ts coverage that doesn't exist; (c) §8 row #1 overstated safety. Absorbed in r4. |
| Codex review (r4 diff) | `/codex review` against the branch diff | Re-verify the absorption | 0 P1 + 3 P2 | **GATE PASS** | All 3 P2 polish-only: (a) header estimate stale; (b) §3.1 comment terminology regression; (c) Test 1 case-count mismatch with §6 C3. Absorbed in r5. |
| Codex review (r5 diff) | `/codex review` against the branch diff | Re-verify r5 absorption + check for new issues | 0 P1 + 0 P2 | **PASS clean** | "Clean: r5 absorbs the r4 polish items for the stale estimate, comment terminology, and Test 1 count mismatch. I did not find any new P1/P2 issues in the branch diff." Plan is PR-ready. |
