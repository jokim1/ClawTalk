/* eslint-disable */
// Salon prototype — shell components. Sidebar (rail + list), top bar,
// composer, doc pane. Built on the Salon system primitives.

// Salon palette echo (var() so tweaks can re-tint).
const S = {
  ink:    'var(--salon-ink, #1F1B16)',
  ink2:   'var(--salon-ink-2, #6B6660)',
  paper:  'var(--salon-paper, #FBF7EF)',
  paper2: 'var(--salon-paper-2, #F4ECDB)',
  card:   'var(--salon-card, #FFFFFF)',
  line:   'var(--salon-line, #E6E0D1)',
  accent: 'var(--salon-accent, #C8643A)',
};

// ─── atoms ─────────────────────────────────────────────────────────────

function Avatar({ initials, color = '#3F6B5C', size = 36, ring = false }) {
  return (
    <div className="rounded-full grid place-items-center font-serif font-medium text-white shrink-0"
      style={{ width: size, height: size, background: color, fontSize: size * 0.36,
        boxShadow: ring ? `0 0 0 2px ${S.paper}, 0 0 0 3px ${color}55` : 'none' }}>
      {initials}
    </div>
  );
}

function AgentAvatar({ agent, size = 36, ring = false }) {
  return <Avatar initials={agent.initials} color={agent.accent} size={size} ring={ring} />;
}

function RunPill({ status }) {
  const meta = CT_RUN_STATES[status] || CT_RUN_STATES.queued;
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium"
      style={{ background: meta.bg, color: meta.fg, border: `1px solid ${meta.border}` }}>
      <span className={`w-1.5 h-1.5 rounded-full ${status === 'running' ? 'ct-pulse' : ''}`} style={{ background: meta.dot }} />
      {meta.label}
    </span>
  );
}

function Chip({ children, tone = 'paper', onClick, active = false }) {
  const base = "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium select-none";
  const style = tone === 'paper'
    ? { background: active ? S.accent : S.paper2, color: active ? '#FFF' : S.ink, border: active ? 'none' : `1px solid ${S.line}` }
    : { background: 'transparent', color: S.ink2, border: `1px solid ${S.line}` };
  return <button onClick={onClick} className={base} style={style}>{children}</button>;
}

function Kbd({ children }) {
  return <span className="font-mono text-[10px] px-1.5 py-0.5 rounded" style={{ background: S.paper2, color: S.ink2 }}>{children}</span>;
}

// ─── icon rail (left-most 56px) ────────────────────────────────────────

function IconRail({ active, onNav, onCmdK }) {
  const { state, setRoute } = useApp();
  const [profileOpen, setProfileOpen] = useState(false);
  const profileBtnRef = useRef(null);
  const items = [
    { id: 'home',     icon: 'home',     label: 'Home' },
    { id: 'talks',    icon: 'chat',     label: 'Talks' },
    { id: 'agents',   icon: 'sparkle',  label: 'Agents' },
    { id: 'docs',     icon: 'doc',      label: 'Documents' },
  ];
  if (window.CT_FORGE_ENABLED) items.push({ id: 'forge', icon: 'forge', label: 'Forge' });
  return (
    <div className="w-14 flex flex-col items-center py-3 gap-1 shrink-0 h-full relative"
      style={{ background: S.paper2, borderRight: `1px solid ${S.line}` }}>
      <div className="mb-2"><CTMarkSalon size={28} accent={S.accent} /></div>
      {items.map((it) => {
        const on = it.id === active;
        return (
          <button key={it.id} onClick={() => { if (it.id === 'forge') setRoute('forge'); else onNav(it.id); }}
            className="w-10 h-10 rounded-xl grid place-items-center transition-colors"
            style={{
              background: on ? S.card : 'transparent',
              color: on ? S.ink : S.ink2,
              boxShadow: on ? `inset 0 0 0 1px ${S.line}` : 'none',
            }}
            title={it.label}>
            {it.id === 'forge' ? <ForgeMark size={18} accent={on ? S.accent : S.ink2} /> : <CTIcon name={it.icon} size={18} strokeWidth={1.7} />}
          </button>
        );
      })}
      <button onClick={onCmdK}
        className="w-10 h-10 rounded-xl grid place-items-center transition-colors mt-1"
        style={{ background: 'transparent', color: S.ink2 }}
        title="Command palette (⌘K)">
        <CTIcon name="cmd" size={18} strokeWidth={1.7} />
      </button>

      {/* Profile avatar replaces the old cog — single entry point. */}
      <div className="mt-auto relative">
        <button
          ref={profileBtnRef}
          onClick={() => setProfileOpen((v) => !v)}
          className="w-10 h-10 rounded-full grid place-items-center transition-shadow"
          style={{
            boxShadow: active === 'settings' || profileOpen
              ? `0 0 0 2px ${S.paper2}, 0 0 0 3.5px ${S.accent}`
              : `0 0 0 2px ${S.paper2}, 0 0 0 3px ${S.line}`,
          }}
          aria-label={`${state.user.name} — open profile menu`}
          title={state.user.name}>
          <Avatar initials={state.user.initials} color={state.user.avatarColor} size={32} />
        </button>
        {profileOpen ? (
          <ProfileMenu
            onClose={() => setProfileOpen(false)}
          />
        ) : null}
      </div>
    </div>
  );
}

// Popover for the rail's profile button — anchored to the bottom-left.
// 2-column layout: left = workspaces list, right = account actions.
function ProfileMenu({ onClose }) {
  const { state, setRoute, setSettingsTab, switchWorkspace } = useApp();
  const goTo = (tab) => () => { onClose(); setSettingsTab(tab); };
  const workspaces = state.workspaces || [];
  const active = workspaces.find((w) => w.active) || workspaces[0];

  const switchTo = (id) => () => {
    if (typeof switchWorkspace === 'function') switchWorkspace(id);
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute bottom-0 left-full ml-2 flex rounded-2xl overflow-hidden z-50 ct-screen-enter"
        style={{
          background: S.card,
          border: `1px solid ${S.line}`,
          boxShadow: '0 28px 64px rgba(31,27,22,0.22), 0 2px 6px rgba(31,27,22,0.06)',
          width: 520,
        }}>

        {/* ── Left column: Workspaces ─────────────────────────────── */}
        <div className="flex flex-col"
          style={{ width: 224, background: S.paper2, borderRight: `1px solid ${S.line}` }}>
          <div className="px-3.5 pt-3 pb-2 flex items-baseline justify-between">
            <div className="font-serif text-[13px] tracking-tight" style={{ color: S.ink }}>Workspaces</div>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em]" style={{ color: S.ink2 }}>
              {workspaces.length}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto ct-thin-scroll px-1.5 pb-1.5" style={{ maxHeight: 320 }}>
            {workspaces.map((w) => {
              const isActive = w.id === active?.id;
              return (
                <button key={w.id} onClick={switchTo(w.id)}
                  className="w-full px-2 py-1.5 my-0.5 flex items-center gap-2 rounded-lg text-left transition-colors"
                  style={{
                    background: isActive ? S.card : 'transparent',
                    border: `1px solid ${isActive ? S.line : 'transparent'}`,
                    color: S.ink,
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'rgba(31,27,22,0.04)'; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}>
                  <span className="w-6 h-6 shrink-0 rounded grid place-items-center text-[9.5px] font-mono"
                    style={{ background: w.color, color: '#FFF', letterSpacing: '0.02em' }}>
                    {w.initials}
                  </span>
                  <span className="flex-1 min-w-0 text-[12.5px] truncate"
                    style={{ color: S.ink, fontWeight: isActive ? 500 : 400 }}>
                    {w.name}
                  </span>
                  {w.unread > 0 ? (
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: S.accent }} title={`${w.unread} unread`} />
                  ) : null}
                  {isActive ? (
                    <CTIcon name="check" size={12} stroke={S.accent} strokeWidth={2.4} />
                  ) : null}
                </button>
              );
            })}
          </div>

          {/* Left footer: user mini-row + Log out */}
          <div className="border-t flex items-center gap-2 px-2.5 py-2" style={{ borderColor: S.line }}>
            <Avatar initials={state.user.initials} color={state.user.avatarColor} size={22} />
            <button onClick={() => { onClose(); setRoute('signin'); }}
              className="flex items-center gap-1.5 text-[12px] font-medium px-1.5 py-1 rounded"
              style={{ color: '#A8434A' }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(168,67,74,0.08)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
              <CTIcon name="logout" size={12} stroke="#A8434A" strokeWidth={1.8} />
              Log out
            </button>
          </div>
        </div>

        {/* ── Right column: Account actions ───────────────────────── */}
        <div className="flex-1 flex flex-col" style={{ background: S.card }}>
          {/* User header */}
          <div className="px-4 pt-3.5 pb-3 flex items-start gap-3">
            <Avatar initials={state.user.initials} color={state.user.avatarColor} size={40} />
            <div className="min-w-0 flex-1">
              <div className="font-serif text-[15px] leading-tight truncate" style={{ color: S.ink }}>
                {state.user.name}
              </div>
              <div className="text-[11.5px] truncate mt-0.5" style={{ color: S.ink2 }}>{state.user.email}</div>
            </div>
            <span className="text-[9.5px] uppercase tracking-[0.14em] font-mono px-1.5 py-0.5 rounded-full shrink-0"
              style={{ background: '#3F6B5C', color: '#FFF' }}>
              {active?.role || 'Owner'}
            </span>
          </div>

          {/* Out-of-office style status row */}
          <div className="px-3 pb-2">
            <button onClick={onClose}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12.5px] transition-colors"
              style={{ background: S.paper2, border: `1px solid ${S.line}`, color: S.ink }}
              onMouseEnter={(e) => e.currentTarget.style.background = '#EEE6D2'}
              onMouseLeave={(e) => e.currentTarget.style.background = S.paper2}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#3F6B5C' }} />
              Available · agents may notify
              <span className="ml-auto text-[10.5px]" style={{ color: S.ink2 }}>Edit</span>
            </button>
          </div>

          <div className="h-px mx-3" style={{ background: S.line }} />

          {/* Workspace-scoped actions */}
          <div className="py-1">
            <MenuRow icon="settings" label="Admin console" onClick={onClose} />
            <MenuRow icon="plus" label="New workspace" onClick={onClose} />
            <MenuRow icon="sparkle" label="Invite people to Oxbow" onClick={onClose} />
          </div>

          {/* CTA */}
          <div className="px-3 pb-2 pt-1">
            <button onClick={onClose}
              className="w-full rounded-lg py-2 text-[13px] font-medium transition-transform active:scale-[0.99]"
              style={{
                background: S.accent,
                color: '#FFF',
                boxShadow: '0 2px 0 rgba(31,27,22,0.08), inset 0 1px 0 rgba(255,255,255,0.18)',
              }}>
              Upgrade workspace
            </button>
          </div>

          <div className="h-px mx-3" style={{ background: S.line }} />

          {/* Account-scoped actions */}
          <div className="py-1">
            <MenuRow icon="settings" label="Profile"    onClick={goTo('profile')} />
            <MenuRow icon="bolt"     label="API keys"   onClick={goTo('api-keys')} />
            <MenuRow icon="sparkle"  label="AI agents"  onClick={goTo('agents')} />
            <MenuRow icon="globe"    label="Tools"      onClick={goTo('tools')} />
            <MenuRow icon="folder"   label="Connectors" onClick={goTo('connectors')} />
          </div>

          <div className="h-px mx-3" style={{ background: S.line }} />

          <div className="py-1 pb-2">
            <MenuRow icon="plus" label="Add another account" onClick={onClose} muted />
          </div>
        </div>
      </div>
    </>
  );
}

// Single menu row used in the right column of ProfileMenu.
function MenuRow({ icon, label, onClick, muted = false }) {
  return (
    <button onClick={onClick}
      className="w-full px-3.5 py-1.5 flex items-center gap-2.5 text-[13px] text-left transition-colors"
      style={{ color: muted ? S.ink2 : S.ink }}
      onMouseEnter={(e) => e.currentTarget.style.background = S.paper2}
      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
      <CTIcon name={icon} size={14} stroke={S.ink2} strokeWidth={1.6} />
      {label}
    </button>
  );
}

// ─── secondary list (260px) ────────────────────────────────────────────

function SecondaryList() {
  const app = useApp();
  const { state, setShowNewTalkSheet, createFolder, setFolderDeleteDialog, setShowCmdK } = app;
  const [q, setQ] = useState('');
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [plusRect, setPlusRect] = useState(null);
  const [newFolder, setNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const plusBtnRef = useRef(null);
  const newFolderInputRef = useRef(null);

  useEffect(() => { if (newFolder) setTimeout(() => newFolderInputRef.current?.focus(), 50); }, [newFolder]);

  const onPlus = () => {
    setPlusRect(plusBtnRef.current?.getBoundingClientRect());
    setPlusMenuOpen(true);
  };
  const commitNewFolder = () => {
    if (newFolderName.trim()) createFolder(newFolderName.trim());
    setNewFolder(false);
    setNewFolderName('');
  };

  const allTalks = state.folders.flatMap((f) => f.talkIds.map((id) => ({ ...state.talks[id], folder: f })))
    .concat(state.looseIds.map((id) => state.talks[id]).filter(Boolean));
  const filteredTalks = q
    ? allTalks.filter((t) => t.title.toLowerCase().includes(q.toLowerCase()))
    : null;
  const sumStreaming = allTalks.filter((t) => t.running).length;
  const inboxCount = state.looseIds.length;

  return (
    <div className="w-[260px] flex flex-col h-full shrink-0 border-r"
      style={{ background: S.paper, borderColor: S.line }}>
      {/* Header */}
      <div className="px-4 pt-4 pb-3 flex items-center justify-between">
        <div>
          <div className="font-serif text-[18px] leading-none" style={{ color: S.ink }}>Talks</div>
          <div className="text-[11px] mt-1" style={{ color: S.ink2 }}>
            {allTalks.length} active · {sumStreaming} streaming
          </div>
        </div>
        <button ref={plusBtnRef} onClick={onPlus}
          className="w-7 h-7 rounded-lg grid place-items-center"
          style={{ background: S.card, border: `1px solid ${S.line}`, color: S.ink }}
          title="New Talk or folder">
          <CTIcon name="plus" size={14} strokeWidth={1.8} />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pb-3">
        <button
          onClick={() => setShowCmdK(true)}
          className="flex items-center gap-2 px-2.5 h-8 rounded-lg w-full text-left"
          style={{ background: S.card, border: `1px solid ${S.line}` }}>
          <CTIcon name="search" size={13} stroke={S.ink2} />
          <input
            value={q}
            onChange={(e) => { e.stopPropagation(); setQ(e.target.value); }}
            onClick={(e) => e.stopPropagation()}
            placeholder="Search talks"
            className="bg-transparent outline-none text-[12.5px] flex-1"
            style={{ color: S.ink }}
          />
          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded" style={{ background: S.paper2, color: S.ink2 }}>⌘K</span>
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-2 ct-thin-scroll pb-2">
        {filteredTalks ? (
          <div className="mb-3">
            <div className="px-2 py-1 text-[10.5px] uppercase tracking-[0.14em] font-medium" style={{ color: S.ink2 }}>
              Search · {filteredTalks.length}
            </div>
            {filteredTalks.map((t) => <TalkRow key={t.id} talk={t} app={app} />)}
          </div>
        ) : (
          <>
            {newFolder ? (
              <div className="mb-2 px-2 py-1.5 flex items-center gap-2 rounded-lg" style={{ background: S.card, border: `1px solid ${S.accent}55` }}>
                <CTIcon name="folder" size={12} stroke={S.ink2} />
                <input
                  ref={newFolderInputRef}
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitNewFolder(); if (e.key === 'Escape') { setNewFolder(false); setNewFolderName(''); } }}
                  onBlur={commitNewFolder}
                  placeholder="Folder name…"
                  className="bg-transparent outline-none text-[12.5px] flex-1"
                  style={{ color: S.ink }}
                />
              </div>
            ) : null}
            {state.folders.map((f) => (
              <div key={f.id} className="mb-3 group/folder">
                <div className="flex items-center group/folderhdr">
                  <button className="flex items-center gap-1 flex-1 px-2 py-1 text-[10.5px] uppercase tracking-[0.14em] font-medium text-left"
                    style={{ color: S.ink2 }}>
                    <CTIcon name="chevron-d" size={11} strokeWidth={2} />
                    {f.title}
                    <span className="ml-1 font-mono" style={{ color: S.ink2, opacity: 0.7 }}>{f.talkIds.length}</span>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setFolderDeleteDialog({ folderId: f.id }); }}
                    className="w-5 h-5 grid place-items-center rounded opacity-0 group-hover/folderhdr:opacity-100 transition-opacity"
                    style={{ color: S.ink2 }} title={`Delete ${f.title}`}>
                    <CTIcon name="more" size={11} />
                  </button>
                </div>
                <div className="mt-0.5">
                  {f.talkIds.map((id) => {
                    const t = state.talks[id];
                    return t ? <TalkRow key={id} talk={t} app={app} /> : null;
                  })}
                  {f.talkIds.length === 0 ? (
                    <div className="pl-5 pr-2 py-1.5 text-[11px] italic" style={{ color: S.ink2, opacity: 0.65 }}>(empty)</div>
                  ) : null}
                </div>
              </div>
            ))}
            {inboxCount > 0 ? (
              <div className="mb-3 mt-2 pt-3 border-t" style={{ borderColor: S.line + 'AA' }}>
                <div className="px-2 py-1 flex items-center gap-1.5">
                  <CTIcon name="folder" size={11} stroke={S.ink2 + '88'} strokeWidth={1.6} />
                  <span className="text-[10.5px] uppercase tracking-[0.14em] italic" style={{ color: S.ink2 + 'AA' }}>Inbox</span>
                  <span className="font-mono text-[10.5px]" style={{ color: S.ink2 + 'AA' }}>{inboxCount}</span>
                </div>
                {state.looseIds.map((id) => {
                  const t = state.talks[id];
                  return t ? <TalkRow key={id} talk={t} app={app} /> : null;
                })}
              </div>
            ) : null}
          </>
        )}
      </div>

      {plusMenuOpen ? (
        <SidebarPlusMenu
          anchorRect={plusRect}
          onClose={() => setPlusMenuOpen(false)}
          onNewTalk={() => { setPlusMenuOpen(false); setShowNewTalkSheet(true); }}
          onNewFolder={() => { setPlusMenuOpen(false); setNewFolder(true); }}
        />
      ) : null}
    </div>
  );
}

function TalkRow({ talk, app }) {
  const on = talk.id === app.state.activeTalkId && app.route === 'talk';
  return (
    <button
      onClick={() => app.setActiveTalk(talk.id)}
      className="flex items-center gap-2 pl-5 pr-2 h-8 rounded-lg w-full text-left transition-colors"
      style={{
        background: on ? S.card : 'transparent',
        boxShadow: on ? `inset 0 0 0 1px ${S.line}` : 'none',
      }}>
      {talk.running
        ? <span className="w-1.5 h-1.5 rounded-full ct-pulse" style={{ background: S.accent, boxShadow: `0 0 0 3px ${S.paper2}` }} />
        : <span className="w-1.5 h-1.5 rounded-full" style={{ background: S.line }} />}
      <span className={`flex-1 truncate text-[13px] ${talk.running ? 'italic' : ''}`}
        style={{ color: on ? S.ink : S.ink2 }}>{talk.title}</span>
      {talk.hasDoc ? <CTIcon name="doc" size={11} stroke={S.ink2} /> : null}
      {talk.unread ? (
        <span className="text-[10px] font-medium rounded-full px-1.5 py-0.5"
          style={{ background: S.accent, color: '#FFF' }}>{talk.unread}</span>
      ) : null}
    </button>
  );
}

function ProfileCard() {
  const { state, setRoute } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative m-3 mt-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full p-2 flex items-center gap-2.5 rounded-xl text-left transition-colors"
        style={{ background: open ? S.paper2 : S.card, border: `1px solid ${S.line}` }}>
        <Avatar initials={state.user.initials} color={state.user.avatarColor} size={32} />
        <div className="min-w-0 flex-1">
          <div className="font-serif text-[13px] leading-tight truncate" style={{ color: S.ink }}>{state.user.name}</div>
          <div className="text-[10.5px] truncate" style={{ color: S.ink2 }}>{state.user.email}</div>
        </div>
        <CTIcon name="more" size={14} stroke={S.ink2} />
      </button>

      {open ? (
        <div className="absolute left-0 right-0 bottom-full mb-1.5 rounded-xl overflow-hidden ct-screen-enter"
          style={{ background: S.card, border: `1px solid ${S.line}`, boxShadow: '0 20px 40px rgba(31,27,22,0.12)' }}>
          <button
            onClick={() => { setOpen(false); setRoute('settings'); }}
            className="w-full px-3 py-2 flex items-center gap-2 text-[13px] text-left hover:bg-[var(--salon-paper-2)]"
            style={{ color: S.ink }}>
            <CTIcon name="settings" size={14} stroke={S.ink2} /> Settings
          </button>
          <button
            onClick={() => { setOpen(false); }}
            className="w-full px-3 py-2 flex items-center gap-2 text-[13px] text-left hover:bg-[var(--salon-paper-2)]"
            style={{ color: S.ink }}>
            <CTIcon name="sparkle" size={14} stroke={S.ink2} /> Invite people
          </button>
          <button
            onClick={() => { setOpen(false); }}
            className="w-full px-3 py-2 flex items-center gap-2 text-[13px] text-left hover:bg-[var(--salon-paper-2)]"
            style={{ color: S.ink }}>
            <CTIcon name="bolt" size={14} stroke={S.ink2} /> What\u2019s new
          </button>
          <div className="h-px" style={{ background: S.line }} />
          <button
            onClick={() => { setOpen(false); useApp().setRoute('signin'); }}
            className="w-full px-3 py-2 flex items-center gap-2 text-[13px] text-left hover:bg-[var(--salon-paper-2)]"
            style={{ color: '#A8434A' }}>
            <CTIcon name="logout" size={14} stroke="#A8434A" /> Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ─── top bar (in talk + home) ───────────────────────────────────────────

function TopBar({ left, right }) {
  return (
    <div className="h-14 px-7 flex items-center justify-between border-b shrink-0"
      style={{ borderColor: S.line, background: S.paper }}>
      <div className="flex items-center gap-3 text-[13px] min-w-0" style={{ color: S.ink2 }}>{left}</div>
      <div className="flex items-center gap-2 shrink-0">{right}</div>
    </div>
  );
}

// ─── composer ───────────────────────────────────────────────────────────

function Composer({ compact = false }) {
  const { state, setComposerText, sendMessage, toggleTarget, activeTalk } = useApp();
  const ref = useRef(null);
  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      sendMessage(state.composerText);
    }
  };
  return (
    <div className="px-7 pb-6 pt-2 shrink-0" style={{ background: S.paper }}>
      <div className="rounded-2xl p-3"
        style={{ background: S.card, border: `1px solid ${S.line}`, boxShadow: '0 4px 24px rgba(31,27,22,0.05)' }}>
        {/* Targets */}
        <div className="flex items-center gap-1.5 flex-wrap mb-2">
          <span className="text-[11px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>Address to</span>
          {(activeTalk?.agents || []).map((id) => {
            const a = CT_AGENTS.find((x) => x.id === id);
            if (!a) return null;
            const on = state.composerTargets.includes(id);
            return (
              <button key={id} onClick={() => toggleTarget(id)}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11.5px] transition-colors"
                style={{
                  background: on ? S.paper2 : S.paper,
                  color: on ? S.ink : S.ink2,
                  border: `1px solid ${S.line}`,
                  opacity: on ? 1 : 0.55,
                }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: a.accent }} />
                {a.name}
              </button>
            );
          })}
          <button className="inline-flex items-center gap-1 text-[11.5px] px-2 py-0.5 rounded-full"
            style={{ color: S.ink2, border: `1px dashed ${S.line}` }}>
            <CTIcon name="plus" size={11} stroke={S.ink2} strokeWidth={2} /> Add agent
          </button>
          <div className="ml-auto flex items-center gap-1.5">
            <Chip>{state.composerMode}</Chip>
            <Chip tone="ghost">{state.composerRounds} rounds</Chip>
          </div>
        </div>

        {/* Input */}
        <div className="px-1">
          <textarea
            ref={ref}
            value={state.composerText}
            onChange={(e) => setComposerText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask the room… Use @name to direct at one agent. ⌘+Enter sends."
            className="w-full bg-transparent outline-none resize-none font-serif text-[16px] leading-[1.55]"
            style={{ color: S.ink, minHeight: compact ? 60 : 92 }}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-1.5 px-1">
          <div className="flex items-center gap-1">
            <button className="w-8 h-8 grid place-items-center rounded-lg" style={{ color: S.ink2 }} title="Attach"><CTIcon name="paperclip" size={15} /></button>
            <button className="w-8 h-8 grid place-items-center rounded-lg" style={{ color: S.ink2 }} title="Voice"><CTIcon name="mic" size={15} /></button>
            <button className="w-8 h-8 grid place-items-center rounded-lg" style={{ color: S.ink2 }} title="Prompt library"><CTIcon name="sparkle" size={15} /></button>
            <div className="w-px h-4 mx-1" style={{ background: S.line }} />
            <ComposerToolsSummary />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono" style={{ color: S.ink2 }}>⌘ + Enter</span>
            <button
              onClick={() => sendMessage(state.composerText)}
              disabled={!state.composerText.trim()}
              className="h-9 px-4 rounded-full text-[13px] font-medium text-white inline-flex items-center gap-1.5 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: S.accent }}>
              Send to room <CTIcon name="send" size={13} stroke="#FFF" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── messages ───────────────────────────────────────────────────────────

function UserMessage({ m }) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-4 pt-7 pb-5 ct-screen-enter">
      <div className="flex justify-end pt-1">
        <Avatar initials={m.initials} color={m.avatarColor} size={40} />
      </div>
      <div className="max-w-[680px]">
        <div className="flex items-baseline gap-2 mb-2">
          <span className="font-serif text-[16px]" style={{ color: S.ink }}>{m.author}</span>
          <span className="text-[11px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>{m.time}</span>
          <Chip tone="ghost">@all-agents</Chip>
        </div>
        <div className="font-serif text-[16.5px] leading-[1.65]" style={{ color: S.ink }}>{m.text}</div>
        {m.attachments?.length ? (
          <div className="mt-3 flex gap-2 flex-wrap">
            {m.attachments.map((a) => (
              <div key={a.name} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg"
                style={{ background: S.card, border: `1px solid ${S.line}` }}>
                <CTIcon name="doc" size={13} stroke={S.ink2} />
                <span className="text-[12px]" style={{ color: S.ink }}>{a.name}</span>
                <span className="text-[10.5px] font-mono" style={{ color: S.ink2 }}>{a.meta}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AgentMessage({ m }) {
  const agent = CT_AGENTS.find((a) => a.id === m.agentId);
  if (!agent) return null;
  const streaming = m.runStatus === 'running';
  const queued = m.runStatus === 'queued';
  const cancelled = m.runStatus === 'cancelled';

  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-4 py-5 group">
      <div className="flex justify-end pt-1"><AgentAvatar agent={agent} size={40} /></div>
      <div className="max-w-[680px] pl-4 -ml-4"
        style={{ borderLeft: `2px solid ${streaming ? agent.accent : S.line}` }}>
        {/* Byline */}
        <div className="flex items-center flex-wrap gap-x-2 gap-y-1 mb-2">
          <span className="font-serif text-[16px] font-medium" style={{ color: S.ink }}>{agent.name}</span>
          <span className="text-[11.5px] font-mono" style={{ color: S.ink2 }}>{agent.handle}</span>
          <span className="text-[11.5px] font-mono px-1.5 py-px rounded" style={{ background: S.paper2, color: S.ink2 }}>{agent.model}</span>
          <RunPill status={m.runStatus} />
          {m.time ? <span className="text-[11px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>{m.time}</span> : null}
          {m.tokens ? <span className="text-[11px] font-mono ml-auto" style={{ color: S.ink2 }}>
            {m.tokens.in.toLocaleString()} in · {m.tokens.out} out
          </span> : null}
        </div>

        {/* Body */}
        {queued ? (
          <div className="rounded-lg px-3 py-2.5 text-[13px] flex items-center gap-2"
            style={{ background: S.paper2, border: `1px dashed ${S.line}`, color: S.ink2 }}>
            <CTIcon name="pause" size={12} stroke={S.ink2} />
            Waiting in queue · position {m.queuePosition || 1}
          </div>
        ) : streaming ? (
          <div>
            <p className="font-serif text-[16px] leading-[1.7]" style={{ color: S.ink }}>
              {m.streamingText || ''}
              <span className="ct-caret" style={{ color: agent.accent }} />
            </p>
            <div className="mt-2 text-[12px] font-mono inline-flex items-center gap-2" style={{ color: agent.accent }}>
              <span className="w-1.5 h-1.5 rounded-full ct-pulse" style={{ background: agent.accent }} />
              {m.progress || 'Composing'}
            </div>
          </div>
        ) : cancelled ? (
          <div className="font-serif text-[15px] italic" style={{ color: S.ink2 }}>
            {m.text}
          </div>
        ) : (
          <p className="font-serif text-[16px] leading-[1.7]" style={{ color: S.ink }} dangerouslySetInnerHTML={{
            __html: (m.text || '')
              .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
              .replace(/\*(.+?)\*/g, '<em>$1</em>'),
          }} />
        )}

        {/* Hover actions */}
        {!queued && !streaming && !cancelled ? (
          <div className="mt-2.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {['Reply to this','Pin','Copy','More'].map((l) => (
              <button key={l} className="text-[11.5px] px-2 py-1 rounded hover:bg-[var(--salon-paper-2)]" style={{ color: S.ink2 }}>{l}</button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── doc tab strip ────────────────────────────────────────────────────
// Compact, horizontal "document tabs" (Google-Docs style, no extra sidebar).
// Click to switch · "+" to add · double-click to rename · ✕ (on hover) to delete.

function DocTabStrip({ doc, activeTabId, onSwitch, onAdd, onRename, onDelete }) {
  const tabs = CT_docTabs(doc);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');

  const startRename = (t) => { setEditingId(t.id); setDraft(t.title); };
  const commit = () => { if (editingId) onRename(editingId, draft); setEditingId(null); };

  return (
    <div className="flex items-stretch gap-1 pl-3 pr-2 pt-2 border-b shrink-0"
      style={{ borderColor: S.line, background: S.paper2 }}>
      <div className="flex-1 min-w-0 flex items-stretch gap-1 overflow-x-auto ct-thin-scroll">
        {tabs.map((t) => {
          const active = t.id === activeTabId;
          const pending = (t.blocks || []).filter((b) => b.pending).length;
          return (
            <div key={t.id}
              onClick={() => onSwitch(t.id)}
              onDoubleClick={() => startRename(t)}
              title={t.title}
              className="group/tab relative flex items-center gap-1.5 h-9 px-2.5 rounded-t-lg cursor-pointer select-none shrink-0 transition-colors"
              style={active
                ? { background: S.card, border: `1px solid ${S.line}`, borderBottomColor: S.card, marginBottom: -1, color: S.ink, boxShadow: '0 -1px 4px rgba(31,27,22,0.05)' }
                : { background: 'transparent', color: S.ink2 }}>
              <CTIcon name="doc" size={12} stroke={active ? S.accent : S.ink2} strokeWidth={active ? 1.9 : 1.6} />
              {editingId === t.id ? (
                <input autoFocus value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditingId(null); }}
                  onClick={(e) => e.stopPropagation()}
                  className="bg-transparent outline-none text-[12.5px] font-serif w-[96px]"
                  style={{ color: S.ink, borderBottom: `1px solid ${S.accent}` }} />
              ) : (
                <span className="text-[12.5px] font-serif truncate"
                  style={{ maxWidth: 116, fontWeight: active ? 500 : 400 }}>{t.title}</span>
              )}
              {pending ? <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: S.accent }} title={`${pending} pending`} /> : null}
              {active && tabs.length > 1 && editingId !== t.id ? (
                <button onClick={(e) => { e.stopPropagation(); onDelete(t.id); }}
                  title="Delete tab"
                  className="ml-0.5 w-4 h-4 grid place-items-center rounded opacity-0 group-hover/tab:opacity-100 transition-opacity shrink-0 hover:bg-[var(--salon-paper-2)]"
                  style={{ color: S.ink2 }}>
                  <CTIcon name="x" size={11} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <button onClick={onAdd} title="Add tab"
        className="shrink-0 w-8 h-8 self-center grid place-items-center rounded-lg transition-colors hover:bg-[var(--salon-card)]"
        style={{ color: S.ink2, border: `1px solid ${S.line}`, background: 'transparent' }}>
        <CTIcon name="plus" size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

// ─── doc pane ───────────────────────────────────────────────────────────

function DocResizeHandle({ width, setWidth }) {
  const [active, setActive] = useState(false);
  const onPointerDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    setActive(true);
    const onMove = (ev) => {
      // Dragging left grows the doc pane; dragging right shrinks it.
      const next = Math.min(980, Math.max(360, startW + (startX - ev.clientX)));
      setWidth(next);
    };
    const onUp = () => {
      setActive(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={() => setWidth(560)}
      title="Drag to resize · double-click to reset"
      className="ct-doc-resizer relative shrink-0 flex items-center justify-center ct-screen-enter"
      style={{ width: 10, cursor: 'col-resize', marginRight: -1, zIndex: 5 }}>
      <div
        className="ct-doc-resizer-bar rounded-full transition-all"
        style={{
          width: active ? 4 : 3,
          height: active ? 56 : 36,
          background: active ? S.accent : S.line,
          opacity: active ? 1 : 0,
        }}
      />
      <style>{`.ct-doc-resizer:hover .ct-doc-resizer-bar { opacity: 1 !important; background: ${S.accent} !important; }`}</style>
    </div>
  );
}

function DocPane({ width = 560 }) {
  const { activeDoc, activeDocTabId, activeDocTab, toggleDoc, acceptDocEdits, rejectDocEdits,
    setDocTab, addDocTab, renameDocTab, deleteDocTab } = useApp();
  if (!activeDoc) return null;
  const tab = activeDocTab || {};
  const blocks = tab.blocks || [];
  const pendingCount = blocks.filter((b) => b.pending).length;
  const coNames = (tab.coEditors || []).map((id) => (CT_AGENTS.find((a) => a.id === id) || {}).name).filter(Boolean);
  const fmt = activeDoc.format === 'html' ? 'HTML' : 'Markdown';
  const metaLine = coNames.length ? `${fmt} · co-edited by ${coNames.join(', ')}` : fmt;

  return (
    <div className="shrink-0 flex flex-col h-full border-l ct-screen-enter"
      style={{ width, background: S.paper2, borderColor: S.line }}>
      <div className="px-5 h-14 flex items-center gap-3 border-b shrink-0" style={{ borderColor: S.line }}>
        <CTIcon name="doc" size={14} stroke={S.ink2} />
        <div className="flex-1 min-w-0">
          <div className="font-serif text-[15px] leading-none truncate" style={{ color: S.ink }}>{activeDoc.title}</div>
          <div className="text-[10.5px] font-mono mt-1 truncate" style={{ color: S.ink2 }}>
            {metaLine}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {window.CT_FORGE_ENABLED ? (
            <button onClick={() => window.dispatchEvent(new CustomEvent('ct-forge-open'))}
              title="Improve this document with Forge"
              className="h-7 pl-2 pr-2.5 rounded-lg text-[11.5px] inline-flex items-center gap-1.5 font-medium text-white mr-1"
              style={{ background: S.accent }}>
              <ForgeMark size={13} accent="#FFF" /> Improve
            </button>
          ) : null}
          {['MD','HTML'].map((p, i) => (
            <span key={p} className="text-[10.5px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: i === 0 ? S.accent : S.card, color: i === 0 ? '#FFF' : S.ink2, border: i === 0 ? 'none' : `1px solid ${S.line}` }}>{p}</span>
          ))}
        </div>
        <button onClick={toggleDoc} className="w-7 h-7 grid place-items-center rounded-lg" style={{ color: S.ink2 }}>
          <CTIcon name="x" size={14} />
        </button>
      </div>

      <DocTabStrip
        doc={activeDoc}
        activeTabId={activeDocTabId}
        onSwitch={(tid) => setDocTab(activeDoc.id, tid)}
        onAdd={() => addDocTab(activeDoc.id)}
        onRename={(tid, title) => renameDocTab(activeDoc.id, tid, title)}
        onDelete={(tid) => deleteDocTab(activeDoc.id, tid)}
      />

      <div className="flex-1 overflow-y-auto ct-thin-scroll">
        <div className="px-8 py-7">
          {blocks.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-16 gap-3">
              <div className="w-11 h-11 rounded-full grid place-items-center" style={{ background: S.paper2, border: `1px solid ${S.line}` }}>
                <CTIcon name="doc" size={18} stroke={S.ink2} />
              </div>
              <div className="font-serif text-[16px]" style={{ color: S.ink }}>This tab is empty</div>
              <div className="text-[12.5px] max-w-[260px]" style={{ color: S.ink2 }}>
                Start writing, or ask the room to draft into this tab. Each tab is its own section of the document.
              </div>
            </div>
          ) : blocks.map((b) => {
            if (b.kind === 'h1') return <h1 key={b.id} className="font-serif text-[30px] leading-tight tracking-tight mb-1" style={{ color: S.ink }}>{b.text}</h1>;
            if (b.kind === 'meta') return <div key={b.id} className="text-[11px] font-mono uppercase tracking-widest mb-5" style={{ color: S.ink2 }}>{b.text}</div>;
            if (b.kind === 'h2') return <h2 key={b.id} className="font-serif text-[18px] mt-5 mb-2" style={{ color: S.ink }}>{b.text}</h2>;
            if (b.kind === 'p')  return <p key={b.id} className="font-serif text-[14.5px] leading-[1.7] mb-3" style={{ color: S.ink }}>{b.text}</p>;
            if (b.kind === 'li') {
              const pending = b.pending;
              return (
                <div key={b.id} className="flex gap-2 py-1.5 transition-all"
                  style={pending ? { background: 'rgba(200,100,58,0.08)', borderLeft: `2px solid ${S.accent}`, paddingLeft: 8, marginLeft: -10, borderRadius: 4 } : {}}>
                  <span className="font-serif" style={{ color: pending ? S.accent : S.ink2 }}>•</span>
                  <span className="font-serif text-[14px] leading-[1.65] flex-1" style={{ color: S.ink }}>
                    {b.text}
                    {pending ? (
                      <span className="ml-2 align-middle inline-block text-[10px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded"
                        style={{ background: S.accent, color: '#FFF' }}>
                        Editor · pending
                      </span>
                    ) : null}
                  </span>
                </div>
              );
            }
            return null;
          })}
        </div>
      </div>

      {pendingCount > 0 ? (
        <div className="px-5 py-3.5 border-t flex items-center gap-3 shrink-0 ct-screen-enter"
          style={{ borderColor: S.line, background: S.paper }}>
          <CTIcon name="sparkle" size={14} stroke={S.accent} />
          <div className="flex-1 text-[12.5px]" style={{ color: S.ink }}>
            <span className="font-medium">{pendingCount} pending edit{pendingCount !== 1 ? 's' : ''}</span> from <span className="italic">Editor</span>.
          </div>
          <button onClick={rejectDocEdits}
            className="h-7 px-2.5 text-[11.5px] rounded-md hover:bg-[var(--salon-paper-2)]"
            style={{ color: S.ink2, border: `1px solid ${S.line}` }}>Reject all</button>
          <button onClick={acceptDocEdits}
            className="h-7 px-2.5 text-[11.5px] rounded-md text-white"
            style={{ background: S.accent }}>Accept &amp; continue</button>
        </div>
      ) : (
        <div className="px-5 py-3 border-t flex items-center gap-2 shrink-0"
          style={{ borderColor: S.line, background: S.paper }}>
          <CTIcon name="check" size={13} stroke="#3F6B5C" />
          <div className="text-[12px]" style={{ color: S.ink2 }}>All edits applied · clean</div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, {
  S, Avatar, AgentAvatar, RunPill, Chip, Kbd,
  IconRail, ProfileMenu, SecondaryList, TopBar, Composer, UserMessage, AgentMessage, DocPane, DocResizeHandle, DocTabStrip,
});

// Read-only summary of the talk's enabled tools, shown in the composer footer.
function ComposerToolsSummary() {
  const { state, activeTalk } = useApp();
  const tools = effectiveTools(state, activeTalk);
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11.5px]"
      style={{ color: S.ink2 }}
      title="Tools the room can use — change in the header">
      <CTIcon name="bolt" size={12} stroke={S.ink2} strokeWidth={1.8} />
      <ToolGlyphs tools={tools} />
    </span>
  );
}

Object.assign(window, { ComposerToolsSummary });
