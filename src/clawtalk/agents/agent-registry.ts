/**
 * Agent Registry — service layer over the pg accessor modules.
 *
 * Provides higher-level operations for agent management:
 * - Create/update agents with validation
 * - Resolve the main agent
 * - List available agents for a Talk
 *
 * Post-cloud cutover (Phase 5 PR 2): every function is async. Persistence
 * delegates to:
 *   - `accessors-pg.ts` for `settings_kv` (main agent / default talk agent
 *     pointers — system table grant landed in migration 0004).
 *   - `talk-agents-pg.ts` for the per-Talk `talk_agents` CRUD.
 *   - `agent-accessors-pg.ts` for the `registered_agents` surface.
 *
 * Callers MUST run within `withUserContext(userId, async () => ...)` so that
 * RLS gates writes on `auth.uid()`. The `setTalkAgents` /
 * `ensureTalkUsesUsableDefaultAgent` signatures take an explicit ownerId so
 * the call site stays honest about whose identity is being written.
 */

import { getSettingValue, upsertSettingValue } from '../db/accessors.js';
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
import {
  listTalkAgents,
  resolvePrimaryAgent,
  resolveAgentByName,
  setTalkAgents,
  getTalkAgentRows,
  type TalkAgentAssignment,
  type TalkAgentInput,
  type TalkAgentRow,
} from '../db/talk-agents.js';

// ---------------------------------------------------------------------------
// Main Agent Resolution
// ---------------------------------------------------------------------------

const MAIN_AGENT_SETTING_KEY = 'system.mainAgentId';
const DEFAULT_TALK_AGENT_SETTING_KEY = 'system.defaultTalkAgentId';
const DEFAULT_TALK_AGENT_FALLBACK_ID = 'agent.talk';

/**
 * Returns the main agent ID from settings_kv.
 */
export async function getMainAgentId(): Promise<string> {
  const value = await getSettingValue(MAIN_AGENT_SETTING_KEY);
  if (!value) {
    throw new Error(
      'Main agent not configured. Check settings_kv for system.mainAgentId.',
    );
  }
  return value;
}

/**
 * Returns the default Talk agent ID from settings_kv.
 * Falls back to the direct-safe seeded Talk agent when the setting is absent,
 * and then to the main agent if the fallback agent has been removed.
 */
export async function getDefaultTalkAgentId(): Promise<string> {
  const value = await getSettingValue(DEFAULT_TALK_AGENT_SETTING_KEY);
  const candidate = value?.trim() || DEFAULT_TALK_AGENT_FALLBACK_ID;
  const agent = await getRegisteredAgent(candidate);
  if (agent && agent.enabled === true) {
    return candidate;
  }
  return getMainAgentId();
}

/**
 * Returns the main agent record.
 * Throws if the agent has been disabled since it was set as main.
 */
export async function getMainAgent(): Promise<RegisteredAgentRecord> {
  const id = await getMainAgentId();
  const agent = await getRegisteredAgent(id);
  if (!agent) {
    throw new Error(`Main agent '${id}' not found in registered_agents.`);
  }
  if (agent.enabled !== true) {
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
export async function getMainAgentSnapshot(): Promise<RegisteredAgentSnapshot> {
  const id = await getMainAgentId();
  const snapshot = await getRegisteredAgentSnapshot(id);
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
// Talk Agent Mention Resolution
// ---------------------------------------------------------------------------

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

export async function resolveTalkAgentMentions(
  talkId: string,
  content: string,
): Promise<TalkAgentAssignment[]> {
  const mentionTokens = extractMentionTokens(content);
  if (mentionTokens.length === 0) return [];

  const talkAgents = await listTalkAgents(talkId);
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
// Talk Agent Healing
// ---------------------------------------------------------------------------

/**
 * Ensure a Talk always has at least one assigned agent. Existing assignments
 * are preserved as-is; only broken zero-agent Talks are healed.
 *
 * `ownerId` is forwarded to the underlying `setTalkAgents` so RLS WITH CHECK
 * binds the insert to `auth.uid()`.
 */
export async function ensureTalkUsesUsableDefaultAgent(
  talkId: string,
  ownerId: string,
): Promise<void> {
  // Fresh installs may have neither a default Talk agent nor a main
  // agent configured — getDefaultTalkAgentId() throws in that case.
  // Healing is a best-effort fixup, not a hard requirement, so swallow
  // and no-op when there's nothing to heal toward.
  let defaultTalkAgentId: string;
  try {
    defaultTalkAgentId = await getDefaultTalkAgentId();
  } catch {
    return;
  }
  const defaultTalkAgent = await getRegisteredAgent(defaultTalkAgentId);
  if (!defaultTalkAgent || defaultTalkAgent.enabled !== true) {
    return;
  }

  const rows = await getTalkAgentRows(talkId);
  if (rows.length === 0) {
    await setTalkAgents({
      talkId,
      ownerId,
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
export async function setMainAgentId(agentId: string): Promise<void> {
  const agent = await getRegisteredAgent(agentId);
  if (!agent) {
    throw new Error(`Agent '${agentId}' not found in registered_agents.`);
  }
  if (agent.enabled !== true) {
    throw new Error(
      `Agent '${agentId}' is disabled — cannot set as main agent.`,
    );
  }
  await upsertSettingValue({
    key: MAIN_AGENT_SETTING_KEY,
    value: agentId,
  });
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
  listTalkAgents,
  resolvePrimaryAgent,
  resolveAgentByName,
  setTalkAgents,
  getTalkAgentRows,
  type RegisteredAgentRecord,
  type RegisteredAgentSnapshot,
  type AgentFallbackStep,
  type TalkAgentAssignment,
  type TalkAgentInput,
  type TalkAgentRow,
};
