# RemoteClaw iOS App — Technical Architecture Document

## Overview

This document characterizes the scope, architecture, and challenges of building a native iOS application that replicates and extends RemoteClaw's terminal-based LLM chat interface with a modern app UI.

The key architectural advantage: RemoteClaw is already a thin client. It holds no API keys, performs no LLM inference, and delegates all provider communication to the Moltbot gateway. The iOS app would be another thin client talking to the same gateway over the same HTTP endpoints.

## Current RemoteClaw Architecture

```
Local machine                        Server                          LLM providers
┌──────────────────┐                ┌──────────────────────┐        ┌───────────┐
│  RemoteClaw CLI   │──── HTTP ────▶│  Moltbot               │─ API ─▶│ Anthropic │
│  (React + Ink)    │               │  + RemoteClawGateway   │        │ OpenAI    │
│                   │◀── SSE ──────│  plugin                │        │ DeepSeek  │
│  Holds no keys    │               │                        │        │ Google    │
│  Thin client      │               │  Holds all API keys    │        │ Moonshot  │
└──────────────────┘                └──────────────────────┘        └───────────┘
       │
  Tailscale VPN (optional)
```

### Gateway endpoints used by RemoteClaw

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Gateway connectivity check |
| `/v1/chat/completions` | POST | Chat with SSE streaming |
| `/api/models` | GET | Discover available models |
| `/api/providers` | GET | Provider metadata and billing info |
| `/api/rate-limits?provider=X` | GET | Rate limit data for subscription plans |
| `/api/cost-usage?days=N` | GET | Cost tracking data |
| `/api/voice/capabilities` | GET | Check STT/TTS availability |
| `/api/voice/transcribe` | POST | Speech-to-text (multipart WAV upload) |
| `/api/voice/synthesize` | POST | Text-to-speech (returns audio) |
| `/api/model-override` | POST | Set active model on gateway |

No new server-side work is required. The iOS app uses these same endpoints.

## Proposed iOS Architecture

```
iPhone                               Server (unchanged)
┌──────────────────────┐            ┌──────────────────────┐
│  RemoteClaw iOS       │            │  Moltbot               │
│                       │            │  + RemoteClawGateway   │
│  ┌─────────────────┐ │            │                        │
│  │  SwiftUI Views   │ │            │  Same gateway, same    │
│  │  - ChatView      │ │── HTTP ──▶│  endpoints, same API   │
│  │  - ModelPicker   │ │◀── SSE ──│  keys                  │
│  │  - Settings      │ │            │                        │
│  │  - Transcripts   │ │            └──────────────────────┘
│  └─────────────────┘ │
│  ┌─────────────────┐ │
│  │  Services        │ │
│  │  - GatewayClient │ │
│  │  - SessionStore  │ │
│  │  - VoiceEngine   │ │
│  └─────────────────┘ │
│  ┌─────────────────┐ │
│  │  Local Storage   │ │
│  │  - SwiftData     │ │
│  │  - UserDefaults  │ │
│  └─────────────────┘ │
└──────────────────────┘
       │
  Tailscale VPN (iOS app)
```

### Technology stack

| Layer | Technology | Notes |
|---|---|---|
| UI framework | SwiftUI | Native, declarative, no third-party UI deps |
| Networking | URLSession | Streaming via `AsyncBytes` for SSE |
| Persistence | SwiftData (or Codable JSON) | Session transcripts and config |
| Settings | UserDefaults + Settings screen | Replaces `~/.remoteclaw/config.json` |
| Voice input | AVAudioRecorder / AVAudioEngine | Record WAV, send to gateway |
| Voice output | AVAudioPlayer | Play audio from gateway TTS |
| Markdown | swift-markdown-ui or AttributedString | Render chat responses |

No third-party dependencies required for core functionality.

## Feature-by-Feature Mapping

### Direct ports (minimal adaptation)

| RemoteClaw feature | iOS implementation | Complexity |
|---|---|---|
| Gateway health check | `URLSession` GET to `/health` | Trivial |
| Model list discovery | `URLSession` GET to `/api/models` | Trivial |
| Model health probing | Same probe request as CLI | Trivial |
| Model switching | SwiftUI sheet/picker | Trivial |
| Rate limit progress bar | SwiftUI `ProgressView` or `Gauge` | Trivial |
| Cost tracking display | Fetch `/api/cost-usage`, display in header | Trivial |
| Configuration | UserDefaults + settings screen | Trivial |
| Session persistence | SwiftData or JSON in app sandbox | Straightforward |
| Transcript browser | SwiftUI `List` with `.searchable()` | Straightforward |
| Voice input (push-to-talk) | `AVAudioRecorder` → WAV → gateway `/api/voice/transcribe` | Straightforward |
| Voice output | Gateway `/api/voice/synthesize` → `AVAudioPlayer` | Straightforward |
| SSE streaming chat | `URLSession` streaming + incremental UI updates | Straightforward |

### Requires significant new work

| Feature | Challenge | Complexity |
|---|---|---|
| Streaming markdown rendering | Render partial markdown as chunks arrive; code blocks with syntax highlighting; proper text selection | Moderate–High |
| App lifecycle + SSE | Handle stream interruption on background/foreground transitions; reconnect and recover partial responses | Moderate |
| Connectivity diagnostics | Cannot detect Tailscale status from sandboxed app; need alternative UX for connection troubleshooting | Low (drop Tailscale detection, show generic connectivity status) |

### iOS-native improvements over CLI

| Capability | Benefit |
|---|---|
| **Local real-time STT** | `SFSpeechRecognizer` enables on-device streaming transcription — no gateway round-trip, enables hands-free conversation mode |
| **Push notifications** | Gateway could notify app when long responses complete (requires adding push endpoint to gateway plugin) |
| **Background refresh** | Rate limits and cost data updated via `BGAppRefreshTask` |
| **Haptics** | Model switching, message sent/received feedback |
| **Share sheet** | Export conversations to other apps natively |
| **Widgets** | Home screen widget showing current spend, rate limit status |
| **Siri / Shortcuts** | "Hey Siri, ask Claude..." integration |

## Key Technical Challenges

### 1. Streaming markdown rendering (highest complexity)

The CLI outputs raw text to a terminal. An iOS app needs proper markdown rendering: bold, italic, headers, lists, code blocks with syntax highlighting, inline code, links, and tables.

The hard part is **streaming**: chunks arrive mid-word, mid-paragraph, mid-code-block. The renderer must handle partial markdown gracefully without flickering or layout jumps.

**Options:**
- **swift-markdown-ui**: Mature library, but designed for complete markdown strings. Would need to re-render on each chunk, which can cause flicker.
- **AttributedString with incremental parsing**: Build a custom incremental markdown parser that appends attributed text as chunks arrive. More work upfront but smoother UX.
- **WKWebView with streaming HTML**: Render markdown to HTML incrementally. Flexible but adds WebView overhead and complicates text selection/copy.

**Recommendation:** Start with swift-markdown-ui for v1 (re-render full response on each chunk). Optimize to incremental rendering if performance is an issue.

### 2. SSE streaming + iOS app lifecycle

When the user switches to another app mid-response, iOS will suspend the app and tear down the network connection. When they return:

- The SSE stream is dead
- The partial response is lost (unless buffered)
- The gateway may have already finished generating

**Mitigation strategies:**
- Buffer all received chunks locally so partial responses survive backgrounding
- On foreground resume, check if the response completed (query gateway or re-request with conversation context)
- Use `beginBackgroundTask` to request extra execution time (up to ~30 seconds) for active streams
- Consider switching from SSE to a request/response model where the gateway buffers complete responses and the client polls or fetches the result

### 3. Network connectivity and Tailscale

RemoteClaw assumes local network or Tailscale access to the gateway. On iOS:

- **Tailscale works**: The Tailscale iOS app creates a VPN profile. When active, the gateway is reachable at its Tailscale IP.
- **Detection is limited**: You cannot programmatically check if Tailscale is running from a sandboxed app. You can only observe whether the gateway URL is reachable.
- **Cellular considerations**: If the user is on cellular without Tailscale, the gateway is unreachable unless exposed publicly.

**Recommendation:** Drop Tailscale-specific detection. Show gateway connection status (connected/disconnected) and provide a setup guide linking to the Tailscale iOS app.

### 4. App Store review

Apple reviews AI-related apps with scrutiny:

- **Content moderation**: Apple may require content filtering for AI-generated responses. Since the app proxies to the user's own server, you can argue the user controls their own content, but Apple may still require age-rating (17+) or content warnings.
- **"App connects to user's own server" narrative**: This is uncommon and may confuse reviewers. Clear App Store description and review notes explaining the self-hosted architecture will help.
- **API key handling**: The app doesn't hold API keys (the gateway does), which simplifies the review story.

**Recommendation:** Submit with a 17+ age rating. Prepare detailed review notes explaining the self-hosted gateway architecture. Consider adding a basic content filter toggle as a concession if Apple requests it.

### 5. Voice: push-to-talk vs. hands-free

**Push-to-talk (v1):** Direct port of current behavior. User taps a button to record, taps again to stop. Audio sent to gateway for transcription. Simple, reliable.

**Hands-free conversation mode (v2):** Possible on iOS with local capabilities:

1. Use `AVAudioEngine` with an input tap for continuous audio capture
2. Run Voice Activity Detection (VAD) locally — either simple amplitude thresholding or Apple's `SFSpeechRecognizer` which provides real-time partial results with `isFinal` flags
3. Detect end-of-turn via silence duration (1.5–2s after last speech)
4. Send finalized transcript to gateway for LLM response
5. Play TTS response, then resume listening

`SFSpeechRecognizer` is the most viable path for hands-free on iOS because it provides streaming on-device recognition with built-in endpoint detection. The gateway's OpenAI-based STT could be used as a higher-quality fallback for the finalized transcript.

## Proposed Module Structure

```
RemoteClawApp/
├── App/
│   ├── RemoteClawApp.swift              # App entry point
│   └── AppState.swift                   # Global observable state
├── Models/
│   ├── Message.swift                    # Chat message model
│   ├── Session.swift                    # Session model
│   ├── ModelInfo.swift                  # LLM model metadata
│   ├── UsageStats.swift                 # Cost and rate limit data
│   └── GatewayConfig.swift              # Connection configuration
├── Services/
│   ├── GatewayClient.swift              # HTTP client for all gateway endpoints
│   ├── SSEStream.swift                  # Server-Sent Events parser
│   ├── SessionStore.swift               # Session persistence (SwiftData)
│   ├── VoiceRecorder.swift              # Audio recording
│   ├── VoicePlayer.swift                # Audio playback
│   └── SpeechRecognizer.swift           # Local STT (SFSpeechRecognizer)
├── Views/
│   ├── ChatView.swift                   # Main chat interface
│   ├── MessageBubble.swift              # Individual message rendering
│   ├── MarkdownRenderer.swift           # Markdown → AttributedString
│   ├── ModelPickerView.swift            # Model selection sheet
│   ├── TranscriptListView.swift         # Session browser
│   ├── TranscriptDetailView.swift       # Full transcript view
│   ├── StatusHeaderView.swift           # Connection, model, cost display
│   ├── VoiceControlView.swift           # Voice recording UI
│   └── SettingsView.swift               # Configuration screen
└── Utilities/
    ├── SSEParser.swift                  # SSE line protocol parser
    └── MarkdownStreamBuffer.swift       # Incremental markdown handling
```

## MVP Scope (v1)

A functional first release should include:

1. **Connect to gateway** — URL + optional auth token configuration
2. **Chat with streaming** — SSE streaming with markdown rendering
3. **Model switching** — picker with model list from gateway
4. **Session persistence** — save/load conversations
5. **Voice input** — push-to-talk via gateway transcription
6. **Basic status display** — connection status, current model, cost summary

### Deferred to v2+

- Hands-free conversation mode (local VAD + streaming STT)
- Push notifications for completed responses
- Rate limit progress bars and Anthropic direct-fetch fallback
- Transcript search and export
- Voice output / TTS auto-play
- Widgets and Siri Shortcuts
- Background refresh for usage data
- iPad and Mac Catalyst support

## Risk Summary

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Streaming markdown rendering is janky | High — core UX | Medium | Start simple, iterate on rendering approach |
| SSE drops on background | Medium — lost partial responses | High — iOS always does this | Buffer chunks locally, recover on foreground |
| App Store rejection | High — blocks release | Low–Medium | 17+ rating, clear review notes, optional content filter |
| Gateway unreachable on cellular | Medium — app unusable without VPN | Medium | Clear onboarding explaining Tailscale requirement |
| Apple deprecates/changes SFSpeechRecognizer | Low — only affects hands-free v2 | Low | Gateway STT as fallback |
