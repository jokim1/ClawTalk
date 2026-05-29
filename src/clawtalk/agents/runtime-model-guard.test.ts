import { describe, expect, it, vi } from 'vitest';

import {
  ensureRunnableModel,
  type EnsureRunnableModelDeps,
} from './runtime-model-guard.js';
import type { ProviderModelSupport } from './agent-model-support.js';
import type { RegisteredAgentRecord } from '../db/agent-accessors.js';

const ANTHROPIC = 'provider.anthropic';

function makeAgent(
  overrides: Partial<RegisteredAgentRecord> = {},
): RegisteredAgentRecord {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    owner_id: '22222222-2222-2222-2222-222222222222',
    name: 'Test',
    provider_id: ANTHROPIC,
    model_id: 'claude-opus-4-7',
    tool_permissions_json: {},
    persona_role: null,
    system_prompt: null,
    description: null,
    enabled: true,
    credential_mode: null,
    model_auto_upgraded_from: null,
    model_auto_upgraded_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// The orchestration doesn't read the support object (resolveTarget is
// injected), so an empty incomplete picture is fine for these tests.
const EMPTY_SUPPORT: ProviderModelSupport = {
  supported: {
    ids: new Set(),
    curated: new Set(),
    served: new Set(),
    complete: false,
  },
  displayNames: new Map(),
};

function makeDeps(
  overrides: Partial<EnsureRunnableModelDeps> = {},
): EnsureRunnableModelDeps {
  return {
    loadSupport: vi.fn(async () => EMPTY_SUPPORT),
    resolveTarget: vi.fn(async () => null),
    upgrade: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('ensureRunnableModel', () => {
  it('swaps a retired model and mutates the record in place', async () => {
    const agent = makeAgent({ model_id: 'claude-opus-4-7' });
    const upgradedRow = makeAgent({
      model_id: 'claude-opus-4-8',
      model_auto_upgraded_from: 'claude-opus-4-7',
      model_auto_upgraded_at: '2026-05-29T00:00:00Z',
      updated_at: '2026-05-29T00:00:00Z',
    });
    const deps = makeDeps({
      resolveTarget: vi.fn(async () => 'claude-opus-4-8'),
      upgrade: vi.fn(async () => upgradedRow),
    });

    await ensureRunnableModel(agent, deps);

    expect(deps.upgrade).toHaveBeenCalledWith(
      agent.id,
      ANTHROPIC,
      'claude-opus-4-7',
      'claude-opus-4-8',
    );
    // Mutated in place — this is the propagation mechanism for the run.
    expect(agent.model_id).toBe('claude-opus-4-8');
    expect(agent.model_auto_upgraded_from).toBe('claude-opus-4-7');
    expect(agent.model_auto_upgraded_at).toBe('2026-05-29T00:00:00Z');
  });

  it('does nothing when the model is not retired (no target)', async () => {
    const agent = makeAgent({ model_id: 'claude-opus-4-8' });
    const deps = makeDeps({ resolveTarget: vi.fn(async () => null) });

    await ensureRunnableModel(agent, deps);

    expect(deps.upgrade).not.toHaveBeenCalled();
    expect(agent.model_id).toBe('claude-opus-4-8');
    expect(agent.model_auto_upgraded_from).toBeNull();
  });

  it('does not swap when the target equals the current model', async () => {
    const agent = makeAgent({ model_id: 'claude-opus-4-8' });
    const deps = makeDeps({
      resolveTarget: vi.fn(async () => 'claude-opus-4-8'),
    });

    await ensureRunnableModel(agent, deps);

    expect(deps.upgrade).not.toHaveBeenCalled();
    expect(agent.model_id).toBe('claude-opus-4-8');
  });

  it('fails open when discovery (loadSupport) throws', async () => {
    const agent = makeAgent({ model_id: 'claude-opus-4-7' });
    const deps = makeDeps({
      loadSupport: vi.fn(async () => {
        throw new Error('anthropic /v1/models timed out');
      }),
    });

    await expect(ensureRunnableModel(agent, deps)).resolves.toBeUndefined();
    expect(deps.upgrade).not.toHaveBeenCalled();
    expect(agent.model_id).toBe('claude-opus-4-7'); // untouched
  });

  it('fails open when resolveTarget throws', async () => {
    const agent = makeAgent({ model_id: 'claude-opus-4-7' });
    const deps = makeDeps({
      resolveTarget: vi.fn(async () => {
        throw new Error('settings_kv read failed');
      }),
    });

    await expect(ensureRunnableModel(agent, deps)).resolves.toBeUndefined();
    expect(agent.model_id).toBe('claude-opus-4-7');
  });

  it('fails open when the upgrade write throws', async () => {
    const agent = makeAgent({ model_id: 'claude-opus-4-7' });
    const deps = makeDeps({
      resolveTarget: vi.fn(async () => 'claude-opus-4-8'),
      upgrade: vi.fn(async () => {
        throw new Error('db write failed');
      }),
    });

    await expect(ensureRunnableModel(agent, deps)).resolves.toBeUndefined();
    expect(agent.model_id).toBe('claude-opus-4-7');
  });

  it('adopts the live model when the guarded upgrade lost a concurrent race', async () => {
    // autoUpgradeAgentModel returns undefined when the agent already moved off
    // `from` (a concurrent run/edit won). We must reload and run on the live
    // model — NOT proceed on the stale retired one (the container backend has
    // no later reload).
    const agent = makeAgent({ model_id: 'claude-opus-4-7' });
    const liveRow = makeAgent({
      model_id: 'claude-opus-4-8',
      model_auto_upgraded_from: 'claude-opus-4-7',
    });
    const deps = makeDeps({
      resolveTarget: vi.fn(async () => 'claude-opus-4-8'),
      upgrade: vi.fn(async () => undefined),
      reload: vi.fn(async () => liveRow),
    });

    await ensureRunnableModel(agent, deps);

    expect(deps.upgrade).toHaveBeenCalledOnce();
    expect(deps.reload).toHaveBeenCalledWith(agent.id);
    expect(agent.model_id).toBe('claude-opus-4-8'); // adopted the live row
  });

  it('leaves the record untouched when the lost-race reload finds nothing', async () => {
    const agent = makeAgent({ model_id: 'claude-opus-4-7' });
    const deps = makeDeps({
      resolveTarget: vi.fn(async () => 'claude-opus-4-8'),
      upgrade: vi.fn(async () => undefined),
      reload: vi.fn(async () => undefined),
    });

    await ensureRunnableModel(agent, deps);

    expect(deps.reload).toHaveBeenCalledOnce();
    expect(agent.model_id).toBe('claude-opus-4-7'); // fail open, untouched
  });

  it('fails open when the lost-race reload throws', async () => {
    const agent = makeAgent({ model_id: 'claude-opus-4-7' });
    const deps = makeDeps({
      resolveTarget: vi.fn(async () => 'claude-opus-4-8'),
      upgrade: vi.fn(async () => undefined),
      reload: vi.fn(async () => {
        throw new Error('reload failed');
      }),
    });

    await expect(ensureRunnableModel(agent, deps)).resolves.toBeUndefined();
    expect(agent.model_id).toBe('claude-opus-4-7');
  });

  it('skips non-Anthropic providers without any discovery call', async () => {
    const agent = makeAgent({
      provider_id: 'provider.openai',
      model_id: 'gpt-5.4',
    });
    const deps = makeDeps();

    await ensureRunnableModel(agent, deps);

    expect(deps.loadSupport).not.toHaveBeenCalled();
    expect(deps.resolveTarget).not.toHaveBeenCalled();
    expect(deps.upgrade).not.toHaveBeenCalled();
    expect(agent.model_id).toBe('gpt-5.4');
  });
});
