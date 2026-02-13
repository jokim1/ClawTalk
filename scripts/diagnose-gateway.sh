#!/bin/bash
#
# Gateway Binding Diagnostic Script
# Run this on the gateway server (Alienware) to diagnose binding issues
#

set -e

echo "=========================================="
echo "OpenClaw Gateway Binding Diagnostics"
echo "Date: $(date)"
echo "=========================================="
echo

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}1. OpenClaw Version${NC}"
echo "------------------------------------------"
openclaw --version 2>/dev/null || echo "openclaw command not found"
echo

echo -e "${YELLOW}2. Current OpenClaw Config${NC}"
echo "------------------------------------------"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"
if [ -f "$CONFIG_FILE" ]; then
    echo "Config location: $CONFIG_FILE"
    echo "Gateway section:"
    cat "$CONFIG_FILE" | jq '.gateway' 2>/dev/null || cat "$CONFIG_FILE" | grep -A10 '"gateway"'
else
    echo -e "${RED}Config not found at $CONFIG_FILE${NC}"
fi
echo

echo -e "${YELLOW}3. Network Interfaces${NC}"
echo "------------------------------------------"
echo "All interfaces:"
ip addr show 2>/dev/null || ifconfig 2>/dev/null || echo "Cannot list interfaces"
echo

echo "Tailscale IP:"
tailscale ip -4 2>/dev/null || echo "Tailscale not running or not installed"
echo

echo -e "${YELLOW}4. Current Listening Ports${NC}"
echo "------------------------------------------"
echo "All TCP listeners:"
sudo ss -tlnp 2>/dev/null | grep -E "(Port|18789)" || netstat -tlnp 2>/dev/null | grep -E "(Local|18789)" || echo "Cannot list ports"
echo

echo -e "${YELLOW}5. Gateway Process${NC}"
echo "------------------------------------------"
echo "OpenClaw processes:"
ps aux | grep -i openclaw | grep -v grep || echo "No openclaw processes running"
echo

echo -e "${YELLOW}6. Test Gateway Binding${NC}"
echo "------------------------------------------"

# Check if port is already in use
if ss -tlnp | grep -q ":18789"; then
    echo -e "${GREEN}Port 18789 is already listening${NC}"
    ss -tlnp | grep ":18789"
    
    # Try connecting
    echo
    echo "Testing local connection:"
    curl -s http://127.0.0.1:18789/health | head -20 || echo -e "${RED}Local connection failed${NC}"
    
    # Get Tailscale IP
    TS_IP=$(tailscale ip -4 2>/dev/null || echo "")
    if [ -n "$TS_IP" ]; then
        echo
        echo "Testing Tailscale IP connection ($TS_IP):"
        curl -s "http://$TS_IP:18789/health" 2>&1 | head -20 || echo -e "${RED}Tailscale connection failed${NC}"
    fi
else
    echo -e "${YELLOW}Port 18789 is not currently listening${NC}"
    echo "Gateway may not be running"
fi
echo

echo "=========================================="
echo "Diagnostic complete"
echo "=========================================="
echo
echo "Next steps:"
echo "  1. If listening on 127.0.0.1 only, try changing mode:"
echo "     sed -i 's/\"mode\": \"local\"/\"mode\": \"tailnet\"/' ~/.openclaw/openclaw.json"
echo
echo "  2. Then restart gateway:"
echo "     openclaw gateway restart"
echo
echo "  3. Re-run this script to verify"
