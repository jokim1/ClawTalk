> ⛔ **ARCHIVED — not current.** Engineering constraints for the retired "ClawRocket" NanoClaw fork (dual execution domains, systemd). Obsolete under the single Workers runtime.
>
> Retired 2026-05-28 during the docs restructure. See [../DOC-AUDIT.md](../DOC-AUDIT.md) and [../README.md](../README.md). Kept for historical reference only.

# ClawRocket Requirements And Constraints

This file captures current project constraints and engineering priorities.

## 1. Preserve The Boundary Split

ClawRocket is not a clean-slate rewrite. It is a NanoClaw-derived fork with an explicit boundary:

- keep the NanoClaw-style core small and upstream-friendly
- place ClawRocket-specific systems under `src/clawrocket/*`

If a change can live entirely under `src/clawrocket/*`, it should.

## 2. Keep Two Execution Domains Separate

There are two valid execution models in the repo:

1. **Core executor**
   - containerized
   - Claude/NanoClaw path
   - upstream-sensitive

2. **Talk runtime**
   - direct HTTP
   - provider-routed
   - stateless
   - ClawRocket-owned

Do not blur those paths unless there is a strong reason and explicit design work.

## 3. Prefer Typed Persistence Over Ad Hoc Config

Operator-visible runtime configuration should live in typed services and DB-backed settings, not in scattered env parsing or stringly typed blobs.

Current examples:

- `ExecutorSettingsService` for core executor settings
- typed Talk provider/route/agent tables for Talks

## 4. Keep Operations Deterministic

Operational behavior must be predictable on real hosts.

That means:

- one process per `DATA_DIR`
- startup only reports success after actual bind/listen success
- restart workflows are explicit and observable
- systemd-based Ubuntu deployment remains the canonical production path

## 5. Treat Talks As Product Surface, Not Just Debug UI

Talks are now a first-class subsystem with:

- authenticated access
- per-talk agents
- provider-routed execution
- streaming SSE events
- fallback logic
- settings-backed runtime configuration

Changes to the Talk runtime should be designed as product behavior, not quick internal tooling.

## 6. Keep Security Model Honest

Docs and code should distinguish clearly between:

- container-isolated core execution
- host-process direct Talk execution
- plaintext-at-rest core executor secrets
- encrypted-at-rest Talk provider secrets

Avoid implying stronger isolation or secret handling than the code actually provides.

## 7. Keep Docs Evergreen

Project docs should describe:

- the current implementation
- current operator workflows
- current safety boundaries

They should not be used to store:

- obsolete rollout phases
- stale design proposals
- duplicated architecture drafts

Historical planning artifacts should be archived or deleted rather than left as active context.
