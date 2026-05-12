import { afterEach, describe, expect, it, vi } from 'vitest';

import { decryptConnectorSecret } from './connector-secret-store.js';
import type { ConnectorSecretPayload } from './types.js';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

function createGoogleSheetsSecret(input: {
  accessToken: string;
  refreshToken: string;
  expiryDate?: string | null;
}): Extract<ConnectorSecretPayload, { kind: 'google_sheets' }> {
  return {
    kind: 'google_sheets',
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiryDate: input.expiryDate ?? null,
  };
}

async function importHttpModule() {
  vi.resetModules();

  const replaceCredentialMock = vi.fn();
  vi.doMock('../config.js', () => ({
    GOOGLE_OAUTH_CLIENT_ID: 'google-client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'google-client-secret',
  }));
  vi.doMock('../db/index.js', () => ({
    replaceDataConnectorCredentialCiphertext: replaceCredentialMock,
  }));

  const http = await import('./http.js');
  return {
    http,
    replaceCredentialMock,
  };
}

describe('connector http helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('deduplicates concurrent Google Sheets refreshes per connector', async () => {
    const { http, replaceCredentialMock } = await importHttpModule();
    const secret = createGoogleSheetsSecret({
      accessToken: 'expired-token',
      refreshToken: 'refresh-old',
      expiryDate: new Date(Date.now() - 60_000).toISOString(),
    });

    let tokenCalls = 0;
    let metadataCalls = 0;
    let releaseTokenResponse!: (response: Response) => void;
    const tokenResponse = new Promise<Response>((resolve) => {
      releaseTokenResponse = resolve;
    });

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const targetUrl = String(url);
      if (targetUrl === GOOGLE_TOKEN_ENDPOINT) {
        tokenCalls += 1;
        return tokenResponse;
      }
      if (targetUrl.includes('/v4/spreadsheets/sheet-123')) {
        metadataCalls += 1;
        return new Response(
          JSON.stringify({
            sheets: [
              {
                properties: {
                  title: 'Revenue',
                  gridProperties: { rowCount: 100, columnCount: 6 },
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      throw new Error(`unexpected fetch: ${targetUrl}`);
    });

    const pendingOne = http.fetchGoogleSheetsMetadata({
      connectorId: 'connector-sheets',
      secret,
      spreadsheetId: 'sheet-123',
      fetchImpl: fetchImpl as typeof fetch,
      signal: new AbortController().signal,
    });
    const pendingTwo = http.fetchGoogleSheetsMetadata({
      connectorId: 'connector-sheets',
      secret,
      spreadsheetId: 'sheet-123',
      fetchImpl: fetchImpl as typeof fetch,
      signal: new AbortController().signal,
    });

    await Promise.resolve();
    expect(tokenCalls).toBe(1);

    releaseTokenResponse(
      new Response(
        JSON.stringify({
          access_token: 'fresh-token',
          refresh_token: 'refresh-rotated',
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const [metadataOne, metadataTwo] = await Promise.all([
      pendingOne,
      pendingTwo,
    ]);

    expect(metadataOne).toEqual(metadataTwo);
    expect(metadataCalls).toBe(2);
    expect(replaceCredentialMock).toHaveBeenCalledTimes(1);

    const persistedCiphertext = replaceCredentialMock.mock.calls[0]?.[0]
      ?.ciphertext as string;
    const refreshed = decryptConnectorSecret(persistedCiphertext);
    expect(refreshed).toMatchObject({
      kind: 'google_sheets',
      accessToken: 'fresh-token',
      refreshToken: 'refresh-rotated',
    });
  });

  it('refreshes Google Sheets credentials after a 401 and retries the request', async () => {
    const { http, replaceCredentialMock } = await importHttpModule();
    const secret = createGoogleSheetsSecret({
      accessToken: 'stale-token',
      refreshToken: 'refresh-old',
      expiryDate: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

    let sheetsCallCount = 0;
    const authorizationHeaders: string[] = [];
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const targetUrl = String(url);
        if (targetUrl.includes('/v4/spreadsheets/sheet-123/values/')) {
          sheetsCallCount += 1;
          authorizationHeaders.push(
            new Headers(init?.headers).get('authorization') || '',
          );
          if (sheetsCallCount === 1) {
            return new Response('{}', {
              status: 401,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(
            JSON.stringify({
              range: 'Revenue!1:2',
              values: [['step', 'users']],
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }

        if (targetUrl === GOOGLE_TOKEN_ENDPOINT) {
          return new Response(
            JSON.stringify({
              access_token: 'retry-token',
              refresh_token: 'refresh-new',
              expires_in: 3600,
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }

        throw new Error(`unexpected fetch: ${targetUrl}`);
      },
    );

    const result = await http.fetchGoogleSheetRange({
      connectorId: 'connector-sheets',
      secret,
      spreadsheetId: 'sheet-123',
      range: 'Revenue!1:2',
      fetchImpl: fetchImpl as typeof fetch,
      signal: new AbortController().signal,
      maxBytes: 1024,
    });

    expect(result).toEqual({
      range: 'Revenue!1:2',
      values: [['step', 'users']],
    });
    expect(sheetsCallCount).toBe(2);
    expect(authorizationHeaders).toEqual([
      'Bearer stale-token',
      'Bearer retry-token',
    ]);
    expect(replaceCredentialMock).toHaveBeenCalledTimes(1);

    const persistedCiphertext = replaceCredentialMock.mock.calls[0]?.[0]
      ?.ciphertext as string;
    const refreshed = decryptConnectorSecret(persistedCiphertext);
    expect(refreshed).toMatchObject({
      kind: 'google_sheets',
      accessToken: 'retry-token',
      refreshToken: 'refresh-new',
    });
  });

  it('rejects oversized connector responses before consuming the full stream', async () => {
    const { http } = await importHttpModule();
    const secret = createGoogleSheetsSecret({
      accessToken: 'valid-token',
      refreshToken: 'refresh-old',
      expiryDate: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

    const encoder = new TextEncoder();
    let pullCount = 0;
    const fetchImpl = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pullCount += 1;
            if (pullCount === 1) {
              controller.enqueue(
                encoder.encode('{"values":"' + 'x'.repeat(40)),
              );
              return;
            }
            if (pullCount === 2) {
              controller.enqueue(encoder.encode('y'.repeat(40)));
              return;
            }
            controller.enqueue(encoder.encode('"}'));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    await expect(
      http.fetchGoogleSheetRange({
        connectorId: 'connector-sheets',
        secret,
        spreadsheetId: 'sheet-123',
        range: 'Revenue!1:2',
        fetchImpl: fetchImpl as typeof fetch,
        signal: new AbortController().signal,
        maxBytes: 16,
      }),
    ).rejects.toMatchObject({
      code: 'connector_response_too_large',
    });
    expect(pullCount).toBeLessThan(3);
  });

  it('parses normal small JSON connector responses', async () => {
    const { http } = await importHttpModule();

    const result = await http.runPostHogQuery({
      hostUrl: 'https://posthog.example.test',
      projectId: '12345',
      secret: {
        kind: 'posthog',
        apiKey: 'phc_test_key',
      },
      query: 'SELECT 1',
      limit: 10,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            results: [{ total: 42 }],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )) as typeof fetch,
      signal: new AbortController().signal,
      maxBytes: 1024,
    });

    expect(result).toEqual({
      results: [{ total: 42 }],
    });
  });

  it('sends PostHog query to URL with trailing slash to avoid Django 301 redirect', async () => {
    const { http } = await importHttpModule();
    let capturedUrl = '';

    await http.runPostHogQuery({
      hostUrl: 'https://us.posthog.com',
      projectId: '99999',
      secret: {
        kind: 'posthog',
        apiKey: 'phc_test_key',
      },
      query: 'SELECT event FROM events LIMIT 5',
      limit: 100,
      fetchImpl: (async (url: string | URL | Request) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
      signal: new AbortController().signal,
    });

    expect(capturedUrl).toBe(
      'https://us.posthog.com/api/projects/99999/query/',
    );
  });
});
