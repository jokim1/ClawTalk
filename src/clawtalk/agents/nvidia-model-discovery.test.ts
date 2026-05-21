import { describe, expect, it, vi } from 'vitest';

import {
  discoverNvidiaModels,
  invalidateNvidiaDiscovery,
  type DiscoveryCacheLike,
} from './nvidia-model-discovery.js';

// ---------------------------------------------------------------------------
// Map-backed Cache fake. Honors `cache-control: max-age=N` so we can simulate
// the production TTL policy (success 1h, never auth_error, 60s unavailable,
// 5min rate_limited).
// ---------------------------------------------------------------------------
function makeFakeCache(now: () => number = () => Date.now()): {
  cache: DiscoveryCacheLike;
  size: () => number;
  advance: (ms: number) => void;
  current: number;
} {
  const store = new Map<string, { body: string; expiresAt: number }>();
  let nowOverride = now();
  return {
    cache: {
      async match(key: string) {
        const entry = store.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= nowOverride) {
          store.delete(key);
          return undefined;
        }
        return new Response(entry.body, {
          headers: { 'content-type': 'application/json' },
        });
      },
      async put(key: string, response: Response) {
        const cc = response.headers.get('cache-control') || '';
        const m = /max-age=(\d+)/.exec(cc);
        const maxAge = m ? parseInt(m[1], 10) : 0;
        const body = await response.text();
        if (maxAge <= 0) {
          // Effectively a delete — store with already-expired sentinel.
          store.set(key, { body, expiresAt: nowOverride - 1 });
          return;
        }
        store.set(key, { body, expiresAt: nowOverride + maxAge * 1000 });
      },
    },
    size: () => store.size,
    advance: (ms: number) => {
      nowOverride += ms;
    },
    get current() {
      return nowOverride;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('discoverNvidiaModels', () => {
  it('returns parsed models on success', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: 'moonshotai/kimi-k2.6' },
          { id: 'meta/llama-3.3-70b-instruct' },
        ],
      }),
    );
    const result = await discoverNvidiaModels('nvapi-test', { fetcher });
    expect(result.status).toBe('ok');
    expect(result.models.map((m) => m.modelId)).toEqual([
      'moonshotai/kimi-k2.6',
      'meta/llama-3.3-70b-instruct',
    ]);
  });

  it('serves a cache hit without re-fetching', async () => {
    const { cache } = makeFakeCache();
    const fetcher = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'moonshotai/kimi-k2.6' }] }),
    );
    await discoverNvidiaModels('nvapi-test', { cache, fetcher });
    await discoverNvidiaModels('nvapi-test', { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache auth_error so the user gets immediate feedback on key fix', async () => {
    const { cache, size } = makeFakeCache();
    const fetcher = vi.fn(async () => jsonResponse({}, 401));
    const result = await discoverNvidiaModels('nvapi-bad', { cache, fetcher });
    expect(result.status).toBe('auth_error');
    expect(size()).toBe(0);

    // Second call should re-fetch (no cache entry blocking it).
    await discoverNvidiaModels('nvapi-bad', { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('treats 403 as auth_error', async () => {
    const fetcher = vi.fn(async () => jsonResponse({}, 403));
    const result = await discoverNvidiaModels('nvapi-bad', { fetcher });
    expect(result.status).toBe('auth_error');
  });

  it('caches 429 rate_limited for 5 minutes', async () => {
    const { cache, advance } = makeFakeCache();
    const fetcher = vi.fn(async () => jsonResponse({}, 429));
    await discoverNvidiaModels('nvapi-test', { cache, fetcher });

    advance(4 * 60 * 1000); // still within TTL
    await discoverNvidiaModels('nvapi-test', { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);

    advance(2 * 60 * 1000); // now past 5 min
    await discoverNvidiaModels('nvapi-test', { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('caches network errors (unavailable) for 60s', async () => {
    const { cache, advance } = makeFakeCache();
    const fetcher = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const result = await discoverNvidiaModels('nvapi-test', { cache, fetcher });
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('socket hang up');

    advance(30 * 1000);
    await discoverNvidiaModels('nvapi-test', { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);

    advance(40 * 1000); // now past 60s
    await discoverNvidiaModels('nvapi-test', { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports timeout as unavailable when the request is aborted', async () => {
    const fetcher = vi.fn(
      async (_url: unknown, init?: { signal?: AbortSignal }) => {
        // Simulate hang until aborted.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      },
    );
    const result = await discoverNvidiaModels('nvapi-test', {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.status).toBe('unavailable');
    expect(result.message).toMatch(/timed out/i);
  }, 10_000);

  it('returns ok with empty models for an empty response', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: [] }));
    const result = await discoverNvidiaModels('nvapi-test', { fetcher });
    expect(result.status).toBe('ok');
    expect(result.models).toEqual([]);
  });

  it('filters non-chat models (embeddings, rerankers, asr, guards, tts)', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: 'moonshotai/kimi-k2.6' },
          { id: 'nvidia/nv-embedqa-e5-v5' },
          { id: 'nvidia/llama-3.2-nv-rerankqa-1b-v2' },
          { id: 'nvidia/parakeet-ctc-1.1b-asr' },
          { id: 'nvidia/llama-3.1-nemoguard-8b-content-safety' },
          { id: 'meta/llama-3.3-70b-instruct' },
        ],
      }),
    );
    const result = await discoverNvidiaModels('nvapi-test', { fetcher });
    expect(result.models.map((m) => m.modelId)).toEqual([
      'moonshotai/kimi-k2.6',
      'meta/llama-3.3-70b-instruct',
    ]);
  });

  it('isolates cache entries per API key (workspace isolation)', async () => {
    const { cache } = makeFakeCache();
    const fetcherA = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'moonshotai/kimi-k2.6' }] }),
    );
    const fetcherB = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'meta/llama-3.3-70b-instruct' }] }),
    );
    const resA = await discoverNvidiaModels('nvapi-workspace-A', {
      cache,
      fetcher: fetcherA,
    });
    const resB = await discoverNvidiaModels('nvapi-workspace-B', {
      cache,
      fetcher: fetcherB,
    });
    expect(resA.models[0].modelId).toBe('moonshotai/kimi-k2.6');
    expect(resB.models[0].modelId).toBe('meta/llama-3.3-70b-instruct');
    // Each key got its own fetch.
    expect(fetcherA).toHaveBeenCalledTimes(1);
    expect(fetcherB).toHaveBeenCalledTimes(1);
  });

  it('returns auth_error early for an empty API key without a fetch', async () => {
    const fetcher = vi.fn();
    const result = await discoverNvidiaModels('', {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.status).toBe('auth_error');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('invalidateNvidiaDiscovery', () => {
  it('forces the next call to re-fetch after invalidation', async () => {
    const { cache } = makeFakeCache();
    const fetcher = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'moonshotai/kimi-k2.6' }] }),
    );
    await discoverNvidiaModels('nvapi-test', { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await invalidateNvidiaDiscovery('nvapi-test', cache);

    await discoverNvidiaModels('nvapi-test', { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('no-ops when no cache is provided', async () => {
    await expect(
      invalidateNvidiaDiscovery('nvapi-test', null),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration test against the real NVIDIA endpoint. Skipped unless
// NVIDIA_TEST_KEY is set so CI stays hermetic.
// ---------------------------------------------------------------------------
const NVIDIA_TEST_KEY = process.env.NVIDIA_TEST_KEY;

describe.skipIf(!NVIDIA_TEST_KEY)(
  'discoverNvidiaModels [integration: real NVIDIA endpoint]',
  () => {
    it('returns a non-empty model list with kimi-k2.6 present', async () => {
      const result = await discoverNvidiaModels(NVIDIA_TEST_KEY!);
      expect(result.status).toBe('ok');
      expect(result.models.length).toBeGreaterThan(0);
      const ids = result.models.map((m) => m.modelId);
      // Kimi 2.6 is the curated default we ship; if NVIDIA ever drops it
      // we need to know.
      expect(ids).toContain('moonshotai/kimi-k2.6');
    }, 15_000);
  },
);
