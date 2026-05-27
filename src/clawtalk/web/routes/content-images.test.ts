// Tests for the content-images upload + serve routes.
//
// The full Hono app's auth stack is exercised by worker-app.test.ts.
// Here we mount the handlers on a minimal Hono with a stub auth
// middleware so the route logic itself is the system under test
// without dragging in JWKS + JWT mint + Supabase env scaffolding.

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ContentImagesBucket,
  ContentImagesObjectBody,
} from '../../r2/content-images.js';
import type { AuthContext } from '../types.js';
import {
  _internal,
  getContentImageHandler,
  postContentImageHandler,
} from './content-images.js';

const APP_ORIGIN = 'https://app.test,http://localhost:5173';
const GOOD_ORIGIN = 'https://app.test';

// Sample image bytes the magic-byte detector accepts.
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function btoaBinary(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

const PNG_DATA_URL = `data:image/png;base64,${btoaBinary(PNG_BYTES)}`;

function makeStubBucket() {
  const stored = new Map<
    string,
    { bytes: Uint8Array; contentType?: string; httpEtag: string }
  >();
  let etagCounter = 0;
  const bucket: ContentImagesBucket = {
    async put(key, value, options) {
      etagCounter += 1;
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const httpEtag = `"etag-${etagCounter}"`;
      stored.set(key, {
        bytes,
        contentType: options?.httpMetadata?.contentType,
        httpEtag,
      });
      return { key, size: bytes.byteLength, httpEtag };
    },
    async get(key) {
      const entry = stored.get(key);
      if (!entry) return null;
      const obj: ContentImagesObjectBody = {
        key,
        size: entry.bytes.byteLength,
        httpEtag: entry.httpEtag,
        httpMetadata: entry.contentType
          ? { contentType: entry.contentType }
          : undefined,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(entry.bytes);
            controller.close();
          },
        }),
        async arrayBuffer() {
          return entry.bytes.buffer.slice(
            entry.bytes.byteOffset,
            entry.bytes.byteOffset + entry.bytes.byteLength,
          ) as ArrayBuffer;
        },
      };
      return obj;
    },
    async head(key) {
      const entry = stored.get(key);
      if (!entry) return null;
      return {
        key,
        size: entry.bytes.byteLength,
        httpEtag: entry.httpEtag,
        httpMetadata: entry.contentType
          ? { contentType: entry.contentType }
          : undefined,
      };
    },
  };
  return { bucket, stored };
}

function makeTestApp(
  bucket: ContentImagesBucket,
  authType: AuthContext['authType'] = 'bearer',
) {
  const app = new Hono<{
    Variables: { auth: AuthContext };
    Bindings: { CONTENT_IMAGES: ContentImagesBucket; APP_ORIGIN: string };
  }>();
  // Stub auth middleware — populates c.var.auth without JWT verification.
  app.use(async (c, next) => {
    const auth: AuthContext = {
      sessionId: 'sess-1',
      userId: '00000000-0000-0000-0000-000000000001',
      role: 'owner',
      authType,
    };
    c.set('auth', auth);
    await next();
  });
  app.post('/api/v1/content-images', postContentImageHandler);
  app.get('/api/v1/content-images/:key', getContentImageHandler);
  return {
    app,
    env: { CONTENT_IMAGES: bucket, APP_ORIGIN },
  };
}

// ─── helper-level unit tests (_internal) ─────────────────────────

describe('decodeDataUrl', () => {
  it('decodes a base64 PNG data URL', () => {
    const result = _internal.decodeDataUrl(PNG_DATA_URL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.bytes)).toEqual(Array.from(PNG_BYTES));
  });

  it('rejects non-image media types', () => {
    expect(_internal.decodeDataUrl('data:text/html,<x>').ok).toBe(false);
    expect(_internal.decodeDataUrl('data:application/json,{}').ok).toBe(false);
  });

  it('rejects garbage that does not start with data:', () => {
    expect(_internal.decodeDataUrl('http://example.com/x.png').ok).toBe(false);
    expect(_internal.decodeDataUrl('').ok).toBe(false);
  });

  it('decodes urlencoded (non-base64) data URLs', () => {
    const result = _internal.decodeDataUrl('data:image/svg+xml,%3Csvg%2F%3E');
    expect(result.ok).toBe(true);
  });
});

describe('parseAppOrigin', () => {
  it('splits comma list and trims whitespace', () => {
    const s = _internal.parseAppOrigin('  https://a.com ,https://b.com,  ');
    expect([...s].sort()).toEqual(['https://a.com', 'https://b.com']);
  });

  it('returns empty set for undefined / empty', () => {
    expect(_internal.parseAppOrigin(undefined).size).toBe(0);
    expect(_internal.parseAppOrigin('').size).toBe(0);
  });
});

describe('originFromReferer', () => {
  it('extracts the origin from a full URL', () => {
    expect(_internal.originFromReferer('https://app.test/path?x=1')).toBe(
      'https://app.test',
    );
  });

  it('returns null for malformed input', () => {
    expect(_internal.originFromReferer('not a url')).toBeNull();
    expect(_internal.originFromReferer(undefined)).toBeNull();
  });
});

describe('etagMatches', () => {
  it('matches exact', () => {
    expect(_internal.etagMatches('"abc"', '"abc"')).toBe(true);
  });

  it('matches comma-separated lists', () => {
    expect(_internal.etagMatches('"abc"', '"xyz", "abc"')).toBe(true);
  });

  it('matches *', () => {
    expect(_internal.etagMatches('"abc"', '*')).toBe(true);
  });

  it('does not match mismatched etags', () => {
    expect(_internal.etagMatches('"abc"', '"xyz"')).toBe(false);
  });

  it('returns false when server etag is null', () => {
    expect(_internal.etagMatches(null, '"abc"')).toBe(false);
  });
});

describe('readBoundedBody', () => {
  it('reads a small body in full', async () => {
    const req = new Request('http://x/', { method: 'POST', body: 'hello' });
    const result = await _internal.readBoundedBody(req, 1024);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.bytes)).toBe('hello');
  });

  it('rejects via content-length precheck', async () => {
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'content-length': '5000' },
      body: 'x'.repeat(5000),
    });
    const result = await _internal.readBoundedBody(req, 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('payload_too_large');
  });

  it('rejects when streamed body exceeds cap', async () => {
    // Request without content-length forces the streaming-read cap path.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(60));
        c.enqueue(new Uint8Array(60));
        c.close();
      },
    });
    const req = new Request('http://x/', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const result = await _internal.readBoundedBody(req, 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('payload_too_large');
  });
});

// ─── route integration tests ─────────────────────────────────────

describe('POST /api/v1/content-images', () => {
  it('happy path: dataUrl PNG → 200 with url + key', async () => {
    const { bucket, stored } = makeStubBucket();
    const { app, env } = makeTestApp(bucket);
    const res = await app.request(
      new Request('https://app.test/api/v1/content-images', {
        method: 'POST',
        headers: {
          origin: GOOD_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dataUrl: PNG_DATA_URL }),
      }),
      undefined,
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { url: string; key: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.key).toMatch(/^ci\/[a-f0-9]{32}\.png$/);
    expect(body.data.url).toBe(
      `/api/v1/content-images/${body.data.key.replace(/^ci\//, '')}`,
    );
    expect(stored.has(body.data.key)).toBe(true);
  });

  it('cross-origin → 403 origin_not_allowed', async () => {
    const { bucket } = makeStubBucket();
    const { app, env } = makeTestApp(bucket);
    const res = await app.request(
      new Request('https://app.test/api/v1/content-images', {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dataUrl: PNG_DATA_URL }),
      }),
      undefined,
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe('origin_not_allowed');
  });

  it('missing Origin and Referer → 403 origin_required', async () => {
    const { bucket } = makeStubBucket();
    const { app, env } = makeTestApp(bucket);
    const res = await app.request(
      new Request('https://app.test/api/v1/content-images', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataUrl: PNG_DATA_URL }),
      }),
      undefined,
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('origin_required');
  });

  it('bad MIME (text payload labelled as image/png) → 400 unsupported_mime', async () => {
    const { bucket } = makeStubBucket();
    const { app, env } = makeTestApp(bucket);
    const garbage = `data:image/png;base64,${btoa('this is plain text')}`;
    const res = await app.request(
      new Request('https://app.test/api/v1/content-images', {
        method: 'POST',
        headers: {
          origin: GOOD_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dataUrl: garbage }),
      }),
      undefined,
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unsupported_mime');
  });

  it('missing dataUrl and sourceUrl → 400 invalid_body', async () => {
    const { bucket } = makeStubBucket();
    const { app, env } = makeTestApp(bucket);
    const res = await app.request(
      new Request('https://app.test/api/v1/content-images', {
        method: 'POST',
        headers: {
          origin: GOOD_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
      undefined,
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
  });

  it('content-length precheck blocks oversized → 413', async () => {
    const { bucket } = makeStubBucket();
    const { app, env } = makeTestApp(bucket);
    const res = await app.request(
      new Request('https://app.test/api/v1/content-images', {
        method: 'POST',
        headers: {
          origin: GOOD_ORIGIN,
          'content-type': 'application/json',
          'content-length': String(10 * 1024 * 1024),
        },
        body: '{}',
      }),
      undefined,
      env,
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('payload_too_large');
  });

  it('sourceUrl with disallowed host → 403 source_host_not_allowed', async () => {
    const { bucket } = makeStubBucket();
    const { app, env } = makeTestApp(bucket);
    const res = await app.request(
      new Request('https://app.test/api/v1/content-images', {
        method: 'POST',
        headers: {
          origin: GOOD_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sourceUrl: 'https://example.com/image.png',
        }),
      }),
      undefined,
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('source_host_not_allowed');
  });

  it('sourceUrl with http:// → 400 source_url_invalid_protocol', async () => {
    const { bucket } = makeStubBucket();
    const { app, env } = makeTestApp(bucket);
    const res = await app.request(
      new Request('https://app.test/api/v1/content-images', {
        method: 'POST',
        headers: {
          origin: GOOD_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sourceUrl: 'http://example.com/image.png',
        }),
      }),
      undefined,
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('source_url_invalid_protocol');
  });

  it('cookie auth without CSRF token → 403 csrf_failed', async () => {
    const { bucket } = makeStubBucket();
    const { app, env } = makeTestApp(bucket, 'cookie');
    const res = await app.request(
      new Request('https://app.test/api/v1/content-images', {
        method: 'POST',
        headers: {
          origin: GOOD_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dataUrl: PNG_DATA_URL }),
      }),
      undefined,
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('csrf_failed');
  });
});

describe('GET /api/v1/content-images/:key', () => {
  let key: string;
  let storedRef: ReturnType<typeof makeStubBucket>['stored'];
  let bucketRef: ContentImagesBucket;

  beforeEach(async () => {
    const { bucket, stored } = makeStubBucket();
    bucketRef = bucket;
    storedRef = stored;
    // Seed the bucket via a real POST so the key is derived consistently.
    const { app, env } = makeTestApp(bucket);
    const res = await app.request(
      new Request('https://app.test/api/v1/content-images', {
        method: 'POST',
        headers: {
          origin: GOOD_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dataUrl: PNG_DATA_URL }),
      }),
      undefined,
      env,
    );
    const body = (await res.json()) as {
      data: { key: string };
    };
    key = body.data.key.replace(/^ci\//, '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 + bytes with cache-control + etag', async () => {
    const { app, env } = makeTestApp(bucketRef);
    const res = await app.request(
      new Request(`https://app.test/api/v1/content-images/${key}`),
      undefined,
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toMatch(/immutable/);
    expect(res.headers.get('etag')).toBeTruthy();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const buf = await res.arrayBuffer();
    expect(Array.from(new Uint8Array(buf))).toEqual(Array.from(PNG_BYTES));
  });

  it('returns 304 when If-None-Match matches', async () => {
    const { app, env } = makeTestApp(bucketRef);
    // First request to grab the etag.
    const firstRes = await app.request(
      new Request(`https://app.test/api/v1/content-images/${key}`),
      undefined,
      env,
    );
    const etag = firstRes.headers.get('etag');
    expect(etag).toBeTruthy();
    // Drain body so the stream completes.
    await firstRes.arrayBuffer();

    const condRes = await app.request(
      new Request(`https://app.test/api/v1/content-images/${key}`, {
        headers: { 'if-none-match': etag ?? '' },
      }),
      undefined,
      env,
    );
    expect(condRes.status).toBe(304);
  });

  it('returns 400 for invalid key shape', async () => {
    const { app, env } = makeTestApp(bucketRef);
    const res = await app.request(
      new Request('https://app.test/api/v1/content-images/not-a-valid-key.png'),
      undefined,
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_key');
  });

  it('returns 400 for invalid extension', async () => {
    const { app, env } = makeTestApp(bucketRef);
    const res = await app.request(
      new Request(
        `https://app.test/api/v1/content-images/${'a'.repeat(32)}.svg`,
      ),
      undefined,
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for missing object', async () => {
    const { app, env } = makeTestApp(bucketRef);
    const res = await app.request(
      new Request(
        `https://app.test/api/v1/content-images/${'0'.repeat(32)}.png`,
      ),
      undefined,
      env,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
    // No object was inserted under the all-zero key.
    expect(storedRef.has(`ci/${'0'.repeat(32)}.png`)).toBe(false);
  });
});
