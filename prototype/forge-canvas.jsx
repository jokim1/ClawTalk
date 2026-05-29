/* eslint-disable */
// Forge — design exploration canvas. Static mockups of the directions the
// interactive flow can't show side-by-side: 3 entry surfaces + 3 gallery
// layouts, plus a written rationale. Uses the Salon palette + CTIcon (from
// shared/data.jsx). These are design frames, not interactive.

const FS = {
  ink: '#1F1B16', ink2: '#6B6660', paper: '#FBF7EF', paper2: '#F4ECDB',
  card: '#FFFFFF', line: '#E6E0D1', accent: '#C8643A', green: '#3F6B5C',
};
const mono = '"Geist Mono", ui-monospace, monospace';
const serif = '"Newsreader", Georgia, serif';

function FMark({ size = 16, accent = FS.accent }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 19h16" stroke={accent} strokeWidth="2" strokeLinecap="round" />
      <path d="M6 19c0-3 2.5-5 6-5" stroke={accent} strokeWidth="2" strokeLinecap="round" />
      <path d="M13 3l-2.5 6h4L12 15" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
const I = (props) => <CTIcon {...props} />;

// small atoms ------------------------------------------------------------
function Mono({ children, c = FS.ink2, s = 10 }) {
  return <span style={{ fontFamily: mono, fontSize: s, letterSpacing: '0.08em', color: c }}>{children}</span>;
}
function Score({ v, big }) {
  const c = v >= 7.5 ? FS.green : v >= 6.5 ? '#9A7B2E' : '#A8434A';
  return <span style={{ fontFamily: mono, fontWeight: 600, fontSize: big ? 26 : 13, color: c }}>{v.toFixed(1)}</span>;
}

// ─── ENTRY A · doc-pane action ──────────────────────────────────────────
function EntryDocPane() {
  const blocks = [
    { k: 'h', t: 'Pricing v2 — draft' },
    { k: 'p', t: 'For the 50-seat eng band, the strongest position is a seat + usage hybrid with a procurement-friendly cap.' },
    { k: 'li', t: 'Predictable seat line item ($32/seat).' },
    { k: 'li', t: 'Bundled token pool covers the median user.' },
    { k: 'li', t: '"Tokens" is illegible to procurement.' },
  ];
  return (
    <div style={{ width: 440, height: 600, background: FS.paper, display: 'flex' }}>
      {/* thread sliver */}
      <div style={{ width: 150, borderRight: `1px solid ${FS.line}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, opacity: 0.6 }}>
        <Mono s={9}>THREAD</Mono>
        {[0, 1, 2].map((i) => <div key={i} style={{ height: 34, borderRadius: 8, background: FS.card, border: `1px solid ${FS.line}` }} />)}
      </div>
      {/* doc pane */}
      <div style={{ flex: 1, background: FS.paper2, display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 46, borderBottom: `1px solid ${FS.line}`, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px' }}>
          <I name="doc" size={14} stroke={FS.ink2} />
          <span style={{ fontFamily: serif, fontSize: 13, color: FS.ink, flex: 1 }}>pricing-v2-draft.md</span>
          {/* the entry point */}
          <span style={{ height: 26, padding: '0 9px', borderRadius: 8, background: FS.accent, color: '#fff', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5, boxShadow: `0 0 0 4px ${FS.accent}33` }}>
            <FMark size={12} accent="#fff" /> Improve
          </span>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 9 }}>
          {blocks.map((b, i) => b.k === 'h'
            ? <div key={i} style={{ fontFamily: serif, fontSize: 19, color: FS.ink }}>{b.t}</div>
            : b.k === 'p'
            ? <div key={i} style={{ fontFamily: serif, fontSize: 12, lineHeight: 1.6, color: FS.ink }}>{b.t}</div>
            : <div key={i} style={{ display: 'flex', gap: 6, fontFamily: serif, fontSize: 12, color: FS.ink }}><span style={{ color: FS.ink2 }}>•</span>{b.t}</div>
          )}
        </div>
        {/* callout */}
        <div style={{ margin: '8px 16px', padding: 12, borderRadius: 12, background: FS.card, border: `1px solid ${FS.accent}55` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
            <FMark size={13} /><span style={{ fontFamily: serif, fontSize: 13, color: FS.ink }}>Improve opens right here</span>
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.5, color: FS.ink2 }}>
            The action lives on the document you're already looking at. One click → the Forge overlay, scoped to this doc. Lowest friction; matches the 1-doc-per-Talk model.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── ENTRY B · Forge home in the rail ───────────────────────────────────
function EntryNav() {
  const railItems = [['home', false], ['chat', false], ['sparkle', false], ['doc', false]];
  const runs = [
    { doc: 'pricing-v2-draft.md', base: 6.1, best: 7.6, status: 'done' },
    { doc: 'launch-comms.md', base: 6.4, best: 7.0, status: 'running' },
    { doc: 'notion-teardown.md', base: 5.9, best: 6.8, status: 'done' },
  ];
  return (
    <div style={{ width: 440, height: 600, background: FS.paper, display: 'flex' }}>
      {/* rail with Forge added */}
      <div style={{ width: 46, background: FS.paper2, borderRight: `1px solid ${FS.line}`, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 10, gap: 6 }}>
        <div style={{ marginBottom: 6 }}><CTMarkSalon size={22} accent={FS.accent} /></div>
        {railItems.map(([ic], i) => (
          <div key={i} style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', color: FS.ink2 }}><I name={ic} size={16} stroke={FS.ink2} /></div>
        ))}
        {/* Forge entry, active */}
        <div style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: FS.card, boxShadow: `inset 0 0 0 1px ${FS.line}` }}><FMark size={16} /></div>
      </div>
      {/* dashboard */}
      <div style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <Mono s={9}>WORKSPACE · OXBOW &amp; CO.</Mono>
          <div style={{ fontFamily: serif, fontSize: 22, color: FS.ink, marginTop: 2 }}>Forge</div>
          <div style={{ fontSize: 11.5, color: FS.ink2, marginTop: 2 }}>Every improvement run across your docs. Start one, or revisit the gallery.</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[['Runs', '14'], ['Avg lift', '+1.2'], ['Promoted', '9']].map(([l, v]) => (
            <div key={l} style={{ flex: 1, borderRadius: 12, background: FS.card, border: `1px solid ${FS.line}`, padding: 10 }}>
              <Mono s={9}>{l}</Mono>
              <div style={{ fontFamily: serif, fontSize: 20, color: FS.ink }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Mono s={9}>RECENT RUNS</Mono><div style={{ flex: 1, height: 1, background: FS.line }} />
          <span style={{ height: 26, padding: '0 10px', borderRadius: 13, background: FS.accent, color: '#fff', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}><I name="plus" size={11} stroke="#fff" strokeWidth={2} /> New run</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {runs.map((r, i) => (
            <div key={i} style={{ borderRadius: 10, background: FS.card, border: `1px solid ${FS.line}`, padding: '9px 11px', display: 'flex', alignItems: 'center', gap: 9 }}>
              <I name="doc" size={13} stroke={FS.ink2} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: mono, fontSize: 11.5, color: FS.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.doc}</div>
                <div style={{ fontSize: 10, color: FS.ink2 }}>{r.base.toFixed(1)} → <span style={{ color: FS.green }}>{r.best.toFixed(1)}</span></div>
              </div>
              {r.status === 'running'
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: FS.accent }}><span style={{ width: 6, height: 6, borderRadius: 6, background: FS.accent }} /> live</span>
                : <Score v={r.best} />}
            </div>
          ))}
        </div>
        <div style={{ marginTop: 'auto', fontSize: 10.5, color: FS.ink2, lineHeight: 1.5 }}>
          <b style={{ color: FS.ink }}>B · A home for power users.</b> Good once runs are frequent — a place to compare history. Heavier to build; risks separating Forge from the doc it edits.
        </div>
      </div>
    </div>
  );
}

// ─── ENTRY C · full-screen workspace ────────────────────────────────────
function EntryFullscreen() {
  return (
    <div style={{ width: 440, height: 600, background: FS.paper, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 44, borderBottom: `1px solid ${FS.line}`, background: FS.card, display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px' }}>
        <I name="chevron-r" size={12} stroke={FS.ink2} /><Mono s={10}>BACK TO DOC</Mono>
        <div style={{ flex: 1 }} />
        <span style={{ width: 26, height: 26, borderRadius: 8, background: `${FS.accent}14`, border: `1px solid ${FS.accent}33`, display: 'grid', placeItems: 'center' }}><FMark size={15} /></span>
        <span style={{ fontFamily: serif, fontSize: 14, color: FS.ink }}>Forge workspace</span>
      </div>
      <div style={{ flex: 1, display: 'flex' }}>
        {/* doc preview */}
        <div style={{ width: 180, borderRight: `1px solid ${FS.line}`, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Mono s={9}>SOURCE</Mono>
          <div style={{ fontFamily: serif, fontSize: 15, color: FS.ink }}>Pricing v2</div>
          {[0, 1, 2, 3].map((i) => <div key={i} style={{ height: 8, borderRadius: 4, background: FS.paper2, width: i % 2 ? '80%' : '100%' }} />)}
          <div style={{ height: 8, borderRadius: 4, background: `${FS.accent}33`, width: '60%' }} />
          {[0, 1].map((i) => <div key={i} style={{ height: 8, borderRadius: 4, background: FS.paper2, width: '90%' }} />)}
        </div>
        {/* big workspace */}
        <div style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Mono s={9}>OBJECTIVE</Mono>
            <div style={{ fontFamily: serif, fontSize: 17, color: FS.ink, marginTop: 2 }}>Champion likelihood, 50-seat buyers</div>
          </div>
          {/* mini chart */}
          <div style={{ borderRadius: 12, background: FS.paper2, border: `1px solid ${FS.line}`, padding: 12, height: 150 }}>
            <Mono s={9}>SCORE / ROUND</Mono>
            <svg viewBox="0 0 240 90" width="100%" style={{ marginTop: 6 }}>
              <line x1="0" y1="20" x2="240" y2="20" stroke={FS.accent} strokeWidth="1" strokeDasharray="4 4" opacity="0.7" />
              <polyline points="6,76 60,60 120,40 180,26 228,16" fill="none" stroke={FS.accent} strokeWidth="2.5" strokeLinecap="round" />
              {[[6, 76], [60, 60], [120, 40], [180, 26], [228, 16]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3.5" fill={i === 4 ? FS.accent : '#fff'} stroke={FS.accent} strokeWidth="2" />)}
            </svg>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[['Best', 7.6], ['Held-out', 7.4]].map(([l, v]) => (
              <div key={l} style={{ flex: 1, borderRadius: 10, background: FS.card, border: `1px solid ${FS.line}`, padding: 10 }}>
                <Mono s={9}>{l}</Mono><div><Score v={v} big /></div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 'auto', fontSize: 10.5, color: FS.ink2, lineHeight: 1.5 }}>
            <b style={{ color: FS.ink }}>C · Maximum focus.</b> Full-bleed room for the chart, diffs and feedback. Best for deep sessions; a heavier context-switch than the overlay.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── GALLERY D · leaderboard ────────────────────────────────────────────
function GalleryBoard() {
  const rows = [
    { s: 7.6, t: 'Lead with the number, bill in "AI actions"', tag: 'winner', r: 3 },
    { s: 7.1, t: 'Every "token" becomes an "AI action"', tag: 'frontier', r: 2 },
    { s: 6.8, t: 'Open on $32/seat and defend it', tag: 'keep', r: 2 },
    { s: 6.6, t: "Open on the buyer's fear, not positioning", tag: 'keep', r: 1 },
    { s: 6.4, t: 'Three claims, three rebuttals', tag: 'keep', r: 1 },
    { s: 5.8, t: 'Aggressive, confident, lots of bold', tag: 'discard', r: 1 },
  ];
  const tagC = (t) => t === 'winner' ? FS.accent : t === 'discard' ? '#A8434A' : FS.ink2;
  return (
    <div style={{ width: 440, height: 430, background: FS.paper, padding: 16, display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontFamily: serif, fontSize: 16, color: FS.ink }}>All versions, ranked</div>
        <Mono s={10}>6 · BY FITNESS</Mono>
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ borderRadius: 10, background: FS.card, border: `1px solid ${r.tag === 'winner' ? FS.accent : FS.line}`, padding: '8px 11px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: mono, fontSize: 11, color: FS.ink2, width: 12 }}>{i + 1}</span>
          <Score v={r.s} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: FS.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.t}</span>
          <span style={{ fontFamily: mono, fontSize: 8.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: tagC(r.tag), background: `${tagC(r.tag)}1A`, padding: '2px 5px', borderRadius: 4 }}>{r.tag}</span>
          <Mono s={9}>R{r.r}</Mono>
        </div>
      ))}
      <div style={{ marginTop: 'auto', fontSize: 10.5, color: FS.ink2 }}><b style={{ color: FS.ink }}>D · Score-first.</b> Densest; best when there are many versions to scan.</div>
    </div>
  );
}

// ─── GALLERY E · side-by-side diff ──────────────────────────────────────
function GalleryDiff() {
  const Hl = ({ children, mode }) => (
    <span style={mode === 'add'
      ? { background: `${FS.accent}22`, borderRadius: 3, padding: '0 2px' }
      : { textDecoration: 'line-through', color: FS.ink2, opacity: 0.7 }}>{children}</span>
  );
  return (
    <div style={{ width: 440, height: 430, background: FS.paper, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontFamily: serif, fontSize: 16, color: FS.ink }}>Winner vs your current draft</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, flex: 1 }}>
        <div style={{ borderRadius: 12, background: FS.paper2, border: `1px solid ${FS.line}`, padding: 12 }}>
          <Mono s={9}>CURRENT · 6.1</Mono>
          <p style={{ fontFamily: serif, fontSize: 12, lineHeight: 1.6, color: FS.ink, marginTop: 8 }}>
            For the 50-seat eng band, the strongest position is a <Hl mode="del">seat + usage hybrid</Hl>. Bundled <Hl mode="del">10M tokens / seat</Hl> covers the median user; overage at <Hl mode="del">$4 / M tokens</Hl>.
          </p>
        </div>
        <div style={{ borderRadius: 12, background: FS.card, border: `1.5px solid ${FS.accent}66`, padding: 12 }}>
          <Mono s={9} c={FS.accent}>FORGE WINNER · 7.6</Mono>
          <p style={{ fontFamily: serif, fontSize: 12, lineHeight: 1.6, color: FS.ink, marginTop: 8 }}>
            For a 50-seat org, procurement's real question is <Hl mode="add">"the worst case on the invoice"</Hl> — so answer it first: <Hl mode="add">one predictable price, a soft cap you set</Hl>, billed in <Hl mode="add">"AI actions," never tokens</Hl>.
          </p>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, height: 1, background: FS.line }} />
        <span style={{ height: 30, padding: '0 12px', borderRadius: 15, background: FS.accent, color: '#fff', fontSize: 11.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}><I name="check" size={13} stroke="#fff" strokeWidth={2.2} /> Set as document</span>
      </div>
      <div style={{ fontSize: 10.5, color: FS.ink2 }}><b style={{ color: FS.ink }}>E · Decision-first.</b> Best for choosing fast — see exactly what changes before it lands.</div>
    </div>
  );
}

// ─── GALLERY F · card grid ──────────────────────────────────────────────
function GalleryGrid() {
  const cards = [
    { s: 7.6, t: 'Lead with the number', strat: 'Plain units + procurement hook', win: true },
    { s: 7.1, t: 'Tokens → AI actions', strat: 'Cut the jargon', win: false },
    { s: 6.8, t: 'Open on $32/seat', strat: 'Lead with number', win: false },
    { s: 6.6, t: "Open on buyer's fear", strat: 'Reframe the hook', win: false },
  ];
  return (
    <div style={{ width: 440, height: 430, background: FS.paper, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontFamily: serif, fontSize: 16, color: FS.ink }}>Compare candidates</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, flex: 1 }}>
        {cards.map((c, i) => (
          <div key={i} style={{ borderRadius: 12, background: FS.card, border: c.win ? `1.5px solid ${FS.accent}` : `1px solid ${FS.line}`, padding: 11, display: 'flex', flexDirection: 'column', gap: 6, position: 'relative' }}>
            {c.win ? <span style={{ position: 'absolute', top: 9, right: 9, fontFamily: mono, fontSize: 8, letterSpacing: '0.1em', color: FS.accent }}>WINNER</span> : null}
            <Score v={c.s} big />
            <div style={{ fontFamily: serif, fontSize: 13, color: FS.ink, lineHeight: 1.25 }}>{c.t}</div>
            <div style={{ fontFamily: mono, fontSize: 9.5, color: FS.ink2 }}>{c.strat}</div>
            <div style={{ marginTop: 'auto', display: 'flex', gap: 3 }}>
              {[0, 1, 2].map((d) => <span key={d} style={{ width: 16, height: 16, borderRadius: 8, background: ['#3D5688', '#3F6B5C', '#8E3B59'][d], opacity: 0.9 }} />)}
              <span style={{ fontSize: 9.5, color: FS.ink2, alignSelf: 'center', marginLeft: 2 }}>+{5 + i} more</span>
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: FS.ink2 }}><b style={{ color: FS.ink }}>F · Comparison-first.</b> Cards weigh roughly equal — best for a small, close field.</div>
    </div>
  );
}

// ─── rationale panel ─────────────────────────────────────────────────────
function RationalePanel() {
  const Q = ({ q, children }) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontFamily: serif, fontSize: 15, color: FS.ink, marginBottom: 3 }}>{q}</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.6, color: FS.ink2 }}>{children}</div>
    </div>
  );
  return (
    <div style={{ width: '100%', height: '100%', background: FS.card, padding: 26, boxSizing: 'border-box', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ width: 32, height: 32, borderRadius: 9, background: `${FS.accent}14`, border: `1px solid ${FS.accent}33`, display: 'grid', placeItems: 'center' }}><FMark size={18} /></span>
        <div>
          <div style={{ fontFamily: serif, fontSize: 22, color: FS.ink }}>Forge — where it lives &amp; how it works</div>
          <Mono s={10}>AUTONOMOUS CONTENT IMPROVEMENT · DESIGN RATIONALE</Mono>
        </div>
      </div>
      <p style={{ fontSize: 13, lineHeight: 1.65, color: FS.ink2, margin: '10px 0 18px' }}>
        Forge closes the generate → score → improve loop inside ClawTalk: pick a document, define what "good" means with synthetic personas, hit one button, walk away, then choose a measurably-better version from a gallery. <b style={{ color: FS.ink }}>Built (v1):</b> a simple in-doc <b style={{ color: FS.ink }}>Improve</b> launcher (A) that hands off to a dedicated <b style={{ color: FS.ink }}>Forge page</b> (B) holding all the depth — run history, score charts, version galleries, per-persona responses, and the Synthetical connection. The frames below are the original exploration.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
        <div>
          <Q q="Where should it be surfaced? — built: A + B">
            <b style={{ color: FS.ink }}>A hybrid, not a new top-level app alone.</b> The document keeps a <b style={{ color: FS.ink }}>simple Improve launcher</b> (A) — audience, target, budget, go. All depth lives on a dedicated <b style={{ color: FS.ink }}>Forge page</b> in the rail (B): run history, run detail, audiences, and Synthetical setup. The full-screen workspace (C) folds into the Forge run-detail view.
          </Q>
          <Q q="How do users select content?">
            A scope toggle on the config step: <b style={{ color: FS.ink }}>whole document, a single tab, just the title, or a selected section.</b> Block-level passes the rest of the doc as read-only context so a fragment stays coherent.
          </Q>
          <Q q="Defining personas for scoring">
            Personas come from the user's existing <b style={{ color: FS.ink }}>Synthetical</b> org (read-only in v1) — shown as a gallery of cards (who they are, what they care about), grouped into reusable <b style={{ color: FS.ink }}>audiences</b>. Authoring personas inside ClawTalk is a later step.
          </Q>
        </div>
        <div>
          <Q q="What else can users tune?">
            Up front: <b style={{ color: FS.ink }}>survey question, reference set, target score, max rounds, budget cap</b> (with a live cost estimate). Under Advanced: mutation strategies, beam width (N / top-k), and held-out validation. Defaults are sane so most users only touch the audience.
          </Q>
          <Q q="How prominent is trust?">
            The headline risk is over-fitting to the panel. Every winner carries a <b style={{ color: FS.ink }}>held-out validation score and over-fit gap</b> in a dedicated trust panel — the loop never overwrites the doc; the winner lands as a pending edit you accept. The Forge run detail also shows <b style={{ color: FS.ink }}>verbatim per-persona responses + Likert spreads</b>.
          </Q>
          <Q q="Picking the winner — built: leaderboard + responses">
            Three treatments were explored: a ranked <b style={{ color: FS.ink }}>leaderboard</b> (D), a <b style={{ color: FS.ink }}>side-by-side diff</b> (E), and a <b style={{ color: FS.ink }}>card grid</b> (F). The Forge page ships the leaderboard with per-version persona responses; the diff is available in the in-doc result.
          </Q>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  FS, FMark, EntryDocPane, EntryNav, EntryFullscreen,
  GalleryBoard, GalleryDiff, GalleryGrid, RationalePanel,
});
