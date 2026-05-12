import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../db.js';
import { createMessage, _initTestDatabase, upsertUser } from '../db/index.js';
import {
  loadMainContext,
  refreshMainThreadSummary,
} from './main-context-loader.js';

function insertMainThread(threadId: string, userId = 'owner-1'): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO main_threads (thread_id, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `,
    )
    .run(threadId, userId, now, now);
}

function insertMainMessage(input: {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  index: number;
}): void {
  createMessage({
    id: input.id,
    talkId: null,
    threadId: input.threadId,
    role: input.role,
    content: input.content,
    createdBy: input.role === 'user' ? 'owner-1' : null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, input.index)).toISOString(),
  });
}

function insertSummaryRow(input: {
  threadId: string;
  summaryText: string;
  coversThroughMessageId: string;
}): void {
  getDb()
    .prepare(
      `
      INSERT INTO main_thread_summaries (
        thread_id, summary_text, covers_through_message_id, updated_at
      ) VALUES (?, ?, ?, ?)
    `,
    )
    .run(
      input.threadId,
      input.summaryText,
      input.coversThroughMessageId,
      new Date().toISOString(),
    );
}

describe('main-context-loader', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
  });

  it('computes a summary for older messages, excludes the current trigger, and avoids cross-thread leakage', () => {
    insertMainThread('thread-a');
    insertMainThread('thread-b');

    insertMainMessage({
      id: 'msg-1',
      threadId: 'thread-a',
      role: 'user',
      content: 'Important old fact: the launch code is Atlas.',
      index: 1,
    });
    for (let index = 2; index <= 13; index += 1) {
      insertMainMessage({
        id: `msg-${index}`,
        threadId: 'thread-a',
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `Thread A message ${index}`,
        index,
      });
    }
    insertMainMessage({
      id: 'msg-14',
      threadId: 'thread-a',
      role: 'user',
      content: 'What is the launch code?',
      index: 14,
    });

    insertMainMessage({
      id: 'msg-b-1',
      threadId: 'thread-b',
      role: 'user',
      content: 'Other thread secret should not leak.',
      index: 20,
    });

    const context = loadMainContext('thread-a', 128000, 'msg-14');

    expect(context.summaryText).toContain('Atlas');
    expect(context.summaryText).not.toContain('Other thread secret');
    expect(context.history).toHaveLength(12);
    expect(context.history.map((message) => message.content)).not.toContain(
      'What is the launch code?',
    );
    expect(context.contextSnapshot.summary.source).toBe('computed');
    expect(context.contextSnapshot.history.messageIds).not.toContain('msg-14');
  });

  it('uses the persisted summary when its coverage matches the older window', () => {
    insertMainThread('thread-persisted');

    insertMainMessage({
      id: 'persisted-1',
      threadId: 'thread-persisted',
      role: 'user',
      content: 'Oldest message that should be summarized.',
      index: 1,
    });
    for (let index = 2; index <= 13; index += 1) {
      insertMainMessage({
        id: `persisted-${index}`,
        threadId: 'thread-persisted',
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `Persisted thread message ${index}`,
        index,
      });
    }
    insertMainMessage({
      id: 'persisted-14',
      threadId: 'thread-persisted',
      role: 'user',
      content: 'Current question',
      index: 14,
    });

    insertSummaryRow({
      threadId: 'thread-persisted',
      summaryText: 'Persisted summary text.',
      coversThroughMessageId: 'persisted-1',
    });

    const context = loadMainContext('thread-persisted', 128000, 'persisted-14');

    expect(context.summaryText).toBe('Persisted summary text.');
    expect(context.contextSnapshot.summary.source).toBe('persisted');
    expect(context.contextSnapshot.summary.coversThroughMessageId).toBe(
      'persisted-1',
    );
  });

  it('refreshes and clears persisted summaries based on the recent window threshold', () => {
    insertMainThread('thread-summary-refresh');

    for (let index = 1; index <= 14; index += 1) {
      insertMainMessage({
        id: `refresh-${index}`,
        threadId: 'thread-summary-refresh',
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `Refresh thread message ${index}`,
        index,
      });
    }

    refreshMainThreadSummary('thread-summary-refresh');

    const summaryRow = getDb()
      .prepare(
        `
        SELECT summary_text, covers_through_message_id
        FROM main_thread_summaries
        WHERE thread_id = ?
      `,
      )
      .get('thread-summary-refresh') as
      | {
          summary_text: string;
          covers_through_message_id: string | null;
        }
      | undefined;
    expect(summaryRow?.summary_text).toContain('Refresh thread message 1');
    expect(summaryRow?.covers_through_message_id).toBe('refresh-2');

    insertMainThread('thread-summary-clear');
    for (let index = 1; index <= 12; index += 1) {
      insertMainMessage({
        id: `clear-${index}`,
        threadId: 'thread-summary-clear',
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `Clear thread message ${index}`,
        index: 40 + index,
      });
    }
    insertSummaryRow({
      threadId: 'thread-summary-clear',
      summaryText: 'Stale summary',
      coversThroughMessageId: 'clear-1',
    });

    refreshMainThreadSummary('thread-summary-clear');

    const clearedRow = getDb()
      .prepare(
        `SELECT 1 AS ok FROM main_thread_summaries WHERE thread_id = ? LIMIT 1`,
      )
      .get('thread-summary-clear');
    expect(clearedRow).toBeUndefined();
  });
});
