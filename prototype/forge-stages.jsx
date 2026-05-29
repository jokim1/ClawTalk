/* eslint-disable */
// Forge — Stage 2 (Live run) + Stage 3 (Version gallery) + the overlay
// shell + mount. Relies on atoms on window (S, CTIcon, Avatar) and the
// Forge data + config components.

// ─── ascending score line chart ─────────────────────────────────────────
function ForgeLineChart({ revealed, target, baseline, width = 560, height = 200 }) {
  const pad = { l: 34, r: 16, t: 16, b: 26 };
  const rounds = FORGE_ROUNDS;
  const maxR = rounds.length - 1;
  const yMin = 5.5, yMax = 8.0;
  const x = (r) => pad.l + (r / maxR) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (height - pad.t - pad.b);
  const pts = rounds.slice(0, revealed + 1);
  const poly = pts.map((p) => `${x(p.round)},${y(p.best)}`).join(' ');
  const gridY = [6.0, 6.5, 7.0, 7.5];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ display: 'block' }}>
      {/* gridlines */}
      {gridY.map((g) => (
        <g key={g}>
          <line x1={pad.l} y1={y(g)} x2={width - pad.r} y2={y(g)} stroke={S.line} strokeWidth="1" />
          <text x={pad.l - 8} y={y(g) + 3} textAnchor="end" fontSize="9" fontFamily="monospace" fill="#6B6660">{g.toFixed(1)}</text>
        </g>
      ))}
      {/* target line */}
      <line x1={pad.l} y1={y(target)} x2={width - pad.r} y2={y(target)} stroke={S.accent} strokeWidth="1.5" strokeDasharray="4 4" opacity="0.8" />
      <text x={width - pad.r} y={y(target) - 5} textAnchor="end" fontSize="9.5" fontFamily="monospace" fill={S.accent}>target {target.toFixed(1)}</text>
      {/* baseline marker */}
      <circle cx={x(0)} cy={y(baseline)} r="3.5" fill="#FFF" stroke={S.ink2} strokeWidth="1.5" />
      {/* climbing line */}
      <polyline points={poly} fill="none" stroke={S.accent} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((p, i) => (
        <g key={p.round}>
          <circle cx={x(p.round)} cy={y(p.best)} r={i === pts.length - 1 ? 5 : 3.5}
            fill={i === pts.length - 1 ? S.accent : '#FFF'} stroke={S.accent} strokeWidth="2" />
          {i === pts.length - 1 ? (
            <text x={x(p.round)} y={y(p.best) - 11} textAnchor="middle" fontSize="11" fontWeight="600" fontFamily="monospace" fill={S.accent}>{p.best.toFixed(1)}</text>
          ) : null}
          <text x={x(p.round)} y={height - 8} textAnchor="middle" fontSize="9" fontFamily="monospace" fill="#6B6660">{p.round === 0 ? 'base' : 'R' + p.round}</text>
        </g>
      ))}
    </svg>
  );
}

// candidate stream items per round (deterministic spread around the best)
function roundCandidates(r) {
  const best = FORGE_ROUNDS[r].best;
  const strat = ['Reframe hook','Lead with number','Cut jargon','Tighten structure','Add proof','Shift tone','Plain units','Procurement-first'];
  const n = FORGE_ROUNDS[r].candidates;
  const out = [];
  for (let i = 0; i < n; i++) {
    const jitter = (i === 0 ? 0 : -(0.2 + (i * 0.13) % 1.1));
    out.push({ id: `r${r}c${i}`, score: Math.max(5.2, best + jitter), strat: strat[i % strat.length], top: i < 2 });
  }
  return out;
}

// ─── Stage 2 · Live run ──────────────────────────────────────────────────
function ForgeRunning({ cfg, onDone, onCancel }) {
  const [revealed, setRevealed] = useState(0);   // round index currently shown
  const [feed, setFeed] = useState([]);          // streaming candidate lines
  const [done, setDone] = useState(false);
  const selCount = cfg.personaIds.length;

  useEffect(() => {
    let cancelled = false;
    let r = 0;
    // seed baseline
    setFeed([{ id: 'seed', round: 0, score: FORGE_BASELINE, strat: 'Baseline', top: false, base: true }]);
    const advance = () => {
      if (cancelled) return;
      r += 1;
      if (r > 3) { setDone(true); return; }
      setRevealed(r);
      const cands = roundCandidates(r);
      // stream candidate lines in quickly
      cands.forEach((c, i) => {
        setTimeout(() => { if (!cancelled) setFeed((f) => [{ ...c, round: r }, ...f]); }, i * 110);
      });
      setTimeout(advance, 1900);
    };
    const t = setTimeout(advance, 1100);
    return () => { cancelled = true; clearTimeout(t); };
  }, []);

  const spend = FORGE_ROUNDS[revealed].spend;
  const budgetPct = Math.min(100, (spend / cfg.budget) * 100);

  return (
    <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: '1.4fr 1fr', gridTemplateRows: '1fr auto' }}>
      {/* Left: chart + status */}
      <div className="min-h-0 overflow-y-auto ct-thin-scroll px-7 py-6 flex flex-col gap-5" style={{ borderRight: `1px solid ${S.line}` }}>
        <div className="flex items-center gap-3">
          <span className="relative flex h-2.5 w-2.5">
            {!done ? <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: S.accent }} /> : null}
            <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ background: done ? '#3F6B5C' : S.accent }} />
          </span>
          <div className="flex-1">
            <div className="font-serif text-[19px]" style={{ color: S.ink }}>
              {done ? 'Target reached — Forge stopped' : `Round ${revealed} of ${cfg.rounds} · scoring ${cfg.beamN} candidates`}
            </div>
            <div className="text-[12px]" style={{ color: S.ink2 }}>
              {done ? `Best version beats baseline by +${(FORGE_ROUNDS[3].best - FORGE_BASELINE).toFixed(1)}.` : `against ${selCount} personas on Synthetical · ~30s / batch`}
            </div>
          </div>
        </div>

        <div className="rounded-2xl p-4" style={{ background: S.paper2, border: `1px solid ${S.line}` }}>
          <div className="text-[11px] font-mono uppercase tracking-[0.16em] mb-1" style={{ color: S.ink2 }}>Best composite score / round</div>
          <ForgeLineChart revealed={revealed} target={cfg.target} baseline={FORGE_BASELINE} />
        </div>

        {/* stop conditions */}
        <div className="flex flex-col gap-2">
          <div className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>Stops on whichever comes first</div>
          <div className="grid grid-cols-2 gap-2">
            {[
              { k: 'target', label: 'Hits target', val: `≥ ${cfg.target.toFixed(1)}`, hit: done },
              { k: 'rounds', label: 'Max rounds', val: `${cfg.rounds} rounds`, hit: false },
              { k: 'plateau', label: 'Plateau', val: '< 0.1 for 2 rounds', hit: false },
              { k: 'budget', label: 'Budget cap', val: `$${cfg.budget}`, hit: false },
            ].map((c) => (
              <div key={c.k} className="rounded-lg px-3 py-2 flex items-center gap-2"
                style={{ background: c.hit ? `${'#3F6B5C'}14` : S.card, border: `1px solid ${c.hit ? '#3F6B5C55' : S.line}` }}>
                {c.hit ? <CTIcon name="check" size={13} stroke="#3F6B5C" strokeWidth={2.4} /> : <span className="w-3.5 h-3.5 rounded-full" style={{ border: `1.5px solid ${S.line}` }} />}
                <div className="flex-1 min-w-0">
                  <div className="text-[12px]" style={{ color: S.ink }}>{c.label}</div>
                  <div className="font-mono text-[10.5px]" style={{ color: S.ink2 }}>{c.val}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right: live candidate feed */}
      <div className="min-h-0 overflow-y-auto ct-thin-scroll px-6 py-6 flex flex-col gap-3" style={{ background: S.paper2 }}>
        <div className="flex items-baseline justify-between">
          <div className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>Candidates streaming in</div>
          <div className="font-mono text-[11px]" style={{ color: S.ink2 }}>{feed.filter((f) => !f.base).length} scored</div>
        </div>
        <div className="flex flex-col gap-1.5">
          {feed.map((c) => (
            <div key={c.id} className="rounded-lg px-3 py-2 flex items-center gap-2.5 ct-screen-enter"
              style={{ background: c.base ? S.card : (c.top ? `${S.accent}0E` : S.card), border: `1px solid ${c.top ? S.accent + '44' : S.line}` }}>
              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: S.paper2, color: S.ink2 }}>
                {c.base ? 'base' : 'R' + c.round}
              </span>
              <span className="text-[12px] flex-1 min-w-0 truncate" style={{ color: S.ink }}>{c.strat}</span>
              {c.top && !c.base ? <span className="text-[9px] font-mono uppercase tracking-wide" style={{ color: S.accent }}>kept</span> : null}
              <ScoreChip value={c.score} />
            </div>
          ))}
        </div>
      </div>

      {/* footer */}
      <div className="col-span-2 flex items-center gap-4 px-7 h-[68px] border-t shrink-0" style={{ borderColor: S.line, background: S.card }}>
        <div className="flex items-center gap-2.5 w-[260px]">
          <span className="text-[11px] font-mono uppercase tracking-[0.14em]" style={{ color: S.ink2 }}>Spent</span>
          <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: S.paper2 }}>
            <div className="h-full rounded-full transition-all" style={{ width: budgetPct + '%', background: S.accent }} />
          </div>
          <span className="font-mono text-[12.5px]" style={{ color: S.ink }}>${spend}<span style={{ color: S.ink2 }}>/{cfg.budget}</span></span>
        </div>
        <div className="flex-1" />
        {!done ? (
          <button onClick={onCancel} className="h-9 px-4 rounded-full text-[12.5px] inline-flex items-center gap-1.5 whitespace-nowrap"
            style={{ background: S.card, color: '#A8434A', border: `1px solid ${S.line}` }}>
            <CTIcon name="x" size={13} stroke="#A8434A" /> Cancel run
          </button>
        ) : (
          <button onClick={onDone} className="h-10 px-5 rounded-full text-[13.5px] font-medium inline-flex items-center gap-2 text-white whitespace-nowrap" style={{ background: S.accent }}>
            See the {FORGE_VERSIONS.length} versions <CTIcon name="arrow" size={14} stroke="#FFF" strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── diff line helpers (word-level, lightweight) ─────────────────────────
function DiffText({ children, mode }) {
  // mode: 'add' | 'del' | undefined
  const style = mode === 'add'
    ? { background: `${S.accent}22`, color: S.ink, borderRadius: 3, padding: '0 2px' }
    : mode === 'del'
    ? { textDecoration: 'line-through', color: S.ink2, opacity: 0.7 }
    : {};
  return <span style={style}>{children}</span>;
}

// ─── Stage 3 · Version gallery ───────────────────────────────────────────
function ForgeGallery({ cfg, onClose, onRestart }) {
  const [view, setView] = useState('board');   // board | diff
  const [openId, setOpenId] = useState('v-w');
  const [promoted, setPromoted] = useState(false);
  const winner = FORGE_VERSIONS.find((v) => v.decision === 'winner');
  const ranked = [...FORGE_VERSIONS].sort((a, b) => b.score - a.score);
  const heldOutGap = (winner.score - winner.heldOut).toFixed(1);
  const personaById = (id) => FORGE_PERSONAS.find((p) => p.id === id);

  if (promoted) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
        <div className="w-16 h-16 rounded-full grid place-items-center" style={{ background: '#3F6B5C14', border: '1px solid #3F6B5C44' }}>
          <CTIcon name="check" size={28} stroke="#3F6B5C" strokeWidth={2.2} />
        </div>
        <div className="font-serif text-[24px]" style={{ color: S.ink }}>Winner promoted as a pending edit</div>
        <div className="text-[13.5px] max-w-[460px]" style={{ color: S.ink2 }}>
          The chosen version was written into <span className="font-mono">pricing-v2-draft.md</span> through the normal edit flow — review and accept it in the document pane. Nothing was overwritten.
        </div>
        <div className="flex items-center gap-2 mt-2">
          <button onClick={onRestart} className="h-9 px-4 rounded-full text-[12.5px]" style={{ color: S.ink2, border: `1px solid ${S.line}` }}>Run again</button>
          <button onClick={onClose} className="h-9 px-4 rounded-full text-[12.5px] font-medium text-white" style={{ background: S.accent }}>Back to document</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: '1.5fr 1fr', gridTemplateRows: '1fr auto' }}>
      {/* Left: winner + diff/board */}
      <div className="min-h-0 overflow-y-auto ct-thin-scroll px-7 py-6 flex flex-col gap-5" style={{ borderRight: `1px solid ${S.line}` }}>

        {/* Winner hero */}
        <div className="rounded-2xl p-5 relative overflow-hidden" style={{ background: S.card, border: `1.5px solid ${S.accent}` }}>
          <div className="absolute inset-0 pointer-events-none" style={{ background: `radial-gradient(60% 120% at 100% 0%, ${S.accent}14 0%, transparent 60%)` }} />
          <div className="relative flex items-start gap-4">
            <div className="flex flex-col items-center shrink-0">
              <span className="text-[10px] font-mono uppercase tracking-[0.16em] mb-1" style={{ color: S.accent }}>Winner</span>
              <ScoreChip value={winner.score} big />
              <span className="mt-1 text-[11px] font-mono px-2 py-0.5 rounded-full" style={{ background: '#3F6B5C14', color: '#3F6B5C' }}>+{winner.delta.toFixed(1)} vs base</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-serif text-[19px] leading-snug" style={{ color: S.ink }}>{winner.title}</div>
              <div className="text-[11.5px] font-mono mt-1" style={{ color: S.ink2 }}>{winner.strategy} · round {winner.round}</div>
              <p className="font-serif text-[14px] leading-[1.6] mt-2.5" style={{ color: S.ink }}>{winner.excerpt}</p>
            </div>
          </div>
        </div>

        {/* view toggle */}
        <div className="flex items-center gap-2">
          {[['board','All versions'],['diff','Diff vs current']].map(([k, label]) => {
            const on = view === k;
            return (
              <button key={k} onClick={() => setView(k)} className="h-8 px-3.5 rounded-full text-[12.5px]"
                style={{ background: on ? S.ink : S.card, color: on ? S.paper : S.ink2, border: `1px solid ${on ? S.ink : S.line}` }}>{label}</button>
            );
          })}
          <div className="flex-1" />
          <span className="text-[11.5px]" style={{ color: S.ink2 }}>{FORGE_VERSIONS.length} versions across {FORGE_ROUNDS.length - 1} rounds</span>
        </div>

        {view === 'diff' ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl p-4" style={{ background: S.paper2, border: `1px solid ${S.line}` }}>
              <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] mb-2" style={{ color: S.ink2 }}>Your current draft · {FORGE_BASELINE.toFixed(1)}</div>
              <p className="font-serif text-[13.5px] leading-[1.65]" style={{ color: S.ink }}>
                For the 50-seat eng band, the strongest position is a <DiffText mode="del">seat + usage hybrid with a procurement-friendly cap</DiffText>. Bundled <DiffText mode="del">10M tokens / seat / month</DiffText> covers the median power user; overage charged at <DiffText mode="del">$4 / M tokens</DiffText>.
              </p>
            </div>
            <div className="rounded-xl p-4" style={{ background: S.card, border: `1.5px solid ${S.accent}66` }}>
              <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] mb-2" style={{ color: S.accent }}>Forge winner · {winner.score.toFixed(1)}</div>
              <p className="font-serif text-[13.5px] leading-[1.65]" style={{ color: S.ink }}>
                For a 50-seat engineering org, the question procurement actually asks is <DiffText mode="add">"what is the worst case on the invoice?"</DiffText> — so we answer it first: <DiffText mode="add">one predictable seat price, a soft cap you set</DiffText>, and usage billed in plain <DiffText mode="add">"AI actions," never tokens</DiffText>.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {ranked.map((v, i) => {
              const open = openId === v.id;
              const tone = v.decision === 'winner' ? S.accent : v.decision === 'discard' ? '#A8434A' : S.ink2;
              return (
                <div key={v.id} className="rounded-xl overflow-hidden" style={{ background: S.card, border: `1px solid ${open ? S.accent + '55' : S.line}` }}>
                  <button onClick={() => setOpenId(open ? null : v.id)} className="w-full px-3.5 py-2.5 flex items-center gap-3 text-left">
                    <span className="font-mono text-[12px] w-5 text-center shrink-0" style={{ color: S.ink2 }}>{i + 1}</span>
                    <ScoreChip value={v.score} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] truncate" style={{ color: S.ink }}>{v.title}</div>
                      <div className="text-[11px] font-mono" style={{ color: S.ink2 }}>{v.strategy}</div>
                    </div>
                    <span className="text-[9.5px] font-mono uppercase tracking-[0.12em] px-1.5 py-0.5 rounded shrink-0" style={{ background: `${tone}1A`, color: tone }}>{v.decision}</span>
                    <span className="font-mono text-[10.5px] shrink-0" style={{ color: S.ink2 }}>R{v.round}</span>
                    <CTIcon name={open ? 'chevron-d' : 'chevron-r'} size={13} stroke={S.ink2} />
                  </button>
                  {open ? (
                    <div className="px-3.5 pb-3.5 pt-1 border-t flex flex-col gap-2.5" style={{ borderColor: S.line }}>
                      <p className="font-serif text-[13px] leading-[1.6]" style={{ color: S.ink }}>{v.excerpt}</p>
                      <div className="text-[10.5px] font-mono uppercase tracking-[0.14em]" style={{ color: S.ink2 }}>Why personas scored it this way</div>
                      {v.feedback.map((f) => {
                        const p = personaById(f.pid);
                        return (
                          <div key={f.pid} className="flex items-start gap-2.5">
                            <Avatar initials={p.initials} color={p.accent} size={26} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-[12px] font-medium whitespace-nowrap" style={{ color: S.ink }}>{p.name}</span>
                                <ScoreChip value={f.score} />
                              </div>
                              <div className="font-serif italic text-[12.5px] leading-snug" style={{ color: S.ink2 }}>"{f.note}"</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Right: trust panel */}
      <div className="min-h-0 overflow-y-auto ct-thin-scroll px-6 py-6 flex flex-col gap-4" style={{ background: S.paper2 }}>
        <div className="font-serif text-[18px]" style={{ color: S.ink }}>Is the gain real?</div>
        <div className="text-[12.5px] leading-snug" style={{ color: S.ink2 }}>
          A persona score is a <span className="font-medium">screening</span> signal, not launch truth. Optimizing hard against it can drift into gaming the panel — so we check the winner against personas the loop never saw.
        </div>

        <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: S.card, border: `1px solid ${S.line}` }}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] whitespace-nowrap" style={{ color: S.ink2 }}>Optimized personas</span>
            <ScoreChip value={winner.score} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] inline-flex items-center gap-1.5 whitespace-nowrap" style={{ color: S.ink2 }}>
              <CTIcon name="eye" size={12} stroke={S.ink2} /> Held-out personas
            </span>
            <ScoreChip value={winner.heldOut} />
          </div>
          <div className="h-px" style={{ background: S.line }} />
          <div className="flex items-center justify-between">
            <span className="text-[12px]" style={{ color: S.ink2 }}>Over-fit gap</span>
            <span className="font-mono text-[14px]" style={{ color: heldOutGap <= 0.3 ? '#3F6B5C' : '#9A7B2E' }}>{heldOutGap}</span>
          </div>
          <div className="rounded-lg px-3 py-2 flex items-center gap-2" style={{ background: '#3F6B5C14' }}>
            <CTIcon name="check" size={14} stroke="#3F6B5C" strokeWidth={2.2} />
            <span className="text-[12.5px]" style={{ color: '#2F5247' }}>Gain holds on unseen personas — safe to promote.</span>
          </div>
        </div>

        <div className="rounded-2xl p-4 flex flex-col gap-2" style={{ background: S.card, border: `1px solid ${S.line}` }}>
          <div className="text-[11px] font-mono uppercase tracking-[0.14em]" style={{ color: S.ink2 }}>Run summary</div>
          {[
            ['Spent', `$${FORGE_BUDGET.spend} / ${cfg.budget}`],
            ['Rounds', `3 of ${cfg.rounds}`],
            ['Stopped on', 'Target reached'],
            ['Scored by', `${cfg.personaIds.length} personas · ${FORGE_ORG.name}`],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between text-[12.5px]">
              <span style={{ color: S.ink2 }}>{k}</span>
              <span className="font-mono" style={{ color: S.ink }}>{v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* footer */}
      <div className="col-span-2 flex items-center gap-3 px-7 h-[68px] border-t shrink-0" style={{ borderColor: S.line, background: S.card }}>
        <div className="text-[12.5px]" style={{ color: S.ink2 }}>
          Choosing a winner writes it back as a <span className="font-medium" style={{ color: S.ink }}>pending edit</span> — you still accept it in the doc. Forge never overwrites your work.
        </div>
        <div className="flex-1" />
        <button onClick={onRestart} className="h-9 px-4 rounded-full text-[12.5px]" style={{ color: S.ink2, border: `1px solid ${S.line}` }}>Discard run</button>
        <button onClick={() => setPromoted(true)} className="h-10 px-5 rounded-full text-[13.5px] font-medium inline-flex items-center gap-2 text-white" style={{ background: S.accent }}>
          <CTIcon name="check" size={15} stroke="#FFF" strokeWidth={2.2} /> Set winner as document
        </button>
      </div>
    </div>
  );
}

// ─── Overlay shell + stage stepper ───────────────────────────────────────
function ForgeOverlay({ onClose }) {
  const app = (typeof useApp === 'function') ? useApp() : {};
  const doc = app.activeDoc || { title: 'pricing-v2-draft.md' };
  const [stage, setStage] = useState('config');
  const [cfg, setCfg] = useState(() => {
    const aud = FORGE_AUDIENCES[0];
    return {
      scopeKind: 'doc', audience: aud.id, personaIds: aud.personaIds.slice(),
      refSet: aud.refSet, question: aud.question,
      target: FORGE_TARGET, rounds: 5, budget: FORGE_BUDGET.cap,
      advanced: false, beamN: 8, beamK: 3, heldOut: true,
      mutations: Object.fromEntries(FORGE_MUTATIONS.map((m) => [m.id, m.on])),
    };
  });

  const steps = [['config', 'Configure'], ['running', 'Run'], ['gallery', 'Choose winner']];
  const stageIdx = steps.findIndex((s) => s[0] === stage);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <style>{`
        .forge-range { -webkit-appearance:none; appearance:none; height:5px; border-radius:6px;
          background: linear-gradient(to right, ${S.accent} var(--pct), ${'#E6E0D1'} var(--pct)); outline:none; }
        .forge-range::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:16px; height:16px; border-radius:50%;
          background:#fff; border:2px solid ${S.accent}; cursor:pointer; box-shadow:0 1px 3px rgba(31,27,22,0.25); }
        .forge-range::-moz-range-thumb { width:16px; height:16px; border-radius:50%; background:#fff; border:2px solid ${S.accent}; cursor:pointer; }
      `}</style>
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-5" style={{ background: 'rgba(31,27,22,0.5)' }}>
        <div className="flex flex-col rounded-2xl overflow-hidden ct-screen-enter"
          style={{ width: 'min(1120px, 96vw)', height: 'min(760px, 92vh)', background: S.paper, border: `1px solid ${S.line}`, boxShadow: '0 40px 90px rgba(31,27,22,0.4)' }}>

          {/* header */}
          <div className="h-15 px-6 flex items-center gap-4 shrink-0 border-b" style={{ borderColor: S.line, background: S.card, height: 60 }}>
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-lg grid place-items-center" style={{ background: `${S.accent}14`, border: `1px solid ${S.accent}33` }}>
                <ForgeMark size={18} />
              </span>
              <div>
                <div className="font-serif text-[16px] leading-none" style={{ color: S.ink }}>Forge</div>
                <div className="text-[10.5px] font-mono mt-0.5" style={{ color: S.ink2 }}>improving · {doc.title}</div>
              </div>
            </div>

            {/* stepper */}
            <div className="flex items-center gap-1.5 ml-3">
              {steps.map((s, i) => {
                const active = i === stageIdx, doneStep = i < stageIdx;
                return (
                  <React.Fragment key={s[0]}>
                    {i > 0 ? <span className="w-5 h-px" style={{ background: S.line }} /> : null}
                    <span className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full text-[11.5px] whitespace-nowrap"
                      style={{ background: active ? S.accent : doneStep ? `${S.accent}14` : 'transparent', color: active ? '#FFF' : doneStep ? S.accent : S.ink2, border: active ? 'none' : `1px solid ${S.line}` }}>
                      <span className="font-mono">{doneStep ? '✓' : i + 1}</span> {s[1]}
                    </span>
                  </React.Fragment>
                );
              })}
            </div>

            <div className="flex-1" />
            <span className="text-[11px] font-mono inline-flex items-center gap-1.5" style={{ color: S.ink2 }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#3F6B5C' }} /> Synthetical · {FORGE_ORG.name}
            </span>
            <button onClick={onClose} className="w-8 h-8 grid place-items-center rounded-lg" style={{ color: S.ink2, border: `1px solid ${S.line}` }}>
              <CTIcon name="x" size={15} />
            </button>
          </div>

          {/* body */}
          {stage === 'config' ? (
            <ForgeConfig cfg={cfg} setCfg={setCfg} doc={doc} onStart={() => setStage('running')} />
          ) : stage === 'running' ? (
            <ForgeRunning cfg={cfg} onDone={() => setStage('gallery')} onCancel={onClose} />
          ) : (
            <ForgeGallery cfg={cfg} onClose={onClose} onRestart={() => setStage('config')} />
          )}
        </div>
      </div>
    </>
  );
}

// ─── mount — listens for the doc-pane "Improve" action ───────────────────
function ForgeMount() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener('ct-forge-open', h);
    return () => window.removeEventListener('ct-forge-open', h);
  }, []);
  if (!open) return null;
  return <ForgeOverlay onClose={() => setOpen(false)} />;
}

Object.assign(window, { ForgeLineChart, ForgeRunning, ForgeGallery, ForgeOverlay, ForgeMount });
