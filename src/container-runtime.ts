/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';
export type ContainerRuntimeStatus = 'ready' | 'unavailable';

const CONTAINER_RUNTIME_STATUS_CACHE_TTL_MS = 5_000;
let cachedContainerRuntimeStatus: {
  status: ContainerRuntimeStatus;
  checkedAt: number;
} | null = null;
let forcedContainerRuntimeStatusForTests: ContainerRuntimeStatus | null = null;

export class ContainerRuntimeUnavailableError extends Error {
  constructor(message = 'Container runtime is required but failed to start') {
    super(message);
    this.name = 'ContainerRuntimeUnavailableError';
  }
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

export function getContainerRuntimeStatus(input?: {
  refresh?: boolean;
  logReady?: boolean;
  logFailure?: boolean;
}): ContainerRuntimeStatus {
  if (forcedContainerRuntimeStatusForTests) {
    return forcedContainerRuntimeStatusForTests;
  }
  const now = Date.now();
  if (
    !input?.refresh &&
    cachedContainerRuntimeStatus &&
    now - cachedContainerRuntimeStatus.checkedAt <
      CONTAINER_RUNTIME_STATUS_CACHE_TTL_MS
  ) {
    return cachedContainerRuntimeStatus.status;
  }

  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10_000,
    });
    cachedContainerRuntimeStatus = {
      status: 'ready',
      checkedAt: now,
    };
    if (input?.logReady) {
      logger.debug('Container runtime already running');
    }
    return 'ready';
  } catch (err) {
    cachedContainerRuntimeStatus = {
      status: 'unavailable',
      checkedAt: now,
    };
    if (input?.logFailure) {
      logger.warn({ err }, 'Container runtime is unavailable');
    }
    return 'unavailable';
  }
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  if (
    getContainerRuntimeStatus({
      refresh: true,
      logReady: true,
      logFailure: true,
    }) !== 'ready'
  ) {
    throw new ContainerRuntimeUnavailableError();
  }
}

export function _resetContainerRuntimeStatusForTests(): void {
  cachedContainerRuntimeStatus = null;
  forcedContainerRuntimeStatusForTests = null;
}

export function _setContainerRuntimeStatusForTests(
  status: ContainerRuntimeStatus | null,
): void {
  forcedContainerRuntimeStatusForTests = status;
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
