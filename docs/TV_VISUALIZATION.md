# TradingView visualization — Trade Panel + Octave Levels indicator

Two complementary tools for seeing the bot's trades visually:

1. **Trade Panel** — a hosted web page, auto-refreshing every 3s. Open in a
   browser tab next to TradingView. Shows every open trade with entry / SL /
   TP / current price / progress to TP. No TradingView dependency.
2. **Octave Levels Pine indicator** — installed once in TradingView. Per
   signal, paste the levels from the Telegram alert into the indicator's
   inputs (4 numbers). Lines + labels overlay your chart.

---

## 1. Trade Panel (no-setup, always-on)

The signal-engine's web UI already runs on the VPS (`octave-webui` service).
A new `/positions` route was added in this build.

### Open it
```
https://<your-tunnel-host>/positions
```

To find your current tunnel host:
```
ssh ubuntu@141.148.58.80 'cat /home/octave/.octave-tunnel-url'
```
(Or just type `/dashboard` to the bot in Telegram — same URL.)

### What you'll see
- Two account cards (AUTO + USER), each with balance / today's P&L /
  open positions
- Each open trade shows entry / stop / TP1 / TP2 as colored bars
- Progress bar between entry and TP1 (green when winning) or entry and
  SL (red when losing)
- Auto-refreshes every 3 seconds

### Recommended layout
Pull the panel out as a separate browser window, dock it next to your
TradingView tab. Glanceable.

---

## 2. Octave Levels Pine indicator (lines on the actual chart)

### Install once (5 min)
1. In TradingView, open any chart (e.g. MGC1!)
2. Click **Pine Editor** at the bottom of the screen → **Open** → **New
   indicator**
3. Open `docs/octave-levels.pine` from this repo in your text editor, copy
   the whole file, paste into the Pine Editor
4. Click **Save** (top right) → name it `Octave Levels` → save
5. Click **Add to chart** (the indicator now appears in your chart)
6. You'll see 5 inputs in the indicator's gear icon → Settings:
   `Direction · Strategy · Entry · Stop · TP1 · TP2`
7. While not in a trade: leave `Direction = NONE` → nothing drawn

### When a signal fires
The Telegram alert card now includes a one-line block like:
```
OCTAVE  LONG  4500 / 4510 / 4485 / 4475
```

In TradingView:
1. Click the gear icon next to "Octave Levels" in the indicator pane
2. Set `Direction = LONG` (or SHORT)
3. Type the 4 numbers into Entry / Stop / TP1 / TP2
4. Click OK — lines + labels appear

When the trade closes (TP or SL Telegram alert), set `Direction = NONE`
to clear.

### Pro tip: use `/levels` to re-fetch
If you switched charts or lost the alert message, type `/levels` to the bot.
It DMs you the levels for every currently-open trade, ready to copy-paste.

---

## Trade-offs

| Feature | Trade Panel | Pine Indicator |
|---|---|---|
| Auto-updates per signal | ✅ Yes, every 3s | ⚫ Manual paste per trade |
| Lines on actual TV chart | ⚫ No (separate panel) | ✅ Yes, on your chart |
| Setup time | None — open URL | 5 min one-time install |
| Survives TV UI changes | ✅ Yes (no TV dependency) | ✅ Yes (native Pine) |
| Multiple charts simultaneously | One panel, all trades | Need indicator on each chart |

Use both. Panel for awareness, indicator when you want to study the trade
on the chart itself.
