// GET /api/v1/talks/:talkId/snapshot — point-in-time bundle the
// webapp uses to render a Talk in one round-trip. Composes
// loadTalkSnapshot's REPEATABLE READ accessor into a camelCase API
// shape the webapp can hand directly to TanStack Query.
//
// Plan: ~/.gstack/projects/clawtalk/talk-load-architecture-plan-2026-05-27.md
// (PR A).
//
// The route layer's only job here is shape translation — every read
// happens inside `loadTalkSnapshot`'s isolated tx, so no extra RLS-aware
// queries are issued from this file.

import {
  loadTalkSnapshot,
  type TalkSnapshot,
} from '../../db/talk-snapshot-accessor.js';
import type {
  TalkMessageRecord,
  TalkRecord,
  TalkRunRecord,
  TalkRunStatus,
  TalkThreadWithMetrics,
} from '../../db/accessors.js';
import type { Content } from '../../db/content-accessors.js';
import type { ContentEditRow } from '../../../shared/rich-text/index.js';
import type { TalkAgentAssignment } from '../../db/talk-agents.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

export interface TalkSnapshotApiTalk {
  id: string;
  ownerId: string;
  folderId: string | null;
  sortOrder: number;
  title: string | null;
  orchestrationMode: 'ordered' | 'panel';
  status: 'active' | 'paused' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TalkSnapshotApiThread {
  id: string;
  talkId: string;
  title: string | null;
  isDefault: boolean;
  isInternal: boolean;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt: string | null;
}

export interface TalkSnapshotApiMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdBy: string | null;
  createdAt: string;
  runId: string | null;
  agentId: string | null;
  agentNickname: string | null;
  metadata: Record<string, unknown> | null;
}

export interface TalkSnapshotApiRun {
  id: string;
  threadId: string;
  status: TalkRunStatus;
  responseGroupId: string | null;
  sequenceIndex: number | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  triggerMessageId: string | null;
  targetAgentId: string | null;
  executorAlias: string | null;
  executorModel: string | null;
}

export interface TalkSnapshotApiAgent {
  assignmentId: string;
  agentId: string;
  agentName: string;
  nickname: string;
  personaRole: string | null;
  isPrimary: boolean;
  sortOrder: number;
}

export interface TalkSnapshotApiRecord {
  talk: TalkSnapshotApiTalk;
  threads: TalkSnapshotApiThread[];
  activeThreadId: string;
  messages: TalkSnapshotApiMessage[];
  hasOlderMessages: boolean;
  content: Content | null;
  pendingEdits: ContentEditRow[];
  runs: TalkSnapshotApiRun[];
  agents: TalkSnapshotApiAgent[];
  snapshotVersion: number;
}

function toApiTalk(row: TalkRecord): TalkSnapshotApiTalk {
  return {
    id: row.id,
    ownerId: row.owner_id,
    folderId: row.folder_id,
    sortOrder: row.sort_order,
    title: row.topic_title,
    orchestrationMode: row.orchestration_mode,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toApiThread(row: TalkThreadWithMetrics): TalkSnapshotApiThread {
  return {
    id: row.id,
    talkId: row.talk_id,
    title: row.title,
    isDefault: row.is_default,
    isInternal: row.is_internal,
    isPinned: row.is_pinned,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at,
  };
}

function toApiMessage(row: TalkMessageRecord): TalkSnapshotApiMessage {
  const meta =
    row.metadata_json &&
    typeof row.metadata_json === 'object' &&
    !Array.isArray(row.metadata_json)
      ? (row.metadata_json as Record<string, unknown>)
      : null;
  const agentId =
    meta && typeof meta.agentId === 'string' ? (meta.agentId as string) : null;
  const agentNicknameRaw = meta
    ? typeof meta.agentNickname === 'string'
      ? (meta.agentNickname as string)
      : typeof meta.agentName === 'string'
        ? (meta.agentName as string)
        : null
    : null;
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    createdBy: row.created_by,
    createdAt: row.created_at,
    runId: row.run_id,
    agentId,
    agentNickname: agentNicknameRaw,
    metadata: meta,
  };
}

function toApiRun(row: TalkRunRecord): TalkSnapshotApiRun {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status,
    responseGroupId: row.response_group_id,
    sequenceIndex: row.sequence_index,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    triggerMessageId: row.trigger_message_id,
    targetAgentId: row.target_agent_id,
    executorAlias: row.executor_alias,
    executorModel: row.executor_model,
  };
}

function toApiAgent(row: TalkAgentAssignment): TalkSnapshotApiAgent {
  return {
    assignmentId: row.assignmentId,
    agentId: row.agentId,
    agentName: row.agentName,
    nickname: row.nickname,
    personaRole: row.personaRole,
    isPrimary: row.isPrimary,
    sortOrder: row.sortOrder,
  };
}

export function toTalkSnapshotApi(
  snapshot: TalkSnapshot,
): TalkSnapshotApiRecord {
  return {
    talk: toApiTalk(snapshot.talk),
    threads: snapshot.threads.map(toApiThread),
    activeThreadId: snapshot.activeThreadId,
    messages: snapshot.messages.map(toApiMessage),
    hasOlderMessages: snapshot.hasOlderMessages,
    content: snapshot.content,
    pendingEdits: snapshot.pendingEdits,
    runs: snapshot.runs.map(toApiRun),
    agents: snapshot.agents.map(toApiAgent),
    snapshotVersion: snapshot.snapshotVersion,
  };
}

export async function getTalkSnapshotRoute(input: {
  talkId: string;
  threadId?: string | null;
  auth: AuthContext;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<TalkSnapshotApiRecord>;
}> {
  const snapshot = await loadTalkSnapshot({
    userId: input.auth.userId,
    talkId: input.talkId,
    threadId: input.threadId ?? null,
  });
  if (!snapshot) {
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
    body: { ok: true, data: toTalkSnapshotApi(snapshot) },
  };
}
