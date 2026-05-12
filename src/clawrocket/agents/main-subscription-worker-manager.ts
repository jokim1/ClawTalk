import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import {
  PersistentContainerAgentWorker,
  PersistentContainerAgentWorkerError,
} from '../../container-runner.js';
import { createWebRuntimeExecutionTarget } from '../../container-execution-target.js';
import {
  MAIN_SUBSCRIPTION_WARM_WORKER_BOOT_TIMEOUT_MS,
  MAIN_SUBSCRIPTION_WARM_WORKER_IDLE_TTL_MS,
  MAIN_SUBSCRIPTION_WARM_WORKER_MAX_COUNT,
} from '../config.js';
import { BrowserRunPausedError } from '../browser/run-paused-error.js';
import { ensureBrowserBridgeServer } from '../browser/bridge.js';
import { getBrowserBlockForRun, getTalkRunById } from '../db/index.js';
import {
  materializeContainerTurnContext,
  type ContainerBrowserTimeoutProfile,
  type ExecuteContainerTurnInput,
  type ExecuteContainerTurnOutput,
} from './container-turn-executor.js';

type WarmWorkerLeaseState = 'cold_boot' | 'warm_reuse' | 'recovered_cold_boot';

interface WarmWorkerTaskCallbacks {
  onQueueWaitStart?: (at: string) => void;
  onLeaseBootStart?: (input: {
    at: string;
    leaseState: 'cold_boot' | 'recovered_cold_boot';
  }) => void;
  onLeaseReady?: (input: {
    at: string;
    leaseState: WarmWorkerLeaseState;
  }) => void;
  onTaskDispatched?: (at: string) => void;
  onWorkerProgress?: (at: string) => void;
}

interface ExecuteWarmMainSubscriptionTurnInput {
  turn: ExecuteContainerTurnInput;
  timeoutProfile: ContainerBrowserTimeoutProfile;
  recoveryMode?: 'normal' | 'recovered_cold_boot';
  callbacks?: WarmWorkerTaskCallbacks;
}

export interface ExecuteWarmMainSubscriptionTurnOutput extends ExecuteContainerTurnOutput {
  leaseState: WarmWorkerLeaseState;
  timing: {
    leaseRequestedAt: string;
    leaseReadyAt: string;
    taskDispatchedAt: string;
  };
}

export class MainSubscriptionWorkerManagerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'capacity_exhausted'
      | 'worker_boot_failed'
      | 'worker_unresponsive',
  ) {
    super(message);
    this.name = 'MainSubscriptionWorkerManagerError';
  }
}

interface WorkerTaskRequest {
  input: ExecuteWarmMainSubscriptionTurnInput;
  leaseRequestedAt: string;
  resolve: (value: ExecuteWarmMainSubscriptionTurnOutput) => void;
  reject: (error: unknown) => void;
}

interface WorkerEntry {
  key: string;
  worker: PersistentContainerAgentWorker | null;
  queue: WorkerTaskRequest[];
  processing: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  workspaceDir: string;
  browserBridgeHostSocketPath: string | null;
  projectMountHostPath: string | null;
  targetAgentId: string;
  modelId: string;
  authMode: string;
  lastIdleAt: number | null;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function buildWorkerKey(input: ExecuteContainerTurnInput): string {
  return [
    input.userId,
    input.agent.id,
    input.agent.model_id,
    input.containerCredential.authMode,
  ].join(':');
}

function buildWorkspaceDir(key: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return path.join(DATA_DIR, 'main-subscription-workers', digest);
}

async function maybeThrowPausedRun(runId: string): Promise<void> {
  const pausedRun = getTalkRunById(runId);
  const browserBlock =
    pausedRun?.status === 'awaiting_confirmation'
      ? getBrowserBlockForRun(runId)
      : null;
  if (browserBlock) {
    throw new BrowserRunPausedError(runId, browserBlock);
  }
}

function toTaskInput(
  input: ExecuteContainerTurnInput,
  workspaceDir: string,
  browserBridgeHostSocketPath: string | null,
  timeoutProfile: ContainerBrowserTimeoutProfile,
): ConstructorParameters<typeof PersistentContainerAgentWorker>[1] {
  return {
    prompt: input.userMessage,
    model: input.agent.model_id,
    toolProfile: 'talk_main',
    timeoutProfile,
    allowedTools: input.allowedTools,
    groupFolder: 'web-executor',
    chatJid: 'internal:web-executor',
    isMain: true,
    assistantName: input.agent.name,
    enableWebTalkOutputTools: false,
    ephemeralContextDir: workspaceDir,
    projectMountHostPath: input.projectMountHostPath ?? null,
    browserBridgeHostSocketPath,
    browserRunId: input.runId,
    browserUserId: input.userId,
    browserTalkId: null,
    secrets: input.containerCredential.secrets,
  };
}

export class MainSubscriptionWorkerManager {
  private readonly entries = new Map<string, WorkerEntry>();
  private readonly idleTtlMs: number;
  private readonly maxCount: number;
  private readonly bootTimeoutMs: number;

  constructor(options?: {
    idleTtlMs?: number;
    maxCount?: number;
    bootTimeoutMs?: number;
  }) {
    this.idleTtlMs =
      options?.idleTtlMs ?? MAIN_SUBSCRIPTION_WARM_WORKER_IDLE_TTL_MS;
    this.maxCount =
      options?.maxCount ?? MAIN_SUBSCRIPTION_WARM_WORKER_MAX_COUNT;
    this.bootTimeoutMs =
      options?.bootTimeoutMs ?? MAIN_SUBSCRIPTION_WARM_WORKER_BOOT_TIMEOUT_MS;
  }

  async executeTask(
    input: ExecuteWarmMainSubscriptionTurnInput,
  ): Promise<ExecuteWarmMainSubscriptionTurnOutput> {
    const key = buildWorkerKey(input.turn);
    const leaseRequestedAt = new Date().toISOString();

    const existing = this.entries.get(key);
    const hadQueueWait = Boolean(
      existing && (existing.processing || existing.queue.length > 0),
    );
    if (hadQueueWait) {
      input.callbacks?.onQueueWaitStart?.(leaseRequestedAt);
    }

    const entry = await this.ensureEntry(key, input.turn);
    this.clearIdleTimer(entry);

    return new Promise<ExecuteWarmMainSubscriptionTurnOutput>(
      (resolve, reject) => {
        entry.queue.push({
          input,
          leaseRequestedAt,
          resolve,
          reject,
        });
        void this.processEntry(entry);
      },
    );
  }

  async stop(): Promise<void> {
    for (const entry of this.entries.values()) {
      this.clearIdleTimer(entry);
      await entry.worker?.dispose();
    }
    this.entries.clear();
  }

  private async ensureEntry(
    key: string,
    input: ExecuteContainerTurnInput,
  ): Promise<WorkerEntry> {
    const existing = this.entries.get(key);
    if (existing) {
      return existing;
    }

    if (this.entries.size >= this.maxCount) {
      const evicted = await this.evictOldestIdleEntry();
      if (!evicted && this.entries.size >= this.maxCount) {
        throw new MainSubscriptionWorkerManagerError(
          'No warm subscription worker capacity is currently available.',
          'capacity_exhausted',
        );
      }
    }

    const entry: WorkerEntry = {
      key,
      worker: null,
      queue: [],
      processing: false,
      idleTimer: null,
      workspaceDir: buildWorkspaceDir(key),
      browserBridgeHostSocketPath: null,
      projectMountHostPath: input.projectMountHostPath ?? null,
      targetAgentId: input.agent.id,
      modelId: input.agent.model_id,
      authMode: input.containerCredential.authMode,
      lastIdleAt: null,
    };
    ensureDir(entry.workspaceDir);
    this.entries.set(key, entry);
    return entry;
  }

  private async evictOldestIdleEntry(): Promise<boolean> {
    const idleEntries = Array.from(this.entries.values())
      .filter((entry) => !entry.processing && entry.queue.length === 0)
      .sort((left, right) => (left.lastIdleAt ?? 0) - (right.lastIdleAt ?? 0));
    const oldest = idleEntries[0];
    if (!oldest) {
      return false;
    }
    await this.disposeEntry(oldest);
    return true;
  }

  private async processEntry(entry: WorkerEntry): Promise<void> {
    if (entry.processing) {
      return;
    }
    const request = entry.queue.shift();
    if (!request) {
      entry.lastIdleAt = Date.now();
      this.scheduleIdleDispose(entry);
      return;
    }

    entry.processing = true;
    try {
      const result = await this.runRequest(entry, request);
      request.resolve(result);
    } catch (error) {
      request.reject(error);
    } finally {
      entry.processing = false;
      if (entry.queue.length > 0) {
        void this.processEntry(entry);
      } else {
        entry.lastIdleAt = Date.now();
        this.scheduleIdleDispose(entry);
      }
    }
  }

  private async runRequest(
    entry: WorkerEntry,
    request: WorkerTaskRequest,
  ): Promise<ExecuteWarmMainSubscriptionTurnOutput> {
    const { turn, timeoutProfile, callbacks, recoveryMode } = request.input;
    const abortReason = () =>
      turn.signal.reason instanceof Error
        ? turn.signal.reason
        : new Error(String(turn.signal.reason || 'Execution aborted.'));
    const abortActiveWorker = () => {
      void this.disposeWorkerOnly(entry);
    };
    if (turn.signal.aborted) {
      abortActiveWorker();
      throw abortReason();
    }
    turn.signal.addEventListener('abort', abortActiveWorker, { once: true });

    try {
      const { leaseState, leaseReadyAt } = await this.ensureWorkerReady(
        entry,
        request,
      );
      materializeContainerTurnContext({
        input: turn,
        baseDir: entry.workspaceDir,
      });
      const taskDispatchedAt = new Date().toISOString();
      callbacks?.onTaskDispatched?.(taskDispatchedAt);

      const streamedContentRef = { current: '' as string };
      const output = await entry.worker!.runTask(
        toTaskInput(
          {
            ...turn,
            projectMountHostPath: entry.projectMountHostPath,
          },
          entry.workspaceDir,
          entry.browserBridgeHostSocketPath,
          timeoutProfile,
        ),
        {
          onEvent: (event) => {
            if (event.type === 'task_started') {
              callbacks?.onWorkerProgress?.(new Date().toISOString());
            }
          },
          onOutput: async (outputChunk) => {
            if (
              outputChunk.status === 'success' &&
              typeof outputChunk.result === 'string' &&
              outputChunk.result.trim()
            ) {
              streamedContentRef.current = outputChunk.result;
            }
          },
        },
      );

      if (turn.signal.aborted) {
        throw abortReason();
      }
      await maybeThrowPausedRun(turn.runId);

      if (output.status !== 'success') {
        if (streamedContentRef.current.trim()) {
          return {
            content: streamedContentRef.current,
            leaseState,
            timing: {
              leaseRequestedAt: request.leaseRequestedAt,
              leaseReadyAt,
              taskDispatchedAt,
            },
          };
        }
        throw new Error(output.error || 'Container execution failed.');
      }

      const finalContent =
        output.result && output.result.trim()
          ? output.result
          : streamedContentRef.current;
      if (!finalContent || !finalContent.trim()) {
        throw new Error(
          'Container execution completed without a final response.',
        );
      }

      return {
        content: finalContent,
        leaseState,
        timing: {
          leaseRequestedAt: request.leaseRequestedAt,
          leaseReadyAt,
          taskDispatchedAt,
        },
      };
    } catch (error) {
      if (turn.signal.aborted) {
        throw abortReason();
      }
      try {
        await maybeThrowPausedRun(turn.runId);
      } catch (pausedError) {
        await this.disposeEntry(entry);
        throw pausedError;
      }

      if (error instanceof PersistentContainerAgentWorkerError) {
        await this.disposeEntry(entry);
        throw new MainSubscriptionWorkerManagerError(
          error.message,
          error.code === 'worker_start_failed'
            ? 'worker_boot_failed'
            : 'worker_unresponsive',
        );
      }

      if (recoveryMode === 'recovered_cold_boot') {
        await this.disposeEntry(entry);
      }
      throw error;
    } finally {
      turn.signal.removeEventListener('abort', abortActiveWorker);
    }
  }

  private async ensureWorkerReady(
    entry: WorkerEntry,
    request: WorkerTaskRequest,
  ): Promise<{
    leaseState: WarmWorkerLeaseState;
    leaseReadyAt: string;
  }> {
    const { turn, callbacks, recoveryMode } = request.input;
    const desiredBrowserBridgeHostSocketPath = turn.enableBrowserTools
      ? await ensureBrowserBridgeServer()
      : null;
    const shouldColdBoot =
      recoveryMode === 'recovered_cold_boot' ||
      !entry.worker ||
      entry.projectMountHostPath !== (turn.projectMountHostPath ?? null) ||
      entry.browserBridgeHostSocketPath !== desiredBrowserBridgeHostSocketPath;

    if (!shouldColdBoot && entry.worker) {
      const readyAt = new Date().toISOString();
      callbacks?.onLeaseReady?.({
        at: readyAt,
        leaseState: 'warm_reuse',
      });
      return {
        leaseState: 'warm_reuse',
        leaseReadyAt: readyAt,
      };
    }

    await this.disposeWorkerOnly(entry);
    entry.projectMountHostPath = turn.projectMountHostPath ?? null;
    entry.browserBridgeHostSocketPath = desiredBrowserBridgeHostSocketPath;

    const leaseState: WarmWorkerLeaseState =
      recoveryMode === 'recovered_cold_boot'
        ? 'recovered_cold_boot'
        : 'cold_boot';
    const bootStartedAt = new Date().toISOString();
    callbacks?.onLeaseBootStart?.({
      at: bootStartedAt,
      leaseState:
        leaseState === 'recovered_cold_boot'
          ? 'recovered_cold_boot'
          : 'cold_boot',
    });

    const worker = new PersistentContainerAgentWorker(
      createWebRuntimeExecutionTarget(),
      toTaskInput(
        turn,
        entry.workspaceDir,
        entry.browserBridgeHostSocketPath,
        request.input.timeoutProfile,
      ),
    );

    const bootPromise = worker.start();
    const bootResult = await Promise.race([
      bootPromise.then(() => 'ready' as const),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), this.bootTimeoutMs);
      }),
    ]);
    if (bootResult !== 'ready') {
      await worker.dispose();
      throw new MainSubscriptionWorkerManagerError(
        'Warm subscription worker boot timed out.',
        'worker_boot_failed',
      );
    }

    entry.worker = worker;
    const readyAt = new Date().toISOString();
    callbacks?.onLeaseReady?.({
      at: readyAt,
      leaseState,
    });
    return {
      leaseState,
      leaseReadyAt: readyAt,
    };
  }

  private scheduleIdleDispose(entry: WorkerEntry): void {
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      void this.disposeEntry(entry);
    }, this.idleTtlMs);
  }

  private clearIdleTimer(entry: WorkerEntry): void {
    if (!entry.idleTimer) {
      return;
    }
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  private async disposeWorkerOnly(entry: WorkerEntry): Promise<void> {
    const worker = entry.worker;
    entry.worker = null;
    if (worker) {
      await worker.dispose();
    }
  }

  private async disposeEntry(entry: WorkerEntry): Promise<void> {
    this.clearIdleTimer(entry);
    await this.disposeWorkerOnly(entry);
    if (!entry.processing && entry.queue.length === 0) {
      this.entries.delete(entry.key);
    }
  }
}

let singleton: MainSubscriptionWorkerManager | null = null;

export function getMainSubscriptionWorkerManager(): MainSubscriptionWorkerManager {
  if (!singleton) {
    singleton = new MainSubscriptionWorkerManager();
  }
  return singleton;
}

export async function stopMainSubscriptionWorkerManager(): Promise<void> {
  if (!singleton) {
    return;
  }
  await singleton.stop();
  singleton = null;
}

export async function executeWarmMainSubscriptionTurn(
  input: ExecuteWarmMainSubscriptionTurnInput,
): Promise<ExecuteWarmMainSubscriptionTurnOutput> {
  return getMainSubscriptionWorkerManager().executeTask(input);
}
