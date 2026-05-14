// Cookie shim — bridges Supabase Auth (client) to ClawTalk's HttpOnly
// cookies (server). Flow:
//
//   1. SPA calls signInWithGoogle().
//   2. supabase.auth.signInWithOAuth navigates the browser to
//      Google's consent screen.
//   3. On return, Supabase auto-extracts access_token + refresh_token
//      from the URL hash (detectSessionInUrl=true) and fires SIGNED_IN.
//   4. installAuthStateListener() subscribes to onAuthStateChange,
//      POSTs the tokens to /api/v1/auth/callback so eb_at / eb_rt /
//      eb_csrf cookies get set, then calls onSignedIn so the app
//      can refresh its session state.
//
// Refresh is NOT handled here — backend /api/v1/auth/refresh owns
// refresh. The api.ts fetch wrapper retries 401s by hitting that
// route. autoRefreshToken=false on the supabase client keeps
// supabase-js's auto-refresh out of the way.

import type {
  AuthChangeEvent,
  Session,
  Subscription,
} from '@supabase/supabase-js';

import { getSupabaseClient } from './supabase-client';

const CALLBACK_PATH = '/api/v1/auth/callback';
const WARN_AFTER_FAILURES = 3;

export class CookieShimError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CookieShimError';
    this.code = code;
  }
}

/**
 * Kick off Google OAuth. Returns once Supabase has navigated the
 * browser to Google's consent screen — in normal operation the user
 * never returns to this promise (the redirect tears the page down).
 */
export async function signInWithGoogle(): Promise<void> {
  const supabase = getSupabaseClient();
  const redirectTo =
    typeof window !== 'undefined' ? window.location.origin : undefined;
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: redirectTo ? { redirectTo } : undefined,
  });
  if (error) {
    throw new CookieShimError('auth_failed', error.message);
  }
}

export async function signOut(): Promise<void> {
  const supabase = getSupabaseClient();
  await supabase.auth.signOut().catch(() => {
    // Ignore — server-side teardown owned by POST /api/v1/auth/logout.
    // We just want the in-memory client cleared.
  });
}

export interface AuthStateListenerOptions {
  /** Called after a successful SIGNED_IN POST to the callback.
   * Used by App to re-run /api/v1/session/me and flip auth state
   * from unauthenticated → authenticated when the user returns from
   * a Google OAuth redirect. */
  onSignedIn?: () => void | Promise<void>;
}

let listenerSubscription: Subscription | null = null;
let consecutiveFailures = 0;
let onSignedInCallback: AuthStateListenerOptions['onSignedIn'] = undefined;

export function installAuthStateListener(
  opts?: AuthStateListenerOptions,
): () => void {
  if (listenerSubscription) {
    return uninstallAuthStateListener;
  }
  onSignedInCallback = opts?.onSignedIn;
  const supabase = getSupabaseClient();
  const { data } = supabase.auth.onAuthStateChange(handleAuthStateChange);
  listenerSubscription = data.subscription;
  return uninstallAuthStateListener;
}

export function uninstallAuthStateListener(): void {
  if (!listenerSubscription) return;
  listenerSubscription.unsubscribe();
  listenerSubscription = null;
  consecutiveFailures = 0;
  onSignedInCallback = undefined;
}

async function handleAuthStateChange(
  event: AuthChangeEvent,
  session: Session | null,
): Promise<void> {
  if (!session) return;
  // Only act on SIGNED_IN — the OAuth / magic-link return path.
  // TOKEN_REFRESHED is ignored: backend owns refresh.
  if (event !== 'SIGNED_IN') return;

  try {
    await postCallback(session.access_token, session.refresh_token);
    consecutiveFailures = 0;
    if (onSignedInCallback) {
      await onSignedInCallback();
    }
  } catch (err) {
    consecutiveFailures += 1;
    console.warn(
      `[supabase-cookie-shim] sign-in callback POST failed (${consecutiveFailures}x)`,
      err,
    );
    if (consecutiveFailures >= WARN_AFTER_FAILURES) {
      dispatchSessionWarning(
        'Session may need refresh — sign in again if you see issues',
      );
    }
  }
}

async function postCallback(
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  const res = await fetch(CALLBACK_PATH, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessToken, refreshToken }),
  });
  if (!res.ok) {
    throw new Error(`Callback returned status ${res.status}`);
  }
}

function dispatchSessionWarning(message: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('clawtalk-session-warning', { detail: { message } }),
  );
}

export function _resetCookieShimStateForTests(): void {
  listenerSubscription = null;
  consecutiveFailures = 0;
  onSignedInCallback = undefined;
}
