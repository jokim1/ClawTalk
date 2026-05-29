> **Status:** canonical (Forge design/interaction). Front-end mock; all scoring data simulated. Scope model (whole doc / tab / section) must reconcile with the PRD + tabs (DOC-AUDIT #3c).
> Precedence + orientation: [README.md](./README.md) · decisions: [DECISIONS.md](./DECISIONS.md) · terms: [GLOSSARY.md](./GLOSSARY.md).

# Forge — design handoff

Autonomous content improvement for ClawTalk. This doc is the
hi-fi, clickable design for **Forge** plus the design exploration behind it.
Everything is front-end only — all scoring data is simulated (see *What's
real vs mocked*). Use it as the visual + interaction spec for implementation
against the PRD ([`09-autonomous-content-improvement-prd.md`](./09-autonomous-content-improvement-prd.md)).

---

## Deliverables

| File | What it is |
|---|---|
| [`../ClawTalk Forge.html`](../ClawTalk%20Forge.html) | The clickable prototype. Forked ClawTalk "Salon" app with Forge wired in. Open it and the demo lands on the Pricing Talk with the doc pane open. |
| [`../ClawTalk Forge - Exploration.html`](../ClawTalk%20Forge%20-%20Exploration.html) | Design canvas: written rationale + the entry-surface and gallery-layout options that were explored. |
| [`09-autonomous-content-improvement-prd.md`](./09-autonomous-content-improvement-prd.md) | The source PRD (unchanged). |

### Forge source modules (loaded by `../ClawTalk Forge.html`)

| File | Contents |
|---|---|
| `../prototype/forge-data.jsx` | Mock Synthetical assets (personas, audiences, reference sets, survey questions), the simulated runs history, per-persona verbatim responses + Likert spreads, and the connection-state helpers. |
| `../prototype/forge-config.jsx` | Shared atoms — `ForgeMark`, `ScoreChip`, `PersonaCard`, `ForgeField`, `ForgeSlider` (slider **+ click-to-type** value) — and the full objective config (`ForgeConfig`). |
| `../prototype/forge-page.jsx` | The **Forge page** (rail destination + sub-nav), Runs list, Run detail (chart + trust + leaderboard + per-persona responses), Audiences, Setup, Onboarding, the compact in-doc **launcher**, and `ForgeMount`. |
| `../prototype/forge-stages.jsx` | The score line chart + the original full-overlay run/gallery stages (superseded by the page, kept for reference). |
| `../prototype/forge-canvas.jsx` | Exploration artboards for `../ClawTalk Forge - Exploration.html`. |

### Integration touchpoints (all gated by `window.CT_FORGE_ENABLED`)

The Forge flag is set in `../ClawTalk Forge.html` before scripts load, so the
base Salon app (`../ClawTalk Salon.html`) is untouched when the flag is absent.

- `../prototype/shell.jsx` — adds the **Forge** item to the icon rail (`IconRail`) and the **Improve** button to the document pane (`DocPane`).
- `../prototype/documents.jsx` — adds the **Improve** button to the full-screen document view (`DocEditorScreen`).
- `../prototype/app.jsx` — registers the `forge` route and mounts `ForgeMount`.

> The same five modules also carry the latest base-design updates that ship
> regardless of the Forge flag: Google-Docs-style **document tabs**, the
> multi-workspace **account switcher**, the **resizable document pane**, and a
> `localStorage` schema bump to `clawtalk.salon.v2`.

---

## The surface model (two surfaces, two jobs)

1. **In the document → a simple launcher.** "Improve" (doc pane *and* full-screen doc view) opens a compact modal: pick a saved **audience**, set **target** + **budget**, Start. It hands off to the Forge page to run. An "Open in Forge for full control" link goes to the full config. If Synthetical isn't connected, it routes the user to Setup.
2. **The Forge page (rail) → all the depth.** Sub-nav:
   - **Runs** — history across all docs → **Run detail**: score-over-rounds chart, trust panel (held-out vs optimized + over-fit gap), ranked version leaderboard, and per-version **verbatim persona responses with Likert distributions**.
   - **Audiences** — saved audiences (composed in ClawTalk) + the read-only persona library (authored on Synthetical).
   - **Setup** — Synthetical connection (org, scopes, synced assets) + "how Forge works". Disconnect flips the page to a first-run **onboarding** gate.

---

## Design → PRD mapping

| PRD | Where it shows up |
|---|---|
| §11 Entry ("Improve" on doc pane + selection) | In-doc launcher (doc pane + doc editor); scope toggle = whole doc / tab / title / section |
| §11 Config modal | Compact launcher + full `ForgeConfig` ("New run" / "Open in Forge") |
| §6 Objective (`persona_ids`, `reference_set_ids`, `survey_question`, `scoring_config`, fitness) | Audience + personas, reference set, survey question, target score; Advanced = mutation strategies, beam N / top-k, held-out toggle |
| §5.4 Stop conditions | Run shows target / max-rounds / plateau / budget; run statuses include `plateaued`, `cancelled` |
| §11 Live run | Run detail "running" state — animated chart + status |
| §11 Version gallery | Run detail leaderboard + per-persona responses; diff view in the in-doc result |
| §10 Goodhart / trust | Trust panel: optimized vs **held-out** score + over-fit gap; "winner lands as a pending edit" (no autonomous overwrite) |
| §7 Synthetical integration | Setup/connection (scopes `assets:write` / `tests:run` / `tests:read`, org binding), onboarding gate; personas read-only (link out), **audiences composed in-app** per §6 |

---

## What's real vs mocked

**Everything is a front-end mock.** There is no Synthetical API call, no
backend, no real scoring. Specifically:
- Personas, audiences, reference sets, runs, candidates, scores, and persona
  responses are static fixtures in `../prototype/forge-data.jsx`.
- The "live run" is a timed animation, not real iteration.
- "Set winner as document" shows a success state; it does not patch content.
- The Synthetical connection is a `localStorage` toggle (`ct-forge-connected`).
- Doc-pane width persists to `localStorage` (`ct-doc-width`); demo route is
  seeded in `localStorage` (`clawtalk.salon.v2`).

## Suggested build order (from the PRD)

1. SSR connector — OAuth + org binding, `create_candidate_assets` / `run_scoring_batch` / `get_scoring_batch` with polling (PRD §7).
2. `content_improvement_runs` + `content_versions` tables (PRD §8) backing the Runs list + Run detail.
3. Thin slice: in-doc launcher → one scored round → leaderboard → promote via the existing Content accept path (PRD §12 P0).
4. The loop (beam search, critic-driven mutation, stop conditions) + event-hub streaming into the Run detail "running" state (PRD §12 P1).
5. Held-out validation re-scoring feeding the trust panel (PRD §10).
