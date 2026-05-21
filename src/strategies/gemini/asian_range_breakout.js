/**
 * Strategy GEM #1 — Asian Range Breakout (Gemini pack).
 *
 * Playbook (verbatim from Asian Range Breakout.pdf):
 *   - 15m chart.
 *   - Mark high/low of Asian Session (00:00–06:00 GMT).
 *   - Wait for London Open (07:00 GMT onwards).
 *   - Entry: 15m candle CLOSES completely outside Asian range w/ noticeable volume.
 *   - SL: midpoint of Asian range (or 1 ATR below the breakout candle for tighter risk).
 *   - TP 1.5R (1:1.5). Move SL to BE when price reaches 1:1.
 *
 * Internal id: GEM-ASIA
 */

import { atr } from '../../lib/structure.js';
import { dayScopedId, buildTriggered, rangeOf, barsInWindow, volNoticeable } from '../_helpers.js';
import { gmtParts, gmtAsianWindow, gmtWallToUnix } from '../../lib/time.js';
import { is24x7 } from '../../lib/runtime_config.js';

const KEY = 'GEM-ASIA';
const TF = '15';
const NAME = 'Asian Range Breakout';

export function evaluate(ctx) {
  const pane = ctx.panesByTf.get(`gold|${TF}`);
  if (!pane || pane.bars.length < 60) return [];
  const bars = pane.bars;
  const last = bars[bars.length - 1];
  if (!last) return [];

  const gp = gmtParts(last.time);
  const wd = new Date(last.time * 1000).getUTCDay();
  if (wd === 6 || wd === 0) return [];
  // Default window is London open through end of NY (07:00-21:00 GMT). When
  // 24/7 mode is on, drop the window so the bot can fire on a late Asian
  // breakout etc.
  if (!is24x7()) {
    const inWindow = gp.minutesOfDay >= 7 * 60 && gp.minutesOfDay < 16 * 60;
    if (!inWindow) return [];
  }

  const { start, end } = gmtAsianWindow(last.time);
  const asianBars = barsInWindow(bars, start, end);
  if (asianBars.length < 8) return [];
  const range = rangeOf(asianBars);
  if (!range) return [];

  // Scan post-Asian closed bars for first qualifying breakout close
  const closedBars = bars.slice(0, -1);
  const since = closedBars.filter((b) => b.time >= end);
  let breakout = null;
  for (const c of since) {
    const completelyAbove = c.open > range.high && c.close > range.high;
    const completelyBelow = c.open < range.low && c.close < range.low;
    // spec says "closes completely outside" — interpret as both open and close outside
    if (completelyAbove) {
      const seriesUpTo = bars.filter((b) => b.time <= c.time);
      if (volNoticeable(seriesUpTo, 1.2, 10)) { breakout = { direction: 'LONG', bar: c }; break; }
    }
    if (completelyBelow) {
      const seriesUpTo = bars.filter((b) => b.time <= c.time);
      if (volNoticeable(seriesUpTo, 1.2, 10)) { breakout = { direction: 'SHORT', bar: c }; break; }
    }
  }
  if (!breakout) return [];

  // Only fire when the breakout candle is the most-recent CLOSED bar
  // (so we alert at trigger time, not retroactively when scrolling history).
  const lastClosed = closedBars[closedBars.length - 1];
  if (lastClosed.time !== breakout.bar.time) return [];

  const entry = breakout.bar.close;
  const a = atr(bars, 14) || (range.high - range.low) * 0.2;
  // Spec offers two SL options — use the TIGHTER of (mid of Asian range, 1 ATR
  // beyond breakout candle). Smaller risk → better RR for the 1.5R target.
  const slMid = range.mid;
  const slAtr = breakout.direction === 'LONG' ? breakout.bar.low - a : breakout.bar.high + a;
  const stop = breakout.direction === 'LONG'
    ? Math.max(slMid, slAtr)
    : Math.min(slMid, slAtr);
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return [];
  const t1 = breakout.direction === 'LONG' ? entry + 1.5 * risk : entry - 1.5 * risk;
  const runner = breakout.direction === 'LONG' ? entry + 2.5 * risk : entry - 2.5 * risk;

  return [buildTriggered({
    strategy: KEY,
    setupId: dayScopedId(KEY, gp.dateKey, breakout.direction, 'asian-bo'),
    direction: breakout.direction,
    setupName: `${NAME} — ${breakout.direction} break of Asian range`,
    summary: `Asian range $${range.low.toFixed(2)}-$${range.high.toFixed(2)}; 15m close completely ${breakout.direction === 'LONG' ? 'above' : 'below'} with volume confirms breakout.`,
    confidence: 0.71,
    timeframe: TF,
    entry, stop, t1, t2: t1, runner,
  })];
}
