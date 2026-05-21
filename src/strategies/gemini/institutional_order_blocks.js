/**
 * Strategy GEM #3 — Institutional Order Blocks (SMC) (Gemini pack).
 *
 * Playbook (verbatim from SMC.pdf):
 *   - 1H for bias, 5m for entry (we promote to 15m entry due to 15m+ gate).
 *   - Identify 1H Order Blocks: last DOWN candle before strong impulsive
 *     UP move that broke market structure (bullish OB) — and mirror for bear.
 *   - Draw zone from open→low of that 1H candle.
 *   - When price taps into 1H OB, drop to LTF for CHoCH (lower-high break for
 *     bullish reclaim) — we use 15m close past last 15m swing as our CHoCH.
 *   - Entry on pullback into newly formed 15m order block.
 *   - SL just below 1H OB zone (liquidity-sweep buffer).
 *   - TP: next major liquidity pool (PDH or equal highs). Aim 1:2.5-1:4 RR.
 *
 * Internal id: GEM-SMC
 */

import { atr, findSwings, detectMSS, orderBlockBefore } from '../../lib/structure.js';
import { dayScopedId, buildTriggered, previousDayHL } from '../_helpers.js';
import { nyParts } from '../../lib/time.js';

const KEY = 'GEM-SMC';
const TF = '15';
const NAME = 'Institutional Order Blocks';

/** Identify recent 1H Order Blocks tied to a BOS. */
function findHourlyOBs(bars1h, atrVal) {
  const obs = [];
  const swingLookback = 2;
  const { highs, lows } = findSwings(bars1h, swingLookback);
  for (let i = 5; i < bars1h.length - 2; i++) {
    const impulse = bars1h[i];
    const body = Math.abs(impulse.close - impulse.open);
    if (body < 1.5 * atrVal) continue;
    // Bullish OB: down candle at i-1, impulse up at i, breaking prior swing high
    if (impulse.close > impulse.open && bars1h[i - 1].close < bars1h[i - 1].open) {
      const priorHigh = [...highs].reverse().find((h) => h.idx < i);
      if (priorHigh && impulse.close > priorHigh.price) {
        const ob = bars1h[i - 1];
        obs.push({ side: 'bullish', top: Math.max(ob.open, ob.close), bottom: ob.low, idx: i - 1, time: ob.time });
      }
    }
    // Bearish OB
    if (impulse.close < impulse.open && bars1h[i - 1].close > bars1h[i - 1].open) {
      const priorLow = [...lows].reverse().find((l) => l.idx < i);
      if (priorLow && impulse.close < priorLow.price) {
        const ob = bars1h[i - 1];
        obs.push({ side: 'bearish', top: ob.high, bottom: Math.min(ob.open, ob.close), idx: i - 1, time: ob.time });
      }
    }
  }
  // Filter to FRESH zones (not yet broken through by close)
  return obs.filter((z) => {
    for (let j = z.idx + 2; j < bars1h.length; j++) {
      const b = bars1h[j];
      if (z.side === 'bullish' && b.close < z.bottom) return false;
      if (z.side === 'bearish' && b.close > z.top) return false;
    }
    return true;
  });
}

export function evaluate(ctx) {
  const pane1h = ctx.panesByTf.get('gold|60');
  const pane15 = ctx.panesByTf.get(`gold|${TF}`);
  const daily = ctx.panesByTf.get('gold|1D') || ctx.panesByTf.get('gold|D');
  if (!pane1h || pane1h.bars.length < 80) return [];
  if (!pane15 || pane15.bars.length < 60) return [];

  const a1h = atr(pane1h.bars, 14);
  if (!a1h) return [];
  const obs = findHourlyOBs(pane1h.bars, a1h);
  if (obs.length === 0) return [];

  const bars15 = pane15.bars;
  const last = bars15[bars15.length - 1];
  if (!last) return [];

  // Find an OB that price is currently tapping
  const tapped = obs.find((z) => last.close >= z.bottom && last.close <= z.top);
  if (!tapped) return [];

  // 15m CHoCH check in the OB direction
  const direction = tapped.side === 'bullish' ? 'LONG' : 'SHORT';
  const mss = detectMSS(bars15, tapped.side, { displacementMult: 0.8, lookback: 12 });
  if (!mss) return [];
  // Entry on pullback to the just-formed 15m OB
  const ltfOB = orderBlockBefore(bars15, mss.idx, tapped.side);
  if (!ltfOB) return [];
  const entry = direction === 'LONG' ? ltfOB.body.top : ltfOB.body.bottom;
  // Price needs to be close to that entry
  const dist = Math.abs(last.close - entry);
  const a15 = atr(bars15, 14) || 1;
  if (dist > 0.6 * a15) return [];

  const stop = direction === 'LONG' ? tapped.bottom - 0.4 * a1h : tapped.top + 0.4 * a1h;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return [];
  // TP target: next major liquidity = PDH for LONG, PDL for SHORT (fall back to 2.5R)
  const pdhl = previousDayHL(daily);
  let t1 = direction === 'LONG' ? entry + 2.5 * risk : entry - 2.5 * risk;
  if (pdhl) {
    t1 = direction === 'LONG'
      ? Math.max(t1, pdhl.high)
      : Math.min(t1, pdhl.low);
  }
  const t2 = direction === 'LONG' ? entry + 4 * risk : entry - 4 * risk;

  const { dateKey } = nyParts(last.time);
  return [buildTriggered({
    strategy: KEY,
    setupId: dayScopedId(KEY, dateKey, direction, `ob-${Math.round(tapped.top)}-${Math.round(tapped.bottom)}`),
    direction,
    setupName: `${NAME} — ${direction} mitigation of 1H ${tapped.side} OB`,
    summary: `1H ${tapped.side} OB $${tapped.bottom.toFixed(2)}-$${tapped.top.toFixed(2)} tapped; 15m CHoCH + LTF OB entry.`,
    confidence: 0.79,
    timeframe: TF,
    entry, stop, t1, t2,
  })];
}
