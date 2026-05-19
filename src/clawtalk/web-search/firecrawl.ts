/**
 * web-search/firecrawl.ts
 *
 * Adapter for Firecrawl's `/search` endpoint
 * (https://docs.firecrawl.dev/features/search). Firecrawl combines
 * search + scrape — results include both a snippet and (optionally)
 * markdown for the page. We surface the snippet only; agents that
 * want full content can paste the URL into a second tool call later.
 *
 * Endpoint: POST {baseUrl}/v1/search
 * Headers:  Authorization: Bearer <api_key>
 *           Content-Type: application/json
 * Body:     { query, limit }
 * Response (web variant):
 *   { success: true, data: { web: [{ title, url, description }] } }
 * Older payload shape (still served by some accounts):
 *   { success: true, data: [{ title, url, description }] }
 */

import { WebSearchError, type WebSearchAdapter } from './types.js';

const FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev';
const DEFAULT_MAX_RESULTS = 5;
const HARD_CAP_RESULTS = 10;

export const firecrawlSearch: WebSearchAdapter = async (
  apiKey,
  query,
  options,
) => {
  const limit = Math.min(
    HARD_CAP_RESULTS,
    Math.max(1, options?.maxResults ?? DEFAULT_MAX_RESULTS),
  );

  const response = await fetch(`${FIRECRAWL_BASE_URL}/v1/search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, limit }),
    signal: options?.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new WebSearchError(
      `Firecrawl search failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      'web_search.firecrawl',
      response.status,
    );
  }

  const payload = (await response.json()) as {
    success?: boolean;
    data?:
      | Array<{ title?: unknown; url?: unknown; description?: unknown }>
      | {
          web?: Array<{
            title?: unknown;
            url?: unknown;
            description?: unknown;
          }>;
        };
  };

  // Accept both the legacy flat `data: []` and the newer namespaced
  // `data: { web: [] }` shapes so the adapter doesn't break when
  // Firecrawl ships a backend update.
  const rawList = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.data?.web)
      ? payload.data!.web!
      : [];

  return rawList
    .map((r) => ({
      title: typeof r.title === 'string' ? r.title : '',
      url: typeof r.url === 'string' ? r.url : '',
      snippet: typeof r.description === 'string' ? r.description : undefined,
    }))
    .filter((r) => r.url);
};
