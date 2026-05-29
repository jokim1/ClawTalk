import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import {
  createTalk,
  createTalkMessage,
  createTalkRun,
  getOrCreateDefaultThread,
} from '../db/accessors.js';
import { buildStepUserMessageText } from './new-executor.js';

// Regression coverage for the ordered-round prior-output injection queries
// (listPriorOrderedOutputs / listPriorOrderedGaps / getOrderedGroupMaxSequence).
// These run ONLY for a downstream ordered step (sequence_index >= 1). They had
// cast the text `response_group_id` to ::uuid, which threw
// `operator does not exist: text = uuid` the moment any such step executed.
// The bug was invisible while ordered rounds dead-lettered before reaching a
// downstream step; once active promotion let them run, every seq>=1 step died.

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const OWNER_ID = '0c777777-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function seedAuthUser(id: string, email: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${id}::uuid, ${email}::text,
            jsonb_build_object('full_name', ${email}::text))
    on conflict (id) do nothing
  `;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.talks where owner_id = ${OWNER_ID}::uuid`;
}

beforeAll(async () => {
  await initPgDatabase({ url: TEST_DB_URL });
  await seedAuthUser(OWNER_ID, 'new-executor-test@clawtalk.test');
});

afterAll(async () => {
  await purge();
  await closePgDatabase();
});

beforeEach(async () => {
  await purge();
});

// Seed one ordered response group. Step i takes steps[i].status and an
// optional assistant output linked to its run. Returns the runIds by index.
async function seedOrderedGroup(
  groupId: string,
  steps: Array<{ status: 'queued' | 'completed' | 'failed'; output?: string }>,
): Promise<string[]> {
  return await withUserContext(OWNER_ID, async () => {
    const talk = await createTalk({
      ownerId: OWNER_ID,
      topicTitle: 'Ordered Round',
    });
    const threadId = await getOrCreateDefaultThread({
      talkId: talk.id,
      ownerId: OWNER_ID,
    });
    const userMsg = await createTalkMessage({
      ownerId: OWNER_ID,
      talkId: talk.id,
      threadId,
      role: 'user',
      content: 'trigger',
    });
    const ids: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      const run = await createTalkRun({
        ownerId: OWNER_ID,
        talkId: talk.id,
        threadId,
        requestedBy: OWNER_ID,
        status: steps[i]!.status,
        triggerMessageId: userMsg.id,
        responseGroupId: groupId,
        sequenceIndex: i,
      });
      ids.push(run.id);
      const output = steps[i]!.output;
      if (output) {
        await createTalkMessage({
          ownerId: OWNER_ID,
          talkId: talk.id,
          threadId,
          role: 'assistant',
          content: output,
          runId: run.id,
        });
      }
    }
    return ids;
  });
}

describe('buildStepUserMessageText — ordered-round prior-output queries', () => {
  it('injects a prior completed step output into a downstream step (regression: text=uuid)', async () => {
    await seedOrderedGroup('0c000000-0000-0000-0000-0000000000a1', [
      { status: 'completed', output: 'PRIOR_AGENT_ANALYSIS_XYZ' }, // seq 0
      { status: 'queued' }, // seq 1 — the step under test
      { status: 'queued' }, // seq 2 — so seq 1 is not the max (not synthesis)
    ]);

    const result = await buildStepUserMessageText({
      triggerContent: 'evaluate the doc',
      estimatedContextTokens: 100,
      modelContextWindow: 128_000,
      responseGroupId: '0c000000-0000-0000-0000-0000000000a1',
      sequenceIndex: 1,
    });

    expect(result.userMessageText).toContain('evaluate the doc');
    expect(result.userMessageText).toContain('PRIOR_AGENT_ANALYSIS_XYZ');
    expect(result.isSynthesis).toBe(false);
  });

  it('marks the highest-sequence step as synthesis and surfaces unavailable prior steps', async () => {
    await seedOrderedGroup('0c000000-0000-0000-0000-0000000000a2', [
      { status: 'failed' }, // seq 0 — a gap (failed, no output)
      { status: 'completed', output: 'SECOND_AGENT_TAKE' }, // seq 1
      { status: 'queued' }, // seq 2 — the synthesis step (max sequence)
    ]);

    const result = await buildStepUserMessageText({
      triggerContent: 'synthesize the round',
      estimatedContextTokens: 100,
      modelContextWindow: 128_000,
      responseGroupId: '0c000000-0000-0000-0000-0000000000a2',
      sequenceIndex: 2,
    });

    expect(result.isSynthesis).toBe(true);
    expect(result.userMessageText).toContain('SECOND_AGENT_TAKE');
    expect(result.userMessageText).toContain(
      'Unavailable earlier ordered steps',
    );
  });

  it('returns the bare trigger for the first step (guard: no prior queries run)', async () => {
    await seedOrderedGroup('0c000000-0000-0000-0000-0000000000a3', [
      { status: 'queued' }, // seq 0
      { status: 'queued' }, // seq 1
    ]);

    const result = await buildStepUserMessageText({
      triggerContent: 'first step content',
      estimatedContextTokens: 100,
      modelContextWindow: 128_000,
      responseGroupId: '0c000000-0000-0000-0000-0000000000a3',
      sequenceIndex: 0,
    });

    expect(result.userMessageText).toBe('first step content');
    expect(result.isSynthesis).toBe(false);
  });
});
