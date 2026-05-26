// Detect whether the latest user turn is asking the agent to EDIT the
// Talk's attached document, as opposed to discuss / evaluate / summarize
// it in chat. Used by the executor to (a) emit content_edit_run_started/
// run_aborted banner events around the apply turn and (b) by talks.ts
// to force serial routing when multiple agents are addressed.
//
// Conservative design: the cost of a false positive (forcing a tool
// call on a valid analysis request) is worse than the cost of a false
// negative (the agent declines to edit even though it could). Verbs
// must be unambiguous edit verbs, and they must appear in the same
// sentence as `@doc`.

/**
 * Edit verbs — when one of these appears in the same sentence as
 * `@doc`, the user is asking for a document change. Matched as
 * standalone words via word-boundary regex so "added" / "edited" /
 * "appending" all hit.
 */
const EDIT_VERB_PATTERNS: ReadonlyArray<RegExp> = [
  /\badd(?:ed|ing|s)?\b/i,
  /\bappend(?:ed|ing|s)?\b/i,
  /\binsert(?:ed|ing|s)?\b/i,
  /\bdraft(?:ed|ing|s)?\b/i,
  /\bcontinue(?:d|s)?\b/i,
  /\bcontinuing\b/i,
  /\bextend(?:ed|ing|s)?\b/i,
  /\bexpand(?:ed|ing|s)?\b/i,
  /\blengthen(?:ed|ing|s)?\b/i,
  /\breplac(?:e|ed|ing|es)\b/i,
  /\bswap(?:ped|ping|s)?\b/i,
  /\bsubstitut(?:e|ed|ing|es)\b/i,
  /\brewrit(?:e|ing|es)\b/i,
  /\brewrote\b/i,
  /\bredo(?:ing|es)?\b/i,
  /\bredid\b/i,
  /\bredraft(?:ed|ing|s)?\b/i,
  /\bfix(?:ed|ing|es)?\b/i,
  /\bcorrect(?:ed|ing|s)?\b/i,
  /\bpolish(?:ed|ing|es)?\b/i,
  /\btighten(?:ed|ing|s)?\b/i,
  /\brefin(?:e|ed|ing|es)\b/i,
  /\bimprov(?:e|ed|ing|es)\b/i,
  /\bedit(?:ed|ing|s)?\b/i,
  /\brevis(?:e|ed|ing|es)\b/i,
  /\bshorten(?:ed|ing|s)?\b/i,
  /\btrim(?:med|ming|s)?\b/i,
  /\bcondens(?:e|ed|ing|es)\b/i,
  /\bcut\b/i, // "cut paragraph 3"
  /\bdelet(?:e|ed|ing|es)\b/i,
  /\bremov(?:e|ed|ing|es)\b/i,
  /\bdrop(?:ped|ping|s)?\b/i,
  /\brestructur(?:e|ed|ing|es)\b/i,
  /\breorganiz(?:e|ed|ing|es)\b/i,
  /\breorder(?:ed|ing|s)?\b/i,
];

/**
 * Analysis verbs — when one of these is the *primary* verb near `@doc`
 * and no edit verb matches, the user is asking for discussion / not an
 * edit. We don't currently use this list to *block* the gate (the gate
 * already requires an edit-verb match to fire); it's documented here
 * to keep the boundary visible for future tuning.
 */
export const ANALYSIS_VERBS_REFERENCE: ReadonlyArray<string> = [
  'evaluate',
  'analyze',
  'assess',
  'critique',
  'review',
  'comment',
  'feedback',
  'explain',
  'describe',
  'walk through',
  'summarize',
  'compare',
  'contrast',
  'thoughts',
  'opinion',
  'take',
];

const AT_DOC_PATTERN = /@doc\b/i;

/**
 * Return true when the message contains both `@doc` and an edit verb
 * in the same sentence. Sentence boundaries are split on `.`, `!`,
 * `?`, and newlines.
 */
export function isContentEditIntent(message: string): boolean {
  if (!message) return false;
  if (!AT_DOC_PATTERN.test(message)) return false;

  // Split on sentence terminators + newlines. Bullet lists become
  // separate sentences so "- @doc add ..." matches the bullet alone
  // rather than catching a stray edit verb three bullets away.
  const sentences = message.split(/[.!?\n]+/);
  for (const sentence of sentences) {
    if (!AT_DOC_PATTERN.test(sentence)) continue;
    for (const pattern of EDIT_VERB_PATTERNS) {
      if (pattern.test(sentence)) return true;
    }
  }
  return false;
}

/**
 * Extract the plain-text body of the last user message in the
 * conversation. Defaults to '' when no user message is present so
 * `isContentEditIntent` returns false cleanly.
 */
export function lastUserMessageText(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      // Multimodal content array — concatenate text parts.
      const parts: string[] = [];
      for (const item of content) {
        if (
          item &&
          typeof item === 'object' &&
          (item as { type?: string }).type === 'text' &&
          typeof (item as { text?: unknown }).text === 'string'
        ) {
          parts.push((item as { text: string }).text);
        }
      }
      return parts.join('\n');
    }
    return '';
  }
  return '';
}
