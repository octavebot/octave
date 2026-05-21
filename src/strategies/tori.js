/**
 * Strategy #9 — TORI (Tori Trades — Pure Price-Action Trendline Breakout)
 *
 * Source: TORI.pdf "Pure Price Action Trendline Strategy" by Tori Trades.
 *
 * Higher-time-frame setup on the 4-hour chart. The strategy is:
 *
 *   A) Identify an "A+" trendline. ALL four criteria required:
 *       1. ≥3 touchpoints (wick anchors preferred)
 *       2. ≥6 candles between consecutive touchpoints
 *       3. ≥3 weeks (504 hours = 126 4H bars) between first touch and now
 *       4. Slope sustainable — under 45° on the macro 3-month view
 *
 *   B) Wait for a 4H candle to BODY CLOSE outside the trendline (not just a
 *      wick). Enter market at the close of that confirming candle.
 *
 *   C) Skip if the breakout candle closes "too far" from the line (chase filter).
 *      Skip if not at least 1:2 RR to the next horizontal S/R target.
 *      Only one trade attempt per drawn trendline.
 *
 *   D) Stop: project a "safety line" (complementary trendline across opposing
 *      swings) and place the stop where that line is projected to be 4 candles
 *      after entry. We approximate this with the recent swing low/high
 *      (whichever is opposing the direction) offset by 4 bars × slope.
 *
 *   E) Target: nearest significant horizontal level (recent multi-touch
 *      support/resistance on 4H).
 *
 * Yahoo's gold endpoint only provides up to 60m natively, so we resample to
 * 4H using lib/resample.js. 60m × 2 years = ~12,400 bars; resampling produces
 * ~3,100 4H bars — plenty for 3-week trendline detection.
 */

import { resampleTo4H } from '../lib/resample.js';
import { atr, findSwings } from '../lib/structure.js';

const NAME = 'TORI';
const LABEL = 'Strategy #9';
const MIN_TOUCHES = 3;
const MIN_SPACING_BARS = 6;
const MIN_HISTORY_BARS = 126; // 3 weeks × 7 trading days × 6 4H bars/day (rough; commodities trade Sun-Fri)
const MAX_SLOPE_PER_BAR_PCT = 0.025; // <45° on macro 3-month view — empirically <2.5%/bar
const RR_MIN = 2.0;
const TRENDLINE_TOLERANCE_ATR = 0.25;
const CHASE_MAX_DISTANCE_ATR = 1.5;

function find4HGoldBars(ctx) {
  // Prefer native if some external source provides "gold|240" later
  const native = ctx.panesByTf.get('gold|240');
  if (native?.bars?.length >= 50) return native.bars;
  const h1 = ctx.panesByTf.get('gold|60');
  if (!h1?.bars?.length) return null;
  return resampleTo4H(h1.bars);
}

/** Linear-fit a line through (x, y) for an indexed set, return slope/intercept. */
function fitLine(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

/**
 * Find the best "A+" descending or ascending trendline using recent swing
 * highs (for descending) or swing lows (for ascending). Returns the trendline
 * params + the touchpoints used, or null.
 */
function findA_Plus_Trendline(bars, direction) {
  // direction='DOWN' → descending trendline through swing HIGHS (break upward)
  // direction='UP'   → ascending trendline through swing LOWS  (break downward)
  const { highs, lows } = findSwings(bars, 3);
  // Cap candidates to the most recent 30 swings. The triple-nested loop below
  // is O(n³) — without this cap, a 60-day 4H backtest with 80+ swings runs
  // 500k+ iterations per anchor tick × thousands of ticks → freezes the
  // backtest child for minutes. 30 swings keeps it under 30k iterations.
  let candidates = direction === 'DOWN' ? highs : lows;
  if (candidates.length > 30) candidates = candidates.slice(-30);
  if (candidates.length < MIN_TOUCHES) return null;
  const a14 = atr(bars, 14) || 1;
  const tolerance = TRENDLINE_TOLERANCE_ATR * a14;

  // Greedy: from each candidate as anchor #1, try to build the longest
  // chain of touchpoints respecting spacing and slope constraints.
  let best = null;
  for (let i = 0; i < candidates.length - (MIN_TOUCHES - 1); i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      if (b.idx - a.idx < MIN_SPACING_BARS) continue;
      // Initial slope from these two
      const slope = (b.price - a.price) / (b.idx - a.idx);
      const intercept = a.price - slope * a.idx;
      // For DOWN trendline we want slope ≤ 0 (or just below zero for slight downward decay)
      // For UP we want slope ≥ 0
      if (direction === 'DOWN' && slope > 0) continue;
      if (direction === 'UP' && slope < 0) continue;
      // Slope sustainability filter (% per bar relative to last price)
      const lastPrice = bars[bars.length - 1].close;
      if (Math.abs(slope) / lastPrice > MAX_SLOPE_PER_BAR_PCT) continue;

      // Find other touchpoints respecting tolerance + spacing
      const touches = [a, b];
      let lastIdx = b.idx;
      for (let k = j + 1; k < candidates.length; k++) {
        const c = candidates[k];
        if (c.idx - lastIdx < MIN_SPACING_BARS) continue;
        const linePrice = slope * c.idx + intercept;
        if (Math.abs(c.price - linePrice) <= tolerance) {
          touches.push(c);
          lastIdx = c.idx;
        }
      }
      if (touches.length < MIN_TOUCHES) continue;
      // History maturity check: span from first touch to last bar
      const span = bars.length - 1 - touches[0].idx;
      if (span < MIN_HISTORY_BARS) continue;
      // Re-fit using all touches for a better trendline
      const fit = fitLine(touches.map((t) => ({ x: t.idx, y: t.price })));
      if (!fit) continue;
      if (direction === 'DOWN' && fit.slope > 0) continue;
      if (direction === 'UP' && fit.slope < 0) continue;
      if (Math.abs(fit.slope) / lastPrice > MAX_SLOPE_PER_BAR_PCT) continue;

      const score = touches.length + span / 200; // more touches, more history = better
      if (!best || score > best.score) {
        best = { ...fit, touches, score, span, direction };
      }
    }
  }
  return best;
}

function nearestHorizontalLevel(bars, fromPrice, direction) {
  const { highs, lows } = findSwings(bars.slice(-200), 3);
  const candidates = direction === 'LONG' ? highs : lows;
  if (!candidates.length) return null;
  if (direction === 'LONG') {
    const above = candidates.filter((s) => s.price > fromPrice).map((s) => s.price).sort((a, b) => a - b);
    return above[0] ?? null;
  }
  const below = candidates.filter((s) => s.price < fromPrice).map((s) => s.price).sort((a, b) => b - a);
  return below[0] ?? null;
}

function safetyStop(bars, line, direction, entryIdx) {
  // Approximate the safety line as the opposing trendline through nearby
  // opposing swings. Then project to entryIdx + 4 bars.
  const opp = findA_Plus_Trendline(bars, direction === 'LONG' ? 'UP' : 'DOWN');
  const projectIdx = entryIdx + 4;
  if (opp) {
    const projected = opp.slope * projectIdx + opp.intercept;
    return projected;
  }
  // Fallback: recent opposing swing offset by a small buffer
  const { highs, lows } = findSwings(bars.slice(-30), 2);
  const last = bars[bars.length - 1];
  const a14 = atr(bars, 14) || 1;
  if (direction === 'LONG') {
    if (lows.length === 0) return last.low - a14;
    return lows[lows.length - 1].price - 0.3 * a14;
  }
  if (highs.length === 0) return last.high + a14;
  return highs[highs.length - 1].price + 0.3 * a14;
}

export function evaluateTORI(ctx) {
  const bars = find4HGoldBars(ctx);
  if (!bars || bars.length < MIN_HISTORY_BARS + 20) return [];
  const last = bars[bars.length - 1];
  const lastIdx = bars.length - 1;
  const a14 = atr(bars, 14) || 1;
  const out = [];

  // LONG breakout: descending trendline through swing HIGHS broken upward
  // by a 4H candle body close.
  const longLine = findA_Plus_Trendline(bars, 'DOWN');
  if (longLine) {
    const linePrice = longLine.slope * lastIdx + longLine.intercept;
    const bodyTop = Math.max(last.open, last.close);
    const bodyBottom = Math.min(last.open, last.close);
    // Strict body-close above the line, body bottom below (i.e., this candle did the breaking)
    if (bodyTop > linePrice && bodyBottom < linePrice + a14 * 0.5) {
      const distance = last.close - linePrice;
      if (distance > 0 && distance <= CHASE_MAX_DISTANCE_ATR * a14) {
        const entry = last.close;
        const stop = safetyStop(bars, longLine, 'LONG', lastIdx);
        if (stop < entry) {
          const risk = entry - stop;
          const tgt = nearestHorizontalLevel(bars, entry, 'LONG');
          const ratio = tgt ? (tgt - entry) / risk : 0;
          if (tgt && ratio >= RR_MIN) {
            const t1 = tgt;
            out.push({
              strategy: NAME,
              setupId: `${NAME}-${ctx.dateKey}-LONG-${Math.round(entry * 100)}`,
              status: 'triggered',
              direction: 'LONG',
              setupName: `${LABEL} · LONG 4H trendline BREAKOUT`,
              summary: `Descending 4H trendline broken upward (${longLine.touches.length} touches over ${longLine.span} 4H bars). Entry ${entry.toFixed(2)} · SL ${stop.toFixed(2)} · TP ${t1.toFixed(2)} (1:${ratio.toFixed(2)} RR).`,
              confidence: 0.74 + (longLine.touches.length >= 4 ? 0.06 : 0),
              details: {
                'trendline touches': String(longLine.touches.length),
                'trendline span': `${longLine.span} 4H bars`,
                'line @ now': linePrice.toFixed(2),
                'breakout close': entry.toFixed(2),
                'stop (safety line)': stop.toFixed(2),
                'TP (horizontal S/R)': t1.toFixed(2),
                'RR': `1:${ratio.toFixed(2)}`,
              },
              invalidationLevel: stop,
              entryPlan: { direction: 'LONG', entry, stop, t1, t2: t1, runner: t1, risk },
              geometry: {
                target: { name: 'Horizontal S/R', level: t1 },
                mss: { brokenPrice: linePrice, time: last.time },
                entryPlan: { direction: 'LONG', entry, stop, t1, t2: t1, runner: t1 },
              },
            });
          }
        }
      }
    }
  }

  // SHORT breakout: ascending trendline through swing LOWS broken downward.
  const shortLine = findA_Plus_Trendline(bars, 'UP');
  if (shortLine) {
    const linePrice = shortLine.slope * lastIdx + shortLine.intercept;
    const bodyTop = Math.max(last.open, last.close);
    const bodyBottom = Math.min(last.open, last.close);
    if (bodyBottom < linePrice && bodyTop > linePrice - a14 * 0.5) {
      const distance = linePrice - last.close;
      if (distance > 0 && distance <= CHASE_MAX_DISTANCE_ATR * a14) {
        const entry = last.close;
        const stop = safetyStop(bars, shortLine, 'SHORT', lastIdx);
        if (stop > entry) {
          const risk = stop - entry;
          const tgt = nearestHorizontalLevel(bars, entry, 'SHORT');
          const ratio = tgt ? (entry - tgt) / risk : 0;
          if (tgt && ratio >= RR_MIN) {
            const t1 = tgt;
            out.push({
              strategy: NAME,
              setupId: `${NAME}-${ctx.dateKey}-SHORT-${Math.round(entry * 100)}`,
              status: 'triggered',
              direction: 'SHORT',
              setupName: `${LABEL} · SHORT 4H trendline BREAKDOWN`,
              summary: `Ascending 4H trendline broken downward (${shortLine.touches.length} touches over ${shortLine.span} 4H bars). Entry ${entry.toFixed(2)} · SL ${stop.toFixed(2)} · TP ${t1.toFixed(2)} (1:${ratio.toFixed(2)} RR).`,
              confidence: 0.74 + (shortLine.touches.length >= 4 ? 0.06 : 0),
              details: {
                'trendline touches': String(shortLine.touches.length),
                'trendline span': `${shortLine.span} 4H bars`,
                'line @ now': linePrice.toFixed(2),
                'breakdown close': entry.toFixed(2),
                'stop (safety line)': stop.toFixed(2),
                'TP (horizontal S/R)': t1.toFixed(2),
                'RR': `1:${ratio.toFixed(2)}`,
              },
              invalidationLevel: stop,
              entryPlan: { direction: 'SHORT', entry, stop, t1, t2: t1, runner: t1, risk },
              geometry: {
                target: { name: 'Horizontal S/R', level: t1 },
                mss: { brokenPrice: linePrice, time: last.time },
                entryPlan: { direction: 'SHORT', entry, stop, t1, t2: t1, runner: t1 },
              },
            });
          }
        }
      }
    }
  }

  return out;
}
