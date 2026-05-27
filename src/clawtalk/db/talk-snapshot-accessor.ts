// loadTalkSnapshot — single point-in-time read for the
// `/api/v1/talks/:talkId/snapshot` endpoint (PR A of the talk-load
// architecture refactor, plan
// ~/.gstack/projects/clawtalk/talk-load-architecture-plan-2026-05-27.md).
//
// Composes existing accessors inside `withUserContextIsolated` (BEGIN
// ISOLATION LEVEL REPEATABLE READ) so every nested read agrees on one
// snapshot view. Not READ ONLY because `listTalkThreads` calls
// `getOrCreateDefaultThread`, which heal-on-read-INSERTs when the talk's
// default thread is missing. The DB-shape records are returned as-is;
// the route layer (`web/routes/talk-snapshot.ts`) is responsible for
// camelCase shaping.
//
// `snapshotVersion` comes from the SECURITY DEFINER helper
// `public.get_talk_snapshot_version(uuid)` introduced in migration 0033 —
// authenticated callers can't SELECT from `event_outbox` directly
// (revoked in migration 0006), but the helper self-verifies ownership
// before reading. Returns 0 when the helper returns NULL (talk not
// owned), keeping the client-side delta filter on a numeric cursor.

import { getDbPg, withUserContextIsolated } from '../../db.js';
import {
  TALK_MESSAGE_COLUMNS,
  TALK_RUN_COLUMNS,
  getTalkById,
  listTalkThreads,
  resolveThreadIdForTalk,
  type TalkMessageRecord,
  type TalkRecord,
  type TalkRunRecord,
  type TalkThreadWithMetrics,
} from './accessors.js';
import { getContentByThreadId, type Content } from './content-accessors.js';
import { getPendingEditsByContent } from './content-edits-accessors.js';
import type { ContentEditRow } from '../../shared/rich-text/index.js';
import { listTalkAgents, type TalkAgentAssignment } from './talk-agents.js';

// Snapshot caps the messages slice at 200; the underlying SELECT pulls 201
// so we can detect that an older history exists without a second query.
const TALK_SNAPSHOT_MESSAGE_LIMIT = 200;

export interface TalkSnapshot {
  talk: TalkRecord;
  threads: TalkThreadWithMetrics[];
  activeThreadId: string;
  messages: TalkMessageRecord[];
  hasOlderMessages: boolean;
  content: Content | null;
  pendingEdits: ContentEditRow[];
  runs: TalkRunRecord[];
  agents: TalkAgentAssignment[];
  snapshotVersion: number;
}

export async function loadTalkSnapshot(input: {
  userId: string;
  talkId: string;
  threadId?: string | null;
}): Promise<TalkSnapshot | null> {
  return withUserContextIsolated(input.userId, async () => {
    const talk = await getTalkById(input.talkId);
    if (!talk) return null;

    const threads = await listTalkThreads({
      talkId: input.talkId,
      ownerId: talk.owner_id,
    });

    const activeThreadId = await resolveThreadIdForTalk({
      talkId: input.talkId,
      threadId: input.threadId ?? null,
      ownerId: talk.owner_id,
    });

    const db = getDbPg();

    // Pull LIMIT+1 so hasOlderMessages is counted post-RLS and we don't
    // pay for a second COUNT(*) query. Order DESC so the newest 200 are
    // the ones we keep when truncating; reverse to chronological asc
    // before returning so the UI can append-only.
    const fetchLimit = TALK_SNAPSHOT_MESSAGE_LIMIT + 1;
    const messageRows = await db<TalkMessageRecord[]>`
      select ${db.unsafe(TALK_MESSAGE_COLUMNS)}
      from public.talk_messages
      where talk_id = ${input.talkId}::uuid
        and thread_id = ${activeThreadId}::uuid
      order by created_at desc, coalesce(sequence_in_run, 0) desc, id desc
      limit ${fetchLimit}
    `;
    const hasOlderMessages = messageRows.length > TALK_SNAPSHOT_MESSAGE_LIMIT;
    const messages = (
      hasOlderMessages
        ? messageRows.slice(0, TALK_SNAPSHOT_MESSAGE_LIMIT)
        : messageRows
    )
      .slice()
      .reverse();

    const content = await getContentByThreadId(activeThreadId);
    const pendingEdits = content
      ? await getPendingEditsByContent(content.id)
      : [];

    const runs = await db<TalkRunRecord[]>`
      select ${db.unsafe(TALK_RUN_COLUMNS)}
      from public.talk_runs
      where talk_id = ${input.talkId}::uuid
        and status in ('queued', 'running', 'awaiting_confirmation')
      order by created_at desc
    `;

    const agents = await listTalkAgents(input.talkId);

    // Helper returns NULL for non-owners (paranoid double-check; RLS on
    // talks already gated us above) and 0 for owners with no events yet.
    const versionRows = await db<{ snapshot_version: string | null }[]>`
      select public.get_talk_snapshot_version(${input.talkId}::uuid)::text
        as snapshot_version
    `;
    const rawVersion = versionRows[0]?.snapshot_version;
    const snapshotVersion =
      rawVersion === null || rawVersion === undefined ? 0 : Number(rawVersion);

    return {
      talk,
      threads,
      activeThreadId,
      messages,
      hasOlderMessages,
      content,
      pendingEdits,
      runs,
      agents,
      snapshotVersion,
    };
  });
}
