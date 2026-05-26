// CodeMirror-backed raw-HTML editor for the doc pane's Source mode.
// Pairs with the Preview mode (rendered via <SafeHtml>) — the doc-pane
// header's segmented toggle swaps between them.
//
// Debounced autosave matches the existing markdown autosave cadence
// (~1200ms). Caller owns the persisted state; this component just
// reports changes via onChange + onSave.
//
// CodeMirror contentEditable does not render reliably in jsdom, so the
// component is lazy-friendly: A3 will `React.lazy(() => import(...))`
// it. Tests mock `@uiw/react-codemirror` with a textarea shim — the
// integration assertion (debounced save → calls onSave) does not
// require the real CodeMirror runtime.

import { useCallback, useEffect, useRef } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { html as cmHtml } from '@codemirror/lang-html';
import { EditorView } from '@codemirror/view';

const DEFAULT_DEBOUNCE_MS = 1200;

export interface HtmlSourceEditorProps {
  value: string;
  onChange: (next: string) => void;
  onSave?: (next: string) => void;
  saveDebounceMs?: number;
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
  // A11y label for screen readers wrapping the editor surface.
  ariaLabel?: string;
}

export function HtmlSourceEditor({
  value,
  onChange,
  onSave,
  saveDebounceMs = DEFAULT_DEBOUNCE_MS,
  readOnly,
  placeholder,
  className,
  ariaLabel = 'HTML source editor',
}: HtmlSourceEditorProps): JSX.Element {
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>(value);

  // Keep the last-saved baseline in sync when the caller hands us a
  // fresh value (e.g. AI edit just materialised). Otherwise the next
  // user edit would be diffed against a stale baseline.
  useEffect(() => {
    lastSavedRef.current = value;
  }, [value]);

  // Cancel any pending save on unmount.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, []);

  const handleChange = useCallback(
    (next: string) => {
      onChange(next);
      if (!onSave) return;
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        if (next !== lastSavedRef.current) {
          lastSavedRef.current = next;
          onSave(next);
        }
      }, saveDebounceMs);
    },
    [onChange, onSave, saveDebounceMs],
  );

  // CodeMirror extensions: HTML language + line wrap so narrow viewports
  // keep the source on screen instead of forcing horizontal scroll.
  const extensions = [
    cmHtml({ matchClosingTags: true }),
    EditorView.lineWrapping,
  ];

  const classes = ['html-source-editor', className].filter(Boolean).join(' ');

  return (
    <div className={classes} aria-label={ariaLabel}>
      <CodeMirror
        ref={editorRef}
        value={value}
        editable={!readOnly}
        readOnly={readOnly}
        extensions={extensions}
        placeholder={placeholder}
        onChange={handleChange}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          foldGutter: true,
        }}
        // Visual hooks for our stylesheet.
        theme="light"
      />
    </div>
  );
}

export default HtmlSourceEditor;
