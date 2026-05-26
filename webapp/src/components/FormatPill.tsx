// Small uppercase pill that signals the doc's authoring format.
// Visible text ("MD" / "HTML") is the label — no aria-label needed.
// Colors live in :root tokens (--format-pill-{md,html}-{bg,fg,border})
// so both light and future dark variants source from one place.

export type DocFormat = 'markdown' | 'html';

interface FormatPillProps {
  format: DocFormat;
  className?: string;
}

export function FormatPill({
  format,
  className,
}: FormatPillProps): JSX.Element {
  const variant = format === 'html' ? 'html' : 'markdown';
  const classes = ['format-pill', `format-pill-${variant}`, className]
    .filter(Boolean)
    .join(' ');
  return <span className={classes}>{format === 'html' ? 'HTML' : 'MD'}</span>;
}
