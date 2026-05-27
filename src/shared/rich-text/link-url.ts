// Link URL normalization. Allows http, https, mailto only — the plan
// constraint from design review (sanitizer policy: no javascript:, no
// data:, no file:). Adapted from rocketboard with two changes:
//   - 'tel:' dropped (clawtalk has no telephony surface in v1)
//   - returns '' for unsafe inputs; callers treat '' as "drop the link
//     mark entirely" (same convention as the rocketboard original).

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const EXPLICIT_LINK_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const RELATIVE_LINK_PATTERN = /^(\/|#|\?|\.\/|\.\.\/)/;

export function normalizeRichTextLinkUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('//')) {
    return normalizeRichTextLinkUrl(`https:${trimmed}`);
  }

  if (RELATIVE_LINK_PATTERN.test(trimmed)) {
    return '';
  }

  const candidate = EXPLICIT_LINK_SCHEME_PATTERN.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    if (!SAFE_LINK_PROTOCOLS.has(parsed.protocol)) return '';
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.hostname
    ) {
      return '';
    }
    if (parsed.protocol === 'mailto:' && !parsed.pathname) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function isAllowedRichTextLinkUrl(value: string): boolean {
  return normalizeRichTextLinkUrl(value).length > 0;
}

// Image-src normalizer. Permits the same http/https schemes as the link
// normalizer PLUS `data:image/*` so inline screenshots paste from the
// clipboard without an upload round-trip. Anything else is rejected by
// returning '' — the caller drops the image node entirely.
//
// `data:` is allowed only when the media-type starts with `image/` so a
// pasted `data:text/html` payload can't smuggle markup into the editor.
const SAFE_IMAGE_DATA_MIME_RE =
  /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml|avif)(;[^,]*)?,/i;

export function normalizeRichTextImageSrc(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  // data: URIs are explicitly allowed for image MIME types only.
  if (trimmed.toLowerCase().startsWith('data:')) {
    return SAFE_IMAGE_DATA_MIME_RE.test(trimmed) ? trimmed : '';
  }

  // For http(s), reuse the link normalizer but loosen mailto rejection
  // (irrelevant for images anyway — mailto: as image src would be
  // dropped by the URL parser). Relative URLs are still rejected because
  // ClawTalk doesn't serve images from its own origin yet.
  return normalizeRichTextLinkUrl(trimmed);
}

export function isAllowedRichTextImageSrc(value: string): boolean {
  return normalizeRichTextImageSrc(value).length > 0;
}
