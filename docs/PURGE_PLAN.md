# PURGE Plan — strip the chassis, keep the editorial product

**Status:** In progress (PR-1 + PR-2 merged; PR-3 WIP on `claude/purge-pr3-chassis-and-editorial-app`; PR-4 + PR-5 pending)
**Companion:** `docs/CLOUD_TARGET.md` — this plan is the precondition for Phase B of the cloud port. Until PURGE merges, no cloud work begins.

**Updated 2026-05-03 mid-session:** Original 6-PR sequence collapsed to 5 PRs after `/plan-eng-review` of `docs/CLOUD_TARGET.md` — PR-3 (routes purge) and PR-4 (chassis purge) merged into a single combined PR-3 because `src/clawrocket/web/server.ts` has 6000 LOC of inline route handlers (not separate registration calls), making partial trimming impossible. Combined PR-3 is opened as DRAFT for Joseph review given size.

**Scope:** delete NanoClaw, Channels, Talks, container execution, rocketorchestra references. Keep the Editorial Room. Carve a clean editorial-only persistence module so the cloud port doesn't drag chassis abstractions forward.

**Magnitude:** ~89% of the codebase by LOC. 116 schema tables down to ~10. Roughly 161,000 lines deleted, 20,000 lines preserved.

---

## 0. Goal and non-goals

**Goal:** Leave the repo in a state where:
1. Only the Editorial Room product exists in the codebase
2. A clean editorial-only persistence module (`src/editorial/db.ts` or similar) exists and is the only DB abstraction
3. The repo is renamed `editorialboard` and rebranded
4. All NanoClaw / rocketorchestra documentation is rewritten or retired
5. Local dev runs the editorial product against the slimmed persistence; full test suite green

**Non-goals:**
- No cloud work yet — that's `docs/CLOUD_TARGET.md` Phase B onward
- No Postgres migration — `src/db.ts` still uses better-sqlite3 after PURGE; the carved editorial-only module just narrows its scope. Postgres swap is Phase C of cloud port.
- No new features — strict deletion + carving + rename
- No data migration — local SQLite data is disposable per `CLAUDE.md`

---

## 1. What survives — Editorial Room core

### Frontend (`webapp/src/`)
- `pages/EditorialSetupPage.tsx` (+ test)
- `pages/ThemeTopicsWorkspacePage.tsx`
- `pages/PointsOutlineWorkspacePage.tsx`
- `pages/DraftWorkspacePage.tsx`
- `lib/editorial-fixtures.ts`
- `lib/editorial-setup.ts`
- `lib/llm-providers.ts`
- `lib/llm-provider-auth.ts`
- `lib/panel-fanout.ts`
- `lib/markdown-export.ts` (+ test)
- `lib/markdown-import.ts` (+ test)
- `components/EditorialPhaseStrip.tsx`
- `components/SignInView.tsx` (+ test) — minimal sign-in, will be replaced in Phase D of cloud port
- `App.tsx` — trimmed to only `/editorial/*` routing tree

### Backend (`src/`)
- `clawrocket/web/server.ts` — the Hono server, **promoted to be the main bootstrap** (replaces `src/index.ts`)
- `clawrocket/web/routes/editorial-panel.ts`
- `clawrocket/web/routes/llm-oauth.ts` (Anthropic OAuth)
- `clawrocket/web/routes/llm-oauth-openai.ts` (OpenAI Codex device-code OAuth)
- `clawrocket/web/routes/auth.test.ts` + minimal auth route — survives Phase D of cloud port replacement
- `clawrocket/web/routes/system.ts` (health endpoint)
- `clawrocket/web/routes/agent-management.ts` — provider secret management
- `clawrocket/web/routes/ai-agents.ts` — provider listing (renamed from "ai agents" to "providers" later)
- `clawrocket/web/routes/user-settings.ts`
- `clawrocket/web/middleware/{auth,csrf,rate-limit,acl,idempotency}.ts`
- `clawrocket/llm/editorial-llm-call.ts`
- `clawrocket/llm/anthropic-oauth.ts` + `anthropic-oauth-state-store.ts`
- `clawrocket/llm/openai-codex-oauth.ts` + `openai-oauth-state-store.ts`
- `clawrocket/llm/provider-secret-store.ts`
- `clawrocket/llm/types.ts`
- `clawrocket/llm/capabilities.ts`
- `clawrocket/identity/{auth-service,session,device-auth}.ts` — survive PURGE; replaced in Phase D of cloud port
- `clawrocket/db/init.ts` — drastically trimmed (10 tables, not 116)
- `db.ts` — survives PURGE; replaced by carved editorial-only module in Phase A2
- `config.ts`, `env.ts`, `logger.ts`, `types.ts`
- `clawrocket/contracts/editorial-room.test.ts` + `docs/contracts/editorial-room/v0/*.schema.json`

### Documentation
- `CLAUDE.md` — rewritten
- `CLAUDE.local.md` — already current
- `README.md` — rewritten
- `docs/CLOUD_TARGET.md`, `docs/TODOS.md` — current
- `docs/EDITORIAL_ROOM_CONTRACT.md`, `docs/SCHEMA_DEFINITION.md`, `docs/THEME_TOPIC_POINTS_DEFINITION.md`, `docs/SYNTHETICALRESEARCH_API_CHANGES.md`, `docs/02_HERO_APPLICATIONS.md`, `docs/04_BUILD_PLAN.md`, `docs/05_DESIGN_BRIEF.md`, `docs/01_ARCHITECTURE.md`, `docs/OPTIMIZATION_LOOP.md` — kept; cross-repo framing flagged stale
- `docs/design/0[1-4]_*.md` — kept (canonical UI specs)
- `docs/06_PHASE_1A_KICKOFF.md` — Section A heavily rewritten or retired; Section B (rocketorchestra) deleted entirely
- `docs/PHASE_0P_STOP_GO.md`, `docs/SECURITY.md`, `docs/SPEC.md`, `docs/REQUIREMENTS.md`, `docs/DEBUG_CHECKLIST.md`, `docs/OPERATIONS_UBUNTU.md`, `docs/UPSTREAM-PATCH-SURFACE.md` — review and either rewrite or delete

---

## 2. What dies

### Backend chassis (top-level `src/`)
- `src/index.ts` (1052 LOC) — singleton orchestrator, signal handling, channel registry startup, scheduler startup, group queue startup
- `src/container-runner.ts` (1332 LOC) — containerized Claude/Codex executor
- `src/container-runtime.ts`, `src/container-execution-target.ts` — container abstraction
- `src/instance-coordinator.ts` (822 LOC) — single-instance lock + graceful takeover
- `src/task-scheduler.ts` (275 LOC) — cron + lease scheduler
- `src/group-queue.ts` (357 LOC) — message queueing for grouped channel deliveries
- `src/group-folder.ts` — group/folder model
- `src/router.ts` — channel routing
- `src/ipc.ts` — IPC primitives
- `src/mount-security.ts` — container mount perimeter

### Channel adapters
- `src/channels/` (entire directory) — Slack + Telegram bots and registry

### NanoClaw agents runtime
- `src/clawrocket/agents/` (entire directory) — codex-host-runtime, codex-mcp-adapter, container-turn-executor, codex-turn-executor, agent-registry, agent-router, llm-client, execution-{planner,preview,resolver}, main-{browser-contract,channel,context-loader,executor,run-worker,subscription-worker-manager}, project-mounts

### Talks runtime
- `src/clawrocket/talks/` (entire directory) — executor, run-worker, run-queue, attachment-extraction, attachment-storage, source-ingestion, browser-source-container, context-loader, executor-settings, executor-subscription-host-auth, google-drive-tools, internal-tags, job-worker, json-fingerprint, mock-executor, output-tools, policy

### Other clawrocket subsystems (Talk-adjacent)
- `src/clawrocket/channels/` — channel binding, delivery worker, ingress worker, slack/telegram connectors
- `src/clawrocket/connectors/` — data connector framework + connector-secret-store, connector-verifier, http, runtime, tool-executors
- `src/clawrocket/browser/` — browser agent service + bridge
- `src/clawrocket/tools/` — Talk tool surfaces (browser-tools, web-tools)
- `src/clawrocket/scheduler-maintenance.ts`
- `src/clawrocket/secrets/keychain.ts` (if Talk-only)

### Backend HTTP routes that die
- `src/clawrocket/web/routes/talks.ts` (+ test)
- `src/clawrocket/web/routes/talk-attachments.ts` (+ test)
- `src/clawrocket/web/routes/talk-context.ts` (+ test)
- `src/clawrocket/web/routes/talk-jobs.ts` (+ test)
- `src/clawrocket/web/routes/talk-outputs.ts` (+ test)
- `src/clawrocket/web/routes/talk-threads.ts`
- `src/clawrocket/web/routes/talk-tools.ts` (+ test)
- `src/clawrocket/web/routes/main-channel.ts`
- `src/clawrocket/web/routes/channels.ts` (+ test)
- `src/clawrocket/web/routes/data-connectors.ts` (+ test)
- `src/clawrocket/web/routes/browser.ts` (+ test)
- `src/clawrocket/web/routes/events.ts` (+ test)
- `src/clawrocket/web/routes/executor-settings.ts` (+ tests)
- `src/clawrocket/web/routes/ai-agents.ts` (+ test) — **conditional:** if it's only the Talk-style "AI Agents" page, dies. The provider-listing functionality survives (rename to `providers.ts`)

### DB accessors that die
- `src/clawrocket/db/agent-accessors.ts`
- `src/clawrocket/db/browser-accessors.ts`
- `src/clawrocket/db/browser-run-accessors.ts`
- `src/clawrocket/db/channel-accessors.ts`
- `src/clawrocket/db/connector-accessors.ts`
- `src/clawrocket/db/context-accessors.ts` (+ test) — Talk context loader
- `src/clawrocket/db/job-accessors.ts` (+ test)
- `src/clawrocket/db/output-accessors.ts` (+ test)
- `src/clawrocket/db/talk-tools-accessors.ts`
- `src/clawrocket/db/thread-title-utils.ts`
- `src/clawrocket/db/accessors.ts` — large mixed file; **carve** out the editorial+auth+provider-secret pieces; delete the rest

### Webapp pages that die
- `webapp/src/pages/TalkListPage.tsx` (+ test)
- `webapp/src/pages/TalkDetailPage.tsx` (+ test)
- `webapp/src/pages/MainChannelPage.tsx` (+ test)
- `webapp/src/pages/DataConnectorsPage.tsx` (+ test)
- `webapp/src/pages/AiAgentsPage.tsx` (+ test) — **conditional:** if it's the Talk agent picker, dies. The provider-management UI moves into Editorial Setup or a new `/settings` page
- `webapp/src/pages/SettingsPage.tsx` (+ test) — **conditional:** if it's only Talks executor settings, dies. If it has provider-secret management for editorial, the Editorial bits move into Editorial Setup
- `webapp/src/pages/ProfilePage.tsx` — **conditional**

### Webapp libs that die
- `webapp/src/lib/api.ts` (+ test) — Talk API client
- `webapp/src/lib/assistantText.ts` — Talk-specific
- `webapp/src/lib/browser-blocks.ts` — browser-agent UI
- `webapp/src/lib/googleAccountPopup.ts`, `googlePicker.ts` — Google Drive linkage for Talks
- `webapp/src/lib/mainStream.ts` (+ test) — main-channel streaming
- `webapp/src/lib/slackInstallPopup.ts`
- `webapp/src/lib/talkStream.ts` (+ test)
- `webapp/src/lib/threadTitles.ts`

### Webapp components that die
- `webapp/src/components/AvatarMenu.tsx`, `BrowserBlockedRunCard.tsx`, `ClawTalkMark.tsx`, `ClawTalkSidebar.tsx` (+ test), `ExecutionDecisionSummary.tsx`, `InlineEditableTitle.tsx`, `RegisteredAgentsPanel.tsx`, `SlackChannelConnectorPanel.tsx`, `TalkHistoryEditor.tsx`, `TalkLlmSettingsCard.tsx`, `TelegramChannelConnectorPanel.tsx`, `ThreadContextMenu.tsx` (+ test), `ThreadRowTitleEditor.tsx` (+ test), `ThreadStartButton.tsx`

### Tests that die
- All tests under deleted directories — ~33 backend test files for talks/channels/agents/browser/connectors plus webapp tests for TalkDetail/TalkList/MainChannel/DataConnectors/AiAgents

### Dependencies (`package.json`)
Removable on inspection:
- `grammy` (Telegram bot framework)
- `@slack/*` packages
- Browser-automation deps if used only by `clawrocket/browser/` (Playwright?)
- Container runtime deps (anything Docker-related)
- Google Drive / Picker deps if only used by Talks

`better-sqlite3` survives PURGE (replaced in Phase C of cloud port).

---

## 3. Editorial-only persistence carve

The current `src/db.ts` (704 LOC) and `src/clawrocket/db/accessors.ts` (large) are mixed-concern — they handle Talk threads, agent runs, channel deliveries, browser sessions, AND editorial state. Per Codex's outside-voice critique on `CLOUD_TARGET.md`: don't carry the chassis abstraction forward into Postgres. Carve a fresh editorial-only persistence module during PURGE.

**New module:** `src/editorial/db.ts` (or `src/editorialboard/db.ts` if we rename in PURGE)

**Surface:**
- Direct better-sqlite3 connection (still sync at this stage; Phase C of cloud port async-ifies)
- Typed accessors only for editorial tables:
  - `getProviderSecret`, `setProviderSecret`, `revokeProviderSecret`
  - `getOauthState`, `setOauthState`, `cleanupExpiredOauthState`
  - `getEditorialSetupState`, `setEditorialSetupState`
  - `getUser`, `createUser` (minimal — auth is local-cookie until Phase D)
  - `getWebSession`, `createWebSession`, `revokeWebSession`
- Schema definition lives in `src/editorial/schema.sql` (or inline in TS) — only the ~10 tables Editorial Room needs

**What it does NOT have:**
- No talk_*, channel_*, agent_*, browser_*, job_*, connector_* accessors
- No raw `.prepare(...).get(...)` exposed; callers use typed accessors only
- No Talk-shaped abstractions (sessions, runs, attachments, etc.)

**Why carve, not rewrite later:**
Per Codex: porting the existing chassis abstraction to Postgres in Phase C would drag NanoClaw assumptions (sync semantics, raw SQL exposure, mixed-concern accessors) into the new product. Carving now means Phase C is "implement the typed accessor surface against Postgres + Hyperdrive" which is straightforward, not "untangle a 1500-line chassis."

---

## 4. Database schema purge

`src/clawrocket/db/init.ts` currently has 116 `CREATE TABLE` statements. After PURGE: ~10.

### Tables that survive
- `users` — minimal
- `user_invites` — if invitation flow is editorial; otherwise dies
- `web_sessions` — local cookie sessions (replaced in Phase D)
- `oauth_state` — provider OAuth flow state
- `user_google_credentials` — Google export OAuth (kept for future Substack/GDocs export)
- `llm_providers` — provider catalog
- `llm_provider_models` — model metadata
- `llm_provider_secrets` — encrypted user provider credentials
- `llm_provider_verifications` — provider validation status
- `user_tool_permissions` — tool permission grants

### Tables that die (~106 of them)
All `talk_*`, `channel_*`, `agent_*`, `browser_*`, `job_*`, `connector_*`, `main_*` tables. Channel provider secrets. Container session tracking. Group queues. Scheduler leases. Browser run state.

### Migration strategy
- New `src/editorial/schema.sql` defines the surviving tables from scratch
- Drop the existing better-sqlite3 file on first run after PURGE (DATA_DIR clean)
- No migration of existing local data (per `CLAUDE.md` — data is disposable)

---

## 5. Backend bootstrap promotion

Currently `src/index.ts` is the entry point. It:
1. Initializes singleton lock
2. Starts channel registry
3. Starts scheduler
4. Starts group queue
5. Starts the Hono web server (`src/clawrocket/web/server.ts`)
6. Starts the Talk run-worker
7. Wires IPC

After PURGE, only #5 survives. The new bootstrap is `src/clawrocket/web/server.ts` (or moved to `src/server.ts` for clarity), and:
- No singleton lock (single Node process anyway)
- No scheduler (no jobs to schedule once Talks/Channels are gone)
- No IPC (no other processes to talk to)
- No channel registry
- Direct startup: load env → init DB → start Hono → log "ready"

`npm run dev` is rewritten to launch this directly: `tsx src/server.ts`.

---

## 6. App.tsx routing tree purge

Current `webapp/src/App.tsx` has two routing trees:
- `/editorial/*` (survives)
- `/app/main`, `/app/main/:threadId`, `/app/talks`, etc. (dies)

After PURGE:
- Single routing tree under root or `/editorial/*` (decision: probably rename to root since editorial is the only product)
- Sign-in view at `/sign-in` (or whatever; keep current path)
- Redirect `/` → editorial root

Editorial Room currently early-returns for `/editorial/*` paths. After PURGE, this becomes the default — no early-return needed.

---

## 7. Package + repo rename

### `package.json`
- `"name": "nanoclaw"` → `"name": "editorialboard"`
- `"version"` — reset to `0.1.0` or keep continuity, your call
- Author / homepage / repository fields if needed
- Remove dead deps (Slack, Telegram, container, browser-automation, etc.)

### Repo rename
- GitHub repo `clawrocket` → `editorialboard` (one-click in GitHub settings; redirects from old name preserved)
- Local clone updated via `git remote set-url`
- CI references updated

### Branch convention
- Existing `claude/<slug>` branch convention continues
- Main branch stays `main`

---

## 8. Documentation rewrites

### `CLAUDE.md` — full rewrite
Drop:
- "NanoClaw-derived fork" framing
- "Two distinct runtime domains" framing
- Upstream-sensitive file boundaries (NanoClaw merging is dead)
- Container executor / channels / scheduler / IPC / group queues references
- `docs/UPSTREAM-PATCH-SURFACE.md` reference

Add:
- Single-product framing: "editorialboard.ai is the Editorial Room"
- Key files trimmed to editorial only
- Updated dev commands

### `README.md` — full rewrite
Drop NanoClaw-derived language. New brief description of editorialboard.ai + setup + dev commands.

### `docs/06_PHASE_1A_KICKOFF.md`
- Section A — heavy rewrite. Drop rocketorchestra references, drop Cloud Run references, drop the Phase Pre-1 cloud migration sections (those are now in `docs/CLOUD_TARGET.md`)
- Section B (rocketorchestra session prompt) — delete entirely
- Locked decisions — review each; many become stale

### `docs/EDITORIAL_ROOM_CONTRACT.md`
- Drop "cross-repo" framing
- Schemas remain useful as internal validation contracts
- Note that the contract is now ClawRocket-only (no rocketorchestra consumer)

### `docs/SPEC.md`, `docs/REQUIREMENTS.md`, `docs/SECURITY.md`, `docs/DEBUG_CHECKLIST.md`, `docs/OPERATIONS_UBUNTU.md`, `docs/UPSTREAM-PATCH-SURFACE.md`
- Review each. Most reference NanoClaw chassis; either rewrite for editorialboard or delete.

---

## 8.5 Current state (mid-session checkpoint, 2026-05-03)

### Merged to main
- ✅ **PR-1 (#298)** — frontend purge. 47K lines deleted; webapp src 22 files (was 70+); bundle 740KB (was 1.15MB). Editorial-only routing tree. New `webapp/src/lib/session-api.ts` carved from old `api.ts`. Sign-in heading updated to "editorialboard".
- ✅ **PR-2 (#299)** — backend bootstrap promotion. New `src/server.ts` (50 LOC) boots Hono directly without NanoClaw orchestrator. `npm run dev:editorial` script added. Old `npm run dev` (NanoClaw) still works in parallel.

### In progress (NOT merged)
- 🚧 **PR-3 WIP on branch `claude/purge-pr3-chassis-and-editorial-app`** — combined chassis purge + editorial-app extract. Pushed to remote with detailed status in commit message. **Typecheck currently failing** — `accessors.ts` (6142 LOC), `init.ts` schema (116 tables), and `server.ts` (8000 LOC inline routes) still need carving. Resume work picks up here.

### Not started
- ⏳ **PR-4 (DRAFT)** — was originally "top-level NanoClaw + persistence carve"; now folded into PR-3. PR-4 next will be the **rename + docs rewrite** step that was originally PR-6.
- ⏳ **PR-5** — none (sequence collapsed to 5 PRs)

### Revised PR sequence (5 PRs total, not 6)
- PR-1 ✅ Frontend purge
- PR-2 ✅ Bootstrap promotion
- PR-3 🚧 (DRAFT) Chassis purge + editorial-app extract (combined)
- PR-4 ⏳ (DRAFT) Rename + docs rewrite (was PR-6)

## 9. Phased PR sequence

PURGE is large enough to need multiple PRs. Each PR leaves the repo in a working state (test suite green, Editorial Room runs locally). **Recommended: 6 PRs, sequenced.** A single mega-PR is also viable (one big diff, one review pass, one merge) but harder to roll back if something breaks.

### Recommendation: 6 PRs

**PR-1: Frontend purge** (~50 files deleted, no backend change)
Delete:
- All Talk-related webapp pages, components, libs (TalkListPage, TalkDetailPage, MainChannelPage, DataConnectorsPage, AiAgentsPage if Talk-flavored, ClawTalkSidebar, TalkLlmSettingsCard, TelegramChannelConnectorPanel, SlackChannelConnectorPanel, etc.)
- Their tests
- App.tsx routing tree for `/app/*`
- Webapp libs: api.ts, mainStream.ts, talkStream.ts, slackInstallPopup.ts, googleAccountPopup.ts, googlePicker.ts, browser-blocks.ts, threadTitles.ts, assistantText.ts

Keep: all Editorial pages + components.
Risk: low — frontend deletion doesn't break backend; backend routes that webapp no longer calls become dead but harmless.

**PR-2: Backend bootstrap promotion** (~5 files added, ~5 files modified, none deleted yet)
- Move `src/clawrocket/web/server.ts` content into a new `src/server.ts` (or keep path; just ensure it's a standalone bootstrap)
- Add `npm run dev:editorial` that launches the new bootstrap
- Wire DB init, env load, Hono server, log ready
- Existing `npm run dev` (NanoClaw bootstrap) keeps working in parallel during this PR

Risk: low — additive, both bootstraps work.

**PR-3: Backend routes purge** (~30 files deleted)
Delete:
- All `src/clawrocket/web/routes/talk-*.ts`, `talks.ts`, `main-channel.ts`, `channels.ts`, `data-connectors.ts`, `browser.ts`, `events.ts`, `executor-settings*.ts` and their tests
- Update `src/clawrocket/web/server.ts` (or `src/server.ts`) to drop their route registrations

Keep: editorial-panel, llm-oauth, llm-oauth-openai, agent-management, ai-agents (provider listing), system, user-settings, auth.

Risk: medium — anything still importing these will break. Test suite catches.

**PR-4: Backend chassis purge** (~150 files deleted)
Delete:
- `src/clawrocket/agents/` (all)
- `src/clawrocket/talks/` (all)
- `src/clawrocket/channels/` (all)
- `src/clawrocket/connectors/` (all)
- `src/clawrocket/browser/` (all)
- `src/clawrocket/tools/` (all)
- `src/clawrocket/scheduler-maintenance.ts`
- `src/clawrocket/db/{agent,browser,browser-run,channel,connector,context,job,output,talk-tools}-accessors.ts` (and tests)
- `src/clawrocket/compat/` if Talks-only

Risk: medium-high — large deletion. Many cross-imports between these. Test suite + typecheck catch breakages. Some `src/clawrocket/db/accessors.ts` content needs to be preserved (carve in PR-5).

**PR-5: Top-level NanoClaw chassis + persistence carve** (~15 files deleted, 1-2 added)
Delete:
- `src/index.ts`
- `src/container-runner.ts`, `src/container-runtime.ts`, `src/container-execution-target.ts`
- `src/instance-coordinator.ts`
- `src/task-scheduler.ts`
- `src/group-queue.ts`, `src/group-folder.ts`
- `src/router.ts`, `src/ipc.ts`, `src/mount-security.ts`
- `src/channels/` (all)

Add:
- `src/editorial/db.ts` — typed editorial-only persistence accessors (the carved module per §3)
- `src/editorial/schema.sql` (or inline in TS) — ~10-table schema

Modify:
- `src/db.ts` — trim to just better-sqlite3 connection bootstrap; no schema; no accessors
- `src/clawrocket/db/init.ts` — drop 100+ table definitions; keep only the ~10 editorial-related ones
- `package.json` — `"main"` and `"scripts"` point at new bootstrap

Risk: high — this PR deletes the biggest pieces. Full test pass + manual dogfood of Editorial Room required before merge.

**PR-6: Rename + docs rewrite** (small file changes, big content changes)
- `package.json` rename to `editorialboard`
- Remove dead deps
- Rewrite `CLAUDE.md`, `README.md`
- Heavy edit `docs/06_PHASE_1A_KICKOFF.md`, `docs/EDITORIAL_ROOM_CONTRACT.md` cross-repo framing
- Delete `docs/UPSTREAM-PATCH-SURFACE.md`, `docs/OPERATIONS_UBUNTU.md` if no longer relevant
- (Optional) GitHub repo rename to `editorialboard`

Risk: low — mostly docs.

### Alternative: single PR
A single mega-PR (~250 files deleted, ~3 added, big docs diff) is reviewable in one pass but can't be rolled back incrementally. Pick this if you want one decision point.

**Recommendation:** the 6-PR sequence. Each PR is independently reviewable, leaves repo working, and rollbackable. The cost is 6 review cycles vs 1.

---

## 10. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Editorial Room implicitly depends on something we delete | Medium | High | Each PR runs full test suite + manual Editorial Room dogfood (Setup → Theme → Topic → Points → Draft → use `+ ASK PANEL`) before merge |
| `src/clawrocket/db/accessors.ts` carve misses an editorial-needed accessor | Medium | Medium | Grep for accessor usages from `src/clawrocket/llm/` and `src/clawrocket/web/routes/editorial-panel.ts` before deleting; preserve all referenced accessors |
| Some surviving file imports a deleted file | Certain | Low (caught by typecheck) | TypeScript catches; fix import-by-import |
| Identity service (`src/clawrocket/identity/`) has Talks-only code mixed in | Medium | Low | Audit before PR-4 / PR-5; identity stays minimal until cloud Phase D anyway |
| Local dev breaks after bootstrap promotion (PR-2) | Low | Medium | New bootstrap added in parallel to old; old keeps working until PR-5 deletes `src/index.ts` |
| Renaming the GitHub repo breaks links in TODOs / commit messages | Low | Low | GitHub auto-redirects from old repo name; PRs and historical URLs continue to resolve |
| Deleted code has hidden dependencies on `node_modules` packages we keep | Low | Low | After PR-5, remove unused `node_modules` packages from `package.json` based on `npm ls` |

---

## 11. Exit criteria

After PURGE merges:

- ✅ `find src webapp/src -type f \( -name '*.ts' -o -name '*.tsx' \)` shows ~50 files (down from ~280)
- ✅ `wc -l src webapp/src` shows ~25K LOC (down from ~180K)
- ✅ `npm run typecheck` passes (frontend + backend)
- ✅ `npm run test` passes — only editorial test files remain
- ✅ `npm run build` produces a working bundle
- ✅ `npm run dev` boots the new editorial-only bootstrap; health check at `/api/v1/health` green
- ✅ Manual Editorial Room dogfood: open browser → sign in → Setup wizard → Theme + Topics → Points + Outline → Draft → click `+ ASK PANEL` → real LLM critique streams back
- ✅ No imports from `src/clawrocket/agents/`, `talks/`, `channels/`, `connectors/`, `browser/`, `tools/` anywhere in surviving code
- ✅ No references to "NanoClaw" or "rocketorchestra" anywhere in surviving code (comments OK in CHANGELOG-style sections)
- ✅ `package.json` says `"name": "editorialboard"`
- ✅ `CLAUDE.md` describes editorialboard, not ClawRocket-on-NanoClaw
- ✅ `docs/CLOUD_TARGET.md` Phase A is checked off

When all ✅ pass, Phase B of the cloud port can begin.

---

## 12. Open decisions

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | 6-PR sequence or single mega-PR? | **6-PR sequence** — incrementally rollbackable; each leaves repo working |
| 2 | Repo rename `clawrocket` → `editorialboard` on GitHub now or later? | **Now (in PR-6)** — fits naturally with the rename PR; GitHub auto-redirects |
| 3 | Where does the editorial-only persistence module live? `src/editorial/db.ts` or `src/db.ts`? | **`src/editorial/db.ts`** — keeps `src/db.ts` minimal (just better-sqlite3 connection); makes the carve explicit |
| 4 | Sign-in path: keep `/sign-in` or rename? | **Keep `/sign-in`** — works; rename optional in cloud Phase D |
| 5 | Editorial routing tree: stay `/editorial/*` or move to root? | **Move to root in PR-1** — editorial is the only product; root + `/editorial/*` redirects is cleaner |
| 6 | What about `docs/contracts/editorial-room/v0/*.schema.json`? Keep, drop "cross-repo" framing? | **Keep** — still useful for internal fixture validation; just drop the cross-repo language |

---

## 13. Decision log

This plan was drafted on 2026-05-02 as the precondition for `docs/CLOUD_TARGET.md` Phase B. No decisions locked yet — pending review.

---

## 14. Next step

This plan needs review. Once approved:
1. Lock open decisions in §12
2. Start PR-1 (frontend purge)
3. Sequence PR-2 through PR-6 over ~1-2 weeks
4. After PURGE merges, begin `docs/CLOUD_TARGET.md` Phase B
