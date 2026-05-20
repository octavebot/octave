# trading-alerts

Background service that polls a TradingView Desktop chart via CDP and sends Telegram alerts when a strategy setup is imminent or triggered.

## Setup

```bash
# 1. Install deps (links the local tradingview-mcp via file:)
cd ~/trading-alerts && npm install

# 2. Write credentials (chmod 600!)
mkdir -p ~/.config/trading-alerts
chmod 700 ~/.config/trading-alerts
cp .env.example ~/.config/trading-alerts/.env
$EDITOR ~/.config/trading-alerts/.env
chmod 600 ~/.config/trading-alerts/.env

# 3. Smoke test
node src/index.js --verify   # should send "✅ Trading alerts service started" and exit

# 4. Run in foreground
node src/index.js            # Ctrl-C to stop

# 5. Install as a LaunchAgent
mkdir -p ~/Library/Logs/trading-alerts
cp launchd/com.jqvier.trading-alerts.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jqvier.trading-alerts.plist
launchctl print gui/$(id -u)/com.jqvier.trading-alerts | head -20
```

## Editing the strategy

The detector is `src/detector.js`. Edit only that file. Return:
- `{ status: 'none' }` — nothing to alert
- `{ status: 'imminent_5m', setupName: '...', summary: '...', details: {...}, etaSeconds: 300 }`
- `{ status: 'imminent_15s', ... }`
- `{ status: 'triggered', ... }`

Dedup is by `${setupName}:${symbol}:${tf}:${barTime}:${status}` — same setup won't re-fire on the same bar/tier.

After editing, restart the service:
```bash
launchctl kickstart -k gui/$(id -u)/com.jqvier.trading-alerts
```

## Logs

```bash
tail -f ~/Library/Logs/trading-alerts/stdout.log
tail -f ~/Library/Logs/trading-alerts/stderr.log
```

## Uninstall

```bash
launchctl bootout gui/$(id -u)/com.jqvier.trading-alerts
rm ~/Library/LaunchAgents/com.jqvier.trading-alerts.plist
```
