# Gateway Binding Fix Guide

## Problem

After OpenClaw 2026.2.9 update, the gateway ignores `--bind` flags and config,
always binding to `127.0.0.1` instead of the Tailscale IP.

## Root Cause

OpenClaw 2026.2.9 likely changed the precedence:
- `mode: "local"` now **forces** `127.0.0.1` binding (ignores `bind` setting)
- `mode: "tailnet"` respects the `bind` setting

## Fix Options (Try in order)

### Option 1: Change Mode to "tailnet" (Recommended)

```bash
# On Alienware (gateway server)
openclaw gateway stop

# Edit the config
nano ~/.openclaw/openclaw.json

# Change:
{
  "gateway": {
    "mode": "tailnet",  # ← Change from "local" to "tailnet"
    "bind": "tailnet",  # ← Keep this
    ...
  }
}

# Start gateway
openclaw gateway start

# Verify (should show Tailscale IP, not 127.0.0.1)
# Expected: "proxy started on 100.69.69.108:18789"
```

### Option 2: Downgrade OpenClaw

If mode change doesn't work, downgrade to pre-regression version:

```bash
npm install -g openclaw@2026.1.27-beta.1
openclaw gateway restart
```

### Option 3: Use systemd Socket Binding

If OpenClaw has systemd integration, the socket might be pre-bound:

```bash
# Check if systemd is managing the socket
sudo systemctl status openclaw-gateway.socket
sudo systemctl status openclaw-gateway.service

# If socket is bound to 127.0.0.1, that's the problem
sudo systemctl edit openclaw-gateway.socket

# Override with:
# [Socket]
# ListenStream=0.0.0.0:18789
```

### Option 4: Environment Variable Override

Try these environment variables before starting:

```bash
# Try various env vars that might control binding
export OPENCLAW_BIND=0.0.0.0
export OPENCLAW_HOST=0.0.0.0
export OPENCLAW_GATEWAY_BIND=tailnet
export CLAWTALK_GATEWAY_BIND=0.0.0.0

openclaw gateway start
```

### Option 5: Check for New Config Schema

OpenClaw 2026.2.9 might have changed the config schema:

```bash
# Look for new config options
openclaw gateway start --help

# Check if there's a new bind-related setting
cat ~/.openclaw/openclaw.json | jq '.gateway'
```

### Option 6: SSH Tunnel Workaround

If all else fails, use an SSH tunnel:

```bash
# On MacBook
ssh -L 18789:localhost:18789 alienware-tailscale-ip -N

# In another terminal, use localhost
clawtalk --gateway http://127.0.0.1:18789
```

## Verification Commands

### On Gateway Server (Alienware):

```bash
# Check what's actually listening
sudo ss -tlnp | grep 18789
# Should show: 100.69.69.108:18789 or 0.0.0.0:18789
# Wrong:      127.0.0.1:18789

# Test locally
curl http://127.0.0.1:18789/health

# Test from Tailscale IP (should work after fix)
curl http://100.69.69.108:18789/health
```

### On Client (MacBook):

```bash
# Test connectivity
ping 100.69.69.108

# Test gateway
curl http://100.69.69.108:18789/health

# Test with Node.js (should work with our DNS fix)
node -e "fetch('http://100.69.69.108:18789/health').then(r => r.json()).then(console.log)"
```

## Debugging OpenClaw

If you need to dig into OpenClaw source:

```bash
# Find OpenClaw installation
which openclaw
npm list -g openclaw

# Look for gateway plugin code
cd $(npm root -g)/openclaw
find . -name "*.js" | xargs grep -l "proxy started on" 2>/dev/null

# Look for bind-related code
grep -r "127.0.0.1" --include="*.js" . 2>/dev/null | grep -i gateway | head -20
```

## Configuration Reference

### OpenClaw Config Location
```
~/.openclaw/openclaw.json
```

### Key Sections:
```json
{
  "gateway": {
    "mode": "tailnet",        // "local" | "tailnet" - TRY CHANGING THIS
    "bind": "tailnet",        // "tailnet" | "0.0.0.0" | specific IP
    "auth": {
      "token": "..."
    }
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

## Reporting to OpenClaw

If this is a regression in 2026.2.9, report it:

```
https://github.com/jokim1/openclaw/issues

Title: Gateway ignores --bind flag in 2026.2.9, always binds to 127.0.0.1

Description:
- After updating to 2026.2.9, the gateway ignores:
  - Config: "gateway.bind": "tailnet"
  - CLI: --bind 0.0.0.0
  - CLI: --bind 100.69.69.108
- Always binds to 127.0.0.1 regardless of configuration
- Changing "gateway.mode" from "local" to "tailnet" may fix it
```
