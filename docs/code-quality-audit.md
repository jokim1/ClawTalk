# RemoteClaw Code Quality Audit

**Date:** 2026-01-31
**Audited by:** Claude Opus 4.5
**Files audited:** All 17 source files in src/

---

## Issue Summary

| # | Category | Severity | File | Description | Status |
|---|---|---|---|---|---|
| 1 | SRP | SHOULD-FIX | app.tsx | God component with 20+ state variables and 726 lines | OPEN |
| 2 | SRP | NICE-TO-HAVE | chat.ts | ChatService mixes HTTP transport with 10 operations | OPEN |
| 3 | SRP | NICE-TO-HAVE | TranscriptHub.tsx | Three modes in one component | OPEN |
| 4 | OCP | SHOULD-FIX | app.tsx | Slash commands not extensible | OPEN |
| 5 | OCP | SHOULD-FIX | app.tsx | `isNoReply` sentinel check is fragile and inline | FIXED |
| 6 | ISP | NICE-TO-HAVE | StatusBar.tsx | 10-prop interface too broad | OPEN |
| 7 | DIP | SHOULD-FIX | app.tsx | No service interfaces; concrete classes only | OPEN |
| 8 | DIP | NICE-TO-HAVE | sessions.ts | Direct fs coupling, no storage abstraction | OPEN |
| 9 | Pattern | SHOULD-FIX | chat.ts, voice.ts | No Gateway Client abstraction; auth headers repeated 11x | FIXED |
| 10 | Pattern | NICE-TO-HAVE | sessions.ts | Module-level singleton pattern | OPEN |
| 11 | Pattern | NICE-TO-HAVE | app.tsx | Voice state machine would be clearer | OPEN |
| 12 | Pattern | NICE-TO-HAVE | app.tsx | Rate limit strategy chain | OPEN |
| 13 | Complexity | SHOULD-FIX | app.tsx | 4-level nesting in voice handler | OPEN |
| 14 | Complexity | SHOULD-FIX | app.tsx | 4-level nesting in gateway/voice init | OPEN |
| 15 | Complexity | NICE-TO-HAVE | StatusBar.tsx | IIFE in JSX for rate limit rendering | OPEN |
| 16 | Duplication | SHOULD-FIX | chat.ts, voice.ts | Auth header construction repeated 11 times | FIXED |
| 17 | Duplication | SHOULD-FIX | app.tsx | Message construction repeated 6 times | OPEN |
| 18 | Duplication | SHOULD-FIX | chat.ts | History mapping duplicated in send/stream | FIXED |
| 19 | Duplication | SHOULD-FIX | app.tsx | `setInputText` cleanup hack repeated 6 times | OPEN |
| 20 | Maintainability | SHOULD-FIX | Multiple | 20+ magic numbers without named constants | FIXED |
| 21 | Maintainability | SHOULD-FIX | app.tsx, sessions.ts | Default model string repeated in 3 places | FIXED |
| 22 | Naming | NICE-TO-HAVE | Multiple | Inconsistent export styles (class vs functions) | OPEN |
| 23 | Naming | NICE-TO-HAVE | app.tsx | Terse variable names (`p`) | OPEN |
| 24 | Scalability | NICE-TO-HAVE | models.ts | Static model registry (mitigated by dynamic discovery) | OPEN |
| 25 | Scalability | NICE-TO-HAVE | app.tsx | No plugin/hook architecture for new features | OPEN |
| 26 | Scalability | SHOULD-FIX | sessions.ts | Synchronous I/O blocks event loop; loads all data at startup | OPEN |
| 27 | Reusability | NICE-TO-HAVE | components/ | Components import domain-specific types | OPEN |
| 28 | Error Handling | SHOULD-FIX | Multiple | 14 bare catch blocks swallow errors silently | OPEN |
| 29 | Error Handling | NICE-TO-HAVE | app.tsx | Gateway errors not differentiated to user | OPEN |
| 30 | Error Handling | NICE-TO-HAVE | app.tsx | `probeModel` promise has no `.catch()` | OPEN |
| 31 | Error Handling | NICE-TO-HAVE | app.tsx | Error state never auto-clears | OPEN |
| 32 | TypeScript | SHOULD-FIX | chat.ts, voice.ts | API responses cast with `as` without runtime validation | OPEN |
| 33 | TypeScript | NICE-TO-HAVE | sessions.ts, config.ts | `JSON.parse` returns untyped `any` | OPEN |
| 34 | TypeScript | NICE-TO-HAVE | chat.ts | SSE `parsed` is implicitly `any` | OPEN |
| 35 | TypeScript | NICE-TO-HAVE | chat.ts | No generic fetch wrapper | OPEN |
| 36 | TypeScript | SHOULD-FIX | InputArea.tsx | `disabled` prop accepted but never used | FIXED |
| 37 | Dead Code | NICE-TO-HAVE | sessions.ts | `saveSession` method never called | FIXED |
| 38 | Correctness | SHOULD-FIX | app.tsx | Hardcoded $0.01 cost per message | FIXED |
| 39 | Memory | NICE-TO-HAVE | chat.ts | AbortSignal listeners not cleaned on error path | OPEN |
| 40 | Correctness | NICE-TO-HAVE | app.tsx | `Date.now()` message IDs can collide | OPEN |

---

## Detailed Findings

### Issue #1: `app.tsx` is a God Component (SRP — SHOULD-FIX)

**File:** `src/tui/app.tsx`, lines 42-768 (~726 lines)

The `App` component handles too many responsibilities:
- Service initialization (ChatService, VoiceService, SessionManager, AnthropicRateLimitService)
- Gateway health polling and model discovery
- Voice recording lifecycle
- Keyboard shortcut routing
- Chat message sending with streaming
- Model switching and probing
- Layout calculations
- Rendering
- Usage/cost tracking
- Rate limit fetching with Anthropic fallback

Manages **20+ pieces of state**. Should be extracted into custom hooks:
- `useGatewayHealth()` — gateway status polling, model discovery, provider fetching
- `useModelManagement()` — model switching, probing
- `useChat()` — message sending, streaming, history
- `useVoice()` — voice recording, transcription, TTS
- `useUsageTracking()` — cost/rate limit polling
- `useKeyboardShortcuts()` — input handling
- `useLayout()` — dimension calculations

### Issue #2: ChatService Mixes Transport with Business Logic (SRP — NICE-TO-HAVE)

**File:** `src/services/chat.ts`, lines 39-386

`ChatService` has 10 distinct network operations with duplicated header construction logic across nearly every method. A base `GatewayClient` class could handle auth headers and base URL.

### Issue #3: TranscriptHub Handles Three Modes (SRP — NICE-TO-HAVE)

**File:** `src/tui/components/TranscriptHub.tsx`, lines 25-498

Manages list, transcript, and search modes with separate state, scroll logic, and rendering for each. Each mode could be its own component.

### Issue #4: Slash Commands Not Extensible (OCP — SHOULD-FIX)

**File:** `src/tui/app.tsx`, lines 522-559

The `/model` command and bare alias commands are handled with hardcoded `if` statements. A command registry pattern would allow extending commands without modifying `sendMessage`:
```typescript
const COMMANDS: Record<string, CommandHandler> = {
  model: handleModelCommand,
  // new commands added here
};
```

### Issue #5: `isNoReply` Sentinel Check is Fragile (OCP — SHOULD-FIX)

**File:** `src/tui/app.tsx`, lines 586-591

Gateway sentinel strings (`'NO_REPLY'`, `'HEARTBEAT_OK'`, etc.) are checked inline with multiple `.startsWith()` calls. Should be constants, checked via a single helper, and ideally filtered at the `ChatService` layer.

### Issue #6: StatusBar Takes Too Many Props (ISP — NICE-TO-HAVE)

**File:** `src/tui/components/StatusBar.tsx`, lines 33-46

`StatusBarProps` has 10 properties. Could group related props or split into sub-components.

### Issue #7: No Service Interfaces (DIP — SHOULD-FIX)

**File:** `src/tui/app.tsx`, lines 82-86, 159-174

`App` directly instantiates concrete service classes with no interfaces, making testing and implementation swapping impossible.

### Issue #8: SessionManager Coupled to Filesystem (DIP — NICE-TO-HAVE)

**File:** `src/services/sessions.ts`

Direct `fs` calls throughout. A `SessionStorage` interface would allow alternative backends.

### Issue #9: No Gateway Client Abstraction (Pattern — SHOULD-FIX)

**File:** `src/services/chat.ts` (8x), `src/services/voice.ts` (3x)

Auth header construction repeated 11 times:
```typescript
...(this.config.gatewayToken && {
  'Authorization': `Bearer ${this.config.gatewayToken}`,
})
```

Extract to a shared `GatewayClient` base with `buildHeaders()` and `buildUrl()`.

### Issue #10–12: Pattern Opportunities (NICE-TO-HAVE)

- **#10:** `SessionManager` uses module-level singleton
- **#11:** Voice state transitions scattered across callbacks; state machine would be clearer
- **#12:** Rate limit fetching (gateway → Anthropic fallback) is a strategy/chain pattern

### Issue #13–14: Deep Nesting (Complexity — SHOULD-FIX)

- **#13:** Ctrl+V handler has 4 levels of nesting
- **#14:** Gateway/voice initialization has 4 levels of conditional nesting

### Issue #15: IIFE in JSX (Complexity — NICE-TO-HAVE)

StatusBar subscription rendering uses `(() => { ... })()` inside JSX. Extract to sub-component.

### Issue #16: Auth Headers Repeated 11 Times (Duplication — SHOULD-FIX)

See Issue #9. Same fix.

### Issue #17: Message Construction Repeated 6 Times (Duplication — SHOULD-FIX)

**File:** `src/tui/app.tsx`, lines 137-142, 147-152, 547-552, 564-568, 594-599, 643-648

Extract `createSystemMessage(content)` and `appendMessage(msg)` helpers.

### Issue #18: History Mapping Duplicated (Duplication — SHOULD-FIX)

**File:** `src/services/chat.ts`, lines 53-59, 108-114

Identical history-to-messages mapping in `sendMessage` and `streamMessage`. Extract to `private buildMessages()`.

### Issue #19: Input Cleanup Hack Repeated 6 Times (Duplication — SHOULD-FIX)

**File:** `src/tui/app.tsx`, multiple locations

The `setTimeout(() => setInputText(prev => prev.replace(...)))` pattern for Ink control character cleanup. Extract to `cleanInputChar(char)`.

### Issue #20: Magic Numbers (Maintainability — SHOULD-FIX)

20+ unnamed numeric constants across the codebase:
- Timeouts: 3000, 5000, 10000, 30000 ms
- Audio params: 16000 Hz, 16-bit, 120s max
- Layout: padding 4, prompt width 2
- Cost: $0.01 per message
- Polling: 30000ms interval
- Debounce: 150ms, 100ms, 300ms

Should be named constants in a `constants.ts`.

### Issue #21: Default Model String Repeated (Maintainability — SHOULD-FIX)

`'deepseek/deepseek-chat'` appears in `app.tsx`, `sessions.ts` (2x). Should be `DEFAULT_MODEL` from `models.ts`.

### Issue #22–23: Naming (NICE-TO-HAVE)

- Inconsistent export styles (classes vs bare functions)
- Terse variable names (`p` for both pricing and provider)

### Issue #24–25: Scalability (NICE-TO-HAVE)

- Static model registry (mitigated by dynamic discovery)
- No plugin/hook architecture for new features

### Issue #26: Synchronous I/O in SessionManager (Scalability — SHOULD-FIX)

**File:** `src/services/sessions.ts`

All file operations are synchronous. `loadSessions()` reads ALL sessions into memory on startup. `searchTranscripts()` does linear scan. Consider lazy loading and async I/O.

### Issue #27: Components Import Domain Types (Reusability — NICE-TO-HAVE)

Components directly import from `../../types` and `../../models` rather than accepting generic props.

### Issue #28: 14 Bare Catch Blocks (Error Handling — SHOULD-FIX)

Across `config.ts`, `chat.ts`, `sessions.ts`, `voice.ts`. All silently swallow errors. Should at least have `console.debug()` or propagate typed errors.

### Issue #29–31: Error Handling Improvements (NICE-TO-HAVE)

- Gateway polling errors all show as "offline" regardless of cause
- `probeModel` promise has no `.catch()`
- Error state persists indefinitely in UI

### Issue #32: API Responses Cast Without Validation (TypeScript — SHOULD-FIX)

**File:** `src/services/chat.ts`, `src/services/voice.ts`

Every `response.json()` uses `as` type assertion with no runtime validation. A lightweight validator (Zod or manual guards) would prevent silent failures.

### Issue #33–35: TypeScript Improvements (NICE-TO-HAVE)

- `JSON.parse` returns untyped `any`
- SSE `parsed` is implicitly `any`
- No generic fetch wrapper

### Issue #36: `disabled` Prop Never Used (TypeScript — SHOULD-FIX)

**File:** `src/tui/components/InputArea.tsx`, line 20

`InputArea` accepts `disabled` but never uses it. The input should be disabled during processing.

### Issue #37: Dead Code (NICE-TO-HAVE)

`saveSession` method in `sessions.ts` is defined but never called.

### Issue #38: Hardcoded Cost Tracking (Correctness — SHOULD-FIX)

**File:** `src/tui/app.tsx`, lines 629-632

Adds flat `$0.01` per message regardless of model or token count. Should use actual cost data from `getCostUsage()`.

### Issue #39: AbortSignal Listener Leak (Memory — NICE-TO-HAVE)

**File:** `src/services/chat.ts`

Listeners added in `probeModel` not cleaned up on error path.

### Issue #40: Message ID Collisions (Correctness — NICE-TO-HAVE)

`Date.now().toString()` for message IDs can collide within the same millisecond. Use `crypto.randomUUID()`.

---

## Priority Recommendations

### Highest Impact (do first):

1. **Extract custom hooks from `app.tsx`** — Addresses issues #1, #13, #14, #17, #19
2. **Create `GatewayClient` base class** — Addresses issues #9, #16, #18
3. **Add runtime validation for API responses** — Issue #32
4. **Extract named constants** — Issues #20, #21
5. **Add command registry** — Issue #4

### Medium Impact (do when touching affected code):

6. Define service interfaces (#7)
7. Fix `disabled` prop in InputArea (#36)
8. Fix hardcoded cost tracking (#38)
9. Add logging to bare catch blocks (#28)
10. Add `.catch()` to fire-and-forget promises (#30)
