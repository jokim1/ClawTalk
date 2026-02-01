/**
 * Shared constants for RemoteClaw
 */

// Default model ID used when no model is specified
export const DEFAULT_MODEL = 'deepseek/deepseek-chat';

// --- Network Timeouts (ms) ---
export const HEALTH_CHECK_TIMEOUT_MS = 3_000;
export const MODEL_LIST_TIMEOUT_MS = 5_000;
export const MODEL_PROBE_TIMEOUT_MS = 30_000;
export const CHAT_TIMEOUT_MS = 300_000; // 5 minutes
export const COST_USAGE_TIMEOUT_MS = 5_000;
export const RATE_LIMIT_TIMEOUT_MS = 5_000;
export const PROVIDER_LIST_TIMEOUT_MS = 5_000;
export const VOICE_CAPABILITY_TIMEOUT_MS = 5_000;
export const VOICE_TRANSCRIBE_TIMEOUT_MS = 30_000;
export const VOICE_SYNTHESIZE_TIMEOUT_MS = 30_000;
export const SOX_DETECT_TIMEOUT_MS = 3_000;
export const ANTHROPIC_RL_TIMEOUT_MS = 10_000;

// --- Polling ---
export const GATEWAY_POLL_INTERVAL_MS = 30_000;

// --- Audio Recording ---
export const AUDIO_SAMPLE_RATE = 16_000;
export const AUDIO_CHANNELS = 1;
export const AUDIO_BIT_DEPTH = 16;
export const AUDIO_MAX_DURATION_SEC = 120;
export const AUDIO_MIN_FILE_SIZE_BYTES = 100;
export const AUDIO_FINALIZE_DELAY_MS = 300;

// --- UI ---
export const SEARCH_DEBOUNCE_MS = 150;
export const INPUT_CLEANUP_DELAY_MS = 10;
export const RESIZE_DEBOUNCE_MS = 100;

// --- Gateway Protocol ---
export const GATEWAY_SENTINELS = new Set([
  'NO_REPLY',
  'NO_REPL',
  'HEARTBEAT_OK',
  'HEARTBEAT',
]);

/** Check if a response is a gateway sentinel (not real content). */
export function isGatewaySentinel(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (GATEWAY_SENTINELS.has(trimmed)) return true;
  for (const s of GATEWAY_SENTINELS) {
    if (trimmed.startsWith(s)) return true;
  }
  return false;
}
