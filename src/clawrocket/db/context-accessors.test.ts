import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createTalkRun,
  createTalkThread,
  deleteTalkStateEntry,
  forceDeleteTalkStateEntry,
  MAX_STATE_ENTRIES_PER_TALK,
  MAX_STATE_KEY_LENGTH,
  MAX_STATE_VALUE_BYTES,
  upsertTalk,
  upsertTalkStateEntry,
  upsertUser,
} from './index.js';

const TALK_ID = 'talk-state';

describe('context-accessors state', () => {
  let threadId = '';

  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertTalk({
      id: TALK_ID,
      ownerId: 'owner-1',
      topicTitle: 'State Test Talk',
    });
    threadId = createTalkThread({ talkId: TALK_ID, title: 'Default' }).id;
  });

  function insertRun(runId: string) {
    createTalkRun({
      id: runId,
      talk_id: TALK_ID,
      thread_id: threadId,
      requested_by: 'owner-1',
      status: 'completed',
      trigger_message_id: null,
      target_agent_id: null,
      idempotency_key: null,
      response_group_id: null,
      sequence_index: null,
      executor_alias: 'direct_http',
      executor_model: 'claude-sonnet-4-6',
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      cancel_reason: null,
    });
  }

  it('creates a new entry when expectedVersion is 0', () => {
    insertRun('run-1');
    const result = upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'summary',
      value: { mood: 'bullish' },
      expectedVersion: 0,
      updatedByUserId: 'owner-1',
      updatedByRunId: 'run-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected successful state write');
    }
    expect(result.entry.key).toBe('summary');
    expect(result.entry.value).toEqual({ mood: 'bullish' });
    expect(result.entry.version).toBe(1);
    expect(result.entry.updatedByUserId).toBe('owner-1');
    expect(result.entry.updatedByRunId).toBe('run-1');
  });

  it('updates an existing entry when the version matches', () => {
    insertRun('run-1');
    const created = upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'summary',
      value: { mood: 'bullish' },
      expectedVersion: 0,
      updatedByUserId: 'owner-1',
      updatedByRunId: 'run-1',
    });
    if (!created.ok) {
      throw new Error('Expected successful state write');
    }

    insertRun('run-2');
    const updated = upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'summary',
      value: { mood: 'neutral' },
      expectedVersion: created.entry.version,
      updatedByUserId: 'owner-1',
      updatedByRunId: 'run-2',
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) {
      throw new Error('Expected successful state update');
    }
    expect(updated.entry.value).toEqual({ mood: 'neutral' });
    expect(updated.entry.version).toBe(2);
    expect(updated.entry.updatedByRunId).toBe('run-2');
  });

  it('returns the current stored entry on version conflict', () => {
    insertRun('run-1');
    const created = upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'summary',
      value: { mood: 'bullish' },
      expectedVersion: 0,
      updatedByUserId: 'owner-1',
      updatedByRunId: 'run-1',
    });
    if (!created.ok) {
      throw new Error('Expected successful state write');
    }

    insertRun('run-2');
    const updated = upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'summary',
      value: { mood: 'neutral' },
      expectedVersion: created.entry.version,
      updatedByUserId: 'owner-1',
      updatedByRunId: 'run-2',
    });
    if (!updated.ok) {
      throw new Error('Expected successful state update');
    }

    insertRun('run-3');
    const conflict = upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'summary',
      value: { mood: 'bearish' },
      expectedVersion: 1,
      updatedByUserId: 'owner-1',
      updatedByRunId: 'run-3',
    });

    expect(conflict.ok).toBe(false);
    if (conflict.ok) {
      throw new Error('Expected version conflict');
    }
    expect(conflict.current.value).toEqual({ mood: 'neutral' });
    expect(conflict.current.version).toBe(2);
    expect(conflict.current.updatedByRunId).toBe('run-2');
  });

  it('rejects updating a missing key with a nonzero expectedVersion', () => {
    expect(() =>
      upsertTalkStateEntry({
        talkId: TALK_ID,
        key: 'missing',
        value: { note: 'nope' },
        expectedVersion: 1,
        updatedByUserId: 'owner-1',
        updatedByRunId: 'run-1',
      }),
    ).toThrow(/expectedVersion 0/i);
  });

  it('rejects a key exceeding the length limit', () => {
    const longKey = 'a'.repeat(MAX_STATE_KEY_LENGTH + 1);
    expect(() =>
      upsertTalkStateEntry({
        talkId: TALK_ID,
        key: longKey,
        value: 'test',
        expectedVersion: 0,
      }),
    ).toThrow(/exceeds.*character limit/i);
  });

  it('rejects a key with invalid characters', () => {
    expect(() =>
      upsertTalkStateEntry({
        talkId: TALK_ID,
        key: 'has spaces',
        value: 'test',
        expectedVersion: 0,
      }),
    ).toThrow(/must contain only/i);
  });

  it('rejects a key starting with a hyphen', () => {
    expect(() =>
      upsertTalkStateEntry({
        talkId: TALK_ID,
        key: '-bad-start',
        value: 'test',
        expectedVersion: 0,
      }),
    ).toThrow(/must contain only/i);
  });

  it('rejects a value exceeding the byte limit', () => {
    const bigValue = 'x'.repeat(MAX_STATE_VALUE_BYTES + 1);
    expect(() =>
      upsertTalkStateEntry({
        talkId: TALK_ID,
        key: 'big_value',
        value: bigValue,
        expectedVersion: 0,
      }),
    ).toThrow(/exceeds 20 KB/i);
  });

  it('rejects creating entries past the per-talk limit', () => {
    for (let i = 0; i < MAX_STATE_ENTRIES_PER_TALK; i += 1) {
      const result = upsertTalkStateEntry({
        talkId: TALK_ID,
        key: `key_${i}`,
        value: i,
        expectedVersion: 0,
      });
      expect(result.ok).toBe(true);
    }

    expect(() =>
      upsertTalkStateEntry({
        talkId: TALK_ID,
        key: 'one_too_many',
        value: 'overflow',
        expectedVersion: 0,
      }),
    ).toThrow(/Maximum.*state entries/i);
  });

  it('deletes an entry with matching version', () => {
    const created = upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'to_delete',
      value: 'temp',
      expectedVersion: 0,
    });
    expect(created.ok).toBe(true);

    const result = deleteTalkStateEntry({
      talkId: TALK_ID,
      key: 'to_delete',
      expectedVersion: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deleted).toBe(true);
    }
  });

  it('returns conflict when delete version mismatches', () => {
    upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'conflict_del',
      value: 'v1',
      expectedVersion: 0,
    });
    upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'conflict_del',
      value: 'v2',
      expectedVersion: 1,
    });

    const result = deleteTalkStateEntry({
      talkId: TALK_ID,
      key: 'conflict_del',
      expectedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.current.version).toBe(2);
    }
  });

  it('throws when deleting a missing key', () => {
    expect(() =>
      deleteTalkStateEntry({
        talkId: TALK_ID,
        key: 'does_not_exist',
        expectedVersion: 1,
      }),
    ).toThrow(/does not exist/i);
  });

  it('throws when deleting with a negative expectedVersion', () => {
    upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'neg_ver_del',
      value: 'test',
      expectedVersion: 0,
    });
    expect(() =>
      deleteTalkStateEntry({
        talkId: TALK_ID,
        key: 'neg_ver_del',
        expectedVersion: -1,
      }),
    ).toThrow(/non-negative integer/i);
  });

  it('throws when deleting with a non-integer expectedVersion', () => {
    upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'float_ver_del',
      value: 'test',
      expectedVersion: 0,
    });
    expect(() =>
      deleteTalkStateEntry({
        talkId: TALK_ID,
        key: 'float_ver_del',
        expectedVersion: 1.5,
      }),
    ).toThrow(/non-negative integer/i);
  });

  it('force-deletes an entry without CAS', () => {
    upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'force_del',
      value: 'temp',
      expectedVersion: 0,
    });

    const deleted = forceDeleteTalkStateEntry(TALK_ID, 'force_del');
    expect(deleted).toBe(true);
  });

  it('returns false when force-deleting a missing key', () => {
    const deleted = forceDeleteTalkStateEntry(TALK_ID, 'nope_key');
    expect(deleted).toBe(false);
  });
});
