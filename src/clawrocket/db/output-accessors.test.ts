import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createTalkOutput,
  createTalkRun,
  createTalkThread,
  deleteTalkForOwner,
  deleteTalkOutput,
  getTalkOutput,
  listTalkOutputs,
  patchTalkOutput,
  upsertTalk,
  upsertUser,
} from './index.js';

const TALK_ID = 'talk-outputs';

describe('output-accessors', () => {
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
      topicTitle: 'Outputs Test Talk',
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

  it('creates, lists, and fetches outputs', () => {
    const created = createTalkOutput({
      talkId: TALK_ID,
      title: 'Weekly Brief',
      contentMarkdown: '# Hello\n\nWorld',
      createdByUserId: 'owner-1',
    });

    const summaries = listTalkOutputs(TALK_ID);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: created.id,
      title: 'Weekly Brief',
      version: 1,
      contentLength: '# Hello\n\nWorld'.length,
    });
    expect('contentMarkdown' in summaries[0]).toBe(false);

    expect(getTalkOutput(TALK_ID, created.id)).toMatchObject({
      id: created.id,
      title: 'Weekly Brief',
      contentMarkdown: '# Hello\n\nWorld',
      version: 1,
      createdByUserId: 'owner-1',
    });
  });

  it('updates outputs with whole-document CAS versioning', () => {
    insertRun('run-1');
    const created = createTalkOutput({
      talkId: TALK_ID,
      title: 'Draft Plan',
      contentMarkdown: 'Initial body',
      createdByUserId: 'owner-1',
      updatedByRunId: 'run-1',
    });

    insertRun('run-2');
    const updated = patchTalkOutput({
      talkId: TALK_ID,
      outputId: created.id,
      expectedVersion: created.version,
      title: 'Final Plan',
      updatedByUserId: 'owner-1',
      updatedByRunId: 'run-2',
    });

    expect(updated.kind).toBe('ok');
    if (updated.kind !== 'ok') {
      throw new Error('Expected successful output update');
    }
    expect(updated.output.title).toBe('Final Plan');
    expect(updated.output.contentMarkdown).toBe('Initial body');
    expect(updated.output.version).toBe(2);
    expect(updated.output.updatedByRunId).toBe('run-2');
  });

  it('returns the current output on version conflict', () => {
    const created = createTalkOutput({
      talkId: TALK_ID,
      title: 'Plan',
      contentMarkdown: 'v1',
      createdByUserId: 'owner-1',
    });

    const updated = patchTalkOutput({
      talkId: TALK_ID,
      outputId: created.id,
      expectedVersion: 1,
      contentMarkdown: 'v2',
      updatedByUserId: 'owner-1',
    });
    if (updated.kind !== 'ok') {
      throw new Error('Expected successful output update');
    }

    const conflict = patchTalkOutput({
      talkId: TALK_ID,
      outputId: created.id,
      expectedVersion: 1,
      contentMarkdown: 'stale write',
      updatedByUserId: 'owner-1',
    });

    expect(conflict.kind).toBe('conflict');
    if (conflict.kind !== 'conflict') {
      throw new Error('Expected output conflict');
    }
    expect(conflict.current.version).toBe(2);
    expect(conflict.current.contentMarkdown).toBe('v2');
  });

  it('deletes outputs and cascades on talk delete', () => {
    const created = createTalkOutput({
      talkId: TALK_ID,
      title: 'To Delete',
      contentMarkdown: '',
      createdByUserId: 'owner-1',
    });
    expect(deleteTalkOutput(TALK_ID, created.id)).toBe(true);
    expect(getTalkOutput(TALK_ID, created.id)).toBeUndefined();

    const retained = createTalkOutput({
      talkId: TALK_ID,
      title: 'Cascade Me',
      contentMarkdown: 'Body',
      createdByUserId: 'owner-1',
    });
    expect(deleteTalkForOwner({ talkId: TALK_ID, ownerId: 'owner-1' })).toBe(
      true,
    );
    expect(getTalkOutput(TALK_ID, retained.id)).toBeUndefined();
  });
});
