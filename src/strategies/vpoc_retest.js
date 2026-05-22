/**
 * Strategy: Volume Profile POC Retest (approximation)
 *
 * We don't have tick-by-tick volume profile, but we approximate the daily
 * Point of Control (POC) using session-weighted bars: the price where the
 * most bars closed. Retest = mean reversion magnet.
 */

import { isPinBar, isEngulfing } from '../lib/indicators.js';
import { atr } from '../lib/structure.js';
import { nyDayStartUnix } from '../lib/time.js';
import { buildTriggered, dayScopedId } from './_helpers.js';

export const meta = {
  id: 'VPOC-RETEST',
  name: 'Volume POC · Retest',
  concept: 'Approximated daily POC retest as mean-reversion magnet',
  timeframes: ['15'],
  defaultEnabled: true,
};

export const playbook = `# Volume POC · Retest

## Concept
The point of control (POC) is where the most volume traded — institutions defend it. Without tick data, we approximate POC as the closing-price bucket with the most bar closes during the prior session. When price tests POC from above on the next day and rejects, that's a reversion magnet entry.

## Rules
1. **Compute** — Prior NY session bars (00:00 → 17:00 NY) — bucket closes by 0.25 × ATR; POC = bucket with most closes.
2. **Touch** — Current 15m wick within 0.3 × ATR of POC.
3. **Trigger** — Rejection candle (pin or engulfing).

## Entry
- Market at trigger close.

## Stop loss
- 1.0 × ATR beyond POC on the wick side.

## Take profit
- TP1: 1.1 x risk  ·  TP2: 1.5 x risk  ·  SL: 1.0 x risk
`;

export function evaluate(ctx) {
  const out = [];
  const tf = ctx.pane('15');
  if (!tf?.bars || tf.bars.length < 80) return out;
  const a = atr(tf.bars, 14);
  if (!a) return out;

  // Prior session = full prior NY day
  const prevDayStart = nyDayStartUnix(ctx.barTime - 86400);
  const prevDayEnd = nyDayStartUnix(ctx.barTime);
  const prevBars = tf.bars.filter((b) => b.time >= prevDayStart && b.time < prevDayEnd);
  if (prevBars.length < 10) return out;

  // Bucket closes by 0.25 × ATR
  const bucketSize = 0.25 * a;
  const buckets = new Map();
  for (const b of prevBars) {
    const k = Math.round(b.close / bucketSize) * bucketSize;
    buckets.set(k, (buckets.get(k) || 0) + 1);
  }
  let poc = null, max = 0;
  for (const [k, count] of buckets) if (count > max) { max = count; poc = k; }
  if (poc == null) return out;

  const last = tf.bars[tf.bars.length - 1];
  const prev = tf.bars[tf.bars.length - 2];
  const tol = 0.3 * a;
  const sessHi = Math.max(...tf.bars.slice(-30).map((b) => b.high));
  const sessLo = Math.min(...tf.bars.slice(-30).map((b) => b.low));

  // Retest from above → SHORT
  if (Math.abs(last.high - poc) <= tol && last.high > poc && last.close < poc + tol
      && (isPinBar(last, 'bearish') || isEngulfing(prev, last, 'bearish'))) {
    const entry = last.close, stop = last.high + a, risk = stop - entry;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'SHORT', 'poc'),
      direction: 'SHORT', timeframe: '15', confidence: 0.71,
      setupName: 'POC retest from above', summary: `Prior-day POC ${poc.toFixed(2)} rejected from above`,
      entry, stop, t1: entry - 1.2 * risk, t2: sessLo,
    }));
  } else if (Math.abs(last.low - poc) <= tol && last.low < poc && last.close > poc - tol
      && (isPinBar(last, 'bullish') || isEngulfing(prev, last, 'bullish'))) {
    const entry = last.close, stop = last.low - a, risk = entry - stop;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'LONG', 'poc'),
      direction: 'LONG', timeframe: '15', confidence: 0.71,
      setupName: 'POC retest from below', summary: `Prior-day POC ${poc.toFixed(2)} bounced from below`,
      entry, stop, t1: entry + 1.2 * risk, t2: sessHi,
    }));
  }
  for (const r of out) r.confirmations = ['Prior-day POC computed', 'Wick at POC', 'Rejection candle'];
  return out;
}
