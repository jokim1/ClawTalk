// Auth-cookie helpers for ClawTalk.
//
// Phase 5 PR 2: this module is the single source of truth for the
// `eb_at` / `eb_rt` / `eb_csrf` Set-Cookie strings that replace the
// old `cr_access_token` / `cr_refresh_token` / `cr_csrf_token` trio
// from the sqlite era. Cookie attribute matrix locked at
// CLOUD_TARGET §3.1; mirrors editorialroom's same-named helper.
//
// Anything outside this file that hand-rolls a Set-Cookie for these
// three names is a bug.

import { ACCESS_TOKEN_TTL_SEC, REFRESH_TOKEN_TTL_SEC } from '../config.js';

// Cookie names locked at CLOUD_TARGET §3.1 — shared with editorialroom.
export const ACCESS_TOKEN_COOKIE = 'eb_at';
export const REFRESH_TOKEN_COOKIE = 'eb_rt';
export const CSRF_TOKEN_COOKIE = 'eb_csrf';

const REFRESH_PATH = '/api/v1/auth/refresh';

export function parseCookieHeader(
  cookieHeader: string | undefined,
): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName) continue;
    cookies[rawName] = decodeURIComponent(rawValue.join('='));
  }
  return cookies;
}

export interface CookieOpts {
  secure: boolean;
}

export function buildAuthCookie(token: string, opts: CookieOpts): string {
  return formatCookie({
    name: ACCESS_TOKEN_COOKIE,
    value: token,
    path: '/',
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'Lax',
    maxAgeSec: ACCESS_TOKEN_TTL_SEC,
  });
}

export function buildRefreshCookie(token: string, opts: CookieOpts): string {
  return formatCookie({
    name: REFRESH_TOKEN_COOKIE,
    value: token,
    path: REFRESH_PATH,
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'Strict',
    maxAgeSec: REFRESH_TOKEN_TTL_SEC,
  });
}

export function buildCsrfCookie(token: string, opts: CookieOpts): string {
  return formatCookie({
    name: CSRF_TOKEN_COOKIE,
    value: token,
    path: '/',
    httpOnly: false,
    secure: opts.secure,
    sameSite: 'Lax',
    maxAgeSec: ACCESS_TOKEN_TTL_SEC,
  });
}

export function clearAuthCookies(opts: CookieOpts): string[] {
  return [
    formatCookie({
      name: ACCESS_TOKEN_COOKIE,
      value: '',
      path: '/',
      httpOnly: true,
      secure: opts.secure,
      sameSite: 'Lax',
      maxAgeSec: 0,
    }),
    formatCookie({
      name: REFRESH_TOKEN_COOKIE,
      value: '',
      path: REFRESH_PATH,
      httpOnly: true,
      secure: opts.secure,
      sameSite: 'Strict',
      maxAgeSec: 0,
    }),
    formatCookie({
      name: CSRF_TOKEN_COOKIE,
      value: '',
      path: '/',
      httpOnly: false,
      secure: opts.secure,
      sameSite: 'Lax',
      maxAgeSec: 0,
    }),
  ];
}

export function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

interface FormatInput {
  name: string;
  value: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax' | 'Strict';
  maxAgeSec: number;
}

function formatCookie(input: FormatInput): string {
  const parts: string[] = [`${input.name}=${encodeURIComponent(input.value)}`];
  parts.push(`Path=${input.path}`);
  parts.push(`Max-Age=${input.maxAgeSec}`);
  parts.push(`SameSite=${input.sameSite}`);
  if (input.httpOnly) parts.push('HttpOnly');
  if (input.secure) parts.push('Secure');
  return parts.join('; ');
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
