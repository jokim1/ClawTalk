// Tiptap editor for the Content feature. PR 3 shipped read-only render;
// PR 4 makes it editable, adds a native-button toolbar + link bubbles,
// and runs a debounced autosave (T17 — keystrokes commit visually
// immediately; the editor reconciles on the server's response rather
// than gating the visible commit on the round trip).
//
// The doc body is markdown. The shared `markdownToTiptapJson` /
// `tiptapJsonToMarkdown` modules are the single transactional surface
// for the editor and the worker — autosave converts via the same
// pipeline so a round-trip is a no-op.

import { type Editor, EditorContent, useEditor } from '@tiptap/react';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import StarterKit from '@tiptap/starter-kit';
import {
  Bold,
  Check,
  ChevronDown,
  ExternalLink,
  Italic,
  Link2,
  List,
  ListOrdered,
  Pencil,
  Strikethrough,
  Type,
  Unlink,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import {
  composeBody,
  ensureAnchorIds,
  isAllowedRichTextLinkUrl,
  markdownToTiptapJson,
  normalizeRichTextLinkUrl,
  tiptapJsonToMarkdown,
  type ContentEditRow,
} from '../../../../src/shared/rich-text/index.js';
import { ApiError, patchContent, type Content } from '../../lib/api';
import {
  AnchorIdExtension,
  makeTransformPasted,
  registerPendingBlockEditedCallback,
} from './anchor-id-extension';
import { PendingReplaceWrapperExtension } from './PendingReplaceWrapperExtension';
import { PendingChangeGutter } from './PendingChangeGutter';
import { PendingChangeTray } from './PendingChangeTray';

export type RichTextEditorSaveStatus =
  | 'idle'
  | 'pending'
  | 'saving'
  | 'saved'
  | 'error';

export type RichTextEditorAutosave = {
  contentId: string;
  bodyVersion: number;
  onSaved: (result: {
    content: Content;
    acceptedPendingEditIds?: string[];
  }) => void;
  onConflict: () => void;
  onError: (error: Error) => void;
  onStatusChange?: (status: RichTextEditorSaveStatus) => void;
  // Per-block implicit accept (plan D2): when the user types inside a
  // pending-edit block, the editor's onPendingBlockEdited fires, the
  // editId is queued, and the next autosave PATCH includes them.
  acceptPendingEditsOnSave?: () => string[];
  consumeAcceptedPendingEditIds?: (ids: string[]) => void;
};

export type RichTextEditorPendingEditsProps = {
  pendingEdits: ContentEditRow[];
  inFlightEditIds: Set<string>;
  onAccept: (editId: string) => void;
  onReject: (editId: string) => void;
  onBlockEdited?: (editId: string) => void;
};

type RichTextEditorProps = {
  bodyMarkdown: string;
  editable?: boolean;
  placeholder?: string;
  autosave?: RichTextEditorAutosave;
  pendingEdits?: RichTextEditorPendingEditsProps;
};

const SAVE_DEBOUNCE_MS = 800;

export function RichTextEditor({
  bodyMarkdown,
  editable = false,
  placeholder,
  autosave,
  pendingEdits,
}: RichTextEditorProps): JSX.Element {
  const initialContent = useMemo(
    () =>
      pendingEdits && pendingEdits.pendingEdits.length > 0
        ? ensureAnchorIds(
            composeBody(bodyMarkdown, pendingEdits.pendingEdits).doc,
          )
        : ensureAnchorIds(markdownToTiptapJson(bodyMarkdown)),
    // Initial-only; subsequent body / pending-edits updates re-run via
    // the effect below so the editor instance keeps its selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const transformPasted = useMemo(() => makeTransformPasted(), []);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Autosave plumbing. Refs guard against React closure staleness in
  // the editor's onUpdate callback — useEditor reads its options once
  // on mount, so the inner callback would otherwise capture the
  // initial autosave object.
  const autosaveRef = useRef<RichTextEditorAutosave | null>(autosave ?? null);
  const bodyVersionRef = useRef<number>(autosave?.bodyVersion ?? 0);
  const lastSavedMarkdownRef = useRef<string>(bodyMarkdown);
  const pendingMarkdownRef = useRef<string>(bodyMarkdown);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const statusRef = useRef<RichTextEditorSaveStatus>('idle');

  useEffect(() => {
    autosaveRef.current = autosave ?? null;
    if (autosave) bodyVersionRef.current = autosave.bodyVersion;
  }, [autosave]);

  const reportStatus = useCallback((next: RichTextEditorSaveStatus) => {
    if (statusRef.current === next) return;
    statusRef.current = next;
    autosaveRef.current?.onStatusChange?.(next);
  }, []);

  const performSave = useCallback(async (): Promise<void> => {
    const cfg = autosaveRef.current;
    if (!cfg) return;
    if (savingRef.current) return;
    const next = pendingMarkdownRef.current;
    const acceptIds = cfg.acceptPendingEditsOnSave?.() ?? [];
    const sameBody = next === lastSavedMarkdownRef.current;
    if (sameBody && acceptIds.length === 0) {
      reportStatus('saved');
      return;
    }
    savingRef.current = true;
    reportStatus('saving');
    try {
      const result = await patchContent({
        contentId: cfg.contentId,
        expectedVersion: bodyVersionRef.current,
        bodyMarkdown: sameBody ? undefined : next,
        acceptPendingEditIds: acceptIds.length > 0 ? acceptIds : undefined,
      });
      lastSavedMarkdownRef.current = result.content.bodyMarkdown;
      bodyVersionRef.current = result.content.bodyVersion;
      cfg.onSaved(result);
      if (
        result.acceptedPendingEditIds &&
        result.acceptedPendingEditIds.length > 0
      ) {
        cfg.consumeAcceptedPendingEditIds?.(result.acceptedPendingEditIds);
      }
      if (pendingMarkdownRef.current === next) {
        reportStatus('saved');
      } else {
        reportStatus('pending');
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'version_conflict') {
        reportStatus('error');
        cfg.onConflict();
      } else {
        reportStatus('error');
        cfg.onError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      savingRef.current = false;
      // A keystroke during the in-flight save left the buffer ahead of
      // what we just persisted — schedule another save so we catch up.
      // Compare against the pre-save snapshot (`next`), NOT against
      // `lastSavedMarkdownRef` (which holds the server's canonical body
      // and may drift from the editor's client-side serialization for
      // round-trip-stable but byte-different forms, e.g. trailing
      // newlines or anchor encoding). Comparing to `lastSavedMarkdownRef`
      // here caused an idle-doc save loop where every PATCH scheduled
      // the next PATCH because server canonical ≠ editor serialization,
      // even with zero user input.
      if (autosaveRef.current && pendingMarkdownRef.current !== next) {
        scheduleSave();
      }
    }
  }, [reportStatus]);

  const scheduleSave = useCallback(() => {
    if (!autosaveRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    reportStatus('pending');
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void performSave();
    }, SAVE_DEBOUNCE_MS);
  }, [performSave, reportStatus]);

  const editor = useEditor({
    content: initialContent,
    editable,
    extensions: [
      StarterKit.configure({
        undoRedo: editable ? undefined : false,
      }),
      Link.configure({
        autolink: true,
        defaultProtocol: 'https',
        isAllowedUri: (url) => isAllowedRichTextLinkUrl(url),
        openOnClick: !editable,
        linkOnPaste: true,
        HTMLAttributes: {
          rel: 'noopener noreferrer nofollow',
          target: '_blank',
        },
      }),
      Placeholder.configure({
        placeholder: placeholder ?? '',
      }),
      AnchorIdExtension,
      PendingReplaceWrapperExtension,
    ],
    immediatelyRender: false,
    editorProps: {
      transformPasted: (slice) => transformPasted(slice),
    },
    onUpdate: ({ editor: active }) => {
      if (!autosaveRef.current) return;
      const next = tiptapJsonToMarkdown(active.getJSON());
      pendingMarkdownRef.current = next;
      if (next === lastSavedMarkdownRef.current) {
        // user reverted to the last-saved state — clear pending status.
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        reportStatus('saved');
        return;
      }
      scheduleSave();
    },
  });

  // Sync the editor when the parent hands us new markdown that isn't
  // the version we just emitted, OR when the pending-edits list changes
  // (run start / accept / reject). The render-time composer overlays
  // pending edits onto the doc body inside the editor.
  const pendingEditsFingerprint = useMemo(() => {
    if (!pendingEdits || pendingEdits.pendingEdits.length === 0) return '';
    return pendingEdits.pendingEdits.map((e) => `${e.id}:${e.kind}`).join('|');
  }, [pendingEdits]);

  useEffect(() => {
    if (!editor) return;
    const remoteBodyChanged = bodyMarkdown !== lastSavedMarkdownRef.current;
    const echoedSelf = bodyMarkdown === pendingMarkdownRef.current;
    const pendingChanged = pendingEditsFingerprint !== '';

    if (!remoteBodyChanged && !pendingChanged) return;

    if (!remoteBodyChanged && pendingChanged) {
      // Body unchanged, but pending edits shifted — re-compose to reflect.
      const composed =
        pendingEdits && pendingEdits.pendingEdits.length > 0
          ? composeBody(bodyMarkdown, pendingEdits.pendingEdits).doc
          : markdownToTiptapJson(bodyMarkdown);
      editor.commands.setContent(ensureAnchorIds(composed), {
        emitUpdate: false,
      });
      return;
    }

    if (echoedSelf && !pendingChanged) {
      lastSavedMarkdownRef.current = bodyMarkdown;
      return;
    }

    const composed =
      pendingEdits && pendingEdits.pendingEdits.length > 0
        ? composeBody(bodyMarkdown, pendingEdits.pendingEdits).doc
        : markdownToTiptapJson(bodyMarkdown);
    editor.commands.setContent(ensureAnchorIds(composed), {
      emitUpdate: false,
    });
    lastSavedMarkdownRef.current = bodyMarkdown;
    pendingMarkdownRef.current = bodyMarkdown;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    reportStatus('saved');
  }, [bodyMarkdown, editor, pendingEdits, pendingEditsFingerprint, reportStatus]);

  // Forward the global pending-block-edited fire-and-forget event to
  // the consumer-supplied callback. We register at module level so
  // anchor-id-extension's plugin observer can broadcast without each
  // editor instance plumbing its own option.
  useEffect(() => {
    const cb = pendingEdits?.onBlockEdited;
    if (!cb) return;
    return registerPendingBlockEditedCallback((editId) => cb(editId));
  }, [pendingEdits?.onBlockEdited]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editable, editor]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const [isLinkInputOpen, setIsLinkInputOpen] = useState(false);

  const handleLinkButtonClick = useCallback(() => {
    if (!editor) return;
    // If no text is selected, expand to the word under the cursor so
    // the link applies to a meaningful range. Mirrors rocketboard.
    const { from, to } = editor.state.selection;
    if (from === to) {
      const $pos = editor.state.doc.resolve(from);
      const start = $pos.start();
      const text = $pos.parent.textContent;
      const offset = from - start;
      let wordStart = offset;
      let wordEnd = offset;
      while (wordStart > 0 && /\w/.test(text[wordStart - 1])) wordStart--;
      while (wordEnd < text.length && /\w/.test(text[wordEnd])) wordEnd++;
      if (wordStart !== wordEnd) {
        editor
          .chain()
          .focus()
          .setTextSelection({
            from: start + wordStart,
            to: start + wordEnd,
          })
          .run();
      }
    }
    setIsLinkInputOpen(true);
  }, [editor]);

  const closeLinkInput = useCallback(() => {
    setIsLinkInputOpen(false);
    editor?.chain().focus().run();
  }, [editor]);

  return (
    <div className="rich-text-editor">
      {editable ? (
        <RichTextToolbar
          editor={editor}
          onLinkButtonClick={handleLinkButtonClick}
        />
      ) : null}
      <div className="rich-text-editor-canvas" ref={canvasRef}>
        <EditorContent editor={editor} />
        {editor && editable ? (
          <>
            <LinkCreationBubble
              editor={editor}
              isOpen={isLinkInputOpen}
              onClose={closeLinkInput}
            />
            <LinkHoverBubble
              editor={editor}
              isLinkInputOpen={isLinkInputOpen}
            />
          </>
        ) : null}
        {pendingEdits && pendingEdits.pendingEdits.length > 0 ? (
          <>
            <PendingChangeGutter
              containerRef={canvasRef}
              pendingEdits={pendingEdits.pendingEdits}
              inFlightEditIds={pendingEdits.inFlightEditIds}
              onAccept={pendingEdits.onAccept}
              onReject={pendingEdits.onReject}
            />
            <PendingChangeTray
              containerRef={canvasRef}
              pendingEdits={pendingEdits.pendingEdits}
              inFlightEditIds={pendingEdits.inFlightEditIds}
              onAccept={pendingEdits.onAccept}
              onReject={pendingEdits.onReject}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── toolbar ──────────────────────────────────────────────────────

type ToolbarIconButtonProps = {
  active?: boolean;
  disabled?: boolean;
  icon: typeof Bold;
  label: string;
  onClick: () => void;
};

function ToolbarIconButton({
  active = false,
  disabled = false,
  icon: Icon,
  label,
  onClick,
}: ToolbarIconButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className="rich-text-editor-toolbar-button"
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      title={label}
      tabIndex={-1}
    >
      <Icon size={14} aria-hidden="true" />
    </button>
  );
}

const HEADING_LABEL_BY_LEVEL: Record<1 | 2 | 3 | 4, string> = {
  1: 'Heading 1',
  2: 'Heading 2',
  3: 'Heading 3',
  4: 'Heading 4',
};

function activeHeadingLevel(editor: Editor | null): 1 | 2 | 3 | 4 | null {
  if (!editor) return null;
  for (const level of [1, 2, 3, 4] as const) {
    if (editor.isActive('heading', { level })) return level;
  }
  return null;
}

function HeadingDropdown({
  editor,
  disabled,
}: {
  editor: Editor | null;
  disabled: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const activeLevel = activeHeadingLevel(editor);
  const triggerLabel = activeLevel
    ? `H${activeLevel}`
    : 'Normal';

  const runCommand = useCallback(
    (action: (chain: ReturnType<Editor['chain']>) => void) => {
      if (!editor) return;
      const chain = editor.chain().focus();
      action(chain);
      chain.run();
      setOpen(false);
    },
    [editor],
  );

  return (
    <div ref={containerRef} className="rich-text-editor-heading-wrap">
      <button
        type="button"
        className="rich-text-editor-toolbar-button rich-text-editor-heading-trigger"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
        disabled={disabled || !editor}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Paragraph style"
        tabIndex={-1}
      >
        <Type size={14} aria-hidden="true" />
        <span className="rich-text-editor-heading-trigger-label">
          {triggerLabel}
        </span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="rich-text-editor-heading-menu"
          role="menu"
          onMouseDown={(event) => event.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            className="rich-text-editor-heading-menu-item"
            onClick={() => runCommand((chain) => chain.setParagraph())}
          >
            Normal text
          </button>
          {([1, 2, 3, 4] as const).map((level) => (
            <button
              key={level}
              type="button"
              role="menuitem"
              className={`rich-text-editor-heading-menu-item rich-text-editor-heading-menu-item-h${level}`}
              onClick={() =>
                runCommand((chain) => chain.toggleHeading({ level }))
              }
            >
              {HEADING_LABEL_BY_LEVEL[level]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RichTextToolbar({
  editor,
  onLinkButtonClick,
}: {
  editor: Editor | null;
  onLinkButtonClick: () => void;
}): JSX.Element {
  const disabled = !editor;
  return (
    <div
      className="rich-text-editor-toolbar"
      role="toolbar"
      aria-label="Formatting"
      onMouseDown={(event) => event.preventDefault()}
    >
      <HeadingDropdown editor={editor} disabled={disabled} />
      <span className="rich-text-editor-toolbar-divider" aria-hidden="true" />
      <ToolbarIconButton
        active={!!editor?.isActive('bold')}
        disabled={disabled}
        icon={Bold}
        label="Bold"
        onClick={() => editor?.chain().focus().toggleBold().run()}
      />
      <ToolbarIconButton
        active={!!editor?.isActive('italic')}
        disabled={disabled}
        icon={Italic}
        label="Italic"
        onClick={() => editor?.chain().focus().toggleItalic().run()}
      />
      <ToolbarIconButton
        active={!!editor?.isActive('strike')}
        disabled={disabled}
        icon={Strikethrough}
        label="Strikethrough"
        onClick={() => editor?.chain().focus().toggleStrike().run()}
      />
      <ToolbarIconButton
        active={!!editor?.isActive('link')}
        disabled={disabled}
        icon={Link2}
        label={editor?.isActive('link') ? 'Remove link' : 'Insert link'}
        onClick={() => {
          if (!editor) return;
          if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run();
          } else {
            onLinkButtonClick();
          }
        }}
      />
      <span className="rich-text-editor-toolbar-divider" aria-hidden="true" />
      <ToolbarIconButton
        active={!!editor?.isActive('bulletList')}
        disabled={disabled}
        icon={List}
        label="Bulleted list"
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
      />
      <ToolbarIconButton
        active={!!editor?.isActive('orderedList')}
        disabled={disabled}
        icon={ListOrdered}
        label="Numbered list"
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
      />
    </div>
  );
}

// ── link bubbles ─────────────────────────────────────────────────

function getEditorRect(editor: Editor): DOMRect {
  // Position relative to `.rich-text-editor-canvas` because that's the
  // positioned ancestor the absolute-positioned bubbles render inside.
  const wrap = editor.view.dom.closest('.rich-text-editor-canvas');
  if (wrap instanceof HTMLElement) return wrap.getBoundingClientRect();
  return editor.view.dom.getBoundingClientRect();
}

function computeBubblePosition(
  editor: Editor,
  selectionFrom: number,
): { top: number; left: number } | null {
  try {
    const coords = editor.view.coordsAtPos(selectionFrom);
    const rect = getEditorRect(editor);
    return {
      top: coords.bottom - rect.top + 4,
      left: Math.max(0, coords.left - rect.left),
    };
  } catch {
    return null;
  }
}

function LinkCreationBubble({
  editor,
  isOpen,
  onClose,
}: {
  editor: Editor;
  isOpen: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const savedSelectionRef = useRef<{ from: number; to: number } | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(
    null,
  );

  useEffect(() => {
    if (!isOpen) {
      setPosition(null);
      return;
    }
    const { from, to } = editor.state.selection;
    savedSelectionRef.current = { from, to };
    setUrl('');
    setPosition(computeBubblePosition(editor, from) ?? { top: 40, left: 0 });
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [editor, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [isOpen, onClose]);

  const applyLink = useCallback(() => {
    const saved = savedSelectionRef.current;
    if (!saved) return;
    const href = normalizeRichTextLinkUrl(url);
    if (!href) return;
    editor
      .chain()
      .focus()
      .setTextSelection({ from: saved.from, to: saved.to })
      .setLink({ href })
      .run();
    onClose();
  }, [editor, onClose, url]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyLink();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    },
    [applyLink, onClose],
  );

  if (!isOpen || !position) return null;

  return (
    <div
      ref={containerRef}
      className="rich-text-editor-link-bubble"
      style={{ top: position.top, left: position.left }}
      onMouseDown={(event: ReactMouseEvent) => event.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        className="rich-text-editor-link-bubble-input"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Paste or type a URL…"
      />
      <button
        type="button"
        className="rich-text-editor-toolbar-button"
        disabled={!url.trim()}
        onClick={applyLink}
        title="Apply link"
        aria-label="Apply link"
        tabIndex={-1}
      >
        <Check size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

function truncateUrl(value: string, max = 40): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function LinkHoverBubble({
  editor,
  isLinkInputOpen,
}: {
  editor: Editor;
  isLinkInputOpen: boolean;
}): JSX.Element | null {
  const [state, setState] = useState<{
    href: string;
    position: { top: number; left: number };
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const recompute = () => {
      if (isLinkInputOpen || !editor.isActive('link')) {
        setState(null);
        setEditing(false);
        return;
      }
      const attrs = editor.getAttributes('link');
      const href = typeof attrs?.href === 'string' ? attrs.href : '';
      if (!href) {
        setState(null);
        return;
      }
      const { from } = editor.state.selection;
      const position = computeBubblePosition(editor, from);
      if (!position) {
        setState(null);
        return;
      }
      setState({ href, position });
    };
    recompute();
    editor.on('selectionUpdate', recompute);
    editor.on('transaction', recompute);
    return () => {
      editor.off('selectionUpdate', recompute);
      editor.off('transaction', recompute);
    };
  }, [editor, isLinkInputOpen]);

  const startEditing = useCallback(() => {
    if (!state) return;
    setEditValue(state.href);
    setEditing(true);
    window.setTimeout(() => editInputRef.current?.focus(), 0);
  }, [state]);

  const applyEdit = useCallback(() => {
    const href = normalizeRichTextLinkUrl(editValue);
    if (!href) return;
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    setEditing(false);
  }, [editValue, editor]);

  const handleEditKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyEdit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setEditing(false);
      }
    },
    [applyEdit],
  );

  if (!state) return null;

  return (
    <div
      className="rich-text-editor-link-bubble"
      style={{ top: state.position.top, left: state.position.left }}
      onMouseDown={(event: ReactMouseEvent) => event.stopPropagation()}
    >
      {editing ? (
        <>
          <input
            ref={editInputRef}
            type="text"
            className="rich-text-editor-link-bubble-input"
            value={editValue}
            onChange={(event) => setEditValue(event.target.value)}
            onKeyDown={handleEditKeyDown}
            placeholder="Edit URL…"
          />
          <button
            type="button"
            className="rich-text-editor-toolbar-button"
            onClick={applyEdit}
            title="Apply"
            aria-label="Apply"
            tabIndex={-1}
          >
            <Check size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="rich-text-editor-toolbar-button"
            onClick={() => setEditing(false)}
            title="Cancel"
            aria-label="Cancel"
            tabIndex={-1}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </>
      ) : (
        <>
          <span
            className="rich-text-editor-link-bubble-url"
            title={state.href}
          >
            {truncateUrl(state.href)}
          </span>
          <button
            type="button"
            className="rich-text-editor-toolbar-button"
            onClick={startEditing}
            title="Edit link"
            aria-label="Edit link"
            tabIndex={-1}
          >
            <Pencil size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="rich-text-editor-toolbar-button"
            onClick={() => editor.chain().focus().unsetLink().run()}
            title="Remove link"
            aria-label="Remove link"
            tabIndex={-1}
          >
            <Unlink size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="rich-text-editor-toolbar-button"
            onClick={() => {
              const url = normalizeRichTextLinkUrl(state.href);
              if (!url) return;
              window.open(url, '_blank', 'noopener,noreferrer');
            }}
            title="Open link"
            aria-label="Open link"
            tabIndex={-1}
          >
            <ExternalLink size={12} aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}
