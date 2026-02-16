# ClawTalkPad Architecture Document

## Executive Summary

This document describes the architecture for extending ClawTalk (terminal TUI) to iPad while maintaining sync between devices. The approach prioritizes:

1. **Keeping the Mac TUI unchanged** — terminal experience is preserved
2. **Gateway-first sync** — no external cloud dependencies
3. **iPad-optimized TUI** — keyboard-driven, dense UI matching Mac experience
4. **Incremental delivery** — phases allow testing at each step

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Sync Architecture](#2-sync-architecture)
3. [Gateway API Extensions](#3-gateway-api-extensions)
4. [Mac TUI Modifications](#4-mac-tui-modifications)
5. [iPad App Architecture](#5-ipad-app-architecture)
6. [Data Models](#6-data-models)
7. [Conflict Resolution](#7-conflict-resolution)
8. [Implementation Phases](#8-implementation-phases)
9. [Open Questions](#9-open-questions)

---

## 1. System Overview

### 1.1 Current State

```
┌─────────────┐      HTTP/SSE       ┌─────────────────┐
│  Mac TUI    │◄───────────────────►│  OpenClaw       │
│  (Node.js)  │   talks/messages    │  + Gateway      │
│             │                     │  Plugin         │
│  ~/.clawtalk/                   │                 │
│  - config.json                  │  • talks API    │
│  - sessions/                    │  • chat API     │
│  - talks.json (local)           │  • voice API    │
└─────────────┘                   └─────────────────┘
```

**Limitation:** Talks are local to each Mac. No cross-device sync.

### 1.2 Target State

```
┌─────────────┐                    ┌─────────────────┐
│  Mac TUI    │◄──────────────────►│  OpenClaw       │
│  (Node.js)  │   HTTP/SSE         │  + Gateway      │
│             │   Sync API         │  Plugin         │
│  ~/.clawtalk/                  │                 │
│  - config.json                 │  • talks API    │
│  - sync.json (new)             │  • chat API     │
│  - local cache                 │  • sync API ◄───┼── new
└─────────────┘                  │  • realtime WS  │
                                 └────────┬────────┘
                                          │
                                 ┌────────▼────────┐
                                 │   iPad App      │
                                 │   (SwiftUI)     │
                                 │                 │
                                 │  • SwiftData    │
                                 │  - talks        │
                                 │  - messages     │
                                 │  - sync state   │
                                 └─────────────────┘
```

### 1.3 Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Gateway as sync hub | Uses existing infrastructure, works over Tailscale |
| WebSocket for realtime | Lower latency than polling |
| Soft deletes | Prevent accidental data loss |
| Version vectors | Handle offline edits cleanly |
| iPad-optimized UI | Don't compromise for iPhone universal support |

---

## 2. Sync Architecture

### 2.1 Sync Modes

Each device operates in three sync states:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   ONLINE    │────►│  SYNCING    │────►│    IDLE     │
│  (realtime) │     │  (catch-up) │     │  (ready)    │
└─────────────┘     └─────────────┘     └─────────────┘
       ▲                                      │
       └──────────────────────────────────────┘
                    (change detected)
```

**ONLINE:** WebSocket connected, changes pushed immediately
**SYNCING:** Reconnecting, downloading missed changes
**IDLE:** Local changes only, queue for next sync

### 2.2 Sync Engine (Shared Concept)

Both Mac and iPad implement the same sync logic:

```typescript
// Pseudocode for sync engine
interface SyncEngine {
  // State
  lastSyncTime: number
  deviceId: string
  pendingChanges: Change[]
  
  // Operations
  initialize(): Promise<void>
  push(change: Change): Promise<void>
  pull(): Promise<Change[]>
  resolveConflicts(local: Change, remote: Change): Change
}
```

### 2.3 Change Types

```typescript
type ChangeType = 
  | 'talk_created'
  | 'talk_updated'      // title, objective, model
  | 'talk_deleted'      // soft delete
  | 'message_sent'
  | 'message_edited'    // future: edit messages
  | 'message_deleted'   // soft delete
  | 'talk_pinned'       // pin added/removed
  | 'agent_added'
  | 'agent_removed'

interface Change {
  id: string
  type: ChangeType
  talkId: string
  timestamp: number      // client timestamp
  serverTimestamp?: number  // set by gateway
  deviceId: string
  data: unknown
  version: number        // increment on each edit
}
```

### 2.4 Sync Flow

```
Device A (Mac)                          Device B (iPad)
────────────                            ───────────────
    │                                         │
    │  1. User sends message                  │
    │  ──────────────────►                    │
    │                                         │
    │  2. Queue change locally                │
    │     + update UI immediately             │
    │                                         │
    │  3. Push to Gateway ───────────────────►│
    │              HTTP POST /api/sync/push   │
    │                                         │
    │         ◄───────────────────────────────│
    │              200 OK + serverTimestamp   │
    │                                         │
    │  4. Gateway broadcasts ────────────────►│
    │              WebSocket event            │
    │                                         │
    │  5. B receives message                  │
    │     + updates UI                        │
    │                                         │
```

---

## 3. Gateway API Extensions

### 3.1 New Endpoints

#### GET /api/sync/status
Health check and sync state.

**Response:**
```json
{
  "serverTime": 1709769600000,
  "websocketUrl": "wss://gateway.example.com/ws/sync",
  "supportedVersions": ["1.0"]
}
```

#### GET /api/sync/changes
Poll-based sync for initial load or WebSocket fallback.

**Query Parameters:**
- `since`: timestamp (milliseconds)
- `deviceId`: string
- `limit`: number (max 1000)

**Response:**
```json
{
  "changes": [
    {
      "id": "change-uuid",
      "type": "message_sent",
      "talkId": "talk-uuid",
      "timestamp": 1709769600000,
      "serverTimestamp": 1709769600010,
      "deviceId": "macbook-pro-joseph",
      "data": {
        "messageId": "msg-uuid",
        "role": "user",
        "content": "Hello",
        "model": "deepseek/deepseek-chat"
      },
      "version": 1
    }
  ],
  "hasMore": false,
  "serverTime": 1709769600100
}
```

#### POST /api/sync/push
Upload local changes.

**Request:**
```json
{
  "deviceId": "ipad-pro-joseph",
  "changes": [
    {
      "type": "talk_created",
      "talkId": "new-talk-uuid",
      "timestamp": 1709769600000,
      "data": {
        "title": "New Project Ideas",
        "model": "anthropic/claude-sonnet-4-5"
      }
    }
  ],
  "lastSyncTime": 1709769500000
}
```

**Response:**
```json
{
  "accepted": ["change-uuid-1", "change-uuid-2"],
  "rejected": [
    {
      "changeId": "change-uuid-3",
      "reason": "conflict",
      "serverVersion": 5
    }
  ],
  "serverTime": 1709769600100
}
```

#### WebSocket /ws/sync
Realtime bidirectional sync.

**Client → Server:**
```json
{
  "type": "subscribe",
  "deviceId": "ipad-pro-joseph",
  "lastSyncTime": 1709769600000
}
```

**Server → Client:**
```json
{
  "type": "change",
  "change": { /* change object */ }
}

{
  "type": "sync_complete",
  "serverTime": 1709769600100
}

{
  "type": "error",
  "message": "Authentication failed"
}
```

### 3.2 Gateway Storage

Extend existing talk storage with sync metadata:

```typescript
// In ClawTalkGateway plugin
interface SyncableTalk extends Talk {
  version: number           // increment on each update
  modifiedAt: number        // server timestamp
  modifiedBy: string        // deviceId
  deleted: boolean          // soft delete
}

interface StoredChange {
  id: string
  talkId: string
  timestamp: number
  deviceId: string
  changeType: ChangeType
  data: unknown
  // Retain for 30 days for new devices
  expiresAt: number
}
```

---

## 4. Mac TUI Modifications

### 4.1 New Files

```
src/
├── services/
│   ├── sync.ts           # Core sync engine
│   ├── syncStore.ts      # Local sync state persistence
│   └── webSocketSync.ts  # WebSocket client
```

### 4.2 Modified Files

```
src/
├── cli.ts                # Add --sync flag, sync init
├── config.ts             # Add deviceId, sync settings
├── tui/
│   └── app.tsx           # Sync indicator in status bar
└── services/
    ├── talks.ts          # Call sync.push() on mutations
    └── chat.ts           # Call sync.push() on new messages
```

### 4.3 Sync State File

`~/.clawtalk/sync.json`:
```json
{
  "deviceId": "macbook-pro-joseph",
  "lastSyncTime": 1709769600000,
  "pendingChanges": [],
  "serverUrl": "ws://100.x.x.x:18789",
  "syncEnabled": true
}
```

### 4.4 User Experience

**Status Bar Addition:**
```
GW:● TS:● M:Deep SYNC:●  $0.14/$0.28  Today $0.42  Wk $2.17
                              ^
                              new: ● = synced, ○ = syncing, ✗ = error
```

**Keyboard Shortcut:**
- `^R` — Force sync now

**Startup Behavior:**
1. Load local talks from `talks.json`
2. Initialize sync engine
3. Pull changes from gateway
4. Merge into local state
5. UI shows "Syncing..." indicator during merge

---

## 5. iPad App Architecture

### 5.1 Technology Stack

| Layer | Technology |
|-------|------------|
| Language | Swift 5.9+ |
| UI Framework | SwiftUI |
| Persistence | SwiftData |
| Networking | URLSession + WebSocketTask |
| Concurrency | Swift Concurrency (async/await) |
| Minimum OS | iPadOS 17.0+ |

### 5.2 Module Structure

```
ClawTalkPad/
├── App/
│   ├── ClawTalkPadApp.swift
│   ├── AppState.swift
│   └── KeyboardShortcuts.swift
├── Core/
│   ├── Sync/
│   │   ├── SyncEngine.swift
│   │   ├── SyncState.swift
│   │   ├── GatewaySyncClient.swift
│   │   └── WebSocketSync.swift
│   ├── Network/
│   │   ├── GatewayClient.swift
│   │   ├── SSEParser.swift
│   │   └── APIEndpoints.swift
│   ├── Data/
│   │   ├── Models/
│   │   │   ├── Talk.swift
│   │   │   ├── Message.swift
│   │   │   └── SyncMetadata.swift
│   │   └── Persistence/
│   │       ├── TalkStore.swift
│   │       └── MessageStore.swift
│   └── Voice/
│       ├── VoiceController.swift
│       └── AudioSessionManager.swift
├── UI/
│   ├── RootView.swift
│   ├── Components/
│   │   ├── StatusBar.swift
│   │   ├── TerminalMessageView.swift
│   │   ├── CommandPalette.swift
│   │   └── ShortcutBar.swift
│   ├── Talks/
│   │   ├── TalksSidebar.swift
│   │   ├── TalkRow.swift
│   │   └── NewTalkSheet.swift
│   ├── Chat/
│   │   ├── ChatContainer.swift
│   │   ├── MessageList.swift
│   │   └── StreamingMessageView.swift
│   └── Input/
│       ├── InputBar.swift
│       ├── ModelPicker.swift
│       ├── HistoryBrowser.swift
│       └── VoiceOverlay.swift
└── Resources/
```

### 5.3 Key UI Components

#### StatusBar
Matches Mac TUI exactly:
```swift
struct StatusBar: View {
    // GW:● TS:● M:Deep SYNC:●
    // Pricing and cost tracking
    // Session indicator
}
```

#### ChatContainer
Main chat interface:
```swift
struct ChatContainer: View {
    // Status bar (fixed top)
    // Scrollable message list (terminal-style)
    // Command hints (when typing /)
    // Error bar
    // Input bar with > prompt
    // Shortcut bar (fixed bottom)
}
```

#### TalksSidebar
Navigation sidebar:
```swift
struct TalksSidebar: View {
    // Search bar
    // Pinned talks section
    // Recent talks list
    // New talk button
}
```

### 5.4 SwiftData Models

```swift
@Model
class Talk {
    @Attribute(.unique) var id: UUID
    var topicTitle: String
    var objective: String?
    var model: String
    var createdAt: Date
    var updatedAt: Date
    var isPinned: Bool
    var isArchived: Bool
    var syncVersion: Int
    var lastSyncTime: Date?
    
    @Relationship(deleteRule: .cascade, inverse: \Message.talk)
    var messages: [Message]?
    
    @Relationship(deleteRule: .nullify)
    var pinnedMessages: [Message]?
}

@Model
class Message {
    @Attribute(.unique) var id: UUID
    var role: MessageRole
    var content: String
    var timestamp: Date
    var model: String?
    var agentName: String?
    var syncVersion: Int
    var isDeleted: Bool
    
    var talk: Talk?
}

@Model
class SyncState {
    var deviceId: String
    var lastSyncTime: Date
    var serverUrl: String
    var isSyncEnabled: Bool
}

enum MessageRole: String, Codable {
    case user, assistant, system
}
```

### 5.5 Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `^T` | Toggle talks sidebar |
| `^A` | Open model picker |
| `^N` | New talk |
| `^H` | Open history browser |
| `^P` | Push-to-talk voice input |
| `^C` | Live voice chat |
| `^V` | Toggle TTS |
| `^R` | Force sync |
| `^X` | Exit (close talk) |
| `↑` / `↓` | Cycle message history |
| `Tab` | Accept command completion |
| `Esc` | Close overlay / back to talks |

---

## 6. Data Models

### 6.1 Talk (Cross-Platform)

```typescript
// Shared schema
interface Talk {
  id: string
  topicTitle: string
  objective?: string
  model: string
  createdAt: number
  updatedAt: number
  
  // Sync
  version: number
  modifiedBy: string
  deleted: boolean
  
  // Relationships
  pinnedMessageIds: string[]
  agents: TalkAgent[]
}

interface TalkAgent {
  name: string
  model: string
  role: AgentRole
  isPrimary: boolean
}

type AgentRole = 
  | 'analyst' 
  | 'critic' 
  | 'strategist' 
  | 'devils-advocate' 
  | 'synthesizer' 
  | 'editor'
```

### 6.2 Message

```typescript
interface Message {
  id: string
  talkId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  
  // Optional metadata
  model?: string
  agentName?: string
  agentRole?: AgentRole
  
  // Sync
  version: number
  deleted: boolean
  
  // Usage (optional)
  usage?: {
    promptTokens: number
    completionTokens: number
  }
}
```

### 6.3 Configuration

```typescript
// ~/.clawtalk/config.json (Mac)
// Shared schema with iPad
interface ClawTalkConfig {
  gatewayUrl: string
  gatewayToken: string
  deviceId: string
  defaultModel: string
  
  sync: {
    enabled: boolean
    autoSync: boolean
    syncInterval: number  // seconds
  }
  
  billing: BillingConfig
  voice: VoiceConfig
}
```

---

## 7. Conflict Resolution

### 7.1 Conflict Types

| Scenario | Resolution |
|----------|------------|
| Simultaneous message send | Both kept, ordered by timestamp |
| Title edit on A and B | Last-write-wins (server timestamp) |
| Talk deleted on A, message added on B | Soft delete wins, B's message archived |
| Model switched on A and B | Last-write-wins, but per-message model preserved |
| Offline edits on both devices | Merge: messages append, metadata LWW |

### 7.2 Version Vectors

Each talk maintains a version counter:

```typescript
interface TalkVersion {
  talkId: string
  globalVersion: number
  deviceVersions: Record<string, number>
}

// Example:
{
  talkId: "talk-123",
  globalVersion: 5,
  deviceVersions: {
    "macbook-pro": 3,
    "ipad-pro": 2
  }
}
```

### 7.3 Merge Strategy

```typescript
function mergeTalks(local: Talk, remote: Talk): Talk {
  // Messages: append-only union
  const mergedMessages = unionByTimestamp(
    local.messages,
    remote.messages
  )
  
  // Metadata: compare versions
  const metadata = remote.version > local.version 
    ? remote 
    : local
  
  return {
    ...metadata,
    messages: mergedMessages,
    version: Math.max(local.version, remote.version)
  }
}
```

---

## 8. Implementation Phases

### Phase 1: Gateway Sync API (Week 1-2)

**Deliverable:** Extended ClawTalkGateway with sync endpoints

**Tasks:**
- [ ] Add sync storage tables (talk versions, change log)
- [ ] Implement `GET /api/sync/changes`
- [ ] Implement `POST /api/sync/push`
- [ ] Add WebSocket endpoint `/ws/sync`
- [ ] Add change retention policy (30 days)
- [ ] Write integration tests

**Test:** Use curl to verify sync between two sessions

### Phase 2: Mac TUI Sync (Week 3-4)

**Deliverable:** Mac TUI syncs talks to gateway

**Tasks:**
- [ ] Create `SyncEngine` class
- [ ] Add `sync.json` persistence
- [ ] Integrate sync into `TalkManager`
- [ ] Add status indicator to UI
- [ ] Add `^R` force sync shortcut
- [ ] Handle offline queue

**Test:** Two Macs (or Mac + curl) sync talks

### Phase 3: iPad Foundation (Week 5-7)

**Deliverable:** Basic iPad app with talks and chat

**Tasks:**
- [ ] Xcode project setup
- [ ] SwiftData models
- [ ] Gateway client (HTTP)
- [ ] Talks sidebar
- [ ] Chat container
- [ ] Message streaming
- [ ] Basic keyboard shortcuts

**Test:** iPad can create talks and send messages

### Phase 4: iPad Sync (Week 8-9)

**Deliverable:** iPad syncs with gateway

**Tasks:**
- [ ] Port `SyncEngine` to Swift
- [ ] WebSocket sync client
- [ ] Initial sync on launch
- [ ] Real-time updates
- [ ] Offline queue
- [ ] Conflict resolution UI

**Test:** Mac and iPad sync in real-time

### Phase 5: iPad Polish (Week 10-11)

**Deliverable:** Feature-complete iPad app

**Tasks:**
- [ ] Voice input (^P)
- [ ] Model picker (^A)
- [ ] History browser (^H)
- [ ] Complete keyboard shortcuts
- [ ] Settings view
- [ ] Status bar parity with Mac

**Test:** Full workflow on iPad matches Mac

### Phase 6: Integration (Week 12)

**Deliverable:** Production-ready system

**Tasks:**
- [ ] End-to-end testing
- [ ] Performance testing (1000+ talks)
- [ ] Error handling review
- [ ] Documentation
- [ ] App Store submission prep

---

## 9. Open Questions

### 9.1 To Resolve Before Starting

1. **Conflict UI:** Should conflicts show a resolution dialog, or auto-resolve silently?

2. **Initial Sync:** On new device setup, download all talks or lazy-load on open?

3. **Message History:** How many messages to sync per talk? (last 100? all?)

4. **Images/Files:** Mac TUI doesn't support attachments. Should iPad? How sync?

5. **Voice Settings:** Per-device or synced? (e.g., TTS voice preference)

6. **Gateway Compatibility:** Minimum gateway version check on connect?

7. **Encryption:** Encrypt sync data at rest on gateway?

8. **Multiple Gateways:** Support syncing talks from different gateways?

### 9.2 Future Considerations

- **iPhone companion:** Simplified read-only mode?
- **Web client:** Browser-based access?
- **Shared talks:** Multi-user access to same talk?
- **E2E encryption:** Zero-knowledge sync?

---

## Appendix A: API Endpoint Summary

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sync/status` | GET | Health check |
| `/api/sync/changes` | GET | Poll for changes |
| `/api/sync/push` | POST | Submit changes |
| `/ws/sync` | WebSocket | Real-time sync |

## Appendix B: Sync State Machine

```
┌─────────┐    connect     ┌─────────┐
│  IDLE   │───────────────►│ CONNECT │
└────┬────┘                └────┬────┘
     │                          │ success
     │                    ┌─────▼─────┐
     │                    │  ONLINE   │◄──────────┐
     │                    └─────┬─────┘           │
     │                          │                 │
     │                ┌─────────┴──────────┐      │
     │                │                    │      │
     │           disconnect            push change│
     │                │                    │      │
     │                ▼                    ▼      │
     │           ┌─────────┐        ┌─────────┐   │
     └──────────►│ OFFLINE │◄───────│ SYNCING │   │
                 └────┬────┘        └────┬────┘   │
                      │                   │        │
                      │   network back    │        │
                      └──────────────────►│        │
                                          └────────┘
```

---

*Document Version: 1.0*  
*Last Updated: 2026-02-11*  
*Author: Claude + Joseph*
