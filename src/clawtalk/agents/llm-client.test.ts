import { describe, expect, it } from 'vitest';

import {
  buildOpenAiRequest,
  type LlmMessage,
  type LlmProviderConfig,
} from './llm-client.js';

const nvidiaProvider: LlmProviderConfig = {
  providerId: 'provider.nvidia',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  apiFormat: 'openai_chat_completions',
  authScheme: 'bearer',
};

const openaiProvider: LlmProviderConfig = {
  providerId: 'provider.openai',
  baseUrl: 'https://api.openai.com/v1',
  apiFormat: 'openai_chat_completions',
  authScheme: 'bearer',
};

const messages: LlmMessage[] = [{ role: 'user', content: 'hi' }];

describe('buildOpenAiRequest — moonshot thinking-disabled allowlist', () => {
  it('adds thinking:disabled for kimi-k2.6 on NVIDIA', () => {
    const req = buildOpenAiRequest(
      nvidiaProvider,
      'moonshotai/kimi-k2.6',
      messages,
      undefined,
      1024,
    );
    expect(req.thinking).toEqual({ type: 'disabled' });
  });

  it('adds thinking:disabled for kimi-k2.5 on NVIDIA (legacy still listed)', () => {
    const req = buildOpenAiRequest(
      nvidiaProvider,
      'moonshotai/kimi-k2.5',
      messages,
      undefined,
      1024,
    );
    expect(req.thinking).toEqual({ type: 'disabled' });
  });

  it('does NOT add thinking for a non-allowlisted moonshot model', () => {
    // Defensive: a future moonshot variant must not be silently muted.
    // If/when such a model needs the flag, add it to MOONSHOT_NO_THINKING.
    const req = buildOpenAiRequest(
      nvidiaProvider,
      'moonshotai/kimi-future-thinking-supported',
      messages,
      undefined,
      1024,
    );
    expect(req.thinking).toBeUndefined();
  });

  it('does NOT add thinking for OpenAI gpt-5-mini', () => {
    const req = buildOpenAiRequest(
      openaiProvider,
      'gpt-5-mini',
      messages,
      undefined,
      1024,
    );
    expect(req.thinking).toBeUndefined();
  });

  it('does NOT add thinking when a moonshot modelId is sent through a non-NVIDIA provider', () => {
    const req = buildOpenAiRequest(
      openaiProvider,
      'moonshotai/kimi-k2.6',
      messages,
      undefined,
      1024,
    );
    expect(req.thinking).toBeUndefined();
  });
});
