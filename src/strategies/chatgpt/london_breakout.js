/**
 * Strategy CGT #1 — London Breakout Momentum (ChatGPT pack).
 *
 * Playbook (verbatim from LONDON BREAKOUT MOMENTUM.pdf):
 *   - Trade only between 8:00–11:00 London time (== 07:00-10:00 GMT winter,
 *     equivalent UTC offset adjusted for BST).
 *   - Mark Asian session high/low (Asian session = 00:00-07:00 GMT here —
 *     we use the standard 00:00-06:00 GMT block per the Gemini variant since
 *     ChatGPT doesn't specify a cutoff).
 *   - Wait for a candle CLOSE outside the Asian range with strong momentum.
 *   - Enter on first pullback into the breakout zone (the broken edge).
 *   - SL below/above the breakout candle.
 *   - TP 1.8R, or trail behind 15m swing low/high.
 *
 * Internal id: CGT-LONDON
 */

import { atr } from '../../lib/structure.js';
import { dayScopedId, buildTriggered, rangeOf, barsInWindow, volNoticeable } from '../_helpers.js';
import { gmtParts, gmtAsianWindow, gmtWallToUnix } from '../../lib/time.js';

const KEY = 'CGT-LONDON';
const TF = '15';
const NAME = 'London Breakout Momentum';

export function evaluate(ctx) {
  const pane = ctx.panesByTf.get(`gold|${TF}`);
  if (!pane || pane.bars.length < 60) return [];
  const bars = pane.bars;
  const last = bars[bars.length - 1];
  if (!last) return [];

  const gp = gmtParts(last.time);
  // London window 08:00–11:00 GMT (covers London cash open 08:00 GMT through
  // London/NY overlap onset). Spec says "London time"; in winter London = GMT,
  // in summer London = GMT+1, so 08:00-11:00 London ≈ 07:00-11:00 GMT depending
  // on DST. We use 07:00-11:00 GMT as a permissive union of both seasons.
  const inWindow = gp.minutesOfDay >= 7 * 60 && gp.minutesOfDay < 11 * 60;
  if (!inWindow) return [];
  // Weekend exclusion (GMT date)
  const wd = new Date(last.time * 1000).getUTCDay();
  if (wd === 6 || wd === 0) return [];

  // Asian range for today (00:00–06:00 GMT, same calendar day)
  const { start, end } = gmtAsianWindow(last.time);
  const asianBars = barsInWindow(bars, start, end);
  if (asianBars.length < 8) return [];
  const range = rangeOf(asianBars);
  if (!range) return [];
  const rangeHeight = range.high - range.low;
  if (rangeHeight <= 0) return [];

  // Has a 15m bar already CLOSED outside the range, with noticeable volume?
  // Scan all closed bars since the Asian session ended.
  const breakoutWindowStart = end;
  const breakoutWindowEnd = gmtWallToUnix(gp.y, gp.m, gp.d, 11, 0);
  const closedBars = bars.slice(0, -1);
  const candidates = closedBars.filter((b) => b.time >= breakoutWindowStart && b.time < breakoutWindowEnd);
  let breakout = null;
  for (const c of candidates) {
    if (c.close > range.high && volNoticeable([...closedBars.filter((x) => x.time < c.time), c], 1.2, 10)) {
      breakout = { direction: 'LONG', bar: c, brokenLevel: range.high };
      break; // first qualifying breakout — we're following the first impulse
    }
    if (c.close < range.low && volNoticeable([...closedBars.filter((x) => x.time < c.time), c], 1.2, 10)) {
      breakout = { direction: 'SHORT', bar: c, brokenLevel: range.low };
      break;
    }
  }
  if (!breakout) return [];

  // Pullback condition: at least one bar AFTER the breakout has revisited
  // the broken edge (low ≤ brokenLevel ≤ high for LONG, similar for SHORT).
  const afterBreak = closedBars.filter((b) => b.time > breakout.bar.time);
  const pulledBack = afterBreak.some((b) =>
    breakout.direction === 'LONG'
      ? (b.low <= breakout.brokenLevel)
      : (b.high >= breakout.brokenLevel)
  );
  if (!pulledBack) return [];

  // Trigger on the most recent CLOSED bar showing rejection back in the
  // breakout direction (close > brokenLevel for LONG).
  const cur = closedBars[closedBars.length - 1];
  const confirmed = breakout.direction === 'LONG'
    ? cur.close > breakout.brokenLevel && cur.close > cur.open
    : cur.close < breakout.brokenLevel && cur.close < cur.open;
  if (!confirmed) return [];

  const entry = cur.close;
  const stop = breakout.direction === 'LONG' ? breakout.bar.low - 0.5 : breakout.bar.high + 0.5;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return [];
  const t1 = breakout.direction === 'LONG' ? entry + 1.8 * risk : entry - 1.8 * risk;
  const runner = breakout.direction === 'LONG' ? entry + 3 * risk : entry - 3 * risk;

  return [buildTriggered({
    strategy: KEY,
    setupId: dayScopedId(KEY, gp.dateKey, breakout.direction, 'london-bo'),
    direction: breakout.direction,
    setupName: `${NAME} — ${breakout.direction} break of Asian range`,
    summary: `Asian range $${range.low.toFixed(2)}-$${range.high.toFixed(2)} broken ${breakout.direction === 'LONG' ? 'above' : 'below'}; pullback + retest confirmed.`,
    confidence: 0.74,
    timeframe: TF,
    entry, stop, t1, t2: t1, runner,
  })];
}
