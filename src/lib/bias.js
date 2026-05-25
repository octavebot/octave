/**
 * Market-structure bias — magnitude-weighted multi-factor read.
 *
 * Each factor returns a *signed magnitude* (typically in [-1.5, +1.5], capped)
 * instead of a flat ±1 vote. Big displacement counts more than marginal noise.
 * Final bias score = Σ (factor.v × factor.weight).
 *
 * Factors:
 *   D1 trend       price vs D1 20-EMA, magnitude = (close - EMA) / ATR_D1     w=1.5
 *   H1 trend       price vs H1 50-EMA, magnitude = (close - EMA) / ATR_H1     w=1.0
 *   H1 slope       EMA50 derivative over 3 bars / ATR_H1                       w=0.8
 *   H1 RSI(14)     (RSI - 50) / 50                                             w=0.7
 *   15m trend      price vs 15m 20-EMA, magnitude = (close - EMA) / ATR_15m   w=0.5
 *   15m momentum   (9-EMA - 21-EMA) / ATR_15m                                  w=0.5
 *   vs VWAP        (close - VWAP) / ATR_15m                                    w=0.8
 *   Session        (close - sessionOpen) / sessionRange                        w=0.3
 *
 * Strategy vote: each gate-passing precheck row contributes (1 + closeness)
 * to its direction side — so NEAR-trigger strategies count more than barely-
 * gated FORMING ones.
 *
 * Combined direction labels:
 *   - aligned BULLISH/BEARISH    both reads agree
 *   - leaning BULLISH/BEARISH    one read agrees, other neutral
 *   - mixed                       reads disagree
 *   - NEUTRAL                     both flat
 */

import { ema, rsi, vwap } from './indicators.js';
import { atr } from './structure.js';
import { nyDayStartUnix } from './time.js';

// Clamp magnitude so a runaway value can't dominate the whole vote.
const clamp = (x, lo = -1.5, hi = 1.5) => Math.max(lo, Math.min(hi, x));
const safeDiv = (a, b) => (b && Number.isFinite(b) && b !== 0) ? a / b : 0;

/**
 * Structural-only bias. Each factor contributes a *weighted magnitude* —
 * `v` is in roughly [-1.5, +1.5] (clamped), `w` is the factor weight.
 * @param {object} ctx  instrument ctx with ctx.pane('15') / ctx.pane('60') / ctx.pane('1D')
 * @returns {object|null}
 */
export function computeInstrumentBias(ctx) {
  const m15 = ctx?.pane?.('15');
  const h1 = ctx?.pane?.('60');
  const d1 = ctx?.pane?.('1D');
  if (!m15?.bars || m15.bars.length < 50 || !h1?.bars || h1.bars.length < 55) return null;

  const b15 = m15.bars, b60 = h1.bars;
  const last15 = b15[b15.length - 1];
  const last60 = b60[b60.length - 1];
  const a15 = atr(b15, 14);
  const a60 = atr(b60, 14);

  const factors = [];
  let weightedSum = 0;
  let maxWeight = 0;
  const add = (label, value, weight) => {
    const v = clamp(value);
    factors.push({ label, v: round2(v), w: weight, weighted: round2(v * weight) });
    weightedSum += v * weight;
    maxWeight += weight;  // assumes |v| ≤ 1 typically; clamp lets it touch 1.5
  };

  // ─── D1 trend (macro) ───────────────────────────────────────────────────
  if (d1?.bars && d1.bars.length >= 25) {
    const e20D = ema(d1.bars, 20);
    const e20Dnow = e20D[e20D.length - 1];
    const lastD = d1.bars[d1.bars.length - 1];
    const aD = atr(d1.bars, 14);
    if (e20Dnow != null && aD) {
      add('D1 trend', safeDiv(lastD.close - e20Dnow, aD), 1.5);
    }
  }

  // ─── H1 trend + slope ───────────────────────────────────────────────────
  const e50 = ema(b60, 50);
  const e50now = e50[e50.length - 1];
  const e50prev3 = e50[e50.length - 4];
  if (e50now != null && a60) {
    add('H1 trend', safeDiv(last60.close - e50now, a60), 1.0);
  }
  if (e50now != null && e50prev3 != null && a60) {
    // EMA derivative — slope per 3-bar interval, normalized by ATR.
    add('H1 slope', safeDiv(e50now - e50prev3, a60), 0.8);
  }

  // ─── H1 RSI(14) — pure momentum, not derived from EMAs ──────────────────
  const rsi60series = rsi(b60, 14);
  const rsi60now = rsi60series[rsi60series.length - 1];
  if (rsi60now != null && Number.isFinite(rsi60now)) {
    // Centered: 50 = neutral. Scaled so 70 → +0.4, 30 → -0.4.
    add('H1 RSI(14)', safeDiv(rsi60now - 50, 50), 0.7);
  }

  // ─── 15m trend + momentum ───────────────────────────────────────────────
  const e20 = ema(b15, 20);
  const e20now = e20[e20.length - 1];
  if (e20now != null && a15) {
    add('15m trend', safeDiv(last15.close - e20now, a15), 0.5);
  }
  const e9 = ema(b15, 9), e21 = ema(b15, 21);
  const e9now = e9[e9.length - 1], e21now = e21[e21.length - 1];
  if (e9now != null && e21now != null && a15) {
    add('15m momentum', safeDiv(e9now - e21now, a15), 0.5);
  }

  // ─── vs session VWAP (institutional read) ──────────────────────────────
  const sessStart = nyDayStartUnix(last15.time);
  const sessBars = b15.filter((b) => b.time >= sessStart);
  let vwapVal = null;
  if (sessBars.length >= 3) {
    vwapVal = vwap(sessBars, sessStart);
    if (vwapVal != null && a15) {
      add('vs VWAP', safeDiv(last15.close - vwapVal, a15), 0.8);
    }
  }

  // ─── Session open relationship ──────────────────────────────────────────
  if (sessBars.length) {
    const sessOpen = sessBars[0].open;
    const sessHigh = Math.max(...sessBars.map((b) => b.high));
    const sessLow = Math.min(...sessBars.map((b) => b.low));
    const sessRange = sessHigh - sessLow;
    add('Session', safeDiv(last15.close - sessOpen, sessRange || 1), 0.3);
  }

  // ─── Threshold ──────────────────────────────────────────────────────────
  // weightedSum range is roughly [-maxWeight, +maxWeight]. Trigger BULLISH/
  // BEARISH when |score| ≥ 25% of maxWeight (a meaningful lopsided vote).
  const cutoff = maxWeight * 0.25;
  let direction = 'NEUTRAL';
  if (weightedSum >= cutoff) direction = 'BULLISH';
  else if (weightedSum <= -cutoff) direction = 'BEARISH';

  // Confidence as % of theoretical max (capped at 100).
  const confidence = Math.min(100, Math.round(Math.abs(weightedSum) / maxWeight * 100));

  // ─── Context: vol regime + intraday range ──────────────────────────────
  const volRegime = volBucket(b15, 100);
  let intradayChange = null;
  if (sessBars.length >= 2) {
    intradayChange = last15.close - sessBars[0].open;
  }
  let h1Change = null;
  if (b15.length >= 5) {
    h1Change = last15.close - b15[Math.max(0, b15.length - 5)].close;
  }

  return {
    direction,
    score: round2(weightedSum),
    maxScore: round2(maxWeight),
    confidence,
    factors,
    price: last15.close,
    atr15m: a15 || null,
    volRegime,
    intradayChange: intradayChange != null ? round2(intradayChange) : null,
    h1Change: h1Change != null ? round2(h1Change) : null,
    vwap: vwapVal != null ? round2(vwapVal) : null,
    rsi60: rsi60now != null ? round2(rsi60now) : null,
  };
}

function volBucket(bars, lookback = 100) {
  if (!bars || bars.length < lookback + 14) return 'unknown';
  const ranges = bars.slice(-lookback).map((b) => b.high - b.low).sort((a, b) => a - b);
  const lastATR = atr(bars, 14);
  if (!lastATR) return 'unknown';
  // Approximate ATR percentile by counting ranges < lastATR.
  const idx = ranges.findIndex((r) => r >= lastATR);
  const pct = idx === -1 ? 100 : (idx / ranges.length) * 100;
  if (pct < 25) return 'low';
  if (pct < 65) return 'normal';
  if (pct < 90) return 'elevated';
  return 'extreme';
}

function round2(x) { return Math.round(x * 100) / 100; }

/**
 * Tally a per-instrument strategy vote from precheck rows. Gate-passing rows
 * vote (1 + closeness) toward their direction — a NEAR-trigger setup carries
 * more weight than a barely-gated FORMING one. Returns the raw rows too so
 * the bot can pick the top candidates per direction.
 */
export function tallyStrategyVote(precheckRows) {
  let long = 0, short = 0;
  let longCount = 0, shortCount = 0;
  const candidates = [];
  for (const r of precheckRows || []) {
    const conds = r.conditions || [];
    const gates = conds.filter((c) => c.kind === 'gate');
    if (!gates.length || !gates.every((c) => c.met)) continue;
    const triggers = conds.filter((c) => c.kind === 'trigger');
    const closeness = triggers.length ? triggers.filter((c) => c.met).length / triggers.length : 0;
    const weight = 1 + closeness;
    if (r.direction === 'LONG')  { long  += weight; longCount  += 1; }
    if (r.direction === 'SHORT') { short += weight; shortCount += 1; }
    candidates.push({ strategy: r.strategy, direction: r.direction || 'NONE', closeness: round2(closeness) });
  }
  candidates.sort((a, b) => b.closeness - a.closeness);
  return {
    long: round2(long), short: round2(short),
    longCount, shortCount,
    candidates,
  };
}

/**
 * Combine structural read + strategy vote into a single directional verdict.
 * Uses weighted score not just direction label.
 */
export function combineBias(structural, vote) {
  if (!structural) return null;
  const sDir = structural.direction;
  const sNet = vote.long - vote.short;

  // Net strategy vote stronger than 1 weight unit → directional
  let stratDir = 'NEUTRAL';
  if (sNet >= 2) stratDir = 'BULLISH';
  else if (sNet <= -2) stratDir = 'BEARISH';
  else if (sNet >= 1) stratDir = 'BULLISH-lean';
  else if (sNet <= -1) stratDir = 'BEARISH-lean';

  let combined = 'NEUTRAL';
  let label = 'flat';
  const bullStruct = sDir === 'BULLISH';
  const bearStruct = sDir === 'BEARISH';
  const bullStrat = sNet > 0;
  const bearStrat = sNet < 0;

  if (bullStruct && bullStrat) { combined = 'BULLISH'; label = 'aligned bullish'; }
  else if (bearStruct && bearStrat) { combined = 'BEARISH'; label = 'aligned bearish'; }
  else if (bullStruct && !bearStrat) { combined = 'BULLISH'; label = sNet === 0 ? 'structural bullish · no strategy vote' : 'leaning bullish'; }
  else if (bearStruct && !bullStrat) { combined = 'BEARISH'; label = sNet === 0 ? 'structural bearish · no strategy vote' : 'leaning bearish'; }
  else if (!bullStruct && !bearStruct && sNet >= 2) { combined = 'BULLISH'; label = 'strategy-led bullish'; }
  else if (!bullStruct && !bearStruct && sNet <= -2) { combined = 'BEARISH'; label = 'strategy-led bearish'; }
  else if ((bullStruct && bearStrat) || (bearStruct && bullStrat)) { combined = 'MIXED'; label = 'structural vs strategy disagree'; }
  else { combined = 'NEUTRAL'; label = 'flat'; }

  return { direction: combined, label, structuralDir: sDir, strategyDir: stratDir };
}
