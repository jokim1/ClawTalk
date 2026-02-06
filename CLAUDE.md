# ClawTalk

Terminal TUI client for remote LLM chatting. Connects to a Moltbot gateway (via Tailscale VPN) and provides a React/Ink-based chat interface with multi-model support, voice I/O, session management, and real-time token/cost tracking.

## Testing Constraints

When asked to test TUI/interactive applications, do NOT attempt to run them directly. Instead:
1. Write and run automated unit/integration tests
2. Review the code for correctness
3. If visual verification is needed, explain what the user should check manually

## Build

```bash
npm install
npm run build    # tsc → dist/
npm run dev      # tsc --watch
npm start        # node dist/cli.js
```

Requires Node 20+. No test suite configured yet.

## Source Structure

```
src/
  cli.ts                   CLI entry point (commander.js)
  config.ts                Configuration management
  constants.ts             Shared constants
  models.ts                Model registry and pricing
  types.ts                 TypeScript type definitions
  services/
    chat.ts                Gateway API client (SSE streaming)
    voice.ts               Voice recording, transcription, playback
    realtime-voice.ts      Realtime voice WebSocket protocol
    sessions.ts            Session persistence (file-based)
    talks.ts               Talk metadata management
    tailscale.ts           Tailscale VPN status detection
    anthropic-ratelimit.ts Direct Anthropic rate limit fetching
    validation.ts          SSE chunk validation
    context-generator.ts   Context generation utilities
    terminal.ts            Terminal window spawning
  tui/
    app.tsx                Main application component
    commands.ts            Slash command registry
    helpers.ts             Input helpers
    utils.ts               TUI utilities
    messageWriter.ts       Message rendering logic
    hooks/
      useChat.ts           Chat state and messaging
      useGateway.ts        Gateway polling and status
      useRealtimeVoice.ts  Realtime voice state machine
    components/
      StatusBar.tsx        Status bar display
      ChatView.tsx         Message display
      InputArea.tsx        Text input / voice state
      ModelPicker.tsx      Model selection
      TranscriptHub.tsx    Session browser
      TalksHub.tsx         Talks management
      MultiLineInput.tsx   Multi-line input component
```

## Architecture

Client-server design. ClawTalk runs locally and connects to a ClawTalkGateway plugin on a remote Moltbot server. API keys stay on the server. Auth is via bearer token or localhost fallback.

Gateway project: `~/Projects/Personal/Terminator/ClawTalkGateway` (run `git pull` for latest).

## Caution: TUI Rendering

The TUI rendering layer (Ink/React, alternate screen, scrollback) is **fragile** and has known issues. It likely needs a complete rewrite to achieve a Claude Code-like experience. When working in `src/tui/`:
- Be very careful with changes to rendering, scrolling, and screen management
- Recent commits have been iterating on alternate screen vs scrollback approaches
- Test any rendering changes manually — automated verification is insufficient

## Testing

When asked to 'test' something, prefer writing automated tests (unit tests, integration tests) over manual/interactive testing. Use the project's existing test framework and patterns.

## Code Standards

This is a TypeScript project. Always use TypeScript for new files. Run `npx tsc --noEmit` after significant type-related changes to catch type errors early.

## Code Style

No linter or formatter configured. Match existing code style:
- TypeScript with strict mode
- React 17 + Ink 3 for TUI components
- CommonJS module output (ES2020 target)

## Related Projects

- **ClawTalkGateway** — Moltbot plugin providing HTTP endpoints this client connects to
- **ClawTalkMobile** — iOS client that connects to the same gateway
- **Moltbot** — The host server the gateway plugin extends
