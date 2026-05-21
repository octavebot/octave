#!/bin/bash
# One-shot updater for Octave on the VPS.
#
# Usage: sudo bash /home/octave/trading-alerts/scripts/update.sh
#
# Pulls latest code, restarts all services in the right order, prints the
# new dashboard URL. Use after Claude pushes a fix.

set -e
REPO=/home/octave/trading-alerts

echo "→ Pulling latest code…"
sudo -u octave git -C "$REPO" pull

echo "→ Restarting tunnel (URL may rotate)…"
systemctl restart octave-tunnel
sleep 12

echo "→ Restarting services…"
systemctl restart octave-webui octave-telegram octave-signal-engine octave-watchdog 2>/dev/null || true
sleep 3

echo
echo "=== Status ==="
for svc in octave-webui octave-telegram octave-signal-engine octave-watchdog octave-tunnel; do
  state=$(systemctl is-active "$svc" 2>&1 | head -1)
  echo "  $svc: $state"
done

URL=$(cat /home/octave/.octave-tunnel-url 2>/dev/null)
echo
echo "=== Dashboard URL ==="
echo "  ${URL:-(no URL captured — check journalctl -u octave-tunnel)}"
if [ -n "$URL" ]; then
  echo
  echo "=== HTTP test ==="
  curl -sS -o /dev/null -w "  $URL → HTTP %{http_code}\n" "$URL/" || true
fi
