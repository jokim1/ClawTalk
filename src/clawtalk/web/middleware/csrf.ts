// clawtalk Phase 5 PR 2 — CSRF validation against the eb_csrf cookie.
//
// Sibling of the legacy `csrf.ts`. Behavior is identical (double-
// submit cookie vs X-CSRF-Token header equality) — only the cookie
// name source differs. Once the caller swap completes, `csrf.ts` can
// be deleted.
//
// Double-submit CSRF is intentionally stateless: token equality
// between the non-httpOnly `eb_csrf` cookie and the X-CSRF-Token
// header is the validation rule. No server-side CSRF token store.

import { CSRF_TOKEN_COOKIE, parseCookieHeader } from '../cookies.js';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function requiresCsrfValidation(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

export function validateCsrfTokenPg(input: {
  method: string;
  authType: 'cookie' | 'bearer';
  cookieHeader?: string;
  csrfHeader?: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!requiresCsrfValidation(input.method)) return { ok: true };
  // Bearer auth (e.g., API clients with an Authorization header) is
  // immune to browser-context CSRF; only cookie-auth requests need the
  // double-submit pair.
  if (input.authType !== 'cookie') return { ok: true };

  const cookies = parseCookieHeader(input.cookieHeader);
  const cookieToken = cookies[CSRF_TOKEN_COOKIE];
  if (!cookieToken) {
    return { ok: false, reason: 'Missing CSRF cookie' };
  }
  if (!input.csrfHeader) {
    return { ok: false, reason: 'Missing X-CSRF-Token header' };
  }
  if (cookieToken !== input.csrfHeader) {
    return { ok: false, reason: 'CSRF token mismatch' };
  }

  return { ok: true };
}
