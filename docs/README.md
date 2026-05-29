# ClawTalk · Build Package

This `/docs` folder is a complete specification for building **ClawTalk** — a multi-agent reasoning product where users invite different LLMs into a "Talk" (a context-bound room) and watch them debate, push back, and synthesize toward a recommendation.

You're reading this because you're an AI coding agent (or engineer) about to build the product greenfield. Read these docs in order, then start.

---

## Read in this order

| # | Doc | What it gives you |
|---|---|---|
| 1 | **[01-product-spec.md](./01-product-spec.md)** | The product. Every concept, every screen, every flow. The most important doc. |
| 2 | **[02-visual-system.md](./02-visual-system.md)** | Design tokens — color, type, spacing, components. Use exactly these. |
| 3 | **[03-agents.md](./03-agents.md)** | The 5 default agents (Strategist · Critic · Researcher · Editor · Quant) with full system prompts and methodologies. Seed these into every new workspace. |
| 4 | **[06-agent-system-design.md](./06-agent-system-design.md)** | Production agent architecture: hidden runtime policy, role templates, editable fields, snapshots, prompt assembly, and evals. |
| 5 | **[07-homepage-system-design.md](./07-homepage-system-design.md)** | Home architecture: recommendations, News, Inbox items, ranking, feedback, and auto-optimization. |
| 6 | **[08-information-architecture.md](./08-information-architecture.md)** | Canonical workspace/folder/Talk/document hierarchy, primary document model, Context rules, and IA schema constraints. |
| 7 | **[04-api-contracts.md](./04-api-contracts.md)** | Backend API endpoints, websocket protocol for streaming, LLM-provider abstraction, OAuth shapes. |
| 8 | **[05-build-plan.md](./05-build-plan.md)** | Recommended build sequence. Infrastructure first, polish last. |

---

## What also lives in this repo

| Path | What it is |
|---|---|
| `ClawTalk Salon.html` | The **working visual prototype** in React + Tailwind. Open it in a browser to see the entire product running with mocked state. This is the source of truth for visual + interaction design. Now includes the latest base-design updates: document tabs, the multi-workspace account switcher, and the resizable document pane. |
| `ClawTalk Forge.html` | The **Forge** clickable prototype — `ClawTalk Salon.html` with `window.CT_FORGE_ENABLED` set, wiring in the autonomous content-improvement flow. See **[10-forge-design-handoff.md](./10-forge-design-handoff.md)**. |
| `ClawTalk Forge - Exploration.html` | Forge design canvas — written rationale plus the entry-surface and gallery-layout options explored before settling on the shipped design. |
| `prototype/*.jsx` | The prototype's source. Component-by-component. Read these alongside the screens you're building. The `forge-*.jsx` modules hold the Forge surfaces; the Salon modules carry Forge integration gated behind `CT_FORGE_ENABLED`. |
| `design-canvas.jsx` | Source for the Forge exploration canvas (`ClawTalk Forge - Exploration.html`). |
| `shared/data.jsx` | Mock data, brand marks, icons, and the canonical agent / team / role definitions. **Seed your DB from this file.** |
| `ClawTalk Redesign.html` | An earlier design canvas with three alternate visual directions (Salon, Operator, Studio). For reference only — the chosen direction is **Salon**, which is what `ClawTalk Salon.html` implements. |
| `MIGRATION SPEC.md` (root) | Earlier draft of the product spec written as a migration. Superseded by `01-product-spec.md` here; left for archeology. |

---

## How to use this material

1. **Read the prototype first.** Open `ClawTalk Salon.html` in a browser. Click every icon in the left rail, send a message, open the doc pane, hit ⌘K, open the Tools popover, archive a Talk. Get a feel for the product before reading any docs.
2. **Read `01-product-spec.md`** end to end. It tells you *what to build*.
3. **Skim `02-visual-system.md`** — extract the tokens, then refer back as needed.
4. **Read `03-agents.md` carefully.** The 5 default agents and their methodologies are the heart of the product's value. Get them right.
5. **Read `06-agent-system-design.md`** before implementing agent storage, prompt assembly, or the Agents page.
6. **Read `07-homepage-system-design.md`** before implementing Home, Inbox, recommendations, or News.
7. **Read `08-information-architecture.md`** before implementing folders, Talks, Documents, Context, or archive behavior.
8. **Read `04-api-contracts.md`** when you start the backend.
9. **Use `05-build-plan.md`** to sequence the work.

When ambiguity arises, the **prototype** is the canonical reference for UI, the **docs** for behavior, and the **user** for product questions you can't answer from either.

---

## Feature PRDs (forward-looking, not part of the greenfield build order)

| # | Doc | What it gives you |
|---|---|---|
| 9 | **[09-autonomous-content-improvement-prd.md](./09-autonomous-content-improvement-prd.md)** | "Forge" — autonomously iterate a document toward a scored quality bar, using the Synthetical/SSR platform as the scoring oracle. Population-based generate→score→improve loop over the existing Content feature. The *what & why*. Draft, pending review. |
| 10 | **[10-forge-design-handoff.md](./10-forge-design-handoff.md)** | "Forge" design + interaction handoff — the *how it looks & behaves*. Maps the clickable prototype (`ClawTalk Forge.html`) and its surfaces back to the PRD, with a suggested build order. Front-end mock; all scoring data simulated. |

---

## Tech stack — recommended but not prescribed

The prototype is React + Tailwind + Babel-in-the-browser. For production:

- **Frontend:** Next.js (App Router) + React + Tailwind. Stick with the type scale and color tokens in `02-visual-system.md`.
- **Backend:** Whatever you're comfortable with — the API contract in `04` is framework-agnostic. Reference is Node/TypeScript with Postgres.
- **LLM providers:** Anthropic Claude (Opus + Sonnet), OpenAI GPT, Google Gemini. The agents in `03` pick a default model per role; users can swap.
- **Real-time:** WebSocket or SSE for streaming agent responses. Pattern in `04`.
- **Auth:** OAuth (Google, GitHub) + magic-link email. Workspace-scoped sessions.

If you swap any of these, document why and adjust the relevant doc.
