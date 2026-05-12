import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  type ContextSourceSnapshot,
  createTalkContextSource,
  upsertTalkStateEntry,
  updateSourceExtraction,
  upsertTalk,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { hashSessionToken } from '../../identity/session.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, WebServerHandle } from '../server.js';
import type { TalkContextSourceIngestionService } from '../../talks/source-ingestion.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

const ownerAuth = () => authHeaders('owner-token');

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('talk context routes', () => {
  let server: WebServerHandle;
  let sourceIngestion: TalkContextSourceIngestionService & {
    enqueueUrlSource: ReturnType<
      typeof vi.fn<(sourceId: string, url: string) => void>
    >;
  };
  const TALK_ID = 'talk-ctx';

  beforeEach(() => {
    _initTestDatabase();
    _resetRateLimitStateForTests();

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertTalk({
      id: TALK_ID,
      ownerId: 'owner-1',
      topicTitle: 'Context Test Talk',
    });
    upsertWebSession({
      id: 's-owner',
      userId: 'owner-1',
      accessTokenHash: hashSessionToken('owner-token'),
      refreshTokenHash: hashSessionToken('owner-refresh'),
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

  // =========================================================================
  // GET /talks/:talkId/context — full snapshot
  // =========================================================================

  describe('GET /context', () => {
    it('returns empty context for a new talk', async () => {
      const res = await server.request(`/api/v1/talks/${TALK_ID}/context`, {
        method: 'GET',
        headers: ownerAuth(),
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.ok).toBe(true);
      const data = body.data as Record<string, unknown>;
      expect(data.goal).toBeNull();
      expect(data.rules).toEqual([]);
      expect(data.sources).toEqual([]);
    });

    it('returns 404 for non-existent talk', async () => {
      const res = await server.request(`/api/v1/talks/no-such-talk/context`, {
        method: 'GET',
        headers: ownerAuth(),
      });
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // PUT /talks/:talkId/context/goal
  // =========================================================================

  describe('PUT /context/goal', () => {
    it('sets and retrieves the goal', async () => {
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/goal`,
        {
          method: 'PUT',
          headers: ownerAuth(),
          body: JSON.stringify({ goalText: '  Summarize earnings calls  ' }),
        },
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.ok).toBe(true);
      const goal = (body.data as Record<string, unknown>).goal as Record<
        string,
        unknown
      >;
      expect(goal.goalText).toBe('Summarize earnings calls');
    });

    it('rejects goal over 160 characters', async () => {
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/goal`,
        {
          method: 'PUT',
          headers: ownerAuth(),
          body: JSON.stringify({ goalText: 'x'.repeat(161) }),
        },
      );
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.ok).toBe(false);
      expect((body.error as Record<string, string>).code).toBe('goal_too_long');
    });

    it('strips newlines from goal text', async () => {
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/goal`,
        {
          method: 'PUT',
          headers: ownerAuth(),
          body: JSON.stringify({ goalText: 'line1\nline2\r\nline3' }),
        },
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      const goal = (body.data as Record<string, unknown>).goal as Record<
        string,
        unknown
      >;
      expect(goal.goalText).toBe('line1line2line3');
    });

    it('clears goal when text is empty', async () => {
      // Set goal first
      await server.request(`/api/v1/talks/${TALK_ID}/context/goal`, {
        method: 'PUT',
        headers: ownerAuth(),
        body: JSON.stringify({ goalText: 'A goal' }),
      });

      // Clear it
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/goal`,
        {
          method: 'PUT',
          headers: ownerAuth(),
          body: JSON.stringify({ goalText: '   ' }),
        },
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect((body.data as Record<string, unknown>).goal).toBeNull();
    });
  });

  // =========================================================================
  // Rules CRUD
  // =========================================================================

  describe('rules', () => {
    it('creates, lists, and deletes rules', async () => {
      // Create
      const createRes = await server.request(
        `/api/v1/talks/${TALK_ID}/context/rules`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({ ruleText: 'Always cite sources' }),
        },
      );
      expect(createRes.status).toBe(201);
      const created = await json(createRes);
      const rule = (created.data as Record<string, unknown>).rule as Record<
        string,
        unknown
      >;
      expect(rule.ruleText).toBe('Always cite sources');
      expect(rule.isActive).toBe(true);
      const ruleId = rule.id as string;

      // List
      const listRes = await server.request(
        `/api/v1/talks/${TALK_ID}/context/rules`,
        { method: 'GET', headers: ownerAuth() },
      );
      expect(listRes.status).toBe(200);
      const listed = await json(listRes);
      const rules = (listed.data as Record<string, unknown>).rules as unknown[];
      expect(rules).toHaveLength(1);

      // Delete
      const delRes = await server.request(
        `/api/v1/talks/${TALK_ID}/context/rules/${ruleId}`,
        { method: 'DELETE', headers: ownerAuth() },
      );
      expect(delRes.status).toBe(200);

      // Verify deleted
      const listRes2 = await server.request(
        `/api/v1/talks/${TALK_ID}/context/rules`,
        { method: 'GET', headers: ownerAuth() },
      );
      const listed2 = await json(listRes2);
      expect((listed2.data as Record<string, unknown>).rules).toEqual([]);
    });

    it('rejects rule over 240 characters', async () => {
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/rules`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({ ruleText: 'r'.repeat(241) }),
        },
      );
      expect(res.status).toBe(400);
      const body = await json(res);
      expect((body.error as Record<string, string>).code).toBe('rule_too_long');
    });

    it('rejects empty rule text', async () => {
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/rules`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({ ruleText: '   ' }),
        },
      );
      expect(res.status).toBe(400);
      expect((await json(res)).ok).toBe(false);
    });

    it('enforces 8 active rule limit', async () => {
      // Create 8 rules
      for (let i = 0; i < 8; i++) {
        const res = await server.request(
          `/api/v1/talks/${TALK_ID}/context/rules`,
          {
            method: 'POST',
            headers: ownerAuth(),
            body: JSON.stringify({ ruleText: `Rule ${i + 1}` }),
          },
        );
        expect(res.status).toBe(201);
      }

      // 9th should fail
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/rules`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({ ruleText: 'Rule 9' }),
        },
      );
      expect(res.status).toBe(400);
      const body = await json(res);
      expect((body.error as Record<string, string>).code).toBe(
        'active_rule_limit',
      );
    });

    it('patches rule text, active state, and sortOrder', async () => {
      // Create rule
      const createRes = await server.request(
        `/api/v1/talks/${TALK_ID}/context/rules`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({ ruleText: 'Original text' }),
        },
      );
      const rule = ((await json(createRes)).data as Record<string, unknown>)
        .rule as Record<string, unknown>;
      const ruleId = rule.id as string;

      // Patch text
      const patchRes = await server.request(
        `/api/v1/talks/${TALK_ID}/context/rules/${ruleId}`,
        {
          method: 'PATCH',
          headers: ownerAuth(),
          body: JSON.stringify({ ruleText: 'Updated text' }),
        },
      );
      expect(patchRes.status).toBe(200);
      const patched = ((await json(patchRes)).data as Record<string, unknown>)
        .rule as Record<string, unknown>;
      expect(patched.ruleText).toBe('Updated text');

      // Pause rule
      const pauseRes = await server.request(
        `/api/v1/talks/${TALK_ID}/context/rules/${ruleId}`,
        {
          method: 'PATCH',
          headers: ownerAuth(),
          body: JSON.stringify({ isActive: false }),
        },
      );
      expect(pauseRes.status).toBe(200);
      const paused = ((await json(pauseRes)).data as Record<string, unknown>)
        .rule as Record<string, unknown>;
      expect(paused.isActive).toBe(false);
    });

    it('allows creating a 9th rule if one is paused', async () => {
      const ruleIds: string[] = [];
      for (let i = 0; i < 8; i++) {
        const res = await server.request(
          `/api/v1/talks/${TALK_ID}/context/rules`,
          {
            method: 'POST',
            headers: ownerAuth(),
            body: JSON.stringify({ ruleText: `Rule ${i + 1}` }),
          },
        );
        const created = ((await json(res)).data as Record<string, unknown>)
          .rule as Record<string, unknown>;
        ruleIds.push(created.id as string);
      }

      // Pause one
      await server.request(
        `/api/v1/talks/${TALK_ID}/context/rules/${ruleIds[0]}`,
        {
          method: 'PATCH',
          headers: ownerAuth(),
          body: JSON.stringify({ isActive: false }),
        },
      );

      // Now 9th should succeed
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/rules`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({ ruleText: 'Rule 9' }),
        },
      );
      expect(res.status).toBe(201);
    });
  });

  // =========================================================================
  // GET /state
  // =========================================================================

  describe('state', () => {
    it('returns an empty state list for a new talk', async () => {
      const res = await server.request(`/api/v1/talks/${TALK_ID}/state`, {
        method: 'GET',
        headers: ownerAuth(),
      });

      expect(res.status).toBe(200);
      const body = await json(res);
      expect((body.data as Record<string, unknown>).entries).toEqual([]);
    });

    it('returns entries in newest-first order', async () => {
      const older = upsertTalkStateEntry({
        talkId: TALK_ID,
        key: 'older',
        value: { score: 1 },
        expectedVersion: 0,
        updatedByUserId: 'owner-1',
      });
      if (!older.ok) {
        throw new Error('Expected older state entry to be created');
      }

      await new Promise((resolve) => setTimeout(resolve, 2));

      const newer = upsertTalkStateEntry({
        talkId: TALK_ID,
        key: 'newer',
        value: { score: 2 },
        expectedVersion: 0,
        updatedByUserId: 'owner-1',
      });
      if (!newer.ok) {
        throw new Error('Expected newer state entry to be created');
      }

      const res = await server.request(`/api/v1/talks/${TALK_ID}/state`, {
        method: 'GET',
        headers: ownerAuth(),
      });

      expect(res.status).toBe(200);
      const body = await json(res);
      const entries = (body.data as Record<string, unknown>).entries as Array<
        Record<string, unknown>
      >;
      expect(entries).toHaveLength(2);
      expect(entries[0]?.key).toBe('newer');
      expect(entries[1]?.key).toBe('older');
    });

    it('DELETE /state/:key removes an existing entry', async () => {
      upsertTalkStateEntry({
        talkId: TALK_ID,
        key: 'delete_me',
        value: 'temporary',
        expectedVersion: 0,
        updatedByUserId: 'owner-1',
      });

      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/state/${encodeURIComponent('delete_me')}`,
        { method: 'DELETE', headers: ownerAuth() },
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.ok).toBe(true);
      expect((body.data as Record<string, unknown>).deleted).toBe(true);

      const listRes = await server.request(`/api/v1/talks/${TALK_ID}/state`, {
        method: 'GET',
        headers: ownerAuth(),
      });
      const listBody = await json(listRes);
      expect((listBody.data as Record<string, unknown>).entries).toEqual([]);
    });

    it('DELETE /state/:key returns 404 for missing key', async () => {
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/state/${encodeURIComponent('no_such_key')}`,
        { method: 'DELETE', headers: ownerAuth() },
      );
      expect(res.status).toBe(404);
    });

    it('DELETE /state/:key returns 400 for invalid key pattern', async () => {
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/state/${encodeURIComponent('has spaces')}`,
        { method: 'DELETE', headers: ownerAuth() },
      );
      expect(res.status).toBe(400);
      const body = await json(res);
      expect((body.error as Record<string, string>).code).toBe('invalid_key');
    });
  });

  // =========================================================================
  // Sources CRUD
  // =========================================================================

  describe('sources', () => {
    it('creates a URL source with stable sourceRef', async () => {
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({
            sourceType: 'url',
            title: 'Meeting Notes',
            sourceUrl: 'https://example.com/notes',
          }),
        },
      );
      expect(res.status).toBe(201);
      const body = await json(res);
      const source = (body.data as Record<string, unknown>).source as Record<
        string,
        unknown
      >;
      expect(source.sourceRef).toBe('S1');
      expect(source.sourceType).toBe('url');
      expect(source.status).toBe('pending');
      expect(source.title).toBe('Meeting Notes');
    });

    it('creates a URL source in pending status', async () => {
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({
            sourceType: 'url',
            title: 'Docs page',
            sourceUrl: 'https://example.com/docs',
          }),
        },
      );
      expect(res.status).toBe(201);
      const source = ((await json(res)).data as Record<string, unknown>)
        .source as Record<string, unknown>;
      expect(source.status).toBe('pending');
      expect(source.sourceUrl).toBe('https://example.com/docs');
      expect(source.lastFetchedAt).toBeNull();
      expect(source.fetchStrategy).toBeNull();
      expect(sourceIngestion.enqueueUrlSource).toHaveBeenCalledWith(
        source.id,
        'https://example.com/docs',
      );
    });

    it('retries a failed URL source and re-enqueues ingestion', async () => {
      const createRes = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({
            sourceType: 'url',
            title: 'Docs page',
            sourceUrl: 'https://example.com/docs',
          }),
        },
      );
      const source = ((await json(createRes)).data as Record<string, unknown>)
        .source as ContextSourceSnapshot;

      updateSourceExtraction({
        sourceId: source.id,
        extractedText: null,
        extractionError:
          'fetch_http_error: HTTP 403 from https://example.com/docs',
        fetchStrategy: 'http',
      });

      sourceIngestion.enqueueUrlSource.mockClear();

      const retryRes = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources/${source.id}/retry`,
        {
          method: 'POST',
          headers: ownerAuth(),
        },
      );
      expect(retryRes.status).toBe(200);
      const retried = ((await json(retryRes)).data as Record<string, unknown>)
        .source as Record<string, unknown>;
      expect(retried.status).toBe('pending');
      expect(retried.extractionError).toBeNull();
      expect(sourceIngestion.enqueueUrlSource).toHaveBeenCalledWith(
        source.id,
        'https://example.com/docs',
      );
    });

    it('creates a text source via API', async () => {
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({
            sourceType: 'text',
            title: 'Text Source',
            extractedText: 'Some content',
          }),
        },
      );
      expect(res.status).toBe(201);
      const source = ((await json(res)).data as Record<string, unknown>)
        .source as Record<string, unknown>;
      expect(source.sourceType).toBe('text');
      expect(source.status).toBe('ready');
      expect(source.extractedTextLength).toBe('Some content'.length);
    });

    it('rejects text source without content', async () => {
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({
            sourceType: 'text',
            title: 'Empty Text Source',
            extractedText: '   ',
          }),
        },
      );
      expect(res.status).toBe(400);
      expect(((await json(res)).error as Record<string, string>).code).toBe(
        'text_required',
      );
    });

    it('rejects URL source without URL', async () => {
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({ sourceType: 'url', title: 'No URL' }),
        },
      );
      expect(res.status).toBe(400);
      expect(((await json(res)).error as Record<string, string>).code).toBe(
        'url_required',
      );
    });

    it('rejects invalid source type', async () => {
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({ sourceType: 'image', title: 'Pic' }),
        },
      );
      expect(res.status).toBe(400);
      expect(((await json(res)).error as Record<string, string>).code).toBe(
        'invalid_source_type',
      );
    });

    it('source refs never recompact on delete', async () => {
      // Create S1, S2, S3
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await server.request(
          `/api/v1/talks/${TALK_ID}/context/sources`,
          {
            method: 'POST',
            headers: ownerAuth(),
            body: JSON.stringify({
              sourceType: 'url',
              title: `Source ${i + 1}`,
              sourceUrl: `https://example.com/${i + 1}`,
            }),
          },
        );
        const source = ((await json(res)).data as Record<string, unknown>)
          .source as Record<string, unknown>;
        ids.push(source.id as string);
      }

      // Delete S2
      await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources/${ids[1]}`,
        { method: 'DELETE', headers: ownerAuth() },
      );

      // Create new source — should be S4, not S2
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({
            sourceType: 'url',
            title: 'Source 4',
            sourceUrl: 'https://example.com/4',
          }),
        },
      );
      const source = ((await json(res)).data as Record<string, unknown>)
        .source as Record<string, unknown>;
      expect(source.sourceRef).toBe('S4');
    });

    it('enforces 20 source limit', async () => {
      // Create 20 sources
      for (let i = 0; i < 20; i++) {
        const res = await server.request(
          `/api/v1/talks/${TALK_ID}/context/sources`,
          {
            method: 'POST',
            headers: ownerAuth(),
            body: JSON.stringify({
              sourceType: 'url',
              title: `Source ${i + 1}`,
              sourceUrl: `https://example.com/${i + 1}`,
            }),
          },
        );
        expect(res.status).toBe(201);
      }

      // 21st should fail
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({
            sourceType: 'url',
            title: 'Source 21',
            sourceUrl: 'https://example.com/21',
          }),
        },
      );
      expect(res.status).toBe(400);
      expect(((await json(res)).error as Record<string, string>).code).toBe(
        'source_limit',
      );
    });

    it('patches source title, note, and sortOrder', async () => {
      const createRes = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({
            sourceType: 'url',
            title: 'Original',
            sourceUrl: 'https://example.com/original',
            note: 'Initial note',
          }),
        },
      );
      const source = ((await json(createRes)).data as Record<string, unknown>)
        .source as Record<string, unknown>;
      const sourceId = source.id as string;

      const patchRes = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources/${sourceId}`,
        {
          method: 'PATCH',
          headers: ownerAuth(),
          body: JSON.stringify({
            title: 'Updated Title',
            note: 'Updated note',
            sortOrder: 5,
          }),
        },
      );
      expect(patchRes.status).toBe(200);
      const patched = ((await json(patchRes)).data as Record<string, unknown>)
        .source as Record<string, unknown>;
      expect(patched.title).toBe('Updated Title');
      expect(patched.note).toBe('Updated note');
      expect(patched.sortOrder).toBe(5);
    });

    it('patches text source content', async () => {
      const createRes = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({
            sourceType: 'text',
            title: 'Notes',
            extractedText: 'V1 content',
          }),
        },
      );
      const source = ((await json(createRes)).data as Record<string, unknown>)
        .source as Record<string, unknown>;
      const sourceId = source.id as string;

      const patchRes = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources/${sourceId}`,
        {
          method: 'PATCH',
          headers: ownerAuth(),
          body: JSON.stringify({ extractedText: 'V2 content' }),
        },
      );
      expect(patchRes.status).toBe(200);
      // Verify via the snapshot (extractedTextLength should update)
      const patched = ((await json(patchRes)).data as Record<string, unknown>)
        .source as Record<string, unknown>;
      expect(patched.extractedTextLength).toBe(10); // 'V2 content'.length
    });

    it('truncates oversized text source content on create via API', async () => {
      const longText = 'x'.repeat(60_000);
      const res = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({
            sourceType: 'text',
            title: 'Huge Source',
            extractedText: longText,
          }),
        },
      );
      expect(res.status).toBe(201);
      const source = ((await json(res)).data as Record<string, unknown>)
        .source as Record<string, unknown>;

      expect(source.isTruncated).toBe(true);
      expect(source.extractedTextLength).toBe(50_000);
      expect(source.status).toBe('ready');
    });

    it('truncates oversized text source content on patch', async () => {
      const createRes = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources`,
        {
          method: 'POST',
          headers: ownerAuth(),
          body: JSON.stringify({
            sourceType: 'text',
            title: 'Patch Me',
            extractedText: 'Short text',
          }),
        },
      );
      const source = ((await json(createRes)).data as Record<string, unknown>)
        .source as Record<string, unknown>;
      const sourceId = source.id as string;

      const patchRes = await server.request(
        `/api/v1/talks/${TALK_ID}/context/sources/${sourceId}`,
        {
          method: 'PATCH',
          headers: ownerAuth(),
          body: JSON.stringify({
            extractedText: 'y'.repeat(55_000),
          }),
        },
      );

      expect(patchRes.status).toBe(200);
      const patched = ((await json(patchRes)).data as Record<string, unknown>)
        .source as Record<string, unknown>;
      expect(patched.isTruncated).toBe(true);
      expect(patched.extractedTextLength).toBe(50_000);
    });

    it('marks file sources ready even when extraction yields no text', () => {
      const source = createTalkContextSource({
        talkId: TALK_ID,
        sourceType: 'file',
        title: 'Spreadsheet',
        fileName: 'sheet.xlsx',
        fileSize: 1234,
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        storageKey: 'attachments/talk-ctx/sheet.xlsx',
        extractedText: null,
        createdBy: 'owner-1',
      });

      expect(source.status).toBe('ready');
      expect(source.extractedTextLength).toBeNull();
    });
  });

  // =========================================================================
  // Full integration: context snapshot reflects all operations
  // =========================================================================

  describe('integration', () => {
    it('full workflow: goal + rules + sources appear in GET /context', async () => {
      // Set goal
      await server.request(`/api/v1/talks/${TALK_ID}/context/goal`, {
        method: 'PUT',
        headers: ownerAuth(),
        body: JSON.stringify({ goalText: 'Analyze quarterly data' }),
      });

      // Add rules
      await server.request(`/api/v1/talks/${TALK_ID}/context/rules`, {
        method: 'POST',
        headers: ownerAuth(),
        body: JSON.stringify({ ruleText: 'Be concise' }),
      });
      await server.request(`/api/v1/talks/${TALK_ID}/context/rules`, {
        method: 'POST',
        headers: ownerAuth(),
        body: JSON.stringify({ ruleText: 'Use metric units' }),
      });

      // Add sources
      await server.request(`/api/v1/talks/${TALK_ID}/context/sources`, {
        method: 'POST',
        headers: ownerAuth(),
        body: JSON.stringify({
          sourceType: 'url',
          title: 'Data dictionary',
          sourceUrl: 'https://example.com/data-dictionary',
        }),
      });
      await server.request(`/api/v1/talks/${TALK_ID}/context/sources`, {
        method: 'POST',
        headers: ownerAuth(),
        body: JSON.stringify({
          sourceType: 'url',
          title: 'Docs',
          sourceUrl: 'https://docs.example.com',
        }),
      });

      // Retrieve full context
      const res = await server.request(`/api/v1/talks/${TALK_ID}/context`, {
        method: 'GET',
        headers: ownerAuth(),
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      const data = body.data as Record<string, unknown>;

      // Goal
      const goal = data.goal as Record<string, unknown>;
      expect(goal.goalText).toBe('Analyze quarterly data');

      // Rules
      const rules = data.rules as Array<Record<string, unknown>>;
      expect(rules).toHaveLength(2);
      expect(rules[0].ruleText).toBe('Be concise');
      expect(rules[1].ruleText).toBe('Use metric units');

      // Sources
      const sources = data.sources as Array<Record<string, unknown>>;
      expect(sources).toHaveLength(2);
      expect(sources[0].sourceRef).toBe('S1');
      expect(sources[0].sourceType).toBe('url');
      expect(sources[1].sourceRef).toBe('S2');
      expect(sources[1].sourceType).toBe('url');
    });
  });
});
