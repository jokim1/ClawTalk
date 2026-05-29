# ClawTalk Rebuild Plan

Status: review draft  
Date: 2026-05-28  
Posture: aggressive greenfield rebuild  
Canonical inputs:

- `docs/README.md`
- `docs/01-product-spec.md`
- `docs/02-visual-system.md`
- `docs/03-agents.md`
- `docs/06-agent-system-design.md`
- `docs/07-homepage-system-design.md`
- `docs/08-information-architecture.md`
- `docs/04-api-contracts.md`
- `docs/05-build-plan.md`
- `ClawTalk Salon.html`
- `prototype/*.jsx`
- `shared/data.jsx`

## 1. Executive Decision

Build ClawTalk from zero as a focused v1 product, not as a refactor of the
current codebase.

The current repo is useful archeology, but the rebuild target is the canonical
Salon package. That means:

- No Threads. A Talk contains rounds.
- No nested folders, tags, multi-folder Talks, or branches.
- No multiple primary documents per Talk. A Talk has zero or one primary
  document pane, but can read many supporting documents through Context.
- No async or scheduled agent jobs in v1.
- No community marketplace in v1.
- No real-time co-editing in v1.
- The prototype is the canonical UI reference.
- The product spec is the canonical behavior reference.
- The five default agents and three default teams are seeded into every
  workspace from `shared/data.jsx` plus the full prompts in `docs/03-agents.md`.

Recommended stack:

- Frontend: Next.js App Router, React, Tailwind.
- Backend API: Node.js, TypeScript, Fastify or Hono.
- Database: Postgres.
- Realtime and coordination: Redis plus WebSocket.
- LLM providers: Anthropic, OpenAI, Google.

This stack matches the handoff package and avoids spending the rebuild on
platform migration drama. The aggressive part is not the framework choice. It is
the schema reset, the run engine, and the decision to optimize the interactive
path around time-to-first-token.

## 2. What I Observed In The Prototype

I opened `ClawTalk Salon.html` locally and exercised the required flows:

- Signed in through the mock magic-link path.
- Clicked the left rail destinations: Home, Talks, Agents, Documents, command
  palette, and profile/workspace menu.
- Opened the Pricing v2 Talk.
- Sent a message in the Pricing v2 Talk.
- Watched Round 4 create the user message, show Strategy Lead streaming, and
  queue Critic, Researcher, and Editor.
- Opened the Tools popover. It is a toggle catalog grouped by Web, Google
  Workspace, Comms, and Work.
- Opened the Context popover. It shows the primary document, captured URLs,
  uploaded CSV, past Talk, and house rules.
- Opened the Connectors popover. It shows Slack, Drive, Gmail, Linear, and
  GitHub bindings.
- Hit Cmd+K and saw the action/jump palette.
- Archived the active Talk with a primary document and chose the safe default:
  archive Talk only, keep the doc unlinked.

Prototype details that should survive into production:

- The app should feel like a working salon, not a generic chat app.
- The left rail is primary navigation; the secondary Talk list is contextual.
- Agent attribution is the core UI grammar: avatar, role, handle, model, status,
  and tokens.
- The run-state cards appear immediately, even before every agent starts.
- Tools, Context, and Connectors are separate concepts and separate header
  buttons.
- The archive flow is careful when a primary document exists.
- The Home page is already the product's first screen after sign-in.

## 3. Product Scope For V1

### Core Objects

Workspace:

- Permissions root.
- Seeds agents, teams, default tools, and empty folders.
- Holds API keys, connector tokens, audit events, and quota.

Folder:

- Flat grouping only.
- A Talk has zero or one folder.
- Unfiled is the null-folder Talk view. Inbox is a Home queue of arrivals,
  blockers, and waiting items.

Talk:

- The main work surface.
- Has title, workspace, optional folder, mode, rounds, team roster, tool flags,
  unread count, running state, archive state, and optional primary document.
- Contains user and agent messages grouped into rounds.

Round:

- One pass through the Talk team.
- Ordered mode runs agents in team order.
- Parallel mode runs non-editor agents together, then Editor closes.

Agent:

- One of five fixed roles in v1: Strategist, Critic, Researcher, Editor, Quant.
- Role identity and accent are fixed.
- Display name, persona, focus, method, and model are editable within spec
  rules.

Team composition:

- Saved roster.
- Seed Pricing crew, Research crew, and Hiring crew.

Document:

- Markdown or HTML artifact.
- Primary-linked to zero or one Talk.
- Can be supporting read-only context for many Talks.
- Block-based editing with pending agent edits.
- Workspace-owned artifact, not a child row hidden inside the Talk.
- When primary-linked, it becomes the Talk's document pane and default document
  context.

Tools:

- What agents can do.
- Talk-scoped toggles backed by workspace catalog and permissions.

Connectors:

- Which external services this Talk is wired into.
- Workspace OAuth plus per-Talk binding target.

Context:

- What the room knows right now.
- Primary document, supporting documents, URLs, files, past Talks, and house
  rules.

Curator:

- System-level Home agent.
- Generates recommendations and news cards with provenance.
- Feature-flag the model call if needed, but build the Home surface.

### Explicit Non-Goals

- Threads.
- Multi-folder Talks or tags.
- Nested folders.
- Branches or sub-conversations inside a Talk.
- More than one primary document per Talk.
- Async scheduled agent jobs.
- Community marketplace.
- Multiplayer doc co-editing.
- Building from the old `TalkDetailPage.tsx`.

## 4. Repository Shape

Use a small monorepo so app, API, worker, schema, and shared contracts evolve
together.

Suggested layout:

```text
apps/
  web/                 Next.js App Router frontend
  api/                 Node HTTP API and WebSocket server
  worker/              interactive run worker process
packages/
  contracts/           shared Zod schemas and TypeScript types
  db/                  schema, migrations, query helpers
  agents/              seeded definitions, prompt assembly, orchestration
  llm/                 Anthropic/OpenAI/Google adapters
  realtime/            WebSocket event types and reducers
  documents/           block model, markdown/html projections, sanitization
  ui/                  Salon tokens and reusable UI primitives
  config/              eslint, tsconfig, tailwind presets
docs/
  canonical specs plus this plan
```

The production app should not import from `/prototype` at runtime. The prototype
is a reference and a source of UI patterns. Port the behavior into production
components, then delete any production dependency on Babel-in-browser code.

## 5. Visual System Implementation

Extract the Salon tokens exactly from `docs/02-visual-system.md`.

CSS variables:

```css
:root {
  --salon-paper: #FBF7EF;
  --salon-paper-2: #F4ECDB;
  --salon-card: #FFFFFF;
  --salon-ink: #1F1B16;
  --salon-ink-2: #6B6660;
  --salon-line: #E6E0D1;
  --salon-accent: #C8643A;
}
```

Fonts:

- Newsreader for Talk titles, page headers, agent message bodies, and docs.
- Geist for UI.
- Geist Mono for metadata, status pills, shortcuts, IDs, and timestamps.
- Instrument Serif is optional for display moments.
- Do not introduce Inter, Roboto, Arial, Fraunces, emoji, gradient themes, or
  off-palette brand colors.

Production component targets:

- Left icon rail from `prototype/shell.jsx`.
- Run pill and agent avatar from `prototype/shell.jsx`.
- Tools popover from `prototype/tools.jsx`.
- Context and Connectors popovers from `prototype/talk-dialogs.jsx`.
- Home Focus layout from `prototype/home-focus.jsx`.
- Documents table/editor from `prototype/documents.jsx`.
- Agents roster/profile from `prototype/agents.jsx`.
- New Talk sheet and archive/folder dialogs from `prototype/talk-dialogs.jsx`.
- Cmd+K palette from `prototype/screens.jsx`.

Strip the Tweaks panel from production. The production default is Salon, cozy
density, focus Home layout.

## 6. Data Model

Start with one clean baseline migration. There is no data that must be
preserved.

### Identity And Workspace

- `users`
  - `id`, `email`, `name`, `initials`, `avatar_color`, timestamps.
- `auth_accounts`
  - provider identity for Google, GitHub, and magic-link.
- `sessions`
  - server-side session records if not using a hosted auth layer.
- `workspaces`
  - `id`, `name`, `initials`, `owner_id`, `region`, `plan`, timestamps.
- `workspace_members`
  - `workspace_id`, `user_id`, `role`.

### Product Structure

- `folders`
  - `id`, `workspace_id`, `title`, `sort_order`, timestamps.
- `talks`
  - `id`, `workspace_id`, `folder_id`, `title`, `mode`, `rounds`, `team_id`,
    `tools_json`, `running`, `unread`, `archived_at`, timestamps.
  - Do not store the canonical document relationship here. Materialize
    `primaryDocumentId` in API responses by looking up
    `documents.primary_talk_id`.
- `talk_agent_snapshots`
  - `id`, `talk_id`, `source_agent_id`, `sort_order`, `role_key`, `name`,
    `handle`, `initials`, `accent`, `model`, `persona`, `focus`,
    `method_json`, `capabilities_json`, `role_template_version`,
    `global_policy_version`, timestamps.
  - This preserves what a Talk used even if the workspace agent changes later.
- `messages`
  - `id`, `talk_id`, `round`, `role`, `author_user_id`, `agent_id`, `run_id`,
    `text`, `attachments_json`, timestamps.
- `runs`
  - `id`, `talk_id`, `message_id`, `agent_id`, `round`, `sequence_index`,
    `mode`, `status`, `queue_position`, `progress`, `tokens_in`, `tokens_out`,
    timing columns, error fields, timestamps.
- `run_events`
  - append-only event stream for status, token deltas, tool calls, commits, and
    cancellation.
- `tool_calls`
  - `id`, `run_id`, `tool_id`, `args_json`, `result_json`, `duration_ms`,
    timestamps.

### Agents And Teams

- `agents`
  - `id`, `workspace_id`, `role_key`, `name`, `handle`, `initials`, `accent`,
    `accent_dark`, `model`, `default_model`, `persona`, `focus`,
    `method_json`, `capabilities_json`, `is_default`, `is_custom`, `enabled`,
    `disabled_at`, `created_from_template_version`, timestamps.
  - Do not store user-editable raw system prompts or expanded technical
    characteristic fields on workspace agents in v1. See
    `docs/06-agent-system-design.md`.
- `agent_role_templates`
  - Optional v1 table or code fixture for fixed role defaults: role identity,
    job, default model, default persona/focus/method, canonical prompt,
    output instruction, capabilities, eval checks, and UI accent. Use a table
    only if admin editing of templates is needed.
- `team_compositions`
  - `id`, `workspace_id`, `name`, `description`, `icon`, `recommended_mode`,
    `suggested_rounds`, `default_tools_json`, `missing_perspective`,
    `is_default`, `runs`, timestamps.
- `team_composition_agents`
  - `team_id`, `agent_id`, `sort_order`.
- `run_prompt_snapshots`
  - `run_id`, `talk_id`, `agent_snapshot_id`, `provider`, `model`,
    `global_policy_version`, `role_template_version`,
    `prompt_assembly_version`, `context_manifest_json`, `tool_manifest_json`,
    `prompt_hash`, `prompt_text_redacted`, timestamps.
- `agent_feedback_events`
  - per-message thumbs up/down, "useful", "off-topic", "too verbose",
    "missed evidence", and "wrong model" feedback for future prompt/model
    tuning.

### Documents

- `documents`
  - `id`, `workspace_id`, `primary_talk_id`, `folder_id`, `title`, `format`,
    `last_edit_at`, `word_count`, timestamps.
  - Add a partial unique index on `primary_talk_id` where
    `primary_talk_id is not null`.
  - `primary_talk_id` is the source of truth for whether a document is the
    primary document for a Talk.
- `doc_tabs`
  - `id`, `workspace_id`, `document_id`, `title`, `sort_order`, timestamps.
  - Every document has at least one tab. The UI can hide the tab bar when there
    is only one tab.
- `doc_blocks`
  - `id`, `workspace_id`, `document_id`, `tab_id`, `sort_order`, `kind`, `text`,
    `attrs_json`, `pending`, `pending_by_agent_id`, timestamps.
- `doc_edits`
  - `id`, `document_id`, `tab_id`, `block_id`, `run_id`, `agent_id`,
    `operation`, `payload_json`, `status`, `created_at`, `resolved_at`.

This follows the API contract's tabbed block model while leaving room for better
markdown/html projections.

### Tools, Connectors, Context

- `tool_catalog`
  - static seeded tool definitions and groups.
- `workspace_tool_settings`
  - workspace default enablement and configuration.
- `connectors`
  - workspace OAuth authorization, service, scopes, status, token reference.
- `connector_bindings`
  - `connector_id`, `talk_id`, `target`, `scope_json`, `enabled`.
- `context_sources`
  - `id`, `workspace_id`, `talk_id`, `kind`, `name`, `source_document_id`,
    `source_talk_id`, `meta_json`, `payload_ref`, `extracted_text`, `summary`,
    `include_in_prompt`, `added_at`.

### API Keys, Audit, Quotas

- `api_keys`
  - hashed token, label, scopes, last used, revoked at.
- `audit_events`
  - append-only mutation log per `docs/04-api-contracts.md`.
- `llm_attempts`
  - provider/model telemetry, TTFT, duration, token usage, cost, and failure
    class.
- `workspace_usage_daily`
  - token and prompt counters for Home stats and limits.
- `home_inbox_items`
  - arrivals, blockers, and waiting items across Talks, documents, runs,
    connectors, News context, and future jobs.
- `home_recommendation_candidates`
  - generated candidate actions with state fingerprint, provenance, features,
    confidence, and expiration.
- `home_recommendations`
  - ranked/displayable cards with score, provenance, action payload, status,
    dismissal state, and algorithm version.
- `home_news_topics`
  - privacy-safe per-Talk topic profiles generated from News-monitor-enabled
    Talks.
- `home_news_items`
  - canonical fetched News items by URL/content hash.
- `home_news_matches`
  - Talk-to-News matches with impact classification, score, status, and
    provenance.
- `activity_events`
  - compact Home/sidebar event feed derived from audit events, run events, doc
    edits, Inbox items, and connector state.
- `home_interaction_events`
  - impressions, clicks, dismissals, snoozes, add-to-context actions, and
    recommendation completions used to tune v1 ranking.
- `home_ranking_profiles`
  - bounded workspace-level preference weights for recommendations, News, and
    Inbox ordering.
- `home_optimization_proposals`
  - admin-reviewed proposals for structural Home algorithm changes.

Indexes should prioritize:

- `talks(workspace_id, archived_at, last_activity_at desc)`
- `talks(workspace_id, folder_id, archived_at, last_activity_at desc)`
- `messages(talk_id, round, created_at)`
- `runs(talk_id, status, created_at)`
- `run_events(run_id, id)`
- `documents(workspace_id, last_edit_at desc)`
- `documents(primary_talk_id) where primary_talk_id is not null`
- `doc_tabs(document_id, sort_order)`
- `doc_blocks(tab_id, sort_order)`
- `doc_edits(document_id, status)`
- `context_sources(talk_id, kind)`
- `audit_events(workspace_id, timestamp desc)`
- `home_inbox_items(workspace_id, status, score desc, created_at desc)`
- `home_recommendations(workspace_id, status, score desc, created_at desc)`
- `home_news_matches(workspace_id, status, score desc, created_at desc)`
- `activity_events(workspace_id, created_at desc)`
- `home_interaction_events(workspace_id, created_at desc)`

## 7. Fast Interactive Architecture

The main latency problem to solve is not raw model speed. It is users waiting in
an invisible queue before anything appears.

Aggressive rule:

Interactive Talk runs must not wait behind background work.

### Send Message Path

1. Client optimistically appends the user message locally.
2. Client sends `POST /talks/:id/messages`.
3. API validates workspace, permissions, current Talk state, and quota.
4. In one Postgres transaction:
   - insert user message
   - insert one queued run per agent in the active round
   - insert `run.status` events for queued runs
   - update Talk `running`, `last_activity_at`, and unread counters
5. API publishes run events to Redis pub/sub or Redis Streams.
6. API returns 202 with message and queued run cards.
7. Interactive worker claims the next eligible run immediately.
8. Worker emits `running`, `progress`, `run.delta`, tool calls, and commit
   events over WebSocket.

Use Redis for realtime coordination and backpressure. Do not use a delayed
batch queue for the normal interactive path.

### Latency Budget

Targets for local and production smoke tests:

| Stage | Target p50 | Target p95 |
|---|---:|---:|
| Optimistic local message visible | 50 ms | 100 ms |
| API 202 returned | 150 ms | 300 ms |
| Queued run cards visible | 200 ms | 400 ms |
| First worker claim | 250 ms | 600 ms |
| Provider stream request started | 600 ms | 1200 ms |
| First model delta visible | 600-1500 ms | 3000 ms |
| Cancel intent visible | 100 ms | 200 ms |
| Provider abort after cancel | 2000 ms | 5000 ms |

The spec's launch target is under 600 ms TTFT. Treat that as the goal for warm,
healthy provider paths. Also measure and display provider-caused delays
honestly.

### Queue Policy

Redis/BullMQ is acceptable for:

- non-interactive retries
- connector sync
- news refresh
- stuck-run recovery
- digest/cache jobs
- failed runner rescue

These are infrastructure jobs. They must not become user-visible scheduled
agent workflows, which are out of scope for v1.

Redis/BullMQ is not acceptable for:

- putting an ordinary user message behind minutes of unrelated work
- hiding the reason a run is still queued
- ordered mode orchestration by repeated delayed retries

## 8. Run Orchestration

### Ordered Mode

Default order when all five agents are present:

1. Strategist
2. Critic
3. Researcher
4. Quant
5. Editor

Rules:

- Create queued run cards for the full round immediately.
- Claim only the first eligible agent at first.
- When an agent commits, unlock the next sequence index immediately.
- Editor closes the round.
- If an agent fails, mark it failed and let the user retry, skip, or continue to
  Editor with an explicit missing-perspective note.

### Parallel Mode

Rules:

- Start all non-editor agents together within workspace concurrency caps.
- Editor waits until all required agents complete, fail, or are skipped.
- Editor synthesizes the independent perspectives.

### Cancellation

`POST /talks/:id/cancel-runs`:

- marks queued runs `cancelled`
- marks running runs `cancel_requested`
- emits WebSocket state immediately
- aborts provider streams through AbortController
- commits final `cancelled` status when the provider/tool loop stops

The user should never wonder whether cancel worked.

### Run Events

Persist and stream these event types:

- `run.status`
- `run.delta`
- `run.progress`
- `run.tool-call`
- `message.commit`
- `doc.pending-edit`
- `talk.state`
- `run.error`

Use monotonically increasing event ids so WebSocket reconnect can replay missed
events.

## 9. LLM Provider Layer

Implement a provider interface matching `docs/04-api-contracts.md`:

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

Adapters:

- Anthropic: Claude Opus 4.5 and Claude Sonnet 4.5.
- OpenAI: GPT-5 Pro and GPT-5 Mini.
- Google: Gemini 2.5 Pro.

Engineering rules:

- Provider adapters own provider-specific request/response mapping only.
- Agent orchestration never imports a provider SDK directly.
- Tool-call normalization happens outside adapters.
- Every attempt logs model, provider, TTFT, duration, tokens, cost, and error
  class.
- Agent prompts are assembled deterministically and snapshotted per run.

## 10. Agent System

The complete v1 agent architecture is specified in
[`06-agent-system-design.md`](./06-agent-system-design.md). Keep the rebuild
plan thin and defer agent-design details to that doc.

Implementation summary:

- Seed the five default agents and three default teams into every workspace.
- Use `shared/data.jsx` for display defaults, accents, and team composition
  seed data.
- Use `docs/03-agents.md` for canonical default prompts and methodologies; port
  those strings verbatim into the runtime seed package.
- Use the practical v1 agent shape: role, name, model, persona, focus, method,
  capabilities, and enabled state.
- Keep expanded characteristics such as evidence policy, context policy, tool
  policy, discussion policy, output contracts, examples, and eval metrics out of
  the editable agent schema. Implement them through hidden global runtime
  policy, role templates, prompt assembly, tool/context services, and evals.
- Snapshot agents per Talk and assembled prompts per run.
- Do not build raw prompt editing, custom agents, or a community agent
  marketplace in v1.

## 11. Tools, Connectors, And Context

Keep these separate in database, API, UI, and prompt assembly.

Tools:

- Talk-scoped capability flags.
- Workspace-level defaults and configuration.
- Tool execution checks both Talk flag and connector/credential availability.

Connectors:

- Workspace OAuth authorization.
- Per-Talk bindings with target and scope.
- Never infer connector access from a visible UI toggle alone.

Context:

- Talk-scoped source list.
- Context compiler reads the primary document, supporting documents, URLs, files,
  past Talks, and house rules.
- Prompt manifest labels each source and treats all source text as untrusted
  content, never as system authority.

Privacy rule:

- News monitor sends only topic summaries or keywords to outside services, not
  raw message content.

## 12. Information Architecture

Canonical IA lives in `docs/08-information-architecture.md`.

The build should follow that doc rather than re-deriving hierarchy from scattered
screen specs. The short version:

```text
Workspace
  Folder*              optional, flat Talk organization
  Unfiled              virtual null-folder Talk view
  Talk*
    Primary document?  zero or one editable document pane
    Context sources*   many read sources, including supporting documents
  Document*
    Tab*               one or more ordered sections inside the document
```

The important document decision:

- A Talk has zero or one primary document.
- A primary document can have one or more tabs.
- A Talk can read many supporting documents through Context.
- A document can be primary for zero or one Talk.
- A document can be supporting context for many Talks.
- The primary link lives on `documents.primary_talk_id`, not `talks.doc_id`.

This keeps the document pane and pending-edit UX simple while avoiding the false
constraint that a Talk can only learn from one document.

## 13. Documents Architecture

The spec's tabbed block model is the v1 canonical document model:

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
  pendingBy?: AgentId;
}
```

Production storage should add enough metadata to support document tabs,
markdown, and HTML without creating two divergent editors.

Recommended model:

- `documents.format` is `markdown` or `html`.
- `doc_tabs` provide Google-Docs-style sections inside one document.
- Every document starts with one `Main` tab; hide the tab bar until a second tab
  exists.
- `doc_blocks` are canonical for editing and agent pending edits, scoped by tab.
- Markdown import parses into blocks.
- HTML import sanitizes, then parses supported tags into blocks.
- Export regenerates markdown or safe HTML from all tabs in order.
- Unsupported HTML is preserved only as safe metadata when necessary.

Pending edit flow:

1. Agent proposes tab/block operations in a structured form.
2. Server validates operation against current document state.
3. UI shows pending edits at tab and block level.
4. User accepts or rejects per block or in bulk.
5. Accept mutates canonical blocks and records audit event.

Hard line:

- Do not let agents directly overwrite document source.
- Do not store raw unsanitized HTML as renderable content.
- Do not add collaborative editing in v1.

## 14. API Surface

Implement the contracts in `docs/04-api-contracts.md` directly.

Priority order:

1. `GET /me`
2. workspace CRUD and seed
3. folders
4. agents and teams
5. talks list/detail/create/update/archive
6. messages and run creation
7. WebSocket stream
8. documents
9. tools
10. connectors
11. context
12. home recommendations/news
13. API keys, audit, analytics

Use shared Zod schemas for:

- request bodies
- API responses
- WebSocket events
- DB payload JSON fields
- tool-call arguments
- LLM structured outputs

Every endpoint must require workspace scope. The API contract uses
`X-Workspace-Id`; the implementation should enforce that header and reject
entity ids outside the workspace.

## 15. Frontend Build

### App Routes

- `/signin`
- `/home`
- `/talks/[id]`
- `/agents`
- `/agents/[id]`
- `/documents`
- `/documents/[id]`
- `/settings/profile`
- `/settings/api-keys`
- `/settings/agents`
- `/settings/tools`
- `/settings/connectors`
- `/archive`

Do not implement thread routes.

### State Model

- TanStack Query for snapshots and mutations.
- WebSocket reducer for live run events and token deltas.
- Local reducer for command palette, modal, popover, drawer, and composer
  state.
- Optimistic UI for message send, archive, folder moves, tool toggles, and doc
  accept/reject.

### Surface Priority

1. Shell and sign-in.
2. Talk list and Talk detail.
3. Composer and streaming.
4. Tools, Context, Connectors, Document, More menu.
5. New Talk sheet.
6. Documents table and editor.
7. Agents roster and profile.
8. Settings.
9. Home Inbox systems.
10. Archive.

Home is a large design surface, but the Talk loop must work before Home ranking
is trusted. Build Home UI early with seeded/mock cards, then wire deterministic
recommendation, News, Inbox, and optimization systems behind it.

## 16. Home, Sidebar, Inbox, Recommendations, And News

The complete Home architecture is specified in
[`07-homepage-system-design.md`](./07-homepage-system-design.md). Keep this
rebuild plan thin and defer Home-system details to that doc.

Implementation summary:

- Home is the user's attention router, not a generic dashboard or marketing
  page.
- Build deterministic systems first: activity events, Inbox items,
  recommendation candidates, News topics/matches, ranking, and structured
  actions.
- Keep the Curator as summary/copy polish over real state, not the source of
  truth for recommendations.
- Keep Talk organization separate from Inbox: `talks.folder_id is null` means
  Unfiled. Inbox items are arrivals, blockers, and waiting states that can point
  to Talks, documents, runs, connectors, News, or future jobs.
- Recommendations optimize for useful completed actions with provenance and
  executable structured actions.
- News optimizes for Talk impact and `Add to context`, not general article
  clicks.
- Log impressions and interactions from day one so recommendations, News, and
  Inbox ordering can improve.
- Allow bounded automatic tuning of ranking weights/preferences. Structural
  algorithm changes should become admin-reviewed optimization proposals.
- Keep model use optional and constrained to copy rewrite, clustering, impact
  explanation, and proposal generation behind the same structured interfaces.

## 17. Build Phases

This sequence is based on `docs/05-build-plan.md`, with a more aggressive
latency-first backend path.

### Phase 0: Project Setup

- Initialize monorepo.
- Set up TypeScript, lint, format, tests, CI.
- Create `apps/web`, `apps/api`, `apps/worker`.
- Add Tailwind config and Salon tokens.
- Add Postgres and Redis locally through Docker Compose.
- Add env templates for Anthropic, OpenAI, and Google keys.
- Add seed script and DB reset command.

Exit criteria:

- One command starts web, API, worker, Postgres, and Redis locally.
- The Salon tokens render in a bare shell.

### Phase 1: Schema And Seeds

- Create the baseline migration.
- Add seed data for user, workspace, folders, talks, docs, agents, teams, tools,
  connectors, and context.
- Seed canonical agents and teams from `shared/data.jsx`.
- Add full system prompts from `docs/03-agents.md`.
- Add schema and seed tests.

Exit criteria:

- Fresh DB reset produces a complete demo workspace matching the prototype.
- Tests prove five agents and three teams exist for every new workspace.

### Phase 2: Auth And Workspace Shell

- Magic link, Google OAuth, GitHub OAuth.
- `GET /me`.
- Workspace creation and switching.
- Left rail, profile/workspace popover, sign-in screen.

Exit criteria:

- Sign in lands on `/home`.
- Workspace switcher looks and behaves like the prototype.

### Phase 3: Talk API, Snapshot, And WebSocket

- Implement folders and talks APIs.
- Implement Talk snapshot endpoint.
- Implement WebSocket subscribe/unsubscribe/ping.
- Implement event replay cursor.
- Build Talk list, secondary sidebar, and static Talk detail.

Exit criteria:

- Open a Talk and see the same structural surfaces as the prototype.
- WebSocket reconnect replays missed events in tests.

### Phase 4: Interactive Run Engine

- Implement message send endpoint.
- Insert queued run cards immediately.
- Implement worker claim loop.
- Implement Ordered and Parallel orchestration.
- Implement provider adapter interface with one fake streaming provider.
- Implement cancellation.
- Build composer and live timeline reducer.

Exit criteria:

- Sending a message shows the user message and queued agent cards immediately.
- Fake provider streams through WebSocket.
- Cancel intent appears immediately and stops the fake provider.

### Phase 5: Real Providers And Agent Prompts

- Add Anthropic, OpenAI, and Google adapters.
- Add prompt assembly per agent role.
- Add model selection.
- Add TTFT and usage logging.
- Add provider chaos tests for disconnects, slow first token, tool errors, and
  cancellation.

Exit criteria:

- Pricing crew can run a complete Ordered round with real providers.
- First-token benchmark is tracked by provider/model.

### Phase 6: Tools, Context, And Connectors

- Implement Tools popover and workspace Tools settings.
- Implement Context popover and context compiler.
- Implement Connector model and basic OAuth stubs.
- Add web search/fetch and Drive-read scaffolding behind tool flags.
- Ensure Researcher cites sources when tools are enabled and labels prior
  knowledge when they are disabled.

Exit criteria:

- Tool toggles affect the run manifest.
- Context sources show up in prompt manifests.
- Connector permissions are checked at execution time.

### Phase 7: Documents

- Implement document CRUD.
- Implement document tabs with one default `Main` tab per document.
- Implement block editor.
- Implement md/html import/export.
- Implement pending agent edits.
- Implement in-Talk doc pane and full-page document editor.

Exit criteria:

- The Pricing doc can be opened in pane and full-page views.
- Agent pending edits can be accepted and rejected.
- HTML documents are sanitized and rendered safely.

### Phase 8: Agents And Teams

- Implement Agents page.
- Implement Agent profile page.
- Implement the v1 agent fields from `docs/06-agent-system-design.md`: name,
  model, persona, focus, method, capabilities, and enabled state.
- Implement hidden global runtime policy, role templates, deterministic prompt
  assembly, and per-run prompt snapshots.
- Implement persona/model/focus/method editing and reset.
- Implement model profile metadata and "why this default model" copy.
- Implement Team composition CRUD.
- Implement "save current Talk as team".
- Add team preview copy: best for, missing perspective, default tools, latency
  and cost estimate.
- Add recent contributions and per-agent feedback capture.

Exit criteria:

- Default agents match the canonical definitions.
- Persona changes tone, focus changes domain emphasis, method changes visible
  role behavior, and hidden policies remain controlled by runtime templates.
- Prompt snapshots prove old runs are reproducible after agent edits.
- Editing persona/focus/method/model affects future runs without rewriting old
  run snapshots.

### Phase 9: Settings, API Keys, Archive

- Implement settings left rail.
- Implement Profile, API keys, AI agents, Tools, and Connectors panels.
- Implement API key create/reveal/copy/revoke.
- Implement archive view and restore.
- Implement archive-with-primary-document dialog.
- Finish Cmd+K action registry.

Exit criteria:

- The archive flow matches the prototype safe defaults.
- Cmd+K can jump to Talks and settings sub-pages.

### Phase 10: Home Inbox Systems And News

- Build Home UI from `HomeFocus`.
- Implement `home-summary`: curator headline, stats, and activity event inputs.
- Implement sidebar search, Unfiled, and Inbox rules from
  `docs/07-homepage-system-design.md`.
- Implement `GET /home/inbox`, deterministic Inbox item generation, grouping,
  ranking, actions, and interaction events.
- Implement deterministic recommendation candidate generators and scoring.
- Implement hero and `Then maybe` ranking, dismiss, refresh, and action
  execution.
- Implement News monitor topic extraction, search provider interface, source
  allowlist, ranking, dedupe, refresh cadence, and feedback events.
- Implement `Snooze`, `Add to context`, and `Open` news actions.
- Add provenance for every recommendation and news match.
- Add Home interaction events and bounded ranking-profile updates.
- Implement admin-reviewed Home optimization proposals for structural algorithm
  changes.
- Implement Curator copy rewrite/clustering behind a feature flag only after
  deterministic recommendations are working.

Exit criteria:

- Home shows curator headline, stats, quick composer, hero recommendation,
  three follow-ups, and news cards.
- Sidebar search, folders, Unfiled, and Inbox work from real workspace state:
  Unfiled is folderless Talks; Inbox is item-based arrivals/waits.
- Recommendation cards are rule-generated, ranked, actionable, dismissible, and
  traceable to Talk/doc/message provenance.
- News initially renders six ranked cards, supports paginated loading toward a
  30-card qualified pool, never sends raw Talk content externally, and can add an
  item to Talk context.
- Home logs impressions/interactions and can tune bounded preferences without
  changing structural algorithms.
- If Curator polish is not ready, the UI degrades to deterministic cards.

### Phase 11: Polish And Launch Hardening

- Accessibility pass.
- Responsive pass at desktop and mobile breakpoints.
- No overlapping controls or clipped button text.
- Audit events for every mutation.
- Latency dashboards.
- Error states for provider failures and connector failures.
- Export MD/HTML/PDF if PDF is still in launch scope.

Exit criteria:

- The full `docs/05-build-plan.md` definition of done passes.
- No JS errors in the main flows.
- End-to-end Talk streaming latency meets the launch threshold.

## 18. Testing And Verification

Backend:

- schema constraints
- workspace scoping
- seed correctness
- run claim idempotency
- ordered sequencing
- parallel fanout
- editor-after-agents rule
- cancellation before claim
- cancellation after provider start
- provider retry/failure classification
- context compiler trust boundaries
- tool permission checks
- agent prompt assembly snapshots
- method and role-template output enforcement in fake provider tests
- role behavior coverage tests from `docs/06-agent-system-design.md`
- model profile and context manifest snapshot tests
- model profile selection and run snapshotting
- team ordering and missing-perspective metadata
- document import sanitization
- doc edit accept/reject
- primary-document cardinality
- Talk archive with doc unlink/delete behavior
- sidebar search ranking
- Inbox item generation, grouping, ranking, actions, and lifecycle
- recommendation candidate generation and scoring
- recommendation action authorization
- news topic extraction privacy guard
- news dedupe/ranking/source caps
- news feedback scoring effects
- Home ranking profile bounded updates
- Home optimization proposal generation
- audit events

Frontend:

- sign-in route
- left rail navigation
- Talk send flow
- queued/running/completed/failed/cancelled UI states
- Tools/Context/Connectors popovers
- Cmd+K actions
- New Talk sheet
- archive with primary document
- link and unlink primary document from Talk
- Documents table sorting
- full-page doc editor
- Agents profile edits
- Persona, Focus, Model, Method, reset controls, and recent contributions
  panels
- Team composition cards and Start a Talk actions
- Settings API key flows
- Sidebar search, Unfiled, and Inbox badges
- Home summary stat cards
- recommendation hero ranking/action/dismiss
- Then Maybe dedupe and ordering
- News snooze/add-to-context/open actions
- Home recommendation actions

Performance:

- benchmark API 202 time
- benchmark worker claim time
- benchmark provider-start time
- benchmark first delta time
- benchmark WebSocket reconnect replay
- fail CI or release gate if interactive runs touch the background queue path

Browser QA:

- use the prototype as a screenshot reference for major surfaces
- verify production screens at 1280px, 1440px, and mobile widths
- specifically check composer, Talk header, popovers, doc pane, and table rows
  for clipping or overlap

## 19. Review Gates

### Product Review

Questions:

- Is the scoped v1 correct with no Threads and no multiple primary documents per
  Talk?
- Should Home ship with only deterministic copy, or should model copy polish be
  enabled behind a feature flag?
- Is Ordered mode the default for all new Talks?
- Is the initial workspace seed enough for a new user to understand the product?
- Is the simplified v1 agent editor right: name, model, persona, focus, method,
  and enabled state?
- Are raw prompt editing and custom agents correctly excluded from v1?
- Are the v1 recommendation kinds and actions from
  `docs/07-homepage-system-design.md` the right first set?
- Should v1 expose Inbox in the left rail, Home only, or both?
- Are the news source allowlist and refresh cadence acceptable for launch?
- Are bounded automatic Home ranking updates acceptable, or should all tuning be
  admin-reviewed at first?

### Engineering Review

Questions:

- Is the monorepo split right?
- Should API and worker be one deployable service or two?
- Is Redis Streams plus WebSocket enough for replay and coordination?
- Are run events sufficiently durable for debugging and reconnect?
- Does the schema enforce single-primary-document-per-Talk cleanly?
- Is `documents.primary_talk_id` the right source of truth for the primary
  Talk-document link?
- Are prompt snapshots and prompt versions enough to debug agent behavior over
  time?
- Are recommendation/news/activity modules decoupled enough to iterate without
  rewriting Home?

### Design Review

Questions:

- Does the production shell match Salon closely enough?
- Are Tools, Context, and Connectors visually distinct but not noisy?
- Does the Agents profile make Persona vs Focus vs Method vs Model clear?
- Does the team composition UI explain what perspective is missing?
- Does Home feel like a product surface rather than marketing?
- Are the hero, Then Maybe, and News sections visually distinct and scannable?
- Does sidebar folder/Unfiled organization stay clear at 20+ Talks, and does
  Inbox feel separate from Talk organization?
- Does the document editor feel first-class?
- Is the primary-document lifecycle understandable from both Talk and Documents?

### Security Review

Questions:

- Are workspace boundaries enforced in every endpoint?
- Are OAuth tokens and provider API keys encrypted and never sent to the client?
- Are tool permissions checked at execution time?
- Is HTML import sanitized before render?
- Is Researcher source text treated as untrusted content?

### Performance Review

Questions:

- What is current p50/p95 from send to first delta?
- Are provider delays distinguishable from app queue delays?
- Can a Talk show queued cards immediately even under load?
- Does cancellation stop visible streaming within two seconds?

## 20. Risks

| Risk | Mitigation |
|---|---|
| Real providers cannot consistently hit 600 ms TTFT. | Track app latency and provider latency separately. Optimize app path first; expose honest run progress when provider is slow. |
| Multi-agent orchestration becomes hard to reason about. | Keep a simple persisted state machine. Store sequence index and event log. Test Ordered and Parallel heavily. |
| Agents collapse into five generic chatbots. | Keep strong hidden role templates, concise editable method/focus fields, prompt snapshots, and role-specific evals from `docs/06-agent-system-design.md`. |
| Persona edits accidentally change agent behavior. | Treat persona as tone only. Put behavior in role templates, method, focus, and hidden runtime policy with reset controls. |
| Model swaps degrade a role. | Store model profiles and model rationale, snapshot model per run, and expose reset-to-default. |
| Curator output is low quality. | Treat Curator as optional copy polish. Build deterministic cards first and put model-generated copy/clustering behind a flag. |
| Recommendations feel arbitrary. | Require provenance, deterministic scoring, visible why-lines, and structured actions. Track dismiss/completion feedback from day one. |
| News feed becomes generic noise. | Optimize News for Talk impact and Add-to-context, only scan News-monitor-enabled Talks, cap visible cards per Talk/source, and learn from snooze/add-to-context/open events. |
| Inbox becomes a second product. | Keep Inbox as a compact item queue of arrivals, blockers, and waits. Keep Talk organization in folders/Unfiled and broad suggestions in Recommendations. |
| Home auto-optimization overfits to sparse behavior. | Use bounded ranking-profile updates, preserve diversity floors, and require admin review for structural algorithm changes. |
| Researcher creates latency drag. | Run source search only when tool is enabled, show progress, cache source fetches, and make source count visible. |
| Documents grow past the tabbed block model. | Keep v1 block kinds narrow. Add richer nodes later only after markdown/html round-trip tests pass. |
| Users misunderstand whether a doc belongs to a Talk or to Documents. | Treat docs as workspace artifacts with optional primary Talk links and many supporting context uses. Make primary/unlinked/supporting state explicit in headers, tables, archive dialogs, and context popovers. |
| Connector OAuth scope gets messy. | Separate connector authorization from Talk binding and from tool permission checks. |
| Prototype drift. | Keep a visual QA checklist tied to `ClawTalk Salon.html` until production replaces it. |

## 21. Open Decisions For Review

1. API framework:
   - Recommendation: Fastify for the API and `ws` for WebSocket.
   - Alternative: Hono for lighter route handlers.

2. API and worker deploy shape:
   - Recommendation: separate processes from the start, same repo and shared
     packages.
   - Reason: long-running LLM streams and cancellation are easier to isolate.

3. Auth:
   - Recommendation: Auth.js if it does not fight the API split; otherwise a
     small first-party session layer.

4. Editor implementation:
   - Recommendation: start with a controlled block editor, not full ProseMirror,
     because the spec's v1 block model is intentionally small.
   - Revisit if HTML fidelity becomes more important than block-level pending
     edits.

5. Home launch:
   - Recommendation: ship deterministic recommendations, News matching, Inbox
     item generation, and interaction logging first; enable model copy polish
     only after quality review.

6. Raw prompt editing:
   - Recommendation: keep raw prompt editing out of v1. A read-only debug view
     can be admin/dev-only if needed.
   - Reason: persona/focus/method/model controls cover normal customization
     while preserving prompt safety and debuggability.

7. Custom role templates:
   - Recommendation: keep v1 defaults fixed to the five canonical roles.
     Support cloning/custom templates after the core debate loop is working.
   - Reason: the product needs strong default discussions before it needs a
     marketplace or free-form agent builder.

8. Duplicate Talk document behavior:
   - Recommendation: duplicate Talk messages and settings only; leave doc
     unlinked by default.
   - Reason: silent doc copying creates stale artifacts. Add an explicit "also
     duplicate document" control later if needed.

9. `ClawTalk Redesign.html`:
   - The zip currently includes `ClawTalk Salon.html`, not
     `ClawTalk Redesign.html`.
   - If the redesign canvas is added later, treat it as reference only unless
     it conflicts with Salon, then ask for a decision.

## 22. Immediate Next Steps

1. Review this plan against the canonical docs.
2. Decide API framework and deploy shape.
3. Create the monorepo skeleton.
4. Implement Salon tokens and static shell.
5. Build schema and seed tests before any real LLM integration.
6. Build fake-provider streaming before real-provider streaming.
7. Benchmark the send-to-first-delta path from the first working prototype.

The rebuild should optimize for one sharp loop:

Create a Talk, pick a team, send a question, watch named agents respond quickly,
and leave with a usable document.
