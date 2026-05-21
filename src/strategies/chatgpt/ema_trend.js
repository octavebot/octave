/**
 * Strategy CGT #3 — EMA Trend Continuation (ChatGPT pack).
 *
 * Playbook (verbatim from EMA TREND.pdf):
 *   - 20 EMA + 50 EMA on 15m chart.
 *   - Trade only in direction of EMA alignment (price > 50EMA & 20>50 = LONG).
 *   - Wait for pullback INTO 20 EMA (price touches or crosses 20 EMA).
 *   - Enter on bullish/bearish engulfing candle in trend direction.
 *   - SL below recent swing.
 *   - TP at 2R.
 *
 * Internal id: CGT-EMA
 */

import { emaLast, ema, isEngulfing } from '../../lib/indicators.js';
import { findSwings, atr } from '../../lib/structure.js';
import { dayScopedId, buildTriggered } from '../_helpers.js';
import { nyParts } from '../../lib/time.js';

const KEY = 'CGT-EMA';
const TF = '15';
const NAME = 'EMA Trend Continuation';

export function evaluate(ctx) {
  const pane = ctx.pane(TF);
  if (!pane || pane.bars.length < 80) return [];
  const bars = pane.bars;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (!last || !prev) return [];

  const ema20Series = ema(bars, 20);
  const ema50Series = ema(bars, 50);
  const ema20 = ema20Series[ema20Series.length - 1];
  const ema50 = ema50Series[ema50Series.length - 1];
  if (ema20 == null || ema50 == null) return [];

  const aligned = (ema20 > ema50) && (last.close > ema50);
  const alignedShort = (ema20 < ema50) && (last.close < ema50);
  if (!aligned && !alignedShort) return [];

  // Pullback to 20 EMA: prev OR current touched it (low ≤ ema20 ≤ high)
  const touchedPrev = prev.low <= ema20 && prev.high >= ema20;
  const touchedCur = last.low <= ema20 && last.high >= ema20;
  if (!touchedPrev && !touchedCur) return [];

  const direction = aligned ? 'LONG' : 'SHORT';
  const engulf = isEngulfing(prev, last, aligned ? 'bullish' : 'bearish');
  if (!engulf) return [];

  // SL below/above recent swing (within last ~12 bars)
  const recent = bars.slice(-20);
  const { highs, lows } = findSwings(recent, 2);
  let stop;
  if (direction === 'LONG') {
    const swing = lows.length ? lows[lows.length - 1].price : Math.min(prev.low, last.low);
    stop = swing - 0.5; // tiny buffer below swing
  } else {
    const swing = highs.length ? highs[highs.length - 1].price : Math.max(prev.high, last.high);
    stop = swing + 0.5;
  }

  const entry = last.close;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return [];
  const t1 = direction === 'LONG' ? entry + 2 * risk : entry - 2 * risk;
  // Add a TP2 / runner using ATR-based trail logic so the alerter has something
  // to draw beyond the spec 2R target — purely additive context for the trader.
  const a = atr(bars, 14) || risk;
  const runner = direction === 'LONG' ? entry + 3.5 * risk : entry - 3.5 * risk;

  const { dateKey } = nyParts(last.time);
  return [buildTriggered({
    strategy: KEY,
    setupId: dayScopedId(KEY, dateKey, direction, 'pullback'),
    direction,
    setupName: `${NAME} — ${direction} pullback to 20 EMA`,
    summary: `EMA aligned (${direction}); engulfing on pullback to 20 EMA at $${ema20.toFixed(2)}`,
    confidence: 0.72,
    timeframe: TF,
    entry, stop, t1, t2: t1, runner,
  })];
}
