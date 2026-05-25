# ClawTalk Repo Context

See [README.md](README.md) for product overview. This file is the short coding context for agents working inside the repo.

## Current Project Shape

ClawTalk is a web product where users invite different LLM personas into context-bound "Talks" and watch them discuss together.

- **Backend:** Hono worker in `src/worker.ts` (Cloudflare entry) → `src/clawtalk/web/worker-app.ts` (route mounts). Postgres via `src/db.ts` (postgres.js + `withUserContext` for RLS) → Supabase migrations in `supabase/migrations/`.
- **Talk runtime:** `src/clawtalk/talks/` — `/chat` enqueues onto `TALK_RUN_QUEUE`; the queue consumer in `queue-consumer.ts` runs `CleanTalkExecutor` per message and streams events to the per-user `UserEventHub` Durable Object. The cron-triggered `scheduler.ts` fans out due jobs onto the same queue every minute and sweeps stuck runs.
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
| `src/clawtalk/talks/queue-consumer.ts`, `queue-producer.ts`, `scheduler.ts`                   | Queue dispatch: per-message run executor, run-id producer, cron tick |
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
3. **Projects** — deferred. Joseph flipped the roadmap to do Phase 5 first.
4. ~~**Cloud port (Phase 5)**~~ — clawtalk.app on Cloudflare Workers + Supabase Postgres. PR 1 (#311), PR 2 (#312), W7-evtsse (#313–#318), Queues port (#320–#324) all shipped. Custom domain is the last open follow-up.
5. **Connectors refactor** — workspace-global channels + data connectors replacing the chassis-era per-Talk surface. PR 1 backend (#384), PR 2 additive UI (#386), sidebar retarget (#387) all shipped. **PR 3 cleanup is open** — delete `SlackChannelConnectorPanel.tsx`, `TelegramChannelConnectorPanel.tsx`, `ConnectorsPage.tsx`, slim `webapp/src/lib/api.ts` (~826 LOC), collapse TalkDetailPage's `state`/`channels`/`data-connectors` tabs into one `connectors`. Plan: `~/.claude/plans/connectors-refactor-plan.md`. Memory: `~/.claude/projects/-Users-josephkim-dev-clawtalk/memory/project_connectors_refactor.md` (includes reflog SHAs for the dropped PR 3 WIP).
6. **Content feature** — long-form documents 1:1 attached to Talks, with agent proposal cards. **PR 1 shipped (#385)**: schema, shared rich-text module (`src/shared/rich-text/`), accessors, API. Append-only `propose_content_append` in v1; replace and retrieve are v2. PRs 2–6 remain (sidebar + promotion modal → editor port → user edits + reconciliation → propose tool → ProposalCard). Plan: `~/.claude/plans/yes-let-s-plan-this-misty-crab.md`. Memory: `project_content_feature.md`.
7. **Jobs re-architecture (TODO, next week)** — Reports was killed (talk_outputs table dropped, Reports tab removed), so scheduled `talk_jobs` now always produce thread messages. The whole jobs surface needs rethinking in light of Content: should a scheduled job append to a Content doc via `propose_content_append`? Should it post to the thread? Both? Job UI, deliverable concept, and scheduler semantics all open for redesign. No plan file yet — start fresh.
