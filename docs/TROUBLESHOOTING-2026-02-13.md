# ClawTalk Connection Issues - Troubleshooting Log

**Date:** 2026-02-13  
**Summary:** Multiple issues discovered after OpenClaw 2026.2.9 update causing ClawTalk to fail connecting from MacBook to gateway.

---

## Problem 1: Gateway Binding to localhost instead of Tailscale IP

**Status:** ⚠️ NOT RESOLVED - Root cause identified

### Symptoms
- ClawTalk shows: `GW:○` (hollow/red = disconnected)
- Error: `ECONNREFUSED 100.69.69.108:18789`
- Gateway status shows: `proxy started on 127.0.0.1:18789`

### Root Cause
OpenClaw 2026.2.9 update broke the `bind` functionality. The gateway ignores:
- Config: `"gateway": {"bind": "tailnet"}`
- CLI flag: `--bind 0.0.0.0`
- CLI flag: `--bind 100.69.69.108`

Always binds to `127.0.0.1` regardless of configuration.

### Evidence
```bash
# Config shows bind: tailnet
cat ~/.openclaw/openclaw.json | grep -A5 '"gateway"'
{
  "gateway": {
    "mode": "local",  # ← Was likely reset during update
    "bind": "tailnet",
    ...
  }
}

# But gateway starts on 127.0.0.1
openclaw gateway start --bind 0.0.0.0 --port 18789
[plugins] ClawTalk: proxy started on 127.0.0.1:18789  # ← WRONG!
```

### Failed Fixes Attempted
1. ✅ Changed `proxyPort` from 18794 → 18789
2. ❌ `--bind 0.0.0.0` flag (ignored)
3. ❌ `--bind 100.69.69.108` flag (ignored)
4. ❌ Config `"bind": "tailnet"` (ignored)
5. ❌ Config `"mode": "local"` → `"tailnet"` (not attempted yet)

### Potential Fix
Change gateway mode from `"local"` to `"tailnet"` in config:
```bash
# On gateway server (Alienware)
sed -i 's/"mode": "local"/"mode": "tailnet"/' ~/.openclaw/openclaw.json
openclaw gateway restart
```

Or check if OpenClaw has a regression/bug report for 2026.2.9.

---

## Problem 2: ClawTalk IPv6/Tailscale DNS Issue (FIXED)

**Status:** ✅ RESOLVED

### Symptoms
- Node.js fetch fails with `ECONNREFUSED` to Tailscale IP
- curl works fine to same IP
- `nc` fails but curl succeeds

### Root Cause
Node.js 25+ tries IPv6 first for all connections. Tailscale IPs are IPv4, causing connection failures.

### Fix Applied
Added DNS resolution order fix in `src/cli.ts`:
```typescript
import { setDefaultResultOrder } from 'dns';
setDefaultResultOrder('ipv4first');
```

This forces Node.js to try IPv4 before IPv6.

---

## Problem 3: Config Auto-Overwrite (FIXED)

**Status:** ✅ RESOLVED

### Symptoms
- Config kept changing from remote gateway IP to `127.0.0.1`
- Running `clawtalk --gateway http://127.0.0.1:18789` would persist that to config

### Root Cause
`cli.ts` had code that auto-saved CLI `--gateway` flag to config file:
```typescript
if (opts.gateway || opts.token) {
  const existing = loadConfig();
  if (opts.gateway) existing.gatewayUrl = opts.gateway;
  saveConfig(existing);  // ← Problem
}
```

### Fix Applied
Removed auto-save behavior. CLI flags are now temporary.

---

## Problem 4: Gateway Port Mismatch (FIXED)

**Status:** ✅ RESOLVED

### Symptoms
- Gateway showing `port 18794 busy, retrying`
- ClawTalk config expected port 18789

### Root Cause
`~/.openclaw/openclaw.json` had `"proxyPort": 18794` instead of 18789.

### Fix Applied
```bash
sed -i 's/"proxyPort": 18794/"proxyPort": 18789/' ~/.openclaw/openclaw.json
```

---

## Problem 5: ClawTalk Not Using IPv4-First DNS (FIXED)

**Status:** ✅ RESOLVED

### Symptoms
- ClawTalk installed globally didn't have the DNS fix
- Running `clawtalk` failed but `npm start` worked

### Root Cause
The `npm link` or global install wasn't updated with the DNS fix.

### Fix Applied
Rebuilt and re-linked:
```bash
npm run build
npm link --force
```

---

## Current Status

**Gateway Server (Alienware):**
- ✅ OpenClaw 2026.2.9 running
- ✅ Port 18789 configured
- ❌ Still binding to 127.0.0.1 (needs fix)

**ClawTalk (MacBook):**
- ✅ DNS fix applied
- ✅ IPv4-first resolution working
- ✅ Config correct (points to 100.69.69.108:18789)
- ❌ Can't connect because gateway on 127.0.0.1

---

## Next Steps to Fix

### Option 1: Fix Gateway Bind (Preferred)
Try changing gateway mode to "tailnet":
```bash
# On Alienware
openclaw gateway stop
sed -i 's/"mode": "local"/"mode": "tailnet"/' ~/.openclaw/openclaw.json
openclaw gateway start
# Verify: should show "proxy started on 100.69.69.108:18789"
```

### Option 2: Downgrade OpenClaw
If 2026.2.9 has a regression, downgrade to previous version:
```bash
npm install -g openclaw@2026.1.27-beta.1
```

### Option 3: Use SSH Tunnel
Workaround - tunnel through SSH:
```bash
# On MacBook
ssh -L 18789:localhost:18789 alienware-tailscale-ip
# Then use clawtalk with --gateway http://127.0.0.1:18789
```

### Option 4: Check OpenClaw Environment Variables
Try different env vars that might control binding:
```bash
OPENCLAW_BIND=0.0.0.0 openclaw gateway start
OPENCLAW_HOST=100.69.69.108 openclaw gateway start
OPENCLAW_GATEWAY_BIND=tailnet openclaw gateway start
```

---

## Configuration Files Reference

### ClawTalk Config (MacBook)
```bash
~/.clawtalk/config.json
```
Should contain:
```json
{
  "gatewayUrl": "http://100.69.69.108:18789",
  "gatewayToken": "..."
}
```

### OpenClaw Config (Alienware)
```bash
~/.openclaw/openclaw.json
```
Key sections:
```json
{
  "gateway": {
    "mode": "local",  // Try changing to "tailnet"
    "bind": "tailnet",
    "auth": { ... }
  },
  "plugins": {
    "entries": {
      "clawtalk": {
        "config": {
          "proxyPort": 18789
        }
      }
    }
  }
}
```

---

## Testing Commands

From MacBook:
```bash
# Test basic connectivity
ping 100.69.69.108

# Test if gateway responds
curl http://100.69.69.108:18789/health

# Test with Node.js (should work with our fix)
node -e "fetch('http://100.69.69.108:18789/health').then(r => console.log(r.status))"
```

From Alienware:
```bash
# Check what's actually listening
sudo ss -tlnp | grep 18789

# Should show: 100.69.69.108:18789 or 0.0.0.0:18789
# Currently shows: 127.0.0.1:18789
```

---

## Related Changes Made Today

1. **ClawTalk fixes committed:**
   - `ecd1d74` - fix: imported gateway talks should be marked as saved
   - `946e151` - fix: don't auto-save CLI --gateway flag to config
   - `294cdee` - fix: set DNS to IPv4-first in code for Tailscale compatibility
   - `29dd260` - docs: add troubleshooting section for common connection issues

2. **Config changes on Alienware:**
   - Fixed `proxyPort` from 18794 → 18789
   - Attempted bind fixes (unsuccessful)

---

## Questions to Investigate

1. Did OpenClaw 2026.2.9 change the gateway binding behavior?
2. Is `"mode": "tailnet"` vs `"mode": "local"` the key difference?
3. Are there new undocumented environment variables for binding?
4. Did the systemd service configuration change?

---

## Kimi CLI Installation (for direct gateway debugging)

To install Kimi CLI on the gateway server for easier debugging:

```bash
# On Alienware (gateway server)
curl -fsSL https://github.com/jokim1/kimi-cli/releases/latest/download/install.sh | bash
# Or via npm if available
npm install -g @jokim1/kimi-cli

# Then configure
kimi config --api-key YOUR_API_KEY
```

This would allow me to directly inspect and fix the gateway configuration.
