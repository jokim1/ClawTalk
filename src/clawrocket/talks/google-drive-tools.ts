import type { LlmToolDefinition } from '../agents/llm-client.js';
import {
  BUILTIN_TALK_TOOLS,
  getUserGoogleCredential,
  listTalkResourceBindings,
  listTalkToolGrants,
  type TalkResourceBindingKind,
} from '../db/index.js';
import { getValidGoogleToolAccessToken } from '../identity/google-tools-service.js';

const GOOGLE_DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const GOOGLE_DOCS_API_BASE = 'https://docs.googleapis.com/v1';
const GOOGLE_DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_DOCS_MIME = 'application/vnd.google-apps.document';
const GOOGLE_SHEETS_MIME = 'application/vnd.google-apps.spreadsheet';
const MAX_TEXT_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_SEARCH_RESULTS = 10;
const DEFAULT_FOLDER_RESULTS = 25;
const MAX_GOOGLE_DOCS_BATCH_REQUESTS = 50;

type JsonMap = Record<string, unknown>;

type GoogleDriveBindingKind = Extract<
  TalkResourceBindingKind,
  'google_drive_file' | 'google_drive_folder'
>;

type BoundGoogleDriveResource = {
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

function parseJsonMap(value: unknown): JsonMap | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonMap)
    : null;
}

function normalizeGoogleDriveBindings(
  talkId: string,
): BoundGoogleDriveResource[] {
  return listTalkResourceBindings(talkId)
    .filter(
      (
        binding,
      ): binding is typeof binding & { bindingKind: GoogleDriveBindingKind } =>
        binding.bindingKind === 'google_drive_file' ||
        binding.bindingKind === 'google_drive_folder',
    )
    .map((binding, index) => {
      const metadata = parseJsonMap(binding.metadata);
      const mimeType =
        metadata && typeof metadata.mimeType === 'string'
          ? metadata.mimeType
          : null;
      const url =
        metadata && typeof metadata.url === 'string' ? metadata.url : null;
      return {
        ref: `G${index + 1}`,
        bindingId: binding.id,
        bindingKind: binding.bindingKind,
        externalId: binding.externalId,
        displayName: binding.displayName,
        mimeType,
        url,
      };
    });
}

function hasTalkToolGrant(talkId: string, toolId: string): boolean {
  const grants = listTalkToolGrants(talkId);
  if (grants.length === 0) {
    return (
      BUILTIN_TALK_TOOLS.find((tool) => tool.id === toolId)?.defaultGrant ??
      false
    );
  }
  return grants.some((grant) => grant.toolId === toolId && grant.enabled);
}

function hasGoogleScope(
  userId: string | null | undefined,
  scope: string,
): boolean {
  if (!userId) return false;
  const credential = getUserGoogleCredential(userId);
  return credential?.scopes.includes(scope) ?? false;
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

async function getGoogleAccessToken(
  userId: string,
  requiredScopes: string[],
): Promise<string> {
  const token = await getValidGoogleToolAccessToken({
    userId,
    requiredScopes,
  });
  return token.accessToken;
}

async function readTextResponse(response: Response): Promise<string> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_RESPONSE_BYTES) {
    throw new Error('Google Drive response exceeded the maximum allowed size.');
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
    throw new Error(`${errorPrefix} response was not a JSON object.`);
  }
  return map;
}

async function fetchDriveJson(
  url: string,
  accessToken: string,
  signal: AbortSignal,
): Promise<JsonMap> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Google Drive request failed with HTTP ${response.status}.`,
    );
  }
  const parsed = (await response.json()) as unknown;
  const map = parseJsonMap(parsed);
  if (!map) {
    throw new Error('Google Drive response was not a JSON object.');
  }
  return map;
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
    if (boundFolder) {
      return boundFolder.ref;
    }

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
  const response = await fetch(
    `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(input.fileId)}?alt=media&supportsAllDrives=true`,
    {
      headers: {
        authorization: `Bearer ${input.accessToken}`,
      },
      signal: input.signal,
    },
  );
  if (!response.ok) {
    throw new Error(
      `Google Drive download failed with HTTP ${response.status}.`,
    );
  }
  return readTextResponse(response);
}

async function exportGoogleDocText(input: {
  fileId: string;
  accessToken: string;
  signal: AbortSignal;
}): Promise<string> {
  const params = new URLSearchParams({
    mimeType: 'text/plain',
  });
  const response = await fetch(
    `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(input.fileId)}/export?${params.toString()}`,
    {
      headers: {
        authorization: `Bearer ${input.accessToken}`,
      },
      signal: input.signal,
    },
  );
  if (!response.ok) {
    throw new Error(`Google Docs export failed with HTTP ${response.status}.`);
  }
  return readTextResponse(response);
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

async function fetchGoogleDoc(input: {
  fileId: string;
  accessToken: string;
  signal: AbortSignal;
}): Promise<{ title: string; text: string }> {
  const response = await fetch(
    `${GOOGLE_DOCS_API_BASE}/documents/${encodeURIComponent(input.fileId)}`,
    {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${input.accessToken}`,
      },
      signal: input.signal,
    },
  );
  if (!response.ok) {
    throw new Error(`Google Docs read failed with HTTP ${response.status}.`);
  }

  const payload = await readJsonMapResponse(response, 'Google Docs');
  const title =
    typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : input.fileId;
  const body = parseJsonMap(payload.body);
  const content = Array.isArray(body?.content) ? body.content : [];

  return {
    title,
    text: extractGoogleDocText(content),
  };
}

function validateGoogleDocsBatchUpdateInput(args: Record<string, unknown>): {
  bindingRef: string;
  requests: JsonMap[];
  writeControl: JsonMap | null;
} {
  const bindingRef =
    typeof args.bindingRef === 'string' ? args.bindingRef.trim() : '';
  if (!bindingRef) {
    throw new Error('google_docs_batch_update requires bindingRef.');
  }

  const rawRequests = Array.isArray(args.requests) ? args.requests : [];
  const requests = rawRequests.map((request) => parseJsonMap(request));
  if (requests.some((request) => !request)) {
    throw new Error('google_docs_batch_update requests must be JSON objects.');
  }
  if (requests.length === 0) {
    throw new Error(
      'google_docs_batch_update requires a non-empty requests array.',
    );
  }
  if (requests.length > MAX_GOOGLE_DOCS_BATCH_REQUESTS) {
    throw new Error(
      `google_docs_batch_update supports at most ${MAX_GOOGLE_DOCS_BATCH_REQUESTS} requests per call.`,
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
  const response = await fetch(
    `${GOOGLE_DOCS_API_BASE}/documents/${encodeURIComponent(input.fileId)}:batchUpdate`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requests: input.requests,
        ...(input.writeControl ? { writeControl: input.writeControl } : {}),
      }),
      signal: input.signal,
    },
  );
  if (!response.ok) {
    throw new Error(
      `Google Docs batch update failed with HTTP ${response.status}.`,
    );
  }
  return readJsonMapResponse(response, 'Google Docs batch update');
}

export function buildBoundGoogleDrivePromptSection(
  talkId: string,
): string | null {
  const resources = normalizeGoogleDriveBindings(talkId);
  if (resources.length === 0) return null;

  const lines = resources.map((resource) => {
    const kind =
      resource.bindingKind === 'google_drive_folder' ? 'FOLDER' : 'FILE';
    return `[${resource.ref}] ${kind} ${resource.displayName}`;
  });

  return [
    '**Bound Google Drive Resources:**',
    lines.join('\n'),
    'Use the Google Drive tools to search, list, or read these bound resources when available.',
  ].join('\n');
}

export function buildGoogleDriveContextTools(input: {
  talkId: string;
  userId?: string | null;
}): LlmToolDefinition[] {
  if (!input.userId) return [];
  const resources = normalizeGoogleDriveBindings(input.talkId);
  if (resources.length === 0) return [];

  const hasBoundDocFile = resources.some(
    (resource) =>
      resource.bindingKind === 'google_drive_file' &&
      (!resource.mimeType || resource.mimeType === GOOGLE_DOCS_MIME),
  );

  const tools: LlmToolDefinition[] = [];

  if (
    hasTalkToolGrant(input.talkId, 'google_drive_search') &&
    hasGoogleScope(input.userId, 'drive.readonly')
  ) {
    tools.push({
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
    });
  }

  if (
    hasTalkToolGrant(input.talkId, 'google_drive_read') &&
    hasGoogleScope(input.userId, 'drive.readonly')
  ) {
    tools.push({
      name: 'google_drive_read',
      description:
        'Read a bound Google Drive file by bindingRef (for a directly bound file like G1), or read a fileId that was discovered inside a bound folder via google_drive_search or google_drive_list_folder.',
      inputSchema: {
        type: 'object',
        properties: {
          bindingRef: {
            type: 'string',
            description:
              'Bound resource ref like G1 for a directly bound file.',
          },
          fileId: {
            type: 'string',
            description:
              'Drive file id discovered from google_drive_search or google_drive_list_folder.',
          },
        },
        required: ['bindingRef'],
      },
    });
  }

  if (
    hasTalkToolGrant(input.talkId, 'google_drive_list_folder') &&
    hasGoogleScope(input.userId, 'drive.readonly')
  ) {
    tools.push({
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
    });
  }

  if (
    hasBoundDocFile &&
    hasTalkToolGrant(input.talkId, 'google_docs_read') &&
    hasGoogleScope(input.userId, 'documents.readonly')
  ) {
    tools.push({
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
    });
  }

  if (
    hasBoundDocFile &&
    hasTalkToolGrant(input.talkId, 'google_docs_batch_update') &&
    hasGoogleScope(input.userId, 'documents')
  ) {
    tools.push({
      name: 'google_docs_batch_update',
      description:
        'Apply Google Docs API batchUpdate requests to a directly bound Google Doc by bindingRef. Bind the document file directly before using this tool.',
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
            items: {
              type: 'object',
              additionalProperties: true,
            },
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
    });
  }

  return tools;
}

function okResult(result: unknown): { result: string } {
  return {
    result: typeof result === 'string' ? result : JSON.stringify(result),
  };
}

function errorResult(message: string): { result: string; isError: true } {
  return { result: message, isError: true };
}

export async function executeGoogleDriveTalkTool(input: {
  talkId: string;
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<{ result: string; isError?: boolean }> {
  const resources = normalizeGoogleDriveBindings(input.talkId);
  if (resources.length === 0) {
    return errorResult('No Google Drive resources are bound to this Talk.');
  }
  const resourceByRef = new Map(
    resources.map((resource) => [resource.ref, resource]),
  );
  const boundFoldersById = new Map(
    resources
      .filter((resource) => resource.bindingKind === 'google_drive_folder')
      .map((resource) => [resource.externalId, resource]),
  );
  const metadataCache = new Map<string, GoogleDriveFileMetadata>();

  if (input.toolName === 'google_drive_list_folder') {
    const accessToken = await getGoogleAccessToken(input.userId, [
      'drive.readonly',
    ]);
    const bindingRef =
      typeof input.args.bindingRef === 'string'
        ? input.args.bindingRef.trim()
        : '';
    if (!bindingRef) {
      return errorResult('google_drive_list_folder requires bindingRef.');
    }
    const folder = resourceByRef.get(bindingRef);
    if (!folder || folder.bindingKind !== 'google_drive_folder') {
      return errorResult(
        `Bound folder ${bindingRef} was not found. Use a folder ref like G1.`,
      );
    }

    const maxResults = coercePositiveInt(
      input.args.maxResults,
      DEFAULT_FOLDER_RESULTS,
      100,
    );
    const params = new URLSearchParams({
      q: `'${escapeDriveQueryValue(folder.externalId)}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,webViewLink,parents)',
      orderBy: 'folder,name',
      pageSize: String(maxResults),
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

  if (input.toolName === 'google_drive_search') {
    const accessToken = await getGoogleAccessToken(input.userId, [
      'drive.readonly',
    ]);
    const query =
      typeof input.args.query === 'string' ? input.args.query.trim() : '';
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

    if (results.length < maxResults) {
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
          (resource) =>
            resource.bindingKind === 'google_drive_file' &&
            resource.externalId === fileId,
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
          mimeType: typeof entry.mimeType === 'string' ? entry.mimeType : null,
          webViewLink:
            typeof entry.webViewLink === 'string' ? entry.webViewLink : null,
        });
      }
    }

    return okResult({ query, results });
  }

  if (input.toolName === 'google_drive_read') {
    const accessToken = await getGoogleAccessToken(input.userId, [
      'drive.readonly',
    ]);
    const bindingRef =
      typeof input.args.bindingRef === 'string'
        ? input.args.bindingRef.trim()
        : '';
    const fileIdArg =
      typeof input.args.fileId === 'string' ? input.args.fileId.trim() : '';

    if (!bindingRef && !fileIdArg) {
      return errorResult(
        'google_drive_read requires either bindingRef or fileId.',
      );
    }

    let fileId = fileIdArg;
    let displayName: string | null = null;
    if (bindingRef) {
      const resource = resourceByRef.get(bindingRef);
      if (!resource) {
        return errorResult(
          `Bound resource ${bindingRef} was not found. Use a ref like G1 from the bound resource manifest.`,
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

    const directBoundFile = resources.find(
      (resource) =>
        resource.bindingKind === 'google_drive_file' &&
        resource.externalId === metadata.id,
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
        'That Drive file is outside this Talk’s bound resources.',
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
        'Google Sheets files are not readable through google_drive_read yet. Use a text document/file, or add Sheets-specific reading in a later change.',
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
  }

  if (input.toolName === 'google_docs_read') {
    const accessToken = await getGoogleAccessToken(input.userId, [
      'documents.readonly',
    ]);
    const bindingRef =
      typeof input.args.bindingRef === 'string'
        ? input.args.bindingRef.trim()
        : '';
    if (!bindingRef) {
      return errorResult('google_docs_read requires bindingRef.');
    }

    const resource = resourceByRef.get(bindingRef);
    if (!resource) {
      return errorResult(
        `Bound resource ${bindingRef} was not found. Use a file ref like G1 from the bound resource manifest.`,
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
  }

  if (input.toolName === 'google_docs_batch_update') {
    const accessToken = await getGoogleAccessToken(input.userId, ['documents']);
    try {
      const { bindingRef, requests, writeControl } =
        validateGoogleDocsBatchUpdateInput(input.args);
      const resource = resourceByRef.get(bindingRef);
      if (!resource) {
        return errorResult(
          `Bound resource ${bindingRef} was not found. Use a file ref like G1 from the bound resource manifest.`,
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

      const response = await batchUpdateGoogleDoc({
        fileId: resource.externalId,
        accessToken,
        signal: input.signal,
        requests,
        writeControl,
      });
      return okResult(response);
    } catch (error) {
      return errorResult(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return errorResult(
    `Tool '${input.toolName}' is not a supported Google Drive Talk tool.`,
  );
}
