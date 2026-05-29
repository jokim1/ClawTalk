> **Status:** canonical (product behavior). Uses greenfield `documents`/`agents` names — read via [GLOSSARY](./GLOSSARY.md) (DECISIONS D2). Connectors are workspace-global per [roadmap](./roadmap.md) #5; scheduled-jobs scope per DECISIONS D2 — both override this doc.
> Precedence + orientation: [README.md](./README.md) · decisions: [DECISIONS.md](./DECISIONS.md) · terms: [GLOSSARY.md](./GLOSSARY.md).

# ClawTalk · Product Spec

**Read me first.** This is the canonical specification of ClawTalk — the product you're building. Every concept, data structure, screen, and flow lives here. The working visual prototype (`ClawTalk Salon.html` at the repo root) is the canonical reference for *what it looks like and how it feels*. This doc tells you *what it does*.

---

## §0 · One-page overview

**ClawTalk** is a multi-agent reasoning product. Users open a **Talk** — a context-bound room — and invite a curated team of LLM agents (Strategist, Critic, Researcher, Editor, Quant) to debate a question. The agents speak in turns ("Rounds"), push back on each other, surface holes, and synthesize toward a recommendation. The output of a Talk is usually a decision *plus* a document that captures it.

### Core concepts

| Concept | What it is |
|---|---|
| **Workspace** | Top-level container. Permissions root. Users belong to 1+ workspaces. |
| **Folder** | Optional, flat grouping inside a workspace. A Talk lives in 0 or 1 folder. |
| **Talk** | A multi-agent conversation about a specific question. Has rounds, a team of agents, mode (Ordered / Parallel), tools, context sources, and optional primary document. |
| **Round** | One turn of debate. Each agent in the Talk responds (Ordered) or responds in parallel (Parallel). Editor closes the round with a synthesis. |
| **Agent** | A fixed-role LLM reasoning role — Strategist, Critic, Researcher, Editor, or Quant. Each has a role template, model, persona, focus, and method. See `06-agent-system-design.md`. |
| **Team composition** | A saved roster of agents reusable across Talks. |
| **Document** | A markdown or HTML artifact with one or more tabs. It may be the primary editable document for one Talk, and may also be supporting read-only context for many Talks. |
| **Tools** | Per-Talk capabilities the agents can invoke (web search, Drive read, Gmail send, news monitor, etc.). |
| **Connectors** | Per-Talk external service bindings (Slack #channel, Drive folder, Linear project). |
| **Context** | The set of sources the room currently knows from (primary document, supporting documents, attached URLs, uploaded files, past Talks, house rules). |
| **Unfiled** | Virtual Talk list for Talks that have no folder. Not Inbox. |
| **Inbox** | Home queue of arrivals, blockers, and waiting items generated from Talk/doc/run/connector state. A Talk can be the target of an Inbox item, but is not itself an Inbox item. |
| **Archive** | Soft-delete for Talks (and optionally their docs). Recoverable. |
| **Curator** | The Home summary/copy layer over deterministic workspace state. It can polish recommendations, but it is not the source of truth for Home ranking. |

Canonical information architecture lives in `08-information-architecture.md`.
When object ownership, folder behavior, document links, or Context semantics are
ambiguous, that doc wins.

### Headline product moves (vs typical chat UIs)

1. **Multiple agents in one room, attributed by role + color + name.** The Talk thread shows who said what; agents reply to each other.
2. **Run state is first-class.** Streaming, queued, awaiting, done, failed, cancelled — visible on every agent message.
3. **Curator-driven home page.** Instead of an empty "New chat" button, Home shows a single "Do this next" recommendation, then follow-ups, then a news feed contextual to the user's Talks.
4. **Docs are first-class artifacts.** Co-edited by agents, accept/reject pending edits, browseable separately from Talks.
5. **Fixed-role agents with simple editable controls.** Users can tune model, persona, focus, and method without editing raw system prompts. Five battle-tested roles cover ~95% of needs.

---

## §1 · Data model changes

### 1.1 Workspaces (NEW)

A user can belong to 1+ workspaces. Workspace is the root of permissions, billing, audit, member list, default folders, provider keys.

```ts
type Workspace = {
  id: string;
  name: string;             // 'Oxbow & Co.'
  initials: string;         // 'OC'
  ownerId: string;
  region: string;           // 'us-east'
  plan: 'team' | 'enterprise';
  createdAt: Date;
}
type WorkspaceMember = {
  workspaceId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member';
}
```

**Migration.** Every existing user gets a default workspace named `<First name>'s workspace`. All existing Talks attach to it. Workspace-switcher UI required (see §4.6).

### 1.2 Folders (NEW)

Optional grouping. Flat. No nesting in v1.

```ts
type Folder = {
  id: string;
  workspaceId: string;
  title: string;
  order: number;            // user-draggable
  createdAt: Date;
}
```

**Constraint.** A Talk lives in **0 or 1** folder. No multi-folder, no tags. Talks not in a folder appear in Unfiled.

### 1.3 Talks (CHANGED)

- **Drop the Threads concept entirely.** Rounds handle iteration inside a single Talk.
- Add `folderId: string | null`.
- Add `archivedAt: Date | null` (replaces delete).
- Add `team: AgentId[]` and `teamId: string | null` (snapshot + optional reference to a saved Team composition).
- Add `tools: Record<ToolId, boolean>` (per-Talk overrides; inherits workspace defaults).
- Keep `mode: 'Ordered' | 'Parallel'`, `rounds: number`, `running: boolean`, `unread: number`.

```ts
type Talk = {
  id: string;
  workspaceId: string;
  folderId: string | null;       // null → Unfiled
  title: string;
  mode: 'Ordered' | 'Parallel';
  rounds: number;
  team: AgentId[];
  teamId?: string;
  tools: Record<ToolId, boolean>;
  running: boolean;
  unread: number;
  archivedAt: Date | null;
  createdAt: Date;
  lastActivityAt: Date;
}
```

### 1.4 Threads (REMOVE)

- Every Thread becomes a Talk in migration. If a current Talk had N threads, materialize N new Talks all sharing the original Talk's intent in their title (`<Talk title> — <thread name>`), all in the same folder.
- Doc previously attached to a Thread becomes the new Talk's primary document.
- **Edge case:** if multiple threads shared a parent doc (does this happen in current code? — confirm with eng), pick the most-recent thread to own the doc; others become *unlinked* in the new Documents page.

### 1.5 Docs (CHANGED)

- `primaryTalkId: string | null` (was non-null `talkId`).
- Add `folder: string | null` (denormalized from the primary Talk while linked; falls through to its own folder if unlinked).
- Add `format: 'markdown' | 'html'`.
- Add `lastEditAt: Date`, `wordCount: number` (computed; can be derived rather than stored).
- Add tabs. Every document has at least one tab; blocks live inside tabs.
- Supporting document use inside Talks is modeled through Context, not through
  this primary link.

```ts
type Doc = {
  id: string;
  workspaceId: string;
  primaryTalkId: string | null;
  folder: string | null;
  title: string;
  format: 'markdown' | 'html';
  tabs: DocTab[];
  coEditorIds: AgentId[];
  lastEditAt: Date;
}
type DocTab = {
  id: string;
  documentId: string;
  title: string;
  order: number;
  blocks: Block[];
}
```

### 1.6 Agents (CHANGED — substantial)

Each agent is a small workspace record backed by a hidden role template and
global runtime policy. Roles are fixed for the five defaults; users can edit
name, model, persona, focus, method, and enabled state. The full architecture is
in `06-agent-system-design.md`.

```ts
type Agent = {
  id: string;
  workspaceId: string;
  roleKey: 'strategist' | 'critic' | 'researcher' | 'editor' | 'quant';
  name: string;            // user-editable display name
  handle: string;          // @strat
  initials: string;
  accent: string;
  model: string;           // current model
  defaultModel: string;    // for "reset to default"
  job: string;             // read-only role description
  persona: string;         // editable tone/voice
  focus: string;           // editable domain or topic emphasis
  method: string[];        // editable visible reasoning moves
  capabilities: string[];  // gated by Talk tools/connectors at runtime
  isCustom: boolean;       // false for the 5 ship-with-app defaults
  enabled: boolean;
}
```

**5 default agents to seed for every workspace on signup:**
- Strategist · Claude Opus
- Critic · GPT-5 Pro
- Researcher · Gemini 2.5 Pro
- Editor · Claude Sonnet
- Quant · GPT-5 Pro

Full default system prompts and methodologies are in `03-agents.md`; display
defaults, accents, and teams are in `shared/data.jsx`'s `CT_AGENTS` array. Port
canonical prompt and method text verbatim.

### 1.7 Team compositions (NEW)

Saved rosters for common Talk shapes.

```ts
type TeamComposition = {
  id: string;
  workspaceId: string;
  name: string;            // 'Pricing crew'
  description: string;
  agentIds: AgentId[];
  isDefault: boolean;      // ship-with-app teams
  runs: number;            // analytics
}
```

Seed with 3 defaults on workspace creation: Pricing crew, Research crew, Hiring crew.

### 1.8 Tools, Connectors, Context (3 distinct concepts — see §3)

```ts
type ToolToggle = Record<ToolId, boolean>;  // Talk-scoped + workspace default
type Connector = {                          // workspace-scoped OAuth wiring
  id: string;
  service: 'slack' | 'gdrive' | 'gmail' | 'linear' | 'github' | 'notion' | 'telegram';
  target?: string;                          // '#pricing', '/pricing-v2/', etc.
  scope: string[];                          // ['read','write']
  bindings: { talkId: string; enabled: boolean }[];  // per-Talk bindings
}
type ContextSource = {                      // Talk-scoped
  id: string;
  talkId: string;
  kind: 'primary_document' | 'document' | 'url' | 'file' | 'past_talk' | 'rule' | 'news';
  name: string;
  meta: string;
}
```

---

## §2 · Routing & navigation

### 2.1 New routes

| Route | Purpose |
|---|---|
| `/signin` | unchanged |
| `/home` | curator dashboard (replaces old home) |
| `/talks/:id` | Talk detail (no thread sub-path) |
| `/talks/:id/doc` | Talk + doc pane open (state-level, not separate route) |
| `/agents` | Agent roster + team compositions |
| `/agents/:id` | Single agent profile |
| `/documents` | Sortable doc table |
| `/documents/:id` | Full-bleed doc editor |
| `/settings/profile` | Account |
| `/settings/api-keys` | (NEW) |
| `/settings/agents` | Workspace-level agent management |
| `/settings/tools` | (NEW) Tools catalog |
| `/settings/connectors` | OAuth bindings |
| `/archive` | (NEW) Archived Talks |

### 2.2 Routes to delete

- `/talks/:id/threads/:threadId` and everything under it.

### 2.3 Left icon rail (5 destinations + profile)

Top to bottom:
1. **Home** — curator dashboard
2. **Talks** — sidebar list (was already there)
3. **Agents** — sparkle icon (NEW page behind it)
4. **Documents** — doc icon (was a stub)
5. **⌘K palette trigger** (visual button)
6. **Profile avatar** (replaces cog; opens profile menu)

### 2.4 Keyboard shortcuts

| Combo | Action |
|---|---|
| ⌘K | Open command palette |
| ⌘N | New Talk sheet |
| ⌘+Enter | Send composer |
| ⌘. | Cancel runs |
| ⌘J | Toggle doc pane (in Talk) |
| g h / g t / g , | Goto home / talks / settings |
| Esc | Close palette / dialog |

---

## §3 · Three abstractions to never confuse

| Concept | Answers | Surface |
|---|---|---|
| **Tools** | What can agents *do*? | Per-Talk popover from header + workspace catalog in Settings → Tools |
| **Connectors** | Which external services is this Talk *wired into*? | Per-Talk popover + workspace OAuth bindings in Settings → Connectors |
| **Context** | What does the room *know right now*? | Per-Talk popover with sources (primary document, supporting documents, URLs, files, past Talks, house rules) |

All three are first-class header buttons in the Talk header — see §4.4.

---

## §4 · UI surfaces — every screen

### 4.1 Sign-in (small refresh)

- Two-pane editorial layout (already in prototype). Magic link, Google, GitHub. No change in flow vs current.

### 4.2 Home — **curator dashboard** (NEW shape)

The biggest UI change. Single wide column at 1240px max. Stack:

1. **Greeting** — "Welcome back, <name>"
2. **Curator card + 4-card stat strip side-by-side**
   - Curator card: one-sentence headline from the curator agent describing the state of the salon
   - Stats: Talks · Prompts (today / this month) · Tokens (today / this month) · Words (today / this month)
3. **Quick composer** — "Start a new room…" with template chips (Pricing review, Teardown, Weekly review, Hiring loop)
4. **"Do this next" — hero NBA card.** Single highest-priority curator-picked action with: priority badge, why-line, agent strip, primary action button, live transcript preview pane on the right when the linked Talk is streaming
5. **"Then maybe" — 3 follow-up recommendation cards**, full width each. Same shape as hero but smaller. Each carries priority badge (Decide / Improve / Tidy), why-line, talk pill, action button
6. **News for your Talks** — Perplexity-Discover-style wide cards. Headline + excerpt + source row (favicon + name + age) + colored thumbnail block on the right + "Matched: <Talk>" provenance line + Snooze / Add to context / Open actions

**Variants behind a tweak** (development only — settle on one before launch):
- `focus` — the stack above. Default.
- `split` — two-column: recs left, Activity/News tabs right.
- `feed` — narrow single column.

**Recommendations engine.** Deterministic generators read workspace state and surface actionable cards. Each cites the Talk + turn it came from (provenance is non-negotiable). Cards are dismissible and refresh on demand. The Curator can polish copy or cluster cards behind the same structured contracts. Full architecture: `07-homepage-system-design.md`.

**News feed.** Pulls live news keyed to privacy-safe topic profiles from Talks that have the **News monitor** tool enabled. Sends only topic abstracts, keywords, entities, and domains; never raw message or document content. Items decay after 3 days by default. Add-to-context is the primary action.

### 4.3 Talks sidebar (CHANGED)

Two-pane: 56px icon rail + 260px secondary list.

**Top of secondary list:**
- "Talks" header + "X active · Y streaming" subtext
- "+" button → split menu: New Talk / New folder / Import

**List body:**
- Folders (expandable, with talk count, drag-to-reorder, hover-reveal delete affordance)
- Unfiled (below folders, italic + muted gray header with count, hides entirely when empty)
- Inbox is a Home/shell queue of arrivals and waiting items, not part of the Talk folder tree
- Search input → ⌘K palette

**Profile card removed** from sidebar; the profile avatar lives in the icon rail at bottom.

### 4.4 Talk detail (CHANGED — header gets richer)

**Header right-side buttons (in order):**

1. Cancel runs (only when running)
2. **Agents · N**
3. **Tools · N** (popover with toggle switches per tool, grouped by Web / Google / Comms / Work)
4. **Context · N** (NEW popover — sources of truth for the Talk: primary document, supporting documents, URLs, files, past Talks, house rules)
5. **Connectors · N** (NEW popover — OAuth service bindings: Slack channel, Drive folder, Gmail label, Linear project, GitHub repo)
6. **Document** (toggle the doc pane)
7. **⋯ More menu** — Run history · Move to folder ▸ · Rename · Duplicate · Export ▸ · Archive

**Body:** unchanged — multi-agent thread with rounds, run-state pills, agent attribution, live streaming with cursor.

### 4.5 Composer

- Address-to row with agent chips (per-Talk team) + Add agent
- Mode (Ordered / Parallel) + rounds chips
- Textarea, ⌘+Enter to send
- Footer: attach / mic / prompt library / **tool glyphs** showing what's enabled

### 4.6 Workspace switcher (REPLACES profile menu)

Asana-style two-column popover anchored to the rail's profile avatar.

- **Left column:** workspace list with avatar + name + unread dot. Current is checked. Scroll.
- **Right column:** active workspace context — user identity card, "Set out of office", links to Admin console (if owner), New workspace, Invite to workspace, Settings, Profile, Add another account, Sign out at bottom.

### 4.7 Documents (NEW page)

Dense sortable table at 1320px max width.

**Top:** workspace label + page title + 4-card stat strip (Documents · Words · Pending edits · Last activity) + filter input + "+ New document".

**Table columns** (all sortable except Primary Talk):

| Title | Fmt | Tabs | Folder | Primary Talk | Last activity | Words | ⋯ |
|---|---|---|---|---|---|---|

- Click a row → open `/documents/:id` (full-bleed editor at 720px column).
- Click the **Primary Talk** pill (stop propagation) → jump into that Talk.
- Pending-edits badge in the title cell when any blocks are awaiting review.

**Full-bleed doc editor:** unlinked or primary-linked indicator in the top bar, document tabs when more than one exists, co-editor avatars in meta strip, pending-edits banner with Accept all / Reject all.

### 4.8 Agents (NEW page)

3 sections, stacked at 1240px max width:

1. **Your team** — 3-column grid of agent cards (5 default + "Add agent" slot). Each card: avatar, name, role badge, default-model chip, job in italic, usage stats. Click → profile.
2. **Team compositions** — 3-column grid of saved teams. Each card: name, description, agent chips, runs count, Start a Talk / Edit.
3. **Discover** — placeholder for a future community marketplace.

**Agent profile page:**
- Hero: avatar, name, role badge, job, model, usage stats
- Persona (editable textarea + Reset)
- Focus (editable textarea + Reset)
- Model picker (5+ models with `default` badge)
- Method (numbered steps view + Reset)
- Raw prompt is not editable in v1; admin/dev read-only debug view only if needed
- Recent contributions across all Talks
- Disable agent for workspace at the bottom

### 4.9 Settings (RESTRUCTURED)

**Removes the top-tab strip.** Adds a 240px left rail with 5 sub-pages:

- **Profile** — display name, handle, photo, defaults
- **API keys** (NEW) — labelled tokens, reveal/copy/revoke, scope chips, "+ New key" CTA
- **AI agents** — workspace-level agent management (mostly mirrors what's on the Agents page)
- **Tools** (NEW) — workspace catalog grouped by Web / Google Workspace / Communication / Work tools. Each tool shows Connect/Configure + description
- **Connectors** — OAuth integrations (Slack, GDrive, Linear, etc.) and their bindings

Reachable from the workspace-switcher popover (no longer from a cog icon).

### 4.10 New Talk sheet (NEW)

Modal sheet, appears from ⌘N, Home "+ New Talk", or sidebar "+ → New Talk":

- Title *(optional, auto-derived from first sentence)*
- Folder *(optional, defaults to "— No folder (lands in Unfiled)")*
- Team picker (default workspace team + saved compositions + "All five agents")
- Team-preview agent chips
- Prompt *(optional — open empty room and decide inside if blank)*
- Mode (Ordered / Parallel) + Rounds (1 / 2 / 3 / 5)
- "Lands in <X>" footer summary
- Cancel / Open Talk (⌘+Enter)

### 4.11 Dialogs

**Folder delete (NEW)** — three-button confirm:
- Keep Talks (move to Unfiled) — safest, primary
- Delete folder + all Talks — destructive, gated
- Cancel

**Archive Talk with primary document (NEW)** — three-button confirm:
- Archive Talk only — keep doc (unlinked) — safest, primary
- Archive Talk AND doc together
- Cancel

If no primary document: single confirm "Archive Talk".

### 4.12 Command palette ⌘K (refresh)

- Actions: Open/close doc pane, Cancel runs, Go to Home, Settings sub-page deep links (Profile / API keys / AI agents / Tools / Connectors), Reset demo
- Jump-to: every Talk by title
- Switch model for next round
- ↑↓ navigate · ↵ select · esc close

---

## §5 · System defaults shipped with the app

Every new workspace seeds with:

- **5 default agents** (Strategist, Critic, Researcher, Editor, Quant) — full prompts and methodologies in `03-agents.md`; display seed data in `shared/data.jsx`
- **3 default team compositions** (Pricing crew, Research crew, Hiring crew)
- **9 default tools** with sensible enable-by-default flags (Web search ON, Drive read ON, News monitor ON; others OFF)
- **Empty folder list** — user creates folders or leaves Talks in Unfiled

---

## §6 · Migration sequencing

Suggested rollout order for the eng team:

1. **Data model migration** (§1) — workspaces, folders, kill threads, doc linking
2. **Workspace switcher + profile menu** (§4.6) — touches every page
3. **Sidebar restructure** (§4.3) — folders, Unfiled, Inbox queue affordance, "+" menu, profile in rail
4. **New Talk sheet** (§4.10) — both the create flow and ⌘N hotkey
5. **Talk header buttons** (§4.4) — Context, Connectors as popovers
6. **⋯ menu + dialogs** (§4.11) — folder delete, archive flow
7. **Agents page + profile** (§4.8) — including seed agents from §5
8. **Documents page + editor** (§4.7)
9. **Settings restructure** (§4.9) — kill tab strip, add API keys + Tools panels
10. **Home dashboard** (§4.2) — curator + stats + recs + news. Highest design risk; ship behind a feature flag.
11. **Archive view** + ⌘K palette polish

Stages 1–6 are infrastructure / IA cleanup with low UI risk. 7–10 are net-new surfaces. 11 is polish.

---

## §7 · Open questions (need product decisions)

- **Multi-workspace billing.** Is it per-workspace or per-user? Affects API key scoping (§1.8) and connector OAuth state.
- **News monitor privacy.** Confirm the topic-summary-only contract is acceptable for enterprise users; otherwise add a workspace-level kill switch.
- **Drag-and-drop Talk filing.** Spec says drag from sidebar → folder header. Confirm desired sensitivity / drop targets — could be deferred to v1.1 if scope tight.
- **Method editor affordance.** Method is editable in v1; decide whether the UI needs an advanced warning or simple reset copy.
- **Archive retention.** How long do archived Talks live before becoming hard-delete eligible? (Default proposed: indefinite.)

---

## §8 · Out of scope for v1 (explicit no-go)

- Threads as a first-class concept
- Multi-folder per Talk (no tags either)
- Nested folders
- Branches / sub-conversations inside a Talk
- Multiple primary documents per Talk
- Community marketplace
- Async / scheduled agent jobs
- Real-time multiplayer co-editing of docs (single-user editor in v1)
