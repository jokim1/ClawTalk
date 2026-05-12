/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_SYNC_AGENT_RUNNER_SOURCE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import {
  getExecutionTargetFolder,
  getExecutionTargetName,
  type ContainerExecutionTarget,
} from './container-execution-target.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import type { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function parseContainerOutputFromStdout(
  stdout: string,
  allowLegacyFallback: boolean,
): ParsedContainerOutput {
  const endIdx = stdout.lastIndexOf(OUTPUT_END_MARKER);
  const startIdx =
    endIdx === -1 ? -1 : stdout.lastIndexOf(OUTPUT_START_MARKER, endIdx);

  let jsonPayload: string | null = null;
  if (startIdx !== -1 && endIdx > startIdx) {
    jsonPayload = stdout
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();
  } else if (startIdx !== -1 || endIdx !== -1) {
    return {
      output: null,
      error: 'Failed to parse container output: incomplete output markers',
    };
  } else if (allowLegacyFallback) {
    const lines = stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return { output: null, error: null };
    }
    jsonPayload = lines[lines.length - 1] ?? null;
  } else {
    return { output: null, error: null };
  }

  if (!jsonPayload) {
    return { output: null, error: null };
  }

  try {
    return {
      output: JSON.parse(jsonPayload) as ContainerOutput,
      error: null,
    };
  } catch (err) {
    return {
      output: null,
      error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  model?: string;
  toolProfile?: 'default' | 'web_talk' | 'talk_main';
  timeoutProfile?: 'default' | 'fast_lane';
  allowedTools?: string[];
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  webTalkConnectorBundle?: ContainerWebTalkConnectorBundle;
  enableWebTalkOutputTools?: boolean;
  webTalkOutputToolNames?: Array<
    'list_outputs' | 'read_output' | 'write_output'
  >;
  ephemeralContextDir?: string;
  projectMountHostPath?: string | null;
  browserBridgeHostSocketPath?: string | null;
  browserBridgeSocketPath?: string | null;
  browserRunId?: string;
  browserUserId?: string;
  browserTalkId?: string | null;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface PersistentContainerTaskEnvelope {
  requestId: string;
  input: ContainerInput;
}

export type PersistentContainerWorkerStdoutMessage =
  | {
      type: 'worker_ready';
    }
  | {
      type: 'task_started';
      requestId: string;
    }
  | {
      type: 'task_output';
      requestId: string;
      output: ContainerOutput;
    }
  | {
      type: 'task_completed';
      requestId: string;
      output: ContainerOutput;
    };

export class PersistentContainerAgentWorkerError extends Error {
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

interface ParsedContainerOutput {
  output: ContainerOutput | null;
  error: string | null;
}

export type ContainerConnectorSecretPayload =
  | {
      kind: 'posthog';
      apiKey: string;
    }
  | {
      kind: 'google_docs';
      accessToken: string;
      refreshToken?: string;
      expiryDate?: string | null;
      scopes?: string[];
    }
  | {
      kind: 'google_sheets';
      accessToken: string;
      refreshToken?: string;
      expiryDate?: string | null;
      scopes?: string[];
    };

export interface ContainerWebTalkConnectorRecord {
  id: string;
  name: string;
  connectorKind: 'google_docs' | 'google_sheets' | 'posthog';
  config: Record<string, unknown> | null;
  secret: ContainerConnectorSecretPayload;
}

export interface ContainerWebTalkConnectorToolDefinition {
  connectorId: string;
  connectorKind: 'google_docs' | 'google_sheets' | 'posthog';
  connectorName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ContainerWebTalkConnectorBundle {
  connectors: ContainerWebTalkConnectorRecord[];
  toolDefinitions: ContainerWebTalkConnectorToolDefinition[];
  googleOAuth?: {
    clientId: string;
    clientSecret: string;
  };
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

const TALK_MAIN_RUN_DIR = '/workspace/run';
const PROJECT_MOUNT_PATH = '/workspace/project';
const BROWSER_BRIDGE_CONTAINER_DIR = '/workspace/browser-bridge';
const STATIC_SKILLS_CONTAINER_PATH = '/opt/nanoclaw/skills';
const PROJECT_SENSITIVE_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.npmrc',
  '.pypirc',
  '.netrc',
];

const CLAUDE_HOME_PATH = '/home/node/.claude';

if (CONTAINER_SYNC_AGENT_RUNNER_SOURCE) {
  logger.warn(
    'DEV MODE: agent-runner source sync enabled — container startup will be slower.',
  );
}

function addShadowedProjectMount(
  mounts: VolumeMount[],
  hostPath: string,
  containerPath: string,
): void {
  mounts.push({
    hostPath,
    containerPath,
    readonly: true,
  });

  for (const relativePath of PROJECT_SENSITIVE_FILES) {
    const hostFile = path.join(hostPath, relativePath);
    if (!fs.existsSync(hostFile)) continue;
    mounts.push({
      hostPath: '/dev/null',
      containerPath: path.join(containerPath, relativePath),
      readonly: true,
    });
  }
}

function ensureStaticSkillsLink(claudeHomeDir: string): void {
  const skillsDst = path.join(claudeHomeDir, 'skills');
  try {
    const stat = fs.lstatSync(skillsDst);
    if (stat.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(skillsDst);
      if (linkTarget === STATIC_SKILLS_CONTAINER_PATH) {
        return;
      }
    }
    fs.rmSync(skillsDst, { recursive: true, force: true });
  } catch {
    // ignored
  }
  fs.symlinkSync(STATIC_SKILLS_CONTAINER_PATH, skillsDst, 'dir');
}

function ensureClaudeHome(
  claudeHomeDir: string,
  disableAutoMemory: boolean,
): void {
  fs.mkdirSync(claudeHomeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeHomeDir, 'settings.json'),
    JSON.stringify(
      {
        env: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: disableAutoMemory ? '1' : '0',
        },
      },
      null,
      2,
    ) + '\n',
  );
  ensureStaticSkillsLink(claudeHomeDir);
}

function buildTalkMainVolumeMounts(
  projectRoot: string,
  ephemeralContextDir?: string,
  projectMountHostPath?: string | null,
  browserBridgeHostSocketPath?: string | null,
): VolumeMount[] {
  if (!ephemeralContextDir || !fs.existsSync(ephemeralContextDir)) {
    throw new Error(
      'talk_main container execution requires an ephemeral context directory.',
    );
  }

  const mounts: VolumeMount[] = [
    {
      hostPath: ephemeralContextDir,
      containerPath: TALK_MAIN_RUN_DIR,
      readonly: false,
    },
  ];

  if (projectMountHostPath && fs.existsSync(projectMountHostPath)) {
    addShadowedProjectMount(mounts, projectMountHostPath, PROJECT_MOUNT_PATH);
  }

  if (browserBridgeHostSocketPath) {
    const bridgeDir = path.dirname(browserBridgeHostSocketPath);
    if (fs.existsSync(bridgeDir)) {
      mounts.push({
        hostPath: bridgeDir,
        containerPath: BROWSER_BRIDGE_CONTAINER_DIR,
        readonly: false,
      });
    }
  }

  const claudeHomeDir = path.join(ephemeralContextDir, 'claude-home');
  ensureClaudeHome(claudeHomeDir, true);
  mounts.push({
    hostPath: claudeHomeDir,
    containerPath: CLAUDE_HOME_PATH,
    readonly: false,
  });

  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  if (CONTAINER_SYNC_AGENT_RUNNER_SOURCE && fs.existsSync(agentRunnerSrc)) {
    const runAgentRunnerDir = path.join(
      ephemeralContextDir,
      'agent-runner-src',
    );
    fs.cpSync(agentRunnerSrc, runAgentRunnerDir, {
      recursive: true,
      force: true,
    });
    mounts.push({
      hostPath: runAgentRunnerDir,
      containerPath: '/app/src',
      readonly: false,
    });
  }

  return mounts;
}

function buildLegacyVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  syncAgentRunnerSource: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    addShadowedProjectMount(mounts, projectRoot, PROJECT_MOUNT_PATH);
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  ensureClaudeHome(groupSessionsDir, false);
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: CLAUDE_HOME_PATH,
    readonly: false,
  });

  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (
    CONTAINER_SYNC_AGENT_RUNNER_SOURCE &&
    fs.existsSync(agentRunnerSrc) &&
    (syncAgentRunnerSource || !fs.existsSync(groupAgentRunnerDir))
  ) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, {
      recursive: true,
      force: true,
    });
  }
  if (
    CONTAINER_SYNC_AGENT_RUNNER_SOURCE &&
    fs.existsSync(groupAgentRunnerDir)
  ) {
    mounts.push({
      hostPath: groupAgentRunnerDir,
      containerPath: '/app/src',
      readonly: false,
    });
  }

  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildVolumeMounts(
  target: ContainerExecutionTarget,
  isMain: boolean,
  syncAgentRunnerSource = false,
  toolProfile: ContainerInput['toolProfile'] = 'default',
  ephemeralContextDir?: string,
  projectMountHostPath?: string | null,
  browserBridgeHostSocketPath?: string | null,
): VolumeMount[] {
  const projectRoot = process.cwd();
  if (toolProfile === 'talk_main') {
    return buildTalkMainVolumeMounts(
      projectRoot,
      ephemeralContextDir,
      projectMountHostPath,
      browserBridgeHostSocketPath,
    );
  }

  if (target.kind !== 'legacy_group') {
    throw new Error(
      `Execution target ${target.kind} does not support legacy container profiles.`,
    );
  }

  return buildLegacyVolumeMounts(target.group, isMain, syncAgentRunnerSource);
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  return {};
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  extraEnv?: Record<string, string>,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const [key, value] of Object.entries(extraEnv || {})) {
    args.push('-e', `${key}=${value}`);
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

interface PersistentTaskState {
  requestId: string;
  onOutput?: (output: ContainerOutput) => Promise<void> | void;
  onEvent?: (
    event: Extract<
      PersistentContainerWorkerStdoutMessage,
      { requestId: string }
    >,
  ) => void;
  resolve: (output: ContainerOutput) => void;
  reject: (error: Error) => void;
}

export class PersistentContainerAgentWorker {
  private readonly targetFolder: string;
  private readonly targetName: string;
  private readonly logsDir: string;
  private readonly mounts: VolumeMount[];
  private readonly containerArgs: string[];
  private readonly containerName: string;

  private container: ChildProcess | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private started = false;
  private startPromise: Promise<void> | null = null;
  private startResolve: (() => void) | null = null;
  private startReject: ((error: Error) => void) | null = null;
  private currentTask: PersistentTaskState | null = null;
  private closedError: PersistentContainerAgentWorkerError | null = null;

  constructor(
    private readonly target: ContainerExecutionTarget,
    input: ContainerInput,
  ) {
    this.targetFolder = getExecutionTargetFolder(target);
    this.targetName = getExecutionTargetName(target);
    this.logsDir =
      target.kind === 'legacy_group'
        ? path.join(resolveGroupFolderPath(target.group.folder), 'logs')
        : target.logsDir;
    this.mounts = buildVolumeMounts(
      target,
      input.isMain,
      CONTAINER_SYNC_AGENT_RUNNER_SOURCE,
      input.toolProfile,
      input.ephemeralContextDir,
      input.projectMountHostPath,
      input.browserBridgeHostSocketPath,
    );
    const safeName = this.targetFolder.replace(/[^a-zA-Z0-9-]/g, '-');
    this.containerName = `nanoclaw-${safeName}-worker-${Date.now()}`;
    this.containerArgs = buildContainerArgs(this.mounts, this.containerName, {
      NANOCLAW_PERSISTENT_WORKER: '1',
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    fs.mkdirSync(this.logsDir, { recursive: true });
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      const container = spawn(CONTAINER_RUNTIME_BIN, this.containerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.container = container;

      container.stdout.setEncoding('utf8');
      container.stderr.setEncoding('utf8');

      container.stdout.on('data', (chunk) => {
        this.handleStdoutChunk(String(chunk));
      });
      container.stderr.on('data', (chunk) => {
        const text = String(chunk);
        this.stderrBuffer += text;
        const lines = text.trim().split('\n');
        for (const line of lines) {
          if (line) {
            logger.debug({ container: this.targetFolder }, line);
          }
        }
      });
      container.on('error', (error) => {
        this.closeWithError(
          new PersistentContainerAgentWorkerError(
            error instanceof Error ? error.message : String(error),
            'worker_start_failed',
          ),
        );
      });
      container.on('close', (code) => {
        const message =
          code === 0
            ? 'Persistent container worker exited unexpectedly.'
            : `Persistent container worker exited with code ${code}.`;
        this.closeWithError(
          new PersistentContainerAgentWorkerError(message, 'worker_closed'),
        );
      });
    });

    logger.info(
      {
        group: this.targetName,
        containerName: this.containerName,
        mountCount: this.mounts.length,
      },
      'Spawning persistent container worker',
    );

    return this.startPromise;
  }

  isBusy(): boolean {
    return this.currentTask !== null;
  }

  async runTask(
    input: ContainerInput,
    callbacks?: {
      onOutput?: (output: ContainerOutput) => Promise<void> | void;
      onEvent?: (
        event: Extract<
          PersistentContainerWorkerStdoutMessage,
          { requestId: string }
        >,
      ) => void;
    },
  ): Promise<ContainerOutput> {
    await this.start();
    if (this.closedError) {
      throw this.closedError;
    }
    const container = this.container;
    const stdin = container?.stdin;
    if (!stdin || !stdin.writable) {
      throw new PersistentContainerAgentWorkerError(
        'Persistent container worker stdin is not writable.',
        'worker_closed',
      );
    }
    if (this.currentTask) {
      throw new PersistentContainerAgentWorkerError(
        'Persistent container worker is already executing a task.',
        'worker_busy',
      );
    }

    const requestId = `worker_${randomUUID()}`;
    return new Promise<ContainerOutput>((resolve, reject) => {
      this.currentTask = {
        requestId,
        onOutput: callbacks?.onOutput,
        onEvent: callbacks?.onEvent,
        resolve: (output) => {
          this.currentTask = null;
          resolve(output);
        },
        reject: (error) => {
          this.currentTask = null;
          reject(error);
        },
      };

      const envelope: PersistentContainerTaskEnvelope = {
        requestId,
        input: {
          ...input,
          secrets: input.secrets ?? readSecrets(),
          ...(input.browserBridgeHostSocketPath
            ? {
                browserBridgeSocketPath: path.posix.join(
                  BROWSER_BRIDGE_CONTAINER_DIR,
                  path.basename(input.browserBridgeHostSocketPath),
                ),
              }
            : {}),
        },
      };

      stdin.write(
        `${JSON.stringify(envelope)}\n`,
        (error: Error | null | undefined) => {
          if (!error) {
            return;
          }
          const activeTask = this.currentTask;
          if (activeTask?.requestId === requestId) {
            activeTask.reject(
              new PersistentContainerAgentWorkerError(
                error.message,
                'worker_closed',
              ),
            );
          }
        },
      );
    });
  }

  async dispose(): Promise<void> {
    if (!this.container) {
      return;
    }
    const container = this.container;
    this.container = null;
    this.startResolve = null;
    this.startReject = null;
    this.startPromise = null;
    if (!container.killed) {
      container.kill('SIGKILL');
    }
    await new Promise<void>((resolve) => {
      container.once('close', () => resolve());
      setTimeout(resolve, 250);
    });
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleStdoutLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleStdoutLine(line: string): void {
    let message: PersistentContainerWorkerStdoutMessage;
    try {
      message = JSON.parse(line) as PersistentContainerWorkerStdoutMessage;
    } catch {
      logger.debug(
        { container: this.targetFolder, line },
        'Ignoring non-JSON stdout line from persistent worker',
      );
      return;
    }

    if (message.type === 'worker_ready') {
      this.started = true;
      this.startResolve?.();
      this.startResolve = null;
      this.startReject = null;
      this.startPromise = null;
      return;
    }

    if (!('requestId' in message)) {
      return;
    }

    if (!this.currentTask || this.currentTask.requestId !== message.requestId) {
      logger.warn(
        {
          container: this.targetFolder,
          requestId: message.requestId,
          currentRequestId: this.currentTask?.requestId ?? null,
        },
        'Received persistent worker event for an unexpected request',
      );
      return;
    }

    this.currentTask.onEvent?.(message);

    if (message.type === 'task_output') {
      void this.currentTask.onOutput?.(message.output);
      return;
    }

    if (message.type === 'task_completed') {
      this.currentTask.resolve(message.output);
    }
  }

  private closeWithError(error: PersistentContainerAgentWorkerError): void {
    if (this.closedError) {
      return;
    }
    this.closedError = error;
    this.startReject?.(error);
    this.startResolve = null;
    this.startReject = null;
    this.startPromise = null;
    const activeTask = this.currentTask;
    this.currentTask = null;
    activeTask?.reject(error);
  }
}

export async function runContainerAgent(
  target: ContainerExecutionTarget,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const targetFolder = getExecutionTargetFolder(target);
  const targetName = getExecutionTargetName(target);
  const logsDir =
    target.kind === 'legacy_group'
      ? path.join(resolveGroupFolderPath(target.group.folder), 'logs')
      : target.logsDir;
  const containerConfig =
    target.kind === 'legacy_group' ? target.group.containerConfig : undefined;

  const mounts = buildVolumeMounts(
    target,
    input.isMain,
    CONTAINER_SYNC_AGENT_RUNNER_SOURCE,
    input.toolProfile,
    input.ephemeralContextDir,
    input.projectMountHostPath,
    input.browserBridgeHostSocketPath,
  );
  const safeName = targetFolder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: targetName,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: targetName,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = input.secrets ?? readSecrets();
    if (input.browserBridgeHostSocketPath) {
      input.browserBridgeSocketPath = path.posix.join(
        BROWSER_BRIDGE_CONTAINER_DIR,
        path.basename(input.browserBridgeHostSocketPath),
      );
    }
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove sensitive input so it does not appear in logs on failure.
    delete input.secrets;
    delete input.webTalkConnectorBundle;
    delete input.ephemeralContextDir;
    delete input.projectMountHostPath;
    delete input.browserBridgeHostSocketPath;
    delete input.browserBridgeSocketPath;
    delete input.browserRunId;
    delete input.browserUserId;
    delete input.browserTalkId;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: targetName, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: targetName, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: targetFolder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: targetName, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: targetName, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: targetName, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${targetName}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: targetName, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: targetName, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${targetName}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      const parsedOutput = parseContainerOutputFromStdout(stdout, !onOutput);
      if (parsedOutput.output) {
        const resolvedOutput: ContainerOutput = {
          ...parsedOutput.output,
          newSessionId:
            parsedOutput.output.newSessionId || newSessionId || undefined,
        };
        const finishWithParsedOutput = () => {
          if (code !== 0 && resolvedOutput.status === 'success') {
            logger.warn(
              {
                group: targetName,
                code,
                duration,
                logFile,
              },
              'Container exited non-zero after emitting a successful result; treating emitted output as authoritative',
            );
          } else {
            logger.info(
              {
                group: targetName,
                duration,
                status: resolvedOutput.status,
                hasResult: !!resolvedOutput.result,
              },
              'Container completed',
            );
          }
          resolve(resolvedOutput);
        };

        if (onOutput) {
          outputChain.then(finishWithParsedOutput);
        } else {
          finishWithParsedOutput();
        }
        return;
      }

      if (parsedOutput.error) {
        logger.error(
          {
            group: targetName,
            stdout,
            stderr,
            error: parsedOutput.error,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: parsedOutput.error,
        });
        return;
      }

      if (code !== 0) {
        logger.error(
          {
            group: targetName,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: targetName, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      resolve({
        status: 'error',
        result: null,
        error: 'Container completed without emitting a final response.',
      });
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: targetName, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
