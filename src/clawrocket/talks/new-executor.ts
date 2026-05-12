/**
 * CleanTalkExecutor orchestrates a single Talk run execution.
 *
 * Responsibilities:
 * 1. Resolve the target agent
 * 2. Load Talk context for that agent
 * 3. Inject ordered-round prior outputs into the step-local user message
 * 4. Execute via agent-router
 * 5. Stream TalkExecutionEvents
 *
 * Persistence is intentionally handled by the worker / DB atomic helpers.
 */

import { getDb } from '../../db.js';
import { logger } from '../../logger.js';
import {
  getRegisteredAgent,
  type EffectiveToolAccess,
  type RegisteredAgentRecord,
} from '../db/agent-accessors.js';
import {
  getTalkById,
  getTalkMessageById,
  getTalkRunById,
} from '../db/accessors.js';
import { getTalkChannelBindingById } from '../db/channel-accessors.js';
import { getTalkJobById } from '../db/job-accessors.js';
import {
  listConnectorsForTalkRun,
  type TalkRunConnectorRecord,
} from '../db/connector-accessors.js';
import {
  executeConnectorTool,
  type ToolExecutionContext,
} from '../connectors/tool-executors.js';
import { parseConnectorToolName } from '../connectors/runtime.js';
import {
  deleteTalkStateEntry,
  getTalkStateEntry,
  listTalkStateEntries,
  listTalkStateEntriesByPrefix,
  listMessageAttachmentRecords,
  type MessageAttachmentRecord,
  upsertTalkStateEntry,
  validateStateKey,
} from '../db/context-accessors.js';
import { setTalkRunMetadataJson } from '../db/accessors.js';
import {
  executeWithAgent,
  type ExecutionContext,
  type ExecutionEvent,
} from '../agents/agent-router.js';
import type { LlmContentBlock, LlmMessage } from '../agents/llm-client.js';
import {
  getContainerAllowedTools,
  planExecution,
} from '../agents/execution-planner.js';
import {
  getMainAgent,
  listTalkAgents,
  resolvePrimaryAgent,
} from '../agents/agent-registry.js';
import { resolveValidatedProjectMountPath } from '../agents/project-mounts.js';
import { executeContainerAgentTurn } from '../agents/container-turn-executor.js';
import { executeCodexAgentTurn } from '../agents/codex-turn-executor.js';
import { modelSupportsVision } from '../llm/capabilities.js';
import type { TalkPersonaRole } from '../llm/types.js';
import type { TalkRunStatus } from '../types.js';
import { executeWebFetch, executeWebSearch } from '../tools/web-tools.js';
import { executeBrowserTool } from '../tools/browser-tools.js';
import { buildBrowserResumeSection } from '../browser/run-context.js';
import type { ExecutionDecisionMetadata } from '../browser/metadata.js';
import { fetchSlackRecentConversationContext } from '../channels/slack-connector.js';
import { buildTalkChannelBindingStateNamespace } from '../db/channel-accessors.js';
import { loadTalkContext } from './context-loader.js';
import { executeGoogleDriveTalkTool } from './google-drive-tools.js';
import { executeTalkOutputTool } from './output-tools.js';
import { isImageAttachmentMimeType } from './attachment-extraction.js';
import { loadAttachmentFile } from './attachment-storage.js';
import {
  TalkExecutorError,
  type TalkJobExecutionPolicy,
  type TalkExecutionEvent,
  type TalkExecutor,
  type TalkExecutorInput,
  type TalkExecutorOutput,
} from './executor.js';

type ResolvedTalkAgentExecution = {
  agent: RegisteredAgentRecord;
  nickname: string;
};

function mapExecutionEvent(
  event: ExecutionEvent,
  input: TalkExecutorInput,
  resolved: ResolvedTalkAgentExecution,
): TalkExecutionEvent | null {
  const shared = {
    runId: input.runId,
    talkId: input.talkId,
    threadId: input.threadId,
    agentId: resolved.agent.id,
    agentNickname: resolved.nickname,
    responseGroupId: input.responseGroupId ?? null,
    sequenceIndex: input.sequenceIndex ?? null,
    providerId: resolved.agent.provider_id,
    modelId: resolved.agent.model_id,
  };

  switch (event.type) {
    case 'started':
      return {
        type: 'talk_response_started',
        ...shared,
        providerId: event.providerId,
        modelId: event.modelId,
      };

    case 'text_delta':
      return {
        type: 'talk_response_delta',
        ...shared,
        deltaText: event.text,
      };

    case 'usage':
      return {
        type: 'talk_response_usage',
        ...shared,
        usage: {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          estimatedCostUsd: event.estimatedCostUsd,
        },
      };

    case 'completed':
      return {
        type: 'talk_response_completed',
        ...shared,
        completion: event.completion,
      };

    case 'failed':
      return {
        type: 'talk_response_failed',
        ...shared,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
        completion: event.completion,
      };

    case 'cancelled':
      return {
        type: 'talk_response_cancelled',
        ...shared,
      };

    case 'tool_call':
    case 'tool_result':
    case 'awaiting_confirmation':
      return null;

    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function parseRunMetadata(
  metadataJson: string | null | undefined,
): Record<string, unknown> {
  if (!metadataJson) return {};
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignored
  }
  return {};
}

type ChannelInboundTriggerMetadata = {
  kind: 'channel_inbound';
  bindingId: string;
  platform: 'telegram' | 'slack';
  connectionId: string;
  targetKind: string;
  targetId: string;
  targetDisplayName: string | null;
  senderId: string | null;
  senderName: string | null;
  isMentioned: boolean;
  timestamp: string | null;
  externalMessageId: string | null;
  metadata: Record<string, unknown> | null;
};

function parseChannelInboundTriggerMetadata(
  metadataJson: string | null | undefined,
): ChannelInboundTriggerMetadata | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (record.kind !== 'channel_inbound') {
      return null;
    }
    const platform =
      record.platform === 'slack' || record.platform === 'telegram'
        ? record.platform
        : null;
    if (
      platform === null ||
      typeof record.bindingId !== 'string' ||
      typeof record.connectionId !== 'string' ||
      typeof record.targetKind !== 'string' ||
      typeof record.targetId !== 'string'
    ) {
      return null;
    }
    return {
      kind: 'channel_inbound',
      bindingId: record.bindingId,
      platform,
      connectionId: record.connectionId,
      targetKind: record.targetKind,
      targetId: record.targetId,
      targetDisplayName:
        typeof record.targetDisplayName === 'string'
          ? record.targetDisplayName
          : null,
      senderId: typeof record.senderId === 'string' ? record.senderId : null,
      senderName:
        typeof record.senderName === 'string' ? record.senderName : null,
      isMentioned: record.isMentioned === true,
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
      externalMessageId:
        typeof record.externalMessageId === 'string'
          ? record.externalMessageId
          : null,
      metadata:
        record.metadata &&
        typeof record.metadata === 'object' &&
        !Array.isArray(record.metadata)
          ? (record.metadata as Record<string, unknown>)
          : null,
    };
  } catch {
    return null;
  }
}

function formatChannelResponseModeLabel(
  mode: 'off' | 'mentions' | 'all',
): string {
  switch (mode) {
    case 'off':
      return 'Do not answer unless an administrator changes this binding.';
    case 'mentions':
      return 'Answer when directly mentioned or when the channel context clearly calls for it.';
    case 'all':
      return 'This binding may react to ordinary channel messages, but it can still stay silent when unhelpful.';
  }
}

function formatChannelDeliveryModeLabel(mode: 'reply' | 'channel'): string {
  return mode === 'reply'
    ? 'Post the response as a threaded reply tied to the source message or thread.'
    : 'Post the response back into the main channel timeline.';
}

function buildChannelBindingLabel(input: {
  binding: NonNullable<ReturnType<typeof getTalkChannelBindingById>>;
  trigger: ChannelInboundTriggerMetadata;
}): string {
  const platformLabel =
    input.binding.platform === 'slack' ? 'Slack' : 'Telegram';
  const destination =
    input.trigger.targetDisplayName ||
    input.binding.display_name ||
    input.trigger.targetId;
  return `${platformLabel} · ${input.binding.connection_display_name} · ${destination}`;
}

function buildLocalChannelClockFacts(input?: {
  timeZone?: string | null;
  now?: Date;
}): {
  localTimestamp: string;
  localDate: string;
  localDayOfWeek: string;
  timeZone: string;
} {
  const now = input?.now ?? new Date();
  const timeZone =
    input?.timeZone?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC';
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const localTime = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(now);
  const localDayOfWeek = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
  }).format(now);
  return {
    localTimestamp: `${localDate} ${localTime}`,
    localDate,
    localDayOfWeek,
    timeZone,
  };
}

function buildChannelContextSection(input: {
  binding: ReturnType<typeof getTalkChannelBindingById>;
  trigger: ChannelInboundTriggerMetadata;
  recentSlackLines?: string[];
  recentSlackUnavailableReason?: string | null;
}): string | null {
  const binding = input.binding;
  if (!binding) return null;
  const stateNamespace = buildTalkChannelBindingStateNamespace(binding.id);
  const clock = buildLocalChannelClockFacts({ timeZone: binding.timezone });
  const lines: string[] = [
    `Binding: ${buildChannelBindingLabel({ binding, trigger: input.trigger })}`,
    `Platform: ${input.trigger.platform === 'slack' ? 'Slack' : 'Telegram'}`,
    `Connection: ${binding.connection_display_name}`,
    `Destination: ${input.trigger.targetDisplayName || binding.display_name || input.trigger.targetId}`,
    `Sender: ${input.trigger.senderName || input.trigger.senderId || 'Unknown sender'}`,
    `When to respond: ${formatChannelResponseModeLabel(binding.response_mode)}`,
    `Where to post reply: ${formatChannelDeliveryModeLabel(binding.delivery_mode)}`,
    `State namespace: ${stateNamespace}`,
    `Keep binding-owned state under this prefix. Use list_state with prefix "${stateNamespace}" to inspect binding memory.`,
    `Local timestamp: ${clock.localTimestamp}`,
    `Local date: ${clock.localDate}`,
    `Local day-of-week: ${clock.localDayOfWeek}`,
    `Timezone: ${clock.timeZone}`,
  ];

  if (input.trigger.isMentioned) {
    lines.push(
      'This message directly mentioned the assistant. Reply briefly and do not suppress the outward reply.',
    );
  } else {
    lines.push(
      'If you should stay silent, begin your response with [[NO_CHANNEL_REPLY]]. You may optionally include a short internal rationale after that directive.',
    );
  }

  const instructions = binding.instructions?.trim();
  if (instructions) {
    lines.push(`Binding instructions:\n${instructions}`);
  }

  if (input.recentSlackLines && input.recentSlackLines.length > 0) {
    lines.push(`Recent Slack context:\n${input.recentSlackLines.join('\n')}`);
  } else if (input.recentSlackUnavailableReason) {
    lines.push(
      `Recent Slack context unavailable: ${input.recentSlackUnavailableReason}`,
    );
  }

  return lines.join('\n');
}

function loadChannelTriggerContext(input: { triggerMessageId: string }): {
  trigger: ChannelInboundTriggerMetadata | null;
  binding: ReturnType<typeof getTalkChannelBindingById>;
} {
  const triggerMessage = getTalkMessageById(input.triggerMessageId);
  const trigger = parseChannelInboundTriggerMetadata(
    triggerMessage?.metadata_json,
  );
  if (!trigger) {
    return { trigger: null, binding: undefined };
  }

  return {
    trigger,
    binding: getTalkChannelBindingById(trigger.bindingId),
  };
}

async function loadChannelExecutionContext(input: {
  trigger: ChannelInboundTriggerMetadata | null;
  binding: ReturnType<typeof getTalkChannelBindingById>;
}): Promise<{
  channelContextSection: string | null;
}> {
  const trigger = input.trigger;
  const binding = input.binding;
  if (!trigger || !binding) {
    return { channelContextSection: null };
  }

  let recentSlackLines: string[] = [];
  let recentSlackUnavailableReason: string | null = null;
  if (binding.platform === 'slack') {
    if (binding.connection_health_status === 'disconnected') {
      recentSlackUnavailableReason = 'Slack workspace is disconnected.';
    } else {
      const sourceThreadKey =
        typeof trigger.metadata?.sourceThreadKey === 'string'
          ? trigger.metadata.sourceThreadKey
          : null;
      const recentSlackContext = await fetchSlackRecentConversationContext({
        connectionId: binding.connection_id,
        targetId: trigger.targetId,
        sourceThreadKey,
        externalMessageId: trigger.externalMessageId,
        directMention: trigger.isMentioned,
        maxMessages: 10,
        maxCharsPerMessage: 300,
      });
      recentSlackLines = recentSlackContext.lines;
      recentSlackUnavailableReason = recentSlackContext.unavailableReason;
    }
  }

  return {
    channelContextSection: buildChannelContextSection({
      binding,
      trigger,
      recentSlackLines,
      recentSlackUnavailableReason,
    }),
  };
}

function buildExecutionDecision(
  agent: RegisteredAgentRecord,
  plan: ReturnType<typeof planExecution>,
): ExecutionDecisionMetadata {
  if (plan.backend === 'container') {
    return {
      backend: 'container',
      authPath: plan.containerCredential.authMode,
      credentialSource: plan.containerCredential.credentialSource,
      routeReason: plan.routeReason,
      plannerReason: plan.routeReason,
      providerId: agent.provider_id,
      modelId: agent.model_id,
    };
  }
  if (plan.backend === 'host_codex') {
    return {
      backend: 'host_codex',
      authPath: plan.authPath,
      credentialSource: plan.credentialSource,
      routeReason: plan.routeReason,
      plannerReason: plan.routeReason,
      providerId: agent.provider_id,
      modelId: agent.model_id,
    };
  }
  return {
    backend: 'direct_http',
    authPath: plan.authPath,
    credentialSource: plan.credentialSource,
    routeReason: plan.routeReason,
    plannerReason: plan.routeReason,
    providerId: agent.provider_id,
    modelId: agent.model_id,
  };
}

function talkUsesUnsupportedCodexExecution(talkId: string): {
  supported: boolean;
  message?: string;
} {
  const talk = getTalkById(talkId);
  if (talk?.orchestration_mode === 'panel') {
    return {
      supported: false,
      message:
        'Codex host execution does not support panel Talks. Use a single-agent ordered Talk instead.',
    };
  }

  if (listTalkAgents(talkId).length > 1) {
    return {
      supported: false,
      message: 'Codex host execution only supports single-agent Talks in v1.',
    };
  }

  return { supported: true };
}

function contextUsesUnsupportedCodexTools(context: ExecutionContext): string[] {
  const unsupportedToolNames = new Set<string>();
  for (const tool of context.contextTools) {
    if (
      tool.name === 'list_outputs' ||
      tool.name === 'read_output' ||
      tool.name === 'write_output'
    ) {
      unsupportedToolNames.add(tool.name);
    }
  }
  if (context.connectorTools.length > 0) {
    unsupportedToolNames.add('connectors');
  }
  return Array.from(unsupportedToolNames);
}

/** @internal Exported for integration testing only. */
export function buildToolExecutor(
  talkId: string,
  userId: string,
  runId: string,
  signal: AbortSignal,
  jobPolicy?: TalkJobExecutionPolicy | null,
  effectiveTools?: EffectiveToolAccess[],
) {
  let connectorCache: Map<string, TalkRunConnectorRecord> | null = null;
  const enabledToolFamilies = new Set(
    (effectiveTools ?? [])
      .filter((tool) => tool.enabled)
      .map((tool) => tool.toolFamily),
  );

  function loadConnectors(): Map<string, TalkRunConnectorRecord> {
    if (connectorCache) return connectorCache;
    const connectors = listConnectorsForTalkRun(talkId);
    connectorCache = new Map(
      connectors.map((connector) => [connector.id, connector]),
    );
    return connectorCache;
  }

  return async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ result: string; isError?: boolean }> => {
    if (
      toolName === 'list_outputs' ||
      toolName === 'read_output' ||
      toolName === 'write_output'
    ) {
      return executeTalkOutputTool({
        talkId,
        userId,
        runId,
        toolName,
        args,
        policy: jobPolicy,
      });
    }

    if (toolName === 'read_context_source') {
      const ref = args.sourceRef as string | undefined;
      if (!ref) {
        return { result: 'Error: sourceRef parameter required', isError: true };
      }

      const sourceRow = getDb()
        .prepare(
          `
        SELECT extracted_text
        FROM talk_context_sources
        WHERE talk_id = ? AND (id = ? OR source_ref = ?)
      `,
        )
        .get(talkId, ref, ref) as { extracted_text: string | null } | undefined;

      if (!sourceRow) {
        return { result: `Source ${ref} not found`, isError: true };
      }

      return { result: sourceRow.extracted_text || '' };
    }

    if (toolName === 'read_attachment') {
      const attachmentId = args.attachmentId as string | undefined;
      if (!attachmentId) {
        return {
          result: 'Error: attachmentId parameter required',
          isError: true,
        };
      }

      const attachmentRow = getDb()
        .prepare(
          `
        SELECT extracted_text, mime_type, file_name
        FROM talk_message_attachments
        WHERE id = ? AND talk_id = ?
      `,
        )
        .get(attachmentId, talkId) as
        | {
            extracted_text: string | null;
            mime_type: string;
            file_name: string;
          }
        | undefined;

      if (!attachmentRow) {
        return {
          result: `Attachment ${attachmentId} not found`,
          isError: true,
        };
      }

      if (
        !attachmentRow.extracted_text &&
        isImageAttachmentMimeType(attachmentRow.mime_type)
      ) {
        return {
          result: `[Image attachment "${attachmentRow.file_name}" cannot be read as text. Vision input delivery is not yet implemented in this tool path.]`,
        };
      }

      return { result: attachmentRow.extracted_text || '' };
    }

    if (toolName === 'read_state') {
      const rawKey = args.key as string | undefined;
      if (!rawKey?.trim()) {
        return { result: 'Error: key parameter required', isError: true };
      }
      try {
        const validatedKey = validateStateKey(rawKey);
        const entry = getTalkStateEntry(talkId, validatedKey);
        if (!entry) {
          return {
            result: `State entry "${validatedKey}" does not exist.`,
            isError: true,
          };
        }
        return { result: JSON.stringify(entry) };
      } catch (error) {
        return {
          result: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    }

    if (toolName === 'list_state') {
      const rawPrefix = args.prefix as string | undefined;
      try {
        const entries =
          rawPrefix && rawPrefix.trim()
            ? listTalkStateEntriesByPrefix(talkId, rawPrefix)
            : listTalkStateEntries(talkId);
        return { result: JSON.stringify({ entries }) };
      } catch (error) {
        return {
          result: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    }

    if (toolName === 'update_state') {
      if (jobPolicy && !jobPolicy.allowStateMutation) {
        return {
          result: 'Error: update_state is not available for scheduled job runs',
          isError: true,
        };
      }
      const key = args.key as string | undefined;
      const expectedVersion = args.expectedVersion;

      if (!key?.trim()) {
        return { result: 'Error: key parameter required', isError: true };
      }
      if (
        typeof expectedVersion !== 'number' ||
        !Number.isInteger(expectedVersion) ||
        expectedVersion < 0
      ) {
        return {
          result:
            'Error: expectedVersion must be a non-negative integer number',
          isError: true,
        };
      }

      try {
        const result = upsertTalkStateEntry({
          talkId,
          key,
          value: args.value,
          expectedVersion,
          updatedByUserId: userId,
          updatedByRunId: runId,
        });

        if (!result.ok) {
          return {
            result: JSON.stringify({
              conflict: true,
              current: result.current,
            }),
            isError: true,
          };
        }

        return {
          result: JSON.stringify(result.entry),
        };
      } catch (error) {
        return {
          result: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    }

    if (toolName === 'delete_state') {
      if (jobPolicy && !jobPolicy.allowStateMutation) {
        return {
          result: 'Error: delete_state is not available for scheduled job runs',
          isError: true,
        };
      }
      const rawKey = args.key as string | undefined;
      const expectedVersion = args.expectedVersion;

      if (!rawKey?.trim()) {
        return { result: 'Error: key parameter required', isError: true };
      }
      if (
        typeof expectedVersion !== 'number' ||
        !Number.isInteger(expectedVersion) ||
        expectedVersion < 0
      ) {
        return {
          result:
            'Error: expectedVersion must be a non-negative integer number',
          isError: true,
        };
      }

      try {
        const validatedKey = validateStateKey(rawKey);
        const result = deleteTalkStateEntry({
          talkId,
          key: validatedKey,
          expectedVersion,
        });

        if (!result.ok) {
          return {
            result: JSON.stringify({
              conflict: true,
              current: result.current,
            }),
            isError: true,
          };
        }

        return {
          result: JSON.stringify({ deleted: true, key: validatedKey }),
        };
      } catch (error) {
        return {
          result: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    }

    if (toolName.startsWith('connector_')) {
      const parsed = parseConnectorToolName(toolName);
      if (!parsed) {
        return {
          result: `Unknown connector tool format: ${toolName}`,
          isError: true,
        };
      }

      const connectors = loadConnectors();
      const connector = connectors.get(parsed.connectorId);
      if (!connector) {
        return {
          result: `Connector '${parsed.connectorId}' is not available for this Talk.`,
          isError: true,
        };
      }

      if (connector.verificationStatus !== 'verified') {
        return {
          result: `Connector '${connector.name}' is no longer verified (status: ${connector.verificationStatus}). Please re-verify the connector credentials.`,
          isError: true,
        };
      }
      if (
        jobPolicy &&
        !jobPolicy.allowedConnectorIds.includes(parsed.connectorId)
      ) {
        return {
          result: `Connector '${parsed.connectorId}' is not available for this scheduled job.`,
          isError: true,
        };
      }

      const context: ToolExecutionContext = {
        connector,
        signal,
      };

      const result = await executeConnectorTool(toolName, args, context);
      return { result: result.content, isError: result.isError };
    }

    if (toolName === 'web_fetch') {
      if (effectiveTools && !enabledToolFamilies.has('web')) {
        return {
          result: 'Error: web tools are not enabled for this agent',
          isError: true,
        };
      }
      if (jobPolicy && !jobPolicy.allowWeb) {
        return {
          result: 'Error: web_fetch is not available for this scheduled job',
          isError: true,
        };
      }
      return executeWebFetch(args, signal);
    }
    if (toolName === 'web_search') {
      if (effectiveTools && !enabledToolFamilies.has('web')) {
        return {
          result: 'Error: web tools are not enabled for this agent',
          isError: true,
        };
      }
      if (jobPolicy && !jobPolicy.allowWeb) {
        return {
          result: 'Error: web_search is not available for this scheduled job',
          isError: true,
        };
      }
      return executeWebSearch(args, signal);
    }
    if (toolName.startsWith('browser_')) {
      if (effectiveTools && !enabledToolFamilies.has('browser')) {
        return {
          result: 'Error: browser tools are not enabled for this agent',
          isError: true,
        };
      }
      if (jobPolicy && !jobPolicy.allowWeb) {
        return {
          result:
            'Error: browser tools are not available for this scheduled job',
          isError: true,
        };
      }
      return executeBrowserTool({
        toolName,
        args,
        context: {
          signal,
          talkId,
          userId,
          runId,
        },
      });
    }
    if (
      toolName === 'google_drive_search' ||
      toolName === 'google_drive_read' ||
      toolName === 'google_drive_list_folder' ||
      toolName === 'google_docs_read' ||
      toolName === 'google_docs_batch_update'
    ) {
      return executeGoogleDriveTalkTool({
        talkId,
        userId,
        toolName,
        args,
        signal,
      });
    }

    return {
      result: `Tool '${toolName}' is not available in Talk context execution`,
      isError: true,
    };
  };
}

function buildTalkJobExecutionPolicy(
  jobId: string | null | undefined,
): TalkJobExecutionPolicy | null {
  if (!jobId) return null;
  const job = getTalkJobById(jobId);
  if (!job) return null;
  return {
    jobId: job.id,
    allowedConnectorIds: job.sourceScope.connectorIds,
    allowedChannelBindingIds: job.sourceScope.channelBindingIds,
    allowWeb: job.sourceScope.allowWeb,
    allowStateMutation: false,
    allowOutputWrite: false,
  };
}

function filterEffectiveToolsForJob(
  effectiveTools: EffectiveToolAccess[],
  jobPolicy: TalkJobExecutionPolicy | null,
): EffectiveToolAccess[] {
  if (!jobPolicy || jobPolicy.allowWeb) {
    return effectiveTools;
  }
  return effectiveTools.map((tool) =>
    tool.toolFamily === 'web' || tool.toolFamily === 'browser'
      ? { ...tool, enabled: false }
      : tool,
  );
}

function resolveTalkAgent(
  talkId: string,
  targetAgentId?: string | null,
): ResolvedTalkAgentExecution {
  const assignments = listTalkAgents(talkId);
  if (targetAgentId) {
    const targetedAssignment = assignments.find(
      (assignment) => assignment.agentId === targetAgentId,
    );
    const targetedAgent = getRegisteredAgent(targetAgentId);
    if (targetedAssignment && targetedAgent) {
      return {
        agent: targetedAgent,
        nickname: targetedAssignment.nickname || targetedAssignment.agentName,
      };
    }
    if (targetedAgent) {
      return { agent: targetedAgent, nickname: targetedAgent.name };
    }
  }

  const primaryAssignment =
    assignments.find((assignment) => assignment.isPrimary) || assignments[0];
  if (primaryAssignment) {
    const primaryAgent = getRegisteredAgent(primaryAssignment.agentId);
    if (primaryAgent) {
      return {
        agent: primaryAgent,
        nickname: primaryAssignment.nickname || primaryAssignment.agentName,
      };
    }
  }

  const primary = resolvePrimaryAgent(talkId);
  if (primary) {
    return { agent: primary, nickname: primary.name };
  }

  const main = getMainAgent();
  if (main) {
    return { agent: main, nickname: main.name };
  }

  throw new TalkExecutorError(
    'NO_AGENT_AVAILABLE',
    'No agent could be resolved for this Talk',
  );
}

function getModelContextWindow(agent: RegisteredAgentRecord): number {
  const row = getDb()
    .prepare(
      `
      SELECT context_window_tokens
      FROM llm_provider_models
      WHERE provider_id = ? AND model_id = ?
      LIMIT 1
    `,
    )
    .get(agent.provider_id, agent.model_id) as
    | { context_window_tokens: number }
    | undefined;

  return row?.context_window_tokens || 128000;
}

function buildMultiAgentExecutionNote(input: {
  responseGroupId?: string | null;
  currentAgentNickname: string;
}): string {
  if (!input.responseGroupId) {
    return '';
  }

  return [
    'Multi-agent routing note:',
    `You are ${input.currentAgentNickname}.`,
    'The system is routing each selected agent separately.',
    'If the user mentions other agent nicknames with @mentions, treat that as addressing/routing context only.',
    "Do not say you cannot invoke the other agents, and do not present another agent's work as your own previous turn.",
  ].join(' ');
}

const CHARS_TO_TOKENS = 0.25;
const ORDERED_USER_MESSAGE_RESERVE_TOKENS = 1024;
const MAX_ORDERED_PRIOR_OUTPUT_TOKENS = 12000;
const MAX_ORDERED_PRIOR_OUTPUT_CONTEXT_SHARE = 0.15;
const MAX_INLINE_TEXT_ATTACHMENT_CHARS = 16_000;
const DIRECT_HISTORY_ATTACHMENT_RESERVE_TOKENS = 2_048;
const MAX_DIRECT_HISTORY_ATTACHMENT_TOKENS = 8_000;
const MAX_DIRECT_HISTORY_ATTACHMENT_CONTEXT_SHARE = 0.1;
const MAX_DIRECT_HISTORY_IMAGE_MESSAGES = 3;
const MAX_DIRECT_HISTORY_IMAGE_BYTES = 15 * 1024 * 1024;
const TRUNCATED_CONTEXT_SUFFIX = '\n\n[truncated for context window]';
const OMITTED_CONTEXT_MARKER = '[omitted due to context window]';
const ATTACHMENT_BUDGET_OMISSION_MESSAGE =
  'omitted from earlier conversation context due to prompt budget.';

type PriorOrderedOutput = {
  sequenceIndex: number;
  agentId: string | null;
  agentNickname: string | null;
  content: string;
};

type PriorOrderedGap = {
  sequenceIndex: number;
  agentId: string | null;
  agentNickname: string | null;
  status: TalkRunStatus;
};

function listPriorOrderedOutputs(
  responseGroupId: string,
  currentSequenceIndex: number,
): PriorOrderedOutput[] {
  return getDb()
    .prepare(
      `
      WITH ordered_assistant_messages AS (
        SELECT
          talk_messages.run_id,
          talk_messages.content
        FROM talk_messages
        WHERE talk_messages.role = 'assistant'
        ORDER BY
          talk_messages.run_id ASC,
          COALESCE(talk_messages.sequence_in_run, 0) ASC,
          talk_messages.created_at ASC,
          talk_messages.id ASC
      ),
      assistant_outputs AS (
        SELECT
          ordered_assistant_messages.run_id,
          GROUP_CONCAT(ordered_assistant_messages.content, '\n\n') AS content
        FROM ordered_assistant_messages
        GROUP BY ordered_assistant_messages.run_id
      )
      SELECT
        r.sequence_index AS sequenceIndex,
        r.target_agent_id AS agentId,
        COALESCE(
          (
            SELECT ta.nickname
            FROM talk_agents ta
            WHERE ta.talk_id = r.talk_id
              AND ta.registered_agent_id = r.target_agent_id
            ORDER BY ta.sort_order ASC, ta.created_at ASC
            LIMIT 1
          ),
          ra.name,
          'Agent'
        ) AS agentNickname,
        ao.content AS content
      FROM talk_runs r
      JOIN assistant_outputs ao ON ao.run_id = r.id
      LEFT JOIN registered_agents ra ON ra.id = r.target_agent_id
      WHERE r.response_group_id = ?
        AND r.sequence_index IS NOT NULL
        AND r.sequence_index < ?
        AND r.status = 'completed'
      ORDER BY r.sequence_index ASC
    `,
    )
    .all(responseGroupId, currentSequenceIndex) as PriorOrderedOutput[];
}

function listPriorOrderedGaps(
  responseGroupId: string,
  currentSequenceIndex: number,
): PriorOrderedGap[] {
  return getDb()
    .prepare(
      `
      SELECT
        r.sequence_index AS sequenceIndex,
        r.target_agent_id AS agentId,
        COALESCE(
          (
            SELECT ta.nickname
            FROM talk_agents ta
            WHERE ta.talk_id = r.talk_id
              AND ta.registered_agent_id = r.target_agent_id
            ORDER BY ta.sort_order ASC, ta.created_at ASC
            LIMIT 1
          ),
          ra.name,
          'Agent'
        ) AS agentNickname,
        r.status AS status
      FROM talk_runs r
      LEFT JOIN registered_agents ra ON ra.id = r.target_agent_id
      WHERE r.response_group_id = ?
        AND r.sequence_index IS NOT NULL
        AND r.sequence_index < ?
        AND r.status <> 'completed'
      ORDER BY r.sequence_index ASC
    `,
    )
    .all(responseGroupId, currentSequenceIndex) as PriorOrderedGap[];
}

function getOrderedGroupMaxSequence(responseGroupId: string): number | null {
  const row = getDb()
    .prepare(
      `
      SELECT MAX(sequence_index) AS max_sequence_index
      FROM talk_runs
      WHERE response_group_id = ?
        AND sequence_index IS NOT NULL
    `,
    )
    .get(responseGroupId) as { max_sequence_index: number | null } | undefined;

  if (!row || row.max_sequence_index == null) {
    return null;
  }

  return row.max_sequence_index;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length * CHARS_TO_TOKENS);
}

function tokenBudgetToCharBudget(tokens: number): number {
  return Math.max(0, Math.floor(tokens / CHARS_TO_TOKENS));
}

function truncateForContextWindow(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return OMITTED_CONTEXT_MARKER;
  }
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= TRUNCATED_CONTEXT_SUFFIX.length) {
    return TRUNCATED_CONTEXT_SUFFIX.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - TRUNCATED_CONTEXT_SUFFIX.length).trimEnd()}${TRUNCATED_CONTEXT_SUFFIX}`;
}

function computePriorOutputBudgetChars(input: {
  modelContextWindow: number;
  estimatedContextTokens: number;
  originalQuestion: string;
}): number {
  const questionTokens = estimateTokens(input.originalQuestion);
  const cappedPromptShare = Math.floor(
    input.modelContextWindow * MAX_ORDERED_PRIOR_OUTPUT_CONTEXT_SHARE,
  );
  const promptBudgetTokens = Math.min(
    MAX_ORDERED_PRIOR_OUTPUT_TOKENS,
    cappedPromptShare,
  );
  const remainingTokens =
    input.modelContextWindow -
    input.estimatedContextTokens -
    ORDERED_USER_MESSAGE_RESERVE_TOKENS -
    questionTokens;
  return tokenBudgetToCharBudget(
    Math.max(0, Math.min(promptBudgetTokens, remainingTokens)),
  );
}

function formatPriorOutputs(
  priorOutputs: PriorOrderedOutput[],
  maxContentChars: number,
): string {
  const maxCharsPerOutput =
    priorOutputs.length > 0
      ? Math.max(0, Math.floor(maxContentChars / priorOutputs.length))
      : 0;
  return priorOutputs
    .map((output) => {
      const label = output.agentNickname || output.agentId || 'Agent';
      return `[${label}]\n${truncateForContextWindow(output.content, maxCharsPerOutput)}`;
    })
    .join('\n\n');
}

function formatPriorGaps(priorGaps: PriorOrderedGap[]): string {
  return priorGaps
    .map((gap) => {
      const label =
        gap.agentNickname || gap.agentId || `Agent ${gap.sequenceIndex + 1}`;
      const statusText =
        gap.status === 'failed'
          ? 'failed to finish'
          : gap.status === 'cancelled'
            ? 'was cancelled'
            : gap.status === 'awaiting_confirmation'
              ? 'is waiting for confirmation'
              : gap.status === 'running'
                ? 'is still running'
                : 'is unavailable';
      return `[${label}] ${statusText}; its output is omitted.`;
    })
    .join('\n');
}

function buildOrderedUserMessage(input: {
  originalQuestion: string;
  priorOutputs: PriorOrderedOutput[];
  priorGaps: PriorOrderedGap[];
  isSynthesis: boolean;
  maxPriorOutputChars: number;
}): string {
  const sections = [`Original user request:\n${input.originalQuestion}`];

  if (input.priorOutputs.length > 0) {
    sections.push(
      `Prior analyses from other agents:\n${formatPriorOutputs(input.priorOutputs, input.maxPriorOutputChars)}`,
    );
  }

  if (input.priorGaps.length > 0) {
    sections.push(
      `Unavailable earlier ordered steps:\n${formatPriorGaps(input.priorGaps)}`,
    );
  }

  if (input.isSynthesis) {
    sections.push(
      [
        'Synthesize these perspectives.',
        'Identify areas of agreement, resolve tensions between differing viewpoints,',
        'and produce a unified recommendation that captures the strongest insights from each perspective.',
        "Treat the prior analyses as other agents' work, not as your own previous statements.",
        'Even if a prior excerpt resembles your provider or a generic assistant label, it still belongs to the cited agent label above, not to you.',
        'Do not assume every earlier ordered step is represented if some analyses are marked unavailable.',
      ].join(' '),
    );
  } else {
    sections.push(
      [
        'Provide your own analysis from your role and perspective.',
        'Use the prior analyses as context from other agents, not as your own previous statements.',
        'Even if a prior excerpt resembles your provider or a generic assistant label, it still belongs to the cited agent label above, not to you.',
        'Do not merely restate them; add your independent reasoning.',
        'Do not assume every earlier ordered step is represented if some analyses are marked unavailable.',
      ].join(' '),
    );
  }

  return sections.join('\n\n');
}

function buildStepUserMessageText(input: {
  triggerContent: string;
  estimatedContextTokens: number;
  modelContextWindow: number;
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
}): { userMessageText: string; isSynthesis: boolean } {
  if (
    !input.responseGroupId ||
    typeof input.sequenceIndex !== 'number' ||
    input.sequenceIndex <= 0
  ) {
    return { userMessageText: input.triggerContent, isSynthesis: false };
  }

  const priorOutputs = listPriorOrderedOutputs(
    input.responseGroupId,
    input.sequenceIndex,
  );
  const priorGaps = listPriorOrderedGaps(
    input.responseGroupId,
    input.sequenceIndex,
  );
  if (priorOutputs.length === 0 && priorGaps.length === 0) {
    return { userMessageText: input.triggerContent, isSynthesis: false };
  }

  const maxSequenceIndex = getOrderedGroupMaxSequence(input.responseGroupId);
  const isSynthesis =
    maxSequenceIndex != null &&
    maxSequenceIndex > 0 &&
    input.sequenceIndex === maxSequenceIndex;
  const maxPriorOutputChars = computePriorOutputBudgetChars({
    modelContextWindow: input.modelContextWindow,
    estimatedContextTokens: input.estimatedContextTokens,
    originalQuestion: input.triggerContent,
  });

  return {
    userMessageText: buildOrderedUserMessage({
      originalQuestion: input.triggerContent,
      priorOutputs,
      priorGaps,
      isSynthesis,
      maxPriorOutputChars,
    }),
    isSynthesis,
  };
}

type DirectPromptAttachment =
  | {
      originalKind: 'image';
      kind: 'image';
      id: string;
      fileName: string;
      fileSize: number;
      mimeType: string;
      base64Data: string;
    }
  | {
      originalKind: 'image' | 'text';
      kind: 'text';
      id: string;
      fileName: string;
      fileSize: number;
      mimeType: string;
      text: string | null;
      omittedDueToBudget?: boolean;
    };

type TextAttachmentExcerpt = {
  text: string | null;
  usedChars: number;
  omittedDueToBudget: boolean;
};

type DirectHistoryAttachmentBudget = {
  remainingImageBytes: number;
  remainingTextChars: number;
};

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

function buildTextAttachmentExcerpt(input: {
  attachmentId: string;
  fileName: string;
  extractionStatus: 'pending' | 'ready' | 'failed';
  extractedText: string | null;
  extractionError: string | null;
  maxChars?: number;
}): TextAttachmentExcerpt {
  const maxChars = Math.max(
    0,
    Math.min(
      MAX_INLINE_TEXT_ATTACHMENT_CHARS,
      input.maxChars ?? MAX_INLINE_TEXT_ATTACHMENT_CHARS,
    ),
  );

  if (maxChars <= 0) {
    return {
      text: null,
      usedChars: 0,
      omittedDueToBudget: true,
    };
  }

  const formatNote = (text: string): TextAttachmentExcerpt => {
    const bounded = truncateForContextWindow(text, maxChars);
    return {
      text: bounded,
      usedChars: bounded.length,
      omittedDueToBudget: false,
    };
  };

  if (input.extractionStatus === 'failed') {
    return formatNote(
      `Attachment text extraction failed for "${input.fileName}". ${
        input.extractionError || 'Unknown extraction error.'
      }`,
    );
  }
  if (input.extractionStatus === 'pending') {
    return formatNote(
      `Attachment text extraction is still pending for "${input.fileName}".`,
    );
  }
  if (!input.extractedText?.trim()) {
    return formatNote(
      `No extracted text is available for "${input.fileName}".`,
    );
  }
  if (input.extractedText.length <= maxChars) {
    return {
      text: input.extractedText,
      usedChars: input.extractedText.length,
      omittedDueToBudget: false,
    };
  }

  const suffix = `\n\n[Excerpt truncated. Use read_attachment("${input.attachmentId}") for the full content.]`;
  if (maxChars <= suffix.length) {
    const boundedSuffix = suffix.slice(0, maxChars);
    return {
      text: boundedSuffix,
      usedChars: boundedSuffix.length,
      omittedDueToBudget: false,
    };
  }

  const excerpt = `${input.extractedText
    .slice(0, maxChars - suffix.length)
    .trimEnd()}${suffix}`;
  return {
    text: excerpt,
    usedChars: excerpt.length,
    omittedDueToBudget: false,
  };
}

function computeHistoryAttachmentTextBudgetChars(input: {
  modelContextWindow: number;
  estimatedContextTokens: number;
  userMessageText: string;
}): number {
  const promptTokens = estimateTokens(input.userMessageText);
  const cappedPromptShare = Math.floor(
    input.modelContextWindow * MAX_DIRECT_HISTORY_ATTACHMENT_CONTEXT_SHARE,
  );
  const promptBudgetTokens = Math.min(
    MAX_DIRECT_HISTORY_ATTACHMENT_TOKENS,
    cappedPromptShare,
  );
  const remainingTokens =
    input.modelContextWindow -
    input.estimatedContextTokens -
    DIRECT_HISTORY_ATTACHMENT_RESERVE_TOKENS -
    promptTokens;
  return tokenBudgetToCharBudget(
    Math.max(0, Math.min(promptBudgetTokens, remainingTokens)),
  );
}

function hasImageAttachments(rows: MessageAttachmentRecord[]): boolean {
  return rows.some((row) => isImageAttachmentMimeType(row.mime_type));
}

function buildHistoryAttachmentRowsByMessageId(input: {
  history: LlmMessage[];
  historyMessageIds: string[];
  currentTriggerMessageId: string;
}): Map<string, MessageAttachmentRecord[]> {
  const byMessageId = new Map<string, MessageAttachmentRecord[]>();

  for (let index = 0; index < input.history.length; index += 1) {
    const message = input.history[index]!;
    const messageId = input.historyMessageIds[index];
    if (
      message.role !== 'user' ||
      !messageId ||
      messageId === input.currentTriggerMessageId
    ) {
      continue;
    }

    const rows = listMessageAttachmentRecords(messageId);
    if (rows.length > 0) {
      byMessageId.set(messageId, rows);
    }
  }

  return byMessageId;
}

function selectRecentHistoryImageMessageIds(input: {
  history: LlmMessage[];
  historyMessageIds: string[];
  attachmentRowsByMessageId: Map<string, MessageAttachmentRecord[]>;
}): Set<string> {
  const selected = new Set<string>();

  for (
    let index = input.history.length - 1;
    index >= 0 && selected.size < MAX_DIRECT_HISTORY_IMAGE_MESSAGES;
    index -= 1
  ) {
    const message = input.history[index]!;
    const messageId = input.historyMessageIds[index];
    if (message.role !== 'user' || !messageId) {
      continue;
    }
    const rows = input.attachmentRowsByMessageId.get(messageId);
    if (!rows || !hasImageAttachments(rows)) {
      continue;
    }
    selected.add(messageId);
  }

  return selected;
}

async function loadDirectPromptAttachments(input: {
  attachmentRows: MessageAttachmentRecord[];
  includeImages?: boolean;
  historyBudget?: DirectHistoryAttachmentBudget;
}): Promise<DirectPromptAttachment[]> {
  const attachments: DirectPromptAttachment[] = [];

  for (const row of input.attachmentRows) {
    if (isImageAttachmentMimeType(row.mime_type)) {
      if (input.includeImages === false) {
        attachments.push({
          originalKind: 'image',
          kind: 'text',
          id: row.id,
          fileName: row.file_name || 'image',
          fileSize: row.file_size,
          mimeType: row.mime_type,
          text: null,
          omittedDueToBudget: true,
        });
        continue;
      }

      if (
        input.historyBudget &&
        row.file_size > input.historyBudget.remainingImageBytes
      ) {
        attachments.push({
          originalKind: 'image',
          kind: 'text',
          id: row.id,
          fileName: row.file_name || 'image',
          fileSize: row.file_size,
          mimeType: row.mime_type,
          text: null,
          omittedDueToBudget: true,
        });
        continue;
      }

      try {
        const buffer = await loadAttachmentFile(row.storage_key);
        if (input.historyBudget) {
          input.historyBudget.remainingImageBytes = Math.max(
            0,
            input.historyBudget.remainingImageBytes - row.file_size,
          );
        }
        attachments.push({
          originalKind: 'image',
          kind: 'image',
          id: row.id,
          fileName: row.file_name || 'image',
          fileSize: row.file_size,
          mimeType: row.mime_type,
          base64Data: buffer.toString('base64'),
        });
        continue;
      } catch (error) {
        logger.warn(
          {
            err: error,
            attachmentId: row.id,
            messageId: row.message_id,
            talkId: row.talk_id,
            storageKey: row.storage_key,
          },
          'Failed to load image attachment for direct vision input',
        );
        attachments.push({
          originalKind: 'image',
          kind: 'text',
          id: row.id,
          fileName: row.file_name || 'image',
          fileSize: row.file_size,
          mimeType: row.mime_type,
          text: `Image attachment "${row.file_name || row.id}" could not be loaded for vision input.`,
        });
        continue;
      }
    }

    const excerpt = buildTextAttachmentExcerpt({
      attachmentId: row.id,
      fileName: row.file_name || row.id,
      extractionStatus: row.extraction_status,
      extractedText: row.extracted_text,
      extractionError: row.extraction_error,
      maxChars: input.historyBudget?.remainingTextChars,
    });
    if (input.historyBudget) {
      input.historyBudget.remainingTextChars = Math.max(
        0,
        input.historyBudget.remainingTextChars - excerpt.usedChars,
      );
    }
    attachments.push({
      originalKind: 'text',
      kind: 'text',
      id: row.id,
      fileName: row.file_name || 'attachment',
      fileSize: row.file_size,
      mimeType: row.mime_type,
      text: excerpt.text,
      omittedDueToBudget: excerpt.omittedDueToBudget,
    });
  }

  return attachments;
}

function messageContentToPlainText(content: LlmMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter(
      (block): block is Extract<LlmContentBlock, { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n');
}

async function buildAttachmentAwareMessageContent(input: {
  attachmentRows: MessageAttachmentRecord[];
  userMessageText: string;
  attachmentHeading: string;
  includeImages?: boolean;
  historyBudget?: DirectHistoryAttachmentBudget;
}): Promise<LlmMessage['content']> {
  const attachments = await loadDirectPromptAttachments({
    attachmentRows: input.attachmentRows,
    includeImages: input.includeImages,
    historyBudget: input.historyBudget,
  });
  if (attachments.length === 0) {
    return input.userMessageText;
  }

  const blocks: LlmContentBlock[] = [];
  const summaryLines = attachments.map((attachment) => {
    const size = formatAttachmentSize(attachment.fileSize);
    if (attachment.originalKind === 'image') {
      if (attachment.kind === 'image') {
        return `- [${attachment.id}] ${attachment.fileName} (${attachment.mimeType}, ${size}) — image included below.`;
      }
      if (attachment.omittedDueToBudget) {
        return `- [${attachment.id}] ${attachment.fileName} (${attachment.mimeType}, ${size}) — ${ATTACHMENT_BUDGET_OMISSION_MESSAGE}`;
      }
      return `- [${attachment.id}] ${attachment.fileName} (${attachment.mimeType}, ${size}) — image note included below.`;
    }
    if (attachment.omittedDueToBudget) {
      return `- [${attachment.id}] ${attachment.fileName} (${attachment.mimeType}, ${size}) — ${ATTACHMENT_BUDGET_OMISSION_MESSAGE}`;
    }
    return `- [${attachment.id}] ${attachment.fileName} (${attachment.mimeType}, ${size}) — text excerpt included below.`;
  });

  blocks.push({
    type: 'text',
    text: [
      input.userMessageText.trim() ||
        'The user attached files without additional text.',
      input.attachmentHeading,
      ...summaryLines,
    ].join('\n\n'),
  });

  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      blocks.push({
        type: 'text',
        text: `Image attachment [${attachment.id}] "${attachment.fileName}":`,
      });
      blocks.push({
        type: 'image',
        mimeType: attachment.mimeType,
        data: attachment.base64Data,
        detail: 'auto',
      });
      continue;
    }

    if (!attachment.text?.trim()) {
      continue;
    }

    blocks.push({
      type: 'text',
      text: `Attachment [${attachment.id}] "${attachment.fileName}":\n${attachment.text}`,
    });
  }

  return blocks;
}

async function buildDirectHistoryMessages(input: {
  history: LlmMessage[];
  historyMessageIds: string[];
  currentTriggerMessageId: string;
  attachmentRowsByMessageId: Map<string, MessageAttachmentRecord[]>;
  imageMessageIdsToHydrate: Set<string>;
  modelContextWindow: number;
  estimatedContextTokens: number;
  userMessageText: string;
}): Promise<LlmMessage[]> {
  const next: LlmMessage[] = [];
  const rehydratedContentByMessageId = new Map<string, LlmMessage['content']>();
  const historyBudget: DirectHistoryAttachmentBudget = {
    remainingImageBytes: MAX_DIRECT_HISTORY_IMAGE_BYTES,
    remainingTextChars: computeHistoryAttachmentTextBudgetChars({
      modelContextWindow: input.modelContextWindow,
      estimatedContextTokens: input.estimatedContextTokens,
      userMessageText: input.userMessageText,
    }),
  };

  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    const message = input.history[index]!;
    const messageId = input.historyMessageIds[index];
    if (
      message.role !== 'user' ||
      !messageId ||
      messageId === input.currentTriggerMessageId
    ) {
      continue;
    }

    const attachmentRows = input.attachmentRowsByMessageId.get(messageId);
    if (!attachmentRows || attachmentRows.length === 0) {
      continue;
    }

    rehydratedContentByMessageId.set(
      messageId,
      await buildAttachmentAwareMessageContent({
        attachmentRows,
        userMessageText: messageContentToPlainText(message.content),
        attachmentHeading: 'Message attachments:',
        includeImages: input.imageMessageIdsToHydrate.has(messageId),
        historyBudget,
      }),
    );
  }

  for (let index = 0; index < input.history.length; index += 1) {
    const message = input.history[index]!;
    const messageId = input.historyMessageIds[index];
    const rehydratedContent = messageId
      ? rehydratedContentByMessageId.get(messageId)
      : undefined;
    next.push(
      rehydratedContent === undefined
        ? message
        : {
            ...message,
            content: rehydratedContent,
          },
    );
  }

  return next;
}

function assertVisionSupportForConversationImages(input: {
  agent: RegisteredAgentRecord;
  currentAttachmentRows: MessageAttachmentRecord[];
  historyImageMessageIdsToHydrate: Set<string>;
}): void {
  const includesCurrentImages = hasImageAttachments(
    input.currentAttachmentRows,
  );
  const includesHistoryImages = input.historyImageMessageIdsToHydrate.size > 0;

  if (!includesCurrentImages && !includesHistoryImages) {
    return;
  }

  if (modelSupportsVision(input.agent.provider_id, input.agent.model_id)) {
    return;
  }

  const scope = includesCurrentImages
    ? 'this message includes image attachments'
    : 'recent conversation context includes image attachments';
  throw new TalkExecutorError(
    'MODEL_VISION_UNSUPPORTED',
    `The selected model "${input.agent.model_id}" does not support vision, but ${scope}. Choose a vision-capable model or remove the images.`,
  );
}

function buildResponseMetadataJson(input: {
  runId: string;
  providerId: string;
  modelId: string;
  estimatedContextTokens: number;
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
  isSynthesis: boolean;
  completion?: TalkExecutorOutput['completion'] | null;
}): string {
  return JSON.stringify({
    runId: input.runId,
    providerId: input.providerId,
    modelId: input.modelId,
    contextTokens: input.estimatedContextTokens,
    responseGroupId: input.responseGroupId ?? null,
    sequenceIndex: input.sequenceIndex ?? null,
    completionStatus: input.completion?.completionStatus ?? 'complete',
    providerStopReason: input.completion?.providerStopReason ?? null,
    incompleteReason: input.completion?.incompleteReason ?? null,
    completedCleanly: input.completion?.completionStatus !== 'incomplete',
    ...(input.isSynthesis ? { isSynthesis: true } : {}),
  });
}

export class CleanTalkExecutor implements TalkExecutor {
  async execute(
    input: TalkExecutorInput,
    signal: AbortSignal,
    emit?: (event: TalkExecutionEvent) => void,
  ): Promise<TalkExecutorOutput> {
    const emitEvent = emit || (() => {});
    let failureEmitted = false;
    let resolvedAgent: ResolvedTalkAgentExecution | null = null;

    const emitTalkEvent = (event: TalkExecutionEvent) => {
      if (event.type === 'talk_response_failed') {
        failureEmitted = true;
      }
      emitEvent(event);
    };

    try {
      const existingRunMetadata = parseRunMetadata(
        getTalkRunById(input.runId)?.metadata_json,
      );
      const runMetadata = { ...existingRunMetadata };
      const browserResumeSection =
        buildBrowserResumeSection(existingRunMetadata);
      const channelTriggerContext = loadChannelTriggerContext({
        triggerMessageId: input.triggerMessageId,
      });

      resolvedAgent = resolveTalkAgent(input.talkId, input.targetAgentId);
      const activeAgent = resolvedAgent.agent;
      const modelContextWindow = getModelContextWindow(activeAgent);
      const jobPolicy = buildTalkJobExecutionPolicy(input.jobId);
      const plan = planExecution(activeAgent, input.requestedBy);
      const multiAgentExecutionNote = buildMultiAgentExecutionNote({
        responseGroupId: input.responseGroupId,
        currentAgentNickname: resolvedAgent.nickname,
      });
      const channelExecutionContext = await loadChannelExecutionContext({
        trigger: channelTriggerContext.trigger,
        binding: channelTriggerContext.binding,
      });
      const scopedEffectiveTools = filterEffectiveToolsForJob(
        plan.effectiveTools,
        jobPolicy,
      );
      const contextPackage = await loadTalkContext(
        input.talkId,
        modelContextWindow,
        input.threadId,
        input.triggerMessageId,
        input.requestedBy,
        {
          personaRole: activeAgent.persona_role as TalkPersonaRole | null,
          retrievalQuery: input.triggerContent,
          jobPolicy,
          effectiveTools: scopedEffectiveTools,
          channelContextSection: channelExecutionContext.channelContextSection,
        },
      );
      setTalkRunMetadataJson(
        input.runId,
        JSON.stringify({
          ...runMetadata,
          ...contextPackage.contextSnapshot,
          executionDecision: buildExecutionDecision(activeAgent, plan),
        }),
      );

      const context: ExecutionContext = {
        systemPrompt: [
          contextPackage.systemPrompt,
          multiAgentExecutionNote,
          browserResumeSection
            ? `# Browser Resume Context\n\n${browserResumeSection}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        contextTools: contextPackage.contextTools,
        connectorTools: contextPackage.connectorTools,
        history: contextPackage.history,
      };
      const talkCodexSupport = talkUsesUnsupportedCodexExecution(input.talkId);
      if (plan.backend === 'host_codex' && !talkCodexSupport.supported) {
        throw new TalkExecutorError(
          'CODEX_TALK_UNSUPPORTED',
          talkCodexSupport.message ||
            'Codex host execution is not supported for this Talk.',
        );
      }
      if (plan.backend === 'host_codex') {
        const unsupportedContextTools =
          contextUsesUnsupportedCodexTools(context);
        if (unsupportedContextTools.length > 0) {
          throw new TalkExecutorError(
            'CODEX_TALK_UNSUPPORTED',
            `Codex host execution does not support this Talk context yet: ${unsupportedContextTools.join(', ')}.`,
          );
        }
      }

      const orderedStep = buildStepUserMessageText({
        triggerContent: input.triggerContent,
        estimatedContextTokens: contextPackage.estimatedTokens,
        modelContextWindow,
        responseGroupId: input.responseGroupId,
        sequenceIndex: input.sequenceIndex,
      });

      if (plan.backend === 'container') {
        const talk = getTalkById(input.talkId);
        const projectMountHostPath = resolveValidatedProjectMountPath(
          talk?.project_path ?? null,
          false,
        );
        emitTalkEvent({
          type: 'talk_response_started',
          runId: input.runId,
          talkId: input.talkId,
          threadId: input.threadId,
          agentId: activeAgent.id,
          agentNickname: resolvedAgent.nickname,
          responseGroupId: input.responseGroupId ?? null,
          sequenceIndex: input.sequenceIndex ?? null,
          providerId: activeAgent.provider_id,
          modelId: activeAgent.model_id,
        });

        const containerResult = await executeContainerAgentTurn({
          runId: input.runId,
          userId: input.requestedBy,
          agent: activeAgent,
          promptLabel: 'talk',
          userMessage: orderedStep.userMessageText,
          signal,
          allowedTools: getContainerAllowedTools({
            effectiveTools: scopedEffectiveTools,
            includeConnectorTools: contextPackage.connectorTools.length > 0,
          }),
          context: {
            systemPrompt: [
              context.systemPrompt,
              activeAgent.system_prompt?.trim() || '',
            ]
              .filter(Boolean)
              .join('\n\n'),
            history: contextPackage.history,
          },
          modelContextWindow,
          containerCredential: plan.containerCredential,
          talkId: input.talkId,
          threadId: input.threadId,
          triggerMessageId: input.triggerMessageId,
          historyMessageIds: contextPackage.metadata.historyMessageIds,
          projectMountHostPath,
          jobPolicy,
          enableBrowserTools: scopedEffectiveTools.some(
            (tool) => tool.toolFamily === 'browser' && tool.enabled,
          ),
        });

        emitTalkEvent({
          type: 'talk_response_completed',
          runId: input.runId,
          talkId: input.talkId,
          threadId: input.threadId,
          agentId: activeAgent.id,
          agentNickname: resolvedAgent.nickname,
          responseGroupId: input.responseGroupId ?? null,
          sequenceIndex: input.sequenceIndex ?? null,
          providerId: activeAgent.provider_id,
          modelId: activeAgent.model_id,
        });

        return {
          content: containerResult.content,
          agentId: activeAgent.id,
          agentNickname: resolvedAgent.nickname,
          providerId: activeAgent.provider_id,
          modelId: activeAgent.model_id,
          responseSequenceInRun: 1,
          metadataJson: buildResponseMetadataJson({
            runId: input.runId,
            providerId: activeAgent.provider_id,
            modelId: activeAgent.model_id,
            estimatedContextTokens: contextPackage.estimatedTokens,
            responseGroupId: input.responseGroupId,
            sequenceIndex: input.sequenceIndex,
            isSynthesis: orderedStep.isSynthesis,
            completion: {
              completionStatus: 'complete',
              providerStopReason: null,
              incompleteReason: null,
            },
          }),
        };
      }

      if (plan.backend === 'host_codex') {
        const talk = getTalkById(input.talkId);
        const projectMountHostPath = resolveValidatedProjectMountPath(
          talk?.project_path ?? null,
          false,
        );
        emitTalkEvent({
          type: 'talk_response_started',
          runId: input.runId,
          talkId: input.talkId,
          threadId: input.threadId,
          agentId: activeAgent.id,
          agentNickname: resolvedAgent.nickname,
          responseGroupId: input.responseGroupId ?? null,
          sequenceIndex: input.sequenceIndex ?? null,
          providerId: activeAgent.provider_id,
          modelId: activeAgent.model_id,
        });

        const codexResult = await executeCodexAgentTurn({
          runId: input.runId,
          userId: input.requestedBy,
          agent: activeAgent,
          promptLabel: 'talk',
          userMessage: orderedStep.userMessageText,
          signal,
          context: {
            systemPrompt: [
              context.systemPrompt,
              activeAgent.system_prompt?.trim() || '',
            ]
              .filter(Boolean)
              .join('\n\n'),
            history: contextPackage.history,
          },
          modelContextWindow,
          talkId: input.talkId,
          threadId: input.threadId,
          triggerMessageId: input.triggerMessageId,
          historyMessageIds: contextPackage.metadata.historyMessageIds,
          projectMountHostPath,
          jobPolicy,
          enableWebTools: scopedEffectiveTools.some(
            (tool) => tool.toolFamily === 'web' && tool.enabled,
          ),
          enableBrowserTools: scopedEffectiveTools.some(
            (tool) => tool.toolFamily === 'browser' && tool.enabled,
          ),
          onProgressUpdate: (message) => {
            const currentAgent = resolvedAgent!;
            emitTalkEvent({
              type: 'talk_progress_update',
              runId: input.runId,
              talkId: input.talkId,
              threadId: input.threadId,
              agentId: currentAgent.agent.id,
              agentNickname: currentAgent.nickname,
              responseGroupId: input.responseGroupId ?? null,
              sequenceIndex: input.sequenceIndex ?? null,
              providerId: currentAgent.agent.provider_id,
              modelId: currentAgent.agent.model_id,
              message,
            });
          },
        });

        if (
          codexResult.usage?.inputTokens !== undefined ||
          codexResult.usage?.cachedInputTokens !== undefined ||
          codexResult.usage?.outputTokens !== undefined
        ) {
          emitTalkEvent({
            type: 'talk_response_usage',
            runId: input.runId,
            talkId: input.talkId,
            threadId: input.threadId,
            agentId: activeAgent.id,
            responseGroupId: input.responseGroupId ?? null,
            sequenceIndex: input.sequenceIndex ?? null,
            providerId: activeAgent.provider_id,
            modelId: activeAgent.model_id,
            usage: {
              inputTokens: codexResult.usage.inputTokens,
              cachedInputTokens: codexResult.usage.cachedInputTokens,
              outputTokens: codexResult.usage.outputTokens,
            },
          });
        }

        emitTalkEvent({
          type: 'talk_response_completed',
          runId: input.runId,
          talkId: input.talkId,
          threadId: input.threadId,
          agentId: activeAgent.id,
          agentNickname: resolvedAgent.nickname,
          responseGroupId: input.responseGroupId ?? null,
          sequenceIndex: input.sequenceIndex ?? null,
          providerId: activeAgent.provider_id,
          modelId: activeAgent.model_id,
          usage: codexResult.usage
            ? {
                inputTokens: codexResult.usage.inputTokens,
                cachedInputTokens: codexResult.usage.cachedInputTokens,
                outputTokens: codexResult.usage.outputTokens,
              }
            : undefined,
        });

        return {
          content: codexResult.content,
          agentId: activeAgent.id,
          agentNickname: resolvedAgent.nickname,
          providerId: activeAgent.provider_id,
          modelId: activeAgent.model_id,
          usage: codexResult.usage
            ? {
                inputTokens: codexResult.usage.inputTokens,
                cachedInputTokens: codexResult.usage.cachedInputTokens,
                outputTokens: codexResult.usage.outputTokens,
              }
            : undefined,
          responseSequenceInRun: 1,
          metadataJson: buildResponseMetadataJson({
            runId: input.runId,
            providerId: activeAgent.provider_id,
            modelId: activeAgent.model_id,
            estimatedContextTokens: contextPackage.estimatedTokens,
            responseGroupId: input.responseGroupId,
            sequenceIndex: input.sequenceIndex,
            isSynthesis: orderedStep.isSynthesis,
            completion: {
              completionStatus: 'complete',
              providerStopReason: null,
              incompleteReason: null,
            },
          }),
        };
      }

      const toolExecutor = buildToolExecutor(
        input.talkId,
        input.requestedBy,
        input.runId,
        signal,
        jobPolicy,
        scopedEffectiveTools,
      );
      const currentAttachmentRows = listMessageAttachmentRecords(
        input.triggerMessageId,
      );
      const historyAttachmentRowsByMessageId =
        buildHistoryAttachmentRowsByMessageId({
          history: context.history,
          historyMessageIds: contextPackage.metadata.historyMessageIds,
          currentTriggerMessageId: input.triggerMessageId,
        });
      const historyImageMessageIdsToHydrate =
        selectRecentHistoryImageMessageIds({
          history: context.history,
          historyMessageIds: contextPackage.metadata.historyMessageIds,
          attachmentRowsByMessageId: historyAttachmentRowsByMessageId,
        });

      assertVisionSupportForConversationImages({
        agent: activeAgent,
        currentAttachmentRows,
        historyImageMessageIdsToHydrate,
      });

      const directHistory = await buildDirectHistoryMessages({
        history: context.history,
        historyMessageIds: contextPackage.metadata.historyMessageIds,
        currentTriggerMessageId: input.triggerMessageId,
        attachmentRowsByMessageId: historyAttachmentRowsByMessageId,
        imageMessageIdsToHydrate: historyImageMessageIdsToHydrate,
        modelContextWindow,
        estimatedContextTokens: contextPackage.estimatedTokens,
        userMessageText: orderedStep.userMessageText,
      });
      const directUserMessage = await buildAttachmentAwareMessageContent({
        attachmentRows: currentAttachmentRows,
        userMessageText: orderedStep.userMessageText,
        attachmentHeading: 'Current message attachments:',
      });
      const result = await executeWithAgent(
        activeAgent.id,
        {
          ...context,
          history: directHistory,
        },
        directUserMessage,
        {
          runId: input.runId,
          userId: input.requestedBy,
          signal,
          emit: (event: ExecutionEvent) => {
            const mappedEvent = mapExecutionEvent(event, input, resolvedAgent!);
            if (mappedEvent) {
              emitTalkEvent(mappedEvent);
            }
          },
          executeToolCall: toolExecutor,
        },
      );

      return {
        content: result.content,
        agentId: result.agentId,
        agentNickname: resolvedAgent.nickname,
        providerId: result.providerId,
        modelId: result.modelId,
        usage: result.usage
          ? {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              estimatedCostUsd: result.usage.estimatedCostUsd,
            }
          : undefined,
        responseSequenceInRun: 1,
        metadataJson: buildResponseMetadataJson({
          runId: input.runId,
          providerId: result.providerId,
          modelId: result.modelId,
          estimatedContextTokens: contextPackage.estimatedTokens,
          responseGroupId: input.responseGroupId,
          sequenceIndex: input.sequenceIndex,
          isSynthesis: orderedStep.isSynthesis,
          completion: result.completion,
        }),
        completion: result.completion,
      };
    } catch (error) {
      const errorCode =
        error instanceof TalkExecutorError
          ? error.code
          : error instanceof Error
            ? 'EXECUTOR_ERROR'
            : 'UNKNOWN_ERROR';
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (!failureEmitted) {
        emitTalkEvent({
          type: 'talk_response_failed',
          runId: input.runId,
          talkId: input.talkId,
          threadId: input.threadId,
          agentId: resolvedAgent?.agent.id,
          agentNickname: resolvedAgent?.nickname,
          responseGroupId: input.responseGroupId ?? null,
          sequenceIndex: input.sequenceIndex ?? null,
          providerId: resolvedAgent?.agent.provider_id,
          modelId: resolvedAgent?.agent.model_id,
          errorCode,
          errorMessage,
        });
      }

      throw error;
    }
  }
}

export default CleanTalkExecutor;
