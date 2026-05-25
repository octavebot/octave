#!/bin/bash
# One-shot installer for the TradingView bridge on a fresh always-on Mac.
#
# Sets up everything in one run: Xcode CLI, Homebrew, Node + git, clones the
# trading-alerts repo, installs npm deps, writes the bridge env file, and
# registers two LaunchAgents — one to launch TradingView with CDP on every
# login/boot, one to keep tv-bridge.js running and pushing bars to the VPS.
#
# Designed to be safely re-runnable: every step checks for existing state and
# skips it if already set up.
#
# Usage (interactive — script prompts for any missing values):
#   bash install-tv-bridge.sh
#
# Usage (non-interactive — supply everything via env):
#   VPS_URL="https://xxx.trycloudflare.com" \
#   TV_BRIDGE_SECRET="<64-hex>" \
#   TELEGRAM_BOT_TOKEN="<optional, for blind-alert nudges>" \
#   TELEGRAM_CHAT_ID="<optional>" \
#   bash install-tv-bridge.sh

set -euo pipefail

# ─── Helpers ─────────────────────────────────────────────────────────────────
log()  { echo -e "\033[1;36m[install]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*" >&2; }
err()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }
ok()   { echo -e "\033[1;32m[ok]\033[0m $*"; }
prompt() { local p="$1"; local v=""; read -r -p "$p " v; echo "$v"; }

# ─── Sanity checks ───────────────────────────────────────────────────────────
[[ "$(uname)" == "Darwin" ]] || err "this installer is macOS-only"
[[ "$EUID" -ne 0 ]] || err "run as your regular user (sudo will be invoked where needed) — not as root"

# ─── Step 1: Xcode Command Line Tools ────────────────────────────────────────
if ! xcode-select -p >/dev/null 2>&1; then
  log "installing Xcode Command Line Tools — a system dialog will appear, click Install and wait for it to finish"
  xcode-select --install || true
  echo
  prompt "Press Enter once the Xcode CLI install dialog has FINISHED:" >/dev/null
  xcode-select -p >/dev/null 2>&1 || err "Xcode CLI install didn't complete — re-run this script when it has"
fi
ok "Xcode CLI installed"

# ─── Step 2: git (ships with Xcode CLI — no install needed) ──────────────────
command -v git >/dev/null 2>&1 || err "git not found — Xcode CLI install may not be complete; re-run after it finishes"
ok "git $(git --version | awk '{print $3}')"

# ─── Step 3: Node — portable tarball into ~/.octave-bridge/node (no sudo) ────
# We deliberately avoid Homebrew so this installer runs on non-admin accounts.
# Node tarballs are signed, self-contained, and include npm. Pin to LTS so the
# bot's package.json (Node 20+) is satisfied and we don't pull a rough nightly.
NODE_VER="v20.20.2"
NODE_HOME="$HOME/.octave-bridge/node"

need_node_install=true
if command -v node >/dev/null 2>&1; then
  current="$(node -v)"
  # Accept any v18+ that's already on PATH — npm needs to support modern lockfile v3.
  major="${current#v}"; major="${major%%.*}"
  if [ -n "$major" ] && [ "$major" -ge 18 ]; then
    ok "system node $current — using it"
    need_node_install=false
  fi
fi

if [ "$need_node_install" = "true" ]; then
  arch="$(uname -m)"
  case "$arch" in
    arm64)  NODE_ARCH="darwin-arm64" ;;
    x86_64) NODE_ARCH="darwin-x64"   ;;
    *) err "unknown CPU arch: $arch — open an issue, this needs a tarball" ;;
  esac
  tarball="node-${NODE_VER}-${NODE_ARCH}.tar.gz"
  url="https://nodejs.org/dist/${NODE_VER}/${tarball}"

  if [ ! -x "$NODE_HOME/bin/node" ]; then
    log "downloading node ${NODE_VER} for ${NODE_ARCH} (~25MB)"
    mkdir -p "$NODE_HOME"
    curl -fsSL "$url" | tar -xz -C "$NODE_HOME" --strip-components=1 \
      || err "node tarball download/extract failed"
  fi
  export PATH="$NODE_HOME/bin:$PATH"
  ok "node $($NODE_HOME/bin/node -v) installed to $NODE_HOME (no sudo)"
fi

# ─── Step 4: Clone / update the trading-alerts repo ──────────────────────────
REPO_DIR="$HOME/trading-alerts"
if [ -d "$REPO_DIR/.git" ]; then
  log "updating existing repo at $REPO_DIR"
  git -C "$REPO_DIR" pull --ff-only
else
  log "cloning trading-alerts → $REPO_DIR"
  git clone https://github.com/octavebot/octave.git "$REPO_DIR"
fi
ok "repo at $REPO_DIR ($(git -C "$REPO_DIR" rev-parse --short HEAD))"

# ─── Step 5: npm install (just the bridge dep — chrome-remote-interface) ─────
log "installing npm deps"
cd "$REPO_DIR"
npm install --omit=dev --no-audit --no-fund
ok "npm deps installed"

# ─── Step 6: Collect config ──────────────────────────────────────────────────
CONFIG_DIR="$HOME/.octave-bridge"
mkdir -p "$CONFIG_DIR"
LOG_DIR="$HOME/Library/Logs/octave-bridge"; mkdir -p "$LOG_DIR"

VPS_URL="${VPS_URL:-}"
TV_BRIDGE_SECRET="${TV_BRIDGE_SECRET:-}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"

[ -z "$VPS_URL" ]            && VPS_URL=$(prompt "VPS URL (e.g. https://xxx.trycloudflare.com):")
[ -z "$TV_BRIDGE_SECRET" ]   && TV_BRIDGE_SECRET=$(prompt "TV_BRIDGE_SECRET (64-hex, must match VPS .env):")
[ -z "$TELEGRAM_BOT_TOKEN" ] && TELEGRAM_BOT_TOKEN=$(prompt "TELEGRAM_BOT_TOKEN (optional, Enter to skip):")
[ -z "$TELEGRAM_CHAT_ID" ]   && TELEGRAM_CHAT_ID=$(prompt "TELEGRAM_CHAT_ID (optional, Enter to skip):")

[ -n "$VPS_URL" ] || err "VPS_URL is required"
[ -n "$TV_BRIDGE_SECRET" ] || err "TV_BRIDGE_SECRET is required"
[[ "$TV_BRIDGE_SECRET" =~ ^[0-9a-fA-F]{64}$ ]] || err "TV_BRIDGE_SECRET must be 64 hex chars"

# vps-url stays in its own file so the user can update it in-place when the
# Cloudflare Quick Tunnel rotates, without re-running the installer. Bridge
# re-reads this file on every cycle.
echo "$VPS_URL" > "$CONFIG_DIR/vps-url"
chmod 600 "$CONFIG_DIR/vps-url"

# env file is read by the LaunchAgent — keep secrets here, mode 600.
cat > "$CONFIG_DIR/env" <<EOF
TV_BRIDGE_SECRET=$TV_BRIDGE_SECRET
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID
TV_CDP_PORT=9222
TV_POLL_MS=3000
EOF
chmod 600 "$CONFIG_DIR/env"
ok "config written to $CONFIG_DIR (mode 600)"

# ─── Step 7: TradingView Desktop check ───────────────────────────────────────
if [ ! -d "/Applications/TradingView.app" ]; then
  warn "TradingView Desktop not found at /Applications/TradingView.app"
  warn "Install it from https://www.tradingview.com/desktop/ then re-run this script"
  warn "(the bridge will fail until TV is installed and showing the 3 charts)"
fi

# ─── Step 8: LaunchAgents ────────────────────────────────────────────────────
LA_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LA_DIR"
NODE_BIN="$(command -v node)"

# Agent 1: launch TradingView with CDP at login.
TV_PLIST="$LA_DIR/com.octave.tv-cdp.plist"
cat > "$TV_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.octave.tv-cdp</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO_DIR/scripts/launch-tv-cdp.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>$LOG_DIR/tv-cdp.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/tv-cdp.err</string>
</dict>
</plist>
EOF

# Agent 2: the bridge process itself — KeepAlive so it auto-restarts on crash.
BRIDGE_PLIST="$LA_DIR/com.octave.tv-bridge.plist"
cat > "$BRIDGE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.octave.tv-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_DIR/scripts/tv-bridge.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
$(while IFS='=' read -r k v; do [ -n "$k" ] && echo "    <key>$k</key><string>$v</string>"; done < "$CONFIG_DIR/env")
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/bridge.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/bridge.err</string>
</dict>
</plist>
EOF
chmod 600 "$BRIDGE_PLIST" "$TV_PLIST"

# Bootstrap / kickstart so they run RIGHT NOW (and on every login forever).
launchctl unload "$TV_PLIST" 2>/dev/null || true
launchctl unload "$BRIDGE_PLIST" 2>/dev/null || true
launchctl load -w "$TV_PLIST"
launchctl load -w "$BRIDGE_PLIST"

ok "LaunchAgents installed (com.octave.tv-cdp + com.octave.tv-bridge)"
echo

# ─── Done ────────────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════════"
echo "  TV bridge installed."
echo "═══════════════════════════════════════════════════════════════════"
echo
echo "  TradingView should launch automatically with CDP enabled."
echo "  Now do this ONCE in TradingView (it persists across restarts):"
echo "    1. Open three chart tabs."
echo "    2. Tab 1 → symbol MGC1! · timeframe 5m"
echo "    3. Tab 2 → symbol MNQ1! · timeframe 5m"
echo "    4. Tab 3 → symbol MES1! · timeframe 5m"
echo
echo "  Bridge logs:  $LOG_DIR/bridge.log  (tail -f to watch live)"
echo "  Update VPS URL when it rotates:"
echo "    echo 'https://new-url.trycloudflare.com' > $CONFIG_DIR/vps-url"
echo "    (bridge re-reads on every cycle — no restart needed)"
echo
echo "  Health check (run from any machine):"
echo "    curl $VPS_URL/api/ingest-bars/status"
echo "═══════════════════════════════════════════════════════════════════"
