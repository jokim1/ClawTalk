import { describe, it, expect, beforeEach } from 'vitest';

import { getDb } from './db.js';
import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  isDatabaseHealthy,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';
import {
  _initClawrocketTestSchema,
  appendAssistantMessageWithOutbox,
  appendRuntimeTalkMessage,
  appendOutboxEvent,
  canUserEditTalk,
  claimNextChannelDeliveryRow,
  cancelTalkRunsAtomic,
  completeRunAndPromoteNextAtomic,
  consumeOAuthStateByHash,
  createTalkChannelBinding,
  createTalkThread,
  createOAuthState,
  createTalk,
  createTalkMessage,
  createTalkRun,
  deleteMainMessagesAtomic,
  deleteMainThread,
  deleteTalkMessagesAtomic,
  enqueueChannelTurnAtomic,
  enqueueMainTurnAtomic,
  enqueueTalkTurnAtomic as enqueueTalkTurnAtomicRaw,
  ensureSystemManagedTelegramConnection,
  failInterruptedRunsOnStartup,
  failRunAndPromoteNextAtomic,
  deleteTalkThread,
  deleteTalkExecutorSession,
  getIdempotencyCache,
  getOutboxEventsForTopics,
  getQueuedTalkRuns,
  getRunningTalkRun,
  getSettingValue,
  getTalkById,
  getTalkExecutorSession,
  getTalkForUser,
  getTalkLlmPolicyByTalkId,
  getTalkRunById,
  getOrCreateDefaultThread,
  hasActiveTalkRuns,
  searchChannelTargets,
  getUserById,
  listTalkMessages,
  listTalkThreads,
  listTalksForUser,
  MainThreadBusyError,
  markTalkRunStatus,
  normalizeTalkListPage,
  pruneEventOutbox,
  pruneIdempotencyCache,
  patchTalkMetadata,
  saveIdempotencyCache,
  setTalkRunExecutorProfile,
  upsertSettingValue,
  updateTalkProjectPath,
  updateTalkThreadMetadata,
  ThreadDeleteConflictError,
  upsertTalk,
  upsertChannelTarget,
  upsertChannelConnection,
  upsertTalkExecutorSession,
  upsertTalkLlmPolicy,
  upsertTalkMember,
  upsertUser,
  upsertWebSession,
} from './clawrocket/db/index.js';
import {
  buildDefaultTalkToolPermissions,
  createRegisteredAgent,
  deleteRegisteredAgent,
} from './clawrocket/db/agent-accessors.js';

function enqueueTalkTurnAtomic(input: {
  talkId: string;
  threadId?: string | null;
  userId: string;
  content: string;
  messageId: string;
  runId: string;
  targetAgentId?: string;
  idempotencyKey?: string | null;
  now?: string;
}) {
  const result = enqueueTalkTurnAtomicRaw({
    talkId: input.talkId,
    threadId: input.threadId,
    userId: input.userId,
    content: input.content,
    messageId: input.messageId,
    runIds: [input.runId],
    targetAgentIds: [input.targetAgentId || 'agent-default'],
    idempotencyKey: input.idempotencyKey,
    now: input.now,
  });
  return {
    ...result,
    run: result.runs[0],
  };
}

beforeEach(() => {
  _initTestDatabase();
  _initClawrocketTestSchema();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

const TALK_THREAD_ID = 'thread-talk-1';

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

describe('phase 0 schema and reliability tables', () => {
  beforeEach(() => {
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertUser({
      id: 'member-1',
      email: 'member@example.com',
      displayName: 'Member',
      role: 'member',
    });

    // Create a default registered agent
    const agent = createRegisteredAgent({
      name: 'Claude Opus 4.6',
      providerId: 'provider.anthropic',
      modelId: 'claude-opus-4-6',
      toolPermissionsJson: '{}',
    });

    upsertTalk({
      id: 'talk-1',
      ownerId: 'owner-1',
      topicTitle: 'Test Talk',
    });
    getDb()
      .prepare(
        `
      INSERT INTO talk_agents (id, talk_id, registered_agent_id, is_primary, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, 1, 0, datetime('now'), datetime('now'))
    `,
      )
      .run('ta-talk-1', 'talk-1', agent.id);

    upsertTalkMember({
      talkId: 'talk-1',
      userId: 'member-1',
      role: 'editor',
    });
  });

  it('creates and reads users and sessions', () => {
    upsertWebSession({
      id: 'session-1',
      userId: 'owner-1',
      accessTokenHash: 'hash-a',
      refreshTokenHash: 'hash-r',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const owner = getUserById('owner-1');
    expect(owner?.role).toBe('owner');
    expect(isDatabaseHealthy()).toBe(true);
  });

  it('defaults newly created agents to the Talk-safe tool profile', () => {
    const agent = createRegisteredAgent({
      name: 'Claude Sonnet Persona',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
    });

    expect(JSON.parse(agent.tool_permissions_json)).toEqual(
      buildDefaultTalkToolPermissions(),
    );
  });

  it('removes talk assignments when a registered agent is deleted', () => {
    const agent = createRegisteredAgent({
      name: 'Disposable Persona',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
    });

    getDb()
      .prepare(
        `
      INSERT INTO talk_agents (id, talk_id, registered_agent_id, is_primary, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, 1, 0, datetime('now'), datetime('now'))
    `,
      )
      .run('ta-disposable', 'talk-1', agent.id);

    expect(deleteRegisteredAgent(agent.id)).toBe(true);

    const assignmentCount = getDb()
      .prepare(
        `SELECT COUNT(*) as count FROM talk_agents WHERE talk_id = ? AND registered_agent_id = ?`,
      )
      .get('talk-1', agent.id) as { count: number };
    expect(assignmentCount.count).toBe(0);
  });

  it('defaults talks to ordered orchestration and allows metadata updates to panel', () => {
    expect(getTalkById('talk-1')?.orchestration_mode).toBe('ordered');
    expect(getTalkById('talk-1')?.project_path).toBeNull();

    patchTalkMetadata({
      talkId: 'talk-1',
      ownerId: 'owner-1',
      orchestrationMode: 'panel',
    });

    expect(getTalkById('talk-1')?.orchestration_mode).toBe('panel');
  });

  it('stores a talk project path separately from generic metadata patching', () => {
    updateTalkProjectPath({
      talkId: 'talk-1',
      ownerId: 'owner-1',
      projectPath: '/tmp/project-one',
    });

    expect(getTalkById('talk-1')?.project_path).toBe('/tmp/project-one');

    patchTalkMetadata({
      talkId: 'talk-1',
      ownerId: 'owner-1',
      title: 'Renamed Talk',
    });

    expect(getTalkById('talk-1')?.topic_title).toBe('Renamed Talk');
    expect(getTalkById('talk-1')?.project_path).toBe('/tmp/project-one');
  });

  it('reads and writes settings_kv values through accessors', () => {
    expect(getSettingValue('executor.mainProjectPath')).toBeNull();

    upsertSettingValue({
      key: 'executor.mainProjectPath',
      value: '/tmp/main-project',
      updatedBy: 'owner-1',
    });

    expect(getSettingValue('executor.mainProjectPath')).toBe(
      '/tmp/main-project',
    );
  });

  it('backfills legacy null thread ids and rebuilds talk tables with NOT NULL thread columns', () => {
    upsertTalk({
      id: 'talk-legacy',
      ownerId: 'owner-1',
      topicTitle: 'Legacy Talk',
    });

    const db = getDb();
    db.exec(`
      DROP TABLE IF EXISTS talk_runs;
      DROP TABLE IF EXISTS talk_messages;
      DROP TABLE IF EXISTS talk_threads;

      CREATE TABLE talk_messages (
        id TEXT PRIMARY KEY,
        talk_id TEXT REFERENCES talks(id) ON DELETE CASCADE,
        thread_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT NOT NULL,
        agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
        run_id TEXT,
        sequence_in_run INTEGER,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE TABLE talk_runs (
        id TEXT PRIMARY KEY,
        talk_id TEXT REFERENCES talks(id) ON DELETE CASCADE,
        requested_by TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL
          CHECK(status IN ('queued', 'running', 'awaiting_confirmation', 'cancelled', 'completed', 'failed')),
        trigger_message_id TEXT REFERENCES talk_messages(id),
        target_agent_id TEXT,
        agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
        executor_alias TEXT,
        executor_model TEXT,
        thread_id TEXT,
        idempotency_key TEXT,
        source_binding_id TEXT,
        source_external_message_id TEXT,
        source_thread_key TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        cancel_reason TEXT
      );
    `);

    db.prepare(
      `
        INSERT INTO talk_messages (
          id, talk_id, thread_id, role, content, created_by, created_at
        ) VALUES (?, ?, NULL, 'user', ?, ?, ?)
      `,
    ).run(
      'legacy-msg-1',
      'talk-legacy',
      'legacy content',
      'owner-1',
      '2024-01-01T00:00:00.000Z',
    );
    db.prepare(
      `
        INSERT INTO talk_runs (
          id, talk_id, requested_by, status, trigger_message_id, thread_id, created_at
        ) VALUES (?, ?, ?, 'queued', ?, NULL, ?)
      `,
    ).run(
      'legacy-run-1',
      'talk-legacy',
      'owner-1',
      'legacy-msg-1',
      '2024-01-01T00:00:01.000Z',
    );

    _initClawrocketTestSchema();

    const talkMessageThreadColumn = (
      db.prepare(`PRAGMA table_info(talk_messages)`).all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((column) => column.name === 'thread_id');
    const talkRunThreadColumn = (
      db.prepare(`PRAGMA table_info(talk_runs)`).all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((column) => column.name === 'thread_id');

    expect(talkMessageThreadColumn?.notnull).toBe(1);
    expect(talkRunThreadColumn?.notnull).toBe(1);

    const migratedMessage = db
      .prepare(`SELECT thread_id FROM talk_messages WHERE id = ?`)
      .get('legacy-msg-1') as { thread_id: string };
    const migratedRun = db
      .prepare(`SELECT thread_id FROM talk_runs WHERE id = ?`)
      .get('legacy-run-1') as { thread_id: string };
    const talkThreadCount = db
      .prepare(`SELECT COUNT(*) AS count FROM talk_threads WHERE talk_id = ?`)
      .get('talk-legacy') as { count: number };

    expect(migratedMessage.thread_id).toBeTruthy();
    expect(migratedRun.thread_id).toBe(migratedMessage.thread_id);
    expect(talkThreadCount.count).toBeGreaterThan(0);
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM talk_messages WHERE thread_id IS NULL`,
          )
          .get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM talk_runs WHERE thread_id IS NULL`,
          )
          .get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });

  it('stores and replays outbox events', () => {
    const eventId = appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'message_appended',
      payload: JSON.stringify({ messageId: 'm1' }),
    });
    expect(eventId).toBeGreaterThan(0);

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('message_appended');
  });

  it('consumes oauth state only once', () => {
    createOAuthState({
      id: 'oauth-1',
      provider: 'google',
      stateHash: 'state-hash-1',
      nonceHash: 'nonce-hash-1',
      codeVerifierHash: 'verifier-hash-1',
      redirectUri: 'http://127.0.0.1:3210/api/v1/auth/google/callback',
      returnTo: '/app/talks/talk-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const first = consumeOAuthStateByHash('state-hash-1');
    expect(first?.id).toBe('oauth-1');
    expect(first?.return_to).toBe('/app/talks/talk-1');
    expect(first?.used_at).toBeTruthy();

    const second = consumeOAuthStateByHash('state-hash-1');
    expect(second).toBeUndefined();
  });

  it('stores and reads talk policy by talk id', () => {
    expect(getTalkLlmPolicyByTalkId('talk-1')).toBeNull();

    upsertTalkLlmPolicy({
      talkId: 'talk-1',
      llmPolicy: '{"agents":["Gemini","Opus4.6"]}',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    expect(getTalkLlmPolicyByTalkId('talk-1')).toBe(
      '{"agents":["Gemini","Opus4.6"]}',
    );
  });

  it('upserts and deletes talk executor sessions', () => {
    expect(getTalkExecutorSession('talk-1')).toBeUndefined();

    upsertTalkExecutorSession({
      talkId: 'talk-1',
      sessionId: 'session-1',
      executorAlias: 'Gemini',
      executorModel: 'default',
      sessionCompatKey: 'Gemini:default',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    upsertTalkExecutorSession({
      talkId: 'talk-1',
      sessionId: 'session-2',
      executorAlias: 'Opus4.6',
      executorModel: 'default',
      sessionCompatKey: 'Opus4.6:default',
      updatedAt: '2024-01-01T00:00:01.000Z',
    });

    const session = getTalkExecutorSession('talk-1');
    expect(session).toBeDefined();
    expect(session?.session_id).toBe('session-2');
    expect(session?.executor_alias).toBe('Opus4.6');
    expect(session?.executor_model).toBe('default');
    expect(session?.session_compat_key).toBe('Opus4.6:default');
    expect(session?.updated_at).toBe('2024-01-01T00:00:01.000Z');

    deleteTalkExecutorSession('talk-1');
    expect(getTalkExecutorSession('talk-1')).toBeUndefined();
  });

  it('does not change talk owner when upserting existing talk id', () => {
    upsertUser({
      id: 'owner-2',
      email: 'owner2@example.com',
      displayName: 'Owner 2',
      role: 'member',
    });

    expect(canUserEditTalk('talk-1', 'owner-1')).toBe(true);
    expect(canUserEditTalk('talk-1', 'owner-2')).toBe(false);

    upsertTalk({
      id: 'talk-1',
      ownerId: 'owner-2',
      topicTitle: 'Updated title',
    });

    expect(canUserEditTalk('talk-1', 'owner-1')).toBe(true);
    expect(canUserEditTalk('talk-1', 'owner-2')).toBe(false);
  });

  it('creates talk rows and resolves talk access for shared members', () => {
    createTalk({
      id: 'talk-2',
      ownerId: 'owner-1',
      topicTitle: 'Shared',
    });
    upsertTalkMember({
      talkId: 'talk-2',
      userId: 'member-1',
      role: 'viewer',
    });

    const talk = getTalkById('talk-2');
    expect(talk?.topic_title).toBe('Shared');

    const defaultThreads = getDb()
      .prepare(
        `
            SELECT id, is_default
            FROM talk_threads
            WHERE talk_id = ?
            ORDER BY created_at ASC
          `,
      )
      .all('talk-2') as Array<{ id: string; is_default: number }>;
    expect(defaultThreads).toHaveLength(1);
    expect(defaultThreads[0]?.id).toMatch(/^thread_/);
    expect(defaultThreads[0]?.is_default).toBe(1);

    const ownerView = getTalkForUser('talk-2', 'owner-1');
    expect(ownerView?.access_role).toBe('owner');

    const memberView = getTalkForUser('talk-2', 'member-1');
    expect(memberView?.access_role).toBe('viewer');

    const memberList = listTalksForUser({ userId: 'member-1' });
    expect(memberList.some((entry) => entry.id === 'talk-2')).toBe(true);
  });

  it('stores and paginates talk messages', () => {
    createTalkMessage({
      id: 'tm-1',
      talkId: 'talk-1',
      threadId: TALK_THREAD_ID,
      role: 'user',
      content: 'hello',
      createdBy: 'owner-1',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    createTalkMessage({
      id: 'tm-2',
      talkId: 'talk-1',
      threadId: TALK_THREAD_ID,
      role: 'assistant',
      content: 'world',
      createdBy: null,
      createdAt: '2024-01-01T00:00:01.000Z',
    });

    const all = listTalkMessages({ talkId: 'talk-1', limit: 10 });
    expect(all.map((message) => message.id)).toEqual(['tm-1', 'tm-2']);

    const before = listTalkMessages({
      talkId: 'talk-1',
      limit: 10,
      beforeCreatedAt: '2024-01-01T00:00:01.000Z',
    });
    expect(before.map((message) => message.id)).toEqual(['tm-1']);
  });

  it('deletes selected talk messages, clears executor session, and emits a history-edited event', () => {
    upsertTalkExecutorSession({
      talkId: 'talk-1',
      sessionId: 'session-edit-1',
      executorAlias: 'Claude',
      executorModel: 'claude-sonnet-4-6',
      sessionCompatKey: 'Claude:claude-sonnet-4-6',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    createTalkMessage({
      id: 'tm-edit-1',
      talkId: 'talk-1',
      threadId: TALK_THREAD_ID,
      role: 'user',
      content: 'old question',
      createdBy: 'owner-1',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    createTalkMessage({
      id: 'tm-edit-2',
      talkId: 'talk-1',
      threadId: TALK_THREAD_ID,
      role: 'assistant',
      content: 'old answer',
      createdAt: '2024-01-01T00:00:01.000Z',
    });
    createTalkRun({
      id: 'run-edit-history-1',
      talk_id: 'talk-1',
      thread_id: TALK_THREAD_ID,
      requested_by: 'owner-1',
      status: 'completed',
      trigger_message_id: 'tm-edit-1',
      target_agent_id: null,
      idempotency_key: null,
      executor_alias: 'Claude',
      executor_model: 'claude-sonnet-4-6',
      created_at: '2024-01-01T00:00:00.500Z',
      started_at: '2024-01-01T00:00:00.500Z',
      ended_at: '2024-01-01T00:00:01.500Z',
      cancel_reason: null,
    });
    createTalkMessage({
      id: 'tm-edit-3',
      talkId: 'talk-1',
      threadId: TALK_THREAD_ID,
      role: 'user',
      content: 'keep me',
      createdBy: 'owner-1',
      createdAt: '2024-01-01T00:00:02.000Z',
    });

    const result = deleteTalkMessagesAtomic({
      talkId: 'talk-1',
      messageIds: ['tm-edit-1', 'tm-edit-2'],
      threadId: TALK_THREAD_ID,
      now: '2024-01-01T00:00:03.000Z',
    });

    expect(result).toEqual({
      deletedCount: 2,
      deletedMessageIds: ['tm-edit-1', 'tm-edit-2'],
    });
    expect(
      listTalkMessages({ talkId: 'talk-1', limit: 10 }).map(
        (message) => message.id,
      ),
    ).toEqual(['tm-edit-3']);
    expect(getTalkRunById('run-edit-history-1')?.trigger_message_id).toBeNull();
    expect(getTalkExecutorSession('talk-1')).toBeUndefined();

    const historyEvent = getOutboxEventsForTopics(['talk:talk-1'], 0, 20).find(
      (event) => event.event_type === 'talk_history_edited',
    );
    expect(historyEvent).toBeDefined();
    expect(JSON.parse(historyEvent!.payload)).toMatchObject({
      talkId: 'talk-1',
      threadIds: [TALK_THREAD_ID],
      deletedCount: 2,
      deletedMessageIds: ['tm-edit-1', 'tm-edit-2'],
      editedAt: '2024-01-01T00:00:03.000Z',
    });
  });

  it('rejects main history edits that would orphan the thread from every user message', () => {
    const threadId = 'main-thread-edit-1';
    const messageId = 'main-msg-user-1';
    const runId = 'main-run-1';

    enqueueMainTurnAtomic({
      threadId,
      userId: 'owner-1',
      content: 'Original main prompt',
      messageId,
      runId,
    });
    getDb()
      .prepare(
        `
        UPDATE talk_runs
        SET status = 'completed', ended_at = '2024-01-01T00:00:01.000Z'
        WHERE id = ?
      `,
      )
      .run(runId);
    getDb()
      .prepare(
        `
        INSERT INTO talk_messages (
          id, talk_id, thread_id, role, content, created_by, created_at
        ) VALUES (?, NULL, ?, 'assistant', ?, NULL, ?)
      `,
      )
      .run(
        'main-msg-assistant-1',
        threadId,
        'Reply that should not become orphaned',
        '2024-01-01T00:00:02.000Z',
      );

    expect(() =>
      deleteMainMessagesAtomic({
        threadId,
        userId: 'owner-1',
        messageIds: [messageId],
      }),
    ).toThrow(/retain at least one user message/i);
  });

  it('deletes selected main messages even when historical runs reference the deleted prompt', () => {
    const threadId = 'main-thread-edit-2';
    const messageId = 'main-msg-user-2';
    const runId = 'main-run-2';

    enqueueMainTurnAtomic({
      threadId,
      userId: 'owner-1',
      content: 'Remove this old main prompt',
      messageId,
      runId,
    });
    getDb()
      .prepare(
        `
        UPDATE talk_runs
        SET status = 'completed', ended_at = '2024-01-01T00:00:01.000Z'
        WHERE id = ?
      `,
      )
      .run(runId);
    getDb()
      .prepare(
        `
        INSERT INTO talk_messages (
          id, talk_id, thread_id, role, content, created_by, created_at
        ) VALUES (?, NULL, ?, 'assistant', ?, NULL, ?)
      `,
      )
      .run(
        'main-msg-assistant-2',
        threadId,
        'Remove this old main reply',
        '2024-01-01T00:00:02.000Z',
      );
    getDb()
      .prepare(
        `
        INSERT INTO talk_messages (
          id, talk_id, thread_id, role, content, created_by, created_at
        ) VALUES (?, NULL, ?, 'user', ?, ?, ?)
      `,
      )
      .run(
        'main-msg-user-keep',
        threadId,
        'Keep this latest main note',
        'owner-1',
        '2024-01-01T00:00:03.000Z',
      );

    const result = deleteMainMessagesAtomic({
      threadId,
      userId: 'owner-1',
      messageIds: [messageId, 'main-msg-assistant-2'],
    });

    expect(result).toEqual({
      deletedCount: 2,
      deletedMessageIds: [messageId, 'main-msg-assistant-2'],
      threadDeleted: false,
    });
    expect(getTalkRunById(runId)?.trigger_message_id).toBeNull();
    const remaining = getDb()
      .prepare(
        `
        SELECT id
        FROM talk_messages
        WHERE talk_id IS NULL AND thread_id = ?
        ORDER BY created_at ASC
      `,
      )
      .all(threadId) as Array<{ id: string }>;
    expect(remaining.map((row) => row.id)).toEqual(['main-msg-user-keep']);
  });

  it('orders same-timestamp talk messages by sequence_in_run and includes runtime metadata in outbox events', () => {
    createTalkRun({
      id: 'run-seq-1',
      talk_id: 'talk-1',
      thread_id: TALK_THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: null,
      target_agent_id: 'agent-default',
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: '2024-01-01T00:00:01.000Z',
      started_at: '2024-01-01T00:00:01.500Z',
      ended_at: null,
      cancel_reason: null,
    });

    createTalkMessage({
      id: 'tm-seq-user',
      talkId: 'talk-1',
      threadId: TALK_THREAD_ID,
      role: 'user',
      content: 'trigger',
      createdBy: 'owner-1',
      createdAt: '2024-01-01T00:00:02.000Z',
    });

    appendRuntimeTalkMessage({
      id: 'tm-seq-assistant',
      talkId: 'talk-1',
      threadId: TALK_THREAD_ID,
      runId: 'run-seq-1',
      role: 'assistant',
      content: 'Checking connector data',
      sequenceInRun: 1,
      metadataJson: JSON.stringify({
        kind: 'assistant_tool_use',
        agentId: 'agent-1',
        agentNickname: 'Opus',
      }),
      createdAt: '2024-01-01T00:00:02.000Z',
    });

    appendRuntimeTalkMessage({
      id: 'tm-seq-tool',
      talkId: 'talk-1',
      threadId: TALK_THREAD_ID,
      runId: 'run-seq-1',
      role: 'tool',
      content: 'Returned 12 rows',
      sequenceInRun: 2,
      metadataJson: JSON.stringify({
        kind: 'tool_result',
        toolName: 'connector_posthog__query',
      }),
      createdAt: '2024-01-01T00:00:02.000Z',
    });

    const messages = listTalkMessages({ talkId: 'talk-1', limit: 10 });
    expect(messages.map((message) => message.id)).toEqual([
      'tm-seq-user',
      'tm-seq-assistant',
      'tm-seq-tool',
    ]);

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 20)
      .filter((event) => event.event_type === 'message_appended')
      .map((event) => JSON.parse(event.payload) as Record<string, unknown>);
    const assistantEvent = events.find(
      (event) => event.messageId === 'tm-seq-assistant',
    );
    const toolEvent = events.find((event) => event.messageId === 'tm-seq-tool');

    expect(assistantEvent?.metadata).toMatchObject({
      kind: 'assistant_tool_use',
      agentId: 'agent-1',
      agentNickname: 'Opus',
    });
    expect(assistantEvent).toMatchObject({
      agentId: 'agent-1',
      agentNickname: 'Opus',
    });
    expect(toolEvent?.metadata).toMatchObject({
      kind: 'tool_result',
      toolName: 'connector_posthog__query',
    });
  });

  it('persists assistant actor metadata when appending final assistant messages', () => {
    createTalkRun({
      id: 'run-assistant-metadata',
      talk_id: 'talk-1',
      thread_id: TALK_THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: null,
      target_agent_id: 'agent-default',
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: '2024-01-01T00:00:03.000Z',
      started_at: '2024-01-01T00:00:03.500Z',
      ended_at: null,
      cancel_reason: null,
    });

    const message = appendAssistantMessageWithOutbox({
      talkId: 'talk-1',
      threadId: TALK_THREAD_ID,
      runId: 'run-assistant-metadata',
      messageId: 'msg-assistant-metadata',
      content: 'Final answer',
      metadataJson: JSON.stringify({ completionStatus: 'complete' }),
      agentId: 'agent-default',
      agentNickname: 'Claude Opus 4.6',
      createdAt: '2024-01-01T00:00:04.000Z',
    });

    expect(JSON.parse(message.metadata_json || '{}')).toMatchObject({
      completionStatus: 'complete',
      agentId: 'agent-default',
      agentNickname: 'Claude Opus 4.6',
    });
    expect(
      JSON.parse(
        listTalkMessages({ talkId: 'talk-1', limit: 20 }).find(
          (candidate) => candidate.id === 'msg-assistant-metadata',
        )?.metadata_json || '{}',
      ),
    ).toMatchObject({
      agentId: 'agent-default',
      agentNickname: 'Claude Opus 4.6',
    });
  });

  it('atomically enqueues talk turn with message, run, and outbox events', () => {
    const result = enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'atomic hello',
      messageId: 'msg-atomic-1',
      runId: 'run-atomic-1',
      idempotencyKey: 'idem-atomic-1',
      now: '2024-01-01T00:00:10.000Z',
    });

    expect(result.message.id).toBe('msg-atomic-1');
    expect(result.message.created_at).toBe('2024-01-01T00:00:10.000Z');
    expect(result.run.id).toBe('run-atomic-1');
    expect(result.run.status).toBe('queued');

    const messages = listTalkMessages({ talkId: 'talk-1', limit: 10 });
    expect(messages.map((message) => message.id)).toContain('msg-atomic-1');

    const run = getTalkRunById('run-atomic-1');
    expect(run?.status).toBe('queued');

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 10);
    const messageEvent = events.find(
      (event) => event.event_type === 'message_appended',
    );
    const runEvent = events.find(
      (event) => event.event_type === 'talk_run_queued',
    );

    expect(messageEvent).toBeDefined();
    expect(runEvent).toBeDefined();

    const messagePayload = JSON.parse(messageEvent!.payload) as {
      talkId: string;
      messageId: string;
      runId: string;
    };
    const runPayload = JSON.parse(runEvent!.payload) as {
      talkId: string;
      runId: string;
      triggerMessageId: string;
      status: string;
    };

    expect(messagePayload).toMatchObject({
      talkId: 'talk-1',
      messageId: 'msg-atomic-1',
      runId: null,
    });
    expect(runPayload).toMatchObject({
      talkId: 'talk-1',
      runId: 'run-atomic-1',
      triggerMessageId: 'msg-atomic-1',
      status: 'queued',
    });
  });

  it('persists ordered response group metadata for multi-agent turns', () => {
    const result = enqueueTalkTurnAtomicRaw({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'ordered hello',
      messageId: 'msg-ordered-atomic-1',
      runIds: [
        'run-ordered-atomic-1',
        'run-ordered-atomic-2',
        'run-ordered-atomic-3',
      ],
      targetAgentIds: ['agent.main', 'agent.main', 'agent.main'],
      responseGroupId: 'group-ordered-atomic-1',
      sequenceIndexes: [0, 1, 2],
      now: '2024-01-01T00:00:11.000Z',
    });

    expect(result.runs.map((run) => run.response_group_id)).toEqual([
      'group-ordered-atomic-1',
      'group-ordered-atomic-1',
      'group-ordered-atomic-1',
    ]);
    expect(result.runs.map((run) => run.sequence_index)).toEqual([0, 1, 2]);
    expect(getTalkRunById('run-ordered-atomic-2')).toMatchObject({
      response_group_id: 'group-ordered-atomic-1',
      sequence_index: 1,
    });

    const queuedEvents = getOutboxEventsForTopics(['talk:talk-1'], 0, 20)
      .filter((event) => event.event_type === 'talk_run_queued')
      .map((event) => JSON.parse(event.payload) as Record<string, unknown>);

    expect(queuedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-ordered-atomic-1',
          responseGroupId: 'group-ordered-atomic-1',
          sequenceIndex: 0,
        }),
        expect.objectContaining({
          runId: 'run-ordered-atomic-2',
          responseGroupId: 'group-ordered-atomic-1',
          sequenceIndex: 1,
        }),
        expect.objectContaining({
          runId: 'run-ordered-atomic-3',
          responseGroupId: 'group-ordered-atomic-1',
          sequenceIndex: 2,
        }),
      ]),
    );
  });

  it('rolls back message writes when run insert fails inside atomic enqueue', () => {
    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'first',
      messageId: 'msg-atomic-2a',
      runId: 'run-atomic-2',
      now: '2024-01-01T00:00:20.000Z',
    });

    expect(() =>
      enqueueTalkTurnAtomic({
        talkId: 'talk-1',
        userId: 'owner-1',
        content: 'second should rollback',
        messageId: 'msg-atomic-2b',
        runId: 'run-atomic-2', // duplicate PK to force failure
        now: '2024-01-01T00:00:21.000Z',
      }),
    ).toThrow();

    const messages = listTalkMessages({ talkId: 'talk-1', limit: 20 });
    expect(
      messages.some((message) => message.id === 'msg-atomic-2b'),
    ).toBeFalsy();

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 50);
    expect(
      events.some((event) => event.payload.includes('msg-atomic-2b')),
    ).toBeFalsy();
  });

  it('does not create orphan talk messages when a channel enqueue hits an active round', () => {
    // resetTalkAgentsToDefault('talk-1', '2024-01-01T00:00:21.500Z');
    const connection = ensureSystemManagedTelegramConnection(
      '2024-01-01T00:00:21.600Z',
    );
    const binding = createTalkChannelBinding({
      talkId: 'talk-1',
      connectionId: connection.id,
      targetKind: 'chat',
      targetId: 'tg:chat:123',
      displayName: 'Telegram Chat',
      createdBy: 'owner-1',
      now: '2024-01-01T00:00:21.700Z',
    });

    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'busy run',
      messageId: 'msg-busy-1',
      runId: 'run-busy-1',
      now: '2024-01-01T00:00:22.000Z',
    });
    markTalkRunStatus(
      'run-busy-1',
      'running',
      null,
      null,
      '2024-01-01T00:00:22.100Z',
    );

    const beforeIds = listTalkMessages({ talkId: 'talk-1', limit: 20 }).map(
      (message) => message.id,
    );
    const result = enqueueChannelTurnAtomic({
      talkId: 'talk-1',
      messageId: 'msg-channel-busy-1',
      runId: 'run-channel-busy-1',
      targetAgentId: binding.responder_agent_id!,
      content: 'hello from telegram',
      metadataJson: JSON.stringify({ platform: 'telegram' }),
      externalCreatedAt: '2024-01-01T00:00:22.200Z',
      sourceBindingId: binding.id,
      sourceExternalMessageId: 'tg-msg-1',
      now: '2024-01-01T00:00:22.300Z',
    });

    expect(result).toEqual({ status: 'thread_busy' });
    const afterIds = listTalkMessages({ talkId: 'talk-1', limit: 20 }).map(
      (message) => message.id,
    );
    expect(afterIds).toEqual(beforeIds);
    expect(getTalkRunById('run-channel-busy-1')).toBeNull();
  });

  it('assigns channel-ingress messages and runs to a valid talk thread', () => {
    const connection = ensureSystemManagedTelegramConnection(
      '2024-01-01T00:00:22.600Z',
    );
    const binding = createTalkChannelBinding({
      talkId: 'talk-1',
      connectionId: connection.id,
      targetKind: 'chat',
      targetId: 'tg:chat:threaded',
      displayName: 'Threaded Telegram Chat',
      createdBy: 'owner-1',
      now: '2024-01-01T00:00:22.700Z',
    });

    const result = enqueueChannelTurnAtomic({
      talkId: 'talk-1',
      messageId: 'msg-channel-ok-1',
      runId: 'run-channel-ok-1',
      targetAgentId: binding.responder_agent_id!,
      content: 'hello from telegram',
      metadataJson: JSON.stringify({ platform: 'telegram' }),
      externalCreatedAt: '2024-01-01T00:00:22.800Z',
      sourceBindingId: binding.id,
      sourceExternalMessageId: 'tg-msg-ok-1',
      now: '2024-01-01T00:00:22.900Z',
    });

    expect(result).toEqual({
      status: 'enqueued',
      messageId: 'msg-channel-ok-1',
      runId: 'run-channel-ok-1',
    });

    const message = listTalkMessages({ talkId: 'talk-1', limit: 20 }).find(
      (entry) => entry.id === 'msg-channel-ok-1',
    );
    const run = getTalkRunById('run-channel-ok-1');

    expect(message?.thread_id).toBeTruthy();
    expect(run?.thread_id).toBe(message?.thread_id);
  });

  it('maps Slack conversations to distinct Talk threads by sourceThreadKey', () => {
    const connection = upsertChannelConnection({
      platform: 'slack',
      connectionMode: 'oauth_workspace',
      accountKey: 'slack:T-test',
      displayName: 'Slack (KimFamily)',
      config: { teamId: 'T-test' },
      createdBy: 'owner-1',
      updatedBy: 'owner-1',
      healthStatus: 'healthy',
      lastHealthCheckAt: '2024-01-01T00:00:23.000Z',
      lastHealthError: null,
    });
    const binding = createTalkChannelBinding({
      talkId: 'talk-1',
      connectionId: connection.id,
      targetKind: 'channel',
      targetId: 'slack:C-general',
      displayName: '#general',
      createdBy: 'owner-1',
      now: '2024-01-01T00:00:23.100Z',
    });

    const first = enqueueChannelTurnAtomic({
      talkId: 'talk-1',
      messageId: 'msg-slack-thread-1',
      runId: 'run-slack-thread-1',
      targetAgentId: binding.responder_agent_id!,
      content: 'first slack message',
      metadataJson: JSON.stringify({ platform: 'slack' }),
      externalCreatedAt: '2024-01-01T00:00:23.200Z',
      sourceBindingId: binding.id,
      sourceExternalMessageId: '1710000000.000100',
      sourceThreadKey: '1710000000.000100',
      now: '2024-01-01T00:00:23.300Z',
    });
    expect(first.status).toBe('enqueued');

    markTalkRunStatus(
      'run-slack-thread-1',
      'running',
      null,
      null,
      '2024-01-01T00:00:23.350Z',
    );

    const second = enqueueChannelTurnAtomic({
      talkId: 'talk-1',
      messageId: 'msg-slack-thread-2',
      runId: 'run-slack-thread-2',
      targetAgentId: binding.responder_agent_id!,
      content: 'second slack message',
      metadataJson: JSON.stringify({ platform: 'slack' }),
      externalCreatedAt: '2024-01-01T00:00:23.400Z',
      sourceBindingId: binding.id,
      sourceExternalMessageId: '1710000001.000100',
      sourceThreadKey: '1710000001.000100',
      now: '2024-01-01T00:00:23.500Z',
    });
    expect(second.status).toBe('enqueued');

    const firstMessage = listTalkMessages({ talkId: 'talk-1', limit: 20 }).find(
      (entry) => entry.id === 'msg-slack-thread-1',
    );
    const secondMessage = listTalkMessages({
      talkId: 'talk-1',
      limit: 20,
    }).find((entry) => entry.id === 'msg-slack-thread-2');
    expect(firstMessage?.thread_id).toBeTruthy();
    expect(secondMessage?.thread_id).toBeTruthy();
    expect(secondMessage?.thread_id).not.toBe(firstMessage?.thread_id);

    const threadMappings = getDb()
      .prepare(
        `
        SELECT source_thread_key, talk_thread_id
        FROM talk_channel_thread_map
        WHERE binding_id = ?
        ORDER BY source_thread_key ASC
      `,
      )
      .all(binding.id) as Array<{
      source_thread_key: string;
      talk_thread_id: string;
    }>;
    expect(threadMappings).toHaveLength(2);
    expect(threadMappings.map((entry) => entry.source_thread_key)).toEqual([
      '1710000000.000100',
      '1710000001.000100',
    ]);
  });

  it('keeps Telegram channel ingress on the default thread when no sourceThreadKey exists', () => {
    const connection = ensureSystemManagedTelegramConnection(
      '2024-01-01T00:00:23.600Z',
    );
    const binding = createTalkChannelBinding({
      talkId: 'talk-1',
      connectionId: connection.id,
      targetKind: 'chat',
      targetId: 'tg:chat:no-thread-key',
      displayName: 'Telegram Chat',
      createdBy: 'owner-1',
      now: '2024-01-01T00:00:23.700Z',
    });
    const defaultThreadId = getOrCreateDefaultThread('talk-1');

    const result = enqueueChannelTurnAtomic({
      talkId: 'talk-1',
      messageId: 'msg-telegram-default-thread',
      runId: 'run-telegram-default-thread',
      targetAgentId: binding.responder_agent_id!,
      content: 'telegram inbound',
      metadataJson: JSON.stringify({ platform: 'telegram' }),
      externalCreatedAt: '2024-01-01T00:00:23.800Z',
      sourceBindingId: binding.id,
      sourceExternalMessageId: 'tg-msg-threadless',
      now: '2024-01-01T00:00:23.900Z',
    });

    expect(result.status).toBe('enqueued');
    expect(getTalkRunById('run-telegram-default-thread')?.thread_id).toBe(
      defaultThreadId,
    );

    const mapCount = (
      getDb()
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM talk_channel_thread_map
          WHERE binding_id = ?
        `,
        )
        .get(binding.id) as { count: number }
    ).count;
    expect(mapCount).toBe(0);
  });

  it('completes a running run and appends the assistant message', () => {
    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'run one',
      messageId: 'msg-atomic-3a',
      runId: 'run-atomic-3a',
      now: '2024-01-01T00:00:30.000Z',
    });
    markTalkRunStatus(
      'run-atomic-3a',
      'running',
      null,
      null,
      '2024-01-01T00:00:30.500Z',
    );

    const completion = completeRunAndPromoteNextAtomic({
      runId: 'run-atomic-3a',
      responseMessageId: 'msg-atomic-3r',
      responseContent: 'assistant reply',
      now: '2024-01-01T00:00:32.000Z',
    });

    expect(completion.applied).toBe(true);
    expect(completion.talkId).toBe('talk-1');

    expect(getTalkRunById('run-atomic-3a')?.status).toBe('completed');

    const messages = listTalkMessages({ talkId: 'talk-1', limit: 20 });
    const responseMessage = messages.find(
      (message) => message.id === 'msg-atomic-3r',
    );
    expect(responseMessage?.role).toBe('assistant');
    expect(responseMessage?.run_id).toBe('run-atomic-3a');

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 50);
    const completed = events.find(
      (event) =>
        event.event_type === 'talk_run_completed' &&
        event.payload.includes('\"runId\":\"run-atomic-3a\"'),
    );
    expect(completed).toBeDefined();
  });

  it('queues a delivery row when a channel-originated run completes successfully', () => {
    // resetTalkAgentsToDefault('talk-1', '2024-01-01T00:00:32.100Z');
    const connection = ensureSystemManagedTelegramConnection(
      '2024-01-01T00:00:32.200Z',
    );
    const binding = createTalkChannelBinding({
      talkId: 'talk-1',
      connectionId: connection.id,
      targetKind: 'chat',
      targetId: 'tg:chat:456',
      displayName: 'Telegram Delivery Chat',
      createdBy: 'owner-1',
      now: '2024-01-01T00:00:32.300Z',
    });

    const enqueueResult = enqueueChannelTurnAtomic({
      talkId: 'talk-1',
      messageId: 'msg-channel-1',
      runId: 'run-channel-1',
      targetAgentId: binding.responder_agent_id!,
      content: 'Need the latest update',
      metadataJson: JSON.stringify({ platform: 'telegram' }),
      externalCreatedAt: '2024-01-01T00:00:32.400Z',
      sourceBindingId: binding.id,
      sourceExternalMessageId: 'tg-msg-99',
      now: '2024-01-01T00:00:32.500Z',
    });
    expect(enqueueResult).toEqual({
      status: 'enqueued',
      messageId: 'msg-channel-1',
      runId: 'run-channel-1',
    });

    markTalkRunStatus(
      'run-channel-1',
      'running',
      null,
      null,
      '2024-01-01T00:00:32.600Z',
    );
    const completion = completeRunAndPromoteNextAtomic({
      runId: 'run-channel-1',
      responseMessageId: 'msg-channel-1-response',
      responseContent: 'Here is the channel reply',
      now: '2024-01-01T00:00:33.000Z',
    });

    expect(completion.applied).toBe(true);
    expect(completion.deliveryQueued).toBe(true);

    const delivery = claimNextChannelDeliveryRow('2024-01-01T00:00:33.100Z');
    expect(delivery).toBeTruthy();
    expect(delivery?.binding_id).toBe(binding.id);
    expect(delivery?.run_id).toBe('run-channel-1');
    expect(delivery?.talk_message_id).toBe('msg-channel-1-response');
    expect(delivery?.status).toBe('sending');
    expect(delivery?.payload_json).toContain('Here is the channel reply');
    expect(delivery?.payload_json).toContain('"deliveryMode":"reply"');
  });

  it('escapes LIKE wildcards when searching channel targets', () => {
    const connection = ensureSystemManagedTelegramConnection(
      '2024-01-01T00:00:33.200Z',
    );
    upsertChannelTarget({
      connectionId: connection.id,
      targetKind: 'chat',
      targetId: 'tg:chat:percent',
      displayName: '100% Coverage',
      lastSeenAt: '2024-01-01T00:00:33.300Z',
    });
    upsertChannelTarget({
      connectionId: connection.id,
      targetKind: 'chat',
      targetId: 'tg:chat:plain',
      displayName: 'Regular Chat',
      lastSeenAt: '2024-01-01T00:00:33.400Z',
    });

    const matches = searchChannelTargets({
      connectionId: connection.id,
      query: '%',
      limit: 10,
    });
    expect(matches.targets.map((row) => row.display_name)).toEqual([
      '100% Coverage',
    ]);
  });

  it('enforces first-writer-wins between cancel and fail transitions', () => {
    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'cancel vs fail',
      messageId: 'msg-atomic-4',
      runId: 'run-atomic-4',
      now: '2024-01-01T00:00:40.000Z',
    });

    const cancelled = cancelTalkRunsAtomic({
      talkId: 'talk-1',
      cancelledBy: 'owner-1',
      now: '2024-01-01T00:00:41.000Z',
    });
    expect(cancelled.cancelledRuns).toBe(1);

    const failed = failRunAndPromoteNextAtomic({
      runId: 'run-atomic-4',
      errorCode: 'execution_failed',
      errorMessage: 'should not override cancellation',
      now: '2024-01-01T00:00:42.000Z',
    });
    expect(failed.applied).toBe(false);

    expect(getTalkRunById('run-atomic-4')?.status).toBe('cancelled');
    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 50);
    expect(
      events.some(
        (event) =>
          event.event_type === 'talk_run_failed' &&
          event.payload.includes('\"runId\":\"run-atomic-4\"'),
      ),
    ).toBe(false);
  });

  it('treats awaiting confirmation runs as active and cancellable', () => {
    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'wait for approval',
      messageId: 'msg-atomic-awaiting',
      runId: 'run-atomic-awaiting',
      now: '2024-01-01T00:00:45.000Z',
    });
    markTalkRunStatus(
      'run-atomic-awaiting',
      'awaiting_confirmation',
      null,
      null,
      '2024-01-01T00:00:46.000Z',
    );

    expect(hasActiveTalkRuns('talk-1')).toBe(true);

    const cancelled = cancelTalkRunsAtomic({
      talkId: 'talk-1',
      cancelledBy: 'owner-1',
      now: '2024-01-01T00:00:47.000Z',
    });
    expect(cancelled.cancelledRuns).toBe(1);
    expect(getTalkRunById('run-atomic-awaiting')?.status).toBe('cancelled');
  });

  it('blocks deleting a main thread while a run is awaiting confirmation', () => {
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });

    enqueueMainTurnAtomic({
      threadId: 'main-thread-awaiting-delete',
      userId: 'owner-1',
      content: 'Need approval before deleting',
      messageId: 'main-msg-awaiting-delete',
      runId: 'main-run-awaiting-delete',
    });
    markTalkRunStatus(
      'main-run-awaiting-delete',
      'awaiting_confirmation',
      null,
      null,
      '2024-01-01T00:00:47.500Z',
    );

    expect(() =>
      deleteMainThread({
        threadId: 'main-thread-awaiting-delete',
        userId: 'owner-1',
      }),
    ).toThrow(ThreadDeleteConflictError);
  });

  it('allows enqueueing another Main turn when the only existing run is awaiting confirmation', () => {
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });

    enqueueMainTurnAtomic({
      threadId: 'main-thread-awaiting-busy',
      userId: 'owner-1',
      content: 'First main turn',
      messageId: 'main-msg-awaiting-busy-1',
      runId: 'main-run-awaiting-busy-1',
    });
    markTalkRunStatus(
      'main-run-awaiting-busy-1',
      'awaiting_confirmation',
      null,
      null,
      '2024-01-01T00:00:47.600Z',
    );

    expect(() =>
      enqueueMainTurnAtomic({
        threadId: 'main-thread-awaiting-busy',
        userId: 'owner-1',
        content: 'Second main turn',
        messageId: 'main-msg-awaiting-busy-2',
        runId: 'main-run-awaiting-busy-2',
      }),
    ).not.toThrow();

    const secondRun = getDb()
      .prepare(`SELECT status FROM talk_runs WHERE id = ?`)
      .get('main-run-awaiting-busy-2') as { status: string } | undefined;
    expect(secondRun?.status).toBe('queued');
  });

  it('cancels only the requested thread when sibling threads still have active work', () => {
    const threadA = createTalkThread({ talkId: 'talk-1', title: 'Thread A' });
    const threadB = createTalkThread({ talkId: 'talk-1', title: 'Thread B' });

    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      threadId: threadA.id,
      userId: 'owner-1',
      content: 'run A',
      messageId: 'msg-thread-a',
      runId: 'run-thread-a',
      now: '2024-01-01T00:00:47.500Z',
    });
    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      threadId: threadB.id,
      userId: 'owner-1',
      content: 'run B',
      messageId: 'msg-thread-b',
      runId: 'run-thread-b',
      now: '2024-01-01T00:00:47.600Z',
    });
    markTalkRunStatus(
      'run-thread-a',
      'running',
      null,
      null,
      '2024-01-01T00:00:47.700Z',
    );

    const cancelled = cancelTalkRunsAtomic({
      talkId: 'talk-1',
      threadId: threadA.id,
      cancelledBy: 'owner-1',
      now: '2024-01-01T00:00:47.800Z',
    });

    expect(cancelled.cancelledRuns).toBe(1);
    expect(cancelled.cancelledRunIds).toEqual(['run-thread-a']);
    expect(getTalkRunById('run-thread-a')?.status).toBe('cancelled');
    expect(getTalkRunById('run-thread-b')?.status).toBe('queued');
    expect(hasActiveTalkRuns('talk-1', threadA.id)).toBe(false);
    expect(hasActiveTalkRuns('talk-1', threadB.id)).toBe(true);

    const cancelEvent = getOutboxEventsForTopics(['talk:talk-1'], 0, 100).find(
      (event) => event.event_type === 'talk_run_cancelled',
    );
    expect(cancelEvent).toBeDefined();
    expect(JSON.parse(cancelEvent!.payload)).toMatchObject({
      talkId: 'talk-1',
      runIds: ['run-thread-a'],
      threadIds: [threadA.id],
    });
  });

  it('sorts pinned talk threads ahead of newer unpinned threads', () => {
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertTalk({
      id: 'talk-threads',
      ownerId: 'owner-1',
      topicTitle: 'Thread sorting',
    });

    const older = createTalkThread({ talkId: 'talk-threads', title: 'Older' });
    const newer = createTalkThread({ talkId: 'talk-threads', title: 'Newer' });
    createTalkMessage({
      id: 'msg-older-thread',
      talkId: 'talk-threads',
      threadId: older.id,
      role: 'user',
      content: 'older',
      createdBy: 'owner-1',
      createdAt: '2026-03-18T11:00:00.000Z',
    });
    createTalkMessage({
      id: 'msg-newer-thread',
      talkId: 'talk-threads',
      threadId: newer.id,
      role: 'user',
      content: 'newer',
      createdBy: 'owner-1',
      createdAt: '2026-03-18T12:00:00.000Z',
    });

    updateTalkThreadMetadata({
      talkId: 'talk-threads',
      threadId: older.id,
      pinned: true,
    });

    const threads = listTalkThreads('talk-threads');
    expect(threads[0]?.id).toBe(older.id);
    expect(threads[0]?.is_pinned).toBe(1);
  });

  it('deletes a talk thread and its associated rows', () => {
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertTalk({
      id: 'talk-delete',
      ownerId: 'owner-1',
      topicTitle: 'Thread delete',
    });

    const thread = createTalkThread({ talkId: 'talk-delete', title: 'Delete' });
    createTalkMessage({
      id: 'msg-thread-delete',
      talkId: 'talk-delete',
      threadId: thread.id,
      role: 'user',
      content: 'hello',
      createdBy: 'owner-1',
      createdAt: '2026-03-18T12:00:00.000Z',
    });
    createTalkRun({
      id: 'run-thread-delete',
      talk_id: 'talk-delete',
      requested_by: 'owner-1',
      status: 'completed',
      trigger_message_id: 'msg-thread-delete',
      job_id: null,
      target_agent_id: null,
      executor_alias: null,
      executor_model: null,
      thread_id: thread.id,
      idempotency_key: null,
      response_group_id: null,
      sequence_index: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2026-03-18T12:00:00.000Z',
      started_at: '2026-03-18T12:00:01.000Z',
      ended_at: '2026-03-18T12:00:02.000Z',
      cancel_reason: null,
    });

    const deleted = deleteTalkThread({
      talkId: 'talk-delete',
      threadId: thread.id,
    });

    expect(deleted).toBe(true);
    expect(
      listTalkThreads('talk-delete').map((entry) => entry.id),
    ).not.toContain(thread.id);
    expect(getTalkRunById('run-thread-delete')).toBeNull();
  });

  it('rejects deleting the default talk thread', () => {
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertTalk({
      id: 'talk-default-delete',
      ownerId: 'owner-1',
      topicTitle: 'Default thread',
    });

    const defaultThreadId = getOrCreateDefaultThread('talk-default-delete');

    expect(() =>
      deleteTalkThread({
        talkId: 'talk-default-delete',
        threadId: defaultThreadId,
      }),
    ).toThrow(ThreadDeleteConflictError);
  });

  // it('supersedes pending confirmations when cancelling awaiting confirmation runs', () => {
  //   enqueueTalkTurnAtomic({
  //     talkId: 'talk-1',
  //     userId: 'owner-1',
  //     content: 'confirm before send',
  //     messageId: 'msg-atomic-confirm',
  //     runId: 'run-atomic-confirm',
  //     now: '2024-01-01T00:00:48.000Z',
  //   });
  //   markTalkRunStatus(
  //     'run-atomic-confirm',
  //     'awaiting_confirmation',
  //     null,
  //     null,
  //     '2024-01-01T00:00:49.000Z',
  //   );
  //   const confirmation = createTalkActionConfirmation({
  //     talkId: 'talk-1',
  //     runId: 'run-atomic-confirm',
  //     toolName: 'gmail_send_email',
  //     confirmationType: 'mutation',
  //     proposedArgs: {
  //       to: ['alice@example.com'],
  //     },
  //     requestedBy: 'owner-1',
  //   });
  //
  //   const cancelled = cancelTalkRunsAtomic({
  //     talkId: 'talk-1',
  //     cancelledBy: 'owner-1',
  //     now: '2024-01-01T00:00:50.000Z',
  //   });
  //
  //   expect(cancelled.cancelledRuns).toBe(1);
  //   expect(getTalkRunById('run-atomic-confirm')?.status).toBe('cancelled');
  //   expect(getTalkActionConfirmationById(confirmation.id)).toMatchObject({
  //     status: 'superseded',
  //     resolvedBy: 'owner-1',
  //   });
  // });

  it('fails interrupted running runs on startup and leaves queued runs queued', () => {
    createTalkRun({
      id: 'run-atomic-5a',
      talk_id: 'talk-1',
      thread_id: TALK_THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: null,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: '2024-01-01T00:00:50.000Z',
      started_at: '2024-01-01T00:00:50.000Z',
      ended_at: null,
      cancel_reason: null,
    });
    createTalkRun({
      id: 'run-atomic-5b',
      talk_id: 'talk-1',
      thread_id: TALK_THREAD_ID,
      requested_by: 'owner-1',
      status: 'queued',
      trigger_message_id: null,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: '2024-01-01T00:00:51.000Z',
      started_at: null,
      ended_at: null,
      cancel_reason: null,
    });

    const recovered = failInterruptedRunsOnStartup('2024-01-01T00:00:52.000Z');
    expect(recovered.failedRunIds).toEqual(['run-atomic-5a']);
    expect(recovered.promotedRunIds).toEqual([]);

    expect(getTalkRunById('run-atomic-5a')?.status).toBe('failed');
    expect(getTalkRunById('run-atomic-5a')?.cancel_reason).toBe(
      'interrupted_by_restart',
    );
    expect(getTalkRunById('run-atomic-5b')?.status).toBe('queued');
  });

  it('normalizes talk list pagination consistently', () => {
    expect(normalizeTalkListPage({ limit: 500, offset: -10 })).toEqual({
      limit: 200,
      offset: 0,
    });
    expect(normalizeTalkListPage({ limit: 0, offset: 3.7 })).toEqual({
      limit: 1,
      offset: 3,
    });
    expect(normalizeTalkListPage()).toEqual({
      limit: 50,
      offset: 0,
    });
  });

  it('prunes old idempotency cache records', () => {
    const createdAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
    saveIdempotencyCache({
      idempotency_key: 'idem-old',
      user_id: 'owner-1',
      method: 'POST',
      path: '/api/v1/talks/talk-1/chat/cancel',
      request_hash: 'abc',
      status_code: 200,
      response_body: '{}',
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    });

    const pruned = pruneIdempotencyCache();
    expect(pruned).toBe(1);

    const existing = getIdempotencyCache({
      userId: 'owner-1',
      idempotencyKey: 'idem-old',
      method: 'POST',
      path: '/api/v1/talks/talk-1/chat/cancel',
    });
    expect(existing).toBeUndefined();
  });

  it('maintains one running talk run and queued follow-ups', () => {
    createTalkRun({
      id: 'run-1',
      talk_id: 'talk-1',
      thread_id: TALK_THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: null,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      ended_at: null,
      cancel_reason: null,
    });
    createTalkRun({
      id: 'run-2',
      talk_id: 'talk-1',
      thread_id: TALK_THREAD_ID,
      requested_by: 'owner-1',
      status: 'queued',
      trigger_message_id: null,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: new Date().toISOString(),
      started_at: null,
      ended_at: null,
      cancel_reason: null,
    });

    expect(getRunningTalkRun('talk-1')?.id).toBe('run-1');
    expect(getQueuedTalkRuns('talk-1').map((row) => row.id)).toEqual(['run-2']);

    markTalkRunStatus(
      'run-1',
      'completed',
      new Date().toISOString(),
      null,
      new Date().toISOString(),
    );
    expect(getTalkRunById('run-1')?.status).toBe('completed');
  });

  it('persists executor alias/model metadata on talk runs', () => {
    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'metadata check',
      messageId: 'msg-meta-1',
      runId: 'run-meta-1',
      now: '2024-01-01T00:00:55.000Z',
    });

    setTalkRunExecutorProfile({
      runId: 'run-meta-1',
      executorAlias: 'Gemini',
      executorModel: 'default',
    });

    const run = getTalkRunById('run-meta-1');
    expect(run?.executor_alias).toBe('Gemini');
    expect(run?.executor_model).toBe('default');
  });

  it('includes executor alias/model in terminal run lifecycle events', () => {
    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'terminal metadata complete',
      messageId: 'msg-meta-term-1',
      runId: 'run-meta-term-1',
      now: '2024-01-01T00:00:56.000Z',
    });

    setTalkRunExecutorProfile({
      runId: 'run-meta-term-1',
      executorAlias: 'Gemini',
      executorModel: 'default',
    });

    markTalkRunStatus(
      'run-meta-term-1',
      'running',
      null,
      null,
      '2024-01-01T00:00:56.500Z',
    );
    const completionApplied = completeRunAndPromoteNextAtomic({
      runId: 'run-meta-term-1',
      responseMessageId: 'msg-meta-term-1r',
      responseContent: 'done',
      now: '2024-01-01T00:00:57.000Z',
    });
    expect(completionApplied.applied).toBe(true);

    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'terminal metadata fail',
      messageId: 'msg-meta-term-2',
      runId: 'run-meta-term-2',
      now: '2024-01-01T00:00:58.000Z',
    });

    setTalkRunExecutorProfile({
      runId: 'run-meta-term-2',
      executorAlias: 'Opus4.6',
      executorModel: 'default',
    });
    markTalkRunStatus(
      'run-meta-term-2',
      'running',
      null,
      null,
      '2024-01-01T00:00:58.500Z',
    );

    const failure = failRunAndPromoteNextAtomic({
      runId: 'run-meta-term-2',
      errorCode: 'execution_failed',
      errorMessage: 'boom',
      now: '2024-01-01T00:00:59.000Z',
    });
    expect(failure.applied).toBe(true);

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 100);
    const completedEvent = events.find(
      (event) =>
        event.event_type === 'talk_run_completed' &&
        event.payload.includes('"runId":"run-meta-term-1"'),
    );
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.payload).toContain('"executorAlias":"Gemini"');
    expect(completedEvent?.payload).toContain('"executorModel":"default"');

    const failedEvent = events.find(
      (event) =>
        event.event_type === 'talk_run_failed' &&
        event.payload.includes('"runId":"run-meta-term-2"'),
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.payload).toContain('"executorAlias":"Opus4.6"');
    expect(failedEvent?.payload).toContain('"executorModel":"default"');
  });

  it('preserves hot events while pruning old outbox rows', () => {
    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'keep',
      payload: '{}',
    });
    const deleted = pruneEventOutbox({
      nowMs: Date.now() + 1000,
      retentionHours: 0,
      keepRecentPerTopic: 1,
    });
    expect(deleted).toBe(0);
  });
});
