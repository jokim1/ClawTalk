import { useEffect, useMemo, useState } from 'react';

import type { TalkMessage } from '../lib/api';
import './TalkHistoryEditor.css';

type TalkHistoryEditorProps = {
  isOpen: boolean;
  messages: TalkMessage[];
  selectedCountLabel?: string;
  busy?: boolean;
  errorMessage?: string | null;
  onClose: () => void;
  onConfirm: (messageIds: string[]) => void;
  resolveActorLabel: (message: TalkMessage) => string | null;
};

function summarizeMessage(message: TalkMessage): string {
  const compact = message.content.trim().replace(/\s+/g, ' ');
  if (!compact) return '(empty message)';
  return compact.length > 220 ? `${compact.slice(0, 220)}…` : compact;
}

function formatRoleLabel(message: TalkMessage, actorLabel: string | null): string {
  if (message.role === 'user') return 'You';
  if (message.role === 'assistant') {
    return actorLabel ? `${actorLabel}` : 'Assistant';
  }
  if (message.role === 'tool') {
    return actorLabel ? `${actorLabel} tool` : 'Tool';
  }
  return 'System';
}

export function TalkHistoryEditor({
  isOpen,
  messages,
  selectedCountLabel,
  busy = false,
  errorMessage = null,
  onClose,
  onConfirm,
  resolveActorLabel,
}: TalkHistoryEditorProps): JSX.Element | null {
  const editableMessages = useMemo(
    () => messages.filter((message) => message.role !== 'system'),
    [messages],
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isOpen) return;
    setSelectedIds(new Set());
  }, [isOpen, messages]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [busy, isOpen, onClose]);

  if (!isOpen) return null;

  const selectedCount = selectedIds.size;
  const selectionLabel =
    selectedCountLabel ||
    `${selectedCount} message${selectedCount === 1 ? '' : 's'} selected`;

  const toggleMessage = (messageId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  };

  return (
    <div
      className="talk-history-editor-backdrop"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <section
        className="talk-history-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="talk-history-editor-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <header className="talk-history-editor-header">
          <div className="talk-history-editor-title">
            <h2 id="talk-history-editor-title">Edit history</h2>
            <button type="button" onClick={onClose} disabled={busy}>
              Close
            </button>
          </div>
          <p>
            Select messages to delete from this Talk. Future runs will start from
            the edited history, and the cached executor session will be reset.
          </p>
          {errorMessage ? (
            <div className="inline-banner inline-banner-error" role="alert">
              {errorMessage}
            </div>
          ) : null}
        </header>

        <div className="talk-history-editor-toolbar">
          <span className="talk-history-editor-footer-summary">{selectionLabel}</span>
          <div className="talk-history-editor-toolbar-actions">
            <button
              type="button"
              onClick={() =>
                setSelectedIds(new Set(editableMessages.map((message) => message.id)))
              }
              disabled={busy || editableMessages.length === 0}
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              disabled={busy || selectedCount === 0}
            >
              Clear selection
            </button>
          </div>
        </div>

        {editableMessages.length === 0 ? (
          <div className="talk-history-editor-empty">
            There are no editable messages in this Talk yet.
          </div>
        ) : (
          <div className="talk-history-editor-list">
            {editableMessages.map((message) => {
              const actorLabel = resolveActorLabel(message);
              const roleLabel = formatRoleLabel(message, actorLabel);
              const isSelected = selectedIds.has(message.id);
              return (
                <article
                  key={message.id}
                  className={`talk-history-editor-row${
                    isSelected ? ' talk-history-editor-row-selected' : ''
                  }`}
                >
                  <label>
                    <div className="talk-history-editor-row-header">
                      <div className="talk-history-editor-row-meta">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleMessage(message.id)}
                          disabled={busy}
                        />
                        <span className="talk-history-editor-row-role">{roleLabel}</span>
                        <time className="talk-history-editor-row-time">
                          {new Date(message.createdAt).toLocaleString()}
                        </time>
                      </div>
                    </div>
                    <p className="talk-history-editor-row-preview">
                      {summarizeMessage(message)}
                    </p>
                  </label>
                </article>
              );
            })}
          </div>
        )}

        <footer className="talk-history-editor-footer">
          <span className="talk-history-editor-footer-summary">
            Tip: type <code>/edit</code> in the composer to open this panel.
          </span>
          <div className="talk-history-editor-footer-actions">
            <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-btn"
              onClick={() => onConfirm(Array.from(selectedIds))}
              disabled={busy || selectedCount === 0}
            >
              {busy ? 'Deleting…' : 'Delete selected'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
