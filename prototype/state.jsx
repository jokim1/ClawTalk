/* eslint-disable */
// Prototype state — app-wide store + multi-agent thread simulator.
// Backed by localStorage so refreshing keeps you where you were.

const { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } = React;

// ─── persistence helper ────────────────────────────────────────────────
const LS_KEY = 'clawtalk.salon.v2';
function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!raw) return null;
    // Defensive merge — make sure top-level shape matches latest world
    // even if the stored copy was written by an older build.
    const fresh = buildInitialWorld();
    return { ...fresh, ...raw, talks: { ...fresh.talks, ...(raw.talks || {}) }, docs: { ...fresh.docs, ...(raw.docs || {}) }, user: { ...fresh.user, ...(raw.user || {}) } };
  } catch (e) { return null; }
}
function saveState(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) {}
}

// ─── doc-tab helpers ────────────────────────────────────────────────────
// A document is a container of tabs (Google-Docs style). Older docs that
// only have a flat `blocks` array are transparently wrapped into one tab so
// every consumer can treat docs uniformly.
function CT_docTabs(doc) {
  if (!doc) return [];
  if (doc.tabs && doc.tabs.length) return doc.tabs;
  return [{ id: doc.id + '-t1', title: 'Tab 1', blocks: doc.blocks || [], coEditors: doc.coEditors || [] }];
}
function CT_docActiveTabId(state, doc) {
  if (!doc) return null;
  const tabs = CT_docTabs(doc);
  const stored = state && state.docTabs ? state.docTabs[doc.id] : null;
  return tabs.some((t) => t.id === stored) ? stored : tabs[0].id;
}
function CT_activeDocTab(state, doc) {
  if (!doc) return null;
  const tabs = CT_docTabs(doc);
  const id = CT_docActiveTabId(state, doc);
  return tabs.find((t) => t.id === id) || tabs[0];
}
function CT_docWordCount(doc) {
  let n = 0;
  for (const t of CT_docTabs(doc)) for (const b of (t.blocks || [])) if (b.text) n += b.text.trim().split(/\s+/).filter(Boolean).length;
  return n;
}
function CT_docPending(doc) {
  let n = 0;
  for (const t of CT_docTabs(doc)) n += (t.blocks || []).filter((b) => b.pending).length;
  return n;
}
Object.assign(window, { CT_docTabs, CT_docActiveTabId, CT_activeDocTab, CT_docWordCount, CT_docPending });

// ─── default world ────────────────────────────────────────────────────
// Multiple talks, each with their own thread. The 'pricing' talk is
// pre-populated with the rich multi-agent scenario from the canvas;
// the rest have lighter content.

function buildInitialWorld() {
  return {
    user: {
      name: 'Samira Rao',
      handle: '@samira',
      email: 'samira@oxbow.co',
      initials: 'SR',
      avatarColor: '#3F6B5C',
      workspace: 'Oxbow & Co.',
    },
    // Workspaces the user has access to — shown in the 2-col account menu.
    // First one is the active workspace.
    workspaces: [
      { id: 'ws-oxbow',    name: 'Oxbow & Co.',      initials: 'OC', color: '#C8643A', role: 'Owner',  active: true,  unread: 0 },
      { id: 'ws-lattice',  name: 'Lattice Lab',      initials: 'LL', color: '#3F6B5C', role: 'Admin',  active: false, unread: 4 },
      { id: 'ws-foundry',  name: 'Foundry SF',       initials: 'FS', color: '#2A6F8A', role: 'Member', active: false, unread: 0 },
      { id: 'ws-maker',    name: 'Maker House Co-op',initials: 'MH', color: '#8A4A3A', role: 'Member', active: false, unread: 12 },
      { id: 'ws-personal', name: 'Samira · personal',initials: 'SR', color: '#6B4A8A', role: 'Owner',  active: false, unread: 0 },
      { id: 'ws-curio',    name: 'Curio Magazine',   initials: 'CM', color: '#C49A3A', role: 'Guest',  active: false, unread: 1 },
      { id: 'ws-relay',    name: 'Relay (paused)',   initials: 'RL', color: '#7A6F58', role: 'Member', active: false, unread: 0 },
    ],
    activeTalkId: 't-pricing',
    showDoc: false,
    showCmdK: false,
    settingsTab: 'profile',
    selectedAgentId: null,
    selectedDocId: null,
    // Which tab is active within each doc (a doc is a container of tabs,
    // Google-Docs style). Keyed by docId → tabId. Defaults to the first tab.
    docTabs: {},
    archivedTalkIds: [],
    // Ephemeral UI dialogs.
    showNewTalkSheet: false,
    folderDeleteDialog: null,  // { folderId } | null
    archiveTalkDialog:  null,  // { talkId }   | null
    talkSubpanel:       null,  // 'context' | 'connectors' | null
    composerText: '',
    composerTargets: ['a-strategy','a-critic','a-research','a-editor'],
    composerMode: 'Ordered',
    composerRounds: 3,
    // Per-talk tool defaults — used when a talk doesn't override them.
    defaultTools: {
      'web-search':  true,
      'web-fetch':   false,
      'news-monitor':true,
      'gdrive-read': true,
      'gdrive-write':false,
      'gmail-read':  false,
      'gmail-send':  false,
      'messaging':   false,
      'linear':      false,
      'github-read': false,
    },
    folders: [
      {
        id: 'f-q1',
        title: 'Q1 Launches',
        expanded: true,
        talkIds: ['t-pricing','t-launch','t-feat'],
      },
      {
        id: 'f-research',
        title: 'Research & longreads',
        expanded: true,
        talkIds: ['t-competitor','t-hiring'],
      },
    ],
    looseIds: ['t-personal','t-scratch'],
    talks: {
      't-pricing': {
        id: 't-pricing', title: 'Pricing & packaging for v2 launch',
        folder: 'Q1 Launches', mode: 'Ordered', rounds: 3,
        agents: ['a-strategy','a-critic','a-research','a-editor'],
        running: true,
        unread: 0,
        hasDoc: true,
        docId: 'd1',
        tools: {
          'web-search':  true,
          'web-fetch':   true,
          'news-monitor':true,
          'gdrive-read': true,
          'gdrive-write':false,
          'gmail-read':  false,
          'gmail-send':  false,
          'messaging':   false,
          'linear':      false,
          'github-read': false,
        },
        messages: [
          { id: 'm1', role: 'user', author: 'Samira', initials: 'SR', avatarColor: '#1F1B16',
            time: '2:14 PM',
            text: 'I want to land v2 pricing this week. Three options on the table — usage-based, seat + usage hybrid, or a flat pro tier. What\u2019s the strongest pitch to a 50-seat eng org evaluating us against Notion AI? Make the case, then poke holes.',
            attachments: [{ kind: 'doc', name: 'pricing-v2-draft.md', meta: '2.4 KB' }],
            round: 1 },
          { id: 'm2', role: 'agent', agentId: 'a-strategy', time: '2:14 PM', runId: 'r1', runStatus: 'completed',
            text: 'For a 50-seat eng org, lead with **seat + usage hybrid**. Predictable line item for procurement; usage credit absorbs the spiky power-user. Anchor the headline price at $32/seat to land above Notion AI ($20) but below Linear Asks ($45) — premium without sticker shock. Bundle 10M tokens / seat / mo; overage at $4/M.',
            tokens: { in: 1842, out: 624 },
            round: 3 },
          { id: 'm3', role: 'agent', agentId: 'a-critic', time: '2:14 PM', runId: 'r2', runStatus: 'completed',
            text: 'Procurement won\u2019t pencil out hybrid without a usage cap they control. The $32 anchor reads premium to a *Notion buyer*; to a Linear buyer it reads cheap and they\u2019ll suspect quality. And "10M tokens / seat" is invisible to the buyer — they read tokens as risk, not value. Re-shape the unit.',
            tokens: { in: 2104, out: 488 },
            round: 3 },
          { id: 'm4', role: 'agent', agentId: 'a-research', time: '2:15 PM', runId: 'r3', runStatus: 'running',
            streamingText: 'Pulled comps for the 50-seat band: Notion AI Business is $20/seat + $10 AI add-on, Linear Asks ',
            fullText: 'Pulled comps for the 50-seat band: Notion AI Business is $20/seat + $10 AI add-on, Linear Asks is $45/seat with a 10k action ceiling, and Vercel\u2019s v0 Teams sits at $30/seat unmetered for the first 6 months. The 50-seat band is sensitive to *predictability* over headline price — three of four buyers cited audit cost above unit cost.',
            progress: 'Reading 3 comps · synthesizing',
            round: 3 },
          { id: 'm5', role: 'agent', agentId: 'a-editor', runId: 'r4', runStatus: 'queued', queuePosition: 2, round: 3 },
        ],
      },
      't-launch': {
        id: 't-launch', title: 'Launch week — comms plan',
        folder: 'Q1 Launches', mode: 'Parallel', rounds: 2,
        agents: ['a-strategy','a-critic','a-editor'],
        running: false, unread: 3, hasDoc: true, docId: 'd2',
        messages: [
          { id: 'lm1', role: 'user', author: 'Samira', initials: 'SR', avatarColor: '#1F1B16',
            time: 'Yesterday', text: 'Draft me a launch week comms plan. Day-by-day, who emails who, when the embargo lifts, what the social cadence looks like.', round: 1 },
          { id: 'lm2', role: 'agent', agentId: 'a-strategy', time: 'Yesterday', runStatus: 'completed',
            text: 'Embargo lifts Tuesday 9am ET. Day 0 (Mon): direct outreach to the 12 design partners. Day 1: press &amp; analyst briefings. Day 2 morning: blog post + Twitter thread. Day 2 afternoon: launch on PH + HN. Day 3: customer webinar. Day 4: retrospective post.', tokens: { in: 980, out: 320 }, round: 2 },
          { id: 'lm3', role: 'agent', agentId: 'a-critic', time: 'Yesterday', runStatus: 'completed',
            text: 'Tuesday morning blog + Twitter thread *plus* HN+PH all on Day 2 will fragment attention. Pick one launch surface — either PH or HN, not both. Also no plan for the inevitable competitor response on Day 3; reserve a counter-thread.', tokens: { in: 1100, out: 280 }, round: 2 },
          { id: 'lm4', role: 'agent', agentId: 'a-editor', time: 'Yesterday', runStatus: 'completed',
            text: 'Synthesized into a single timeline doc with both perspectives folded in. Open question: PH vs HN — needs Samira\u2019s call.', tokens: { in: 1640, out: 412 }, round: 2 },
        ],
      },
      't-feat': {
        id: 't-feat', title: 'Feature gates by tier',
        folder: 'Q1 Launches', mode: 'Ordered', rounds: 1,
        agents: ['a-strategy','a-research'],
        running: false, unread: 0, hasDoc: false,
        messages: [
          { id: 'fm1', role: 'user', author: 'Samira', initials: 'SR', avatarColor: '#1F1B16',
            time: '2 days ago', text: 'What ships free, what ships team, what gates to enterprise? Pretend you\u2019re competing with Notion AI and Linear Asks.', round: 1 },
          { id: 'fm2', role: 'agent', agentId: 'a-strategy', time: '2 days ago', runStatus: 'completed',
            text: 'Free: 50 messages / day, 2 agents per Talk, single workspace. Team: unlimited agents, SSO via Google, history retention 90d. Enterprise: SSO via SAML, audit log export, custom retention, on-prem provider keys.', tokens: { in: 820, out: 280 }, round: 1 },
        ],
      },
      't-competitor': {
        id: 't-competitor', title: 'Notion AI teardown',
        folder: 'Research & longreads', mode: 'Ordered', rounds: 2,
        agents: ['a-research','a-critic'],
        running: false, unread: 1, hasDoc: true, docId: 'd3',
        messages: [
          { id: 'cm1', role: 'user', author: 'Samira', initials: 'SR', avatarColor: '#1F1B16',
            time: 'Yesterday', text: 'Tear down Notion AI\u2019s current product — features, pricing, where they win, where they lose.', round: 1 },
          { id: 'cm2', role: 'agent', agentId: 'a-research', time: 'Yesterday', runStatus: 'completed',
            text: 'Three product surfaces: (1) inline page AI, (2) Q&amp;A across workspace, (3) writing autocomplete. Pricing is $10/seat as an add-on. They win on distribution (75M Notion users); they lose on multi-document reasoning and on power-user latency.', tokens: { in: 1620, out: 520 }, round: 2 },
          { id: 'cm3', role: 'agent', agentId: 'a-critic', time: 'Yesterday', runStatus: 'completed',
            text: '"They lose on power-user latency" needs a number, not a vibe. Notion AI median is 3.2s, p95 is 8.4s in my last measurement. We\u2019re currently 2.1s / 5.8s — that\u2019s the gap to anchor on.', tokens: { in: 1840, out: 290 }, round: 2 },
        ],
      },
      't-hiring': {
        id: 't-hiring', title: 'Eng hiring loop notes',
        folder: 'Research & longreads', mode: 'Ordered', rounds: 1,
        agents: ['a-research'],
        running: false, unread: 0, hasDoc: false,
        messages: [
          { id: 'hm1', role: 'user', author: 'Samira', initials: 'SR', avatarColor: '#1F1B16',
            time: '3 days ago', text: 'Brainstorm a 3-loop interview for a senior infra engineer.', round: 1 },
          { id: 'hm2', role: 'agent', agentId: 'a-research', time: '3 days ago', runStatus: 'completed',
            text: 'Loop 1: paired debugging on a deliberately-broken service. Loop 2: design a job system, with a curveball at minute 30. Loop 3: written architecture review of an existing RFC, then a 30-min walkthrough.', tokens: { in: 920, out: 340 }, round: 1 },
        ],
      },
      't-personal': {
        id: 't-personal', title: 'My weekly review',
        folder: null, mode: 'Ordered', rounds: 1,
        agents: ['a-editor'],
        running: false, unread: 0, hasDoc: true, docId: 'd4',
        messages: [
          { id: 'pm1', role: 'user', author: 'Samira', initials: 'SR', avatarColor: '#1F1B16',
            time: 'Sunday', text: 'Walk me through the week. What got done, what slipped, what to focus on Monday.', round: 1 },
          { id: 'pm2', role: 'agent', agentId: 'a-editor', time: 'Sunday', runStatus: 'completed',
            text: 'Done: shipped v1.4, closed the Series A round, hired two engineers. Slipped: pricing announcement (now this week), Q1 OKR review. Monday focus: pricing call with Henry, then Q1 OKR draft.', tokens: { in: 540, out: 220 }, round: 1 },
        ],
      },
      't-scratch': {
        id: 't-scratch', title: 'Scratchpad — ideas',
        folder: null, mode: 'Parallel', rounds: 1,
        agents: ['a-strategy'],
        running: false, unread: 7, hasDoc: false,
        messages: [
          { id: 'sm1', role: 'user', author: 'Samira', initials: 'SR', avatarColor: '#1F1B16',
            time: '4 days ago', text: 'Open scratchpad — drop anything here.', round: 1 },
        ],
      },
    },
    docs: {
      d1: {
        id: 'd1', title: 'pricing-v2-draft.md', talkId: 't-pricing', format: 'md',
        coEditors: ['a-strategy', 'a-editor'],
        lastEdit: '14 s ago', lastEditTs: Date.now() - 14000,
        folder: 'Q1 Launches',
        tabs: [
          { id: 'd1t1', title: 'Draft', coEditors: ['a-strategy', 'a-editor'], blocks: [
            { id: 'b1', kind: 'h1',   text: 'Pricing v2 — draft' },
            { id: 'b2', kind: 'meta', text: 'Owner: you  ·  Co-editing: Strategy Lead, Editor  ·  Last edit 14s ago' },
            { id: 'b3', kind: 'p',    text: 'For the 50-seat eng band, the strongest position is a seat + usage hybrid with a procurement-friendly cap. Below is the case we\u2019ll make, plus the three places this falls apart under pressure.' },
            { id: 'b4', kind: 'h2',   text: 'The case' },
            { id: 'b5', kind: 'li',   text: 'Predictable seat line item ($32/seat) lands above Notion AI ($20) and signals premium positioning.' },
            { id: 'b6', kind: 'li',   text: 'Bundled 10M tokens / seat / month covers the median power user with headroom; overage charged at $4 / M tokens.', pending: true, pendingBy: 'a-editor' },
            { id: 'b7', kind: 'li',   text: 'Annual prepay unlocks an 18% discount — trades a small margin haircut for cashflow + retention.' },
            { id: 'b8', kind: 'h2',   text: 'Where this breaks' },
            { id: 'b9', kind: 'li',   text: '"Tokens" is illegible to procurement. Replace with "messages" or "AI actions" before any external pitch.' },
            { id: 'b10', kind: 'li',  text: 'No per-org cap means procurement will block. We need a soft cap with an opt-in overage flow.', pending: true, pendingBy: 'a-editor' },
          ] },
          { id: 'd1t2', title: 'Comp table', coEditors: ['a-research'], blocks: [
            { id: 'c1', kind: 'h1',   text: 'Competitor comp' },
            { id: 'c2', kind: 'meta', text: 'Researcher · pulled for the 50-seat band' },
            { id: 'c3', kind: 'p',    text: 'Headline numbers procurement will hold us against. This band weighs predictability over sticker price.' },
            { id: 'c4', kind: 'h2',   text: 'Per seat, 50 seats' },
            { id: 'c5', kind: 'li',   text: 'Notion AI Business — $20/seat + $10 AI add-on. Cheapest; weakest reasoning.' },
            { id: 'c6', kind: 'li',   text: 'Linear Asks — $45/seat with a 10k action ceiling. Premium; hard cap.' },
            { id: 'c7', kind: 'li',   text: 'Vercel v0 Teams — $30/seat, unmetered for the first 6 months. Promo pricing.' },
            { id: 'c8', kind: 'li',   text: 'Our proposal — $32/seat + 10M token pool. Sits between, premium-leaning.' },
          ] },
          { id: 'd1t3', title: 'Procurement', coEditors: ['a-critic', 'a-editor'], blocks: [
            { id: 'p1', kind: 'h1',   text: 'Procurement objections' },
            { id: 'p2', kind: 'meta', text: 'Devil\u2019s Advocate · the three blockers' },
            { id: 'p3', kind: 'li',   text: 'No usage cap they control — re-shape to a soft cap with opt-in overage.' },
            { id: 'p4', kind: 'li',   text: '"Tokens" reads as risk, not value — bill externally in "AI actions".', pending: true, pendingBy: 'a-editor' },
            { id: 'p5', kind: 'li',   text: 'The hybrid line item needs one predictable number for the PO.' },
          ] },
        ],
      },
      d2: {
        id: 'd2', title: 'launch-comms-checklist.md', talkId: 't-launch', format: 'md',
        coEditors: ['a-editor'], lastEdit: '2 h ago', lastEditTs: Date.now() - 7200000,
        folder: 'Q1 Launches',
        blocks: [
          { id: 'b1', kind: 'h1',   text: 'Launch week — comms plan' },
          { id: 'b2', kind: 'meta', text: 'Owner: you  ·  Last edit 2h ago' },
          { id: 'b3', kind: 'h2',   text: 'Day-by-day' },
          { id: 'b4', kind: 'li',   text: 'Monday (Day 0): direct outreach to 12 design partners.' },
          { id: 'b5', kind: 'li',   text: 'Tuesday 9 am ET: embargo lifts. Press &amp; analyst briefings.' },
          { id: 'b6', kind: 'li',   text: 'Wednesday morning: blog post. Pick one launch surface — PH or HN, not both.' },
          { id: 'b7', kind: 'li',   text: 'Wednesday afternoon: customer webinar.' },
          { id: 'b8', kind: 'li',   text: 'Thursday: reserve a counter-thread for the inevitable competitor response.' },
          { id: 'b9', kind: 'li',   text: 'Friday: retrospective post.' },
          { id: 'b10', kind: 'h2',  text: 'Open questions' },
          { id: 'b11', kind: 'li',  text: 'PH vs HN — needs Samira\u2019s call.' },
        ],
      },
      d3: {
        id: 'd3', title: 'notion-teardown.md', talkId: 't-competitor', format: 'md',
        coEditors: ['a-research'], lastEdit: 'yesterday', lastEditTs: Date.now() - 86400000,
        folder: 'Research & longreads',
        tabs: [
          { id: 'd3t1', title: 'Teardown', coEditors: ['a-research', 'a-critic'], blocks: [
            { id: 'b1', kind: 'h1',   text: 'Notion AI — teardown' },
            { id: 'b2', kind: 'meta', text: 'Owner: you  ·  Researcher · Critic' },
            { id: 'b3', kind: 'h2',   text: 'Surfaces' },
            { id: 'b4', kind: 'li',   text: 'Inline page AI — strong for single-page tasks, weak across docs.' },
            { id: 'b5', kind: 'li',   text: 'Workspace Q&amp;A — getting better since v3, but still slow on big workspaces.' },
            { id: 'b6', kind: 'li',   text: 'Writing autocomplete — table stakes, comparable to GitHub Copilot.' },
            { id: 'b9', kind: 'h2',   text: 'Where they win / lose' },
            { id: 'b10', kind: 'li',  text: 'Win: distribution. 75M Notion users. The "already there" advantage.' },
            { id: 'b11', kind: 'li',  text: 'Lose: multi-doc reasoning depth. Median 3.2s, p95 8.4s vs our 2.1s / 5.8s.' },
            { id: 'b12', kind: 'li',  text: 'Lose: opinionated agents. Their assistant is one model with one prompt.' },
          ] },
          { id: 'd3t2', title: 'Pricing', coEditors: ['a-research'], blocks: [
            { id: 'pr1', kind: 'h1',   text: 'Notion AI — pricing' },
            { id: 'pr2', kind: 'meta', text: 'Researcher · as of this quarter' },
            { id: 'pr3', kind: 'p',    text: 'Business plan: $20/seat. AI add-on: $10/seat. Bundled at higher tiers.' },
            { id: 'pr4', kind: 'h2',   text: 'How it bites us' },
            { id: 'pr5', kind: 'li',   text: 'The $10 add-on undercuts any premium AI line item we float.' },
            { id: 'pr6', kind: 'li',   text: 'Bundling at higher tiers hides the AI cost — buyers stop comparing it.' },
          ] },
          { id: 'd3t3', title: 'Our angle', coEditors: ['a-critic'], blocks: [
            { id: 'an1', kind: 'h1',   text: 'How we counter' },
            { id: 'an2', kind: 'meta', text: 'Devil\u2019s Advocate · the anchor' },
            { id: 'an3', kind: 'li',   text: 'Anchor on latency: 2.1s / 5.8s vs their 3.2s / 8.4s. A number, not a vibe.' },
            { id: 'an4', kind: 'li',   text: 'Anchor on multi-doc reasoning — the thing one prompt can\u2019t do.' },
            { id: 'an5', kind: 'li',   text: 'Don\u2019t fight on price. Fight on the work their single assistant can\u2019t finish.' },
          ] },
        ],
      },
      d4: {
        id: 'd4', title: 'weekly-review-2026-W21.md', talkId: 't-personal', format: 'md',
        coEditors: ['a-editor'], lastEdit: '3 d ago', lastEditTs: Date.now() - 86400000 * 3,
        folder: null,
        blocks: [
          { id: 'b1', kind: 'h1',   text: 'Weekly review · 2026-W21' },
          { id: 'b2', kind: 'meta', text: 'Owner: you · Editor only' },
          { id: 'b3', kind: 'h2',   text: 'Done' },
          { id: 'b4', kind: 'li',   text: 'Shipped v1.4 across all three providers.' },
          { id: 'b5', kind: 'li',   text: 'Closed the Series A round (target +20%, landed +12%).' },
          { id: 'b6', kind: 'li',   text: 'Hired two engineers; both starting in two weeks.' },
          { id: 'b7', kind: 'h2',   text: 'Slipped' },
          { id: 'b8', kind: 'li',   text: 'Pricing announcement — now this week.' },
          { id: 'b9', kind: 'li',   text: 'Q1 OKR review — Monday.' },
          { id: 'b10', kind: 'h2',  text: 'Monday focus' },
          { id: 'b11', kind: 'li',  text: 'Pricing call with Henry, then Q1 OKR draft.' },
        ],
      },
      // Unlinked docs — created outside any Talk.
      d5: {
        id: 'd5', title: 'ideas-scratchpad.html', talkId: null, format: 'html',
        coEditors: [], lastEdit: '4 d ago', lastEditTs: Date.now() - 86400000 * 4,
        folder: null,
        blocks: [
          { id: 'b1', kind: 'h1',   text: 'Ideas scratchpad' },
          { id: 'b2', kind: 'meta', text: 'Owner: you · unlinked · HTML' },
          { id: 'b3', kind: 'p',    text: 'A junk drawer for half-formed thoughts. Promote anything good to a Talk.' },
          { id: 'b4', kind: 'li',   text: 'Could the Critic optionally cite the original verbatim, like a Twitter quote-tweet?' },
          { id: 'b5', kind: 'li',   text: 'Per-round token budget — set a ceiling before agents pick their model.' },
          { id: 'b6', kind: 'li',   text: 'Editor synthesis could output a TLDR + an "if you only had 30s" version.' },
        ],
      },
      d6: {
        id: 'd6', title: 'pricing-v1-archive.md', talkId: null, format: 'md',
        coEditors: [], lastEdit: '3 w ago', lastEditTs: Date.now() - 86400000 * 21,
        folder: 'Q1 Launches',
        blocks: [
          { id: 'b1', kind: 'h1',   text: 'Pricing v1 — archive' },
          { id: 'b2', kind: 'meta', text: 'Owner: you · Archived · referenced from Pricing v2' },
          { id: 'b3', kind: 'p',    text: 'The original $24/seat flat pricing. Useful as context for v2 decisions; not currently being edited.' },
          { id: 'b4', kind: 'h2',   text: 'Why v1 was wrong' },
          { id: 'b5', kind: 'li',   text: 'Flat-per-seat couldn\u2019t absorb the power-user tail. 12% of users drove 60% of cost.' },
          { id: 'b6', kind: 'li',   text: 'Procurement liked it; engineers hated being throttled.' },
        ],
      },
    },
  };
}

// ─── context ──────────────────────────────────────────────────────────

const AppContext = createContext(null);
const useApp = () => useContext(AppContext);

function AppProvider({ children }) {
  const [state, setState] = useState(() => loadState() || buildInitialWorld());
  const [route, setRoute] = useState(() => loadState()?.__route || 'signin');
  const streamTimers = useRef({});

  // Persist
  useEffect(() => {
    saveState({ ...state, __route: route });
  }, [state, route]);

  // Stop all timers on unmount.
  useEffect(() => () => {
    Object.values(streamTimers.current).forEach((t) => clearInterval(t));
  }, []);

  // ─── mutators ────────────────────────────────────────────────────
  const setSettingsTab = useCallback((tab) => {
    setState((s) => ({ ...s, settingsTab: tab }));
    setRoute('settings');
  }, []);

  const setSelectedAgent = useCallback((id) => {
    setState((s) => ({ ...s, selectedAgentId: id }));
    setRoute(id ? 'agent' : 'agents');
  }, []);

  const setSelectedDoc = useCallback((id) => {
    setState((s) => ({ ...s, selectedDocId: id }));
    setRoute(id ? 'doc' : 'documents');
  }, []);

  const setActiveTalk = useCallback((id) => {
    setState((s) => ({ ...s, activeTalkId: id, showDoc: false }));
    setRoute('talk');
  }, []);

  const toggleDoc = useCallback(() => {
    setState((s) => ({ ...s, showDoc: !s.showDoc }));
  }, []);

  const setShowCmdK = useCallback((v) => {
    setState((s) => ({ ...s, showCmdK: typeof v === 'function' ? v(s.showCmdK) : v }));
  }, []);

  const setComposerText = useCallback((text) => {
    setState((s) => ({ ...s, composerText: text }));
  }, []);

  // Toggle a tool on the active talk. Falls back to defaultTools as base
  // if the talk hasn't been initialized with its own copy.
  const toggleTool = useCallback((toolId) => {
    setState((s) => {
      const talk = s.talks[s.activeTalkId];
      if (!talk) return s;
      const cur = talk.tools || s.defaultTools;
      const next = { ...cur, [toolId]: !cur[toolId] };
      return {
        ...s,
        talks: { ...s.talks, [talk.id]: { ...talk, tools: next } },
      };
    });
  }, []);

  const toggleTarget = useCallback((agentId) => {
    setState((s) => ({
      ...s,
      composerTargets: s.composerTargets.includes(agentId)
        ? s.composerTargets.filter((x) => x !== agentId)
        : [...s.composerTargets, agentId],
    }));
  }, []);

  // ─── doc-tab mutators ────────────────────────────────────────────
  const setDocTab = useCallback((docId, tabId) => {
    setState((s) => ({ ...s, docTabs: { ...s.docTabs, [docId]: tabId } }));
  }, []);

  const addDocTab = useCallback((docId) => {
    setState((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      const tabs = CT_docTabs(doc).map((t) => ({ ...t }));
      const newId = docId + '-t' + Date.now().toString().slice(-6);
      tabs.push({ id: newId, title: 'Tab ' + (tabs.length + 1), blocks: [], coEditors: [] });
      return {
        ...s,
        docs: { ...s.docs, [docId]: { ...doc, tabs } },
        docTabs: { ...s.docTabs, [docId]: newId },
      };
    });
  }, []);

  const renameDocTab = useCallback((docId, tabId, title) => {
    setState((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      const tabs = CT_docTabs(doc).map((t) => (t.id === tabId ? { ...t, title: (title && title.trim()) || t.title } : { ...t }));
      return { ...s, docs: { ...s.docs, [docId]: { ...doc, tabs } } };
    });
  }, []);

  const deleteDocTab = useCallback((docId, tabId) => {
    setState((s) => {
      const doc = s.docs[docId];
      if (!doc) return s;
      let tabs = CT_docTabs(doc).map((t) => ({ ...t }));
      if (tabs.length <= 1) return s; // always keep at least one tab
      const idx = tabs.findIndex((t) => t.id === tabId);
      tabs = tabs.filter((t) => t.id !== tabId);
      const cur = s.docTabs ? s.docTabs[docId] : null;
      let nextActive = cur;
      if (cur === tabId || cur == null) nextActive = (tabs[Math.max(0, idx - 1)] || tabs[0]).id;
      return {
        ...s,
        docs: { ...s.docs, [docId]: { ...doc, tabs } },
        docTabs: { ...s.docTabs, [docId]: nextActive },
      };
    });
  }, []);

  // Accept all pending edits in a doc's tab. Defaults to the active talk's
  // doc + its active tab when ids are omitted.
  const acceptDocEdits = useCallback((docId, tabId) => {
    setState((s) => {
      const did = docId || s.talks[s.activeTalkId]?.docId;
      const doc = did ? s.docs[did] : null;
      if (!doc) return s;
      const tid = tabId || CT_docActiveTabId(s, doc);
      const tabs = CT_docTabs(doc).map((t) => (t.id === tid
        ? { ...t, blocks: (t.blocks || []).map((b) => ({ ...b, pending: false })) }
        : { ...t }));
      return { ...s, docs: { ...s.docs, [doc.id]: { ...doc, tabs } } };
    });
  }, []);

  // Reject all pending edits in a tab — drop those lines.
  const rejectDocEdits = useCallback((docId, tabId) => {
    setState((s) => {
      const did = docId || s.talks[s.activeTalkId]?.docId;
      const doc = did ? s.docs[did] : null;
      if (!doc) return s;
      const tid = tabId || CT_docActiveTabId(s, doc);
      const tabs = CT_docTabs(doc).map((t) => (t.id === tid
        ? { ...t, blocks: (t.blocks || []).filter((b) => !b.pending) }
        : { ...t }));
      return { ...s, docs: { ...s.docs, [doc.id]: { ...doc, tabs } } };
    });
  }, []);

  // ─── multi-agent run simulation ──────────────────────────────────
  // When user sends, we (a) add the user message, (b) queue all targeted
  // agents, then (c) for each one in order: queued→running→stream→completed.
  const sendMessage = useCallback((text) => {
    if (!text.trim()) return;
    setState((s) => {
      const talk = s.talks[s.activeTalkId];
      if (!talk) return s;
      const round = (Math.max(0, ...talk.messages.map((m) => m.round || 0))) + 1;
      const userMsg = {
        id: 'u-' + Date.now(),
        role: 'user',
        author: s.user.name.split(' ')[0],
        initials: s.user.initials,
        avatarColor: s.user.avatarColor,
        time: 'just now',
        text,
        round,
      };
      const targets = s.composerTargets.length ? s.composerTargets : talk.agents;
      const newAgentMsgs = targets.map((agentId, i) => ({
        id: 'a-' + Date.now() + '-' + i,
        role: 'agent',
        agentId,
        runId: 'r-' + Date.now() + '-' + i,
        runStatus: i === 0 ? 'running' : 'queued',
        queuePosition: i,
        streamingText: '',
        fullText: SIMULATED_REPLIES[agentId] || 'Acknowledged.',
        progress: i === 0 ? 'Composing response · 0 tokens' : null,
        round,
      }));
      return {
        ...s,
        composerText: '',
        talks: {
          ...s.talks,
          [talk.id]: {
            ...talk,
            running: true,
            messages: [...talk.messages, userMsg, ...newAgentMsgs],
          },
        },
      };
    });

    // Kick off streaming for the first agent right after state commits.
    setTimeout(() => beginNextStream(), 60);
  }, [setState]);

  // Simulated replies per agent.
  const SIMULATED_REPLIES = {
    'a-strategy': 'Holding my position. The hybrid case still pencils — but I\u2019d add: phase it. Quarter one as flat-per-seat to land procurement, quarter two introduce the credit pool as a "soft launch" alongside annual prepay.',
    'a-critic':   'Phasing is a fig leaf. If the credit pool is the right unit it should be the right unit on day one — staging it telegraphs that we\u2019re unsure. Pick a story and commit.',
    'a-research': 'Quick read on the comp shift: when Linear introduced their action-credit model phased, churn rose 4 pts in the first 90 days while customers re-modeled budgets. Phasing has a real cost in confusion.',
    'a-editor':   'Synthesizing both rounds. Recommendation: commit to seat + credit pool from day one, with a soft cap negotiated per-org. The phased option goes in an appendix, not the lead.',
  };

  function beginNextStream() {
    setState((s) => {
      const talk = s.talks[s.activeTalkId];
      if (!talk) return s;
      const idx = talk.messages.findIndex((m) => m.role === 'agent' && m.runStatus === 'running' && (m.streamingText === '' || m.streamingText === undefined || m.streamingText.length === 0));
      if (idx === -1) return s;
      // Already kicked, no-op
      return s;
    });
    runStreamingLoop();
  }

  // Streams one character at a time for the currently-running agent message.
  function runStreamingLoop() {
    const key = 'stream';
    if (streamTimers.current[key]) return;
    streamTimers.current[key] = setInterval(() => {
      setState((s) => {
        const talk = s.talks[s.activeTalkId];
        if (!talk) { clearInterval(streamTimers.current[key]); delete streamTimers.current[key]; return s; }
        const running = talk.messages.find((m) => m.runStatus === 'running');
        if (!running) {
          // Promote the next queued agent.
          const queuedIdx = talk.messages.findIndex((m) => m.runStatus === 'queued');
          if (queuedIdx === -1) {
            clearInterval(streamTimers.current[key]); delete streamTimers.current[key];
            return { ...s, talks: { ...s.talks, [talk.id]: { ...talk, running: false } } };
          }
          const updated = talk.messages.map((m, i) => i === queuedIdx
            ? { ...m, runStatus: 'running', streamingText: '', progress: 'Composing response · 0 tokens' }
            : m);
          return { ...s, talks: { ...s.talks, [talk.id]: { ...talk, messages: updated } } };
        }
        const target = running.fullText || '';
        const cur = running.streamingText || '';
        if (cur.length >= target.length) {
          // Mark completed.
          const updated = talk.messages.map((m) => m.id === running.id
            ? { ...m, runStatus: 'completed', text: target, streamingText: undefined, progress: undefined, time: 'just now',
                tokens: { in: 1200 + Math.floor(Math.random() * 800), out: Math.floor(target.length / 4) } }
            : m);
          return { ...s, talks: { ...s.talks, [talk.id]: { ...talk, messages: updated } } };
        }
        // Append 4–10 chars per tick for a quick but legible stream.
        const grow = 4 + Math.floor(Math.random() * 7);
        const next = target.slice(0, Math.min(target.length, cur.length + grow));
        const tokens = Math.floor(next.length / 4);
        const updated = talk.messages.map((m) => m.id === running.id
          ? { ...m, streamingText: next, progress: `Composing response · ${tokens} tokens` }
          : m);
        return { ...s, talks: { ...s.talks, [talk.id]: { ...talk, messages: updated } } };
      });
    }, 60);
  }

  // Start streaming for an in-progress pricing thread on load so the demo
  // looks alive when you first land on it.
  useEffect(() => {
    if (route === 'talk') runStreamingLoop();
    // eslint-disable-next-line
  }, [route, state.activeTalkId]);

  // Cancel all runs in active talk
  const cancelRuns = useCallback(() => {
    setState((s) => {
      const talk = s.talks[s.activeTalkId];
      if (!talk) return s;
      const updated = talk.messages.map((m) =>
        m.role === 'agent' && (m.runStatus === 'running' || m.runStatus === 'queued')
          ? { ...m, runStatus: 'cancelled', streamingText: undefined, progress: undefined, text: m.text || 'Cancelled before completing.' }
          : m);
      return { ...s, talks: { ...s.talks, [talk.id]: { ...talk, running: false, messages: updated } } };
    });
    Object.values(streamTimers.current).forEach((t) => clearInterval(t));
    streamTimers.current = {};
  }, []);

  // Reset to fresh demo
  const resetDemo = useCallback(() => {
    Object.values(streamTimers.current).forEach((t) => clearInterval(t));
    streamTimers.current = {};
    const fresh = buildInitialWorld();
    setState(fresh);
    setRoute('talk');
    setTimeout(() => runStreamingLoop(), 80);
  }, []);

  // ─── new Talk / folder / archive mutators ─────────────────────────
  const setShowNewTalkSheet = useCallback((v) => {
    setState((s) => ({ ...s, showNewTalkSheet: typeof v === 'function' ? v(s.showNewTalkSheet) : v }));
  }, []);

  const createTalk = useCallback(({ title, folderId, team, mode, rounds, prompt }) => {
    const id = 't-' + Date.now();
    const agents = team || ['a-strategy','a-critic','a-research','a-editor'];
    const folder = folderId === 'inbox' ? null : folderId;
    setState((s) => {
      const next = {
        ...s,
        talks: {
          ...s.talks,
          [id]: {
            id, title: title || (prompt ? prompt.split(/[.\n]/)[0].slice(0, 60) : 'New Talk'),
            folder: folder ? (s.folders.find((f) => f.id === folder)?.title || null) : null,
            mode: mode || 'Ordered', rounds: rounds || 3,
            agents,
            running: false, unread: 0, hasDoc: false,
            tools: s.defaultTools,
            messages: prompt ? [{
              id: 'u-' + Date.now(), role: 'user', author: s.user.name.split(' ')[0],
              initials: s.user.initials, avatarColor: s.user.avatarColor,
              time: 'just now', text: prompt, round: 1,
            }] : [],
          },
        },
        folders: folder
          ? s.folders.map((f) => f.id === folder ? { ...f, talkIds: [...f.talkIds, id] } : f)
          : s.folders,
        looseIds: folder ? s.looseIds : [id, ...s.looseIds],
        activeTalkId: id,
        showNewTalkSheet: false,
      };
      return next;
    });
    setRoute('talk');
  }, []);

  const createFolder = useCallback((name) => {
    if (!name || !name.trim()) return;
    const id = 'f-' + Date.now();
    setState((s) => ({
      ...s,
      folders: [{ id, title: name.trim(), expanded: true, talkIds: [] }, ...s.folders],
    }));
  }, []);

  const deleteFolder = useCallback((folderId, alsoTalks) => {
    setState((s) => {
      const folder = s.folders.find((f) => f.id === folderId);
      if (!folder) return s;
      const tids = folder.talkIds;
      if (alsoTalks) {
        const remaining = { ...s.talks };
        tids.forEach((id) => { delete remaining[id]; });
        return {
          ...s,
          folders: s.folders.filter((f) => f.id !== folderId),
          talks: remaining,
          folderDeleteDialog: null,
        };
      }
      // Keep talks, move them to inbox.
      return {
        ...s,
        folders: s.folders.filter((f) => f.id !== folderId),
        looseIds: [...tids, ...s.looseIds],
        talks: Object.fromEntries(Object.entries(s.talks).map(([k, t]) => tids.includes(k) ? [k, { ...t, folder: null }] : [k, t])),
        folderDeleteDialog: null,
      };
    });
  }, []);

  const moveTalk = useCallback((talkId, folderId) => {
    setState((s) => {
      const folders = s.folders.map((f) => ({ ...f, talkIds: f.talkIds.filter((id) => id !== talkId) }));
      let looseIds = s.looseIds.filter((id) => id !== talkId);
      let folderTitle = null;
      if (folderId === 'inbox' || !folderId) {
        looseIds = [talkId, ...looseIds];
      } else {
        const idx = folders.findIndex((f) => f.id === folderId);
        if (idx >= 0) { folders[idx] = { ...folders[idx], talkIds: [talkId, ...folders[idx].talkIds] }; folderTitle = folders[idx].title; }
      }
      return {
        ...s,
        folders,
        looseIds,
        talks: { ...s.talks, [talkId]: { ...s.talks[talkId], folder: folderTitle } },
      };
    });
  }, []);

  const renameTalk = useCallback((talkId, title) => {
    setState((s) => ({ ...s, talks: { ...s.talks, [talkId]: { ...s.talks[talkId], title } } }));
  }, []);

  const duplicateTalk = useCallback((talkId) => {
    setState((s) => {
      const src = s.talks[talkId];
      if (!src) return s;
      const id = 't-' + Date.now();
      const copy = { ...src, id, title: `${src.title} (copy)`, running: false,
        messages: src.messages.filter((m) => m.role === 'user').map((m) => ({ ...m, id: m.id + '-cp' })) };
      const updated = { ...s, talks: { ...s.talks, [id]: copy } };
      // Place in same folder if it had one, else inbox.
      const folder = s.folders.find((f) => f.talkIds.includes(talkId));
      if (folder) updated.folders = s.folders.map((f) => f.id === folder.id ? { ...f, talkIds: [id, ...f.talkIds] } : f);
      else updated.looseIds = [id, ...s.looseIds];
      updated.activeTalkId = id;
      return updated;
    });
    setRoute('talk');
  }, []);

  const archiveTalk = useCallback((talkId, alsoDoc) => {
    setState((s) => {
      const t = s.talks[talkId]; if (!t) return s;
      const folders = s.folders.map((f) => ({ ...f, talkIds: f.talkIds.filter((id) => id !== talkId) }));
      const looseIds = s.looseIds.filter((id) => id !== talkId);
      const archived = [talkId, ...(s.archivedTalkIds || [])];
      let docs = s.docs;
      if (t.docId) {
        if (alsoDoc) {
          docs = { ...docs };
          delete docs[t.docId];
        } else {
          docs = { ...docs, [t.docId]: { ...docs[t.docId], talkId: null } };
        }
      }
      // Pick a new active talk.
      const remainingIds = Object.keys(s.talks).filter((id) => id !== talkId && !archived.includes(id));
      const nextActive = remainingIds[0] || null;
      return {
        ...s,
        folders, looseIds, archivedTalkIds: archived, docs,
        activeTalkId: nextActive || s.activeTalkId,
        archiveTalkDialog: null,
      };
    });
  }, []);

  const setTalkSubpanel = useCallback((panel) => {
    setState((s) => ({ ...s, talkSubpanel: s.talkSubpanel === panel ? null : panel }));
  }, []);

  const setFolderDeleteDialog = useCallback((v) => setState((s) => ({ ...s, folderDeleteDialog: v })), []);
  const setArchiveTalkDialog  = useCallback((v) => setState((s) => ({ ...s, archiveTalkDialog: v })), []);

  // Derived
  const activeTalk = state.talks[state.activeTalkId];
  const activeDoc  = activeTalk?.docId ? state.docs[activeTalk.docId] : null;
  const activeDocTabId = CT_docActiveTabId(state, activeDoc);
  const activeDocTab   = CT_activeDocTab(state, activeDoc);

  const value = useMemo(() => ({
    state, setState, route, setRoute,
    setActiveTalk, setSettingsTab, setSelectedAgent, setSelectedDoc, toggleDoc, setShowCmdK, setComposerText, toggleTarget, toggleTool,
    sendMessage, cancelRuns, acceptDocEdits, rejectDocEdits, resetDemo,
    setDocTab, addDocTab, renameDocTab, deleteDocTab,
    setShowNewTalkSheet, createTalk, createFolder, deleteFolder, moveTalk, renameTalk, duplicateTalk, archiveTalk,
    setTalkSubpanel, setFolderDeleteDialog, setArchiveTalkDialog,
    activeTalk, activeDoc, activeDocTabId, activeDocTab,
  }), [state, route, activeTalk, activeDoc, activeDocTabId, activeDocTab]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

Object.assign(window, { AppProvider, useApp, buildInitialWorld });
