# OANDA setup — for true 1y / 3y / 5y backtests

Yahoo's free intraday API caps 15m bars at **~71 days**. Every strategy in the
stack anchors on 15m, so any backtest beyond ~71 days silently uses only the
data Yahoo has — your `--days 365` request is honored as `--days 71` under the
hood.

OANDA's demo accounts are **free** and give clean OHLC history going back
~5 years on the instruments they support. The Octave backtest auto-merges
OANDA history with Yahoo's live feed when `OANDA_API_TOKEN` is set.

---

## 1. Create a free OANDA demo account (5 min)

1. Visit **https://www.oanda.com/demo-account/**
2. Click "Create Account" → "fxTrade Practice" (free, no credit card).
3. Pick "USA" or your region. (Region affects which CFD instruments are
   available — see step 5.)
4. Verify your email.

---

## 2. Generate an API token

1. Log into the demo account dashboard.
2. Click your account name (top right) → **"Manage API Access"**.
3. Click **"Generate"** → copy the token.
4. Note your **Account ID** (looks like `101-001-12345678-001`).

---

## 3. Save credentials to the VPS

SSH into the VPS:

```bash
ssh ubuntu@141.148.58.80
sudo -u octave nano /home/octave/.config/trading-alerts/.env
```

Add these lines:

```
OANDA_API_TOKEN=paste-your-token-here
OANDA_ACCOUNT_ID=101-001-12345678-001
# Optional — only needed for a live (non-demo) account:
# OANDA_API_BASE=https://api-fxtrade.oanda.com
```

Save (`Ctrl+O`, `Enter`, `Ctrl+X`).

Restart the signal engine so it picks up the new env:

```bash
sudo systemctl restart octave-signal-engine
```

---

## 4. Run a deep backtest

The first call may take 30-60 seconds — OANDA paginates in chunks of 5000
candles, so 5 years of 15m bars (~130k candles per instrument) = ~26 requests
per instrument.

```bash
ssh ubuntu@141.148.58.80
cd /home/octave/trading-alerts
node scripts/strategy-report.js 365   # 1-year backtest
node scripts/strategy-report.js 1095  # 3-year backtest
node scripts/deep-backtest.js         # full diagnostics, uses max available depth
```

If OANDA is configured AND the requested window > 71 days, the backtest
will fetch the longer history and merge it under each pane key. You'll see
`source: 'yahoo+oanda'` in the panes summary line.

---

## 5. Instrument availability

OANDA's free demo always gives:
- `XAU_USD` → **gold**
- `XAG_USD` → **silver**

Some accounts get CFDs (depends on region/account type):
- `NAS100_USD` → **nasdaq**
- `SPX500_USD` → **sp500**
- `DE30_EUR`, `US30_USD`, etc.

If your account doesn't have the index CFDs (you'll see `HTTP 404` for them
on first fetch), gold history will still be deep but nasdaq/sp will stay
capped at Yahoo's 71-day window. The backtest cleanly handles partial
availability — strategies just see whatever data is there.

---

## 6. Verifying it works

```bash
ssh ubuntu@141.148.58.80
cd /home/octave/trading-alerts
node -e '
import("./src/cloud/oanda.js").then(async (m) => {
  console.log("Token configured:", m.isConfigured());
  const g = await m.fetchBars("gold", "15", 365);
  console.log("Gold 15m bars over 365 days:", g?.bars?.length || 0);
  const n = await m.fetchBars("nasdaq", "15", 365);
  console.log("Nasdaq 15m bars over 365 days:", n?.bars?.length || 0,
              n ? "(supported)" : "(NOT supported on this account)");
});
'
```

Expected output if gold works:
```
Token configured: true
Gold 15m bars over 365 days: 34500
```

---

## Removing OANDA

Delete the `OANDA_API_TOKEN` line from `.env` and restart. The backtest will
silently fall back to Yahoo-only mode.
