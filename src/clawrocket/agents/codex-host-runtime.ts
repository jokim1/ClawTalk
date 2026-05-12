import { execFile, type ExecFileException } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';

const CODEX_VERSION_TIMEOUT_MS = 2_000;
const CODEX_LOGIN_STATUS_TIMEOUT_MS = 5_000;
const CODEX_SANDBOX_TIMEOUT_MS = 2_000;
const CODEX_MCP_CONFIG_TIMEOUT_MS = 5_000;
const AUTH_LOCK_RETRY_MS = 50;
const AUTH_LOCK_TIMEOUT_MS = 3_000;
const AUTH_LOCK_STALE_MS = 30_000;

export type CodexAuthMode = 'chatgpt' | 'apikey';

export interface CodexHostStatusView {
  cliInstalled: boolean;
  authenticated: boolean;
  authMode: CodexAuthMode | null;
  sandboxAvailable: boolean;
  managedHomePath: string;
  message: string;
  recommendedCommands: string[];
}

interface CodexAuthJson {
  auth_mode?: string;
  last_refresh?: string;
  tokens?: unknown;
  OPENAI_API_KEY?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type RunCommand = (
  file: string,
  args: string[],
  options: {
    timeoutMs: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
) => Promise<CommandResult>;

export interface CodexRunEnvironment {
  managedHomePath: string;
  runHomePath: string;
  scratchDirPath: string;
  finalMessagePath: string;
}

const CODEX_RUNTIME_ROOT = path.join(DATA_DIR, 'codex-host-runtime');
const MANAGED_CODEX_HOME_PATH = path.join(CODEX_RUNTIME_ROOT, 'managed-home');
const RUN_HOMES_DIR = path.join(CODEX_RUNTIME_ROOT, 'run-homes');
const SCRATCH_WORKSPACES_DIR = path.join(CODEX_RUNTIME_ROOT, 'scratch');

function defaultRunCommand(): RunCommand {
  return async (file, args, options) =>
    new Promise<CommandResult>((resolve, reject) => {
      execFile(
        file,
        args,
        {
          cwd: options.cwd,
          env: {
            ...process.env,
            ...options.env,
          },
          timeout: options.timeoutMs,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (
          error: ExecFileException | null,
          stdout: string | Buffer,
          stderr: string | Buffer,
        ) => {
          const normalizedStdout = String(stdout ?? '');
          const normalizedStderr = String(stderr ?? '');
          if (error) {
            reject(
              Object.assign(error, {
                stdout: normalizedStdout,
                stderr: normalizedStderr,
              }),
            );
            return;
          }
          resolve({
            stdout: normalizedStdout,
            stderr: normalizedStderr,
          });
        },
      );
    });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getSandboxCommandForPlatform(): string[] | null {
  switch (process.platform) {
    case 'darwin':
      return ['sandbox', 'macos', '--help'];
    case 'linux':
      return ['sandbox', 'linux', '--help'];
    case 'win32':
      return ['sandbox', 'windows', '--help'];
    default:
      return null;
  }
}

function mapAuthMode(value: unknown): CodexAuthMode | null {
  return value === 'chatgpt' || value === 'apikey' ? value : null;
}

function readAuthJson(homePath: string): CodexAuthJson | null {
  const authPath = path.join(homePath, 'auth.json');
  if (!fs.existsSync(authPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as CodexAuthJson;
  } catch (error) {
    logger.warn(
      { err: error, homePath },
      'Failed to parse Codex auth.json from managed home',
    );
    return null;
  }
}

function parseLoginStatus(
  output: string,
  authJson: CodexAuthJson | null,
): { authenticated: boolean; authMode: CodexAuthMode | null } {
  const authMode = mapAuthMode(authJson?.auth_mode);
  if (authMode) {
    return {
      authenticated: true,
      authMode,
    };
  }

  if (/logged in using chatgpt/i.test(output)) {
    return {
      authenticated: true,
      authMode: 'chatgpt',
    };
  }

  if (/logged in using an api key/i.test(output)) {
    return {
      authenticated: true,
      authMode: 'apikey',
    };
  }

  if (/not logged in/i.test(output)) {
    return {
      authenticated: false,
      authMode: null,
    };
  }

  return {
    authenticated: false,
    authMode: null,
  };
}

function ensureDirectory(targetPath: string): string {
  fs.mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

function getAuthPath(homePath: string): string {
  return path.join(homePath, 'auth.json');
}

async function withAuthLock<T>(
  lockPath: string,
  callback: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + AUTH_LOCK_TIMEOUT_MS;
  let fd: number | null = null;

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, String(process.pid));
      break;
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        (error as { code?: string }).code !== 'EEXIST'
      ) {
        throw error;
      }

      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > AUTH_LOCK_STALE_MS) {
          // This stale-lock cleanup is best-effort. Another process can still
          // win the race to recreate the lock between unlink and our next
          // openSync('wx'), so mergeRunAuthBackToManagedHome still relies on
          // last_refresh checks to avoid stale overwrites.
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error('codex_auth_lock_timeout');
      }
      await new Promise((resolve) => setTimeout(resolve, AUTH_LOCK_RETRY_MS));
    }
  }

  try {
    return await callback();
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
    fs.rmSync(lockPath, { force: true });
  }
}

function isNewerRefreshTimestamp(
  candidate: string | null | undefined,
  current: string | null | undefined,
): boolean {
  if (!candidate) return false;
  if (!current) return true;
  const candidateTime = Date.parse(candidate);
  const currentTime = Date.parse(current);
  if (Number.isFinite(candidateTime) && Number.isFinite(currentTime)) {
    return candidateTime > currentTime;
  }
  return candidate > current;
}

async function copyManagedAuthToRunHome(
  managedHomePath: string,
  runHomePath: string,
): Promise<void> {
  const sourceAuthPath = getAuthPath(managedHomePath);
  const destinationAuthPath = getAuthPath(runHomePath);
  if (!fs.existsSync(sourceAuthPath)) {
    return;
  }
  fs.copyFileSync(sourceAuthPath, destinationAuthPath);
}

async function mergeRunAuthBackToManagedHome(input: {
  managedHomePath: string;
  runHomePath: string;
}): Promise<void> {
  const runAuthPath = getAuthPath(input.runHomePath);
  if (!fs.existsSync(runAuthPath)) {
    return;
  }

  const runAuth = readAuthJson(input.runHomePath);
  if (!runAuth || mapAuthMode(runAuth.auth_mode) !== 'chatgpt') {
    return;
  }

  const managedAuth = readAuthJson(input.managedHomePath);
  if (
    !isNewerRefreshTimestamp(runAuth.last_refresh, managedAuth?.last_refresh)
  ) {
    return;
  }

  const lockPath = path.join(input.managedHomePath, '.auth.lock');
  await withAuthLock(lockPath, async () => {
    const latestManagedAuth = readAuthJson(input.managedHomePath);
    if (
      !isNewerRefreshTimestamp(
        runAuth.last_refresh,
        latestManagedAuth?.last_refresh,
      )
    ) {
      return;
    }

    const managedAuthPath = getAuthPath(input.managedHomePath);
    const tempAuthPath = `${managedAuthPath}.tmp`;
    fs.copyFileSync(runAuthPath, tempAuthPath);
    fs.renameSync(tempAuthPath, managedAuthPath);
  });
}

export function getManagedCodexHomePath(): string {
  return ensureDirectory(MANAGED_CODEX_HOME_PATH);
}

export async function createCodexRunEnvironment(
  runId: string,
): Promise<CodexRunEnvironment> {
  const managedHomePath = getManagedCodexHomePath();
  const runHomeBase = ensureDirectory(RUN_HOMES_DIR);
  const scratchBase = ensureDirectory(SCRATCH_WORKSPACES_DIR);
  const runHomePath = fs.mkdtempSync(
    path.join(runHomeBase, `${runId.replace(/[^a-zA-Z0-9_-]+/g, '-')}-`),
  );
  const scratchDirPath = fs.mkdtempSync(
    path.join(scratchBase, `${runId.replace(/[^a-zA-Z0-9_-]+/g, '-')}-`),
  );
  await copyManagedAuthToRunHome(managedHomePath, runHomePath);
  return {
    managedHomePath,
    runHomePath,
    scratchDirPath,
    finalMessagePath: path.join(scratchDirPath, 'FINAL_MESSAGE.md'),
  };
}

export async function cleanupCodexRunEnvironment(
  environment: CodexRunEnvironment,
): Promise<void> {
  try {
    await mergeRunAuthBackToManagedHome({
      managedHomePath: environment.managedHomePath,
      runHomePath: environment.runHomePath,
    });
  } finally {
    fs.rmSync(environment.runHomePath, { recursive: true, force: true });
    fs.rmSync(environment.scratchDirPath, { recursive: true, force: true });
  }
}

export async function registerCodexMcpServer(input: {
  runHomePath: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  runCommand?: RunCommand;
}): Promise<void> {
  const runCommand = input.runCommand || defaultRunCommand();
  const args = ['mcp', 'add', input.name];
  for (const [key, value] of Object.entries(input.env || {})) {
    args.push('--env', `${key}=${value}`);
  }
  args.push('--', input.command, ...input.args);
  await runCommand('codex', args, {
    timeoutMs: CODEX_MCP_CONFIG_TIMEOUT_MS,
    env: {
      CODEX_HOME: input.runHomePath,
    },
  });
}

export class CodexHostStatusService {
  private readonly runCommand: RunCommand;
  private readonly managedHomePath: string;

  constructor(input?: { runCommand?: RunCommand; managedHomePath?: string }) {
    this.runCommand = input?.runCommand || defaultRunCommand();
    this.managedHomePath = input?.managedHomePath || getManagedCodexHomePath();
  }

  async getStatusView(): Promise<CodexHostStatusView> {
    ensureDirectory(this.managedHomePath);
    const recommendedCommands = [
      `CODEX_HOME=${shellQuote(this.managedHomePath)} codex login`,
      `CODEX_HOME=${shellQuote(this.managedHomePath)} codex login status`,
    ];

    const cliInstalled = await this.detectCliInstalled();
    if (!cliInstalled) {
      return {
        cliInstalled: false,
        authenticated: false,
        authMode: null,
        sandboxAvailable: false,
        managedHomePath: this.managedHomePath,
        message:
          'Codex CLI was not found on this host. Install Codex, then sign in against the managed ClawRocket home.',
        recommendedCommands,
      };
    }

    const sandboxAvailable = await this.detectWorkspaceSandboxAvailable();
    const authJson = readAuthJson(this.managedHomePath);
    const loginStatus = await this.readLoginStatus(authJson);

    if (!sandboxAvailable) {
      return {
        cliInstalled: true,
        authenticated: loginStatus.authenticated,
        authMode: loginStatus.authMode,
        sandboxAvailable: false,
        managedHomePath: this.managedHomePath,
        message:
          'Codex CLI is installed, but workspace sandbox support is unavailable on this host.',
        recommendedCommands,
      };
    }

    if (!loginStatus.authenticated) {
      return {
        cliInstalled: true,
        authenticated: false,
        authMode: null,
        sandboxAvailable: true,
        managedHomePath: this.managedHomePath,
        message:
          'No Codex login was detected for the managed ClawRocket home. Run the recommended login command, then verify again.',
        recommendedCommands,
      };
    }

    return {
      cliInstalled: true,
      authenticated: true,
      authMode: loginStatus.authMode,
      sandboxAvailable: true,
      managedHomePath: this.managedHomePath,
      message:
        loginStatus.authMode === 'apikey'
          ? 'Codex is ready for host execution with API-key authentication.'
          : 'Codex is ready for host execution with ChatGPT authentication.',
      recommendedCommands,
    };
  }

  private async detectCliInstalled(): Promise<boolean> {
    try {
      await this.runCommand('codex', ['--version'], {
        timeoutMs: CODEX_VERSION_TIMEOUT_MS,
      });
      return true;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        return false;
      }
      logger.warn({ err: error }, 'Failed to probe Codex CLI version');
      return false;
    }
  }

  private async detectWorkspaceSandboxAvailable(): Promise<boolean> {
    const sandboxCommand = getSandboxCommandForPlatform();
    if (!sandboxCommand) {
      return false;
    }
    try {
      await this.runCommand('codex', sandboxCommand, {
        timeoutMs: CODEX_SANDBOX_TIMEOUT_MS,
      });
      return true;
    } catch (error) {
      logger.warn({ err: error }, 'Failed to probe Codex sandbox availability');
      return false;
    }
  }

  private async readLoginStatus(
    authJson: CodexAuthJson | null,
  ): Promise<{ authenticated: boolean; authMode: CodexAuthMode | null }> {
    try {
      const result = await this.runCommand('codex', ['login', 'status'], {
        timeoutMs: CODEX_LOGIN_STATUS_TIMEOUT_MS,
        env: {
          CODEX_HOME: this.managedHomePath,
        },
      });
      return parseLoginStatus(`${result.stdout}\n${result.stderr}`, authJson);
    } catch (error) {
      logger.warn(
        { err: error, managedHomePath: this.managedHomePath },
        'Failed to read Codex login status',
      );
      return parseLoginStatus('', authJson);
    }
  }
}

export function getCodexRuntimeRoots(): {
  runtimeRoot: string;
  managedHomePath: string;
  runHomesDir: string;
  scratchDir: string;
} {
  return {
    runtimeRoot: ensureDirectory(CODEX_RUNTIME_ROOT),
    managedHomePath: getManagedCodexHomePath(),
    runHomesDir: ensureDirectory(RUN_HOMES_DIR),
    scratchDir: ensureDirectory(SCRATCH_WORKSPACES_DIR),
  };
}

export function getCodexRecommendedLoginCommands(): string[] {
  const managedHomePath = getManagedCodexHomePath();
  return [
    `CODEX_HOME=${shellQuote(managedHomePath)} codex login`,
    `CODEX_HOME=${shellQuote(managedHomePath)} codex login status`,
  ];
}

export function getDefaultCodexHomeStatus(): CodexHostStatusView {
  return {
    cliInstalled: false,
    authenticated: false,
    authMode: null,
    sandboxAvailable: false,
    managedHomePath: getManagedCodexHomePath(),
    message:
      'Codex host runtime has not been verified for the managed ClawRocket home.',
    recommendedCommands: getCodexRecommendedLoginCommands(),
  };
}

export function getCurrentOsUserSummary(): string {
  return os.userInfo().username || process.env.USER || 'unknown';
}
