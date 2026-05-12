import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  saveIdempotencyCache,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { hashSessionToken } from '../../identity/session.js';
import { hashRequestBody } from '../../security/hash.js';
import { authenticateRequest } from './auth.js';
import { validateCsrfToken } from './csrf.js';
import { idempotencyPrecheck } from './idempotency.js';
import { _resetRateLimitStateForTests, checkRateLimit } from './rate-limit.js';

describe('web middleware', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetRateLimitStateForTests();

    upsertUser({
      id: 'u1',
      email: 'u1@example.com',
      displayName: 'User 1',
      role: 'member',
    });

    upsertWebSession({
      id: 's1',
      userId: 'u1',
      accessTokenHash: hashSessionToken('access-token'),
      refreshTokenHash: hashSessionToken('refresh-token'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  });

  it('authenticates bearer and cookie sessions', () => {
    const bearerAuth = authenticateRequest({
      authorization: 'Bearer access-token',
    });
    expect(bearerAuth?.userId).toBe('u1');
    expect(bearerAuth?.authType).toBe('bearer');

    const cookieAuth = authenticateRequest({
      cookie: 'cr_access_token=access-token; cr_csrf_token=csrf-1',
    });
    expect(cookieAuth?.userId).toBe('u1');
    expect(cookieAuth?.authType).toBe('cookie');
  });

  it('rejects sessions with expired access token even if refresh is still valid', () => {
    upsertWebSession({
      id: 's-expired',
      userId: 'u1',
      accessTokenHash: hashSessionToken('expired-token'),
      refreshTokenHash: hashSessionToken('expired-refresh'),
      accessExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const auth = authenticateRequest({
      authorization: 'Bearer expired-token',
    });
    expect(auth).toBeNull();
  });

  it('blocks csrf mismatch for cookie-authenticated mutating calls', () => {
    const bad = validateCsrfToken({
      method: 'POST',
      authType: 'cookie',
      cookieHeader: 'cr_csrf_token=abc',
      csrfHeader: 'def',
    });
    expect(bad.ok).toBe(false);

    const good = validateCsrfToken({
      method: 'POST',
      authType: 'cookie',
      cookieHeader: 'cr_csrf_token=abc',
      csrfHeader: 'abc',
    });
    expect(good.ok).toBe(true);
  });

  it('replays idempotent requests with same key and body', () => {
    saveIdempotencyCache({
      idempotency_key: 'idem-1',
      user_id: 'u1',
      method: 'POST',
      path: '/api/v1/talks/t1/chat/cancel',
      request_hash: hashRequestBody('{}'),
      status_code: 200,
      response_body: '{"ok":true}',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });

    const replay = idempotencyPrecheck({
      userId: 'u1',
      idempotencyKey: 'idem-1',
      method: 'POST',
      path: '/api/v1/talks/t1/chat/cancel',
      bodyText: '{}',
    });

    expect(replay.replay).toBe(true);
    expect(replay.response?.statusCode).toBe(200);
  });

  it('rejects idempotency key reused with different request body', () => {
    saveIdempotencyCache({
      idempotency_key: 'idem-mismatch',
      user_id: 'u1',
      method: 'POST',
      path: '/api/v1/talks/t1/chat/cancel',
      request_hash: hashRequestBody('{"a":1}'),
      status_code: 200,
      response_body: '{"ok":true}',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });

    const mismatch = idempotencyPrecheck({
      userId: 'u1',
      idempotencyKey: 'idem-mismatch',
      method: 'POST',
      path: '/api/v1/talks/t1/chat/cancel',
      bodyText: '{"a":2}',
    });

    expect(mismatch.replay).toBe(false);
    expect(mismatch.error).toContain('different request body');
  });

  it('allows mutating request precheck with no idempotency key', () => {
    const result = idempotencyPrecheck({
      userId: 'u1',
      idempotencyKey: null,
      method: 'POST',
      path: '/api/v1/talks/t1/chat/cancel',
      bodyText: '{}',
    });

    expect(result.hasKey).toBe(false);
    expect(result.replay).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('enforces per-user rate limits', () => {
    for (let i = 0; i < 20; i += 1) {
      const result = checkRateLimit({ userId: 'u1', bucket: 'chat_write' });
      expect(result.allowed).toBe(true);
    }

    const blocked = checkRateLimit({ userId: 'u1', bucket: 'chat_write' });
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it('resets rate limits after the window elapses', () => {
    const nowMs = Date.now();
    for (let i = 0; i < 20; i += 1) {
      checkRateLimit({
        userId: 'u1',
        bucket: 'chat_write',
        nowMs,
      });
    }

    const blocked = checkRateLimit({
      userId: 'u1',
      bucket: 'chat_write',
      nowMs: nowMs + 10_000,
    });
    expect(blocked.allowed).toBe(false);

    const afterReset = checkRateLimit({
      userId: 'u1',
      bucket: 'chat_write',
      nowMs: nowMs + 61_000,
    });
    expect(afterReset.allowed).toBe(true);
  });
});
