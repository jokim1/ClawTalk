import { describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createMessage,
  initClawrocketSchema,
  upsertUser,
} from './index.js';
import { getDb } from '../../db.js';
import { _initClawrocketTestSchema } from './init.js';

describe('clawrocket schema init', () => {
  it('creates all core tables on a fresh database', () => {
    _initTestDatabase();
    const db = getDb();

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);

    // Core tables from db.ts
    expect(tableNames).toContain('chats');
    expect(tableNames).toContain('scheduled_tasks');

    // Clawrocket tables
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('talks');
    expect(tableNames).toContain('talk_messages');
    expect(tableNames).toContain('talk_runs');
    expect(tableNames).toContain('registered_agents');
    expect(tableNames).toContain('browser_profiles');
    expect(tableNames).toContain('browser_sessions');
    expect(tableNames).toContain('talk_agents');
    expect(tableNames).toContain('talk_llm_policies');
    expect(tableNames).toContain('talk_executor_sessions');
    expect(tableNames).toContain('channel_delivery_outbox');
    expect(tableNames).toContain('llm_attempts');
  });

  it('talk_messages table has required columns', () => {
    _initTestDatabase();
    const db = getDb();

    const columns = db
      .prepare(`PRAGMA table_info('talk_messages')`)
      .all() as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain('id');
    expect(colNames).toContain('talk_id');
    expect(colNames).toContain('thread_id');
    expect(colNames).toContain('role');
    expect(colNames).toContain('content');
    expect(colNames).toContain('agent_id');
    expect(colNames).toContain('run_id');
    expect(colNames).toContain('sequence_in_run');
    expect(colNames).toContain('created_by');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('metadata_json');
  });

  it('talks table includes version column', () => {
    _initTestDatabase();
    const db = getDb();

    const columns = db.prepare(`PRAGMA table_info('talks')`).all() as Array<{
      name: string;
    }>;
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain('version');
  });

  it('talk_channel_policies includes timezone', () => {
    _initTestDatabase();
    const db = getDb();

    const columns = db
      .prepare(`PRAGMA table_info('talk_channel_policies')`)
      .all() as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain('timezone');
  });

  it('talk_runs includes typed browser lifecycle columns', () => {
    _initTestDatabase();
    const db = getDb();

    const columns = db
      .prepare(`PRAGMA table_info('talk_runs')`)
      .all() as Array<{
      name: string;
    }>;
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain('task_type');
    expect(colNames).toContain('browser_phase');
    expect(colNames).toContain('blocked_reason');
    expect(colNames).toContain('browser_session_id');
    expect(colNames).toContain('selected_mode');
    expect(colNames).toContain('transport');
    expect(colNames).toContain('timeout_phase');
  });

  it('registered_agents table has tool_permissions_json', () => {
    _initTestDatabase();
    const db = getDb();

    const columns = db
      .prepare(`PRAGMA table_info('registered_agents')`)
      .all() as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain('tool_permissions_json');
  });

  it('seeds both Sonnet and Opus Anthropic models for AI Agents', () => {
    _initTestDatabase();
    const db = getDb();

    const models = db
      .prepare(
        `SELECT model_id, display_name
         FROM llm_provider_models
         WHERE provider_id = 'provider.anthropic'
         ORDER BY model_id`,
      )
      .all() as Array<{ model_id: string; display_name: string }>;

    expect(models).toEqual([
      {
        model_id: 'claude-opus-4-6',
        display_name: 'Claude Opus 4.6',
      },
      {
        model_id: 'claude-sonnet-4-6',
        display_name: 'Claude Sonnet 4.6',
      },
    ]);
  });

  it('seeds builtin additional providers for direct-http agents', () => {
    _initTestDatabase();
    const db = getDb();

    const providers = db
      .prepare(
        `SELECT id, name, base_url
         FROM llm_providers
         WHERE id IN ('provider.openai', 'provider.gemini', 'provider.nvidia')
         ORDER BY id`,
      )
      .all() as Array<{ id: string; name: string; base_url: string }>;

    expect(providers).toEqual([
      {
        id: 'provider.gemini',
        name: 'Google / Gemini',
        base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
      },
      {
        id: 'provider.nvidia',
        name: 'NVIDIA Kimi2.5',
        base_url: 'https://integrate.api.nvidia.com/v1',
      },
      {
        id: 'provider.openai',
        name: 'OpenAI',
        base_url: 'https://api.openai.com/v1',
      },
    ]);

    const models = db
      .prepare(
        `SELECT provider_id, model_id
         FROM llm_provider_models
         WHERE provider_id IN ('provider.openai', 'provider.gemini', 'provider.nvidia')
         ORDER BY provider_id, model_id`,
      )
      .all() as Array<{ provider_id: string; model_id: string }>;

    expect(models).toEqual([
      { provider_id: 'provider.gemini', model_id: 'gemini-2.5-flash' },
      { provider_id: 'provider.nvidia', model_id: 'moonshotai/kimi-k2.5' },
      { provider_id: 'provider.openai', model_id: 'gpt-5-mini' },
    ]);
  });

  it('repairs persisted builtin provider configuration on startup', () => {
    _initTestDatabase();
    const db = getDb();

    db.prepare(
      `UPDATE llm_providers
       SET base_url = 'https://generativelanguage.googleapis.com/openai'
       WHERE id = 'provider.gemini'`,
    ).run();

    initClawrocketSchema();

    const geminiProvider = db
      .prepare(
        `SELECT base_url
         FROM llm_providers
         WHERE id = 'provider.gemini'`,
      )
      .get() as { base_url: string } | undefined;

    expect(geminiProvider?.base_url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai',
    );
  });

  it('deactivates older duplicate active talk channel bindings before creating the unique target index', () => {
    _initTestDatabase();
    const db = getDb();
    const baseTime = '2026-03-21T00:00:00.000Z';

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });

    db.exec(
      'DROP INDEX IF EXISTS idx_talk_channel_bindings_active_target_unique;',
    );

    db.prepare(
      `INSERT INTO talks (id, owner_id, topic_title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('talk-1', 'owner-1', 'Family Ops', baseTime, baseTime);
    db.prepare(
      `INSERT INTO talks (id, owner_id, topic_title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('talk-2', 'owner-1', 'Family Announcements', baseTime, baseTime);
    db.prepare(
      `INSERT INTO channel_connections (
         id, platform, connection_mode, account_key, display_name, enabled,
         health_status, config_json, created_at, updated_at, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'channel-conn:slack:kimfamily',
      'slack',
      'oauth_workspace',
      'slack:T123',
      'KimFamily',
      'healthy',
      JSON.stringify({ teamId: 'T123', teamName: 'KimFamily' }),
      baseTime,
      baseTime,
      'owner-1',
      'owner-1',
    );

    db.prepare(
      `INSERT INTO talk_channel_bindings (
         id, talk_id, connection_id, target_kind, target_id, display_name,
         response_mode, active, created_at, updated_at, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, 'mentions', 1, ?, ?, ?, ?)`,
    ).run(
      'binding-old',
      'talk-1',
      'channel-conn:slack:kimfamily',
      'channel',
      'slack:C123',
      '#family-ops',
      '2026-03-21T00:00:00.000Z',
      '2026-03-21T00:00:00.000Z',
      'owner-1',
      'owner-1',
    );
    db.prepare(
      `INSERT INTO talk_channel_bindings (
         id, talk_id, connection_id, target_kind, target_id, display_name,
         response_mode, active, created_at, updated_at, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, 'mentions', 1, ?, ?, ?, ?)`,
    ).run(
      'binding-new',
      'talk-2',
      'channel-conn:slack:kimfamily',
      'channel',
      'slack:C123',
      '#family-ops',
      '2026-03-21T00:01:00.000Z',
      '2026-03-21T00:02:00.000Z',
      'owner-1',
      'owner-1',
    );

    initClawrocketSchema();

    const bindings = db
      .prepare(
        `SELECT id, active
         FROM talk_channel_bindings
         WHERE connection_id = 'channel-conn:slack:kimfamily'
           AND target_id = 'slack:C123'
         ORDER BY id`,
      )
      .all() as Array<{ id: string; active: number }>;
    expect(bindings).toEqual([
      { id: 'binding-new', active: 1 },
      { id: 'binding-old', active: 0 },
    ]);

    const index = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'index'
           AND name = 'idx_talk_channel_bindings_active_target_unique'`,
      )
      .get() as { name: string } | undefined;
    expect(index?.name).toBe('idx_talk_channel_bindings_active_target_unique');
  });

  it('seeds separate main and default Talk agents', () => {
    _initTestDatabase();
    const db = getDb();

    const agents = db
      .prepare(
        `SELECT id, provider_id, model_id FROM registered_agents WHERE id IN ('agent.main', 'agent.talk') ORDER BY id`,
      )
      .all() as Array<{
      id: string;
      provider_id: string;
      model_id: string;
    }>;
    expect(agents).toEqual([
      {
        id: 'agent.main',
        provider_id: 'provider.anthropic',
        model_id: 'claude-sonnet-4-6',
      },
      {
        id: 'agent.talk',
        provider_id: 'provider.anthropic',
        model_id: 'claude-sonnet-4-6',
      },
    ]);

    const settings = db
      .prepare(
        `SELECT key, value FROM settings_kv WHERE key IN ('system.mainAgentId', 'system.defaultTalkAgentId') ORDER BY key`,
      )
      .all() as Array<{ key: string; value: string }>;
    expect(settings).toEqual([
      {
        key: 'system.defaultTalkAgentId',
        value: 'agent.talk',
      },
      {
        key: 'system.mainAgentId',
        value: 'agent.main',
      },
    ]);

    const toolPermissionsRow = db
      .prepare(
        `SELECT tool_permissions_json FROM registered_agents WHERE id = 'agent.main'`,
      )
      .get() as { tool_permissions_json: string } | undefined;
    expect(toolPermissionsRow).toBeTruthy();
    expect(JSON.parse(toolPermissionsRow!.tool_permissions_json)).toMatchObject(
      {
        shell: true,
        filesystem: true,
        web: true,
      },
    );
    expect(
      JSON.parse(toolPermissionsRow!.tool_permissions_json),
    ).not.toMatchObject({
      browser: true,
    });
  });

  it('creates browser_profiles indexes for canonical profile lookup', () => {
    _initTestDatabase();
    const db = getDb();

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'browser_profiles' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'idx_browser_profiles_path',
        'idx_browser_profiles_site_account',
        'idx_browser_profiles_site_last_used',
      ]),
    );
  });

  it('preserves explicit browser enablement on the main agent across init reruns', () => {
    _initTestDatabase();
    const db = getDb();

    db.prepare(
      `UPDATE registered_agents
       SET tool_permissions_json = ?,
           updated_at = ?
       WHERE id = 'agent.main'`,
    ).run(
      JSON.stringify({
        shell: true,
        filesystem: true,
        web: true,
        browser: true,
        connectors: true,
      }),
      new Date().toISOString(),
    );

    _initClawrocketTestSchema();

    const toolPermissionsRow = db
      .prepare(
        `SELECT tool_permissions_json FROM registered_agents WHERE id = 'agent.main'`,
      )
      .get() as { tool_permissions_json: string } | undefined;

    expect(toolPermissionsRow).toBeTruthy();
    expect(JSON.parse(toolPermissionsRow!.tool_permissions_json)).toMatchObject(
      {
        shell: true,
        filesystem: true,
        web: true,
        browser: true,
        connectors: true,
      },
    );
  });

  it('defines main_thread_summaries coverage with ON DELETE SET NULL', () => {
    _initTestDatabase();
    const db = getDb();

    const foreignKeys = db
      .prepare(`PRAGMA foreign_key_list('main_thread_summaries')`)
      .all() as Array<{
      table: string;
      from: string;
      on_delete: string;
    }>;

    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'talk_messages',
          from: 'covers_through_message_id',
          on_delete: 'SET NULL',
        }),
      ]),
    );
  });

  it('migrates stale main_thread_summaries coverage markers to null', () => {
    _initTestDatabase();
    const db = getDb();
    const now = new Date().toISOString();

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });

    db.prepare(
      `
      INSERT INTO main_threads (thread_id, user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('thread-main-summary-migration', 'owner-1', now, now);

    createMessage({
      id: 'msg-main-summary-1',
      talkId: null,
      threadId: 'thread-main-summary-migration',
      role: 'user',
      content: 'Original covered message',
      createdBy: 'owner-1',
      createdAt: now,
    });

    db.prepare(
      `
      INSERT INTO main_thread_summaries (
        thread_id, summary_text, covers_through_message_id, updated_at
      ) VALUES (?, ?, ?, ?)
    `,
    ).run(
      'thread-main-summary-migration',
      'Persisted summary text',
      'msg-main-summary-1',
      now,
    );

    db.exec(`
      CREATE TABLE main_thread_summaries_legacy AS
        SELECT * FROM main_thread_summaries;
      DROP TABLE main_thread_summaries;
      CREATE TABLE main_thread_summaries (
        thread_id TEXT PRIMARY KEY REFERENCES main_threads(thread_id) ON DELETE CASCADE,
        summary_text TEXT NOT NULL,
        covers_through_message_id TEXT REFERENCES talk_messages(id),
        updated_at TEXT NOT NULL
      );
      INSERT INTO main_thread_summaries
      SELECT * FROM main_thread_summaries_legacy;
      DROP TABLE main_thread_summaries_legacy;
    `);

    db.pragma('foreign_keys = OFF');
    db.prepare(`DELETE FROM talk_messages WHERE id = ?`).run(
      'msg-main-summary-1',
    );
    db.pragma('foreign_keys = ON');

    initClawrocketSchema();

    const migratedRow = db
      .prepare(
        `
        SELECT covers_through_message_id
        FROM main_thread_summaries
        WHERE thread_id = ?
      `,
      )
      .get('thread-main-summary-migration') as
      | { covers_through_message_id: string | null }
      | undefined;

    expect(migratedRow?.covers_through_message_id).toBeNull();

    const foreignKeys = db
      .prepare(`PRAGMA foreign_key_list('main_thread_summaries')`)
      .all() as Array<{
      table: string;
      from: string;
      on_delete: string;
    }>;

    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'talk_messages',
          from: 'covers_through_message_id',
          on_delete: 'SET NULL',
        }),
      ]),
    );
  });
});
