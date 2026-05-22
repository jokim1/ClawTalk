// Route-level tests for google-account.
//
// These tests cover the parts of the route module that don't require a live
// Postgres connection — the htmlSafeJson helper (D3 XSS regression guard) and
// the bare callback paths (no state → invalid response). DB-backed paths
// (full happy-path callback, auth gate via middleware, rate-limit hits) live
// in google-oauth-service.test.ts and the existing integration suite.

import { describe, expect, it } from 'vitest';

import { handleGoogleCallback, htmlSafeJson } from './google-account.js';

describe('htmlSafeJson (D3 XSS regression guard)', () => {
  it('escapes </ so the payload cannot close a <script> tag', () => {
    const out = htmlSafeJson({
      type: 'clawtalk:google-account-link',
      status: 'error',
      message: '</script><script>alert(1)</script>',
    });
    // The raw injection string must NOT appear verbatim
    expect(out).not.toContain('</script><script>');
    // The forward slash after < should be escaped
    expect(out).toContain('\\u003c');
  });

  it('escapes ampersands', () => {
    const out = htmlSafeJson({ message: 'a & b' });
    expect(out).toContain('\\u0026');
  });

  it('escapes U+2028 and U+2029 (JS line terminators)', () => {
    const out = htmlSafeJson({ message: 'one two three' });
    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
    // The raw line separators must not survive into the output
    expect(out).not.toMatch(new RegExp('[\\u2028\\u2029]'));
  });

  it('round-trips safe content untouched (no over-escape)', () => {
    const out = htmlSafeJson({ status: 'success', message: 'hello world' });
    expect(out).toContain('"status":"success"');
    expect(out).toContain('"hello world"');
  });
});

describe('handleGoogleCallback — missing state', () => {
  it('returns 400 with an error popup HTML when state is missing', async () => {
    const result = await handleGoogleCallback({
      state: null,
      code: 'whatever',
      error: null,
    });
    expect(result.statusCode).toBe(400);
    expect(result.html).toContain('clawtalk:google-account-link');
    expect(result.html).toContain('"status":"error"');
    expect(result.html).toContain('Connection link is invalid');
  });

  it('returns HTML that does not let attacker-controlled message escape <script>', async () => {
    // The "message" field is server-controlled in the no-state path, so this
    // exercises the rendering pipeline end-to-end rather than the message
    // content itself. Any future code that interpolates user-controlled
    // message values must still flow through htmlSafeJson.
    const result = await handleGoogleCallback({
      state: null,
      code: null,
      error: null,
    });
    expect(result.html).toContain('window.opener.postMessage');
    // Verify the HTML uses a JSON.parse-style embed — no raw template
    // interpolation of strings into <script>.
    expect(result.html).toContain('var payload =');
  });
});
