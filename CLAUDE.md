# ClawTalk Repo Context

See [README.md](README.md) for product overview. This file is the short coding context for agents working inside the repo.

## Current Project Shape

ClawTalk is a web product where users invite different LLM personas into context-bound "Talks" and watch them discuss together.

- **Backend:** Hono worker in `src/worker.ts` (Cloudflare entry) → `src/clawtalk/web/worker-app.ts` (route mounts). Postgres via `src/db.ts` (postgres.js + `withUserContext` for RLS) → Supabase migrations in `supabase/migrations/`.
- **Talk runtime:** `src/clawtalk/talks/` — TalkRunWorker + TalkJobWorker + CleanTalkExecutor stream multi-agent responses via direct HTTP to LLM providers (Anthropic / OpenAI / etc.).
- **Frontend:** Vite + React under `webapp/`. TalkList → TalkDetail flow, AiAgents page for provider/agent config, Settings, Profile.
- **Identity:** Google OAuth + device-code auth in `src/clawtalk/identity/`. RBAC (`owner`, `admin`, `member`). HttpOnly access/refresh cookies + double-submit CSRF.

## Engineering Defaults

- Prefer long-term stable architecture over backward-compatibility scaffolding.
- Do not preserve legacy APIs, schema shapes, data, or local users by default unless the task explicitly requires it.
- Treat existing local users and stored data as disposable by default at this stage of the project.
- If a simpler implementation requires resetting, deleting, or rebuilding local data/users, do that instead of carrying compatibility baggage.
- Remove dead paths instead of supporting old and new behavior in parallel.

## Key Files

| File                                                                                          | Purpose                                                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/server.ts`                                                                               | Top-level entry: init DB → start web server → SIGINT/SIGTERM       |
| `src/db.ts`                                                                                   | postgres.js connection + `withUserContext` (cloud) / Hyperdrive on Workers |
| `src/clawtalk/config.ts`                                                                      | Server + auth + provider env config                                |
| `supabase/migrations/*.sql`                                                                   | Postgres schema + RLS policies + grants                            |
| `src/clawtalk/db/accessors.ts`, `agent-accessors.ts`, etc.                                    | Typed async pg accessors (tagged-template SQL, RLS-scoped)         |
| `src/clawtalk/identity/auth-service.ts`                                                       | Google OAuth + device-code + session lifecycle                     |
| `src/clawtalk/talks/new-executor.ts`                                                          | CleanTalkExecutor — orchestrates a single Talk run                 |
| `src/clawtalk/talks/run-worker.ts`, `job-worker.ts`                                           | Talk run + job dispatch                                            |
| `src/clawtalk/agents/agent-registry.ts`, `agent-router.ts`                                    | Multi-agent registry + per-Talk routing                            |
| `src/clawtalk/llm/`                                                                           | Provider catalog, secret store, LLM client                         |
| `src/clawtalk/web/server.ts`                                                                  | Hono app + route registration (monolithic; carve in a future PR)   |
| `webapp/src/pages/TalkDetailPage.tsx`                                                         | Talk UI (agent targeting + streaming)                              |

## Chassis-removed shims (transient)

`src/clawtalk/web/routes/{executor-settings,main-channel,browser,data-connectors,talk-tools,channels}.ts` and `_chassis-removed.ts` are tiny stub modules whose route handlers return HTTP 410 Gone. They exist only so `web/server.ts` still compiles after the chassis purge without ripping out hundreds of route registrations in one PR. Delete them and their referencing route registrations in `web/server.ts` as a follow-up cleanup PR. (`agent-management.ts` was restored to real persona CRUD by Phase 2 / PR #310.)

Similarly, `new-executor.ts`, `context-loader.ts`, `agents/agent-router.ts`, and `db/accessors.ts` have inline `// Chassis-removal stubs` blocks near the imports. Same deal — they keep the type-checker green; remove them when the rest of the chassis surface comes out.

## Node-path deferred retirement (Phase 5 PR 2)

After the U5-del sqlite-delete unit, `src/server.ts → web/index.ts → web/server.ts` and everything only consumed by that chain (`identity/auth-service.ts`, `identity/google-tools-service.ts`, `web/middleware/idempotency.ts`, `web/routes/{events,talk-context,talk-jobs,talk-attachments,talk-outputs,talk-threads}.ts`, plus their sqlite-era tests) are transient typecheck-broken zombies. The cloud-deploy surface (`src/worker.ts → web/worker-app.ts` and its mounted routes) typechecks clean. Local dev moves to `npm run dev:worker` (wrangler) + `npm run db:start` (supabase); the Node path retires entirely in a follow-up session.

## Cloud foundation (Phase 5 PR 1, parallel)

`supabase/` + `wrangler.toml` + `src/worker.ts` + `src/db-pg.ts` landed in PR #311 as additive surface alongside the SQLite path. The running app still serves from `tsx src/server.ts` against SQLite; PR 2 flips the entry. Local dev for the cloud foundation: `npm run db:start` (supabase on ports 54430–54439) + `npm run dev:worker` (wrangler dev on :8788). See `~/.claude/projects/-Users-josephkim-dev-clawtalk/memory/project_phase5_pr2_plan.md` for the PR 2 cutover plan.

## Development Commands

```bash
npm run dev                   # backend on :3210 (tsx src/server.ts)
npm run dev:web               # webapp on :5173 (proxies /api/* to :3210)
npm run typecheck             # backend tsc --noEmit
npm run test                  # backend vitest run
npm --prefix webapp run typecheck
npm --prefix webapp run test
npm --prefix webapp run build
```

## What's Next (Phase 2+)

1. ~~**AI Persona system**~~ — shipped in PR #310 (Phase 2). `description` column added; persona CRUD restored from chassis-removed stub; Talk-invite picker shows persona role + description.
2. ~~**Talk-level context**~~ — already in place from the chassis era and survived the purge. Context tab on TalkDetailPage exposes Goal + Sources; backend supports Rules + State entries too. Executor injects all four surfaces into the system prompt.
3. **Projects** — new top-level entity (deliverable). Talk → Project spinoff. Rich editor (port back from rocketboard / editorialroom rather than the in-repo archive tag — see `~/.claude/projects/-Users-josephkim-dev-clawtalk/memory/reference_sibling_repos.md`). **Deferred — Joseph flipped the roadmap order to do Phase 5 first.**
4. **Cloud port** — clawtalk.app on Cloudflare Workers + Supabase Postgres. **Phase 5 in flight.** PR 1 ("cloud foundation, additive") merged as #311. PR 2 ("cutover") queued — see the Phase 5 PR 2 memory.
