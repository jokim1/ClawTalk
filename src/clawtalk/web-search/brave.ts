/**
 * web-search/brave.ts
 *
 * Adapter for Brave Search's Web Search API
 * (https://brave.com/search/api/). Brave runs its own independent
 * web index and is meaningfully cheaper than the alternatives at
 * volume.
 *
 * Endpoint: GET {baseUrl}/res/v1/web/search?q=...&count=...
 * Headers:  X-Subscription-Token: <api_key>
 * Response:
 *   { web: { results: [{ title, url, description, age? }] } }
 */

import { WebSearchError, type WebSearchAdapter } from './types.js';

const BRAVE_BASE_URL = 'https://api.search.brave.com';
const DEFAULT_MAX_RESULTS = 5;
const HARD_CAP_RESULTS = 10;

export const braveSearch: WebSearchAdapter = async (apiKey, query, options) => {
  const maxResults = Math.min(
    HARD_CAP_RESULTS,
    Math.max(1, options?.maxResults ?? DEFAULT_MAX_RESULTS),
  );

  const url = new URL(`${BRAVE_BASE_URL}/res/v1/web/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(maxResults));

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
    signal: options?.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new WebSearchError(
      `Brave search failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      'web_search.brave',
      response.status,
    );
  }

  const payload = (await response.json()) as {
    web?: {
      results?: Array<{
        title?: unknown;
        url?: unknown;
        description?: unknown;
        age?: unknown;
      }>;
    };
  };

  const raw = Array.isArray(payload.web?.results) ? payload.web!.results : [];
  return raw
    .map((r) => ({
      title: typeof r.title === 'string' ? r.title : '',
      url: typeof r.url === 'string' ? r.url : '',
      snippet: typeof r.description === 'string' ? r.description : undefined,
      publishedAt: typeof r.age === 'string' ? r.age : undefined,
    }))
    .filter((r) => r.url);
};
