/**
 * Agent Registry — service layer over agent-accessors.
 *
 * Provides higher-level operations for agent management:
 * - Create/update agents with validation
 * - Resolve the main agent
 * - List available agents for a Talk
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../../db.js';
import {
  createRegisteredAgent,
  deleteRegisteredAgent,
  getRegisteredAgent,
  getRegisteredAgentSnapshot,
  getFallbackSteps,
  listEnabledAgents,
  listRegisteredAgents,
  setFallbackSteps,
  updateRegisteredAgent,
  type RegisteredAgentRecord,
  type RegisteredAgentSnapshot,
  type AgentFallbackStep,
} from '../db/agent-accessors.js';

// ---------------------------------------------------------------------------
// Main Agent Resolution
// ---------------------------------------------------------------------------

const MAIN_AGENT_SETTING_KEY = 'system.mainAgentId';
const DEFAULT_TALK_AGENT_SETTING_KEY = 'system.defaultTalkAgentId';
const DEFAULT_TALK_AGENT_FALLBACK_ID = 'agent.talk';

/**
 * Returns the main agent ID from settings_kv.
 */
export function getMainAgentId(): string {
  const row = getDb()
    .prepare(`SELECT value FROM settings_kv WHERE key = ?`)
    .get(MAIN_AGENT_SETTING_KEY) as { value: string } | undefined;

  if (!row?.value) {
    throw new Error(
      'Main agent not configured. Check settings_kv for system.mainAgentId.',
    );
  }
  return row.value;
}

/**
 * Returns the default Talk agent ID from settings_kv.
 * Falls back to the direct-safe seeded Talk agent when the setting is absent,
 * and then to the main agent if the fallback agent has been removed.
 */
export function getDefaultTalkAgentId(): string {
  const row = getDb()
    .prepare(`SELECT value FROM settings_kv WHERE key = ?`)
    .get(DEFAULT_TALK_AGENT_SETTING_KEY) as { value: string } | undefined;
  const candidate = row?.value?.trim() || DEFAULT_TALK_AGENT_FALLBACK_ID;
  const agent = getRegisteredAgent(candidate);
  if (agent && agent.enabled === 1) {
    return candidate;
  }
  return getMainAgentId();
}

/**
 * Returns the main agent record.
 * Throws if the agent has been disabled since it was set as main.
 */
export function getMainAgent(): RegisteredAgentRecord {
  const id = getMainAgentId();
  const agent = getRegisteredAgent(id);
  if (!agent) {
    throw new Error(`Main agent '${id}' not found in registered_agents.`);
  }
  if (agent.enabled !== 1) {
    throw new Error(
      `Main agent '${id}' (${agent.name}) is disabled. ` +
        'Please select a new main agent in AI Agents settings.',
    );
  }
  return agent;
}

/**
 * Returns the main agent as a snapshot (API-friendly format).
 * Throws if the agent has been disabled since it was set as main.
 */
export function getMainAgentSnapshot(): RegisteredAgentSnapshot {
  const id = getMainAgentId();
  const snapshot = getRegisteredAgentSnapshot(id);
  if (!snapshot) {
    throw new Error(`Main agent '${id}' not found in registered_agents.`);
  }
  if (!snapshot.enabled) {
    throw new Error(
      `Main agent '${id}' (${snapshot.name}) is disabled. ` +
        'Please select a new main agent in AI Agents settings.',
    );
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Talk Agent Resolution
// ---------------------------------------------------------------------------

export interface TalkAgentAssignment {
  assignmentId: string;
  agentId: string;
  agentName: string;
  nickname: string;
  personaRole: string | null;
  isPrimary: boolean;
  sortOrder: number;
}

/**
 * List agents assigned to a Talk, ordered by sort_order.
 * Only returns enabled agents — disabled agents are silently excluded.
 */
export function listTalkAgents(talkId: string): TalkAgentAssignment[] {
  const rows = getDb()
    .prepare(
      `
    SELECT
      ta.id AS assignment_id,
      ta.registered_agent_id AS agent_id,
      ra.name AS agent_name,
      COALESCE(ta.nickname, ra.name, 'Agent') AS nickname,
      ta.persona_role,
      ta.is_primary,
      ta.sort_order
    FROM talk_agents ta
    JOIN registered_agents ra ON ra.id = ta.registered_agent_id
    WHERE ta.talk_id = ?
      AND ra.enabled = 1
    ORDER BY ta.sort_order ASC
  `,
    )
    .all(talkId) as Array<{
    assignment_id: string;
    agent_id: string;
    agent_name: string;
    nickname: string;
    persona_role: string | null;
    is_primary: number;
    sort_order: number;
  }>;
  return rows.map((row) => ({
    assignmentId: row.assignment_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    nickname: row.nickname,
    personaRole: row.persona_role,
    isPrimary: !!row.is_primary,
    sortOrder: row.sort_order,
  }));
}

/**
 * Resolve the primary agent for a Talk.
 * Returns the agent marked as primary, or the first assigned agent.
 * Only considers enabled agents — disabled agents are skipped.
 */
export function resolvePrimaryAgent(
  talkId: string,
): RegisteredAgentRecord | undefined {
  const row = getDb()
    .prepare(
      `
    SELECT ra.*
    FROM talk_agents ta
    JOIN registered_agents ra ON ra.id = ta.registered_agent_id
    WHERE ta.talk_id = ?
      AND ra.enabled = 1
    ORDER BY ta.is_primary DESC, ta.sort_order ASC
    LIMIT 1
  `,
    )
    .get(talkId) as RegisteredAgentRecord | undefined;

  return row;
}

/**
 * Resolve a specific agent for a Talk by @mention name.
 * Used for explicit @agent routing.
 * Only considers enabled agents — disabled agents are not routable.
 */
export function resolveAgentByName(
  talkId: string,
  agentName: string,
): RegisteredAgentRecord | undefined {
  const row = getDb()
    .prepare(
      `
    SELECT ra.*
    FROM talk_agents ta
    JOIN registered_agents ra ON ra.id = ta.registered_agent_id
    WHERE ta.talk_id = ?
      AND (
        LOWER(COALESCE(ta.nickname, '')) = LOWER(?)
        OR LOWER(ra.name) = LOWER(?)
      )
      AND ra.enabled = 1
    LIMIT 1
  `,
    )
    .get(talkId, agentName, agentName) as RegisteredAgentRecord | undefined;

  return row;
}

function normalizeMentionAlias(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function buildMentionAliases(value: string | null | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];

  const aliases = new Set<string>();
  const normalized = normalizeMentionAlias(trimmed);
  if (normalized.length >= 2) {
    aliases.add(normalized);
  }

  const firstToken = trimmed
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .find((token) => token.length >= 2);
  if (firstToken) {
    aliases.add(firstToken);
  }

  return [...aliases];
}

function extractMentionTokens(content: string): string[] {
  const mentions: string[] = [];
  const pattern = /(^|[\s([{"'`])@([A-Za-z0-9][A-Za-z0-9._-]*)/g;
  for (const match of content.matchAll(pattern)) {
    const token = normalizeMentionAlias(match[2] || '');
    if (token.length >= 2) {
      mentions.push(token);
    }
  }
  return mentions;
}

export function resolveTalkAgentMentions(
  talkId: string,
  content: string,
): TalkAgentAssignment[] {
  const mentionTokens = extractMentionTokens(content);
  if (mentionTokens.length === 0) return [];

  const talkAgents = listTalkAgents(talkId);
  if (talkAgents.length === 0) return [];

  const aliasToAgentIds = new Map<string, Set<string>>();
  for (const agent of talkAgents) {
    const aliases = new Set<string>([
      ...buildMentionAliases(agent.nickname),
      ...buildMentionAliases(agent.agentName),
    ]);
    for (const alias of aliases) {
      const next = aliasToAgentIds.get(alias) || new Set<string>();
      next.add(agent.agentId);
      aliasToAgentIds.set(alias, next);
    }
  }

  const matchedAgentIds = new Set<string>();
  for (const token of mentionTokens) {
    const matches = aliasToAgentIds.get(token);
    if (matches && matches.size === 1) {
      matchedAgentIds.add([...matches][0]!);
    }
  }

  if (matchedAgentIds.size === 0) {
    return [];
  }

  return talkAgents.filter((agent) => matchedAgentIds.has(agent.agentId));
}

// ---------------------------------------------------------------------------
// Talk Agent Persistence
// ---------------------------------------------------------------------------

export interface TalkAgentInput {
  /** Client-generated assignment ID (preserved across saves). */
  id: string;
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  modelId: string;
  nickname: string | null;
  nicknameMode: 'auto' | 'custom';
  personaRole: string;
  isPrimary: boolean;
  sortOrder: number;
}

export interface TalkAgentRow {
  id: string;
  talkId: string;
  registeredAgentId: string | null;
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  modelId: string | null;
  nickname: string | null;
  nicknameMode: 'auto' | 'custom';
  personaRole: string | null;
  isPrimary: boolean;
  sortOrder: number;
}

/**
 * Replace all talk_agents for a Talk in a single transaction.
 *
 * Deletes existing rows and inserts the new set. This is a full replace —
 * partial updates are not supported (the frontend always sends the full list).
 *
 * The frontend sends the registered_agent_id as the `id` field in TalkAgentInput.
 * We generate a unique assignment ID (`ta_<uuid>`) for the row PK so the same
 * registered agent can appear in multiple talks without a PK collision.
 * The `registered_agent_id` FK stores the agent reference for JOINs.
 */
export function setTalkAgents(talkId: string, agents: TalkAgentInput[]): void {
  const db = getDb();
  const now = new Date().toISOString();

  const deleteStmt = db.prepare(`DELETE FROM talk_agents WHERE talk_id = ?`);
  const insertStmt = db.prepare(`
    INSERT INTO talk_agents (
      id, talk_id, registered_agent_id,
      source_kind, provider_id, model_id,
      nickname, nickname_mode,
      persona_role, is_primary, sort_order,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    deleteStmt.run(talkId);
    for (const agent of agents) {
      // Generate a unique assignment ID for the row PK.
      // The frontend's `agent.id` is the registered_agent_id — store it
      // only in the FK column so the same agent can exist in multiple talks.
      const assignmentId = `ta_${randomUUID()}`;
      insertStmt.run(
        assignmentId,
        talkId,
        agent.id, // registered_agent_id FK
        agent.sourceKind,
        agent.providerId,
        agent.modelId,
        agent.nickname,
        agent.nicknameMode,
        agent.personaRole,
        agent.isPrimary ? 1 : 0,
        agent.sortOrder,
        now,
        now,
      );
    }
  })();
}

function pruneDeletedTalkAgentAssignments(talkId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `DELETE FROM talk_agents WHERE talk_id = ? AND registered_agent_id IS NULL`,
    ).run(talkId);

    const remaining = db
      .prepare(
        `
        SELECT id, is_primary
        FROM talk_agents
        WHERE talk_id = ?
        ORDER BY sort_order ASC, created_at ASC
      `,
      )
      .all(talkId) as Array<{ id: string; is_primary: number }>;

    if (remaining.length === 0) return;

    const primaryCount = remaining.filter((row) => row.is_primary === 1).length;
    if (primaryCount === 1) return;

    const nextPrimaryId = remaining[0]!.id;
    db.prepare(
      `
        UPDATE talk_agents
        SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END
        WHERE talk_id = ?
      `,
    ).run(nextPrimaryId, talkId);
  })();
}

/**
 * Load all talk_agents for a Talk, ordered by sort_order.
 */
export function getTalkAgentRows(talkId: string): TalkAgentRow[] {
  pruneDeletedTalkAgentAssignments(talkId);
  const rows = getDb()
    .prepare(
      `
    SELECT
      id, talk_id, registered_agent_id,
      source_kind, provider_id, model_id,
      nickname, nickname_mode,
      persona_role, is_primary, sort_order
    FROM talk_agents
    WHERE talk_id = ?
    ORDER BY sort_order ASC, created_at ASC
  `,
    )
    .all(talkId) as Array<{
    id: string;
    talk_id: string;
    registered_agent_id: string | null;
    source_kind: string;
    provider_id: string | null;
    model_id: string | null;
    nickname: string | null;
    nickname_mode: string;
    persona_role: string | null;
    is_primary: number;
    sort_order: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    talkId: row.talk_id,
    registeredAgentId: row.registered_agent_id,
    sourceKind: row.source_kind as 'claude_default' | 'provider',
    providerId: row.provider_id,
    modelId: row.model_id,
    nickname: row.nickname,
    nicknameMode: row.nickname_mode as 'auto' | 'custom',
    personaRole: row.persona_role,
    isPrimary: !!row.is_primary,
    sortOrder: row.sort_order,
  }));
}

/**
 * Ensure a Talk always has at least one assigned agent. Existing assignments
 * are preserved as-is; only broken zero-agent Talks are healed.
 */
export function ensureTalkUsesUsableDefaultAgent(talkId: string): void {
  const defaultTalkAgentId = getDefaultTalkAgentId();
  const defaultTalkAgent = getRegisteredAgent(defaultTalkAgentId);
  if (!defaultTalkAgent || defaultTalkAgent.enabled !== 1) {
    return;
  }

  const rows = getTalkAgentRows(talkId);
  if (rows.length === 0) {
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
    return;
  }
}

// ---------------------------------------------------------------------------
// Main Agent Write Path
// ---------------------------------------------------------------------------

/**
 * Set the system-wide main agent ID.
 * Validates the agent exists and is enabled before writing.
 */
export function setMainAgentId(agentId: string): void {
  const agent = getRegisteredAgent(agentId);
  if (!agent) {
    throw new Error(`Agent '${agentId}' not found in registered_agents.`);
  }
  if (agent.enabled !== 1) {
    throw new Error(
      `Agent '${agentId}' is disabled — cannot set as main agent.`,
    );
  }
  getDb()
    .prepare(
      `INSERT INTO settings_kv (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(MAIN_AGENT_SETTING_KEY, agentId);
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export {
  createRegisteredAgent,
  deleteRegisteredAgent,
  getRegisteredAgent,
  getRegisteredAgentSnapshot,
  getFallbackSteps,
  listEnabledAgents,
  listRegisteredAgents,
  setFallbackSteps,
  updateRegisteredAgent,
  type RegisteredAgentRecord,
  type RegisteredAgentSnapshot,
  type AgentFallbackStep,
};
