/**
 * Chat Service
 *
 * Handles communication with remote Moltbot gateway for LLM chat
 */

import { randomUUID } from 'crypto';
import type { Message, RateLimitInfo } from '../types.js';
import {
  CHAT_TIMEOUT_MS,
  HEALTH_CHECK_TIMEOUT_MS,
  MODEL_LIST_TIMEOUT_MS,
  MODEL_PROBE_TIMEOUT_MS,
  COST_USAGE_TIMEOUT_MS,
  RATE_LIMIT_TIMEOUT_MS,
  PROVIDER_LIST_TIMEOUT_MS,
} from '../constants.js';

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

function parseModelError(status: number, body: string, model: string): string {
  if (status === 401) return 'Authentication failed. Check your API key or gateway token.';
  if (status === 403) return 'Access denied. Account may lack permission.';
  if (status === 404) return `Model "${model}" not found on this gateway.`;
  if (status === 429) return 'Rate limited or out of credits.';
  if (status >= 500) return 'Server issues. Provider may be down.';
  return `Unexpected error (${status}): ${body.slice(0, 120)}`;
}

export class ChatService {
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

  /** Map message history to the OpenAI-compatible format. */
  private buildMessages(userMessage: string, history: Message[]) {
    return [
      ...history.map(m => ({
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
      const error = await response.text();
      throw new Error(`Gateway error (${response.status}): ${error}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    return {
      content: data.choices?.[0]?.message?.content ?? '',
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
      throw new Error(`Gateway error (${response.status}): ${error}`);
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
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;

          try {
            const parsed = JSON.parse(data);
            if (!this.lastResponseModel && parsed.model) {
              this.lastResponseModel = parsed.model;
            }
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) yield content;
          } catch {
            // Skip invalid SSE JSON chunks
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
    } catch {
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

      const data = await response.json() as {
        data?: Array<{ id: string }>;
      };

      return data.data?.map(m => m.id) ?? null;
    } catch {
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

      const data = await response.json() as { model?: string };
      const actualModel = data.model;

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
      const result = await response.json() as { ok?: boolean };
      return result.ok === true;
    } catch {
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
      return await response.json() as CostUsageResult;
    } catch {
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
      return await response.json() as RateLimitInfo;
    } catch {
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

      const data = await response.json() as { providers?: ProviderInfo[] };
      return data.providers ?? null;
    } catch {
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
