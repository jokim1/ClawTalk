import { TALK_RUN_POLL_MS } from '../config.js';
import { claimDueTalkJobs, createJobTriggerRun } from '../db/index.js';
import { logger } from '../../logger.js';
import { WakeablePollLoop } from '../channels/wakeable-poll-loop.js';

export interface TalkJobWorkerControl {
  wake(): void;
}

export interface TalkJobWorkerOptions {
  pollMs?: number;
  claimBatchSize?: number;
  onRunQueued?: () => void;
}

const DEFAULT_CLAIM_BATCH_SIZE = 10;

export class TalkJobWorker implements TalkJobWorkerControl {
  private readonly claimBatchSize: number;
  private readonly loop: WakeablePollLoop;
  private readonly onRunQueued?: () => void;

  constructor(options: TalkJobWorkerOptions = {}) {
    this.claimBatchSize = Math.max(
      1,
      Math.floor(options.claimBatchSize ?? DEFAULT_CLAIM_BATCH_SIZE),
    );
    this.onRunQueued = options.onRunQueued;
    this.loop = new WakeablePollLoop({
      label: 'TalkJobWorker',
      pollMs: options.pollMs ?? TALK_RUN_POLL_MS,
      onCycle: async () => this.processCycle(),
    });
  }

  async start(): Promise<void> {
    await this.loop.start();
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }

  wake(): void {
    this.loop.wake();
  }

  private async processCycle(): Promise<boolean> {
    const claimed = claimDueTalkJobs(this.claimBatchSize);
    if (claimed.length === 0) {
      return false;
    }

    let didWork = false;
    for (const job of claimed) {
      const result = createJobTriggerRun({
        jobId: job.id,
        triggerSource: 'scheduler',
      });

      if (result.status === 'enqueued') {
        didWork = true;
        this.onRunQueued?.();
        continue;
      }

      if (result.status === 'blocked') {
        didWork = true;
        logger.warn(
          {
            talkId: result.job.talkId,
            jobId: result.job.id,
            issueCode: result.issue.code,
          },
          'Blocked scheduled Talk job due to invalid dependency',
        );
      }
    }

    return didWork;
  }
}
