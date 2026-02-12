/**
 * Chat Service
 *
 * Handles communication with remote Moltbot gateway for LLM chat
 */

import { randomUUID } from 'crypto';
import type { Message, RateLimitInfo, Job, JobReport, TalkAgent, StreamChunk } from '../types.js';
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

/**
 * Create an AbortController with an activity-based timeout.
 * The timer resets each time `touch()` is called.
 * Falls back to a hard maximum timeout as a safety net.
 */
function createActivityAbort(inactivityMs: number, maxMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;

  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), inactivityMs);
  };

  // Hard maximum timeout safety net
  const maxTimer = setTimeout(() => controller.abort(), maxMs);

  resetTimer();
  return {
    signal: controller.signal,
    touch: resetTimer,
    clear: () => { clearTimeout(timer); clearTimeout(maxTimer); },
  };
}

/** Inactivity timeout for SSE streams — resets on each chunk (2 min per chunk). */
const STREAM_INACTIVITY_MS = 120_000;

/** Hard max timeout for the entire SSE connection (15 minutes). */
const STREAM_MAX_MS = 900_000;

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
  lastResponseUsage: { promptTokens: number; completionTokens: number } | undefined;

  constructor(config: ChatServiceConfig) {
    this.config = config;
    this.sessionKey = `clawtalk-${randomUUID()}`;
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
    history: Message[] = [],
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
    history: Message[] = [],
  ): AsyncGenerator<string, void, unknown> {
    const response = await fetch(`${this.config.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.chatHeaders(),
      body: JSON.stringify({
        model: this.config.model ?? 'moltbot',
        messages: this.buildMessages(userMessage, history),
        stream: true,
        stream_options: { include_usage: true },
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
    this.lastResponseUsage = undefined;

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
            if (parsed.usage) {
              this.lastResponseUsage = {
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
              };
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

  // -----------------------------------------------------------------------
  // Gateway Talk API methods
  // -----------------------------------------------------------------------

  /** Create a Talk on the gateway. Returns the gateway talk ID. */
  async createGatewayTalk(model?: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/talks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        console.debug(`createGatewayTalk failed: ${response.status} ${response.statusText}`);
        return null;
      }
      const data = await response.json() as { id?: string };
      return data.id ?? null;
    } catch (err) {
      console.debug('createGatewayTalk error:', err);
      return null;
    }
  }

  /** Update Talk metadata on the gateway (objective, topicTitle, model). */
  async updateGatewayTalk(talkId: string, updates: { objective?: string; topicTitle?: string; model?: string; agents?: TalkAgent[] }): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/talks/${encodeURIComponent(talkId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify(updates),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Delete a Talk on the gateway. */
  async deleteGatewayTalk(talkId: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/talks/${encodeURIComponent(talkId)}`, {
        method: 'DELETE',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Fetch Talk metadata from gateway. */
  async getGatewayTalk(talkId: string): Promise<{ id: string; topicTitle?: string; objective?: string; model?: string; pinnedMessageIds: string[]; agents?: TalkAgent[]; contextMd?: string } | null> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/talks/${encodeURIComponent(talkId)}`, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      return await response.json() as any;
    } catch {
      return null;
    }
  }

  /** List all talks from the gateway. */
  async listGatewayTalks(): Promise<Array<{ id: string; topicTitle?: string; objective?: string; model?: string; pinnedMessageIds: string[]; jobs: Job[]; agents?: TalkAgent[]; createdAt: number; updatedAt: number }>> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/talks`, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];
      const data = await response.json() as { talks?: any[] };
      return data.talks ?? [];
    } catch {
      return [];
    }
  }

  /** Fetch message history from the gateway. */
  async fetchGatewayMessages(talkId: string, limit = 100): Promise<Message[]> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/talks/${encodeURIComponent(talkId)}/messages?limit=${limit}`, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return [];
      const data = await response.json() as { messages?: Message[] };
      return data.messages ?? [];
    } catch {
      return [];
    }
  }

  /** Pin a message on the gateway. */
  async pinGatewayMessage(talkId: string, messageId: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/talks/${encodeURIComponent(talkId)}/pin/${encodeURIComponent(messageId)}`, {
        method: 'POST',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Unpin a message on the gateway. */
  async unpinGatewayMessage(talkId: string, messageId: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/talks/${encodeURIComponent(talkId)}/pin/${encodeURIComponent(messageId)}`, {
        method: 'DELETE',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Create a job on a gateway talk. */
  async createGatewayJob(talkId: string, schedule: string, prompt: string): Promise<Job | null> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/talks/${encodeURIComponent(talkId)}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ schedule, prompt }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      return await response.json() as Job;
    } catch {
      return null;
    }
  }

  /** List all jobs for a gateway talk. */
  async listGatewayJobs(talkId: string): Promise<Job[]> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/talks/${encodeURIComponent(talkId)}/jobs`, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];
      const data = await response.json() as { jobs?: Job[] };
      return data.jobs ?? [];
    } catch {
      return [];
    }
  }

  /** Update a job on a gateway talk (active, schedule, prompt). */
  async updateGatewayJob(talkId: string, jobId: string, updates: { active?: boolean; schedule?: string; prompt?: string }): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/talks/${encodeURIComponent(talkId)}/jobs/${encodeURIComponent(jobId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify(updates),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Delete a job on a gateway talk. */
  async deleteGatewayJob(talkId: string, jobId: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/talks/${encodeURIComponent(talkId)}/jobs/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Fetch job reports from a gateway talk. */
  async fetchGatewayReports(talkId: string, jobId?: string, limit = 20, since?: number): Promise<JobReport[]> {
    try {
      const path = jobId
        ? `/api/talks/${encodeURIComponent(talkId)}/jobs/${encodeURIComponent(jobId)}/reports`
        : `/api/talks/${encodeURIComponent(talkId)}/reports`;
      const sinceParam = since ? `&since=${since}` : '';
      const response = await fetch(`${this.config.gatewayUrl}${path}?limit=${limit}${sinceParam}`, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return [];
      const data = await response.json() as { reports?: JobReport[] };
      return data.reports ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Stream a message through the gateway Talk chat endpoint.
   * The gateway handles system prompt, context, and history.
   * Yields StreamChunk objects: content text, tool_start, and tool_end events.
   */
  async *streamTalkMessage(
    talkId: string,
    userMessage: string,
    model?: string,
    image?: { base64: string; mimeType: string },
  ): AsyncGenerator<StreamChunk, void, unknown> {
    // Use activity-based timeout: resets on each chunk, with a hard max.
    // This keeps the connection alive during multi-iteration tool loops
    // where tool execution gaps can be long but data is still flowing.
    const abort = createActivityAbort(STREAM_INACTIVITY_MS, STREAM_MAX_MS);

    const response = await fetch(`${this.config.gatewayUrl}/api/talks/${encodeURIComponent(talkId)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({
        message: userMessage,
        model: model ?? this.config.model,
        ...(image && { imageBase64: image.base64, imageMimeType: image.mimeType }),
      }),
      signal: abort.signal,
    });

    if (!response.ok) {
      abort.clear();
      const error = await response.text();
      throw new Error(`Gateway error (${response.status}): ${error.slice(0, 200)}`);
    }

    const reader = response.body?.getReader();
    if (!reader) { abort.clear(); throw new Error('No response body'); }

    const decoder = new TextDecoder();
    let buffer = '';
    let pendingEvent: string | null = null;
    this.lastResponseModel = undefined;
    this.lastResponseUsage = undefined;

    try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      abort.touch(); // Reset inactivity timer on each chunk
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_STREAM_BUFFER_BYTES) {
        reader.cancel();
        throw new Error('Streaming buffer exceeded size limit');
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        // Track event type for tool_start / tool_end
        if (line.startsWith('event: ')) {
          const eventType = line.slice(7).trim();
          if (eventType === 'tool_start' || eventType === 'tool_end') {
            pendingEvent = eventType;
          } else {
            pendingEvent = null; // Skip other custom events (meta, etc.)
          }
          continue;
        }

        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;

          // Handle tool events
          if (pendingEvent === 'tool_start') {
            try {
              const parsed = JSON.parse(data);
              yield {
                type: 'tool_start',
                id: parsed.id ?? '',
                name: parsed.name ?? '',
                arguments: parsed.arguments ?? '',
              };
            } catch { /* ignore parse error */ }
            pendingEvent = null;
            continue;
          }

          if (pendingEvent === 'tool_end') {
            try {
              const parsed = JSON.parse(data);
              yield {
                type: 'tool_end',
                id: parsed.id ?? '',
                name: parsed.name ?? '',
                success: parsed.success ?? false,
                content: parsed.content ?? '',
                durationMs: parsed.durationMs ?? 0,
              };
            } catch { /* ignore parse error */ }
            pendingEvent = null;
            continue;
          }

          pendingEvent = null;

          try {
            const parsed = validateSSEChunk(JSON.parse(data));
            if (!parsed) continue;
            if (!this.lastResponseModel && parsed.model) {
              this.lastResponseModel = parsed.model;
            }
            if (parsed.usage) {
              this.lastResponseUsage = {
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
              };
            }
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) yield { type: 'content', text: stripAnsi(content) };
          } catch (err) {
            console.debug('SSE parse error (expected for partial chunks):', err);
          }
        }
      }
    }
    } finally {
      abort.clear();
    }
  }

  /**
   * Stream a message through the gateway Talk chat endpoint with agent context.
   * The gateway handles system prompt, context, and history with role-specific instructions.
   * Yields StreamChunk objects: content text, tool_start, and tool_end events.
   */
  async *streamAgentMessage(
    talkId: string,
    message: string,
    agent: { name: string; model: string; role: string },
    allAgents: { name: string; role: string; model: string }[],
    roleInstructions: string,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const abort = createActivityAbort(STREAM_INACTIVITY_MS, STREAM_MAX_MS);

    const response = await fetch(`${this.config.gatewayUrl}/api/talks/${encodeURIComponent(talkId)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({
        message,
        model: agent.model,
        agentName: agent.name,
        agentRole: agent.role,
        agentRoleInstructions: roleInstructions,
        otherAgents: allAgents.filter(a => a.name !== agent.name),
      }),
      signal: abort.signal,
    });

    if (!response.ok) {
      abort.clear();
      const error = await response.text();
      throw new Error(`Gateway error (${response.status}): ${error.slice(0, 200)}`);
    }

    const reader = response.body?.getReader();
    if (!reader) { abort.clear(); throw new Error('No response body'); }

    const decoder = new TextDecoder();
    let buffer = '';
    let pendingEvent: string | null = null;
    this.lastResponseModel = undefined;
    this.lastResponseUsage = undefined;

    try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      abort.touch(); // Reset inactivity timer on each chunk
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_STREAM_BUFFER_BYTES) {
        reader.cancel();
        throw new Error('Streaming buffer exceeded size limit');
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        // Track event type for tool_start / tool_end
        if (line.startsWith('event: ')) {
          const eventType = line.slice(7).trim();
          if (eventType === 'tool_start' || eventType === 'tool_end') {
            pendingEvent = eventType;
          } else {
            pendingEvent = null;
          }
          continue;
        }

        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;

          // Handle tool events
          if (pendingEvent === 'tool_start') {
            try {
              const parsed = JSON.parse(data);
              yield {
                type: 'tool_start',
                id: parsed.id ?? '',
                name: parsed.name ?? '',
                arguments: parsed.arguments ?? '',
              };
            } catch { /* ignore parse error */ }
            pendingEvent = null;
            continue;
          }

          if (pendingEvent === 'tool_end') {
            try {
              const parsed = JSON.parse(data);
              yield {
                type: 'tool_end',
                id: parsed.id ?? '',
                name: parsed.name ?? '',
                success: parsed.success ?? false,
                content: parsed.content ?? '',
                durationMs: parsed.durationMs ?? 0,
              };
            } catch { /* ignore parse error */ }
            pendingEvent = null;
            continue;
          }

          pendingEvent = null;

          try {
            const parsed = validateSSEChunk(JSON.parse(data));
            if (!parsed) continue;
            if (!this.lastResponseModel && parsed.model) {
              this.lastResponseModel = parsed.model;
            }
            if (parsed.usage) {
              this.lastResponseUsage = {
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
              };
            }
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) yield { type: 'content', text: stripAnsi(content) };
          } catch (err) {
            console.debug('SSE parse error (expected for partial chunks):', err);
          }
        }
      }
    }
    } finally {
      abort.clear();
    }
  }

  /** Upload a file to the gateway server. */
  async uploadFile(
    filename: string,
    base64Data: string,
  ): Promise<{ serverPath: string; filename: string; sizeBytes: number }> {
    const response = await fetch(`${this.config.gatewayUrl}/api/files/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
      },
      body: JSON.stringify({ filename, base64Data }),
      signal: AbortSignal.timeout(120_000), // 2-minute timeout for large files
    });

    if (!response.ok) {
      const error = await readLimitedBody(response, MAX_RESPONSE_BODY_BYTES);
      let message: string;
      try {
        const parsed = JSON.parse(error);
        message = parsed.error || error.slice(0, 200);
      } catch {
        message = error.slice(0, 200);
      }
      throw new Error(`Upload failed (${response.status}): ${message}`);
    }

    const data = JSON.parse(await readLimitedBody(response, MAX_RESPONSE_BODY_BYTES)) as {
      ok?: boolean;
      serverPath?: string;
      filename?: string;
      sizeBytes?: number;
    };

    if (!data.ok || !data.serverPath || !data.filename) {
      throw new Error('Invalid upload response from gateway');
    }

    return {
      serverPath: data.serverPath,
      filename: data.filename,
      sizeBytes: data.sizeBytes ?? 0,
    };
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
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(),
          'x-moltbot-agent-id': this.config.agentId,
        },
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

  getModel(): string | undefined {
    return this.config.model;
  }

  async setModelOverride(model: string, signal?: AbortSignal): Promise<boolean> {
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
        signal,
      });

      if (!response.ok) return false;
      const result = validateToolResult(await response.json());
      return result?.ok === true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return false;
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
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('json')) return null;
      return validateCostUsage(await response.json()) as CostUsageResult | null;
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
