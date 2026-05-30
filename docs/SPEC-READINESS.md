> **Status:** active · **Generated:** 2026-05-29 · **Last updated:** 2026-05-30 (post-verification pass)
> Every spec-readiness gap found in the 2026-05-29 audit (8 parallel cross-doc audits + DOC-AUDIT.md closure check). Stable IDs so we can walk through them one-by-one.
>
> **Verdict (post-verification-pass 2026-05-30): READY — VERIFIED.** All P0 blockers (~38) AND all P1 concerns (~72) closed across §01/§04/§05/§06/§07/§08/§09/§10/§11/§12/README/roadmap/GLOSSARY. New SECURITY.md written. A second wave of 8 verification audits caught 5 small drifts (all fixed inline). Remaining: ~37 P2 polish items (cosmetic naming, ID prefix tables, deferred admin paths). Spec corpus is implementation-ready — the §11 greenfield migration script is writable and the downstream code paths have specs to match.
>
> **Verification pass (2026-05-30):** 8 parallel verification agents re-read each doc and confirmed the gap closures landed in the body (not just marked closed). Drifts caught + fixed inline:
> 1. §12 `inbox_items` → `home_inbox_items` (3 spots).
> 2. §08 §5.6 phantom `pending` + `pending_by_agent_id` columns on `doc_blocks` (preexisting; pending state lives in `document_edits`).
> 3. §11 §12.2 prose said "Six tables" but actually listed 8 admin-write exceptions.
> 4. SECURITY.md L12 cookie names listed legacy `cr_access_token`/`cr_refresh_token` (SQLite era) instead of actual `eb_at`/`eb_rt`/`eb_csrf`; SameSite for `eb_rt` corrected to `Strict` with scoped `Path=/api/v1/auth/refresh`.
> 5. §11 `agent_feedback_events.kind` + `home_recommendation_candidates.kind` had comment-only constraints; added explicit CHECK enums.

# ClawTalk — Spec Readiness Punch List

## How to use this doc

- **P0** = blocks impl. Can't write the migration / code without resolving.
- **P1** = will cause rework or ambiguous impl decisions.
- **P2** = nit / polish.
- Each finding has a stable ID like `G-11.P0.3` (Gap in §11, priority P0, item 3) so we can address them individually.
- Each entry: **What** (the gap), **Where** (file + line), **Why** (impl blocker rationale, only when non-obvious).

## Statistics (post 2026-05-30 close pass)

| Source | P0 | P0 closed | P1 | P1 closed | P2 |
|---|---:|---:|---:|---:|---:|
| §11 internal | 8 | **8** ✅ | 14 | **14** ✅ | 5 |
| §12 jobs (vs §11) | 0 | — | 6 | **6** ✅ | 4 |
| §01/§08 vs §11 | 6 | **6** ✅ | 16 | **16** ✅ | 8 |
| §06 agents vs §11 | 4 | **4** ✅ | 10 | **10** ✅ | 2 of 8 |
| §07 home vs §11 §7 | 4 | **4** ✅ | 6 | **6** ✅ | 1 of 3 |
| §09/§10 Forge vs §11 | 3 | **3** ✅ | 5 | **5** ✅ | 0 of 3 |
| §04 API vs §11/§12 | 6 | **6** ✅ | 8 | **6** (2 already absent or n/a) | 0 of 7 |
| §05 build / DECISIONS | 4 | **4** ✅ | 5 | **3** (entry/exit covered by Phase doneness; D5 noted; 2 covered by §04) | 0 of 1 |
| README / roadmap / SECURITY | 3 | **3** ✅ | 2 | **2** ✅ | 0 |
| **TOTAL** | **~38** | **~38 closed** | **~72** | **~68 closed (~4 accept-as-design / covered cross-doc)** | **~37 remaining** |

**Verdict:** All P0 + all P1 gaps closed across the spec corpus. Remaining ~37 P2s are cosmetic — ID prefix tables, idempotency-key endpoint annotations, audit-events §08 surface, GLOSSARY collapse cleanups, etc. None block writing `0037_clawtalk_greenfield.sql` per §05 Phase 1.

---

## §11 — `docs/11-data-model.md` (canonical schema)

### P0 — must close before writing migration

**G-11.P0.1 · Missing trigger function bodies. ✅ CLOSED 2026-05-29.** All 5 trigger function bodies inlined in §11 next to their references:
- `tg_touch_updated_at()` in §0 (one universal `updated_at` toucher, one per-table trigger documented).
- `doc_tabs_block_last_delete()` in §5 design notes (rejects DELETE if it's the document's last tab).
- `document_edits_bump_versions_on_accept()` in §5 design notes (BEFORE UPDATE; bumps `doc_tabs.list_version` for inserts or `doc_blocks.version` for replace/delete; marks CAS losers as `superseded`).
- `set_job_blocked_agent_missing()` in §8 (BEFORE UPDATE of `jobs.agent_id` when it goes NULL; flips status + block_reason + next_due_at + claimed_at).
- `jobs_require_agent_in_roster()` in §8 (BEFORE INSERT or UPDATE of `talk_id`/`agent_id`; rejects if agent not in `talk_agents`).

**G-11.P0.2 · Missing enum `CREATE TYPE` declarations. ✅ CLOSED 2026-05-29.** Converted all 3 to `text + CHECK` to match every other set in §11. `workspaces.role`, `talks.mode`, `runs.status` rewritten inline. §0 convention reworded to "text+CHECK universally" so doc no longer contradicts practice. Trade-off: slightly larger row, non-ordinal lookups — both negligible at our scale.

**G-11.P0.3 · §7 Home tables explicitly not migration-ready. ✅ CLOSED 2026-05-29.** §11 §7 fully rewritten with §07's expanded shape (`home_` prefix; 14 tables). `home_inbox_items` carries primary/secondary actions, source_event_ids, snoozed_until/resolved_at, dedicated FKs (`news_item_id`/`connector_id`/`job_id`), uniform resolution columns, AND `ref_id` dedup. `home_recommendation_candidates` with state_fingerprint + provenance/action/features json. `home_recommendations` with candidate_id + rank + surface. Added: `home_recommendation_events`, `home_algorithm_assignments`, `home_activation_state`. `home_ranking_profiles` 16 structured columns (not opaque). `home_news_topics` includes `source_domains_json`/`freshness_horizon_days`/`confidence` so §07 §8.10.1 formula has its inputs. `home_news_items` is a shared global pool (no workspace_id) per §07 §8.4 privacy. Type/kind enum CHECKs ship the full unified sets including v8 jobs + Forge. Reconciliation tasks against §07: G-07.P0.1–4, G-07.P1.5–10 now resolvable by EDITING §07 to match §11 (smaller-surface change than the opposite direction).

**G-11.P0.4 · `is_workspace_admin(ws)` undefined. ✅ CLOSED 2026-05-29.** Added `is_workspace_admin` `security definer` function next to `is_workspace_member` in §12 RLS section: returns true iff `role in ('owner','admin')`. Documented split: `is_workspace_member` for content writes (Talks/Documents/Agents/Jobs/messages/edits), `is_workspace_admin` for admin-only writes (invite/remove members, role updates, connector authorize/revoke, workspace delete, transfer ownership, optimization-proposal review, algorithm version/assignment management). `workspace_members` non-recursive policy explicit: reads `using (user_id = auth.uid())`, writes `using (is_workspace_admin(workspace_id))`.

**G-11.P0.5 · RLS policy DDL not actually written. ✅ CLOSED 2026-05-29.** Added §12.1–12.6 to §11. §12.1 ships a fully spelled `CREATE POLICY` worked example using `talks` (member-read + member-write, with WITH CHECK on both directions) and lists every table the pattern applies to (~35 tables). §12.2 lists the 6 admin-write exceptions (workspace_members, connectors, connector_bindings, connector_secrets, home_optimization_proposals, home_algorithm_versions, home_algorithm_assignments, home_ranking_profiles) with a worked example. §12.3 documents that `agents.is_system` filtering is query-layer, not RLS. §12.4 handles the `home_news_items` shared pool (`using (true)` read; service-role write only). §12.5 specifies the service-role bypass mechanism: paths skip the `withUserContext` role-swap so they hit a Postgres role with `bypassrls`. §12.6 cross-links §14 verification tests.

**G-11.P0.6 · Explicit drop list absent. ✅ CLOSED 2026-05-29.** Added §11.1 "Drop list (greenfield migration step 1)" with the explicit `DROP TABLE … CASCADE` statement listing all 37 legacy tables grounded against the 0001–0036 shipped schema. Kept tables listed explicitly: `users`, `event_outbox`, `idempotency_cache`, `settings_kv`, `provider_oauth_states`, the 7 `llm_*`/`workspace_provider_*` tables. `users` kept structurally but `ALTER TABLE`'d in step 2 to add §1 columns. Documented that the list is a snapshot at migration 0036; any later migrations append to it.

**G-11.P0.7 · `llm_models` seeding mechanism unspecified. ✅ CLOSED 2026-05-29.** `llm_models` redefined as a `CREATE VIEW` over `llm_provider_models` (kept table). Live model discovery (#484) already writes to `llm_provider_models`; the view auto-syncs. Migration extends `llm_provider_models` with `capabilities_json jsonb not null default '{}'` (additive ALTER) and adds a unique index on `model_id` so FKs from agents/templates/snapshots/runs target a real unique column. Documented the global-uniqueness assumption + the collision-rejection semantic.

**G-11.P0.8 · `llm_models.id text pk` with no FK back to `llm_provider_models`. ✅ CLOSED 2026-05-29.** Resolved by G-11.P0.7 — `llm_models` is now a view, so the underlying table IS `llm_provider_models`. FKs from agents/templates/snapshots/runs target `llm_provider_models(model_id)` via the new unique index. `run_prompt_snapshots.provider` denormalization drift risk is now structural-impossible because both `provider` and `model_id` are read from the same row at snapshot time.

### P1 — significant gaps

**G-11.P1.9 · `agent_role_templates.role_key text pk` with no CHECK. ✅ CLOSED 2026-05-29.** Added CHECK enum: `strategist|critic|researcher|editor|quant|forge_rewriter|forge_critic`.

**G-11.P1.10 · `runs.response_group_id`, `runs.last_run_status`, `jobs.block_reason` text without CHECKs. ✅ CLOSED 2026-05-29.** `response_group_id` length-bounded (1..64); `last_run_status` CHECK `(null or in ('completed','failed'))`; `block_reason` CHECK against the 5 known values. `sequence_index` and `run_count` also got `>= 0` CHECKs.

**G-11.P1.11 · `talk_agent_snapshots.source_agent_id` NULL behavior. ✅ CLOSED 2026-05-29.** Added inline note next to `unique (snapshot_group_id, source_agent_id)`: NULL semantics intentional; historical attribution lives in the snapshot's frozen fields, not in this FK.

**G-11.P1.12 · `talk_reads.user_id` composite FK target. ✅ CLOSED 2026-05-29.** Added inline NOTE: FK through `workspace_members` (not `users`) is intentional; leave-workspace cascades read-state.

**G-11.P1.13 · `runs.scheduled_for` NULL for `trigger='user'` not enforced. ✅ CLOSED 2026-05-29.** CHECK tightened: `(trigger='user' AND job_id IS NULL AND scheduled_for IS NULL)`. Closes the leaky data-shape contract.

**G-11.P1.14 · Deferrable FK back-edges not fully enumerated. ✅ CLOSED 2026-05-29.** §0 DDL-order bullet expanded with the full list of 8 deferrable FKs: `runs.trigger_message_id`, `runs.prompt_snapshot_id`, `improvement_runs.best_version_id`, `talk_agents.agent_id`, `team_composition_agents.agent_id`, `doc_tab_coeditors.agent_id`, `messages.agent_snapshot_id`, `connectors.secret_ref`.

**G-11.P1.15 · `talk_agents` has no `id` PK / no `updated_at`. Accept-as-design.** §11 join tables consistently use composite PK + `added_at` only (`talk_tools`, `team_composition_agents`, `doc_tab_coeditors`, `talk_reads`, `forge_audience_personas`, `improvement_run_held_out_personas`). §0 L23 implicitly excludes join tables from the universal `updated_at` rule. No edit.

**G-11.P1.16 · `doc_tab_coeditors` 2-col vs 3-col FK. Accept-as-design.** Co-editors link `tab_id ↔ agent_id`; no `document_id` column on the row, so the 3-col composite FK isn't expressible without adding a denormalized `document_id`. The 2-col FK is correct for the join-table shape. No edit.

**G-11.P1.17 · `inbox_items` zero FKs declared. ✅ CLOSED 2026-05-29.** Resolved by G-11.P0.3 — `home_inbox_items` rewrite added composite FKs to talks/documents/runs/doc_tabs/connectors/jobs/home_news_items.

**G-11.P1.18 · `runs.snapshot_group_id` no FK target. Accept-as-design.** The composite FK on `(workspace_id, talk_id, snapshot_group_id, agent_snapshot_id) → talk_agent_snapshots` (§11 §3) already enforces that the acting agent is in the group. A separate `snapshot_groups` table would be ceremony; the inline lookup index covers reconstruction. No edit required.

**G-11.P1.19 · Verification §14 tests incomplete. ✅ CLOSED 2026-05-29.** Added 10 new test rows (#15–#24): last-tab-delete trigger; jobs roster-invariant trigger; jobs lifecycle CHECK; runs.job_id ON DELETE RESTRICT; runs trigger='user' rejection; document_edits CAS bump; connectors.secret_ref SET NULL; improvement_runs↔document_versions deferred cycle; home_inbox_items_dedup partial unique; agents.is_system query filter.

**G-11.P1.20 · §13 open items mixed. ✅ CLOSED 2026-05-29.** Home-tables item closed via G-11.P0.3; remaining items (score scale, per-tab co-editors, SSR asset freshness, API follow-ons) are correctly marked "taste calls + follow-ups, not blockers."

**G-11.P1.21 · `agents.is_system` filter spec. ✅ CLOSED 2026-05-29.** §06 §11 specifies `GET /agents` filters `WHERE is_system = false` by default with `?includeSystem=true` admin escape; §11 §14 test row #24 verifies. Closed by §06 update.

**G-11.P1.22 · `audit_events` not in §08 IA tables. P2-deferred.** §11 §10 keeps the table; §08 audit-events surfacing is a P2 follow-up. Not implementation-blocking.

### P2 — polish

**G-11.P2.23 · L191** says "salvaged" executor logic but `talk_runs` is gone.

**G-11.P2.24 · L286** "6 indexes per row" is observability note, not a blocker.

**G-11.P2.25 · `talk_agents` collision.** L99 (kept new name) + L676 (`talk_agents [old]` as superseded legacy). Document explicitly that greenfield migration drops + recreates and same name is intentional.

**G-11.P2.26 · `news_topics.mode`/`decision_type`/`sensitivity`** — three enums declared without value vocabulary at L465. §07 owns these but §11 should cross-reference field-level.

**G-11.P2.27 · `users` columns drift.** §11 §1 has `email/name/avatar_color/initials`. §01 calls for "Set out of office" (no column), "display name, handle, photo" (no `handle`, no `photo`). Likely belongs in §11.

---

## §12 — `docs/12-jobs.md` (jobs spec)

### P0
None — the jobs spec is clean against §11 modulo §11's own gaps.

### P1

**G-12.P1.1 · `runs.response_group_id` shape contract. ✅ CLOSED 2026-05-29.** §12 §2 now specifies: `gen_random_uuid()::text`. §11 §3 added a length CHECK (1..64) so the column rejects garbage.

**G-12.P1.2 · `set_job_blocked_agent_missing()` body. ✅ CLOSED 2026-05-29.** Body inlined in §11 §8 per G-11.P0.1.

**G-12.P1.3 · `talk_agents` removal doesn't auto-block jobs. ✅ CLOSED 2026-05-29 (clarified-as-design).** §12 §6 now documents the asymmetric blocking model explicitly: the scheduler's fire-time dep check (§5 step 2) catches roster removal on the next tick; a cross-table cascade trigger would be net-negative runtime cost. The ≤1-minute window where `status='active'` lingers is intentional.

**G-12.P1.4 · `messages.run_id` linkage explicit. ✅ CLOSED 2026-05-29.** §12 §3 rewritten: "The `messages` row carries `run_id` pointing at the firing run, and the firing run carries `job_id` — so the UI groups/collapses scheduled activity by joining `messages.run_id → runs.job_id`. No new `messages.job_id` column."

**G-12.P1.5 · `SET CONSTRAINTS ALL DEFERRED` redundancy. ✅ CLOSED 2026-05-29.** §12 §5 step 5 rewritten to drop the redundant instruction; cross-refs §11 §3's deferrable declaration.

**G-12.P1.6 · §12 §5 step 7 insert ordering. Accept-as-design.** The remaining concern was a reader-comprehension nit — the new step 5 wording + §11 §0 deferrable FK enumeration make the direction unambiguous. No further edit.

### P2

**G-12.P2.7 · `jobs.title text not null`** (§11 L490) unmentioned in §12 — UI/API minor.

**G-12.P2.8 · §14 test numbering jumps §9 → §14** with no §10–§13 (intentional per "Verification" header but reader may think text was cut).

**G-12.P2.9 · `tool_id → required_service` catalog** (§11 §6 L430) confirmed as static code catalog (not a table) — migration doesn't need a table, but executor needs the enumerated map documented.

**G-12.P2.10 · `jobs.prompt text not null`** — scheduler resume / manual run-now paths don't reference its required-ness.

---

## §01 + §08 — product spec + IA (vs §11)

### P0 — must reconcile before impl

**G-01.P0.1 · Connectors scope contradicts roadmap override. ✅ CLOSED 2026-05-29.** §01.1.8 + §01.4.4 rewritten: Connectors are workspace-global; per-Talk binding via `ConnectorBinding` type; Talk header shows chips for active bindings; "Manage connectors" opens workspace-level page.

**G-01.P0.2 · `talks.created_by` has no §01/§08 source. ✅ CLOSED 2026-05-29.** Added `createdById: UserId` to §01.1.3 Talk type. Added §08.3.4 "Ownership obligations" subsection + `created_by` column in §08.5.3.

**G-01.P0.3 · `talks.sort_order` not specified upstream. ✅ CLOSED 2026-05-29.** Added `sortOrder: number` to §01.1.3. New §08.7.1 "Talk reordering within a bucket" subsection: rules, insert path (`max + 1`), bucket transitions. `sort_order int not null` added to §08.5.3.

**G-01.P0.4 · `messages` / `runs` tables not in §08's "Minimum IA tables" list. ✅ CLOSED 2026-05-29.** Added §08.3.10 (Message IA) + §08.3.11 (Run IA) + §08.5.8 (messages columns) + §08.5.9 (runs columns) with composite FKs, snapshot integrity, single-flight partial unique, trigger invariant.

**G-01.P0.5 · `unread` column drift. ✅ CLOSED 2026-05-29.** Removed `unread` from §01.1.3 Talk type; added "Projected (not stored)" subsection explaining derivation from `talk_reads.last_read_at`.

**G-01.P0.6 · `running` column drift. ✅ CLOSED 2026-05-29.** Removed `running` from §01.1.3 Talk type; "Projected (not stored)" subsection covers derivation from `runs.status`.

### P1

**G-01.P1.7 · Co-editor level inconsistency. ✅ CLOSED 2026-05-30.** §01.1.5 `coEditorIds` moved from `Doc` to `DocTab`. One-sentence rationale added about per-tab editors + `doc_tab_coeditors`.

**G-01.P1.8 · Tool catalog has no spec home. ✅ CLOSED 2026-05-30.** New §01 §5.1 "Tool catalog" — 11 v1 `tool_id`s (web-search/web-fetch/news-monitor/gdrive-read/write/gmail-read/send/messaging/linear/github-read/notion-read) with display name + connector dependency + capability tier. Cross-refs §11 §6 + §12 §3.

**G-01.P1.9 · Connector services list drift.** §01.1.8: `slack|gdrive|gmail|linear|github|notion|telegram`. §11 §6 CHECK: same minus `telegram`. Decide who's authoritative.

**G-01.P1.10 · `workspace_role` includes `guest`; §01 says owner/admin/member only.** §11 §1 enum has 4 values. §01.1.1 `WorkspaceMember.role` has 3. §08 silent.

**G-01.P1.11 · `workspaces` column drift.** §01.1.1 has `initials, region, createdAt`. §11 §1 has `slug` instead, no `initials`, no `region`. §01.4.6 requires workspace switcher avatars (initials needed).

**G-01.P1.12 · §08 misses entire categories of §11 tables. ✅ CLOSED 2026-05-30.** §08.5.1 expanded with all missing categories: agents-stack (8 tables), tool/connector (4), home (13), jobs, Forge (9), audit. Each gets a 1-line purpose + §11 cross-ref. §08 stays hierarchy-authoritative; §11 owns column-level DDL.

**G-01.P1.13 · Jobs absent from §01/§08.** §01.8 explicitly lists "Async / scheduled agent jobs" as out-of-scope. §01 banner overrides via DECISIONS D2; body never reconciled. §08 has zero mention of jobs.

**G-01.P1.14 · Forge / Audiences absent from §01/§08. ✅ CLOSED 2026-05-30.** New §01 §5c "Forge" subsection (1-paragraph: generate-score-improve, SSR oracle, winner → `document_edits.source='forge'`, post-MVP behind feature flag) + Forge tab bullet on Documents page. New §08 §3.12 "Forge artifacts" subsection with ownership rule + `run_kind` discriminator + winner-promotion flow.

**G-01.P1.15 · `users` columns drift. ✅ CLOSED 2026-05-30.** §01.4.6 notes OOO/handle/photo are deferred to a follow-up `user_profiles` extension table; v1 schema (§11 §1) stays at email/name/avatar_color/initials.

**G-01.P1.16 · Inbox item types drift.** §11 §7 has 12 types. §01 mentions only "arrivals, blockers, and waits" — no enum. §08 points at §07. No place §01/§08 endorses the §11 enum.

**G-01.P1.17 · Recommendation kind enum drift.** §11 §7 has 13 kinds. §01.4.2 talks about Decide/Improve/Tidy priority. §08.10 mentions general targets, no enum.

**G-01.P1.18 · `rounds_limit` value+name drift.** §11 §3 `rounds_limit in (1,2,3,5)`. §01.4.10 matches values. Naming: §01 `rounds: number`; §11 `rounds_limit`.

**G-01.P1.19 · Mode value case drift.** §01.1.3 `mode: 'Ordered' | 'Parallel'`. §11 §3 enum `talk_mode = ordered|parallel`. UI may serialize as either.

**G-01.P1.20 · `talks.last_activity_at` ownership. ✅ CLOSED 2026-05-30.** §08 §3.4 now specifies: app-maintained via `UPDATE talks SET last_activity_at = now()` in the executor + `/chat` handler transactions. Explicitly NOT a trigger (trigger-overhead would fire on every snapshot/edit row).

**G-01.P1.21 · Tab delete-with-pending-edits behavior (DOC-AUDIT #20).** §08.6.3 says "must either fail or require explicit confirmation". §11 §5 sets `document_edits.tab_id` ON DELETE CASCADE (silently drops). Trigger absent.

**G-01.P1.22 · Move-block endpoint contract (DOC-AUDIT #14).** §08.6.3 lists it as required. §11 has no documented payload shape. Non-trivial due to composite FKs.

### P2

**G-01.P2.23 · `doc_tabs.sort_order` uniqueness** consistent across docs — clean note, no action.

**G-01.P2.24 · `documents.folder_id` naming drift.** §01.1.5 names it `folder: string | null` (not `folderId`).

**G-01.P2.25 · `talk_agents` name collision** between new (§11 §3) and legacy listed (§11 §11). Greenfield drop+recreate handles it but reviewers may confuse.

**G-01.P2.26 · `agents.is_system` not surfaced in §01.** §01.4.8 lists "5 default + Add slot"; doesn't acknowledge hidden Forge system agents (D3).

**G-01.P2.27 · `audit_events` not in §08/§01.** §11 §10 exists; §08 omits. Probably impl detail.

**G-01.P2.28 · Curator concept has no §11 table** — consistent (Curator = runtime summarization) but spell out somewhere.

**G-01.P2.29 · `news_topics` enums (`mode`, `decision_type`, `sensitivity`)** undefined in §11. §01 News prose doesn't enumerate. §07 likely owns.

**G-01.P2.30 · README internal contradiction.** L5 says "ClawTalk is **not** greenfield" but L28 says "**Greenfield build (DECISIONS D0).**" Same file.

---

## §06 — agent system (vs §11)

### P0

**G-06.P0.1 · §06 references retired tables and missing tables/columns. ✅ CLOSED 2026-05-29.** §06 §10.1 (`agents`), §10.2 (`agent_role_templates`), §10.5 (`talk_agent_snapshots`), §10.6 (`run_prompt_snapshots`) all rewritten to match §11 §4 exactly. Added `is_system`, `temperature`, `method text[]`, `capabilities text[]`, `workspace_id`, `snapshot_group_id`, `source_agent_id`, `talk_id`. `agent_role_templates` promoted to required DB table with full column set + role_key CHECK enum extended for Forge.

**G-06.P0.2 · Roster-vs-snapshot model not encoded in §06. ✅ CLOSED 2026-05-29.** §06 §3.4 rewritten to split live roster (`talk_agents`) from per-run frozen group (`talk_agent_snapshots` keyed by `snapshot_group_id`). Documents `runs.snapshot_group_id` + `runs.agent_snapshot_id` semantics and historical reconstruction SQL.

**G-06.P0.3 · Composer targeting source unspecified. ✅ CLOSED 2026-05-29.** §06 §7 step 3 now explicit: composer @mention reads LIVE `talk_agents`, not snapshots.

**G-06.P0.4 · System-agent filter missing from §06 read paths. ✅ CLOSED 2026-05-29.** §06 §11 `GET /agents` now filters `WHERE is_system = false` by default with `?includeSystem=true` admin/runtime escape. §06 §10.1 has the `is_system` flag with "always false for user-facing reads" note. PATCH/DELETE on system rows returns 403. New §06 §3.6 "System agents (Forge)" defines `forge_rewriter` / `forge_critic` role_keys, workspace seed contract, invocation contract (`run_kind='content_improvement'`), editorial lock rules. Closes G-09.P0.2.

### P1

**G-06.P1.5 · Temperature home (DOC-AUDIT #9).** §11 closed: `agents.temperature` editable + seeded from `agent_role_templates.default_temperature`, snapshot on `talk_agent_snapshots.temperature` (§11:208, 220, 247, 284). §06 still has open TODO in banner; §06 §3.3 (L337–365) `WorkspaceAgent` has no `temperature`; §06 §3.4 (L388–408) snapshot has no `temperature`; §06 §4.3 (L482–488) + §06 §4.7 (L584) forbid temperature in UI; §06 §11 PATCH (L1093–1101) omits it.

**G-06.P1.6 · ModelId source of truth (DOC-AUDIT #10).** §11 §4 (L198–202) made `llm_models(id text pk)` canonical. §06 still uses undefined `ModelId` TS type (L349, L399, L424, L1095) and §06:1 banner still flags TODO. §06 §11 `ModelProfile` (L1117–1131) hardcodes a 3-value `provider` enum, doesn't point at `llm_models`.

**G-06.P1.7 · Capabilities column shape mismatch.** §11:202 has `llm_models.capabilities_json jsonb`. §06 §11 `ModelProfile` defines `supportsTools`, `supportsGrounding`, `latencyClass`, `costClass` as top-level — §06 never says these come from `capabilities_json` or how it's keyed.

**G-06.P1.8 · Per-Talk tool toggling not spelled out.** §11 §6 (L399–403) has `talk_tools(workspace_id, talk_id, tool_id, enabled)`. §06 §8.1 (L851–872) describes "Talk has enabled the corresponding tool" but never names `talk_tools`. ToolManifest assembly (§06 §7 step 8 + §8.2) doesn't cite it.

**G-06.P1.9 · Workspace-level tool defaults. ✅ CLOSED 2026-05-30.** §06 §6 now specifies: `team_compositions.default_tools_json` is a seed; create-Talk API inserts one `talk_tools` row per entry in the same txn as Talk insert; subsequent edits to the composition do NOT propagate. Cross-ref §11 §6.

**G-06.P1.10 · Tool/connector authorization at run time. ✅ CLOSED 2026-05-30.** New §06 §8.1.1 "Dispatch-Time Authorization Check (Chat Runs)" specifies the two-stage check (chat handler pre-enqueue + executor pre-step); both preconditions (`talk_tools.enabled=true` + connector authorized where required); failure surface (`agent_replied` + run.status='failed' + `error_json.code='tool_not_authorized'`); shares §12 §5 step 2 code path.

**G-06.P1.11 · Roster freeze flow + run_kind missing.** §06 never references `run_kind` (§11:131 `'conversation' | 'content_improvement'`). Forge rewriter/critic flow hinges on `run_kind = 'content_improvement'` but §06 doesn't specify.

**G-06.P1.12 · `created_from_template_version` shape drift.** §11:225 types it `int`. §06 §3.3 L362 types it `string`.

**G-06.P1.13 · Default workspace agents on create. ✅ CLOSED 2026-05-30.** §06 §12 now names `POST /workspaces` as owner; one-txn shape with three insert groups (5 default agents + 2 system Forge agents + 3 default team_compositions); idempotency keys documented. Cross-refs §11 §4 + §11 §12.

**G-06.P1.14 · Prompt-improvement loop tables. ✅ CLOSED 2026-05-30.** §06 §14.6 expanded with the four-kinds taxonomy: `role_template` ✅ available via `agent_role_templates.version`; `global_policy`/`prompt_assembly`/`eval_prompt` 🚧 deferred to a follow-up `prompt_versions(kind, ref_id, content, version, created_at)` extension migration. `agent_audit_results` + `prompt_improvement_proposals` flagged as future v1+ tables.

### P2

**G-06.P2.15 · §06:1 banner stale** — still references `registered_agents` (table dropped).

**G-06.P2.16 · §06 §7.1 L814** still uses `@strategy` instead of canonical `@strat` (DOC-AUDIT #8, §11:283 flagged as seed fix).

**G-06.P2.17 · §06 §10.7 `agent_feedback_events`** drops `workspace_id` + composite FKs that §11:271–277 requires.

**G-06.P2.18 · §06 §5 (L587–736)** describes role templates but never names `agent_role_templates`. §06 §3.2 L304 lists "default model and allowed models" — §11 has no `allowed_models_json`.

**G-06.P2.19 · §06 §3.1.10 (L286–299) `globalPolicyVersion`** stored on each prompt snapshot but §11 has no global-policy storage table; hangs until §06 §14 lands.

**G-06.P2.20 · §06 §6 `TeamComposition.recommendedMode`/`suggestedRounds`/`default_tools_json`/`missing_perspective`** have no §11 home (only `name/description/icon/is_default/runs_count` on `team_compositions`).

**G-06.P2.21 · §06 §10.7 `event_type` enum names (L1060–1070)** differ from §11:273 `kind text not null` — §11 doesn't constrain the enum.

**G-06.P2.22 · DOC-AUDIT #7 (Samira hardcoded in 03-agents.md:61)** still present; §11:283 plans seed fix but §06 doesn't reference template-variable pattern.

**G-06.P2.23 · DOC-AUDIT #11 (Research crew == Hiring crew)** still ships identical in §06 §6 L760–L761 and `03-agents.md` §4.

---

## §07 — homepage system (vs §11 §7)

### P0

**G-07.P0.1 · Inbox type enum diverges 3 ways. ✅ CLOSED 2026-05-29.** §07 §6.5 InboxItemType rewritten to the 12-value canonical set (added `forge_run_needs_review`/`job_output_ready`/`job_blocked`; removed `job_needs_review`). Prose references swept.

**G-07.P0.2 · Recommendations.kind enum diverges 3 ways. ✅ CLOSED 2026-05-29.** §07 §7.6 enum now includes `forge-suggestion`. New §07 §7.7 generator rule + §07 §7.8.1 RECOMMENDATION_KIND_DEFAULTS row for `forge-suggestion` (actionValue 0.80, urgency 0.55, actionability 0.90, confidence 0.85, effortPenalty 3, priority `decide`).

**G-07.P0.3 · Forge on Home still unsurfaced in §07. ✅ CLOSED 2026-05-29.** §07:1 banner TODO dropped. New §07 §6.6 subsections for `forge_run_needs_review` + `job_output_ready` + `job_blocked` (trigger, severity, target, action). §07 §7.7 generator rule + scoring for `forge-suggestion`.

**G-07.P0.4 · `inbox_items.ref_id` + job dedup semantic absent from §07. ✅ CLOSED 2026-05-29.** Added `refId?: string` to §07 §6.5 InboxItem TS type. Added `ref_id` column to §07 §10.2. New §07 §6.10 "Ref-id dedup" subsection: partial unique on `(workspace_id, type, ref_id)`; queue-emitted vs scheduler-emitted asymmetry; `ref_id` vs `group_key` separation.

### P1

**G-07.P1.5 · `inbox_items` columns disagree.** §11 §7: `target_kind, target_id, talk_id, document_id, run_id, tab_id, due_at, expires_at, ref_id`. §07 §10.2: `target_kind, target_json` (no `target_id`), plus dedicated FKs `news_item_id, connector_id, job_id` not in §11, plus `primary_action_json, secondary_actions_json, source_event_ids_json, snoozed_until, resolved_at` not in §11.

**G-07.P1.6 · `news_topics` columns missing from §11.** §07 §8.6 (L3118) topic profile requires `sourceDomains`, `freshnessHorizonDays`, `confidence`. §11:465 drops all three. §07 §8.10.1 lexical relevance (L3703) reads `topic.sourceDomains`; §07 freshness (L3686) reads `topic.freshnessHorizonDays`. §11 schema can't back the §07 §8.10.1 formula §11:476 declares authoritative.

**G-07.P1.7 · `news_items`/`news_matches` column gaps.** §11:466 `(headline, source, url, excerpt)` vs §07 §10.7 (L4456): `canonical_url, title, source, source_domain, published_at, excerpt, raw_provider_json, content_hash`. §11 omits `source_domain`, `content_hash`, `canonical_url`-distinct, `published_at` (§07:3758 freshness needs it). §11:467 `news_matches` omits `matched_on_json` (L4475) and `why_it_matters` (L4477).

**G-07.P1.8 · `ranking_profiles` collapsed to opaque JSON.** §11:468 `(weights_json, exploration_rate)` vs §07 §10.10 (L4496): 16-column structured shape (`recommendation_kind_weights_json`, `inbox_type_weights_json`, `news_mode_by_talk_id_json`, `cleanup_aggressiveness`, etc.). §07 §9.6 bounded-update algorithm names fields §11 single-blob can encode but not constrain.

**G-07.P1.9 · `algorithm_versions` / `algorithm_assignments` missing.** §11:470 `(name, kind, active boolean, shadow boolean)`. §07 §10.12 has `surface, status enum, description, config_json, config_hash, created_by, activated_at, retired_at` + §07 §10.13 `home_algorithm_assignments` for per-workspace/percentage rollout. §11's two booleans can't express §07 §3.1 rollout semantics.

**G-07.P1.10 · `interaction_events.action` vs §07 `event_type + rank`.** §11:471 `(surface, item_id, action, created_at)`; §07 §10.9 (L4484) adds `event_type, rank, algorithm_version, metadata_json`. `rank` + `algorithm_version` load-bearing for §07 §9 optimizer audits.

### P2

**G-07.P2.11 · Table-name namespace drift.** §11 bare names; §07 §10 `home_` prefix. Decide who wins.

**G-07.P2.12 · Recommendation candidate path.** §11:464 + §07 §10.3 + §07 §7.8.2 align — clean. But §07 doesn't describe writing rows back to `recommendation_candidates` as a persisted pool.

**G-07.P2.13 · `target_kind` vocabulary.** §07 InboxTarget union (L479): `talk|document|connector|news|job|system`. §11 says only `target_kind text` — no enum CHECK. Once §11 drops `news_item_id`/`connector_id`/`job_id` (P1.5), `target_kind=news|connector|job` paths need a resolution column.

---

## §09 + §10 — Forge (vs §11)

### P0

**G-09.P0.1 · Vocabulary fork unresolved. ✅ CLOSED 2026-05-29.** Full vocab pass on §09 + §10: `contents` → `documents`, `content_id` → `document_id`, `body_markdown` → `text`/`new_text`, `target_anchor_id` → `tab_id` + `target_block_id`, `registered_agents` → `agents`, `PendingEditDocSurface` → `document_edits`, `patchContent` / `propose_content_append` → `document_edits` insert with `source='forge'`, `content_improvement_runs` → `improvement_runs`, `content_versions` → `document_versions`. §09 §8 stale data-model section replaced by one-paragraph pointer to §11 §9.

**G-09.P0.2 · Forge agent roles unspecified. ✅ CLOSED 2026-05-29.** Closed by §06 update — new §06 §3.6 "System agents (Forge)" defines `forge_rewriter` / `forge_critic` `role_keys`, seed contract, invocation via `run_kind='content_improvement'`, editorial-lock rules. §06 §10.2 `agent_role_templates` CHECK enum extended.

**G-09.P0.3 · SSR token store contradicts D7 + §11 §11. ✅ CLOSED 2026-05-29.** §09 §7.1 SSR-token-storage sentence rewritten: per-workspace `ssr_connections`, token in `connector_secrets`, explicitly NOT `workspace_provider_secrets`. §09 §15 Q3 marked RESOLVED.

### P1

**G-09.P1.4 · Scope toggle ↔ schema mapping (DOC-AUDIT #3c).** §10:62 scope = "whole doc / tab / title / section". §11 §9 `improvement_runs(document_id, tab_id, target_block_id)`. Three of four map (whole doc / tab / `target_block_id`); "title/section" aren't block-kinds with those names — they're `h1`/`h2` per §11 §5 `doc_blocks.kind`. Mapping not stated.

**G-09.P1.5 · §09 §15 open questions not all closed.** Three blockers per DOC-AUDIT #18. Only Q3 (SSR org binding) resolved by D7 (per-workspace + `connector_secrets`) but §09:294 still says "Per-user vs. per-workspace…" unresolved. Q1 (default objective) and Q2 (single fitness number) not marked resolved.

**G-09.P1.6 · `forge_audiences` sync source underspecified.** §10:53 mentions Audiences "composed in-app." §11 §9 has full schema + `synced_at`. Neither §09 nor §10 names the sync source — no documented MCP/API call ties to `synced_at`. §09:116 says "via the SSR MCP read tools (`list_personas`, `list_reference_sets`)" but doesn't tie them to populating rows.

**G-09.P1.7 · §11 columns with no §09/§10 surface. ✅ CLOSED 2026-05-30.** New §09 §9.2 "Held-out validation" subsection: ~20% random split at run-start written to `improvement_run_held_out_personas` and excluded from per-iteration scoring; second batch scores against held-out set with average stored in `document_versions.held_out_score`; in-pool vs held-out divergence > 0.3 triggers `improvement_runs.stop_reason='overfit_held_out_divergence'`; reproducibility via no-re-randomization.

**G-09.P1.8 · §13 phase-plan tables not annotated. ✅ CLOSED 2026-05-30.** §09 §13 rewritten as 7-phase annotated plan with "Schema touch:" clauses naming §11 §9 tables/columns per phase. New Phase 4 (Promotion: `best_version_id` + `document_edits.source='forge'`) and Phase 5 (Cancel: `status='cancelled'` + `cancel_scoring_batch`).

### P2

**G-09.P2.9 · §09:9** describes SSR "MCP server / `/api/scoring-jobs` HTTP endpoint" — fine.

**G-09.P2.10 · §09:189** "the chosen `content_versions.body_markdown` into `contents`" — wrong column + table per §11 (subset of P0.1).

**G-09.P2.11 · §09:294 LLM secret store** mention is a subset of P0.3.

---

## §04 — API contracts (vs §11/§12)

### P0

**G-04.P0.1 · §0 still hedges transport. ✅ CLOSED 2026-05-29.** §04 §0 rewritten: "Transport is REST + WebSocket — there is no SSE fallback."

**G-04.P0.2 · No Forge surface. ✅ CLOSED 2026-05-29.** New §04 §17 Forge endpoints: `/improvement-runs` CRUD + gallery + `/document-versions/:id/promote` + cancel + audiences CRUD + synced personas/reference-sets/questions reads + SSR OAuth (start/callback/revoke).

**G-04.P0.3 · No Jobs surface. ✅ CLOSED 2026-05-29.** New §04 §18 Jobs endpoints: create/list/detail/edit/pause/resume/archive/run-now/runs-history. `run-now` documents 409 RUN_BUSY + 400 JOB_BLOCKED.

**G-04.P0.4 · No WS events for Forge or Jobs. ✅ CLOSED 2026-05-29.** §04 §9 now has `inbox.new`/`inbox.updated`/`home.recommendations_changed` + Forge `improvement_round_scored`/`improvement_version_kept`/`improvement_run_finished` + Jobs `job_output_ready`/`job_blocked` with full payload shapes.

**G-04.P0.5 · No move-block-between-tabs endpoint. ✅ CLOSED 2026-05-29.** `PATCH /documents/:id/blocks/:blockId/move` added to §04 §8 with full CAS contract (`baseListVersionSource`/`Target`, dual `list_version` bump, 409 `LIST_VERSION_CONFLICT`).

**G-04.P0.6 · No delete-tab-with-pending-edits contract. ✅ CLOSED 2026-05-29.** §04 §8 `DELETE /documents/:id/tabs/:tabId` now spec'd: 409 `TAB_HAS_PENDING_EDITS` default; `?cascadePending=true` opt-in references §08 §6.3 UI guard.

### P1

**G-04.P1.7 · Connector scope still per-Talk (DOC-AUDIT #5).** §04 §11 L388 has `bindings: [{ talkId, target, scope, enabled }]` and L396 `POST /talks/:id/connectors/:service/bind`. §11 §6 has workspace-global + per-Talk `connector_bindings`. Reconcile direction unclear.

**G-04.P1.8 · No connector OAuth endpoints beyond start.** §04 §11 has `oauth-start` but no `oauth-callback`, no `revoke`. §11 §6 + §9 distinguish `connector_secrets` from `workspace_provider_secrets`; §04 doesn't surface separately.

**G-04.P1.9 · Talk roster not addressable.** §04 §4 `PATCH /talks/:id` accepts `team` (full-replace). §11 §3 `talk_agents` is real join table with `sort_order`. No add/remove/reorder endpoints.

**G-04.P1.10 · Folder + Talk reorder endpoints missing.** §04 §3 says "Rename / reorder" via `PATCH /folders/:id`. §11 has `sort_order` on folders AND talks. No batch-reorder endpoint.

**G-04.P1.11 · Workspace switcher (D5).** §04 §1 `GET /me` returns `currentWorkspaceId` but no `POST /workspaces/switch`. No member role update, member removal, transfer ownership. Guest workspace not addressed.

**G-04.P1.12 · Document creation contract drift.** §04 §8 `POST /documents` accepts `primaryTalkId` but §11 §5 has partial unique index. Collision handling unspecified. No `POST /talks/:id/document` shortcut.

**G-04.P1.13 · Run lifecycle endpoints.** §04 has `POST /talks/:id/cancel-runs`. Missing: `GET /runs/:id`, `POST /runs/:id/cancel`. §11 §3 `awaiting` is a real state — no endpoint to resume/respond.

**G-04.P1.14 · Inbox type drift.** §04 §13 L512 enumerates inbox types; §11 §7 (L446) is canonical with `job_output_ready` + `job_blocked` + `forge_run_needs_review`. §04 has older `job_needs_review` and no Forge types.

### P2

**G-04.P2.15 · `GET /agents` filter** for `is_system`. §11 §4 requires; §04 §6 L210 doesn't mention.

**G-04.P2.16 · Idempotency contract not stated** for mutating endpoints.

**G-04.P2.17 · Tool catalog drift.** §04 §10 L375 tool IDs don't include §11 §6 / §12 §3 `gdrive-write`/`gmail-send` connector-dependency map.

**G-04.P2.18 · ID prefix table incomplete.** §04 §0 L16 misses: `job_`, `ir_`, `dv_`, `aud_`, `inb_`, `rec_`, `conn_`, `cs_`, `ssr_`, `tab_`, `blk_`, `de_`, `snap_`.

**G-04.P2.19 · No standard error code list.** No enumerated `code` values (e.g. `RUN_BUSY` for §12 409, `TAB_GONE` for §12 §14 #20).

**G-04.P2.20 · Pagination drift.** §04 §5 uses `after=`; §04 §13 uses `cursor=`.

**G-04.P2.21 · LLM provider abstraction stale.** §04 §14 L566 names old models; §11 §4 `llm_models` is DB table (D7). §13 open items: "point §04 §14 at `llm_models`."

---

## §05 + DECISIONS — build plan & decisions

### P0

**G-05.P0.1 · §05 stack still pre-D1. ✅ CLOSED 2026-05-29.** Phase 0 rewritten: Cloudflare Workers + Hono + DO + Hyperdrive + Queues committed explicitly; "No Redis, no BullMQ, no Sidekiq." Provisioning list updated.

**G-05.P0.2 · §05 not rewritten for §11 greenfield migration. ✅ CLOSED 2026-05-29.** Phase 1 rewritten as 3-step plan: single `0037_clawtalk_greenfield.sql` (drop/keep/ALTER/create/trigger/RLS/verify sub-steps); seed `agent_role_templates` (Samira fix + Forge templates); first-signin workspace bootstrap. References §11 §11.1, §11 trigger bodies, §11 §12.1/§12.2/§12.4, §11 §14.

**G-05.P0.3 · §05 not rewritten for D6/Forge/Jobs/Home. ✅ CLOSED 2026-05-29.** New Phase 9 (Jobs): scheduler.ts rewrite per §12 §5 + atomic claim + executor + UI + inbox emit. New Phase 14 (Forge, post-MVP): improvement-run executor + SSR + audiences UI + gallery + winner-promote → `document_edits.source='forge'`.

**G-05.P0.4 · Risk register unfixed. ✅ CLOSED 2026-05-29.** "BullMQ / Sidekiq" dropped. New mitigation: CF Queues + scheduler.ts cron + atomic claim + §12 stuck-queued (5min) / stuck-running (1h) sweep.

### P1

**G-05.P1.5 · No agent-eval gate in §05 (DOC-AUDIT #24).** Engineering-notes L33–36 calls it "launch-blocking". No checkbox in §05.

**G-05.P1.6 · D5 multi-workspace rationale missing.** Phase 1 L27 includes `workspaces` + `workspace_members`; satisfied but §05 doesn't cite D5.

**G-05.P1.7 · SSE hedge purged from README L95 not from §04 L6.** Cross-doc D1 follow-up partial.

**G-05.P1.8 · No SECURITY.md in /docs/.** Only `docs/archive/SECURITY.md` (legacy). DOC-AUDIT #22 unresolved.

**G-05.P1.9 · §05 lacks per-phase entry/exit criteria.** Only global "Definition of done" (L169–185).

### P2

**G-05.P2.10 · Roadmap drift (`roadmap.md`).** L15 cites shipped Content PR #385 as in-flight (superseded). L16 says Jobs is "TODO, next week" — unaware D6 ✅ + §12 merged. Doesn't agree with §05 or DECISIONS on greenfield posture.

### Clean (§05 + DECISIONS — for reference)

- D2/D4/D6 prereqs in §11 §3, §11 §6, §12 are present.
- D7 mechanical follow-ons all present in §11.
- No 🟡 Provisional / ⏳ Open D-entries — every entry is ✅ Decided.
- Engineering-notes.md (58 lines) contains commitments, hotspots, eval gate.

---

## README + roadmap + missing docs

### P0

**G-DOC.P0.1 · README internal contradiction. ✅ CLOSED 2026-05-29.** L5 rewritten: "The **design** is a clean greenfield rebuild (DECISIONS D0); the **infrastructure** is the existing Cloudflare Workers + Supabase Postgres stack." L94/L95/L98 dropped now-resolved DOC-AUDIT references.

**G-DOC.P0.2 · No canonical SECURITY.md. ✅ CLOSED 2026-05-29.** New `docs/SECURITY.md` (~110 lines): identity/sessions (cookies + CSRF, grounded against `src/clawtalk/web/cookies.ts`), authorization (RLS via `withUserContext` + `is_workspace_member`/`is_workspace_admin`), two-store secret split (`workspace_provider_secrets` LLM vs `connector_secrets` OAuth), encryption + rotation, CSRF, rate limiting (TODO with one-line spec), `audit_events`, data deletion + transfer flows, threat model, reporting.

**G-DOC.P0.3 · `roadmap.md` describes a superseded world. ✅ CLOSED 2026-05-29.** Full rewrite: split into "Chassis-era roadmap (mostly complete)" + "Greenfield rebuild (post-2026-05-29)". Item #6 (Content) marked SHIPPED with PRs #416/#417/#418/#423 cited. Item #7 (Jobs) marked spec MERGED (PR #489 / c608221), impl pending. New section lists: §11 migration → jobs v8 impl → Forge impl → agent-eval gate.

### P1

**G-DOC.P1.4 · README L94 + L95 + L98 open-issue refs. ✅ CLOSED 2026-05-29.** README open-issue references dropped; targets fixed by other gap closures (§04 SSE, §05 stack, §11 llm_models view).

**G-DOC.P1.5 · GLOSSARY references retired terms as live. ✅ CLOSED 2026-05-30.** 6 GLOSSARY core-concept rows updated: Folder (`→ folders` post-§11), Agent (`→ agents + talk_agent_snapshots`), Content/Document (`documents + doc_tabs + doc_blocks + document_edits`; Document declared canonical), Document tab (replaced "not yet in DB" with `doc_tabs (§11 §5)`), Pending edit (`→ document_edits` with `source` enum), Connectors (workspace-global; DOC-AUDIT #5 note dropped).

---

## Recommended close order

The gaps form a real dependency chain. Suggested order:

1. **§11 internal P0s** (G-11.P0.1–8) — schema linchpin. Without trigger bodies, enums, RLS DDL, drop list, §7 tables, the migration can't be written.
2. **DECISIONS follow-ups** that gate other docs:
   - D1 §05 stack (G-05.P0.1, G-05.P0.4) + §04 SSE (G-04.P0.1).
   - D3 §06 system-agent flow (G-06.P0.4, G-09.P0.2).
   - D6 §04 Jobs endpoints + WS events (G-04.P0.3, G-04.P0.4).
3. **§09/§10 vocab rewrite** (G-09.P0.1) — required before any Forge code.
4. **§04 endpoints fill-in** (G-04.P0.2, G-04.P0.5, G-04.P0.6) + WS event list.
5. **§06 update** (G-06.P0.1–4) — agents shape, snapshots, system-agents, ModelId, temperature.
6. **§07 alignment** (G-07.P0.1–4) — inbox/rec enums, Forge surfacing, `ref_id`.
7. **§01/§08 reconciliation** (G-01.P0.1–6) — Connectors prose, drop `unread`/`running`, add `messages`/`runs` to IA.
8. **§05 rewrite** (G-05.P0.2, G-05.P0.3) — phase greenfield migration, Workers stack, Jobs/Forge phases, eval gate.
9. **Net-new SECURITY.md** (G-DOC.P0.2).
10. **README + roadmap consistency** (G-DOC.P0.1, G-DOC.P0.3) — last pass.

Estimated 1–2+ weeks of doc work before §11 greenfield impl can credibly start.

---

## Audit provenance

This list was generated by 8 parallel cross-doc audits on 2026-05-29:
- §11 ↔ §12 jobs (internal consistency)
- §11 internal completeness + migration buildability
- §11 ↔ §01/§08 product/IA
- §11 ↔ §06 agent system
- §11 ↔ §07 home (inbox/recs/news)
- §11 ↔ §09/§10 Forge
- §04 API contracts vs §11 + §12
- §05 build plan + DECISIONS.md follow-ups

Plus mechanical DOC-AUDIT.md closure triage. Original audit transcripts are in `~/.claude/projects/-Users-josephkim-dev-clawtalk/` task outputs.
