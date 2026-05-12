import { randomUUID, createHash } from 'crypto';
import fs from 'fs';
import net, { type Server as NetServer, type Socket as NetSocket } from 'net';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { execFile as execFileCb } from 'child_process';

import { logger } from './logger.js';

const execFile = promisify(execFileCb);

export const GRACEFUL_TAKEOVER_TIMEOUT_MS = 10_000;
export const FORCE_KILL_WAIT_MS = 2_000;
export const LOCK_RETRY_DELAY_MS = 250;
export const LOCK_METADATA_GRACE_MS = 2_000;
// This bounds the number of outer acquisition loops; individual iterations may
// also block inside graceful/forced takeover waits.
export const MAX_TAKEOVER_RETRIES = 48;
const TAKEOVER_SOCKET_TIMEOUT_MS = 2_000;
const APP_NAME = 'clawrocket';

export interface InstanceOwnerRecord {
  appName: 'clawrocket';
  pid: number;
  bootId: string;
  startedAt: string;
  cwd: string;
  dataDir: string;
  webHost?: string | null;
  webPort?: number | null;
  controlSocketPath?: string | null;
}

export interface InstanceCoordinatorOptions {
  dataDir: string;
  webHost?: string | null;
  webPort?: number | null;
  pid?: number;
  bootId?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  readLinuxProcessInfo?: (
    pid: number,
  ) => Promise<{ cmdline: string; cwd: string } | null>;
  readPsCommand?: (pid: number) => Promise<string | null>;
  createControlServer?: () => NetServer;
  createControlConnection?: (socketPath: string) => NetSocket;
}

type ProcessVerification =
  | { kind: 'dead' }
  | { kind: 'verified' }
  | { kind: 'unverified'; reason: string };

function isErrno(
  error: unknown,
  ...codes: string[]
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    codes.includes(String((error as NodeJS.ErrnoException).code))
  );
}

async function defaultReadLinuxProcessInfo(
  pid: number,
): Promise<{ cmdline: string; cwd: string } | null> {
  try {
    const [cmdline, cwd] = await Promise.all([
      fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf8'),
      fs.promises.readlink(`/proc/${pid}/cwd`),
    ]);
    return {
      cmdline: cmdline.replace(/\0/g, ' ').trim(),
      cwd,
    };
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ESRCH')) return null;
    throw error;
  }
}

async function defaultReadPsCommand(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFile('ps', [
      '-p',
      String(pid),
      '-o',
      'command=',
    ]);
    const command = stdout.trim();
    return command || null;
  } catch {
    return null;
  }
}

function processLooksLikeClawRocket(command: string): boolean {
  const normalized = command.toLowerCase();
  const looksLikeNamedProcess =
    /(^|[\\/\s])(clawrocket|nanoclaw)([\\/\s]|$)/.test(normalized);
  if (looksLikeNamedProcess) return true;

  // Dev launches often look like `tsx src/index.ts` or
  // `node .../tsx/dist/cli.mjs src/index.ts`, which do not include the app
  // name in /proc/<pid>/cmdline.
  const looksLikeNodeRuntime =
    /(^|[\\/\s])(node|tsx|ts-node|bun|npm|pnpm|yarn)([\\/\s]|$)/.test(
      normalized,
    );
  const looksLikeKnownEntrypoint =
    /(^|[\\/\s])(src[\\/]index\.ts|dist[\\/]index\.js)([\\/\s]|$)/.test(
      normalized,
    );

  return looksLikeNodeRuntime && looksLikeKnownEntrypoint;
}

function normalizeFsPath(input: string): string {
  return path.resolve(input);
}

export class InstanceCoordinator {
  private readonly dataDir: string;
  private readonly runtimeRoot: string;
  private readonly lockDir: string;
  private readonly lockFilePath: string;
  private readonly ownerPath: string;
  private readonly ownerTmpPath: string;
  private readonly preferredSocketPath: string;
  private readonly fallbackSocketPath: string;
  private readonly pid: number;
  private readonly bootId: string;
  private readonly cwd: string;
  private readonly platform: NodeJS.Platform;
  private readonly webHost: string | null;
  private readonly webPort: number | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly signalProcess: (
    pid: number,
    signal: NodeJS.Signals | 0,
  ) => void;
  private readonly readLinuxProcessInfo: (
    pid: number,
  ) => Promise<{ cmdline: string; cwd: string } | null>;
  private readonly readPsCommand: (pid: number) => Promise<string | null>;
  private readonly createControlServer: () => NetServer;
  private readonly createControlConnection: (socketPath: string) => NetSocket;

  private controlServer: NetServer | null = null;
  private ownershipHandle: fs.promises.FileHandle | null = null;
  private controlSocketPath: string | null = null;
  private ownerRecord: InstanceOwnerRecord | null = null;
  private releaseInFlight: Promise<void> | null = null;
  private released = false;
  private takeoverHandler:
    | ((reason: 'takeover_request') => Promise<void> | void)
    | null = null;

  constructor(options: InstanceCoordinatorOptions) {
    this.dataDir = normalizeFsPath(options.dataDir);
    this.runtimeRoot = path.join(this.dataDir, 'runtime', 'instance');
    this.lockDir = path.join(this.runtimeRoot, 'lock');
    this.lockFilePath = path.join(this.runtimeRoot, 'ownership.lock');
    this.ownerPath = path.join(this.runtimeRoot, 'owner.json');
    this.ownerTmpPath = path.join(this.runtimeRoot, 'owner.json.tmp');
    this.preferredSocketPath = path.join(this.lockDir, 'control.sock');
    this.fallbackSocketPath = path.join(
      os.tmpdir(),
      `${APP_NAME}-${createHash('sha1').update(this.dataDir).digest('hex').slice(0, 16)}.sock`,
    );
    this.pid = options.pid ?? process.pid;
    this.bootId = options.bootId ?? randomUUID();
    this.cwd = normalizeFsPath(options.cwd ?? process.cwd());
    this.platform = options.platform ?? process.platform;
    this.webHost = options.webHost ?? null;
    this.webPort = options.webPort ?? null;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.signalProcess =
      options.signalProcess ??
      ((pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal));
    this.readLinuxProcessInfo =
      options.readLinuxProcessInfo ?? defaultReadLinuxProcessInfo;
    this.readPsCommand = options.readPsCommand ?? defaultReadPsCommand;
    this.createControlServer =
      options.createControlServer ?? (() => net.createServer());
    this.createControlConnection =
      options.createControlConnection ??
      ((socketPath: string) => net.createConnection(socketPath));
  }

  getBootId(): string {
    return this.bootId;
  }

  getOwnerRecord(): InstanceOwnerRecord | null {
    return this.ownerRecord;
  }

  async acquire(
    onTakeoverRequest: (reason: 'takeover_request') => Promise<void> | void,
  ): Promise<InstanceOwnerRecord> {
    if (this.platform === 'win32') {
      throw new Error(
        'Single-instance takeover is supported only on Linux, macOS, and WSL2.',
      );
    }

    this.takeoverHandler = onTakeoverRequest;
    await fs.promises.mkdir(this.runtimeRoot, { recursive: true });

    for (let attempt = 0; attempt < MAX_TAKEOVER_RETRIES; attempt += 1) {
      const acquired = await this.tryAcquireOwnershipLock();
      if (acquired) {
        this.released = false;
        const record = await this.initializeOwnership();
        this.ownerRecord = record;
        return record;
      }

      const ownerState = await this.readOwnerState();
      if (ownerState.kind === 'recent_invalid') {
        await this.sleep(LOCK_RETRY_DELAY_MS);
        continue;
      }

      if (ownerState.kind === 'stale_invalid') {
        await this.cleanupStaleState(ownerState.controlSocketPath);
        continue;
      }

      const socketAccepted = await this.requestGracefulTakeover(
        ownerState.record,
      );
      if (socketAccepted) {
        const released = await this.waitForOwnerRelease(
          ownerState.record,
          GRACEFUL_TAKEOVER_TIMEOUT_MS,
        );
        if (released) {
          await this.cleanupStaleState(
            ownerState.record.controlSocketPath || null,
          );
          continue;
        }
      }

      const verification = await this.verifyProcessIdentity(ownerState.record);
      if (verification.kind === 'dead') {
        await this.cleanupStaleState(
          ownerState.record.controlSocketPath || null,
        );
        continue;
      }

      if (verification.kind === 'unverified') {
        throw new Error(
          `Refusing to terminate an unrelated process for singleton takeover: ${verification.reason}`,
        );
      }

      logger.warn(
        {
          ownerPid: ownerState.record.pid,
          ownerBootId: ownerState.record.bootId,
        },
        'Existing ClawRocket instance detected; requesting shutdown via signal',
      );

      this.signalProcess(ownerState.record.pid, 'SIGTERM');
      const gracefulReleased = await this.waitForOwnerRelease(
        ownerState.record,
        GRACEFUL_TAKEOVER_TIMEOUT_MS,
      );
      if (gracefulReleased) {
        await this.cleanupStaleState(
          ownerState.record.controlSocketPath || null,
        );
        continue;
      }

      this.signalProcess(ownerState.record.pid, 'SIGKILL');
      const forceReleased = await this.waitForOwnerRelease(
        ownerState.record,
        FORCE_KILL_WAIT_MS,
      );
      if (forceReleased) {
        await this.cleanupStaleState(
          ownerState.record.controlSocketPath || null,
        );
        continue;
      }

      throw new Error(
        `Timed out waiting for instance ${ownerState.record.bootId} (pid ${ownerState.record.pid}) to exit.`,
      );
    }

    throw new Error(
      'Exceeded maximum retries while attempting singleton takeover.',
    );
  }

  async release(): Promise<void> {
    if (this.released) return;
    if (this.releaseInFlight) return this.releaseInFlight;
    this.released = true;

    this.releaseInFlight = (async () => {
      const activeSocketPath = this.controlSocketPath;
      const activeServer = this.controlServer;
      const activeOwnershipHandle = this.ownershipHandle;
      this.controlServer = null;
      this.ownershipHandle = null;
      this.controlSocketPath = null;
      this.ownerRecord = null;

      if (activeServer) {
        await new Promise<void>((resolve) => {
          activeServer.close(() => resolve());
        });
      }

      await this.safeUnlink(activeSocketPath);
      if (activeSocketPath !== this.preferredSocketPath) {
        await this.safeUnlink(this.preferredSocketPath);
      }
      if (activeSocketPath !== this.fallbackSocketPath) {
        await this.safeUnlink(this.fallbackSocketPath);
      }
      await this.safeUnlink(this.ownerTmpPath);
      await this.safeUnlink(this.ownerPath);
      await fs.promises.rm(this.lockDir, { recursive: true, force: true });
      if (activeOwnershipHandle) {
        await activeOwnershipHandle.close();
      }
      await this.safeUnlink(this.lockFilePath);
      await fs.promises
        .rm(this.runtimeRoot, { recursive: false, force: true })
        .catch(() => {
          /* ignore non-empty runtime root */
        });
    })();

    await this.releaseInFlight;
  }

  private async tryAcquireOwnershipLock(): Promise<boolean> {
    try {
      this.ownershipHandle = await fs.promises.open(this.lockFilePath, 'wx');
      return true;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) return false;
      throw error;
    }
  }

  private async initializeOwnership(): Promise<InstanceOwnerRecord> {
    const socketPath = this.resolveControlSocketPath();
    const record: InstanceOwnerRecord = {
      appName: 'clawrocket',
      pid: this.pid,
      bootId: this.bootId,
      startedAt: new Date(this.now()).toISOString(),
      cwd: this.cwd,
      dataDir: this.dataDir,
      webHost: this.webHost,
      webPort: this.webPort,
      controlSocketPath: socketPath,
    };

    try {
      await fs.promises.mkdir(this.lockDir, { recursive: true });
      await this.writeOwnerRecord(record);
      await this.bindControlSocket(socketPath);
    } catch (error) {
      await this.closeOwnershipHandle();
      await this.cleanupStaleState(socketPath);
      throw error;
    }

    logger.info(
      {
        pid: record.pid,
        bootId: record.bootId,
        dataDir: record.dataDir,
      },
      'Singleton ownership acquired',
    );
    return record;
  }

  private resolveControlSocketPath(): string {
    const unixSocketMaxPath = this.platform === 'darwin' ? 103 : 107;
    return this.preferredSocketPath.length <= unixSocketMaxPath
      ? this.preferredSocketPath
      : this.fallbackSocketPath;
  }

  private async writeOwnerRecord(record: InstanceOwnerRecord): Promise<void> {
    await fs.promises.writeFile(
      this.ownerTmpPath,
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    );
    await fs.promises.rename(this.ownerTmpPath, this.ownerPath);
  }

  private async bindControlSocket(socketPath: string): Promise<void> {
    await this.ensureSocketPathAvailable(socketPath);
    const server = this.createControlServer();
    this.controlServer = server;
    this.controlSocketPath = socketPath;

    server.on('connection', (socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;

        const line = buffer.slice(0, buffer.indexOf('\n')).trim();
        buffer = '';

        try {
          const payload = JSON.parse(line) as {
            type?: string;
            expectedBootId?: string;
          };

          if (
            payload.type !== 'shutdown' ||
            payload.expectedBootId !== this.bootId
          ) {
            socket.end(
              `${JSON.stringify({ ok: false, error: 'boot_id_mismatch' })}\n`,
            );
            return;
          }

          socket.write(
            `${JSON.stringify({ ok: true, bootId: this.bootId })}\n`,
            () => {
              socket.end();
              void Promise.resolve(
                this.takeoverHandler?.('takeover_request'),
              ).catch((error) => {
                logger.error(
                  { err: error, bootId: this.bootId },
                  'Takeover shutdown handler failed',
                );
              });
            },
          );
        } catch (error) {
          logger.warn(
            { err: error },
            'Failed to parse takeover control message',
          );
          socket.end(
            `${JSON.stringify({ ok: false, error: 'invalid_request' })}\n`,
          );
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(socketPath);
    });
  }

  private async ensureSocketPathAvailable(socketPath: string): Promise<void> {
    try {
      await fs.promises.stat(socketPath);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw error;
    }

    const stale = await this.socketLooksStale(socketPath);
    if (!stale) {
      throw new Error(`Control socket path already in use: ${socketPath}`);
    }
    await this.safeUnlink(socketPath);
  }

  private async socketLooksStale(socketPath: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const client = this.createControlConnection(socketPath);
      const finish = (value: boolean) => {
        client.removeAllListeners();
        if (!client.destroyed) client.destroy();
        resolve(value);
      };

      client.once('connect', () => finish(false));
      client.once('error', (error) => {
        if (isErrno(error, 'ECONNREFUSED', 'ENOENT')) {
          finish(true);
          return;
        }
        finish(false);
      });
    });
  }

  private async readOwnerState(): Promise<
    | {
        kind: 'recent_invalid';
        controlSocketPath: string | null;
      }
    | {
        kind: 'stale_invalid';
        controlSocketPath: string | null;
      }
    | {
        kind: 'valid';
        record: InstanceOwnerRecord;
      }
  > {
    let ownerText: string | null = null;
    try {
      ownerText = await fs.promises.readFile(this.ownerPath, 'utf8');
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }

    const dirStat = await fs.promises.stat(this.lockDir).catch((error) => {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    });
    const lockStat = await fs.promises
      .stat(this.lockFilePath)
      .catch((error) => {
        if (isErrno(error, 'ENOENT')) return null;
        throw error;
      });

    const lockAgeMs = lockStat
      ? this.now() - lockStat.mtimeMs
      : dirStat
        ? this.now() - dirStat.mtimeMs
        : Infinity;

    if (!ownerText) {
      return lockAgeMs <= LOCK_METADATA_GRACE_MS
        ? { kind: 'recent_invalid', controlSocketPath: null }
        : { kind: 'stale_invalid', controlSocketPath: null };
    }

    try {
      const parsed = JSON.parse(ownerText) as InstanceOwnerRecord;
      if (
        parsed.appName !== APP_NAME ||
        typeof parsed.pid !== 'number' ||
        typeof parsed.bootId !== 'string' ||
        typeof parsed.cwd !== 'string' ||
        typeof parsed.dataDir !== 'string'
      ) {
        throw new Error('Owner record missing required fields');
      }
      return {
        kind: 'valid',
        record: {
          ...parsed,
          cwd: normalizeFsPath(parsed.cwd),
          dataDir: normalizeFsPath(parsed.dataDir),
          controlSocketPath: parsed.controlSocketPath || null,
        },
      };
    } catch {
      let controlSocketPath: string | null = null;
      try {
        const parsed = JSON.parse(ownerText) as { controlSocketPath?: unknown };
        if (typeof parsed.controlSocketPath === 'string') {
          controlSocketPath = parsed.controlSocketPath;
        }
      } catch {
        /* ignore */
      }

      return lockAgeMs <= LOCK_METADATA_GRACE_MS
        ? { kind: 'recent_invalid', controlSocketPath }
        : { kind: 'stale_invalid', controlSocketPath };
    }
  }

  private async requestGracefulTakeover(
    owner: InstanceOwnerRecord,
  ): Promise<boolean> {
    if (!owner.controlSocketPath) return false;
    const socketPath = owner.controlSocketPath;

    const response = await new Promise<
      | { kind: 'ack'; bootId: string }
      | { kind: 'missing' }
      | { kind: 'refused' }
      | { kind: 'other-error' }
    >((resolve) => {
      const client = this.createControlConnection(socketPath);
      let buffer = '';
      let settled = false;

      const finish = (
        value:
          | { kind: 'ack'; bootId: string }
          | { kind: 'missing' }
          | { kind: 'refused' }
          | { kind: 'other-error' },
      ) => {
        if (settled) return;
        settled = true;
        client.removeAllListeners();
        if (!client.destroyed) client.destroy();
        resolve(value);
      };

      client.setEncoding('utf8');
      client.setTimeout(TAKEOVER_SOCKET_TIMEOUT_MS, () => {
        finish({ kind: 'other-error' });
      });
      client.once('connect', () => {
        client.write(
          `${JSON.stringify({
            type: 'shutdown',
            expectedBootId: owner.bootId,
          })}\n`,
        );
      });
      client.on('data', (chunk) => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        const line = buffer.slice(0, buffer.indexOf('\n')).trim();
        try {
          const payload = JSON.parse(line) as {
            ok?: boolean;
            bootId?: string;
          };
          if (payload.ok === true && typeof payload.bootId === 'string') {
            finish({ kind: 'ack', bootId: payload.bootId });
            return;
          }
          finish({ kind: 'other-error' });
        } catch {
          finish({ kind: 'other-error' });
        }
      });
      client.once('error', (error) => {
        if (isErrno(error, 'ENOENT')) {
          finish({ kind: 'missing' });
          return;
        }
        if (isErrno(error, 'ECONNREFUSED')) {
          finish({ kind: 'refused' });
          return;
        }
        finish({ kind: 'other-error' });
      });
    });

    if (response.kind === 'ack' && response.bootId === owner.bootId) {
      logger.info(
        { ownerPid: owner.pid, ownerBootId: owner.bootId },
        'Existing ClawRocket instance acknowledged graceful takeover',
      );
      return true;
    }

    if (response.kind === 'refused') {
      await this.safeUnlink(socketPath);
    }

    return false;
  }

  private async waitForOwnerRelease(
    owner: InstanceOwnerRecord,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = this.now() + timeoutMs;

    while (this.now() < deadline) {
      const status = await this.verifyProcessIdentity(owner);
      if (status.kind === 'dead') return true;
      const lockExists = await fs.promises
        .stat(this.lockFilePath)
        .then(() => true)
        .catch((error) => {
          if (isErrno(error, 'ENOENT')) return false;
          throw error;
        });
      if (!lockExists) {
        const ownerStateExists = await fs.promises
          .stat(this.ownerPath)
          .then(() => true)
          .catch((error) => {
            if (isErrno(error, 'ENOENT')) return false;
            throw error;
          });
        if (!ownerStateExists) return true;
      }

      await this.sleep(LOCK_RETRY_DELAY_MS);
    }

    return false;
  }

  private async verifyProcessIdentity(
    owner: InstanceOwnerRecord,
  ): Promise<ProcessVerification> {
    const running = this.checkPidLiveness(owner.pid);
    if (running === 'dead') return { kind: 'dead' };
    if (running === 'inaccessible') {
      return {
        kind: 'unverified',
        reason: `pid ${owner.pid} is inaccessible for liveness verification`,
      };
    }

    const normalizedOwnerDataDir = normalizeFsPath(owner.dataDir);
    if (normalizedOwnerDataDir !== this.dataDir) {
      return {
        kind: 'unverified',
        reason: `owner data dir mismatch: ${normalizedOwnerDataDir}`,
      };
    }

    if (this.platform === 'linux') {
      const info = await this.readLinuxProcessInfo(owner.pid);
      if (!info) return { kind: 'dead' };
      const normalizedCwd = normalizeFsPath(info.cwd);
      if (normalizedCwd !== normalizeFsPath(owner.cwd)) {
        return {
          kind: 'unverified',
          reason: `pid ${owner.pid} cwd mismatch`,
        };
      }
      if (!processLooksLikeClawRocket(info.cmdline)) {
        return {
          kind: 'unverified',
          reason: `pid ${owner.pid} command does not look like ClawRocket`,
        };
      }
      return { kind: 'verified' };
    }

    const command = await this.readPsCommand(owner.pid);
    if (!command) return { kind: 'dead' };
    if (!processLooksLikeClawRocket(command)) {
      return {
        kind: 'unverified',
        reason: `pid ${owner.pid} command does not look like ClawRocket`,
      };
    }
    return { kind: 'verified' };
  }

  private checkPidLiveness(pid: number): 'alive' | 'dead' | 'inaccessible' {
    try {
      this.signalProcess(pid, 0);
      return 'alive';
    } catch (error) {
      if (isErrno(error, 'ESRCH')) return 'dead';
      if (isErrno(error, 'EPERM')) return 'inaccessible';
      throw error;
    }
  }

  private async cleanupStaleState(
    controlSocketPath: string | null,
  ): Promise<void> {
    const sockets = new Set<string>([this.fallbackSocketPath]);
    if (controlSocketPath && controlSocketPath !== this.preferredSocketPath) {
      sockets.add(controlSocketPath);
    }

    for (const socketPath of sockets) {
      if (socketPath !== this.preferredSocketPath) {
        await this.safeUnlink(socketPath);
      }
    }

    await this.safeUnlink(this.ownerTmpPath);
    await this.safeUnlink(this.ownerPath);
    await fs.promises.rm(this.lockDir, { recursive: true, force: true });
    await this.safeUnlink(this.lockFilePath);
  }

  private async safeUnlink(targetPath: string | null): Promise<void> {
    if (!targetPath) return;
    await fs.promises.unlink(targetPath).catch((error) => {
      if (!isErrno(error, 'ENOENT')) throw error;
    });
  }

  private async closeOwnershipHandle(): Promise<void> {
    if (!this.ownershipHandle) return;
    const handle = this.ownershipHandle;
    this.ownershipHandle = null;
    await handle.close();
  }
}
