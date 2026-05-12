import { execFile, type ExecFileException } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';

import { logger } from '../../logger.js';
import { fingerprintStableJson } from './json-fingerprint.js';

const CLAUDE_VERSION_TIMEOUT_MS = 2_000;
const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 2_000;
const HOST_PROBE_TIMEOUT_MS = 5_000;

export type SubscriptionHostRuntimeContext =
  | 'host'
  | 'systemd'
  | 'container'
  | 'unknown';

export interface SubscriptionHostStatusView {
  serviceUser: string | null;
  serviceUid: number | null;
  serviceHomePath: string;
  runtimeContext: SubscriptionHostRuntimeContext;
  claudeCliInstalled: boolean | null;
  hostLoginDetected: boolean;
  serviceEnvOauthPresent: boolean;
  importAvailable: boolean;
  hostCredentialFingerprint: string | null;
  message: string;
  recommendedCommands: string[];
}

export interface SubscriptionHostImportProbe extends SubscriptionHostStatusView {
  importSource: 'service_env' | 'unsupported' | 'none';
  importCredential: string | null;
}

interface ClaudeAuthStatusJson {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type RunCommand = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<CommandResult>;

function detectRuntimeContext(
  env: NodeJS.ProcessEnv,
): SubscriptionHostRuntimeContext {
  if (env.INVOCATION_ID || env.JOURNAL_STREAM) {
    return 'systemd';
  }
  if (
    env.CONTAINER ||
    env.KUBERNETES_SERVICE_HOST ||
    existsSync('/.dockerenv')
  ) {
    return 'container';
  }
  return 'host';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('host_probe_timeout'));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function defaultRunCommand(): RunCommand {
  return async (file, args, timeoutMs) =>
    new Promise<CommandResult>((resolve, reject) => {
      execFile(
        file,
        args,
        {
          timeout: timeoutMs,
          encoding: 'utf8',
          maxBuffer: 128 * 1024,
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

function buildRecommendedCommands(
  env: NodeJS.ProcessEnv,
  serviceUser: string | null,
): string[] {
  const shellUser = env.SUDO_USER || env.LOGNAME || env.USER || null;
  const prefix =
    serviceUser && shellUser && shellUser !== serviceUser
      ? `sudo -u ${serviceUser} -H `
      : '';
  return [
    `${prefix}claude config set -g forceLoginMethod claudeai`,
    `${prefix}claude login`,
  ];
}

function buildBaseStatus(input: {
  env: NodeJS.ProcessEnv;
  serviceUser: string | null;
  serviceUid: number | null;
  serviceHomePath: string;
}): SubscriptionHostStatusView {
  return {
    serviceUser: input.serviceUser,
    serviceUid: input.serviceUid,
    serviceHomePath: input.serviceHomePath,
    runtimeContext: detectRuntimeContext(input.env),
    claudeCliInstalled: null,
    hostLoginDetected: false,
    serviceEnvOauthPresent: false,
    importAvailable: false,
    hostCredentialFingerprint: null,
    message: '',
    recommendedCommands: buildRecommendedCommands(input.env, input.serviceUser),
  };
}

export class ExecutorSubscriptionHostAuthService {
  private readonly runCommand: RunCommand;
  private readonly env: NodeJS.ProcessEnv;
  private readonly serviceUser: string | null;
  private readonly serviceUid: number | null;
  private readonly serviceHomePath: string;

  constructor(input?: {
    runCommand?: RunCommand;
    env?: NodeJS.ProcessEnv;
    serviceUser?: string | null;
    serviceUid?: number | null;
    serviceHomePath?: string;
  }) {
    this.runCommand = input?.runCommand || defaultRunCommand();
    this.env = input?.env || process.env;
    this.serviceUser =
      input?.serviceUser ?? os.userInfo().username ?? this.env.USER ?? null;
    this.serviceUid =
      input?.serviceUid ??
      (typeof process.getuid === 'function' ? process.getuid() : null);
    this.serviceHomePath = input?.serviceHomePath || os.homedir();
  }

  async getStatusView(): Promise<SubscriptionHostStatusView> {
    const probe = await this.probeImportSource();
    return {
      serviceUser: probe.serviceUser,
      serviceUid: probe.serviceUid,
      serviceHomePath: probe.serviceHomePath,
      runtimeContext: probe.runtimeContext,
      claudeCliInstalled: probe.claudeCliInstalled,
      hostLoginDetected: probe.hostLoginDetected,
      serviceEnvOauthPresent: probe.serviceEnvOauthPresent,
      importAvailable: probe.importAvailable,
      hostCredentialFingerprint: probe.hostCredentialFingerprint,
      message: probe.message,
      recommendedCommands: probe.recommendedCommands,
    };
  }

  async probeImportSource(): Promise<SubscriptionHostImportProbe> {
    return withTimeout(this.probeInternal(), HOST_PROBE_TIMEOUT_MS).catch(
      (error) => {
        const status = buildBaseStatus({
          env: this.env,
          serviceUser: this.serviceUser,
          serviceUid: this.serviceUid,
          serviceHomePath: this.serviceHomePath,
        });

        if (error instanceof Error && error.message === 'host_probe_timeout') {
          return {
            ...status,
            message:
              'Host Claude login detection timed out. Please try again, or use the advanced manual token flow.',
            importSource: 'none' as const,
            importCredential: null,
          };
        }

        logger.warn(
          { err: error },
          'Subscription host auth probe failed unexpectedly',
        );
        return {
          ...status,
          message:
            'Host Claude login detection failed unexpectedly. Use the advanced manual token flow if needed.',
          importSource: 'none' as const,
          importCredential: null,
        };
      },
    );
  }

  private async probeInternal(): Promise<SubscriptionHostImportProbe> {
    const status = buildBaseStatus({
      env: this.env,
      serviceUser: this.serviceUser,
      serviceUid: this.serviceUid,
      serviceHomePath: this.serviceHomePath,
    });
    const envOauthToken = this.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || null;
    status.serviceEnvOauthPresent = Boolean(envOauthToken);

    const claudeCliInstalled = await this.detectClaudeCliInstalled();
    status.claudeCliInstalled = claudeCliInstalled;

    if (envOauthToken) {
      const hostCredentialFingerprint = fingerprintStableJson({
        source: 'service_env',
        credential: envOauthToken,
      });
      return {
        ...status,
        hostLoginDetected: true,
        importAvailable: true,
        hostCredentialFingerprint,
        message:
          'A Claude Code OAuth token is already present in the ClawRocket service environment and can be imported into settings.',
        importSource: 'service_env',
        importCredential: envOauthToken,
      };
    }

    if (claudeCliInstalled !== true) {
      return {
        ...status,
        message:
          claudeCliInstalled === false
            ? 'Claude Code CLI was not found for the ClawRocket service user. Install Claude Code, then sign in as the same OS user that runs ClawRocket.'
            : 'Claude Code CLI detection is unavailable in this environment. Use the advanced manual token flow if needed.',
        importSource: 'none',
        importCredential: null,
      };
    }

    const cliStatus = await this.readClaudeAuthStatus();
    if (!cliStatus.loggedIn) {
      return {
        ...status,
        message:
          'No Claude Code login was detected for the ClawRocket service user. Run the recommended CLI commands as this same OS user, then check again.',
        importSource: 'none',
        importCredential: null,
      };
    }

    return {
      ...status,
      hostLoginDetected: true,
      importAvailable: false,
      message:
        'Claude Code login was detected for this service user, but the current authenticated state could not be imported automatically. Use the advanced manual token flow with `claude setup-token`.',
      importSource: 'unsupported',
      importCredential: null,
    };
  }

  private async detectClaudeCliInstalled(): Promise<boolean | null> {
    try {
      await this.runCommand('claude', ['--version'], CLAUDE_VERSION_TIMEOUT_MS);
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
      if (
        error &&
        typeof error === 'object' &&
        'killed' in error &&
        (error as { killed?: boolean }).killed
      ) {
        return null;
      }
      return null;
    }
  }

  private async readClaudeAuthStatus(): Promise<ClaudeAuthStatusJson> {
    try {
      const result = await this.runCommand(
        'claude',
        ['auth', 'status', '--json'],
        CLAUDE_AUTH_STATUS_TIMEOUT_MS,
      );
      const parsed = JSON.parse(result.stdout) as ClaudeAuthStatusJson;
      return {
        loggedIn: Boolean(parsed.loggedIn),
        authMethod:
          typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined,
        apiProvider:
          typeof parsed.apiProvider === 'string'
            ? parsed.apiProvider
            : undefined,
      };
    } catch (error) {
      logger.warn(
        { err: error },
        'Failed to read Claude CLI auth status during host subscription probe',
      );
      return {
        loggedIn: false,
        authMethod: 'none',
      };
    }
  }
}
