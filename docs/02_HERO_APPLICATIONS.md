# Hero Applications — Specification

**Document type:** Product / UX handoff — for Claude Design to characterize the surface
**Last updated:** 2026-04-30
**Reader:** designer (Joseph + Claude Design) iterating on the user-facing surface
**Companion docs:**
- `01_ARCHITECTURE.md` — substrate spec
- `04_BUILD_PLAN.md` §5 — Phase 1A engineering execution
- `05_DESIGN_BRIEF.md` — UX brief
- `OPTIMIZATION_LOOP.md` — agentic optimization loop these apps surface to users
- `THEME_TOPIC_POINTS_DEFINITION.md` — definitions of editorial layers the Editorial Room operates on
- `SCHEMA_DEFINITION.md` — persona schema referenced when configuring scoring panels
- `EDITORIAL_ROOM_CONTRACT.md` — cross-repo schemas powering the Editorial Room

**Editorial Room flow:** conceptually Setup → Theme → Topic → Points → Research → Outline → Draft → Polish → Ship; **visible UI is 6 phase pills**: `01 SETUP | 02 THEME + TOPICS | 03 POINTS + OUTLINE | 04 DRAFT | 05 POLISH | 06 SHIP`. Setup selects deliverable, voice/length/destination, audience personas, LLM agent profiles, and scoring system. Theme + Topics share one combined workspace (B++ four-column); Points + Outline share one combined workspace (PO5+ chevron-toggleable layout); Sources/Research is a tab inside the Points + Outline workspace. Both combined workspaces use a reusable scoped LLM Discussion panel. Optimization rounds (`OPTIMIZATION_LOOP.md`) surface as top-K candidate lists at Theme, Topic, Point, Outline, and Draft layers — the user picks from the top-K. The Draft Editor uses a **unified `+ OPTIMIZE ⌘O` action** (D3++) with scope-aware popover that runs the full autoresearch + autonovel + panel-pass + propose pipeline. Acceptance is portfolio-compounding (3-5h first piece, ~90 min by piece 5). **Canonical UI specs: `design/01_setup.md` through `design/04_draft.md`.**

**Scope:** two flagship apps, **co-equal and independently useful**; both consume the substrate.

> **Note on document state.** Planning-phase reference doc. App scope, surface affordances, and Phase 1A flow can change freely until first production deployment.

---

## 0a. Success metrics — shared north-star, separate per-app measures

**Shared north-star:** *does this product compound Joseph's thinking into durable artifacts he returns to?*

Both apps are judged against that question, but the per-app measures are sharper and different:

**Panel Talk metric:** *does Joseph return to panels and leave with better decisions, arguments, or reusable synthesis?*

Concrete weekly measures:
- Resumed panels per week (panels opened ≥24h after last touch)
- Panels with ≥1 tracked talking point
- Panels exported, synthesized, or promoted to Editorial Draft
- Panels revisited ≥3 times across separate sessions

**Editorial Room metric:** *does Joseph produce stronger GameMakers pieces, with portfolio (themes/topics/points) that compounds across pieces?*

Concrete trajectory measures (post-v9, portfolio-aware):
- **First piece end-to-end:** 3-5 hours expected (you're investing in portfolio: hand-seeding themes, debating points, building the outline). Quality > speed for piece 1.
- **Fifth piece on the same theme:** ~90 minutes (portfolio compounds — existing points get reused, only new ones need fresh debate).
- **Tenth piece across 2-3 themes:** ~45-60 minutes.
- **Pieces shipped through the workflow:** ≥1/week (ramp after first 2-3 pieces).
- **Claims ledger completed before drafting:** 100% of pieces.
- **Voice score on shipped pieces:** ≥7.5/10.
- **Portfolio depth at 30 days:** number of themes (target 5-10), topics across themes (target 15-30), points across topics (target 60+).
- **Point reuse rate:** % of points used in piece N that already existed before piece N (target rises across the first 5 pieces — this is the compounding signal).
- **Manual rewrite percentage of AI-suggested edits accepted** (signal — high acceptance means suggestions are landing).

These are tracked locally; not for comparing against external benchmarks, just for the user to know whether the tool is paying off.

## 0. The two apps and how they relate

This doc specs two hero applications:

- **App A — Panel Talk** — a general-purpose multi-LLM discussion surface. Any topic the user wants N frontier models to debate, score, brainstorm, steelman, or critique. **Editorially neutral by default.** Use cases span sports analysis, personal finance decisions, parenting questions, career moves, technical design reviews, and editorial workshopping — the substrate is the same; the topic is the user's.
- **App B — Editorial Room** — the creator workflow: ideas → research → draft → AI/human review → finalize. v1 ships with **GameMakers blog posts** as the only output type. Strongly opinionated about voice protection, claims separation, and editorial discipline.

**The two are co-equal and independently valuable.** Panel Talk is not a sub-feature of Editorial Room; Editorial Room is not a wrapper around Panel Talk. They are siblings on a shared substrate.

**Cross-app affordances are loose, not structural.** Editorial Room can fire a *momentary panel fan-out* (one-off, in-place) to consult N models on a paragraph — but that's an editor operation using the substrate's `enqueueTalkTurnAtomic` primitive directly, not an embedded Panel Talk session. From Panel Talk, "Promote to Editorial Draft" hands a synthesis or column response over as a Stage-1 seed in Editorial Room. Beyond those two affordances, the apps don't know about each other.

**Shared constraints:**
- Single user. v1.
- No publish automation. Both apps emit copy-paste-ready markdown / audio / images.
- Both apps share auth, the substrate, and the provider key model — but each gets its own brand and its own marketing surface (see §11 on naming).
- Both apps consume substrate primitives via MCP (see `01_ARCHITECTURE.md` §9). Neither app re-implements substrate capabilities.

---

# APP A — Panel Talk

## 1. User goal

> *"Let me have a real conversation with N frontier LLMs at once — where I push back, take positions, defend my views, and they push back on me and on each other. Not me asking questions and them answering. Me as a voice in the room, debating alongside them."*

The unit of work is a **Panel** — a saved, optionally-persistent multi-way conversation where the user and N agents are all participants. The user's contributions are first-class voices in the discussion, not prompts that get answered. This is the part that made clawtalk *amazing when it worked*: the user wasn't moderating the AIs, the user was *arguing with them*, and they were arguing back.

**Panel Talk is editorially neutral.** It is not a creator tool, not a content tool, not a research tool. It is a *thinking-with-N-models* tool. The user brings the topic. Representative real-world use cases:

- *"I'm leaning toward betting the Lakers tonight — here's my read of the matchup. Push back on me."*
- *"Here's how I'm thinking about my kid's 529 — argue with my reasoning, especially on tax timing."*
- *"My son is struggling with a friendship. Here's how I'm planning to talk to him. Tell me what's wrong with my approach."*
- *"I'm 60/40 on taking this job offer. Steelman both sides, then I'll respond to whichever one I find weakest."*
- *"Critique this function — and then I'll defend the parts I disagree with you on."*
- *"Cal football's 2026 QB prospects: I think Mendoza is overrated. Tell me why I'm wrong."*
- *"I think my product strategy is right. Make me sweat."*
- *"I'm not sure this newsletter angle works. Argue both directions and I'll jump in."* ← editorial workshopping is one use case among many.

Notice the framing: the user takes a position or has a stake; the panel engages, the user defends, pushes back, refines. Not "answer my question." Not "advise me." Real argument, with the user as a peer voice.

The point is breadth. The substrate is general-purpose; the app surfaces it as such.

## 2. What Panel Talk adds beyond clawrocket today

clawrocket today supports `panel` orchestration mode — `enqueueTalkTurnAtomic` already creates N runs per turn with shared `response_group_id`. The Talk UI renders responses in columns. But the surface is generic, ungrounded, ephemeral, editorial-neutral by accident, and treats the user as a question-asker rather than a peer in the discussion. Panel Talk makes the design intentional and adds:

| Richness | What it adds |
|---|---|
| **The user is a peer voice** | The user's contributions are visually weighted as first-class participants, not prompts. User turns can address the panel (default), address one panelist, react to a specific point a panelist made, or take a position the panel must engage with. The compose box affords *contribution*, not *querying*. See §2.6 for the full participation model. |
| **Cross-talk by default** | Every new turn (user or model) sees the full prior conversation including all previous user contributions and all previous model columns. Models can — and should — reference and engage with the user's prior arguments, not just the user's latest prompt. The substrate already provides this; the app surfaces it. |
| **Quote-and-respond** | User can select text from any model column and "Push back on this," "Defend the opposite," or "Quote in next turn." The quoted text appears inline in the user's next contribution; the addressed model sees the quote as a direct callout. |
| **Persistent by default** | Every new panel is saved, indexed, visible in the panel list, and re-openable later. **This is the spine of the app** — see §4.1. The "I want to think about this for a while and come back" pattern is the killer use case for Panel Talk, and persistence by default is what makes it work. Panels are durable until the user explicitly deletes them. |
| **Incognito (opt-in escape hatch)** | Rare use case: user explicitly marks a panel "Incognito" at creation (or toggles it on for an existing panel). Effects: not visible in main panel list, not indexed for cross-panel reference, no context grounding, no capture-to-context, auto-purges after 7 days. Minimal banner at the top says "Incognito — auto-deletes 7 days from now." No nagging. **Defaults to off.** Months of clawtalk/clawrocket use confirm that most users almost never need this; making it a default would undermine the persistence value prop. |
| **Optional context grounding** | A Persistent panel can be primed with rocketorchestra `pages` (e.g., `voice`, a `themes` child, a specific `back_catalog` piece, or any personal context page like `person/son` or `project/heart-of-desire`). Every panel agent sees that context. UX: a "Context" rail with selected pages as chips. Grounding is opt-in *for what to attach* but the panel itself stays Persistent regardless. (Editorial-Room-launched panels auto-ground in the active piece's editorial pages.) |
| **Preset library** | Curated `(provider, model, role, system_prompt)` bundles. The library is browsable and filterable by category: General Reasoning, Devil's Advocate, Steelman/Strawman Pair, Sports Analyst, Personal Finance Council, Career Coach, Code Review Quartet, Editorial Workshop, Parenting Counsel, Founder's Roundtable, Academic Review. Users clone and customize. The default preset is "General Reasoning" (Opus + GPT 5.2 + Gemini 3 Pro + DeepSeek R1, neutral system prompts) — *not* an editorial-domain preset. **Preset system prompts must instruct the model to engage with the user as a peer, not as an assistant** (see §2.6). |
| **Persona-as-panelist** | A panel slot can be a raw `(provider, model, system_prompt)` slot OR a reference to a substrate `persona` page. When the slot is a persona ref, the system prompt is built from the persona's `detailed_profile`, and the panelist roleplays as that named person. The same Ankit persona used as an audience target in Editorial Room can be invited as a panelist here — argue with Ankit specifically about a take you're considering. Persona slots and raw model slots can mix in the same panel. |
| **Provider transparency badges** | Every agent column renders metadata badges: knowledge cutoff date, web search availability (on/off), citation rendering (when the model emits sources), and provider data-retention class. |
| **Synthesis on demand** | After a panel turn, click "Synthesize" → an Opus call merges the N responses **plus the user's contributions** into one summary or a structured points-of-agreement / points-of-disagreement view. The user is a voice in the synthesis, not the moderator of it. |
| **Targeted reply** | Reply to one specific column without re-fanning to all. UX: hover a column header, click "Reply to this only." Useful for one-on-one debate within a multi-way conversation. |
| **Address-the-room toggle** | The compose box has a clear "to: All / @opus / @gpt / @gemini / @deepseek" addressing control. Default is "All." Single-target preserves cost on focused exchanges. |
| **Cost meter + model swap** | Live per-turn cost preview before send; per-turn actual cost after. Click any agent chip to swap its model mid-conversation; preserves persona and system prompt. |
| **Branch from a response** | Right-click a column response → "Branch from here" — opens a new Panel seeded with that response as the new starting context. |
| **Reference other Panels** | When composing a new turn, `@` to inline a prior Panel's synthesis as context. Builds compound thinking across sessions (only for saved panels). |
| **Talking Points tracker** | A side rail tracks the emergent structure of the debate: each point has status `Active` / `Closed - Agreed` / `Closed - Disagreed` / `Parked`. Points are extracted manually (select text → "Track this point") or proposed by the synthesizer; status is set by the user, never automatically. The points list is the working artifact of the conversation. See §2.7. |
| **Convergence (user-triggered, never mandatory)** | When the user is ready, "Converge" produces a structured outline of where the conversation landed: agreed-on points in order, parked points listed, open points kept open. Convergence is an action the user takes, not an emergent state the system declares. Some panels never converge — that's a valid outcome. See §2.7. |
| **Variable output destinations** | After convergence (or any time), the user picks where the structure goes: nothing (close panel), internal pinned summary, markdown copy/download, Editorial Room draft seed, or Google Doc. Output is optional — sometimes the conversation IS the artifact. See §2.8. |
| **Promote to Editorial Draft** *(loose cross-app affordance)* | If a Panel produces something publishable, this CTA hands the convergence outline (or one column, or one of the user's own arguments) over to Editorial Room as a Stage-1 idea seed or Stage-3 draft seed. One-way; no structural coupling. |

**What does NOT belong in Panel Talk** (anti-bloat principle):
- **No editor pane.** Panel Talk is for thinking; Editorial Room is for writing. Don't conflate them.
- **No autonomous overnight agents.** Panel Talk is human-initiated, every turn. Scheduled work belongs in Editorial Room or in substrate-level cron triggers.
- **No publishing.** Panel Talk is never the surface that ships content.
- **No life-coach framing.** The product is "watch N frontier models think out loud and disagree productively." It is not "AI advisor." Resist any UX language that implies advice-giving authority. The framing is *here are perspectives, you decide.*

## 2.5 Trust surface — sensible defaults, escape hatches when needed

Most users want their panels saved and accumulating — that's why the default is Persistent. For the rare situations where a user wants to think out loud without leaving a record, the product offers escape hatches without making them the default. Three pieces v1 ships:

- **Per-provider retention disclosure.** Each agent column shows a one-line "data handling" indicator (e.g., "Anthropic API: not used for training"; "OpenAI: zero-data-retention if enabled"; "Google: 60-day retention by default"). The values come from current provider API terms, surfaced via a substrate-maintained metadata sheet — not from in-app prose. **This is useful in any mode** — whether persistent or incognito, the user benefits from knowing what providers do with the data.
- **Incognito mode (opt-in per panel).** New panel → toggle "Incognito" before sending the first turn. Banner at top says "Incognito — auto-deletes 7 days from now. Not indexed. Not grounded." That's it. No nagging.
- **Easy delete.** One-click delete on any panel. Explicit "purge across providers (best-effort)" action that fires retention/deletion API calls where supported. Available regardless of mode.
- **Private mode (per-panel provider filter).** A toggle inside any panel that filters out providers with training-on-content default terms. Independent of the persistent/incognito axis — a Persistent panel can still be Private. Useful when the user wants to keep the panel saved but doesn't want a particular provider's training pool to see it.

**No advice disclaimers in the way of use.** A footer disclaimer ("Not professional advice") is fine; intrusive every-turn modals are not. Treat users as adults.

**Why these defaults work.** Months of clawtalk/clawrocket use confirm: most users almost never want their conversations purged, and Defaulting to Ephemeral / Incognito undermines the cold-start-tax-elimination story rocketorchestra is built around. The trust surface is "make the rare case easy to opt into" — not "make the common case feel sterile."

## 2.6 The participation model — user as peer, not moderator

This is the load-bearing decision that distinguishes Panel Talk from a generic multi-LLM chat client. The user is a participant in the conversation, not the operator of it. Six concrete implications:

**1. Visual weight.** User turns are rendered with the same column-width and visual gravity as a model column — not as thin "user said:" headers. A user's argument should look like another voice in the discussion, not a prompt that the AI is replying to. The user's voice gets a name (display name from auth), an accent color (user-configurable), and full block weight.

**2. Default system prompts treat the user as a peer.** Every preset's system prompt explicitly instructs the model: *"You are in a conversation with a human and other AI agents. The human is not your client; they are a peer voice in the discussion. Respond to their arguments substantively. Disagree when warranted. Do not flatter, hedge by default, or treat their question as needing service. They are arguing with you; argue back."* This is the single most important UX lever in the whole product. Default-helpful-assistant prompting kills peer dynamics.

**3. Addressing affordances.** The compose box surfaces the user's intent explicitly:
- **Address all** *(default)* — fans to all enabled agents
- **Address one** — single-target reply (`@opus`, etc.); model knows it's a direct exchange
- **React to** — quotes a specific passage from a prior column; addressed model sees the quote as a callout to defend or revise
- **Take a position** — special framing where the user states a thesis and the panel is asked to engage with it; the panel's prompt explicitly includes "the user has staked a position; engage with it directly, agree or disagree, but don't sidestep"

**4. Cross-talk is real.** When the user pushes back on Opus, then in the next turn fan-outs to all, GPT and Gemini see Opus's response *and* the user's pushback. Models reference both. The user's contributions are part of the conversation context for every subsequent turn — the substrate already does this; the app's job is to make it visible (e.g., a model's response can quote a user argument the same way the user can quote a model).

**5. Disagreement is first-class.** "Push back on this" / "Disagree" is a primary action on every column response, not buried in a menu. The whole product loses if the user has to work hard to argue. The friction of disagreement should be lower than the friction of agreement.

**6. The user is not a moderator.** There is no "judge" UI element. No "rate this response" buttons in the main flow. No "which model won?" framing. The user joins the conversation; the conversation is the point. Synthesis exists because sometimes the user wants a summary, not because the user adjudicates the panel.

**Anti-pattern to avoid:** the "AI advisor with multiple opinions" framing. That's what every existing multi-LLM chat client builds. Panel Talk is not that. It's a *room with peers in it.* The user enters the room and contributes; they don't sit at a desk and consult.

## 2.7 Talking Points and convergence — the working structure of a debate

A long, productive debate isn't a flat sequence of turns; it has emergent structure. Different sub-claims get raised, debated, and resolved (or left unresolved) at different rates. Panel Talk surfaces this structure as **Talking Points** — a live side rail that tracks where each thread of the conversation stands.

### Point lifecycle

Every Talking Point has one of four statuses:

| Status | Meaning |
|---|---|
| **Active** | Currently being debated; the most recent turn is engaging with this point |
| **Closed — Agreed** | User explicitly closed the point because the panel and user converged on a position |
| **Closed — Disagreed** | User explicitly closed the point as "agree to disagree" — no consensus, but no further productive debate expected. **This is a first-class outcome.** Real debates have irreconcilable points. The product must respect that. |
| **Parked** | Interesting but tangential to the current thesis; user wants to come back to it later |

### How points enter the tracker

- **User-extracted (primary path):** user selects text from any turn (their own or a model's), clicks "Track this point," types a one-sentence claim. Source turn is recorded.
- **Synthesizer-proposed:** when the user clicks "Synthesize" or "Suggest points," the synthesizer reads the conversation and proposes points that look distinct. Proposals appear with a "Track" / "Dismiss" action. **Proposals never auto-track — user confirms.**
- **Manual:** user types a point directly in the points rail (e.g., to seed a thesis the panel will engage with).

### How points get closed

**Only by the user. Never automatically.**

The system can *suggest* a point looks settled — a small badge ("panel appears to have converged on this") on points where recent turns show alignment — but the act of closing is always an explicit user click. Closing carries judgment; that judgment belongs to the user.

When closing, the user picks the status (Agreed / Disagreed / Parked) and optionally adds a one-line resolution note. The point moves out of the Active list and into a status-organized section of the rail.

### Convergence

When the user is ready (zero or more points may be Closed; some Active points may remain), they click **"Converge."** This produces a **convergence outline**: a structured snapshot of where the conversation landed:

- Closed-Agreed points in narrative order
- Closed-Disagreed points listed with a brief note that consensus wasn't reached and why
- Parked points listed for later
- Open (still Active) points listed with their current status of debate
- Unresolved questions explicitly named

**Convergence is never required.** Many panels end without it — the user got clarity, walks away, panel stays in the sidebar with whatever state it had. That's fine. Convergence exists for the cases where the user wants to *do something* with the structure.

### What the points rail looks like (UX sketch)

The points rail is a collapsible right sidebar:

```
┌──────────── Talking Points ────────────┐
│                                        │
│ ▼ Active (3)                           │
│   • [thesis] AI tutorials hurt indies  │
│   • SEO pollution is the real issue    │
│   • Discovery vs. content quality      │
│                                        │
│ ▼ Closed — Agreed (2)                  │
│   ✓ Smaller indies don't compete on    │
│     SEO; volume tutorials win the SERP │
│   ✓ Tutorial discovery is a separate   │
│     problem from tutorial quality      │
│                                        │
│ ▼ Closed — Disagreed (1)               │
│   ⚠ Whether AI tutorials displace      │
│     paid courses long-term             │
│                                        │
│ ▼ Parked (1)                           │
│   ⏸ Substack as a tutorial host        │
│                                        │
│ [+ Add point]    [Converge →]          │
└────────────────────────────────────────┘
```

## 2.7.5 Dialectical synthesis — making disagreement productive

Most LLM panel implementations have a *summarization* problem. When two agents disagree, the natural UX move is to surface "Agent A says X, Agent B says Y" as a flat side-by-side, or to pick a winner, or to compute a vague middle position. None of these is what makes panel discussion actually generative.

The product hypothesis Panel Talk is built on — different models with different points of view materially improve understanding — only pays off if the system can do something with the disagreement beyond display it. The genuinely valuable move is **dialectical synthesis** in Nonaka's sense: not compromise, not selection of a winner, but a higher-order frame that makes both positions partially true *and the disagreement itself productive*. When honest synthesis isn't possible, the system should name the *aporia* (the genuine unresolved point) and articulate what would have to be true to resolve it.

This is a distinct operation from the existing **Synthesize** action (which extracts themes and pulls coherent points). Synthesize is summarization. Dialectical synthesis is structural and adversarial: it requires the system to actively resist middle-grounding.

### When it surfaces

The `Find Synthesis` action appears in the right rail when the panel produces *sustained disagreement* — heuristic: ≥ 2 agents holding distinguishable positions across ≥ 2 turns. The user can also invoke it manually on any selected exchange. Cost preview shown before launch (~$0.05–$0.20 per synthesis call; cheap because input is one bounded turn-thread).

### What it returns

The Skill produces a `DialecticResult` with the following structure:

```typescript
type DialecticResult = {
  schema_version: "0";
  source_turn_ids: string[];            // panel turns that produced the disagreement
  source_panel_id: string;
  source_run_id: string;

  thesis: DialecticPosition;
  antithesis: DialecticPosition;

  disagreement_kind:
      "empirical"           // they disagree about what's true
    | "values"              // they prioritize different things
    | "framing"             // they're using different frames
    | "talking_past"        // they're answering different questions
    | "mixed";

  synthesis_candidates: SynthesisCandidate[];    // 0–3
  aporia: AporiaNote | null;                     // populated when no honest synthesis exists

  new_question: string;                          // the better question this opens

  cost_usd: number;
  latency_ms: number;
  model_used: string;
  created_at: string;
};

type DialecticPosition = {
  position_summary: string;                      // ≤ 300 chars, charitable steelman
  held_by_agents: string[];                      // agent_profile_ids
  strongest_quote: string | null;                // verbatim from a turn, optional
  underlying_value_or_assumption: string;        // what makes this position attractive
};

type SynthesisCandidate = {
  framing: string;                               // the higher-order frame
  why_it_resolves: string;                       // how it makes both positions partially true
  what_it_costs: string;                         // what each side gives up
  practical_implication: string;                 // what changes if you adopt this synthesis
};

type AporiaNote = {
  reason: string;                                // why no synthesis was attempted
  what_would_resolve: string;                    // what would have to be true to resolve
};
```

**The Skill prompt actively resists three failure modes:**

- *Compromise dressed as synthesis* ("they're both kind of right"). The synthesis must be a genuine higher-order frame, not a midpoint.
- *Strawmanning either position.* Each position is summarized in its strongest form. If the model can't articulate the strongest form of position B, it admits aporia rather than surfacing a weak version.
- *False resolution.* The model is explicitly told that returning aporia with a clear `what_would_resolve` line is a *better* answer than a vague synthesis. The success criterion is "does this give the user a better question to think about," not "does this end the disagreement."

### UX surfacing

`Find Synthesis` is a distinct affordance from `Synthesize`. Different icon, different copy, different output card. The result renders as a structured `DialecticCard` in the panel side rail with four collapsed-by-default sections (Thesis, Antithesis, Synthesis Candidates, New Question). Aporia appears as its own labeled state when the synthesis_candidates array is empty.

Each `DialecticResult` is saveable as a Talking Point with the synthesis (or aporia) as the *durable artifact* — not a summary of the panel, but the structured form of what the panel produced. Talking Points produced this way are tagged `derived_from_dialectic: true` for downstream filtering.

### Promotion path: Panel insight → Editorial Theme/Topic

A `DialecticResult` (and any saved Talking Point) carries a `Promote to Editorial` action. Click → opens Editorial Room's Theme or Topic search with the synthesis pre-loaded as seed context, the originating panel linked as provenance, and a `derived_from_panel: true` flag on the resulting page.

Mechanically, this routes through the same `SkillContext.panel_seed` parameter the Optimization Loop already uses for PCP context (per `EDITORIAL_ROOM_CONTRACT.md` §6.1). The Theme/Topic generation Skill prompt receives:

- The synthesis text (or aporia + new_question if no synthesis)
- The thesis and antithesis as anti-targets ("don't generate Themes that flatten this disagreement back into one pole")
- The panel link as provenance metadata

Resulting Themes/Topics carry `PanelProvenance` (parallel shape to `PcpProvenance`) with the source panel id, source turn ids, source dialectic result id, and a user-promoted-at timestamp once the Theme/Topic is adopted.

This is the **forward direction of the SECI spiral**: Panel Talk produces externalized articulations through dialogue → those articulations seed Editorial Room Theme/Topic search → resulting Pieces ship → published context flows back into the substrate as `back_catalog` and durable `domain` pages → the user's accumulated knowledge informs the next panel. The two apps stop being "two tools that share substrate" and start being "two phases of one knowledge cycle."

### What we're explicitly not doing yet (TODOs)

- **Phronesis as a quality metric** for the synthesizer's output — practical-wisdom grading is a real concept but doesn't operationalize cleanly without a measurable rubric. Defer until we have shipped synthesis history we can grade by adoption rate.
- **Externalizations as a renamed first-class artifact** (replacing "Talking Points" with "Externalizations" or "Articulations"). Conceptually clean, mostly UX/copy work, low marginal value before we have real-world usage to justify the rename.
- **"Ba" framing for context modes** in user-facing copy. Worth absorbing into in-app help text once we know which terms users gravitate to.

See `TODOS.md` for these and other deferred items.

---

## 2.8 Variable output destinations

After convergence — or at any time during a debate, even before convergence — the user picks where the structure goes. **Output is optional.** Sometimes the conversation IS the artifact: the user got clarity, marks a few points as parked for later, and walks away.

When the user does want output, v1 ships these destinations:

| Output | Destination | Best for |
|---|---|---|
| **Nothing** | (panel stays in the sidebar in its current state; Incognito panels eventually purge per TTL) | The conversation gave the user clarity; no portable output needed |
| **Internal summary** | Markdown summary pinned inside the Panel itself, re-readable later | Saved panels you want to revisit; reference-only |
| **Markdown copy** | Clipboard | Talking points to bring into a meeting; engineering memo; rough seed for any other tool |
| **Markdown download** | `.md` file | Same as copy, but archival |
| **Editorial Draft** | Editorial Room (Stage 1 idea seed or Stage 3 draft seed) | Blog posts, newsletters, podcast scripts — the cross-app affordance |
| **Google Doc** | New doc in user's Drive | Code refactor recommendations, meeting prep, longer-form notes the user will edit further outside this product |

Future destinations (v2+, all map to the same points-structure → format-shaped output pattern): Notion page, Slack message, Linear issue, GitHub PR description, Apple Notes, Obsidian vault.

### Format-shaped templates

Each output destination supports format-shaped templates that map the points-structure to the destination's idiomatic shape:

| Template | Shape | Default destination |
|---|---|---|
| **Talking points list** | Numbered list of agreed points, "open questions" section, "parked" footnotes | Markdown copy / Google Doc |
| **Engineering memo** | Background, recommendations (one per agreed point), tradeoffs (disagreed points), open questions | Google Doc |
| **Blog post draft seed** | Working title, thesis (the user's), supporting points (agreed), counterarguments to address (disagreed), open questions for the piece | Editorial Room |
| **Decision memo** | Decision, alternatives considered, why this won, what we set aside | Markdown copy / Google Doc |
| **Meeting prep doc** | Topic, your position, expected pushback, your responses to pushback, open questions to ask the room | Google Doc / markdown copy |

Templates are user-editable; new ones can be created (system prompt + output schema). The mapping is deterministic — same points structure + same template = same output, regardless of which models were in the panel.

## 3. Core flow (the minute-one experience)

Two walkthroughs to make the breadth concrete — one personal, one editorial. Same surface, different context modes.

### 3a. Personal-topic walkthrough (Persistent mode, default) — coming back later

1. User clicks **"+ New Panel"** in the sidebar. Names it "Job offer — push or accept?" Preset: "Career Coach" (4 agents). Mode: Persistent (default — no decision needed; the panel just gets saved).
2. User opens with a position: *"I'm leaning toward accepting as-is. The offer is at the top of the band, the team feels right, and pushing harder feels greedy. Convince me I'm wrong, or tell me I'm right and why."*
3. Fan-out. Negotiation-coach pushes hard: *"You're leaving leverage on the table."* Risk-modeler agrees with the user. Career-strategist middles. Employee-advocate sides with negotiation-coach.
4. **User extracts a point**: selects "leverage on the table," clicks "Track this point," writes: *"Whether I actually have leverage to negotiate."* Status: Active.
5. **User pushes back on negotiation-coach specifically**: *"That assumes I have leverage. I don't have a competing offer. What leverage am I actually wielding?"* Negotiation-coach lists three: start-date, sign-on, equity vesting.
6. **User adds a point**: *"Single-issue negotiation (equity vesting only) is a viable middle path."* Status: Active.
7. **User wants to think.** Closes the tab. The panel persists in the sidebar with the timestamp "last edit 12 min ago" and 2 Active points.
8. **Two days later.** User has talked to a friend, done some research. Re-opens the panel from the sidebar. The full transcript is there; the points rail still shows the two Active points.
9. User adds a new turn addressing the panel: *"Argue against single-issue equity-only ask. I've thought about it for 48 hours and I want to see if my reasoning holds up."* Career-strategist raises tax timing. Risk-modeler raises rigidity-signaling.
10. **User closes points**: "leverage" → Closed-Agreed; "single-issue is rigidity-signaling" → Closed-Disagreed (note: "I disagree — single-issue is appropriate for this offer"); "tax timing" → Parked ("need accountant input").
11. User clicks "Output to..." → picks **Markdown copy** with the talking-points-list template. Pastes into a notes app for reference during the actual negotiation.
12. **Panel stays in the sidebar.** Six months later the user is negotiating again at a different company; opens the old panel as reference, branches a new one from it. The accumulated thinking is durable.

**The killer moment was step 7-8** — closing the tab and coming back two days later with the full thinking intact. That's what Persistent-by-default exists for. If the panel had auto-purged or required explicit "save" the user would have lost the thread.

### 3a-alt. Same topic, but in Incognito mode (rare opt-in case)

If the user *did* want to keep this off the record — say, mid-job-search at a current employer where they don't want any AI training data containing offer details — they'd toggle "Incognito" before the first turn. Banner appears: "Incognito — auto-deletes 7 days from now." Same conversation flow, but: not in the sidebar list, not indexed for future reference, no capture-to-context. After 7 days, purged. The user weighs the tradeoff explicitly. **Incognito is the exception, not the rule.**

### 3b. Editorial-topic walkthrough (Grounded mode) — debate ending in Editorial Draft

1. User clicks **"+ New Panel"**. Names it "AI tutorials angle." Preset: "Editorial Workshop." Mode: `Grounded`, with `voice: gamemakers-2026` and `themes: AI-in-games` attached.
2. User opens with a working thesis: *"My take: AI-generated tutorials will hurt indie devs more than help them, because the tutorials are now SEO-optimized fluff that buries the actual hard-earned how-to content from working developers. Argue against this; I want to see if the take holds up."*
3. Fan-out. Editor-in-Chief calls the take too binary. Skeptical Contrarian agrees with the user but pushes for evidence. Newsletter Editor reframes: *"narrow it — not 'tutorials' but 'tutorial discovery'."* Developer Advocate offers a counter-anecdote.
4. **User extracts the original thesis as a point**: *"AI tutorials hurt indies more than help"* — Active.
5. **User defends a narrowed version** by quoting the discovery reframe: *"Discovery is exactly the point — the tutorials themselves can be fine, but the discovery surface is being polluted."* **Tracks this as a separate point**: *"Tutorial discovery (not quality) is the real harm."* Active.
6. Panel re-engages on the narrowed claim. Two columns agree; one wants a case study.
7. User pulls in back-catalog: cites a 2025 piece they wrote on developer SEO.
8. **User closes the original thesis as Disagreed**: too broad — better as the narrowed version. **Closes the narrowed claim as Agreed**: panel converged with case-study support. **Parks** Newsletter Editor's quote about "AI tutorials enable smaller devs to learn faster" — interesting counter-thread, but not central to this piece.
9. User clicks **"Converge"** → outline produced: thesis (the narrowed one), three supporting points, two open questions for the piece (one of which the user wants to explicitly leave open in the post itself), one parked counter-thread, one back-catalog connection.
10. User picks output destination: **Editorial Draft.** Picks template: **Blog post draft seed.**
11. Editorial Room opens with the narrowed thesis as the seed and the convergence outline as the Stage-1/2 starting point. Panel responses are preserved as `claims_ledger` evidence; the parked counter-thread shows up as an "open question" the user can decide whether to address in the post.
12. Panel Talk session remains saved; Editorial Room work continues independently.

The user's contributions did the actual editorial work. The panel sharpened the thinking, the points-tracker structured it, the convergence outline preserved the structure for Editorial Room to consume. The result feels like the user's because it is.

### 3c. Code-base discussion walkthrough (Persistent mode) — debate ending in Google Doc

1. User opens a Panel: *"Should we refactor our auth middleware before or after the Q3 release?"* Preset: "Code Review Quartet." Mode: Persistent (default — the user wants to be able to come back to this thinking; they may revisit during the actual eng meeting).
2. User opens with a position: *"I want to refactor before. The middleware is fragile and we're going to ship features through it for the next quarter. The cost of waiting compounds."* Pastes a 200-line excerpt of the middleware.
3. Fan-out. Architect-persona agrees but flags coordination cost with two other teams. Pragmatist-persona pushes back hard: *"Ship Q3 first; tech debt is a future-you problem. The risk of refactor breaking the release is higher than the risk of a fragile middleware lasting one more quarter."* Risk-modeler quantifies (back-of-envelope incident probabilities). Code-quality-persona enumerates specific brittleness in the excerpt.
4. **User tracks four points**: (a) brittleness specifics, (b) coordination cost, (c) Q3 release risk if refactored now, (d) compounding cost of waiting.
5. User pushes back on Pragmatist: *"You're treating this as binary. What about a phased refactor that ships a stable interface first, then the internals after Q3?"* Pragmatist concedes the phased option might work; flags integration test debt as the new risk.
6. **User adds a point**: *"Phased refactor — interface-first, internals-after — as a middle path."* Active.
7. After more exchanges: User closes (a) brittleness as Agreed (panel converged on the four most fragile spots); closes (c) Q3 risk as Disagreed (user thinks the panel is overweighting it; user is the one shipping it); closes (e) phased refactor as Agreed; parks (b) coordination cost ("decide after I talk to the other team leads").
8. User clicks **"Converge"** → outline: phased refactor recommended (interface-first, internals-after Q3), four fragility hotspots, integration-test debt as a tracked risk, coordination call to other teams as a prerequisite, parked items.
9. User picks output: **Google Doc.** Template: **Engineering memo.**
10. Doc lands in Drive: "Auth Middleware Refactor — Recommendation Memo." User shares it with the eng team; uses it to frame the next eng meeting.
11. Panel stays in the sidebar — the user can re-open it during the eng meeting if questions come up. The Google Doc lives independently; the Panel is the durable workshop.

This is the use case Joseph called out specifically — the panel was a way to *frame discussions with the engineering team*, not a way to write a blog post. Different output, same primitive.

## 4. Surfaces (for Claude Design to characterize)

Three top-level UI regions in App A. Layout proportions are illustrative; Claude Design will iterate.

### 4.1 The Panel List (left rail) — the spine of Panel Talk

This is the most important UX component of the app. The "I want to think about it for a while and come back" pattern is the killer use case for Panel Talk, and the panel list is what makes it work. clawtalk and clawrocket both got this right — Panel Talk inherits and extends the pattern.

**Sections (top to bottom):**

- **+ New Panel** — primary CTA. Always visible.
- **Pinned** *(≤5 user-pinned panels)* — the user's most-active threads. Right-click any panel to toggle pin.
- **Active — needs attention** *(automatic)* — panels with unresolved Active points + recent activity from another participant (rare in single-user, but matters when AI agents propose follow-ups). Each item shows a subtle "you left this with N active points" indicator.
- **Recent** *(last 14 days, sorted by last-touched)* — most-used surface. Each row shows: title, last-touched timestamp, mode badge if not Persistent (Editorial / Incognito), points-count summary ("3 active, 2 closed"), preset hint ("Career Coach panel").
- **All panels** *(filterable + searchable)* — full-text search across panel transcripts AND persona/preset names. Filter chips: by tag, by preset, by date range, by origin (Editorial-launched vs. standalone), by mode.
- **Archived** *(bottom)* — panels the user has explicitly archived. Out of the way but recoverable.

**The list shows only Panel Talk panels initially.** Editorial-Room-launched momentary consultations stay editor-local and are not saved as Panel Talk sessions unless the user explicitly clicks "Save as Panel Talk." Editorial Room has its own piece list with its own navigation. Each app's surface stays conceptually clean. If usage signal shows users want a substrate-level "Recent Thinking" view that spans both apps, that's a later addition.

**Resumption affordances** (these matter most):
- **Last-touched timestamps** — humanized ("12 min ago," "2 days ago," "last week").
- **"You left this with X" indicator** — when re-opening a panel with active points, the rail shows the unresolved points first so the user re-enters the thinking quickly.
- **Search across transcripts** — full-text within Persistent panels (Incognito and Editorial-Momentary panels excluded from index).
- **Branch indicators** — if a panel was branched from another, the source is one click away.

**Keyboard shortcuts:**
- `⌘+K` — quick-search the panel list.
- `⌘+Shift+N` — new panel (cursor in title field).
- `⌘+1..9` — jump to pinned panel #1..9.

**Visual density:** the panel list defaults to comfortable density (~12 visible items on a 1080px-tall window). User can switch to compact density (~24 items) for power users with many open threads.

**What does NOT belong in the panel list:**
- No analytics or "engagement" metrics. The list is a working document, not a dashboard.
- No notifications nags. If a scheduled job updated a referenced page, that goes to the inbox, not here.
- No archived panels mixed in by default — they're explicitly in the bottom section.

### 4.2 The Panel Detail (center, three sub-regions)

- **Header:** title (default-named with the first turn's gist if user doesn't name it; user can rename anytime), objective, **mode badge** — `Persistent` is implicit (no badge, since it's the default), `Incognito` shows a clear yellow banner with TTL, `Editorial` shows the linked Piece's title. Agent chip rack with provider-transparency badges. Optional context chip rack (any context page the user has attached). Cost meter.
- **Transcript:** vertical scroll of message blocks.
  - **User contributions render as full-weight blocks** with the user's display name and accent color — same vertical scale and visual gravity as a model column. Not thin "user said:" headers. The user is a peer voice, and the layout shows it.
  - **Panel turns render as horizontal column triptychs** (responsive: scrolls horizontally on narrow viewports, stacks vertically below ~720px). Per-column header shows knowledge-cutoff badge, web-search-on/off badge, retention-class badge.
  - **Targeted exchanges** (user replies to one column, or one model replies to user) render with a connecting visual cue (line, indent, "→ in reply to X" label) so the conversational thread is readable.
- **Compose:** textarea + addressing control + send button.
  - **Addressing control** is prominent: a segmented selector or chip rack showing `To: All` (default) / `To: @opus` / `To: @gpt` / etc. Single-tap to switch.
  - **Quote affordance:** when the user has selected text from a prior column, a "Quote in reply" / "Push back on this" control appears above the compose box; the quoted text inlines into the message with the source attribution.
  - **Send shortcuts:** `⌘+Enter` sends to whatever the addressing control says.
  - Cost preview before send.
  - **One skill-shaped action initially:** Synthesize, which runs on the latest panel turn or pinned slots. Editorial Skills (`adv_cut`, `opus_review`, etc.) are not exposed here. **Scoring is deferred from Panel Talk** — let it prove itself in Editorial Room first; if Panel Talk genuinely wants a "Run Rubric" action later it gets added then with the right framing.

### 4.3 The Right Inspector (collapsible)

The right rail is the working surface for the conversation's structure. Two stacked sections:

**Talking Points panel** *(top, primary)* — the live points tracker described in §2.7. Sections: Active, Closed - Agreed, Closed - Disagreed, Parked. Each item is a one-line claim with status chip; click to expand for resolution note + source-turn link. CTAs at bottom: `+ Add point`, `Converge →`. This is the most-used part of the right rail in long debates.

**Actions / Output tray** *(bottom)* — Panel-level operations:
- `Synthesize` — quick consolidation summary; doesn't require points to be tracked.
- `Converge →` — the formal convergence step; produces the structured outline; opens the output destination picker.
- `Output to...` — direct shortcut to the destination picker (Nothing / Internal pin / Markdown copy / Markdown download / Editorial Draft / Google Doc).
- **`Save to Context...`** *(Persistent and Editorial modes — suppressed in Incognito)* — opens a small modal proposing a personal-context page update from the panel content. The substrate's `factory_propose_context_update` Skill auto-suggests a target page (e.g., a Panel about your son routes to the `person/son` page; a Panel about an architectural decision routes to a new `decision` page). User can override target, edit the proposed diff, then approve it through the standard inbox flow. **Available on:** any user contribution, any model column, the synthesis, the convergence outline, or the entire panel transcript.
- `Pinned response slots` — drag any column response here to keep accessible across many turns.
- `Convert to Incognito` *(Persistent mode only — converts a Persistent panel to Incognito; sets a 7-day purge timer; one-way action)*.
- `Convert to Persistent` *(Incognito mode only — keeps the panel permanently; cancels the purge timer)*.
- `Purge Now` *(Incognito mode only — explicit early deletion)*.
- `Delete Panel` *(any mode — explicit deletion with confirmation)*.
- `Export Transcript`.

**Mode controls** *(secondary, collapsible)* — attach/detach context pages, toggle "private mode" (excludes providers with training-on-content terms; independent of Persistent/Incognito axis).

**Run history** *(secondary, collapsible)* — last 20 panel turns with cost + latency. Reload any to inspect.

## 5. Edge cases & details for design

- **Streaming asymmetry.** Some models stream faster than others; the slowest column can leave 30s of empty space while others are done. Design needs a "tap to read fastest-first" affordance and a per-column "thinking" placeholder.
- **One column errors.** If GPT 5.2 hits a 429 and falls back, that column shows the fallback model's response with a small badge. Don't block the whole turn.
- **Context overflow.** When a Panel has 50+ turns and 3 grounded pages, the system prompt + context exceeds 200k tokens. Substrate handles via auto-summarization of older turns; UX should show a "summary mode" indicator and let user expand to see what was summarized.
- **Cost surprise prevention.** Before fanning to 4 frontier models with a 50k-token context, show an estimated cost preview. Don't gate; just inform.
- **Persona disagreement signaling.** When two columns substantively disagree, render a small ⚡ icon on the divergent claim. Useful for fast scanning.
- **Mobile.** Read-only mobile (responsive). Authoring stays desktop initially.

## 6. Open design questions for Claude Design

1. **User-block visual weight.** This is the most important question. User contributions must read as peer voices, not prompts. Full-width blocks like a model column? Half-width with a "user" lane? Avatar-prefixed but full-width? Get this wrong and the whole product reads like a chatbot.
2. **Addressing control placement.** The "To: All / @opus / @gpt" selector — segmented control above compose, chips next to send button, or persistent in the compose left margin? The frequency of addressing-mode changes (likely high — users will toggle between fan-out and single-target many times per session) means it has to be one-touch.
3. **Quote-and-respond UX.** When the user selects text in a column, what surfaces? A floating action bar near the selection? A "quote" button in the compose footer? Once quoted, how is the inline quote rendered in the message — blockquote, gray-bordered card, attribution-only?
4. **Targeted-reply threading.** A user-reply-to-one-column → that-column-replying-to-user is a visual mini-thread inside a multi-way panel. Should it indent? Connect with a line? Collapse-on-default? The risk is that targeted exchanges visually disappear into the broader transcript scroll.
5. **How is Synthesis visually distinguished from a column response?** Full-width banner? Structured points-of-agreement / points-of-disagreement table? Where does the user's evolving position appear in the synthesis — as a separate voice, a thread, or implicit in the summary prose?
6. **Pinned slots — sidebar or header strip?**
7. **Branch UX — modal, side-panel, or new tab?**
8. **Cost meter placement — header (always visible) or footer (only on send)?**
9. **Triptych on narrow viewports — horizontal scroll or vertical stack?**
10. **Default agent count — 3 or 4?** Three fits horizontally on most laptops without scroll; four gives more diversity. Note: the user is conceptually a "fifth voice" in the conversation, even though their contributions render as full-width blocks rather than columns. That asymmetry is intentional — the user's contributions span the conversation, the models' are points within it.
11. **Provider transparency badges — how prominent?** Always-visible chips eat header space; tooltip-on-hover hides them.
12. **Incognito banner placement.** Persistent panels show no mode badge (default state, no visual noise). Incognito needs to be visible without nagging — yellow strip across the panel header showing "Incognito — auto-deletes 2026-05-04," subtle persistent badge near the title, or background tint? My instinct: header strip with the date, calm yellow, no repeat reminders.
13. **The "empty Panel" zero state.** A blank page is intimidating; a tutorial nags. Suggested: a curated "starter prompts by category" picker — Personal Decisions, Steelman / Strawman, Code Review, Sports / Stats, Editorial Workshop, Career Moves. **Crucially:** the starter prompts should model user-as-participant phrasing — "I think X, push back" — not assistant-summoning phrasing — "what do you think about X."
14. **Preset library browsing.** Vertical list, card grid, search-led? Design for ~40 presets without it becoming a wall.
15. **Panel list visual density.** Comfortable (~12 visible) vs. compact (~24 visible) toggle — where does it live? What's the right default? Power users with many open threads will want compact; new users will want comfortable.
16. **"You left this with X active points" indicator.** When re-opening a panel, where does the unresolved-points reminder appear — banner in the panel header, expanded points rail by default, or in-line annotation in the transcript at the spot where the user last left off?
17. **Search across panel transcripts.** Full-text search via `⌘+K` — what's in scope? Just panel titles and objectives, or full transcript bodies? Returning transcript snippets is more powerful but harder to render readably.
18. **Mobile.** Read-only mobile (responsive). Authoring stays desktop initially. Mobile panel list is a real use case (re-reading on the go); prioritize that surface.
17. **Points rail prominence.** Always-visible right sidebar, collapsed-by-default with notification dot when synthesizer proposes points, or only-on-demand toggle? The points list is critical for long debates and irrelevant for short ones; the design has to handle both gracefully.
18. **Tracking a point — friction floor.** Tracking should be one selection + one click. Worse than that and users won't do it. What's the right gesture: floating toolbar near selection, sidebar drop-zone, keyboard shortcut, slash command in compose?
19. **Closing a point — visual finality.** Closed-Agreed and Closed-Disagreed are emotionally different states; how does the UI honor that? A green checkmark vs. a yellow "agree to disagree" badge? The "agree to disagree" outcome must not feel like failure.
20. **Convergence button — when does it appear?** Persistent in points rail? Only when ≥1 point is closed? Only when ≥3 points are closed? Convergence is never required, so the button shouldn't nag — but it should be findable when the user is ready.
21. **Output destination picker UX.** Modal flow with destination → template → preview → confirm? Or single-screen with all options visible? The picker is rare (often once per Panel); favor clarity over speed.
22. **The "Nothing" output option visibility.** It's first-class but quiet. Where does it live in the picker? At the top ("just close this panel — no output needed") or at the bottom as an escape hatch? My instinct: top, with framing that signals the conversation itself was the artifact.
23. **Synthesizer-proposed points UX.** When the synthesizer suggests points to track, where do they appear — inline in the points rail with "Track / Dismiss" actions, or in a separate "proposed" section, or as a toast notification? The risk is making the user feel like the AI is trying to take over the structure.

---

# APP B — Editorial Workspace

## 1. User goal

> *"Take me from 'I have an idea worth writing about' to 'I have a finalized GameMakers blog post ready to paste into Substack' in under 90 minutes of focused work, with my voice intact and my facts straight."*

The unit of work is a **Piece** — one canonical artifact (initially: a blog post / newsletter, since that's where Joseph wants to start).

**Current Phase 1A override from design review:** the first shipped workflow uses `Setup → Theme → Topic → Points → Research → Outline → Draft → Polish → Ship`. Setup replaces the older Stage 1.5 Set Targets concept for Phase 1A. The older five-stage framing below remains useful as the long-term Editorial Room mental model, but implementation should follow `05_DESIGN_BRIEF.md` and `04_BUILD_PLAN.md` for the current Phase 1A surface.

## 2. The seven stages (well, five required + two optional)

```
                                                          ╔════════════╗
                                                          ║ 3.5 OPTIM. ║
                                                          ║ (autonovel ║
                                                          ║  iteration)║
                                                          ╚═════▲══════╝
                                                                │ optional
┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌──┴──────┐  ┌──────────┐
│ 1. IDEAS │─▶│1.5 TARGET│─▶│ 2. RESEARCH  │─▶│ 3. DRAFT │─▶│4. REVIEW│─▶│ 5. SHIP  │
│ (backlog)│  │(personas)│  │ (outline +   │  │ (compose │  │ (AI +   │  │ (export) │
│          │  │          │  │  claims)     │  │  + write)│  │  human) │  │          │
└──────────┘  └──────────┘  └──────────────┘  └──────────┘  └─────────┘  └──────────┘
     │             │              │                │             │            │
     ▼             ▼              ▼                ▼             ▼            ▼
  Idea       Personas +    Research Brief +    Outline +    Suggestions   Markdown
  Backlog    Pipeline      Claims Ledger       Tiptap       accept/reject copy-out
  (cards)    (pick targets)(per-piece)         editor +     + Score       (Substack)
                                               Score widget
```

Each stage is a recognizable surface with its own affordances. **Five required, two optional.** Stage 1.5 (Set Targets) is a small modal between Ideas and Research. Stage 3.5 (Optimize) is a full-screen surface that takes a draft and iterates against the scoring pipeline; the user can skip it entirely (manual write-and-edit) or run it to convergence (autonovel-pattern automated iteration). Stage transitions are explicit user actions, not implicit "the AI moved you forward."

**Stage 1.5 (Set Targets)** is a small, explicit action between Ideas and Research. The user picks 1–3 target personas and (optionally) overrides the default scoring pipeline. This is the single most important moment for the iteration loop — without target personas, the loop has no defined optimization metric. Defaults are pre-filled based on the Idea's themes; the user can accept defaults in two clicks.

**Stage 3.5 (Optimize)** is the autonovel-pattern automated-iteration stage. Optional but visible — users see it in the diagram and know it's there. Detailed in §2.4.5 below. Two valid paths through Editorial Room: **Manual** (Draft → skip Optimize → Review) and **Autonovel-style** (Draft → Optimize → Review with the converged best variant). Both end at Review, where the human is always the gate.

### 2.1 Stage 1 — Ideas

**Goal:** maintain a backlog of candidate angles, seed it both manually and automatically, pick the next one.

**Inputs:** `themes`, `back_catalog`, `industry_signal`, `reader_signal` pages.
**Skill that powers it:** `factory_idea_generator` (scheduled Monday 06:00 + manual trigger).

**Surface:** the **Idea Backlog** — a Kanban-light board with three columns: `Inbox` (newly generated, unreviewed), `Shortlist` (picked for next ~4 weeks), `Archived` (rejected or used).

**Each Idea Card has:**
- Working title (1 line)
- Thesis (1–2 sentences)
- Why now (1 sentence)
- Format fit chips (newsletter | podcast | YouTube)
- Source links (industry articles, reader emails, prior posts)
- Novelty score (0–1, against `back_catalog` 60-day window)
- Confidence score (judge-model confidence in the angle)
- "Open" → moves to Stage 2

**User actions:**
- "+ Add idea" — manual entry, opens a small composer modal.
- "Generate ideas now" — fires `factory_idea_generator` on demand.
- Drag between columns.
- Merge duplicates.
- Click a source link → opens the underlying `industry_signal` page.

**Critical UX detail:** ideas should look like cards a human wrote, not like LLM JSON dumps. Real headlines, not "Idea about X." The Skill prompt explicitly instructs for headline craft.

### 2.1.5 Stage 1.5 — Set Targets

**Goal:** define who this piece is aimed at and how it will be scored. The single moment that gives the iteration loop a target.

**Inputs:** the picked Idea (carries its themes), the substrate's `persona` page library, the substrate's `scoring_pipeline` library.

**Surface:** a small modal or inline action triggered by "Open" on an Idea. Two sections:

```
┌─ Set Targets for "AI tutorials hurt indies" ─────────────────────┐
│                                                                  │
│  Audience  (pick 1–3)                                            │
│    [✓ @Ankit]  [✓ @Sarah]  [ ] @Marco  [ ] @Priya  [ ] @Tom      │
│    [ + new persona ]                                             │
│                                                                  │
│  Scoring pipeline                                                │
│    Default ▾  (gamemakers_default — Mech + Judge)                │
│    Or pick: audience_targeted_iteration, voice_protective, …      │
│    [ Edit pipeline... ]                                          │
│                                                                  │
│              [ Cancel ]   [ Use defaults — go to Research → ]    │
└──────────────────────────────────────────────────────────────────┘
```

**Defaults flow:**
- Personas: pre-checked based on the Idea's themes (e.g., Idea tagged `indie_dev_economics` pre-selects Ankit + Sarah). User can override with two clicks.
- Pipeline: the user's default pipeline (`gamemakers_default` ships pre-configured); per-channel default overrides apply (newsletter vs. podcast vs. youtube). User can swap.
- The "Use defaults" button is the fast path — accepts everything and moves to Research.

**User actions:**
- Pick personas (chip selector, multi-select).
- (Optional) Pick scoring pipeline (single-select dropdown).
- (Power users only) "Edit pipeline..." opens the Scorer Library page.
- "Use defaults" → moves to Stage 2.

**Critical UX detail:** this stage is small *because it has to be*. If picking targets feels like work, users will skip it and the iteration loop will be unanchored. Defaults must be smart enough that "click into the Idea, click 'use defaults', be in Research 5 seconds later" is the dominant path. Power users who want to tune find the controls easily.

The picked targets and pipeline are persisted on the Piece. They're visible (and re-editable) at the top of every subsequent stage as a "Aimed at: @Ankit @Sarah · Pipeline: gamemakers_default" chip rack.

### 2.2 Stage 2 — Research

**Goal:** turn an angle into a defensible point of view with sources.

**Skills that power it:** `factory_research_brief` then `factory_outline`.

**Surface:** the **Brief & Outline view** — a two-pane layout. Left: `claims_ledger` (sourced facts vs. inferences vs. open questions vs. counterarguments). Right: `outline` (per-format outline with section-level claims and hook options).

**Outputs of this stage:**
- A `claims_ledger` page in rocketorchestra, attached to the Piece.
- An outline document attached to the Piece, with hook options.
- Optional: a Panel Talk auto-launched from the outline ("Debate angle X with this outline as context") for editorial gut-check before drafting.

**User actions:**
- Edit any cell in the claims ledger inline (this is fact-checking, not prose-writing).
- Reject open questions (mark "won't address") or promote them to draft sections.
- Pick which hook to use.
- "Send to Draft" — moves to Stage 3 with outline + claims as system context.

**Critical UX detail:** the user *must* see the claims ledger before drafting. The visual separation between "this is sourced" and "this is the model's inference" is the anti-hallucination guardrail. Don't let the user skip this; it should feel like opening a research notebook before opening a writing pad.

### 2.3 Stage 3 — Draft

**Goal:** compose the actual blog post. This is where the user spends most time.

**Skills that power it:** `factory_draft` for the initial generation; then manual writing in the Tiptap editor.

**Surface:** the **Draft Composer** — a three-pane layout (responsive collapses to two on narrow):

```
┌─────────────────┬────────────────────────────────┬──────────────────┐
│  CONTEXT RAIL   │       TIPTAP EDITOR             │  SKILLS RAIL     │
│  (left, 240px)  │       (center, fluid)           │  (right, 280px)  │
│                 │  ────────────────────────────── │                  │
│  Voice: ...     │  Targets: @Ankit @Sarah         │   ┌────────────┐ │
│  Outline:       │  Pipeline: gamemakers_default ▾ │   │Adversarial │ │
│  ├ Hook         │  ────────────────────────────── │   │Cut         │ │
│  ├ Setup        │                                 │   └────────────┘ │
│  ├ Payoff       │   # The Title                   │   ┌────────────┐ │
│  ├ Takeaway     │                                 │   │Reader Panel│ │
│  Claims (12)    │   Lede paragraph...             │   └────────────┘ │
│  Sources (5)    │                                 │   ┌────────────┐ │
│                 │   Body paragraph 2...           │   │Opus Review │ │
│  Personas       │                                 │   └────────────┘ │
│  ├ @Ankit       │   ## Subhead                    │   ┌────────────┐ │
│  ├ @Sarah       │                                 │   │Score Now   │ │
│                 │   ...                           │   └────────────┘ │
│                 │  ┌── Score widget ────────────┐ │   ┌────────────┐ │
│                 │  │ Aggregate: 7.8 ●●●○○        │ │   │Iterate to  │ │
│                 │  │ Mech: clean (penalty 0.5)   │ │   │Score ▶     │ │
│                 │  │ Judge: 8.2/10 (voice 9, …) │ │   └────────────┘ │
│                 │  │ SSR: @Ankit 4.1 @Sarah 3.6 │ │                  │
│                 │  │ [...details]                │ │                  │
│                 │  └────────────────────────────┘ │                  │
└─────────────────┴────────────────────────────────┴──────────────────┘
```

**Editor behaviors:**
- Markdown source mode + WYSIWYG mode toggle.
- Voice lock banner at top (clickable → opens `voice` page in sidesheet).
- Inline mechanical scorer: red/yellow underlines on slop matches (banned-word patterns, sentence-opener repetition, hedge density).
- Auto-save on every meaningful pause; saves are revisions in `talk_output_revisions`.
- Slash commands: `/cut` (run adv_cut on selection), `/score` (run scorer on selection), `/cite` (insert citation from claims ledger), `/consult` (momentary panel fan-out — see below).
- Selection menu: Bold, Italic, Link, Cite, **Consult Panel on this paragraph**.

**Momentary panel fan-out (the loose Panel-Talk-as-primitive affordance).**
Selecting "Consult Panel on this paragraph" opens a slim side-sheet that runs *one panel turn* against a curated set of agents (default = "Editorial Workshop" preset) on the selected text. The result renders as columns inside the side-sheet. This is **not** a saved Panel — it's a one-shot consultation using the substrate's `enqueueTalkTurnAtomic` primitive directly. The user can:
- Read the columns inline.
- Promote one column's wording back into the editor as an inline suggestion.
- "Save as Panel Talk" — promotes this one-off into a real Panel Talk session for follow-up. (One-way; the side-sheet doesn't sync back if the user keeps writing.)

This is the cleaner architecture: the editor uses panel fan-out as a primitive, but it doesn't *contain* Panel Talk and doesn't open a Panel Talk session unless the user explicitly asks for one.

**Skills rail behaviors (Stage 3):**
- Each Skill button opens an inline modal showing inputs, expected runtime, expected cost. Click "Run" → fires `run_skill` MCP tool.
- Result appears as a banner below the editor (e.g., "Reader Panel returned 4 reports — view") OR as inline suggestion popovers (e.g., adv_cut places `Suggestion[]` highlights).

**Score widget behaviors (Stage 3):**
- Sits below the editor, collapsible. Default-collapsed if user hasn't run a manual score yet; default-expanded after first score.
- **Manual score** — "Score Now" button runs the configured pipeline once. Cost preview shown before running. Result populates the widget. Cost incurred goes to `runs.cost_usd`.
- **Aggregate display** — top line shows aggregate score with a color band (red ≤ 5.5, yellow 5.5–7.5, green ≥ 7.5 by default; thresholds editable). Hover for tooltip explaining which scorers contributed and at what weight.
- **Per-scorer breakdown** — inline strip showing each scorer's name + scalar (Mech: 0.5 penalty / Judge: 8.2 / SSR: per-persona). Click a scorer to expand its full result (per-dimension scores, raw notes, model used, cost, latency).
- **Per-persona breakdown** (when SSR or persona-aware scorers ran) — Ankit: 4.1, Sarah: 3.6, etc. Color-coded against the per-piece target threshold. **Color is per-persona, not just aggregate** — a piece can be green for Ankit and red for Sarah, and the user must see that asymmetry.
- **Pipeline override (per-piece)** — small "..." menu next to "Pipeline: gamemakers_default" lets the user swap pipelines for this specific piece without affecting their default. Re-runs score on swap (with cost preview).
- **"Send to Optimize ▶"** button (alternative to "Send to Review") — moves to Stage 3.5 (Optimize) where the system iterates against the scoring pipeline until convergence or plateau. See §2.4.5. The button is co-equal in placement with "Send to Review" — explicit choice between manual continuation and automated iteration.
- **Score history** — clicking "history" opens a side panel showing every revision's score side-by-side with significance markers (Welch t-test results when SSR was used). User can revert to any prior revision.

**Critical UX detail:** never display a single mystery aggregate. Every score the user sees breaks down on click into the contributing scorers, and every scorer breaks down into its per-dimension or per-persona detail. "Mystery numbers" erode trust faster than any other UI mistake.

**User actions in Stage 3:**
- Click "Generate first draft" if outline is set → fires `factory_draft`.
- Write/rewrite manually.
- Run Skills.
- Accept/reject/edit suggestions.
- "Send to Review" — moves to Stage 4.

**Critical UX detail:** the user must be able to write without AI help if they want to. The Skills rail is opt-in. Nothing the AI does happens automatically except auto-save. Martin's voice in the strategy doc — "make it disappear when working" — is the design rule here.

### 2.4.5 Stage 3.5 — Optimize (optional)

**Goal:** let the system iterate the draft against a scoring pipeline + persona targets until convergence (or plateau, or max attempts) — the autonovel pattern made into a first-class workflow stage. Optional. Manual users skip it entirely.

**When the user enters this stage:** they have a Stage 3 draft they're not done with — but rather than continue editing manually, they want to see what the system can do given the targets and pipeline they configured at Stage 1.5. They press "Optimize ▶" and the loop runs.

**Skills that power it:** `factory_iterate_to_score` runtime (orchestrates the loop), which calls `factory_opus_review` for revision briefs, `factory_draft` (or `factory_revision`) to apply revisions, and the configured `scoring_pipeline` to evaluate each variant.

**Surface:** the **Optimize Watcher** — a full-screen surface with three regions:

```
┌────────────────────────────────────────────────────────────────────┐
│  Optimizing: "AI tutorials hurt indies"                            │
│  Targets: @Ankit @Sarah  ·  Pipeline: gamemakers_default            │
│  Config: max 5 attempts, plateau Δ 0.3, threshold ≥4.0              │
│  ──────────────────────────────────────────────────────────────────│
│                                                                    │
│  ┌── Progress ──────────────────────────────────────────────────┐ │
│  │  Attempt 3 of 5         elapsed 2m 14s         cost so far $0.62│ │
│  │  ●●●○○                                                        │ │
│  │                                                                │ │
│  │  Current: scoring revision-3 against @Ankit, @Sarah...        │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ┌── Best so far (revision 2) ────┬── Current candidate (rev 3) ──┐│
│  │  aggregate: 7.4 (yellow)        │  aggregate: scoring...         ││
│  │  @Ankit: 4.0  @Sarah: 3.7       │                                ││
│  │  [show diff vs original]        │  [show diff vs revision 2]     ││
│  │                                  │                                ││
│  │  changes: tightened intro,      │                                ││
│  │  specified the SEO mechanism,   │                                ││
│  │  cut tangent on tutorial pricing│                                ││
│  └─────────────────────────────────┴────────────────────────────────┘│
│                                                                    │
│  [ Accept best so far → Review ]  [ Continue iterating ]  [ Stop ] │
└────────────────────────────────────────────────────────────────────┘
```

**Watcher behaviors:**
- **Live progress:** stepwise visual showing current attempt out of max, elapsed time, cost-so-far. Per-attempt streaming as each Skill in the loop runs (drafting, scoring).
- **Best-so-far always visible:** every successful iteration updates the "best so far" panel with score breakdown, persona deltas, and a click-through diff vs. the original. The user can see the trajectory.
- **Current candidate visible:** as a new revision is being generated and scored, it streams in alongside the best-so-far for live comparison.
- **User can interrupt at any time:** "Accept best so far → Review" jumps straight to Stage 4 with the highest-scoring revision selected. "Stop" halts the loop and returns the user to Stage 3 with all revisions preserved in history.
- **Convergence trigger:** the loop runs until the configured `iteration_config` says stop — threshold met, plateau detected, or max attempts hit. On convergence, the best variant is selected automatically and the user is prompted "Convergence reached at attempt 4. Aggregate score 7.9. Send to Review?" — single-click yes, but the user can also click into earlier revisions to override.
- **Cost meter:** running total visible always. Configurable hard cap per piece (default $5) — when hit, loop pauses and asks user to confirm "$5.00 spent so far. Continue iterating?"
- **Pause and resume:** user can pause mid-loop (e.g., "I want to look at this more carefully before another attempt"). Resume picks up from where the loop left off, using the existing `goal_state` + `run_events` resumability the substrate already provides.

**Critical UX principle — aggressive in generation, conservative in applying.** The system can produce many candidate revisions quickly; it must NEVER overwrite the canonical draft. Every candidate lands as a new `talk_output_revision` row, fully reverable. The user is in control of the loop, not watching it work autonomously. Auto-iteration is opt-in per piece, the watcher always shows what's happening, every attempt is preserved (so nothing is lost), and Stop is one click away. This is the autonovel pattern made transparent: not a black box that produces a draft, but a visible iteration the user can drop into at any point.

**Five rewrite modes available** (per `01_ARCHITECTURE.md` §15.8):
1. **Suggest only** — one scorer pass, inline accept/reject popovers; default for Stage 3.
2. **Rewrite selected passage** — targeted revision Skill on a user-selected range; new revision; user accepts.
3. **Generate full-draft candidate** — `factory_draft` re-run; user picks vs. current.
4. **Optimize loop** — what Stage 3.5 runs; iterate-to-score until threshold/plateau/max.
5. **Autonomous-until-cap** — same as Optimize loop, runs unattended until threshold OR cost cap OR plateau; background notification.

Editorial v1 ships modes 1, 3, and 4. Modes 2 and 5 are Phase 2+.

**What happens after Optimize:** the chosen variant moves to Stage 4 (Review). The full revision history (every attempt the loop produced) is preserved and visible in Stage 4's history panel — the user can compare any iteration against the final selection if they want to second-guess the loop's pick.

### 2.5 Stage 4 — Review

**Goal:** systematically catch what the user can't catch alone — voice drift, weak structure, factual gaps, hedge density, missed counterarguments.

**Skills that power it:** `factory_reader_panel`, `factory_opus_review`, `factory_voice_drift_check` (this last one for trend, not per-piece).

**Surface:** **Review View** — the editor pane on the left, a Review report panel on the right. The Review panel renders Skill outputs as actionable items.

**Review panel composition:**
- **Score widget** (same as Stage 3, expanded by default) — full pipeline result with per-scorer + per-persona breakdown, plus iteration-history side panel.
- **Reader Panel report** (one-page diagnostic from `factory_reader_panel` Skill) — collapsed by default, click to expand. **This is the qualitative complement to the SSR scorer's quantitative output** — the Reader Panel surfaces *consensus disagreements between personas* (e.g., "Ankit and Sarah disagree on whether the lede earns the payoff"), which is editorial signal that pure scoring can't replicate.
- **Opus Review** — list of items, each with severity (major / moderate / minor) and a [Accept] / [Reject] / [Edit] action. Accepting writes a new revision; rejecting marks resolved with reason. After accept/reject, the score widget auto-re-scores against the new revision so the user can see whether the change improved the score.
- **Voice drift status** (if `factory_voice_drift_check` has run on the user's last 4 published pieces) — a small "voice integrity" badge with a link to the Friday Voice Report.

**Stop condition:** the user marks the Piece "Approved" when ready. Optional gate: configurable per-user threshold (e.g., "must hit aggregate score ≥ 7.5 before Approve unlocks"). **Score is never a hard gate by default** — the user is always the gate. Soft warnings are fine; lockouts are not.

**Capture to context (on Approve).** When the user marks Approved, an inline modal asks: "Promote any of this piece's claims/decisions to durable context?" — preselects high-confidence accepted `claims_ledger` entries that look like generalizable `domain` knowledge (e.g., "Steam algorithm gives 60-day discoverability windows" → suggests promoting to `domain/steam-algorithm`). Modal also offers to register the piece itself as a `back_catalog` entry (this happens automatically on publish; the modal just confirms the metadata). User can dismiss with one click. The aim: every published piece adds one or two durable entries to the user's accumulated knowledge, so next time they write about Steam the prior take is grounded automatically. Suppressed if the piece was authored entirely in `Ephemeral` privacy mode.

**Critical UX detail:** the user should be able to bounce between Stage 3 (write) and Stage 4 (review) freely. Don't lock the editor when in Review mode; the review report just hovers next to the editable draft.

### 2.6 Stage 5 — Ship

**Goal:** get the finalized Piece out of the system into wherever the user actually publishes it (Substack v1).

**Skills that power it:** none required for blog v1; future stages add `factory_podcast_script`, `factory_audio`, `factory_thumbnail`.

**Surface:** the **Export Pane** — shows the final markdown rendered both as source and as preview, with format-shaped export buttons:

- **Copy as Markdown (Substack-flavored)** — handles Substack's image syntax, link handling, footnote style. Single-click clipboard write.
- **Copy as Markdown (plain)** — universal markdown.
- **Download .md file**.
- (Future) **Generate Podcast Script** → opens Stage-3-equivalent for the audio version.
- (Future) **Generate Thumbnail Concepts** → opens fal.ai-rendered image grid with promote-to-final action.

**Side-effect on Approve:** the Piece's final revision is pushed to rocketorchestra `pages` as a `back_catalog` entry. This is what closes the loop — every piece you ship becomes context for the next idea generation cycle. The final revision is also tagged with `published_at` (manually set by the user when they paste into Substack) for accurate reader-feedback timing.

## 3. Information architecture

App B's primary navigation:

```
Editorial Workspace
├─ Today           ← dashboard: pieces in progress, scheduled briefs, recent runs
├─ Ideas           ← Idea Backlog (Stage 1)
├─ Pieces          ← list of all Pieces, filterable by stage/status/channel
│   └─ /pieces/:id  ← single Piece, opens at the current stage
├─ Sources         ← context pages: voice, themes, audience, back_catalog, episode_bible
├─ Skills          ← catalog of available Skills, with stats (cost, run count, accept rate)
└─ Settings        ← provider keys (proxied to rocketorchestra), schedules, voice page
```

**The Today screen (zero-state for daily use):**
- "Today's Brief" hero card: latest `factory_idea_generator` output (5 ideas, top novelty/relevance/hook).
- "In progress" strip: pieces in Stages 2–4 with last-touched time.
- "Awaiting your review" strip: pieces in Stage 4 with unresolved Opus Review items.
- "This week's voice integrity" strip: Friday `voice_drift_check` report.

This is the screen Joseph opens at 8am Monday. It should *demand nothing* and *invite one action* (open the brief).

## 4. Worked example — the user's Monday

A literal walk-through of one piece, end to end, to make the workflow concrete:

**Monday 08:00.** Joseph opens Editorial Workspace → Today. Brief lands ("Five angles for this week"). Angles include: "Why solo devs are overestimating AI's effect on marketing," "Steam algorithm shifts in Q1 2026 — what indies need to know," "The case for AI playtesting (and three serious caveats)."

**08:05.** He clicks angle #3 → moves it to Shortlist → opens it. Now in Stage 2 / Research.

**08:10.** `factory_research_brief` runs (~30s). Returns: claims ledger with 6 sourced facts (3 from past back-catalog, 3 from industry signals from last week), 4 model inferences, 2 open questions, 3 counterarguments. Outline pane shows newsletter outline with two hook options.

**08:18.** He fact-checks the ledger inline — corrects one inference that's actually a sourced fact (he wrote about it 6 months ago), promotes one open question to a draft section, picks Hook B. Clicks "Send to Draft."

**08:22.** Stage 3 / Draft opens. He clicks "Generate first draft." `factory_draft` runs (~45s). 1,100-word v1 lands in the Tiptap editor, voice score 7.4, slop score 2 cautions.

**08:25–09:15.** He writes. Cuts the AI's lede, replaces with his own anecdote about Heart's Desire's playtest cycle. Restructures middle. Edits transitions. Voice score climbs to 8.6. Slop score drops to 0.

**09:18.** Clicks "Adversarial Cut" Skill. 11 suggestions return. Accepts 4, rejects 6, edits 1. Length drops 8%.

**09:25.** Clicks "Send to Review." `factory_reader_panel` + `factory_opus_review` fire in parallel (~90s combined). Reader Panel returns: Editor persona thinks the payoff is too soft; Indie Dev persona loves the anecdote; AAA Producer persona says the caveats are well-balanced; Skeptic persona flags one unsupported superlative.

**09:30.** Joseph reads the panel report, agrees with the Editor — strengthens the payoff. Opus Review returns 3 items: 2 wording, 1 structural. He accepts both wording suggestions; the structural item he disagrees with and rejects with reason "I want this implication left implicit."

**09:42.** Clicks "Approved." Rev count: 14. Total Skills runs: 5. Total cost: $0.71.

**09:43.** Stage 5 / Ship opens. Clicks "Copy as Markdown (Substack-flavored)." Pastes into Substack. Adds a header image (manual). Schedules for Tuesday 7am send.

**09:48.** Closes the laptop. Total focused time: 1 hour 48 minutes. Manually-written baseline for a similar piece: ~3 hours. **Lift: ~40%, voice intact.**

Approve also pushed a `back_catalog` entry to rocketorchestra. Next Monday's `factory_idea_generator` won't propose a redundant angle.

## 5. The starter agent roster (for embedded Panel use inside App B)

When App B fires a `Reader Panel` Skill or auto-launches a Panel for editorial gut-check, these are the persona slots. Each is a row in `registered_agents` with system prompt + role.

| Agent | Role |
|---|---|
| **Editor-in-Chief** | Owns final voice/structure judgment. Asks: does this earn its length? |
| **Market Analyst** | Evaluates business framing, comparable cases, monetization tradeoffs. |
| **Developer Advocate** | Speaks for working dev studios. Flags advice that's detached from production. |
| **Monetization Strategist** | Economy/IAP/ads/subscription tradeoffs. |
| **Platform Analyst** | Steam, mobile, console, app stores, discovery. |
| **Skeptical Contrarian** | Challenges weak assumptions and unsupported claims. |
| **Newsletter Editor** | Improves prose, transitions, reader value. |
| **Podcast Producer** | (For audio repurposing) optimizes flow and retention. |
| **YouTube Packaging Editor** | Hook, title, thumbnail, opening 30s. |
| **Research Librarian** | Maintains claims ledger honesty. |
| **Final Synthesizer** | Combines panel outputs into a single recommendation. |

Each is `(provider, model, system_prompt)` configurable. Default model assignment biases toward Opus for judgment-heavy roles (Editor-in-Chief, Synthesizer) and Sonnet/GPT/Gemini for opinion-heavy roles (panelists). User can swap.

## 6. Critical UX principles (the load-bearing decisions)

These are the principles I'd flag for Claude Design as non-negotiable in the surface design:

1. **Stage clarity always.** Every screen tells you what stage you're in and what's next. No "where am I" moments.
2. **Skills are opt-in.** No auto-firing on save. Every AI mutation requires an explicit human "run" or "accept."
3. **Voice protection is visible.** The voice page is one click away from any Stage 3+ screen. Voice score is always visible during write.
4. **Claims separation is mandatory.** The user cannot reach Stage 3 without seeing the claims ledger. Don't let speed override factuality.
5. **Suggestions are atomic.** Accept/reject/edit per item; no "apply all." The discipline is the point.
6. **Cost is visible per run.** Don't surprise the user with monthly bills.
7. **The factory must lose to the human when they disagree.** Reject is a first-class action; accepted is the special case.
8. **The first draft is never the artifact.** The final draft after revision and review is the artifact.

## 7. Open design questions for Claude Design

Numbered for easy reference in design iteration:

1. **Three-pane Stage 3 layout density.** Is 240px context + fluid editor + 280px skills the right ratio on a 1440px laptop? On 1080p? On ultrawide?
2. **Suggestion popover style.** Inline tooltip? Side rail line item? Full modal? The choice trades signal density vs. read flow.
3. **Voice score display.** Dial/gauge, single number, color bar? The score must feel like a writing instrument, not a grade.
4. **Stage transitions — gated or free?** Should "Send to Draft" be allowed without a complete outline, or should it require all sections filled?
5. **Idea Backlog visual style.** Kanban (drag columns), list (compact), or card stream (one card focused at a time)?
6. **How to render `claims_ledger` non-tabularly.** Table feels like spreadsheet; cards feel like Notion. Both are right for different cognitive modes.
7. **Momentary panel side-sheet design.** "Consult Panel on this paragraph" opens a slim side-sheet running one panel turn (not a saved Panel Talk session). What's the visual relationship between the side-sheet columns and the editor selection? How does promote-back-to-editor work — drag, click, or accept-as-suggestion? When does the side-sheet close — auto on dismiss, or persist until explicitly closed?
8. **The Today screen layout.** It's the daily zero-state, so it has to be calm but informative. What's the right hero treatment?
9. **Mobile.** Read-only view of a Piece in any stage. Prioritize: which stage matters most on mobile? My guess: Today + the latest Brief, plus Stage 4 review with reject-only actions.
10. **The "no AI" mode.** Should there be a mode where Skills are hidden entirely? For a writer in flow who wants pure editor?
11. **Score widget density.** Aggregate-first with progressive disclosure (click for breakdown), or always-show all dimensions? My instinct: aggregate-first with one-click expand; users who want the full breakdown find it instantly, users who don't get a calm number.
12. **Per-persona color asymmetry.** When SSR shows Ankit: 4.1 (green) and Sarah: 3.6 (yellow), the visual treatment should make the asymmetry obvious. A side-by-side color strip per persona? Mini bar chart? The user has to *notice* when one audience is being lost.
13. **Iterate-to-Score progress UX.** During an automated iteration loop, the user is waiting (potentially 60–120s per cycle). What do they see — a stepwise progress visual ("Attempt 3/5 — score 7.2 vs. 7.4 best so far"), a pause-and-watch transcript of revisions happening, or just a spinner with a final report? My instinct: stepwise visual with current best so far always visible.
14. **Score-history side panel.** When comparing revisions, what's the diff treatment — score deltas only, or full prose diff with score deltas alongside? How are statistically-non-significant changes (Welch t-test fail) marked vs. significant ones?
15. **Pipeline override discoverability.** The "Pipeline: gamemakers_default ▾" chip in Stage 3's editor — visible enough that power users find it easily, calm enough that casual users ignore it. Where does it live and how is it styled?
16. **Set Targets defaults aggressiveness.** When the user opens an Idea, how aggressive should we be at pre-checking personas based on the Idea's themes? Pre-check 2 obvious matches and let the user override, or show all unchecked and require explicit selection? Two-click "use defaults" path matters here.
17. **Score as soft warning vs. visible reminder.** When a piece is below the user's configured target score and they click "Approve," what happens — proceed silently, soft confirmation modal, or block? My instinct: soft confirmation for first time per piece, then proceed silently.

## 8. Out of scope for App B v1

- Podcast scripts and audio (Stage 5 placeholder; ship in v2).
- YouTube scripts and thumbnails (v2).
- Direct Substack API publishing (manual paste forever, until the API improves).
- Multi-user collaboration on a single Piece.
- Comments / notes from a separate reviewer.
- Advanced analytics ingestion (read-rate feedback) — v3.

---

# 9. How the two apps share infrastructure

Both apps consume the substrate documented in `01_ARCHITECTURE.md`. Specifically:

| Capability | Panel Talk uses | Editorial Room uses |
|---|---|---|
| Multi-agent fan-out (`enqueueTalkTurnAtomic`) | yes — core | yes — Reader Panel Skill + momentary editor consultations |
| Provider key vault (`/api/distribute/fetch`) | yes | yes |
| Provider transparency metadata (knowledge cutoff, retention class, web search availability) | yes — surfaced as badges | yes — surfaced minimally in Stage 3 momentary consults |
| MCP context (`query_context`, `get_page`) | optional per panel — Persistent panels can attach context pages on demand; Incognito disables grounding | yes — `voice`, `themes`, `claims_ledger` always grounded |
| `panel_presets` table (preset library) | yes — primary consumer | yes — for momentary consult presets |
| `talk_outputs` + revisions | optional, only for saved persistent panels | yes — drafts (the canonical artifact) |
| Tiptap editor | no | yes — Stage 3 |
| Skill runtimes (`factory_*`) | none directly (Synthesize is a panel-internal action, not a Skill) | many |
| Inline mechanical scorer | no | yes |
| Inbox / propose_update | optional — only when user explicitly proposes a context-page update from a panel | yes — for `voice` drift, `themes` updates |
| Cron schedules | no | yes — `factory_idea_generator` Monday, `factory_voice_drift_check` Friday |

**Cross-app affordances (loose, intentional, minimal):**
- **Panel Talk → Editorial Room:** "Promote to Editorial Draft" CTA hands a synthesis or single-column response over as a Stage-1 idea seed (or a Stage-3 draft seed). One-way; the originating panel stays in Panel Talk.
- **Editorial Room → momentary panel:** "Consult Panel on this paragraph" runs a single panel turn in a side-sheet using substrate primitives directly. **Does not open Panel Talk.** "Save as Panel Talk" inside the side-sheet promotes a one-off into a persistent Panel Talk session — at user's explicit request only.
- **Shared substrate, separate state and navigation initially:** the apps share provider routes, the preset library, the `voice` page (when explicitly attached), and all substrate primitives (scorers, personas, page types, exporters). They do **not** share talk lists, navigation, or session state. Each app has its own panel list. The cleaner conceptual boundary; if usage signal shows users want a unified "Recent Thinking" view across apps, add it as a substrate-level later phase.

# 10. Phasing recommendation

**Build order principle: Editorial Setup + portfolio is the first proof loop.** Substrate ships what the Phase 1A workflow needs to define a target, score themes/topics/points, capture notes, build an outline, draft, polish, and export. Substrate phases are detailed in `01_ARCHITECTURE.md` §12; this section lists the *app phases* that consume them.

### Phase 0 — Decisions and contracts (no engineering hours)

Lock the decisions in `01_ARCHITECTURE.md` §12 Phase 0 before any app code: editor canonical format (JSON + Markdown snapshot), cloud-default, BYOK, separate v1 navigation, Setup before Theme, and first Phase 1A export targets are Markdown copy/download + Substack-flavored Markdown. Context modes, momentary semantics, Incognito implementation, and Google Docs export stay in the architecture but are deferred until the core flow is stable.

### Phase 1A — Editorial Room Setup + portfolio proof loop (the first thing that ships)

**Scope:** the smallest surface that lets Joseph configure the target, select/build a theme, score/select a topic, create points, capture point notes, build an outline, draft, polish, and export publishable Markdown. See `05_DESIGN_BRIEF.md` for the UI details.

- Setup screen: deliverable type, voice/length/destination, audience personas, LLM agent profiles, scoring system.
- Theme/Topic workspace: three panels, Themes / Topics / scoped LLM Discussion.
- Points workspace: three panels, Points / typed freeform Notes / scoped LLM Discussion.
- Score badges on themes/topics/points.
- **Single-call cheap mode** (proposes 3–8 candidates in 5–15 sec, ~$0.10–$0.50): actions like `Propose topics`, `Propose points`, `Research this point`. Path of least resistance for quick ideation.
- **Optimization rounds** (per `OPTIMIZATION_LOOP.md`): actions like `Optimize topics`, `Optimize points`, `Optimize outline`. Multi-iteration runs returning top-K candidates with rubric breakdown, per-persona SSR distributions, and diversity-reserved slots. ~$2–$5 per round for Topic. The differentiated product feature.

### 2.X — Optimization Rounds: UX patterns

Optimization rounds are surfaced at every editorial layer (Theme, Topic, Point, Outline, Draft). They have four UX states. The same patterns apply to all target kinds with per-kind copy variation.

**State 1 — Pre-launch confirm.** Before kicking off, the user sees a `CostPreviewCard` with: estimated cost (`$3.40 ± 30%`, calibrated from past similar runs), estimated wallclock (`~6m 15s`), and the round configuration (`20 candidates × 3 iterations × 8 SSR samples × 3 personas`). User can edit `n_candidates`, `n_iterations`, `n_personas`, `budget_usd cap`. For all target kinds except `draft_fullsearch`, the user clicks `Start optimization` and the round launches. For `draft_fullsearch` only — regardless of estimated cost — a mandatory double-confirm modal appears: *"This run is expected to cost ~\$245 and may take ~32 minutes. [ ] Confirm. [Start]"*. Other target kinds skip the double-confirm; users who want tighter cost guarantees set the `budget_usd` cap.

**State 2 — Mid-run progress.** A `RunProgressBar` shows: live cost-so-far, projected-actual (continuously recalibrated), current iteration count (`Iter 2 of 3`), current phase (`generating` / `rubric_judging` / `ssr_scoring` / `counter_audience` / `ranking` / `merging_subloops`). Partial-provider failures surface as a non-blocking badge. A `Cancel` button is always visible. Cancellation completes the current candidate's gates, preserves the acceptable pool, and routes the user to the partial top-K view.

**State 3 — Completed top-K.** Returns a ranked list (default 5; 10 for Theme; 8 for Point; 3 for Outline; 3 for Draft polish). Each candidate is a `ProposalCard` showing: composite score, per-axis rubric breakdown with gap quote and fix recommendation, full SSR PMF per primary persona with confidence (Shannon entropy), counter-audience objections (Drafts only), `comparable_history` ("scores higher than 73% of your shipped Topics under this Theme"), `diversity_position` ("most novel of top-5"). Diversity-reserved slots are explicitly labeled (`cohort-reservation` / `novelty-reservation`). The user picks one (Topic/Outline) or multiple (Points). A post-run report at the bottom shows convergence reason, cost actual vs estimate, and a reject-reason histogram (`18× specificity_lt_3, 12× diversity_lt_0_4, 9× disputability_lt_3`) — useful when no candidates make it to top-K and the user needs to diagnose tight gates.

**State 4 — Cancelled with partial pool.** Same shape as State 3 but explicitly labeled "Cancelled at iteration N." Top-K is built from candidates that completed all hard-gate scoring before cancel; partially-scored candidates are excluded. The user can still pick from the partial pool or re-launch with adjusted config.

**Cross-cutting UX rules:**
- *Cost transparency.* Every round's actuals are saved and used to calibrate future estimates. Users see "estimated cost vs past actuals" on every cost preview.
- *Editorial sovereignty.* All optimization rounds return top-K to the user. The user picks; the system never auto-adopts.
- *PCP-context disclosure.* When a Theme is `derived_from_pcp: true`, its ProposalCard shows the seed events (`2026-04-22: meeting with Hooded Horse re: indie deal terms`) so the user can audit what produced the suggestion. Default `scope: personal` until explicit promotion.
- *Settings → Optimization.* Power users can tune the diversity floor (default 0.4), per-Skill default `n_candidates`, `n_iterations`, `budget_usd`, and `top_k_returned` from a dedicated settings surface.
- Outline Builder fed by selected points, notes, scores, and evidence.
- Draft editor with Production Brief, Tiptap editor, and Skills rail.
- Polish mode with atomic suggestions.
- Manual export: Markdown copy, Markdown download, **Substack-flavored Markdown**.

**Exit criterion:** Joseph can configure a Piece, move from Theme to Topic to Points with scores and notes, build an outline, draft/polish, export Substack-flavored Markdown, and ship a real GameMakers piece without manual workarounds.

### Phase 1A.5 — Optimize Watcher + deeper scoring (after 1A is dogfooded)

**Scope:** the rest of the iteration story. ~1.5 weeks. Substrate adds: persona substrate + 5 starter personas, full claims ledger field schema, AutoNovel Judge scorer, `Scorer` interface, `iteration_config` (newsletter default), `factory_score` + `factory_iterate_to_score` Skills, `factory_research_brief` + `factory_outline` Skills.

App-side work:
- Deeper scoring pipeline management and score history.
- Score widget below the editor (per-scorer + per-persona breakdown).
- Stage 3.5 Optimize Watcher (live progress, best-so-far, current candidate, diff viewer, interrupt/stop, cost cap).
- "Send to Optimize ▶" co-equal with "Send to Review" in Stage 3.

**Exit criterion:** Joseph can run the full iterate-to-score loop on a draft, watch it work, accept the best variant, and see why each scorer scored what it did.

### Phase 1B — Editorial Room Stages 1, 2, 4 polish (after 1A.5)

**Scope:** ~1 week. Idea Backlog (port `BoardView` from rocketboard) + `factory_idea_generator` (cron). Brief & Outline view (Stage 2) consuming the claims_ledger schema added in 1A.5. Reader Panel review at Stage 4.

### Phase 1C — Editorial polish + scheduled briefs (after 1B)

**Scope:** ~1 week. Export pane (Stage 5) for podcast script + audio + thumbnail (deferred outputs). Cron-fire `factory_idea_generator` Monday + `factory_voice_drift_check` Friday. Today screen. SSR scorer vendored. Reader-signal Gmail trigger.

### Phase 2A — Panel Talk Core (slim MVP per §1–§3)

**Scope:** ~2 weeks. Slimmed per plan-review feedback to the actual MVP:
- Persistent panel list (per §4.1).
- General-purpose presets (5 starter presets only — General Reasoning, Devil's Advocate, Code Review, Career Coach, Personal Finance Council).
- Multi-agent fan-out (already shipped in clawrocket — Panel Talk just adds the `talk_kind = 'panel'` shape and the user-as-peer system prompts).
- Targeted reply to one column.
- Synthesize action.
- Cost visibility (preview before send + actual after).
- Markdown copy export.
- **Optional Incognito mode** with hard local-no-index/no-capture guarantees per `01_ARCHITECTURE.md` §5.3.

**Deferred from Phase 2A** (vs. earlier plans): Talking Points lifecycle, Convergence outline, Google Docs export, Editorial Draft promotion, panel-references-panel, private-mode filtering, scoring inside panels.

**Exit criterion:** Joseph uses Panel Talk for real decisions (sports, finance, code review, parenting, etc.) and returns to old panels.

### Phase 2B — Panel Talk richness (after 2A is dogfooded)

**Scope:** ~1.5 weeks. Talking Points lifecycle (Active / Closed-Agreed / Closed-Disagreed / Parked). Convergence outline action. Output destinations beyond Markdown (Google Doc, Editorial Draft promote). Branch from response. Panel-references-panel. Private-mode provider filtering.

### Phase 3 — Personal context capture and broader page types

**Scope:** ~1 week. The broader PCP page types (`person`, `decision`, `preference`, `domain`, `goal`, `tool`, `relationship`, `event` — `voice` / `themes` / `back_catalog` / `claims_ledger` already in earlier phases). `factory_propose_context_update` Skill. "Save to Context" action in both apps. Context Library page.

### Phase 4 — Outbound exporters (beyond ship-target Markdown)

**Scope:** ~0.5 weeks. `Exporter` abstraction. Markdown dump adapter (always-available, lossless, scheduled). Obsidian vault adapter. `external_export_target` page type. Scheduled `context_export` cron.

(Substack-flavored Markdown ships in Phase 1A as the primary publish export. Google Docs is deferred until after the setup + portfolio proof loop is dogfooded.)

### Phase 5 — Cross-app affordances

**Scope:** ~0.5 weeks. "Promote to Editorial Draft" CTA in Panel Talk → seeds an Editorial Room Setup/Theme/Topic starting point. "Consult Panel on paragraph" momentary fan-out side-sheet in Editorial Room Draft.

---

**Total realistic effort: ~11 weeks of focused engineering** — broadly similar to the prior estimate, but the *order* is meaningfully different. Editorial Setup + portfolio ships first as the proof loop. Panel Talk ships after Editorial has been dogfooded for a few weeks. Personal context broadens once both apps benefit from it. Substrate completeness is sequenced behind app demand rather than ahead of it.

---

# 11. Naming guidance (revised)

Given Panel Talk is now fully general-purpose, the prior "Editorial Room" umbrella doesn't fit. Two apps, two brands, no forced parent:

- **Panel Talk** stays as the working name. It's clear, neutral, ungimmicky, and reads well in any topical context (sports, finance, parenting, code, editorial). Domain candidates: `paneltalk.app`, `panel.chat`, `panels.fyi`. Avoid "AI" in the name — the product is multi-LLM but the user shouldn't have to explain that to themselves.
- **Editorial Room** stays for the creator workflow. Domain-coded; that's the point. Internal v1 brand can be GameMakers-flavored ("GameMakers Editorial Room"); decoupling is straightforward later.
- **No umbrella consumer brand.** The substrate (rocketorchestra) is engineering-facing. Two siblings, one substrate, no parent.

Marketing implication: when discussing externally, lead with the app the user came in for. Cross-mention the other only when relevant. The product is not "we make AI tools"; it is "Panel Talk lets you think with N frontier models" *or* "Editorial Room helps you ship publishable work." Two distinct value props.

---

*End of hero applications spec.*
