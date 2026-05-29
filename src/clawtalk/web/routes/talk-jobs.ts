import { withUserContext } from '../../../db.js';
import {
  blockTalkJob,
  createJobTriggerRun,
  createTalkJob,
  deleteTalkJob,
  getTalkForUser,
  getTalkJob,
  listTalkJobRunSummaries,
  listTalkJobs,
  patchTalkJob,
  pauseTalkJob,
  resumeTalkJob,
  type TalkJob,
  type TalkJobRunSummary,
  type TalkJobSchedule,
  type TalkJobScope,
} from '../../db/index.js';
import { canEditTalk } from '../middleware/acl.js';
import { ApiEnvelope, AuthContext } from '../types.js';

function notFound(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 404,
    body: { ok: false, error: { code: 'not_found', message } },
  };
}

function forbidden(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 403,
    body: { ok: false, error: { code: 'forbidden', message } },
  };
}

function badRequest(
  code: string,
  message: string,
): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 400,
    body: { ok: false, error: { code, message } },
  };
}

function conflict(
  code: string,
  message: string,
): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 409,
    body: { ok: false, error: { code, message } },
  };
}

async function requireTalk(talkId: string) {
  return await getTalkForUser(talkId);
}

async function requireEditAccess(
  talkId: string,
): Promise<ReturnType<typeof forbidden> | null> {
  if (!(await canEditTalk(talkId))) {
    return forbidden('You do not have permission to edit jobs for this talk.');
  }
  return null;
}

export async function listTalkJobsRoute(input: {
  auth: AuthContext;
  talkId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ jobs: TalkJob[] }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await requireTalk(input.talkId);
    if (!talk) return notFound('Talk not found.');

    return {
      statusCode: 200,
      body: { ok: true, data: { jobs: await listTalkJobs(input.talkId) } },
    };
  });
}

export async function getTalkJobRoute(input: {
  auth: AuthContext;
  talkId: string;
  jobId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ job: TalkJob }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await requireTalk(input.talkId);
    if (!talk) return notFound('Talk not found.');

    const job = await getTalkJob(input.talkId, input.jobId);
    if (!job) return notFound('Job not found.');

    return {
      statusCode: 200,
      body: { ok: true, data: { job } },
    };
  });
}

export async function createTalkJobRoute(input: {
  auth: AuthContext;
  talkId: string;
  title: string;
  prompt: string;
  targetAgentId: string;
  schedule: TalkJobSchedule;
  timezone: string;
  sourceScope?: TalkJobScope;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ job: TalkJob }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await requireTalk(input.talkId);
    if (!talk) return notFound('Talk not found.');
    const denied = await requireEditAccess(input.talkId);
    if (denied) return denied;

    try {
      const job = await createTalkJob({
        ownerId: input.auth.userId,
        talkId: input.talkId,
        title: input.title,
        prompt: input.prompt,
        targetAgentId: input.targetAgentId,
        schedule: input.schedule,
        timezone: input.timezone,
        sourceScope: input.sourceScope,
        createdBy: input.auth.userId,
      });
      return {
        statusCode: 201,
        body: { ok: true, data: { job } },
      };
    } catch (error) {
      return badRequest(
        'invalid_job',
        error instanceof Error ? error.message : 'Failed to create job.',
      );
    }
  });
}

export async function patchTalkJobRoute(input: {
  auth: AuthContext;
  talkId: string;
  jobId: string;
  title?: string;
  prompt?: string;
  targetAgentId?: string;
  schedule?: TalkJobSchedule;
  timezone?: string;
  sourceScope?: TalkJobScope;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ job: TalkJob }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await requireTalk(input.talkId);
    if (!talk) return notFound('Talk not found.');
    const denied = await requireEditAccess(input.talkId);
    if (denied) return denied;

    const current = await getTalkJob(input.talkId, input.jobId);
    if (!current) return notFound('Job not found.');

    try {
      const job = await patchTalkJob({
        talkId: input.talkId,
        jobId: input.jobId,
        title: input.title,
        prompt: input.prompt,
        targetAgentId: input.targetAgentId,
        schedule: input.schedule,
        timezone: input.timezone,
        sourceScope: input.sourceScope,
      });
      if (!job) return notFound('Job not found.');
      return {
        statusCode: 200,
        body: { ok: true, data: { job } },
      };
    } catch (error) {
      return badRequest(
        'invalid_job',
        error instanceof Error ? error.message : 'Failed to update job.',
      );
    }
  });
}

export async function deleteTalkJobRoute(input: {
  auth: AuthContext;
  talkId: string;
  jobId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await requireTalk(input.talkId);
    if (!talk) return notFound('Talk not found.');
    const denied = await requireEditAccess(input.talkId);
    if (denied) return denied;

    const deleted = await deleteTalkJob(input.talkId, input.jobId);
    if (!deleted) return notFound('Job not found.');

    return {
      statusCode: 200,
      body: { ok: true, data: { deleted: true } },
    };
  });
}

export async function pauseTalkJobRoute(input: {
  auth: AuthContext;
  talkId: string;
  jobId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ job: TalkJob }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await requireTalk(input.talkId);
    if (!talk) return notFound('Talk not found.');
    const denied = await requireEditAccess(input.talkId);
    if (denied) return denied;

    const job = await pauseTalkJob(input.talkId, input.jobId);
    if (!job) return notFound('Job not found.');

    return {
      statusCode: 200,
      body: { ok: true, data: { job } },
    };
  });
}

export async function resumeTalkJobRoute(input: {
  auth: AuthContext;
  talkId: string;
  jobId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ job: TalkJob }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await requireTalk(input.talkId);
    if (!talk) return notFound('Talk not found.');
    const denied = await requireEditAccess(input.talkId);
    if (denied) return denied;

    const job = await resumeTalkJob(input.talkId, input.jobId);
    if (!job) return notFound('Job not found.');

    return {
      statusCode: 200,
      body: { ok: true, data: { job } },
    };
  });
}

type RunTalkJobNowResult =
  | {
      statusCode: number;
      body: ApiEnvelope<{
        job: TalkJob;
        runId: string;
        triggerMessageId: string;
      }>;
    }
  | {
      statusCode: number;
      body: ApiEnvelope<never>;
    };

export async function runTalkJobNowRoute(input: {
  auth: AuthContext;
  talkId: string;
  jobId: string;
}): Promise<RunTalkJobNowResult> {
  return await withUserContext<RunTalkJobNowResult>(
    input.auth.userId,
    async (): Promise<RunTalkJobNowResult> => {
      const talk = await requireTalk(input.talkId);
      if (!talk) return notFound('Talk not found.');
      const denied = await requireEditAccess(input.talkId);
      if (denied) return denied;

      const result = await createJobTriggerRun({
        ownerId: input.auth.userId,
        jobId: input.jobId,
        triggerSource: 'manual',
        allowPaused: true,
      });

      switch (result.status) {
        case 'not_found':
          return notFound('Job not found.');
        case 'blocked':
          return conflict('job_blocked', result.issue.message);
        case 'job_busy':
          return conflict(
            'job_busy',
            'This job already has an active queued or running run.',
          );
        case 'thread_busy':
          return conflict(
            'thread_busy',
            'A round is already in progress on this thread. Wait for it to finish or cancel before running the job.',
          );
        case 'paused':
          return badRequest(
            'job_paused',
            'Paused jobs must be resumed before they can run now.',
          );
        case 'enqueued':
          return {
            statusCode: 202,
            body: {
              ok: true,
              data: {
                job: result.job,
                runId: result.runId,
                triggerMessageId: result.messageId,
              },
            },
          };
      }
    },
  );
}

export async function listTalkJobRunsRoute(input: {
  auth: AuthContext;
  talkId: string;
  jobId: string;
  limit?: number;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ runs: TalkJobRunSummary[] }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await requireTalk(input.talkId);
    if (!talk) return notFound('Talk not found.');
    const job = await getTalkJob(input.talkId, input.jobId);
    if (!job) return notFound('Job not found.');

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          runs: await listTalkJobRunSummaries(
            input.talkId,
            input.jobId,
            input.limit,
          ),
        },
      },
    };
  });
}

export async function blockTalkJobRoute(input: {
  auth: AuthContext;
  talkId: string;
  jobId: string;
  lastRunStatus?: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ job: TalkJob }>;
}> {
  return await withUserContext(input.auth.userId, async () => {
    const talk = await requireTalk(input.talkId);
    if (!talk) return notFound('Talk not found.');
    const denied = await requireEditAccess(input.talkId);
    if (denied) return denied;
    const job = await blockTalkJob(
      input.talkId,
      input.jobId,
      input.lastRunStatus ?? 'blocked',
    );
    if (!job) return notFound('Job not found.');
    return { statusCode: 200, body: { ok: true, data: { job } } };
  });
}
