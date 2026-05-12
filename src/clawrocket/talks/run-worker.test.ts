import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  cancelTalkRunsAtomic,
  createTalkChannelBinding,
  createTalk,
  createJobTriggerRun,
  createTalkMessage,
  createTalkJob,
  createTalkOutput,
  createTalkRun,
  enqueueChannelTurnAtomic,
  enqueueTalkTurnAtomic as enqueueTalkTurnAtomicRaw,
  ensureSystemManagedTelegramConnection,
  getTalkOutput,
  getOutboxEventsForTopics,
  getTalkRunById,
  listTalkMessages,
  upsertUser,
} from '../db/index.js';
import { createRegisteredAgent } from '../db/agent-accessors.js';
import { getDb } from '../../db.js';

import type {
  TalkExecutionEvent,
  TalkExecutor,
  TalkExecutorInput,
  TalkExecutorOutput,
} from './executor.js';
import { TalkExecutorError } from './executor.js';
import { MockTalkExecutor } from './mock-executor.js';
import { TalkRunWorker } from './run-worker.js';

class BlockingExecutor implements TalkExecutor {
  startedRuns: string[] = [];

  private resolveStarted!: () => void;

  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  async execute(
    input: TalkExecutorInput,
    signal: AbortSignal,
  ): Promise<TalkExecutorOutput> {
    this.startedRuns.push(input.runId);
    this.resolveStarted();

    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(createAbortError(signal.reason));
        return;
      }

      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(createAbortError(signal.reason));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

class AliasUnmappedExecutor implements TalkExecutor {
  async execute(): Promise<TalkExecutorOutput> {
    throw new TalkExecutorError(
      'executor_alias_unmapped',
      'No model mapping configured for alias',
    );
  }
}

class InternalTagExecutor implements TalkExecutor {
  async execute(
    input: TalkExecutorInput,
    _signal: AbortSignal,
    emit?: (event: TalkExecutionEvent) => void,
  ): Promise<TalkExecutorOutput> {
    emit?.({
      type: 'talk_response_started',
      runId: input.runId,
      talkId: input.talkId,
      agentNickname: 'Claude Sonnet 4.6',
    });
    emit?.({
      type: 'talk_response_delta',
      runId: input.runId,
      talkId: input.talkId,
      deltaText: '<internal>thinking',
      agentNickname: 'Claude Sonnet 4.6',
    });
    emit?.({
      type: 'talk_response_delta',
      runId: input.runId,
      talkId: input.talkId,
      deltaText: ' harder</internal>Hello',
      agentNickname: 'Claude Sonnet 4.6',
    });
    emit?.({
      type: 'talk_response_delta',
      runId: input.runId,
      talkId: input.talkId,
      deltaText: ' world',
      agentNickname: 'Claude Sonnet 4.6',
    });
    emit?.({
      type: 'talk_response_completed',
      runId: input.runId,
      talkId: input.talkId,
      agentNickname: 'Claude Sonnet 4.6',
    });

    return {
      content: '<internal>thinking harder</internal>Hello world',
      agentNickname: 'Claude Sonnet 4.6',
    };
  }
}

class SuppressingChannelExecutor implements TalkExecutor {
  constructor(private readonly content: string) {}

  async execute(): Promise<TalkExecutorOutput> {
    return {
      content: this.content,
      agentNickname: 'Claude Sonnet 4.6',
    };
  }
}

function createAbortError(reason?: unknown): Error {
  const error = new Error(typeof reason === 'string' ? reason : 'aborted');
  error.name = 'AbortError';
  return error;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('Timed out waiting for condition');
}

function enqueueTalkTurnAtomic(input: {
  talkId: string;
  userId: string;
  content: string;
  messageId: string;
  runId: string;
  targetAgentId?: string;
  idempotencyKey?: string | null;
  now?: string;
}) {
  return enqueueTalkTurnAtomicRaw({
    talkId: input.talkId,
    userId: input.userId,
    content: input.content,
    messageId: input.messageId,
    runIds: [input.runId],
    targetAgentIds: [input.targetAgentId || 'agent-default'],
    idempotencyKey: input.idempotencyKey,
    now: input.now,
  });
}

function enqueueTalkRoundAtomic(input: {
  talkId: string;
  userId: string;
  content: string;
  messageId: string;
  runIds: string[];
  targetAgentIds?: string[];
  responseGroupId?: string | null;
  sequenceIndexes?: Array<number | null>;
  idempotencyKey?: string | null;
  now?: string;
}) {
  return enqueueTalkTurnAtomicRaw({
    talkId: input.talkId,
    userId: input.userId,
    content: input.content,
    messageId: input.messageId,
    runIds: input.runIds,
    targetAgentIds:
      input.targetAgentIds ?? input.runIds.map(() => 'agent-default'),
    responseGroupId: input.responseGroupId,
    sequenceIndexes: input.sequenceIndexes,
    idempotencyKey: input.idempotencyKey,
    now: input.now,
  });
}

class OrderedFailureExecutor implements TalkExecutor {
  startedRuns: string[] = [];

  private resolveFirstStarted!: () => void;
  readonly firstStarted = new Promise<void>((resolve) => {
    this.resolveFirstStarted = resolve;
  });

  private releaseFirstExecution!: () => void;
  readonly firstExecutionReleased = new Promise<void>((resolve) => {
    this.releaseFirstExecution = resolve;
  });

  releaseFirst(): void {
    this.releaseFirstExecution();
  }

  async execute(input: TalkExecutorInput): Promise<TalkExecutorOutput> {
    this.startedRuns.push(input.runId);

    if (input.runId === 'run-ordered-1') {
      this.resolveFirstStarted();
      await this.firstExecutionReleased;
      return {
        content: 'Ordered phase one complete',
        agentId: 'agent.main',
        agentNickname: 'Nanoclaw',
        providerId: 'builtin.mock',
        modelId: 'mock-default',
        responseSequenceInRun: 1,
      };
    }

    if (input.runId === 'run-ordered-2') {
      throw new TalkExecutorError('rate_limited', 'Provider rate limited');
    }

    return {
      content: `Unexpected completion for ${input.runId}`,
      agentId: 'agent.main',
      agentNickname: 'Nanoclaw',
      providerId: 'builtin.mock',
      modelId: 'mock-default',
      responseSequenceInRun: 1,
    };
  }
}

class OrderedIncompleteExecutor implements TalkExecutor {
  async execute(input: TalkExecutorInput): Promise<TalkExecutorOutput> {
    if (input.runId === 'run-incomplete-1') {
      return {
        content: 'Phase one complete',
        agentId: 'agent.main',
        agentNickname: 'Nanoclaw',
        providerId: 'builtin.mock',
        modelId: 'mock-default',
        responseSequenceInRun: 1,
      };
    }

    if (input.runId === 'run-incomplete-3') {
      return {
        content: 'Phase three completed after a truncated earlier step',
        agentId: 'agent.main',
        agentNickname: 'Nanoclaw',
        providerId: 'builtin.mock',
        modelId: 'mock-default',
        responseSequenceInRun: 1,
      };
    }

    throw new TalkExecutorError(
      'incomplete_response',
      'The model stopped before finishing its answer (provider stop reason: length).',
      {
        metadata: {
          completionStatus: 'incomplete',
          providerStopReason: 'length',
          incompleteReason: 'truncated',
        },
      },
    );
  }
}

describe('TalkRunWorker', () => {
  beforeEach(() => {
    _initTestDatabase();

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });

    createTalk({
      id: 'talk-1',
      ownerId: 'owner-1',
      topicTitle: 'Test Talk',
    });
  });

  it('processes queued work immediately when wake() is called', async () => {
    const worker = new TalkRunWorker({
      executor: new MockTalkExecutor({ executionMs: 5 }),
      pollMs: 10_000,
      maxConcurrency: 1,
    });
    await worker.start();

    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'wake me now',
      messageId: 'msg-1',
      runId: 'run-1',
    });

    const startedAt = Date.now();
    worker.wake();

    await waitFor(() => getTalkRunById('run-1')?.status === 'completed');
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    await worker.stop();
  });

  it('writes report-job results into the configured output after a successful run', async () => {
    const agent = createRegisteredAgent({
      name: 'Scheduler Agent',
      providerId: 'provider.openai',
      modelId: 'gpt-5-mini',
      systemPrompt: 'Do scheduled work.',
    });
    getDb()
      .prepare(
        `
        INSERT INTO talk_agents (
          id, talk_id, registered_agent_id, nickname, is_primary, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, 0, datetime('now'), datetime('now'))
      `,
      )
      .run('ta-job-agent', 'talk-1', agent.id, agent.name);
    const output = createTalkOutput({
      talkId: 'talk-1',
      title: 'Daily Report',
      contentMarkdown: 'Old content',
      createdByUserId: 'owner-1',
    });
    const job = createTalkJob({
      talkId: 'talk-1',
      title: 'Daily Brief',
      prompt: 'Summarize key updates.',
      targetAgentId: agent.id,
      schedule: { kind: 'hourly_interval', everyHours: 24 },
      timezone: 'America/Los_Angeles',
      deliverableKind: 'report',
      reportOutputId: output.id,
      createdBy: 'owner-1',
    });

    const enqueued = createJobTriggerRun({
      jobId: job.id,
      triggerSource: 'manual',
      allowPaused: true,
    });
    expect(enqueued.status).toBe('enqueued');
    if (enqueued.status !== 'enqueued') {
      return;
    }

    const worker = new TalkRunWorker({
      executor: new MockTalkExecutor({ executionMs: 5 }),
      pollMs: 10_000,
      maxConcurrency: 1,
    });
    await worker.start();

    worker.wake();
    await waitFor(() => getTalkRunById(enqueued.runId)?.status === 'completed');

    const updated = getTalkOutput('talk-1', output.id);
    expect(updated?.contentMarkdown).toBe(
      'Mock assistant response to: Summarize key updates.',
    );
    expect(updated?.updatedByRunId).toBe(enqueued.runId);

    await worker.stop();
  });

  it('does not emit terminal failure when a running talk is cancelled and aborted', async () => {
    const executor = new BlockingExecutor();
    const worker = new TalkRunWorker({
      executor,
      pollMs: 10_000,
      maxConcurrency: 1,
    });
    await worker.start();

    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'cancel me',
      messageId: 'msg-2',
      runId: 'run-2',
    });

    worker.wake();
    await executor.started;

    const cancellation = cancelTalkRunsAtomic({
      talkId: 'talk-1',
      cancelledBy: 'owner-1',
    });
    expect(cancellation.cancelledRuns).toBe(1);
    expect(cancellation.cancelledRunning).toBe(true);

    worker.abortTalk('talk-1');

    await waitFor(() => getTalkRunById('run-2')?.status === 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 50);
    expect(
      events.some((event) => {
        if (
          event.event_type !== 'talk_run_failed' &&
          event.event_type !== 'talk_run_completed'
        ) {
          return false;
        }
        const payload = JSON.parse(event.payload) as { runId?: string };
        return payload.runId === 'run-2';
      }),
    ).toBe(false);

    await worker.stop();
  });

  it('completes parallel round runs and preserves run/message correlation fields', async () => {
    const worker = new TalkRunWorker({
      executor: new MockTalkExecutor({ executionMs: 5 }),
      pollMs: 10_000,
      maxConcurrency: 1,
    });
    await worker.start();

    enqueueTalkRoundAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'round prompt',
      messageId: 'msg-3',
      runIds: ['run-3', 'run-4'],
    });

    worker.wake();

    await waitFor(() => getTalkRunById('run-3')?.status === 'completed');
    await waitFor(() => getTalkRunById('run-4')?.status === 'completed');

    const messages = listTalkMessages({ talkId: 'talk-1', limit: 20 });
    const userMessages = messages.filter((message) => message.role === 'user');
    const assistantMessages = messages.filter(
      (message) => message.role === 'assistant',
    );

    expect(userMessages).toHaveLength(1);
    expect(userMessages.every((message) => message.run_id === null)).toBe(true);
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages.every((message) => message.run_id !== null)).toBe(
      true,
    );

    const outbox = getOutboxEventsForTopics(['talk:talk-1'], 0, 100);
    const queuedEvent = outbox.find(
      (event) =>
        event.event_type === 'talk_run_queued' &&
        event.payload.includes('"runId":"run-4"'),
    );
    const startedEvent = outbox.find(
      (event) =>
        event.event_type === 'talk_run_started' &&
        event.payload.includes('"runId":"run-4"'),
    );

    expect(queuedEvent).toBeDefined();
    expect(startedEvent).toBeDefined();
    expect(startedEvent?.payload).toContain('"triggerMessageId":"msg-3"');

    await worker.stop();
  });

  it('only claims the next eligible ordered run and continues after an earlier failure', async () => {
    const executor = new OrderedFailureExecutor();
    const worker = new TalkRunWorker({
      executor,
      pollMs: 10_000,
      maxConcurrency: 3,
    });
    await worker.start();

    enqueueTalkRoundAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'ordered round prompt',
      messageId: 'msg-ordered-1',
      runIds: ['run-ordered-1', 'run-ordered-2', 'run-ordered-3'],
      responseGroupId: 'group-ordered-1',
      sequenceIndexes: [0, 1, 2],
    });

    worker.wake();
    await executor.firstStarted;

    expect(executor.startedRuns).toEqual(['run-ordered-1']);
    expect(getTalkRunById('run-ordered-1')?.status).toBe('running');
    expect(getTalkRunById('run-ordered-2')?.status).toBe('queued');
    expect(getTalkRunById('run-ordered-3')?.status).toBe('queued');

    executor.releaseFirst();

    await waitFor(
      () => getTalkRunById('run-ordered-1')?.status === 'completed',
    );
    await waitFor(() => getTalkRunById('run-ordered-2')?.status === 'failed');
    await waitFor(
      () => getTalkRunById('run-ordered-3')?.status === 'completed',
    );

    expect(executor.startedRuns).toEqual([
      'run-ordered-1',
      'run-ordered-2',
      'run-ordered-3',
    ]);
    expect(getTalkRunById('run-ordered-3')?.cancel_reason).toBeNull();

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 100);
    const cancelledEvent = events.find(
      (event) =>
        event.event_type === 'talk_run_cancelled' &&
        event.payload.includes('"runIds":["run-ordered-3"]'),
    );
    expect(cancelledEvent).toBeUndefined();

    await worker.stop();
  });

  it('persists incomplete-response metadata on failed ordered runs', async () => {
    const worker = new TalkRunWorker({
      executor: new OrderedIncompleteExecutor(),
      pollMs: 10_000,
      maxConcurrency: 2,
    });
    await worker.start();

    enqueueTalkRoundAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'ordered retry prompt',
      messageId: 'msg-incomplete-1',
      runIds: ['run-incomplete-1', 'run-incomplete-2', 'run-incomplete-3'],
      responseGroupId: 'group-incomplete-1',
      sequenceIndexes: [0, 1, 2],
    });

    worker.wake();

    await waitFor(
      () => getTalkRunById('run-incomplete-1')?.status === 'completed',
    );
    await waitFor(
      () => getTalkRunById('run-incomplete-2')?.status === 'failed',
    );
    await waitFor(
      () => getTalkRunById('run-incomplete-3')?.status === 'completed',
    );

    const failedRun = getTalkRunById('run-incomplete-2');
    expect(failedRun?.cancel_reason).toContain('incomplete_response');
    expect(JSON.parse(failedRun?.metadata_json || '{}')).toMatchObject({
      responseMetadata: {
        completionStatus: 'incomplete',
        providerStopReason: 'length',
        incompleteReason: 'truncated',
      },
    });
    expect(getTalkRunById('run-incomplete-3')?.cancel_reason).toBeNull();

    await worker.stop();
  });

  it('fails interrupted running work on startup and starts the next queued run', async () => {
    createTalkMessage({
      id: 'msg-5',
      talkId: 'talk-1',
      threadId: 'thread-1',
      role: 'user',
      content: 'stale running work',
      createdBy: 'owner-1',
      createdAt: '2024-01-01T00:00:01.000Z',
    });
    createTalkMessage({
      id: 'msg-6',
      talkId: 'talk-1',
      threadId: 'thread-1',
      role: 'user',
      content: 'queued recovery work',
      createdBy: 'owner-1',
      createdAt: '2024-01-01T00:00:02.000Z',
    });
    createTalkRun({
      id: 'run-5',
      talk_id: 'talk-1',
      thread_id: 'thread-1',
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: 'msg-5',
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: '2024-01-01T00:00:01.000Z',
      started_at: '2024-01-01T00:00:01.000Z',
      ended_at: null,
      cancel_reason: null,
    });
    createTalkRun({
      id: 'run-6',
      talk_id: 'talk-1',
      thread_id: 'thread-1',
      requested_by: 'owner-1',
      status: 'queued',
      trigger_message_id: 'msg-6',
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: '2024-01-01T00:00:02.000Z',
      started_at: null,
      ended_at: null,
      cancel_reason: null,
    });

    const worker = new TalkRunWorker({
      executor: new BlockingExecutor(),
      pollMs: 10_000,
      maxConcurrency: 1,
    });

    await worker.start();

    await waitFor(() => getTalkRunById('run-5')?.status === 'failed');

    const staleRun = getTalkRunById('run-5');
    expect(staleRun?.cancel_reason).toBe('interrupted_by_restart');
    await waitFor(() => getTalkRunById('run-6')?.status === 'running');
    expect(getTalkRunById('run-6')?.status).toBe('running');

    await worker.stop();
  });

  it('propagates typed executor error codes to failed run events', async () => {
    const worker = new TalkRunWorker({
      executor: new AliasUnmappedExecutor(),
      pollMs: 10_000,
      maxConcurrency: 1,
    });
    await worker.start();

    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'this should fail',
      messageId: 'msg-7',
      runId: 'run-7',
    });

    worker.wake();
    await waitFor(() => getTalkRunById('run-7')?.status === 'failed');

    const run = getTalkRunById('run-7');
    expect(run?.cancel_reason).toContain('executor_alias_unmapped');

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 100);
    const failedEvent = events.find(
      (event) =>
        event.event_type === 'talk_run_failed' &&
        event.payload.includes('"runId":"run-7"'),
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.payload).toContain(
      '"errorCode":"executor_alias_unmapped"',
    );

    await worker.stop();
  });

  it('strips internal tags from streamed events and persisted assistant messages', async () => {
    const worker = new TalkRunWorker({
      executor: new InternalTagExecutor(),
      pollMs: 10_000,
      maxConcurrency: 1,
    });
    await worker.start();

    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'tell me something',
      messageId: 'msg-8',
      runId: 'run-8',
    });

    worker.wake();
    await waitFor(() => getTalkRunById('run-8')?.status === 'completed');

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 100).filter(
      (event) =>
        event.event_type === 'talk_response_delta' &&
        event.payload.includes('"runId":"run-8"'),
    );
    expect(events.map((event) => event.payload).join('')).not.toContain(
      '<internal>',
    );
    expect(
      events
        .map((event) => JSON.parse(event.payload) as { deltaText: string })
        .map((event) => event.deltaText)
        .join(''),
    ).toBe('Hello world');

    const assistantMessage = listTalkMessages({
      talkId: 'talk-1',
      limit: 20,
    }).find(
      (message) => message.run_id === 'run-8' && message.role === 'assistant',
    );
    expect(assistantMessage?.content).toBe('Hello world');

    await worker.stop();
  });

  it('suppresses outbound delivery for channel runs that explicitly stay silent', async () => {
    const agent = createRegisteredAgent({
      name: 'Channel Agent',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: '{}',
    });
    getDb()
      .prepare(
        `
        INSERT INTO talk_agents (
          id, talk_id, registered_agent_id, nickname, is_primary, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, 0, datetime('now'), datetime('now'))
      `,
      )
      .run('agent.main', 'talk-1', agent.id, agent.name);
    const connection = ensureSystemManagedTelegramConnection(
      '2024-01-01T00:00:08.000Z',
    );
    const binding = createTalkChannelBinding({
      talkId: 'talk-1',
      connectionId: connection.id,
      targetKind: 'chat',
      targetId: 'tg:chat:silent',
      displayName: 'Telegram Chat',
      createdBy: 'owner-1',
      now: '2024-01-01T00:00:08.100Z',
    });
    const worker = new TalkRunWorker({
      executor: new SuppressingChannelExecutor(
        '[[NO_CHANNEL_REPLY]] Not useful to answer here.',
      ),
      pollMs: 10_000,
      maxConcurrency: 1,
    });
    await worker.start();

    enqueueChannelTurnAtomic({
      talkId: 'talk-1',
      messageId: 'msg-channel-silent',
      runId: 'run-channel-silent',
      targetAgentId: binding.responder_agent_id!,
      content: 'ambient message',
      metadataJson: JSON.stringify({
        kind: 'channel_inbound',
        bindingId: binding.id,
        platform: 'telegram',
        connectionId: connection.id,
        targetKind: 'chat',
        targetId: 'tg:chat:silent',
        targetDisplayName: 'Telegram Chat',
        senderId: 'sender-1',
        senderName: 'Alice',
        isMentioned: false,
        timestamp: '2024-01-01T00:00:08.200Z',
        externalMessageId: 'tg-msg-silent',
        metadata: null,
      }),
      externalCreatedAt: '2024-01-01T00:00:08.200Z',
      sourceBindingId: binding.id,
      sourceExternalMessageId: 'tg-msg-silent',
      now: '2024-01-01T00:00:08.300Z',
    });

    worker.wake();
    await waitFor(
      () => getTalkRunById('run-channel-silent')?.status === 'completed',
    );

    const run = getTalkRunById('run-channel-silent');
    expect(run?.status).toBe('completed');
    expect(JSON.parse(run?.metadata_json || '{}')).toMatchObject({
      channelDelivery: {
        suppressed: true,
        suppressionReason: 'Not useful to answer here.',
      },
    });

    const assistantMessage = listTalkMessages({
      talkId: 'talk-1',
      limit: 20,
    }).find(
      (message) =>
        message.run_id === 'run-channel-silent' && message.role === 'assistant',
    );
    expect(assistantMessage).toBeUndefined();

    const outboxCount = (
      getDb()
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM channel_delivery_outbox
          WHERE binding_id = ?
        `,
        )
        .get(binding.id) as { count: number }
    ).count;
    expect(outboxCount).toBe(0);

    await worker.stop();
  });

  it('still delivers a brief reply for direct mentions even if the model emits a suppression directive', async () => {
    const agent = createRegisteredAgent({
      name: 'Channel Agent',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: '{}',
    });
    getDb()
      .prepare(
        `
        INSERT INTO talk_agents (
          id, talk_id, registered_agent_id, nickname, is_primary, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, 0, datetime('now'), datetime('now'))
      `,
      )
      .run('agent.main', 'talk-1', agent.id, agent.name);
    const connection = ensureSystemManagedTelegramConnection(
      '2024-01-01T00:00:09.000Z',
    );
    const binding = createTalkChannelBinding({
      talkId: 'talk-1',
      connectionId: connection.id,
      targetKind: 'chat',
      targetId: 'tg:chat:mention',
      displayName: 'Telegram Chat',
      createdBy: 'owner-1',
      now: '2024-01-01T00:00:09.100Z',
    });
    const worker = new TalkRunWorker({
      executor: new SuppressingChannelExecutor(
        '[[NO_CHANNEL_REPLY]] Brief answer anyway.',
      ),
      pollMs: 10_000,
      maxConcurrency: 1,
    });
    await worker.start();

    enqueueChannelTurnAtomic({
      talkId: 'talk-1',
      messageId: 'msg-channel-mention',
      runId: 'run-channel-mention',
      targetAgentId: binding.responder_agent_id!,
      content: '@bot can you help?',
      metadataJson: JSON.stringify({
        kind: 'channel_inbound',
        bindingId: binding.id,
        platform: 'telegram',
        connectionId: connection.id,
        targetKind: 'chat',
        targetId: 'tg:chat:mention',
        targetDisplayName: 'Telegram Chat',
        senderId: 'sender-2',
        senderName: 'Bob',
        isMentioned: true,
        timestamp: '2024-01-01T00:00:09.200Z',
        externalMessageId: 'tg-msg-mention',
        metadata: null,
      }),
      externalCreatedAt: '2024-01-01T00:00:09.200Z',
      sourceBindingId: binding.id,
      sourceExternalMessageId: 'tg-msg-mention',
      now: '2024-01-01T00:00:09.300Z',
    });

    worker.wake();
    await waitFor(
      () => getTalkRunById('run-channel-mention')?.status === 'completed',
    );

    const run = getTalkRunById('run-channel-mention');
    expect(run?.status).toBe('completed');
    expect(JSON.parse(run?.metadata_json || '{}')).toMatchObject({
      channelDelivery: {
        suppressed: false,
        suppressionReason: null,
      },
    });

    const assistantMessage = listTalkMessages({
      talkId: 'talk-1',
      limit: 20,
    }).find(
      (message) =>
        message.run_id === 'run-channel-mention' &&
        message.role === 'assistant',
    );
    expect(assistantMessage?.content).toBe('Brief answer anyway.');

    const outboxRow = getDb()
      .prepare(
        `
        SELECT payload_json
        FROM channel_delivery_outbox
        WHERE binding_id = ?
        LIMIT 1
      `,
      )
      .get(binding.id) as { payload_json: string } | undefined;
    expect(outboxRow?.payload_json).toContain('Brief answer anyway.');

    await worker.stop();
  });
});
