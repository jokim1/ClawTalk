import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  upsertTalk,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { hashSessionToken } from '../../identity/session.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, type WebServerHandle } from '../server.js';

describe('talk attachment routes', () => {
  let server: WebServerHandle;

  beforeEach(() => {
    _initTestDatabase();
    _resetRateLimitStateForTests();

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertUser({
      id: 'outsider-1',
      email: 'outsider@example.com',
      displayName: 'Outsider',
      role: 'member',
    });
    upsertTalk({
      id: 'talk-attachments',
      ownerId: 'owner-1',
      topicTitle: 'Attachment Test Talk',
    });
    upsertWebSession({
      id: 's-owner',
      userId: 'owner-1',
      accessTokenHash: hashSessionToken('owner-token'),
      refreshTokenHash: hashSessionToken('owner-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    upsertWebSession({
      id: 's-outsider',
      userId: 'outsider-1',
      accessTokenHash: hashSessionToken('outsider-token'),
      refreshTokenHash: hashSessionToken('outsider-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    server = createWebServer({ host: '127.0.0.1', port: 0 });
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function uploadTextAttachment() {
    const form = new FormData();
    form.append(
      'file',
      new File(['hello attachment'], 'notes.txt', {
        type: 'application/octet-stream',
      }),
    );

    const res = await server.request(
      '/api/v1/talks/talk-attachments/attachments',
      {
        method: 'POST',
        headers: auth('owner-token'),
        body: form,
      },
    );

    expect(res.status).toBe(201);
    return (await res.json()) as {
      ok: true;
      data: {
        attachment: {
          id: string;
          extractionStatus: 'pending' | 'ready' | 'failed';
          mimeType: string;
          extractedTextLength: number | null;
        };
      };
    };
  }

  it('returns ready after successful extraction', async () => {
    const body = await uploadTextAttachment();

    expect(body.data.attachment.mimeType).toBe('text/plain');
    expect(body.data.attachment.extractionStatus).toBe('ready');
    expect(body.data.attachment.extractedTextLength).toBeGreaterThan(0);
  });

  it('accepts PNG image uploads for vision-capable talks', async () => {
    const form = new FormData();
    form.append(
      'file',
      new File([Uint8Array.from([137, 80, 78, 71])], 'screenshot.png', {
        type: 'image/png',
      }),
    );

    const res = await server.request(
      '/api/v1/talks/talk-attachments/attachments',
      {
        method: 'POST',
        headers: auth('owner-token'),
        body: form,
      },
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: true;
      data: {
        attachment: {
          mimeType: string;
          extractionStatus: 'pending' | 'ready' | 'failed';
          extractedTextLength: number | null;
        };
      };
    };
    expect(body.data.attachment.mimeType).toBe('image/png');
    expect(body.data.attachment.extractionStatus).toBe('ready');
    expect(body.data.attachment.extractedTextLength).toBeNull();
  });

  it('enforces the 5 MB image upload limit on the backend', async () => {
    const form = new FormData();
    form.append(
      'file',
      new File(
        [new Uint8Array(5 * 1024 * 1024 + 1)],
        'oversized-screenshot.png',
        {
          type: 'image/png',
        },
      ),
    );

    const res = await server.request(
      '/api/v1/talks/talk-attachments/attachments',
      {
        method: 'POST',
        headers: auth('owner-token'),
        body: form,
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe('file_too_large');
    expect(body.error.message).toContain('5 MB');
  });

  it('serves raw attachment content with inline headers', async () => {
    const upload = await uploadTextAttachment();
    const attachmentId = upload.data.attachment.id;

    const res = await server.request(
      `/api/v1/talks/talk-attachments/attachments/${attachmentId}/content`,
      {
        headers: auth('owner-token'),
      },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('cache-control')).toBe(
      'private, max-age=31536000, immutable',
    );
    expect(res.headers.get('content-disposition')).toContain(
      'inline; filename="notes.txt"',
    );
    expect(await res.text()).toBe('hello attachment');
  });

  it('returns 404 for a missing attachment content request', async () => {
    const res = await server.request(
      '/api/v1/talks/talk-attachments/attachments/att-missing/content',
      {
        headers: auth('owner-token'),
      },
    );

    expect(res.status).toBe(404);
  });

  it('returns 404 for attachment content when the talk is inaccessible', async () => {
    const upload = await uploadTextAttachment();
    const attachmentId = upload.data.attachment.id;

    const res = await server.request(
      `/api/v1/talks/talk-attachments/attachments/${attachmentId}/content`,
      {
        headers: auth('outsider-token'),
      },
    );

    expect(res.status).toBe(404);
  });
});
