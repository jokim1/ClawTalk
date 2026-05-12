import { TALK_MOCK_EXECUTION_MS } from '../config.js';

import type {
  TalkExecutor,
  TalkExecutionEvent,
  TalkExecutorInput,
  TalkExecutorOutput,
} from './executor.js';

function abortError(reason?: unknown): Error {
  const err = new Error(
    typeof reason === 'string' ? reason : 'Talk execution aborted',
  );
  err.name = 'AbortError';
  return err;
}

function waitFor(durationMs: number, signal: AbortSignal): Promise<void> {
  if (durationMs <= 0) {
    if (signal.aborted) return Promise.reject(abortError(signal.reason));
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal.reason));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal.reason));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface MockTalkExecutorOptions {
  executionMs?: number;
}

export class MockTalkExecutor implements TalkExecutor {
  private readonly executionMs: number;

  constructor(options: MockTalkExecutorOptions = {}) {
    this.executionMs = Math.max(
      0,
      Math.floor(options.executionMs ?? TALK_MOCK_EXECUTION_MS),
    );
  }

  async execute(
    input: TalkExecutorInput,
    signal: AbortSignal,
    emit?: (event: TalkExecutionEvent) => void,
  ): Promise<TalkExecutorOutput> {
    emit?.({
      type: 'talk_response_started',
      runId: input.runId,
      talkId: input.talkId,
      threadId: input.threadId,
      responseGroupId: input.responseGroupId ?? null,
      sequenceIndex: input.sequenceIndex ?? null,
    });
    await waitFor(this.executionMs, signal);

    const content = `Mock assistant response to: ${input.triggerContent}`;
    emit?.({
      type: 'talk_response_delta',
      runId: input.runId,
      talkId: input.talkId,
      threadId: input.threadId,
      responseGroupId: input.responseGroupId ?? null,
      sequenceIndex: input.sequenceIndex ?? null,
      deltaText: content,
    });
    emit?.({
      type: 'talk_response_completed',
      runId: input.runId,
      talkId: input.talkId,
      threadId: input.threadId,
      responseGroupId: input.responseGroupId ?? null,
      sequenceIndex: input.sequenceIndex ?? null,
    });

    return {
      content,
      agentNickname: 'Mock Assistant',
      responseSequenceInRun: 1,
      metadataJson: JSON.stringify({
        runId: input.runId,
        responseGroupId: input.responseGroupId ?? null,
        sequenceIndex: input.sequenceIndex ?? null,
      }),
    };
  }
}
