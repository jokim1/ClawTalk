# Uncommitted Changes — 2026-02-16

## Modified Files

### `src/services/chat.ts` (+31/-2)

Expanded inline return types for two gateway methods to include `directives` and `platformBindings` fields, and reformatted the type signatures from single-line to multi-line for readability.

**`getGatewayTalk()`** (line ~420): Added `directives?: Directive[]` and `platformBindings?: PlatformBinding[]` to the return type.

**`listGatewayTalks()`** (line ~445): Same two fields added, plus reformatted the return type from a single long line to multi-line.

### `package-lock.json` (+7)

Added `"peer": true` annotations to 7 existing dependency entries: `@babel/core`, `@types/react`, `browserslist`, `ink`, `jest`, `react`, and `typescript`. This marks them as peer dependencies rather than direct dependencies — likely a side effect of an `npm install` or lockfile regeneration.

---

## Untracked Files (New)

### `docs/ClawTalkPad-Architecture.md`

Full architecture document for extending ClawTalk to iPad with cross-device sync. Covers:
- System overview (current vs target state with diagrams)
- Sync architecture with version vectors, change types, and sync engine design
- Gateway API extensions (4 new endpoints: sync status, changes, push, WebSocket)
- Mac TUI modifications (new sync files, status bar indicator, startup flow)
- iPad app architecture (SwiftUI + SwiftData, module structure, keyboard shortcuts)
- Data models (Talk, Message, Configuration schemas)
- Conflict resolution strategy (version vectors, merge strategies)
- 6-phase implementation plan (~12 weeks)
- Open questions (8 items)

### `docs/ClawTalkPad-CounterProposal.md`

Counter-proposal to the above architecture arguing for a simpler "gateway-first" approach. Key thesis: since ClawTalk is single-user, the full sync engine with version vectors and CRDTs is unnecessary. Instead:
- Gateway is already the source of truth — clients are just caches
- Replace 4 sync endpoints with `?since=` timestamp filtering + lightweight WebSocket notifications
- No sync engine, no change queue, no conflict resolution — just HTTP CRUD
- iPad app uses SwiftData as a read cache, not an offline editing store
- Reduces gateway prep from ~4 weeks to ~1 week
- 4-phase implementation plan (shorter overall)

### `docs/TROUBLESHOOTING-2026-02-13.md`

Troubleshooting log for connection issues after OpenClaw 2026.2.9 update. Documents 5 problems:
1. **Gateway binding to localhost** (unresolved) — OpenClaw ignores `bind` config, always binds to 127.0.0.1
2. **IPv6/Tailscale DNS issue** (fixed) — Added `setDefaultResultOrder('ipv4first')` in cli.ts
3. **Config auto-overwrite** (fixed) — Removed auto-save of CLI `--gateway` flag
4. **Gateway port mismatch** (fixed) — Changed proxyPort from 18794 to 18789
5. **Global install missing DNS fix** (fixed) — Rebuilt and re-linked

Includes next steps, configuration reference, and testing commands.

---

## Note

Local branch is 1 commit behind `origin/main`.
