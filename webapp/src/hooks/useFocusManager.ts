// Focus routing for the pending-edit UI (plan D9).
//
// After Accept/Reject of a pending change, focus moves to the next
// pending change's gutter button. When the last change in the run
// resolves, focus moves to the chat composer.
//
// `prefers-reduced-motion: reduce` is respected — we don't animate
// focus moves; we just .focus() the target.

import { useCallback, useRef } from 'react';

export interface UseFocusManagerInput {
  composerRef?: React.RefObject<HTMLElement | null>;
}

export interface UseFocusManagerResult {
  // Call after an accept/reject mutation resolves. `remainingEditIds`
  // is the new pending list in document order; the hook focuses the
  // gutter button of the first remaining edit, or composer when empty.
  routeFocusAfter: (remainingEditIds: string[]) => void;
}

export function useFocusManager(
  input: UseFocusManagerInput = {},
): UseFocusManagerResult {
  const lastFocusedRef = useRef<string | null>(null);

  const routeFocusAfter = useCallback(
    (remainingEditIds: string[]) => {
      if (remainingEditIds.length === 0) {
        input.composerRef?.current?.focus();
        lastFocusedRef.current = null;
        return;
      }
      const nextId = remainingEditIds[0];
      lastFocusedRef.current = nextId;
      // Lookup the accept button for the next pending edit in the DOM.
      // Tied loosely to the gutter component's data attribute.
      const selector = `[data-pending-edit-id="${nextId}"]`;
      const block = document.querySelector(selector);
      if (!block) return;
      const blockRect = block.getBoundingClientRect();
      // Find the gutter button whose row top matches this block's top
      // (within a few px tolerance). Each row carries [data-pending-
      // edit-id] too — see PendingChangeGutter for the matching attr.
      const gutterRow = document.querySelector(
        `.pending-change-gutter-row [aria-label*="${nextId}"], .pending-change-gutter-row [data-pending-edit-id="${nextId}"]`,
      );
      if (gutterRow instanceof HTMLElement) {
        gutterRow.focus();
        return;
      }
      // Fallback: focus the block itself (visible cue, no nav).
      if (block instanceof HTMLElement) {
        block.focus({ preventScroll: false });
        void blockRect;
      }
    },
    [input.composerRef],
  );

  return { routeFocusAfter };
}
