/* eslint-disable */
// Agents screen — fixed-role roster + team compositions, plus a single
// agent profile sub-page reachable by clicking any role card.

// ─── role badge ──────────────────────────────────────────────────────

function RoleBadge({ role, big = false }) {
  const r = CT_ROLES.find((x) => x.id === role) || { label: role, accent: S.ink };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-medium ${big ? 'text-[12px] px-2.5 py-0.5' : 'text-[10.5px] px-2 py-0.5'}`}
      style={{ background: `${r.accent}1A`, color: r.accent, border: `1px solid ${r.accent}33` }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: r.accent }} />
      {r.label}
    </span>
  );
}

// ─── agent card (used in Your team grid) ────────────────────────────

function AgentCard({ agent }) {
  const { setSelectedAgent } = useApp();
  return (
    <button onClick={() => setSelectedAgent(agent.id)}
      className="text-left rounded-2xl p-5 flex flex-col gap-3 transition-shadow hover:shadow-md"
      style={{ background: S.card, border: `1px solid ${S.line}` }}>
      <div className="flex items-start gap-3">
        <AgentAvatar agent={agent} size={48} ring />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-serif text-[20px] leading-none" style={{ color: S.ink }}>{agent.name}</span>
            {!agent.isCustom ? <Chip tone="ghost">default</Chip> : null}
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            <RoleBadge role={agent.role} />
            <span className="text-[11px] font-mono" style={{ color: S.ink2 }}>{agent.model}</span>
          </div>
        </div>
      </div>
      <p className="font-serif italic text-[14px] leading-snug" style={{ color: S.ink2 }}>{agent.job}</p>
      <div className="flex items-center gap-1.5 mt-auto pt-1">
        <Chip>{['37', '24', '41', '52', '8'][CT_AGENTS.indexOf(agent)] || '12'} rounds</Chip>
        <Chip tone="ghost">in {agent.id === 'a-quant' ? 1 : 4} talks</Chip>
        <span className="ml-auto text-[11.5px] inline-flex items-center gap-1" style={{ color: S.ink2 }}>
          View profile <CTIcon name="arrow" size={11} stroke={S.ink2} strokeWidth={1.8} />
        </span>
      </div>
    </button>
  );
}

// ─── team composition card ──────────────────────────────────────────

function TeamCard({ team }) {
  return (
    <div className="rounded-2xl p-4 flex flex-col gap-3"
      style={{ background: S.card, border: `1px solid ${S.line}` }}>
      <div className="flex items-center gap-2">
        <span className="w-7 h-7 rounded-lg grid place-items-center"
          style={{ background: S.paper2, color: S.accent, border: `1px solid ${S.line}` }}>
          <CTIcon name={team.icon} size={14} stroke={S.accent} strokeWidth={1.7} />
        </span>
        <div className="font-serif text-[17px] leading-none flex-1 min-w-0 truncate" style={{ color: S.ink }}>{team.name}</div>
        {team.isDefault ? <Chip tone="ghost">default</Chip> : null}
      </div>
      <div className="text-[12.5px] leading-snug" style={{ color: S.ink2 }}>{team.description}</div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {team.agentIds.map((id) => {
          const a = CT_AGENTS.find((x) => x.id === id);
          if (!a) return null;
          return (
            <div key={id} className="inline-flex items-center gap-1.5 pl-1 pr-2 py-0.5 rounded-full"
              style={{ background: S.paper, border: `1px solid ${S.line}` }}>
              <AgentAvatar agent={a} size={16} />
              <span className="text-[11.5px]" style={{ color: S.ink }}>{a.name}</span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 mt-1 pt-2 border-t" style={{ borderColor: S.line }}>
        <span className="text-[11px] font-mono" style={{ color: S.ink2 }}>{team.runs} runs</span>
        <button className="ml-auto h-7 px-2.5 text-[11.5px] rounded-full" style={{ color: S.ink2 }}>Edit</button>
        <button className="h-7 px-2.5 text-[11.5px] rounded-full text-white font-medium" style={{ background: S.accent }}>
          Start a Talk
        </button>
      </div>
    </div>
  );
}

// ─── Agents · list screen ───────────────────────────────────────────

function AgentsScreen() {
  const { state, setRoute, setShowCmdK } = useApp();
  return (
    <div className="flex h-screen" style={{ background: S.paper, color: S.ink }}>
      <IconRail
        active="agents"
        onNav={(id) => {
          if (id === 'home') setRoute('home');
          else if (id === 'talks') setRoute('talk');
          else if (id === 'agents') setRoute('agents');
          else if (id === 'docs') setRoute('documents');
          else setRoute('home');
        }}
        onCmdK={() => setShowCmdK(true)}
      />

      <div className="flex-1 min-w-0 flex flex-col ct-screen-enter">
        <TopBar
          left={<>
            <CTIcon name="sparkle" size={14} />
            <span style={{ color: S.ink }}>Agents</span>
            <span>·</span>
            <span>{CT_AGENTS.length} roles · {CT_TEAMS.length} teams</span>
          </>}
          right={<>
            <button className="h-8 px-3 rounded-lg text-[12.5px] inline-flex items-center gap-1.5"
              style={{ background: S.card, border: `1px solid ${S.line}`, color: S.ink }}>
              <CTIcon name="bolt" size={13} stroke={S.ink2} /> Save current Talk as team
            </button>
            <button className="h-8 px-3 rounded-lg text-[12.5px] font-medium text-white inline-flex items-center gap-1.5"
              style={{ background: S.accent }}>
              <CTIcon name="plus" size={13} stroke="#FFF" strokeWidth={2} /> New agent
            </button>
          </>}
        />

        <div className="flex-1 overflow-y-auto px-9 py-7 ct-thin-scroll">
          <div className="max-w-[1240px] mx-auto flex flex-col gap-9">

            {/* Header */}
            <div>
              <div className="text-[11px] font-mono uppercase tracking-[0.18em]" style={{ color: S.ink2 }}>Your team</div>
              <h1 className="font-serif text-[36px] leading-[1.05] tracking-tight mt-1" style={{ color: S.ink }}>
                Five roles. One <em style={{ color: S.accent }}>argumentative</em> table.
              </h1>
              <p className="text-[14px] mt-2 max-w-[660px]" style={{ color: S.ink2 }}>
                Each agent has a fixed role and a specific job. Edit their persona, swap their model, or tune their methodology. Reset to defaults any time.
              </p>
            </div>

            {/* Your team grid */}
            <section>
              <div className="grid grid-cols-3 gap-4">
                {CT_AGENTS.map((a) => <AgentCard key={a.id} agent={a} />)}
                {/* Add slot */}
                <button className="rounded-2xl p-5 flex flex-col items-center justify-center text-center gap-1.5"
                  style={{ background: 'transparent', border: `2px dashed ${S.line}`, color: S.ink2, minHeight: 196 }}>
                  <span className="w-10 h-10 rounded-full grid place-items-center" style={{ background: S.paper2, border: `1px solid ${S.line}` }}>
                    <CTIcon name="plus" size={16} stroke={S.ink} strokeWidth={1.8} />
                  </span>
                  <div className="text-[14px] font-medium mt-1" style={{ color: S.ink }}>Add a new agent</div>
                  <div className="text-[11.5px]" style={{ color: S.ink2 }}>Start from a role template</div>
                </button>
              </div>
            </section>

            {/* Team compositions */}
            <section>
              <div className="flex items-baseline gap-2 mb-3">
                <h3 className="font-serif text-[20px] leading-none" style={{ color: S.ink }}>Team compositions</h3>
                <span className="text-[10.5px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>
                  {CT_TEAMS.length} saved
                </span>
                <div className="flex-1 h-px ml-2" style={{ background: S.line }} />
                <span className="text-[11px]" style={{ color: S.ink2 }}>
                  Reusable rosters · pick one when starting a new Talk
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {CT_TEAMS.map((t) => <TeamCard key={t.id} team={t} />)}
              </div>
            </section>

            {/* Discover (placeholder for marketplace) */}
            <section>
              <div className="flex items-baseline gap-2 mb-3">
                <h3 className="font-serif text-[20px] leading-none" style={{ color: S.ink }}>Discover</h3>
                <span className="text-[10.5px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>Coming soon</span>
                <div className="flex-1 h-px ml-2" style={{ background: S.line }} />
              </div>
              <div className="rounded-2xl p-7 flex items-center gap-5"
                style={{ background: S.paper2, border: `1px dashed ${S.line}` }}>
                <span className="w-12 h-12 rounded-xl grid place-items-center" style={{ background: S.card, border: `1px solid ${S.line}` }}>
                  <CTIcon name="globe" size={20} stroke={S.accent} strokeWidth={1.6} />
                </span>
                <div className="flex-1">
                  <div className="font-serif text-[18px]" style={{ color: S.ink }}>A marketplace of community personas</div>
                  <div className="text-[12.5px] mt-1 leading-relaxed" style={{ color: S.ink2 }}>
                    Browse and install agent presets shared by the ClawTalk community — <em>"Hostile editor"</em>, <em>"Pricing analyst"</em>, <em>"Code reviewer"</em>. We\u2019ll open this up after v1 lands.
                  </div>
                </div>
                <button className="h-9 px-3 rounded-full text-[12.5px]" style={{ color: S.ink2, border: `1px solid ${S.line}` }}>
                  Notify me
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Agent profile screen ───────────────────────────────────────────

function AgentProfileScreen() {
  const { state, setRoute, setShowCmdK, setSelectedAgent, setState } = useApp();
  const id = state.selectedAgentId;
  const agent = CT_AGENTS.find((a) => a.id === id);
  if (!agent) return <div className="p-10">Agent not found.</div>;
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [draft, setDraft] = useState({ persona: agent.persona, model: agent.model });

  return (
    <div className="flex h-screen" style={{ background: S.paper, color: S.ink }}>
      <IconRail
        active="agents"
        onNav={(id2) => {
          if (id2 === 'home') setRoute('home');
          else if (id2 === 'talks') setRoute('talk');
          else if (id2 === 'agents') { setSelectedAgent(null); setRoute('agents'); }
          else if (id2 === 'docs') setRoute('documents');
          else setRoute('home');
        }}
        onCmdK={() => setShowCmdK(true)}
      />

      <div className="flex-1 min-w-0 flex flex-col ct-screen-enter">
        <TopBar
          left={<>
            <button onClick={() => { setSelectedAgent(null); setRoute('agents'); }} className="inline-flex items-center gap-1" style={{ color: S.ink2 }}>
              <CTIcon name="chevron-r" size={12} stroke={S.ink2} /> Agents
            </button>
            <span>·</span>
            <span style={{ color: S.ink }}>{agent.name}</span>
          </>}
          right={<>
            <button className="h-8 px-3 rounded-lg text-[12.5px] inline-flex items-center gap-1.5"
              style={{ background: S.card, border: `1px solid ${S.line}`, color: S.ink2 }}>
              <CTIcon name="bolt" size={13} stroke={S.ink2} /> Reset to defaults
            </button>
            <button className="h-8 px-3 rounded-lg text-[12.5px] font-medium text-white" style={{ background: S.accent }}>
              Save changes
            </button>
          </>}
        />

        <div className="flex-1 overflow-y-auto px-9 py-7 ct-thin-scroll">
          <div className="max-w-[1040px] mx-auto flex flex-col gap-6">

            {/* Hero */}
            <div className="rounded-2xl p-6 flex items-center gap-5 relative overflow-hidden"
              style={{ background: S.card, border: `1px solid ${S.line}` }}>
              <div className="absolute inset-0 pointer-events-none" style={{
                background: `radial-gradient(40% 80% at 0% 50%, ${agent.accent}18 0%, transparent 70%)`,
              }} />
              <AgentAvatar agent={agent} size={72} ring />
              <div className="flex-1 min-w-0 relative">
                <div className="flex items-center gap-2">
                  <span className="font-serif text-[28px] leading-none" style={{ color: S.ink }}>{agent.name}</span>
                  <RoleBadge role={agent.role} big />
                </div>
                <p className="font-serif italic text-[15px] mt-2 leading-snug" style={{ color: S.ink2 }}>{agent.job}</p>
                <div className="flex items-center gap-3 mt-3 text-[11.5px] font-mono" style={{ color: S.ink2 }}>
                  <span>{agent.handle}</span><span>·</span>
                  <span>{agent.model}</span><span>·</span>
                  <span>active in 4 Talks</span><span>·</span>
                  <span>37 rounds this month</span>
                </div>
              </div>
            </div>

            {/* Layout: 2-col, persona+model left, methodology right */}
            <div className="grid grid-cols-2 gap-4">

              {/* Persona */}
              <div className="rounded-2xl p-5" style={{ background: S.card, border: `1px solid ${S.line}` }}>
                <div className="flex items-baseline justify-between mb-3">
                  <h4 className="font-serif text-[17px]" style={{ color: S.ink }}>Persona</h4>
                  <button className="text-[11px] underline underline-offset-2" style={{ color: S.ink2 }}>Reset</button>
                </div>
                <p className="text-[12px] mb-3" style={{ color: S.ink2 }}>
                  Tone, voice, and a thumbprint of personality. Doesn\u2019t change what the agent does — that lives in <em>Methodology</em>.
                </p>
                <textarea
                  value={draft.persona}
                  onChange={(e) => setDraft((d) => ({ ...d, persona: e.target.value }))}
                  className="w-full bg-transparent outline-none resize-none font-serif text-[14.5px] leading-[1.6] p-3 rounded-lg focus:ring-2"
                  style={{ background: S.paper, color: S.ink, border: `1px solid ${S.line}`, minHeight: 92, ['--tw-ring-color']: S.accent + '55' }}
                />
              </div>

              {/* Model */}
              <div className="rounded-2xl p-5" style={{ background: S.card, border: `1px solid ${S.line}` }}>
                <div className="flex items-baseline justify-between mb-3">
                  <h4 className="font-serif text-[17px]" style={{ color: S.ink }}>Model</h4>
                  <button className="text-[11px] underline underline-offset-2" style={{ color: S.ink2 }}>Reset to default</button>
                </div>
                <p className="text-[12px] mb-3" style={{ color: S.ink2 }}>
                  Different model families produce more useful disagreement than persona alone. We picked the best default for this role.
                </p>
                <div className="flex flex-col gap-1.5">
                  {['claude-opus-4.5', 'claude-sonnet-4.5', 'gpt-5-pro', 'gpt-5-mini', 'gemini-2.5-pro'].map((m) => {
                    const on = draft.model === m;
                    const isDefault = m === agent.defaultModel;
                    return (
                      <button key={m} onClick={() => setDraft((d) => ({ ...d, model: m }))}
                        className="h-9 px-3 rounded-lg text-[12.5px] flex items-center gap-2 text-left"
                        style={{
                          background: on ? `${S.accent}1A` : 'transparent',
                          color: on ? S.ink : S.ink2,
                          border: on ? `1px solid ${S.accent}55` : `1px solid ${S.line}`,
                        }}>
                        <span className="font-mono">{m}</span>
                        {isDefault ? <Chip tone="ghost">default</Chip> : null}
                        {on ? <CTIcon name="check" size={12} stroke={S.accent} strokeWidth={2.2} /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Methodology — spans both cols */}
              <div className="col-span-2 rounded-2xl p-5" style={{ background: S.card, border: `1px solid ${S.line}` }}>
                <div className="flex items-baseline justify-between mb-2">
                  <h4 className="font-serif text-[17px]" style={{ color: S.ink }}>Methodology</h4>
                  <button onClick={() => setShowAdvanced((v) => !v)}
                    className="text-[11.5px] inline-flex items-center gap-1" style={{ color: S.ink2 }}>
                    {showAdvanced ? <><CTIcon name="eye" size={11} stroke={S.ink2} /> Hide raw prompt</> : <><CTIcon name="eye" size={11} stroke={S.ink2} /> Show raw prompt</>}
                  </button>
                </div>
                <p className="text-[12px] mb-4" style={{ color: S.ink2 }}>
                  The actual moves the agent makes every turn. <span className="font-medium">This is what makes the role useful.</span> Edit with care.
                </p>

                {!showAdvanced ? (
                  <ol className="flex flex-col gap-2 list-none">
                    {agent.methodology.map((step, i) => (
                      <li key={i} className="flex gap-3 items-start">
                        <span className="w-6 h-6 rounded-full grid place-items-center font-mono text-[11px] shrink-0 mt-0.5"
                          style={{ background: S.paper2, color: S.ink, border: `1px solid ${S.line}` }}>{i + 1}</span>
                        <span className="font-serif text-[15px] leading-snug" style={{ color: S.ink }}>{step}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="rounded-lg p-3 font-mono text-[12px] leading-[1.6]"
                    style={{ background: '#1F1B16', color: '#EAD7A4', border: `1px solid ${S.line}` }}>
                    <div style={{ color: '#9C887A' }}># role: {agent.role}</div>
                    <div style={{ color: '#9C887A' }}># job:</div>
                    <div>{agent.job}</div>
                    <div className="mt-2" style={{ color: '#9C887A' }}># methodology:</div>
                    {agent.methodology.map((step, i) => (
                      <div key={i}>{i + 1}. {step}</div>
                    ))}
                    <div className="mt-2" style={{ color: '#9C887A' }}># persona:</div>
                    <div>{draft.persona}</div>
                  </div>
                )}
                <div className="mt-3 inline-flex items-center gap-2 text-[11.5px] px-2.5 py-1 rounded-full"
                  style={{ background: '#FAF1DE', color: '#7E5418', border: '1px solid #EAD7A4' }}>
                  <CTIcon name="bolt" size={11} stroke="#7E5418" /> Advanced — the role identity is fixed. Edit the raw prompt at your own risk.
                </div>
              </div>

              {/* Recent activity — stub */}
              <div className="col-span-2 rounded-2xl p-5" style={{ background: S.card, border: `1px solid ${S.line}` }}>
                <div className="flex items-baseline gap-2 mb-3">
                  <h4 className="font-serif text-[17px]" style={{ color: S.ink }}>Recent contributions</h4>
                  <span className="text-[10.5px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>across all Talks</span>
                </div>
                <div className="flex flex-col">
                  {[
                    { talk: 'Pricing v2', t: '12 m', text: 'Finished round 3 — defended seat + usage hybrid with 3 supporting claims.' },
                    { talk: 'Launch comms', t: '4 h',  text: 'Argued against Day-2 dual launch (HN + PH). Cited Linear comms post-mortem.' },
                    { talk: 'Notion teardown', t: 'yesterday', text: 'Re-framed the comparison around p95 latency, not feature count.' },
                    { talk: 'Eng hiring', t: '3 d', text: 'Pushed paired debugging as the strongest signal in a 3-loop.' },
                  ].map((r, i, arr) => (
                    <div key={i} className={`py-3 flex gap-3 ${i < arr.length - 1 ? 'border-b' : ''}`} style={{ borderColor: S.line }}>
                      <div className="w-1 self-stretch rounded-full" style={{ background: agent.accent }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px]" style={{ color: S.ink2 }}>
                          <span className="font-mono">{r.t} ago</span> · <span style={{ color: S.ink }} className="font-medium">{r.talk}</span>
                        </div>
                        <div className="font-serif italic text-[14px] leading-snug mt-0.5" style={{ color: S.ink }}>{r.text}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Danger zone */}
            <div className="text-center pb-4">
              <button className="text-[12px]" style={{ color: '#A8434A' }}>
                Disable {agent.name} for the entire workspace
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { AgentsScreen, AgentProfileScreen, AgentCard, TeamCard, RoleBadge });
