// Tool family display metadata for the Talk chip bar (ToolChipsBar —
// active-now toggles). Tools are a property of the Talk only; there is no
// per-agent tool surface, so the chip bar is the single consumer.
//
// Heavy families (shell/filesystem/browser) are intentionally excluded — the
// Claude container that ran them is gone, so they never appear on the bar.

export const TOOL_FAMILY_GROUPS: Record<string, string[]> = {
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
  web: 'Web',
  connectors: 'Connectors',
  google_read: 'Google Read',
  google_write: 'Google Write',
  gmail_read: 'Gmail Read',
  gmail_send: 'Gmail Send',
  messaging: 'Messaging',
};

// Per-chip tooltip copy, also used to compose the discovery hint surfaced
// when a Talk has no tools active yet (the all-off default).
export const TOOL_HINTS: Record<string, string> = {
  web: 'Live web search and page fetch',
  connectors: 'Connected third-party integrations',
  google_read: 'Read Google Docs, Drive, and Sheets',
  google_write: 'Create and edit Google Docs and Sheets',
  gmail_read: 'Read and search Gmail',
  gmail_send: 'Send Gmail messages',
  messaging: 'Post to Slack and Discord',
};

/**
 * Flat list of family slugs in display order (Web → Connectors → Google →
 * Messaging). ToolChipsBar uses this to render chips in a stable order.
 */
export const TOOL_FAMILY_ORDER: string[] = Object.values(
  TOOL_FAMILY_GROUPS,
).flat();
