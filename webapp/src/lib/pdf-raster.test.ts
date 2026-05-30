import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { uploadSourcePageImage } from './api';
import { isRasterizablePdf, renderAndUploadPdfPages } from './pdf-raster';

function jpegBlob(tag: string): Blob {
  return new Blob([tag], { type: 'image/jpeg' });
}

describe('renderAndUploadPdfPages', () => {
  it('uploads each rendered page in order with the right index, total, and blob', async () => {
    const blobs = [jpegBlob('p0'), jpegBlob('p1'), jpegBlob('p2')];
    const upload = vi
      .fn()
      .mockResolvedValue({ uploaded: 0, expected: 3, complete: false });

    const result = await renderAndUploadPdfPages({
      talkId: 'talk-1',
      sourceId: 'src-1',
      data: new ArrayBuffer(8),
      rasterize: async () => blobs,
      upload,
    });

    expect(result).toEqual({ pagesUploaded: 3, pagesTotal: 3 });
    expect(upload).toHaveBeenCalledTimes(3);
    // Assert the actual parts of each upload, not merely that a call happened.
    expect(upload.mock.calls.map((c) => c[0].pageIndex)).toEqual([0, 1, 2]);
    expect(upload.mock.calls.map((c) => c[0].jpeg)).toEqual(blobs);
    for (const [arg] of upload.mock.calls) {
      expect(arg.talkId).toBe('talk-1');
      expect(arg.sourceId).toBe('src-1');
      expect(arg.totalPages).toBe(3); // every page carries the same N
    }
  });

  it('reports progress after each uploaded page', async () => {
    const progress: Array<[number, number]> = [];
    await renderAndUploadPdfPages({
      talkId: 't',
      sourceId: 's',
      data: new ArrayBuffer(0),
      rasterize: async () => [jpegBlob('a'), jpegBlob('b')],
      upload: vi
        .fn()
        .mockResolvedValue({ uploaded: 0, expected: 2, complete: false }),
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('uploads nothing and returns 0/0 when no pages render', async () => {
    const upload = vi.fn();
    const result = await renderAndUploadPdfPages({
      talkId: 't',
      sourceId: 's',
      data: new ArrayBuffer(0),
      rasterize: async () => [],
      upload,
    });
    expect(result).toEqual({ pagesUploaded: 0, pagesTotal: 0 });
    expect(upload).not.toHaveBeenCalled();
  });

  it('propagates a mid-sequence upload failure (set left incomplete ⇒ text-only)', async () => {
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ uploaded: 0, expected: 3, complete: false })
      .mockRejectedValueOnce(new Error('network'));
    await expect(
      renderAndUploadPdfPages({
        talkId: 't',
        sourceId: 's',
        data: new ArrayBuffer(0),
        rasterize: async () => [jpegBlob('a'), jpegBlob('b'), jpegBlob('c')],
        upload,
      }),
    ).rejects.toThrow('network');
    // Stopped after the failing second page — the third was never attempted.
    expect(upload).toHaveBeenCalledTimes(2);
  });
});

describe('uploadSourcePageImage (request shape)', () => {
  let cookieValue = 'cr_csrf_token=test-csrf';
  beforeEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => cookieValue,
      set: (value: string) => {
        cookieValue = value;
      },
    });
    cookieValue = 'cr_csrf_token=test-csrf';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('POSTs one raw JPEG to /page-images/:index?total=N with CSRF', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: { uploaded: 1, expected: 4, complete: false },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const jpeg = jpegBlob('bytes');
    const result = await uploadSourcePageImage({
      talkId: 'talk 1',
      sourceId: 'src-1',
      pageIndex: 2,
      totalPages: 4,
      jpeg,
    });

    expect(result).toEqual({ uploaded: 1, expected: 4, complete: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      '/api/v1/talks/talk%201/context/sources/src-1/page-images/2?total=4',
    );
    expect(init.method).toBe('POST');
    expect(init.body).toBe(jpeg);
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('image/jpeg');
    expect(headers.get('x-csrf-token')).toBe('test-csrf');
  });
});

describe('isRasterizablePdf', () => {
  it('is true only for application/pdf', () => {
    expect(isRasterizablePdf('application/pdf')).toBe(true);
    expect(isRasterizablePdf('image/png')).toBe(false);
    expect(isRasterizablePdf('text/plain')).toBe(false);
    expect(isRasterizablePdf(null)).toBe(false);
  });
});
