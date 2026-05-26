// Mobile floating action tray that follows the focused pending block
// (plan D6 / D8). Replaces the right-margin gutter on viewports ≤767px.
//
// Tray surface: ✓ accept, ✕ reject, ‹ › prev/next-block navigation.
// Tapping a pending block in the editor focuses it (scrolls to center,
// sets tray context); the tray dismisses when no pending block is
// focused.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react';

import type { ContentEditRow } from '../../../../src/shared/rich-text/index.js';

export interface PendingChangeTrayProps {
  containerRef: React.RefObject<HTMLElement>;
  pendingEdits: ContentEditRow[];
  inFlightEditIds: Set<string>;
  onAccept: (editId: string) => void;
  onReject: (editId: string) => void;
}

export function PendingChangeTray(
  props: PendingChangeTrayProps,
): JSX.Element | null {
  const editableEdits = useMemo(
    () => props.pendingEdits.filter((e) => e.kind !== 'bulk'),
    [props.pendingEdits],
  );

  const [focusedEditId, setFocusedEditId] = useState<string | null>(null);

  // Reset focus when the list shrinks past the focused id.
  useEffect(() => {
    if (
      focusedEditId &&
      !editableEdits.some((edit) => edit.id === focusedEditId)
    ) {
      setFocusedEditId(editableEdits[0]?.id ?? null);
    } else if (!focusedEditId && editableEdits.length > 0) {
      setFocusedEditId(editableEdits[0].id);
    }
  }, [editableEdits, focusedEditId]);

  // Click handler on the editor surface — pick up clicks inside a
  // pending block and update tray context.
  useEffect(() => {
    const container = props.containerRef.current;
    if (!container) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const wrapper = target.closest('[data-pending-edit-id]');
      if (!wrapper) return;
      const id = wrapper.getAttribute('data-pending-edit-id');
      if (!id) return;
      if (editableEdits.some((e) => e.id === id)) {
        setFocusedEditId(id);
      }
    };
    container.addEventListener('click', onClick);
    return () => container.removeEventListener('click', onClick);
  }, [props.containerRef, editableEdits]);

  const focusedIndex = focusedEditId
    ? editableEdits.findIndex((edit) => edit.id === focusedEditId)
    : -1;

  const scrollToEdit = useCallback(
    (editId: string) => {
      const container = props.containerRef.current;
      if (!container) return;
      const el = container.querySelector(`[data-pending-edit-id="${editId}"]`);
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    },
    [props.containerRef],
  );

  const navigate = useCallback(
    (direction: 1 | -1) => {
      if (focusedIndex === -1) return;
      const nextIndex =
        (focusedIndex + direction + editableEdits.length) % editableEdits.length;
      const next = editableEdits[nextIndex];
      setFocusedEditId(next.id);
      scrollToEdit(next.id);
    },
    [editableEdits, focusedIndex, scrollToEdit],
  );

  if (!focusedEditId || editableEdits.length === 0) return null;
  const focused = editableEdits[focusedIndex] ?? null;
  if (!focused) return null;

  const inFlight = props.inFlightEditIds.has(focused.id);

  return (
    <div
      className="pending-change-tray"
      role="toolbar"
      aria-label="Pending change controls"
    >
      <button
        type="button"
        className="pending-change-tray-button"
        onClick={() => navigate(-1)}
        disabled={editableEdits.length <= 1}
        aria-label="Previous pending change"
      >
        <ChevronLeft size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="pending-change-tray-button pending-change-tray-button--accept"
        onClick={() => props.onAccept(focused.id)}
        disabled={inFlight}
        aria-label={`Accept this ${focused.kind}`}
      >
        <Check size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="pending-change-tray-button pending-change-tray-button--reject"
        onClick={() => props.onReject(focused.id)}
        disabled={inFlight}
        aria-label={`Reject this ${focused.kind}`}
      >
        <X size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="pending-change-tray-button"
        onClick={() => navigate(1)}
        disabled={editableEdits.length <= 1}
        aria-label="Next pending change"
      >
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
