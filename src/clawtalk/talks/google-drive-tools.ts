// Google Drive / Docs tool executors for Talks.
//
// Surface:
//   - `loadGoogleDriveBindings(talkId)` — async; reads talk_resource_bindings
//     and assigns G1/G2/... refs by creation order. Drive/Docs bindings only.
//   - `buildBoundGoogleDrivePromptSection(bindings)` — string fragment for
//     the system prompt. Lists each bound resource by ref + kind + name, or
//     a "no bindings" hint pointing the agent at the Tools tab.
//   - `buildGoogleDriveContextTools({ readEnabled, writeEnabled })` —
//     LlmToolDefinition[] for context-loader to merge in. D4: schemas are
//     ALWAYS emitted when the agent's family is enabled, regardless of
//     credential or binding state. Gating on credential/binding happens at
//     call time via typed errors returned to the LLM.
//   - `executeGoogleDriveTalkTool({...})` — dispatcher for the 6 tools:
//       google_drive_search, google_drive_read, google_drive_list_folder,
//       google_docs_read, google_docs_batch_update, google_docs_create.
//
// Security boundaries:
//   - C4: every executor that takes a `bindingRef` (G1/G2/...) resolves it
//     through `loadGoogleDriveBindings`. Raw `fileId` args only work when
//     the file lives inside a bound folder (resolved server-side via
//     `findContainingBoundFolderRef`). Folder escape, shortcut targets that
//     resolve outside bindings — all rejected.
//   - C5: user-controlled strings are escaped through `escapeDriveQueryValue`
//     before being interpolated into Drive `q=` params.
//   - C6: mutation tools (`google_docs_create`, `google_docs_batch_update`)
//     check `jobPolicy.allowExternalMutation`. When the policy is set and
//     the flag is off, the tool returns `external_mutation_blocked` instead
//     of hitting Google. Read tools are unaffected.
//   - D2: every Drive/Docs fetch is wrapped in `withTokenRefresh` — a 401
//     forces a credential refresh and retries the same call once. A second
//     401 (or refresh failure) surfaces `google_reauth_required`.

import { type LlmToolDefinition } from '../agents/llm-client.js';
import {
  createTalkResourceBinding,
  getUserGoogleCredential,
  listTalkResourceBindings,
  type TalkResourceBindingKind,
  type TalkResourceBindingRecord,
} from '../db/talk-tools-accessors.js';
import { GoogleToolCredentialError } from '../identity/google-tools-errors.js';
import {
  decryptGoogleToolCredential,
  type GoogleToolCredentialPayload,
} from '../identity/google-tools-credential-store.js';
import {
  getValidGoogleToolAccessToken,
  performRefresh,
} from '../identity/google-tools-service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOGLE_DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const GOOGLE_DOCS_API_BASE = 'https://docs.googleapis.com/v1';
const GOOGLE_SHEETS_API_BASE = 'https://sheets.googleapis.com/v4';
const GOOGLE_DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_DOCS_MIME = 'application/vnd.google-apps.document';
const GOOGLE_SHEETS_MIME = 'application/vnd.google-apps.spreadsheet';
const MAX_TEXT_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_SEARCH_RESULTS = 10;
const DEFAULT_FOLDER_RESULTS = 25;
const MAX_GOOGLE_DOCS_BATCH_REQUESTS = 50;
const MAX_GOOGLE_SHEETS_BATCH_UPDATES = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JsonMap = Record<string, unknown>;

type GoogleDriveBindingKind = Extract<
  TalkResourceBindingKind,
  'google_drive_file' | 'google_drive_folder'
>;

export type BoundGoogleDriveResource = {
  ref: string;
  bindingId: string;
  bindingKind: GoogleDriveBindingKind;
  externalId: string;
  displayName: string;
  mimeType: string | null;
  url: string | null;
};

type GoogleDriveFileMetadata = {
  id: string;
  name: string;
  mimeType: string | null;
  parents: string[];
  webViewLink: string | null;
  size: string | null;
};

type ExecutorResult = { result: string; isError?: boolean };

export type GoogleDriveJobPolicy = {
  allowExternalMutation: boolean;
};

// Thrown by `googleFetch` when the response status is 401. Caught by
// `withTokenRefresh` to force a credential refresh and retry once.
class GoogleApiAuthError extends Error {
  constructor() {
    super('Google API returned 401 Unauthorized');
    this.name = 'GoogleApiAuthError';
  }
}

// ---------------------------------------------------------------------------
// Bindings → refs
// ---------------------------------------------------------------------------

function isDriveBinding(binding: TalkResourceBindingRecord): boolean {
  return (
    binding.bindingKind === 'google_drive_file' ||
    binding.bindingKind === 'google_drive_folder'
  );
}

function toBoundResource(
  binding: TalkResourceBindingRecord,
  index: number,
): BoundGoogleDriveResource {
  const metadata =
    binding.metadata && !Array.isArray(binding.metadata)
      ? (binding.metadata as JsonMap)
      : null;
  const mimeType =
    metadata && typeof metadata.mimeType === 'string'
      ? metadata.mimeType
      : null;
  const url =
    metadata && typeof metadata.url === 'string' ? metadata.url : null;
  return {
    ref: `G${index + 1}`,
    bindingId: binding.id,
    bindingKind: binding.bindingKind as GoogleDriveBindingKind,
    externalId: binding.externalId,
    displayName: binding.displayName,
    mimeType,
    url,
  };
}

export async function loadGoogleDriveBindings(
  talkId: string,
): Promise<BoundGoogleDriveResource[]> {
  const all = await listTalkResourceBindings(talkId);
  return all.filter(isDriveBinding).map(toBoundResource);
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function buildBoundGoogleDrivePromptSection(
  bindings: BoundGoogleDriveResource[],
): string {
  if (bindings.length === 0) {
    return [
      '**Bound Google Drive Resources:**',
      'No Drive resources are bound to this Talk. To attach a Drive folder or',
      'Doc, ask the user to open the Tools tab and use "Add from Drive".',
    ].join('\n');
  }
  const lines = bindings.map((resource) => {
    const kind =
      resource.bindingKind === 'google_drive_folder' ? 'FOLDER' : 'FILE';
    return `[${resource.ref}] ${kind} ${resource.displayName}`;
  });
  return [
    '**Bound Google Drive Resources:**',
    lines.join('\n'),
    'Use the Google Drive tools to search, list, or read these bound resources.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tool schemas (D4 always-advertise)
// ---------------------------------------------------------------------------

const READ_TOOL_DEFINITIONS: LlmToolDefinition[] = [
  {
    name: 'google_drive_search',
    description:
      'Search for files inside the bound Google Drive resources. Use this to find a file inside a bound folder before reading it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for file names or Drive full text.',
        },
        maxResults: {
          type: 'number',
          description: 'Optional maximum number of results to return.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'google_drive_read',
    description:
      'Read a bound Google Drive file by bindingRef (for a directly bound file like G1), or read a fileId that was discovered inside a bound folder via google_drive_search or google_drive_list_folder.',
    inputSchema: {
      type: 'object',
      properties: {
        bindingRef: {
          type: 'string',
          description: 'Bound resource ref like G1 for a directly bound file.',
        },
        fileId: {
          type: 'string',
          description:
            'Drive file id discovered from google_drive_search or google_drive_list_folder.',
        },
      },
    },
  },
  {
    name: 'google_drive_list_folder',
    description:
      'List the direct children of a bound Google Drive folder by bindingRef (for example G1).',
    inputSchema: {
      type: 'object',
      properties: {
        bindingRef: {
          type: 'string',
          description: 'Bound folder ref like G1.',
        },
        maxResults: {
          type: 'number',
          description: 'Optional maximum number of children to return.',
        },
      },
      required: ['bindingRef'],
    },
  },
  {
    name: 'google_docs_read',
    description:
      'Read a directly bound Google Doc by bindingRef (for example G1). Bind the file directly before using this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        bindingRef: {
          type: 'string',
          description:
            'Bound file ref like G1 for a directly bound Google Doc.',
        },
      },
      required: ['bindingRef'],
    },
  },
  {
    name: 'google_sheets_read_range',
    description:
      'Read a cell range from a bound Google Sheet by bindingRef. Range uses A1 notation, for example "Sheet1!A1:C10". Returns a 2D array of cell values.',
    inputSchema: {
      type: 'object',
      properties: {
        bindingRef: {
          type: 'string',
          description:
            'Bound file ref like G1 for a directly bound Google Sheet.',
        },
        range: {
          type: 'string',
          description:
            'A1-notation range like "Sheet1!A1:C10" or just "A1:C10" to use the first sheet.',
        },
        valueRenderOption: {
          type: 'string',
          description:
            'Optional Google Sheets valueRenderOption. Defaults to FORMATTED_VALUE; use UNFORMATTED_VALUE for raw numbers or FORMULA to read formulas.',
        },
      },
      required: ['bindingRef', 'range'],
    },
  },
];

const WRITE_TOOL_DEFINITIONS: LlmToolDefinition[] = [
  {
    name: 'google_docs_create',
    description:
      'Create a new Google Doc with the given title. The created doc is automatically bound to this Talk and gets a fresh G-ref. Returns the new ref and the doc URL.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title for the new Google Doc.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'google_docs_batch_update',
    description:
      'Apply Google Docs API batchUpdate requests to a bound Google Doc by bindingRef. Bind the document file directly (or create one via google_docs_create) before using this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        bindingRef: {
          type: 'string',
          description:
            'Bound file ref like G1 for a directly bound Google Doc.',
        },
        requests: {
          type: 'array',
          description:
            'Array of Google Docs API batchUpdate request objects such as insertText or replaceAllText.',
          items: { type: 'object', additionalProperties: true },
        },
        writeControl: {
          type: 'object',
          description:
            'Optional Google Docs writeControl object, for example requiredRevisionId.',
          additionalProperties: true,
        },
      },
      required: ['bindingRef', 'requests'],
    },
  },
  {
    name: 'google_sheets_batch_update',
    description:
      'Write one or more cell ranges to a bound Google Sheet via the Sheets values.batchUpdate endpoint. Each update is { range, values } where values is a 2D array of cell values.',
    inputSchema: {
      type: 'object',
      properties: {
        bindingRef: {
          type: 'string',
          description:
            'Bound file ref like G1 for a directly bound Google Sheet.',
        },
        updates: {
          type: 'array',
          description:
            'Array of value-range updates. Each item: { range: "Sheet1!A1:B2", values: [["x","y"],["z","w"]] }.',
          items: {
            type: 'object',
            properties: {
              range: { type: 'string' },
              values: {
                type: 'array',
                items: { type: 'array', items: {} },
              },
            },
            required: ['range', 'values'],
          },
        },
        valueInputOption: {
          type: 'string',
          description:
            'Optional Google Sheets valueInputOption. Defaults to USER_ENTERED (formulas + auto-parsing); use RAW to write strings verbatim.',
        },
      },
      required: ['bindingRef', 'updates'],
    },
  },
];

export function buildGoogleDriveContextTools(input: {
  readEnabled: boolean;
  writeEnabled: boolean;
}): LlmToolDefinition[] {
  const tools: LlmToolDefinition[] = [];
  if (input.readEnabled) tools.push(...READ_TOOL_DEFINITIONS);
  if (input.writeEnabled) tools.push(...WRITE_TOOL_DEFINITIONS);
  return tools;
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function parseJsonMap(value: unknown): JsonMap | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonMap)
    : null;
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function isTextLikeMimeType(mimeType: string | null): boolean {
  if (!mimeType) return true;
  if (mimeType.startsWith('text/')) return true;
  return (
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/x-typescript' ||
    mimeType === 'application/typescript' ||
    mimeType === 'application/x-sh'
  );
}

function coercePositiveInt(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

function okResult(result: unknown): ExecutorResult {
  return {
    result: typeof result === 'string' ? result : JSON.stringify(result),
  };
}

function errorResult(message: string): ExecutorResult {
  return { result: message, isError: true };
}

function errorFromCredential(err: GoogleToolCredentialError): ExecutorResult {
  // Surface the typed error to the LLM with enough detail to act on it.
  // The dispatcher in new-executor.ts treats `isError: true` as a recoverable
  // tool failure (not a hard executor crash).
  if (err.code === 'google_scopes_missing' && err.missingScopes?.length) {
    return errorResult(
      `${err.message} (missing: ${err.missingScopes.join(', ')})`,
    );
  }
  return errorResult(`${err.code}: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Token refresh wrapper (D2 401 retry-once)
// ---------------------------------------------------------------------------

async function withTokenRefresh<T>(
  userId: string,
  requiredScopes: string[],
  fn: (accessToken: string) => Promise<T>,
): Promise<T> {
  const tokenInfo = await getValidGoogleToolAccessToken({
    userId,
    requiredScopes,
  });
  try {
    return await fn(tokenInfo.accessToken);
  } catch (err) {
    if (!(err instanceof GoogleApiAuthError)) throw err;
    // 401 after a presumably-valid token — Google may have revoked it
    // out of band (admin console, security alert). Force a refresh and
    // retry the call once. If the second attempt also 401s, surface
    // google_reauth_required so the UI prompts a reconnect.
    const credential = await getUserGoogleCredential();
    if (!credential) {
      throw new GoogleToolCredentialError(
        'google_account_not_connected',
        'Google account is not connected.',
        404,
      );
    }
    let payload: GoogleToolCredentialPayload;
    try {
      payload = decryptGoogleToolCredential(credential.ciphertext);
    } catch {
      throw new GoogleToolCredentialError(
        'google_reauth_required',
        'Stored Google credential is invalid and must be reconnected.',
        401,
      );
    }
    const refreshed = await performRefresh(userId, payload);
    try {
      return await fn(refreshed.accessToken);
    } catch (retryErr) {
      if (retryErr instanceof GoogleApiAuthError) {
        throw new GoogleToolCredentialError(
          'google_reauth_required',
          'Google denied the access token after refresh; please reconnect.',
          401,
        );
      }
      throw retryErr;
    }
  }
}

// ---------------------------------------------------------------------------
// Google API fetch wrappers
// ---------------------------------------------------------------------------

async function googleFetch(
  url: string,
  init: RequestInit,
  accessToken: string,
  signal: AbortSignal,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${accessToken}`);
  const response = await fetch(url, { ...init, headers, signal });
  if (response.status === 401) {
    throw new GoogleApiAuthError();
  }
  return response;
}

async function readTextResponse(response: Response): Promise<string> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_RESPONSE_BYTES) {
    throw new GoogleToolCredentialError(
      'drive_api_error',
      'Google Drive response exceeded the maximum allowed size.',
      413,
    );
  }
  return text;
}

async function readJsonMapResponse(
  response: Response,
  errorPrefix: string,
): Promise<JsonMap> {
  const text = await readTextResponse(response);
  const parsed = JSON.parse(text) as unknown;
  const map = parseJsonMap(parsed);
  if (!map) {
    throw new GoogleToolCredentialError(
      'drive_api_error',
      `${errorPrefix} response was not a JSON object.`,
      502,
    );
  }
  return map;
}

async function fetchDriveJson(
  url: string,
  accessToken: string,
  signal: AbortSignal,
): Promise<JsonMap> {
  const response = await googleFetch(url, {}, accessToken, signal);
  if (!response.ok) {
    throw new GoogleToolCredentialError(
      'drive_api_error',
      `Google Drive request failed with HTTP ${response.status}.`,
      502,
    );
  }
  return readJsonMapResponse(response, 'Google Drive');
}

async function fetchDriveFileMetadata(input: {
  fileId: string;
  accessToken: string;
  signal: AbortSignal;
  cache: Map<string, GoogleDriveFileMetadata>;
}): Promise<GoogleDriveFileMetadata> {
  const existing = input.cache.get(input.fileId);
  if (existing) return existing;

  const params = new URLSearchParams({
    fields: 'id,name,mimeType,parents,webViewLink,size',
    supportsAllDrives: 'true',
  });
  const payload = await fetchDriveJson(
    `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(input.fileId)}?${params.toString()}`,
    input.accessToken,
    input.signal,
  );

  const metadata: GoogleDriveFileMetadata = {
    id: typeof payload.id === 'string' ? payload.id : input.fileId,
    name:
      typeof payload.name === 'string' && payload.name.trim()
        ? payload.name.trim()
        : input.fileId,
    mimeType: typeof payload.mimeType === 'string' ? payload.mimeType : null,
    parents: Array.isArray(payload.parents)
      ? payload.parents.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
    webViewLink:
      typeof payload.webViewLink === 'string' ? payload.webViewLink : null,
    size: typeof payload.size === 'string' ? payload.size : null,
  };
  input.cache.set(input.fileId, metadata);
  return metadata;
}

async function findContainingBoundFolderRef(input: {
  accessToken: string;
  signal: AbortSignal;
  cache: Map<string, GoogleDriveFileMetadata>;
  startParents: string[];
  boundFoldersById: Map<string, BoundGoogleDriveResource>;
}): Promise<string | null> {
  const queue = [...input.startParents];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);
    const boundFolder = input.boundFoldersById.get(currentId);
    if (boundFolder) return boundFolder.ref;
    const metadata = await fetchDriveFileMetadata({
      fileId: currentId,
      accessToken: input.accessToken,
      signal: input.signal,
      cache: input.cache,
    });
    queue.push(...metadata.parents);
  }
  return null;
}

async function downloadDriveFileText(input: {
  fileId: string;
  accessToken: string;
  signal: AbortSignal;
}): Promise<string> {
  const response = await googleFetch(
    `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(input.fileId)}?alt=media&supportsAllDrives=true`,
    {},
    input.accessToken,
    input.signal,
  );
  if (!response.ok) {
    throw new GoogleToolCredentialError(
      'drive_api_error',
      `Google Drive download failed with HTTP ${response.status}.`,
      502,
    );
  }
  return readTextResponse(response);
}

async function exportGoogleDocText(input: {
  fileId: string;
  accessToken: string;
  signal: AbortSignal;
}): Promise<string> {
  const params = new URLSearchParams({ mimeType: 'text/plain' });
  const response = await googleFetch(
    `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(input.fileId)}/export?${params.toString()}`,
    {},
    input.accessToken,
    input.signal,
  );
  if (!response.ok) {
    throw new GoogleToolCredentialError(
      'drive_api_error',
      `Google Docs export failed with HTTP ${response.status}.`,
      502,
    );
  }
  return readTextResponse(response);
}

// ---------------------------------------------------------------------------
// Google Docs text extraction
// ---------------------------------------------------------------------------

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
        if (cellTexts.length > 0) blocks.push(cellTexts.join(' | '));
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

async function fetchGoogleDoc(input: {
  fileId: string;
  accessToken: string;
  signal: AbortSignal;
}): Promise<{ title: string; text: string }> {
  const response = await googleFetch(
    `${GOOGLE_DOCS_API_BASE}/documents/${encodeURIComponent(input.fileId)}`,
    {},
    input.accessToken,
    input.signal,
  );
  if (!response.ok) {
    throw new GoogleToolCredentialError(
      'drive_api_error',
      `Google Docs read failed with HTTP ${response.status}.`,
      502,
    );
  }
  const payload = await readJsonMapResponse(response, 'Google Docs');
  const title =
    typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : input.fileId;
  const body = parseJsonMap(payload.body);
  const content = Array.isArray(body?.content) ? body.content : [];
  return { title, text: extractGoogleDocText(content) };
}

function validateGoogleDocsBatchUpdateInput(args: Record<string, unknown>): {
  bindingRef: string;
  requests: JsonMap[];
  writeControl: JsonMap | null;
} {
  const bindingRef =
    typeof args.bindingRef === 'string' ? args.bindingRef.trim() : '';
  if (!bindingRef) {
    throw new GoogleToolCredentialError(
      'invalid_request',
      'google_docs_batch_update requires bindingRef.',
      400,
    );
  }
  const rawRequests = Array.isArray(args.requests) ? args.requests : [];
  const requests = rawRequests.map((request) => parseJsonMap(request));
  if (requests.some((request) => !request)) {
    throw new GoogleToolCredentialError(
      'invalid_request',
      'google_docs_batch_update requests must be JSON objects.',
      400,
    );
  }
  if (requests.length === 0) {
    throw new GoogleToolCredentialError(
      'invalid_request',
      'google_docs_batch_update requires a non-empty requests array.',
      400,
    );
  }
  if (requests.length > MAX_GOOGLE_DOCS_BATCH_REQUESTS) {
    throw new GoogleToolCredentialError(
      'invalid_request',
      `google_docs_batch_update supports at most ${MAX_GOOGLE_DOCS_BATCH_REQUESTS} requests per call.`,
      400,
    );
  }
  return {
    bindingRef,
    requests: requests as JsonMap[],
    writeControl: parseJsonMap(args.writeControl),
  };
}

async function batchUpdateGoogleDoc(input: {
  fileId: string;
  accessToken: string;
  signal: AbortSignal;
  requests: JsonMap[];
  writeControl: JsonMap | null;
}): Promise<JsonMap> {
  const response = await googleFetch(
    `${GOOGLE_DOCS_API_BASE}/documents/${encodeURIComponent(input.fileId)}:batchUpdate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: input.requests,
        ...(input.writeControl ? { writeControl: input.writeControl } : {}),
      }),
    },
    input.accessToken,
    input.signal,
  );
  if (!response.ok) {
    throw new GoogleToolCredentialError(
      'drive_api_error',
      `Google Docs batch update failed with HTTP ${response.status}.`,
      502,
    );
  }
  return readJsonMapResponse(response, 'Google Docs batch update');
}

async function createGoogleDoc(input: {
  title: string;
  accessToken: string;
  signal: AbortSignal;
}): Promise<{ documentId: string; title: string; url: string }> {
  const response = await googleFetch(
    `${GOOGLE_DOCS_API_BASE}/documents`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: input.title }),
    },
    input.accessToken,
    input.signal,
  );
  if (!response.ok) {
    throw new GoogleToolCredentialError(
      'drive_api_error',
      `Google Docs create failed with HTTP ${response.status}.`,
      502,
    );
  }
  const payload = await readJsonMapResponse(response, 'Google Docs');
  const documentId =
    typeof payload.documentId === 'string' ? payload.documentId : null;
  if (!documentId) {
    throw new GoogleToolCredentialError(
      'drive_api_error',
      'Google Docs create response did not include documentId.',
      502,
    );
  }
  const title =
    typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : input.title;
  return {
    documentId,
    title,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
  };
}

// ---------------------------------------------------------------------------
// Google Sheets — values.get + values.batchUpdate
// ---------------------------------------------------------------------------

async function fetchSheetRange(input: {
  spreadsheetId: string;
  range: string;
  valueRenderOption: string | null;
  accessToken: string;
  signal: AbortSignal;
}): Promise<JsonMap> {
  const params = new URLSearchParams();
  if (input.valueRenderOption) {
    params.set('valueRenderOption', input.valueRenderOption);
  }
  const qs = params.toString();
  const url =
    `${GOOGLE_SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(input.spreadsheetId)}` +
    `/values/${encodeURIComponent(input.range)}${qs ? `?${qs}` : ''}`;
  const response = await googleFetch(url, {}, input.accessToken, input.signal);
  if (!response.ok) {
    throw new GoogleToolCredentialError(
      'drive_api_error',
      `Google Sheets read failed with HTTP ${response.status}.`,
      502,
    );
  }
  return readJsonMapResponse(response, 'Google Sheets');
}

function validateGoogleSheetsBatchUpdateInput(args: Record<string, unknown>): {
  bindingRef: string;
  data: JsonMap[];
  valueInputOption: 'RAW' | 'USER_ENTERED';
} {
  const bindingRef =
    typeof args.bindingRef === 'string' ? args.bindingRef.trim() : '';
  if (!bindingRef) {
    throw new GoogleToolCredentialError(
      'invalid_request',
      'google_sheets_batch_update requires bindingRef.',
      400,
    );
  }
  const rawUpdates = Array.isArray(args.updates) ? args.updates : [];
  if (rawUpdates.length === 0) {
    throw new GoogleToolCredentialError(
      'invalid_request',
      'google_sheets_batch_update requires a non-empty updates array.',
      400,
    );
  }
  if (rawUpdates.length > MAX_GOOGLE_SHEETS_BATCH_UPDATES) {
    throw new GoogleToolCredentialError(
      'invalid_request',
      `google_sheets_batch_update supports at most ${MAX_GOOGLE_SHEETS_BATCH_UPDATES} updates per call.`,
      400,
    );
  }
  const data: JsonMap[] = [];
  for (const entry of rawUpdates) {
    const map = parseJsonMap(entry);
    if (!map) {
      throw new GoogleToolCredentialError(
        'invalid_request',
        'google_sheets_batch_update updates must be JSON objects.',
        400,
      );
    }
    const range = typeof map.range === 'string' ? map.range.trim() : '';
    if (!range) {
      throw new GoogleToolCredentialError(
        'invalid_request',
        'each updates[].range must be a non-empty string.',
        400,
      );
    }
    if (!Array.isArray(map.values)) {
      throw new GoogleToolCredentialError(
        'invalid_request',
        'each updates[].values must be a 2D array of cell values.',
        400,
      );
    }
    data.push({ range, values: map.values });
  }
  // USER_ENTERED matches the typical "write what a person would type" intent —
  // formulas evaluate, dates parse, numbers stay numeric. RAW preserves the
  // literal string for cases where the agent needs to bypass auto-parsing.
  const rawOption =
    typeof args.valueInputOption === 'string'
      ? args.valueInputOption.trim().toUpperCase()
      : '';
  const valueInputOption: 'RAW' | 'USER_ENTERED' =
    rawOption === 'RAW' ? 'RAW' : 'USER_ENTERED';
  return { bindingRef, data, valueInputOption };
}

async function batchUpdateSheetValues(input: {
  spreadsheetId: string;
  data: JsonMap[];
  valueInputOption: 'RAW' | 'USER_ENTERED';
  accessToken: string;
  signal: AbortSignal;
}): Promise<JsonMap> {
  const response = await googleFetch(
    `${GOOGLE_SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values:batchUpdate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        valueInputOption: input.valueInputOption,
        data: input.data,
      }),
    },
    input.accessToken,
    input.signal,
  );
  if (!response.ok) {
    throw new GoogleToolCredentialError(
      'drive_api_error',
      `Google Sheets batch update failed with HTTP ${response.status}.`,
      502,
    );
  }
  return readJsonMapResponse(response, 'Google Sheets batch update');
}

// ---------------------------------------------------------------------------
// Individual tool executors
// ---------------------------------------------------------------------------

async function executeListFolder(
  input: ToolContext,
  resources: BoundGoogleDriveResource[],
): Promise<ExecutorResult> {
  const bindingRef = readString(input.args.bindingRef);
  if (!bindingRef) {
    return errorResult('google_drive_list_folder requires bindingRef.');
  }
  const folder = resources.find((r) => r.ref === bindingRef);
  if (!folder || folder.bindingKind !== 'google_drive_folder') {
    return errorResult(
      `unbound_resource: ${bindingRef} is not a bound folder. Use a folder ref like G1.`,
    );
  }
  const maxResults = coercePositiveInt(
    input.args.maxResults,
    DEFAULT_FOLDER_RESULTS,
    100,
  );

  const payload = await withTokenRefresh(
    input.userId,
    ['drive.readonly'],
    async (accessToken) => {
      const params = new URLSearchParams({
        q: `'${escapeDriveQueryValue(folder.externalId)}' in parents and trashed = false`,
        fields: 'files(id,name,mimeType,webViewLink,parents)',
        orderBy: 'folder,name',
        pageSize: String(maxResults),
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      return fetchDriveJson(
        `${GOOGLE_DRIVE_API_BASE}/files?${params.toString()}`,
        accessToken,
        input.signal,
      );
    },
  );

  const files = Array.isArray(payload.files)
    ? payload.files.filter(
        (entry): entry is JsonMap =>
          !!entry && typeof entry === 'object' && !Array.isArray(entry),
      )
    : [];
  return okResult({
    folder: {
      bindingRef: folder.ref,
      displayName: folder.displayName,
      folderId: folder.externalId,
    },
    children: files.map((entry) => ({
      fileId: typeof entry.id === 'string' ? entry.id : null,
      displayName:
        typeof entry.name === 'string' && entry.name.trim()
          ? entry.name.trim()
          : typeof entry.id === 'string'
            ? entry.id
            : 'unknown',
      mimeType: typeof entry.mimeType === 'string' ? entry.mimeType : null,
      webViewLink:
        typeof entry.webViewLink === 'string' ? entry.webViewLink : null,
    })),
  });
}

async function executeSearch(
  input: ToolContext,
  resources: BoundGoogleDriveResource[],
  boundFoldersById: Map<string, BoundGoogleDriveResource>,
  metadataCache: Map<string, GoogleDriveFileMetadata>,
): Promise<ExecutorResult> {
  const query = readString(input.args.query);
  if (!query) {
    return errorResult('google_drive_search requires a non-empty query.');
  }
  const maxResults = coercePositiveInt(
    input.args.maxResults,
    DEFAULT_SEARCH_RESULTS,
    50,
  );

  const loweredQuery = query.toLowerCase();
  const seenIds = new Set<string>();
  const results: Array<Record<string, unknown>> = [];

  // Pass 1: match against bound resource displayName / externalId.
  for (const resource of resources) {
    if (results.length >= maxResults) break;
    if (
      resource.displayName.toLowerCase().includes(loweredQuery) ||
      resource.externalId.toLowerCase().includes(loweredQuery)
    ) {
      seenIds.add(resource.externalId);
      results.push({
        resultType: 'bound_resource',
        bindingRef: resource.ref,
        displayName: resource.displayName,
        kind: resource.bindingKind,
        fileId: resource.externalId,
        mimeType: resource.mimeType,
        webViewLink: resource.url,
      });
    }
  }

  // Pass 2: Drive API search (C5: query escaped), then C4 filter — every
  // returned fileId must either be a direct binding OR live inside a
  // bound folder. Raw matches outside the bound surface are dropped.
  if (results.length < maxResults) {
    await withTokenRefresh(
      input.userId,
      ['drive.readonly'],
      async (accessToken) => {
        const params = new URLSearchParams({
          q: `trashed = false and (name contains '${escapeDriveQueryValue(query)}' or fullText contains '${escapeDriveQueryValue(query)}')`,
          fields: 'files(id,name,mimeType,webViewLink,parents)',
          pageSize: String(Math.max(maxResults * 3, 10)),
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        });
        const payload = await fetchDriveJson(
          `${GOOGLE_DRIVE_API_BASE}/files?${params.toString()}`,
          accessToken,
          input.signal,
        );
        const files = Array.isArray(payload.files)
          ? payload.files.filter(
              (entry): entry is JsonMap =>
                !!entry && typeof entry === 'object' && !Array.isArray(entry),
            )
          : [];
        for (const entry of files) {
          if (results.length >= maxResults) break;
          const fileId = typeof entry.id === 'string' ? entry.id : null;
          if (!fileId || seenIds.has(fileId)) continue;

          const directBinding = resources.find(
            (r) =>
              r.bindingKind === 'google_drive_file' && r.externalId === fileId,
          );
          if (directBinding) {
            seenIds.add(fileId);
            results.push({
              resultType: 'bound_resource',
              bindingRef: directBinding.ref,
              displayName: directBinding.displayName,
              kind: directBinding.bindingKind,
              fileId,
              mimeType:
                typeof entry.mimeType === 'string'
                  ? entry.mimeType
                  : directBinding.mimeType,
              webViewLink:
                typeof entry.webViewLink === 'string'
                  ? entry.webViewLink
                  : directBinding.url,
            });
            continue;
          }
          const parents = Array.isArray(entry.parents)
            ? entry.parents.filter(
                (value): value is string => typeof value === 'string',
              )
            : [];
          const parentBindingRef = await findContainingBoundFolderRef({
            accessToken,
            signal: input.signal,
            cache: metadataCache,
            startParents: parents,
            boundFoldersById,
          });
          if (!parentBindingRef) continue;
          seenIds.add(fileId);
          results.push({
            resultType: 'folder_child',
            parentBindingRef,
            displayName:
              typeof entry.name === 'string' && entry.name.trim()
                ? entry.name.trim()
                : fileId,
            fileId,
            mimeType:
              typeof entry.mimeType === 'string' ? entry.mimeType : null,
            webViewLink:
              typeof entry.webViewLink === 'string' ? entry.webViewLink : null,
          });
        }
      },
    );
  }

  return okResult({ query, results });
}

async function executeDriveRead(
  input: ToolContext,
  resources: BoundGoogleDriveResource[],
  boundFoldersById: Map<string, BoundGoogleDriveResource>,
  metadataCache: Map<string, GoogleDriveFileMetadata>,
): Promise<ExecutorResult> {
  const bindingRef = readString(input.args.bindingRef);
  const fileIdArg = readString(input.args.fileId);
  if (!bindingRef && !fileIdArg) {
    return errorResult(
      'google_drive_read requires either bindingRef or fileId.',
    );
  }

  let fileId = fileIdArg;
  let displayName: string | null = null;
  if (bindingRef) {
    const resource = resources.find((r) => r.ref === bindingRef);
    if (!resource) {
      return errorResult(
        `unbound_resource: ${bindingRef} was not found. Use a ref like G1.`,
      );
    }
    if (resource.bindingKind === 'google_drive_folder') {
      return errorResult(
        `${bindingRef} is a folder. Use google_drive_list_folder or google_drive_search to find a file inside it first.`,
      );
    }
    fileId = resource.externalId;
    displayName = resource.displayName;
  }

  return withTokenRefresh(
    input.userId,
    ['drive.readonly'],
    async (accessToken) => {
      const metadata = await fetchDriveFileMetadata({
        fileId,
        accessToken,
        signal: input.signal,
        cache: metadataCache,
      });
      if (metadata.mimeType === GOOGLE_DRIVE_FOLDER_MIME) {
        return errorResult(
          'google_drive_read can only read files. Use google_drive_list_folder for folders.',
        );
      }
      // C4: even when the caller passed bindingRef, re-check the resolved
      // file ID against bindings — a Drive shortcut could redirect us
      // outside the bound surface.
      const directBoundFile = resources.find(
        (r) =>
          r.bindingKind === 'google_drive_file' && r.externalId === metadata.id,
      );
      const allowedByDirectBinding = !!directBoundFile;
      const allowedByFolder =
        !allowedByDirectBinding &&
        (await findContainingBoundFolderRef({
          accessToken,
          signal: input.signal,
          cache: metadataCache,
          startParents: metadata.parents,
          boundFoldersById,
        }));
      if (!allowedByDirectBinding && !allowedByFolder) {
        return errorResult(
          'unbound_resource: that Drive file is outside this Talk’s bound resources.',
        );
      }
      let content: string;
      if (metadata.mimeType === GOOGLE_DOCS_MIME) {
        content = await exportGoogleDocText({
          fileId: metadata.id,
          accessToken,
          signal: input.signal,
        });
      } else if (metadata.mimeType === GOOGLE_SHEETS_MIME) {
        return errorResult(
          'Google Sheets files are not readable through google_drive_read yet.',
        );
      } else if (isTextLikeMimeType(metadata.mimeType)) {
        content = await downloadDriveFileText({
          fileId: metadata.id,
          accessToken,
          signal: input.signal,
        });
      } else {
        return errorResult(
          `The bound Drive file "${metadata.name}" has mime type ${metadata.mimeType || 'unknown'} and cannot be read as text.`,
        );
      }
      return okResult(
        [`# ${displayName || metadata.name}`, '', content].join('\n'),
      );
    },
  );
}

async function executeDocsRead(
  input: ToolContext,
  resources: BoundGoogleDriveResource[],
): Promise<ExecutorResult> {
  const bindingRef = readString(input.args.bindingRef);
  if (!bindingRef) {
    return errorResult('google_docs_read requires bindingRef.');
  }
  const resource = resources.find((r) => r.ref === bindingRef);
  if (!resource) {
    return errorResult(
      `unbound_resource: ${bindingRef} was not found. Use a file ref like G1.`,
    );
  }
  if (resource.bindingKind !== 'google_drive_file') {
    return errorResult(
      `${bindingRef} is a folder. Bind a Google Doc file directly before using google_docs_read.`,
    );
  }
  if (resource.mimeType && resource.mimeType !== GOOGLE_DOCS_MIME) {
    return errorResult(
      `${bindingRef} is not a Google Doc. Bind a Google Doc file before using google_docs_read.`,
    );
  }
  return withTokenRefresh(
    input.userId,
    ['documents.readonly'],
    async (accessToken) => {
      const document = await fetchGoogleDoc({
        fileId: resource.externalId,
        accessToken,
        signal: input.signal,
      });
      return okResult(
        [`# ${resource.displayName || document.title}`, '', document.text].join(
          '\n',
        ),
      );
    },
  );
}

async function executeDocsBatchUpdate(
  input: ToolContext,
  resources: BoundGoogleDriveResource[],
): Promise<ExecutorResult> {
  // C6 mutation gate
  if (input.jobPolicy && !input.jobPolicy.allowExternalMutation) {
    return errorResult(
      'external_mutation_blocked: google_docs_batch_update is not allowed under the current scheduled job policy.',
    );
  }
  const { bindingRef, requests, writeControl } =
    validateGoogleDocsBatchUpdateInput(input.args);
  const resource = resources.find((r) => r.ref === bindingRef);
  if (!resource) {
    return errorResult(
      `unbound_resource: ${bindingRef} was not found. Use a file ref like G1.`,
    );
  }
  if (resource.bindingKind !== 'google_drive_file') {
    return errorResult(
      `${bindingRef} is a folder. Bind a Google Doc file directly before using google_docs_batch_update.`,
    );
  }
  if (resource.mimeType && resource.mimeType !== GOOGLE_DOCS_MIME) {
    return errorResult(
      `${bindingRef} is not a Google Doc. Bind a Google Doc file before using google_docs_batch_update.`,
    );
  }

  return withTokenRefresh(input.userId, ['documents'], async (accessToken) => {
    const response = await batchUpdateGoogleDoc({
      fileId: resource.externalId,
      accessToken,
      signal: input.signal,
      requests,
      writeControl,
    });
    return okResult(response);
  });
}

async function executeDocsCreate(input: ToolContext): Promise<ExecutorResult> {
  // C6 mutation gate
  if (input.jobPolicy && !input.jobPolicy.allowExternalMutation) {
    return errorResult(
      'external_mutation_blocked: google_docs_create is not allowed under the current scheduled job policy.',
    );
  }
  const title = readString(input.args.title);
  if (!title) {
    return errorResult('google_docs_create requires a non-empty title.');
  }

  const created = await withTokenRefresh(
    input.userId,
    ['documents'],
    async (accessToken) => {
      return createGoogleDoc({
        title,
        accessToken,
        signal: input.signal,
      });
    },
  );

  // Self-bind the new doc to the Talk. Idempotent on conflict (the
  // 4-column unique index added in migration 0018 covers this — same
  // owner re-creating dedupes; different owners get distinct rows).
  await createTalkResourceBinding({
    ownerId: input.userId,
    talkId: input.talkId,
    bindingKind: 'google_drive_file',
    externalId: created.documentId,
    displayName: created.title,
    metadata: { mimeType: GOOGLE_DOCS_MIME, url: created.url },
    createdBy: input.userId,
  });

  // Re-load bindings so we can report the new G-ref to the LLM.
  const fresh = await loadGoogleDriveBindings(input.talkId);
  const newBinding = fresh.find((b) => b.externalId === created.documentId);
  const ref = newBinding ? newBinding.ref : 'G?';
  return okResult(`Created ${ref}: "${created.title}" at ${created.url}`);
}

async function executeSheetsReadRange(
  input: ToolContext,
  resources: BoundGoogleDriveResource[],
): Promise<ExecutorResult> {
  const bindingRef = readString(input.args.bindingRef);
  if (!bindingRef) {
    return errorResult('google_sheets_read_range requires bindingRef.');
  }
  const range = readString(input.args.range);
  if (!range) {
    return errorResult(
      'google_sheets_read_range requires a non-empty range (A1 notation).',
    );
  }
  const resource = resources.find((r) => r.ref === bindingRef);
  if (!resource) {
    return errorResult(
      `unbound_resource: ${bindingRef} was not found. Use a file ref like G1.`,
    );
  }
  if (resource.bindingKind !== 'google_drive_file') {
    return errorResult(
      `${bindingRef} is a folder. Bind a Google Sheet file directly before using google_sheets_read_range.`,
    );
  }
  if (resource.mimeType && resource.mimeType !== GOOGLE_SHEETS_MIME) {
    return errorResult(
      `${bindingRef} is not a Google Sheet. Bind a Sheets file before using google_sheets_read_range.`,
    );
  }
  const valueRenderOption = readString(input.args.valueRenderOption) || null;
  return withTokenRefresh(
    input.userId,
    ['spreadsheets.readonly'],
    async (accessToken) => {
      const payload = await fetchSheetRange({
        spreadsheetId: resource.externalId,
        range,
        valueRenderOption,
        accessToken,
        signal: input.signal,
      });
      const returnedRange =
        typeof payload.range === 'string' ? payload.range : range;
      const values = Array.isArray(payload.values) ? payload.values : [];
      return okResult({
        range: returnedRange,
        majorDimension:
          typeof payload.majorDimension === 'string'
            ? payload.majorDimension
            : 'ROWS',
        values,
      });
    },
  );
}

async function executeSheetsBatchUpdate(
  input: ToolContext,
  resources: BoundGoogleDriveResource[],
): Promise<ExecutorResult> {
  // C6 mutation gate
  if (input.jobPolicy && !input.jobPolicy.allowExternalMutation) {
    return errorResult(
      'external_mutation_blocked: google_sheets_batch_update is not allowed under the current scheduled job policy.',
    );
  }
  const { bindingRef, data, valueInputOption } =
    validateGoogleSheetsBatchUpdateInput(input.args);
  const resource = resources.find((r) => r.ref === bindingRef);
  if (!resource) {
    return errorResult(
      `unbound_resource: ${bindingRef} was not found. Use a file ref like G1.`,
    );
  }
  if (resource.bindingKind !== 'google_drive_file') {
    return errorResult(
      `${bindingRef} is a folder. Bind a Google Sheet file directly before using google_sheets_batch_update.`,
    );
  }
  if (resource.mimeType && resource.mimeType !== GOOGLE_SHEETS_MIME) {
    return errorResult(
      `${bindingRef} is not a Google Sheet. Bind a Sheets file before using google_sheets_batch_update.`,
    );
  }
  return withTokenRefresh(
    input.userId,
    ['spreadsheets'],
    async (accessToken) => {
      const response = await batchUpdateSheetValues({
        spreadsheetId: resource.externalId,
        data,
        valueInputOption,
        accessToken,
        signal: input.signal,
      });
      return okResult(response);
    },
  );
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

interface ToolContext {
  talkId: string;
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
  jobPolicy: GoogleDriveJobPolicy | null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function executeGoogleDriveTalkTool(input: {
  talkId: string;
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
  jobPolicy?: GoogleDriveJobPolicy | null;
}): Promise<ExecutorResult> {
  const ctx: ToolContext = {
    talkId: input.talkId,
    userId: input.userId,
    toolName: input.toolName,
    args: input.args,
    signal: input.signal,
    jobPolicy: input.jobPolicy ?? null,
  };

  try {
    // google_docs_create doesn't require pre-existing bindings — it
    // creates and self-binds, so handle it before the bindings load.
    if (ctx.toolName === 'google_docs_create') {
      return await executeDocsCreate(ctx);
    }

    const resources = await loadGoogleDriveBindings(ctx.talkId);
    if (resources.length === 0) {
      return errorResult(
        'No Google Drive resources are bound to this Talk. Ask the user to add a binding via the Tools tab.',
      );
    }
    const boundFoldersById = new Map(
      resources
        .filter((r) => r.bindingKind === 'google_drive_folder')
        .map((r) => [r.externalId, r]),
    );
    const metadataCache = new Map<string, GoogleDriveFileMetadata>();

    switch (ctx.toolName) {
      case 'google_drive_list_folder':
        return await executeListFolder(ctx, resources);
      case 'google_drive_search':
        return await executeSearch(
          ctx,
          resources,
          boundFoldersById,
          metadataCache,
        );
      case 'google_drive_read':
        return await executeDriveRead(
          ctx,
          resources,
          boundFoldersById,
          metadataCache,
        );
      case 'google_docs_read':
        return await executeDocsRead(ctx, resources);
      case 'google_docs_batch_update':
        return await executeDocsBatchUpdate(ctx, resources);
      case 'google_sheets_read_range':
        return await executeSheetsReadRange(ctx, resources);
      case 'google_sheets_batch_update':
        return await executeSheetsBatchUpdate(ctx, resources);
      default:
        return errorResult(
          `Tool '${ctx.toolName}' is not a supported Google Drive Talk tool.`,
        );
    }
  } catch (err) {
    if (err instanceof GoogleToolCredentialError) {
      return errorFromCredential(err);
    }
    throw err;
  }
}
