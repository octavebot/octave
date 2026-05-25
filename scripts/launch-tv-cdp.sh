#!/bin/bash
# Persistent watchdog that keeps TradingView Desktop running with Chrome
# DevTools Protocol enabled on port 9222 so the local tv-bridge.js can read
# live bars.
#
# Why a watchdog and not a one-shot launch:
# TradingView occasionally crashes or relaunches itself (auto-updates, login
# expiry, etc.), and macOS sometimes re-opens it from "Open at Login" or the
# Dock — those new instances start WITHOUT the --remote-debugging-port flag,
# which kills the bridge silently. This loop checks the port every 10s and
# relaunches TV with the flag whenever it isn't there.
#
# Installed as a LaunchAgent by install-tv-bridge.sh with KeepAlive=true so
# even if this bash process itself dies, launchd restarts it.

set -e

PORT="${TV_CDP_PORT:-9222}"
BIN="/Applications/TradingView.app/Contents/MacOS/TradingView"
CHECK_EVERY_S=10
LOG_FILE="/tmp/tradingview-cdp.log"

[ -x "$BIN" ] || { echo "[tv-cdp] $BIN not found — install TradingView from tradingview.com/desktop/"; exit 1; }

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [tv-cdp] $*"; }

log "watchdog starting · port $PORT · check every ${CHECK_EVERY_S}s"

while true; do
  # Anything listening on the debug port? If not, TV is either down or running
  # without the flag — either way we kill and relaunch.
  if ! lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    log "port $PORT not listening — relaunching TradingView with debug flag"
    pkill -x TradingView 2>/dev/null || true
    sleep 3
    # nohup + disown so the launch isn't tied to this watchdog's lifetime —
    # if launchd kills this script, TV keeps running until next CDP failure.
    nohup "$BIN" --remote-debugging-port="$PORT" >"$LOG_FILE" 2>&1 &
    disown
    log "TradingView relaunched (PID $!) — giving it 12s to bind the port"
    sleep 12
  fi
  sleep "$CHECK_EVERY_S"
done
