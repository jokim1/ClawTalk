// clawtalk Phase 5 PR 2 — shared helper for calling Supabase's REST
// auth API.
//
// Mirrors editorialroom's same-named module. Used by
// `auth-refresh-pg.ts` and `auth-logout-pg.ts` so the request shape,
// timeout, and error semantics live in one place.
//
// Result discriminator (`kind`) is the contract route handlers
// branch on:
//   - 'ok'            : 2xx + parseable JSON; `json` is whatever
//                       Supabase returned.
//   - 'http_error'    : non-2xx; route maps status → its own error
//                       (4xx → 401 refresh-expired, 5xx → 502).
//   - 'network_error' : fetch threw / aborted (timeout); route
//                       maps to 502 (or 204 + warn for logout).
//   - 'malformed'     : 2xx but body wasn't valid JSON; treat as
//                       Supabase contract violation, 502.

const DEFAULT_TIMEOUT_MS = 5_000;

export interface SupabaseAuthEnv {
  SUPABASE_PROJECT_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
}

export type SupabaseApiResult =
  | { kind: 'ok'; status: number; json: unknown }
  | { kind: 'http_error'; status: number; body: string }
  | { kind: 'network_error' }
  | { kind: 'malformed' };

export interface CallSupabaseAuthApiOptions {
  bearerToken?: string;
  timeoutMs?: number;
}

export async function callSupabaseAuthApi(
  path: string,
  body: unknown,
  env: SupabaseAuthEnv,
  options: CallSupabaseAuthApiOptions = {},
): Promise<SupabaseApiResult> {
  const url = `${env.SUPABASE_PROJECT_URL.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = {
    apikey: env.SUPABASE_PUBLISHABLE_KEY,
    'content-type': 'application/json',
  };
  if (options.bearerToken) {
    headers['authorization'] = `Bearer ${options.bearerToken}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    return { kind: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { kind: 'http_error', status: response.status, body: text };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { kind: 'malformed' };
  }
  return { kind: 'ok', status: response.status, json };
}

export function extractSupabaseAuthEnv(envIn: unknown): SupabaseAuthEnv | null {
  if (!envIn || typeof envIn !== 'object') return null;
  const env = envIn as Record<string, unknown>;
  const projectUrl = env.SUPABASE_PROJECT_URL;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;
  if (
    typeof projectUrl !== 'string' ||
    projectUrl.length === 0 ||
    typeof publishableKey !== 'string' ||
    publishableKey.length === 0
  ) {
    return null;
  }
  return {
    SUPABASE_PROJECT_URL: projectUrl,
    SUPABASE_PUBLISHABLE_KEY: publishableKey,
  };
}
