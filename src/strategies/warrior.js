/**
 * Strategy #10 — WARRIOR (Ross Cameron / Warrior Trading — Momentum + Reversal)
 *
 * Source: Warrior Trading.pdf "Day Trading Guide For Beginners 2021".
 *
 * The Warrior Trading guide is a beginners' book, not a single pattern. It
 * describes several setups; the two most mechanically tradable are coded here:
 *
 *   PATTERN A — Bull Flag (or Bear Flag) micro-pullback breakout
 *     Definition (LONG): strong impulse move up over the last few bars, then
 *     a 3-7 bar shallow consolidation/pullback on declining volume, then a
 *     breakout candle that takes out the recent micro-high on rising volume.
 *
 *   PATTERN B — Reversal at extremes
 *     Definition: ≥10 consecutive 5-min candles of the same color AND RSI
 *     reading above 90 (top reversal) or below 10 (bottom reversal). Entry
 *     when the FIRST candle prints in the opposing direction. The guide's
 *     own language: "the rubber band stretched — bet on the snapback."
 *
 * Both patterns execute on the 5-minute chart (the Warrior team's preferred
 * intraday TF for momentum). No killzone gating — Warrior trades the full
 * RTH session, with peak activity 9:30-10:30 EST. We enforce isMarketOpen()
 * so off-hours doesn't fire.
 *
 * NOTE: the guide is stock-centric (small-float momentum) but the patterns
 * themselves are timeframe-agnostic. We adapt to gold by dropping float /
 * news-catalyst filters and keeping pure price-action structure.
 */

import { isMarketOpen } from '../lib/time.js';
import { atr, findSwings, volumeSpike } from '../lib/structure.js';

const NAME = 'WARRIOR';
const LABEL = 'Strategy #10';

function findGold5(ctx) { return ctx.pane('5'); }

/** Wilder's RSI on close prices, returning the value at the last bar. */
function rsi(bars, period = 14) {
  if (bars.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const diff = bars[i].close - bars[i - 1].close;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Count consecutive same-direction (color) bars ending at the most recent. */
function consecutiveBarsSameColor(bars) {
  let count = 1;
  const last = bars[bars.length - 1];
  const isGreen = last.close > last.open;
  for (let i = bars.length - 2; i >= 0; i--) {
    const b = bars[i];
    const green = b.close > b.open;
    if (green === isGreen) count++;
    else break;
  }
  return { count, direction: isGreen ? 'UP' : 'DOWN' };
}

/**
 * Bull-flag detector (LONG version).
 *
 * Looks for:
 *   - An impulse leg in the prior ~10 bars (close[N] >> close[N-10])
 *   - A 3-7 bar consolidation where range narrows and volume cools
 *   - The most recent bar closes above the consolidation's high on volume
 */
function detectBullFlag(bars, direction) {
  if (bars.length < 25) return null;
  const a14 = atr(bars, 14);
  if (!a14) return null;

  // Hunt across (consolidationLen, impulseLen) combos
  for (let consLen = 3; consLen <= 7; consLen++) {
    const consEnd = bars.length - 1;
    const consStart = consEnd - consLen;
    const impulseEnd = consStart;
    const impulseStart = Math.max(0, impulseEnd - 6);
    if (impulseStart >= impulseEnd) continue;

    const impulseBars = bars.slice(impulseStart, impulseEnd + 1);
    const consBars = bars.slice(consStart, consEnd); // exclude the breakout bar itself
    const breakoutBar = bars[consEnd];

    const impulseStartClose = impulseBars[0].close;
    const impulseEndClose = impulseBars[impulseBars.length - 1].close;
    const impulseSize = impulseEndClose - impulseStartClose;

    // Impulse must be ≥1.0 ATR in the trade direction
    if (direction === 'LONG' && impulseSize < 1.0 * a14) continue;
    if (direction === 'SHORT' && impulseSize > -1.0 * a14) continue;

    // Consolidation: range narrower than impulse, near the extreme
    const consHigh = Math.max(...consBars.map((b) => b.high));
    const consLow = Math.min(...consBars.map((b) => b.low));
    const consRange = consHigh - consLow;
    if (consRange > 0.7 * Math.abs(impulseSize)) continue;

    // Breakout: close beyond cons extreme in direction, on healthy volume
    const breakoutDirection = direction === 'LONG'
      ? breakoutBar.close > consHigh
      : breakoutBar.close < consLow;
    if (!breakoutDirection) continue;

    // Volume confirmation — breakout bar volume above 20-bar average
    const recentAvgVol = bars.slice(-21, -1).reduce((a, b) => a + (b.volume || 0), 0) / 20;
    const volOk = recentAvgVol === 0 || (breakoutBar.volume || 0) >= 1.1 * recentAvgVol;
    if (!volOk) continue;

    return {
      pattern: 'bull-flag',
      consHigh, consLow, consLen, impulseSize, breakoutVol: breakoutBar.volume,
      breakoutClose: breakoutBar.close, atr: a14,
    };
  }
  return null;
}

/**
 * Reversal at extreme RSI + ≥10 consecutive same-color bars.
 */
function detectExtremeReversal(bars) {
  if (bars.length < 20) return null;
  const r = rsi(bars, 14);
  if (r == null) return null;
  // Need at least 10 consecutive same-color bars EXCLUDING the current bar
  const prior = bars.slice(0, -1);
  const { count, direction: priorDir } = consecutiveBarsSameColor(prior);
  if (count < 10) return null;
  // The last bar should be the FIRST reversal (color flip)
  const last = bars[bars.length - 1];
  const lastGreen = last.close > last.open;
  if (priorDir === 'UP' && r >= 70 && !lastGreen) {
    // Top reversal: go SHORT on the first red bar
    return { pattern: 'reversal-top', direction: 'SHORT', rsi: r, run: count };
  }
  if (priorDir === 'DOWN' && r <= 30 && lastGreen) {
    return { pattern: 'reversal-bottom', direction: 'LONG', rsi: r, run: count };
  }
  return null;
}

function buildBullFlagTriggered(ctx, direction, det, bars) {
  const last = bars[bars.length - 1];
  const a14 = det.atr;
  const entry = last.close;
  const stop = direction === 'LONG'
    ? det.consLow - 0.15 * a14
    : det.consHigh + 0.15 * a14;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  // Warrior's exits are discretionary; use 2R as a reasonable mechanical floor
  const t1 = direction === 'LONG' ? entry + 1.5 * risk : entry - 1.5 * risk;
  const t2 = direction === 'LONG' ? entry + 2.5 * risk : entry - 2.5 * risk;
  const runner = direction === 'LONG' ? entry + 4 * risk : entry - 4 * risk;

  return {
    strategy: NAME,
    setupId: `${NAME}-${ctx.dateKey}-${direction}-flag-${Math.round(entry * 100)}`,
    status: 'triggered',
    direction,
    setupName: `${LABEL} · ${direction} bull-flag BREAKOUT`,
    summary: `Impulse + ${det.consLen}-bar pullback + breakout on volume. Entry ${entry.toFixed(2)} · SL ${stop.toFixed(2)} · TP1 ${t1.toFixed(2)} (1.5R) · TP2 ${t2.toFixed(2)} (2.5R).`,
    confidence: 0.7 + (det.consLen >= 4 ? 0.05 : 0),
    details: {
      'pattern': 'bull-flag micro-pullback breakout',
      'impulse size': det.impulseSize.toFixed(2),
      'consolidation bars': String(det.consLen),
      'consolidation range': `${det.consLow.toFixed(2)} - ${det.consHigh.toFixed(2)}`,
      'breakout close': entry.toFixed(2),
      'stop': stop.toFixed(2),
      'TP1 (1.5R)': t1.toFixed(2),
      'TP2 (2.5R)': t2.toFixed(2),
    },
    invalidationLevel: stop,
    entryPlan: { direction, entry, stop, t1, t2, runner, risk },
    geometry: {
      target: { name: 'TP2', level: t2 },
      mss: { brokenPrice: direction === 'LONG' ? det.consHigh : det.consLow, time: last.time },
      entryPlan: { direction, entry, stop, t1, t2, runner },
    },
  };
}

function buildReversalTriggered(ctx, det, bars) {
  const last = bars[bars.length - 1];
  const a14 = atr(bars, 14) || 1;
  const direction = det.direction;
  const entry = last.close;
  // Stop just beyond the reversal candle's extreme
  const stop = direction === 'LONG'
    ? last.low - 0.15 * a14
    : last.high + 0.15 * a14;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  // Warrior uses trailing stops; mechanical TP at 2R for the alert
  const t1 = direction === 'LONG' ? entry + 1.5 * risk : entry - 1.5 * risk;
  const t2 = direction === 'LONG' ? entry + 2.5 * risk : entry - 2.5 * risk;

  return {
    strategy: NAME,
    setupId: `${NAME}-${ctx.dateKey}-${direction}-rev-${Math.round(entry * 100)}`,
    status: 'triggered',
    direction,
    setupName: `${LABEL} · ${direction} extreme REVERSAL`,
    summary: `${det.run} consecutive ${direction === 'LONG' ? 'red' : 'green'} 5m bars + RSI ${det.rsi.toFixed(0)}. First reversal candle. Entry ${entry.toFixed(2)} · SL ${stop.toFixed(2)} · TP ${t1.toFixed(2)} (1.5R).`,
    confidence: 0.66 + (det.run >= 12 ? 0.05 : 0),
    details: {
      'pattern': det.pattern,
      'consecutive bars': String(det.run),
      'RSI(14)': det.rsi.toFixed(1),
      'entry (first reversal close)': entry.toFixed(2),
      'stop': stop.toFixed(2),
      'TP1 (1.5R)': t1.toFixed(2),
      'TP2 (2.5R)': t2.toFixed(2),
    },
    invalidationLevel: stop,
    entryPlan: { direction, entry, stop, t1, t2, runner: t2, risk },
    geometry: {
      target: { name: 'TP2', level: t2 },
      entryPlan: { direction, entry, stop, t1, t2, runner: t2 },
    },
  };
}

export function evaluateWARRIOR(ctx) {
  const now = ctx.ts / 1000;
  if (!isMarketOpen(now)) return [];
  const m5 = findGold5(ctx);
  if (!m5 || !m5.bars || m5.bars.length < 40) return [];
  const out = [];

  // Bull flag (LONG) and bear flag (SHORT)
  const longFlag = detectBullFlag(m5.bars, 'LONG');
  if (longFlag) {
    const r = buildBullFlagTriggered(ctx, 'LONG', longFlag, m5.bars);
    if (r) out.push(r);
  }
  const shortFlag = detectBullFlag(m5.bars, 'SHORT');
  if (shortFlag) {
    const r = buildBullFlagTriggered(ctx, 'SHORT', shortFlag, m5.bars);
    if (r) out.push(r);
  }

  // Extreme RSI reversal
  const rev = detectExtremeReversal(m5.bars);
  if (rev) {
    const r = buildReversalTriggered(ctx, rev, m5.bars);
    if (r) out.push(r);
  }

  return out;
}
