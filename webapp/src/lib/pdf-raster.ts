// Client-side PDF page rasterization.
//
// Cloudflare Worker isolates have no canvas, so PDFs destined for
// vision-but-not-PDF models (gpt-5-mini, gemini-2.5-flash, kimi-k2.6)
// are rasterized in the browser with pdf.js and uploaded one JPEG per
// page to the Lane A endpoint. The Worker only ever serves bytes it
// already has. See ~/.claude/plans/pdf-page-rasterization-plan.md.
//
// Two layers:
//   - rasterizePdfToJpegBlobs(): the pdf.js render (lazy-loaded; only
//     reached in a real browser — unit tests mock it out).
//   - renderAndUploadPdfPages(): the testable orchestration that takes
//     rendered blobs and uploads them in order; `rasterize`/`upload`
//     are injectable seams so the upload sequence can be asserted
//     without standing up pdf.js or a network.

import {
  MAX_RASTER_PAGES,
  RASTER_JPEG_QUALITY,
  RASTER_RENDER_SCALE,
} from '../../../src/shared/attachment-caps.js';
import { uploadSourcePageImage } from './api';

export type RasterUploadResult = {
  pagesUploaded: number;
  pagesTotal: number;
};

type RenderCanvas =
  | { kind: 'offscreen'; canvas: OffscreenCanvas }
  | { kind: 'dom'; canvas: HTMLCanvasElement };

/**
 * Prefer OffscreenCanvas (off the main thread, no DOM attach); fall back
 * to a detached <canvas> for browsers without it (older Safari — Codex #9).
 */
function createRenderCanvas(
  width: number,
  height: number,
): {
  surface: RenderCanvas;
  context: CanvasRenderingContext2D;
} {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      return {
        surface: { kind: 'offscreen', canvas },
        // pdf.js accepts an OffscreenCanvas 2D context; the DOM and
        // offscreen 2D context APIs it uses are identical.
        context: ctx as unknown as CanvasRenderingContext2D,
      };
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('pdf-raster: 2D canvas context unavailable');
  }
  return { surface: { kind: 'dom', canvas }, context: ctx };
}

async function canvasToJpegBlob(
  surface: RenderCanvas,
  quality: number,
): Promise<Blob> {
  if (surface.kind === 'offscreen') {
    return surface.canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    surface.canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error('pdf-raster: canvas.toBlob returned null')),
      'image/jpeg',
      quality,
    );
  });
}

/**
 * Render up to MAX_RASTER_PAGES pages of a PDF to JPEG blobs. pdf.js (and
 * its worker) are lazy-imported so the ~1 MB library never lands in the
 * initial bundle. Throws if the PDF can't be parsed — the caller treats a
 * throw as "0 pages, stay text-only + show a notice".
 */
export async function rasterizePdfToJpegBlobs(
  data: ArrayBuffer,
  opts?: { maxPages?: number; scale?: number; quality?: number },
): Promise<Blob[]> {
  const maxPages = opts?.maxPages ?? MAX_RASTER_PAGES;
  const scale = opts?.scale ?? RASTER_RENDER_SCALE;
  const quality = opts?.quality ?? RASTER_JPEG_QUALITY;

  const pdfjs = await import('pdfjs-dist');
  // Vite rewrites the `?url` import to the emitted worker asset URL;
  // pdf.js spins up the worker from it.
  const workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url'))
    .default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data) });
  const pdf = await loadingTask.promise;
  try {
    const pageCount = Math.min(pdf.numPages, maxPages);
    const blobs: Blob[] = [];
    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      const page = await pdf.getPage(pageNum);
      try {
        const viewport = page.getViewport({ scale });
        const { surface, context } = createRenderCanvas(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        // `canvas: null` → pdf.js uses `canvasContext.canvas`, which works
        // for both an OffscreenCanvas and a DOM <canvas> 2D context.
        await page.render({ canvasContext: context, canvas: null, viewport })
          .promise;
        blobs.push(await canvasToJpegBlob(surface, quality));
      } finally {
        page.cleanup();
      }
    }
    return blobs;
  } finally {
    await pdf.cleanup();
    await loadingTask.destroy();
  }
}

/**
 * Render a PDF's pages and upload each JPEG in order to the page-images
 * endpoint. The set is "complete" only when every page lands, so a mid-
 * sequence failure leaves the source text-only (count < N) rather than a
 * truncated page run — the error propagates to the caller, which surfaces
 * a visible notice. `rasterize` and `upload` are injectable for tests.
 */
export async function renderAndUploadPdfPages(args: {
  talkId: string;
  sourceId: string;
  data: ArrayBuffer;
  onProgress?: (pagesDone: number, pagesTotal: number) => void;
  rasterize?: (data: ArrayBuffer) => Promise<Blob[]>;
  upload?: typeof uploadSourcePageImage;
}): Promise<RasterUploadResult> {
  const rasterize = args.rasterize ?? rasterizePdfToJpegBlobs;
  const upload = args.upload ?? uploadSourcePageImage;

  const blobs = await rasterize(args.data);
  const pagesTotal = blobs.length;
  if (pagesTotal === 0) return { pagesUploaded: 0, pagesTotal: 0 };

  let pagesUploaded = 0;
  for (let i = 0; i < blobs.length; i++) {
    await upload({
      talkId: args.talkId,
      sourceId: args.sourceId,
      pageIndex: i,
      totalPages: pagesTotal,
      jpeg: blobs[i],
    });
    pagesUploaded += 1;
    args.onProgress?.(pagesUploaded, pagesTotal);
  }
  return { pagesUploaded, pagesTotal };
}

/** True for sources we should rasterize on upload (PDFs only). */
export function isRasterizablePdf(mimeType: string | null): boolean {
  return mimeType === 'application/pdf';
}
