import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  TALK_CONTEXT_BROWSER_DISABLE_HOSTS: [],
  TALK_CONTEXT_BROWSER_PREFER_HOSTS: ['substack.com'],
  TALK_CONTEXT_BROWSER_TIMEOUT_MS: 30_000,
  TALK_CONTEXT_MANAGED_FETCH_ENABLED: false,
  TALK_CONTEXT_MANAGED_FETCH_TIMEOUT_MS: 30_000,
}));

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { ingestUrlSource, SourceIngestionError } from './source-ingestion.js';

describe('source-ingestion', () => {
  const updateExtraction = vi.fn();

  beforeEach(() => {
    updateExtraction.mockReset();
  });

  it('stores HTTP extraction when the fast path is good enough', async () => {
    const httpFetcher = vi.fn().mockResolvedValue({
      body: '<html><body><main>' + 'A'.repeat(800) + '</main></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://example.com/post',
    });
    const browserFetcher = {
      fetch: vi.fn(),
    };

    await ingestUrlSource('source-1', 'https://example.com/post', {
      httpFetcher,
      browserFetcher,
      updateExtraction,
    });

    expect(browserFetcher.fetch).not.toHaveBeenCalled();
    expect(updateExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-1',
        extractionError: null,
        fetchStrategy: 'http',
        mimeType: 'text/html',
      }),
    );
  });

  it('prefers the browser path for Substack URLs even after HTTP success', async () => {
    const httpFetcher = vi.fn().mockResolvedValue({
      body:
        '<html><body><article>' + 'B'.repeat(1200) + '</article></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://example.substack.com/p/test-post',
    });
    const browserFetcher = {
      fetch: vi.fn().mockResolvedValue({
        finalUrl: 'https://example.substack.com/p/test-post',
        pageTitle: 'Substack Post',
        extractedText: 'Browser extracted article body',
        contentType: 'text/html' as const,
        strategy: 'browser' as const,
      }),
    };

    await ingestUrlSource(
      'source-2',
      'https://example.substack.com/p/test-post',
      {
        httpFetcher,
        browserFetcher,
        updateExtraction,
      },
    );

    expect(browserFetcher.fetch).toHaveBeenCalledTimes(1);
    expect(updateExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-2',
        extractionError: null,
        fetchStrategy: 'browser',
      }),
    );
  });

  it('falls back to the browser path after HTTP fetch failures', async () => {
    const httpFetcher = vi
      .fn()
      .mockRejectedValue(
        new SourceIngestionError(
          'fetch_http_error',
          'HTTP 403 from https://example.com/article',
        ),
      );
    const browserFetcher = {
      fetch: vi.fn().mockResolvedValue({
        finalUrl: 'https://example.com/article',
        pageTitle: 'Recovered',
        extractedText: 'Recovered in browser',
        contentType: 'text/html' as const,
        strategy: 'browser' as const,
      }),
    };

    await ingestUrlSource('source-3', 'https://example.com/article', {
      httpFetcher,
      browserFetcher,
      updateExtraction,
    });

    expect(browserFetcher.fetch).toHaveBeenCalledTimes(1);
    expect(updateExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-3',
        extractionError: null,
        fetchStrategy: 'browser',
      }),
    );
  });

  it('keeps useful HTTP content when browser fallback fails', async () => {
    const httpFetcher = vi.fn().mockResolvedValue({
      body:
        '<html><body><article>' + 'C'.repeat(1200) + '</article></body></html>',
      contentType: 'text/html',
      finalUrl: 'https://example.substack.com/p/fallback',
    });
    const browserFetcher = {
      fetch: vi
        .fn()
        .mockRejectedValue(new Error('Browser container unavailable')),
    };

    await ingestUrlSource(
      'source-4',
      'https://example.substack.com/p/fallback',
      {
        httpFetcher,
        browserFetcher,
        updateExtraction,
      },
    );

    expect(browserFetcher.fetch).toHaveBeenCalledTimes(1);
    expect(updateExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-4',
        extractionError: null,
        fetchStrategy: 'http',
      }),
    );
  });

  it('stores a failure when all ingestion tiers fail', async () => {
    const httpFetcher = vi
      .fn()
      .mockRejectedValue(
        new SourceIngestionError('fetch_error', 'Network down'),
      );
    const browserFetcher = {
      fetch: vi.fn().mockRejectedValue(new Error('Browser failed')),
    };

    await ingestUrlSource('source-5', 'https://example.com/post', {
      httpFetcher,
      browserFetcher,
      updateExtraction,
    });

    expect(updateExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-5',
        extractedText: null,
        fetchStrategy: 'browser',
      }),
    );
    const payload = updateExtraction.mock.calls[0][0] as {
      extractionError: string;
    };
    expect(payload.extractionError).toContain(
      'http: fetch_error: Network down',
    );
    expect(payload.extractionError).toContain('browser: Browser failed');
  });
});
