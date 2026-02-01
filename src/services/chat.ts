/**
 * Chat Service
 *
 * Handles communication with remote Moltbot gateway for LLM chat
 */

import { randomUUID } from 'crypto';
import type { Message, RateLimitInfo } from '../types.js';
import type { IChatService } from './interfaces.js';
import {
  CHAT_TIMEOUT_MS,
  HEALTH_CHECK_TIMEOUT_MS,
  MODEL_LIST_TIMEOUT_MS,
  MODEL_PROBE_TIMEOUT_MS,
  COST_USAGE_TIMEOUT_MS,
  RATE_LIMIT_TIMEOUT_MS,
  PROVIDER_LIST_TIMEOUT_MS,
  MAX_CONTEXT_MESSAGES,
  MAX_RESPONSE_BODY_BYTES,
  MAX_STREAM_BUFFER_BYTES,
} from '../constants.js';
import {
  validateChatResponse,
  validateSSEChunk,
  validateModelList,
  validateProbeResponse,
  validateToolResult,
  validateCostUsage,
  validateRateLimits,
  validateProviders,
} from './validation.js';

export interface ChatServiceConfig {
  gatewayUrl: string;
  gatewayToken?: string;
  agentId: string;
  model?: string;
}

export interface ChatResponse {
  content: string;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export type ModelProbeResult =
  | { ok: true; actualModel?: string }
  | { ok: false; code: number; reason: string; actualModel?: string };

/** Read a response body with a size limit to prevent memory exhaustion. */
async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new Error(`Response too large (${contentLength} bytes, max ${maxBytes})`);
  }

  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      reader.cancel();
      throw new Error(`Response exceeded ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }

  const decoder = new TextDecoder();
  return chunks.map(c => decoder.decode(c, { stream: true })).join('') + decoder.decode();
}

/** Strip ANSI escape sequences to prevent terminal injection from gateway responses. */
function stripAnsi(text: string): string {
  // Matches: ESC[ ... final byte, ESC] ... ST, and other CSI/OSC sequences
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u001b\u009b][\[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g, '');
}

function parseModelError(status: number, body: string, model: string): string {
  if (status === 401) return 'Authentication failed. Check your API key or gateway token.';
  if (status === 403) return 'Access denied. Account may lack permission.';
  if (status === 404) return `Model "${model}" not found on this gateway.`;
  if (status === 429) return 'Rate limited or out of credits.';
  if (status >= 500) return 'Server issues. Provider may be down.';
  return `Unexpected error (${status}): ${body.slice(0, 120)}`;
}

export class ChatService implements IChatService {
  private config: ChatServiceConfig;
  private sessionKey: string;
  lastResponseModel: string | undefined;

  constructor(config: ChatServiceConfig) {
    this.config = config;
    this.sessionKey = `remoteclaw-${randomUUID()}`;
  }

  /** Build standard auth headers for gateway requests. */
  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.gatewayToken) {
      headers['Authorization'] = `Bearer ${this.config.gatewayToken}`;
    }
    return headers;
  }

  /** Build chat completion headers (auth + content type + agent/session). */
  private chatHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...this.authHeaders(),
      'x-moltbot-agent-id': this.config.agentId,
      'x-moltbot-session-key': this.sessionKey,
    };
  }

  /** Map message history to the OpenAI-compatible format, truncating to avoid unbounded growth. */
  private buildMessages(userMessage: string, history: Message[]) {
    const recent = history.slice(-MAX_CONTEXT_MESSAGES);
    return [
      ...recent.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      })),
      { role: 'user' as const, content: userMessage },
    ];
  }

  async sendMessage(
    userMessage: string,
    history: Message[] = []
  ): Promise<ChatResponse> {
    const response = await fetch(`${this.config.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.chatHeaders(),
      body: JSON.stringify({
        model: this.config.model ?? 'moltbot',
        messages: this.buildMessages(userMessage, history),
        stream: false,
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const error = await readLimitedBody(response, MAX_RESPONSE_BODY_BYTES);
      throw new Error(`Gateway error (${response.status}): ${error.slice(0, 200)}`);
    }

    const raw = JSON.parse(await readLimitedBody(response, MAX_RESPONSE_BODY_BYTES));
    const data = validateChatResponse(raw);
    if (!data) throw new Error('Invalid chat completion response');

    return {
      content: stripAnsi(data.choices?.[0]?.message?.content ?? ''),
      model: data.model,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? 0,
        totalTokens: data.usage.total_tokens ?? 0,
      } : undefined,
    };
  }

  async *streamMessage(
    userMessage: string,
    history: Message[] = []
  ): AsyncGenerator<string, void, unknown> {
    const response = await fetch(`${this.config.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.chatHeaders(),
      body: JSON.stringify({
        model: this.config.model ?? 'moltbot',
        messages: this.buildMessages(userMessage, history),
        stream: true,
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gateway error (${response.status}): ${error.slice(0, 200)}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    this.lastResponseModel = undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_STREAM_BUFFER_BYTES) {
        reader.cancel();
        throw new Error('Streaming buffer exceeded size limit');
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;

          try {
            const parsed = validateSSEChunk(JSON.parse(data));
            if (!parsed) continue;
            if (!this.lastResponseModel && parsed.model) {
              this.lastResponseModel = parsed.model;
            }
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) yield stripAnsi(content);
          } catch (err) {
            console.debug('SSE parse error (expected for partial chunks):', err);
          }
        }
      }
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      return response.ok;
    } catch (err) {
      console.debug('Health check failed:', err);
      return false;
    }
  }

  async listModels(): Promise<string[] | null> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/v1/models`, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
      });

      if (!response.ok) return null;

      const data = validateModelList(await response.json());
      return data?.data?.map(m => m.id) ?? null;
    } catch (err) {
      console.debug('listModels failed:', err);
      return null;
    }
  }

  async probeModel(model?: string, signal?: AbortSignal): Promise<ModelProbeResult> {
    const targetModel = model ?? this.config.model ?? 'moltbot';
    const timeoutSignal = AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS);
    const combinedController = new AbortController();
    const onAbort = () => combinedController.abort();

    timeoutSignal.addEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort);

    try {
      const response = await fetch(`${this.config.gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.chatHeaders(),
        body: JSON.stringify({
          model: targetModel,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: combinedController.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        return { ok: false, code: response.status, reason: parseModelError(response.status, body, targetModel) };
      }

      const data = validateProbeResponse(await response.json());
      const actualModel = data?.model;

      if (actualModel && actualModel !== targetModel) {
        return {
          ok: false,
          code: 0,
          reason: `Model mismatch: requested "${targetModel}" but gateway routed to "${actualModel}". The model may not be configured on this gateway.`,
          actualModel,
        };
      }

      return { ok: true, actualModel };
    } catch (err: unknown) {
      if (signal?.aborted) {
        return { ok: false, code: 0, reason: 'Probe cancelled.' };
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { ok: false, code: 0, reason: 'Model timed out (30s). May be overloaded.' };
      }
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return { ok: false, code: 0, reason: msg };
    } finally {
      timeoutSignal.removeEventListener('abort', onAbort);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  setModel(model: string): void {
    this.config.model = model;
  }

  async setModelOverride(model: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/tools/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          tool: 'session_status',
          args: {
            model: model === 'default' ? 'default' : model,
            sessionKey: this.sessionKey,
          },
          sessionKey: this.sessionKey,
        }),
      });

      if (!response.ok) return false;
      const result = validateToolResult(await response.json());
      return result?.ok === true;
    } catch (err) {
      console.debug('setModelOverride failed:', err);
      return false;
    }
  }

  async getCostUsage(days: number = 1): Promise<CostUsageResult | null> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/cost-usage?days=${days}`, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(COST_USAGE_TIMEOUT_MS),
      });

      if (!response.ok) return null;
      return validateCostUsage(await response.json()) as CostUsageResult | null;
    } catch (err) {
      console.debug('getCostUsage failed:', err);
      return null;
    }
  }

  async getRateLimits(provider?: string): Promise<RateLimitInfo | null> {
    try {
      const query = provider ? `?provider=${encodeURIComponent(provider)}` : '';
      const response = await fetch(`${this.config.gatewayUrl}/api/rate-limits${query}`, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(RATE_LIMIT_TIMEOUT_MS),
      });

      if (!response.ok) return null;
      return validateRateLimits(await response.json()) as RateLimitInfo | null;
    } catch (err) {
      console.debug('getRateLimits failed:', err);
      return null;
    }
  }

  async getProviders(): Promise<ProviderInfo[] | null> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/providers`, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(PROVIDER_LIST_TIMEOUT_MS),
      });

      if (!response.ok) return null;

      const data = validateProviders(await response.json());
      return (data?.providers as ProviderInfo[] | undefined) ?? null;
    } catch (err) {
      console.debug('getProviders failed:', err);
      return null;
    }
  }
}

export interface ProviderInfo {
  id: string;
  billing: {
    mode: 'api' | 'subscription';
    plan?: string;
    monthlyPrice?: number;
  };
}

export interface CostUsageResult {
  totals?: {
    totalCost?: number;
    inputCost?: number;
    outputCost?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  byDay?: Array<{
    date: string;
    totalCost: number;
  }>;
}
