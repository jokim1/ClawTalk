// G7 — coalesce out-of-band streaming notifies into one DO RPC per
// (ownerId, ~50ms window).
//
// Without coalescing, a streaming run at ~10 deltas/sec issues 10
// DO RPCs/sec per user. The coalescer collects entries in a per-owner
// `PendingDrain` slot on `streamingCoalesceStorage` (opened by
// `withRequestScopedDb` for the request scope's lifetime), schedules
// a setTimeout(50ms) the first time an owner's slot gets a pending
// entry, and flushes via `flushNotifyQueueForOwner` when the timer
// fires.
//
// Scope-exit semantics: `withRequestScopedDb`'s finally block walks
// the streaming coalesce map, clears any pending timer, and flushes
// the remaining entries synchronously so no notifies orphan.
//
// In Node mode (no streaming-coalesce ALS scope), this is a no-op —
// Node-mode SSE has its own in-process notifier.

import {
  flushNotifyQueueForOwner,
  getRequestScopeEnvAndCtx,
  getStreamingCoalesceMap,
  type NotifyQueueEntry,
  type PendingDrain,
} from '../../db.js';

const DEBOUNCE_MS = 50;

export interface StreamingNotifyInput {
  eventId: number;
  topic: string;
  ownerId: string;
}

export function enqueueStreamingNotify(input: StreamingNotifyInput): void {
  const byOwner = getStreamingCoalesceMap();
  if (!byOwner) return;
  const { env, ctx } = getRequestScopeEnvAndCtx();
  if (!env?.USER_EVENT_HUB) return;

  const slot: PendingDrain = byOwner.get(input.ownerId) ?? {
    timer: null,
    entries: [],
  };
  const entry: NotifyQueueEntry = {
    topic: input.topic,
    eventId: input.eventId,
    ownerIds: [input.ownerId],
  };
  slot.entries.push(entry);

  if (!slot.timer) {
    const ownerId = input.ownerId;
    slot.timer = setTimeout(() => {
      const toFlush = slot.entries;
      slot.entries = [];
      slot.timer = null;
      const flush = flushNotifyQueueForOwner(ownerId, toFlush, env).catch(
        (err) => {
          console.error('[streaming-notify] flush failed', err);
        },
      );
      if (ctx) ctx.waitUntil(flush);
    }, DEBOUNCE_MS);
  }
  byOwner.set(input.ownerId, slot);
}
