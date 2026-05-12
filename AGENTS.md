# ClawRocket Repo Context

See [README.md](README.md) for product overview. This file is the short coding context for agents working inside the repo.

## Current Project Shape

ClawRocket is a NanoClaw-derived fork with two distinct runtime domains:

1. **NanoClaw core**
   - single-process orchestrator
   - containerized Codex execution
   - channels, scheduler, IPC, group queues

2. **ClawRocket web/talk stack**
   - auth + RBAC
   - web UI and API
   - executor settings
   - provider-routed Talk runtime
   - direct HTTP streaming talk execution

Keep those domains separate when making changes.

## Engineering Defaults

- Prefer long-term stable architecture over backward-compatibility scaffolding.
- Do not preserve legacy APIs, schema shapes, data, or local users by default unless the task explicitly requires it.
- Treat existing local users and stored data as disposable by default at this stage of the project.
- If a simpler implementation requires resetting, deleting, or rebuilding local data/users, do that instead of carrying compatibility baggage.
- Remove dead paths instead of supporting old and new behavior in parallel.

## Most Important Boundaries

- Prefer ClawRocket-specific work under `src/clawrocket/*`.
- Treat changes to `src/index.ts`, `src/db.ts`, `src/config.ts`, and `src/task-scheduler.ts` as upstream-sensitive.
- Before widening that surface, check [docs/UPSTREAM-PATCH-SURFACE.md](docs/UPSTREAM-PATCH-SURFACE.md).

## Key Files

| File | Purpose |
| --- | --- |
| `src/index.ts` | core startup, singleton coordination, channels, scheduler, message loop |
| `src/instance-coordinator.ts` | single-instance ownership and graceful takeover |
| `src/container-runner.ts` | containerized core executor path |
| `src/clawrocket/web/index.ts` | web-server bootstrap and Talk worker wiring |
| `src/clawrocket/web/server.ts` | Hono app and HTTP bind lifecycle |
| `src/clawrocket/talks/direct-executor.ts` | provider-neutral direct Talk runtime |
| `src/clawrocket/talks/run-worker.ts` | queued Talk run dispatch |
| `src/clawrocket/talks/executor-settings.ts` | core executor settings + restart status |
| `src/clawrocket/db/init.ts` | ClawRocket schema |
| `src/clawrocket/db/llm-accessors.ts` | Talk provider, route, agent, and attempt persistence |
| `webapp/src/pages/SettingsPage.tsx` | executor + Talk LLM settings UI |
| `webapp/src/pages/TalkDetailPage.tsx` | Talk UI, agent targeting, streaming state |

## Current Runtime Facts

- Talk runtime mode is `direct_http`.
- Talks are stateless and text-only in v1.
- Core executor remains on the container/Codex path.
- Talk provider secrets are encrypted at rest.
- Core executor credentials are managed through the executor settings service.
- A built-in mock Talk route exists for first boot.
- Only one process should own a given `DATA_DIR`; a second process attempts graceful takeover.

## Operations Facts

- Ubuntu `systemd --user` is the canonical deployment model.
- `CLAWROCKET_SELF_RESTART=1` enables owner-triggered restart from the settings page.
- The web server should only log startup success after confirmed bind.

## Development Commands

```bash
npm run dev
npm run dev:web
npm run typecheck
npm run test
npm run build
npm --prefix webapp run typecheck
npm --prefix webapp run test
```

## Docs To Trust

- [docs/SPEC.md](docs/SPEC.md): current architecture
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md): current constraints/priorities
- [docs/SECURITY.md](docs/SECURITY.md): security model
- [docs/DEBUG_CHECKLIST.md](docs/DEBUG_CHECKLIST.md): debugging flows
- [docs/OPERATIONS_UBUNTU.md](docs/OPERATIONS_UBUNTU.md): production operations

## Docs To Avoid Reintroducing

- old phase plans
- rollout notes masquerading as source-of-truth docs
- upstream NanoClaw-only descriptions that ignore the ClawRocket web/talk stack
