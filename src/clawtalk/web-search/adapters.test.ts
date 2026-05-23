import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { braveSearch } from './brave.js';
import { exaSearch } from './exa.js';
import { firecrawlSearch } from './firecrawl.js';
import { tavilySearch } from './tavily.js';
import { WebSearchError } from './types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type FetchMock = ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

function mockFetchOnce(response: {
  ok: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}): FetchMock {
  const status = response.status ?? (response.ok ? 200 : 500);
  const mock = vi.fn().mockResolvedValue({
    ok: response.ok,
    status,
    json: async () => response.json ?? {},
    text: async () => response.text ?? '',
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tavily
// ---------------------------------------------------------------------------

describe('tavilySearch', () => {
  it('POSTs to /search with the api key in body and parses results', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      json: {
        results: [
          {
            title: 'Foo',
            url: 'https://example.com/foo',
            content: 'Foo snippet',
            score: 0.9,
            published_date: '2026-01-01',
          },
          {
            title: 'Bar',
            url: 'https://example.com/bar',
            content: 'Bar snippet',
          },
        ],
      },
    });

    const results = await tavilySearch('tvly-test', 'hello world');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.tavily.com/search');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      api_key: 'tvly-test',
      query: 'hello world',
      search_depth: 'basic',
      include_answer: false,
    });
    expect(results).toEqual([
      {
        title: 'Foo',
        url: 'https://example.com/foo',
        snippet: 'Foo snippet',
        score: 0.9,
        publishedAt: '2026-01-01',
      },
      {
        title: 'Bar',
        url: 'https://example.com/bar',
        snippet: 'Bar snippet',
        score: undefined,
        publishedAt: undefined,
      },
    ]);
  });

  it('clamps max_results to the hard cap of 10', async () => {
    const fetchMock = mockFetchOnce({ ok: true, json: { results: [] } });
    await tavilySearch('k', 'q', { maxResults: 9999 });
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.max_results).toBe(10);
  });

  it('drops result objects without a url', async () => {
    mockFetchOnce({
      ok: true,
      json: { results: [{ title: 'no url' }, { url: 'https://ok.com' }] },
    });
    const results = await tavilySearch('k', 'q');
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://ok.com');
  });

  it('throws WebSearchError with status code and trimmed body on 4xx/5xx', async () => {
    mockFetchOnce({
      ok: false,
      status: 401,
      text: 'invalid api key',
    });
    await expect(tavilySearch('bad', 'q')).rejects.toMatchObject({
      name: 'WebSearchError',
      providerId: 'web_search.tavily',
      statusCode: 401,
      message: expect.stringContaining('401'),
    });
  });
});

// ---------------------------------------------------------------------------
// Brave
// ---------------------------------------------------------------------------

describe('braveSearch', () => {
  it('sends X-Subscription-Token header and parses web.results', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      json: {
        web: {
          results: [
            {
              title: 'Hit',
              url: 'https://brave.example/x',
              description: 'description text',
              age: '2 days ago',
            },
          ],
        },
      },
    });

    const results = await braveSearch('BSA-test', 'cats');

    const [url, init] = fetchMock.mock.calls[0];
    expect(
      (url as string).startsWith(
        'https://api.search.brave.com/res/v1/web/search',
      ),
    ).toBe(true);
    expect(url as string).toContain('q=cats');
    expect(url as string).toContain('count=5');
    expect((init as RequestInit).method).toBe('GET');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['X-Subscription-Token']).toBe('BSA-test');
    expect(results).toEqual([
      {
        title: 'Hit',
        url: 'https://brave.example/x',
        snippet: 'description text',
        publishedAt: '2 days ago',
      },
    ]);
  });

  it('returns empty array when web.results is missing', async () => {
    mockFetchOnce({ ok: true, json: { web: {} } });
    const results = await braveSearch('k', 'q');
    expect(results).toEqual([]);
  });

  it('throws WebSearchError on non-2xx', async () => {
    mockFetchOnce({ ok: false, status: 429, text: 'rate limited' });
    await expect(braveSearch('k', 'q')).rejects.toMatchObject({
      providerId: 'web_search.brave',
      statusCode: 429,
    });
  });
});

// ---------------------------------------------------------------------------
// Firecrawl
// ---------------------------------------------------------------------------

describe('firecrawlSearch', () => {
  it('sends Bearer auth and parses the namespaced data.web shape', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      json: {
        success: true,
        data: {
          web: [
            {
              title: 'FC Hit',
              url: 'https://fc.example/y',
              description: 'fc desc',
            },
          ],
        },
      },
    });

    const results = await firecrawlSearch('fc-test', 'docs');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.firecrawl.dev/v1/search');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer fc-test');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ query: 'docs', limit: 5 });
    expect(results).toEqual([
      {
        title: 'FC Hit',
        url: 'https://fc.example/y',
        snippet: 'fc desc',
      },
    ]);
  });

  it('also accepts the legacy flat data array shape', async () => {
    mockFetchOnce({
      ok: true,
      json: {
        success: true,
        data: [
          {
            title: 'Legacy',
            url: 'https://legacy.example/x',
            description: 'legacy snippet',
          },
        ],
      },
    });
    const results = await firecrawlSearch('k', 'q');
    expect(results).toEqual([
      {
        title: 'Legacy',
        url: 'https://legacy.example/x',
        snippet: 'legacy snippet',
      },
    ]);
  });

  it('throws WebSearchError on auth failure', async () => {
    mockFetchOnce({ ok: false, status: 403, text: 'forbidden' });
    await expect(firecrawlSearch('k', 'q')).rejects.toMatchObject({
      providerId: 'web_search.firecrawl',
      statusCode: 403,
    });
  });
});

// ---------------------------------------------------------------------------
// Exa
// ---------------------------------------------------------------------------

describe('exaSearch', () => {
  it('POSTs to /search with x-api-key header and parses highlights into snippet', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      json: {
        results: [
          {
            title: 'Exa Hit',
            url: 'https://exa.example/a',
            highlights: ['first highlight', 'second highlight'],
            publishedDate: '2026-02-14',
            score: 0.42,
          },
          {
            title: 'No Highlights',
            url: 'https://exa.example/b',
          },
        ],
      },
    });

    const results = await exaSearch('exa-test', 'neural search');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.exa.ai/search');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('exa-test');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      query: 'neural search',
      numResults: 5,
      type: 'auto',
      contents: { highlights: true },
    });
    expect(results).toEqual([
      {
        title: 'Exa Hit',
        url: 'https://exa.example/a',
        snippet: 'first highlight … second highlight',
        score: 0.42,
        publishedAt: '2026-02-14',
      },
      {
        title: 'No Highlights',
        url: 'https://exa.example/b',
        snippet: undefined,
        score: undefined,
        publishedAt: undefined,
      },
    ]);
  });

  it('falls back to summary when highlights are missing', async () => {
    mockFetchOnce({
      ok: true,
      json: {
        results: [
          {
            title: 'Sum',
            url: 'https://exa.example/sum',
            summary: 'a one-line summary',
          },
        ],
      },
    });
    const results = await exaSearch('k', 'q');
    expect(results[0].snippet).toBe('a one-line summary');
  });

  it('clamps numResults to the hard cap of 10', async () => {
    const fetchMock = mockFetchOnce({ ok: true, json: { results: [] } });
    await exaSearch('k', 'q', { maxResults: 9999 });
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.numResults).toBe(10);
  });

  it('drops result objects without a url', async () => {
    mockFetchOnce({
      ok: true,
      json: { results: [{ title: 'no url' }, { url: 'https://ok.com' }] },
    });
    const results = await exaSearch('k', 'q');
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://ok.com');
  });

  it('throws WebSearchError with status code on 4xx/5xx', async () => {
    mockFetchOnce({ ok: false, status: 401, text: 'invalid api key' });
    await expect(exaSearch('bad', 'q')).rejects.toMatchObject({
      name: 'WebSearchError',
      providerId: 'web_search.exa',
      statusCode: 401,
      message: expect.stringContaining('401'),
    });
  });
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

describe('WebSearchError', () => {
  it('carries provider id + status code', () => {
    const err = new WebSearchError('boom', 'web_search.tavily', 500);
    expect(err.name).toBe('WebSearchError');
    expect(err.providerId).toBe('web_search.tavily');
    expect(err.statusCode).toBe(500);
  });
});
