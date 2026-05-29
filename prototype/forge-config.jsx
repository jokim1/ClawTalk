/* eslint-disable */
// Forge — overlay shell + Stage 1 (Configure). Loaded only when
// window.CT_FORGE_ENABLED is set (the Forge HTML sets it). Mounts inside
// the React tree (see app.jsx) so it can read the active doc + reuse the
// Salon atoms (S, CTIcon, Avatar, Chip) already on window.

// ─── Forge mark — a struck spark over an anvil arc ──────────────────────
function ForgeMark({ size = 22, accent }) {
  const a = accent || S.accent;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 19h16" stroke={a} strokeWidth="2" strokeLinecap="round" />
      <path d="M6 19c0-3 2.5-5 6-5" stroke={a} strokeWidth="2" strokeLinecap="round" />
      <path d="M13 3l-2.5 6h4L12 15" stroke={a} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── tiny score chip (composite scores, on a 0–10 scale) ────────────────
function ScoreChip({ value, tone = 'auto', sub, big = false }) {
  const v = Number(value);
  const color = tone === 'auto' ? (v >= 7.5 ? '#3F6B5C' : v >= 6.5 ? '#9A7B2E' : '#A8434A') : tone;
  return (
    <span className="inline-flex items-baseline gap-1 font-mono tabular-nums"
      style={{ color }}>
      <span className={big ? 'text-[34px] leading-none font-semibold' : 'text-[14px] font-semibold'}>{v.toFixed(1)}</span>
      {sub ? <span className="text-[10.5px] opacity-70">{sub}</span> : null}
    </span>
  );
}

// ─── selectable persona card ────────────────────────────────────────────
function PersonaCard({ p, selected, heldOut, onToggle }) {
  return (
    <button onClick={onToggle} disabled={heldOut}
      className="text-left rounded-xl p-3 flex flex-col gap-2 transition-all relative"
      style={{
        background: heldOut ? S.paper2 : (selected ? `${S.accent}0F` : S.card),
        border: selected ? `1.5px solid ${S.accent}` : `1px solid ${S.line}`,
        opacity: heldOut ? 0.62 : 1,
        cursor: heldOut ? 'not-allowed' : 'pointer',
      }}>
      <div className="flex items-start gap-2.5">
        <Avatar initials={p.initials} color={p.accent} size={34} />
        <div className="flex-1 min-w-0">
          <div className="font-serif text-[14.5px] leading-tight truncate" style={{ color: S.ink }}>{p.name}</div>
          <div className="text-[11px] truncate" style={{ color: S.ink2 }}>{p.title}</div>
        </div>
        <span className="w-5 h-5 rounded-full grid place-items-center shrink-0"
          style={{
            background: selected ? S.accent : 'transparent',
            border: selected ? 'none' : `1.5px solid ${S.line}`,
          }}>
          {selected ? <CTIcon name="check" size={12} stroke="#FFF" strokeWidth={2.4} /> : null}
        </span>
      </div>
      <div className="text-[11.5px] leading-snug" style={{ color: S.ink2 }}>{p.cares}</div>
      <div className="flex items-center gap-1.5">
        <span className="text-[9.5px] font-mono uppercase tracking-[0.12em] px-1.5 py-0.5 rounded"
          style={{ background: `${p.accent}1A`, color: p.accent }}>{p.seg}</span>
        {heldOut ? (
          <span className="text-[9.5px] font-mono uppercase tracking-[0.12em] px-1.5 py-0.5 rounded inline-flex items-center gap-1"
            style={{ background: S.card, color: S.ink2, border: `1px solid ${S.line}` }}>
            <CTIcon name="eye" size={9} stroke={S.ink2} /> held out
          </span>
        ) : null}
      </div>
    </button>
  );
}

// ─── labeled control row ────────────────────────────────────────────────
function ForgeField({ label, hint, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>{label}</span>
        {hint ? <span className="text-[11px]" style={{ color: S.ink2, opacity: 0.8 }}>{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

// A range slider with a value bubble, styled to the Salon palette.
function ForgeSlider({ min, max, step, value, onChange, format, prefix }) {
  const pct = ((value - min) / (max - min)) * 100;
  const dec = step < 1 ? 1 : 0;
  const [editing, setEditing] = useState(false);
  const commit = (raw) => {
    let n = parseFloat(String(raw).replace(/[^0-9.\-]/g, ''));
    setEditing(false);
    if (isNaN(n)) return;
    n = Math.min(max, Math.max(min, n));
    n = Math.round(n / step) * step;
    onChange(+n.toFixed(dec));
  };
  return (
    <div className="flex items-center gap-3">
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 forge-range"
        style={{ ['--pct']: pct + '%' }} />
      {editing ? (
        <span className="inline-flex items-center justify-end gap-0.5 w-[58px]">
          {prefix ? <span className="font-mono text-[13px]" style={{ color: S.ink2 }}>{prefix}</span> : null}
          <input autoFocus type="text" inputMode="decimal" defaultValue={value.toFixed(dec)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(e.target.value); else if (e.key === 'Escape') setEditing(false); }}
            className="w-[42px] bg-transparent outline-none font-mono text-[13px] text-right border-b"
            style={{ color: S.ink, borderColor: S.accent }} />
        </span>
      ) : (
        <button onClick={() => setEditing(true)} title="Click to type a value"
          className="font-mono text-[13px] tabular-nums w-[58px] text-right rounded px-1 -mr-1 hover:bg-[var(--salon-paper-2)] transition-colors"
          style={{ color: S.ink }}>
          {format ? format(value) : (prefix || '') + value}
        </button>
      )}
    </div>
  );
}

// ─── Stage 1 · Configure the objective ──────────────────────────────────
function ForgeConfig({ cfg, setCfg, doc, scope, onStart }) {
  const allP = FORGE_PERSONAS;
  const heldOutIds = cfg.heldOut ? ['p-yuki', 'p-hana'] : [];
  const selectable = allP.filter((p) => !heldOutIds.includes(p.id));
  const selCount = cfg.personaIds.filter((id) => !heldOutIds.includes(id)).length;

  const applyAudience = (aud) => {
    setCfg((c) => ({ ...c, personaIds: aud.personaIds.slice(), refSet: aud.refSet, question: aud.question, audience: aud.id }));
  };
  const togglePersona = (id) => {
    setCfg((c) => ({
      ...c,
      audience: null,
      personaIds: c.personaIds.includes(id) ? c.personaIds.filter((x) => x !== id) : [...c.personaIds, id],
    }));
  };
  const toggleMutation = (id) => {
    setCfg((c) => ({ ...c, mutations: { ...c.mutations, [id]: !c.mutations[id] } }));
  };

  // Live cost estimate scales with audience size × rounds.
  const estLow = Math.max(8, Math.round(selCount * cfg.rounds * 1.05));
  const estHigh = Math.round(estLow * 1.4);
  const overBudget = estHigh > cfg.budget;
  const q = FORGE_QUESTIONS.find((x) => x.id === cfg.question) || FORGE_QUESTIONS[0];

  return (
    <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: '1.55fr 1fr', gridTemplateRows: '1fr auto' }}>
      {/* ── Left: scope + audience ─────────────────────────────────── */}
      <div className="min-h-0 overflow-y-auto ct-thin-scroll px-7 py-6 flex flex-col gap-6"
        style={{ borderRight: `1px solid ${S.line}` }}>

        {/* What are we improving */}
        <div className="flex flex-col gap-2.5">
          <ForgeField label="What Forge will improve">
            <div className="rounded-xl p-3.5 flex items-center gap-3" style={{ background: S.paper2, border: `1px solid ${S.line}` }}>
              <span className="w-9 h-9 rounded-lg grid place-items-center shrink-0" style={{ background: S.card, border: `1px solid ${S.line}` }}>
                <CTIcon name="doc" size={16} stroke={S.ink2} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-mono text-[13px] truncate" style={{ color: S.ink }}>{doc?.title || 'pricing-v2-draft.md'}</div>
                <div className="text-[11.5px]" style={{ color: S.ink2 }}>{(doc && CT_docWordCount ? CT_docWordCount(doc) : 240)} words · baseline scored at {FORGE_BASELINE.toFixed(1)}</div>
              </div>
            </div>
          </ForgeField>
          <div className="flex items-center gap-1.5 flex-wrap">
            {[
              { k: 'doc',   label: 'Whole document' },
              { k: 'tab',   label: 'This tab' },
              { k: 'title', label: 'Just the title' },
              { k: 'block', label: 'Selected section' },
            ].map((s) => {
              const on = cfg.scopeKind === s.k;
              return (
                <button key={s.k} onClick={() => setCfg((c) => ({ ...c, scopeKind: s.k }))}
                  className="h-8 px-3 rounded-full text-[12px] inline-flex items-center gap-1.5 transition-colors"
                  style={{
                    background: on ? S.accent : S.card, color: on ? '#FFF' : S.ink,
                    border: on ? `1px solid ${S.accent}` : `1px solid ${S.line}`,
                  }}>
                  {on ? <CTIcon name="check" size={12} stroke="#FFF" strokeWidth={2.2} /> : null}
                  {s.label}
                </button>
              );
            })}
          </div>
          {cfg.scopeKind === 'block' ? (
            <div className="rounded-lg px-3 py-2 text-[12px] flex items-center gap-2" style={{ background: `${S.accent}0F`, color: S.ink, border: `1px dashed ${S.accent}66` }}>
              <CTIcon name="sparkle" size={12} stroke={S.accent} />
              Improving the <span className="font-medium">opening hook</span> only — the rest of the doc is passed as read-only context so the section stays coherent.
            </div>
          ) : null}
        </div>

        {/* Audience */}
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="font-serif text-[18px]" style={{ color: S.ink }}>Who are we optimizing for?</div>
              <div className="text-[12px] mt-0.5" style={{ color: S.ink2 }}>
                Synthetic personas from <span className="font-medium">{FORGE_ORG.name}</span> on Synthetical. This is how Forge defines "good."
              </div>
            </div>
            <span className="text-[11.5px] font-mono px-2 py-1 rounded-full shrink-0"
              style={{ background: selCount ? `${S.accent}1A` : S.paper2, color: selCount ? S.accent : S.ink2, border: `1px solid ${selCount ? S.accent + '44' : S.line}` }}>
              {selCount} selected
            </span>
          </div>

          {/* Audience presets */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px]" style={{ color: S.ink2 }}>Presets:</span>
            {FORGE_AUDIENCES.map((aud) => {
              const on = cfg.audience === aud.id;
              return (
                <button key={aud.id} onClick={() => applyAudience(aud)} title={aud.note}
                  className="h-7 px-2.5 rounded-full text-[12px] inline-flex items-center gap-1.5"
                  style={{ background: on ? S.ink : S.card, color: on ? S.paper : S.ink, border: `1px solid ${on ? S.ink : S.line}` }}>
                  {aud.name} <span className="font-mono text-[10.5px] opacity-70">{aud.personaIds.length}</span>
                </button>
              );
            })}
            <button className="h-7 px-2.5 rounded-full text-[12px] inline-flex items-center gap-1" style={{ color: S.ink2, border: `1px dashed ${S.line}` }}>
              <CTIcon name="plus" size={11} stroke={S.ink2} /> Save current as audience
            </button>
          </div>

          {/* Persona grid */}
          <div className="grid grid-cols-2 gap-2">
            {selectable.map((p) => (
              <PersonaCard key={p.id} p={p} selected={cfg.personaIds.includes(p.id)} onToggle={() => togglePersona(p.id)} />
            ))}
          </div>

          {/* Held-out personas */}
          {cfg.heldOut ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-px" style={{ background: S.line }} />
                <span className="text-[10.5px] font-mono uppercase tracking-[0.14em]" style={{ color: S.ink2 }}>Reserved · held out for validation</span>
                <div className="flex-1 h-px" style={{ background: S.line }} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                {allP.filter((p) => heldOutIds.includes(p.id)).map((p) => (
                  <PersonaCard key={p.id} p={p} selected={false} heldOut onToggle={() => {}} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* ── Right rail: objective + stops + advanced ───────────────── */}
      <div className="min-h-0 overflow-y-auto ct-thin-scroll px-6 py-6 flex flex-col gap-6" style={{ background: S.paper2 }}>

        <div className="flex flex-col gap-4">
          <div className="font-serif text-[18px]" style={{ color: S.ink }}>The objective</div>

          <ForgeField label="Survey question" hint="what each persona answers">
            <div className="rounded-lg" style={{ border: `1px solid ${S.line}`, background: S.card }}>
              <select value={cfg.question} onChange={(e) => setCfg((c) => ({ ...c, question: e.target.value, audience: null }))}
                className="w-full bg-transparent outline-none text-[13px] px-3 h-10 font-serif" style={{ color: S.ink }}>
                {FORGE_QUESTIONS.map((qq) => <option key={qq.id} value={qq.id}>{qq.text}</option>)}
              </select>
            </div>
          </ForgeField>

          <ForgeField label="Reference set" hint="the Likert anchors">
            <div className="flex flex-col gap-1.5">
              {FORGE_REFSETS.map((r) => {
                const on = cfg.refSet === r.id;
                return (
                  <button key={r.id} onClick={() => setCfg((c) => ({ ...c, refSet: r.id, audience: null }))}
                    className="rounded-lg px-3 py-2 text-left flex items-center gap-2"
                    style={{ background: on ? `${S.accent}12` : S.card, border: on ? `1px solid ${S.accent}66` : `1px solid ${S.line}` }}>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12.5px]" style={{ color: S.ink }}>{r.name} <span className="font-mono text-[11px]" style={{ color: S.ink2 }}>{r.ver}</span></div>
                      <div className="text-[11px] truncate" style={{ color: S.ink2 }}>{r.note}</div>
                    </div>
                    {on ? <CTIcon name="check" size={13} stroke={S.accent} strokeWidth={2.2} /> : null}
                  </button>
                );
              })}
            </div>
          </ForgeField>

          <ForgeField label="Target score" hint={`baseline ${FORGE_BASELINE.toFixed(1)} → goal`}>
            <ForgeSlider min={5} max={9} step={0.1} value={cfg.target} onChange={(v) => setCfg((c) => ({ ...c, target: v }))} format={(v) => v.toFixed(1)} />
          </ForgeField>

          <div className="grid grid-cols-2 gap-3">
            <ForgeField label="Max rounds">
              <ForgeSlider min={1} max={8} step={1} value={cfg.rounds} onChange={(v) => setCfg((c) => ({ ...c, rounds: v }))} />
            </ForgeField>
            <ForgeField label="Budget cap">
              <ForgeSlider min={25} max={150} step={5} value={cfg.budget} onChange={(v) => setCfg((c) => ({ ...c, budget: v }))} format={(v) => '$' + v} />
            </ForgeField>
          </div>
        </div>

        {/* Advanced */}
        <div className="rounded-xl" style={{ border: `1px solid ${S.line}`, background: S.card }}>
          <button onClick={() => setCfg((c) => ({ ...c, advanced: !c.advanced }))}
            className="w-full px-3.5 h-11 flex items-center gap-2 text-[12.5px]" style={{ color: S.ink }}>
            <CTIcon name="bolt" size={13} stroke={S.ink2} />
            <span className="flex-1 text-left font-medium">Advanced — search &amp; trust</span>
            <CTIcon name={cfg.advanced ? 'chevron-d' : 'chevron-r'} size={13} stroke={S.ink2} />
          </button>
          {cfg.advanced ? (
            <div className="px-3.5 pb-4 pt-1 flex flex-col gap-4 border-t" style={{ borderColor: S.line }}>
              <ForgeField label="Mutation strategies" hint="how the rewriter varies each round">
                <div className="flex flex-wrap gap-1.5">
                  {FORGE_MUTATIONS.map((m) => {
                    const on = cfg.mutations[m.id];
                    return (
                      <button key={m.id} onClick={() => toggleMutation(m.id)}
                        className="h-7 px-2.5 rounded-full text-[11.5px]"
                        style={{ background: on ? `${S.accent}1A` : 'transparent', color: on ? S.ink : S.ink2, border: `1px solid ${on ? S.accent + '55' : S.line}` }}>
                        {m.label}
                      </button>
                    );
                  })}
                </div>
              </ForgeField>
              <div className="grid grid-cols-2 gap-3">
                <ForgeField label="Candidates / round">
                  <ForgeSlider min={4} max={16} step={2} value={cfg.beamN} onChange={(v) => setCfg((c) => ({ ...c, beamN: v }))} />
                </ForgeField>
                <ForgeField label="Keep top-k">
                  <ForgeSlider min={1} max={6} step={1} value={cfg.beamK} onChange={(v) => setCfg((c) => ({ ...c, beamK: v }))} />
                </ForgeField>
              </div>
              <button onClick={() => setCfg((c) => ({ ...c, heldOut: !c.heldOut }))}
                className="flex items-start gap-2.5 text-left rounded-lg p-2.5"
                style={{ background: cfg.heldOut ? `${S.accent}0F` : S.paper2, border: `1px solid ${cfg.heldOut ? S.accent + '44' : S.line}` }}>
                <span className="w-9 h-5 rounded-full shrink-0 mt-0.5 relative transition-colors" style={{ background: cfg.heldOut ? S.accent : S.line }}>
                  <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: cfg.heldOut ? 18 : 2 }} />
                </span>
                <div>
                  <div className="text-[12.5px] font-medium" style={{ color: S.ink }}>Hold out personas for validation</div>
                  <div className="text-[11.5px]" style={{ color: S.ink2 }}>Re-score the winner against personas the loop never optimized against — the antidote to over-fitting.</div>
                </div>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* footer is rendered by the overlay; expose computed values via ref-less props */}
      <ForgeConfigFooter
        estLow={estLow} estHigh={estHigh} budget={cfg.budget} overBudget={overBudget}
        selCount={selCount} rounds={cfg.rounds} canStart={selCount >= 2} onStart={onStart}
      />
    </div>
  );
}

// Footer pinned to the bottom of the overlay during config.
function ForgeConfigFooter({ estLow, estHigh, budget, overBudget, selCount, rounds, canStart, onStart }) {
  return (
    <div className="col-span-2 flex items-center gap-4 px-7 h-[68px] border-t shrink-0"
      style={{ borderColor: S.line, background: S.card }}>
      <div className="flex items-center gap-2.5">
        <span className="text-[11px] font-mono uppercase tracking-[0.14em]" style={{ color: S.ink2 }}>Est. cost</span>
        <span className="font-mono text-[15px]" style={{ color: overBudget ? '#A8434A' : S.ink }}>${estLow}–{estHigh}</span>
        <span className="text-[12px]" style={{ color: S.ink2 }}>/ cap ${budget}</span>
        {overBudget ? (
          <span className="text-[11px] inline-flex items-center gap-1 px-2 py-0.5 rounded-full" style={{ background: '#FBEAEA', color: '#A8434A' }}>
            <CTIcon name="bolt" size={10} stroke="#A8434A" /> may exceed cap
          </span>
        ) : null}
      </div>
      <div className="text-[12px]" style={{ color: S.ink2 }}>
        {selCount} personas · up to {rounds} rounds · Forge stops at your target, a plateau, or the cap.
      </div>
      <div className="flex-1" />
      <button onClick={onStart} disabled={!canStart}
        className="h-10 px-5 rounded-full text-[13.5px] font-medium inline-flex items-center gap-2 whitespace-nowrap"
        style={{ background: canStart ? S.accent : S.line, color: canStart ? '#FFF' : S.ink2, cursor: canStart ? 'pointer' : 'not-allowed' }}>
        <ForgeMark size={16} accent="#FFF" /> Start improvement run
      </button>
    </div>
  );
}

Object.assign(window, { ForgeMark, ScoreChip, PersonaCard, ForgeField, ForgeSlider, ForgeConfig });
