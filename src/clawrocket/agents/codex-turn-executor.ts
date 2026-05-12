import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

import { getDb } from '../../db.js';
import { logger } from '../../logger.js';
import type { RegisteredAgentRecord } from '../db/agent-accessors.js';
import { BrowserRunPausedError } from '../browser/run-paused-error.js';
import { getBrowserBlockForRun, getTalkRunById } from '../db/index.js';
import type { TalkJobExecutionPolicy } from '../talks/executor.js';
import type { ExecutionContext } from './agent-router.js';
import type { LlmMessage } from './llm-client.js';
import {
  cleanupCodexRunEnvironment,
  createCodexRunEnvironment,
  registerCodexMcpServer,
  type CodexRunEnvironment,
} from './codex-host-runtime.js';

interface ExecuteCodexTurnInput {
  runId: string;
  userId: string;
  agent: RegisteredAgentRecord;
  promptLabel: 'talk' | 'main';
  userMessage: string;
  signal: AbortSignal;
  context: Pick<ExecutionContext, 'systemPrompt' | 'history'>;
  modelContextWindow: number;
  talkId?: string;
  threadId: string;
  triggerMessageId?: string | null;
  historyMessageIds?: string[];
  projectMountHostPath?: string | null;
  jobPolicy?: TalkJobExecutionPolicy | null;
  enableWebTools?: boolean;
  enableBrowserTools?: boolean;
  onProgressUpdate?: (message: string) => void;
}

export interface ExecuteCodexTurnOutput {
  content: string;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  };
}

interface MaterializedSourceFile {
  ref: string;
  title: string;
  relativePath: string;
  inlinePreview: string | null;
}

interface MaterializedAttachmentFile {
  id: string;
  fileName: string | null;
  relativePath: string;
}

type CodexJsonEvent = Record<string, unknown> & {
  type?: string;
};

const OUTPUT_RESERVE = 4096;
const MCP_TOOL_RESERVE = 2000;
const CHARS_TO_TOKENS = 0.25;
const SMALL_SOURCE_THRESHOLD = 250;
const CODEX_STARTUP_TIMEOUT_MS = 20_000;
const CODEX_IDLE_TIMEOUT_MS = 60_000;
const MAX_PROGRESS_MESSAGE_CHARS = 240;
const RUN_CONTEXT_FILE_NAME = 'RUN_CONTEXT.md';
const REQUEST_FILE_NAME = 'REQUEST.md';
const HISTORY_FILE_NAME = 'HISTORY.md';
const SOURCES_DIR_NAME = 'sources';
const ATTACHMENTS_DIR_NAME = 'attachments';

function estimateTokens(text: string): number {
  return Math.ceil(text.length * CHARS_TO_TOKENS);
}

function formatMessageContent(content: LlmMessage['content']): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(content, null, 2);
}

function writeFile(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(
    targetPath,
    content.endsWith('\n') ? content : `${content}\n`,
  );
}

function renderHistoryMarkdown(history: LlmMessage[]): string {
  if (history.length === 0) {
    return 'No prior conversation history for this run.\n';
  }

  return history
    .map((message) => {
      const role = message.role.toUpperCase();
      return `## ${role}\n\n${formatMessageContent(message.content)}`;
    })
    .join('\n\n');
}

function shrinkHistoryToBudget(
  history: LlmMessage[],
  budgetTokens: number,
): LlmMessage[] {
  if (budgetTokens <= 0) {
    return [];
  }

  const selected: LlmMessage[] = [];
  let used = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    const tokens = estimateTokens(formatMessageContent(message.content));
    if (used + tokens > budgetTokens) {
      break;
    }
    used += tokens;
    selected.push(message);
  }
  selected.reverse();
  return selected;
}

function sanitizeFileNameSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function materializeTalkSourceFiles(
  baseDir: string,
  talkId: string,
): MaterializedSourceFile[] {
  const rows = getDb()
    .prepare(
      `
      SELECT source_ref, title, source_type, source_url, file_name, extracted_text
      FROM talk_context_sources
      WHERE talk_id = ? AND status = 'ready' AND extracted_text IS NOT NULL
      ORDER BY sort_order ASC, created_at ASC
    `,
    )
    .all(talkId) as Array<{
    source_ref: string;
    title: string;
    source_type: string;
    source_url: string | null;
    file_name: string | null;
    extracted_text: string;
  }>;

  return rows.map((row) => {
    const safeRef = sanitizeFileNameSegment(row.source_ref || 'source');
    const relativePath = path.join(SOURCES_DIR_NAME, `${safeRef}.md`);
    const filePath = path.join(baseDir, relativePath);
    writeFile(
      filePath,
      [
        `# ${row.source_ref}: ${row.title}`,
        '',
        `Type: ${row.source_type}`,
        row.source_url ? `URL: ${row.source_url}` : null,
        row.file_name ? `File name: ${row.file_name}` : null,
        '',
        row.extracted_text,
      ]
        .filter(Boolean)
        .join('\n'),
    );

    const inlinePreview =
      row.source_type === 'text' &&
      estimateTokens(row.extracted_text) < SMALL_SOURCE_THRESHOLD
        ? row.extracted_text
        : null;

    return {
      ref: row.source_ref,
      title: row.title,
      relativePath,
      inlinePreview,
    };
  });
}

function listScopedAttachmentIds(input: {
  triggerMessageId?: string | null;
  historyMessageIds?: string[];
}): string[] {
  const ids = new Set<string>();
  if (input.triggerMessageId) {
    ids.add(input.triggerMessageId);
  }
  for (const messageId of input.historyMessageIds || []) {
    ids.add(messageId);
  }
  return Array.from(ids);
}

function materializeTalkAttachmentFiles(
  baseDir: string,
  talkId: string,
  messageIds: string[],
): MaterializedAttachmentFile[] {
  if (messageIds.length === 0) {
    return [];
  }

  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `
      SELECT id, file_name, extracted_text
      FROM talk_message_attachments
      WHERE talk_id = ?
        AND message_id IN (${placeholders})
        AND extracted_text IS NOT NULL
      ORDER BY created_at ASC
    `,
    )
    .all(talkId, ...messageIds) as Array<{
    id: string;
    file_name: string | null;
    extracted_text: string;
  }>;

  return rows.map((row) => {
    const fileStem = sanitizeFileNameSegment(
      row.file_name || `attachment-${row.id}`,
    );
    const relativePath = path.join(
      ATTACHMENTS_DIR_NAME,
      `${sanitizeFileNameSegment(row.id)}-${fileStem}.md`,
    );
    const filePath = path.join(baseDir, relativePath);
    writeFile(
      filePath,
      [
        `# Attachment ${row.id}`,
        row.file_name ? `File name: ${row.file_name}` : null,
        '',
        row.extracted_text,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return {
      id: row.id,
      fileName: row.file_name,
      relativePath,
    };
  });
}

function buildRunContextMarkdown(input: {
  promptLabel: 'talk' | 'main';
  systemPrompt: string;
  sourceFiles: MaterializedSourceFile[];
  attachmentFiles: MaterializedAttachmentFile[];
  historyIncluded: boolean;
  projectMountHostPath?: string | null;
}): string {
  const sections: string[] = ['# ClawRocket Run Context'];

  if (input.systemPrompt.trim()) {
    sections.push(input.systemPrompt.trim());
  }

  sections.push(
    [
      `Read \`${REQUEST_FILE_NAME}\` for the user-visible request for this run.`,
      input.historyIncluded
        ? `Read \`${HISTORY_FILE_NAME}\` for bounded conversation history.`
        : 'No separate history file is provided for this run.',
      input.projectMountHostPath
        ? `A persistent writable project directory is available at ${input.projectMountHostPath}. Put lasting code changes there.`
        : 'No persistent project directory is attached. Any files created in this workspace are scratch-only and will be deleted after the run.',
      'Treat this scratch workspace as transient context only.',
    ].join(' '),
  );

  if (input.sourceFiles.length > 0) {
    sections.push(
      [
        '## Source Files',
        ...input.sourceFiles.map((source) =>
          [
            `- [${source.ref}] ${source.title} -> ${source.relativePath}`,
            source.inlinePreview
              ? `  Inline preview:\n${source.inlinePreview}`
              : null,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      ].join('\n'),
    );
  }

  if (input.attachmentFiles.length > 0) {
    sections.push(
      [
        '## Attachment Files',
        ...input.attachmentFiles.map(
          (attachment) =>
            `- [${attachment.id}] ${attachment.fileName || 'attachment'} -> ${attachment.relativePath}`,
        ),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}

function shouldPassCodexModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const normalized = modelId.trim().toLowerCase();
  return (
    normalized !== '' &&
    normalized !== 'default' &&
    normalized !== 'provider-default'
  );
}

function truncateProgressMessage(message: string): string {
  if (message.length <= MAX_PROGRESS_MESSAGE_CHARS) {
    return message;
  }
  return `${message.slice(0, MAX_PROGRESS_MESSAGE_CHARS - 1)}…`;
}

function readNestedString(
  value: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function readNestedNumber(
  value: Record<string, unknown> | null | undefined,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function summarizeCompletedItem(item: Record<string, unknown>): string | null {
  const itemType =
    typeof item.type === 'string' ? item.type.toLowerCase() : 'item';
  const command = readNestedString(item, ['command', 'cmd', 'shell_command']);
  if (command) {
    return truncateProgressMessage(`Running: ${command}`);
  }

  const filePath = readNestedString(item, [
    'file_path',
    'path',
    'target_path',
    'relative_path',
  ]);
  if (filePath && (itemType.includes('edit') || itemType.includes('patch'))) {
    return truncateProgressMessage(`Editing: ${filePath}`);
  }

  const message = readNestedString(item, [
    'message',
    'summary',
    'description',
    'title',
  ]);
  if (message) {
    return truncateProgressMessage(message);
  }

  return null;
}

function extractProgressUpdate(event: CodexJsonEvent): string | null {
  switch (event.type) {
    case 'turn.started':
      return 'Codex is working…';
    case 'error': {
      const message =
        typeof event.message === 'string' ? event.message.trim() : '';
      return message ? truncateProgressMessage(message) : null;
    }
    case 'item.completed': {
      const item =
        event.item &&
        typeof event.item === 'object' &&
        !Array.isArray(event.item)
          ? (event.item as Record<string, unknown>)
          : null;
      return item ? summarizeCompletedItem(item) : null;
    }
    default:
      return null;
  }
}

function extractUsage(event: CodexJsonEvent): ExecuteCodexTurnOutput['usage'] {
  const usageSource =
    event.usage &&
    typeof event.usage === 'object' &&
    !Array.isArray(event.usage)
      ? (event.usage as Record<string, unknown>)
      : null;
  const eventInput =
    readNestedNumber(usageSource, ['input_tokens', 'inputTokens']) ??
    readNestedNumber(event, ['input_tokens', 'inputTokens']);
  const eventCachedInput =
    readNestedNumber(usageSource, [
      'cached_input_tokens',
      'cachedInputTokens',
    ]) ?? readNestedNumber(event, ['cached_input_tokens', 'cachedInputTokens']);
  const eventOutput =
    readNestedNumber(usageSource, ['output_tokens', 'outputTokens']) ??
    readNestedNumber(event, ['output_tokens', 'outputTokens']);

  if (
    eventInput === undefined &&
    eventCachedInput === undefined &&
    eventOutput === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens: eventInput,
    cachedInputTokens: eventCachedInput,
    outputTokens: eventOutput,
  };
}

function readFileIfExists(targetPath: string): string | null {
  try {
    if (!fs.existsSync(targetPath)) {
      return null;
    }
    return fs.readFileSync(targetPath, 'utf-8');
  } catch {
    return null;
  }
}

function buildCodexExecPrompt(input: { historyIncluded: boolean }): string {
  return [
    `Read \`${RUN_CONTEXT_FILE_NAME}\` first.`,
    `Then read \`${REQUEST_FILE_NAME}\` for the current request.`,
    input.historyIncluded
      ? `Use \`${HISTORY_FILE_NAME}\` for recent conversation context.`
      : null,
    `Use files under \`${SOURCES_DIR_NAME}/\` and \`${ATTACHMENTS_DIR_NAME}/\` when referenced in the context.`,
    'If a persistent project directory was added to the workspace, place lasting code edits there because this scratch workspace will be deleted after the run.',
    'Write the final assistant response normally.',
  ]
    .filter(Boolean)
    .join(' ');
}

function getCodexMcpAdapterPath(): string {
  return fileURLToPath(new URL('./codex-mcp-adapter.js', import.meta.url));
}

async function configureCodexMcpServer(
  environment: CodexRunEnvironment,
  input: ExecuteCodexTurnInput,
): Promise<void> {
  if (!input.enableWebTools && !input.enableBrowserTools) {
    return;
  }

  await registerCodexMcpServer({
    runHomePath: environment.runHomePath,
    name: 'clawrocket-runtime',
    command: process.execPath,
    args: [getCodexMcpAdapterPath()],
    env: {
      CLAWROCKET_CODEX_RUN_ID: input.runId,
      CLAWROCKET_CODEX_USER_ID: input.userId,
      ...(input.talkId ? { CLAWROCKET_CODEX_TALK_ID: input.talkId } : {}),
      CLAWROCKET_CODEX_ALLOW_WEB: input.enableWebTools ? '1' : '0',
      CLAWROCKET_CODEX_ALLOW_BROWSER: input.enableBrowserTools ? '1' : '0',
    },
  });
}

function createScratchWorkspace(
  input: ExecuteCodexTurnInput,
  environment: CodexRunEnvironment,
): void {
  const sourceFiles = input.talkId
    ? materializeTalkSourceFiles(environment.scratchDirPath, input.talkId)
    : [];
  const attachmentFiles = input.talkId
    ? materializeTalkAttachmentFiles(
        environment.scratchDirPath,
        input.talkId,
        listScopedAttachmentIds({
          triggerMessageId: input.triggerMessageId,
          historyMessageIds: input.historyMessageIds,
        }),
      )
    : [];
  const runContextSeed = buildRunContextMarkdown({
    promptLabel: input.promptLabel,
    systemPrompt: input.context.systemPrompt,
    sourceFiles,
    attachmentFiles,
    historyIncluded: input.promptLabel === 'talk',
    projectMountHostPath: input.projectMountHostPath ?? null,
  });
  const runContextTokens = estimateTokens(runContextSeed);
  const historyBudgetTokens = Math.max(
    0,
    input.modelContextWindow -
      OUTPUT_RESERVE -
      MCP_TOOL_RESERVE -
      runContextTokens,
  );
  const boundedHistory = shrinkHistoryToBudget(
    input.context.history,
    historyBudgetTokens,
  );

  writeFile(
    path.join(environment.scratchDirPath, RUN_CONTEXT_FILE_NAME),
    runContextSeed,
  );
  writeFile(
    path.join(environment.scratchDirPath, REQUEST_FILE_NAME),
    input.userMessage,
  );
  if (input.promptLabel === 'talk') {
    writeFile(
      path.join(environment.scratchDirPath, HISTORY_FILE_NAME),
      renderHistoryMarkdown(boundedHistory),
    );
  }
}

function resetTimer(
  timer: NodeJS.Timeout | null,
  callback: () => void,
  timeoutMs: number,
): NodeJS.Timeout {
  if (timer) {
    clearTimeout(timer);
  }
  return setTimeout(callback, timeoutMs);
}

export async function executeCodexAgentTurn(
  input: ExecuteCodexTurnInput,
): Promise<ExecuteCodexTurnOutput> {
  const environment = await createCodexRunEnvironment(input.runId);
  createScratchWorkspace(input, environment);
  await configureCodexMcpServer(environment, input);

  const args = [
    '-a',
    'never',
    '-s',
    'workspace-write',
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '-C',
    environment.scratchDirPath,
    '-o',
    environment.finalMessagePath,
  ];
  if (input.projectMountHostPath) {
    args.push('--add-dir', input.projectMountHostPath);
  }
  if (shouldPassCodexModel(input.agent.model_id)) {
    args.push('-m', input.agent.model_id);
  }
  args.push(
    buildCodexExecPrompt({
      historyIncluded: input.promptLabel === 'talk',
    }),
  );

  let activeProcess: ChildProcess | null = null;
  let startupTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let usage: ExecuteCodexTurnOutput['usage'];
  const stderrLines: string[] = [];
  const killProcess = (reason: string) => {
    if (!activeProcess || activeProcess.killed) return;
    activeProcess.kill('SIGKILL');
    stderrLines.push(reason);
  };

  const onAbort = () => {
    killProcess('Codex execution aborted.');
  };
  input.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const result = await new Promise<ExecuteCodexTurnOutput>(
      (resolve, reject) => {
        const child = spawn('codex', args, {
          env: {
            ...process.env,
            CODEX_HOME: environment.runHomePath,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        activeProcess = child;
        let sawActivity = false;
        startupTimer = resetTimer(
          startupTimer,
          () => {
            killProcess('Codex startup timed out.');
          },
          CODEX_STARTUP_TIMEOUT_MS,
        );
        const recordActivity = () => {
          if (!sawActivity) {
            sawActivity = true;
            if (startupTimer) {
              clearTimeout(startupTimer);
              startupTimer = null;
            }
          }
          idleTimer = resetTimer(
            idleTimer,
            () => {
              killProcess('Codex execution stalled waiting for activity.');
            },
            CODEX_IDLE_TIMEOUT_MS,
          );
        };

        const stdoutRl = readline.createInterface({
          input: child.stdout!,
          crlfDelay: Infinity,
        });
        stdoutRl.on('line', (line) => {
          recordActivity();
          let parsed: CodexJsonEvent | null = null;
          try {
            parsed = JSON.parse(line) as CodexJsonEvent;
          } catch {
            return;
          }

          if (parsed.type === 'turn.completed') {
            usage = extractUsage(parsed);
          }

          const progressMessage = extractProgressUpdate(parsed);
          if (progressMessage) {
            input.onProgressUpdate?.(progressMessage);
          }
        });

        child.stderr?.on('data', (chunk: Buffer | string) => {
          recordActivity();
          const text = String(chunk);
          const lines = text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          stderrLines.push(...lines);
        });

        child.on('error', (error) => {
          reject(error);
        });

        child.on('close', (code, signalName) => {
          if (startupTimer) clearTimeout(startupTimer);
          if (idleTimer) clearTimeout(idleTimer);
          const pausedRun = getTalkRunById(input.runId);
          const browserBlock =
            pausedRun?.status === 'awaiting_confirmation'
              ? getBrowserBlockForRun(input.runId)
              : null;
          if (browserBlock) {
            reject(new BrowserRunPausedError(input.runId, browserBlock));
            return;
          }

          const finalContent = readFileIfExists(
            environment.finalMessagePath,
          )?.trim();
          if (code === 0 && finalContent) {
            resolve({
              content: finalContent,
              usage,
            });
            return;
          }

          const stderrSummary = stderrLines.slice(-6).join('\n').trim();
          reject(
            new Error(
              code !== 0 || signalName
                ? `Codex execution failed (${signalName || code}): ${stderrSummary || 'no diagnostics available'}`
                : 'Codex execution completed without a final response.',
            ),
          );
        });
      },
    );

    return result;
  } catch (error) {
    logger.error(
      {
        err: error,
        runId: input.runId,
        talkId: input.talkId,
        threadId: input.threadId,
        agentId: input.agent.id,
      },
      'Codex-backed Talk/Main turn failed',
    );
    throw error;
  } finally {
    if (startupTimer) clearTimeout(startupTimer);
    if (idleTimer) clearTimeout(idleTimer);
    input.signal.removeEventListener('abort', onAbort);
    await cleanupCodexRunEnvironment(environment);
  }
}
