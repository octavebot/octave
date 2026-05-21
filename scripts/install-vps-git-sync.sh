#!/bin/bash
# Install/refresh the VPS auto-update systemd timer.
#
# Run this once on the VPS (or any time the unit file changes):
#   ssh ubuntu@<vps>
#   sudo bash /home/octave/trading-alerts/scripts/install-vps-git-sync.sh
#
# What it does:
#   1. Copies octave-git-sync.{service,timer} → /etc/systemd/system/
#   2. systemctl daemon-reload + enable + start the timer
#   3. Verifies the first run completes
#
# Idempotent — safe to re-run.

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Run as root (or with sudo)."; exit 1
fi

REPO_DIR="${OCTAVE_REPO_DIR:-/home/octave/trading-alerts}"
SRC_UNIT_DIR="$REPO_DIR/scripts/systemd"
DEST_UNIT_DIR="/etc/systemd/system"

for u in octave-git-sync.service octave-git-sync.timer; do
  if [ ! -f "$SRC_UNIT_DIR/$u" ]; then
    echo "Missing source unit: $SRC_UNIT_DIR/$u"; exit 1
  fi
  cp "$SRC_UNIT_DIR/$u" "$DEST_UNIT_DIR/$u"
  echo "installed $DEST_UNIT_DIR/$u"
done

# Ensure git-sync.sh is executable and sudo-able for restart subcommands.
chmod +x "$REPO_DIR/scripts/git-sync.sh"
# Allow the octave user to restart octave-* services without a password prompt
SUDOERS_FILE=/etc/sudoers.d/octave-git-sync
if [ ! -f "$SUDOERS_FILE" ]; then
  cat >"$SUDOERS_FILE" <<EOF
octave ALL=(root) NOPASSWD: /bin/systemctl restart octave-*, /bin/systemctl is-active --quiet octave-*
EOF
  chmod 0440 "$SUDOERS_FILE"
  echo "installed sudoers rule: $SUDOERS_FILE"
fi

# Ensure log dir exists
mkdir -p /home/octave/.octave-logs
chown -R octave:octave /home/octave/.octave-logs

systemctl daemon-reload
systemctl enable --now octave-git-sync.timer

echo
echo "✓ Timer installed and started."
systemctl status octave-git-sync.timer --no-pager | head -10
echo
echo "Next sync:"
systemctl list-timers octave-git-sync.timer --no-pager | head -4
echo
echo "Tail logs with: journalctl -u octave-git-sync.service -f"
echo "Or:             tail -f /home/octave/.octave-logs/git-sync.log"
