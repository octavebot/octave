/**
 * Strategy CGT #2 — NY Reversal Trap (ChatGPT pack).
 *
 * Playbook (verbatim from NY REVERSAL TRAP.pdf):
 *   - Focus only on the New York open (08:30-11:00 EST window).
 *   - Wait for price to sweep previous high or low (PDH/PDL).
 *   - Enter after rejection candle closes back inside range.
 *   - 5m structure break for confirmation (downgraded: we use 15m close
 *     reversal since our gate forces 15m+).
 *   - SL above liquidity sweep.
 *   - Target opposing intraday liquidity.
 *
 * Internal id: CGT-NYREV
 */

import { atr, detectSweep } from '../../lib/structure.js';
import { dayScopedId, buildTriggered, previousDayHL, lastBullishRejection, lastBearishRejection } from '../_helpers.js';
import { nyParts, killzoneStatus } from '../../lib/time.js';

const KEY = 'CGT-NYREV';
const TF = '15';
const NAME = 'NY Reversal Trap';

export function evaluate(ctx) {
  const pane = ctx.pane(TF);
  const daily = ctx.pane('1D') || ctx.pane('D');
  if (!pane || pane.bars.length < 60) return [];
  if (!daily) return [];
  const bars = pane.bars;
  const last = bars[bars.length - 1];
  if (!last) return [];

  const kz = killzoneStatus(last.time);
  if (!kz.inKillzone) return [];

  const pdhl = previousDayHL(daily);
  if (!pdhl) return [];

  // Look for a sweep of PDH or PDL within last 6 bars on 15m
  const closedBars = bars.slice(0, -1);
  const lookback = closedBars.slice(-6);
  const sweepHigh = detectSweep(lookback, pdhl.high, 'BSL', 6);
  const sweepLow = detectSweep(lookback, pdhl.low, 'SSL', 6);
  if (!sweepHigh && !sweepLow) return [];

  let direction, sweptLevel, opposing;
  if (sweepHigh) {
    direction = 'SHORT';
    sweptLevel = pdhl.high;
    opposing = pdhl.low;
  } else {
    direction = 'LONG';
    sweptLevel = pdhl.low;
    opposing = pdhl.high;
  }

  // Most recent CLOSED bar must be a rejection in the trade direction
  const ok = direction === 'LONG' ? lastBullishRejection(closedBars) : lastBearishRejection(closedBars);
  if (!ok) return [];

  const cur = closedBars[closedBars.length - 1];
  const entry = cur.close;
  const stop = direction === 'LONG'
    ? Math.min(...lookback.map((b) => b.low)) - 0.5
    : Math.max(...lookback.map((b) => b.high)) + 0.5;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return [];
  // TP target: opposing intraday liquidity (the other PDH/PDL) AND a 2R floor
  const targetByLiquidity = opposing;
  const targetMin = direction === 'LONG' ? entry + 2 * risk : entry - 2 * risk;
  const t1 = direction === 'LONG'
    ? Math.max(targetByLiquidity, targetMin)
    : Math.min(targetByLiquidity, targetMin);
  const t2 = direction === 'LONG' ? entry + 3 * risk : entry - 3 * risk;

  const { dateKey } = nyParts(last.time);
  return [buildTriggered({
    strategy: KEY,
    setupId: dayScopedId(KEY, dateKey, direction, direction === 'LONG' ? 'pdl-sweep' : 'pdh-sweep'),
    direction,
    setupName: `${NAME} — ${direction} after ${direction === 'LONG' ? 'PDL' : 'PDH'} sweep`,
    summary: `${direction === 'LONG' ? 'PDL' : 'PDH'} $${sweptLevel.toFixed(2)} swept; 15m rejection closes back inside range.`,
    confidence: 0.76,
    timeframe: TF,
    entry, stop, t1, t2,
  })];
}
