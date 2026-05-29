/* eslint-disable */
// Talk-related controls: New Talk sheet, sidebar "+" split menu,
// folder-delete dialog, archive dialog, Context popover, Connectors
// popover, "⋯" more menu.

// ─── small generic Modal ─────────────────────────────────────────────

function Modal({ onClose, width = 520, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] grid place-items-start pt-[10vh] ct-screen-enter"
      style={{ background: 'rgba(31,27,22,0.32)', backdropFilter: 'blur(3px)' }}
      onClick={onClose}>
      <div
        className="mx-auto rounded-2xl overflow-hidden"
        style={{
          width, background: S.card, border: `1px solid ${S.line}`,
          boxShadow: '0 40px 80px rgba(31,27,22,0.25)',
        }}
        onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

// ─── New Talk sheet ─────────────────────────────────────────────────

function NewTalkSheet() {
  const { state, setShowNewTalkSheet, createTalk } = useApp();
  const [title, setTitle]   = useState('');
  const [folderId, setFolderId] = useState('inbox');
  const [teamId, setTeamId]     = useState('team-pricing');
  const [mode, setMode]         = useState('Ordered');
  const [rounds, setRounds]     = useState(3);
  const [prompt, setPrompt]     = useState('');
  const promptRef = useRef(null);

  useEffect(() => { setTimeout(() => promptRef.current?.focus(), 80); }, []);

  const team = CT_TEAMS.find((t) => t.id === teamId);
  const submit = () => {
    createTalk({
      title: title.trim() || (prompt.trim() ? null : 'Untitled Talk'),
      folderId,
      team: team?.agentIds || ['a-strategy','a-critic','a-research','a-editor'],
      mode, rounds, prompt: prompt.trim() || null,
    });
  };
  const onKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  };

  return (
    <Modal onClose={() => setShowNewTalkSheet(false)} width={620}>
      <div className="px-5 py-4 flex items-center justify-between border-b" style={{ borderColor: S.line }}>
        <div className="flex items-center gap-2">
          <CTIcon name="plus" size={14} stroke={S.accent} strokeWidth={2.2} />
          <div className="font-serif text-[17px]" style={{ color: S.ink }}>New Talk</div>
        </div>
        <div className="flex items-center gap-2">
          <Kbd>⌘↵</Kbd>
          <button onClick={() => setShowNewTalkSheet(false)} className="w-7 h-7 grid place-items-center rounded" style={{ color: S.ink2 }}>
            <CTIcon name="x" size={14} />
          </button>
        </div>
      </div>

      <div className="px-5 pt-4 pb-5 flex flex-col gap-3.5">
        {/* Title (optional) */}
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>Title <span style={{ opacity: 0.6 }}>(optional)</span></label>
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder={prompt ? prompt.split(/[.\n]/)[0].slice(0, 60) || 'Auto-derived from your first sentence' : 'Auto-derived from your first sentence'}
            className="h-10 px-3 rounded-lg text-[14px] outline-none focus:ring-2 font-serif"
            style={{ background: S.paper, color: S.ink, border: `1px solid ${S.line}`, ['--tw-ring-color']: S.accent + '55' }} />
        </div>

        {/* Folder + Team row */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>Folder <span style={{ opacity: 0.6 }}>(optional)</span></label>
            <select value={folderId} onChange={(e) => setFolderId(e.target.value)}
              className="h-10 px-3 rounded-lg text-[13.5px] outline-none focus:ring-2"
              style={{ background: S.paper, color: S.ink, border: `1px solid ${S.line}`, ['--tw-ring-color']: S.accent + '55' }}>
              <option value="inbox">— No folder (lands in Inbox)</option>
              {state.folders.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>Team</label>
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}
              className="h-10 px-3 rounded-lg text-[13.5px] outline-none focus:ring-2"
              style={{ background: S.paper, color: S.ink, border: `1px solid ${S.line}`, ['--tw-ring-color']: S.accent + '55' }}>
              {CT_TEAMS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              <option value="all">All five agents</option>
            </select>
          </div>
        </div>

        {/* Team preview chips */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {(team?.agentIds || ['a-strategy','a-critic','a-research','a-editor','a-quant']).map((id) => {
            const a = CT_AGENTS.find((x) => x.id === id); if (!a) return null;
            return (
              <span key={id} className="inline-flex items-center gap-1.5 pl-1 pr-2 py-0.5 rounded-full"
                style={{ background: S.paper, border: `1px solid ${S.line}` }}>
                <AgentAvatar agent={a} size={16} />
                <span className="text-[11.5px]" style={{ color: S.ink }}>{a.name}</span>
              </span>
            );
          })}
        </div>

        {/* Prompt */}
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>What should the room argue about? <span style={{ opacity: 0.6 }}>(optional)</span></label>
          <textarea ref={promptRef} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={onKey}
            placeholder="You can frame the question now, or open an empty room and decide inside…"
            className="rounded-lg p-3 text-[15px] outline-none resize-none focus:ring-2 font-serif leading-[1.55]"
            style={{ background: S.paper, color: S.ink, border: `1px solid ${S.line}`, minHeight: 120, ['--tw-ring-color']: S.accent + '55' }} />
        </div>

        {/* Mode + rounds */}
        <div className="grid grid-cols-2 gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>Mode</label>
            <div className="flex gap-1 rounded-lg p-0.5 self-start" style={{ background: S.paper2, border: `1px solid ${S.line}` }}>
              {['Ordered','Parallel'].map((m) => (
                <button key={m} onClick={() => setMode(m)}
                  className="h-7 px-3 rounded-md text-[12px] font-medium"
                  style={{
                    background: mode === m ? S.card : 'transparent',
                    color: mode === m ? S.ink : S.ink2,
                    boxShadow: mode === m ? `inset 0 0 0 1px ${S.line}` : 'none',
                  }}>{m}</button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>Rounds</label>
            <div className="flex gap-1 rounded-lg p-0.5 self-start" style={{ background: S.paper2, border: `1px solid ${S.line}` }}>
              {[1, 2, 3, 5].map((r) => (
                <button key={r} onClick={() => setRounds(r)}
                  className="h-7 w-8 rounded-md text-[12px] font-medium"
                  style={{
                    background: rounds === r ? S.card : 'transparent',
                    color: rounds === r ? S.ink : S.ink2,
                    boxShadow: rounds === r ? `inset 0 0 0 1px ${S.line}` : 'none',
                  }}>{r}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="px-5 py-3 border-t flex items-center justify-between" style={{ borderColor: S.line, background: S.paper }}>
        <span className="text-[11.5px]" style={{ color: S.ink2 }}>
          Lands in <span className="font-medium" style={{ color: S.ink }}>{folderId === 'inbox' ? 'Inbox' : state.folders.find((f) => f.id === folderId)?.title}</span>
        </span>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowNewTalkSheet(false)} className="h-9 px-3 rounded-full text-[13px]" style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>Cancel</button>
          <button onClick={submit}
            className="h-9 px-4 rounded-full text-[13px] font-medium text-white inline-flex items-center gap-1.5"
            style={{ background: S.accent }}>
            Open Talk <CTIcon name="arrow" size={13} stroke="#FFF" strokeWidth={2} />
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Sidebar "+" split menu ──────────────────────────────────────────

function SidebarPlusMenu({ onClose, onNewTalk, onNewFolder, anchorRect }) {
  const style = anchorRect ? {
    position: 'fixed',
    top: anchorRect.bottom + 6,
    left: anchorRect.left - 4,
    width: 200, zIndex: 60,
  } : { position: 'fixed', top: 60, left: 60, width: 200, zIndex: 60 };
  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div className="rounded-xl overflow-hidden ct-screen-enter"
        style={{ ...style, background: S.card, border: `1px solid ${S.line}`, boxShadow: '0 20px 40px rgba(31,27,22,0.18)' }}>
        <button onClick={onNewTalk} className="w-full px-3 py-2 flex items-center gap-2 text-[13px] text-left hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink }}>
          <CTIcon name="chat" size={13} stroke={S.ink2} />
          <span className="flex-1">New Talk</span>
          <Kbd>⌘N</Kbd>
        </button>
        <button onClick={onNewFolder} className="w-full px-3 py-2 flex items-center gap-2 text-[13px] text-left hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink }}>
          <CTIcon name="folder" size={13} stroke={S.ink2} />
          New folder
        </button>
        <div className="h-px" style={{ background: S.line }} />
        <button onClick={onClose} className="w-full px-3 py-2 flex items-center gap-2 text-[13px] text-left hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink2 }}>
          <CTIcon name="paperclip" size={13} stroke={S.ink2} />
          Import…
        </button>
      </div>
    </>
  );
}

// ─── Folder delete confirmation ─────────────────────────────────────

function FolderDeleteDialog() {
  const { state, setFolderDeleteDialog, deleteFolder } = useApp();
  const folderId = state.folderDeleteDialog?.folderId;
  const folder = state.folders.find((f) => f.id === folderId);
  if (!folder) return null;
  const close = () => setFolderDeleteDialog(null);

  return (
    <Modal onClose={close} width={480}>
      <div className="px-5 pt-5">
        <div className="text-[10.5px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>Delete folder</div>
        <h3 className="font-serif text-[22px] leading-tight mt-1" style={{ color: S.ink }}>
          Delete <em style={{ color: S.accent }}>{folder.title}</em>?
        </h3>
        <p className="text-[13px] mt-2 leading-relaxed" style={{ color: S.ink2 }}>
          {folder.talkIds.length === 0 ? (
            <>This folder is empty — it\u2019ll just go away.</>
          ) : (
            <>This folder has <span className="font-medium" style={{ color: S.ink }}>{folder.talkIds.length} Talk{folder.talkIds.length === 1 ? '' : 's'}</span>. Choose what happens to them.</>
          )}
        </p>
      </div>
      <div className="px-5 py-4 flex flex-col gap-2">
        {folder.talkIds.length > 0 ? (
          <>
            <button onClick={() => deleteFolder(folder.id, false)}
              className="rounded-xl p-3 text-left flex items-start gap-3 hover:shadow-md transition-shadow"
              style={{ background: S.card, border: `1px solid ${S.line}` }}>
              <span className="w-8 h-8 rounded-lg grid place-items-center shrink-0" style={{ background: `${S.accent}1A`, color: S.accent }}>
                <CTIcon name="folder" size={14} stroke={S.accent} strokeWidth={1.7} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-[13.5px]" style={{ color: S.ink }}>Keep the Talks — delete folder only</div>
                <div className="text-[12px] mt-0.5" style={{ color: S.ink2 }}>Talks move to Inbox. Safest default.</div>
              </div>
            </button>
            <button onClick={() => deleteFolder(folder.id, true)}
              className="rounded-xl p-3 text-left flex items-start gap-3 hover:shadow-md transition-shadow"
              style={{ background: S.card, border: `1px solid #ECC4C7` }}>
              <span className="w-8 h-8 rounded-lg grid place-items-center shrink-0" style={{ background: '#FBECEC', color: '#A8434A' }}>
                <CTIcon name="x" size={14} stroke="#A8434A" strokeWidth={1.7} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-[13.5px]" style={{ color: '#7B2A30' }}>Delete folder AND its Talks</div>
                <div className="text-[12px] mt-0.5" style={{ color: '#7B2A30' + 'AA' }}>{folder.talkIds.length} Talk{folder.talkIds.length === 1 ? '' : 's'} archived. Recoverable from Archive.</div>
              </div>
            </button>
          </>
        ) : (
          <button onClick={() => deleteFolder(folder.id, false)}
            className="rounded-xl p-3 text-left text-white font-medium" style={{ background: S.accent }}>
            Delete folder
          </button>
        )}
      </div>
      <div className="px-5 py-3 border-t flex justify-end" style={{ borderColor: S.line }}>
        <button onClick={close} className="h-9 px-3 rounded-full text-[13px]" style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>Cancel</button>
      </div>
    </Modal>
  );
}

// ─── Archive Talk confirmation ──────────────────────────────────────

function ArchiveTalkDialog() {
  const { state, setArchiveTalkDialog, archiveTalk } = useApp();
  const talkId = state.archiveTalkDialog?.talkId;
  const talk = talkId ? state.talks[talkId] : null;
  if (!talk) return null;
  const doc = talk.docId ? state.docs[talk.docId] : null;
  const close = () => setArchiveTalkDialog(null);

  return (
    <Modal onClose={close} width={480}>
      <div className="px-5 pt-5">
        <div className="text-[10.5px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>Archive Talk</div>
        <h3 className="font-serif text-[22px] leading-tight mt-1" style={{ color: S.ink }}>
          Archive <em style={{ color: S.accent }}>{talk.title}</em>?
        </h3>
        <p className="text-[13px] mt-2 leading-relaxed" style={{ color: S.ink2 }}>
          {doc ? (
            <>This Talk has a linked doc — <span className="font-mono">{doc.title}</span>. Choose what happens to it.</>
          ) : (
            <>The Talk is moved to Archive, recoverable later.</>
          )}
        </p>
      </div>
      {doc ? (
        <div className="px-5 py-4 flex flex-col gap-2">
          <button onClick={() => archiveTalk(talk.id, false)}
            className="rounded-xl p-3 text-left flex items-start gap-3 hover:shadow-md transition-shadow"
            style={{ background: S.card, border: `1px solid ${S.line}` }}>
            <span className="w-8 h-8 rounded-lg grid place-items-center shrink-0" style={{ background: `${S.accent}1A`, color: S.accent }}>
              <CTIcon name="doc" size={14} stroke={S.accent} strokeWidth={1.7} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-[13.5px]" style={{ color: S.ink }}>Archive Talk only — keep doc (unlinked)</div>
              <div className="text-[12px] mt-0.5" style={{ color: S.ink2 }}>The doc stays in Documents, but no longer points at any Talk. Safe default.</div>
            </div>
          </button>
          <button onClick={() => archiveTalk(talk.id, true)}
            className="rounded-xl p-3 text-left flex items-start gap-3 hover:shadow-md transition-shadow"
            style={{ background: S.card, border: `1px solid #ECC4C7` }}>
            <span className="w-8 h-8 rounded-lg grid place-items-center shrink-0" style={{ background: '#FBECEC', color: '#A8434A' }}>
              <CTIcon name="x" size={14} stroke="#A8434A" strokeWidth={1.7} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-[13.5px]" style={{ color: '#7B2A30' }}>Archive Talk AND doc together</div>
              <div className="text-[12px] mt-0.5" style={{ color: '#7B2A30' + 'AA' }}>The doc is removed from Documents.</div>
            </div>
          </button>
        </div>
      ) : (
        <div className="px-5 py-4">
          <button onClick={() => archiveTalk(talk.id, false)}
            className="w-full rounded-xl p-3 text-white font-medium" style={{ background: S.accent }}>
            Archive Talk
          </button>
        </div>
      )}
      <div className="px-5 py-3 border-t flex justify-end" style={{ borderColor: S.line }}>
        <button onClick={close} className="h-9 px-3 rounded-full text-[13px]" style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>Cancel</button>
      </div>
    </Modal>
  );
}

// ─── Context popover (talk header) ──────────────────────────────────

function ContextPopover({ anchorRect, onClose }) {
  const { state, activeTalk } = useApp();
  const sources = [
    { kind: 'doc',  name: state.docs[activeTalk?.docId]?.title || '—', meta: 'Linked doc' },
    { kind: 'url',  name: 'notion.com/pricing',         meta: 'Web · captured 12 m ago' },
    { kind: 'url',  name: 'linear.app/pricing/asks',    meta: 'Web · captured 12 m ago' },
    { kind: 'csv',  name: 'comps-50seat.csv',           meta: 'CSV · 2.4 KB · uploaded' },
    { kind: 'talk', name: 'Pricing v1 — archive',       meta: 'Past Talk · referenced' },
    { kind: 'rule', name: 'token → action (renaming)',  meta: 'House rule' },
    { kind: 'rule', name: 'cap = hard (procurement)',   meta: 'House rule' },
  ].filter((s) => s.name && s.name !== '—');

  const style = anchorRect ? {
    position: 'fixed',
    top: anchorRect.bottom + 6,
    left: Math.max(8, anchorRect.right - 380),
    width: 400, zIndex: 60,
  } : { position: 'fixed', top: 80, right: 16, width: 400, zIndex: 60 };

  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div className="rounded-2xl overflow-hidden ct-screen-enter"
        style={{ ...style, background: S.card, border: `1px solid ${S.line}`, boxShadow: '0 30px 60px rgba(31,27,22,0.22)' }}>
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-center gap-2">
            <CTIcon name="sparkle" size={13} stroke={S.ink2} />
            <div className="font-serif text-[16px]" style={{ color: S.ink }}>Context in this Talk</div>
            <span className="ml-auto text-[10.5px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>
              {sources.length} sources
            </span>
          </div>
          <p className="text-[12px] mt-1 leading-relaxed" style={{ color: S.ink2 }}>
            Everything the room can read from when composing. Add a URL, drop a file, or link a past Talk.
          </p>
        </div>
        <div className="max-h-[56vh] overflow-y-auto pb-1">
          {sources.map((s, i) => (
            <div key={i} className="px-4 py-2 flex items-center gap-2.5 hover:bg-[var(--salon-paper-2)]">
              <span className="w-7 h-7 rounded-lg grid place-items-center shrink-0"
                style={{ background: S.paper2, color: S.ink2, border: `1px solid ${S.line}` }}>
                <CTIcon name={
                  s.kind === 'doc' ? 'doc' :
                  s.kind === 'url' ? 'globe' :
                  s.kind === 'csv' ? 'doc' :
                  s.kind === 'talk' ? 'chat' : 'bolt'
                } size={12} stroke={S.ink2} strokeWidth={1.7} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium truncate" style={{ color: S.ink }}>{s.name}</div>
                <div className="text-[11px] truncate" style={{ color: S.ink2 }}>{s.meta}</div>
              </div>
              <button className="w-6 h-6 grid place-items-center rounded" style={{ color: S.ink2 }} title="Remove">
                <CTIcon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="px-4 py-3 border-t flex items-center gap-2" style={{ borderColor: S.line, background: S.paper }}>
          <button className="h-7 px-2.5 rounded-full text-[11.5px] inline-flex items-center gap-1.5" style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>
            <CTIcon name="globe" size={11} stroke={S.ink2} /> Add URL
          </button>
          <button className="h-7 px-2.5 rounded-full text-[11.5px] inline-flex items-center gap-1.5" style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>
            <CTIcon name="paperclip" size={11} stroke={S.ink2} /> Upload file
          </button>
          <button className="h-7 px-2.5 rounded-full text-[11.5px] inline-flex items-center gap-1.5 ml-auto" style={{ background: S.accent, color: '#FFF' }}>
            Done
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Connectors popover (talk header) ───────────────────────────────

function ConnectorsPopover({ anchorRect, onClose }) {
  const bindings = [
    { service: 'Slack',    target: '#pricing',                  scope: 'read · post',   on: true },
    { service: 'Drive',    target: '/pricing-v2/',              scope: 'read · write',  on: true },
    { service: 'Gmail',    target: 'label "pricing"',           scope: 'read',          on: false },
    { service: 'Linear',   target: 'Project · Pricing v2',      scope: 'read · file',   on: false },
    { service: 'GitHub',   target: 'oxbow/billing-svc',         scope: 'read',          on: false },
  ];

  const style = anchorRect ? {
    position: 'fixed',
    top: anchorRect.bottom + 6,
    left: Math.max(8, anchorRect.right - 380),
    width: 400, zIndex: 60,
  } : { position: 'fixed', top: 80, right: 16, width: 400, zIndex: 60 };

  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div className="rounded-2xl overflow-hidden ct-screen-enter"
        style={{ ...style, background: S.card, border: `1px solid ${S.line}`, boxShadow: '0 30px 60px rgba(31,27,22,0.22)' }}>
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-center gap-2">
            <CTIcon name="globe" size={13} stroke={S.ink2} />
            <div className="font-serif text-[16px]" style={{ color: S.ink }}>Connectors in this Talk</div>
            <span className="ml-auto text-[10.5px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>
              {bindings.filter((b) => b.on).length} of {bindings.length} bound
            </span>
          </div>
          <p className="text-[12px] mt-1 leading-relaxed" style={{ color: S.ink2 }}>
            External services this Talk is wired into. Manage workspace-wide connections in <span className="underline cursor-pointer">Settings · Connectors</span>.
          </p>
        </div>
        <div className="max-h-[56vh] overflow-y-auto pb-1">
          {bindings.map((b, i) => (
            <div key={i} className="px-4 py-2.5 flex items-center gap-3 hover:bg-[var(--salon-paper-2)]">
              <span className="w-7 h-7 rounded-lg grid place-items-center font-mono text-[10px] font-medium shrink-0"
                style={{ background: S.paper2, color: S.ink, border: `1px solid ${S.line}` }}>{b.service[0]}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium truncate" style={{ color: S.ink }}>{b.service} · {b.target}</div>
                <div className="text-[11px]" style={{ color: S.ink2 }}>{b.scope}</div>
              </div>
              <Switch on={b.on} />
            </div>
          ))}
        </div>
        <div className="px-4 py-3 border-t flex items-center gap-2" style={{ borderColor: S.line, background: S.paper }}>
          <button className="h-7 px-2.5 rounded-full text-[11.5px] inline-flex items-center gap-1.5" style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>
            <CTIcon name="plus" size={11} stroke={S.ink2} strokeWidth={2} /> Add connection
          </button>
          <button className="h-7 px-2.5 rounded-full text-[11.5px] ml-auto" style={{ background: S.accent, color: '#FFF' }}>Done</button>
        </div>
      </div>
    </>
  );
}

// ─── Talk "⋯" more menu ─────────────────────────────────────────────

function TalkMoreMenu({ anchorRect, onClose, talk }) {
  const { state, moveTalk, renameTalk, duplicateTalk, setArchiveTalkDialog } = useApp();
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);

  const style = anchorRect ? {
    position: 'fixed',
    top: anchorRect.bottom + 6,
    left: Math.max(8, anchorRect.right - 240),
    width: 240, zIndex: 60,
  } : { position: 'fixed', top: 80, right: 16, width: 240, zIndex: 60 };

  const onRename = () => {
    const next = window.prompt('Rename Talk', talk.title);
    if (next && next.trim()) renameTalk(talk.id, next.trim());
    onClose();
  };
  const onDuplicate = () => { duplicateTalk(talk.id); onClose(); };
  const onArchive = () => { setArchiveTalkDialog({ talkId: talk.id }); onClose(); };

  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div className="rounded-xl overflow-hidden ct-screen-enter"
        style={{ ...style, background: S.card, border: `1px solid ${S.line}`, boxShadow: '0 20px 40px rgba(31,27,22,0.18)' }}>
        <button onClick={onClose} className="w-full px-3 py-2 flex items-center gap-2 text-[13px] text-left hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink }}>
          <CTIcon name="bolt" size={13} stroke={S.ink2} /> Run history
        </button>
        <div className="relative">
          <button onClick={() => setShowMoveSubmenu((v) => !v)} className="w-full px-3 py-2 flex items-center gap-2 text-[13px] text-left hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink }}>
            <CTIcon name="folder" size={13} stroke={S.ink2} /> Move to folder…
            <CTIcon name="chevron-r" size={11} stroke={S.ink2} strokeWidth={1.8} className="ml-auto" />
          </button>
          {showMoveSubmenu ? (
            <div className="absolute left-full top-0 ml-1 w-[200px] rounded-xl overflow-hidden ct-screen-enter"
              style={{ background: S.card, border: `1px solid ${S.line}`, boxShadow: '0 20px 40px rgba(31,27,22,0.18)' }}>
              <button onClick={() => { moveTalk(talk.id, 'inbox'); onClose(); }}
                className="w-full px-3 py-2 flex items-center gap-2 text-[12.5px] text-left hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink }}>
                <CTIcon name="folder" size={12} stroke={S.ink2} /> Inbox
              </button>
              {state.folders.map((f) => (
                <button key={f.id} onClick={() => { moveTalk(talk.id, f.id); onClose(); }}
                  className="w-full px-3 py-2 flex items-center gap-2 text-[12.5px] text-left hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink }}>
                  <CTIcon name="folder" size={12} stroke={S.ink2} /> {f.title}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button onClick={onRename} className="w-full px-3 py-2 flex items-center gap-2 text-[13px] text-left hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink }}>
          <CTIcon name="paperclip" size={13} stroke={S.ink2} /> Rename
        </button>
        <button onClick={onDuplicate} className="w-full px-3 py-2 flex items-center gap-2 text-[13px] text-left hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink }}>
          <CTIcon name="plus" size={13} stroke={S.ink2} /> Duplicate
        </button>
        <button onClick={onClose} className="w-full px-3 py-2 flex items-center gap-2 text-[13px] text-left hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink }}>
          <CTIcon name="send" size={13} stroke={S.ink2} /> Export…
        </button>
        <div className="h-px" style={{ background: S.line }} />
        <button onClick={onArchive} className="w-full px-3 py-2 flex items-center gap-2 text-[13px] text-left hover:bg-[var(--salon-paper-2)]" style={{ color: '#A8434A' }}>
          <CTIcon name="logout" size={13} stroke="#A8434A" /> Archive
        </button>
      </div>
    </>
  );
}

Object.assign(window, {
  Modal, NewTalkSheet, SidebarPlusMenu, FolderDeleteDialog, ArchiveTalkDialog,
  ContextPopover, ConnectorsPopover, TalkMoreMenu,
});
