// T7 in-process dispatcher — sibling of `queue-producer.ts:dispatchRun`.
//
// `dispatchRun` sends `{ runId }` onto TALK_RUN_QUEUE and the queue
// consumer Worker picks it up later (~5–14s of CF Queues + cold isolate
// latency, measured in the T9 baseline 2026-05-27). For single-run
// `/chat` POSTs we can skip that hop entirely by running
// `processTalkRunMessage` inside the same Worker invocation via
// `ctx.waitUntil` — same executor, same outbox/DO event delivery,
// minus the queue dispatch window.
//
// Caveats (per plan D5):
//   • Cloudflare's `ctx.waitUntil` has a 30s ceiling after the HTTP
//     response returns / client disconnects. Executors that need >30s
//     past disconnect die silently. Rows stuck in 'running' are reaped
//     by `scheduler.ts:sweepStuckRunningRuns` after 60 min.
//   • Errors before `markRunRunning` claims the row would leave it
//     'queued' — and the scheduler sweep ONLY catches 'running' rows
//     (see scheduler.ts:125), not 'queued'. To avoid stranding the
//     run, the catch below falls back to `TALK_RUN_QUEUE.send` so the
//     queue consumer can retry under CF Queues' retry/DLQ semantics.
//
// Multi-run, cron, and job-run-now keep going through `dispatchRun` —
// see `worker-app.ts` for the routing decision.

import {
  type DbScopeEnvBindings,
  type RequestExecutionContext,
  withRequestScopedDb,
} from '../../db.js';
import { logger } from '../../logger.js';
import { processTalkRunMessage } from './queue-consumer.js';

export type DispatchRunInProcessEnv = DbScopeEnvBindings & {
  DB: { connectionString: string };
};

export interface DispatchRunInProcessInput {
  env: DispatchRunInProcessEnv;
  ctx: RequestExecutionContext;
  runId: string;
}

/**
 * Run `processTalkRunMessage` for the given runId inside a fresh
 * `withRequestScopedDb` scope, so the executor's DB connection survives
 * past the calling request handler's 202 response. Errors are caught
 * and logged — callers do not need to await this promise themselves;
 * they wrap the call in `ctx.waitUntil(dispatchRunInProcess(...))`.
 */
export async function dispatchRunInProcess(
  input: DispatchRunInProcessInput,
): Promise<void> {
  const { env, ctx, runId } = input;
  try {
    await withRequestScopedDb(
      env.DB.connectionString,
      ctx,
      {
        DB_EVENT_HUB_URL: env.DB_EVENT_HUB_URL,
        USER_EVENT_HUB: env.USER_EVENT_HUB,
        TALK_RUN_QUEUE: env.TALK_RUN_QUEUE,
        ATTACHMENTS: env.ATTACHMENTS,
      },
      async () =>
        processTalkRunMessage({
          runId,
          attempts: 1,
          maxRetries: 3,
        }),
    );
  } catch (err) {
    // Pre-claim failures (e.g. transient DB error in markRunRunning,
    // withUserContext throwing) leave the row 'queued'. The scheduler
    // sweep only catches 'running'. Fall back to TALK_RUN_QUEUE.send
    // so CF Queues' retry/DLQ pipeline handles it — same semantics the
    // pre-T7 path had.
    logger.error(
      { err, runId },
      'dispatchRunInProcess: in-process exec failed; falling back to TALK_RUN_QUEUE.send for retry/DLQ',
    );
    const queue = input.env.TALK_RUN_QUEUE;
    if (!queue) {
      logger.error(
        { err, runId },
        'dispatchRunInProcess: TALK_RUN_QUEUE binding missing — run row stranded in queued',
      );
      return;
    }
    try {
      await queue.send({ runId }, { contentType: 'json' });
    } catch (sendErr) {
      logger.error(
        { err: sendErr, runId },
        'dispatchRunInProcess: fallback queue.send also failed; run row stranded in queued',
      );
    }
  }
}
