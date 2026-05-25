/**
 * Market-structure bias.
 *
 * Two reads combined:
 *   1. Structural — multi-timeframe price/EMA/momentum/session (always available).
 *   2. Strategy — how the live precheck rows from the registry currently lean
 *      (which strategies are gate-passing LONG vs SHORT). Real-time fingerprint
 *      of "what's the bot actually watching for right now".
 *
 * Structural factors (each scores +1 bullish / -1 bearish / 0 flat):
 *   - D1 trend     price vs the D1 20-EMA (macro)
 *   - H1 trend     price vs the H1 50-EMA
 *   - H1 slope     the H1 50-EMA rising or falling
 *   - 15m trend    price vs the 15m 20-EMA
 *   - 15m momentum 15m 9-EMA vs 21-EMA
 *   - Session      price vs the session open
 *
 * Strategy vote: each gate-passing precheck row contributes +1 (LONG) / -1 (SHORT).
 *
 * Combined direction labels:
 *   - aligned BULLISH/BEARISH    both reads agree
 *   - leaning BULLISH/BEARISH    one read agrees, other neutral
 *   - mixed                       reads disagree
 *   - NEUTRAL                     both flat
 */

import { ema } from './indicators.js';
import { atr } from './structure.js';
import { nyDayStartUnix } from './time.js';

const sign = (a, b) => a > b ? 1 : a < b ? -1 : 0;

/**
 * Structural-only bias. Used standalone and as one half of the combined read.
 * @param {object} ctx  instrument ctx with ctx.pane('15') / ctx.pane('60') / ctx.pane('1D')
 * @returns {{direction,score,maxScore,factors,price}|null}
 */
export function computeInstrumentBias(ctx) {
  const m15 = ctx?.pane?.('15');
  const h1 = ctx?.pane?.('60');
  const d1 = ctx?.pane?.('1D');
  if (!m15?.bars || m15.bars.length < 50 || !h1?.bars || h1.bars.length < 55) return null;

  const b15 = m15.bars, b60 = h1.bars;
  const last15 = b15[b15.length - 1];
  const last60 = b60[b60.length - 1];

  const factors = [];
  let score = 0;
  const add = (label, v) => { factors.push({ label, v }); score += v; };

  // D1 macro (when daily pane present — null on instruments without daily data).
  if (d1?.bars && d1.bars.length >= 25) {
    const e20D = ema(d1.bars, 20);
    const e20Dnow = e20D[e20D.length - 1];
    const lastD = d1.bars[d1.bars.length - 1];
    if (e20Dnow != null) add('D1 trend', sign(lastD.close, e20Dnow));
  }

  const e50 = ema(b60, 50);
  const e50now = e50[e50.length - 1], e50prev = e50[e50.length - 4];
  if (e50now != null) add('H1 trend', sign(last60.close, e50now));
  if (e50now != null && e50prev != null) add('H1 slope', sign(e50now, e50prev));

  const e20 = ema(b15, 20);
  const e20now = e20[e20.length - 1];
  if (e20now != null) add('15m trend', sign(last15.close, e20now));

  const e9 = ema(b15, 9), e21 = ema(b15, 21);
  const e9now = e9[e9.length - 1], e21now = e21[e21.length - 1];
  if (e9now != null && e21now != null) add('15m momentum', sign(e9now, e21now));

  const sessStart = nyDayStartUnix(last15.time);
  const sessBars = b15.filter((b) => b.time >= sessStart);
  if (sessBars.length) add('Session', sign(last15.close, sessBars[0].open));

  // Threshold scales with factor count so adding D1 doesn't shift the meaning
  // of BULLISH/BEARISH. Need ~40% lopsided vote to call a direction.
  const cutoff = Math.max(2, Math.ceil(factors.length * 0.4));
  let direction = 'NEUTRAL';
  if (score >= cutoff) direction = 'BULLISH';
  else if (score <= -cutoff) direction = 'BEARISH';

  // ATR-15m as a quick volatility tag the dashboard can show.
  const a15 = atr(b15, 14) || null;

  return { direction, score, maxScore: factors.length, factors, price: last15.close, atr15m: a15 };
}

/**
 * Tally a per-instrument strategy vote from precheck rows.
 * Only gate-passing rows count — those are the strategies actually watching now.
 * @param {Array} precheckRows  output of strategy.precheck() for this instrument
 * @returns {{long:number, short:number, candidates:Array<{strategy,direction,closeness}>}}
 */
export function tallyStrategyVote(precheckRows) {
  let long = 0, short = 0;
  const candidates = [];
  for (const r of precheckRows || []) {
    const conds = r.conditions || [];
    const gates = conds.filter((c) => c.kind === 'gate');
    if (!gates.length || !gates.every((c) => c.met)) continue;
    const triggers = conds.filter((c) => c.kind === 'trigger');
    const closeness = triggers.length ? triggers.filter((c) => c.met).length / triggers.length : 0;
    if (r.direction === 'LONG')  long  += 1;
    if (r.direction === 'SHORT') short += 1;
    candidates.push({ strategy: r.strategy, direction: r.direction || 'NONE', closeness });
  }
  candidates.sort((a, b) => b.closeness - a.closeness);
  return { long, short, candidates };
}

/**
 * Combine structural read + strategy vote into a single directional verdict.
 */
export function combineBias(structural, vote) {
  if (!structural) return null;
  const sDir = structural.direction;
  const sNet = vote.long - vote.short;
  const stratDir = sNet >= 2 ? 'BULLISH' : sNet <= -2 ? 'BEARISH' : sNet === 1 ? 'BULLISH-lean' : sNet === -1 ? 'BEARISH-lean' : 'NEUTRAL';

  let combined = 'NEUTRAL';
  let label = 'no read';
  const bothBull = sDir === 'BULLISH' && sNet > 0;
  const bothBear = sDir === 'BEARISH' && sNet < 0;
  if (bothBull) { combined = 'BULLISH'; label = 'aligned bullish'; }
  else if (bothBear) { combined = 'BEARISH'; label = 'aligned bearish'; }
  else if (sDir === 'BULLISH' && sNet === 0) { combined = 'BULLISH'; label = 'structural bullish · no strategy vote'; }
  else if (sDir === 'BEARISH' && sNet === 0) { combined = 'BEARISH'; label = 'structural bearish · no strategy vote'; }
  else if (sDir === 'NEUTRAL' && sNet >= 2) { combined = 'BULLISH'; label = 'strategy-led bullish'; }
  else if (sDir === 'NEUTRAL' && sNet <= -2) { combined = 'BEARISH'; label = 'strategy-led bearish'; }
  else if ((sDir === 'BULLISH' && sNet < 0) || (sDir === 'BEARISH' && sNet > 0)) { combined = 'MIXED'; label = 'structural vs strategy disagree'; }
  else { combined = 'NEUTRAL'; label = 'flat'; }

  return { direction: combined, label, structuralDir: sDir, strategyDir: stratDir };
}
