#!/bin/bash
# Cloudflare Quick Tunnel — free HTTPS for the Octave dashboard.
#
# Run AS ROOT on your VPS after vps-deploy.sh:
#   sudo bash scripts/setup-cloudflare-tunnel.sh
#
# Installs `cloudflared`, sets it up as a systemd service pointing at
# localhost:7345, captures the public HTTPS URL into ~octave/.octave-tunnel-url
# so the bot can include it in /menu.
#
# This uses Quick Tunnels (free, no Cloudflare account needed). The URL is
# stable across normal restarts but Cloudflare reserves the right to rotate
# it; if your URL changes, just rerun this script.

set -euo pipefail
if [ "$EUID" -ne 0 ]; then echo "Run as root"; exit 1; fi

ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64) PKG=cloudflared-linux-arm64 ;;
  x86_64)        PKG=cloudflared-linux-amd64 ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

# 1. Install cloudflared
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[+] Installing cloudflared ($PKG)"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/$PKG" -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared
fi

# 2. Systemd unit
cat > /etc/systemd/system/octave-tunnel.service <<'EOF'
[Unit]
Description=Octave Cloudflare Quick Tunnel
After=network-online.target octave-webui.service
Wants=network-online.target

[Service]
Type=simple
User=octave
WorkingDirectory=/home/octave
ExecStart=/bin/bash -c '/usr/local/bin/cloudflared tunnel --url http://localhost:7345 --no-autoupdate 2>&1 | tee /home/octave/.octave-tunnel.log'
ExecStartPost=/bin/bash -c 'sleep 8 && grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" /home/octave/.octave-tunnel.log | head -1 > /home/octave/.octave-tunnel-url'
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable octave-tunnel
systemctl restart octave-tunnel

echo "[+] Tunnel starting…"
sleep 12

# 3. Show the URL
URL=$(cat /home/octave/.octave-tunnel-url 2>/dev/null || true)
if [ -n "$URL" ]; then
  echo
  echo "==========================================="
  echo "  Octave Dashboard URL (HTTPS, public):"
  echo "  $URL"
  echo "==========================================="
  echo
  echo "Paste it into your Telegram /menu to test."
  echo "On your phone: open the bot, send /menu, then tap the Dashboard button."
else
  echo "Tunnel did not produce a URL yet. Check:  journalctl -u octave-tunnel -f"
fi
