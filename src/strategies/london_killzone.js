/**
 * Strategy: London Killzone Sweep
 *
 * London open (02:00-05:00 NY) typically runs the Asian range stops then
 * reverses for the true daily move. Trade the reversal after the sweep.
 */

import { atr } from '../lib/structure.js';
import { nyParts } from '../lib/time.js';
import { buildTriggered, dayScopedId, qualityConfidence, projectTrade } from './_helpers.js';

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
      direction: 'SHORT', timeframe: '15',
      confidence: qualityConfidence(meta.id, [
        (last.high - asianHi) / a,                                                  // sweep depth
        (asianHi - last.close) / a,                                                 // body closed back inside
        (last.high - Math.max(last.open, last.close)) / (last.high - last.low || 1), // upper-wick rejection
      ]),
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
      direction: 'LONG', timeframe: '15',
      confidence: qualityConfidence(meta.id, [
        (asianLo - last.low) / a,                                                    // sweep depth
        (last.close - asianLo) / a,                                                  // body closed back inside
        (Math.min(last.open, last.close) - last.low) / (last.high - last.low || 1),   // lower-wick rejection
      ]),
      setupName: 'London sweep of Asian low',
      summary: `Asian low $${asianLo.toFixed(2)} swept · body closed inside`,
      entry, stop, t1: entry + 1.3 * risk, t2: asianHi,
    }));
  }
  for (const r of out) r.confirmations = ['London killzone window', 'Asian range sweep', 'Body closed back inside'];
  return out;
}

// Live diagnostics for /setups. Conditions are tagged `gate` (hard prerequisite —
// strategy can't fire without it) or `trigger` (the catalyst that fires the
// alert when met). Bot only surfaces this strategy as "forming" when every
// gate is true; closeness then = fraction of triggers met.
export function precheck(ctx) {
  const tf = ctx.pane('15');
  if (!tf?.bars || tf.bars.length < 60) return null;
  const np = nyParts(ctx.barTime);
  const inWindow = np.h >= 2 && np.h < 5;

  const asianBars = tf.bars.filter((b) => {
    const p = nyParts(b.time);
    if (p.dateKey === ctx.dateKey && p.h < 2) return true;
    const dayMs = 24 * 3600 * 1000;
    if (ctx.barTime * 1000 - b.time * 1000 < dayMs && p.h >= 20) return true;
    return false;
  });
  const haveAsian = asianBars.length >= 5;
  const asianHi = haveAsian ? Math.max(...asianBars.map((b) => b.high)) : null;
  const asianLo = haveAsian ? Math.min(...asianBars.map((b) => b.low)) : null;
  const last = tf.bars[tf.bars.length - 1];

  const sweepHi = haveAsian && last.high > asianHi && last.close < asianHi;
  const sweepLo = haveAsian && last.low < asianLo && last.close > asianLo;
  const swept = sweepHi || sweepLo;
  const direction = sweepHi ? 'SHORT' : sweepLo ? 'LONG' : null;

  // Project what the trade would look like right now.
  const a = atr(tf.bars, 14);
  let projection = null;
  if (haveAsian && a) {
    if (direction === 'SHORT') {
      const entry = (last.high + asianHi) / 2;
      const stop = last.high + 0.3 * a;
      projection = projectTrade({ strategy: meta.id, direction: 'SHORT', entry, stop, t1: entry - 1.3 * (stop - entry), t2: asianLo });
    } else if (direction === 'LONG') {
      const entry = (last.low + asianLo) / 2;
      const stop = last.low - 0.3 * a;
      projection = projectTrade({ strategy: meta.id, direction: 'LONG', entry, stop, t1: entry + 1.3 * (entry - stop), t2: asianHi });
    }
  }
  return {
    direction,
    projection,
    conditions: [
      { kind: 'gate',    label: 'London killzone (02:00–05:00 ET)', met: inWindow, value: `${np.h}:${String(np.min||0).padStart(2,'0')} ET` },
      { kind: 'gate',    label: 'Asian range built',                met: haveAsian, value: haveAsian ? `hi ${asianHi.toFixed(2)} / lo ${asianLo.toFixed(2)} · ${asianBars.length} bars` : `only ${asianBars.length} bars (need 5)` },
      { kind: 'trigger', label: 'Sweep of Asian range',             met: swept, value: sweepHi ? `high ${asianHi.toFixed(2)} swept by ${(last.high - asianHi).toFixed(2)}` : sweepLo ? `low ${asianLo.toFixed(2)} swept by ${(asianLo - last.low).toFixed(2)}` : haveAsian ? `last ${last.low.toFixed(2)}–${last.high.toFixed(2)} inside` : '—' },
      { kind: 'trigger', label: 'Body closed back inside',          met: swept, value: haveAsian ? `close ${last.close.toFixed(2)} vs hi ${asianHi.toFixed(2)} / lo ${asianLo.toFixed(2)}` : '—' },
    ],
  };
}
