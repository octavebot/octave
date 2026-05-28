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
  # The registry (strategy list) is read by ALL THREE services — engine
  # (detection), webui (/api/strategies → dashboard), bot (/strategies, /setups).
  # Restart all three so adding/removing a strategy syncs everywhere, not just
  # the engine (otherwise the dashboard + bot show a stale strategy list).
  ["src/strategies/"]="octave-signal-engine octave-webui octave-telegram"
  # src/lib and src/cloud are imported by all three Node services (engine,
  # webui, bot), so any change in those dirs needs to restart all of them —
  # otherwise the shared on-disk state (e.g. tv_bars.json) and the in-memory
  # code drift apart between processes.
  ["src/lib/"]="octave-signal-engine octave-webui octave-telegram"
  ["src/cloud/"]="octave-signal-engine octave-webui octave-telegram"
  ["src/webui/bot.js"]="octave-telegram"
  ["src/webui/server.js"]="octave-webui"
  ["src/webui/index.html"]="octave-webui"
  ["scripts/watchdog.js"]="octave-watchdog"
)

declare -A NEEDS_RESTART
while IFS= read -r path; do
  for key in "${!UNIT_FOR_PATH[@]}"; do
    if [[ "$path" == "$key"* ]]; then
      for unit in ${UNIT_FOR_PATH[$key]}; do
        NEEDS_RESTART[$unit]=1
      done
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

# Strategy code change → backtest-stats.json (registry ranking + dashboard
# numbers) AND the per-strategy PDF playbooks are now stale. Kick off a single
# backgrounded chain that:
#   1. reruns strategy-report.js over a 90-day Databento window → backtest-stats.json
#   2. regenerates the PDFs, which embed those fresh stats → playbooks/*.pdf
# The registry watches backtest-stats.json's mtime, so the new ranking is picked
# up on the next tick with NO extra restart (the strategies/ change already
# restarted signal-engine via UNIT_FOR_PATH above). playbooks/ is gitignored, so
# regenerating PDFs here never dirties the tree.
#
# Launched as a TRANSIENT systemd unit (not nohup&disown): this oneshot service's
# cgroup is torn down the moment git-sync exits, which SIGKILLs any plain child
# (disown doesn't escape the cgroup) — that's why deploy-time regen used to never
# finish. A transient unit gets its own cgroup and outlives us. 90d (was 365d)
# completes reliably in RAM; the fixed unit name also prevents two concurrent
# regens (systemd-run no-ops if it's already running → no shared-cache corruption).
if echo "$CHANGED" | grep -qE '^src/strategies/'; then
  if [ -f /home/octave/.config/trading-alerts/.env ] && command -v systemd-run >/dev/null 2>&1; then
    LOG "strategies changed — launching detached 90d backtest-stats + PDF regen (transient unit)"
    systemd-run --quiet --collect --unit=octave-deploy-regen --nice=10 \
      sudo -u octave bash -lc 'set -a; . /home/octave/.config/trading-alerts/.env; set +a; cd '"$REPO_DIR"'; node --max-old-space-size=420 scripts/strategy-report.js 90 && node scripts/generate-playbooks.js' \
      || LOG "regen not launched (already running or systemd-run unavailable)"
  else
    LOG "strategies changed — regen skipped (no .env or systemd-run)"
  fi
fi

LOG "sync complete"
