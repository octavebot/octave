/**
 * Strategy #6 — Cross-Asset SMT Divergence M15
 *
 * Per SMT.pdf: M15 state machine that requires TWO correlated streams.
 * For XAU/USD trading, the natural correlated sibling is XAG/USD (Silver).
 *
 *   STATE 0 IDLE → 1 RESOLVE_BOUNDARIES (when KZ opens)
 *   STATE 1 → 2 PARSE_SMT_MATRIX (gold/silver SMT divergence check at each M15 close)
 *   STATE 2 → 3 MONITOR_SHIFT (after SMT TRUE, watch for MSS body close past local swing)
 *   STATE 3 → 4 ROUTE_ORDER (FVG forms → limit order at C1 boundary)
 *   STATE 4 → 5 LIFECYCLE_MGMT (OCO: SL at sweep wick / TP1 at 1:2 RR)
 *
 * SMT divergence (matches PDF spec exactly):
 *   Bullish: Gold.Low[0] < Gold_Asian_SSL  AND  Silver.Low[0] > Silver_Asian_SSL
 *   Bearish: Gold.High[0] > Gold_Asian_BSL AND  Silver.High[0] < Silver_Asian_BSL
 *
 * Only fires during London (02:00-05:00) or NY (07:00-10:00) killzones.
 * Requires a silver pane in addition to the gold 15m pane.
 */

import { isMarketOpen, fmtNY } from '../lib/time.js';
import {
  activeKillZone, asianRangeHighLow, previousDayHighLow,
} from '../lib/ict_session.js';
import {
  detectSweep, detectMSS, findFVGs, atr,
} from '../lib/structure.js';

const NAME = 'SMT';
const LABEL = 'Strategy #6';
const PIP = 0.10;

function findGoldM15(ctx) {
  return ctx.panesByTf.get('gold|15');
}
function findSilverM15(ctx) {
  return ctx.panesByTf.get('silver|15') ||
         ctx.panesByTf.get('silver|5') ||
         ctx.panesByTf.get('silver|60');
}

/**
 * Check SMT condition per PDF spec.
 *   - For bullish: gold most recent bar low < gold Asian SSL AND silver most recent bar low > silver Asian SSL
 *   - For bearish: gold high > gold BSL AND silver high < silver BSL
 *
 * Returns { detected: bool, reason: string }
 */
function checkSMT(goldBars, silverBars, goldPools, silverPools, side) {
  const gLast = goldBars[goldBars.length - 1];
  // Find silver bar at the same time as the most recent gold bar (or nearest before)
  let sLast = null;
  for (let i = silverBars.length - 1; i >= 0; i--) {
    if (silverBars[i].time <= gLast.time) { sLast = silverBars[i]; break; }
  }
  if (!sLast) return { detected: false, reason: 'no silver bar aligned' };

  if (side === 'SSL') {
    const goldSwept = gLast.low < goldPools.low;
    const silverHeld = sLast.low > silverPools.low;
    if (goldSwept && silverHeld) {
      return {
        detected: true,
        reason: `Gold ${gLast.low.toFixed(2)} < SSL ${goldPools.low.toFixed(2)}; Silver ${sLast.low.toFixed(2)} > SSL ${silverPools.low.toFixed(2)}`,
      };
    }
    return { detected: false, reason: `Gold swept SSL=${goldSwept}, Silver held=${silverHeld}` };
  }
  // BSL side
  const goldSwept = gLast.high > goldPools.high;
  const silverHeld = sLast.high < silverPools.high;
  if (goldSwept && silverHeld) {
    return {
      detected: true,
      reason: `Gold ${gLast.high.toFixed(2)} > BSL ${goldPools.high.toFixed(2)}; Silver ${sLast.high.toFixed(2)} < BSL ${silverPools.high.toFixed(2)}`,
    };
  }
  return { detected: false, reason: `Gold swept BSL=${goldSwept}, Silver held=${silverHeld}` };
}

function evalDirection(ctx, m15, silver, kz, goldPools, silverPools, direction) {
  const bars = m15.bars;
  const side = direction === 'LONG' ? 'SSL' : 'BSL';
  const wantedMssDir = direction === 'LONG' ? 'bullish' : 'bearish';
  const lastClose = bars[bars.length - 1].close;
  const a14 = atr(bars, 14) || 0;

  const smt = checkSMT(bars, silver.bars, goldPools, silverPools, side);
  if (!smt.detected) {
    // Forming if we're close to the pool — heads-up that SMT is being watched
    const targetLevel = direction === 'LONG' ? goldPools.low : goldPools.high;
    if (a14 > 0 && Math.abs(lastClose - targetLevel) < 1.0 * a14) {
      return {
        strategy: NAME,
        setupId: `${NAME}-${ctx.dateKey}-${kz}-${direction}-watching-${side}`,
        status: 'forming',
        direction,
        setupName: `${LABEL} · ${kz.toUpperCase()} ${direction} — watching Gold/Silver SMT`,
        summary: `Price near ${side} ${targetLevel.toFixed(2)}. SMT not confirmed yet (${smt.reason}).`,
        confidence: 0.25,
        details: {
          'killzone': kz,
          'pool': `${side} @ ${targetLevel.toFixed(2)}`,
          'SMT status': smt.reason,
        },
        invalidationLevel: null,
        geometry: { target: { name: `Asian ${side}`, level: targetLevel, side } },
      };
    }
    return null;
  }

  // SMT confirmed — find the sweep on gold and look for MSS
  const sweep = detectSweep(bars, direction === 'LONG' ? goldPools.low : goldPools.high, side, 8);
  if (!sweep) {
    // Edge case: SMT TRUE but no clean sweep detected. Use the last bar's wick.
    return null;
  }

  const mss = detectMSS(bars, wantedMssDir, { displacementMult: 1.0, lookback: 10 });
  if (!mss || mss.idx <= sweep.idx) {
    return {
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${kz}-${direction}-smt-confirmed`,
      status: 'forming',
      direction,
      setupName: `${LABEL} · ${kz.toUpperCase()} ${direction} — SMT confirmed, awaiting MSS`,
      summary: `Gold/Silver SMT ${direction === 'LONG' ? 'bullish' : 'bearish'} divergence confirmed. Waiting for MSS body close.`,
      confidence: 0.6,
      details: {
        'killzone': kz,
        'SMT': smt.reason,
        'sweep wick': sweep.wickPrice.toFixed(2),
      },
      invalidationLevel: sweep.wickPrice,
      geometry: {
        target: { name: `Asian ${side}`, level: direction === 'LONG' ? goldPools.low : goldPools.high, side },
        sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
      },
    };
  }

  const allFvgs = findFVGs(bars, 20).filter((f) => f.side === wantedMssDir && !f.invalidated);
  const fvg = allFvgs.find((f) => f.idx >= mss.idx - 1 && f.idx <= mss.idx + 3);

  if (!fvg) {
    return {
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${kz}-${direction}-mss`,
      status: 'near_trigger',
      direction,
      setupName: `${LABEL} · ${kz.toUpperCase()} ${direction} — MSS done, awaiting FVG`,
      summary: `SMT + MSS confirmed (${mss.ratio.toFixed(1)}× ATR). Waiting for 3-candle FVG.`,
      confidence: 0.7,
      details: {
        'killzone': kz,
        'SMT': smt.reason,
        'sweep wick': sweep.wickPrice.toFixed(2),
        'MSS x ATR': mss.ratio.toFixed(2),
      },
      invalidationLevel: sweep.wickPrice,
      geometry: {
        target: { name: `Asian ${side}`, level: direction === 'LONG' ? goldPools.low : goldPools.high, side },
        sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
        mss: { brokenPrice: mss.brokenSwing.price, time: mss.time, ratio: mss.ratio },
      },
    };
  }

  // Full trigger
  const c1 = bars[fvg.idx - 1];
  const entry = direction === 'LONG' ? c1.high : c1.low;
  const buffer = 2 * PIP;
  const stop = direction === 'LONG' ? sweep.wickPrice - buffer : sweep.wickPrice + buffer;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const t1 = direction === 'LONG' ? entry + 2 * risk : entry - 2 * risk;
  const oppositeLevel = direction === 'LONG' ? goldPools.high : goldPools.low;
  const t2 = oppositeLevel;
  return {
    strategy: NAME,
    setupId: `${NAME}-${ctx.dateKey}-${kz}-${direction}-trig`,
    status: 'triggered',
    direction,
    setupName: `${LABEL} · ${kz.toUpperCase()} ${direction} TRIGGERED (SMT confluence)`,
    summary: `Gold/Silver SMT divergence → MSS → FVG. Limit ${entry.toFixed(2)} · SL ${stop.toFixed(2)} · TP1 ${t1.toFixed(2)} · TP2 ${t2.toFixed(2)}`,
    confidence: 0.85 + (mss.ratio >= 1.5 ? 0.04 : 0) + (kz === 'ny' ? 0.02 : 0),
    details: {
      'killzone': kz,
      'SMT': smt.reason,
      'sweep wick': sweep.wickPrice.toFixed(2),
      'MSS x ATR': mss.ratio.toFixed(2),
      'FVG': `${fvg.bottom.toFixed(2)} - ${fvg.top.toFixed(2)}`,
      'entry (C1 edge)': entry.toFixed(2),
      'stop (sweep ±2pip)': stop.toFixed(2),
      'TP1 (1:2 RR)': t1.toFixed(2),
      'TP2 (opposite pool)': t2.toFixed(2),
    },
    invalidationLevel: stop,
    entryPlan: { direction, entry, stop, t1, t2, runner: t2, risk },
    geometry: {
      target: { name: `Asian ${side}`, level: direction === 'LONG' ? goldPools.low : goldPools.high, side },
      sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
      mss: { brokenPrice: mss.brokenSwing.price, time: mss.time, ratio: mss.ratio },
      fvg: { top: fvg.top, bottom: fvg.bottom, time: fvg.time, side: fvg.side },
      entryPlan: { direction, entry, stop, t1, t2, runner: t2 },
    },
  };
}

export function evaluateSMTM15(ctx) {
  const now = ctx.ts / 1000;
  if (!isMarketOpen(now)) return [];
  const kz = activeKillZone(now);
  if (!kz) return [];

  const m15 = findGoldM15(ctx);
  if (!m15 || !m15.bars || m15.bars.length < 50) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-no-m15`,
      status: 'forming',
      direction: 'NONE',
      setupName: `${LABEL} · waiting — no 15m gold pane`,
      summary: 'Strategy #6 requires a 15m gold pane.',
      confidence: 0,
      details: { 'phase': 'state 0 — no M15 data' },
      invalidationLevel: null,
    }];
  }

  const silver = findSilverM15(ctx);
  if (!silver || !silver.bars || silver.bars.length < 50) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-no-silver`,
      status: 'forming',
      direction: 'NONE',
      setupName: `${LABEL} · waiting — no Silver pane`,
      summary: 'Strategy #6 requires a Silver pane (XAGUSD or SI1!) for cross-asset SMT divergence.',
      confidence: 0,
      details: { 'killzone': kz, 'phase': 'state 1 — silver missing' },
      invalidationLevel: null,
    }];
  }

  const goldPools = asianRangeHighLow(m15.bars, now) || previousDayHighLow(m15.bars, now);
  const silverPools = asianRangeHighLow(silver.bars, now) || previousDayHighLow(silver.bars, now);
  if (!goldPools || !silverPools) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${kz}-no-pools`,
      status: 'forming',
      direction: 'NONE',
      setupName: `${LABEL} · ${kz.toUpperCase()} — Asian range unresolved on one stream`,
      summary: `Gold pools: ${!!goldPools}. Silver pools: ${!!silverPools}. Need both to evaluate SMT.`,
      confidence: 0,
      details: { 'killzone': kz },
      invalidationLevel: null,
    }];
  }

  const out = [];
  const longResult = evalDirection(ctx, m15, silver, kz, goldPools, silverPools, 'LONG');
  if (longResult) out.push(longResult);
  const shortResult = evalDirection(ctx, m15, silver, kz, goldPools, silverPools, 'SHORT');
  if (shortResult) out.push(shortResult);
  return out;
}
