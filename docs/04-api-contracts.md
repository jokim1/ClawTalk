# ClawTalk · API Contracts

Framework-agnostic backend contracts derived from the prototype's behavior. Reference implementation should be REST + WebSocket (or Server-Sent Events). All endpoints are workspace-scoped unless noted. The canonical object hierarchy and document relationship are defined in `08-information-architecture.md`.

---

## §0 · Conventions

- **Base URL:** `https://api.clawtalk.app/v1`
- **Authentication:** `Authorization: Bearer <session_token>` for user requests, `Authorization: Bearer <api_key>` for programmatic.
- **Tenant scoping:** Every request that touches user data includes `X-Workspace-Id: <wid>` header. Reject mismatches.
- **Timestamps:** ISO 8601 UTC. Always.
- **IDs:** Opaque strings, ≤ 64 chars. Prefix by entity type: `ws_`, `f_`, `t_`, `d_`, `a_`, `team_`, `msg_`, `run_`.
- **Pagination:** Cursor-based. `?cursor=<opaque>&limit=50`. Response includes `nextCursor` (null when done).
- **Errors:** `{ error: { code: "VALIDATION_FAILED", message: "...", details: { ... } } }`. Use standard HTTP status codes.

---

## §1 · Auth & sessions

### Sign-in flows

| Endpoint | Purpose |
|---|---|
| `POST /auth/magic-link` | `{ email }` → sends magic link |
| `GET /auth/callback?token=...` | Magic-link callback. Sets session cookie. |
| `GET /auth/google` | OAuth start |
| `GET /auth/google/callback` | OAuth callback |
| `GET /auth/github` | OAuth start |
| `GET /auth/github/callback` | OAuth callback |
| `POST /auth/sign-out` | Invalidate session |
| `GET /me` | Returns current user + workspaces list |

### `GET /me`

```ts
{
  user: { id, name, email, avatarColor, initials },
  workspaces: [{ id, name, role: 'owner' | 'admin' | 'member', initials }],
  currentWorkspaceId: string
}
```

---

## §2 · Workspaces

| Endpoint | Purpose |
|---|---|
| `GET /workspaces` | List workspaces user belongs to |
| `POST /workspaces` | Create new workspace |
| `GET /workspaces/:id` | Full workspace info |
| `PATCH /workspaces/:id` | Update name/settings |
| `POST /workspaces/:id/invite` | Invite member by email |
| `GET /workspaces/:id/members` | List members |

**On workspace creation:** seed the 5 default agents and 3 default team compositions (see `03-agents.md`).

---

## §3 · Folders

| Endpoint | Purpose |
|---|---|
| `GET /folders` | All folders in workspace |
| `POST /folders` | `{ title }` → new folder |
| `PATCH /folders/:id` | Rename / reorder |
| `DELETE /folders/:id?with_talks=true|false` | Delete; optional cascade |

---

## §4 · Talks

### `GET /talks?folder=<id>|unfiled|all&include_archived=false`

```ts
{
  talks: [{
    id, workspaceId, folderId, title,
    mode: 'Ordered' | 'Parallel',
    rounds, team: [agentId],
    tools: { [toolId]: boolean },
    running: boolean,
    unread: number,
    archivedAt: null | string,
    lastActivityAt: string,
    primaryDocumentId: string | null,
    messageCount: number,
  }],
  nextCursor: string | null
}
```

### `POST /talks`

```ts
// Request
{
  title?: string,           // auto-derives from first message if omitted
  folderId?: string,        // null/omitted → Unfiled
  team: [agentId],          // 1-5 agent IDs
  mode: 'Ordered' | 'Parallel',
  rounds: 1 | 2 | 3 | 5,
  tools?: { [toolId]: boolean },
  initialPrompt?: string,   // if present, also creates first user message and kicks off round 1
}

// Response
{
  talk: Talk,
  initialRun?: Run   // populated if initialPrompt was sent
}
```

### `GET /talks/:id`

Full talk with messages.

### `PATCH /talks/:id`

Partial update — `title`, `folderId`, `mode`, `rounds`, `tools`, `team`.

### `POST /talks/:id/archive`

```ts
{ alsoArchiveDoc: boolean }
// Returns 204
```

### `POST /talks/:id/duplicate`

Returns a new Talk with copied user messages, fresh agent run state.

### `POST /talks/:id/messages`

User sends a message. Triggers a run for each agent in the team (Ordered → sequential, Parallel → fan out).

```ts
// Request
{ text: string, attachments?: [Attachment] }

// Response (202)
{
  message: UserMessage,
  runs: [{ id, agentId, runStatus: 'queued', queuePosition: number }]
}
```

Subscribe to the WebSocket stream (§9) to receive `run.update` events.

### `POST /talks/:id/cancel-runs`

Cancels every in-flight or queued run on this Talk.

---

## §5 · Messages & runs

```ts
type Message = UserMessage | AgentMessage;

type UserMessage = {
  id: string;
  role: 'user';
  authorUserId: string;
  text: string;
  attachments: Attachment[];
  createdAt: string;
  round: number;
}

type AgentMessage = {
  id: string;
  role: 'agent';
  agentId: string;
  runId: string;
  runStatus: 'queued' | 'running' | 'awaiting' | 'completed' | 'failed' | 'cancelled';
  queuePosition?: number;       // when queued
  text?: string;                 // when completed
  streamingText?: string;        // when running (partial)
  progress?: string;             // when running ("Reading 3 comps · synthesizing")
  tokens?: { in: number; out: number };
  toolCalls?: ToolCall[];        // tools the agent invoked during this run
  createdAt: string;
  round: number;
}

type ToolCall = {
  id: string;
  toolId: string;
  args: object;
  result?: object;
  durationMs: number;
}
```

### `GET /talks/:id/messages?after=<msgId>&limit=50`

Paginated. Most recent first by default.

---

## §6 · Agents

| Endpoint | Purpose |
|---|---|
| `GET /agents` | All agents in workspace |
| `GET /agents/:id` | Single agent |
| `PATCH /agents/:id` | Update name / model / persona / focus / method / enabled |
| `POST /agents/:id/reset` | Reset to defaults |
| `GET /agents/:id/stats` | Recent contributions across Talks |

```ts
type Agent = {
  id, workspaceId, roleKey, name, handle, initials, accent,
  model: string,
  defaultModel: string,
  job: string,            // read-only role description
  persona: string,        // editable tone/voice
  focus: string,          // editable domain/topic emphasis
  method: string[],       // editable visible reasoning moves
  capabilities: string[],
  isCustom: boolean,
  enabled: boolean,
}
```

Raw system prompt editing and custom-agent creation are out of scope for v1.
See `06-agent-system-design.md` for agent storage, prompt assembly, snapshots,
and evals.

---

## §7 · Team compositions

| Endpoint | Purpose |
|---|---|
| `GET /teams` | All teams in workspace |
| `POST /teams` | Create from agentIds + name |
| `PATCH /teams/:id` | Update |
| `DELETE /teams/:id` | Delete |
| `POST /talks/:id/save-as-team` | `{ name }` → snapshot current Talk team |

---

## §8 · Documents

| Endpoint | Purpose |
|---|---|
| `GET /documents?include_unlinked=true` | All docs in workspace |
| `POST /documents` | `{ title, format, primaryTalkId?, folderId?, tabs? }` → new |
| `GET /documents/:id` | Full doc with blocks |
| `PATCH /documents/:id` | Update title / format / primary Talk / folder |
| `DELETE /documents/:id` | Hard delete (no archive for docs in v1) |
| `POST /documents/:id/tabs` | `{ title }` → new document tab |
| `PATCH /documents/:id/tabs/:tabId` | Rename / reorder tab |
| `DELETE /documents/:id/tabs/:tabId` | Delete tab if document has 2+ tabs |
| `POST /documents/:id/blocks/:blockId/accept` | Accept a pending edit |
| `POST /documents/:id/blocks/:blockId/reject` | Reject a pending edit |
| `POST /documents/:id/accept-all` | Bulk accept |
| `POST /documents/:id/reject-all` | Bulk reject |

```ts
type DocTab = {
  id: string;
  documentId: string;
  title: string;
  order: number;
  blocks: DocBlock[];
}
type DocBlock = {
  id: string;
  tabId: string;
  kind: 'h1' | 'h2' | 'p' | 'li' | 'meta' | 'code';
  text: string;
  pending: boolean;
  pendingBy?: AgentId;     // who proposed this edit
}
```

Document creation creates one default tab named `Main` when `tabs` is omitted.
Blocks are always scoped to a tab.

---

## §9 · WebSocket — streaming protocol

Connect: `wss://api.clawtalk.app/v1/stream?workspace=<wid>` with `Authorization` header on the upgrade.

Server pushes events; client may send a few control messages.

### Server → client

```ts
// Streaming token chunk
{
  type: 'run.delta',
  runId, talkId, messageId, agentId,
  delta: string,          // characters to append to streamingText
  tokensSoFar: number
}

// Status transitions
{
  type: 'run.status',
  runId, talkId, messageId,
  status: 'queued' | 'running' | 'awaiting' | 'completed' | 'failed' | 'cancelled',
  details?: object
}

// Tool invocation
{
  type: 'run.tool-call',
  runId, talkId, messageId,
  toolCall: ToolCall
}

// Full message commit (use to replace streamingText with final text)
{
  type: 'message.commit',
  messageId, talkId,
  message: AgentMessage   // with final text + tokens
}

// Doc edit proposed by an agent
{
  type: 'doc.pending-edit',
  docId, tabId, blockId,
  pendingBy: agentId,
  block: DocBlock
}

// Talk-level state changes
{
  type: 'talk.state',
  talkId,
  patch: Partial<Talk>    // running flag, unread count, etc.
}
```

### Client → server

```ts
// Subscribe to a talk's stream
{ type: 'subscribe', talkId }

// Unsubscribe
{ type: 'unsubscribe', talkId }

// Heartbeat
{ type: 'ping' }
```

---

## §10 · Tools

Per-Talk tool state lives on the Talk. Workspace-level Tool catalog + connector configuration lives separately.

### `GET /workspace/tools`

Catalog of available tools with current connection status.

### `PATCH /talks/:id/tools`

```ts
{ tools: { 'web-search': true, 'gdrive-read': true, ... } }
```

### Tool IDs (v1)

`web-search` · `web-fetch` · `news-monitor` · `gdrive-read` · `gdrive-write` · `gmail-read` · `gmail-send` · `messaging` (Slack) · `linear` · `github-read`

---

## §11 · Connectors

### `GET /workspace/connectors`

```ts
[{
  id, service: 'slack' | 'gdrive' | 'gmail' | 'linear' | 'github' | 'notion' | 'telegram',
  authorized: boolean,
  authorizedAt: string,
  bindings: [{ talkId, target, scope: string[], enabled: boolean }]
}]
```

### `POST /workspace/connectors/:service/oauth-start`

Returns OAuth redirect URL.

### `POST /talks/:id/connectors/:service/bind`

Bind a service to this Talk with a target (e.g. `#pricing` for Slack).

---

## §12 · Context sources

Per-Talk context (supporting documents, URLs, files, past Talks, house rules, News items) lives separately from messages — it's what agents read *from*, not what they say. A Talk's primary document is projected into this API for display, but the source of truth is `documents.primary_talk_id`.

### `GET /talks/:id/context`

```ts
[{ id, kind: 'primary_document' | 'document' | 'url' | 'file' | 'past_talk' | 'rule' | 'news', name, meta, addedAt }]
```

### `POST /talks/:id/context`

```ts
{ kind, name, meta, payload }  // payload depends on kind
// Supporting document context:
// { kind: 'document', payload: { documentId, includeInPrompt: true } }
```

### `DELETE /talks/:id/context/:contextId`

---

## §13 · Home

Home is specified in `07-homepage-system-design.md`. The API should treat Home
as deterministic state, ranking, and structured actions first. Model use is
optional copy polish/clustering behind the same contracts.

### `GET /home/summary`

Returns curator headline, stats, active Talk summary, and Inbox counts.

### `GET /home/recommendations`

```ts
[{
  id,
  kind,
  title,
  why,
  priority: 'decide' | 'improve' | 'tidy',
  score: number,
  confidence: number,
  provenance: object,
  action: { type: string, payload: object },
  status: 'active' | 'dismissed' | 'completed' | 'expired' | 'snoozed',
  algorithmVersion: string,
  createdAt: string,
  expiresAt: string
}]
```

Recommendations are generated from deterministic candidates and ranked from
workspace state. The Curator may rewrite copy or cluster cards behind a feature
flag, but it does not emit arbitrary user-visible cards.

### `POST /home/recommendations/refresh`

Regenerate deterministic candidates and rerank cached state.

### `POST /home/recommendations/:id/action`

Validate and execute the structured action.

### `POST /home/recommendations/:id/dismiss`

### `POST /home/recommendations/:id/feedback`

### `GET /home/news`

```ts
[{
  id, headline, source, favicon, age, excerpt,
  url,
  talkId,
  matchedOn: string[],
  whyItMatters: string,
  impact: 'changes_assumption' | 'adds_evidence' | 'updates_competitor' | 'introduces_risk' | 'provides_tactic' | 'background_only',
  score: number,
  publishedAt: string,
  algorithmVersion: string
}]
```

News matcher pulls privacy-safe topic profiles from Talks where the
`news-monitor` tool is enabled. External providers receive only abstracts,
keywords, entities, domains, and negative terms. They never receive raw message
or document content.

### `POST /home/news/refresh`

Queues News refresh jobs and returns cached results.

### `POST /home/news/:id/add-to-context`

### `POST /home/news/:id/opened`

### `POST /home/news/:id/snooze`

### `POST /home/news/:id/feedback`

### `GET /home/inbox?limit=20&cursor=`

Returns active Inbox items for Home and shell badges. Inbox items are arrivals,
blockers, and waiting states; they are not Talk rows.

```ts
{
  items: [{
    id: string,
    type: 'agent_replied' | 'round_completed' | 'agent_asks_user' | 'run_failed' | 'doc_edits_ready' | 'connector_needs_auth' | 'news_context_added' | 'long_running_run' | 'system_limit_reached' | 'job_needs_review',
    title: string,
    summary: string,
    reason: string,
    severity: 'info' | 'action' | 'blocking',
    status: 'unread' | 'read' | 'resolved' | 'dismissed' | 'snoozed' | 'expired',
    target: { kind: string, id?: string, talkId?: string, documentId?: string, runId?: string },
    primaryAction: { type: string, label: string, payload: object },
    secondaryActions: [{ type: string, label: string, payload: object }],
    score: number,
    createdAt: string,
    algorithmVersion: string
  }],
  counts: { unread: number, blocking: number, action: number, info: number },
  nextCursor: string | null,
  algorithmVersion: string
}
```

Use `GET /talks?folder=unfiled` for folderless Talks. Use this endpoint for
Inbox items.

### `POST /home/inbox/:id/read`

### `POST /home/inbox/:id/resolve`

### `POST /home/inbox/:id/dismiss`

### `POST /home/inbox/:id/snooze`

### `POST /home/inbox/:id/action`

---

## §14 · LLM provider abstraction

Don't bake calls to specific providers into routes. Abstract through one interface:

```ts
interface LLMProvider {
  name: string;
  models: string[];
  stream(args: {
    model: string;
    messages: ChatMessage[];
    temperature: number;
    tools?: ToolDefinition[];
    abortSignal?: AbortSignal;
  }): AsyncIterable<TokenDelta>;
}
```

Implement provider adapters for:

- **Anthropic** (Claude Opus 4.5, Sonnet 4.5) — streaming, tool use
- **OpenAI** (GPT-5 Pro, GPT-5 Mini) — streaming, function calling
- **Google** (Gemini 2.5 Pro) — streaming, grounding for `web-search`

Each agent's `model` field selects provider + model variant.

---

## §15 · Rate limiting & quotas

Per-workspace, per-day:
- Token budget by plan tier (configurable; defaults: Team = 200k/day, Enterprise = unmetered).
- Concurrent runs cap (default 5).
- Concurrent Talks streaming (default 3).

Per-user, per-minute:
- Messages sent (default 60/min).
- Talks created (default 20/min).

Surface remaining budget in `GET /me` and on the Home stat strip.

---

## §16 · Audit & analytics events

Log everything that mutates state. Minimum events:

- `talk.created`, `talk.archived`, `talk.moved`
- `folder.created`, `folder.deleted`
- `message.sent`, `run.started`, `run.completed`, `run.failed`
- `doc.created`, `doc.edited`, `doc.deleted`
- `agent.edited`, `agent.reset`
- `connector.bound`, `connector.unbound`
- `member.invited`, `member.removed`, `role.changed`

Include `actorId`, `workspaceId`, `entityId`, `payload`, `timestamp`. Stream to your analytics + audit log.
