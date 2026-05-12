import { useEffect, useRef, useState } from 'react';

type InlineEditableTitleProps = {
  title: string;
  onSave: (title: string) => Promise<void> | void;
  buttonClassName?: string;
  inputClassName?: string;
  errorClassName?: string;
  renameLabel?: string;
};

export function InlineEditableTitle({
  title,
  onSave,
  buttonClassName = 'inline-editable-title-button',
  inputClassName = 'inline-editable-title-input',
  errorClassName = 'inline-editable-title-error',
  renameLabel = 'Rename thread',
}: InlineEditableTitleProps): JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const saveOnBlurRef = useRef(true);

  useEffect(() => {
    if (!isEditing) {
      setDraft(title);
      setError(null);
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
      setError('Thread title cannot be empty.');
      return;
    }
    if (trimmed === title.trim()) {
      setIsEditing(false);
      setError(null);
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setIsEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to rename thread.');
    } finally {
      setIsSaving(false);
    }
  }

  if (!isEditing) {
    return (
      <div className="inline-editable-title">
        <button
          type="button"
          className={buttonClassName}
          onClick={() => setIsEditing(true)}
          aria-label={renameLabel}
          title={renameLabel}
        >
          {title}
        </button>
        {error ? (
          <p className={errorClassName} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="inline-editable-title">
      <input
        ref={inputRef}
        className={inputClassName}
        type="text"
        value={draft}
        aria-label={renameLabel}
        disabled={isSaving}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void commit(draft);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            saveOnBlurRef.current = false;
            setDraft(title);
            setIsEditing(false);
            setError(null);
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
