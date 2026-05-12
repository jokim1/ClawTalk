import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getOutboxEventsForTopics,
  getQueuedTalkRuns,
  getRunningTalkRun,
  getTalkRunById,
  markTalkRunStatus,
  upsertTalk,
  upsertUser,
} from '../db/index.js';
import { TalkRunQueue } from './run-queue.js';

describe('TalkRunQueue', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'u-owner',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertTalk({
      id: 'talk-1',
      ownerId: 'u-owner',
      topicTitle: 'Phase 0',
    });
  });

  it('enforces single running run and FIFO queue per talk', () => {
    const queue = new TalkRunQueue();

    const first = queue.enqueue({
      runId: 'run-1',
      talkId: 'talk-1',
      threadId: 'thread-default',
      requestedBy: 'u-owner',
    });
    const second = queue.enqueue({
      runId: 'run-2',
      talkId: 'talk-1',
      threadId: 'thread-default',
      requestedBy: 'u-owner',
    });

    expect(first.status).toBe('running');
    expect(second.status).toBe('queued');

    const running = getRunningTalkRun('talk-1');
    const queued = getQueuedTalkRuns('talk-1');
    expect(running?.id).toBe('run-1');
    expect(queued.map((row) => row.id)).toEqual(['run-2']);

    queue.complete('run-1');

    expect(getTalkRunById('run-1')?.status).toBe('completed');
    expect(getRunningTalkRun('talk-1')?.id).toBe('run-2');
  });

  it('cancels running and queued runs and emits event', () => {
    const queue = new TalkRunQueue();

    queue.enqueue({
      runId: 'run-a',
      talkId: 'talk-1',
      threadId: 'thread-default',
      requestedBy: 'u-owner',
    });
    queue.enqueue({
      runId: 'run-b',
      talkId: 'talk-1',
      threadId: 'thread-default',
      requestedBy: 'u-owner',
    });

    const cancelled = queue.cancelTalkRuns('talk-1', 'u-owner');
    expect(cancelled).toBe(2);
    expect(getTalkRunById('run-a')?.status).toBe('cancelled');
    expect(getTalkRunById('run-b')?.status).toBe('cancelled');

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0);
    const eventTypes = events.map((event) => event.event_type);
    expect(eventTypes).toContain('talk_run_cancelled');
  });

  it('treats awaiting confirmation runs as active for enqueue and cancel', () => {
    const queue = new TalkRunQueue();

    queue.enqueue({
      runId: 'run-a',
      talkId: 'talk-1',
      threadId: 'thread-default',
      requestedBy: 'u-owner',
    });
    markTalkRunStatus(
      'run-a',
      'awaiting_confirmation',
      null,
      null,
      '2026-03-06T00:00:01.000Z',
    );

    const second = queue.enqueue({
      runId: 'run-b',
      talkId: 'talk-1',
      threadId: 'thread-default',
      requestedBy: 'u-owner',
    });

    expect(second.status).toBe('queued');
    expect(getRunningTalkRun('talk-1')?.id).toBe('run-a');

    const cancelled = queue.cancelTalkRuns('talk-1', 'u-owner');
    expect(cancelled).toBe(2);
    expect(getTalkRunById('run-a')?.status).toBe('cancelled');
    expect(getTalkRunById('run-b')?.status).toBe('cancelled');
  });
});
