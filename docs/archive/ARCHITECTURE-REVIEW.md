> ⛔ **ARCHIVED — not current.** As-built review of the retired "ClawRocket" architecture (SQLite + containers). Durable architectural commitments + the execution-resolver credential rationale are captured in ../engineering-notes.md.
>
> Retired 2026-05-28 during the docs restructure. See [../DOC-AUDIT.md](../DOC-AUDIT.md) and [../README.md](../README.md). Kept for historical reference only.

# Architecture Review: Post Main-Channel Wiring

All findings verified against source code. Decisions annotated inline.

---

## Architectural Commitments

These are non-negotiable architectural principles. Every implementation decision flows from these.

### 1. The DB transcript is the single source of truth

All conversation state lives in the database (`talk_messages`, main channel messages). No execution backend maintains its own persistent conversational memory for Talk or Main agents.

This resolves the fundamental state ownership split: the container path currently maintains Claude SDK session memory (`resume: sessionId`, `resumeAt`) which drifts from the DB transcript over time. The direct executor path already rebuilds from DB. Both paths must converge on DB-as-truth.

Consequence: Containerized Talk/Main agents are stateless per turn. Each invocation loads context from DB, executes one turn, persists the result back. Session resume is kept only for legacy external-chat paths (WhatsApp/Telegram) where the container is the primary conversation engine.

### 2. Container execution is a special adapter, not a second conversation engine

The container is a stateless compute unit that receives compiled context and returns a result. Same conceptual role as a serverless function. It does not own conversation state, does not maintain session continuity, and does not make architectural decisions about what context to include.

The structured context adapter compiles `ExecutionContext` → container workspace files + input fields. The host (Talk executor or Main executor) decides what context the container sees. The container executes and returns.

This means: the direct executor remains the default execution path for most agents. Container execution is an escalation for agents that need heavy local capabilities, and in 5A it is intentionally scoped to Main and single-agent Talk turns. The two backends are not peers — direct executor is the standard, container is the specialist.

### 3. Multi-agent Talks use explicit orchestration, not hidden agent-to-agent conversation

A user turn in a multi-agent Talk enqueues one run per selected target agent under an explicit orchestration mode. This is no longer just fan-out panel execution.

**Shipped default: Ordered.** Selected agents execute in `talk_agents.sort_order`. Later phases receive prior-agent outputs as attributed user-context, and the final phase is explicitly marked as synthesis.

**Quick alternative: Panel.** Selected agents respond independently. This is still useful for fast parallel perspectives, but it is no longer the primary model.

**Targeted subset override.** Explicit agent targeting narrows orchestration scope. If one agent is targeted, only that agent runs. If a subset is targeted, ordered or panel applies only to that subset.

What this is NOT (either version): emergent debate, hidden inter-agent messaging, or agents autonomously deciding to invoke other agents. Those patterns require a different architecture and create unpredictable UX.

### 4. Different agents will behave differently, and that's fine

A Claude agent with bash/filesystem runs in a container with different latency, streaming behavior, and error modes than a GPT agent doing research via the direct executor. This is a feature: different specialists work differently. The coherence comes from the shared transcript and context, not from identical execution semantics.

The per-agent routing model makes this explicit. Users see execution tier on the agent chip tooltip. They understand that enabling heavy tools means Claude-only container execution. They choose agents knowing the tradeoffs.

### 5. Container context for Talk/Main runs is ephemeral per run

When the structured context adapter materializes context files for a containerized Talk/Main agent, those files must live in a per-run ephemeral directory — not in the persistent `/workspace/group` mount.

Why: The current container workspace is a persistent writable mount (`container-runner.ts` line 98/130), and the runner uses `/workspace/group` as cwd with auto-loaded extras from `/workspace/extra/*` (`index.ts` line 445). If context files land in this persistent mount and are not cleaned up, they become out-of-band memory that survives across turns — violating Commitment #1.

Implementation: Create a unique temp directory per run and make it the container cwd. Generate:
- `CLAUDE.md` for Talk/workspace/run instructions
- `HISTORY.md` for bounded transcript history
- `sources/` and `attachments/` file manifests for materialized context

`CLAUDE.md` is rendered first, then `HISTORY.md` is budgeted from the remaining context window. Containers do not read SQLite directly; the host compiles DB state into files. In 5A, optional project mounts are read-only and mounted separately at `/workspace/project`.

### 6. Execution routing uses effective per-user permissions, not raw agent flags

The per-agent routing decision must evaluate `effectiveToolAccess` (agent capabilities ∩ user grants), not raw `tool_permissions_json`. The user permission layer (`user-settings.ts` line 54, merged in `agent-accessors.ts` line 594) includes per-user allow/deny and `requiresApproval` states.

Why: The container runner is configured with `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true` (`index.ts` line 489). If routing uses raw agent flags, a user who disabled heavy tools still gets a container run that bypasses host-side intent. This is a security model violation.

Implementation: Before routing, compute effective permissions. Routing uses `enabled` as the truth. In 5A, `shell` / `filesystem` are the heavy routing families and `browser` only counts when `shell` is also enabled. If a heavy family is denied by the user, the agent falls back to the direct executor with reduced capabilities (or the request is rejected with a clear message).

**Approval mechanism (decided): mutation-only runtime approvals.** Container spawn itself is not the approval boundary. Runtime approval remains for high-consequence external mutation families such as `gmail_send`, `messaging`, and `google_write`. Read/inspect families like `shell`, `filesystem`, `browser`, `web`, `connectors`, `google_read`, and `gmail_read` do not require per-run approval by default in 5A.

### What this plan delivers

Main (Nanoclaw) as the best everyday AI surface — fast, tool-capable, always available. Talks as configured workspaces with shared context, connectors, and selected agents. Ordered multi-agent Talks as the default synthesis surface, with panel as the quick alternative. Container Claude agents as premium heavy-tool specialists for Main and Talk turns, including mixed direct/container multi-agent rounds when shell/filesystem work is needed.

What it does NOT deliver in 5A: seamless free-form inter-agent conversation, identical behavior across all providers and backends, or real-time streaming from containerized agents (final-result-only).

---

## Architectural Foundation: Per-Agent Execution Routing

ClawRocket has two execution backends. The execution model is NOT tied to Talks or channels — it is a **per-agent, per-invocation routing decision** based on what tools the agent needs.

**Backend 1 — Container execution** (`container/agent-runner/src/index.ts`): Spawns a Docker container running the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). The SDK's `query()` function runs Claude Code with built-in tools: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task, etc. (agent-runner line 477-488). Tool loop, sandboxing, and execution are all handled internally. ClawRocket sends a prompt via stdin, gets results via stdout markers. Currently used for WhatsApp/Telegram messages and scheduled tasks. **Claude-only** — the Claude Agent SDK requires Anthropic API credentials.

**Backend 2 — Direct executor** (`agent-router.ts` → `llm-client.ts`): Calls LLM provider APIs directly (Anthropic, OpenAI, any provider). When the LLM returns a tool call, ClawRocket's own code executes it. Currently implements `read_context_source` and `read_attachment` (`new-executor.ts` line 162-237). Connector tools are stubbed. **Provider-agnostic** — works with any LLM that supports tool use.

### Per-agent routing model (decided)

The execution backend is chosen per-agent based on **effective permissions** (per Commitment #6: agent capabilities ∩ user grants), not per-Talk or per-channel:

- **Agent's effective permissions include heavy tools** (`shell`, `filesystem`, `browser` enabled AND allowed by user): Route to container execution. These tools require sandboxing that only the container provides. Currently Claude-only (Claude Agent SDK).
- **Agent needs only API tools** (connectors, web fetch, web search, Google Docs): Route to direct executor. These are HTTP API calls — no sandboxing needed. Works with any LLM provider.
- **Agent has heavy tools in `tool_permissions_json` but user has denied them**: Do NOT route to container. Either fall back to the direct executor with reduced capabilities or reject clearly.
- **Agent has heavy tools that are enabled but marked `requiresApproval` at the user layer**: This does not block container routing in 5A by itself. Runtime approval is reserved for high-consequence external mutation families, not container spawn.

**This means a single Talk can have mixed agents.** A Claude agent with `shell: true` gets container execution with full Bash/filesystem/web power. A GPT-4 or Gemini agent in the same Talk gets the direct executor with connectors + web tools. The Talk is the conversation container; the execution backend is per-agent.

### Routing decision point

The routing branch lives in the Talk executor (`new-executor.ts` line 321) and Main executor (`main-executor.ts` line 139). Currently both always use the direct executor. The change:

```
compute effectiveToolAccess(agent, user) — merge agent tool_permissions_json with user grants
effective permissions include shell/filesystem/browser?
  → container execution (runContainerAgent) — stream results back to Talk/Main SSE
  → must be Claude provider (container requires Claude Agent SDK)
  → context files in ephemeral per-run directory (Commitment #5)
else
  → direct executor (executeWithAgent) — HTTP API tools only
  → any LLM provider
```

### Execution Binding Model (decided — Commitment #7)

The direct executor path (`agent-router.ts → llm-client.ts`) needs to resolve three things before calling an LLM: provider config, auth scheme, and credential. These were previously resolved inline in agent-router.ts with growing special cases. That's now extracted into a single resolver: `execution-resolver.ts`.

**v1 scope: direct HTTP only.** The resolver handles one execution path — direct HTTP to a provider API. Container execution is a separate path entirely (container-runner → Claude Agent SDK) and is not managed by the resolver.

**Credential resolution (in `resolveSecret()`):**

```
1. Try llm_provider_secrets for the agent's provider_id
2. For provider.anthropic only: fall back to ANTHROPIC_API_KEY env var
3. OAuth/auth tokens are REJECTED — incompatible with x-api-key auth
4. If nothing found → hard error with specific code
```

**Why OAuth/subscription is rejected, not bridged:** An OAuth token or auth token sent as `x-api-key` to api.anthropic.com is not a valid API contract and fails silently. Rather than building a fake "claude_executor" mode that sends bearer auth to an endpoint that doesn't accept it, we reject early with a clear error. Subscription/OAuth users get Claude through container execution, which is the correct path for those credential types.

**What the UI shows:** The synthetic Claude provider card in `AiAgentsPage.tsx` shows `hasCredential: true` and real verification status ONLY when `executorAuthMode === 'api_key'` and an API key is stored. Subscription/OAuth users see Claude listed (agents may reference it) but marked as not ready for direct agent creation.

**Credential ownership is singular:**
- Direct HTTP (all providers): `llm_provider_secrets`, with API-key-only env var fallback for `provider.anthropic`
- Container execution: host-managed executor env vars (separate path, not in execution-resolver)

**v2 extension point:** When container-in-Talk ships, agents will gain an explicit execution target (e.g., `execution_kind: 'container'` on `registered_agents`). The resolver can then dispatch to the container path. That field does not exist yet — it will be added when the container backend is integrated with the Talk executor.

### What needs to change for container-in-Talk

**P0 — State ownership: enforcing Commitment #1 (DB-as-truth).**

Current state: `index.ts` line 315 passes `sessions[group.folder]` as `sessionId`, and the agent-runner resumes it (`resume: sessionId` at line 472). Between turns, `resumeAt` tracks the last assistant UUID (line 613) for incremental pickup. This is persistent Claude SDK session memory, separate from the database.

Per Commitment #1: containerized Talk/Main agents are stateless per turn. No `sessionId`, no `resume`, no `resumeAt`. Each turn loads context from DB → compiles into container input → executes one turn → persists result back.

Session resume is kept ONLY for legacy external-chat paths (WhatsApp/Telegram).

**Container context delivery (per Commitments #2 and #5: adapter with ephemeral context).**

Extend `ContainerInput` with structured context fields. Inside the agent-runner, compile them into Claude SDK inputs:
- `systemPrompt`: Talk system prompt + agent system prompt (runner already supports `systemPrompt.append` at line 474)
- `userMessage`: The current user turn as a separate field — NOT baked into a concatenated prompt blob
- `contextFiles`: For large context (history, context sources), write generated files (`TALK_CONTEXT.md`, source snapshots) into a **per-run ephemeral directory** (e.g., `/workspace/run-{runId}/`). Mount via `additionalDirectories` (line 445-456). Reference from system prompt.

**Per Commitment #5:** Context files MUST NOT land in the persistent `/workspace/group` mount. The ephemeral directory is created before the run and deleted after (success or failure). This prevents stale context from becoming out-of-band memory across turns.

This is clean because the runner already has the hooks — `additionalDirectories`, `systemPrompt.append`, and workspace mounts. The adapter compiles `ExecutionContext` → ephemeral context directory + input fields. No flat prompt concatenation, no persistent state leakage.

**Container output protocol — v1 accepts final result, not streaming deltas.**

The current runner only emits output on `message.type === 'result'` (agent-runner line 539). The host parser (`container-runner.ts` line 390) looks for `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER` pairs. There is no delta streaming protocol.

The Claude SDK's `query()` iterator does emit `message.type === 'assistant'` events with token content during generation, but the runner ignores these for output (only tracks `lastAssistantUuid` at line 526). So streaming data IS available inside the container — the runner just doesn't forward it.

For v1, containerized Talk/Main agents return the final result only. The Talk UI shows a "running..." state → completed result. This is acceptable because Tier 5 agents are doing heavy agentic work (running code, browsing) where a slight delay for the final answer is expected.

Future: Add a new marker type for delta streaming in the runner protocol, and parse incrementally on the host side. This is a protocol change, not just SSE mapping.

**Provider validation.** If an agent has Tier 5 tool permissions (`shell`/`filesystem`/`browser`), validate that its `provider_id` is Claude-compatible. Non-Claude agents with `shell: true` should be rejected at registration time.

### Tool capability tiers

| Tier | Tools | Backend | Provider | Effort |
|------|-------|---------|----------|--------|
| **Tier 1: Context tools** | `read_context_source`, `read_attachment` | Direct executor | Any | Already done |
| **Tier 2: Connector tools** | PostHog queries, Google Sheets read | Direct executor | Any | 3-5h (wiring only) |
| **Tier 3: Web tools** | `web_fetch`, `web_search` | Direct executor | Any | 5-7h total |
| **Tier 4: Google Workspace** | Docs read/write, Sheets write, Drive | Direct executor | Any | ~1 day per service |
| **Tier 5: Heavy/agentic** | Bash, filesystem, browser, code execution | Container | Claude only | Already works in container; routing integration ~1 day |

Tiers 1-4 are all HTTP API calls following the same `tool-executors.ts` pattern. Tier 5 is the existing container model. The per-agent routing model means you don't choose between them — each agent gets the right tier based on its permissions.

---

## P0: Blocking — must fix before shipping

### 1. Talk agent editing is not wired — and has a data model mismatch

**Status:** Confirmed. Two compounding problems.

**Problem A:** `updateTalkAgentsRoute` (talks.ts line 1038) validates input, then returns `agents: []` without persisting. The frontend trusts this and replaces local state with the empty array. Multi-agent Talks are unusable.

**Problem B:** The Talk Agents UI sends fields the DB can't store. The UI edits `sourceKind`, `providerId`, `modelId`, `nickname`, `nicknameMode`. But `talk_agents` only has columns: `id`, `talk_id`, `registered_agent_id`, `persona_role`, `is_primary`, `sort_order`. The active read path `listEffectiveTalkAgents()` (line 441) maps from `registered_agent_id` and hardcodes `sourceKind: 'provider'`, `providerId: null`, `modelId: null`, `health: 'ready'`.

**Decision: Talk agents = registered agent assignments.** Talks select from `registered_agents` and assign a `persona_role`. Provider/model config lives on the registered agent, not the Talk assignment.

**Dependency:** Requires registered-agent management UI (#6) to exist first — users need to be able to create agents before they can assign them to Talks.

**Effort note:** This is larger than a "wire persistence" fix. The fix requires:
1. Frontend API client methods for registered-agents CRUD (or reuse existing if wrapped)
2. Talk Agents tab UI rewrite: dropdown of registered agents + role assignment + primary toggle
3. Wire `updateTalkAgentsRoute` to persist into `talk_agents` (delete + insert)
4. Update `listEffectiveTalkAgents` to JOIN `registered_agents` for real provider/model/name/health

Revised estimate: 1-2 days including the UI rewrite.

---

## P0-feature: Main (Nanoclaw) — the default experience

### 2. Main Channel frontend

**Status:** Backend wired, no frontend exists.

**Decision:** The main channel is called **"Main (Nanoclaw)"**. It's the default chat surface — talk directly to the Nanoclaw agent with full tool access. This should feel like the Nanoclaw Telegram or WhatsApp connection.

**What to build:**
- Sidebar entry: "Main (Nanoclaw)" above the Talks section
- Thread list view (for main threads)
- Thread detail view: message timeline + streaming, no tabs

**Streaming note:** "Reuse talkStream.ts conventions" means the same EventSource/SSE patterns, NOT the same endpoint. Talks stream from talk-scoped SSE (`talkStream.ts` line 265). Main needs a sibling `mainStream.ts` over the user-scoped event stream with its own filtering/replay behavior. Same architecture, separate client.

**Product direction (decided):** Main (Nanoclaw) will eventually become a special Talk (with a real `talk_id`) so it can sync with external channels (Telegram, WhatsApp). This enables users to continue their Nanoclaw conversations across platforms. Multi-agent swarm channels are just regular Talks with multiple agents + a channel binding — no special type needed.

For v1, ship with the current `talk_id IS NULL` architecture. The migration to a real Talk happens when channel sync is built.

### 3. Tool execution gaps — shared runtime + per-tier wiring

**Status:** CONFIRMED — multiple compounding problems.

**Problem A (shared — agent-router tool loop):** `agent-router.ts` line 355 has `// TODO: Re-call LLM with appended result (implement tool loop)`. After executing a tool call and appending the result to messages, the router does NOT re-call the LLM. The LLM never gets a chance to interpret the result or make follow-up calls. This **unblocks shared multi-step tool semantics** — necessary for any tool use to work end-to-end. However, fixing the loop alone does not make tools appear where they're absent; each executor still needs its own definitions and callback.

**Problem B (Main-specific — no tools at all):** `main-executor.ts` (line 139) calls `executeWithAgent` without providing an `executeToolCall` callback. In `agent-router.ts` (line 332), tool execution only fires when `options.executeToolCall` is supplied. Additionally, `contextTools: []` and `connectorTools: []` means zero tool definitions are sent to the LLM.

**Problem C (Talk-specific — connector tools stubbed):** `new-executor.ts` (line 223-230) stubs connector tool execution with "not yet implemented" error. Connector tool definitions are also empty (`buildConnectorTools()` returns `[]`).

**Direct executor tool wiring (Tiers 1-4):**
1. Fix the tool loop in agent-router.ts — re-call LLM after tool result, add max-iterations guard. Effort: 2-3h.
2. Wire connector tools for Talks — definitions from `buildConnectorToolDefinitions()`, execution via `executeConnectorTool()`. Already built, just needs plumbing. Effort: 3-5h.
3. Wire connector tools for Main — same pattern, once Main has a callback. Effort: 2-3h after #1.
4. Add `web_fetch` tool — HTTP fetch + HTML-to-text extraction. Same `tool-executors.ts` pattern. Effort: 2-3h.
5. Add `web_search` tool — requires search API integration (Google Custom Search or Brave). Follows connector pattern. Effort: 3-4h.
6. Add Google Docs read/write — new connector type, same OAuth pattern as Sheets. Effort: ~1 day.

All Tier 1-4 tools are HTTP API calls. No sandboxing needed. The pattern is identical to the existing PostHog/Sheets connectors: define tool schema (`LlmToolDefinition` with `{ name, description, inputSchema }`) → implement HTTP execution → wire into `executeToolCall` callback. Each tool family builds its own definitions alongside its executor — no separate shared catalog needed. This is already how `buildConnectorToolDefinitions()` works in runtime.ts.

Note: `agent-router.ts` line 236 starts with `tools: LlmToolDefinition[] = []` and only pushes from `context.contextTools` and `context.connectorTools`. New Tier 2-4 tools must be added to the `ExecutionContext` the same way — the caller (Talk executor or Main executor) builds the tool definitions and passes them in. The router doesn't need to know about tool families; it just needs the `LlmToolDefinition[]` array.

**Container routing for heavy tools (Tier 5):**
Agents with `shell`/`filesystem`/`browser` in `tool_permissions_json` get routed to container execution instead of the direct executor. This is per-agent routing, not a new tool implementation. See "Per-agent routing model" in Architectural Foundation. Key requirements: stateless per turn (no Claude session resume), structured context adapter, final-result-only for v1 (no streaming deltas). Effort: ~2 days (routing + stateless adapter + context compilation + output mapping).

**Revised estimates:**
- 3a: Shared tool loop fix — 2-3h
- 3b: Connector tool wiring for Talks — 3-5h (see also #5)
- 3c: Main executor callback + connector tools — 2-3h (after 3a)
- 3d: Web fetch tool — 2-3h (new, follows connector pattern)
- 3e: Web search tool — 3-4h (new, requires search API key)
- 3f: Google Docs read/write connector — ~1 day (new, follows Sheets OAuth pattern)
- 3g: Per-agent container routing in Talk/Main executors — ~2-3 days (stateless adapter, ephemeral per-run context directory per Commitment #5, route on effective permissions per Commitment #6, structured context compilation, output mapping. No session resume for Talk/Main. Final-result-only for v1.)

### 4. Main Agent selector needs backend write support

**Status:** Confirmed — `setMainAgentId()` does not exist anywhere in the codebase. `getMainAgentId()` exists and `GET /api/v1/registered-agents/main` exists, but there's no write path.

**Decision (revised):** Default to Claude, but keep the write path provider-agnostic. The current main executor resolves any registered agent through the generic provider path (`agent-router.ts` line 172). Enforcing "Claude only" in the backend would be a new architectural limitation. If product wants Nanoclaw to default to Claude, set that as the initial configured main agent. The backend validates the agent exists and is enabled, but doesn't restrict by provider.

**Fix:**
1. Add `setMainAgentId(agentId: string)` in `agent-registry.ts` (writes to `settings_kv`)
2. Add `PUT /api/v1/registered-agents/main` route (admin only) — validates agent exists and is enabled
3. Add selector UI on the AI Agents page

---

## P1: Runtime/UI mismatches — fix soon

### 5. Data connector tools — wire them for real

**Status:** Confirmed. `buildConnectorTools()` in context-loader.ts (line 242) returns `[]`. But `buildConnectorToolDefinitions()` in runtime.ts (line 182) already generates real tool definitions. The tool executor in `tool-executors.ts` already knows how to call PostHog and Google Sheets.

**Decision:** Wire it for real. Also ship honest copy immediately as a stopgap.

**Implementation (corrected from earlier review):** The context loader does NOT need to decrypt credentials. The architecture is explicitly designed to carry ciphertext through to execution:
- `connector-accessors.ts` (line 58): `TalkRunConnectorRecord` includes `ciphertext` — "Sensitive: ciphertext is returned here so the runtime layer can decrypt it just-in-time."
- `buildConnectorToolDefinitions()` in runtime.ts only needs connector metadata (name, kind, config) — no credentials
- Decryption happens just-in-time in `tool-executors.ts` (lines 171, 218, 260) via `decryptConnectorSecret(context.connector.ciphertext)`

**Correct implementation steps:**
1. In `buildConnectorTools()`: query `talk_data_connectors JOIN data_connectors` to get `TalkRunConnectorRecord[]` (includes metadata + ciphertext)
2. Call `buildConnectorToolDefinitions(records)` from runtime.ts to get `ConnectorToolDefinition[]`
3. Convert to `LlmToolDefinition[]` for the executor context
4. In the Talk executor's `executeToolCall` callback: detect connector tool names, look up the matching `TalkRunConnectorRecord`, and call `executeConnectorTool()` from tool-executors.ts (which handles decryption internally)

No credential handling in the context loader. Revised estimate: 3-5 hours.

**Immediate stopgap:** Change UI copy to say "Preconfiguration — connector query tools coming soon."

### 6. AI Agents page: registered-agent management + credential consolidation

**Status:** Confirmed. Both pages call the same APIs. Additionally, the AI Agents frontend is missing any registered-agent management UI.

**Decision:** AI Agents owns all LLM provider credentials, registered agents CRUD, default agent selection, and provider verification. Settings becomes operational/admin only: executor status, restart, alias map, service health, diagnostics.

This means **removing the credential section from Settings**, not from AI Agents.

**Registered-agent management surface (prerequisite for #1 and #4):** The AI Agents page (`AiAgentsPage.tsx`) is currently built around provider/runtime management — it calls `getAiAgentsPageData()` which returns provider cards, not the registered-agents list. The backend has full CRUD at `GET/POST/PUT/DELETE /api/v1/registered-agents` but the frontend doesn't use any of it. The main-agent selector (#4) and Talk agent picker (#1) are both meaningless without a way to create and manage agents. The AI Agents page needs a registered-agent management section: list agents, create new agents (name + provider + model + system prompt + tool permissions), edit, delete, set as main.

**Tool permissions in agent creation:** When creating an agent, tool permissions determine the execution tier. The UI should make this clear: enabling `shell`/`filesystem`/`browser` means the agent runs in a container (Claude-only). Disabling those means the agent uses the direct executor (any provider). This is the user-facing surface for the per-agent routing model.

**This must ship before or alongside #1.** You can't build a Talk agent picker if there are no agents to pick from.

### 7. Talk agent health pills show hardcoded values

**Status:** Confirmed. `buildTalkAgentHealthLookup()` and `toTalkAgentApiRecord()` are **dead code** — neither is called anywhere. The active path `listEffectiveTalkAgents()` hardcodes `health: 'ready'`.

**Fix (after resolving #1):** Once Talk agents are registered-agent assignments, health comes from the registered agent's provider verification status:
1. In `listEffectiveTalkAgents`, JOIN to `registered_agents` for `provider_id`
2. Look up provider `verificationStatus`
3. Map to health enum
4. Delete the dead `buildTalkAgentHealthLookup` and `toTalkAgentApiRecord` functions

---

## P2: Incomplete flows — wire up

### 8. Google Sheets OAuth — wire it

**Decision:** Wire it. Users can walk into a dead end otherwise.

### 9. Talk connector attachment ignores verification readiness

**Fix (after #5 is wired):** Filter attach list to `verificationStatus === 'verified'`. Show unverified connectors greyed out.

### 10. User tool permissions — needs frontend

**Status:** Backend routes exist at `GET/PUT /api/v1/user/tool-permissions`. Zero frontend usage.

**Proposed UI:** A "Tool Access" section on the Profile page or as a new sidebar destination. Per tool family: toggle (allowed/blocked) + checkbox (requires approval before agent uses it). One card per tool family, global scope. Per-Talk grants on the Talk Tools tab further restrict.

**Note on per-agent routing:** Tool permissions interact with the execution routing model. If a user blocks `shell` globally, any agent with `shell: true` effectively can't use container execution for that user. The UI should reflect which permissions affect which tier — Tier 5 permissions (shell, filesystem, browser) gate container execution; Tier 2-4 permissions (connectors, web, google) gate direct executor tools.

### 11. Decide Talk-LLM settings surface: keep or remove

**Recommendation:** Archive. The registered-agents model is the canonical path. Remove the component and routes, or hide behind a feature flag.

---

## P3: Polish & future

### 12. Chat vs Talk distinction — unified model is the direction

**Decision:** Don't restructure now, but the product direction is decided: Main (Nanoclaw) will eventually be a special Talk. Everything converges into one conversation type with progressive disclosure of configuration. Multi-agent swarm channels are regular Talks with multiple agents + channel binding.

Ship Main (Nanoclaw) as a separate surface for v1. Migrate to unified Talk model when channel sync is built.

### 13. New Talk defaults — runtime already handles this, UI/copy only

**Status:** De-scoped after round 4 verification. The runtime fallback chain in `new-executor.ts` (line 263-267) already handles this: target agent → `resolvePrimaryAgent(talkId)` → `getMainAgent()`. A Talk with zero assigned agents already uses the main agent at execution time. No runtime work needed.

**Remaining work (UI/copy only):** Show onboarding copy in the Talk's initial state: "This Talk is using the default agent with all tools enabled. [Customize →]" so users know what's happening and can discover configuration. Effort: ~1h.

### 14. Channel bindings are Talk-only

No change. Clarify in UI copy.

### 14b. Agent chip tooltip — show tool capabilities and effective execution on hover

**Status:** New feature. Currently users have zero visibility into what an agent can do from the Talk conversation view.

**Key distinction: capability vs effective execution (per Commitment #6).** The UI must show two separate concepts:
- **Agent capability** (from `tool_permissions_json` on the registered agent): what the agent is *configured* to do. This is the agent definition.
- **Effective execution** (from `effectiveToolAccess` — agent capabilities ∩ user grants): what the agent *will actually do* for the current user. This reflects user-level allow/deny/approval state.

If these differ (e.g., agent has `shell: true` but user denied shell), the tooltip must show it. Otherwise "Full power (container)" on the agent chip is wrong — the agent will actually run on the direct executor with reduced capabilities.

**Design:** When a user hovers over an agent chip in the Talk header:

```
Claude Opus 4.6 (Analyst) — Primary
────────────────────────────────────
Capable: Shell · Filesystem · Web · Connectors
Active:  Shell · Filesystem · Web · Connectors
Execution: Full power (container)
```

```
Claude Opus 4.6 (Analyst) — Primary
────────────────────────────────────
Capable: Shell · Filesystem · Web · Connectors
Active:  Web · Connectors (Shell, Filesystem blocked)
Execution: Standard (reduced — user permissions)
```

```
GPT-4o (Researcher)
────────────────────────────────────
Capable: Web · Connectors · Google Docs
Active:  Web · Connectors · Google Docs
Execution: Standard
```

**Data source:** Capability from `tool_permissions_json` via `listEffectiveTalkAgents` JOIN. Effective execution from `effectiveToolAccess()` in `agent-accessors.ts` (line 594), which merges agent capabilities with user grants from `user-settings.ts` (line 54). Execution tier derived from effective (not raw) permissions.

**Dependency:** Requires #1 (Talk agents wired as registered-agent assignments), #7 (real agent data via JOIN), and the effective permission computation from Commitment #6.

**Effort:** ~3-4h frontend work. Backend already has `effectiveToolAccess` — may need a new API field to expose the delta between capability and effective.

### 15. Google Docs read/write connector — new connector type

**Status:** Not implemented in either execution model. Needed for agents that write reports, summaries, or collaborative documents.

**Implementation:** Follow the Google Sheets connector pattern — OAuth token management already works in `connectors.ts` (refresh, retry on 401). Google Docs API uses the same OAuth scopes/flow. Build as a new connector kind with tools: `google_docs_read` (fetch doc content as text/markdown), `google_docs_write` (append/replace content), `google_docs_create` (new doc).

**Effort:** ~1 day. The OAuth plumbing is solved; this is API integration work.

---

## Current Practical Order

The historical implementation-order checklist above is no longer the right roadmap. The current state is:

- Phase 1 through **Phase 7** are shipped in practical terms, including:
  - direct executor tool loop
  - Talk agent persistence and UI
  - Main executor web tools
  - ordered/panel multi-agent Talk orchestration
  - stateless per-agent container routing for Main + supported single-agent Talk turns
  - Rules elevation and structured Talk State
  - explicit separation between Channel Bindings and Data Connectors in the Talk UI
  - fully editable channel binding policies
  - Google Docs as a real data connector/tool surface
- Phase 8 and the immediate mixed-talk polish are now shipped:
  - per-run context inspection
  - lightweight role-aware context hints
  - lightweight retrieval on top of the standardized context package
  - mixed direct/container multi-agent backend parity
  - pre-send guardrails for unavailable multi-agent mixes
- Post-phase work remains:
  - Main → Talk migration when channel sync needs it
  - Outputs, Jobs, and a fuller execution planner
  - eventual Talk → Workspace rename once the model materially converges
