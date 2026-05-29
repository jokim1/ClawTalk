# T-new-A2 B-3 — remove the `workspace_provider_secrets` surface (two-PR rollout)

**Status:** Plan, **r5 draft**.
**Tracking:** [[project-llm-turn-latency]], [[T-new-A2-enqueue-talk-turn-atomic]] (the C-M4 / C8 deferred work), [[T-new-A2-followup]].
**Branch (planning):** `docs/t-new-a2-b3-plan` (this doc).
**Branches (implementation, to be created):** `feature/t-new-a2-b3-pr-a-code-removal`, then `feature/t-new-a2-b3-pr-b-drop-tables`.
**Estimated effort:** ~6 h human / ~3 h CC across both PRs. PR A is the bulk; PR B is a one-line migration + a re-run audit.

---

## Revision history

- **r1 (2026-05-29, `6d3e437`)** — Framed B-3 as "collapse 2 SELECTs to 1." Codex consult returned 16 findings, 3 critical, that invalidated the central premise (invalid `owner_id` predicate, inconsistent enqueue/runtime fallback, UNION ALL did not short-circuit). Findings preserved at `.codex-r1-findings.txt`.
- **r2 (2026-05-29, `0341fc8`)** — Reframed to "coherently remove `workspace_provider_secrets`." Codex consult returned 12 findings (6 critical, 6 advisory), karpathy audit returned 6 findings (3 critical). Critical blockers: (1) `DROP FUNCTION current_user_is_workspace_admin()` would break unrelated workspace_channels / workspace_data_connectors / workspace_slack_installs RLS; (2) deploy.yml runs migrations **before** the Worker deploys — single-PR shape leaves old code reading dropped tables during the window; (3) rollback framing only covered the migration, not the Worker; (4) §4.2 ↔ §4.3 contradicted on `provider_oauth_states.scope`; (5) `TalkDetailPage.tsx:2338-2340` + its test fixture consume `workspaceHasCredential` and `hasWorkspaceSubscription`, missed from §2.4; (6) §4.6 `ON CONFLICT DO NOTHING` discards workspace ciphertext silently. Codex r2 findings preserved at `.codex-r2-findings.txt`.
- **r3 (2026-05-29, `b400133`)** — Splits the rollout into two PRs to dodge the deploy-window race. PR A removes code only (forward-compatible against the existing schema). PR B ships the destructive migration after PR A is verified in prod. Keeps `current_user_is_workspace_admin` (still referenced by 0019/0020/0023). Resolves the scope contradiction: column and NOT NULL stay; inserts keep `scope: 'user'`; PR B tightens the CHECK. Adds `TalkDetailPage` to the frontend inventory. Reconciles §7 test plan to live in three files (execution-resolver, agent-management, main-talk-bootstrap), drops the contradiction about asserting against a dropped table. Codex r3 returned 4 findings (1 P1, 3 P2); karpathy r3 added 1 CRITICAL + 2 WARNINGS + 1 nit. Raw codex output preserved at `.codex-r3-findings.txt`.
- **r4 (this revision)** — Tight delta absorbing the r3 review round. Six edits, all confined to §4.1, §4.4, §4.6, §6, §9, and §2.4:
  - **§4.4 internal contradiction** (codex r3 P1 #1 + karpathy r3 CRITICAL #1). The data-migration fork now INSERTs new rows, then DELETEs both migrated *and* intentionally-discarded source rows from `workspace_provider_secrets`, then re-runs the §4.3 audit which can now actually return `row_count = 0`.
  - **§4.4 `enc_key_version` omission** (codex r3 P2 #2). Copy SQL now includes `enc_key_version` in both columns and projection.
  - **§4.1 + §2.4 invented field name** (codex r3 P2 #4 + karpathy r3 CRITICAL #2). `provider.hasSubscription` (does not exist) → `provider.hasPersonalSubscription` (the actual field per `webapp/src/lib/api.ts:880`). §2.4 also adds an explicit "field names verified against `webapp/src/lib/api.ts` at commit-time" line. Same precision-failure class as r2's `workspaceSubscriptionHasCredential` mistake; logged to [[feedback-verify-schema-facts-in-plan-gates]] so it doesn't repeat.
  - **§6 "no-op redeploy" framing** (codex r3 P2 #3 + karpathy r3 WARNING). PR B's deploy is not literally a no-op — `deploy.yml` still rebuilds SPA, syncs secrets, re-publishes assets / queues / cron / DO bindings via wrangler. Reworded to "no application code changes; still a full Worker + assets redeploy."
  - **§6 file-count ambiguity + §4.1 list-count discrepancy** (karpathy r3 WARNING). "~13 source files + 4 webapp files" was inconsistent with §2.2's 14 sites + §2.4's 11 rows. r4 picks the "files touched" convention (~9 backend + ~5 webapp) so it matches PR-stat output.
  - **§4.1 + §4.4 "~24h soak" success criteria** (karpathy r3 WARNING). Now explicit: PR B opens once PR A has been in prod ≥24h with zero `ExecutionResolverError` / `PROVIDER_SECRET_MISSING` events in `wrangler tail` and bench `resolveCredentialKindSnapshot` median ≤140 ms.
  - **§9 task-time syntax** (karpathy r3 NIT). Uniform `(P1, human: ~X min, CC: ~Y min)` across every task line.

Cross-revision overlap rose sharply on r3: 4 of 6 karpathy findings also surfaced in codex output. Per [[feedback-codex-catches-behavior-karpathy-catches-style]] this is diagnostic of plan health, not reviewer redundancy — the precision-failure class kept re-firing because the plan kept inventing identifiers. r4 closes that channel by pinning field names and adding the source-of-truth verification note.

- **r5 (this revision)** — Polish pass absorbing the four codex r4 + four karpathy r4 P2 advisories. No structural changes; ~10 LoC delta confined to §4.2, §4.4, §4.6. Codex r4 + karpathy r4 had 4-of-4 overlap on findings (and karpathy added an observation about long-term revision-history accumulation that does not yet require action). Fixes:
  - **§4.2 "no-op" residue** (codex r4 P2 #1 + karpathy r4 WARNING). r4 fixed §6 but missed the same string class at §4.2:161. Reworded to match §6.
  - **§4.6 soak criterion (2) unverifiable** (codex r4 P2 #2 + karpathy r4 WARNING). The original wording asked Joseph to filter `ExecutionResolverError` events "tagged to workspace credentials," but the error object carries only `message` and `code` — no credential origin metadata. Reworded to "zero resolver failures from providers listed in the §4.3 workspace audit," which defers to the human cross-reference Joseph would do anyway.
  - **§4.4 DB-role preamble** (codex r4 P2 #3 + karpathy r4 WARNING). The INSERT step requires `owner_id = auth.uid()` per RLS at `0002_rls_policies.sql:53`; the DELETE on `workspace_provider_secrets` requires `current_user_is_workspace_admin()` per `0008:53`. r5 adds an explicit "run as the Supabase postgres role" preamble so the fork doesn't trip on authenticated-user RLS.
  - **§4.4 `<joseph-uuid>` lookup as Step 0** (codex r4 P2 #4 + karpathy r4 NIT). Adds a one-line lookup query so the fork is self-contained and Joseph doesn't paste the UUID literal four times.

Codex r4 raw output preserved at `.codex-r4-findings.txt`.

---

## 1. Context

The original B-3 lever named in `T-new-A2-followup` was "collapse `resolveCredentialKindSnapshot` from 2 SELECTs to 1." The function is already 1 RT when a personal secret matches the agent's `credential_mode`; only the personal-miss path probes `workspace_provider_secrets`. The followup's ~248 ms measurement came from the bench (which has no personal Anthropic credential), making 2 RT the worst case rather than the prod hot path.

The right question is not "collapse two SELECTs" but: ClawTalk is single-user — why is there a workspace-shared credential table at all?

The workspace-shared API key feature shipped in PRs #325–#332 as scaffolding for a multi-user workspace model that the product has not pursued. The surface is alive end-to-end (UI Personal/Workspace sub-tab, OAuth `scope='workspace'`, secrets + verifications tables, provider-card workspace fields), but no real user touches it. Removing it tightens the credential-resolve path, simplifies the SettingsPage, and lets the runtime credential resolver drop to one store.

The structural perf win is implicit: `resolveCredentialKindSnapshot` always becomes 1 RT, `providerHasCredential` always 1 RT, `loadSetupChecklist` drops a `Promise.all` leg. Bench should see ~125 ms saving × N on the personal-miss path. Production saving depends on Joseph's hit rate (gated by the audit in §4.3).

**This plan is plan-only.** No code changes during planning. Implementation lives behind the §4.3 / §4.4 gates.

---

## 2. Surface inventory

### 2.1 Schema (confirmed against migrations)

`supabase/migrations/0008_workspace_provider_secrets.sql:38-45` (the base table) +  `supabase/migrations/0010_oauth_subscription_credentials.sql:34-45` (PK shape change to `(provider_id, credential_kind)`). **No `owner_id` column.** RLS read policy is `using (true)` per `0008:48` — workspace rows are globally visible to authenticated users by design.

Sibling table `workspace_provider_verifications` (`0008:65-92` + `0010:59-68`) mirrors the secrets shape and RLS pattern. Both tables travel with this plan.

The `current_user_is_workspace_admin()` SECURITY DEFINER helper (`0008:18-31`) **stays** — it is also referenced by `0019_workspace_channels.sql:58-59`, `0020_workspace_data_connectors.sql:43-44`, and `0023_workspace_slack_installs.sql:42-43`. Dropping it would break those tables' write policies.

The `provider_oauth_states.scope` column (`0010:79-80`) is `NOT NULL CHECK (scope IN ('user', 'workspace'))`. PR B tightens the CHECK to `'user'` only; the column and NOT NULL stay. Existing `'workspace'` rows expire in ~10 min and PR B's migration deletes any survivors before the CHECK tightens.

### 2.2 Backend reader / writer sites (14 total)

| # | File:line | Operation | What it does |
|---|---|---|---|
| 1 | `src/clawtalk/agents/execution-resolver.ts:202-208` | SELECT | `isAnthropicDirectHttpReady` falls back to workspace when personal returns 0 rows. **Note:** existing query already reads any credential kind, not just `api_key` (the comment at `:187-188` says api_key only, but the query doesn't filter). Removing the workspace branch doesn't fix this — that's a separate latent bug. |
| 2 | `src/clawtalk/agents/execution-resolver.ts:266-278` | SELECT (limit 2) | `resolveSecret` workspace pass — runtime credential lookup. |
| 3 | `src/clawtalk/agents/execution-resolver.ts:336-369` | SELECT (limit 1) | `resolveCredentialKindSnapshot` workspace pass — enqueue-time snapshot (the original B-3 target). |
| 4 | `src/clawtalk/agents/execution-resolver.ts:462-471` | UPDATE | `refreshAndPersist` writes refreshed OAuth access tokens back to the workspace row when `origin === 'workspace'`. Reachable only if a runtime `resolveSecret` returns a workspace `subscription` row; PR A removes that path simultaneously. |
| 5 | `src/clawtalk/agents/execution-planner.ts:164-167` | SELECT | `getAnthropicApiKeyFromDb` workspace fallback. |
| 6 | `src/clawtalk/talks/main-talk-bootstrap.ts:121-124` | SELECT count(*) | `loadSetupChecklist` — fourth leg of `Promise.all` for the welcome banner's "Add an LLM provider key" item. `hasProviderKey` becomes `personalKey > 0` only. |
| 7 | `src/clawtalk/web/routes/agent-management.ts:74-79` | SELECT | `providerHasCredential` workspace fallback (drives `executionPreview.ready`). |
| 8 | `src/clawtalk/web/routes/ai-agents.ts:318-338` | SELECT | `listWorkspaceProviderSecrets` — workspace half of every provider card. |
| 9 | `src/clawtalk/web/routes/ai-agents.ts:357-372` | SELECT | `listWorkspaceSubscriptionMetadata` — workspace subscription expiry on the card. |
| 10 | `src/clawtalk/web/routes/ai-agents.ts:374-401` | SELECT | `listWorkspaceProviderVerifications` — workspace verification rows. |
| 11 | `src/clawtalk/web/routes/ai-agents.ts:674-692` | INSERT/UPDATE | `upsertWorkspaceProviderVerification` — verification result write. |
| 12 | `src/clawtalk/web/routes/ai-agents.ts:695-704` | DELETE | `deleteWorkspaceProviderVerification` — verification clear on credential clear. |
| 13 | `src/clawtalk/web/routes/ai-agents.ts:797-1078` | SELECT / INSERT / UPDATE / DELETE | `verifyProviderSecret` workspace branch; `putAiProviderCredentialRoute` workspace insert + delete branches. Also: workspace-credential preference in `buildAdditionalProviderCards`'s `credentialFor()` (`:427-430`) for live model discovery — removing the workspace branch means discovery falls back to personal key only. |
| 14 | `src/clawtalk/web/routes/agent-oauth.ts:89-106` | INSERT/UPDATE | `persistSubscriptionCredential` writes OAuth tokens to the workspace row when `scope === 'workspace'`. |

`agent-oauth.ts` additionally carries five `scope === 'workspace'` admin-gate branches (`:229, :288, :344, :417, parseScope`). The OAuth-state inserts pass `scope: 'user'` or `'workspace'` to `provider_oauth_states`; PR A makes the inserts pass `'user'` exclusively (the column and NOT NULL stay; only the value narrows).

The provider-card API response (`AgentProviderCard` type in `ai-agents.ts`) exposes the workspace half via `workspaceHasCredential`, `workspaceCredentialHint`, `workspaceVerificationStatus`, `workspaceLastVerifiedAt`, `workspaceLastVerificationError`, `hasWorkspaceSubscription`, and `workspaceSubscriptionExpiresAt`. These fields drop from the response shape in PR A.

### 2.3 Worker route surface

`src/clawtalk/web/worker-app.ts:505` parses `?scope=workspace` on `POST /api/v1/agents/providers/:providerId/verify` and threads it into `verifyAiProviderCredentialRoute`. Route bindings for the OAuth initiate / complete / poll endpoints accept `{ scope }` in the JSON body via `parseScope`. PR A removes these parser branches; the routes accept only `'user'` going forward (default).

### 2.4 Frontend surface

Field names below were verified against `webapp/src/lib/api.ts` at the r4 commit; the type definition for `AgentProviderCard` lives at lines 875-883.

| File | What it does |
|---|---|
| `webapp/src/lib/api.ts:843` | `export type ProviderCredentialScope = 'user' \| 'workspace'`. |
| `webapp/src/lib/api.ts:875-883` | `workspaceHasCredential`, `workspaceCredentialHint`, `workspaceVerificationStatus`, `workspaceLastVerifiedAt`, `workspaceLastVerificationError`, `hasWorkspaceSubscription`, `workspaceSubscriptionExpiresAt` on the provider card type. |
| `webapp/src/lib/api.ts:3434-3525` | `scope` argument on `putAiProviderCredential`, `verifyAiProviderCredential`, `initiateAnthropicSubscriptionOauth`, `initiateOpenAiCodexSubscriptionOauth`, `completeAnthropicSubscriptionOauth`, `pollOpenAiCodexSubscriptionOauth`. |
| `webapp/src/pages/SettingsPage.tsx:206-214` | `projectProvider(provider, scope)` returns the workspace view. |
| `webapp/src/pages/SettingsPage.tsx:240-242` | "Configured" computation reads `workspaceHasCredential`. |
| `webapp/src/pages/SettingsPage.tsx:526-883` | `draftKey`, `ApiKeysSubTab`, `handleSave`/`handleClear`/`handleVerify` taking `scope`, the Personal / Workspace sub-tab UI, and a second `ProviderCredentialCard` rendering for workspace. |
| `webapp/src/pages/SettingsPage.tsx:1455-1856` | `ProviderCredentialCard` (`scope` prop, scopeLabel, aria), `AnthropicSubscriptionPanel`, `OpenAiCodexSubscriptionPanel` (workspace expiry display, scope arg to OAuth initiate). |
| `webapp/src/pages/TalkDetailPage.tsx:2338-2340` | "Configured providers" check reads `workspaceHasCredential` and `hasWorkspaceSubscription` alongside personal. PR A simplifies to `provider.hasCredential \|\| provider.hasPersonalSubscription` (the actual personal-OAuth field on `AgentProviderCard`). |
| `webapp/src/components/RegisteredAgentsPanel.tsx:38-68` | `hasApiKey = provider.hasCredential \|\| provider.workspaceHasCredential`. |
| `webapp/src/pages/SettingsPage.test.tsx` | Workspace tab test ("saves a Workspace API key with scope=workspace as an admin"); workspace fields in fixtures. |
| `webapp/src/pages/TalkDetailPage.test.tsx:4862-4870` | Workspace fields in provider fixtures. |

### 2.5 Documentation that mentions workspace credentials

`docs/11-data-model.md:30-32, 392, 414, 632-637` still describes `workspace_provider_secrets` as preserved/shared infrastructure. **Out of scope for this plan** — `11-data-model.md` is the greenfield-schema redesign doc currently under separate planning. A short note here records the inconsistency; if 11-data-model.md ships first, it should rewrite those lines.

---

## 3. Why removal is the right move

r1 considered three options for `resolveCredentialKindSnapshot`:

- **UNION ALL collapse** — solves only one of 14 sites, doesn't reduce the surface, codex r1 #4 showed Postgres won't short-circuit.
- **Drop workspace from snapshot only** — codex r1 #10 showed this leaves enqueue/runtime resolvers inconsistent.
- **Index hint** — already index-served, no-op.

r2's reframing accepts that ClawTalk is single-user and the workspace surface is dead weight. r3 keeps that thesis. The single-PR shape r2 proposed is what required the rework — see §4 for the staged-deploy fix.

What removal buys:
- `resolveCredentialKindSnapshot` always 1 RT (~125 ms saving on the bench / personal-miss path; 0 ms on the personal-hit path).
- `providerHasCredential` always 1 RT.
- `loadSetupChecklist` drops a `Promise.all` leg.
- ~80 LoC removed from `execution-resolver.ts`, ~200 LoC from `ai-agents.ts`, ~250 LoC from `SettingsPage.tsx`.
- Future plans touching the credential resolver no longer reason about two stores.

What removal does not buy:
- B-1 (batch per-agent SELECTs) and B-4 (denormalize snapshot) from the followup doc are independent levers and still open after this lands.

---

## 4. The two-PR plan

PR A removes code under the existing schema. PR B ships the destructive migration after PR A is verified in prod. The split is required by `.github/workflows/deploy.yml:73-95` running migrations **before** `npx wrangler deploy` at `:129` — a single-PR shape would leave the old Worker reading dropped tables during the deploy window.

### 4.1 PR A — forward-compatible code removal (no migration)

PR A removes every reader, writer, and UI surface for `workspace_provider_secrets` / `workspace_provider_verifications`. The tables stay in the DB. After PR A deploys:
- No code reads from or writes to the workspace tables.
- Existing workspace rows (if any) sit untouched.
- The OAuth scope branches are gone; new OAuth flows pass `scope: 'user'` exclusively.
- The API response drops the `workspace*` fields.
- The SPA renders only the Personal API Keys panel.

**Files changed in PR A** (approximate diff: backend ~+60 / −400, frontend ~+30 / −350):

- `src/clawtalk/agents/execution-resolver.ts` — delete workspace probes in `isAnthropicDirectHttpReady`, `resolveSecret`, `resolveCredentialKindSnapshot`; drop the `origin === 'workspace'` branch in `refreshAndPersist`; remove the `'workspace'` value from the `CredentialOrigin` union.
- `src/clawtalk/agents/execution-planner.ts` — `getAnthropicApiKeyFromDb` becomes personal-only.
- `src/clawtalk/talks/main-talk-bootstrap.ts` — `loadSetupChecklist` drops the workspaceKey leg.
- `src/clawtalk/web/routes/agent-management.ts` — `providerHasCredential` becomes single SELECT + env-key fallback for Anthropic.
- `src/clawtalk/web/routes/ai-agents.ts` — delete `listWorkspaceProviderSecrets`, `listWorkspaceSubscriptionMetadata`, `listWorkspaceProviderVerifications`, `upsertWorkspaceProviderVerification`, `deleteWorkspaceProviderVerification`; remove workspace branches in `verifyProviderSecret`, `putAiProviderCredentialRoute`, `verifyAiProviderCredentialRoute`; drop the workspace-* fields from `AgentProviderCard`; drop `ProviderCredentialScope` (or narrow to `'user'` — recommend delete).
- `src/clawtalk/web/routes/agent-oauth.ts` — delete workspace branches in `persistSubscriptionCredential`, the four OAuth route handlers, and `parseScope`; OAuth-state inserts pass `scope: 'user'` only (the column stays).
- `src/clawtalk/web/worker-app.ts` — drop `c.req.query('scope')` parse on the verify route and the body-scope parsing on OAuth routes.
- `webapp/src/lib/api.ts` — narrow / delete `ProviderCredentialScope`; drop workspace-* fields from the provider card type; remove `scope` argument from credential and OAuth helpers.
- `webapp/src/pages/SettingsPage.tsx` — collapse Personal/Workspace sub-tabs to a single Personal panel; drop `ApiKeysSubTab`, `subTab`, the `draftKey` keyspace, and the second `ProviderCredentialCard` render path. `AnthropicSubscriptionPanel`, `OpenAiCodexSubscriptionPanel` drop their `scope` prop.
- `webapp/src/pages/TalkDetailPage.tsx:2338-2340` — "Configured providers" check becomes `provider.hasCredential || provider.hasPersonalSubscription`. Field name verified against `webapp/src/lib/api.ts:880`.
- `webapp/src/components/RegisteredAgentsPanel.tsx` — `hasApiKey = provider.hasCredential`.
- `webapp/src/pages/SettingsPage.test.tsx` — delete the workspace-tab test; strip workspace fields from fixtures.
- `webapp/src/pages/TalkDetailPage.test.tsx:4862-4870` — strip workspace fields from provider fixtures.

PR A ships **no migration**. The destructive migration is PR B.

### 4.2 PR B — destructive migration

PR B is a single new migration file. No application code changes; the deploy.yml-triggered deploy is still a full Worker + assets redeploy (SPA rebuild, secret sync, asset / queue / cron / DO binding republish via wrangler). PR B may be opened immediately after PR A merges, but **must not merge until §4.4 confirms the workspace tables haven't been written to since PR A's deploy** — the audit query catches the rare race where a stale build is still serving and re-inserts a workspace row.

Migration text (filename `supabase/migrations/0036_drop_workspace_provider_secrets.sql` — next free index per `ls supabase/migrations/ | tail -10`):

```sql
-- 0036_drop_workspace_provider_secrets.sql
--
-- Drop the workspace-shared LLM credential surface. ClawTalk is single-user;
-- the workspace API-key feature (0008/0010) was scaffolding for a multi-user
-- model that the product has not pursued. PR A removed every reader and
-- writer; this migration drops the now-orphan tables.
--
-- The SECURITY DEFINER helper `current_user_is_workspace_admin()` STAYS —
-- it is also referenced by 0019/0020/0023 (workspace_channels,
-- workspace_data_connectors, workspace_slack_installs).
--
-- provider_oauth_states.scope COLUMN STAYS. The CHECK tightens from
-- ('user','workspace') to ('user') only. Any stale 'workspace' rows
-- (lifetime ~10 min) are deleted first so the CHECK can be re-added.

delete from public.provider_oauth_states where scope = 'workspace';

alter table public.provider_oauth_states
  drop constraint if exists provider_oauth_states_scope_check;

alter table public.provider_oauth_states
  add constraint provider_oauth_states_scope_check
    check (scope = 'user');

drop table if exists public.workspace_provider_verifications;
drop table if exists public.workspace_provider_secrets;
```

Migration runs inside Postgres's implicit DDL transaction — either every statement applies or the whole migration rolls back. Verify the constraint name against `\d provider_oauth_states` on a fresh local stack before committing PR B (the inline `check (scope in ('user','workspace'))` from `0010:80` generates the name `provider_oauth_states_scope_check`).

### 4.3 PR A gate — audit current workspace state (run before merging PR A)

Joseph runs this once before merging PR A. The check is not destructive; it informs whether §4.4's data-migration fork will be needed when PR B is prepped.

```sql
select 'secrets' as table_name,
       count(*) as row_count,
       max(updated_at) as last_write
from public.workspace_provider_secrets
union all
select 'verifications', count(*), max(updated_at)
from public.workspace_provider_verifications
union all
select 'oauth_states_workspace_active', count(*), max(created_at)
from public.provider_oauth_states
where scope = 'workspace' and consumed_at is null and expires_at > now();
```

Expected: all three `row_count = 0`. If `secrets.row_count > 0`, the §4.4 data-migration fork applies between PR A and PR B.

### 4.4 PR B gate — final audit and data-migration fork

Re-run the §4.3 query after PR A has been deployed and the §4.6 soak criteria are satisfied (see §4.6 for the specific signals; minimum ≥24h prod soak). The `secrets` row count should still match what it was at §4.3 — PR A's writer removal means nothing new can land. If row count is 0, run PR B's migration.

If `secrets.row_count > 0`, run the data-migration fork before merging PR B. The fork is four explicit steps — `look up owner` → `report` → `copy non-conflicting rows` → `delete migrated and discarded source rows` → `re-audit` — so the post-fork audit can actually return zero.

**Run all four steps as the Supabase postgres role** (the same connection `deploy.yml:84` uses for `supabase db push`). Authenticated-user psql sessions will hit RLS on the `llm_provider_secrets` INSERT (requires `owner_id = auth.uid()` per `0002_rls_policies.sql:53`) and on the workspace DELETE (requires `current_user_is_workspace_admin()` per `0008_workspace_provider_secrets.sql:53`).

**Step 0 — capture Joseph's owner_id once.** Used as `:joseph_uuid` in Steps 1 / 2:

```sql
select id as joseph_uuid
from public.users
where email = 'jokim1@gmail.com';
\gset
```

(Steps 1 and 2 below reference `:joseph_uuid`; psql substitutes the value captured by `\gset`. If you're running outside psql, paste the UUID into the literal `'<joseph-uuid>'` slots.)

**Step 1 — report (read-only).** Lists every workspace row and whether a personal row already exists for the same `(owner_id, provider_id, credential_kind)`:

```sql
select wps.provider_id,
       wps.credential_kind,
       wps.enc_key_version,
       wps.updated_at as workspace_updated_at,
       exists (
         select 1 from public.llm_provider_secrets lps
         where lps.owner_id = :'joseph_uuid'::uuid
           and lps.provider_id = wps.provider_id
           and lps.credential_kind = wps.credential_kind
       ) as personal_row_exists
from public.workspace_provider_secrets wps;
```

**Step 2 — copy non-conflicting workspace rows into personal.** Inserts only the workspace rows that have no matching personal row. Preserves `enc_key_version` so ciphertext stays decryptable across all key versions:

```sql
insert into public.llm_provider_secrets (
  owner_id, provider_id, credential_kind, enc_key_version, ciphertext,
  encrypted_refresh_token, expires_at
)
select :'joseph_uuid'::uuid, wps.provider_id, wps.credential_kind,
       wps.enc_key_version, wps.ciphertext, wps.encrypted_refresh_token,
       wps.expires_at
from public.workspace_provider_secrets wps
where not exists (
  select 1 from public.llm_provider_secrets lps
  where lps.owner_id = :'joseph_uuid'::uuid
    and lps.provider_id = wps.provider_id
    and lps.credential_kind = wps.credential_kind
);
```

**Step 3 — delete source rows.** Removes both the rows we just migrated AND the rows where a personal row already existed (those workspace copies are intentionally discarded, since the personal row already wins under the resolver's precedence). Joseph confirms the discard in PR B's description: "rows X, Y intentionally discarded; personal copy wins." If he wants to keep a workspace copy instead, he deletes the personal row first and re-runs Step 2 before running Step 3:

```sql
delete from public.workspace_provider_secrets;
```

(`delete from ... where true` is implied by the empty `where` clause; an unrestricted delete is intentional here because Step 2's INSERT plus the explicit "discard the rest" decision covers every row.)

**Step 4 — re-audit.** Re-run the §4.3 query. `secrets.row_count` must equal 0 before PR B merges. If non-zero, do not proceed — investigate which row Steps 2/3 missed and update the fork.

If the §4.3 audit at PR A time already returned 0 (the expected path on Joseph's setup), Steps 0-4 are skipped entirely and PR B's migration runs against an empty table.

### 4.5 Local verification (per PR)

PR A:
```bash
npm run typecheck
npm --prefix webapp run typecheck
npm run test                              # backend vitest
npm --prefix webapp run test              # webapp vitest (local-only per [[feedback-webapp-tests-not-in-ci]])
npm run format:check
```

PR B:
```bash
npm run db:start
supabase migration up                     # applies through 0036
psql $LOCAL_DATABASE_URL -c "\d workspace_provider_secrets"   # expect: "relation does not exist"
psql $LOCAL_DATABASE_URL -c "\d+ provider_oauth_states"       # expect: CHECK (scope = 'user') only
npm run typecheck                                              # no changes, should be a no-op
```

### 4.6 Post-deploy verification

PR A:
- Bench haiku n=10 at N=1 and N=3 (`scripts/latency-bench.ts`, per [[feedback-close-clawtalk-tabs-before-bench]]). Median `agent_loop_iter_*_resolveCredentialKindSnapshot` should drop from ~248 ms to ≤140 ms; iteration total drops ~125 ms × N.
- `wrangler tail` clean for 60 min: zero new `ExecutionResolverError`, zero `PROVIDER_SECRET_MISSING` from the bench user, zero 500s on `/api/v1/agents/providers/:id` routes.
- Smoke `/api/v1/agents`: response no longer carries `workspace*` fields.
- SPA: SettingsPage shows only the Personal panel; TalkDetailPage's "Configured providers" still resolves correctly without the workspace branch.
- Model discovery: providers with only a workspace API key (NVIDIA, Anthropic) fall back to curated rows. **Expected degraded state.** Verify on the AI Agents page that the model dropdown is non-empty for any provider that had a personal key.

**PR A → PR B gate (the "~24h soak" — explicit success criteria):** PR B opens only once **all four** of these hold:
1. PR A has been deployed to prod for ≥24 hours.
2. `wrangler tail` shows zero `ExecutionResolverError` events with a `provider_id` in the §4.3 workspace-audit provider list. (Runtime errors don't carry credential-origin metadata — `execution-resolver.ts:92` records only `message`+`code`. The §4.3 audit captures the provider IDs that had workspace credentials pre-PR-A; Joseph filters tail by `provider_id` against that list.)
3. `wrangler tail` shows zero `PROVIDER_SECRET_MISSING` events for any provider in the §4.3 audit list (same cross-reference pattern as #2).
4. Bench median `resolveCredentialKindSnapshot` ≤140 ms on a fresh haiku N=1 + N=3 run.

If any of (1)–(4) fails, hold PR B. Investigate before re-arming.

PR B:
- `wrangler tail` clean for 60 min: same shape as PR A's check; the deployed Worker has no application code changes but the deploy is still a full Worker + assets redeploy (rebuilds SPA, syncs secrets, re-publishes assets / queues / cron / DO bindings via wrangler).
- `\d workspace_provider_secrets` on prod returns "relation does not exist."
- `\d+ provider_oauth_states` on prod shows `CHECK (scope = 'user')` only.

### 4.7 Out of scope (explicit)

- **`current_user_is_workspace_admin()` removal.** Stays; referenced by 0019/0020/0023.
- **`provider_oauth_states.scope` column removal.** CHECK tightens; column stays.
- **`isAnthropicDirectHttpReady` `credential_kind = 'api_key'` filter.** Latent imprecision in `execution-resolver.ts:187-198` (query reads any kind despite the comment). Not introduced by this plan; not fixed by this plan. Separate follow-up if it matters.
- **`docs/11-data-model.md` workspace-credential references** (`:30-32, 392, 414, 632-637`). The data-model redesign owns those lines.
- **B-1 / B-4** levers from the followup doc. Separate plans.
- **`ensureTalkUsesUsableDefaultAgent` ~748 ms.** Separate plan.

---

## 5. Risks

1. **Grandfathered data on `workspace_provider_secrets`.** §4.3 audit catches at PR A time; §4.4 fork between PR A and PR B preserves anything found. The destructive drop in PR B's migration only runs after §4.4 confirms `row_count = 0`. **Mitigation:** human gate in PR B description requires Joseph to paste the audit result.
2. **In-flight workspace OAuth state.** Workspace OAuth rows expire in ~10 min. PR A removes the writer; no new workspace OAuth states can be created after PR A deploys. §4.4 confirms `oauth_states_workspace_active = 0` before PR B's migration tightens the CHECK. **Mitigation:** wait until any in-flight rows expire (worst case ~10 min).
3. **PR A revert.** If PR A regresses something visible (UI / API), revert is safe — workspace tables are still in the DB, the prior code resumes reading them, no data lost. Standard `git revert + redeploy` works.
4. **PR B revert is hard.** `DROP TABLE` cannot be reversed by a code revert. If something needs the workspace table back, the table must be recreated by re-running the 0008+0010 DDL manually (no ciphertext data — that's gone). In practice, PR B only ships when PR A has been live ~24h with zero incidents; the rollback risk is structural, not data.
5. **Bench post-deploy may still measure 2 RTs.** The bench user `bench-haiku` may hit env-key fallback (no personal Anthropic credential). Verify the resolver path via `wrangler tail` sub_phase logs, not just the bench median.
6. **Provider card UI regression.** Workspace sub-tab disappears. Personal panel is the sole API Keys panel. Acceptable for solo-user; document in PR A's description.
7. **`ProviderCredentialScope` type deletion ripples.** `webapp/src/lib/api.ts` exports it; `SettingsPage.tsx`, `TalkDetailPage.tsx`, `RegisteredAgentsPanel.tsx` import it. PR A deletes the type and all imports; typecheck catches any missed call site.
8. **External multi-user customer arrives someday.** Implicit cost of removal. Per [[feedback-solo-user-ship-fast]] this is acceptable. A future multi-user mode should build per-org tables with proper `org_id` partitioning, not re-introduce the global RLS-`using (true)` shape from 0008/0010.

---

## 6. What lands per PR

Counts below use the "files touched" convention so the numbers match PR-stat output.

**PR A** — ~9 backend files (execution-resolver, execution-planner, main-talk-bootstrap, agent-management, ai-agents, agent-oauth, worker-app, plus 2 test files) + ~5 webapp files (lib/api, SettingsPage, SettingsPage.test, TalkDetailPage, TalkDetailPage.test, RegisteredAgentsPanel). Approximate diff: backend ~+60 / −400, frontend ~+30 / −350. No migration.

**PR B** — 1 new migration file (`0036_drop_workspace_provider_secrets.sql`). Approximate diff: ~+25 / 0. No application code changes; the deploy.yml-triggered deploy is still a full Worker + assets redeploy (SPA rebuild, secret sync, asset / queue / cron / DO binding republish via wrangler), so monitor the deploy log even though the application surface is unchanged.

Sequencing is documented in §4. Both PRs squash-merge on green CI.

---

## 7. Tests

Test changes live in three files. PR A ships all of them. PR B ships none (no code paths to test — the migration applies and verifies in `4.5 PR B local verification`).

```
CODE PATHS                                            USER FLOWS
[~] resolveCredentialKindSnapshot                    [-] Personal API key (no change)
  └── [★★ Test 1] returns personal credential_kind     └── [★★ Test 1]
      when personal row exists
[~] resolveSecret                                    [-] Personal OAuth subscription (no change)
  └── [★★ Test 2] returns 'subscription' from          └── [★★ Test 2]
      personal OAuth row
[~] resolveSecret env fallback (Anthropic)           [-] Env-only Anthropic (no change)
  └── [★★ Test 3] returns env api_key when             └── [★★ Test 3]
      no personal row exists
[+] resolveCredentialKindSnapshot — personal-miss    [+] Workspace-shaped agent
  └── [★★★ Test 4] returns null when personal           └── [★★★ Test 4] surfaces
      row is absent and pinnedMode='subscription'         PROVIDER_SECRET_MISSING
[+] providerHasCredential — no workspace             [+] Agent card readiness
  └── [★★★ Test 5] returns false for non-Anthropic     └── [★★★ Test 5] no false
      provider with no personal row                       "ready" state
[+] loadSetupChecklist — no workspace leg            [+] Setup checklist
  └── [★★ Test 6] hasProviderKey reads only from       └── [★★ Test 6] checklist accurate
      personal table

COVERAGE: 3 unchanged + 3 added; QUALITY: ★★★:2 ★★:4

LEGEND: [~] modified path, [-] no flow change, [+] new test, ★ = quality stars.
```

**File ownership:**
- Tests 1-4 live in `src/clawtalk/agents/execution-resolver.test.ts` (extends the existing suite).
- Test 5 lives in `src/clawtalk/web/routes/agent-management.test.ts` (create if it doesn't exist; `providerHasCredential` is a private helper, so Test 5 asserts indirectly via `buildExecutionPreview`'s `reasonCode: 'credential_missing'` path).
- Test 6 lives in `src/clawtalk/talks/main-talk-bootstrap.test.ts` (create if it doesn't exist; `loadSetupChecklist` is private, so Test 6 asserts via the welcome-banner output or `hasProviderKey` boolean if surfaced).

**Test data discipline:**
- All tests seed and assert against the **pre-migration schema** (workspace tables still exist; PR A's code just doesn't reference them).
- A workspace row may be seeded as a negative control ("agent ignores it"), but no test asserts the workspace table is dropped — that's PR B's `\d` check in §4.5.
- All tests use `seedAuthUser` + `withUserContext(USER_ID, ...)` per the existing pattern in `execution-resolver.test.ts`.

Frontend tests: `SettingsPage.test.tsx` drops the workspace-tab test. `TalkDetailPage.test.tsx` strips workspace fields from provider fixtures. No new frontend tests required (deletion-only). Webapp suite is not in CI ([[feedback-webapp-tests-not-in-ci]]) — verify locally.

---

## 8. Failure modes (changed paths only)

| Codepath | Realistic failure mode | Test covers? | Error handling? | User visibility? |
|---|---|---|---|---|
| `resolveCredentialKindSnapshot` post-removal (PR A) | Agent that depended on a workspace-only credential returns null | Test 4 | Resolver propagates null → executor surfaces `PROVIDER_SECRET_MISSING` at run start | "No API credentials" error in the SPA |
| `providerHasCredential` post-removal (PR A) | Agent card shows "credential missing" | Test 5 | UI shows `credential_missing` reason on the agent card | Visible on AI Agents page |
| `loadSetupChecklist` post-removal (PR A) | Welcome banner shows "Add an LLM provider key" even though a workspace key existed | Test 6 | `hasProviderKey` boolean is correct (personal-only) | Welcome banner item state |
| Model discovery falls back to curated rows (PR A) | NVIDIA / Anthropic discovery uses curated `llm_provider_models` instead of live `/v1/models` | Verified in §4.6 PR A post-deploy | Curated rows render unchanged | Smaller model dropdown for affected providers |
| Old Worker reading dropped tables (rolled out PR B before PR A) | "relation does not exist" 500 | n/a (sequencing prevents) | Stop-the-line | API errors on `/api/v1/agents/*` |
| `DROP TABLE workspace_provider_secrets` (PR B) | Existing row data lost | §4.4 audit + fork | PR B refuses to merge if §4.4 row count > 0 | Run-time errors if workspace keys were live (caught by §4.4) |
| `DROP TABLE workspace_provider_verifications` (PR B) | Verification status lost | n/a (verifications recomputable) | Re-verify on next save | "Not verified" badge until re-save |
| Tighten `provider_oauth_states.scope` CHECK (PR B) | In-flight workspace OAuth flow fails on completion | §4.3 + §4.4 audits | Existing rows deleted by migration; new rows can't be created (PR A removed the writer) | None in practice |

**Critical gaps:** none. The two-PR shape removes the deploy-window race; the §4.3 + §4.4 gates remove the data-loss risk.

---

## 9. Implementation tasks

Time annotations: `(P1, human: ~X min, CC: ~Y min)` — `human` is wall-clock time Joseph spends in psql / PR review / tail watching; `CC` is Claude-Code edit time. "CC: instant" marks tasks with no agent work.

### PR A — code removal

- [ ] **B3-A1 (P1, human: ~5 min, CC: instant)** — Joseph runs §4.3 audit on prod. Records counts in PR A's description.
  - Files: none
  - Verify: row counts captured

- [ ] **B3-A2 (P1, human: ~5 min, CC: ~45 min)** — Remove backend writers: `execution-resolver.ts:462-471`, `ai-agents.ts:674-704`, `ai-agents.ts:797-1078` (workspace branches only), `agent-oauth.ts:89-106`, `agent-oauth.ts:229/288/344/417`, `worker-app.ts:505`.
  - Files: 4 source files
  - Verify: typecheck + format:check pass

- [ ] **B3-A3 (P1, human: ~5 min, CC: ~30 min)** — Remove backend readers: `execution-resolver.ts:202-208/266-278/336-369`, `execution-planner.ts:164-167`, `agent-management.ts:74-79`, `main-talk-bootstrap.ts:121-124`, `ai-agents.ts:318-401` (list helpers + workspace fields on `AgentProviderCard`).
  - Files: 5 source files
  - Verify: typecheck + format:check pass

- [ ] **B3-A4 (P1, human: ~2 min, CC: ~15 min)** — Drop `ProviderCredentialScope`, `parseScope`. Tighten any `scope` body parsing on OAuth routes to refuse non-`'user'` values (HTTP 400).
  - Files: 2 source files
  - Verify: typecheck pass

- [ ] **B3-A5 (P1, human: ~5 min, CC: ~45 min)** — Frontend: collapse SettingsPage to single Personal panel; trim `subTab`/`ApiKeysSubTab`/`draftKey`; remove workspace branches from `AnthropicSubscriptionPanel`, `OpenAiCodexSubscriptionPanel`, `RegisteredAgentsPanel.tsx`. Update `webapp/src/lib/api.ts` (drop type + workspace-* fields + `scope` args). Update `TalkDetailPage.tsx:2338-2340` to drop workspace branches. Strip workspace fields from `SettingsPage.test.tsx`, `TalkDetailPage.test.tsx` fixtures.
  - Files: 6 webapp files
  - Verify: webapp typecheck + webapp vitest pass locally

- [ ] **B3-A6 (P1, human: ~5 min, CC: ~30 min)** — Add Tests 4 / 5 / 6 per §7 in their respective files.
  - Files: 3 test files
  - Verify: full backend vitest pass

- [ ] **B3-A7 (P1, human: ~30 min, CC: ~15 min)** — Push PR A. Run `/codex review` + `/karpathy-audit diff` on the diff. Absorb findings. Squash-merge.
  - Files: PR metadata
  - Verify: codex PASS, karpathy PASS, deploy.yml succeeds

- [ ] **B3-A8 (P1, human: ~30 min, CC: instant)** — §4.6 PR A post-deploy verification.
  - Files: none (bench + tail)
  - Verify: predicted ~125 ms drop in `resolveCredentialKindSnapshot` p50; no new errors

### PR B — destructive migration (after PR A meets the §4.6 soak criteria)

- [ ] **B3-B1 (P1, human: ~5 min, CC: instant)** — Joseph re-runs §4.3 audit on prod. Counts unchanged from B3-A1 (writers were already gone after PR A).
  - Files: none
  - Verify: row counts captured in PR B description

- [ ] **B3-B2 (P1, human: ~15 min, CC: instant, only if `secrets.row_count > 0`)** — Run §4.4 data-migration fork Steps 1-4 (report → copy → delete → re-audit). Confirm `secrets.row_count = 0` before opening PR B.
  - Files: none
  - Verify: post-fork count = 0

- [ ] **B3-B3 (P1, human: ~2 min, CC: ~10 min)** — Add migration `0036_drop_workspace_provider_secrets.sql` per §4.2 (confirm next free index at commit time).
  - Files: 1 new migration
  - Verify: §4.5 PR B local verification passes

- [ ] **B3-B4 (P1, human: ~20 min, CC: ~10 min)** — Push PR B. Run `/codex review` on the migration diff. Squash-merge.
  - Files: PR metadata
  - Verify: codex PASS, deploy.yml succeeds

- [ ] **B3-B5 (P1, human: ~15 min, CC: ~5 min)** — §4.6 PR B post-deploy verification + update [[project-llm-turn-latency]] memory + r5 footer on this doc marking B-3 SHIPPED.
  - Files: this doc footer, memory
  - Verify: workspace tables gone from prod; bench results recorded

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests | 0 | not run | Skipped — codex + karpathy cover the same ground for this scope. |
| Codex Consult (r1) | `/codex consult` on r1 | Independent 2nd opinion | 1 | ABSORBED | 16 findings (3 critical, 5 high, 7 medium, 1 low). Raw output `.codex-r1-findings.txt`. |
| Codex Consult (r2) | `/codex consult` on r2 | Independent 2nd opinion | 1 | ABSORBED | 12 findings (6 critical, 6 advisory). Raw output `.codex-r2-findings.txt`. r3 absorbs all 6 P1 + key P2s. |
| Codex Consult (r3) | `/codex consult` on r3 | Verify staged-deploy framing | 1 | ABSORBED | 4 findings (1 P1, 3 P2): §4.4 INSERT-no-DELETE contradiction, missing `enc_key_version`, "no-op" framing, invented `hasSubscription` field. Raw output `.codex-r3-findings.txt`. r4 fixes all four. |
| Codex Consult (r4) | `/codex consult` on r4 | Verify §4.4 fork + naming fixes | 1 | ABSORBED | 4 findings, all P2: §4.2 "no-op" residue, soak criterion (2) unverifiable, §4.4 DB-role missing, `<joseph-uuid>` lookup needed. Raw output `.codex-r4-findings.txt`. r5 fixes all four. |
| Codex Consult (r5) | `/codex consult` on r5 | Verify polish-pass fixes | 0 | pending | Will run on r5 commit. |
| Karpathy Audit (r1) | manual | Style lens + four principles | 1 | ABSORBED | 1 warning, 2 nits. Reframed §1 in r2 to defer to §4.5. |
| Karpathy Audit (r2) | manual | Style lens + four principles | 1 | ABSORBED | 6 findings (3 critical, 2 warning, 1 nit). r3 fixes §4.2/§4.3 contradiction, field naming, §6 dup, §7 test reconciliation. |
| Karpathy Audit (r3) | manual | Style lens + four principles | 1 | ABSORBED | 6 findings (2 critical, 3 warning, 1 nit): §4.4 contradiction (overlap with codex P1), invented field name (overlap with codex P2 #4), §6 "no-op" framing (overlap), `enc_key_version` (overlap), file-count ambiguity, missing soak success criteria, §9 task-time syntax. Cross-revision overlap noted in r4 revision-history block. |
| Karpathy Audit (r4) | manual | Style lens + four principles | 1 | ABSORBED | 4 findings (0 critical, 3 warning, 1 nit). 4-of-4 overlap with codex r4 + 1 karpathy-unique observation on long-term revision-history accumulation cost (deferred to r6+). |
| Karpathy Audit (r5) | manual | Style lens + four principles | 0 | pending | Will run alongside codex r5. |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | Not run — scope is "remove dead surface in a solo-user product." |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | Not run — UI change is sub-tab removal; low risk. |
| DX Review | `/plan-devex-review` | DX gaps | 0 | — | Not run. |

**VERDICT (r5):** **DRAFT — pending review.** r5 absorbs the four codex r4 + four karpathy r4 P2 advisories as a ~10-LoC polish pass on §4.2 / §4.4 / §4.6. The structural shape (two-PR rollout, RLS helper preserved, scope contradiction resolved, four-step fork) has been stable since r3; r4 closed the identifier-precision channel; r5 closes the operational-precision channel (DB role, UUID lookup, verifiable soak criteria, framing parity). Critical pre-implementation constraints (unchanged from r4):

1. **PR A must merge and meet §4.6's soak criteria before PR B opens.** All four conditions (≥24h, zero ExecutionResolverError, zero PROVIDER_SECRET_MISSING from workspace-served providers, bench median ≤140 ms).
2. **Migration filename re-verified at commit time** against `supabase/migrations/`.
3. **`current_user_is_workspace_admin()` stays.** Don't add a DROP FUNCTION line to PR B.
4. **`provider_oauth_states.scope` column and NOT NULL stay.** Only the CHECK tightens.
5. **`docs/11-data-model.md` workspace references** are deferred to the data-model redesign owner; do not touch in this plan.
6. **All TypeScript identifiers in §2.4 and §4.1 were verified against `webapp/src/lib/api.ts` at r4 commit-time.** Don't reintroduce invented names; round-trip new ones through the source file before adding them.
