import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// Inject test credentials for the OAuth client + picker SDK. The service
// module reads these as module-level constants at import time; mocking the
// config module before importing the service is the cleanest way to override.
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
  getDbPg,
  initPgDatabase,
  purgeUserData,
  seedAuthUser,
  withUserContext,
} from '../db/test-helpers.js';
import {
  getUserGoogleCredential,
  upsertUserGoogleCredential,
} from '../db/talk-tools-accessors.js';

import {
  decryptGoogleToolCredential,
  encryptGoogleToolCredential,
  type GoogleToolCredentialPayload,
} from './google-tools-credential-store.js';
import { normalizeGoogleScopeAliases } from './google-scopes.js';
import {
  buildGooglePickerSession,
  getValidGoogleToolAccessToken,
  refreshCredentialIfNeeded,
} from './google-tools-service.js';

const DRIVE_READONLY_URL = 'https://www.googleapis.com/auth/drive.readonly';
const DOCUMENTS_URL = 'https://www.googleapis.com/auth/documents';

async function seedGoogleCredential(input: {
  userId: string;
  accessToken?: string;
  refreshToken?: string | null;
  expiryDate?: string | null;
  scopes?: string[]; // URL form
  email?: string;
  displayName?: string | null;
}): Promise<void> {
  const scopes = input.scopes ?? [DRIVE_READONLY_URL, DOCUMENTS_URL];
  const payload: GoogleToolCredentialPayload = {
    kind: 'google_tools',
    accessToken: input.accessToken ?? 'access-old',
    refreshToken: input.refreshToken ?? 'refresh-original',
    expiryDate:
      input.expiryDate === undefined
        ? new Date(Date.now() + 3600_000).toISOString()
        : input.expiryDate,
    scopes,
    tokenType: 'Bearer',
  };
  // Allow callers to pass refreshToken: null to drop the field entirely.
  if (input.refreshToken === null) {
    delete payload.refreshToken;
  }
  await upsertUserGoogleCredential({
    userId: input.userId,
    googleSubject: `sub-${input.userId.slice(0, 8)}`,
    email: input.email ?? 'tester@example.com',
    displayName: input.displayName ?? 'Tester',
    scopes: normalizeGoogleScopeAliases(scopes),
    ciphertext: encryptGoogleToolCredential(payload),
    accessExpiresAt: payload.expiryDate ?? null,
  });
}

function mockRefreshFetch(input: {
  ok?: boolean;
  status?: number;
  body?: Record<string, unknown>;
}): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: input.ok ?? true,
    status: input.status ?? 200,
    json: async () =>
      input.body ?? {
        access_token: 'access-fresh',
        expires_in: 3600,
        scope: `${DRIVE_READONLY_URL} ${DOCUMENTS_URL}`,
        token_type: 'Bearer',
      },
  } as unknown as Response);
}

describe('google-tools-service', () => {
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

  describe('getValidGoogleToolAccessToken', () => {
    it('returns the stored token when not expired and skips the refresh fetch', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await withUserContext(userId, async () => {
        await seedGoogleCredential({ userId });
        const result = await getValidGoogleToolAccessToken({
          userId,
          requiredScopes: ['drive.readonly'],
        });
        expect(result.accessToken).toBe('access-old');
        expect(result.email).toBe('tester@example.com');
        expect(result.scopes).toEqual(
          expect.arrayContaining(['drive.readonly', 'documents']),
        );
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('throws google_account_not_connected when no credential exists', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);
      await withUserContext(userId, async () => {
        await expect(
          getValidGoogleToolAccessToken({
            userId,
            requiredScopes: ['drive.readonly'],
          }),
        ).rejects.toMatchObject({
          code: 'google_account_not_connected',
          status: 404,
        });
      });
    });

    it('throws google_scopes_missing with missingScopes listing when required scope is absent', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);
      await withUserContext(userId, async () => {
        await seedGoogleCredential({
          userId,
          scopes: [DRIVE_READONLY_URL], // documents intentionally absent
        });
        await expect(
          getValidGoogleToolAccessToken({
            userId,
            requiredScopes: ['drive.readonly', 'documents'],
          }),
        ).rejects.toMatchObject({
          code: 'google_scopes_missing',
          missingScopes: ['documents'],
        });
      });
    });

    it('deletes the credential and throws google_reauth_required when ciphertext fails to decrypt', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);
      await withUserContext(userId, async () => {
        // Insert a deliberately-malformed ciphertext to simulate either a
        // rotated encryption key or a corrupted row.
        const db = getDbPg();
        await db`
          insert into public.user_google_credentials
            (user_id, google_subject, email, display_name, scopes_json,
             ciphertext, access_expires_at)
          values
            (${userId}::uuid, 'sub', 'tester@example.com', 'T',
             ${db.json(['drive.readonly'] as never)}, 'not-json', null)
        `;
        await expect(
          getValidGoogleToolAccessToken({
            userId,
            requiredScopes: ['drive.readonly'],
          }),
        ).rejects.toMatchObject({ code: 'google_reauth_required' });
        const after = await getUserGoogleCredential();
        expect(after).toBeUndefined();
      });
    });
  });

  describe('refresh state machine', () => {
    it('refreshes an expired credential, persists the new token, and rolls the expiry forward', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);
      mockRefreshFetch({
        body: {
          access_token: 'access-fresh',
          expires_in: 3600,
          scope: `${DRIVE_READONLY_URL} ${DOCUMENTS_URL}`,
          token_type: 'Bearer',
        },
      });
      await withUserContext(userId, async () => {
        await seedGoogleCredential({
          userId,
          expiryDate: new Date(Date.now() - 60_000).toISOString(),
        });
        const result = await getValidGoogleToolAccessToken({
          userId,
          requiredScopes: ['drive.readonly'],
        });
        expect(result.accessToken).toBe('access-fresh');
        const stored = await getUserGoogleCredential();
        expect(stored).toBeDefined();
        const decoded = decryptGoogleToolCredential(stored!.ciphertext);
        expect(decoded.accessToken).toBe('access-fresh');
        expect(stored!.accessExpiresAt).toBeTruthy();
        expect(
          new Date(stored!.accessExpiresAt as string).getTime(),
        ).toBeGreaterThan(Date.now());
      });
    });

    it('deletes the credential and throws google_reauth_required when refresh returns 400 invalid_grant', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);
      mockRefreshFetch({
        ok: false,
        status: 400,
        body: { error: 'invalid_grant' },
      });
      await withUserContext(userId, async () => {
        await seedGoogleCredential({
          userId,
          expiryDate: new Date(Date.now() - 60_000).toISOString(),
        });
        await expect(
          getValidGoogleToolAccessToken({
            userId,
            requiredScopes: ['drive.readonly'],
          }),
        ).rejects.toMatchObject({
          code: 'google_reauth_required',
          status: 401,
        });
        const after = await getUserGoogleCredential();
        expect(after).toBeUndefined();
      });
    });

    it('throws google_reauth_required without calling Google when refresh_token is absent', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await withUserContext(userId, async () => {
        await seedGoogleCredential({
          userId,
          refreshToken: null,
          expiryDate: new Date(Date.now() - 60_000).toISOString(),
        });
        await expect(
          getValidGoogleToolAccessToken({
            userId,
            requiredScopes: ['drive.readonly'],
          }),
        ).rejects.toMatchObject({ code: 'google_reauth_required' });
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('preserves the prior refresh_token when Google omits one in the refresh response', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);
      mockRefreshFetch({
        body: {
          access_token: 'access-fresh-2',
          expires_in: 3600,
          token_type: 'Bearer',
          // refresh_token intentionally omitted — typical for refresh
        },
      });
      await withUserContext(userId, async () => {
        await seedGoogleCredential({
          userId,
          refreshToken: 'refresh-original',
          expiryDate: new Date(Date.now() - 60_000).toISOString(),
        });
        await getValidGoogleToolAccessToken({
          userId,
          requiredScopes: ['drive.readonly'],
        });
        const stored = await getUserGoogleCredential();
        const decoded = decryptGoogleToolCredential(stored!.ciphertext);
        expect(decoded.refreshToken).toBe('refresh-original');
        expect(decoded.accessToken).toBe('access-fresh-2');
      });
    });

    it('preserves prior scopes when Google omits the scope field in the refresh response (PR1 C8 regression guard)', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);
      mockRefreshFetch({
        body: {
          access_token: 'access-fresh-3',
          expires_in: 3600,
          token_type: 'Bearer',
          // scope intentionally omitted
        },
      });
      await withUserContext(userId, async () => {
        const priorScopes = [DRIVE_READONLY_URL, DOCUMENTS_URL];
        await seedGoogleCredential({
          userId,
          scopes: priorScopes,
          expiryDate: new Date(Date.now() - 60_000).toISOString(),
        });
        const result = await getValidGoogleToolAccessToken({
          userId,
          // Both scopes are still required post-refresh; if the refresh path
          // ever narrows the persisted set this assertion fails.
          requiredScopes: ['drive.readonly', 'documents'],
        });
        expect(result.accessToken).toBe('access-fresh-3');
        const stored = await getUserGoogleCredential();
        const decoded = decryptGoogleToolCredential(stored!.ciphertext);
        expect([...decoded.scopes].sort()).toEqual([...priorScopes].sort());
      });
    });
  });

  describe('in-flight refresh dedup (D1)', () => {
    it('shares a single refresh fetch across concurrent callers in the same isolate', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);
      let resolveRefresh:
        | ((value: Response | PromiseLike<Response>) => void)
        | undefined;
      const deferredRefresh = new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      });
      // Use mockImplementationOnce for the first call so the dedup test
      // exercises a controlled deferred Promise, then a fallback
      // mockImplementation that throws — so a future refactor that breaks
      // dedup fails the test loudly instead of silently hitting the real
      // oauth2.googleapis.com endpoint.
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementationOnce(() => deferredRefresh)
        .mockImplementation(() => {
          throw new Error(
            'dedup broken: refreshCredentialIfNeeded called fetch more than once',
          );
        });
      await withUserContext(userId, async () => {
        await seedGoogleCredential({
          userId,
          expiryDate: new Date(Date.now() - 60_000).toISOString(),
        });
        const stored = await getUserGoogleCredential();
        const expired = decryptGoogleToolCredential(stored!.ciphertext);

        // Both callers see the expired payload and reach refreshCredentialIfNeeded.
        // The second call should hit the in-flight map and reuse the promise
        // started by the first call instead of issuing a second fetch.
        const callA = refreshCredentialIfNeeded(userId, expired);
        const callB = refreshCredentialIfNeeded(userId, expired);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        resolveRefresh!({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'shared-access',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        } as unknown as Response);

        const [a, b] = await Promise.all([callA, callB]);
        expect(a.accessToken).toBe('shared-access');
        expect(b.accessToken).toBe('shared-access');
      });
      // After both callers resolved the in-flight entry should be drained so
      // the next refresh starts fresh.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('buildGooglePickerSession', () => {
    it('returns oauthToken, developerKey, and appId when a drive.readonly-scoped credential exists', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);
      await withUserContext(userId, async () => {
        await seedGoogleCredential({ userId });
        const session = await buildGooglePickerSession(userId);
        expect(session).toEqual({
          oauthToken: 'access-old',
          developerKey: 'test-picker-key',
          appId: 'test-picker-app',
        });
      });
    });

    it('throws google_scopes_missing when drive.readonly is not granted', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);
      await withUserContext(userId, async () => {
        await seedGoogleCredential({
          userId,
          scopes: [DOCUMENTS_URL], // no drive.readonly
        });
        await expect(buildGooglePickerSession(userId)).rejects.toMatchObject({
          code: 'google_scopes_missing',
          missingScopes: ['drive.readonly'],
        });
      });
    });
  });
});
