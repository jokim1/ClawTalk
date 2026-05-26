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
      // Content-feature events: doc body + pending-edit updates are
      // scoped to the Talk-level Content (1:1 with the Talk), not to any
      // individual thread — every thread of the Talk needs to see them
      // so the pending-edit banner renders inline regardless of which
      // thread the tool-call originated in.
      case 'content_updated':
      case 'content_edit_run_started':
      case 'content_edit_run_aborted':
      case 'content_edit_applied':
      case 'content_edit_resolved':
        return true;
      // Talk-scoped tool toggles (migration 0031). The chip bar lives
      // above the composer for every thread of the Talk, so all
      // thread-bound subscribers need the event.
      case 'talk_tools_changed':
        return true;
      // `tool_call_started` carries threadId in the payload (per the
      // executor emit) so it can route to the originating thread.
      // Without the thread match, a streaming placeholder would appear
      // in every thread of the Talk on every tool call.
      case 'tool_call_started':
        return payload.threadId === undefined || payload.threadId === threadId;
      default:
        // New event types must be added to this switch to be visible in
        // thread-scoped streams. Unknown events are excluded by default.
        return false;
    }
  };
}
