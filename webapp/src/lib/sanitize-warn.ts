// Helper for the sanitize-warning banner copy. The server-side
// sanitizer (PR A1) returns a `stripped` array of {tag, count} pairs
// when a user-edit removes blocked elements; this function formats
// that into the inline banner copy used by `DocPaneHeader`.
//
// Banner copy contract (see plan §Interaction states):
//   "Stripped N tag(s): <script>, <iframe>"
// AI-generated content also strips silently — that path does NOT
// surface this banner; the parent component decides whether to call.

export interface StrippedTag {
  tag: string;
  count: number;
}

export function formatStrippedTags(stripped: StrippedTag[]): string {
  if (!stripped || stripped.length === 0) return '';
  const total = stripped.reduce((sum, s) => sum + Math.max(s.count, 0), 0);
  const names = stripped.map((s) => `<${s.tag}>`).join(', ');
  return `Stripped ${total} tag${total === 1 ? '' : 's'}: ${names}`;
}
