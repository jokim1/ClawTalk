import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import type { LlmToolDefinition } from '../agents/llm-client.js';
import type { BrowserBlockedKind } from '../browser/service.js';
import { getBrowserService } from '../browser/service.js';
import type {
  BrowserBlockArtifact,
  BrowserBlockMetadata,
  BrowserPendingToolCall,
} from '../browser/metadata.js';
import { BrowserRunPausedError } from '../browser/run-paused-error.js';
import {
  createMessageAttachment,
  createRunConfirmation,
  createTalkOutput,
  getPausedMainBrowserOwnerForProfile,
  getTalkStateEntry,
  getTalkRunById,
  pauseRunForBrowserBlock,
  updateAttachmentExtraction,
  upsertTalkStateEntry,
} from '../db/index.js';
import { getBrowserProfile } from '../db/browser-accessors.js';
import { saveAttachmentFile } from '../talks/attachment-storage.js';

export const BROWSER_TOOL_NAMES = [
  'browser_open',
  'browser_snapshot',
  'browser_act',
  'browser_wait',
  'browser_screenshot',
  'browser_close',
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

export const BROWSER_TOOL_DEFINITIONS: LlmToolDefinition[] = [
  {
    name: 'browser_open',
    description:
      'Open a browser session for a site using a persistent on-disk browser profile.',
    inputSchema: {
      type: 'object',
      properties: {
        siteKey: {
          type: 'string',
          description: 'Stable site key such as linkedin, delta, or irs.',
        },
        url: {
          type: 'string',
          description: 'URL to open in the browser session.',
        },
        accountLabel: {
          type: 'string',
          description:
            'Optional account label when the same site has multiple browser profiles.',
        },
        headed: {
          type: 'boolean',
          description: 'Open headed instead of headless. Defaults to false.',
        },
        reuseSession: {
          type: 'boolean',
          description:
            'Reuse the existing live session for this profile when available. Defaults to true.',
        },
      },
      required: ['siteKey', 'url'],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Capture a fresh page snapshot and return visible page elements with stable refs for later actions.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Live browser session ID from browser_open.',
        },
        interactiveOnly: {
          type: 'boolean',
          description:
            'Limit results to interactive controls. Defaults to true.',
        },
        maxElements: {
          type: 'number',
          description: 'Maximum number of elements to include.',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_act',
    description:
      'Perform a browser action using a session and, when needed, a target ref from browser_snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Live browser session ID from browser_open.',
        },
        action: {
          type: 'string',
          enum: [
            'navigate',
            'click',
            'dblclick',
            'fill',
            'type',
            'press',
            'select',
            'check',
            'uncheck',
            'hover',
            'scroll',
            'upload',
            'back',
            'forward',
            'reload',
          ],
        },
        target: {
          type: 'string',
          description:
            'Element ref from browser_snapshot. Required for most element actions.',
        },
        value: {
          type: 'string',
          description:
            'Action value such as typed text, key to press, scroll amount, or navigation URL.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute file paths for upload actions.',
        },
        confirm: {
          type: 'boolean',
          description:
            'Set true when the action has already been explicitly approved.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional action timeout in milliseconds.',
        },
      },
      required: ['sessionId', 'action'],
    },
  },
  {
    name: 'browser_wait',
    description:
      'Wait for a browser condition such as URL change, text, element presence, or page load state.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Live browser session ID from browser_open.',
        },
        conditionType: {
          type: 'string',
          enum: ['url', 'text', 'element', 'load'],
        },
        value: {
          type: 'string',
          description:
            'Condition value such as a URL glob, text, ref, or load state.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional timeout in milliseconds.',
        },
      },
      required: ['sessionId', 'conditionType'],
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture a screenshot from the live browser session and optionally save it into the Talk attachment store.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Live browser session ID from browser_open.',
        },
        fullPage: {
          type: 'boolean',
          description: 'Capture the full page. Defaults to false.',
        },
        saveToTalk: {
          type: 'boolean',
          description:
            'When in a Talk run, save the screenshot as a Talk attachment.',
        },
        label: {
          type: 'string',
          description:
            'Optional label used in the saved filename or artifact path.',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_close',
    description:
      'Close a live browser session while preserving the on-disk profile.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Live browser session ID from browser_open.',
        },
        keepProfile: {
          type: 'boolean',
          description:
            'Retained for API stability. Profiles are always preserved in v1.',
        },
      },
      required: ['sessionId'],
    },
  },
];

export interface BrowserToolExecutionContext {
  signal: AbortSignal;
  runId: string;
  userId: string;
  talkId?: string | null;
  onProgress?: ((message: string) => void) | undefined;
  timeoutProfile?: 'default' | 'fast_lane';
  onPageReady?: (() => void) | undefined;
}

const BROWSER_TOOL_PROGRESS_HEARTBEAT_MS = 10_000;
const FAST_LANE_BROWSER_OPEN_TIMEOUT_MS = 8_000;
const FAST_LANE_BROWSER_ACTION_TIMEOUT_MS = 5_000;

function jsonResult(
  result: unknown,
  isError = false,
): {
  result: string;
  isError?: boolean;
} {
  return {
    result: JSON.stringify(result),
    ...(isError ? { isError: true } : {}),
  };
}

function abortReason(signal: AbortSignal): Error {
  const { reason } = signal;
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === 'string' && reason.trim().length > 0) {
    return new Error(reason);
  }
  return new Error('Browser tool execution was aborted.');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

async function runAbortable<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortReason(signal));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    void operation().then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function emitBrowserToolProgress(
  context: BrowserToolExecutionContext,
  message: string,
): void {
  if (!context.onProgress) {
    return;
  }
  try {
    context.onProgress(message);
  } catch {
    // Ignore progress listener failures so tool execution can continue.
  }
}

function getBrowserToolProgressMessage(
  toolName: BrowserToolName,
  args: Record<string, unknown>,
): string | null {
  switch (toolName) {
    case 'browser_open': {
      const siteKey =
        typeof args.siteKey === 'string' && args.siteKey.trim().length > 0
          ? args.siteKey.trim()
          : 'browser';
      return `Opening ${siteKey}…`;
    }
    case 'browser_snapshot':
      return 'Refreshing browser snapshot…';
    case 'browser_act': {
      const action =
        typeof args.action === 'string' && args.action.trim().length > 0
          ? args.action.trim()
          : 'action';
      return `Running browser ${action}…`;
    }
    case 'browser_wait':
      return 'Waiting for browser condition…';
    case 'browser_screenshot':
      return 'Capturing browser screenshot…';
    case 'browser_close':
      return 'Closing browser session…';
  }
}

async function runBrowserToolWithProgress<T>(input: {
  toolName: BrowserToolName;
  args: Record<string, unknown>;
  context: BrowserToolExecutionContext;
  operation: () => Promise<T>;
}): Promise<T> {
  const progressMessage = getBrowserToolProgressMessage(
    input.toolName,
    input.args,
  );
  if (!progressMessage) {
    return runAbortable(input.context.signal, input.operation);
  }

  emitBrowserToolProgress(input.context, progressMessage);
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  if (input.context.onProgress) {
    heartbeatTimer = setInterval(() => {
      emitBrowserToolProgress(input.context, progressMessage);
    }, BROWSER_TOOL_PROGRESS_HEARTBEAT_MS);
  }

  try {
    return await runAbortable(input.context.signal, input.operation);
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
  }
}

function browserSetupCommand(input: {
  siteKey: string;
  accountLabel?: string | null;
}): string {
  // Check profile connection mode to emit appropriate instructions
  const profile = getBrowserProfile(input.siteKey, input.accountLabel);
  const mode = profile?.connectionMode ?? 'managed';

  if (mode === 'chrome_profile') {
    return 'Close Chrome completely, then retry — this reuses Chrome profile data and cookies, but it does not attach to your already-open trusted Chrome window. For live-session reuse, configure a CDP browser connection instead.';
  }
  if (mode === 'cdp') {
    const endpointUrl =
      profile?.connectionConfig.mode === 'cdp'
        ? profile.connectionConfig.endpointUrl
        : 'http://localhost:9222';
    return `Make sure Chrome is running with --remote-debugging-port (endpoint: ${endpointUrl}), then retry.`;
  }

  const quote = (value: string): string =>
    `'${value.replace(/'/g, `'\"'\"'`)}'`;
  const accountPart = input.accountLabel
    ? ` --account ${quote(input.accountLabel)}`
    : '';
  return `npx tsx src/clawrocket/browser/setup.ts --site ${quote(input.siteKey)}${accountPart}`;
}

function isBrowserToolName(toolName: string): toolName is BrowserToolName {
  return (BROWSER_TOOL_NAMES as readonly string[]).includes(toolName);
}

async function saveTalkScreenshot(input: {
  talkId: string;
  userId: string;
  content: Buffer;
  fileName: string;
}): Promise<{ attachmentId: string }> {
  const attachmentId = `att_${randomUUID()}`;
  const storageKey = await saveAttachmentFile(
    attachmentId,
    input.talkId,
    input.content,
    input.fileName,
  );
  createMessageAttachment({
    id: attachmentId,
    talkId: input.talkId,
    fileName: input.fileName,
    fileSize: input.content.length,
    mimeType: 'image/png',
    storageKey,
    createdBy: input.userId,
  });
  updateAttachmentExtraction({
    attachmentId,
    extractedText: null,
    extractionStatus: 'ready',
  });
  return { attachmentId };
}

function upsertBrowserState(input: {
  talkId: string;
  userId: string;
  runId: string;
  key: string;
  value: unknown;
}): void {
  const current = getTalkStateEntry(input.talkId, input.key);
  const result = upsertTalkStateEntry({
    talkId: input.talkId,
    key: input.key,
    value: input.value,
    expectedVersion: current?.version ?? 0,
    updatedByUserId: input.userId,
    updatedByRunId: input.runId,
  });
  if (!result.ok) {
    throw new Error(`Failed to update Talk state for key ${input.key}`);
  }
}

function recordTalkPending(input: {
  talkId: string;
  userId: string;
  runId: string;
  status: 'needs_auth' | 'awaiting_confirmation' | 'human_step_required';
  siteKey: string;
  accountLabel: string | null;
  url: string;
  actionSummary: string;
  message: string;
  attachmentId?: string | null;
  setupCommand?: string;
  riskReason?: string;
}): void {
  upsertBrowserState({
    talkId: input.talkId,
    userId: input.userId,
    runId: input.runId,
    key: 'browser.pending',
    value: {
      reason:
        input.status === 'needs_auth'
          ? 'auth_required'
          : input.status === 'human_step_required'
            ? 'human_step_required'
            : 'confirmation_required',
      siteKey: input.siteKey,
      accountLabel: input.accountLabel,
      url: input.url,
      actionSummary: input.actionSummary,
      attachmentId: input.attachmentId ?? null,
      setupCommand: input.setupCommand ?? null,
      riskReason: input.riskReason ?? null,
      message: input.message,
      updatedAt: new Date().toISOString(),
    },
  });

  createTalkOutput({
    talkId: input.talkId,
    title:
      input.status === 'needs_auth'
        ? `Browser auth required: ${input.siteKey}`
        : input.status === 'human_step_required'
          ? `Browser human step required: ${input.siteKey}`
          : `Browser confirmation required: ${input.siteKey}`,
    contentMarkdown: [
      `Status: ${input.status}`,
      `Site: ${input.siteKey}`,
      `URL: ${input.url}`,
      `Action: ${input.actionSummary}`,
      `Message: ${input.message}`,
      input.riskReason ? `Risk reason: ${input.riskReason}` : null,
      input.setupCommand ? `Setup: \`${input.setupCommand}\`` : null,
      input.attachmentId ? `Attachment: ${input.attachmentId}` : null,
    ]
      .filter(Boolean)
      .join('\n\n'),
    createdByUserId: input.userId,
    updatedByRunId: input.runId,
  });
}

function updateBrowserLastState(input: {
  talkId?: string | null;
  userId: string;
  runId: string;
  siteKey?: string;
  accountLabel?: string | null;
  url?: string;
  title?: string;
  status: string;
}): void {
  if (!input.talkId) return;
  upsertBrowserState({
    talkId: input.talkId,
    userId: input.userId,
    runId: input.runId,
    key: 'browser.last',
    value: {
      siteKey: input.siteKey ?? null,
      accountLabel: input.accountLabel ?? null,
      url: input.url ?? null,
      title: input.title ?? null,
      status: input.status,
      updatedAt: new Date().toISOString(),
    },
  });
}

function updateBrowserProfileState(input: {
  talkId?: string | null;
  userId: string;
  runId: string;
  siteKey: string;
  accountLabel?: string | null;
}): void {
  if (!input.talkId) return;
  upsertBrowserState({
    talkId: input.talkId,
    userId: input.userId,
    runId: input.runId,
    key: 'browser.profile',
    value: {
      siteKey: input.siteKey,
      accountLabel: input.accountLabel ?? null,
      updatedAt: new Date().toISOString(),
    },
  });
}

function browserActionSummary(args: {
  action?: unknown;
  target?: unknown;
  value?: unknown;
}): string {
  const action = typeof args.action === 'string' ? args.action : 'unknown';
  const target = typeof args.target === 'string' ? args.target : null;
  const value =
    typeof args.value === 'string' && args.value.length > 0
      ? args.value.slice(0, 120)
      : null;
  return [
    action,
    target ? `target=${target}` : null,
    value ? `value=${value}` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

function buildPendingToolCall(input: {
  toolName: BrowserToolName;
  args: Record<string, unknown>;
}): BrowserPendingToolCall {
  return {
    toolName: input.toolName,
    args: { ...input.args },
  };
}

async function captureBlockedArtifact(input: {
  sessionId: string | null;
  runId: string;
  talkId?: string | null;
  userId: string;
  signal: AbortSignal;
  service: ReturnType<typeof getBrowserService>;
  label: string;
}): Promise<BrowserBlockArtifact[]> {
  if (!input.sessionId) {
    return [];
  }

  const screenshot = await runAbortable(input.signal, () =>
    input.service.screenshot({
      sessionId: input.sessionId!,
      label: input.label,
    }),
  );

  if (input.talkId) {
    const attachment = await saveTalkScreenshot({
      talkId: input.talkId,
      userId: input.userId,
      content: screenshot.content,
      fileName: `${input.label}.png`,
    });
    return [
      {
        attachmentId: attachment.attachmentId,
        fileName: `${input.label}.png`,
        contentType: screenshot.contentType,
        label: input.label,
      },
    ];
  }

  const dir = path.join(DATA_DIR, 'browser-artifacts', 'runs', input.runId);
  fs.mkdirSync(dir, { recursive: true });
  const targetPath = path.join(dir, path.basename(screenshot.path));
  fs.copyFileSync(screenshot.path, targetPath);
  return [
    {
      path: targetPath,
      fileName: path.basename(targetPath),
      contentType: screenshot.contentType,
      label: input.label,
    },
  ];
}

async function throwBrowserRunPaused(input: {
  toolName: BrowserToolName;
  args: Record<string, unknown>;
  context: BrowserToolExecutionContext;
  service: ReturnType<typeof getBrowserService>;
  result: {
    status:
      | 'needs_auth'
      | 'awaiting_confirmation'
      | 'human_step_required'
      | 'ok'
      | 'error';
    siteKey: string;
    accountLabel: string | null;
    url: string;
    title: string;
    message: string;
    riskReason?: string;
    sessionId?: string;
    reusedSession?: boolean;
  };
}): Promise<never> {
  const now = new Date().toISOString();
  const pendingToolCall = buildPendingToolCall({
    toolName: input.toolName,
    args: input.args,
  });
  const artifacts = await captureBlockedArtifact({
    sessionId:
      input.result.sessionId ||
      (typeof input.args.sessionId === 'string' ? input.args.sessionId : null),
    runId: input.context.runId,
    talkId: input.context.talkId,
    userId: input.context.userId,
    signal: input.context.signal,
    service: input.service,
    label: 'browser-blocked',
  });

  let confirmationId: string | null = null;
  if (input.result.status === 'awaiting_confirmation') {
    confirmationId = createRunConfirmation({
      runId: input.context.runId,
      talkId: input.context.talkId ?? null,
      toolId: input.toolName,
      actionSummary: browserActionSummary(input.args),
      metadata: {
        siteKey: input.result.siteKey,
        accountLabel: input.result.accountLabel,
        url: input.result.url,
        sessionId:
          input.result.sessionId ||
          (typeof input.args.sessionId === 'string'
            ? input.args.sessionId
            : null),
        pendingToolCall,
      },
    });
  }

  const kind: BrowserBlockedKind =
    input.result.status === 'needs_auth'
      ? 'auth_required'
      : input.result.status === 'human_step_required'
        ? 'human_step_required'
        : 'confirmation_required';

  const browserBlock: BrowserBlockMetadata = {
    kind,
    sessionId:
      input.result.sessionId ||
      (typeof input.args.sessionId === 'string' ? input.args.sessionId : null),
    siteKey: input.result.siteKey,
    accountLabel: input.result.accountLabel,
    url: input.result.url,
    title: input.result.title,
    message: input.result.message,
    riskReason: input.result.riskReason ?? null,
    setupCommand:
      input.result.status === 'needs_auth' ||
      input.result.status === 'human_step_required'
        ? input.result.reusedSession
          ? null
          : browserSetupCommand({
              siteKey: input.result.siteKey,
              accountLabel: input.result.accountLabel,
            })
        : null,
    artifacts,
    confirmationId,
    pendingToolCall,
    createdAt: now,
    updatedAt: now,
  };

  pauseRunForBrowserBlock({
    runId: input.context.runId,
    browserBlock,
  });

  throw new BrowserRunPausedError(input.context.runId, browserBlock);
}

async function throwSessionConflictPausedRun(input: {
  toolName: BrowserToolName;
  args: Record<string, unknown>;
  context: BrowserToolExecutionContext;
  service: ReturnType<typeof getBrowserService>;
  owner: {
    runId: string;
    sessionId: string;
    siteKey: string;
    accountLabel: string | null;
    url: string;
    title: string;
    summary: string | null;
  };
}): Promise<never> {
  const now = new Date().toISOString();
  const pendingToolCall = buildPendingToolCall({
    toolName: input.toolName,
    args: input.args,
  });
  const artifacts = await captureBlockedArtifact({
    sessionId: input.owner.sessionId,
    runId: input.context.runId,
    talkId: input.context.talkId,
    userId: input.context.userId,
    signal: input.context.signal,
    service: input.service,
    label: 'browser-session-conflict',
  });
  const browserBlock: BrowserBlockMetadata = {
    kind: 'session_conflict',
    sessionId: input.owner.sessionId,
    siteKey: input.owner.siteKey,
    accountLabel: input.owner.accountLabel,
    conflictingRunId: input.owner.runId,
    conflictingSessionId: input.owner.sessionId,
    conflictingRunSummary: input.owner.summary,
    url: input.owner.url,
    title: input.owner.title,
    message: `Another paused browser task already owns the ${input.owner.siteKey} session. Resolve that task before this run can continue.`,
    riskReason: 'session_conflict',
    setupCommand: null,
    artifacts,
    confirmationId: null,
    pendingToolCall,
    createdAt: now,
    updatedAt: now,
  };

  pauseRunForBrowserBlock({
    runId: input.context.runId,
    browserBlock,
  });

  throw new BrowserRunPausedError(input.context.runId, browserBlock);
}

export async function executeBrowserTool(input: {
  toolName: string;
  args: Record<string, unknown>;
  context: BrowserToolExecutionContext;
}): Promise<{ result: string; isError?: boolean }> {
  if (!isBrowserToolName(input.toolName)) {
    return {
      result: `Tool '${input.toolName}' is not a browser tool`,
      isError: true,
    };
  }

  const service = getBrowserService();

  try {
    switch (input.toolName) {
      case 'browser_open': {
        const siteKey =
          typeof input.args.siteKey === 'string' ? input.args.siteKey : '';
        const url = typeof input.args.url === 'string' ? input.args.url : '';
        const accountLabel =
          typeof input.args.accountLabel === 'string'
            ? input.args.accountLabel
            : null;
        const headed = input.args.headed === true;
        const reuseSession = input.args.reuseSession !== false;
        if (!siteKey || !url) {
          return jsonResult(
            {
              status: 'error',
              message: 'browser_open requires siteKey and url.',
            },
            true,
          );
        }
        const currentRun = getTalkRunById(input.context.runId);
        if (currentRun && currentRun.talk_id == null && currentRun.thread_id) {
          const owner = getPausedMainBrowserOwnerForProfile({
            threadId: currentRun.thread_id,
            siteKey,
            accountLabel,
            excludeRunId: currentRun.id,
          });
          if (owner) {
            await throwSessionConflictPausedRun({
              toolName: 'browser_open',
              args: input.args,
              context: input.context,
              service,
              owner,
            });
          }
        }
        let pageReadyEmitted = false;
        const markPageReady = (): void => {
          if (pageReadyEmitted) {
            return;
          }
          pageReadyEmitted = true;
          input.context.onPageReady?.();
        };

        const result = await runBrowserToolWithProgress({
          toolName: 'browser_open',
          args: input.args,
          context: input.context,
          operation: () =>
            service.open({
              siteKey,
              url,
              accountLabel,
              userId: input.context.userId,
              runId: input.context.runId,
              headed,
              reuseSession,
              onPageReady: markPageReady,
              navigationTimeoutMs:
                input.context.timeoutProfile === 'fast_lane'
                  ? FAST_LANE_BROWSER_OPEN_TIMEOUT_MS
                  : undefined,
              retryOnInitialTimeout:
                input.context.timeoutProfile === 'fast_lane',
            }),
        });
        markPageReady();
        if (result.sessionId) {
          service.recordRunSessionTouch(
            input.context.runId,
            result.sessionId,
            input.context.userId,
          );
        }

        updateBrowserProfileState({
          talkId: input.context.talkId,
          userId: input.context.userId,
          runId: input.context.runId,
          siteKey: result.siteKey,
          accountLabel: result.accountLabel,
        });
        updateBrowserLastState({
          talkId: input.context.talkId,
          userId: input.context.userId,
          runId: input.context.runId,
          siteKey: result.siteKey,
          accountLabel: result.accountLabel,
          url: result.url,
          title: result.title,
          status: result.status,
        });

        if (
          (result.status === 'needs_auth' ||
            result.status === 'human_step_required') &&
          input.context.talkId
        ) {
          recordTalkPending({
            talkId: input.context.talkId,
            userId: input.context.userId,
            runId: input.context.runId,
            status: result.status,
            siteKey: result.siteKey,
            accountLabel: result.accountLabel,
            url: result.url,
            actionSummary: `Open ${result.url}`,
            message: result.message,
            setupCommand: result.reusedSession
              ? undefined
              : browserSetupCommand({
                  siteKey: result.siteKey,
                  accountLabel: result.accountLabel,
                }),
          });
        }

        if (
          result.status === 'needs_auth' ||
          result.status === 'human_step_required'
        ) {
          await throwBrowserRunPaused({
            toolName: 'browser_open',
            args: input.args,
            context: input.context,
            service,
            result,
          });
        }

        return jsonResult(result, result.status === 'error');
      }

      case 'browser_snapshot': {
        const sessionId =
          typeof input.args.sessionId === 'string' ? input.args.sessionId : '';
        if (!sessionId) {
          return jsonResult(
            {
              status: 'error',
              message: 'browser_snapshot requires sessionId.',
            },
            true,
          );
        }
        const result = await runBrowserToolWithProgress({
          toolName: 'browser_snapshot',
          args: input.args,
          context: input.context,
          operation: () =>
            service.snapshot({
              sessionId,
              interactiveOnly: input.args.interactiveOnly as
                | boolean
                | undefined,
              maxElements:
                typeof input.args.maxElements === 'number'
                  ? input.args.maxElements
                  : undefined,
            }),
        });
        service.recordRunSessionTouch(
          input.context.runId,
          sessionId,
          input.context.userId,
        );
        updateBrowserLastState({
          talkId: input.context.talkId,
          userId: input.context.userId,
          runId: input.context.runId,
          siteKey: result.siteKey,
          accountLabel: result.accountLabel,
          url: result.url,
          title: result.title,
          status: result.status,
        });
        return jsonResult(result);
      }

      case 'browser_act': {
        const sessionId =
          typeof input.args.sessionId === 'string' ? input.args.sessionId : '';
        const action =
          typeof input.args.action === 'string' ? input.args.action : '';
        if (!sessionId || !action) {
          return jsonResult(
            {
              status: 'error',
              message: 'browser_act requires sessionId and action.',
            },
            true,
          );
        }
        const result = await runBrowserToolWithProgress({
          toolName: 'browser_act',
          args: input.args,
          context: input.context,
          operation: () =>
            service.act(
              {
                sessionId,
                action,
                target:
                  typeof input.args.target === 'string'
                    ? input.args.target
                    : undefined,
                value:
                  typeof input.args.value === 'string'
                    ? input.args.value
                    : undefined,
                files: Array.isArray(input.args.files)
                  ? input.args.files.filter(
                      (file): file is string => typeof file === 'string',
                    )
                  : undefined,
                confirm: input.args.confirm === true,
                timeoutMs:
                  typeof input.args.timeoutMs === 'number'
                    ? input.args.timeoutMs
                    : input.context.timeoutProfile === 'fast_lane'
                      ? FAST_LANE_BROWSER_ACTION_TIMEOUT_MS
                      : undefined,
              },
              {
                talkId: input.context.talkId,
                runId: input.context.runId,
              },
            ),
        });
        service.recordRunSessionTouch(
          input.context.runId,
          sessionId,
          input.context.userId,
        );

        updateBrowserLastState({
          talkId: input.context.talkId,
          userId: input.context.userId,
          runId: input.context.runId,
          siteKey: result.siteKey,
          accountLabel: result.accountLabel,
          url: result.url,
          title: result.title,
          status: result.status,
        });

        if (
          (result.status === 'needs_auth' ||
            result.status === 'awaiting_confirmation' ||
            result.status === 'human_step_required') &&
          input.context.talkId
        ) {
          recordTalkPending({
            talkId: input.context.talkId,
            userId: input.context.userId,
            runId: input.context.runId,
            status:
              result.status === 'needs_auth'
                ? 'needs_auth'
                : result.status === 'human_step_required'
                  ? 'human_step_required'
                  : 'awaiting_confirmation',
            siteKey: result.siteKey,
            accountLabel: result.accountLabel,
            url: result.url,
            actionSummary: browserActionSummary(input.args),
            message: result.message,
            riskReason: result.riskReason,
            setupCommand:
              result.status === 'needs_auth'
                ? browserSetupCommand({
                    siteKey: result.siteKey,
                    accountLabel: result.accountLabel,
                  })
                : undefined,
          });
        }

        if (
          result.status === 'needs_auth' ||
          result.status === 'awaiting_confirmation' ||
          result.status === 'human_step_required'
        ) {
          await throwBrowserRunPaused({
            toolName: 'browser_act',
            args: input.args,
            context: input.context,
            service,
            result,
          });
        }

        return jsonResult(result);
      }

      case 'browser_wait': {
        const sessionId =
          typeof input.args.sessionId === 'string' ? input.args.sessionId : '';
        const conditionType =
          typeof input.args.conditionType === 'string'
            ? (input.args.conditionType as 'url' | 'text' | 'element' | 'load')
            : null;
        if (!sessionId || !conditionType) {
          return jsonResult(
            {
              status: 'error',
              message: 'browser_wait requires sessionId and conditionType.',
            },
            true,
          );
        }
        const result = await runBrowserToolWithProgress({
          toolName: 'browser_wait',
          args: input.args,
          context: input.context,
          operation: () =>
            service.wait({
              sessionId,
              conditionType,
              value:
                typeof input.args.value === 'string'
                  ? input.args.value
                  : undefined,
              timeoutMs:
                typeof input.args.timeoutMs === 'number'
                  ? input.args.timeoutMs
                  : input.context.timeoutProfile === 'fast_lane'
                    ? FAST_LANE_BROWSER_ACTION_TIMEOUT_MS
                    : undefined,
            }),
        });
        service.recordRunSessionTouch(
          input.context.runId,
          sessionId,
          input.context.userId,
        );
        updateBrowserLastState({
          talkId: input.context.talkId,
          userId: input.context.userId,
          runId: input.context.runId,
          siteKey: result.siteKey,
          accountLabel: result.accountLabel,
          url: result.url,
          title: result.title,
          status: result.status,
        });
        if (
          (result.status === 'needs_auth' ||
            result.status === 'human_step_required') &&
          input.context.talkId
        ) {
          recordTalkPending({
            talkId: input.context.talkId,
            userId: input.context.userId,
            runId: input.context.runId,
            status: result.status,
            siteKey: result.siteKey,
            accountLabel: result.accountLabel,
            url: result.url,
            actionSummary: `Wait ${conditionType}`,
            message: result.message,
            setupCommand: browserSetupCommand({
              siteKey: result.siteKey,
              accountLabel: result.accountLabel,
            }),
          });
        }
        if (
          result.status === 'needs_auth' ||
          result.status === 'human_step_required'
        ) {
          await throwBrowserRunPaused({
            toolName: 'browser_wait',
            args: input.args,
            context: input.context,
            service,
            result,
          });
        }
        return jsonResult(result);
      }

      case 'browser_screenshot': {
        const sessionId =
          typeof input.args.sessionId === 'string' ? input.args.sessionId : '';
        if (!sessionId) {
          return jsonResult(
            {
              status: 'error',
              message: 'browser_screenshot requires sessionId.',
            },
            true,
          );
        }
        const result = await runBrowserToolWithProgress({
          toolName: 'browser_screenshot',
          args: input.args,
          context: input.context,
          operation: () =>
            service.screenshot({
              sessionId,
              fullPage: input.args.fullPage === true,
              label:
                typeof input.args.label === 'string'
                  ? input.args.label
                  : undefined,
            }),
        });
        service.recordRunSessionTouch(
          input.context.runId,
          sessionId,
          input.context.userId,
        );
        updateBrowserLastState({
          talkId: input.context.talkId,
          userId: input.context.userId,
          runId: input.context.runId,
          siteKey: result.siteKey,
          accountLabel: result.accountLabel,
          url: result.url,
          title: result.title,
          status: result.status,
        });

        if (input.args.saveToTalk === true) {
          if (!input.context.talkId) {
            return jsonResult(
              {
                status: 'error',
                message:
                  'browser_screenshot(saveToTalk=true) requires a Talk run context.',
              },
              true,
            );
          }

          const label =
            typeof input.args.label === 'string' && input.args.label.trim()
              ? input.args.label.trim()
              : 'browser-screenshot';
          const attachment = await saveTalkScreenshot({
            talkId: input.context.talkId,
            userId: input.context.userId,
            content: result.content,
            fileName: `${label}.png`,
          });
          return jsonResult({
            status: result.status,
            siteKey: result.siteKey,
            accountLabel: result.accountLabel,
            url: result.url,
            title: result.title,
            artifact: {
              attachmentId: attachment.attachmentId,
              fileName: `${label}.png`,
              contentType: result.contentType,
            },
          });
        }

        return jsonResult({
          status: result.status,
          siteKey: result.siteKey,
          accountLabel: result.accountLabel,
          url: result.url,
          title: result.title,
          artifact: {
            path: result.path,
            fileName: path.basename(result.path),
            contentType: result.contentType,
          },
        });
      }

      case 'browser_close': {
        const sessionId =
          typeof input.args.sessionId === 'string' ? input.args.sessionId : '';
        if (!sessionId) {
          return jsonResult(
            {
              status: 'error',
              message: 'browser_close requires sessionId.',
            },
            true,
          );
        }
        const result = await runBrowserToolWithProgress({
          toolName: 'browser_close',
          args: input.args,
          context: input.context,
          operation: () =>
            service.close({
              sessionId,
              userId: input.context.userId,
              keepProfile: input.args.keepProfile !== false,
            }),
        });
        service.recordRunSessionTouch(
          input.context.runId,
          sessionId,
          input.context.userId,
        );
        return jsonResult(result);
      }
    }
  } catch (error) {
    if (error instanceof BrowserRunPausedError) {
      throw error;
    }
    return jsonResult(
      {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      },
      true,
    );
  }
}
