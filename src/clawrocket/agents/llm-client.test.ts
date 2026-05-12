import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  callLlm,
  type LlmMessage,
  type LlmProviderConfig,
} from './llm-client.js';

function makeSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
      },
    },
  );
}

describe('llm-client multimodal request building', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serializes image blocks for Anthropic Messages requests', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        makeSseResponse([
          'event: content_block_start\n' +
            'data: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\n' +
            'data: {"type":"content_block_delta","delta":{"text":"ok"}}\n\n',
          'event: message_delta\n' +
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        ]),
      );

    const provider: LlmProviderConfig = {
      providerId: 'provider.anthropic',
      baseUrl: 'https://api.anthropic.test',
      apiFormat: 'anthropic_messages',
      authScheme: 'x_api_key',
    };
    const messages: LlmMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this screenshot.' },
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'iVBORw0KGgo=',
            detail: 'auto',
          },
        ],
      },
    ];

    await callLlm(
      provider,
      { apiKey: 'test-key' },
      'claude-sonnet-4-6',
      messages,
    );

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).toBeTruthy();
    const body = JSON.parse(String(request?.body)) as any;
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this screenshot.' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgo=',
            },
          },
        ],
      },
    ]);
  });

  it('serializes image blocks for OpenAI-compatible chat completions requests', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        makeSseResponse([
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
          'data: [DONE]\n\n',
        ]),
      );

    const provider: LlmProviderConfig = {
      providerId: 'provider.openai',
      baseUrl: 'https://api.openai.test',
      apiFormat: 'openai_chat_completions',
      authScheme: 'bearer',
    };
    const messages: LlmMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this screenshot.' },
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'iVBORw0KGgo=',
            detail: 'low',
          },
        ],
      },
    ];

    await callLlm(provider, { apiKey: 'test-key' }, 'gpt-4.1', messages);

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).toBeTruthy();
    const body = JSON.parse(String(request?.body)) as any;
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this screenshot.' },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,iVBORw0KGgo=',
              detail: 'low',
            },
          },
        ],
      },
    ]);
  });

  it('disables thinking mode for NVIDIA-hosted Kimi chat completions', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        makeSseResponse([
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
          'data: [DONE]\n\n',
        ]),
      );

    const provider: LlmProviderConfig = {
      providerId: 'provider.nvidia',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiFormat: 'openai_chat_completions',
      authScheme: 'bearer',
    };
    const messages: LlmMessage[] = [
      {
        role: 'user',
        content: 'Review this slide deck.',
      },
    ];

    await callLlm(
      provider,
      { apiKey: 'test-key' },
      'moonshotai/kimi-k2.5',
      messages,
    );

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).toBeTruthy();
    const body = JSON.parse(String(request?.body)) as any;
    expect(body.thinking).toEqual({ type: 'disabled' });
  });
});
