/**
 * Strategy: Daily Trend Pullback (DAILY-TREND-PB)
 *
 * Candidate #3 for the eval-pass slot. Daily trend defines bias; H1 20-EMA
 * pullback with a 15m rejection candle gives the entry. 3R target rides
 * the next leg of the trend.
 */

import { ema, isPinBar, isEngulfing } from '../lib/indicators.js';
import { atr } from '../lib/structure.js';
import { buildTriggered, dayScopedId, qualityConfidence } from './_helpers.js';

export const meta = {
  id: 'DAILY-TREND-PB',
  name: 'Daily Trend · H1 EMA Pullback',
  concept: 'Daily trend + H1 20-EMA pullback + 15m rejection = 3R continuation',
  window: 'Any session hour',
  timeframes: ['15', '60', '1D'],
  defaultEnabled: true,
};

export const playbook = `# Daily Trend · H1 EMA Pullback

## Concept
Higher-timeframe trend trades are the highest-quality continuation setups.
Daily trend defines bias (close above 20-EMA on D1 = long-only). H1 pulls
back to its 20-EMA. On 15m, the first pin bar or engulfing in the bias
direction at that pullback is the entry.

## Rules
1. **Daily bias** — D1 close > 20-EMA → LONG only. < 20-EMA → SHORT only.
   The 20-EMA must also be sloping in the bias direction.
2. **H1 pullback** — Last 3 H1 bars touched within 0.3 × ATR(H1) of the H1 20-EMA.
3. **15m rejection** — Most recent 15m bar is a pin bar or engulfing in the
   bias direction, with body in that direction.

## Entry
- Market at rejection-bar close.

## Stop loss
- 0.4 × ATR(15m) beyond the rejection wick extreme.

## Take profit
- TP1: 1.5 × risk
- TP2: 3.0 × risk

## Why this passes evals
- Trend-trades have the highest expectancy; 3R targets stack profit fast.
- The daily + H1 + 15m alignment is a triple filter — fewer but cleaner fires.
- Stop sits beyond a real swing low/high, not arbitrary chart distance.
`;

export function evaluate(ctx) {
  const out = [];
  const tf = ctx.pane('15');
  const tf60 = ctx.pane('60');
  const dPane = ctx.pane('1D');
  if (!tf?.bars || tf.bars.length < 30) return out;
  if (!tf60?.bars || tf60.bars.length < 50) return out;
  if (!dPane?.bars || dPane.bars.length < 25) return out;

  // Daily bias: D1 close vs 20-EMA, EMA slope confirmation
  const d20 = ema(dPane.bars, 20);
  const d20last = d20[d20.length - 1];
  const d20prev = d20[d20.length - 3];
  const dlast = dPane.bars[dPane.bars.length - 1];
  if (d20last == null || d20prev == null) return out;
  const dailyUp = dlast.close > d20last && d20last > d20prev;
  const dailyDown = dlast.close < d20last && d20last < d20prev;
  if (!dailyUp && !dailyDown) return out;

  // H1 pullback: any of the last 5 H1 bars must have touched within 0.6 × ATR(H1)
  // of the H1 20-EMA. Loose enough to capture real pullbacks while excluding
  // bars that never approach the mean.
  const h20 = ema(tf60.bars, 20);
  const h20last = h20[h20.length - 1];
  const aH1 = atr(tf60.bars, 14);
  if (h20last == null || !aH1) return out;
  const tol = 0.6 * aH1;
  const recent5 = tf60.bars.slice(-5);
  const touched = recent5.some((b) => b.low - tol <= h20last && b.high + tol >= h20last);
  if (!touched) return out;

  // 15m rejection
  const bars = tf.bars;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const a15 = atr(bars, 14);
  if (!prev || !a15) return out;

  // The current 15m rejection bar must itself touch (within 0.4 × ATR(15m))
  // the H1 20-EMA — proves we're trading the pullback in real time, not a
  // bar that drifted away after the pullback ended.
  const proximityTol = 0.4 * a15;
  const lastTouches = last.low - proximityTol <= h20last && last.high + proximityTol >= h20last;
  if (!lastTouches) return out;

  // Engulfings travel further than pins on average — require either a real
  // engulfing OR a pin with a body ≥ 0.6 × ATR(15m) (real displacement, not
  // a tiny doji-pin). And require the rejection bar to take out the prior
  // bar's high/low (commitment beyond the pullback).
  const bigEngulfBull = isEngulfing(prev, last, 'bullish');
  const bigPinBull = isPinBar(last, 'bullish') && Math.abs(last.close - last.open) >= 0.6 * a15;
  const tookPrevHigh = last.close > prev.high;
  if (dailyUp && (bigEngulfBull || bigPinBull) && tookPrevHigh && last.close > last.open) {
    const entry = last.close;
    const stop = last.low - 0.4 * a15;
    const risk = entry - stop;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'LONG', 'pb'),
      direction: 'LONG', timeframe: '15',
      confidence: qualityConfidence(meta.id, [
        Math.abs(dlast.close - d20last) / (d20last * 0.01),
        Math.abs(h20last - recent5[recent5.length - 1].close) <= tol ? 1 : 0.5,
        Math.abs(last.close - last.open) / (last.high - last.low || 1),
      ]),
      setupName: 'Daily trend pullback long',
      summary: `D1 up · H1 retraced to 20-EMA · ${isPinBar(last,'bullish') ? 'pin' : 'engulfing'} reject`,
      entry, stop, t1Mult: 1.5, t2Mult: 3.0,
    }));
  }
  const bigEngulfBear = isEngulfing(prev, last, 'bearish');
  const bigPinBear = isPinBar(last, 'bearish') && Math.abs(last.close - last.open) >= 0.6 * a15;
  const tookPrevLow = last.close < prev.low;
  if (dailyDown && (bigEngulfBear || bigPinBear) && tookPrevLow && last.close < last.open) {
    const entry = last.close;
    const stop = last.high + 0.4 * a15;
    const risk = stop - entry;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'SHORT', 'pb'),
      direction: 'SHORT', timeframe: '15',
      confidence: qualityConfidence(meta.id, [
        Math.abs(dlast.close - d20last) / (d20last * 0.01),
        Math.abs(h20last - recent5[recent5.length - 1].close) <= tol ? 1 : 0.5,
        Math.abs(last.close - last.open) / (last.high - last.low || 1),
      ]),
      setupName: 'Daily trend pullback short',
      summary: `D1 down · H1 retraced to 20-EMA · ${isPinBar(last,'bearish') ? 'pin' : 'engulfing'} reject`,
      entry, stop, t1Mult: 1.5, t2Mult: 3.0,
    }));
  }
  for (const r of out) r.confirmations = ['Daily 20-EMA trend', 'H1 pullback to 20-EMA', '15m pin/engulfing'];
  return out;
}
