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
1. **Daily bias** — D1 close > 20-EMA AND 20-EMA sloping up → LONG only.
   D1 close < 20-EMA AND 20-EMA sloping down → SHORT only.
2. **H1 pullback** — Any of the last 5 H1 bars wicked into a 0.6 × ATR(H1)
   band around the H1 20-EMA.
3. **15m proximity** — The current 15m bar itself wicks within 0.4 × ATR(15m)
   of the H1 20-EMA — we're trading the pullback live, not after it ended.
4. **15m rejection** — Engulfing or pin bar in the bias direction. Bar must
   close past the prior 15m bar's high (long) or low (short) — commitment
   beyond the pullback, not just a wick touch.

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

  // Daily bias: D1 close vs 20-EMA, EMA slope confirmation. ALSO require a
  // minimum daily ATR to confirm there's real movement in the trend — flat
  // markets with technically-up EMAs but no displacement produce false signals.
  // 3y backtest finding: longs at 42% (+1.9R/400 trades) were dragged by
  // weak-trend days; shorts held 51% (+27.6R/180 trades) because down-trends
  // tend to be sharper. The displacement filter targets the weak-trend
  // false-positive pattern without overfitting to instrument or session.
  const d20 = ema(dPane.bars, 20);
  const d20last = d20[d20.length - 1];
  const d20prev = d20[d20.length - 3];
  const dlast = dPane.bars[dPane.bars.length - 1];
  if (d20last == null || d20prev == null) return out;
  const aD = atr(dPane.bars, 14);
  if (!aD) return out;
  // Require D1 close to be ≥ 0.3 × D1-ATR away from the 20-EMA — real
  // separation, not just barely-above noise.
  const trendStrength = Math.abs(dlast.close - d20last);
  if (trendStrength < 0.3 * aD) return out;
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

  // Engulfing or pin in the bias direction. The "took prev high/low" filter
  // is the real quality gate — without it, any micro-rejection at the EMA
  // qualifies and the win rate halves. With it, we demand commitment past
  // the pullback's last bar before entering.
  const rejBull = isEngulfing(prev, last, 'bullish') || isPinBar(last, 'bullish');
  const tookPrevHigh = last.close > prev.high;
  if (dailyUp && rejBull && tookPrevHigh && last.close > last.open) {
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
  const rejBear = isEngulfing(prev, last, 'bearish') || isPinBar(last, 'bearish');
  const tookPrevLow = last.close < prev.low;
  if (dailyDown && rejBear && tookPrevLow && last.close < last.open) {
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

export function precheck(ctx) {
  const tf = ctx.pane('15');
  const tf60 = ctx.pane('60');
  const dPane = ctx.pane('1D');
  if (!tf?.bars || tf.bars.length < 30) return null;
  if (!tf60?.bars || tf60.bars.length < 50) return null;
  if (!dPane?.bars || dPane.bars.length < 25) return null;

  const d20 = ema(dPane.bars, 20);
  const d20last = d20[d20.length - 1];
  const d20prev = d20[d20.length - 3];
  const dlast = dPane.bars[dPane.bars.length - 1];
  const aD = atr(dPane.bars, 14);
  if (d20last == null || d20prev == null || !aD) return null;

  const trendStrength = Math.abs(dlast.close - d20last);
  const trendStrong = trendStrength >= 0.3 * aD;
  const dailyUp = dlast.close > d20last && d20last > d20prev;
  const dailyDown = dlast.close < d20last && d20last < d20prev;
  const direction = dailyUp ? 'LONG' : dailyDown ? 'SHORT' : null;

  const h20 = ema(tf60.bars, 20);
  const h20last = h20[h20.length - 1];
  const aH1 = atr(tf60.bars, 14);
  const a15 = atr(tf.bars, 14);
  if (h20last == null || !aH1 || !a15) return null;
  const tol = 0.6 * aH1;
  const recent5 = tf60.bars.slice(-5);
  const h1Touched = recent5.some((b) => b.low - tol <= h20last && b.high + tol >= h20last);

  const last = tf.bars[tf.bars.length - 1];
  const prev = tf.bars[tf.bars.length - 2];
  const proximityTol = 0.4 * a15;
  const lastTouches = last.low - proximityTol <= h20last && last.high + proximityTol >= h20last;

  const rejBull = dailyUp && (isEngulfing(prev, last, 'bullish') || isPinBar(last, 'bullish')) && last.close > prev.high && last.close > last.open;
  const rejBear = dailyDown && (isEngulfing(prev, last, 'bearish') || isPinBar(last, 'bearish')) && last.close < prev.low && last.close < last.open;

  return {
    direction,
    conditions: [
      { label: 'Daily trend established', met: !!direction && trendStrong, value: direction ? `D1 ${direction === 'LONG' ? 'above' : 'below'} 20-EMA${trendStrong ? '' : ' (weak)'}` : 'flat' },
      { label: 'H1 pulled back to 20-EMA', met: h1Touched, value: h1Touched ? `within ${tol.toFixed(2)}` : 'not pulled back' },
      { label: '15m bar at pullback now', met: lastTouches, value: lastTouches ? 'in zone' : `${(Math.abs(last.close - h20last)).toFixed(2)} away` },
      { label: '15m rejection candle', met: rejBull || rejBear, value: rejBull ? 'bullish reject + took prev high' : rejBear ? 'bearish reject + took prev low' : 'no rejection yet' },
    ],
  };
}
