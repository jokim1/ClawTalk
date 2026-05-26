// DRY hook for accept/reject mutations on pending content edits.
//
// Consumers (banner + per-change gutter + mobile tray) call `fire` with
// the target (edit-id or run-id) + action (accept/reject). The hook:
//   1. Applies an optimistic local update via the supplied callbacks.
//   2. Fires the correct API route.
//   3. On 409 (CAS conflict), invokes onConflict for refetch+reconcile.
//   4. On 404 (sibling auto-accept), refetches silently.
//   5. On success, routes focus to the next pending change.
//
// Per plan D6: all four UI surfaces consume this hook so there's a
// single source of truth for optimistic + conflict + focus logic.

import { useCallback, useRef, useState } from 'react';

import {
  ApiError,
  acceptContentEdit,
  acceptContentEditRun,
  rejectContentEdit,
  rejectContentEditRun,
  type Content,
  type ContentEditSummary,
} from '../lib/api';

export type PendingMutationTarget =
  | { kind: 'edit'; editId: string }
  | { kind: 'run'; runId: string };

export type PendingMutationAction = 'accept' | 'reject';

export interface UsePendingChangeMutationInput {
  contentId: string;
  expectedContentVersion: number;
  pendingEdits: ContentEditSummary[];
  onOptimisticUpdate: (next: ContentEditSummary[]) => void;
  onConflict: () => void;
  onSuccess?: (next: { content?: Content; editIds: string[] }) => void;
  onError?: (error: Error) => void;
}

export interface UsePendingChangeMutationResult {
  fire: (input: {
    target: PendingMutationTarget;
    action: PendingMutationAction;
  }) => Promise<void>;
  inFlightTargets: Set<string>;
  isFiring: boolean;
}

function targetKey(target: PendingMutationTarget): string {
  return target.kind === 'edit' ? `edit:${target.editId}` : `run:${target.runId}`;
}

function removeEdits(
  edits: ContentEditSummary[],
  predicate: (edit: ContentEditSummary) => boolean,
): ContentEditSummary[] {
  return edits.filter((edit) => !predicate(edit));
}

export function usePendingChangeMutation(
  input: UsePendingChangeMutationInput,
): UsePendingChangeMutationResult {
  const [inFlight, setInFlight] = useState<Set<string>>(() => new Set());
  const pendingRef = useRef<ContentEditSummary[]>(input.pendingEdits);
  pendingRef.current = input.pendingEdits;

  const fire = useCallback(
    async (call: {
      target: PendingMutationTarget;
      action: PendingMutationAction;
    }) => {
      const key = targetKey(call.target);
      if (inFlight.has(key)) return;
      setInFlight((prev) => new Set(prev).add(key));

      // Compute optimistic next list. Reject just drops; accept also
      // drops (the body update will land via the API response or a
      // companion content_updated event).
      const target = call.target;
      const optimisticNext =
        target.kind === 'edit'
          ? removeEdits(pendingRef.current, (e) => e.id === target.editId)
          : removeEdits(pendingRef.current, (e) => e.runId === target.runId);
      input.onOptimisticUpdate(optimisticNext);

      try {
        let resultEditIds: string[] = [];
        let resultContent: Content | undefined;
        if (call.target.kind === 'edit' && call.action === 'accept') {
          const out = await acceptContentEdit({
            contentId: input.contentId,
            editId: call.target.editId,
            expectedContentVersion: input.expectedContentVersion,
          });
          resultEditIds = [out.editId];
          resultContent = out.content;
        } else if (call.target.kind === 'edit' && call.action === 'reject') {
          const out = await rejectContentEdit({
            contentId: input.contentId,
            editId: call.target.editId,
          });
          resultEditIds = [out.editId];
        } else if (call.target.kind === 'run' && call.action === 'accept') {
          const out = await acceptContentEditRun({
            contentId: input.contentId,
            runId: call.target.runId,
            expectedContentVersion: input.expectedContentVersion,
          });
          resultEditIds = out.editIds;
          resultContent = out.content;
        } else if (call.target.kind === 'run' && call.action === 'reject') {
          const out = await rejectContentEditRun({
            contentId: input.contentId,
            runId: call.target.runId,
          });
          resultEditIds = out.editIds;
        }

        input.onSuccess?.({ content: resultContent, editIds: resultEditIds });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'version_conflict') {
          input.onConflict();
        } else if (err instanceof ApiError && err.code === 'not_found') {
          // Sibling auto-accept already cleared it — refetch silently.
          input.onConflict();
        } else {
          input.onError?.(err instanceof Error ? err : new Error(String(err)));
          // Roll back optimistic change by re-asserting prior state.
          input.onOptimisticUpdate(pendingRef.current);
        }
      } finally {
        setInFlight((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [inFlight, input],
  );

  return {
    fire,
    inFlightTargets: inFlight,
    isFiring: inFlight.size > 0,
  };
}
