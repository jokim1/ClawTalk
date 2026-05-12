/**
 * execution-resolver.ts
 *
 * Single source of truth for resolving how an agent should be executed
 * via the direct HTTP path (agent-router.ts → llm-client.ts).
 *
 * This module is the ONLY place that merges:
 *   - agent config (registered_agents row)
 *   - provider config (llm_providers row)
 *   - credential source (llm_provider_secrets or env-var fallback)
 *   - auth scheme compatibility
 *
 * agent-router.ts calls `resolveExecution()` and receives a ready-to-use
 * binding, or a hard failure explaining why execution is not possible.
 *
 * ── v1 scope ──
 *
 * The direct HTTP path supports ANY provider with an API key stored in
 * `llm_provider_secrets` (OpenAI, Gemini, DeepSeek, etc.) and the special
 * case of `provider.anthropic` where the API key may also come from the
 * `ANTHROPIC_API_KEY` env var managed by the host layer.
 *
 * Claude subscription/OAuth credentials (CLAUDE_CODE_OAUTH_TOKEN,
 * ANTHROPIC_AUTH_TOKEN) are NOT compatible with the direct HTTP path.
 * They require the container executor or a compatible proxy — both of
 * which are outside the scope of this module.  If a user is in
 * subscription/OAuth mode without a proxy, agent creation through the
 * registered-agents panel for Anthropic is not supported.  The resolver
 * will reject with a clear error rather than sending an invalid auth
 * header to api.anthropic.com.
 */

import { getDb } from '../../db.js';
import type { RegisteredAgentRecord } from '../db/agent-accessors.js';
import { decryptProviderSecret } from '../llm/provider-secret-store.js';
import type { LlmProviderConfig, LlmSecret } from './llm-client.js';
import {
  TALK_EXECUTOR_ANTHROPIC_API_KEY,
  TALK_EXECUTOR_ANTHROPIC_BASE_URL,
} from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutionBinding {
  /** Provider config for the LLM client (base URL, api format, auth scheme). */
  providerConfig: LlmProviderConfig;
  /** Credential to send with the request. */
  secret: LlmSecret;
  /** Default output budget configured for this provider/model pair. */
  defaultMaxOutputTokens?: number;
}

export class ExecutionResolverError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ExecutionResolverError';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve everything needed to execute the given agent via direct HTTP.
 *
 * Returns a ready-to-use ExecutionBinding or throws an
 * ExecutionResolverError with a machine-readable code.
 */
export function resolveExecution(
  agent: RegisteredAgentRecord,
): ExecutionBinding {
  const db = getDb();

  // --- Step 1: Load provider row ---
  const providerRecord: any = db
    .prepare('SELECT * FROM llm_providers WHERE id = ?')
    .get(agent.provider_id);

  if (!providerRecord) {
    throw new ExecutionResolverError(
      `Provider ${agent.provider_id} not found`,
      'PROVIDER_NOT_FOUND',
    );
  }

  // --- Step 2: Resolve credentials ---
  const secret = resolveSecret(agent, db);

  // --- Step 3: Build provider config ---
  // For provider.anthropic, honour the ANTHROPIC_BASE_URL env var override
  // so the host layer can point agents at a proxy without touching the DB.
  const baseUrl =
    agent.provider_id === 'provider.anthropic' &&
    TALK_EXECUTOR_ANTHROPIC_BASE_URL
      ? TALK_EXECUTOR_ANTHROPIC_BASE_URL
      : providerRecord.base_url || undefined;

  const providerConfig: LlmProviderConfig = {
    providerId: agent.provider_id,
    baseUrl,
    apiFormat: providerRecord.api_format,
    authScheme: providerRecord.auth_scheme || 'x_api_key',
    responseStartTimeoutMs:
      providerRecord.response_start_timeout_ms ?? undefined,
    streamIdleTimeoutMs: providerRecord.stream_idle_timeout_ms ?? undefined,
    absoluteTimeoutMs: providerRecord.absolute_timeout_ms ?? undefined,
  };

  const modelRecord = db
    .prepare(
      `
        SELECT default_max_output_tokens
        FROM llm_provider_models
        WHERE provider_id = ? AND model_id = ?
        LIMIT 1
      `,
    )
    .get(agent.provider_id, agent.model_id) as
    | { default_max_output_tokens: number }
    | undefined;

  return {
    providerConfig,
    secret,
    defaultMaxOutputTokens: modelRecord?.default_max_output_tokens,
  };
}

/**
 * Check whether direct HTTP execution is possible for `provider.anthropic`.
 *
 * This is intended for the frontend to determine whether to show Claude as
 * a ready provider in the registered-agents panel.  Returns true only when
 * an Anthropic API key is available (directly or via env var).
 *
 * Subscription/OAuth credentials are NOT sufficient for direct HTTP
 * execution and this function returns false for them.
 */
export function isAnthropicDirectHttpReady(): boolean {
  if (TALK_EXECUTOR_ANTHROPIC_API_KEY) return true;

  const db = getDb();
  const secretRecord: any = db
    .prepare('SELECT 1 FROM llm_provider_secrets WHERE provider_id = ?')
    .get('provider.anthropic');

  return !!secretRecord;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Resolve the API credential for an agent.
 *
 * 1. Try llm_provider_secrets (works for all providers).
 * 2. For provider.anthropic only: fall back to ANTHROPIC_API_KEY env var.
 *    OAuth/auth tokens are NOT used — they are incompatible with the
 *    x-api-key auth scheme required by api.anthropic.com.
 * 3. If nothing found, throw a clear error.
 */
function resolveSecret(
  agent: RegisteredAgentRecord,
  db: ReturnType<typeof getDb>,
): LlmSecret {
  // Try llm_provider_secrets first (all providers)
  const secretRecord: any = db
    .prepare(
      'SELECT ciphertext FROM llm_provider_secrets WHERE provider_id = ?',
    )
    .get(agent.provider_id);

  if (secretRecord) {
    try {
      return decryptProviderSecret(secretRecord.ciphertext);
    } catch {
      throw new ExecutionResolverError(
        `Failed to decrypt provider secret for ${agent.provider_id}`,
        'SECRET_DECRYPTION_FAILED',
      );
    }
  }

  // For provider.anthropic: fall back to the API key env var ONLY.
  if (
    agent.provider_id === 'provider.anthropic' &&
    TALK_EXECUTOR_ANTHROPIC_API_KEY
  ) {
    return { apiKey: TALK_EXECUTOR_ANTHROPIC_API_KEY };
  }

  // Not found — produce a specific error for Anthropic subscription users.
  if (agent.provider_id === 'provider.anthropic') {
    throw new ExecutionResolverError(
      'No Anthropic API key configured. Claude subscription/OAuth credentials ' +
        'cannot be used for direct HTTP agent execution. Either configure an ' +
        'Anthropic API key, or use container execution for Claude agents.',
      'ANTHROPIC_REQUIRES_API_KEY',
    );
  }

  throw new ExecutionResolverError(
    `No API credentials found for provider ${agent.provider_id}`,
    'PROVIDER_SECRET_MISSING',
  );
}
