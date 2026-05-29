/* eslint-disable */
// Salon prototype — screens: SignIn, Home, TalkDetail, Settings, CmdKPalette.

// ─── SignIn ────────────────────────────────────────────────────────────

function SignInScreen() {
  const { setRoute } = useApp();
  const [email, setEmail] = useState('samira@oxbow.co');
  const onSubmit = (e) => { e?.preventDefault(); setRoute('home'); };
  return (
    <div className="w-full min-h-screen grid grid-cols-1 lg:grid-cols-[1.05fr_1fr] ct-screen-enter" style={{ background: S.paper, color: S.ink }}>
      <div className="hidden lg:flex p-12 flex-col" style={{ background: S.paper2 }}>
        <div className="flex items-center gap-3">
          <CTMarkSalon size={36} accent={S.accent} />
          <span className="font-serif text-[20px]">ClawTalk</span>
        </div>
        <div className="my-auto max-w-[480px]">
          <div className="text-[11px] font-mono uppercase tracking-[0.18em] mb-5" style={{ color: S.ink2 }}>The salon · multi-agent rooms</div>
          <h1 className="font-serif text-[58px] leading-[1.05] tracking-tight" style={{ color: S.ink }}>
            A room where four <em className="not-italic" style={{ color: S.accent }}>different minds</em> argue your question out loud.
          </h1>
          <p className="font-serif text-[18px] leading-[1.55] mt-6" style={{ color: S.ink2 }}>
            Invite Claude, GPT, Gemini, and a critic into a Talk. Watch them propose, push back, and synthesize — then walk away with the draft.
          </p>
          <div className="mt-9 flex items-center gap-3">
            <div className="flex -space-x-2">
              {CT_AGENTS.map((a) => <AgentAvatar key={a.id} agent={a} size={28} ring />)}
            </div>
            <span className="text-[12.5px]" style={{ color: S.ink2 }}>Strategy · Critic · Researcher · Editor</span>
          </div>
        </div>
        <div className="flex items-center gap-5 text-[12px]" style={{ color: S.ink2 }}>
          <span>© 2026 ClawTalk Inc.</span>
          <span>·</span><span>clawtalk.app</span>
          <span>·</span><span>SOC 2 Type II</span>
        </div>
      </div>

      <form onSubmit={onSubmit} className="p-12 flex flex-col" style={{ background: S.paper }}>
        <div className="ml-auto flex items-center gap-3 text-[12.5px]" style={{ color: S.ink2 }}>
          No account?
          <a className="underline underline-offset-4 font-medium" style={{ color: S.ink }}>Request access →</a>
        </div>
        <div className="my-auto max-w-[400px] w-full mx-auto">
          <h2 className="font-serif text-[34px] leading-none mb-2" style={{ color: S.ink }}>Welcome back</h2>
          <p className="text-[14px] mb-8" style={{ color: S.ink2 }}>Sign in to your salon.</p>

          <button type="button" onClick={onSubmit}
            className="w-full h-12 rounded-xl flex items-center justify-center gap-3 text-[14px] font-medium mb-3"
            style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>
            <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8a12 12 0 1 1 0-24c3.1 0 5.9 1.2 8 3l5.6-5.6A20 20 0 1 0 24 44a20 20 0 0 0 19.6-23.5"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8A12 12 0 0 1 24 12c3.1 0 5.9 1.2 8 3l5.6-5.6A20 20 0 0 0 6.3 14.7"/><path fill="#4CAF50" d="M24 44c5.1 0 9.7-2 13.2-5.2l-6.1-5.2a12 12 0 0 1-19-5.6L5.5 33A20 20 0 0 0 24 44"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.1 5.2C36.9 41.4 44 36 44 24c0-1.2-.1-2.4-.4-3.5"/></svg>
            Continue with Google
          </button>
          <button type="button" onClick={onSubmit}
            className="w-full h-12 rounded-xl flex items-center justify-center gap-3 text-[14px] font-medium"
            style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 0 0-2.5 15.6c.4.1.5-.2.5-.4v-1.6c-2.2.5-2.7-1-2.7-1-.4-1-.9-1.2-.9-1.2-.7-.5 0-.5 0-.5.8.1 1.2.9 1.2.9.7 1.3 2 .9 2.5.7.1-.6.3-1 .5-1.2-1.7-.2-3.6-.9-3.6-3.9 0-.9.3-1.6.8-2.1-.1-.2-.3-1 .1-2.1 0 0 .7-.2 2.2.8a7.5 7.5 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.5.8 1.2.8 2.1 0 3-1.9 3.7-3.6 3.9.3.3.6.8.6 1.6v2.3c0 .2.1.5.5.4A8 8 0 0 0 8 0Z"/></svg>
            Continue with GitHub
          </button>

          <div className="flex items-center gap-3 my-6">
            <div className="flex-1 h-px" style={{ background: S.line }} />
            <span className="text-[11px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>or with email</span>
            <div className="flex-1 h-px" style={{ background: S.line }} />
          </div>

          <label className="block text-[12px] mb-1.5" style={{ color: S.ink2 }}>Work email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)}
            className="w-full h-11 px-3.5 rounded-xl text-[14px] outline-none mb-3 focus:ring-2"
            style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}`, ['--tw-ring-color']: S.accent + '55' }} />
          <button type="submit"
            className="w-full h-11 rounded-xl text-[14px] font-medium text-white" style={{ background: S.accent }}>
            Send magic link →
          </button>

          <p className="text-[11.5px] mt-6 leading-relaxed" style={{ color: S.ink2 }}>
            By signing in you agree to the <span className="underline">Terms</span> and <span className="underline">Privacy Policy</span>.
          </p>
        </div>
      </form>
    </div>
  );
}

// ─── Home ──────────────────────────────────────────────────────────────

// ─── Home (split & feed variants) ──────────────────────────────────────

function HomeScreen() {
  const { state, setRoute, setShowCmdK } = useApp();
  // Stay in sync with the Tweaks panel's homeLayout — app.jsx fires a
  // 'ct-home-layout' event whenever the tweak changes.
  const [layout, setLayout] = useState(() => document.documentElement.dataset.homeLayout || 'split');
  useEffect(() => {
    const h = () => setLayout(document.documentElement.dataset.homeLayout || 'split');
    window.addEventListener('ct-home-layout', h);
    return () => window.removeEventListener('ct-home-layout', h);
  }, []);
  return (
    <div className="flex h-screen" style={{ background: S.paper, color: S.ink }}>
      <IconRail active="home" onNav={(id) => { if (id === 'talks') setRoute('talk'); else if (id === 'agents') setRoute('agents'); else if (id === 'docs') setRoute('documents'); else if (id === 'settings') setRoute('settings'); else setRoute('home'); }} onCmdK={() => setShowCmdK(true)} />
      <SecondaryList />
      {layout === 'feed' ? <HomeFeed /> : layout === 'focus' ? <HomeFocus /> : <HomeSplit />}
    </div>
  );
}

function HomeTopBar() {
  const { setShowCmdK, setShowNewTalkSheet } = useApp();
  return (
    <TopBar
      left={<>
        <CTIcon name="home" size={14} />
        <span style={{ color: S.ink }}>Home</span>
        <span>·</span>
        <span>Curator-driven view of your salon</span>
      </>}
      right={<>
        <button onClick={() => setShowCmdK(true)} className="flex items-center gap-2 h-8 px-2.5 rounded-lg"
          style={{ background: S.card, border: `1px solid ${S.line}`, color: S.ink2 }}>
          <CTIcon name="search" size={13} stroke={S.ink2} />
          <span className="text-[12.5px]">Search across all Talks</span>
          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded ml-10" style={{ background: S.paper2, color: S.ink2 }}>⌘K</span>
        </button>
        <button onClick={() => setShowNewTalkSheet(true)} className="h-8 px-3 rounded-lg text-[12.5px] font-medium text-white inline-flex items-center gap-1.5" style={{ background: S.accent }}>
          <CTIcon name="plus" size={13} stroke="#FFF" strokeWidth={2} /> New Talk
          <span className="font-mono text-[10px] px-1 py-0.5 rounded ml-1" style={{ background: 'rgba(255,255,255,0.18)' }}>⌘N</span>
        </button>
      </>}
    />
  );
}

function HomeGreeting() {
  const { state } = useApp();
  return (
    <div className="mb-5">
      <div className="text-[11px] font-mono uppercase tracking-[0.18em]" style={{ color: S.ink2 }}>
        {new Date().toLocaleDateString(undefined, { weekday: 'long' })} afternoon
      </div>
      <h1 className="font-serif text-[40px] leading-[1.05] tracking-tight mt-1" style={{ color: S.ink }}>
        Welcome back, {state.user.name.split(' ')[0]}.
      </h1>
    </div>
  );
}

// ─── Variant A · Split (recs left, activity/news right) ───────────────

function HomeSplit() {
  const { state } = useApp();
  const [rightTab, setRightTab] = useState('activity');
  const stats = computeStats(state);

  return (
    <div className="flex-1 min-w-0 flex flex-col ct-screen-enter">
      <HomeTopBar />
      <div className="flex-1 overflow-y-auto px-9 py-7 ct-thin-scroll">
        <div className="max-w-[1240px] mx-auto">
          <HomeGreeting />

          {/* Curator + stats */}
          <div className="grid grid-cols-[1.4fr_1fr] gap-4 mb-5">
            <CuratorBar state={state} />
            <StatStrip stats={stats} dense />
          </div>

          {/* Composer */}
          <div className="mb-7">
            <HomeComposer />
          </div>

          {/* Two-column body */}
          <div className="grid grid-cols-[1.1fr_1fr] gap-5">
            {/* Recommendations */}
            <div>
              <div className="flex items-baseline justify-between mb-3">
                <div className="flex items-baseline gap-2">
                  <h3 className="font-serif text-[20px]" style={{ color: S.ink }}>Recommendations</h3>
                  <span className="text-[11px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>{CT_RECOMMENDATIONS.length}</span>
                </div>
                <button className="text-[11.5px] inline-flex items-center gap-1" style={{ color: S.ink2 }}>
                  <CTIcon name="sparkle" size={11} stroke={S.ink2} /> Refresh
                </button>
              </div>
              <div className="flex flex-col gap-3">
                {CT_RECOMMENDATIONS.map((r) => <RecommendationCard key={r.id} rec={r} />)}
              </div>
            </div>

            {/* Right column */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-1 rounded-lg p-0.5" style={{ background: S.paper2, border: `1px solid ${S.line}` }}>
                  {[
                    { id: 'activity', label: 'Activity' },
                    { id: 'news',     label: 'News' },
                  ].map((t) => (
                    <button key={t.id} onClick={() => setRightTab(t.id)}
                      className="px-3 h-7 rounded-md text-[12.5px] font-medium"
                      style={{
                        background: rightTab === t.id ? S.card : 'transparent',
                        color: rightTab === t.id ? S.ink : S.ink2,
                        boxShadow: rightTab === t.id ? `inset 0 0 0 1px ${S.line}` : 'none',
                      }}>{t.label}</button>
                  ))}
                </div>
                <span className="text-[11px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>
                  {rightTab === 'activity' ? `${CT_ACTIVITY.length} events` : `${CT_NEWS.length} stories`}
                </span>
              </div>

              {rightTab === 'activity' ? (
                <div className="rounded-2xl p-2 px-3" style={{ background: S.card, border: `1px solid ${S.line}` }}>
                  {CT_ACTIVITY.map((ev) => <ActivityRow key={ev.id} ev={ev} />)}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {CT_NEWS.map((n) => <NewsCard key={n.id} item={n} dense />)}
                  <div className="text-[11.5px] text-center py-2" style={{ color: S.ink2 }}>
                    News from Talks with the <span className="font-mono">News monitor</span> tool enabled. Manage in <span className="underline cursor-pointer">Settings · Tools</span>.
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Variant B · Single long feed ─────────────────────────────────────

function HomeFeed() {
  const { state } = useApp();
  const stats = computeStats(state);
  return (
    <div className="flex-1 min-w-0 flex flex-col ct-screen-enter">
      <HomeTopBar />
      <div className="flex-1 overflow-y-auto px-9 py-7 ct-thin-scroll">
        <div className="max-w-[760px] mx-auto">
          <HomeGreeting />

          <div className="mb-4"><CuratorBar state={state} /></div>
          <div className="mb-4"><StatStrip stats={stats} dense /></div>
          <div className="mb-6"><HomeComposer /></div>

          <FeedSection title="Recommendations" count={`${CT_RECOMMENDATIONS.length}`}>
            {CT_RECOMMENDATIONS.map((r) => <RecommendationCard key={r.id} rec={r} />)}
          </FeedSection>

          <FeedSection title="Activity" count={`${CT_ACTIVITY.length}`}>
            <div className="rounded-2xl p-2 px-3" style={{ background: S.card, border: `1px solid ${S.line}` }}>
              {CT_ACTIVITY.map((ev) => <ActivityRow key={ev.id} ev={ev} />)}
            </div>
          </FeedSection>

          <FeedSection title="News for your Talks" count={`${CT_NEWS.length}`}>
            {CT_NEWS.map((n) => <NewsCard key={n.id} item={n} />)}
            <div className="text-[11.5px] text-center py-2" style={{ color: S.ink2 }}>
              News pulled live from Talks with the <span className="font-mono">News monitor</span> tool enabled. Manage in <span className="underline cursor-pointer">Settings · Tools</span>.
            </div>
          </FeedSection>

          <div className="text-center text-[11.5px] py-6" style={{ color: S.ink2 }}>
            That\u2019s everything new. Refresh to re-curate, or <span className="underline cursor-pointer">start a new room</span>.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Talk detail ───────────────────────────────────────────────────────

function TalkScreen() {
  const { state, route, setRoute, activeTalk, toggleDoc, cancelRuns, setShowCmdK, setTalkSubpanel, setArchiveTalkDialog } = useApp();
  const threadRef = useRef(null);
  const ctxBtnRef = useRef(null);
  const connBtnRef = useRef(null);
  const moreBtnRef = useRef(null);
  const [ctxRect, setCtxRect] = useState(null);
  const [connRect, setConnRect] = useState(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreRect, setMoreRect] = useState(null);
  // Draggable width of the document pane (persisted).
  const [docWidth, setDocWidth] = useState(() => {
    const saved = Number(localStorage.getItem('ct-doc-width'));
    return saved >= 360 && saved <= 980 ? saved : 560;
  });
  useEffect(() => { localStorage.setItem('ct-doc-width', String(docWidth)); }, [docWidth]);
  // Auto-scroll to bottom on new content.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeTalk?.messages?.length, activeTalk?.messages?.map((m) => m.streamingText?.length).join(',')]);

  if (!activeTalk) return <div className="p-12">No talk selected.</div>;

  const showDoc = state.showDoc && activeTalk.docId;
  const running = activeTalk.messages.some((m) => m.runStatus === 'running' || m.runStatus === 'queued');

  return (
    <div className="flex h-screen" style={{ background: S.paper, color: S.ink }}>
      <IconRail active="talks" onNav={(id) => { if (id === 'home') setRoute('home'); else if (id === 'agents') setRoute('agents'); else if (id === 'docs') setRoute('documents'); else if (id === 'settings') setRoute('settings'); else setRoute('talk'); }} onCmdK={() => setShowCmdK(true)} />
      <SecondaryList />

      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {/* Header */}
        <div className="px-7 h-16 flex items-center gap-4 border-b shrink-0" style={{ borderColor: S.line }}>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-[11.5px]" style={{ color: S.ink2 }}>
              <CTIcon name="folder" size={12} />
              <span>{activeTalk.folder || 'Loose'}</span>
              <CTIcon name="chevron-r" size={10} />
              <span style={{ color: S.ink }} className="font-mono uppercase tracking-widest text-[10.5px]">
                {activeTalk.mode} mode · {activeTalk.agents.length} agents
              </span>
              {running ? <RunPill status="running" /> : null}
            </div>
            <h2 className="font-serif text-[22px] leading-tight truncate mt-0.5" style={{ color: S.ink }}>{activeTalk.title}</h2>
          </div>
          <div className="flex items-center gap-2">
            {running ? (
              <button onClick={cancelRuns} className="h-8 px-3 rounded-lg text-[12.5px] inline-flex items-center gap-1.5"
                style={{ background: S.card, color: '#A8434A', border: `1px solid ${S.line}` }}>
                <CTIcon name="x" size={13} stroke="#A8434A" /> Cancel runs
              </button>
            ) : null}

            <button className="h-8 px-3 rounded-lg text-[12.5px] inline-flex items-center gap-1.5"
              style={{ background: S.card, border: `1px solid ${S.line}`, color: S.ink }}>
              <CTIcon name="sparkle" size={13} /> Agents
              <span className="font-mono text-[10.5px] ml-0.5" style={{ color: S.ink2 }}>{activeTalk.agents.length}</span>
            </button>

            <ToolsHeaderButton />

            <button
              ref={ctxBtnRef}
              onClick={() => { setCtxRect(ctxBtnRef.current?.getBoundingClientRect()); setTalkSubpanel('context'); }}
              className="h-8 pl-2.5 pr-3 rounded-lg text-[12.5px] inline-flex items-center gap-1.5"
              style={{ background: S.card, border: `1px solid ${S.line}`, color: S.ink }}>
              <CTIcon name="bolt" size={13} stroke={S.ink2} strokeWidth={1.7} />
              Context
              <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10.5px] font-mono"
                style={{ background: S.paper2, color: S.ink2, border: `1px solid ${S.line}` }}>7</span>
            </button>

            <button
              ref={connBtnRef}
              onClick={() => { setConnRect(connBtnRef.current?.getBoundingClientRect()); setTalkSubpanel('connectors'); }}
              className="h-8 pl-2.5 pr-3 rounded-lg text-[12.5px] inline-flex items-center gap-1.5"
              style={{ background: S.card, border: `1px solid ${S.line}`, color: S.ink }}>
              <CTIcon name="globe" size={13} stroke={S.ink2} strokeWidth={1.7} />
              Connectors
              <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10.5px] font-mono"
                style={{ background: S.paper2, color: S.ink2, border: `1px solid ${S.line}` }}>2</span>
            </button>

            {activeTalk.docId ? (
              <button onClick={toggleDoc} className="h-8 px-3 rounded-lg text-[12.5px] inline-flex items-center gap-1.5"
                style={{
                  background: showDoc ? S.accent : S.card,
                  color: showDoc ? '#FFF' : S.ink,
                  border: showDoc ? `1px solid ${S.accent}` : `1px solid ${S.line}`,
                }}>
                <CTIcon name="doc" size={13} stroke={showDoc ? '#FFF' : S.ink} /> Document
              </button>
            ) : null}
            <div className="w-px h-5 mx-1" style={{ background: S.line }} />
            <button
              ref={moreBtnRef}
              onClick={() => { setMoreRect(moreBtnRef.current?.getBoundingClientRect()); setMoreOpen((v) => !v); }}
              className="w-8 h-8 grid place-items-center rounded-lg"
              style={{ color: S.ink2, border: `1px solid ${S.line}`, background: moreOpen ? S.paper2 : S.card }}>
              <CTIcon name="more" size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden flex min-h-0">
          {/* Thread column */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            <div ref={threadRef} className="flex-1 overflow-y-auto px-8 ct-thin-scroll" style={{ background: S.paper }}>
              <RoundList messages={activeTalk.messages} />
            </div>
            <Composer compact={showDoc} />
          </div>

          {showDoc ? <DocResizeHandle width={docWidth} setWidth={setDocWidth} /> : null}
          {showDoc ? <DocPane width={docWidth} /> : null}
        </div>
      </div>

      {state.talkSubpanel === 'context'    ? <ContextPopover    anchorRect={ctxRect}  onClose={() => setTalkSubpanel(null)} /> : null}
      {state.talkSubpanel === 'connectors' ? <ConnectorsPopover anchorRect={connRect} onClose={() => setTalkSubpanel(null)} /> : null}
      {moreOpen ? <TalkMoreMenu anchorRect={moreRect} onClose={() => setMoreOpen(false)} talk={activeTalk} /> : null}
    </div>
  );
}

// Groups messages by `round` and renders dividers between them.
function RoundList({ messages }) {
  // Bucket by round.
  const rounds = [];
  for (const m of messages) {
    const r = m.round || 1;
    let bucket = rounds.find((x) => x.round === r);
    if (!bucket) { bucket = { round: r, items: [] }; rounds.push(bucket); }
    bucket.items.push(m);
  }
  return (
    <div className="max-w-[760px] mx-auto">
      {rounds.map((r, ri) => {
        const isLive = r.items.some((m) => m.runStatus === 'running' || m.runStatus === 'queued');
        return (
          <React.Fragment key={r.round}>
            <div className="pt-6 pb-2">
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px" style={{ background: S.line }} />
                <span className="text-[10.5px] font-mono uppercase tracking-[0.18em]" style={{ color: S.ink2 }}>
                  Round {r.round}{isLive ? ' · live' : ''}
                </span>
                <div className="flex-1 h-px" style={{ background: S.line }} />
              </div>
            </div>
            {r.items.map((m) => m.role === 'user'
              ? <UserMessage key={m.id} m={m} />
              : <AgentMessage key={m.id} m={m} />)}
            {ri === rounds.length - 1 && isLive ? (
              <div className="my-6 rounded-2xl p-4" style={{ background: S.paper2, border: `1px dashed ${S.line}` }}>
                <div className="flex items-center gap-2 mb-1.5">
                  <CTIcon name="sparkle" size={13} stroke={S.ink2} />
                  <span className="text-[11px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>
                    Editor will synthesize when round {r.round} closes
                  </span>
                </div>
                <div className="font-serif italic text-[14px]" style={{ color: S.ink2 }}>
                  Combines the strongest argument from each agent into a single recommendation, with the open questions surfaced as TODOs in the doc.
                </div>
              </div>
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── Cmd+K palette ────────────────────────────────────────────────────

function CmdKPalette() {
  const { state, setShowCmdK, setActiveTalk, setRoute, toggleDoc, cancelRuns, resetDemo, setSettingsTab } = useApp();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 50); }, []);

  const allTalks = Object.values(state.talks);
  const actions = [
    { id: 'open-doc',  label: 'Open / close document pane', icon: 'doc',     kbd: '⌘ J',  do: () => { toggleDoc(); setShowCmdK(false); } },
    { id: 'cancel',    label: 'Cancel all running runs',    icon: 'x',       kbd: '⌘ .',  do: () => { cancelRuns(); setShowCmdK(false); }, danger: true },
    { id: 'home',      label: 'Go to Home',                 icon: 'home',    kbd: 'g h',  do: () => { setRoute('home'); setShowCmdK(false); } },
    { id: 'profile',   label: 'Settings · Profile',         icon: 'settings',kbd: '',     do: () => { setSettingsTab('profile'); setShowCmdK(false); } },
    { id: 'api-keys',  label: 'Settings · API keys',        icon: 'bolt',    kbd: '',     do: () => { setSettingsTab('api-keys'); setShowCmdK(false); } },
    { id: 'agents',    label: 'Settings · AI agents',       icon: 'sparkle', kbd: '',     do: () => { setSettingsTab('agents'); setShowCmdK(false); } },
    { id: 'tools-s',   label: 'Settings · Tools',           icon: 'globe',   kbd: '',     do: () => { setSettingsTab('tools'); setShowCmdK(false); } },
    { id: 'conn-s',    label: 'Settings · Connectors',      icon: 'folder',  kbd: '',     do: () => { setSettingsTab('connectors'); setShowCmdK(false); } },
    { id: 'reset',     label: 'Reset demo data',            icon: 'bolt',    kbd: '⌘ ⇧ R',do: () => { resetDemo(); setShowCmdK(false); } },
  ];

  const ql = q.toLowerCase();
  const filteredTalks = allTalks.filter((t) => t.title.toLowerCase().includes(ql));
  const filteredActions = actions.filter((a) => a.label.toLowerCase().includes(ql));

  const flat = [];
  if (filteredActions.length) {
    flat.push({ kind: 'sect', label: 'Actions' });
    filteredActions.forEach((a) => flat.push({ kind: 'action', ...a }));
  }
  if (filteredTalks.length) {
    flat.push({ kind: 'sect', label: `Jump to (${filteredTalks.length})` });
    filteredTalks.forEach((t) => flat.push({ kind: 'talk', id: t.id, label: t.title, icon: 'chat', talk: t }));
  }
  const selectables = flat.map((x, i) => ({ ...x, i })).filter((x) => x.kind !== 'sect');
  const onPick = (idx) => {
    const item = selectables[idx];
    if (!item) return;
    if (item.kind === 'action') item.do();
    else if (item.kind === 'talk') { setActiveTalk(item.id); setShowCmdK(false); }
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); setShowCmdK(false); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((v) => Math.min(selectables.length - 1, v + 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setSel((v) => Math.max(0, v - 1)); }
    if (e.key === 'Enter')     { e.preventDefault(); onPick(sel); }
  };

  return (
    <div className="fixed inset-0 z-50 ct-screen-enter" style={{ background: 'rgba(31,27,22,0.32)', backdropFilter: 'blur(3px)' }}
      onClick={() => setShowCmdK(false)}>
      <div className="mx-auto mt-[10vh] w-[640px] max-w-[92vw] rounded-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}
        style={{ background: S.card, border: `1px solid ${S.line}`, boxShadow: '0 40px 80px rgba(31,27,22,0.25)' }}>
        <div className="h-12 px-4 flex items-center gap-2.5 border-b" style={{ borderColor: S.line }}>
          <CTIcon name="search" size={15} stroke={S.ink2} />
          <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey}
            placeholder="Search talks, run actions…"
            className="flex-1 bg-transparent outline-none text-[14.5px]" style={{ color: S.ink }} />
          <Kbd>esc</Kbd>
        </div>

        <div className="py-1 max-h-[480px] overflow-y-auto ct-thin-scroll">
          {flat.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px]" style={{ color: S.ink2 }}>
              No matches for <span className="font-mono">"{q}"</span>.
            </div>
          ) : null}
          {flat.map((row, i) => {
            if (row.kind === 'sect') return (
              <div key={`s-${i}`} className="px-3 pt-3 pb-1 text-[10.5px] font-mono uppercase tracking-[0.18em]" style={{ color: S.ink2 }}>{row.label}</div>
            );
            const selIdx = selectables.findIndex((s) => s.i === i);
            const on = selIdx === sel;
            return (
              <button key={row.id || i}
                onMouseEnter={() => setSel(selIdx)}
                onClick={() => onPick(selIdx)}
                className="w-full mx-1 px-3 h-10 rounded-lg flex items-center gap-2.5 text-left"
                style={{ background: on ? S.paper2 : 'transparent', color: row.danger ? '#A8434A' : S.ink, width: 'calc(100% - 8px)' }}>
                <CTIcon name={row.icon} size={14} stroke={row.danger ? '#A8434A' : S.ink2} />
                <span className="flex-1 text-[13.5px]">{row.label}</span>
                {row.kind === 'talk' && row.talk?.running ? <RunPill status="running" /> : null}
                {row.kind === 'talk' && row.talk?.unread ? <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full" style={{ background: S.accent, color: '#FFF' }}>{row.talk.unread}</span> : null}
                <Kbd>{row.kbd || '↵'}</Kbd>
              </button>
            );
          })}
        </div>

        <div className="h-9 px-4 flex items-center justify-between text-[11px] border-t" style={{ borderColor: S.line, color: S.ink2 }}>
          <div className="flex items-center gap-3">
            <span><Kbd>↑↓</Kbd> navigate</span>
            <span><Kbd>↵</Kbd> select</span>
            <span><Kbd>esc</Kbd> close</span>
          </div>
          <span className="font-mono">{selectables.length} results</span>
        </div>
      </div>
    </div>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────

function SettingsScreen() {
  const { state, setRoute, setState, setShowCmdK, setSettingsTab } = useApp();
  const tabs = [
    { id: 'profile',    label: 'Profile',    icon: 'settings' },
    { id: 'api-keys',   label: 'API keys',   icon: 'bolt'     },
    { id: 'agents',     label: 'AI agents',  icon: 'sparkle'  },
    { id: 'tools',      label: 'Tools',      icon: 'globe'    },
    { id: 'connectors', label: 'Connectors', icon: 'folder'   },
  ];
  const tab = state.settingsTab || 'profile';
  const current = tabs.find((t) => t.id === tab) || tabs[0];
  const u = state.user;
  const update = (patch) => setState((s) => ({ ...s, user: { ...s.user, ...patch } }));

  return (
    <div className="flex h-screen" style={{ background: S.paper, color: S.ink }}>
      <IconRail active="settings" onNav={(id) => { if (id === 'home') setRoute('home'); else if (id === 'talks') setRoute('talk'); else if (id === 'agents') setRoute('agents'); else if (id === 'docs') setRoute('documents'); else setRoute('home'); }} onCmdK={() => setShowCmdK(true)} />

      {/* Settings sub-nav (replaces the top-tabs strip) */}
      <div className="w-[240px] shrink-0 h-full flex flex-col border-r"
        style={{ background: S.paper, borderColor: S.line }}>
        <div className="px-4 pt-4 pb-3">
          <div className="font-serif text-[18px] leading-none" style={{ color: S.ink }}>Settings</div>
          <div className="text-[11px] mt-1" style={{ color: S.ink2 }}>{u.workspace}</div>
        </div>
        <div className="px-2 flex flex-col gap-0.5">
          {tabs.map((t) => {
            const on = t.id === tab;
            return (
              <button key={t.id} onClick={() => setSettingsTab(t.id)}
                className="flex items-center gap-2.5 px-2.5 h-9 rounded-lg text-[13px] text-left"
                style={{
                  background: on ? S.card : 'transparent',
                  color: on ? S.ink : S.ink2,
                  boxShadow: on ? `inset 0 0 0 1px ${S.line}` : 'none',
                }}>
                <CTIcon name={t.icon} size={14} stroke={on ? S.ink : S.ink2} strokeWidth={1.7} />
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="mt-auto p-3">
          <div className="rounded-xl p-2.5 flex items-center gap-2.5" style={{ background: S.paper2, border: `1px solid ${S.line}` }}>
            <Avatar initials={u.initials} color={u.avatarColor} size={28} />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] truncate" style={{ color: S.ink }}>{u.name}</div>
              <div className="text-[10.5px] truncate" style={{ color: S.ink2 }}>{u.email}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="h-16 px-9 flex items-center justify-between border-b shrink-0" style={{ borderColor: S.line }}>
          <div>
            <div className="text-[11px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>Settings</div>
            <h2 className="font-serif text-[22px] leading-none mt-1" style={{ color: S.ink }}>{current.label}</h2>
          </div>
          <div className="flex items-center gap-3 text-[12.5px]" style={{ color: S.ink2 }}>
            <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full" style={{ background: '#3F6B5C' }} /> All changes saved · 14 s ago</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-9 py-7 ct-thin-scroll">
          {tab === 'profile'    ? <ProfilePanel    u={u} update={update} /> : null}
          {tab === 'api-keys'   ? <ApiKeysPanel /> : null}
          {tab === 'agents'     ? <AgentsPanel /> : null}
          {tab === 'tools'      ? <ToolsSettingsPanel /> : null}
          {tab === 'connectors' ? <ConnectorsPanel /> : null}
        </div>
      </div>
    </div>
  );
}

function ProfilePanel({ u, update }) {
  return (
    <div className="grid grid-cols-[280px_minmax(0,1fr)] gap-10 max-w-[920px]">
      <div>
        <h3 className="font-serif text-[20px] leading-tight" style={{ color: S.ink }}>Profile</h3>
        <p className="text-[12.5px] mt-1.5 leading-relaxed" style={{ color: S.ink2 }}>
          How you appear to agents in your salon, and the defaults used when you start a new Talk.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-4">
          <Avatar initials={u.initials} color={u.avatarColor} size={64} />
          <div className="flex flex-col gap-1">
            <button className="h-8 px-3 rounded-lg text-[12.5px]" style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>Replace photo</button>
            <span className="text-[11px]" style={{ color: S.ink2 }}>PNG or JPG, max 2 MB</span>
          </div>
        </div>

        {[
          { l: 'Display name',  k: 'name' },
          { l: 'Salon handle',  k: 'handle', muted: u.handle.replace('@', '') + '.clawtalk.app' },
          { l: 'Email',         k: 'email', locked: true },
        ].map((f) => (
          <div key={f.k} className="flex flex-col gap-1.5">
            <label className="text-[12px]" style={{ color: S.ink2 }}>{f.l}</label>
            <input
              value={u[f.k]}
              onChange={(e) => !f.locked && update({ [f.k]: e.target.value, ...(f.k === 'name' ? { initials: e.target.value.split(' ').map((w) => w[0]).join('').slice(0,2).toUpperCase() } : {}) })}
              readOnly={!!f.locked}
              className="h-10 px-3.5 rounded-lg text-[14px] outline-none focus:ring-2"
              style={{
                background: f.locked ? S.paper2 : S.card,
                color: f.locked ? S.ink2 : S.ink,
                border: `1px solid ${S.line}`,
                ['--tw-ring-color']: S.accent + '55',
              }} />
            {f.muted ? <span className="text-[11px] font-mono" style={{ color: S.ink2 }}>{f.muted}</span> : null}
          </div>
        ))}

        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-widest font-mono px-2 py-0.5 rounded-full" style={{ background: '#3F6B5C', color: '#FFF' }}>Owner</span>
          <span className="text-[12.5px]" style={{ color: S.ink2 }}>Workspace: <span style={{ color: S.ink }} className="font-medium">{u.workspace}</span></span>
        </div>

        <div className="flex items-center gap-2 mt-2">
          <button className="h-9 px-4 rounded-full text-[13px] font-medium text-white" style={{ background: S.accent }}>Save changes</button>
          <button className="h-9 px-4 rounded-full text-[13px]" style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>Discard</button>
          <button className="h-9 px-3 rounded-full text-[13px] inline-flex items-center gap-1.5 ml-auto" style={{ color: '#A8434A' }}>
            <CTIcon name="logout" size={13} stroke="#A8434A" /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function AgentsPanel() {
  return (
    <div className="max-w-[920px]">
      <h3 className="font-serif text-[20px]" style={{ color: S.ink }}>Agents in your salon</h3>
      <p className="text-[12.5px] mt-1.5 mb-6" style={{ color: S.ink2 }}>
        Personas you can invite into any Talk. Each one has its own system prompt, model, and color.
      </p>
      <div className="grid grid-cols-2 gap-4">
        {CT_AGENTS.map((a) => (
          <div key={a.id} className="rounded-2xl p-5 flex flex-col gap-3" style={{ background: S.card, border: `1px solid ${S.line}` }}>
            <div className="flex items-center gap-3">
              <AgentAvatar agent={a} size={44} />
              <div className="flex-1 min-w-0">
                <div className="font-serif text-[18px] truncate" style={{ color: S.ink }}>{a.name}</div>
                <div className="text-[11.5px] font-mono" style={{ color: S.ink2 }}>{a.handle} · {a.model}</div>
              </div>
              <Chip>Enabled</Chip>
            </div>
            <div className="text-[13px] leading-relaxed" style={{ color: S.ink2 }}>
              {{
                'a-strategy': 'Frames the strongest pitch first. Optimizes for landing the position with a hostile buyer.',
                'a-critic':   'Adversarial. Surfaces the three places the current argument breaks first.',
                'a-research': 'Pulls comps, runs the math, finds the data behind the vibe.',
                'a-editor':   'Synthesizes the round into a single recommendation and edits the linked doc.',
              }[a.id]}
            </div>
            <div className="flex items-center gap-1.5">
              <button className="text-[11.5px] px-2 py-1 rounded hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink2 }}>Edit prompt</button>
              <button className="text-[11.5px] px-2 py-1 rounded hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink2 }}>Swap model</button>
              <button className="text-[11.5px] px-2 py-1 rounded hover:bg-[var(--salon-paper-2)] ml-auto" style={{ color: '#A8434A' }}>Disable</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectorsPanel() {
  const items = [
    { name: 'Google Drive', desc: 'Sync docs into Talks as context', on: true },
    { name: 'Slack',        desc: 'Post Talk summaries to channels', on: true },
    { name: 'Linear',       desc: 'Turn synthesized recs into issues', on: false },
    { name: 'GitHub',       desc: 'Mention PRs and let agents read diffs', on: false },
    { name: 'Notion',       desc: 'Read pages as context, push docs back', on: false },
    { name: 'Telegram',     desc: 'Get a ping when an agent finishes', on: false },
  ];
  return (
    <div className="max-w-[920px]">
      <h3 className="font-serif text-[20px]" style={{ color: S.ink }}>Connectors</h3>
      <p className="text-[12.5px] mt-1.5 mb-6" style={{ color: S.ink2 }}>External tools agents can read from and post to.</p>
      <div className="grid grid-cols-2 gap-3">
        {items.map((c) => (
          <div key={c.name} className="rounded-xl p-4 flex items-center gap-3" style={{ background: S.card, border: `1px solid ${S.line}` }}>
            <div className="w-10 h-10 rounded-lg grid place-items-center font-mono text-[14px]"
              style={{ background: S.paper2, color: S.ink, border: `1px solid ${S.line}` }}>{c.name[0]}</div>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-medium" style={{ color: S.ink }}>{c.name}</div>
              <div className="text-[11.5px]" style={{ color: S.ink2 }}>{c.desc}</div>
            </div>
            <button className={`h-7 px-3 rounded-full text-[11.5px] font-medium ${c.on ? '' : ''}`}
              style={c.on
                ? { background: '#3F6B5C', color: '#FFF' }
                : { background: 'transparent', color: S.ink, border: `1px solid ${S.line}` }}>
              {c.on ? 'Connected' : 'Connect'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function BillingPanel() {
  return (
    <div className="max-w-[820px]">
      <h3 className="font-serif text-[20px]" style={{ color: S.ink }}>Billing</h3>
      <p className="text-[12.5px] mt-1.5 mb-6" style={{ color: S.ink2 }}>Plan, usage, invoices.</p>
      <div className="rounded-2xl p-6 mb-5" style={{ background: S.card, border: `1px solid ${S.line}` }}>
        <div className="flex items-baseline gap-3">
          <div className="font-serif text-[26px]" style={{ color: S.ink }}>Team plan</div>
          <Chip>Annual · saved 18%</Chip>
        </div>
        <div className="text-[13.5px] mt-1.5" style={{ color: S.ink2 }}>
          $32 / seat / month · 12 seats · renews <span className="font-medium" style={{ color: S.ink }}>March 12, 2027</span>.
        </div>

        <div className="grid grid-cols-3 gap-4 mt-6">
          {[
            { l: 'Tokens this period', v: '184.2k', sub: 'of 200k included' },
            { l: 'Active Talks',       v: '7',      sub: '3 streaming today'},
            { l: 'Connectors',         v: '2',      sub: 'of 6 connected'   },
          ].map((s) => (
            <div key={s.l} className="rounded-xl p-3" style={{ background: S.paper2, border: `1px solid ${S.line}` }}>
              <div className="text-[10.5px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>{s.l}</div>
              <div className="font-serif text-[26px] mt-1" style={{ color: S.ink }}>{s.v}</div>
              <div className="text-[11.5px] mt-0.5" style={{ color: S.ink2 }}>{s.sub}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-2xl overflow-hidden" style={{ background: S.card, border: `1px solid ${S.line}` }}>
        <div className="h-10 px-4 flex items-center border-b text-[11px] font-mono uppercase tracking-widest" style={{ borderColor: S.line, color: S.ink2 }}>
          <span className="flex-1">Invoice</span><span className="w-24">Date</span><span className="w-24">Amount</span><span className="w-20 text-right">PDF</span>
        </div>
        {[
          { id: 'INV-2027-002', date: 'Feb 12 2027', amt: '$3,840.00' },
          { id: 'INV-2027-001', date: 'Jan 12 2027', amt: '$3,840.00' },
          { id: 'INV-2026-012', date: 'Dec 12 2026', amt: '$3,840.00' },
        ].map((i) => (
          <div key={i.id} className="h-12 px-4 flex items-center text-[12.5px] border-b last:border-0" style={{ borderColor: S.line, color: S.ink }}>
            <span className="flex-1 font-mono">{i.id}</span>
            <span className="w-24 font-mono" style={{ color: S.ink2 }}>{i.date}</span>
            <span className="w-24">{i.amt}</span>
            <span className="w-20 text-right"><button className="text-[11.5px] underline" style={{ color: S.ink2 }}>Download</button></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkspacePanel({ u }) {
  return (
    <div className="max-w-[820px]">
      <h3 className="font-serif text-[20px]" style={{ color: S.ink }}>Workspace</h3>
      <p className="text-[12.5px] mt-1.5 mb-6" style={{ color: S.ink2 }}>Members, default folders, and provider keys.</p>

      <div className="rounded-2xl p-5 mb-5" style={{ background: S.card, border: `1px solid ${S.line}` }}>
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-xl grid place-items-center font-serif text-[20px]" style={{ background: S.paper2, color: S.ink, border: `1px solid ${S.line}` }}>OC</div>
          <div className="flex-1">
            <div className="font-serif text-[20px]" style={{ color: S.ink }}>{u.workspace}</div>
            <div className="text-[12px]" style={{ color: S.ink2 }}>12 members · 7 talks · created Aug 2025</div>
          </div>
          <button className="h-8 px-3 rounded-lg text-[12.5px]" style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>Rename</button>
        </div>
      </div>

      <div className="rounded-2xl overflow-hidden" style={{ background: S.card, border: `1px solid ${S.line}` }}>
        <div className="h-10 px-4 flex items-center border-b text-[11px] font-mono uppercase tracking-widest" style={{ borderColor: S.line, color: S.ink2 }}>
          <span className="flex-1">Member</span><span className="w-32">Role</span><span className="w-20"></span>
        </div>
        {[
          { n: 'Samira Rao',  e: 'samira@oxbow.co',  r: 'Owner',  c: '#3F6B5C', i: 'SR' },
          { n: 'Henry Otieno', e: 'henry@oxbow.co',  r: 'Admin',  c: '#8E3B59', i: 'HO' },
          { n: 'Liu Wei',      e: 'liu@oxbow.co',    r: 'Member', c: '#3D5688', i: 'LW' },
          { n: 'Priya Anand',  e: 'priya@oxbow.co',  r: 'Member', c: '#C8643A', i: 'PA' },
        ].map((m, i, arr) => (
          <div key={m.e} className="h-14 px-4 flex items-center gap-3 border-b last:border-0" style={{ borderColor: S.line }}>
            <Avatar initials={m.i} color={m.c} size={32} />
            <div className="flex-1 min-w-0">
              <div className="text-[13.5px] truncate" style={{ color: S.ink }}>{m.n}</div>
              <div className="text-[11.5px] truncate" style={{ color: S.ink2 }}>{m.e}</div>
            </div>
            <span className="w-32 text-[12px]" style={{ color: S.ink2 }}>{m.r}</span>
            <button className="w-20 text-[12px] text-right" style={{ color: S.ink2 }}>•••</button>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, {
  SignInScreen, HomeScreen, HomeSplit, HomeFeed, HomeTopBar, HomeGreeting, TalkScreen, RoundList, CmdKPalette, SettingsScreen,
  ProfilePanel, AgentsPanel, ConnectorsPanel, BillingPanel, WorkspacePanel,
  ApiKeysPanel, ToolsSettingsPanel,
});

// ─── API Keys panel ─────────────────────────────────────────────────

function ApiKeysPanel() {
  const [reveal, setReveal] = useState({});
  const keys = [
    { id: 'k1', label: 'Production CLI',    prefix: 'ct_live_',  body: 'aHR0cHM6Ly9jbGF3dGFsay5hcHA',  created: 'Feb 2 2027',  last: '3 hours ago',  scopes: ['talks:rw','docs:rw'] },
    { id: 'k2', label: 'GitHub Actions',    prefix: 'ct_live_',  body: 'YzlmM2VlMjFmZjQ0NWNkMmVlYTE',  created: 'Jan 14 2027', last: 'yesterday',     scopes: ['talks:r','docs:r'] },
    { id: 'k3', label: 'Personal scratch',  prefix: 'ct_test_',  body: 'OWQyZjEzYjU3ZGRkZTQyN2I0YjY',  created: 'Oct 28 2026', last: '2 weeks ago',   scopes: ['talks:rw'] },
  ];
  return (
    <div className="max-w-[920px]">
      <div className="flex items-baseline justify-between">
        <div>
          <h3 className="font-serif text-[20px]" style={{ color: S.ink }}>API keys</h3>
          <p className="text-[12.5px] mt-1.5 mb-6" style={{ color: S.ink2 }}>
            Scoped tokens for the ClawTalk REST API and CLI. Keys are workspace-scoped — revoking one doesn\u2019t affect others.
          </p>
        </div>
        <button className="h-9 px-3 rounded-full text-[12.5px] font-medium text-white inline-flex items-center gap-1.5"
          style={{ background: S.accent }}>
          <CTIcon name="plus" size={13} stroke="#FFF" strokeWidth={2}/> New key
        </button>
      </div>

      <div className="rounded-2xl overflow-hidden" style={{ background: S.card, border: `1px solid ${S.line}` }}>
        <div className="h-10 px-4 flex items-center border-b text-[11px] font-mono uppercase tracking-widest"
          style={{ borderColor: S.line, color: S.ink2 }}>
          <span className="flex-1">Label</span>
          <span className="w-[260px]">Key</span>
          <span className="w-28">Scopes</span>
          <span className="w-28">Last used</span>
          <span className="w-10"></span>
        </div>
        {keys.map((k) => {
          const shown = reveal[k.id];
          const masked = `${k.prefix}${'•'.repeat(20)}`;
          const full   = `${k.prefix}${k.body}`;
          return (
            <div key={k.id} className="h-14 px-4 flex items-center gap-3 border-b last:border-0 text-[12.5px]"
              style={{ borderColor: S.line, color: S.ink }}>
              <div className="flex-1 min-w-0">
                <div className="truncate">{k.label}</div>
                <div className="text-[11px]" style={{ color: S.ink2 }}>Created {k.created}</div>
              </div>
              <div className="w-[260px] flex items-center gap-1.5">
                <span className="font-mono text-[12px] truncate" style={{ color: S.ink }}>{shown ? full : masked}</span>
                <button onClick={() => setReveal((r) => ({ ...r, [k.id]: !r[k.id] }))}
                  className="w-6 h-6 grid place-items-center rounded" style={{ color: S.ink2 }} title={shown ? 'Hide' : 'Reveal'}>
                  <CTIcon name="eye" size={13} />
                </button>
                <button className="w-6 h-6 grid place-items-center rounded" style={{ color: S.ink2 }} title="Copy">
                  <CTIcon name="paperclip" size={12} />
                </button>
              </div>
              <span className="w-28 flex items-center gap-1">
                {k.scopes.map((s) => (
                  <span key={s} className="font-mono text-[10.5px] px-1.5 py-0.5 rounded"
                    style={{ background: S.paper2, color: S.ink, border: `1px solid ${S.line}` }}>{s}</span>
                ))}
              </span>
              <span className="w-28 font-mono text-[11px]" style={{ color: S.ink2 }}>{k.last}</span>
              <button className="w-10 grid place-items-center text-[11.5px]" style={{ color: '#A8434A' }}>Revoke</button>
            </div>
          );
        })}
      </div>

      <div className="mt-5 rounded-xl p-4 flex items-start gap-3"
        style={{ background: S.paper2, border: `1px solid ${S.line}` }}>
        <CTIcon name="bolt" size={14} stroke={S.ink2} />
        <div className="text-[12.5px]" style={{ color: S.ink2 }}>
          Keys grant access to the entire workspace they\u2019re created in. For per-agent scoping (e.g. a key that can only read one Talk), use a personal access token from <span className="underline cursor-pointer" style={{ color: S.ink }}>your profile</span>.
        </div>
      </div>
    </div>
  );
}

// ─── Tools (workspace-level) ──────────────────────────────────────────
// Distinct from the per-Talk tools popover: this is where you configure
// auth & defaults for each tool. Per-Talk toggles inherit from here.

function ToolsSettingsPanel() {
  const { state } = useApp();
  const grouped = CT_TOOL_GROUPS.map((g) => ({ ...g, tools: CT_TOOLS.filter((t) => t.group === g.id) }));
  return (
    <div className="max-w-[920px]">
      <h3 className="font-serif text-[20px]" style={{ color: S.ink }}>Tools</h3>
      <p className="text-[12.5px] mt-1.5 mb-6 max-w-[640px]" style={{ color: S.ink2 }}>
        Workspace-wide tool catalog. Per-Talk toggles in the chat header pick from this set — agents can only use tools you\u2019ve <em>enabled</em> and <em>connected</em> here.
      </p>

      <div className="rounded-2xl p-5 mb-5 grid grid-cols-3 gap-4" style={{ background: S.card, border: `1px solid ${S.line}` }}>
        {[
          { l: 'Connected tools', v: '5',  sub: 'of 9 available' },
          { l: 'Calls this month', v: '1,842', sub: '+18% vs last month' },
          { l: 'Most-used',        v: 'Web search', sub: '624 calls' },
        ].map((s) => (
          <div key={s.l}>
            <div className="text-[10.5px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>{s.l}</div>
            <div className="font-serif text-[26px] mt-1" style={{ color: S.ink }}>{s.v}</div>
            <div className="text-[11.5px] mt-0.5" style={{ color: S.ink2 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {grouped.map((g) => (
        <div key={g.id} className="mb-6">
          <div className="text-[10.5px] font-mono uppercase tracking-[0.18em] mb-2.5" style={{ color: S.ink2 }}>{g.title}</div>
          <div className="rounded-2xl overflow-hidden" style={{ background: S.card, border: `1px solid ${S.line}` }}>
            {g.tools.map((t, i) => {
              const connected = state.defaultTools[t.id];
              return (
                <div key={t.id} className={`px-4 py-3.5 flex items-center gap-3 ${i < g.tools.length - 1 ? 'border-b' : ''}`}
                  style={{ borderColor: S.line }}>
                  <span className="w-9 h-9 rounded-lg grid place-items-center shrink-0"
                    style={{ background: connected ? `${S.accent}1A` : S.paper2, color: connected ? S.accent : S.ink2, border: `1px solid ${S.line}` }}>
                    <CTIcon name={t.icon} size={15} stroke={connected ? S.accent : S.ink2} strokeWidth={1.7} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-medium flex items-center gap-2" style={{ color: S.ink }}>
                      {t.label}
                      {connected ? <Chip>Connected</Chip> : null}
                    </div>
                    <div className="text-[12px]" style={{ color: S.ink2 }}>{t.desc}</div>
                  </div>
                  <button className="h-8 px-3 rounded-lg text-[12px]"
                    style={connected
                      ? { background: S.card, color: S.ink, border: `1px solid ${S.line}` }
                      : { background: S.accent, color: '#FFF' }}>
                    {connected ? 'Configure' : 'Connect'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Tools header button ─────────────────────────────────────────────

function ToolsHeaderButton() {
  const { state, activeTalk } = useApp();
  const btnRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const tools = effectiveTools(state, activeTalk);
  const enabled = CT_TOOLS.filter((t) => tools[t.id]);

  const onClick = () => {
    const r = btnRef.current?.getBoundingClientRect();
    setRect(r);
    setOpen((v) => !v);
  };

  return (
    <>
      <button ref={btnRef} onClick={onClick}
        className="h-8 pl-2.5 pr-3 rounded-lg text-[12.5px] inline-flex items-center gap-1.5"
        style={{
          background: enabled.length ? S.card : S.paper2,
          border: `1px solid ${S.line}`,
          color: S.ink,
        }}
        title={`${enabled.length} tools enabled`}>
        <CTIcon name="bolt" size={13} stroke={S.ink} strokeWidth={1.7} />
        <span>Tools</span>
        <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10.5px] font-mono"
          style={{ background: enabled.length ? S.accent : S.paper2, color: enabled.length ? '#FFF' : S.ink2, border: enabled.length ? 'none' : `1px solid ${S.line}` }}>
          {enabled.length}
        </span>
        <CTIcon name="chevron-d" size={11} stroke={S.ink2} strokeWidth={1.8} />
      </button>
      {open ? <ToolsPopover anchorRect={rect} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

Object.assign(window, { ToolsHeaderButton });
