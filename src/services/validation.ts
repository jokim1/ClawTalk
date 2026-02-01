/**
 * Lightweight runtime validation for API responses
 *
 * Simple type guards to validate response shapes without external dependencies.
 * Prevents silent failures from malformed gateway responses.
 */

/** Check that a value is a non-null object. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Check that a value is an array. */
function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/** Validate a chat completion response has the expected shape. */
export function validateChatResponse(data: unknown): {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
} | null {
  if (!isObject(data)) return null;
  // choices must be an array if present
  if (data.choices !== undefined && !isArray(data.choices)) return null;
  return data as ReturnType<typeof validateChatResponse>;
}

/** Validate a streaming SSE chunk. */
export function validateSSEChunk(data: unknown): {
  model?: string;
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
} | null {
  if (!isObject(data)) return null;
  return data as ReturnType<typeof validateSSEChunk>;
}

/** Validate a model list response. */
export function validateModelList(data: unknown): { data?: Array<{ id: string }> } | null {
  if (!isObject(data)) return null;
  if (data.data !== undefined && !isArray(data.data)) return null;
  return data as ReturnType<typeof validateModelList>;
}

/** Validate a probe response (just needs model field). */
export function validateProbeResponse(data: unknown): { model?: string } | null {
  if (!isObject(data)) return null;
  return data as ReturnType<typeof validateProbeResponse>;
}

/** Validate a tool invoke response. */
export function validateToolResult(data: unknown): { ok?: boolean } | null {
  if (!isObject(data)) return null;
  return data as ReturnType<typeof validateToolResult>;
}

/** Validate a cost usage response. */
export function validateCostUsage(data: unknown): {
  totals?: { totalCost?: number; inputCost?: number; outputCost?: number; inputTokens?: number; outputTokens?: number };
  byDay?: Array<{ date: string; totalCost: number }>;
} | null {
  if (!isObject(data)) return null;
  return data as ReturnType<typeof validateCostUsage>;
}

/** Validate a rate limit response. */
export function validateRateLimits(data: unknown): {
  provider: string;
  session?: { used: number; limit: number; resetsAt: string };
  weekly?: { used: number; limit: number; resetsAt: string };
} | null {
  if (!isObject(data)) return null;
  if (typeof data.provider !== 'string') return null;
  return data as ReturnType<typeof validateRateLimits>;
}

/** Validate a providers response. */
export function validateProviders(data: unknown): { providers?: Array<{ id: string; billing: { mode: string; plan?: string; monthlyPrice?: number } }> } | null {
  if (!isObject(data)) return null;
  if (data.providers !== undefined && !isArray(data.providers)) return null;
  return data as ReturnType<typeof validateProviders>;
}

/** Validate voice capabilities response. */
export function validateVoiceCapabilities(data: unknown): {
  stt: { available: boolean; provider?: string; model?: string; maxDurationSeconds?: number; maxFileSizeMB?: number };
  tts: { available: boolean; provider?: string; model?: string; voices?: string[]; defaultVoice?: string };
} | null {
  if (!isObject(data)) return null;
  if (!isObject(data.stt) || typeof (data.stt as Record<string, unknown>).available !== 'boolean') return null;
  if (!isObject(data.tts) || typeof (data.tts as Record<string, unknown>).available !== 'boolean') return null;
  return data as ReturnType<typeof validateVoiceCapabilities>;
}

/** Validate transcription response. */
export function validateTranscription(data: unknown): { text: string; language?: string; duration?: number } | null {
  if (!isObject(data)) return null;
  if (typeof data.text !== 'string') return null;
  return data as ReturnType<typeof validateTranscription>;
}
