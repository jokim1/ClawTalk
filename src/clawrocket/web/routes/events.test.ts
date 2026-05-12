import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  appendOutboxEvent,
  createTalkThread,
  pruneEventOutbox,
  upsertTalk,
  upsertTalkMember,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { hashSessionToken } from '../../identity/session.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, WebServerHandle } from '../server.js';

describe('events routes', () => {
  let server: WebServerHandle;

  beforeEach(async () => {
    _initTestDatabase();
    _resetRateLimitStateForTests();

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertUser({
      id: 'member-1',
      email: 'member@example.com',
      displayName: 'Member',
      role: 'member',
    });

    upsertTalk({
      id: 'talk-1',
      ownerId: 'owner-1',
      topicTitle: 'Owner Talk',
    });

    upsertTalkMember({
      talkId: 'talk-1',
      userId: 'member-1',
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
      id: 's-member',
      userId: 'member-1',
      accessTokenHash: hashSessionToken('member-token'),
      refreshTokenHash: hashSessionToken('member-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'message_appended',
      payload: JSON.stringify({ talkId: 'talk-1', messageId: 'm1' }),
    });

    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
    });
  });

  it('returns talk-scoped stream only for authorized users', async () => {
    const ownerRes = await server.request('/api/v1/talks/talk-1/events', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(ownerRes.status).toBe(200);
    const ownerStream = await ownerRes.text();
    expect(ownerStream).toContain('event: message_appended');

    const memberRes = await server.request(
      '/api/v1/talks/unknown-talk/events',
      {
        headers: {
          Authorization: 'Bearer member-token',
        },
      },
    );
    expect(memberRes.status).toBe(404);
  });

  it('filters snapshot talk events by threadId', async () => {
    const threadA = createTalkThread({ talkId: 'talk-1', title: 'Thread A' });
    const threadB = createTalkThread({ talkId: 'talk-1', title: 'Thread B' });

    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'message_appended',
      payload: JSON.stringify({
        talkId: 'talk-1',
        threadId: threadA.id,
        messageId: 'm-thread-a',
      }),
    });
    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'message_appended',
      payload: JSON.stringify({
        talkId: 'talk-1',
        threadId: threadB.id,
        messageId: 'm-thread-b',
      }),
    });
    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'talk_run_cancelled',
      payload: JSON.stringify({
        talkId: 'talk-1',
        cancelledBy: 'owner-1',
        runIds: ['run-a'],
        threadIds: [threadA.id],
      }),
    });
    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'talk_history_edited',
      payload: JSON.stringify({
        talkId: 'talk-1',
        deletedCount: 1,
        deletedMessageIds: ['m-thread-b'],
        threadIds: [threadB.id],
        editedAt: new Date().toISOString(),
      }),
    });

    const res = await server.request(
      `/api/v1/talks/talk-1/events?threadId=${encodeURIComponent(threadA.id)}`,
      {
        headers: {
          Authorization: 'Bearer owner-token',
        },
      },
    );

    expect(res.status).toBe(200);
    const stream = await res.text();
    expect(stream).toContain('m-thread-a');
    expect(stream).not.toContain('m-thread-b');
    expect(stream).toContain('event: talk_run_cancelled');
    expect(stream).not.toContain('event: talk_history_edited');
  });

  it('filters live talk events by threadId and rejects invalid thread ids', async () => {
    const threadA = createTalkThread({ talkId: 'talk-1', title: 'Thread A' });
    const threadB = createTalkThread({ talkId: 'talk-1', title: 'Thread B' });

    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'message_appended',
      payload: JSON.stringify({
        talkId: 'talk-1',
        threadId: threadA.id,
        messageId: 'm-live-a',
      }),
    });
    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'message_appended',
      payload: JSON.stringify({
        talkId: 'talk-1',
        threadId: threadB.id,
        messageId: 'm-live-b',
      }),
    });

    const res = await server.request(
      `/api/v1/talks/talk-1/events?stream=1&threadId=${encodeURIComponent(threadA.id)}`,
      {
        headers: {
          Authorization: 'Bearer owner-token',
          'Last-Event-ID': '0',
        },
      },
    );

    expect(res.status).toBe(200);
    const streamText = await readSseUntil(res, (text) =>
      text.includes('m-live-a'),
    );
    expect(streamText).toContain('m-live-a');
    expect(streamText).not.toContain('m-live-b');

    const invalidRes = await server.request(
      '/api/v1/talks/talk-1/events?threadId=missing-thread',
      {
        headers: {
          Authorization: 'Bearer owner-token',
        },
      },
    );
    expect(invalidRes.status).toBe(400);
    const invalidBody = (await invalidRes.json()) as any;
    expect(invalidBody.error.code).toBe('thread_not_found');
  });

  it('includes browser block lifecycle events in thread-scoped talk streams', async () => {
    const threadA = createTalkThread({ talkId: 'talk-1', title: 'Thread A' });
    const threadB = createTalkThread({ talkId: 'talk-1', title: 'Thread B' });

    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'browser_blocked',
      payload: JSON.stringify({
        talkId: 'talk-1',
        threadId: threadA.id,
        runId: 'run-browser-a',
        browserBlock: {
          kind: 'auth_required',
        },
      }),
    });
    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'browser_unblocked',
      payload: JSON.stringify({
        talkId: 'talk-1',
        threadId: threadA.id,
        runId: 'run-browser-a',
        browserResume: {
          kind: 'auth_completed',
        },
      }),
    });
    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'browser_blocked',
      payload: JSON.stringify({
        talkId: 'talk-1',
        threadId: threadB.id,
        runId: 'run-browser-b',
        browserBlock: {
          kind: 'auth_required',
        },
      }),
    });

    const res = await server.request(
      `/api/v1/talks/talk-1/events?stream=1&threadId=${encodeURIComponent(threadA.id)}`,
      {
        headers: {
          Authorization: 'Bearer owner-token',
          'Last-Event-ID': '0',
        },
      },
    );

    expect(res.status).toBe(200);
    const streamText = await readSseUntil(res, (text) =>
      text.includes('event: browser_unblocked'),
    );
    expect(streamText).toContain('event: browser_blocked');
    expect(streamText).toContain('event: browser_unblocked');
    expect(streamText).toContain('run-browser-a');
    expect(streamText).not.toContain('run-browser-b');
  });

  it('supports Last-Event-ID replay semantics on user stream', async () => {
    const res = await server.request('/api/v1/events', {
      headers: {
        Authorization: 'Bearer owner-token',
        'Last-Event-ID': '0',
      },
    });

    expect(res.status).toBe(200);
    const stream = await res.text();
    expect(stream).toContain('event: message_appended');
  });

  it('keeps snapshot mode when stream=0 is provided', async () => {
    const res = await server.request('/api/v1/events?stream=0', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-clawrocket-sse-mode')).toBe('snapshot');
  });

  it('supports opt-in long-lived stream mode with incremental events', async () => {
    const res = await server.request('/api/v1/events?stream=1', {
      headers: {
        Authorization: 'Bearer owner-token',
        'Last-Event-ID': '0',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-clawrocket-sse-mode')).toBe('stream');

    const streamText = await readSseUntil(res, (text) =>
      text.includes('event: message_appended'),
    );
    expect(streamText).toContain('retry: 3000');
    expect(streamText).toContain('event: message_appended');
  });

  it('starts fresh live user streams at the current tail when Last-Event-ID is omitted', async () => {
    const res = await server.request('/api/v1/events?stream=1', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-clawrocket-sse-mode')).toBe('stream');

    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'message_appended',
      payload: JSON.stringify({ talkId: 'talk-1', messageId: 'm-live-now' }),
    });

    const streamText = await readSseUntil(res, (text) =>
      text.includes('m-live-now'),
    );
    expect(streamText).toContain('m-live-now');
    expect(streamText).not.toContain('"messageId":"m1"');
  });

  it('starts fresh live talk streams at the current tail when Last-Event-ID is omitted', async () => {
    const res = await server.request('/api/v1/talks/talk-1/events?stream=1', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-clawrocket-sse-mode')).toBe('stream');

    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'message_appended',
      payload: JSON.stringify({
        talkId: 'talk-1',
        messageId: 'm-talk-live-now',
      }),
    });

    const streamText = await readSseUntil(res, (text) =>
      text.includes('m-talk-live-now'),
    );
    expect(streamText).toContain('m-talk-live-now');
    expect(streamText).not.toContain('"messageId":"m1"');
  });

  it('emits replay_gap inline in stream mode when cursor falls behind retention', async () => {
    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'message_appended',
      payload: JSON.stringify({ talkId: 'talk-1', messageId: 'm2' }),
    });
    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'message_appended',
      payload: JSON.stringify({ talkId: 'talk-1', messageId: 'm3' }),
    });
    pruneEventOutbox({
      nowMs: Date.now() + 1000,
      retentionHours: 0,
      keepRecentPerTopic: 1,
    });

    const res = await server.request('/api/v1/talks/talk-1/events?stream=1', {
      headers: {
        Authorization: 'Bearer owner-token',
        'Last-Event-ID': '1',
      },
    });

    expect(res.status).toBe(200);
    const streamText = await readSseUntil(res, (text) =>
      text.includes('event: replay_gap'),
    );
    expect(streamText).toContain('event: replay_gap');
  });

  it('rejects malformed percent-encoding in talk id', async () => {
    const res = await server.request('/api/v1/talks/%ZZ/events', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('invalid_talk_id');
  });

  it('includes retry-after when user-scoped events stream is rate limited', async () => {
    await exhaustReadBucket(server, 'owner-token');

    const res = await server.request('/api/v1/events', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('includes retry-after when talk-scoped events stream is rate limited', async () => {
    await exhaustReadBucket(server, 'owner-token');

    const res = await server.request('/api/v1/talks/talk-1/events', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('limits concurrent live stream connections per user', async () => {
    const open: Response[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await server.request('/api/v1/events?stream=1', {
        headers: {
          Authorization: 'Bearer owner-token',
        },
      });
      expect(res.status).toBe(200);
      open.push(res);
    }

    const blocked = await server.request('/api/v1/events?stream=1', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();

    const body = (await blocked.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('too_many_stream_connections');

    for (const response of open) {
      const reader = response.body?.getReader();
      if (!reader) continue;
      await reader.cancel();
    }
  });
});

async function exhaustReadBucket(
  server: WebServerHandle,
  accessToken: string,
): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const res = await server.request('/api/v1/status', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    expect(res.status).toBe(200);
  }
}

async function readSseUntil(
  response: Response,
  predicate: (accumulatedText: string) => boolean,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Expected streaming response body');
  }

  const decoder = new TextDecoder();
  const deadline = Date.now() + 5_000;
  let text = '';
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value ? decoder.decode(value, { stream: true }) : '';
    if (predicate(text)) break;
  }

  text += decoder.decode();
  await reader.cancel();
  return text;
}
