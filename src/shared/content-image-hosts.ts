// Server-side host allowlist for rehosting external images into the
// CONTENT_IMAGES R2 bucket. The upload route fetches a sourceUrl ONLY
// when the URL's host is in this set; otherwise it returns 403
// `source_host_not_allowed`. Frontend-only allowlists are easy to
// bypass — this is the security boundary.
//
// **T13 empirical finding (2026-05-27):** A real Google Docs paste
// embeds inline images as `data:image/png;base64,…` URLs in the HTML
// clipboard payload, NOT as external `lh3-6.googleusercontent.com`
// URLs. So the dataUrl branch of POST /api/v1/content-images handles
// the Google Docs paste case natively, and the allowlist can stay
// empty for v1.
//
// Other paste sources (Drive-linked images, browser tab → editor
// paste from a third-party site) may still use http(s) URLs. Add
// hosts to REHOST_HOST_ALLOWLIST as those cases come up — empirically,
// not by guess. While the set is empty the sourceUrl branch returns
// 403 for every host, which is the correct fail-closed default.

export const REHOST_HOST_ALLOWLIST: ReadonlySet<string> = new Set<string>();

export function isRehostHostAllowed(host: string): boolean {
  return REHOST_HOST_ALLOWLIST.has(host.toLowerCase());
}
