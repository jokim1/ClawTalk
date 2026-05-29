/**
 * runtime-model-guard.ts
 *
 * Run-time safety net for the model lifecycle. Page-load
 * (agent-management.ts) is the AUTHORITY that auto-heals a retired model the
 * moment the user opens AI Agents; this guard is the backstop that runs JUST
 * BEFORE a run so a Talk never fails on a model the provider has stopped
 * serving — including for a user who runs Talks but hasn't reopened that page
 * since the retirement, and for the main agent.
 *
 * FAIL-OPEN is the whole contract. Any discovery error, incomplete model
 * list, missing credential, or absence of a safe served target leaves the
 * agent's configured model untouched. The net never blocks a run and never
 * swaps to an unconfirmed model — at worst it does nothing and the run
 * proceeds exactly as it would have without it.
 *
 * Anthropic-only (the lifecycle engine only reasons about Claude ids); other
 * providers return immediately, with no discovery call. The discovery read
 * goes through the Workers Cache (see buildProviderModelSupport) so the
 * per-run call stays off the hot path, and the swap is PERSISTED out-of-band
 * (auto-commit, see autoUpgradeAgentModelOutsideTx) so it never holds the
 * agent row lock for the run's streaming transaction.
 */

import {
  autoUpgradeAgentModelOutsideTx,
  getRegisteredAgent,
  type RegisteredAgentRecord,
} from '../db/agent-accessors.js';
import {
  buildProviderModelSupport,
  resolveRetirementTarget,
  type ProviderModelSupport,
} from './agent-model-support.js';
import type { DiscoveryCacheLike } from './model-discovery.js';

const ANTHROPIC_PROVIDER_ID = 'provider.anthropic';

/**
 * The Cloudflare Workers default Cache, or undefined in environments (Node,
 * tests) that don't expose it. Mirrors ai-agents.ts:getDefaultCache —
 * `caches.default` is a Workers extension, kept loosely typed so the project
 * tsconfig doesn't need @cloudflare/workers-types just for this.
 */
function getRuntimeDiscoveryCache(): DiscoveryCacheLike | undefined {
  const g = globalThis as typeof globalThis & {
    caches?: { default?: unknown };
  };
  return (g.caches?.default ?? undefined) as DiscoveryCacheLike | undefined;
}

/**
 * Injectable seams so the orchestration (fail-open, only-swap-when-retired,
 * mutate-in-place) is unit-testable without a DB or a live Anthropic call.
 * Production uses the real implementations.
 */
export interface EnsureRunnableModelDeps {
  loadSupport: (providerId: string) => Promise<ProviderModelSupport>;
  resolveTarget: (
    record: Pick<RegisteredAgentRecord, 'provider_id' | 'model_id'>,
    support: ProviderModelSupport,
  ) => Promise<string | null>;
  upgrade: (
    agentId: string,
    expectedProviderId: string,
    fromModel: string,
    toModel: string,
  ) => Promise<RegisteredAgentRecord | undefined>;
  /**
   * Reload the current persisted row. Used to adopt a concurrent writer's
   * model when our guarded upgrade lost the race (see ensureRunnableModel).
   */
  reload: (agentId: string) => Promise<RegisteredAgentRecord | undefined>;
}

// Each default is a thin arrow, not a direct export reference, so importing
// this module never force-resolves the underlying bindings at load time —
// tests that partially mock agent-accessors / agent-model-support (e.g.
// agent-router.test.ts) can import the execution path without listing every
// transitive export. The real functions run only on the Anthropic swap path.
const defaultDeps: EnsureRunnableModelDeps = {
  loadSupport: (providerId) =>
    buildProviderModelSupport(providerId, {
      cache: getRuntimeDiscoveryCache(),
    }),
  resolveTarget: (record, support) => resolveRetirementTarget(record, support),
  // Out-of-band (auto-commit) so the swap doesn't hold the agent row lock for
  // the run's whole streaming transaction — see autoUpgradeAgentModelOutsideTx.
  upgrade: (agentId, expectedProviderId, fromModel, toModel) =>
    autoUpgradeAgentModelOutsideTx(
      agentId,
      expectedProviderId,
      fromModel,
      toModel,
    ),
  reload: (agentId) => getRegisteredAgent(agentId),
};

/**
 * If `agent`'s configured model is RETIRED, swap it to the newest served
 * same-family model (or the served default) so the run doesn't fail on a dead
 * model, persisting the upgrade trail so the UI can surface a badge.
 *
 * MUTATES `agent` in place (model_id + the upgrade-trail fields) so every
 * downstream read of the same record reflects the swap for the rest of the
 * run — context-window sizing, vision/pdf capability gating, the LLM call,
 * and the persisted run metadata all read `agent.model_id`. Callers share a
 * single object reference, so the mutation is the propagation mechanism.
 *
 * Never throws — see the module doc: fail-open.
 */
export async function ensureRunnableModel(
  agent: RegisteredAgentRecord,
  deps: EnsureRunnableModelDeps = defaultDeps,
): Promise<void> {
  // Skip the discovery call entirely for providers the lifecycle engine
  // can't reason about — only Claude ids parse into family + version.
  if (agent.provider_id !== ANTHROPIC_PROVIDER_ID) return;

  try {
    const support = await deps.loadSupport(agent.provider_id);
    // resolveTarget returns null for any non-retired model and for a retired
    // model with no SAFE served target — both leave the agent untouched.
    const target = await deps.resolveTarget(agent, support);
    if (!target || target === agent.model_id) return;

    const upgraded = await deps.upgrade(
      agent.id,
      agent.provider_id,
      agent.model_id,
      target,
    );
    if (upgraded) {
      Object.assign(agent, upgraded);
      return;
    }

    // The guarded update matched no row: another writer changed this agent's
    // model between our load and the write (a concurrent run's swap, a
    // page-load auto-upgrade, or a manual edit). Our stale `from` lost the
    // race. Adopt the CURRENT persisted row so the run uses the live model
    // rather than the retired one we loaded — the Talk container backend has
    // no later reload, so without this it would still call the dead model.
    // One reload, then fail-open: we don't re-run the lifecycle on the result
    // (a pathological concurrent re-retirement isn't worth a loop on a backstop).
    const current = await deps.reload(agent.id);
    if (current) Object.assign(agent, current);
  } catch {
    // FAIL-OPEN — a discovery/DB hiccup must never block or corrupt a run.
  }
}
