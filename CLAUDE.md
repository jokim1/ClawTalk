# ClawTalk

Terminal TUI client for remote LLM chatting. Connects to a ClawTalkGateway plugin on an OpenClaw server (via Tailscale VPN). React/Ink-based chat interface with multi-model support, voice I/O, session management, and real-time token/cost tracking. API keys stay on the server.

## Build

```bash
npm install
npm run build    # tsc → dist/
npm run dev      # tsc --watch
npm start        # node dist/cli.js
npm test         # jest
```

Requires Node 20+.

## Architecture

Client-server thin client. ClawTalk handles UI and streams SSE responses from the gateway. No direct LLM API calls.

- **`src/cli.ts`** — CLI entry point (commander.js)
- **`src/config.ts`** — Configuration management
- **`src/services/`** — Gateway API client (SSE streaming), voice I/O, session persistence, Talk metadata, Tailscale detection
- **`src/tui/`** — React/Ink components, hooks (`useChat`, `useGateway`, `useRealtimeVoice`), slash commands, input handling

Gateway project: `/home/k1min8r/projects/clawtalkgateway`

## TUI Rendering Warning

The TUI rendering layer (Ink/React, alternate screen, scrollback) is **fragile**. When working in `src/tui/`:
- Be very careful with changes to rendering, scrolling, and screen management
- Test any rendering changes manually — automated verification is insufficient
- Do NOT attempt to run the TUI directly; write automated tests or explain what to check manually

## Testing

Jest + ts-jest configured. Tests in `src/__tests__/`. When asked to "test" something, prefer writing automated unit/integration tests over manual/interactive testing.

## Code Style

- TypeScript with strict mode
- React 17 + Ink 3 for TUI components
- CommonJS module output (ES2020 target)
- No linter or formatter — match existing style
- Run `npx tsc --noEmit` after significant type-related changes

## Engineering Principles

1. **Single responsibility + explicit naming** — Each module does one thing. If a reader can't understand it from name + signature, rename it.
2. **Pass dependencies in, no hidden globals** — Constructor/function params, not singletons.
3. **Extract at 3+ call sites, not 2** — Duplication is cheaper than the wrong abstraction.
4. **Separate layers** — Services (API calls) / TUI (rendering) / hooks (state). Don't mix.
5. **Verify against gateway source** — Read ClawTalkGateway code before assuming endpoint behavior.
6. **Issue reporting: P0/P1/P2** — P0 (production failure), P1 (design flaw), P2 (improvement). Surface all P0s.

## Related Projects

- **ClawTalkGateway** — OpenClaw plugin providing HTTP endpoints this client connects to
- **ClawTalkMobile** — iOS client connecting to the same gateway
- **OpenClaw** — The host server the gateway plugin extends
