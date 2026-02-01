# RemoteClaw Gateway Plugin — Moltbot Implementation Spec

## Overview

A moltbot plugin that exposes two endpoints for the RemoteClaw TUI client:
- `GET /api/providers` — returns billing mode per configured provider
- `GET /api/rate-limits` — returns current rate-limit consumption from upstream providers

Both endpoints require the same `Authorization: Bearer {token}` auth as existing moltbot endpoints.

---

## Endpoint 1: `GET /api/providers`

### Purpose
Tells the client which providers are configured and how they're billed, so the UI can show the correct pricing model (API per-token vs subscription plan) without manual client-side config.

### Response

```json
{
  "providers": [
    {
      "id": "anthropic",
      "billing": {
        "mode": "subscription",
        "plan": "Max Pro",
        "monthlyPrice": 200
      }
    },
    {
      "id": "deepseek",
      "billing": {
        "mode": "api"
      }
    },
    {
      "id": "openai",
      "billing": {
        "mode": "api"
      }
    },
    {
      "id": "google",
      "billing": {
        "mode": "api"
      }
    }
  ]
}
```

### Field reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `providers[].id` | string | yes | Must match the prefix in model IDs (e.g. `anthropic` from `anthropic/claude-opus-4-5`) |
| `providers[].billing.mode` | `"api"` or `"subscription"` | yes | How this provider is billed |
| `providers[].billing.plan` | string | no | Plan name for subscriptions (e.g. `"Max Pro"`, `"Max"`) |
| `providers[].billing.monthlyPrice` | number | no | Monthly price in USD for subscriptions |

### Implementation notes
- This is mostly static config. Read it from moltbot's provider configuration at startup.
- Only return providers that have credentials configured (i.e. are actually usable).
- The `id` field is the lowercase provider prefix, not a display name.

---

## Endpoint 2: `GET /api/rate-limits?provider={provider}`

### Purpose
Returns the current rate-limit state for a provider. The client uses this to show a progress bar indicating how close the user is to being throttled/paused, plus a countdown to the next reset.

### Query parameters

| Param | Required | Description |
|-------|----------|-------------|
| `provider` | no | Filter to a specific provider (e.g. `anthropic`). If omitted, return all. |

### Response

```json
{
  "provider": "anthropic",
  "session": {
    "used": 8000,
    "limit": 80000,
    "resetsAt": "2026-01-31T19:00:00Z"
  },
  "weekly": {
    "used": 250000,
    "limit": 800000,
    "resetsAt": "2026-02-04T00:00:00Z"
  }
}
```

### Field reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | string | yes | Provider ID (e.g. `"anthropic"`) |
| `session` | object | no | Short-window rate limit (typically resets every 4-5 hours) |
| `weekly` | object | no | Long-window rate limit (resets every 7 days) |
| `session.used` | number | yes | Tokens consumed in this window |
| `session.limit` | number | yes | Total token budget for this window |
| `session.resetsAt` | string | yes | ISO 8601 timestamp when the window resets |
| `weekly.*` | | | Same fields as `session` |

### How to compute `used` and `limit`

Anthropic returns these headers on every `/v1/chat/completions` response:

```
anthropic-ratelimit-tokens-limit: 80000
anthropic-ratelimit-tokens-remaining: 72000
anthropic-ratelimit-tokens-reset: 2026-01-31T19:00:00Z
```

Map them as:
- `limit` = `anthropic-ratelimit-tokens-limit`
- `used` = `limit` - `anthropic-ratelimit-tokens-remaining`
- `resetsAt` = `anthropic-ratelimit-tokens-reset`

For Max plan weekly limits, Anthropic may return a second set of headers with a longer reset window (7-day cycle). If two distinct reset windows are detected, use the shorter one for `session` and the longer one for `weekly`.

### Implementation

1. **Hook into the proxy layer.** After every response from an upstream provider (specifically on `/v1/chat/completions`), read the rate-limit headers before forwarding the response body to the client.

2. **Store in memory.** Keep a simple map per provider:
   ```
   rateLimitCache = {
     "anthropic": {
       session: { used: 8000, limit: 80000, resetsAt: "..." },
       weekly: { used: 250000, limit: 800000, resetsAt: "..." }
     }
   }
   ```
   No persistence needed — this resets on gateway restart, and gets repopulated on the first proxied request.

3. **Serve on request.** The `GET /api/rate-limits` handler just reads from the cache and returns it.

4. **Return 404 or `{}`** if no data has been captured yet (no requests made since restart). The client handles both gracefully.

### Header reference by provider

**Anthropic:**
```
anthropic-ratelimit-requests-limit
anthropic-ratelimit-requests-remaining
anthropic-ratelimit-requests-reset
anthropic-ratelimit-tokens-limit
anthropic-ratelimit-tokens-remaining
anthropic-ratelimit-tokens-reset
```

**OpenAI** (if needed later):
```
x-ratelimit-limit-requests
x-ratelimit-remaining-requests
x-ratelimit-reset-requests
x-ratelimit-limit-tokens
x-ratelimit-remaining-tokens
x-ratelimit-reset-tokens
```

**DeepSeek / Others:** Most don't return rate-limit headers. Return nothing for these providers — the client shows standard API pricing instead.

---

## Client behavior

The RemoteClaw client already has the consumer code built:
- Calls `GET /api/providers` once at startup to auto-detect billing mode
- Calls `GET /api/rate-limits?provider=X` every 30 seconds alongside the health check
- StatusBar renders a progress bar for subscription providers when rate-limit data is available
- Shows `PAUSED` + reset countdown when usage hits 100%
- Falls back gracefully to `$200/mo` display when no rate-limit data is available

---

## Architecture: Rate-limit header capture

Moltbot's plugin API doesn't expose upstream provider response headers to plugins. To capture Anthropic's `anthropic-ratelimit-*` headers, the plugin runs a lightweight reverse proxy on a separate port (default `18793`).

### Request flow

```
RemoteClaw → moltbot:18789 → plugin-proxy:18793 → api.anthropic.com
                                    ↑
                            captures rate-limit
                            headers here
```

### Setup required

After installing the plugin, update your moltbot Anthropic provider config to route through the proxy:

```json
{
  "anthropic": {
    "baseUrl": "http://localhost:18793"
  }
}
```

The proxy transparently forwards all requests to Anthropic's API and passes responses back unchanged. The only side effect is that it reads and caches the rate-limit headers from each response.

**Note:** This proxy only applies to providers where you want rate-limit tracking (typically Anthropic for Max subscribers). Other providers (DeepSeek, OpenAI, etc.) continue to connect directly.

---

## Plugin config

The plugin accepts config for billing mode per provider, since moltbot can't always infer this automatically:

```json
{
  "remoteclaw": {
    "proxyPort": 18793,
    "providers": {
      "anthropic": {
        "billing": "subscription",
        "plan": "Max Pro",
        "monthlyPrice": 200
      }
    }
  }
}
```

Providers not listed default to `{ "mode": "api" }`.
