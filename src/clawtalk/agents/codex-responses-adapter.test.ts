import { describe, expect, it } from 'vitest';

import {
  buildCodexCloudflareHeaders,
  buildCodexRequestBody,
  createCodexStreamState,
  CodexRequestValidationError,
  deriveResponseItemId,
  deterministicCallId,
  finalizeCodexStream,
  handleCodexSseEvent,
  llmMessagesToResponsesInput,
  llmToolDefinitionsToResponses,
  preflightCodexRequestBody,
  TOOL_CALL_LEAK_PATTERN,
} from './codex-responses-adapter.js';
import type { LlmMessage, LlmToolDefinition } from './llm-client.js';

// ---------------------------------------------------------------------------
// llmMessagesToResponsesInput
// ---------------------------------------------------------------------------

describe('llmMessagesToResponsesInput', () => {
  it('strips system messages — they belong in the top-level instructions field', () => {
    const out = llmMessagesToResponsesInput([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi' },
    ]);
    expect(out).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('converts assistant string content into a plain assistant input item', () => {
    const out = llmMessagesToResponsesInput([
      { role: 'assistant', content: 'sure thing' },
    ]);
    expect(out).toEqual([{ role: 'assistant', content: 'sure thing' }]);
  });

  it('emits a function_call item for each tool_use block on an assistant message', () => {
    const messages: LlmMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'looking up' },
          {
            type: 'tool_use',
            id: 'call_abc',
            name: 'search',
            input: { q: 'cats' },
          },
        ],
      },
    ];
    const out = llmMessagesToResponsesInput(messages);
    expect(out).toEqual([
      { role: 'assistant', content: 'looking up' },
      {
        type: 'function_call',
        call_id: 'call_abc',
        name: 'search',
        arguments: '{"q":"cats"}',
      },
    ]);
  });

  it('converts a tool message into a function_call_output item', () => {
    const out = llmMessagesToResponsesInput([
      { role: 'tool', toolCallId: 'call_abc', content: '42 results' },
    ]);
    expect(out).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_abc',
        output: '42 results',
      },
    ]);
  });

  it('replays encrypted reasoning items from providerData on assistant messages', () => {
    const reasoningBlob = {
      type: 'reasoning',
      encrypted_content: 'ENCRYPTED_OPAQUE_BLOB',
      id: 'rs_xyz',
      summary: [{ type: 'summary_text', text: 'thinking…' }],
    };
    const out = llmMessagesToResponsesInput([
      {
        role: 'assistant',
        content: 'final answer here',
        providerData: {
          codexReasoningItems: [reasoningBlob],
        },
      },
    ]);
    // Reasoning item is replayed FIRST, then the assistant message.
    // The `id` field is stripped on replay (store=false rejects it).
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      type: 'reasoning',
      encrypted_content: 'ENCRYPTED_OPAQUE_BLOB',
      summary: [{ type: 'summary_text', text: 'thinking…' }],
    });
    expect(out[1]).toEqual({
      role: 'assistant',
      content: 'final answer here',
    });
  });

  it('replays codexMessageItems verbatim (preserving id + phase) and skips fallback content', () => {
    const messageItem = {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      id: 'msg_456',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'ready' }],
    };
    const out = llmMessagesToResponsesInput([
      {
        role: 'assistant',
        // Should NOT be used — replayed messageItems win.
        content: 'old fallback text',
        providerData: { codexMessageItems: [messageItem] },
      },
    ]);
    expect(out).toEqual([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'ready' }],
        id: 'msg_456',
        phase: 'final_answer',
      },
    ]);
  });

  it('emits an empty assistant follow-up after reasoning-only items so the API gets its required following item', () => {
    const out = llmMessagesToResponsesInput([
      {
        role: 'assistant',
        content: '',
        providerData: {
          codexReasoningItems: [{ type: 'reasoning', encrypted_content: 'X' }],
        },
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: 'reasoning' });
    expect(out[1]).toEqual({ role: 'assistant', content: '' });
  });
});

// ---------------------------------------------------------------------------
// llmToolDefinitionsToResponses
// ---------------------------------------------------------------------------

describe('llmToolDefinitionsToResponses', () => {
  it('returns undefined for an empty tool list', () => {
    expect(llmToolDefinitionsToResponses([])).toBeUndefined();
    expect(llmToolDefinitionsToResponses(undefined)).toBeUndefined();
  });

  it('converts LlmToolDefinition into Responses function-tool shape', () => {
    const tools: LlmToolDefinition[] = [
      {
        name: 'search',
        description: 'search the web',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ];
    const out = llmToolDefinitionsToResponses(tools);
    expect(out).toEqual([
      {
        type: 'function',
        name: 'search',
        description: 'search the web',
        strict: false,
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildCodexRequestBody + preflight
// ---------------------------------------------------------------------------

describe('buildCodexRequestBody', () => {
  it('puts system prompt into top-level instructions and asks for encrypted reasoning', () => {
    const body = buildCodexRequestBody({
      model: 'gpt-5.4',
      systemPrompt: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body).toMatchObject({
      model: 'gpt-5.4',
      instructions: 'be helpful',
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'medium', summary: 'auto' },
    });
    expect(body.input).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('attaches tool_choice + parallel_tool_calls only when tools are present', () => {
    const noTools = buildCodexRequestBody({
      model: 'gpt-5.4',
      systemPrompt: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(noTools.tools).toBeUndefined();
    expect(noTools.tool_choice).toBeUndefined();

    const withTools = buildCodexRequestBody({
      model: 'gpt-5.4',
      systemPrompt: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 's', description: '', inputSchema: { type: 'object' } }],
    });
    expect(withTools.tools).toHaveLength(1);
    expect(withTools.tool_choice).toBe('auto');
    expect(withTools.parallel_tool_calls).toBe(true);
  });

  it('forwards max_output_tokens, prompt_cache_key, and stream when set', () => {
    const body = buildCodexRequestBody({
      model: 'gpt-5.4',
      systemPrompt: 's',
      messages: [],
      maxOutputTokens: 1024,
      sessionId: 'talk-uuid-abc',
      stream: true,
    });
    expect(body.max_output_tokens).toBe(1024);
    expect(body.prompt_cache_key).toBe('talk-uuid-abc');
    expect(body.stream).toBe(true);
  });
});

describe('preflightCodexRequestBody', () => {
  function baseBody() {
    return buildCodexRequestBody({
      model: 'gpt-5.4',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });
  }

  it('accepts a well-formed body', () => {
    expect(() => preflightCodexRequestBody(baseBody())).not.toThrow();
  });

  it('rejects missing model', () => {
    const body = baseBody();
    (body as { model?: string }).model = '';
    expect(() => preflightCodexRequestBody(body)).toThrow(
      CodexRequestValidationError,
    );
  });

  it('rejects store !== false', () => {
    const body = { ...baseBody(), store: true as unknown as false };
    expect(() => preflightCodexRequestBody(body)).toThrow(
      CodexRequestValidationError,
    );
  });

  it('rejects unknown fields', () => {
    const body = { ...baseBody(), foo: 'bar' } as ReturnType<
      typeof baseBody
    > & {
      foo: string;
    };
    expect(() => preflightCodexRequestBody(body)).toThrow(/foo/);
  });

  it('rejects malformed tools', () => {
    const body = {
      ...baseBody(),
      tools: [
        {
          type: 'not_function' as 'function',
          name: 'x',
          parameters: {},
        } as never,
      ],
    };
    expect(() => preflightCodexRequestBody(body)).toThrow(/type/);
  });
});

// ---------------------------------------------------------------------------
// Cloudflare headers + JWT
// ---------------------------------------------------------------------------

function makeFakeJwt(claims: Record<string, unknown>): string {
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.SIG`;
}

describe('buildCodexCloudflareHeaders', () => {
  it('always emits the codex_cli_rs originator + UA — Cloudflare 403s without them', () => {
    const headers = buildCodexCloudflareHeaders('');
    expect(headers.originator).toBe('codex_cli_rs');
    expect(headers['User-Agent']).toMatch(/^codex_cli_rs\//);
  });

  it('extracts ChatGPT-Account-ID from the JWT chatgpt_account_id claim', () => {
    const token = makeFakeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_42' },
    });
    const headers = buildCodexCloudflareHeaders(token);
    expect(headers['ChatGPT-Account-ID']).toBe('acct_42');
  });

  it('tolerates malformed JWTs — drops the account header rather than throwing', () => {
    const headers = buildCodexCloudflareHeaders('not.a.real.jwt');
    expect(headers).not.toHaveProperty('ChatGPT-Account-ID');
    expect(headers.originator).toBe('codex_cli_rs');
  });
});

// ---------------------------------------------------------------------------
// Streaming event handling + finalize
// ---------------------------------------------------------------------------

describe('handleCodexSseEvent', () => {
  it('forwards response.output_text.delta as text_delta', () => {
    const state = createCodexStreamState();
    const out = handleCodexSseEvent(state, {
      type: 'response.output_text.delta',
      delta: 'hello ',
    });
    expect(out).toEqual([{ type: 'text_delta', text: 'hello ' }]);
    expect(state.collectedTextDeltas).toEqual(['hello ']);
  });

  it('forwards function_call_arguments.delta as tool_call_delta', () => {
    const state = createCodexStreamState();
    const out = handleCodexSseEvent(state, {
      type: 'response.function_call_arguments.delta',
      delta: '{"q":',
      item_id: 'fc_x',
    });
    expect(out).toEqual([
      {
        type: 'tool_call_delta',
        toolCall: { id: 'fc_x', name: '', argumentsDelta: '{"q":' },
      },
    ]);
  });

  it('captures function_call items via response.output_item.added → tool_call_start', () => {
    const state = createCodexStreamState();
    const out = handleCodexSseEvent(state, {
      type: 'response.output_item.added',
      item: {
        type: 'function_call',
        name: 'search',
        call_id: 'call_999',
        arguments: '',
      },
    });
    expect(state.hasToolCalls).toBe(true);
    expect(out).toEqual([
      {
        type: 'tool_call_start',
        toolCall: { id: 'call_999', name: 'search' },
      },
    ]);
  });

  it('captures items via response.output_item.done', () => {
    const state = createCodexStreamState();
    handleCodexSseEvent(state, {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'all done' }],
        status: 'completed',
      },
    });
    expect(state.items).toHaveLength(1);
  });

  it('captures terminal status + usage from response.completed', () => {
    const state = createCodexStreamState();
    handleCodexSseEvent(state, {
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: { input_tokens: 200, output_tokens: 80 },
      },
    });
    expect(state.responseStatus).toBe('completed');
    expect(state.inputTokens).toBe(200);
    expect(state.outputTokens).toBe(80);
  });

  it('emits an error event for type=error frames', () => {
    const state = createCodexStreamState();
    const out = handleCodexSseEvent(state, {
      type: 'error',
      message: 'rate limited',
    });
    expect(out).toEqual([{ type: 'error', error: 'rate limited' }]);
    expect(state.errorMessage).toBe('rate limited');
  });
});

describe('finalizeCodexStream', () => {
  it('returns the plain message text + finishReason=stop when only message items are present', () => {
    const state = createCodexStreamState();
    state.responseStatus = 'completed';
    state.items.push({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'final answer' }],
    });
    const result = finalizeCodexStream(state);
    expect(result.content).toBe('final answer');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
  });

  it('extracts function_call items as toolCalls and marks finishReason=tool_calls', () => {
    const state = createCodexStreamState();
    state.responseStatus = 'completed';
    state.items.push({
      type: 'function_call',
      name: 'search',
      call_id: 'call_abc',
      arguments: '{"q":"cats"}',
    });
    const result = finalizeCodexStream(state);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([
      {
        id: 'call_abc',
        callId: 'call_abc',
        responseItemId: 'fc_abc',
        name: 'search',
        arguments: '{"q":"cats"}',
      },
    ]);
  });

  it('captures encrypted reasoning items + message items for persistence', () => {
    const state = createCodexStreamState();
    state.responseStatus = 'completed';
    state.items.push({
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'BLOB',
      summary: [{ type: 'summary_text', text: 'thought' }],
    });
    state.items.push({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      id: 'msg_1',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'visible answer' }],
    });
    const result = finalizeCodexStream(state);
    expect(result.codexReasoningItems).toHaveLength(1);
    expect(result.codexReasoningItems[0]).toMatchObject({
      type: 'reasoning',
      encrypted_content: 'BLOB',
      id: 'rs_1',
    });
    expect(result.codexMessageItems).toHaveLength(1);
    expect(result.codexMessageItems[0]).toMatchObject({
      type: 'message',
      role: 'assistant',
      id: 'msg_1',
      phase: 'final_answer',
    });
  });

  it('detects leaked tool-call text — clears content, marks incomplete', () => {
    const state = createCodexStreamState();
    state.responseStatus = 'completed';
    state.items.push({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'assistant to=functions.search {"q":"x"}',
        },
      ],
    });
    const result = finalizeCodexStream(state);
    expect(result.leakedToolCallText).toBe(true);
    expect(result.content).toBe('');
    expect(result.finishReason).toBe('incomplete');
  });

  it('marks reasoning-only output as incomplete (model needs another turn)', () => {
    const state = createCodexStreamState();
    state.responseStatus = 'completed';
    state.items.push({
      type: 'reasoning',
      encrypted_content: 'BLOB',
    });
    const result = finalizeCodexStream(state);
    expect(result.finishReason).toBe('incomplete');
    expect(result.content).toBe('');
    expect(result.codexReasoningItems).toHaveLength(1);
  });

  it('treats response.status=incomplete as incomplete', () => {
    const state = createCodexStreamState();
    state.responseStatus = 'incomplete';
    state.items.push({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'partial' }],
    });
    const result = finalizeCodexStream(state);
    expect(result.finishReason).toBe('incomplete');
  });
});

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

describe('id helpers', () => {
  it('deterministicCallId is stable for the same (name, args, index)', () => {
    const a = deterministicCallId('search', '{"q":"x"}', 0);
    const b = deterministicCallId('search', '{"q":"x"}', 0);
    expect(a).toBe(b);
    expect(a).toMatch(/^call_/);
  });

  it('deriveResponseItemId returns the existing fc_ id when valid', () => {
    expect(deriveResponseItemId('call_x', 'fc_y')).toBe('fc_y');
  });

  it('deriveResponseItemId rewrites call_ → fc_ when no response_item_id', () => {
    expect(deriveResponseItemId('call_abc')).toBe('fc_abc');
  });
});

// ---------------------------------------------------------------------------
// Leak pattern sanity
// ---------------------------------------------------------------------------

describe('TOOL_CALL_LEAK_PATTERN', () => {
  it.each([
    'to=functions.search',
    'assistant to=functions.exec_command {"cmd":"ls"}',
    '<|channel|>commentary to=functions.foo',
  ])('matches leak form %s', (s) => {
    expect(TOOL_CALL_LEAK_PATTERN.test(s)).toBe(true);
  });

  it('does not match legitimate prose mentioning the word "functions"', () => {
    expect(
      TOOL_CALL_LEAK_PATTERN.test('there are functions defined here'),
    ).toBe(false);
  });
});
