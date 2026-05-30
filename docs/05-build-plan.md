> **Status:** canonical (sequence). Aligned with [DECISIONS.md](./DECISIONS.md) D0 (greenfield) + D1 (Cloudflare Workers) + D5 (multi-workspace) + D6 (Jobs); references the locked schema in [11-data-model.md](./11-data-model.md) and locked Jobs spec in [12-jobs.md](./12-jobs.md).
> Precedence + orientation: [README.md](./README.md) · decisions: [DECISIONS.md](./DECISIONS.md) · terms: [GLOSSARY.md](./GLOSSARY.md).

# ClawTalk · Build Plan

Recommended sequence for building ClawTalk greenfield. Infrastructure → data → core flows → polish → Forge.

The numbering is *suggested*. You can parallelize where capacity allows — front-end work on Talk thread UX doesn't block back-end work on streaming, for example.

Each phase carries a one-line **Done when:** acceptance criterion to gate progress.

---

## Phase 0 · Project setup (week 0)

The stack is locked by [DECISIONS](./DECISIONS.md) D1 — no "pick stack" step.

- [ ] Initialize repo, CI, linter, formatter.
- [ ] **Stack (locked, D1):** Cloudflare Workers + Hono router + Durable Objects (`UserEventHub` for per-user WebSocket fan-out) + Hyperdrive (Postgres connection pool) + Cloudflare Queues (`TALK_RUN_QUEUE` for run dispatch) + Wrangler (local dev + deploy). Streaming transport is WebSocket — no SSE.
- [ ] **Data + storage (locked):** Supabase Postgres for the schema in `11-data-model.md`; RLS engages via `withUserContext` (sets `request.jwt.claims.sub` → `auth.uid()` + `set local role authenticated`). R2 for object storage (chat attachments, doc-embedded images). **No Redis, no BullMQ, no Sidekiq** — run queues = Cloudflare Queues, websocket pub/sub = `UserEventHub` Durable Object.
- [ ] **Provisioning:** Supabase project (local stack via `npm run db:start`) + Cloudflare account + Wrangler local dev (`npm run dev:worker`) + Hyperdrive binding to Supabase + R2 bucket binding + KV / Queue / DO bindings declared in `wrangler.toml`.
- [ ] Set up dev / staging / production environments.
- [ ] Set up LLM provider accounts: Anthropic, OpenAI, Google. Keys are stored encrypted at rest in the kept `workspace_provider_secrets` table (§11 §11), decrypted just-in-time server-side; never shipped to the client.
- [ ] Pull tokens from `02-visual-system.md` into the webapp design system (CSS variables + Tailwind config).

**Done when:** `npm run dev:worker` boots, `npm run dev:web` proxies to it, a Worker-served `/api/health` returns 200 against a local Supabase DB through Hyperdrive.

---

## Phase 1 · Greenfield migration (week 1)

Build the locked schema from `11-data-model.md` in a single migration before any screens. This is a clean break per [DECISIONS](./DECISIONS.md) D0 — drop the legacy tables, create the new model, seed defaults. Local users + data are disposable; the only live user is Joseph and he re-OAuths after the migration.

Multi-workspace tenancy (`workspaces` + `workspace_members`) is in this phase because [DECISIONS](./DECISIONS.md) D5 makes Workspace the tenant root from day one — workspaces are the RLS keystone every other policy joins through, so they must exist before any workspace-scoped table can be policed.

### Step 1 · Write the single greenfield migration (parked at `docs/canonical-greenfield-migration.sql`; lands as `0040_*.sql` at cutover)

> **Migration status (2026-05-30):** the SQL is written and locally validated; see [`docs/canonical-greenfield-migration.sql`](./canonical-greenfield-migration.sql). It is **parked in docs/** rather than `supabase/migrations/` because landing it on `main` without the matching src/ rewrite breaks the existing test suite (38/38 accessor tests + 21/30 google-drive tests fail — they target the dropped legacy tables). The executable copy lands in `supabase/migrations/0040_*.sql` (or higher, depending on intervening work) when the §05 Phases 2–12 rewrites have caught up. See [REFACTOR-OVERVIEW.md §14](./REFACTOR-OVERVIEW.md) for the cutover strategy.

One migration file, executed top-to-bottom in a transaction. Steps inside the migration:

- [ ] **Drop step.** Single `DROP TABLE … CASCADE` listing all 37 legacy tables per §11 §11.1 (contents, talk_threads, talk_messages, talk_runs, talk_jobs, registered_agents, …). CASCADE handles intra-list FKs.
- [ ] **Keep step.** Verify the 12 kept tables per §11 §11 are untouched: `users`, `event_outbox`, `idempotency_cache`, `settings_kv`, `provider_oauth_states`, `llm_providers`, `llm_provider_models`, `llm_provider_secrets`, `llm_provider_verifications`, `llm_ttft_stats`, `workspace_provider_secrets`, `workspace_provider_verifications`.
- [ ] **ALTER step.** Add §11 §1 columns to the kept `users` table (`avatar_color`, `initials`); add §11 §4 `capabilities_json jsonb not null default '{}'` to `llm_provider_models`; add the unique index on `llm_provider_models.model_id` that FKs target.
- [ ] **Create step.** Every §11 table in FK-dependency order: workspaces → workspace_members → folders → talks → talk_agents/talk_agent_snapshots/talk_reads → messages → runs → run_prompt_snapshots → agents (with `agent_role_templates` first) → team_compositions/team_composition_agents → documents → doc_tabs → doc_blocks → document_edits → doc_tab_coeditors → context_sources → talk_tools → connectors/connector_secrets/connector_bindings → activity_events → home_inbox_items + 13 other `home_*` tables (§11 §7) → jobs (§11 §8) → forge_audiences + ssr_connections + forge_personas/reference_sets/questions + forge_audience_personas + improvement_runs + improvement_run_held_out_personas + document_versions (§11 §9) → audit_events (§11 §10). Include the composite FKs, partial uniques, and back-edge FKs `DEFERRABLE INITIALLY DEFERRED` per §11 §0. Create the `llm_models` view (§11 §4) over `llm_provider_models`. Create the `jobs_active` view with `security_invoker = true` (§11 §8).
- [ ] **Trigger step.** Install the trigger function bodies inlined in §11: `tg_touch_updated_at` (§11 §0; one BEFORE UPDATE trigger per table with `updated_at`), `doc_tabs_block_last_delete` (§11 §5; rejects deleting a document's last tab), `document_edits_bump_versions_on_accept` (§11 §5; CAS-bumps versions and marks losers `superseded`), `set_job_blocked_agent_missing` (§11 §8; atomic agent-delete → block transition), `jobs_require_agent_in_roster` (§11 §8; rejects job writes where agent isn't on `talk_agents`).
- [ ] **RLS step.** `ALTER TABLE … ENABLE ROW LEVEL SECURITY` on every workspace-owned table. Create the `is_workspace_member` + `is_workspace_admin` `SECURITY DEFINER` helpers per §11 §12. Apply the §11 §12.1 canonical pattern (member-read + member-write with `WITH CHECK`) to every workspace-owned table — the full list is in §11 §12.1. Apply §11 §12.2 admin-only-write to the 6 admin tables (`workspace_members`, `connectors`, `connector_bindings`, `connector_secrets`, `home_optimization_proposals`, `home_algorithm_versions`, `home_algorithm_assignments`, `home_ranking_profiles`). Apply §11 §12.4 shared-pool policy to `home_news_items` (`USING (true)` read; service-role only write). Apply the §11 §12 non-recursive policy to `workspace_members` (`user_id = auth.uid()` for reads; `is_workspace_admin(workspace_id)` for writes). The service role (Hyperdrive connection-owning role) is `bypassrls` per §11 §12.5 — scheduler / queue-consumer / outbox / news-ingest paths run as service role.
- [ ] **Verify step.** Run the §11 §14 verification suite (14 negative tests covering composite FKs, snapshot group reconstruction, CAS, RLS membership, deferrable FK cycles, `ON DELETE SET NULL (col)` syntax). Migration is "done" only when every row in §11 §14 passes.

### Step 2 · Seed `agent_role_templates`

- [ ] Seed the five canonical roles from `03-agents.md`: `strategist`, `critic`, `researcher`, `editor`, `quant`. Use the §11 §4 schema (`default_name`, `default_handle`, `default_initials`, `default_accent` + `default_accent_dark`, `default_model_id`, `default_temperature`, `job`, `system_prompt`, `method_default text[]`, `version`).
- [ ] **Strategist seed fix:** replace the hardcoded `Samira` reference in the Strategist `system_prompt` with a user-name placeholder (e.g. `{user_display_name}`) resolved at prompt assembly time. The seed text otherwise reads `Samira` literally for every workspace (DOC-AUDIT #7).
- [ ] **`@strat` handle:** seed `default_handle = '@strat'` (canonical; `03-agents.md:32`) — not `@strategy` (DOC-AUDIT #8).
- [ ] Add two new system roles per [DECISIONS](./DECISIONS.md) D3 / Forge (§11 §4 `agents.is_system`): `forge_rewriter` and `forge_critic`. Prompts live alongside the user-facing roles in seed; Forge invokes them internally and the agent registry filters them from `GET /agents`.

### Step 3 · First-signin workspace bootstrap

- [ ] On the first successful auth (Google OAuth or device-code), create the user row (if absent) + their first `workspaces` row + an `owner` `workspace_members` row in one transaction, per §11 §1.
- [ ] Seed that workspace with 5 default `agents` rows (one per user-facing template — `strategist`/`critic`/`researcher`/`editor`/`quant`) and 3 default `team_compositions` from `03-agents.md` / prototype `shared/data.jsx`. The 2 system Forge agents are also inserted but flagged `is_system=true` so they're hidden from the roster.

**Done when:** migration applies clean on a fresh Supabase DB; §11 §14 verification suite passes (14/14); Joseph signs in and lands in a fresh workspace with 5 user-facing agents + 3 team compositions seeded; `SELECT * FROM agents WHERE workspace_id=…` excludes `is_system=true` rows at the accessor layer.

---

## Phase 2 · Auth & workspaces (week 2)

- [ ] Implement Google OAuth + device-code flow from `04-api-contracts.md` §1 (the live identity stack in `src/clawtalk/identity/`).
- [ ] Workspace creation, switching, member invites; role updates and member removal are admin-only writes per §11 §12.2.
- [ ] Session management: HttpOnly access/refresh cookies + double-submit CSRF (the kept identity model from the shipped repo).
- [ ] `GET /me` returns user + workspaces + `currentWorkspaceId`.
- [ ] Frontend: sign-in screen (reference: `SignInScreen` in `prototype/screens.jsx`).
- [ ] Frontend: workspace switcher popover from the profile avatar (reference: `ProfileMenu` in `prototype/shell.jsx`).

**Done when:** a fresh user can sign in via Google OAuth, hit `GET /me`, and switch between two workspaces with the cookie + CSRF flow intact.

---

## Phase 3 · Skeleton shell (week 2–3)

The chrome that every screen lives in.

- [ ] Left icon rail with: Home, Talks, Agents, Documents, ⌘K, Profile avatar.
- [ ] Top bar pattern: left meta + right actions.
- [ ] Sidebar secondary list (Talks tree): folder sections + Unfiled + search. Inbox is a separate Home/shell queue, not part of the Talk tree.
- [ ] ⌘K command palette skeleton (actions registry can be filled in as features land).
- [ ] Global hotkeys: ⌘K, ⌘N, ⌘+Enter, ⌘., ⌘J, g+h / g+t / g+,.
- [ ] Density modes (`cozy` default, `compact` optional).
- [ ] Density / accent applied via CSS vars — no JS prop-drilling for theming.

**Done when:** the shell renders against a real workspace + folder list at 1280px with no broken layouts; ⌘K opens an empty palette; nav between Home/Talks/Agents/Documents works.

---

## Phase 4 · Talks · the conversational core (week 3–5)

The heart of the product. Don't skimp.

- [ ] **Data layer:** Talk CRUD endpoints (`/talks`) per `04-api-contracts.md` §4. `talks` rows scope by `workspace_id`; new Talks default to mode=`ordered`, rounds_limit=3.
- [ ] **LLM provider adapters:** Anthropic, OpenAI, Google. Streaming-aware. Tool use. Model catalog reads from the `llm_models` view (§11 §4).
- [ ] **Run orchestrator:** Ordered + Parallel mode. Queue + execute agents in sequence (Ordered) or fan-out (Parallel). State machine: `queued → running → awaiting? → completed/failed/cancelled` (§11 §3 `runs.status`). Uses `response_group_id` + `sequence_index` for sequencing. Roster freeze per fire writes `talk_agent_snapshots` rows sharing a `snapshot_group_id`; the acting agent's snapshot id is the run's `agent_snapshot_id` (§11 §3 / §4).
- [ ] **Cloudflare Queues dispatch:** `/chat` enqueues on `TALK_RUN_QUEUE`; `queue-consumer.ts` performs atomic claim (`update runs set status='running' where id=$1 and status='queued' returning *`) so at-least-once delivery is safe (§12 §5).
- [ ] **WebSocket streaming:** `04-api-contracts.md` §9. Token deltas, status transitions, tool calls, message commits, talk-state patches. Streamed via per-user `UserEventHub` DO (WebSocket Hibernation) reading from `event_outbox`.
- [ ] **Frontend talk thread UI:** rounds, agent attribution (via `messages.agent_snapshot_id` so historical attribution is immutable — P1-5), run-state pills, live streaming with cursor, queued state, cancelled state. Reference: `TalkScreen` + `AgentMessage` + `UserMessage` in `prototype/screens.jsx` + `prototype/shell.jsx`.
- [ ] **Composer:** address-to chips (reads live `talk_agents`), mode/rounds chips, ⌘+Enter send, ⌘. cancel.
- [ ] **Talk header buttons:** Cancel runs / Agents / Tools / Context / Connectors / Document / ⋯. Each popover from `01-product-spec.md` §3 and `prototype/talk-dialogs.jsx`.
- [ ] **⋯ menu:** Run history, Move to folder, Rename, Duplicate, Export, Archive.

This phase is the largest. Allocate accordingly.

**Done when:** a user can open a new Talk, send a prompt to a 3-agent team in Ordered mode, watch each agent stream live with attribution, cancel mid-stream with ⌘., and see `messages` + `runs` + `talk_agent_snapshots` + `event_outbox` rows landed correctly.

---

## Phase 5 · Sidebar, folders, Unfiled, New Talk (week 5)

- [ ] Sidebar "+" split menu (New Talk / New folder / Import).
- [ ] Folder CRUD: create (inline rename), delete (three-button confirm dialog). Deleting a folder uses `ON DELETE SET NULL (folder_id)` per §11 §2 to reparent its talks to Unfiled.
- [ ] Talk filing: drag-to-folder OR right-click → Move to. Persists `talks.folder_id` + `talks.sort_order` within the bucket.
- [ ] Unfiled: visually muted, hides when empty, count badge.
- [ ] New Talk sheet (modal): title (auto-derived) / folder (optional) / team (saved compositions) / prompt (optional) / mode / rounds. ⌘N + ⌘+Enter. Reference: `NewTalkSheet`.
- [ ] Folder deletion dialog with three-button choice.

**Done when:** the user can create / rename / delete folders, drag a Talk between folders, and Unfiled lands correctly when its folder is deleted.

---

## Phase 6 · Documents (week 6)

- [ ] Doc CRUD + tab/block-level pending edit accept/reject (§04 §8). Accept path uses the `document_edits_bump_versions_on_accept` trigger from §11 §5 — CAS losers transition to `superseded` automatically.
- [ ] Primary-document semantics: 0 or 1 primary Talk per doc (§11 §5 unique partial index on `documents.primary_talk_id`), many supporting context uses.
- [ ] Documents page: sortable table with columns Title · Fmt · Tabs · Folder · Primary Talk · Last activity · Words. Reference: `DocumentsScreen`.
- [ ] Full-bleed doc editor: 720px column, serif typography, co-editor avatars (per-tab via `doc_tab_coeditors`) in meta strip, pending-edits banner. Reference: `DocEditorScreen`.
- [ ] In-Talk doc pane (side-by-side with thread). Reference: `DocPane`.
- [ ] "New document" creation flow (linked or unlinked). Linking sets `documents.primary_talk_id`; the partial unique index rejects a second primary doc for the same Talk.
- [ ] Move-block-between-tabs endpoint (DOC-AUDIT #14) — composite FKs in §11 §5 allow this but the API contract needs to specify the payload.

**Done when:** the user can create a doc, link it as primary to a Talk, agents propose pending edits (`document_edits.source='agent'`), the user accepts them, the block versions advance, and a concurrent edit at the same anchor lands `superseded`.

---

## Phase 7 · Agents (week 6–7)

- [ ] Agent endpoints for the v1 editable fields per §11 §4: name, model_id, persona, focus, method (`text[]`), temperature, enabled. `GET /agents` filters `is_system = true` rows at the accessor layer (§11 §12.3 — query-layer filter, not RLS).
- [ ] Agents page: 5-card roster + add slot + team compositions + Discover placeholder. Reference: `AgentsScreen`.
- [ ] Agent profile: persona / focus / model / method / reset controls / recent contributions. Reference: `AgentProfileScreen`, adjusted by `06-agent-system-design.md`.
- [ ] Role templates: `agents.role_key` FKs to `agent_role_templates` (§11 §4 D7). Editing prompts ships a versioned row; the `06` §14 prompt-improvement loop tables are deferred until §06 §14 implementation.
- [ ] Hidden global runtime policy, deterministic prompt assembly, per-run `talk_agent_snapshots` + `run_prompt_snapshots`. Acting-agent snapshot id is the run's `agent_snapshot_id`; the full frozen room is reconstructible via `snapshot_group_id` (§11 §3 / §4).
- [ ] Team composition CRUD + "Save current Talk as team" gesture.
- [ ] Reset-to-default everywhere (uses `agent_role_templates.default_*` fields).

**Done when:** the user can edit an agent's persona/focus/method, run a Talk with the edit applied, reset to default, swap a model, and the `is_system` Forge rewriter/critic rows never appear in any user-facing list.

---

## Phase 8 · Tools, Connectors, Context (week 7–8)

These intersect with Talks (popovers) and Settings (workspace catalogs).

- [ ] **Tools:** workspace catalog page, per-Talk popover with toggle switches writing `talk_tools(workspace_id, talk_id, tool_id, enabled)` (§11 §6), tool-call invocation by agents during runs. Tool catalog (`tool_id` vocabulary) seeded in code.
- [ ] **Connectors:** OAuth flows for Slack, GDrive, Gmail, Linear, GitHub, Notion against the per-workspace `connectors` row + `connector_secrets` store (§11 §6 — not `workspace_provider_secrets`, which is LLM keys per D7). Per-Talk binding writes `connector_bindings` with target picker.
- [ ] **Context:** per-Talk `context_sources` rows. Add-URL, upload-file, link-past-Talk, house-rule entry. Kind ↔ source-column shape enforced by the §11 §6 CHECK.
- [ ] **Static tool → connector catalog (`tool_id → required_service`):** the runtime gates a tool if its connector isn't authorized (§11 §6). This is a code catalog, not a table.
- [ ] **News monitor tool:** topic-summary submission to the news matcher (privacy contract — never send messages). Reads/writes `home_news_topics` (§11 §7).
- [ ] **File attachments:** uploads go to R2 (Phase 0 binding); chat-attachment vision path uses the `ATTACHMENTS` R2 binding the queue scope already has.

**Done when:** the user can enable a tool in a Talk, authorize Google OAuth for the `gdrive` connector, bind it to a Talk with a target, send a prompt that uses the tool, and the run completes with tool-call deltas streamed.

---

## Phase 9 · Jobs (week 8)

Scheduled single-agent prompts per [12-jobs.md](./12-jobs.md) (D6). Schema is locked in §11 §3 (runs.job_id / scheduled_for / single-flight partial uniques), §11 §8 (`jobs` table + `jobs_active` view + triggers), §11 §12 (RLS). This phase implements the runtime + UI against that schema.

- [ ] **Scheduler rewrite:** rebuild `scheduler.ts` against the new `jobs` + `runs` schema. Per-tick `FOR UPDATE SKIP LOCKED` claim path runs the §12 §5 Path A single-transaction sequence: single-flight check → fire-time dependency check (§12 §5 step 2; agent in `talk_agents`, model enabled, primary doc if `emit_document_append`, `talk_tools` enabled per `source_scope_json.tool_ids`, connector authorized per static catalog) → roster freeze (`talk_agent_snapshots` rows sharing a fresh `snapshot_group_id`) → INSERT `runs` + INSERT `run_prompt_snapshots` (deferrable back-edge FK) → advance `next_due_at` → clear `claimed_at` → COMMIT → dispatch to `TALK_RUN_QUEUE` outside the txn. Path B stuck-sweep: `queued > 5min` and `running > 1h` → `failed` with `error_json={code:"stuck_*_swept"}`; `awaiting` is NEVER swept.
- [ ] **Queue-consumer atomic claim swap:** the existing `queue-consumer.ts` atomic claim (`update runs set status='running' where id=$1 and status='queued' returning *`) covers the at-least-once dedup; reuse unchanged against the new `runs` shape.
- [ ] **Executor:** reads prompt from `runs.prompt_snapshot_id.prompt_text_redacted` (NOT live `jobs.prompt` — editing mid-queue affects the NEXT fire only, §12 §2). On `emit_document_append`, inserts a single `document_edits` row keyed to the Talk's primary Document's primary tab per §12 §3 (op=insert, source='job', after_block_id = last block or NULL, base_list_version captured at insert).
- [ ] **Webapp Jobs UI:** create / list / edit / pause / resume / archive (sets `archived_at`, NOT hard delete — runs.job_id is ON DELETE RESTRICT per §11 §8). Manual run-now button (`POST /api/v1/talks/{talkId}/jobs/{jobId}/run-now`) creates a `trigger='manual'` run; respects single-flight (409 busy if a non-terminal run exists). Surface `block_reason` (`agent_missing` | `model_disabled` | `no_primary_document` | `tool_not_enabled` | `connector_not_authorized`) inline so the user can fix the dependency.
- [ ] **Inbox emit:** `job_output_ready` on successful run completion (`ref_id = run.id` — the partial unique on `(workspace_id, type, ref_id)` dedups at-least-once retries); `job_blocked` synchronously in the same txn as the block transition (`ref_id = NULL` — each block episode is a distinct row, §12 §6).
- [ ] **API surface (§04 G-04.P0.3 close):** CRUD + pause/resume/archive/run-now + runs-history (`SELECT * FROM runs WHERE job_id = …`, no separate ledger).

**Done when:** §12 §14 verification suite passes (25 tests covering slot dedup, single-flight, queue dedup, DST gap/overlap, stuck sweep, dependency blocking, multi-target all-or-nothing, archive semantics, inbox idempotency, prompt-snapshot immutability, connector-auth blocking, long-running catch-up behavior).

---

## Phase 10 · Settings (week 8–9)

- [ ] Settings shell with left-rail sub-nav (no top tabs).
- [ ] Profile · API keys · AI agents · Tools · Connectors panels. Reference: `SettingsScreen` + the panel components.
- [ ] API key generation, reveal, copy, revoke flow.
- [ ] Workspace member management (admin-write per §11 §12.2): invite, role change, remove, transfer ownership.

**Done when:** the user can generate / reveal / copy / revoke an API key; an admin can promote a member to admin and the change reflects in `GET /me` for that member.

---

## Phase 11 · Home — the curator dashboard (week 9–10)

Highest design risk. Ship behind a feature flag.

- [ ] **Home Inbox:** activity events (`activity_events` table), Inbox items (`home_inbox_items` table — §11 §7, full 12-type CHECK including `forge_run_needs_review` / `job_output_ready` / `job_blocked`), shell/Home badges, and item lifecycle (`unread → read → resolved | dismissed | snoozed | expired`). Unfiled Talks remain separate organization. See `07-homepage-system-design.md`.
- [ ] **Recommendations engine:** deterministic candidate generation writing `home_recommendation_candidates`; ranking + structured actions in `home_recommendations` (15-kind CHECK including `forge-suggestion` + `job` + `prompt-suggestion`); dismissal/completion lifecycle in `home_recommendation_events`; provenance in `provenance_json`.
- [ ] **News feed:** privacy-safe topic profiles (`home_news_topics` — `summary` only, never raw text per §07 §8.4); async third-party news search → `home_news_items` (shared global pool, no `workspace_id`); Talk-impact ranking in `home_news_matches`; Add-to-context, Snooze, Not relevant via `home_news_matches.status`.
- [ ] **Optimization loop:** impression/action events in `home_interaction_events`; bounded ranking-profile updates writing the 16 structured columns of `home_ranking_profiles` (NOT opaque blob); lightweight user feedback; admin-reviewed algorithm proposals via `home_optimization_proposals` → `home_algorithm_versions` → `home_algorithm_assignments`.
- [ ] **Curator polish:** optional model copy rewrite/clustering behind a feature flag after deterministic cards work.
- [ ] **Home page UI:** Curator headline + stat strip + composer + hero NBA card + 3 follow-up rec cards + news section. Reference: `HomeFocus`.
- [ ] **Home layout:** commit to `focus` for production; do not ship the Tweaks panel.

**Done when:** behind the flag, Home renders deterministic Inbox + recommendations + news against real activity in Joseph's workspace; a `job_output_ready` inbox row from Phase 9 lands and resolves correctly.

---

## Phase 12 · Archive, polish, ⌘K palette (week 10–11)

- [ ] Archive view: list of archived Talks with restore action.
- [ ] Archive flow with primary-document three-button confirm.
- [ ] ⌘K palette: full action registry, jump-to-Talk by title, settings deep links, reset-demo (dev-only).
- [ ] Run history view per Talk.
- [ ] Export to MD / HTML / PDF.
- [ ] Audit log surface (Settings → Admin console for owners) reading `audit_events` (§11 §10).
- [ ] Onboarding flow for first-time users (out of scope unless time permits).

**Done when:** archive + restore round-trip a Talk; ⌘K jumps between Talks by title; audit log surfaces recent owner-visible mutations.

---

## Phase 13 · Offline agent eval gate — launch-blocking

Per `engineering-notes.md` §3 + DOC-AUDIT #24, the five system prompts in `03-agents.md` have never been tested against each other in a multi-agent run. This phase builds the eval and runs it as a launch gate.

- [ ] Build an offline eval harness that runs the default 5-agent team on a representative prompt set (decision-quality questions covering the v1 talk shapes).
- [ ] Evaluator-model checks per `06-agent-system-design.md` §14.6 produce an `AgentAuditResult` JSON per agent per run, scoring (1–5 each): `roleAdherence`, `nonDuplication`, `evidenceDiscipline`, `methodAdherence`, `usefulness`, `concision`.
- [ ] Aggregate scores by agent role; set per-role thresholds (e.g. roleAdherence ≥ 4.0 mean, nonDuplication ≥ 4.0, evidence flags ≤ N%) for gate pass.
- [ ] Gate is launch-blocking for v1 (>1 user). Run before opening access beyond Joseph.

**Done when:** all five role default prompts pass the per-role thresholds on the eval prompt set; the per-run JSON results are persisted for the §06 §14 prompt-improvement loop when it lands.

---

## Phase 14 · Forge — autonomous content improvement (post-MVP)

Schema is already in §11 §9 (`ssr_connections`, `forge_personas`/`reference_sets`/`questions`, `forge_audiences` + `forge_audience_personas` join, `improvement_runs` + `improvement_run_held_out_personas`, `document_versions`). This phase implements the runtime + UI against that schema after the core product is shipped (`09-autonomous-content-improvement-prd.md` + `10-forge-design-handoff.md`).

- [ ] **Improvement-run executor:** Forge rewriter + critic are the seeded `is_system=true` agents from Phase 1 (D3); the loop runs through the normal `runs` path with `run_kind='content_improvement'` (§11 §3). Scope is tab/block-aware via `improvement_runs(document_id, tab_id, target_block_id)` (§11 §9). Streaming reuses `event_outbox` with `improvement_round_scored` / `_version_kept` / `_run_finished` event types.
- [ ] **SSR connector:** per-workspace `ssr_connections` row + per-workspace `connector_secrets` store (§11 §9 — D7 correction: NOT `workspace_provider_secrets`). OAuth start/callback/revoke endpoints. Synced reads of personas / reference_sets / questions populate `forge_personas` / `forge_reference_sets` / `forge_questions` with `synced_at` watermarks.
- [ ] **Audiences UI:** Audiences page lets the user compose `forge_audiences` rows (name, note, reference_set_id, question_id) and pick personas via the `forge_audience_personas` join. Held-out persona set persists per run in `improvement_run_held_out_personas` for reproducibility (P1-8 / §11 §9).
- [ ] **Gallery + run-detail surfaces:** list `improvement_runs` with status (`pending`/`running`/`completed`/`plateaued`/`budget_exhausted`/`cancelled`/`failed`); per-run detail shows `document_versions` rows with composite_score / held_out_score (0–10 scale) + per_persona Likert distributions (1–5 five-bucket).
- [ ] **Winner-promote:** promoting `document_versions.decision='winner'` writes a `document_edits` row with `source='forge'` against the document/tab/block scope and lands through the standard accept path (§11 §5). No second write path.
- [ ] **API surface (§04 G-04.P0.2 close):** `POST /improvement-runs`, list/detail, version list, `POST /document-versions/:id/promote`, cancel, `forge/audiences` CRUD, synced-asset reads, `POST /forge/ssr/oauth-start`.

**Done when:** Joseph can connect SSR, build an audience, run a content improvement on a real Document tab, watch beam/critic iterations stream, and promote a winner that lands as a pending `document_edits` row he accepts via the standard accept path.

---

## Risk register

| Risk | Mitigation |
|---|---|
| **LLM streaming reliability across 3 providers.** | Build the provider adapter abstraction in week 3 before UI work. Test with chaos: dropped connections, partial responses, tool-use errors. |
| **Run orchestrator.** | Cloudflare Queues + the `scheduler.ts` cron tick + queue-consumer atomic claim (`update runs set status='running' where id=$1 and status='queued' returning *`) handle dispatch; the §12 stuck-`queued` (5min) + stuck-`running` (1h) sweep is the safety net. State machine lives in code, not in DB triggers. |
| **Schema migration size.** | The single greenfield migration ([`docs/canonical-greenfield-migration.sql`](./canonical-greenfield-migration.sql), parked) is large but executes against disposable local data per D0. Verify with the §11 §14 invariant suite before deploying to staging; a green suite is the gate, not "looks OK." |
| **Cutover gap.** | The parked migration drops 37 legacy tables that current `src/` and tests target. Landing the migration without the matching src/ rewrite breaks main. Resolved by holding the migration in `docs/` until §05 Phases 2–12 rewrites are ready — at which point the migration moves to `supabase/migrations/0040+_*.sql` as the cutover commit. See REFACTOR-OVERVIEW §14. |
| **Curator quality.** | Phase 11 is behind a flag for model polish only. Deterministic recommendations must work without Curator output. |
| **News feed privacy.** | Bake the topic-summary-only contract into the matcher service. `home_news_items` is a shared global pool with no `workspace_id` per §07 §8.4 — never log message bodies in that pipeline. Document for security review. |
| **Home auto-optimization.** | Tune only bounded `home_ranking_profiles` weights automatically. Structural algorithm changes require `home_optimization_proposals` → admin review → new `home_algorithm_versions` row → `home_algorithm_assignments` flip. |
| **Multi-workspace performance.** | Index aggressively. Don't N+1 across workspaces. The `/me` endpoint should be one query. `is_workspace_member` / `is_workspace_admin` are `SECURITY DEFINER` helpers so the membership lookup is plan-cached, not re-evaluated per row (§11 §12). |
| **Doc co-editing conflicts.** | V1 is single-user editing. CAS via `doc_blocks.version` / `doc_tabs.list_version` marks concurrent loser edits `superseded` automatically (§11 §5 trigger). Real CRDT comes in v1.1+. |
| **Agent prompt quality.** | The launch-blocking offline agent eval (Phase 13) catches role drift / duplication / evidence gaps before they reach users. Don't open access beyond Joseph until the eval passes. |

---

## Definition of done (for v1 launch)

- [ ] A new user can sign up via Google OAuth, land in a fresh workspace with 5 default agents seeded (Strategist with proper user-name placeholder, not literal `Samira`).
- [ ] Open a New Talk, pick a team, send a prompt, watch agents stream live with attribution via `messages.agent_snapshot_id`.
- [ ] Each agent's run-state pill transitions visibly through queued → running → completed.
- [ ] Cancel runs mid-stream with ⌘. — runs stop within 2 seconds.
- [ ] Editor closes a round with a synthesis and proposes pending doc edits (`document_edits.source='agent'`).
- [ ] Accept the pending edits — they apply; concurrent loser edits land `superseded`.
- [ ] Move the Talk to a folder. Delete the folder (folder-only). Talk lands in Unfiled with `folder_id` nulled via `ON DELETE SET NULL (folder_id)`.
- [ ] Inbox item generation, counts, actions, and lifecycle match the Home spec.
- [ ] Archive the Talk with a primary document — prompt offers Talk-only vs both.
- [ ] Open ⌘K, jump between Talks, switch active model for next round.
- [ ] Open the Documents page. Sort. Click a row. Edit. Save.
- [ ] Open the Agents page. Edit persona/focus/method. Reset to default. Swap a model. System Forge agents do NOT appear.
- [ ] Open Settings → API keys. Generate a key. Reveal. Copy. Revoke.
- [ ] Create a Job that fires hourly with `emit_talk_message=true`; the slot fires once per hour with no double-runs across scheduler ticks, the agent reply lands tagged with `runs.job_id`, and `job_output_ready` lands in Inbox.
- [ ] Open Home. Curator headline + 4 stats + 1 hero rec + 3 follow-ups + 6 news cards. Click a recommendation's action button — it does the thing.
- [ ] Offline agent eval (Phase 13) passes per-role thresholds on the eval prompt set.
- [ ] All of the above with no JS errors, no broken layouts at 1280px viewport, and end-to-end latency on the streaming response under 600ms TTFT.
