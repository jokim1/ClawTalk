export type BuiltinAdditionalProviderKind =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'nvidia';
export type BuiltinAdditionalProviderCredentialMode =
  | 'api_key'
  | 'subscription_only';
export type BuiltinAdditionalProviderApiFormat =
  | 'anthropic_messages'
  | 'openai_chat_completions'
  | 'codex_responses';
export type BuiltinAdditionalProviderAuthScheme = 'x_api_key' | 'bearer';

export interface BuiltinAdditionalProviderModel {
  modelId: string;
  displayName: string;
  contextWindowTokens: number;
  defaultMaxOutputTokens: number;
  defaultTtftTimeoutMs: number;
  supportsVision?: boolean;
}

export interface BuiltinAdditionalProvider {
  id: string;
  name: string;
  providerKind: BuiltinAdditionalProviderKind;
  credentialMode: BuiltinAdditionalProviderCredentialMode;
  apiFormat: BuiltinAdditionalProviderApiFormat;
  baseUrl: string;
  authScheme: BuiltinAdditionalProviderAuthScheme;
  responseStartTimeoutMs: number;
  streamIdleTimeoutMs: number;
  absoluteTimeoutMs: number;
  models: BuiltinAdditionalProviderModel[];
}

export const BUILTIN_ADDITIONAL_PROVIDERS: BuiltinAdditionalProvider[] = [
  {
    id: 'provider.anthropic',
    name: 'Claude (Anthropic)',
    providerKind: 'anthropic',
    credentialMode: 'api_key',
    apiFormat: 'anthropic_messages',
    baseUrl: 'https://api.anthropic.com',
    authScheme: 'x_api_key',
    responseStartTimeoutMs: 60_000,
    streamIdleTimeoutMs: 20_000,
    absoluteTimeoutMs: 300_000,
    models: [
      {
        modelId: 'claude-opus-4-7',
        displayName: 'Claude Opus 4.7',
        contextWindowTokens: 200_000,
        defaultMaxOutputTokens: 8_192,
        defaultTtftTimeoutMs: 60_000,
        supportsVision: true,
      },
      {
        modelId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        contextWindowTokens: 200_000,
        defaultMaxOutputTokens: 8_192,
        defaultTtftTimeoutMs: 45_000,
        supportsVision: true,
      },
      {
        modelId: 'claude-haiku-4-5-20251001',
        displayName: 'Claude Haiku 4.5',
        contextWindowTokens: 200_000,
        defaultMaxOutputTokens: 8_192,
        defaultTtftTimeoutMs: 30_000,
        supportsVision: true,
      },
    ],
  },
  {
    id: 'provider.openai',
    name: 'OpenAI',
    providerKind: 'openai',
    credentialMode: 'api_key',
    apiFormat: 'openai_chat_completions',
    baseUrl: 'https://api.openai.com/v1',
    authScheme: 'bearer',
    responseStartTimeoutMs: 60_000,
    streamIdleTimeoutMs: 20_000,
    absoluteTimeoutMs: 300_000,
    models: [
      {
        modelId: 'gpt-5-mini',
        displayName: 'GPT-5 Mini',
        contextWindowTokens: 128_000,
        defaultMaxOutputTokens: 4_096,
        defaultTtftTimeoutMs: 30_000,
        supportsVision: true,
      },
    ],
  },
  {
    id: 'provider.openai_codex',
    name: 'ChatGPT Codex (Subscription)',
    providerKind: 'openai',
    credentialMode: 'subscription_only',
    apiFormat: 'codex_responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    authScheme: 'bearer',
    responseStartTimeoutMs: 120_000,
    streamIdleTimeoutMs: 60_000,
    absoluteTimeoutMs: 1_800_000,
    models: [
      {
        modelId: 'gpt-5.4',
        displayName: 'GPT-5.4',
        contextWindowTokens: 128_000,
        defaultMaxOutputTokens: 8_192,
        defaultTtftTimeoutMs: 60_000,
        supportsVision: true,
      },
      {
        modelId: 'gpt-5.4-mini',
        displayName: 'GPT-5.4 Mini',
        contextWindowTokens: 128_000,
        defaultMaxOutputTokens: 8_192,
        defaultTtftTimeoutMs: 45_000,
        supportsVision: true,
      },
      {
        modelId: 'gpt-5.3-codex',
        displayName: 'GPT-5.3 Codex',
        contextWindowTokens: 400_000,
        defaultMaxOutputTokens: 128_000,
        defaultTtftTimeoutMs: 45_000,
        supportsVision: true,
      },
    ],
  },
  {
    id: 'provider.gemini',
    name: 'Google / Gemini',
    providerKind: 'gemini',
    credentialMode: 'api_key',
    apiFormat: 'openai_chat_completions',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authScheme: 'bearer',
    responseStartTimeoutMs: 90_000,
    streamIdleTimeoutMs: 20_000,
    absoluteTimeoutMs: 300_000,
    models: [
      {
        modelId: 'gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        contextWindowTokens: 1_000_000,
        defaultMaxOutputTokens: 8_192,
        defaultTtftTimeoutMs: 45_000,
        supportsVision: true,
      },
    ],
  },
  {
    id: 'provider.nvidia',
    name: 'NVIDIA NIM',
    providerKind: 'nvidia',
    credentialMode: 'api_key',
    apiFormat: 'openai_chat_completions',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    authScheme: 'bearer',
    responseStartTimeoutMs: 90_000,
    // NVIDIA NIM serving Kimi 2.6 (and other large MoE models) has
    // long mid-stream pauses between text and tool-use blocks — the
    // model finishes its prose, then thinks for ~30s about the
    // function call before emitting the tool_use delta. 20s was too
    // tight; 60s leaves room for that transition while still catching
    // genuine hangs well before the 300s absolute ceiling.
    streamIdleTimeoutMs: 60_000,
    absoluteTimeoutMs: 300_000,
    models: [
      {
        modelId: 'moonshotai/kimi-k2.6',
        displayName: 'Kimi 2.6 (NVIDIA)',
        contextWindowTokens: 262_144,
        defaultMaxOutputTokens: 16_384,
        defaultTtftTimeoutMs: 60_000,
        supportsVision: true,
      },
    ],
  },
];

export const BUILTIN_ADDITIONAL_PROVIDER_IDS = BUILTIN_ADDITIONAL_PROVIDERS.map(
  (provider) => provider.id,
);
