> ⛔ **ARCHIVED — not current.** Ops runbook for the retired "ClawRocket" (sqlite3/journalctl/docker/port 3210). None of these commands apply to the current Workers + Postgres + Queues + Durable Objects stack.
>
> Retired 2026-05-28 during the docs restructure. See [../DOC-AUDIT.md](../DOC-AUDIT.md) and [../README.md](../README.md). Kept for historical reference only.

# ClawRocket Debug Checklist

Use [OPERATIONS_UBUNTU.md](OPERATIONS_UBUNTU.md) for routine service management. This file is for targeted debugging.

## 1. Process Ownership And Single-Instance State

Check who owns the runtime:

```bash
ls -la data/runtime/instance
cat data/runtime/instance/owner.json
```

Key files:

- `data/runtime/instance/ownership.lock`
- `data/runtime/instance/owner.json`
- `data/runtime/instance/lock/control.sock` or hashed `/tmp` fallback socket

Useful checks:

```bash
pgrep -fa "node dist/index.js"
lsof -iTCP:3210 -sTCP:LISTEN || true
```

If startup/takeover is behaving strangely, verify:

- only one process owns the same `DATA_DIR`
- the PID in `owner.json` is real
- the process command line actually belongs to ClawRocket/NanoClaw

## 2. Health And Web Surface

```bash
curl -i http://127.0.0.1:3210/api/v1/health
```

Expected:

- `200` when DB is readable
- no optimistic “server started” logs on bind failure

If auth/session issues are suspected:

- sign in via the web UI
- inspect `/api/v1/session/me`
- inspect `/api/v1/settings/executor-status`

## 3. Core Executor Checks

The core executor still uses the container/Claude path.

Check:

```bash
journalctl --user -u nanoclaw -n 200 | rg -n "Talk executor mode selected|Database initialized|Container runtime"
docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw || true
```

Watch for:

- container runtime failures
- auth misconfiguration
- no channels connected

## 4. Talk Runtime Checks

Talks use the direct HTTP runtime.

Useful checks:

```bash
journalctl --user -u nanoclaw -n 200 | rg -n "direct_http|Retryable talk-provider failure|route_unavailable"
sqlite3 data/messages.db "SELECT id, status, created_at, started_at, ended_at FROM talk_runs ORDER BY created_at DESC LIMIT 10;"
sqlite3 data/messages.db "SELECT provider_id, model_id, status, failure_class, created_at FROM llm_attempts ORDER BY created_at DESC LIMIT 20;"
```

When debugging a specific talk:

```bash
sqlite3 data/messages.db "SELECT id, role, created_at, substr(content,1,120) FROM talk_messages WHERE talk_id = '<talk-id>' ORDER BY created_at DESC LIMIT 20;"
sqlite3 data/messages.db "SELECT id, name, route_id, is_primary, sort_order FROM talk_agents WHERE talk_id = '<talk-id>' ORDER BY sort_order;"
```

Look for:

- missing primary agent
- missing/default route mismatch
- retryable provider failures causing fallback
- repeated `route_unavailable` or auth/config errors

## 5. Settings And Provider State

Current settings split:

- core executor settings
- Talk LLM settings

Check:

```bash
sqlite3 data/messages.db "SELECT key, value FROM settings_kv WHERE key LIKE 'executor.%' OR key LIKE 'talkLlm.%' ORDER BY key;"
sqlite3 data/messages.db "SELECT id, provider_kind, api_format, enabled FROM llm_providers ORDER BY id;"
sqlite3 data/messages.db "SELECT route_id, position, provider_id, model_id FROM talk_route_steps ORDER BY route_id, position;"
```

Notes:

- Talk provider secrets are encrypted in `llm_provider_secrets`
- core executor credentials are managed separately via executor settings
- the admin UI currently edits Talk LLM settings as JSON

## 6. Channels And Scheduler

```bash
journalctl --user -u nanoclaw -n 200 | rg -n "Group registered|Task created|Task resumed|Task paused|Task cancelled"
journalctl --user -u nanoclaw -n 200 | rg -n "Connected to Telegram|Connected to WhatsApp|connection"
```

If duplicate consumer behavior appears, check the singleton guard first before chasing channel-specific causes.

## 7. Common Failure Patterns

### Health is down
- DB unreadable or initialization failed.

### Web server won’t bind
- another process owns the port
- or another ClawRocket process is already running and should be taken over intentionally

### Talk run never starts
- TalkRunWorker not running
- no valid primary agent / route
- provider disabled or route invalid

### Talk run starts but fails immediately
- provider credentials missing
- invalid provider/model configuration
- timeout or retryable upstream failure exhausted the route steps

### Restart button does nothing
- service is not running under `systemd --user`
- or `CLAWROCKET_SELF_RESTART=1` is missing
