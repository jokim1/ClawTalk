// Supabase client factory — auth settings mirror rocketboard's
// proven-good pattern (rocketboard/src/platform/supabase/client.ts).
//
// `persistSession: true` keeps the session in localStorage so a page
// reload / browser restart finds the user already signed in.
//
// `autoRefreshToken: true` makes supabase-js refresh the access token
// on a background timer before it expires, instead of the SPA having
// to wait for a 401 to react. The cookie shim mirrors every refreshed
// session into the backend's HttpOnly `eb_at` / `eb_rt` cookies via
// POST /api/v1/auth/callback, so the cookie tier and the localStorage
// tier stay in sync.
//
// `lock: processLock` serializes auth operations across browser tabs
// using the Web Locks API. Without it, two tabs can race a refresh,
// the loser invalidates the single-use refresh token, and the user
// gets bounced to login.
//
// `detectSessionInUrl: true` — Supabase pulls access_token +
// refresh_token out of the URL hash on the OAuth landing, fires
// SIGNED_IN; the shim then POSTs to /api/v1/auth/callback so cookies
// land.

import { processLock } from '@supabase/auth-js';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

let cached: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export function getSupabaseClient(): SupabaseClient {
  if (cached) return cached;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      'Supabase client unavailable: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set in webapp/.env.local',
    );
  }
  cached = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      lock: processLock,
      persistSession: true,
    },
  });
  return cached;
}

export function _resetSupabaseClientForTests(): void {
  cached = null;
}
