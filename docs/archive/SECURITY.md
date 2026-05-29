> ⛔ **ARCHIVED — not current.** Security model for the retired "ClawRocket" (container isolation, SQLite secrets, no RLS). Superseded; a fresh security doc for Workers + Postgres RLS is still TODO (see DOC-AUDIT.md #22).
>
> Retired 2026-05-28 during the docs restructure. See [../DOC-AUDIT.md](../DOC-AUDIT.md) and [../README.md](../README.md). Kept for historical reference only.

# ClawRocket Security Model

This document describes the current security model and its real limitations.

## 1. Trust Model

| Component | Trust Level | Notes |
| --- | --- | --- |
| Host process | Trusted | Owns DB, routing, settings, web auth, provider secrets |
| Web `owner` / `admin` users | Trusted operators | Can change runtime configuration |
| Non-admin users | Partially trusted | Can participate in Talks based on access controls |
| Core container agents | Sandboxed | Isolated from host by container boundary |
| Talk runtime prompts | Untrusted input | Processed in host process and sent to external providers |
| External model providers | External trust boundary | Receive Talk prompt content and provider credentials over API |

## 2. Primary Boundaries

### Core executor boundary

Core execution is protected primarily by container isolation:

- filesystem isolation via explicit mounts
- unprivileged execution inside the container
- per-group session and IPC separation
- host-side mount validation

This is the stronger isolation boundary in the repo.

### Talk runtime boundary

Talk execution is different:

- runs in the host process
- uses direct outbound HTTP
- is text-only in v1
- does not expose Bash/tools/container mounts to Talk agents

The Talk runtime is safer in capability scope than the core container path, but it is not container-isolated.

## 3. Credential Handling

### Core executor credentials

Core executor credentials are managed by the executor settings service and exposed to the containerized runtime as needed for Claude execution.

Important limitation:

- these settings are not encrypted at rest in a dedicated secret store
- they are not returned via settings APIs
- they are still sensitive host data and should be treated similarly to `.env` secrets

### Talk provider secrets

Talk provider secrets are stored separately and encrypted before being written to SQLite.

Important details:

- encryption key comes from `CLAWROCKET_PROVIDER_SECRET_KEY`
- if absent in development, the code falls back to an unsafe development key and logs a warning
- provider GET APIs expose only `hasCredential`, not the underlying secret

## 4. Web Security Model

The web app and API enforce:

- authenticated sessions
- CSRF protection on mutating routes
- idempotency on write paths where required
- RBAC for owner/admin/member roles

Current high-value admin surfaces:

- executor settings
- Talk LLM settings
- service restart

Restart remains owner-only.

## 5. Single-Instance Safety

ClawRocket now enforces one runtime owner per `DATA_DIR`.

This is primarily an operational safety mechanism, but it also reduces integrity risks such as:

- duplicate schedulers
- duplicate channel consumers
- duplicate Talk workers
- conflicting ownership of runtime state

The coordinator verifies process identity before using signals during takeover.

## 6. Known Limitations

1. Core executor credentials are not protected by the same encrypted secret store used for Talk provider secrets.
2. Talk prompts leave the host process and are sent to external providers selected by route configuration.
3. The Talk runtime is not container-isolated.
4. The core executor may still expose credentials to the runtime environment needed by the Claude/agent path.
5. Native Windows takeover is out of scope.

## 7. Practical Security Guidance

- Use the Talk runtime only with providers you are willing to trust with Talk content.
- Set `CLAWROCKET_PROVIDER_SECRET_KEY` in non-development environments.
- Use the Ubuntu systemd service rather than ad hoc manual background processes.
- Keep ClawRocket-specific changes under `src/clawrocket/*` so security-sensitive core changes stay auditable.
