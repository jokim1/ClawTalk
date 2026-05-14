// clawtalk Phase 5 (PR 2) — postgres port of job-accessors.ts.
//
// Behavior changes vs sqlite:
//   - `talk_data_connectors` + `talk_channel_bindings` validation
//     dropped (chassis removal). `validateScopedConnectorIds` +
//     `validateScopedChannelBindingIds` gone. `getTalkJobDependencyIssue`
//     no longer returns `connector_scope_invalid` /
//     `channel_scope_invalid` codes. `sourceScope.connectorIds` and
//     `sourceScope.channelBindingIds` continue to round-trip on the row
//     for forward-compatibility but no longer validate against
//     attachment tables.
//   - IDs use bare uuid (no `job_`/`msg_`/`run_` string prefixes).
//   - `schedule_json` + `source_scope_json` are jsonb columns; they
//     round-trip as parsed objects rather than strings — no JSON.parse /
//     JSON.stringify at accessor boundary.
//   - Inserts/updates rely on RLS `owner_id = auth.uid()` instead of an
//     explicit ownerId WHERE clause.

import {
  appendOutboxEvent,
  createTalkMessage,
  createTalkRun,
  createTalkThread,
} from './accessors.js';
import { getDbPg } from '../../db.js';

export type TalkJobStatus = 'active' | 'paused' | 'blocked';
export type TalkJobDeliverableKind = 'thread' | 'report';
export type TalkJobWeekday =
  | 'sun'
  | 'mon'
  | 'tue'
  | 'wed'
  | 'thu'
  | 'fri'
  | 'sat';

export type TalkJobSchedule =
  | { kind: 'hourly_interval'; everyHours: number }
  | {
      kind: 'weekly';
      weekdays: TalkJobWeekday[];
      hour: number;
      minute: number;
    };

export interface TalkJobScope {
  connectorIds: string[];
  channelBindingIds: string[];
  allowWeb: boolean;
}

interface TalkJobRow {
  id: string;
  talk_id: string;
  owner_id: string;
  title: string;
  prompt: string;
  target_agent_id: string | null;
  target_agent_nickname: string | null;
  status: TalkJobStatus;
  schedule_json: TalkJobSchedule;
  timezone: string;
  deliverable_kind: TalkJobDeliverableKind;
  report_output_id: string | null;
  report_output_title: string | null;
  source_scope_json: TalkJobScope;
  thread_id: string;
  last_run_at: string | null;
  last_run_status: string | null;
  next_due_at: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export interface TalkJob {
  id: string;
  talkId: string;
  ownerId: string;
  title: string;
  prompt: string;
  targetAgentId: string | null;
  targetAgentNickname: string | null;
  status: TalkJobStatus;
  schedule: TalkJobSchedule;
  timezone: string;
  deliverableKind: TalkJobDeliverableKind;
  reportOutputId: string | null;
  reportOutputTitle: string | null;
  sourceScope: TalkJobScope;
  threadId: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  nextDueAt: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface TalkJobRunSummary {
  id: string;
  threadId: string;
  status:
    | 'queued'
    | 'running'
    | 'awaiting_confirmation'
    | 'cancelled'
    | 'completed'
    | 'failed';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  triggerMessageId: string | null;
  responseExcerpt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  cancelReason: string | null;
  executorAlias: string | null;
  executorModel: string | null;
}

export interface TalkJobDependencyIssue {
  code: 'target_agent_missing' | 'report_output_missing' | 'thread_missing';
  message: string;
}

// ---------------------------------------------------------------------------
// Input normalizers (pure JS — identical to the sqlite-era validators).
// ---------------------------------------------------------------------------

function normalizePrompt(prompt: string): string {
  const normalized = prompt.trim();
  if (!normalized) {
    throw new Error('Job prompt is required');
  }
  return normalized;
}

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized) {
    throw new Error('Job title is required');
  }
  return normalized;
}

function validateTimezone(timezone: string): string {
  const normalized = timezone.trim();
  if (!normalized) {
    throw new Error('Timezone is required');
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date());
    return normalized;
  } catch {
    throw new Error('Timezone is invalid');
  }
}

function normalizeWeekdays(values: unknown): TalkJobWeekday[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Weekly schedules require at least one weekday');
  }
  const allowed = new Set<TalkJobWeekday>([
    'sun',
    'mon',
    'tue',
    'wed',
    'thu',
    'fri',
    'sat',
  ]);
  const normalized = Array.from(
    new Set(
      values
        .map((value) =>
          typeof value === 'string' ? value.trim().toLowerCase() : '',
        )
        .filter((value): value is TalkJobWeekday =>
          allowed.has(value as TalkJobWeekday),
        ),
    ),
  );
  if (normalized.length === 0) {
    throw new Error('Weekly schedules require valid weekdays');
  }
  return normalized;
}

function normalizeIntegerInRange(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function normalizeTalkJobSchedule(raw: unknown): TalkJobSchedule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Schedule is required');
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.kind === 'hourly_interval') {
    return {
      kind: 'hourly_interval',
      everyHours: normalizeIntegerInRange(
        candidate.everyHours,
        1,
        24,
        'everyHours',
      ),
    };
  }
  if (candidate.kind === 'weekly') {
    return {
      kind: 'weekly',
      weekdays: normalizeWeekdays(candidate.weekdays),
      hour: normalizeIntegerInRange(candidate.hour, 0, 23, 'hour'),
      minute: normalizeIntegerInRange(candidate.minute, 0, 59, 'minute'),
    };
  }
  throw new Error('Schedule kind must be hourly_interval or weekly');
}

function normalizeStringIdList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean),
    ),
  );
}

export function normalizeTalkJobScope(raw: unknown): TalkJobScope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { connectorIds: [], channelBindingIds: [], allowWeb: false };
  }
  const candidate = raw as Record<string, unknown>;
  return {
    connectorIds: normalizeStringIdList(candidate.connectorIds),
    channelBindingIds: normalizeStringIdList(candidate.channelBindingIds),
    allowWeb: candidate.allowWeb === true,
  };
}

function getLocalDateParts(
  date: Date,
  timezone: string,
): { weekday: TalkJobWeekday; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value || '';
  const weekdayRaw = get('weekday').toLowerCase();
  const weekdayMap: Record<string, TalkJobWeekday> = {
    sun: 'sun',
    mon: 'mon',
    tue: 'tue',
    wed: 'wed',
    thu: 'thu',
    fri: 'fri',
    sat: 'sat',
  };
  return {
    weekday: weekdayMap[weekdayRaw.slice(0, 3)] || 'sun',
    hour: Number.parseInt(get('hour'), 10),
    minute: Number.parseInt(get('minute'), 10),
  };
}

export function computeNextTalkJobDueAt(input: {
  schedule: TalkJobSchedule;
  timezone: string;
  from?: string | Date;
}): string {
  const fromDate =
    input.from instanceof Date
      ? input.from
      : input.from
        ? new Date(input.from)
        : new Date();
  if (input.schedule.kind === 'hourly_interval') {
    return new Date(
      fromDate.getTime() + input.schedule.everyHours * 60 * 60 * 1000,
    ).toISOString();
  }
  const startMs = fromDate.getTime() + 60_000;
  const weekdays = new Set(input.schedule.weekdays);
  const endMs = startMs + 8 * 24 * 60 * 60 * 1000;
  for (let ts = startMs; ts <= endMs; ts += 60_000) {
    const parts = getLocalDateParts(new Date(ts), input.timezone);
    if (
      weekdays.has(parts.weekday) &&
      parts.hour === input.schedule.hour &&
      parts.minute === input.schedule.minute
    ) {
      return new Date(ts).toISOString();
    }
  }
  throw new Error('Could not compute next due time for schedule');
}

// ---------------------------------------------------------------------------
// Row → TalkJob mapping + load
// ---------------------------------------------------------------------------

function toTalkJob(row: TalkJobRow): TalkJob {
  return {
    id: row.id,
    talkId: row.talk_id,
    ownerId: row.owner_id,
    title: row.title,
    prompt: row.prompt,
    targetAgentId: row.target_agent_id,
    targetAgentNickname: row.target_agent_nickname,
    status: row.status,
    schedule: normalizeTalkJobSchedule(row.schedule_json),
    timezone: row.timezone,
    deliverableKind: row.deliverable_kind,
    reportOutputId: row.report_output_id,
    reportOutputTitle: row.report_output_title,
    sourceScope: normalizeTalkJobScope(row.source_scope_json),
    threadId: row.thread_id,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    nextDueAt: row.next_due_at,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

const TALK_JOB_SELECT = `
  j.id,
  j.talk_id,
  j.owner_id,
  j.title,
  j.prompt,
  j.target_agent_id,
  ra.name as target_agent_nickname,
  j.status,
  j.schedule_json,
  j.timezone,
  j.deliverable_kind,
  j.report_output_id,
  o.title as report_output_title,
  j.source_scope_json,
  j.thread_id,
  j.last_run_at,
  j.last_run_status,
  j.next_due_at,
  j.run_count,
  j.created_at,
  j.updated_at,
  j.created_by
`;

export async function listTalkJobs(talkId: string): Promise<TalkJob[]> {
  const db = getDbPg();
  const rows = await db<TalkJobRow[]>`
    select ${db.unsafe(TALK_JOB_SELECT)}
    from public.talk_jobs j
    left join public.registered_agents ra on ra.id = j.target_agent_id
    left join public.talk_outputs o
      on o.id = j.report_output_id and o.talk_id = j.talk_id
    where j.talk_id = ${talkId}::uuid
    order by
      case j.status
        when 'active' then 0
        when 'paused' then 1
        else 2
      end asc,
      coalesce(j.next_due_at, j.updated_at) asc,
      j.created_at asc
  `;
  return rows.map(toTalkJob);
}

export async function getTalkJob(
  talkId: string,
  jobId: string,
): Promise<TalkJob | undefined> {
  const db = getDbPg();
  const rows = await db<TalkJobRow[]>`
    select ${db.unsafe(TALK_JOB_SELECT)}
    from public.talk_jobs j
    left join public.registered_agents ra on ra.id = j.target_agent_id
    left join public.talk_outputs o
      on o.id = j.report_output_id and o.talk_id = j.talk_id
    where j.talk_id = ${talkId}::uuid and j.id = ${jobId}::uuid
    limit 1
  `;
  return rows[0] ? toTalkJob(rows[0]) : undefined;
}

export async function getTalkJobById(
  jobId: string,
): Promise<TalkJob | undefined> {
  const db = getDbPg();
  const rows = await db<TalkJobRow[]>`
    select ${db.unsafe(TALK_JOB_SELECT)}
    from public.talk_jobs j
    left join public.registered_agents ra on ra.id = j.target_agent_id
    left join public.talk_outputs o
      on o.id = j.report_output_id and o.talk_id = j.talk_id
    where j.id = ${jobId}::uuid
    limit 1
  `;
  return rows[0] ? toTalkJob(rows[0]) : undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

async function validateTargetAgentMembership(
  talkId: string,
  targetAgentId: string,
): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ ok: number }[]>`
    select 1 as ok
    from public.talk_agents ta
    join public.registered_agents ra on ra.id = ta.registered_agent_id
    where ta.talk_id = ${talkId}::uuid and ra.id = ${targetAgentId}::uuid
    limit 1
  `;
  return rows.length > 0;
}

async function validateReportOutput(
  talkId: string,
  deliverableKind: TalkJobDeliverableKind,
  reportOutputId: string | null | undefined,
): Promise<void> {
  if (deliverableKind !== 'report') return;
  if (!reportOutputId?.trim()) {
    throw new Error('Report jobs require a configured report output.');
  }
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    select id from public.talk_outputs
    where talk_id = ${talkId}::uuid and id = ${reportOutputId}::uuid
    limit 1
  `;
  if (rows.length === 0) {
    throw new Error('The selected report output was not found on this talk.');
  }
}

async function validateTalkJobConfiguration(input: {
  talkId: string;
  targetAgentId: string;
  deliverableKind: TalkJobDeliverableKind;
  reportOutputId?: string | null;
}): Promise<void> {
  if (
    !(await validateTargetAgentMembership(input.talkId, input.targetAgentId))
  ) {
    throw new Error(
      'The selected Talk agent is not currently configured on this talk.',
    );
  }
  await validateReportOutput(
    input.talkId,
    input.deliverableKind,
    input.reportOutputId,
  );
}

export async function getTalkJobDependencyIssue(
  job: TalkJob,
): Promise<TalkJobDependencyIssue | null> {
  const db = getDbPg();
  const threadRows = await db<{ id: string }[]>`
    select id from public.talk_threads
    where id = ${job.threadId}::uuid and talk_id = ${job.talkId}::uuid
    limit 1
  `;
  if (threadRows.length === 0) {
    return {
      code: 'thread_missing',
      message: 'The job thread no longer exists.',
    };
  }
  if (
    !job.targetAgentId ||
    !(await validateTargetAgentMembership(job.talkId, job.targetAgentId))
  ) {
    return {
      code: 'target_agent_missing',
      message: 'The selected Talk agent is no longer available on this talk.',
    };
  }
  if (job.deliverableKind === 'report') {
    if (!job.reportOutputId) {
      return {
        code: 'report_output_missing',
        message: 'This report job no longer has a configured report output.',
      };
    }
    const outputRows = await db<{ id: string }[]>`
      select id from public.talk_outputs
      where talk_id = ${job.talkId}::uuid and id = ${job.reportOutputId}::uuid
      limit 1
    `;
    if (outputRows.length === 0) {
      return {
        code: 'report_output_missing',
        message: 'The configured report output no longer exists.',
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

async function touchTalkUpdatedAtForJob(
  talkId: string,
  now: string,
): Promise<void> {
  const db = getDbPg();
  await db`
    update public.talks
    set updated_at = ${now}::timestamptz
    where id = ${talkId}::uuid
  `;
}

export async function createTalkJob(input: {
  ownerId: string;
  talkId: string;
  title: string;
  prompt: string;
  targetAgentId: string;
  schedule: TalkJobSchedule;
  timezone: string;
  deliverableKind: TalkJobDeliverableKind;
  reportOutputId?: string | null;
  sourceScope?: TalkJobScope;
  createdBy: string;
}): Promise<TalkJob> {
  const title = normalizeTitle(input.title);
  const prompt = normalizePrompt(input.prompt);
  const schedule = normalizeTalkJobSchedule(input.schedule);
  const timezone = validateTimezone(input.timezone);
  const sourceScope = normalizeTalkJobScope(input.sourceScope);
  await validateTalkJobConfiguration({
    talkId: input.talkId,
    targetAgentId: input.targetAgentId,
    deliverableKind: input.deliverableKind,
    reportOutputId: input.reportOutputId,
  });
  const now = new Date().toISOString();
  const nextDueAt = computeNextTalkJobDueAt({
    schedule,
    timezone,
    from: now,
  });
  const thread = await createTalkThread({
    ownerId: input.ownerId,
    talkId: input.talkId,
    title,
    isInternal: input.deliverableKind === 'report',
  });

  const db = getDbPg();
  const inserted = await db<{ id: string }[]>`
    insert into public.talk_jobs (
      talk_id, owner_id, title, prompt, target_agent_id, status,
      schedule_json, timezone, deliverable_kind, report_output_id,
      source_scope_json, thread_id, next_due_at, created_by,
      created_at, updated_at, run_count
    )
    values (
      ${input.talkId}::uuid, ${input.ownerId}::uuid, ${title}, ${prompt},
      ${input.targetAgentId}::uuid, 'active',
      ${db.json(schedule as never)}, ${timezone}, ${input.deliverableKind},
      ${input.reportOutputId ?? null}::uuid,
      ${db.json(sourceScope as never)}, ${thread.id}::uuid,
      ${nextDueAt}::timestamptz, ${input.createdBy}::uuid,
      ${now}::timestamptz, ${now}::timestamptz, 0
    )
    returning id
  `;
  await touchTalkUpdatedAtForJob(input.talkId, now);
  return (await getTalkJob(input.talkId, inserted[0].id))!;
}

export async function patchTalkJob(input: {
  talkId: string;
  jobId: string;
  title?: string;
  prompt?: string;
  targetAgentId?: string;
  schedule?: TalkJobSchedule;
  timezone?: string;
  deliverableKind?: TalkJobDeliverableKind;
  reportOutputId?: string | null;
  sourceScope?: TalkJobScope;
}): Promise<TalkJob | undefined> {
  const current = await getTalkJob(input.talkId, input.jobId);
  if (!current) return undefined;

  const title =
    input.title !== undefined ? normalizeTitle(input.title) : current.title;
  const prompt =
    input.prompt !== undefined ? normalizePrompt(input.prompt) : current.prompt;
  const targetAgentId =
    input.targetAgentId !== undefined
      ? input.targetAgentId.trim()
      : current.targetAgentId;
  const schedule =
    input.schedule !== undefined
      ? normalizeTalkJobSchedule(input.schedule)
      : current.schedule;
  const timezone =
    input.timezone !== undefined
      ? validateTimezone(input.timezone)
      : current.timezone;
  const deliverableKind = input.deliverableKind ?? current.deliverableKind;
  const sourceScope =
    input.sourceScope !== undefined
      ? normalizeTalkJobScope(input.sourceScope)
      : current.sourceScope;
  const reportOutputId =
    input.reportOutputId !== undefined
      ? input.reportOutputId
      : current.reportOutputId;

  if (!targetAgentId) {
    throw new Error('Job target agent is required');
  }
  await validateTalkJobConfiguration({
    talkId: input.talkId,
    targetAgentId,
    deliverableKind,
    reportOutputId,
  });

  const now = new Date().toISOString();
  const nextDueAt =
    current.status === 'paused' || current.status === 'blocked'
      ? null
      : computeNextTalkJobDueAt({ schedule, timezone, from: now });

  const db = getDbPg();
  await db`
    update public.talk_threads
    set title = ${title},
        is_internal = ${deliverableKind === 'report'},
        updated_at = ${now}::timestamptz
    where id = ${current.threadId}::uuid and talk_id = ${input.talkId}::uuid
  `;
  await db`
    update public.talk_jobs
    set title = ${title},
        prompt = ${prompt},
        target_agent_id = ${targetAgentId}::uuid,
        schedule_json = ${db.json(schedule as never)},
        timezone = ${timezone},
        deliverable_kind = ${deliverableKind},
        report_output_id = ${reportOutputId ?? null}::uuid,
        source_scope_json = ${db.json(sourceScope as never)},
        next_due_at = ${nextDueAt}::timestamptz,
        updated_at = ${now}::timestamptz
    where talk_id = ${input.talkId}::uuid and id = ${input.jobId}::uuid
  `;
  await touchTalkUpdatedAtForJob(input.talkId, now);
  return await getTalkJob(input.talkId, input.jobId);
}

export async function deleteTalkJob(
  talkId: string,
  jobId: string,
): Promise<boolean> {
  const current = await getTalkJob(talkId, jobId);
  if (!current) return false;
  const now = new Date().toISOString();
  const db = getDbPg();
  await db`
    update public.talk_threads
    set is_internal = true, updated_at = ${now}::timestamptz
    where id = ${current.threadId}::uuid and talk_id = ${talkId}::uuid
  `;
  const result = await db<{ id: string }[]>`
    delete from public.talk_jobs
    where talk_id = ${talkId}::uuid and id = ${jobId}::uuid
    returning id
  `;
  if (result.length === 1) {
    await touchTalkUpdatedAtForJob(talkId, now);
  }
  return result.length === 1;
}

async function updateTalkJobStatus(
  talkId: string,
  jobId: string,
  status: TalkJobStatus,
  nextDueAt: string | null,
): Promise<TalkJob | undefined> {
  const now = new Date().toISOString();
  const db = getDbPg();
  const result = await db<{ id: string }[]>`
    update public.talk_jobs
    set status = ${status},
        next_due_at = ${nextDueAt}::timestamptz,
        updated_at = ${now}::timestamptz
    where talk_id = ${talkId}::uuid and id = ${jobId}::uuid
    returning id
  `;
  if (result.length !== 1) return undefined;
  await touchTalkUpdatedAtForJob(talkId, now);
  return await getTalkJob(talkId, jobId);
}

export async function pauseTalkJob(
  talkId: string,
  jobId: string,
): Promise<TalkJob | undefined> {
  return await updateTalkJobStatus(talkId, jobId, 'paused', null);
}

export async function resumeTalkJob(
  talkId: string,
  jobId: string,
): Promise<TalkJob | undefined> {
  const current = await getTalkJob(talkId, jobId);
  if (!current) return undefined;
  const nextDueAt = computeNextTalkJobDueAt({
    schedule: current.schedule,
    timezone: current.timezone,
  });
  return await updateTalkJobStatus(talkId, jobId, 'active', nextDueAt);
}

export async function blockTalkJob(
  talkId: string,
  jobId: string,
  lastRunStatus = 'blocked',
): Promise<TalkJob | undefined> {
  const now = new Date().toISOString();
  const db = getDbPg();
  const result = await db<{ id: string }[]>`
    update public.talk_jobs
    set status = 'blocked',
        next_due_at = null,
        last_run_status = ${lastRunStatus},
        updated_at = ${now}::timestamptz
    where talk_id = ${talkId}::uuid and id = ${jobId}::uuid
    returning id
  `;
  if (result.length !== 1) return undefined;
  await touchTalkUpdatedAtForJob(talkId, now);
  return await getTalkJob(talkId, jobId);
}

// ---------------------------------------------------------------------------
// Run summaries (job activity view)
// ---------------------------------------------------------------------------

function buildResponseExcerpt(content: string | null): string | null {
  if (!content) return null;
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 179).trimEnd()}…`;
}

function parseRunError(input: {
  status: TalkJobRunSummary['status'];
  cancel_reason: string | null;
}): { errorCode: string | null; errorMessage: string | null } {
  const raw = input.cancel_reason?.trim() || null;
  if (!raw) return { errorCode: null, errorMessage: null };
  if (input.status === 'cancelled') {
    return { errorCode: 'cancelled', errorMessage: raw };
  }
  const prefixed = /^([a-z0-9_]+):\s*(.+)$/i.exec(raw);
  if (prefixed) {
    return { errorCode: prefixed[1], errorMessage: prefixed[2] };
  }
  return { errorCode: 'execution_failed', errorMessage: raw };
}

interface TalkRunSummaryRow {
  id: string;
  thread_id: string;
  status: TalkJobRunSummary['status'];
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  trigger_message_id: string | null;
  cancel_reason: string | null;
  executor_alias: string | null;
  executor_model: string | null;
  response_content: string | null;
}

export async function listTalkJobRunSummaries(
  talkId: string,
  jobId: string,
  limit = 20,
): Promise<TalkJobRunSummary[]> {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const db = getDbPg();
  const rows = await db<TalkRunSummaryRow[]>`
    select
      r.id, r.thread_id, r.status, r.created_at, r.started_at, r.ended_at,
      r.trigger_message_id, r.cancel_reason, r.executor_alias,
      r.executor_model,
      (
        select tm.content from public.talk_messages tm
        where tm.run_id = r.id and tm.role = 'assistant'
        order by tm.created_at desc
        limit 1
      ) as response_content
    from public.talk_runs r
    where r.talk_id = ${talkId}::uuid and r.job_id = ${jobId}::uuid
    order by r.created_at desc, r.id desc
    limit ${normalizedLimit}
  `;
  return rows.map((row) => {
    const parsedError = parseRunError({
      status: row.status,
      cancel_reason: row.cancel_reason,
    });
    return {
      id: row.id,
      threadId: row.thread_id,
      status: row.status,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.ended_at,
      triggerMessageId: row.trigger_message_id,
      responseExcerpt: buildResponseExcerpt(row.response_content),
      errorCode: parsedError.errorCode,
      errorMessage: parsedError.errorMessage,
      cancelReason: row.cancel_reason,
      executorAlias: row.executor_alias,
      executorModel: row.executor_model,
    };
  });
}

// ---------------------------------------------------------------------------
// Scheduler ticks
// ---------------------------------------------------------------------------

export async function claimDueTalkJobs(
  limit: number,
  now?: string,
): Promise<TalkJob[]> {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const currentNow = now ?? new Date().toISOString();
  const db = getDbPg();
  const dueRows = await db<TalkJobRow[]>`
    select ${db.unsafe(TALK_JOB_SELECT)}
    from public.talk_jobs j
    left join public.registered_agents ra on ra.id = j.target_agent_id
    left join public.talk_outputs o
      on o.id = j.report_output_id and o.talk_id = j.talk_id
    where j.status = 'active'
      and j.next_due_at is not null
      and j.next_due_at <= ${currentNow}::timestamptz
    order by j.next_due_at asc, j.created_at asc
    limit ${normalizedLimit}
  `;
  const claimed: TalkJob[] = [];
  for (const row of dueRows) {
    const job = toTalkJob(row);
    const nextDueAt = computeNextTalkJobDueAt({
      schedule: job.schedule,
      timezone: job.timezone,
      from: currentNow,
    });
    await db`
      update public.talk_jobs
      set next_due_at = ${nextDueAt}::timestamptz,
          updated_at = ${currentNow}::timestamptz
      where id = ${job.id}::uuid
    `;
    claimed.push({ ...job, nextDueAt });
  }
  return claimed;
}

export async function markTalkJobRunQueued(
  jobId: string,
  now?: string,
): Promise<void> {
  const currentNow = now ?? new Date().toISOString();
  const db = getDbPg();
  await db`
    update public.talk_jobs
    set last_run_status = 'queued', updated_at = ${currentNow}::timestamptz
    where id = ${jobId}::uuid
  `;
}

export async function markTalkJobRunFinished(input: {
  jobId: string;
  status: string;
  finishedAt?: string;
}): Promise<void> {
  const finishedAt = input.finishedAt ?? new Date().toISOString();
  const db = getDbPg();
  await db`
    update public.talk_jobs
    set last_run_at = ${finishedAt}::timestamptz,
        last_run_status = ${input.status},
        run_count = run_count + 1,
        updated_at = ${finishedAt}::timestamptz
    where id = ${input.jobId}::uuid
  `;
}

// ---------------------------------------------------------------------------
// createJobTriggerRun — enqueue a single run from the scheduler or a
// manual trigger. Returns a discriminated union so callers can branch on
// status without reading the run record.
// ---------------------------------------------------------------------------

export type CreateJobTriggerRunResult =
  | {
      status: 'enqueued';
      talkId: string;
      threadId: string;
      messageId: string;
      runId: string;
      job: TalkJob;
    }
  | { status: 'not_found' }
  | { status: 'blocked'; job: TalkJob; issue: TalkJobDependencyIssue }
  | { status: 'job_busy'; job: TalkJob }
  | { status: 'paused'; job: TalkJob };

export async function createJobTriggerRun(input: {
  ownerId: string;
  jobId: string;
  triggerSource: 'scheduler' | 'manual';
  allowPaused?: boolean;
  now?: string;
}): Promise<CreateJobTriggerRunResult> {
  const currentNow = input.now ?? new Date().toISOString();
  const job = await getTalkJobById(input.jobId);
  if (!job) return { status: 'not_found' };
  if (job.status === 'paused' && !input.allowPaused) {
    return { status: 'paused', job };
  }
  if (job.status === 'blocked') {
    return {
      status: 'blocked',
      job,
      issue: {
        code: 'thread_missing',
        message: 'The job is blocked and must be fixed before it can run.',
      },
    };
  }

  const issue = await getTalkJobDependencyIssue(job);
  if (issue) {
    const db = getDbPg();
    await db`
      update public.talk_jobs
      set status = 'blocked',
          next_due_at = null,
          last_run_status = 'blocked',
          updated_at = ${currentNow}::timestamptz
      where id = ${job.id}::uuid
    `;
    const blockedJob = (await getTalkJobById(job.id))!;
    return { status: 'blocked', job: blockedJob, issue };
  }

  const db = getDbPg();
  const active = await db<{ count: number }[]>`
    select count(*)::int as count
    from public.talk_runs
    where job_id = ${job.id}::uuid
      and status in ('queued', 'running', 'awaiting_confirmation')
  `;
  if ((active[0]?.count ?? 0) > 0) {
    return { status: 'job_busy', job };
  }

  const metadata = {
    kind: 'job_trigger' as const,
    jobId: job.id,
    triggerSource: input.triggerSource,
    deliverableKind: job.deliverableKind,
    scheduled: input.triggerSource === 'scheduler',
  };

  const message = await createTalkMessage({
    ownerId: input.ownerId,
    talkId: job.talkId,
    threadId: job.threadId,
    role: 'user',
    content: job.prompt,
    createdBy: null,
    metadata,
    createdAt: currentNow,
  });

  const run = await createTalkRun({
    ownerId: input.ownerId,
    talkId: job.talkId,
    threadId: job.threadId,
    requestedBy: job.createdBy,
    status: 'queued',
    triggerMessageId: message.id,
    jobId: job.id,
    targetAgentId: job.targetAgentId,
  });

  await touchTalkUpdatedAtForJob(job.talkId, currentNow);
  await appendOutboxEvent({
    topic: `talk:${job.talkId}`,
    eventType: 'message_appended',
    payload: {
      talkId: job.talkId,
      threadId: job.threadId,
      messageId: message.id,
      runId: null,
      role: 'user',
      createdBy: null,
      content: job.prompt,
      createdAt: currentNow,
      metadata,
    },
  });
  await markTalkJobRunQueued(job.id, currentNow);

  return {
    status: 'enqueued',
    talkId: job.talkId,
    threadId: job.threadId,
    messageId: message.id,
    runId: run.id,
    job,
  };
}
