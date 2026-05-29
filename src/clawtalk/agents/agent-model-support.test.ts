import { describe, expect, it, vi } from 'vitest';

import { resolveRetirementTarget } from './agent-model-support.js';
import type { ProviderModelSupport } from './agent-model-support.js';

const ANTHROPIC = 'provider.anthropic';

// Mirror of model-lifecycle.test.ts's helper, wrapped in the
// ProviderModelSupport shape resolveRetirementTarget consumes. `served`
// defaults to mirroring `ids`; tests that need a curated-but-unserved id
// pass `served` explicitly.
function support(
  ids: string[],
  opts?: { curated?: string[]; served?: string[]; complete?: boolean },
): ProviderModelSupport {
  const complete = opts?.complete ?? true;
  return {
    supported: {
      ids: new Set(ids),
      curated: new Set(opts?.curated ?? ids),
      served: new Set(complete ? (opts?.served ?? ids) : (opts?.served ?? [])),
      complete,
    },
    displayNames: new Map(),
  };
}

describe('resolveRetirementTarget', () => {
  it('returns the newest served same-family model for a retired model', async () => {
    const getDefault = vi.fn(async () => 'claude-opus-4-8');
    const target = await resolveRetirementTarget(
      { provider_id: ANTHROPIC, model_id: 'claude-opus-4-7' },
      support(['claude-opus-4-8']),
      getDefault,
    );
    expect(target).toBe('claude-opus-4-8');
    // The same-family suggestion short-circuits — the default isn't consulted.
    expect(getDefault).not.toHaveBeenCalled();
  });

  it('prefers the curated alias over a served dated snapshot', async () => {
    const target = await resolveRetirementTarget(
      { provider_id: ANTHROPIC, model_id: 'claude-opus-4-7' },
      support(['claude-opus-4-8', 'claude-opus-4-8-20260528'], {
        curated: ['claude-opus-4-8'],
        served: ['claude-opus-4-8-20260528'],
      }),
    );
    expect(target).toBe('claude-opus-4-8');
  });

  it('falls back to the default Claude model when the whole family retired', async () => {
    const target = await resolveRetirementTarget(
      { provider_id: ANTHROPIC, model_id: 'claude-opus-4-7' },
      support(['claude-sonnet-4-6']),
      async () => 'claude-sonnet-4-6',
    );
    expect(target).toBe('claude-sonnet-4-6');
  });

  it('returns null when the default fallback is itself not served', async () => {
    const target = await resolveRetirementTarget(
      { provider_id: ANTHROPIC, model_id: 'claude-opus-4-7' },
      support(['claude-sonnet-4-6']),
      async () => 'claude-haiku-9-9', // not in the served set
    );
    expect(target).toBeNull();
  });

  it('returns null when there is no successor and no default configured', async () => {
    const target = await resolveRetirementTarget(
      { provider_id: ANTHROPIC, model_id: 'claude-opus-4-7' },
      support(['claude-sonnet-4-6']),
      async () => null,
    );
    expect(target).toBeNull();
  });

  it('returns null for a model that is still served (not retired)', async () => {
    const getDefault = vi.fn(async () => 'claude-opus-4-8');
    const target = await resolveRetirementTarget(
      { provider_id: ANTHROPIC, model_id: 'claude-opus-4-8' },
      support(['claude-opus-4-8']),
      getDefault,
    );
    expect(target).toBeNull();
    expect(getDefault).not.toHaveBeenCalled();
  });

  it('returns null when discovery is incomplete (never concludes retired)', async () => {
    const target = await resolveRetirementTarget(
      { provider_id: ANTHROPIC, model_id: 'claude-opus-4-7' },
      // complete:false → served empty → resolveModelLifecycle never retires.
      support(['claude-opus-4-8'], { complete: false }),
      async () => 'claude-opus-4-8',
    );
    expect(target).toBeNull();
  });

  it('returns null for non-Anthropic providers', async () => {
    const target = await resolveRetirementTarget(
      { provider_id: 'provider.openai', model_id: 'gpt-5.4' },
      support(['gpt-5.5']),
      async () => 'gpt-5.5',
    );
    expect(target).toBeNull();
  });
});
