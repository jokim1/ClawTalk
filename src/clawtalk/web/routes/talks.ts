import { randomUUID } from 'crypto';

import { getDbPg, withUserContext } from '../../../db.js';
function getContainerRuntimeStatus(): 'ready' | 'unavailable' {
  return 'unavailable';
}
import {
  AttachmentValidationError,
  TalkActiveRoundError,
  TalkThreadValidationError,
  cancelTalkRunsAtomic,
  createTalk,
  createTalkFolder,
  deleteTalkFolderAndMoveTalksToTopLevel,
  deleteTalkForOwner,
  deleteTalkMessagesAtomic,
  enqueueTalkTurnAtomic,
  getTalkById,
  getTalkForUser,
  getTalkRunById,
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
  updateTalkProjectPath,
  type TalkMessageRecord,
  type TalkRunRecord,
  type TalkSidebarTalkRecord,
  type TalkWithAccessRecord,
} from '../../db/accessors.js';
import { listMessageAttachments } from '../../db/context-accessors.js';
import type { TalkPersonaRole } from '../../llm/types.js';
import type { TalkRunContextSnapshot } from '../../talks/context-loader.js';
type BrowserBlockMetadata = Record<string, unknown>;
type BrowserResumeMetadata = Record<string, unknown>;
type CarriedBrowserSessionMetadata = Record<string, unknown>;
type ExecutionDecisionMetadata = Record<string, unknown>;
type MountValidationResult =
  | { allowed: true; realHostPath: string; reason?: never }
  | { allowed: false; reason: string; realHostPath?: never };
function validateMount(
  _mount: { hostPath: string; readonly?: boolean },
  _opts?: unknown,
): MountValidationResult {
  return {
    allowed: false,
    reason: 'Mount validation is disabled (chassis removed).',
  };
}
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
  metadataJson: Record<string, unknown> | null | undefined,
): TalkRunContextSnapshot | null {
  if (!metadataJson || typeof metadataJson !== 'object') return null;
  return (metadataJson as { version?: unknown }).version === 1
    ? (metadataJson as unknown as TalkRunContextSnapshot)
    : null;
}

function parseRunMetadataObject<T>(value: unknown): T | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as T;
}

function parseRunMetadata(
  metadataJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (
    !metadataJson ||
    typeof metadataJson !== 'object' ||
    Array.isArray(metadataJson)
  ) {
    return {};
  }
  return metadataJson;
}

function parseRunResponseMetadata(
  metadataJson: Record<string, unknown> | null | undefined,
): {
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
const MAX_TALK_AGENTS = 12;
const MAX_TALK_AGENT_NAME_CHARS = 80;

async function toTalkApiRecord(
  talk: TalkWithAccessRecord,
  ownerId: string,
): Promise<TalkApiRecord> {
  const effectiveAgents = await listEffectiveTalkAgents(talk.id, ownerId);
  const agents = effectiveAgents.map((a) => a.nickname);
  const canManageProjectPath = talk.access_role === 'owner';
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
  run: Pick<TalkRunRecord, 'status' | 'cancel_reason'>,
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

async function toTalkMessageApiRecord(
  message: TalkMessageRecord,
): Promise<TalkMessageApiRecord> {
  let agentId: string | null | undefined;
  let agentNickname: string | null | undefined;
  let metadata: Record<string, unknown> | null = null;
  if (
    message.metadata_json &&
    typeof message.metadata_json === 'object' &&
    !Array.isArray(message.metadata_json)
  ) {
    metadata = message.metadata_json;
    const parsed = message.metadata_json as {
      agentId?: unknown;
      agentNickname?: unknown;
      agentName?: unknown;
    };
    if (typeof parsed.agentId === 'string') agentId = parsed.agentId;
    if (typeof parsed.agentNickname === 'string') {
      agentNickname = parsed.agentNickname;
    } else if (typeof parsed.agentName === 'string') {
      agentNickname = parsed.agentName;
    }
  }
  if ((!agentId || !agentNickname) && message.run_id) {
    const db = getDbPg();
    const fallbackRows = await db<
      Array<{ agent_id: string | null; agent_nickname: string | null }>
    >`
      select
        r.target_agent_id as agent_id,
        coalesce(
          (
            select ta.nickname
            from public.talk_agents ta
            where ta.talk_id = r.talk_id
              and ta.registered_agent_id = r.target_agent_id
            order by ta.sort_order asc, ta.created_at asc
            limit 1
          ),
          ra.name
        ) as agent_nickname
      from public.talk_runs r
      left join public.registered_agents ra on ra.id = r.target_agent_id
      where r.id = ${message.run_id}::uuid
      limit 1
    `;
    const fallback = fallbackRows[0];
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
  const attachmentRows = await listMessageAttachments(message.id);
  const attachments: TalkMessageAttachmentApi[] | undefined =
    attachmentRows.length > 0
      ? attachmentRows.map((a) => ({
          id: a.id,
          fileName: a.fileName,
          fileSize: a.fileSize ?? 0,
          mimeType: a.mimeType ?? 'application/octet-stream',
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

async function getBrowserPreflightErrorForAgent(
  agentId: string,
  userId: string,
): Promise<string | null> {
  const agent = await getRegisteredAgent(agentId);
  if (!agent) return null;

  const effectiveTools = await getEffectiveToolsForAgent(agent.id);
  const browserEnabled = effectiveTools.some(
    (tool) => tool.toolFamily === 'browser' && tool.enabled,
  );
  if (!browserEnabled) return null;

  try {
    const plan = await planExecution(agent, userId);
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
        : randomUUID();
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

async function listEffectiveTalkAgents(
  talkId: string,
  ownerId: string,
): Promise<TalkAgentApiRecord[]> {
  await ensureTalkUsesUsableDefaultAgent(talkId, ownerId);
  const rows = await getTalkAgentRows(talkId);
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

export async function listTalksRoute(input: {
  auth: AuthContext;
  limit?: number;
  offset?: number;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    talks: TalkApiRecord[];
    page: { limit: number; offset: number; count: number };
  }>;
}> {
  const page = normalizeTalkListPage({
    limit: input.limit,
    offset: input.offset,
  });
  return await withUserContext(input.auth.userId, async () => {
    const talks = await listTalksForUser({
      limit: page.limit,
      offset: page.offset,
    });
    const apiRecords = await Promise.all(
      talks.map((talk) => toTalkApiRecord(talk, input.auth.userId)),
    );

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          talks: apiRecords,
          page: {
            limit: page.limit,
            offset: page.offset,
            count: talks.length,
          },
        },
      },
    };
  });
}

export async function listTalkSidebarRoute(input: {
  auth: AuthContext;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ items: TalkSidebarItemApiRecord[] }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const tree = await listTalkSidebarTreeForUser();
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
  });
}

export async function createTalkFolderRoute(input: {
  auth: AuthContext;
  title?: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ folder: TalkFolderApiRecord }>;
}> {
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

  return await withUserContext(input.auth.userId, async () => {
    const folder = await createTalkFolder({
      id: randomUUID(),
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
  });
}

export async function patchTalkFolderRoute(input: {
  auth: AuthContext;
  folderId: string;
  title?: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ folder: TalkFolderApiRecord }>;
}> {
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

  return await withUserContext(input.auth.userId, async () => {
    const folder = await renameTalkFolder({
      id: input.folderId,
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
  });
}

export async function deleteTalkFolderRoute(input: {
  auth: AuthContext;
  folderId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const deleted = await deleteTalkFolderAndMoveTalksToTopLevel({
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
  });
}

export async function createTalkRoute(input: {
  auth: AuthContext;
  title?: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ talk: TalkApiRecord }>;
}> {
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

  const talkId = randomUUID();
  const title = rawTitle || 'Untitled Talk';
  return await withUserContext(input.auth.userId, async () => {
    await createTalk({
      id: talkId,
      ownerId: input.auth.userId,
      topicTitle: title,
      status: 'active',
    });

    // Auto-assign the default Talk agent so the talk is immediately usable even
    // on installs that do not have a registered container runtime yet.
    try {
      const defaultTalkAgentId = await getDefaultTalkAgentId();
      await setTalkAgents({
        talkId,
        ownerId: input.auth.userId,
        agents: [
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
        ],
      });
    } catch {
      // If main agent isn't configured yet, create the talk without agents.
      // The user can assign one later via the talk settings.
    }

    const talk = await getTalkForUser(talkId);
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
          talk: await toTalkApiRecord(talk, input.auth.userId),
        },
      },
    };
  });
}

export async function patchTalkRoute(input: {
  auth: AuthContext;
  talkId: string;
  title?: string;
  folderId?: string | null;
  orchestrationMode?: 'ordered' | 'panel';
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ talk: TalkApiRecord }>;
}> {
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

  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: { code: 'talk_not_found', message: 'Talk not found' },
        },
      };
    }
    if (!(await canEditTalk(input.talkId))) {
      return {
        statusCode: 403,
        body: {
          ok: false,
          error: { code: 'forbidden', message: 'Talk is read-only' },
        },
      };
    }

    const updated = await patchTalkMetadata({
      talkId: input.talkId,
      ownerId: talk.owner_id,
      title: rawTitle,
      folderId: input.folderId,
      orchestrationMode: input.orchestrationMode,
    });
    const reloaded = updated ? await getTalkForUser(updated.id) : undefined;
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
          talk: await toTalkApiRecord(reloaded, input.auth.userId),
        },
      },
    };
  });
}

export async function deleteTalkRoute(input: {
  auth: AuthContext;
  talkId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
    if (!talk) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: { code: 'talk_not_found', message: 'Talk not found' },
        },
      };
    }
    if (!(await canEditTalk(input.talkId))) {
      return {
        statusCode: 403,
        body: {
          ok: false,
          error: { code: 'forbidden', message: 'Talk is read-only' },
        },
      };
    }
    const deleted = await deleteTalkForOwner({
      talkId: input.talkId,
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
  });
}

export async function getTalkProjectMountRoute(input: {
  auth: AuthContext;
  talkId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ talk: TalkApiRecord }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
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
          talk: await toTalkApiRecord(talk, input.auth.userId),
        },
      },
    };
  });
}

export async function updateTalkProjectMountRoute(input: {
  auth: AuthContext;
  talkId: string;
  projectPath: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ talk: TalkApiRecord }>;
}> {
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

  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
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

    const updated = await updateTalkProjectPath({
      talkId: input.talkId,
      projectPath: validated.projectPath!,
    });
    const reloaded = updated ? await getTalkForUser(updated.id) : undefined;
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
          talk: await toTalkApiRecord(reloaded, input.auth.userId),
        },
      },
    };
  });
}

export async function clearTalkProjectMountRoute(input: {
  auth: AuthContext;
  talkId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ talk: TalkApiRecord }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
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

    const updated = await updateTalkProjectPath({
      talkId: input.talkId,
      projectPath: null,
    });
    const reloaded = updated ? await getTalkForUser(updated.id) : undefined;
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
          talk: await toTalkApiRecord(reloaded, input.auth.userId),
        },
      },
    };
  });
}

export async function reorderTalkSidebarRoute(input: {
  auth: AuthContext;
  itemType: 'talk' | 'folder';
  itemId: string;
  destinationFolderId: string | null;
  destinationIndex: number;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ reordered: true }>;
}> {
  const destinationIndex = Math.max(0, Math.floor(input.destinationIndex));
  return await withUserContext(input.auth.userId, async () => {
    if (input.itemType === 'talk') {
      const talk = await getTalkForUser(input.itemId);
      if (!talk) {
        return {
          statusCode: 404,
          body: {
            ok: false,
            error: { code: 'talk_not_found', message: 'Talk not found' },
          },
        };
      }
      if (!(await canEditTalk(talk.id))) {
        return {
          statusCode: 403,
          body: {
            ok: false,
            error: { code: 'forbidden', message: 'Talk is read-only' },
          },
        };
      }
    }

    if (input.destinationFolderId !== null) {
      const folders = await listTalkFoldersForOwner();
      if (!folders.some((folder) => folder.id === input.destinationFolderId)) {
        return {
          statusCode: 404,
          body: {
            ok: false,
            error: { code: 'folder_not_found', message: 'Folder not found' },
          },
        };
      }
    }

    const reordered = await reorderTalkSidebarItem({
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
  });
}

export async function getTalkRoute(input: {
  talkId: string;
  auth: AuthContext;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ talk: TalkApiRecord }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
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

    await ensureTalkUsesUsableDefaultAgent(input.talkId, talk.owner_id);

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          talk: await toTalkApiRecord(talk, input.auth.userId),
        },
      },
    };
  });
}

export async function listTalkAgentsRoute(input: {
  talkId: string;
  auth: AuthContext;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    agents: TalkAgentApiRecord[];
  }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
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

    await ensureTalkUsesUsableDefaultAgent(input.talkId, talk.owner_id);

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          talkId: input.talkId,
          agents: await listEffectiveTalkAgents(input.talkId, talk.owner_id),
        },
      },
    };
  });
}

export async function updateTalkAgentsRoute(input: {
  talkId: string;
  auth: AuthContext;
  agents: unknown;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    agents: TalkAgentApiRecord[];
  }>;
}> {
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

  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
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

    if (!(await canEditTalk(input.talkId))) {
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
      await setTalkAgents({
        talkId: input.talkId,
        ownerId: talk.owner_id,
        agents: agentInputs,
      });
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
          agents: await listEffectiveTalkAgents(input.talkId, talk.owner_id),
        },
      },
    };
  });
}

export async function getTalkPolicyRoute(input: {
  talkId: string;
  auth: AuthContext;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    agents: string[];
    limits: { maxAgents: number; maxAgentChars: number };
  }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
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

    // talk_llm_policies is chassis-removed; derive the legacy agents list
    // from the typed talk_agents assignment instead.
    const effectiveAgents = await listEffectiveTalkAgents(
      input.talkId,
      talk.owner_id,
    );

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
  });
}

export async function updateTalkPolicyRoute(input: {
  talkId: string;
  auth: AuthContext;
  agents: unknown;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    agents: string[];
    limits: { maxAgents: number; maxAgentChars: number };
  }>;
}> {
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

  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
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

    if (!(await canEditTalk(input.talkId))) {
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

    // talk_llm_policies is chassis-removed; the typed talk_agents table is
    // the execution source of truth. This legacy endpoint now just echoes
    // the normalized names back so older clients keep functioning, but no
    // persistent policy mirror is written.
    if (normalizedNames.length === 0) {
      const effectiveAgents = await listEffectiveTalkAgents(
        input.talkId,
        talk.owner_id,
      );
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
  });
}

export async function listTalkMessagesRoute(input: {
  talkId: string;
  auth: AuthContext;
  threadId?: string | null;
  limit?: number;
  beforeCreatedAt?: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    messages: TalkMessageApiRecord[];
    page: { limit: number; count: number; beforeCreatedAt: string | null };
  }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
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
        threadId = await resolveThreadIdForTalk({
          talkId: input.talkId,
          threadId: input.threadId,
          ownerId: talk.owner_id,
        });
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
    const messages = await listTalkMessages({
      talkId: input.talkId,
      threadId,
      limit,
      beforeCreatedAt: beforeCreatedAt || undefined,
    });
    const apiMessages = await Promise.all(messages.map(toTalkMessageApiRecord));

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          talkId: input.talkId,
          messages: apiMessages,
          page: {
            limit,
            count: messages.length,
            beforeCreatedAt,
          },
        },
      },
    };
  });
}

export async function deleteTalkMessagesRoute(input: {
  talkId: string;
  auth: AuthContext;
  messageIds: string[];
  threadId: string | null;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    deletedCount: number;
    deletedMessageIds: string[];
  }>;
}> {
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

  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
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
    if (!(await canEditTalk(input.talkId))) {
      return {
        statusCode: 403,
        body: {
          ok: false,
          error: { code: 'forbidden', message: 'Talk is read-only' },
        },
      };
    }

    let threadId: string;
    try {
      threadId = await resolveThreadIdForTalk({
        talkId: input.talkId,
        threadId: input.threadId,
        ownerId: talk.owner_id,
      });
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
      const deleted = await deleteTalkMessagesAtomic({
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
      if (
        message === 'selected messages do not belong to the requested thread'
      ) {
        return {
          statusCode: 400,
          body: {
            ok: false,
            error: {
              code: 'thread_mismatch',
              message:
                'Selected messages do not belong to the requested thread.',
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
  });
}

export async function enqueueTalkChat(input: {
  talkId: string;
  threadId?: string | null;
  auth: AuthContext;
  content: string;
  targetAgentIds?: string[] | null;
  attachmentIds?: string[] | null;
  idempotencyKey?: string | null;
}): Promise<{
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
}> {
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

  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
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

    if (!(await canEditTalk(input.talkId))) {
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

    const requestedTargetIds = Array.isArray(input.targetAgentIds)
      ? [
          ...new Set(
            input.targetAgentIds.map((id: any) => id.trim()).filter(Boolean),
          ),
        ]
      : [];
    await ensureTalkUsesUsableDefaultAgent(input.talkId, talk.owner_id);
    const talkAgents = await listTalkAgents(input.talkId);
    const mentionedAgents = await resolveTalkAgentMentions(
      input.talkId,
      content,
    );
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
      const browserPreflightError = await getBrowserPreflightErrorForAgent(
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

    const messageId = randomUUID();
    const runIds = selectedAgents.map(() => randomUUID());
    const responseGroupId = randomUUID();
    let persisted: Awaited<ReturnType<typeof enqueueTalkTurnAtomic>>;
    try {
      // Attachment validation and linking happen inside the same postgres
      // transaction as message/run creation. If any attachment ID is invalid,
      // already linked, or exceeds the cap, the transaction rolls back — no
      // orphaned messages or runs are left behind.
      persisted = await enqueueTalkTurnAtomic({
        ownerId: talk.owner_id,
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
          message: await toTalkMessageApiRecord(persisted.message),
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
  });
}

export async function searchTalkMessagesRoute(input: {
  talkId: string;
  auth: AuthContext;
  query: string;
  limit?: number;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    query: string;
    results: TalkMessageSearchResultApiRecord[];
  }>;
}> {
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

  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
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
        ? Math.min(50, Math.max(1, Math.floor(input.limit)))
        : 20;
    const rows = await searchTalkMessages({
      talkId: input.talkId,
      query,
      limit,
    });
    const results = rows.map((row) => ({
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
  });
}

function toTalkRunApiRecord(
  run: TalkRunRecord,
  nicknameByAgentId: Map<string, string>,
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
    targetAgentNickname: run.target_agent_id
      ? (nicknameByAgentId.get(run.target_agent_id) ?? null)
      : null,
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

export async function listTalkRunsRoute(input: {
  talkId: string;
  auth: AuthContext;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    runs: TalkRunApiRecord[];
  }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
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

    const runs = await listTalkRunsForTalk(input.talkId, 50);
    const assignments = await listTalkAgents(input.talkId);
    const nicknameByAgentId = new Map<string, string>(
      assignments.map((a) => [a.agentId, a.nickname || a.agentName]),
    );

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          talkId: input.talkId,
          runs: runs.map((run) => toTalkRunApiRecord(run, nicknameByAgentId)),
        },
      },
    };
  });
}

export async function getTalkRunContextRoute(input: {
  talkId: string;
  runId: string;
  auth: AuthContext;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    runId: string;
    contextSnapshot: TalkRunContextSnapshot | null;
  }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
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

    const run = await getTalkRunById(input.runId);
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
  });
}

export async function cancelTalkChat(input: {
  talkId: string;
  threadId?: string | null;
  auth: AuthContext;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    threadId?: string | null;
    cancelledRuns: number;
  }>;
  cancelledRunning: boolean;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await getTalkForUser(input.talkId);
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

    if (!(await canEditTalk(input.talkId))) {
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
      const cancellation = await cancelTalkRunsAtomic({
        talkId: input.talkId,
        threadId: input.threadId,
        cancelledBy: input.auth.userId,
        ownerId: talk.owner_id,
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
  });
}
