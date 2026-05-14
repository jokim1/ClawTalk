import { describe, expect, it } from 'vitest';
import type { OutboxEvent } from '../db/index.js';
import {
  buildConversationRunEventFilter,
  buildTalkThreadEventFilter,
} from './event-filters.js';

function makeEvent(
  event_type: string,
  payload: Record<string, unknown>,
): OutboxEvent {
  return {
    event_id: 1,
    topic: 'talk:t1',
    event_type,
    payload,
    created_at: new Date().toISOString(),
  };
}

describe('buildConversationRunEventFilter', () => {
  const filter = buildConversationRunEventFilter();

  it('passes through unrecognized event types unchanged', () => {
    expect(filter(makeEvent('talk_response_delta', { foo: 'bar' }))).toBe(true);
    expect(filter(makeEvent('message_appended', {}))).toBe(true);
    expect(filter(makeEvent('made_up_event', {}))).toBe(true);
  });

  for (const event_type of [
    'talk_run_queued',
    'talk_run_started',
    'talk_run_completed',
    'talk_run_failed',
  ]) {
    it(`allows ${event_type} when runKind is undefined (conversation default)`, () => {
      expect(filter(makeEvent(event_type, { threadId: 't1' }))).toBe(true);
    });

    it(`allows ${event_type} when runKind === 'conversation'`, () => {
      expect(
        filter(
          makeEvent(event_type, { runKind: 'conversation', threadId: 't1' }),
        ),
      ).toBe(true);
    });

    it(`blocks ${event_type} when runKind is any other value`, () => {
      expect(filter(makeEvent(event_type, { runKind: 'job' }))).toBe(false);
      expect(filter(makeEvent(event_type, { runKind: 'reaction' }))).toBe(
        false,
      );
      expect(filter(makeEvent(event_type, { runKind: null }))).toBe(false);
    });
  }
});

describe('buildTalkThreadEventFilter', () => {
  const filter = buildTalkThreadEventFilter('thread-A');

  describe('thread-matched conversation-run events', () => {
    for (const event_type of [
      'message_appended',
      'talk_run_started',
      'talk_run_completed',
      'talk_run_failed',
    ]) {
      it(`accepts ${event_type} with matching threadId and conversation runKind`, () => {
        expect(
          filter(makeEvent(event_type, { threadId: 'thread-A' })),
        ).toBe(true);
        expect(
          filter(
            makeEvent(event_type, {
              threadId: 'thread-A',
              runKind: 'conversation',
            }),
          ),
        ).toBe(true);
      });

      it(`rejects ${event_type} on threadId mismatch`, () => {
        expect(
          filter(makeEvent(event_type, { threadId: 'thread-B' })),
        ).toBe(false);
      });

      it(`rejects ${event_type} when runKind is not conversation`, () => {
        expect(
          filter(
            makeEvent(event_type, {
              threadId: 'thread-A',
              runKind: 'job',
            }),
          ),
        ).toBe(false);
      });
    }
  });

  describe('streaming events (no runKind gate)', () => {
    for (const event_type of [
      'browser_blocked',
      'browser_unblocked',
      'talk_response_started',
      'talk_progress_update',
      'talk_response_delta',
      'talk_response_usage',
      'talk_response_completed',
      'talk_response_failed',
      'talk_response_cancelled',
    ]) {
      it(`accepts ${event_type} when threadId matches (ignores runKind)`, () => {
        expect(
          filter(makeEvent(event_type, { threadId: 'thread-A' })),
        ).toBe(true);
        expect(
          filter(
            makeEvent(event_type, {
              threadId: 'thread-A',
              runKind: 'job',
            }),
          ),
        ).toBe(true);
      });

      it(`rejects ${event_type} on threadId mismatch`, () => {
        expect(
          filter(makeEvent(event_type, { threadId: 'thread-B' })),
        ).toBe(false);
      });
    }
  });

  describe('threadIds[] events', () => {
    for (const event_type of ['talk_run_cancelled', 'talk_history_edited']) {
      it(`accepts ${event_type} when threadIds includes the threadId`, () => {
        expect(
          filter(
            makeEvent(event_type, {
              threadIds: ['thread-A', 'thread-B'],
            }),
          ),
        ).toBe(true);
      });

      it(`rejects ${event_type} when threadIds excludes the threadId`, () => {
        expect(
          filter(
            makeEvent(event_type, {
              threadIds: ['thread-B', 'thread-C'],
            }),
          ),
        ).toBe(false);
      });

      it(`rejects ${event_type} when threadIds is not a string array`, () => {
        expect(filter(makeEvent(event_type, { threadIds: undefined }))).toBe(
          false,
        );
        expect(filter(makeEvent(event_type, { threadIds: null }))).toBe(false);
        expect(filter(makeEvent(event_type, { threadIds: 'thread-A' }))).toBe(
          false,
        );
        expect(
          filter(makeEvent(event_type, { threadIds: ['thread-A', 1] })),
        ).toBe(false);
        expect(filter(makeEvent(event_type, { threadIds: [] }))).toBe(false);
      });
    }
  });

  it('rejects unknown event types by default', () => {
    expect(filter(makeEvent('made_up_event', { threadId: 'thread-A' }))).toBe(
      false,
    );
    expect(filter(makeEvent('talk_response_invalid', {}))).toBe(false);
  });
});
