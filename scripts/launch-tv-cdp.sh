#!/bin/bash
# Launches TradingView Desktop on macOS with Chrome DevTools Protocol enabled
# on port 9222 so the local tv-bridge.js can read live bars. Installed as a
# LoginItem / LaunchAgent by install-tv-bridge.sh so it auto-starts on boot.
#
# Idempotent: kills any existing TradingView instance first (otherwise the
# second launch silently uses the existing one without the --remote-debugging-port
# flag, which is exactly what the MCP team got bitten by — that's why the
# default `tv_launch` MCP tool sometimes doesn't expose the port).

set -e

PORT="${TV_CDP_PORT:-9222}"
BIN="/Applications/TradingView.app/Contents/MacOS/TradingView"

if [ ! -x "$BIN" ]; then
  echo "[launch-tv-cdp] TradingView Desktop not found at $BIN — install from tradingview.com" >&2
  exit 1
fi

# Kill any existing instance so the next one definitely picks up the CDP flag.
pkill -x TradingView 2>/dev/null || true
sleep 2

# Launch detached so the LaunchAgent doesn't keep the process attached as a child
# (which would make the agent restart it constantly).
nohup "$BIN" --remote-debugging-port="$PORT" >/tmp/tradingview-cdp.log 2>&1 &
disown

echo "[launch-tv-cdp] TradingView started with CDP on port $PORT (PID $!)"
