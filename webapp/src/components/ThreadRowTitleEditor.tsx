import { useEffect, useRef, useState, type ReactNode } from 'react';

type ThreadRowTitleEditorProps = {
  title: string;
  isEditing: boolean;
  onSave: (title: string) => Promise<void> | void;
  onCancel: () => void;
  staticClassName: string;
  inputClassName: string;
  errorClassName: string;
  leadingVisual?: ReactNode;
  label?: string;
};

export function ThreadRowTitleEditor({
  title,
  isEditing,
  onSave,
  onCancel,
  staticClassName,
  inputClassName,
  errorClassName,
  leadingVisual,
  label = 'Rename thread',
}: ThreadRowTitleEditorProps): JSX.Element {
  const [draft, setDraft] = useState(title);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const saveOnBlurRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isEditing) {
      setDraft(title);
      setError(null);
      setIsSaving(false);
    }
  }, [isEditing, title]);

  useEffect(() => {
    if (!isEditing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isEditing]);

  async function commit(nextTitle: string): Promise<void> {
    const trimmed = nextTitle.trim();
    if (!trimmed) {
      if (mountedRef.current) {
        setError('Thread title cannot be empty.');
      }
      return;
    }
    if (trimmed === title.trim()) {
      onCancel();
      return;
    }
    if (mountedRef.current) {
      setIsSaving(true);
      setError(null);
    }
    try {
      await onSave(trimmed);
    } catch (err) {
      if (mountedRef.current) {
        setError(
          err instanceof Error ? err.message : 'Unable to rename thread.',
        );
      }
    } finally {
      if (mountedRef.current) {
        setIsSaving(false);
      }
    }
  }

  if (!isEditing) {
    return (
      <span className={staticClassName}>
        {leadingVisual}
        {title}
      </span>
    );
  }

  return (
    <div className="thread-row-title-editor">
      <input
        ref={inputRef}
        type="text"
        value={draft}
        className={inputClassName}
        aria-label={label}
        disabled={isSaving}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void commit(draft);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            saveOnBlurRef.current = false;
            onCancel();
          }
        }}
        onBlur={() => {
          const shouldSave = saveOnBlurRef.current;
          saveOnBlurRef.current = true;
          if (shouldSave) {
            void commit(draft);
          }
        }}
      />
      {error ? (
        <p className={errorClassName} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
