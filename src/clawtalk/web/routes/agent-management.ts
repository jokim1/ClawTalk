import { getDbPg, withUserContext } from '../../../db.js';
import {
  createRegisteredAgent,
  deleteRegisteredAgent,
  getRegisteredAgent,
  listRegisteredAgents,
  toAgentSnapshot,
  updateRegisteredAgent,
  type RegisteredAgentRecord,
  type RegisteredAgentSnapshot,
} from '../../db/agent-accessors.js';
import {
  getDefaultTalkAgentId,
  getMainAgentId,
  setMainAgentId,
} from '../../agents/agent-registry.js';
import { TALK_EXECUTOR_ANTHROPIC_API_KEY } from '../../config.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

// ---------------------------------------------------------------------------
// Persona-aware snapshot returned by registered-agent routes.
//
// After the chassis purge, every agent runs through direct HTTP, so the
// execution preview collapses to "do we have a credential for the provider?".
// We still emit the legacy shape (backend / authPath / routeReason etc.) so
// the webapp's existing UI code keeps working without conditional wiring.
// ---------------------------------------------------------------------------

type ExecutionPreview = {
  surface: 'main';
  backend: 'direct_http' | null;
  authPath: 'api_key' | null;
  selectedMode: 'api' | null;
  transport: 'direct' | null;
  reasonCode: string | null;
  routeReason: 'normal' | 'no_valid_path';
  ready: boolean;
  message: string;
};

export type RegisteredAgentApiSnapshot = RegisteredAgentSnapshot & {
  executionPreview: ExecutionPreview;
};

function isAdminLike(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

async function providerHasCredential(providerId: string): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<Array<{ ok: number }>>`
    select 1 as ok from public.llm_provider_secrets
    where provider_id = ${providerId}
    limit 1
  `;
  if (rows.length > 0) return true;
  if (providerId === 'provider.anthropic') {
    return TALK_EXECUTOR_ANTHROPIC_API_KEY.trim().length > 0;
  }
  return false;
}

async function getProviderName(providerId: string): Promise<string | null> {
  const db = getDbPg();
  const rows = await db<Array<{ name: string }>>`
    select name from public.llm_providers
    where id = ${providerId}
    limit 1
  `;
  return rows[0]?.name ?? null;
}

async function buildExecutionPreview(
  record: RegisteredAgentRecord,
): Promise<ExecutionPreview> {
  const providerName =
    (await getProviderName(record.provider_id)) || record.provider_id;
  if (!(await providerHasCredential(record.provider_id))) {
    return {
      surface: 'main',
      backend: null,
      authPath: null,
      selectedMode: null,
      transport: null,
      reasonCode: 'credential_missing',
      routeReason: 'no_valid_path',
      ready: false,
      message: `No API credential is configured for ${providerName}. Add one from AI Agents → Provider Setup.`,
    };
  }
  return {
    surface: 'main',
    backend: 'direct_http',
    authPath: 'api_key',
    selectedMode: 'api',
    transport: 'direct',
    reasonCode: null,
    routeReason: 'normal',
    ready: true,
    message: `Ready to run via ${providerName} direct HTTP.`,
  };
}

async function toApiSnapshot(
  record: RegisteredAgentRecord,
): Promise<RegisteredAgentApiSnapshot> {
  return {
    ...toAgentSnapshot(record),
    executionPreview: await buildExecutionPreview(record),
  };
}

function envelopeOk<T>(data: T): { statusCode: number; body: ApiEnvelope<T> } {
  return { statusCode: 200, body: { ok: true, data } };
}

function envelopeError(
  statusCode: number,
  code: string,
  message: string,
): { statusCode: number; body: ApiEnvelope<never> } {
  return { statusCode, body: { ok: false, error: { code, message } } };
}

function readStringField(
  body: Record<string, unknown> | null,
  key: string,
): string | null | undefined {
  if (!body || !(key in body)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

// ---------------------------------------------------------------------------
// List / get
// ---------------------------------------------------------------------------

export async function listAgentsRoute(auth: AuthContext): Promise<{
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot[]>;
}> {
  return withUserContext(auth.userId, async () => {
    const records = await listRegisteredAgents();
    const snapshots = await Promise.all(records.map(toApiSnapshot));
    return envelopeOk(snapshots);
  });
}

export async function getAgentRoute(
  auth: AuthContext,
  agentId: string,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
}> {
  return withUserContext(auth.userId, async () => {
    const record = await getRegisteredAgent(agentId);
    if (!record) {
      return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
    }
    return envelopeOk(await toApiSnapshot(record));
  });
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

export async function createAgentRoute(
  auth: AuthContext,
  body: Record<string, unknown> | null,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
}> {
  if (!isAdminLike(auth.role)) {
    return envelopeError(
      403,
      'forbidden',
      'You do not have permission to create agents.',
    );
  }

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const providerId =
    typeof body?.providerId === 'string' ? body.providerId.trim() : '';
  const modelId = typeof body?.modelId === 'string' ? body.modelId.trim() : '';
  if (!name) {
    return envelopeError(400, 'invalid_input', 'name is required.');
  }
  if (!providerId) {
    return envelopeError(400, 'invalid_input', 'providerId is required.');
  }
  if (!modelId) {
    return envelopeError(400, 'invalid_input', 'modelId is required.');
  }

  let toolPermissions: Record<string, boolean> | undefined;
  if (typeof body?.toolPermissionsJson === 'string') {
    try {
      toolPermissions = JSON.parse(body.toolPermissionsJson);
    } catch (err) {
      return envelopeError(
        400,
        'invalid_input',
        err instanceof Error
          ? `toolPermissionsJson must be valid JSON: ${err.message}`
          : 'toolPermissionsJson must be valid JSON.',
      );
    }
  }
  const personaRole =
    typeof body?.personaRole === 'string' ? body.personaRole : undefined;
  const systemPrompt =
    typeof body?.systemPrompt === 'string' ? body.systemPrompt : undefined;
  const description =
    typeof body?.description === 'string' ? body.description : undefined;

  return withUserContext(auth.userId, async () => {
    try {
      const record = await createRegisteredAgent({
        ownerId: auth.userId,
        name,
        providerId,
        modelId,
        toolPermissions,
        personaRole,
        systemPrompt,
        description,
      });
      return envelopeOk(await toApiSnapshot(record));
    } catch (err) {
      return envelopeError(
        400,
        'invalid_input',
        err instanceof Error ? err.message : 'Failed to create agent.',
      );
    }
  });
}

export async function updateAgentRoute(
  auth: AuthContext,
  agentId: string,
  body: Record<string, unknown> | null,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
}> {
  if (!isAdminLike(auth.role)) {
    return envelopeError(
      403,
      'forbidden',
      'You do not have permission to update agents.',
    );
  }

  const updates: Parameters<typeof updateRegisteredAgent>[1] = {};
  if (typeof body?.name === 'string') updates.name = body.name.trim();
  if (typeof body?.providerId === 'string')
    updates.providerId = body.providerId.trim();
  if (typeof body?.modelId === 'string') updates.modelId = body.modelId.trim();
  if (typeof body?.toolPermissionsJson === 'string') {
    try {
      updates.toolPermissions = JSON.parse(body.toolPermissionsJson);
    } catch (err) {
      return envelopeError(
        400,
        'invalid_input',
        err instanceof Error
          ? `toolPermissionsJson must be valid JSON: ${err.message}`
          : 'toolPermissionsJson must be valid JSON.',
      );
    }
  }
  const personaRole = readStringField(body, 'personaRole');
  if (personaRole !== undefined) updates.personaRole = personaRole;
  const systemPrompt = readStringField(body, 'systemPrompt');
  if (systemPrompt !== undefined) updates.systemPrompt = systemPrompt;
  const description = readStringField(body, 'description');
  if (description !== undefined) updates.description = description;
  if (typeof body?.enabled === 'boolean') updates.enabled = body.enabled;

  return withUserContext(auth.userId, async () => {
    if (!(await getRegisteredAgent(agentId))) {
      return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
    }
    try {
      const updated = await updateRegisteredAgent(agentId, updates);
      if (!updated) {
        return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
      }
      return envelopeOk(await toApiSnapshot(updated));
    } catch (err) {
      return envelopeError(
        400,
        'invalid_input',
        err instanceof Error ? err.message : 'Failed to update agent.',
      );
    }
  });
}

export async function deleteAgentRoute(
  auth: AuthContext,
  agentId: string,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
}> {
  if (!isAdminLike(auth.role)) {
    return envelopeError(
      403,
      'forbidden',
      'You do not have permission to delete agents.',
    );
  }
  return withUserContext(auth.userId, async () => {
    if (agentId === (await getMainAgentId())) {
      return envelopeError(
        400,
        'invalid_input',
        'Cannot delete the main agent. Set a different main agent first.',
      );
    }
    if (agentId === (await getDefaultTalkAgentId())) {
      return envelopeError(
        400,
        'invalid_input',
        'Cannot delete the default Talk agent.',
      );
    }
    const deleted = await deleteRegisteredAgent(agentId);
    if (!deleted) {
      return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
    }
    return envelopeOk({ deleted: true } as const);
  });
}

// ---------------------------------------------------------------------------
// Main agent
// ---------------------------------------------------------------------------

export async function getMainAgentRoute(auth: AuthContext): Promise<{
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
}> {
  return withUserContext(auth.userId, async () => {
    try {
      const mainAgentId = await getMainAgentId();
      const record = await getRegisteredAgent(mainAgentId);
      if (!record) {
        return envelopeError(
          404,
          'not_found',
          `Main agent '${mainAgentId}' not found.`,
        );
      }
      return envelopeOk(await toApiSnapshot(record));
    } catch (err) {
      return envelopeError(
        404,
        'not_found',
        err instanceof Error ? err.message : 'Main agent not configured.',
      );
    }
  });
}

export async function updateMainAgentRoute(
  auth: AuthContext,
  body: Record<string, unknown> | null,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
}> {
  if (!isAdminLike(auth.role)) {
    return envelopeError(
      403,
      'forbidden',
      'You do not have permission to update the main agent.',
    );
  }
  const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : '';
  if (!agentId) {
    return envelopeError(400, 'invalid_input', 'agentId is required.');
  }
  return withUserContext(auth.userId, async () => {
    try {
      await setMainAgentId(agentId);
    } catch (err) {
      return envelopeError(
        400,
        'invalid_input',
        err instanceof Error ? err.message : 'Failed to set main agent.',
      );
    }
    const record = await getRegisteredAgent(agentId);
    if (!record) {
      return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
    }
    return envelopeOk(await toApiSnapshot(record));
  });
}

// ---------------------------------------------------------------------------
// Fallback steps — Phase 2 keeps these as read-empty / write-noop so the
// webapp routes don't 410. Wire real fallback when we revisit it.
// ---------------------------------------------------------------------------

export async function getAgentFallbackRoute(
  auth: AuthContext,
  agentId: string,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ agentId: string; steps: [] }>;
}> {
  return withUserContext(auth.userId, async () => {
    if (!(await getRegisteredAgent(agentId))) {
      return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
    }
    return envelopeOk({ agentId, steps: [] as [] });
  });
}

export async function setAgentFallbackRoute(
  auth: AuthContext,
  agentId: string,
  _body: Record<string, unknown> | null,
): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ agentId: string; steps: [] }>;
}> {
  if (!isAdminLike(auth.role)) {
    return envelopeError(
      403,
      'forbidden',
      'You do not have permission to update agent fallback.',
    );
  }
  return withUserContext(auth.userId, async () => {
    if (!(await getRegisteredAgent(agentId))) {
      return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
    }
    return envelopeOk({ agentId, steps: [] as [] });
  });
}
