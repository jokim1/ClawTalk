# ClawTalk · Visual System

The chosen direction is **Salon** — warm, editorial, paper-cream. Notion + Anthropic territory with multi-agent reasoning UI grafted on top. Use these tokens exactly. The working reference is `ClawTalk Salon.html`; this doc abstracts what's there into reusable tokens.

---

## §1 · Color

### Primary palette

| Token | Hex | Use |
|---|---|---|
| `--salon-paper` | `#FBF7EF` | Page background. The cream that makes everything feel editorial. |
| `--salon-paper-2` | `#F4ECDB` | Surface variant — sidebar, headers, subtle bands. |
| `--salon-card` | `#FFFFFF` | Card backgrounds. Slightly brighter than paper for "elevated" feel. |
| `--salon-ink` | `#1F1B16` | Primary text. Warm near-black. Never pure black. |
| `--salon-ink-2` | `#6B6660` | Secondary text. Captions, metadata, muted UI. |
| `--salon-line` | `#E6E0D1` | Dividers, card borders. Warm tan-grey. |
| `--salon-accent` | `#C8643A` | Primary CTAs, focus rings, brand. Terracotta. |

### Status colors

| Run state | Bg | Fg | Dot |
|---|---|---|---|
| queued | `#F5F4F0` | `#6B6660` | `#A8A29E` |
| running | `#EAF3EE` | `#235041` | `#3F6B5C` |
| awaiting | `#FAF1DE` | `#7E5418` | `#C8893A` |
| completed | `#EAEFF9` | `#27407A` | `#3D5688` |
| failed | `#FBECEC` | `#7B2A30` | `#A8434A` |
| cancelled | `#F4EFE6` | `#5E5645` | `#8B7E6A` |

### Agent accent colors (used for avatars, byline borders, attribution)

| Agent | Accent | Dark variant |
|---|---|---|
| Strategist | `#C8643A` | `#E8855B` |
| Critic | `#8E3B59` | `#D26086` |
| Researcher | `#3F6B5C` | `#6BA98F` |
| Editor | `#3D5688` | `#7B96D1` |
| Quant | `#2A6F7E` | `#5BA8B8` |

Note: Strategist shares the accent hue with the brand. Acceptable — they're conceptually the "lead voice."

---

## §2 · Type

### Families

| Family | Use | Where to load |
|---|---|---|
| **Newsreader** | Body serif. Editorial display. Talk titles, page headers, agent message bodies, doc content. | Google Fonts |
| **Instrument Serif** | Display italics. Marketing moments. *Optional* — not load-bearing. | Google Fonts |
| **Geist** | UI sans. Buttons, chips, navigation, dense text. | Google Fonts |
| **Geist Mono** | All metadata, status pills, kbd shortcuts, IDs, file names, timestamps. Anywhere a developer might want to copy a string. | Google Fonts |

**Never use** Inter, Roboto, Arial, or Fraunces. Avoid emoji.

### Scale (px)

| Token | Size | Line-height | Use |
|---|---|---|---|
| `display` | 56 / 40 / 36 | 1.05 | Marketing H1, home greeting |
| `h1` | 30–34 | 1.15 | Doc titles, page H1 |
| `h2` | 20–22 | 1.3 | Card titles, section headers |
| `h3` | 17–18 | 1.4 | Sub-section, agent name in byline |
| `body-l` | 16–16.5 | 1.65–1.7 | Talk thread message body, doc paragraphs |
| `body` | 14–14.5 | 1.55 | Default UI text |
| `caption` | 12–12.5 | 1.4 | Secondary UI |
| `micro` | 10.5–11 | 1.3 | Mono metadata, uppercase tracking |

**Uppercase mono pattern:** `font-mono uppercase tracking-[0.16em]` at micro size for labels like `ROUND 3 · LIVE`. Used heavily — gives the product its editorial-meets-terminal personality.

---

## §3 · Spacing & layout

- **Page padding:** 36px (`px-9`) horizontal, 28px (`py-7`) vertical.
- **Max content width:** 1240px for Home / Agents, 1320px for Documents (table), 760px for Talk thread, 720px for full-bleed doc editor, 620px for the New Talk sheet.
- **Card padding:** 16–20px (`p-4` to `p-5`).
- **Section gutter:** 28px (`gap-7`) between major sections, 12px (`gap-3`) inside grids.
- **Border radius:** Cards = 16px (`rounded-2xl`). Buttons / chips = full (`rounded-full`). Inputs / pills = 8–10px (`rounded-lg`).

---

## §4 · Components

These are *patterns*, not strict implementations. Look at the prototype source for exact React.

### Run pill
Status indicator next to every agent message. Filled background + dot + label. See `RunPill` in `prototype/shell.jsx`.

### Agent avatar
Round, colored circle with monospace initials (e.g. "SL"). Optional ring for emphasis. See `AgentAvatar`.

### Chip
Small rounded-full pills. Two tones: `paper` (filled bg) and `ghost` (outlined). Use for metadata, filters, options.

### Kbd
Mono shortcut display. `<Kbd>⌘K</Kbd>`. Always inside a context (e.g. button trailing).

### Stat card
4-column strip on Home and Documents. Mono uppercase label + serif large number + small caption. See `FocusStatStrip`.

### Recommendation card
Curator-generated card with priority badge (Decide / Improve / Tidy), title, why-line, talk pill, primary action button. See `RecommendationCard` + `HeroNBACard`.

### News card
Perplexity-Discover-style. Wide layout with text left, colored thumbnail block right. Source row + headline + excerpt + "Matched: <Talk>" provenance. See `WideNewsCard`.

### Popover
Anchored to a button, floats above content with backdrop dismiss. Used for Tools / Context / Connectors / Cmd-K / Workspace switcher. See `ToolsPopover` for the canonical implementation.

### Modal
Centered sheet with 10vh top offset, backdrop blur, scoped close-on-escape. See `Modal` wrapper in `prototype/talk-dialogs.jsx`.

### Sheet (form modal)
Larger modal with sectioned form layout. See `NewTalkSheet`.

---

## §5 · Motion

- **Subtle screen fade-in:** `opacity 0 → 1` + 4px vertical translate over 220ms ease-out. Applied on route change. See `.ct-screen-enter` in `ClawTalk Salon.html`.
- **Streaming cursor:** 7×18px filled block, agent's accent color, 800ms steps(1) blink. See `.ct-caret`.
- **Pulse:** Dot indicators for live/streaming things. 1.6s ease-in-out opacity 1 → 0.35 → 1. See `.ct-pulse`.
- **No bouncy animations.** No spring physics. The product is editorial-quiet, not playful.

---

## §6 · Iconography

Custom stroke-icon set in `shared/data.jsx` → `CTIcon` component. Names: `search`, `plus`, `folder`, `chat`, `doc`, `settings`, `arrow`, `send`, `sparkle`, `paperclip`, `mic`, `cmd`, `chevron-r`, `chevron-d`, `sidebar`, `panel`, `check`, `x`, `more`, `play`, `pause`, `bolt`, `globe`, `home`, `eye`, `logout`.

**Stroke width:** 1.5–1.7 default; 1.8–2.2 for emphasis.

**Avoid:** Filled icons, photographic icons, emoji.

---

## §7 · Brand mark

See `CTMarkSalon` in `shared/data.jsx`. Three claw streaks over a rounded paper-cut speech bubble. Renders at 16–80px cleanly. Always use the function — do not embed as PNG.

Available sizes used:
- 28px (sidebar, inline)
- 36px (sign-in)
- 56px (brand card)

Color follows the `--salon-accent` token.

---

## §8 · Density modes

The product supports `density-cozy` (default) and `density-compact` body classes. Compact reduces base font-size by 1px (14 → 13). Use the cozy default for production; expose compact as a preference for power users.

---

## §9 · Tweaks panel (development only)

The prototype includes an in-app Tweaks panel for live experimentation:
- Accent color
- Density (cozy / compact)
- Home layout (focus / split / feed)

**Strip the Tweaks panel from production builds.** It's a development affordance for iterating on the design with stakeholders.
