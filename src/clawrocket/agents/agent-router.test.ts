import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/agent-accessors.js', () => ({
  getRegisteredAgent: vi.fn(),
  TOOL_FAMILY_MAP: {},
}));
vi.mock('./execution-resolver.js', () => ({
  resolveExecution: vi.fn(),
  ExecutionResolverError: class ExecutionResolverError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock('./llm-client.js', () => ({
  streamLlmResponse: vi.fn(),
  LlmClientError: class LlmClientError extends Error {
    failureClass: string;
    statusCode?: number;

    constructor(message: string, failureClass: string, statusCode?: number) {
      super(message);
      this.failureClass = failureClass;
      this.statusCode = statusCode;
    }
  },
}));

import { getRegisteredAgent } from '../db/agent-accessors.js';
import { resolveExecution } from './execution-resolver.js';
import { streamLlmResponse } from './llm-client.js';
import {
  ALWAYS_ALLOWED_CONTEXT_TOOLS,
  executeWithAgent,
} from './agent-router.js';

describe('agent-router', () => {
  beforeEach(() => {
    vi.mocked(getRegisteredAgent).mockReturnValue({
      id: 'agent-1',
      enabled: 1,
      provider_id: 'provider.openai',
      model_id: 'gpt-5-mini',
      tool_permissions_json: '{}',
      system_prompt: 'Be useful.',
    } as never);
    vi.mocked(resolveExecution).mockReturnValue({
      providerConfig: {
        providerId: 'provider.openai',
        baseUrl: 'https://api.openai.com/v1',
        apiFormat: 'openai_chat_completions',
        authScheme: 'bearer',
      },
      secret: {
        apiKey: 'sk-test',
      },
    } as never);
  });

  it('always permits read_state as a talk-internal context tool', () => {
    expect(ALWAYS_ALLOWED_CONTEXT_TOOLS.has('read_state')).toBe(true);
  });

  it('fails incomplete direct-http responses when the provider stops early', async () => {
    vi.mocked(streamLlmResponse).mockImplementation(async function* () {
      yield { type: 'text_delta', text: "I'll read the full content" };
      yield { type: 'done', stopReason: 'length' };
    } as typeof streamLlmResponse);

    const events: Array<Record<string, unknown>> = [];
    await expect(
      executeWithAgent('agent-1', null, 'Review both docs', {
        runId: 'run-1',
        userId: 'owner-1',
        emit: (event) => events.push(event as Record<string, unknown>),
      }),
    ).rejects.toMatchObject({
      code: 'incomplete_response',
    });

    const failedEvent = events.find((event) => event.type === 'failed');
    expect(failedEvent).toMatchObject({
      errorCode: 'incomplete_response',
      completion: {
        completionStatus: 'incomplete',
        providerStopReason: 'length',
        incompleteReason: 'truncated',
      },
    });
    expect(events.some((event) => event.type === 'completed')).toBe(false);
  });

  it('passes the model default output budget through to the direct HTTP client', async () => {
    vi.mocked(resolveExecution).mockReturnValue({
      providerConfig: {
        providerId: 'provider.openai',
        baseUrl: 'https://api.openai.com/v1',
        apiFormat: 'openai_chat_completions',
        authScheme: 'bearer',
      },
      secret: {
        apiKey: 'sk-test',
      },
      defaultMaxOutputTokens: 8192,
    } as never);
    vi.mocked(streamLlmResponse).mockImplementation(async function* (
      _provider,
      _secret,
      _modelId,
      _messages,
      options,
    ) {
      expect(options?.maxOutputTokens).toBe(8192);
      yield { type: 'text_delta', text: 'Ready.' };
      yield { type: 'done', stopReason: 'stop' };
    } as typeof streamLlmResponse);

    const result = await executeWithAgent('agent-1', null, 'Review both docs', {
      runId: 'run-2',
      userId: 'owner-1',
    });

    expect(result.content).toBe('Ready.');
  });
});
