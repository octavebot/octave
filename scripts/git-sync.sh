#!/bin/bash
# Octave VPS auto-update.
#
# Runs every 60s via systemd timer (or every 60s via LaunchAgent on Mac). It
# fetches origin/main and fast-forwards; if anything actually changed it then:
#   - installs deps (only when package.json moved)
#   - restarts the services whose files moved (signal-engine, bot, webui, watchdog)
#
# Idempotent — no-op when there's nothing to pull. Safe to run as often as you
# like. Logs to stdout (systemd captures to journal / log file).

set -uo pipefail

REPO_DIR="${OCTAVE_REPO_DIR:-/home/octave/trading-alerts}"
cd "$REPO_DIR" || { echo "[git-sync] cd $REPO_DIR failed"; exit 0; }

# Quiet output unless something changes
LOG() { echo "[$(date -u +%FT%TZ)] $*"; }

# 1. Fetch
git fetch --quiet origin main 2>/dev/null || { LOG "fetch failed"; exit 0; }

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  # No new commits — nothing to do.
  exit 0
fi

LOG "remote ahead — pulling ($LOCAL → $REMOTE)"

# 2. Detect what changed BEFORE we move HEAD (lets us decide which services
# to restart)
CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE")

# 3. Fast-forward (refuse non-FF — manual intervention needed if local diverges)
if ! git merge --ff-only "$REMOTE" >/dev/null 2>&1; then
  LOG "FF merge failed — local diverged from origin/main. Skipping."
  exit 0
fi

# 4. npm install only if package.json or lock changed
if echo "$CHANGED" | grep -qE '(^|/)package(-lock)?\.json$'; then
  LOG "package.json changed — running npm install"
  if command -v npm >/dev/null 2>&1; then
    npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5
  fi
fi

# 5. Restart services whose source files changed.
declare -A UNIT_FOR_PATH=(
  ["src/index.js"]="octave-signal-engine"
  ["src/loop.js"]="octave-signal-engine"
  ["src/detector.js"]="octave-signal-engine"
  ["src/alerter.js"]="octave-signal-engine"
  ["src/strategies/"]="octave-signal-engine"
  ["src/lib/"]="octave-signal-engine"
  ["src/cloud/"]="octave-signal-engine"
  ["src/webui/bot.js"]="octave-bot"
  ["src/webui/server.js"]="octave-webui"
  ["src/webui/index.html"]="octave-webui"
  ["scripts/watchdog.js"]="octave-watchdog"
)

declare -A NEEDS_RESTART
while IFS= read -r path; do
  for key in "${!UNIT_FOR_PATH[@]}"; do
    if [[ "$path" == "$key"* ]]; then
      NEEDS_RESTART[${UNIT_FOR_PATH[$key]}]=1
    fi
  done
done <<<"$CHANGED"

for unit in "${!NEEDS_RESTART[@]}"; do
  LOG "restarting $unit (files changed)"
  if systemctl is-active --quiet "$unit" 2>/dev/null; then
    sudo systemctl restart "$unit" 2>&1 || systemctl restart --user "$unit" 2>&1 || true
  elif [ "$(uname)" = "Darwin" ]; then
    # Mac: kickstart the matching LaunchAgent (com.jqvier.<unit-name>)
    launchctl kickstart -k "gui/$(id -u)/com.jqvier.${unit#octave-}" 2>&1 || true
  fi
done

LOG "sync complete"
