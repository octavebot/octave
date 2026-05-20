/**
 * Classical technical indicators used by Strategy #4 (Adaptive Gold Matrix).
 *
 * All functions operate on ascending OHLCV bar arrays.
 * Each returns either a number (latest value) or an array (full series).
 */

import { findSwings } from './structure.js';

/** Exponential Moving Average — returns full series. */
export function ema(bars, period) {
  if (!bars || bars.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(bars.length).fill(null);
  // Seed with SMA over the first `period` closes
  let sum = 0;
  for (let i = 0; i < period; i++) sum += bars[i].close;
  out[period - 1] = sum / period;
  for (let i = period; i < bars.length; i++) {
    out[i] = bars[i].close * k + out[i - 1] * (1 - k);
  }
  return out;
}

/** Latest EMA value, or null if insufficient data. */
export function emaLast(bars, period) {
  const s = ema(bars, period);
  return s.length ? s[s.length - 1] : null;
}

/** Wilder's RSI — returns full series. */
export function rsi(bars, period = 14) {
  if (!bars || bars.length < period + 1) return [];
  const out = new Array(bars.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    if (ch > 0) gain += ch; else loss -= ch;
  }
  gain /= period;
  loss /= period;
  out[period] = 100 - 100 / (1 + (loss === 0 ? Infinity : gain / loss));
  for (let i = period + 1; i < bars.length; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = 100 - 100 / (1 + (loss === 0 ? Infinity : gain / loss));
  }
  return out;
}

export function rsiLast(bars, period = 14) {
  const s = rsi(bars, period);
  return s.length ? s[s.length - 1] : null;
}

/** Wilder's ADX — returns the most recent value (and DI+/DI-). */
export function adx(bars, period = 14) {
  if (!bars || bars.length < period * 2 + 1) return null;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    const ph = bars[i - 1].high, pl = bars[i - 1].low;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph;
    const dn = pl - l;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
  }
  // Wilder smoothing
  let trS = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let pS = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let mS = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  const dxs = [];
  for (let i = period; i < tr.length; i++) {
    trS = trS - trS / period + tr[i];
    pS = pS - pS / period + plusDM[i];
    mS = mS - mS / period + minusDM[i];
    const plusDI = (pS / trS) * 100;
    const minusDI = (mS / trS) * 100;
    const sum = plusDI + minusDI;
    const dx = sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100;
    dxs.push({ dx, plusDI, minusDI });
  }
  if (dxs.length < period) return null;
  // ADX = Wilder average of DX over `period`
  let adxVal = dxs.slice(0, period).reduce((a, b) => a + b.dx, 0) / period;
  for (let i = period; i < dxs.length; i++) {
    adxVal = (adxVal * (period - 1) + dxs[i].dx) / period;
  }
  const last = dxs[dxs.length - 1];
  return { adx: adxVal, plusDI: last.plusDI, minusDI: last.minusDI };
}

/** MACD (fast=12, slow=26, signal=9). Returns latest {macd, signal, hist}. */
export function macd(bars, fast = 12, slow = 26, signal = 9) {
  if (!bars || bars.length < slow + signal) return null;
  const emaFast = ema(bars, fast);
  const emaSlow = ema(bars, slow);
  const macdLine = bars.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  // Signal line: EMA of macdLine starting where it has values
  const firstIdx = macdLine.findIndex((v) => v != null);
  if (firstIdx < 0) return null;
  const valid = macdLine.slice(firstIdx).filter((v) => v != null);
  if (valid.length < signal) return null;
  const k = 2 / (signal + 1);
  let sig = valid.slice(0, signal).reduce((a, b) => a + b, 0) / signal;
  for (let i = signal; i < valid.length; i++) sig = valid[i] * k + sig * (1 - k);
  const lastMacd = valid[valid.length - 1];
  return { macd: lastMacd, signal: sig, hist: lastMacd - sig };
}

// ---------- candlestick patterns ----------

/** Is the most recent bar a pin bar (long wick rejection) in `direction`? */
export function isPinBar(bar, direction) {
  const range = bar.high - bar.low;
  if (range <= 0) return false;
  const body = Math.abs(bar.close - bar.open);
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  const lowerWick = Math.min(bar.open, bar.close) - bar.low;
  if (body / range > 0.35) return false; // body must be small
  if (direction === 'bullish') return lowerWick / range >= 0.55 && upperWick / range <= 0.25;
  return upperWick / range >= 0.55 && lowerWick / range <= 0.25;
}

/** Engulfing pattern: previous bar engulfed by current in `direction`. */
export function isEngulfing(prev, curr, direction) {
  if (!prev || !curr) return false;
  const prevBody = { lo: Math.min(prev.open, prev.close), hi: Math.max(prev.open, prev.close) };
  const currBody = { lo: Math.min(curr.open, curr.close), hi: Math.max(curr.open, curr.close) };
  const currBullish = curr.close > curr.open;
  const currBearish = curr.close < curr.open;
  if (direction === 'bullish') {
    return currBullish && prev.close < prev.open && currBody.lo <= prevBody.lo && currBody.hi >= prevBody.hi;
  }
  return currBearish && prev.close > prev.open && currBody.lo <= prevBody.lo && currBody.hi >= prevBody.hi;
}

/** Detect a rejection candle (pin bar OR engulfing) in `direction` on the LAST closed bar. */
export function rejectionCandle(bars, direction) {
  if (!bars || bars.length < 2) return null;
  const curr = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (isPinBar(curr, direction)) return { kind: 'pin', bar: curr };
  if (isEngulfing(prev, curr, direction)) return { kind: 'engulfing', bar: curr };
  return null;
}

// ---------- RSI divergence ----------

/**
 * Detect simple RSI divergence on the recent N swings.
 *   Bearish: price higher-high, RSI lower-high
 *   Bullish: price lower-low,  RSI higher-low
 */
export function rsiDivergence(bars, swingLookback = 3, rsiPeriod = 14) {
  const rsiSeries = rsi(bars, rsiPeriod);
  if (rsiSeries.length === 0) return null;
  const { highs, lows } = findSwings(bars, swingLookback);
  // Bearish: last two swing highs
  let bearish = null;
  if (highs.length >= 2) {
    const h2 = highs[highs.length - 1];
    const h1 = highs[highs.length - 2];
    const r1 = rsiSeries[h1.idx];
    const r2 = rsiSeries[h2.idx];
    if (r1 != null && r2 != null && h2.price > h1.price && r2 < r1) {
      bearish = { from: h1, to: h2, rsiFrom: r1, rsiTo: r2 };
    }
  }
  // Bullish: last two swing lows
  let bullish = null;
  if (lows.length >= 2) {
    const l2 = lows[lows.length - 1];
    const l1 = lows[lows.length - 2];
    const r1 = rsiSeries[l1.idx];
    const r2 = rsiSeries[l2.idx];
    if (r1 != null && r2 != null && l2.price < l1.price && r2 > r1) {
      bullish = { from: l1, to: l2, rsiFrom: r1, rsiTo: r2 };
    }
  }
  return { bullish, bearish };
}

/**
 * Detect a tight consolidation range over the last N bars
 * (Strategy #4 breakout playbook precondition). Returns {top, bottom, ratio}
 * where ratio = range_height / ATR(14). Tight = ratio < 2.5 over >= 8 bars.
 */
export function consolidationRange(bars, lookback = 12) {
  if (!bars || bars.length < lookback + 14) return null;
  const window = bars.slice(-lookback);
  let top = -Infinity, bottom = Infinity;
  for (const b of window) { top = Math.max(top, b.high); bottom = Math.min(bottom, b.low); }
  const trs = [];
  for (let i = bars.length - 14 - 1; i < bars.length - 1; i++) {
    const h = bars[i + 1].high, l = bars[i + 1].low, pc = bars[i].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  if (atr === 0) return null;
  const height = top - bottom;
  return { top, bottom, height, atr, ratio: height / atr };
}
