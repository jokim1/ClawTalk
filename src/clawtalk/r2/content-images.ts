// Content-image storage helpers for the rich-text editor's inline image
// upload flow. Backed by the CONTENT_IMAGES R2 bucket (configured in
// wrangler.toml). Keys live under the `ci/` prefix as
// `ci/<32hex>.<ext>` — 128 bits of content addressing is sufficient for
// dedup at our scale and keeps URLs short.

export type ContentImageMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp';

export const CONTENT_IMAGE_MIMES: readonly ContentImageMime[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

// MIME → key extension. JPEG uses the shorter `jpg`; the link-url
// normalizer (src/shared/rich-text/link-url.ts) accepts both `jpg` and
// `jpeg`, but we always write `jpg` so dedup keys stay canonical.
const MIME_TO_EXT: Readonly<Record<ContentImageMime, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const EXT_TO_MIME: Readonly<Record<string, ContentImageMime>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// Narrow R2 bucket surface — structurally compatible with the inline
// R2Bucket type in src/worker.ts. Defined locally so this module
// doesn't have to import from worker.ts (which would tangle the
// dependency graph) and so tests can pass a plain mock object.
export interface ContentImagesBucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<{ key: string; size: number; httpEtag: string }>;
  get(key: string): Promise<ContentImagesObjectBody | null>;
  head(key: string): Promise<{
    key: string;
    size: number;
    httpEtag: string;
    httpMetadata?: { contentType?: string };
  } | null>;
}

export interface ContentImagesObjectBody {
  key: string;
  size: number;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface PutContentImageResult {
  key: string;
  httpEtag: string;
}

export function buildKey(hash: string, ext: string): string {
  return `ci/${hash}.${ext}`;
}

// Derive the response Content-Type from a key (or just the
// `<hash>.<ext>` portion). Returns null for unknown extensions so the
// route handler can 404 rather than serve unknown bytes.
export function deriveContentType(key: string): ContentImageMime | null {
  const dot = key.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = key.slice(dot + 1).toLowerCase();
  return EXT_TO_MIME[ext] ?? null;
}

export async function putContentImage(
  bucket: ContentImagesBucket,
  bytes: ArrayBuffer | Uint8Array,
  mime: ContentImageMime,
): Promise<PutContentImageResult> {
  const hash = await sha256Hex(bytes);
  const shortHash = hash.slice(0, 32);
  const key = buildKey(shortHash, MIME_TO_EXT[mime]);
  const result = await bucket.put(key, bytes, {
    httpMetadata: { contentType: mime },
  });
  return { key, httpEtag: result.httpEtag };
}

export async function getContentImage(
  bucket: ContentImagesBucket,
  key: string,
): Promise<ContentImagesObjectBody | null> {
  return bucket.get(key);
}

async function sha256Hex(buf: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const arr = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    out += arr[i].toString(16).padStart(2, '0');
  }
  return out;
}

// Magic-byte MIME sniffer. Defends the upload route against a
// content-type-spoofed payload (e.g. caller claims image/png but bytes
// are SVG). Covers the four raster types we accept; returns null for
// anything else so the route can 400.
export function detectMime(buf: Uint8Array): ContentImageMime | null {
  // JPEG: FF D8 FF — earliest match, only 3 bytes needed.
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  // GIF87a / GIF89a — 6 bytes.
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 && // G
    buf[1] === 0x49 && // I
    buf[2] === 0x46 && // F
    buf[3] === 0x38 && // 8
    (buf[4] === 0x37 || buf[4] === 0x39) && // 7 | 9
    buf[5] === 0x61 // a
  ) {
    return 'image/gif';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A — 8 bytes.
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP: "RIFF" at 0..3, "WEBP" at 8..11, chunk type at 12..15.
  // VP8 (lossy) = "VP8 ", VP8L (lossless) = "VP8L", VP8X (extended) = "VP8X".
  if (
    buf.length >= 16 &&
    buf[0] === 0x52 && // R
    buf[1] === 0x49 && // I
    buf[2] === 0x46 && // F
    buf[3] === 0x46 && // F
    buf[8] === 0x57 && // W
    buf[9] === 0x45 && // E
    buf[10] === 0x42 && // B
    buf[11] === 0x50 && // P
    buf[12] === 0x56 && // V
    buf[13] === 0x50 && // P
    buf[14] === 0x38 && // 8
    (buf[15] === 0x20 || buf[15] === 0x4c || buf[15] === 0x58) // ' ' | L | X
  ) {
    return 'image/webp';
  }

  return null;
}
