// Shared error envelope for the Google tools subsystem.
//
// The full code union covers both the credential layer (Lane A) and the
// per-tool executor layer (Lane B). Splitting them across two files would
// force the tool dispatcher in new-executor.ts to thread two different
// error types through one common flatten-to-LLM-result path, which makes
// the dispatcher harder to keep typed. One union here, both layers throw
// instances of `GoogleToolCredentialError`.
//
// The plan (snazzy-crunching-quill.md, "Typed error envelope (C9)") lists
// the canonical 10 codes for PR2; we include them all so Lane B and Lane C
// don't need to extend the type. `google_refresh_unavailable` is an extra
// code surfaced when the OAuth client secret env vars are missing on the
// Worker — defensive in dev / misconfigured deploys, never expected in prod.

export type GoogleToolErrorCode =
  // — Credential layer (Lane A) —
  | 'google_account_not_connected'
  | 'google_reauth_required'
  | 'google_scopes_missing'
  | 'google_picker_not_configured'
  | 'google_refresh_unavailable'
  | 'token_exchange_failed'
  // — Tool executor layer (Lane B) —
  | 'unbound_resource'
  | 'external_mutation_blocked'
  | 'drive_api_error'
  | 'invalid_request'
  | 'rate_limited';

export class GoogleToolCredentialError extends Error {
  readonly code: GoogleToolErrorCode;
  readonly status: number;
  readonly missingScopes?: string[];

  constructor(
    code: GoogleToolErrorCode,
    message: string,
    status = 400,
    extra?: { missingScopes?: string[] },
  ) {
    super(message);
    this.name = 'GoogleToolCredentialError';
    this.code = code;
    this.status = status;
    if (extra?.missingScopes && extra.missingScopes.length > 0) {
      this.missingScopes = extra.missingScopes;
    }
  }
}
