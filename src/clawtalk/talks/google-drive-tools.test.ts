import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('../config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    GOOGLE_OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_PICKER_API_KEY: 'test-picker-key',
    GOOGLE_PICKER_APP_ID: 'test-picker-app',
  };
});

import {
  closePgDatabase,
  deleteAuthUsers,
  initPgDatabase,
  purgeUserData,
  seedAuthUser,
  seedTalk,
  withUserContext,
} from '../db/test-helpers.js';
import {
  createTalkResourceBinding,
  listTalkResourceBindings,
  upsertUserGoogleCredential,
} from '../db/talk-tools-accessors.js';
import {
  encryptGoogleToolCredential,
  type GoogleToolCredentialPayload,
} from '../identity/google-tools-credential-store.js';
import { normalizeGoogleScopeAliases } from '../identity/google-scopes.js';
import {
  buildBoundGoogleDrivePromptSection,
  buildGoogleDriveContextTools,
  executeGoogleDriveTalkTool,
  loadGoogleDriveBindings,
} from './google-drive-tools.js';

const DRIVE_READONLY_URL = 'https://www.googleapis.com/auth/drive.readonly';
const DOCUMENTS_URL = 'https://www.googleapis.com/auth/documents';
const SPREADSHEETS_URL = 'https://www.googleapis.com/auth/spreadsheets';
const GOOGLE_DOCS_MIME = 'application/vnd.google-apps.document';

async function seedDriveCredential(userId: string): Promise<void> {
  const payload: GoogleToolCredentialPayload = {
    kind: 'google_tools',
    accessToken: 'access-old',
    refreshToken: 'refresh-original',
    expiryDate: new Date(Date.now() + 3600_000).toISOString(),
    // Only grant the parent scopes; `expandImpliedScopes` in
    // google-scopes.ts widens these to cover the matching readonly
    // children at scope-check time. This doubles as a regression guard:
    // if a future change breaks the hierarchy logic, the Sheets/Docs
    // read tests (which require *.readonly) would start failing here.
    scopes: [DRIVE_READONLY_URL, DOCUMENTS_URL, SPREADSHEETS_URL],
    tokenType: 'Bearer',
  };
  await upsertUserGoogleCredential({
    userId,
    googleSubject: `sub-${userId.slice(0, 8)}`,
    email: 'tester@example.com',
    displayName: 'Tester',
    scopes: normalizeGoogleScopeAliases(payload.scopes),
    ciphertext: encryptGoogleToolCredential(payload),
    accessExpiresAt: payload.expiryDate ?? null,
  });
}

function mockFetchSequence(
  responses: Array<
    Partial<Response> & {
      jsonBody?: unknown;
      textBody?: string;
    }
  >,
): ReturnType<typeof vi.spyOn> {
  const spy = vi.spyOn(globalThis, 'fetch');
  for (const r of responses) {
    const status = r.status ?? 200;
    const ok = r.ok ?? (status >= 200 && status < 300);
    spy.mockResolvedValueOnce({
      ok,
      status,
      text: async () =>
        r.textBody !== undefined
          ? r.textBody
          : JSON.stringify(r.jsonBody ?? {}),
      json: async () => r.jsonBody ?? {},
    } as unknown as Response);
  }
  return spy;
}

const signal = new AbortController().signal;

describe('google-drive-tools — pure helpers', () => {
  describe('buildGoogleDriveContextTools', () => {
    it('returns read-side schemas (Drive + Docs + Sheets) when only read is enabled', () => {
      const tools = buildGoogleDriveContextTools({
        readEnabled: true,
        writeEnabled: false,
      });
      expect(tools.map((t) => t.name)).toEqual([
        'google_drive_search',
        'google_drive_read',
        'google_drive_list_folder',
        'google_docs_read',
        'google_sheets_read_range',
      ]);
    });
    it('returns write-side schemas (Docs + Sheets) when only write is enabled', () => {
      const tools = buildGoogleDriveContextTools({
        readEnabled: false,
        writeEnabled: true,
      });
      expect(tools.map((t) => t.name)).toEqual([
        'google_docs_create',
        'google_docs_batch_update',
        'google_sheets_batch_update',
      ]);
    });
    it('returns all 8 when both are enabled', () => {
      const tools = buildGoogleDriveContextTools({
        readEnabled: true,
        writeEnabled: true,
      });
      expect(tools.length).toBe(8);
    });
    it('returns empty array when both disabled', () => {
      const tools = buildGoogleDriveContextTools({
        readEnabled: false,
        writeEnabled: false,
      });
      expect(tools).toEqual([]);
    });
  });

  describe('buildBoundGoogleDrivePromptSection', () => {
    it('renders G-refs for bound resources', () => {
      const section = buildBoundGoogleDrivePromptSection([
        {
          ref: 'G1',
          bindingId: 'b1',
          bindingKind: 'google_drive_folder',
          externalId: 'folder-a',
          displayName: 'Project Docs',
          mimeType: null,
          url: null,
        },
        {
          ref: 'G2',
          bindingId: 'b2',
          bindingKind: 'google_drive_file',
          externalId: 'file-b',
          displayName: 'Spec',
          mimeType: GOOGLE_DOCS_MIME,
          url: null,
        },
      ]);
      expect(section).toContain('[G1] FOLDER Project Docs');
      expect(section).toContain('[G2] FILE Spec');
    });
    it('returns the empty-state instruction when no bindings exist', () => {
      const section = buildBoundGoogleDrivePromptSection([]);
      expect(section).toContain('No Drive resources are bound');
      expect(section).toContain('Tools tab');
    });
  });
});

describe('google-drive-tools — executor', () => {
  const userIds: string[] = [];

  beforeAll(async () => {
    await initPgDatabase();
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await purgeUserData(userIds);
      await deleteAuthUsers(userIds);
    }
    await closePgDatabase();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function setupTalkWithBindings(): Promise<{
    userId: string;
    talkId: string;
    fileRef: string;
    folderRef: string;
    fileId: string;
    folderId: string;
  }> {
    const userId = await seedAuthUser();
    userIds.push(userId);
    let talkId = '';
    let fileRef = 'G?';
    let folderRef = 'G?';
    const fileId = 'drive-file-xyz';
    const folderId = 'drive-folder-abc';
    await withUserContext(userId, async () => {
      await seedDriveCredential(userId);
      talkId = await seedTalk({ ownerId: userId });
      await createTalkResourceBinding({
        ownerId: userId,
        talkId,
        bindingKind: 'google_drive_folder',
        externalId: folderId,
        displayName: 'Project Folder',
      });
      await createTalkResourceBinding({
        ownerId: userId,
        talkId,
        bindingKind: 'google_drive_file',
        externalId: fileId,
        displayName: 'Spec Doc',
        metadata: { mimeType: GOOGLE_DOCS_MIME },
      });
      // G-ref assignment depends on created_at ordering. When two rows
      // share a microsecond the tiebreaker is id (UUID) which isn't
      // deterministic, so we discover the actual refs after the inserts
      // instead of assuming insertion order.
      const bindings = await loadGoogleDriveBindings(talkId);
      folderRef = bindings.find((b) => b.externalId === folderId)?.ref ?? 'G?';
      fileRef = bindings.find((b) => b.externalId === fileId)?.ref ?? 'G?';
    });
    return { userId, talkId, fileRef, folderRef, fileId, folderId };
  }

  it('rejects when no bindings exist and the tool is not google_docs_create', async () => {
    const userId = await seedAuthUser();
    userIds.push(userId);
    let talkId = '';
    await withUserContext(userId, async () => {
      await seedDriveCredential(userId);
      talkId = await seedTalk({ ownerId: userId });
      const result = await executeGoogleDriveTalkTool({
        talkId,
        userId,
        toolName: 'google_drive_search',
        args: { query: 'anything' },
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.result).toContain('No Google Drive resources are bound');
    });
  });

  it('google_drive_list_folder happy path returns the folder children', async () => {
    const setup = await setupTalkWithBindings();
    mockFetchSequence([
      {
        jsonBody: {
          files: [
            {
              id: 'child-1',
              name: 'Child One',
              mimeType: 'text/plain',
            },
          ],
        },
      },
    ]);
    await withUserContext(setup.userId, async () => {
      const result = await executeGoogleDriveTalkTool({
        talkId: setup.talkId,
        userId: setup.userId,
        toolName: 'google_drive_list_folder',
        args: { bindingRef: setup.folderRef },
        signal,
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result) as {
        folder: { bindingRef: string };
        children: Array<{ displayName: string }>;
      };
      expect(parsed.folder.bindingRef).toBe(setup.folderRef);
      expect(parsed.children[0].displayName).toBe('Child One');
    });
  });

  it('google_drive_list_folder rejects unknown bindingRef as unbound_resource (C4)', async () => {
    const setup = await setupTalkWithBindings();
    await withUserContext(setup.userId, async () => {
      const result = await executeGoogleDriveTalkTool({
        talkId: setup.talkId,
        userId: setup.userId,
        toolName: 'google_drive_list_folder',
        args: { bindingRef: 'G99' },
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.result).toContain('unbound_resource');
    });
  });

  it('google_drive_search escapes single-quotes in the user query (C5)', async () => {
    const setup = await setupTalkWithBindings();
    const spy = mockFetchSequence([{ jsonBody: { files: [] } }]);
    await withUserContext(setup.userId, async () => {
      await executeGoogleDriveTalkTool({
        talkId: setup.talkId,
        userId: setup.userId,
        toolName: 'google_drive_search',
        args: { query: "Joe's notes" },
        signal,
      });
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const url = spy.mock.calls[0][0] as string;
    // Drive query escape doubles the backslash and escapes the apostrophe.
    // URLSearchParams percent-encodes the result; the escaped sequence is
    // `\'` which encodes as `%5C%27`.
    expect(url).toContain('%5C%27');
  });

  it('google_drive_read rejects a raw fileId outside the bound surface (C4)', async () => {
    const setup = await setupTalkWithBindings();
    // Drive metadata for a fileId that has no bound parent.
    mockFetchSequence([
      {
        jsonBody: {
          id: 'orphan-file',
          name: 'Orphan',
          mimeType: 'text/plain',
          parents: ['unrelated-folder'],
        },
      },
      // findContainingBoundFolderRef will fetch metadata for the parent
      // folder to walk up the tree; return one with no further parents.
      {
        jsonBody: {
          id: 'unrelated-folder',
          name: 'Unrelated',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [],
        },
      },
    ]);
    await withUserContext(setup.userId, async () => {
      const result = await executeGoogleDriveTalkTool({
        talkId: setup.talkId,
        userId: setup.userId,
        toolName: 'google_drive_read',
        args: { fileId: 'orphan-file' },
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.result).toContain('unbound_resource');
    });
  });

  it('google_drive_read accepts a bindingRef pointing at a bound file', async () => {
    const setup = await setupTalkWithBindings();
    mockFetchSequence([
      // file metadata
      {
        jsonBody: {
          id: setup.fileId,
          name: 'Spec Doc',
          mimeType: GOOGLE_DOCS_MIME,
          parents: [],
        },
      },
      // export text
      { textBody: 'Document body text' },
    ]);
    await withUserContext(setup.userId, async () => {
      const result = await executeGoogleDriveTalkTool({
        talkId: setup.talkId,
        userId: setup.userId,
        toolName: 'google_drive_read',
        args: { bindingRef: setup.fileRef },
        signal,
      });
      expect(result.isError).toBeUndefined();
      expect(result.result).toContain('Document body text');
    });
  });

  it('google_docs_batch_update rejects > MAX_GOOGLE_DOCS_BATCH_REQUESTS', async () => {
    const setup = await setupTalkWithBindings();
    const requests = Array.from({ length: 51 }, () => ({
      insertText: { location: { index: 1 }, text: 'x' },
    }));
    await withUserContext(setup.userId, async () => {
      const result = await executeGoogleDriveTalkTool({
        talkId: setup.talkId,
        userId: setup.userId,
        toolName: 'google_docs_batch_update',
        args: { bindingRef: setup.fileRef, requests },
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.result).toContain('at most 50 requests');
    });
  });

  it('google_docs_batch_update is blocked when jobPolicy.allowExternalMutation is false (C6)', async () => {
    const setup = await setupTalkWithBindings();
    await withUserContext(setup.userId, async () => {
      const result = await executeGoogleDriveTalkTool({
        talkId: setup.talkId,
        userId: setup.userId,
        toolName: 'google_docs_batch_update',
        args: {
          bindingRef: setup.fileRef,
          requests: [{ insertText: { location: { index: 1 }, text: 'x' } }],
        },
        signal,
        jobPolicy: { allowExternalMutation: false },
      });
      expect(result.isError).toBe(true);
      expect(result.result).toContain('external_mutation_blocked');
    });
  });

  it('google_docs_create creates the doc + binds it + returns the new G-ref', async () => {
    const userId = await seedAuthUser();
    userIds.push(userId);
    let talkId = '';
    await withUserContext(userId, async () => {
      await seedDriveCredential(userId);
      talkId = await seedTalk({ ownerId: userId });
    });
    mockFetchSequence([
      {
        jsonBody: {
          documentId: 'new-doc-id',
          title: 'Test PR2',
        },
      },
    ]);
    await withUserContext(userId, async () => {
      const result = await executeGoogleDriveTalkTool({
        talkId,
        userId,
        toolName: 'google_docs_create',
        args: { title: 'Test PR2' },
        signal,
      });
      expect(result.isError).toBeUndefined();
      // First binding so it gets G1.
      expect(result.result).toContain('Created G1');
      expect(result.result).toContain('Test PR2');
      expect(result.result).toContain(
        'https://docs.google.com/document/d/new-doc-id/edit',
      );
      const bindings = await listTalkResourceBindings(talkId);
      expect(bindings.length).toBe(1);
      expect(bindings[0].externalId).toBe('new-doc-id');
    });
  });

  it('google_docs_create is blocked under jobPolicy.allowExternalMutation=false (C6)', async () => {
    const userId = await seedAuthUser();
    userIds.push(userId);
    let talkId = '';
    await withUserContext(userId, async () => {
      await seedDriveCredential(userId);
      talkId = await seedTalk({ ownerId: userId });
      const result = await executeGoogleDriveTalkTool({
        talkId,
        userId,
        toolName: 'google_docs_create',
        args: { title: 'Test PR2' },
        signal,
        jobPolicy: { allowExternalMutation: false },
      });
      expect(result.isError).toBe(true);
      expect(result.result).toContain('external_mutation_blocked');
    });
  });

  it('D2: a 401 on the Drive API triggers a refresh + retry that succeeds', async () => {
    const setup = await setupTalkWithBindings();
    // First call: 401. Then refresh-token POST returns a new access token.
    // Then retry: 200 with the folder listing.
    mockFetchSequence([
      // initial list-folder fetch returns 401
      { status: 401, jsonBody: { error: 'unauthorized' } },
      // refresh POST to oauth2.googleapis.com/token succeeds
      {
        jsonBody: {
          access_token: 'access-fresh',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      },
      // retried list-folder fetch returns the actual data
      {
        jsonBody: {
          files: [{ id: 'child-1', name: 'Retried', mimeType: 'text/plain' }],
        },
      },
    ]);
    await withUserContext(setup.userId, async () => {
      const result = await executeGoogleDriveTalkTool({
        talkId: setup.talkId,
        userId: setup.userId,
        toolName: 'google_drive_list_folder',
        args: { bindingRef: setup.folderRef },
        signal,
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result) as {
        children: Array<{ displayName: string }>;
      };
      expect(parsed.children[0].displayName).toBe('Retried');
    });
  });

  it('D2: a double-401 (even after refresh) surfaces google_reauth_required', async () => {
    const setup = await setupTalkWithBindings();
    mockFetchSequence([
      { status: 401, jsonBody: { error: 'unauthorized' } },
      // refresh succeeds
      {
        jsonBody: {
          access_token: 'access-fresh',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      },
      // retried call also returns 401
      { status: 401, jsonBody: { error: 'unauthorized' } },
    ]);
    await withUserContext(setup.userId, async () => {
      const result = await executeGoogleDriveTalkTool({
        talkId: setup.talkId,
        userId: setup.userId,
        toolName: 'google_drive_list_folder',
        args: { bindingRef: setup.folderRef },
        signal,
      });
      expect(result.isError).toBe(true);
      expect(result.result).toContain('google_reauth_required');
    });
  });

  it('google_drive_search query without bindings still uses the lookup-by-name path', async () => {
    const setup = await setupTalkWithBindings();
    // Query matches displayName of the folder binding → pass-1 result.
    await withUserContext(setup.userId, async () => {
      // Drive API is still called for pass-2; mock an empty result.
      mockFetchSequence([{ jsonBody: { files: [] } }]);
      const result = await executeGoogleDriveTalkTool({
        talkId: setup.talkId,
        userId: setup.userId,
        toolName: 'google_drive_search',
        args: { query: 'Project Folder' },
        signal,
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result) as {
        results: Array<{ bindingRef: string; resultType: string }>;
      };
      expect(parsed.results[0]).toMatchObject({
        bindingRef: setup.folderRef,
        resultType: 'bound_resource',
      });
    });
  });

  describe('google_sheets_*', () => {
    const GOOGLE_SHEETS_MIME = 'application/vnd.google-apps.spreadsheet';

    async function setupTalkWithSheetBinding(): Promise<{
      userId: string;
      talkId: string;
      sheetRef: string;
      sheetId: string;
    }> {
      const userId = await seedAuthUser();
      userIds.push(userId);
      const sheetId = 'sheet-id-xyz';
      let talkId = '';
      let sheetRef = 'G?';
      await withUserContext(userId, async () => {
        await seedDriveCredential(userId);
        talkId = await seedTalk({ ownerId: userId });
        await createTalkResourceBinding({
          ownerId: userId,
          talkId,
          bindingKind: 'google_drive_file',
          externalId: sheetId,
          displayName: 'Budget Sheet',
          metadata: { mimeType: GOOGLE_SHEETS_MIME },
        });
        const bindings = await loadGoogleDriveBindings(talkId);
        sheetRef = bindings.find((b) => b.externalId === sheetId)?.ref ?? 'G?';
      });
      return { userId, talkId, sheetRef, sheetId };
    }

    it('google_sheets_read_range happy path returns the values array', async () => {
      const setup = await setupTalkWithSheetBinding();
      mockFetchSequence([
        {
          jsonBody: {
            range: 'Sheet1!A1:B2',
            majorDimension: 'ROWS',
            values: [
              ['Header A', 'Header B'],
              ['1', '2'],
            ],
          },
        },
      ]);
      await withUserContext(setup.userId, async () => {
        const result = await executeGoogleDriveTalkTool({
          talkId: setup.talkId,
          userId: setup.userId,
          toolName: 'google_sheets_read_range',
          args: { bindingRef: setup.sheetRef, range: 'Sheet1!A1:B2' },
          signal,
        });
        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.result) as {
          range: string;
          values: unknown[][];
        };
        expect(parsed.range).toBe('Sheet1!A1:B2');
        expect(parsed.values[0]).toEqual(['Header A', 'Header B']);
      });
    });

    it('google_sheets_read_range rejects unknown bindingRef (C4)', async () => {
      const setup = await setupTalkWithSheetBinding();
      await withUserContext(setup.userId, async () => {
        const result = await executeGoogleDriveTalkTool({
          talkId: setup.talkId,
          userId: setup.userId,
          toolName: 'google_sheets_read_range',
          args: { bindingRef: 'G99', range: 'A1:B2' },
          signal,
        });
        expect(result.isError).toBe(true);
        expect(result.result).toContain('unbound_resource');
      });
    });

    it('google_sheets_read_range rejects when the binding is a Google Doc, not a Sheet', async () => {
      // Reuse the Drive+Docs talk fixture — its bound file is a Doc, not
      // a Sheet, so the mime-type check should reject the read.
      const setup = await setupTalkWithBindings();
      await withUserContext(setup.userId, async () => {
        const result = await executeGoogleDriveTalkTool({
          talkId: setup.talkId,
          userId: setup.userId,
          toolName: 'google_sheets_read_range',
          args: { bindingRef: setup.fileRef, range: 'A1:B2' },
          signal,
        });
        expect(result.isError).toBe(true);
        expect(result.result).toContain('is not a Google Sheet');
      });
    });

    it('google_sheets_batch_update happy path writes values', async () => {
      const setup = await setupTalkWithSheetBinding();
      mockFetchSequence([
        {
          jsonBody: {
            spreadsheetId: setup.sheetId,
            totalUpdatedRows: 2,
            totalUpdatedColumns: 2,
            totalUpdatedCells: 4,
          },
        },
      ]);
      await withUserContext(setup.userId, async () => {
        const result = await executeGoogleDriveTalkTool({
          talkId: setup.talkId,
          userId: setup.userId,
          toolName: 'google_sheets_batch_update',
          args: {
            bindingRef: setup.sheetRef,
            updates: [
              {
                range: 'Sheet1!A1:B2',
                values: [
                  ['x', 'y'],
                  ['z', 'w'],
                ],
              },
            ],
          },
          signal,
        });
        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.result) as {
          totalUpdatedCells: number;
        };
        expect(parsed.totalUpdatedCells).toBe(4);
      });
    });

    it('google_sheets_batch_update is blocked under jobPolicy.allowExternalMutation=false (C6)', async () => {
      const setup = await setupTalkWithSheetBinding();
      await withUserContext(setup.userId, async () => {
        const result = await executeGoogleDriveTalkTool({
          talkId: setup.talkId,
          userId: setup.userId,
          toolName: 'google_sheets_batch_update',
          args: {
            bindingRef: setup.sheetRef,
            updates: [{ range: 'A1:A1', values: [['x']] }],
          },
          signal,
          jobPolicy: { allowExternalMutation: false },
        });
        expect(result.isError).toBe(true);
        expect(result.result).toContain('external_mutation_blocked');
      });
    });

    it('google_sheets_batch_update rejects more than MAX_GOOGLE_SHEETS_BATCH_UPDATES updates', async () => {
      const setup = await setupTalkWithSheetBinding();
      const updates = Array.from({ length: 51 }, (_, i) => ({
        range: `Sheet1!A${i + 1}:A${i + 1}`,
        values: [['x']],
      }));
      await withUserContext(setup.userId, async () => {
        const result = await executeGoogleDriveTalkTool({
          talkId: setup.talkId,
          userId: setup.userId,
          toolName: 'google_sheets_batch_update',
          args: { bindingRef: setup.sheetRef, updates },
          signal,
        });
        expect(result.isError).toBe(true);
        expect(result.result).toContain('at most 50 updates');
      });
    });

    it('google_sheets_batch_update rejects empty updates array', async () => {
      const setup = await setupTalkWithSheetBinding();
      await withUserContext(setup.userId, async () => {
        const result = await executeGoogleDriveTalkTool({
          talkId: setup.talkId,
          userId: setup.userId,
          toolName: 'google_sheets_batch_update',
          args: { bindingRef: setup.sheetRef, updates: [] },
          signal,
        });
        expect(result.isError).toBe(true);
        expect(result.result).toContain('non-empty updates array');
      });
    });
  });
});

describe('loadGoogleDriveBindings', () => {
  const userIds: string[] = [];

  beforeAll(async () => {
    await initPgDatabase();
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await purgeUserData(userIds);
      await deleteAuthUsers(userIds);
    }
    await closePgDatabase();
  });

  it('filters non-Drive bindings out and assigns sequential G-refs', async () => {
    const userId = await seedAuthUser();
    userIds.push(userId);
    await withUserContext(userId, async () => {
      const talkId = await seedTalk({ ownerId: userId });
      await createTalkResourceBinding({
        ownerId: userId,
        talkId,
        bindingKind: 'saved_source',
        externalId: 'src-1',
        displayName: 'A saved source',
      });
      await createTalkResourceBinding({
        ownerId: userId,
        talkId,
        bindingKind: 'google_drive_folder',
        externalId: 'folder-1',
        displayName: 'F1',
      });
      await createTalkResourceBinding({
        ownerId: userId,
        talkId,
        bindingKind: 'google_drive_file',
        externalId: 'file-1',
        displayName: 'D1',
      });
      const bindings = await loadGoogleDriveBindings(talkId);
      // saved_source is excluded; both Drive bindings present with G-refs.
      // We don't assert order between the folder + file because same-
      // microsecond inserts fall back to id ASC, which isn't stable.
      expect(bindings.length).toBe(2);
      expect(bindings.map((b) => b.ref).sort()).toEqual(['G1', 'G2']);
      const kinds = bindings.map((b) => b.bindingKind).sort();
      expect(kinds).toEqual(['google_drive_file', 'google_drive_folder']);
    });
  });
});
