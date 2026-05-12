import { getDb } from '../../../db.js';
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

function providerHasCredential(providerId: string): boolean {
  if (providerId === 'provider.anthropic') {
    const row = getDb()
      .prepare(
        `SELECT 1 FROM llm_provider_secrets WHERE provider_id = ? LIMIT 1`,
      )
      .get(providerId) as { 1: number } | undefined;
    if (row) return true;
    return TALK_EXECUTOR_ANTHROPIC_API_KEY.trim().length > 0;
  }
  const row = getDb()
    .prepare(
      `SELECT 1 FROM llm_provider_secrets WHERE provider_id = ? LIMIT 1`,
    )
    .get(providerId) as { 1: number } | undefined;
  return !!row;
}

function getProviderName(providerId: string): string | null {
  const row = getDb()
    .prepare(`SELECT name FROM llm_providers WHERE id = ? LIMIT 1`)
    .get(providerId) as { name: string } | undefined;
  return row?.name ?? null;
}

function buildExecutionPreview(record: RegisteredAgentRecord): ExecutionPreview {
  const providerName = getProviderName(record.provider_id) || record.provider_id;
  if (!providerHasCredential(record.provider_id)) {
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

function toApiSnapshot(record: RegisteredAgentRecord): RegisteredAgentApiSnapshot {
  return {
    ...toAgentSnapshot(record),
    executionPreview: buildExecutionPreview(record),
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

export function listAgentsRoute(_auth: AuthContext): {
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot[]>;
} {
  const records = listRegisteredAgents();
  return envelopeOk(records.map(toApiSnapshot));
}

export function getAgentRoute(_auth: AuthContext, agentId: string): {
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
} {
  const record = getRegisteredAgent(agentId);
  if (!record) {
    return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
  }
  return envelopeOk(toApiSnapshot(record));
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

export function createAgentRoute(
  auth: AuthContext,
  body: Record<string, unknown> | null,
): {
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
} {
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

  const toolPermissionsJson =
    typeof body?.toolPermissionsJson === 'string'
      ? body.toolPermissionsJson
      : undefined;
  const personaRole =
    typeof body?.personaRole === 'string' ? body.personaRole : undefined;
  const systemPrompt =
    typeof body?.systemPrompt === 'string' ? body.systemPrompt : undefined;
  const description =
    typeof body?.description === 'string' ? body.description : undefined;

  try {
    const record = createRegisteredAgent({
      name,
      providerId,
      modelId,
      toolPermissionsJson,
      personaRole,
      systemPrompt,
      description,
    });
    return envelopeOk(toApiSnapshot(record));
  } catch (err) {
    return envelopeError(
      400,
      'invalid_input',
      err instanceof Error ? err.message : 'Failed to create agent.',
    );
  }
}

export function updateAgentRoute(
  auth: AuthContext,
  agentId: string,
  body: Record<string, unknown> | null,
): {
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
} {
  if (!isAdminLike(auth.role)) {
    return envelopeError(
      403,
      'forbidden',
      'You do not have permission to update agents.',
    );
  }
  if (!getRegisteredAgent(agentId)) {
    return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
  }

  const updates: Parameters<typeof updateRegisteredAgent>[1] = {};
  if (typeof body?.name === 'string') updates.name = body.name.trim();
  if (typeof body?.providerId === 'string')
    updates.providerId = body.providerId.trim();
  if (typeof body?.modelId === 'string') updates.modelId = body.modelId.trim();
  if (typeof body?.toolPermissionsJson === 'string')
    updates.toolPermissionsJson = body.toolPermissionsJson;
  const personaRole = readStringField(body, 'personaRole');
  if (personaRole !== undefined) updates.personaRole = personaRole;
  const systemPrompt = readStringField(body, 'systemPrompt');
  if (systemPrompt !== undefined) updates.systemPrompt = systemPrompt;
  const description = readStringField(body, 'description');
  if (description !== undefined) updates.description = description;
  if (typeof body?.enabled === 'boolean') updates.enabled = body.enabled;

  try {
    const updated = updateRegisteredAgent(agentId, updates);
    if (!updated) {
      return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
    }
    return envelopeOk(toApiSnapshot(updated));
  } catch (err) {
    return envelopeError(
      400,
      'invalid_input',
      err instanceof Error ? err.message : 'Failed to update agent.',
    );
  }
}

export function deleteAgentRoute(
  auth: AuthContext,
  agentId: string,
): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  if (!isAdminLike(auth.role)) {
    return envelopeError(
      403,
      'forbidden',
      'You do not have permission to delete agents.',
    );
  }
  if (agentId === getMainAgentId()) {
    return envelopeError(
      400,
      'invalid_input',
      'Cannot delete the main agent. Set a different main agent first.',
    );
  }
  if (agentId === getDefaultTalkAgentId()) {
    return envelopeError(
      400,
      'invalid_input',
      'Cannot delete the default Talk agent.',
    );
  }
  const deleted = deleteRegisteredAgent(agentId);
  if (!deleted) {
    return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
  }
  return envelopeOk({ deleted: true } as const);
}

// ---------------------------------------------------------------------------
// Main agent
// ---------------------------------------------------------------------------

export function getMainAgentRoute(_auth: AuthContext): {
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
} {
  try {
    const mainAgentId = getMainAgentId();
    const record = getRegisteredAgent(mainAgentId);
    if (!record) {
      return envelopeError(
        404,
        'not_found',
        `Main agent '${mainAgentId}' not found.`,
      );
    }
    return envelopeOk(toApiSnapshot(record));
  } catch (err) {
    return envelopeError(
      404,
      'not_found',
      err instanceof Error ? err.message : 'Main agent not configured.',
    );
  }
}

export function updateMainAgentRoute(
  auth: AuthContext,
  body: Record<string, unknown> | null,
): {
  statusCode: number;
  body: ApiEnvelope<RegisteredAgentApiSnapshot>;
} {
  if (!isAdminLike(auth.role)) {
    return envelopeError(
      403,
      'forbidden',
      'You do not have permission to update the main agent.',
    );
  }
  const agentId =
    typeof body?.agentId === 'string' ? body.agentId.trim() : '';
  if (!agentId) {
    return envelopeError(400, 'invalid_input', 'agentId is required.');
  }
  try {
    setMainAgentId(agentId);
  } catch (err) {
    return envelopeError(
      400,
      'invalid_input',
      err instanceof Error ? err.message : 'Failed to set main agent.',
    );
  }
  const record = getRegisteredAgent(agentId);
  if (!record) {
    return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
  }
  return envelopeOk(toApiSnapshot(record));
}

// ---------------------------------------------------------------------------
// Fallback steps — Phase 2 keeps these as read-empty / write-noop so the
// webapp routes don't 410. Wire real fallback when we revisit it.
// ---------------------------------------------------------------------------

export function getAgentFallbackRoute(
  _auth: AuthContext,
  agentId: string,
): {
  statusCode: number;
  body: ApiEnvelope<{ agentId: string; steps: [] }>;
} {
  if (!getRegisteredAgent(agentId)) {
    return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
  }
  return envelopeOk({ agentId, steps: [] });
}

export function setAgentFallbackRoute(
  auth: AuthContext,
  agentId: string,
  _body: Record<string, unknown> | null,
): {
  statusCode: number;
  body: ApiEnvelope<{ agentId: string; steps: [] }>;
} {
  if (!isAdminLike(auth.role)) {
    return envelopeError(
      403,
      'forbidden',
      'You do not have permission to update agent fallback.',
    );
  }
  if (!getRegisteredAgent(agentId)) {
    return envelopeError(404, 'not_found', `Agent '${agentId}' not found.`);
  }
  return envelopeOk({ agentId, steps: [] });
}
