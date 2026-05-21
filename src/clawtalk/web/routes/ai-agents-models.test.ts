import { describe, expect, it } from 'vitest';

import { buildModelSuggestions } from './ai-agents.js';

const curatedNvidia = [
  {
    provider_id: 'provider.nvidia',
    model_id: 'moonshotai/kimi-k2.6',
    display_name: 'Kimi 2.6 (NVIDIA)',
    context_window_tokens: 262_144,
    default_max_output_tokens: 16_384,
    default_ttft_timeout_ms: 60_000,
  },
];

describe('buildModelSuggestions', () => {
  it('returns curated-only when discovery is null', () => {
    const out = buildModelSuggestions('provider.nvidia', curatedNvidia, null);
    expect(out.map((m) => m.modelId)).toEqual(['moonshotai/kimi-k2.6']);
    expect(out[0].displayName).toBe('Kimi 2.6 (NVIDIA)');
  });

  it('appends live-discovered models that are not in the curated set', () => {
    const out = buildModelSuggestions('provider.nvidia', curatedNvidia, {
      status: 'ok',
      models: [
        { modelId: 'moonshotai/kimi-k2.6' }, // dupe — skip
        { modelId: 'meta/llama-3.3-70b-instruct' },
        { modelId: 'deepseek-ai/deepseek-r1' },
      ],
    });
    expect(out.map((m) => m.modelId)).toEqual([
      'moonshotai/kimi-k2.6',
      'meta/llama-3.3-70b-instruct',
      'deepseek-ai/deepseek-r1',
    ]);
  });

  it('keeps curated display name when a live result matches by modelId', () => {
    const out = buildModelSuggestions('provider.nvidia', curatedNvidia, {
      status: 'ok',
      models: [{ modelId: 'moonshotai/kimi-k2.6' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].displayName).toBe('Kimi 2.6 (NVIDIA)');
    expect(out[0].contextWindowTokens).toBe(262_144);
  });

  it('falls back to curated when discovery returned auth_error', () => {
    const out = buildModelSuggestions('provider.nvidia', curatedNvidia, {
      status: 'auth_error',
      models: [],
      message: 'Key invalid',
    });
    expect(out).toHaveLength(1);
    expect(out[0].modelId).toBe('moonshotai/kimi-k2.6');
  });

  it('uses modelId as the displayName for live-only models', () => {
    const out = buildModelSuggestions('provider.nvidia', [], {
      status: 'ok',
      models: [{ modelId: 'meta/llama-3.3-70b-instruct' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].displayName).toBe('meta/llama-3.3-70b-instruct');
    // Live-only models don't have known token windows; zeros are sentinels.
    expect(out[0].contextWindowTokens).toBe(0);
    expect(out[0].defaultMaxOutputTokens).toBe(0);
  });

  it('does not append live models when discovery is in any non-ok status', () => {
    const out = buildModelSuggestions('provider.nvidia', curatedNvidia, {
      status: 'unavailable',
      models: [{ modelId: 'meta/llama-3.3-70b-instruct' }],
      message: 'transient',
    });
    expect(out.map((m) => m.modelId)).toEqual(['moonshotai/kimi-k2.6']);
  });
});
