// TanStack Query client + IDB-backed persister for the webapp. Persists
// snapshot caches across reloads so a returning user gets a sub-100ms
// warm-cache first paint when they reopen a Talk they've recently
// visited. Cache lifetime is bounded by `gcTime` (24h) — entries older
// than that are dropped on next mount, and the persister itself drops
// stale buster keys on bump.

import { QueryClient } from '@tanstack/react-query';
import type {
  PersistedClient,
  Persister,
} from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';

const IDB_KEY = 'clawtalk.tanstack-query.v1';

// Bump this string whenever the snapshot wire format changes in a way
// that would make older cached entries incorrect to render. The
// PersistQueryClientProvider compares it and silently drops mismatched
// caches on hydration.
export const QUERY_CACHE_BUSTER = 'snapshot-v1';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cache must outlive the persistence window or persisted entries
      // get garbage-collected before they're restored. 24h matches the
      // upstream PersistQueryClientProvider example.
      gcTime: 1000 * 60 * 60 * 24,
      // Snapshots are kept fresh by WS deltas and reconnect-invalidate.
      // No need to refetch on every focus/mount.
      staleTime: 1000 * 60 * 5,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export function createIDBPersister(): Persister {
  return {
    persistClient: async (client: PersistedClient) => {
      await set(IDB_KEY, client);
    },
    restoreClient: async () => {
      return (await get<PersistedClient>(IDB_KEY)) ?? undefined;
    },
    removeClient: async () => {
      await del(IDB_KEY);
    },
  };
}

export const idbPersister = createIDBPersister();

// Called from the auth-logout flow so a different user signing in on
// the same device can't see the previous user's cached snapshots.
// Per-user queryKey prefix already prevents accidental cross-user reads
// across reloads, but clearing IDB on logout is the belt-and-braces
// move that also drops MRU residue for privacy.
export async function clearPersistedQueryCache(): Promise<void> {
  queryClient.clear();
  // Best-effort: never let a cache-clear failure break sign-out. IndexedDB
  // can be unavailable (private browsing, blocked, quota) or absent entirely
  // (jsdom in tests), and a rejected removeClient() would otherwise abort the
  // caller's sign-out flow before it clears auth state.
  try {
    await idbPersister.removeClient();
  } catch {
    // ignore
  }
}
