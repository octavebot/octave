/**
 * Strategy GEM #4 — VWAP Rubber Band (Gemini pack).
 *
 * Playbook (verbatim from VWAP.pdf, Gemini):
 *   - 5m chart (we promote to 15m because of the 15m+ alert gate).
 *   - Indicators: VWAP, Bollinger (20, 2.5 σ), ADX(14) on 1H.
 *   - Filter: 1H ADX < 25 → ranging market.  No high-impact news days (the
 *     news.js blackout integration handles that globally).
 *   - Setup: price aggressively pierces upper/lower 2.5 σ BB, visibly extended
 *     from VWAP.
 *   - Trigger: 15m reversal candle (pin/doji/engulfing) closing BACK inside BB.
 *   - Entry on close of reversal candle.
 *   - SL: 1 ATR beyond the wick of the reversal candle.
 *   - TP: VWAP line directly. Exit on touch.
 *
 * Internal id: GEM-VWAP
 */

import { atr } from '../../lib/structure.js';
import { bollinger, vwap, adx, isPinBar, isEngulfing } from '../../lib/indicators.js';
import { dayScopedId, buildTriggered } from '../_helpers.js';
import { nyParts, nyOpenUnix } from '../../lib/time.js';

const KEY = 'GEM-VWAP';
const TF = '15';
const NAME = 'VWAP Rubber Band';

export function evaluate(ctx) {
  const pane = ctx.pane(TF);
  const pane1h = ctx.pane('60');
  if (!pane || pane.bars.length < 80) return [];
  if (!pane1h || pane1h.bars.length < 60) return [];

  // ADX(1H) < 25 — only fire in ranging markets
  const adxObj = adx(pane1h.bars, 14);
  if (!adxObj || adxObj.adx >= 25) return [];

  const bars = pane.bars;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (!last || !prev) return [];

  const bb = bollinger(bars, 20, 2.5);
  if (!bb) return [];

  // Session-anchored VWAP from NY open (standard institutional anchor)
  const sessionStart = nyOpenUnix(last.time);
  const v = vwap(bars, sessionStart);
  if (v == null) return [];

  // Did the PREVIOUS bar pierce the BB and the CURRENT bar close back inside?
  const piercedUp = prev.high > bb.upper && Math.abs(prev.close - v) > 1.2 * (bb.upper - bb.mid);
  const piercedDown = prev.low < bb.lower && Math.abs(v - prev.close) > 1.2 * (bb.upper - bb.mid);
  if (!piercedUp && !piercedDown) return [];

  const direction = piercedUp ? 'SHORT' : 'LONG';
  // Reversal candle on the most recent CLOSED bar
  const closedBars = bars.slice(0, -1);
  const cur = closedBars[closedBars.length - 1];
  const prevBar = closedBars[closedBars.length - 2];
  const reversed = direction === 'LONG'
    ? (isPinBar(cur, 'bullish') || isEngulfing(prevBar, cur, 'bullish'))
    : (isPinBar(cur, 'bearish') || isEngulfing(prevBar, cur, 'bearish'));
  if (!reversed) return [];
  // Confirm close back inside Bollinger
  if (direction === 'SHORT' && cur.close >= bb.upper) return [];
  if (direction === 'LONG' && cur.close <= bb.lower) return [];

  const entry = cur.close;
  const a = atr(bars, 14) || (bb.upper - bb.mid);
  const stop = direction === 'LONG' ? cur.low - a : cur.high + a;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return [];
  const t1 = v;
  // Runner = beyond VWAP by 0.5R for traders who want to extend
  const t2 = direction === 'LONG' ? entry + 1.5 * risk : entry - 1.5 * risk;

  const { dateKey } = nyParts(last.time);
  return [buildTriggered({
    strategy: KEY,
    setupId: dayScopedId(KEY, dateKey, direction, 'rubber-band'),
    direction,
    setupName: `${NAME} — ${direction} reversion to VWAP`,
    summary: `1H ADX ${adxObj.adx.toFixed(0)} (ranging); price pierced ${direction === 'SHORT' ? 'upper' : 'lower'} 2.5 σ BB then closed back inside. Target VWAP $${v.toFixed(2)}.`,
    confidence: 0.7,
    timeframe: TF,
    entry, stop, t1, t2,
  })];
}
