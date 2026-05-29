> ⛔ **ARCHIVED — not current.** Implementation spec for the retired "ClawRocket" (SQLite, container core, systemd, SSE). Superseded by 01-product-spec.md + 08-information-architecture.md; current stack is Cloudflare Workers + Postgres.
>
> Retired 2026-05-28 during the docs restructure. See [../DOC-AUDIT.md](../DOC-AUDIT.md) and [../README.md](../README.md). Kept for historical reference only.

# ClawRocket Specification

This document describes the current implementation, not historical rollout plans.

## 1. Scope

ClawRocket combines:

- the upstream-style NanoClaw core runtime
- a ClawRocket web application and authenticated API
- two LLM execution domains:
  - containerized core execution
  - direct HTTP Talk execution

The codebase is intentionally split so ClawRocket-specific behavior lives under `src/clawrocket/*` whenever possible.

## 2. High-Level Architecture

```text
Channels / Scheduler / IPC
        |
        v
  src/index.ts
    - singleton startup guard
    - core state + queue ownership
    - channel connection
    - scheduler + IPC startup
        |
        +--> container-runner.ts
        |      -> containerized Claude/NanoClaw execution
        |
        +--> src/clawrocket/web/index.ts
               -> web server + TalkRunWorker
                      |
                      +--> auth, RBAC, settings, Talks API
                      +--> direct Talk executor
```

## 3. Execution Domains

### 3.1 Core Executor

The core executor remains the upstream-sensitive path.

Properties:

- containerized
- Anthropic-compatible
- tied to the existing `container-runner.ts` and `container/agent-runner/*`
- reads credentials/runtime config from the executor settings service

This path still owns:

- channels
- scheduled tasks
- IPC-driven task actions
- group-scoped container execution

### 3.2 Talk Runtime

Talks use a separate runtime in `src/clawrocket/talks/direct-executor.ts`.

Properties:

- direct HTTP, not containerized
- streaming
- stateless context reconstruction
- text-only in v1
- provider-neutral route resolution
- sequential fallback

Talk runtime behavior:

- each Talk has one or more agents
- exactly one agent is primary
- user turns go to the primary agent unless `targetAgentId` is specified
- routes are global resources
- each route contains ordered provider/model steps
- fallback applies to retryable failures only

## 4. Persistence Model

### Core tables

Core NanoClaw data remains in the shared SQLite database managed through `src/db.ts`.

### ClawRocket tables

ClawRocket extends the shared DB with tables under `src/clawrocket/db/init.ts`, including:

- `users`
- `web_sessions`
- `talks`
- `talk_members`
- `talk_runs`
- `settings_kv`
- `llm_providers`
- `llm_provider_models`
- `llm_provider_secrets`
- `talk_routes`
- `talk_route_steps`
- `talk_agents`
- `llm_attempts`

Key distinctions:

- `settings_kv` backs core executor settings
- `llm_provider_*`, `talk_routes`, and `talk_agents` back the Talk runtime
- Talk provider secrets are encrypted before storage

## 5. Web and Auth Model

The web server uses Hono and is started from `src/clawrocket/web/index.ts`.

Capabilities:

- cookie-based authenticated web sessions
- Google OAuth / device auth support
- RBAC for `owner`, `admin`, and `member`
- SSE-based event delivery
- settings APIs for both executor settings and Talk LLM settings

Current public-access behavior:

- local-only installs remain the default
- public mode activates when `PUBLIC_MODE=true`, a trusted proxy mode is set, or the Google redirect URI is non-localhost
- public mode refuses startup unless secure-cookie, proxy, provider-secret, and Google OAuth requirements are met
- public mode also requires either `INITIAL_OWNER_EMAIL` or an existing owner in the DB
- device auth is disabled in public mode
- once an owner exists, normal invite-based onboarding continues
- request IP extraction uses `TRUSTED_PROXY_MODE`:
  - `none` -> socket address only
  - `cloudflare` -> `CF-Connecting-IP`
  - `caddy` -> `X-Forwarded-For`

Important routes:

- `/api/v1/health`
- `/api/v1/status`
- `/api/v1/session/*`
- `/api/v1/settings/executor`
- `/api/v1/settings/executor-status`
- `/api/v1/settings/talk-llm`
- `/api/v1/talks/*`
- `/api/v1/events`

## 6. Settings Model

### Core executor settings

Managed by `ExecutorSettingsService`.

Current responsibilities:

- bootstrap env-to-DB ownership handoff
- config versioning
- restart requirement diffing
- executor status reporting
- boot-marker reporting

### Talk LLM settings

Managed through typed DB accessors and the Talk LLM settings routes.

Current responsibilities:

- provider definitions
- provider models
- encrypted provider secrets
- named Talk routes
- global default Talk route

The current admin UI is functional but intentionally basic: it edits a JSON snapshot rather than a polished provider form.

## 7. Startup and Shutdown

`src/index.ts` now owns a per-`DATA_DIR` singleton coordinator.

The startup sequence is:

1. acquire singleton ownership
2. install signal-safe shutdown handling
3. initialize DB and ClawRocket schema
4. start web server / Talk worker
5. connect channels
6. start scheduler, IPC watcher, and message loop

The singleton coordinator:

- holds a live `ownership.lock` file handle
- writes `owner.json`
- exposes a local control socket for graceful takeover
- verifies process identity before using signals

## 8. Deployment Assumptions

- Linux, macOS, and WSL2 are supported
- Ubuntu `systemd --user` is the primary production path
- self-restart from the settings page requires `CLAWROCKET_SELF_RESTART=1`
- native Windows takeover is out of scope
- public internet exposure is Cloudflare-first in the current docs
- local-only installs require no changes to keep working after the public-mode additions

## 9. Current Constraints

- core executor stays upstream-friendly
- Talk runtime is stateless and text-only
- direct Talk execution is intentionally separate from the containerized core path
- routes are shared resources, not copied per talk
- docs should reflect current code, not old phase plans

## 10. Related Docs

- [README.md](../README.md)
- [REQUIREMENTS.md](REQUIREMENTS.md)
- [SECURITY.md](SECURITY.md)
- [UPSTREAM-PATCH-SURFACE.md](UPSTREAM-PATCH-SURFACE.md)
- [OPERATIONS_UBUNTU.md](OPERATIONS_UBUNTU.md)
