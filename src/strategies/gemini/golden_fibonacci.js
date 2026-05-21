/**
 * Strategy GEM #5 — Golden Fibonacci Pullback (Gemini pack).
 *
 * Playbook (verbatim from FIBBONACI.pdf):
 *   - 15m or 30m chart.
 *   - Confirm HH/HL bullish bias (we mirror for bearish via LH/LL).
 *   - Identify strong impulsive leg (usually early NY session).
 *   - Draw fib from swing low → swing high of that leg.
 *   - Wait for price to retrace into 'Golden Zone' (0.618–0.786).
 *   - Entry at 0.618 with smaller-TF bullish confirmation (we use 15m bar
 *     close since our 15m+ gate forbids 5m signals).
 *   - SL below 0.786 — break of 0.786 = invalidation.
 *   - TP at 0% (top of original swing high) → 1:2+ RR typical.
 *
 * Internal id: GEM-FIB
 */

import { findSwings, atr } from '../../lib/structure.js';
import { dayScopedId, buildTriggered, lastBullishRejection, lastBearishRejection } from '../_helpers.js';
import { nyParts } from '../../lib/time.js';

const KEY = 'GEM-FIB';
const TF = '15';
const NAME = 'Golden Fibonacci Pullback';

/** Find the most recent strong impulsive leg in the last `lookback` bars. */
function findImpulseLeg(bars, atrVal, lookback = 30) {
  const window = bars.slice(-lookback);
  const { highs, lows } = findSwings(window, 2);
  // Pair the most recent swing high with the most recent swing low BEFORE it
  // (for bullish impulse) and vice versa (for bearish).
  let bullish = null, bearish = null;
  if (highs.length && lows.length) {
    const hh = highs[highs.length - 1];
    const llBefore = [...lows].reverse().find((l) => l.idx < hh.idx);
    if (llBefore && hh.price - llBefore.price >= 3 * atrVal) {
      bullish = { low: llBefore.price, high: hh.price, lowIdx: llBefore.idx, highIdx: hh.idx };
    }
    const ll = lows[lows.length - 1];
    const hhBefore = [...highs].reverse().find((h) => h.idx < ll.idx);
    if (hhBefore && hhBefore.price - ll.price >= 3 * atrVal) {
      bearish = { high: hhBefore.price, low: ll.price, highIdx: hhBefore.idx, lowIdx: ll.idx };
    }
  }
  // Prefer the most recent one
  if (bullish && bearish) {
    return bullish.highIdx > bearish.lowIdx
      ? { ...bullish, direction: 'LONG' }
      : { ...bearish, direction: 'SHORT' };
  }
  if (bullish) return { ...bullish, direction: 'LONG' };
  if (bearish) return { ...bearish, direction: 'SHORT' };
  return null;
}

export function evaluate(ctx) {
  const pane = ctx.pane(TF);
  if (!pane || pane.bars.length < 80) return [];
  const bars = pane.bars;
  const last = bars[bars.length - 1];
  if (!last) return [];

  const a = atr(bars, 14);
  if (!a) return [];
  const leg = findImpulseLeg(bars, a, 40);
  if (!leg) return [];

  const range = leg.high - leg.low;
  // Golden zone 0.618–0.786
  const fib618 = leg.direction === 'LONG' ? leg.high - 0.618 * range : leg.low + 0.618 * range;
  const fib786 = leg.direction === 'LONG' ? leg.high - 0.786 * range : leg.low + 0.786 * range;

  // Is price currently in the golden zone?
  const zoneHi = Math.max(fib618, fib786);
  const zoneLo = Math.min(fib618, fib786);
  if (last.close < zoneLo || last.close > zoneHi) return [];

  // Bullish/bearish confirmation on the most recent closed bar
  const closedBars = bars.slice(0, -1);
  const ok = leg.direction === 'LONG'
    ? lastBullishRejection(closedBars)
    : lastBearishRejection(closedBars);
  if (!ok) return [];

  const entry = last.close;
  const stop = leg.direction === 'LONG' ? fib786 - 0.3 : fib786 + 0.3;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return [];
  const t1 = leg.direction === 'LONG' ? leg.high : leg.low; // 0% fib = swing high/low
  // If 0% fib gives < 2R, replace with 2R floor so trade is worth taking
  const minR = leg.direction === 'LONG' ? entry + 2 * risk : entry - 2 * risk;
  const t1Final = leg.direction === 'LONG' ? Math.max(t1, minR) : Math.min(t1, minR);
  const t2 = leg.direction === 'LONG' ? entry + 3 * risk : entry - 3 * risk;

  const { dateKey } = nyParts(last.time);
  return [buildTriggered({
    strategy: KEY,
    setupId: dayScopedId(KEY, dateKey, leg.direction, `fib-${Math.round(fib618)}`),
    direction: leg.direction,
    setupName: `${NAME} — ${leg.direction} at golden zone`,
    summary: `Impulse leg $${leg.low.toFixed(2)}-$${leg.high.toFixed(2)}; tap into 0.618-0.786 ($${zoneLo.toFixed(2)}-$${zoneHi.toFixed(2)}) with rejection.`,
    confidence: 0.74,
    timeframe: TF,
    entry, stop, t1: t1Final, t2,
  })];
}
