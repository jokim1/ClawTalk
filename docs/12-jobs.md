> **Status:** canonical (Jobs feature spec — resolves [DECISIONS.md](./DECISIONS.md) D6). Greenfield (D0). Schema lives in [11-data-model.md](./11-data-model.md) §8/§3; this doc owns the model + behavior.
> Precedence + orientation: [README.md](./README.md) · decisions: [DECISIONS.md](./DECISIONS.md) · terms: [GLOSSARY.md](./GLOSSARY.md).

# ClawTalk — Scheduled Jobs

A **Job** is a saved, scheduled run: a prompt + one agent + a schedule that fires inside a Talk and lands its output as a message and/or a pending Document edit. This doc is the D6 redesign — built from the requirements the current implementation proved out, rebuilt clean for the Workspace → Talk + Document model (no threads).

---

## 1. What jobs are for (requirements, distilled from the current build)

The shipped feature established the real requirements; the redesign keeps these and drops the rest:

- **Recurring single-agent prompt.** On a schedule, send a fixed prompt to one agent in a Talk and capture its answer. (One job kind — not a general workflow engine.)
- **Two schedule shapes that cover the need:** every-N-hours and weekly (weekdays + time), **timezone-aware** (DST-safe for wall-clock schedules). No raw cron in v1.
- **Unattended + safe.** Job runs are **read-only by default** — no state or external mutation, web/browser tools off unless explicitly allowed. A scheduled run must not take side-effecting actions on its own.
- **Reuse the run pipeline.** A fired job is just a run on the existing queue + executor + event stream — not a parallel execution path.
- **Self-healing lifecycle.** active / paused / blocked; a job that loses its agent goes `blocked` (not a crash loop); a failed _run_ doesn't break the job — it fires again next time.
- **Single-flight + no double-fire.** Never run two instances of the same job at once; never fire the same slot twice across scheduler ticks.

What the current build got wrong / carried as dead weight (removed here): a **dedicated thread per job** (threads are gone), **per-user** ownership (we're multi-workspace), dead `connectorIds`/`channelBindingIds` scope fields, a watermark-only claim that relies on cron ticks never overlapping, and a stuck-sweep that misses `queued` runs.

---

## 2. The model

A Job belongs to a **Talk** (and its Workspace) and targets **one agent** from that Talk's roster. When it fires:

1. The scheduler claims it (lease, §5) and creates a **run** on the Talk — a normal `conversation` run with `job_id` set and `trigger = 'scheduler'`. The prompt is appended as the triggering turn.
2. The run executes through the **standard queue → executor → event stream** (no special path).
3. The result lands per the job's **output targets** (§3).
4. Bookkeeping updates (`last_run_at`, `last_run_status`, `run_count`, next `next_due_at`); an Inbox item is raised.

A job is conceptually **"a saved run that fires itself."** No threads, no separate deliverable object — it produces a run, and runs already know how to land a message and/or propose a Document edit.

---

## 3. Output model (resolves the open D6 / roadmap-#7 question)

The old feature "always posts a thread message." With threads gone and Documents first-class, a job's output targets one or both of:

- **`talk_message`** _(default)_ — the agent's answer is appended to the **Talk** as a normal round, tagged with its `job_id` so the UI can group/collapse scheduled activity (this replaces the old dedicated-thread isolation with a tag, not a separate stream).
- **`document_append`** _(optional)_ — the answer is appended to the Talk's **primary Document** as a **pending edit** (`document_edits`, `source = 'job'`) through the _same_ unified accept path Forge uses. **Review-gated by default** (no autonomous overwrite — consistent with Forge's human-in-the-loop principle); a job may opt into `document_append_mode = 'auto_accept'` for trusted, low-stakes appends (e.g. a rolling log).

`output_targets` is a set, so a job can post to the Talk **and** propose a Document append in one fire. `document_append` requires the Talk to have a primary Document; if it doesn't, the job is `blocked` with `block_reason = 'no_primary_document'`.

This keeps the no-second-write-path rule: a job never mutates content directly — it proposes through `document_edits`, exactly like an agent or Forge.

---

## 4. Schedule

`schedule_json` is a small discriminated union, evaluated against a stored IANA `timezone`:

- **`{ kind: 'interval', every_hours: 1–24 }`** — fixed UTC interval (tz-independent).
- **`{ kind: 'daily', hour: 0–23, minute: 0–59 }`** — every day at local wall-clock.
- **`{ kind: 'weekly', weekdays: [0–6], hour, minute }`** — selected weekdays at local time.

Next-fire is a precomputed **`next_due_at`** watermark (not a live cron evaluator): on create/resume/after-fire, compute the next slot by stepping wall-clock minutes through `Intl.DateTimeFormat(timezone)` (DST-safe). Raw cron expressions are a deliberate non-goal for v1 — these three shapes cover the product need and stay legible.

**Catch-up policy** is explicit (the old code silently skipped missed fires): `catch_up = 'skip'` _(default — after downtime, jump to the next future slot)_ or `'run_once'` _(fire once on recovery, then resume)_. No multi-fire backfill.

---

## 5. Scheduler semantics (robustness — the redesign's real wins)

Driven by the existing every-minute cron tick (`scheduler.ts` mechanism is kept). Each tick:

1. **Claim due jobs with a lease.** `select … where status='active' and next_due_at <= now order by next_due_at for update skip locked limit N`, then set `claimed_at = now` and advance `next_due_at` to the next slot **in the same transaction**. `FOR UPDATE SKIP LOCKED` + the lease makes this safe under overlapping ticks and multiple workers — replacing the old watermark-only guard that assumed ticks never overlap.
2. **Single-flight per job.** Skip creating a run if the job already has a non-terminal run (`queued`/`running`/`awaiting`) — prevents a long job overrunning its interval or a manual run racing the scheduler.
3. **Create + dispatch** the run (§2) under the job's workspace/user context. On success, clear `claimed_at`.
4. **Sweep stuck runs** — reap runs stuck in `running` **and `queued`** past a threshold → `failed` (the old sweep missed `queued`, so a lost queue message could wedge a run forever).
5. **Sweep dropped claims** _(closes the step-1-commit / step-3-crash window)_. `select … where claimed_at < now - interval 'N minutes' and not exists (select 1 from runs where runs.job_id = jobs.id and runs.created_at > jobs.claimed_at)` — these are jobs whose claim committed in step 1 but whose run was never created (worker crashed, deploy mid-fire, OOM between commit and dispatch). For each, **back up `next_due_at` to the missed slot** (so the next tick re-fires it) and clear `claimed_at`. Threshold should be a few × the typical run-create latency (e.g. 2 minutes) — long enough that an in-flight dispatch doesn't get re-claimed, short enough that a dropped fire is recovered within one product cycle.

**Failure handling** stays layered: transient run failures retry at the queue/DLQ layer; a terminally failed _run_ does **not** pause or block the job — it just records `last_run_status='failed'` and fires again next slot. Only **dependency** failures (agent removed from the Talk, `document_append` with no primary Document) flip the job to `blocked` with a `block_reason`, requiring a user fix (no auto-unblock, no crash loop).

---

## 6. Lifecycle & surfacing

- **States:** `active` (has `next_due_at`) · `paused` (`next_due_at = null`, user-paused) · `blocked` (`next_due_at = null`, dependency issue + `block_reason`).
- **Bookkeeping:** `last_run_at`, `last_run_status`, `run_count`, denormalized on the job for fast list rendering; full history is `runs where job_id = …`.
- **Home/Inbox:** a finished job raises an Inbox item — `job_output_ready` (links to the message and/or pending edit) — and `job_blocked` when it trips a dependency. (Add these to the `inbox_items.type` set in `11` §7.)
- **Permissions:** managed by workspace members on the Talk; create/edit/pause/delete + a manual **Run now** (which respects single-flight). RLS scopes by workspace membership like everything else.

---

## 7. Schema

Lives in [11-data-model.md](./11-data-model.md): the `jobs` table (§8) and the `runs.job_id` + `runs.trigger` back-reference (§3). Job history is `runs` filtered by `job_id` — there is no separate `job_runs` ledger. Key columns: `workspace_id`, `talk_id`, `agent_id` (one agent, must be in the Talk roster), `prompt`, `schedule_json`, `timezone`, `output_targets text[]`, `document_append_mode`, `source_scope_json` (`{ allow_web, tool_ids[] }`), `status`, `block_reason`, `next_due_at`, `claimed_at`, `catch_up`, `last_run_at`, `last_run_status`, `run_count`.

---

## 8. Reuse vs. rewrite

- **Keep:** the every-minute cron tick, the run queue + executor + event stream, the read-only mutation lockdown for unattended runs, the timezone/DST-safe wall-clock stepping, single-flight.
- **Rewrite:** drop the per-job thread (tag turns instead); workspace-scope + membership RLS (was per-user); lease-based claim (was watermark-only); sweep `queued` too; drop dead connector/channel scope fields; output through `document_edits` instead of a `talk_outputs` report doc.

---

## 9. Open items

- **`source_scope_json`** should track the new tools model (`tool_ids` + `allow_web`) rather than the dead connector/channel fields — finalize once tools/connectors land (`11` §6).
- **Daily schedule** added beyond the old hourly/weekly — confirm it's wanted (low cost).
- **`auto_accept` document appends** — confirm the trust model (default is review-gated pending edits).
