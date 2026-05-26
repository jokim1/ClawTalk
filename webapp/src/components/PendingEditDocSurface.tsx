// Wires the AgentEditRunBanner, the editor, and the per-change
// mutation hook together for the doc pane. Owned by TalkDetailPage —
// extracted into a standalone component so the page file doesn't have
// to inline ~150 LOC of pending-edit plumbing.

import { useCallback, useEffect, useMemo, useRef } from 'react';

import { RichTextEditor } from './rich-text/RichTextEditor';
import { AgentEditRunBanner } from './AgentEditRunBanner';
import { PendingEditTooltip } from './onboarding/PendingEditTooltip';
import {
  listPendingRunIds,
  type ContentEditRow,
} from '../../../src/shared/rich-text/index.js';
import {
  acceptContentEdit,
  acceptContentEditRun,
  rejectContentEdit,
  rejectContentEditRun,
  ApiError,
  type Content,
  type ContentEditSummary,
} from '../lib/api';

export interface PendingEditDocSurfaceProps {
  content: Content;
  pendingEdits: ContentEditSummary[];
  streamingByRunId: Map<string, string | null>;
  inFlightEditIds: Set<string>;
  canEditDoc: boolean;
  conflict: boolean;
  onSaved: (content: Content) => void;
  onConflict: () => void;
  onError: (error: Error) => void;
  onStatusChange: (status: 'idle' | 'pending' | 'saving' | 'saved' | 'error') => void;
  setPendingEdits: (next: ContentEditSummary[]) => void;
  setInFlightEditIds: (
    update: (prev: Set<string>) => Set<string>,
  ) => void;
  refetchTalkContent: () => Promise<Content | null>;
}

function toEditRow(summary: ContentEditSummary): ContentEditRow {
  return {
    id: summary.id,
    contentId: summary.contentId,
    runId: summary.runId,
    agentId: summary.agentId,
    agentNickname: summary.agentNickname,
    messageId: summary.messageId,
    kind: summary.kind,
    baseContentVersion: summary.baseContentVersion,
    targetAnchorId: summary.targetAnchorId,
    newMarkdown: summary.newMarkdown,
    rationale: summary.rationale,
    createdAt: summary.createdAt,
  };
}

export function PendingEditDocSurface(
  props: PendingEditDocSurfaceProps,
): JSX.Element {
  const pendingRows = useMemo(
    () => props.pendingEdits.map(toEditRow),
    [props.pendingEdits],
  );
  const runIds = useMemo(() => listPendingRunIds(pendingRows), [pendingRows]);
  const activeRunId = runIds[runIds.length - 1] ?? null;
  const streamingRunId = useMemo(() => {
    for (const [runId] of props.streamingByRunId) {
      if (!runIds.includes(runId)) return runId;
    }
    return null;
  }, [props.streamingByRunId, runIds]);
  const streamingAgentNickname =
    streamingRunId !== null
      ? (props.streamingByRunId.get(streamingRunId) ?? null)
      : null;

  // Per-block implicit accept queue. The editor calls into us when the
  // user types inside a pending-edit block; we collect the IDs and feed
  // them to the next autosave PATCH via acceptPendingEditsOnSave.
  const queuedImplicitAcceptsRef = useRef<Set<string>>(new Set());
  const enqueueImplicitAccept = useCallback((editId: string) => {
    queuedImplicitAcceptsRef.current.add(editId);
  }, []);
  const drainImplicitAccepts = useCallback((): string[] => {
    const out = Array.from(queuedImplicitAcceptsRef.current);
    queuedImplicitAcceptsRef.current.clear();
    return out;
  }, []);
  const consumeAcceptedPendingEditIds = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      props.setPendingEdits(
        props.pendingEdits.filter((edit) => !ids.includes(edit.id)),
      );
    },
    [props],
  );

  const setOptimistic = useCallback(
    (next: ContentEditSummary[]) => props.setPendingEdits(next),
    [props],
  );

  // Centralised mutation dispatcher. Each surface (banner, gutter, tray)
  // calls into the same helpers; the wiring stays small and we don't
  // re-implement optimistic + conflict + focus logic per surface.
  const fireAction = useCallback(
    async (
      target:
        | { kind: 'edit'; editId: string }
        | { kind: 'run'; runId: string },
      action: 'accept' | 'reject',
    ) => {
      const key =
        target.kind === 'edit' ? `edit:${target.editId}` : `run:${target.runId}`;
      props.setInFlightEditIds((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      // Optimistic local strip
      const optimistic = props.pendingEdits.filter((edit) =>
        target.kind === 'edit'
          ? edit.id !== target.editId
          : edit.runId !== target.runId,
      );
      setOptimistic(optimistic);
      try {
        if (target.kind === 'edit' && action === 'accept') {
          const out = await acceptContentEdit({
            contentId: props.content.id,
            editId: target.editId,
            expectedContentVersion: props.content.bodyVersion,
          });
          props.onSaved(out.content);
        } else if (target.kind === 'edit' && action === 'reject') {
          await rejectContentEdit({
            contentId: props.content.id,
            editId: target.editId,
          });
        } else if (target.kind === 'run' && action === 'accept') {
          const out = await acceptContentEditRun({
            contentId: props.content.id,
            runId: target.runId,
            expectedContentVersion: props.content.bodyVersion,
          });
          props.onSaved(out.content);
        } else if (target.kind === 'run' && action === 'reject') {
          await rejectContentEditRun({
            contentId: props.content.id,
            runId: target.runId,
          });
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'version_conflict') {
          props.onConflict();
          await props.refetchTalkContent();
        } else if (err instanceof ApiError && err.code === 'not_found') {
          // Sibling auto-accept may have cleared the row — refetch.
          await props.refetchTalkContent();
        } else {
          props.onError(
            err instanceof Error ? err : new Error(String(err)),
          );
          // Rollback optimistic strip
          props.setPendingEdits(props.pendingEdits);
        }
      } finally {
        props.setInFlightEditIds((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [props, setOptimistic],
  );

  // Drop any queued implicit-accept ids for edits that no longer exist.
  useEffect(() => {
    const ids = Array.from(queuedImplicitAcceptsRef.current);
    if (ids.length === 0) return;
    const stillPresent = new Set(props.pendingEdits.map((e) => e.id));
    for (const id of ids) {
      if (!stillPresent.has(id)) queuedImplicitAcceptsRef.current.delete(id);
    }
  }, [props.pendingEdits]);

  const showBanner =
    activeRunId !== null || streamingRunId !== null;
  const hasPending = pendingRows.length > 0;

  return (
    <>
      {showBanner && activeRunId !== null ? (
        <AgentEditRunBanner
          pendingEdits={pendingRows}
          runId={activeRunId}
          onAcceptAll={() =>
            fireAction({ kind: 'run', runId: activeRunId }, 'accept')
          }
          onRejectAll={() =>
            fireAction({ kind: 'run', runId: activeRunId }, 'reject')
          }
          isAcceptInFlight={props.inFlightEditIds.has(`run:${activeRunId}`)}
          isRejectInFlight={props.inFlightEditIds.has(`run:${activeRunId}`)}
        />
      ) : null}
      {streamingRunId !== null && activeRunId === null ? (
        <AgentEditRunBanner
          pendingEdits={[]}
          runId={streamingRunId}
          streamingAgentNickname={streamingAgentNickname}
          onAcceptAll={() => {
            /* no-op while streaming */
          }}
          onRejectAll={() => {
            /* no-op while streaming */
          }}
          isAcceptInFlight={false}
          isRejectInFlight={false}
        />
      ) : null}
      <PendingEditTooltip visible={hasPending} />
      <RichTextEditor
        bodyMarkdown={props.content.bodyMarkdown}
        editable={props.canEditDoc && !props.conflict}
        autosave={
          props.canEditDoc
            ? {
                contentId: props.content.id,
                bodyVersion: props.content.bodyVersion,
                onSaved: ({ content }) => {
                  props.onSaved(content);
                },
                onConflict: props.onConflict,
                onError: props.onError,
                onStatusChange: props.onStatusChange,
                acceptPendingEditsOnSave: drainImplicitAccepts,
                consumeAcceptedPendingEditIds,
              }
            : undefined
        }
        pendingEdits={{
          pendingEdits: pendingRows,
          inFlightEditIds: new Set(
            Array.from(props.inFlightEditIds)
              .filter((k) => k.startsWith('edit:'))
              .map((k) => k.slice('edit:'.length)),
          ),
          onAccept: (editId) =>
            fireAction({ kind: 'edit', editId }, 'accept'),
          onReject: (editId) =>
            fireAction({ kind: 'edit', editId }, 'reject'),
          onBlockEdited: enqueueImplicitAccept,
        }}
      />
    </>
  );
}
