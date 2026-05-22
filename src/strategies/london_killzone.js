/**
 * Strategy: London Killzone Sweep
 *
 * London open (02:00-05:00 NY) typically runs the Asian range stops then
 * reverses for the true daily move. Trade the reversal after the sweep.
 */

import { atr } from '../lib/structure.js';
import { nyParts } from '../lib/time.js';
import { buildTriggered, dayScopedId } from './_helpers.js';

export const meta = {
  id: 'LONDON-SWEEP',
  name: 'London Killzone · Asian Sweep Reversal',
  concept: 'London opens with a stop run on Asian range, then reverses',
  window: 'London killzone · 02:00-05:00 ET',
  timeframes: ['15'],
  defaultEnabled: true,
};

export const playbook = `# London Killzone · Asian Sweep Reversal

## Concept
Smart-money M.O. at the London open: spike through the Asian range to grab stops, then reverse for the real move. We wait for the sweep (wick beyond Asian H/L, close back inside) then enter on the rejection candle.

## Rules
1. **Session** — London killzone (02:00-05:00 NY).
2. **Asian range** — Bars from 20:00 prior day → 02:00 NY define Asian high/low.
3. **Sweep** — 15m wick beyond Asian H or L, body closes back inside.
4. **Direction** — Sweep high → SHORT, sweep low → LONG.

## Entry
- Limit at midpoint of sweep wick.

## Stop loss
- Beyond sweep wick + 0.3 × ATR.

## Take profit
- TP1: 1.1 x risk  ·  TP2: 1.5 x risk  ·  SL: 1.0 x risk
`;

export function evaluate(ctx) {
  const out = [];
  const tf = ctx.pane('15');
  if (!tf?.bars || tf.bars.length < 60) return out;
  const np = nyParts(ctx.barTime);
  if (np.h < 2 || np.h >= 5) return out; // London killzone only

  // Build Asian range from prior 20:00 → today 02:00 NY
  const asianBars = tf.bars.filter((b) => {
    const p = nyParts(b.time);
    if (p.dateKey === ctx.dateKey && p.h < 2) return true;
    // previous day after 20:00
    const prev = new Date(b.time * 1000);
    const dayMs = 24 * 3600 * 1000;
    const ctxDate = new Date(ctx.barTime * 1000);
    if (ctxDate.getTime() - prev.getTime() < dayMs && p.h >= 20) return true;
    return false;
  });
  if (asianBars.length < 5) return out;
  const asianHi = Math.max(...asianBars.map((b) => b.high));
  const asianLo = Math.min(...asianBars.map((b) => b.low));
  const last = tf.bars[tf.bars.length - 1];
  const a = atr(tf.bars, 14);
  if (!a) return out;

  // Sweep above → SHORT
  if (last.high > asianHi && last.close < asianHi) {
    const sweepMid = (last.high + asianHi) / 2;
    const entry = sweepMid;
    const stop  = last.high + 0.3 * a;
    const risk  = stop - entry;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'SHORT', 'asian-hi'),
      direction: 'SHORT', timeframe: '15', confidence: 0.74,
      setupName: 'London sweep of Asian high',
      summary: `Asian high $${asianHi.toFixed(2)} swept · body closed inside`,
      entry, stop, t1: entry - 1.3 * risk, t2: asianLo,
    }));
  } else if (last.low < asianLo && last.close > asianLo) {
    const sweepMid = (last.low + asianLo) / 2;
    const entry = sweepMid;
    const stop  = last.low - 0.3 * a;
    const risk  = entry - stop;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'LONG', 'asian-lo'),
      direction: 'LONG', timeframe: '15', confidence: 0.74,
      setupName: 'London sweep of Asian low',
      summary: `Asian low $${asianLo.toFixed(2)} swept · body closed inside`,
      entry, stop, t1: entry + 1.3 * risk, t2: asianHi,
    }));
  }
  for (const r of out) r.confirmations = ['London killzone window', 'Asian range sweep', 'Body closed back inside'];
  return out;
}
