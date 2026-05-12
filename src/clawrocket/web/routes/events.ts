import {
  getOutboxEventsForTopics,
  getOutboxMinEventIdForTopics,
  getTalkIdsAccessibleByUser,
} from '../../db/index.js';

type OutboxEventLike = {
  event_id: number;
  event_type: string;
  payload: string;
};

export type OutboxEventFilter = (event: OutboxEventLike) => boolean;

export function formatOutboxEventAsSse(event: {
  event_id: number;
  event_type: string;
  payload: string;
}): string {
  return `id: ${event.event_id}\nevent: ${event.event_type}\ndata: ${event.payload}\n\n`;
}

export function getUserScopedEventTopics(userId: string): string[] {
  const talkIds = getTalkIdsAccessibleByUser(userId);
  return [`user:${userId}`, ...talkIds.map((id) => `talk:${id}`)];
}

export function getTalkScopedEventTopics(talkId: string): string[] {
  return [`talk:${talkId}`];
}

export function buildUserScopedSseStream(input: {
  userId: string;
  lastEventId: number;
}): string {
  const topics = getUserScopedEventTopics(input.userId);
  return buildSseStreamForTopics(topics, input.lastEventId);
}

export function buildTalkScopedSseStream(input: {
  talkId: string;
  lastEventId: number;
  threadId?: string | null;
}): string {
  const filters: OutboxEventFilter[] = [buildConversationRunEventFilter()];
  if (input.threadId) {
    filters.push(buildTalkThreadEventFilter(input.threadId));
  }
  return buildSseStreamForTopics(
    getTalkScopedEventTopics(input.talkId),
    input.lastEventId,
    filters.length === 1
      ? filters[0]
      : (event) => filters.every((filter) => filter(event)),
  );
}

function buildSseStreamForTopics(
  topics: string[],
  lastEventId: number,
  filterEvent?: OutboxEventFilter,
): string {
  let output = '';

  const minId = getOutboxMinEventIdForTopics(topics);
  if (lastEventId > 0 && minId !== null && lastEventId < minId - 1) {
    output +=
      'event: replay_gap\ndata: {"message":"Requested replay position is outside retention window"}\n\n';
  }

  const events = getOutboxEventsForTopics(topics, lastEventId);
  for (const event of events) {
    if (filterEvent && !filterEvent(event)) {
      continue;
    }
    output += formatOutboxEventAsSse(event);
  }

  if (!output) {
    output = ': keepalive\n\n';
  }

  return output;
}

function parsePayload(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isConversationRunPayload(payload: Record<string, unknown>): boolean {
  return payload.runKind === undefined || payload.runKind === 'conversation';
}

function buildConversationRunEventFilter(): OutboxEventFilter {
  return (event) => {
    switch (event.event_type) {
      case 'talk_run_queued':
      case 'talk_run_started':
      case 'talk_run_completed':
      case 'talk_run_failed': {
        const payload = parsePayload(event.payload);
        return payload ? isConversationRunPayload(payload) : false;
      }
      default:
        return true;
    }
  };
}

export function buildTalkThreadEventFilter(
  threadId: string,
): OutboxEventFilter {
  return (event) => {
    const payload = parsePayload(event.payload);
    if (!payload) return false;

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
        // thread-scoped SSE. Unknown events are excluded by default.
        return false;
    }
  };
}
