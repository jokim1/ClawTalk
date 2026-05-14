import {
  getOutboxEventsForTopics,
  getOutboxMinEventIdForTopics,
  getTalkIdsAccessibleByUser,
  type OutboxEvent,
} from '../../db/index.js';
import {
  buildConversationRunEventFilter,
  buildTalkThreadEventFilter,
  type OutboxEventFilter,
} from '../../talks/event-filters.js';

export function formatOutboxEventAsSse(event: OutboxEvent): string {
  return `id: ${event.event_id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

export async function getUserScopedEventTopics(
  userId: string,
): Promise<string[]> {
  const talkIds = await getTalkIdsAccessibleByUser();
  return [`user:${userId}`, ...talkIds.map((id: string) => `talk:${id}`)];
}

export function getTalkScopedEventTopics(talkId: string): string[] {
  return [`talk:${talkId}`];
}

export async function buildUserScopedSseStream(input: {
  userId: string;
  lastEventId: number;
}): Promise<string> {
  const topics = await getUserScopedEventTopics(input.userId);
  return await buildSseStreamForTopics(topics, input.lastEventId);
}

export async function buildTalkScopedSseStream(input: {
  talkId: string;
  lastEventId: number;
  threadId?: string | null;
}): Promise<string> {
  const filters: OutboxEventFilter[] = [buildConversationRunEventFilter()];
  if (input.threadId) {
    filters.push(buildTalkThreadEventFilter(input.threadId));
  }
  return await buildSseStreamForTopics(
    getTalkScopedEventTopics(input.talkId),
    input.lastEventId,
    filters.length === 1
      ? filters[0]
      : (event) => filters.every((filter) => filter(event)),
  );
}

async function buildSseStreamForTopics(
  topics: string[],
  lastEventId: number,
  filterEvent?: OutboxEventFilter,
): Promise<string> {
  let output = '';

  const minId = await getOutboxMinEventIdForTopics(topics);
  if (lastEventId > 0 && minId !== null && lastEventId < minId - 1) {
    output +=
      'event: replay_gap\ndata: {"message":"Requested replay position is outside retention window"}\n\n';
  }

  const events = await getOutboxEventsForTopics(topics, lastEventId);
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
