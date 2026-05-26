// Talk-scoped tool toggle bar (chip row above the composer).
//
// Renders one chip per family in `available` (the families some agent in
// this Talk can actually use). Clicking a chip optimistically flips the
// `active` state and PATCHes the server; on failure the local state
// reverts. External `talk_tools_changed` events (e.g. another tab toggled
// a chip) come in via props and refresh the bar.
//
// The chip set ORDER is locked to TOOL_FAMILY_ORDER so this bar reads
// consistently with the agent-config "Tool capabilities" section
// (RegisteredAgentsPanel). Both surfaces import labels from the same
// shared module — see webapp/src/lib/tool-families.ts.

import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  getTalkTools,
  updateTalkTool,
  type TalkToolsState,
} from '../lib/api';
import { TOOL_FAMILY_ORDER, TOOL_NAMES } from '../lib/tool-families';

export interface ToolChipsBarProps {
  talkId: string;
  // External event-driven refresh trigger (incremented by parent each
  // time a `talk_tools_changed` WebSocket event arrives for this Talk).
  refreshKey?: number;
  // Lets the parent show a passive error or status when a toggle fails.
  onError?: (message: string) => void;
}

export function ToolChipsBar({
  talkId,
  refreshKey,
  onError,
}: ToolChipsBarProps): JSX.Element | null {
  const [state, setState] = useState<TalkToolsState | null>(null);
  const [pendingFamilies, setPendingFamilies] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    let cancelled = false;
    getTalkTools(talkId)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((err) => {
        if (!cancelled) {
          onError?.(
            err instanceof Error
              ? err.message
              : 'Failed to load tool toggles',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [talkId, refreshKey, onError]);

  const onToggle = useCallback(
    async (family: string) => {
      if (!state) return;
      const prevEnabled = state.active[family] === true;
      const nextEnabled = !prevEnabled;
      // Optimistic update.
      setState((prev) =>
        prev
          ? {
              ...prev,
              active: { ...prev.active, [family]: nextEnabled },
            }
          : prev,
      );
      setPendingFamilies((prev) => {
        const next = new Set(prev);
        next.add(family);
        return next;
      });
      try {
        const updated = await updateTalkTool({
          talkId,
          family,
          enabled: nextEnabled,
        });
        setState(updated);
      } catch (err) {
        // Revert on failure.
        setState((prev) =>
          prev
            ? {
                ...prev,
                active: { ...prev.active, [family]: prevEnabled },
              }
            : prev,
        );
        const message =
          err instanceof ApiError || err instanceof Error
            ? err.message
            : 'Failed to update tool toggle';
        onError?.(message);
      } finally {
        setPendingFamilies((prev) => {
          const next = new Set(prev);
          next.delete(family);
          return next;
        });
      }
    },
    [state, talkId, onError],
  );

  if (!state) return null;
  const availableSet = new Set(state.available);
  // Render in TOOL_FAMILY_ORDER so chips appear in the same order as the
  // agent-config screen, regardless of how the server returned them.
  const familiesToRender = TOOL_FAMILY_ORDER.filter((slug) =>
    availableSet.has(slug),
  );
  if (familiesToRender.length === 0) return null;

  return (
    <div className="tool-chips-bar" role="group" aria-label="Talk tools">
      {familiesToRender.map((family) => {
        const enabled = state.active[family] === true;
        const pending = pendingFamilies.has(family);
        return (
          <button
            key={family}
            type="button"
            className={`tool-chip${enabled ? ' tool-chip-on' : ''}${pending ? ' tool-chip-pending' : ''}`}
            aria-pressed={enabled}
            disabled={pending}
            onClick={() => {
              void onToggle(family);
            }}
          >
            {TOOL_NAMES[family] ?? family}
          </button>
        );
      })}
    </div>
  );
}
