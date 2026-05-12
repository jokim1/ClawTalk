import {
  getDataConnectorById,
  getDataConnectorCredential,
  patchDataConnectorDiscovery,
  upsertDataConnectorVerification,
  type DataConnectorSnapshot,
} from '../db/index.js';

import { decryptConnectorSecret } from './connector-secret-store.js';
import {
  ConnectorHttpError,
  fetchGoogleDoc,
  fetchGoogleSheetsMetadata,
  fetchPostHogEventDefinitions,
} from './http.js';
import {
  parseGoogleDocsConnectorConfig,
  parseGoogleSheetsConnectorConfig,
  parsePostHogConnectorConfig,
} from './runtime.js';

function classifyVerificationFailure(error: unknown): {
  status: 'invalid' | 'unavailable';
  message: string;
} {
  if (error instanceof ConnectorHttpError) {
    if (
      error.status === 401 ||
      error.status === 403 ||
      error.code.endsWith('_invalid')
    ) {
      return {
        status: 'invalid',
        message: error.message,
      };
    }
    return {
      status: 'unavailable',
      message: error.message,
    };
  }

  return {
    status: 'unavailable',
    message:
      error instanceof Error ? error.message : 'Connector verification failed.',
  };
}

export class DataConnectorVerifier {
  private readonly fetchImpl: typeof fetch;
  private readonly inFlight = new Map<string, Promise<DataConnectorSnapshot>>();

  constructor(input?: { fetchImpl?: typeof fetch }) {
    this.fetchImpl = input?.fetchImpl || fetch;
  }

  verify(connectorId: string): Promise<DataConnectorSnapshot> {
    const existing = this.inFlight.get(connectorId);
    if (existing) {
      return existing;
    }

    const task = this.verifyInternal(connectorId).finally(() => {
      this.inFlight.delete(connectorId);
    });
    this.inFlight.set(connectorId, task);
    return task;
  }

  private async verifyInternal(
    connectorId: string,
  ): Promise<DataConnectorSnapshot> {
    const connector = getDataConnectorById(connectorId);
    if (!connector) {
      throw new Error(`data connector not found: ${connectorId}`);
    }

    const secretRecord = getDataConnectorCredential(connectorId);
    if (!secretRecord) {
      return connector;
    }

    upsertDataConnectorVerification({
      connectorId,
      status: 'verifying',
      lastError: null,
      lastVerifiedAt: connector.lastVerifiedAt,
    });

    const controller = new AbortController();
    try {
      const secret = decryptConnectorSecret(secretRecord.ciphertext);
      if (connector.connectorKind === 'posthog') {
        const config = parsePostHogConnectorConfig(connector.config);
        if (!config) {
          throw new ConnectorHttpError(
            'posthog_config_invalid',
            'PostHog connector requires hostUrl and projectId.',
          );
        }
        if (secret.kind !== 'posthog') {
          throw new ConnectorHttpError(
            'posthog_credential_invalid',
            'Stored connector credential is not a PostHog API key.',
          );
        }

        const discovery = await fetchPostHogEventDefinitions({
          hostUrl: config.hostUrl,
          projectId: config.projectId,
          secret,
          fetchImpl: this.fetchImpl,
          signal: controller.signal,
        });

        patchDataConnectorDiscovery(connectorId, {
          projectId: config.projectId,
          projectName: discovery.projectName,
          eventNames: discovery.eventNames,
        });
      } else if (connector.connectorKind === 'google_sheets') {
        const config = parseGoogleSheetsConnectorConfig(connector.config);
        if (!config) {
          throw new ConnectorHttpError(
            'google_sheets_config_invalid',
            'Google Sheets connector requires spreadsheetId.',
          );
        }
        if (secret.kind !== 'google_sheets') {
          throw new ConnectorHttpError(
            'google_sheets_credential_invalid',
            'Stored connector credential is not a Google Sheets OAuth credential.',
          );
        }

        const discovery = await fetchGoogleSheetsMetadata({
          connectorId,
          secret,
          spreadsheetId: config.spreadsheetId,
          fetchImpl: this.fetchImpl,
          signal: controller.signal,
        });

        patchDataConnectorDiscovery(connectorId, {
          sheets: discovery.sheets.map((sheet) => ({
            title: sheet.title,
            rowCount: sheet.rowCount,
            columnCount: sheet.columnCount,
          })),
        });
      } else if (connector.connectorKind === 'google_docs') {
        const config = parseGoogleDocsConnectorConfig(connector.config);
        if (!config) {
          throw new ConnectorHttpError(
            'google_docs_config_invalid',
            'Google Docs connector requires documentId.',
          );
        }
        if (secret.kind !== 'google_docs') {
          throw new ConnectorHttpError(
            'google_docs_credential_invalid',
            'Stored connector credential is not a Google Docs OAuth credential.',
          );
        }

        const document = await fetchGoogleDoc({
          connectorId,
          secret,
          documentId: config.documentId,
          fetchImpl: this.fetchImpl,
          signal: controller.signal,
        });

        patchDataConnectorDiscovery(connectorId, {
          title: document.title,
        });
      } else {
        throw new ConnectorHttpError(
          'connector_kind_unsupported',
          `Unsupported connector kind: ${connector.connectorKind}.`,
        );
      }

      upsertDataConnectorVerification({
        connectorId,
        status: 'verified',
        lastError: null,
        lastVerifiedAt: new Date().toISOString(),
      });
    } catch (error) {
      const classified = classifyVerificationFailure(error);
      upsertDataConnectorVerification({
        connectorId,
        status: classified.status,
        lastError: classified.message,
        lastVerifiedAt: new Date().toISOString(),
      });
    }

    const updated = getDataConnectorById(connectorId);
    if (!updated) {
      throw new Error(`data connector not found after verify: ${connectorId}`);
    }
    return updated;
  }
}
