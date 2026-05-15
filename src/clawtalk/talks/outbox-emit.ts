// Outbox-event producer wrappers.
//
// Two routing paths:
//
//   emitOutboxEvent — in-tx path. The INSERT joins the surrounding
//   withUserContext transaction; the notify is queued on
//   notifyQueueStorage and fires AFTER db.begin resolves. Used by
//   the 11 state-change producers in `accessors.ts` and the 1 in
//   `job-accessors.ts:1044`. Run-state events (talk_run_started,
//   talk_run_completed, message_appended, etc.) stay atomic with
//   their underlying state changes.
//
//   emitOutboxEventOutsideTx — out-of-band path (G1). The INSERT
//   commits immediately on a fresh auto-commit connection (sibling
//   to any surrounding tx); the notify is enqueued on the streaming
//   coalescer (50ms debounce, one drain per owner per window).
//   Used ONLY by run-worker.emitExecutionEvent for streaming events
//   (talk_response_delta, talk_progress_*, talk_response_started,
//   talk_response_completed/failed/cancelled from the executor)
//   that must surface to subscribers DURING the run, not at run end.
//
// Both wrappers no-op the notify side in Node mode (no
// notifyQueueStorage / streamingCoalesceStorage scope active) — the
// in-process SSE notifier still fires via the legacy outbox-notifier
// path until U6 retires Node-mode SSE.

import {
  appendOutboxEvent,
  appendOutboxEventOutsideTx,
} from '../db/accessors.js';
import {
  getCurrentNotifyQueue,
  getStreamingCoalesceMap,
  type NotifyQueueEntry,
} from '../../db.js';
import { notifyOutboxEvent } from './outbox-notifier.js';
import { enqueueStreamingNotify } from './streaming-notify.js';

export interface EmitOutboxEventInput {
  topic: string;
  eventType: string;
  payload: Record<string, unknown>;
  ownerIds: string[];
}

/**
 * In-tx emit. Returns the new event_id once the INSERT resolves on
 * the surrounding tx; queues the notify entry for post-commit flush
 * via the outer `withUserContext` / `withNotifyQueueScope` scope.
 */
export async function emitOutboxEvent(
  input: EmitOutboxEventInput,
): Promise<number> {
  const eventId = await appendOutboxEvent({
    topic: input.topic,
    eventType: input.eventType,
    payload: input.payload,
  });
  const queue = getCurrentNotifyQueue();
  if (queue) {
    const entry: NotifyQueueEntry = {
      topic: input.topic,
      eventId,
      ownerIds: input.ownerIds,
    };
    queue.push(entry);
  } else {
    // Node-mode fallback: no queue scope is active (Node startup
    // recovery path, or any in-process caller that hasn't wrapped
    // its work in withUserContext / withNotifyQueueScope). Wake up
    // in-process SSE waiters directly. Cloud mode never lands here
    // because the request scope opens the queue.
    queueMicrotask(() => {
      notifyOutboxEvent({ topic: input.topic, eventId });
    });
  }
  return eventId;
}

/**
 * Out-of-band emit (G1). INSERT on a fresh auto-commit connection
 * sibling to any surrounding tx; notify is enqueued on the streaming
 * coalescer. The INSERT resolves before this function returns; the
 * notify fires up to ~50ms later via the debounce timer.
 */
export async function emitOutboxEventOutsideTx(
  input: EmitOutboxEventInput,
): Promise<number> {
  const eventId = await appendOutboxEventOutsideTx({
    topic: input.topic,
    eventType: input.eventType,
    payload: input.payload,
  });
  if (getStreamingCoalesceMap()) {
    for (const ownerId of input.ownerIds) {
      enqueueStreamingNotify({ eventId, topic: input.topic, ownerId });
    }
  } else {
    // Node-mode fallback — wake in-process SSE waiters directly.
    queueMicrotask(() => {
      notifyOutboxEvent({ topic: input.topic, eventId });
    });
  }
  return eventId;
}
