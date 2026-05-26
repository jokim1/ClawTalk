// Tool family display metadata shared by the agent-config UI
// (RegisteredAgentsPanel — capability ceiling) and the Talk chip bar
// (ToolChipsBar — active-now toggles). Keeping a single source
// prevents label drift between the two surfaces.

export const TOOL_FAMILY_GROUPS: Record<string, string[]> = {
  'Heavy tools (Claude container)': ['shell', 'filesystem', 'browser'],
  'Web tools': ['web'],
  Connectors: ['connectors'],
  'Google Workspace': [
    'google_read',
    'google_write',
    'gmail_read',
    'gmail_send',
  ],
  Messaging: ['messaging'],
};

export const TOOL_NAMES: Record<string, string> = {
  shell: 'Shell',
  filesystem: 'Filesystem',
  browser: 'Browser',
  web: 'Web',
  connectors: 'Connectors',
  google_read: 'Google Read',
  google_write: 'Google Write',
  gmail_read: 'Gmail Read',
  gmail_send: 'Gmail Send',
  messaging: 'Messaging',
};

/**
 * Flat list of family slugs in display order (Heavy → Web → Connectors
 * → Google → Messaging). ToolChipsBar uses this to render chips in a
 * stable order matching the agent-config screen.
 */
export const TOOL_FAMILY_ORDER: string[] = Object.values(
  TOOL_FAMILY_GROUPS,
).flat();
