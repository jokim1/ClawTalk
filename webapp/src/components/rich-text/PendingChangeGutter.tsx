// Per-change ✓/✕ overlay rendered in the right gutter of the doc pane.
//
// One button-row per pending edit row whose kind != 'bulk' (bulk runs
// are banner-only per plan D10). The overlay reads bounding rects from
// the editor DOM and positions each row at the block's top edge. Re-
// positions on scroll/resize via ResizeObserver; the recompute is rAF-
// batched so many pending blocks don't jank (plan D8).
//
// Mobile (<=767px) is handled by PendingChangeTray instead; the gutter
// hides itself behind a CSS media query.

import { useCallback, useEffect, useRef, useState } from 'react';

import { Check, X } from 'lucide-react';

import type { ContentEditRow } from '../../../../src/shared/rich-text/index.js';

export interface PendingChangeGutterProps {
  containerRef: React.RefObject<HTMLElement>;
  pendingEdits: ContentEditRow[];
  inFlightEditIds: Set<string>;
  onAccept: (editId: string) => void;
  onReject: (editId: string) => void;
}

interface ControlPosition {
  editId: string;
  top: number;
  kind: ContentEditRow['kind'];
}

// Read the bounding rects of every pending-marked block inside the
// container and project them into the container's local coord space.
// rAF-batched: one read per animation frame even if multiple observers
// fire in the same tick.
function readPositions(
  container: HTMLElement,
  pendingEdits: ContentEditRow[],
): ControlPosition[] {
  const containerRect = container.getBoundingClientRect();
  const positions: ControlPosition[] = [];
  const seen = new Set<string>();
  for (const edit of pendingEdits) {
    if (edit.kind === 'bulk') continue;
    if (seen.has(edit.id)) continue;
    const selector = `[data-pending-edit-id="${edit.id}"]`;
    const el = container.querySelector(selector);
    if (!el) continue;
    const rect = (el as HTMLElement).getBoundingClientRect();
    positions.push({
      editId: edit.id,
      top: rect.top - containerRect.top,
      kind: edit.kind,
    });
    seen.add(edit.id);
  }
  return positions;
}

export function PendingChangeGutter(
  props: PendingChangeGutterProps,
): JSX.Element | null {
  const [positions, setPositions] = useState<ControlPosition[]>([]);
  const rafRef = useRef<number | null>(null);

  const scheduleRecompute = useCallback(() => {
    const container = props.containerRef.current;
    if (!container) return;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const fresh = readPositions(container, props.pendingEdits);
      setPositions(fresh);
    });
  }, [props.containerRef, props.pendingEdits]);

  useEffect(() => {
    const container = props.containerRef.current;
    if (!container) {
      setPositions([]);
      return;
    }
    scheduleRecompute();

    const ro = new ResizeObserver(() => scheduleRecompute());
    ro.observe(container);
    const onScroll = () => scheduleRecompute();
    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    // MutationObserver: edits may land via React state updates that
    // change inner DOM positions without firing ResizeObserver.
    const mo = new MutationObserver(() => scheduleRecompute());
    mo.observe(container, { childList: true, subtree: true });

    return () => {
      ro.disconnect();
      mo.disconnect();
      container.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [props.containerRef, scheduleRecompute]);

  // Recompute whenever the pending list changes (new edits, accepted,
  // rejected) — the deps in scheduleRecompute already cover it via
  // closure capture, but kick the loop explicitly so a render-only
  // change picks it up.
  useEffect(() => {
    scheduleRecompute();
  }, [scheduleRecompute, props.pendingEdits]);

  if (positions.length === 0) return null;

  return (
    <div
      className="pending-change-gutter"
      aria-label="Pending change controls"
      role="group"
    >
      {positions.map((pos) => {
        const inFlight = props.inFlightEditIds.has(pos.editId);
        return (
          <div
            key={pos.editId}
            className="pending-change-gutter-row"
            style={{ top: `${pos.top}px` }}
          >
            <button
              type="button"
              className="pending-change-gutter-button pending-change-gutter-button--accept"
              onClick={() => props.onAccept(pos.editId)}
              disabled={inFlight}
              aria-label={`Accept this ${pos.kind}`}
              title={`Accept this ${pos.kind}`}
            >
              <Check size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="pending-change-gutter-button pending-change-gutter-button--reject"
              onClick={() => props.onReject(pos.editId)}
              disabled={inFlight}
              aria-label={`Reject this ${pos.kind}`}
              title={`Reject this ${pos.kind}`}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
