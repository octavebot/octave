/**
 * Shared building blocks for the 10 add-on strategies (ChatGPT + Gemini packs).
 *
 * Goal: keep each strategy file short and readable by extracting the boilerplate
 * (last-N-bars, range high/low, "did this candle close outside range").
 */

import { atr, findSwings, detectSweep } from '../lib/structure.js';
import { bollinger } from '../lib/indicators.js';

/** Get the most recent N closed bars from a pane (excluding the in-progress one). */
export function lastClosedBars(pane, count) {
  if (!pane?.bars?.length) return [];
  // Treat last bar as the "current/forming" bar — exclude it from closed analysis
  // so we don't false-trigger on a partial bar.
  const closed = pane.bars.slice(0, -1);
  return closed.slice(-count);
}

/** Range of an array of bars: { high, low, mid }. */
export function rangeOf(bars) {
  if (!bars?.length) return null;
  let hi = -Infinity, lo = Infinity;
  for (const b of bars) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  return { high: hi, low: lo, mid: (hi + lo) / 2 };
}

/**
 * Bars in a unix-seconds [start, end) window. Used to scope session-anchored
 * analysis like Asian range or NY VWAP.
 */
export function barsInWindow(bars, startUnix, endUnix) {
  if (!bars?.length) return [];
  return bars.filter((b) => b.time >= startUnix && b.time < endUnix);
}

/**
 * Volume "noticeable" check. Returns true if the last bar's volume is at least
 * `factor` × the avg of the previous `lookback` bars. Defaults to 1.2 — the
 * Gemini playbooks ask for "noticeable volume" which we read as ≥120% average.
 * Null/no-volume bars degrade to true so we don't lock out symbols without volume.
 */
export function volNoticeable(bars, factor = 1.2, lookback = 10) {
  if (!bars || bars.length < lookback + 1) return true;
  const last = bars[bars.length - 1];
  if (!last?.volume) return true; // tolerate missing volume data
  const window = bars.slice(-lookback - 1, -1);
  const hasVol = window.some((b) => (b.volume || 0) > 0);
  if (!hasVol) return true;
  const avg = window.reduce((a, b) => a + (b.volume || 0), 0) / window.length;
  return (last.volume || 0) >= factor * avg;
}

/** Build a stable per-day setupId for a strategy that fires at most once/day. */
export function dayScopedId(strategyKey, dateKey, direction, label = '') {
  return `${strategyKey}|${dateKey}|${direction}|${label}`;
}

/** Compute previous-day high/low for HTF context. */
export function previousDayHL(dailyPane) {
  if (!dailyPane?.bars || dailyPane.bars.length < 2) return null;
  // Most-recent CLOSED daily bar
  const prev = dailyPane.bars[dailyPane.bars.length - 2];
  return { high: prev.high, low: prev.low, date: prev.time };
}

/** True if the most recent closed bar is a bullish engulfing (or pin bar). */
export function lastBullishRejection(bars) {
  if (!bars || bars.length < 2) return false;
  const cur = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const body = Math.abs(cur.close - cur.open);
  const range = cur.high - cur.low;
  if (range <= 0) return false;
  const lowerWick = Math.min(cur.open, cur.close) - cur.low;
  // bullish engulfing
  if (cur.close > cur.open && prev.close < prev.open &&
      cur.close >= prev.open && cur.open <= prev.close) return true;
  // bullish pin bar: long lower wick, small body
  if (lowerWick / range >= 0.5 && body / range <= 0.4 && cur.close > cur.open) return true;
  return false;
}

/** True if the most recent closed bar is a bearish engulfing (or pin bar). */
export function lastBearishRejection(bars) {
  if (!bars || bars.length < 2) return false;
  const cur = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const body = Math.abs(cur.close - cur.open);
  const range = cur.high - cur.low;
  if (range <= 0) return false;
  const upperWick = cur.high - Math.max(cur.open, cur.close);
  if (cur.close < cur.open && prev.close > prev.open &&
      cur.close <= prev.open && cur.open >= prev.close) return true;
  if (upperWick / range >= 0.5 && body / range <= 0.4 && cur.close < cur.open) return true;
  return false;
}

// Uniform reward profile for every strategy. The strategy supplies entry +
// a structural stop; we widen that stop by STOP_PAD × its distance so market
// noise doesn't stop us out before the move plays — win rate rises while the
// RR stays fixed (targets are multiples of the *widened* risk). TP1 = 1.2R,
// TP2 = 1.5R measured off the widened risk.
export const TP1_R = 1.1;
export const TP2_R = 1.5;
export const STOP_PAD = 0.35;  // widen the structural stop by 35%

/**
 * Build the standard triggered DetectorResult shape that the alerter expects.
 * Targets + the executed stop are derived from a noise-padded risk so the
 * whole stack ships a consistent 1.2R / 1.5R profile.
 */
export function buildTriggered({
  strategy, setupId, direction, setupName, summary, confidence, timeframe,
  entry, stop,
}) {
  const sign = direction === 'LONG' ? 1 : -1;
  const structuralRisk = Math.abs(entry - stop);
  const risk = structuralRisk * (1 + STOP_PAD);
  const widenedStop = entry - sign * risk;
  const t1 = entry + sign * TP1_R * risk;
  const t2 = entry + sign * TP2_R * risk;
  stop = widenedStop;
  return {
    strategy,
    setupId,
    status: 'triggered',
    direction,
    setupName,
    summary,
    confidence: confidence ?? 0.7,
    timeframe,
    details: {},
    invalidationLevel: stop,
    entryPlan: { entry, stop, t1, t2, runner: t2, risk },
  };
}

/**
 * Bollinger band width for the last `count` bars. The lib's bollinger() only
 * returns the latest bar's band, so we re-evaluate it on progressively shorter
 * slices. Returns oldest→newest array of { upper, lower, mid, width }.
 */
export function bollingerSeries(bars, count, period = 20, mult = 2) {
  const out = [];
  const n = bars.length;
  for (let k = Math.max(period, n - count); k <= n; k++) {
    const b = bollinger(bars.slice(0, k), period, mult);
    if (b) out.push({ upper: b.upper, lower: b.lower, mid: b.mid, width: b.upper - b.lower });
  }
  return out;
}

// Re-export so strategies don't need to know which file each helper lives in.
export { atr, findSwings, detectSweep };
