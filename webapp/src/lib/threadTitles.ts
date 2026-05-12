const MAX_THREAD_TITLE_CHARS = 48;

export function displayThreadTitle(
  title: string | null | undefined,
  fallback = 'New thread',
): string {
  const compact = title?.replace(/\s+/g, ' ').trim();
  if (!compact || compact === 'Default Thread') {
    return fallback;
  }
  return compact;
}

export function inferThreadTitleFromContent(
  content: string | null | undefined,
): string | null {
  const compact = content?.replace(/\s+/g, ' ').trim() || '';
  if (!compact) {
    return null;
  }
  const unquoted = compact.replace(/^["'`]+|["'`]+$/g, '').trim() || compact;
  if (unquoted.length <= MAX_THREAD_TITLE_CHARS) {
    return unquoted;
  }
  return `${unquoted.slice(0, MAX_THREAD_TITLE_CHARS - 1).trimEnd()}…`;
}
