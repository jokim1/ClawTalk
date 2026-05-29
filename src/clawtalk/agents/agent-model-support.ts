/**
 * agent-model-support.ts
 *
 * Integration layer between live discovery and the pure model-lifecycle
 * logic. Resolves a provider's authoritative supported-model set (curated
 * catalog ∪ raw /v1/models discovery) plus a display-name map, so callers
 * can ask `resolveModelLifecycle()` whether an agent's model is retired or
 * has a newer sibling.
 *
 * Anthropic-only for now (the only provider with both discovery and a
 * parseable version scheme). Other providers return an INCOMPLETE set
 * (curated only), which guarantees their agents are never auto-retired.
 */

import { getDbPg } from '../../db.js';
import { TALK_EXECUTOR_ANTHROPIC_API_KEY } from '../config.js';
import { decryptProviderSecret } from '../llm/provider-secret-store.js';
import { discoverAnthropicModels } from './anthropic-model-discovery.js';
import type { DiscoveryCacheLike } from './model-discovery.js';
import {
  isModelServed,
  resolveModelLifecycle,
  type SupportedModels,
} from './model-lifecycle.js';

const ANTHROPIC_PROVIDER_ID = 'provider.anthropic';

export interface ProviderModelSupport {
  supported: SupportedModels;
  /** modelId → friendly label (curated display_name or discovery's). */
  displayNames: Map<string, string>;
}

/** Anthropic API key for the current context — workspace credential wins,
 *  else personal, else the host env var. Returns null when none is set or
 *  decrypt fails. */
async function resolveAnthropicApiKey(): Promise<string | null> {
  const db = getDbPg();
  const wsRows = await db<Array<{ ciphertext: string }>>`
    select ciphertext from public.workspace_provider_secrets
    where provider_id = ${ANTHROPIC_PROVIDER_ID} and credential_kind = 'api_key'
    limit 1
  `;
  const personalRows = wsRows.length
    ? []
    : await db<Array<{ ciphertext: string }>>`
        select ciphertext from public.llm_provider_secrets
        where provider_id = ${ANTHROPIC_PROVIDER_ID}
          and credential_kind = 'api_key'
        limit 1
      `;
  const ciphertext = wsRows[0]?.ciphertext ?? personalRows[0]?.ciphertext;
  if (!ciphertext) {
    // Mirror resolveExecution's env-var fallback: a host-configured Anthropic
    // key can run agents, so discovery must see it too — otherwise the
    // lifecycle (page-load AND run-time net) silently no-ops for env-key-only
    // deployments and a retired model is never detected. Discovery requires an
    // api_key (the OAuth/subscription token is scoped to /v1/messages).
    const envKey = TALK_EXECUTOR_ANTHROPIC_API_KEY.trim();
    return envKey.length > 0 ? envKey : null;
  }
  try {
    const secret = await decryptProviderSecret(ciphertext);
    return secret?.apiKey ?? null;
  } catch {
    return null;
  }
}

async function loadCuratedModels(
  providerId: string,
): Promise<{ ids: Set<string>; displayNames: Map<string, string> }> {
  const db = getDbPg();
  const rows = await db<Array<{ model_id: string; display_name: string }>>`
    select model_id, display_name
    from public.llm_provider_models
    where provider_id = ${providerId}
  `;
  const ids = new Set<string>();
  const displayNames = new Map<string, string>();
  for (const row of rows) {
    ids.add(row.model_id);
    if (row.display_name) displayNames.set(row.model_id, row.display_name);
  }
  return { ids, displayNames };
}

/**
 * Build the authoritative supported-model picture for a provider.
 * `complete` is true only when a successful live discovery backed it —
 * the model-lifecycle resolver requires that before ever flagging a model
 * 'retired', so a missing key or a failed discovery can't trigger an
 * auto-upgrade.
 *
 * `opts.cache` controls the /v1/models read. Page-load passes NOTHING
 * (uncached) — it is the authority that auto-heals retired models the
 * moment the user opens AI Agents, so it must never read a stale list. The
 * run-time safety net passes the Workers Cache: a per-run live Anthropic
 * call would regress TTFT, and a backstop tolerates the discovery layer's
 * status-based TTL (ok 1h, auth_error never, unavailable 60s) because
 * retirement is rare and monotonic.
 */
export async function buildProviderModelSupport(
  providerId: string,
  opts: { cache?: DiscoveryCacheLike | null } = {},
): Promise<ProviderModelSupport> {
  const curatedData = await loadCuratedModels(providerId);
  const curated = curatedData.ids;
  const displayNames = curatedData.displayNames;

  // Incomplete picture (non-Anthropic, no key, failed/empty discovery) →
  // served empty + complete:false, so the lifecycle resolver never retires.
  const incomplete = {
    supported: {
      ids: new Set(curated),
      curated,
      served: new Set<string>(),
      complete: false,
    },
    displayNames,
  };

  if (providerId !== ANTHROPIC_PROVIDER_ID) return incomplete;

  const apiKey = await resolveAnthropicApiKey();
  if (!apiKey) return incomplete;

  // Lifecycle decisions MUTATE agent config (auto-upgrade). The page-load
  // authority passes no cache → a LIVE, uncached /v1/models read, so a stale
  // or partial cached list never drives a page-load auto-upgrade. The
  // run-time net passes the Workers Cache (shared with the picker) to keep
  // the per-run call off the hot path; it still only concludes 'retired'
  // from a complete, non-empty result (guarded below + in resolveModelLifecycle).
  const discovery = await discoverAnthropicModels(apiKey, {
    cache: opts.cache ?? null,
  });
  // An `ok` with an empty list is NOT authoritative — Anthropic always
  // serves several Claude models, so treat empty as a failed probe rather
  // than "everything is retired". Guards against a transient/malformed 200.
  if (discovery.status !== 'ok' || discovery.models.length === 0) {
    return incomplete;
  }

  const served = new Set<string>();
  const ids = new Set(curated);
  for (const model of discovery.models) {
    served.add(model.modelId);
    ids.add(model.modelId);
    // Curated display name wins over discovery's (it's the blessed label).
    if (model.displayName && !displayNames.has(model.modelId)) {
      displayNames.set(model.modelId, model.displayName);
    }
  }
  return { supported: { ids, curated, served, complete: true }, displayNames };
}

/**
 * Resolve the model a RETIRED agent should be moved TO. Shared by the
 * page-load auto-upgrade (agent-management.ts) and the run-time safety net
 * (runtime-model-guard.ts) so the two can never diverge on this
 * correctness-critical choice:
 *   1. the newest SERVED same-family model (the lifecycle engine's
 *      suggestion — already guaranteed to be a live, served version), else
 *   2. the configured default Claude model, but ONLY if it is itself SERVED
 *      (never swap one dead model for another unserved/curated-only one), else
 *   3. null — no safe target; the caller leaves the agent's model untouched.
 *
 * Returns null for any non-retired model. `getDefault` is injectable for
 * tests; production reads settings_kv['executor.defaultClaudeModel'].
 */
export async function resolveRetirementTarget(
  record: { provider_id: string; model_id: string },
  support: ProviderModelSupport,
  getDefault: () => Promise<string | null> = defaultClaudeModelId,
): Promise<string | null> {
  const lifecycle = resolveModelLifecycle(
    record.provider_id,
    record.model_id,
    support.supported,
  );
  if (lifecycle.status !== 'retired') return null;
  if (lifecycle.suggestedModelId) return lifecycle.suggestedModelId;

  // No same-family successor is served (the whole family retired). Fall back
  // to the configured default Claude model — but only when it is itself
  // served, so we never trade a dead model for another dead one.
  const fallback = await getDefault();
  return fallback && isModelServed(fallback, support.supported)
    ? fallback
    : null;
}

/**
 * Default Claude model to fall back to when a retired model has no
 * same-family successor (settings_kv, maintained by the AI Agents UI).
 */
async function defaultClaudeModelId(): Promise<string | null> {
  const db = getDbPg();
  const rows = await db<Array<{ value: string | null }>>`
    select value from public.settings_kv
    where key = 'executor.defaultClaudeModel'
    limit 1
  `;
  return rows[0]?.value ?? null;
}
