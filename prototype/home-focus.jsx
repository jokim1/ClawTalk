/* eslint-disable */
// Home · Focus layout — single wide column, opinionated stack:
//   1. Wide 4-card stat strip (Operator-style)
//   2. ONE hero "Next best action" card (the curator's headline pick)
//   3. 2–3 smaller recommendation cards (full width, stacked)
//   4. News (Perplexity-discover-style cards with thumbnail)

// ─── Wide stat strip — Operator-flavored, light palette ───────────────
// Each card carries TWO numbers: today (headline) and this-month (sub),
// so the strip reads as a "where have I been" recap, not an ephemeral
// system status.

function FocusStatStrip() {
  const { state } = useApp();
  const talks = Object.values(state.talks || {});

  // Today: from current loaded thread state.
  let tokensToday = 0, wordsToday = 0, promptsToday = 0;
  for (const t of talks) {
    for (const m of t.messages) {
      if (m.tokens) tokensToday += (m.tokens.in || 0) + (m.tokens.out || 0);
      const body = (m.text || m.streamingText || '');
      if (body) wordsToday += body.trim().split(/\s+/).filter(Boolean).length;
      if (m.role === 'user') promptsToday += 1;
    }
  }
  // This month — derived multipliers (mocked, since we don't have history).
  const tokensMonth   = Math.max(tokensToday * 14, 184200);
  const wordsMonth    = Math.max(wordsToday  * 18, 12400);
  const promptsMonth  = Math.max(promptsToday * 22, 312);

  const fmt = (n) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
                   : n >= 1_000     ? `${(n / 1_000).toFixed(1)}k`
                   :                   String(n);

  const cards = [
    {
      l: 'Talks',
      v: String(talks.length),
      vSub: `${talks.filter((t) => t.running).length} active · ${talks.filter((t) => t.unread).length} new`,
      direct: true, // no today/month split
    },
    {
      l: 'Prompts',
      v: String(promptsToday),
      vSub: `${promptsMonth.toLocaleString()} this month`,
    },
    {
      l: 'Tokens',
      v: fmt(tokensToday),
      vSub: `${fmt(tokensMonth)} this month`,
    },
    {
      l: 'Words',
      v: fmt(wordsToday),
      vSub: `${fmt(wordsMonth)} this month`,
    },
  ];

  return (
    <div className="grid grid-cols-4 gap-3">
      {cards.map((c, i) => (
        <div key={c.l} className="rounded-2xl p-4"
          style={{ background: S.card, border: `1px solid ${S.line}` }}>
          <div className="flex items-center justify-between">
            <div className="text-[10.5px] font-mono uppercase tracking-[0.18em]" style={{ color: S.ink2 }}>{c.l}</div>
            {c.direct ? null : (
              <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>Today</div>
            )}
          </div>
          <div className="font-serif text-[34px] leading-none tracking-tight mt-1.5" style={{ color: S.ink }}>{c.v}</div>
          <div className="h-px mt-3 mb-2" style={{ background: S.line }} />
          <div className="text-[11.5px]" style={{ color: S.ink2 }}>{c.vSub}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Hero "Next best action" card ─────────────────────────────────────
// Picks the single highest-priority recommendation and renders it like
// the original featured pinned card — two-column inside, with a live
// preview pane on the right if the related Talk is streaming.

function HeroNBACard() {
  const { state, setActiveTalk } = useApp();
  // Pull the first high-priority rec — that's the curator's pick.
  const top = CT_RECOMMENDATIONS.find((r) => r.priority === 'high') || CT_RECOMMENDATIONS[0];
  const talk = state.talks[top.talkId];
  if (!talk) return null;
  const streamingMsg = talk.messages.find((m) => m.runStatus === 'running');
  const streamingAgent = streamingMsg ? CT_AGENTS.find((a) => a.id === streamingMsg.agentId) : null;

  return (
    <div className="rounded-2xl p-6 grid grid-cols-[1.35fr_1fr] gap-6 relative overflow-hidden"
      style={{
        background: S.card,
        border: `1px solid ${S.line}`,
        boxShadow: `inset 4px 0 0 ${S.accent}, 0 12px 32px rgba(31,27,22,0.06)`,
      }}>
      <div>
        <div className="flex items-center gap-2 mb-2.5 flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium"
            style={{ background: '#FBECEC', color: '#7B2A30' }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#7B2A30' }} />
            Decide first
          </span>
          <span className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>
            Curator · the single most useful thing right now
          </span>
        </div>

        <h2 className="font-serif text-[28px] leading-tight tracking-tight" style={{ color: S.ink }}>
          {top.title}
        </h2>
        <p className="font-serif italic text-[15px] leading-relaxed mt-2" style={{ color: S.ink2 }}>
          {top.why}
        </p>

        <div className="flex items-center gap-2 mt-4 flex-wrap">
          {talk.agents.map((id) => {
            const a = CT_AGENTS.find((x) => x.id === id);
            return a ? <AgentAvatar key={id} agent={a} size={28} ring /> : null;
          })}
          <span className="text-[12px] ml-1" style={{ color: S.ink2 }}>
            Round {Math.max(...talk.messages.map((m) => m.round || 1))} of {talk.rounds} · {talk.messages.length} messages
          </span>
        </div>

        <div className="flex items-center gap-2 mt-5">
          <button className="h-9 px-4 rounded-full text-[13px] font-medium text-white inline-flex items-center gap-1.5"
            style={{ background: S.accent }}>
            {top.action} <CTIcon name="arrow" size={13} stroke="#FFF" strokeWidth={2} />
          </button>
          <button onClick={() => setActiveTalk(talk.id)}
            className="h-9 px-3 rounded-full text-[13px] inline-flex items-center gap-1.5"
            style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>
            <CTIcon name="chat" size={13} stroke={S.ink2} /> Open Talk
          </button>
          <button className="h-9 px-3 rounded-full text-[13px] ml-auto" style={{ color: S.ink2 }}>
            Why this →
          </button>
        </div>
      </div>

      {/* Live preview / context column */}
      <div className="rounded-xl p-4 flex flex-col" style={{ background: S.paper, border: `1px solid ${S.line}` }}>
        {streamingMsg && streamingAgent ? (
          <>
            <div className="text-[10px] uppercase tracking-[0.18em] font-mono" style={{ color: S.ink2 }}>Live</div>
            <div className="mt-1.5 text-[12.5px] leading-[1.55]" style={{ color: S.ink }}>
              <span className="font-medium">{streamingAgent.name}</span>{' '}
              <span className="italic" style={{ color: S.ink2 }}>
                "{((streamingMsg.streamingText || '').slice(-160))}"
              </span>
              <span className="ct-caret" style={{ color: streamingAgent.accent, height: 12 }} />
            </div>
            <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-mono" style={{ color: streamingAgent.accent }}>
              <span className="w-1.5 h-1.5 rounded-full ct-pulse" style={{ background: streamingAgent.accent }} />
              Reading 3 comps · synthesizing
            </div>
            <button onClick={() => setActiveTalk(talk.id)}
              className="mt-auto self-end text-[12px] font-medium underline underline-offset-2" style={{ color: S.ink }}>
              Jump to thread →
            </button>
          </>
        ) : (
          <>
            <div className="text-[10px] uppercase tracking-[0.18em] font-mono" style={{ color: S.ink2 }}>Context</div>
            <div className="mt-1.5 text-[12.5px] leading-[1.55]" style={{ color: S.ink }}>
              <p className="mb-2"><span className="font-medium">3 agreements:</span> seat anchor at $32, annual prepay discount, premium positioning above Notion AI.</p>
              <p><span className="font-medium">2 disagreements:</span> phased vs day-one credit pool, hard cap vs soft cap.</p>
            </div>
            <button onClick={() => setActiveTalk(talk.id)}
              className="mt-auto self-end text-[12px] font-medium underline underline-offset-2" style={{ color: S.ink }}>
              Open thread →
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Wide "Discover-style" news card ──────────────────────────────────
// Thumbnail block on the right (gradient + source glyph — we don't have
// real photos in the mock), headline + excerpt left, provenance footer.

const NEWS_PALETTE = {
  'TechCrunch':            { bg: '#0F9F4F', fg: '#FFFFFF', mark: 'TC' },
  'Lenny\u2019s Newsletter': { bg: '#1F1B16', fg: '#F4C75A', mark: 'L' },
  'Notion blog':           { bg: '#1F1B16', fg: '#FBF7EF', mark: 'N' },
  'Hacker News':           { bg: '#FF6600', fg: '#FFFFFF', mark: 'Y' },
  'a16z':                  { bg: '#FBF7EF', fg: '#1F1B16', mark: 'a16' },
  'Substack · Pricing':    { bg: '#FF6719', fg: '#FFFFFF', mark: 'S' },
};

function NewsThumb({ source, kind }) {
  const p = NEWS_PALETTE[source] || { bg: S.paper2, fg: S.ink, mark: source[0] };
  return (
    <div className="rounded-xl shrink-0 grid place-items-center relative overflow-hidden"
      style={{ width: 200, height: 132, background: p.bg, color: p.fg, border: `1px solid ${S.line}` }}>
      {/* Decorative gradient overlay */}
      <div className="absolute inset-0 pointer-events-none" style={{
        background: 'radial-gradient(80% 60% at 30% 20%, rgba(255,255,255,0.18) 0%, transparent 60%), radial-gradient(60% 50% at 80% 100%, rgba(0,0,0,0.18) 0%, transparent 70%)',
      }} />
      <div className="relative font-serif text-[42px] leading-none tracking-tight">{p.mark}</div>
      <div className="absolute bottom-2 left-3 text-[10px] uppercase tracking-[0.18em] font-mono opacity-85">{kind}</div>
    </div>
  );
}

function WideNewsCard({ item }) {
  const { state, setActiveTalk } = useApp();
  const talk = state.talks[item.talkId];
  return (
    <div className="rounded-2xl p-4 flex gap-4 group transition-shadow hover:shadow-md"
      style={{ background: S.card, border: `1px solid ${S.line}` }}>
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded grid place-items-center font-mono text-[9.5px] font-medium"
            style={{ background: S.paper2, color: S.ink, border: `1px solid ${S.line}` }}>{item.favicon}</span>
          <span className="text-[11.5px] font-medium" style={{ color: S.ink }}>{item.source}</span>
          <span className="text-[11px]" style={{ color: S.ink2 }}>· {item.age} ago</span>
          <span className="ml-auto text-[10px] uppercase tracking-widest font-mono px-1.5 py-0.5 rounded"
            style={{ background: S.paper2, color: S.ink2 }}>{item.kind}</span>
        </div>

        <h3 className="font-serif text-[20px] leading-snug tracking-tight mt-1.5" style={{ color: S.ink }}>{item.headline}</h3>
        <p className="text-[13px] leading-[1.55] mt-1.5" style={{ color: S.ink2 }}>{item.excerpt}</p>

        <div className="flex items-center gap-2 mt-auto pt-2 flex-wrap">
          <span className="text-[10.5px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>Matched</span>
          {talk ? (
            <button onClick={() => setActiveTalk(talk.id)}
              className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full"
              style={{ background: S.paper, color: S.ink, border: `1px solid ${S.line}` }}>
              <CTIcon name="chat" size={10} stroke={S.ink2} /> {talk.title.length > 30 ? talk.title.slice(0, 28) + '…' : talk.title}
            </button>
          ) : null}
          <span className="text-[10.5px] font-mono italic" style={{ color: S.ink2 }}>· {item.matchedOn}</span>
          <div className="ml-auto flex items-center gap-1">
            <button className="text-[11.5px] px-2 py-1 rounded hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink2 }}>Snooze</button>
            <button className="text-[11.5px] px-2 py-1 rounded hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink2 }}>Add to context</button>
            <button className="text-[11.5px] px-2 py-1 rounded hover:bg-[var(--salon-paper-2)] font-medium" style={{ color: S.ink }}>Open ↗</button>
          </div>
        </div>
      </div>

      <NewsThumb source={item.source} kind={item.kind} />
    </div>
  );
}

// ─── The full Focus layout ────────────────────────────────────────────

function HomeFocus() {
  const { state } = useApp();
  // Skip the rec that's already showing in the hero so we don't dupe.
  const heroId = (CT_RECOMMENDATIONS.find((r) => r.priority === 'high') || CT_RECOMMENDATIONS[0])?.id;
  const otherRecs = CT_RECOMMENDATIONS.filter((r) => r.id !== heroId).slice(0, 3);

  return (
    <div className="flex-1 min-w-0 flex flex-col ct-screen-enter">
      <HomeTopBar />
      <div className="flex-1 overflow-y-auto px-9 py-7 ct-thin-scroll">
        <div className="max-w-[1240px] mx-auto flex flex-col gap-7">

          <HomeGreeting />

          {/* Usage / activity strip */}
          <FocusStatStrip />

          {/* The curator's single pick — full-width hero */}
          <div>
            <div className="flex items-baseline gap-2 mb-3">
              <h3 className="font-serif text-[20px] leading-none" style={{ color: S.ink }}>Do this next</h3>
              <span className="text-[10.5px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>
                Curator pick · 2 m ago
              </span>
              <div className="flex-1 h-px ml-2" style={{ background: S.line }} />
              <button className="text-[11.5px] inline-flex items-center gap-1" style={{ color: S.ink2 }}>
                <CTIcon name="sparkle" size={11} stroke={S.ink2} /> Re-pick
              </button>
            </div>
            <HeroNBACard />
          </div>

          {/* Smaller follow-ups */}
          <div>
            <div className="flex items-baseline gap-2 mb-3">
              <h3 className="font-serif text-[20px] leading-none" style={{ color: S.ink }}>Then maybe</h3>
              <span className="text-[10.5px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>
                {otherRecs.length} more
              </span>
              <div className="flex-1 h-px ml-2" style={{ background: S.line }} />
            </div>
            <div className="flex flex-col gap-3">
              {otherRecs.map((r) => <RecommendationCard key={r.id} rec={r} />)}
            </div>
          </div>

          {/* News */}
          <div>
            <div className="flex items-baseline gap-2 mb-3">
              <h3 className="font-serif text-[20px] leading-none" style={{ color: S.ink }}>News for your Talks</h3>
              <span className="text-[10.5px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>
                {CT_NEWS.length} stories · live
              </span>
              <div className="flex-1 h-px ml-2" style={{ background: S.line }} />
              <span className="text-[11px]" style={{ color: S.ink2 }}>
                pulled from Talks with <span className="font-mono">News monitor</span> on
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3">
              {CT_NEWS.map((n) => <WideNewsCard key={n.id} item={n} />)}
            </div>
          </div>

          <div className="text-center text-[11.5px] py-2" style={{ color: S.ink2 }}>
            That\u2019s today\u2019s curation. Refresh to re-rank, or <span className="underline cursor-pointer">start a new room</span>.
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  FocusStatStrip, HeroNBACard, NewsThumb, WideNewsCard, HomeFocus,
});
