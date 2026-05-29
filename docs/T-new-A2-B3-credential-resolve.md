# T-new-A2 B-3 — remove the `workspace_provider_secrets` surface

**Status:** Plan, **r2 draft**.
**Tracking:** [[project-llm-turn-latency]], [[T-new-A2-enqueue-talk-turn-atomic]] (the C-M4 / C8 deferred work), [[T-new-A2-followup]] (measured per-iteration evidence that originally named B-3).
**Branch (planning):** `docs/t-new-a2-b3-plan` (this doc).
**Branch (implementation, to be created):** `feature/t-new-a2-b3-remove-workspace-secrets`.
**Estimated effort:** ~8 h human / ~2 h CC. Larger than r1 estimated. The change is small-per-file but spans 13 source sites + a UI tab + a destructive migration, and the gate has to confirm no real data is on the table before drop.

---

## Revision history

- **r1 (2026-05-29)** — Framed the work as "collapse `resolveCredentialKindSnapshot` from 2 SELECTs to 1." Recommended Option A (UNION ALL) or fallback Option B (drop workspace fallback in the snapshot path only). **Codex consult flagged 16 findings, 3 critical, that invalidated the central premise:**
  - **§4.5 step 1 SQL was invalid.** It read `where owner_id = <joseph>` against `workspace_provider_secrets`. That table has no `owner_id` column — the PK is `(provider_id, credential_kind)` per migration `0010_oauth_subscription_credentials.sql:43`. The RLS SELECT policy is `using (true)` per migration `0008_workspace_provider_secrets.sql:48` — workspace rows are globally visible to all authenticated users by design, not owner-scoped.
  - **Option B was internally inconsistent.** r1 proposed dropping the workspace fallback from `resolveCredentialKindSnapshot` (the enqueue-time snapshot) but left `resolveSecret` (the runtime resolver, `execution-resolver.ts:266`) and `getAnthropicApiKeyFromDb` (`execution-planner.ts:165`) reading from `workspace_provider_secrets`. That creates an enqueue-time/runtime mismatch: the snapshot says "no credential" but the runtime would still find one.
  - **Option A's UNION ALL does not short-circuit.** Postgres evaluates both branches and sorts the merged result before `LIMIT 1` — savings are 1 client/Hyperdrive RT, not planner work avoided. For users on the 1-RT early-return path today (likely the prod hot path), the UNION ALL likely costs **more** server-side.
  - The 30 ms gate band, the n=10 sample, and the shadow-measurement contamination were also too weak.
- **r2 (this revision)** — drops the "collapse 2 SELECTs" framing entirely. The right operation is to remove `workspace_provider_secrets` (and its sibling `workspace_provider_verifications`, plus the `scope='workspace'` branch of `provider_oauth_states`) as a complete surface. ClawTalk is single-user, so the workspace-shared credential surface has no users and is dead weight. The perf win — making `resolveCredentialKindSnapshot` 1 RT regardless of personal-secret presence — is a side effect of removing the table. r2 redesigns §4.5 around the actual gate question: "is there real data on `workspace_provider_secrets` that we'd lose?"

The codex r1 findings file is preserved at `.codex-r1-findings.txt` in this worktree for traceability.

---

## 1. Context

The original B-3 lever named in `T-new-A2-followup` was "collapse `resolveCredentialKindSnapshot` from 2 SELECTs to 1." Re-reading the function showed it is already 1 RT when a personal secret matches the agent's `credential_mode`; only the personal-miss path pays 2 RTs to also probe `workspace_provider_secrets`. The followup's ~248 ms measurement came from the bench scenario, where `bench-haiku` has no personal Anthropic credential — so the bench always hits the 2-RT path and reports the worst case.

So the real question is not "how do we collapse two SELECTs" but: **why is there a workspace-shared credential table at all in a product with one user?**

The workspace-shared API key feature shipped in PRs #325–#332 (`project_ai_agents_settings_restructure`) as scaffolding for a multi-user workspace model that ClawTalk has not pursued. Today the surface is alive end-to-end — UI tab, OAuth scope, secrets table, verification table — but no one uses it. The runtime cost is two extra round-trips per agent on every credential resolve (snapshot + secret + readiness check), plus an extra `Promise.all` query in the SetupChecklist and a workspace-credential branch in every provider-card builder.

Removing the surface:
- shrinks the credential resolver in `execution-resolver.ts` by ~80 LoC and removes 3 of its workspace probes,
- drops `getAnthropicApiKeyFromDb` workspace branch (`execution-planner.ts:164`),
- collapses the SettingsPage Personal / Workspace sub-tabs back to a single Personal panel,
- removes the `workspace_provider_verifications` table that mirrors the secrets table,
- relaxes `provider_oauth_states.scope` (drops the `'workspace'` branch),
- and lets a destructive migration drop both workspace tables.

The structural perf win is implicit: `resolveCredentialKindSnapshot` always becomes 1 RT, the readiness check (`agent-management.ts:75`) drops its second SELECT, the SetupChecklist `Promise.all` drops to three queries instead of four. Bench should see the same ~125 ms saving the r1 plan predicted in the personal-miss path — but the change is justified by surface removal, not by the perf delta.

This plan is **plan-only**: no code changes during planning. Implementation lives behind a §4.5 gate that audits the live production table for any rows we'd lose.

---

## 2. Surface inventory — what `workspace_provider_secrets` touches

### 2.1 Schema (confirmed against migrations)

`supabase/migrations/0008_workspace_provider_secrets.sql`:
```sql
create table public.workspace_provider_secrets (
  provider_id text primary key references public.llm_providers(id) on delete cascade,
  enc_key_version integer not null default 1,
  ciphertext text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null
);
alter table public.workspace_provider_secrets enable row level security;

create policy workspace_provider_secrets_read
  on public.workspace_provider_secrets
  for select to authenticated using (true);

create policy workspace_provider_secrets_write
  on public.workspace_provider_secrets
  for all to authenticated
  using (public.current_user_is_workspace_admin())
  with check (public.current_user_is_workspace_admin());
```

`supabase/migrations/0010_oauth_subscription_credentials.sql:34-45` then adds `credential_kind`, `encrypted_refresh_token`, `expires_at`, and changes the PK to `(provider_id, credential_kind)`. **There is no `owner_id` column.** The SELECT policy `using (true)` means every authenticated user sees every workspace row — that is the intended design of the surface, and the reason r1's owner-scoped gate query was invalid.

The sibling table `workspace_provider_verifications` (same migration, lines 59-68 after `credential_kind`) mirrors the shape and the RLS pattern. It must travel with the secrets removal.

The `provider_oauth_states.scope` column (migration `0010_oauth_subscription_credentials.sql:80`) carries the values `'user'` and `'workspace'`. Removing the workspace surface means the workspace value is no longer reachable; the CHECK constraint should be tightened so only `'user'` is valid going forward. (Existing `'workspace'` rows, if any — they only live ~10 min — should be tolerated or cleaned up; covered in §4.)

### 2.2 Backend reader / writer sites (13 total)

| # | File:line | Operation | What it does |
|---|---|---|---|
| 1 | `src/clawtalk/agents/execution-resolver.ts:202-208` | SELECT | `isAnthropicDirectHttpReady` falls back to workspace when personal returns 0 rows. |
| 2 | `src/clawtalk/agents/execution-resolver.ts:266-278` | SELECT (limit 2) | `resolveSecret` workspace pass — runtime credential lookup. |
| 3 | `src/clawtalk/agents/execution-resolver.ts:336-369` | SELECT (limit 1) | `resolveCredentialKindSnapshot` workspace pass — enqueue-time snapshot (the original B-3 target). |
| 4 | `src/clawtalk/agents/execution-resolver.ts:462-471` | UPDATE | `refreshAndPersist` writes refreshed OAuth access tokens back to the workspace row when `origin === 'workspace'`. |
| 5 | `src/clawtalk/agents/execution-planner.ts:164-167` | SELECT | `getAnthropicApiKeyFromDb` workspace fallback. |
| 6 | `src/clawtalk/talks/main-talk-bootstrap.ts:121-124` | SELECT count(*) | `loadSetupChecklist` — fourth leg of the `Promise.all` for the welcome banner's "Add an LLM provider key" checklist item. |
| 7 | `src/clawtalk/web/routes/agent-management.ts:74-79` | SELECT | `providerHasCredential` workspace fallback (drives `executionPreview.ready` for the agent card). |
| 8 | `src/clawtalk/web/routes/ai-agents.ts:318-338` | SELECT | `listWorkspaceProviderSecrets` — builds the workspace half of every provider card. |
| 9 | `src/clawtalk/web/routes/ai-agents.ts:357-372` | SELECT | `listWorkspaceSubscriptionMetadata` — workspace subscription expiry on the provider card. |
| 10 | `src/clawtalk/web/routes/ai-agents.ts:374-401` | SELECT | `listWorkspaceProviderVerifications` — workspace verification rows for the card. |
| 11 | `src/clawtalk/web/routes/ai-agents.ts:674-692` | INSERT/UPDATE | `upsertWorkspaceProviderVerification` — verification result write. |
| 12 | `src/clawtalk/web/routes/ai-agents.ts:695-704` | DELETE | `deleteWorkspaceProviderVerification` — verification clear on credential clear. |
| 13 | `src/clawtalk/web/routes/ai-agents.ts:797-1078` | SELECT / INSERT / UPDATE / DELETE | `verifyProviderSecret` workspace branch; `putAiProviderCredentialRoute` workspace insert + workspace delete branches. |
| 14 | `src/clawtalk/web/routes/agent-oauth.ts:89-106` | INSERT/UPDATE | `persistSubscriptionCredential` writes OAuth tokens to the workspace row when `scope === 'workspace'`. |

In addition, `agent-oauth.ts` carries five `scope === 'workspace'` admin-gate branches (`initiateAnthropicOauthRoute:229`, `completeAnthropicOauthRoute:288`, `initiateOpenAiCodexOauthRoute:344`, `pollOpenAiCodexOauthRoute:417`, plus the `parseScope` helper) and the OAuth-state inserts persist `scope: 'workspace'` to `provider_oauth_states`.

The provider-card API response (`AgentProviderCard` shape, `ai-agents.ts` types) exposes the workspace half via `workspaceHasCredential`, `workspaceCredentialHint`, `workspaceVerificationStatus`, `workspaceLastVerifiedAt`, `workspaceLastVerificationError`, and `workspaceSubscriptionExpiresAt`. These fields go away.

### 2.3 Worker route surface

`src/clawtalk/web/worker-app.ts:505` parses `?scope=workspace` on `POST /api/v1/agents/providers/:providerId/verify` and threads it into `verifyAiProviderCredentialRoute`. Route bindings for the OAuth initiate / complete / poll endpoints accept `{ scope }` in the JSON body via `parseScope`. With workspace removed, the query param and body field are no-ops; we should remove the parser branches so the route surface is honest.

### 2.4 Frontend surface

| File | What it does |
|---|---|
| `webapp/src/lib/api.ts:843` | `export type ProviderCredentialScope = 'user' \| 'workspace'`. |
| `webapp/src/lib/api.ts:875-883` | `workspaceHasCredential`, `workspaceCredentialHint`, `workspaceVerificationStatus`, `workspaceLastVerifiedAt`, `workspaceLastVerificationError`, `workspaceSubscriptionHasCredential`, `workspaceSubscriptionExpiresAt` on the provider card type. |
| `webapp/src/lib/api.ts:3434-3525` | `scope` argument on `putAiProviderCredential`, `verifyAiProviderCredential`, `initiateAnthropicSubscriptionOauth`, `initiateOpenAiCodexSubscriptionOauth`, `completeAnthropicSubscriptionOauth`, `pollOpenAiCodexSubscriptionOauth`. |
| `webapp/src/pages/SettingsPage.tsx:206-214` | `projectProvider(provider, scope)` returns the workspace view. |
| `webapp/src/pages/SettingsPage.tsx:240-242` | "Configured" computation reads `workspaceHasCredential`. |
| `webapp/src/pages/SettingsPage.tsx:526-883` | `draftKey`, `ApiKeysSubTab`, `handleSave`/`handleClear`/`handleVerify` taking `scope`, the Personal / Workspace sub-tab UI, and a second `ProviderCredentialCard` rendering for workspace. |
| `webapp/src/pages/SettingsPage.tsx:1455-1856` | `ProviderCredentialCard` (`scope` prop, scopeLabel, aria), `AnthropicSubscriptionPanel`, `OpenAiCodexSubscriptionPanel` (workspace expiry display, scope arg to OAuth initiate). |
| `webapp/src/components/RegisteredAgentsPanel.tsx:38-68` | `hasApiKey = provider.hasCredential \|\| provider.workspaceHasCredential`. |
| `webapp/src/pages/SettingsPage.test.tsx` | Workspace tab test ("saves a Workspace API key with scope=workspace as an admin"); workspace fields in test fixtures. |

### 2.5 Migrations to be added

A new migration (next free index — `0033_drop_workspace_provider_secrets.sql` likely, check the directory at commit time) drops both workspace tables, the `current_user_is_workspace_admin` helper (no other readers), and tightens the `provider_oauth_states.scope` CHECK to `('user')` only. See §4.4 for the migration text.

---

## 3. Why removal is the right move

### 3.1 The original options reconsidered

r1 considered three options for `resolveCredentialKindSnapshot`:

- **Option A (UNION ALL collapse).** Single query, 1 RT regardless of personal-secret presence. Codex finding #4 noted Postgres won't short-circuit the UNION the way r1's reasoning implied. More importantly, this leaves the workspace surface intact while solving only the snapshot probe — every other workspace reader (resolveSecret, getAnthropicApiKeyFromDb, providerHasCredential, listWorkspace*, etc.) still pays the cost.
- **Option B (drop workspace from snapshot only).** Codex finding #10: this leaves enqueue/runtime resolvers inconsistent. Bad shape.
- **Option C (index hint).** Already index-served. No-op.

The r1 framing assumed the workspace surface should stay. Once you accept that ClawTalk has one user and no plan for a multi-user workspace model in the foreseeable future, the right move is to delete the surface coherently — Option B expanded to every site.

### 3.2 What the removal buys

- **Per-agent loop perf.** `resolveCredentialKindSnapshot` always 1 RT (saves ~125 ms when personal misses, which is the bench path today; saves 0 ms when personal hits, which is the prod hot path). `providerHasCredential` always 1 RT. Net N=1 saving in the bench: ~125 ms. Net N=3 saving in the bench: ~375 ms. **Production saving is gated by §4.5 step 2** (Joseph's actual personal-secret hit rate).
- **Surface reduction.** 13 backend sites, ~6 frontend sites, two tables, one RLS helper, one CHECK constraint relaxation. Net diff is something like +60 / −400 across backend, +30 / −300 across frontend (rough order; final numbers in PR).
- **Future plan complexity.** Any later plan touching the credential resolver no longer has to reason about two stores. The runtime fallback path collapses to "personal → env → fail."

### 3.3 What removal does NOT buy

- The C-M4 / C8 follow-up still mentions B-1 (batch the per-agent SELECTs across the loop) and B-4 (denormalize snapshot) as separate levers. Those are independent of this plan. After B-3 ships, B-1's win shifts from `(N−1) × 2 RTs` to `(N−1) × 2 RTs` still — same magnitude — because the surviving per-agent operations (`getRegisteredAgent`, `resolveCredentialKindSnapshot`, `createTalkRun`) still run sequentially. The interaction is additive, not duplicative.

---

## 4. The plan — coordinated removal sequence

The removal lands in **one PR** (sole-user product per [[feedback-solo-user-ship-fast]], no need for staged rollout). The order *within* the PR is deliberate: writers go before readers go before the destructive migration. If any commit-by-commit is wanted, the steps below are also a natural sequence of commits within the PR.

### 4.1 Step order (within the implementation PR)

1. **§4.5 gate.** Joseph runs the audit queries in production. If the table is non-empty, follow the data-migration fork in §4.6 before deleting writers.
2. **Remove writers** — sites #4, #11, #12, #13, #14 in §2.2 plus the OAuth scope branches in `agent-oauth.ts` and the worker-route scope parsing. After this commit, nothing new can land in `workspace_provider_secrets`.
3. **Remove readers** — sites #1, #2, #3, #5, #6, #7, #8, #9, #10 in §2.2. The `executionPreview` workspace branch in `agent-management.ts` becomes a single-table check. `loadSetupChecklist` drops its fourth `Promise.all` leg.
4. **Remove the API response shape** — strip the workspace-* fields from `AgentProviderCard`. The frontend types in `webapp/src/lib/api.ts` follow.
5. **Remove the frontend** — collapse `SettingsPage` Personal/Workspace sub-tabs to a single Personal panel; remove the workspace branch in `ProviderCredentialCard`, `AnthropicSubscriptionPanel`, `OpenAiCodexSubscriptionPanel`; update `RegisteredAgentsPanel.tsx` "hasApiKey" computation; delete the workspace test in `SettingsPage.test.tsx`.
6. **Add the destructive migration** — `DROP TABLE workspace_provider_secrets`, `DROP TABLE workspace_provider_verifications`, `DROP FUNCTION current_user_is_workspace_admin`, `ALTER TABLE provider_oauth_states` to tighten the scope CHECK. See §4.4 for exact text.
7. **Tests** — `npm run typecheck`, `npm --prefix webapp run typecheck`, both vitest suites, `format:check`.
8. **PR review** — `/codex review` (per [[feedback-codex-review-before-locking-cf-anthropic-decisions]]) + `/karpathy-audit diff` (per [[feedback-codex-catches-behavior-karpathy-catches-style]]). Absorb findings. Merge.
9. **Post-deploy verification** — bench haiku n=10 at N=1 and N=3; expect `resolveCredentialKindSnapshot` median to drop from ~248 ms to ~125 ms in the bench scenario.

### 4.2 What changes per file (high-level)

- `src/clawtalk/agents/execution-resolver.ts` — delete the workspace SELECTs in `isAnthropicDirectHttpReady`, `resolveSecret`, `resolveCredentialKindSnapshot`; drop the `origin === 'workspace'` branch in `refreshAndPersist` (keeps the personal branch only); drop the `CredentialOrigin` 'workspace' value. Net ~−80 LoC.
- `src/clawtalk/agents/execution-planner.ts` — `getAnthropicApiKeyFromDb` becomes "personal → null" (env-key path lives at the call site). Net ~−15 LoC.
- `src/clawtalk/talks/main-talk-bootstrap.ts` — `loadSetupChecklist` drops the workspaceKey leg from `Promise.all`. Net ~−5 LoC.
- `src/clawtalk/web/routes/agent-management.ts` — `providerHasCredential` becomes a single SELECT + env-key fallback. Net ~−6 LoC.
- `src/clawtalk/web/routes/ai-agents.ts` — delete `listWorkspaceProviderSecrets`, `listWorkspaceSubscriptionMetadata`, `listWorkspaceProviderVerifications`, `upsertWorkspaceProviderVerification`, `deleteWorkspaceProviderVerification`, the workspace branch in `verifyProviderSecret`, the workspace branch in `putAiProviderCredentialRoute`, the workspace branch in `verifyAiProviderCredentialRoute`, and the workspace fields from the provider-card builder. Drop `ProviderCredentialScope` (or narrow it to `'user'` only). Net ~−200 LoC.
- `src/clawtalk/web/routes/agent-oauth.ts` — delete the workspace branches in `persistSubscriptionCredential`, `initiateAnthropicOauthRoute`, `completeAnthropicOauthRoute`, `initiateOpenAiCodexOauthRoute`, `pollOpenAiCodexOauthRoute`; drop `parseScope` (or narrow to `'user'` only). Inserts to `provider_oauth_states` drop the `scope` column. Net ~−80 LoC.
- `src/clawtalk/web/worker-app.ts` — drop the `c.req.query('scope')` parse on the verify route; drop `scope` from the JSON-body parse paths into OAuth routes. Net ~−6 LoC.
- `webapp/src/lib/api.ts` — narrow `ProviderCredentialScope` or remove it; delete the workspace-* fields from the provider-card type; remove the `scope` argument from the credential and OAuth helpers. Net ~−40 LoC.
- `webapp/src/pages/SettingsPage.tsx` — collapse the Personal/Workspace sub-tab into a single panel; drop `ApiKeysSubTab` type, `subTab` state, `draftKey` (now keyed by `providerId` only), and the workspace `ProviderCredentialCard` render path. `AnthropicSubscriptionPanel` and `OpenAiCodexSubscriptionPanel` drop their `scope` prop. Net ~−250 LoC.
- `webapp/src/components/RegisteredAgentsPanel.tsx` — `hasApiKey = provider.hasCredential`. Net ~−2 LoC.
- `webapp/src/pages/SettingsPage.test.tsx` — delete the workspace-tab test; strip workspace fields from fixtures. Net ~−60 LoC.
- `supabase/migrations/0033_drop_workspace_provider_secrets.sql` (new file) — see §4.4.

Order is intentional: source-of-truth (writers) → consumers (readers) → schema (drop). Reverse order would leave dangling readers querying a dropped table mid-deploy.

### 4.3 Out of scope (explicit)

- **`agent_oauth.ts` `parseScope`-style API contract elsewhere in the codebase** — checked, no other surface uses `ProviderCredentialScope` outside this set of files.
- **Reintroducing workspace credentials in the future** — if a multi-user mode arrives, the right answer is a per-org table with proper org-id partitioning, not the global RLS-`using (true)` shape that 0008 created. That work is its own plan, not a "restore" of the deleted code.
- **`provider_oauth_states.scope` column removal** — narrowing the CHECK is enough; dropping the column is a separate cleanup. Avoided here to keep the migration minimal and reversible.
- **B-1 / B-4 levers** from the followup doc. Same status as r1 — separate plans.
- **`ensureTalkUsesUsableDefaultAgent` ~748 ms** — separate plan.

### 4.4 The destructive migration (text)

Final filename to be checked at commit time (next free index in `supabase/migrations/`). Approximate text:

```sql
-- 0033_drop_workspace_provider_secrets.sql
--
-- Remove the workspace-shared credential surface. ClawTalk is single-user;
-- the workspace API-key feature (introduced in 0008/0010) was scaffolding
-- for a multi-user model that the product has not pursued. The §4.5 gate
-- on the plan confirmed the table is empty (or has only stale rows
-- migrated out before this migration ran) — see plan doc for the audit.

drop table if exists public.workspace_provider_verifications;
drop table if exists public.workspace_provider_secrets;
drop function if exists public.current_user_is_workspace_admin();

-- Tighten provider_oauth_states.scope to 'user' only. Existing
-- 'workspace' rows (if any — they live ~10 min) are cleaned up first so
-- the constraint can be re-added.
delete from public.provider_oauth_states where scope = 'workspace';

alter table public.provider_oauth_states
  drop constraint if exists provider_oauth_states_scope_check;

alter table public.provider_oauth_states
  add constraint provider_oauth_states_scope_check
    check (scope = 'user');
```

The `drop function` line removes the SECURITY DEFINER helper from migration 0008 — no other readers exist (confirmed via grep). The `provider_oauth_states.scope` column itself stays (column drop has tougher rollback semantics; CHECK tightening is sufficient).

### 4.5 Pre-deploy gate (audit)

Run from a workstation against the production DB (Joseph has access). The gate is the audit step, not a perf measurement — the perf win is implicit.

**Step 1 — count and age of every row in the workspace tables:**

```sql
select count(*) as row_count,
       max(updated_at) as last_write
from public.workspace_provider_secrets;
-- repeat for workspace_provider_verifications
```

Expected: both queries return `row_count = 0`. If both are 0, proceed to writers removal.

If `row_count > 0` on the secrets table, fork to §4.6.

**Step 2 — verify no in-flight workspace OAuth states (~30 sec):**

```sql
select count(*), max(created_at)
from public.provider_oauth_states
where scope = 'workspace'
  and consumed_at is null
  and expires_at > now();
```

Expected: `count = 0` (workspace OAuth attempts only live ~10 min and Joseph isn't initiating them). If non-zero, wait until the row(s) expire, then run the migration's `delete ... where scope = 'workspace'` step.

**Step 3 (optional, instrumentation) — confirm prod credential resolve already pays 2 RTs OR confirm it pays 1 RT.** This is a sanity check on the bench's "248 ms is per-agent" claim:

```sql
select credential_kind, count(*)
from public.llm_provider_secrets
group by credential_kind;
```

If Joseph has an Anthropic `api_key` row, the production hot path already early-returns at the personal probe (1 RT, ~125 ms). The removal still ships — the perf delta in prod is just smaller than the bench. If Joseph has no Anthropic row, the prod path pays 2 RTs and removal saves the full ~125 ms per agent.

Bench harness for post-deploy comparison: `scripts/latency-bench.ts`. Per [[feedback-close-clawtalk-tabs-before-bench]], close all `clawtalk.app` tabs before running so the user-keyed DO isn't shared with the SPA.

### 4.6 Data-migration fork (if §4.5 step 1 returns non-zero)

If workspace rows exist, two outcomes are acceptable:

- **(a) Migrate to personal under Joseph's owner_id.** For each `(provider_id, credential_kind)` row in `workspace_provider_secrets`, UPSERT into `llm_provider_secrets` keyed on `(owner_id = <joseph>, provider_id, credential_kind)`. Preserve `ciphertext`, `encrypted_refresh_token`, `expires_at`. Resolve `<joseph>` via `select id from public.users where role = 'owner'` (or the explicit UUID Joseph supplies). Skip the migration target if a personal row already exists (personal takes precedence; user can re-save if they want the workspace key instead).
- **(b) Walk the rows manually and decide.** Joseph deletes anything stale; whatever remains gets migrated as in (a).

The destructive migration runs AFTER the personal upsert completes. The drop is irreversible — no rollback for deleted ciphertext rows.

### 4.7 Local verification (per PR4.6 ordering)

```bash
npm run typecheck
npm --prefix webapp run typecheck
npm run test                              # backend vitest
npm --prefix webapp run test              # webapp vitest (known: not in CI per [[feedback-webapp-tests-not-in-ci]])
npm run format:check
```

Verify the migration applies clean to the local Supabase stack:

```bash
npm run db:start                          # supabase start
supabase migration up                     # apply through 0033
psql $LOCAL_DATABASE_URL -c "\d workspace_provider_secrets"   # expect: relation does not exist
```

### 4.8 Post-deploy verification

- Bench haiku n=10 at N=1 and N=3 (`scripts/latency-bench.ts`). Median `agent_loop_iter_*_resolveCredentialKindSnapshot` should drop from ~248 ms to ~125 ms. Iteration total should drop by ~125 ms × N.
- `wrangler tail` clean for 60 minutes: no `ExecutionResolverError`, no `PROVIDER_SECRET_MISSING` from the bench user, no 500s on `/api/v1/agents/providers/:id` routes.
- Smoke `/api/v1/agents` page composite: response should no longer carry `workspace*` fields on `AgentProviderCard`. SPA should render only the Personal API Keys panel.

---

## 5. Risks and open questions

1. **Grandfathered data on `workspace_provider_secrets`.** The §4.5 step 1 audit catches this. The data-migration fork in §4.6 preserves anything found. **Mitigation:** the gate refuses to run the migration if rows exist and the migration step hasn't run.
2. **In-flight workspace OAuth state.** `provider_oauth_states` rows with `scope='workspace'` would be invalidated by the CHECK tightening. The §4.5 step 2 audit + the migration's `delete ... where scope='workspace'` covers this. **Mitigation:** the rows naturally expire in ~10 min and Joseph won't initiate new workspace OAuth flows during the deploy window.
3. **Rollback strategy if the migration fails partway.** The migration is three DROPs + a column DELETE + a CHECK swap. Postgres DDL is transactional — the whole migration either applies or rolls back. **Mitigation:** rely on the transactional wrapper. If a deploy fails between migration apply and code rollout, code is forward-compatible because the deploy.yml runs migrations before deploying the Worker — and the new code expects the tables to be gone.
4. **Bench may still measure 2 RTs on the post-deploy path.** The bench user (`bench-haiku`) might be missing a personal Anthropic credential and therefore hit env-key fallback. That's a measurement detail, not a correctness issue. Post-deploy bench should reflect actual code change; verify by reading `wrangler tail` sub_phase logs.
5. **External multi-user customer arrives someday.** This is the implicit cost of removal. Per [[feedback-solo-user-ship-fast]] and Joseph's stated solo-user posture, this trade is acceptable today. The note in §4.3 documents that a future multi-user mode should build per-org tables, not re-introduce the global RLS shape.
6. **Provider card UI regression.** SettingsPage's removed Workspace sub-tab is a visible change. Personal panel becomes the sole API Keys panel. Acceptable for solo-user; document in the PR body.
7. **`ProviderCredentialScope` type — keep or delete.** Narrow to `'user'` (zero-LoC name) or delete entirely. Recommend delete — every consumer can pass nothing, and a one-member union type is dead code per [[feedback-surface-backend-capability-dont-recompute]] (the "don't re-encode dead branches" spirit). If anything in the OAuth API contract still benefits from the discrim, keep it as a TODO; the migration is forward-compatible either way.

---

## 6. What lands in the PR

One PR, ~13 source files + 1 migration. Approximate diff size: backend ~+60 / −400, frontend ~+30 / −300, migration ~+25 / 0.

**Sequencing (recap from §4.1):**
1. Joseph runs §4.5 audit. Decision: empty → continue; non-empty → §4.6 data migration first.
2. Apply §4.2 deletions across all 13 source files in the order writers → readers → API shape → frontend → migration.
3. §4.7 local verification.
4. Push, `/codex review`, `/karpathy-audit diff`, absorb findings.
5. Squash-merge. Deploy.
6. §4.8 post-deploy bench + tail check.

---

## 7. Tests

Test coverage stays at the same level it is today; the deleted code paths take their tests with them.

```
CODE PATHS                                            USER FLOWS
[~] resolveCredentialKindSnapshot                    [-] Personal API key (no change)
  └── [★★ Test 1] returns personal credential_kind     └── [★★ Test 1] (was Test 1)
      when personal row exists
[~] resolveSecret                                    [-] Personal OAuth subscription (no change)
  └── [★★ Test 2] returns 'subscription' from          └── [★★ Test 2] (was Test 2)
      personal OAuth row
[~] resolveSecret env fallback (Anthropic)           [-] Env-only Anthropic (no change)
  └── [★★ Test 3] returns env api_key when             └── [★★ Test 3] (was Test 3)
      no personal row exists
[+] resolveCredentialKindSnapshot — no workspace     [+] Removed workspace surface
  └── [★★★ Test 4] returns null when only a            └── [★★★ Test 4] workspace-only
      pinnedMode='subscription' is set and no             agent surfaces PROVIDER_SECRET_MISSING
      personal row (used to fall through to                 (asserts the dropped fallback)
      workspace; should now return null cleanly)
[+] providerHasCredential — no workspace             [+] Agent card readiness
  └── [★★★ Test 5] returns false when only a workspace └── [★★★ Test 5] no false-positive
      row would have existed (asserts no leak)            "ready" state
[+] loadSetupChecklist — no workspace leg            [+] Setup checklist
  └── [★★ Test 6] hasProviderKey reads only from       └── [★★ Test 6] checklist accurate
      personal table                                       post-removal

COVERAGE: 3 unchanged + 3 added; total 6 tests in execution-resolver.test.ts.
QUALITY: ★★★:2 ★★:4
```

Frontend tests: `SettingsPage.test.tsx` loses its workspace-tab test (one `it()` block). No new frontend tests required — the workspace removal is a code deletion, not new behavior. The webapp suite is not in CI today ([[feedback-webapp-tests-not-in-ci]]) so verification is local-only.

Test discipline:
- Backend tests use the existing `seedAuthUser` + provider-setup helpers in `execution-resolver.test.ts`. All run inside `withUserContext(USER_ID, ...)`.
- The Test 4 / Test 5 assertions explicitly seed a workspace row into the OLD test fixture and then assert the new behavior, then remove the workspace fixture. After the migration runs in test setup, the workspace row INSERT must fail (table doesn't exist) — confirm by running the test against the post-migration schema.
- No new helpers needed.

---

## 8. Failure modes (changed paths only)

| Codepath | Realistic failure mode | Test covers? | Error handling? | User visibility? |
|---|---|---|---|---|
| `resolveCredentialKindSnapshot` post-removal | Agent that depended on a workspace-only credential returns null | Test 4 | Resolver propagates null → executor surfaces `PROVIDER_SECRET_MISSING` at run start | "No API credentials" error in the SPA |
| `providerHasCredential` post-removal | Same shape — agent card shows "credential missing" | Test 5 | UI shows `credential_missing` reason on the agent card | Visible on AI Agents page |
| `loadSetupChecklist` post-removal | Welcome message banner shows "Add an LLM provider key" even though a workspace key existed | Test 6 | Welcome banner copy unchanged; only `hasProviderKey` boolean computation changes | Welcome banner item state |
| `DROP TABLE workspace_provider_secrets` | Existing row data lost | §4.5 step 1 + §4.6 migration | Plan refuses to ship migration if §4.5 step 1 returns non-zero and §4.6 hasn't run | Run-time errors if Joseph relied on workspace keys |
| `DROP TABLE workspace_provider_verifications` | Verification status lost | n/a (verifications are recomputable; clearing them is harmless) | Re-verify on next save | "Not verified" badge until user re-saves |
| Tighten `provider_oauth_states.scope` CHECK | In-flight workspace OAuth flow fails on completion | §4.5 step 2 audit | CHECK violation surfaces as 400 from completeAnthropicOauthRoute | Rare; OAuth state expires in ~10 min |
| Removed `parseScope` workspace branch | Existing client sending `scope=workspace` JSON gets a no-op route call (route treats it as `user`) | Removed in tandem with client (`webapp/src/lib/api.ts` change) | n/a — value silently ignored | None — the SPA stops sending it |
| New deployed code reading dropped tables | Worker hits "relation does not exist" | n/a | Deploy order: migration first, code follows | Brief outage if order is wrong |

**Critical gaps:** none — §4.5 gate provides the data-loss safety net, and the migration is forward-compatible with the deployed code.

---

## 9. Implementation tasks

- [ ] **B3-2-1 (P1, human: ~10 min)** — Joseph runs §4.5 step 1 + step 2 audit queries against prod. Records result in PR body. Decides empty path vs §4.6 fork.
  - Files: none (psql session)
  - Verify: row counts + max(updated_at) captured

- [ ] **B3-2-2 (P1, human: ~15 min)** — If §4.5 step 1 returned non-zero: run §4.6 data migration (UPSERT workspace rows into `llm_provider_secrets` under Joseph's owner_id), then re-run §4.5 step 1 to confirm zero rows.
  - Files: none (psql session)
  - Verify: post-migration row count = 0

- [ ] **B3-2-3 (P1, CC: ~30 min)** — Remove writers: `execution-resolver.ts:462-471` (refreshAndPersist workspace branch), `ai-agents.ts:674-704` (upsert/delete verification), `ai-agents.ts:797-1078` (verifyProviderSecret + putAiProviderCredentialRoute workspace branches), `agent-oauth.ts:89-106` (persistSubscriptionCredential workspace branch), `agent-oauth.ts:229,288,344,417` (admin gates), `worker-app.ts:505` (verify route scope parse). Code at this commit may still read workspace tables, but nothing new can be written.
  - Files: 5 source files
  - Verify: typecheck + format:check pass; existing tests still green on local Supabase

- [ ] **B3-2-4 (P1, CC: ~45 min)** — Remove backend readers: `execution-resolver.ts:202-208, 266-278, 336-369`, `execution-planner.ts:164-167`, `agent-management.ts:74-79`, `main-talk-bootstrap.ts:121-124`, `ai-agents.ts:318-401` (the three list helpers + the workspace fields on `AgentProviderCard`).
  - Files: 5 source files
  - Verify: typecheck + format:check pass; vitest pass

- [ ] **B3-2-5 (P1, CC: ~20 min)** — Remove `worker-app.ts` workspace-scope query parse + agent-oauth body scope parse. Drop or narrow `ProviderCredentialScope` (recommend full delete per §5 risk #7).
  - Files: 2 source files
  - Verify: typecheck + format:check pass

- [ ] **B3-2-6 (P1, CC: ~30 min)** — Frontend: collapse SettingsPage to single Personal panel; drop `subTab`/`ApiKeysSubTab` state; trim `draftKey`; remove workspace branches from `AnthropicSubscriptionPanel`, `OpenAiCodexSubscriptionPanel`, `RegisteredAgentsPanel.tsx`. Update `webapp/src/lib/api.ts` types and helpers (drop `scope` arg). Delete `SettingsPage.test.tsx` workspace-tab test.
  - Files: 4 webapp files
  - Verify: webapp typecheck + webapp vitest pass (run locally — not in CI per [[feedback-webapp-tests-not-in-ci]])

- [ ] **B3-2-7 (P1, CC: ~15 min)** — Add migration `0033_drop_workspace_provider_secrets.sql` per §4.4 (confirm exact filename at commit time vs the migrations directory).
  - Files: 1 new migration
  - Verify: `supabase migration up` clean against local stack; `\d workspace_provider_secrets` returns "relation does not exist"

- [ ] **B3-2-8 (P1, CC: ~10 min)** — Update or add `execution-resolver.test.ts` tests per §7 (Tests 4-6 added; existing Tests 1-3 trimmed of any workspace-specific assertions).
  - Files: 1 test file
  - Verify: full vitest pass

- [ ] **B3-2-9 (P1, human: ~30 min / CC: ~15 min)** — Push branch, open PR, run `/codex review` + `/karpathy-audit diff`, absorb findings to a follow-up commit (or revert + re-run if structural), squash-merge.
  - Files: PR metadata
  - Verify: PR green, codex PASS, karpathy PASS, deploy.yml succeeds

- [ ] **B3-2-10 (P1, human: ~30 min)** — §4.8 post-deploy bench + tail check. Update `T-new-A2-followup.md` to record the new per-iteration baseline.
  - Files: `docs/T-new-A2-followup.md` (footer update only)
  - Verify: bench median matches predicted ~125 ms drop in the workspace-fallback scenario

- [ ] **B3-2-11 (P2, human: ~10 min)** — r3 footer on this doc + memory update on `project_llm_turn_latency` (B-3 SHIPPED, new baseline numbers).
  - Files: this doc, `project_llm_turn_latency` memory

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | not run | Will run on r2 before locking design. |
| Codex Consult (plan, r1) | `/codex` consult on r1 | Independent 2nd opinion | 1 | ABSORBED | 16 findings (3 critical, 5 high, 7 medium, 1 low). r1 raw output preserved at `.codex-r1-findings.txt`. All critical/high findings inverted the plan's framing — r2 is the response. |
| Codex Consult (plan, r2) | `/codex` consult on r2 | Independent 2nd opinion | 0 | not run | Will run on r2 — destructive migration plus 13-site coordinated removal warrants a second pass per [[feedback-codex-review-before-locking-cf-anthropic-decisions]]. |
| Karpathy Audit (diff, r1) | manual against r1 | Style lens + four principles | 1 | ABSORBED | 1 warning (§1 made a sharp factual claim about Joseph's prod credential state that should defer to the gate), 2 nits. Reframed §1 in r2 to defer to §4.5. |
| Karpathy Audit (diff, r2) | `/karpathy-audit diff` on r2 | Style lens + four principles | 0 | not run | Will run alongside codex r2. |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (scope self-evident — removing dead surface in a solo-user product) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (UI change is a sub-tab removal, low risk) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

**VERDICT (r2):** **DRAFT — pending review.** Plan ready for `/codex` consult + `/karpathy-audit diff` on r2. Critical pre-implementation constraints:

1. §4.5 step 1 (workspace row count + max updated_at, no owner_id predicate) MUST happen before any code change.
2. If §4.5 step 1 returns non-zero, run §4.6 data migration BEFORE the destructive drop. The plan refuses to ship until the table is empty.
3. The runtime path (`resolveSecret`, `getAnthropicApiKeyFromDb`) is removed in the same PR as the snapshot path. Inconsistent partial removal is rejected per codex r1 finding #10.
4. After this lands, do not re-introduce `workspace_provider_*` tables. A future multi-user mode should build per-org tables with proper org-id partitioning rather than the global RLS-`using (true)` shape that 0008/0010 used.
