# ClawTalk Security

Security model for the current Workers + Postgres stack. Supersedes [archive/SECURITY.md](./archive/SECURITY.md) (retired SQLite/containers model). Closes DOC-AUDIT #22.

Cross-refs: [§11 §12](./11-data-model.md) (RLS), [engineering-notes.md](./engineering-notes.md), `src/clawtalk/identity/`, `src/clawtalk/llm/`.

## 1. Identity & sessions

- **OAuth (Google)** — primary signin. Implementation: `src/clawtalk/identity/google-oauth-service.ts`.
- **Email magic-link** — planned, not shipped.
- **Device-code** auth for CLI/terminal — `src/clawtalk/identity/device-auth.ts`.
- **Cookies** — three cookies (locked at CLOUD_TARGET §3.1, single source of truth `src/clawtalk/web/cookies.ts`):
  - `eb_at` — access token. `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
  - `eb_rt` — refresh token. `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api/v1/auth/refresh` (scoped to the refresh endpoint so it never leaks to other requests).
  - `eb_csrf` — CSRF token, non-`HttpOnly` so the SPA can echo it. `Secure`, `SameSite=Lax`, `Path=/`.
- **Workspace-scoped sessions.** Access token carries the active `workspace_id`; switching workspaces issues a new access token.
- **Rotation.** Refresh on every access-token expiry; refresh token rotates on use.

## 2. Authorization model

- **RLS-by-default.** Every workspace-owned table has RLS on (§11 §12). The visibility predicate is workspace membership, not user-id.
- **Identity binding.** `withUserContext(userId, fn)` (`src/db.ts`) opens a transaction, runs `set local role authenticated`, then `select set_config('request.jwt.claims', {sub, role}, true)`. Inside the transaction, `auth.uid()` returns the caller and policies enforce membership.
- **Helpers.** Two `security definer` functions (§11 §12):
  - `is_workspace_member(ws uuid) returns boolean` — true if caller has any role in the workspace.
  - `is_workspace_admin(ws uuid) returns boolean` — true iff caller is `owner` or `admin` (member/guest get false).
- **Recursion guard.** `workspace_members` policies key on `user_id = auth.uid()` directly; every other table joins through the helpers. A policy on table T cannot safely subselect from T.
- **Service-role bypass.** Cross-workspace paths (scheduler, queue consumer, outbox writer, Forge executor, news ingest) connect with the connection-owning role (`bypassrls` in Supabase) and skip `withUserContext`. The contract: any code path that handles user input MUST call `withUserContext(authUserId)` so RLS engages. A missing `withUserContext` on a user-input path is the bug to grep for.

## 3. Secret storage

Two distinct stores. Do not conflate.

- **`workspace_provider_secrets`** — LLM provider API keys (Anthropic, OpenAI, Google, NVIDIA). Encrypted at rest. JIT-decrypted at inference time. Workspace-shared. **Not used for OAuth.** Implementation: `src/clawtalk/llm/provider-secret-store.ts`.
- **`connector_secrets`** — OAuth tokens for connectors (Slack, Google Drive, Gmail, Linear, GitHub, Notion, SSR/Synthetical). Encrypted at rest. JIT-decrypted at use. **Never returned by GET APIs** — only `hasCredential: boolean`. Implementation: per §11 §6/§9.

Both stores use the same encrypt-at-rest + JIT-decrypt pattern (engineering-notes §1).

## 4. Encryption

- **Key versioning.** Both stores carry `enc_key_version int not null default 1`. Rotation = bump version, re-encrypt new writes; old rows stay readable until rewritten.
- **Master key.** `CLAWTALK_PROVIDER_SECRET_KEY` Cloudflare Workers env var (set via `wrangler secret put`). In development with no key set, `provider-secret-store.ts` falls back to `PROVIDER_SECRET_DEV_FALLBACK` and logs a warning — never run prod without the env var set.
- **Rotation procedure.** (1) Set the new key in Workers env. (2) Bump the `enc_key_version` default and the encryption helper. (3) New writes use the new version. (4) Optional: background re-encrypt sweep for old rows.

## 5. CSRF

- **Double-submit cookie.** Non-HttpOnly `eb_csrf` cookie + `X-CSRF-Token` request header on mutating methods. Token equality is the entire check — stateless.
- **Validation.** `src/clawtalk/web/middleware/csrf.ts`. Checked on every cookie-authed mutating route (POST/PUT/PATCH/DELETE). Bearer-token API clients skip CSRF (no cookie attached).
- **Same-origin.** Cookies are `SameSite=Lax`; cross-site POST cannot read the cookie value to forge the header.

## 6. Rate limiting

Per-user per-route limits enforced in the Worker. Implementation surface and limits: TODO — currently not consolidated. Spec for the new build: token bucket per (user_id, route_class), with stricter buckets on auth + LLM-cost routes.

## 7. Audit logs

- **`audit_events` table** (§11 §10) — every state mutation that touches workspace state (member changes, connector authorize/revoke, document edits accepted, agent prompt edits, job run lifecycle, workspace delete/transfer).
- **Indexed** on `(workspace_id, created_at desc)` and `(workspace_id, entity_type, entity_id, created_at desc)`.
- **PII discipline.** Payload (`details_json`) captures structural facts (entity ids, action verb, before/after of safe fields). Do not log message bodies, document text, prompt content, OAuth tokens, or LLM keys.

## 8. Data deletion

- **Workspace delete.** Owner-only. Cascades to every workspace-owned table via FK `on delete cascade`. Includes `connector_secrets` and `workspace_provider_secrets`.
- **User delete.** Restricted while the user owns any workspace. User-facing paths: (a) **transfer ownership** to another admin, then (b) **leave workspace** for each remaining membership. After both, user delete is a no-op cascade.
- **Hard user delete.** Admin-only (system admin, not workspace admin) — used for GDPR-style erasure. Cascades through `users.id` FKs.

## 9. Threat model

- **Top concern: cross-tenant leak.** Mitigated by composite FKs (every workspace-owned row carries `workspace_id`; child FKs use `(workspace_id, parent_id)` so a row in workspace A cannot reference a parent in workspace B) plus the RLS membership predicate. Both must hold — neither alone is sufficient.
- **Untrusted user input** (chat messages, document text, agent prompt edits) is validated at the HTTP boundary, stored as-is, and only crosses out of the system via (a) LLM provider APIs (provider trust boundary) and (b) the SPA renderer (XSS-safe React).
- **Trusted internal calls** (scheduler → queue → executor → outbox) run service-role and are gated by code review, not RLS. Adding a new internal writer means thinking about which workspace the write belongs to.
- **Prompt injection** into agent runs is in-scope as a product risk, out-of-scope as an infrastructure risk — prompts cannot reach the host beyond the LLM API call.

## 10. Reporting vulnerabilities

Email Joseph: jokim1@gmail.com. Please do not file public issues for security bugs.
