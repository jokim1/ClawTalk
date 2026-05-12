import { describe, expect, it, vi } from 'vitest';

import { encryptConnectorSecret } from './connector-secret-store.js';
import { executeConnectorTool } from './tool-executors.js';
import type { TalkRunConnectorRecord } from '../db/connector-accessors.js';

function createPostHogConnector(): TalkRunConnectorRecord {
  return {
    id: 'connector-posthog',
    name: 'FTUE PostHog',
    connectorKind: 'posthog',
    config: {
      hostUrl: 'https://posthog.example.test',
      projectId: '12345',
    },
    discovered: {
      projectName: 'FTUE',
      eventNames: ['session_started'],
    },
    enabled: true,
    hasCredential: true,
    verificationStatus: 'verified',
    lastVerifiedAt: '2024-01-01T00:00:00.000Z',
    lastVerificationError: null,
    attachedTalkCount: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ciphertext: encryptConnectorSecret({
      kind: 'posthog',
      apiKey: 'phc_test_key',
    }),
  };
}

function createGoogleSheetsConnector(): TalkRunConnectorRecord {
  return {
    id: 'connector-sheets',
    name: 'Economy Sheet',
    connectorKind: 'google_sheets',
    config: {
      spreadsheetId: 'sheet-123',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-123',
    },
    discovered: {
      sheets: [],
    },
    enabled: true,
    hasCredential: true,
    verificationStatus: 'verified',
    lastVerifiedAt: '2024-01-01T00:00:00.000Z',
    lastVerificationError: null,
    attachedTalkCount: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ciphertext: encryptConnectorSecret({
      kind: 'google_sheets',
      accessToken: 'ya29.test',
      refreshToken: 'refresh-test',
      expiryDate: new Date(Date.now() + 10 * 60_000).toISOString(),
    }),
  };
}

function createGoogleDocsConnector(): TalkRunConnectorRecord {
  return {
    id: 'connector-docs',
    name: 'Season Preview Doc',
    connectorKind: 'google_docs',
    config: {
      documentId: 'doc-123',
      documentUrl: 'https://docs.google.com/document/d/doc-123/edit',
    },
    discovered: {
      title: 'Season Preview',
    },
    enabled: true,
    hasCredential: true,
    verificationStatus: 'verified',
    lastVerifiedAt: '2024-01-01T00:00:00.000Z',
    lastVerificationError: null,
    attachedTalkCount: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ciphertext: encryptConnectorSecret({
      kind: 'google_docs',
      accessToken: 'ya29.docs',
      refreshToken: 'refresh-docs',
      expiryDate: new Date(Date.now() + 10 * 60_000).toISOString(),
    }),
  };
}

describe('executeConnectorTool', () => {
  it('rejects PostHog queries that exceed the bounded date window', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch should not be called');
    });

    const result = await executeConnectorTool(
      'connector_connector-posthog__posthog_query',
      {
        query: 'SELECT count() FROM events',
        dateFrom: '2024-01-01',
        dateTo: '2024-05-01',
      },
      {
        connector: createPostHogConnector(),
        signal: new AbortController().signal,
        fetchImpl,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('90 days');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires PostHog dateFrom/dateTo to be provided together', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch should not be called');
    });

    const result = await executeConnectorTool(
      'connector_connector-posthog__posthog_query',
      {
        query: 'SELECT count() FROM events',
        dateFrom: '2024-01-01',
      },
      {
        connector: createPostHogConnector(),
        signal: new AbortController().signal,
        fetchImpl,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('provided together');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists sheets via the live spreadsheet metadata endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const targetUrl = String(url);
      expect(targetUrl).toContain('/v4/spreadsheets/sheet-123');
      expect(targetUrl).toContain('fields=sheets.properties');
      return new Response(
        JSON.stringify({
          sheets: [
            {
              properties: {
                title: 'Revenue',
                gridProperties: { rowCount: 1000, columnCount: 12 },
              },
            },
            {
              properties: {
                title: 'Summary',
                gridProperties: { rowCount: 100, columnCount: 4 },
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    const result = await executeConnectorTool(
      'connector_connector-sheets__list_sheets',
      {},
      {
        connector: createGoogleSheetsConnector(),
        signal: new AbortController().signal,
        fetchImpl,
      },
    );

    expect(result.isError).toBe(false);
    expect(result.displaySummary).toContain('Economy Sheet');
    expect(result.content).toContain('Revenue');
    expect(result.content).toContain('Summary');
  });

  it('requires an A1-style range for Google Sheets reads', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch should not be called');
    });

    const result = await executeConnectorTool(
      'connector_connector-sheets__read_range',
      {},
      {
        connector: createGoogleSheetsConnector(),
        signal: new AbortController().signal,
        fetchImpl,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('A1-style range');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads a Google Doc through the connector runtime', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const targetUrl = String(url);
      expect(targetUrl).toContain('/v1/documents/doc-123');
      return new Response(
        JSON.stringify({
          title: 'Season Preview',
          body: {
            content: [
              {
                paragraph: {
                  elements: [
                    {
                      textRun: {
                        content: 'Cal should win seven games.\n',
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    const result = await executeConnectorTool(
      'connector_connector-docs__read_document',
      {},
      {
        connector: createGoogleDocsConnector(),
        signal: new AbortController().signal,
        fetchImpl,
      },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Season Preview');
    expect(result.content).toContain('Cal should win seven games.');
  });

  it('validates Google Docs batch update requests', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch should not be called');
    });

    const result = await executeConnectorTool(
      'connector_connector-docs__batch_update',
      {},
      {
        connector: createGoogleDocsConnector(),
        signal: new AbortController().signal,
        fetchImpl,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('non-empty requests array');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
