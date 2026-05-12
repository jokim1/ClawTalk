import { randomUUID } from 'crypto';

import { getDb } from '../../db.js';
import {
  appendOutboxEvent,
  createTalkMessage,
  createTalkRun,
  createTalkThread,
  type TalkRunRecord,
} from './accessors.js';

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
  | {
      kind: 'hourly_interval';
      everyHours: number;
    }
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
  title: string;
  prompt: string;
  target_agent_id: string | null;
  target_agent_nickname: string | null;
  status: TalkJobStatus;
  schedule_json: string;
  timezone: string;
  deliverable_kind: TalkJobDeliverableKind;
  report_output_id: string | null;
  report_output_title: string | null;
  source_scope_json: string;
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
  code:
    | 'target_agent_missing'
    | 'report_output_missing'
    | 'connector_scope_invalid'
    | 'channel_scope_invalid'
    | 'thread_missing';
  message: string;
}

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

function serializeSchedule(schedule: TalkJobSchedule): string {
  return JSON.stringify(schedule);
}

function serializeScope(scope: TalkJobScope): string {
  return JSON.stringify(scope);
}

function parseSchedule(value: string): TalkJobSchedule {
  return normalizeTalkJobSchedule(JSON.parse(value));
}

function parseScope(value: string | null): TalkJobScope {
  return normalizeTalkJobScope(value ? JSON.parse(value) : null);
}

function getLocalDateParts(
  date: Date,
  timezone: string,
): {
  weekday: TalkJobWeekday;
  hour: number;
  minute: number;
} {
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

function toTalkJob(row: TalkJobRow): TalkJob {
  return {
    id: row.id,
    talkId: row.talk_id,
    title: row.title,
    prompt: row.prompt,
    targetAgentId: row.target_agent_id,
    targetAgentNickname: row.target_agent_nickname,
    status: row.status,
    schedule: parseSchedule(row.schedule_json),
    timezone: row.timezone,
    deliverableKind: row.deliverable_kind,
    reportOutputId: row.report_output_id,
    reportOutputTitle: row.report_output_title,
    sourceScope: parseScope(row.source_scope_json),
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

function loadTalkJobRows(whereSql: string, ...params: unknown[]): TalkJobRow[] {
  return getDb()
    .prepare(
      `
      SELECT
        j.id,
        j.talk_id,
        j.title,
        j.prompt,
        j.target_agent_id,
        ra.name AS target_agent_nickname,
        j.status,
        j.schedule_json,
        j.timezone,
        j.deliverable_kind,
        j.report_output_id,
        o.title AS report_output_title,
        j.source_scope_json,
        j.thread_id,
        j.last_run_at,
        j.last_run_status,
        j.next_due_at,
        j.run_count,
        j.created_at,
        j.updated_at,
        j.created_by
      FROM talk_jobs j
      LEFT JOIN registered_agents ra ON ra.id = j.target_agent_id
      LEFT JOIN talk_outputs o ON o.id = j.report_output_id AND o.talk_id = j.talk_id
      ${whereSql}
    `,
    )
    .all(...params) as TalkJobRow[];
}

export function listTalkJobs(talkId: string): TalkJob[] {
  return loadTalkJobRows(
    `
      WHERE j.talk_id = ?
      ORDER BY
        CASE j.status
          WHEN 'active' THEN 0
          WHEN 'paused' THEN 1
          ELSE 2
        END ASC,
        COALESCE(j.next_due_at, j.updated_at) ASC,
        j.created_at ASC
    `,
    talkId,
  ).map(toTalkJob);
}

export function getTalkJob(talkId: string, jobId: string): TalkJob | undefined {
  const row = loadTalkJobRows(
    'WHERE j.talk_id = ? AND j.id = ? LIMIT 1',
    talkId,
    jobId,
  )[0];
  return row ? toTalkJob(row) : undefined;
}

export function getTalkJobById(jobId: string): TalkJob | undefined {
  const row = loadTalkJobRows('WHERE j.id = ? LIMIT 1', jobId)[0];
  return row ? toTalkJob(row) : undefined;
}

function validateTargetAgentMembership(
  talkId: string,
  targetAgentId: string,
): boolean {
  const row = getDb()
    .prepare(
      `
      SELECT 1
      FROM talk_agents ta
      JOIN registered_agents ra ON ra.id = ta.registered_agent_id
      WHERE ta.talk_id = ? AND ra.id = ?
      LIMIT 1
    `,
    )
    .get(talkId, targetAgentId) as { 1: number } | undefined;
  return Boolean(row);
}

function validateScopedConnectorIds(
  talkId: string,
  connectorIds: string[],
): void {
  if (connectorIds.length === 0) return;
  const placeholders = connectorIds.map(() => '?').join(', ');
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM talk_data_connectors
      WHERE talk_id = ?
        AND connector_id IN (${placeholders})
    `,
    )
    .get(talkId, ...connectorIds) as { count: number } | undefined;
  if ((row?.count || 0) !== connectorIds.length) {
    throw new Error(
      'One or more scoped data connectors are not attached to this talk.',
    );
  }
}

function validateScopedChannelBindingIds(
  talkId: string,
  channelBindingIds: string[],
): void {
  if (channelBindingIds.length === 0) return;
  const placeholders = channelBindingIds.map(() => '?').join(', ');
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM talk_channel_bindings
      WHERE talk_id = ?
        AND id IN (${placeholders})
    `,
    )
    .get(talkId, ...channelBindingIds) as { count: number } | undefined;
  if ((row?.count || 0) !== channelBindingIds.length) {
    throw new Error(
      'One or more scoped channel bindings are not attached to this talk.',
    );
  }
}

function validateReportOutput(
  talkId: string,
  deliverableKind: TalkJobDeliverableKind,
  reportOutputId: string | null | undefined,
): void {
  if (deliverableKind !== 'report') return;
  if (!reportOutputId?.trim()) {
    throw new Error('Report jobs require a configured report output.');
  }
  const row = getDb()
    .prepare(
      `
      SELECT id
      FROM talk_outputs
      WHERE talk_id = ? AND id = ?
      LIMIT 1
    `,
    )
    .get(talkId, reportOutputId) as { id: string } | undefined;
  if (!row) {
    throw new Error('The selected report output was not found on this talk.');
  }
}

function validateTalkJobConfiguration(input: {
  talkId: string;
  targetAgentId: string;
  deliverableKind: TalkJobDeliverableKind;
  reportOutputId?: string | null;
  sourceScope: TalkJobScope;
}): void {
  if (!validateTargetAgentMembership(input.talkId, input.targetAgentId)) {
    throw new Error(
      'The selected Talk agent is not currently configured on this talk.',
    );
  }
  validateReportOutput(
    input.talkId,
    input.deliverableKind,
    input.reportOutputId,
  );
  validateScopedConnectorIds(input.talkId, input.sourceScope.connectorIds);
  validateScopedChannelBindingIds(
    input.talkId,
    input.sourceScope.channelBindingIds,
  );
}

export function getTalkJobDependencyIssue(
  job: TalkJob,
): TalkJobDependencyIssue | null {
  const threadRow = getDb()
    .prepare(`SELECT id FROM talk_threads WHERE id = ? AND talk_id = ? LIMIT 1`)
    .get(job.threadId, job.talkId) as { id: string } | undefined;
  if (!threadRow) {
    return {
      code: 'thread_missing',
      message: 'The job thread no longer exists.',
    };
  }

  if (
    !job.targetAgentId ||
    !validateTargetAgentMembership(job.talkId, job.targetAgentId)
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
    const reportRow = getDb()
      .prepare(
        `SELECT id FROM talk_outputs WHERE talk_id = ? AND id = ? LIMIT 1`,
      )
      .get(job.talkId, job.reportOutputId) as { id: string } | undefined;
    if (!reportRow) {
      return {
        code: 'report_output_missing',
        message: 'The configured report output no longer exists.',
      };
    }
  }

  if (job.sourceScope.connectorIds.length > 0) {
    const placeholders = job.sourceScope.connectorIds.map(() => '?').join(', ');
    const row = getDb()
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM talk_data_connectors
        WHERE talk_id = ?
          AND connector_id IN (${placeholders})
      `,
      )
      .get(job.talkId, ...job.sourceScope.connectorIds) as { count: number };
    if ((row?.count || 0) !== job.sourceScope.connectorIds.length) {
      return {
        code: 'connector_scope_invalid',
        message:
          'One or more scoped data connectors are no longer attached to this talk.',
      };
    }
  }

  if (job.sourceScope.channelBindingIds.length > 0) {
    const placeholders = job.sourceScope.channelBindingIds
      .map(() => '?')
      .join(', ');
    const row = getDb()
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM talk_channel_bindings
        WHERE talk_id = ?
          AND id IN (${placeholders})
      `,
      )
      .get(job.talkId, ...job.sourceScope.channelBindingIds) as {
      count: number;
    };
    if ((row?.count || 0) !== job.sourceScope.channelBindingIds.length) {
      return {
        code: 'channel_scope_invalid',
        message:
          'One or more scoped channel bindings are no longer attached to this talk.',
      };
    }
  }

  return null;
}

function updateTalkUpdatedAt(talkId: string, now: string): void {
  getDb()
    .prepare(
      `
      UPDATE talks
      SET updated_at = ?
      WHERE id = ?
    `,
    )
    .run(now, talkId);
}

export function createTalkJob(input: {
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
}): TalkJob {
  const title = normalizeTitle(input.title);
  const prompt = normalizePrompt(input.prompt);
  const schedule = normalizeTalkJobSchedule(input.schedule);
  const timezone = validateTimezone(input.timezone);
  const sourceScope = normalizeTalkJobScope(input.sourceScope);
  validateTalkJobConfiguration({
    talkId: input.talkId,
    targetAgentId: input.targetAgentId,
    deliverableKind: input.deliverableKind,
    reportOutputId: input.reportOutputId,
    sourceScope,
  });
  const now = new Date().toISOString();
  const nextDueAt = computeNextTalkJobDueAt({
    schedule,
    timezone,
    from: now,
  });
  const thread = createTalkThread({
    talkId: input.talkId,
    title,
    isInternal: input.deliverableKind === 'report',
  });
  const id = `job_${randomUUID()}`;

  getDb()
    .prepare(
      `
      INSERT INTO talk_jobs (
        id,
        talk_id,
        title,
        prompt,
        target_agent_id,
        status,
        schedule_json,
        timezone,
        deliverable_kind,
        report_output_id,
        source_scope_json,
        thread_id,
        last_run_at,
        last_run_status,
        next_due_at,
        run_count,
        created_at,
        updated_at,
        created_by
      )
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0, ?, ?, ?)
    `,
    )
    .run(
      id,
      input.talkId,
      title,
      prompt,
      input.targetAgentId,
      serializeSchedule(schedule),
      timezone,
      input.deliverableKind,
      input.reportOutputId ?? null,
      serializeScope(sourceScope),
      thread.id,
      nextDueAt,
      now,
      now,
      input.createdBy,
    );

  updateTalkUpdatedAt(input.talkId, now);
  return getTalkJob(input.talkId, id)!;
}

export function patchTalkJob(input: {
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
}): TalkJob | undefined {
  const current = getTalkJob(input.talkId, input.jobId);
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
  validateTalkJobConfiguration({
    talkId: input.talkId,
    targetAgentId,
    deliverableKind,
    reportOutputId,
    sourceScope,
  });

  const now = new Date().toISOString();
  const threadId = current.threadId;

  getDb()
    .prepare(
      `
      UPDATE talk_threads
      SET title = ?, is_internal = ?, updated_at = ?
      WHERE id = ? AND talk_id = ?
    `,
    )
    .run(
      title,
      deliverableKind === 'report' ? 1 : 0,
      now,
      current.threadId,
      input.talkId,
    );

  const nextDueAt =
    current.status === 'paused' || current.status === 'blocked'
      ? null
      : computeNextTalkJobDueAt({
          schedule,
          timezone,
          from: now,
        });

  getDb()
    .prepare(
      `
      UPDATE talk_jobs
      SET title = ?,
          prompt = ?,
          target_agent_id = ?,
          schedule_json = ?,
          timezone = ?,
          deliverable_kind = ?,
          report_output_id = ?,
          source_scope_json = ?,
          thread_id = ?,
          next_due_at = ?,
          updated_at = ?
      WHERE talk_id = ? AND id = ?
    `,
    )
    .run(
      title,
      prompt,
      targetAgentId,
      serializeSchedule(schedule),
      timezone,
      deliverableKind,
      reportOutputId ?? null,
      serializeScope(sourceScope),
      threadId,
      nextDueAt,
      now,
      input.talkId,
      input.jobId,
    );

  updateTalkUpdatedAt(input.talkId, now);
  return getTalkJob(input.talkId, input.jobId);
}

export function deleteTalkJob(talkId: string, jobId: string): boolean {
  const current = getTalkJob(talkId, jobId);
  if (!current) return false;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE talk_threads
      SET is_internal = 1, updated_at = ?
      WHERE id = ? AND talk_id = ?
    `,
    )
    .run(now, current.threadId, talkId);

  const result = getDb()
    .prepare(`DELETE FROM talk_jobs WHERE talk_id = ? AND id = ?`)
    .run(talkId, jobId);
  if (result.changes === 1) {
    updateTalkUpdatedAt(talkId, now);
  }
  return result.changes === 1;
}

function updateTalkJobStatus(
  talkId: string,
  jobId: string,
  status: TalkJobStatus,
  nextDueAt: string | null,
): TalkJob | undefined {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `
      UPDATE talk_jobs
      SET status = ?, next_due_at = ?, updated_at = ?
      WHERE talk_id = ? AND id = ?
    `,
    )
    .run(status, nextDueAt, now, talkId, jobId);
  if (result.changes !== 1) return undefined;
  updateTalkUpdatedAt(talkId, now);
  return getTalkJob(talkId, jobId);
}

export function pauseTalkJob(
  talkId: string,
  jobId: string,
): TalkJob | undefined {
  return updateTalkJobStatus(talkId, jobId, 'paused', null);
}

export function resumeTalkJob(
  talkId: string,
  jobId: string,
): TalkJob | undefined {
  const current = getTalkJob(talkId, jobId);
  if (!current) return undefined;
  const nextDueAt = computeNextTalkJobDueAt({
    schedule: current.schedule,
    timezone: current.timezone,
  });
  return updateTalkJobStatus(talkId, jobId, 'active', nextDueAt);
}

export function blockTalkJob(
  talkId: string,
  jobId: string,
  lastRunStatus = 'blocked',
): TalkJob | undefined {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `
      UPDATE talk_jobs
      SET status = 'blocked',
          next_due_at = NULL,
          last_run_status = ?,
          updated_at = ?
      WHERE talk_id = ? AND id = ?
    `,
    )
    .run(lastRunStatus, now, talkId, jobId);
  if (result.changes !== 1) return undefined;
  updateTalkUpdatedAt(talkId, now);
  return getTalkJob(talkId, jobId);
}

function buildResponseExcerpt(content: string | null): string | null {
  if (!content) return null;
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 179).trimEnd()}…`;
}

function parseRunError(input: {
  status: TalkRunSummaryRow['status'];
  cancel_reason: string | null;
}): { errorCode: string | null; errorMessage: string | null } {
  const raw = input.cancel_reason?.trim() || null;
  if (!raw) {
    return { errorCode: null, errorMessage: null };
  }
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
  status:
    | 'queued'
    | 'running'
    | 'awaiting_confirmation'
    | 'cancelled'
    | 'completed'
    | 'failed';
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  trigger_message_id: string | null;
  cancel_reason: string | null;
  executor_alias: string | null;
  executor_model: string | null;
  response_content: string | null;
}

export function listTalkJobRunSummaries(
  talkId: string,
  jobId: string,
  limit = 20,
): TalkJobRunSummary[] {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const rows = getDb()
    .prepare(
      `
      SELECT
        r.id,
        r.thread_id,
        r.status,
        r.created_at,
        r.started_at,
        r.ended_at,
        r.trigger_message_id,
        r.cancel_reason,
        r.executor_alias,
        r.executor_model,
        (
          SELECT tm.content
          FROM talk_messages tm
          WHERE tm.run_id = r.id AND tm.role = 'assistant'
          ORDER BY tm.created_at DESC
          LIMIT 1
        ) AS response_content
      FROM talk_runs r
      WHERE r.talk_id = ? AND r.job_id = ?
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ?
    `,
    )
    .all(talkId, jobId, normalizedLimit) as TalkRunSummaryRow[];

  return rows.map((row) => {
    const parsedError = parseRunError(row);
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

export function claimDueTalkJobs(limit: number, now?: string): TalkJob[] {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const currentNow = now || new Date().toISOString();
  const tx = getDb().transaction(
    (txLimit: number, txNow: string): TalkJob[] => {
      const dueRows = loadTalkJobRows(
        `
        WHERE j.status = 'active'
          AND j.next_due_at IS NOT NULL
          AND j.next_due_at <= ?
        ORDER BY j.next_due_at ASC, j.created_at ASC
        LIMIT ?
      `,
        txNow,
        txLimit,
      );

      const updateStmt = getDb().prepare(
        `
      UPDATE talk_jobs
      SET next_due_at = ?,
          updated_at = ?
      WHERE id = ?
    `,
      );

      const claimed: TalkJob[] = [];
      for (const row of dueRows) {
        const job = toTalkJob(row);
        const nextDueAt = computeNextTalkJobDueAt({
          schedule: job.schedule,
          timezone: job.timezone,
          from: txNow,
        });
        updateStmt.run(nextDueAt, txNow, job.id);
        claimed.push({ ...job, nextDueAt });
      }

      return claimed;
    },
  );

  return tx(normalizedLimit, currentNow);
}

export function markTalkJobRunQueued(jobId: string, now?: string): void {
  const currentNow = now || new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE talk_jobs
      SET last_run_status = 'queued',
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(currentNow, jobId);
}

export function markTalkJobRunFinished(input: {
  jobId: string;
  status: string;
  finishedAt?: string;
}): void {
  const finishedAt = input.finishedAt || new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE talk_jobs
      SET last_run_at = ?,
          last_run_status = ?,
          run_count = run_count + 1,
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(finishedAt, input.status, finishedAt, input.jobId);
}

export function createJobTriggerRun(input: {
  jobId: string;
  triggerSource: 'scheduler' | 'manual';
  allowPaused?: boolean;
  now?: string;
}):
  | {
      status: 'enqueued';
      talkId: string;
      threadId: string;
      messageId: string;
      runId: string;
      job: TalkJob;
    }
  | {
      status: 'not_found';
    }
  | {
      status: 'blocked';
      job: TalkJob;
      issue: TalkJobDependencyIssue;
    }
  | {
      status: 'job_busy';
      job: TalkJob;
    }
  | {
      status: 'paused';
      job: TalkJob;
    } {
  const currentNow = input.now || new Date().toISOString();
  const tx = getDb().transaction(() => {
    const job = getTalkJobById(input.jobId);
    if (!job) return { status: 'not_found' as const };
    if (job.status === 'paused' && !input.allowPaused) {
      return { status: 'paused' as const, job };
    }
    if (job.status === 'blocked') {
      return {
        status: 'blocked' as const,
        job,
        issue: {
          code: 'thread_missing',
          message: 'The job is blocked and must be fixed before it can run.',
        } satisfies TalkJobDependencyIssue,
      };
    }

    const issue = getTalkJobDependencyIssue(job);
    if (issue) {
      getDb()
        .prepare(
          `
          UPDATE talk_jobs
          SET status = 'blocked',
              next_due_at = NULL,
              last_run_status = 'blocked',
              updated_at = ?
          WHERE id = ?
        `,
        )
        .run(currentNow, job.id);
      const blockedJob = getTalkJobById(job.id)!;
      return { status: 'blocked' as const, job: blockedJob, issue };
    }

    const active = getDb()
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM talk_runs
        WHERE job_id = ?
          AND status IN ('queued', 'running', 'awaiting_confirmation')
      `,
      )
      .get(job.id) as { count: number };
    if ((active?.count || 0) > 0) {
      return { status: 'job_busy' as const, job };
    }

    const messageId = `msg_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const metadataJson = JSON.stringify({
      kind: 'job_trigger',
      jobId: job.id,
      triggerSource: input.triggerSource,
      deliverableKind: job.deliverableKind,
      scheduled: input.triggerSource === 'scheduler',
    });

    createTalkMessage({
      id: messageId,
      talkId: job.talkId,
      threadId: job.threadId,
      role: 'user',
      content: job.prompt,
      createdBy: null,
      createdAt: currentNow,
      metadataJson,
    });
    createTalkRun({
      id: runId,
      talk_id: job.talkId,
      thread_id: job.threadId,
      requested_by: job.createdBy,
      status: 'queued',
      trigger_message_id: messageId,
      job_id: job.id,
      target_agent_id: job.targetAgentId,
      idempotency_key: null,
      response_group_id: null,
      sequence_index: null,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: currentNow,
      started_at: null,
      ended_at: null,
      cancel_reason: null,
      metadata_json: null,
    } satisfies TalkRunRecord);
    updateTalkUpdatedAt(job.talkId, currentNow);
    appendOutboxEvent({
      topic: `talk:${job.talkId}`,
      eventType: 'message_appended',
      payload: JSON.stringify({
        talkId: job.talkId,
        threadId: job.threadId,
        messageId,
        runId: null,
        role: 'user',
        createdBy: null,
        content: job.prompt,
        createdAt: currentNow,
        metadataJson,
      }),
    });
    markTalkJobRunQueued(job.id, currentNow);

    return {
      status: 'enqueued' as const,
      talkId: job.talkId,
      threadId: job.threadId,
      messageId,
      runId,
      job,
    };
  });

  return tx();
}
