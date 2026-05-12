import {
  listRegisteredAgents,
  getRegisteredAgent,
  createRegisteredAgent,
  updateRegisteredAgent,
  deleteRegisteredAgent,
  getFallbackSteps,
  setFallbackSteps,
  validateToolPermissionsJson,
  toAgentSnapshot,
  type RegisteredAgentSnapshot,
  type RegisteredAgentRecord,
  type AgentFallbackStep,
} from '../../db/agent-accessors.js';
import { getMainAgentId, setMainAgentId } from '../../agents/agent-registry.js';
import { buildMainExecutionPreview } from '../../agents/execution-preview.js';
import type { AuthContext, ApiEnvelope } from '../types.js';

export type RegisteredAgentApiSnapshot = RegisteredAgentSnapshot & {
  executionPreview: ReturnType<typeof buildMainExecutionPreview>;
};

function attachExecutionPreview(
  record: RegisteredAgentRecord,
  auth: AuthContext,
): RegisteredAgentApiSnapshot {
  return {
    ...toAgentSnapshot(record),
    executionPreview: buildMainExecutionPreview(record, auth.userId),
  };
}

// ---------------------------------------------------------------------------
// Auth Checks
// ---------------------------------------------------------------------------

function isAdminLike(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

// ---------------------------------------------------------------------------
// List Agents Route
// ---------------------------------------------------------------------------

export function listAgentsRoute(auth: AuthContext): {
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot[]>;
} {
  try {
    const agents = listRegisteredAgents();
    const snapshots = agents.map((agent) =>
      attachExecutionPreview(agent, auth),
    );

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: snapshots,
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to list agents: ${String(err)}`,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Get Single Agent Route
// ---------------------------------------------------------------------------

export function getAgentRoute(
  auth: AuthContext,
  agentId: string,
): {
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
} {
  try {
    const record = getRegisteredAgent(agentId);
    if (!record) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'not_found',
            message: `Agent '${agentId}' not found`,
          },
        },
      };
    }

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: attachExecutionPreview(record, auth),
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to get agent: ${String(err)}`,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Create Agent Route
// ---------------------------------------------------------------------------

interface CreateAgentBody {
  name?: unknown;
  providerId?: unknown;
  modelId?: unknown;
  toolPermissionsJson?: unknown;
  personaRole?: unknown;
  systemPrompt?: unknown;
}

export function createAgentRoute(
  auth: AuthContext,
  body: CreateAgentBody,
): {
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
} {
  // Auth check
  if (!isAdminLike(auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to create agents',
        },
      },
    };
  }

  // Validate required fields
  if (typeof body.name !== 'string' || !body.name.trim()) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'name is required and must be a non-empty string',
        },
      },
    };
  }

  if (typeof body.providerId !== 'string' || !body.providerId.trim()) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'providerId is required and must be a non-empty string',
        },
      },
    };
  }

  if (typeof body.modelId !== 'string' || !body.modelId.trim()) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'modelId is required and must be a non-empty string',
        },
      },
    };
  }

  // Validate tool_permissions_json if provided
  let toolPermissionsJson: string | undefined;
  if (body.toolPermissionsJson !== undefined) {
    if (typeof body.toolPermissionsJson !== 'string') {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: 'toolPermissionsJson must be a JSON string',
          },
        },
      };
    }

    const validation = validateToolPermissionsJson(body.toolPermissionsJson);
    if (!validation.valid) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_tool_permissions',
            message: validation.error || 'Invalid tool permissions',
          },
        },
      };
    }

    toolPermissionsJson = body.toolPermissionsJson;
  }

  // Validate optional string fields
  const personaRole =
    typeof body.personaRole === 'string'
      ? body.personaRole.trim() || undefined
      : undefined;
  const systemPrompt =
    typeof body.systemPrompt === 'string'
      ? body.systemPrompt.trim() || undefined
      : undefined;

  try {
    const created = createRegisteredAgent({
      name: body.name.trim(),
      providerId: body.providerId.trim(),
      modelId: body.modelId.trim(),
      toolPermissionsJson,
      personaRole,
      systemPrompt,
    });

    return {
      statusCode: 201,
      body: {
        ok: true,
        data: attachExecutionPreview(created, auth),
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to create agent: ${String(err)}`,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Update Agent Route
// ---------------------------------------------------------------------------

interface UpdateAgentBody {
  name?: unknown;
  providerId?: unknown;
  modelId?: unknown;
  toolPermissionsJson?: unknown;
  personaRole?: unknown;
  systemPrompt?: unknown;
  enabled?: unknown;
}

export function updateAgentRoute(
  auth: AuthContext,
  agentId: string,
  body: UpdateAgentBody,
): {
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
} {
  // Auth check
  if (!isAdminLike(auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to update agents',
        },
      },
    };
  }

  // Check if agent exists
  const existing = getRegisteredAgent(agentId);
  if (!existing) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'not_found',
          message: `Agent '${agentId}' not found`,
        },
      },
    };
  }

  // Build update object
  const updates: Parameters<typeof updateRegisteredAgent>[1] = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: 'name must be a non-empty string',
          },
        },
      };
    }
    updates.name = body.name.trim();
  }

  if (body.providerId !== undefined) {
    if (typeof body.providerId !== 'string' || !body.providerId.trim()) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: 'providerId must be a non-empty string',
          },
        },
      };
    }
    updates.providerId = body.providerId.trim();
  }

  if (body.modelId !== undefined) {
    if (typeof body.modelId !== 'string' || !body.modelId.trim()) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: 'modelId must be a non-empty string',
          },
        },
      };
    }
    updates.modelId = body.modelId.trim();
  }

  if (body.toolPermissionsJson !== undefined) {
    if (typeof body.toolPermissionsJson !== 'string') {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: 'toolPermissionsJson must be a JSON string',
          },
        },
      };
    }

    const validation = validateToolPermissionsJson(body.toolPermissionsJson);
    if (!validation.valid) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_tool_permissions',
            message: validation.error || 'Invalid tool permissions',
          },
        },
      };
    }

    updates.toolPermissionsJson = body.toolPermissionsJson;
  }

  if (body.personaRole !== undefined) {
    updates.personaRole =
      typeof body.personaRole === 'string'
        ? body.personaRole.trim() || null
        : null;
  }

  if (body.systemPrompt !== undefined) {
    updates.systemPrompt =
      typeof body.systemPrompt === 'string'
        ? body.systemPrompt.trim() || null
        : null;
  }

  if (body.enabled !== undefined) {
    updates.enabled = body.enabled === true;
  }

  try {
    const updated = updateRegisteredAgent(agentId, updates);
    if (!updated) {
      return {
        statusCode: 500,
        body: {
          ok: false,
          error: {
            code: 'internal_error',
            message: 'Failed to update agent (no result returned)',
          },
        },
      };
    }

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: attachExecutionPreview(updated, auth),
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to update agent: ${String(err)}`,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Delete Agent Route
// ---------------------------------------------------------------------------

export function deleteAgentRoute(
  auth: AuthContext,
  agentId: string,
): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  // Auth check
  if (!isAdminLike(auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to delete agents',
        },
      },
    };
  }

  // Prevent deletion of main agent
  try {
    const mainAgentId = getMainAgentId();
    if (agentId === mainAgentId) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_operation',
            message: 'Cannot delete the main agent',
          },
        },
      };
    }
  } catch {
    // If main agent is not configured, allow deletion to proceed
  }

  try {
    const deleted = deleteRegisteredAgent(agentId);
    if (!deleted) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'not_found',
            message: `Agent '${agentId}' not found`,
          },
        },
      };
    }

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: { deleted: true },
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to delete agent: ${String(err)}`,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Get Agent Fallback Steps Route
// ---------------------------------------------------------------------------

export function getAgentFallbackRoute(
  auth: AuthContext,
  agentId: string,
): {
  statusCode: number;
  body: ApiEnvelope<AgentFallbackStep[]>;
} {
  try {
    // Verify agent exists
    const agent = getRegisteredAgent(agentId);
    if (!agent) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'not_found',
            message: `Agent '${agentId}' not found`,
          },
        },
      };
    }

    const steps = getFallbackSteps(agentId);

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: steps,
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to get fallback steps: ${String(err)}`,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Set Agent Fallback Steps Route
// ---------------------------------------------------------------------------

interface SetFallbackBody {
  steps?: unknown;
}

export function setAgentFallbackRoute(
  auth: AuthContext,
  agentId: string,
  body: SetFallbackBody,
): {
  statusCode: number;
  body: ApiEnvelope<AgentFallbackStep[]>;
} {
  // Auth check
  if (!isAdminLike(auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to manage agent fallback steps',
        },
      },
    };
  }

  // Verify agent exists
  const agent = getRegisteredAgent(agentId);
  if (!agent) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'not_found',
          message: `Agent '${agentId}' not found`,
        },
      },
    };
  }

  // Validate steps
  if (!Array.isArray(body.steps)) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'steps must be an array',
        },
      },
    };
  }

  const steps: Array<{ providerId: string; modelId: string }> = [];

  for (let i = 0; i < body.steps.length; i++) {
    const rawStep = body.steps[i];
    if (!rawStep || typeof rawStep !== 'object') {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: `Step ${i} must be an object`,
          },
        },
      };
    }

    const step = rawStep as Record<string, unknown>;

    if (typeof step.providerId !== 'string' || !step.providerId.trim()) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: `Step ${i}: providerId is required and must be a non-empty string`,
          },
        },
      };
    }

    if (typeof step.modelId !== 'string' || !step.modelId.trim()) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: `Step ${i}: modelId is required and must be a non-empty string`,
          },
        },
      };
    }

    steps.push({
      providerId: step.providerId.trim(),
      modelId: step.modelId.trim(),
    });
  }

  try {
    setFallbackSteps(agentId, steps);

    const updatedSteps = getFallbackSteps(agentId);

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: updatedSteps,
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to set fallback steps: ${String(err)}`,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Get Main Agent Route
// ---------------------------------------------------------------------------

export function getMainAgentRoute(auth: AuthContext): {
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
} {
  try {
    const record = getRegisteredAgent(getMainAgentId());
    if (!record) {
      throw new Error('Main agent is not configured.');
    }

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: attachExecutionPreview(record, auth),
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to get main agent: ${String(err)}`,
        },
      },
    };
  }
}

/**
 * PUT /api/v1/registered-agents/main
 *
 * Set the system-wide main agent. Requires admin/owner role.
 * Body: { agentId: string }
 */
export function updateMainAgentRoute(
  auth: AuthContext,
  body: unknown,
): {
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
} {
  if (!isAdminLike(auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'Only admins can change the main agent.',
        },
      },
    };
  }

  const parsed = body as Record<string, unknown> | null;
  const agentId =
    parsed && typeof parsed.agentId === 'string' ? parsed.agentId.trim() : '';

  if (!agentId) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'agentId is required.',
        },
      },
    };
  }

  try {
    const record = getRegisteredAgent(agentId);
    if (!record || record.enabled !== 1) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'agent_not_found',
            message: 'Selected main agent was not found or is disabled.',
          },
        },
      };
    }

    const preview = buildMainExecutionPreview(record, auth.userId);
    if (!preview.ready) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_main_agent',
            message: preview.message,
          },
        },
      };
    }

    setMainAgentId(agentId);
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: attachExecutionPreview(record, auth),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isNotFound =
      message.includes('not found') || message.includes('disabled');
    return {
      statusCode: isNotFound ? 404 : 500,
      body: {
        ok: false,
        error: {
          code: isNotFound ? 'agent_not_found' : 'internal_error',
          message,
        },
      },
    };
  }
}
