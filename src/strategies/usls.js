/**
 * Strategy 1 — Universal Session Liquidity Sweep (USLS)
 *
 * Pipeline (per Lucid_Flex_50k spec):
 *   1. Define previous session high/low as BSL/SSL on 15m chart
 *   2. Wait for liquidity raid: 15m/5m wick past level + close back inside
 *   3. Drop to 5m/1m: displacement candle creates MSS + FVG opposite to sweep
 *   4. Limit entry at FVG opening, SL 1.5-2 pips beyond sweep wick
 *
 * Returns a list of active setup states for the orchestrator to alert on.
 */

import { activeSession, fmtNY, nyParts, isMarketOpen } from '../lib/time.js';
import { buildSessionRanges, liquidityTargetsFor, lastCompletedRange } from '../lib/sessions.js';
import { detectSweep, detectMSS, findFVGs, orderBlockBefore, atr } from '../lib/structure.js';

// Display label is "Strategy #1" in alerts; internal id stays 'USLS' for stable setupIds.
const NAME = 'USLS';
const LABEL = 'Strategy #1';

function pickExecutionPane(ctx) {
  // Prefer 5m > 1m > 15m. 15m is fallback if user has only one pane.
  const tf5 = ctx.pane('5');
  const tf1 = ctx.pane('1');
  const tf15 = ctx.pane('15');
  return tf5 || tf1 || tf15;
}

function pickAnalysisPane(ctx) {
  // 15m is the canonical analysis TF for sessions per the spec.
  return ctx.pane('15') || pickExecutionPane(ctx);
}

/**
 * Evaluate the USLS strategy against the current market state.
 * @returns {Array} array of setups (could be 0, 1, or 2). Each is a detector result.
 */
export function evaluateUSLS(ctx) {
  const results = [];
  const analysis = pickAnalysisPane(ctx);
  const execution = pickExecutionPane(ctx);
  if (!analysis || !analysis.bars || analysis.bars.length < 50) return results;

  const now = ctx.ts / 1000;
  // Weekend skip — gold isn't trading. Otherwise fire any time of day.
  if (!isMarketOpen(now)) return results;

  const session = activeSession(now);
  const ranges = buildSessionRanges(analysis.bars, now);
  // liquidityTargetsFor handles 'off'/'lunch' by returning all recent ranges.
  const targets = liquidityTargetsFor(ranges, session);
  if (targets.length === 0) return results;

  const lastBar = analysis.bars[analysis.bars.length - 1];
  const close = lastBar.close;
  const a14 = atr(analysis.bars, 14) || 0;

  for (const target of targets) {
    // Detect sweep on the analysis TF (15m).
    const sweep = detectSweep(analysis.bars, target.level, target.side, 6);
    if (!sweep) {
      // No sweep yet — emit a "forming" alert when price is approaching the level.
      // Use max(2×ATR, $15) so gold's typical session range still triggers heads-up.
      const proximityThreshold = Math.max(2 * a14, 15);
      if (a14 > 0 && Math.abs(close - target.level) < proximityThreshold) {
        results.push(buildForming({ ctx, session, target, close, atr: a14 }));
      }
      continue;
    }

    // Sweep occurred. Setup is at least "forming".
    const sweepDir = target.side === 'BSL' ? 'bullish_reversal' : 'bearish_reversal';
    const wantedMssDir = target.side === 'BSL' ? 'bearish' : 'bullish';

    // Look for MSS on execution TF post-sweep.
    const execBars = execution && execution.bars ? execution.bars : analysis.bars;
    const mss = detectMSS(execBars, wantedMssDir, { displacementMult: 1.0, lookback: 15 });

    if (!mss) {
      results.push(
        buildPostSweepNoMSS({ ctx, session, target, sweep, close, wantedMssDir, atr: a14, execTf: execution?.resolution || analysis.resolution })
      );
      continue;
    }

    // We have a sweep + MSS. Look for FVG/IFVG near the MSS
    const fvgs = findFVGs(execBars, 40).filter((f) => f.side === wantedMssDir && !f.invalidated);
    const freshFvgs = fvgs.filter((f) => f.idx >= mss.idx - 1 && f.idx <= mss.idx + 1);
    const fvg = freshFvgs[freshFvgs.length - 1] || null;
    const ob = orderBlockBefore(execBars, mss.idx, wantedMssDir);

    if (!fvg && !ob) {
      results.push(buildMssNoEntry({ ctx, session, target, sweep, mss, close, atr: a14, execTf: execution?.resolution || analysis.resolution }));
      continue;
    }

    // Full setup confirmed
    results.push(
      buildTriggered({ ctx, session, target, sweep, mss, fvg, ob, close, atr: a14, execBars, execTf: execution?.resolution || analysis.resolution })
    );
  }

  return results;
}

// ---------- alert builders ----------

function buildForming({ ctx, session, target, close, atr }) {
  const direction = target.side === 'BSL' ? 'SHORT' : 'LONG';
  return {
    strategy: NAME,
    setupId: `${NAME}-${session}-${target.fromSession}-${target.fromDate}-${target.side}-near`,
    status: 'forming',
    direction,
    setupName: `${LABEL} · ${session.toUpperCase()} · approaching ${target.name}`,
    summary: `Price ${(close).toFixed(2)} approaching ${target.name} @ ${target.level.toFixed(2)} — watching for sweep.`,
    confidence: 0.25,
    details: {
      session,
      'target pool': `${target.name} @ ${target.level.toFixed(2)} (${target.side})`,
      'distance': `${(close - target.level).toFixed(2)}`,
      'ATR(14)': atr.toFixed(2),
      'phase': 'approaching liquidity (step 1 of 4)',
    },
    invalidationLevel: null,
    geometry: { target: { name: target.name, level: target.level, side: target.side } },
  };
}

function buildPostSweepNoMSS({ ctx, session, target, sweep, close, wantedMssDir, atr, execTf }) {
  const direction = wantedMssDir === 'bullish' ? 'LONG' : 'SHORT';
  return {
    strategy: NAME,
    setupId: `${NAME}-${session}-${target.fromSession}-${target.fromDate}-${target.side}-swept`,
    status: 'forming',
    direction,
    setupName: `${LABEL} · ${session.toUpperCase()} · sweep complete, awaiting MSS`,
    summary: `${target.name} swept @ ${sweep.wickPrice.toFixed(2)}. Waiting for ${direction} MSS on ${execTf}m.`,
    confidence: 0.45,
    details: {
      session,
      'sweep level': `${target.name} @ ${target.level.toFixed(2)}`,
      'wick price': sweep.wickPrice.toFixed(2),
      'close back': sweep.closePrice.toFixed(2),
      'magnitude': sweep.magnitude.toFixed(2),
      'ATR(14)': atr.toFixed(2),
      'phase': 'sweep done, awaiting MSS (step 2/4 complete)',
      'execution TF': `${execTf}m`,
    },
    invalidationLevel: target.side === 'BSL' ? sweep.wickPrice : sweep.wickPrice,
    geometry: {
      target: { name: target.name, level: target.level, side: target.side },
      sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
    },
  };
}

function buildMssNoEntry({ ctx, session, target, sweep, mss, close, atr, execTf }) {
  const direction = mss.side === 'bullish' ? 'LONG' : 'SHORT';
  return {
    strategy: NAME,
    setupId: `${NAME}-${session}-${target.fromSession}-${target.fromDate}-${target.side}-mss`,
    status: 'near_trigger',
    direction,
    setupName: `${LABEL} · ${session.toUpperCase()} · MSS confirmed, awaiting entry`,
    summary: `MSS confirmed on ${execTf}m (${mss.ratio.toFixed(1)}× ATR). No fresh FVG/OB — wait for retrace or skip.`,
    confidence: 0.55,
    details: {
      session,
      'swept pool': `${target.name} @ ${target.level.toFixed(2)}`,
      'sweep wick': sweep.wickPrice.toFixed(2),
      'MSS at': fmtNY(mss.time),
      'MSS displacement': `${mss.displacement.toFixed(2)} (${mss.ratio.toFixed(2)}× ATR)`,
      'broken swing': mss.brokenSwing.price.toFixed(2),
      'phase': 'MSS done, no entry array (step 3/4)',
      'execution TF': `${execTf}m`,
    },
    invalidationLevel: sweep.wickPrice,
    geometry: {
      target: { name: target.name, level: target.level, side: target.side },
      sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
      mss: { brokenPrice: mss.brokenSwing.price, time: mss.time, ratio: mss.ratio },
    },
  };
}

function buildTriggered({ ctx, session, target, sweep, mss, fvg, ob, close, atr, execBars, execTf }) {
  const direction = mss.side === 'bullish' ? 'LONG' : 'SHORT';
  // Entry preference: FVG mid (50% / consequent encroachment), else OB body top
  let entry, entryDesc;
  if (fvg) {
    entry = fvg.mid;
    entryDesc = `FVG 50% @ ${fvg.mid.toFixed(2)} (zone ${fvg.bottom.toFixed(2)}-${fvg.top.toFixed(2)})`;
  } else {
    entry = direction === 'LONG' ? ob.body.top : ob.body.bottom;
    entryDesc = `OB ${direction === 'LONG' ? 'top' : 'bottom'} @ ${entry.toFixed(2)}`;
  }

  // Stop: spec says "1.5-2 pips beyond swing wick"; on gold that's essentially zero.
  // We use a small ATR-relative buffer. Tuning didn't help on small samples — keep spec-faithful.
  const buffer = Math.max(0.1 * atr, 0.5);
  const stop = direction === 'LONG' ? sweep.wickPrice - buffer : sweep.wickPrice + buffer;

  // Target: opposite session's liquidity (per the table). For simplicity, target the opposing range bound from the same session pair.
  // Use 1R, 2R partial structure; final target = opposite-side previous session level if known.
  const risk = Math.abs(entry - stop);
  const t1 = direction === 'LONG' ? entry + 1.0 * risk : entry - 1.0 * risk;
  const t2 = direction === 'LONG' ? entry + 2.0 * risk : entry - 2.0 * risk;

  const confidence = 0.7 + (fvg ? 0.1 : 0) + (mss.ratio >= 1.5 ? 0.05 : 0);

  return {
    strategy: NAME,
    setupId: `${NAME}-${session}-${target.fromSession}-${target.fromDate}-${target.side}-trig`,
    status: 'triggered',
    direction,
    setupName: `${LABEL} · ${session.toUpperCase()} · TRIGGERED`,
    summary: `Full setup confirmed. Limit ${entry.toFixed(2)} · Stop ${stop.toFixed(2)} · TP1 ${t1.toFixed(2)} · TP2 ${t2.toFixed(2)} (1:2 R)`,
    confidence: Math.min(0.95, confidence),
    details: {
      session,
      'swept pool': `${target.name} @ ${target.level.toFixed(2)}`,
      'sweep wick': sweep.wickPrice.toFixed(2),
      'MSS at': fmtNY(mss.time),
      'MSS displacement': `${mss.ratio.toFixed(2)}× ATR`,
      'entry': entryDesc,
      'entry price': entry.toFixed(2),
      'stop': `${stop.toFixed(2)} (${risk.toFixed(2)} risk)`,
      'TP1 (50%, BE-trail)': `${t1.toFixed(2)} (1R)`,
      'TP2 (terminal)': `${t2.toFixed(2)} (2R)`,
      'execution TF': `${execTf}m`,
    },
    invalidationLevel: stop,
    entryPlan: { direction, entry, stop, t1, t2, risk },
    geometry: {
      target: { name: target.name, level: target.level, side: target.side },
      sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
      mss: { brokenPrice: mss.brokenSwing.price, time: mss.time, ratio: mss.ratio },
      fvg: fvg ? { top: fvg.top, bottom: fvg.bottom, time: fvg.time, side: fvg.side } : null,
      ob: !fvg && ob ? { top: ob.body.top, bottom: ob.body.bottom, time: ob.time, side: ob.side } : null,
      entryPlan: { direction, entry, stop, t1, t2 },
    },
  };
}
