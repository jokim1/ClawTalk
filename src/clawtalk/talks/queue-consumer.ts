// Talk-run queue consumer (Queues port U3).
//
// Stateless port of `run-worker.ts:executeRun`. Replaces the Node-mode
// polling worker's batch-claim semantics with a single-row claim per
// queue message (see `markRunRunning`). The queue() handler in
// `src/worker.ts` invokes this once per message; each invocation
// opens its own `withUserContext` for the run's owner and either runs
// the executor through to a terminal state or throws for retry.
//
// Cancellation is cooperative — a background poll on `talk_runs.status`
// flips an AbortSignal when the row turns 'cancelled'. The cancel
// route (`worker-app.ts:/chat/cancel`) writes the status; the consumer
// detects within ~500ms.
//
// Streaming events emit through the same `emitOutboxEventOutsideTx`
// helper the legacy worker used (W7-evtsse U2 path), so live frames
// fan out to the UserEventHub DO while execution is mid-flight.

import { randomUUID } from 'crypto';

import { withUserContext } from '../../db.js';
import {
  completeRunAndPromoteNextAtomic,
  failRunAndPromoteNextAtomic,
  getTalkMessageById,
  getTalkRunById,
  markRunRunning,
  type TalkRunRecord,
} from '../db/accessors.js';
import {
  blockTalkJob,
  getTalkJobById,
  markTalkJobRunFinished,
} from '../db/job-accessors.js';
import { replaceJobReportOutput } from '../db/output-accessors.js';
import { logger } from '../../logger.js';

import { CleanTalkExecutor } from './new-executor.js';
import {
  TalkExecutorError,
  type TalkExecutionEvent,
  type TalkExecutor,
} from './executor.js';
import {
  createTalkResponseStreamSanitizer,
  extractChannelReplyControl,
  stripInternalTalkResponseText,
  type TalkResponseStreamSanitizer,
} from './internal-tags.js';
import { emitOutboxEventOutsideTx } from './outbox-emit.js';

export interface ProcessTalkRunMessageInput {
  runId: string;
  // Test seam — defaults to a fresh CleanTalkExecutor per invocation.
  executor?: TalkExecutor;
  // Test seam — cancellation poll interval; production default is 500ms.
  cancelPollIntervalMs?: number;
}

export class BlockedBySiblingError extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`run ${runId} blocked by lower-sequence-index sibling`);
    this.name = 'BlockedBySiblingError';
    this.runId = runId;
  }
}

const DEFAULT_CANCEL_POLL_MS = 500;

/**
 * Stateless per-message handler invoked by the queue() dispatcher.
 *
 * Returns normally on terminal success (run completed, failed, or
 * cancelled, in any case acked at the queue level).
 *
 * Throws `BlockedBySiblingError` when the run is part of an ordered
 * response group and a lower-sequence sibling is still active — the
 * caller should `message.retry()` with a delay so the sibling can
 * finish. Throws on unexpected infrastructure errors so the queue
 * retries.
 */
export async function processTalkRunMessage(
  input: ProcessTalkRunMessageInput,
): Promise<void> {
  const claim = await markRunRunning(input.runId);
  switch (claim.status) {
    case 'not_found':
      logger.warn(
        { runId: input.runId },
        'processTalkRunMessage: run not found, acking',
      );
      return;
    case 'terminal':
      logger.debug(
        { runId: input.runId },
        'processTalkRunMessage: run already terminal, acking',
      );
      return;
    case 'blocked_by_sibling':
      throw new BlockedBySiblingError(input.runId);
    case 'claimed':
      break;
  }

  const run = claim.run;
  const executor = input.executor ?? new CleanTalkExecutor();
  const cancelPollMs = input.cancelPollIntervalMs ?? DEFAULT_CANCEL_POLL_MS;

  await withUserContext(run.owner_id, async () => {
    if (!run.trigger_message_id) {
      await failRun(
        run,
        'trigger_message_missing',
        'Run missing trigger message reference',
      );
      return;
    }

    const triggerMessage = await getTalkMessageById(run.trigger_message_id);
    if (!triggerMessage) {
      await failRun(
        run,
        'trigger_message_not_found',
        `Trigger message not found: ${run.trigger_message_id}`,
      );
      return;
    }

    const cancelController = new AbortController();
    const pollerStop = new AbortController();
    const cancelPoller = (async () => {
      while (!pollerStop.signal.aborted) {
        const slept = await sleepUntil(cancelPollMs, pollerStop.signal);
        if (!slept) return; // poller stopped — exit cleanly
        try {
          const current = await getTalkRunById(run.id);
          if (current?.status === 'cancelled') {
            cancelController.abort('cancelled');
            return;
          }
          if (current && current.status !== 'running') {
            // Some other path already flipped status — stop polling.
            return;
          }
        } catch (err) {
          logger.warn({ err, runId: run.id }, 'cancel poll failed; continuing');
        }
      }
    })();

    let sanitizer: TalkResponseStreamSanitizer | null = null;
    const emit = (event: TalkExecutionEvent): void => {
      let routed: TalkExecutionEvent = event;
      if (event.type === 'talk_response_started') {
        sanitizer = createTalkResponseStreamSanitizer();
      } else if (event.type === 'talk_response_delta') {
        if (!sanitizer) sanitizer = createTalkResponseStreamSanitizer();
        const deltaText = sanitizer.push(event.deltaText);
        if (!deltaText) return;
        routed = { ...event, deltaText };
      } else if (
        event.type === 'talk_response_completed' ||
        event.type === 'talk_response_failed' ||
        event.type === 'talk_response_cancelled'
      ) {
        sanitizer = null;
      }
      emitOutboxEventOutsideTx({
        topic: `talk:${routed.talkId}`,
        eventType: routed.type,
        payload: routed as unknown as Record<string, unknown>,
        ownerIds: [run.owner_id],
      }).catch((err) => {
        logger.warn({ err, eventType: routed.type }, 'outbox emit failed');
      });
    };

    try {
      const executionStartedAt = Date.now();
      const output = await executor.execute(
        {
          runId: run.id,
          talkId: run.talk_id!,
          threadId: run.thread_id,
          requestedBy: run.requested_by,
          triggerMessageId: triggerMessage.id,
          triggerContent: triggerMessage.content,
          jobId: run.job_id ?? null,
          targetAgentId: run.target_agent_id,
          responseGroupId: run.response_group_id ?? null,
          sequenceIndex: run.sequence_index ?? null,
        },
        cancelController.signal,
        emit,
      );
      const latencyMs = Date.now() - executionStartedAt;
      void extractChannelReplyControl(output.content);
      const responseContent = stripInternalTalkResponseText(output.content);
      const responseMetadata = output.metadataJson
        ? (JSON.parse(output.metadataJson) as Record<string, unknown>)
        : null;

      const completed = await completeRunAndPromoteNextAtomic({
        ownerId: run.owner_id,
        runId: run.id,
        responseMessageId: randomUUID(),
        responseContent,
        responseMetadata,
        agentId: output.agentId,
        agentNickname: output.agentNickname,
        providerId: output.providerId,
        modelId: output.modelId,
        latencyMs,
        usage: output.usage,
        responseSequenceInRun: output.responseSequenceInRun,
      });
      if (completed.applied) {
        await handleJobCompletion(run, responseContent);
      } else {
        logger.debug(
          { runId: run.id, talkId: run.talk_id },
          'Run completion skipped due to non-running status',
        );
      }
    } catch (err) {
      if (isAbortError(err)) {
        if (await isCancelled(run.id)) {
          // Cancel route already flipped status + emitted the
          // talk_run_cancelled outbox event. Nothing more to do.
          return;
        }
        await failRun(run, 'execution_aborted', errorMessageText(err));
        return;
      }
      await failRun(
        run,
        err instanceof TalkExecutorError ? err.code : 'execution_failed',
        errorMessageText(err),
        err instanceof TalkExecutorError ? err.metadata : null,
      );
    } finally {
      pollerStop.abort();
      cancelController.abort('done');
      await cancelPoller.catch(() => {});
    }
  });
}

async function failRun(
  run: TalkRunRecord,
  errorCode: string,
  message: string,
  metadataPatch?: Record<string, unknown> | null,
): Promise<void> {
  const result = await failRunAndPromoteNextAtomic({
    runId: run.id,
    errorCode,
    errorMessage: message,
    metadataPatch,
  });
  if (!result.applied) {
    logger.debug(
      { runId: run.id, talkId: run.talk_id },
      'Run failure skipped due to non-running status',
    );
    return;
  }
  if (run.job_id) {
    await markTalkJobRunFinished({
      jobId: run.job_id,
      status: 'failed',
    });
  }
}

async function handleJobCompletion(
  run: TalkRunRecord,
  responseContent: string,
): Promise<void> {
  if (!run.job_id) return;
  let finalStatus = 'completed';

  try {
    const job = await getTalkJobById(run.job_id);
    if (job?.deliverableKind === 'report') {
      if (!job.reportOutputId) {
        await blockTalkJob(job.talkId, job.id, 'blocked');
        finalStatus = 'blocked';
      } else {
        const updated = await replaceJobReportOutput({
          talkId: job.talkId,
          outputId: job.reportOutputId,
          contentMarkdown: responseContent,
          updatedByRunId: run.id,
        });
        if (!updated) {
          await blockTalkJob(job.talkId, job.id, 'blocked');
          finalStatus = 'blocked';
        }
      }
    }
  } catch (err) {
    logger.error(
      {
        err,
        runId: run.id,
        talkId: run.talk_id,
        jobId: run.job_id,
      },
      'Job report delivery failed after successful run completion',
    );
  } finally {
    await markTalkJobRunFinished({
      jobId: run.job_id,
      status: finalStatus,
    });
  }
}

async function isCancelled(runId: string): Promise<boolean> {
  return (await getTalkRunById(runId))?.status === 'cancelled';
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function errorMessageText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Unknown talk execution failure';
}

/**
 * Sleep for `ms` milliseconds. Resolves to true on natural timeout,
 * false if the signal aborts during the wait. Used by the cancel
 * poller so the per-message processing can exit promptly when the
 * executor returns — no 500ms tail latency on every run.
 */
function sleepUntil(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
