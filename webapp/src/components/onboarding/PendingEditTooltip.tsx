// First-time tooltip shown the first time a user sees a pending agent
// edit. Anchored to the banner on desktop, the tray on mobile. Uses a
// localStorage flag so each user only sees it once (plan D8).

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'clawtalk:pending-edit-tooltip-seen';

function hasSeenTooltip(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return true; // privacy mode — treat as seen so we don't bug the user.
  }
}

function markTooltipSeen(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // ignore
  }
}

export interface PendingEditTooltipProps {
  // Whether the rest of the pending-edit UI is currently visible.
  // The tooltip only renders when there's actually a pending edit to
  // explain.
  visible: boolean;
}

export function PendingEditTooltip(
  props: PendingEditTooltipProps,
): JSX.Element | null {
  const [dismissed, setDismissed] = useState<boolean>(() => hasSeenTooltip());

  useEffect(() => {
    if (!props.visible || dismissed) return;
    const onAnyInteraction = () => {
      setDismissed(true);
      markTooltipSeen();
    };
    document.addEventListener('mousedown', onAnyInteraction, { once: true });
    document.addEventListener('keydown', onAnyInteraction, { once: true });
    document.addEventListener('touchstart', onAnyInteraction, { once: true });
    return () => {
      document.removeEventListener('mousedown', onAnyInteraction);
      document.removeEventListener('keydown', onAnyInteraction);
      document.removeEventListener('touchstart', onAnyInteraction);
    };
  }, [props.visible, dismissed]);

  if (!props.visible || dismissed) return null;

  return (
    <div className="pending-edit-tooltip" role="status">
      Red text is a pending agent edit. Tap ✓ to accept, ✕ to reject, or just
      type to accept and edit.
    </div>
  );
}
