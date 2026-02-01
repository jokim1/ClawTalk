# RemoteClaw

A terminal UI for remote terminal chatting with LLMs through a [Moltbot](https://github.com/jokim1/moltbot) gateway. 

So you can remote into your Moltbot from your terminal on your Mac/PC/whatever.

Switch between models from multiple providers (Anthropic, OpenAI, DeepSeek, Google, Moonshot) with a single keypress, track costs and rate limits in real time, and manage conversation sessions — all from your terminal. Also, store, search, all of your terminal chat history as well. You're welcome bruh.

TLDR:
1. Install the moltbot plugin on your gateway server (e.g., moltbot plugin add remoteclaw-gateway or drop it in the plugin dir)
2. Install RemoteClaw on your computer (e.g., npm install -g @jokim1/remoteclaw)
3. Configure RemoteClaw to point at your gateway (remoteclaw config --gateway http://... --token ...)
4. Done - RemoteClaw auto-discovers providers and rate limits fromm the plugin

Built with React + [Ink](https://github.com/vadimdemedes/ink) by [Claude Opus 4.5](https://anthropic.com) and [Joseph Kim](https://github.com/jokim1).

```
GW:● TS:● M:Deep  API: $0.14/$0.28 per 1M  Today: $0.42 (Avg $0.31)  Session 3
─────────────────────────────────────────────────────────────────────────────────
You:
  explain quicksort in one sentence

Deep:
  Quicksort recursively partitions an array around a pivot element, placing
  smaller elements before it and larger elements after it, then sorts each
  partition independently.

> _
─────────────────────────────────────────────────────────────────────────────────
 ^Q  Model   ^N  New   ^L  Clear   ^T  Transcript   ^C  Exit
```

## What it does

- **Multi-model chat** — talk to Claude, GPT, DeepSeek, Gemini, Kimi, and more through one interface
- **Model health probing** — when you switch models, RemoteClaw sends a lightweight probe to verify the model is responding. The model name turns green (ok), yellow (checking), or red (error) in the status bar
- **Model mismatch detection** — if the gateway silently routes your request to a different model than you asked for, RemoteClaw detects and warns you
- **Cost tracking** — shows today's spend and 7-day average for API-billed providers
- **Rate limit monitoring** — for Anthropic Max subscribers, shows a progress bar with weekly usage and reset countdown so you know when you'll be throttled
- **Session persistence** — conversations are saved to disk and browsable across sessions
- **Tailscale-aware** — detects Tailscale status for diagnosing connectivity to remote gateways

## Requirements

- **Node.js 20+**
- A running [Moltbot](https://github.com/jokim1/moltbot) gateway (local or remote)
- Optional: [Tailscale](https://tailscale.com) for secure remote gateway access

## Install

```bash
npm install -g @jokim1/remoteclaw
```

Or clone and build from source:

```bash
git clone https://github.com/jokim1/RemoteClaw.git
cd RemoteClaw
npm install
npm run build
npm link  # makes 'remoteclaw' available globally
```

## Quick start

### 1. Configure your gateway

```bash
# Point at your Moltbot gateway
remoteclaw config --gateway http://your-gateway:18789

# Set auth token (if your gateway requires one)
remoteclaw config --token your-token-here

# Optionally set a default model
remoteclaw config --model deepseek/deepseek-chat
```

Configuration is saved to `~/.remoteclaw/config.json`.

### 2. Launch

```bash
remoteclaw
```

That's it. RemoteClaw will connect to your gateway, verify connectivity, discover available models, and drop you into the chat UI.

### CLI options

```
remoteclaw [options]

Options:
  -g, --gateway <url>    Gateway URL (overrides config)
  -t, --token <token>    Auth token (overrides config)
  -m, --model <model>    Model to use (overrides config)
  -s, --session <name>   Resume or create a named session
  -V, --version          Show version
  -h, --help             Show help
```

You can also set `REMOTECLAW_GATEWAY_URL` and `REMOTECLAW_GATEWAY_TOKEN` as environment variables.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Q` | Open model picker |
| `Ctrl+N` | Open new terminal window |
| `Ctrl+L` | Clear current chat |
| `Ctrl+T` | Open transcript browser |
| `Ctrl+C` | Exit |

## Switching models

Three ways to switch:

1. **Model picker** — press `Ctrl+Q` to open the picker, browse models grouped by provider, press Enter to select
2. **Slash command** — type `/model sonnet` or `/model deepseek/deepseek-chat` in the chat
3. **Alias** — short names like `deep`, `opus`, `sonnet`, `haiku`, `gpt`, `gemini`, `kimi` are mapped to full model IDs

When you switch, RemoteClaw:
1. Shows "Checking connection..." in chat
2. Sends a lightweight probe (`max_tokens: 1`) to verify the model responds
3. Turns the model name green on success, or red with an error message on failure
4. Detects if the gateway routed to a different model than requested

## Supported models

| Provider | Model | Alias | Tier | Pricing (per 1M tokens) |
|----------|-------|-------|------|------------------------|
| DeepSeek | DeepSeek Chat | `deep` | Fast | $0.14 / $0.28 |
| DeepSeek | DeepSeek Reasoner | `deepr1` | Reasoning | $0.55 / $2.19 |
| Anthropic | Claude Opus 4.5 | `opus` | Powerful | $15 / $75 |
| Anthropic | Claude Sonnet 4.5 | `sonnet` | Balanced | $3 / $15 |
| Anthropic | Claude Haiku 3.5 | `haiku` | Fast | $0.80 / $4 |
| OpenAI | GPT-5.2 | `gpt` | Powerful | $2.50 / $10 |
| OpenAI | GPT-5 Mini | `gptmini` | Fast | $0.15 / $0.60 |
| OpenAI | GPT-4o | `gpt4o` | Balanced | $2.50 / $10 |
| OpenAI | GPT-4o Mini | `gpt4omini` | Fast | $0.15 / $0.60 |
| Google | Gemini 2.5 Flash | `gemini` | Fast | $0.15 / $0.60 |
| Google | Gemini 3 Pro | `geminipro` | Powerful | $1.25 / $5 |
| Google | Gemini 3 Flash | `gemini3flash` | Fast | $0.15 / $0.60 |
| Moonshot | Kimi K2 | `kimi` | Balanced | $0.60 / $2.40 |

Models not in this list are auto-discovered from the gateway at runtime.

## Status bar

The top line shows real-time status:

```
GW:● TS:● M:Deep  API: $0.14/$0.28 per 1M  Today: $1.23 (Avg $0.87)  Session 1
```

| Indicator | Meaning |
|-----------|---------|
| `GW:●` | Gateway online (green), connecting (yellow), offline (red) |
| `TS:●` | Tailscale connected (green), not running (red) |
| `M:Deep` | Current model — green (verified), yellow (checking), red (error), cyan (unknown) |

### Billing display

**API providers** show per-token pricing and daily spend:
```
M:Deep  API: $0.14/$0.28 per 1M  Today: $1.23 (Avg $0.87)
```

**Subscription providers** (e.g. Anthropic Max) show a rate-limit progress bar when the gateway provides rate-limit data:
```
M:Opus  Max Pro  ████░░░░░░ 12% wk  Resets 3d 20h
```

If you hit your rate limit:
```
M:Opus  Max Pro  ██████████ PAUSED  Resets 2h 15m
```

## Billing configuration

RemoteClaw auto-detects billing mode from the gateway if the [Moltbot RemoteClaw plugin](docs/moltbot-plugin-spec.md) is installed. You can also configure it manually:

```bash
# Set Anthropic to subscription billing
remoteclaw config --billing anthropic:subscription:Max Pro:200

# Reset a provider to default API billing
remoteclaw config --billing anthropic:api

# View current config
remoteclaw config --show
```

Format: `provider:mode[:plan[:price]]`

## Configuration

All config is stored in `~/.remoteclaw/config.json`:

```json
{
  "gatewayUrl": "http://100.x.x.x:18789",
  "agentId": "remoteclaw",
  "gatewayToken": "your-token",
  "defaultModel": "deepseek/deepseek-chat",
  "billing": {
    "anthropic": {
      "mode": "subscription",
      "plan": "Max Pro",
      "monthlyPrice": 200
    }
  }
}
```

Resolution priority: CLI flags > environment variables > config file > defaults.

Session transcripts are stored in `~/.remoteclaw/sessions/`.

## Gateway setup

RemoteClaw requires a [Moltbot](https://github.com/jokim1/moltbot) gateway. The gateway handles:
- API key management for all providers
- Request routing to the correct provider based on model ID
- Streaming (SSE) and non-streaming chat completions
- Cost tracking

### Optional: Rate limit tracking

For Anthropic Max subscribers who want rate-limit monitoring in the status bar, install the RemoteClaw gateway plugin on your Moltbot instance. See [docs/moltbot-plugin-spec.md](docs/moltbot-plugin-spec.md) for the full spec and setup instructions.

## Architecture

```
┌──────────────┐        ┌──────────────────┐        ┌───────────────┐
│  RemoteClaw   │──HTTP──│  Moltbot Gateway  │──API──│  Anthropic    │
│  (your Mac)   │        │  (remote server)  │       │  OpenAI       │
│               │        │                   │       │  DeepSeek     │
│  Terminal UI  │        │  /v1/chat/...     │       │  Google       │
│  React + Ink  │        │  /api/providers   │       │  Moonshot     │
│               │        │  /api/rate-limits │       │               │
└──────────────┘        └──────────────────┘        └───────────────┘
        │
   Tailscale VPN (optional)
```

RemoteClaw is the client. It runs on any machine with Node.js 20+ (macOS, Linux, WSL). It connects to a Moltbot gateway over HTTP, optionally through a Tailscale VPN for secure remote access.

## Project structure

```
src/
├── cli.ts                    # CLI entry point and commands
├── config.ts                 # Configuration management
├── models.ts                 # Model registry and metadata
├── types.ts                  # TypeScript type definitions
├── services/
│   ├── chat.ts               # Gateway API client
│   ├── sessions.ts           # Session persistence
│   ├── tailscale.ts          # Tailscale status detection
│   └── terminal.ts           # Terminal window spawning
└── tui/
    ├── app.tsx               # Main application component
    ├── utils.ts              # TUI utilities
    └── components/
        ├── StatusBar.tsx     # Status bar and shortcut bar
        ├── ChatView.tsx      # Chat message display
        ├── InputArea.tsx     # Text input
        ├── ModelPicker.tsx   # Model selection UI
        └── TranscriptHub.tsx # Session transcript browser
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode (rebuild on changes)
npm run dev

# Run
npm start
```

## License

MIT
