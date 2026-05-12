import {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
} from '../config.js';
import { replaceDataConnectorCredentialCiphertext } from '../db/index.js';

import { encryptConnectorSecret } from './connector-secret-store.js';
import {
  type GoogleSheetDiscoveryItem,
  type GoogleSheetsConnectorDiscovery,
} from './runtime.js';
import type { ConnectorSecretPayload } from './types.js';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_DOCS_BASE_URL = 'https://docs.googleapis.com';
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const GOOGLE_REFRESH_SKEW_MS = 60_000;
const DEFAULT_ABORT_MESSAGE = 'Connector request aborted.';

type JsonMap = Record<string, unknown>;
type GoogleDocsSecret = Extract<
  ConnectorSecretPayload,
  { kind: 'google_docs' }
>;
type GoogleSheetsSecret = Extract<
  ConnectorSecretPayload,
  { kind: 'google_sheets' }
>;

// Single-flight is keyed by connector ID, not by the observed stale refresh
// token. Concurrent callers for one connector converge on the same refresh and
// then read the newly persisted credential on subsequent requests.
const googleSheetsRefreshInFlight = new Map<
  string,
  Promise<GoogleSheetsSecret>
>();
const googleDocsRefreshInFlight = new Map<string, Promise<GoogleDocsSecret>>();

export class ConnectorHttpError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ConnectorHttpError';
    this.code = code;
    this.status = status;
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function parseJsonMap(value: unknown): JsonMap | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonMap)
    : null;
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(
    typeof reason === 'string' && reason ? reason : DEFAULT_ABORT_MESSAGE,
  );
  error.name = 'AbortError';
  return error;
}

function waitForPromiseWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal.reason));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settleResolve = (value: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = () => settleReject(abortError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        settleResolve(value);
      },
      (error) => {
        settleReject(error);
      },
    );
  });
}

async function readResponseText(
  response: Response,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new ConnectorHttpError(
        'connector_response_too_large',
        'Connector response exceeded the maximum allowed size.',
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader
          .cancel('connector_response_too_large')
          .catch(() => undefined);
        throw new ConnectorHttpError(
          'connector_response_too_large',
          'Connector response exceeded the maximum allowed size.',
        );
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    'utf8',
  );
}

async function readJsonResponse(
  response: Response,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<JsonMap> {
  const text = await readResponseText(response, maxBytes);

  try {
    const parsed = JSON.parse(text) as unknown;
    const map = parseJsonMap(parsed);
    if (!map) {
      throw new Error('Connector response was not a JSON object.');
    }
    return map;
  } catch (error) {
    throw new ConnectorHttpError(
      'connector_invalid_response',
      error instanceof Error
        ? error.message
        : 'Connector returned invalid JSON.',
    );
  }
}

function buildPostHogAuthHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
}

function isGoogleSecretExpired(
  secret: GoogleSheetsSecret | GoogleDocsSecret,
): boolean {
  if (!secret.expiryDate) return false;
  const expiresAt = Date.parse(secret.expiryDate);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt <= Date.now() + GOOGLE_REFRESH_SKEW_MS;
}

async function performGoogleSheetsSecretRefresh(input: {
  connectorId: string;
  secret: GoogleSheetsSecret;
  fetchImpl: typeof fetch;
}): Promise<Extract<ConnectorSecretPayload, { kind: 'google_sheets' }>> {
  if (!input.secret.refreshToken) {
    throw new ConnectorHttpError(
      'google_sheets_refresh_unavailable',
      'Google Sheets access token expired and no refresh token is available.',
    );
  }
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new ConnectorHttpError(
      'google_sheets_refresh_unavailable',
      'Google OAuth client credentials are not configured for Sheets token refresh.',
    );
  }

  const body = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: input.secret.refreshToken,
  });

  const response = await input.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new ConnectorHttpError(
      'google_sheets_refresh_failed',
      `Google Sheets token refresh failed with HTTP ${response.status}.`,
      response.status,
    );
  }

  const payload = await readJsonResponse(response, 64 * 1024);
  const accessToken =
    typeof payload.access_token === 'string' ? payload.access_token : null;
  const expiresIn =
    typeof payload.expires_in === 'number' &&
    Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 3600;

  if (!accessToken) {
    throw new ConnectorHttpError(
      'google_sheets_refresh_failed',
      'Google Sheets token refresh did not return an access token.',
    );
  }

  const refreshed: Extract<ConnectorSecretPayload, { kind: 'google_sheets' }> =
    {
      ...input.secret,
      accessToken,
      refreshToken:
        typeof payload.refresh_token === 'string'
          ? payload.refresh_token
          : input.secret.refreshToken,
      expiryDate: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };

  replaceDataConnectorCredentialCiphertext({
    connectorId: input.connectorId,
    ciphertext: encryptConnectorSecret(refreshed),
  });

  return refreshed;
}

async function refreshGoogleSheetsSecret(input: {
  connectorId: string;
  secret: GoogleSheetsSecret;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<GoogleSheetsSecret> {
  const existing = googleSheetsRefreshInFlight.get(input.connectorId);
  if (existing) {
    return waitForPromiseWithSignal(existing, input.signal);
  }

  const refreshPromise = performGoogleSheetsSecretRefresh({
    connectorId: input.connectorId,
    secret: input.secret,
    fetchImpl: input.fetchImpl,
  }).finally(() => {
    googleSheetsRefreshInFlight.delete(input.connectorId);
  });

  googleSheetsRefreshInFlight.set(input.connectorId, refreshPromise);
  return waitForPromiseWithSignal(refreshPromise, input.signal);
}

async function getGoogleSheetsSecret(input: {
  connectorId: string;
  secret: GoogleSheetsSecret;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<GoogleSheetsSecret> {
  if (!isGoogleSecretExpired(input.secret)) {
    return input.secret;
  }

  return refreshGoogleSheetsSecret(input);
}

async function performGoogleDocsSecretRefresh(input: {
  connectorId: string;
  secret: GoogleDocsSecret;
  fetchImpl: typeof fetch;
}): Promise<GoogleDocsSecret> {
  if (!input.secret.refreshToken) {
    throw new ConnectorHttpError(
      'google_docs_refresh_unavailable',
      'Google Docs access token expired and no refresh token is available.',
    );
  }
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new ConnectorHttpError(
      'google_docs_refresh_unavailable',
      'Google OAuth client credentials are not configured for Docs token refresh.',
    );
  }

  const body = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: input.secret.refreshToken,
  });

  const response = await input.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new ConnectorHttpError(
      'google_docs_refresh_failed',
      `Google Docs token refresh failed with HTTP ${response.status}.`,
      response.status,
    );
  }

  const payload = await readJsonResponse(response, 64 * 1024);
  const accessToken =
    typeof payload.access_token === 'string' ? payload.access_token : null;
  const expiresIn =
    typeof payload.expires_in === 'number' &&
    Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 3600;

  if (!accessToken) {
    throw new ConnectorHttpError(
      'google_docs_refresh_failed',
      'Google Docs token refresh did not return an access token.',
    );
  }

  const refreshed: GoogleDocsSecret = {
    ...input.secret,
    accessToken,
    refreshToken:
      typeof payload.refresh_token === 'string'
        ? payload.refresh_token
        : input.secret.refreshToken,
    expiryDate: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };

  replaceDataConnectorCredentialCiphertext({
    connectorId: input.connectorId,
    ciphertext: encryptConnectorSecret(refreshed),
  });

  return refreshed;
}

async function refreshGoogleDocsSecret(input: {
  connectorId: string;
  secret: GoogleDocsSecret;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<GoogleDocsSecret> {
  const existing = googleDocsRefreshInFlight.get(input.connectorId);
  if (existing) {
    return waitForPromiseWithSignal(existing, input.signal);
  }

  const refreshPromise = performGoogleDocsSecretRefresh({
    connectorId: input.connectorId,
    secret: input.secret,
    fetchImpl: input.fetchImpl,
  }).finally(() => {
    googleDocsRefreshInFlight.delete(input.connectorId);
  });

  googleDocsRefreshInFlight.set(input.connectorId, refreshPromise);
  return waitForPromiseWithSignal(refreshPromise, input.signal);
}

async function getGoogleDocsSecret(input: {
  connectorId: string;
  secret: GoogleDocsSecret;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<GoogleDocsSecret> {
  if (!isGoogleSecretExpired(input.secret)) {
    return input.secret;
  }

  return refreshGoogleDocsSecret(input);
}

async function fetchGoogleSheetsJson(input: {
  connectorId: string;
  secret: Extract<ConnectorSecretPayload, { kind: 'google_sheets' }>;
  url: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  maxBytes?: number;
}): Promise<JsonMap> {
  let activeSecret = await getGoogleSheetsSecret(input);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await input.fetchImpl(input.url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${activeSecret.accessToken}`,
        accept: 'application/json',
      },
      signal: input.signal,
    });

    if (response.ok) {
      return readJsonResponse(response, input.maxBytes);
    }

    if (
      attempt === 0 &&
      (response.status === 401 || response.status === 403) &&
      activeSecret.refreshToken
    ) {
      activeSecret = await refreshGoogleSheetsSecret({
        connectorId: input.connectorId,
        secret: activeSecret,
        fetchImpl: input.fetchImpl,
        signal: input.signal,
      });
      continue;
    }

    throw new ConnectorHttpError(
      'google_sheets_request_failed',
      `Google Sheets request failed with HTTP ${response.status}.`,
      response.status,
    );
  }

  throw new ConnectorHttpError(
    'google_sheets_request_failed',
    'Google Sheets request failed.',
  );
}

async function fetchGoogleDocsJson(input: {
  connectorId: string;
  secret: GoogleDocsSecret;
  url: string;
  method?: 'GET' | 'POST';
  body?: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  maxBytes?: number;
}): Promise<JsonMap> {
  let activeSecret = await getGoogleDocsSecret({
    connectorId: input.connectorId,
    secret: input.secret,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await input.fetchImpl(input.url, {
      method: input.method || 'GET',
      headers: {
        authorization: `Bearer ${activeSecret.accessToken}`,
        accept: 'application/json',
        ...(input.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(input.body ? { body: input.body } : {}),
      signal: input.signal,
    });

    if (response.ok) {
      return readJsonResponse(response, input.maxBytes);
    }

    if (
      attempt === 0 &&
      (response.status === 401 || response.status === 403) &&
      activeSecret.refreshToken
    ) {
      activeSecret = await refreshGoogleDocsSecret({
        connectorId: input.connectorId,
        secret: activeSecret,
        fetchImpl: input.fetchImpl,
        signal: input.signal,
      });
      continue;
    }

    throw new ConnectorHttpError(
      'google_docs_request_failed',
      `Google Docs request failed with HTTP ${response.status}.`,
      response.status,
    );
  }

  throw new ConnectorHttpError(
    'google_docs_request_failed',
    'Google Docs request failed.',
  );
}

export async function fetchGoogleSheetsMetadata(input: {
  connectorId: string;
  secret: Extract<ConnectorSecretPayload, { kind: 'google_sheets' }>;
  spreadsheetId: string;
  fetchImpl?: typeof fetch;
  signal: AbortSignal;
}): Promise<GoogleSheetsConnectorDiscovery> {
  const json = await fetchGoogleSheetsJson({
    connectorId: input.connectorId,
    secret: input.secret,
    url: joinUrl(
      'https://sheets.googleapis.com',
      `/v4/spreadsheets/${encodeURIComponent(
        input.spreadsheetId,
      )}?fields=sheets.properties`,
    ),
    fetchImpl: input.fetchImpl || fetch,
    signal: input.signal,
    maxBytes: DEFAULT_MAX_RESPONSE_BYTES,
  });

  const sheets = Array.isArray(json.sheets)
    ? json.sheets
        .map((entry) => {
          const properties = parseJsonMap(parseJsonMap(entry)?.properties);
          const gridProperties = parseJsonMap(properties?.gridProperties);
          const title =
            properties && typeof properties.title === 'string'
              ? properties.title
              : null;
          if (!title) return null;
          return {
            title,
            rowCount:
              typeof gridProperties?.rowCount === 'number'
                ? Math.floor(gridProperties.rowCount)
                : null,
            columnCount:
              typeof gridProperties?.columnCount === 'number'
                ? Math.floor(gridProperties.columnCount)
                : null,
          } satisfies GoogleSheetDiscoveryItem;
        })
        .filter((item): item is GoogleSheetDiscoveryItem => Boolean(item))
    : [];

  return { sheets };
}

export async function fetchGoogleSheetRange(input: {
  connectorId: string;
  secret: Extract<ConnectorSecretPayload, { kind: 'google_sheets' }>;
  spreadsheetId: string;
  range: string;
  fetchImpl?: typeof fetch;
  signal: AbortSignal;
  maxBytes?: number;
}): Promise<JsonMap> {
  return fetchGoogleSheetsJson({
    connectorId: input.connectorId,
    secret: input.secret,
    url: joinUrl(
      'https://sheets.googleapis.com',
      `/v4/spreadsheets/${encodeURIComponent(
        input.spreadsheetId,
      )}/values/${encodeURIComponent(input.range)}`,
    ),
    fetchImpl: input.fetchImpl || fetch,
    signal: input.signal,
    maxBytes: input.maxBytes,
  });
}

function readGoogleDocParagraphText(paragraph: JsonMap): string {
  const elements = Array.isArray(paragraph.elements) ? paragraph.elements : [];
  return elements
    .map((element) => {
      const map = parseJsonMap(element);
      const textRun = parseJsonMap(map?.textRun);
      return typeof textRun?.content === 'string' ? textRun.content : '';
    })
    .join('')
    .trimEnd();
}

function extractGoogleDocText(elements: unknown[]): string {
  const blocks: string[] = [];

  for (const element of elements) {
    const map = parseJsonMap(element);
    if (!map) continue;

    const paragraph = parseJsonMap(map.paragraph);
    if (paragraph) {
      const text = readGoogleDocParagraphText(paragraph).trim();
      if (text) blocks.push(text);
      continue;
    }

    const table = parseJsonMap(map.table);
    if (table) {
      const rows = Array.isArray(table.tableRows) ? table.tableRows : [];
      for (const row of rows) {
        const rowMap = parseJsonMap(row);
        if (!rowMap) continue;
        const cells = Array.isArray(rowMap.tableCells) ? rowMap.tableCells : [];
        const cellTexts = cells
          .map((cell) => {
            const cellMap = parseJsonMap(cell);
            if (!cellMap) return '';
            const content = Array.isArray(cellMap.content)
              ? cellMap.content
              : [];
            return extractGoogleDocText(content).trim();
          })
          .filter(Boolean);
        if (cellTexts.length > 0) {
          blocks.push(cellTexts.join(' | '));
        }
      }
      continue;
    }

    const tableOfContents = parseJsonMap(map.tableOfContents);
    if (tableOfContents) {
      const content = Array.isArray(tableOfContents.content)
        ? tableOfContents.content
        : [];
      const text = extractGoogleDocText(content).trim();
      if (text) blocks.push(text);
    }
  }

  return blocks.join('\n\n');
}

export async function fetchGoogleDoc(input: {
  connectorId: string;
  secret: GoogleDocsSecret;
  documentId: string;
  fetchImpl?: typeof fetch;
  signal: AbortSignal;
}): Promise<{ title: string; text: string }> {
  const payload = await fetchGoogleDocsJson({
    connectorId: input.connectorId,
    secret: input.secret,
    url: joinUrl(
      GOOGLE_DOCS_BASE_URL,
      `/v1/documents/${encodeURIComponent(input.documentId)}`,
    ),
    fetchImpl: input.fetchImpl || fetch,
    signal: input.signal,
    maxBytes: DEFAULT_MAX_RESPONSE_BYTES,
  });

  const title =
    typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : input.documentId;
  const body = parseJsonMap(payload.body);
  const content = Array.isArray(body?.content) ? body.content : [];

  return {
    title,
    text: extractGoogleDocText(content),
  };
}

export async function batchUpdateGoogleDoc(input: {
  connectorId: string;
  secret: GoogleDocsSecret;
  documentId: string;
  requests: JsonMap[];
  writeControl?: JsonMap | null;
  fetchImpl?: typeof fetch;
  signal: AbortSignal;
}): Promise<JsonMap> {
  return fetchGoogleDocsJson({
    connectorId: input.connectorId,
    secret: input.secret,
    url: joinUrl(
      GOOGLE_DOCS_BASE_URL,
      `/v1/documents/${encodeURIComponent(input.documentId)}:batchUpdate`,
    ),
    method: 'POST',
    body: JSON.stringify({
      requests: input.requests,
      ...(input.writeControl ? { writeControl: input.writeControl } : {}),
    }),
    fetchImpl: input.fetchImpl || fetch,
    signal: input.signal,
    maxBytes: DEFAULT_MAX_RESPONSE_BYTES,
  });
}

export async function fetchPostHogEventDefinitions(input: {
  hostUrl: string;
  projectId: string;
  secret: Extract<ConnectorSecretPayload, { kind: 'posthog' }>;
  fetchImpl?: typeof fetch;
  signal: AbortSignal;
}): Promise<{
  projectName: string | null;
  eventNames: string[];
}> {
  const response = await (input.fetchImpl || fetch)(
    joinUrl(
      input.hostUrl,
      `/api/projects/${encodeURIComponent(
        input.projectId,
      )}/event_definitions/?limit=10`,
    ),
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${input.secret.apiKey}`,
        accept: 'application/json',
      },
      signal: input.signal,
    },
  );

  if (!response.ok) {
    throw new ConnectorHttpError(
      'posthog_request_failed',
      `PostHog verification failed with HTTP ${response.status}.`,
      response.status,
    );
  }

  const json = await readJsonResponse(response, DEFAULT_MAX_RESPONSE_BYTES);
  const results = Array.isArray(json.results) ? json.results : [];
  const eventNames = results
    .map((entry) => {
      const item = parseJsonMap(entry);
      return item && typeof item.name === 'string' ? item.name : null;
    })
    .filter((value): value is string => Boolean(value));
  const projectName =
    typeof json.projectName === 'string'
      ? json.projectName
      : typeof json.name === 'string'
        ? json.name
        : null;

  return {
    projectName,
    eventNames,
  };
}

/**
 * Append a LIMIT clause to a HogQL query if one isn't already present.
 * Handles trailing semicolons and whitespace gracefully.
 */
function injectLimitIfMissing(query: string, limit: number): string {
  // Strip trailing whitespace and semicolons for analysis
  const trimmed = query.replace(/[\s;]+$/, '');
  // Check whether the query already contains a LIMIT clause (case-insensitive)
  if (/\bLIMIT\s+\d+/i.test(trimmed)) {
    return query;
  }
  return `${trimmed} LIMIT ${limit}`;
}

export async function runPostHogQuery(input: {
  hostUrl: string;
  projectId: string;
  secret: Extract<ConnectorSecretPayload, { kind: 'posthog' }>;
  query: string;
  limit: number;
  fetchImpl?: typeof fetch;
  signal: AbortSignal;
  maxBytes?: number;
}): Promise<JsonMap> {
  const finalQuery = injectLimitIfMissing(input.query, input.limit);

  const response = await (input.fetchImpl || fetch)(
    joinUrl(
      input.hostUrl,
      `/api/projects/${encodeURIComponent(input.projectId)}/query/`,
    ),
    {
      method: 'POST',
      headers: buildPostHogAuthHeaders(input.secret.apiKey),
      body: JSON.stringify({
        query: {
          kind: 'HogQLQuery',
          query: finalQuery,
        },
      }),
      signal: input.signal,
    },
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new ConnectorHttpError(
      'posthog_request_failed',
      `PostHog query failed with HTTP ${response.status}${errorBody ? `: ${errorBody.slice(0, 200)}` : ''}.`,
      response.status,
    );
  }

  return readJsonResponse(response, input.maxBytes);
}
