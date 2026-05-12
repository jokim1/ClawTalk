import { randomUUID } from 'crypto';

import { getDb } from '../../db.js';

export interface TalkOutputRecord {
  id: string;
  talk_id: string;
  title: string;
  content_markdown: string;
  version: number;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  updated_by_run_id: string | null;
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
  | {
      kind: 'ok';
      output: TalkOutput;
    }
  | {
      kind: 'conflict';
      current: TalkOutput;
    }
  | {
      kind: 'not_found';
    };

const TALK_OUTPUT_RECORD_COLUMNS = `
  id,
  talk_id,
  title,
  content_markdown,
  version,
  created_at,
  updated_at,
  created_by_user_id,
  updated_by_user_id,
  updated_by_run_id
`;

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized) {
    throw new Error('Output title is required');
  }
  return normalized;
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

export function listTalkOutputs(
  talkId: string,
  options?: { limit?: number },
): TalkOutputSummary[] {
  const limit =
    typeof options?.limit === 'number' && options.limit > 0
      ? Math.floor(options.limit)
      : null;
  const rows = limit
    ? (getDb()
        .prepare(
          `
          SELECT
            id,
            title,
            version,
            length(content_markdown) AS content_length,
            created_at,
            updated_at,
            created_by_user_id,
            updated_by_user_id,
            updated_by_run_id
          FROM talk_outputs
          WHERE talk_id = ?
          ORDER BY updated_at DESC, created_at DESC, id ASC
          LIMIT ?
        `,
        )
        .all(talkId, limit) as TalkOutputSummaryRow[])
    : (getDb()
        .prepare(
          `
          SELECT
            id,
            title,
            version,
            length(content_markdown) AS content_length,
            created_at,
            updated_at,
            created_by_user_id,
            updated_by_user_id,
            updated_by_run_id
          FROM talk_outputs
          WHERE talk_id = ?
          ORDER BY updated_at DESC, created_at DESC, id ASC
        `,
        )
        .all(talkId) as TalkOutputSummaryRow[]);

  return rows.map(toTalkOutputSummary);
}

export function getTalkOutput(
  talkId: string,
  outputId: string,
): TalkOutput | undefined {
  const row = getDb()
    .prepare(
      `
      SELECT
        ${TALK_OUTPUT_RECORD_COLUMNS}
      FROM talk_outputs
      WHERE talk_id = ? AND id = ?
      LIMIT 1
    `,
    )
    .get(talkId, outputId) as TalkOutputRecord | undefined;
  return row ? toTalkOutput(row) : undefined;
}

export function createTalkOutput(input: {
  talkId: string;
  title: string;
  contentMarkdown: string;
  createdByUserId?: string | null;
  updatedByRunId?: string | null;
}): TalkOutput {
  const id = randomUUID();
  const now = new Date().toISOString();
  const title = normalizeTitle(input.title);
  const contentMarkdown = input.contentMarkdown ?? '';

  getDb()
    .prepare(
      `
      INSERT INTO talk_outputs (
        id,
        talk_id,
        title,
        content_markdown,
        version,
        created_at,
        updated_at,
        created_by_user_id,
        updated_by_user_id,
        updated_by_run_id
      )
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      id,
      input.talkId,
      title,
      contentMarkdown,
      now,
      now,
      input.createdByUserId ?? null,
      input.createdByUserId ?? null,
      input.updatedByRunId ?? null,
    );

  return getTalkOutput(input.talkId, id)!;
}

export function patchTalkOutput(input: {
  talkId: string;
  outputId: string;
  expectedVersion: number;
  title?: string;
  contentMarkdown?: string;
  updatedByUserId?: string | null;
  updatedByRunId?: string | null;
}): TalkOutputUpdateResult {
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

  const db = getDb();
  return db.transaction((): TalkOutputUpdateResult => {
    const existing = db
      .prepare(
        `
        SELECT
          ${TALK_OUTPUT_RECORD_COLUMNS}
        FROM talk_outputs
        WHERE talk_id = ? AND id = ?
        LIMIT 1
      `,
      )
      .get(input.talkId, input.outputId) as TalkOutputRecord | undefined;
    if (!existing) {
      return { kind: 'not_found' };
    }
    if (existing.version !== input.expectedVersion) {
      return { kind: 'conflict', current: toTalkOutput(existing) };
    }

    const now = new Date().toISOString();
    const nextTitle =
      input.title !== undefined ? normalizeTitle(input.title) : existing.title;
    const nextContent =
      input.contentMarkdown !== undefined
        ? input.contentMarkdown
        : existing.content_markdown;

    const result = db
      .prepare(
        `
        UPDATE talk_outputs
        SET title = ?,
            content_markdown = ?,
            version = version + 1,
            updated_at = ?,
            updated_by_user_id = ?,
            updated_by_run_id = ?
        WHERE id = ? AND talk_id = ? AND version = ?
      `,
      )
      .run(
        nextTitle,
        nextContent,
        now,
        input.updatedByUserId ?? null,
        input.updatedByRunId ?? null,
        input.outputId,
        input.talkId,
        input.expectedVersion,
      );

    const current = db
      .prepare(
        `
        SELECT
          ${TALK_OUTPUT_RECORD_COLUMNS}
        FROM talk_outputs
        WHERE talk_id = ? AND id = ?
        LIMIT 1
      `,
      )
      .get(input.talkId, input.outputId) as TalkOutputRecord | undefined;

    if (!current) {
      return { kind: 'not_found' };
    }
    if (result.changes !== 1) {
      return { kind: 'conflict', current: toTalkOutput(current) };
    }

    return {
      kind: 'ok',
      output: toTalkOutput(current),
    };
  })();
}

export function deleteTalkOutput(talkId: string, outputId: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM talk_outputs WHERE talk_id = ? AND id = ?`)
    .run(talkId, outputId);
  return result.changes > 0;
}

export function replaceJobReportOutput(input: {
  talkId: string;
  outputId: string;
  title?: string;
  contentMarkdown: string;
  updatedByRunId: string;
}): TalkOutput | null {
  const db = getDb();
  return db.transaction((): TalkOutput | null => {
    const existing = db
      .prepare(
        `
        SELECT
          ${TALK_OUTPUT_RECORD_COLUMNS}
        FROM talk_outputs
        WHERE talk_id = ? AND id = ?
        LIMIT 1
      `,
      )
      .get(input.talkId, input.outputId) as TalkOutputRecord | undefined;

    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();
    const nextTitle =
      input.title !== undefined ? normalizeTitle(input.title) : existing.title;

    db.prepare(
      `
      UPDATE talk_outputs
      SET title = ?,
          content_markdown = ?,
          version = version + 1,
          updated_at = ?,
          updated_by_user_id = NULL,
          updated_by_run_id = ?
      WHERE talk_id = ? AND id = ?
    `,
    ).run(
      nextTitle,
      input.contentMarkdown,
      now,
      input.updatedByRunId,
      input.talkId,
      input.outputId,
    );

    const updated = db
      .prepare(
        `
        SELECT
          ${TALK_OUTPUT_RECORD_COLUMNS}
        FROM talk_outputs
        WHERE talk_id = ? AND id = ?
        LIMIT 1
      `,
      )
      .get(input.talkId, input.outputId) as TalkOutputRecord | undefined;

    return updated ? toTalkOutput(updated) : null;
  })();
}
