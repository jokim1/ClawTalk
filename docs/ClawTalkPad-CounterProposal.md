# ClawTalkPad: Gateway-First Architecture

**Counter-proposal to ClawTalkPad-Architecture.md**

## Core Thesis

The original architecture proposes a full sync engine with version vectors, change logs, and a dedicated sync protocol. This counter-proposal argues that the gateway already IS the sync hub, and multi-device support requires extending what exists rather than building a parallel sync system.

**Key insight:** ClawTalk is a single-user system. There is no concurrent multi-user editing. The hardest sync problems (conflict resolution, CRDTs, version vectors) don't apply. The gateway is already the source of truth for all important data.

---

## 1. Current State Assessment

### What the Gateway Already Owns

| Data | Storage | API Exists? | Source of Truth? |
|------|---------|-------------|-----------------|
| Message history | `history.jsonl` per talk | `GET /api/talks/:id/messages` | Yes |
| Talk metadata | `talk.json` per talk | Full CRUD on `/api/talks` | Yes |
| Context.md | `context.md` per talk | Via talk detail endpoint | Yes |
| Pinned messages | In `talk.json` | Pin/unpin endpoints | Yes |
| Agents | In `talk.json` | Via talk update | Yes |
| Jobs | In `talk.json` | Full CRUD on jobs endpoints | Yes |
| Job reports | `reports.jsonl` per talk | `GET /api/talks/:id/reports` | Yes |

### What the Mac Client Does Today

1. On TalksHub open: calls `GET /api/talks` and imports all gateway talks into local cache
2. On talk select: fetches messages from gateway, replaces local state
3. On message send: `POST /api/talks/:id/chat` (gateway persists both user + assistant messages)
4. On metadata change: calls `PATCH /api/talks/:id` to sync title, objective, model, agents
5. Polls gateway every 30 seconds for job reports

**The Mac client is already a thin cache over the gateway.** The only gaps are:
- Unsaved talks don't create a gateway talk until first message
- No notification when another device makes changes
- No awareness of other connected devices

---

## 2. What Needs to Change

### 2.1 Gateway Additions (Small)

#### A. Timestamp-based change detection

Add `since` filtering to the talks list endpoint:

```
GET /api/talks?since=1709769600000
```

Returns only talks with `updatedAt > since`. Clients call this on launch (or resume from background) to discover what changed while they were away. No change log, no change types -- just re-fetch the talks that are newer.

**Why this is enough:** Messages are append-only (no edits, no deletes). Talk metadata is small and cheap to re-fetch entirely. Re-importing a talk that hasn't actually changed is a no-op.

#### B. Lightweight WebSocket notifications

Add a simple notification channel:

```
WS /api/sync
```

Server sends one-line events when any talk data changes:

```json
{"event": "talk_updated", "talkId": "uuid", "updatedAt": 1709769600000}
{"event": "talk_created", "talkId": "uuid"}
{"event": "talk_deleted", "talkId": "uuid"}
{"event": "message_added", "talkId": "uuid", "messageId": "uuid"}
{"event": "job_report", "talkId": "uuid", "reportId": "uuid"}
```

These are **notifications, not data**. The client receives "something changed" and re-fetches via the existing HTTP endpoints. This keeps the WebSocket protocol trivially simple and avoids duplicating the HTTP API over WebSocket.

Client subscribes on connect:
```json
{"type": "subscribe", "deviceId": "macbook-pro-joseph", "since": 1709769600000}
```

Server replays missed events since `since` timestamp, then streams live.

**Fallback:** If WebSocket drops, the client falls back to polling `GET /api/talks?since=` on a 30-second interval (which is what the Mac TUI already does for job reports). No data loss, just slower updates.

#### C. Device awareness (optional, nice-to-have)

```
GET /api/sync/devices
```

Returns currently connected devices:
```json
{
  "devices": [
    {"deviceId": "macbook-pro-joseph", "connectedAt": 1709769600000, "lastSeen": 1709769650000},
    {"deviceId": "ipad-pro-joseph", "connectedAt": 1709769610000, "lastSeen": 1709769660000}
  ]
}
```

Useful for the status bar ("2 devices connected") but not required for sync.

### 2.2 Gateway Fixes (Required Before iPad)

#### A. Auto-create talks on gateway

Currently, a gateway talk is only created on first message send. For sync to work, every saved talk should exist on the gateway immediately. Change the flow:

- `/save` command or `saveTalk()` -> if no `gatewayTalkId`, create on gateway immediately
- Remove the lazy creation pattern from message send

#### B. Consistent Talk IDs

Currently, the client generates its own local talk IDs (session-based) and the gateway generates separate UUIDs. For multi-device, the gateway ID should be the canonical ID everywhere. The client's local ID becomes an internal implementation detail.

#### C. Touch `updatedAt` on all mutations

Ensure every mutation (new message, pin, agent change, job update, metadata edit) bumps `updatedAt` on the talk. This is what powers `?since=` filtering.

---

## 3. Mac TUI Modifications

### 3.1 Changes Required

| File | Change | Effort |
|------|--------|--------|
| `services/talks.ts` | Treat local talk cache as expendable; always reconcile with gateway on startup | Small |
| `tui/app.tsx` | Auto-create gateway talk on save (not on first message) | Small |
| `tui/hooks/useGateway.ts` | Add WebSocket connection for change notifications; re-fetch talks on notification | Medium |
| `tui/components/StatusBar.tsx` | Add sync indicator | Small |

### 3.2 Startup Flow Change

Current:
1. Load local talks from disk
2. Show TUI
3. User manually opens TalksHub to see gateway talks

Proposed:
1. Load local talks from disk (instant, for fast startup)
2. Show TUI
3. Background: `GET /api/talks?since=<lastSyncTime>` to refresh changed talks
4. Background: Connect WebSocket for live notifications
5. Merge: Any gateway talks not in local cache get imported; any local talks not on gateway get created on gateway

### 3.3 What Does NOT Change

- The chat flow (messages go through `POST /api/talks/:id/chat` as today)
- The message rendering (loaded from gateway on talk open)
- Session management (sessions are a local-only concept for terminal history)
- Voice I/O (unchanged)
- Model picker, cost tracking, etc.

---

## 4. iPad App Architecture

### 4.1 Key Principle: No Sync Engine

The iPad app does NOT need a sync engine. It is a **gateway client with local caching**. It calls the same HTTP endpoints the Mac TUI calls. SwiftData provides offline caching, not offline editing.

### 4.2 Technology Stack

| Layer | Technology |
|-------|------------|
| Language | Swift 6 |
| UI Framework | SwiftUI |
| Local Cache | SwiftData |
| Networking | URLSession + WebSocketTask |
| Streaming | AsyncSequence for SSE parsing |
| Minimum OS | iPadOS 17.0+ |

### 4.3 Data Flow

```
                  ┌─────────────────────────────────────────┐
                  │              iPad App                    │
                  │                                         │
                  │  ┌───────────┐     ┌───────────────┐    │
                  │  │ SwiftData │◄────│ GatewayClient │    │
                  │  │  (cache)  │     │   (HTTP/WS)   │    │
                  │  └─────┬─────┘     └───────┬───────┘    │
                  │        │                   │            │
                  │        ▼                   │            │
                  │  ┌───────────┐             │            │
                  │  │  SwiftUI  │             │            │
                  │  │  Views    │             │            │
                  │  └───────────┘             │            │
                  └────────────────────────────┼────────────┘
                                               │
                                    HTTP/SSE + WebSocket
                                               │
                                    ┌──────────▼──────────┐
                                    │  ClawTalkGateway     │
                                    │  (source of truth)   │
                                    └─────────────────────┘
```

### 4.4 GatewayClient

Single class that wraps all gateway communication:

```swift
class GatewayClient: ObservableObject {
    let baseURL: URL
    let authToken: String
    let deviceId: String

    // Talks
    func listTalks(since: Date?) async throws -> [Talk]
    func getTalk(_ id: String) async throws -> TalkDetail
    func createTalk(model: String, title: String?) async throws -> Talk
    func updateTalk(_ id: String, updates: TalkUpdate) async throws
    func deleteTalk(_ id: String) async throws

    // Messages
    func getMessages(_ talkId: String, limit: Int?) async throws -> [Message]
    func sendMessage(_ talkId: String, content: String, model: String?) -> AsyncThrowingStream<SSEChunk, Error>

    // Jobs
    func listJobs(_ talkId: String) async throws -> [Job]
    func createJob(_ talkId: String, schedule: String, prompt: String) async throws -> Job
    func getReports(_ talkId: String, since: Date?) async throws -> [JobReport]

    // Realtime
    func connectSync() -> AsyncStream<SyncEvent>
}
```

No sync engine. No change queue. No conflict resolution. Just HTTP calls.

### 4.5 SwiftData Models

```swift
@Model
class CachedTalk {
    @Attribute(.unique) var id: String      // gateway UUID
    var topicTitle: String
    var objective: String?
    var model: String
    var createdAt: Date
    var updatedAt: Date
    var contextMd: String?

    // Local-only UI state
    var lastOpenedAt: Date?
    var isPinned: Bool = false
}

@Model
class CachedMessage {
    @Attribute(.unique) var id: String
    var talkId: String
    var role: String                        // "user", "assistant", "system"
    var content: String
    var timestamp: Date
    var model: String?
    var agentName: String?
}
```

These are **caches**, not the source of truth. On talk open, the app fetches fresh data from the gateway. SwiftData lets the user browse talks and read old messages while offline, but all writes go through the gateway.

### 4.6 Module Structure

```
ClawTalkPad/
├── App/
│   ├── ClawTalkPadApp.swift
│   └── AppState.swift
├── Gateway/
│   ├── GatewayClient.swift          # All HTTP + WebSocket communication
│   ├── SSEParser.swift              # Server-sent events parser
│   └── Models/                      # Codable gateway response types
│       ├── Talk.swift
│       ├── Message.swift
│       ├── Job.swift
│       └── SyncEvent.swift
├── Cache/
│   ├── CachedTalk.swift             # SwiftData model
│   ├── CachedMessage.swift          # SwiftData model
│   └── CacheManager.swift           # Fetch-and-cache logic
├── UI/
│   ├── RootView.swift               # Split view: sidebar + chat
│   ├── Sidebar/
│   │   ├── TalksSidebar.swift
│   │   └── TalkRow.swift
│   ├── Chat/
│   │   ├── ChatContainer.swift      # Status bar + messages + input
│   │   ├── MessageList.swift
│   │   ├── StreamingMessageView.swift
│   │   └── InputBar.swift
│   ├── Components/
│   │   ├── StatusBar.swift
│   │   ├── ModelPicker.swift
│   │   └── ShortcutBar.swift
│   └── Settings/
│       └── GatewaySettings.swift    # URL, token, pairing
└── Resources/
```

### 4.7 Offline Behavior

| Scenario | Behavior |
|----------|----------|
| Open app, no gateway | Show cached talks and messages (read-only) |
| Try to send message | Show "No gateway connection" error |
| Gateway reconnects | Re-fetch talk list, update cache |
| Background → foreground | `GET /api/talks?since=lastSync`, refresh changed talks |

No offline queue for message sending. Sending a message requires the gateway because the gateway proxies to the LLM provider. There's no value in queuing a message locally when the LLM can't respond until the gateway is reachable anyway.

### 4.8 iPad UI

The original doc's UI design is good. Keep the same layout:
- Split view: talks sidebar (collapsible) + chat area
- Status bar with gateway/sync indicators
- Keyboard-first with shortcut bar
- Terminal-aesthetic message rendering

### 4.9 Pairing Flow

The gateway already has `POST /api/pair` for mobile pairing. The iPad app can use the same flow:

1. User enters gateway URL (or scans QR from Mac TUI)
2. App calls `POST /api/pair` with password
3. Receives `gatewayURL` + `authToken`
4. Stores in Keychain
5. Connected

---

## 5. Conflict Resolution: Why It's Not Needed

The original doc dedicates a full section to conflict resolution with version vectors. Here's why each "conflict" is a non-issue:

| Scenario | Why It Can't Happen / Simple Resolution |
|----------|---------------------------------------|
| Simultaneous message send from 2 devices | Can't happen -- LLM response goes to the device that sent the message. Other device sees it on next fetch. |
| Title edited on 2 devices at once | Single user. Last write wins. No merge needed. |
| Talk deleted on A, message sent on B | Delete is a deliberate action. If user deleted on one device, that's intentional. Block sends to deleted talks. |
| Model switched on 2 devices | Single user. Last write wins. Per-message model is preserved anyway. |
| Offline edits on both devices | Messages can't be sent offline (need LLM). Only metadata edits could conflict, and last-write-wins is fine for a single user. |

**The only "conflict" that matters:** Two devices with stale caches opening the same talk. Solution: always fetch from gateway on talk open. Already implemented.

---

## 6. What NOT to Build

| Feature from Original Doc | Why Skip It |
|--------------------------|-------------|
| Version vectors | Single user, last-write-wins is sufficient |
| Change log with 30-day retention | Just re-fetch talks; no incremental replay needed |
| `POST /api/sync/push` | Use existing CRUD endpoints directly |
| SyncEngine abstraction | Gateway client + cache is simpler and equivalent |
| Conflict resolution UI | No real conflicts in single-user system |
| Offline message queue | Can't send messages without LLM anyway |
| `sync.json` local state file | `lastSyncTime` can live in UserDefaults / config |

---

## 7. Implementation Phases

### Phase 1: Gateway Prep (2-3 days)

**Goal:** Make the gateway ready for multi-device clients.

- [ ] Add `?since=` timestamp filtering to `GET /api/talks`
- [ ] Ensure all mutations bump `updatedAt` on the parent talk
- [ ] Add `WS /api/sync` notification channel (simple event broadcast)
- [ ] Auto-create gateway talk on `/save` (not on first message)
- [ ] Add `deviceId` header tracking (optional, for status bar)

**Test:** Two curl sessions can observe each other's changes via WebSocket notifications.

### Phase 2: Mac TUI Sync Awareness (2-3 days)

**Goal:** Mac TUI stays in sync with gateway without user intervention.

- [ ] On startup, background-fetch `GET /api/talks?since=lastSyncTime`
- [ ] Connect to `WS /api/sync` for live notifications
- [ ] On `talk_updated` notification, re-import talk metadata
- [ ] On `message_added` notification for active talk, append message to chat view
- [ ] Add sync indicator to status bar
- [ ] Auto-create gateway talk on save

**Test:** Open Talk on Mac, send a message via curl to same Talk. Mac shows the new message within seconds.

### Phase 3: iPad Foundation (2-3 weeks)

**Goal:** Basic iPad app that connects to gateway, shows talks, sends messages.

- [ ] Xcode project + SwiftData setup
- [ ] `GatewayClient` with auth, talk list, messages, chat streaming
- [ ] `SSEParser` for streaming responses
- [ ] Pairing flow (enter URL + password, or scan QR)
- [ ] Talks sidebar with search
- [ ] Chat container with message rendering
- [ ] Streaming message display
- [ ] Input bar with `>` prompt
- [ ] Basic keyboard shortcuts (Cmd+N, Cmd+T, etc.)
- [ ] SwiftData caching for offline reading

**Test:** iPad can browse talks, read messages, and have a conversation.

### Phase 4: iPad Feature Parity (1-2 weeks)

**Goal:** iPad matches Mac TUI functionality.

- [ ] WebSocket sync connection (live updates from Mac)
- [ ] Model picker
- [ ] Job management (list, create, view reports)
- [ ] Agent configuration
- [ ] Pin/unpin messages
- [ ] Status bar with cost tracking
- [ ] Voice input (if desired)
- [ ] Full keyboard shortcut set

**Test:** Full workflow on iPad. Changes made on Mac appear on iPad and vice versa.

---

## 8. Architecture Comparison

| Aspect | Original Proposal | This Counter-Proposal |
|--------|------------------|----------------------|
| New gateway endpoints | 4 (sync status, changes, push, WebSocket) | 1-2 (since filter, WebSocket notifications) |
| New client abstractions | SyncEngine, SyncStore, WebSocketSync | None (extend existing GatewayClient) |
| Conflict resolution | Version vectors, merge strategies, resolution UI | Last-write-wins (single user) |
| Offline support | Full offline queue with change replay | Read-only cache, no offline writes |
| Data flow | Bidirectional sync with change log | Gateway is source of truth, clients are caches |
| Change tracking | Per-field change types, StoredChange entities | `updatedAt` timestamp on talks |
| Complexity | High (sync is notoriously hard) | Low (HTTP CRUD + WebSocket notifications) |
| Time to multi-device | ~4 weeks before iPad work starts | ~1 week before iPad work starts |

---

## 9. Open Questions (Reduced)

The original doc's 8 open questions reduce to 3:

1. **ClawTalkMobile overlap:** There's already an iOS client (ClawTalkMobile). Is ClawTalkPad a separate app or should it extend/replace ClawTalkMobile? If ClawTalkMobile already has a gateway client, we can reuse its networking layer.

2. **Message history depth:** When opening a talk on iPad for the first time, fetch all messages or last N? Recommend: fetch last 100, load more on scroll. The gateway `GET /api/talks/:id/messages` endpoint already supports `limit` and `before` parameters (or should).

3. **Push notifications:** When the iPad app is backgrounded and a job report comes in, should it push-notify? This would require an APNs integration on the gateway side. Nice-to-have, not required for v1.

---

*Document Version: 1.0*
*Last Updated: 2026-02-12*
*Author: Claude + Joseph*
