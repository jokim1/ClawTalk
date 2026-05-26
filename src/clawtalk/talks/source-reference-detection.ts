// Detect `@-references` to saved sources in the latest user message.
// Two forms are supported:
//   `@S1`, `@s99`         — stable ref (case-insensitive; normalized to `S<n>`)
//   `@design-notes`       — title_slug form (case-insensitive; normalized to lowercase)
//
// The boundary guard is critical: a token only counts when the `@` is at
// the start of the message or preceded by whitespace / common punctuation.
// This stops email addresses (`joe@example.com`), in-word `@`, and
// markdown links (`[link](url@something)`) from triggering injection.
//
// A small denylist (`@doc`, `@everyone`, `@here`) keeps reserved tokens
// out of the slug list — `@doc` is the document reference handled by
// content-edit-intent, and the others are conventional non-mentions.

const DENYLIST = new Set(['doc', 'everyone', 'here']);

/**
 * Parse `@S<n>` ref-form and `@<slug>` slug-form mentions from a single
 * user message body. Returns deduped lists; refs are upper-cased to the
 * canonical `S<n>` form, slugs are lower-cased.
 */
export function extractSourceReferences(messageText: string): {
  refs: string[];
  slugs: string[];
} {
  if (!messageText) return { refs: [], slugs: [] };

  const refs = new Set<string>();
  const slugs = new Set<string>();

  // Match `@` followed by at least 2 chars of letters/digits/hyphens. We
  // verify the boundary before `@` in code to keep the regex simple and
  // sidestep lookbehind portability concerns.
  const pattern = /@[A-Za-z0-9][A-Za-z0-9-]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(messageText)) !== null) {
    const start = match.index;
    if (start > 0) {
      const prev = messageText[start - 1];
      // Word chars before `@` mean we're inside a token like an email
      // (`joe@example.com`) or markdown link (`[link](url@something)`).
      if (/[A-Za-z0-9_]/.test(prev)) continue;
    }
    const inner = match[0].slice(1);
    const lower = inner.toLowerCase();
    if (DENYLIST.has(lower)) continue;

    if (/^s\d+$/i.test(inner)) {
      refs.add(`S${inner.slice(1)}`);
      continue;
    }

    // Strip trailing hyphens so `@design-notes-` resolves to `design-notes`.
    const cleanedSlug = lower.replace(/-+$/, '');
    if (cleanedSlug.length >= 2) {
      slugs.add(cleanedSlug);
    }
  }

  return {
    refs: Array.from(refs),
    slugs: Array.from(slugs),
  };
}
