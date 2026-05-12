import {
  BUILTIN_TALK_TOOLS,
  createGoogleOAuthLinkRequest,
  createTalkResourceBinding,
  deleteTalkResourceBinding,
  getUserGoogleCredential,
  initializeTalkToolGrants,
  listTalkResourceBindings,
  listTalkToolGrants,
  replaceTalkToolGrants,
  type BuiltinTalkToolDefinition,
  type TalkResourceBindingKind,
} from '../../db/talk-tools-accessors.js';
import {
  canUserEditTalk,
  getTalkForUser,
  getUserById,
  listTalkAttachments,
  listTalkContextSources,
  listTalkDataConnectors,
  getRegisteredAgentSnapshot,
} from '../../db/index.js';
import { listTalkAgents } from '../../agents/agent-registry.js';
import { startGoogleOAuth } from '../../identity/auth-service.js';
import { buildGooglePickerSession } from '../../identity/google-tools-service.js';
import { hashOpaqueToken } from '../../security/hash.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

type JsonMap = Record<string, unknown>;

type EffectiveAccessState =
  | 'available'
  | 'unavailable_due_to_route'
  | 'unavailable_due_to_identity'
  | 'unavailable_due_to_pending_scopes'
  | 'unavailable_due_to_scope'
  | 'unavailable_due_to_config'
  | 'unavailable_due_to_missing_resource';

export interface TalkToolRegistryEntryApiRecord {
  id: string;
  family: BuiltinTalkToolDefinition['family'];
  displayName: string;
  description: string | null;
  enabled: boolean;
  installStatus: 'installed';
  healthStatus: 'healthy';
  authRequirements: JsonMap | null;
  mutatesExternalState: boolean;
  requiresBinding: boolean;
  defaultGrant: boolean;
  sortOrder: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface TalkToolGrantApiRecord {
  toolId: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export interface TalkResourceBindingApiRecord {
  id: string;
  kind: TalkResourceBindingKind;
  externalId: string;
  displayName: string;
  metadata: JsonMap | null;
  createdAt: string;
  createdBy: string | null;
}

export interface UserGoogleAccountApiRecord {
  connected: boolean;
  email: string | null;
  displayName: string | null;
  scopes: string[];
  accessExpiresAt: string | null;
}

export interface TalkToolAccessByAgentApiRecord {
  agentId: string;
  nickname: string;
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  modelId: string | null;
  toolAccess: Array<{
    toolId: string;
    state: EffectiveAccessState;
  }>;
}

export interface TalkToolsApiRecord {
  talkId: string;
  registry: TalkToolRegistryEntryApiRecord[];
  grants: TalkToolGrantApiRecord[];
  bindings: TalkResourceBindingApiRecord[];
  googleAccount: UserGoogleAccountApiRecord;
  summary: string[];
  warnings: string[];
  effectiveAccess: TalkToolAccessByAgentApiRecord[];
}

function notFoundResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 404,
    body: { ok: false, error: { code: 'not_found', message } },
  };
}

function forbiddenResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 403,
    body: { ok: false, error: { code: 'forbidden', message } },
  };
}

function invalidResponse(
  code: string,
  message: string,
): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 400,
    body: { ok: false, error: { code, message } },
  };
}

function toGoogleAccountApiRecord(userId: string): UserGoogleAccountApiRecord {
  const credential = getUserGoogleCredential(userId);
  if (!credential) {
    return {
      connected: false,
      email: null,
      displayName: null,
      scopes: [],
      accessExpiresAt: null,
    };
  }
  return {
    connected: true,
    email: credential.email,
    displayName: credential.displayName,
    scopes: credential.scopes,
    accessExpiresAt: credential.accessExpiresAt,
  };
}

// Keep this mapping in sync with webapp/src/pages/TalkDetailPage.tsx.
function requiredScopesForTool(toolId: string): string[] {
  switch (toolId) {
    case 'gmail_read':
      return ['gmail.readonly'];
    case 'gmail_send':
      return ['gmail.send'];
    case 'google_drive_search':
    case 'google_drive_read':
    case 'google_drive_list_folder':
      return ['drive.readonly'];
    case 'google_docs_read':
      return ['documents.readonly'];
    case 'google_docs_batch_update':
      return ['documents'];
    case 'google_sheets_read_range':
      return ['spreadsheets.readonly'];
    case 'google_sheets_batch_update':
      return ['spreadsheets'];
    default:
      return [];
  }
}

function hasRelevantResources(input: {
  toolId: string;
  bindingsCount: number;
  sourcesCount: number;
  attachmentsCount: number;
  connectorCount: number;
}): boolean {
  switch (input.toolId) {
    case 'saved_sources':
      return input.sourcesCount > 0;
    case 'attachments':
      return input.attachmentsCount > 0;
    case 'data_connectors':
      return input.connectorCount > 0;
    case 'google_drive_search':
    case 'google_drive_read':
    case 'google_drive_list_folder':
    case 'google_docs_read':
    case 'google_docs_batch_update':
    case 'google_sheets_read_range':
    case 'google_sheets_batch_update':
      return input.bindingsCount > 0;
    default:
      return true;
  }
}

function computeToolState(input: {
  toolId: string;
  grantEnabled: boolean;
  requiresBinding: boolean;
  bindingsCount: number;
  sourcesCount: number;
  attachmentsCount: number;
  connectorCount: number;
  googleConnected: boolean;
  grantedScopes: Set<string>;
  toolCapable: boolean;
}): EffectiveAccessState {
  if (!input.grantEnabled) return 'unavailable_due_to_config';
  if (!input.toolCapable) return 'unavailable_due_to_route';

  const requiredScopes = requiredScopesForTool(input.toolId);
  if (requiredScopes.length > 0 && !input.googleConnected) {
    return 'unavailable_due_to_identity';
  }
  if (
    requiredScopes.length > 0 &&
    requiredScopes.some((scope) => !input.grantedScopes.has(scope))
  ) {
    return 'unavailable_due_to_pending_scopes';
  }
  if (
    input.requiresBinding &&
    !hasRelevantResources({
      toolId: input.toolId,
      bindingsCount: input.bindingsCount,
      sourcesCount: input.sourcesCount,
      attachmentsCount: input.attachmentsCount,
      connectorCount: input.connectorCount,
    })
  ) {
    return 'unavailable_due_to_missing_resource';
  }
  return 'available';
}

function summarizeCapabilities(input: {
  grants: Map<string, boolean>;
  bindingsCount: number;
  googleAccount: UserGoogleAccountApiRecord;
  grantedScopes: Set<string>;
}): string[] {
  const summary: string[] = [];
  const add = (text: string) => {
    if (!summary.includes(text)) summary.push(text);
  };
  const hasAllScopes = (toolIds: string[]): boolean =>
    toolIds.every((toolId) =>
      requiredScopesForTool(toolId).every((scope) =>
        input.grantedScopes.has(scope),
      ),
    );

  if (input.grants.get('web_search') || input.grants.get('web_fetch')) {
    add('This Talk can search the web');
  }

  const googleToolIds = [
    'google_drive_search',
    'google_drive_read',
    'google_drive_list_folder',
    'google_docs_read',
    'google_docs_batch_update',
    'google_sheets_read_range',
    'google_sheets_batch_update',
  ].filter((toolId) => input.grants.get(toolId) === true);

  if (googleToolIds.length > 0) {
    if (input.bindingsCount === 0) {
      add('Google Drive unavailable — bind a file or folder to enable');
    } else if (!input.googleAccount.connected) {
      add('Google Drive tools need a connected Google account');
    } else if (!hasAllScopes(googleToolIds)) {
      add('Google Drive tools need additional Google permissions');
    } else {
      add('This Talk can use bound Drive files');
    }
  }

  if (input.grants.get('gmail_send')) {
    add(
      input.googleAccount.connected && hasAllScopes(['gmail_send'])
        ? 'Email sends require user approval'
        : 'Gmail send needs additional Google permissions',
    );
  }

  return summary;
}

function buildTalkToolsRecord(input: {
  talkId: string;
  userId: string;
}): TalkToolsApiRecord {
  const talk = getTalkForUser(input.talkId, input.userId);
  if (!talk) {
    throw new Error('talk_not_found');
  }

  initializeTalkToolGrants(input.talkId, input.userId);
  const grants = listTalkToolGrants(input.talkId);
  const bindings = listTalkResourceBindings(input.talkId);
  const googleAccount = toGoogleAccountApiRecord(input.userId);
  const grantedScopes = new Set(googleAccount.scopes);
  const grantMap = new Map(
    grants.map((grant) => [grant.toolId, grant.enabled]),
  );
  const boundDriveResources = bindings.filter(
    (binding) =>
      binding.bindingKind === 'google_drive_folder' ||
      binding.bindingKind === 'google_drive_file',
  );
  const sourcesCount = listTalkContextSources(input.talkId).length;
  const attachmentsCount = listTalkAttachments(input.talkId).length;
  const connectorCount = listTalkDataConnectors(input.talkId).length;
  const registry = BUILTIN_TALK_TOOLS.map((tool) => ({
    id: tool.id,
    family: tool.family,
    displayName: tool.displayName,
    description: tool.description,
    enabled: true,
    installStatus: 'installed' as const,
    healthStatus: 'healthy' as const,
    authRequirements: null,
    mutatesExternalState: tool.mutatesExternalState,
    requiresBinding: tool.requiresBinding,
    defaultGrant: tool.defaultGrant,
    sortOrder: tool.sortOrder,
    updatedAt:
      grants.find((grant) => grant.toolId === tool.id)?.updatedAt ||
      talk.updated_at,
    updatedBy:
      grants.find((grant) => grant.toolId === tool.id)?.updatedBy || null,
  }));

  const effectiveAccess = listTalkAgents(input.talkId).map((assignment) => {
    const snapshot = getRegisteredAgentSnapshot(assignment.agentId);
    return {
      agentId: assignment.agentId,
      nickname: assignment.nickname,
      sourceKind: 'provider' as const,
      providerId: snapshot?.providerId || null,
      modelId: snapshot?.modelId || null,
      toolAccess: registry.map((entry) => ({
        toolId: entry.id,
        state: computeToolState({
          toolId: entry.id,
          grantEnabled: grantMap.get(entry.id) === true,
          requiresBinding: entry.requiresBinding,
          bindingsCount: boundDriveResources.length,
          sourcesCount,
          attachmentsCount,
          connectorCount,
          googleConnected: googleAccount.connected,
          grantedScopes,
          toolCapable: true,
        }),
      })),
    };
  });

  return {
    talkId: input.talkId,
    registry,
    grants: grants.map((grant) => ({
      toolId: grant.toolId,
      enabled: grant.enabled,
      updatedAt: grant.updatedAt,
      updatedBy: grant.updatedBy,
    })),
    bindings: bindings.map((binding) => ({
      id: binding.id,
      kind: binding.bindingKind,
      externalId: binding.externalId,
      displayName: binding.displayName,
      metadata: binding.metadata,
      createdAt: binding.createdAt,
      createdBy: binding.createdBy,
    })),
    googleAccount,
    summary: summarizeCapabilities({
      grants: grantMap,
      bindingsCount: boundDriveResources.length,
      googleAccount,
      grantedScopes,
    }),
    warnings: [],
    effectiveAccess,
  };
}

export function getTalkToolsRoute(input: {
  auth: AuthContext;
  talkId: string;
}): { statusCode: number; body: ApiEnvelope<TalkToolsApiRecord> } {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: buildTalkToolsRecord({
        talkId: input.talkId,
        userId: input.auth.userId,
      }),
    },
  };
}

export function updateTalkToolGrantsRoute(input: {
  auth: AuthContext;
  talkId: string;
  grants: Array<{ toolId: string; enabled: boolean }>;
}): { statusCode: number; body: ApiEnvelope<TalkToolsApiRecord> } {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  if (!canUserEditTalk(input.talkId, input.auth.userId)) {
    return forbiddenResponse(
      'You do not have permission to update Talk tools.',
    );
  }

  const validToolIds = new Set(BUILTIN_TALK_TOOLS.map((tool) => tool.id));
  const invalidGrant = input.grants.find(
    (grant) => !validToolIds.has(grant.toolId),
  );
  if (invalidGrant) {
    return invalidResponse(
      'invalid_tool_id',
      `Tool "${invalidGrant.toolId}" is not registered.`,
    );
  }

  initializeTalkToolGrants(input.talkId, input.auth.userId);
  const currentById = new Map(
    listTalkToolGrants(input.talkId).map((grant) => [
      grant.toolId,
      grant.enabled,
    ]),
  );
  const requestedById = new Map(
    input.grants.map((grant) => [grant.toolId, grant.enabled]),
  );
  replaceTalkToolGrants({
    talkId: input.talkId,
    grants: BUILTIN_TALK_TOOLS.map((tool) => ({
      toolId: tool.id,
      enabled: requestedById.get(tool.id) ?? currentById.get(tool.id) ?? false,
    })),
    updatedBy: input.auth.userId,
  });

  return getTalkToolsRoute(input);
}

export function listTalkResourcesRoute(input: {
  auth: AuthContext;
  talkId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    bindings: TalkResourceBindingApiRecord[];
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        bindings: listTalkResourceBindings(input.talkId).map((binding) => ({
          id: binding.id,
          kind: binding.bindingKind,
          externalId: binding.externalId,
          displayName: binding.displayName,
          metadata: binding.metadata,
          createdAt: binding.createdAt,
          createdBy: binding.createdBy,
        })),
      },
    },
  };
}

export function createTalkResourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  kind: TalkResourceBindingKind;
  externalId: string;
  displayName: string;
  metadata?: JsonMap | null;
}): {
  statusCode: number;
  body: ApiEnvelope<{ binding: TalkResourceBindingApiRecord }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  if (!canUserEditTalk(input.talkId, input.auth.userId)) {
    return forbiddenResponse(
      'You do not have permission to bind Talk resources.',
    );
  }

  const externalId = input.externalId.trim();
  const displayName = input.displayName.trim();
  if (!externalId || !displayName) {
    return invalidResponse(
      'invalid_binding',
      'Resource bindings require both an external id and display name.',
    );
  }
  if (
    input.kind !== 'google_drive_folder' &&
    input.kind !== 'google_drive_file'
  ) {
    return invalidResponse(
      'unsupported_resource_kind',
      `Resource kind "${input.kind}" is not supported in this release.`,
    );
  }

  const binding = createTalkResourceBinding({
    talkId: input.talkId,
    bindingKind: input.kind,
    externalId,
    displayName,
    metadata: input.metadata ?? null,
    createdBy: input.auth.userId,
  });
  return {
    statusCode: 201,
    body: {
      ok: true,
      data: {
        binding: {
          id: binding.id,
          kind: binding.bindingKind,
          externalId: binding.externalId,
          displayName: binding.displayName,
          metadata: binding.metadata,
          createdAt: binding.createdAt,
          createdBy: binding.createdBy,
        },
      },
    },
  };
}

export function deleteTalkResourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  resourceId: string;
}): { statusCode: number; body: ApiEnvelope<{ deleted: true }> } {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  if (!canUserEditTalk(input.talkId, input.auth.userId)) {
    return forbiddenResponse(
      'You do not have permission to remove Talk resources.',
    );
  }
  if (!deleteTalkResourceBinding(input.talkId, input.resourceId)) {
    return notFoundResponse('Talk resource binding not found.');
  }
  return {
    statusCode: 200,
    body: { ok: true, data: { deleted: true } },
  };
}

export function getUserGoogleAccountRoute(input: { auth: AuthContext }): {
  statusCode: number;
  body: ApiEnvelope<{ googleAccount: UserGoogleAccountApiRecord }>;
} {
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        googleAccount: toGoogleAccountApiRecord(input.auth.userId),
      },
    },
  };
}

export function startUserGoogleAccountConnectRoute(input: {
  auth: AuthContext;
  scopes?: string[];
  returnTo?: string | null;
  redirectUri?: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ authorizationUrl: string; expiresInSec: number }>;
} {
  const user = getUserById(input.auth.userId);
  if (!user || user.is_active !== 1) {
    return notFoundResponse('User not found.');
  }
  const scopes = Array.from(
    new Set((input.scopes || []).map((scope) => scope.trim()).filter(Boolean)),
  );
  const start = startGoogleOAuth({
    redirectUri: input.redirectUri,
    returnTo: input.returnTo || '/app/talks',
    scopes,
  });
  createGoogleOAuthLinkRequest({
    stateHash: hashOpaqueToken(start.state),
    userId: input.auth.userId,
    scopes,
  });
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        authorizationUrl: start.authorizationUrl,
        expiresInSec: start.expiresInSec,
      },
    },
  };
}

export function startUserGoogleScopeExpansionRoute(input: {
  auth: AuthContext;
  scopes: string[];
  returnTo?: string | null;
  redirectUri?: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ authorizationUrl: string; expiresInSec: number }>;
} {
  const current = getUserGoogleCredential(input.auth.userId);
  if (!current) {
    return invalidResponse(
      'google_account_not_connected',
      'Google account is not connected.',
    );
  }
  const scopes = Array.from(
    new Set(input.scopes.map((scope) => scope.trim()).filter(Boolean)),
  );
  if (scopes.length === 0) {
    return invalidResponse('invalid_scopes', 'At least one scope is required.');
  }
  const start = startGoogleOAuth({
    redirectUri: input.redirectUri,
    returnTo: input.returnTo || '/app/talks',
    scopes,
  });
  createGoogleOAuthLinkRequest({
    stateHash: hashOpaqueToken(start.state),
    userId: input.auth.userId,
    scopes,
  });
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        authorizationUrl: start.authorizationUrl,
        expiresInSec: start.expiresInSec,
      },
    },
  };
}

export async function getGooglePickerSessionRoute(input: {
  auth: AuthContext;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{
    oauthToken: string;
    developerKey: string;
    appId: string;
  }>;
  noStore?: boolean;
}> {
  try {
    const session = await buildGooglePickerSession(input.auth.userId);
    return {
      statusCode: 200,
      body: { ok: true, data: session },
      noStore: true,
    };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      'status' in error &&
      typeof (error as { code: unknown }).code === 'string' &&
      typeof (error as { status: unknown }).status === 'number'
    ) {
      return {
        statusCode: (error as { status: number }).status,
        body: {
          ok: false,
          error: {
            code: (error as { code: string }).code,
            message:
              error instanceof Error
                ? error.message
                : 'Failed to create Google Picker session.',
          },
        },
      };
    }
    throw error;
  }
}
