// Per-Talk localStorage key for the last thread the user viewed.
//
// When the user clicks a Talk in the sidebar (or otherwise navigates to
// /app/talks/<talkId> without a thread param), the routing effect prefers
// the saved value over the most-recent-by-activity fallback. Caller must
// fall back to threads[0] when the saved id is no longer present.

const PER_TALK_KEY_PREFIX = 'clawtalk.lastThread:';

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getLastThreadForTalk(talkId: string): string | null {
  const storage = getStorage();
  if (!storage) return null;
  const stored = storage.getItem(PER_TALK_KEY_PREFIX + talkId);
  return stored && stored.length > 0 ? stored : null;
}

export function setLastThreadForTalk(talkId: string, threadId: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(PER_TALK_KEY_PREFIX + talkId, threadId);
  } catch {
    // Quota / private mode — silently ignore.
  }
}
