/**
 * web-search/types.ts
 *
 * Shared types for the pluggable web-search backend. Each provider
 * adapter implements `search(query, opts) → WebSearchResult[]`; the
 * registry resolves the user's active provider + credential and
 * dispatches.
 *
 * The result shape is deliberately minimal: title, url, optional
 * snippet, optional published date. Anything more (raw HTML, page
 * screenshots, citations) belongs in a dedicated tool — this one
 * is the "search engine substitute" surface for agents.
 */

export type WebSearchProviderId =
  | 'web_search.tavily'
  | 'web_search.brave'
  | 'web_search.firecrawl';

export interface WebSearchOptions {
  /** Soft cap on results returned to the model. Providers may return fewer. */
  maxResults?: number;
  /** AbortSignal forwarded to the underlying fetch. */
  signal?: AbortSignal;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  score?: number;
}

export interface WebSearchResponse {
  query: string;
  providerId: WebSearchProviderId;
  results: WebSearchResult[];
}

export class WebSearchError extends Error {
  constructor(
    message: string,
    public readonly providerId: WebSearchProviderId,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'WebSearchError';
  }
}

/**
 * Adapter contract: a stateless function that takes (apiKey, query,
 * options) and returns normalized results. Adapters MUST NOT cache,
 * persist, or mutate global state — the registry handles credential
 * resolution + dispatch.
 */
export type WebSearchAdapter = (
  apiKey: string,
  query: string,
  options?: WebSearchOptions,
) => Promise<WebSearchResult[]>;
