## ClawTalk

ClawTalk is a web product where users invite different LLM personas into "Talks" — context-bound rooms — and watch them discuss together.

**Status:** Phase 5 PR 2 (sqlite → Postgres cutover in flight). Talk runtime is live on the cloud target (Cloudflare Workers + Supabase). Persona, context, and projects layers shipped. Deploy: clawtalk.app on Cloudflare + Supabase Postgres.

## What's inside

```
src/
  worker.ts                  Cloudflare Worker entry (cloud deploy target)
  server.ts                  Node entry (deferred retirement; see CLAUDE.md)
  db.ts, config.ts           postgres.js connection + global config

  clawtalk/
    talks/                   Multi-agent Talk runtime (executor, run-worker,
                             job-worker, attachments, source ingestion)
    agents/                  Agent registry, router, execution resolver
    llm/                     Provider catalog, secret store, direct-HTTP
                             streaming dispatcher
    db/                      Postgres schema + RLS-scoped accessors
    identity/                Auth + sessions
    web/                     Hono worker-app + route modules
    secrets/, security/      Keychain bridge, hashing

webapp/
  src/pages/                 TalkList, TalkDetail, AiAgents, Settings,
                             Profile (React + Vite)

supabase/
  migrations/                Postgres schema + RLS + grants
```

## Quick start

```bash
npm run install:all          # root + webapp deps
npm run db:start             # supabase local stack (ports 54430–54439)
npm run dev:worker           # wrangler dev on :8788 against local supabase
npm run dev:web              # vite on :5173, proxies /api/* to wrangler
```

Then open `http://localhost:5173`. Sign in via Google OAuth (configured in the local Supabase project).

## Development commands

```bash
npm run typecheck                  # backend tsc --noEmit
npm run test                       # backend vitest run
npm --prefix webapp run typecheck
npm --prefix webapp run test
npm --prefix webapp run build
npm run build                      # backend tsc → dist/
```

If you're on Node < 24 locally, set `CLAWTALK_ALLOW_UNSUPPORTED_NODE=1` to bypass the vitest version guard.

## Vision

A Talk is a room defined by:
- **The agents in it** — each LLM has a role + system prompt template (persona).
- **The context attached to it** — files, links, notes scoped to that Talk.
- **The history of the conversation** — persistent across sessions.

Projects (deliverables — blog posts, podcast scripts, books) are spun off from Talks and co-edited with the agents in the room.

See `docs/` for the current architecture and pending design work.
