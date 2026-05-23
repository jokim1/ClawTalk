/**
 * web-search/exa.ts
 *
 * Adapter for Exa's search API (https://exa.ai/docs/reference/search).
 * Exa is a neural search engine purpose-built for LLM workflows — we
 * request `contents.highlights` so each result includes a few short
 * relevance-ranked snippets instead of full page text (which would
 * blow the model's context budget).
 *
 * Endpoint: POST {baseUrl}/search
 * Headers:  x-api-key: <api_key>
 *           Content-Type: application/json
 * Body:     { query, numResults, type: 'auto', contents: { highlights: true } }
 * Response:
 *   { results: [{ title, url, highlights?: string[], publishedDate?, ... }] }
 */

import { WebSearchError, type WebSearchAdapter } from './types.js';

const EXA_BASE_URL = 'https://api.exa.ai';
const DEFAULT_MAX_RESULTS = 5;
const HARD_CAP_RESULTS = 10;

export const exaSearch: WebSearchAdapter = async (apiKey, query, options) => {
  const numResults = Math.min(
    HARD_CAP_RESULTS,
    Math.max(1, options?.maxResults ?? DEFAULT_MAX_RESULTS),
  );

  const response = await fetch(`${EXA_BASE_URL}/search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      query,
      numResults,
      type: 'auto',
      contents: { highlights: true },
    }),
    signal: options?.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new WebSearchError(
      `Exa search failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      'web_search.exa',
      response.status,
    );
  }

  const payload = (await response.json()) as {
    results?: Array<{
      title?: unknown;
      url?: unknown;
      highlights?: unknown;
      summary?: unknown;
      text?: unknown;
      publishedDate?: unknown;
      score?: unknown;
    }>;
  };

  const raw = Array.isArray(payload.results) ? payload.results : [];
  return raw
    .map((r) => {
      const snippet = pickSnippet(r);
      return {
        title: typeof r.title === 'string' ? r.title : '',
        url: typeof r.url === 'string' ? r.url : '',
        snippet,
        score: typeof r.score === 'number' ? r.score : undefined,
        publishedAt:
          typeof r.publishedDate === 'string' ? r.publishedDate : undefined,
      };
    })
    .filter((r) => r.url);
};

function pickSnippet(r: {
  highlights?: unknown;
  summary?: unknown;
  text?: unknown;
}): string | undefined {
  if (Array.isArray(r.highlights)) {
    const joined = r.highlights
      .filter((h): h is string => typeof h === 'string' && h.length > 0)
      .join(' … ');
    if (joined) return joined;
  }
  if (typeof r.summary === 'string' && r.summary.length > 0) return r.summary;
  if (typeof r.text === 'string' && r.text.length > 0) {
    return r.text.length > 500 ? `${r.text.slice(0, 500)}…` : r.text;
  }
  return undefined;
}
