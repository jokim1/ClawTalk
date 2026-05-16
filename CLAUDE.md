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
| `src/worker.ts`                                                                               | Cloudflare Worker entry — boots `getWorkerApp(env)`                |
| `src/db.ts`                                                                                   | postgres.js connection + `withUserContext` / Hyperdrive on Workers |
| `src/clawtalk/config.ts`                                                                      | Auth + provider env config                                         |
| `supabase/migrations/*.sql`                                                                   | Postgres schema + RLS policies + grants                            |
| `src/clawtalk/db/accessors.ts`, `agent-accessors.ts`, etc.                                    | Typed async pg accessors (tagged-template SQL, RLS-scoped)         |
| `src/clawtalk/talks/new-executor.ts`                                                          | CleanTalkExecutor — orchestrates a single Talk run                 |
| `src/clawtalk/talks/run-worker.ts`, `job-worker.ts`                                           | Talk run + job dispatch                                            |
| `src/clawtalk/talks/user-event-hub.ts`                                                        | Per-user Durable Object — WebSocket Hibernation event hub          |
| `src/clawtalk/agents/agent-registry.ts`, `agent-router.ts`                                    | Multi-agent registry + per-Talk routing                            |
| `src/clawtalk/llm/`                                                                           | Provider catalog, secret store, LLM client                         |
| `src/clawtalk/web/worker-app.ts`                                                              | Hono app + route registration for the Worker bundle                |
| `webapp/src/pages/TalkDetailPage.tsx`                                                         | Talk UI (agent targeting + streaming)                              |

## Chassis-removal stubs (transient)

`new-executor.ts`, `context-loader.ts`, `agents/agent-router.ts`, and `db/accessors.ts` have inline `// Chassis-removal stubs` blocks near the imports. They keep the type-checker green; remove them when the rest of the chassis surface comes out. (The web-route 410 stubs and the Node-mode entry were both retired in W7-evtsse U6.)

## Development Commands

```bash
npm run db:start              # supabase local stack on ports 54430–54439
npm run dev:worker            # wrangler dev on :8788 (Worker + DO + Hyperdrive)
npm run dev:web               # webapp on :5173 (proxies /api/* to :8788)
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
