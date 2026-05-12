import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTalkOutput,
  createTalkThread,
  patchTalkOutput,
  upsertTalk,
  upsertTalkMember,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { hashSessionToken } from '../../identity/session.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, WebServerHandle } from '../server.js';
import type { TalkContextSourceIngestionService } from '../../talks/source-ingestion.js';

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function json(res: Response) {
  return res.json() as Promise<Record<string, any>>;
}

describe('talk output routes', () => {
  let server: WebServerHandle;
  let sourceIngestion: TalkContextSourceIngestionService & {
    enqueueUrlSource: ReturnType<
      typeof vi.fn<(sourceId: string, url: string) => void>
    >;
  };

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
      id: 'viewer-1',
      email: 'viewer@example.com',
      displayName: 'Viewer',
      role: 'member',
    });
    upsertUser({
      id: 'outsider-1',
      email: 'outsider@example.com',
      displayName: 'Outsider',
      role: 'member',
    });
    upsertTalk({
      id: 'talk-1',
      ownerId: 'owner-1',
      topicTitle: 'Outputs Route Test',
    });
    createTalkThread({ talkId: 'talk-1', title: 'Default' });
    upsertTalkMember({
      talkId: 'talk-1',
      userId: 'viewer-1',
      role: 'viewer',
    });

    upsertWebSession({
      id: 's-owner',
      userId: 'owner-1',
      accessTokenHash: hashSessionToken('owner-token'),
      refreshTokenHash: hashSessionToken('owner-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    upsertWebSession({
      id: 's-viewer',
      userId: 'viewer-1',
      accessTokenHash: hashSessionToken('viewer-token'),
      refreshTokenHash: hashSessionToken('viewer-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    upsertWebSession({
      id: 's-outsider',
      userId: 'outsider-1',
      accessTokenHash: hashSessionToken('outsider-token'),
      refreshTokenHash: hashSessionToken('outsider-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    sourceIngestion = {
      enqueueUrlSource: vi.fn<(sourceId: string, url: string) => void>(),
    };
    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
      sourceIngestion,
    });
  });

  it('lists summaries without content bodies and fetches full detail separately', async () => {
    const output = createTalkOutput({
      talkId: 'talk-1',
      title: 'Weekly Brief',
      contentMarkdown: '# Hello',
      createdByUserId: 'owner-1',
    });

    const listRes = await server.request('/api/v1/talks/talk-1/outputs', {
      method: 'GET',
      headers: authHeaders('viewer-token'),
    });
    expect(listRes.status).toBe(200);
    const listBody = await json(listRes);
    const listed = listBody.data.outputs[0];
    expect(listed.title).toBe('Weekly Brief');
    expect(listed.contentLength).toBe('# Hello'.length);
    expect(listed.contentMarkdown).toBeUndefined();

    const detailRes = await server.request(
      `/api/v1/talks/talk-1/outputs/${output.id}`,
      {
        method: 'GET',
        headers: authHeaders('viewer-token'),
      },
    );
    expect(detailRes.status).toBe(200);
    const detailBody = await json(detailRes);
    expect(detailBody.data.output.contentMarkdown).toBe('# Hello');
  });

  it('blocks non-members from reading outputs and viewers from mutating them', async () => {
    const output = createTalkOutput({
      talkId: 'talk-1',
      title: 'Read Me',
      contentMarkdown: 'body',
      createdByUserId: 'owner-1',
    });

    const outsiderRes = await server.request('/api/v1/talks/talk-1/outputs', {
      method: 'GET',
      headers: authHeaders('outsider-token'),
    });
    expect(outsiderRes.status).toBe(404);

    const viewerMutateRes = await server.request(
      `/api/v1/talks/talk-1/outputs/${output.id}`,
      {
        method: 'DELETE',
        headers: authHeaders('viewer-token'),
      },
    );
    expect(viewerMutateRes.status).toBe(403);
  });

  it('creates, patches, and deletes outputs for editors', async () => {
    const createRes = await server.request('/api/v1/talks/talk-1/outputs', {
      method: 'POST',
      headers: authHeaders('owner-token'),
      body: JSON.stringify({
        title: 'Untitled Output',
        contentMarkdown: '',
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await json(createRes);
    const outputId = created.data.output.id as string;

    const patchRes = await server.request(
      `/api/v1/talks/talk-1/outputs/${outputId}`,
      {
        method: 'PATCH',
        headers: authHeaders('owner-token'),
        body: JSON.stringify({
          expectedVersion: 1,
          title: 'Updated Title',
          contentMarkdown: 'Hello world',
        }),
      },
    );
    expect(patchRes.status).toBe(200);
    const patched = await json(patchRes);
    expect(patched.data.output.title).toBe('Updated Title');
    expect(patched.data.output.version).toBe(2);

    const deleteRes = await server.request(
      `/api/v1/talks/talk-1/outputs/${outputId}`,
      {
        method: 'DELETE',
        headers: authHeaders('owner-token'),
      },
    );
    expect(deleteRes.status).toBe(200);
  });

  it('rejects empty or stale patches', async () => {
    const output = createTalkOutput({
      talkId: 'talk-1',
      title: 'Plan',
      contentMarkdown: 'v1',
      createdByUserId: 'owner-1',
    });

    const missingVersionRes = await server.request(
      `/api/v1/talks/talk-1/outputs/${output.id}`,
      {
        method: 'PATCH',
        headers: authHeaders('owner-token'),
        body: JSON.stringify({ title: 'New Title' }),
      },
    );
    expect(missingVersionRes.status).toBe(400);

    const emptyPatchRes = await server.request(
      `/api/v1/talks/talk-1/outputs/${output.id}`,
      {
        method: 'PATCH',
        headers: authHeaders('owner-token'),
        body: JSON.stringify({ expectedVersion: 1 }),
      },
    );
    expect(emptyPatchRes.status).toBe(400);

    const updated = patchTalkOutput({
      talkId: 'talk-1',
      outputId: output.id,
      expectedVersion: 1,
      contentMarkdown: 'v2',
      updatedByUserId: 'owner-1',
    });
    expect(updated.kind).toBe('ok');

    const stalePatchRes = await server.request(
      `/api/v1/talks/talk-1/outputs/${output.id}`,
      {
        method: 'PATCH',
        headers: authHeaders('owner-token'),
        body: JSON.stringify({
          expectedVersion: 1,
          contentMarkdown: 'stale',
        }),
      },
    );
    expect(stalePatchRes.status).toBe(409);
    const staleBody = await json(stalePatchRes);
    expect(staleBody.error.code).toBe('version_conflict');
    expect(staleBody.error.details.current.version).toBe(2);
  });
});
