// Supabase client factory — Phase 5 PR 2.
//
// One module-scoped client serves the whole webapp. We deliberately
// disable session persistence (`persistSession: false`) so Supabase
// never writes tokens to localStorage — `eb_at` / `eb_rt` HttpOnly
// cookies set by `POST /api/v1/auth/callback` are the only persisted
// session state.
//
// `detectSessionInUrl: true` — Supabase auto-extracts access_token
// + refresh_token from the URL hash on landing back from Google
// OAuth and fires SIGNED_IN. The cookie shim's listener catches that
// event and POSTs the tokens to /api/v1/auth/callback so cookies get
// set, then the app re-checks /api/v1/session/me and flips into
// authenticated state.
//
// `autoRefreshToken: false` — the backend /api/v1/auth/refresh route
// owns refresh, not supabase-js. The api.ts fetch wrapper retries
// 401s by hitting the refresh route; we don't want supabase-js's
// auto-refresh racing the backend wrapper.

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
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: true,
    },
  });
  return cached;
}

export function _resetSupabaseClientForTests(): void {
  cached = null;
}
