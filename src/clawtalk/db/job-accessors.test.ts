// clawtalk Phase 5 (PR 2) — end-to-end test for job-accessors-pg.
//
// Asserts:
//   - CRUD + status transitions for talk_jobs
//   - dependency-validation paths (missing agent membership, missing
//     report output) — chassis-removed connector/channel validation is
//     intentionally not exercised here
//   - claimDueTalkJobs window + nextDueAt recompute
//   - createJobTriggerRun discriminated union branches (enqueued,
//     paused, blocked, job_busy)
//   - RLS cross-user gate
//
// The talk_jobs row requires talk_agents membership for the target
// agent — every test seeds a registered_agent and a talk_agents row
// linking it to the talk under USER_A_ID's context.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closePgDatabase,
  getDbPg,
  initPgDatabase,
  withUserContext,
} from '../../db.js';
import { createRegisteredAgent } from './agent-accessors.js';
import {
  appendOutboxEvent,
  createTalk,
  createTalkRun,
  enqueueTalkTurnAtomic,
  getOrCreateDefaultThread,
  getOutboxEventsForTopics,
} from './accessors.js';
import {
  blockTalkJob,
  claimDueTalkJobs,
  createJobTriggerRun,
  createTalkJob,
  deleteTalkJob,
  getTalkJob,
  getTalkJobById,
  getTalkJobDependencyIssue,
  listTalkJobRunSummaries,
  listTalkJobs,
  markTalkJobRunFinished,
  markTalkJobRunQueued,
  pauseTalkJob,
  patchTalkJob,
  resumeTalkJob,
} from './job-accessors.js';

const USER_A_ID = '0c777777-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = '0c777777-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PROVIDER_ID = 'test.jobs-provider';
const MODEL_ID = 'test.jobs-model';

async function seedAuthUser(
  id: string,
  email: string,
  displayName: string,
): Promise<void> {
  const db = getDbPg();
  await db`
    insert into auth.users (id, email, raw_user_meta_data)
    values (${id}::uuid, ${email}::text,
            jsonb_build_object('full_name', ${displayName}::text))
    on conflict (id) do nothing
  `;
}

async function seedProvider(): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.llm_providers
      (id, name, provider_kind, api_format, base_url, auth_scheme)
    values (${PROVIDER_ID}, 'Test Jobs Provider', 'custom',
            'openai_chat_completions', 'mock://jobs', 'bearer')
    on conflict (id) do nothing
  `;
  await db`
    insert into public.llm_provider_models
      (provider_id, model_id, display_name, context_window_tokens,
       default_max_output_tokens)
    values (${PROVIDER_ID}, ${MODEL_ID}, 'Test Jobs Model', 32000, 2048)
    on conflict (provider_id, model_id) do nothing
  `;
}

async function seedTalkAgent(input: {
  ownerId: string;
  talkId: string;
  agentId: string;
}): Promise<void> {
  // Caller is in postgres role here (BYPASSRLS) — direct SQL is fine.
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
  // Cascade through talks: talk_jobs / talk_agents / talk_threads /
  // talk_messages / talk_runs all delete on talk delete.
  await db`
    delete from public.talks
    where owner_id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
  `;
  await db`
    delete from public.registered_agents
    where owner_id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
  `;
  await db`
    delete from public.event_outbox
    where topic like 'talk:%'
  `;
}

describe('job-accessors-pg (postgres + RLS)', () => {
  beforeAll(async () => {
    await initPgDatabase();
    await seedAuthUser(USER_A_ID, 'jobs-a@clawtalk.local', 'Jobs User A');
    await seedAuthUser(USER_B_ID, 'jobs-b@clawtalk.local', 'Jobs User B');
    await seedProvider();
  });

  afterAll(async () => {
    const db = getDbPg();
    await db`
      delete from auth.users where id in (${USER_A_ID}::uuid, ${USER_B_ID}::uuid)
    `;
    await db`
      delete from public.llm_provider_models where provider_id = ${PROVIDER_ID}
    `;
    await db`
      delete from public.llm_providers where id = ${PROVIDER_ID}
    `;
    await closePgDatabase();
  });

  beforeEach(async () => {
    await purge();
  });

  async function setupTalkWithAgent(): Promise<{
    talkId: string;
    threadId: string;
    agentId: string;
  }> {
    const { talkId, agentId } = await withUserContext(USER_A_ID, async () => {
      const talk = await createTalk({
        ownerId: USER_A_ID,
        topicTitle: 'Jobs Talk',
      });
      const agent = await createRegisteredAgent({
        ownerId: USER_A_ID,
        name: 'Argus',
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
      });
      return { talkId: talk.id, agentId: agent.id };
    });
    // Wire talk_agents membership (chassis-era surface, but the table
    // itself is in the pg schema and the dependency validator reads it).
    await seedTalkAgent({ ownerId: USER_A_ID, talkId, agentId });
    const threadId = await withUserContext(USER_A_ID, async () => {
      return await getOrCreateDefaultThread({
        talkId,
        ownerId: USER_A_ID,
      });
    });
    return { talkId, threadId, agentId };
  }

  // ── CRUD ───────────────────────────────────────────────────────────

  it('createTalkJob: persists job + spins up a thread; getTalkJob/getById match', async () => {
    const { talkId, agentId } = await setupTalkWithAgent();
    const job = await withUserContext(USER_A_ID, async () => {
      return await createTalkJob({
        ownerId: USER_A_ID,
        talkId,
        title: 'Daily Standup',
        prompt: 'What changed today?',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 6 },
        timezone: 'America/Los_Angeles',
        deliverableKind: 'thread',
        createdBy: USER_A_ID,
      });
    });
    expect(job.title).toBe('Daily Standup');
    expect(job.status).toBe('active');
    expect(job.targetAgentId).toBe(agentId);
    expect(job.targetAgentNickname).toBe('Argus');
    expect(job.threadId).toBeTruthy();
    expect(job.nextDueAt).toBeTruthy();
    expect(job.runCount).toBe(0);

    await withUserContext(USER_A_ID, async () => {
      expect((await getTalkJob(talkId, job.id))?.id).toBe(job.id);
      expect((await getTalkJobById(job.id))?.id).toBe(job.id);
    });
  });

  it('createTalkJob: rejects when target agent is not a talk member', async () => {
    const { talkId } = await setupTalkWithAgent();
    const otherAgent = await withUserContext(USER_A_ID, async () => {
      return await createRegisteredAgent({
        ownerId: USER_A_ID,
        name: 'Stranger',
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
      });
    });
    await expect(
      withUserContext(USER_A_ID, async () => {
        await createTalkJob({
          ownerId: USER_A_ID,
          talkId,
          title: 'Bad',
          prompt: 'wat',
          targetAgentId: otherAgent.id,
          schedule: { kind: 'hourly_interval', everyHours: 12 },
          timezone: 'UTC',
          deliverableKind: 'thread',
          createdBy: USER_A_ID,
        });
      }),
    ).rejects.toThrow(/not currently configured on this talk/);
  });

  it('patchTalkJob + delete: roundtrips updates; deleteTalkJob marks thread internal', async () => {
    const { talkId, agentId } = await setupTalkWithAgent();
    const job = await withUserContext(USER_A_ID, async () => {
      return await createTalkJob({
        ownerId: USER_A_ID,
        talkId,
        title: 'Original',
        prompt: 'Original prompt',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 1 },
        timezone: 'UTC',
        deliverableKind: 'thread',
        createdBy: USER_A_ID,
      });
    });

    const patched = await withUserContext(USER_A_ID, async () => {
      return await patchTalkJob({
        talkId,
        jobId: job.id,
        title: 'Renamed',
        prompt: 'New prompt',
        schedule: {
          kind: 'weekly',
          weekdays: ['mon', 'wed', 'fri'],
          hour: 9,
          minute: 0,
        },
      });
    });
    expect(patched?.title).toBe('Renamed');
    expect(patched?.prompt).toBe('New prompt');
    expect(patched?.schedule.kind).toBe('weekly');

    const ok = await withUserContext(USER_A_ID, async () => {
      return await deleteTalkJob(talkId, job.id);
    });
    expect(ok).toBe(true);

    await withUserContext(USER_A_ID, async () => {
      expect(await getTalkJob(talkId, job.id)).toBeUndefined();
      // Thread is marked internal (UI hides it from the user's tab list).
      const db = getDbPg();
      const threadRows = await db<{ is_internal: boolean }[]>`
        select is_internal from public.talk_threads
        where id = ${patched!.threadId}::uuid
      `;
      expect(threadRows[0]?.is_internal).toBe(true);
    });
  });

  // ── Status transitions ─────────────────────────────────────────────

  it('pauseTalkJob clears nextDueAt; resumeTalkJob recomputes it', async () => {
    const { talkId, agentId } = await setupTalkWithAgent();
    const job = await withUserContext(USER_A_ID, async () => {
      return await createTalkJob({
        ownerId: USER_A_ID,
        talkId,
        title: 'Pausable',
        prompt: 'hi',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 4 },
        timezone: 'UTC',
        deliverableKind: 'thread',
        createdBy: USER_A_ID,
      });
    });
    const paused = await withUserContext(USER_A_ID, async () => {
      return await pauseTalkJob(talkId, job.id);
    });
    expect(paused?.status).toBe('paused');
    expect(paused?.nextDueAt).toBeNull();

    const resumed = await withUserContext(USER_A_ID, async () => {
      return await resumeTalkJob(talkId, job.id);
    });
    expect(resumed?.status).toBe('active');
    expect(resumed?.nextDueAt).toBeTruthy();
  });

  it('blockTalkJob: marks blocked + records lastRunStatus', async () => {
    const { talkId, agentId } = await setupTalkWithAgent();
    const job = await withUserContext(USER_A_ID, async () => {
      return await createTalkJob({
        ownerId: USER_A_ID,
        talkId,
        title: 'Blockable',
        prompt: 'p',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 8 },
        timezone: 'UTC',
        deliverableKind: 'thread',
        createdBy: USER_A_ID,
      });
    });
    const blocked = await withUserContext(USER_A_ID, async () => {
      return await blockTalkJob(talkId, job.id, 'thread_missing');
    });
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.lastRunStatus).toBe('thread_missing');
    expect(blocked?.nextDueAt).toBeNull();
  });

  // ── claimDueTalkJobs ───────────────────────────────────────────────

  it('claimDueTalkJobs: pulls due active jobs and advances nextDueAt', async () => {
    const { talkId, agentId } = await setupTalkWithAgent();
    // Use a backdated `now` so the job's initial nextDueAt is in the
    // past at claim time. The accessor sets nextDueAt = now + 1h on
    // create; we ask claimDueTalkJobs for `now + 2h` to ensure the row
    // is selected.
    const createdAt = await withUserContext(USER_A_ID, async () => {
      const j = await createTalkJob({
        ownerId: USER_A_ID,
        talkId,
        title: 'Due',
        prompt: 'p',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 1 },
        timezone: 'UTC',
        deliverableKind: 'thread',
        createdBy: USER_A_ID,
      });
      return j.nextDueAt!;
    });
    const claimAt = new Date(
      new Date(createdAt).getTime() + 60_000,
    ).toISOString();
    const claimed = await withUserContext(USER_A_ID, async () => {
      return await claimDueTalkJobs(10, claimAt);
    });
    expect(claimed.length).toBe(1);
    // nextDueAt advanced past claimAt.
    expect(Date.parse(claimed[0].nextDueAt!)).toBeGreaterThan(
      Date.parse(claimAt),
    );
  });

  // ── createJobTriggerRun ────────────────────────────────────────────

  it('createJobTriggerRun: enqueues a user message + queued run + outbox event', async () => {
    const { talkId, threadId, agentId } = await setupTalkWithAgent();
    const job = await withUserContext(USER_A_ID, async () => {
      return await createTalkJob({
        ownerId: USER_A_ID,
        talkId,
        title: 'Trigger',
        prompt: 'Trigger prompt',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 1 },
        timezone: 'UTC',
        deliverableKind: 'thread',
        createdBy: USER_A_ID,
      });
    });

    const result = await withUserContext(USER_A_ID, async () => {
      return await createJobTriggerRun({
        ownerId: USER_A_ID,
        jobId: job.id,
        triggerSource: 'manual',
      });
    });
    expect(result.status).toBe('enqueued');
    if (result.status !== 'enqueued') throw new Error('unreachable');
    expect(result.talkId).toBe(talkId);
    expect(result.threadId).toBe(job.threadId);

    await withUserContext(USER_A_ID, async () => {
      const db = getDbPg();
      const message = await db<{ content: string; role: string }[]>`
        select content, role from public.talk_messages
        where id = ${result.messageId}::uuid
      `;
      expect(message[0]?.content).toBe('Trigger prompt');
      expect(message[0]?.role).toBe('user');
      const run = await db<{ status: string; job_id: string }[]>`
        select status, job_id from public.talk_runs
        where id = ${result.runId}::uuid
      `;
      expect(run[0]?.status).toBe('queued');
      expect(run[0]?.job_id).toBe(job.id);

      const events = await getOutboxEventsForTopics([`talk:${talkId}`], 0);
      expect(events.some((e) => e.event_type === 'message_appended')).toBe(
        true,
      );
    });
    // Silences unused-var lint for threadId.
    expect(threadId).toBeTruthy();
  });

  it('createJobTriggerRun: returns paused branch when status=paused and !allowPaused', async () => {
    const { talkId, agentId } = await setupTalkWithAgent();
    const job = await withUserContext(USER_A_ID, async () => {
      const j = await createTalkJob({
        ownerId: USER_A_ID,
        talkId,
        title: 'Sleep',
        prompt: 'zzz',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 1 },
        timezone: 'UTC',
        deliverableKind: 'thread',
        createdBy: USER_A_ID,
      });
      await pauseTalkJob(talkId, j.id);
      return j;
    });
    const result = await withUserContext(USER_A_ID, async () => {
      return await createJobTriggerRun({
        ownerId: USER_A_ID,
        jobId: job.id,
        triggerSource: 'scheduler',
      });
    });
    expect(result.status).toBe('paused');
  });

  it('createJobTriggerRun: returns job_busy when an active run exists', async () => {
    const { talkId, agentId } = await setupTalkWithAgent();
    const job = await withUserContext(USER_A_ID, async () => {
      return await createTalkJob({
        ownerId: USER_A_ID,
        talkId,
        title: 'Busy',
        prompt: 'p',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 1 },
        timezone: 'UTC',
        deliverableKind: 'thread',
        createdBy: USER_A_ID,
      });
    });
    // Park a queued run tied to this job.
    await withUserContext(USER_A_ID, async () => {
      await createTalkRun({
        ownerId: USER_A_ID,
        talkId,
        threadId: job.threadId,
        requestedBy: USER_A_ID,
        status: 'queued',
        jobId: job.id,
      });
    });
    const result = await withUserContext(USER_A_ID, async () => {
      return await createJobTriggerRun({
        ownerId: USER_A_ID,
        jobId: job.id,
        triggerSource: 'manual',
      });
    });
    expect(result.status).toBe('job_busy');
  });

  it('createJobTriggerRun: detects target-agent membership loss and blocks the job', async () => {
    const { talkId, agentId } = await setupTalkWithAgent();
    const job = await withUserContext(USER_A_ID, async () => {
      return await createTalkJob({
        ownerId: USER_A_ID,
        talkId,
        title: 'Drift',
        prompt: 'p',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 1 },
        timezone: 'UTC',
        deliverableKind: 'thread',
        createdBy: USER_A_ID,
      });
    });
    // Remove the talk_agents membership row → the target agent is no
    // longer attached.
    const db = getDbPg();
    await db`
      delete from public.talk_agents
      where talk_id = ${talkId}::uuid and registered_agent_id = ${agentId}::uuid
    `;
    const result = await withUserContext(USER_A_ID, async () => {
      return await createJobTriggerRun({
        ownerId: USER_A_ID,
        jobId: job.id,
        triggerSource: 'scheduler',
      });
    });
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('unreachable');
    expect(result.issue.code).toBe('target_agent_missing');
    expect(result.job.status).toBe('blocked');
  });

  // ── Other helpers ──────────────────────────────────────────────────

  it('markTalkJobRunQueued / Finished + listTalkJobRunSummaries: surface run history', async () => {
    const { talkId, agentId } = await setupTalkWithAgent();
    const job = await withUserContext(USER_A_ID, async () => {
      return await createTalkJob({
        ownerId: USER_A_ID,
        talkId,
        title: 'History',
        prompt: 'p',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 1 },
        timezone: 'UTC',
        deliverableKind: 'thread',
        createdBy: USER_A_ID,
      });
    });
    // Spin a run + an assistant response so listTalkJobRunSummaries
    // populates response_excerpt.
    await withUserContext(USER_A_ID, async () => {
      const run = await createTalkRun({
        ownerId: USER_A_ID,
        talkId,
        threadId: job.threadId,
        requestedBy: USER_A_ID,
        status: 'completed',
        jobId: job.id,
      });
      const db = getDbPg();
      await db`
        insert into public.talk_messages
          (talk_id, thread_id, owner_id, role, content, run_id)
        values (${talkId}::uuid, ${job.threadId}::uuid, ${USER_A_ID}::uuid,
                'assistant',
                'Daily standup summary: zero blockers, three PRs landed.',
                ${run.id}::uuid)
      `;
      await markTalkJobRunQueued(job.id);
      await markTalkJobRunFinished({ jobId: job.id, status: 'completed' });
    });

    const summaries = await withUserContext(USER_A_ID, async () => {
      return await listTalkJobRunSummaries(talkId, job.id, 10);
    });
    expect(summaries.length).toBe(1);
    expect(summaries[0].status).toBe('completed');
    expect(summaries[0].responseExcerpt).toMatch(/Daily standup/);

    const refetched = await withUserContext(USER_A_ID, async () => {
      return await getTalkJob(talkId, job.id);
    });
    expect(refetched?.runCount).toBe(1);
    expect(refetched?.lastRunStatus).toBe('completed');
  });

  it('listTalkJobs: orders active first, then due-soonest', async () => {
    const { talkId, agentId } = await setupTalkWithAgent();
    await withUserContext(USER_A_ID, async () => {
      const active1 = await createTalkJob({
        ownerId: USER_A_ID,
        talkId,
        title: 'Active 1',
        prompt: 'p',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 4 },
        timezone: 'UTC',
        deliverableKind: 'thread',
        createdBy: USER_A_ID,
      });
      const paused1 = await createTalkJob({
        ownerId: USER_A_ID,
        talkId,
        title: 'Paused 1',
        prompt: 'p',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 4 },
        timezone: 'UTC',
        deliverableKind: 'thread',
        createdBy: USER_A_ID,
      });
      await pauseTalkJob(talkId, paused1.id);
      // Silences unused-var lint.
      expect(active1.id).toBeTruthy();
    });

    const list = await withUserContext(USER_A_ID, async () => {
      return await listTalkJobs(talkId);
    });
    expect(list.length).toBe(2);
    expect(list[0].status).toBe('active');
    expect(list[1].status).toBe('paused');
  });

  // ── Dependency issue surface ──────────────────────────────────────

  it('getTalkJobDependencyIssue: reports missing target agent membership', async () => {
    const { talkId, agentId } = await setupTalkWithAgent();
    const job = await withUserContext(USER_A_ID, async () => {
      return await createTalkJob({
        ownerId: USER_A_ID,
        talkId,
        title: 'Wobbly',
        prompt: 'p',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 1 },
        timezone: 'UTC',
        deliverableKind: 'thread',
        createdBy: USER_A_ID,
      });
    });
    // Pull the membership row.
    const db = getDbPg();
    await db`
      delete from public.talk_agents
      where talk_id = ${talkId}::uuid and registered_agent_id = ${agentId}::uuid
    `;
    const issue = await withUserContext(USER_A_ID, async () => {
      return await getTalkJobDependencyIssue(job);
    });
    expect(issue?.code).toBe('target_agent_missing');
  });

  // ── RLS gate ───────────────────────────────────────────────────────

  it('RLS gate: USER_B cannot read or mutate USER_A talk_jobs', async () => {
    const { talkId, agentId } = await setupTalkWithAgent();
    const job = await withUserContext(USER_A_ID, async () => {
      return await createTalkJob({
        ownerId: USER_A_ID,
        talkId,
        title: 'A only',
        prompt: 'p',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 1 },
        timezone: 'UTC',
        deliverableKind: 'thread',
        createdBy: USER_A_ID,
      });
    });
    await withUserContext(USER_B_ID, async () => {
      // RLS hides A's row from B.
      expect(await getTalkJob(talkId, job.id)).toBeUndefined();
      // Update affects zero rows.
      expect(await pauseTalkJob(talkId, job.id)).toBeUndefined();
      // Delete returns false.
      expect(await deleteTalkJob(talkId, job.id)).toBe(false);
    });
  });

  it('enqueueTalkTurnAtomic still works alongside the jobs surface (sanity)', async () => {
    // Cheap interop check: the jobs port shares createTalkMessage +
    // createTalkRun + appendOutboxEvent with the multi-agent turn
    // surface. Spin a regular turn to make sure nothing got monkey-
    // patched on the shared accessors.
    const { talkId, threadId } = await setupTalkWithAgent();
    const AGENT_TURN = '0c777777-9999-9999-9999-000000000001';
    const result = await withUserContext(USER_A_ID, async () => {
      return await enqueueTalkTurnAtomic({
        ownerId: USER_A_ID,
        talkId,
        threadId,
        userId: USER_A_ID,
        content: 'just checking',
        targetAgentIds: [AGENT_TURN],
      });
    });
    expect(result.runs.length).toBe(1);
    expect(result.runs[0].target_agent_id).toBe(AGENT_TURN);
    // Silence unused-import lint for appendOutboxEvent (kept in import
    // for parity with other test files).
    expect(typeof appendOutboxEvent).toBe('function');
  });
});
