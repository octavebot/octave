/**
 * Strategy #7 — The Trinity Model (Colin Jones)
 *
 * 3-step pipeline (per Trinity_Model_Blueprint.pdf):
 *
 *   Step 1: HTF Fair Value Gap on 15-minute or higher chart, aligned with daily narrative.
 *           Bearish narrative → bearish FVG above price.
 *           Bullish narrative → bullish FVG below price.
 *
 *   Step 2: Gold/Silver SMT divergence AFTER price has tapped into the HTF gap.
 *           (Original PDF uses NQ/ES; for gold trading we use Gold/Silver.)
 *
 *   Step 3: LTF (1-5 min) Inverse FVG = entry signal.
 *           Counter-direction FVG that gets violated → becomes IFVG → entry on flip candle close.
 *
 *   Stop loss: above/below the swing point that created the SMT inside the HTF gap.
 *
 *   Rules:
 *     - Active only 9:30-11:00 AM EST (per Trinity Rule #2)
 *     - Skip on FOMC / Fed Chair / no-news Mondays (Rule #1) — uses news.json blackout
 *     - "Stop after 1 win or 2 losses" (Rule #3) is operator discipline, not enforced here.
 *
 * Required panes:
 *   - 15m gold (HTF FVG mapping)
 *   - 1m or 3m or 5m gold (LTF IFVG detection)
 *   - Silver pane (any TF) — for SMT divergence
 *   - Optional Daily gold for narrative computation (falls back to recent 15m structure)
 */

import { isMarketOpen, isInTrinityWindow, fmtNY } from '../lib/time.js';
import { findFVGs, findSwings, atr } from '../lib/structure.js';
import { macd } from '../lib/indicators.js';
import { checkBlackout } from '../lib/news.js';

const NAME = 'TRINITY';
const LABEL = 'Strategy #7';

function findPane(ctx, key) {
  return ctx.panesByTf.get(key);
}

function pickHTFPane(ctx) {
  // PDF says "15-minute or higher" for HTF gap
  return findPane(ctx, 'gold|15') || findPane(ctx, 'gold|60');
}
function pickLTFPane(ctx) {
  // PDF says "1 through 5 minute charts" for IFVG entry
  return findPane(ctx, 'gold|1') || findPane(ctx, 'gold|3') || findPane(ctx, 'gold|5');
}
function pickSilverPane(ctx) {
  return findPane(ctx, 'silver|15') || findPane(ctx, 'silver|5') ||
         findPane(ctx, 'silver|3')  || findPane(ctx, 'silver|1') || findPane(ctx, 'silver|60');
}
function pickDailyGold(ctx) {
  return findPane(ctx, 'gold|1D') || findPane(ctx, 'gold|D');
}

/**
 * Determine daily narrative (bullish / bearish / neutral).
 * Prefer Daily MACD if available. Fallback: trend on the highest TF gold pane we have.
 */
function computeNarrative(ctx) {
  const daily = pickDailyGold(ctx);
  if (daily?.bars && daily.bars.length >= 35) {
    const m = macd(daily.bars);
    if (m) {
      const reason = `Daily MACD ${m.macd.toFixed(2)} / signal ${m.signal.toFixed(2)} / hist ${m.hist.toFixed(2)}`;
      if (m.hist > 0 && m.macd > m.signal) return { narrative: 'bullish', reason };
      if (m.hist < 0 && m.macd < m.signal) return { narrative: 'bearish', reason };
      return { narrative: 'neutral', reason };
    }
  }
  // Fallback: use HTF pane recent structure
  const htf = findPane(ctx, 'gold|240') || findPane(ctx, 'gold|60') || pickHTFPane(ctx);
  if (htf?.bars && htf.bars.length >= 20) {
    const { highs, lows } = findSwings(htf.bars, 3);
    if (highs.length >= 2 && lows.length >= 2) {
      const h1 = highs[highs.length - 1].price, h0 = highs[highs.length - 2].price;
      const l1 = lows[lows.length - 1].price, l0 = lows[lows.length - 2].price;
      if (h1 > h0 && l1 > l0) return { narrative: 'bullish', reason: `${htf.resolution}m structure HH+HL` };
      if (h1 < h0 && l1 < l0) return { narrative: 'bearish', reason: `${htf.resolution}m structure LH+LL` };
    }
  }
  return { narrative: 'neutral', reason: 'no clear bias from available panes' };
}

/**
 * Find the most recent UNFILLED HTF FVG on the side of the narrative.
 *   Bearish narrative → look for bearish FVG (top above current price, bottom above-ish)
 *   Bullish narrative → look for bullish FVG (bottom below current price)
 */
function findRelevantHTFGap(htfPane, narrative, currentPrice) {
  const fvgs = findFVGs(htfPane.bars, 80);
  if (narrative === 'bearish') {
    // Bearish FVG above price, not yet invalidated
    const cands = fvgs.filter((f) => f.side === 'bearish' && !f.invalidated && f.bottom >= currentPrice * 0.998);
    return cands.length ? cands[cands.length - 1] : null;
  }
  if (narrative === 'bullish') {
    const cands = fvgs.filter((f) => f.side === 'bullish' && !f.invalidated && f.top <= currentPrice * 1.002);
    return cands.length ? cands[cands.length - 1] : null;
  }
  return null;
}

/**
 * Check if HTF gap has been TAPPED (touched) in recent bars.
 * Returns the tap info {idx, time} if found, else null.
 */
function findHTFGapTap(htfPane, gap, lookback = 12) {
  const start = Math.max(gap.idx + 2, htfPane.bars.length - lookback);
  for (let i = start; i < htfPane.bars.length; i++) {
    const b = htfPane.bars[i];
    if (b.low <= gap.top && b.high >= gap.bottom) {
      return { idx: i, time: b.time };
    }
  }
  return null;
}

/**
 * Detect SMT divergence on bars AFTER the tap.
 * Bearish SMT: gold makes a higher high after tap, silver does NOT.
 * Bullish SMT: gold makes a lower low after tap, silver does NOT.
 * Returns { detected, swingPrice, swingTime, reason }.
 */
function detectPostTapSMT(htfPane, silverPane, tapTime, narrative) {
  if (!silverPane || !silverPane.bars) return { detected: false, reason: 'no silver pane' };
  const goldSince = htfPane.bars.filter((b) => b.time >= tapTime);
  const silverSince = silverPane.bars.filter((b) => b.time >= tapTime);
  if (goldSince.length < 2 || silverSince.length < 2) {
    return { detected: false, reason: 'insufficient post-tap bars' };
  }

  if (narrative === 'bearish') {
    // Gold made a higher high since tap, silver did NOT
    let goldMaxIdx = 0, silverMaxIdx = 0;
    for (let i = 1; i < goldSince.length; i++) if (goldSince[i].high > goldSince[goldMaxIdx].high) goldMaxIdx = i;
    for (let i = 1; i < silverSince.length; i++) if (silverSince[i].high > silverSince[silverMaxIdx].high) silverMaxIdx = i;
    const goldMakingNewHigh = goldMaxIdx === goldSince.length - 1 || goldMaxIdx > 0;
    const goldHi = goldSince[goldMaxIdx].high;
    const silverHi = silverSince[silverMaxIdx].high;
    // SMT: gold high is "fresh" (in recent half) but silver high is "stale" (in early half)
    if (goldMakingNewHigh && goldMaxIdx >= goldSince.length / 2 && silverMaxIdx < silverSince.length / 2) {
      return {
        detected: true,
        swingPrice: goldHi,
        swingTime: goldSince[goldMaxIdx].time,
        reason: `Gold HH @ ${goldHi.toFixed(2)} (bar ${goldMaxIdx}/${goldSince.length - 1}), Silver high held @ bar ${silverMaxIdx}`,
      };
    }
    return { detected: false, reason: `Gold high bar ${goldMaxIdx}/${goldSince.length - 1}, Silver high bar ${silverMaxIdx}/${silverSince.length - 1} — no divergence yet` };
  }
  if (narrative === 'bullish') {
    let goldMinIdx = 0, silverMinIdx = 0;
    for (let i = 1; i < goldSince.length; i++) if (goldSince[i].low < goldSince[goldMinIdx].low) goldMinIdx = i;
    for (let i = 1; i < silverSince.length; i++) if (silverSince[i].low < silverSince[silverMinIdx].low) silverMinIdx = i;
    const goldMakingNewLow = goldMinIdx >= goldSince.length / 2;
    const goldLo = goldSince[goldMinIdx].low;
    if (goldMakingNewLow && silverMinIdx < silverSince.length / 2) {
      return {
        detected: true,
        swingPrice: goldLo,
        swingTime: goldSince[goldMinIdx].time,
        reason: `Gold LL @ ${goldLo.toFixed(2)} (bar ${goldMinIdx}/${goldSince.length - 1}), Silver low held @ bar ${silverMinIdx}`,
      };
    }
    return { detected: false, reason: `no divergence` };
  }
  return { detected: false, reason: 'neutral narrative' };
}

/**
 * Find the most recent LTF Inverse FVG (counter-direction FVG that's been violated).
 *   Bearish trinity setup → looking for bullish LTF FVG that has been invalidated (price closed below)
 *   Bullish trinity setup → looking for bearish LTF FVG that has been invalidated
 */
function findRecentIFVG(ltfPane, narrative, sinceTime) {
  const fvgs = findFVGs(ltfPane.bars, 60);
  const wantedSide = narrative === 'bearish' ? 'bullish' : 'bearish';
  // FVG that:
  //   - was on the counter-side (bullish for a bearish setup)
  //   - has been invalidated (a candle closed beyond the opposite edge)
  //   - the FVG itself was created AFTER the tap
  const recent = fvgs.filter((f) =>
    f.side === wantedSide && f.invalidated && f.time >= sinceTime
  );
  if (recent.length === 0) return null;
  // Return the most recent
  return recent[recent.length - 1];
}

export function evaluateTrinity(ctx) {
  const now = ctx.ts / 1000;
  if (!isMarketOpen(now)) return [];
  if (!isInTrinityWindow(now)) return []; // strict 9:30-11:00 EST gate

  // News blackout (Rule #1)
  const black = checkBlackout(now, 30);
  if (black.blocked) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-blackout`,
      status: 'invalidated',
      direction: 'NONE',
      setupName: `${LABEL} · BLOCKED — news ±30min`,
      summary: `Tier-1 news ${black.minutesAway}m away (${black.event?.name}). Trinity Rule #1 — no trade.`,
      confidence: 0,
      details: { 'event': black.event?.name || '?' },
      invalidationLevel: null,
    }];
  }

  const htf = pickHTFPane(ctx);
  if (!htf || htf.bars.length < 50) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-no-htf`,
      status: 'forming',
      direction: 'NONE',
      setupName: `${LABEL} · waiting — no 15m gold pane`,
      summary: 'Trinity needs a 15m gold pane for HTF FVG mapping.',
      confidence: 0,
      details: { 'phase': 'step 1 — no HTF data' },
      invalidationLevel: null,
    }];
  }

  const narr = computeNarrative(ctx);
  if (narr.narrative === 'neutral') {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-no-narrative`,
      status: 'forming',
      direction: 'NONE',
      setupName: `${LABEL} · no narrative — standby`,
      summary: `No clear daily bias (${narr.reason}). Trinity requires a directional narrative.`,
      confidence: 0,
      details: { 'narrative': narr.narrative, 'reason': narr.reason },
      invalidationLevel: null,
    }];
  }

  const direction = narr.narrative === 'bullish' ? 'LONG' : 'SHORT';
  const lastClose = htf.bars[htf.bars.length - 1].close;

  // STEP 1 — find HTF gap aligned with narrative
  const gap = findRelevantHTFGap(htf, narr.narrative, lastClose);
  if (!gap) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${direction}-no-gap`,
      status: 'forming',
      direction,
      setupName: `${LABEL} · ${direction} — no aligned HTF FVG`,
      summary: `${narr.narrative} narrative but no unfilled HTF FVG ${narr.narrative === 'bearish' ? 'above' : 'below'} price.`,
      confidence: 0.15,
      details: { 'narrative': narr.narrative, 'narrative reason': narr.reason },
      invalidationLevel: null,
    }];
  }

  // STEP 1 continued — has price tapped the HTF gap?
  const tap = findHTFGapTap(htf, gap, 12);
  if (!tap) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${direction}-no-tap`,
      status: 'forming',
      direction,
      setupName: `${LABEL} · ${direction} — awaiting tap into HTF FVG`,
      summary: `HTF ${gap.side} FVG at ${gap.bottom.toFixed(2)}-${gap.top.toFixed(2)}. Watching for price to tap.`,
      confidence: 0.3,
      details: {
        'narrative': narr.narrative,
        'HTF FVG': `${gap.bottom.toFixed(2)} - ${gap.top.toFixed(2)} (${gap.side})`,
        'price now': lastClose.toFixed(2),
      },
      invalidationLevel: null,
      geometry: {
        target: { name: 'HTF FVG', level: gap.mid, side: narr.narrative === 'bearish' ? 'BSL' : 'SSL' },
        fvg: { top: gap.top, bottom: gap.bottom, time: gap.time, side: gap.side },
      },
    }];
  }

  // STEP 2 — Gold/Silver SMT divergence after tap
  const silver = pickSilverPane(ctx);
  if (!silver) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${direction}-no-silver`,
      status: 'forming',
      direction,
      setupName: `${LABEL} · ${direction} — HTF tapped, no Silver pane`,
      summary: 'HTF FVG was tapped. Add a Silver pane (XAGUSD/SI1!) to evaluate SMT divergence.',
      confidence: 0.4,
      details: {
        'narrative': narr.narrative,
        'HTF FVG': `${gap.bottom.toFixed(2)} - ${gap.top.toFixed(2)} (${gap.side})`,
        'tap at': fmtNY(tap.time),
      },
      invalidationLevel: null,
      geometry: {
        target: { name: 'HTF FVG', level: gap.mid, side: narr.narrative === 'bearish' ? 'BSL' : 'SSL' },
        fvg: { top: gap.top, bottom: gap.bottom, time: gap.time, side: gap.side },
      },
    }];
  }

  const smt = detectPostTapSMT(htf, silver, tap.time, narr.narrative);
  if (!smt.detected) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${direction}-no-smt`,
      status: 'forming',
      direction,
      setupName: `${LABEL} · ${direction} — HTF tapped, awaiting Gold/Silver SMT`,
      summary: `HTF FVG was tapped @ ${fmtNY(tap.time)}. ${smt.reason}.`,
      confidence: 0.5,
      details: {
        'narrative': narr.narrative,
        'HTF FVG': `${gap.bottom.toFixed(2)} - ${gap.top.toFixed(2)} (${gap.side})`,
        'tap at': fmtNY(tap.time),
        'SMT status': smt.reason,
      },
      invalidationLevel: null,
      geometry: {
        target: { name: 'HTF FVG', level: gap.mid, side: narr.narrative === 'bearish' ? 'BSL' : 'SSL' },
        fvg: { top: gap.top, bottom: gap.bottom, time: gap.time, side: gap.side },
      },
    }];
  }

  // STEP 3 — LTF Inverse FVG
  const ltf = pickLTFPane(ctx);
  if (!ltf || ltf.bars.length < 30) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${direction}-no-ltf`,
      status: 'near_trigger',
      direction,
      setupName: `${LABEL} · ${direction} — SMT confirmed, no LTF pane`,
      summary: `Steps 1-2 done. Add a 1m, 3m, or 5m gold pane to detect the inversion FVG (Step 3).`,
      confidence: 0.65,
      details: {
        'narrative': narr.narrative,
        'HTF FVG': `${gap.bottom.toFixed(2)} - ${gap.top.toFixed(2)}`,
        'tap at': fmtNY(tap.time),
        'SMT': smt.reason,
      },
      invalidationLevel: smt.swingPrice,
      geometry: {
        target: { name: 'HTF FVG', level: gap.mid, side: narr.narrative === 'bearish' ? 'BSL' : 'SSL' },
        fvg: { top: gap.top, bottom: gap.bottom, time: gap.time, side: gap.side },
        mss: { brokenPrice: smt.swingPrice, time: smt.swingTime, ratio: 1.0 },
      },
    }];
  }

  const ifvg = findRecentIFVG(ltf, narr.narrative, smt.swingTime);
  if (!ifvg) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${direction}-awaiting-ifvg`,
      status: 'near_trigger',
      direction,
      setupName: `${LABEL} · ${direction} — SMT confirmed, awaiting LTF IFVG`,
      summary: `All confluences present. Watching ${ltf.resolution}m for counter-direction FVG to flip into IFVG.`,
      confidence: 0.7,
      details: {
        'narrative': narr.narrative,
        'HTF FVG': `${gap.bottom.toFixed(2)} - ${gap.top.toFixed(2)}`,
        'tap at': fmtNY(tap.time),
        'SMT': smt.reason,
        'LTF': `${ltf.resolution}m (${ltf.bars.length} bars)`,
      },
      invalidationLevel: smt.swingPrice,
      geometry: {
        target: { name: 'HTF FVG', level: gap.mid, side: narr.narrative === 'bearish' ? 'BSL' : 'SSL' },
        fvg: { top: gap.top, bottom: gap.bottom, time: gap.time, side: gap.side },
        mss: { brokenPrice: smt.swingPrice, time: smt.swingTime, ratio: 1.0 },
      },
    }];
  }

  // All 3 steps complete — TRIGGERED
  const lastLtf = ltf.bars[ltf.bars.length - 1];
  const entry = lastLtf.close;
  const buffer = Math.max(0.5, 0.1 * (atr(htf.bars, 14) || 5));
  const stop = direction === 'LONG' ? smt.swingPrice - buffer : smt.swingPrice + buffer;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return [];
  const t1 = direction === 'LONG' ? entry + 2 * risk : entry - 2 * risk;
  const t2 = direction === 'LONG' ? entry + 3 * risk : entry - 3 * risk;

  return [{
    strategy: NAME,
    setupId: `${NAME}-${ctx.dateKey}-${direction}-trig`,
    status: 'triggered',
    direction,
    setupName: `${LABEL} · ${direction} TRIGGERED (Trinity Model complete)`,
    summary: `Step 1 HTF FVG ✓ · Step 2 Gold/Silver SMT ✓ · Step 3 LTF Inverse FVG ✓. Entry ${entry.toFixed(2)} · SL ${stop.toFixed(2)} · TP1 ${t1.toFixed(2)} (1:2 RR)`,
    confidence: 0.88,
    details: {
      'narrative': narr.narrative,
      'narrative reason': narr.reason,
      'HTF FVG': `${gap.bottom.toFixed(2)} - ${gap.top.toFixed(2)} (${gap.side})`,
      'HTF tap': fmtNY(tap.time),
      'SMT': smt.reason,
      'SMT swing (SL ref)': smt.swingPrice.toFixed(2),
      'LTF IFVG zone': `${ifvg.bottom.toFixed(2)} - ${ifvg.top.toFixed(2)} (was ${ifvg.side}, now inverse)`,
      'entry': entry.toFixed(2),
      'stop (beyond SMT)': stop.toFixed(2),
      'TP1 (1:2 RR)': t1.toFixed(2),
      'TP2 (1:3 RR)': t2.toFixed(2),
      'discipline': 'Rule #3: stop after 1 win or 2 losses today',
    },
    invalidationLevel: stop,
    entryPlan: { direction, entry, stop, t1, t2, runner: t2, risk },
    geometry: {
      target: { name: 'HTF FVG', level: gap.mid, side: narr.narrative === 'bearish' ? 'BSL' : 'SSL' },
      fvg: { top: gap.top, bottom: gap.bottom, time: gap.time, side: gap.side },
      mss: { brokenPrice: smt.swingPrice, time: smt.swingTime, ratio: 1.0 },
      ob: { top: ifvg.top, bottom: ifvg.bottom, time: ifvg.time, side: ifvg.side === 'bullish' ? 'bearish' : 'bullish' },
      entryPlan: { direction, entry, stop, t1, t2, runner: t2 },
    },
  }];
}
