// Header bar for the doc pane.
//
// Pure presentation — owns no doc state. The page wires the props
// (title, format, save status, mode, sanitize-warning…) and listens
// to callbacks for changes.
//
// Slot order (left → right):
//   1. Title (InlineEditableTitle)
//   2. FormatPill (MD / HTML)
//   3. Save status
//   4. Preview/Source segmented toggle (HTML docs only)
//   5. CopyExportMenu (rendered via the copyExportSlot prop)
//   6. Hide-pane button
//
// Below the bar: optional sanitize-warning banner ("Stripped N tags…")
// reusing the existing .talk-tab-doc-conflict yellow-banner styling.

import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import { FormatPill, type DocFormat } from './FormatPill';
import { InlineEditableTitle } from './InlineEditableTitle';
import { formatStrippedTags, type StrippedTag } from '../lib/sanitize-warn';

export type DocPaneSaveStatus =
  | 'idle'
  | 'saving'
  | 'pending'
  | 'saved'
  | 'error';

export type DocPaneMode = 'preview' | 'source';

export interface DocPaneHeaderProps {
  title: string;
  onTitleSave: (next: string) => Promise<void> | void;
  format: DocFormat;
  saveStatus: DocPaneSaveStatus;
  loading?: boolean;
  // HTML-only Preview/Source toggle; pass undefined for markdown docs.
  mode?: DocPaneMode;
  onModeChange?: (next: DocPaneMode) => void;
  // Renders inside slot 5. Caller decides what goes here (typically
  // a <CopyExportMenu/>) so the header doesn't hard-depend on the
  // export library shape.
  copyExportSlot?: ReactNode;
  onHidePane?: () => void;
  sanitizeWarning?: { stripped: StrippedTag[] } | null;
  onSanitizeWarningDismiss?: () => void;
  // Opens the "Why?" explainer; if undefined the link is hidden.
  onSanitizeWhy?: () => void;
}

const SAVE_LABEL: Record<DocPaneSaveStatus, string> = {
  idle: '',
  saving: 'Saving…',
  pending: 'Unsaved changes',
  saved: 'Saved',
  error: 'Save failed',
};

export function DocPaneHeader(props: DocPaneHeaderProps): JSX.Element {
  const {
    title,
    onTitleSave,
    format,
    saveStatus,
    loading,
    mode,
    onModeChange,
    copyExportSlot,
    onHidePane,
    sanitizeWarning,
    onSanitizeWarningDismiss,
    onSanitizeWhy,
  } = props;

  const previewTabRef = useRef<HTMLButtonElement | null>(null);
  const sourceTabRef = useRef<HTMLButtonElement | null>(null);

  const handleModeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!onModeChange) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const next: DocPaneMode = mode === 'preview' ? 'source' : 'preview';
        onModeChange(next);
        // Roving focus to the newly selected tab so screen readers
        // announce the right item.
        const target =
          next === 'preview' ? previewTabRef.current : sourceTabRef.current;
        target?.focus();
      }
    },
    [mode, onModeChange],
  );

  const warningCopy = sanitizeWarning
    ? formatStrippedTags(sanitizeWarning.stripped)
    : '';
  const showWarning = sanitizeWarning !== null && warningCopy !== '';

  // Dismiss timer for the banner is owned by the parent — we just emit
  // the dismiss callback when the close button is clicked. Auto-dismiss
  // is a parent concern because it has the full lifecycle of the
  // sanitize-warning state (set on save, replaced on next save, etc.).

  return (
    <>
      <header
        className={[
          'talk-tab-doc-header',
          'doc-pane-header',
          format === 'html'
            ? 'doc-pane-header-html'
            : 'doc-pane-header-markdown',
        ].join(' ')}
      >
        <div className="doc-pane-header-left">
          <InlineEditableTitle
            title={title}
            onSave={onTitleSave}
            buttonClassName="talk-tab-doc-title doc-pane-header-title-button"
            inputClassName="doc-pane-header-title-input"
            errorClassName="doc-pane-header-title-error"
            renameLabel="Rename document"
          />
          <FormatPill format={format} />
        </div>
        <div className="doc-pane-header-right">
          {loading ? (
            <span className="talk-tab-doc-status">Loading…</span>
          ) : (
            <span
              className={`talk-tab-doc-status talk-tab-doc-save-${saveStatus}`}
              aria-live="polite"
            >
              {SAVE_LABEL[saveStatus]}
            </span>
          )}
          {format === 'html' && mode && onModeChange ? (
            <div
              role="tablist"
              aria-label="Document view"
              className="doc-pane-header-mode-toggle"
              onKeyDown={handleModeKeyDown}
            >
              <button
                ref={previewTabRef}
                type="button"
                role="tab"
                aria-selected={mode === 'preview'}
                tabIndex={mode === 'preview' ? 0 : -1}
                className={[
                  'doc-pane-header-mode-toggle-btn',
                  mode === 'preview'
                    ? 'doc-pane-header-mode-toggle-btn-active'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => onModeChange('preview')}
              >
                Preview
              </button>
              <button
                ref={sourceTabRef}
                type="button"
                role="tab"
                aria-selected={mode === 'source'}
                tabIndex={mode === 'source' ? 0 : -1}
                className={[
                  'doc-pane-header-mode-toggle-btn',
                  mode === 'source'
                    ? 'doc-pane-header-mode-toggle-btn-active'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => onModeChange('source')}
              >
                Source
              </button>
            </div>
          ) : null}
          {copyExportSlot ? (
            <div className="doc-pane-header-export-slot">{copyExportSlot}</div>
          ) : null}
          {onHidePane ? (
            <button
              type="button"
              className="doc-pane-hide-btn"
              aria-label="Hide document pane"
              aria-pressed={false}
              onClick={onHidePane}
              title="Hide document pane"
            >
              <span aria-hidden="true" className="doc-pane-hide-glyph">
                ›
              </span>
            </button>
          ) : null}
        </div>
      </header>
      {showWarning ? (
        <SanitizeWarningBanner
          message={warningCopy}
          onDismiss={onSanitizeWarningDismiss}
          onWhy={onSanitizeWhy}
        />
      ) : null}
    </>
  );
}

interface SanitizeWarningBannerProps {
  message: string;
  onDismiss?: () => void;
  onWhy?: () => void;
}

function SanitizeWarningBanner({
  message,
  onDismiss,
  onWhy,
}: SanitizeWarningBannerProps): JSX.Element {
  // Re-use the existing .talk-tab-doc-conflict yellow banner styling
  // so this stays visually consistent with the version-conflict toast.
  return (
    <div
      className="talk-tab-doc-conflict doc-pane-sanitize-warning"
      role="status"
      aria-live="polite"
    >
      <span>{message}</span>
      <span className="doc-pane-sanitize-warning-actions">
        {onWhy ? (
          <button
            type="button"
            className="doc-pane-sanitize-warning-why"
            onClick={onWhy}
          >
            Why?
          </button>
        ) : null}
        {onDismiss ? (
          <button
            type="button"
            className="talk-tab-doc-conflict-button doc-pane-sanitize-warning-dismiss"
            onClick={onDismiss}
            aria-label="Dismiss sanitize warning"
          >
            Dismiss
          </button>
        ) : null}
      </span>
    </div>
  );
}
