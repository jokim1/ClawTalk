# T-new-C — `ensureTalkUsesUsableDefaultAgent` happy-path early-exit

**Status:** Plan, **r1 draft**.
**Tracking:** [[project-llm-turn-latency]], [[T-new-A-chat-handler-parallelize]] (the §4.5 attribution that surfaced this).
**Branch (planning):** `docs/t-new-c-ensure-default-agent` (this doc).
**Branch (implementation, to be created):** `feature/t-new-c-ensure-default-agent`.
**Estimated effort:** ~2 h human / ~1.5 h CC.

---

## Revision history

- **r1 (2026-05-29, draft)** — initial draft. Awaiting codex + karpathy review.

---

## 1. Context

T-new-A's §4.5 attribution surfaced `ensureTalkUsesUsableDefaultAgent` at **~748 ms median** per call. The function is invoked from four hot-path routes (`src/clawtalk/web/routes/talks.ts:644, 1231, 1270, 1952`) — every `GET /talks/:id`, every `GET /talks/:id/agents`, every `POST /talks/:id/chat`. So this cost lands on essentially every authenticated talk-related request.

The function is a "best-effort healing" fixup: it ensures a talk has at least one assigned agent (the default), and that exactly one of them is marked `is_primary`. In steady state Joseph's talks all have healthy agent assignments, so the heal path is rarely taken — yet the full SELECT chain runs every time, on the happy path, just to confirm there's nothing to heal.

**The lever:** answer the healthy-state question with a single cheap SELECT, and skip the rest of the chain when the talk is already healthy.

This plan is plan-only. No code changes during planning. Implementation lives behind r-N codex+karpathy review per [[feedback-codex-catches-behavior-karpathy-catches-style]].

---

## 2. Surface inventory

### 2.1 The function (confirmed against current main)

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

### 2.2 The happy-path round-trip chain

Following the call chain into the accessors:

1. `getDefaultTalkAgentId()` (`agent-registry.ts:86`):
   - **SELECT** `settings_kv` for `system.defaultTalkAgentId` (via `getSettingValue`, `accessors.ts:3283`).
   - **SELECT** `registered_agents` for the candidate (via `getRegisteredAgent`, `agent-accessors.ts:244`).
2. Outer caller line 269: **SELECT** `registered_agents` AGAIN with the same ID — **redundant** with step 1's SELECT in the candidate-enabled branch; only meaningful in the main-agent-fallback branch (where `getDefaultTalkAgentId` falls through to `getMainAgentId()` without verifying enabled).
3. `getTalkAgentRows(talkId)` (`talk-agents.ts:225`):
   - Internally calls `pruneDeletedTalkAgentAssignments(talkId)` (`talk-agents.ts:303`):
     - **DELETE** `talk_agents` where `registered_agent_id IS NULL` (no-op on healthy talks, but the round-trip still happens).
     - **SELECT** `talk_agents` for remaining rows (the prune's primary-count check).
     - Optional **UPDATE** if primary count != 1 (heal path only).
   - Then **SELECT** `talk_agents` for the actual returned rows.

**Round-trip count on the happy path: 6** (3 settings/registered_agents SELECTs + 1 DELETE + 2 talk_agents SELECTs). At Joseph's measured ~125 ms p50 per Hyperdrive round trip, that's ~750 ms — matching T-new-A's attribution.

### 2.3 Callers (confirmed against current main)

All four sites in `src/clawtalk/web/routes/talks.ts`:

- `:644` — `listEffectiveTalkAgents` helper (consumed by `getTalkRoute` + `listTalkAgentsRoute`).
- `:1231` — `getTalkRoute` (the GET `/talks/:id` route).
- `:1270` — `listTalkAgentsRoute` (the GET `/talks/:id/agents` route).
- `:1952` — `sendChatRoute` (the POST `/talks/:id/chat` route — most latency-sensitive).

Per [[feedback-verify-schema-facts-in-plan-gates]] — every identifier above round-tripped through grep against current main (`af4206b`).

---

## 3. The fix — early-exit on healthy state

### 3.1 What changes

Add a single cheap accessor that answers "is this talk's agent set already healthy?" in 1 RT, and gate the rest of `ensureTalkUsesUsableDefaultAgent` behind it.

**New accessor** in `src/clawtalk/db/talk-agents.ts`:

```ts
export async function getTalkAgentsHealthSnapshot(
  talkId: string,
): Promise<{ activeCount: number; primaryCount: number }> {
  const db = getDbPg();
  const rows = await db<Array<{ active_count: string; primary_count: string }>>`
    select
      count(*) filter (where registered_agent_id is not null) as active_count,
      coalesce(sum((is_primary)::int), 0)                     as primary_count
    from public.talk_agents
    where talk_id = ${talkId}::uuid
  `;
  return {
    activeCount: Number(rows[0]?.active_count ?? 0),
    primaryCount: Number(rows[0]?.primary_count ?? 0),
  };
}
```

**Rewritten `ensureTalkUsesUsableDefaultAgent`**:

```ts
export async function ensureTalkUsesUsableDefaultAgent(
  talkId: string,
  ownerId: string,
): Promise<void> {
  const health = await getTalkAgentsHealthSnapshot(talkId);
  if (health.activeCount > 0 && health.primaryCount === 1) {
    return; // happy path: 1 RT total
  }
  // Healing path: existing logic, line-for-line, behind the gate.
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

- **Happy path** (talk already has ≥1 active agent with exactly one primary): 6 RT → 1 RT = **~625 ms saved per call.**
- **Heal path** (activeCount = 0 OR primaryCount != 1): 6 RT → 7 RT = ~125 ms regression. Acceptable — heal is rare and not in the user's latency budget.

Joseph's prod hit rate for healthy-path is gated by the §4.6 post-deploy bench, not assumed at plan time. If healthy-path turns out to be <50 % of calls (e.g. there's a previously unknown bug making talks unhealthy), the plan still delivers the structural saving on healthy ones, and the gap surfaces the actual bug.

### 3.3 What's NOT in this plan (deferred)

- **Dedupe `getDefaultTalkAgentId` → return the record, not just the ID.** Would save 1 more RT on the heal path. Deferred because heal path is rare and the change touches `getDefaultTalkAgentId`'s API contract (callers in other files).
- **Inline the heal-path `setTalkAgents` into the snapshot transaction.** Would save the round-trip cost of setting up the write transaction. Deferred — premature, and `setTalkAgents` is already used in many places with its own contract.
- **Replace `pruneDeletedTalkAgentAssignments`'s unconditional DELETE with a conditional one.** Same idea applied to `getTalkAgentRows`. Out of scope — that accessor has many callers and its internal contract is load-bearing elsewhere.

---

## 4. Risks and correctness

### 4.1 Health snapshot accuracy

The snapshot answers two questions:

- `activeCount` = "how many `talk_agents` rows have a non-null `registered_agent_id`?" — matches `pruneDeletedTalkAgentAssignments`'s delete predicate (line 309-313). If `activeCount > 0`, prune wouldn't have deleted anything anyway.
- `primaryCount` = "how many of those rows have `is_primary = true`?" — matches the post-prune invariant (line 322-324). If `primaryCount = 1`, the prune wouldn't have updated anything.

If both hold, `pruneDeletedTalkAgentAssignments` is a no-op and the rest of the function returns early at `rows.length === 0` check (which would be false since `activeCount > 0`). So the gate is logically equivalent to running the full chain and observing it was a no-op.

**Edge case:** if `talk_agents` has rows where `registered_agent_id IS NULL`, `activeCount` will not count them but `primaryCount` may include their `is_primary` if any. The gate would correctly route those into the heal path (because `activeCount` and `primaryCount` won't match the healthy invariant when `is_primary` is on a null-FK row). The heal path runs `pruneDeletedTalkAgentAssignments` which deletes those rows.

### 4.2 Concurrent mutation between snapshot and heal

If another request mutates `talk_agents` between the snapshot SELECT and a subsequent `setTalkAgents` write:

- Both paths run inside `withUserContext` per-row RLS (set on every connection), but not inside a single SQL transaction.
- `setTalkAgents` is full-replace ([[feedback-settalkagents-full_replace]]) — the last writer wins.
- The previous code had the same race (snapshot via `getTalkAgentRows` → write via `setTalkAgents`), so this plan does not introduce a new race. It preserves the existing best-effort-healing contract.

### 4.3 RLS surface

`talk_agents` has owner-scoped RLS (`0001_clawtalk_core.sql`-era policies). The new snapshot SELECT runs inside `withUserContext(auth.uid())`, so it inherits the same RLS scoping as the existing `getTalkAgentRows` call it replaces on the happy path. No new authorization surface.

### 4.4 What could break a previously-healthy talk's read

If the new SELECT returns the wrong shape (e.g. postgres.js coerces `count()` to BigInt and `Number()` overflows), the gate could mis-classify. The accessor's unit test (§5 Test 1) covers all four count combinations; the runtime coercion via `Number()` is the same pattern already used in `loadEnqueueTurnContext` and other accessors.

---

## 5. Tests

Three test files touched:

### Test 1 — `src/clawtalk/db/talk-agents.test.ts` (new)

`getTalkAgentsHealthSnapshot` returns correct counts across fixtures:

- empty `talk_agents` → `{ activeCount: 0, primaryCount: 0 }`
- 1 row, non-null FK, `is_primary=true` → `{ activeCount: 1, primaryCount: 1 }`
- 1 row, non-null FK, `is_primary=false` → `{ activeCount: 1, primaryCount: 0 }`
- 2 rows, both non-null, both primary (invalid state) → `{ activeCount: 2, primaryCount: 2 }`
- 1 row null FK + 1 row non-null primary → `{ activeCount: 1, primaryCount: 1 }`

(File does not exist yet; create using the `seedAuthUser` + `withUserContext` pattern from `accessors.test.ts:84-96, 119-141`.)

### Test 2 — `src/clawtalk/agents/agent-registry.test.ts` (extend)

`ensureTalkUsesUsableDefaultAgent`:

- **Healthy gate:** seed talk with 1 active primary agent → call function → assert `setTalkAgents` was NOT called AND `getDefaultTalkAgentId` was NOT called (via spies / mock counts on the underlying accessors).
- **Heal-path-on-empty:** seed talk with zero agents → call function → assert default agent was set.
- **Heal-path-on-broken-primary:** seed talk with 2 rows, 0 primary → call function → assert `pruneDeletedTalkAgentAssignments` ran (primary fixed via spy or post-condition check).

### Test 3 — `src/clawtalk/web/routes/talks.test.ts` (regression)

Existing four-caller happy-path tests must continue to pass without modification. Specifically the `sendChatRoute` test (the latency-sensitive caller) — confirms the gate doesn't break end-to-end /chat flow.

---

## 6. Implementation tasks

| Task | Files | Verify |
|---|---|---|
| **C1** Add `getTalkAgentsHealthSnapshot` accessor | `src/clawtalk/db/talk-agents.ts` (~25 LoC) | Unit test 1 passes |
| **C2** Rewrite `ensureTalkUsesUsableDefaultAgent` | `src/clawtalk/agents/agent-registry.ts:255` (gate added; existing logic preserved behind gate) | Unit test 2 passes |
| **C3** Tests | `src/clawtalk/db/talk-agents.test.ts` (new) + `src/clawtalk/agents/agent-registry.test.ts` (extend) | `npm run test` 1037+3 passes |
| **C4** Push PR. Run `/codex review` + `/karpathy-audit diff` on diff. Absorb findings. | n/a | both PASS clean |
| **C5** Deploy. Post-deploy bench: `t1-t0` should drop by ~625 ms for `/chat` requests (1 call per request). | n/a | bench n=10 confirms ≥500 ms median drop |

---

## 7. Post-deploy verification

Per [[feedback-measure-before-locking-perf-plans]]: T-new-A's §4.5 attribution already gave us the 748 ms baseline for this function, so we don't need pre-deploy instrumentation. The post-deploy bench validates the savings actually materialize.

**Success criteria** (matches the structural prediction):

1. `npx tsx scripts/latency-bench.ts --provider=haiku` (n=10, SPA tabs closed per [[feedback-close-clawtalk-tabs-before-bench]]):
   - **t1-t0 median drops by ≥500 ms** vs the post-T-new-A baseline (3920 ms).
   - **Predicted post-T-new-C: ~3300 ms** (3920 − 625 = 3295, allow 100 ms slack).
2. **Zero new error classes** in 24h prod logs after deploy.

If t1-t0 drops < 300 ms after deploy:

- The hypothesis ("healthy path is 99 % of calls") was wrong. File `T-new-C-followup.md` with the actual hit rate from `event_outbox` log analysis (compare healthy-gate-hit count vs heal-path-hit count over 24h).

---

## 8. Failure modes (new code paths only)

| Failure | Behavior | Recovery |
|---|---|---|
| `getTalkAgentsHealthSnapshot` SELECT throws | `ensureTalkUsesUsableDefaultAgent` throws → caller (talks.ts route) throws → 500 | Same as today's behavior when `getDefaultTalkAgentId` throws. |
| `postgres.js` coerces counts as strings (BigInt-via-string) | `Number()` coerces correctly; `Number('NaN')` → NaN → `> 0` is false → falls into heal path | Heal path runs the full chain; no user-visible breakage. |
| Snapshot reads stale row count under concurrent mutation | Same as today's race in the `getTalkAgentRows` path | No regression vs current behavior. |

---

## 9. Out of scope

- Dedupe `getDefaultTalkAgentId` to return the agent record (deferred — see §3.3).
- Inline heal-path write into snapshot transaction (deferred — see §3.3).
- `pruneDeletedTalkAgentAssignments` redesign (out of scope — accessor shared with other callers).
- `getRegisteredAgent` caching (separate plan, separate file).

---

## GSTACK REVIEW REPORT

| Review | Method | What it checked | Findings | Verdict | Notes |
|---|---|---|---|---|---|
| Codex consult (r1) | `/codex consult` | Behavior + framework-specific (Hyperdrive RT semantics, RLS, postgres.js coercion, race) | pending | pending | To run after this commit lands. |
| Karpathy audit (r1) | `/karpathy-audit diff` | Style + four principles | pending | pending | To run alongside codex r1. |

