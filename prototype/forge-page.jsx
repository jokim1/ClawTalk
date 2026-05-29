/* eslint-disable */
// Forge — the dedicated page (rail destination "forge") + the compact
// in-doc launcher. The document keeps a simple "Improve" launcher; all the
// depth — run history, score charts, version galleries, per-persona LLM
// responses, audiences, and the Synthetical connection — lives here.
//
// Reuses on window: S, CTIcon, Avatar, IconRail, TopBar, ScoreChip,
// ForgeMark, ForgeField, ForgeSlider, PersonaCard, ForgeConfig, and the
// FORGE_* data.

// ─── shared helpers ──────────────────────────────────────────────────────
function fRun(id) { return FORGE_RUNS.find((r) => r.id === id); }
function synthRounds(run) {
  const out = [{ round: 0, best: run.base }];
  for (let i = 1; i <= run.rounds; i++) out.push({ round: i, best: +(run.base + (run.best - run.base) * (i / run.rounds)).toFixed(1) });
  return out;
}
function runVersions(run) {
  if (run.rich) return [...FORGE_VERSIONS].sort((a, b) => b.score - a.score);
  // lightweight synthetic leaderboard for non-rich runs
  const strat = ['Reframe the hook', 'Lead with the number', 'Cut the jargon', 'Tighten structure', 'Add proof'];
  const n = 4;
  const out = [];
  for (let i = 0; i < n; i++) {
    const score = +(run.best - i * ((run.best - run.base) / (n + 1))).toFixed(1);
    out.push({ id: run.id + '-v' + i, score, delta: +(score - run.base).toFixed(1), strategy: strat[i % strat.length],
      decision: i === 0 ? (run.status === 'completed' ? 'winner' : 'frontier') : i === n - 1 ? 'discard' : 'keep',
      round: Math.max(1, run.rounds - i), title: strat[i % strat.length], feedback: [] });
  }
  return out;
}
const STATUS_META = {
  completed: { label: 'Completed', c: '#3F6B5C' },
  running:   { label: 'Running',   c: '#C8643A' },
  plateaued: { label: 'Plateaued', c: '#9A7B2E' },
  cancelled: { label: 'Cancelled', c: '#A8434A' },
};

// ─── parameterized score chart ───────────────────────────────────────────
function RunChart({ rounds, target, base, revealed = 999, height = 190 }) {
  const width = 560, pad = { l: 34, r: 16, t: 18, b: 26 };
  const maxR = Math.max(1, rounds.length - 1);
  const allBest = rounds.map((r) => r.best);
  const yMin = Math.min(base, ...allBest, target) - 0.4;
  const yMax = Math.max(...allBest, target) + 0.4;
  const x = (r) => pad.l + (r / maxR) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (height - pad.t - pad.b);
  const pts = rounds.slice(0, revealed + 1);
  const poly = pts.map((p) => `${x(p.round)},${y(p.best)}`).join(' ');
  const grid = [];
  for (let g = Math.ceil(yMin * 2) / 2; g <= yMax; g += 0.5) grid.push(+g.toFixed(1));
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ display: 'block' }}>
      {grid.map((g) => (
        <g key={g}>
          <line x1={pad.l} y1={y(g)} x2={width - pad.r} y2={y(g)} stroke={S.line} strokeWidth="1" />
          <text x={pad.l - 8} y={y(g) + 3} textAnchor="end" fontSize="9" fontFamily="monospace" fill="#6B6660">{g.toFixed(1)}</text>
        </g>
      ))}
      <line x1={pad.l} y1={y(target)} x2={width - pad.r} y2={y(target)} stroke={S.accent} strokeWidth="1.5" strokeDasharray="4 4" opacity="0.8" />
      <text x={width - pad.r} y={y(target) - 5} textAnchor="end" fontSize="9.5" fontFamily="monospace" fill={S.accent}>target {target.toFixed(1)}</text>
      <circle cx={x(0)} cy={y(base)} r="3.5" fill="#FFF" stroke={S.ink2} strokeWidth="1.5" />
      <polyline points={poly} fill="none" stroke={S.accent} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((p, i) => (
        <g key={p.round}>
          <circle cx={x(p.round)} cy={y(p.best)} r={i === pts.length - 1 ? 5 : 3.5} fill={i === pts.length - 1 ? S.accent : '#FFF'} stroke={S.accent} strokeWidth="2" />
          {i === pts.length - 1 ? <text x={x(p.round)} y={y(p.best) - 11} textAnchor="middle" fontSize="11" fontWeight="600" fontFamily="monospace" fill={S.accent}>{p.best.toFixed(1)}</text> : null}
          <text x={x(p.round)} y={height - 8} textAnchor="middle" fontSize="9" fontFamily="monospace" fill="#6B6660">{p.round === 0 ? 'base' : 'R' + p.round}</text>
        </g>
      ))}
    </svg>
  );
}

// ─── Likert distribution bar (5 buckets, 1–5) ────────────────────────────
function LikertBar({ arr }) {
  const max = Math.max(1, ...arr);
  const mean = forgeLikertMean(arr);
  return (
    <div className="flex items-end gap-[3px] h-7" title={`mean ${mean.toFixed(1)} / 5`}>
      {arr.map((v, i) => (
        <div key={i} className="w-2.5 rounded-sm" style={{ height: `${Math.max(8, (v / max) * 100)}%`, background: i + 1 >= 4 ? S.accent : i + 1 === 3 ? '#9A7B2E' : '#C9938A', opacity: v === 0 ? 0.25 : 1 }} />
      ))}
    </div>
  );
}

// ─── one persona's response on a version (the depth) ──────────────────────
function PersonaResponse({ pid, score, response, likert }) {
  const p = FORGE_PERSONAS.find((x) => x.id === pid);
  if (!p) return null;
  return (
    <div className="rounded-xl p-3.5 flex gap-3" style={{ background: S.card, border: `1px solid ${S.line}` }}>
      <Avatar initials={p.initials} color={p.accent} size={34} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium whitespace-nowrap" style={{ color: S.ink }}>{p.name}</span>
          <span className="text-[11px]" style={{ color: S.ink2 }}>{p.title}</span>
          <span className="flex-1" />
          <ScoreChip value={score} />
        </div>
        <p className="font-serif text-[13px] leading-[1.6] mt-1.5" style={{ color: S.ink }}>{response}</p>
        {likert ? (
          <div className="flex items-center gap-2 mt-2">
            <LikertBar arr={likert} />
            <span className="text-[10.5px] font-mono" style={{ color: S.ink2 }}>spread across {likert.reduce((a, b) => a + b, 0)} samples · 1–5</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── how-it-works explainer (shared by onboarding + setup) ────────────────
function HowItWorks({ compact }) {
  const steps = [
    { n: 1, t: 'Pick an audience', d: 'Synthetic personas from your Synthetical org define who "good" is for.' },
    { n: 2, t: 'Forge proposes & scores', d: 'It rewrites your draft many ways each round and scores every candidate against the panel.' },
    { n: 3, t: 'It stops on its own', d: 'When it hits your target score, plateaus, or reaches the budget cap — whichever comes first.' },
    { n: 4, t: 'You choose the winner', d: 'Pick from a ranked gallery; the winner lands as a pending edit you accept. Nothing is overwritten.' },
  ];
  return (
    <div className={`grid ${compact ? 'grid-cols-2' : 'grid-cols-4'} gap-3`}>
      {steps.map((s) => (
        <div key={s.n} className="rounded-xl p-3.5" style={{ background: S.card, border: `1px solid ${S.line}` }}>
          <span className="w-6 h-6 rounded-full grid place-items-center font-mono text-[11px]" style={{ background: `${S.accent}1A`, color: S.accent }}>{s.n}</span>
          <div className="font-serif text-[14.5px] mt-2" style={{ color: S.ink }}>{s.t}</div>
          <div className="text-[11.5px] leading-snug mt-1" style={{ color: S.ink2 }}>{s.d}</div>
        </div>
      ))}
    </div>
  );
}

// ─── ONBOARDING (when not connected) ──────────────────────────────────────
function ForgeOnboarding() {
  return (
    <div className="flex-1 overflow-y-auto ct-thin-scroll px-9 py-10">
      <div className="max-w-[860px] mx-auto flex flex-col gap-8">
        <div className="flex flex-col items-center text-center gap-3">
          <span className="w-14 h-14 rounded-2xl grid place-items-center" style={{ background: `${S.accent}14`, border: `1px solid ${S.accent}33` }}>
            <ForgeMark size={28} />
          </span>
          <h1 className="font-serif text-[34px] leading-tight tracking-tight" style={{ color: S.ink }}>Connect Synthetical to use Forge</h1>
          <p className="text-[14.5px] max-w-[560px]" style={{ color: S.ink2 }}>
            Forge turns a document into something you can <em>measurably</em> improve. It scores your draft against synthetic personas on <span className="font-medium">Synthetical</span> and iterates until a quality bar is met — then hands you the winner to accept.
          </p>
          <button onClick={() => setForgeConnected(true)}
            className="h-11 px-6 rounded-full text-[14px] font-medium text-white inline-flex items-center gap-2 mt-1 whitespace-nowrap" style={{ background: S.accent }}>
            <CTIcon name="globe" size={16} stroke="#FFF" /> Connect Synthetical
          </button>
          <a className="text-[12.5px] inline-flex items-center gap-1 mt-0.5" style={{ color: S.ink2 }} href="#">
            What is Synthetical? <CTIcon name="arrow" size={11} stroke={S.ink2} />
          </a>
        </div>
        <div>
          <div className="text-[11px] font-mono uppercase tracking-[0.16em] mb-3" style={{ color: S.ink2 }}>How Forge works</div>
          <HowItWorks />
        </div>
        <div className="rounded-2xl p-5 flex items-start gap-3" style={{ background: S.paper2, border: `1px dashed ${S.line}` }}>
          <CTIcon name="bolt" size={16} stroke={S.ink2} />
          <div className="text-[12.5px] leading-relaxed" style={{ color: S.ink2 }}>
            A persona score is a <span className="font-medium" style={{ color: S.ink }}>screening</span> signal, not launch truth. Forge re-scores every winner against held-out personas it never optimized against, and surfaces the gap so you can trust the gain is real.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── RUNS LIST ─────────────────────────────────────────────────────────────
function ForgeRunsList({ onOpen, onNewRun }) {
  return (
    <div className="flex-1 overflow-y-auto ct-thin-scroll px-9 py-7">
      <div className="max-w-[1100px] mx-auto flex flex-col gap-6">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-[0.18em]" style={{ color: S.ink2 }}>Forge · Oxbow &amp; Co.</div>
            <h1 className="font-serif text-[34px] leading-[1.05] tracking-tight mt-1" style={{ color: S.ink }}>Improvement runs</h1>
            <p className="text-[14px] mt-2 max-w-[620px]" style={{ color: S.ink2 }}>Every run across your documents. Open one to see the score chart, the version gallery, and exactly why each persona scored it the way it did.</p>
          </div>
          <button onClick={onNewRun} className="h-9 px-4 rounded-full text-[13px] font-medium text-white inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap" style={{ background: S.accent }}>
            <CTIcon name="plus" size={13} stroke="#FFF" strokeWidth={2} /> New run
          </button>
        </div>

        {/* stats */}
        <div className="grid grid-cols-4 gap-3">
          {[
            { l: 'Runs', v: String(FORGE_RUNS.length), s: `${FORGE_RUNS.filter((r) => r.status === 'running').length} running now` },
            { l: 'Median lift', v: '+1.0', s: 'winner vs baseline' },
            { l: 'Promoted', v: '9', s: 'versions set as document' },
            { l: 'Spend · 30d', v: '$284', s: 'across all runs' },
          ].map((s) => (
            <div key={s.l} className="rounded-2xl p-4" style={{ background: S.card, border: `1px solid ${S.line}` }}>
              <div className="text-[10.5px] font-mono uppercase tracking-[0.18em]" style={{ color: S.ink2 }}>{s.l}</div>
              <div className="font-serif text-[26px] leading-none tracking-tight mt-1.5" style={{ color: S.ink }}>{s.v}</div>
              <div className="text-[11.5px] mt-2" style={{ color: S.ink2 }}>{s.s}</div>
            </div>
          ))}
        </div>

        {/* table */}
        <div className="rounded-2xl overflow-hidden" style={{ background: S.card, border: `1px solid ${S.line}` }}>
          <div className="h-10 px-4 flex items-center gap-3 border-b text-[11px] font-mono uppercase tracking-[0.14em]" style={{ borderColor: S.line, color: S.ink2 }}>
            <span className="flex-1">Document</span>
            <span className="w-[170px]">Audience</span>
            <span className="w-[120px]">Score</span>
            <span className="w-[110px]">Status</span>
            <span className="w-[70px] text-right">When</span>
          </div>
          {FORGE_RUNS.map((r) => {
            const sm = STATUS_META[r.status];
            return (
              <button key={r.id} onClick={() => onOpen(r.id)}
                className="w-full h-14 px-4 flex items-center gap-3 border-b last:border-0 hover:bg-[var(--salon-paper-2)] transition-colors text-left" style={{ borderColor: S.line }}>
                <span className="flex-1 min-w-0 flex items-center gap-2.5">
                  <CTIcon name="doc" size={14} stroke={S.ink2} />
                  <span className="font-mono text-[12.5px] truncate" style={{ color: S.ink }}>{r.doc}</span>
                </span>
                <span className="w-[170px] text-[12.5px] truncate" style={{ color: S.ink2 }}>{r.audience}</span>
                <span className="w-[120px] flex items-center gap-1.5">
                  <span className="font-mono text-[12px]" style={{ color: S.ink2 }}>{r.base.toFixed(1)}</span>
                  <CTIcon name="arrow" size={11} stroke={S.ink2} />
                  <ScoreChip value={r.best} />
                </span>
                <span className="w-[110px]">
                  <span className="inline-flex items-center gap-1.5 text-[11.5px] px-2 py-0.5 rounded-full" style={{ background: `${sm.c}14`, color: sm.c }}>
                    {r.status === 'running' ? <span className="w-1.5 h-1.5 rounded-full ct-pulse" style={{ background: sm.c }} /> : null}{sm.label}
                  </span>
                </span>
                <span className="w-[70px] text-right font-mono text-[11px]" style={{ color: S.ink2 }}>{r.when}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── RUN DETAIL (live + completed, with persona responses) ────────────────
function ForgeRunDetail({ runId, live, onBack }) {
  const run = fRun(runId) || FORGE_RUNS[0];
  const versions = runVersions(run);
  const [openVer, setOpenVer] = useState(versions[0]?.id);
  const [revealed, setRevealed] = useState(live ? 0 : run.rounds);
  const [running, setRunning] = useState(!!live);
  const rounds = synthRounds(run);

  useEffect(() => {
    if (!live) return;
    let r = 0, cancelled = false;
    const tick = () => {
      if (cancelled) return;
      r += 1; setRevealed(r);
      if (r >= run.rounds) { setRunning(false); return; }
      setTimeout(tick, 1500);
    };
    const t = setTimeout(tick, 1100);
    return () => { cancelled = true; clearTimeout(t); };
  }, [live, run.rounds]);

  const sm = STATUS_META[run.status];
  const ver = versions.find((v) => v.id === openVer) || versions[0];
  const responses = (run.rich && FORGE_RESPONSES[ver?.id]) || {};
  const respByPid = {};
  (ver?.feedback || []).forEach((f) => { respByPid[f.pid] = { score: f.score, response: f.note }; });
  Object.entries(responses).forEach(([pid, d]) => { respByPid[pid] = { score: respByPid[pid]?.score || forgeLikertMean(d.likert), response: d.response, likert: d.likert }; });
  const respList = Object.entries(respByPid);

  return (
    <div className="flex-1 overflow-y-auto ct-thin-scroll px-9 py-7">
      <div className="max-w-[1180px] mx-auto flex flex-col gap-5">
        {/* breadcrumb + header */}
        <div className="flex items-center gap-2 text-[12px]" style={{ color: S.ink2 }}>
          <button onClick={onBack} className="inline-flex items-center gap-1" style={{ color: S.ink2 }}><CTIcon name="chevron-r" size={12} stroke={S.ink2} /> All runs</button>
          <span>·</span><span className="font-mono" style={{ color: S.ink }}>{run.doc}</span>
        </div>
        <div className="flex items-start gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <h1 className="font-serif text-[28px] leading-tight tracking-tight" style={{ color: S.ink }}>
              {running ? 'Forge is improving this document…' : run.status === 'completed' ? 'Improvement run' : sm.label + ' run'}
            </h1>
            <div className="flex items-center gap-2 mt-1.5 text-[12.5px]" style={{ color: S.ink2 }}>
              <span className="inline-flex items-center gap-1.5"><CTIcon name="sparkle" size={12} stroke={S.ink2} /> {run.audience}</span>
              <span>·</span>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full" style={{ background: `${sm.c}14`, color: sm.c }}>
                {running ? <span className="w-1.5 h-1.5 rounded-full ct-pulse" style={{ background: sm.c }} /> : null}{running ? 'Running' : sm.label}
              </span>
              <span>·</span><span className="font-mono">{run.when}</span>
            </div>
          </div>
          {!running && run.status === 'completed' ? (
            <button className="h-9 px-4 rounded-full text-[12.5px] font-medium text-white inline-flex items-center gap-1.5 whitespace-nowrap" style={{ background: S.accent }}>
              <CTIcon name="check" size={14} stroke="#FFF" strokeWidth={2.2} /> Set winner as document
            </button>
          ) : null}
        </div>

        {/* top row: chart + trust/summary */}
        <div className="grid gap-4" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
          <div className="rounded-2xl p-4" style={{ background: S.paper2, border: `1px solid ${S.line}` }}>
            <div className="flex items-center justify-between mb-1">
              <div className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>Best composite score / round</div>
              {running ? <div className="text-[11.5px]" style={{ color: S.accent }}>Round {revealed} of {run.maxRounds}…</div> : null}
            </div>
            <RunChart rounds={rounds} target={run.target} base={run.base} revealed={revealed} />
          </div>
          <div className="flex flex-col gap-3">
            {!running && run.heldOut != null ? (
              <div className="rounded-2xl p-4 flex flex-col gap-2.5" style={{ background: S.card, border: `1px solid ${S.line}` }}>
                <div className="text-[11px] font-mono uppercase tracking-[0.14em]" style={{ color: S.ink2 }}>Is the gain real?</div>
                <div className="flex items-center justify-between gap-2"><span className="text-[12px] whitespace-nowrap" style={{ color: S.ink2 }}>Optimized personas</span><ScoreChip value={run.best} /></div>
                <div className="flex items-center justify-between gap-2"><span className="text-[12px] inline-flex items-center gap-1.5 whitespace-nowrap" style={{ color: S.ink2 }}><CTIcon name="eye" size={12} stroke={S.ink2} /> Held-out personas</span><ScoreChip value={run.heldOut} /></div>
                <div className="rounded-lg px-3 py-2 flex items-center gap-2" style={{ background: (run.best - run.heldOut) <= 0.3 ? '#3F6B5C14' : '#9A7B2E14' }}>
                  <CTIcon name={(run.best - run.heldOut) <= 0.3 ? 'check' : 'bolt'} size={13} stroke={(run.best - run.heldOut) <= 0.3 ? '#3F6B5C' : '#9A7B2E'} strokeWidth={2.2} />
                  <span className="text-[12px]" style={{ color: S.ink }}>{(run.best - run.heldOut) <= 0.3 ? 'Gain holds — over-fit gap only ' : 'Watch over-fit — gap '}{(run.best - run.heldOut).toFixed(1)}</span>
                </div>
              </div>
            ) : null}
            <div className="rounded-2xl p-4 flex flex-col gap-1.5" style={{ background: S.card, border: `1px solid ${S.line}` }}>
              <div className="text-[11px] font-mono uppercase tracking-[0.14em] mb-0.5" style={{ color: S.ink2 }}>Run summary</div>
              {[['Spent', `$${run.spend} / ${run.budget}`], ['Rounds', `${running ? revealed : run.rounds} of ${run.maxRounds}`], ['Stopped on', running ? 'Running…' : (run.stopped || '—')], ['Personas', `${run.personas} · Oxbow Research`]].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between text-[12.5px]"><span style={{ color: S.ink2 }}>{k}</span><span className="font-mono" style={{ color: S.ink }}>{v}</span></div>
              ))}
            </div>
          </div>
        </div>

        {!running ? (
          <div className="grid gap-4" style={{ gridTemplateColumns: '1fr 1.25fr' }}>
            {/* version leaderboard */}
            <div className="flex flex-col gap-2">
              <div className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>{versions.length} versions · ranked</div>
              {versions.map((v, i) => {
                const on = openVer === v.id;
                const tone = v.decision === 'winner' ? S.accent : v.decision === 'discard' ? '#A8434A' : S.ink2;
                return (
                  <button key={v.id} onClick={() => setOpenVer(v.id)} className="rounded-xl px-3.5 py-2.5 flex items-center gap-3 text-left transition-colors"
                    style={{ background: on ? `${S.accent}0E` : S.card, border: on ? `1px solid ${S.accent}66` : `1px solid ${S.line}` }}>
                    <span className="font-mono text-[12px] w-4 text-center shrink-0" style={{ color: S.ink2 }}>{i + 1}</span>
                    <ScoreChip value={v.score} />
                    <span className="flex-1 min-w-0">
                      <span className="text-[13px] block truncate" style={{ color: S.ink }}>{v.title}</span>
                      <span className="text-[11px] font-mono" style={{ color: S.ink2 }}>{v.strategy}</span>
                    </span>
                    <span className="text-[9.5px] font-mono uppercase tracking-[0.1em] px-1.5 py-0.5 rounded shrink-0" style={{ background: `${tone}1A`, color: tone }}>{v.decision}</span>
                  </button>
                );
              })}
            </div>
            {/* selected version → persona responses */}
            <div className="flex flex-col gap-3">
              {ver?.excerpt ? (
                <div className="rounded-xl p-4" style={{ background: S.card, border: `1px solid ${S.line}` }}>
                  <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] mb-1.5" style={{ color: S.ink2 }}>The candidate · scored {ver.score.toFixed(1)}</div>
                  <p className="font-serif text-[14px] leading-[1.6]" style={{ color: S.ink }}>{ver.excerpt}</p>
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <div className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>Why the personas scored it</div>
                <div className="flex-1 h-px" style={{ background: S.line }} />
              </div>
              {respList.length ? respList.map(([pid, d]) => (
                <PersonaResponse key={pid} pid={pid} score={d.score} response={d.response} likert={d.likert} />
              )) : (
                <div className="rounded-xl p-4 text-[12.5px]" style={{ background: S.paper2, border: `1px dashed ${S.line}`, color: S.ink2 }}>
                  Verbatim persona responses are captured for rich runs. This summary run kept scores only.
                </div>
              )}
              {run.rich && respList.length ? (
                <div className="text-[11.5px] text-center py-1" style={{ color: S.ink2 }}>+ {Math.max(0, run.personas - respList.length)} more personas scored this version</div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="rounded-2xl p-5 flex items-center gap-3" style={{ background: S.paper2, border: `1px solid ${S.line}` }}>
            <span className="relative flex h-2.5 w-2.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: S.accent }} /><span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ background: S.accent }} /></span>
            <span className="text-[13px]" style={{ color: S.ink }}>Scoring candidates against {run.personas} personas… the gallery and per-persona responses appear when the run settles.</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── AUDIENCES ─────────────────────────────────────────────────────────────
function ForgeAudiences() {
  return (
    <div className="flex-1 overflow-y-auto ct-thin-scroll px-9 py-7">
      <div className="max-w-[1100px] mx-auto flex flex-col gap-7">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-[0.18em]" style={{ color: S.ink2 }}>Forge · audiences</div>
            <h1 className="font-serif text-[34px] leading-[1.05] tracking-tight mt-1" style={{ color: S.ink }}>Audiences &amp; personas</h1>
            <p className="text-[14px] mt-2 max-w-[640px]" style={{ color: S.ink2 }}>An audience is a saved bundle of personas, a reference set, and a survey question. Compose them here; personas themselves are authored on Synthetical.</p>
          </div>
          <button className="h-9 px-4 rounded-full text-[13px] font-medium text-white inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap" style={{ background: S.accent }}>
            <CTIcon name="plus" size={13} stroke="#FFF" strokeWidth={2} /> New audience
          </button>
        </div>

        <section className="flex flex-col gap-3">
          <div className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>Saved audiences</div>
          <div className="grid grid-cols-3 gap-3">
            {FORGE_AUDIENCES.map((aud) => {
              const ps = aud.personaIds.map((id) => FORGE_PERSONAS.find((p) => p.id === id)).filter(Boolean);
              const q = FORGE_QUESTIONS.find((x) => x.id === aud.question);
              return (
                <div key={aud.id} className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: S.card, border: `1px solid ${S.line}` }}>
                  <div className="flex items-center gap-2">
                    <span className="font-serif text-[17px] flex-1" style={{ color: S.ink }}>{aud.name}</span>
                    <span className="font-mono text-[11px] px-1.5 py-0.5 rounded" style={{ background: S.paper2, color: S.ink2 }}>{ps.length}</span>
                  </div>
                  <div className="flex -space-x-2">
                    {ps.slice(0, 6).map((p) => <span key={p.id} style={{ boxShadow: `0 0 0 2px ${S.card}`, borderRadius: '50%' }}><Avatar initials={p.initials} color={p.accent} size={26} /></span>)}
                    {ps.length > 6 ? <span className="w-[26px] h-[26px] rounded-full grid place-items-center text-[10px] font-mono" style={{ background: S.paper2, color: S.ink2, boxShadow: `0 0 0 2px ${S.card}` }}>+{ps.length - 6}</span> : null}
                  </div>
                  <div className="text-[12px] leading-snug" style={{ color: S.ink2 }}>{aud.note}</div>
                  <div className="text-[11px] font-mono pt-2 border-t" style={{ borderColor: S.line, color: S.ink2 }}>{(q && q.text) || ''}</div>
                  <div className="flex items-center gap-2">
                    <button className="h-7 px-2.5 text-[11.5px] rounded-full" style={{ color: S.ink2, border: `1px solid ${S.line}` }}>Edit</button>
                    <button className="h-7 px-2.5 text-[11.5px] rounded-full ml-auto" style={{ color: S.ink2 }}>Use in a run</button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>Persona library · {FORGE_PERSONAS.length}</div>
            <div className="flex-1 h-px" style={{ background: S.line }} />
            <a href="#" className="text-[11.5px] inline-flex items-center gap-1" style={{ color: S.ink2 }}>Authored on Synthetical — edit there <CTIcon name="arrow" size={11} stroke={S.ink2} /></a>
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            {FORGE_PERSONAS.map((p) => (
              <div key={p.id} className="rounded-xl p-3 flex items-start gap-2.5" style={{ background: S.card, border: `1px solid ${S.line}` }}>
                <Avatar initials={p.initials} color={p.accent} size={34} />
                <div className="flex-1 min-w-0">
                  <div className="font-serif text-[14px] leading-tight truncate" style={{ color: S.ink }}>{p.name}</div>
                  <div className="text-[11px] truncate" style={{ color: S.ink2 }}>{p.title}</div>
                  <div className="text-[11px] leading-snug mt-1" style={{ color: S.ink2 }}>{p.cares}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

// ─── SETUP / CONNECTION ────────────────────────────────────────────────────
function ForgeSetup() {
  const [, force] = useState(0);
  return (
    <div className="flex-1 overflow-y-auto ct-thin-scroll px-9 py-7">
      <div className="max-w-[860px] mx-auto flex flex-col gap-7">
        <div>
          <div className="text-[11px] font-mono uppercase tracking-[0.18em]" style={{ color: S.ink2 }}>Forge · setup</div>
          <h1 className="font-serif text-[34px] leading-[1.05] tracking-tight mt-1" style={{ color: S.ink }}>Synthetical connection</h1>
          <p className="text-[14px] mt-2 max-w-[620px]" style={{ color: S.ink2 }}>Forge uses Synthetical as its scoring engine. ClawTalk never runs the scoring math itself — it calls your org over Synthetical's API.</p>
        </div>

        {/* connection card */}
        <div className="rounded-2xl p-5" style={{ background: S.card, border: `1px solid ${S.line}` }}>
          <div className="flex items-center gap-3">
            <span className="w-11 h-11 rounded-xl grid place-items-center" style={{ background: S.paper2, border: `1px solid ${S.line}` }}><CTIcon name="globe" size={20} stroke={S.accent} /></span>
            <div className="flex-1">
              <div className="font-serif text-[17px]" style={{ color: S.ink }}>syntheticalresearch.com</div>
              <div className="text-[12px] inline-flex items-center gap-1.5 mt-0.5" style={{ color: '#3F6B5C' }}><span className="w-1.5 h-1.5 rounded-full" style={{ background: '#3F6B5C' }} /> Connected · org <span className="font-mono">Oxbow Research</span></div>
            </div>
            <a href="#" className="h-8 px-3 rounded-lg text-[12.5px] inline-flex items-center gap-1.5 whitespace-nowrap" style={{ border: `1px solid ${S.line}`, color: S.ink }}>Manage on Synthetical <CTIcon name="arrow" size={12} stroke={S.ink2} /></a>
            <button onClick={() => { setForgeConnected(false); force((n) => n + 1); }} className="h-8 px-3 rounded-lg text-[12.5px]" style={{ color: '#A8434A', border: `1px solid ${S.line}` }}>Disconnect</button>
          </div>
          <div className="grid grid-cols-3 gap-2.5 mt-4">
            {[['assets:write', 'create candidates'], ['tests:run', 'run scoring batches'], ['tests:read', 'read results']].map(([s, d]) => (
              <div key={s} className="rounded-lg px-3 py-2" style={{ background: S.paper2 }}>
                <div className="font-mono text-[11.5px]" style={{ color: S.ink }}>{s}</div>
                <div className="text-[10.5px]" style={{ color: S.ink2 }}>{d}</div>
              </div>
            ))}
          </div>
        </div>

        {/* synced assets */}
        <div className="rounded-2xl p-5" style={{ background: S.card, border: `1px solid ${S.line}` }}>
          <div className="text-[11px] font-mono uppercase tracking-[0.16em] mb-3" style={{ color: S.ink2 }}>Synced from your org</div>
          <div className="grid grid-cols-3 gap-3">
            {[['Personas', FORGE_PERSONAS.length, 'read-only · authored on Synthetical'], ['Reference sets', FORGE_REFSETS.length, 'Likert anchor bundles'], ['Audiences', FORGE_AUDIENCES.length, 'composed here in ClawTalk']].map(([l, v, d]) => (
              <div key={l} className="rounded-xl p-3.5" style={{ background: S.paper2 }}>
                <div className="font-serif text-[24px]" style={{ color: S.ink }}>{v}</div>
                <div className="text-[12px] font-medium" style={{ color: S.ink }}>{l}</div>
                <div className="text-[11px] mt-0.5" style={{ color: S.ink2 }}>{d}</div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[11px] font-mono uppercase tracking-[0.16em] mb-3" style={{ color: S.ink2 }}>How Forge works</div>
          <HowItWorks compact />
        </div>
      </div>
    </div>
  );
}

// ─── FORGE PAGE shell ───────────────────────────────────────────────────────
function ForgePage() {
  const { setRoute } = useApp();
  const [connected, setConnected] = useState(forgeConnected());
  const [section, setSection] = useState('runs');     // runs | audiences | setup
  const [runId, setRunId] = useState(null);           // null = list
  const [live, setLive] = useState(false);
  const [newRun, setNewRun] = useState(false);

  useEffect(() => {
    const onConn = () => setConnected(forgeConnected());
    const onGoto = (e) => {
      const d = e.detail || {};
      if (d.section) setSection(d.section);
      if (d.runId) { setRunId(d.runId); setLive(!!d.live); }
      if (d.newRun) setNewRun(true);
    };
    window.addEventListener('ct-forge-conn', onConn);
    window.addEventListener('ct-forge-goto', onGoto);
    // consume a pending nav set by the launcher before route change
    if (window.__forgeNav) { onGoto({ detail: window.__forgeNav }); window.__forgeNav = null; }
    return () => { window.removeEventListener('ct-forge-conn', onConn); window.removeEventListener('ct-forge-goto', onGoto); };
  }, []);

  const navItems = [['runs', 'chat', 'Runs'], ['audiences', 'sparkle', 'Audiences'], ['setup', 'settings', 'Setup']];

  return (
    <div className="flex h-screen" style={{ background: S.paper, color: S.ink }}>
      <IconRail active="forge"
        onNav={(id) => { if (id === 'home') setRoute('home'); else if (id === 'talks') setRoute('talk'); else if (id === 'agents') setRoute('agents'); else if (id === 'docs') setRoute('documents'); else if (id === 'settings') setRoute('settings'); else setRoute('talk'); }}
        onCmdK={() => {}} />

      {/* sub-nav */}
      <div className="w-[210px] shrink-0 flex flex-col border-r" style={{ background: S.paper2, borderColor: S.line }}>
        <div className="px-4 h-16 flex items-center gap-2 border-b" style={{ borderColor: S.line }}>
          <span className="w-7 h-7 rounded-lg grid place-items-center" style={{ background: `${S.accent}14`, border: `1px solid ${S.accent}33` }}><ForgeMark size={15} /></span>
          <span className="font-serif text-[18px]" style={{ color: S.ink }}>Forge</span>
        </div>
        <div className="p-2 flex flex-col gap-0.5">
          {navItems.map(([id, icon, label]) => {
            const on = section === id && !runId;
            return (
              <button key={id} onClick={() => { setSection(id); setRunId(null); }}
                className="h-9 px-3 rounded-lg text-[13px] flex items-center gap-2.5 text-left transition-colors"
                style={{ background: on ? S.card : 'transparent', color: on ? S.ink : S.ink2, boxShadow: on ? `inset 0 0 0 1px ${S.line}` : 'none' }}>
                <CTIcon name={icon} size={15} stroke={on ? S.ink : S.ink2} /> {label}
              </button>
            );
          })}
        </div>
        <div className="mt-auto p-3">
          <div className="rounded-xl p-3 text-[11.5px] leading-snug" style={{ background: connected ? S.card : '#FBEAEA', border: `1px solid ${connected ? S.line : '#E3B9B9'}`, color: S.ink2 }}>
            <div className="inline-flex items-center gap-1.5 font-medium" style={{ color: connected ? '#3F6B5C' : '#A8434A' }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: connected ? '#3F6B5C' : '#A8434A' }} /> {connected ? 'Synthetical connected' : 'Not connected'}
            </div>
            <div className="mt-1">{connected ? 'org · Oxbow Research' : 'Connect to run improvements.'}</div>
          </div>
        </div>
      </div>

      {/* content */}
      {!connected ? <ForgeOnboarding />
        : runId ? <ForgeRunDetail runId={runId} live={live} onBack={() => { setRunId(null); setLive(false); }} />
        : section === 'audiences' ? <ForgeAudiences />
        : section === 'setup' ? <ForgeSetup />
        : <ForgeRunsList onOpen={(id) => { setRunId(id); setLive(false); }} onNewRun={() => setNewRun(true)} />}

      {newRun ? <ForgeNewRunModal onClose={() => setNewRun(false)} onStart={() => { setNewRun(false); setRunId('run-pricing'); setLive(true); setSection('runs'); }} /> : null}
    </div>
  );
}

// full-control config in a modal (reuses ForgeConfig)
function ForgeNewRunModal({ onClose, onStart }) {
  const doc = { title: 'pricing-v2-draft.md' };
  const [cfg, setCfg] = useState(() => {
    const aud = FORGE_AUDIENCES[0];
    return { scopeKind: 'doc', audience: aud.id, personaIds: aud.personaIds.slice(), refSet: aud.refSet, question: aud.question,
      target: FORGE_TARGET, rounds: 5, budget: FORGE_BUDGET.cap, advanced: false, beamN: 8, beamK: 3, heldOut: true,
      mutations: Object.fromEntries(FORGE_MUTATIONS.map((m) => [m.id, m.on])) };
  });
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-5" style={{ background: 'rgba(31,27,22,0.5)' }}>
      <div className="flex flex-col rounded-2xl overflow-hidden ct-screen-enter" style={{ width: 'min(1040px, 96vw)', height: 'min(720px, 92vh)', background: S.paper, border: `1px solid ${S.line}`, boxShadow: '0 40px 90px rgba(31,27,22,0.4)' }}>
        <div className="px-6 flex items-center gap-3 shrink-0 border-b" style={{ borderColor: S.line, background: S.card, height: 58 }}>
          <span className="w-8 h-8 rounded-lg grid place-items-center" style={{ background: `${S.accent}14`, border: `1px solid ${S.accent}33` }}><ForgeMark size={17} /></span>
          <div className="flex-1"><div className="font-serif text-[16px] leading-none" style={{ color: S.ink }}>New improvement run</div><div className="text-[10.5px] font-mono mt-0.5" style={{ color: S.ink2 }}>full control · {doc.title}</div></div>
          <button onClick={onClose} className="w-8 h-8 grid place-items-center rounded-lg" style={{ color: S.ink2, border: `1px solid ${S.line}` }}><CTIcon name="x" size={15} /></button>
        </div>
        <ForgeConfig cfg={cfg} setCfg={setCfg} doc={doc} onStart={onStart} />
      </div>
    </div>
  );
}

// ─── COMPACT IN-DOC LAUNCHER ─────────────────────────────────────────────────
function ForgeLauncher({ onClose }) {
  const { setRoute } = useApp();
  const connected = forgeConnected();
  const [audience, setAudience] = useState(FORGE_AUDIENCES[0].id);
  const [target, setTarget] = useState(FORGE_TARGET);
  const [budget, setBudget] = useState(FORGE_BUDGET.cap);
  const aud = FORGE_AUDIENCES.find((a) => a.id === audience);
  const personas = aud.personaIds.length;
  const estLow = Math.max(8, Math.round(personas * 5 * 1.05)), estHigh = Math.round(estLow * 1.4);

  const goForge = (extra) => { window.__forgeNav = { section: 'runs', ...extra }; setRoute('forge'); onClose(); };
  const start = () => goForge({ runId: 'run-pricing', live: true });

  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-5" style={{ background: 'rgba(31,27,22,0.5)' }}>
      <div className="rounded-2xl overflow-hidden ct-screen-enter flex flex-col" style={{ width: 440, background: S.paper, border: `1px solid ${S.line}`, boxShadow: '0 40px 90px rgba(31,27,22,0.4)' }}>
        {/* header */}
        <div className="px-5 pt-4 pb-3 flex items-center gap-2.5" style={{ background: S.card, borderBottom: `1px solid ${S.line}` }}>
          <span className="w-8 h-8 rounded-lg grid place-items-center" style={{ background: `${S.accent}14`, border: `1px solid ${S.accent}33` }}><ForgeMark size={17} /></span>
          <div className="flex-1"><div className="font-serif text-[16px] leading-none" style={{ color: S.ink }}>Improve with Forge</div><div className="text-[10.5px] font-mono mt-1" style={{ color: S.ink2 }}>pricing-v2-draft.md</div></div>
          <button onClick={onClose} className="w-7 h-7 grid place-items-center rounded-lg" style={{ color: S.ink2 }}><CTIcon name="x" size={14} /></button>
        </div>

        {!connected ? (
          <div className="p-6 flex flex-col items-center text-center gap-3">
            <span className="w-12 h-12 rounded-2xl grid place-items-center" style={{ background: `${S.accent}14`, border: `1px solid ${S.accent}33` }}><CTIcon name="globe" size={22} stroke={S.accent} /></span>
            <div className="font-serif text-[18px]" style={{ color: S.ink }}>Connect Synthetical first</div>
            <div className="text-[12.5px]" style={{ color: S.ink2 }}>Forge scores your draft against personas on Synthetical. Set up the connection in Forge to get started.</div>
            <button onClick={() => goForge({ section: 'setup' })} className="h-10 px-5 rounded-full text-[13px] font-medium text-white mt-1" style={{ background: S.accent }}>Open Forge to connect</button>
          </div>
        ) : (
          <>
            <div className="p-5 flex flex-col gap-4">
              <ForgeField label="Audience" hint={`${personas} personas`}>
                <div className="rounded-lg" style={{ border: `1px solid ${S.line}`, background: S.card }}>
                  <select value={audience} onChange={(e) => setAudience(e.target.value)} className="w-full bg-transparent outline-none text-[13px] px-3 h-10 font-serif" style={{ color: S.ink }}>
                    {FORGE_AUDIENCES.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <div className="flex -space-x-2 mt-1.5">
                  {aud.personaIds.slice(0, 8).map((id) => { const p = FORGE_PERSONAS.find((x) => x.id === id); return <span key={id} style={{ boxShadow: `0 0 0 2px ${S.paper}`, borderRadius: '50%' }}><Avatar initials={p.initials} color={p.accent} size={22} /></span>; })}
                </div>
              </ForgeField>
              <div className="grid grid-cols-2 gap-3">
                <ForgeField label="Target score"><ForgeSlider min={5} max={9} step={0.1} value={target} onChange={setTarget} format={(v) => v.toFixed(1)} /></ForgeField>
                <ForgeField label="Budget cap"><ForgeSlider min={25} max={150} step={5} value={budget} onChange={setBudget} format={(v) => '$' + v} /></ForgeField>
              </div>
              <div className="rounded-lg px-3 py-2 flex items-center gap-2 text-[12px]" style={{ background: S.paper2, color: S.ink2 }}>
                <span className="font-mono" style={{ color: S.ink }}>Est. ${estLow}–{estHigh}</span> · stops at target, plateau, or cap · winner lands as a pending edit.
              </div>
            </div>
            <div className="px-5 py-3.5 flex items-center gap-2 border-t" style={{ borderColor: S.line, background: S.card }}>
              <button onClick={() => goForge({ newRun: true })} className="h-9 px-3 rounded-full text-[12px]" style={{ color: S.ink2 }}>Open in Forge for full control</button>
              <div className="flex-1" />
              <button onClick={start} className="h-10 px-5 rounded-full text-[13px] font-medium text-white inline-flex items-center gap-2 whitespace-nowrap" style={{ background: S.accent }}>
                <ForgeMark size={15} accent="#FFF" /> Start run
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// mount — listens for the doc-pane "Improve" action (overrides the old overlay)
function ForgeMount() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener('ct-forge-open', h);
    return () => window.removeEventListener('ct-forge-open', h);
  }, []);
  if (!open) return null;
  return <ForgeLauncher onClose={() => setOpen(false)} />;
}

Object.assign(window, { ForgePage, ForgeLauncher, ForgeMount, ForgeRunsList, ForgeRunDetail, ForgeAudiences, ForgeSetup, ForgeOnboarding, RunChart, LikertBar, PersonaResponse });
