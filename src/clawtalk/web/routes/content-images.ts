// POST + GET routes for inline content images.
//
// POST /api/v1/content-images       (auth required, browser-CSRF)
//   Body: { dataUrl?: string } | { sourceUrl?: string }
//   Returns: 200 { ok, data: { url, key } }
//
// GET  /api/v1/content-images/:key  (public — keys are content-addressed
//                                    with 128 bits of unguessability)
//   Returns: 200 image bytes + immutable cache headers, or 304 / 404.
//
// The dataUrl branch handles clipboard pastes (browser screenshot, image
// copy from the OS). The sourceUrl branch rehosts an external image
// that the editor saw during a paste — gated by REHOST_HOST_ALLOWLIST
// in src/shared/content-image-hosts.ts so a user can't trick the
// Worker into fetching arbitrary URLs.
//
// Both branches buffer bytes in memory (8 MiB POST cap, 5 MiB fetch
// cap), sniff MIME via magic bytes (defending against a spoofed
// Content-Type), and persist through putContentImage which
// content-addresses the key as ci/<32hex>.<ext>.

import type { Context } from 'hono';

import { isRehostHostAllowed } from '../../../shared/content-image-hosts.js';
import {
  type ContentImagesBucket,
  detectMime,
  deriveContentType,
  putContentImage,
} from '../../r2/content-images.js';
import { validateCsrfTokenPg } from '../middleware/csrf.js';
import type { AuthContext } from '../types.js';

interface ContentImagesEnv {
  CONTENT_IMAGES: ContentImagesBucket;
  APP_ORIGIN?: string;
}

const POST_BODY_CAP_BYTES = 8 * 1024 * 1024;
const SOURCE_FETCH_CAP_BYTES = 5 * 1024 * 1024;
const SOURCE_FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
// Must mirror the key shape used by `buildKey` in r2/content-images.ts:
// 32 hex chars + one of the four allowed raster extensions.
const KEY_RE = /^[a-f0-9]{32}\.(png|jpe?g|gif|webp)$/;

interface PostBody {
  dataUrl?: string;
  sourceUrl?: string;
}

// ─── POST /api/v1/content-images ─────────────────────────────────

export async function postContentImageHandler(c: Context): Promise<Response> {
  const env = c.env as ContentImagesEnv;
  const auth = c.get('auth') as AuthContext | undefined;
  if (!auth) {
    return c.json(
      {
        ok: false,
        error: { code: 'unauthorized', message: 'Not authenticated' },
      },
      401,
    );
  }

  const originErr = checkContentImageOrigin(c, env.APP_ORIGIN);
  if (originErr) return originErr;

  const csrfErr = checkCsrf(c, auth);
  if (csrfErr) return csrfErr;

  const body = await readBoundedBody(c.req.raw, POST_BODY_CAP_BYTES);
  if (!body.ok) {
    return c.json(
      { ok: false, error: { code: body.code, message: body.message } },
      body.code === 'payload_too_large' ? 413 : 400,
    );
  }

  let parsed: PostBody;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body.bytes)) as PostBody;
  } catch {
    return c.json(
      {
        ok: false,
        error: {
          code: 'invalid_json',
          message: 'Request body is not valid JSON',
        },
      },
      400,
    );
  }

  let imageBytes: Uint8Array;
  if (typeof parsed.dataUrl === 'string') {
    const decoded = decodeDataUrl(parsed.dataUrl);
    if (!decoded.ok) {
      return c.json(
        {
          ok: false,
          error: { code: decoded.code, message: decoded.message },
        },
        400,
      );
    }
    imageBytes = decoded.bytes;
  } else if (typeof parsed.sourceUrl === 'string') {
    const fetched = await fetchSourceUrl(parsed.sourceUrl);
    if (!fetched.ok) {
      return c.json(
        {
          ok: false,
          error: { code: fetched.code, message: fetched.message },
        },
        fetched.status,
      );
    }
    imageBytes = fetched.bytes;
  } else {
    return c.json(
      {
        ok: false,
        error: {
          code: 'invalid_body',
          message: 'Body must include dataUrl or sourceUrl',
        },
      },
      400,
    );
  }

  const mime = detectMime(imageBytes);
  if (!mime) {
    return c.json(
      {
        ok: false,
        error: {
          code: 'unsupported_mime',
          message: 'Image MIME could not be detected from bytes',
        },
      },
      400,
    );
  }

  const result = await putContentImage(env.CONTENT_IMAGES, imageBytes, mime);
  const urlPath = `/api/v1/content-images/${result.key.replace(/^ci\//, '')}`;
  return c.json({
    ok: true,
    data: { url: urlPath, key: result.key },
  });
}

// ─── GET /api/v1/content-images/:key ─────────────────────────────

export async function getContentImageHandler(c: Context): Promise<Response> {
  const env = c.env as ContentImagesEnv;
  const key = c.req.param('key');
  if (!key || !KEY_RE.test(key)) {
    return c.json(
      {
        ok: false,
        error: { code: 'invalid_key', message: 'Invalid content-image key' },
      },
      400,
    );
  }

  const cache = getCachesDefault();
  // The cache key uses the request URL — only the path/query are
  // material (method is implicit GET).
  const cacheKey = new Request(c.req.url, { method: 'GET' });

  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const inm = c.req.header('if-none-match');
      if (inm && etagMatches(cached.headers.get('etag'), inm)) {
        return new Response(null, {
          status: 304,
          headers: stripBodyHeaders(cached.headers),
        });
      }
      return cached;
    }
  }

  const obj = await env.CONTENT_IMAGES.get(`ci/${key}`);
  if (!obj) {
    return c.json(
      {
        ok: false,
        error: { code: 'not_found', message: 'Image not found' },
      },
      404,
    );
  }

  const inm = c.req.header('if-none-match');
  if (inm && etagMatches(obj.httpEtag, inm)) {
    void obj.body.cancel().catch(() => {});
    return new Response(null, {
      status: 304,
      headers: { etag: obj.httpEtag },
    });
  }

  const contentType = deriveContentType(key);
  if (!contentType) {
    // Unreachable given KEY_RE, but keeps the type chain honest.
    return c.json(
      {
        ok: false,
        error: {
          code: 'unsupported_mime',
          message: 'Cannot derive content-type',
        },
      },
      500,
    );
  }
  const headers = new Headers({
    'content-type': contentType,
    'cache-control': `public, max-age=${CACHE_TTL_SECONDS}, immutable`,
    etag: obj.httpEtag,
    'x-content-type-options': 'nosniff',
  });
  const response = new Response(obj.body, { status: 200, headers });

  if (cache) {
    const ctx = c.executionCtx;
    const write = cache
      .put(cacheKey, response.clone())
      .catch((err: unknown) => {
        // Cache writes are best-effort; log + continue.
        console.warn('content-images cache.put failed', err);
      });
    if (ctx) {
      ctx.waitUntil(write);
    } else {
      void write;
    }
  }

  return response;
}

// ─── helpers ─────────────────────────────────────────────────────

function checkContentImageOrigin(
  c: Context,
  appOriginRaw: string | undefined,
): Response | null {
  const origin = c.req.header('origin');
  const referer = c.req.header('referer');
  if (!origin && !referer) {
    return c.json(
      {
        ok: false,
        error: {
          code: 'origin_required',
          message: 'Origin or Referer header is required',
        },
      },
      403,
    );
  }
  const allowlist = parseAppOrigin(appOriginRaw);
  const candidate = origin ?? originFromReferer(referer);
  if (!candidate || !allowlist.has(candidate)) {
    return c.json(
      {
        ok: false,
        error: {
          code: 'origin_not_allowed',
          message: `Origin ${candidate ?? '(missing)'} is not in APP_ORIGIN allowlist`,
        },
      },
      403,
    );
  }
  return null;
}

function parseAppOrigin(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function originFromReferer(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function checkCsrf(c: Context, auth: AuthContext): Response | null {
  const csrf = validateCsrfTokenPg({
    method: c.req.method,
    authType: auth.authType,
    cookieHeader: c.req.header('cookie'),
    csrfHeader: c.req.header('x-csrf-token'),
  });
  if (csrf.ok) return null;
  return c.json(
    { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
    403,
  );
}

type BoundedBodyResult =
  | { ok: true; bytes: Uint8Array }
  | {
      ok: false;
      code: 'payload_too_large' | 'body_read_failed';
      message: string;
    };

async function readBoundedBody(
  req: Request | Response,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  const lenHeader = req.headers.get('content-length');
  if (lenHeader) {
    const claimed = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(claimed) && claimed > maxBytes) {
      return {
        ok: false,
        code: 'payload_too_large',
        message: `Body exceeds ${maxBytes} bytes (declared ${claimed})`,
      };
    }
  }
  if (!req.body) {
    return { ok: true, bytes: new Uint8Array(0) };
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return {
          ok: false,
          code: 'payload_too_large',
          message: `Body exceeds ${maxBytes} bytes`,
        };
      }
      chunks.push(value);
    }
  } catch (err) {
    return {
      ok: false,
      code: 'body_read_failed',
      message: err instanceof Error ? err.message : 'body read failed',
    };
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: merged };
}

type DataUrlResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: 'invalid_data_url'; message: string };

function decodeDataUrl(dataUrl: string): DataUrlResult {
  const match = /^data:([^;,]+)?(;[^,]*)?,(.*)$/s.exec(dataUrl);
  if (!match) {
    return {
      ok: false,
      code: 'invalid_data_url',
      message: 'Malformed data URL',
    };
  }
  const mediaType = (match[1] ?? '').toLowerCase();
  const params = (match[2] ?? '').toLowerCase();
  const payload = match[3] ?? '';
  if (!mediaType.startsWith('image/')) {
    return {
      ok: false,
      code: 'invalid_data_url',
      message: `Unsupported media type ${mediaType}`,
    };
  }
  const isBase64 = params.includes('base64');
  try {
    const binary = isBase64 ? atob(payload) : decodeURIComponent(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { ok: true, bytes };
  } catch {
    return {
      ok: false,
      code: 'invalid_data_url',
      message: 'Failed to decode data URL payload',
    };
  }
}

type SourceFetchResult =
  | { ok: true; bytes: Uint8Array }
  | {
      ok: false;
      status: 400 | 403 | 413 | 502;
      code:
        | 'source_url_invalid_protocol'
        | 'source_host_not_allowed'
        | 'source_fetch_redirected'
        | 'source_fetch_failed'
        | 'payload_too_large';
      message: string;
    };

async function fetchSourceUrl(sourceUrl: string): Promise<SourceFetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return {
      ok: false,
      status: 400,
      code: 'source_url_invalid_protocol',
      message: 'sourceUrl is not a valid URL',
    };
  }
  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      status: 400,
      code: 'source_url_invalid_protocol',
      message: 'sourceUrl must use https',
    };
  }
  if (!isRehostHostAllowed(parsed.hostname)) {
    return {
      ok: false,
      status: 403,
      code: 'source_host_not_allowed',
      message: `Host ${parsed.hostname} is not in the rehost allowlist`,
    };
  }
  let res: Response;
  try {
    res = await fetch(parsed.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      code: 'source_fetch_failed',
      message: err instanceof Error ? err.message : 'fetch failed',
    };
  }
  if (res.status >= 300 && res.status < 400) {
    return {
      ok: false,
      status: 502,
      code: 'source_fetch_redirected',
      message: `sourceUrl returned ${res.status}; redirects are not followed`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: 502,
      code: 'source_fetch_failed',
      message: `sourceUrl returned ${res.status}`,
    };
  }
  const result = await readBoundedBody(res, SOURCE_FETCH_CAP_BYTES);
  if (!result.ok) {
    return {
      ok: false,
      status: result.code === 'payload_too_large' ? 413 : 502,
      code:
        result.code === 'payload_too_large'
          ? 'payload_too_large'
          : 'source_fetch_failed',
      message: result.message,
    };
  }
  return { ok: true, bytes: result.bytes };
}

// Minimal Cloudflare Workers Cache surface — only the methods we use.
// Kept inline so this module doesn't have to import
// @cloudflare/workers-types globals.
interface WorkerCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function getCachesDefault(): WorkerCache | null {
  try {
    return (
      (globalThis as { caches?: { default?: WorkerCache } }).caches?.default ??
      null
    );
  } catch {
    return null;
  }
}

function etagMatches(
  serverEtag: string | null | undefined,
  ifNoneMatch: string,
): boolean {
  if (!serverEtag) return false;
  return ifNoneMatch
    .split(',')
    .map((s) => s.trim())
    .some((tag) => tag === serverEtag || tag === '*');
}

function stripBodyHeaders(h: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of h.entries()) {
    if (k.toLowerCase() === 'content-length') continue;
    out.set(k, v);
  }
  return out;
}

// Re-exported for tests so we don't have to invoke the full Hono
// stack to validate parsers.
export const _internal = {
  decodeDataUrl,
  parseAppOrigin,
  originFromReferer,
  readBoundedBody,
  etagMatches,
};
