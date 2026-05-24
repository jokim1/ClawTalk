// Per-Talk localStorage key for the Content split-pane ratio.
//
// Each Talk remembers its own preferred chat/doc split. PR 3 wires the
// resize handle to these helpers; PR 2 establishes the key naming + the
// one-time migration from a hypothetical legacy global key so the helper
// is a single source of truth across PRs.

const LEGACY_KEY = 'clawtalk.contentSplitRatio';
const PER_TALK_KEY_PREFIX = 'clawtalk.contentSplitRatio:';
const DEFAULT_RATIO = 0.5;
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

function clamp(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RATIO;
  if (value < MIN_RATIO) return MIN_RATIO;
  if (value > MAX_RATIO) return MAX_RATIO;
  return value;
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readLegacyRatio(storage: Storage): number | null {
  const raw = storage.getItem(LEGACY_KEY);
  if (raw === null) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? clamp(parsed) : null;
}

export function getContentSplitRatio(talkId: string): number {
  const storage = getStorage();
  if (!storage) return DEFAULT_RATIO;
  const perTalkKey = PER_TALK_KEY_PREFIX + talkId;
  const stored = storage.getItem(perTalkKey);
  if (stored !== null) {
    const parsed = Number.parseFloat(stored);
    return Number.isFinite(parsed) ? clamp(parsed) : DEFAULT_RATIO;
  }
  const legacy = readLegacyRatio(storage);
  if (legacy === null) return DEFAULT_RATIO;
  storage.setItem(perTalkKey, String(legacy));
  return legacy;
}

export function setContentSplitRatio(talkId: string, ratio: number): void {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(PER_TALK_KEY_PREFIX + talkId, String(clamp(ratio)));
}
