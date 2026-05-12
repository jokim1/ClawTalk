import {
  attachDataConnectorToTalk,
  createDataConnector,
  deleteDataConnector,
  deleteDataConnectorCredential,
  detachDataConnectorFromTalk,
  getDataConnectorById,
  getTalkForUser,
  getUserGoogleCredential,
  listDataConnectors,
  listTalkDataConnectors,
  patchDataConnector,
  setDataConnectorCredential,
  type DataConnectorSnapshot,
  type TalkDataConnectorSnapshot,
} from '../../db/index.js';
import { decryptGoogleToolCredential } from '../../identity/google-tools-credential-store.js';
import { normalizeGoogleScopeAliases } from '../../identity/google-scopes.js';
import { DataConnectorVerifier } from '../../connectors/connector-verifier.js';
import { encryptConnectorSecret } from '../../connectors/connector-secret-store.js';
import type { ConnectorKind } from '../../connectors/types.js';
import { ApiEnvelope, AuthContext } from '../types.js';

type JsonMap = Record<string, unknown>;
const GOOGLE_SHEETS_CONNECTOR_SCOPES = [
  'spreadsheets.readonly',
  'spreadsheets',
];
const GOOGLE_DOCS_CONNECTOR_SCOPES = ['documents'];

function canManageDataConnectors(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin';
}

function normalizeJsonMap(value: unknown): JsonMap | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonMap;
}

function validateConnectorKind(value: string): ConnectorKind | null {
  if (
    value === 'google_docs' ||
    value === 'google_sheets' ||
    value === 'posthog'
  ) {
    return value;
  }
  return null;
}

function getRequiredGoogleConnectorScopes(kind: ConnectorKind): string[] {
  return kind === 'google_docs'
    ? GOOGLE_DOCS_CONNECTOR_SCOPES
    : GOOGLE_SHEETS_CONNECTOR_SCOPES;
}

function formatGoogleConnectorLabel(kind: ConnectorKind): string {
  return kind === 'google_docs' ? 'Google Docs' : 'Google Sheets';
}

function hasAnyGoogleScope(
  grantedScopes: string[],
  requiredScopes: string[],
): boolean {
  const granted = new Set(normalizeGoogleScopeAliases(grantedScopes));
  return requiredScopes.some((scope) => granted.has(scope));
}

function forbiddenResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 403,
    body: {
      ok: false,
      error: {
        code: 'forbidden',
        message,
      },
    },
  };
}

function notFoundResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 404,
    body: {
      ok: false,
      error: {
        code: 'not_found',
        message,
      },
    },
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
    body: {
      ok: false,
      error: {
        code,
        message,
      },
    },
  };
}

export interface DataConnectorsListRecord {
  connectors: DataConnectorSnapshot[];
}

export interface TalkDataConnectorsListRecord {
  talkId: string;
  connectors: TalkDataConnectorSnapshot[];
}

export function listDataConnectorsRoute(input: { auth: AuthContext }): {
  statusCode: number;
  body: ApiEnvelope<DataConnectorsListRecord>;
} {
  if (!canManageDataConnectors(input.auth)) {
    return forbiddenResponse(
      'You do not have permission to manage data connectors.',
    );
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        connectors: listDataConnectors(),
      },
    },
  };
}

export function createDataConnectorRoute(input: {
  auth: AuthContext;
  name: string;
  connectorKind: string;
  config?: unknown;
  enabled?: boolean;
}): {
  statusCode: number;
  body: ApiEnvelope<{ connector: DataConnectorSnapshot }>;
} {
  if (!canManageDataConnectors(input.auth)) {
    return forbiddenResponse(
      'You do not have permission to manage data connectors.',
    );
  }

  const name = input.name.trim();
  if (!name) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_name',
          message: 'A connector name is required.',
        },
      },
    };
  }

  const connectorKind = validateConnectorKind(input.connectorKind);
  if (!connectorKind) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_connector_kind',
          message: 'A supported connector kind is required.',
        },
      },
    };
  }

  const connector = createDataConnector({
    name,
    connectorKind,
    config: normalizeJsonMap(input.config) ?? {},
    enabled: input.enabled !== false,
    createdBy: input.auth.userId,
  });

  return {
    statusCode: 201,
    body: {
      ok: true,
      data: {
        connector,
      },
    },
  };
}

export function patchDataConnectorRoute(input: {
  auth: AuthContext;
  connectorId: string;
  name?: string;
  config?: unknown;
  enabled?: boolean;
  verifier: DataConnectorVerifier;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ connector: DataConnectorSnapshot }>;
}> {
  return (async () => {
    if (!canManageDataConnectors(input.auth)) {
      return forbiddenResponse(
        'You do not have permission to manage data connectors.',
      );
    }

    const existing = getDataConnectorById(input.connectorId);
    if (!existing) {
      return notFoundResponse('Data connector not found.');
    }

    const nextName = input.name !== undefined ? input.name.trim() : undefined;
    if (input.name !== undefined && !nextName) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_name',
            message: 'A connector name is required.',
          },
        },
      };
    }

    const connector = patchDataConnector({
      connectorId: input.connectorId,
      name: nextName,
      config:
        input.config !== undefined
          ? (normalizeJsonMap(input.config) ?? {})
          : undefined,
      enabled: input.enabled,
      updatedBy: input.auth.userId,
    });

    if (!connector) {
      return notFoundResponse('Data connector not found.');
    }

    let verified = connector;
    if (
      verified.hasCredential &&
      verified.verificationStatus === 'not_verified'
    ) {
      verified = await input.verifier.verify(verified.id);
    }

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          connector: verified,
        },
      },
    };
  })();
}

export function deleteDataConnectorRoute(input: {
  auth: AuthContext;
  connectorId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  if (!canManageDataConnectors(input.auth)) {
    return forbiddenResponse(
      'You do not have permission to manage data connectors.',
    );
  }

  const deleted = deleteDataConnector(input.connectorId);
  if (!deleted) {
    return notFoundResponse('Data connector not found.');
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        deleted: true,
      },
    },
  };
}

export function setDataConnectorCredentialRoute(input: {
  auth: AuthContext;
  connectorId: string;
  apiKey?: string | null;
  useGoogleAccount?: boolean;
  clearCredential?: boolean;
  verifier: DataConnectorVerifier;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ connector: DataConnectorSnapshot }>;
}> {
  return (async () => {
    if (!canManageDataConnectors(input.auth)) {
      return forbiddenResponse(
        'You do not have permission to manage data connectors.',
      );
    }

    const connector = getDataConnectorById(input.connectorId);
    if (!connector) {
      return notFoundResponse('Data connector not found.');
    }

    const apiKey = input.apiKey?.trim() || null;
    const useGoogleAccount = input.useGoogleAccount === true;
    const clearCredential = input.clearCredential === true;
    if (useGoogleAccount && clearCredential) {
      return invalidResponse(
        'invalid_credential_action',
        'Choose either linked Google account save or credential clear, not both.',
      );
    }
    let updated: DataConnectorSnapshot | undefined;

    if (connector.connectorKind === 'posthog') {
      if (useGoogleAccount || clearCredential) {
        return {
          statusCode: 400,
          body: {
            ok: false,
            error: {
              code: 'unsupported_connector_kind',
              message: 'PostHog connectors only support API key credentials.',
            },
          },
        };
      }
      updated = apiKey
        ? setDataConnectorCredential({
            connectorId: input.connectorId,
            ciphertext: encryptConnectorSecret({
              kind: 'posthog',
              apiKey,
            }),
            updatedBy: input.auth.userId,
          })
        : deleteDataConnectorCredential(input.connectorId, input.auth.userId);
    } else if (
      connector.connectorKind === 'google_sheets' ||
      connector.connectorKind === 'google_docs'
    ) {
      const googleConnectorLabel = formatGoogleConnectorLabel(
        connector.connectorKind,
      );
      const requiredScopes = getRequiredGoogleConnectorScopes(
        connector.connectorKind,
      );

      if (clearCredential) {
        updated = deleteDataConnectorCredential(
          input.connectorId,
          input.auth.userId,
        );
      } else if (useGoogleAccount) {
        const googleCredential = getUserGoogleCredential(input.auth.userId);
        if (!googleCredential) {
          return invalidResponse(
            'google_account_not_connected',
            `Connect a Google account before using it for a ${googleConnectorLabel} connector.`,
          );
        }

        let payload;
        try {
          payload = decryptGoogleToolCredential(googleCredential.ciphertext);
        } catch {
          return invalidResponse(
            'google_credential_invalid',
            'Stored Google account credential is invalid. Reconnect your Google account and try again.',
          );
        }

        if (!hasAnyGoogleScope(payload.scopes, requiredScopes)) {
          return invalidResponse(
            'google_scopes_missing',
            `Linked Google account is missing ${googleConnectorLabel} access. Grant ${googleConnectorLabel} permissions and try again.`,
          );
        }

        updated = setDataConnectorCredential({
          connectorId: input.connectorId,
          ciphertext: encryptConnectorSecret({
            kind: connector.connectorKind,
            accessToken: payload.accessToken,
            refreshToken: payload.refreshToken,
            expiryDate: payload.expiryDate,
            scopes: normalizeGoogleScopeAliases(payload.scopes),
          }),
          updatedBy: input.auth.userId,
        });
      } else {
        return {
          statusCode: 400,
          body: {
            ok: false,
            error: {
              code: 'oauth_required',
              message: `${googleConnectorLabel} connectors require a linked Google account credential.`,
            },
          },
        };
      }
    } else {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'unsupported_connector_kind',
            message:
              'This connector kind does not support direct API key storage.',
          },
        },
      };
    }

    if (!updated) {
      return notFoundResponse('Data connector not found.');
    }

    let verified = updated;
    if (
      (apiKey || useGoogleAccount) &&
      updated.verificationStatus === 'not_verified'
    ) {
      verified = await input.verifier.verify(updated.id);
    }

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          connector: verified,
        },
      },
    };
  })();
}

export function listTalkDataConnectorsRoute(input: {
  auth: AuthContext;
  talkId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<TalkDataConnectorsListRecord>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFoundResponse('Talk not found.');
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        connectors: listTalkDataConnectors(input.talkId),
      },
    },
  };
}

export function attachTalkDataConnectorRoute(input: {
  auth: AuthContext;
  talkId: string;
  connectorId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ connector: TalkDataConnectorSnapshot }>;
} {
  if (!canManageDataConnectors(input.auth)) {
    return forbiddenResponse(
      'You do not have permission to attach data connectors to talks.',
    );
  }

  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFoundResponse('Talk not found.');
  }
  if (!input.connectorId.trim()) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_connector_id',
          message: 'A connectorId is required.',
        },
      },
    };
  }

  const connector = getDataConnectorById(input.connectorId);
  if (!connector) {
    return notFoundResponse('Data connector not found.');
  }
  if (!connector.enabled) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'connector_disabled',
          message: 'Only enabled data connectors can be attached to talks.',
        },
      },
    };
  }
  if (connector.verificationStatus !== 'verified') {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'connector_not_verified',
          message: `Only verified connectors can be attached to talks (current status: ${connector.verificationStatus}).`,
        },
      },
    };
  }

  const attached = attachDataConnectorToTalk({
    talkId: input.talkId,
    connectorId: input.connectorId,
    userId: input.auth.userId,
  });
  if (!attached) {
    return notFoundResponse('Data connector not found.');
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        connector: attached,
      },
    },
  };
}

export function detachTalkDataConnectorRoute(input: {
  auth: AuthContext;
  talkId: string;
  connectorId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  if (!canManageDataConnectors(input.auth)) {
    return forbiddenResponse(
      'You do not have permission to detach data connectors from talks.',
    );
  }

  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFoundResponse('Talk not found.');
  }

  const deleted = detachDataConnectorFromTalk(input.talkId, input.connectorId);
  if (!deleted) {
    return notFoundResponse('Data connector attachment not found.');
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        deleted: true,
      },
    },
  };
}
