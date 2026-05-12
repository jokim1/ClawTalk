/**
 * Integration tests for MainRunWorker: claim → execute → sanitize → complete/fail.
 */
import { randomUUID } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  createMessage,
  enqueueMainTurnAtomic,
  getOutboxEventsForTopics,
  getTalkRunById,
  pauseRunForBrowserBlock,
  upsertSettingValue,
  updateTalkRunMetadata,
  upsertUser,
} from '../db/index.js';
import { createRegisteredAgent } from '../db/agent-accessors.js';
import type { BrowserBlockMetadata } from '../browser/metadata.js';
import { BrowserRunPausedError } from '../browser/run-paused-error.js';
import type {
  MainExecutionEvent,
  MainExecutorInput,
  MainExecutorOutput,
} from './main-executor.js';
import { MainRunPhaseTimeoutError } from './main-executor.js';
import { MainRunWorker, type MainExecutorFn } from './main-run-worker.js';

const USER_A = 'user-a';
let AGENT_ID: string;
const PROVIDER_ID = 'builtin.mock';
const MODEL_ID = 'mock-default';

function upsertProviderVerification(
  providerId: string,
  status: 'verified' | 'invalid',
  lastError: string | null = null,
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO llm_provider_verifications (
         provider_id, status, last_verified_at, last_error, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         status = excluded.status,
         last_verified_at = excluded.last_verified_at,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
    )
    .run(
      providerId,
      status,
      status === 'verified' ? now : null,
      lastError,
      now,
    );
}

beforeEach(() => {
  _initTestDatabase();
  upsertUser({ id: USER_A, email: 'a@test.com', displayName: 'User A' });
  const agent = createRegisteredAgent({
    name: 'Test Main Agent',
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
  });
  AGENT_ID = agent.id;
});

/** Creates a mock executor that returns successfully with given content. */
function createMockExecutor(
  responseContent: string,
  opts?: { latencyMs?: number; emitInternalTags?: boolean },
): MainExecutorFn {
  return async (
    input: MainExecutorInput,
    _signal: AbortSignal,
    emit?: (event: MainExecutionEvent) => void,
  ): Promise<MainExecutorOutput> => {
    emit?.({
      type: 'main_response_started',
      runId: input.runId,
      threadId: input.threadId,
      agentId: AGENT_ID,
      agentName: 'Test Agent',
    });

    const content = opts?.emitInternalTags
      ? `<internal>thinking</internal>${responseContent}`
      : responseContent;

    emit?.({
      type: 'main_response_delta',
      runId: input.runId,
      threadId: input.threadId,
      text: content,
    });

    return {
      content,
      agentId: AGENT_ID,
      agentName: 'Test Agent',
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      threadId: input.threadId,
      latencyMs: opts?.latencyMs ?? 42,
      usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.001 },
    };
  };
}

/** Creates a mock executor that throws. */
function createFailingExecutor(errorMessage: string): MainExecutorFn {
  return async (): Promise<MainExecutorOutput> => {
    throw new Error(errorMessage);
  };
}

function createPausedExecutor(): MainExecutorFn {
  return async (input: MainExecutorInput): Promise<MainExecutorOutput> => {
    const browserBlock: BrowserBlockMetadata = {
      kind: 'auth_required',
      sessionId: 'bs_linkedin_auth',
      siteKey: 'linkedin',
      accountLabel: null,
      url: 'https://www.linkedin.com/checkpoint/challenge',
      title: 'LinkedIn Login',
      message: 'LinkedIn requires interactive authentication.',
      riskReason: null,
      setupCommand: "npx tsx src/clawrocket/browser/setup.ts --site 'linkedin'",
      artifacts: [],
      confirmationId: null,
      pendingToolCall: {
        toolName: 'browser_open',
        args: {
          siteKey: 'linkedin',
          url: 'https://www.linkedin.com/messaging/',
        },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    pauseRunForBrowserBlock({
      runId: input.runId,
      browserBlock,
    });
    throw new BrowserRunPausedError(input.runId, browserBlock);
  };
}

/** Helper to enqueue a turn and return its IDs. */
function enqueueTurn(threadId?: string) {
  const tid = threadId ?? randomUUID();
  const messageId = `msg_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  enqueueMainTurnAtomic({
    threadId: tid,
    userId: USER_A,
    content: 'hello from test',
    messageId,
    runId,
  });
  return { threadId: tid, messageId, runId };
}

/** Wait for a run to reach a terminal status. */
async function waitForRunTerminal(
  runId: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = getTalkRunById(runId);
    if (run && (run.status === 'completed' || run.status === 'failed')) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `Run ${runId} did not reach terminal status within ${timeoutMs}ms`,
  );
}

async function waitForRunStatus(
  runId: string,
  status: 'awaiting_confirmation' | 'completed' | 'failed',
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = getTalkRunById(runId);
    if (run?.status === status) {
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `Run ${runId} did not reach status ${status} within ${timeoutMs}ms`,
  );
}

describe('MainRunWorker integration', () => {
  it('claims, executes, and completes a run with sanitized content', async () => {
    const { runId, threadId } = enqueueTurn();

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: createMockExecutor('Hello world'),
    });
    await worker.start();

    await waitForRunTerminal(runId);
    await worker.stop();

    // Run should be completed
    const run = getTalkRunById(runId)!;
    expect(run.status).toBe('completed');
    expect(run.ended_at).toBeTruthy();

    // Assistant message should be stored
    const msg = getDb()
      .prepare(
        `SELECT * FROM talk_messages
         WHERE thread_id = ? AND role = 'assistant'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(threadId) as any;
    expect(msg).toBeTruthy();
    expect(msg.content).toBe('Hello world');

    // LLM attempt should record latency and usage
    const attempt = getDb()
      .prepare('SELECT * FROM llm_attempts WHERE run_id = ?')
      .get(runId) as any;
    expect(attempt).toBeTruthy();
    expect(attempt.latency_ms).toBe(42);
    expect(attempt.input_tokens).toBe(10);
    expect(attempt.output_tokens).toBe(20);

    // Terminal outbox event should exist
    const events = getOutboxEventsForTopics([`user:${USER_A}`], 0);
    const terminal = events.find(
      (e) => e.event_type === 'main_response_completed',
    );
    expect(terminal).toBeTruthy();
  });

  it('refreshes the persisted thread summary after a completed run', async () => {
    const threadId = 'thread-summary-metadata';

    const now = new Date().toISOString();
    getDb()
      .prepare(
        `
        INSERT INTO main_threads (thread_id, user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `,
      )
      .run(threadId, USER_A, now, now);

    for (let index = 1; index <= 13; index += 1) {
      createMessage({
        id: `seed-msg-${String(index).padStart(2, '0')}`,
        talkId: null,
        threadId,
        role: index % 2 === 0 ? 'assistant' : 'user',
        content:
          index === 1
            ? 'Important earlier fact: the launch code is Atlas.'
            : `Seed thread message ${index}`,
        createdBy: index % 2 === 0 ? null : USER_A,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
    }

    const { runId } = enqueueTurn(threadId);

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: createMockExecutor('Summary refreshed'),
    });
    await worker.start();

    await waitForRunTerminal(runId);
    await worker.stop();

    const summaryRow = getDb()
      .prepare(
        `
        SELECT summary_text, covers_through_message_id
        FROM main_thread_summaries
        WHERE thread_id = ?
      `,
      )
      .get(threadId) as
      | {
          summary_text: string;
          covers_through_message_id: string | null;
        }
      | undefined;
    expect(summaryRow?.summary_text).toContain('Atlas');
    expect(summaryRow?.covers_through_message_id).toBeTruthy();
  });

  it('sanitizes internal tags from both streamed deltas and stored content', async () => {
    const { runId, threadId } = enqueueTurn();

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: createMockExecutor('visible text', { emitInternalTags: true }),
    });
    await worker.start();

    await waitForRunTerminal(runId);
    await worker.stop();

    // Stored content should have internal tags stripped
    const msg = getDb()
      .prepare(
        `SELECT * FROM talk_messages
         WHERE thread_id = ? AND role = 'assistant'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(threadId) as any;
    expect(msg.content).toBe('visible text');
    expect(msg.content).not.toContain('<internal>');

    // Streamed delta events should also be sanitized
    const events = getOutboxEventsForTopics([`user:${USER_A}`], 0);
    const deltas = events
      .filter((e) => e.event_type === 'main_response_delta')
      .map((e) => JSON.parse(e.payload));
    for (const delta of deltas) {
      expect(delta.text).not.toContain('<internal>');
    }
  });

  it('persists streamed preview and heartbeat metadata while completing a run', async () => {
    const { runId } = enqueueTurn();

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: async (
        input: MainExecutorInput,
        _signal: AbortSignal,
        emit?: (event: MainExecutionEvent) => void,
      ): Promise<MainExecutorOutput> => {
        emit?.({
          type: 'main_response_started',
          runId: input.runId,
          threadId: input.threadId,
          agentId: AGENT_ID,
          agentName: 'Test Agent',
        });
        emit?.({
          type: 'main_progress_update',
          runId: input.runId,
          threadId: input.threadId,
          message: 'Opening LinkedIn…',
        });
        emit?.({
          type: 'main_response_delta',
          runId: input.runId,
          threadId: input.threadId,
          text: 'Visible answer',
        });
        return {
          content: 'Visible answer',
          agentId: AGENT_ID,
          agentName: 'Test Agent',
          providerId: PROVIDER_ID,
          modelId: MODEL_ID,
          threadId: input.threadId,
          latencyMs: 42,
          usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.001 },
        };
      },
    });
    await worker.start();

    await waitForRunTerminal(runId);
    await worker.stop();

    const run = getTalkRunById(runId)!;
    const metadata = JSON.parse(run.metadata_json || '{}') as Record<
      string,
      unknown
    >;
    expect(metadata.streamedTextPreview).toBe('Visible answer');
    expect(typeof metadata.lastHeartbeatAt).toBe('string');
    expect(metadata.lastProgressMessage).toBeNull();
  });

  it('persists terminal summary metadata for failed runs', async () => {
    const { runId } = enqueueTurn();

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: async (
        input: MainExecutorInput,
        _signal: AbortSignal,
        emit?: (event: MainExecutionEvent) => void,
      ): Promise<MainExecutorOutput> => {
        emit?.({
          type: 'main_response_started',
          runId: input.runId,
          threadId: input.threadId,
          agentId: AGENT_ID,
          agentName: 'Test Agent',
        });
        emit?.({
          type: 'main_response_delta',
          runId: input.runId,
          threadId: input.threadId,
          text: 'Partial preview',
        });
        throw new Error('boom failure');
      },
    });
    await worker.start();

    await waitForRunTerminal(runId);
    await worker.stop();

    const run = getTalkRunById(runId)!;
    expect(run.status).toBe('failed');
    const metadata = JSON.parse(run.metadata_json || '{}') as {
      streamedTextPreview?: string | null;
      terminalSummary?: { statusLabel?: string; body?: string } | null;
    };
    expect(metadata.streamedTextPreview).toBe('Partial preview');
    expect(metadata.terminalSummary?.statusLabel).toBe('Failed');
    expect(metadata.terminalSummary?.body).toBe('boom failure');
  });

  it('emits heartbeats for slow-running runs before model output arrives', async () => {
    vi.useFakeTimers();
    try {
      const { runId, threadId } = enqueueTurn();
      let resolveRun!: (value: MainExecutorOutput) => void;
      const completion = new Promise<MainExecutorOutput>((resolve) => {
        resolveRun = resolve;
      });

      const worker = new MainRunWorker({
        pollMs: 10,
        maxConcurrency: 1,
        heartbeatMs: 1_000,
        executor: async (
          input: MainExecutorInput,
          _signal: AbortSignal,
          emit?: (event: MainExecutionEvent) => void,
        ): Promise<MainExecutorOutput> => {
          emit?.({
            type: 'main_response_started',
            runId: input.runId,
            threadId: input.threadId,
            agentId: AGENT_ID,
            agentName: 'Test Agent',
          });
          return completion;
        },
      });
      await worker.start();

      await vi.advanceTimersByTimeAsync(2_100);

      const heartbeatEvents = getOutboxEventsForTopics(
        [`user:${USER_A}`],
        0,
      ).filter((event) => event.event_type === 'main_heartbeat');
      expect(heartbeatEvents.length).toBeGreaterThanOrEqual(2);

      const metadata = JSON.parse(
        getTalkRunById(runId)?.metadata_json || '{}',
      ) as {
        lastHeartbeatAt?: string | null;
      };
      expect(typeof metadata.lastHeartbeatAt).toBe('string');

      resolveRun({
        content: 'done',
        agentId: AGENT_ID,
        agentName: 'Test Agent',
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        threadId,
        latencyMs: 42,
        usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.001 },
      });

      await vi.advanceTimersByTimeAsync(50);
      await worker.stop();
      expect(getTalkRunById(runId)?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails the run and emits terminal event on executor error', async () => {
    const { runId } = enqueueTurn();

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: createFailingExecutor('LLM provider unreachable'),
    });
    await worker.start();

    await waitForRunTerminal(runId);
    await worker.stop();

    // Run should be failed
    const run = getTalkRunById(runId)!;
    expect(run.status).toBe('failed');
    expect(run.cancel_reason).toContain('LLM provider unreachable');

    // Terminal failure event should exist
    const events = getOutboxEventsForTopics([`user:${USER_A}`], 0);
    const failure = events.find((e) => e.event_type === 'main_response_failed');
    expect(failure).toBeTruthy();
    const payload = JSON.parse(failure!.payload);
    expect(payload.errorCode).toBe('execution_failed');
    expect(payload.errorMessage).toContain('LLM provider unreachable');
  });

  it('invalidates Anthropic browser verification after a direct auth failure', async () => {
    upsertProviderVerification('provider.anthropic', 'verified');
    const threadId = randomUUID();
    const runId = `run_${randomUUID()}`;
    enqueueMainTurnAtomic({
      threadId,
      userId: USER_A,
      content: 'Open LinkedIn',
      messageId: `msg_${randomUUID()}`,
      runId,
      taskType: 'browser',
      selectedMode: 'api',
      transport: 'direct',
    });

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: createFailingExecutor('Anthropic API error: Unauthorized'),
    });
    await worker.start();

    await waitForRunTerminal(runId);
    await worker.stop();

    const verification = getDb()
      .prepare(
        `SELECT status, last_error FROM llm_provider_verifications WHERE provider_id = 'provider.anthropic'`,
      )
      .get() as { status: string; last_error: string | null } | undefined;
    expect(verification?.status).toBe('invalid');
    expect(verification?.last_error).toContain('Unauthorized');
  });

  it('invalidates executor verification after a subscription bootstrap failure', async () => {
    upsertSettingValue({
      key: 'executor.verificationStatus',
      value: 'verified',
      updatedBy: USER_A,
    });
    const threadId = randomUUID();
    const runId = `run_${randomUUID()}`;
    enqueueMainTurnAtomic({
      threadId,
      userId: USER_A,
      content: 'Open LinkedIn',
      messageId: `msg_${randomUUID()}`,
      runId,
      taskType: 'browser',
      selectedMode: 'subscription',
      transport: 'subscription',
    });

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: createFailingExecutor(
        'Claude container runtime is unavailable on this host. Start Docker before using subscription mode for browser runs.',
      ),
    });
    await worker.start();

    await waitForRunTerminal(runId);
    await worker.stop();

    expect(
      getDb()
        .prepare(
          `SELECT value FROM settings_kv WHERE key = 'executor.verificationStatus'`,
        )
        .get() as { value: string } | undefined,
    ).toMatchObject({ value: 'not_verified' });
    expect(
      getDb()
        .prepare(
          `SELECT value FROM settings_kv WHERE key = 'executor.lastVerificationError'`,
        )
        .get() as { value: string } | undefined,
    ).toMatchObject({
      value: expect.stringContaining('container runtime is unavailable'),
    });
  });

  it('does not invalidate readiness for ordinary browser task failures', async () => {
    upsertProviderVerification('provider.anthropic', 'verified');
    upsertSettingValue({
      key: 'executor.verificationStatus',
      value: 'verified',
      updatedBy: USER_A,
    });
    const threadId = randomUUID();
    const runId = `run_${randomUUID()}`;
    enqueueMainTurnAtomic({
      threadId,
      userId: USER_A,
      content: 'Open LinkedIn',
      messageId: `msg_${randomUUID()}`,
      runId,
      taskType: 'browser',
      selectedMode: 'subscription',
      transport: 'subscription',
    });

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: createFailingExecutor('LinkedIn login required'),
    });
    await worker.start();

    await waitForRunTerminal(runId);
    await worker.stop();

    expect(
      getDb()
        .prepare(
          `SELECT status FROM llm_provider_verifications WHERE provider_id = 'provider.anthropic'`,
        )
        .get() as { status: string } | undefined,
    ).toMatchObject({ status: 'verified' });
    expect(
      getDb()
        .prepare(
          `SELECT value FROM settings_kv WHERE key = 'executor.verificationStatus'`,
        )
        .get() as { value: string } | undefined,
    ).toMatchObject({ value: 'verified' });
  });

  it('persists timeout phase metadata when execution exceeds a phase budget', async () => {
    const { runId } = enqueueTurn();

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: async (): Promise<MainExecutorOutput> => {
        throw new MainRunPhaseTimeoutError(
          'first_page_ready',
          'The browser did not reach a usable page state quickly enough.',
        );
      },
    });
    await worker.start();

    await waitForRunTerminal(runId);
    await worker.stop();

    const run = getTalkRunById(runId)!;
    expect(run.status).toBe('failed');
    expect(run.cancel_reason).toContain('execution_timeout');
    const metadata = JSON.parse(run.metadata_json || '{}') as {
      timeoutPhase?: string | null;
      terminalSummary?: { body?: string } | null;
    };
    expect(metadata.timeoutPhase).toBe('first_page_ready');
    expect(metadata.terminalSummary?.body).toBe(
      'The browser did not reach a usable page state quickly enough.',
    );
  });

  it('keeps browser auth blocks in awaiting_confirmation instead of failing the run', async () => {
    const threadId = randomUUID();
    const runId = `run_${randomUUID()}`;
    enqueueMainTurnAtomic({
      threadId,
      userId: USER_A,
      content: 'Open LinkedIn and tell me what you can access.',
      messageId: `msg_${randomUUID()}`,
      runId,
      taskType: 'browser',
      selectedMode: 'subscription',
      transport: 'subscription',
    });

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: createPausedExecutor(),
    });
    await worker.start();

    await waitForRunStatus(runId, 'awaiting_confirmation');
    await worker.stop();

    const run = getTalkRunById(runId)!;
    expect(run.status).toBe('awaiting_confirmation');
    expect(run.cancel_reason).toBeNull();
    const metadata = JSON.parse(run.metadata_json || '{}') as {
      browserBlock?: { kind?: string; siteKey?: string };
      timeoutPhase?: string | null;
    };
    expect(metadata.browserBlock).toMatchObject({
      kind: 'auth_required',
      siteKey: 'linkedin',
    });
    expect(metadata.timeoutPhase ?? null).toBeNull();
  });

  it('recovers interrupted runs on startup', async () => {
    const { runId } = enqueueTurn();
    // Manually transition to running to simulate a crash
    getDb()
      .prepare(
        `UPDATE talk_runs SET status = 'running', started_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), runId);

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: createMockExecutor('should not be called'),
    });
    await worker.start();
    // Give it a tick to process
    await new Promise((r) => setTimeout(r, 50));
    await worker.stop();

    // Run should have been failed by startup recovery
    const run = getTalkRunById(runId)!;
    expect(run.status).toBe('failed');
    expect(run.cancel_reason).toContain('interrupted_by_restart');
  });

  it('auto-queues a deferred paused run after the active runnable run completes', async () => {
    const threadId = randomUUID();
    const pausedRunId = `run_${randomUUID()}`;
    enqueueMainTurnAtomic({
      threadId,
      userId: USER_A,
      content: 'Needs auth first',
      messageId: `msg_${randomUUID()}`,
      runId: pausedRunId,
    });
    updateTalkRunMetadata(pausedRunId, (current) => ({
      ...current,
      browserBlock: {
        kind: 'auth_required',
        sessionId: 'session-1',
        siteKey: 'linkedin',
        accountLabel: null,
        url: 'https://www.linkedin.com/login',
        title: 'LinkedIn Login',
        message: 'Authenticate to continue.',
        riskReason: null,
        setupCommand: null,
        artifacts: [],
        confirmationId: null,
        pendingToolCall: null,
        createdAt: '2026-03-21T20:00:00.000Z',
        updatedAt: '2026-03-21T20:00:00.000Z',
      },
      resumeRequestedAt: '2026-03-21T20:01:00.000Z',
      resumeRequestedBy: USER_A,
    }));
    getDb()
      .prepare(
        `UPDATE talk_runs SET status = 'awaiting_confirmation' WHERE id = ?`,
      )
      .run(pausedRunId);

    const activeRunId = `run_${randomUUID()}`;
    enqueueMainTurnAtomic({
      threadId,
      userId: USER_A,
      content: 'Current runnable task',
      messageId: `msg_${randomUUID()}`,
      runId: activeRunId,
    });

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: async (
        input: MainExecutorInput,
        _signal: AbortSignal,
        emit?: (event: MainExecutionEvent) => void,
      ): Promise<MainExecutorOutput> => {
        emit?.({
          type: 'main_response_started',
          runId: input.runId,
          threadId: input.threadId,
          agentId: AGENT_ID,
          agentName: 'Test Agent',
        });
        return {
          content: `done ${input.runId}`,
          agentId: AGENT_ID,
          agentName: 'Test Agent',
          providerId: PROVIDER_ID,
          modelId: MODEL_ID,
          threadId: input.threadId,
          latencyMs: 42,
          usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.001 },
        };
      },
    });
    await worker.start();

    await waitForRunTerminal(activeRunId);
    await waitForRunTerminal(pausedRunId);
    await worker.stop();

    expect(getTalkRunById(activeRunId)?.status).toBe('completed');
    expect(getTalkRunById(pausedRunId)?.status).toBe('completed');
  });

  it('pauses a browser-tagged run on session conflict before executing the model', async () => {
    const threadId = randomUUID();
    const ownerRunId = `run_${randomUUID()}`;
    enqueueMainTurnAtomic({
      threadId,
      userId: USER_A,
      content: 'Open LinkedIn',
      messageId: `msg_${randomUUID()}`,
      runId: ownerRunId,
    });
    updateTalkRunMetadata(ownerRunId, (current) => ({
      ...current,
      browserBlock: {
        kind: 'auth_required',
        sessionId: 'session-1',
        siteKey: 'linkedin',
        accountLabel: null,
        url: 'https://www.linkedin.com/login',
        title: 'LinkedIn Login',
        message: 'Authenticate to continue.',
        riskReason: null,
        setupCommand: null,
        artifacts: [],
        confirmationId: null,
        pendingToolCall: null,
        createdAt: '2026-03-21T20:00:00.000Z',
        updatedAt: '2026-03-21T20:00:00.000Z',
      },
    }));
    getDb()
      .prepare(
        `UPDATE talk_runs SET status = 'awaiting_confirmation' WHERE id = ?`,
      )
      .run(ownerRunId);

    const waitingRunId = `run_${randomUUID()}`;
    enqueueMainTurnAtomic({
      threadId,
      userId: USER_A,
      content: 'Try LinkedIn again',
      messageId: `msg_${randomUUID()}`,
      runId: waitingRunId,
    });
    updateTalkRunMetadata(waitingRunId, (current) => ({
      ...current,
      requestedToolFamilies: ['browser'],
    }));

    let executed = false;
    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: async (): Promise<MainExecutorOutput> => {
        executed = true;
        throw new Error('executor should not have been called');
      },
    });
    await worker.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await worker.stop();

    expect(executed).toBe(false);
    const run = getTalkRunById(waitingRunId);
    expect(run?.status).toBe('awaiting_confirmation');
    const metadata = JSON.parse(run?.metadata_json || '{}') as {
      browserBlock?: { kind?: string; conflictingRunId?: string };
    };
    expect(metadata.browserBlock?.kind).toBe('session_conflict');
    expect(metadata.browserBlock?.conflictingRunId).toBe(ownerRunId);
  });
});
