/**
 * codex-responses-adapter.ts
 *
 * Format conversion + streaming-event parsing for the OpenAI Responses
 * API as served from chatgpt.com/backend-api/codex (ChatGPT Plus/Pro
 * subscription).
 *
 * Ported from hermes' agent/codex_responses_adapter.py and the
 * Cloudflare-header glue in agent/auxiliary_client.py. The Codex
 * backend speaks a Responses-shaped API (input items, function_call
 * items, encrypted reasoning items) that differs structurally from
 * openai_chat_completions — this file owns that translation so
 * llm-client.ts can stay focused on HTTP + SSE dispatch.
 *
 * Key shape transformations:
 *
 *   llm-client LlmMessage[]               ←→ Responses input items
 *   llm-client LlmToolDefinition[]        ←→ Responses function tools
 *   chatgpt.com SSE event stream          ←→ LlmStreamEvent generator
 *   Responses output items (final state)  ←→ assistant text + tool calls
 *                                             + codexReasoningItems
 *                                             + codexMessageItems
 *
 * The two opaque blobs (codexReasoningItems, codexMessageItems) are
 * persisted into talk_messages.metadata_json after the turn so they
 * can be replayed verbatim on the next request — preserving the
 * server-side reasoning chain and prefix-cache hits.
 */

import { createHash } from 'crypto';

import type {
  LlmContentBlock,
  LlmMessage,
  LlmStreamEvent,
  LlmToolDefinition,
} from './llm-client.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Tool-call leak detector.
 *
 * gpt-5.x on the Codex Responses API occasionally degenerates and
 * emits what should be a `function_call` item as plain assistant text
 * using the Harmony/Codex serialization (`to=functions.foo {json}`,
 * `assistant to=functions.foo {json}`, or
 * `<|channel|>commentary to=functions.foo`). When this happens
 * `response.output` has no `function_call` item and the parent
 * agent loop ends up surfacing a confident-looking text answer with
 * no tools actually invoked.
 *
 * Detection: leaked tokens always contain `to=functions.<name>`. The
 * optional `assistant` or Harmony channel prefix varies; the
 * `to=functions.` marker is stable. Case-insensitive to cover
 * uppercase/lowercase `assistant` variants.
 */
export const TOOL_CALL_LEAK_PATTERN =
  /(?:^|[\s>|])to=functions\.[A-Za-z_][\w.]*/i;

const RESPONSE_MESSAGE_STATUSES = new Set([
  'completed',
  'incomplete',
  'in_progress',
]);

// ============================================================================
// Public types
// ============================================================================

export type CodexRole = 'user' | 'assistant';

export type CodexInputItem =
  | {
      type?: 'message';
      role: CodexRole;
      content: string | CodexContentPart[];
    }
  | {
      type: 'function_call';
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: 'function_call_output';
      call_id: string;
      output: string | CodexContentPart[];
    }
  | {
      type: 'reasoning';
      encrypted_content: string;
      summary?: Array<Record<string, unknown>>;
    }
  | {
      type: 'message';
      role: 'assistant';
      status: string;
      content: Array<{ type: 'output_text'; text: string }>;
      id?: string;
      phase?: string;
    };

export type CodexContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: string };

export interface CodexFunctionTool {
  type: 'function';
  name: string;
  description: string;
  strict: boolean;
  parameters: Record<string, unknown>;
}

export interface CodexRequestBody {
  model: string;
  instructions: string;
  input: CodexInputItem[];
  store: false;
  tools?: CodexFunctionTool[];
  tool_choice?: 'auto' | 'required' | 'none';
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string; summary?: string };
  include?: string[];
  max_output_tokens?: number;
  prompt_cache_key?: string;
  stream?: true;
}

export interface CodexBuildOptions {
  model: string;
  systemPrompt: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  maxOutputTokens?: number;
  /**
   * Stable per-conversation identifier for prompt-cache routing on the
   * Codex backend. Used as `prompt_cache_key` body field + session_id
   * / x-client-request-id request headers. Defaults to no caching.
   */
  sessionId?: string;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  stream?: boolean;
}

/**
 * Final assistant result extracted from the accumulated Responses
 * output items.
 */
export interface CodexAssistantResult {
  content: string;
  toolCalls: Array<{
    id: string;
    callId: string;
    responseItemId: string;
    name: string;
    arguments: string;
  }>;
  reasoning: string | null;
  finishReason: 'stop' | 'tool_calls' | 'incomplete';
  /** Encrypted reasoning items to persist + replay on next turn. */
  codexReasoningItems: Array<Record<string, unknown>>;
  /** Assistant message items (with phase/id) to persist + replay. */
  codexMessageItems: Array<Record<string, unknown>>;
  leakedToolCallText: boolean;
  usage: { inputTokens: number; outputTokens: number } | null;
}

// ============================================================================
// JWT / Cloudflare headers
// ============================================================================

/**
 * Headers required to avoid Cloudflare 403s on chatgpt.com/backend-api/codex.
 *
 * The Cloudflare layer whitelists a small set of first-party
 * originators (`codex_cli_rs`, `codex_vscode`, `codex_sdk_ts`).
 * Requests from non-residential IPs (the Worker, CI runners,
 * residential VPNs) that don't advertise an allowed originator are
 * served a 403 with `cf-mitigated: challenge`. We pin
 * `originator: codex_cli_rs` to match the upstream codex-rs CLI, send
 * a codex_cli_rs-shaped User-Agent, and extract `ChatGPT-Account-ID`
 * (canonical casing) from the OAuth JWT's `chatgpt_account_id` claim.
 *
 * Malformed tokens are tolerated — we drop the account-ID header
 * rather than throwing, so a bad token still surfaces as 401 on the
 * server instead of failing at request-construction time.
 */
export function buildCodexCloudflareHeaders(
  accessToken: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'codex_cli_rs/0.0.0 (ClawTalk)',
    originator: 'codex_cli_rs',
  };
  const accountId = extractChatGptAccountId(accessToken);
  if (accountId) {
    headers['ChatGPT-Account-ID'] = accountId;
  }
  return headers;
}

function extractChatGptAccountId(accessToken: string): string | null {
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    return null;
  }
  const parts = accessToken.split('.');
  if (parts.length < 2) return null;
  try {
    const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    const claims = JSON.parse(json) as Record<string, unknown>;
    const auth = claims['https://api.openai.com/auth'];
    if (auth && typeof auth === 'object') {
      const acct = (auth as Record<string, unknown>)['chatgpt_account_id'];
      if (typeof acct === 'string' && acct) return acct;
    }
  } catch {
    // Malformed JWT — drop the account header silently.
  }
  return null;
}

// ============================================================================
// Tool-schema conversion
// ============================================================================

export function llmToolDefinitionsToResponses(
  tools: LlmToolDefinition[] | undefined,
): CodexFunctionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const out: CodexFunctionTool[] = [];
  for (const tool of tools) {
    if (!tool.name || typeof tool.name !== 'string') continue;
    out.push({
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      strict: false,
      parameters:
        tool.inputSchema && typeof tool.inputSchema === 'object'
          ? tool.inputSchema
          : { type: 'object', properties: {} },
    });
  }
  return out.length > 0 ? out : undefined;
}

// ============================================================================
// Message → Responses input conversion
// ============================================================================

function contentBlocksToResponsesParts(
  blocks: LlmContentBlock[],
  role: CodexRole,
): CodexContentPart[] {
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  const out: CodexContentPart[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      out.push({ type: textType, text: block.text });
    } else if (block.type === 'image') {
      out.push({
        type: 'input_image',
        image_url: `data:${block.mimeType};base64,${block.data}`,
        ...(block.detail ? { detail: block.detail } : {}),
      });
    }
  }
  return out;
}

function stringifyToolResultContent(
  content: string | LlmContentBlock[],
): string {
  if (typeof content === 'string') return content;
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') texts.push(block.text);
    else if (block.type === 'tool_result') texts.push(block.content);
  }
  return texts.join('\n');
}

/**
 * Convert clawtalk's LlmMessage[] into the Responses input-items list.
 *
 * System messages are NOT emitted as items — the system prompt is
 * carried in the request's top-level `instructions` field. Callers
 * should strip system messages from the array before passing them in,
 * or rely on the upstream `buildCodexRequestBody` which does the
 * stripping itself.
 *
 * Assistant messages with `providerData.codexReasoningItems` or
 * `providerData.codexMessageItems` are replayed verbatim so the
 * Codex backend can rebuild its server-side reasoning chain.
 */
export function llmMessagesToResponsesInput(
  messages: LlmMessage[],
): CodexInputItem[] {
  const items: CodexInputItem[] = [];
  const seenItemIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        items.push({ role: 'user', content: msg.content });
      } else {
        const parts = contentBlocksToResponsesParts(msg.content, 'user');
        if (parts.length > 0) {
          items.push({ role: 'user', content: parts });
        } else {
          items.push({ role: 'user', content: '' });
        }
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const reasoning = msg.providerData?.codexReasoningItems;
      let replayedReasoning = 0;
      if (Array.isArray(reasoning)) {
        for (const ri of reasoning) {
          if (!ri || typeof ri !== 'object') continue;
          const encrypted = (ri as Record<string, unknown>).encrypted_content;
          if (typeof encrypted !== 'string' || !encrypted) continue;
          const rawId = (ri as Record<string, unknown>).id;
          if (typeof rawId === 'string' && rawId) {
            if (seenItemIds.has(rawId)) continue;
            seenItemIds.add(rawId);
          }
          // Strip `id` from the replayed item — with store=false the
          // backend cannot look up items by ID and returns 404. The
          // encrypted_content blob is self-contained for chain
          // continuity. `summary` is required when replaying.
          const replay: Record<string, unknown> = {
            type: 'reasoning',
            encrypted_content: encrypted,
          };
          const summary = (ri as Record<string, unknown>).summary;
          replay.summary = Array.isArray(summary) ? summary : [];
          items.push(replay as CodexInputItem);
          replayedReasoning += 1;
        }
      }

      // Replay exact assistant message items (with id/phase) so the
      // backend keeps prefix-cache hits. Per OpenAI: "preserve and
      // resend `phase` on all assistant messages — dropping it can
      // degrade performance."
      const messageItems = msg.providerData?.codexMessageItems;
      let replayedMessageItems = 0;
      if (Array.isArray(messageItems)) {
        for (const raw of messageItems) {
          if (!raw || typeof raw !== 'object') continue;
          const rec = raw as Record<string, unknown>;
          if (rec.type !== 'message' || rec.role !== 'assistant') continue;
          const rawContent = rec.content;
          if (!Array.isArray(rawContent)) continue;
          const parts: Array<{ type: 'output_text'; text: string }> = [];
          for (const p of rawContent) {
            if (!p || typeof p !== 'object') continue;
            const pType = (p as Record<string, unknown>).type;
            if (pType !== 'output_text' && pType !== 'text') continue;
            const text = (p as Record<string, unknown>).text ?? '';
            parts.push({
              type: 'output_text',
              text: typeof text === 'string' ? text : String(text),
            });
          }
          if (parts.length === 0) continue;
          const item: CodexInputItem = {
            type: 'message',
            role: 'assistant',
            status: normalizeResponsesMessageStatus(rec.status),
            content: parts,
          };
          if (typeof rec.id === 'string' && rec.id) {
            (item as { id?: string }).id = rec.id;
          }
          if (typeof rec.phase === 'string' && rec.phase) {
            (item as { phase?: string }).phase = rec.phase;
          }
          items.push(item);
          replayedMessageItems += 1;
        }
      }

      if (replayedMessageItems === 0) {
        // Fall back to emitting from the visible message content
        // (text blocks + plain string). Tool calls are surfaced as
        // separate function_call items below.
        let textContent = '';
        if (typeof msg.content === 'string') {
          textContent = msg.content;
        } else {
          for (const block of msg.content) {
            if (block.type === 'text') textContent += block.text;
          }
        }
        if (textContent.trim().length > 0) {
          items.push({ role: 'assistant', content: textContent });
        } else if (replayedReasoning > 0) {
          // The Responses API requires a following item after each
          // reasoning item (otherwise: missing_following_item error).
          // Emit an empty assistant message as the required follow-up.
          items.push({ role: 'assistant', content: '' });
        }
      }

      // Translate tool_use blocks into function_call items.
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type !== 'tool_use') continue;
          const args =
            typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input ?? {});
          items.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: (args || '{}').trim() || '{}',
          });
        }
      }

      continue;
    }

    if (msg.role === 'tool') {
      // Map our LlmMessage tool result to function_call_output.
      const callId =
        msg.toolCallId?.trim() || extractToolCallIdFromBlocks(msg.content);
      if (!callId) continue;

      let output: string | CodexContentPart[];
      if (typeof msg.content === 'string') {
        output = msg.content;
      } else {
        const parts: CodexContentPart[] = [];
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            parts.push({ type: 'input_text', text: block.content });
          } else if (block.type === 'text') {
            parts.push({ type: 'input_text', text: block.text });
          } else if (block.type === 'image') {
            parts.push({
              type: 'input_image',
              image_url: `data:${block.mimeType};base64,${block.data}`,
              ...(block.detail ? { detail: block.detail } : {}),
            });
          }
        }
        output =
          parts.length > 0 ? parts : stringifyToolResultContent(msg.content);
      }

      items.push({
        type: 'function_call_output',
        call_id: callId,
        output,
      });
    }
  }

  return items;
}

function extractToolCallIdFromBlocks(
  content: string | LlmContentBlock[],
): string | null {
  if (typeof content === 'string') return null;
  for (const block of content) {
    if (block.type === 'tool_result' && block.toolUseId) return block.toolUseId;
  }
  return null;
}

function normalizeResponsesMessageStatus(value: unknown): string {
  if (typeof value !== 'string') return 'completed';
  const status = value.trim().toLowerCase().replace(/[-\s]/g, '_');
  return RESPONSE_MESSAGE_STATUSES.has(status) ? status : 'completed';
}

// ============================================================================
// Build + preflight the request body
// ============================================================================

const DEFAULT_AGENT_INSTRUCTIONS = 'You are a helpful assistant.';

export function buildCodexRequestBody(
  opts: CodexBuildOptions,
): CodexRequestBody {
  const instructions = opts.systemPrompt.trim() || DEFAULT_AGENT_INSTRUCTIONS;
  const input = llmMessagesToResponsesInput(opts.messages);
  const tools = llmToolDefinitionsToResponses(opts.tools);

  const body: CodexRequestBody = {
    model: opts.model,
    instructions,
    input,
    store: false,
    reasoning: {
      effort: opts.reasoningEffort ?? 'medium',
      summary: 'auto',
    },
    include: ['reasoning.encrypted_content'],
  };

  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
    body.parallel_tool_calls = true;
  }

  if (opts.maxOutputTokens && opts.maxOutputTokens > 0) {
    body.max_output_tokens = opts.maxOutputTokens;
  }

  if (opts.sessionId) {
    body.prompt_cache_key = opts.sessionId;
  }

  if (opts.stream) {
    body.stream = true;
  }

  return body;
}

const ALLOWED_REQUEST_KEYS = new Set<keyof CodexRequestBody>([
  'model',
  'instructions',
  'input',
  'tools',
  'store',
  'reasoning',
  'include',
  'max_output_tokens',
  'tool_choice',
  'parallel_tool_calls',
  'prompt_cache_key',
  'stream',
]);

export class CodexRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexRequestValidationError';
  }
}

/**
 * Validate a CodexRequestBody before sending. Mirrors hermes'
 * `_preflight_codex_api_kwargs` minus the `extra_headers` / `extra_body`
 * passthrough (those are handled at the HTTP layer in llm-client.ts).
 */
export function preflightCodexRequestBody(
  body: CodexRequestBody,
): CodexRequestBody {
  if (!body || typeof body !== 'object') {
    throw new CodexRequestValidationError(
      'Codex Responses request must be an object.',
    );
  }
  if (!body.model || typeof body.model !== 'string' || !body.model.trim()) {
    throw new CodexRequestValidationError(
      "Codex Responses request 'model' must be a non-empty string.",
    );
  }
  if (typeof body.instructions !== 'string') {
    throw new CodexRequestValidationError(
      "Codex Responses request 'instructions' must be a string.",
    );
  }
  if (!Array.isArray(body.input)) {
    throw new CodexRequestValidationError(
      "Codex Responses request 'input' must be an array of input items.",
    );
  }
  if (body.store !== false) {
    throw new CodexRequestValidationError(
      "Codex Responses contract requires 'store' to be false.",
    );
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      throw new CodexRequestValidationError(
        "Codex Responses request 'tools' must be an array when provided.",
      );
    }
    for (let i = 0; i < body.tools.length; i++) {
      const tool = body.tools[i];
      if (!tool || typeof tool !== 'object') {
        throw new CodexRequestValidationError(
          `Codex Responses tools[${i}] must be an object.`,
        );
      }
      if (tool.type !== 'function') {
        throw new CodexRequestValidationError(
          `Codex Responses tools[${i}].type must be 'function'.`,
        );
      }
      if (!tool.name || typeof tool.name !== 'string') {
        throw new CodexRequestValidationError(
          `Codex Responses tools[${i}].name is required.`,
        );
      }
      if (!tool.parameters || typeof tool.parameters !== 'object') {
        throw new CodexRequestValidationError(
          `Codex Responses tools[${i}].parameters must be an object.`,
        );
      }
    }
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_REQUEST_KEYS.has(key as keyof CodexRequestBody)) {
      throw new CodexRequestValidationError(
        `Codex Responses request has unsupported field: ${key}`,
      );
    }
  }

  return body;
}

// ============================================================================
// ID helpers
// ============================================================================

/**
 * Deterministic call_id used when the backend omits one. Random UUIDs
 * would make every replayed request unique and bust the prefix cache;
 * deterministic IDs derived from (name, arguments, index) keep cache
 * hits intact.
 */
export function deterministicCallId(
  name: string,
  args: string,
  index: number,
): string {
  const seed = `${name}:${args}:${index}`;
  const digest = createHash('sha256')
    .update(seed, 'utf-8')
    .digest('hex')
    .slice(0, 12);
  return `call_${digest}`;
}

/**
 * The Responses API requires `function_call.id` to start with `fc_`.
 * Translate from our `call_…` form when the upstream rejected it.
 */
export function deriveResponseItemId(
  callId: string,
  responseItemId?: string,
): string {
  if (typeof responseItemId === 'string') {
    const trimmed = responseItemId.trim();
    if (trimmed.startsWith('fc_')) return trimmed;
  }
  const source = (callId || '').trim();
  if (source.startsWith('fc_')) return source;
  if (source.startsWith('call_') && source.length > 'call_'.length) {
    return `fc_${source.slice('call_'.length)}`;
  }
  const sanitized = source.replace(/[^A-Za-z0-9_-]/g, '');
  if (sanitized.startsWith('fc_')) return sanitized;
  if (sanitized.startsWith('call_') && sanitized.length > 'call_'.length) {
    return `fc_${sanitized.slice('call_'.length)}`;
  }
  if (sanitized) return `fc_${sanitized.slice(0, 48)}`;
  const fallback = source || responseItemId || 'unknown';
  const digest = createHash('sha1')
    .update(fallback, 'utf-8')
    .digest('hex')
    .slice(0, 24);
  return `fc_${digest}`;
}

// ============================================================================
// SSE event handling
// ============================================================================

/**
 * Mutable accumulator for the Responses SSE event stream. Hand each
 * parsed-JSON event to `handleCodexSseEvent`; when the stream
 * terminates, call `finalizeCodexStream` to extract the assistant
 * result + per-turn provider_data.
 */
export interface CodexStreamState {
  items: Array<Record<string, unknown>>;
  itemsByIndex: Map<number, Record<string, unknown>>;
  collectedTextDeltas: string[];
  hasToolCalls: boolean;
  responseStatus: string | null;
  incompleteDetails: Record<string, unknown> | null;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
}

export function createCodexStreamState(): CodexStreamState {
  return {
    items: [],
    itemsByIndex: new Map(),
    collectedTextDeltas: [],
    hasToolCalls: false,
    responseStatus: null,
    incompleteDetails: null,
    errorMessage: null,
    inputTokens: 0,
    outputTokens: 0,
  };
}

/**
 * Process a single SSE event from the Codex Responses stream,
 * returning the LlmStreamEvents (if any) to forward to the agent
 * loop. The accumulator state is mutated in place.
 *
 * Recognized event types:
 *   response.created            — start of stream (no LlmStreamEvent)
 *   response.in_progress        — periodic heartbeat
 *   response.output_item.added  — a new output item is starting
 *   response.output_item.done   — the item is finished (capture it)
 *   response.output_text.delta  — text delta from a message item
 *   response.function_call_arguments.delta — tool-call args streaming
 *   response.completed / .incomplete / .failed — terminal
 *   error                       — provider-side stream error
 *
 * Unknown event types are ignored quietly to remain forward-compatible.
 */
export function handleCodexSseEvent(
  state: CodexStreamState,
  raw: Record<string, unknown>,
): LlmStreamEvent[] {
  const out: LlmStreamEvent[] = [];
  const type = typeof raw.type === 'string' ? raw.type : '';

  if (type === 'error') {
    const message =
      typeof raw.message === 'string'
        ? raw.message
        : 'Codex stream emitted an error event.';
    state.errorMessage = message;
    out.push({ type: 'error', error: message });
    return out;
  }

  if (type === 'response.output_item.added') {
    const item = raw.item;
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const itemType = rec.type;
      if (itemType === 'function_call') {
        state.hasToolCalls = true;
        const name = typeof rec.name === 'string' ? rec.name : 'unknown';
        const callId = typeof rec.call_id === 'string' ? rec.call_id : '';
        if (callId) {
          out.push({
            type: 'tool_call_start',
            toolCall: { id: callId, name },
          });
        }
      }
    }
    return out;
  }

  if (type === 'response.output_text.delta') {
    const delta = typeof raw.delta === 'string' ? raw.delta : '';
    if (delta) {
      state.collectedTextDeltas.push(delta);
      out.push({ type: 'text_delta', text: delta });
    }
    return out;
  }

  if (type === 'response.function_call_arguments.delta') {
    const delta = typeof raw.delta === 'string' ? raw.delta : '';
    const itemId = typeof raw.item_id === 'string' ? raw.item_id : '';
    if (delta && itemId) {
      out.push({
        type: 'tool_call_delta',
        toolCall: {
          id: itemId,
          name: '',
          argumentsDelta: delta,
        },
      });
    }
    return out;
  }

  if (type === 'response.output_item.done') {
    const item = raw.item;
    if (item && typeof item === 'object') {
      state.items.push(item as Record<string, unknown>);
    }
    return out;
  }

  if (
    type === 'response.completed' ||
    type === 'response.incomplete' ||
    type === 'response.failed'
  ) {
    const response = raw.response;
    if (response && typeof response === 'object') {
      const rec = response as Record<string, unknown>;
      if (typeof rec.status === 'string') {
        state.responseStatus = rec.status;
      } else if (type === 'response.completed') {
        state.responseStatus = 'completed';
      } else if (type === 'response.incomplete') {
        state.responseStatus = 'incomplete';
      } else if (type === 'response.failed') {
        state.responseStatus = 'failed';
      }
      const incomplete = rec.incomplete_details;
      if (incomplete && typeof incomplete === 'object') {
        state.incompleteDetails = incomplete as Record<string, unknown>;
      }
      // Backfill items if `output` is present and we didn't capture
      // them via output_item.done.
      const output = rec.output;
      if (Array.isArray(output) && output.length > state.items.length) {
        state.items = output as Array<Record<string, unknown>>;
      }
      const usage = rec.usage;
      if (usage && typeof usage === 'object') {
        const u = usage as Record<string, unknown>;
        if (typeof u.input_tokens === 'number')
          state.inputTokens = u.input_tokens;
        if (typeof u.output_tokens === 'number')
          state.outputTokens = u.output_tokens;
      }
    }
    return out;
  }

  return out;
}

/**
 * Walk the accumulated output items and produce the final assistant
 * result. Mirrors hermes' `_normalize_codex_response`.
 */
export function finalizeCodexStream(
  state: CodexStreamState,
): CodexAssistantResult {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const reasoningItemsRaw: Array<Record<string, unknown>> = [];
  const messageItemsRaw: Array<Record<string, unknown>> = [];
  const toolCalls: CodexAssistantResult['toolCalls'] = [];

  let sawCommentaryPhase = false;
  let sawFinalAnswerPhase = false;
  let hasIncompleteItems =
    state.responseStatus === 'in_progress' ||
    state.responseStatus === 'queued' ||
    state.responseStatus === 'incomplete';

  for (const item of state.items) {
    const itemType = item.type;
    const itemStatus =
      typeof item.status === 'string' ? item.status.trim().toLowerCase() : null;
    if (
      itemStatus === 'queued' ||
      itemStatus === 'in_progress' ||
      itemStatus === 'incomplete'
    ) {
      hasIncompleteItems = true;
    }

    if (itemType === 'message') {
      const phase =
        typeof item.phase === 'string' ? item.phase.trim().toLowerCase() : null;
      if (phase === 'commentary' || phase === 'analysis')
        sawCommentaryPhase = true;
      if (phase === 'final_answer' || phase === 'final')
        sawFinalAnswerPhase = true;
      const text = extractMessageText(item);
      if (text) {
        contentParts.push(text);
        const raw: Record<string, unknown> = {
          type: 'message',
          role: 'assistant',
          status: itemStatus ?? 'completed',
          content: [{ type: 'output_text', text }],
        };
        if (typeof item.id === 'string' && item.id) raw.id = item.id;
        if (phase) raw.phase = phase;
        messageItemsRaw.push(raw);
      }
    } else if (itemType === 'reasoning') {
      const reasoningText = extractReasoningText(item);
      if (reasoningText) reasoningParts.push(reasoningText);
      const encrypted = item.encrypted_content;
      if (typeof encrypted === 'string' && encrypted) {
        const raw: Record<string, unknown> = {
          type: 'reasoning',
          encrypted_content: encrypted,
        };
        if (typeof item.id === 'string' && item.id) raw.id = item.id;
        const summary = item.summary;
        if (Array.isArray(summary)) {
          const cleaned: Array<{ type: string; text: string }> = [];
          for (const part of summary) {
            if (!part || typeof part !== 'object') continue;
            const text = (part as Record<string, unknown>).text;
            if (typeof text === 'string') {
              cleaned.push({ type: 'summary_text', text });
            }
          }
          raw.summary = cleaned;
        }
        reasoningItemsRaw.push(raw);
      }
    } else if (
      itemType === 'function_call' ||
      itemType === 'custom_tool_call'
    ) {
      if (
        itemStatus === 'queued' ||
        itemStatus === 'in_progress' ||
        itemStatus === 'incomplete'
      ) {
        continue;
      }
      const name = typeof item.name === 'string' ? item.name : '';
      const rawArgs =
        itemType === 'function_call' ? item.arguments : item.input;
      const args =
        typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});
      const rawCallId = typeof item.call_id === 'string' ? item.call_id : '';
      const rawItemId = typeof item.id === 'string' ? item.id : '';
      const callId =
        rawCallId.trim() || deterministicCallId(name, args, toolCalls.length);
      const responseItemId = deriveResponseItemId(callId, rawItemId);
      toolCalls.push({
        id: callId,
        callId,
        responseItemId,
        name,
        arguments: args || '{}',
      });
    }
  }

  let finalText = contentParts.filter(Boolean).join('\n').trim();
  if (!finalText && state.collectedTextDeltas.length > 0) {
    finalText = state.collectedTextDeltas.join('').trim();
  }

  let leakedToolCallText = false;
  if (
    finalText &&
    toolCalls.length === 0 &&
    TOOL_CALL_LEAK_PATTERN.test(finalText)
  ) {
    leakedToolCallText = true;
    finalText = '';
  }

  let finishReason: CodexAssistantResult['finishReason'];
  if (toolCalls.length > 0) {
    finishReason = 'tool_calls';
  } else if (leakedToolCallText) {
    finishReason = 'incomplete';
  } else if (
    hasIncompleteItems ||
    state.responseStatus === 'incomplete' ||
    state.responseStatus === 'failed' ||
    (sawCommentaryPhase && !sawFinalAnswerPhase)
  ) {
    finishReason = 'incomplete';
  } else if (reasoningItemsRaw.length > 0 && !finalText) {
    finishReason = 'incomplete';
  } else {
    finishReason = 'stop';
  }

  return {
    content: finalText,
    toolCalls,
    reasoning:
      reasoningParts.length > 0 ? reasoningParts.join('\n\n').trim() : null,
    finishReason,
    codexReasoningItems: reasoningItemsRaw,
    codexMessageItems: messageItemsRaw,
    leakedToolCallText,
    usage:
      state.inputTokens || state.outputTokens
        ? { inputTokens: state.inputTokens, outputTokens: state.outputTokens }
        : null,
  };
}

function extractMessageText(item: Record<string, unknown>): string {
  const content = item.content;
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const pType = (part as Record<string, unknown>).type;
    if (pType !== 'output_text' && pType !== 'text') continue;
    const text = (part as Record<string, unknown>).text;
    if (typeof text === 'string' && text) chunks.push(text);
  }
  return chunks.join('').trim();
}

function extractReasoningText(item: Record<string, unknown>): string {
  const summary = item.summary;
  if (Array.isArray(summary)) {
    const chunks: string[] = [];
    for (const part of summary) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === 'string' && text) chunks.push(text);
    }
    if (chunks.length > 0) return chunks.join('\n').trim();
  }
  const text = item.text;
  if (typeof text === 'string') return text.trim();
  return '';
}
