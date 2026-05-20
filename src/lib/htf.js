/**
 * HTF (Higher-Timeframe) bias from Daily + 4H panes.
 *
 * Per ICT/SMC Strategy step 1:
 *   Bullish bias if:
 *     - Daily made recent BOS to upside (close above last sig daily swing high)
 *     - 4H making HH and HL
 *     - Price above last unmitigated bullish daily OB or FVG  (deferred — needs full OB engine)
 *
 *   Bearish bias if mirror of above.
 *
 *   No bias if Daily and 4H conflict or Daily is range-bound.
 *
 * This module returns { bias: 'bullish'|'bearish'|'none', confidence, reasons[] }.
 */

import { findSwings, atr } from './structure.js';

function classifyTrend(bars, swingLookback = 3) {
  if (!bars || bars.length < 10) return { trend: 'none', reasons: ['not enough bars'] };
  const { highs, lows } = findSwings(bars, swingLookback);
  const reasons = [];

  // Last two confirmed highs and lows
  const h1 = highs[highs.length - 1], h0 = highs[highs.length - 2];
  const l1 = lows[lows.length - 1], l0 = lows[lows.length - 2];
  if (!h1 || !h0 || !l1 || !l0) return { trend: 'none', reasons: ['insufficient pivots'] };

  const hh = h1.price > h0.price;
  const hl = l1.price > l0.price;
  const lh = h1.price < h0.price;
  const ll = l1.price < l0.price;

  if (hh && hl) {
    reasons.push(`HH:${h1.price.toFixed(2)}>${h0.price.toFixed(2)}`, `HL:${l1.price.toFixed(2)}>${l0.price.toFixed(2)}`);
    return { trend: 'bullish', reasons };
  }
  if (lh && ll) {
    reasons.push(`LH:${h1.price.toFixed(2)}<${h0.price.toFixed(2)}`, `LL:${l1.price.toFixed(2)}<${l0.price.toFixed(2)}`);
    return { trend: 'bearish', reasons };
  }
  reasons.push(`mixed: HH=${hh} HL=${hl} LH=${lh} LL=${ll}`);
  return { trend: 'mixed', reasons };
}

/**
 * Recent BOS detection: did the most recent close exceed the last confirmed
 * opposing swing pivot? Returns 'up' | 'down' | 'none'.
 */
function recentBOS(bars, swingLookback = 3) {
  if (!bars || bars.length < swingLookback * 2 + 2) return 'none';
  const { highs, lows } = findSwings(bars, swingLookback);
  const last = bars[bars.length - 1];
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  // Bullish BOS: last close > most recent confirmed swing high
  if (lastHigh && last.close > lastHigh.price) return 'up';
  if (lastLow && last.close < lastLow.price) return 'down';
  return 'none';
}

/**
 * Compute HTF bias from Daily + 4H pane bars.
 * If either pane is missing, returns { bias: 'unknown', reason: 'missing-pane' }.
 *
 * @param {Array} dailyBars  Daily bars (ascending)
 * @param {Array} h4Bars     4H bars (ascending)
 */
export function computeHtfBias(dailyBars, h4Bars) {
  if (!dailyBars || dailyBars.length === 0) {
    return { bias: 'unknown', confidence: 0, reasons: ['no daily pane'] };
  }
  if (!h4Bars || h4Bars.length === 0) {
    return { bias: 'unknown', confidence: 0, reasons: ['no 4h pane'] };
  }

  const dailyBos = recentBOS(dailyBars, 3);
  const h4Trend = classifyTrend(h4Bars, 3);

  // Strong agreement
  if (dailyBos === 'up' && h4Trend.trend === 'bullish') {
    return {
      bias: 'bullish',
      confidence: 0.85,
      reasons: [`Daily BOS up`, `4H trend bullish (${h4Trend.reasons.join(', ')})`],
    };
  }
  if (dailyBos === 'down' && h4Trend.trend === 'bearish') {
    return {
      bias: 'bearish',
      confidence: 0.85,
      reasons: [`Daily BOS down`, `4H trend bearish (${h4Trend.reasons.join(', ')})`],
    };
  }

  // Daily clear, 4H mixed — still useable but lower confidence
  if (dailyBos === 'up' && h4Trend.trend !== 'bearish') {
    return { bias: 'bullish', confidence: 0.55, reasons: [`Daily BOS up`, `4H ${h4Trend.trend}`] };
  }
  if (dailyBos === 'down' && h4Trend.trend !== 'bullish') {
    return { bias: 'bearish', confidence: 0.55, reasons: [`Daily BOS down`, `4H ${h4Trend.trend}`] };
  }

  // Conflict or no BOS — skip the day per strategy doc
  return {
    bias: 'none',
    confidence: 0,
    reasons: [`Daily BOS ${dailyBos}`, `4H trend ${h4Trend.trend}`, 'no aligned bias'],
  };
}

/**
 * Identify the Draw-on-Liquidity (DOL) per Strategy 2 step 2.
 * Bullish bias → nearest BSL above current price.
 * Bearish bias → nearest SSL below current price.
 *
 * @param {object} args { bias, currentPrice, candidates: [{name, level, side}] }
 */
export function pickDOL({ bias, currentPrice, candidates }) {
  if (bias !== 'bullish' && bias !== 'bearish') return null;
  const wanted = bias === 'bullish' ? 'BSL' : 'SSL';
  const filtered = candidates.filter((c) => {
    if (c.side !== wanted) return false;
    if (bias === 'bullish') return c.level > currentPrice;
    return c.level < currentPrice;
  });
  if (filtered.length === 0) return null;
  // Choose nearest
  filtered.sort((a, b) => Math.abs(a.level - currentPrice) - Math.abs(b.level - currentPrice));
  return filtered[0];
}
