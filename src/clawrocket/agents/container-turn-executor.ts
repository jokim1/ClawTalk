import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { getDb } from '../../db.js';
import { logger } from '../../logger.js';
import { createWebRuntimeExecutionTarget } from '../../container-execution-target.js';
import {
  PersistentContainerAgentWorkerError,
  runContainerAgent,
  type ContainerWebTalkConnectorBundle,
} from '../../container-runner.js';
import {
  buildConnectorToolDefinitions,
  type ConnectorToolDefinition,
} from '../connectors/runtime.js';
import { decryptConnectorSecret } from '../connectors/connector-secret-store.js';
import {
  listConnectorsForTalkRun,
  type TalkRunConnectorRecord,
} from '../db/connector-accessors.js';
import {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
} from '../config.js';
import type { RegisteredAgentRecord } from '../db/agent-accessors.js';
import { executeTalkOutputTool } from '../talks/output-tools.js';
import type { TalkJobExecutionPolicy } from '../talks/executor.js';
import type { ContainerCredentialConfig } from './execution-planner.js';
import type { ExecutionContext } from './agent-router.js';
import type { LlmMessage } from './llm-client.js';
import {
  ensureBrowserBridgeServer,
  registerBrowserBridgeRunAbort,
  unregisterBrowserBridgeRunAbort,
} from '../browser/bridge.js';
import { BrowserRunPausedError } from '../browser/run-paused-error.js';
import { getBrowserBlockForRun, getTalkRunById } from '../db/index.js';

export type ContainerBrowserTimeoutProfile = 'default' | 'fast_lane';

export interface ExecuteContainerTurnInput {
  runId: string;
  userId: string;
  agent: RegisteredAgentRecord;
  promptLabel: 'talk' | 'main';
  userMessage: string;
  signal: AbortSignal;
  allowedTools: string[];
  context: Pick<ExecutionContext, 'systemPrompt' | 'history'>;
  modelContextWindow: number;
  containerCredential: ContainerCredentialConfig;
  talkId?: string;
  threadId: string;
  triggerMessageId?: string | null;
  historyMessageIds?: string[];
  projectMountHostPath?: string | null;
  jobPolicy?: TalkJobExecutionPolicy | null;
  enableBrowserTools?: boolean;
  timeoutProfile?: ContainerBrowserTimeoutProfile;
}

export interface ExecuteContainerTurnOutput {
  content: string;
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

interface WebTalkOutputBridgeRequest {
  id: string;
  toolName: 'list_outputs' | 'read_output' | 'write_output';
  args: Record<string, unknown>;
}

type WebTalkOutputToolName = WebTalkOutputBridgeRequest['toolName'];

interface WebTalkOutputBridgeResponse {
  id: string;
  result: string;
  isError?: boolean;
}

const OUTPUT_RESERVE = 4096;
const TOOL_SCHEMA_RESERVE = 2000;
const CHARS_TO_TOKENS = 0.25;
const SMALL_SOURCE_THRESHOLD = 250;
const WEB_TALK_OUTPUT_BRIDGE_DIRNAME = '.nanoclaw-web-talk-output-bridge';
const WEB_TALK_OUTPUT_BRIDGE_POLL_MS = 50;
const REUSABLE_CONTEXT_DIR_CLEANUP_ENTRIES = [
  'CLAUDE.md',
  'HISTORY.md',
  'sources',
  'attachments',
  WEB_TALK_OUTPUT_BRIDGE_DIRNAME,
];

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasNonEmptyText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
    const relativePath = path.join('sources', `${safeRef}.md`);
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
      'attachments',
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

function ensureOutputBridgeDirectories(baseDir: string): string {
  const bridgeDir = path.join(baseDir, WEB_TALK_OUTPUT_BRIDGE_DIRNAME);
  fs.mkdirSync(path.join(bridgeDir, 'requests'), { recursive: true });
  fs.mkdirSync(path.join(bridgeDir, 'responses'), { recursive: true });
  return bridgeDir;
}

function writeOutputBridgeResponse(
  bridgeDir: string,
  response: WebTalkOutputBridgeResponse,
): void {
  const responsePath = path.join(bridgeDir, 'responses', `${response.id}.json`);
  const tempPath = `${responsePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(response));
  fs.renameSync(tempPath, responsePath);
}

async function handleOutputBridgeRequest(input: {
  talkId: string;
  userId: string;
  runId: string;
  request: WebTalkOutputBridgeRequest;
  jobPolicy?: TalkJobExecutionPolicy | null;
}): Promise<WebTalkOutputBridgeResponse> {
  const result = await executeTalkOutputTool({
    talkId: input.talkId,
    userId: input.userId,
    runId: input.runId,
    toolName: input.request.toolName,
    args: input.request.args,
    policy: input.jobPolicy,
  });
  return {
    id: input.request.id,
    result: result.result,
    ...(result.isError ? { isError: true } : {}),
  };
}

function startOutputBridge(input: {
  bridgeDir: string;
  talkId: string;
  userId: string;
  runId: string;
  jobPolicy?: TalkJobExecutionPolicy | null;
}): {
  stop: () => void;
  done: Promise<void>;
} {
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      const requestDir = path.join(input.bridgeDir, 'requests');
      const files = fs.existsSync(requestDir)
        ? fs.readdirSync(requestDir).filter((file) => file.endsWith('.json'))
        : [];

      for (const file of files) {
        if (stopped) break;
        const requestPath = path.join(requestDir, file);
        const processingPath = `${requestPath}.processing`;
        try {
          fs.renameSync(requestPath, processingPath);
        } catch {
          continue;
        }

        try {
          const raw = fs.readFileSync(processingPath, 'utf-8');
          const request = JSON.parse(raw) as WebTalkOutputBridgeRequest;
          const response = await handleOutputBridgeRequest({
            talkId: input.talkId,
            userId: input.userId,
            runId: input.runId,
            request,
            jobPolicy: input.jobPolicy,
          });
          writeOutputBridgeResponse(input.bridgeDir, response);
        } catch (error) {
          const requestId = path.basename(file, '.json');
          writeOutputBridgeResponse(input.bridgeDir, {
            id: requestId,
            result: error instanceof Error ? error.message : String(error),
            isError: true,
          });
        } finally {
          fs.rmSync(processingPath, { force: true });
        }
      }

      if (!stopped) {
        await sleep(WEB_TALK_OUTPUT_BRIDGE_POLL_MS);
      }
    }
  })();

  return {
    stop: () => {
      stopped = true;
    },
    done,
  };
}

function buildClaudeMd(input: {
  promptLabel: 'talk' | 'main';
  systemPrompt: string;
  sourceFiles: MaterializedSourceFile[];
  attachmentFiles: MaterializedAttachmentFile[];
  hasProjectMount: boolean;
}): string {
  const sections: string[] = ['# ClawRocket Run Context'];

  if (input.systemPrompt.trim()) {
    sections.push(input.systemPrompt.trim());
  }

  sections.push(
    [
      input.promptLabel === 'talk'
        ? 'Use `HISTORY.md` for bounded transcript history from the current Talk thread.'
        : 'For Main runs, thread memory is already included inline in the prompt payload.',
      input.hasProjectMount
        ? 'A read-only project is mounted at `/workspace/project`.'
        : 'No project mount is configured for this run.',
      'This run-local `CLAUDE.md` is turn-specific context. If you later navigate into `/workspace/project`, any repo-local `CLAUDE.md` you find there is additive project guidance.',
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

function buildConnectorBundle(
  talkId: string,
  jobPolicy?: TalkJobExecutionPolicy | null,
): ContainerWebTalkConnectorBundle | undefined {
  const connectors = listConnectorsForTalkRun(talkId)
    .filter(
      (connector) =>
        !jobPolicy || jobPolicy.allowedConnectorIds.includes(connector.id),
    )
    .filter((connector) => connector.verificationStatus === 'verified');
  if (connectors.length === 0) return undefined;

  const toolDefinitions = buildConnectorToolDefinitions(connectors);
  return {
    connectors: connectors.map((connector) => ({
      id: connector.id,
      name: connector.name,
      connectorKind: connector.connectorKind,
      config: connector.config,
      secret: decryptConnectorSecret(connector.ciphertext),
    })),
    toolDefinitions: toolDefinitions.map(
      (definition: ConnectorToolDefinition) => ({
        connectorId: definition.connectorId,
        connectorKind: definition.connectorKind,
        connectorName: definition.connectorName,
        toolName: definition.toolName,
        description: definition.description,
        inputSchema: definition.inputSchema,
      }),
    ),
    googleOAuth:
      GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET
        ? {
            clientId: GOOGLE_OAUTH_CLIENT_ID,
            clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
          }
        : undefined,
  };
}

function getAllowedOutputToolNames(
  jobPolicy?: TalkJobExecutionPolicy | null,
): WebTalkOutputToolName[] {
  if (!jobPolicy || jobPolicy.allowOutputWrite) {
    return ['list_outputs', 'read_output', 'write_output'];
  }
  return ['list_outputs', 'read_output'];
}

function resetReusableContextDirectory(baseDir: string): void {
  fs.mkdirSync(baseDir, { recursive: true });
  for (const entry of REUSABLE_CONTEXT_DIR_CLEANUP_ENTRIES) {
    fs.rmSync(path.join(baseDir, entry), { recursive: true, force: true });
  }
}

export function materializeContainerTurnContext(input: {
  input: ExecuteContainerTurnInput;
  baseDir?: string;
}): {
  path: string;
  connectorBundle?: ContainerWebTalkConnectorBundle;
  outputBridgeDir?: string;
  outputToolNames: WebTalkOutputToolName[];
} {
  const baseDir =
    input.baseDir ||
    fs.mkdtempSync(
      path.join(
        DATA_DIR,
        `${input.input.promptLabel}-container-turn-${input.input.runId}-`,
      ),
    );
  if (input.baseDir) {
    resetReusableContextDirectory(baseDir);
  }

  const sourceFiles = input.input.talkId
    ? materializeTalkSourceFiles(baseDir, input.input.talkId)
    : [];
  const attachmentFiles = input.input.talkId
    ? materializeTalkAttachmentFiles(
        baseDir,
        input.input.talkId,
        listScopedAttachmentIds({
          triggerMessageId: input.input.triggerMessageId,
          historyMessageIds: input.input.historyMessageIds,
        }),
      )
    : [];

  const claudeMdContent = buildClaudeMd({
    promptLabel: input.input.promptLabel,
    systemPrompt: input.input.context.systemPrompt,
    sourceFiles,
    attachmentFiles,
    hasProjectMount: Boolean(input.input.projectMountHostPath),
  });
  const claudeMdTokens = estimateTokens(claudeMdContent);
  const historyBudgetTokens = Math.max(
    0,
    input.input.modelContextWindow -
      OUTPUT_RESERVE -
      TOOL_SCHEMA_RESERVE -
      claudeMdTokens,
  );
  const boundedHistory = shrinkHistoryToBudget(
    input.input.context.history,
    historyBudgetTokens,
  );

  writeFile(path.join(baseDir, 'CLAUDE.md'), claudeMdContent);
  if (input.input.promptLabel === 'talk') {
    writeFile(
      path.join(baseDir, 'HISTORY.md'),
      renderHistoryMarkdown(boundedHistory),
    );
  }
  const outputBridgeDir = input.input.talkId
    ? ensureOutputBridgeDirectories(baseDir)
    : undefined;

  return {
    path: baseDir,
    connectorBundle: input.input.talkId
      ? buildConnectorBundle(input.input.talkId, input.input.jobPolicy)
      : undefined,
    outputBridgeDir,
    outputToolNames: getAllowedOutputToolNames(input.input.jobPolicy),
  };
}

export async function executeContainerAgentTurn(
  input: ExecuteContainerTurnInput,
): Promise<ExecuteContainerTurnOutput> {
  const target = createWebRuntimeExecutionTarget();
  const contextDir = materializeContainerTurnContext({ input });
  const browserBridgeHostSocketPath = input.enableBrowserTools
    ? await ensureBrowserBridgeServer()
    : null;
  const outputBridge =
    input.talkId && contextDir.outputBridgeDir
      ? startOutputBridge({
          bridgeDir: contextDir.outputBridgeDir,
          talkId: input.talkId,
          userId: input.userId,
          runId: input.runId,
          jobPolicy: input.jobPolicy,
        })
      : null;

  let activeProcess: ChildProcess | null = null;
  const onAbort = () => {
    if (!activeProcess) return;
    activeProcess.kill('SIGKILL');
  };
  input.signal.addEventListener('abort', onAbort, { once: true });
  if (input.enableBrowserTools) {
    registerBrowserBridgeRunAbort(input.runId, onAbort);
  }

  try {
    let streamedContent: string | null = null;
    const output = await runContainerAgent(
      target,
      {
        prompt: input.userMessage,
        model: input.agent.model_id,
        toolProfile: 'talk_main',
        allowedTools: input.allowedTools,
        groupFolder: target.folder,
        chatJid: target.jid,
        isMain: true,
        assistantName: input.agent.name,
        enableWebTalkOutputTools:
          Boolean(input.talkId) && contextDir.outputToolNames.length > 0,
        webTalkOutputToolNames: contextDir.outputToolNames,
        webTalkConnectorBundle: contextDir.connectorBundle,
        ephemeralContextDir: contextDir.path,
        projectMountHostPath: input.projectMountHostPath ?? null,
        browserBridgeHostSocketPath,
        browserRunId: input.runId,
        browserUserId: input.userId,
        browserTalkId: input.talkId ?? null,
        timeoutProfile: input.timeoutProfile ?? 'default',
        secrets: input.containerCredential.secrets,
      },
      (proc) => {
        activeProcess = proc;
      },
      async (streamedOutput) => {
        if (
          streamedOutput.status === 'success' &&
          streamedOutput.result &&
          streamedOutput.result.trim()
        ) {
          streamedContent = streamedOutput.result;
        }
      },
    );

    const pausedRun = getTalkRunById(input.runId);
    const browserBlock =
      pausedRun?.status === 'awaiting_confirmation'
        ? getBrowserBlockForRun(input.runId)
        : null;
    if (browserBlock) {
      throw new BrowserRunPausedError(input.runId, browserBlock);
    }

    if (output.status !== 'success') {
      if (hasNonEmptyText(streamedContent)) {
        logger.warn(
          {
            runId: input.runId,
            talkId: input.talkId,
            threadId: input.threadId,
            agentId: input.agent.id,
          },
          'Container process exited after emitting a successful result; using streamed output',
        );
        return {
          content: streamedContent,
        };
      }
      throw new Error(output.error || 'Container execution failed.');
    }
    const finalContent = hasNonEmptyText(output.result)
      ? output.result
      : streamedContent;
    if (!hasNonEmptyText(finalContent)) {
      throw new Error(
        'Container execution completed without a final response.',
      );
    }

    return {
      content: finalContent,
    };
  } catch (error) {
    logger.error(
      {
        err: error,
        runId: input.runId,
        talkId: input.talkId,
        threadId: input.threadId,
        agentId: input.agent.id,
      },
      'Container-backed Talk/Main turn failed',
    );
    throw error;
  } finally {
    input.signal.removeEventListener('abort', onAbort);
    if (input.enableBrowserTools) {
      unregisterBrowserBridgeRunAbort(input.runId);
    }
    outputBridge?.stop();
    await outputBridge?.done;
    fs.rmSync(contextDir.path, { recursive: true, force: true });
  }
}
