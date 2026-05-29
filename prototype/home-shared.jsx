/* eslint-disable */
// Home page — curator-driven dashboard with recommendations, activity
// feed, and news stream. Two layouts: split (2-col) and feed (single
// long scroll). User picks via Tweaks.

// ─── mock content ──────────────────────────────────────────────────────
// Each surfaces is keyed to a Talk so provenance lines work.

const CT_RECOMMENDATIONS = [
  {
    id: 'r1',
    kind: 'synthesis',
    title: 'Synthesize Pricing v2',
    why: 'Round 3 finished 2 h ago, Editor hasn\u2019t been kicked. Strategy and Critic agree on 3 of 5 points.',
    talkId: 't-pricing',
    action: 'Run synthesis',
    priority: 'high',
  },
  {
    id: 'r2',
    kind: 'cross-link',
    title: 'Pull Notion teardown into Pricing v2',
    why: 'Strategy Lead cites Notion comp numbers from memory that already live in your Notion teardown doc.',
    talkId: 't-pricing',
    relatedTalkId: 't-competitor',
    action: 'Add as context',
    priority: 'high',
  },
  {
    id: 'r3',
    kind: 'doc',
    title: 'Generate a decision doc for Launch comms',
    why: 'Four rounds in, no document. PH-vs-HN choice is scattered across messages and will be lost.',
    talkId: 't-launch',
    action: 'Draft doc',
    priority: 'med',
  },
  {
    id: 'r4',
    kind: 'unresolved',
    title: 'Resolve Critic\u2019s objection in Pricing v2',
    why: '"No usage cap" was raised twice and never addressed. Editor will synthesize over it.',
    talkId: 't-pricing',
    action: 'Open at turn',
    priority: 'med',
  },
  {
    id: 'r5',
    kind: 'recap',
    title: 'Recap Eng hiring loop notes',
    why: 'Untouched for 3 days. Researcher could surface what\u2019s already decided.',
    talkId: 't-hiring',
    action: 'Generate recap',
    priority: 'low',
  },
  {
    id: 'r6',
    kind: 'tool',
    title: 'Add a Web fetch tool to Notion teardown',
    why: 'Critic kept asking for live numbers but only Web search is on. Fetch is what they need.',
    talkId: 't-competitor',
    action: 'Enable tool',
    priority: 'low',
  },
];

const CT_ACTIVITY = [
  { id: 'e1', t: '2 m',  kind: 'stream',    agent: 'a-research',  talkId: 't-pricing',    text: 'Researcher is composing the comps response — 47 s in, 312 tokens.' },
  { id: 'e2', t: '8 m',  kind: 'complete',  agent: 'a-critic',    talkId: 't-pricing',    text: 'Critic finished round 3 — 488 tokens out, 2104 in.' },
  { id: 'e3', t: '12 m', kind: 'complete',  agent: 'a-strategy',  talkId: 't-pricing',    text: 'Strategy Lead finished round 3 — 624 tokens out.' },
  { id: 'e4', t: '14 m', kind: 'round',     agent: null,          talkId: 't-pricing',    text: 'Round 3 started in Pricing v2 — "poke holes, then synthesize."' },
  { id: 'e5', t: '2 h',  kind: 'doc',       agent: 'a-editor',    talkId: 't-pricing',    text: 'Editor proposed 2 edits to pricing-v2-draft.md — awaiting accept.' },
  { id: 'e6', t: '4 h',  kind: 'complete',  agent: 'a-editor',    talkId: 't-launch',     text: 'Editor closed round 2 of Launch comms with a single timeline.' },
  { id: 'e7', t: 'yesterday', kind: 'failed', agent: 'a-research', talkId: 't-competitor', text: 'Researcher\u2019s run failed in Notion teardown — gpt-5-pro rate-limited.' },
  { id: 'e8', t: 'yesterday', kind: 'complete', agent: 'a-critic',  talkId: 't-competitor', text: 'Critic finished comp analysis with latency p95 numbers.' },
  { id: 'e9', t: '3 d',  kind: 'complete', agent: 'a-research',  talkId: 't-hiring',     text: 'Researcher proposed a 3-loop interview structure in Eng hiring.' },
];

const CT_NEWS = [
  {
    id: 'n1',
    headline: 'Notion quietly raises Business pricing 10% to fund AI build-out',
    source: 'TechCrunch',
    favicon: 'TC',
    age: '4 h',
    excerpt: 'Notion Business moves from $20 to $22/seat starting March, with the AI add-on bundled at higher tiers.',
    talkId: 't-pricing',
    matchedOn: 'seat + usage hybrid · Notion AI pricing',
    kind: 'pricing-shift',
  },
  {
    id: 'n2',
    headline: 'The credit-pool pricing model is becoming the dev tool default',
    source: 'Lenny\u2019s Newsletter',
    favicon: 'LN',
    age: '1 d',
    excerpt: 'Linear, Vercel, and v0 all moved to credit pools in Q1. The author argues the unit needs to be visible to the buyer, not the engineer.',
    talkId: 't-pricing',
    matchedOn: 'pricing unit · credit pool',
    kind: 'opinion',
  },
  {
    id: 'n3',
    headline: 'Notion ships v4 of AI sidebar with cross-doc Q&A',
    source: 'Notion blog',
    favicon: 'N',
    age: '6 h',
    excerpt: 'Same sidebar surface, but the agent can now answer across an entire workspace, not just the current page.',
    talkId: 't-competitor',
    matchedOn: 'Notion AI · multi-doc reasoning',
    kind: 'product',
  },
  {
    id: 'n4',
    headline: 'How Linear announced Asks: a comms post-mortem',
    source: 'Hacker News',
    favicon: 'HN',
    age: '2 d',
    excerpt: 'The team broke the embargo themselves, posted directly to HN at 9am ET, and reserved a counter-thread for the Day-2 critique. Net positive: 1.2k upvotes.',
    talkId: 't-launch',
    matchedOn: 'launch comms · PH vs HN',
    kind: 'tactic',
  },
  {
    id: 'n5',
    headline: 'Senior infra interview questions that actually predict performance',
    source: 'a16z',
    favicon: 'a16',
    age: '1 w',
    excerpt: 'Across 240 interviews, paired debugging on a broken service was the strongest single signal. Whiteboarding system design was the weakest.',
    talkId: 't-hiring',
    matchedOn: 'senior infra · interview loop',
    kind: 'research',
  },
  {
    id: 'n6',
    headline: '"We dropped tokens from our pricing page. Activation went up 11%."',
    source: 'Substack · Pricing',
    favicon: 'S',
    age: '3 d',
    excerpt: 'Buyer-facing token counts make procurement nervous. The author renamed them "AI actions" and saw conversion lift on the team plan.',
    talkId: 't-pricing',
    matchedOn: 'tokens vs actions · procurement',
    kind: 'tactic',
  },
];

// ─── helpers ──────────────────────────────────────────────────────────

function curatorHeadline(state) {
  const talks = Object.values(state.talks || {});
  const streaming = talks.filter((t) => t.running).length;
  const decisionsNeeded = CT_RECOMMENDATIONS.filter((r) => r.priority === 'high').length;
  if (streaming) {
    const live = talks.find((t) => t.running);
    return `${decisionsNeeded} ${decisionsNeeded === 1 ? 'decision needs' : 'decisions need'} you. "${live.title}" is mid-stream.`;
  }
  return `${decisionsNeeded} ${decisionsNeeded === 1 ? 'decision' : 'decisions'} on the table. Nothing\u2019s running right now.`;
}

function computeStats(state) {
  const talks = Object.values(state.talks || {});
  const active = talks.filter((t) => t.running).length;
  // Sum tokens out across completed agent messages.
  let tokensToday = 0, rounds = 0;
  for (const t of talks) {
    for (const m of t.messages) {
      if (m.tokens) tokensToday += (m.tokens.in || 0) + (m.tokens.out || 0);
      if (m.round && m.role === 'agent') rounds = Math.max(rounds, m.round);
    }
  }
  // Pretty.
  const tk = tokensToday >= 1000 ? `${(tokensToday / 1000).toFixed(1)}k` : String(tokensToday);
  return [
    { l: 'Tokens today',    v: tk,                  sub: 'of 200k included' },
    { l: 'Active runs',     v: String(active + (active ? 1 : 0)),  sub: active ? 'streaming + queued' : 'idle' },
    { l: 'Rounds this week',v: String(7 + rounds),  sub: '+ 3 vs last week' },
    { l: 'Talks moving',    v: String(talks.filter((t) => t.messages.length > 1).length),  sub: `of ${talks.length} total` },
  ];
}

// ─── atoms shared between layouts ────────────────────────────────────

function StatStrip({ stats, dense = false }) {
  return (
    <div className={`grid grid-cols-4 gap-${dense ? '2.5' : '3'}`}>
      {stats.map((s) => (
        <div key={s.l} className={`rounded-xl ${dense ? 'p-3' : 'p-3.5'} flex flex-col gap-0.5`}
          style={{ background: S.card, border: `1px solid ${S.line}` }}>
          <div className="text-[10.5px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>{s.l}</div>
          <div className="font-serif text-[24px] leading-none" style={{ color: S.ink }}>{s.v}</div>
          <div className="text-[11px]" style={{ color: S.ink2 }}>{s.sub}</div>
        </div>
      ))}
    </div>
  );
}

function CuratorBar({ state }) {
  return (
    <div className="rounded-2xl p-4 flex items-start gap-3"
      style={{ background: `linear-gradient(180deg, ${S.paper2} 0%, ${S.paper} 100%)`, border: `1px solid ${S.line}` }}>
      <div className="w-9 h-9 rounded-xl grid place-items-center font-serif text-[14px] shrink-0"
        style={{ background: S.accent, color: '#FFF' }}>C</div>
      <div className="flex-1 min-w-0">
        <div className="text-[10.5px] font-mono uppercase tracking-[0.16em] mb-0.5" style={{ color: S.ink2 }}>Curator</div>
        <div className="font-serif text-[18px] leading-snug" style={{ color: S.ink }}>{curatorHeadline(state)}</div>
      </div>
      <button className="text-[11.5px] underline underline-offset-2" style={{ color: S.ink2 }}>Why this →</button>
    </div>
  );
}

function HomeComposer() {
  const { setRoute } = useApp();
  const [val, setVal] = useState('');
  const templates = ['Pricing review', 'Competitor teardown', 'Launch comms plan', 'Weekly review', 'Hiring loop'];
  return (
    <div className="rounded-2xl p-4" style={{ background: S.card, border: `1px solid ${S.line}`, boxShadow: '0 2px 12px rgba(31,27,22,0.04)' }}>
      <div className="flex items-baseline gap-2 mb-2">
        <span className="font-serif text-[15px]" style={{ color: S.ink }}>Start a new room</span>
        <span className="text-[11.5px]" style={{ color: S.ink2 }}>or ask the curator about your existing Talks</span>
      </div>
      <textarea value={val} onChange={(e) => setVal(e.target.value)}
        placeholder="What should the room argue about? …"
        className="w-full bg-transparent outline-none resize-none font-serif text-[16px] leading-[1.55] px-1 min-h-[64px]"
        style={{ color: S.ink }} />
      <div className="flex items-center justify-between mt-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          {templates.map((t) => (
            <button key={t} onClick={() => setVal(`Run a ${t.toLowerCase()}: `)}
              className="text-[11.5px] px-2 py-1 rounded-full"
              style={{ background: S.paper2, color: S.ink, border: `1px solid ${S.line}` }}>
              {t}
            </button>
          ))}
        </div>
        <button onClick={() => { setRoute('talk'); }} disabled={!val.trim()}
          className="h-9 px-4 rounded-full text-[13px] font-medium text-white inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: S.accent }}>
          Open room <CTIcon name="send" size={13} stroke="#FFF" />
        </button>
      </div>
    </div>
  );
}

// ─── recommendation card ─────────────────────────────────────────────

function RecommendationCard({ rec, dense = false }) {
  const { state, setActiveTalk } = useApp();
  const talk = state.talks[rec.talkId];
  const relatedTalk = rec.relatedTalkId ? state.talks[rec.relatedTalkId] : null;
  const pri = rec.priority;
  const priBadge = pri === 'high'
    ? { bg: '#FBECEC', fg: '#7B2A30', label: 'Decide' }
    : pri === 'med'
      ? { bg: '#FAF1DE', fg: '#7E5418', label: 'Improve' }
      : { bg: S.paper2, fg: S.ink2, label: 'Tidy' };
  const kindIcon = {
    'synthesis':  'sparkle',
    'cross-link': 'paperclip',
    'doc':        'doc',
    'unresolved': 'bolt',
    'recap':      'sparkle',
    'tool':       'globe',
  }[rec.kind] || 'sparkle';

  return (
    <div className={`rounded-2xl ${dense ? 'p-4' : 'p-4'} flex flex-col gap-2 group`}
      style={{
        background: S.card,
        border: `1px solid ${S.line}`,
        boxShadow: pri === 'high' ? `inset 3px 0 0 ${S.accent}` : 'none',
      }}>
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium"
          style={{ background: priBadge.bg, color: priBadge.fg }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: priBadge.fg }} />
          {priBadge.label}
        </span>
        <span className="text-[10.5px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>
          Curator · 2 m ago
        </span>
        <button className="ml-auto w-6 h-6 grid place-items-center rounded opacity-0 group-hover:opacity-100"
          style={{ color: S.ink2 }} title="Dismiss"><CTIcon name="x" size={12} /></button>
      </div>

      <div className="flex items-start gap-2.5">
        <span className="w-7 h-7 rounded-lg grid place-items-center shrink-0 mt-0.5"
          style={{ background: S.paper2, color: S.accent }}>
          <CTIcon name={kindIcon} size={13} stroke={S.accent} strokeWidth={1.8} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-serif text-[17px] leading-snug" style={{ color: S.ink }}>{rec.title}</div>
          <div className="text-[12.5px] leading-snug mt-1" style={{ color: S.ink2 }}>{rec.why}</div>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-1">
        {talk ? (
          <button onClick={() => setActiveTalk(talk.id)}
            className="inline-flex items-center gap-1.5 text-[11.5px] px-2 py-0.5 rounded-full"
            style={{ background: S.paper, color: S.ink2, border: `1px solid ${S.line}` }}>
            <CTIcon name="chat" size={11} stroke={S.ink2} /> {talk.title.length > 28 ? talk.title.slice(0, 26) + '…' : talk.title}
          </button>
        ) : null}
        {relatedTalk ? (
          <>
            <span className="text-[11px]" style={{ color: S.ink2 }}>×</span>
            <button className="inline-flex items-center gap-1.5 text-[11.5px] px-2 py-0.5 rounded-full"
              style={{ background: S.paper, color: S.ink2, border: `1px solid ${S.line}` }}>
              <CTIcon name="chat" size={11} stroke={S.ink2} /> {relatedTalk.title}
            </button>
          </>
        ) : null}
        <button className="ml-auto h-7 px-2.5 text-[12px] rounded-full font-medium text-white inline-flex items-center gap-1"
          style={{ background: S.accent }}>
          {rec.action} <CTIcon name="arrow" size={11} stroke="#FFF" />
        </button>
      </div>
    </div>
  );
}

// ─── activity row ────────────────────────────────────────────────────

function ActivityRow({ ev }) {
  const { state, setActiveTalk } = useApp();
  const talk = state.talks[ev.talkId];
  const agent = ev.agent ? CT_AGENTS.find((a) => a.id === ev.agent) : null;
  const iconMap = {
    stream:   { icon: 'sparkle', color: agent?.accent || S.accent },
    complete: { icon: 'check',   color: '#3F6B5C' },
    failed:   { icon: 'x',       color: '#A8434A' },
    round:    { icon: 'chevron-r', color: S.ink2 },
    doc:      { icon: 'doc',     color: S.ink2 },
  };
  const m = iconMap[ev.kind] || iconMap.complete;
  return (
    <button onClick={() => talk && setActiveTalk(talk.id)} className="w-full text-left flex items-start gap-2.5 py-2.5 px-1 rounded-lg hover:bg-[var(--salon-paper-2)] transition-colors">
      <span className="w-6 h-6 rounded-full grid place-items-center shrink-0 mt-0.5"
        style={{ background: `${m.color}1A`, color: m.color }}>
        <CTIcon name={m.icon} size={11} stroke={m.color} strokeWidth={2} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] leading-snug" style={{ color: S.ink }}>
          {agent ? <span className="font-medium">{agent.name} </span> : null}
          {ev.text}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[10.5px] font-mono" style={{ color: S.ink2 }}>{ev.t} ago</span>
          {talk ? (
            <>
              <span className="text-[10.5px]" style={{ color: S.ink2 }}>·</span>
              <span className="text-[10.5px] truncate" style={{ color: S.ink2 }}>{talk.title}</span>
            </>
          ) : null}
        </div>
      </div>
    </button>
  );
}

// ─── news card ───────────────────────────────────────────────────────

function NewsCard({ item, dense = false }) {
  const { state, setActiveTalk } = useApp();
  const talk = state.talks[item.talkId];
  return (
    <div className={`rounded-2xl ${dense ? 'p-3.5' : 'p-4'} flex flex-col gap-2 group`}
      style={{ background: S.card, border: `1px solid ${S.line}` }}>
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 rounded grid place-items-center font-mono text-[10px] font-medium"
          style={{ background: S.paper2, color: S.ink, border: `1px solid ${S.line}` }}>{item.favicon}</span>
        <span className="text-[11.5px] font-medium" style={{ color: S.ink }}>{item.source}</span>
        <span className="text-[10.5px]" style={{ color: S.ink2 }}>· {item.age} ago</span>
        <span className="ml-auto text-[10px] uppercase tracking-widest font-mono px-1.5 py-0.5 rounded"
          style={{ background: S.paper2, color: S.ink2 }}>{item.kind}</span>
      </div>
      <div className="font-serif text-[16px] leading-snug" style={{ color: S.ink }}>{item.headline}</div>
      <div className="text-[12.5px] leading-snug" style={{ color: S.ink2 }}>{item.excerpt}</div>
      <div className="flex items-center gap-2 mt-1 flex-wrap">
        <span className="text-[10.5px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>Matched</span>
        {talk ? (
          <button onClick={() => setActiveTalk(talk.id)} className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full"
            style={{ background: S.paper, color: S.ink, border: `1px solid ${S.line}` }}>
            <CTIcon name="chat" size={10} stroke={S.ink2} /> {talk.title.length > 28 ? talk.title.slice(0, 26) + '…' : talk.title}
          </button>
        ) : null}
        <span className="text-[10.5px] font-mono italic" style={{ color: S.ink2 }}>· {item.matchedOn}</span>
        <div className="ml-auto flex items-center gap-1">
          <button className="text-[11px] px-2 py-1 rounded hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink2 }}>Snooze</button>
          <button className="text-[11px] px-2 py-1 rounded hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink2 }}>Add to context</button>
          <button className="text-[11px] px-2 py-1 rounded hover:bg-[var(--salon-paper-2)] font-medium" style={{ color: S.ink }}>Open ↗</button>
        </div>
      </div>
    </div>
  );
}

// Wrapper to give feed items a label band (for the long-feed variant).
function FeedSection({ title, count, children }) {
  return (
    <section className="mb-4">
      <div className="flex items-baseline gap-2 mb-2.5">
        <h3 className="font-serif text-[18px] leading-none" style={{ color: S.ink }}>{title}</h3>
        <span className="text-[10.5px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>{count}</span>
        <div className="flex-1 h-px ml-2" style={{ background: S.line }} />
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

Object.assign(window, {
  CT_RECOMMENDATIONS, CT_ACTIVITY, CT_NEWS,
  curatorHeadline, computeStats,
  StatStrip, CuratorBar, HomeComposer,
  RecommendationCard, ActivityRow, NewsCard, FeedSection,
});
