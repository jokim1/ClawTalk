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

### Step 1: Set up the gateway (on your server)

Install the [ClawTalkGateway](https://github.com/jokim1/ClawTalkGateway) plugin on your OpenClaw instance. See that repo's README for instructions.

Once the plugin is running, you'll have a gateway URL (e.g. `http://100.x.x.x:18789`) and optionally an auth token.

### Step 2: Set up Tailscale (on both machines)

ClawTalk uses [Tailscale](https://tailscale.com) to securely connect your local machine to your server. Tailscale creates a private mesh VPN — each device gets a stable `100.x.x.x` IP address that works from anywhere, without port forwarding or firewall configuration.

**On your server (where OpenClaw runs):**

1. Install Tailscale: https://tailscale.com/download
2. Start Tailscale and log in:
   ```bash
   sudo tailscale up
   ```
3. Note your server's Tailscale IP:
   ```bash
   tailscale ip -4
   # Example output: 100.85.123.45
   ```

**On your local machine (where you'll run ClawTalk):**

1. Install Tailscale — download directly from the website: https://tailscale.com/download

   > **macOS note:** The [website download](https://tailscale.com/download) is the most reliable option. The Mac App Store version and `brew install tailscale` can have issues with the system network extension and daemon management. The website version installs both the menu bar app and the CLI tools.
2. Log in with the same Tailscale account:
   ```bash
   tailscale up
   ```
3. Verify you can reach your server:
   ```bash
   # Replace with your server's Tailscale IP from above
   ping 100.85.123.45
   ```

Once both machines are on the same Tailscale network, your server's gateway (e.g. `http://100.85.123.45:18789`) is reachable from your machine as if it were on the local network.

ClawTalk monitors Tailscale status and shows it in the status bar (`TS:●`). If Tailscale isn't connected, ClawTalk tells you exactly what's wrong — not installed, daemon not running, or not logged in.

> **Note:** If your server is on the same local network (or is localhost), you can skip Tailscale and use the local IP directly. Tailscale is for remote access from anywhere.

### Step 3: Install ClawTalk (on your machine)

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

Requires **Node.js 20+**.

### Step 4: Point ClawTalk at your gateway

```bash
# Set your gateway URL (use your server's Tailscale IP)
clawtalk config --gateway http://100.85.123.45:18789

# Set auth token (if your gateway requires one)
clawtalk config --token your-token-here

# Optionally pick a default model
clawtalk config --model deepseek/deepseek-chat
```

### Step 5: Run it

```bash
clawtalk
```

ClawTalk connects to your gateway over Tailscale, discovers available models, and drops you into the chat.

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

## Tailscale

ClawTalk is designed for remote access — your server holds the API keys and runs the OpenClaw gateway, and you connect to it from your laptop, phone, or any other machine. [Tailscale](https://tailscale.com) makes this easy.

### What Tailscale does

Tailscale creates a private mesh VPN between your devices. Each device gets a stable IP address (like `100.85.123.45`) that works from anywhere — at home, at a coffee shop, on a plane. No port forwarding, no DNS, no firewall rules.

Your server's gateway runs on a local port (e.g. `18789`). With Tailscale, you access it at `http://100.85.123.45:18789` from any of your devices.

### How ClawTalk uses Tailscale

ClawTalk checks Tailscale status on startup and continuously while running:

- **On startup** — if the gateway is unreachable, ClawTalk checks Tailscale and tells you exactly what's wrong:
  - `Tailscale is not installed` — with install instructions
  - `Tailscale daemon is not running` — with the command to start it
  - `Tailscale is not authenticated` — tells you to run `tailscale up`
  - `Tailscale is connected but gateway unreachable` — suggests checking the server

- **While running** — the status bar shows `TS:●` (green = connected, red = disconnected). If Tailscale drops, you'll see it immediately.

### Without Tailscale

If your server is on the same local network or is localhost, you don't need Tailscale. Just point ClawTalk at the local address:

```bash
clawtalk config --gateway http://192.168.1.50:18789
# or
clawtalk config --gateway http://localhost:18789
```

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
- **[ClawTalkTerminal](https://github.com/jokim1/ClawTalkTerminal)** — Voice-first terminal plugin running locally on the OpenClaw server
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
