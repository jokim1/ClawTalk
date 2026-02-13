# ClawTalk Connection Issues - Complete History

**Date:** 2026-02-13  
**Status:** Resolved
**Affected:** ClawTalk client on macOS Sequoia (26.2) connecting to OpenClaw gateway via Tailscale

---

## Executive Summary

Multiple interconnected issues were discovered after the OpenClaw 2026.2.9 update, causing ClawTalk to fail connecting from a MacBook to the OpenClaw gateway over Tailscale VPN. The root causes were:

1. **Port conflict** - ClawTalk plugin's internal proxy using same port as gateway
2. **macOS interface binding** - Node.js 25 binds to wrong interface for Tailscale IPs

All issues resolved. The fetch connector bug is fixed by replacing Node.js 25's built-in undici dispatcher with the npm undici package's connector.

---

## Initial Symptoms (2026-02-13)

```
Health check failed: TypeError: fetch failed
[cause]: Error: connect ECONNREFUSED 100.69.69.108:18789
```

- `curl http://100.69.69.108:18789/health` → **Works** (HTTP 200)
- `clawtalk` → **Fails** (ECONNREFUSED)
- Gateway status showed: `Runtime: stopped` or restarting loop

---

## Problem 1: Gateway Not Running

### Discovery
Gateway was in a restart loop due to port conflicts.

### Evidence
```
Gateway failed to start: gateway already running (pid 2830654)
Port 18789 is already in use.
pid 2830654 k1min8r: openclaw (127.0.0.1:18789)
```

### Root Cause
The ClawTalk plugin has an internal rate-limit proxy that was configured to use the **same port** as the main gateway:

```json
// ~/.openclaw/openclaw.json (BROKEN)
{
  "plugins": {
    "entries": {
      "clawtalk": {
        "config": {
          "proxyPort": 18789  // ← CONFLICT with gateway port!
        }
      }
    }
  }
}
```

The proxy (`src/proxy.ts` line 165) hardcodes binding to `127.0.0.1`:
```typescript
server.listen(port, '127.0.0.1', () => {
  logger.info(`ClawTalk: proxy started on 127.0.0.1:${port}`);
});
```

### Fix Applied
Changed `proxyPort` from `18789` to `18793`:

```bash
jq '.plugins.entries.clawtalk.config.proxyPort = 18793' ~/.openclaw/openclaw.json
```

### Verification
```bash
# Before: Port 18789 used twice (conflict)
# After:
LISTEN 0 511 127.0.0.1:18793  # ← ClawTalk proxy (internal)
LISTEN 0 511 100.69.69.108:18789  # ← Gateway (external)
```

---

## Problem 2: DNS IPv6/IPv4 Resolution (Node.js 25+)

### Discovery
Node.js 25 defaults to IPv6-first DNS resolution, but Tailscale IPs are IPv4-only.

### Evidence
```
Node.js tries IPv6 first → fails → may not fall back to IPv4
```

### Fix Applied
Added DNS resolution order fix in `src/cli.ts`:

```typescript
import { setDefaultResultOrder } from 'dns';
setDefaultResultOrder('ipv4first');
```

### Status
✅ **Fixed in code** - Already present in pulled code

---

## Problem 3: Config Auto-Save (Fixed)

### Discovery
CLI `--gateway` flag was persisting to config file unexpectedly.

### Fix Applied
Removed auto-save logic in `src/cli.ts`.

### Status
✅ **Fixed in code**

---

## Problem 4: macOS Interface Binding (FIXED)

### Discovery
After fixing the port conflict, curl worked but Node.js still failed.

### Evidence
```bash
# On MacBook
$ curl http://100.69.69.108:18789/health
→ HTTP 200 OK ✅

$ node -e "fetch('http://100.69.69.108:18789/health')"
→ ECONNREFUSED ❌

$ node -e "http.get({hostname:'100.69.69.108',port:18789,localAddress:'100.92.199.30'}...)"
→ HTTP 200 OK ✅ (with explicit localAddress)
```

### Root Cause Analysis

**Network routing on macOS:**
```
MacBook routing table:
100.69.69.108/32 → link#24 (utun4 - Tailscale interface)

But Node.js 25 binds to:
Default interface (en0 Wi-Fi) → tries to reach 100.69.69.108
→ Kernel routes via loopback instead of utun4
→ Connection refused
```

**Why curl works:**
- curl uses different socket binding behavior
- curl may use `connect()` without explicit `bind()`
- Node.js undici explicitly binds to default interface

**Why explicit localAddress fixes it:**
- Forces Node.js to bind to utun4 (Tailscale)
- Outbound packets then correctly route through Tailscale

### Attempted Fix 1: undici Global Dispatcher (FAILED)

Tried to configure undici's global dispatcher:

```typescript
import('undici').then(({ Agent, setGlobalDispatcher }) => {
  const agent = new Agent({
    connect: (options) => {
      if (isTailscaleIp(options.hostname)) {
        return { localAddress: localTailscaleIp };
      }
      return {};
    },
  });
  setGlobalDispatcher(agent);
});
```

**Failure:** Node.js 25 doesn't expose undici as a package:
```
undici error: Cannot find package 'undici' imported from...
```

undici is built into Node.js 25+ but not externally importable.

### Attempted Fix 2: http Module Patching (NOT IMPLEMENTED)

Alternative approach: Patch Node.js's built-in `http` module:

```typescript
import http from 'http';
const originalRequest = http.request;
http.request = function(options, callback) {
  if (options.hostname?.startsWith('100.')) {
    options.localAddress = getLocalTailscaleIp();
  }
  return originalRequest.call(this, options, callback);
};
```

**Not implemented** - Would require significant refactoring of all fetch calls in ClawTalk.

### Attempted Fix 3: net.connect Patching (FAILED)

Patched `net.connect` to inject `localAddress` for Tailscale IP destinations. This did NOT work because Node.js 25's built-in undici uses internal TCP bindings that bypass the public `net.connect`.

### Fix Applied: undici Global Dispatcher Replacement

The real root cause is that Node.js 25's **built-in** undici connector has a bug connecting to Tailscale IPs. The **npm** undici package's `buildConnector` does not have this bug. Replacing the global dispatcher with one from the npm package fixes all `fetch()` calls:

```typescript
const { Agent, setGlobalDispatcher, buildConnector } = require('undici');
const connector = buildConnector({});
setGlobalDispatcher(new Agent({
  connect: (opts, cb) => connector(opts, cb),
}));
```

**Key discovery:** This is NOT a macOS-specific issue or an interface binding issue. The bug exists on Linux too. Both `curl` and `http.get` work fine, but `fetch()` (via the built-in undici) fails with ECONNREFUSED for Tailscale-bound servers.

**Why this works:**
- `setGlobalDispatcher` sets `globalThis[Symbol.for('undici.globalDispatcher.1')]`
- Node.js's built-in `fetch()` reads from this same symbol
- The npm undici's `buildConnector({})` creates a working connector
- No `localAddress` injection needed — the npm connector handles routing correctly

### Status
✅ **Fixed in code** — `src/services/chat.ts` applies fix at module load time, requires `undici` npm dependency

---

## Working Solutions

### Solution 1: Manual Workaround (CURRENT)

Force Node.js to use the correct local interface by specifying the gateway URL with your local Tailscale IP:

```bash
# Get your MacBook's Tailscale IP
MY_TS_IP=$(tailscale ip -4)

# Run clawtalk with explicit binding
clawtalk --gateway "http://$MY_TS_IP:18789" --token $OPENCLAW_GATEWAY_TOKEN
```

**Why this works:** When the local address and remote address are in the same subnet (both 100.x.x.x), Node.js correctly binds to the Tailscale interface.

### Solution 2: Use SSH Tunnel

Bypass Tailscale routing entirely:

```bash
# On MacBook
ssh -L 18789:localhost:18789 alienware-tailscale-ip -N

# Then use localhost
clawtalk --gateway http://127.0.0.1:18789
```

### Solution 3: Downgrade Node.js (Not Recommended)

Earlier Node.js versions may have different binding behavior:

```bash
# Test with Node.js 20 or 22
nvm use 22
clawtalk
```

---

## Configuration Summary

### Alienware (Gateway Server)

**File: `~/.openclaw/openclaw.json`**
```json
{
  "gateway": {
    "mode": "local",
    "bind": "tailnet",
    "auth": {
      "mode": "token",
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true }
      }
    }
  },
  "plugins": {
    "entries": {
      "clawtalk": {
        "enabled": true,
        "config": {
          "proxyPort": 18793,
          "pairPassword": "...",
          "providers": { ... }
        }
      }
    }
  }
}
```

**File: `~/.config/systemd/user/openclaw-gateway.service`**
```ini
[Unit]
Description=OpenClaw Gateway

[Service]
ExecStart="/usr/bin/node" "/usr/lib/node_modules/openclaw/dist/index.js" gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

### MacBook (Client)

**File: `~/.clawtalk/config.json`**
```json
{
  "gatewayUrl": "http://100.69.69.108:18789",
  "gatewayToken": "your-token-here"
}
```

**Environment:**
```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
```

---

## Current Status

| Component | Status |
|-----------|--------|
| Gateway binding to 100.69.69.108:18789 | ✅ Working |
| Tailscale VPN connectivity | ✅ Working |
| curl from MacBook | ✅ Working |
| Node.js fetch without localAddress | ✅ Fixed (undici dispatcher replacement) |
| Node.js fetch with localAddress | ✅ Working |
| ClawTalk with manual workaround | ✅ Working |
| ClawTalk out-of-the-box | ✅ Fixed (undici dispatcher replacement) |

---

## Technical Details

### Affected Versions
- **macOS:** 26.2 (15.2 Sequoia) - confirmed
- **Node.js:** 25.2.1 - confirmed affected
- **OpenClaw:** 2026.2.9
- **ClawTalk:** Latest main branch

### Why This Happens

1. **macOS routing quirk:** When connecting to a local Tailscale IP (100.x.x.x), the kernel may route through `lo0` (loopback) instead of `utun4` (Tailscale)

2. **Node.js 25 behavior:** undici (Node's fetch implementation) explicitly binds to the default network interface before connecting

3. **curl behavior:** May not explicitly bind, allowing kernel to choose based on routing table

### Packet Flow (Broken)
```
Node.js fetch to 100.69.69.108
  ↓
Binds to en0 (Wi-Fi) default interface
  ↓
Kernel routes 100.69.69.108 via lo0 (loopback)
  ↓
SYN sent via lo0 to 100.69.69.108:18789
  ↓
Gateway listening on tailscale0, not lo0
  ↓
Connection refused (ECONNREFUSED)
```

### Packet Flow (With Fix)
```
Node.js fetch to 100.69.69.108
  ↓
Binds to utun4 (Tailscale) via localAddress
  ↓
SYN sent via utun4 to 100.69.69.108:18789
  ↓
Gateway listening on tailscale0
  ↓
Connection established ✅
```

---

## Recommendations

### For Users (Immediate)

Use the manual workaround:
```bash
clawtalk --gateway "http://$(tailscale ip -4):18789" --token $OPENCLAW_GATEWAY_TOKEN
```

### For Developers (Long-term)

1. **Option A:** Patch Node.js http module at startup (requires refactoring)
2. **Option B:** Use a custom fetch wrapper that sets localAddress for Tailscale IPs
3. **Option C:** Wait for Node.js to fix interface binding behavior
4. **Option D:** Document the limitation and require manual workaround for macOS + Node 25

---

## Related Files

- `src/services/chat.ts` - Attempted undici fix (not working)
- `src/cli.ts` - DNS IPv4-first fix (working)
- `docs/TROUBLESHOOTING-GATEWAY-BIND.md` - Server-side troubleshooting
- `scripts/diagnose-gateway.sh` - Diagnostic script

---

## Timeline

| Time | Event |
|------|-------|
| Morning | OpenClaw 2026.2.9 update applied |
| +1h | ClawTalk connection failures reported |
| +2h | Identified port conflict (proxyPort: 18789) |
| +3h | Fixed proxyPort to 18793 |
| +4h | Identified macOS interface binding issue |
| +5h | Attempted undici fix (failed - not importable) |
| +6h | Confirmed manual workaround works |
| Now | Documented all issues and solutions |

---

## References

- [Tailscale CGNAT range](https://tailscale.com/kb/1015/100.x-addresses): 100.64.0.0/10
- [Node.js 25 undici](https://nodejs.org/api/globals.html#fetch): Built-in fetch implementation
- [macOS utun interfaces](https://developer.apple.com/documentation/kernel/if_utun_name): Tunnel interfaces
