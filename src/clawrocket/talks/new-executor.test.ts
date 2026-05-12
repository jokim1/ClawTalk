import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agents/agent-router.js', () => ({
  executeWithAgent: vi.fn(),
}));
vi.mock('../agents/execution-planner.js', () => ({
  planExecution: vi.fn(),
  getContainerAllowedTools: vi.fn(() => ['Bash']),
}));
vi.mock('../agents/container-turn-executor.js', () => ({
  executeContainerAgentTurn: vi.fn(),
}));
vi.mock('../agents/project-mounts.js', () => ({
  resolveValidatedProjectMountPath: vi.fn(),
}));
vi.mock('../tools/browser-tools.js', () => ({
  BROWSER_TOOL_DEFINITIONS: [],
  executeBrowserTool: vi.fn(),
}));
vi.mock('../channels/slack-connector.js', () => ({
  fetchSlackRecentConversationContext: vi.fn(),
}));

import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  createMessageAttachment,
  createTalkChannelBinding,
  createTalkMessage,
  createTalkOutput,
  createTalkRun,
  linkAttachmentToMessage,
  upsertChannelConnection,
  upsertTalk,
  updateAttachmentExtraction,
  upsertUser,
} from '../db/index.js';
import { executeWithAgent } from '../agents/agent-router.js';
import { planExecution } from '../agents/execution-planner.js';
import { executeContainerAgentTurn } from '../agents/container-turn-executor.js';
import { resolveValidatedProjectMountPath } from '../agents/project-mounts.js';
import { fetchSlackRecentConversationContext } from '../channels/slack-connector.js';
import { createRegisteredAgent } from '../db/agent-accessors.js';
import { upsertTalkStateEntry } from '../db/context-accessors.js';
import { buildToolExecutor, CleanTalkExecutor } from './new-executor.js';
import * as attachmentStorage from './attachment-storage.js';
import { saveAttachmentFile } from './attachment-storage.js';
import type { TalkExecutionEvent } from './executor.js';

const TALK_ID = 'talk-clean-exec';
const THREAD_ID = 'thread-clean-exec';

function insertSource(input: {
  id: string;
  sourceRef: string;
  title: string;
  extractedText: string;
}) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO talk_context_sources (
        id, talk_id, source_ref, source_type, title, status,
        extracted_text, created_at, updated_at, created_by
      ) VALUES (?, ?, ?, 'text', ?, 'ready', ?, ?, ?, ?)
    `,
    )
    .run(
      input.id,
      TALK_ID,
      input.sourceRef,
      input.title,
      input.extractedText,
      now,
      now,
      'owner-1',
    );
}

describe('CleanTalkExecutor', () => {
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
      topicTitle: 'Executor Contract Test Talk',
    });
    vi.mocked(executeWithAgent).mockReset();
    vi.mocked(planExecution).mockReset();
    vi.mocked(executeContainerAgentTurn).mockReset();
    vi.mocked(resolveValidatedProjectMountPath).mockReset();
    vi.mocked(resolveValidatedProjectMountPath).mockImplementation((path) =>
      path ? String(path) : null,
    );
    vi.mocked(fetchSlackRecentConversationContext).mockReset();
    vi.mocked(fetchSlackRecentConversationContext).mockResolvedValue({
      mode: 'skipped',
      lines: [],
      unavailableReason: null,
    });
    vi.mocked(planExecution).mockReturnValue({
      backend: 'direct_http',
      routeReason: 'normal',
      authPath: 'api_key',
      credentialSource: 'env',
      effectiveTools: [],
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      binding: {
        providerConfig: {
          providerId: 'provider.anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiFormat: 'anthropic_messages',
          authScheme: 'x_api_key',
        },
        secret: { apiKey: 'sk-ant-test' },
      },
    });
  });

  it('executes context tools but does not persist assistant messages or llm attempts directly', async () => {
    const now = new Date().toISOString();
    createTalkMessage({
      id: 'msg-user-1',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Summarize source S1',
      createdBy: 'owner-1',
      createdAt: now,
    });
    createTalkRun({
      id: 'run-talk-1',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: 'msg-user-1',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: null,
      sequence_index: null,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: now,
      started_at: now,
      ended_at: null,
      cancel_reason: null,
    });
    insertSource({
      id: 'src-1',
      sourceRef: 'S1',
      title: 'Meeting Notes',
      extractedText: 'Revenue grew 20 percent quarter over quarter.',
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (agentId, context, userMessage, options) => {
        expect(context).not.toBeNull();
        expect(agentId).toBe('agent.main');
        expect(userMessage).toBe('Summarize source S1');
        expect(context!.systemPrompt).toContain('[S1] Meeting Notes');
        expect(context!.contextTools.map((tool) => tool.name)).toContain(
          'read_context_source',
        );

        const toolResult = await options.executeToolCall!(
          'read_context_source',
          { sourceRef: 'S1' },
        );
        expect(toolResult).toEqual({
          result: 'Revenue grew 20 percent quarter over quarter.',
        });

        options.emit?.({
          type: 'started',
          runId: options.runId,
          agentId,
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        });
        options.emit?.({
          type: 'text_delta',
          text: 'Summary ready.',
        });
        options.emit?.({
          type: 'usage',
          inputTokens: 12,
          outputTokens: 34,
          estimatedCostUsd: 0,
        });
        options.emit?.({
          type: 'completed',
          content: 'Summary ready.',
        });

        return {
          content: `Summary ready. ${toolResult.result}`,
          agentId,
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
          usage: {
            inputTokens: 12,
            outputTokens: 34,
            estimatedCostUsd: 0,
          },
        };
      },
    );

    const events: TalkExecutionEvent[] = [];
    const executor = new CleanTalkExecutor();
    const result = await executor.execute(
      {
        runId: 'run-talk-1',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-1',
        triggerContent: 'Summarize source S1',
      },
      new AbortController().signal,
      (event) => events.push(event),
    );

    expect(result.content).toBe(
      'Summary ready. Revenue grew 20 percent quarter over quarter.',
    );
    expect(result.agentId).toBe('agent.main');
    expect(result.providerId).toBe('provider.anthropic');
    expect(result.modelId).toBe('claude-sonnet-4-6');
    expect(result.responseSequenceInRun).toBe(1);
    expect(result.metadataJson).toBeTruthy();
    expect(JSON.parse(result.metadataJson!)).toMatchObject({
      runId: 'run-talk-1',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      responseGroupId: null,
      sequenceIndex: null,
    });
    const persistedRun = getDb()
      .prepare(
        `
        SELECT metadata_json
        FROM talk_runs
        WHERE id = ?
      `,
      )
      .get('run-talk-1') as { metadata_json: string | null } | undefined;
    expect(persistedRun?.metadata_json).toBeTruthy();
    expect(JSON.parse(persistedRun!.metadata_json!)).toMatchObject({
      version: 1,
      threadId: THREAD_ID,
      history: {
        messageIds: ['msg-user-1'],
        turnCount: 1,
      },
      tools: {
        contextToolNames: expect.arrayContaining(['read_context_source']),
      },
    });

    expect(events.some((event) => event.type === 'talk_response_started')).toBe(
      true,
    );
    expect(events.some((event) => event.type === 'talk_response_delta')).toBe(
      true,
    );
    expect(
      events.some(
        (event) =>
          event.type === 'talk_response_completed' &&
          event.agentId === 'agent.main',
      ),
    ).toBe(true);

    const assistantMessages = getDb()
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM talk_messages
        WHERE talk_id = ? AND role = 'assistant'
      `,
      )
      .get(TALK_ID) as { count: number };
    expect(assistantMessages.count).toBe(0);

    const llmAttempts = getDb()
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM llm_attempts
        WHERE run_id = ?
      `,
      )
      .get('run-talk-1') as { count: number };
    expect(llmAttempts.count).toBe(0);
  });

  it('persists direct-http completion metadata into the response payload', async () => {
    const now = new Date().toISOString();
    createTalkMessage({
      id: 'msg-user-completion',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Give me the final answer',
      createdBy: 'owner-1',
      createdAt: now,
    });
    createTalkRun({
      id: 'run-talk-completion',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: 'msg-user-completion',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: null,
      sequence_index: null,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: now,
      started_at: now,
      ended_at: null,
      cancel_reason: null,
    });

    vi.mocked(executeWithAgent).mockResolvedValue({
      content: 'Final answer.',
      agentId: 'agent.main',
      providerId: 'provider.openai',
      modelId: 'gpt-5-mini',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        estimatedCostUsd: 0,
      },
      completion: {
        completionStatus: 'complete',
        providerStopReason: 'stop',
        incompleteReason: null,
      },
    });

    const executor = new CleanTalkExecutor();
    const result = await executor.execute(
      {
        runId: 'run-talk-completion',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-completion',
        triggerContent: 'Give me the final answer',
      },
      new AbortController().signal,
    );

    expect(JSON.parse(result.metadataJson || '{}')).toMatchObject({
      completionStatus: 'complete',
      providerStopReason: 'stop',
      incompleteReason: null,
      completedCleanly: true,
    });
  });

  it('injects a multi-agent routing note and keeps the Talk nickname for grouped direct runs', async () => {
    const kimiAgent = createRegisteredAgent({
      name: 'Moonshot Kimi',
      providerId: 'provider.nvidia',
      modelId: 'moonshotai/kimi-k2.5',
      toolPermissionsJson: '{}',
    });
    const gemAgent = createRegisteredAgent({
      name: 'Gemini Flash',
      providerId: 'provider.gemini',
      modelId: 'gemini-2.5-flash',
      toolPermissionsJson: '{}',
    });
    getDb()
      .prepare(
        `
      INSERT INTO talk_agents (id, talk_id, registered_agent_id, nickname, is_primary, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 0, datetime('now'), datetime('now'))
    `,
      )
      .run('ta-kimi', TALK_ID, kimiAgent.id, 'Kimi');
    getDb()
      .prepare(
        `
      INSERT INTO talk_agents (id, talk_id, registered_agent_id, nickname, is_primary, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 1, datetime('now'), datetime('now'))
    `,
      )
      .run('ta-gem', TALK_ID, gemAgent.id, 'Gem');
    createTalkMessage({
      id: 'msg-user-grouped',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: '@kimi and @gem please review this.',
      createdBy: 'owner-1',
      createdAt: '2026-03-27T00:00:00.000Z',
    });
    createTalkRun({
      id: 'run-grouped-kimi',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: 'msg-user-grouped',
      target_agent_id: kimiAgent.id,
      idempotency_key: null,
      response_group_id: 'group-kimi-gem',
      sequence_index: 0,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2026-03-27T00:00:00.100Z',
      started_at: '2026-03-27T00:00:00.100Z',
      ended_at: null,
      cancel_reason: null,
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (agentId, context, userMessage) => {
        expect(agentId).toBe(kimiAgent.id);
        expect(userMessage).toBe('@kimi and @gem please review this.');
        expect(context?.systemPrompt).toContain('Multi-agent routing note:');
        expect(context?.systemPrompt).toContain('You are Kimi.');
        expect(context?.systemPrompt).toContain(
          'Do not say you cannot invoke the other agents',
        );
        return {
          content: 'I will handle only my own perspective.',
          agentId: kimiAgent.id,
          providerId: 'provider.nvidia',
          modelId: 'moonshotai/kimi-k2.5',
        };
      },
    );

    const result = await new CleanTalkExecutor().execute(
      {
        runId: 'run-grouped-kimi',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-grouped',
        triggerContent: '@kimi and @gem please review this.',
        targetAgentId: kimiAgent.id,
        responseGroupId: 'group-kimi-gem',
        sequenceIndex: 0,
      },
      new AbortController().signal,
    );

    expect(result.agentNickname).toBe('Kimi');
  });

  it('injects channel context and recent Slack history for channel-triggered runs', async () => {
    const now = new Date().toISOString();
    const agent = createRegisteredAgent({
      name: 'Slack Channel Agent',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: '{}',
    });
    getDb()
      .prepare(
        `
      INSERT INTO talk_agents (id, talk_id, registered_agent_id, nickname, is_primary, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 0, datetime('now'), datetime('now'))
    `,
      )
      .run('agent.main', TALK_ID, agent.id, agent.name);
    const connection = upsertChannelConnection({
      platform: 'slack',
      connectionMode: 'oauth_workspace',
      accountKey: 'slack:T-kim',
      displayName: 'Slack (KimFamily)',
      config: {
        teamId: 'T-kim',
        teamName: 'KimFamily',
      },
      createdBy: 'owner-1',
      updatedBy: 'owner-1',
      healthStatus: 'healthy',
      lastHealthCheckAt: now,
      lastHealthError: null,
    });
    const binding = createTalkChannelBinding({
      talkId: TALK_ID,
      connectionId: connection.id,
      targetKind: 'channel',
      targetId: 'slack:C-general',
      displayName: '#general',
      createdBy: 'owner-1',
      responseMode: 'all',
      deliveryMode: 'reply',
      timezone: 'Pacific/Honolulu',
      instructions:
        'Reply briefly when directly mentioned. Keep all binding state inside the provided namespace.',
      now,
    });
    createTalkMessage({
      id: 'msg-channel-trigger-1',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Hey @Clawd can you help here?',
      createdBy: 'owner-1',
      createdAt: now,
      metadataJson: JSON.stringify({
        kind: 'channel_inbound',
        bindingId: binding.id,
        platform: 'slack',
        connectionId: connection.id,
        targetKind: 'channel',
        targetId: 'slack:C-general',
        targetDisplayName: '#general',
        senderId: 'U-big-daddy',
        senderName: 'Big Bad Daddy',
        isMentioned: true,
        timestamp: now,
        externalMessageId: '1710000000.000100',
        metadata: {
          sourceThreadKey: '1710000000.000100',
        },
      }),
    });
    createTalkRun({
      id: 'run-channel-context-1',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: 'msg-channel-trigger-1',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: null,
      sequence_index: null,
      executor_alias: null,
      executor_model: null,
      source_binding_id: binding.id,
      source_external_message_id: '1710000000.000100',
      source_thread_key: '1710000000.000100',
      created_at: now,
      started_at: now,
      ended_at: null,
      cancel_reason: null,
    });
    vi.mocked(fetchSlackRecentConversationContext).mockResolvedValue({
      mode: 'channel',
      lines: ['- Asher: 60 min math', '- Jaxon: 3 hrs vibecoding'],
      unavailableReason: null,
    });
    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, context, userMessage) => {
        expect(userMessage).toBe('Hey @Clawd can you help here?');
        expect(context?.systemPrompt).toContain('**Channel Context:**');
        expect(context?.systemPrompt).toContain('Platform: Slack');
        expect(context?.systemPrompt).toContain(
          'Connection: Slack (KimFamily)',
        );
        expect(context?.systemPrompt).toContain(
          'Binding instructions:\nReply briefly when directly mentioned. Keep all binding state inside the provided namespace.',
        );
        expect(context?.systemPrompt).toContain('State namespace: channel.');
        expect(context?.systemPrompt).toContain('Local day-of-week:');
        expect(context?.systemPrompt).toContain('Timezone: Pacific/Honolulu');
        expect(context?.systemPrompt).toContain('Recent Slack context:');
        expect(context?.systemPrompt).toContain('- Asher: 60 min math');
        expect(context?.systemPrompt).toContain(
          'This message directly mentioned the assistant.',
        );
        return {
          content: 'Happy to help.',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
          usage: {
            inputTokens: 10,
            outputTokens: 6,
            estimatedCostUsd: 0,
          },
        };
      },
    );

    const executor = new CleanTalkExecutor();
    const result = await executor.execute(
      {
        runId: 'run-channel-context-1',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-channel-trigger-1',
        triggerContent: 'Hey @Clawd can you help here?',
      },
      new AbortController().signal,
    );

    expect(result.content).toBe('Happy to help.');
    expect(fetchSlackRecentConversationContext).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: connection.id,
        targetId: 'slack:C-general',
        directMention: true,
        externalMessageId: '1710000000.000100',
        sourceThreadKey: '1710000000.000100',
      }),
    );
  });

  it('passes current-message attachments to direct agents as multimodal content', async () => {
    const now = new Date().toISOString();
    createTalkMessage({
      id: 'msg-user-attachments',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Compare the attached notes and screenshot.',
      createdBy: 'owner-1',
      createdAt: now,
    });

    const textStorageKey = await saveAttachmentFile(
      'att-text-1',
      TALK_ID,
      Buffer.from('Quarterly revenue grew 18%.'),
      'notes.txt',
    );
    createMessageAttachment({
      id: 'att-text-1',
      talkId: TALK_ID,
      fileName: 'notes.txt',
      fileSize: Buffer.byteLength('Quarterly revenue grew 18%.'),
      mimeType: 'text/plain',
      storageKey: textStorageKey,
      createdBy: 'owner-1',
    });
    expect(
      linkAttachmentToMessage('att-text-1', 'msg-user-attachments', TALK_ID),
    ).toBe(true);
    updateAttachmentExtraction({
      attachmentId: 'att-text-1',
      extractedText: 'Quarterly revenue grew 18%.',
      extractionStatus: 'ready',
    });

    const imageBytes = Buffer.from([137, 80, 78, 71]);
    const imageStorageKey = await saveAttachmentFile(
      'att-image-1',
      TALK_ID,
      imageBytes,
      'dashboard.png',
    );
    createMessageAttachment({
      id: 'att-image-1',
      talkId: TALK_ID,
      fileName: 'dashboard.png',
      fileSize: imageBytes.byteLength,
      mimeType: 'image/png',
      storageKey: imageStorageKey,
      createdBy: 'owner-1',
    });
    expect(
      linkAttachmentToMessage('att-image-1', 'msg-user-attachments', TALK_ID),
    ).toBe(true);
    updateAttachmentExtraction({
      attachmentId: 'att-image-1',
      extractedText: null,
      extractionStatus: 'ready',
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (agentId, context, userMessage) => {
        expect(context).not.toBeNull();
        expect(agentId).toBe('agent.main');
        expect(Array.isArray(userMessage)).toBe(true);
        const blocks = userMessage as Array<
          | { type: 'text'; text: string }
          | { type: 'image'; mimeType: string; data: string }
        >;
        expect(
          blocks.some(
            (block) =>
              block.type === 'text' &&
              block.text.includes('Current message attachments:'),
          ),
        ).toBe(true);
        expect(
          blocks.some(
            (block) =>
              block.type === 'text' &&
              block.text.includes('Quarterly revenue grew 18%.'),
          ),
        ).toBe(true);
        expect(
          blocks.some(
            (block) =>
              block.type === 'image' &&
              block.mimeType === 'image/png' &&
              block.data === imageBytes.toString('base64'),
          ),
        ).toBe(true);

        return {
          content: 'Compared both attachments.',
          agentId,
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
          usage: {
            inputTokens: 20,
            outputTokens: 10,
            estimatedCostUsd: 0,
          },
        };
      },
    );

    const executor = new CleanTalkExecutor();
    const result = await executor.execute(
      {
        runId: 'run-talk-attachments',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-attachments',
        triggerContent: 'Compare the attached notes and screenshot.',
      },
      new AbortController().signal,
    );

    expect(result.content).toBe('Compared both attachments.');
  });

  it('rehydrates prior user image attachments into direct-model history', async () => {
    createTalkMessage({
      id: 'msg-user-history-image',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'See the earlier dashboard screenshot.',
      createdBy: 'owner-1',
      createdAt: '2026-03-01T00:00:00.000Z',
    });
    const historyImageBytes = Buffer.from([137, 80, 78, 71, 1]);
    const historyImageStorageKey = await saveAttachmentFile(
      'att-history-image-1',
      TALK_ID,
      historyImageBytes,
      'earlier-dashboard.png',
    );
    createMessageAttachment({
      id: 'att-history-image-1',
      talkId: TALK_ID,
      fileName: 'earlier-dashboard.png',
      fileSize: historyImageBytes.byteLength,
      mimeType: 'image/png',
      storageKey: historyImageStorageKey,
      createdBy: 'owner-1',
    });
    expect(
      linkAttachmentToMessage(
        'att-history-image-1',
        'msg-user-history-image',
        TALK_ID,
      ),
    ).toBe(true);
    updateAttachmentExtraction({
      attachmentId: 'att-history-image-1',
      extractedText: null,
      extractionStatus: 'ready',
    });

    createTalkMessage({
      id: 'msg-user-followup-image',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'What stands out in the earlier screenshot?',
      createdBy: 'owner-1',
      createdAt: '2026-03-01T00:00:01.000Z',
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (agentId, context, userMessage) => {
        expect(agentId).toBe('agent.main');
        expect(userMessage).toBe('What stands out in the earlier screenshot?');
        expect(
          context?.history.some(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some(
                (block) =>
                  block.type === 'image' &&
                  block.mimeType === 'image/png' &&
                  block.data === historyImageBytes.toString('base64'),
              ),
          ),
        ).toBe(true);

        return {
          content: 'The trend line bends upward.',
          agentId,
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        };
      },
    );

    const executor = new CleanTalkExecutor();
    const result = await executor.execute(
      {
        runId: 'run-talk-history-image',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-followup-image',
        triggerContent: 'What stands out in the earlier screenshot?',
      },
      new AbortController().signal,
    );

    expect(result.content).toBe('The trend line bends upward.');
  });

  it('limits history image rehydration to the most recent image-bearing messages', async () => {
    const imageSpecs = [
      {
        messageId: 'msg-user-history-image-1',
        attachmentId: 'att-history-image-limit-1',
        fileName: 'oldest.png',
        content: 'Oldest screenshot.',
        createdAt: '2026-03-02T00:00:00.000Z',
        bytes: Buffer.from([137, 80, 78, 71, 1]),
      },
      {
        messageId: 'msg-user-history-image-2',
        attachmentId: 'att-history-image-limit-2',
        fileName: 'older.png',
        content: 'Older screenshot.',
        createdAt: '2026-03-02T00:00:01.000Z',
        bytes: Buffer.from([137, 80, 78, 71, 2]),
      },
      {
        messageId: 'msg-user-history-image-3',
        attachmentId: 'att-history-image-limit-3',
        fileName: 'newer.png',
        content: 'Newer screenshot.',
        createdAt: '2026-03-02T00:00:02.000Z',
        bytes: Buffer.from([137, 80, 78, 71, 3]),
      },
      {
        messageId: 'msg-user-history-image-4',
        attachmentId: 'att-history-image-limit-4',
        fileName: 'newest.png',
        content: 'Newest screenshot.',
        createdAt: '2026-03-02T00:00:03.000Z',
        bytes: Buffer.from([137, 80, 78, 71, 4]),
      },
    ] as const;

    for (const spec of imageSpecs) {
      createTalkMessage({
        id: spec.messageId,
        talkId: TALK_ID,
        threadId: THREAD_ID,
        role: 'user',
        content: spec.content,
        createdBy: 'owner-1',
        createdAt: spec.createdAt,
      });
      const storageKey = await saveAttachmentFile(
        spec.attachmentId,
        TALK_ID,
        spec.bytes,
        spec.fileName,
      );
      createMessageAttachment({
        id: spec.attachmentId,
        talkId: TALK_ID,
        fileName: spec.fileName,
        fileSize: spec.bytes.byteLength,
        mimeType: 'image/png',
        storageKey,
        createdBy: 'owner-1',
      });
      expect(
        linkAttachmentToMessage(spec.attachmentId, spec.messageId, TALK_ID),
      ).toBe(true);
      updateAttachmentExtraction({
        attachmentId: spec.attachmentId,
        extractedText: null,
        extractionStatus: 'ready',
      });
    }

    createTalkMessage({
      id: 'msg-user-history-image-limit-followup',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Compare the recent screenshots.',
      createdBy: 'owner-1',
      createdAt: '2026-03-02T00:00:04.000Z',
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (agentId, context, userMessage) => {
        expect(agentId).toBe('agent.main');
        expect(userMessage).toBe('Compare the recent screenshots.');

        const historyContents = (context?.history || []).map((message) =>
          typeof message.content === 'string'
            ? message.content
            : message.content
                .filter(
                  (
                    block,
                  ): block is Extract<
                    (typeof message.content)[number],
                    { type: 'text' }
                  > => block.type === 'text',
                )
                .map((block) => block.text)
                .join('\n'),
        );
        const historyImageBlocks = (context?.history || []).flatMap(
          (message) =>
            Array.isArray(message.content)
              ? message.content.filter(
                  (
                    block,
                  ): block is Extract<
                    (typeof message.content)[number],
                    { type: 'image' }
                  > => block.type === 'image',
                )
              : [],
        );

        expect(historyImageBlocks).toHaveLength(3);
        expect(
          historyImageBlocks.some(
            (block) => block.data === imageSpecs[0].bytes.toString('base64'),
          ),
        ).toBe(false);
        expect(
          historyImageBlocks.some(
            (block) => block.data === imageSpecs[1].bytes.toString('base64'),
          ),
        ).toBe(true);
        expect(
          historyImageBlocks.some(
            (block) => block.data === imageSpecs[2].bytes.toString('base64'),
          ),
        ).toBe(true);
        expect(
          historyImageBlocks.some(
            (block) => block.data === imageSpecs[3].bytes.toString('base64'),
          ),
        ).toBe(true);
        expect(
          historyContents.some(
            (text) =>
              text.includes('oldest.png') &&
              text.includes(
                'omitted from earlier conversation context due to prompt budget',
              ),
          ),
        ).toBe(true);

        return {
          content: 'Compared the recent screenshots.',
          agentId,
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        };
      },
    );

    await new CleanTalkExecutor().execute(
      {
        runId: 'run-talk-history-image-limit',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-history-image-limit-followup',
        triggerContent: 'Compare the recent screenshots.',
      },
      new AbortController().signal,
    );
  });

  it('budgets history text attachment excerpts toward the most recent messages', async () => {
    getDb()
      .prepare(
        `
        UPDATE llm_provider_models
        SET context_window_tokens = 8192
        WHERE provider_id = 'provider.anthropic' AND model_id = 'claude-sonnet-4-6'
      `,
      )
      .run();

    const textSpecs = [
      {
        messageId: 'msg-user-history-text-1',
        attachmentId: 'att-history-text-1',
        fileName: 'older.txt',
        content: 'Use the older note if needed.',
        createdAt: '2026-03-03T00:00:00.000Z',
        extractedText: 'OLDER-SEGMENT '.repeat(1400),
      },
      {
        messageId: 'msg-user-history-text-2',
        attachmentId: 'att-history-text-2',
        fileName: 'newer.txt',
        content: 'Use the newer note if needed.',
        createdAt: '2026-03-03T00:00:01.000Z',
        extractedText: 'NEWER-SEGMENT '.repeat(1400),
      },
    ] as const;

    for (const spec of textSpecs) {
      const fileBytes = Buffer.from(spec.extractedText, 'utf-8');
      createTalkMessage({
        id: spec.messageId,
        talkId: TALK_ID,
        threadId: THREAD_ID,
        role: 'user',
        content: spec.content,
        createdBy: 'owner-1',
        createdAt: spec.createdAt,
      });
      const storageKey = await saveAttachmentFile(
        spec.attachmentId,
        TALK_ID,
        fileBytes,
        spec.fileName,
      );
      createMessageAttachment({
        id: spec.attachmentId,
        talkId: TALK_ID,
        fileName: spec.fileName,
        fileSize: fileBytes.byteLength,
        mimeType: 'text/plain',
        storageKey,
        createdBy: 'owner-1',
      });
      expect(
        linkAttachmentToMessage(spec.attachmentId, spec.messageId, TALK_ID),
      ).toBe(true);
      updateAttachmentExtraction({
        attachmentId: spec.attachmentId,
        extractedText: spec.extractedText,
        extractionStatus: 'ready',
      });
    }

    createTalkMessage({
      id: 'msg-user-history-text-followup',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'What changed between the notes?',
      createdBy: 'owner-1',
      createdAt: '2026-03-03T00:00:02.000Z',
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, context) => {
        const historyContents = (context?.history || []).map((message) =>
          typeof message.content === 'string'
            ? message.content
            : message.content
                .filter(
                  (
                    block,
                  ): block is Extract<
                    (typeof message.content)[number],
                    { type: 'text' }
                  > => block.type === 'text',
                )
                .map((block) => block.text)
                .join('\n'),
        );

        const newerHistoryEntry =
          historyContents.find((text) => text.includes('newer.txt')) || '';
        const olderHistoryEntry =
          historyContents.find((text) => text.includes('older.txt')) || '';

        expect(newerHistoryEntry).toContain('NEWER-SEGMENT');
        expect(
          olderHistoryEntry.includes(
            'omitted from earlier conversation context due to prompt budget',
          ) || olderHistoryEntry.length === 0,
        ).toBe(true);
        expect(olderHistoryEntry).not.toContain('OLDER-SEGMENT');

        return {
          content: 'The newer note adds the latest changes.',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        };
      },
    );

    await new CleanTalkExecutor().execute(
      {
        runId: 'run-talk-history-text-budget',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-history-text-followup',
        triggerContent: 'What changed between the notes?',
      },
      new AbortController().signal,
    );
  });

  it('sanitizes image load failures before passing degradation notes to the model', async () => {
    createTalkMessage({
      id: 'msg-user-broken-image',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Describe the broken screenshot.',
      createdBy: 'owner-1',
      createdAt: '2026-03-04T00:00:00.000Z',
    });

    const imageBytes = Buffer.from([137, 80, 78, 71, 9]);
    const storageKey = await saveAttachmentFile(
      'att-broken-image',
      TALK_ID,
      imageBytes,
      'broken.png',
    );
    createMessageAttachment({
      id: 'att-broken-image',
      talkId: TALK_ID,
      fileName: 'broken.png',
      fileSize: imageBytes.byteLength,
      mimeType: 'image/png',
      storageKey,
      createdBy: 'owner-1',
    });
    expect(
      linkAttachmentToMessage(
        'att-broken-image',
        'msg-user-broken-image',
        TALK_ID,
      ),
    ).toBe(true);
    updateAttachmentExtraction({
      attachmentId: 'att-broken-image',
      extractedText: null,
      extractionStatus: 'ready',
    });

    const loadAttachmentSpy = vi
      .spyOn(attachmentStorage, 'loadAttachmentFile')
      .mockRejectedValueOnce(
        new Error('ENOENT: missing /private/tmp/secret/broken.png'),
      );

    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, _context, userMessage) => {
        const promptText =
          typeof userMessage === 'string'
            ? userMessage
            : userMessage
                .filter(
                  (
                    block,
                  ): block is Extract<
                    (typeof userMessage)[number],
                    { type: 'text' }
                  > => block.type === 'text',
                )
                .map((block) => block.text)
                .join('\n');
        expect(promptText).toContain(
          'Image attachment "broken.png" could not be loaded for vision input.',
        );
        expect(promptText).not.toContain('/private/tmp/secret/broken.png');

        return {
          content: 'The screenshot could not be loaded.',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        };
      },
    );

    await new CleanTalkExecutor().execute(
      {
        runId: 'run-talk-broken-image',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-broken-image',
        triggerContent: 'Describe the broken screenshot.',
      },
      new AbortController().signal,
    );

    loadAttachmentSpy.mockRestore();
  });

  it('rejects direct image-bearing turns for models without vision support', async () => {
    createTalkMessage({
      id: 'msg-user-text-only-image',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Analyze this screenshot.',
      createdBy: 'owner-1',
      createdAt: '2026-03-05T00:00:00.000Z',
    });

    const imageBytes = Buffer.from([137, 80, 78, 71, 10]);
    const storageKey = await saveAttachmentFile(
      'att-text-only-image',
      TALK_ID,
      imageBytes,
      'text-only.png',
    );
    createMessageAttachment({
      id: 'att-text-only-image',
      talkId: TALK_ID,
      fileName: 'text-only.png',
      fileSize: imageBytes.byteLength,
      mimeType: 'image/png',
      storageKey,
      createdBy: 'owner-1',
    });
    expect(
      linkAttachmentToMessage(
        'att-text-only-image',
        'msg-user-text-only-image',
        TALK_ID,
      ),
    ).toBe(true);
    updateAttachmentExtraction({
      attachmentId: 'att-text-only-image',
      extractedText: null,
      extractionStatus: 'ready',
    });

    getDb()
      .prepare(
        `
        UPDATE registered_agents
        SET provider_id = ?, model_id = ?
        WHERE id = ?
      `,
      )
      .run('provider.openai', 'gpt-text-only', 'agent.main');

    vi.mocked(planExecution).mockReturnValue({
      backend: 'direct_http',
      routeReason: 'normal',
      authPath: 'api_key',
      credentialSource: 'db_secret',
      effectiveTools: [],
      providerId: 'provider.openai',
      modelId: 'gpt-text-only',
      binding: {
        providerConfig: {
          providerId: 'provider.openai',
          baseUrl: 'https://api.openai.com/v1',
          apiFormat: 'openai_chat_completions',
          authScheme: 'bearer',
        },
        secret: { apiKey: 'sk-openai-test' },
      },
    });

    await expect(
      new CleanTalkExecutor().execute(
        {
          runId: 'run-talk-text-only-image',
          talkId: TALK_ID,
          threadId: THREAD_ID,
          requestedBy: 'owner-1',
          triggerMessageId: 'msg-user-text-only-image',
          triggerContent: 'Analyze this screenshot.',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'MODEL_VISION_UNSUPPORTED',
      message:
        'The selected model "gpt-text-only" does not support vision, but this message includes image attachments. Choose a vision-capable model or remove the images.',
    });
    expect(executeWithAgent).not.toHaveBeenCalled();
  });

  it('routes container-backed talk turns through the stateless adapter', async () => {
    createTalkMessage({
      id: 'msg-user-container',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Open the mounted project',
      createdBy: 'owner-1',
      createdAt: '2026-03-16T00:00:00.000Z',
    });
    getDb()
      .prepare(
        `
        UPDATE talks
        SET project_path = ?
        WHERE id = ?
      `,
      )
      .run('/tmp/talk-project', TALK_ID);
    getDb()
      .prepare(
        `
        UPDATE registered_agents
        SET system_prompt = ?,
            provider_id = ?,
            model_id = ?
        WHERE id = ?
      `,
      )
      .run(
        'Follow Talk execution rules.',
        'provider.anthropic',
        'claude-sonnet-4-6',
        'agent.main',
      );

    vi.mocked(planExecution).mockReturnValue({
      backend: 'container',
      routeReason: 'normal',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      effectiveTools: [
        {
          toolFamily: 'shell',
          runtimeTools: ['Bash'],
          enabled: true,
          requiresApproval: false,
        },
      ],
      heavyToolFamilies: ['shell'],
      containerCredential: {
        authMode: 'api_key',
        credentialSource: 'env',
        secrets: {
          ANTHROPIC_API_KEY: 'sk-container-test',
        },
      },
    });
    vi.mocked(resolveValidatedProjectMountPath).mockReturnValue(
      '/resolved/talk-project',
    );
    vi.mocked(executeContainerAgentTurn).mockResolvedValue({
      content: 'Container talk reply',
    });

    const events: TalkExecutionEvent[] = [];
    const executor = new CleanTalkExecutor();
    const result = await executor.execute(
      {
        runId: 'run-talk-container',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-container',
        triggerContent: 'Open the mounted project',
      },
      new AbortController().signal,
      (event) => events.push(event),
    );

    expect(resolveValidatedProjectMountPath).toHaveBeenCalledWith(
      '/tmp/talk-project',
      false,
    );
    expect(executeContainerAgentTurn).toHaveBeenCalledTimes(1);
    expect(executeContainerAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-talk-container',
        userId: 'owner-1',
        promptLabel: 'talk',
        userMessage: 'Open the mounted project',
        allowedTools: ['Bash'],
        talkId: TALK_ID,
        threadId: THREAD_ID,
        triggerMessageId: 'msg-user-container',
        projectMountHostPath: '/resolved/talk-project',
      }),
    );

    const containerInput = vi.mocked(executeContainerAgentTurn).mock
      .calls[0]![0];
    expect(containerInput.context.systemPrompt).toContain(
      'Follow Talk execution rules.',
    );
    expect(containerInput.context.history).toEqual([
      { role: 'user', content: 'Open the mounted project' },
    ]);
    expect(containerInput.historyMessageIds).toContain('msg-user-container');

    expect(result).toMatchObject({
      content: 'Container talk reply',
      agentId: 'agent.main',
      agentNickname: 'Nanoclaw',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      responseSequenceInRun: 1,
    });
    expect(JSON.parse(result.metadataJson!)).toMatchObject({
      runId: 'run-talk-container',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      responseGroupId: null,
      sequenceIndex: null,
    });
    expect(events.map((event) => event.type)).toEqual([
      'talk_response_started',
      'talk_response_completed',
    ]);
  });

  it('injects prior ordered outputs into later phases as attributed user context', async () => {
    createTalkMessage({
      id: 'msg-user-ordered',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Compare the go-to-market options.',
      createdBy: 'owner-1',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    createTalkRun({
      id: 'run-ordered-1',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'completed',
      trigger_message_id: 'msg-user-ordered',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-ordered',
      sequence_index: 0,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-01T00:00:00.100Z',
      started_at: '2024-01-01T00:00:00.100Z',
      ended_at: '2024-01-01T00:00:01.000Z',
      cancel_reason: null,
    });
    createTalkMessage({
      id: 'msg-assistant-ordered-1',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'assistant',
      content: 'Agent A thinks partnerships are the fastest path.',
      createdBy: null,
      runId: 'run-ordered-1',
      createdAt: '2024-01-01T00:00:01.000Z',
    });
    createTalkRun({
      id: 'run-ordered-2',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: 'msg-user-ordered',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-ordered',
      sequence_index: 1,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-01T00:00:01.100Z',
      started_at: '2024-01-01T00:00:01.100Z',
      ended_at: null,
      cancel_reason: null,
    });
    createTalkRun({
      id: 'run-ordered-3',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'queued',
      trigger_message_id: 'msg-user-ordered',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-ordered',
      sequence_index: 2,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-01T00:00:01.200Z',
      started_at: null,
      ended_at: null,
      cancel_reason: null,
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, context, userMessage) => {
        expect(context).not.toBeNull();
        expect(
          context!.history.some((message) =>
            typeof message.content === 'string'
              ? message.content.includes('partnerships are the fastest path')
              : false,
          ),
        ).toBe(false);
        expect(userMessage).toContain(
          'Original user request:\nCompare the go-to-market options.',
        );
        expect(userMessage).toContain(
          '[Nanoclaw]\nAgent A thinks partnerships are the fastest path.',
        );
        expect(userMessage).toContain(
          'Provide your own analysis from your role and perspective.',
        );
        expect(userMessage).not.toContain('Synthesize these perspectives.');

        return {
          content: 'Agent B prefers direct sales.',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        };
      },
    );

    const result = await new CleanTalkExecutor().execute(
      {
        runId: 'run-ordered-2',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-ordered',
        triggerContent: 'Compare the go-to-market options.',
        responseGroupId: 'group-ordered',
        sequenceIndex: 1,
      },
      new AbortController().signal,
    );

    expect(JSON.parse(result.metadataJson!)).toMatchObject({
      responseGroupId: 'group-ordered',
      sequenceIndex: 1,
    });
    expect(JSON.parse(result.metadataJson!)).not.toHaveProperty('isSynthesis');
  });

  it('tells later ordered agents when an earlier step failed even without prior completed outputs', async () => {
    createTalkMessage({
      id: 'msg-user-gap-only',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Evaluate this launch plan.',
      createdBy: 'owner-1',
      createdAt: '2024-01-01T00:01:00.000Z',
    });
    createTalkRun({
      id: 'run-gap-only-1',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'failed',
      trigger_message_id: 'msg-user-gap-only',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-gap-only',
      sequence_index: 0,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-01T00:01:00.100Z',
      started_at: '2024-01-01T00:01:00.100Z',
      ended_at: '2024-01-01T00:01:00.900Z',
      cancel_reason: 'incomplete_response: truncated',
    });
    createTalkRun({
      id: 'run-gap-only-2',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: 'msg-user-gap-only',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-gap-only',
      sequence_index: 1,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-01T00:01:01.000Z',
      started_at: '2024-01-01T00:01:01.000Z',
      ended_at: null,
      cancel_reason: null,
    });
    createTalkRun({
      id: 'run-gap-only-3',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'queued',
      trigger_message_id: 'msg-user-gap-only',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-gap-only',
      sequence_index: 2,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-01T00:01:01.100Z',
      started_at: null,
      ended_at: null,
      cancel_reason: null,
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, _context, userMessage) => {
        expect(userMessage).toContain(
          'Original user request:\nEvaluate this launch plan.',
        );
        expect(userMessage).not.toContain('Prior analyses from other agents:');
        expect(userMessage).toContain('Unavailable earlier ordered steps:');
        expect(userMessage).toContain(
          'failed to finish; its output is omitted.',
        );
        expect(userMessage).toContain(
          'Do not assume every earlier ordered step is represented if some analyses are marked unavailable.',
        );

        return {
          content: 'Proceed, but tighten the rollout controls.',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        };
      },
    );

    const result = await new CleanTalkExecutor().execute(
      {
        runId: 'run-gap-only-2',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-gap-only',
        triggerContent: 'Evaluate this launch plan.',
        responseGroupId: 'group-gap-only',
        sequenceIndex: 1,
      },
      new AbortController().signal,
    );

    expect(JSON.parse(result.metadataJson!)).toMatchObject({
      responseGroupId: 'group-gap-only',
      sequenceIndex: 1,
    });
    expect(JSON.parse(result.metadataJson!)).not.toHaveProperty('isSynthesis');
  });

  it('marks the final ordered phase as synthesis and injects synthesis instructions', async () => {
    createTalkMessage({
      id: 'msg-user-synth',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Recommend a pricing strategy.',
      createdBy: 'owner-1',
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    for (const [runId, sequenceIndex, content] of [
      ['run-synth-1', 0, 'Agent A recommends premium positioning.'],
      ['run-synth-2', 1, 'Agent B warns about market share risk.'],
    ] as const) {
      createTalkRun({
        id: runId,
        talk_id: TALK_ID,
        thread_id: THREAD_ID,
        requested_by: 'owner-1',
        status: 'completed',
        trigger_message_id: 'msg-user-synth',
        target_agent_id: 'agent.main',
        idempotency_key: null,
        response_group_id: 'group-synth',
        sequence_index: sequenceIndex,
        executor_alias: null,
        executor_model: null,
        source_binding_id: null,
        source_external_message_id: null,
        source_thread_key: null,
        created_at: `2024-01-01T00:00:0${sequenceIndex + 1}.000Z`,
        started_at: `2024-01-01T00:00:0${sequenceIndex + 1}.000Z`,
        ended_at: `2024-01-01T00:00:0${sequenceIndex + 1}.500Z`,
        cancel_reason: null,
      });
      createTalkMessage({
        id: `msg-${runId}`,
        talkId: TALK_ID,
        threadId: THREAD_ID,
        role: 'assistant',
        content,
        createdBy: null,
        runId,
        createdAt: `2024-01-01T00:00:0${sequenceIndex + 1}.500Z`,
      });
    }
    createTalkRun({
      id: 'run-synth-3',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: 'msg-user-synth',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-synth',
      sequence_index: 2,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-01T00:00:03.000Z',
      started_at: '2024-01-01T00:00:03.000Z',
      ended_at: null,
      cancel_reason: null,
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, _context, userMessage) => {
        expect(userMessage).toContain(
          '[Nanoclaw]\nAgent A recommends premium positioning.',
        );
        expect(userMessage).toContain(
          '[Nanoclaw]\nAgent B warns about market share risk.',
        );
        expect(userMessage).toContain('Synthesize these perspectives.');

        return {
          content: 'Synthesis: pursue premium entry pricing with guardrails.',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        };
      },
    );

    const result = await new CleanTalkExecutor().execute(
      {
        runId: 'run-synth-3',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-synth',
        triggerContent: 'Recommend a pricing strategy.',
        responseGroupId: 'group-synth',
        sequenceIndex: 2,
      },
      new AbortController().signal,
    );

    expect(JSON.parse(result.metadataJson!)).toMatchObject({
      responseGroupId: 'group-synth',
      sequenceIndex: 2,
      isSynthesis: true,
    });
  });

  it('coalesces multiple assistant messages from one prior run into a single attributed block', async () => {
    createTalkMessage({
      id: 'msg-user-multi-output',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Evaluate the trade-offs.',
      createdBy: 'owner-1',
      createdAt: '2024-01-02T00:00:00.000Z',
    });
    createTalkRun({
      id: 'run-multi-output-1',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'completed',
      trigger_message_id: 'msg-user-multi-output',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-multi-output',
      sequence_index: 0,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-02T00:00:00.100Z',
      started_at: '2024-01-02T00:00:00.100Z',
      ended_at: '2024-01-02T00:00:01.000Z',
      cancel_reason: null,
    });
    createTalkMessage({
      id: 'msg-multi-output-1a',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'assistant',
      content: 'First supporting point.',
      createdBy: null,
      runId: 'run-multi-output-1',
      sequenceInRun: 1,
      createdAt: '2024-01-02T00:00:00.500Z',
    });
    createTalkMessage({
      id: 'msg-multi-output-1b',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'assistant',
      content: 'Second supporting point.',
      createdBy: null,
      runId: 'run-multi-output-1',
      sequenceInRun: 2,
      createdAt: '2024-01-02T00:00:00.700Z',
    });
    createTalkRun({
      id: 'run-multi-output-2',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: 'msg-user-multi-output',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-multi-output',
      sequence_index: 1,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-02T00:00:01.100Z',
      started_at: '2024-01-02T00:00:01.100Z',
      ended_at: null,
      cancel_reason: null,
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, _context, userMessage) => {
        const promptText =
          typeof userMessage === 'string'
            ? userMessage
            : userMessage
                .filter(
                  (
                    block,
                  ): block is Extract<
                    (typeof userMessage)[number],
                    { type: 'text' }
                  > => block.type === 'text',
                )
                .map((block) => block.text)
                .join('\n');
        expect(promptText).toContain(
          '[Nanoclaw]\nFirst supporting point.\n\nSecond supporting point.',
        );
        expect(promptText.match(/\[Nanoclaw\]/g)).toHaveLength(1);

        return {
          content: 'Independent second-pass analysis.',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        };
      },
    );

    await new CleanTalkExecutor().execute(
      {
        runId: 'run-multi-output-2',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-multi-output',
        triggerContent: 'Evaluate the trade-offs.',
        responseGroupId: 'group-multi-output',
        sequenceIndex: 1,
      },
      new AbortController().signal,
    );
  });

  it('caps injected prior outputs to the remaining prompt budget', async () => {
    getDb()
      .prepare(
        `
        UPDATE llm_provider_models
        SET context_window_tokens = 4096
        WHERE provider_id = 'provider.anthropic' AND model_id = 'claude-sonnet-4-6'
      `,
      )
      .run();

    createTalkMessage({
      id: 'msg-user-budgeted',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Recommend a launch plan.',
      createdBy: 'owner-1',
      createdAt: '2024-01-03T00:00:00.000Z',
    });
    createTalkRun({
      id: 'run-budgeted-1',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'completed',
      trigger_message_id: 'msg-user-budgeted',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-budgeted',
      sequence_index: 0,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-03T00:00:00.100Z',
      started_at: '2024-01-03T00:00:00.100Z',
      ended_at: '2024-01-03T00:00:01.000Z',
      cancel_reason: null,
    });
    createTalkMessage({
      id: 'msg-budgeted-1',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'assistant',
      content: 'A'.repeat(8000),
      createdBy: null,
      runId: 'run-budgeted-1',
      createdAt: '2024-01-03T00:00:01.000Z',
    });
    createTalkRun({
      id: 'run-budgeted-2',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: 'msg-user-budgeted',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-budgeted',
      sequence_index: 1,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-03T00:00:01.100Z',
      started_at: '2024-01-03T00:00:01.100Z',
      ended_at: null,
      cancel_reason: null,
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, _context, userMessage) => {
        expect(userMessage.length).toBeLessThan(3500);
        expect(userMessage).toContain('[truncated for context window]');

        return {
          content: 'Budget-aware analysis.',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        };
      },
    );

    await new CleanTalkExecutor().execute(
      {
        runId: 'run-budgeted-2',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-budgeted',
        triggerContent: 'Recommend a launch plan.',
        responseGroupId: 'group-budgeted',
        sequenceIndex: 1,
      },
      new AbortController().signal,
    );
  });

  it('executes Talk output tools for direct runs', async () => {
    const now = new Date().toISOString();
    createTalkRun({
      id: 'run-output-tools',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: null,
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: null,
      sequence_index: null,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: now,
      started_at: now,
      ended_at: null,
      cancel_reason: null,
    });

    const executeTool = buildToolExecutor(
      TALK_ID,
      'owner-1',
      'run-output-tools',
      new AbortController().signal,
    );

    const created = await executeTool('write_output', {
      expectedVersion: 0,
      title: 'Draft Memo',
      contentMarkdown: 'Initial content',
    });
    expect(created.isError).toBeUndefined();
    const createdOutput = JSON.parse(created.result) as {
      id: string;
      version: number;
    };

    const listed = await executeTool('list_outputs', {});
    expect(JSON.parse(listed.result)).toMatchObject({
      outputs: [
        expect.objectContaining({
          id: createdOutput.id,
          title: 'Draft Memo',
          version: 1,
        }),
      ],
    });

    const updated = await executeTool('write_output', {
      outputId: createdOutput.id,
      expectedVersion: createdOutput.version,
      contentMarkdown: 'Revised content',
    });
    expect(updated.isError).toBeUndefined();
    expect(JSON.parse(updated.result)).toMatchObject({
      id: createdOutput.id,
      contentMarkdown: 'Revised content',
      version: 2,
      updatedByRunId: 'run-output-tools',
    });
  });

  it('rejects restricted job tools while keeping read-only output access', async () => {
    const output = createTalkOutput({
      talkId: TALK_ID,
      title: 'Weekly Brief',
      contentMarkdown: '# Hello',
      createdByUserId: 'owner-1',
    });

    const executeTool = buildToolExecutor(
      TALK_ID,
      'owner-1',
      'run-job-tools',
      new AbortController().signal,
      {
        jobId: 'job-1',
        allowedConnectorIds: [],
        allowedChannelBindingIds: [],
        allowWeb: false,
        allowStateMutation: false,
        allowOutputWrite: false,
      },
    );

    const listed = await executeTool('list_outputs', {});
    expect(listed.isError).toBeUndefined();
    expect(listed.result).toContain(output.id);

    const read = await executeTool('read_output', { outputId: output.id });
    expect(read.isError).toBeUndefined();
    expect(read.result).toContain('# Hello');

    const write = await executeTool('write_output', {
      outputId: output.id,
      expectedVersion: 1,
      contentMarkdown: 'Updated',
    });
    expect(write.isError).toBe(true);
    expect(write.result).toContain('not available for scheduled job runs');

    const stateUpdate = await executeTool('update_state', {
      key: 'focus',
      value: { ok: true },
      expectedVersion: 0,
    });
    expect(stateUpdate.isError).toBe(true);
    expect(stateUpdate.result).toContain('update_state is not available');

    const stateDelete = await executeTool('delete_state', {
      key: 'focus',
      expectedVersion: 1,
    });
    expect(stateDelete.isError).toBe(true);
    expect(stateDelete.result).toContain('delete_state is not available');

    const webSearch = await executeTool('web_search', {
      query: 'cal football',
    });
    expect(webSearch.isError).toBe(true);
    expect(webSearch.result).toContain('web_search is not available');
  });

  describe('read_state tool', () => {
    function makeExecutor() {
      const now = new Date().toISOString();
      createTalkRun({
        id: 'run-read-state',
        talk_id: TALK_ID,
        thread_id: THREAD_ID,
        requested_by: 'owner-1',
        status: 'running',
        trigger_message_id: null,
        target_agent_id: null,
        idempotency_key: null,
        response_group_id: null,
        sequence_index: null,
        executor_alias: null,
        executor_model: null,
        source_binding_id: null,
        source_external_message_id: null,
        source_thread_key: null,
        created_at: now,
        started_at: now,
        ended_at: null,
        cancel_reason: null,
      });
      return buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-read-state',
        new AbortController().signal,
      );
    }

    it('returns an existing state entry', async () => {
      const { upsertTalkStateEntry } =
        await import('../db/context-accessors.js');
      upsertTalkStateEntry({
        talkId: TALK_ID,
        key: 'read_me',
        value: { data: 42 },
        expectedVersion: 0,
      });
      const exec = makeExecutor();
      const result = await exec('read_state', { key: 'read_me' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.key).toBe('read_me');
      expect(parsed.value).toEqual({ data: 42 });
    });

    it('returns isError for missing key', async () => {
      const exec = makeExecutor();
      const result = await exec('read_state', { key: 'nonexistent' });
      expect(result.isError).toBe(true);
      expect(result.result).toContain('does not exist');
    });

    it('returns isError for empty key', async () => {
      const exec = makeExecutor();
      const result = await exec('read_state', { key: '' });
      expect(result.isError).toBe(true);
    });

    it('returns isError for invalid key pattern', async () => {
      const exec = makeExecutor();
      const result = await exec('read_state', { key: 'has spaces' });
      expect(result.isError).toBe(true);
      expect(result.result).toContain('must contain only');
    });
  });

  describe('delete_state tool', () => {
    function makeExecutor() {
      const now = new Date().toISOString();
      createTalkRun({
        id: 'run-del-state',
        talk_id: TALK_ID,
        thread_id: THREAD_ID,
        requested_by: 'owner-1',
        status: 'running',
        trigger_message_id: null,
        target_agent_id: null,
        idempotency_key: null,
        response_group_id: null,
        sequence_index: null,
        executor_alias: null,
        executor_model: null,
        source_binding_id: null,
        source_external_message_id: null,
        source_thread_key: null,
        created_at: now,
        started_at: now,
        ended_at: null,
        cancel_reason: null,
      });
      return buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-del-state',
        new AbortController().signal,
      );
    }

    it('deletes an entry with matching version', async () => {
      const { upsertTalkStateEntry } =
        await import('../db/context-accessors.js');
      upsertTalkStateEntry({
        talkId: TALK_ID,
        key: 'del_me',
        value: 'temp',
        expectedVersion: 0,
      });
      const exec = makeExecutor();
      const result = await exec('delete_state', {
        key: 'del_me',
        expectedVersion: 1,
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.deleted).toBe(true);
    });

    it('returns conflict on version mismatch', async () => {
      const { upsertTalkStateEntry } =
        await import('../db/context-accessors.js');
      upsertTalkStateEntry({
        talkId: TALK_ID,
        key: 'conflict_key',
        value: 'v1',
        expectedVersion: 0,
      });
      upsertTalkStateEntry({
        talkId: TALK_ID,
        key: 'conflict_key',
        value: 'v2',
        expectedVersion: 1,
      });
      const exec = makeExecutor();
      const result = await exec('delete_state', {
        key: 'conflict_key',
        expectedVersion: 1,
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.result);
      expect(parsed.conflict).toBe(true);
    });
  });

  describe('update_state tool limits', () => {
    function makeExecutor() {
      const now = new Date().toISOString();
      createTalkRun({
        id: 'run-state-limits',
        talk_id: TALK_ID,
        thread_id: THREAD_ID,
        requested_by: 'owner-1',
        status: 'running',
        trigger_message_id: null,
        target_agent_id: null,
        idempotency_key: null,
        response_group_id: null,
        sequence_index: null,
        executor_alias: null,
        executor_model: null,
        source_binding_id: null,
        source_external_message_id: null,
        source_thread_key: null,
        created_at: now,
        started_at: now,
        ended_at: null,
        cancel_reason: null,
      });
      return buildToolExecutor(
        TALK_ID,
        'owner-1',
        'run-state-limits',
        new AbortController().signal,
      );
    }

    it('returns error for key exceeding length limit', async () => {
      const exec = makeExecutor();
      const longKey = 'a'.repeat(81);
      const result = await exec('update_state', {
        key: longKey,
        value: 'test',
        expectedVersion: 0,
      });
      expect(result.isError).toBe(true);
      expect(result.result).toContain('character limit');
    });

    it('returns error for value exceeding size limit', async () => {
      const exec = makeExecutor();
      const result = await exec('update_state', {
        key: 'big',
        value: 'x'.repeat(21000),
        expectedVersion: 0,
      });
      expect(result.isError).toBe(true);
      expect(result.result).toContain('20 KB');
    });

    it('returns error for invalid key pattern', async () => {
      const exec = makeExecutor();
      const result = await exec('update_state', {
        key: 'has spaces',
        value: 'ok',
        expectedVersion: 0,
      });
      expect(result.isError).toBe(true);
      expect(result.result).toContain('must contain only');
    });
  });
});
