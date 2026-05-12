import { randomUUID } from 'crypto';

import { getDb } from '../../db.js';
import type {
  BrowserBlockMetadata,
  ExecutionDecisionMetadata,
  BrowserResumeMetadata,
} from '../browser/metadata.js';
import {
  appendOutboxEvent,
  countRunnableMainRuns,
  getTalkRunBrowserSessionId,
  getTalkRunBlockedReason,
  getTalkRunById,
  inferTalkRunBlockedReasonFromBrowserBlock,
  queueNextDeferredMainRunIfIdle,
  type TalkRunRecord,
} from './accessors.js';

function parseMetadata(
  metadataJson: string | null | undefined,
): Record<string, unknown> {
  if (!metadataJson) return {};
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignored
  }
  return {};
}

function parseMetadataField<T>(
  metadataJson: string | null | undefined,
  key: string,
): T | null {
  const metadata = parseMetadata(metadataJson);
  const value = metadata[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as T;
}

function runTopic(run: TalkRunRecord): string {
  return run.talk_id ? `talk:${run.talk_id}` : `user:${run.requested_by}`;
}

function serializeMetadata(
  run: TalkRunRecord,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): string {
  const nextValue = updater(parseMetadata(run.metadata_json));
  return JSON.stringify(nextValue);
}

export function createRunConfirmation(input: {
  runId: string;
  talkId?: string | null;
  toolId: string;
  actionSummary: string;
  metadata?: Record<string, unknown> | null;
}): string {
  const id = `confirm_${randomUUID()}`;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO run_confirmations (
        id,
        run_id,
        talk_id,
        tool_id,
        action_summary,
        status,
        metadata_json,
        created_at,
        resolved_at,
        resolved_by
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)
    `,
    )
    .run(
      id,
      input.runId,
      input.talkId ?? null,
      input.toolId,
      input.actionSummary,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
    );
  return id;
}

export function getBrowserBlockForRun(
  runId: string,
): BrowserBlockMetadata | null {
  const run = getTalkRunById(runId);
  if (!run) return null;
  return parseMetadataField<BrowserBlockMetadata>(
    run.metadata_json,
    'browserBlock',
  );
}

export function getExecutionDecisionForRun(
  runId: string,
): ExecutionDecisionMetadata | null {
  const run = getTalkRunById(runId);
  if (!run) return null;
  return parseMetadataField<ExecutionDecisionMetadata>(
    run.metadata_json,
    'executionDecision',
  );
}

export function pauseRunForBrowserBlock(input: {
  runId: string;
  browserBlock: BrowserBlockMetadata;
}): { applied: boolean; run: TalkRunRecord | null } {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): { applied: boolean; run: TalkRunRecord | null } => {
      const run = getTalkRunById(txInput.runId);
      if (!run) {
        return { applied: false, run: null };
      }
      if (
        run.status !== 'running' &&
        run.status !== 'queued' &&
        run.status !== 'awaiting_confirmation'
      ) {
        return { applied: false, run };
      }

      const metadataJson = serializeMetadata(run, (current) => ({
        ...current,
        browserBlock: txInput.browserBlock,
        streamedTextPreview:
          txInput.browserBlock.kind === 'session_conflict'
            ? null
            : (current.streamedTextPreview ?? null),
        lastProgressMessage:
          txInput.browserBlock.kind === 'session_conflict'
            ? null
            : (current.lastProgressMessage ?? null),
        lastHeartbeatAt: txInput.browserBlock.updatedAt,
      }));

      getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET status = 'awaiting_confirmation',
              blocked_reason = ?,
              browser_session_id = ?,
              metadata_json = ?,
              cancel_reason = NULL
          WHERE id = ?
        `,
        )
        .run(
          inferTalkRunBlockedReasonFromBrowserBlock(txInput.browserBlock),
          txInput.browserBlock.sessionId,
          metadataJson,
          run.id,
        );

      appendOutboxEvent({
        topic: runTopic(run),
        eventType: 'browser_blocked',
        payload: JSON.stringify({
          runId: run.id,
          talkId: run.talk_id,
          threadId: run.thread_id,
          browserBlock: txInput.browserBlock,
        }),
      });

      if (run.thread_id && run.talk_id == null) {
        queueNextDeferredMainRunIfIdle(
          run.thread_id,
          txInput.browserBlock.updatedAt,
        );
      }

      return {
        applied: true,
        run: {
          ...run,
          status: 'awaiting_confirmation',
          blocked_reason: inferTalkRunBlockedReasonFromBrowserBlock(
            txInput.browserBlock,
          ),
          browser_session_id: txInput.browserBlock.sessionId,
          metadata_json: metadataJson,
        },
      };
    },
  );

  return tx(input);
}

export function resumeBrowserBlockedRun(input: {
  runId: string;
  resumedBy: string;
  browserResume: BrowserResumeMetadata;
}): {
  applied: boolean;
  run: TalkRunRecord | null;
  queueState: 'queued' | 'deferred' | null;
} {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): {
      applied: boolean;
      run: TalkRunRecord | null;
      queueState: 'queued' | 'deferred' | null;
    } => {
      const run = getTalkRunById(txInput.runId);
      if (!run || run.status !== 'awaiting_confirmation') {
        return { applied: false, run: run || null, queueState: null };
      }

      const queueState: 'queued' | 'deferred' =
        run.talk_id == null &&
        run.thread_id &&
        countRunnableMainRuns({
          threadId: run.thread_id,
          excludeRunId: run.id,
        }) > 0
          ? 'deferred'
          : 'queued';

      const metadataJson = serializeMetadata(run, (current) => {
        const next = { ...current };
        if (queueState === 'queued') {
          delete next.browserBlock;
          delete next.resumeRequestedAt;
          delete next.resumeRequestedBy;
        }
        return {
          ...next,
          browserResume: txInput.browserResume,
          ...(queueState === 'deferred'
            ? {
                resumeRequestedAt: txInput.browserResume.resumedAt,
                resumeRequestedBy: txInput.resumedBy,
              }
            : {}),
          lastHeartbeatAt: txInput.browserResume.resumedAt,
        };
      });

      getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET status = ?,
              blocked_reason = ?,
              browser_session_id = ?,
              cancel_reason = NULL,
              ended_at = NULL,
              metadata_json = ?
          WHERE id = ? AND status = 'awaiting_confirmation'
        `,
        )
        .run(
          queueState === 'queued' ? 'queued' : 'awaiting_confirmation',
          queueState === 'queued' ? null : getTalkRunBlockedReason(run),
          queueState === 'queued'
            ? (txInput.browserResume.sessionId ??
                getTalkRunBrowserSessionId(run))
            : getTalkRunBrowserSessionId(run),
          metadataJson,
          run.id,
        );

      appendOutboxEvent({
        topic: runTopic(run),
        eventType: 'browser_unblocked',
        payload: JSON.stringify({
          runId: run.id,
          talkId: run.talk_id,
          threadId: run.thread_id,
          browserResume: txInput.browserResume,
        }),
      });
      if (queueState === 'queued') {
        appendOutboxEvent({
          topic: runTopic(run),
          eventType: run.talk_id ? 'talk_run_queued' : 'main_run_queued',
          payload: JSON.stringify({
            runId: run.id,
            talkId: run.talk_id,
            threadId: run.thread_id,
            status: 'queued',
          }),
        });
      }

      return {
        applied: true,
        run: {
          ...run,
          status: queueState === 'queued' ? 'queued' : 'awaiting_confirmation',
          blocked_reason:
            queueState === 'queued' ? null : getTalkRunBlockedReason(run),
          browser_session_id:
            queueState === 'queued'
              ? (txInput.browserResume.sessionId ??
                getTalkRunBrowserSessionId(run))
              : getTalkRunBrowserSessionId(run),
          metadata_json: metadataJson,
          cancel_reason: null,
          ended_at: null,
        },
        queueState,
      };
    },
  );
  return tx(input);
}

export function rejectBrowserBlockedRun(input: {
  runId: string;
  rejectedBy: string;
  browserResume: BrowserResumeMetadata;
  cancelReason?: string;
}): { applied: boolean; run: TalkRunRecord | null } {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): { applied: boolean; run: TalkRunRecord | null } => {
      const run = getTalkRunById(txInput.runId);
      if (!run || run.status !== 'awaiting_confirmation') {
        return { applied: false, run: run || null };
      }

      const metadataJson = serializeMetadata(run, (current) => {
        const next = { ...current };
        delete next.browserBlock;
        return {
          ...next,
          browserResume: txInput.browserResume,
        };
      });
      const now = new Date().toISOString();

      getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET status = 'cancelled',
              blocked_reason = NULL,
              browser_session_id = NULL,
              ended_at = ?,
              cancel_reason = ?,
              metadata_json = ?
          WHERE id = ? AND status = 'awaiting_confirmation'
        `,
        )
        .run(
          now,
          txInput.cancelReason || 'browser_confirmation_rejected',
          metadataJson,
          run.id,
        );

      appendOutboxEvent({
        topic: runTopic(run),
        eventType: 'browser_unblocked',
        payload: JSON.stringify({
          runId: run.id,
          talkId: run.talk_id,
          threadId: run.thread_id,
          browserResume: txInput.browserResume,
        }),
      });
      appendOutboxEvent({
        topic: runTopic(run),
        eventType: run.talk_id ? 'talk_run_cancelled' : 'main_run_cancelled',
        payload: JSON.stringify({
          runId: run.id,
          talkId: run.talk_id,
          threadId: run.thread_id,
          cancelReason: txInput.cancelReason || 'browser_confirmation_rejected',
        }),
      });

      if (run.thread_id && run.talk_id == null) {
        queueNextDeferredMainRunIfIdle(run.thread_id, now);
      }

      return {
        applied: true,
        run: {
          ...run,
          status: 'cancelled',
          blocked_reason: null,
          browser_session_id: null,
          ended_at: now,
          cancel_reason:
            txInput.cancelReason || 'browser_confirmation_rejected',
          metadata_json: metadataJson,
        },
      };
    },
  );
  return tx(input);
}

export function cancelBrowserBlockedRun(input: {
  runId: string;
  cancelledBy: string;
  cancelReason: string;
}): { applied: boolean; run: TalkRunRecord | null } {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): { applied: boolean; run: TalkRunRecord | null } => {
      const run = getTalkRunById(txInput.runId);
      if (!run || run.status !== 'awaiting_confirmation') {
        return { applied: false, run: run || null };
      }

      const metadataJson = serializeMetadata(run, (current) => {
        const next = { ...current };
        delete next.browserBlock;
        delete next.resumeRequestedAt;
        delete next.resumeRequestedBy;
        return {
          ...next,
          lastHeartbeatAt: new Date().toISOString(),
        };
      });
      const now = new Date().toISOString();

      getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET status = 'cancelled',
              blocked_reason = NULL,
              browser_session_id = NULL,
              ended_at = ?,
              cancel_reason = ?,
              metadata_json = ?
          WHERE id = ? AND status = 'awaiting_confirmation'
        `,
        )
        .run(now, txInput.cancelReason, metadataJson, run.id);

      appendOutboxEvent({
        topic: runTopic(run),
        eventType: 'browser_unblocked',
        payload: JSON.stringify({
          runId: run.id,
          talkId: run.talk_id,
          threadId: run.thread_id,
          cancelReason: txInput.cancelReason,
        }),
      });
      appendOutboxEvent({
        topic: runTopic(run),
        eventType: run.talk_id ? 'talk_run_cancelled' : 'main_run_cancelled',
        payload: JSON.stringify({
          runId: run.id,
          talkId: run.talk_id,
          threadId: run.thread_id,
          cancelReason: txInput.cancelReason,
        }),
      });

      if (run.thread_id && run.talk_id == null) {
        queueNextDeferredMainRunIfIdle(run.thread_id, now);
      }

      return {
        applied: true,
        run: {
          ...run,
          status: 'cancelled',
          blocked_reason: null,
          browser_session_id: null,
          ended_at: now,
          cancel_reason: txInput.cancelReason,
          metadata_json: metadataJson,
        },
      };
    },
  );
  return tx(input);
}

export function resolveRunConfirmation(input: {
  confirmationId: string;
  status: 'approved' | 'rejected';
  resolvedBy: string;
}): boolean {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `
      UPDATE run_confirmations
      SET status = ?,
          resolved_at = ?,
          resolved_by = ?
      WHERE id = ? AND status = 'pending'
    `,
    )
    .run(input.status, now, input.resolvedBy, input.confirmationId);
  return result.changes === 1;
}

export function getPendingRunConfirmationById(confirmationId: string): {
  id: string;
  run_id: string;
  talk_id: string | null;
  tool_id: string;
  action_summary: string;
  metadata_json: string | null;
} | null {
  const row = getDb()
    .prepare(
      `
      SELECT id, run_id, talk_id, tool_id, action_summary, metadata_json
      FROM run_confirmations
      WHERE id = ? AND status = 'pending'
      LIMIT 1
    `,
    )
    .get(confirmationId) as
    | {
        id: string;
        run_id: string;
        talk_id: string | null;
        tool_id: string;
        action_summary: string;
        metadata_json: string | null;
      }
    | undefined;
  return row || null;
}
