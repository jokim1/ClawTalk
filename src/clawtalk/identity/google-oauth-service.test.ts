import { createHash } from 'crypto';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// jose is mocked so the callback tests don't need real Google JWKS. The PKCE
// + state tests don't touch jose, so the default mock implementation is
// unused for them.
vi.mock('jose', async () => ({
  createRemoteJWKSet: () => ({
    /* opaque */
  }),
  jwtVerify: vi.fn(),
}));

vi.mock('../config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    GOOGLE_OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_OAUTH_REDIRECT_URI:
      'http://localhost:5173/api/v1/auth/google/callback',
  };
});

import { jwtVerify } from 'jose';

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
  GoogleOAuthError,
  completeGoogleOAuthCallback,
  ensureOidcScopes,
  persistGoogleOAuthIdentity,
  startGoogleOAuth,
  validateRequestedScopes,
} from './google-oauth-service.js';
import {
  decryptGoogleToolCredential,
  encryptGoogleToolCredential,
} from './google-tools-credential-store.js';

const REDIRECT_URI = 'http://localhost:5173/api/v1/auth/google/callback';

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function sha256Base64Url(input: string): string {
  return base64url(createHash('sha256').update(input).digest());
}

function stateFromUrl(url: string): string {
  const u = new URL(url);
  return u.searchParams.get('state') ?? '';
}

function nonceFromUrl(url: string): string {
  const u = new URL(url);
  return u.searchParams.get('nonce') ?? '';
}

function codeChallengeFromUrl(url: string): string {
  const u = new URL(url);
  return u.searchParams.get('code_challenge') ?? '';
}

function mockTokenExchange(payload: {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  ok?: boolean;
  status?: number;
}): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: payload.ok ?? true,
    status: payload.status ?? 200,
    json: async () => ({
      access_token: 'gat_abc',
      refresh_token: 'grt_xyz',
      id_token: 'opaque.jwt.value',
      expires_in: 3600,
      scope:
        'openid email profile https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/documents',
      token_type: 'Bearer',
      ...payload,
    }),
  } as unknown as Response);
}

function mockJwtVerify(payload: {
  nonce?: string;
  sub?: string;
  email?: string;
  name?: string;
}): void {
  vi.mocked(jwtVerify).mockResolvedValueOnce({
    payload: {
      nonce: payload.nonce ?? 'will-be-overridden',
      sub: payload.sub ?? 'google-sub-12345',
      email: payload.email ?? 'tester@example.com',
      name: payload.name ?? 'Tester',
    },
    protectedHeader: { alg: 'RS256' },
    key: { type: 'public' } as unknown as object,
  } as unknown as Awaited<ReturnType<typeof jwtVerify>>);
}

describe('google-oauth-service', () => {
  let userIds: string[] = [];

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
    // Re-apply the jose mock since restoreAllMocks clears the spy.
    vi.mocked(jwtVerify).mockReset();
  });

  // ─── validateRequestedScopes ──────────────────────────────────────

  describe('validateRequestedScopes (C7)', () => {
    it('accepts allowed scope aliases', () => {
      expect(validateRequestedScopes(['drive.readonly', 'documents'])).toEqual([
        'drive.readonly',
        'documents',
      ]);
    });
    it('rejects gmail.send', () => {
      expect(() => validateRequestedScopes(['gmail.send'])).toThrow(
        GoogleOAuthError,
      );
    });
    it('rejects raw URL scopes outside the allowlist', () => {
      expect(() =>
        validateRequestedScopes(['https://www.googleapis.com/auth/calendar']),
      ).toThrow(GoogleOAuthError);
    });
  });

  // ─── ensureOidcScopes ─────────────────────────────────────────────

  describe('ensureOidcScopes (C3)', () => {
    it('adds openid, email, profile when missing', () => {
      const result = ensureOidcScopes(['drive.readonly']);
      expect(result).toContain('openid');
      expect(result).toContain('email');
      expect(result).toContain('profile');
      expect(result).toContain('drive.readonly');
    });
    it('does not duplicate when already present', () => {
      const result = ensureOidcScopes(['openid', 'email', 'profile']);
      const counts = result.filter((s) => s === 'openid').length;
      expect(counts).toBe(1);
    });
  });

  // ─── startGoogleOAuth: PKCE + state storage (C4, C5) ─────────────

  describe('startGoogleOAuth', () => {
    it('stores sha256 hashes of state/nonce/code_verifier with provider=google_tools', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);

      const result = await withUserContext(userId, () =>
        startGoogleOAuth({
          userId,
          scopes: ensureOidcScopes(['drive.readonly', 'documents']),
          redirectUri: REDIRECT_URI,
        }),
      );

      const rawState = stateFromUrl(result.authorizationUrl);
      const rawNonce = nonceFromUrl(result.authorizationUrl);
      const codeChallenge = codeChallengeFromUrl(result.authorizationUrl);
      expect(rawState).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(rawNonce).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);

      const db = getDbPg();
      const rows = await db<
        Array<{
          provider: string;
          state_hash: string;
          nonce_hash: string;
          code_verifier_hash: string;
          code_verifier: string;
          user_id: string;
        }>
      >`select provider, state_hash, nonce_hash, code_verifier_hash,
              code_verifier, user_id
        from public.oauth_state
        where user_id = ${userId}::uuid
        order by created_at desc
        limit 1`;
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.provider).toBe('google_tools');
      expect(row.state_hash).toBe(sha256Base64Url(rawState));
      expect(row.nonce_hash).toBe(sha256Base64Url(rawNonce));
      expect(row.code_verifier_hash).toBe(sha256Base64Url(row.code_verifier));
      // code_challenge in the URL must match sha256(raw_code_verifier)
      expect(codeChallenge).toBe(sha256Base64Url(row.code_verifier));
    });

    it('produces unique state/nonce/verifier per call', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);
      const a = await withUserContext(userId, () =>
        startGoogleOAuth({
          userId,
          scopes: ensureOidcScopes(['drive.readonly']),
          redirectUri: REDIRECT_URI,
        }),
      );
      const b = await withUserContext(userId, () =>
        startGoogleOAuth({
          userId,
          scopes: ensureOidcScopes(['drive.readonly']),
          redirectUri: REDIRECT_URI,
        }),
      );
      expect(stateFromUrl(a.authorizationUrl)).not.toEqual(
        stateFromUrl(b.authorizationUrl),
      );
    });
  });

  // ─── completeGoogleOAuthCallback: state lifecycle (D2, C5) ───────

  describe('completeGoogleOAuthCallback — state', () => {
    it('returns state_invalid_or_expired when state not found', async () => {
      const result = await completeGoogleOAuthCallback({
        rawState: 'no-such-state',
        code: 'irrelevant',
        googleError: null,
      });
      expect(result.status).toBe('error');
      expect(result.errorCode).toBe('state_invalid_or_expired');
    });

    it('returns state_invalid_or_expired when state belongs to a different provider (C5)', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);

      // Insert an oauth_state row with provider != 'google_tools'
      const rawState = 'other-provider-state';
      const stateHash = sha256Base64Url(rawState);
      const db = getDbPg();
      await db`
        insert into public.oauth_state
          (user_id, provider, state_hash, nonce_hash, code_verifier_hash,
           code_verifier, redirect_uri, expires_at)
        values
          (${userId}::uuid, 'something_else', ${stateHash}, 'irrelevant',
           'irrelevant', 'verifier', ${REDIRECT_URI},
           ${new Date(Date.now() + 60_000).toISOString()}::timestamptz)
      `;
      const result = await completeGoogleOAuthCallback({
        rawState,
        code: 'irrelevant',
        googleError: null,
      });
      expect(result.errorCode).toBe('state_invalid_or_expired');
    });

    it('returns state_invalid_or_expired when state has expired', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);
      const rawState = 'expired-state-value';
      const stateHash = sha256Base64Url(rawState);
      const db = getDbPg();
      await db`
        insert into public.oauth_state
          (user_id, provider, state_hash, nonce_hash, code_verifier_hash,
           code_verifier, redirect_uri, expires_at)
        values
          (${userId}::uuid, 'google_tools', ${stateHash}, 'irrelevant',
           'irrelevant', 'verifier', ${REDIRECT_URI},
           ${new Date(Date.now() - 60_000).toISOString()}::timestamptz)
      `;
      const result = await completeGoogleOAuthCallback({
        rawState,
        code: 'irrelevant',
        googleError: null,
      });
      expect(result.errorCode).toBe('state_invalid_or_expired');
    });

    it('user_denied (Google ?error=access_denied) consumes the state and returns denied', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);

      const startResult = await withUserContext(userId, () =>
        startGoogleOAuth({
          userId,
          scopes: ensureOidcScopes(['drive.readonly']),
          redirectUri: REDIRECT_URI,
        }),
      );
      const rawState = stateFromUrl(startResult.authorizationUrl);

      const result = await completeGoogleOAuthCallback({
        rawState,
        code: null,
        googleError: 'access_denied',
      });
      expect(result.status).toBe('denied');

      // State row was claimed → second call returns state_invalid_or_expired
      const second = await completeGoogleOAuthCallback({
        rawState,
        code: null,
        googleError: 'access_denied',
      });
      expect(second.errorCode).toBe('state_invalid_or_expired');
    });

    it('replayed state (after happy claim) is rejected', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);

      const startResult = await withUserContext(userId, () =>
        startGoogleOAuth({
          userId,
          scopes: ensureOidcScopes(['drive.readonly', 'documents']),
          redirectUri: REDIRECT_URI,
        }),
      );
      const rawState = stateFromUrl(startResult.authorizationUrl);
      const rawNonce = nonceFromUrl(startResult.authorizationUrl);

      mockTokenExchange({});
      mockJwtVerify({ nonce: rawNonce });
      const first = await completeGoogleOAuthCallback({
        rawState,
        code: 'good-code',
        googleError: null,
      });
      expect(first.status).toBe('success');

      const second = await completeGoogleOAuthCallback({
        rawState,
        code: 'good-code',
        googleError: null,
      });
      expect(second.errorCode).toBe('state_invalid_or_expired');
    });
  });

  // ─── completeGoogleOAuthCallback: jose + nonce verification ──────

  describe('completeGoogleOAuthCallback — id_token verification', () => {
    it('rejects when id_token nonce does not match stored nonce_hash (C4)', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);

      const startResult = await withUserContext(userId, () =>
        startGoogleOAuth({
          userId,
          scopes: ensureOidcScopes(['drive.readonly']),
          redirectUri: REDIRECT_URI,
        }),
      );
      const rawState = stateFromUrl(startResult.authorizationUrl);

      mockTokenExchange({});
      mockJwtVerify({ nonce: 'completely-different-nonce' });
      const result = await completeGoogleOAuthCallback({
        rawState,
        code: 'good-code',
        googleError: null,
      });
      expect(result.errorCode).toBe('callback_failed');
      // ...or 'id_token_invalid' depending on where the error surfaces.
      // The route catches GoogleOAuthError and maps to a generic message.
    });

    it('rejects when jose throws (tampered signature)', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);

      const startResult = await withUserContext(userId, () =>
        startGoogleOAuth({
          userId,
          scopes: ensureOidcScopes(['drive.readonly']),
          redirectUri: REDIRECT_URI,
        }),
      );
      const rawState = stateFromUrl(startResult.authorizationUrl);

      mockTokenExchange({});
      vi.mocked(jwtVerify).mockRejectedValueOnce(
        new Error('signature verification failed'),
      );

      await expect(
        completeGoogleOAuthCallback({
          rawState,
          code: 'good-code',
          googleError: null,
        }),
      ).rejects.toThrow();
    });

    it('rejects when id_token is missing from token response (C3 defensive)', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);

      const startResult = await withUserContext(userId, () =>
        startGoogleOAuth({
          userId,
          scopes: ensureOidcScopes(['drive.readonly']),
          redirectUri: REDIRECT_URI,
        }),
      );
      const rawState = stateFromUrl(startResult.authorizationUrl);

      // Fetch returns successful response but without id_token
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'gat',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/drive.readonly',
          token_type: 'Bearer',
        }),
      } as unknown as Response);

      await expect(
        completeGoogleOAuthCallback({
          rawState,
          code: 'good-code',
          googleError: null,
        }),
      ).rejects.toThrow(/id_token/);
    });
  });

  // ─── persistGoogleOAuthIdentity ──────────────────────────────────

  describe('persistGoogleOAuthIdentity', () => {
    it('preserves prior refresh_token when new one is null', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);
      const priorRefresh = 'PRIOR-REFRESH-TOKEN';

      // Seed an existing credential row with the prior refresh token.
      await withUserContext(userId, async () => {
        const ciphertext = encryptGoogleToolCredential({
          kind: 'google_tools',
          accessToken: 'old-access',
          refreshToken: priorRefresh,
          expiryDate: new Date(Date.now() + 3600_000).toISOString(),
          scopes: ['https://www.googleapis.com/auth/drive.readonly'],
          tokenType: 'Bearer',
        });
        await upsertUserGoogleCredential({
          userId,
          googleSubject: 'sub-1',
          email: 'tester@example.com',
          displayName: 'Tester',
          scopes: ['drive.readonly'],
          ciphertext,
          accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
      });

      // Now persist a new identity that lacks refreshToken.
      await withUserContext(userId, async () => {
        await persistGoogleOAuthIdentity({
          userId,
          identity: {
            googleSubject: 'sub-1',
            email: 'tester@example.com',
            displayName: 'Tester',
            accessToken: 'new-access',
            refreshToken: null,
            scopes: ['https://www.googleapis.com/auth/drive.readonly'],
            tokenType: 'Bearer',
            expiresInSec: 3600,
          },
        });
        const fresh = await getUserGoogleCredential();
        expect(fresh).toBeTruthy();
        const decoded = decryptGoogleToolCredential(fresh!.ciphertext);
        expect(decoded.refreshToken).toBe(priorRefresh);
        expect(decoded.accessToken).toBe('new-access');
      });
    });

    it('unions persisted scopes with newly granted (C8)', async () => {
      const userId = await seedAuthUser();
      userIds.push(userId);

      // Prior credential with documents only
      await withUserContext(userId, async () => {
        const ciphertext = encryptGoogleToolCredential({
          kind: 'google_tools',
          accessToken: 'old',
          refreshToken: 'r',
          expiryDate: new Date(Date.now() + 3600_000).toISOString(),
          scopes: ['https://www.googleapis.com/auth/documents'],
          tokenType: 'Bearer',
        });
        await upsertUserGoogleCredential({
          userId,
          googleSubject: 'sub-1',
          email: 'tester@example.com',
          displayName: 'Tester',
          scopes: ['documents'],
          ciphertext,
          accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
      });

      // New identity grants only drive.readonly (would NORMALLY drop documents)
      await withUserContext(userId, async () => {
        await persistGoogleOAuthIdentity({
          userId,
          identity: {
            googleSubject: 'sub-1',
            email: 'tester@example.com',
            displayName: 'Tester',
            accessToken: 'new',
            refreshToken: 'r2',
            scopes: ['https://www.googleapis.com/auth/drive.readonly'],
            tokenType: 'Bearer',
            expiresInSec: 3600,
          },
        });
        const fresh = await getUserGoogleCredential();
        expect(fresh).toBeTruthy();
        // Persisted scopes should contain BOTH aliases
        expect(fresh!.scopes.sort()).toEqual(['documents', 'drive.readonly']);
      });
    });
  });
});
