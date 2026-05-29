/* eslint-disable */
// Shared mock data + brand marks + icon set for the ClawTalk redesign.
// All artboards across the three variations read from these so a "Strategy
// Lead" agent in Salon and Operator is the same persona.

// ─── Agents ─────────────────────────────────────────────────────────────
// Each agent is a (role + methodology + default model + persona) bundle.
// Role identity is fixed in v1 — users can edit persona and model freely,
// methodology with an "advanced" warning.

const CT_AGENTS = [
  {
    id: 'a-strategy',
    role: 'strategist',
    name: 'Strategy Lead',
    handle: '@strat',
    model: 'claude-opus-4.5',
    defaultModel: 'claude-opus-4.5',
    accent: '#C8643A',
    accentDark: '#E8855B',
    initials: 'SL',
    job: 'Frames the strongest defensible position on the question.',
    methodology: [
      'State your thesis in one sentence.',
      'Defend it with exactly 3 supporting claims, ordered by load-bearing weight.',
      'Rate your confidence (1–5) and name what would change your mind.',
    ],
    persona: 'Direct, confident, MBA-trained. Loves frameworks, impatient with handwaves. Speaks in declarative sentences.',
  },
  {
    id: 'a-critic',
    role: 'critic',
    name: 'Devil\u2019s Advocate',
    handle: '@critic',
    model: 'gpt-5-pro',
    defaultModel: 'gpt-5-pro',
    accent: '#8E3B59',
    accentDark: '#D26086',
    initials: 'DA',
    job: 'Finds where the argument breaks before the user does.',
    methodology: [
      'Identify the single weakest premise in the most recent claim.',
      'Quote the exact text being criticized.',
      'Propose the failure mode — how does this break? What\u2019s the worst case?',
      'Suggest one concrete repair, or argue why it can\u2019t be saved.',
    ],
    persona: 'Adversarial but professional. Cuts past politeness. Never agrees just to be agreeable.',
  },
  {
    id: 'a-research',
    role: 'researcher',
    name: 'Researcher',
    handle: '@research',
    model: 'gemini-2.5-pro',
    defaultModel: 'gemini-2.5-pro',
    accent: '#3F6B5C',
    accentDark: '#6BA98F',
    initials: 'Rs',
    job: 'Brings outside evidence to ground the conversation.',
    methodology: [
      'Search for ≥ 3 sources before responding.',
      'Synthesize across sources; flag contradictions explicitly.',
      'Cite inline with source name + 1-line summary.',
      'Distinguish "I found X" from "I infer X."',
    ],
    persona: 'Curious, methodical. Always shows sources. Comfortable saying "I don\u2019t know yet — let me look."',
  },
  {
    id: 'a-editor',
    role: 'editor',
    name: 'Editor',
    handle: '@editor',
    model: 'claude-sonnet-4.5',
    defaultModel: 'claude-sonnet-4.5',
    accent: '#3D5688',
    accentDark: '#7B96D1',
    initials: 'Ed',
    job: 'Closes the round into a single recommendation.',
    methodology: [
      'List points of agreement across agents (cite who).',
      'List points of disagreement (cite who and what they said).',
      'Propose a recommendation with confidence.',
      'Surface open questions as TODOs in the linked doc.',
    ],
    persona: 'Concise, structured. Closes rounds cleanly. Reads like a managing editor, not a participant.',
  },
  {
    id: 'a-quant',
    role: 'quant',
    name: 'Quant',
    handle: '@quant',
    model: 'gpt-5-pro',
    defaultModel: 'gpt-5-pro',
    accent: '#2A6F7E',
    accentDark: '#5BA8B8',
    initials: 'Qt',
    job: 'Verifies the math the others handwave through.',
    methodology: [
      'Extract every numerical claim from the round.',
      'Run the actual computation; show your work.',
      'Flag missing data needed to evaluate a claim.',
      'Propose ranges instead of point estimates when uncertainty is real.',
    ],
    persona: 'Skeptical of numbers without provenance. Always shows ranges, not point estimates. Quietly suspicious of round numbers.',
  },
];

// Role catalog — small reference for the Agents page header chips and
// the "Add agent" template picker.
const CT_ROLES = [
  { id: 'strategist', label: 'Strategist',  job: 'Frame the strongest position',  accent: '#C8643A' },
  { id: 'critic',     label: 'Critic',      job: 'Find where it breaks',          accent: '#8E3B59' },
  { id: 'researcher', label: 'Researcher',  job: 'Bring outside evidence',        accent: '#3F6B5C' },
  { id: 'editor',     label: 'Editor',      job: 'Close the round',               accent: '#3D5688' },
  { id: 'quant',      label: 'Quant',       job: 'Verify the math',               accent: '#2A6F7E' },
];

// Saved "team compositions" — pre-made rosters for common use cases.
// Users can save the current Talk\u2019s roster as a new team.
const CT_TEAMS = [
  {
    id: 'team-pricing',
    name: 'Pricing crew',
    description: 'Lands a defensible price with the math actually checked.',
    icon: 'bolt',
    agentIds: ['a-strategy', 'a-critic', 'a-quant', 'a-editor'],
    runs: 14,
    isDefault: true,
  },
  {
    id: 'team-research',
    name: 'Research crew',
    description: 'Teardown / comp work. Heavy on web sourcing, lean on debate.',
    icon: 'globe',
    agentIds: ['a-research', 'a-critic', 'a-editor'],
    runs: 7,
    isDefault: true,
  },
  {
    id: 'team-hiring',
    name: 'Hiring crew',
    description: 'Interview loop design. Skips the strategist; pure structure + critique.',
    icon: 'sparkle',
    agentIds: ['a-research', 'a-critic', 'a-editor'],
    runs: 4,
    isDefault: true,
  },
];

// ─── Run states (multi-agent orchestration) ─────────────────────────────
const CT_RUN_STATES = {
  queued:     { label: 'Queued',     dot: '#A8A29E', bg: '#F5F4F0', fg: '#6B6660', border: '#E6E2DA' },
  running:    { label: 'Streaming',  dot: '#3F6B5C', bg: '#EAF3EE', fg: '#235041', border: '#C9DFD3' },
  awaiting:   { label: 'Awaiting',   dot: '#C8893A', bg: '#FAF1DE', fg: '#7E5418', border: '#EAD7A4' },
  completed:  { label: 'Done',       dot: '#3D5688', bg: '#EAEFF9', fg: '#27407A', border: '#C9D5EE' },
  failed:     { label: 'Failed',     dot: '#A8434A', bg: '#FBECEC', fg: '#7B2A30', border: '#ECC4C7' },
  cancelled:  { label: 'Cancelled',  dot: '#8B7E6A', bg: '#F4EFE6', fg: '#5E5645', border: '#DCD2BE' },
};

// ─── Conversation timeline ──────────────────────────────────────────────
// A real-feeling multi-agent thread: human → ordered round with 4 agents,
// two finished, one streaming, one queued. This is the hero scenario.
const CT_THREAD = {
  id: 't-pricing',
  title: 'Pricing & packaging for v2 launch',
  folder: 'Q1 Launches',
  mode: 'Ordered',
  unread: 0,
  agents: CT_AGENTS,
  // ms-relative timestamps just for sort
  messages: [
    {
      id: 'm1',
      role: 'user',
      author: 'You',
      time: '2:14 PM',
      text:
        'I want to land v2 pricing this week. Three options on the table — usage-based, seat + usage hybrid, or a flat pro tier. What\u2019s the strongest pitch to a 50-seat eng org evaluating us against Notion AI? Make the case, then poke holes.',
      attachments: [
        { kind: 'doc', name: 'pricing-v2-draft.md', meta: '2.4 KB' },
      ],
    },
    {
      id: 'm2',
      role: 'agent',
      agentId: 'a-strategy',
      time: '2:14 PM',
      runId: 'r1',
      runStatus: 'completed',
      text:
        'For a 50-seat eng org, lead with **seat + usage hybrid**. Predictable line item for procurement; usage credit absorbs the spiky power-user. Anchor the headline price at $32/seat to land above Notion AI ($20) but below Linear Asks ($45) — premium without sticker shock. Bundle 10M tokens / seat / mo; overage at $4/M.',
      tokens: { in: 1842, out: 624 },
    },
    {
      id: 'm3',
      role: 'agent',
      agentId: 'a-critic',
      time: '2:14 PM',
      runId: 'r2',
      runStatus: 'completed',
      text:
        'Procurement won\u2019t pencil out hybrid without a usage cap they control. The $32 anchor reads premium to a *Notion buyer*; to a Linear buyer it reads cheap and they\u2019ll suspect quality. And "10M tokens / seat" is invisible to the buyer — they read tokens as risk, not value. Re-shape the unit.',
      tokens: { in: 2104, out: 488 },
    },
    {
      id: 'm4',
      role: 'agent',
      agentId: 'a-research',
      time: '2:15 PM',
      runId: 'r3',
      runStatus: 'running',
      // Live-streaming partial — used to show typing/streaming UI.
      streamingText:
        'Pulled comps for the 50-seat band: Notion AI Business is $20/seat + $10 AI add-on, Linear Asks ',
      progress: 'Reading 3 comps · synthesizing',
    },
    {
      id: 'm5',
      role: 'agent',
      agentId: 'a-editor',
      runId: 'r4',
      runStatus: 'queued',
      queuePosition: 2,
    },
  ],
};

// ─── Sidebar tree (talks + folders + content docs) ──────────────────────
const CT_SIDEBAR = {
  folders: [
    {
      id: 'f-q1',
      title: 'Q1 Launches',
      expanded: true,
      talks: [
        { id: 't-pricing',  title: 'Pricing & packaging for v2 launch', responding: true,  unread: 0,  hasDoc: true,  active: true },
        { id: 't-launch',   title: 'Launch week — comms plan',          responding: false, unread: 3,  hasDoc: true  },
        { id: 't-feat',     title: 'Feature gates by tier',              responding: false, unread: 0,  hasDoc: false },
      ],
    },
    {
      id: 'f-research',
      title: 'Research & longreads',
      expanded: true,
      talks: [
        { id: 't-competitor', title: 'Notion AI teardown',     responding: false, unread: 1, hasDoc: true  },
        { id: 't-hiring',     title: 'Eng hiring loop notes',  responding: false, unread: 0, hasDoc: false },
      ],
    },
  ],
  loose: [
    { id: 't-personal', title: 'My weekly review',          responding: false, unread: 0, hasDoc: true  },
    { id: 't-scratch',  title: 'Scratchpad \u2014 ideas',   responding: false, unread: 7, hasDoc: false },
  ],
  contents: [
    { id: 'd1', title: 'pricing-v2-draft.md',          talkId: 't-pricing' },
    { id: 'd2', title: 'launch-comms-checklist.md',    talkId: 't-launch' },
    { id: 'd3', title: 'notion-teardown.md',           talkId: 't-competitor' },
    { id: 'd4', title: 'weekly-review-2024-W12.md',    talkId: 't-personal' },
  ],
};

// ─── Active doc (the artifact pane shows this) ─────────────────────────
const CT_DOC = {
  title: 'pricing-v2-draft.md',
  blocks: [
    { kind: 'h1', text: 'Pricing v2 \u2014 draft' },
    { kind: 'meta', text: 'Owner: you  ·  Co-editing: Strategy Lead, Editor  ·  Last edit 14s ago' },
    { kind: 'p', text: 'For the 50-seat eng band, the strongest position is a seat + usage hybrid with a procurement-friendly cap. Below is the case we\u2019ll make, plus the three places this falls apart under pressure.' },
    { kind: 'h2', text: 'The case' },
    { kind: 'li', text: 'Predictable seat line item ($32/seat) lands above Notion AI ($20) and signals premium positioning.' },
    { kind: 'li', text: 'Bundled 10M tokens / seat / month covers the median power user with headroom; overage charged at $4 / M tokens.', pending: true },
    { kind: 'li', text: 'Annual prepay unlocks an 18% discount \u2014 trades a small margin haircut for cashflow + retention.' },
    { kind: 'h2', text: 'Where this breaks' },
    { kind: 'li', text: '"Tokens" is illegible to procurement. Replace with "messages" or "AI actions" before any external pitch.' },
    { kind: 'li', text: 'No per-org cap means procurement will block. We need a soft cap with an opt-in overage flow.', pending: true },
  ],
};

// ─── Brand mark variants ────────────────────────────────────────────────
// Three takes on the ClawTalk mark — same primitive (three claw streaks
// over a speech bubble) but tuned per variation.

function CTMarkSalon({ size = 32, accent = '#C8643A' }) {
  // Warm editorial: a rounded paper-cut speech bubble with three soft
  // diagonal claw streaks. Hand-drawn-ish.
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <path
        d="M6 8 C6 5 8 3 11 3 H29 C32 3 34 5 34 8 V24 C34 27 32 29 29 29 H18 L11 35 V29 C8 29 6 27 6 24 Z"
        fill="#FBF7EF"
        stroke={accent}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M13 19 L18 9"  stroke={accent} strokeWidth="2.2" strokeLinecap="round" />
      <path d="M19 22 L24 10" stroke={accent} strokeWidth="2.2" strokeLinecap="round" />
      <path d="M25 22 L28 13" stroke={accent} strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function CTMarkOperator({ size = 32, accent = '#E8855B' }) {
  // Precise/monospace: a hard-edged square with three pixel-perfect
  // diagonal slashes. Reads as a terminal prompt cursor + claws.
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect x="4" y="4" width="32" height="32" rx="6" fill="#15161A" />
      <rect x="4" y="4" width="32" height="32" rx="6" fill="none" stroke={accent} strokeWidth="1.2" opacity="0.45" />
      <path d="M10 26 L18 12" stroke={accent} strokeWidth="2.4" strokeLinecap="square" />
      <path d="M16 28 L24 14" stroke={accent} strokeWidth="2.4" strokeLinecap="square" />
      <path d="M22 30 L30 16" stroke={accent} strokeWidth="2.4" strokeLinecap="square" />
      <rect x="27" y="26" width="3" height="6" fill={accent} />
    </svg>
  );
}

function CTMarkStudio({ size = 32, accent = '#7C3AED' }) {
  // Playful: a circle "head" with three blade-style claws fanning out
  // off-center. More gestural, more colorful.
  const sec = '#F59E0B';
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="16" fill={accent} />
      <circle cx="20" cy="20" r="16" fill="url(#ctstudio-grad)" opacity="0.65" />
      <defs>
        <radialGradient id="ctstudio-grad" cx="0.3" cy="0.25" r="0.9">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.5" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d="M12 24 Q16 16 22 12" stroke="#FFFFFF" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      <path d="M14 28 Q19 19 26 16" stroke="#FFFFFF" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      <path d="M18 30 Q23 22 30 20" stroke={sec} strokeWidth="2.4" fill="none" strokeLinecap="round" />
    </svg>
  );
}

// ─── Tiny icon set (no external icon library; vary stroke per variation) ─
function CTIcon({ name, size = 16, stroke = 'currentColor', strokeWidth = 1.5 }) {
  const common = {
    width: size, height: size, viewBox: '0 0 24 24',
    fill: 'none', stroke, strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true,
  };
  switch (name) {
    case 'search':  return <svg {...common}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>;
    case 'plus':    return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
    case 'folder':  return <svg {...common}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>;
    case 'chat':    return <svg {...common}><path d="M21 12a8 8 0 1 1-3.5-6.6L21 4l-1.4 3.5A8 8 0 0 1 21 12Z"/></svg>;
    case 'doc':     return <svg {...common}><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5"/></svg>;
    case 'settings':return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1A2 2 0 1 1 4.3 17l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7 4.3l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>;
    case 'arrow':   return <svg {...common}><path d="M5 12h14M13 5l7 7-7 7"/></svg>;
    case 'send':    return <svg {...common}><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/></svg>;
    case 'sparkle': return <svg {...common}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>;
    case 'paperclip': return <svg {...common}><path d="m21.4 11.1-8.5 8.5a5 5 0 1 1-7-7l8.5-8.5a3.5 3.5 0 1 1 5 5l-8.5 8.5a2 2 0 0 1-2.8-2.8l8-8"/></svg>;
    case 'mic':     return <svg {...common}><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>;
    case 'cmd':     return <svg {...common}><path d="M9 9V6a3 3 0 1 0-3 3h3Zm0 0v6h6V9H9Zm6 0V6a3 3 0 1 1 3 3h-3Zm0 6v3a3 3 0 1 0 3-3h-3Zm-6 0v3a3 3 0 1 1-3-3h3Z"/></svg>;
    case 'chevron-r': return <svg {...common}><path d="m9 6 6 6-6 6"/></svg>;
    case 'chevron-d': return <svg {...common}><path d="m6 9 6 6 6-6"/></svg>;
    case 'sidebar': return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>;
    case 'panel':   return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>;
    case 'check':   return <svg {...common}><path d="M5 12l5 5L20 7"/></svg>;
    case 'x':       return <svg {...common}><path d="M6 6l12 12M18 6 6 18"/></svg>;
    case 'more':    return <svg {...common}><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>;
    case 'play':    return <svg {...common}><path d="M6 4v16l14-8Z"/></svg>;
    case 'pause':   return <svg {...common}><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>;
    case 'bolt':    return <svg {...common}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>;
    case 'globe':   return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>;
    case 'home':    return <svg {...common}><path d="M3 11 12 3l9 8v9a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/></svg>;
    case 'eye':     return <svg {...common}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>;
    case 'logout':  return <svg {...common}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>;
    default: return null;
  }
}

Object.assign(window, {
  CT_AGENTS, CT_ROLES, CT_TEAMS, CT_RUN_STATES, CT_THREAD, CT_SIDEBAR, CT_DOC,
  CTMarkSalon, CTMarkOperator, CTMarkStudio, CTIcon,
});
