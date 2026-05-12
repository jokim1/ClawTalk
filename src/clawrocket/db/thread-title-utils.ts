export const LEGACY_DEFAULT_TALK_THREAD_TITLE = 'Default Thread';

export const MAX_INFERRED_THREAD_TITLE_CHARS = 48;
export const MAX_EDITABLE_THREAD_TITLE_CHARS = 120;

export class ThreadTitleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreadTitleValidationError';
  }
}

export function normalizeStoredThreadTitle(
  title: string | null | undefined,
): string | null {
  if (typeof title !== 'string') return null;
  const compact = title.replace(/\s+/g, ' ').trim();
  return compact ? compact : null;
}

export function isLegacyPlaceholderTalkThreadTitle(
  title: string | null | undefined,
): boolean {
  return normalizeStoredThreadTitle(title) === LEGACY_DEFAULT_TALK_THREAD_TITLE;
}

export function inferThreadTitleFromContent(
  content: string | null | undefined,
): string | null {
  const compact = normalizeStoredThreadTitle(content);
  if (!compact) return null;

  const unquoted = compact.replace(/^["'`]+|["'`]+$/g, '').trim() || compact;
  if (unquoted.length <= MAX_INFERRED_THREAD_TITLE_CHARS) {
    return unquoted;
  }
  return `${unquoted.slice(0, MAX_INFERRED_THREAD_TITLE_CHARS - 1).trimEnd()}…`;
}

export function validateEditableThreadTitle(
  title: string | null | undefined,
): string {
  const normalized = normalizeStoredThreadTitle(title);
  if (!normalized) {
    throw new ThreadTitleValidationError(
      'Thread title must be a non-empty string',
    );
  }
  if (normalized.length > MAX_EDITABLE_THREAD_TITLE_CHARS) {
    throw new ThreadTitleValidationError(
      `Thread title must be at most ${MAX_EDITABLE_THREAD_TITLE_CHARS} characters`,
    );
  }
  return normalized;
}
