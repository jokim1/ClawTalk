/**
 * llm-client.ts
 *
 * Provider-agnostic LLM client abstraction for streaming and non-streaming calls.
 * Supports Anthropic Messages API and OpenAI Chat Completions API via raw fetch.
 *
 * Key features:
 * - SSE streaming with proper timeout management
 * - Tool call support for both Anthropic and OpenAI formats
 * - Auth header abstraction (x-api-key vs Bearer)
 * - Comprehensive error classification
 * - AbortSignal integration for cancellation
 */

import { randomUUID } from 'crypto';

import {
  computeAdaptiveResponseStartTimeout,
  recordTtftObservation,
} from './llm-timeout-stats.js';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

export type LlmApiFormat = 'anthropic_messages' | 'openai_chat_completions';
export type LlmAuthScheme = 'x_api_key' | 'bearer';

export interface LlmProviderConfig {
  providerId?: string;
  baseUrl: string;
  apiFormat: LlmApiFormat;
  authScheme: LlmAuthScheme;
  responseStartTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
}

export interface LlmSecret {
  apiKey: string;
  organizationId?: string;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | LlmContentBlock[];
  toolCallId?: string;
}

export type LlmContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      mimeType: string;
      data: string;
      detail?: 'auto' | 'low' | 'high';
    }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      toolUseId: string;
      content: string;
      isError?: boolean;
    };

export interface LlmStreamEvent {
  type:
    | 'text_delta'
    | 'tool_call_start'
    | 'tool_call_delta'
    | 'usage'
    | 'done'
    | 'error';
  text?: string;
  toolCall?: {
    id: string;
    name: string;
    argumentsDelta?: string;
    arguments?: string;
  };
  usage?: { inputTokens: number; outputTokens: number };
  stopReason?: string;
  error?: string;
}

export interface LlmResponse {
  content: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
}

export class LlmClientError extends Error {
  constructor(
    message: string,
    public readonly failureClass: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'LlmClientError';
  }
}

// =============================================================================
// INTERNAL TYPES
// =============================================================================

interface SseEvent {
  event?: string;
  data: string;
}

interface TimeoutConfig {
  responseStartTimeoutMs: number;
  streamIdleTimeoutMs: number;
  absoluteTimeoutMs: number;
}

// =============================================================================
// ANTHROPIC TYPE DEFINITIONS
// =============================================================================

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContent[];
}

type AnthropicContent =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: string;
        data: string;
      };
    }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// =============================================================================
// OPENAI TYPE DEFINITIONS
// =============================================================================

interface OpenAiMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string | OpenAiContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

type OpenAiContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: {
        url: string;
        detail?: 'auto' | 'low' | 'high';
      };
    };

interface OpenAiToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function contentToPlainText(content: string | LlmContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter(
      (block): block is Extract<LlmContentBlock, { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.text)
    .join('');
}

function toOpenAiUserContentParts(
  content: string | LlmContentBlock[],
): string | OpenAiContentPart[] {
  if (typeof content === 'string') {
    return content;
  }

  const parts: OpenAiContentPart[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${block.mimeType};base64,${block.data}`,
          ...(block.detail ? { detail: block.detail } : {}),
        },
      });
    }
  }

  return parts;
}

/**
 * Build authorization headers based on the authentication scheme.
 */
export function buildAuthHeaders(
  provider: LlmProviderConfig,
  secret: LlmSecret | null,
): Record<string, string> {
  if (!secret) return {};

  const headers: Record<string, string> = {};
  if (provider.authScheme === 'x_api_key') {
    headers['x-api-key'] = secret.apiKey;
  } else {
    headers.authorization = `Bearer ${secret.apiKey}`;
  }

  if (secret.organizationId) {
    headers['OpenAI-Organization'] = secret.organizationId;
  }

  return headers;
}

/**
 * Build timeout configuration.
 *
 * response-start timeout priority:
 * 1. Explicit provider override (llm_providers.response_start_timeout_ms) — admin knob
 * 2. Adaptive: computed from observed TTFT stats for this (provider, model)
 * 3. Per-model cold-start default (llm_provider_models.default_ttft_timeout_ms)
 * 4. Model-class heuristic / ultimate fallback
 *
 * Steps 2-4 are handled by computeAdaptiveResponseStartTimeout().
 */
function buildTimeoutConfig(
  provider: LlmProviderConfig,
  modelId?: string,
): TimeoutConfig {
  let responseStartTimeoutMs: number;

  if (provider.responseStartTimeoutMs != null) {
    // Explicit admin override — honour it as-is
    responseStartTimeoutMs = provider.responseStartTimeoutMs;
  } else if (provider.providerId && modelId) {
    // Adaptive computation from TTFT stats / model defaults / heuristics
    responseStartTimeoutMs = computeAdaptiveResponseStartTimeout(
      provider.providerId,
      modelId,
    );
  } else {
    // No provider ID or model ID available — conservative fallback
    responseStartTimeoutMs = 120_000;
  }

  return {
    responseStartTimeoutMs,
    streamIdleTimeoutMs: provider.streamIdleTimeoutMs ?? 20000,
    absoluteTimeoutMs: provider.absoluteTimeoutMs ?? 300000,
  };
}

/**
 * Parse SSE (Server-Sent Events) buffer into individual events.
 *
 * SSE format:
 * - Event boundaries: double newline (\n\n)
 * - Event type: "event: <type>"
 * - Data: "data: <json>"
 * - End marker: "data: [DONE]"
 */
export function parseSseBuffer(buffer: string): {
  events: SseEvent[];
  remainder: string;
} {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const remainder = parts.pop() || '';
  const events = parts
    .map((block) => {
      const lines = block.split('\n');
      let eventType: string | undefined;
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const rawData = line.slice(5);
          dataLines.push(rawData.startsWith(' ') ? rawData.slice(1) : rawData);
        }
      }
      return {
        event: eventType,
        data: dataLines.join('\n'),
      };
    })
    .filter((event) => event.data || event.event);

  return { events, remainder };
}

/**
 * Read SSE response body and emit events.
 */
async function readSseResponse(
  response: Response,
  controller: AbortController,
  parentSignal: AbortSignal,
  timeouts: TimeoutConfig,
  onEvent: (event: SseEvent) => Promise<void> | void,
  onFirstChunk?: (elapsedMs: number) => void,
): Promise<void> {
  if (!response.body) {
    throw new LlmClientError(
      'Provider response did not include a streaming body.',
      'network',
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawFirstChunk = false;
  const streamStartTime = Date.now();

  let responseStartTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => {
      controller.abort('response_start_timeout');
    },
    timeouts.responseStartTimeoutMs,
  );

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const absoluteTimer = setTimeout(() => {
    controller.abort('absolute_timeout');
  }, timeouts.absoluteTimeoutMs);

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      controller.abort('stream_idle_timeout');
    }, timeouts.streamIdleTimeoutMs);
  };

  try {
    while (!parentSignal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!sawFirstChunk) {
        sawFirstChunk = true;
        if (responseStartTimer) {
          clearTimeout(responseStartTimer);
          responseStartTimer = null;
        }
        if (onFirstChunk) {
          try {
            onFirstChunk(Date.now() - streamStartTime);
          } catch {
            /* never break stream */
          }
        }
      }

      resetIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBuffer(buffer);
      buffer = parsed.remainder;
      for (const event of parsed.events) {
        await onEvent(event);
      }
    }

    if (buffer.trim()) {
      const parsed = parseSseBuffer(`${buffer}\n\n`);
      for (const event of parsed.events) {
        await onEvent(event);
      }
    }
  } catch (error) {
    if (parentSignal.aborted) {
      throw new LlmClientError(
        `Cancelled: ${String(parentSignal.reason || 'aborted')}`,
        'network',
      );
    }
    if (controller.signal.aborted) {
      const reason = String(controller.signal.reason || 'timeout');
      throw new LlmClientError(
        `Provider request timed out: ${reason}`,
        'timeout',
      );
    }
    throw error;
  } finally {
    if (responseStartTimer) clearTimeout(responseStartTimer);
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(absoluteTimer);
    reader.releaseLock();
  }
}

// =============================================================================
// REQUEST BUILDERS
// =============================================================================

/**
 * Convert LlmMessage[] to Anthropic format.
 * Extracts system message if present, converts tool calls to Anthropic format.
 */
function buildAnthropicRequest(
  modelId: string,
  messages: LlmMessage[],
  tools: LlmToolDefinition[] | undefined,
  maxOutputTokens: number | undefined,
): {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicToolDefinition[];
  stream: boolean;
} {
  let systemText = '';
  const conversationMessages: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const plainText = contentToPlainText(msg.content);
      systemText += (systemText ? '\n\n' : '') + plainText;
    } else if (msg.role === 'assistant') {
      const content: AnthropicContent[] = [];
      if (typeof msg.content === 'string') {
        content.push({ type: 'text', text: msg.content });
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') {
            content.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            content.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: (block.input ?? {}) as Record<string, unknown>,
            });
          }
        }
      }
      conversationMessages.push({ role: 'assistant', content });
    } else if (msg.role === 'tool') {
      // Tool responses are wrapped in a user message with tool_result blocks
      const content: AnthropicContent[] = [];
      if (typeof msg.content === 'string') {
        content.push({
          type: 'tool_result',
          tool_use_id: msg.toolCallId || '',
          content: msg.content,
        });
      } else {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            content.push({
              type: 'tool_result',
              tool_use_id: block.toolUseId,
              content: block.content,
              is_error: block.isError,
            });
          }
        }
      }
      conversationMessages.push({ role: 'user', content });
    } else if (msg.role === 'user') {
      const content: AnthropicContent[] = [];
      if (typeof msg.content === 'string') {
        content.push({ type: 'text', text: msg.content });
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') {
            content.push({ type: 'text', text: block.text });
          } else if (block.type === 'image') {
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: block.mimeType,
                data: block.data,
              },
            });
          }
        }
      }
      conversationMessages.push({ role: 'user', content });
    }
  }

  return {
    model: modelId,
    max_tokens: maxOutputTokens || 1024,
    ...(systemText ? { system: systemText } : {}),
    messages: conversationMessages,
    ...(tools && tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }
      : {}),
    stream: true,
  };
}

/**
 * Convert LlmMessage[] to OpenAI format.
 */
function buildOpenAiRequest(
  provider: LlmProviderConfig,
  modelId: string,
  messages: LlmMessage[],
  tools: LlmToolDefinition[] | undefined,
  maxOutputTokens: number | undefined,
): {
  model: string;
  max_tokens: number;
  messages: OpenAiMessage[];
  tools?: OpenAiToolDefinition[];
  stream: boolean;
  stream_options: { include_usage: boolean };
  thinking?: { type: 'disabled' };
} {
  const conversationMessages: OpenAiMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      conversationMessages.push({
        role: 'system',
        content: contentToPlainText(msg.content),
      });
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        conversationMessages.push({
          role: 'assistant',
          content: msg.content,
        });
      } else {
        const toolCalls: OpenAiMessage['tool_calls'] = [];
        let textContent = '';
        for (const block of msg.content) {
          if (block.type === 'text') {
            textContent += block.text;
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }
        conversationMessages.push({
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        });
      }
    } else if (msg.role === 'tool') {
      conversationMessages.push({
        role: 'tool',
        tool_call_id: msg.toolCallId || '',
        content: contentToPlainText(msg.content),
      });
    } else if (msg.role === 'user') {
      conversationMessages.push({
        role: 'user',
        content: toOpenAiUserContentParts(msg.content),
      });
    }
  }

  return {
    model: modelId,
    max_tokens: maxOutputTokens || 1024,
    messages: conversationMessages,
    ...(tools && tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }
      : {}),
    stream: true,
    stream_options: { include_usage: true },
    // NVIDIA-hosted Kimi defaults to "thinking" mode, which emits reasoning
    // separately from the final assistant content. Disable that mode so the
    // generic OpenAI-compatible parser receives normal assistant text deltas.
    ...(provider.providerId === 'provider.nvidia' &&
    modelId === 'moonshotai/kimi-k2.5'
      ? { thinking: { type: 'disabled' as const } }
      : {}),
  };
}

// =============================================================================
// RESPONSE PARSING
// =============================================================================

/**
 * Parse Anthropic streaming response and yield events.
 */
async function* parseAnthropicStream(
  response: Response,
  controller: AbortController,
  signal: AbortSignal,
  timeouts: TimeoutConfig,
  onFirstChunk?: (elapsedMs: number) => void,
): AsyncGenerator<LlmStreamEvent> {
  const blocks: Array<{
    type: 'text' | 'tool_use';
    id?: string;
    name?: string;
    text?: string;
    inputJson?: string;
  }> = [];
  let currentBlockIndex = -1;
  let stopReason = '';
  const eventQueue: LlmStreamEvent[] = [];

  const queueEvent = (event: LlmStreamEvent) => {
    eventQueue.push(event);
  };

  await readSseResponse(
    response,
    controller,
    signal,
    timeouts,
    (event) => {
      if (event.data === '[DONE]' || event.event === 'ping') return;

      const payload = JSON.parse(event.data) as Record<string, unknown>;

      if (payload.type === 'content_block_start') {
        const block =
          typeof payload.content_block === 'object' && payload.content_block
            ? (payload.content_block as Record<string, unknown>)
            : null;
        if (block?.type === 'text') {
          blocks.push({ type: 'text', text: '' });
          currentBlockIndex = blocks.length - 1;
        } else if (block?.type === 'tool_use') {
          const blockId =
            typeof block.id === 'string' ? block.id : randomUUID();
          const blockName =
            typeof block.name === 'string' ? block.name : 'unknown_tool';
          blocks.push({
            type: 'tool_use',
            id: blockId,
            name: blockName,
            inputJson: '',
          });
          currentBlockIndex = blocks.length - 1;
          queueEvent({
            type: 'tool_call_start',
            toolCall: { id: blockId, name: blockName },
          });
        }
        return;
      }

      if (payload.type === 'content_block_delta' && currentBlockIndex >= 0) {
        const currentBlock = blocks[currentBlockIndex];
        const delta =
          typeof payload.delta === 'object' && payload.delta
            ? (payload.delta as Record<string, unknown>)
            : null;
        if (currentBlock.type === 'text' && typeof delta?.text === 'string') {
          currentBlock.text = (currentBlock.text || '') + delta.text;
          queueEvent({ type: 'text_delta', text: delta.text });
          return;
        }
        if (
          currentBlock.type === 'tool_use' &&
          typeof delta?.partial_json === 'string'
        ) {
          currentBlock.inputJson =
            (currentBlock.inputJson || '') + delta.partial_json;
          queueEvent({
            type: 'tool_call_delta',
            toolCall: {
              id: currentBlock.id!,
              name: currentBlock.name!,
              argumentsDelta: delta.partial_json,
            },
          });
          return;
        }
      }

      if (
        (payload.type === 'message_start' ||
          payload.type === 'message_delta') &&
        typeof payload.message === 'object' &&
        payload.message &&
        'usage' in payload.message
      ) {
        const rawUsage = (
          payload.message as {
            usage?: { input_tokens?: number; output_tokens?: number };
          }
        ).usage;
        if (rawUsage) {
          queueEvent({
            type: 'usage',
            usage: {
              inputTokens: rawUsage.input_tokens ?? 0,
              outputTokens: rawUsage.output_tokens ?? 0,
            },
          });
        }
      }

      if (
        payload.type === 'message_delta' &&
        typeof payload.delta === 'object' &&
        payload.delta &&
        'stop_reason' in payload.delta
      ) {
        stopReason = String(
          (payload.delta as { stop_reason?: unknown }).stop_reason ||
            'end_turn',
        );
      }

      if (payload.type === 'error') {
        const message =
          typeof payload.error === 'object' &&
          payload.error &&
          'message' in payload.error &&
          typeof (payload.error as { message?: unknown }).message === 'string'
            ? String((payload.error as { message: string }).message)
            : 'Anthropic streaming request failed.';
        queueEvent({ type: 'error', error: message });
      }
    },
    onFirstChunk,
  );

  // Emit final tool calls with complete arguments
  for (const block of blocks) {
    if (block.type === 'tool_use' && block.inputJson) {
      queueEvent({
        type: 'tool_call_delta',
        toolCall: {
          id: block.id!,
          name: block.name!,
          arguments: block.inputJson,
        },
      });
    }
  }

  queueEvent({ type: 'done', stopReason });

  // Yield all queued events
  for (const evt of eventQueue) {
    yield evt;
  }
}

/**
 * Parse OpenAI streaming response and yield events.
 */
async function* parseOpenAiStream(
  response: Response,
  controller: AbortController,
  signal: AbortSignal,
  timeouts: TimeoutConfig,
  onFirstChunk?: (elapsedMs: number) => void,
): AsyncGenerator<LlmStreamEvent> {
  const toolCallsByIndex = new Map<
    number,
    { id: string; name: string; argumentsJson: string }
  >();
  let stopReason = '';
  const eventQueue: LlmStreamEvent[] = [];

  const queueEvent = (event: LlmStreamEvent) => {
    eventQueue.push(event);
  };

  await readSseResponse(
    response,
    controller,
    signal,
    timeouts,
    (event) => {
      if (!event.data || event.data === '[DONE]') return;

      const payload = JSON.parse(event.data) as {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
        };
        error?: { message?: string };
      };

      if (payload.error?.message) {
        queueEvent({ type: 'error', error: payload.error.message });
        return;
      }

      const choice = payload.choices?.[0];
      const deltaText = choice?.delta?.content || '';
      if (deltaText) {
        queueEvent({ type: 'text_delta', text: deltaText });
      }

      for (const toolDelta of choice?.delta?.tool_calls || []) {
        const index = Number.isFinite(toolDelta.index)
          ? Number(toolDelta.index)
          : 0;
        const current = toolCallsByIndex.get(index) || {
          id: toolDelta.id || randomUUID(),
          name: '',
          argumentsJson: '',
        };
        if (toolDelta.id) {
          current.id = toolDelta.id;
        }
        if (toolDelta.function?.name) {
          current.name = toolDelta.function.name;
          queueEvent({
            type: 'tool_call_start',
            toolCall: { id: current.id, name: current.name },
          });
        }
        if (toolDelta.function?.arguments) {
          current.argumentsJson += toolDelta.function.arguments;
          queueEvent({
            type: 'tool_call_delta',
            toolCall: {
              id: current.id,
              name: current.name,
              argumentsDelta: toolDelta.function.arguments,
            },
          });
        }
        toolCallsByIndex.set(index, current);
      }

      if (choice?.finish_reason) {
        stopReason = choice.finish_reason;
      }

      if (payload.usage) {
        queueEvent({
          type: 'usage',
          usage: {
            inputTokens: payload.usage.prompt_tokens ?? 0,
            outputTokens: payload.usage.completion_tokens ?? 0,
          },
        });
      }
    },
    onFirstChunk,
  );

  queueEvent({ type: 'done', stopReason });

  // Yield all queued events
  for (const evt of eventQueue) {
    yield evt;
  }
}

// =============================================================================
// MAIN STREAMING FUNCTION
// =============================================================================

/**
 * Stream LLM response as an async generator yielding individual events.
 *
 * This is the core function that:
 * - Builds auth headers based on scheme
 * - Converts messages to the appropriate API format
 * - Makes the HTTP POST request
 * - Parses SSE stream events
 * - Yields structured LlmStreamEvent objects
 * - Manages timeouts and cancellation
 */
export async function* streamLlmResponse(
  provider: LlmProviderConfig,
  secret: LlmSecret | null,
  modelId: string,
  messages: LlmMessage[],
  options?: {
    tools?: LlmToolDefinition[];
    maxOutputTokens?: number;
    signal?: AbortSignal;
  },
): AsyncGenerator<LlmStreamEvent> {
  const controller = new AbortController();
  const parentSignal = options?.signal || new AbortController().signal;

  const onAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal.reason || 'aborted');
    }
  };
  parentSignal.addEventListener('abort', onAbort, { once: true });

  try {
    const timeouts = buildTimeoutConfig(provider, modelId);
    const authHeaders = buildAuthHeaders(provider, secret);

    // TTFT recording callback — fires once per streaming call on first chunk
    const onFirstChunk = (elapsedMs: number) => {
      if (provider.providerId) {
        recordTtftObservation(provider.providerId, modelId, elapsedMs);
      }
    };

    if (provider.apiFormat === 'anthropic_messages') {
      const requestBody = buildAnthropicRequest(
        modelId,
        messages,
        options?.tools,
        options?.maxOutputTokens,
      );

      const response = await fetch(`${provider.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...authHeaders,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        const failureClass = classifyHttpFailure(response.status, errorText);
        throw new LlmClientError(
          `Anthropic API error: ${response.statusText}`,
          failureClass,
          response.status,
        );
      }

      yield* parseAnthropicStream(
        response,
        controller,
        parentSignal,
        timeouts,
        onFirstChunk,
      );
    } else if (provider.apiFormat === 'openai_chat_completions') {
      const requestBody = buildOpenAiRequest(
        provider,
        modelId,
        messages,
        options?.tools,
        options?.maxOutputTokens,
      );

      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        const failureClass = classifyHttpFailure(response.status, errorText);
        throw new LlmClientError(
          `OpenAI API error: ${response.statusText}`,
          failureClass,
          response.status,
        );
      }

      yield* parseOpenAiStream(
        response,
        controller,
        parentSignal,
        timeouts,
        onFirstChunk,
      );
    } else {
      throw new LlmClientError(
        `Unsupported API format: ${provider.apiFormat}`,
        'invalid_request',
      );
    }
  } catch (error) {
    if (parentSignal.aborted && !controller.signal.aborted) {
      throw new LlmClientError(
        `Operation cancelled: ${String(parentSignal.reason || 'aborted')}`,
        'network',
      );
    }
    throw error;
  } finally {
    parentSignal.removeEventListener('abort', onAbort);
  }
}

// =============================================================================
// CONVENIENCE FUNCTION FOR NON-STREAMING
// =============================================================================

/**
 * Consume the streaming response and return a single LlmResponse.
 */
export async function callLlm(
  provider: LlmProviderConfig,
  secret: LlmSecret | null,
  modelId: string,
  messages: LlmMessage[],
  options?: {
    tools?: LlmToolDefinition[];
    maxOutputTokens?: number;
    signal?: AbortSignal;
  },
): Promise<LlmResponse> {
  let content = '';
  const toolCallsMap = new Map<
    string,
    { name: string; argumentsJson: string }
  >();
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = '';

  for await (const event of streamLlmResponse(
    provider,
    secret,
    modelId,
    messages,
    options,
  )) {
    switch (event.type) {
      case 'text_delta':
        if (event.text) {
          content += event.text;
        }
        break;
      case 'tool_call_start':
        if (event.toolCall) {
          toolCallsMap.set(event.toolCall.id, {
            name: event.toolCall.name,
            argumentsJson: '',
          });
        }
        break;
      case 'tool_call_delta':
        if (event.toolCall) {
          const current = toolCallsMap.get(event.toolCall.id);
          if (current && event.toolCall.argumentsDelta) {
            current.argumentsJson += event.toolCall.argumentsDelta;
          }
          if (current && event.toolCall.arguments) {
            current.argumentsJson = event.toolCall.arguments;
          }
        }
        break;
      case 'usage':
        if (event.usage) {
          inputTokens = event.usage.inputTokens;
          outputTokens = event.usage.outputTokens;
        }
        break;
      case 'done':
        stopReason = event.stopReason || 'end_turn';
        break;
      case 'error':
        throw new LlmClientError(
          event.error || 'Unknown error',
          'upstream_5xx',
        );
    }
  }

  const toolCalls = Array.from(toolCallsMap.entries()).map(([id, call]) => ({
    id,
    name: call.name,
    arguments: call.argumentsJson ? JSON.parse(call.argumentsJson) : {},
  }));

  return {
    content: content.trim() || 'No response generated.',
    toolCalls,
    usage: { inputTokens, outputTokens },
    stopReason,
  };
}

// =============================================================================
// ERROR CLASSIFICATION
// =============================================================================

/**
 * Classify HTTP errors into failure classes for retry logic.
 */
function classifyHttpFailure(statusCode: number, errorText: string): string {
  if (statusCode === 401 || statusCode === 403) {
    return 'auth';
  }
  if (statusCode === 429) {
    return 'rate_limit';
  }
  if (statusCode >= 500 && statusCode < 600) {
    return 'upstream_5xx';
  }
  if (statusCode === 400 || statusCode === 422) {
    return 'invalid_request';
  }
  if (statusCode === 451) {
    return 'policy';
  }
  return 'network';
}
