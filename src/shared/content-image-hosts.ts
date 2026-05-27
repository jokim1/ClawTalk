// Server-side host allowlist for rehosting external images into the
// CONTENT_IMAGES R2 bucket. The upload route fetches a sourceUrl ONLY
// when the URL's host is in this set; otherwise it returns 403
// `source_host_not_allowed`. Frontend-only allowlists are easy to bypass
// — this is the security boundary.
//
// The allowlist is intentionally empty pending T13 (capture a real
// Google Docs paste fixture and identify the actual image-host
// subdomains). Until T13 lands, the sourceUrl branch of POST
// /api/v1/content-images returns 403 for all hosts, leaving dataUrl
// paste as the only working path. That degrades cleanly — pastes from
// the system clipboard still work; pasting from Google Docs falls back
// to the original Google-hosted URL in the document.
//
// To extend after T13: add hosts (or wildcards like `*.googleusercontent.com`)
// to REHOST_HOST_ALLOWLIST and update isRehostHostAllowed to match.

export const REHOST_HOST_ALLOWLIST: ReadonlySet<string> = new Set<string>();

export function isRehostHostAllowed(host: string): boolean {
  return REHOST_HOST_ALLOWLIST.has(host.toLowerCase());
}
