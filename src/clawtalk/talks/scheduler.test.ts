import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  type RequestExecutionContext,
  withUserContext,
} from '../../db.js';
import { createRegisteredAgent } from '../db/agent-accessors.js';
import {
  createTalk,
  createTalkMessage,
  createTalkRun,
  getOrCreateDefaultThread,
  getTalkRunById,
  markTalkRunStatus,
} from '../db/accessors.js';
import { createTalkJob } from '../db/job-accessors.js';
import { runScheduledTick, type ScheduledTickEnv } from './scheduler.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54432/postgres';
const OWNER_ID = '0c888888-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PROVIDER_ID = 'test.scheduler-provider';
const MODEL_ID = 'test.scheduler-model';

interface FakeQueue {
  sends: Array<{ runId: string }>;
  send(message: unknown): Promise<void>;
}

function makeQueue(): FakeQueue {
  return {
    sends: [],
    async send(message) {
      this.sends.push(message as { runId: string });
    },
  };
}

function makeMockCtx(): {
  ctx: RequestExecutionContext;
  drain: () => Promise<void>;
} {
  const promises: Array<Promise<unknown>> = [];
  return {
    ctx: { waitUntil: (p) => promises.push(p) },
    drain: async () => {
      await Promise.all(promises);
    },
  };
}

async function seedAuthUser(id: string, email: string): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${id}::uuid, ${email}::text,
            jsonb_build_object('full_name', ${email}::text))
    on conflict (id) do nothing
  `;
}

async function seedProvider(): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.llm_providers
      (id, name, provider_kind, api_format, base_url, auth_scheme)
    values (${PROVIDER_ID}, 'Test Scheduler Provider', 'custom',
            'openai_chat_completions', 'mock://sched', 'bearer')
    on conflict (id) do nothing
  `;
  await db`
    insert into public.llm_provider_models
      (provider_id, model_id, display_name, context_window_tokens,
       default_max_output_tokens)
    values (${PROVIDER_ID}, ${MODEL_ID}, 'Test Sched Model', 32000, 2048)
    on conflict (provider_id, model_id) do nothing
  `;
}

async function seedTalkAgent(input: {
  ownerId: string;
  talkId: string;
  agentId: string;
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talk_agents
      (talk_id, owner_id, registered_agent_id, source_kind, provider_id,
       model_id)
    values (${input.talkId}::uuid, ${input.ownerId}::uuid,
            ${input.agentId}::uuid, 'provider', ${PROVIDER_ID}, ${MODEL_ID})
  `;
}

async function purge(): Promise<void> {
  const db = getDbPg();
  await db`delete from public.talks where owner_id = ${OWNER_ID}::uuid`;
  await db`delete from public.registered_agents where owner_id = ${OWNER_ID}::uuid`;
  await db`delete from public.event_outbox where topic like 'talk:%'`;
}

beforeAll(async () => {
  await initPgDatabase({ url: TEST_DB_URL });
  await seedAuthUser(OWNER_ID, 'scheduler-test@clawtalk.test');
  await seedProvider();
});

afterAll(async () => {
  await purge();
  const db = getDbPg();
  await db`delete from auth.users where id = ${OWNER_ID}::uuid`;
  await db`delete from public.llm_provider_models where provider_id = ${PROVIDER_ID}`;
  await db`delete from public.llm_providers where id = ${PROVIDER_ID}`;
  await closePgDatabase();
});

beforeEach(async () => {
  await purge();
});

async function setupTalkWithAgent(): Promise<{
  talkId: string;
  agentId: string;
}> {
  const { talkId, agentId } = await withUserContext(OWNER_ID, async () => {
    const talk = await createTalk({
      ownerId: OWNER_ID,
      topicTitle: 'Scheduler Talk',
    });
    const agent = await createRegisteredAgent({
      ownerId: OWNER_ID,
      name: 'Cronista',
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
    });
    return { talkId: talk.id, agentId: agent.id };
  });
  await seedTalkAgent({ ownerId: OWNER_ID, talkId, agentId });
  await withUserContext(OWNER_ID, async () => {
    await getOrCreateDefaultThread({ talkId, ownerId: OWNER_ID });
  });
  return { talkId, agentId };
}

describe('runScheduledTick — processClaimableJobs', () => {
  it('dispatches a run for every due job that successfully creates a trigger', async () => {
    const { talkId, agentId } = await setupTalkWithAgent();

    // Past-due job — claimDueTalkJobs will pick it up on the next tick.
    await withUserContext(OWNER_ID, async () => {
      await createTalkJob({
        ownerId: OWNER_ID,
        talkId,
        title: 'Past-Due',
        prompt: 'tick now',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 1 },
        timezone: 'UTC',
        createdBy: OWNER_ID,
        // Force the row to be due in the past by overriding next_due_at
        // directly below.
      });
    });
    const db = getDbPg();
    await db`
      update public.talk_jobs
      set next_due_at = now() - interval '1 minute'
      where owner_id = ${OWNER_ID}::uuid
    `;

    const queue = makeQueue();
    const env: ScheduledTickEnv = {
      DB: { connectionString: TEST_DB_URL },
      TALK_RUN_QUEUE: queue,
    };
    const { ctx, drain } = makeMockCtx();
    await runScheduledTick(env, ctx);
    await drain();

    expect(queue.sends).toHaveLength(1);
    expect(queue.sends[0]!.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('does nothing when no jobs are due', async () => {
    const { talkId, agentId } = await setupTalkWithAgent();
    // Future-due job — should not be claimed.
    await withUserContext(OWNER_ID, async () => {
      await createTalkJob({
        ownerId: OWNER_ID,
        talkId,
        title: 'Future',
        prompt: 'much later',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 6 },
        timezone: 'UTC',
        createdBy: OWNER_ID,
      });
    });

    const queue = makeQueue();
    const env: ScheduledTickEnv = {
      DB: { connectionString: TEST_DB_URL },
      TALK_RUN_QUEUE: queue,
    };
    const { ctx, drain } = makeMockCtx();
    await runScheduledTick(env, ctx);
    await drain();

    expect(queue.sends).toHaveLength(0);
  });
});

describe('runScheduledTick — sweepStuckRunningRuns', () => {
  it('flips status=running rows older than 1h to failed with stuck_running_swept', async () => {
    const { talkId } = await setupTalkWithAgent();

    // Create a run + flip it to 'running' with an artificially old
    // started_at so the sweep sees it.
    const runId = await withUserContext(OWNER_ID, async () => {
      const threadId = await getOrCreateDefaultThread({
        talkId,
        ownerId: OWNER_ID,
      });
      const message = await createTalkMessage({
        ownerId: OWNER_ID,
        talkId,
        threadId,
        role: 'user',
        content: 'trigger',
      });
      const run = await createTalkRun({
        ownerId: OWNER_ID,
        talkId,
        threadId,
        requestedBy: OWNER_ID,
        status: 'running',
        triggerMessageId: message.id,
      });
      return run.id;
    });

    // Override started_at to 2h ago — well past the 1h threshold.
    const db = getDbPg();
    await db`
      update public.talk_runs
      set started_at = now() - interval '2 hours'
      where id = ${runId}::uuid
    `;

    const queue = makeQueue();
    const env: ScheduledTickEnv = {
      DB: { connectionString: TEST_DB_URL },
      TALK_RUN_QUEUE: queue,
    };
    const { ctx, drain } = makeMockCtx();
    await runScheduledTick(env, ctx);
    await drain();

    const run = await getTalkRunById(runId);
    expect(run?.status).toBe('failed');
    expect(run?.cancel_reason).toContain('stuck_running');
  });

  it('leaves fresh running rows alone', async () => {
    const { talkId } = await setupTalkWithAgent();

    const runId = await withUserContext(OWNER_ID, async () => {
      const threadId = await getOrCreateDefaultThread({
        talkId,
        ownerId: OWNER_ID,
      });
      const message = await createTalkMessage({
        ownerId: OWNER_ID,
        talkId,
        threadId,
        role: 'user',
        content: 'trigger',
      });
      const run = await createTalkRun({
        ownerId: OWNER_ID,
        talkId,
        threadId,
        requestedBy: OWNER_ID,
        status: 'queued',
        triggerMessageId: message.id,
      });
      return run.id;
    });
    await markTalkRunStatus(runId, 'running', {
      startedAt: new Date().toISOString(),
    });

    const queue = makeQueue();
    const env: ScheduledTickEnv = {
      DB: { connectionString: TEST_DB_URL },
      TALK_RUN_QUEUE: queue,
    };
    const { ctx, drain } = makeMockCtx();
    await runScheduledTick(env, ctx);
    await drain();

    const run = await getTalkRunById(runId);
    expect(run?.status).toBe('running');
  });

  it('promotes the next ordered sibling after reaping a stuck step', async () => {
    const { talkId } = await setupTalkWithAgent();
    const groupId = '0c888888-5555-5555-5555-555555555555';
    const { firstRunId, secondRunId } = await withUserContext(
      OWNER_ID,
      async () => {
        const threadId = await getOrCreateDefaultThread({
          talkId,
          ownerId: OWNER_ID,
        });
        const message = await createTalkMessage({
          ownerId: OWNER_ID,
          talkId,
          threadId,
          role: 'user',
          content: 'ordered round',
        });
        const first = await createTalkRun({
          ownerId: OWNER_ID,
          talkId,
          threadId,
          requestedBy: OWNER_ID,
          status: 'running',
          triggerMessageId: message.id,
          responseGroupId: groupId,
          sequenceIndex: 0,
        });
        const second = await createTalkRun({
          ownerId: OWNER_ID,
          talkId,
          threadId,
          requestedBy: OWNER_ID,
          status: 'queued',
          triggerMessageId: message.id,
          responseGroupId: groupId,
          sequenceIndex: 1,
        });
        return { firstRunId: first.id, secondRunId: second.id };
      },
    );
    // Age the running step past the 1h threshold so the sweep reaps it.
    const db = getDbPg();
    await db`
      update public.talk_runs
      set started_at = now() - interval '2 hours'
      where id = ${firstRunId}::uuid
    `;

    const queue = makeQueue();
    const env: ScheduledTickEnv = {
      DB: { connectionString: TEST_DB_URL },
      TALK_RUN_QUEUE: queue,
    };
    const { ctx, drain } = makeMockCtx();
    await runScheduledTick(env, ctx);
    await drain();

    // Step 0 reaped to failed, and its sibling promoted in the same tick
    // (not left to the stranded sweep's 2-min grace).
    expect(await getTalkRunById(firstRunId).then((r) => r?.status)).toBe(
      'failed',
    );
    expect(queue.sends.map((s) => s.runId)).toEqual([secondRunId]);
  });
});

describe('runScheduledTick — sweepStrandedOrderedSiblings', () => {
  // Build an ordered pair (seq 0 + seq 1) in one talk/group. `firstStatus`
  // + `firstEndedAt` shape how the seq-1 sibling looks to the sweep.
  async function setupOrderedPair(opts: {
    groupId: string;
    firstStatus: 'completed' | 'failed' | 'running';
    firstEndedAt?: string; // raw SQL expr, e.g. "now() - interval '5 minutes'"
  }): Promise<{ firstRunId: string; secondRunId: string }> {
    const { talkId } = await setupTalkWithAgent();
    const ids = await withUserContext(OWNER_ID, async () => {
      const threadId = await getOrCreateDefaultThread({
        talkId,
        ownerId: OWNER_ID,
      });
      const message = await createTalkMessage({
        ownerId: OWNER_ID,
        talkId,
        threadId,
        role: 'user',
        content: 'ordered round',
      });
      const first = await createTalkRun({
        ownerId: OWNER_ID,
        talkId,
        threadId,
        requestedBy: OWNER_ID,
        status: opts.firstStatus,
        triggerMessageId: message.id,
        responseGroupId: opts.groupId,
        sequenceIndex: 0,
      });
      const second = await createTalkRun({
        ownerId: OWNER_ID,
        talkId,
        threadId,
        requestedBy: OWNER_ID,
        status: 'queued',
        triggerMessageId: message.id,
        responseGroupId: opts.groupId,
        sequenceIndex: 1,
      });
      return { firstRunId: first.id, secondRunId: second.id };
    });
    if (opts.firstEndedAt) {
      const db = getDbPg();
      await db`
        update public.talk_runs
        set ended_at = ${db.unsafe(opts.firstEndedAt)}
        where id = ${ids.firstRunId}::uuid
      `;
    }
    return ids;
  }

  it('re-dispatches an eligible queued sibling stranded past the grace window', async () => {
    const { secondRunId } = await setupOrderedPair({
      groupId: '0c888888-1111-1111-1111-111111111111',
      firstStatus: 'completed',
      firstEndedAt: "now() - interval '5 minutes'",
    });

    const queue = makeQueue();
    const env: ScheduledTickEnv = {
      DB: { connectionString: TEST_DB_URL },
      TALK_RUN_QUEUE: queue,
    };
    const { ctx, drain } = makeMockCtx();
    await runScheduledTick(env, ctx);
    await drain();

    expect(queue.sends.map((s) => s.runId)).toEqual([secondRunId]);
  });

  it('also re-dispatches when the predecessor FAILED (the slow-524 round)', async () => {
    const { secondRunId } = await setupOrderedPair({
      groupId: '0c888888-2222-2222-2222-222222222222',
      firstStatus: 'failed',
      firstEndedAt: "now() - interval '5 minutes'",
    });

    const queue = makeQueue();
    const env: ScheduledTickEnv = {
      DB: { connectionString: TEST_DB_URL },
      TALK_RUN_QUEUE: queue,
    };
    const { ctx, drain } = makeMockCtx();
    await runScheduledTick(env, ctx);
    await drain();

    expect(queue.sends.map((s) => s.runId)).toEqual([secondRunId]);
  });

  it('leaves a sibling alone when its blocker finished within the grace window', async () => {
    await setupOrderedPair({
      groupId: '0c888888-3333-3333-3333-333333333333',
      firstStatus: 'completed',
      firstEndedAt: "now() - interval '20 seconds'",
    });

    const queue = makeQueue();
    const env: ScheduledTickEnv = {
      DB: { connectionString: TEST_DB_URL },
      TALK_RUN_QUEUE: queue,
    };
    const { ctx, drain } = makeMockCtx();
    await runScheduledTick(env, ctx);
    await drain();

    // Promotion may still be in normal flight — the sweep must not race it.
    expect(queue.sends).toHaveLength(0);
  });

  it('leaves a sibling alone while its blocker is still active', async () => {
    await setupOrderedPair({
      groupId: '0c888888-4444-4444-4444-444444444444',
      firstStatus: 'running',
    });

    const queue = makeQueue();
    const env: ScheduledTickEnv = {
      DB: { connectionString: TEST_DB_URL },
      TALK_RUN_QUEUE: queue,
    };
    const { ctx, drain } = makeMockCtx();
    await runScheduledTick(env, ctx);
    await drain();

    expect(queue.sends).toHaveLength(0);
  });

  it('re-dispatches a first step (seq 0) stranded by a lost initial dispatch', async () => {
    const { talkId } = await setupTalkWithAgent();
    const groupId = '0c888888-6666-6666-6666-666666666666';
    const firstRunId = await withUserContext(OWNER_ID, async () => {
      const threadId = await getOrCreateDefaultThread({
        talkId,
        ownerId: OWNER_ID,
      });
      const message = await createTalkMessage({
        ownerId: OWNER_ID,
        talkId,
        threadId,
        role: 'user',
        content: 'ordered round',
      });
      const first = await createTalkRun({
        ownerId: OWNER_ID,
        talkId,
        threadId,
        requestedBy: OWNER_ID,
        status: 'queued',
        triggerMessageId: message.id,
        responseGroupId: groupId,
        sequenceIndex: 0,
      });
      // A later step also queued; it stays blocked behind seq 0.
      await createTalkRun({
        ownerId: OWNER_ID,
        talkId,
        threadId,
        requestedBy: OWNER_ID,
        status: 'queued',
        triggerMessageId: message.id,
        responseGroupId: groupId,
        sequenceIndex: 1,
      });
      return first.id;
    });
    // seq 0 has no blocker; age its created_at past grace so the coalesce
    // fallback selects it (simulates a lost initial TALK_RUN_QUEUE.send).
    const db = getDbPg();
    await db`
      update public.talk_runs
      set created_at = now() - interval '5 minutes'
      where id = ${firstRunId}::uuid
    `;

    const queue = makeQueue();
    const env: ScheduledTickEnv = {
      DB: { connectionString: TEST_DB_URL },
      TALK_RUN_QUEUE: queue,
    };
    const { ctx, drain } = makeMockCtx();
    await runScheduledTick(env, ctx);
    await drain();

    // Only seq 0 is eligible (seq 1 is blocked by still-queued seq 0).
    expect(queue.sends.map((s) => s.runId)).toEqual([firstRunId]);
  });
});
