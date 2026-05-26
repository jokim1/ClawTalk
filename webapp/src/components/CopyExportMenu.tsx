// Unified Copy / Export dropdown for the doc-pane header.
// Two sections:
//   - Copy as: HTML (text/html + text/plain MIMEs), Markdown, Plain text
//   - Export as file: .html, .md, .txt (Blob + synthetic anchor click)
// Per-item success microcopy: label briefly swaps to "Copied ✓" /
// "Downloaded ✓" for ~1.5s, then reverts.
//
// Accessibility:
//   - Trigger: aria-haspopup="menu" + aria-expanded
//   - Menu: role="menu" with role="menuitem" children
//   - Down/Up arrow nav, Enter activates, Esc closes
//   - Empty doc: trigger disabled with title="Doc is empty"

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import {
  clipboardCopyHtml,
  clipboardCopyMarkdown,
  clipboardCopyPlain,
  downloadAsHtml,
  downloadAsMarkdown,
  downloadAsPlain,
  isDocEmpty,
  type DocSource,
} from '../lib/doc-export';

const SUCCESS_LABEL_MS = 1500;

type ActionId =
  | 'copy-html'
  | 'copy-markdown'
  | 'copy-plain'
  | 'export-html'
  | 'export-markdown'
  | 'export-plain';

interface MenuAction {
  id: ActionId;
  label: string;
  successLabel: string;
  run: (src: DocSource, filenameBase: string) => Promise<void> | void;
  section: 'copy' | 'export';
}

const MENU_ACTIONS: readonly MenuAction[] = [
  {
    id: 'copy-html',
    label: 'Copy as HTML',
    successLabel: 'Copied ✓',
    section: 'copy',
    run: (src) => clipboardCopyHtml(src),
  },
  {
    id: 'copy-markdown',
    label: 'Copy as Markdown',
    successLabel: 'Copied ✓',
    section: 'copy',
    run: (src) => clipboardCopyMarkdown(src),
  },
  {
    id: 'copy-plain',
    label: 'Copy as Plain text',
    successLabel: 'Copied ✓',
    section: 'copy',
    run: (src) => clipboardCopyPlain(src),
  },
  {
    id: 'export-html',
    label: 'Export as .html',
    successLabel: 'Downloaded ✓',
    section: 'export',
    run: (src, filenameBase) => downloadAsHtml(src, { filenameBase }),
  },
  {
    id: 'export-markdown',
    label: 'Export as .md',
    successLabel: 'Downloaded ✓',
    section: 'export',
    run: (src, filenameBase) => downloadAsMarkdown(src, { filenameBase }),
  },
  {
    id: 'export-plain',
    label: 'Export as .txt',
    successLabel: 'Downloaded ✓',
    section: 'export',
    run: (src, filenameBase) => downloadAsPlain(src, { filenameBase }),
  },
];

export interface CopyExportMenuProps {
  format: DocSource['format'];
  bodyMarkdown: string | null;
  bodyHtml: string | null;
  documentTitle: string;
  disabled?: boolean;
  className?: string;
}

export function CopyExportMenu({
  format,
  bodyMarkdown,
  bodyHtml,
  documentTitle,
  disabled,
  className,
}: CopyExportMenuProps): JSX.Element {
  const src: DocSource = { format, bodyMarkdown, bodyHtml };
  const isEmpty = isDocEmpty(src);
  const isDisabled = disabled === true || isEmpty;

  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [successByActionId, setSuccessByActionId] = useState<
    Record<string, true>
  >({});
  const containerRef = useRef<HTMLDivElement>(null);
  const successTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const menuId = useId();

  // Close on outside click / Esc, with the menu container as the
  // boundary. Capturing-phase listener so an item handler running
  // inside the menu can still complete before the menu closes.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (!target || !containerRef.current) return;
      if (!containerRef.current.contains(target)) {
        setOpen(false);
      }
    };
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKeydown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onKeydown);
    };
  }, [open]);

  // Clear lingering success timers on unmount so we don't try to set
  // state after teardown.
  useEffect(() => {
    return () => {
      const timers = successTimersRef.current;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const triggerAction = useCallback(
    async (action: MenuAction) => {
      try {
        await action.run(src, documentTitle);
        // Show the success label for SUCCESS_LABEL_MS, then revert.
        setSuccessByActionId((prev) => ({ ...prev, [action.id]: true }));
        const existing = successTimersRef.current.get(action.id);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          setSuccessByActionId((prev) => {
            const next = { ...prev };
            delete next[action.id];
            return next;
          });
          successTimersRef.current.delete(action.id);
        }, SUCCESS_LABEL_MS);
        successTimersRef.current.set(action.id, timer);
      } catch {
        // Swallow — clipboard / download can reject when permissions
        // are denied. The caller decides whether to surface a banner;
        // we just suppress so the menu stays usable.
      }
      setOpen(false);
    },
    [documentTitle, src],
  );

  const handleTriggerKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (isDisabled) return;
    if (
      event.key === 'ArrowDown' ||
      event.key === 'Enter' ||
      event.key === ' '
    ) {
      event.preventDefault();
      setOpen(true);
      setFocusedIndex(0);
    }
  };

  const handleMenuKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setFocusedIndex((i) => (i + 1) % MENU_ACTIONS.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setFocusedIndex(
        (i) => (i - 1 + MENU_ACTIONS.length) % MENU_ACTIONS.length,
      );
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const action = MENU_ACTIONS[focusedIndex];
      if (action) void triggerAction(action);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  const classes = ['copy-export-menu-root', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={containerRef} className={classes}>
      <button
        type="button"
        className="copy-export-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={isDisabled}
        title={isEmpty ? 'Doc is empty' : undefined}
        onClick={() => {
          if (isDisabled) return;
          setOpen((v) => !v);
          setFocusedIndex(0);
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        Copy / Export
        <span aria-hidden="true" className="copy-export-menu-caret">
          {' '}
          ▾
        </span>
      </button>
      {open ? (
        <div
          role="menu"
          id={menuId}
          className="copy-export-menu"
          aria-label="Copy or export document"
          onKeyDown={handleMenuKeyDown}
          tabIndex={-1}
        >
          <div className="copy-export-menu-section-title">Copy as</div>
          {MENU_ACTIONS.filter((a) => a.section === 'copy').map((action) => (
            <MenuItem
              key={action.id}
              action={action}
              focused={MENU_ACTIONS[focusedIndex]?.id === action.id}
              success={successByActionId[action.id] === true}
              onSelect={() => void triggerAction(action)}
              onMouseEnter={() =>
                setFocusedIndex(
                  MENU_ACTIONS.findIndex((a) => a.id === action.id),
                )
              }
            />
          ))}
          <div className="copy-export-menu-section-title">Export as file</div>
          {MENU_ACTIONS.filter((a) => a.section === 'export').map((action) => (
            <MenuItem
              key={action.id}
              action={action}
              focused={MENU_ACTIONS[focusedIndex]?.id === action.id}
              success={successByActionId[action.id] === true}
              onSelect={() => void triggerAction(action)}
              onMouseEnter={() =>
                setFocusedIndex(
                  MENU_ACTIONS.findIndex((a) => a.id === action.id),
                )
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface MenuItemProps {
  action: MenuAction;
  focused: boolean;
  success: boolean;
  onSelect: () => void;
  onMouseEnter: () => void;
}

function MenuItem({
  action,
  focused,
  success,
  onSelect,
  onMouseEnter,
}: MenuItemProps): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focused) {
      ref.current?.focus();
    }
  }, [focused]);
  return (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      className={[
        'copy-export-menu-item',
        focused ? 'copy-export-menu-item-focused' : '',
        success ? 'copy-export-menu-item-success' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onSelect}
      onMouseEnter={onMouseEnter}
    >
      {success ? action.successLabel : action.label}
    </button>
  );
}
