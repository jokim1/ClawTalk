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
import { failRunAndPromoteNextAtomic } from '../db/accessors.js';
import { claimDueTalkJobs, createJobTriggerRun } from '../db/job-accessors.js';
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
  });
}

async function processClaimableJobs(): Promise<void> {
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
      switch (result.status) {
        case 'enqueued':
          await dispatchRun({ runId: result.runId });
          break;
        case 'blocked':
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
          // Silent — these states are expected at scheduler edges:
          // 'job_busy' (a manual run-now beat us), 'paused' (toggled
          // between claim + create), 'not_found' (deleted).
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
  let stuck: Array<{ id: string; owner_id: string }>;
  try {
    const db = getDbPg();
    stuck = await db<Array<{ id: string; owner_id: string }>>`
      select id, owner_id from public.talk_runs
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
    } catch (err) {
      logger.warn(
        { err, runId: run.id },
        'scheduler: failRunAndPromoteNextAtomic threw during sweep',
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
