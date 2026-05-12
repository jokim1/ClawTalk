import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockNetState = vi.hoisted(() => ({
  servers: new Map<string, unknown>(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('net', () => {
  class FakeEmitter {
    private listeners = new Map<string, Set<(...args: any[]) => void>>();

    on(event: string, handler: (...args: any[]) => void): this {
      const handlers = this.listeners.get(event) ?? new Set();
      handlers.add(handler);
      this.listeners.set(event, handlers);
      return this;
    }

    once(event: string, handler: (...args: any[]) => void): this {
      const wrapped = (...args: any[]) => {
        this.off(event, wrapped);
        handler(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, handler: (...args: any[]) => void): this {
      this.listeners.get(event)?.delete(handler);
      return this;
    }

    removeAllListeners(event?: string): this {
      if (event) {
        this.listeners.delete(event);
      } else {
        this.listeners.clear();
      }
      return this;
    }

    emit(event: string, ...args: any[]): boolean {
      const handlers = this.listeners.get(event);
      if (!handlers || handlers.size === 0) return false;
      for (const handler of [...handlers]) {
        handler(...args);
      }
      return true;
    }
  }

  class FakeSocket extends FakeEmitter {
    private peer: FakeSocket | null = null;
    private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    destroyed = false;

    setEncoding(_encoding: string): this {
      return this;
    }

    setTimeout(ms: number, onTimeout?: () => void): this {
      if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
      if (onTimeout) {
        this.timeoutHandle = setTimeout(onTimeout, ms);
      }
      return this;
    }

    attachPeer(peer: FakeSocket): void {
      this.peer = peer;
    }

    write(chunk: string, callback?: () => void): boolean {
      if (!this.destroyed && this.peer) {
        const peer = this.peer;
        queueMicrotask(() => {
          if (!peer.destroyed) {
            peer.emit('data', chunk);
          }
          callback?.();
        });
      } else {
        callback?.();
      }
      return true;
    }

    end(chunk?: string): this {
      const finalize = () => {
        this.emit('end');
        this.destroy();
        if (this.peer && !this.peer.destroyed) {
          this.peer.emit('end');
          this.peer.destroy();
        }
      };
      if (chunk) {
        this.write(chunk, () => queueMicrotask(finalize));
      } else {
        queueMicrotask(finalize);
      }
      return this;
    }

    destroy(): this {
      this.destroyed = true;
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
        this.timeoutHandle = null;
      }
      return this;
    }
  }

  class FakeNetServer extends FakeEmitter {
    socketPath: string | null = null;

    listen(socketPath: string): this {
      this.socketPath = socketPath;
      mockNetState.servers.set(socketPath, this);
      queueMicrotask(() => this.emit('listening'));
      return this;
    }

    close(callback?: () => void): this {
      if (this.socketPath) {
        mockNetState.servers.delete(this.socketPath);
      }
      queueMicrotask(() => callback?.());
      return this;
    }
  }

  const createServer = () => new FakeNetServer();
  const createConnection = (socketPath: string) => {
    const client = new FakeSocket();
    const server = mockNetState.servers.get(socketPath);

    queueMicrotask(() => {
      if (!server) {
        const error = new Error('missing socket') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        client.emit('error', error);
        return;
      }

      const serverSide = new FakeSocket();
      client.attachPeer(serverSide);
      serverSide.attachPeer(client);
      (server as FakeNetServer).emit('connection', serverSide);
      client.emit('connect');
    });

    return client;
  };

  return {
    default: {
      createConnection,
      createServer,
    },
    createConnection,
    createServer,
  };
});

import { InstanceCoordinator } from './instance-coordinator.js';

function createErrno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function createDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clawrocket-instance-'));
}

function getLockPaths(dataDir: string): {
  runtimeRoot: string;
  lockDir: string;
  lockFilePath: string;
  ownerPath: string;
  socketPath: string;
} {
  const runtimeRoot = path.join(dataDir, 'runtime', 'instance');
  const lockDir = path.join(runtimeRoot, 'lock');
  return {
    runtimeRoot,
    lockDir,
    lockFilePath: path.join(runtimeRoot, 'ownership.lock'),
    ownerPath: path.join(runtimeRoot, 'owner.json'),
    socketPath: path.join(lockDir, 'control.sock'),
  };
}

async function writeOwnerRecord(
  dataDir: string,
  input: {
    pid: number;
    bootId: string;
    cwd?: string;
    controlSocketPath?: string | null;
  },
): Promise<void> {
  const { runtimeRoot, ownerPath, lockFilePath } = getLockPaths(dataDir);
  await fs.promises.mkdir(runtimeRoot, { recursive: true });
  await fs.promises.writeFile(lockFilePath, 'owner-lock\n', 'utf8');
  await fs.promises.writeFile(
    ownerPath,
    JSON.stringify(
      {
        appName: 'clawrocket',
        pid: input.pid,
        bootId: input.bootId,
        startedAt: new Date().toISOString(),
        cwd: input.cwd ?? dataDir,
        dataDir,
        webHost: null,
        webPort: null,
        controlSocketPath: input.controlSocketPath ?? null,
      },
      null,
      2,
    ),
    'utf8',
  );
}

describe('InstanceCoordinator', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    mockNetState.servers.clear();
  });

  afterEach(async () => {
    mockNetState.servers.clear();
    await Promise.all(
      tempDirs.map((dir) =>
        fs.promises.rm(dir, { recursive: true, force: true }),
      ),
    );
    tempDirs.length = 0;
  });

  it('acquires ownership, writes metadata, and releases lock state', async () => {
    const dataDir = createDataDir();
    tempDirs.push(dataDir);

    const coordinator = new InstanceCoordinator({
      dataDir,
      pid: 12345,
      bootId: 'boot-owner',
      cwd: dataDir,
    });

    const record = await coordinator.acquire(async () => {});
    const { lockDir, lockFilePath, ownerPath } = getLockPaths(dataDir);

    expect(record.bootId).toBe('boot-owner');
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.existsSync(lockFilePath)).toBe(true);
    expect(fs.existsSync(ownerPath)).toBe(true);
    expect(record.controlSocketPath).toBeTruthy();

    const stored = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as {
      bootId: string;
      dataDir: string;
    };
    expect(stored.bootId).toBe('boot-owner');
    expect(stored.dataDir).toBe(path.resolve(dataDir));

    await coordinator.release();

    expect(fs.existsSync(lockDir)).toBe(false);
    expect(fs.existsSync(lockFilePath)).toBe(false);
  });

  it('retries when metadata is missing but the lock directory is still fresh', async () => {
    const dataDir = createDataDir();
    tempDirs.push(dataDir);
    const { runtimeRoot, lockFilePath } = getLockPaths(dataDir);
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(lockFilePath, 'owner-lock\n');

    let sleepCalls = 0;
    const coordinator = new InstanceCoordinator({
      dataDir,
      pid: 2001,
      bootId: 'boot-retry',
      cwd: dataDir,
      sleep: async () => {
        sleepCalls += 1;
        expect(fs.existsSync(lockFilePath)).toBe(true);
        if (sleepCalls === 1) {
          await fs.promises.unlink(lockFilePath);
        }
      },
    });

    const record = await coordinator.acquire(async () => {});

    expect(sleepCalls).toBeGreaterThan(0);
    expect(record.bootId).toBe('boot-retry');

    await coordinator.release();
  });

  it('cleans up stale owners with dead pids and acquires ownership', async () => {
    const dataDir = createDataDir();
    tempDirs.push(dataDir);
    const { lockFilePath } = getLockPaths(dataDir);
    await writeOwnerRecord(dataDir, {
      pid: 3333,
      bootId: 'stale-owner',
    });
    const staleAt = new Date(Date.now() - 10_000);
    fs.utimesSync(lockFilePath, staleAt, staleAt);

    const coordinator = new InstanceCoordinator({
      dataDir,
      pid: 3334,
      bootId: 'replacement-owner',
      cwd: dataDir,
      signalProcess: (_pid, signal) => {
        if (signal === 0) throw createErrno('ESRCH');
        throw new Error('dead owners should not receive termination signals');
      },
    });

    const record = await coordinator.acquire(async () => {});

    expect(record.bootId).toBe('replacement-owner');

    await coordinator.release();
  });

  it('uses the control socket to request graceful takeover', async () => {
    const dataDir = createDataDir();
    tempDirs.push(dataDir);

    const coordinatorA = new InstanceCoordinator({
      dataDir,
      pid: process.pid,
      bootId: 'boot-a',
      cwd: dataDir,
    });
    const coordinatorB = new InstanceCoordinator({
      dataDir,
      pid: process.pid,
      bootId: 'boot-b',
      cwd: dataDir,
    });
    const takeoverReasons: string[] = [];

    await coordinatorA.acquire(async (reason) => {
      takeoverReasons.push(reason);
      await coordinatorA.release();
    });

    const record = await coordinatorB.acquire(async () => {});

    expect(takeoverReasons).toEqual(['takeover_request']);
    expect(record.bootId).toBe('boot-b');

    await coordinatorB.release();
  });

  it('falls back to SIGTERM after an acknowledged takeover when the owner is a tsx dev process', async () => {
    const dataDir = createDataDir();
    tempDirs.push(dataDir);

    let alive = true;
    let now = 0;
    const signals: Array<NodeJS.Signals | 0> = [];

    const coordinatorA = new InstanceCoordinator({
      dataDir,
      pid: 4666,
      bootId: 'owner-dev',
      cwd: dataDir,
    });
    const coordinatorB = new InstanceCoordinator({
      dataDir,
      pid: 4667,
      bootId: 'replacement-dev',
      cwd: dataDir,
      platform: 'linux',
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      signalProcess: (_pid, signal) => {
        if (signal === 0) {
          if (!alive) throw createErrno('ESRCH');
          return;
        }
        signals.push(signal);
        if (signal === 'SIGTERM') alive = false;
      },
      readLinuxProcessInfo: async () =>
        alive
          ? {
              cmdline:
                'node /home/k1min8r/projects/clawrocket/node_modules/tsx/dist/cli.mjs src/index.ts',
              cwd: dataDir,
            }
          : null,
    });

    await coordinatorA.acquire(async () => {
      /* simulate a hung graceful shutdown */
    });

    const record = await coordinatorB.acquire(async () => {});

    expect(record.bootId).toBe('replacement-dev');
    expect(signals).toEqual(['SIGTERM']);

    await coordinatorA.release();
    await coordinatorB.release();
  });

  it('falls back to SIGTERM when metadata is valid but no control socket path is available', async () => {
    const dataDir = createDataDir();
    tempDirs.push(dataDir);
    await writeOwnerRecord(dataDir, {
      pid: 4444,
      bootId: 'owner-missing-socket',
      controlSocketPath: null,
    });

    let alive = true;
    const signals: Array<NodeJS.Signals | 0> = [];
    const coordinator = new InstanceCoordinator({
      dataDir,
      pid: 4445,
      bootId: 'replacement',
      cwd: dataDir,
      platform: 'linux',
      signalProcess: (_pid, signal) => {
        if (signal === 0) {
          if (!alive) throw createErrno('ESRCH');
          return;
        }
        signals.push(signal);
        if (signal === 'SIGTERM') alive = false;
      },
      readLinuxProcessInfo: async () =>
        alive
          ? {
              cmdline: '/tmp/ClawRocket/node src/index.ts',
              cwd: dataDir,
            }
          : null,
    });

    const record = await coordinator.acquire(async () => {});

    expect(record.bootId).toBe('replacement');
    expect(signals).toEqual(['SIGTERM']);

    await coordinator.release();
  });

  it('aborts takeover when pid liveness is inaccessible with EPERM', async () => {
    const dataDir = createDataDir();
    tempDirs.push(dataDir);
    await writeOwnerRecord(dataDir, {
      pid: 4545,
      bootId: 'owner-eperm',
      controlSocketPath: null,
    });

    const signals: Array<NodeJS.Signals | 0> = [];
    const coordinator = new InstanceCoordinator({
      dataDir,
      pid: 4546,
      bootId: 'replacement-eperm',
      cwd: dataDir,
      signalProcess: (_pid, signal) => {
        signals.push(signal);
        throw createErrno('EPERM');
      },
    });

    await expect(coordinator.acquire(async () => {})).rejects.toThrow(
      /Refusing to terminate an unrelated process/,
    );
    expect(signals).toEqual([0]);
  });

  it('escalates from SIGTERM to SIGKILL when the owner does not exit gracefully', async () => {
    const dataDir = createDataDir();
    tempDirs.push(dataDir);
    await writeOwnerRecord(dataDir, {
      pid: 5555,
      bootId: 'owner-sigkill',
      controlSocketPath: getLockPaths(dataDir).socketPath,
    });

    let alive = true;
    let now = 0;
    const signals: Array<NodeJS.Signals | 0> = [];
    const coordinator = new InstanceCoordinator({
      dataDir,
      pid: 5556,
      bootId: 'replacement-sigkill',
      cwd: dataDir,
      platform: 'linux',
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      signalProcess: (_pid, signal) => {
        if (signal === 0) {
          if (!alive) throw createErrno('ESRCH');
          return;
        }
        signals.push(signal);
        if (signal === 'SIGKILL') alive = false;
      },
      readLinuxProcessInfo: async () =>
        alive
          ? {
              cmdline: '/tmp/ClawRocket/node src/index.ts',
              cwd: dataDir,
            }
          : null,
    });

    const record = await coordinator.acquire(async () => {});

    expect(record.bootId).toBe('replacement-sigkill');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);

    await coordinator.release();
  });

  it('lets only one contender own the lock and makes the loser take over later', async () => {
    const dataDir = createDataDir();
    tempDirs.push(dataDir);

    const coordinatorA = new InstanceCoordinator({
      dataDir,
      pid: process.pid,
      bootId: 'boot-race-a',
      cwd: dataDir,
    });
    const coordinatorB = new InstanceCoordinator({
      dataDir,
      pid: process.pid,
      bootId: 'boot-race-b',
      cwd: dataDir,
    });
    const takeoverReasons: string[] = [];

    const acquireA = coordinatorA.acquire(async (reason) => {
      takeoverReasons.push(`a:${reason}`);
      await coordinatorA.release();
    });
    const acquireB = coordinatorB.acquire(async (reason) => {
      takeoverReasons.push(`b:${reason}`);
      await coordinatorB.release();
    });

    const [recordA, recordB] = await Promise.all([acquireA, acquireB]);

    expect([recordA.bootId, recordB.bootId].sort()).toEqual([
      'boot-race-a',
      'boot-race-b',
    ]);
    expect(takeoverReasons).toHaveLength(1);

    const activeOwners = [
      coordinatorA.getOwnerRecord()?.bootId,
      coordinatorB.getOwnerRecord()?.bootId,
    ].filter(Boolean);
    expect(activeOwners).toHaveLength(1);

    await coordinatorA.release();
    await coordinatorB.release();
  });
});
