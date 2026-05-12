import { randomUUID } from 'crypto';

import { getDb } from '../../../db.js';
import { getContainerRuntimeStatus } from '../../../container-runtime.js';
import {
  AttachmentValidationError,
  TalkActiveRoundError,
  cancelTalkRunsAtomic,
  createTalk,
  createTalkFolder,
  deleteTalkFolderAndMoveTalksToTopLevel,
  deleteTalkForOwner,
  deleteTalkLlmPolicy,
  deleteTalkMessagesAtomic,
  enqueueTalkTurnAtomic,
  getTalkById,
  getTalkForUser,
  getTalkRunById,
  listMessageAttachments,
  resolveThreadIdForTalk,
  listTalkFoldersForOwner,
  listTalkMessages,
  listTalkRunsForTalk,
  listTalkSidebarTreeForUser,
  listTalksForUser,
  normalizeTalkListPage,
  patchTalkMetadata,
  renameTalkFolder,
  reorderTalkSidebarItem,
  searchTalkMessages,
  TalkThreadValidationError,
  updateTalkProjectPath,
  upsertTalkLlmPolicy,
  type TalkMessageRecord,
  type TalkSidebarTalkRecord,
  type TalkWithAccessRecord,
} from '../../db/index.js';
import type { TalkPersonaRole } from '../../llm/types.js';
import type { TalkRunContextSnapshot } from '../../talks/context-loader.js';
import type {
  BrowserBlockMetadata,
  BrowserResumeMetadata,
  CarriedBrowserSessionMetadata,
  ExecutionDecisionMetadata,
} from '../../browser/metadata.js';
import { validateMount } from '../../../mount-security.js';
import {
  parsePolicyAgentsForExecution,
  parsePolicyAgentsForUiBadges,
} from '../../talks/policy.js';
import {
  getDefaultTalkAgentId,
  ensureTalkUsesUsableDefaultAgent,
  listTalkAgents,
  resolveTalkAgentMentions,
  setTalkAgents,
  getTalkAgentRows,
  type TalkAgentInput,
} from '../../agents/agent-registry.js';
import {
  getEffectiveToolsForAgent,
  getRegisteredAgent,
} from '../../db/agent-accessors.js';
import {
  ExecutionPlannerError,
  planExecution,
} from '../../agents/execution-planner.js';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '../../talks/attachment-extraction.js';
import { canEditTalk } from '../middleware/acl.js';
import { AuthContext, ApiEnvelope } from '../types.js';

const TALK_BROWSER_EXECUTION_SETUP_MESSAGE =
  "Browser access is not configured for this agent. Configure the agent's execution credentials in AI Agents before retrying. For Claude agents, run `claude login` and import subscription auth, or add an Anthropic API key.";

interface TalkApiRecord {
  id: string;
  ownerId: string;
  folderId: string | null;
  sortOrder: number;
  title: string | null;
  projectPath: string | null;
  orchestrationMode: 'ordered' | 'panel';
  agents: string[];
  status: 'active' | 'paused' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
  accessRole: 'owner' | 'admin' | 'editor' | 'viewer';
}

interface SidebarTalkApiRecord {
  id: string;
  title: string | null;
  status: 'active' | 'paused' | 'archived';
  sortOrder: number;
  lastMessageAt: string | null;
  messageCount: number;
  hasActiveRun: boolean;
}

interface TalkFolderApiRecord {
  id: string;
  title: string;
  sortOrder: number;
  talks: SidebarTalkApiRecord[];
}

type TalkSidebarItemApiRecord =
  | ({
      type: 'talk';
    } & SidebarTalkApiRecord)
  | {
      type: 'folder';
      id: string;
      title: string;
      sortOrder: number;
      talks: SidebarTalkApiRecord[];
    };

interface TalkMessageAttachmentApi {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  extractionStatus: 'pending' | 'ready' | 'failed';
}

interface TalkMessageApiRecord {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdBy: string | null;
  createdAt: string;
  runId: string | null;
  agentId?: string | null;
  agentNickname?: string | null;
  metadata?: Record<string, unknown> | null;
  attachments?: TalkMessageAttachmentApi[];
}

interface TalkMessageSearchResultApiRecord {
  messageId: string;
  threadId: string;
  threadTitle: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  createdAt: string;
  preview: string;
}

export interface TalkAgentApiRecord {
  id: string;
  nickname: string;
  nicknameMode: 'auto' | 'custom';
  sourceKind: 'claude_default' | 'provider';
  role: TalkPersonaRole;
  isPrimary: boolean;
  displayOrder: number;
  health: 'ready' | 'invalid' | 'unknown';
  providerId: string | null;
  modelId: string | null;
  modelDisplayName: string | null;
}

export interface TalkRunApiRecord {
  id: string;
  threadId: string;
  responseGroupId: string | null;
  sequenceIndex: number | null;
  status:
    | 'queued'
    | 'running'
    | 'awaiting_confirmation'
    | 'cancelled'
    | 'completed'
    | 'failed';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  triggerMessageId: string | null;
  targetAgentId: string | null;
  targetAgentNickname: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  cancelReason: string | null;
  executorAlias: string | null;
  executorModel: string | null;
  browserBlock: BrowserBlockMetadata | null;
  browserResume: BrowserResumeMetadata | null;
  carriedBrowserSessions: CarriedBrowserSessionMetadata[];
  executionDecision: ExecutionDecisionMetadata | null;
  completionStatus?: 'complete' | 'incomplete' | null;
  providerStopReason?: string | null;
  incompleteReason?: 'truncated' | 'empty' | 'unknown' | null;
}

function parseTalkRunContextSnapshot(
  metadataJson: string | null | undefined,
): TalkRunContextSnapshot | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as
      | TalkRunContextSnapshot
      | { version?: unknown }
      | null;
    return parsed && typeof parsed === 'object' && parsed.version === 1
      ? (parsed as TalkRunContextSnapshot)
      : null;
  } catch {
    return null;
  }
}

function parseRunMetadataObject<T>(value: unknown): T | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as T;
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

function parseRunResponseMetadata(metadataJson: string | null | undefined): {
  completionStatus: 'complete' | 'incomplete' | null;
  providerStopReason: string | null;
  incompleteReason: 'truncated' | 'empty' | 'unknown' | null;
} {
  const metadata = parseRunMetadata(metadataJson);
  const responseMetadata =
    parseRunMetadataObject<Record<string, unknown>>(
      metadata.responseMetadata,
    ) || metadata;
  const completionStatus =
    responseMetadata.completionStatus === 'complete' ||
    responseMetadata.completionStatus === 'incomplete'
      ? (responseMetadata.completionStatus as 'complete' | 'incomplete')
      : null;
  const providerStopReason =
    typeof responseMetadata.providerStopReason === 'string'
      ? responseMetadata.providerStopReason
      : null;
  const incompleteReason =
    responseMetadata.incompleteReason === 'truncated' ||
    responseMetadata.incompleteReason === 'empty' ||
    responseMetadata.incompleteReason === 'unknown'
      ? (responseMetadata.incompleteReason as 'truncated' | 'empty' | 'unknown')
      : null;
  return {
    completionStatus,
    providerStopReason,
    incompleteReason,
  };
}

const DEFAULT_TALK_AGENTS = ['Claude'];
const MAX_TALK_AGENT_BADGES = 6;
const MAX_TALK_AGENTS = 12;
const MAX_TALK_AGENT_NAME_CHARS = 80;

function parseFallbackAgentBadges(llmPolicy: string | null): string[] {
  const normalized = parsePolicyAgentsForUiBadges(
    llmPolicy?.trim() || '',
    MAX_TALK_AGENT_BADGES,
  );
  return normalized.length > 0 ? normalized : DEFAULT_TALK_AGENTS;
}

function parseFallbackPolicyAgents(llmPolicy: string | null): string[] {
  return parsePolicyAgentsForExecution(llmPolicy);
}

function toTalkApiRecord(talk: TalkWithAccessRecord): TalkApiRecord {
  const policyBadges = parseFallbackAgentBadges(talk.llm_policy);
  const agents =
    policyBadges.length > 0 && talk.llm_policy
      ? policyBadges
      : listEffectiveTalkAgents(talk.id).map((a) => a.nickname);
  const canManageProjectPath =
    talk.access_role === 'owner' || talk.access_role === 'admin';
  return {
    id: talk.id,
    ownerId: talk.owner_id,
    folderId: talk.folder_id,
    sortOrder: talk.sort_order,
    title: talk.topic_title,
    projectPath: canManageProjectPath ? talk.project_path : null,
    orchestrationMode: talk.orchestration_mode,
    agents: agents.length > 0 ? agents : DEFAULT_TALK_AGENTS,
    status: talk.status,
    version: talk.version,
    createdAt: talk.created_at,
    updatedAt: talk.updated_at,
    accessRole: talk.access_role,
  };
}

function toSidebarTalkApiRecord(
  talk: TalkSidebarTalkRecord,
): SidebarTalkApiRecord {
  return {
    id: talk.id,
    title: talk.topic_title,
    status: talk.status,
    sortOrder: talk.sort_order,
    lastMessageAt: talk.last_message_at,
    messageCount: talk.message_count,
    hasActiveRun: talk.has_active_run,
  };
}

function mapVerificationToHealth(
  verificationStatus:
    | 'missing'
    | 'not_verified'
    | 'verifying'
    | 'verified'
    | 'invalid'
    | 'unavailable'
    | null
    | undefined,
): 'ready' | 'invalid' | 'unknown' {
  if (verificationStatus === 'verified') return 'ready';
  if (
    verificationStatus === 'invalid' ||
    verificationStatus === 'unavailable'
  ) {
    return 'invalid';
  }
  return 'unknown';
}

function buildTalkAgentHealthLookup(): {
  claudeDefaultHealth: 'ready' | 'invalid' | 'unknown';
  providerHealthById: Map<string, 'ready' | 'invalid' | 'unknown'>;
} {
  const providerHealthById = new Map<string, 'ready' | 'invalid' | 'unknown'>();
  const claudeDefaultHealth: 'ready' | 'invalid' | 'unknown' = 'unknown';
  return { claudeDefaultHealth, providerHealthById };
}

function parseTalkRunError(
  run: Pick<
    ReturnType<typeof listTalkRunsForTalk>[number],
    'status' | 'cancel_reason'
  >,
): { errorCode: string | null; errorMessage: string | null } {
  const raw = run.cancel_reason?.trim() || null;
  if (!raw) {
    return { errorCode: null, errorMessage: null };
  }

  if (run.status === 'cancelled') {
    return { errorCode: 'cancelled', errorMessage: raw };
  }

  const prefixed = /^([a-z0-9_]+):\s*(.+)$/i.exec(raw);
  if (prefixed) {
    return { errorCode: prefixed[1], errorMessage: prefixed[2] };
  }

  if (raw === 'interrupted_by_restart') {
    return {
      errorCode: 'interrupted_by_restart',
      errorMessage: 'Run interrupted by process restart',
    };
  }

  return { errorCode: raw, errorMessage: raw };
}

function toTalkAgentApiRecord(
  agent: {
    id: string;
    nickname: string;
    nicknameMode: 'auto' | 'custom';
    sourceKind: 'claude_default' | 'provider';
    role: TalkPersonaRole;
    isLead: boolean;
    displayOrder: number;
    status: 'active' | 'archived';
    providerId: string | null;
    modelId: string | null;
    modelDisplayName: string | null;
  },
  healthLookup: {
    claudeDefaultHealth: 'ready' | 'invalid' | 'unknown';
    providerHealthById: Map<string, 'ready' | 'invalid' | 'unknown'>;
  },
): TalkAgentApiRecord {
  return {
    id: agent.id,
    nickname: agent.nickname,
    nicknameMode: agent.nicknameMode,
    sourceKind: agent.sourceKind,
    role: agent.role,
    isPrimary: agent.isLead,
    displayOrder: agent.displayOrder,
    health:
      agent.sourceKind === 'claude_default'
        ? healthLookup.claudeDefaultHealth
        : healthLookup.providerHealthById.get(agent.providerId || '') ||
          'unknown',
    providerId: agent.providerId,
    modelId: agent.modelId,
    modelDisplayName: agent.modelDisplayName,
  };
}

function toTalkMessageApiRecord(
  message: TalkMessageRecord,
): TalkMessageApiRecord {
  let agentId: string | null | undefined;
  let agentNickname: string | null | undefined;
  let metadata: Record<string, unknown> | null = null;
  if (message.metadata_json) {
    try {
      const parsed = JSON.parse(message.metadata_json) as {
        agentId?: unknown;
        agentNickname?: unknown;
        agentName?: unknown;
      } & Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed;
        if (typeof parsed.agentId === 'string') agentId = parsed.agentId;
        if (typeof parsed.agentNickname === 'string') {
          agentNickname = parsed.agentNickname;
        } else if (typeof parsed.agentName === 'string') {
          agentNickname = parsed.agentName;
        }
      }
    } catch {
      // Ignore metadata parse failures for UI response shaping.
    }
  }
  if ((!agentId || !agentNickname) && message.run_id) {
    const fallback = getDb()
      .prepare(
        `
          SELECT
            r.target_agent_id AS agent_id,
            COALESCE(
              (
                SELECT ta.nickname
                FROM talk_agents ta
                WHERE ta.talk_id = r.talk_id
                  AND ta.registered_agent_id = r.target_agent_id
                ORDER BY ta.sort_order ASC, ta.created_at ASC
                LIMIT 1
              ),
              ra.name
            ) AS agent_nickname
          FROM talk_runs r
          LEFT JOIN registered_agents ra ON ra.id = r.target_agent_id
          WHERE r.id = ?
          LIMIT 1
        `,
      )
      .get(message.run_id) as
      | {
          agent_id: string | null;
          agent_nickname: string | null;
        }
      | undefined;
    if (fallback) {
      if (!agentId && typeof fallback.agent_id === 'string') {
        agentId = fallback.agent_id;
      }
      if (!agentNickname && typeof fallback.agent_nickname === 'string') {
        agentNickname = fallback.agent_nickname;
      }
    }
  }

  // Load attachments for this message (lightweight — only metadata)
  const attachmentRows = listMessageAttachments(message.id);
  const attachments: TalkMessageAttachmentApi[] | undefined =
    attachmentRows.length > 0
      ? attachmentRows.map((a) => ({
          id: a.id,
          fileName: a.fileName,
          fileSize: a.fileSize,
          mimeType: a.mimeType,
          extractionStatus: a.extractionStatus,
        }))
      : undefined;

  return {
    id: message.id,
    threadId: message.thread_id,
    role: message.role,
    content: message.content,
    createdBy: message.created_by,
    createdAt: message.created_at,
    runId: message.run_id,
    agentId,
    agentNickname,
    metadata,
    attachments,
  };
}

function buildMessagePreview(content: string, maxChars = 140): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function canManageTalkProjectMount(
  talk: Pick<TalkWithAccessRecord, 'owner_id'>,
  auth: AuthContext,
): boolean {
  return (
    auth.role === 'owner' ||
    auth.role === 'admin' ||
    talk.owner_id === auth.userId
  );
}

function validateTalkProjectPath(rawPath: string): {
  projectPath?: string;
  error?: { code: string; message: string };
} {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return {
      error: {
        code: 'invalid_project_path',
        message: 'Project path is required',
      },
    };
  }

  const result = validateMount(
    {
      hostPath: trimmed,
      readonly: true,
    },
    false,
  );
  if (!result.allowed || !result.realHostPath) {
    return {
      error: {
        code: 'invalid_project_path',
        message: result.reason || 'Project path is not allowed',
      },
    };
  }

  return { projectPath: result.realHostPath };
}

function normalizeTalkBrowserExecutionMessage(message: string): string {
  if (
    message === 'Direct execution is unavailable.' ||
    /container execution is not configured/i.test(message) ||
    /direct execution is unavailable/i.test(message)
  ) {
    return TALK_BROWSER_EXECUTION_SETUP_MESSAGE;
  }
  return message;
}

function getBrowserPreflightErrorForAgent(
  agentId: string,
  userId: string,
): string | null {
  const agent = getRegisteredAgent(agentId);
  if (!agent) return null;

  const browserEnabled = getEffectiveToolsForAgent(agent.id, userId).some(
    (tool) => tool.toolFamily === 'browser' && tool.enabled,
  );
  if (!browserEnabled) return null;

  try {
    const plan = planExecution(agent, userId);
    if (
      plan.backend === 'container' &&
      getContainerRuntimeStatus() !== 'ready'
    ) {
      return `Browser access for ${agent.name} needs the Claude container runtime. Start Docker, then retry.`;
    }
    return null;
  } catch (error) {
    if (error instanceof ExecutionPlannerError) {
      return `Browser access for ${agent.name} is not ready. ${normalizeTalkBrowserExecutionMessage(error.message)}`;
    }
    throw error;
  }
}

function validateAgentInputs(input: unknown): {
  agents?: any[];
  error?: string;
} {
  if (!Array.isArray(input)) {
    return { error: 'agents must be an array' };
  }

  if (input.length === 0) {
    return { error: 'at least one talk agent is required' };
  }
  if (input.length > MAX_TALK_AGENTS) {
    return { error: `at most ${MAX_TALK_AGENTS} talk agents are allowed` };
  }

  const normalized: any[] = [];
  let leadCount = 0;
  const ids = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index] as Record<string, unknown>;
    const role =
      typeof raw.role === 'string'
        ? (raw.role as TalkPersonaRole)
        : typeof raw.personaRole === 'string'
          ? (raw.personaRole as TalkPersonaRole)
          : null;
    const id =
      typeof raw.id === 'string' && raw.id.trim()
        ? raw.id.trim()
        : `agent_${randomUUID()}`;
    const isLead = raw.isPrimary === true || raw.isLead === true;
    const displayOrder =
      typeof raw.displayOrder === 'number'
        ? Math.max(0, Math.floor(raw.displayOrder))
        : typeof raw.sortOrder === 'number'
          ? Math.max(0, Math.floor(raw.sortOrder))
          : index;
    const sourceKind =
      raw.sourceKind === 'claude_default' || raw.sourceKind === 'provider'
        ? raw.sourceKind
        : null;
    const providerId =
      typeof raw.providerId === 'string' && raw.providerId.trim()
        ? raw.providerId.trim()
        : null;
    const modelId =
      typeof raw.modelId === 'string' && raw.modelId.trim()
        ? raw.modelId.trim()
        : null;
    const nickname =
      typeof raw.nickname === 'string' && raw.nickname.trim()
        ? raw.nickname.trim()
        : undefined;
    const nicknameMode =
      raw.nicknameMode === 'custom' || raw.nicknameMode === 'auto'
        ? raw.nicknameMode
        : undefined;

    if (
      !role ||
      ![
        'assistant',
        'analyst',
        'critic',
        'strategist',
        'devils-advocate',
        'synthesizer',
        'editor',
      ].includes(role)
    ) {
      return { error: 'each talk agent must have a valid role' };
    }
    if (!sourceKind) {
      return { error: 'each talk agent must have a valid source' };
    }
    if (!modelId) {
      return { error: 'each talk agent must have a model' };
    }
    if (sourceKind === 'provider' && !providerId) {
      return { error: 'provider talk agents must include a provider' };
    }
    if (ids.has(id)) return { error: 'talk agent ids must be unique' };
    ids.add(id);
    if (isLead) leadCount += 1;

    normalized.push({
      id,
      sourceKind,
      providerId,
      modelId,
      nickname,
      nicknameMode,
      role,
      isLead,
      displayOrder,
    });
  }

  if (leadCount !== 1) {
    return { error: 'exactly one talk agent must be marked lead' };
  }

  return { agents: normalized };
}

function listEffectiveTalkAgents(talkId: string): TalkAgentApiRecord[] {
  ensureTalkUsesUsableDefaultAgent(talkId);
  const rows = getTalkAgentRows(talkId);
  return rows.map((row) => ({
    // Use registeredAgentId as the canonical id when available.
    // This keeps the id consistent with what execution paths (send route,
    // resolvePrimaryAgent, listTalkAgents) expect — they all operate on
    // registered_agent_id. Fall back to the row id for unresolved agents.
    id: row.registeredAgentId || row.id,
    nickname: row.nickname || 'Agent',
    nicknameMode: row.nicknameMode,
    sourceKind: row.sourceKind,
    role: (row.personaRole || 'assistant') as TalkPersonaRole,
    isPrimary: row.isPrimary,
    displayOrder: row.sortOrder,
    health: 'ready' as const, // TODO: resolve real health from provider verification
    providerId: row.providerId,
    modelId: row.modelId,
    modelDisplayName: null, // resolved client-side from provider model list
  }));
}

export function listTalksRoute(input: {
  auth: AuthContext;
  limit?: number;
  offset?: number;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talks: TalkApiRecord[];
    page: { limit: number; offset: number; count: number };
  }>;
} {
  const page = normalizeTalkListPage({
    limit: input.limit,
    offset: input.offset,
  });
  const talks = listTalksForUser({
    userId: input.auth.userId,
    limit: page.limit,
    offset: page.offset,
  });

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talks: talks.map(toTalkApiRecord),
        page: {
          limit: page.limit,
          offset: page.offset,
          count: talks.length,
        },
      },
    },
  };
}

export function listTalkSidebarRoute(input: { auth: AuthContext }): {
  statusCode: number;
  body: ApiEnvelope<{ items: TalkSidebarItemApiRecord[] }>;
} {
  const tree = listTalkSidebarTreeForUser(input.auth.userId);
  const rootItems: TalkSidebarItemApiRecord[] = [
    ...tree.rootTalks.map((talk) => ({
      type: 'talk' as const,
      ...toSidebarTalkApiRecord(talk),
    })),
    ...tree.folders.map((folder) => ({
      type: 'folder' as const,
      id: folder.id,
      title: folder.title,
      sortOrder: folder.sort_order,
      talks: (tree.talksByFolderId[folder.id] || []).map((talk) =>
        toSidebarTalkApiRecord(talk),
      ),
    })),
  ].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        items: rootItems,
      },
    },
  };
}

export function createTalkFolderRoute(input: {
  auth: AuthContext;
  title?: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ folder: TalkFolderApiRecord }>;
} {
  const rawTitle = input.title?.trim() || '';
  if (rawTitle.length > 160) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_folder_title',
          message: 'Folder title must be 160 characters or less',
        },
      },
    };
  }

  const folder = createTalkFolder({
    id: `folder_${randomUUID()}`,
    ownerId: input.auth.userId,
    title: rawTitle || 'Untitled Folder',
  });

  return {
    statusCode: 201,
    body: {
      ok: true,
      data: {
        folder: {
          id: folder.id,
          title: folder.title,
          sortOrder: folder.sort_order,
          talks: [],
        },
      },
    },
  };
}

export function patchTalkFolderRoute(input: {
  auth: AuthContext;
  folderId: string;
  title?: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ folder: TalkFolderApiRecord }>;
} {
  const rawTitle = input.title?.trim() || '';
  if (!rawTitle) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_folder_title',
          message: 'Folder title is required',
        },
      },
    };
  }
  if (rawTitle.length > 160) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_folder_title',
          message: 'Folder title must be 160 characters or less',
        },
      },
    };
  }

  const folder = renameTalkFolder({
    id: input.folderId,
    ownerId: input.auth.userId,
    title: rawTitle,
  });
  if (!folder) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'folder_not_found',
          message: 'Folder not found',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        folder: {
          id: folder.id,
          title: folder.title,
          sortOrder: folder.sort_order,
          talks: [],
        },
      },
    },
  };
}

export function deleteTalkFolderRoute(input: {
  auth: AuthContext;
  folderId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  const deleted = deleteTalkFolderAndMoveTalksToTopLevel({
    id: input.folderId,
    ownerId: input.auth.userId,
  });
  if (!deleted) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'folder_not_found',
          message: 'Folder not found',
        },
      },
    };
  }
  return {
    statusCode: 200,
    body: { ok: true, data: { deleted: true } },
  };
}

export function createTalkRoute(input: { auth: AuthContext; title?: string }): {
  statusCode: number;
  body: ApiEnvelope<{ talk: TalkApiRecord }>;
} {
  const rawTitle = input.title?.trim() || '';
  if (rawTitle.length > 160) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_talk_title',
          message: 'Talk title must be 160 characters or less',
        },
      },
    };
  }

  const talkId = `talk_${randomUUID()}`;
  const title = rawTitle || 'Untitled Talk';
  createTalk({
    id: talkId,
    ownerId: input.auth.userId,
    topicTitle: title,
    status: 'active',
  });

  // Auto-assign the default Talk agent so the talk is immediately usable even
  // on installs that do not have a registered container runtime yet.
  try {
    const defaultTalkAgentId = getDefaultTalkAgentId();
    setTalkAgents(talkId, [
      {
        id: defaultTalkAgentId,
        sourceKind: 'claude_default',
        providerId: null,
        modelId: 'default',
        nickname: null,
        nicknameMode: 'auto',
        personaRole: 'assistant',
        isPrimary: true,
        sortOrder: 0,
      },
    ]);
  } catch {
    // If main agent isn't configured yet, create the talk without agents.
    // The user can assign one later via the talk settings.
  }

  const talk = getTalkForUser(talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'talk_create_failed',
          message: 'Talk created but failed to load persisted record',
        },
      },
    };
  }

  return {
    statusCode: 201,
    body: {
      ok: true,
      data: {
        talk: toTalkApiRecord(talk),
      },
    },
  };
}

export function patchTalkRoute(input: {
  auth: AuthContext;
  talkId: string;
  title?: string;
  folderId?: string | null;
  orchestrationMode?: 'ordered' | 'panel';
}): {
  statusCode: number;
  body: ApiEnvelope<{ talk: TalkApiRecord }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'talk_not_found', message: 'Talk not found' },
      },
    };
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Talk is read-only' },
      },
    };
  }

  const rawTitle = input.title?.trim();
  if (rawTitle !== undefined && rawTitle.length === 0) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_talk_title',
          message: 'Talk title is required',
        },
      },
    };
  }
  if (rawTitle && rawTitle.length > 160) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_talk_title',
          message: 'Talk title must be 160 characters or less',
        },
      },
    };
  }
  if (
    input.orchestrationMode !== undefined &&
    input.orchestrationMode !== 'ordered' &&
    input.orchestrationMode !== 'panel'
  ) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_orchestration_mode',
          message: 'Orchestration mode must be ordered or panel',
        },
      },
    };
  }

  const updated = patchTalkMetadata({
    talkId: input.talkId,
    ownerId: talk.owner_id,
    title: rawTitle,
    folderId: input.folderId,
    orchestrationMode: input.orchestrationMode,
  });
  const reloaded = updated
    ? getTalkForUser(updated.id, input.auth.userId)
    : undefined;
  if (!reloaded) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'talk_not_found', message: 'Talk not found' },
      },
    };
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talk: toTalkApiRecord(reloaded),
      },
    },
  };
}

export function deleteTalkRoute(input: { auth: AuthContext; talkId: string }): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'talk_not_found', message: 'Talk not found' },
      },
    };
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Talk is read-only' },
      },
    };
  }
  const deleted = deleteTalkForOwner({
    talkId: input.talkId,
    ownerId: talk.owner_id,
  });
  if (!deleted) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'talk_not_found', message: 'Talk not found' },
      },
    };
  }
  return {
    statusCode: 200,
    body: { ok: true, data: { deleted: true } },
  };
}

export function getTalkProjectMountRoute(input: {
  auth: AuthContext;
  talkId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ talk: TalkApiRecord }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'talk_not_found', message: 'Talk not found' },
      },
    };
  }
  if (!canManageTalkProjectMount(talk, input.auth)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message:
            'Only the talk owner or an admin can manage the project mount',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talk: toTalkApiRecord(talk),
      },
    },
  };
}

export function updateTalkProjectMountRoute(input: {
  auth: AuthContext;
  talkId: string;
  projectPath: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ talk: TalkApiRecord }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'talk_not_found', message: 'Talk not found' },
      },
    };
  }
  if (!canManageTalkProjectMount(talk, input.auth)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message:
            'Only the talk owner or an admin can manage the project mount',
        },
      },
    };
  }

  const validated = validateTalkProjectPath(input.projectPath);
  if (!validated.projectPath) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: validated.error || {
          code: 'invalid_project_path',
          message: 'Project path is invalid',
        },
      },
    };
  }

  const updated = updateTalkProjectPath({
    talkId: input.talkId,
    ownerId: talk.owner_id,
    projectPath: validated.projectPath,
  });
  const reloaded = updated
    ? getTalkForUser(updated.id, input.auth.userId)
    : undefined;
  if (!reloaded) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'talk_not_found', message: 'Talk not found' },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talk: toTalkApiRecord(reloaded),
      },
    },
  };
}

export function clearTalkProjectMountRoute(input: {
  auth: AuthContext;
  talkId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ talk: TalkApiRecord }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'talk_not_found', message: 'Talk not found' },
      },
    };
  }
  if (!canManageTalkProjectMount(talk, input.auth)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message:
            'Only the talk owner or an admin can manage the project mount',
        },
      },
    };
  }

  const updated = updateTalkProjectPath({
    talkId: input.talkId,
    ownerId: talk.owner_id,
    projectPath: null,
  });
  const reloaded = updated
    ? getTalkForUser(updated.id, input.auth.userId)
    : undefined;
  if (!reloaded) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'talk_not_found', message: 'Talk not found' },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talk: toTalkApiRecord(reloaded),
      },
    },
  };
}

export function reorderTalkSidebarRoute(input: {
  auth: AuthContext;
  itemType: 'talk' | 'folder';
  itemId: string;
  destinationFolderId: string | null;
  destinationIndex: number;
}): {
  statusCode: number;
  body: ApiEnvelope<{ reordered: true }>;
} {
  const destinationIndex = Math.max(0, Math.floor(input.destinationIndex));
  let ownerId = input.auth.userId;
  if (input.itemType === 'talk') {
    const talk = getTalkForUser(input.itemId, input.auth.userId);
    if (!talk) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: { code: 'talk_not_found', message: 'Talk not found' },
        },
      };
    }
    if (!canEditTalk(talk.id, input.auth.userId, input.auth.role)) {
      return {
        statusCode: 403,
        body: {
          ok: false,
          error: { code: 'forbidden', message: 'Talk is read-only' },
        },
      };
    }
    ownerId = talk.owner_id;
  }

  if (
    input.destinationFolderId !== null &&
    !listTalkFoldersForOwner(ownerId).some(
      (folder) => folder.id === input.destinationFolderId,
    )
  ) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'folder_not_found', message: 'Folder not found' },
      },
    };
  }

  const reordered = reorderTalkSidebarItem({
    ownerId,
    itemType: input.itemType,
    itemId: input.itemId,
    destinationFolderId: input.destinationFolderId,
    destinationIndex,
  });
  if (!reordered) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_reorder',
          message: 'Reorder target is not valid',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: { ok: true, data: { reordered: true } },
  };
}

export function getTalkRoute(input: { talkId: string; auth: AuthContext }): {
  statusCode: number;
  body: ApiEnvelope<{ talk: TalkApiRecord }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  ensureTalkUsesUsableDefaultAgent(input.talkId);

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talk: toTalkApiRecord(talk),
      },
    },
  };
}

export function listTalkAgentsRoute(input: {
  talkId: string;
  auth: AuthContext;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    agents: TalkAgentApiRecord[];
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  ensureTalkUsesUsableDefaultAgent(input.talkId);

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        agents: listEffectiveTalkAgents(input.talkId),
      },
    },
  };
}

export function updateTalkAgentsRoute(input: {
  talkId: string;
  auth: AuthContext;
  agents: unknown;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    agents: TalkAgentApiRecord[];
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to edit talk agents',
        },
      },
    };
  }

  const normalized = validateAgentInputs(input.agents);
  if (!normalized.agents) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_talk_agents',
          message: normalized.error || 'talk agents are invalid',
        },
      },
    };
  }

  // Persist: full replace of talk_agents for this Talk.
  const agentInputs: TalkAgentInput[] = normalized.agents!.map((a: any) => ({
    id: a.id,
    sourceKind: a.sourceKind,
    providerId: a.providerId,
    modelId: a.modelId,
    nickname: a.nickname || null,
    nicknameMode: a.nicknameMode || 'auto',
    personaRole: a.role,
    isPrimary: a.isLead,
    sortOrder: a.displayOrder,
  }));

  try {
    setTalkAgents(input.talkId, agentInputs);
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'talk_agents_save_failed',
          message:
            err instanceof Error ? err.message : 'Failed to save talk agents',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        agents: listEffectiveTalkAgents(input.talkId),
      },
    },
  };
}

export function getTalkPolicyRoute(input: {
  talkId: string;
  auth: AuthContext;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    agents: string[];
    limits: { maxAgents: number; maxAgentChars: number };
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        agents: parseFallbackPolicyAgents(talk.llm_policy),
        limits: {
          maxAgents: MAX_TALK_AGENTS,
          maxAgentChars: MAX_TALK_AGENT_NAME_CHARS,
        },
      },
    },
  };
}

export function updateTalkPolicyRoute(input: {
  talkId: string;
  auth: AuthContext;
  agents: unknown;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    agents: string[];
    limits: { maxAgents: number; maxAgentChars: number };
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to edit talk agents',
        },
      },
    };
  }

  if (!Array.isArray(input.agents)) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_agents',
          message: 'agents must be an array of strings',
        },
      },
    };
  }

  const normalizedNames = [
    ...new Set(
      input.agents
        .map((entry: any) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean),
    ),
  ];

  if (normalizedNames.length === 0) {
    deleteTalkLlmPolicy(input.talkId);
    const effectiveAgents = listEffectiveTalkAgents(input.talkId);
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          talkId: input.talkId,
          agents: effectiveAgents.map((a) => a.nickname),
          limits: {
            maxAgents: MAX_TALK_AGENTS,
            maxAgentChars: MAX_TALK_AGENT_NAME_CHARS,
          },
        },
      },
    };
  }

  if (normalizedNames.length > MAX_TALK_AGENTS) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_agents',
          message: `at most ${MAX_TALK_AGENTS} agents are allowed`,
        },
      },
    };
  }

  // Legacy compatibility only: typed talk_agents are the execution source of truth,
  // but we still mirror the simple names list for older policy readers.
  upsertTalkLlmPolicy({
    talkId: input.talkId,
    llmPolicy: JSON.stringify({ agents: normalizedNames }),
  });

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        agents: normalizedNames,
        limits: {
          maxAgents: MAX_TALK_AGENTS,
          maxAgentChars: MAX_TALK_AGENT_NAME_CHARS,
        },
      },
    },
  };
}

export function listTalkMessagesRoute(input: {
  talkId: string;
  auth: AuthContext;
  threadId?: string | null;
  limit?: number;
  beforeCreatedAt?: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    messages: TalkMessageApiRecord[];
    page: { limit: number; count: number; beforeCreatedAt: string | null };
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  const limit =
    typeof input.limit === 'number'
      ? Math.min(200, Math.max(1, Math.floor(input.limit)))
      : 100;
  const beforeCreatedAt = input.beforeCreatedAt || null;
  let threadId: string | null = null;
  if (input.threadId) {
    try {
      threadId = resolveThreadIdForTalk(input.talkId, input.threadId);
    } catch (error) {
      if (error instanceof TalkThreadValidationError) {
        return {
          statusCode: 400,
          body: {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
            },
          },
        };
      }
      throw error;
    }
  }
  const messages = listTalkMessages({
    talkId: input.talkId,
    threadId,
    limit,
    beforeCreatedAt: beforeCreatedAt || undefined,
  });

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        messages: messages.map(toTalkMessageApiRecord),
        page: {
          limit,
          count: messages.length,
          beforeCreatedAt,
        },
      },
    },
  };
}

export function deleteTalkMessagesRoute(input: {
  talkId: string;
  auth: AuthContext;
  messageIds: string[];
  threadId: string | null;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    deletedCount: number;
    deletedMessageIds: string[];
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Talk is read-only' },
      },
    };
  }

  const normalizedIds = Array.from(
    new Set(
      input.messageIds
        .map((messageId) => messageId.trim())
        .filter((messageId) => messageId.length > 0),
    ),
  );
  if (normalizedIds.length === 0) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_message_ids',
          message: 'Select at least one message to delete.',
        },
      },
    };
  }
  if (normalizedIds.length > 200) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'too_many_message_ids',
          message: 'Delete at most 200 messages at a time.',
        },
      },
    };
  }

  if (!input.threadId || input.threadId.trim().length === 0) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'thread_not_found',
          message: 'Thread not found for this talk.',
        },
      },
    };
  }

  let threadId: string;
  try {
    threadId = resolveThreadIdForTalk(input.talkId, input.threadId);
  } catch (error) {
    if (error instanceof TalkThreadValidationError) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
          },
        },
      };
    }
    throw error;
  }

  try {
    const deleted = deleteTalkMessagesAtomic({
      talkId: input.talkId,
      messageIds: normalizedIds,
      threadId,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          talkId: input.talkId,
          deletedCount: deleted.deletedCount,
          deletedMessageIds: deleted.deletedMessageIds,
        },
      },
    };
  } catch (error) {
    if (error instanceof TalkActiveRoundError && error.scope === 'thread') {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'thread_active_round',
            message:
              'Wait for the current round to finish or cancel it before editing history.',
          },
        },
      };
    }
    const message =
      error instanceof Error ? error.message : 'Unable to edit talk history';
    if (message === 'one or more talk messages were not found') {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'message_not_found',
            message: 'One or more selected messages no longer exist.',
          },
        },
      };
    }
    if (message === 'system messages cannot be deleted') {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_message_role',
            message: 'System messages cannot be deleted.',
          },
        },
      };
    }
    if (message === 'selected messages do not belong to the requested thread') {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'thread_mismatch',
            message: 'Selected messages do not belong to the requested thread.',
          },
        },
      };
    }
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'talk_history_edit_failed',
          message,
        },
      },
    };
  }
}

export function enqueueTalkChat(input: {
  talkId: string;
  threadId?: string | null;
  auth: AuthContext;
  content: string;
  targetAgentIds?: string[] | null;
  attachmentIds?: string[] | null;
  idempotencyKey?: string | null;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    message: TalkMessageApiRecord;
    runs: Array<{
      id: string;
      responseGroupId: string | null;
      sequenceIndex: number | null;
      status:
        | 'queued'
        | 'running'
        | 'awaiting_confirmation'
        | 'cancelled'
        | 'completed'
        | 'failed';
      createdAt: string;
      startedAt: string | null;
      completedAt: string | null;
      triggerMessageId: string | null;
      targetAgentId: string | null;
      targetAgentNickname: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      cancelReason: string | null;
      executorAlias: string | null;
      executorModel: string | null;
    }>;
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to post messages to this talk',
        },
      },
    };
  }

  const content = input.content.trim();
  if (!content) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'message_required',
          message: 'Message content is required',
        },
      },
    };
  }
  if (content.length > 20_000) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'message_too_large',
          message: 'Message content exceeds 20000 characters',
        },
      },
    };
  }

  const requestedTargetIds = Array.isArray(input.targetAgentIds)
    ? [
        ...new Set(
          input.targetAgentIds.map((id: any) => id.trim()).filter(Boolean),
        ),
      ]
    : [];
  ensureTalkUsesUsableDefaultAgent(input.talkId);
  const talkAgents = listTalkAgents(input.talkId);
  const mentionedAgents = resolveTalkAgentMentions(input.talkId, content);
  const selectedAgents: Array<{ id: string; nickname: string }> =
    mentionedAgents.length > 0
      ? mentionedAgents.map((agent) => ({
          id: agent.agentId,
          nickname: agent.nickname || agent.agentName,
        }))
      : requestedTargetIds.length > 0
        ? talkAgents
            .filter((a) => requestedTargetIds.includes(a.agentId))
            .map((a) => ({
              id: a.agentId,
              nickname: a.nickname || a.agentName,
            }))
        : talkAgents.map((a) => ({
            id: a.agentId,
            nickname: a.nickname || a.agentName,
          }));
  const orderedRunSet =
    talk.orchestration_mode === 'ordered' && selectedAgents.length > 1;

  if (selectedAgents.length === 0) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'talk_agent_not_found',
          message: 'No valid talk agent is available for this talk',
        },
      },
    };
  }

  for (const agent of selectedAgents) {
    const browserPreflightError = getBrowserPreflightErrorForAgent(
      agent.id,
      input.auth.userId,
    );
    if (browserPreflightError) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'browser_execution_not_configured',
            message: browserPreflightError,
          },
        },
      };
    }
  }

  const messageId = `msg_${randomUUID()}`;
  const runIds = selectedAgents.map(() => `run_${randomUUID()}`);
  const responseGroupId = `group_${randomUUID()}`;
  let persisted: ReturnType<typeof enqueueTalkTurnAtomic>;
  try {
    // Attachment validation and linking happen inside the same SQLite
    // transaction as message/run creation. If any attachment ID is invalid,
    // already linked, or exceeds the cap, the transaction rolls back — no
    // orphaned messages or runs are left behind.
    persisted = enqueueTalkTurnAtomic({
      talkId: input.talkId,
      threadId: input.threadId,
      userId: input.auth.userId,
      content,
      messageId,
      runIds,
      targetAgentIds: selectedAgents.map((agent) => agent.id),
      responseGroupId,
      sequenceIndexes: orderedRunSet
        ? selectedAgents.map((_, index) => index)
        : selectedAgents.map(() => null),
      attachmentIds:
        Array.isArray(input.attachmentIds) && input.attachmentIds.length > 0
          ? input.attachmentIds
          : undefined,
      maxAttachmentsPerMessage: MAX_ATTACHMENTS_PER_MESSAGE,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    if (error instanceof TalkActiveRoundError && error.scope === 'thread') {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'talk_round_active',
            message:
              'Wait for the current round in this thread to finish or cancel it before sending another message',
          },
        },
      };
    }
    if (error instanceof TalkThreadValidationError) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
          },
        },
      };
    }
    if (error instanceof AttachmentValidationError) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
          },
        },
      };
    }
    throw error;
  }

  const agentNicknameById = new Map(
    selectedAgents.map((agent) => [agent.id, agent.nickname]),
  );

  return {
    statusCode: 202,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        message: toTalkMessageApiRecord(persisted.message),
        runs: persisted.runs.map((run) => ({
          id: run.id,
          threadId: run.thread_id,
          responseGroupId: run.response_group_id || null,
          sequenceIndex: run.sequence_index ?? null,
          status: run.status,
          createdAt: run.created_at,
          startedAt: run.started_at,
          completedAt: run.ended_at,
          triggerMessageId: run.trigger_message_id,
          targetAgentId: run.target_agent_id || null,
          targetAgentNickname:
            (run.target_agent_id &&
              agentNicknameById.get(run.target_agent_id)) ||
            null,
          errorCode: null,
          errorMessage: null,
          cancelReason: run.cancel_reason,
          executorAlias: run.executor_alias,
          executorModel: run.executor_model,
        })),
      },
    },
  };
}

export function searchTalkMessagesRoute(input: {
  talkId: string;
  auth: AuthContext;
  query: string;
  limit?: number;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    query: string;
    results: TalkMessageSearchResultApiRecord[];
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  const query = input.query.trim();
  if (query.length === 0) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_query',
          message: 'Search query is required.',
        },
      },
    };
  }

  const limit =
    typeof input.limit === 'number'
      ? Math.min(50, Math.max(1, Math.floor(input.limit)))
      : 20;
  const results = searchTalkMessages({
    talkId: input.talkId,
    query,
    limit,
  }).map((row) => ({
    messageId: row.id,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    role: row.role,
    createdAt: row.created_at,
    preview: buildMessagePreview(row.content),
  }));

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        query,
        results,
      },
    },
  };
}

function toTalkRunApiRecord(
  run: ReturnType<typeof listTalkRunsForTalk>[number],
): TalkRunApiRecord {
  const parsedError = parseTalkRunError(run);
  const metadata = parseRunMetadata(run.metadata_json);
  const responseMetadata = parseRunResponseMetadata(run.metadata_json);
  return {
    id: run.id,
    threadId: run.thread_id,
    responseGroupId: run.response_group_id || null,
    sequenceIndex: run.sequence_index ?? null,
    status: run.status,
    createdAt: run.created_at,
    startedAt: run.started_at,
    completedAt: run.ended_at,
    triggerMessageId: run.trigger_message_id,
    targetAgentId: run.target_agent_id || null,
    targetAgentNickname: run.target_agent_nickname,
    errorCode: parsedError.errorCode,
    errorMessage: parsedError.errorMessage,
    cancelReason: run.cancel_reason,
    executorAlias: run.executor_alias,
    executorModel: run.executor_model,
    browserBlock: parseRunMetadataObject<BrowserBlockMetadata>(
      metadata.browserBlock,
    ),
    browserResume: parseRunMetadataObject<BrowserResumeMetadata>(
      metadata.browserResume,
    ),
    carriedBrowserSessions: Array.isArray(metadata.carriedBrowserSessions)
      ? metadata.carriedBrowserSessions.filter(
          (entry): entry is CarriedBrowserSessionMetadata =>
            Boolean(entry) &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            typeof (entry as { sessionId?: unknown }).sessionId === 'string' &&
            typeof (entry as { siteKey?: unknown }).siteKey === 'string',
        )
      : [],
    executionDecision: parseRunMetadataObject<ExecutionDecisionMetadata>(
      metadata.executionDecision,
    ),
    completionStatus: responseMetadata.completionStatus,
    providerStopReason: responseMetadata.providerStopReason,
    incompleteReason: responseMetadata.incompleteReason,
  };
}

export function listTalkRunsRoute(input: {
  talkId: string;
  auth: AuthContext;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    runs: TalkRunApiRecord[];
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        runs: listTalkRunsForTalk(input.talkId, 50).map(toTalkRunApiRecord),
      },
    },
  };
}

export function getTalkRunContextRoute(input: {
  talkId: string;
  runId: string;
  auth: AuthContext;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    runId: string;
    contextSnapshot: TalkRunContextSnapshot | null;
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  const run = getTalkRunById(input.runId);
  if (!run || run.talk_id !== input.talkId) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'run_not_found',
          message: 'Run not found',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        runId: input.runId,
        contextSnapshot: parseTalkRunContextSnapshot(run.metadata_json),
      },
    },
  };
}

export function cancelTalkChat(input: {
  talkId: string;
  threadId?: string | null;
  auth: AuthContext;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    threadId?: string | null;
    cancelledRuns: number;
  }>;
  cancelledRunning: boolean;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
      cancelledRunning: false,
    };
  }

  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to cancel runs for this talk',
        },
      },
      cancelledRunning: false,
    };
  }

  try {
    const cancellation = cancelTalkRunsAtomic({
      talkId: input.talkId,
      threadId: input.threadId,
      cancelledBy: input.auth.userId,
    });

    if (cancellation.cancelledRuns === 0) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'no_active_run',
            message: input.threadId
              ? 'No running or queued chat exists for this thread'
              : 'No running or queued chat exists for this talk',
          },
        },
        cancelledRunning: false,
      };
    }

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          talkId: input.talkId,
          threadId: input.threadId ?? null,
          cancelledRuns: cancellation.cancelledRuns,
        },
      },
      cancelledRunning: cancellation.cancelledRunning,
    };
  } catch (error) {
    if (error instanceof TalkThreadValidationError) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
          },
        },
        cancelledRunning: false,
      };
    }
    throw error;
  }
}
