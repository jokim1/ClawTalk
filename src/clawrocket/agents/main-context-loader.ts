import { getDb } from '../../db.js';
import type { LlmMessage } from './llm-client.js';

const OUTPUT_RESERVE = 4096;
const TOOL_SCHEMA_RESERVE = 2000;
const USER_MESSAGE_RESERVE = 1500;
const CHARS_TO_TOKENS = 0.25;
const MAX_RECENT_MESSAGES = 12;
const MAX_SUMMARY_CHARS = 3200;
const MIN_SUMMARY_LINE_CHARS = 90;
const MAX_SUMMARY_LINE_CHARS = 220;

interface MainThreadMessageRow {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at: string;
}

interface MainThreadSummaryRow {
  thread_id: string;
  summary_text: string;
  covers_through_message_id: string | null;
  updated_at: string;
}

interface MainSummaryTurn {
  userMessage: MainThreadMessageRow | null;
  assistantMessages: MainThreadMessageRow[];
}

interface MainSummaryCandidate {
  text: string | null;
  tokens: number;
  coverageId: string | null;
  source: MainRunContextSnapshot['summary']['source'];
}

export interface MainRunContextSnapshot {
  version: 1;
  threadId: string;
  summary: {
    included: boolean;
    source: 'persisted' | 'computed' | 'none';
    coversThroughMessageId: string | null;
    text: string | null;
  };
  history: {
    messageIds: string[];
    messageCount: number;
  };
  estimatedTokens: number;
  renderer?: 'direct_http' | 'container';
}

export interface MainContextPackage {
  summaryText: string | null;
  history: LlmMessage[];
  estimatedTokens: number;
  contextSnapshot: MainRunContextSnapshot;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length * CHARS_TO_TOKENS);
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function fetchMainThreadMessages(threadId: string): MainThreadMessageRow[] {
  return getDb()
    .prepare(
      `
      SELECT id, role, content, created_at
      FROM talk_messages
      WHERE talk_id IS NULL AND thread_id = ?
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all(threadId) as MainThreadMessageRow[];
}

function getPersistedSummary(
  threadId: string,
): MainThreadSummaryRow | undefined {
  return getDb()
    .prepare(
      `
      SELECT thread_id, summary_text, covers_through_message_id, updated_at
      FROM main_thread_summaries
      WHERE thread_id = ?
      LIMIT 1
    `,
    )
    .get(threadId) as MainThreadSummaryRow | undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildSummaryTurns(rows: MainThreadMessageRow[]): MainSummaryTurn[] {
  const turns: MainSummaryTurn[] = [];
  let currentTurn: MainSummaryTurn | null = null;

  for (const row of rows) {
    if (row.role === 'user') {
      if (currentTurn) {
        turns.push(currentTurn);
      }
      currentTurn = {
        userMessage: row,
        assistantMessages: [],
      };
      continue;
    }

    if (!currentTurn) {
      currentTurn = {
        userMessage: null,
        assistantMessages: [],
      };
    }
    currentTurn.assistantMessages.push(row);
  }

  if (currentTurn) {
    turns.push(currentTurn);
  }

  return turns;
}

function truncateText(text: string, budget: number): string {
  if (budget <= 0) return '';
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= budget) return normalized;
  if (budget <= 3) return '.'.repeat(budget);
  return `${normalized.slice(0, budget - 3).trimEnd()}...`;
}

function buildSummaryLine(turn: MainSummaryTurn, budget: number): string {
  const lineBudget = Math.max(40, budget);
  const userPrefix = 'User: ';
  const assistantPrefix = 'Assistant: ';

  const assistantText = turn.assistantMessages
    .map((message) => normalizeWhitespace(message.content))
    .filter(Boolean)
    .join(' / ');

  if (turn.userMessage && assistantText) {
    const contentBudget = Math.max(
      20,
      lineBudget - userPrefix.length - assistantPrefix.length - 3,
    );
    const userBudget = Math.max(20, Math.floor(contentBudget * 0.55));
    const assistantBudget = Math.max(20, contentBudget - userBudget);
    return `- ${userPrefix}${truncateText(turn.userMessage.content, userBudget)} | ${assistantPrefix}${truncateText(assistantText, assistantBudget)}`;
  }

  if (turn.userMessage) {
    return `- ${userPrefix}${truncateText(
      turn.userMessage.content,
      Math.max(20, lineBudget - userPrefix.length),
    )}`;
  }

  return `- ${assistantPrefix}${truncateText(
    assistantText,
    Math.max(20, lineBudget - assistantPrefix.length),
  )}`;
}

function buildSummaryText(rows: MainThreadMessageRow[]): string | null {
  if (rows.length === 0) return null;

  const turns = buildSummaryTurns(rows);
  const lines: string[] = [];
  let remainingChars = MAX_SUMMARY_CHARS;
  let truncated = false;

  for (let index = 0; index < turns.length; index += 1) {
    const remainingTurns = turns.length - index;
    const targetBudget = clamp(
      Math.floor(remainingChars / remainingTurns),
      MIN_SUMMARY_LINE_CHARS,
      MAX_SUMMARY_LINE_CHARS,
    );
    const line = buildSummaryLine(turns[index], targetBudget);
    const lineCost = line.length + (lines.length > 0 ? 1 : 0);
    if (lineCost > remainingChars) {
      truncated = true;
      break;
    }
    lines.push(line);
    remainingChars -= lineCost;
  }

  if (truncated && remainingChars > 32) {
    lines.push('- Additional older context omitted.');
  }

  return lines.join('\n');
}

function getOlderCoverageId(rows: MainThreadMessageRow[]): string | null {
  return rows.at(-1)?.id ?? null;
}

function getOlderCoverageKey(rows: MainThreadMessageRow[]): string {
  return `${rows.length}:${getOlderCoverageId(rows) ?? 'none'}`;
}

function getComputedSummaryCandidate(
  rows: MainThreadMessageRow[],
  cache: Map<string, MainSummaryCandidate>,
): MainSummaryCandidate {
  if (rows.length === 0) {
    return {
      text: null,
      tokens: 0,
      coverageId: null,
      source: 'none',
    };
  }

  const cacheKey = getOlderCoverageKey(rows);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const text = buildSummaryText(rows);
  const candidate: MainSummaryCandidate = {
    text,
    tokens: text ? estimateTokens(text) : 0,
    coverageId: getOlderCoverageId(rows),
    source: text ? 'computed' : 'none',
  };
  cache.set(cacheKey, candidate);
  return candidate;
}

function resolveSummaryCandidate(input: {
  olderRows: MainThreadMessageRow[];
  persistedSummary?: MainThreadSummaryRow;
  computedSummaryCache: Map<string, MainSummaryCandidate>;
}): MainSummaryCandidate {
  if (input.olderRows.length === 0) {
    return {
      text: null,
      tokens: 0,
      coverageId: null,
      source: 'none',
    };
  }

  const coverageId = getOlderCoverageId(input.olderRows);
  if (
    input.persistedSummary?.summary_text?.trim() &&
    input.persistedSummary.covers_through_message_id === coverageId
  ) {
    const text = input.persistedSummary.summary_text.trim();
    return {
      text,
      tokens: estimateTokens(text),
      coverageId,
      source: 'persisted',
    };
  }

  return getComputedSummaryCandidate(
    input.olderRows,
    input.computedSummaryCache,
  );
}

function selectRecentRowsWithinBudget(
  rows: MainThreadMessageRow[],
  budgetTokens: number,
): MainThreadMessageRow[] {
  if (budgetTokens <= 0) return [];

  const selected: MainThreadMessageRow[] = [];
  let usedTokens = 0;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (selected.length >= MAX_RECENT_MESSAGES) break;
    const row = rows[index];
    const rowTokens = estimateTokens(
      `${row.role.toUpperCase()}: ${normalizeWhitespace(row.content)}`,
    );
    if (usedTokens + rowTokens > budgetTokens) break;
    usedTokens += rowTokens;
    selected.push(row);
  }

  selected.reverse();
  return selected;
}

function toHistoryMessages(rows: MainThreadMessageRow[]): LlmMessage[] {
  return rows.map((row) => ({
    role: row.role,
    content: row.content,
  }));
}

function formatHistoryForPrompt(history: LlmMessage[]): string {
  if (history.length === 0) {
    return 'No prior conversation before this message.';
  }

  return history
    .map((message) => {
      const role =
        message.role === 'user'
          ? 'User'
          : message.role === 'assistant'
            ? 'Assistant'
            : message.role === 'system'
              ? 'System'
              : 'Tool';
      const content =
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content, null, 2);
      return `${role}: ${content}`;
    })
    .join('\n\n');
}

export function buildMainSystemPrompt(summaryText: string | null): string {
  if (!summaryText) return '';
  return [
    '# Main Thread Context',
    '',
    '## Earlier Thread Summary',
    '',
    summaryText,
  ].join('\n');
}

export function renderMainPromptPayload(
  contextPackage: MainContextPackage,
  currentUserMessage: string,
): string {
  const sections = ['## Current User Message', '', currentUserMessage];

  sections.unshift(
    contextPackage.history.length > 0
      ? [
          '## Recent Conversation',
          '',
          formatHistoryForPrompt(contextPackage.history),
        ].join('\n')
      : '## Recent Conversation\n\nNo prior conversation before this message.',
  );

  if (contextPackage.summaryText) {
    sections.unshift(
      ['## Thread Context', '', contextPackage.summaryText].join('\n'),
    );
  }

  return sections.join('\n\n');
}

export function loadMainContext(
  threadId: string,
  modelContextWindow: number,
  historyThroughMessageId?: string | null,
): MainContextPackage {
  const allRows = fetchMainThreadMessages(threadId);
  const cutoffIndex =
    historyThroughMessageId == null
      ? allRows.length
      : allRows.findIndex((row) => row.id === historyThroughMessageId);
  const priorRows =
    cutoffIndex === -1 ? allRows : allRows.slice(0, Math.max(0, cutoffIndex));
  const persistedSummary = getPersistedSummary(threadId);
  const computedSummaryCache = new Map<string, MainSummaryCandidate>();

  const baseHistoryBudget = Math.max(
    0,
    modelContextWindow -
      OUTPUT_RESERVE -
      TOOL_SCHEMA_RESERVE -
      USER_MESSAGE_RESERVE,
  );
  let recentRows = selectRecentRowsWithinBudget(priorRows, baseHistoryBudget);
  let olderRows =
    recentRows.length > 0
      ? priorRows.slice(0, priorRows.length - recentRows.length)
      : priorRows;
  let summaryCandidate = resolveSummaryCandidate({
    olderRows,
    persistedSummary,
    computedSummaryCache,
  });
  const finalHistoryBudget = Math.max(
    0,
    modelContextWindow -
      OUTPUT_RESERVE -
      TOOL_SCHEMA_RESERVE -
      USER_MESSAGE_RESERVE -
      summaryCandidate.tokens,
  );
  recentRows = selectRecentRowsWithinBudget(priorRows, finalHistoryBudget);
  olderRows =
    recentRows.length > 0
      ? priorRows.slice(0, priorRows.length - recentRows.length)
      : priorRows;
  summaryCandidate = resolveSummaryCandidate({
    olderRows,
    persistedSummary,
    computedSummaryCache,
  });

  const history = toHistoryMessages(recentRows);
  const estimatedTokens =
    summaryCandidate.tokens +
    recentRows.reduce(
      (total, row) =>
        total + estimateTokens(`${row.role.toUpperCase()}: ${row.content}`),
      0,
    );

  return {
    summaryText: summaryCandidate.text,
    history,
    estimatedTokens,
    contextSnapshot: {
      version: 1,
      threadId,
      summary: {
        included: Boolean(summaryCandidate.text),
        source: summaryCandidate.source,
        coversThroughMessageId: summaryCandidate.coverageId,
        text: summaryCandidate.text,
      },
      history: {
        messageIds: recentRows.map((row) => row.id),
        messageCount: recentRows.length,
      },
      estimatedTokens,
    },
  };
}

export function refreshMainThreadSummary(threadId: string): void {
  const db = getDb();
  const rows = fetchMainThreadMessages(threadId);
  const olderRows =
    rows.length > MAX_RECENT_MESSAGES
      ? rows.slice(0, rows.length - MAX_RECENT_MESSAGES)
      : [];

  if (olderRows.length === 0) {
    db.prepare(`DELETE FROM main_thread_summaries WHERE thread_id = ?`).run(
      threadId,
    );
    return;
  }

  const summaryText = buildSummaryText(olderRows);
  if (!summaryText) {
    db.prepare(`DELETE FROM main_thread_summaries WHERE thread_id = ?`).run(
      threadId,
    );
    return;
  }

  const threadExists = db
    .prepare(`SELECT 1 AS ok FROM main_threads WHERE thread_id = ?`)
    .get(threadId) as { ok: number } | undefined;
  if (!threadExists) {
    return;
  }

  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO main_thread_summaries (
      thread_id, summary_text, covers_through_message_id, updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      summary_text = excluded.summary_text,
      covers_through_message_id = excluded.covers_through_message_id,
      updated_at = excluded.updated_at
  `,
  ).run(threadId, summaryText, olderRows.at(-1)?.id ?? null, now);
}
