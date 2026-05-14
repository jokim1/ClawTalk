// clawtalk Phase 5 (PR 2) — postgres port of output-accessors.
//
// Single-table accessor for talk_outputs. RLS on owner_id; callers MUST
// wrap in withUserContext. Write paths take ownerId for the INSERT
// VALUES (WITH CHECK); reads/updates filtered by RLS USING.
//
// The CAS pattern (patchTalkOutput) does a SELECT-then-UPDATE inside the
// caller's withUserContext transaction. Postgres can do this as a single
// statement with `where version = ${expectedVersion} returning *`, but
// the existing sqlite shape returned three discrete kinds — ok /
// conflict / not_found — and callers branch on them. Preserving that
// split: do the SELECT to distinguish not_found from conflict, then a
// versioned UPDATE.

import { getDbPg } from '../../db.js';

export interface TalkOutputRecord {
  id: string;
  talk_id: string;
  owner_id: string;
  title: string;
  content_markdown: string;
  version: number;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  updated_by_run_id: string | null;
}

export interface TalkOutputSummary {
  id: string;
  title: string;
  version: number;
  contentLength: number;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  updatedByRunId: string | null;
}

export interface TalkOutput extends TalkOutputSummary {
  contentMarkdown: string;
}

export type TalkOutputUpdateResult =
  | { kind: 'ok'; output: TalkOutput }
  | { kind: 'conflict'; current: TalkOutput }
  | { kind: 'not_found' };

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized) {
    throw new Error('Output title is required');
  }
  return normalized;
}

function toTalkOutput(row: TalkOutputRecord): TalkOutput {
  return {
    id: row.id,
    title: row.title,
    version: row.version,
    contentLength: row.content_markdown.length,
    contentMarkdown: row.content_markdown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    updatedByRunId: row.updated_by_run_id,
  };
}

interface TalkOutputSummaryRow {
  id: string;
  title: string;
  version: number;
  content_length: number;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  updated_by_run_id: string | null;
}

function toTalkOutputSummary(row: TalkOutputSummaryRow): TalkOutputSummary {
  return {
    id: row.id,
    title: row.title,
    version: row.version,
    contentLength: row.content_length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    updatedByRunId: row.updated_by_run_id,
  };
}

export async function listTalkOutputs(
  talkId: string,
  options?: { limit?: number },
): Promise<TalkOutputSummary[]> {
  const limit =
    typeof options?.limit === 'number' && options.limit > 0
      ? Math.floor(options.limit)
      : null;
  const db = getDbPg();
  // postgres.js doesn't accept `NULL` as a LIMIT literal — the two query
  // shapes diverge cleanly enough that branching here is simpler than
  // a server-side `coalesce`.
  const rows = limit
    ? await db<TalkOutputSummaryRow[]>`
        select id, title, version,
               length(content_markdown) as content_length,
               created_at, updated_at,
               created_by_user_id, updated_by_user_id, updated_by_run_id
        from public.talk_outputs
        where talk_id = ${talkId}::uuid
        order by updated_at desc, created_at desc, id asc
        limit ${limit}
      `
    : await db<TalkOutputSummaryRow[]>`
        select id, title, version,
               length(content_markdown) as content_length,
               created_at, updated_at,
               created_by_user_id, updated_by_user_id, updated_by_run_id
        from public.talk_outputs
        where talk_id = ${talkId}::uuid
        order by updated_at desc, created_at desc, id asc
      `;
  return rows.map(toTalkOutputSummary);
}

export async function getTalkOutput(
  talkId: string,
  outputId: string,
): Promise<TalkOutput | undefined> {
  const db = getDbPg();
  const rows = await db<TalkOutputRecord[]>`
    select id, talk_id, owner_id, title, content_markdown, version,
           created_at, updated_at,
           created_by_user_id, updated_by_user_id, updated_by_run_id
    from public.talk_outputs
    where talk_id = ${talkId}::uuid and id = ${outputId}::uuid
    limit 1
  `;
  return rows[0] ? toTalkOutput(rows[0]) : undefined;
}

export async function createTalkOutput(input: {
  ownerId: string;
  talkId: string;
  title: string;
  contentMarkdown: string;
  createdByUserId?: string | null;
  updatedByRunId?: string | null;
}): Promise<TalkOutput> {
  const title = normalizeTitle(input.title);
  const contentMarkdown = input.contentMarkdown ?? '';

  const db = getDbPg();
  const rows = await db<TalkOutputRecord[]>`
    insert into public.talk_outputs
      (talk_id, owner_id, title, content_markdown, version,
       created_by_user_id, updated_by_user_id, updated_by_run_id)
    values
      (${input.talkId}::uuid, ${input.ownerId}::uuid, ${title},
       ${contentMarkdown}, 1,
       ${input.createdByUserId ?? null}::uuid,
       ${input.createdByUserId ?? null}::uuid,
       ${input.updatedByRunId ?? null}::uuid)
    returning id, talk_id, owner_id, title, content_markdown, version,
              created_at, updated_at,
              created_by_user_id, updated_by_user_id, updated_by_run_id
  `;
  return toTalkOutput(rows[0]);
}

export async function patchTalkOutput(input: {
  talkId: string;
  outputId: string;
  expectedVersion: number;
  title?: string;
  contentMarkdown?: string;
  updatedByUserId?: string | null;
  updatedByRunId?: string | null;
}): Promise<TalkOutputUpdateResult> {
  if (
    typeof input.expectedVersion !== 'number' ||
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    throw new Error('expectedVersion must be a positive integer');
  }
  if (input.title === undefined && input.contentMarkdown === undefined) {
    throw new Error(
      'At least one of title or contentMarkdown must be provided',
    );
  }

  const db = getDbPg();
  const existingRows = await db<TalkOutputRecord[]>`
    select id, talk_id, owner_id, title, content_markdown, version,
           created_at, updated_at,
           created_by_user_id, updated_by_user_id, updated_by_run_id
    from public.talk_outputs
    where talk_id = ${input.talkId}::uuid and id = ${input.outputId}::uuid
    limit 1
  `;
  const existing = existingRows[0];
  if (!existing) return { kind: 'not_found' };
  if (existing.version !== input.expectedVersion) {
    return { kind: 'conflict', current: toTalkOutput(existing) };
  }

  const nextTitle =
    input.title !== undefined ? normalizeTitle(input.title) : existing.title;
  const nextContent =
    input.contentMarkdown !== undefined
      ? input.contentMarkdown
      : existing.content_markdown;

  const updatedRows = await db<TalkOutputRecord[]>`
    update public.talk_outputs
    set title = ${nextTitle},
        content_markdown = ${nextContent},
        version = version + 1,
        updated_at = now(),
        updated_by_user_id = ${input.updatedByUserId ?? null}::uuid,
        updated_by_run_id = ${input.updatedByRunId ?? null}::uuid
    where id = ${input.outputId}::uuid
      and talk_id = ${input.talkId}::uuid
      and version = ${input.expectedVersion}
    returning id, talk_id, owner_id, title, content_markdown, version,
              created_at, updated_at,
              created_by_user_id, updated_by_user_id, updated_by_run_id
  `;
  const updated = updatedRows[0];
  if (!updated) {
    // Another writer raced us between the SELECT and UPDATE. Re-read to
    // give the caller the current row to retry with.
    const refetch = await db<TalkOutputRecord[]>`
      select id, talk_id, owner_id, title, content_markdown, version,
             created_at, updated_at,
             created_by_user_id, updated_by_user_id, updated_by_run_id
      from public.talk_outputs
      where talk_id = ${input.talkId}::uuid and id = ${input.outputId}::uuid
      limit 1
    `;
    if (!refetch[0]) return { kind: 'not_found' };
    return { kind: 'conflict', current: toTalkOutput(refetch[0]) };
  }
  return { kind: 'ok', output: toTalkOutput(updated) };
}

export async function deleteTalkOutput(
  talkId: string,
  outputId: string,
): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    delete from public.talk_outputs
    where talk_id = ${talkId}::uuid and id = ${outputId}::uuid
    returning id
  `;
  return rows.length > 0;
}

export async function replaceJobReportOutput(input: {
  talkId: string;
  outputId: string;
  title?: string;
  contentMarkdown: string;
  updatedByRunId: string;
}): Promise<TalkOutput | null> {
  const db = getDbPg();
  const existingRows = await db<TalkOutputRecord[]>`
    select id, talk_id, owner_id, title, content_markdown, version,
           created_at, updated_at,
           created_by_user_id, updated_by_user_id, updated_by_run_id
    from public.talk_outputs
    where talk_id = ${input.talkId}::uuid and id = ${input.outputId}::uuid
    limit 1
  `;
  const existing = existingRows[0];
  if (!existing) return null;

  const nextTitle =
    input.title !== undefined ? normalizeTitle(input.title) : existing.title;

  const rows = await db<TalkOutputRecord[]>`
    update public.talk_outputs
    set title = ${nextTitle},
        content_markdown = ${input.contentMarkdown},
        version = version + 1,
        updated_at = now(),
        updated_by_user_id = null,
        updated_by_run_id = ${input.updatedByRunId}::uuid
    where talk_id = ${input.talkId}::uuid and id = ${input.outputId}::uuid
    returning id, talk_id, owner_id, title, content_markdown, version,
              created_at, updated_at,
              created_by_user_id, updated_by_user_id, updated_by_run_id
  `;
  return rows[0] ? toTalkOutput(rows[0]) : null;
}
