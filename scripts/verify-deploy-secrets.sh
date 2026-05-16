#!/usr/bin/env bash
# Predeploy gate for W7-evtsse migration 0006.
#
# Migration 0006 revokes `authenticated` SELECT on event_outbox; only
# `clawtalk_event_hub` retains read access. The cloud Worker doesn't
# need read access (it only INSERTs), but the UserEventHub DO does —
# via the wrangler secret DB_EVENT_HUB_URL holding the connection
# string for the `clawtalk_event_hub` role.
#
# If 0006 applies before DB_EVENT_HUB_URL is set, the DO can't read
# the outbox and live events stop working. This script blocks the
# deploy when 0006 is in the migration tree and the secret is unset.
#
# Required env in CI:
#   - CLOUDFLARE_API_TOKEN (Workers read access)
#
# Exit codes:
#   0  — safe to proceed (no 0006 file, or secret is set).
#   1  — block the deploy (0006 present, secret missing).
#   2  — environment misconfigured (wrangler unavailable, etc).

set -euo pipefail

MIGRATION_GLOB="supabase/migrations/0006_*.sql"
SECRET_NAME="DB_EVENT_HUB_URL"

# If 0006 isn't in the tree yet, the gate is a no-op.
if ! compgen -G "$MIGRATION_GLOB" > /dev/null; then
  echo "[verify-deploy-secrets] No 0006 migration present — gate skipped."
  exit 0
fi

if ! command -v npx > /dev/null 2>&1; then
  echo "::error ::[verify-deploy-secrets] npx is not available; cannot run wrangler"
  exit 2
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "::error ::[verify-deploy-secrets] CLOUDFLARE_API_TOKEN is not set; cannot list wrangler secrets"
  exit 2
fi

# `wrangler secret list` returns JSON. Each entry is `{ name, type }`.
# We just need to confirm one entry has `name == SECRET_NAME`.
secret_json=$(npx --yes wrangler@4 secret list 2>/dev/null || true)
if [[ -z "$secret_json" ]]; then
  echo "::error ::[verify-deploy-secrets] wrangler secret list returned no output"
  exit 2
fi

if printf '%s' "$secret_json" | grep -q "\"name\":\\s*\"$SECRET_NAME\""; then
  echo "[verify-deploy-secrets] $SECRET_NAME is set — safe to apply 0006."
  exit 0
fi

cat <<EOF >&2
::error ::[verify-deploy-secrets] Migration 0006 is in the tree but $SECRET_NAME is not set.

  Apply migration 0005 first (creates the clawtalk_event_hub role),
  then set the role's password via the Supabase dashboard or
  ALTER ROLE, then set the wrangler secret with the full connection
  string:

    wrangler secret put $SECRET_NAME

  Re-run this deploy after the secret is set.
EOF
exit 1
