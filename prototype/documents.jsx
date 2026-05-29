/* eslint-disable */
// Documents screen — dense table view (Operator-flavored, light palette)
// + a full-bleed single-doc editor.

// ─── helpers ─────────────────────────────────────────────────────────

function docWordCount(doc) {
  return CT_docWordCount(doc);
}

function FormatBadge({ format }) {
  const map = {
    md:   { bg: S.accent,  fg: '#FFF',  label: 'MD'   },
    html: { bg: '#3D5688', fg: '#FFF',  label: 'HTML' },
    txt:  { bg: S.paper2,  fg: S.ink,   label: 'TXT'  },
  };
  const m = map[format] || map.md;
  return (
    <span className="inline-flex items-center justify-center font-mono text-[10px] font-medium rounded px-1.5 py-0.5"
      style={{ background: m.bg, color: m.fg, minWidth: 36 }}>
      {m.label}
    </span>
  );
}

// ─── DocumentsScreen — the table ─────────────────────────────────────

function DocumentsScreen() {
  const { state, setRoute, setShowCmdK, setSelectedDoc, setActiveTalk } = useApp();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ key: 'lastEditTs', dir: 'desc' });

  const docs = Object.values(state.docs || {});
  let rows = docs.map((d) => {
    const linked = d.talkId ? state.talks[d.talkId] : null;
    return {
      ...d,
      words: docWordCount(d),
      folder: d.folder || linked?.folder || null,
      linkedTalk: linked,
    };
  });

  if (q.trim()) {
    const ql = q.toLowerCase();
    rows = rows.filter((r) =>
      r.title.toLowerCase().includes(ql) ||
      (r.folder || '').toLowerCase().includes(ql) ||
      (r.linkedTalk?.title || '').toLowerCase().includes(ql)
    );
  }

  rows.sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : (av - bv);
    return sort.dir === 'asc' ? cmp : -cmp;
  });

  const toggleSort = (key) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }));

  return (
    <div className="flex h-screen" style={{ background: S.paper, color: S.ink }}>
      <IconRail
        active="docs"
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
            <CTIcon name="doc" size={14} />
            <span style={{ color: S.ink }}>Documents</span>
            <span>·</span>
            <span>{docs.length} total · {docs.filter((d) => d.talkId).length} linked to a Talk</span>
          </>}
          right={<>
            <div className="flex items-center gap-2 h-8 px-2.5 rounded-lg" style={{ background: S.card, border: `1px solid ${S.line}` }}>
              <CTIcon name="search" size={13} stroke={S.ink2} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter by title, folder, or linked Talk"
                className="bg-transparent outline-none text-[12.5px] w-[280px]"
                style={{ color: S.ink }}
              />
            </div>
            <button className="h-8 px-3 rounded-lg text-[12.5px] font-medium text-white inline-flex items-center gap-1.5"
              style={{ background: S.accent }}>
              <CTIcon name="plus" size={13} stroke="#FFF" strokeWidth={2} /> New document
            </button>
          </>}
        />

        <div className="flex-1 overflow-y-auto px-9 py-7 ct-thin-scroll">
          <div className="max-w-[1320px] mx-auto">

            {/* Header */}
            <div className="mb-7">
              <div className="text-[11px] font-mono uppercase tracking-[0.18em]" style={{ color: S.ink2 }}>Workspace · Oxbow & Co.</div>
              <h1 className="font-serif text-[36px] leading-[1.05] tracking-tight mt-1" style={{ color: S.ink }}>
                Documents
              </h1>
              <p className="text-[14px] mt-2 max-w-[660px]" style={{ color: S.ink2 }}>
                Every doc your agents have touched. A doc can live on its own, or be linked to one Talk that owns it.
              </p>
            </div>

            {/* Stats strip */}
            <div className="grid grid-cols-4 gap-3 mb-7">
              {[
                { l: 'Documents',    v: String(docs.length),                                     sub: `${docs.filter((d) => d.talkId).length} linked · ${docs.filter((d) => !d.talkId).length} loose` },
                { l: 'Words',        v: docs.reduce((n, d) => n + docWordCount(d), 0).toLocaleString(), sub: 'across all docs' },
                { l: 'Pending edits',v: String(docs.reduce((n, d) => n + CT_docPending(d), 0)), sub: 'awaiting your review' },
                { l: 'Last activity',v: '14 s',                                                  sub: 'pricing-v2-draft.md' },
              ].map((s) => (
                <div key={s.l} className="rounded-2xl p-4" style={{ background: S.card, border: `1px solid ${S.line}` }}>
                  <div className="text-[10.5px] font-mono uppercase tracking-[0.18em]" style={{ color: S.ink2 }}>{s.l}</div>
                  <div className="font-serif text-[26px] leading-none tracking-tight mt-1.5" style={{ color: S.ink }}>{s.v}</div>
                  <div className="text-[11.5px] mt-2" style={{ color: S.ink2 }}>{s.sub}</div>
                </div>
              ))}
            </div>

            {/* Table */}
            <div className="rounded-2xl overflow-hidden" style={{ background: S.card, border: `1px solid ${S.line}` }}>
              <DocTableHeader sort={sort} toggleSort={toggleSort} />
              {rows.length === 0 ? (
                <div className="px-4 py-10 text-center text-[13px]" style={{ color: S.ink2 }}>
                  No docs match <span className="font-mono">"{q}"</span>.
                </div>
              ) : rows.map((d) => (
                <DocRow key={d.id} doc={d} onOpen={() => setSelectedDoc(d.id)} onOpenTalk={(id) => setActiveTalk(id)} />
              ))}
            </div>

            <div className="text-center text-[11.5px] py-5" style={{ color: S.ink2 }}>
              {rows.length} of {docs.length} shown · sorted by <span className="font-mono">{sort.key}</span> {sort.dir}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Column widths kept consistent between header and rows.
const DOC_COLS = {
  title:      'flex-1 min-w-0',
  format:     'w-[64px] shrink-0',
  folder:     'w-[180px] shrink-0',
  talk:       'w-[240px] shrink-0',
  activity:   'w-[120px] shrink-0',
  words:      'w-[72px] shrink-0 text-right',
  more:       'w-[36px] shrink-0',
};

function DocTableHeader({ sort, toggleSort }) {
  const Col = ({ k, label, cls, sortable = true }) => (
    <button
      onClick={() => sortable && toggleSort(k)}
      disabled={!sortable}
      className={`${cls} text-left inline-flex items-center gap-1 text-[11px] font-mono uppercase tracking-[0.16em] ${sortable ? 'cursor-pointer' : 'cursor-default'}`}
      style={{ color: S.ink2 }}>
      {label}
      {sortable && sort.key === k ? <span style={{ color: S.ink }}>{sort.dir === 'desc' ? '↓' : '↑'}</span> : null}
    </button>
  );
  return (
    <div className="h-10 px-4 flex items-center gap-3 border-b" style={{ borderColor: S.line }}>
      <Col k="title"      label="Title"          cls={DOC_COLS.title} />
      <Col k="format"     label="Fmt"            cls={DOC_COLS.format} />
      <Col k="folder"     label="Folder"         cls={DOC_COLS.folder} />
      <Col k="talkId"     label="Linked Talk"    cls={DOC_COLS.talk} sortable={false} />
      <Col k="lastEditTs" label="Last activity"  cls={DOC_COLS.activity} />
      <Col k="words"      label="Words"          cls={DOC_COLS.words} />
      <span className={DOC_COLS.more} />
    </div>
  );
}

function DocRow({ doc, onOpen, onOpenTalk }) {
  const pendingCount = CT_docPending(doc);
  const tabCount = CT_docTabs(doc).length;
  return (
    <div className="h-12 px-4 flex items-center gap-3 border-b last:border-0 group hover:bg-[var(--salon-paper-2)] transition-colors cursor-pointer"
      style={{ borderColor: S.line, color: S.ink }}
      onClick={onOpen}>
      <div className={`${DOC_COLS.title} flex items-center gap-2 min-w-0`}>
        <CTIcon name="doc" size={13} stroke={S.ink2} />
        <span className="font-mono text-[13px] truncate" style={{ color: S.ink }}>{doc.title}</span>
        {tabCount > 1 ? (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 inline-flex items-center gap-1"
            style={{ background: S.paper2, color: S.ink2, border: `1px solid ${S.line}` }}
            title={`${tabCount} tabs`}>
            {tabCount} tabs
          </span>
        ) : null}
        {pendingCount > 0 ? (
          <span className="text-[10px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded shrink-0"
            style={{ background: S.accent, color: '#FFF' }}>
            {pendingCount} pending
          </span>
        ) : null}
      </div>
      <span className={DOC_COLS.format}><FormatBadge format={doc.format} /></span>
      <span className={`${DOC_COLS.folder} text-[12.5px] truncate`} style={{ color: doc.folder ? S.ink2 : S.ink2 + '88' }}>
        {doc.folder || '— Inbox'}
      </span>
      <span className={DOC_COLS.talk}>
        {doc.linkedTalk ? (
          <button onClick={(e) => { e.stopPropagation(); onOpenTalk(doc.linkedTalk.id); }}
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11.5px] max-w-full"
            style={{ background: S.paper, color: S.ink, border: `1px solid ${S.line}` }}>
            <CTIcon name="chat" size={10} stroke={S.ink2} />
            <span className="truncate">{doc.linkedTalk.title}</span>
          </button>
        ) : (
          <span className="text-[12px]" style={{ color: S.ink2 + '99' }}>— unlinked</span>
        )}
      </span>
      <span className={`${DOC_COLS.activity} font-mono text-[11.5px]`} style={{ color: S.ink2 }}>{doc.lastEdit || '—'}</span>
      <span className={`${DOC_COLS.words} font-mono text-[12.5px]`} style={{ color: S.ink }}>{doc.words.toLocaleString()}</span>
      <button onClick={(e) => e.stopPropagation()} className={`${DOC_COLS.more} w-9 h-7 grid place-items-center rounded text-[11px]`} style={{ color: S.ink2 }}>
        <CTIcon name="more" size={14} />
      </button>
    </div>
  );
}

// ─── DocEditorScreen — full-bleed single doc ─────────────────────────

function DocEditorScreen() {
  const { state, setRoute, setSelectedDoc, setActiveTalk, setShowCmdK, acceptDocEdits, rejectDocEdits,
    setDocTab, addDocTab, renameDocTab, deleteDocTab } = useApp();
  const id = state.selectedDocId;
  const doc = state.docs[id];
  if (!doc) return <div className="p-12">Document not found.</div>;
  const linkedTalk = doc.talkId ? state.talks[doc.talkId] : null;
  const tabId = CT_docActiveTabId(state, doc);
  const tab = CT_activeDocTab(state, doc) || {};
  const blocks = tab.blocks || [];
  const coEditors = (tab.coEditors && tab.coEditors.length) ? tab.coEditors : (doc.coEditors || []);
  const pending = blocks.filter((b) => b.pending).length;

  return (
    <div className="flex h-screen" style={{ background: S.paper, color: S.ink }}>
      <IconRail
        active="docs"
        onNav={(id2) => {
          if (id2 === 'home') setRoute('home');
          else if (id2 === 'talks') setRoute('talk');
          else if (id2 === 'agents') setRoute('agents');
          else if (id2 === 'docs') { setSelectedDoc(null); setRoute('documents'); }
          else setRoute('home');
        }}
        onCmdK={() => setShowCmdK(true)}
      />

      <div className="flex-1 min-w-0 flex flex-col ct-screen-enter">
        <TopBar
          left={<>
            <button onClick={() => { setSelectedDoc(null); setRoute('documents'); }} className="inline-flex items-center gap-1" style={{ color: S.ink2 }}>
              <CTIcon name="chevron-r" size={12} stroke={S.ink2} /> Documents
            </button>
            <span>·</span>
            <span className="font-mono" style={{ color: S.ink }}>{doc.title}</span>
            <FormatBadge format={doc.format} />
            {linkedTalk ? (
              <>
                <span>·</span>
                <button onClick={() => setActiveTalk(linkedTalk.id)}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11.5px]"
                  style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>
                  <CTIcon name="chat" size={10} stroke={S.ink2} /> {linkedTalk.title}
                </button>
              </>
            ) : (
              <>
                <span>·</span>
                <span className="text-[11.5px]" style={{ color: S.ink2 }}>unlinked</span>
              </>
            )}
          </>}
          right={<>
            {window.CT_FORGE_ENABLED ? (
              <button onClick={() => window.dispatchEvent(new CustomEvent('ct-forge-open'))}
                title="Improve this document with Forge"
                className="h-8 px-3 rounded-lg text-[12.5px] font-medium text-white inline-flex items-center gap-1.5"
                style={{ background: S.accent }}>
                <ForgeMark size={14} accent="#FFF" /> Improve
              </button>
            ) : null}
            {linkedTalk ? (
              <button onClick={() => setActiveTalk(linkedTalk.id)}
                className="h-8 px-3 rounded-lg text-[12.5px] inline-flex items-center gap-1.5"
                style={{ background: S.card, border: `1px solid ${S.line}`, color: S.ink }}>
                <CTIcon name="arrow" size={13} stroke={S.ink2} /> Open in Talk
              </button>
            ) : null}
            <button className="h-8 px-3 rounded-lg text-[12.5px] inline-flex items-center gap-1.5"
              style={{ background: S.card, border: `1px solid ${S.line}`, color: S.ink2 }}>
              <CTIcon name="paperclip" size={13} stroke={S.ink2} /> Share
            </button>
            <button className="h-8 px-3 rounded-lg text-[12.5px] font-medium text-white" style={{ background: S.accent }}>
              Done
            </button>
          </>}
        />

        <DocTabStrip
          doc={doc}
          activeTabId={tabId}
          onSwitch={(tid) => setDocTab(doc.id, tid)}
          onAdd={() => addDocTab(doc.id)}
          onRename={(tid, title) => renameDocTab(doc.id, tid, title)}
          onDelete={(tid) => deleteDocTab(doc.id, tid)}
        />

        <div className="flex-1 overflow-y-auto ct-thin-scroll" style={{ background: S.paper }}>
          <div className="max-w-[720px] mx-auto px-8 py-10">
            {/* Meta strip */}
            <div className="flex items-center gap-2 mb-5">
              <span className="text-[10.5px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>
                {doc.folder ? doc.folder : 'Inbox'} · last edit {doc.lastEdit}
              </span>
              <div className="flex-1 h-px ml-2" style={{ background: S.line }} />
              {coEditors.length ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10.5px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>Co-editing</span>
                  <div className="flex -space-x-1.5">
                    {coEditors.map((aid) => {
                      const a = CT_AGENTS.find((x) => x.id === aid);
                      return a ? <AgentAvatar key={aid} agent={a} size={20} /> : null;
                    })}
                  </div>
                </div>
              ) : null}
            </div>

            {/* Blocks */}
            {blocks.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center py-24 gap-3">
                <div className="w-12 h-12 rounded-full grid place-items-center" style={{ background: S.card, border: `1px solid ${S.line}` }}>
                  <CTIcon name="doc" size={20} stroke={S.ink2} />
                </div>
                <div className="font-serif text-[20px]" style={{ color: S.ink }}>This tab is empty</div>
                <div className="text-[13.5px] max-w-[320px]" style={{ color: S.ink2 }}>
                  Start writing, or ask the room to draft into this tab. Each tab is its own section of the document.
                </div>
              </div>
            ) : blocks.map((b) => {
              if (b.kind === 'h1') return <h1 key={b.id} className="font-serif text-[34px] leading-tight tracking-tight mb-1" style={{ color: S.ink }}>{b.text}</h1>;
              if (b.kind === 'meta') return <div key={b.id} className="text-[11px] font-mono uppercase tracking-widest mb-5" style={{ color: S.ink2 }}>{b.text}</div>;
              if (b.kind === 'h2') return <h2 key={b.id} className="font-serif text-[22px] mt-7 mb-2" style={{ color: S.ink }}>{b.text}</h2>;
              if (b.kind === 'p')  return <p key={b.id} className="font-serif text-[16px] leading-[1.7] mb-3" style={{ color: S.ink }}>{b.text}</p>;
              if (b.kind === 'li') {
                const pending = b.pending;
                return (
                  <div key={b.id} className="flex gap-2.5 py-1.5"
                    style={pending ? { background: 'rgba(200,100,58,0.08)', borderLeft: `2px solid ${S.accent}`, paddingLeft: 10, marginLeft: -12, borderRadius: 4 } : {}}>
                    <span className="font-serif text-[16px]" style={{ color: pending ? S.accent : S.ink2 }}>•</span>
                    <span className="font-serif text-[15.5px] leading-[1.7] flex-1" style={{ color: S.ink }}>
                      {b.text}
                      {pending ? (
                        <span className="ml-2 align-middle inline-block text-[10px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded"
                          style={{ background: S.accent, color: '#FFF' }}>Editor · pending</span>
                      ) : null}
                    </span>
                  </div>
                );
              }
              return null;
            })}
          </div>
        </div>

        {/* Footer with pending edits banner if any */}
        {pending > 0 ? (
          <div className="px-9 py-3 border-t flex items-center gap-3 shrink-0"
            style={{ borderColor: S.line, background: S.paper2 }}>
            <CTIcon name="sparkle" size={14} stroke={S.accent} />
            <div className="flex-1 text-[12.5px]" style={{ color: S.ink }}>
              <span className="font-medium">{pending} pending edit{pending !== 1 ? 's' : ''}</span> from <span className="italic">Editor</span>.
            </div>
            <button onClick={() => rejectDocEdits(doc.id, tabId)}
              className="h-8 px-3 text-[12px] rounded-md hover:bg-[var(--salon-paper)]"
              style={{ color: S.ink2, border: `1px solid ${S.line}` }}>Reject all</button>
            <button onClick={() => acceptDocEdits(doc.id, tabId)}
              className="h-8 px-3 text-[12px] rounded-md text-white"
              style={{ background: S.accent }}>Accept &amp; apply</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

Object.assign(window, { DocumentsScreen, DocEditorScreen, FormatBadge, DocRow, DocTableHeader, docWordCount });
