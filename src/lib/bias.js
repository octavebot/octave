/**
 * Market-structure bias.
 *
 * The old /bias just tallied whichever strategies happened to be triggering
 * at that instant — usually nothing, so it read "NEUTRAL". This computes a
 * real directional lean per instrument from multi-timeframe structure, so
 * /bias is always meaningful whether or not a setup is live.
 *
 * Factors (each scores +1 bullish / -1 bearish / 0 flat):
 *   - H1 trend     price vs the H1 50-EMA
 *   - H1 slope     the H1 50-EMA rising or falling
 *   - 15m trend    price vs the 15m 20-EMA
 *   - 15m momentum 15m 9-EMA vs 21-EMA
 *   - Session      price vs the session open
 */

import { ema } from './indicators.js';
import { nyDayStartUnix } from './time.js';

/**
 * @param {object} ctx  instrument ctx with ctx.pane('15') / ctx.pane('60')
 * @returns {{direction,score,maxScore,factors,price}|null}
 */
export function computeInstrumentBias(ctx) {
  const m15 = ctx?.pane?.('15');
  const h1 = ctx?.pane?.('60');
  if (!m15?.bars || m15.bars.length < 50 || !h1?.bars || h1.bars.length < 55) return null;

  const b15 = m15.bars, b60 = h1.bars;
  const last15 = b15[b15.length - 1];
  const last60 = b60[b60.length - 1];

  const factors = [];
  let score = 0;
  const add = (label, v) => { factors.push({ label, v }); score += v; };
  const sign = (a, b) => a > b ? 1 : a < b ? -1 : 0;

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

  let direction = 'NEUTRAL';
  if (score >= 2) direction = 'BULLISH';
  else if (score <= -2) direction = 'BEARISH';

  return { direction, score, maxScore: factors.length, factors, price: last15.close };
}
