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

Minimum IA tables:

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
kind
text
attrs_json
pending
pending_by_agent_id nullable
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

Deleting the last remaining tab must fail. Deleting a tab with pending edits must
either fail or require explicit confirmation that pending edits will be rejected.

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
