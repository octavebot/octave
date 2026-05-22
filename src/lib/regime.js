/**
 * Regime classifier — labels the current market state for an instrument.
 *
 * Output regimes:
 *   trend_up    — ADX ≥ 25, +DI dominant
 *   trend_down  — ADX ≥ 25, -DI dominant
 *   range       — ADX < 20, BB width below 30th percentile (compressed)
 *   breakout    — ADX 20-25 transition + BB width just expanded above 70th pct
 *   reversal    — RSI extreme (>72 or <28) + opposite-direction rejection candle
 *   undefined   — not enough data
 *
 * Pure function: needs bars only. Caller passes a per-instrument ctx
 * with at least one usable timeframe (prefers 15m anchor, falls back to 60).
 */

import { adx, rsiLast, bollinger, rejectionCandle } from './indicators.js';

const MIN_BARS = 50;

/**
 * @param {object} ctx — detector ctx (has ctx.pane(tf)).
 * @param {string} [tf] — timeframe to evaluate. Default '15'.
 * @returns {{ regime:string, adx:number|null, plusDI:number|null, minusDI:number|null,
 *             rsi:number|null, bbWidthPct:number|null, confidence:number, factors:string[] }}
 */
export function classifyRegime(ctx, tf = '15') {
  const pane = ctx?.pane?.(tf) || ctx?.pane?.('60') || ctx?.pane?.('5');
  const bars = pane?.bars;
  if (!bars || bars.length < MIN_BARS) {
    return { regime: 'undefined', adx: null, plusDI: null, minusDI: null,
             rsi: null, bbWidthPct: null, confidence: 0, factors: ['insufficient-bars'] };
  }

  const adxObj = adx(bars, 14);
  const rsi = rsiLast(bars, 14);
  const bb = bollinger(bars, 20, 2);
  const bbWidthSeries = computeBbWidthSeries(bars, 20, 2);
  const bbWidthPct = pctRank(bbWidthSeries, bbWidthSeries[bbWidthSeries.length - 1]);

  const factors = [];
  let regime = 'undefined';
  let confidence = 0.5;

  if (adxObj) {
    const { adx: a, plusDI, minusDI } = adxObj;
    if (a >= 25) {
      if (plusDI > minusDI) { regime = 'trend_up';   factors.push(`ADX ${a.toFixed(1)}`, `+DI ${plusDI.toFixed(1)}>${minusDI.toFixed(1)}`); }
      else                  { regime = 'trend_down'; factors.push(`ADX ${a.toFixed(1)}`, `-DI ${minusDI.toFixed(1)}>${plusDI.toFixed(1)}`); }
      confidence = Math.min(1, 0.5 + (a - 25) / 50);
    } else if (a < 20 && bbWidthPct != null && bbWidthPct < 0.30) {
      regime = 'range';
      factors.push(`ADX ${a.toFixed(1)}<20`, `BB-width ${(bbWidthPct * 100).toFixed(0)}th-pct`);
      confidence = 0.6;
    } else if (bbWidthPct != null && bbWidthPct > 0.70 && a >= 20 && a < 28) {
      regime = 'breakout';
      factors.push(`BB-width ${(bbWidthPct * 100).toFixed(0)}th-pct`, `ADX rising ${a.toFixed(1)}`);
      confidence = 0.55;
    } else {
      regime = 'range';
      factors.push(`ADX ${a.toFixed(1)} mid`);
      confidence = 0.4;
    }
  }

  // Reversal overlay — overrides trend if RSI extreme + rejection candle
  if (rsi != null) {
    const rejUp = rejectionCandle(bars, 'LONG');
    const rejDn = rejectionCandle(bars, 'SHORT');
    if (rsi > 72 && rejDn) {
      regime = 'reversal';
      factors.push(`RSI ${rsi.toFixed(0)} overbought`, 'bearish rejection');
      confidence = 0.6;
    } else if (rsi < 28 && rejUp) {
      regime = 'reversal';
      factors.push(`RSI ${rsi.toFixed(0)} oversold`, 'bullish rejection');
      confidence = 0.6;
    }
  }

  return {
    regime,
    adx: adxObj?.adx ?? null,
    plusDI: adxObj?.plusDI ?? null,
    minusDI: adxObj?.minusDI ?? null,
    rsi,
    bbWidthPct,
    confidence,
    factors,
  };
}

function computeBbWidthSeries(bars, period = 20, mult = 2) {
  // Rolling BB width = (upper - lower) / mid. We need a series to compute
  // percentile rank; bollinger() only returns the latest, so reimplement here.
  const widths = [];
  for (let i = period; i <= bars.length; i++) {
    const slice = bars.slice(i - period, i);
    const closes = slice.map((b) => b.close);
    const mean = closes.reduce((a, b) => a + b, 0) / period;
    const variance = closes.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    const upper = mean + mult * sd, lower = mean - mult * sd;
    widths.push(mean === 0 ? 0 : (upper - lower) / mean);
  }
  return widths;
}

function pctRank(series, value) {
  if (!series.length) return null;
  let below = 0;
  for (const v of series) if (v < value) below++;
  return below / series.length;
}
