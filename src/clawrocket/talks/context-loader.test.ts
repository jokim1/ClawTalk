import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _initTestDatabase,
  createTalkRun,
  createTalkOutput,
  createTalkResourceBinding,
  createMessage,
  initializeTalkToolGrants,
  listTalkToolGrants,
  replaceTalkToolGrants,
  upsertTalkStateEntry,
  upsertUserGoogleCredential,
  upsertTalk,
  upsertUser,
} from '../db/index.js';
import { loadTalkContext } from './context-loader.js';
import { buildToolExecutor } from './new-executor.js';
import { getDb } from '../../db.js';
import { encryptGoogleToolCredential } from '../identity/google-tools-credential-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TALK_ID = 'talk-ctx-loader';
const THREAD_ID = 'thread-ctx-loader';

function insertSource(opts: {
  id: string;
  sourceRef: string;
  sourceType: string;
  title: string;
  extractedText?: string | null;
  sourceUrl?: string | null;
  status?: string;
  sortOrder?: number;
}) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO talk_context_sources (
        id, talk_id, source_ref, source_type, title, source_url,
        extracted_text, status, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      opts.id,
      TALK_ID,
      opts.sourceRef,
      opts.sourceType,
      opts.title,
      opts.sourceUrl ?? null,
      opts.extractedText ?? null,
      opts.status ?? 'ready',
      opts.sortOrder ?? 0,
      now,
      now,
    );
}

function insertTalkMessage(opts: {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string;
  createdBy?: string | null;
}) {
  createMessage({
    id: opts.id,
    talkId: TALK_ID,
    threadId: THREAD_ID,
    role: opts.role,
    content: opts.content,
    createdBy: opts.createdBy ?? null,
    createdAt: opts.createdAt,
  });
}

function insertTalkSummary(summaryText: string) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO talk_context_summary (
        talk_id, summary_text, updated_at
      ) VALUES (?, ?, ?)
      ON CONFLICT(talk_id) DO UPDATE SET
        summary_text = excluded.summary_text,
        updated_at = excluded.updated_at
    `,
    )
    .run(TALK_ID, summaryText, now);
}

function insertStateEntry(input: {
  key: string;
  value: unknown;
  expectedVersion?: number;
  updatedByRunId?: string | null;
}) {
  return upsertTalkStateEntry({
    talkId: TALK_ID,
    key: input.key,
    value: input.value,
    expectedVersion: input.expectedVersion ?? 0,
    updatedByUserId: 'owner-1',
    updatedByRunId: input.updatedByRunId ?? null,
  });
}

function enableTalkTools(toolIds: string[]) {
  initializeTalkToolGrants(TALK_ID, 'owner-1');
  const enabled = new Set(toolIds);
  replaceTalkToolGrants({
    talkId: TALK_ID,
    grants: listTalkToolGrants(TALK_ID).map((grant) => ({
      toolId: grant.toolId,
      enabled: enabled.has(grant.toolId),
    })),
    updatedBy: 'owner-1',
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('context-loader', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertTalk({
      id: TALK_ID,
      ownerId: 'owner-1',
      topicTitle: 'Context Loader Test Talk',
    });
    getDb()
      .prepare(
        `
        INSERT INTO talk_threads (
          id, talk_id, title, is_default, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?)
      `,
      )
      .run(
        THREAD_ID,
        TALK_ID,
        'Default Thread',
        new Date().toISOString(),
        new Date().toISOString(),
      );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function insertRun(runId: string) {
    const now = new Date().toISOString();
    createTalkRun({
      id: runId,
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'completed',
      trigger_message_id: null,
      target_agent_id: null,
      idempotency_key: null,
      response_group_id: null,
      sequence_index: null,
      executor_alias: 'direct_http',
      executor_model: 'claude-sonnet-4-6',
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: now,
      started_at: now,
      ended_at: now,
      cancel_reason: null,
    });
  }

  // =========================================================================
  // Source manifest: stable refs from DB
  // =========================================================================

  describe('source manifest uses stable source_ref from DB', () => {
    it('uses S1, S2 refs in the system prompt, not src-1, src-2', async () => {
      insertSource({
        id: 'src-id-1',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'Meeting Notes',
        extractedText: 'Some notes content here.',
      });
      insertSource({
        id: 'src-id-2',
        sourceRef: 'S2',
        sourceType: 'url',
        title: 'Docs page',
        sourceUrl: 'https://example.com/docs',
        extractedText: 'Page content',
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);

      // System prompt should reference stable refs
      expect(ctx.systemPrompt).toContain('[S1]');
      expect(ctx.systemPrompt).toContain('[S2]');
      expect(ctx.systemPrompt).not.toContain('[src-1]');
      expect(ctx.systemPrompt).not.toContain('[src-2]');
    });

    it('preserves non-contiguous refs after deletion (e.g., S1, S4)', async () => {
      insertSource({
        id: 'src-id-1',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'First Source',
        extractedText: 'Content 1',
        sortOrder: 0,
      });
      insertSource({
        id: 'src-id-4',
        sourceRef: 'S4',
        sourceType: 'text',
        title: 'Fourth Source',
        extractedText: 'Content 4',
        sortOrder: 1,
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);

      expect(ctx.systemPrompt).toContain('[S1]');
      expect(ctx.systemPrompt).toContain('[S4]');
      expect(ctx.systemPrompt).not.toContain('[S2]');
      expect(ctx.systemPrompt).not.toContain('[S3]');
    });
  });

  // =========================================================================
  // Context tools: schema declares sourceRef
  // =========================================================================

  describe('context tools schema', () => {
    it('read_context_source tool requires sourceRef parameter', async () => {
      const ctx = await loadTalkContext(TALK_ID, 128000);

      const readSourceTool = ctx.contextTools.find(
        (t) => t.name === 'read_context_source',
      );
      expect(readSourceTool).toBeDefined();
      expect(readSourceTool!.inputSchema.required).toContain('sourceRef');
      expect(readSourceTool!.inputSchema.properties).toHaveProperty(
        'sourceRef',
      );
      // Should NOT have a 'ref' property — that was the old broken name
      expect(readSourceTool!.inputSchema.properties).not.toHaveProperty('ref');
    });

    it('tool description references stable S# format', async () => {
      const ctx = await loadTalkContext(TALK_ID, 128000);
      const readSourceTool = ctx.contextTools.find(
        (t) => t.name === 'read_context_source',
      );
      expect(readSourceTool!.description).toMatch(/S\d/);
      expect(readSourceTool!.description).not.toContain('src-1');
    });

    it('includes bound Google Drive resources and tools when the user has access', async () => {
      createTalkResourceBinding({
        talkId: TALK_ID,
        bindingKind: 'google_drive_file',
        externalId: 'drive-file-1',
        displayName: 'refactor-v1-foundation',
        metadata: {
          mimeType: 'text/plain',
          url: 'https://drive.google.com/file/d/drive-file-1/view',
        },
        createdBy: 'owner-1',
      });
      upsertUserGoogleCredential({
        userId: 'owner-1',
        googleSubject: 'google-subject-1',
        email: 'owner@example.com',
        scopes: ['drive.readonly'],
        ciphertext: encryptGoogleToolCredential({
          kind: 'google_tools',
          accessToken: 'google-access-token',
          refreshToken: 'google-refresh-token',
          expiryDate: new Date(Date.now() + 300_000).toISOString(),
          scopes: ['drive.readonly'],
          tokenType: 'Bearer',
        }),
      });

      const ctx = await loadTalkContext(
        TALK_ID,
        128000,
        undefined,
        undefined,
        'owner-1',
      );

      expect(ctx.systemPrompt).toContain('**Bound Google Drive Resources:**');
      expect(ctx.systemPrompt).toContain('[G1] FILE refactor-v1-foundation');
      expect(ctx.contextTools.map((tool) => tool.name)).toContain(
        'google_drive_read',
      );
      expect(ctx.contextTools.map((tool) => tool.name)).toContain(
        'google_drive_search',
      );
      expect(
        ctx.contextTools.find((tool) => tool.name === 'google_drive_read')
          ?.inputSchema,
      ).toMatchObject({
        required: ['bindingRef'],
      });
    });

    it('includes Google Docs tools when a bound doc, grants, and scopes are present', async () => {
      createTalkResourceBinding({
        talkId: TALK_ID,
        bindingKind: 'google_drive_file',
        externalId: 'google-doc-1',
        displayName: 'Quarterly Review',
        metadata: {
          mimeType: 'application/vnd.google-apps.document',
          url: 'https://docs.google.com/document/d/google-doc-1/edit',
        },
        createdBy: 'owner-1',
      });
      enableTalkTools(['google_docs_read', 'google_docs_batch_update']);
      upsertUserGoogleCredential({
        userId: 'owner-1',
        googleSubject: 'google-subject-1',
        email: 'owner@example.com',
        scopes: ['documents.readonly', 'documents'],
        ciphertext: encryptGoogleToolCredential({
          kind: 'google_tools',
          accessToken: 'google-access-token',
          refreshToken: 'google-refresh-token',
          expiryDate: new Date(Date.now() + 300_000).toISOString(),
          scopes: ['documents.readonly', 'documents'],
          tokenType: 'Bearer',
        }),
      });

      const ctx = await loadTalkContext(
        TALK_ID,
        128000,
        undefined,
        undefined,
        'owner-1',
      );

      expect(ctx.contextTools.map((tool) => tool.name)).toContain(
        'google_docs_read',
      );
      expect(ctx.contextTools.map((tool) => tool.name)).toContain(
        'google_docs_batch_update',
      );
    });

    it('does not include Google Docs tools for non-doc file bindings', async () => {
      createTalkResourceBinding({
        talkId: TALK_ID,
        bindingKind: 'google_drive_file',
        externalId: 'sheet-1',
        displayName: 'Quarterly Model',
        metadata: {
          mimeType: 'application/vnd.google-apps.spreadsheet',
          url: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
        },
        createdBy: 'owner-1',
      });
      enableTalkTools(['google_docs_read', 'google_docs_batch_update']);
      upsertUserGoogleCredential({
        userId: 'owner-1',
        googleSubject: 'google-subject-1',
        email: 'owner@example.com',
        scopes: ['documents.readonly', 'documents'],
        ciphertext: encryptGoogleToolCredential({
          kind: 'google_tools',
          accessToken: 'google-access-token',
          refreshToken: 'google-refresh-token',
          expiryDate: new Date(Date.now() + 300_000).toISOString(),
          scopes: ['documents.readonly', 'documents'],
          tokenType: 'Bearer',
        }),
      });

      const ctx = await loadTalkContext(
        TALK_ID,
        128000,
        undefined,
        undefined,
        'owner-1',
      );

      expect(ctx.contextTools.map((tool) => tool.name)).not.toContain(
        'google_docs_read',
      );
      expect(ctx.contextTools.map((tool) => tool.name)).not.toContain(
        'google_docs_batch_update',
      );
    });
  });

  // =========================================================================
  // System prompt assembly
  // =========================================================================

  describe('system prompt assembly', () => {
    it('includes goal, rules, and sources', async () => {
      // Set goal
      getDb()
        .prepare(
          `INSERT INTO talk_context_goal (talk_id, goal_text, updated_at) VALUES (?, ?, ?)`,
        )
        .run(TALK_ID, 'Help with onboarding', new Date().toISOString());

      // Add rule
      const now = new Date().toISOString();
      getDb()
        .prepare(
          `INSERT INTO talk_context_rules (id, talk_id, rule_text, is_active, sort_order, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?)`,
        )
        .run('rule-1', TALK_ID, 'Use simple language', now, now);

      // Add source
      insertSource({
        id: 'src-1',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'Notes',
        extractedText: 'Short note.',
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);

      expect(ctx.systemPrompt).toContain('Help with onboarding');
      expect(ctx.systemPrompt).toContain('Use simple language');
      expect(ctx.systemPrompt).toContain('[S1] Notes');
    });

    it('includes a bounded state snapshot between rules and sources', async () => {
      getDb()
        .prepare(
          `INSERT INTO talk_context_goal (talk_id, goal_text, updated_at) VALUES (?, ?, ?)`,
        )
        .run(TALK_ID, 'Help with onboarding', new Date().toISOString());

      const now = new Date().toISOString();
      getDb()
        .prepare(
          `INSERT INTO talk_context_rules (id, talk_id, rule_text, is_active, sort_order, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?)`,
        )
        .run('rule-1', TALK_ID, 'Use simple language', now, now);

      const stateResult = insertStateEntry({
        key: 'audience',
        value: { segment: 'new users' },
      });
      if (!stateResult.ok) {
        throw new Error('Expected state entry to be created');
      }

      insertSource({
        id: 'src-1',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'Notes',
        extractedText: 'Short note.',
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);
      const rulesIndex = ctx.systemPrompt.indexOf('**Rules:**');
      const stateIndex = ctx.systemPrompt.indexOf('**State Snapshot:**');
      const sourcesIndex = ctx.systemPrompt.indexOf('**Sources:**');

      expect(stateIndex).toBeGreaterThan(rulesIndex);
      expect(sourcesIndex).toBeGreaterThan(stateIndex);
      expect(ctx.systemPrompt).toContain('audience');
      expect(ctx.systemPrompt).toContain('"segment":"new users"');
      expect(ctx.metadata.stateEntryCount).toBe(1);
    });

    it('includes a bounded outputs manifest and output tools without inlining bodies', async () => {
      createTalkOutput({
        talkId: TALK_ID,
        title: 'Draft Report',
        contentMarkdown: '# Report\n\nDetailed body text',
        createdByUserId: 'owner-1',
      });
      createTalkOutput({
        talkId: TALK_ID,
        title: 'Decision Memo',
        contentMarkdown: 'Second output body',
        createdByUserId: 'owner-1',
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);

      expect(ctx.systemPrompt).toContain('**Outputs:**');
      expect(ctx.systemPrompt).toContain('Draft Report');
      expect(ctx.systemPrompt).not.toContain('Detailed body text');
      expect(ctx.contextSnapshot.outputs.totalCount).toBe(2);
      expect(ctx.contextSnapshot.outputs.manifest).toHaveLength(2);
      expect(ctx.contextSnapshot.tools.contextToolNames).toEqual(
        expect.arrayContaining(['list_outputs', 'read_output', 'write_output']),
      );
    });

    it('omits state entries when the dedicated state budget is exhausted', async () => {
      for (let i = 0; i < 16; i += 1) {
        const result = insertStateEntry({
          key: `entry-${i + 1}`,
          value: { payload: 'x'.repeat(1200) },
        });
        if (!result.ok) {
          throw new Error('Expected state entry to be created');
        }
      }

      const ctx = await loadTalkContext(TALK_ID, 128000);

      expect(ctx.systemPrompt).toContain('**State Snapshot:**');
      expect(ctx.systemPrompt).toMatch(
        /omitted.*Use list_state\(prefix\).*read_state\(key\)/i,
      );
    });

    it('inlines small text sources', async () => {
      insertSource({
        id: 'src-1',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'Tiny Note',
        extractedText: 'This is tiny.',
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);

      // Small text should be inlined in the system prompt
      expect(ctx.systemPrompt).toContain('This is tiny.');
    });

    it('does not inline large text sources', async () => {
      const bigText = 'x'.repeat(1100); // ~275 tokens, exceeds 250 threshold
      insertSource({
        id: 'src-1',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'Big Text',
        extractedText: bigText,
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);

      // Should be in manifest but not inlined
      expect(ctx.systemPrompt).toContain('[S1] Big Text');
      expect(ctx.systemPrompt).not.toContain(bigText);
    });

    it('inlines multiple individually-small text sources', async () => {
      const text200 = 'y'.repeat(800); // ~200 tokens each, below per-item threshold
      insertSource({
        id: 'src-a',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'Text A',
        extractedText: text200,
        sortOrder: 0,
      });
      insertSource({
        id: 'src-b',
        sourceRef: 'S2',
        sourceType: 'text',
        title: 'Text B',
        extractedText: text200,
        sortOrder: 1,
      });
      insertSource({
        id: 'src-c',
        sourceRef: 'S3',
        sourceType: 'text',
        title: 'Text C',
        extractedText: text200,
        sortOrder: 2,
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);

      expect(ctx.systemPrompt).toContain('[S1] Content:');
      expect(ctx.systemPrompt).toContain('[S2] Content:');
      expect(ctx.systemPrompt).toContain('[S3] Content:');
    });

    it('does not inline URL or file sources even when extracted text is small', async () => {
      insertSource({
        id: 'src-url',
        sourceRef: 'S1',
        sourceType: 'url',
        title: 'URL Source',
        sourceUrl: 'https://example.com/url',
        extractedText: 'Small URL text',
        sortOrder: 0,
      });
      insertSource({
        id: 'src-file',
        sourceRef: 'S2',
        sourceType: 'file',
        title: 'File Source',
        extractedText: 'Small file text',
        sortOrder: 1,
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);

      expect(ctx.systemPrompt).toContain(
        '[S1] URL Source - https://example.com/url',
      );
      expect(ctx.systemPrompt).toContain('[S2] File Source');
      expect(ctx.systemPrompt).not.toContain('Small URL text');
      expect(ctx.systemPrompt).not.toContain('Small file text');
      expect(ctx.systemPrompt).not.toContain('[S1] Content:');
      expect(ctx.systemPrompt).not.toContain('[S2] Content:');
    });

    it('suppresses talk-level summary when loading a specific thread', async () => {
      insertTalkSummary('Cross-thread summary that should not be injected');

      const threadedCtx = await loadTalkContext(TALK_ID, 128000, THREAD_ID);
      const unthreadedCtx = await loadTalkContext(TALK_ID, 128000);

      expect(unthreadedCtx.systemPrompt).toContain(
        'Cross-thread summary that should not be injected',
      );
      expect(threadedCtx.systemPrompt).not.toContain(
        'Cross-thread summary that should not be injected',
      );
      expect(threadedCtx.metadata.hasSummary).toBe(false);
    });
  });

  // =========================================================================
  // Metadata
  // =========================================================================

  describe('metadata', () => {
    it('reports correct source and history counts', async () => {
      insertSource({
        id: 'src-1',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'Note',
        extractedText: 'Content.',
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);
      expect(ctx.metadata.sourceCount).toBe(1);
      expect(ctx.metadata.talkId).toBe(TALK_ID);
    });

    it('captures role-aware retrieval details in the saved context snapshot', async () => {
      insertTalkSummary(
        'Cal should stay competitive, but the offense has major downside risk.',
      );
      insertStateEntry({
        key: 'offense_risk',
        value: {
          concern: 'line play remains a weakness',
          likelihood: 'medium',
        },
      });
      insertSource({
        id: 'src-risk-1',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'Spring Practice Notes',
        extractedText:
          'The offense remains volatile and the rushing attack is still a weakness. '.repeat(
            20,
          ),
      });
      insertTalkMessage({
        id: 'msg-risk-1',
        role: 'user',
        content: 'What are the main weaknesses for next season?',
        createdAt: '2026-03-14T00:00:01.000Z',
        createdBy: 'owner-1',
      });

      const ctx = await loadTalkContext(
        TALK_ID,
        128000,
        THREAD_ID,
        null,
        null,
        {
          personaRole: 'critic',
          retrievalQuery: 'What are the main weaknesses for next season?',
        },
      );

      expect(ctx.systemPrompt).toContain('Role Context Hint');
      expect(ctx.systemPrompt).toContain('weaknesses');
      expect(ctx.contextSnapshot.personaRole).toBe('critic');
      expect(ctx.contextSnapshot.roleHint).toMatch(/weaknesses/i);
      expect(ctx.contextSnapshot.retrieval.query).toBe(
        'What are the main weaknesses for next season?',
      );
      expect(ctx.contextSnapshot.retrieval.roleTerms).toContain('risk');
      expect(ctx.contextSnapshot.stateSnapshot.included).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'offense_risk',
            reason: 'state_snapshot',
          }),
        ]),
      );
      expect(ctx.contextSnapshot.retrieval.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ref: 'S1',
            title: 'Spring Practice Notes',
          }),
        ]),
      );
      expect(ctx.contextSnapshot.history.messageIds).toEqual(['msg-risk-1']);
    });
  });

  // =========================================================================
  // History budgeting
  // =========================================================================

  describe('history budgeting', () => {
    it('keeps the newest messages within budget and preserves chronological order', async () => {
      insertTalkMessage({
        id: 'msg-1',
        role: 'user',
        content: 'A'.repeat(120),
        createdAt: '2026-03-14T00:00:01.000Z',
        createdBy: 'owner-1',
      });
      insertTalkMessage({
        id: 'msg-2',
        role: 'assistant',
        content: 'B'.repeat(120),
        createdAt: '2026-03-14T00:00:02.000Z',
      });
      insertTalkMessage({
        id: 'msg-3',
        role: 'user',
        content: 'C'.repeat(120),
        createdAt: '2026-03-14T00:00:03.000Z',
        createdBy: 'owner-1',
      });
      insertTalkMessage({
        id: 'msg-4',
        role: 'assistant',
        content: 'D'.repeat(120),
        createdAt: '2026-03-14T00:00:04.000Z',
      });

      const ctx = await loadTalkContext(TALK_ID, 6156);

      expect(ctx.history).toHaveLength(2);
      expect(ctx.history[0].content).toBe('C'.repeat(120));
      expect(ctx.history[1].content).toBe('D'.repeat(120));
    });

    it('returns no history when the available budget is exhausted', async () => {
      insertTalkMessage({
        id: 'msg-5',
        role: 'user',
        content: 'This message should be trimmed out by a tiny budget.',
        createdAt: '2026-03-14T00:00:05.000Z',
        createdBy: 'owner-1',
      });

      const ctx = await loadTalkContext(TALK_ID, 6000);

      expect(ctx.history).toEqual([]);
    });
  });

  // =========================================================================
  // Executor tool path: buildToolExecutor end-to-end
  // =========================================================================

  describe('buildToolExecutor (read_context_source)', () => {
    it('resolves a source by stable sourceRef and returns extracted_text', async () => {
      insertSource({
        id: 'src-uuid-1',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'Meeting Notes',
        extractedText: 'We discussed Q4 targets.',
      });

      const executor = buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-test',
        AbortSignal.timeout(5000),
      );
      const result = await executor('read_context_source', { sourceRef: 'S1' });

      expect(result.isError).toBeFalsy();
      expect(result.result).toBe('We discussed Q4 targets.');
    });

    it('resolves a source by row ID as fallback', async () => {
      insertSource({
        id: 'src-uuid-2',
        sourceRef: 'S2',
        sourceType: 'url',
        title: 'Docs',
        sourceUrl: 'https://example.com',
        extractedText: 'Page content here.',
      });

      // The SQL uses (id = ? OR source_ref = ?), so passing the row ID works
      const executor = buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-test',
        AbortSignal.timeout(5000),
      );
      const result = await executor('read_context_source', {
        sourceRef: 'src-uuid-2',
      });

      expect(result.isError).toBeFalsy();
      expect(result.result).toBe('Page content here.');
    });

    it('returns error when sourceRef is missing', async () => {
      const executor = buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-test',
        AbortSignal.timeout(5000),
      );
      const result = await executor('read_context_source', {});

      expect(result.isError).toBe(true);
      expect(result.result).toContain('sourceRef');
    });

    it('returns error for non-existent source ref', async () => {
      const executor = buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-test',
        AbortSignal.timeout(5000),
      );
      const result = await executor('read_context_source', {
        sourceRef: 'S99',
      });

      expect(result.isError).toBe(true);
      expect(result.result).toContain('not found');
    });

    it('returns empty string when extracted_text is null', async () => {
      insertSource({
        id: 'src-uuid-3',
        sourceRef: 'S3',
        sourceType: 'url',
        title: 'Pending URL',
        sourceUrl: 'https://example.com/pending',
        extractedText: null,
      });

      const executor = buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-test',
        AbortSignal.timeout(5000),
      );
      const result = await executor('read_context_source', { sourceRef: 'S3' });

      expect(result.isError).toBeFalsy();
      expect(result.result).toBe('');
    });

    it('does NOT resolve when using old "ref" parameter name', async () => {
      insertSource({
        id: 'src-uuid-4',
        sourceRef: 'S4',
        sourceType: 'text',
        title: 'Note',
        extractedText: 'Some content.',
      });

      // Simulate what a model would send if it used the old parameter name
      const executor = buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-test',
        AbortSignal.timeout(5000),
      );
      const result = await executor('read_context_source', { ref: 'S4' });

      // Should fail because the executor reads args.sourceRef, not args.ref
      expect(result.isError).toBe(true);
      expect(result.result).toContain('sourceRef');
    });
  });

  // =========================================================================
  // Executor tool path: buildToolExecutor (read_attachment)
  // =========================================================================

  describe('buildToolExecutor (read_attachment)', () => {
    it('resolves an attachment by ID and returns extracted_text', async () => {
      const now = new Date().toISOString();
      insertTalkMessage({
        id: 'msg-1',
        role: 'user',
        content: 'See attached',
        createdAt: now,
      });
      getDb()
        .prepare(
          `INSERT INTO talk_message_attachments (
            id, talk_id, message_id, file_name, mime_type, storage_key, extracted_text, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'att-1',
          TALK_ID,
          'msg-1',
          'report.pdf',
          'application/pdf',
          'store/att-1',
          'PDF content here.',
          now,
        );

      const executor = buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-test',
        AbortSignal.timeout(5000),
      );
      const result = await executor('read_attachment', {
        attachmentId: 'att-1',
      });

      expect(result.isError).toBeFalsy();
      expect(result.result).toBe('PDF content here.');
    });

    it('returns error for non-existent attachment', async () => {
      const executor = buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-test',
        AbortSignal.timeout(5000),
      );
      const result = await executor('read_attachment', {
        attachmentId: 'no-such',
      });

      expect(result.isError).toBe(true);
      expect(result.result).toContain('not found');
    });

    it('returns a descriptive message for image attachments without extracted text', async () => {
      const now = new Date().toISOString();
      insertTalkMessage({
        id: 'msg-image-1',
        role: 'user',
        content: 'See screenshot',
        createdAt: now,
      });
      getDb()
        .prepare(
          `INSERT INTO talk_message_attachments (
            id, talk_id, message_id, file_name, mime_type, storage_key, extracted_text, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'att-image-1',
          TALK_ID,
          'msg-image-1',
          'screenshot.png',
          'image/png',
          'store/att-image-1',
          null,
          now,
        );

      const executor = buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-test',
        AbortSignal.timeout(5000),
      );
      const result = await executor('read_attachment', {
        attachmentId: 'att-image-1',
      });

      expect(result.isError).toBeFalsy();
      expect(result.result).toContain('cannot be read as text');
      expect(result.result).toContain('screenshot.png');
    });
  });

  describe('buildToolExecutor (google_drive_read)', () => {
    it('reads a directly bound Google Drive file for the requesting user', async () => {
      createTalkResourceBinding({
        talkId: TALK_ID,
        bindingKind: 'google_drive_file',
        externalId: 'drive-file-1',
        displayName: 'refactor-v1-foundation',
        metadata: {
          mimeType: 'text/plain',
          url: 'https://drive.google.com/file/d/drive-file-1/view',
        },
        createdBy: 'owner-1',
      });
      upsertUserGoogleCredential({
        userId: 'owner-1',
        googleSubject: 'google-subject-1',
        email: 'owner@example.com',
        scopes: ['drive.readonly'],
        ciphertext: encryptGoogleToolCredential({
          kind: 'google_tools',
          accessToken: 'google-access-token',
          refreshToken: 'google-refresh-token',
          expiryDate: new Date(Date.now() + 300_000).toISOString(),
          scopes: ['drive.readonly'],
          tokenType: 'Bearer',
        }),
      });

      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input) => {
          const url = String(input);
          if (url.includes('/drive/v3/files/drive-file-1?fields=')) {
            return new Response(
              JSON.stringify({
                id: 'drive-file-1',
                name: 'refactor-v1-foundation',
                mimeType: 'text/plain',
                parents: [],
                webViewLink:
                  'https://drive.google.com/file/d/drive-file-1/view',
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            );
          }
          if (url.includes('/drive/v3/files/drive-file-1?alt=media')) {
            return new Response('This file explains the refactor foundation.', {
              status: 200,
              headers: { 'content-type': 'text/plain' },
            });
          }
          throw new Error(`Unexpected fetch: ${url}`);
        });

      const executor = buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-test',
        AbortSignal.timeout(5000),
      );
      const result = await executor('google_drive_read', {
        bindingRef: 'G1',
      });

      expect(fetchMock).toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      expect(result.result).toContain('# refactor-v1-foundation');
      expect(result.result).toContain(
        'This file explains the refactor foundation.',
      );
    });
  });

  describe('buildToolExecutor (google_docs_read)', () => {
    it('reads a directly bound Google Doc for the requesting user', async () => {
      createTalkResourceBinding({
        talkId: TALK_ID,
        bindingKind: 'google_drive_file',
        externalId: 'google-doc-1',
        displayName: 'Quarterly Review',
        metadata: {
          mimeType: 'application/vnd.google-apps.document',
          url: 'https://docs.google.com/document/d/google-doc-1/edit',
        },
        createdBy: 'owner-1',
      });
      enableTalkTools(['google_docs_read']);
      upsertUserGoogleCredential({
        userId: 'owner-1',
        googleSubject: 'google-subject-1',
        email: 'owner@example.com',
        scopes: ['documents.readonly'],
        ciphertext: encryptGoogleToolCredential({
          kind: 'google_tools',
          accessToken: 'google-access-token',
          refreshToken: 'google-refresh-token',
          expiryDate: new Date(Date.now() + 300_000).toISOString(),
          scopes: ['documents.readonly'],
          tokenType: 'Bearer',
        }),
      });

      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input) => {
          const url = String(input);
          if (url.includes('/documents/google-doc-1')) {
            return new Response(
              JSON.stringify({
                title: 'Quarterly Review',
                body: {
                  content: [
                    {
                      paragraph: {
                        elements: [
                          {
                            textRun: {
                              content: 'Q1 beat plan.\n',
                            },
                          },
                        ],
                      },
                    },
                    {
                      paragraph: {
                        elements: [
                          {
                            textRun: {
                              content: 'Q2 needs cost control.\n',
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            );
          }
          throw new Error(`Unexpected fetch: ${url}`);
        });

      const executor = buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-test',
        AbortSignal.timeout(5000),
      );
      const result = await executor('google_docs_read', {
        bindingRef: 'G1',
      });

      expect(fetchMock).toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      expect(result.result).toContain('# Quarterly Review');
      expect(result.result).toContain('Q1 beat plan.');
      expect(result.result).toContain('Q2 needs cost control.');
    });
  });

  describe('buildToolExecutor (google_docs_batch_update)', () => {
    it('applies a batch update to a directly bound Google Doc', async () => {
      createTalkResourceBinding({
        talkId: TALK_ID,
        bindingKind: 'google_drive_file',
        externalId: 'google-doc-1',
        displayName: 'Quarterly Review',
        metadata: {
          mimeType: 'application/vnd.google-apps.document',
          url: 'https://docs.google.com/document/d/google-doc-1/edit',
        },
        createdBy: 'owner-1',
      });
      enableTalkTools(['google_docs_batch_update']);
      upsertUserGoogleCredential({
        userId: 'owner-1',
        googleSubject: 'google-subject-1',
        email: 'owner@example.com',
        scopes: ['documents'],
        ciphertext: encryptGoogleToolCredential({
          kind: 'google_tools',
          accessToken: 'google-access-token',
          refreshToken: 'google-refresh-token',
          expiryDate: new Date(Date.now() + 300_000).toISOString(),
          scopes: ['documents'],
          tokenType: 'Bearer',
        }),
      });

      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input, init) => {
          const url = String(input);
          if (url.includes('/documents/google-doc-1:batchUpdate')) {
            expect(init?.method).toBe('POST');
            expect(JSON.parse(String(init?.body))).toMatchObject({
              requests: [
                {
                  replaceAllText: {
                    containsText: { text: '{{quarter}}' },
                    replaceText: 'Q2',
                  },
                },
              ],
            });
            return new Response(
              JSON.stringify({
                documentId: 'google-doc-1',
                replies: [{}],
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            );
          }
          throw new Error(`Unexpected fetch: ${url}`);
        });

      const executor = buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-test',
        AbortSignal.timeout(5000),
      );
      const result = await executor('google_docs_batch_update', {
        bindingRef: 'G1',
        requests: [
          {
            replaceAllText: {
              containsText: { text: '{{quarter}}' },
              replaceText: 'Q2',
            },
          },
        ],
      });

      expect(fetchMock).toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.result)).toMatchObject({
        documentId: 'google-doc-1',
        replies: [{}],
      });
    });
  });

  describe('buildToolExecutor (update_state)', () => {
    it('creates and updates Talk state entries with CAS semantics', async () => {
      insertRun('run-state-1');
      const executor = buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-state-1',
        AbortSignal.timeout(5000),
      );

      const created = await executor('update_state', {
        key: 'decision',
        value: { winner: 'Claude' },
        expectedVersion: 0,
      });
      expect(created.isError).toBeFalsy();
      expect(JSON.parse(created.result)).toMatchObject({
        key: 'decision',
        value: { winner: 'Claude' },
        version: 1,
        updatedByRunId: 'run-state-1',
      });

      insertRun('run-state-2');
      const updater = buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-state-2',
        AbortSignal.timeout(5000),
      );
      const updated = await updater('update_state', {
        key: 'decision',
        value: { winner: 'OpenAI' },
        expectedVersion: 1,
      });

      expect(updated.isError).toBeFalsy();
      expect(JSON.parse(updated.result)).toMatchObject({
        key: 'decision',
        value: { winner: 'OpenAI' },
        version: 2,
        updatedByRunId: 'run-state-2',
      });
    });

    it('returns the current stored entry when the version is stale', async () => {
      const seed = insertStateEntry({
        key: 'decision',
        value: { winner: 'Claude' },
      });
      if (!seed.ok) {
        throw new Error('Expected state entry to be created');
      }

      insertRun('run-state-3');
      const executor = buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-state-3',
        AbortSignal.timeout(5000),
      );
      const result = await executor('update_state', {
        key: 'decision',
        value: { winner: 'OpenAI' },
        expectedVersion: 0,
      });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.result)).toMatchObject({
        conflict: true,
        current: {
          key: 'decision',
          value: { winner: 'Claude' },
          version: 1,
        },
      });
    });
  });

  // =========================================================================
  // Executor tool path: unknown tools
  // =========================================================================

  describe('buildToolExecutor (unknown tools)', () => {
    it('returns error for unknown tool names', async () => {
      const executor = buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-test',
        AbortSignal.timeout(5000),
      );
      const result = await executor('some_random_tool', {});

      expect(result.isError).toBe(true);
      expect(result.result).toContain('not available');
    });
  });

  describe('read_state and delete_state tool definitions', () => {
    it('read_state tool is always present regardless of job policy', async () => {
      const ctx = await loadTalkContext(TALK_ID, 128000, null, null, null, {
        jobPolicy: {
          jobId: 'job-1',
          allowedConnectorIds: [],
          allowedChannelBindingIds: [],
          allowWeb: false,
          allowStateMutation: false,
          allowOutputWrite: false,
        },
      });

      const toolNames = ctx.contextTools.map((t) => t.name);
      expect(toolNames).toContain('read_state');
    });

    it('delete_state tool is present when allowStateMutation is true', async () => {
      const ctx = await loadTalkContext(TALK_ID, 128000);

      const toolNames = ctx.contextTools.map((t) => t.name);
      expect(toolNames).toContain('delete_state');
      expect(toolNames).toContain('update_state');
    });

    it('delete_state tool is absent when allowStateMutation is false', async () => {
      const ctx = await loadTalkContext(TALK_ID, 128000, null, null, null, {
        jobPolicy: {
          jobId: 'job-1',
          allowedConnectorIds: [],
          allowedChannelBindingIds: [],
          allowWeb: false,
          allowStateMutation: false,
          allowOutputWrite: false,
        },
      });

      const toolNames = ctx.contextTools.map((t) => t.name);
      expect(toolNames).not.toContain('delete_state');
      expect(toolNames).not.toContain('update_state');
    });

    it('omission note includes key names when entries are omitted', async () => {
      for (let i = 0; i < 20; i += 1) {
        upsertTalkStateEntry({
          talkId: TALK_ID,
          key: `omit_key_${i}`,
          value: { payload: 'x'.repeat(1200) },
          expectedVersion: 0,
        });
      }

      const ctx = await loadTalkContext(TALK_ID, 128000);
      expect(ctx.systemPrompt).toContain('**State Snapshot:**');
      expect(ctx.systemPrompt).toMatch(/keys:.*omit_key_/);
      expect(ctx.systemPrompt).toContain('read_state(key)');
    });

    it('omission note shows +N more for more than five omitted keys', async () => {
      for (let i = 0; i < 16; i += 1) {
        upsertTalkStateEntry({
          talkId: TALK_ID,
          key: `bulk_${i}`,
          value: { payload: 'x'.repeat(1200) },
          expectedVersion: 0,
        });
      }

      const ctx = await loadTalkContext(TALK_ID, 128000);

      expect(ctx.contextSnapshot.stateSnapshot.omittedCount).toBeGreaterThan(5);
      const omissionMatch = ctx.systemPrompt.match(/\+(\d+) more/);
      expect(omissionMatch).not.toBeNull();
      expect(Number(omissionMatch![1])).toBeGreaterThan(0);
    });

    it('includes a channel context section when provided', async () => {
      const ctx = await loadTalkContext(TALK_ID, 128000, null, null, null, {
        channelContextSection:
          'Platform: Slack\nBinding note:\nKeep replies concise.',
      });

      expect(ctx.systemPrompt).toContain('**Channel Context:**');
      expect(ctx.systemPrompt).toContain('Platform: Slack');
      expect(ctx.systemPrompt).toContain('Keep replies concise.');
    });
  });
});
