import { getDb } from '../../db.js';
import type { LlmToolDefinition } from '../agents/llm-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of checking user permissions for a tool family.
 * If no permission record exists, defaults to permissive (allowed: true, requiresApproval: false).
 */
export interface UserPermissionCheck {
  allowed: boolean;
  requiresApproval: boolean;
}

// ---------------------------------------------------------------------------
// Permission Checking Functions
// ---------------------------------------------------------------------------

/**
 * Check if a user is allowed to use a specific tool family.
 *
 * Query: SELECT allowed, requires_approval FROM user_tool_permissions
 *        WHERE user_id = ? AND tool_id = ?
 *
 * Default behavior (no record found):
 * - allowed: true (permissive default for single-user startup)
 * - requiresApproval: false
 *
 * @param userId - User ID to check
 * @param toolFamily - Tool family name (e.g., 'shell', 'web', 'gmail_send')
 * @returns Permission check result
 */
export function checkUserToolPermission(
  userId: string,
  toolFamily: string,
): UserPermissionCheck {
  const db = getDb();

  const record: any = db
    .prepare(
      `
    SELECT allowed, requires_approval
    FROM user_tool_permissions
    WHERE user_id = ? AND tool_id = ?
  `,
    )
    .get(userId, toolFamily);

  if (!record) {
    // Default: permissive for single-user startup
    return {
      allowed: true,
      requiresApproval: false,
    };
  }

  return {
    allowed: record.allowed === 1,
    requiresApproval: record.requires_approval === 1,
  };
}

/**
 * Shorthand to check if a tool family requires approval for a user.
 *
 * @param userId - User ID
 * @param toolFamily - Tool family name
 * @returns Boolean indicating if approval is required
 */
export function requiresApproval(userId: string, toolFamily: string): boolean {
  const check = checkUserToolPermission(userId, toolFamily);
  return check.requiresApproval;
}

// ---------------------------------------------------------------------------
// Tool Filtering Functions
// ---------------------------------------------------------------------------

/**
 * Filter tool definitions against user permissions.
 *
 * Removes tools that the user explicitly disallowed.
 * Tools with no explicit permission record are included by default (permissive).
 *
 * Tool names in LlmToolDefinition.name are matched against user permissions
 * to extract the tool family. This requires a name-to-family mapping
 * (TODO: define mapping for known tools).
 *
 * For now, assumes tool names directly correspond to tool families.
 *
 * @param userId - User ID
 * @param tools - Array of tool definitions to filter
 * @returns Filtered array containing only allowed tools
 */
export function filterToolsByUserPermissions(
  userId: string,
  tools: LlmToolDefinition[],
): LlmToolDefinition[] {
  return tools.filter((tool) => {
    // Extract tool family from tool name
    // TODO: Use proper name-to-family mapping once available
    const toolFamily = tool.name.toLowerCase();
    const check = checkUserToolPermission(userId, toolFamily);
    return check.allowed;
  });
}

/**
 * Get the set of tools that require user approval.
 *
 * Returns tool names (from definitions) that have requiresApproval = true
 * for the given user.
 *
 * Useful for UI to highlight which tool calls will trigger approval gates.
 *
 * @param userId - User ID
 * @param tools - Array of tool definitions to check
 * @returns Array of tool names that require approval
 */
export function getApprovalRequiredTools(
  userId: string,
  tools: LlmToolDefinition[],
): string[] {
  return tools
    .filter((tool) => {
      // Extract tool family from tool name
      // TODO: Use proper name-to-family mapping once available
      const toolFamily = tool.name.toLowerCase();
      const check = checkUserToolPermission(userId, toolFamily);
      return check.requiresApproval;
    })
    .map((tool) => tool.name);
}

// ---------------------------------------------------------------------------
// Permission Management Functions
// ---------------------------------------------------------------------------

/**
 * Upsert a user permission for a tool family.
 *
 * Creates or updates the permission record for a user/tool_id pair.
 *
 * @param userId - User ID
 * @param toolFamily - Tool family name
 * @param allowed - Whether the tool is allowed
 * @param requiresApproval - Whether approval is required before using the tool
 */
export function setUserPermission(
  userId: string,
  toolFamily: string,
  allowed: boolean,
  requiresApproval: boolean,
): void {
  const db = getDb();

  db.prepare(
    `
    INSERT INTO user_tool_permissions (user_id, tool_id, allowed, requires_approval, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, tool_id) DO UPDATE SET
      allowed = excluded.allowed,
      requires_approval = excluded.requires_approval,
      updated_at = excluded.updated_at
  `,
  ).run(userId, toolFamily, allowed ? 1 : 0, requiresApproval ? 1 : 0);
}

/**
 * Get all permissions for a user, keyed by tool family.
 *
 * Returns a map of tool_id -> UserPermissionCheck for all
 * explicit permission records owned by the user.
 *
 * Does NOT include default permissions (allowed: true, requiresApproval: false)
 * for tool families with no explicit record.
 *
 * @param userId - User ID
 * @returns Map of tool family -> permission check result
 */
export function getUserPermissions(
  userId: string,
): Map<string, UserPermissionCheck> {
  const db = getDb();

  const records: any[] = db
    .prepare(
      `
    SELECT tool_id, allowed, requires_approval
    FROM user_tool_permissions
    WHERE user_id = ?
    ORDER BY tool_id ASC
  `,
    )
    .all(userId);

  const result = new Map<string, UserPermissionCheck>();
  for (const record of records) {
    result.set(record.tool_id, {
      allowed: record.allowed === 1,
      requiresApproval: record.requires_approval === 1,
    });
  }

  return result;
}
