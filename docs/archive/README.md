# Archive — retired docs

These documents are **not current**. They mostly describe the retired **"ClawRocket"** architecture (a NanoClaw-derived fork on **SQLite + Docker containers + Telegram/WhatsApp + systemd**) that predates the rename to ClawTalk and the cloud port to **Cloudflare Workers + Supabase Postgres**. They are kept for historical reference and for the occasional durable insight, but an implementer should treat the canonical set in [`../`](../) (docs `01–10`, `README.md`, `roadmap.md`) as the source of truth.

Durable, still-useful knowledge has been lifted out before archiving — see [`../engineering-notes.md`](../engineering-notes.md) and [`../DECISIONS.md`](../DECISIONS.md).

| Doc | Why retired | Durable content lifted to |
|---|---|---|
| `ARCHITECTURE-REVIEW.md` | As-built review of ClawRocket (SQLite, containers, tool tiers). | `engineering-notes.md` (5 architectural commitments, execution-resolver credential rationale) |
| `SPEC.md` | ClawRocket implementation spec (SQLite, container core, systemd, SSE). | — (superseded by 01 + 08) |
| `REQUIREMENTS.md` | ClawRocket fork constraints (dual execution domains, systemd). | — (the "evergreen docs" principle, now in this restructure) |
| `SDK_DEEP_DIVE.md` | claude-agent-sdk reverse-engineering for the retired containerized executor. | Preserved verbatim — reusable if the agent-SDK path returns |
| `SECURITY.md` | ClawRocket security model (container isolation, SQLite secrets, no RLS). | A fresh Workers/RLS security doc is TODO (DOC-AUDIT #22) |
| `DEBUG_CHECKLIST.md` | ClawRocket ops runbook (sqlite3/journalctl/docker/port 3210). | — (write a new Workers/Postgres runbook if needed) |
| `CLAWTALK_V2_REBUILD_PLAN.md` | Greenfield rebuild plan; product layer covered by 01–08; Next.js/Node/Redis stack rejected. | `engineering-notes.md` (schema, latency budget, orchestration state machine) |
| `CLAWTALK_V2_REBUILD_PLAN_REVIEW.md` | Code-accurate critique of the rebuild plan. | `DECISIONS.md` #1 (stack) + `engineering-notes.md` (latency hotspots, eval gate, salvage list) |
