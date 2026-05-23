/**
 * Strategy: VWAP Rejection · Intraday Continuation
 *
 * Price tests the day's VWAP and rejects — the day's trending side defended.
 * We trade the rejection with HTF (H1) trend agreement and a pin/engulfing
 * confirmation candle, entering at the close rather than a retracement limit.
 */

import { vwap, ema, isPinBar, isEngulfing } from '../lib/indicators.js';
import { atr } from '../lib/structure.js';
import { nyDayStartUnix, nyParts } from '../lib/time.js';
import { buildTriggered, dayScopedId, qualityConfidence } from './_helpers.js';

export const meta = {
  id: 'VWAP-REJ',
  name: 'VWAP Rejection · Intraday',
  concept: 'HTF-trend-aligned rejection of session VWAP with a confirmation candle',
  window: 'Any session hour',
  timeframes: ['15', '60'],
  defaultEnabled: true,
};

export const playbook = `# VWAP Rejection · Intraday Continuation

## Concept
VWAP is the volume-weighted "fair price" of the day — institutions defend it.
A clean rejection (wick into VWAP, body back on the trending side, with a
pin or engulfing close) is a continuation trade. The H1 50-EMA trend filter
keeps us on the right side of higher-timeframe flow.

## Rules
1. **H1 trend** — H1 close above/below the 50-EMA, EMA sloping the same way.
2. **Touch** — Bar's wick crosses VWAP, body closes back on the trending side.
3. **Displacement** — Close ≥ 0.3 × ATR away from VWAP (not lingering on it).
4. **Confirmation** — Last bar is a pin bar OR engulfing in the trade direction.

## Entry
- Market at trigger close (no retracement limit).

## Stop loss
- 0.5 × ATR beyond the wick extreme (then widened by STOP_PAD).

## Take profit
- TP1: 1.2 × risk · TP2: 1.8 × risk (uniform reward profile).

## When to skip
- H1 trend disagrees with the day's VWAP side.
- Range-bound tape (ATR-15m < 0.4 × ATR-H1).
`;

export function evaluate(ctx) {
  const out = [];
  const tf = ctx.pane('15');
  const tf60 = ctx.pane('60');
  if (!tf?.bars || tf.bars.length < 30) return out;
  if (!tf60?.bars || tf60.bars.length < 55) return out;

  // Skip NY-PM (12:00-16:00 ET). 3-year backtest: NY-PM is 35% win / -21.6R
  // over 123 trades vs Asian/London/NY-AM all ≥46%. VWAP loses its meaning
  // mid-day — institutions have already positioned for the session and stop
  // defending it. Drop the whole window rather than half-fix it.
  const np = nyParts(ctx.barTime);
  if (np.h >= 12 && np.h < 16) return out;

  const bars = tf.bars;
  const sessStart = nyDayStartUnix(ctx.barTime);
  const sessBars = bars.filter((b) => b.time >= sessStart);
  if (sessBars.length < 6) return out;
  const vwapVal = vwap(sessBars, sessStart);
  if (vwapVal == null) return out;

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const a = atr(bars, 14);
  const a60 = atr(tf60.bars, 14);
  if (!a || !a60) return out;
  // Skip dead tape — 15m ATR has to be at least 40% of H1 ATR
  if (a < 0.4 * a60) return out;

  // H1 trend filter with slope agreement
  const e50arr = ema(tf60.bars, 50);
  const e50last = e50arr[e50arr.length - 1];
  const e50prev = e50arr[e50arr.length - 4];
  const h1 = tf60.bars[tf60.bars.length - 1];
  if (e50last == null || e50prev == null) return out;
  const trendUp = h1.close > e50last && e50last >= e50prev;
  const trendDown = h1.close < e50last && e50last <= e50prev;
  if (!trendUp && !trendDown) return out;

  // LONG: H1 up + wick crossed VWAP from above + close back above + confirmation
  if (trendUp && last.low <= vwapVal && last.close > vwapVal + 0.3 * a
      && (isPinBar(last, 'bullish') || isEngulfing(prev, last, 'bullish'))) {
    const entry = last.close;
    const stop  = last.low - 0.5 * a;
    const risk  = entry - stop;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'LONG', 'vwap'),
      direction: 'LONG', timeframe: '15',
      confidence: qualityConfidence(meta.id, [
        (last.close - vwapVal) / (a * 1.5),         // body holds above VWAP
        (vwapVal - last.low) / a,                   // wick depth into VWAP
        Math.abs(h1.close - e50last) / (a60 * 1.5), // H1 trend strength
      ]),
      setupName: 'VWAP rejection · long',
      summary: `H1 up · wick into VWAP $${vwapVal.toFixed(2)} · ${isPinBar(last,'bullish') ? 'pin' : 'engulfing'} close`,
      entry, stop,
    }));
  } else if (trendDown && last.high >= vwapVal && last.close < vwapVal - 0.3 * a
      && (isPinBar(last, 'bearish') || isEngulfing(prev, last, 'bearish'))) {
    const entry = last.close;
    const stop  = last.high + 0.5 * a;
    const risk  = stop - entry;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'SHORT', 'vwap'),
      direction: 'SHORT', timeframe: '15',
      confidence: qualityConfidence(meta.id, [
        (vwapVal - last.close) / (a * 1.5),         // body holds below VWAP
        (last.high - vwapVal) / a,                  // wick depth into VWAP
        Math.abs(h1.close - e50last) / (a60 * 1.5), // H1 trend strength
      ]),
      setupName: 'VWAP rejection · short',
      summary: `H1 down · wick into VWAP $${vwapVal.toFixed(2)} · ${isPinBar(last,'bearish') ? 'pin' : 'engulfing'} close`,
      entry, stop,
    }));
  }
  for (const r of out) r.confirmations = ['H1 50-EMA trend', 'Wick crosses VWAP', 'Body holds the side', 'Pin/engulfing close'];
  return out;
}
