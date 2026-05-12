import { randomUUID } from 'crypto';

import { TALK_RUN_MAX_CONCURRENCY, TALK_RUN_POLL_MS } from '../config.js';
import {
  claimQueuedTalkRuns,
  appendOutboxEvent,
  blockTalkJob,
  completeRunAndPromoteNextAtomic,
  failInterruptedRunsOnStartup,
  failRunAndPromoteNextAtomic,
  getTalkJobById,
  getTalkMessageById,
  getTalkRunById,
  markTalkJobRunFinished,
  replaceJobReportOutput,
  type TalkRunRecord,
} from '../db/index.js';
import { logger } from '../../logger.js';
import { BrowserRunPausedError } from '../browser/run-paused-error.js';

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
import { MockTalkExecutor } from './mock-executor.js';

export interface TalkRunWorkerOptions {
  executor?: TalkExecutor;
  pollMs?: number;
  maxConcurrency?: number;
  onTalkTerminal?: (talkId: string) => void;
  onChannelDeliveryQueued?: () => void;
}

export interface TalkRunWorkerControl {
  wake(): void;
  abortTalk(talkId: string): void;
  abortThread(threadId: string): void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown talk execution failure';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function parseChannelInboundMetadata(metadataJson: string | null | undefined): {
  isMentioned: boolean;
} | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      parsed.kind !== 'channel_inbound'
    ) {
      return null;
    }
    return {
      isMentioned: parsed.isMentioned === true,
    };
  } catch {
    return null;
  }
}

interface ActiveRun {
  run: TalkRunRecord;
  controller: AbortController;
}

export class TalkRunWorker implements TalkRunWorkerControl {
  private readonly executor: TalkExecutor;
  private readonly pollMs: number;
  private readonly maxConcurrency: number;
  private readonly onTalkTerminal?: (talkId: string) => void;
  private readonly onChannelDeliveryQueued?: () => void;

  private running = false;
  private loopPromise: Promise<void> | null = null;

  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepResolver: (() => void) | null = null;

  private readonly activeRunsById = new Map<string, ActiveRun>();
  private readonly activeRunTasks = new Map<string, Promise<void>>();
  private readonly responseSanitizersByRunId = new Map<
    string,
    TalkResponseStreamSanitizer
  >();

  constructor(options: TalkRunWorkerOptions = {}) {
    this.executor = options.executor || new MockTalkExecutor();
    this.pollMs = Math.max(10, Math.floor(options.pollMs ?? TALK_RUN_POLL_MS));
    this.maxConcurrency = Math.max(
      1,
      Math.floor(options.maxConcurrency ?? TALK_RUN_MAX_CONCURRENCY),
    );
    this.onTalkTerminal = options.onTalkTerminal;
    this.onChannelDeliveryQueued = options.onChannelDeliveryQueued;
  }

  async start(): Promise<void> {
    if (this.running) return;

    const recovery = failInterruptedRunsOnStartup();
    if (
      recovery.failedRunIds.length > 0 ||
      recovery.promotedRunIds.length > 0
    ) {
      logger.warn(
        {
          failedRuns: recovery.failedRunIds.length,
          promotedRuns: recovery.promotedRunIds.length,
        },
        'Recovered interrupted talk runs on startup',
      );
    }

    this.running = true;
    this.loopPromise = this.runLoop();

    if (recovery.promotedRunIds.length > 0) {
      this.wake();
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      if (this.loopPromise) await this.loopPromise;
      return;
    }

    this.running = false;
    this.wake();

    for (const active of this.activeRunsById.values()) {
      active.controller.abort('worker_stopping');
    }

    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }

    if (this.activeRunTasks.size > 0) {
      await Promise.allSettled(this.activeRunTasks.values());
    }
  }

  wake(): void {
    const resolver = this.sleepResolver;
    if (!resolver) return;
    this.clearSleepState();
    resolver();
  }

  abortTalk(talkId: string): void {
    for (const active of this.activeRunsById.values()) {
      if (active.run.talk_id !== talkId) continue;
      active.controller.abort(`talk_cancelled:${talkId}`);
    }
  }

  abortThread(threadId: string): void {
    for (const active of this.activeRunsById.values()) {
      if (active.run.thread_id !== threadId) continue;
      active.controller.abort(`thread_cancelled:${threadId}`);
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        this.processCycle();
      } catch (error) {
        logger.error({ err: error }, 'Talk run worker cycle failed');
      }

      await this.waitForNextTick();
    }

    this.clearSleepState();
  }

  private processCycle(): void {
    const availableSlots = this.maxConcurrency - this.activeRunsById.size;
    if (availableSlots <= 0) return;

    const claimedRuns = claimQueuedTalkRuns(availableSlots);
    for (const run of claimedRuns) {
      if (this.activeRunsById.size >= this.maxConcurrency) break;
      this.startRun(run);
    }
  }

  private startRun(run: TalkRunRecord): void {
    const controller = new AbortController();
    this.activeRunsById.set(run.id, { run, controller });

    const task = this.executeRun(run, controller.signal)
      .catch((error) => {
        logger.error(
          {
            err: error,
            talkId: run.talk_id,
            runId: run.id,
          },
          'Talk run execution crashed',
        );
      })
      .finally(() => {
        this.activeRunsById.delete(run.id);
        this.activeRunTasks.delete(run.id);
        this.wake();
      });
    this.activeRunTasks.set(run.id, task);
  }

  private async executeRun(
    run: TalkRunRecord,
    signal: AbortSignal,
  ): Promise<void> {
    if (!run.trigger_message_id) {
      this.failRun(
        run,
        'trigger_message_missing',
        'Run missing trigger message reference',
      );
      return;
    }

    const triggerMessage = getTalkMessageById(run.trigger_message_id);
    if (!triggerMessage) {
      this.failRun(
        run,
        'trigger_message_not_found',
        `Trigger message not found: ${run.trigger_message_id}`,
      );
      return;
    }

    try {
      const executionStartedAt = Date.now();
      const triggerChannelMetadata = parseChannelInboundMetadata(
        triggerMessage.metadata_json,
      );
      const output = await this.executor.execute(
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
        signal,
        (event) => this.emitExecutionEvent(event),
      );
      const latencyMs = Date.now() - executionStartedAt;
      const replyControl = extractChannelReplyControl(output.content);
      const directMention = triggerChannelMetadata?.isMentioned === true;
      const deliverySuppressed =
        run.source_binding_id != null &&
        replyControl.suppressDelivery &&
        !directMention;
      const responseContent = stripInternalTalkResponseText(output.content);

      const completed = completeRunAndPromoteNextAtomic({
        runId: run.id,
        responseMessageId: `msg_${randomUUID()}`,
        responseContent,
        responseMetadataJson: output.metadataJson,
        deliverySuppressed,
        suppressionReason: deliverySuppressed ? replyControl.rationale : null,
        agentId: output.agentId,
        agentNickname: output.agentNickname,
        providerId: output.providerId,
        modelId: output.modelId,
        latencyMs,
        usage: output.usage,
        responseSequenceInRun: output.responseSequenceInRun,
      });
      if (!completed.applied) {
        logger.debug(
          { runId: run.id, talkId: run.talk_id },
          'Run completion skipped due to non-running status',
        );
      } else {
        if (completed.deliveryQueued) {
          this.onChannelDeliveryQueued?.();
        }
        await this.handleJobCompletion(run, responseContent);
        this.onTalkTerminal?.(run.talk_id!);
      }
    } catch (error) {
      if (error instanceof BrowserRunPausedError) {
        logger.info(
          {
            runId: run.id,
            talkId: run.talk_id,
            browserBlock: error.browserBlock.kind,
          },
          'Talk run paused for browser intervention',
        );
        return;
      }
      if (isAbortError(error)) {
        if (!this.running) return;
        if (this.isCancelled(run.id)) return;
        this.failRun(run, 'execution_aborted', errorMessage(error));
        return;
      }

      this.failRun(
        run,
        error instanceof TalkExecutorError ? error.code : 'execution_failed',
        errorMessage(error),
        error instanceof TalkExecutorError ? error.metadata : null,
      );
    }
  }

  private async handleJobCompletion(
    run: TalkRunRecord,
    responseContent: string,
  ): Promise<void> {
    if (!run.job_id) return;
    let finalStatus = 'completed';

    try {
      const job = getTalkJobById(run.job_id);
      if (job?.deliverableKind === 'report') {
        if (!job.reportOutputId) {
          blockTalkJob(job.talkId, job.id, 'blocked');
          finalStatus = 'blocked';
        } else {
          const updated = replaceJobReportOutput({
            talkId: job.talkId,
            outputId: job.reportOutputId,
            contentMarkdown: responseContent,
            updatedByRunId: run.id,
          });
          if (!updated) {
            blockTalkJob(job.talkId, job.id, 'blocked');
            finalStatus = 'blocked';
          }
        }
      }
    } catch (error) {
      logger.error(
        {
          err: error,
          runId: run.id,
          talkId: run.talk_id,
          jobId: run.job_id,
        },
        'Job report delivery failed after successful run completion',
      );
    } finally {
      markTalkJobRunFinished({
        jobId: run.job_id,
        status: finalStatus,
      });
    }
  }

  private emitExecutionEvent(event: TalkExecutionEvent): void {
    if (event.type === 'talk_response_started') {
      this.responseSanitizersByRunId.set(
        event.runId,
        createTalkResponseStreamSanitizer(),
      );
    } else if (event.type === 'talk_response_delta') {
      const sanitizer =
        this.responseSanitizersByRunId.get(event.runId) ||
        createTalkResponseStreamSanitizer();
      this.responseSanitizersByRunId.set(event.runId, sanitizer);

      const deltaText = sanitizer.push(event.deltaText);
      if (!deltaText) {
        return;
      }

      event = {
        ...event,
        deltaText,
      };
    } else if (
      event.type === 'talk_response_completed' ||
      event.type === 'talk_response_failed' ||
      event.type === 'talk_response_cancelled'
    ) {
      this.responseSanitizersByRunId.delete(event.runId);
    }

    appendOutboxEvent({
      topic: `talk:${event.talkId}`,
      eventType: event.type,
      payload: JSON.stringify(event),
    });
  }

  private failRun(
    run: TalkRunRecord,
    errorCode: string,
    errorMessageText: string,
    metadataPatch?: Record<string, unknown> | null,
  ): void {
    const result = failRunAndPromoteNextAtomic({
      runId: run.id,
      errorCode,
      errorMessage: errorMessageText,
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
      markTalkJobRunFinished({
        jobId: run.job_id,
        status: 'failed',
      });
    }
    this.onTalkTerminal?.(run.talk_id!);
  }

  private isCancelled(runId: string): boolean {
    return getTalkRunById(runId)?.status === 'cancelled';
  }

  private waitForNextTick(): Promise<void> {
    if (!this.running) return Promise.resolve();

    return new Promise((resolve) => {
      this.sleepResolver = resolve;
      this.sleepTimer = setTimeout(() => {
        this.clearSleepState();
        resolve();
      }, this.pollMs);
    });
  }

  private clearSleepState(): void {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    this.sleepResolver = null;
  }
}
