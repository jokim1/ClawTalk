import type { TalkRunConnectorRecord } from '../db/connector-accessors.js';

import { decryptConnectorSecret } from './connector-secret-store.js';
import { MAX_GOOGLE_DOCS_BATCH_REQUESTS } from './google-docs-constants.js';
import {
  batchUpdateGoogleDoc,
  ConnectorHttpError,
  fetchGoogleDoc,
  fetchGoogleSheetRange,
  fetchGoogleSheetsMetadata,
  runPostHogQuery,
} from './http.js';
import {
  parseConnectorToolName,
  parseGoogleDocsConnectorConfig,
  parseGoogleSheetsConnectorConfig,
  parsePostHogConnectorConfig,
} from './runtime.js';

const GOOGLE_SHEETS_TIMEOUT_MS = 10_000;
const GOOGLE_DOCS_TIMEOUT_MS = 10_000;
const POSTHOG_TIMEOUT_MS = 15_000;
const MAX_TOOL_RESULT_BYTES = 512 * 1024;
const MAX_TOOL_RESULT_CHARS = 16_000;
const MAX_POSTHOG_LIMIT = 1_000;
const DEFAULT_POSTHOG_LIMIT = 100;
const MAX_POSTHOG_RANGE_DAYS = 90;
const MAX_SHEETS_RANGE_LENGTH = 200;

type JsonMap = Record<string, unknown>;

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
  displaySummary: string;
}

export interface ToolExecutionContext {
  connector: TalkRunConnectorRecord;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

function createTimedSignal(
  parentSignal: AbortSignal,
  timeoutMs: number,
): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort('connector_timeout');
  }, timeoutMs);
  const onAbort = () => controller.abort(parentSignal.reason || 'aborted');
  parentSignal.addEventListener('abort', onAbort, { once: true });

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onAbort);
    },
  };
}

function parseObjectInput(value: unknown): JsonMap | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonMap)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_POSTHOG_LIMIT;
  }
  return Math.max(1, Math.min(MAX_POSTHOG_LIMIT, Math.floor(value)));
}

function parseDateOnly(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) {
    return null;
  }
  const normalized = parsed.toISOString().slice(0, 10);
  return normalized === value ? parsed : null;
}

function validatePostHogInput(value: unknown): {
  query: string;
  limit: number;
} {
  const input = parseObjectInput(value);
  const query = readString(input?.query);
  if (!query) {
    throw new Error('posthog_query requires a query string.');
  }

  // Optional date guardrails: if the agent passes dateFrom/dateTo, validate
  // them to prevent unbounded queries. These are NOT sent to PostHog — the
  // agent should include date filters in the SQL itself.
  const dateFrom = readString(input?.dateFrom);
  const dateTo = readString(input?.dateTo);
  if ((dateFrom && !dateTo) || (!dateFrom && dateTo)) {
    throw new Error(
      'PostHog dateFrom/dateTo must be provided together when used.',
    );
  }
  if (dateFrom && dateTo) {
    const fromDate = parseDateOnly(dateFrom);
    const toDate = parseDateOnly(dateTo);
    if (!fromDate || !toDate || toDate.valueOf() < fromDate.valueOf()) {
      throw new Error(
        'PostHog dateFrom/dateTo must be valid YYYY-MM-DD values.',
      );
    }

    const diffDays =
      Math.floor((toDate.valueOf() - fromDate.valueOf()) / 86_400_000) + 1;
    if (diffDays > MAX_POSTHOG_RANGE_DAYS) {
      throw new Error('PostHog date range cannot exceed 90 days.');
    }
  }

  return {
    query,
    limit: clampLimit(input?.limit),
  };
}

function validateSheetRange(value: unknown): string {
  const input = parseObjectInput(value);
  const range = readString(input?.range);
  if (!range) {
    throw new Error('read_range requires an A1-style range.');
  }
  if (range.length > MAX_SHEETS_RANGE_LENGTH) {
    throw new Error('Google Sheets ranges must be 200 characters or fewer.');
  }
  return range;
}

function validateGoogleDocsBatchUpdateInput(value: unknown): {
  requests: JsonMap[];
  writeControl: JsonMap | null;
} {
  const input = parseObjectInput(value);
  const rawRequests = Array.isArray(input?.requests) ? input.requests : [];
  const requests = rawRequests.map((request) => parseObjectInput(request));
  if (requests.some((request) => !request)) {
    throw new Error('Google Docs batchUpdate requests must be JSON objects.');
  }
  if (requests.length === 0) {
    throw new Error(
      'Google Docs batchUpdate requires a non-empty requests array.',
    );
  }
  if (requests.length > MAX_GOOGLE_DOCS_BATCH_REQUESTS) {
    throw new Error(
      `Google Docs batchUpdate supports at most ${MAX_GOOGLE_DOCS_BATCH_REQUESTS} requests per call.`,
    );
  }

  return {
    requests: requests as JsonMap[],
    writeControl: parseObjectInput(input?.writeControl),
  };
}

function serializeToolResult(value: unknown): string {
  const serialized =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) {
    return serialized;
  }

  const overflow = serialized.length - MAX_TOOL_RESULT_CHARS;
  return `${serialized.slice(0, MAX_TOOL_RESULT_CHARS)}\n…truncated ${overflow} characters`;
}

function mapConnectorError(error: unknown): string {
  if (error instanceof ConnectorHttpError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Connector request failed.';
}

async function executePostHogQuery(
  toolInput: unknown,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const config = parsePostHogConnectorConfig(context.connector.config);
  if (!config) {
    return {
      content: 'PostHog connector is missing hostUrl or projectId.',
      isError: true,
      displaySummary: `PostHog query (${context.connector.name}) failed`,
    };
  }

  const secret = decryptConnectorSecret(context.connector.ciphertext);
  if (secret.kind !== 'posthog') {
    return {
      content: 'Connector credential is not a PostHog API key.',
      isError: true,
      displaySummary: `PostHog query (${context.connector.name}) failed`,
    };
  }

  const input = validatePostHogInput(toolInput);
  const timed = createTimedSignal(context.signal, POSTHOG_TIMEOUT_MS);
  try {
    const json = await runPostHogQuery({
      hostUrl: config.hostUrl,
      projectId: config.projectId,
      secret,
      query: input.query,
      limit: input.limit,
      fetchImpl: context.fetchImpl,
      signal: timed.signal,
      maxBytes: MAX_TOOL_RESULT_BYTES,
    });

    return {
      content: serializeToolResult(json),
      isError: false,
      displaySummary: `Queried PostHog via ${context.connector.name}`,
    };
  } finally {
    timed.dispose();
  }
}

async function executeListSheets(
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const config = parseGoogleSheetsConnectorConfig(context.connector.config);
  if (!config) {
    return {
      content: 'Google Sheets connector is missing spreadsheetId.',
      isError: true,
      displaySummary: `List sheets (${context.connector.name}) failed`,
    };
  }

  const secret = decryptConnectorSecret(context.connector.ciphertext);
  if (secret.kind !== 'google_sheets') {
    return {
      content: 'Connector credential is not a Google Sheets OAuth credential.',
      isError: true,
      displaySummary: `List sheets (${context.connector.name}) failed`,
    };
  }

  const timed = createTimedSignal(context.signal, GOOGLE_SHEETS_TIMEOUT_MS);
  try {
    const metadata = await fetchGoogleSheetsMetadata({
      connectorId: context.connector.id,
      secret,
      spreadsheetId: config.spreadsheetId,
      fetchImpl: context.fetchImpl,
      signal: timed.signal,
    });

    return {
      content: serializeToolResult(metadata),
      isError: false,
      displaySummary: `Listed sheets from ${context.connector.name}`,
    };
  } finally {
    timed.dispose();
  }
}

async function executeReadRange(
  toolInput: unknown,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const config = parseGoogleSheetsConnectorConfig(context.connector.config);
  if (!config) {
    return {
      content: 'Google Sheets connector is missing spreadsheetId.',
      isError: true,
      displaySummary: `Read range (${context.connector.name}) failed`,
    };
  }

  const secret = decryptConnectorSecret(context.connector.ciphertext);
  if (secret.kind !== 'google_sheets') {
    return {
      content: 'Connector credential is not a Google Sheets OAuth credential.',
      isError: true,
      displaySummary: `Read range (${context.connector.name}) failed`,
    };
  }

  const range = validateSheetRange(toolInput);
  const timed = createTimedSignal(context.signal, GOOGLE_SHEETS_TIMEOUT_MS);
  try {
    const values = await fetchGoogleSheetRange({
      connectorId: context.connector.id,
      secret,
      spreadsheetId: config.spreadsheetId,
      range,
      fetchImpl: context.fetchImpl,
      signal: timed.signal,
      maxBytes: MAX_TOOL_RESULT_BYTES,
    });

    return {
      content: serializeToolResult(values),
      isError: false,
      displaySummary: `Read ${range} from ${context.connector.name}`,
    };
  } finally {
    timed.dispose();
  }
}

async function executeReadDocument(
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const config = parseGoogleDocsConnectorConfig(context.connector.config);
  if (!config) {
    return {
      content: 'Google Docs connector is missing documentId.',
      isError: true,
      displaySummary: `Read document (${context.connector.name}) failed`,
    };
  }

  const secret = decryptConnectorSecret(context.connector.ciphertext);
  if (secret.kind !== 'google_docs') {
    return {
      content: 'Connector credential is not a Google Docs OAuth credential.',
      isError: true,
      displaySummary: `Read document (${context.connector.name}) failed`,
    };
  }

  const timed = createTimedSignal(context.signal, GOOGLE_DOCS_TIMEOUT_MS);
  try {
    const document = await fetchGoogleDoc({
      connectorId: context.connector.id,
      secret,
      documentId: config.documentId,
      fetchImpl: context.fetchImpl,
      signal: timed.signal,
    });

    return {
      content: serializeToolResult(document),
      isError: false,
      displaySummary: `Read Google Doc via ${context.connector.name}`,
    };
  } finally {
    timed.dispose();
  }
}

async function executeBatchUpdateDocument(
  toolInput: unknown,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const config = parseGoogleDocsConnectorConfig(context.connector.config);
  if (!config) {
    return {
      content: 'Google Docs connector is missing documentId.',
      isError: true,
      displaySummary: `Batch update (${context.connector.name}) failed`,
    };
  }

  const secret = decryptConnectorSecret(context.connector.ciphertext);
  if (secret.kind !== 'google_docs') {
    return {
      content: 'Connector credential is not a Google Docs OAuth credential.',
      isError: true,
      displaySummary: `Batch update (${context.connector.name}) failed`,
    };
  }

  const input = validateGoogleDocsBatchUpdateInput(toolInput);
  const timed = createTimedSignal(context.signal, GOOGLE_DOCS_TIMEOUT_MS);
  try {
    const result = await batchUpdateGoogleDoc({
      connectorId: context.connector.id,
      secret,
      documentId: config.documentId,
      requests: input.requests,
      writeControl: input.writeControl,
      fetchImpl: context.fetchImpl,
      signal: timed.signal,
    });

    return {
      content: serializeToolResult(result),
      isError: false,
      displaySummary: `Updated Google Doc via ${context.connector.name}`,
    };
  } finally {
    timed.dispose();
  }
}

export async function executeConnectorTool(
  toolName: string,
  toolInput: unknown,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const parsed = parseConnectorToolName(toolName);
  if (!parsed || parsed.connectorId !== context.connector.id) {
    return {
      content: `Unknown connector tool: ${toolName}`,
      isError: true,
      displaySummary: `Tool ${toolName} failed`,
    };
  }

  try {
    switch (parsed.operation) {
      case 'posthog_query':
        return await executePostHogQuery(toolInput, context);
      case 'list_sheets':
        return await executeListSheets(context);
      case 'read_range':
        return await executeReadRange(toolInput, context);
      case 'read_document':
        return await executeReadDocument(context);
      case 'batch_update':
        return await executeBatchUpdateDocument(toolInput, context);
      default:
        return {
          content: `Unsupported connector tool: ${parsed.operation}`,
          isError: true,
          displaySummary: `Tool ${toolName} failed`,
        };
    }
  } catch (error) {
    if (context.signal.aborted) {
      throw error;
    }
    return {
      content: mapConnectorError(error),
      isError: true,
      displaySummary: `Tool ${toolName} failed`,
    };
  }
}
