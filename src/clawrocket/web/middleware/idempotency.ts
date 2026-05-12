import { getIdempotencyCache, saveIdempotencyCache } from '../../db/index.js';
import { hashRequestBody } from '../../security/hash.js';

export interface IdempotencyPrecheck {
  hasKey: boolean;
  replay: boolean;
  response?: {
    statusCode: number;
    responseBody: string;
  };
  requestHash: string;
  error?: string;
}

export function idempotencyPrecheck(input: {
  userId: string;
  idempotencyKey: string | null;
  method: string;
  path: string;
  bodyText: string;
}): IdempotencyPrecheck {
  const requestHash = hashRequestBody(input.bodyText || '');
  if (!input.idempotencyKey) {
    return {
      hasKey: false,
      replay: false,
      requestHash,
    };
  }

  const existing = getIdempotencyCache({
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    method: input.method,
    path: input.path,
  });

  if (!existing) {
    return { hasKey: true, replay: false, requestHash };
  }

  if (existing.request_hash !== requestHash) {
    return {
      hasKey: true,
      replay: false,
      requestHash,
      error: 'Idempotency-Key reused with different request body',
    };
  }

  return {
    hasKey: true,
    replay: true,
    requestHash,
    response: {
      statusCode: existing.status_code,
      responseBody: existing.response_body,
    },
  };
}

export function saveIdempotencyResult(input: {
  userId: string;
  idempotencyKey: string | null;
  method: string;
  path: string;
  requestHash: string;
  statusCode: number;
  responseBody: string;
}): void {
  if (!input.idempotencyKey) {
    return;
  }

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
  saveIdempotencyCache({
    user_id: input.userId,
    idempotency_key: input.idempotencyKey,
    method: input.method,
    path: input.path,
    request_hash: input.requestHash,
    status_code: input.statusCode,
    response_body: input.responseBody,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  });
}
