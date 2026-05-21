/**
 * nvidia-model-discovery.ts
 *
 * Live discovery of chat-capable models from the NVIDIA NIM catalog
 * (https://integrate.api.nvidia.com/v1/models). Surfaces alongside the
 * curated `llm_provider_models` rows so users with a configured NVIDIA key
 * can pick any model their catalog exposes, not just what we hardcoded.
 *
 * Caching:
 *   success     → 1 hour
 *   auth_error  → never cached (so the user gets immediate feedback when
 *                 they fix their key)
 *   unavailable → 60s (transient network/timeout, brief backoff so we don't
 *                 hammer NVIDIA during outages)
 *   rate_limited→ 5 min (respect 429 with longer backoff)
 *
 * Cache backend is injectable. Production passes `caches.default`
 * (Cloudflare Workers Cache API). Tests pass a Map-backed fake. When the
 * cache is null/undefined, every call is a live fetch.
 *
 * Cache key uses an SHA-256 fingerprint of the API key (first 16 hex chars).
 * This keeps workspace-scoped credentials isolated from each other while
 * never logging the raw key.
 */

const NVIDIA_MODELS_URL = 'https://integrate.api.nvidia.com/v1/models';
const FETCH_TIMEOUT_MS = 5_000;
const TTL_SUCCESS_S = 3_600;
const TTL_UNAVAILABLE_S = 60;
const TTL_RATE_LIMITED_S = 5 * 60;

// Heuristic blocklist for non-chat models. NVIDIA's /v1/models endpoint
// returns embedding, reranker, ASR, TTS, vision-encoder, and safety
// classifier models alongside chat-capable LLMs without a capability field.
// Filter conservatively — false-positive (showing a non-chat model) is worse
// than false-negative (hiding a chat model the user can re-add via a future
// curated row). Tokens are matched as case-insensitive substrings on the
// model id.
const NON_CHAT_ID_TOKENS = [
  'embed',
  'embedding',
  'rerank',
  'reranker',
  'guard',
  'nemoguard',
  'asr',
  'parakeet',
  'tts',
  'audio',
  'vision-encoder',
  'speaker',
] as const;

export type DiscoveryStatus =
  | 'ok'
  | 'auth_error'
  | 'unavailable'
  | 'rate_limited';

export interface DiscoveredModel {
  modelId: string;
}

export interface DiscoveryResult {
  models: DiscoveredModel[];
  status: DiscoveryStatus;
  message?: string;
}

/**
 * Structural subset of the Cloudflare Workers Cache API we depend on. Lets
 * tests pass a Map-backed fake without pulling @cloudflare/workers-types
 * into the project tsconfig.
 */
export interface DiscoveryCacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

export interface DiscoveryOptions {
  cache?: DiscoveryCacheLike | null;
  fetcher?: typeof fetch;
}

interface CachedPayload {
  result: DiscoveryResult;
  cachedAt: number;
}

async function fingerprintApiKey(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function buildCacheKey(apiKey: string): Promise<string> {
  const fp = await fingerprintApiKey(apiKey);
  return `https://nvidia-discovery.internal/models?fp=${fp}`;
}

function isChatCapable(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return !NON_CHAT_ID_TOKENS.some((token) => lower.includes(token));
}

interface NvidiaModelsResponse {
  data?: Array<{ id?: string }>;
}

function parseModelsPayload(raw: unknown): DiscoveredModel[] {
  const payload = raw as NvidiaModelsResponse;
  if (!payload || !Array.isArray(payload.data)) return [];
  return payload.data
    .map((entry) => entry?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .filter(isChatCapable)
    .map((modelId) => ({ modelId }));
}

async function readFromCache(
  cache: DiscoveryCacheLike,
  cacheKey: string,
): Promise<DiscoveryResult | undefined> {
  const hit = await cache.match(cacheKey);
  if (!hit) return undefined;
  try {
    const payload = (await hit.json()) as CachedPayload;
    return payload.result;
  } catch {
    return undefined;
  }
}

async function writeToCache(
  cache: DiscoveryCacheLike,
  cacheKey: string,
  result: DiscoveryResult,
  ttlSeconds: number,
): Promise<void> {
  const payload: CachedPayload = { result, cachedAt: Date.now() };
  const response = new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${ttlSeconds}`,
    },
  });
  await cache.put(cacheKey, response);
}

export async function discoverNvidiaModels(
  apiKey: string,
  opts: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  if (!apiKey) {
    return {
      models: [],
      status: 'auth_error',
      message: 'No NVIDIA API key configured.',
    };
  }

  const cache = opts.cache ?? null;
  const fetcher = opts.fetcher ?? fetch;
  const cacheKey = cache ? await buildCacheKey(apiKey) : '';

  if (cache) {
    const cached = await readFromCache(cache, cacheKey);
    if (cached) return cached;
  }

  const result = await fetchNvidiaModels(apiKey, fetcher);

  if (cache) {
    const ttl = ttlForStatus(result.status);
    if (ttl > 0) {
      await writeToCache(cache, cacheKey, result, ttl);
    }
  }

  return result;
}

function ttlForStatus(status: DiscoveryStatus): number {
  switch (status) {
    case 'ok':
      return TTL_SUCCESS_S;
    case 'rate_limited':
      return TTL_RATE_LIMITED_S;
    case 'unavailable':
      return TTL_UNAVAILABLE_S;
    case 'auth_error':
      return 0;
  }
}

async function fetchNvidiaModels(
  apiKey: string,
  fetcher: typeof fetch,
): Promise<DiscoveryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetcher(NVIDIA_MODELS_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return {
        models: [],
        status: 'auth_error',
        message:
          'NVIDIA API key was rejected. Generate a new key at build.nvidia.com.',
      };
    }
    if (response.status === 429) {
      return {
        models: [],
        status: 'rate_limited',
        message: 'NVIDIA rate limit hit. Retrying in a few minutes.',
      };
    }
    if (!response.ok) {
      return {
        models: [],
        status: 'unavailable',
        message: `NVIDIA /v1/models returned ${response.status}.`,
      };
    }

    const payload = (await response.json()) as unknown;
    return { models: parseModelsPayload(payload), status: 'ok' };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        models: [],
        status: 'unavailable',
        message: `NVIDIA /v1/models timed out after ${FETCH_TIMEOUT_MS}ms.`,
      };
    }
    return {
      models: [],
      status: 'unavailable',
      message: err instanceof Error ? err.message : 'NVIDIA fetch failed.',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drop the cached discovery for a given API key. Called from the credential
 * save route so a user who updates their NVIDIA key sees fresh results on
 * the next provider-card load.
 *
 * The Cloudflare Cache API doesn't expose a public delete, but writing a
 * zero-TTL entry achieves the same effect (the cached response immediately
 * fails the max-age check).
 */
export async function invalidateNvidiaDiscovery(
  apiKey: string,
  cache: DiscoveryCacheLike | null | undefined,
): Promise<void> {
  if (!cache || !apiKey) return;
  const cacheKey = await buildCacheKey(apiKey);
  const expired = new Response('{}', {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=0',
    },
  });
  await cache.put(cacheKey, expired);
}
