// Cron-trigger scheduler (Queues port U4).
//
// Replaces the Node-mode `TalkJobWorker` polling loop. The scheduled()
// handler in `src/worker.ts` fires every minute (`* * * * *` in
// wrangler.toml [triggers]); each tick claims due jobs, creates a
// trigger run + message for each, and dispatches the run onto the
// TALK_RUN_QUEUE. The same tick also sweeps `running` rows whose
// started_at is older than the stuck-run threshold — a long-tail
// safety net for messages that DLQ'd before the consumer reached a
// terminal status flip.
//
// Both passes run inside withRequestScopedDb so dispatchRun and the
// outbox notify path see the Worker env bindings.

import {
  getDbPg,
  withRequestScopedDb,
  withUserContext,
  type DbScopeEnvBindings,
  type RequestExecutionContext,
} from '../../db.js';
import {
  failRunAndPromoteNextAtomic,
  findNextRunnableOrderedSibling,
  listStrandedOrderedSiblings,
} from '../db/accessors.js';
import {
  advanceTalkJobNextDueAt,
  claimDueTalkJobs,
  createJobTriggerRun,
} from '../db/job-accessors.js';
import { logger } from '../../logger.js';

import { dispatchRun } from './queue-producer.js';

// Number of due jobs to claim per tick. Cron fires every minute, so
// even at 10/tick we sustain 14 400 jobs/day before backlog grows.
const JOB_CLAIM_BATCH_SIZE = 10;

// Sweep threshold for the stuck-running sweep. Any talk_run still
// reporting status='running' after this window is assumed dead
// (consumer crashed mid-execution and either the queue retry chain
// dead-lettered the message or the consumer's failRunAtomic also
// crashed). The cron-tick safety net flips it to 'failed' with the
// stuck_running_swept error code so the UI moves on.
//
// 1 hour matches Cloudflare Workers' max scheduled-handler duration
// + a comfortable buffer. Tighter sweeps risk killing legitimately
// long LLM calls.
const STUCK_RUN_THRESHOLD_MS = 60 * 60 * 1000;

// Per-tick sweep cap. If a flood of stuck runs accumulates, we don't
// want a single tick to exhaust the scheduled() handler's CPU budget
// trying to clean them all up. Subsequent ticks chew through the
// rest.
const STUCK_RUN_SWEEP_LIMIT = 100;

// Grace window for the stranded-ordered-sibling sweep. A queued ordered
// step whose blockers are all terminal should be claimed within seconds of
// the consumer's active promotion dispatch. We only re-dispatch one whose
// newest blocker finished longer ago than this, so the sweep never races a
// promotion still in normal flight. 2 min clears Cloudflare Queues'
// sub-second-to-seconds delivery with wide margin.
const STRANDED_SIBLING_GRACE_MS = 2 * 60 * 1000;
const STRANDED_SIBLING_SWEEP_LIMIT = 100;

export interface ScheduledTickEnv extends DbScopeEnvBindings {
  DB: { connectionString: string };
}

/**
 * One scheduled-handler iteration. Opens the request scope so
 * dispatchRun, outbox notify, and the W7-evtsse streaming coalescer
 * all have working bindings.
 */
export async function runScheduledTick(
  env: ScheduledTickEnv,
  ctx: RequestExecutionContext,
): Promise<void> {
  return withRequestScopedDb(env.DB.connectionString, ctx, env, async () => {
    await processClaimableJobs();
    await sweepStuckRunningRuns();
    await sweepStrandedOrderedSiblings();
  });
}

export async function processClaimableJobs(): Promise<void> {
  let claimed;
  try {
    claimed = await claimDueTalkJobs(JOB_CLAIM_BATCH_SIZE);
  } catch (err) {
    logger.error({ err }, 'scheduler: claimDueTalkJobs threw');
    return;
  }

  for (const job of claimed) {
    try {
      const result = await withUserContext(job.ownerId, () =>
        createJobTriggerRun({
          ownerId: job.ownerId,
          jobId: job.id,
          triggerSource: 'scheduler',
        }),
      );
      // T-new-AR: only 'thread_busy' retries on the next tick (the
      // /chat or other job that holds the thread lock will release
      // within seconds). Every other terminal status consumes the
      // tick by advancing next_due_at — matching the pre-T-new-AR
      // claim-time advance for job_busy/paused/not_found/blocked,
      // and adding the same for the new enqueued path.
      switch (result.status) {
        case 'enqueued':
          await withUserContext(job.ownerId, () =>
            advanceTalkJobNextDueAt(job),
          );
          await dispatchRun({ runId: result.runId });
          break;
        case 'thread_busy':
          // Leave next_due_at unchanged — next scheduler tick retries
          // the same occurrence. Silent (no warn) — short-lived
          // contention is expected.
          break;
        case 'blocked':
          // Do NOT advance — createJobTriggerRun's dependency-block
          // path already set next_due_at = NULL and status = 'blocked'.
          // Advancing here would restore a future due time on a
          // blocked row, making it appear scheduled. The blocked
          // status itself excludes the job from claimDueTalkJobs'
          // WHERE j.status = 'active' filter, so it won't re-fire
          // until manually unblocked.
          logger.warn(
            {
              jobId: job.id,
              talkId: job.talkId,
              issue: result.issue,
            },
            'scheduler: due job blocked by dependency',
          );
          break;
        case 'job_busy':
        case 'paused':
        case 'not_found':
          // Consume the tick (matches pre-T-new-AR behavior). Silent —
          // these states are expected at scheduler edges: 'job_busy' (a
          // manual run-now beat us), 'paused' (toggled between claim +
          // create), 'not_found' (deleted).
          await withUserContext(job.ownerId, () =>
            advanceTalkJobNextDueAt(job),
          );
          break;
      }
    } catch (err) {
      logger.error(
        { err, jobId: job.id },
        'scheduler: createJobTriggerRun threw',
      );
    }
  }
}

async function sweepStuckRunningRuns(): Promise<void> {
  const threshold = new Date(Date.now() - STUCK_RUN_THRESHOLD_MS).toISOString();
  let stuck: Array<{
    id: string;
    owner_id: string;
    response_group_id: string | null;
  }>;
  try {
    const db = getDbPg();
    stuck = await db<
      Array<{ id: string; owner_id: string; response_group_id: string | null }>
    >`
      select id, owner_id, response_group_id from public.talk_runs
      where status = 'running'
        and started_at is not null
        and started_at < ${threshold}::timestamptz
      order by started_at asc
      limit ${STUCK_RUN_SWEEP_LIMIT}
    `;
  } catch (err) {
    logger.error({ err }, 'scheduler: stuck-run list query failed');
    return;
  }

  for (const run of stuck) {
    try {
      await withUserContext(run.owner_id, async () => {
        await failRunAndPromoteNextAtomic({
          runId: run.id,
          errorCode: 'stuck_running_swept',
          errorMessage:
            'Run exceeded the 1h stuck-running threshold and was reaped by the scheduler',
        });
      });
      // If the reaped run was an ordered step, wake its next sibling now.
      // failRunAndPromoteNextAtomic only flips status; it does not dispatch,
      // and the stranded-sibling sweep won't pick the sibling up until its
      // 2-min grace elapses (we just set ended_at=now). Promote here so a
      // swept crash doesn't add a 2-3 min stall on top of the 1h reap. Safe
      // to overlap the stranded sweep: the claim gate acks any duplicate.
      if (run.response_group_id) {
        const nextRunId = await findNextRunnableOrderedSibling(
          run.response_group_id,
        );
        if (nextRunId) await dispatchRun({ runId: nextRunId });
      }
    } catch (err) {
      logger.warn(
        { err, runId: run.id },
        'scheduler: stuck-run reap or sibling promotion failed during sweep',
      );
    }
  }

  if (stuck.length > 0) {
    logger.warn(
      { sweptCount: stuck.length },
      'scheduler: stuck-run sweep flipped runs to failed',
    );
  }
}

// Re-dispatch ordered siblings stranded by a lost promotion dispatch (see
// listStrandedOrderedSiblings). dispatchRun is best-effort and internally
// catches send failures, so a single bad send just retries next tick.
async function sweepStrandedOrderedSiblings(): Promise<void> {
  const endedBefore = new Date(
    Date.now() - STRANDED_SIBLING_GRACE_MS,
  ).toISOString();
  let stranded: Array<{ id: string; owner_id: string }>;
  try {
    stranded = await listStrandedOrderedSiblings(
      endedBefore,
      STRANDED_SIBLING_SWEEP_LIMIT,
    );
  } catch (err) {
    logger.error({ err }, 'scheduler: stranded-sibling list query failed');
    return;
  }

  for (const run of stranded) {
    await dispatchRun({ runId: run.id });
  }

  if (stranded.length > 0) {
    logger.warn(
      { redispatchedCount: stranded.length },
      'scheduler: re-dispatched ordered siblings stranded by a lost promotion',
    );
  }
}
