import {
  appendOutboxEvent,
  createTalkRun,
  getTalkRunById,
  getQueuedTalkRuns,
  getRunningTalkRun,
  markTalkRunStatus,
} from '../db/index.js';
import type { TalkRunRecord } from '../db/index.js';
import { TalkRunStatus } from '../types.js';

export interface EnqueueTalkRunInput {
  runId: string;
  talkId: string;
  threadId: string;
  requestedBy: string;
  idempotencyKey?: string;
}

export class TalkRunQueue {
  enqueue(input: EnqueueTalkRunInput): TalkRunRecord {
    const running = getRunningTalkRun(input.talkId);
    const status: TalkRunStatus = running ? 'queued' : 'running';
    const now = new Date().toISOString();

    const record: TalkRunRecord = {
      id: input.runId,
      talk_id: input.talkId,
      thread_id: input.threadId,
      requested_by: input.requestedBy,
      status,
      run_kind: 'conversation',
      trigger_message_id: null,
      idempotency_key: input.idempotencyKey || null,
      executor_alias: null,
      executor_model: null,
      created_at: now,
      started_at: status === 'running' ? now : null,
      ended_at: null,
      cancel_reason: null,
    };

    createTalkRun(record);

    appendOutboxEvent({
      topic: `talk:${input.talkId}`,
      eventType: status === 'running' ? 'talk_run_started' : 'talk_run_queued',
      payload: JSON.stringify({
        talkId: input.talkId,
        threadId: input.threadId,
        runId: input.runId,
        runKind: record.run_kind,
        status,
        executorAlias: record.executor_alias,
        executorModel: record.executor_model,
      }),
    });

    return record;
  }

  complete(runId: string): void {
    const run = this.findByRunIdAcrossQueues(runId);
    if (!run) return;

    const now = new Date().toISOString();
    markTalkRunStatus(runId, 'completed', now, null);

    appendOutboxEvent({
      topic: `talk:${run.talk_id!}`,
      eventType: 'talk_run_completed',
      payload: JSON.stringify({
        talkId: run.talk_id!,
        runId,
        runKind: run.run_kind ?? 'conversation',
        executorAlias: run.executor_alias,
        executorModel: run.executor_model,
      }),
    });

    const nextQueued = getQueuedTalkRuns(run.talk_id!, 1)[0];
    if (!nextQueued) return;

    markTalkRunStatus(nextQueued.id, 'running', null, null, now);
    appendOutboxEvent({
      topic: `talk:${run.talk_id}`,
      eventType: 'talk_run_started',
      payload: JSON.stringify({
        talkId: run.talk_id,
        runId: nextQueued.id,
        runKind: nextQueued.run_kind ?? 'conversation',
        status: 'running',
        executorAlias: nextQueued.executor_alias,
        executorModel: nextQueued.executor_model,
      }),
    });
  }

  cancelTalkRuns(talkId: string, cancelledBy: string): number {
    const running = getRunningTalkRun(talkId);
    const queued = getQueuedTalkRuns(talkId);
    const targetRuns = [...(running ? [running] : []), ...queued];
    if (targetRuns.length === 0) {
      return 0;
    }

    const now = new Date().toISOString();
    for (const run of targetRuns) {
      markTalkRunStatus(
        run.id,
        'cancelled',
        now,
        `Cancelled by ${cancelledBy}`,
      );
    }

    appendOutboxEvent({
      topic: `talk:${talkId}`,
      eventType: 'talk_run_cancelled',
      payload: JSON.stringify({
        talkId,
        cancelledBy,
        runIds: targetRuns.map((run) => run.id),
      }),
    });

    return targetRuns.length;
  }

  private findByRunIdAcrossQueues(runId: string): TalkRunRecord | null {
    return getTalkRunById(runId);
  }
}
