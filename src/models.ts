/**
 * Model Registry
 *
 * Single source of truth for all known LLM models, their metadata,
 * pricing, aliases, and display info.
 */

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  shortAlias: string;
  emoji: string;
  tier: 'fast' | 'balanced' | 'powerful' | 'reasoning';
  pricing: { input: number; output: number };
  aliases: string[];
}

export const MODEL_REGISTRY: ModelInfo[] = [
  // --- DeepSeek ---
  {
    id: 'deepseek/deepseek-chat',
    provider: 'DeepSeek',
    name: 'DeepSeek Chat',
    shortAlias: 'Deep',
    emoji: '⚡',
    tier: 'fast',
    pricing: { input: 0.14, output: 0.28 },
    aliases: ['deep', 'deepseek'],
  },
  {
    id: 'deepseek/deepseek-reasoner',
    provider: 'DeepSeek',
    name: 'DeepSeek Reasoner',
    shortAlias: 'Deep-R1',
    emoji: '🔬',
    tier: 'reasoning',
    pricing: { input: 0.55, output: 2.19 },
    aliases: ['deepr1', 'reasoner'],
  },
  // --- Anthropic ---
  {
    id: 'anthropic/claude-opus-4-5',
    provider: 'Anthropic',
    name: 'Claude Opus 4.5',
    shortAlias: 'Opus',
    emoji: '🧠',
    tier: 'powerful',
    pricing: { input: 15, output: 75 },
    aliases: ['opus'],
  },
  {
    id: 'anthropic/claude-sonnet-4-5',
    provider: 'Anthropic',
    name: 'Claude Sonnet 4.5',
    shortAlias: 'Sonnet',
    emoji: '⚖️ ',
    tier: 'balanced',
    pricing: { input: 3, output: 15 },
    aliases: ['sonnet'],
  },
  {
    id: 'anthropic/claude-haiku-3-5',
    provider: 'Anthropic',
    name: 'Claude Haiku 3.5',
    shortAlias: 'Haiku',
    emoji: '⚡',
    tier: 'fast',
    pricing: { input: 0.80, output: 4 },
    aliases: ['haiku'],
  },
  // --- OpenAI ---
  {
    id: 'openai/gpt-5.2',
    provider: 'OpenAI',
    name: 'GPT-5.2',
    shortAlias: 'GPT',
    emoji: '🧠',
    tier: 'powerful',
    pricing: { input: 2.50, output: 10 },
    aliases: ['gpt', 'gpt5'],
  },
  {
    id: 'openai/gpt-5-mini',
    provider: 'OpenAI',
    name: 'GPT-5 Mini',
    shortAlias: 'GPT-Mini',
    emoji: '⚡',
    tier: 'fast',
    pricing: { input: 0.15, output: 0.60 },
    aliases: ['gptmini'],
  },
  {
    id: 'openai/gpt-4o',
    provider: 'OpenAI',
    name: 'GPT-4o',
    shortAlias: 'GPT-4o',
    emoji: '⚖️ ',
    tier: 'balanced',
    pricing: { input: 2.50, output: 10 },
    aliases: ['gpt4o'],
  },
  {
    id: 'openai/gpt-4o-mini',
    provider: 'OpenAI',
    name: 'GPT-4o Mini',
    shortAlias: 'GPT-4o-Mini',
    emoji: '⚡',
    tier: 'fast',
    pricing: { input: 0.15, output: 0.60 },
    aliases: ['gpt4omini'],
  },
  // --- Google ---
  {
    id: 'google/gemini-2.5-flash',
    provider: 'Google',
    name: 'Gemini 2.5 Flash',
    shortAlias: 'Gemini',
    emoji: '⚡',
    tier: 'fast',
    pricing: { input: 0.15, output: 0.60 },
    aliases: ['gemini', 'flash'],
  },
  {
    id: 'google/gemini-3-pro-preview',
    provider: 'Google',
    name: 'Gemini 3 Pro (Preview)',
    shortAlias: 'Gemini-Pro',
    emoji: '🧠',
    tier: 'powerful',
    pricing: { input: 1.25, output: 5 },
    aliases: ['geminipro'],
  },
  {
    id: 'google/gemini-3-flash-preview',
    provider: 'Google',
    name: 'Gemini 3 Flash (Preview)',
    shortAlias: 'Gemini-3F',
    emoji: '⚡',
    tier: 'fast',
    pricing: { input: 0.15, output: 0.60 },
    aliases: ['gemini3flash'],
  },
  // --- Moonshot ---
  {
    id: 'moonshot/kimi-k2-0905-preview',
    provider: 'Moonshot',
    name: 'Kimi K2 (Preview)',
    shortAlias: 'Kimi',
    emoji: '🌙',
    tier: 'balanced',
    pricing: { input: 0.60, output: 2.40 },
    aliases: ['kimi'],
  },
];

/** Map from model ID to ModelInfo */
export const MODEL_BY_ID: Record<string, ModelInfo> =
  Object.fromEntries(MODEL_REGISTRY.map(m => [m.id, m]));

/** Map from alias to model ID */
export const ALIAS_TO_MODEL_ID: Record<string, string> =
  Object.fromEntries(
    MODEL_REGISTRY.flatMap(m => m.aliases.map(a => [a, m.id]))
  );

/** Extract the provider key from a model ID (e.g. "anthropic" from "anthropic/claude-opus-4-5") */
export function getProviderKey(modelId: string): string {
  return modelId.split('/')[0] ?? modelId;
}

/** Format a pricing label for the model picker */
export function formatPricingLabel(
  model: ModelInfo,
  billing?: { mode: 'api' | 'subscription'; plan?: string },
): string {
  if (billing?.mode === 'subscription') {
    return `${billing.plan ?? 'Sub'} plan`;
  }
  return `$${model.pricing.input}/$${model.pricing.output}`;
}

/** Get short alias for a model (for status bar display) */
export function getModelAlias(modelId: string): string {
  return MODEL_BY_ID[modelId]?.shortAlias
    ?? modelId.split('/').pop()?.split('-')[0]
    ?? 'AI';
}

/** Get pricing for a model */
export function getModelPricing(modelId: string): { input: number; output: number } {
  return MODEL_BY_ID[modelId]?.pricing ?? { input: 1, output: 5 };
}

/** Build a ModelInfo for an unknown model ID discovered from the gateway */
export function buildUnknownModelInfo(id: string): ModelInfo {
  const parts = id.split('/');
  const provider = parts[0] ?? 'Unknown';
  const name = parts[1] ?? id;
  return {
    id,
    provider: provider.charAt(0).toUpperCase() + provider.slice(1),
    name,
    shortAlias: name.split('-')[0] ?? id,
    emoji: '❓',
    tier: 'balanced',
    pricing: { input: 1, output: 5 },
    aliases: [],
  };
}
