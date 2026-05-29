# T-new-A2 followup — per-agent loop attribution + Option B target

**Status:** Open. Filed as the C-M4 / C8 deliverable from T-new-A2 r3 (SHIPPED 2026-05-29). No implementation work yet — this is the measured-evidence handoff so the next latency plan starts from data, not guesses.

**Tracking:** [[project-llm-turn-latency]], [[T-new-A2-enqueue-talk-turn-atomic]] §4.4 (deferred Option B), §4.5 (instrumentation that produced these numbers).

## Why this doc exists

T-new-A2's codex consult (C8 / C-M4) refused to defer the per-agent loop work without measured per-iteration attribution. The §4.5 N=3 haiku bench (n=10 trimmed, against instrumented prod build `5e0a5db4`) captured per-iteration sub-phase timings; this doc records them so any future Option B plan can target the right operand.

## Measured per-iteration cost (N=3 haiku, n=10 median + p95, all values ms)

| Sub-phase | iter 0 med | iter 0 p95 | iter 1 med | iter 1 p95 | iter 2 med | iter 2 p95 |
|---|---|---|---|---|---|---|
| `getRegisteredAgent` | 124.5 | 129 | 124.0 | 130 | 125.0 | 130 |
| `resolveCredentialKindSnapshot` | 249.0 | 258 | 248.5 | 258 | 248.5 | 261 |
| `createTalkRun` | 126.0 | 131 | 125.0 | 129 | 125.5 | 130 |
| **Iteration total** | **~500** | — | **~498** | — | **~499** | — |

Per-iteration cost is essentially flat across iterations (no measurable warming after iter 0). Aggregate loop cost scales linearly with N:
- N=1: ~500 ms in the loop.
- N=3: ~1494 ms in the loop.

For comparison, the rest of `enqueueTalkTurnAtomic` (pre-loop + post-loop) at N=3 ran ~1615 ms median (3109 ms total − 1494 ms loop). The loop is ~48 % of the function's wall time at N=3, ~16 % at N=1.

## Where the time goes inside the loop

The credential resolve is the dominant operand at **~250 ms per agent** (about 50 % of each iteration). Two of the three sub-phases (`getRegisteredAgent`, `createTalkRun`) are single 1-RT queries running at the prevailing Hyperdrive RT cost of ~125 ms — close to the floor of what a single tx-bound query achieves on this stack.

`resolveCredentialKindSnapshot` (see `src/clawtalk/db/accessors.ts` + the agent accessors it delegates to) issues 1-2 SELECTs per agent. With 2 RTs × ~125 ms = ~250 ms, the measured timing matches "always pays 2 RTs" rather than "sometimes pays 1, sometimes 2." That is the structural lever.

## Sketch of Option B candidates

This section is not a plan — it is a list of what a future plan would need to evaluate. Codex C-M1 still applies: postgres.js pipelining inside an async-callback tx is under-specified; Option D failed at the §4.5 gate for that exact reason. Don't trust speculation; measure.

1. **B-1 — batch the per-agent SELECTs across the loop.** Replace the N sequential `getRegisteredAgent` calls with one `SELECT ... WHERE id = ANY(${ids}::uuid[])`. Replace the N sequential `createTalkRun` inserts with one multi-row `INSERT ... VALUES (...), (...) RETURNING ...`. Predicted gain: (N−1) × 2 RTs ≈ (N−1) × 250 ms. **Caveat: N=1 saver is 0 ms.** Only useful when multi-agent fan-out is the common path.
2. **B-2 — pipeline `resolveCredentialKindSnapshot` across agents.** Run all N credential resolves via `Promise.all` *inside* the existing tx. Per the Option D measurement, this likely does NOT pipeline meaningfully (postgres.js serializes on the single tx connection). Pre-deploy instrumentation per the [[feedback-measure-before-locking-perf-plans]] discipline is mandatory — predicted gain is zero or near-zero without it.
3. **B-3 — collapse `resolveCredentialKindSnapshot` to one query per agent.** The function currently issues 1-2 SELECTs depending on the agent's `credential_mode`. If the second SELECT can be merged into the first (CTE or JOIN) the structural cost drops to ~125 ms per agent regardless of mode. This is the highest-confidence per-iteration win at N=1 — no fan-out assumption.
4. **B-4 — denormalize the credential snapshot onto the agent row.** If `registered_agents.credential_kind_snapshot` (or equivalent) can be kept fresh via trigger or write-time recompute, the loop's credential SELECT disappears entirely. Architecturally larger change; may collide with the credential-mode resolver's live-read invariant. Needs its own architecture review.

## Recommended next plan scope

Pick **B-3** as the standalone next plan unless multi-agent fan-out becomes the dominant workflow (in which case **B-1 + B-3** combined). B-2 should only run as a measurement under §4.5-style instrumentation; never ship without a passing gate. B-4 is out of band — bundle with a credential-resolver architecture review.

## Out-of-scope reminders

- **Active-round race (codex C-H2)** — still open from T-new-A2 r3. Fix is a tx-level advisory lock plan; orthogonal to the per-agent loop work.
- **`ensureTalkUsesUsableDefaultAgent` ~748 ms** — surfaced by T-new-A A2 instrumentation. Separate plan, larger lever than B-3 at N=1.
- **`preflight_iter_0` ~435 ms per agent** — codex C2 effective-tools graph. Lives in `enqueueTalkChat`, not `enqueueTalkTurnAtomic`. Different plan.

## Data location

Raw N=1 bench JSON: `/tmp/t-new-a2-bench-n1.json` (local, not checked in).
Raw N=3 bench JSON: `/tmp/t-new-a2-bench-n3.json` (local, not checked in).
Raw wrangler tail with sub_phase logs: `/tmp/wrangler-tail-t-new-a2.log` (local, not checked in).
Parser script: `/tmp/parse-t-new-a2-meta.py` (local, not checked in). Re-run with the bench JSON files in place to reproduce the medians.
