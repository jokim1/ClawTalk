// Failed-upload "broken image" icon for the ContentImageUploaderPlugin.
//
// Must be a `data:image/png;base64,…` URL so the link-url sanitizer
// (src/shared/rich-text/link-url.ts) accepts it as a valid image src
// — the same-origin /api/v1/content-images/<hash>.<ext> path won't
// work because the image was never uploaded.
//
// v1 placeholder: a tiny 1×1 transparent PNG. T14 will replace this
// with a hand-designed 24×24 "broken image" glyph (~500 bytes).

export const FAILED_ICON_SRC =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
