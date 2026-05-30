// Single source of truth for attachment / model-payload size caps.
//
// Created for the PDF page-rasterization feature (plan:
// pdf-page-rasterization-plan.md, T3). Before this file the caps were
// scattered — upload caps in `attachment-extraction.ts`, native-PDF
// document caps in `context-loader.ts` — and the webapp kept its own
// (drifted) copies. Co-locating them here lets the Worker and the
// webapp import one definition instead of re-deriving values that fall
// out of sync (Codex #11).
//
// Importable from both the Worker bundle (`../../shared/attachment-caps.js`)
// and the webapp (`../../../../src/shared/attachment-caps.js`), so the
// client rasterizer and the server validator agree on the raster caps
// with no duplication.

// ── Upload caps (re-exported from attachment-extraction.ts) ──────────
// Hard server-side limits on a single uploaded file. The webapp shows a
// friendlier client-side limit before upload; see the KNOWN DRIFT note
// at the bottom of this file.

/** Max bytes for a non-image attachment (PDF, docx, …) the server accepts. */
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25 MB
/** Max bytes for an image attachment the server accepts. */
export const MAX_IMAGE_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB
/** Max attachments per chat message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

// ── Native-PDF document caps (re-exported from context-loader.ts) ────
// Govern the EXISTING native `document` block path (Claude / Codex),
// which sends the PDF's bytes (text layer + page imagery) to the model.
// Unchanged by the rasterization feature; co-located here so the new
// raster caps below can be reasoned about against them.

// Per-source raw byte cap on PDF documents auto-attached or @-ref'd onto
// a user turn. 12 MiB raw expands to ~16 MB base64 string + ~16 MB
// JSON.stringify materialization, leaving headroom against the Anthropic
// 32 MB total-request-payload cap and the Cloudflare Workers 128 MB
// per-isolate heap (shared across concurrent requests). Codex review
// flagged the prior 16 MB plan as too aggressive — see
// ~/.claude/plans/pdf-vision-plan.md D3.
export const MAX_PDF_DOCUMENT_BYTES = 12 * 1024 * 1024;

// Maximum number of PDFs auto-attached per turn before @-ref bypass.
// Start conservative at 1 to keep cost + heap predictable; lift later
// once production telemetry confirms safe room.
export const MAX_AUTO_ATTACH_PDF_COUNT = 1;

// Cumulative cap across ALL PDF document blocks attached on one turn
// (auto + @-ref forced). Hard ceiling against the Anthropic 32 MB
// total-request-payload limit and the Cloudflare Workers 128 MB
// per-isolate heap. PR #439 shipped the per-source cap but missed this
// cumulative one — @-ref'd second PDF could push 2 × 12 MiB raw to
// ~32 MiB base64 + JSON.stringify materialization → isolate killed →
// queue retry-storm. PDFs that don't fit fall back to text injection
// (with a manifest note explaining why) instead of attaching. Measured
// on RAW source bytes.
export const MAX_TOTAL_PDF_PAYLOAD_BYTES = 24 * 1024 * 1024;

// ── PDF page-raster caps (new) ───────────────────────────────────────
// Govern the NEW page-image path: vision-but-not-PDF models
// (gpt-5-mini, gemini-2.5-flash, kimi-k2.6) receive rasterized page
// JPEGs + the extracted text. The webapp renders pages with pdf.js and
// uploads them one per request; the Worker validates and stores them.

/**
 * Max page images rasterized + stored per PDF source. A v1 cap — the
 * retained `extracted_text` still carries content beyond this many
 * pages, so a long PDF is not silently truncated, only its page imagery
 * is bounded. Enforced at the upload endpoint (page_index must be
 * `< MAX_RASTER_PAGES`) and honored by the webapp renderer.
 */
export const MAX_RASTER_PAGES = 20;

/**
 * Max bytes for a single stored page JPEG (raw, pre-base64). Tighter
 * than `MAX_IMAGE_ATTACHMENT_SIZE` because a page rendered at
 * `RASTER_RENDER_SCALE` / `RASTER_JPEG_QUALITY` is far smaller than an
 * arbitrary user-uploaded image; a page over this cap signals a
 * pathological render and is rejected per-page at the endpoint.
 */
export const MAX_RASTER_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Cumulative ceiling on the page images attached to ONE model turn,
 * measured on the **base64 / JSON-encoded** size that actually goes on
 * the wire (Codex #6) — not the raw bytes — because that is what counts
 * against a provider's request-body limit. 16 MB encoded stays under
 * Gemini's ~20 MB inline-request limit with headroom for the retained
 * `extracted_text` and request overhead. The consumer attaches pages in
 * order until this budget is exhausted, then notes the truncation in the
 * manifest. (Contrast `MAX_TOTAL_PDF_PAYLOAD_BYTES`, which is on raw
 * bytes for the native-document path.)
 */
export const MAX_TOTAL_RASTER_PAYLOAD_BYTES = 16 * 1024 * 1024; // 16 MB encoded

/** Estimate base64-encoded size from raw byte length (~4/3 + padding). */
export function encodedSizeBytes(rawByteLength: number): number {
  return Math.ceil(rawByteLength / 3) * 4;
}

// ── Render settings (consumed by the webapp pdf.js rasterizer) ───────

/**
 * pdf.js render scale (viewport multiplier). ~1.5× balances legibility
 * of small text/figures for the vision model against page JPEG size.
 */
export const RASTER_RENDER_SCALE = 1.5;

/** JPEG quality for rendered pages (0..1). ~0.82 keeps text crisp while compressing. */
export const RASTER_JPEG_QUALITY = 0.82;

// ── KNOWN DRIFT — reconcile in Lane C (webapp) ───────────────────────
// webapp/src/pages/TalkDetailPage.tsx defines its OWN upload limits that
// diverge from the server caps above:
//   webapp MAX_ATTACHMENT_SIZE       = 10 MB  (server: 25 MB)
//   webapp MAX_IMAGE_ATTACHMENT_SIZE =  5 MB  (server: 10 MB)
// The webapp is the stricter client-side pre-check. Pointing it at these
// shared constants changes the client-enforced limit (a product-facing
// behavior change), so it is intentionally deferred to the webapp lane
// rather than bundled into this backend contract change.
