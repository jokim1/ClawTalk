/**
 * Direct Anthropic API rate limit fetching
 *
 * Probes the Anthropic /v1/messages endpoint with a minimal request
 * and parses the anthropic-ratelimit-* response headers.
 * Used as a fallback when the Moltbot gateway can't return rate limits.
 */

import type { RateLimitInfo } from '../types.js';
import { ANTHROPIC_RL_TIMEOUT_MS } from '../constants.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicRateLimitService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async fetchRateLimits(model: string): Promise<RateLimitInfo | null> {
    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: '.' }],
        }),
        signal: AbortSignal.timeout(ANTHROPIC_RL_TIMEOUT_MS),
      });

      // Headers are present on both 200 and 429 responses
      const limit = parseInt(response.headers.get('anthropic-ratelimit-tokens-limit') ?? '', 10);
      const remaining = parseInt(response.headers.get('anthropic-ratelimit-tokens-remaining') ?? '', 10);
      const resetsAt = response.headers.get('anthropic-ratelimit-tokens-reset');

      if (isNaN(limit) || isNaN(remaining) || !resetsAt) {
        return null;
      }

      return {
        provider: 'anthropic',
        session: {
          used: limit - remaining,
          limit,
          resetsAt,
        },
      };
    } catch {
      return null;
    }
  }
}
