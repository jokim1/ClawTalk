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
// normalizer PLUS `data:image/*` (for clipboard pastes pre-upload) PLUS
// the same-origin `/api/v1/content-images/<hash>.<ext>` path served by
// the Worker after upload. Anything else returns '' so the caller drops
// the image node.
//
// `data:` is allowed only for raster image types we accept on upload —
// svg+xml carries XSS risk (inline <script>) and avif isn't in the
// upload MIME allowlist, so both are excluded here as well.
const SAFE_IMAGE_DATA_MIME_RE =
  /^data:image\/(png|jpeg|jpg|gif|webp)(;[^,]*)?,/i;

// Same-origin content-image path. Hash is 32 hex chars (sha256 first 16
// bytes), extension is one of the upload-allowed raster types. An
// optional URL fragment is preserved verbatim so the ProseMirror
// uploader plugin's `#cu-…` / `#cf-…` upload-state markers round-trip
// through the sanitizer.
const CONTENT_IMAGE_PATH_RE =
  /^\/api\/v1\/content-images\/[a-f0-9]{32}\.(png|jpe?g|gif|webp)(#.*)?$/i;

export function normalizeRichTextImageSrc(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  if (trimmed.toLowerCase().startsWith('data:')) {
    return SAFE_IMAGE_DATA_MIME_RE.test(trimmed) ? trimmed : '';
  }

  if (CONTENT_IMAGE_PATH_RE.test(trimmed)) {
    return trimmed;
  }

  // http(s) absolute URLs (including absolute content-image URLs on
  // clawtalk.app) fall through to the link normalizer. All other
  // relative paths are rejected.
  return normalizeRichTextLinkUrl(trimmed);
}

export function isAllowedRichTextImageSrc(value: string): boolean {
  return normalizeRichTextImageSrc(value).length > 0;
}
