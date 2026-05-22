/**
 * Strategy: Asian Range Breakout
 *
 * Most days the Asian session range gets broken decisively during London/NY.
 * Trade the first 15m close that breaks the range with a wide-body bar.
 */

import { ema } from '../lib/indicators.js';
import { atr } from '../lib/structure.js';
import { nyParts } from '../lib/time.js';
import { buildTriggered, dayScopedId } from './_helpers.js';

export const meta = {
  id: 'ASIAN-BREAKOUT',
  name: 'Asian Range Breakout',
  concept: 'First 15m close beyond Asian session range with strong body',
  timeframes: ['15'],
  defaultEnabled: true,
};

export const playbook = `# Asian Range Breakout

## Concept
Asian range (20:00 prior NY → 02:00 NY) caps where the night algos sat. London/NY traders take it out cleanly when intent is real. We trade the first 15m close beyond the range with a body > 60% of the bar.

## Rules
1. **Time** — After 02:00 NY, before 10:00 NY (the breakout window).
2. **Range** — Asian session bars define hi/lo.
3. **Trigger** — Closing 15m bar's close > Asian hi (LONG) or < Asian lo (SHORT) AND |body|/range > 0.6.

## Entry
- Market at trigger close.

## Stop loss
- Mid of Asian range.

## Take profit
- TP1: 1.1 x risk  ·  TP2: 1.5 x risk  ·  SL: 1.0 x risk
`;

export function evaluate(ctx) {
  const out = [];
  const tf = ctx.pane('15');
  if (!tf?.bars || tf.bars.length < 40) return out;
  const np = nyParts(ctx.barTime);
  if (np.h < 2 || np.h >= 10) return out;

  // Asian range = prior day 20:00 NY → today 02:00 NY
  const asianBars = tf.bars.filter((b) => {
    const p = nyParts(b.time);
    if (p.dateKey === ctx.dateKey && p.h < 2) return true;
    const dayMs = 24 * 3600 * 1000;
    if (ctx.barTime * 1000 - b.time * 1000 < dayMs && p.h >= 20) return true;
    return false;
  });
  if (asianBars.length < 5) return out;
  const asianHi = Math.max(...asianBars.map((b) => b.high));
  const asianLo = Math.min(...asianBars.map((b) => b.low));
  const asianMid = (asianHi + asianLo) / 2;
  const asianRange = asianHi - asianLo;

  const last = tf.bars[tf.bars.length - 1];
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  if (range <= 0) return out;
  if (body / range < 0.62) return out;

  // H1 trend filter — only take breakouts aligned with the H1 50-EMA, and
  // require a real close beyond the range edge (not a marginal poke).
  const tf60 = ctx.pane('60');
  const a15 = atr(tf.bars, 14);
  if (!tf60?.bars || tf60.bars.length < 55 || !a15) return out;
  const e50 = ema(tf60.bars, 50);
  const e50last = e50[e50.length - 1];
  const h1 = tf60.bars[tf60.bars.length - 1];
  if (e50last == null) return out;
  const trendUp = h1.close > e50last;
  const trendDown = h1.close < e50last;
  const margin = 0.12 * a15;

  if (trendUp && last.close > asianHi + margin) {
    const entry = last.close, stop = asianMid, risk = entry - stop;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'LONG', 'asian-bo'),
      direction: 'LONG', timeframe: '15', confidence: 0.71,
      setupName: 'Asian range bullish breakout',
      summary: `Asian range $${asianRange.toFixed(2)} · close above $${asianHi.toFixed(2)}`,
      entry, stop, t1: entry + 1.2 * asianRange, t2: entry + 1.8 * asianRange,
    }));
  } else if (trendDown && last.close < asianLo - margin) {
    const entry = last.close, stop = asianMid, risk = stop - entry;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'SHORT', 'asian-bo'),
      direction: 'SHORT', timeframe: '15', confidence: 0.71,
      setupName: 'Asian range bearish breakout',
      summary: `Asian range $${asianRange.toFixed(2)} · close below $${asianLo.toFixed(2)}`,
      entry, stop,
    }));
  }
  for (const r of out) r.confirmations = ['Asian range defined', 'Close beyond range', 'Body > 60% bar'];
  return out;
}
