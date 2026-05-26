// Sticky right-edge button shown when the doc pane is hidden.
// Click restores the pane. Embedded FormatPill signals MD vs HTML
// without requiring the user to expand to find out.
//
// Touch target ≥44×44 (enforced via CSS min-width/min-height). The
// aria-label carries the full title even when the visible label is
// truncated/rotated.

import { FormatPill, type DocFormat } from './FormatPill';

export interface DocPaneEdgeTabProps {
  docTitle: string;
  format: DocFormat;
  onClick: () => void;
  className?: string;
}

export function DocPaneEdgeTab({
  docTitle,
  format,
  onClick,
  className,
}: DocPaneEdgeTabProps): JSX.Element {
  const classes = ['doc-pane-edge-tab', className].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      className={classes}
      aria-label={`Show ${docTitle} document`}
      title={`Show ${docTitle} document`}
      onClick={onClick}
    >
      <span className="doc-pane-edge-tab-label">{docTitle}</span>
      <FormatPill format={format} className="doc-pane-edge-tab-pill" />
    </button>
  );
}
