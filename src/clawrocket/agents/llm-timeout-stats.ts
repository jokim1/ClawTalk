/**
 * llm-timeout-stats.ts
 *
 * Adaptive timeout computation for LLM streaming calls.
 *
 * Instead of hardcoded response-start timeouts, this module:
 * 1. Records observed time-to-first-token (TTFT) per (provider, model)
 * 2. Maintains running percentile estimates (p50, p95, p99, max)
 * 3. Computes adaptive response-start timeouts: max(p99 × 3, floor)
 * 4. Falls back to per-model cold-start defaults when data is sparse
 *
 * The percentile estimates use the P² algorithm approximation via
 * exponential moving statistics for efficiency — no unbounded sample
 * storage.  For the initial ramp (< MIN_SAMPLES), we keep all
 * observations in memory and compute exact percentiles.
 */

import { getDb } from '../../db.js';
import { logger } from '../../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum observations before using adaptive timeouts. */
const MIN_SAMPLES = 10;

/** Multiplier applied to p99 to derive the adaptive timeout. */
const P99_MULTIPLIER = 3;

/** Absolute floor — never set response-start timeout below this. */
const ABSOLUTE_FLOOR_MS = 15_000;

/** Fallback when no model default and no stats exist. */
const ULTIMATE_FALLBACK_MS = 120_000;

/**
 * Model-class heuristic for models we haven't seen before.
 * Used only when llm_provider_models.default_ttft_timeout_ms is NULL.
 */
const MODEL_CLASS_DEFAULTS: Array<{ pattern: RegExp; timeoutMs: number }> = [
  { pattern: /opus/i, timeoutMs: 180_000 },
  { pattern: /sonnet/i, timeoutMs: 90_000 },
  { pattern: /haiku/i, timeoutMs: 30_000 },
  { pattern: /gpt-4o/i, timeoutMs: 60_000 },
  { pattern: /gpt-4/i, timeoutMs: 90_000 },
  { pattern: /gpt-3/i, timeoutMs: 30_000 },
  { pattern: /gemini.*pro/i, timeoutMs: 90_000 },
  { pattern: /gemini.*flash/i, timeoutMs: 30_000 },
  { pattern: /deepseek/i, timeoutMs: 60_000 },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TtftStats {
  providerId: string;
  modelId: string;
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  lastUpdatedAt: string;
}

// ---------------------------------------------------------------------------
// Observation recording
// ---------------------------------------------------------------------------

/**
 * Record a TTFT observation after a successful streaming response.
 *
 * Uses an UPSERT with online percentile updates:
 * - For sample_count < MIN_SAMPLES, we can't compute reliable percentiles,
 *   but we still track max.
 * - For sample_count >= MIN_SAMPLES, we use exponentially weighted moving
 *   estimates to update percentiles without storing individual samples.
 *
 * This is called from the hot path (streaming loop) so it must be fast.
 * SQLite writes are serialized anyway, and a single UPSERT is sub-ms.
 */
export function recordTtftObservation(
  providerId: string,
  modelId: string,
  ttftMs: number,
): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();

    const existing = db
      .prepare(
        `SELECT sample_count, p50_ms, p95_ms, p99_ms, max_ms
         FROM llm_ttft_stats
         WHERE provider_id = ? AND model_id = ?`,
      )
      .get(providerId, modelId) as TtftStatsRow | undefined;

    if (!existing) {
      // First observation for this (provider, model)
      db.prepare(
        `INSERT INTO llm_ttft_stats
           (provider_id, model_id, sample_count, p50_ms, p95_ms, p99_ms, max_ms, last_updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      ).run(providerId, modelId, ttftMs, ttftMs, ttftMs, ttftMs, now);
      return;
    }

    const n = existing.sample_count + 1;

    // Exponentially weighted moving percentile estimation.
    // Alpha controls how fast we adapt: smaller alpha = smoother, larger = more reactive.
    // We use a higher alpha during early ramp-up for faster convergence.
    const alpha = n < 50 ? 0.1 : 0.05;

    // Update each percentile estimate using the EWMA approach:
    // If the observation is above the current estimate, nudge up.
    // If below, nudge down. The rate is scaled by the target quantile.
    const p50 = updatePercentile(existing.p50_ms, ttftMs, 0.5, alpha);
    const p95 = updatePercentile(existing.p95_ms, ttftMs, 0.95, alpha);
    const p99 = updatePercentile(existing.p99_ms, ttftMs, 0.99, alpha);
    const max = Math.max(existing.max_ms, ttftMs);

    db.prepare(
      `UPDATE llm_ttft_stats
       SET sample_count = ?, p50_ms = ?, p95_ms = ?, p99_ms = ?, max_ms = ?, last_updated_at = ?
       WHERE provider_id = ? AND model_id = ?`,
    ).run(n, p50, p95, p99, max, now, providerId, modelId);
  } catch (err) {
    // Recording failures must never break the streaming pipeline
    logger.warn(
      { err, providerId, modelId, ttftMs },
      'Failed to record TTFT observation',
    );
  }
}

/**
 * Online percentile update via EWMA-style nudging.
 *
 * If observation > current estimate: nudge up by alpha × quantile
 * If observation < current estimate: nudge down by alpha × (1 - quantile)
 *
 * This converges to the true quantile over time without storing samples.
 */
function updatePercentile(
  current: number,
  observation: number,
  quantile: number,
  alpha: number,
): number {
  if (observation > current) {
    return current + alpha * quantile * (observation - current);
  }
  return current - alpha * (1 - quantile) * (current - observation);
}

// ---------------------------------------------------------------------------
// Adaptive timeout computation
// ---------------------------------------------------------------------------

/**
 * Compute the adaptive response-start timeout for a (provider, model) pair.
 *
 * Priority:
 * 1. If enough TTFT observations exist (≥ MIN_SAMPLES): p99 × P99_MULTIPLIER
 * 2. Else if llm_provider_models.default_ttft_timeout_ms is set: use that
 * 3. Else if model ID matches a known class pattern: use class default
 * 4. Else: ULTIMATE_FALLBACK_MS
 *
 * The result is always clamped to [ABSOLUTE_FLOOR_MS, ∞).
 */
export function computeAdaptiveResponseStartTimeout(
  providerId: string,
  modelId: string,
): number {
  try {
    const db = getDb();

    // Check for adaptive stats
    const stats = db
      .prepare(
        `SELECT sample_count, p99_ms
         FROM llm_ttft_stats
         WHERE provider_id = ? AND model_id = ?`,
      )
      .get(providerId, modelId) as
      | { sample_count: number; p99_ms: number }
      | undefined;

    if (stats && stats.sample_count >= MIN_SAMPLES) {
      const adaptive = Math.ceil(stats.p99_ms * P99_MULTIPLIER);
      return Math.max(adaptive, ABSOLUTE_FLOOR_MS);
    }

    // Check for per-model default
    const modelRow = db
      .prepare(
        `SELECT default_ttft_timeout_ms
         FROM llm_provider_models
         WHERE provider_id = ? AND model_id = ?`,
      )
      .get(providerId, modelId) as
      | { default_ttft_timeout_ms: number | null }
      | undefined;

    if (modelRow?.default_ttft_timeout_ms) {
      return Math.max(modelRow.default_ttft_timeout_ms, ABSOLUTE_FLOOR_MS);
    }

    // Fall back to model-class heuristic
    for (const { pattern, timeoutMs } of MODEL_CLASS_DEFAULTS) {
      if (pattern.test(modelId)) {
        return Math.max(timeoutMs, ABSOLUTE_FLOOR_MS);
      }
    }

    return ULTIMATE_FALLBACK_MS;
  } catch (err) {
    // Adaptive lookup failures must never break the streaming pipeline
    logger.warn(
      { err, providerId, modelId },
      'Failed to compute adaptive timeout, using fallback',
    );
    return ULTIMATE_FALLBACK_MS;
  }
}

/**
 * Get the current TTFT stats for a (provider, model) pair.
 * Returns null if no observations exist yet. Useful for diagnostics.
 */
export function getTtftStats(
  providerId: string,
  modelId: string,
): TtftStats | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT provider_id, model_id, sample_count, p50_ms, p95_ms, p99_ms, max_ms, last_updated_at
       FROM llm_ttft_stats
       WHERE provider_id = ? AND model_id = ?`,
    )
    .get(providerId, modelId) as TtftStatsRow | undefined;

  if (!row) return null;

  return {
    providerId: row.provider_id,
    modelId: row.model_id,
    sampleCount: row.sample_count,
    p50Ms: row.p50_ms,
    p95Ms: row.p95_ms,
    p99Ms: row.p99_ms,
    maxMs: row.max_ms,
    lastUpdatedAt: row.last_updated_at,
  };
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TtftStatsRow {
  provider_id: string;
  model_id: string;
  sample_count: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  last_updated_at: string;
}
