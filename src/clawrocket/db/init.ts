import Database from 'better-sqlite3';

import { getDb } from '../../db.js';
import { TIMEZONE } from '../../config.js';
import { BUILTIN_ADDITIONAL_PROVIDERS } from '../agents/builtin-additional-providers.js';

const DEFAULT_CHANNEL_BINDING_TIMEZONE = TIMEZONE || 'UTC';

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function seedBuiltinLlmProvider(database: Database.Database): void {
  const now = new Date().toISOString();

  database
    .prepare(
      `
      INSERT INTO llm_providers (
        id, name, provider_kind, api_format, base_url, auth_scheme, enabled,
        core_compatibility, response_start_timeout_ms, stream_idle_timeout_ms,
        absolute_timeout_ms, updated_at, updated_by
      )
      VALUES (
        'builtin.mock',
        'Local Mock',
        'custom',
        'openai_chat_completions',
        'mock://local-talk-runtime',
        'bearer',
        1,
        'none',
        60000,
        20000,
        300000,
        ?,
        NULL
      )
      ON CONFLICT(id) DO NOTHING
    `,
    )
    .run(now);

  database
    .prepare(
      `
      INSERT INTO llm_provider_models (
        provider_id, model_id, display_name, context_window_tokens,
        default_max_output_tokens, default_ttft_timeout_ms, enabled, updated_at, updated_by
      )
      VALUES (
        'builtin.mock',
        'mock-default',
        'Mock',
        64000,
        2048,
        10000,
        1,
        ?,
        NULL
      )
      ON CONFLICT(provider_id, model_id) DO NOTHING
    `,
    )
    .run(now);
}

function seedAnthropicProvider(database: Database.Database): void {
  const now = new Date().toISOString();

  // Ensure a provider.anthropic row exists in llm_providers so that
  // registered agents created through the UI can reference it.  The actual
  // API-key is stored separately in llm_provider_secrets (written when the
  // user configures Claude credentials).
  database
    .prepare(
      `
      INSERT INTO llm_providers (
        id, name, provider_kind, api_format, base_url, auth_scheme, enabled,
        core_compatibility, response_start_timeout_ms, stream_idle_timeout_ms,
        absolute_timeout_ms, updated_at, updated_by
      )
      VALUES (
        'provider.anthropic',
        'Claude (Anthropic)',
        'anthropic',
        'anthropic_messages',
        'https://api.anthropic.com',
        'x_api_key',
        1,
        'claude_sdk_proxy',
        60000,
        30000,
        600000,
        ?,
        NULL
      )
      ON CONFLICT(id) DO NOTHING
    `,
    )
    .run(now);

  // Seed a default Claude model so the provider has at least one selectable
  // option before the user overrides model suggestions via settings.
  database
    .prepare(
      `
      INSERT INTO llm_provider_models (
        provider_id, model_id, display_name, context_window_tokens,
        default_max_output_tokens, default_ttft_timeout_ms, enabled, updated_at, updated_by
      )
      VALUES (
        'provider.anthropic',
        'claude-sonnet-4-6',
        'Claude Sonnet 4.6',
        200000,
        8192,
        90000,
        1,
        ?,
        NULL
      )
      ON CONFLICT(provider_id, model_id) DO NOTHING
    `,
    )
    .run(now);

  database
    .prepare(
      `
      INSERT INTO llm_provider_models (
        provider_id, model_id, display_name, context_window_tokens,
        default_max_output_tokens, default_ttft_timeout_ms, enabled, updated_at, updated_by
      )
      VALUES (
        'provider.anthropic',
        'claude-opus-4-6',
        'Claude Opus 4.6',
        200000,
        8192,
        180000,
        1,
        ?,
        NULL
      )
      ON CONFLICT(provider_id, model_id) DO NOTHING
    `,
    )
    .run(now);
}

function seedAdditionalProviders(database: Database.Database): void {
  const now = new Date().toISOString();

  for (const provider of BUILTIN_ADDITIONAL_PROVIDERS) {
    database
      .prepare(
        `
        INSERT INTO llm_providers (
          id, name, provider_kind, api_format, base_url, auth_scheme, enabled,
          core_compatibility, response_start_timeout_ms, stream_idle_timeout_ms,
          absolute_timeout_ms, updated_at, updated_by
        )
        VALUES (?, ?, ?, ?, ?, ?, 1, 'none', ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          provider_kind = excluded.provider_kind,
          api_format = excluded.api_format,
          base_url = excluded.base_url,
          auth_scheme = excluded.auth_scheme,
          enabled = excluded.enabled,
          core_compatibility = excluded.core_compatibility,
          response_start_timeout_ms = excluded.response_start_timeout_ms,
          stream_idle_timeout_ms = excluded.stream_idle_timeout_ms,
          absolute_timeout_ms = excluded.absolute_timeout_ms,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `,
      )
      .run(
        provider.id,
        provider.name,
        provider.providerKind,
        provider.apiFormat,
        provider.baseUrl,
        provider.authScheme,
        provider.responseStartTimeoutMs,
        provider.streamIdleTimeoutMs,
        provider.absoluteTimeoutMs,
        now,
      );

    for (const model of provider.models) {
      database
        .prepare(
          `
          INSERT INTO llm_provider_models (
            provider_id, model_id, display_name, context_window_tokens,
            default_max_output_tokens, default_ttft_timeout_ms, enabled, updated_at, updated_by
          )
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL)
          ON CONFLICT(provider_id, model_id) DO NOTHING
        `,
        )
        .run(
          provider.id,
          model.modelId,
          model.displayName,
          model.contextWindowTokens,
          model.defaultMaxOutputTokens,
          model.defaultTtftTimeoutMs,
          now,
        );
    }
  }
}

function getSeedClaudeModel(database: Database.Database): string {
  return (
    (
      database
        .prepare(
          `SELECT value FROM settings_kv WHERE key = 'executor.defaultClaudeModel'`,
        )
        .get() as { value: string } | undefined
    )?.value || 'claude-sonnet-4-6'
  );
}

function seedMainAgent(database: Database.Database): void {
  const now = new Date().toISOString();
  const modelId = getSeedClaudeModel(database);
  const toolPermissions = JSON.stringify({
    shell: true,
    filesystem: true,
    web: true,
    connectors: true,
    google_read: true,
    google_write: true,
    gmail_read: true,
    gmail_send: true,
    messaging: true,
  });

  database
    .prepare(
      `
      INSERT INTO registered_agents (
        id, name, provider_id, model_id, tool_permissions_json,
        persona_role, system_prompt, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `,
    )
    .run(
      'agent.main',
      'Nanoclaw',
      'provider.anthropic',
      modelId,
      toolPermissions,
      'assistant',
      null,
      1,
      now,
      now,
    );
}

function seedDefaultTalkAgent(database: Database.Database): void {
  const now = new Date().toISOString();
  const modelId = getSeedClaudeModel(database);
  const toolPermissions = JSON.stringify({
    web: true,
    connectors: true,
    google_read: true,
    google_write: true,
    gmail_read: true,
    gmail_send: true,
    messaging: true,
  });

  database
    .prepare(
      `
      INSERT INTO registered_agents (
        id, name, provider_id, model_id, tool_permissions_json,
        persona_role, system_prompt, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `,
    )
    .run(
      'agent.talk',
      'Claude',
      'provider.anthropic',
      modelId,
      toolPermissions,
      'assistant',
      null,
      1,
      now,
      now,
    );
}

function seedSystemUsers(database: Database.Database): void {
  const now = new Date().toISOString();

  database
    .prepare(
      `
      INSERT INTO users (
        id, email, display_name, user_type, role, is_active, created_at, last_login_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        display_name = excluded.display_name,
        user_type = excluded.user_type,
        role = excluded.role,
        is_active = excluded.is_active
    `,
    )
    .run(
      'system:channel-ingress',
      'channel-ingress@local.invalid',
      'Channel Ingress',
      'system',
      'member',
      0,
      now,
    );
}

function seedDefaultSettings(database: Database.Database): void {
  const now = new Date().toISOString();

  database
    .prepare(
      `
      INSERT INTO settings_kv (key, value, updated_at, updated_by)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(key) DO NOTHING
    `,
    )
    .run('system.mainAgentId', 'agent.main', now);

  database
    .prepare(
      `
      INSERT INTO settings_kv (key, value, updated_at, updated_by)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(key) DO NOTHING
    `,
    )
    .run('system.defaultTalkAgentId', 'agent.talk', now);
}

function createClawrocketSchema(database: Database.Database): void {
  // Run additive/thread migrations BEFORE the schema exec block, because the
  // exec block contains CREATE INDEX statements that reference newer columns.
  // For fresh databases the tables don't exist yet, so these are no-ops.
  migrateAddThreadIdColumns(database);
  migrateAddMissingColumns(database);

  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      user_type TEXT NOT NULL DEFAULT 'human'
        CHECK(user_type IN ('human', 'system')),
      role TEXT NOT NULL DEFAULT 'member'
        CHECK(role IN ('owner', 'admin', 'member')),
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS user_invites (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
      invited_by TEXT NOT NULL REFERENCES users(id),
      accepted INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      accepted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_user_invites_email ON user_invites(email);

    CREATE TABLE IF NOT EXISTS web_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      access_token_hash TEXT NOT NULL UNIQUE,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      access_expires_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      rotated_from TEXT REFERENCES web_sessions(id),
      device_id TEXT,
      created_at TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_web_sessions_user_id ON web_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_web_sessions_expires_at ON web_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS oauth_state (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      state_hash TEXT NOT NULL UNIQUE,
      nonce_hash TEXT NOT NULL,
      code_verifier_hash TEXT NOT NULL,
      code_verifier TEXT,
      redirect_uri TEXT NOT NULL,
      return_to TEXT,
      requested_by_user_id TEXT REFERENCES users(id),
      requested_by_session_id TEXT REFERENCES web_sessions(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_state_expires_at ON oauth_state(expires_at);

    CREATE TABLE IF NOT EXISTS device_auth_codes (
      id TEXT PRIMARY KEY,
      device_code_hash TEXT NOT NULL UNIQUE,
      user_code_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'completed', 'expired')),
      user_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_device_auth_status_expires
      ON device_auth_codes(status, expires_at);

    CREATE TABLE IF NOT EXISTS user_google_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      google_subject TEXT NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT,
      scopes_json TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      access_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_google_credentials_user_id_unique
      ON user_google_credentials(user_id);

    CREATE TABLE IF NOT EXISTS google_oauth_link_requests (
      state_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scopes_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_google_oauth_link_requests_user_id
      ON google_oauth_link_requests(user_id, created_at);

    CREATE TABLE IF NOT EXISTS llm_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_kind TEXT NOT NULL
        CHECK(provider_kind IN ('anthropic', 'openai', 'gemini', 'deepseek', 'kimi', 'nvidia', 'custom')),
      api_format TEXT NOT NULL
        CHECK(api_format IN ('anthropic_messages', 'openai_chat_completions')),
      base_url TEXT NOT NULL,
      auth_scheme TEXT NOT NULL
        CHECK(auth_scheme IN ('x_api_key', 'bearer')),
      enabled INTEGER NOT NULL DEFAULT 1,
      core_compatibility TEXT NOT NULL DEFAULT 'none'
        CHECK(core_compatibility IN ('none', 'claude_sdk_proxy')),
      response_start_timeout_ms INTEGER,
      stream_idle_timeout_ms INTEGER,
      absolute_timeout_ms INTEGER,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS llm_provider_models (
      provider_id TEXT NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      context_window_tokens INTEGER NOT NULL,
      default_max_output_tokens INTEGER NOT NULL,
      default_ttft_timeout_ms INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id),
      PRIMARY KEY (provider_id, model_id)
    );

    CREATE TABLE IF NOT EXISTS llm_ttft_stats (
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      p50_ms REAL NOT NULL DEFAULT 0,
      p95_ms REAL NOT NULL DEFAULT 0,
      p99_ms REAL NOT NULL DEFAULT 0,
      max_ms REAL NOT NULL DEFAULT 0,
      last_updated_at TEXT NOT NULL,
      PRIMARY KEY (provider_id, model_id),
      FOREIGN KEY (provider_id, model_id)
        REFERENCES llm_provider_models(provider_id, model_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS llm_provider_secrets (
      provider_id TEXT PRIMARY KEY REFERENCES llm_providers(id) ON DELETE CASCADE,
      ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS llm_provider_verifications (
      provider_id TEXT PRIMARY KEY REFERENCES llm_providers(id) ON DELETE CASCADE,
      status TEXT NOT NULL
        CHECK(status IN ('missing', 'not_verified', 'verifying', 'verified', 'invalid', 'unavailable')),
      last_verified_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS registered_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      tool_permissions_json TEXT NOT NULL,
      persona_role TEXT,
      system_prompt TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_registered_agents_enabled_name
      ON registered_agents(enabled, name);

    CREATE TABLE IF NOT EXISTS agent_fallback_steps (
      agent_id TEXT NOT NULL REFERENCES registered_agents(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      provider_id TEXT NOT NULL REFERENCES llm_providers(id),
      model_id TEXT NOT NULL,
      PRIMARY KEY (agent_id, position),
      FOREIGN KEY (provider_id, model_id)
        REFERENCES llm_provider_models(provider_id, model_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_tool_permissions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tool_id TEXT NOT NULL,
      allowed INTEGER NOT NULL DEFAULT 1,
      requires_approval INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, tool_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_tool_permissions_user_id
      ON user_tool_permissions(user_id);

    CREATE TABLE IF NOT EXISTS data_connectors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      connector_kind TEXT NOT NULL
        CHECK(connector_kind IN ('google_docs', 'google_sheets', 'posthog')),
      config_json TEXT,
      discovered_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id),
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_data_connectors_kind_enabled
      ON data_connectors(connector_kind, enabled);

    CREATE TABLE IF NOT EXISTS data_connector_secrets (
      connector_id TEXT PRIMARY KEY REFERENCES data_connectors(id) ON DELETE CASCADE,
      ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS data_connector_verifications (
      connector_id TEXT PRIMARY KEY REFERENCES data_connectors(id) ON DELETE CASCADE,
      status TEXT NOT NULL
        CHECK(status IN ('not_verified', 'verifying', 'verified', 'invalid', 'unavailable')),
      last_verified_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_connections (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      connection_mode TEXT NOT NULL,
      account_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      health_status TEXT NOT NULL DEFAULT 'healthy',
      last_health_check_at TEXT,
      last_health_error TEXT,
      consecutive_probe_failures INTEGER NOT NULL DEFAULT 0,
      config_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id),
      updated_by TEXT REFERENCES users(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_connections_platform_account
      ON channel_connections(platform, account_key);

    CREATE TABLE IF NOT EXISTS channel_connection_secrets (
      connection_id TEXT PRIMARY KEY REFERENCES channel_connections(id) ON DELETE CASCADE,
      ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS channel_provider_configs (
      platform TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS channel_provider_secrets (
      platform TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS channel_targets (
      connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      metadata_json TEXT,
      approved INTEGER NOT NULL DEFAULT 0,
      registered_at TEXT,
      registered_by TEXT REFERENCES users(id),
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (connection_id, target_kind, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_targets_connection_seen
      ON channel_targets(connection_id, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS talk_folders (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_talk_folders_owner_sort
      ON talk_folders(owner_id, sort_order, updated_at);

    CREATE TABLE IF NOT EXISTS talks (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder_id TEXT REFERENCES talk_folders(id) ON DELETE SET NULL,
      topic_title TEXT,
      project_path TEXT,
      orchestration_mode TEXT NOT NULL DEFAULT 'ordered'
        CHECK(orchestration_mode IN ('ordered', 'panel')),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'paused', 'archived')),
      sort_order REAL NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_talks_owner_folder_sort
      ON talks(owner_id, folder_id, sort_order, updated_at);

    CREATE TABLE IF NOT EXISTS talk_members (
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('viewer', 'editor')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (talk_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_members_user_id ON talk_members(user_id);

    CREATE TABLE IF NOT EXISTS talk_messages (
      id TEXT PRIMARY KEY,
      talk_id TEXT REFERENCES talks(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      run_id TEXT,
      sequence_in_run INTEGER,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_talk_messages_talk_created_at
      ON talk_messages(talk_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_talk_messages_thread_id
      ON talk_messages(thread_id);

    CREATE TABLE IF NOT EXISTS talk_threads (
      id TEXT PRIMARY KEY,
      talk_id TEXT REFERENCES talks(id) ON DELETE CASCADE,
      title TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_internal INTEGER NOT NULL DEFAULT 0,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_talk_threads_talk_id
      ON talk_threads(talk_id);

    CREATE TABLE IF NOT EXISTS main_threads (
      thread_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_main_threads_user_id_updated_at
      ON main_threads(user_id, updated_at);

    CREATE TABLE IF NOT EXISTS main_thread_summaries (
      thread_id TEXT PRIMARY KEY REFERENCES main_threads(thread_id) ON DELETE CASCADE,
      summary_text TEXT NOT NULL,
      covers_through_message_id TEXT REFERENCES talk_messages(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS talk_tool_grants (
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      tool_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id),
      PRIMARY KEY (talk_id, tool_id)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_tool_grants_talk_id
      ON talk_tool_grants(talk_id);

    CREATE TABLE IF NOT EXISTS talk_resource_bindings (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      binding_kind TEXT NOT NULL
        CHECK(binding_kind IN ('google_drive_folder', 'google_drive_file', 'data_connector', 'saved_source', 'message_attachment')),
      external_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_resource_bindings_talk_id
      ON talk_resource_bindings(talk_id, created_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_talk_resource_bindings_unique_scope
      ON talk_resource_bindings(talk_id, binding_kind, external_id);

    CREATE TABLE IF NOT EXISTS talk_message_attachments (
      id TEXT PRIMARY KEY,
      talk_id TEXT REFERENCES talks(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES talk_messages(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      file_size INTEGER,
      mime_type TEXT,
      storage_key TEXT NOT NULL,
      extracted_text TEXT,
      extraction_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(extraction_status IN ('pending', 'ready', 'failed')),
      extraction_error TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_talk_message_attachments_message_id
      ON talk_message_attachments(message_id);
    CREATE INDEX IF NOT EXISTS idx_talk_message_attachments_talk_created
      ON talk_message_attachments(talk_id, created_at);

    CREATE TABLE IF NOT EXISTS browser_profiles (
      id TEXT PRIMARY KEY,
      site_key TEXT NOT NULL,
      account_label TEXT,
      profile_path TEXT NOT NULL,
      channel TEXT NOT NULL,
      locale TEXT NOT NULL,
      timezone_id TEXT NOT NULL,
      user_agent TEXT,
      viewport_json TEXT NOT NULL,
      policy_json TEXT,
      download_dir TEXT NOT NULL,
      connection_mode TEXT NOT NULL DEFAULT 'managed',
      connection_config_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_browser_profiles_site_last_used
      ON browser_profiles(site_key, last_used_at DESC, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_profiles_site_account
      ON browser_profiles(site_key, COALESCE(account_label, ''));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_profiles_path
      ON browser_profiles(profile_path);

    CREATE TABLE IF NOT EXISTS browser_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      profile_id TEXT REFERENCES browser_profiles(id) ON DELETE SET NULL,
      profile_key TEXT NOT NULL,
      site_key TEXT NOT NULL,
      account_label TEXT,
      state TEXT NOT NULL
        CHECK(state IN ('active', 'blocked', 'takeover', 'disconnected', 'closed')),
      blocked_reason TEXT,
      owner_run_id TEXT REFERENCES talk_runs(id) ON DELETE SET NULL,
      last_seen_at TEXT NOT NULL,
      last_live_context_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_browser_sessions_profile_key
      ON browser_sessions(profile_key, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_browser_sessions_owner_run
      ON browser_sessions(owner_run_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_browser_sessions_site_state
      ON browser_sessions(site_key, state, updated_at DESC);

    CREATE TABLE IF NOT EXISTS talk_context_summary (
      talk_id TEXT PRIMARY KEY REFERENCES talks(id) ON DELETE CASCADE,
      summary_text TEXT NOT NULL,
      covers_through_message_id TEXT REFERENCES talk_messages(id),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS talk_context_goal (
      talk_id TEXT PRIMARY KEY REFERENCES talks(id) ON DELETE CASCADE,
      goal_text TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS talk_context_rules (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      rule_text TEXT NOT NULL,
      sort_order REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_talk_context_rules_talk_sort
      ON talk_context_rules(talk_id, sort_order, created_at);

    CREATE TABLE IF NOT EXISTS talk_state_entries (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_by_run_id TEXT REFERENCES talk_runs(id) ON DELETE SET NULL,
      UNIQUE(talk_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_state_entries_talk_updated
      ON talk_state_entries(talk_id, updated_at DESC, key ASC);

    CREATE TABLE IF NOT EXISTS talk_outputs (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content_markdown TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_by_run_id TEXT REFERENCES talk_runs(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_talk_outputs_talk_updated
      ON talk_outputs(talk_id, updated_at DESC, id ASC);

    CREATE TABLE IF NOT EXISTS talk_jobs (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      target_agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      status TEXT NOT NULL
        CHECK(status IN ('active', 'paused', 'blocked')),
      schedule_json TEXT NOT NULL,
      timezone TEXT NOT NULL,
      deliverable_kind TEXT NOT NULL
        CHECK(deliverable_kind IN ('thread', 'report')),
      report_output_id TEXT REFERENCES talk_outputs(id) ON DELETE SET NULL,
      source_scope_json TEXT NOT NULL,
      thread_id TEXT NOT NULL REFERENCES talk_threads(id) ON DELETE CASCADE,
      last_run_at TEXT,
      last_run_status TEXT,
      next_due_at TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_jobs_talk_updated
      ON talk_jobs(talk_id, updated_at DESC, created_at DESC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_talk_jobs_due_status
      ON talk_jobs(status, next_due_at, created_at);

    CREATE TABLE IF NOT EXISTS talk_context_sources (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      source_ref TEXT NOT NULL,
      source_type TEXT NOT NULL
        CHECK(source_type IN ('url', 'file', 'text')),
      title TEXT,
      note TEXT,
      sort_order REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'ready', 'failed')),
      source_url TEXT,
      file_name TEXT,
      file_size INTEGER,
      mime_type TEXT,
      storage_key TEXT,
      extracted_text TEXT,
      extracted_at TEXT,
      last_fetched_at TEXT,
      extraction_error TEXT,
      fetch_strategy TEXT
        CHECK(fetch_strategy IN ('http', 'browser', 'managed') OR fetch_strategy IS NULL),
      is_truncated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_context_sources_talk_sort
      ON talk_context_sources(talk_id, sort_order, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_talk_context_sources_ref
      ON talk_context_sources(talk_id, source_ref);

    CREATE TABLE IF NOT EXISTS talk_context_source_ref_counter (
      talk_id TEXT PRIMARY KEY REFERENCES talks(id) ON DELETE CASCADE,
      next_ref_number INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS talk_agents (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      registered_agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      source_kind TEXT NOT NULL DEFAULT 'provider'
        CHECK(source_kind IN ('claude_default', 'provider')),
      provider_id TEXT,
      model_id TEXT,
      nickname TEXT,
      nickname_mode TEXT NOT NULL DEFAULT 'auto'
        CHECK(nickname_mode IN ('auto', 'custom')),
      persona_role TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      sort_order REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_talk_agents_talk_sort
      ON talk_agents(talk_id, sort_order, created_at);
    CREATE INDEX IF NOT EXISTS idx_talk_agents_registered_agent_id
      ON talk_agents(registered_agent_id);

    CREATE TABLE IF NOT EXISTS talk_data_connectors (
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      connector_id TEXT NOT NULL REFERENCES data_connectors(id) ON DELETE CASCADE,
      attached_at TEXT NOT NULL,
      attached_by TEXT REFERENCES users(id),
      PRIMARY KEY (talk_id, connector_id)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_data_connectors_connector
      ON talk_data_connectors(connector_id);

    CREATE TABLE IF NOT EXISTS talk_llm_policies (
      talk_id TEXT PRIMARY KEY REFERENCES talks(id) ON DELETE CASCADE,
      llm_policy TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS talk_executor_sessions (
      talk_id TEXT PRIMARY KEY REFERENCES talks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      executor_alias TEXT NOT NULL,
      executor_model TEXT NOT NULL,
      session_compat_key TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS talk_channel_bindings (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      display_name TEXT,
      response_mode TEXT NOT NULL DEFAULT 'mentions'
        CHECK(response_mode IN ('off', 'mentions', 'all')),
      responder_agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      allowed_senders_json TEXT,
      rate_limit_json TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      last_ingress_at TEXT,
      last_delivery_at TEXT,
      last_delivery_error_code TEXT,
      last_delivery_error_detail TEXT,
      last_delivery_error_at TEXT,
      health_quarantined INTEGER NOT NULL DEFAULT 0,
      health_quarantine_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id),
      updated_by TEXT REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_channel_bindings_talk
      ON talk_channel_bindings(talk_id, active, created_at);

    CREATE TABLE IF NOT EXISTS talk_channel_policies (
      binding_id TEXT PRIMARY KEY REFERENCES talk_channel_bindings(id) ON DELETE CASCADE,
      response_mode TEXT NOT NULL DEFAULT 'mentions'
        CHECK(response_mode IN ('off', 'mentions', 'all')),
      responder_mode TEXT NOT NULL DEFAULT 'primary'
        CHECK(responder_mode IN ('primary', 'agent')),
      responder_agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      delivery_mode TEXT NOT NULL DEFAULT 'reply'
        CHECK(delivery_mode IN ('reply', 'channel')),
      thread_mode TEXT NOT NULL DEFAULT 'conversation'
        CHECK(thread_mode IN ('conversation')),
      timezone TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_CHANNEL_BINDING_TIMEZONE)},
      instructions TEXT,
      allowed_senders_json TEXT,
      inbound_rate_limit_per_minute INTEGER,
      max_pending_events INTEGER DEFAULT 20,
      overflow_policy TEXT NOT NULL DEFAULT 'drop_oldest'
        CHECK(overflow_policy IN ('drop_oldest', 'drop_newest')),
      max_deferred_age_minutes INTEGER DEFAULT 60,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS talk_channel_thread_map (
      binding_id TEXT NOT NULL REFERENCES talk_channel_bindings(id) ON DELETE CASCADE,
      source_thread_key TEXT NOT NULL,
      talk_thread_id TEXT NOT NULL REFERENCES talk_threads(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (binding_id, source_thread_key)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_channel_thread_map_thread
      ON talk_channel_thread_map(talk_thread_id);

    CREATE TABLE IF NOT EXISTS talk_runs (
      id TEXT PRIMARY KEY,
      talk_id TEXT REFERENCES talks(id) ON DELETE CASCADE,
      requested_by TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL
        CHECK(status IN ('queued', 'running', 'awaiting_confirmation', 'cancelled', 'completed', 'failed')),
      trigger_message_id TEXT REFERENCES talk_messages(id),
      job_id TEXT REFERENCES talk_jobs(id) ON DELETE SET NULL,
      target_agent_id TEXT,
      agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      executor_alias TEXT,
      executor_model TEXT,
      thread_id TEXT NOT NULL,
      run_kind TEXT NOT NULL DEFAULT 'conversation'
        CHECK(run_kind IN ('conversation', 'instruction_review')),
      idempotency_key TEXT,
      response_group_id TEXT,
      sequence_index INTEGER,
      source_binding_id TEXT,
      source_external_message_id TEXT,
      source_thread_key TEXT,
      task_type TEXT
        CHECK(task_type IN ('chat', 'browser')),
      browser_phase TEXT
        CHECK(browser_phase IN ('starting', 'interacting', 'summarizing')),
      blocked_reason TEXT
        CHECK(blocked_reason IN ('login_required', 'phone_approval', 'app_approval', 'code_entry', 'session_conflict', 'manual_takeover')),
      browser_session_id TEXT,
      selected_mode TEXT
        CHECK(selected_mode IN ('api', 'subscription')),
      transport TEXT
        CHECK(transport IN ('direct', 'subscription')),
      timeout_phase TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      cancel_reason TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_talk_runs_talk_id_status
      ON talk_runs(talk_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_talk_runs_status_created_at
      ON talk_runs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_talk_runs_group_sequence
      ON talk_runs(response_group_id, sequence_index, created_at);
    CREATE INDEX IF NOT EXISTS idx_talk_runs_thread_status_created
      ON talk_runs(thread_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_talk_runs_browser_session
      ON talk_runs(browser_session_id, status, created_at);

    CREATE TABLE IF NOT EXISTS run_confirmations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES talk_runs(id) ON DELETE CASCADE,
      talk_id TEXT REFERENCES talks(id) ON DELETE CASCADE,
      tool_id TEXT NOT NULL,
      action_summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'approved', 'rejected')),
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_run_confirmations_run_status
      ON run_confirmations(run_id, status, created_at);

    CREATE TABLE IF NOT EXISTS llm_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES talk_runs(id) ON DELETE CASCADE,
      talk_id TEXT REFERENCES talks(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      provider_id TEXT REFERENCES llm_providers(id) ON DELETE SET NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK(status IN ('success', 'failed', 'skipped', 'cancelled')),
      failure_class TEXT,
      latency_ms INTEGER,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      estimated_cost_usd REAL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_attempts_run_id ON llm_attempts(run_id);
    CREATE INDEX IF NOT EXISTS idx_llm_attempts_talk_id_created_at
      ON llm_attempts(talk_id, created_at);

    CREATE TABLE IF NOT EXISTS channel_ingress_queue (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES talk_channel_bindings(id) ON DELETE CASCADE,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      platform_event_id TEXT,
      external_message_id TEXT,
      sender_id TEXT,
      sender_name TEXT,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'deferred', 'processing', 'completed', 'dropped', 'dead_letter')),
      reason_code TEXT,
      reason_detail TEXT,
      dedupe_key TEXT NOT NULL UNIQUE,
      available_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_channel_ingress_queue_status_available
      ON channel_ingress_queue(status, available_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_ingress_queue_binding_status_available
      ON channel_ingress_queue(binding_id, status, available_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_ingress_queue_talk_status_available
      ON channel_ingress_queue(talk_id, status, available_at, created_at);

    CREATE TABLE IF NOT EXISTS channel_outbound_queue (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      binding_id TEXT NOT NULL REFERENCES talk_channel_bindings(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES talk_runs(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'sent', 'failed', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      next_retry_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_channel_outbound_queue_status_available
      ON channel_outbound_queue(status, next_retry_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_outbound_queue_binding_status
      ON channel_outbound_queue(binding_id, status, created_at);

    CREATE TABLE IF NOT EXISTS channel_delivery_outbox (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      run_id TEXT,
      talk_message_id TEXT,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'dead_letter', 'dropped')),
      reason_code TEXT,
      reason_detail TEXT,
      dedupe_key TEXT,
      available_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_channel_delivery_outbox_status
      ON channel_delivery_outbox(status, available_at);

    CREATE TABLE IF NOT EXISTS settings_kv (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS event_outbox (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_outbox_topic_event_id
      ON event_outbox(topic, event_id);

    CREATE TABLE IF NOT EXISTS dead_letter_queue (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      payload TEXT,
      error_class TEXT NOT NULL,
      error_detail TEXT,
      attempts INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_retry_at TEXT,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dead_letter_created_at
      ON dead_letter_queue(created_at);

    CREATE TABLE IF NOT EXISTS idempotency_cache (
      idempotency_key TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (idempotency_key, user_id, method, path)
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at
      ON idempotency_cache(expires_at);
  `);

  // ---------------------------------------------------------------------------
  // Migrations for existing databases — MUST run before seeds, because seeds
  // reference columns that may not exist yet in older databases.
  // ---------------------------------------------------------------------------
  migrateTalkAgentsTable(database);
  migrateRegisteredAgentsTable(database);
  migrateTalkMessagesTable(database);
  migrateTalkRunsTable(database);
  migrateAddTtftSupport(database);
  migrateAddThreadIdColumns(database);
  migrateLlmAttemptsTable(database);
  migrateLlmAttemptsCachedInputTokensColumn(database);
  migrateAddMissingColumns(database);
  ensureJobsSupportIndexes(database);

  // ---------------------------------------------------------------------------
  // PR #105 — Comprehensive schema-audit migrations.
  // Fixes every NOT NULL / type / default mismatch discovered between the live
  // database and the current CREATE TABLE definitions so that no more runtime
  // crashes occur due to constraint violations on stale schemas.
  // ---------------------------------------------------------------------------
  migrateSettingsKvTable(database);
  migrateTalkMessageAttachmentsTable(database);
  migrateTalkContextGoalTable(database);
  migrateTalkContextSourcesTable(database);
  migrateTalkContextRulesTable(database);
  migrateChannelIngressQueueTable(database);
  migrateChannelDeliveryOutboxTable(database);
  migrateDataConnectorsTable(database);
  migrateDeadLetterQueueTable(database);
  migrateTalkChannelPoliciesTable(database);
  migrateTalkChannelBindingsTable(database);
  migrateTalksTable(database);
  migrateMainThreadSummariesTable(database);

  // ---------------------------------------------------------------------------
  // Phase 4 — Thread formalization.
  // Creates talk_threads rows for existing data and backfills thread_id on
  // talk_messages and talk_runs so every message/run belongs to a thread.
  // ---------------------------------------------------------------------------
  migrateBackfillThreads(database);
  migrateEnforceThreadIdsNotNull(database);
  migrateGoogleToolingTables(database);

  migrateChannelBindingHealthColumns(database);
  migrateActiveTalkChannelBindingUniqueness(database);
  migrateConnectionProbeFailuresColumn(database);
  migrateChannelConnectionSecretsTable(database);
  migrateChannelProviderConfigTables(database);
  migrateChannelTargetRegistryColumns(database);
  migrateTalkChannelThreadMapTable(database);
  migrateOAuthStateRequesterColumns(database);

  migrateMainAgentToAnthropic(database);

  seedBuiltinLlmProvider(database);
  seedAnthropicProvider(database);
  seedAdditionalProviders(database);
  seedMainAgent(database);
  seedDefaultTalkAgent(database);
  seedSystemUsers(database);
  seedDefaultSettings(database);
}

/**
 * Rebuild talk_agents to:
 *  - relax registered_agent_id from NOT NULL to nullable
 *  - add source_kind, provider_id, model_id, nickname, nickname_mode
 *
 * Idempotent: skips if the new columns already exist.
 */
function migrateTalkAgentsTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(talk_agents)`)
    .all() as Array<{ name: string; notnull: number }>;
  if (columns.length === 0) return; // table doesn't exist yet

  const hasSourceKind = columns.some((c) => c.name === 'source_kind');
  // Also rebuild if the legacy `name` NOT NULL column exists — the new
  // schema removed it in favour of `nickname` (nullable).
  const hasLegacyNameCol = columns.some(
    (c) => c.name === 'name' && c.notnull === 1,
  );
  if (hasSourceKind && !hasLegacyNameCol) return; // already fully migrated

  database.exec(`
    -- 1. Copy existing rows into a temp table
    CREATE TABLE talk_agents_migration_backup AS SELECT * FROM talk_agents;

    -- 2. Drop old table + indexes
    DROP TABLE talk_agents;

    -- 3. Recreate with new schema (matches the CREATE TABLE in createClawrocketSchema)
    CREATE TABLE talk_agents (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      registered_agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      source_kind TEXT NOT NULL DEFAULT 'provider'
        CHECK(source_kind IN ('claude_default', 'provider')),
      provider_id TEXT,
      model_id TEXT,
      nickname TEXT,
      nickname_mode TEXT NOT NULL DEFAULT 'auto'
        CHECK(nickname_mode IN ('auto', 'custom')),
      persona_role TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      sort_order REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_talk_agents_talk_sort
      ON talk_agents(talk_id, sort_order, created_at);
    CREATE INDEX idx_talk_agents_registered_agent_id
      ON talk_agents(registered_agent_id);

    -- 4. Copy old rows back, JOIN registered_agents to backfill
    --    provider_id, model_id, and nickname from the registered agent.
    INSERT INTO talk_agents (
      id, talk_id, registered_agent_id,
      source_kind, provider_id, model_id,
      nickname, nickname_mode,
      persona_role, is_primary, sort_order,
      created_at, updated_at
    )
    SELECT
      bak.id,
      bak.talk_id,
      bak.registered_agent_id,
      'provider',
      ra.provider_id,
      ra.model_id,
      ra.name,
      'auto',
      bak.persona_role,
      bak.is_primary,
      bak.sort_order,
      bak.created_at,
      bak.updated_at
    FROM talk_agents_migration_backup bak
    LEFT JOIN registered_agents ra ON ra.id = bak.registered_agent_id;

    -- 5. Clean up
    DROP TABLE talk_agents_migration_backup;
  `);
}

/**
 * Add adaptive TTFT timeout support:
 *  - default_ttft_timeout_ms column on llm_provider_models
 *  - llm_ttft_stats table for recording observed TTFT
 *
 * Idempotent: skips if the column already exists.
 */
function migrateAddTtftSupport(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(llm_provider_models)`)
    .all() as Array<{ name: string }>;
  const hasTtft = columns.some((c) => c.name === 'default_ttft_timeout_ms');
  if (hasTtft) return; // already migrated or fresh DB

  database.exec(`
    ALTER TABLE llm_provider_models ADD COLUMN default_ttft_timeout_ms INTEGER;
  `);

  // llm_ttft_stats is created in createClawrocketSchema via IF NOT EXISTS,
  // but for existing DBs that ran schema creation before this table existed:
  database.exec(`
    CREATE TABLE IF NOT EXISTS llm_ttft_stats (
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      p50_ms REAL NOT NULL DEFAULT 0,
      p95_ms REAL NOT NULL DEFAULT 0,
      p99_ms REAL NOT NULL DEFAULT 0,
      max_ms REAL NOT NULL DEFAULT 0,
      last_updated_at TEXT NOT NULL,
      PRIMARY KEY (provider_id, model_id),
      FOREIGN KEY (provider_id, model_id)
        REFERENCES llm_provider_models(provider_id, model_id)
        ON DELETE CASCADE
    );
  `);

  // Seed sensible defaults for known Anthropic models
  database.exec(`
    UPDATE llm_provider_models SET default_ttft_timeout_ms = 90000
      WHERE provider_id = 'provider.anthropic' AND model_id LIKE '%sonnet%';
    UPDATE llm_provider_models SET default_ttft_timeout_ms = 180000
      WHERE provider_id = 'provider.anthropic' AND model_id LIKE '%opus%';
    UPDATE llm_provider_models SET default_ttft_timeout_ms = 30000
      WHERE provider_id = 'provider.anthropic' AND model_id LIKE '%haiku%';
  `);
}

/**
 * Add thread_id column to talk_messages and talk_runs for existing databases.
 * Fresh databases already have the column from the CREATE TABLE statement.
 * Idempotent: skips if the table doesn't exist yet OR the column already exists.
 */
function migrateAddThreadIdColumns(database: Database.Database): void {
  for (const table of ['talk_messages', 'talk_runs']) {
    const cols = database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    // Table doesn't exist yet (fresh DB) — the CREATE TABLE will add it
    if (cols.length === 0) continue;
    // Column already present — nothing to do
    if (cols.some((c) => c.name === 'thread_id')) continue;
    database.exec(`ALTER TABLE ${table} ADD COLUMN thread_id TEXT;`);
  }
}

/**
 * Rebuild registered_agents if it contains legacy columns (e.g. route_id)
 * that conflict with the current schema.  The old table may have NOT NULL
 * columns the new code doesn't populate, causing INSERT failures.
 *
 * Idempotent: skips if the table already matches the new schema (no route_id).
 */
function migrateRegisteredAgentsTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(registered_agents)`)
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return; // table doesn't exist yet (fresh DB)
  const hasRouteId = columns.some((c) => c.name === 'route_id');
  if (!hasRouteId) return; // already on new schema

  database.exec(`
    -- 1. Backup existing rows
    CREATE TABLE registered_agents_migration_backup AS
      SELECT * FROM registered_agents;

    -- 2. Drop old table + indexes
    DROP TABLE registered_agents;

    -- 3. Recreate with current schema
    CREATE TABLE registered_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      tool_permissions_json TEXT NOT NULL DEFAULT '{}',
      persona_role TEXT,
      system_prompt TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_registered_agents_enabled_name
      ON registered_agents(enabled, name);

    -- 4. Copy rows back, mapping old columns to new schema
    INSERT INTO registered_agents (
      id, name, provider_id, model_id,
      tool_permissions_json, enabled,
      created_at, updated_at
    )
    SELECT
      id, name, provider_id, model_id,
      COALESCE(
        CASE WHEN typeof(tool_permissions_json) = 'text' THEN tool_permissions_json END,
        '{}'
      ),
      enabled, created_at, updated_at
    FROM registered_agents_migration_backup;

    -- 5. Clean up
    DROP TABLE registered_agents_migration_backup;
  `);
}

/**
 * Rebuild talk_messages if talk_id has a NOT NULL constraint.
 * The new schema allows NULL talk_id for thread-based (Main) messages.
 *
 * Idempotent: skips if talk_id is already nullable or table doesn't exist.
 */
function migrateTalkMessagesTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(talk_messages)`)
    .all() as Array<{ name: string; notnull: number }>;
  if (columns.length === 0) return; // table doesn't exist yet
  const talkIdCol = columns.find((c) => c.name === 'talk_id');
  if (!talkIdCol || talkIdCol.notnull === 0) return; // already nullable

  database.exec(`
    -- 1. Backup
    CREATE TABLE talk_messages_migration_backup AS
      SELECT * FROM talk_messages;

    -- 2. Drop old table + indexes
    DROP TABLE talk_messages;

    -- 3. Recreate with current schema (talk_id nullable)
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
    CREATE INDEX idx_talk_messages_talk_created_at
      ON talk_messages(talk_id, created_at);
    CREATE INDEX idx_talk_messages_thread_id
      ON talk_messages(thread_id);

    -- 4. Copy rows back (old table may not have all columns)
    INSERT INTO talk_messages (
      id, talk_id, role, content, created_by, created_at
    )
    SELECT
      id, talk_id, role, content, created_by, created_at
    FROM talk_messages_migration_backup;

    -- 5. Clean up
    DROP TABLE talk_messages_migration_backup;
  `);
}

/**
 * Rebuild talk_runs if talk_id has a NOT NULL constraint.
 * The new schema allows NULL talk_id for thread-based (Main) runs.
 *
 * Idempotent: skips if talk_id is already nullable or table doesn't exist.
 */
function migrateTalkRunsTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(talk_runs)`)
    .all() as Array<{ name: string; notnull: number }>;
  if (columns.length === 0) return; // table doesn't exist yet
  const talkIdCol = columns.find((c) => c.name === 'talk_id');
  if (!talkIdCol || talkIdCol.notnull === 0) return; // already nullable

  database.exec(`
    -- 1. Backup
    CREATE TABLE talk_runs_migration_backup AS
      SELECT * FROM talk_runs;

    -- 2. Drop old table + indexes
    DROP TABLE talk_runs;

    -- 3. Recreate with current schema (talk_id nullable)
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
      run_kind TEXT NOT NULL DEFAULT 'conversation'
        CHECK(run_kind IN ('conversation', 'instruction_review')),
      idempotency_key TEXT,
      response_group_id TEXT,
      sequence_index INTEGER,
      source_binding_id TEXT,
      source_external_message_id TEXT,
      source_thread_key TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      cancel_reason TEXT
    );
    CREATE INDEX idx_talk_runs_talk_id_status
      ON talk_runs(talk_id, status, created_at);
    CREATE INDEX idx_talk_runs_status_created_at
      ON talk_runs(status, created_at);
    CREATE INDEX idx_talk_runs_group_sequence
      ON talk_runs(response_group_id, sequence_index, created_at);

    -- 4. Copy rows back (old table may not have all columns)
    INSERT INTO talk_runs (
      id, talk_id, requested_by, status,
      trigger_message_id, run_kind, created_at,
      started_at, ended_at, cancel_reason
    )
    SELECT
      id, talk_id, requested_by, status, trigger_message_id, 'conversation',
      created_at,
      started_at, ended_at, cancel_reason
    FROM talk_runs_migration_backup;

    -- 5. Clean up
    DROP TABLE talk_runs_migration_backup;
  `);
}

/**
 * Generic catch-all migration for columns added to CREATE TABLE statements
 * after the user's database was first created.  `CREATE TABLE IF NOT EXISTS`
 * does NOT add new columns to existing tables, so we must ALTER them in.
 *
 * Each entry is { table, column, definition }.  Idempotent: skips if the
 * table doesn't exist yet (fresh DB) or the column already exists.
 *
 * Add new entries here whenever a column is added to an existing table's
 * CREATE TABLE statement.
 */
function migrateAddMissingColumns(database: Database.Database): void {
  const additions: Array<{
    table: string;
    column: string;
    definition: string;
  }> = [
    // registered_agents — columns added after initial schema
    {
      table: 'registered_agents',
      column: 'tool_permissions_json',
      definition: "TEXT NOT NULL DEFAULT '{}'",
    },
    {
      table: 'registered_agents',
      column: 'persona_role',
      definition: 'TEXT',
    },
    {
      table: 'registered_agents',
      column: 'system_prompt',
      definition: 'TEXT',
    },
    // talks — folder + ordering support
    {
      table: 'talks',
      column: 'folder_id',
      definition: 'TEXT',
    },
    {
      table: 'talks',
      column: 'sort_order',
      definition: 'REAL NOT NULL DEFAULT 0',
    },
    // talk_runs — columns added for thread / multi-agent support
    {
      table: 'talk_runs',
      column: 'target_agent_id',
      definition: 'TEXT',
    },
    {
      table: 'talk_runs',
      column: 'idempotency_key',
      definition: 'TEXT',
    },
    {
      table: 'talk_runs',
      column: 'executor_alias',
      definition: 'TEXT',
    },
    {
      table: 'talk_runs',
      column: 'executor_model',
      definition: 'TEXT',
    },
    {
      table: 'talk_runs',
      column: 'run_kind',
      definition:
        "TEXT NOT NULL DEFAULT 'conversation' CHECK(run_kind IN ('conversation', 'instruction_review'))",
    },
    {
      table: 'talks',
      column: 'orchestration_mode',
      definition: "TEXT NOT NULL DEFAULT 'ordered'",
    },
    {
      table: 'talks',
      column: 'project_path',
      definition: 'TEXT',
    },
    {
      table: 'talk_runs',
      column: 'source_binding_id',
      definition: 'TEXT',
    },
    {
      table: 'talk_runs',
      column: 'response_group_id',
      definition: 'TEXT',
    },
    {
      table: 'talk_runs',
      column: 'sequence_index',
      definition: 'INTEGER',
    },
    {
      table: 'talk_runs',
      column: 'source_external_message_id',
      definition: 'TEXT',
    },
    {
      table: 'talk_runs',
      column: 'source_thread_key',
      definition: 'TEXT',
    },
    {
      table: 'talk_runs',
      column: 'task_type',
      definition: "TEXT CHECK(task_type IN ('chat', 'browser'))",
    },
    {
      table: 'talk_runs',
      column: 'browser_phase',
      definition:
        "TEXT CHECK(browser_phase IN ('starting', 'interacting', 'summarizing'))",
    },
    {
      table: 'talk_runs',
      column: 'blocked_reason',
      definition:
        "TEXT CHECK(blocked_reason IN ('login_required', 'phone_approval', 'app_approval', 'code_entry', 'session_conflict', 'manual_takeover'))",
    },
    {
      table: 'talk_runs',
      column: 'browser_session_id',
      definition: 'TEXT',
    },
    {
      table: 'talk_runs',
      column: 'selected_mode',
      definition: "TEXT CHECK(selected_mode IN ('api', 'subscription'))",
    },
    {
      table: 'talk_runs',
      column: 'transport',
      definition: "TEXT CHECK(transport IN ('direct', 'subscription'))",
    },
    {
      table: 'talk_runs',
      column: 'timeout_phase',
      definition: 'TEXT',
    },
    // talk_agents — columns that may be missing if table was partially migrated
    {
      table: 'talk_agents',
      column: 'nickname',
      definition: 'TEXT',
    },
    {
      table: 'talk_agents',
      column: 'nickname_mode',
      definition: "TEXT NOT NULL DEFAULT 'auto'",
    },
    {
      table: 'talk_agents',
      column: 'source_kind',
      definition: "TEXT NOT NULL DEFAULT 'provider'",
    },
    {
      table: 'talk_agents',
      column: 'provider_id',
      definition: 'TEXT',
    },
    {
      table: 'talk_agents',
      column: 'model_id',
      definition: 'TEXT',
    },
    // talk_messages — columns added for agent/run tracking
    {
      table: 'talk_runs',
      column: 'metadata_json',
      definition: 'TEXT',
    },
    {
      table: 'talk_runs',
      column: 'job_id',
      definition: 'TEXT',
    },
    {
      table: 'talk_messages',
      column: 'agent_id',
      definition: 'TEXT',
    },
    {
      table: 'talk_messages',
      column: 'run_id',
      definition: 'TEXT',
    },
    {
      table: 'talk_messages',
      column: 'sequence_in_run',
      definition: 'INTEGER',
    },
    {
      table: 'talk_messages',
      column: 'metadata_json',
      definition: 'TEXT',
    },
    {
      table: 'browser_profiles',
      column: 'policy_json',
      definition: 'TEXT',
    },
    {
      table: 'browser_profiles',
      column: 'connection_mode',
      definition: "TEXT NOT NULL DEFAULT 'managed'",
    },
    {
      table: 'browser_profiles',
      column: 'connection_config_json',
      definition: 'TEXT',
    },
    {
      table: 'talk_threads',
      column: 'is_internal',
      definition: 'INTEGER NOT NULL DEFAULT 0',
    },
    {
      table: 'talk_threads',
      column: 'is_pinned',
      definition: 'INTEGER NOT NULL DEFAULT 0',
    },
    {
      table: 'main_threads',
      column: 'is_pinned',
      definition: 'INTEGER NOT NULL DEFAULT 0',
    },
  ];

  for (const { table, column, definition } of additions) {
    const cols = database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (cols.length === 0) continue; // table doesn't exist yet
    if (cols.some((c) => c.name === column)) continue; // already present
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function ensureJobsSupportIndexes(database: Database.Database): void {
  const talkRunCols = database
    .prepare(`PRAGMA table_info(talk_runs)`)
    .all() as Array<{ name: string }>;
  if (talkRunCols.some((column) => column.name === 'job_id')) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_talk_runs_job_id_created_at
        ON talk_runs(job_id, created_at DESC, id ASC);
    `);
  }
}

/**
 * Rebuild llm_attempts when talk_id has NOT NULL constraint.
 *
 * The Main channel inserts llm_attempts with talk_id = NULL, but older
 * databases created the table with `talk_id TEXT NOT NULL`. The new CREATE
 * TABLE already has talk_id nullable, but existing DBs need a rebuild.
 *
 * Idempotent: skips if talk_id is already nullable or table doesn't exist.
 */
function migrateLlmAttemptsTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(llm_attempts)`)
    .all() as Array<{ name: string; notnull: number }>;
  if (columns.length === 0) return;

  const talkIdCol = columns.find((c) => c.name === 'talk_id');
  if (!talkIdCol || talkIdCol.notnull === 0) return; // already nullable

  database.exec(`
    CREATE TABLE llm_attempts_migration_backup AS
      SELECT * FROM llm_attempts;
    DROP TABLE llm_attempts;

    CREATE TABLE llm_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES talk_runs(id) ON DELETE CASCADE,
      talk_id TEXT REFERENCES talks(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      provider_id TEXT REFERENCES llm_providers(id) ON DELETE SET NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK(status IN ('success', 'failed', 'skipped', 'cancelled')),
      failure_class TEXT,
      latency_ms INTEGER,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      estimated_cost_usd REAL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_llm_attempts_run_id ON llm_attempts(run_id);
    CREATE INDEX idx_llm_attempts_talk_id_created_at
      ON llm_attempts(talk_id, created_at);

    INSERT INTO llm_attempts (
      id, run_id, talk_id, agent_id, provider_id, model_id,
      status, failure_class, latency_ms, input_tokens, output_tokens,
      estimated_cost_usd, created_at
    )
    SELECT
      id, run_id, talk_id, agent_id, provider_id, model_id,
      status, failure_class, latency_ms, input_tokens, output_tokens,
      estimated_cost_usd, created_at
    FROM llm_attempts_migration_backup;

    DROP TABLE llm_attempts_migration_backup;
  `);
}

function migrateLlmAttemptsCachedInputTokensColumn(
  database: Database.Database,
): void {
  const columns = database
    .prepare(`PRAGMA table_info(llm_attempts)`)
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return;
  if (columns.some((column) => column.name === 'cached_input_tokens')) return;
  database.exec(
    `ALTER TABLE llm_attempts ADD COLUMN cached_input_tokens INTEGER;`,
  );
}

// ===========================================================================
// PR #105 — Comprehensive schema-audit migration functions.
//
// Each function follows the same idempotent pattern:
//   1. PRAGMA table_info to inspect live schema
//   2. Check if the specific mismatch still exists
//   3. Backup → drop → recreate → copy → cleanup
// ===========================================================================

/**
 * settings_kv: live DB has `value TEXT NOT NULL`, init.ts has `value TEXT` (nullable).
 * Code stores NULL values for some settings keys.
 */
function migrateSettingsKvTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(settings_kv)`)
    .all() as Array<{ name: string; notnull: number }>;
  if (columns.length === 0) return;

  const valueCol = columns.find((c) => c.name === 'value');
  if (!valueCol || valueCol.notnull === 0) return;

  database.exec(`
    CREATE TABLE settings_kv_migration_backup AS SELECT * FROM settings_kv;
    DROP TABLE settings_kv;

    CREATE TABLE settings_kv (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    INSERT INTO settings_kv (key, value, updated_at, updated_by)
    SELECT key, value, updated_at, updated_by
    FROM settings_kv_migration_backup;

    DROP TABLE settings_kv_migration_backup;
  `);
}

/**
 * talk_message_attachments: live DB has talk_id/file_size/mime_type as NOT NULL,
 * init.ts allows them nullable.
 */
function migrateTalkMessageAttachmentsTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(talk_message_attachments)`)
    .all() as Array<{ name: string; notnull: number }>;
  if (columns.length === 0) return;

  const needsRebuild = ['talk_id', 'file_size', 'mime_type'].some((col) => {
    const c = columns.find((x) => x.name === col);
    return c && c.notnull === 1;
  });
  if (!needsRebuild) return;

  database.exec(`
    CREATE TABLE talk_message_attachments_mig AS SELECT * FROM talk_message_attachments;
    DROP TABLE talk_message_attachments;

    CREATE TABLE talk_message_attachments (
      id TEXT PRIMARY KEY,
      talk_id TEXT REFERENCES talks(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES talk_messages(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      file_size INTEGER,
      mime_type TEXT,
      storage_key TEXT NOT NULL,
      extracted_text TEXT,
      extraction_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(extraction_status IN ('pending', 'ready', 'failed')),
      extraction_error TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX idx_talk_message_attachments_message_id
      ON talk_message_attachments(message_id);
    CREATE INDEX idx_talk_message_attachments_talk_created
      ON talk_message_attachments(talk_id, created_at);

    INSERT INTO talk_message_attachments (
      id, talk_id, message_id, file_name, file_size, mime_type,
      storage_key, extracted_text, extraction_status, extraction_error,
      created_at, created_by
    )
    SELECT
      id, talk_id, message_id, file_name, file_size, mime_type,
      storage_key, extracted_text,
      COALESCE(extraction_status, 'pending'),
      extraction_error, created_at, created_by
    FROM talk_message_attachments_mig;

    DROP TABLE talk_message_attachments_mig;
  `);
}

function migrateMainThreadSummariesTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(main_thread_summaries)`)
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return;

  const foreignKeys = database
    .prepare(`PRAGMA foreign_key_list(main_thread_summaries)`)
    .all() as Array<{
    table: string;
    from: string;
    on_delete: string;
  }>;
  const coverageForeignKey = foreignKeys.find(
    (foreignKey) =>
      foreignKey.table === 'talk_messages' &&
      foreignKey.from === 'covers_through_message_id',
  );
  if (coverageForeignKey?.on_delete?.toUpperCase() === 'SET NULL') {
    return;
  }

  const foreignKeysEnabled =
    Number(database.pragma('foreign_keys', { simple: true })) !== 0;
  if (foreignKeysEnabled) {
    database.pragma('foreign_keys = OFF');
  }

  try {
    database.exec(`
      CREATE TABLE main_thread_summaries_mig AS
        SELECT * FROM main_thread_summaries;

      DROP TABLE main_thread_summaries;

      CREATE TABLE main_thread_summaries (
        thread_id TEXT PRIMARY KEY REFERENCES main_threads(thread_id) ON DELETE CASCADE,
        summary_text TEXT NOT NULL,
        covers_through_message_id TEXT REFERENCES talk_messages(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO main_thread_summaries (
        thread_id, summary_text, covers_through_message_id, updated_at
      )
      SELECT
        backup.thread_id,
        backup.summary_text,
        CASE
          WHEN talk_messages.id IS NOT NULL THEN backup.covers_through_message_id
          ELSE NULL
        END,
        backup.updated_at
      FROM main_thread_summaries_mig AS backup
      INNER JOIN main_threads
        ON main_threads.thread_id = backup.thread_id
      LEFT JOIN talk_messages
        ON talk_messages.id = backup.covers_through_message_id;

      DROP TABLE main_thread_summaries_mig;
    `);
  } finally {
    if (foreignKeysEnabled) {
      database.pragma('foreign_keys = ON');
    }
  }
}

/**
 * talk_context_goal: live DB has goal_text NOT NULL, init.ts allows NULL.
 */
function migrateTalkContextGoalTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(talk_context_goal)`)
    .all() as Array<{ name: string; notnull: number }>;
  if (columns.length === 0) return;

  const goalCol = columns.find((c) => c.name === 'goal_text');
  if (!goalCol || goalCol.notnull === 0) return;

  database.exec(`
    CREATE TABLE talk_context_goal_mig AS SELECT * FROM talk_context_goal;
    DROP TABLE talk_context_goal;

    CREATE TABLE talk_context_goal (
      talk_id TEXT PRIMARY KEY REFERENCES talks(id) ON DELETE CASCADE,
      goal_text TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    INSERT INTO talk_context_goal (talk_id, goal_text, updated_at, updated_by)
    SELECT talk_id, goal_text, updated_at, updated_by
    FROM talk_context_goal_mig;

    DROP TABLE talk_context_goal_mig;
  `);
}

/**
 * talk_context_sources: live DB has title NOT NULL + sort_order INTEGER.
 * init.ts has title nullable + sort_order REAL.
 */
function migrateTalkContextSourcesTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(talk_context_sources)`)
    .all() as Array<{ name: string; notnull: number; type: string }>;
  if (columns.length === 0) return;

  const titleCol = columns.find((c) => c.name === 'title');
  const sortCol = columns.find((c) => c.name === 'sort_order');
  const titleNeedsfix = titleCol && titleCol.notnull === 1;
  const sortNeedsFix = sortCol && sortCol.type.toUpperCase() === 'INTEGER';
  if (!titleNeedsfix && !sortNeedsFix) return;

  database.exec(`
    CREATE TABLE talk_context_sources_mig AS SELECT * FROM talk_context_sources;
    DROP TABLE talk_context_sources;

    CREATE TABLE talk_context_sources (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      source_ref TEXT NOT NULL,
      source_type TEXT NOT NULL
        CHECK(source_type IN ('url', 'file', 'text')),
      title TEXT,
      note TEXT,
      sort_order REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'ready', 'failed')),
      source_url TEXT,
      file_name TEXT,
      file_size INTEGER,
      mime_type TEXT,
      storage_key TEXT,
      extracted_text TEXT,
      extracted_at TEXT,
      last_fetched_at TEXT,
      extraction_error TEXT,
      fetch_strategy TEXT
        CHECK(fetch_strategy IN ('http', 'browser', 'managed') OR fetch_strategy IS NULL),
      is_truncated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id)
    );
    CREATE INDEX idx_talk_context_sources_talk_sort
      ON talk_context_sources(talk_id, sort_order, created_at);
    CREATE UNIQUE INDEX idx_talk_context_sources_ref
      ON talk_context_sources(talk_id, source_ref);

    INSERT INTO talk_context_sources (
      id, talk_id, source_ref, source_type, title, note, sort_order,
      status, source_url, file_name, file_size, mime_type, storage_key,
      extracted_text, extracted_at, last_fetched_at, extraction_error,
      fetch_strategy, is_truncated, created_at, updated_at, created_by
    )
    SELECT
      id, talk_id, source_ref, source_type, title, note, sort_order,
      COALESCE(status, 'pending'),
      source_url, file_name, file_size, mime_type, storage_key,
      extracted_text, extracted_at, last_fetched_at, extraction_error,
      fetch_strategy, COALESCE(is_truncated, 0),
      created_at, updated_at, created_by
    FROM talk_context_sources_mig;

    DROP TABLE talk_context_sources_mig;
  `);
}

/**
 * talk_context_rules: live DB has sort_order INTEGER, init.ts has REAL.
 * Low risk due to SQLite type affinity, but fix for consistency.
 */
function migrateTalkContextRulesTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(talk_context_rules)`)
    .all() as Array<{ name: string; type: string }>;
  if (columns.length === 0) return;

  const sortCol = columns.find((c) => c.name === 'sort_order');
  if (!sortCol || sortCol.type.toUpperCase() !== 'INTEGER') return;

  database.exec(`
    CREATE TABLE talk_context_rules_mig AS SELECT * FROM talk_context_rules;
    DROP TABLE talk_context_rules;

    CREATE TABLE talk_context_rules (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      rule_text TEXT NOT NULL,
      sort_order REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_talk_context_rules_talk_sort
      ON talk_context_rules(talk_id, sort_order, created_at);

    INSERT INTO talk_context_rules (
      id, talk_id, rule_text, sort_order, is_active, created_at, updated_at
    )
    SELECT
      id, talk_id, rule_text, sort_order, COALESCE(is_active, 1),
      created_at, updated_at
    FROM talk_context_rules_mig;

    DROP TABLE talk_context_rules_mig;
  `);
}

/**
 * channel_ingress_queue: live DB has platform_event_id NOT NULL, init.ts nullable.
 */
function migrateChannelIngressQueueTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(channel_ingress_queue)`)
    .all() as Array<{ name: string; notnull: number }>;
  if (columns.length === 0) return;

  const col = columns.find((c) => c.name === 'platform_event_id');
  if (!col || col.notnull === 0) return;

  database.exec(`
    CREATE TABLE channel_ingress_queue_mig AS SELECT * FROM channel_ingress_queue;
    DROP TABLE channel_ingress_queue;

    CREATE TABLE channel_ingress_queue (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES talk_channel_bindings(id) ON DELETE CASCADE,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      platform_event_id TEXT,
      external_message_id TEXT,
      sender_id TEXT,
      sender_name TEXT,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'deferred', 'processing', 'completed', 'dropped', 'dead_letter')),
      reason_code TEXT,
      reason_detail TEXT,
      dedupe_key TEXT NOT NULL UNIQUE,
      available_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_channel_ingress_queue_status_available
      ON channel_ingress_queue(status, available_at, created_at);
    CREATE INDEX idx_channel_ingress_queue_binding_status_available
      ON channel_ingress_queue(binding_id, status, available_at, created_at);
    CREATE INDEX idx_channel_ingress_queue_talk_status_available
      ON channel_ingress_queue(talk_id, status, available_at, created_at);

    INSERT INTO channel_ingress_queue (
      id, binding_id, talk_id, connection_id, target_kind, target_id,
      platform_event_id, external_message_id, sender_id, sender_name,
      payload_json, status, reason_code, reason_detail, dedupe_key,
      available_at, created_at, updated_at, attempt_count
    )
    SELECT
      id, binding_id, talk_id, connection_id, target_kind, target_id,
      platform_event_id, external_message_id, sender_id, sender_name,
      payload_json, status, reason_code, reason_detail, dedupe_key,
      available_at, created_at, updated_at, COALESCE(attempt_count, 0)
    FROM channel_ingress_queue_mig;

    DROP TABLE channel_ingress_queue_mig;
  `);
}

/**
 * channel_delivery_outbox: live DB has dedupe_key NOT NULL, init.ts nullable.
 */
function migrateChannelDeliveryOutboxTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(channel_delivery_outbox)`)
    .all() as Array<{ name: string; notnull: number }>;
  if (columns.length === 0) return;

  const col = columns.find((c) => c.name === 'dedupe_key');
  if (!col || col.notnull === 0) return;

  database.exec(`
    CREATE TABLE channel_delivery_outbox_mig AS SELECT * FROM channel_delivery_outbox;
    DROP TABLE channel_delivery_outbox;

    CREATE TABLE channel_delivery_outbox (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      run_id TEXT,
      talk_message_id TEXT,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'dead_letter', 'dropped')),
      reason_code TEXT,
      reason_detail TEXT,
      dedupe_key TEXT,
      available_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_channel_delivery_outbox_status
      ON channel_delivery_outbox(status, available_at);

    INSERT INTO channel_delivery_outbox (
      id, binding_id, talk_id, run_id, talk_message_id, target_kind,
      target_id, payload_json, status, reason_code, reason_detail,
      dedupe_key, available_at, created_at, updated_at, attempt_count
    )
    SELECT
      id, binding_id, talk_id, run_id, talk_message_id, target_kind,
      target_id, payload_json, status, reason_code, reason_detail,
      dedupe_key, available_at, created_at, updated_at, COALESCE(attempt_count, 0)
    FROM channel_delivery_outbox_mig;

    DROP TABLE channel_delivery_outbox_mig;
  `);
}

/**
 * dead_letter_queue: live DB has payload NOT NULL, init.ts nullable.
 */
function migrateDeadLetterQueueTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(dead_letter_queue)`)
    .all() as Array<{ name: string; notnull: number }>;
  if (columns.length === 0) return;

  const col = columns.find((c) => c.name === 'payload');
  if (!col || col.notnull === 0) return;

  database.exec(`
    CREATE TABLE dead_letter_queue_mig AS SELECT * FROM dead_letter_queue;
    DROP TABLE dead_letter_queue;

    CREATE TABLE dead_letter_queue (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      payload TEXT,
      error_class TEXT NOT NULL,
      error_detail TEXT,
      attempts INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_retry_at TEXT,
      resolved_at TEXT
    );
    CREATE INDEX idx_dead_letter_created_at
      ON dead_letter_queue(created_at);

    INSERT INTO dead_letter_queue (
      id, source_type, source_id, payload, error_class, error_detail,
      attempts, created_at, last_retry_at, resolved_at
    )
    SELECT
      id, source_type, source_id, payload, error_class, error_detail,
      COALESCE(attempts, 1), created_at, last_retry_at, resolved_at
    FROM dead_letter_queue_mig;

    DROP TABLE dead_letter_queue_mig;
  `);
}

function migrateDataConnectorsTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(data_connectors)`)
    .all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
  if (columns.length === 0) return;

  const createSqlRow = database
    .prepare(
      `
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'data_connectors'
      LIMIT 1
    `,
    )
    .get() as { sql?: string | null } | undefined;
  const createSql = createSqlRow?.sql || '';
  if (createSql.includes("'google_docs'")) {
    return;
  }

  database.exec(`
    CREATE TABLE data_connectors_mig AS SELECT * FROM data_connectors;
    DROP TABLE data_connectors;

    CREATE TABLE data_connectors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      connector_kind TEXT NOT NULL
        CHECK(connector_kind IN ('google_docs', 'google_sheets', 'posthog')),
      config_json TEXT,
      discovered_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id),
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );
    CREATE INDEX idx_data_connectors_kind_enabled
      ON data_connectors(connector_kind, enabled);

    INSERT INTO data_connectors (
      id, name, connector_kind, config_json, discovered_json, enabled,
      created_at, created_by, updated_at, updated_by
    )
    SELECT
      id, name, connector_kind, config_json, discovered_json, enabled,
      created_at, created_by, updated_at, updated_by
    FROM data_connectors_mig;

    DROP TABLE data_connectors_mig;
  `);
}

function migrateTalkChannelPoliciesTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(talk_channel_policies)`)
    .all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  if (columns.length === 0) return;

  const hasInstructions = columns.some(
    (column) => column.name === 'instructions',
  );
  const hasLegacyInstructions = columns.some(
    (column) => column.name === 'channel_context_note',
  );
  const hasBehaviorMode = columns.some(
    (column) => column.name === 'behavior_mode',
  );
  const hasBehaviorConfig = columns.some(
    (column) => column.name === 'behavior_config',
  );
  const hasTimezone = columns.some((column) => column.name === 'timezone');
  const rateCol = columns.find(
    (c) => c.name === 'inbound_rate_limit_per_minute',
  );
  const deferredCol = columns.find(
    (c) => c.name === 'max_deferred_age_minutes',
  );
  const rateNeedsFix = rateCol && rateCol.notnull === 1;
  const defaultNeedsFix = deferredCol && deferredCol.dflt_value === '10';
  const needsRebuild =
    !hasInstructions ||
    !hasTimezone ||
    hasLegacyInstructions ||
    hasBehaviorMode ||
    hasBehaviorConfig ||
    rateNeedsFix ||
    defaultNeedsFix;
  if (!needsRebuild) return;

  const instructionsSelect = hasInstructions
    ? 'instructions'
    : hasLegacyInstructions
      ? 'channel_context_note'
      : 'NULL';
  const timezoneSelect = hasTimezone
    ? `COALESCE(timezone, ${sqlStringLiteral(DEFAULT_CHANNEL_BINDING_TIMEZONE)})`
    : sqlStringLiteral(DEFAULT_CHANNEL_BINDING_TIMEZONE);

  database.exec(`
    CREATE TABLE talk_channel_policies_mig AS SELECT * FROM talk_channel_policies;
    DROP TABLE talk_channel_policies;

    CREATE TABLE talk_channel_policies (
      binding_id TEXT PRIMARY KEY REFERENCES talk_channel_bindings(id) ON DELETE CASCADE,
      response_mode TEXT NOT NULL DEFAULT 'mentions'
        CHECK(response_mode IN ('off', 'mentions', 'all')),
      responder_mode TEXT NOT NULL DEFAULT 'primary'
        CHECK(responder_mode IN ('primary', 'agent')),
      responder_agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      delivery_mode TEXT NOT NULL DEFAULT 'reply'
        CHECK(delivery_mode IN ('reply', 'channel')),
      thread_mode TEXT NOT NULL DEFAULT 'conversation'
        CHECK(thread_mode IN ('conversation')),
      timezone TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_CHANNEL_BINDING_TIMEZONE)},
      instructions TEXT,
      allowed_senders_json TEXT,
      inbound_rate_limit_per_minute INTEGER,
      max_pending_events INTEGER DEFAULT 20,
      overflow_policy TEXT NOT NULL DEFAULT 'drop_oldest'
        CHECK(overflow_policy IN ('drop_oldest', 'drop_newest')),
      max_deferred_age_minutes INTEGER DEFAULT 60,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    INSERT INTO talk_channel_policies (
      binding_id, response_mode, responder_mode, responder_agent_id,
      delivery_mode, thread_mode, timezone, instructions, allowed_senders_json,
      inbound_rate_limit_per_minute, max_pending_events, overflow_policy,
      max_deferred_age_minutes, updated_at, updated_by
    )
    SELECT
      binding_id, response_mode, responder_mode, responder_agent_id,
      delivery_mode, thread_mode, ${timezoneSelect}, ${instructionsSelect}, allowed_senders_json,
      inbound_rate_limit_per_minute, max_pending_events,
      COALESCE(overflow_policy, 'drop_oldest'),
      COALESCE(max_deferred_age_minutes, 60), updated_at, updated_by
    FROM talk_channel_policies_mig;

    DROP TABLE talk_channel_policies_mig;
  `);
}

/**
 * talk_channel_bindings: live DB has display_name NOT NULL + missing 4 columns
 * (response_mode, responder_agent_id, allowed_senders_json, rate_limit_json).
 */
function migrateTalkChannelBindingsTable(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(talk_channel_bindings)`)
    .all() as Array<{ name: string; notnull: number }>;
  if (columns.length === 0) return;

  const displayCol = columns.find((c) => c.name === 'display_name');
  const displayNeedsFix = displayCol && displayCol.notnull === 1;
  const missingCols = [
    'response_mode',
    'responder_agent_id',
    'allowed_senders_json',
    'rate_limit_json',
  ].some((col) => !columns.some((c) => c.name === col));
  if (!displayNeedsFix && !missingCols) return;

  // Determine which columns exist in the old table for the SELECT
  const oldColNames = columns.map((c) => c.name);
  const hasResponseMode = oldColNames.includes('response_mode');
  const hasResponderAgentId = oldColNames.includes('responder_agent_id');

  database.exec(`
    CREATE TABLE talk_channel_bindings_mig AS SELECT * FROM talk_channel_bindings;
    DROP TABLE talk_channel_bindings;

    CREATE TABLE talk_channel_bindings (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      display_name TEXT,
      response_mode TEXT NOT NULL DEFAULT 'mentions'
        CHECK(response_mode IN ('off', 'mentions', 'all')),
      responder_agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      allowed_senders_json TEXT,
      rate_limit_json TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id),
      updated_by TEXT REFERENCES users(id)
    );
    CREATE INDEX idx_talk_channel_bindings_talk
      ON talk_channel_bindings(talk_id, active, created_at);

    INSERT INTO talk_channel_bindings (
      id, talk_id, connection_id, target_kind, target_id, display_name,
      response_mode, responder_agent_id, allowed_senders_json, rate_limit_json,
      active, created_at, updated_at, created_by, updated_by
    )
    SELECT
      id, talk_id, connection_id, target_kind, target_id, display_name,
      ${hasResponseMode ? 'response_mode' : "'mentions'"},
      ${hasResponderAgentId ? 'responder_agent_id' : 'NULL'},
      NULL,
      NULL,
      COALESCE(active, 1), created_at, updated_at, created_by, updated_by
    FROM talk_channel_bindings_mig;

    DROP TABLE talk_channel_bindings_mig;
  `);
}

/**
 * talks: live DB has sort_order INTEGER, init.ts has REAL.
 * Low risk due to SQLite type affinity, but fix for schema consistency.
 */
function migrateTalksTable(database: Database.Database): void {
  const columns = database.prepare(`PRAGMA table_info(talks)`).all() as Array<{
    name: string;
    type: string;
  }>;
  if (columns.length === 0) return;

  const sortCol = columns.find((c) => c.name === 'sort_order');
  if (!sortCol || sortCol.type.toUpperCase() !== 'INTEGER') return;
  const projectPathSelect = columns.some((c) => c.name === 'project_path')
    ? 'project_path'
    : 'NULL';

  database.exec(`
    CREATE TABLE talks_mig AS SELECT * FROM talks;
    DROP TABLE talks;

    CREATE TABLE talks (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder_id TEXT REFERENCES talk_folders(id) ON DELETE SET NULL,
      topic_title TEXT,
      project_path TEXT,
      orchestration_mode TEXT NOT NULL DEFAULT 'ordered'
        CHECK(orchestration_mode IN ('ordered', 'panel')),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'paused', 'archived')),
      sort_order REAL NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_talks_owner_folder_sort
      ON talks(owner_id, folder_id, sort_order, updated_at);

    INSERT INTO talks (
      id, owner_id, folder_id, topic_title, project_path, orchestration_mode, status,
      sort_order, version, created_at, updated_at
    )
    SELECT
      id, owner_id, folder_id, topic_title, ${projectPathSelect},
      COALESCE(orchestration_mode, 'ordered'),
      COALESCE(status, 'active'),
      COALESCE(sort_order, 0), COALESCE(version, 1),
      created_at, updated_at
    FROM talks_mig;

    DROP TABLE talks_mig;
  `);
}

/**
 * Phase 4 — Backfill threads for existing data.
 *
 * 1. For each Talk that has messages with NULL thread_id:
 *    - Create a default talk_threads row (is_default=1)
 *    - Update all NULL-thread messages and runs to that thread
 *
 * 2. For each distinct Main channel thread_id that exists on messages
 *    but has no talk_threads row:
 *    - Create a talk_threads row (talk_id=NULL for Main)
 *
 * Idempotent: checks whether work is needed before acting.
 */
function migrateBackfillThreads(database: Database.Database): void {
  // Check if talk_threads table exists (fresh DB has it from CREATE TABLE)
  const ttCols = database
    .prepare(`PRAGMA table_info(talk_threads)`)
    .all() as Array<{ name: string }>;
  if (ttCols.length === 0) return; // table hasn't been created yet

  // --- Part 1: Backfill Talk messages/runs that have NULL thread_id ---

  // Find all talks that have messages with no thread_id
  const talksNeedingBackfill = database
    .prepare(
      `
      SELECT DISTINCT talk_id
      FROM talk_messages
      WHERE talk_id IS NOT NULL AND thread_id IS NULL
    `,
    )
    .all() as Array<{ talk_id: string }>;

  if (talksNeedingBackfill.length > 0) {
    const uuidStmt = database.prepare(
      `SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
        substr(hex(randomblob(2)),2) || '-' ||
        substr('89ab', abs(random()) % 4 + 1, 1) ||
        substr(hex(randomblob(2)),2) || '-' ||
        hex(randomblob(6))) AS uuid`,
    );

    const insertThread = database.prepare(
      `INSERT OR IGNORE INTO talk_threads (id, talk_id, title, is_default, created_at, updated_at)
       VALUES (?, ?, 'Default Thread', 1, ?, ?)`,
    );

    const updateMessages = database.prepare(
      `UPDATE talk_messages SET thread_id = ? WHERE talk_id = ? AND thread_id IS NULL`,
    );

    const updateRuns = database.prepare(
      `UPDATE talk_runs SET thread_id = ? WHERE talk_id = ? AND thread_id IS NULL`,
    );

    const now = new Date().toISOString();

    const backfillTx = database.transaction(() => {
      for (const { talk_id } of talksNeedingBackfill) {
        // Check if this talk already has a default thread
        const existing = database
          .prepare(
            `SELECT id FROM talk_threads WHERE talk_id = ? AND is_default = 1 LIMIT 1`,
          )
          .get(talk_id) as { id: string } | undefined;

        let threadId: string;
        if (existing) {
          threadId = existing.id;
        } else {
          const { uuid } = uuidStmt.get() as { uuid: string };
          threadId = `thread_${uuid}`;
          insertThread.run(threadId, talk_id, now, now);
        }

        updateMessages.run(threadId, talk_id);
        updateRuns.run(threadId, talk_id);
      }
    });

    backfillTx();
  }

  // --- Part 2: Backfill Main channel threads ---
  // Main channel messages have talk_id=NULL and a non-NULL thread_id.
  // Create talk_threads rows for any thread_id that doesn't have one yet.

  const mainThreadIds = database
    .prepare(
      `
      SELECT DISTINCT m.thread_id
      FROM talk_messages m
      WHERE m.talk_id IS NULL AND m.thread_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM talk_threads t WHERE t.id = m.thread_id
        )
    `,
    )
    .all() as Array<{ thread_id: string }>;

  if (mainThreadIds.length > 0) {
    const now = new Date().toISOString();
    const insertMainThread = database.prepare(
      `INSERT OR IGNORE INTO talk_threads (id, talk_id, title, is_default, created_at, updated_at)
       VALUES (?, NULL, NULL, 0, ?, ?)`,
    );

    const backfillMainTx = database.transaction(() => {
      for (const { thread_id } of mainThreadIds) {
        insertMainThread.run(thread_id, now, now);
      }
    });

    backfillMainTx();
  }
}

/**
 * Rebuild talk_messages and talk_runs so thread_id is NOT NULL after the
 * Phase 4 backfill has assigned every surviving row to a thread.
 *
 * If any legacy rows still have NULL thread_id after backfill, they are
 * deleted as unrecoverable pre-thread data rather than keeping the schema
 * in a nullable state forever.
 */
function migrateEnforceThreadIdsNotNull(database: Database.Database): void {
  const talkMessageCols = database
    .prepare(`PRAGMA table_info(talk_messages)`)
    .all() as Array<{ name: string; notnull: number }>;
  const talkRunCols = database
    .prepare(`PRAGMA table_info(talk_runs)`)
    .all() as Array<{ name: string; notnull: number }>;

  const talkMessagesNeedRebuild =
    talkMessageCols.find((c) => c.name === 'thread_id')?.notnull !== 1;
  const talkRunsNeedRebuild =
    talkRunCols.find((c) => c.name === 'thread_id')?.notnull !== 1;
  const talkRunColumnNames = new Set(talkRunCols.map((column) => column.name));

  if (!talkMessagesNeedRebuild && !talkRunsNeedRebuild) return;

  const cleanupTx = database.transaction(() => {
    database.prepare(`DELETE FROM talk_runs WHERE thread_id IS NULL`).run();
    database.prepare(`DELETE FROM talk_messages WHERE thread_id IS NULL`).run();
  });
  cleanupTx();

  const foreignKeysEnabled =
    Number(database.pragma('foreign_keys', { simple: true })) !== 0;
  if (foreignKeysEnabled) {
    database.pragma('foreign_keys = OFF');
  }

  try {
    if (talkMessagesNeedRebuild) {
      database.exec(`
      CREATE TABLE talk_messages_thread_backup AS
        SELECT * FROM talk_messages;

      DROP TABLE talk_messages;

      CREATE TABLE talk_messages (
        id TEXT PRIMARY KEY,
        talk_id TEXT REFERENCES talks(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT NOT NULL,
        agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
        run_id TEXT,
        sequence_in_run INTEGER,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT
      );
      CREATE INDEX idx_talk_messages_talk_created_at
        ON talk_messages(talk_id, created_at);
      CREATE INDEX idx_talk_messages_thread_id
        ON talk_messages(thread_id);

      INSERT INTO talk_messages (
        id, talk_id, thread_id, role, content, agent_id, run_id,
        sequence_in_run, created_by, created_at, metadata_json
      )
      SELECT
        id, talk_id, thread_id, role, content, agent_id, run_id,
        sequence_in_run, created_by, created_at, metadata_json
      FROM talk_messages_thread_backup;

      DROP TABLE talk_messages_thread_backup;
    `);
    }

    if (talkRunsNeedRebuild) {
      const selectOrNull = (column: string) =>
        talkRunColumnNames.has(column) ? column : `NULL AS ${column}`;

      database.exec(`
      CREATE TABLE talk_runs_thread_backup AS
        SELECT * FROM talk_runs;

      DROP TABLE talk_runs;

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
        thread_id TEXT NOT NULL,
        run_kind TEXT NOT NULL DEFAULT 'conversation'
          CHECK(run_kind IN ('conversation', 'instruction_review')),
        idempotency_key TEXT,
        response_group_id TEXT,
        sequence_index INTEGER,
        source_binding_id TEXT,
        source_external_message_id TEXT,
        source_thread_key TEXT,
        task_type TEXT
          CHECK(task_type IN ('chat', 'browser')),
        browser_phase TEXT
          CHECK(browser_phase IN ('starting', 'interacting', 'summarizing')),
        blocked_reason TEXT
          CHECK(blocked_reason IN ('login_required', 'phone_approval', 'app_approval', 'code_entry', 'session_conflict', 'manual_takeover')),
        browser_session_id TEXT,
        selected_mode TEXT
          CHECK(selected_mode IN ('api', 'subscription')),
        transport TEXT
          CHECK(transport IN ('direct', 'subscription')),
        timeout_phase TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        cancel_reason TEXT,
        metadata_json TEXT
      );
      CREATE INDEX idx_talk_runs_talk_id_status
        ON talk_runs(talk_id, status, created_at);
      CREATE INDEX idx_talk_runs_status_created_at
        ON talk_runs(status, created_at);
      CREATE INDEX idx_talk_runs_group_sequence
        ON talk_runs(response_group_id, sequence_index, created_at);
      CREATE INDEX idx_talk_runs_thread_status_created
        ON talk_runs(thread_id, status, created_at);
      CREATE INDEX idx_talk_runs_browser_session
        ON talk_runs(browser_session_id, status, created_at);

      INSERT INTO talk_runs (
        id, talk_id, requested_by, status, trigger_message_id, target_agent_id,
        agent_id, executor_alias, executor_model, thread_id, run_kind, idempotency_key,
        response_group_id, sequence_index,
        source_binding_id, source_external_message_id, source_thread_key,
        task_type, browser_phase, blocked_reason, browser_session_id,
        selected_mode, transport, timeout_phase,
        created_at, started_at, ended_at, cancel_reason, metadata_json
      )
      SELECT
        id, talk_id, requested_by, status, trigger_message_id, ${selectOrNull('target_agent_id')},
        ${selectOrNull('agent_id')}, ${selectOrNull('executor_alias')}, ${selectOrNull('executor_model')}, thread_id, ${talkRunColumnNames.has('run_kind') ? 'run_kind' : "'conversation' AS run_kind"}, ${selectOrNull('idempotency_key')},
        ${selectOrNull('response_group_id')}, ${selectOrNull('sequence_index')},
        ${selectOrNull('source_binding_id')}, ${selectOrNull('source_external_message_id')}, ${selectOrNull('source_thread_key')},
        ${selectOrNull('task_type')}, ${selectOrNull('browser_phase')}, ${selectOrNull('blocked_reason')}, ${selectOrNull('browser_session_id')},
        ${selectOrNull('selected_mode')}, ${selectOrNull('transport')}, ${selectOrNull('timeout_phase')},
        created_at, started_at, ended_at, cancel_reason, ${selectOrNull('metadata_json')}
      FROM talk_runs_thread_backup;

      DROP TABLE talk_runs_thread_backup;
    `);
    }
  } finally {
    if (foreignKeysEnabled) {
      database.pragma('foreign_keys = ON');
    }
  }
}

function migrateGoogleToolingTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS google_oauth_link_requests (
      state_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scopes_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_google_oauth_link_requests_user_id
      ON google_oauth_link_requests(user_id, created_at);

    CREATE TABLE IF NOT EXISTS talk_tool_grants (
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      tool_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id),
      PRIMARY KEY (talk_id, tool_id)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_tool_grants_talk_id
      ON talk_tool_grants(talk_id);

    CREATE TABLE IF NOT EXISTS talk_resource_bindings (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      binding_kind TEXT NOT NULL
        CHECK(binding_kind IN ('google_drive_folder', 'google_drive_file', 'data_connector', 'saved_source', 'message_attachment')),
      external_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_resource_bindings_talk_id
      ON talk_resource_bindings(talk_id, created_at, id);
  `);

  const duplicateUserCredentialIds = database
    .prepare(
      `
      SELECT c1.id
      FROM user_google_credentials c1
      JOIN user_google_credentials c2
        ON c1.user_id = c2.user_id
       AND (
         c1.updated_at < c2.updated_at
         OR (c1.updated_at = c2.updated_at AND c1.id < c2.id)
       )
    `,
    )
    .all() as Array<{ id: string }>;

  if (duplicateUserCredentialIds.length > 0) {
    const deleteStmt = database.prepare(
      `DELETE FROM user_google_credentials WHERE id = ?`,
    );
    const tx = database.transaction((rows: Array<{ id: string }>) => {
      rows.forEach((row) => deleteStmt.run(row.id));
    });
    tx(duplicateUserCredentialIds);
  }

  const duplicateBindingIds = database
    .prepare(
      `
      SELECT b1.id
      FROM talk_resource_bindings b1
      JOIN talk_resource_bindings b2
        ON b1.talk_id = b2.talk_id
       AND b1.binding_kind = b2.binding_kind
       AND b1.external_id = b2.external_id
       AND (
         b1.created_at > b2.created_at
         OR (b1.created_at = b2.created_at AND b1.id > b2.id)
       )
    `,
    )
    .all() as Array<{ id: string }>;

  if (duplicateBindingIds.length > 0) {
    const deleteStmt = database.prepare(
      `DELETE FROM talk_resource_bindings WHERE id = ?`,
    );
    const tx = database.transaction((rows: Array<{ id: string }>) => {
      rows.forEach((row) => deleteStmt.run(row.id));
    });
    tx(duplicateBindingIds);
  }

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_google_credentials_user_id_unique
      ON user_google_credentials(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_talk_resource_bindings_unique_scope
      ON talk_resource_bindings(talk_id, binding_kind, external_id);
  `);
}

/**
 * Migrate the seeded main agent from builtin.mock to provider.anthropic.
 *
 * The original seedMainAgent used provider_id = 'builtin.mock' which has no
 * real execution path. This migration updates it to provider.anthropic with
 * a real model so that the agent can actually execute via the Anthropic API.
 *
 * Idempotent: only updates if the agent still has the old mock provider.
 */
function migrateMainAgentToAnthropic(database: Database.Database): void {
  const row = database
    .prepare(
      `SELECT provider_id FROM registered_agents WHERE id = 'agent.main'`,
    )
    .get() as { provider_id: string } | undefined;

  if (!row || row.provider_id !== 'builtin.mock') return;

  database
    .prepare(
      `UPDATE registered_agents
       SET provider_id = 'provider.anthropic',
           model_id = ?,
           updated_at = ?
       WHERE id = 'agent.main'`,
    )
    .run(getSeedClaudeModel(database), new Date().toISOString());
}

/**
 * talk_channel_bindings: add health/operability columns.
 * Idempotent: skips if columns already exist.
 */
function migrateChannelBindingHealthColumns(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(talk_channel_bindings)`)
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return;
  if (columns.some((c) => c.name === 'health_quarantined')) return;

  database.exec(`
    ALTER TABLE talk_channel_bindings ADD COLUMN last_ingress_at TEXT;
    ALTER TABLE talk_channel_bindings ADD COLUMN last_delivery_at TEXT;
    ALTER TABLE talk_channel_bindings ADD COLUMN last_delivery_error_code TEXT;
    ALTER TABLE talk_channel_bindings ADD COLUMN last_delivery_error_detail TEXT;
    ALTER TABLE talk_channel_bindings ADD COLUMN last_delivery_error_at TEXT;
    ALTER TABLE talk_channel_bindings ADD COLUMN health_quarantined INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE talk_channel_bindings ADD COLUMN health_quarantine_code TEXT;
  `);
}

function migrateActiveTalkChannelBindingUniqueness(
  database: Database.Database,
): void {
  const duplicateBindingIds = database
    .prepare(
      `
      SELECT b1.id
      FROM talk_channel_bindings b1
      JOIN talk_channel_bindings b2
        ON b1.connection_id = b2.connection_id
       AND b1.target_kind = b2.target_kind
       AND b1.target_id = b2.target_id
       AND b1.active = 1
       AND b2.active = 1
       AND (
         b1.updated_at < b2.updated_at
         OR (b1.updated_at = b2.updated_at AND b1.id < b2.id)
       )
    `,
    )
    .all() as Array<{ id: string }>;

  if (duplicateBindingIds.length > 0) {
    const now = new Date().toISOString();
    const deactivateStmt = database.prepare(
      `
      UPDATE talk_channel_bindings
      SET active = 0,
          updated_at = ?
      WHERE id = ?
    `,
    );
    const tx = database.transaction((rows: Array<{ id: string }>) => {
      rows.forEach((row) => deactivateStmt.run(now, row.id));
    });
    tx(duplicateBindingIds);
  }

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_talk_channel_bindings_active_target_unique
      ON talk_channel_bindings(connection_id, target_kind, target_id)
      WHERE active = 1;
  `);
}

/**
 * channel_connections: add consecutive_probe_failures column.
 * Idempotent: skips if column already exists.
 */
function migrateConnectionProbeFailuresColumn(
  database: Database.Database,
): void {
  const columns = database
    .prepare(`PRAGMA table_info(channel_connections)`)
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return;
  if (columns.some((c) => c.name === 'consecutive_probe_failures')) return;

  database.exec(`
    ALTER TABLE channel_connections ADD COLUMN consecutive_probe_failures INTEGER NOT NULL DEFAULT 0;
  `);
}

function migrateChannelConnectionSecretsTable(
  database: Database.Database,
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS channel_connection_secrets (
      connection_id TEXT PRIMARY KEY REFERENCES channel_connections(id) ON DELETE CASCADE,
      ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );
  `);
}

function migrateChannelProviderConfigTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS channel_provider_configs (
      platform TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS channel_provider_secrets (
      platform TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );
  `);
}

function migrateChannelTargetRegistryColumns(
  database: Database.Database,
): void {
  const columns = database
    .prepare(`PRAGMA table_info(channel_targets)`)
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return;

  if (!columns.some((column) => column.name === 'approved')) {
    database.exec(`
      ALTER TABLE channel_targets ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
    `);
  }
  if (!columns.some((column) => column.name === 'registered_at')) {
    database.exec(`
      ALTER TABLE channel_targets ADD COLUMN registered_at TEXT;
    `);
  }
  if (!columns.some((column) => column.name === 'registered_by')) {
    database.exec(`
      ALTER TABLE channel_targets ADD COLUMN registered_by TEXT REFERENCES users(id);
    `);
  }
}

function migrateTalkChannelThreadMapTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS talk_channel_thread_map (
      binding_id TEXT NOT NULL REFERENCES talk_channel_bindings(id) ON DELETE CASCADE,
      source_thread_key TEXT NOT NULL,
      talk_thread_id TEXT NOT NULL REFERENCES talk_threads(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (binding_id, source_thread_key)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_channel_thread_map_thread
      ON talk_channel_thread_map(talk_thread_id);
  `);
}

function migrateOAuthStateRequesterColumns(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(oauth_state)`)
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return;

  if (!columns.some((column) => column.name === 'requested_by_user_id')) {
    database.exec(`
      ALTER TABLE oauth_state
      ADD COLUMN requested_by_user_id TEXT REFERENCES users(id);
    `);
  }

  if (!columns.some((column) => column.name === 'requested_by_session_id')) {
    database.exec(`
      ALTER TABLE oauth_state
      ADD COLUMN requested_by_session_id TEXT REFERENCES web_sessions(id);
    `);
  }
}

export function initClawrocketSchema(): void {
  createClawrocketSchema(getDb());
}

/** @internal - for tests only. */
export function _initClawrocketTestSchema(): void {
  createClawrocketSchema(getDb());
}
