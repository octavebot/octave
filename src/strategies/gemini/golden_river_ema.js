/**
 * Strategy GEM #2 — The Golden River (EMA Trend) (Gemini pack).
 *
 * Playbook (verbatim from EMA TREND.pdf, Gemini):
 *   - 15m chart, indicators: 9 EMA, 21 EMA, 50 EMA, RSI(14).
 *   - 50 EMA sloping clearly up/down → directional bias.
 *   - 9 EMA crosses 21 EMA in direction of 50 EMA.
 *   - RSI > 50 for longs, < 50 for shorts.
 *   - Entry on the FIRST PULLBACK where price touches 21 EMA + rejection candle.
 *   - SL below swing low (long) / above swing high (short).
 *   - TP 2x risk. Trail along 21 EMA in profit.
 *
 * Internal id: GEM-EMA
 */

import { ema, rsiLast, isEngulfing, isPinBar } from '../../lib/indicators.js';
import { findSwings, atr } from '../../lib/structure.js';
import { dayScopedId, buildTriggered } from '../_helpers.js';
import { nyParts } from '../../lib/time.js';

const KEY = 'GEM-EMA';
const TF = '15';
const NAME = 'Golden River EMA';

export function evaluate(ctx) {
  const pane = ctx.panesByTf.get(`gold|${TF}`);
  if (!pane || pane.bars.length < 80) return [];
  const bars = pane.bars;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (!last || !prev) return [];

  const e9 = ema(bars, 9);
  const e21 = ema(bars, 21);
  const e50 = ema(bars, 50);
  const e9L = e9[e9.length - 1], e9P = e9[e9.length - 5];
  const e21L = e21[e21.length - 1];
  const e50L = e50[e50.length - 1], e50P = e50[e50.length - 6];
  if (e9L == null || e21L == null || e50L == null || e50P == null) return [];

  // 50 EMA slope clearly up/down — measured over 5 bars vs ~0.05% threshold
  const slope = (e50L - e50P) / e50P;
  const bullSlope = slope > 0.0005;
  const bearSlope = slope < -0.0005;
  if (!bullSlope && !bearSlope) return [];

  const direction = bullSlope ? 'LONG' : 'SHORT';

  // 9>21 in 50-EMA direction
  if (direction === 'LONG' && !(e9L > e21L)) return [];
  if (direction === 'SHORT' && !(e9L < e21L)) return [];

  // RSI gate
  const r = rsiLast(bars, 14);
  if (r == null) return [];
  if (direction === 'LONG' && r <= 50) return [];
  if (direction === 'SHORT' && r >= 50) return [];

  // Pullback to 21 EMA on prev OR current bar
  const touched = (b) => b.low <= e21L && b.high >= e21L;
  if (!touched(prev) && !touched(last)) return [];

  // Rejection candle in trend direction (engulfing or pin bar)
  const rejected = direction === 'LONG'
    ? (isEngulfing(prev, last, 'bullish') || isPinBar(last, 'bullish'))
    : (isEngulfing(prev, last, 'bearish') || isPinBar(last, 'bearish'));
  if (!rejected) return [];

  // SL strictly below/above recent swing
  const recent = bars.slice(-20);
  const { highs, lows } = findSwings(recent, 2);
  let stop;
  if (direction === 'LONG') {
    const swing = lows.length ? lows[lows.length - 1].price : Math.min(prev.low, last.low);
    stop = swing - 0.4;
  } else {
    const swing = highs.length ? highs[highs.length - 1].price : Math.max(prev.high, last.high);
    stop = swing + 0.4;
  }
  const entry = last.close;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return [];
  const t1 = direction === 'LONG' ? entry + 2 * risk : entry - 2 * risk;
  // Runner: ATR-extended target so the trader has somewhere to trail to
  const a = atr(bars, 14) || risk;
  const runner = direction === 'LONG' ? entry + 3.5 * risk : entry - 3.5 * risk;

  const { dateKey } = nyParts(last.time);
  return [buildTriggered({
    strategy: KEY,
    setupId: dayScopedId(KEY, dateKey, direction, 'golden-river'),
    direction,
    setupName: `${NAME} — ${direction} pullback to 21 EMA`,
    summary: `9>21 over 50 EMA (slope ${(slope * 100).toFixed(2)}%); RSI ${r.toFixed(0)}; rejection candle at 21 EMA $${e21L.toFixed(2)}.`,
    confidence: 0.75,
    timeframe: TF,
    entry, stop, t1, t2: t1, runner,
  })];
}
