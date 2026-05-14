import { withUserContext } from '../../../db.js';
import {
  blockTalkJob,
  createJobTriggerRun,
  createTalkJob,
  createTalkOutput,
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

function normalizeCreateReportPayload(value: unknown): {
  title: string;
  contentMarkdown: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const title =
    typeof (value as { title?: unknown }).title === 'string'
      ? (value as { title: string }).title.trim()
      : '';
  const contentMarkdown =
    typeof (value as { contentMarkdown?: unknown }).contentMarkdown === 'string'
      ? (value as { contentMarkdown: string }).contentMarkdown
      : '';
  if (!title) {
    throw new Error('createReport requires a title.');
  }
  return { title, contentMarkdown };
}

async function resolveReportTarget(input: {
  talkId: string;
  deliverableKind: 'thread' | 'report';
  reportOutputId?: string | null;
  createReport?: unknown;
  auth: AuthContext;
}): Promise<string | null | undefined> {
  if (input.deliverableKind !== 'report') {
    return null;
  }
  if (typeof input.reportOutputId === 'string' && input.reportOutputId.trim()) {
    return input.reportOutputId.trim();
  }
  const createReport = normalizeCreateReportPayload(input.createReport);
  if (!createReport) {
    return undefined;
  }
  const output = await createTalkOutput({
    ownerId: input.auth.userId,
    talkId: input.talkId,
    title: createReport.title,
    contentMarkdown: createReport.contentMarkdown,
    createdByUserId: input.auth.userId,
  });
  return output.id;
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
  deliverableKind: 'thread' | 'report';
  reportOutputId?: string | null;
  createReport?: unknown;
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
      const reportOutputId = await resolveReportTarget({
        talkId: input.talkId,
        deliverableKind: input.deliverableKind,
        reportOutputId: input.reportOutputId,
        createReport: input.createReport,
        auth: input.auth,
      });
      if (input.deliverableKind === 'report' && !reportOutputId) {
        return badRequest(
          'report_target_required',
          'Report jobs require an existing reportOutputId or createReport payload.',
        );
      }

      const job = await createTalkJob({
        ownerId: input.auth.userId,
        talkId: input.talkId,
        title: input.title,
        prompt: input.prompt,
        targetAgentId: input.targetAgentId,
        schedule: input.schedule,
        timezone: input.timezone,
        deliverableKind: input.deliverableKind,
        reportOutputId,
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
  deliverableKind?: 'thread' | 'report';
  reportOutputId?: string | null;
  createReport?: unknown;
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
      const deliverableKind = input.deliverableKind ?? current.deliverableKind;
      const reportOutputId = await resolveReportTarget({
        talkId: input.talkId,
        deliverableKind,
        reportOutputId:
          input.reportOutputId !== undefined
            ? input.reportOutputId
            : current.reportOutputId,
        createReport: input.createReport,
        auth: input.auth,
      });
      if (deliverableKind === 'report' && !reportOutputId) {
        return badRequest(
          'report_target_required',
          'Report jobs require an existing reportOutputId or createReport payload.',
        );
      }

      const job = await patchTalkJob({
        talkId: input.talkId,
        jobId: input.jobId,
        title: input.title,
        prompt: input.prompt,
        targetAgentId: input.targetAgentId,
        schedule: input.schedule,
        timezone: input.timezone,
        deliverableKind,
        reportOutputId,
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
