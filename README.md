# ClawTalk

A terminal UI for chatting with LLMs through an [OpenClaw](https://github.com/jokim1/openclaw) gateway.

Remote into your OpenClaw server from your terminal on your Mac/PC/whatever. Switch between models from multiple providers (Anthropic, OpenAI, DeepSeek, Google, Moonshot) with a single keypress, track costs and rate limits in real time, use voice input/output, and manage conversation sessions — all from your terminal.

Built with React + [Ink](https://github.com/vadimdemedes/ink) by [Claude Opus 4.5](https://anthropic.com), [Claude Opus 4.6](https://anthropic.com), and [Joseph Kim](https://github.com/jokim1).

```
GW:● TS:● M:Deep  V:●  $0.14/$0.28  Today $0.42  Wk $2.17  ~Mo $9  Sess $0.03  Mic:●  Session 3
──────────────────────────────────────────────────────────────────────────────────────────────────
You:
  explain quicksort in one sentence

Deep:
  Quicksort recursively partitions an array around a pivot element, placing
  smaller elements before it and larger elements after it, then sorts each
  partition independently.

> _
──────────────────────────────────────────────────────────────────────────────────────────────────
 ^T  Talks   ^A  Model   ^N  New   ^H  History   ^P  Voice   ^V  TTS   ^X  Exit
```

## How it works

There are two pieces:

1. **ClawTalk** (this repo) — the terminal client that runs on your local machine
2. **[ClawTalkGateway](https://github.com/jokim1/ClawTalkGateway)** — an OpenClaw plugin that runs on your server

Your server (running OpenClaw) holds all the API keys and talks to the LLM providers. ClawTalk connects to it over HTTP and gives you a nice terminal UI.

```
Your machine                         Your server                     LLM providers
┌──────────────┐                    ┌──────────────────┐            ┌───────────┐
│  ClawTalk     │── Tailscale VPN ─▶│  OpenClaw          │───── API ─▶│ Anthropic │
│  (terminal)   │   (100.x.x.x)    │  + Gateway plugin  │            │ OpenAI    │
│               │◀── responses ─────│                    │            │ DeepSeek  │
│               │                   │  Holds API keys    │            │ Google    │
└──────────────┘                    └──────────────────┘            └───────────┘
```

## Setup

### Prerequisites

- **Node.js 20+** installed
- **[ClawTalkGateway](https://github.com/jokim1/ClawTalkGateway)** plugin running on your OpenClaw server (see that repo's README for setup)

### Install ClawTalk

```bash
npm install -g @jokim1/clawtalk
```

Or build from source:

```bash
git clone https://github.com/jokim1/ClawTalk.git
cd ClawTalk
npm install
npm run build
npm link
```

### Option A: Local use (on the same machine as the gateway)

If you're running ClawTalk directly on the same machine where OpenClaw and ClawTalkGateway are running, **no configuration is needed**. Just run:

```bash
clawtalk
```

That's it. Here's why this works with zero config:

1. ClawTalk defaults to `http://127.0.0.1:18789` as the gateway URL
2. ClawTalkGateway listens on port `18789` by default
3. The gateway allows unauthenticated access from localhost — no token required

You can optionally set a default model:

```bash
clawtalk config --model deepseek/deepseek-chat
```

### Option B: Remote use (from a different machine)

To use ClawTalk from your laptop, phone, or any machine that isn't the server itself, you need two things: a network connection to the server, and an auth token.

#### Step 1: Set up Tailscale (on both machines)

[Tailscale](https://tailscale.com) creates a private VPN between your devices. Each device gets a stable `100.x.x.x` IP that works from anywhere — no port forwarding or firewall rules needed.

**On your server (where OpenClaw runs):**

1. Install Tailscale: https://tailscale.com/download
2. Start it and log in:
   ```bash
   sudo tailscale up
   ```
3. Note your server's Tailscale IP:
   ```bash
   tailscale ip -4
   # Example output: 100.85.123.45
   ```

**On your local machine (where you'll run ClawTalk):**

1. Install Tailscale from the website: https://tailscale.com/download

   > **macOS note:** The [website download](https://tailscale.com/download) is the most reliable option. The Mac App Store version and `brew install tailscale` can have issues with the system network extension. The website version installs both the menu bar app and the CLI tools.
2. Log in with the same Tailscale account:
   ```bash
   tailscale up
   ```
3. Verify you can reach your server:
   ```bash
   ping 100.85.123.45   # use your server's IP
   ```

> **Alternative:** If both machines are on the same local network, you can skip Tailscale and use the local IP directly (e.g. `192.168.1.50`).

#### Step 2: Configure ClawTalk

Point ClawTalk at your server's gateway:

```bash
# Set your gateway URL (use your server's Tailscale IP)
clawtalk config --gateway http://100.85.123.45:18789

# Set auth token (required for remote connections)
clawtalk config --token your-token-here

# Optionally pick a default model
clawtalk config --model deepseek/deepseek-chat
```

The auth token is whatever you configured in your gateway's `CLAWDBOT_GATEWAY_TOKEN` env var or `config.gateway.auth.token` setting.

#### Step 3: Run it

```bash
clawtalk
```

ClawTalk connects to your gateway, discovers available models, and drops you into the chat. The status bar shows connection status: `GW:●` for the gateway and `TS:●` for Tailscale.

## Features

- **Multi-model chat** — talk to Claude, GPT, DeepSeek, Gemini, Kimi, and more through one interface
- **Talks** — save, name, and switch between conversations with persistent server-side storage
- **Model health probing** — when you switch models, ClawTalk verifies the model is responding before you use it
- **Model mismatch detection** — if the gateway silently routes to a different model, ClawTalk warns you
- **Cost tracking** — shows today's spend, weekly total, monthly estimate, and per-session cost for API-billed providers
- **Rate limit monitoring** — for subscription plans (e.g. Anthropic Max), shows usage progress bar and reset countdown
- **Voice input/output** — push-to-talk speech input with live volume meter and auto-play speech output (requires [SoX](https://sox.sourceforge.net/) and gateway voice support)
- **Live chat** — real-time voice conversation mode with multiple providers (OpenAI, Cartesia, ElevenLabs, Deepgram, Gemini)
- **Message pinning** — pin important assistant responses for reference
- **Scheduled jobs** — set up recurring prompts that run on a cron schedule
- **Session persistence** — conversations saved to disk, browsable and searchable across sessions
- **Tailscale-aware** — monitors Tailscale VPN status for connectivity diagnostics

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | Talks list (saved conversations) |
| `Ctrl+A` | Open model picker |
| `Ctrl+N` | New chat |
| `Ctrl+H` | Message history / transcript browser |
| `Ctrl+P` | Push-to-talk voice input |
| `Ctrl+C` | Live voice chat |
| `Ctrl+V` | Toggle TTS (text-to-speech) |
| `Ctrl+Y` | Open new terminal window |
| `Ctrl+S` | Settings |
| `Ctrl+X` | Exit |
| `Escape`  | Back to Talks list |

## Switching models

Three ways:

1. **Model picker** — `Ctrl+A` to browse models grouped by provider
2. **Slash command** — type `/model sonnet` or `/model deepseek/deepseek-chat`
3. **Alias** — short names like `deep`, `opus`, `sonnet`, `haiku`, `gpt`, `gemini`, `kimi`

When you switch, ClawTalk probes the model to verify it's responding, then updates the status bar.

## Supported models

| Provider | Model | Alias | Pricing (in/out per 1M tokens) |
|----------|-------|-------|-------------------------------|
| DeepSeek | DeepSeek Chat | `deep` | $0.14 / $0.28 |
| DeepSeek | DeepSeek Reasoner | `deepr1` | $0.55 / $2.19 |
| Anthropic | Claude Opus 4.5 | `opus` | $15 / $75 |
| Anthropic | Claude Sonnet 4.5 | `sonnet` | $3 / $15 |
| Anthropic | Claude Haiku 3.5 | `haiku` | $0.80 / $4 |
| OpenAI | GPT-5.2 | `gpt` | $2.50 / $10 |
| OpenAI | GPT-5 Mini | `gptmini` | $0.15 / $0.60 |
| OpenAI | GPT-4o | `gpt4o` | $2.50 / $10 |
| OpenAI | GPT-4o Mini | `gpt4omini` | $0.15 / $0.60 |
| Google | Gemini 2.5 Flash | `gemini` | $0.15 / $0.60 |
| Google | Gemini 3 Pro | `geminipro` | $1.25 / $5 |
| Google | Gemini 3 Flash | `gemini3flash` | $0.15 / $0.60 |
| Moonshot | Kimi K2 | `kimi` | $0.60 / $2.40 |

Models not in this list are auto-discovered from the gateway at runtime.

## Slash commands

| Command | Description |
|---------|-------------|
| `/model <name>` | Switch model |
| `/save [title]` | Save current chat to Talks |
| `/topic <title>` | Set conversation topic title |
| `/pin [N]` | Pin the N-th assistant response |
| `/unpin [N]` | Remove a pin |
| `/pins` | List all pinned messages |
| `/job <cron> <prompt>` | Create a scheduled job |
| `/jobs` | List all jobs |
| `/objective <text>` | Set a conversation objective |
| `/reports [N]` | View job execution reports |
| `/clear` | Clear conversation history |

## Status bar

```
GW:● TS:● M:Deep  V:●  $0.14/$0.28  Today $1.23  Wk $8.61  ~Mo $37  Sess $0.08  Mic:●  Session 1
```

| Indicator | Meaning |
|-----------|---------|
| `GW:●` | Gateway: green = online, yellow = connecting, red = offline |
| `TS:●` | Tailscale: green = connected, yellow = checking, red = not running |
| `M:Deep` | Model: green = verified, yellow = checking, red = error |
| `V:●` | Voice: green = ready, red = recording, yellow = processing, magenta = playing |
| `Mic:●` | Mic readiness: green = ready, yellow = checking, red = unavailable |

### Billing display

**API providers** show per-token pricing, daily spend, weekly total, monthly estimate, and session cost:
```
$0.14/$0.28  Today $1.23  Wk $8.61  ~Mo $37  Sess $0.08
```

**Subscription providers** (e.g. Anthropic Max) show a rate-limit progress bar:
```
Max Pro  ████░░░░░░ 12% wk  Resets 3d 20h
```

## Voice

ClawTalk supports push-to-talk voice input and auto-play voice output. This requires:

1. **[SoX](https://sox.sourceforge.net/) installed locally** — for recording and playback
2. **Gateway voice support** — the [ClawTalkGateway](https://github.com/jokim1/ClawTalkGateway) plugin with `OPENAI_API_KEY` set on the server

### Install SoX

```bash
# macOS
brew install sox

# Ubuntu / Debian
sudo apt install sox

# Arch
sudo pacman -S sox
```

### How it works

1. Press **Ctrl+P** to start recording — the input area shows a live volume meter
2. Press **Ctrl+P** again to stop and send for transcription
3. Transcribed text is sent immediately (auto-send is on by default)
4. When the assistant responds, the response is automatically spoken aloud (if TTS is on)

Press **Escape** at any time to cancel recording or stop playback.

### Live voice chat

Press **Ctrl+C** to enter real-time voice conversation mode. This uses WebSocket-based streaming for low-latency back-and-forth. Multiple providers are supported: OpenAI, Cartesia, ElevenLabs, Deepgram, and Gemini.

### Voice config

```bash
# Disable auto-send to edit transcribed text before sending (auto-send is on by default)
clawtalk config --no-voice-auto-send

# Disable auto-play of responses (on by default)
clawtalk config --no-voice-auto-play

# Change TTS voice (alloy, echo, fable, onyx, nova, shimmer)
clawtalk config --voice-tts-voice nova
```

## Tailscale diagnostics

When using remote mode, ClawTalk monitors Tailscale status on startup and continuously while running:

- **On startup** — if the gateway is unreachable, ClawTalk checks Tailscale and tells you exactly what's wrong:
  - `Tailscale is not installed` — with install instructions
  - `Tailscale daemon is not running` — with the command to start it
  - `Tailscale is not authenticated` — tells you to run `tailscale up`
  - `Tailscale is connected but gateway unreachable` — suggests checking the server

- **While running** — the status bar shows `TS:●` (green = connected, red = disconnected). If Tailscale drops, you'll see it immediately.

When running locally on the gateway machine, Tailscale is not needed and its status is not relevant.

## Billing configuration

ClawTalk auto-detects billing mode from the gateway plugin. You can also configure it manually:

```bash
# Set Anthropic to subscription billing
clawtalk config --billing anthropic:subscription:Max Pro:200

# Reset to API billing
clawtalk config --billing anthropic:api

# View current config
clawtalk config --show
```

Format: `provider:mode[:plan[:price]]`

## Anthropic rate limits

Rate limit data is normally fetched from the gateway. If the gateway can't provide it (e.g. OAuth scope error), ClawTalk can fetch rate limits directly from Anthropic's API as a fallback:

```bash
# Set via config
clawtalk config --anthropic-key sk-ant-...

# Or via environment variable
export ANTHROPIC_API_KEY=sk-ant-...
```

When configured, ClawTalk makes a minimal probe request (`max_tokens: 1`) to Anthropic's `/v1/messages` endpoint and reads the `anthropic-ratelimit-*` response headers. This only triggers for Anthropic models and only when the gateway doesn't return rate limit data.

## Configuration

All config is stored in `~/.clawtalk/config.json`:

```json
{
  "gatewayUrl": "http://100.x.x.x:18789",
  "agentId": "clawtalk",
  "gatewayToken": "your-token",
  "defaultModel": "deepseek/deepseek-chat",
  "billing": {
    "anthropic": {
      "mode": "subscription",
      "plan": "Max Pro",
      "monthlyPrice": 200
    }
  },
  "voice": {
    "autoSend": true,
    "autoPlay": true,
    "ttsVoice": "nova",
    "ttsSpeed": 1.0
  },
  "anthropicApiKey": "sk-ant-..."
}
```

Resolution priority: CLI flags > environment variables > config file > defaults.

Environment variables: `CLAWTALK_GATEWAY_URL`, `CLAWTALK_GATEWAY_TOKEN`, `ANTHROPIC_API_KEY`.

Session transcripts are stored in `~/.clawtalk/sessions/`.

### CLI options

```
clawtalk [options]

Options:
  -g, --gateway <url>       Gateway URL
  -t, --token <token>       Auth token
  -m, --model <model>       Model to use
  -s, --session <name>      Resume or create a named session
  --anthropic-key <key>     Anthropic API key (for direct rate limit fetching)
  --voice-auto-send         Auto-submit voice transcriptions
  --voice-auto-play         Auto-play assistant responses (default: true)
  --no-voice-auto-play      Disable auto-play
  --voice-tts-voice <name>  TTS voice (alloy/echo/fable/onyx/nova/shimmer)
  -V, --version             Show version
  -h, --help                Show help
```

## Project structure

```
src/
├── cli.ts                     # CLI entry point and commands
├── config.ts                  # Configuration management
├── constants.ts               # Shared constants
├── models.ts                  # Model registry and metadata
├── types.ts                   # TypeScript type definitions
├── services/
│   ├── chat.ts                # Gateway API client (SSE streaming)
│   ├── voice.ts               # Voice recording, transcription, playback
│   ├── realtime-voice.ts      # Realtime voice WebSocket protocol
│   ├── sessions.ts            # Session persistence
│   ├── talks.ts               # Talk metadata management
│   ├── anthropic-ratelimit.ts # Direct Anthropic rate limit fetching
│   ├── tailscale.ts           # Tailscale status detection
│   ├── terminal.ts            # Terminal window spawning
│   ├── context-generator.ts   # Context generation utilities
│   └── validation.ts          # SSE chunk validation
└── tui/
    ├── app.tsx                # Main application component
    ├── lineCount.ts           # Line counting utilities
    ├── commands.ts            # Slash command registry
    ├── helpers.ts             # Input helpers
    ├── utils.ts               # TUI utilities
    ├── hooks/
    │   ├── useChat.ts         # Chat state and message handling
    │   ├── useGateway.ts      # Gateway polling and status
    │   ├── useVoice.ts        # Voice mode state machine
    │   ├── useRealtimeVoice.ts # Realtime voice state machine
    │   └── useMouseScroll.ts  # Mouse scroll handling
    └── components/
        ├── StatusBar.tsx      # Status bar and shortcut bar
        ├── ChatView.tsx       # Chat message display (line-based scroll)
        ├── InputArea.tsx      # Text input / voice state display
        ├── MultiLineInput.tsx # Multi-line text input
        ├── ModelPicker.tsx    # Model selection UI
        ├── TranscriptHub.tsx  # Session transcript browser
        ├── TalksHub.tsx       # Saved conversations browser
        ├── SettingsPicker.tsx  # Settings UI
        └── CommandHints.tsx   # Slash command autocomplete
```

## Related projects

- **[ClawTalkGateway](https://github.com/jokim1/ClawTalkGateway)** — OpenClaw plugin providing HTTP endpoints this client connects to
- **[ClawTalkMobile](https://github.com/jokim1/ClawTalkMobile)** — iOS client that connects to the same gateway
- **[ClawTalkTerminal](https://github.com/jokim1/ClawTalkTerminal)** — Legacy local-only terminal client (superseded by ClawTalk's local mode — see Setup Option A)
- **[OpenClaw](https://github.com/jokim1/openclaw)** — The host server the gateway plugin extends

## Development

```bash
npm install
npm run build
npm run dev    # watch mode
npm start
```

## License

MIT
