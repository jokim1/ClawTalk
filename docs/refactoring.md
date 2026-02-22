# ClawTalk Client – Refactoring Guide

Read this when writing new code, refactoring existing modules, or reviewing pull requests. All examples reference actual source locations. Complements the existing `code-quality-audit.md` (which tracks individual issues) by providing architectural patterns and structural guidance.

## Codebase Overview

19,289 lines across 42 source files. The five largest files account for 57% of total code:

| File | Lines | Primary concern |
|------|------:|-----------------|
| `tui/app.tsx` | 4,264 | God component – layout, state, orchestration, rendering |
| `services/chat.ts` | 1,944 | Gateway HTTP transport + 20 distinct API operations |
| `tui/components/ChannelConfigPicker.tsx` | 1,630 | Platform binding CRUD, Slack proxy setup, response behavior |
| `tui/components/SettingsPicker.tsx` | 1,319 | Four tabbed settings panels in one component |
| `services/talks.ts` | 1,044 | Talk persistence, jobs, agents, directives, platform bindings |

---

## Architectural Patterns

### Existing Patterns to Preserve

These patterns already work well and should be extended to new code.

**Normalize Pattern** — Type guard → trim/lowercase → validate → default. Used in `talks.ts` (`normalizeExecutionMode`, `normalizeFilesystemAccess`, `normalizeNetworkAccess`). Matches the gateway's convention.

```typescript
function normalizeXxx(raw: string | undefined): ValidType | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'a' || value === 'b') return value;
  return undefined;
}
```

**Result Type Pattern** — Discriminated union for expected failures. Used in `voice.ts` (`startRecording`, `stopRecording`), `image.ts`, `file.ts`.

```typescript
type Result<T> = { ok: true } & T | { ok: false; error: string };
```

**Fire-and-forget persistence** — Async writes with `fsp.writeFile` that don't block the event loop. Used in `sessions.ts` and `talks.ts`. Always log on failure at `debug` level; never use empty `.catch(() => {})` in new code.

**Service interfaces** — `interfaces.ts` defines `IChatService`, `IVoiceService`, `IRealtimeVoiceService`, `ISessionManager`. New services should follow this pattern.

**Runtime validation** — `validation.ts` provides type guards for all gateway response shapes. Every `response.json()` call must pass through a validator before use.

### Context Object Pattern

Dependencies bundled into typed objects, passed explicitly to handlers. Currently used in `commands.ts` via `CommandContext`.

`CommandContext` currently has 61 function parameters — a sign that app state is scattered. Refactoring should reduce this by grouping related concerns:

```typescript
interface CommandContext {
  session: SessionContext;    // sessionManager, messages, activeSession
  talk: TalkContext;          // talkManager, activeTalk, talkId
  chat: ChatContext;          // chatService, sendMessage, model
  voice: VoiceContext;        // voiceService, ttsEnabled
  ui: UIContext;              // setMode, setError, setInputText
}
```

### Module Boundaries

| Layer | Responsibility | Current modules |
|-------|---------------|-----------------|
| CLI / entry | Parse args, bootstrap services | `cli.ts`, `config.ts` |
| TUI / presentation | React components, layout, keyboard input | `tui/app.tsx`, `tui/components/*` |
| Hooks / orchestration | State management, side effects, service coordination | `tui/hooks/*` |
| Services / business logic | Gateway communication, persistence, file processing | `services/*` |
| Types / contracts | Shared type definitions, constants | `types.ts`, `constants.ts`, `models.ts` |

A function should not cross layers. Services never import from `tui/`. Components should receive capabilities through props or hooks, not by importing services directly.

---

## Critical Refactoring Priorities

### 1. Split `app.tsx` (4,264 lines → target <800)

This is the single highest-impact refactoring. `app.tsx` currently owns: service initialization, gateway polling, voice state machine, keyboard routing, chat sending, model management, layout calculations, rendering, usage tracking, talk management, file attachments, export, message editing, job/directive/binding management, and multi-agent orchestration.

**Extraction plan:**

| Extract to | Responsibilities | Approximate lines |
|-----------|-----------------|------------------:|
| `hooks/useTalkManagement.ts` | Talk CRUD, objective, directives, pins, gateway sync | ~400 |
| `hooks/useModelManagement.ts` | Model switching, probing, agent model selection | ~200 |
| `hooks/useAttachments.ts` | File detection, image processing, attachment state | ~150 |
| `hooks/useKeyboardShortcuts.ts` | Ctrl key routing, mode switching, shortcut dispatch | ~300 |
| `hooks/useLayout.ts` | Terminal dimensions, height budgets, content width | ~80 |
| `components/OverlayRouter.tsx` | Modal routing (ModelPicker, TalksHub, Settings, etc.) | ~200 |
| Inline helpers → `tui/helpers.ts` | `formatBindingScopeLabel`, job normalization, etc. | ~150 |

After extraction, `app.tsx` should be a thin shell: initialize hooks, compose layout, render children.

### 2. Split ChannelConfigPicker (1,630 lines → 5-6 components)

12 distinct picker modes and 30+ `useState` hooks in a single component.

**Extraction plan:**

| Component | Responsibility |
|-----------|---------------|
| `ChannelBindingsList.tsx` | List view, keyboard nav, delete confirmation |
| `AddBindingFlow.tsx` | Multi-step add: provider → account → scope → permission |
| `EditBindingFields.tsx` | Field-by-field editing (scope, permission, response mode, etc.) |
| `SlackProxySetup.tsx` | Slack-specific proxy configuration, signing secret |
| `ResponseBehaviorEditor.tsx` | Response mode, delivery mode, prompt, agent assignment |
| `ChannelSuggestions.tsx` | Slack channel autocomplete with pagination |

### 3. Split SettingsPicker (1,319 lines → 4 tab components)

Each tab has completely independent state, keyboard handlers, and rendering logic.

| Component | Tab |
|-----------|-----|
| `SpeechSettingsTab.tsx` | Microphone, STT/TTS provider switching |
| `TalkConfigTab.tsx` | Objectives, directives, agent management |
| `ToolsSettingsTab.tsx` | Tool policy, execution modes, allow/deny lists, Google Auth |
| `SkillsSettingsTab.tsx` | Available skills, installation |

`SettingsPicker.tsx` becomes a thin tab router that renders the active tab component.

### 4. Extract Gateway Client base from ChatService (1,944 lines)

`ChatService` has 20+ methods that all repeat the same auth header construction and URL building. Additionally, `VoiceService` and `RealtimeVoiceService` duplicate the same pattern.

```typescript
// services/gateway-client.ts
export class GatewayClient {
  constructor(private config: { gatewayUrl: string; gatewayToken?: string }) {}

  protected buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.config.gatewayToken) {
      headers['Authorization'] = `Bearer ${this.config.gatewayToken}`;
    }
    return headers;
  }

  protected buildUrl(path: string): string {
    return `${this.config.gatewayUrl}${path}`;
  }

  protected async fetchJson<T>(
    path: string,
    options?: RequestInit & { timeoutMs?: number },
  ): Promise<T | null> {
    // Shared fetch with timeout, error handling, response size limits
  }
}
```

Then `ChatService extends GatewayClient`, `VoiceService extends GatewayClient`, etc.

### 5. Deduplicate Cross-Component Utilities

Several functions are duplicated 3-4 times across the codebase:

| Function | Locations | Fix |
|----------|-----------|-----|
| `formatBindingScopeLabel` | `app.tsx`, `SettingsPicker`, `JobsConfigPicker`, `ChannelConfigPicker` | Extract to `tui/formatters.ts` |
| Volume level computation (RMS dBFS) | `voice.ts:331-363`, `realtime-voice.ts:126-141` | Extract to `services/audio-utils.ts` |
| Export transcript (txt/md/docx) | `tui/utils.ts` (3 functions with 80+ lines overlap) | Extract base `exportTranscript(messages, format, options)` |
| Readiness hints / error maps | `useVoice.ts`, `useRealtimeVoice.ts` | Extract to `tui/error-messages.ts` |
| `isValidTalkId` / `isValidSessionId` | `sessions.ts`, `talks.ts` | Extract to `services/path-utils.ts` |
| `execFilePromise` | `file.ts`, `image.ts` (different signatures) | Unify in `services/exec-utils.ts` |
| `resolvePath` (~ expansion) | `file.ts:29`, `image.ts:48` | Extract to shared utility |

---

## SOLID Principles – Current State & Target

### Single Responsibility

| Current violation | Target |
|-------------------|--------|
| `app.tsx` owns 15+ concerns | Thin shell component + specialized hooks |
| `ChannelConfigPicker` owns 12 picker modes | One component per flow |
| `SettingsPicker` owns 4 tab panels | One component per tab |
| `ChatService` mixes transport with 20 API operations | `GatewayClient` base + domain-specific services |
| `TalkManager` handles talks, jobs, agents, directives, bindings, behaviors | Consider splitting into `TalkStore` (CRUD) + `TalkConfigManager` (jobs, agents, directives) |

### Open/Closed

| Current | Target |
|---------|--------|
| `commands.ts` COMMANDS map is extensible ✓ | Maintain this pattern |
| Normalize functions accept unknown input ✓ | Extend to new fields without modifying callers |
| Voice provider switching hardcoded in UI | Provider registry pattern: add new providers without UI changes |
| Export formats (txt/md/docx) as if/else chain | Format registry: `EXPORT_FORMATS: Record<string, ExportFormatter>` |

### Interface Segregation

| Current | Target |
|---------|--------|
| `CommandContext` has 61 parameters | Group into 5 focused sub-contexts (see Context Object Pattern above) |
| `StatusBar` takes 15+ props | Group into `ConnectionStatus`, `BillingInfo`, `VoiceStatus` |
| `app.tsx` passes 30+ props to children | Children get focused prop interfaces or use hooks |

### Dependency Inversion

| Current | Target |
|---------|--------|
| Service interfaces exist ✓ | Extend to all new services |
| `SettingsPicker` shells out to `SwitchAudioSource` | Abstract behind `IAudioDeviceService` |
| `terminal.ts` hardcodes macOS terminal emulators | Abstract behind `ITerminalSpawner` with platform detection |
| `file.ts`/`image.ts` hardcode macOS tools (`sips`, `textutil`) | Abstract behind `IFileProcessor` with platform-specific implementations |

---

## Error Handling Conventions

Align with the gateway's conventions:

| Strategy | When | Example |
|----------|------|---------|
| `throw` | Programmer error, invariant violation | Missing required config, invalid state transition |
| Result type | Expected failure, caller decides | `startRecording()` returns `{ ok: false; error }` |
| Fire-and-forget | Background ops where failure is acceptable | `void persistTalk(talk).catch(err => console.debug(...))` |
| Error classification | Transient vs permanent failures | `isTransientError()` in `chat.ts` for retry decisions |

**Current anti-patterns to fix:**

1. **Fragile string-based error detection** — `useChat.ts:175` uses regex `/^(Connection error|Error:|Failed to|Cannot connect|Timeout)/i` to classify gateway errors. Replace with structured error types:

```typescript
class GatewayError extends Error {
  constructor(message: string, public readonly isTransient: boolean, public readonly statusCode?: number) {
    super(message);
  }
}
```

2. **Swallowed errors** — Several `catch {}` blocks discard error context. Minimum standard: `catch (err) { console.debug('Context:', err); }`.

3. **Generic error states** — UI shows "Error" without indicating which subsystem failed. Error state should include: source (gateway/voice/session/file), severity (transient/permanent), and recovery hint.

---

## Import Conventions

Follow the gateway's conventions:

- Node built-ins: `from 'node:http'`, `from 'node:crypto'` (some files use bare `'fs'` — migrate to `'node:fs'`)
- Local modules: `from './module.js'` (always `.js` extension for ESM)
- Type-only imports: `import type { Foo } from './types.js'`
- Named imports preferred over default imports
- No barrel files (`index.ts` re-exports)

**Current inconsistency:** `sessions.ts` and `talks.ts` use `from '../types'` (no `.js`), while `voice.ts` uses `from './interfaces.js'`. Standardize to always include `.js`.

---

## Constants & Magic Values

`constants.ts` already centralizes network timeouts and audio parameters. Extend to cover values currently scattered through the codebase:

```typescript
// --- TUI Layout ---
export const CONTENT_WIDTH_PADDING = 2;
export const MIN_CONTENT_WIDTH = 10;

// --- UI Timing ---
export const INPUT_CLEANUP_DELAY_MS = 10;
export const VOLUME_POLL_INTERVAL_MS = 150;
export const TRANSCRIPT_CLEAR_DELAY_MS = 3000;
export const GATEWAY_POLL_INTERVAL_MS = 30_000;

// --- UI Icons ---
export const ICONS = {
  CONNECTED: '●',
  DISCONNECTED: '○',
  PARTIAL: '◐',
  VOICE: '♪',
} as const;

// --- Volume Meter ---
export const VOLUME_BAR_WIDTH = 12;
export const VOLUME_HIGH_THRESHOLD = 90;
export const VOLUME_MED_THRESHOLD = 70;
```

---

## State Management Patterns

### Current anti-patterns

1. **Refs mixed with useState** — `useChat.ts` uses `isProcessingRef`, `messagesRef`, `setErrorRef` alongside `useState`. This indicates stale-closure problems being papered over. Prefer `useReducer` for complex state or extract a stable dispatch pattern.

2. **30+ useState hooks in single component** — `ChannelConfigPicker` and `SettingsPicker` each have 30+ state variables. Group into reducers:

```typescript
type ChannelConfigState = {
  mode: ChannelConfigMode;
  selectedIndex: number;
  scopeInput: string;
  editField: EditField | null;
  confirmDelete: number | null;
  // ...
};

type ChannelConfigAction =
  | { type: 'SET_MODE'; mode: ChannelConfigMode }
  | { type: 'SELECT_INDEX'; index: number }
  | { type: 'CONFIRM_DELETE'; index: number }
  // ...
```

3. **TTS preference stored as file** — `useVoice.ts:37-62` reads/writes `~/.clawtalk/tts_enabled` directly. Move to `config.ts` alongside other preferences.

### Recommended patterns

- **Single useState for related state** — Group fields that change together
- **useReducer for mode machines** — Any component with 3+ modes (list/add/edit/delete)
- **Custom hooks for reusable patterns** — List navigation, confirm-delete flow, text input with cursor

---

## Shared Component Patterns to Extract

Several components repeat the same UI patterns:

### Scrollable List Picker

Used in: `TalksHub`, `EditMessages`, `ModelPicker`, `RolePicker`, `JobsConfigPicker`, `ChannelConfigPicker`

```typescript
interface ListPickerProps<T> {
  items: T[];
  selectedIndex: number;
  maxVisible: number;
  renderItem: (item: T, index: number, isSelected: boolean) => React.ReactNode;
  onSelect: (index: number) => void;
  onCancel: () => void;
}
```

### Confirm-Delete Flow

Used in: `TalksHub`, `EditMessages`, `JobsConfigPicker`, `ChannelConfigPicker`

```typescript
function useConfirmDelete(onDelete: (index: number) => void) {
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const confirm = (index: number) => setPendingIndex(index);
  const execute = () => { if (pendingIndex !== null) onDelete(pendingIndex); setPendingIndex(null); };
  const cancel = () => setPendingIndex(null);
  return { pendingIndex, confirm, execute, cancel };
}
```

### Multi-step Flow (Wizard)

Used in: `ChannelConfigPicker` (add binding), `JobsConfigPicker` (add job)

```typescript
interface WizardStep<T> {
  id: string;
  render: (state: T, advance: (patch: Partial<T>) => void) => React.ReactNode;
  validate?: (state: T) => string | null;
}
```

---

## Testing Strategy

Current test coverage is minimal (2 test files, 434 lines). Priority areas for testing:

1. **Normalize functions** — Pure functions with clear inputs/outputs. Easy to test exhaustively.
2. **Command parsing** — `commands.ts` handlers are quasi-pure (args → result). Mock the `CommandContext`.
3. **Validation functions** — `validation.ts` guards are pure. Test with valid, malformed, and adversarial inputs.
4. **State reducers** — Once extracted, reducers are pure `(state, action) → state`.
5. **Service methods** — Mock `fetch` and test `ChatService`, `VoiceService` response handling.
6. **File/image processing** — Mock `execFile` and test `processFile`, `processImage` with various file types.

---

## When to Extract vs Inline

Follow the gateway's conventions:

- **2 call sites**: Keep duplicated unless logic is >10 lines or likely to diverge
- **3+ call sites with identical patterns**: Extract to a shared utility
- **Same file**: Extract a local helper function
- **Cross-file**: Create a shared module in the appropriate layer

---

## Migration Path

Refactoring should be incremental. Each step should produce a working build.

**Phase 1 — Extract hooks from app.tsx (highest impact, lowest risk)**
1. Extract `useLayout` hook (dimensions, height budgets)
2. Extract `useTalkManagement` hook (talk CRUD operations)
3. Extract `useModelManagement` hook (model switching, probing)
4. Extract `useAttachments` hook (file detection, processing)
5. Extract `useKeyboardShortcuts` hook (Ctrl key routing)
6. Verify: `app.tsx` < 1,200 lines, all tests pass

**Phase 2 — Split mega-components**
1. Split `SettingsPicker` into 4 tab components
2. Split `ChannelConfigPicker` into 5-6 flow components
3. Split `JobsConfigPicker` into list + add + edit components
4. Extract `OverlayRouter` from `app.tsx` modal rendering

**Phase 3 — Service layer cleanup**
1. Extract `GatewayClient` base class
2. Deduplicate cross-file utilities (`formatBindingScopeLabel`, `execFilePromise`, volume computation, path resolution)
3. Move TTS preference to `config.ts`
4. Standardize import conventions (`.js` extensions, `node:` prefix)

**Phase 4 — Type safety & error handling**
1. Replace string-based error detection with structured error types
2. Group `CommandContext` into sub-contexts
3. Add `useReducer` for complex modal state machines
4. Extract shared UI patterns (ListPicker, ConfirmDelete, Wizard)

**Phase 5 — Testing**
1. Unit tests for normalize functions, validators, command handlers
2. Hook tests with mocked services
3. Integration tests for critical flows (send message, switch model, save talk)
