# Root Cause Analysis: ClawTalk Connection Issues

**Date:** 2026-02-13  
**Status:** Client-side fixes applied, server-side fix required

---

## Executive Summary

Multiple issues were discovered after the OpenClaw 2026.2.9 update. The **primary blocking issue** is that the OpenClaw gateway is ignoring all bind configuration and always binding to `127.0.0.1`, preventing remote connections from the MacBook.

---

## First Principles Analysis

### What is `ECONNREFUSED`?

`ECONNREFUSED` (Connection Refused) at the TCP level means:

```
Client                    Server (Alienware)
  |                            |
  |---- SYN packet ----------->|  "I want to connect to 100.69.69.108:18789"
  |                            |
  |<--- RST packet ------------|  "No process is listening on that port/IP"
  |                            |
```

**Key insight:** The packet reached the server (network path works), but nothing is accepting connections on that address.

### Why 127.0.0.1 vs 100.69.69.108 Matters

When a process binds to `127.0.0.1`:
- The kernel only routes packets with **destination 127.0.0.1** to that socket
- Packets destined for `100.69.69.108` are **rejected at the network layer**
- This is a security feature for localhost-only services

```
┌─────────────────────────────────────────────────────────────────┐
│                     Network Stack                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Incoming Packet to 100.69.69.108:18789                         │
│         │                                                       │
│         ▼                                                       │
│  ┌─────────────┐    No match      ┌─────────────────┐          │
│  │ 127.0.0.1   │◄─────────────────┤ Reject with RST │          │
│  │ :18789      │   (wrong IP)     │ (ECONNREFUSED)  │          │
│  └─────────────┘                  └─────────────────┘          │
│        ▲                                                        │
│        │ Only matches 127.0.0.1                                  │
│        │                                                        │
│  Local loopback traffic only                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Issue Breakdown

### ✅ FIXED: ClawTalk Client Issues

#### Fix 1: DNS IPv4-First Resolution

**Problem:** Node.js 25+ defaults to IPv6 DNS resolution. Tailscale IPs are IPv4.

**Fix Applied:**
```typescript
// src/cli.ts
import { setDefaultResultOrder } from 'dns';
setDefaultResultOrder('ipv4first');
```

**Verification:**
```bash
node -e "fetch('http://100.69.69.108:18789/health').then(r => console.log(r.status))"
```

#### Fix 2: Remove Config Auto-Save

**Problem:** CLI flags were being persisted to config unexpectedly.

**Fix Applied:** Removed auto-save logic in `src/cli.ts`.

---

### ❌ NOT FIXED: OpenClaw Gateway Binding Issue

**The Core Problem:**

| Configuration Attempted | Result |
|------------------------|--------|
| Config `"bind": "tailnet"` | ❌ Ignored |
| CLI `--bind 0.0.0.0` | ❌ Ignored |
| CLI `--bind 100.69.69.108` | ❌ Ignored |
| Default behavior | ❌ Always 127.0.0.1 |

**Root Cause Hypothesis:**

OpenClaw 2026.2.9 changed the precedence logic:

```
┌─────────────────────────────────────────────────────────────────┐
│  Gateway Startup Logic (2026.2.9)                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  config.mode ───────────┐                                       │
│                         │                                       │
│                         ▼                                       │
│              ┌─────────────────┐                                │
│              │  mode == "local"? │                               │
│              └─────────────────┘                                │
│                   │          │                                  │
│              YES ▼          ▼ NO                               │
│          ┌──────────┐  ┌──────────────────┐                  │
│          │ FORCE    │  │ Use bind setting │                  │
│          │ 127.0.0.1│  │ (config or CLI)  │                  │
│          │          │  │                  │                  │
│          │ Ignores  │  │ Respects         │                  │
│          │ --bind   │  │ --bind flag      │                  │
│          └──────────┘  └──────────────────┘                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Evidence:**
1. `--bind 0.0.0.0` should work (binds to all interfaces) but doesn't
2. `--bind <specific-ip>` should work but doesn't
3. Only `127.0.0.1` works, suggesting it's hardcoded for `mode: "local"`

---

## Solution: Server-Side Fix (Alienware)

### Recommended Fix: Change Mode to "tailnet"

```bash
# 1. Stop the gateway
openclaw gateway stop

# 2. Edit config
nano ~/.openclaw/openclaw.json

# 3. Change mode from "local" to "tailnet":
{
  "gateway": {
    "mode": "tailnet",    # ← Change this
    "bind": "tailnet",    # ← Keep this
    "auth": { ... }
  }
}

# 4. Start gateway
openclaw gateway start

# 5. Verify - should show Tailscale IP, NOT 127.0.0.1
# Expected: "proxy started on 100.69.69.108:18789"
```

### Alternative Fixes

#### Option 2: Downgrade OpenClaw
```bash
npm install -g openclaw@2026.1.27-beta.1
openclaw gateway restart
```

#### Option 3: SSH Tunnel Workaround
```bash
# On MacBook
ssh -L 18789:localhost:18789 alienware-tailscale-ip -N

# Use localhost instead
clawtalk --gateway http://127.0.0.1:18789
```

---

## Verification Checklist

### On Gateway Server (Alienware):

```bash
# Check what's listening
sudo ss -tlnp | grep 18789

# ✅ GOOD: Shows 100.69.69.108:18789 or 0.0.0.0:18789
# ❌ BAD:  Shows 127.0.0.1:18789

# Test from Tailscale IP
curl http://100.69.69.108:18789/health
```

### On Client (MacBook):

```bash
# Ping test
ping 100.69.69.108

# Gateway health check
curl http://100.69.69.108:18789/health

# Run ClawTalk (with latest fixes)
npm run build
npm link --force
clawtalk
```

---

## Summary of Changes Made Today

### ClawTalk Client Fixes:

1. **DNS IPv4-First** (`src/cli.ts`)
   - Added `setDefaultResultOrder('ipv4first')` for Node.js 25+ compatibility

2. **Removed Auto-Save** (`src/cli.ts`)
   - CLI flags no longer persist to config file
   - Use `clawtalk config --gateway <url>` for persistent changes

### Action Required (You):

1. **On Alienware (Gateway):**
   ```bash
   openclaw gateway stop
   sed -i 's/"mode": "local"/"mode": "tailnet"/' ~/.openclaw/openclaw.json
   openclaw gateway start
   # Verify: should show 100.69.69.108:18789
   ```

2. **On MacBook (Client):**
   ```bash
   cd ~/projects/clawtalk
   npm run build
   npm link --force
   clawtalk
   ```

---

## If Nothing Works

### Report to OpenClaw

```
URL: https://github.com/jokim1/openclaw/issues

Title: [Regression 2026.2.9] Gateway ignores --bind flag, always binds to 127.0.0.1

Body:
After updating to OpenClaw 2026.2.9, the gateway plugin ignores all bind 
configurations and always binds to 127.0.0.1:

- Config "gateway.bind": "tailnet" is ignored
- CLI flag --bind 0.0.0.0 is ignored  
- CLI flag --bind <specific-ip> is ignored

Expected: Gateway binds to specified address
Actual: Always binds to 127.0.0.1

Workaround: Changing "gateway.mode" from "local" to "tailnet" may fix it.
```

---

## Technical Deep Dive

### Why Did 2026.2.9 Break This?

Most likely explanations:

1. **Security Hardening**: The update may have intentionally forced `127.0.0.1` for `mode: "local"` as a security measure, requiring users to explicitly opt into remote access via `mode: "tailnet"`.

2. **Config Schema Change**: The `bind` setting may have been deprecated or moved in the config schema.

3. **Regression**: Simply a bug where the bind configuration is being overridden by a hardcoded default.

### The Fix Pattern

```javascript
// Hypothetical OpenClaw gateway startup code (BROKEN):
function startGateway(config, cliArgs) {
  let bindAddress = '127.0.0.1';  // Hardcoded default
  
  if (config.mode === 'local') {
    bindAddress = '127.0.0.1';    // ← BUG: Ignores config/CLI
  } else {
    bindAddress = config.bind || cliArgs.bind || '0.0.0.0';
  }
  
  server.listen(18789, bindAddress);
}

// Fixed version:
function startGateway(config, cliArgs) {
  // CLI args should override config
  const bindAddress = cliArgs.bind || config.bind || 
                      (config.mode === 'local' ? '127.0.0.1' : '0.0.0.0');
  
  server.listen(18789, bindAddress);
}
```

---

## Conclusion

The connection issue is caused by the OpenClaw gateway ignoring bind configuration in version 2026.2.9. The ClawTalk client has been fixed (DNS resolution, config handling). 

**Next step:** Apply the server-side fix by changing `gateway.mode` from `"local"` to `"tailnet"` on the Alienware machine.
