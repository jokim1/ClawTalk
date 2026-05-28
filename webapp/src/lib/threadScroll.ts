// Per-thread scroll position remembered across mounts.
//
// The thread-show effect in TalkDetailPage uses this to decide whether to
// snap a freshly-mounted thread to the bottom (default for "the user was
// last reading new messages") or restore the saved offset (the user had
// scrolled up to read history). The reducer no longer carries an
// `initialScrollPending` flag — this module owns first-paint scroll
// behavior end-to-end.

const KEY_PREFIX = 'clawtalk.scroll:';

export type ThreadScrollState = {
  offset: number;
  atBottom: boolean;
};

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function key(talkId: string, threadId: string): string {
  return `${KEY_PREFIX}${talkId}:${threadId}`;
}

export function loadThreadScroll(
  talkId: string,
  threadId: string,
): ThreadScrollState | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(key(talkId, threadId));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const offset = (parsed as { offset?: unknown }).offset;
    const atBottom = (parsed as { atBottom?: unknown }).atBottom;
    if (typeof offset !== 'number' || !Number.isFinite(offset)) return null;
    if (typeof atBottom !== 'boolean') return null;
    return { offset: Math.max(0, offset), atBottom };
  } catch {
    return null;
  }
}

export function saveThreadScroll(
  talkId: string,
  threadId: string,
  state: ThreadScrollState,
): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key(talkId, threadId), JSON.stringify(state));
  } catch {
    // Quota / private mode — silently ignore.
  }
}

export function clearThreadScroll(talkId: string, threadId: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(key(talkId, threadId));
  } catch {
    // ignore
  }
}
