import { randomUUID } from 'crypto';

import { getDb } from '../../db.js';

// ---------------------------------------------------------------------------
// Tool Capability Mapping
// ---------------------------------------------------------------------------

/**
 * Canonical mapping from tool family names to runtime tool names.
 * Used for:
 * - Write-time validation of tool_permissions_json
 * - Resolving effective tools at execution time
 * - UI toggle definitions
 *
 * Tool families map to concrete tool names the agent can invoke.
 * The 'connectors' family is dynamically populated at startup.
 */
export const TOOL_FAMILY_MAP: Record<string, string[]> = {
  shell: ['Bash'],
  filesystem: ['Read', 'Write', 'Edit', 'Glob'],
  web: ['web_fetch', 'web_search'],
  browser: [
    'browser_open',
    'browser_snapshot',
    'browser_act',
    'browser_wait',
    'browser_screenshot',
    'browser_close',
  ],
  connectors: [], // matched dynamically: any tool starting with 'connector_'
  google_read: [
    'GoogleDriveRead',
    'GoogleDocsRead',
    'google_drive_search',
    'google_drive_read',
    'google_drive_list_folder',
    'google_docs_read',
    'google_sheets_read_range',
  ],
  google_write: [
    'GoogleDriveWrite',
    'GoogleDocsWrite',
    'google_docs_batch_update',
    'google_sheets_batch_update',
  ],
  gmail_read: ['GmailRead', 'GmailSearch', 'gmail_read'],
  gmail_send: ['GmailSend', 'gmail_send'], // also triggers approval gate
  messaging: ['DiscordSend', 'SlackSend'],
};

export function buildDefaultTalkToolPermissions(): Record<string, boolean> {
  return {
    web: true,
    connectors: true,
    google_read: true,
    google_write: true,
    gmail_read: true,
    gmail_send: true,
    messaging: true,
  };
}

/**
 * Hard dependency rules enforced at write time and reflected in UI.
 * Turning ON the left side auto-enables the right side.
 * Turning OFF the right side auto-disables the left side.
 */
export const AUTO_IMPLIED_DEPENDENCIES: Array<[string, string]> = [
  ['shell', 'filesystem'],
  ['gmail_send', 'gmail_read'],
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates tool permissions JSON at write time.
 * - Parses JSON
 * - Checks all keys are valid tool families
 * - Checks all values are boolean
 * - Applies auto-implied dependencies
 * - Rejects unknown keys
 */
export function validateToolPermissionsJson(json: string): {
  valid: boolean;
  error?: string;
} {
  try {
    const parsed = JSON.parse(json);

    // Check that parsed is an object
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {
        valid: false,
        error: 'tool_permissions_json must be a JSON object',
      };
    }

    const knownFamilies = Object.keys(TOOL_FAMILY_MAP);
    const providedKeys = Object.keys(parsed);

    // Check for unknown keys
    for (const key of providedKeys) {
      if (!knownFamilies.includes(key)) {
        return {
          valid: false,
          error: `Unknown tool family: ${key}. Valid families are: ${knownFamilies.join(', ')}`,
        };
      }
    }

    // Check that all values are boolean
    for (const key of providedKeys) {
      const value = parsed[key];
      if (typeof value !== 'boolean') {
        return {
          valid: false,
          error: `Value for ${key} must be boolean, got ${typeof value}`,
        };
      }
    }

    // Apply auto-implied dependencies: ensure that if a family is true,
    // all its right-side dependencies are also true.
    const normalized = { ...parsed };
    for (const [left, right] of AUTO_IMPLIED_DEPENDENCIES) {
      if (normalized[left] === true && normalized[right] !== true) {
        normalized[right] = true;
      }
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Invalid JSON: ${String(err)}` };
  }
}

/**
 * Applies auto-implied dependencies to a tool permissions object.
 * Returns a new object with dependencies resolved.
 */
export function applyToolDependencies(
  permissions: Record<string, boolean>,
): Record<string, boolean> {
  const result = { ...permissions };

  for (const [left, right] of AUTO_IMPLIED_DEPENDENCIES) {
    // If left is true, right must be true
    if (result[left] === true && result[right] !== true) {
      result[right] = true;
    }
    // If right is false, left must be false
    if (result[right] === false && result[left] !== false) {
      result[left] = false;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Record Types (snake_case, database layer)
// ---------------------------------------------------------------------------

export interface RegisteredAgentRecord {
  id: string;
  name: string;
  provider_id: string;
  model_id: string;
  tool_permissions_json: string;
  persona_role: string | null;
  system_prompt: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface AgentFallbackStepRecord {
  agent_id: string;
  position: number;
  provider_id: string;
  model_id: string;
}

export interface UserToolPermissionRecord {
  user_id: string;
  tool_id: string;
  allowed: number;
  requires_approval: number;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Snapshot Types (camelCase, API layer)
// ---------------------------------------------------------------------------

export interface RegisteredAgentSnapshot {
  id: string;
  name: string;
  providerId: string;
  modelId: string;
  toolPermissions: Record<string, boolean>;
  personaRole: string | null;
  systemPrompt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentFallbackStep {
  position: number;
  providerId: string;
  modelId: string;
}

export interface UserToolPermission {
  toolId: string;
  allowed: boolean;
  requiresApproval: boolean;
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

export function toAgentSnapshot(
  record: RegisteredAgentRecord,
): RegisteredAgentSnapshot {
  let toolPermissions: Record<string, boolean> = {};
  try {
    toolPermissions = JSON.parse(record.tool_permissions_json);
  } catch {
    // If parsing fails, return empty object (should not happen if validation worked)
    toolPermissions = {};
  }

  return {
    id: record.id,
    name: record.name,
    providerId: record.provider_id,
    modelId: record.model_id,
    toolPermissions,
    personaRole: record.persona_role,
    systemPrompt: record.system_prompt,
    enabled: record.enabled === 1,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function toUserToolPermission(
  record: UserToolPermissionRecord,
): UserToolPermission {
  return {
    toolId: record.tool_id,
    allowed: record.allowed === 1,
    requiresApproval: record.requires_approval === 1,
  };
}

// ---------------------------------------------------------------------------
// Registered Agents CRUD
// ---------------------------------------------------------------------------

/**
 * Get a single registered agent by ID.
 */
export function getRegisteredAgent(
  agentId: string,
): RegisteredAgentRecord | undefined {
  return getDb()
    .prepare('SELECT * FROM registered_agents WHERE id = ?')
    .get(agentId) as RegisteredAgentRecord | undefined;
}

/**
 * Get a registered agent as a snapshot (API-facing format).
 */
export function getRegisteredAgentSnapshot(
  agentId: string,
): RegisteredAgentSnapshot | undefined {
  const record = getRegisteredAgent(agentId);
  return record ? toAgentSnapshot(record) : undefined;
}

/**
 * List all registered agents.
 */
export function listRegisteredAgents(): RegisteredAgentRecord[] {
  return getDb()
    .prepare('SELECT * FROM registered_agents ORDER BY created_at ASC')
    .all() as RegisteredAgentRecord[];
}

/**
 * List all enabled registered agents.
 */
export function listEnabledAgents(): RegisteredAgentRecord[] {
  return getDb()
    .prepare(
      'SELECT * FROM registered_agents WHERE enabled = 1 ORDER BY created_at ASC',
    )
    .all() as RegisteredAgentRecord[];
}

/**
 * Create a new registered agent.
 * Validates tool_permissions_json and applies auto-implied dependencies.
 * Defaults to the direct-safe Talk profile if not provided.
 */
export function createRegisteredAgent(params: {
  name: string;
  providerId: string;
  modelId: string;
  toolPermissionsJson?: string;
  personaRole?: string;
  systemPrompt?: string;
}): RegisteredAgentRecord {
  const now = new Date().toISOString();
  const agentId = randomUUID();

  // Default to the same Talk-safe tool profile as the seeded Claude agent:
  // web/google/connectors on, heavy container tools off.
  let toolPermissionsJson = params.toolPermissionsJson;
  if (!toolPermissionsJson) {
    toolPermissionsJson = JSON.stringify(buildDefaultTalkToolPermissions());
  }

  // Validate
  const validation = validateToolPermissionsJson(toolPermissionsJson);
  if (!validation.valid) {
    throw new Error(`Invalid tool permissions: ${validation.error}`);
  }

  // Parse, apply dependencies, and re-stringify
  const parsed = JSON.parse(toolPermissionsJson);
  const normalized = applyToolDependencies(parsed);
  const normalizedJson = JSON.stringify(normalized);

  getDb()
    .prepare(
      `
    INSERT INTO registered_agents (
      id, name, provider_id, model_id, tool_permissions_json, persona_role, system_prompt, enabled, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      agentId,
      params.name,
      params.providerId,
      params.modelId,
      normalizedJson,
      params.personaRole || null,
      params.systemPrompt || null,
      1,
      now,
      now,
    );

  const created = getRegisteredAgent(agentId);
  if (!created) {
    throw new Error('Failed to create agent');
  }

  return created;
}

/**
 * Update a registered agent.
 * Validates tool_permissions_json if provided and applies auto-implied dependencies.
 */
export function updateRegisteredAgent(
  agentId: string,
  updates: Partial<{
    name: string;
    providerId: string;
    modelId: string;
    toolPermissionsJson: string;
    personaRole: string | null;
    systemPrompt: string | null;
    enabled: boolean;
  }>,
): RegisteredAgentRecord | undefined {
  const existing = getRegisteredAgent(agentId);
  if (!existing) {
    return undefined;
  }

  const now = new Date().toISOString();

  // Validate tool_permissions_json if provided
  let normalizedToolJson = existing.tool_permissions_json;
  if (updates.toolPermissionsJson !== undefined) {
    const validation = validateToolPermissionsJson(updates.toolPermissionsJson);
    if (!validation.valid) {
      throw new Error(`Invalid tool permissions: ${validation.error}`);
    }
    const parsed = JSON.parse(updates.toolPermissionsJson);
    const normalized = applyToolDependencies(parsed);
    normalizedToolJson = JSON.stringify(normalized);
  }

  // Build update SQL dynamically
  const setClauses: string[] = ['updated_at = ?'];
  const values: any[] = [now];

  if (updates.name !== undefined) {
    setClauses.push('name = ?');
    values.push(updates.name);
  }
  if (updates.providerId !== undefined) {
    setClauses.push('provider_id = ?');
    values.push(updates.providerId);
  }
  if (updates.modelId !== undefined) {
    setClauses.push('model_id = ?');
    values.push(updates.modelId);
  }
  if (updates.toolPermissionsJson !== undefined) {
    setClauses.push('tool_permissions_json = ?');
    values.push(normalizedToolJson);
  }
  if (updates.personaRole !== undefined) {
    setClauses.push('persona_role = ?');
    values.push(updates.personaRole);
  }
  if (updates.systemPrompt !== undefined) {
    setClauses.push('system_prompt = ?');
    values.push(updates.systemPrompt);
  }
  if (updates.enabled !== undefined) {
    setClauses.push('enabled = ?');
    values.push(updates.enabled ? 1 : 0);
  }

  values.push(agentId);

  getDb()
    .prepare(
      `
    UPDATE registered_agents
    SET ${setClauses.join(', ')}
    WHERE id = ?
  `,
    )
    .run(...values);

  return getRegisteredAgent(agentId);
}

/**
 * Delete a registered agent.
 * Returns true if the agent existed and was deleted.
 */
export function deleteRegisteredAgent(agentId: string): boolean {
  const db = getDb();
  const tx = db.transaction((targetAgentId: string): boolean => {
    db.prepare('DELETE FROM talk_agents WHERE registered_agent_id = ?').run(
      targetAgentId,
    );
    const result = db
      .prepare('DELETE FROM registered_agents WHERE id = ?')
      .run(targetAgentId);
    return (result.changes ?? 0) > 0;
  });
  return tx(agentId);
}

// ---------------------------------------------------------------------------
// Agent Fallback Steps
// ---------------------------------------------------------------------------

/**
 * Get all fallback steps for an agent, ordered by position.
 */
export function getFallbackSteps(agentId: string): AgentFallbackStep[] {
  const rows = getDb()
    .prepare(
      `
    SELECT position, provider_id, model_id
    FROM agent_fallback_steps
    WHERE agent_id = ?
    ORDER BY position ASC
  `,
    )
    .all(agentId) as AgentFallbackStepRecord[];

  return rows.map((r) => ({
    position: r.position,
    providerId: r.provider_id,
    modelId: r.model_id,
  }));
}

/**
 * Set fallback steps for an agent.
 * Deletes existing steps and inserts new ones with sequential positions starting at 1.
 */
export function setFallbackSteps(
  agentId: string,
  steps: Array<{ providerId: string; modelId: string }>,
): void {
  const db = getDb();

  // Delete existing steps
  db.prepare('DELETE FROM agent_fallback_steps WHERE agent_id = ?').run(
    agentId,
  );

  // Insert new steps with sequential positions
  if (steps.length > 0) {
    const insertStmt = db.prepare(
      `
      INSERT INTO agent_fallback_steps (agent_id, position, provider_id, model_id)
      VALUES (?, ?, ?, ?)
    `,
    );

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      insertStmt.run(agentId, i + 1, step.providerId, step.modelId);
    }
  }
}

// ---------------------------------------------------------------------------
// User Tool Permissions
// ---------------------------------------------------------------------------

/**
 * Get a single user tool permission.
 */
export function getUserToolPermission(
  userId: string,
  toolId: string,
): UserToolPermission | undefined {
  const record = getDb()
    .prepare(
      `
    SELECT user_id, tool_id, allowed, requires_approval, updated_at
    FROM user_tool_permissions
    WHERE user_id = ? AND tool_id = ?
  `,
    )
    .get(userId, toolId) as UserToolPermissionRecord | undefined;

  return record ? toUserToolPermission(record) : undefined;
}

/**
 * List all tool permissions for a user.
 */
export function listUserToolPermissions(userId: string): UserToolPermission[] {
  const records = getDb()
    .prepare(
      `
    SELECT user_id, tool_id, allowed, requires_approval, updated_at
    FROM user_tool_permissions
    WHERE user_id = ?
    ORDER BY tool_id ASC
  `,
    )
    .all(userId) as UserToolPermissionRecord[];

  return records.map(toUserToolPermission);
}

/**
 * Upsert a user tool permission.
 * Creates or updates the permission for a user/tool pair.
 */
export function upsertUserToolPermission(
  userId: string,
  toolId: string,
  allowed: boolean,
  requiresApproval: boolean,
): void {
  const now = new Date().toISOString();

  getDb()
    .prepare(
      `
    INSERT INTO user_tool_permissions (user_id, tool_id, allowed, requires_approval, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, tool_id) DO UPDATE SET
      allowed = excluded.allowed,
      requires_approval = excluded.requires_approval,
      updated_at = excluded.updated_at
  `,
    )
    .run(userId, toolId, allowed ? 1 : 0, requiresApproval ? 1 : 0, now);
}

// ---------------------------------------------------------------------------
// Effective Tools Computation
// ---------------------------------------------------------------------------

/**
 * Represents the effective tool access for an agent+user combination.
 */
export interface EffectiveToolAccess {
  toolFamily: string;
  runtimeTools: string[];
  enabled: boolean;
  requiresApproval: boolean;
}

/**
 * Compute effective tools for an agent given a user's permissions.
 *
 * Algorithm:
 * 1. Look up agent's tool_permissions_json
 * 2. Parse and resolve each enabled family to runtime tool names via TOOL_FAMILY_MAP
 * 3. Filter by user's tool permissions: a tool is enabled only if:
 *    - The agent permits the tool family (via tool_permissions_json)
 *    - The user allows the tool (or no user permission exists, defaulting to allowed)
 * 4. requiresApproval is set to true if the user requires approval for that tool
 *
 * Returns an array of tool families with their resolved runtime tools and approval status.
 */
export function getEffectiveToolsForAgent(
  agentId: string,
  userId: string,
): EffectiveToolAccess[] {
  const agent = getRegisteredAgent(agentId);
  if (!agent) {
    return [];
  }

  let agentPermissions: Record<string, boolean> = {};
  try {
    agentPermissions = JSON.parse(agent.tool_permissions_json);
  } catch {
    // If parsing fails, return empty
    return [];
  }

  const userPermissions = listUserToolPermissions(userId);
  const userPermissionMap = new Map(userPermissions.map((p) => [p.toolId, p]));

  const result: EffectiveToolAccess[] = [];

  for (const [family, tools] of Object.entries(TOOL_FAMILY_MAP)) {
    const agentEnabled = agentPermissions[family] === true;

    // Resolve runtime tools for this family
    const runtimeTools = tools.length > 0 ? [...tools] : [];

    // Determine overall enable status: both agent and user must allow
    // If no user permission exists, default to allowed
    let enabled = agentEnabled;
    let requiresApproval = false;

    if (enabled && runtimeTools.length > 0) {
      // Check user permissions for each runtime tool
      // If any user permission denies it, the family is disabled
      for (const tool of runtimeTools) {
        const userPerm = userPermissionMap.get(tool);
        if (userPerm && !userPerm.allowed) {
          enabled = false;
          break;
        }
        if (userPerm && userPerm.requiresApproval) {
          requiresApproval = true;
        }
      }
    }

    result.push({
      toolFamily: family,
      runtimeTools,
      enabled,
      requiresApproval,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Message Persistence (unified messages table)
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * Insert a message into the unified messages table.
 * Works for both Talk messages (talk_id set) and Main channel (talk_id null, thread_id set).
 */
export function createMessage(input: {
  id: string;
  talkId?: string | null;
  threadId: string;
  role: MessageRole;
  content: string;
  agentId?: string | null;
  createdBy?: string | null;
  createdAt?: string;
  metadataJson?: string | null;
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO talk_messages (
      id, talk_id, thread_id, role, content, agent_id, created_by, created_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      input.id,
      input.talkId || null,
      input.threadId,
      input.role,
      input.content,
      input.agentId || null,
      input.createdBy || null,
      input.createdAt || new Date().toISOString(),
      input.metadataJson || null,
    );
}

// ---------------------------------------------------------------------------
// LLM Attempt Tracking
// ---------------------------------------------------------------------------

export type LlmAttemptStatus = 'success' | 'failed' | 'skipped' | 'cancelled';

/**
 * Record an LLM attempt for a run. Used for cost tracking and debugging.
 */
export function createLlmAttempt(input: {
  runId: string;
  talkId?: string | null;
  agentId?: string | null;
  providerId?: string | null;
  modelId: string;
  status: LlmAttemptStatus;
  failureClass?: string | null;
  latencyMs?: number | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCostUsd?: number | null;
  createdAt?: string;
}): number {
  const result = getDb()
    .prepare(
      `
    INSERT INTO llm_attempts (
      run_id, talk_id, agent_id,
      provider_id, model_id, status, failure_class, latency_ms,
      input_tokens, cached_input_tokens, output_tokens,
      estimated_cost_usd, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      input.runId,
      input.talkId || null,
      input.agentId || null,
      input.providerId || null,
      input.modelId,
      input.status,
      input.failureClass || null,
      input.latencyMs ?? null,
      input.inputTokens ?? null,
      input.cachedInputTokens ?? null,
      input.outputTokens ?? null,
      input.estimatedCostUsd ?? null,
      input.createdAt || new Date().toISOString(),
    );
  return Number(result.lastInsertRowid);
}
