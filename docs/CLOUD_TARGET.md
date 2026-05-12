# Cloud Target — editorialboard.ai

**Status:** Approved (2026-05-02, after `/plan-eng-review` + Codex outside-voice review)
**Supersedes:**
- `docs/06_PHASE_1A_KICKOFF.md` Pre-1 sections (0a–0g) and Section B (rocketorchestra prompt). Both planned a Cloud Run + Supabase Postgres + Cloud Run Jobs substrate alongside a separate Python service. Replaced wholesale by the single-repo, single-cloud-compute architecture below.
- `docs/EDITORIAL_ROOM_CONTRACT.md` cross-repo framing — schemas remain useful as internal validation contracts but are no longer cross-repo.

**Companion (TODO):** `docs/PURGE_PLAN.md` — the precondition that strips NanoClaw, Channels, Talks, and the rocketorchestra plumbing before this plan's first phase starts. Also defines what minimal editorial-only persistence module replaces `src/db.ts` (so Phase C is "create new", not "port chassis abstraction").

---

## 0. Goal and non-goals

**Goal:** Ship `editorialboard.ai` as a globally-edge-deployed editorial product on Cloudflare with Supabase as the stateful backbone. Sub-100ms first byte from anywhere, Postgres-grade data layer with Row-Level Security, custom domain editorialboard.ai already owned. **Phase E ships as a public beta, not a SaaS launch** — Stripe + paid subscriptions follow in Phase F.

**Non-goals (for this plan):**
- Hosting NanoClaw, container execution, channel adapters, Talks, or rocketorchestra in production. The PURGE removes them.
- Heavy multi-iteration optimization Skills (`factory_*_optimize`). Deferred per `TODOS.md` TD-CLOUD-1.
- Migrating local SQLite data. Existing local users and stored data are disposable per `CLAUDE.md`.
- Stripe / paid subscription billing. Phase F.

---

## 1. Target architecture

```
                              editorialboard.ai
                                      │
                          Cloudflare DNS + SSL + DDoS + WAF
                                      │
                                      v
                             ┌───────────────────┐
                             │ Cloudflare Worker │  ← single Worker
                             │ (Static Assets +  │     - serves Vite static build
                             │  Hono /api/*)     │     - hosts Hono API
                             │                   │     - dispatches LLM streams
                             │                   │     - per-user rate limit + spend cap
                             └─┬───────────┬─────┘
                               │           │
                               │           └──→ Cloudflare R2 (export artifacts)
                               │           └──→ Cloudflare KV (Supabase JWKS cache)
                               │           └──→ Sentry (error tracking)
                               │
                               │ Hyperdrive (CF connection pooler)
                               v
                      ┌──────────────────────────┐
                      │ Supabase                 │
                      │ - Postgres (editorial)   │  ← user-state, page library,
                      │ - Auth (auth.users + JWT)│     editorial state, panel turns
                      │ - Backups (PITR)         │
                      └──────────────────────────┘

                      External LLM providers (called from Worker)
                      - api.anthropic.com (OAuth + messages)
                      - api.openai.com (BYOK API key — primary path)
                      - chatgpt.com/backend-api/codex (Codex subscription — experimental fallback)
                      - generativelanguage.googleapis.com (Gemini)
                      - integrate.api.nvidia.com (NIM)
```

**Two vendors total: Cloudflare for compute + edge + blobs + WAF; Supabase for stateful (auth + Postgres). Sentry for error tracking (free tier).**

---

## 2. Stack decisions

| Layer | Pick | Why | Rejected |
| --- | --- | --- | --- |
| Frontend hosting | **Cloudflare Worker (Static Assets)** | One project, one deploy, no routing precedence config. **Tradeoff:** frontend rollback is coupled to API rollback; for solo app this is acceptable, but documented | Pages + standalone Worker (route override gotchas), Pages Functions (small advantage) |
| Backend runtime | **Cloudflare Workers (Paid plan, $5/mo base)** | Edge execution, scales to zero, SSE streaming supported, Paid tier gives 30s CPU + 15min wall. **Compatibility verified by benchmark in Phase B** (don't assume — measure actual CPU on prompt-assembly + parsing + Postgres writes) | Cloud Run (always-on bill, single-region origin) |
| Backend framework | **Hono** | Already used in `src/clawrocket/web/server.ts`; first-class Workers support; minimal port required | Express (no Workers support), itty-router (less ergonomic) |
| Database | **Supabase Postgres (via Cloudflare Hyperdrive)** | Postgres feature set; native RLS; same vendor as auth; Joseph's existing Supabase familiarity. **RLS + Hyperdrive requires per-transaction JWT-claim binding pattern designed in §3** | Cloudflare D1 (SQLite ceiling, no native RLS), Neon / PlanetScale (extra vendor) |
| Connection pooling | **Cloudflare Hyperdrive** | Edge-cached pooler; ~$5/mo at low scale | Direct Postgres connection (cold-start TLS+auth on every request) |
| Identity | **Supabase Auth** | Mature; 50K MAU free tier; pairs natively with Supabase Postgres RLS | Clerk, Cloudflare Access, roll-own |
| Blob storage | **Cloudflare R2** | Free egress; S3-compatible | S3 (paid egress) |
| Subscription billing | **Stripe (Phase F, post public-beta)** | Industry standard; Workers + Stripe Checkout works cleanly | Defer until ready to charge |
| Secret storage | **Cloudflare Workers Secrets** for the master encryption key; **Postgres** for encrypted-at-rest provider secrets. Key versioned (v1, v2…) so rotation is supported; per-user revoke endpoint; documented incident playbook | Same envelope encryption pattern as today + explicit rotation story | Direct env vars (rotation pain) |
| Observability | **Sentry from Phase E** (free tier 5K events/mo); **Workers Analytics** built-in; **Logpush to R2 in Phase F** | Silent SSE failures need visibility from launch, not post-launch | Sentry-from-day-N (catastrophic blind spot for an LLM SaaS) |
| Rate limiting + spend cap | **Cloudflare WAF rules + per-user request-rate + per-user provider-spend ledger** in Phase E | Prevents runaway frontend retries / attacks from racking up $1000s in LLM spend silently | Defer to Phase F (backwards for LLM-backed product) |
| Edge protection | **Cloudflare WAF** at Phase E with sane defaults; per-route rate limits in Worker middleware | Day-one DDoS / abuse protection | Defer to Phase F |

---

## 3. Auth strategy

**This section is the highest-risk part of the architecture.** Codex flagged the original draft as hand-wavy. Concrete design below.

### 3.1 Cookie-based session (deliberate, not Supabase default)

Supabase Auth's default browser flow uses client-side localStorage. We deliberately use **HTTP-only cookies** instead so the JWT can be validated server-side in the Worker without exposing it to JS:

- **Access token cookie:** `eb_at`, HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=3600
- **Refresh token cookie:** `eb_rt`, HttpOnly, Secure, SameSite=Strict, Path=/api/auth/refresh, Max-Age=2592000
- **CSRF defense:** SameSite=Lax on access token + double-submit CSRF token on state-changing requests
- **Auth-dependent responses:** `Cache-Control: no-store` on every response that includes user-specific data
- **Logout:** explicit `/api/auth/logout` clears both cookies AND invalidates the refresh token in Supabase (calls `supabase.auth.signOut()` with the refresh token)
- **Refresh rotation:** refresh tokens single-use; every refresh issues a new pair and invalidates the old refresh token

Implementation: a thin auth shim in the webapp wraps `@supabase/supabase-js` to set our cookies via the Worker's `/api/auth/callback` instead of letting the SDK use localStorage.

### 3.2 JWT validation in Worker (with KV cache)

The Worker validates each request's `eb_at` cookie:

1. Read cookie
2. Verify JWT against Supabase JWKS (cached in Workers KV with 1h TTL — saves a network round-trip per request)
3. If access token expired: return 401 with `WWW-Authenticate: refresh` so frontend can hit `/api/auth/refresh`
4. Resolve to Supabase `user_id`, attach to Hono request context

### 3.3 RLS via per-transaction JWT-claim binding (the dangerous part)

**Critical:** `auth.uid()` in Postgres RLS works automatically through Supabase's PostgREST API because PostgREST sets request-level config from the JWT on each connection. With a raw Postgres connection over Hyperdrive, **we must replicate this pattern manually per transaction** or RLS won't enforce.

The pattern:

```typescript
// Wrap every editorial-table query in a transaction that sets the JWT
// claims at transaction scope. Hyperdrive pools connections, so without
// transaction scoping, claims could leak across requests.
async function withUserContext<T>(
  db: Sql,
  userJwt: string,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return db.begin(async (tx) => {
    // SET LOCAL is transaction-scoped; auto-cleaned up at COMMIT/ROLLBACK
    await tx`SELECT set_config('request.jwt.claims', ${userJwt}, true)`;
    return fn(tx);
  });
}

// Every editorial route uses this wrapper. RLS policies use auth.uid() normally.
```

**Phase C.5 acceptance gate:** explicit multi-user RLS test that proves a request with user A's JWT cannot read user B's data, even when both requests share the same Hyperdrive-pooled connection. Without this gate passing, Phase D doesn't ship.

### 3.4 Provider OAuth flows (separate from user auth)

OAuth flows for LLM providers (Anthropic, OpenAI Codex) authorize the user's *connection to a provider*, not the user themselves:

- OAuth state ephemeral storage → Postgres table `oauth_state` with TTL cleanup
- Redirect URIs → `https://editorialboard.ai/api/v1/agents/providers/<provider>/oauth/callback`
- Refresh flow unchanged — existing `editorial-llm-call.ts` refresh-on-expiring + refresh-on-401 logic ports as-is

### 3.5 Provider secrets — encryption + rotation + revoke

Provider credentials encrypted at rest in Postgres `llm_provider_secrets`. Master key in Workers Secrets. **Rotation story (was missing from v1 of this plan):**

- Master key versioned: `enc_v1`, `enc_v2`, etc. Key version stored alongside ciphertext
- Re-encrypt-on-read: when a row is read with old key version, re-encrypt with current version on write
- Per-user revoke endpoint: `POST /api/v1/agents/providers/:provider/revoke` deletes the row + invalidates any cached tokens
- Incident playbook: documented in `docs/RUNBOOK.md` — what to do if master key compromised (rotate key version, mass re-encrypt job, force re-auth for all users)

---

## 4. Data model

**Editorial state (per-user, RLS via `owner_id = auth.uid()`):**
- `users` — minimal mirror of `auth.users` (id, email, created_at)
- `llm_provider_secrets` — encrypted provider credentials (with `enc_key_version` column)
- `oauth_state` — ephemeral OAuth flow state with TTL
- `editorial_setup_state` — per-user Setup state
- `editorial_drafts` — per-piece draft state
- `editorial_revisions` — draft revision history (Phase 1A; v1 cloud doesn't need)
- `editorial_panel_turns` — **persisted from Phase C** (not deferred). Replaces localStorage so panel turns follow user across devices

**Page library (per-user portfolio context, also RLS):**
- `editorial_themes` / `editorial_topics` / `editorial_points` / `editorial_point_notes` — portfolio
- `voice_pages` / `persona_pages` / `scorer_config_pages` — reusable context (was rocketorchestra-owned)
- `claims_ledger` — claim text, source, status, owning point, timestamps

**Spend tracking (Phase E, for spend cap enforcement):**
- `provider_spend_ledger` — per-user, per-provider, per-day spend in USD; updated after each LLM call

Everything else from the current 116-table SQLite schema goes away with the PURGE.

Migration: not applicable. Greenfield install.

**Note (per Codex):** embedding the page library directly in editorialboard's Postgres re-creates the same extraction problem we just solved with rocketorchestra. If a second app emerges, page library extracts back out. Captured in `TODOS.md` TD-CLOUD-2.

---

## 5. LLM dispatch on Workers — compatibility notes

The current `src/clawrocket/llm/editorial-llm-call.ts` is mostly Workers-compatible:

- ✅ `fetch`, `ReadableStream`, `TextDecoder`, SSE parsing — native to Workers
- ✅ Response streaming back to client
- ⚠ `Buffer.from(..., 'base64url')` — replace with `atob` + manual padding
- ⚠ `crypto` (Node) — replace with Web Crypto API. Async-only

**Streaming duration:** Workers Paid supports 15min wall time + unlimited subrequest duration during streaming. Confirmed per Cloudflare docs, **but verified by Phase B benchmark** (don't trust the doc spec — measure real CPU on prompt assembly + DB write + multi-provider fan-out).

**Cheap Skills first-class in Workers** (with CPU verification): `factory_topic_propose`, `factory_opus_review`, `factory_adv_cut`, `factory_argument_critic`, `factory_counter_audience`, `factory_claim_coverage`, `factory_claim_research`. Heavy Skills deferred per TD-CLOUD-1.

### 5.1 OpenAI Codex backend — experimental, with fallback

The `chatgpt.com/backend-api/codex` endpoint is unofficial ChatGPT internals. Two hard incidents in this session (model name change, `store: false` requirement) confirm it's fragile.

**Mitigation:**
- Add OpenAI BYOK API key path (`api.openai.com/v1/chat/completions`) as primary OpenAI auth method
- Codex subscription path remains available as a fallback for users without API keys
- UI labels Codex path as "Experimental — may break without notice"
- Sentry alerts on every Codex endpoint failure (not just sampled)
- On Codex failure with no fallback, prompt user to "switch to OpenAI API key"
- Document the risk in `docs/RUNBOOK.md`

---

## 6. Local dev workflow

```bash
# Backend
npm run dev        # wrangler dev (Worker + Static Assets, local Hyperdrive emulator)
npm run dev:vite   # vite on :5173, proxies /api/* to wrangler (heavy frontend iteration)

# Database
supabase start                            # local Postgres + Auth via Docker
supabase db push                          # apply migrations
supabase db reset                         # nuke + reseed
psql $LOCAL_DATABASE_URL                  # poke at it
```

R2 emulated by `wrangler dev`. Local Sentry: noop (Sentry only writes in deployed envs).

---

## 7. Deploy mechanics

```bash
# One-time setup
wrangler login
supabase login
supabase link --project-ref <new-editorialboard-project>
wrangler r2 bucket create editorialboard-attachments
wrangler hyperdrive create editorialboard-pg --connection-string "<supabase-pooler-url>"
wrangler kv namespace create JWKS_CACHE
# Add Hyperdrive + R2 + KV bindings + Sentry DSN to wrangler.toml

# Per-deploy (CI: GitHub Actions on push to main)
npm --prefix webapp run build               # webapp/dist/
supabase db push                            # apply Postgres migrations
wrangler deploy                             # deploys Worker + Static Assets atomically
```

**Custom domain:** point editorialboard.ai DNS at Cloudflare. Worker bound to `editorialboard.ai/*`.

### 7.1 Preview environment strategy (was underspecified — Codex caught)

PR previews need explicit design to avoid migration drift:

- **CI on PR open:** build webapp + `wrangler deploy --env=preview-pr-<N>` to a preview URL
- **Migrations strategy:** **migrations only run on main, never on preview branches.** Preview branches share a single staging Supabase project that always reflects main's schema. If a PR adds a migration, the preview can read existing tables but the migration itself only applies after merge to main.
- **Secret scoping:** preview environments use a separate Supabase project from production (`editorialboard-staging`); production secrets never leak to previews
- **Cleanup:** preview Workers auto-delete after PR close

This rules out "one Supabase project per preview branch" (operationally heavy) in favor of "main-only migrations against shared staging."

---

## 8. Migration sequence

Done in order. Each step is its own PR.

### Phase A — purge (precondition, separate plan)
**A1.** Per `docs/PURGE_PLAN.md` (TODO): delete NanoClaw, Channels, Talks, container execution, rocketorchestra references. Repo shrinks ~80%. `package.json` rename to `editorialboard`. `CLAUDE.md` rewritten. Kickoff doc retired/rewritten.

**A2.** **Carve editorial-only persistence module during PURGE** (per Codex): don't carry forward `src/db.ts` to be ported in Phase C. Instead, delete it during PURGE and create a fresh `src/editorial/db.ts` that knows only about editorial tables. Phase C then "creates new" instead of "ports chassis abstraction."

**Exit criteria:** repo builds, Editorial Room runs locally on the slimmed `editorial-only` persistence layer, no NanoClaw / rocketorchestra imports remain. Test suite green.

### Phase B — Workers compatibility prep + CPU benchmark
**B1.** Port `src/clawrocket/llm/provider-secret-store.ts` from Node `crypto` to Web Crypto. Async-ify all callers.
**B2.** Port `editorial-llm-call.ts` `extractChatGPTAccountId` from `Buffer.from` to `atob`-based base64url decode.
**B3.** Audit `src/clawrocket/identity/` for Node-isms; minimal port (most code dies in Phase D anyway).
**B4.** Add `wrangler.toml` with Worker + Static Assets + R2 + Hyperdrive + KV bindings.
**B5.** **Worker CPU benchmark** (per Codex): measure real CPU on prompt assembly + 5-agent fan-out + Postgres write under realistic editorial load. Fail-fast if anywhere near the 30s CPU limit.

**Exit criteria:** Editorial Room runs locally on Node *and* its non-route logic passes Workers-runtime smoke test. CPU benchmark passes.

### Phase C — Postgres schema + accessors + backup + panel-turn persistence
**C1.** Create new Supabase project (`editorialboard`). Define schema in `supabase/migrations/`. ~17 tables (per §4).
**C2.** Build editorial-only persistence module (the one carved in Phase A2). Async-ify all editorial DB calls. Each call site requires test pass.
**C3.** Re-run all editorial routes against Postgres locally (`wrangler dev` + local Supabase).
**C4.** Backup completeness (per Codex):
- Enable Supabase PITR add-on
- Verify restore drill into a scratch project
- Document retention policy (PITR window: 7 days)
- Document migration rollback procedure
- Document tenant-deletion semantics (account delete → cascade to all editorial_* tables)
- All in `docs/RUNBOOK.md`
**C5.** **Persist live panel turns to `editorial_panel_turns` table** (per Codex): replaces localStorage so editorial state follows user across devices. UI hook updated to read/write Postgres.
**C6.** **RLS multi-user test gate:** explicit test proves user A's JWT cannot read user B's data through a Hyperdrive-pooled connection. Without this passing, Phase D blocked.

**Exit criteria:** local Editorial Room runs end-to-end against Postgres; no `better-sqlite3` import remains; backup + restore drill verified; RLS multi-user test passes; full test suite green.

### Phase D — Supabase Auth migration with cookie design
**D1.** Wire Supabase Auth in webapp using cookie-based session (per §3.1, NOT Supabase's default localStorage). Custom auth shim wraps `@supabase/supabase-js` and sets `eb_at` + `eb_rt` cookies via `/api/auth/callback`.
**D2.** Replace `src/clawrocket/identity/` with Supabase JWT validation in Hono middleware (per §3.2): cookie read → JWKS verify → user_id resolve.
**D3.** Implement `withUserContext` transaction wrapper (per §3.3) for every editorial DB call.
**D4.** Add per-user RLS policies to all editorial tables.
**D5.** Implement refresh rotation flow (`/api/auth/refresh` issues new pair, invalidates old refresh token).
**D6.** Implement logout flow (`/api/auth/logout` clears cookies + invalidates refresh in Supabase).
**D7.** CSRF token middleware on state-changing routes.
**D8.** Delete unused identity / session code from chassis.

**Exit criteria:** full auth flow works (sign-up, sign-in, refresh, logout, password reset); RLS verified with another-user test passes; CSRF tokens validated; all responses with user data have `Cache-Control: no-store`.

### Phase E — public beta (with launch gates)
**E1.** **Rate limit middleware** in Worker: per-user request rate (configurable; default 60 requests/min for editorial routes, 30 LLM-stream initiations/min)
**E2.** **Provider spend cap middleware**: ledger increments per LLM call; daily $$ ceiling per user (configurable; default $5/day to start); requests blocked above cap with clear error
**E3.** **Sentry integration**: bind Sentry DSN to Worker; capture all Worker exceptions, all SSE stream failures, all Codex backend failures (not sampled — every one)
**E4.** Cloudflare WAF rules: rate-by-IP for `/api/auth/*` (anti-bruteforce), block known-bad ASNs, default DDoS protection on
**E5.** Register Anthropic / OpenAI Codex OAuth callbacks on production domain
**E6.** Point editorialboard.ai DNS to Cloudflare. Bind production domain to Worker.
**E7.** Add OpenAI BYOK API key path (per §5.1); UI label Codex path as experimental
**E8.** Add per-user provider revoke endpoint (per §3.5) and `withUserContext`-based account deletion endpoint
**E9.** Smoke-test: sign up, sign in, configure providers (BYOK + OAuth), use editorial flow end-to-end, verify spend ledger increments, verify rate limit returns 429 when exceeded, verify Sentry captures forced failures
**E10.** Public beta announcement copy + landing page emphasizes "beta" framing (no payment, may have downtime, data retention TBD)

**Exit criteria:** editorialboard.ai serves the Editorial Room from the edge with auth gating, spend caps, rate limiting, and error visibility; all smoke tests pass.

**This is the public-beta launch.** Calling it SaaS would be misleading without billing.

### Phase F — production hardening + monetization (post public-beta)
Tracked as `TD-CLOUD-3` in `TODOS.md`. Includes:
- Stripe + paywall + entitlement model + subscription portal
- Cloudflare Logpush to R2 for log retention beyond Sentry
- Per-product spend caps (vs. v1 per-user-per-day)
- Email vendor branding for Supabase Auth flows
- Backup restore drill re-verification + tenant-restore procedure
- Load test for Worker SSE concurrency budget
- BYOK key rotation/revocation UI for users

---

## 9. Open decisions (need your call)

| # | Question | Recommendation | Why it matters |
| --- | --- | --- | --- |
| 1 | Repo rename: `clawrocket` → `editorialboard`? | **Rename in PURGE phase, before this plan starts.** | Removes residual NanoClaw branding |
| 2 | OAuth callback URI registration on production domain | **Required at Phase E5.** | OAuth providers reject unregistered callbacks |
| 3 | Email sender for Supabase Auth flows | **Defer to Phase F.** Initial Supabase built-in templated emails fine | Production polish |
| 4 | Daily spend cap default ($/user/day) | **Start at $5/user/day; revisit after early-user data** | Too low blocks legitimate use; too high allows runaway |
| 5 | Sentry retention / event budget | **Free tier (5K events/mo) at launch; upgrade if needed in Phase F** | Sufficient for early users |

---

## 10. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| RLS bypass via Hyperdrive pool leak | Medium | Catastrophic (user A reads user B's data) | `withUserContext` transaction wrapper required for every editorial DB call; Phase C6 gate tests it explicitly |
| Cookie/CSRF design wrong (XSS, CSRF, session theft) | Medium | High | Explicit cookie design in §3.1; security review before Phase E |
| Workers SSE flakes for long Anthropic responses | Low | High | Phase B benchmark proves real Anthropic streaming works |
| Hyperdrive adds unexpected query latency | Low | Medium | Phase C measures real-world latency; if >150ms p95 from US users, evaluate read replicas |
| Async-ify (Phase C2) introduces race conditions | Medium | Medium | Each call-site change is its own commit with test pass |
| Supabase auth/db has an outage | Low | High | Cloudflare Pages can serve stale static; Worker serves degraded UX with cached JWKS during short outages |
| Worker hits CPU limit mid-LLM-stream | Low | Medium | Phase B5 benchmark catches this; Sentry alerts in Phase E |
| Supabase migration runs against wrong project | High (manual error) | Catastrophic | CI uses `--project-ref` from environment-bound secret; never run migrations from a developer machine against production |
| OAuth callback URI changes break existing local connections | Certain (one-time) | Low | Local: localhost callback. Production: editorialboard.ai callback. Both registered. Documented in E5 |
| PURGE breaks something Editorial Room implicitly depends on | Low–Medium | High | PURGE is the precondition; full test pass + manual dogfood required before merge |
| Cost spikes from Workers requests / LLM calls (bug or attack) | Medium | Medium | E1 (rate limit) + E2 (spend cap) + E4 (WAF) prevent silent runaway |
| ChatGPT Codex backend breaks | Medium-High over time | Medium (lose OpenAI Codex users) | BYOK API key fallback (§5.1); UI marks experimental; Sentry alerts on every failure |
| Provider master encryption key compromised | Low | Catastrophic | Key versioning + per-user revoke + documented incident playbook in `docs/RUNBOOK.md` |
| Frontend deploy rollback ALSO rolls back API (Static Assets coupling) | Low | Low-Medium | Documented tradeoff; Phase F may split if it becomes painful |

---

## 11. Out of scope (explicitly deferred)

- Heavy optimization Skills (`factory_*_optimize`) — `TODOS.md` TD-CLOUD-1
- rocketorchestra extraction — `TODOS.md` TD-CLOUD-2 (also notes page library may need same extraction later if a second consumer emerges)
- Phase F production hardening + Stripe — `TODOS.md` TD-CLOUD-3
- Source-map suggestions, optimization rounds — Phase 1A
- Mobile app (web-on-mobile is fine for v1)
- Multi-region Postgres replication
- Self-hosted option for users
- MCP integration story for third-party AI agents
- Email vendor branding (Phase F)

---

## 12. Estimated cost at launch (low scale)

### Infrastructure (the easy-to-estimate part)

| Service | Cost |
| --- | --- |
| Cloudflare Workers Paid (base) | $5/mo |
| Cloudflare Hyperdrive | $5/mo |
| Cloudflare R2 / DNS / SSL / WAF | $0 (free tier) |
| Sentry free tier (5K events/mo) | $0 |
| Supabase Pro (covers auth + Postgres + storage; pooled across all your Supabase projects) | $25/mo (you already pay if other Pro projects exist) |
| Domain | $0 (already owned) |
| **Infra subtotal** | **$10–35/mo** |

### LLM spend (the expensive part Codex flagged was missing)

LLM cost dominates the actual bill. Rough per-active-user estimate (one editorial session = 1-3h of work):
- Cheap Skills (proposal, polish, critique): ~$0.10–0.50 per Skill invocation × ~20 invocations per session = **$2–10 per session**
- Multi-agent panel turns (3 agents × Anthropic+OpenAI+Gemini): ~$0.10–0.50 per turn × ~5–10 turns per session = **$0.50–5 per session**

**Per active user per month** (assume 4 sessions/month): **$10–60 in LLM spend per active user.**

This is BYOK by default (user pays their own provider bill), but if/when editorialboard offers a managed-key option (Phase F+), the spend lands on editorialboard's bill. **The spend cap (E2) must default conservatively — $5/user/day = $150/user/month max** to prevent runaway when on managed keys.

### Comparison vs. original plan

Compared to original Cloud Run + Supabase + rocketorchestra: **$35–80/mo infra** plus rocketorchestra ops surface (3-5 days/month of attention). New plan: **$10–35/mo infra**, no separate substrate.

---

## 13. Decision log

From `/plan-eng-review` 2026-05-02 (inside review):
- ✅ Cloudflare Worker with Static Assets — single Worker
- ✅ rocketorchestra killed — single repo, page library in Postgres
- ✅ Backup forward to Phase C
- ✅ Supabase Auth + Supabase Postgres + Cloudflare (Worker + R2)
- ✅ TODOS.md updated with TD-CLOUD-1, TD-CLOUD-2, TD-CLOUD-3

From Codex outside-voice review 2026-05-02:
- ✅ E0/E1 split dropped — single Phase E
- ✅ Live panel turns persist in Phase C (not deferred)
- ✅ Rate limit + provider spend cap + Sentry as Phase E exit criteria
- ✅ Codex backend kept with experimental disclaimer + BYOK API key fallback + monitoring
- ✅ No "don't port yet" gate — proceed straight from PURGE → cloud port
- ✅ Phase E framed as "public beta", Stripe stays in Phase F
- ✅ Additive: explicit cookie/JWT/CSRF design in §3.1
- ✅ Additive: RLS via `withUserContext` per-transaction JWT-claim pattern in §3.3
- ✅ Additive: provider secret rotation + per-user revoke + incident playbook in §3.5
- ✅ Additive: editorial-only persistence carved during PURGE (Phase A2), not "port src/db.ts" in Phase C
- ✅ Additive: backup completeness (retention, rollback, tenant deletion) in C4
- ✅ Additive: Worker CPU benchmark in Phase B5
- ✅ Additive: preview env strategy explicit (main-only migrations + per-env Supabase project)
- ✅ Additive: Static Assets / API rollback coupling tradeoff documented
- ✅ Additive: LLM spend in cost model (§12)
- ✅ Additive: page library extraction problem noted in TD-CLOUD-2

---

## 14. Next step

This plan is approved. The immediate next deliverable is **`docs/PURGE_PLAN.md`** — the precondition (Phase A above). PURGE plan must define both:
1. What to delete (NanoClaw, Channels, Talks, container exec, rocketorchestra refs)
2. The carved editorial-only persistence module that replaces `src/db.ts`

No code changes against the cloud target until PURGE is drafted, approved, and merged.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` (outside voice) | Independent 2nd opinion | 1 | CONSIDERED | 21 findings raised: 6 structural fixes + 11 additive gaps + 4 acknowledged-but-unchanged |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 9 issues found, 0 critical gaps, 0 unresolved (after Codex pass) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CROSS-MODEL:** Codex challenged 6 inside-review decisions; user resolved all 6 (E0/E1 dropped, panel turns persisted, rate-limit forward, Codex kept with caveat, no port-yet gate, public beta framing)
- **UNRESOLVED:** 0
- **VERDICT:** ENG + OUTSIDE VOICE CLEARED — ready to draft PURGE plan and start Phase B
