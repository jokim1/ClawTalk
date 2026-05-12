import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ensureBrowserBridgeServerMock = vi.hoisted(() =>
  vi.fn(async () => '/tmp/browser.sock'),
);
const materializeContainerTurnContextMock = vi.hoisted(() => vi.fn());
const getTalkRunByIdMock = vi.hoisted(() =>
  vi.fn(() => ({ status: 'running' })),
);
const getBrowserBlockForRunMock = vi.hoisted(() => vi.fn(() => null));
const workerHarness = vi.hoisted(() => {
  class FakePersistentContainerAgentWorkerError extends Error {
    constructor(
      message: string,
      public readonly code:
        | 'worker_start_failed'
        | 'worker_closed'
        | 'worker_protocol_error'
        | 'worker_busy',
    ) {
      super(message);
      this.name = 'PersistentContainerAgentWorkerError';
    }
  }

  const workerInstances: Array<{
    initialInput: unknown;
    disposed: boolean;
    runTaskInputs: unknown[];
  }> = [];
  let workerStartImpl: (() => Promise<void>) | null = null;
  let workerRunTaskImpl:
    | ((
        input: unknown,
        callbacks?:
          | {
              onOutput?: (output: {
                status: 'success' | 'error';
                result: string | null;
              }) => Promise<void> | void;
              onEvent?: (event: { type: string; requestId: string }) => void;
            }
          | undefined,
      ) => Promise<{ status: 'success' | 'error'; result: string | null }>)
    | null = null;

  class FakePersistentContainerAgentWorker {
    public readonly initialInput: unknown;
    public disposed = false;
    public readonly runTaskInputs: unknown[] = [];

    constructor(_target: unknown, input: unknown) {
      this.initialInput = input;
      workerInstances.push(this);
    }

    async start(): Promise<void> {
      if (workerStartImpl) {
        await workerStartImpl();
      }
    }

    async runTask(
      input: unknown,
      callbacks?:
        | {
            onOutput?: (output: {
              status: 'success' | 'error';
              result: string | null;
            }) => Promise<void> | void;
            onEvent?: (event: { type: string; requestId: string }) => void;
          }
        | undefined,
    ): Promise<{ status: 'success' | 'error'; result: string | null }> {
      this.runTaskInputs.push(input);
      if (workerRunTaskImpl) {
        return workerRunTaskImpl(input, callbacks);
      }
      callbacks?.onEvent?.({
        type: 'task_started',
        requestId: 'request-1',
      });
      return {
        status: 'success',
        result: 'Warm worker result',
      };
    }

    async dispose(): Promise<void> {
      this.disposed = true;
    }
  }

  return {
    FakePersistentContainerAgentWorker,
    FakePersistentContainerAgentWorkerError,
    workerInstances,
    reset() {
      workerInstances.length = 0;
      workerStartImpl = null;
      workerRunTaskImpl = null;
    },
    setWorkerStartImpl(fn: (() => Promise<void>) | null) {
      workerStartImpl = fn;
    },
    setWorkerRunTaskImpl(
      fn:
        | ((
            input: unknown,
            callbacks?:
              | {
                  onOutput?: (output: {
                    status: 'success' | 'error';
                    result: string | null;
                  }) => Promise<void> | void;
                  onEvent?: (event: {
                    type: string;
                    requestId: string;
                  }) => void;
                }
              | undefined,
          ) => Promise<{ status: 'success' | 'error'; result: string | null }>)
        | null,
    ) {
      workerRunTaskImpl = fn;
    },
  };
});

vi.mock('../../container-runner.js', () => ({
  PersistentContainerAgentWorker:
    workerHarness.FakePersistentContainerAgentWorker,
  PersistentContainerAgentWorkerError:
    workerHarness.FakePersistentContainerAgentWorkerError,
}));

vi.mock('../../container-execution-target.js', () => ({
  createWebRuntimeExecutionTarget: vi.fn(() => ({ kind: 'web-runtime' })),
}));

vi.mock('../browser/bridge.js', () => ({
  ensureBrowserBridgeServer: ensureBrowserBridgeServerMock,
}));

vi.mock('../db/index.js', () => ({
  getTalkRunById: getTalkRunByIdMock,
  getBrowserBlockForRun: getBrowserBlockForRunMock,
}));

vi.mock('./container-turn-executor.js', () => ({
  materializeContainerTurnContext: materializeContainerTurnContextMock,
}));

import {
  executeWarmMainSubscriptionTurn,
  MainSubscriptionWorkerManager,
  MainSubscriptionWorkerManagerError,
  stopMainSubscriptionWorkerManager,
} from './main-subscription-worker-manager.js';

function buildTurnInput(overrides?: Partial<Record<string, unknown>>) {
  return {
    runId: 'run-main-1',
    userId: 'owner-1',
    agent: {
      id: 'agent.main',
      name: 'Nanoclaw',
      provider_id: 'provider.anthropic',
      model_id: 'claude-sonnet-4-6',
    },
    promptLabel: 'main' as const,
    userMessage: 'Open LinkedIn and tell me what you can access.',
    signal: new AbortController().signal,
    allowedTools: ['browser_open'],
    context: {
      systemPrompt: 'Browser fast lane',
      history: [],
    },
    modelContextWindow: 128000,
    containerCredential: {
      authMode: 'subscription',
      credentialSource: 'oauth_token',
      secrets: {
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      },
    },
    threadId: 'thread-main-1',
    enableBrowserTools: true,
    timeoutProfile: 'fast_lane' as const,
    ...(overrides || {}),
  };
}

describe('main-subscription-worker-manager', () => {
  beforeEach(() => {
    workerHarness.reset();
    ensureBrowserBridgeServerMock.mockClear();
    materializeContainerTurnContextMock.mockReset();
    getTalkRunByIdMock.mockReset();
    getTalkRunByIdMock.mockReturnValue({ status: 'running' });
    getBrowserBlockForRunMock.mockReset();
    getBrowserBlockForRunMock.mockReturnValue(null);
  });

  afterEach(async () => {
    await stopMainSubscriptionWorkerManager();
  });

  it('reuses one warm worker across multiple Main threads for the same user/agent/model/auth key', async () => {
    const first = await executeWarmMainSubscriptionTurn({
      turn: buildTurnInput({
        runId: 'run-thread-a',
        threadId: 'thread-a',
      }) as never,
      timeoutProfile: 'fast_lane',
    });

    const second = await executeWarmMainSubscriptionTurn({
      turn: buildTurnInput({
        runId: 'run-thread-b',
        threadId: 'thread-b',
      }) as never,
      timeoutProfile: 'fast_lane',
    });

    expect(first.leaseState).toBe('cold_boot');
    expect(second.leaseState).toBe('warm_reuse');
    expect(workerHarness.workerInstances).toHaveLength(1);
    expect(materializeContainerTurnContextMock).toHaveBeenCalledTimes(2);
    expect(materializeContainerTurnContextMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        input: expect.objectContaining({
          threadId: 'thread-a',
        }),
      }),
    );
    expect(materializeContainerTurnContextMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        input: expect.objectContaining({
          threadId: 'thread-b',
        }),
      }),
    );
    expect(workerHarness.workerInstances[0]?.runTaskInputs).toHaveLength(2);
  });

  it('serializes concurrent tasks for the same worker key and exposes queue wait timing', async () => {
    let notifyFirstRunStarted: (() => void) | undefined;
    let releaseFirstRun: (() => void) | undefined;
    const firstRunStarted = new Promise<void>((resolve) => {
      notifyFirstRunStarted = resolve;
    });
    const firstRunGate = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    let callCount = 0;
    workerHarness.setWorkerRunTaskImpl(async (_input, callbacks) => {
      callCount += 1;
      callbacks?.onEvent?.({
        type: 'task_started',
        requestId: `request-${callCount}`,
      });
      if (callCount === 1) {
        notifyFirstRunStarted?.();
        await firstRunGate;
      }
      return {
        status: 'success',
        result: `Warm worker result ${callCount}`,
      };
    });

    const first = executeWarmMainSubscriptionTurn({
      turn: buildTurnInput({
        runId: 'run-first',
        threadId: 'thread-a',
      }) as never,
      timeoutProfile: 'fast_lane',
    });
    await firstRunStarted;

    const queueWaitStart = vi.fn();
    const second = executeWarmMainSubscriptionTurn({
      turn: buildTurnInput({
        runId: 'run-second',
        threadId: 'thread-b',
      }) as never,
      timeoutProfile: 'fast_lane',
      callbacks: {
        onQueueWaitStart: queueWaitStart,
      },
    });

    expect(queueWaitStart).toHaveBeenCalledTimes(1);
    releaseFirstRun?.();

    await expect(first).resolves.toMatchObject({
      leaseState: 'cold_boot',
    });
    await expect(second).resolves.toMatchObject({
      leaseState: 'warm_reuse',
    });
    expect(workerHarness.workerInstances).toHaveLength(1);
  });

  it('maps worker failures to manager errors and evicts the worker', async () => {
    workerHarness.setWorkerRunTaskImpl(async () => {
      throw new workerHarness.FakePersistentContainerAgentWorkerError(
        'Worker stopped responding.',
        'worker_closed',
      );
    });

    await expect(
      executeWarmMainSubscriptionTurn({
        turn: buildTurnInput() as never,
        timeoutProfile: 'fast_lane',
      }),
    ).rejects.toMatchObject({
      code: 'worker_unresponsive',
    });
    expect(workerHarness.workerInstances[0]?.disposed).toBe(true);
  });

  it('boots a new worker after the previous one was disposed', async () => {
    const manager = new MainSubscriptionWorkerManager({
      idleTtlMs: 1,
      maxCount: 1,
      bootTimeoutMs: 100,
    });

    const first = await manager.executeTask({
      turn: buildTurnInput({
        runId: 'run-first',
      }) as never,
      timeoutProfile: 'fast_lane',
    });
    expect(first.leaseState).toBe('cold_boot');
    await manager.stop();

    const secondManager = new MainSubscriptionWorkerManager({
      idleTtlMs: 1,
      maxCount: 1,
      bootTimeoutMs: 100,
    });
    const second = await secondManager.executeTask({
      turn: buildTurnInput({
        runId: 'run-second',
      }) as never,
      timeoutProfile: 'fast_lane',
    });
    await secondManager.stop();

    expect(second.leaseState).toBe('cold_boot');
    expect(workerHarness.workerInstances.length).toBeGreaterThanOrEqual(2);
  });
});
