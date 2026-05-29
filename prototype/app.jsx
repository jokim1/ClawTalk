/* eslint-disable */
// App entry — routes between screens, wires global keyboard shortcuts,
// renders the Tweaks panel.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent":     "#C8643A",
  "density":    "cozy",
  "homeLayout": "focus"
}/*EDITMODE-END*/;

function Router() {
  const { state, route, setRoute, setShowCmdK, setShowNewTalkSheet } = useApp();

  // ─── global hotkeys ─────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      // ⌘K / Ctrl+K — palette
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowCmdK((v) => !v);
        return;
      }
      // ⌘N / Ctrl+N — new Talk sheet
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setShowNewTalkSheet(true);
        return;
      }
      // ⌘. — cancel (handled in screen if running)
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        // The TalkScreen handles cancel; no-op here.
      }
      // esc — close palette
      if (e.key === 'Escape' && state.showCmdK) {
        e.preventDefault();
        setShowCmdK(false);
      }
      // Don't intercept g-prefix when typing in inputs.
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;

      // g+h / g+t / g+, sequences
      if (e.key.toLowerCase() === 'g') {
        const onNext = (e2) => {
          window.removeEventListener('keydown', onNext, true);
          const k = e2.key.toLowerCase();
          if (k === 'h') setRoute('home');
          else if (k === 't') setRoute('talk');
          else if (k === ',') setRoute('settings');
        };
        window.addEventListener('keydown', onNext, true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.showCmdK, setShowCmdK, setRoute]);

  // Route to screen.
  let screen = null;
  if (route === 'signin') screen = <SignInScreen />;
  else if (route === 'home') screen = <HomeScreen />;
  else if (route === 'settings') screen = <SettingsScreen />;
  else if (route === 'agents') screen = <AgentsScreen />;
  else if (route === 'agent') screen = <AgentProfileScreen />;
  else if (route === 'documents') screen = <DocumentsScreen />;
  else if (route === 'doc') screen = <DocEditorScreen />;
  else if (route === 'forge' && window.CT_FORGE_ENABLED && window.ForgePage) screen = React.createElement(window.ForgePage);
  else screen = <TalkScreen />;

  return (
    <React.Fragment>
      {screen}
      {state.showCmdK ? <CmdKPalette /> : null}
      {state.showNewTalkSheet ? <NewTalkSheet /> : null}
      {state.folderDeleteDialog ? <FolderDeleteDialog /> : null}
      {state.archiveTalkDialog  ? <ArchiveTalkDialog />  : null}
      {window.CT_FORGE_ENABLED && window.ForgeMount ? React.createElement(window.ForgeMount) : null}
    </React.Fragment>
  );
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // Push tweaks to CSS / body class.
  useEffect(() => {
    document.documentElement.style.setProperty('--salon-accent', t.accent);
  }, [t.accent]);
  useEffect(() => {
    document.body.classList.remove('density-cozy', 'density-compact');
    document.body.classList.add('density-' + t.density);
  }, [t.density]);

  useEffect(() => {
    document.documentElement.dataset.homeLayout = t.homeLayout;
    window.dispatchEvent(new Event('ct-home-layout'));
  }, [t.homeLayout]);

  return (
    <AppProvider>
      <Router />
      <TweaksPanel title="Tweaks">
        <TweakSection title="Look">
          <TweakColor
            label="Accent"
            value={t.accent}
            onChange={(v) => setTweak('accent', v)}
            options={['#C8643A', '#8E3B59', '#3F6B5C', '#3D5688', '#1F1B16']}
          />
          <TweakRadio
            label="Density"
            value={t.density}
            onChange={(v) => setTweak('density', v)}
            options={['cozy', 'compact']}
          />
          <TweakRadio
            label="Home layout"
            value={t.homeLayout}
            onChange={(v) => setTweak('homeLayout', v)}
            options={['focus', 'split', 'feed']}
          />
        </TweakSection>
        <TweakSection title="Demo">
          <DemoTweakButtons />
        </TweakSection>
      </TweaksPanel>
    </AppProvider>
  );
}

// Tweak buttons that need access to AppContext live inside the provider.
function DemoTweakButtons() {
  const { setRoute, resetDemo, sendMessage, state } = useApp();
  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={() => setRoute('signin')}
        className="h-8 px-3 rounded-md text-[12px] text-left"
        style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>
        Jump to Sign-in
      </button>
      <button
        onClick={() => setRoute('home')}
        className="h-8 px-3 rounded-md text-[12px] text-left"
        style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>
        Jump to Home
      </button>
      <button
        onClick={() => setRoute('talk')}
        className="h-8 px-3 rounded-md text-[12px] text-left"
        style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>
        Jump to active Talk
      </button>
      <button
        onClick={() => setRoute('settings')}
        className="h-8 px-3 rounded-md text-[12px] text-left"
        style={{ background: S.card, color: S.ink, border: `1px solid ${S.line}` }}>
        Jump to Settings
      </button>
      <button
        onClick={resetDemo}
        className="h-8 px-3 rounded-md text-[12px] text-left"
        style={{ background: S.accent, color: '#FFF' }}>
        Reset demo state
      </button>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
