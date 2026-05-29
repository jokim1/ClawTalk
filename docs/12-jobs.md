> **Status:** canonical (Jobs feature spec — resolves [DECISIONS.md](./DECISIONS.md) D6). Greenfield (D0). Schema lives in [11-data-model.md](./11-data-model.md) §3/§4/§5/§6/§7/§8; this doc owns the model + behavior.
> Precedence + orientation: [README.md](./README.md) · decisions: [DECISIONS.md](./DECISIONS.md) · terms: [GLOSSARY.md](./GLOSSARY.md).

# ClawTalk — Scheduled Jobs

A **Job** is a saved, scheduled run: a prompt + one agent + a schedule that fires inside a Talk and lands its output as a message and/or a pending Document edit. This doc is the D6 redesign — built from the requirements the shipped feature proved out, rebuilt clean for the Workspace → Talk + Document model (no threads).

---

## 1. What jobs are for (requirements, distilled from the current build)

The shipped feature established the real requirements; the redesign keeps these and drops the rest:

- **Recurring single-agent prompt.** On a schedule, send a fixed prompt to one agent in a Talk and capture its answer. One job kind — not a general workflow engine.
- **Three schedule shapes that cover the need:** every-N-hours (UTC interval), daily (local wall-clock + time), weekly (weekdays + time). **Timezone-aware, DST-safe** for wall-clock schedules. No raw cron in v1.
- **Unattended + safe.** Job runs are **read-only by default** — no state or external mutation, web/browser tools off unless explicitly allowed. A scheduled run must not take side-effecting actions on its own.
- **Reuse the run pipeline.** A fired job is just a row on the existing queue + executor + event stream — not a parallel execution path.
- **Self-healing lifecycle.** active / paused / blocked; a job that loses its agent goes `blocked` (not a crash loop); a failed _run_ doesn't break the job — it fires again next time.
- **Single-flight + no double-fire.** Never run two instances of the same job at once; never fire the same slot twice across scheduler ticks or queue replays.
- **Immutable history per job.** Past runs survive job lifecycle changes — archive yes, delete no (history is `runs filtered by job_id`).

**What the shipped build got wrong / carried as dead weight (removed here):** a dedicated `talk_thread` per job (threads are gone), per-user RLS (we're multi-workspace), dead `connectorIds`/`channelBindingIds` scope fields, a watermark-only claim that assumes ticks never overlap, a stuck-sweep that misses `queued` runs, prompt-as-`talk_message` (the job prompt now lives only in `jobs.prompt` and is captured per-fire via `run_prompt_snapshots`), report-as-`talk_outputs` (Documents are first-class — append goes through the unified `document_edits` path), `auto_accept` for doc appends (every job edit is review-gated, consistent with Forge's HITL principle).

---

## 2. The model

A Job belongs to a **Talk** (and its Workspace) and targets **one agent** from that Talk's roster. When it fires:

1. The scheduler claims it, freezes the Talk roster, and inserts a **run** on the Talk — a normal `conversation` run with `runs.job_id` set, `runs.trigger = 'scheduler'`, `runs.scheduled_for = <the slot timestamp>`, and `runs.prompt_snapshot_id` pointing at a fresh `run_prompt_snapshots` row that captures `jobs.prompt` verbatim at fire time.
2. **No triggering `messages` row is written.** Conversation runs from `/chat` write a user message and reference it via `runs.trigger_message_id`; scheduler/manual runs leave `trigger_message_id = NULL`. The job's prompt lives in the snapshot, not in the Talk's message stream — there is nothing for `messages.author_kind` to be (user/agent are the only values). The agent's reply is the only message produced by a job fire.
3. The run executes through the **standard queue → executor → event stream** (no special path). The executor reads the prompt from `runs.prompt_snapshot_id.prompt_text_redacted` — not from the live `jobs.prompt`, so editing the job mid-queue affects the NEXT fire, not the in-flight one.
4. The result lands per the job's **output targets** (§3).
5. Bookkeeping updates **only on terminal status** (`completed` / `failed`) via `markTalkJobRunFinished`: `last_run_at = run.finished_at`, `last_run_status`, `run_count++`, and the next slot's `next_due_at` (already advanced in the claim txn — see §5). An Inbox item is raised: `job_output_ready` on success (with `ref_id = run.id` for at-least-once dedup), `job_blocked` on dependency failure.

A job is conceptually **"a saved run that fires itself."** No threads, no separate deliverable object — it produces a run, and runs already know how to land a message and/or propose a Document edit.

### Mapping a scheduled run to the `runs` table (`11` §3)

When the scheduler inserts a run, it sets every required column per the §3 schema:

- `round = max(round) over (talk_id) at fire time + 1` (or `1` if the Talk has no rounds yet) — a scheduled fire starts its own round.
- `run_kind = 'conversation'`.
- `snapshot_group_id = <fresh group id, scheduler-generated>` — the roster freeze for this fire (a fresh group per run; the scheduler also inserts the `talk_agent_snapshots` rows for every agent in `talk_agents`).
- `agent_snapshot_id = <the targeted agent's snapshot id inside the new group>`.
- `model_id = <copied from the targeted agent's snapshot>`.
- `requested_by = jobs.created_by` (attribution-only; scheduler authorization comes from service-role + workspace scoping, not the creator's current membership).
- `trigger_message_id = NULL` (enforced by the `runs` CHECK).
- `job_id = <the firing job's id>`.
- `trigger = 'scheduler'` (or `'manual'` for run-now).
- `scheduled_for = <the slot timestamp the scheduler is firing>` (NULL for manual run-now — see §5).
- `response_group_id = <fresh>`, `sequence_index = 0`.
- `prompt_snapshot_id = <the new run_prompt_snapshots row's id>`.

The `runs` CHECK enforces this contract: `(trigger='user') OR (trigger in ('scheduler','manual') AND job_id is not null AND trigger_message_id is null AND prompt_snapshot_id is not null)`.

The `run_prompt_snapshots` insert is required-column-mapped per `11` §4: `workspace_id = job.workspace_id`, `run_id` (the new run's id), `talk_id = job.talk_id`, `agent_snapshot_id` (the targeted snapshot), `model_id` (from snapshot), `provider = (SELECT provider FROM llm_models WHERE id = model_id)` — `talk_agent_snapshots` has no `provider` column; provider lives on `llm_models`. `prompt_text_redacted = jobs.prompt`. Optional provenance fields (`global_policy_version`, `role_template_version`, `context_manifest_json`, `tool_manifest_json`, `prompt_hash`) are left NULL by the scheduler; the executor or a follow-up backfill can populate them.

---

## 3. Output

The shipped feature "always posts a thread message." With threads gone and Documents first-class, a job's output is controlled by two booleans on `jobs`:

- **`emit_talk_message bool not null default true`** — the agent's answer is appended to the **Talk** as a normal `author_kind='agent'` message, tagged with the firing run's `job_id` so the UI can group/collapse scheduled activity. (This replaces the shipped feature's per-job dedicated thread with a tag, not a separate stream.)
- **`emit_document_append bool not null default false`** — the answer is appended to the Talk's **primary Document** as a **pending `document_edits` row** (`source = 'job'`) through the unified accept path Forge uses. There is **no `auto_accept` mode** — every doc append is review-gated (consistent with §3's "no autonomous overwrite" rule and Forge's human-in-the-loop principle).

A schema CHECK requires `(emit_talk_message OR emit_document_append)` — a job must produce at least one output.

### What "primary Document" means

Primary doc per Talk is the existing `documents.primary_talk_id` reverse FK + the unique partial index at `11` §5 (0/1 primary doc per talk). This doc does **not** add a `talks.primary_document_id` column; that would create two sources of truth. The query is `SELECT * FROM documents WHERE primary_talk_id = job.talk_id`.

The primary tab inside the primary Document is the lowest-`sort_order` `doc_tabs` row for that document — `doc_tabs` has no "primary" flag.

### `document_edits` payload a job emits (cross-references `11` §5)

The executor INSERTs one `document_edits` row per successful run when `emit_document_append=true`:

- `workspace_id = job.workspace_id`, `document_id = <primary doc's id>`, `tab_id = <primary tab's id>`.
- `op = 'insert'` (the disk enum is `('insert','replace','delete')` — there is no `'insert_after'`).
- `block_id = NULL` (the op-shape check at `11` §5 requires `block_id is null` for `op='insert'`).
- `after_block_id = <last block of the primary tab by doc_blocks.sort_order, or NULL if the tab is empty>`. The check constraint allows `NULL`; the accept path materializes the block as the tab's first.
- `base_list_version = <doc_tabs.list_version at insert time>` (CAS; a concurrent reorder bumps the tab's version and marks this edit `superseded` on accept).
- `new_kind = 'p'` (the `doc_blocks.kind` enum at `11` §5 is `('h1','h2','p','li','meta','code')`).
- `new_text = <agent's reply content>`.
- `new_attrs_json = NULL`.
- `source = 'job'`.
- `proposed_by_run_id = <the run.id>`.
- `proposed_by_agent_id`: attempt INSERT with `<snapshot.source_agent_id>`. If the FK to live `agents` violates (the agent was deleted between snapshot and edit insert), retry the INSERT once with `proposed_by_agent_id = NULL`. Cheaper than `SELECT FOR KEY SHARE` on the agent row during the executor's LLM call.

### Multi-target failure: all-or-nothing

When both targets are set and the Talk has no primary Document, the job blocks (`status='blocked'`, `block_reason='no_primary_document'`) — even though `emit_talk_message` could fire on its own. This mirrors the existing "agent removed from roster" rule (one missing dependency blocks the whole job) and keeps the state machine uniform. Fail-loud beats half-broken.

Post-insert, the `document_edits.tab_id` and `after_block_id` FKs are `ON DELETE CASCADE`. If a user deletes the target tab or anchor block while a pending job edit is still pending, the row is silently cascaded out — v1 accepts this as feature (the user manually destroyed the target). Tracked in §9.

---

## 4. Schedule

`schedule_json` is a small discriminated union, evaluated against a stored IANA `timezone`:

- **`{ kind: 'interval', every_hours: 1..24 }`** — fixed UTC interval. Timezone-independent.
- **`{ kind: 'daily', hour: 0..23, minute: 0..59 }`** — every day at local wall-clock.
- **`{ kind: 'weekly', weekdays: [0..6], hour: 0..23, minute: 0..59 }`** — selected weekdays at local time (0 = Sunday, IANA convention).

The next fire is a precomputed `next_due_at timestamptz` watermark — not a live cron evaluator. On create / resume / after-fire, the scheduler computes the next slot by stepping wall-clock minutes through `Intl.DateTimeFormat(timezone)` and storing the result.

### Anchors

- **`interval`** anchors on `jobs.created_at`: next slot = `created_at + N * every_hours`, advancing forward until the slot is after `now`.
- **`daily`** / **`weekly`** anchor on the wall-clock time the user specified, in the job's stored timezone.

### DST policy (resolves the shipped feature's "whatever Intl does" gap)

- **Spring-forward gap** (a nonexistent local time, e.g. 02:30 on a day the clock jumps 02:00 → 03:00): the slot is skipped. The scheduler's next-slot computation advances past the gap to the next valid local-time slot.
- **Fall-back overlap** (a duplicated local time, e.g. 01:30 on a day the clock jumps 02:00 → 01:00): **the scheduler explicitly picks the FIRST UTC occurrence** and advances past both. The second UTC instant is skipped by the slot computation. (We do not rely on `unique (job_id, scheduled_for)` to dedup — the two occurrences are different UTC instants, so the index would not catch them.)

Both rules are testable in §14 with no third-party tz library required (just Intl + careful timestamp arithmetic).

### Catch-up policy

`catch_up text not null default 'skip' check (catch_up in ('skip','run_once'))` resolves the shipped feature's silent skip:

- **`skip`** _(default)_ — after downtime, the scheduler advances `next_due_at` to the next future slot. Missed slots are not re-fired.
- **`run_once`** — on the first tick where `next_due_at < now - <one slot interval>`, fire exactly once with `scheduled_for = next_due_at` (the missed slot), then advance to the next future slot. The slot-identity unique index makes re-runs impossible even if a recovery tick races a normal tick.

No multi-fire backfill: a job that missed 12 hours of slots does not produce 12 runs.

---

## 5. Scheduler semantics (robustness — the redesign's real wins)

Driven by the existing every-minute cron tick (`scheduler.ts` mechanism is kept; the implementation is reworked against the new schema). Each tick runs two independent paths:

### Path A — Process due jobs

`for update skip locked` read of jobs where `status='active' AND archived_at is null AND next_due_at <= now`. Per claimed job, ONE database transaction with the following ordered sub-steps; failure at any sub-step aborts the txn and leaves the job unchanged:

1. **Single-flight check.** If the partial unique index `runs_one_active_per_job` (`runs(job_id) where status in ('queued','running','awaiting')`) would reject because a non-terminal run already exists, this slot is being held by an earlier run that hasn't terminated yet. Behavior depends on `catch_up`:
   - **`catch_up = 'skip'` (default):** advance `next_due_at` to the next future slot (skipping all slots that elapsed while the prior run was in flight), clear `claimed_at`, COMMIT. No new run is inserted. This prevents a long-running run from causing its own catch-up fire when it finishes (a job whose run takes 3 hours on an hourly schedule should not fire 3 missed slots once the prior run completes).
   - **`catch_up = 'run_once'`:** leave `next_due_at` unchanged and ABORT the txn. When the prior run terminates, the next tick re-evaluates and the missed slot fires per §4's `run_once` rule.

2. **Fire-time dependency check.** Verify:
   - The targeted agent (`jobs.agent_id`) is in `talk_agents(workspace_id, talk_id, agent_id)`.
   - The agent's `model_id` references an enabled `llm_models` row.
   - If `emit_document_append = true`: `SELECT 1 FROM documents WHERE primary_talk_id = job.talk_id` returns a row.
   - Every entry in `source_scope_json.tool_ids` has a matching enabled `talk_tools(workspace_id, talk_id, tool_id, enabled=true)` row.
   - For each tool that the static `tool_id → required_service` catalog (`11` §6) says depends on a connector, the corresponding `connectors(workspace_id, service, authorized=true)` row exists. A tool that's toggled on in `talk_tools` but whose service connector is unauthorized would fail at executor time with no actionable signal; checking it here turns the failure into a deterministic block.

   ANY failure → `UPDATE jobs SET status='blocked', block_reason=<the specific reason>, next_due_at=NULL, claimed_at=NULL` + `INSERT INTO inbox_items (workspace_id, type, ref_id, ...) VALUES (..., 'job_blocked', NULL, ...)` — both in the SAME transaction. COMMIT. No snapshots, no `runs` row, no queue dispatch. Path A ends for this job. The next tick will see `status='blocked'` and skip claim entirely.

   `block_reason` values: `agent_missing`, `model_disabled`, `no_primary_document`, `tool_not_enabled`, `connector_not_authorized`.

3. **Pre-generate UUIDs.** `run_id`, `snapshot_id` (for `run_prompt_snapshots`), `snapshot_group_id`, and one `agent_snapshot_id` per agent currently in the Talk's roster.
4. **Freeze roster.** Read current `talk_agents` for the Talk. For each agent, INSERT a `talk_agent_snapshots` row with the shared `snapshot_group_id`, a unique pre-generated `id`, `source_agent_id = <the live agent's id>`, and the snapshot fields per `11` §4 (role_key, model_id, temperature, persona, focus, name, handle, initials, accent — copied from the live agent). Required before the `runs` INSERT because the `runs(workspace_id, talk_id, snapshot_group_id, agent_snapshot_id)` composite FK is non-deferrable.
5. `SET CONSTRAINTS ALL DEFERRED` — the `runs.prompt_snapshot_id` back-edge FK is deferrable; deferring it lets the scheduler insert `runs` first with the future snapshot id.
6. **INSERT `runs`** with the full §2 mapping: `id = run_id`, `prompt_snapshot_id = snapshot_id`, `snapshot_group_id`, `agent_snapshot_id = <targeted snapshot's id>`, `trigger='scheduler'`, `scheduled_for = slot`, `requested_by = jobs.created_by`, `round = max(round)+1 over (talk_id) or 1`, `trigger_message_id = NULL`, `job_id = job.id`, `model_id = <from snapshot>`, `response_group_id = <fresh>`, `sequence_index = 0`, `status = 'queued'`.
7. **INSERT `run_prompt_snapshots`** with the required column mapping from §2 (workspace_id, run_id, talk_id, agent_snapshot_id, model_id, provider from `llm_models`, prompt_text_redacted = `jobs.prompt`). Optional provenance fields left NULL.
8. **UPDATE `jobs`** set `next_due_at = <advance(slot)>`, `claimed_at = NULL`. Do NOT touch `last_run_status` here — bookkeeping is terminal-only (see §6).
9. **COMMIT.** The deferred FK on `runs.prompt_snapshot_id` validates now that the snapshot row exists.
10. **Dispatch to queue** (`TALK_RUN_QUEUE.send({ runId })`) OUTSIDE the transaction. If dispatch fails or the worker crashes between commit and dispatch, the existing stuck-`queued` sweep (Path B) catches the orphan run.

**No separate dropped-claim recovery.** Under this single-txn model, `claimed_at` is always cleared in the same commit that inserts the run. If the txn rolls back, `claimed_at` also rolls back — there is no committed-but-orphaned `claimed_at` to clean up. The stuck-queued sweep handles every remaining stuck-state class.

### Path B — Stuck-run sweep

Independent of Path A; runs every tick. Two thresholds:

- `runs.status = 'queued'` AND `runs.created_at < now - 5 min` → transition to `failed`, set `error_json = '{"code":"stuck_queued_swept"}'`, `finished_at = now`. The 5-minute threshold is well past p99 queue fan-out latency.
- `runs.status = 'running'` AND `runs.started_at < now - 1 hour` → transition to `failed`, set `error_json = '{"code":"stuck_running_swept"}'`, `finished_at = now`.

`runs.status = 'awaiting'` is NEVER swept — `awaiting` means the user (or Forge) is intentionally holding the run, not that it's stuck. Sweep doesn't apply.

Both sweep paths call `markTalkJobRunFinished` (terminal bookkeeping in §6) and emit the appropriate Inbox event.

### Queue idempotency

`TALK_RUN_QUEUE` is at-least-once and can deliver concurrently. The consumer's claim is atomic:

```sql
update runs
set status = 'running', started_at = now()
where id = $1 and status = 'queued'
returning *;
```

If the returning clause yields no row, another consumer (or a stuck-sweep) already won the race. The delivery is ack'd and dropped. Serial replay after completion is also a no-op (status is `completed`/`failed`/`awaiting`, not `queued`).

The unique `(job_id, scheduled_for)` partial index protects the upstream scheduler-side race: if two scheduler ticks (same minute, slow tick + fast tick) both reach §5 step 6 for the same slot, the second INSERT hits the index and rolls back the entire txn. No double-fire, no application-side coordination.

### Failure handling layers

- **Transient run failures** retry at the queue/DLQ layer (existing infrastructure). A terminally-failed run does NOT pause or block the job — it just records `last_run_status='failed'` and fires again next slot.
- **Dependency failures** (agent gone, primary doc gone, tool disabled) flip the job to `blocked` with a `block_reason`. No auto-unblock; the user must edit the job (see §6).
- **Worker crashes** mid-claim-txn are absorbed by the txn rollback (no claim landed in the DB). Mid-run-execution crashes leave the run in `queued`/`running` until Path B sweeps it.

---

## 6. Lifecycle & surfacing

### States

- **`active`** — `next_due_at not null`. Scheduler will claim on the next tick where `next_due_at <= now`.
- **`paused`** — `next_due_at = null`. User-paused; resume recomputes `next_due_at` from `now`.
- **`blocked`** — `next_due_at = null`, `block_reason` set. Dependency missing; manual unblock required (see below).

A schema CHECK enforces the invariant: `(archived_at is not null) OR (status='active' AND next_due_at is not null) OR (status in ('paused','blocked') AND next_due_at is null)`.

### Archive (orthogonal to status)

`archived_at timestamptz` is a separate lifecycle dimension. The UI "Delete" action calls an archive endpoint that sets `archived_at = now()` and `next_due_at = NULL`. Archived rows:

- Are excluded from list endpoints via the `jobs_active` view (`WITH (security_invoker = true)` — RLS-preserving).
- Are skipped by the scheduler's claim query (archive-aware index: `jobs(status, next_due_at) where status='active' and archived_at is null`).
- Are read-only — no further edits accepted.
- Keep their run history queryable: `SELECT * FROM runs WHERE job_id = <archived_job.id>` still works because `runs.job_id` is `ON DELETE RESTRICT` (so hard-delete on a job with `run_count > 0` is rejected; the only path to removing run history is admin-only and out of scope here).

### Bookkeeping (terminal-only)

`last_run_at`, `last_run_status`, and `run_count` are written **only** by `markTalkJobRunFinished` when a run reaches a terminal status (`completed` or `failed`, including stuck-swept failures). The scheduler does NOT touch them at run-insert time; in-flight state is observable via the `runs` table directly. Manual run-now follows the same rule.

- `last_run_at = run.finished_at`.
- `last_run_status` = `'completed'` or `'failed'` (no `'queued'`, no `'running'`).
- `run_count` is incremented on every terminal status — including stuck-swept failures, which ARE terminal `failed` (no special case).

### Unblock path (event-driven for v1)

When a user edits a `blocked` job (assigns a new agent, attaches a primary doc, enables the missing tool), the API handler re-runs the dependency check from §5 step 2 at save time. If all deps pass, the handler flips `status='active'`, recomputes `next_due_at = next slot from now`, and clears `block_reason`. If any check still fails, the edit succeeds but `block_reason` is updated to the new failure (so the user sees what's still missing).

Periodic scheduler-side recheck (auto-unblock when a dep heals via a different code path, e.g. an agent re-added to the Talk roster) is deferred to §9 — for v1, the user re-opening the job is the trigger.

### Manual run-now

A dedicated route (`POST /api/v1/talks/{talkId}/jobs/{jobId}/run-now`) creates a `trigger='manual'` run. Semantics:

- `trigger = 'manual'`, `scheduled_for = NULL` (manual runs don't claim a slot — the scheduler doesn't fire them).
- `prompt_snapshot_id` is a fresh snapshot of the current `jobs.prompt` at run-now time (same path as scheduler, different trigger value).
- `requested_by = <the calling user>` (not `jobs.created_by` — manual runs are real human triggers).
- `round = max(round)+1 over (talk_id)`.
- `runs_one_active_per_job` enforces single-flight: if a non-terminal run already exists, the route returns 409 busy without creating a second run.
- Allowed when `status in ('active','paused')`; rejected (400) when `status = 'blocked'` (fix the dep first).
- Bookkeeping is terminal-only — manual runs increment `run_count` and update `last_run_*` via `markTalkJobRunFinished`, same as scheduler runs.

### Inbox surfacing

- **`job_output_ready`** — emitted by the queue consumer on successful run completion. `ref_id = run.id`. The unique `(workspace_id, type, ref_id)` partial index dedups at-least-once retries from the queue path.
- **`job_blocked`** — emitted by the scheduler **synchronously** in the same transaction as the `jobs.status='blocked'` transition. `ref_id = NULL`. No retry surface and no idempotency need; each new block episode produces a distinct inbox row (a job that blocks, unblocks via user edit, then blocks again writes two separate `job_blocked` rows — intentional).

### Permissions

Jobs are managed by workspace members on the Talk: create / edit / pause / archive / manual run-now. RLS scopes by workspace membership like every other workspace-owned resource. The scheduler runs with service-role auth (no `auth.uid()`); accessors scope explicitly by `workspace_id`.

---

## 7. Schema (summary; full DDL in [11-data-model.md](./11-data-model.md))

This doc owns behavior; `11` owns the DDL. Key column-deltas from the shipped `talk_jobs` shape:

- **Add to `jobs`** (`11` §8): `workspace_id` (replaces shipped `owner_id` for tenancy), `emit_talk_message bool`, `emit_document_append bool` + CHECK at-least-one, `archived_at timestamptz`, lifecycle CHECK per §6, `jobs_active` view with `security_invoker = true`.
- **Drop from `jobs`**: `thread_id` (threads gone), `deliverable_kind`, `report_output_id`, `output_targets text[]`, `document_append_mode`, dead `connectorIds`/`channelBindingIds` keys inside `source_scope_json`.
- **Tighten `source_scope_json`** to the typed shape `{ allow_web: bool, tool_ids: text[] }`. `tool_ids` validates against `talk_tools.tool_id text` at fire time (§5 Path A step 2).
- **`block_reason text`** — known values documented: `agent_missing`, `model_disabled`, `no_primary_document`, `tool_not_enabled`, `connector_not_authorized`. Free text allows future reasons without migration; the documented set is the UI contract.
- **Add to `runs`** (`11` §3): `scheduled_for timestamptz`, the CHECK invariant for scheduler/manual runs, and a partial unique `(job_id, scheduled_for) where job_id is not null and scheduled_for is not null` for slot dedup. Change `runs.job_id` FK from `on delete set null (job_id)` to `on delete restrict` so history survives job archive.
- **Add to `inbox_items`** (`11` §7): `ref_id uuid` + partial unique `(workspace_id, type, ref_id) where ref_id is not null`.

`run_prompt_snapshots` (`11` §4) and `documents.primary_talk_id` (`11` §5) are **reused unchanged**. There is no new `talks.primary_document_id` column — the existing reverse FK + unique partial index in `11` §5 is the source of truth.

---

## 8. Reuse vs. rewrite

- **Keep:** the every-minute cron tick, the run queue + executor + event stream, the read-only mutation lockdown for unattended runs, the timezone/DST-safe wall-clock stepping via `Intl.DateTimeFormat`, single-flight via `runs_one_active_per_job`, the existing `run_prompt_snapshots` table (reused for jobs unchanged), the existing `documents.primary_talk_id` reverse FK, the existing `document_edits` accept path used by Forge.
- **Rewrite:** drop the per-job dedicated `talk_thread` (the shipped feature wrote one per job; now the run is tagged with `job_id` and that's the only grouping); replace per-user RLS with workspace-membership RLS; replace watermark-only claim with a single-transaction claim that inserts run + advances `next_due_at` + clears `claimed_at` atomically (no separate dropped-claim recovery sweep needed); sweep `queued` AND `running` in the stuck-sweep; drop the trigger-message convention (no `messages` row written for the fire; prompt lives only in `runs.prompt_snapshot_id`); drop the `talk_outputs` report path; drop `auto_accept` for doc appends (always pending); narrow `source_scope_json` to the typed `{allow_web, tool_ids}` shape and validate at fire time.

---

## 9. Open items

- **Scheduler-periodic recheck for blocked-job auto-unblock.** v1 unblocks only on user edit (§6). If user telemetry shows blocked jobs sitting un-noticed because the dep healed via a different route (e.g. an agent re-added to the roster via Talk-edit UI), add a cheap periodic recheck (`SELECT id FROM jobs WHERE status='blocked' AND archived_at IS NULL LIMIT N` per tick → re-run dep check → auto-unblock if all pass).
- **Notification surface for `job_blocked`.** v1 raises an Inbox item only. Email/push is a follow-up product call.
- **Un-archive UI.** v1 has no path to revive an archived job. The data supports it (`archived_at = NULL` + recompute `next_due_at`), but the UI is deferred.
- **Post-insert tab/anchor cascade.** `document_edits.tab_id` and `after_block_id` FKs are `ON DELETE CASCADE` at `11` §5. If a user deletes the target tab or anchor block while a job-emitted edit is still pending, the row is silently cascaded out. v1 accepts this as feature (the user manually destroyed the target — surfacing a "the thing you destroyed got destroyed" notification is noise). Revisit if telemetry shows real loss.

---

## 14. Verification (per-feature tests — referenced from `11` §14)

1. **Slot-dedup against scheduler race.** Two scheduler ticks claim the same job concurrently for the same slot; the second `runs` INSERT hits `unique(job_id, scheduled_for)` and rolls back. One run, one slot consumed.
2. **Single-flight dedup.** Manual `run-now` while a scheduler-triggered run is `queued`; `runs_one_active_per_job` rejects the second insert; the route returns 409 busy.
3. **Queue dedup via atomic claim.** Replay an at-least-once queue message for an already-completed run; the consumer's `update runs set status='running' where id=$1 and status='queued' returning *` returns no row because status is `completed`; consumer acks and drops. Same path covers two concurrent deliveries (see #18).
4. **Single-txn safety.** Kill the worker mid-claim-txn before commit; the txn rolls back (no run row, `claimed_at` rolled back, `next_due_at` unchanged); next tick re-claims naturally.
5. **DST spring-forward gap.** A daily 02:30 job on a transition day skips the gap (next fire at 02:30 the following day).
6. **DST fall-back overlap.** A daily 01:30 job on a fall-back day fires exactly ONCE at the earlier UTC instant; at the later UTC instant the scheduler finds `next_due_at > now` and does not claim.
7. **Stuck-`queued` sweep.** Stuck queued past 5 min → `failed` with `error_json={"code":"stuck_queued_swept"}` and `finished_at = now`; `run_count++`, `last_run_status='failed'`.
8. **Fire-time dependency blocking.** Remove the agent from `talk_agents`; next tick flips the job to `blocked` with `block_reason='agent_missing'`; no run inserted.
9. **Multi-target all-or-nothing.** Unset `documents.primary_talk_id` for the Talk; next fire blocks with `block_reason='no_primary_document'`; no message posts.
10. **Manual Run-now respects single-flight.** While a non-terminal run exists, `run-now` returns 409 busy without creating a second run.
11. **Archive semantics.** Archived job excluded from `jobs_active` view and from the scheduler's claim query; past runs queryable by `job_id`; lifecycle invariant CHECK passes (`archived_at` populated → invariant satisfied regardless of status/next_due_at).
12. **Inbox idempotency for `job_output_ready`.** Replay the consumer's completion path; second `inbox_items` INSERT hits the unique `(workspace_id, type, ref_id)` index; no duplicate.
13. **`block_reason='no_primary_document'` specifically.** Delete the primary doc; verify the exact `block_reason` value (not just a generic block).
14. **Prompt snapshot immutability.** Insert a scheduler run with a snapshot; edit `jobs.prompt`; let the run execute; the executor reads the snapshot's `prompt_text_redacted`, not the new `jobs.prompt`.
15. **Tool-id validation.** Configure a job with `source_scope_json.tool_ids` containing an entry not enabled in `talk_tools`; next fire blocks with `block_reason='tool_not_enabled'`.
16. **`runs.job_id RESTRICT`.** Attempt to hard-delete a job with `run_count > 0`; the FK rejects. The archive path succeeds (sets `archived_at`).
17. **Empty primary tab append.** Primary doc has zero blocks in its primary tab; the executor emits `document_edits` with `after_block_id=NULL`; the row commits (op-shape check allows it); the accept path materializes the block as the tab's first.
18. **Concurrent queue delivery.** Simulate two consumer workers delivering the same queued `run.id` concurrently; one consumer's atomic `update runs set status='running' where id=$1 and status='queued' returning *` returns a row; the other returns empty; only one executor proceeds.
19. **Repeat-block inbox.** Block a job (run A's dep check) → unblock via user edit → block again (run B's dep check). Two distinct `job_blocked` inbox rows exist (both with `ref_id=NULL`). The second block is NOT suppressed.
20. **Tab deleted between executor selection and edit insert.** The executor selects `tab_id`; a concurrent operation deletes that tab (the document still has ≥1 tab — the last-tab trigger at `11` §5 enforces this); the executor's `document_edits` INSERT with the now-stale `tab_id` hits the composite FK and rejects; the run transitions to `failed` with `error_json={"code":"tab_gone"}`. (If the deleted tab was the document's last tab, the trigger rejects the delete instead — this test exercises the non-last-tab case.)
21. **Anchor block deleted between selection and edit insert.** The executor selects `after_block_id = <last block>`; that block is deleted before the `document_edits` INSERT; the composite FK at `11` §5 rejects; the run transitions to `failed` with `error_json={"code":"anchor_block_gone"}`. The next scheduled fire re-selects the new last block.
22. **Connector unauthorized blocks the job.** Configure a job with `source_scope_json.tool_ids = ['gdrive-read']` and the `gdrive` connector NOT authorized (`connectors.authorized = false`); next fire blocks with `block_reason='connector_not_authorized'`; no run is inserted. Authorizing the connector + editing the job clears the block.
23. **Long-running run + `catch_up='skip'` does not catch up.** Start a scheduled run on an hourly job; let it run for 3 hours; on every tick during the run, the scheduler advances `next_due_at` to the next future slot (skipping the missed ones) instead of holding the slot. When the run finally completes, the next fire is at the next future slot, not 3 backfilled slots.
24. **Long-running run + `catch_up='run_once'` fires the missed slot.** Same setup but `catch_up='run_once'`. During the long run, ticks ABORT without advancing `next_due_at`. When the run terminates, the next tick fires the missed slot exactly once (with `scheduled_for = the original missed slot timestamp`), then advances past it.
25. **Disabled model blocks the job.** Set the targeted agent's `model_id` to point at an `llm_models` row with `enabled=false`; next fire blocks with `block_reason='model_disabled'`; no run is inserted. Re-enabling the model (or pointing the agent at an enabled model) + editing the job clears the block.
