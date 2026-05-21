/**
 * Strategy CGT #4 — VWAP Mean Reversion (ChatGPT pack).
 *
 * Playbook (verbatim from VWAP.pdf):
 *   - Use VWAP during NY session.
 *   - Wait for overextended move away from VWAP.
 *   - Exhaustion candle + RSI divergence.
 *   - Enter back toward VWAP.
 *   - SL beyond session extreme.
 *   - Partial TP at VWAP.
 *
 * Internal id: CGT-VWAP
 */

import { atr, findSwings } from '../../lib/structure.js';
import { rsi, vwap } from '../../lib/indicators.js';
import { dayScopedId, buildTriggered } from '../_helpers.js';
import { nyParts, nyOpenUnix, killzoneStatus } from '../../lib/time.js';

const KEY = 'CGT-VWAP';
const TF = '15';
const NAME = 'VWAP Mean Reversion';

export function evaluate(ctx) {
  const pane = ctx.pane(TF);
  if (!pane || pane.bars.length < 60) return [];
  const bars = pane.bars;
  const last = bars[bars.length - 1];
  if (!last) return [];

  // NY session gating
  const kz = killzoneStatus(last.time);
  if (!kz.inKillzone) return [];

  const sessionStart = nyOpenUnix(last.time);
  const v = vwap(bars, sessionStart);
  if (v == null) return [];
  const sessionBars = bars.filter((b) => b.time >= sessionStart);
  if (sessionBars.length < 3) return [];

  const a = atr(bars, 14);
  if (!a) return [];

  // Overextended = > 2× ATR from VWAP
  const distance = last.close - v;
  const overextendedShort = distance > 2 * a;   // price way above VWAP → fade short
  const overextendedLong = -distance > 2 * a;   // price way below VWAP → fade long
  if (!overextendedShort && !overextendedLong) return [];

  const direction = overextendedLong ? 'LONG' : 'SHORT';

  // RSI divergence on session: compare last two swing extremes
  const rsiSeries = rsi(bars, 14);
  if (rsiSeries.length === 0) return [];
  const { highs, lows } = findSwings(bars.slice(-30), 2);
  let hasDiv = false;
  if (direction === 'SHORT' && highs.length >= 2) {
    const h1 = highs[highs.length - 2];
    const h2 = highs[highs.length - 1];
    // need indices into the full bars array
    const base = bars.length - 30;
    const r1 = rsiSeries[base + h1.idx];
    const r2 = rsiSeries[base + h2.idx];
    if (h2.price > h1.price && r2 != null && r1 != null && r2 < r1) hasDiv = true;
  } else if (direction === 'LONG' && lows.length >= 2) {
    const l1 = lows[lows.length - 2];
    const l2 = lows[lows.length - 1];
    const base = bars.length - 30;
    const r1 = rsiSeries[base + l1.idx];
    const r2 = rsiSeries[base + l2.idx];
    if (l2.price < l1.price && r2 != null && r1 != null && r2 > r1) hasDiv = true;
  }
  if (!hasDiv) return [];

  // Exhaustion candle: most recent CLOSED bar shows wick rejection in trade dir
  const prev = bars[bars.length - 2];
  if (!prev) return [];
  const range = prev.high - prev.low;
  if (range <= 0) return [];
  const upperWick = prev.high - Math.max(prev.open, prev.close);
  const lowerWick = Math.min(prev.open, prev.close) - prev.low;
  const exhaustion = direction === 'SHORT' ? (upperWick / range >= 0.4) : (lowerWick / range >= 0.4);
  if (!exhaustion) return [];

  const entry = last.close;
  // SL beyond session extreme
  const sessExtreme = direction === 'SHORT'
    ? Math.max(...sessionBars.map((b) => b.high))
    : Math.min(...sessionBars.map((b) => b.low));
  const stop = direction === 'SHORT' ? sessExtreme + 0.5 : sessExtreme - 0.5;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return [];
  // TP = VWAP (partial), then extended past for runner
  const t1 = v;
  const t2 = direction === 'LONG' ? entry + 1.6 * risk : entry - 1.6 * risk;

  const { dateKey } = nyParts(last.time);
  return [buildTriggered({
    strategy: KEY,
    setupId: dayScopedId(KEY, dateKey, direction, 'vwap-fade'),
    direction,
    setupName: `${NAME} — ${direction} fade back to VWAP`,
    summary: `Price ${distance > 0 ? '+' : ''}${distance.toFixed(2)} from VWAP $${v.toFixed(2)} (>2 ATR); RSI div + exhaustion confirms.`,
    confidence: 0.7,
    timeframe: TF,
    entry, stop, t1, t2,
  })];
}
