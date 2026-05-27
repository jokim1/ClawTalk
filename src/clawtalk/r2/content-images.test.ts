// Tests for the content-images R2 helper. No network; bucket calls
// are exercised against a stub that mirrors the narrow
// ContentImagesBucket interface.

import { describe, expect, it } from 'vitest';

import {
  buildKey,
  type ContentImagesBucket,
  type ContentImagesObjectBody,
  deriveContentType,
  detectMime,
  getContentImage,
  putContentImage,
} from './content-images.js';

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
      const body: ContentImagesObjectBody = {
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
      return body;
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

describe('buildKey', () => {
  it('joins hash + ext under the ci/ prefix', () => {
    expect(buildKey('deadbeef', 'png')).toBe('ci/deadbeef.png');
    expect(buildKey('a'.repeat(32), 'webp')).toBe(`ci/${'a'.repeat(32)}.webp`);
  });
});

describe('deriveContentType', () => {
  it('maps known extensions to image MIMEs', () => {
    expect(deriveContentType('ci/abc.png')).toBe('image/png');
    expect(deriveContentType('ci/abc.jpg')).toBe('image/jpeg');
    expect(deriveContentType('ci/abc.jpeg')).toBe('image/jpeg');
    expect(deriveContentType('ci/abc.gif')).toBe('image/gif');
    expect(deriveContentType('ci/abc.webp')).toBe('image/webp');
  });

  it('is case-insensitive on the extension', () => {
    expect(deriveContentType('ci/abc.PNG')).toBe('image/png');
    expect(deriveContentType('ci/abc.JPG')).toBe('image/jpeg');
  });

  it('returns null for unknown extensions', () => {
    expect(deriveContentType('ci/abc.svg')).toBeNull();
    expect(deriveContentType('ci/abc.avif')).toBeNull();
    expect(deriveContentType('ci/abc.bmp')).toBeNull();
    expect(deriveContentType('ci/abc.')).toBeNull();
  });

  it('returns null when there is no dot in the key', () => {
    expect(deriveContentType('abc')).toBeNull();
  });
});

describe('detectMime — positive cases', () => {
  it('detects PNG magic bytes', () => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00,
    ]);
    expect(detectMime(bytes)).toBe('image/png');
  });

  it('detects JPEG magic bytes', () => {
    expect(
      detectMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])),
    ).toBe('image/jpeg');
  });

  it('detects GIF87a', () => {
    expect(
      detectMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00])),
    ).toBe('image/gif');
  });

  it('detects GIF89a', () => {
    expect(
      detectMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00])),
    ).toBe('image/gif');
  });

  function webpHeader(chunkType: [number, number, number, number]): Uint8Array {
    return new Uint8Array([
      // "RIFF"
      0x52,
      0x49,
      0x46,
      0x46,
      // size (placeholder)
      0x00,
      0x00,
      0x00,
      0x00,
      // "WEBP"
      0x57,
      0x45,
      0x42,
      0x50,
      // chunk type (VP8 / VP8L / VP8X)
      ...chunkType,
    ]);
  }

  it('detects WebP VP8 (lossy)', () => {
    expect(detectMime(webpHeader([0x56, 0x50, 0x38, 0x20]))).toBe('image/webp');
  });

  it('detects WebP VP8L (lossless)', () => {
    expect(detectMime(webpHeader([0x56, 0x50, 0x38, 0x4c]))).toBe('image/webp');
  });

  it('detects WebP VP8X (extended)', () => {
    expect(detectMime(webpHeader([0x56, 0x50, 0x38, 0x58]))).toBe('image/webp');
  });
});

describe('detectMime — negative cases', () => {
  it('returns null for empty buffer', () => {
    expect(detectMime(new Uint8Array(0))).toBeNull();
  });

  it('returns null for 1-byte buffer', () => {
    expect(detectMime(new Uint8Array([0x89]))).toBeNull();
  });

  it('returns null for truncated PNG (4 bytes only)', () => {
    expect(detectMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('returns null for plain text (even labelled image/png by caller)', () => {
    expect(
      detectMime(new TextEncoder().encode('this is plain text not an image')),
    ).toBeNull();
  });

  it('returns null for SVG markup', () => {
    expect(
      detectMime(new TextEncoder().encode('<svg xmlns="...">')),
    ).toBeNull();
  });

  it('returns null for AVIF (ftypAVIF box — not in allowlist)', () => {
    // ISO-BMFF: 4 bytes size + "ftyp" + "avif" — we explicitly don't
    // match this, so the upload route can 400.
    const avif = new Uint8Array([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
    ]);
    expect(detectMime(avif)).toBeNull();
  });

  it('returns null for a RIFF container that is NOT WebP', () => {
    // RIFF + "WAVE" instead of "WEBP"
    expect(
      detectMime(
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56,
          0x45, 0x66, 0x6d, 0x74, 0x20,
        ]),
      ),
    ).toBeNull();
  });

  it('returns null for WebP magic without a recognised chunk type', () => {
    // RIFF + WEBP + "XYZ?" chunk type — should be rejected.
    expect(
      detectMime(
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42,
          0x50, 0x58, 0x59, 0x5a, 0x3f,
        ]),
      ),
    ).toBeNull();
  });
});

describe('putContentImage', () => {
  it('writes to ci/<32hex>.<ext> with content-type', async () => {
    const { bucket, stored } = makeStubBucket();
    const bytes = new TextEncoder().encode('fake-png-bytes');
    const result = await putContentImage(bucket, bytes, 'image/png');

    expect(result.key).toMatch(/^ci\/[a-f0-9]{32}\.png$/);
    expect(result.httpEtag).toBeTruthy();
    const stash = stored.get(result.key);
    expect(stash?.contentType).toBe('image/png');
    expect(stash?.bytes).toEqual(bytes);
  });

  it('uses jpg (not jpeg) in the key for image/jpeg', async () => {
    const { bucket } = makeStubBucket();
    const result = await putContentImage(
      bucket,
      new Uint8Array([1, 2, 3]),
      'image/jpeg',
    );
    expect(result.key).toMatch(/\.jpg$/);
  });

  it('is content-addressed — identical bytes → identical key', async () => {
    const { bucket } = makeStubBucket();
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const a = await putContentImage(bucket, bytes, 'image/png');
    const b = await putContentImage(bucket, bytes, 'image/png');
    expect(a.key).toBe(b.key);
  });

  it('different MIME → different ext → different key', async () => {
    const { bucket } = makeStubBucket();
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const png = await putContentImage(bucket, bytes, 'image/png');
    const webp = await putContentImage(bucket, bytes, 'image/webp');
    expect(png.key).not.toBe(webp.key);
    expect(png.key.replace(/\.png$/, '')).toBe(webp.key.replace(/\.webp$/, ''));
  });
});

describe('getContentImage', () => {
  it('returns null when the key is missing', async () => {
    const { bucket } = makeStubBucket();
    expect(await getContentImage(bucket, 'ci/missing.png')).toBeNull();
  });

  it('returns the body for a key written by putContentImage', async () => {
    const { bucket } = makeStubBucket();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { key } = await putContentImage(bucket, bytes, 'image/gif');
    const obj = await getContentImage(bucket, key);
    expect(obj).not.toBeNull();
    expect(obj?.httpMetadata?.contentType).toBe('image/gif');
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(bytes);
  });
});
