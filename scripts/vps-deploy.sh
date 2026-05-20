#!/bin/bash
# Octave VPS deployment script.
#
# Run AS ROOT on a fresh Ubuntu 22.04+ VM (Oracle Cloud, Hetzner, AWS, etc.):
#
#   curl -fsSL https://raw.githubusercontent.com/octavebot/octave/main/scripts/vps-deploy.sh | sudo bash
#
# Or after `git clone`:
#
#   sudo bash trading-alerts/scripts/vps-deploy.sh
#
# What it does:
#   1. Creates 'octave' user
#   2. Installs Node 20 LTS, git, ufw
#   3. Clones the repo to /home/octave/trading-alerts (if not already present)
#   4. Prompts for Telegram credentials → /home/octave/.config/trading-alerts/.env
#   5. Installs the 4 systemd units (signal-engine, telegram, webui, watchdog)
#   6. Opens port 7345 in the firewall (optional — only if you want public dashboard)
#   7. Starts everything and confirms heartbeats
#
# Idempotent: safe to re-run for upgrades.

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Run as root: sudo bash $0"
  exit 1
fi

OCTAVE_HOME="/home/octave"
REPO_DIR="$OCTAVE_HOME/trading-alerts"
ENV_DIR="$OCTAVE_HOME/.config/trading-alerts"
LOG_DIR="$OCTAVE_HOME/.octave-logs"
REPO_URL="${OCTAVE_REPO_URL:-https://github.com/octavebot/octave.git}"

echo "== Octave VPS deploy =="
echo "Target user:    octave"
echo "Repo:           $REPO_URL"
echo "Install dir:    $REPO_DIR"
echo "Env file:       $ENV_DIR/.env"
echo

# ---------- 1. User ----------
if ! id -u octave >/dev/null 2>&1; then
  echo "[+] Creating user 'octave'"
  useradd -m -s /bin/bash octave
fi

# ---------- 2. Packages ----------
echo "[+] Installing system packages"
apt-get update -y
apt-get install -y curl git ca-certificates ufw build-essential

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE '^v(2[0-9]|[3-9][0-9])'; then
  echo "[+] Installing Node 20 LTS"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# ---------- 3. Repo ----------
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[+] Cloning repo"
  sudo -u octave git clone "$REPO_URL" "$REPO_DIR"
else
  echo "[+] Pulling latest"
  sudo -u octave git -C "$REPO_DIR" pull --rebase --autostash
fi

# ---------- 4. Directories ----------
echo "[+] Creating runtime dirs"
sudo -u octave mkdir -p "$ENV_DIR" "$LOG_DIR" "$REPO_DIR/src/state/heartbeats"
chmod 700 "$ENV_DIR"

# ---------- 5. Env file ----------
if [ ! -f "$ENV_DIR/.env" ]; then
  echo
  echo "[+] Telegram credentials needed."
  read -p "  TELEGRAM_BOT_TOKEN: " TG_TOKEN
  read -p "  TELEGRAM_CHAT_ID:   " TG_CHAT
  cat > "$ENV_DIR/.env" <<EOF
TELEGRAM_BOT_TOKEN=$TG_TOKEN
TELEGRAM_CHAT_ID=$TG_CHAT
EOF
  chown octave:octave "$ENV_DIR/.env"
  chmod 600 "$ENV_DIR/.env"
fi

# ---------- 6. Systemd units ----------
echo "[+] Installing systemd units"
cp "$REPO_DIR/scripts/systemd/"*.service /etc/systemd/system/
systemctl daemon-reload

for unit in octave-signal-engine octave-telegram octave-webui octave-watchdog; do
  systemctl enable "$unit"
  systemctl restart "$unit"
done

sleep 5

echo
echo "== Status =="
for unit in octave-signal-engine octave-telegram octave-webui octave-watchdog; do
  state=$(systemctl is-active "$unit" || true)
  echo "  $unit: $state"
done

# ---------- 7. Firewall (optional) ----------
if [ "${OPEN_DASHBOARD:-0}" = "1" ]; then
  echo "[+] Opening port 7345 in ufw"
  ufw allow 7345/tcp || true
fi

PUBLIC_IP=$(curl -fsSL https://api.ipify.org 2>/dev/null || echo '<your-vps-ip>')
echo
echo "== Done =="
echo
echo "Dashboard:  http://$PUBLIC_IP:7345/  (only reachable if OPEN_DASHBOARD=1 was set)"
echo "Logs:       sudo journalctl -u octave-signal-engine -f"
echo "Restart:    sudo systemctl restart octave-telegram"
echo
echo "Send /health to your Telegram bot to confirm everything is live."
