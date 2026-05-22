/**
 * Strategy: NY Killzone FVG Entry
 *
 * NY open (07:00-10:00 NY) frequently delivers an impulse move that leaves
 * a fair value gap. Trade the retracement into the gap.
 */

import { findFVGs, atr } from '../lib/structure.js';
import { ema } from '../lib/indicators.js';
import { nyParts } from '../lib/time.js';
import { buildTriggered, dayScopedId, qualityConfidence } from './_helpers.js';

export const meta = {
  id: 'NY-FVG',
  name: 'NY Killzone · FVG Retracement',
  concept: 'Impulse + 3-candle FVG during NY killzone, enter on retrace',
  window: 'NY killzone · 07:00-10:00 ET',
  timeframes: ['15'],
  defaultEnabled: true,
};

export const playbook = `# NY Killzone · FVG Retracement

## Concept
First hour of NY (07:00-10:00 NY) often delivers a clean impulse that leaves an unfilled 3-candle FVG. Price tends to revisit that gap before continuing — we enter on the retrace into the gap midpoint.

## Rules
1. **Session** — NY killzone (07:00-10:00 NY).
2. **FVG** — Newest bullish/bearish FVG formed in the last 8 bars on 15m.
3. **Retrace** — Latest bar pulled into the FVG zone (low or high inside the gap).

## Entry
- Limit at FVG midpoint.

## Stop loss
- 0.5 × ATR beyond the gap's far edge.

## Take profit
- TP1: 1.1 x risk  ·  TP2: 1.5 x risk  ·  SL: 1.0 x risk
`;

export function evaluate(ctx) {
  const out = [];
  const tf = ctx.pane('15');
  if (!tf?.bars || tf.bars.length < 30) return out;
  const np = nyParts(ctx.barTime);
  if (np.h < 7 || np.h >= 10) return out;
  const gaps = findFVGs(tf.bars, 50);
  if (!gaps?.length) return out;
  // Newest gap within last 8 bars
  const recent = gaps.filter((g) => g.idx >= tf.bars.length - 9);
  if (recent.length === 0) return out;
  const gap = recent[recent.length - 1];
  const last = tf.bars[tf.bars.length - 1];
  const a = atr(tf.bars, 14);
  if (!a) return out;

  // H1 trend filter — only trade the FVG retrace in the H1 trend direction.
  const tf60 = ctx.pane('60');
  if (!tf60?.bars || tf60.bars.length < 55) return out;
  const e50arr = ema(tf60.bars, 50);
  const e50last = e50arr[e50arr.length - 1];
  const h1 = tf60.bars[tf60.bars.length - 1];
  if (e50last == null) return out;
  const trendUp = h1.close > e50last;
  const trendDown = h1.close < e50last;

  // bullish FVG: price moves up, leaves gap; retrace = price comes back down to it
  if (trendUp && gap.side === 'bullish' && last.low <= gap.top && last.low >= gap.bottom) {
    const entry = (gap.top + gap.bottom) / 2;
    const stop  = gap.bottom - 0.5 * a;
    const risk  = entry - stop;
    const sessHi = Math.max(...tf.bars.slice(-20).map((b) => b.high));
    const gapSize = gap.top - gap.bottom;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'LONG', `fvg-${gap.time}`),
      direction: 'LONG', timeframe: '15',
      confidence: qualityConfidence(meta.id, [
        gapSize / a,                                        // gap displacement
        Math.abs(h1.close - e50last) / (e50last * 0.004),   // H1 trend strength
        1 - Math.abs(last.low - entry) / (gapSize / 2 || 1), // retrace centring
      ]),
      setupName: 'NY killzone FVG retrace',
      summary: `Bullish FVG ${gap.bottom.toFixed(2)}–${gap.top.toFixed(2)} retraced into`,
      entry, stop, t1: entry + 1.2 * risk, t2: sessHi,
    }));
  } else if (trendDown && gap.side === 'bearish' && last.high >= gap.bottom && last.high <= gap.top) {
    const entry = (gap.top + gap.bottom) / 2;
    const stop  = gap.top + 0.5 * a;
    const risk  = stop - entry;
    const sessLo = Math.min(...tf.bars.slice(-20).map((b) => b.low));
    const gapSize = gap.top - gap.bottom;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'SHORT', `fvg-${gap.time}`),
      direction: 'SHORT', timeframe: '15',
      confidence: qualityConfidence(meta.id, [
        gapSize / a,                                         // gap displacement
        Math.abs(h1.close - e50last) / (e50last * 0.004),    // H1 trend strength
        1 - Math.abs(last.high - entry) / (gapSize / 2 || 1), // retrace centring
      ]),
      setupName: 'NY killzone FVG retrace',
      summary: `Bearish FVG ${gap.bottom.toFixed(2)}–${gap.top.toFixed(2)} retraced into`,
      entry, stop, t1: entry - 1.2 * risk, t2: sessLo,
    }));
  }
  for (const r of out) r.confirmations = ['NY killzone window', '3-candle FVG', 'Retracement into gap'];
  return out;
}
