// Outbox-event filter helpers.
//
// These are framing-agnostic — they decide *which* events a given
// subscriber receives, independent of whether delivery is SSE
// (the current Node-mode path in `routes/events.ts`) or WebSocket
// (the upcoming Durable-Object path in `talks/user-event-hub.ts`).

import type { OutboxEvent } from '../db/index.js';

export type OutboxEventFilter = (event: OutboxEvent) => boolean;

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isConversationRunPayload(payload: Record<string, unknown>): boolean {
  return payload.runKind === undefined || payload.runKind === 'conversation';
}

export function buildConversationRunEventFilter(): OutboxEventFilter {
  return (event) => {
    switch (event.event_type) {
      case 'talk_run_queued':
      case 'talk_run_started':
      case 'talk_run_completed':
      case 'talk_run_failed':
        return isConversationRunPayload(event.payload);
      default:
        return true;
    }
  };
}

export function buildTalkThreadEventFilter(
  threadId: string,
): OutboxEventFilter {
  return (event) => {
    const payload = event.payload;

    switch (event.event_type) {
      case 'message_appended':
      case 'talk_run_started':
      case 'talk_run_completed':
      case 'talk_run_failed':
        if (!isConversationRunPayload(payload)) {
          return false;
        }
        return payload.threadId === threadId;
      case 'browser_blocked':
      case 'browser_unblocked':
      case 'talk_response_started':
      case 'talk_progress_update':
      case 'talk_response_delta':
      case 'talk_response_usage':
      case 'talk_response_completed':
      case 'talk_response_failed':
      case 'talk_response_cancelled':
        return payload.threadId === threadId;
      case 'talk_run_cancelled':
      case 'talk_history_edited':
        return isStringArray(payload.threadIds)
          ? payload.threadIds.includes(threadId)
          : false;
      default:
        // New event types must be added to this switch to be visible in
        // thread-scoped streams. Unknown events are excluded by default.
        return false;
    }
  };
}
