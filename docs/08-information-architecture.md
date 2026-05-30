> **Status:** canonical — **authoritative for hierarchy + data model.** Uses `documents`/`doc_tabs` names; live DB is `contents` and tabs are unbuilt — see DECISIONS D2 + [GLOSSARY](./GLOSSARY.md).
> Precedence + orientation: [README.md](./README.md) · decisions: [DECISIONS.md](./DECISIONS.md) · terms: [GLOSSARY.md](./GLOSSARY.md).

# ClawTalk Information Architecture

This doc is the canonical information architecture for ClawTalk v1. It defines
the hierarchy, ownership model, document relationship, sidebar organization,
and the schema/API rules that keep those concepts consistent.

Read this alongside:

- `01-product-spec.md` for product behavior.
- `04-api-contracts.md` for endpoint shapes.
- `07-homepage-system-design.md` for Home, Inbox, News, and recommendations.

## 1. Decision Summary

ClawTalk v1 uses this hierarchy:

```text
Workspace
  Folder*                  optional, flat Talk organization
    Talk*
  Unfiled                  virtual view: Talks with no folder
    Talk*

Talk
  Primary document?        zero or one editable document pane
  Context sources*         many read sources: docs, URLs, files, past Talks, rules, news

Document
  Workspace-owned artifact
  Primary document for zero or one Talk
  Supporting context for zero or many Talks
  Tab*                     one or more ordered document tabs/sections
```

The important product decision is:

- A Talk has zero or one **primary document**.
- A primary document may have one or more **document tabs**.
- A Talk may have many **supporting documents** through Context.
- Multiple primary documents in one Talk are out of scope for v1.

This is not the same as saying "a Talk can only use one document." The Talk has
one editable output document pane, that document can contain tabs, and agents can
read many other documents as context.

Terminology note: older prototype copy and a few adjacent docs may say "linked
doc." In v1 implementation language, read that as "primary document" unless the
specific section is talking about Context.

## 2. Why This Model

### 2.1 Why keep one primary document per Talk

One primary document is the right v1 model because it makes the core loop clear:

1. The user starts or opens a Talk.
2. Agents debate in the thread.
3. The Editor or other agents propose edits to one visible artifact.
4. The user accepts/rejects those edits in one document pane.
5. The final outcome is easy to find from either the Talk or Documents page.

Multiple editable documents per Talk create complexity before there is evidence
that v1 needs it:

- The Document header button would need a chooser instead of a direct pane.
- Agents would need to pick an edit target on every proposed edit.
- Pending-edit UX would need per-document grouping and conflict handling.
- Archive/duplicate/restore flows become harder to explain.
- Home recommendations would need to ask "which document?" for every doc action.
- Context compilation becomes more expensive and less predictable.

For v1, the primary document should be a focused output artifact, not a folder.
Tabs are the safe escape hatch for multi-part outputs because they keep one
document pane and one primary link while allowing structure inside the artifact.

### 2.2 Why allow many supporting documents

Only allowing one total document would be too restrictive. Real Talks often need
supporting material:

- a pricing memo plus a competitor teardown
- a hiring rubric plus candidate notes
- a product brief plus customer feedback
- a local AI hardware spreadsheet plus API pricing notes

Those should be added through Context as read-only document sources. Agents can
read and cite them, but pending edits target only the primary document unless the
user promotes a supporting document to primary.

### 2.3 Practical rule

Use this mental model:

```text
Primary document = what this Talk is producing or actively editing.
Document tabs = sections inside that primary artifact.
Supporting documents = what this Talk can read.
```

## 3. Object Definitions

### 3.1 Workspace

Workspace is the tenant, permissions, billing, and data root.

A Workspace owns:

- folders
- Talks
- documents
- agents
- team compositions
- tools and connector settings
- context sources
- Home ranking state
- audit events

Every user-visible object that contains private user data must include
`workspace_id`.

### 3.2 Folder

Folder is optional, flat organization for Talks.

Rules:

- A folder belongs to exactly one Workspace.
- Folders do not nest in v1.
- A Talk belongs to zero or one Folder.
- A Folder contains zero or many Talks.
- A Folder is not the same as Context.
- A Folder is not a permission boundary in v1.

Folder deletion:

- Safe default: delete the folder row and move Talks to Unfiled.
- Destructive option: delete folder and archive/delete contained Talks, gated by
  explicit confirmation.

### 3.3 Unfiled Talks

Unfiled is not a database row.

Unfiled is the virtual view:

```sql
talks.folder_id is null
and talks.archived_at is null
```

Unfiled means "Talks with no folder." It does not mean Inbox, unread, or needs
attention. Inbox is a Home system for arrivals, blockers, and waiting items; see
`07-homepage-system-design.md`.

### 3.4 Talk

Talk is the main work surface.

A Talk:

- belongs to exactly one Workspace
- belongs to zero or one Folder
- has zero or one primary document
- has zero or many context sources
- has one team roster snapshot
- has user and agent messages grouped into rounds
- has tool toggles and connector bindings
- can be archived

The Talk owns conversation state. It does not own documents as child rows.
Documents are workspace artifacts linked into Talks.

Ownership obligations:

- Every Talk has a creator (`talks.created_by`, §5.3), enforced by `NOT NULL +
  ON DELETE RESTRICT` on `users` (§11 §3). A user cannot be hard-deleted while
  they own Talks; the product's "leave workspace" + "transfer ownership" flows
  reassign or anonymize ownership first.
- Every Talk has a `sort_order` (§5.3) for drag-ordering within its folder or
  Unfiled bucket — see §7.1 for reorder semantics.
- `talks.last_activity_at` is maintained by the app at the end of every message
  INSERT or run terminal transition (the executor + `/chat` handler call
  `UPDATE talks SET last_activity_at = now() WHERE id = ?` in the same
  transaction). NOT a trigger — the trigger overhead would fire on every
  snapshot/edit row too. The column is `NOT NULL DEFAULT now()` at create time
  (§11 §3) so the first read is correct even before the first message.

### 3.5 Document

Document is a first-class workspace artifact.

A Document:

- belongs to exactly one Workspace
- has format `markdown` or `html`
- has one or more tabs
- has blocks as the canonical editable representation inside tabs
- may be the primary document for zero or one Talk
- may be supporting context for zero or many Talks
- can be opened from the Documents page even when unlinked

Document is not a message attachment. Attachments and uploaded files become
context sources; a user can later turn selected material into a document.

### 3.6 Document Tab

Document Tab is an ordered section inside one document.

A Tab:

- belongs to exactly one Document
- has a title
- has ordered blocks
- can be selected in the document pane
- can be targeted by agent pending edits
- is not independently linked to a Talk
- is not independently filed into a Folder

Tabs should feel similar to document tabs in Google Docs: a way to organize one
artifact into named sections, not a replacement for documents or folders.

Default behavior:

- Every new document is created with one tab named `Main`.
- The UI may hide the tab bar while a document has exactly one tab.
- Users can add tabs when a document needs multiple outputs or appendices.
- The last remaining tab cannot be deleted.

Common tab examples:

- Decision
- Evidence
- Draft
- Appendix
- Meeting notes
- Open questions

### 3.7 Primary Document

Primary document is the single document pane attached to a Talk.

When a Talk has a primary document:

- the Talk header shows the Document button as active
- the Talk can open a side-by-side document pane
- the primary document appears pinned at the top of the Context popover
- the context compiler includes the primary document by default
- agents may propose pending edits against its tabs and blocks
- the Documents table shows a linked Talk pill
- the document's displayed folder follows the Talk's folder while linked

The primary document is still stored in `documents`; it is not copied into the
Talk or into messages.

### 3.8 Supporting Document Context

Supporting document context is a workspace document attached to a Talk as a read
source.

When a document is attached as supporting context:

- it appears in the Context popover under Supporting documents
- agents can read its included tabs, blocks, or summary
- agents can cite it in their messages
- agents cannot propose edits to it through this Talk
- it does not become the Talk's Document pane
- it may also be the primary document of another Talk

If the user wants agents to edit a supporting document, the UI must ask whether
to promote it to the Talk's primary document. Promotion fails if the Talk already
has a different primary document unless the user explicitly replaces it.

### 3.9 Context Source

Context Source is anything the room knows from.

Supported v1 kinds:

- `primary_document` - materialized system entry for the primary document
- `document` - supporting workspace document, read-only
- `url` - fetched/extracted page
- `file` - uploaded file or extracted text
- `past_talk` - another Talk summary or selected messages
- `rule` - house rule or user instruction
- `news` - News item added to context

Implementation note: the primary document may be returned in Context responses
for display, but the primary link itself is stored on `documents.primary_talk_id`,
not as the source of truth in `context_sources`.

### 3.10 Message

Message is one unit in a Talk's transcript.

A Message:

- belongs to exactly one Talk and one Workspace
- has an `author_kind` of `user` or `agent` (`messages.author_kind`, §11 §3)
- has a `round int` — the round number it belongs to inside the Talk; rounds
  are derived, not a separate table (§11 §3 design notes)
- when `author_kind = 'user'`: carries `author_user_id` (the sending user) and
  has no agent attribution or run back-edge
- when `author_kind = 'agent'`: carries `agent_snapshot_id` (the immutable
  per-run roster snapshot of the speaking agent, §11 §4) and `run_id` (a
  back-edge to the run that produced it)
- has an immutable `body` plus optional `attachments_json`

Composite FKs (§11 §3) tie every message to its parent Talk on
`(workspace_id, talk_id)` and to its run on `(workspace_id, talk_id, run_id)`,
so a row cannot reference a Talk or run in a different workspace or Talk. Agent
attribution points at `talk_agent_snapshots`, not the live `agents` row, so
later edits to the agent don't rewrite history (§11 §4 design notes).

### 3.11 Run

Run is one agent's response to a turn — the unit the orchestrator dispatches
and the queue/Durable Object stream against.

A Run:

- belongs to exactly one Talk and one Workspace
- has a `round int` matching the round the run participates in
- has `run_kind` ∈ `{conversation, content_improvement}` (§11 §3 / §11 §9)
- carries `snapshot_group_id` (the frozen roster group taken for this run)
  and `agent_snapshot_id` (the one acting agent — must be a snapshot inside
  that group; the composite FK in §11 §3 enforces this)
- has `status` ∈ `{queued, running, awaiting, completed, failed, cancelled}`
  (§11 §3); the Talk-level "running" flag is derived from any run being in
  `queued | running | awaiting`
- has `trigger` ∈ `{user, scheduler, manual}` (§11 §3) — `user` runs carry
  `trigger_message_id` (the user message that fired them); `scheduler` and
  `manual` runs carry `job_id` and a `prompt_snapshot_id` instead (no
  `messages` row exists for the trigger; see [12-jobs.md](./12-jobs.md))
- ordered/parallel sequencing rides `response_group_id` + `sequence_index`
  (§11 §3)

Composite FKs (§11 §3) keep every run inside its Talk and workspace. A
partial unique index on `runs(job_id)` for nonterminal statuses enforces
single-flight per job (§11 §3 + §11 §8). The full design notes (job-trigger
invariants, slot identity for scheduler runs, stuck sweep) live in §11 §3.

### 3.12 Forge artifacts (post-MVP)

Forge (autonomous content improvement; `01-product-spec.md` §5c) introduces a
small ownership cluster that follows the same §3.1 workspace-owned rule:

- `improvement_runs` — one row per Forge run; ties to one `documents` row +
  optional `tab_id` + optional `target_block_id` for scope; carries
  `run_kind='content_improvement'`.
- `document_versions` — one row per scored candidate; child of
  `improvement_runs`; carries per-persona Likert + held-out scoring.
- `forge_audiences` — saved Audiences composed in-app; reusable across runs.
- `forge_personas` / `forge_reference_sets` / `forge_questions` — cached
  read-only assets synced from SSR/Synthetical; one row per workspace per
  upstream `ssr_id`.
- `forge_audience_personas` / `improvement_run_held_out_personas` — join tables.
- `ssr_connections` — workspace's SSR/Synthetical OAuth/secret wiring; one
  row per workspace (token in `connector_secrets`, not
  `workspace_provider_secrets`).

Forge runs use the same `runs` machinery (§3.11) — the `run_kind` discriminator
distinguishes `conversation` runs (chat) from `content_improvement` runs
(Forge). The winner of a Forge run lands as a pending `document_edits` row
with `source='forge'` against the targeted `tab_id` / `target_block_id`; the
user accepts/rejects through the normal pending-edit pane (§6.3).

Cross-refs: §11 §9 (schema), `09-improver-spec.md` (PRD),
`10-improver-design.md` (design handoff), §04 §17 (API).

## 4. Canonical Cardinalities

```text
Workspace 1 -> many Folders
Workspace 1 -> many Talks
Workspace 1 -> many Documents

Folder 1 -> many Talks
Talk 0..1 -> 1 Folder

Talk 1 -> many Messages
Talk 1 -> many Rounds
Talk 1 -> many ContextSources
Talk 1 -> zero or one PrimaryDocument

Document 0..1 -> one PrimaryTalk
Document many -> many Talks as supporting context through ContextSources
Document 1 -> many DocTabs
DocTab 1 -> many DocBlocks
```

The many-to-many relationship between Talks and supporting documents exists only
through `context_sources`.

## 5. Canonical Schema Rules

### 5.1 Tables

Hierarchy-core IA tables (§5.2–§5.9 give the column shapes):

```text
workspaces
folders
talks
documents
doc_tabs
doc_blocks
context_sources
messages
runs
```

`messages` and `runs` are listed here because §11 §3 carries heavy invariants
(round attribution, run-status derivation, snapshot freezes) that the IA layer
depends on. Column definitions for both follow at §5.8 (`messages`) and §5.9
(`runs`). For the full schema (composite FKs, CHECKs, indexes) see §11 §3.

**Other workspace-owned tables.** §08 is authoritative for hierarchy + ownership
rules, but §11 has the full ~40-table footprint. The rest of the workspace tables
are categorized below with a 1-line purpose + cross-ref to §11 — a reader
scanning §08 sees the full footprint, not just the hierarchy core. §08 does not
replicate §11's column-level DDL.

Agents stack (§11 §4):

- `agents` — workspace agent roster (5 default + custom).
- `agent_role_templates` — hidden role templates (`strategist`, `critic`, …, `forge_rewriter`, `forge_critic`); seeds `agents` defaults.
- `team_compositions` — saved rosters reusable across Talks (§01 §1.7).
- `team_composition_agents` — join.
- `talk_agents` — live per-Talk roster (the editable group).
- `talk_agent_snapshots` — immutable per-run frozen roster; messages and runs attribute through this.
- `run_prompt_snapshots` — immutable system-prompt copy attached to each run.
- `agent_feedback_events` — per-message upvote/downvote/correction trail.

Tools + connectors (§11 §6):

- `talk_tools` — per-Talk tool toggles (`talk_id`, `tool_id`, `enabled`); validated against the §01 §5.1 tool catalog.
- `connectors` — workspace-global OAuth wiring (one row per `service` per workspace; §01 §1.8).
- `connector_bindings` — per-Talk selection of workspace-authorized connectors with target/scope/enabled.
- `connector_secrets` — encrypted OAuth token store (JIT-decrypt at use).

Home stack (§11 §7, §07 PRD):

- `home_inbox_items` — arrivals/blockers/waits queue (typed; dedup via `ref_id`).
- `home_recommendations` — surfaced ranked recommendations.
- `home_recommendation_candidates` — pre-ranking candidate pool with provenance.
- `home_recommendation_events` — impression/click/dismiss trail.
- `home_news_topics` — privacy-safe topic profiles per Talk (News monitor tool).
- `home_news_items` — shared global news pool (no `workspace_id`).
- `home_news_matches` — per-workspace topic↔item matches with `why_it_matters`.
- `home_ranking_profiles` — structured ranking weights + exploration rate per workspace.
- `home_algorithm_versions`, `home_algorithm_assignments` — ranking algorithm rollout state.
- `home_interaction_events` — surface-level click/event log (drives optimizer).
- `home_optimization_proposals` — admin-approved ranking-update proposals.
- `home_activation_state` — first-run / FTUE flags per workspace.
- `activity_events` — append-only workspace activity log.

Jobs (§11 §8, §12 PRD):

- `jobs` — scheduled single-agent prompts that fire normal runs (§01 §5b).

Forge (§11 §9, §09 PRD, §3.12 below for IA):

- `ssr_connections` — per-workspace SSR/Synthetical token wiring.
- `forge_audiences` — saved Audiences composed in-app.
- `forge_audience_personas` — Audience↔persona join.
- `forge_personas`, `forge_reference_sets`, `forge_questions` — cached read-only assets synced from SSR.
- `improvement_runs` — Forge run state (`run_kind='content_improvement'`).
- `improvement_run_held_out_personas` — held-out personas per run for reproducibility.
- `document_versions` — one row per scored candidate rewrite.

Audit + analytics (§11 §10):

- `audit_events` — append-only sensitive-action audit trail (auth/membership/connectors/secrets).

These tables follow the same §3.1 ownership rule: every workspace-owned row
carries `workspace_id` and is gated by RLS through `is_workspace_member` (or
`is_workspace_admin` for the 6 admin-write exceptions in §11 §12.2).

### 5.2 `folders`

Required columns:

```text
id
workspace_id
title
sort_order
created_at
updated_at
```

Constraints:

- `workspace_id` references `workspaces.id`
- unique folder title per workspace is optional; do not enforce unless UX wants it

### 5.3 `talks`

Required IA columns:

```text
id
workspace_id
folder_id nullable
sort_order int not null
created_by uuid not null
title
archived_at nullable
last_activity_at
created_at
updated_at
```

Constraints:

- `workspace_id` references `workspaces.id`
- `folder_id` references `folders.id`
- folder workspace must match Talk workspace
- `folder_id is null` means Unfiled
- `created_by` references `users.id` with `ON DELETE RESTRICT` — see §3.4 ownership rules
- `sort_order` is the drag-orderable position within the Talk's
  `(workspace_id, folder_id)` bucket (where `folder_id is null` is the Unfiled
  bucket). See §7.1 for the reorder rules.

Do not store `doc_id` on `talks` as the source of truth. Return
`primaryDocumentId` from API responses by looking up
`documents.primary_talk_id = talks.id`.

### 5.4 `documents`

Required IA columns:

```text
id
workspace_id
primary_talk_id nullable
folder_id nullable
title
format
last_edit_at
word_count
created_at
updated_at
```

Constraints:

- `workspace_id` references `workspaces.id`
- `primary_talk_id` references `talks.id`
- `folder_id` references `folders.id`
- `format in ('markdown', 'html')`
- partial unique index on `primary_talk_id where primary_talk_id is not null`
- primary Talk workspace must match document workspace
- folder workspace must match document workspace

`primary_talk_id` is intentionally explicit. It is clearer than `talk_id`
because the same document can still be attached to other Talks as supporting
context.

### 5.5 `doc_tabs`

Required IA columns:

```text
id
workspace_id
document_id
title
sort_order
created_at
updated_at
```

Constraints:

- `workspace_id` references `workspaces.id`
- `document_id` references `documents.id`
- document workspace must match tab workspace
- every document must have at least one tab
- `sort_order` is unique per document

### 5.6 `doc_blocks`

Required IA columns:

```text
id
workspace_id
document_id
tab_id
sort_order
version
kind
text
attrs_json
created_at
updated_at
```

Constraints:

- `workspace_id` references `workspaces.id`
- `document_id` references `documents.id`
- `tab_id` references `doc_tabs.id`
- tab document must match block document
- `sort_order` is unique per tab

Blocks belong to tabs. Keeping `document_id` on `doc_blocks` is denormalized but
worth it for validation, indexing, and document-wide operations.

### 5.7 `context_sources`

Required IA columns:

```text
id
workspace_id
talk_id
kind
name
source_document_id nullable
source_talk_id nullable
payload_ref nullable
extracted_text nullable
summary nullable
meta_json
include_in_prompt
sort_order
added_by_user_id nullable
created_at
updated_at
```

Constraints:

- `workspace_id` references `workspaces.id`
- `talk_id` references `talks.id`
- `source_document_id` references `documents.id` when `kind = 'document'`
- `source_talk_id` references `talks.id` when `kind = 'past_talk'`
- all referenced objects must share the same workspace
- `kind` must be one of the v1 supported kinds

Do not create a normal `context_sources` row as the source of truth for the
primary document. The primary document can be projected into the Context API as a
synthetic pinned item.

### 5.8 `messages`

Required IA columns:

```text
id
workspace_id
talk_id
round int not null
author_kind text not null            -- 'user' | 'agent'
author_user_id uuid nullable         -- set when author_kind = 'user'
agent_snapshot_id uuid nullable      -- set when author_kind = 'agent'
run_id uuid nullable                 -- set when author_kind = 'agent' (back-edge)
body text
attachments_json jsonb
created_at
```

Constraints (see §11 §3 for the full CHECK):

- composite FK to `talks(workspace_id, id)` (one talk per workspace)
- composite FK to `runs(workspace_id, talk_id, id)` is deferrable to allow the
  message + run insert within one transaction
- author shape: `user` messages have `author_user_id` set and `agent_snapshot_id
  / run_id` null; `agent` messages have `agent_snapshot_id + run_id` set and
  `author_user_id` null
- `agent_snapshot_id` references `talk_agent_snapshots(workspace_id, talk_id,
  id)` for tenant + Talk integrity (immutable attribution, §11 §4)

### 5.9 `runs`

Required IA columns:

```text
id
workspace_id
talk_id
round int not null
run_kind text not null               -- 'conversation' | 'content_improvement'
snapshot_group_id uuid not null      -- frozen roster group for the run
agent_snapshot_id uuid not null      -- the acting agent (inside snapshot_group_id)
status text not null                 -- 'queued' | 'running' | 'awaiting' | 'completed' | 'failed' | 'cancelled'
trigger text not null                -- 'user' | 'scheduler' | 'manual'
trigger_message_id uuid nullable     -- set when trigger='user'
job_id uuid nullable                 -- set when trigger in ('scheduler','manual'), §11 §8
prompt_snapshot_id uuid nullable     -- set for scheduler/manual runs (immutable prompt copy)
scheduled_for timestamptz nullable   -- slot identity for trigger='scheduler'
response_group_id text not null
sequence_index int not null
model_id text not null
requested_by uuid not null
tokens_in int, tokens_out int
error_json jsonb
started_at, finished_at, created_at
```

Constraints (see §11 §3 for the full set):

- composite FK to `talks(workspace_id, id)` and to
  `talk_agent_snapshots(workspace_id, talk_id, snapshot_group_id, id)` —
  the acting agent must be a snapshot inside this run's frozen roster group
- composite FK to `messages(workspace_id, talk_id, id)` for
  `trigger_message_id` (deferrable, cross-Talk references blocked)
- composite FK to `jobs(workspace_id, id)` for `job_id`, `ON DELETE RESTRICT`
  so job history (`runs` filtered by `job_id`) survives job archive
- single-flight per job: partial unique index on `runs(job_id)` where
  `status in ('queued','running','awaiting')` (§11 §3 + §11 §8)
- slot dedup for scheduler runs: partial unique index on
  `runs(job_id, scheduled_for)` where both are set (§11 §3 + [12-jobs.md](./12-jobs.md))
- job-trigger invariant: `scheduler` and `manual` runs never carry
  `trigger_message_id`; both require `prompt_snapshot_id`; `scheduler`
  additionally requires `scheduled_for` (slot identity)

Rounds derive from `runs` + `messages` sharing `(talk_id, round)`; there is no
`rounds` table (§11 §3 design notes). The Talk-level "running" flag is derived
from any run being in `queued | running | awaiting` (§3.11).

## 6. API Contract Rules

### 6.1 Talk list and detail

Talk list/detail responses should include:

```ts
type TalkSummary = {
  id: string;
  workspaceId: string;
  folderId: string | null;
  title: string;
  primaryDocumentId: string | null;
  archivedAt: string | null;
  lastActivityAt: string;
}
```

`primaryDocumentId` is a materialized convenience field. The database source of
truth is `documents.primary_talk_id`.

### 6.2 Document create/update

Document create accepts:

```ts
{
  title: string;
  format: 'markdown' | 'html';
  primaryTalkId?: string | null;
  folderId?: string | null;
}
```

Rules:

- If `primaryTalkId` is present, link as that Talk's primary document.
- If the target Talk already has a different primary document, return conflict.
- If `primaryTalkId` is null and `folderId` is null, the document is unfiled on
  the Documents page.
- If linked as primary, the document's displayed folder follows the Talk.
- Create one default tab named `Main` unless explicit initial tabs are provided.

Document update can:

- rename the document
- change format only when conversion succeeds
- set or clear `primaryTalkId`
- set `folderId` only while unlinked, or as a materialized display update from
  the primary Talk's folder

### 6.3 Document tab actions

The product should expose these document-tab actions:

- Create tab.
- Rename tab.
- Reorder tab.
- Delete tab when more than one tab exists.
- Move block to another tab.

Deleting the last remaining tab must fail (the `doc_tabs` `before delete`
trigger in §11 §5 enforces this with `errcode = 'CT001'`).

Deleting a tab with pending edits: the DELETE endpoint **rejects the request
with HTTP 409** if any `document_edits` row in `status='pending'` references
the tab, **unless** the caller passes `?cascadePending=true`. When the override
is set, the cascade falls through `document_edits.tab_id ON DELETE CASCADE`
(§11 §5) — pending edits are dropped silently with the tab. The 409 path
surfaces the list of dependent edits so the UI can offer an "accept/reject all
first" affordance. See §04 (G-04.P0.6) for the endpoint contract.

**Move block** payload (resolves G-01.P1.22):

```ts
POST /documents/:documentId/blocks/:blockId/move
{
  targetTabId: string;        // tab to move the block into (must belong to the same document)
  afterBlockId?: string;      // place after this block in the target tab; null/undefined = append at end
}
```

Atomicity:

- both the source tab and the target tab bump their `list_version` on success
  (§11 §5 `doc_tabs.list_version` CAS) so concurrent insert/reorder edits in
  either tab become `superseded` rather than overwriting
- the move is rejected if `targetTabId` does not belong to the block's document
  (the composite FK in §11 §5 keeps blocks tied to a single document)
- pending `document_edits` referencing the moved block remain attached via
  composite FK; the tab change re-points them to `targetTabId` in the same
  transaction

### 6.4 Context create

Supporting document context is added through Talk Context:

```ts
{
  kind: 'document';
  documentId: string;
  includeInPrompt: boolean;
}
```

This does not make the document primary. It only lets agents read it.

### 6.5 Primary document actions

The product should expose explicit actions:

- Create primary document for Talk.
- Link existing document as primary.
- Replace primary document.
- Unlink primary document.
- Attach document as supporting context.
- Promote supporting document to primary.

Do not overload "attach" to mean "make primary." That ambiguity will create user
confusion and bad agent edit behavior.

## 7. UI Rules

### 7.1 Sidebar

Talk sidebar shows:

```text
Folders
  Folder A
    Talk rows
  Folder B
    Talk rows
Unfiled
  unfiled Talk rows
```

Rules:

- Unfiled hides when empty.
- Archived Talks do not appear in normal folder or Unfiled lists.
- Folder counts count active Talks only.
- Dragging a Talk into a Folder sets `talks.folder_id`.
- Dragging a Talk to Unfiled clears `talks.folder_id`.

Talk reordering within a bucket:

- Each Talk carries `sort_order` (§5.3) unique within its
  `(workspace_id, folder_id)` bucket. The Unfiled bucket is
  `folder_id is null`.
- Drag a Talk row within its bucket to renumber `sort_order`. The reorder API
  updates the dragged row's `sort_order` and shifts the affected siblings; the
  sidebar reads `(folder_id, sort_order)` to render.
- **Insert path for a new Talk:** the API sets
  `sort_order = max(sort_order in target bucket) + 1`. The new Talk lands at
  the bottom of its folder (or Unfiled).
- Moving a Talk to a different folder (or Unfiled) sets a fresh
  `sort_order = max(sort_order in target bucket) + 1` in the new bucket.
- Folder reordering uses `folders.sort_order` (§2.2 / §11 §2); it does not
  cascade through Talks.

### 7.2 Talk header

Talk header must keep these concepts separate:

- Agents - who is in the room
- Tools - what agents can do
- Context - what agents know from
- Connectors - external services wired to this Talk
- Document - the primary editable document pane

The Document button is disabled or empty-state when no primary document exists.
It should not list every supporting document; those live in Context.

### 7.3 Context popover

Recommended sections:

```text
Primary document
  <document title>     Open | Unlink

Supporting documents
  <document title>     Open | Remove | Promote

Links
Files
Past Talks
Rules
News
```

If there is no primary document, Context can show "No primary document" with a
Create document action, but the actual pane is still controlled by the Document
button.

### 7.4 Documents page

Documents table columns:

```text
Title | Format | Tabs | Folder | Primary Talk | Last activity | Words | Actions
```

Folder display:

- If the document is primary for a Talk, display that Talk's folder.
- If the document is unlinked, display `documents.folder_id`.
- If neither exists, show Unfiled.

Primary Talk display:

- Linked primary document: show Talk pill.
- Supporting-only document: no primary Talk pill; optional secondary indicator
  can show "Used as context in N Talks" later.
- Unused document: empty.

### 7.5 Document pane and editor tabs

Document pane rules:

- Hide the tab bar when there is one tab unless there are pending edits or the
  user has enabled tab management.
- Show horizontal document tabs when there are two or more tabs.
- Keep tab labels short and truncate rather than wrapping.
- Show pending-edit count per tab when relevant.
- Agent pending edits should open the target tab automatically.

Tabs are document structure, not navigation out of the Talk.

## 8. Agent And Context Compilation Rules

The context compiler builds agent input in this order:

1. Current user message and Talk state.
2. Recent Talk messages and round summaries.
3. Primary document, if present.
4. Supporting context sources, ranked by relevance and token budget.
5. House rules.
6. Tool/connector availability.

Primary document:

- include title, tab list, selected/relevant tabs, headings, relevant blocks, and
  pending edit summary
- allow agents to propose edits against tab ids and block ids
- prefer the active tab for edits unless the agent explicitly creates or targets
  another tab

Supporting documents:

- include title, tab titles, summary, relevant blocks, and provenance
- read-only in this Talk
- no pending edits against supporting document blocks

When token budget is tight, never drop the user's latest message or the active
agent role instructions. Trim supporting context before primary document context.

## 9. Lifecycle Flows

### 9.1 New Talk

Default:

- create Talk with `folder_id = null`
- no primary document
- no context sources unless the user selected starter context

Optional:

- create primary document during Talk creation if the New Talk sheet exposes that
  option
- attach selected workspace documents as supporting context

### 9.2 Create primary document from Talk

When the Talk has no primary document:

1. User clicks Document.
2. Empty state offers Create document.
3. API creates `documents.primary_talk_id = talk.id`.
4. API creates one default `doc_tabs` row named `Main`.
5. Document pane opens.
6. Context popover shows the document as pinned primary source.

### 9.3 Link existing document as primary

Allowed when:

- document is in the same workspace
- document is not primary for another Talk
- target Talk has no primary document, or the user explicitly chooses Replace

If replacing:

- clear old document's `primary_talk_id`
- set new document's `primary_talk_id`
- preserve both documents
- emit audit events for unlink and link

### 9.4 Attach supporting document

Allowed when:

- document is in the same workspace
- document is not already attached to this Talk as supporting context

Creates:

```text
context_sources.kind = 'document'
context_sources.source_document_id = document.id
```

This does not change `documents.primary_talk_id`.

### 9.5 Move Talk to Folder

When a Talk moves:

- update `talks.folder_id`
- if the Talk has a primary document, materialize the document's `folder_id` to
  match for fast Documents-page sorting
- supporting documents do not move

### 9.6 Delete Folder

Safe default:

- delete folder row
- set contained Talks' `folder_id = null`
- primary documents for those Talks materialize `folder_id = null`
- unlinked documents that had the deleted folder also become unfiled

Destructive option:

- archive or delete contained Talks through the Talk archive/delete path
- handle primary documents according to the archive choice

### 9.7 Archive Talk

No primary document:

- set `talks.archived_at`

With primary document:

- safe default: archive Talk only and unlink primary document
- implementation clears `documents.primary_talk_id`
- document remains available on Documents page

Destructive option:

- archive Talk and delete the primary document through the document delete path
- supporting context documents are never deleted by archiving this Talk

Restore:

- restoring a Talk does not automatically relink a previously unlinked primary
  document in v1
- a later recommendation may suggest relinking a likely document

### 9.8 Duplicate Talk

Default:

- duplicate Talk title/settings/team/tools
- duplicate user messages if the duplicate action is explicitly defined that way
- do not copy primary document
- do not attach supporting document context unless user selects "copy context"

Optional later:

- offer "duplicate primary document too"
- create a new document copy and link it to the duplicate Talk

## 10. Search And Home Implications

Search indexes:

- Talk title
- message summaries
- primary document title/content
- primary document tab titles
- supporting document titles/summaries
- folder title

Home recommendations may target:

- a Talk
- a primary document
- a supporting context source
- a folder cleanup action

Recommendation copy must distinguish:

- "Create a document for this Talk" means primary document.
- "Add this document to context" means supporting context.
- "Promote this document" means make it primary.

News "Add to context" creates a `news` context source. It does not create or
modify documents unless the user later turns the News item into a document.

## 11. Out Of Scope For V1

Out of scope:

- multiple primary documents per Talk
- nested folders
- tags or multi-folder Talks
- per-folder permissions
- documents as folders
- nested document tabs
- hidden per-round documents
- automatically treating every file upload as a document
- real-time multi-user document co-editing

Allowed in v1:

- one primary document per Talk
- one or more tabs inside a primary document
- many supporting document context sources per Talk
- one document used as supporting context in many Talks
- one document primary-linked to one Talk and read by other Talks as context

## 12. Tests

Unit tests:

- Talk with `folder_id = null` appears in Unfiled.
- Moving Talk to Folder removes it from Unfiled.
- Folder delete moves Talks to Unfiled by default.
- One Talk cannot have two primary documents.
- One document cannot be primary for two Talks.
- A new document creates exactly one default tab.
- A document cannot delete its last tab.
- Blocks belong to exactly one tab.
- A document can be supporting context for multiple Talks.
- Supporting document context does not change `primary_talk_id`.
- Promoting supporting document fails when Talk already has primary document
  unless replace is explicit.
- Primary document folder follows primary Talk folder.
- Supporting document folder does not follow attached Talk folder.
- Archive Talk safe default clears primary document link.
- Archive Talk does not delete supporting context documents.

Integration tests:

- Create Talk, create primary document, send prompt, agent proposes pending edit.
- Create a second document tab and verify agent pending edit targets that tab.
- Attach supporting document, send prompt, agent can cite it but cannot edit it.
- Replace primary document and verify old document stays available.
- Add News item to context and verify it appears as context, not document.
- Search finds Talk by primary document title and supporting document title.
