# Trading Alerts — Operator Guide

Service runs three strategies against your TradingView Desktop layout. Alerts go to Telegram, with chart drawings auto-synced for active setups.

| Tag | Internal name | Source doc | Key requirement |
|---|---|---|---|
| `Strategy #1` | `USLS` | Lucid Flex 50K Universal Gold | Session liquidity sweep + MSS + FVG |
| `Strategy #2` | `ICT-SMC` | GOLD_ICT_SMC_STRATEGY.md | HTF bias (D/4H) + judas + MSS + PD array, optional DXY SMT |
| `Strategy #3` | `ALGO-SMC` | XAUUSD_SMC_Algo_Spec.pdf | HTF (1H/4H) sweep + Silver SMT + BOS+volume + 71% Fib at FVG/OB |
| `Strategy #4` | `ADAPTIVE` | Adaptive_Gold_Trading_Strategy.pdf | Regime-aware (ADX): Trend / Range-Reversal / Breakout playbook + Daily macro bias (DXY + MACD) |
| ⚡ `Strategy #5` | `ICT` | ICT.pdf | **ACTIVE** — M15 only, killzone-gated (London 02:00-05:00 EST + NY 07:00-10:00 EST). Asian Range sweep → MSS body close → FVG within 3 bars → Limit at C1 edge. SL sweep ±2pip, TP1 1:2 RR, TP2 opposite pool. |
| ⚡ `Strategy #6` | `SMT` | SMT.pdf | **ACTIVE** — M15 only, killzone-gated, requires Silver pane. Gold sweeps Asian SSL/BSL while Silver does NOT → MSS → FVG → Limit at C1, SL sweep ±2pip, TP 1:2 RR. |
| ⚡ `Strategy #7` | `TRINITY` | Trinity_Model_Blueprint.pdf | **ACTIVE** — 9:30-11:00 EST only. Step 1 HTF FVG (15m+) aligned with Daily narrative → Step 2 Gold/Silver SMT after tap → Step 3 LTF (1-5m) Inverse FVG = entry. SL beyond SMT swing. |

**Currently active:** #5, #6, #7. Strategies #1-#4 are deactivated (commented out in `src/detector.js`). Re-enable any by uncommenting the corresponding import + `evaluateX(ctx)` push in the orchestrator.

**Both strategies fire any weekday hour** as long as all requirements are met. Weekend (Fri 17:00 → Sun 18:00 ET) is skipped because gold isn't trading. The NY AM Killzone (8:30-11:00 ET) and macros (9:50-10:10, 10:50-11:10 ET) now only **boost confidence** on ICT-SMC setups — they no longer gate the strategy.

## TradingView Layout

Both strategies work best with this **6-pane** layout (TradingView menu: top → "Select Layout" → 6 charts):

| Pane | Symbol | Timeframe | Role |
|---|---|---|---|
| 1 | Gold (GC1!, MGC1!, or XAUUSD) | **Daily** | HTF bias |
| 2 | same gold | **4H (240)** | HTF bias |
| 3 | same gold | **1H (60)** | structure context |
| 4 | same gold | **15m** | session ranges + sweep detection |
| 5 | same gold | **5m** | execution (MSS + FVG) |
| 6 | TVC:DXY (or DXY) | **5m** | Strategy #2 SMT divergence |
| 7 | Silver (SI1!, XAGUSD) | **5m** or **15m** | Strategy #3 SMT divergence |

**Minimum viable layout per strategy:**
- **Strategy #1 (USLS):** pane 4 (15m gold) only.
- **Strategy #2 (ICT-SMC):** panes 1 (Daily), 2 (4H), 4 (15m), 5 (5m). Without D/4H you'll get a "HTF bias unknown" forming alert.
- **Strategy #3 (ALGO-SMC):** panes 2 (4H) or 3 (1H) as HTF, pane 5 (5m) as LTF, and **pane 7 (silver)** for SMT. Without silver the strategy stays parked at "sweep done, awaiting Silver SMT" — never triggers.

### Setting up the layout

1. Click the layout selector (top toolbar, looks like 4-square icon)
2. Choose "6 charts"
3. Click each pane → set symbol + timeframe per the table
4. **Save the layout** so it persists: top-right → Layouts → "Save layout as..." → e.g. "gold-strategy-grid"
5. Make sure CDP can still see all panes: `node -e "import('./src/lib/panes.js').then(m=>m.snapshotAllPanes(50).then(p=>console.log(p.map(x=>({sym:x.symbol,tf:x.resolution})))))"` from `~/trading-alerts/`

## News blackout file

`~/trading-alerts/data/news.json` — maintain this manually with the week's high-impact USD/Gold events (NFP, CPI, PPI, FOMC, Retail Sales, Fed speakers).

```json
{
  "events": [
    { "date": "2026-05-21", "time": "08:30", "tz": "America/New_York", "impact": "high", "name": "US CPI" },
    { "date": "2026-05-21", "time": "14:00", "tz": "America/New_York", "impact": "high", "name": "FOMC Minutes" }
  ]
}
```

Strategies skip ±30 minutes around any `"impact": "high"` event. The file is hot-reloaded once per minute — no service restart needed.

## Alert lifecycle

Each strategy emits 1-4 alerts as a setup develops:

| Status | Emoji | Meaning |
|---|---|---|
| `forming` | 🟡 | Early — approaching liquidity, or sweep done but no MSS yet |
| `near_trigger` | 🟠 | MSS confirmed, awaiting entry array (FVG/OB) |
| `triggered` | 🔴 | Full setup — limit entry, stop, targets all defined |
| `invalidated` | ⚫️ | Setup broken (sweep too far, news blackout, stop hit) |

Each Telegram message includes:
- `[USLS]` or `[ICT-SMC]` strategy tag
- Direction (LONG/SHORT)
- Confidence %
- Symbol & timeframe
- Current price
- Phase-specific details (sweep wick, MSS ratio, entry/stop/targets, etc.)
- Invalidation level

## Restarting

After editing strategy code:
```bash
launchctl kickstart -k gui/$(id -u)/com.jqvier.trading-alerts
```

After editing news.json: no restart needed (hot-reload).

## Logs

```bash
tail -f ~/Library/Logs/trading-alerts/stdout.log
tail -f ~/Library/Logs/trading-alerts/stderr.log
```

## Limits / known gaps

- **Order Block detection** is simple (last opposing candle before MSS). Doesn't validate freshness vs. multiple historical OBs.
- **Mitigation Block / Breaker Block** detection not yet implemented.
- **OTE entry preference** logic is documented but not yet automatically chosen over FVG.
- **HTF unmitigated OB / daily FVG** check (Strategy 2 step 1 sub-bullet) not implemented — uses BOS + 4H trend only.
- **Multi-pool sweep detection** (Strategy 2 A+ confluence) detected when targets share a level within ~$2 — not strict simultaneous sweep.
- **Position sizing math** (Strategy 1 Section 5) is computed in alerts but the service does NOT place orders — it's alert-only.
- **Trailing drawdown enforcement** and the 50% consistency cap (Strategy 1 Section 6) are not tracked — that's a journaling concern, not detection.
- **Strategy 2 secondary correlations** (Silver, ZN yields) not implemented — only DXY.

When you want any of these, just say which one and I'll add it.
