import { withUserContext } from '../../../db.js';
import {
  listUserToolPermissions,
  upsertUserToolPermission,
  getEffectiveToolsForAgent,
  getRegisteredAgent,
  TOOL_FAMILY_MAP,
  type UserToolPermission,
  type EffectiveToolAccess,
} from '../../db/agent-accessors.js';
import type { AuthContext, ApiEnvelope } from '../types.js';

// ---------------------------------------------------------------------------
// List User Tool Permissions Route
// ---------------------------------------------------------------------------

export async function listUserToolPermissionsRoute(auth: AuthContext): Promise<{
  statusCode: number;
  body: ApiEnvelope<UserToolPermission[]>;
}> {
  try {
    const permissions = await withUserContext(auth.userId, () =>
      listUserToolPermissions(),
    );

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: permissions,
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to list tool permissions: ${String(err)}`,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Update User Tool Permission Route
// ---------------------------------------------------------------------------

interface UpdateToolPermissionBody {
  toolFamily?: unknown;
  allowed?: unknown;
  requiresApproval?: unknown;
}

export async function updateUserToolPermissionRoute(
  auth: AuthContext,
  body: UpdateToolPermissionBody,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<UserToolPermission>;
}> {
  // Validate toolFamily
  if (typeof body.toolFamily !== 'string' || !body.toolFamily.trim()) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'toolFamily is required and must be a non-empty string',
        },
      },
    };
  }

  const toolFamily = body.toolFamily.trim();

  // Validate that toolFamily is a known family
  if (!(toolFamily in TOOL_FAMILY_MAP)) {
    const validFamilies = Object.keys(TOOL_FAMILY_MAP).join(', ');
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_tool_family',
          message: `Unknown tool family '${toolFamily}'. Valid families are: ${validFamilies}`,
        },
      },
    };
  }

  // Validate allowed
  if (typeof body.allowed !== 'boolean') {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'allowed must be a boolean',
        },
      },
    };
  }

  // Validate requiresApproval
  if (typeof body.requiresApproval !== 'boolean') {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'requiresApproval must be a boolean',
        },
      },
    };
  }

  try {
    // Get the runtime tools for this family to store permissions
    const runtimeTools = TOOL_FAMILY_MAP[toolFamily] || [];

    // Store permission for each runtime tool in this family inside the
    // user's RLS scope. upsertUserToolPermission targets
    // user_tool_permissions where (user_id = auth.uid()) is enforced.
    await withUserContext(auth.userId, async () => {
      for (const tool of runtimeTools) {
        await upsertUserToolPermission({
          userId: auth.userId,
          toolId: tool,
          allowed: body.allowed as boolean,
          requiresApproval: body.requiresApproval as boolean,
        });
      }
    });

    // Return a permission object representing the family
    const permission: UserToolPermission = {
      toolId: toolFamily,
      allowed: body.allowed as boolean,
      requiresApproval: body.requiresApproval as boolean,
    };

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: permission,
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to update tool permission: ${String(err)}`,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Get Effective Tools for Agent Route
// ---------------------------------------------------------------------------

export async function getEffectiveToolsRoute(
  auth: AuthContext,
  agentId: string,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<EffectiveToolAccess[]>;
}> {
  try {
    const { agent, effectiveTools } = await withUserContext(
      auth.userId,
      async () => {
        const agentRecord = await getRegisteredAgent(agentId);
        if (!agentRecord) return { agent: null, effectiveTools: [] };
        const tools = await getEffectiveToolsForAgent(agentId);
        return { agent: agentRecord, effectiveTools: tools };
      },
    );

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

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: effectiveTools,
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to get effective tools: ${String(err)}`,
        },
      },
    };
  }
}
