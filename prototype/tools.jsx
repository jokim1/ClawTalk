/* eslint-disable */
// Per-talk tools — definitions + popover surface used by the talk header.

const CT_TOOLS = [
  { id: 'web-search',  label: 'Web search',     group: 'web',     desc: 'Agents may search the open web for facts and comps.', icon: 'search' },
  { id: 'web-fetch',   label: 'Web fetch',      group: 'web',     desc: 'Agents may open a specific URL and read it.',          icon: 'globe'  },
  { id: 'news-monitor',label: 'News monitor',   group: 'web',     desc: 'Send a topic summary of this Talk to the workspace news feed. Never sends your messages.', icon: 'sparkle' },
  { id: 'gdrive-read', label: 'Drive · read',   group: 'google',  desc: 'Agents may read Google Docs / Sheets you share.',      icon: 'doc'    },
  { id: 'gdrive-write',label: 'Drive · write',  group: 'google',  desc: 'Agents may create or edit Google Docs.',                icon: 'doc'    },
  { id: 'gmail-read',  label: 'Gmail · read',   group: 'google',  desc: 'Agents may search and read your inbox.',                icon: 'eye'    },
  { id: 'gmail-send',  label: 'Gmail · send',   group: 'google',  desc: 'Agents may compose and send mail on your behalf.',      icon: 'send'   },
  { id: 'messaging',   label: 'Slack messages', group: 'comms',   desc: 'Agents may post into Slack channels you select.',       icon: 'chat'   },
  { id: 'linear',      label: 'Linear · issues',group: 'work',    desc: 'Agents may file and update Linear issues.',             icon: 'bolt'   },
  { id: 'github-read', label: 'GitHub · read',  group: 'work',    desc: 'Agents may read PR diffs and file contents.',           icon: 'folder' },
];

const CT_TOOL_GROUPS = [
  { id: 'web',    title: 'Web' },
  { id: 'google', title: 'Google Workspace' },
  { id: 'comms',  title: 'Communication' },
  { id: 'work',   title: 'Work tools' },
];

// Resolves the effective tool map for the active talk.
function effectiveTools(state, talk) {
  return (talk && talk.tools) || state.defaultTools || {};
}

// Compact icon row — used in composer footer for at-a-glance visibility.
function ToolGlyphs({ tools, max = 4 }) {
  const enabled = CT_TOOLS.filter((t) => tools[t.id]);
  if (enabled.length === 0) return (
    <span className="text-[11px]" style={{ color: S.ink2 }}>No tools enabled</span>
  );
  return (
    <div className="flex items-center gap-1">
      {enabled.slice(0, max).map((t) => (
        <span key={t.id} className="w-5 h-5 grid place-items-center rounded-md" title={t.label}
          style={{ background: S.paper2, color: S.ink2 }}>
          <CTIcon name={t.icon} size={11} stroke={S.ink2} />
        </span>
      ))}
      {enabled.length > max ? (
        <span className="text-[10.5px] font-mono ml-0.5" style={{ color: S.ink2 }}>+{enabled.length - max}</span>
      ) : null}
    </div>
  );
}

// Toggle switch (small).
function Switch({ on, onClick }) {
  return (
    <button onClick={onClick} aria-pressed={on}
      className="relative inline-flex items-center transition-colors"
      style={{
        width: 32, height: 18, borderRadius: 999,
        background: on ? S.accent : S.paper2,
        border: `1px solid ${on ? S.accent : S.line}`,
      }}>
      <span className="absolute transition-transform"
        style={{
          width: 12, height: 12, borderRadius: 999, background: '#FFF',
          top: 2, left: 2, transform: on ? 'translateX(14px)' : 'translateX(0)',
          boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
        }} />
    </button>
  );
}

function ToolsPopover({ anchorRect, onClose }) {
  const { state, activeTalk, toggleTool } = useApp();
  const tools = effectiveTools(state, activeTalk);
  const enabledCount = CT_TOOLS.filter((t) => tools[t.id]).length;

  // Position: anchor to bottom-right of the trigger.
  const style = anchorRect ? {
    position: 'fixed',
    top: anchorRect.bottom + 6,
    left: Math.max(8, anchorRect.right - 360),
    width: 380,
    zIndex: 60,
  } : { position: 'fixed', top: 80, right: 16, width: 380, zIndex: 60 };

  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} style={{ background: 'transparent' }} />
      <div className="rounded-2xl overflow-hidden ct-screen-enter"
        style={{ ...style, background: S.card, border: `1px solid ${S.line}`, boxShadow: '0 30px 60px rgba(31,27,22,0.22)' }}>
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-center gap-2">
            <CTIcon name="sparkle" size={13} stroke={S.ink2} />
            <div className="font-serif text-[16px]" style={{ color: S.ink }}>Tools in this Talk</div>
            <span className="ml-auto text-[11px] font-mono uppercase tracking-widest" style={{ color: S.ink2 }}>
              {enabledCount} of {CT_TOOLS.length} on
            </span>
          </div>
          <p className="text-[12px] mt-1 leading-relaxed" style={{ color: S.ink2 }}>
            Agents in this room can use the tools you turn on here. Settings apply to every agent in the Talk and persist across rounds.
          </p>
        </div>

        <div className="max-h-[60vh] overflow-y-auto ct-thin-scroll pb-1">
          {CT_TOOL_GROUPS.map((g) => {
            const groupTools = CT_TOOLS.filter((t) => t.group === g.id);
            return (
              <div key={g.id}>
                <div className="px-4 pt-2 pb-1 text-[10.5px] font-mono uppercase tracking-[0.16em]" style={{ color: S.ink2 }}>
                  {g.title}
                </div>
                {groupTools.map((t) => {
                  const on = !!tools[t.id];
                  return (
                    <button key={t.id} onClick={() => toggleTool(t.id)}
                      className="w-full px-4 py-2 flex items-center gap-3 text-left hover:bg-[var(--salon-paper-2)] transition-colors">
                      <span className="w-7 h-7 rounded-lg grid place-items-center shrink-0"
                        style={{ background: on ? `${S.accent}1A` : S.paper2, color: on ? S.accent : S.ink2 }}>
                        <CTIcon name={t.icon} size={13} stroke={on ? S.accent : S.ink2} strokeWidth={1.8} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium" style={{ color: S.ink }}>{t.label}</div>
                        <div className="text-[11.5px] leading-snug truncate" style={{ color: S.ink2 }}>{t.desc}</div>
                      </div>
                      <Switch on={on} />
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t flex items-center justify-between"
          style={{ borderColor: S.line, background: S.paper }}>
          <span className="text-[11px]" style={{ color: S.ink2 }}>
            Tool calls will appear in the thread as <span className="font-mono px-1 rounded" style={{ background: S.paper2 }}>· tool</span> footnotes.
          </span>
          <button onClick={onClose}
            className="h-7 px-3 rounded-full text-[11.5px] font-medium text-white" style={{ background: S.accent }}>
            Done
          </button>
        </div>
      </div>
    </>
  );
}

Object.assign(window, { CT_TOOLS, CT_TOOL_GROUPS, effectiveTools, ToolGlyphs, Switch, ToolsPopover });
