# ClawTalk · Build Plan

Recommended sequence for building ClawTalk greenfield. Infrastructure → data → core flows → polish.

The numbering is *suggested*. You can parallelize where capacity allows — front-end work on Talk thread UX doesn't block back-end work on streaming, for example.

---

## Phase 0 · Project setup (week 0)

- [ ] Initialize repo, CI, linter, formatter.
- [ ] Pick stack (recommended in `README.md` of this folder).
- [ ] Set up environment scaffolding: dev / staging / production.
- [ ] Provision: Postgres (or chosen DB), Redis (for run queues + websocket pub/sub), object storage (file uploads).
- [ ] Set up LLM provider accounts: Anthropic, OpenAI, Google. Store keys server-side; never ship to client.
- [ ] Pull tokens from `02-visual-system.md` into your design system (CSS variables + Tailwind config).

---

## Phase 1 · Data model (week 1)

Build the schema before any screens.

- [ ] Tables: `workspaces`, `workspace_members`, `users`, `folders`, `talks`, `messages`, `runs`, `tool_calls`, `documents`, `doc_tabs`, `doc_blocks`, `agents`, `team_compositions`, `connectors`, `context_sources`, `audit_events`.
- [ ] Schemas match the types in `01-product-spec.md` §1.
- [ ] Indexes on: `talks.workspace_id`, `talks.folder_id`, `messages.talk_id + created_at`, `documents.primary_talk_id`, `doc_tabs.document_id + sort_order`, `doc_blocks.tab_id + sort_order`, `context_sources.talk_id + kind`, `audit_events.workspace_id + created_at`.
- [ ] Seed function: on workspace create, insert 5 default agents + 3 default team compositions from `03-agents.md` and `shared/data.jsx`.
- [ ] Migrations are versioned.

---

## Phase 2 · Auth & workspaces (week 2)

- [ ] Implement magic-link, Google OAuth, GitHub OAuth flows from `04-api-contracts.md` §1.
- [ ] Workspace creation, switching, member invites.
- [ ] Session management. Workspace-scoped cookies.
- [ ] `GET /me` returns user + workspaces.
- [ ] Frontend: sign-in screen (reference: `SignInScreen` in `prototype/screens.jsx`).
- [ ] Frontend: workspace switcher popover from the profile avatar (reference: `ProfileMenu` in `prototype/shell.jsx`).

---

## Phase 3 · Skeleton shell (week 2–3)

The chrome that every screen lives in.

- [ ] Left icon rail with: Home, Talks, Agents, Documents, ⌘K, Profile avatar.
- [ ] Top bar pattern: left meta + right actions.
- [ ] Sidebar secondary list (Talks tree): folder sections + Unfiled + search. Inbox is a separate Home/shell queue, not part of the Talk tree.
- [ ] ⌘K command palette skeleton (actions registry can be filled in as features land).
- [ ] Global hotkeys: ⌘K, ⌘N, ⌘+Enter, ⌘., ⌘J, g+h / g+t / g+,.
- [ ] Density modes (`cozy` default, `compact` optional).
- [ ] Density / accent applied via CSS vars — no JS prop-drilling for theming.

---

## Phase 4 · Talks · the conversational core (week 3–5)

The heart of the product. Don't skimp.

- [ ] **Data layer:** Talk CRUD endpoints (`/talks`) per `04-api-contracts.md` §4.
- [ ] **LLM provider adapters:** Anthropic, OpenAI, Google. Streaming-aware. Tool use.
- [ ] **Run orchestrator:** Ordered + Parallel mode. Queue + execute agents in sequence (Ordered) or fan-out (Parallel). State machine: `queued → running → completed/failed/cancelled`.
- [ ] **WebSocket streaming:** `04-api-contracts.md` §9. Token deltas, status transitions, tool calls, message commits, talk-state patches.
- [ ] **Frontend talk thread UI:** rounds, agent attribution, run-state pills, live streaming with cursor, queued state, cancelled state. Reference: `TalkScreen` + `AgentMessage` + `UserMessage` in `prototype/screens.jsx` + `prototype/shell.jsx`.
- [ ] **Composer:** address-to chips, mode/rounds chips, ⌘+Enter send, ⌘. cancel.
- [ ] **Talk header buttons:** Cancel runs / Agents / Tools / Context / Connectors / Document / ⋯. Each popover from `01-product-spec.md` §3 and `prototype/talk-dialogs.jsx`.
- [ ] **⋯ menu:** Run history, Move to folder, Rename, Duplicate, Export, Archive.

This phase is the largest. Allocate accordingly.

---

## Phase 5 · Sidebar, folders, Unfiled, New Talk (week 5)

- [ ] Sidebar "+" split menu (New Talk / New folder / Import).
- [ ] Folder CRUD: create (inline rename), delete (three-button confirm dialog).
- [ ] Talk filing: drag-to-folder OR right-click → Move to.
- [ ] Unfiled: visually muted, hides when empty, count badge.
- [ ] New Talk sheet (modal): title (auto-derived) / folder (optional) / team (saved compositions) / prompt (optional) / mode / rounds. ⌘N + ⌘+Enter. Reference: `NewTalkSheet`.
- [ ] Folder deletion dialog with three-button choice.

---

## Phase 6 · Documents (week 6)

- [ ] Doc CRUD + tab/block-level pending edit accept/reject (§8 of API).
- [ ] Primary-document semantics: 0 or 1 primary Talk per doc, many supporting context uses.
- [ ] Documents page: sortable table with columns Title · Fmt · Tabs · Folder · Primary Talk · Last activity · Words. Reference: `DocumentsScreen`.
- [ ] Full-bleed doc editor: 720px column, serif typography, co-editor avatars in meta strip, pending-edits banner. Reference: `DocEditorScreen`.
- [ ] In-Talk doc pane (side-by-side with thread). Reference: `DocPane`.
- [ ] "New document" creation flow (linked or unlinked).

---

## Phase 7 · Agents (week 6–7)

- [ ] Agent endpoints for the v1 editable fields: name, model, persona, focus, method, enabled.
- [ ] Agents page: 5-card roster + add slot + team compositions + Discover placeholder. Reference: `AgentsScreen`.
- [ ] Agent profile: persona / focus / model / method / reset controls / recent contributions. Reference: `AgentProfileScreen`, adjusted by `06-agent-system-design.md`.
- [ ] Hidden global runtime policy, role templates, deterministic prompt assembly, Talk agent snapshots, and run prompt snapshots.
- [ ] Team composition CRUD + "Save current Talk as team" gesture.
- [ ] Reset-to-default everywhere.

---

## Phase 8 · Tools, Connectors, Context (week 7–8)

These intersect with Talks (popovers) and Settings (workspace catalogs).

- [ ] **Tools:** workspace catalog page, per-Talk popover with toggle switches, tool-call invocation by agents during runs.
- [ ] **Connectors:** OAuth flows for Slack, GDrive, Gmail, Linear, GitHub, Notion. Per-Talk binding with target picker.
- [ ] **Context:** per-Talk source list. Add-URL, upload-file, link-past-Talk, house-rule entry.
- [ ] **News monitor tool:** topic-summary submission to news matcher (privacy contract — never send messages).

---

## Phase 9 · Settings (week 8)

- [ ] Settings shell with left-rail sub-nav (no top tabs).
- [ ] Profile · API keys · AI agents · Tools · Connectors panels. Reference: `SettingsScreen` + the panel components.
- [ ] API key generation, reveal, copy, revoke flow.

---

## Phase 10 · Home — the curator dashboard (week 9–10)

Highest design risk. Ship behind a feature flag.

- [ ] **Home Inbox:** activity events, Inbox items, shell/Home badges, and item lifecycle. Unfiled Talks remain separate organization. See `07-homepage-system-design.md`.
- [ ] **Recommendations engine:** deterministic candidate generation, ranking, structured actions, dismissal/completion lifecycle, and provenance.
- [ ] **News feed:** privacy-safe topic profiles, async third-party news search, Talk-impact ranking, Add-to-context, Snooze, and Not relevant.
- [ ] **Optimization loop:** impression/action events, bounded ranking-profile updates, lightweight user feedback, and admin-reviewed algorithm proposals.
- [ ] **Curator polish:** optional model copy rewrite/clustering behind a feature flag after deterministic cards work.
- [ ] **Home page UI:** Curator headline + stat strip + composer + hero NBA card + 3 follow-up rec cards + news section. Reference: `HomeFocus`.
- [ ] **Home layout:** commit to `focus` for production; do not ship the Tweaks panel.

---

## Phase 11 · Archive, polish, ⌘K palette (week 10–11)

- [ ] Archive view: list of archived Talks with restore action.
- [ ] Archive flow with primary-document three-button confirm.
- [ ] ⌘K palette: full action registry, jump-to-Talk by title, settings deep links, reset-demo (dev-only).
- [ ] Run history view per Talk.
- [ ] Export to MD / HTML / PDF.
- [ ] Audit log surface (Settings → Admin console for owners).
- [ ] Onboarding flow for first-time users (out of scope unless time permits).

---

## Risk register

| Risk | Mitigation |
|---|---|
| **LLM streaming reliability across 3 providers.** | Build the provider adapter abstraction in week 3 before UI work. Test with chaos: dropped connections, partial responses, tool-use errors. |
| **Run orchestrator complexity.** | Use a proven queue (BullMQ / Sidekiq / similar) rather than rolling your own. State machine in code, not in DB triggers. |
| **Curator quality.** | Phase 10 is behind a flag for model polish only. Deterministic recommendations must work without Curator output. |
| **News feed privacy.** | Bake the topic-summary-only contract into the matcher service. Never log message bodies in that pipeline. Document for security review. |
| **Home auto-optimization.** | Tune only bounded ranking weights automatically. Structural algorithm changes require admin-reviewed proposals. |
| **Multi-workspace performance.** | Index aggressively. Don't N+1 across workspaces. The `/me` endpoint should be one query. |
| **Doc co-editing conflicts.** | V1 is single-user editing. If two agents propose edits to the same block, last-writer-wins with the older becoming "rejected" automatically; surface this to the user. Real CRDT comes in v1.1+. |

---

## Definition of done (for v1 launch)

- [ ] A new user can sign up, land in a fresh workspace with 5 default agents seeded.
- [ ] Open a New Talk, pick a team, send a prompt, watch agents stream live with attribution.
- [ ] Each agent's run-state pill transitions visibly through queued → running → completed.
- [ ] Cancel runs mid-stream with ⌘. — runs stop within 2 seconds.
- [ ] Editor closes a round with a synthesis and proposes pending doc edits.
- [ ] Accept the pending edits — they apply.
- [ ] Move the Talk to a folder. Delete the folder (folder-only). Talk lands in Unfiled.
- [ ] Inbox item generation, counts, actions, and lifecycle match the Home spec.
- [ ] Archive the Talk with a primary document — prompt offers Talk-only vs both.
- [ ] Open ⌘K, jump between Talks, switch active model for next round.
- [ ] Open the Documents page. Sort. Click a row. Edit. Save.
- [ ] Open the Agents page. Edit persona/focus/method. Reset to default. Swap a model.
- [ ] Open Settings → API keys. Generate a key. Reveal. Copy. Revoke.
- [ ] Open Home. Curator headline + 4 stats + 1 hero rec + 3 follow-ups + 6 news cards. Click a recommendation's action button — it does the thing.
- [ ] All of the above with no JS errors, no broken layouts at 1280px viewport, and end-to-end latency on the streaming response under 600ms TTFT.
