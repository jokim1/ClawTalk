import { describe, expect, it } from 'vitest';

import {
  MAX_RASTER_IMAGE_BYTES,
  MAX_RASTER_PAGES,
  MAX_TOTAL_RASTER_PAYLOAD_BYTES,
  RASTER_JPEG_QUALITY,
  RASTER_RENDER_SCALE,
  encodedSizeBytes,
} from './attachment-caps.js';

describe('encodedSizeBytes', () => {
  it('matches the exact base64 character count (4 * ceil(n/3))', () => {
    expect(encodedSizeBytes(0)).toBe(0);
    expect(encodedSizeBytes(1)).toBe(4); // 1 byte -> "XX==" (4 chars)
    expect(encodedSizeBytes(3)).toBe(4); // 3 bytes -> 4 chars, no padding
    expect(encodedSizeBytes(4)).toBe(8); // 4 bytes -> 8 chars
    expect(encodedSizeBytes(6)).toBe(8);
  });

  it('inflates raw size by roughly 4/3', () => {
    const raw = 3 * 1024 * 1024;
    const encoded = encodedSizeBytes(raw);
    expect(encoded).toBeGreaterThan(raw);
    // ~1.33x, allow a small band for the ceil/padding.
    expect(encoded / raw).toBeGreaterThan(1.3);
    expect(encoded / raw).toBeLessThan(1.4);
  });
});

describe('raster cap invariants', () => {
  it('caps are ordered so a single page fits well under the turn budget', () => {
    expect(MAX_RASTER_PAGES).toBeGreaterThan(0);
    expect(MAX_RASTER_IMAGE_BYTES).toBeGreaterThan(0);
    // A single page (even encoded) must be far below the cumulative cap,
    // otherwise even one page could blow the turn budget.
    expect(encodedSizeBytes(MAX_RASTER_IMAGE_BYTES)).toBeLessThan(
      MAX_TOTAL_RASTER_PAYLOAD_BYTES,
    );
  });

  it('render settings are in the expected ranges', () => {
    expect(RASTER_RENDER_SCALE).toBeGreaterThan(1);
    expect(RASTER_JPEG_QUALITY).toBeGreaterThan(0);
    expect(RASTER_JPEG_QUALITY).toBeLessThanOrEqual(1);
  });
});
