// Tests for the link-url normalizers — guards on data URL MIME tightening
// (svg+xml + avif must be rejected) and the same-origin content-image
// path exception added for T3 of the R2 content-image upload work.

import { describe, expect, it } from 'vitest';

import {
  isAllowedRichTextImageSrc,
  isAllowedRichTextLinkUrl,
  normalizeRichTextImageSrc,
  normalizeRichTextLinkUrl,
} from './link-url.js';

describe('normalizeRichTextLinkUrl', () => {
  it('accepts http / https / mailto', () => {
    expect(normalizeRichTextLinkUrl('https://example.com')).toBe(
      'https://example.com/',
    );
    expect(normalizeRichTextLinkUrl('http://example.com/x')).toBe(
      'http://example.com/x',
    );
    expect(normalizeRichTextLinkUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
  });

  it('upgrades protocol-relative // to https', () => {
    expect(normalizeRichTextLinkUrl('//cdn.example.com/x')).toBe(
      'https://cdn.example.com/x',
    );
  });

  it('rejects javascript: and data: and relative paths', () => {
    expect(normalizeRichTextLinkUrl('javascript:alert(1)')).toBe('');
    expect(normalizeRichTextLinkUrl('data:text/html,<script>')).toBe('');
    expect(normalizeRichTextLinkUrl('/relative')).toBe('');
    expect(normalizeRichTextLinkUrl('./relative')).toBe('');
    expect(normalizeRichTextLinkUrl('#anchor')).toBe('');
  });
});

describe('normalizeRichTextImageSrc — data: URLs', () => {
  const VALID_MIMES = ['png', 'jpeg', 'jpg', 'gif', 'webp'];

  for (const mime of VALID_MIMES) {
    it(`accepts data:image/${mime}`, () => {
      const url = `data:image/${mime};base64,iVBORw0KG`;
      expect(normalizeRichTextImageSrc(url)).toBe(url);
    });

    it(`accepts data:image/${mime} with #cu-… fragment`, () => {
      const url = `data:image/${mime};base64,iVBORw0KG#cu-abc123def456`;
      expect(normalizeRichTextImageSrc(url)).toBe(url);
    });

    it(`accepts data:image/${mime} with #cf-… fragment`, () => {
      const url = `data:image/${mime};base64,iVBORw0KG#cf-abc123def456`;
      expect(normalizeRichTextImageSrc(url)).toBe(url);
    });
  }

  it('rejects data:image/svg+xml (XSS risk)', () => {
    expect(normalizeRichTextImageSrc('data:image/svg+xml;utf8,<svg/>')).toBe(
      '',
    );
    expect(
      normalizeRichTextImageSrc('data:image/svg+xml;base64,PHN2Zy8+'),
    ).toBe('');
  });

  it('rejects data:image/avif (not in upload allowlist)', () => {
    expect(normalizeRichTextImageSrc('data:image/avif;base64,AAAA')).toBe('');
  });

  it('rejects data:text/html', () => {
    expect(
      normalizeRichTextImageSrc('data:text/html,<script>alert(1)</script>'),
    ).toBe('');
  });
});

describe('normalizeRichTextImageSrc — content-image path', () => {
  const HASH = 'a'.repeat(32);

  it('accepts /api/v1/content-images/<32hex>.<ext>', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
      const url = `/api/v1/content-images/${HASH}.${ext}`;
      expect(normalizeRichTextImageSrc(url)).toBe(url);
    }
  });

  it('accepts path with #cu-… fragment', () => {
    const url = `/api/v1/content-images/${HASH}.png#cu-abc123def456`;
    expect(normalizeRichTextImageSrc(url)).toBe(url);
  });

  it('accepts path with #cf-… fragment', () => {
    const url = `/api/v1/content-images/${HASH}.png#cf-abc123def456`;
    expect(normalizeRichTextImageSrc(url)).toBe(url);
  });

  it('accepts path with bare # sentinel', () => {
    const url = `/api/v1/content-images/${HASH}.png#`;
    expect(normalizeRichTextImageSrc(url)).toBe(url);
  });

  it('rejects wrong hash length', () => {
    expect(
      normalizeRichTextImageSrc(`/api/v1/content-images/${'a'.repeat(31)}.png`),
    ).toBe('');
    expect(
      normalizeRichTextImageSrc(`/api/v1/content-images/${'a'.repeat(33)}.png`),
    ).toBe('');
  });

  it('rejects non-hex hash chars', () => {
    expect(
      normalizeRichTextImageSrc(`/api/v1/content-images/${'z'.repeat(32)}.png`),
    ).toBe('');
  });

  it('rejects disallowed extensions', () => {
    for (const ext of ['svg', 'avif', 'bmp', 'tiff', '']) {
      expect(
        normalizeRichTextImageSrc(`/api/v1/content-images/${HASH}.${ext}`),
      ).toBe('');
    }
  });

  it('rejects path with query string', () => {
    expect(
      normalizeRichTextImageSrc(`/api/v1/content-images/${HASH}.png?x=1`),
    ).toBe('');
  });

  it('rejects unrelated relative paths', () => {
    expect(normalizeRichTextImageSrc('/api/v1/talks/foo')).toBe('');
    expect(normalizeRichTextImageSrc('/relative.png')).toBe('');
  });
});

describe('normalizeRichTextImageSrc — http(s) fallthrough', () => {
  it('accepts absolute https URLs (including absolute content-image URL)', () => {
    expect(normalizeRichTextImageSrc('https://example.com/x.png')).toBe(
      'https://example.com/x.png',
    );
    const HASH = 'b'.repeat(32);
    expect(
      normalizeRichTextImageSrc(
        `https://clawtalk.app/api/v1/content-images/${HASH}.png`,
      ),
    ).toBe(`https://clawtalk.app/api/v1/content-images/${HASH}.png`);
  });

  it('rejects javascript: image src', () => {
    expect(normalizeRichTextImageSrc('javascript:alert(1)')).toBe('');
  });
});

describe('isAllowed* boolean wrappers', () => {
  it('isAllowedRichTextLinkUrl reflects normalizer non-empty result', () => {
    expect(isAllowedRichTextLinkUrl('https://x.com')).toBe(true);
    expect(isAllowedRichTextLinkUrl('javascript:alert(1)')).toBe(false);
  });

  it('isAllowedRichTextImageSrc reflects normalizer non-empty result', () => {
    expect(isAllowedRichTextImageSrc('data:image/png;base64,iVBORw0KG')).toBe(
      true,
    );
    expect(isAllowedRichTextImageSrc('data:image/svg+xml,<svg/>')).toBe(false);
  });
});
