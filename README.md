# RemoteClaw

A terminal UI for chatting with LLMs through a [Moltbot](https://github.com/jokim1/moltbot) gateway.

Remote into your Moltbot from your terminal on your Mac/PC/whatever. Switch between models from multiple providers (Anthropic, OpenAI, DeepSeek, Google, Moonshot) with a single keypress, track costs and rate limits in real time, use voice input/output, and manage conversation sessions — all from your terminal.

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
 ^Q  Model   ^N  New   ^L  Clear   ^T  Transcript   ^V  Voice   ^C  Exit
```

## How it works

There are two pieces:

1. **RemoteClaw** (this repo) — the terminal client that runs on your local machine
2. **[RemoteClawGateway](https://github.com/jokim1/RemoteClawGateway)** — a Moltbot plugin that runs on your server

Your server (running Moltbot) holds all the API keys and talks to the LLM providers. RemoteClaw connects to it over HTTP and gives you a nice terminal UI.

```
Your machine                       Your server                     LLM providers
┌──────────────┐                  ┌──────────────────┐            ┌───────────┐
│  RemoteClaw   │───── HTTP ─────▶│  Moltbot          │───── API ─▶│ Anthropic │
│  (terminal)   │                 │  + Gateway plugin  │            │ OpenAI    │
│               │◀── responses ───│                    │            │ DeepSeek  │
│               │                 │  Holds API keys    │            │ Google    │
└──────────────┘                  └──────────────────┘            └───────────┘
       │
  Tailscale (optional, for remote access)
```

## Setup

### Step 1: Set up the gateway (on your server)

Install the [RemoteClawGateway](https://github.com/jokim1/RemoteClawGateway) plugin on your Moltbot instance. See that repo's README for instructions.

Once the plugin is running, you'll have a gateway URL (e.g. `http://your-server:18789`) and optionally an auth token.

### Step 2: Install RemoteClaw (on your machine)

```bash
npm install -g @jokim1/remoteclaw
```

Or build from source:

```bash
git clone https://github.com/jokim1/RemoteClaw.git
cd RemoteClaw
npm install
npm run build
npm link
```

Requires **Node.js 20+**.

### Step 3: Point RemoteClaw at your gateway

```bash
# Set your gateway URL
remoteclaw config --gateway http://your-server:18789

# Set auth token (if your gateway requires one)
remoteclaw config --token your-token-here

# Optionally pick a default model
remoteclaw config --model deepseek/deepseek-chat
```

### Step 4: Run it

```bash
remoteclaw
```

RemoteClaw connects to your gateway, discovers available models, and drops you into the chat.

## Features

- **Multi-model chat** — talk to Claude, GPT, DeepSeek, Gemini, Kimi, and more through one interface
- **Model health probing** — when you switch models, RemoteClaw verifies the model is responding before you use it
- **Model mismatch detection** — if the gateway silently routes to a different model, RemoteClaw warns you
- **Cost tracking** — shows today's spend and 7-day average for API-billed providers
- **Rate limit monitoring** — for subscription plans (e.g. Anthropic Max), shows usage progress and reset countdown
- **Voice input/output** — push-to-talk speech input and auto-play speech output (requires [SoX](https://sox.sourceforge.net/) and gateway voice support)
- **Session persistence** — conversations saved to disk, browsable and searchable across sessions
- **Tailscale-aware** — detects Tailscale status for diagnosing connectivity

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Q` | Open model picker |
| `Ctrl+N` | Open new terminal window |
| `Ctrl+L` | Clear current chat |
| `Ctrl+T` | Open transcript browser |
| `Ctrl+V` | Push-to-talk voice input (if available) |
| `Escape` | Cancel voice recording / stop playback |
| `Ctrl+C` | Exit |

## Switching models

Three ways:

1. **Model picker** — `Ctrl+Q` to browse models grouped by provider
2. **Slash command** — type `/model sonnet` or `/model deepseek/deepseek-chat`
3. **Alias** — short names like `deep`, `opus`, `sonnet`, `haiku`, `gpt`, `gemini`, `kimi`

When you switch, RemoteClaw probes the model to verify it's responding, then updates the status bar.

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

## Status bar

```
GW:● TS:● M:Deep  API: $0.14/$0.28 per 1M  Today: $1.23 (Avg $0.87)  Session 1
```

| Indicator | Meaning |
|-----------|---------|
| `GW:●` | Gateway: green = online, yellow = connecting, red = offline |
| `TS:●` | Tailscale: green = connected, red = not running |
| `M:Deep` | Model: green = verified, yellow = checking, red = error |
| `V:●` | Voice: green = ready, red = recording, yellow = processing, magenta = playing |

### Billing display

**API providers** show per-token pricing and daily spend:
```
M:Deep  API: $0.14/$0.28 per 1M  Today: $1.23 (Avg $0.87)
```

**Subscription providers** (e.g. Anthropic Max) show a rate-limit bar:
```
M:Opus  Max Pro  ████░░░░░░ 12% wk  Resets 3d 20h
```

## Voice

RemoteClaw supports push-to-talk voice input and auto-play voice output. This requires:

1. **[SoX](https://sox.sourceforge.net/) installed locally** — for recording and playback
2. **Gateway voice support** — the [RemoteClawGateway](https://github.com/jokim1/RemoteClawGateway) plugin with `OPENAI_API_KEY` set on the server

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

1. Press **Ctrl+V** to start recording (status bar shows `V:● REC`)
2. Press **Ctrl+V** again to stop and send for transcription
3. Transcribed text appears in your input field — edit it or press Enter to send
4. When the assistant responds, the response is automatically spoken aloud

Press **Escape** at any time to cancel recording or stop playback.

### Voice config

```bash
# Auto-submit transcribed text without editing
remoteclaw config --voice-auto-send

# Disable auto-play of responses (on by default)
remoteclaw config --no-voice-auto-play

# Change TTS voice (alloy, echo, fable, onyx, nova, shimmer)
remoteclaw config --voice-tts-voice nova
```

If SoX isn't installed or the gateway doesn't support voice, voice features are silently hidden — everything else works normally.

## Billing configuration

RemoteClaw auto-detects billing mode from the gateway plugin. You can also configure it manually:

```bash
# Set Anthropic to subscription billing
remoteclaw config --billing anthropic:subscription:Max Pro:200

# Reset to API billing
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
  },
  "voice": {
    "autoSend": false,
    "autoPlay": true,
    "ttsVoice": "nova",
    "ttsSpeed": 1.0
  }
}
```

Resolution priority: CLI flags > environment variables > config file > defaults.

Environment variables: `REMOTECLAW_GATEWAY_URL`, `REMOTECLAW_GATEWAY_TOKEN`.

Session transcripts are stored in `~/.remoteclaw/sessions/`.

### CLI options

```
remoteclaw [options]

Options:
  -g, --gateway <url>       Gateway URL
  -t, --token <token>       Auth token
  -m, --model <model>       Model to use
  -s, --session <name>      Resume or create a named session
  --voice-auto-send         Auto-submit voice transcriptions
  --voice-auto-play         Auto-play assistant responses (default: true)
  --no-voice-auto-play      Disable auto-play
  --voice-tts-voice <name>  TTS voice (alloy/echo/fable/onyx/nova/shimmer)
  -V, --version             Show version
  -h, --help                Show help
```

## Transcript browser

Press **Ctrl+T** to open the transcript browser:

- Browse all sessions by name, message count, and creation time
- View full transcripts with scrolling
- Search across all sessions
- Export transcripts to text files
- Delete old sessions

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
│   ├── voice.ts              # Voice recording, transcription, playback
│   ├── tailscale.ts          # Tailscale status detection
│   └── terminal.ts           # Terminal window spawning
└── tui/
    ├── app.tsx               # Main application component
    ├── utils.ts              # TUI utilities
    └── components/
        ├── StatusBar.tsx     # Status bar and shortcut bar
        ├── ChatView.tsx      # Chat message display
        ├── InputArea.tsx     # Text input / voice state display
        ├── ModelPicker.tsx   # Model selection UI
        └── TranscriptHub.tsx # Session transcript browser
```

## Development

```bash
npm install
npm run build
npm run dev    # watch mode
npm start
```

## License

MIT
