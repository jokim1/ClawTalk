/**
 * web-search/tavily.ts
 *
 * Adapter for Tavily's search API (https://docs.tavily.com).
 * Tavily is purpose-built for LLM workflows — results carry both a
 * one-paragraph snippet and (optionally) extracted full-page content.
 *
 * Endpoint: POST {baseUrl}/search
 *   { api_key, query, max_results, search_depth: 'basic' }
 * Response:
 *   { results: [{ title, url, content, score, published_date? }] }
 */

import { WebSearchError, type WebSearchAdapter } from './types.js';

const TAVILY_BASE_URL = 'https://api.tavily.com';
const DEFAULT_MAX_RESULTS = 5;
const HARD_CAP_RESULTS = 10;

export const tavilySearch: WebSearchAdapter = async (
  apiKey,
  query,
  options,
) => {
  const maxResults = Math.min(
    HARD_CAP_RESULTS,
    Math.max(1, options?.maxResults ?? DEFAULT_MAX_RESULTS),
  );

  const response = await fetch(`${TAVILY_BASE_URL}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: false,
    }),
    signal: options?.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new WebSearchError(
      `Tavily search failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      'web_search.tavily',
      response.status,
    );
  }

  const payload = (await response.json()) as {
    results?: Array<{
      title?: unknown;
      url?: unknown;
      content?: unknown;
      score?: unknown;
      published_date?: unknown;
    }>;
  };

  const raw = Array.isArray(payload.results) ? payload.results : [];
  return raw
    .map((r) => ({
      title: typeof r.title === 'string' ? r.title : '',
      url: typeof r.url === 'string' ? r.url : '',
      snippet: typeof r.content === 'string' ? r.content : undefined,
      score: typeof r.score === 'number' ? r.score : undefined,
      publishedAt:
        typeof r.published_date === 'string' ? r.published_date : undefined,
    }))
    .filter((r) => r.url);
};
