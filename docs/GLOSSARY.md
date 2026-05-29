# ClawTalk — Glossary & Canonical Terms

> **Status:** canonical · **Last updated:** 2026-05-28
> One place to resolve the vocabulary forks across docs and code. If two docs use different words for the same thing, this file says which is canonical. Naming direction is set in [DECISIONS.md](./DECISIONS.md) D2 (provisional: orient to shipped DB names).

## Core concepts

| Term | Means | Notes |
|---|---|---|
| **Workspace** | Top-level tenant; permissions/billing/data root. | |
| **Folder** | Optional flat grouping of Talks. Live table: `talk_folders`. | Spec (`01`/`08`) calls it `folders`; DB says `talk_folders` — see D2. |
| **Talk** | A context-bound multi-agent conversation. | |
| **Round** | One turn of debate; Editor closes with synthesis. | |
| **Agent** | A fixed-role LLM reasoning role. Live table: `registered_agents` (+ per-Talk `talk_agents`). | Spec calls these `agents` / `talk_agent_snapshots` — see D2. |
| **Content / Document** | The editable long-form artifact attached to a Talk. Live table: `contents` (Content feature, PR #385). | Spec (`01`/`08`) calls it `Document` / `documents`. **Same thing.** Canonical name TBD in D2. |
| **Document tab** | A Google-Docs-style section inside one Content/Document. | **Specified (08) and prototyped, but not yet in the DB** — no `doc_tabs`/`doc_blocks`. Unbuilt. |
| **Pending edit** | An agent-proposed change awaiting accept/reject. Live: `content_edits` / `content_proposals`. | |
| **Tools** | What agents can *do* (web search, Drive read, …). Per-Talk + workspace catalog. | |
| **Connectors** | External service bindings (Slack, Drive, Linear, …). | `roadmap.md` #5 moved these **workspace-global**; `01` still shows per-Talk — reconcile (DOC-AUDIT #5). |
| **Context** | What the room *knows from* (primary doc, supporting docs, URLs, files, past Talks, rules, news). | |
| **Unfiled** | Virtual view: Talks with `folder_id is null`. **Not** Inbox. | |
| **Inbox** | Home queue of arrivals/blockers/waits. A Talk can be an Inbox item's *target*, never an item itself. | |
| **Curator** | Home copy/summary layer over deterministic state. Not the ranking source of truth. | |
| **Forge** | Autonomous content-improvement loop (generate→score→improve) over Content, using SSR as the scoring oracle. | PRD `09`, design `10`. |

## Easy-to-confuse pairs

- **Parallel mode ≠ "Panel" mode.** Canonical modes are **Ordered / Parallel** (`01`). "Panel" appears only in the archived ClawRocket review — ignore it.
- **Forge content-improvement ≠ agent prompt-improvement.** `06` §14's "Prompt Improvement Loop" improves *agent system prompts*; **Forge** (`09`/`10`) improves *document content*. Both share an "audit → propose → admin-accept → versioned rollout" shape but are different systems.
- **Primary document ≠ supporting document.** A Talk has 0–1 *primary* (editable) Content; many *supporting* documents are read-only via Context.
- **Unfiled ≠ Inbox.** Unfiled = no folder. Inbox = Home arrivals/blockers/waits.
- **Threads = removed.** `01` §1.4 removes Threads (Rounds replace them). The live `talk_threads`/`main_threads` tables are legacy drift — see D2.

## Retired terms (archived docs only)

**ClawRocket**, **Nanoclaw / Main (Nanoclaw)**, **registered route / `talk_routes`**, **container core executor**, **direct-HTTP vs containerized execution domains**, **SQLite**, **SSE event delivery**, **systemd / Ubuntu deployment**. All belong to the retired architecture in [`archive/`](./archive/). The product is **ClawTalk** on **Cloudflare Workers + Supabase Postgres**.
