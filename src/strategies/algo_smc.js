/**
 * Strategy #3 — XAUUSD SMC Algorithmic Blueprint
 *
 * 5-state machine (per XAUUSD_SMC_Algo_Spec.pdf):
 *   State 0: Identify HTF SSL/BSL/Demand-Supply zones
 *   State 1: Liquidity sweep into HTF demand (or supply for shorts)
 *   State 2: SMT divergence confirmation (Gold ↔ Silver inverse-of-positive-correlation)
 *   State 3: BOS in bias direction + volume spike + FVG/IFVG present
 *   State 4: Limit order at 71% fib retracement IF it overlaps the FVG/OB
 *
 * Stateless implementation: each tick re-derives the state from the bars on disk.
 * The strategy is invalidated if:
 *   - Sweep happens but SMT never confirms within time_limit (~4h)
 *   - A bar body-closes below the OB low before fill (bullish), or above OB high (bearish)
 *
 * Fires any weekday hour when all conditions are met.
 */

import { isMarketOpen, fmtNY, nyParts } from '../lib/time.js';
import {
  findSwings,
  detectSweep,
  detectMSS,
  findFVGs,
  orderBlockBefore,
  atr,
  fib71,
  isWithinZone,
  volumeSpike,
} from '../lib/structure.js';
import { evaluateGoldSilverSMT } from '../lib/smt.js';
import { checkBlackout } from '../lib/news.js';

const NAME = 'ALGO-SMC';
const LABEL = 'Strategy #3';
const SWEEP_TIME_LIMIT_SEC = 4 * 60 * 60; // 4h max wait for SMT → BOS chain

function findPaneByTfClass(ctx, kind) {
  const t = (k) => ctx.panesByTf.get(k);
  switch (kind) {
    case 'h4':       return t('gold|240');
    case 'h1':       return t('gold|60');
    case 'm15':      return t('gold|15');
    case 'm5':       return t('gold|5');
    case 'silver_m15': return t('silver|15') || t('silver|5') || t('silver|60');
    case 'silver_m5':  return t('silver|5')  || t('silver|15');
  }
  return null;
}

function pickHTF(ctx) {
  return findPaneByTfClass(ctx, 'h4') || findPaneByTfClass(ctx, 'h1');
}
function pickLTF(ctx) {
  return findPaneByTfClass(ctx, 'm5')
    || findPaneByTfClass(ctx, 'm15')
    || findPaneByTfClass(ctx, 'h1');
}

/**
 * Pick the HTF liquidity pool to sweep, based on which side price is
 * currently positioned. Bullish setup: nearest SSL BELOW current price.
 * Bearish setup: nearest BSL ABOVE.
 */
function pickHtfTarget(htfBars, currentPrice, side) {
  if (!htfBars || htfBars.length < 20) return null;
  const { highs, lows } = findSwings(htfBars, 4);
  if (side === 'SSL') {
    const ssl = lows.filter((l) => l.price < currentPrice).sort((a, b) => b.idx - a.idx);
    return ssl[0] ? { name: 'HTF-SSL', level: ssl[0].price, side: 'SSL', time: ssl[0].time } : null;
  }
  const bsl = highs.filter((h) => h.price > currentPrice).sort((a, b) => b.idx - a.idx);
  return bsl[0] ? { name: 'HTF-BSL', level: bsl[0].price, side: 'BSL', time: bsl[0].time } : null;
}

/** Next opposing HTF liquidity for take-profit. */
function pickHtfTarget_TP(htfBars, currentPrice, direction) {
  if (!htfBars) return null;
  const { highs, lows } = findSwings(htfBars, 4);
  if (direction === 'LONG') {
    const bsl = highs.filter((h) => h.price > currentPrice).sort((a, b) => a.price - b.price);
    return bsl[0] ? bsl[0].price : null;
  }
  const ssl = lows.filter((l) => l.price < currentPrice).sort((a, b) => b.price - a.price);
  return ssl[0] ? ssl[0].price : null;
}

function evaluateOneSide(ctx, direction) {
  // direction: 'LONG' (bullish setup) or 'SHORT' (bearish setup)
  const out = [];
  const htf = pickHTF(ctx);
  const ltf = pickLTF(ctx);
  if (!htf || !htf.bars || htf.bars.length < 30) return out; // no-HTF handled at top level
  if (!ltf || !ltf.bars || ltf.bars.length < 30) return out;

  const htfBars = htf.bars;
  const ltfBars = ltf.bars;
  const last = ltfBars[ltfBars.length - 1];
  const currentPrice = last.close;
  const a14 = atr(ltfBars, 14) || 0;
  const wantedSide = direction === 'LONG' ? 'SSL' : 'BSL';
  const wantedDir  = direction === 'LONG' ? 'bullish' : 'bearish';

  // STATE 0: pick HTF liquidity pool
  const target = pickHtfTarget(htfBars, currentPrice, wantedSide);
  if (!target) return out; // no candidate pool either side

  // STATE 1: did the LTF sweep that HTF level?
  const sweep = detectSweep(ltfBars, target.level, target.side, 24);
  if (!sweep) {
    // State 0 — show approaching liquidity if within range
    const proximityThreshold = Math.max(2 * a14, 15);
    if (a14 > 0 && Math.abs(currentPrice - target.level) < proximityThreshold) {
      out.push({
        strategy: NAME,
        setupId: `${NAME}-${ctx.dateKey}-${direction}-approaching-${target.level.toFixed(0)}`,
        status: 'forming',
        direction,
        setupName: `${LABEL} · approaching ${target.name}`,
        summary: `Price ${currentPrice.toFixed(2)} approaching ${target.name} @ ${target.level.toFixed(2)} — watching for sweep into HTF zone.`,
        confidence: 0.25,
        details: {
          'phase': 'state 0 — HTF zone defined',
          'HTF': htf.resolution + 'm',
          'LTF': ltf.resolution + 'm',
          'HTF target': `${target.name} @ ${target.level.toFixed(2)}`,
          'distance': (currentPrice - target.level).toFixed(2),
        },
        invalidationLevel: null,
        geometry: { target: { name: target.name, level: target.level, side: target.side } },
      });
    }
    return out;
  }

  // sweep_invalidated(time_limit): if sweep is older than 4h and we haven't progressed, reset
  const sweepAgeSec = (ctx.ts / 1000) - sweep.time;
  if (sweepAgeSec > SWEEP_TIME_LIMIT_SEC) {
    return out; // expired — silently skip rather than spamming "invalidated"
  }

  // STATE 2: SMT divergence with Silver
  const silverPane = direction === 'LONG'
    ? findPaneByTfClass(ctx, 'silver_m5') || findPaneByTfClass(ctx, 'silver_m15')
    : findPaneByTfClass(ctx, 'silver_m5') || findPaneByTfClass(ctx, 'silver_m15');
  const sweepKind = direction === 'LONG' ? 'sweep_low' : 'sweep_high';
  const smt = evaluateGoldSilverSMT(ltfBars, silverPane?.bars || [], sweepKind, 20);

  if (!smt.confirmed) {
    out.push({
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${direction}-sweep-no-smt`,
      status: 'forming',
      direction,
      setupName: `${LABEL} · sweep done, awaiting Silver SMT`,
      summary: `${target.name} swept @ ${sweep.wickPrice.toFixed(2)}. SMT: ${smt.reason}.`,
      confidence: 0.4,
      details: {
        'phase': 'state 1 — sweep, no SMT',
        'HTF': htf.resolution + 'm',
        'LTF': ltf.resolution + 'm',
        'sweep wick': sweep.wickPrice.toFixed(2),
        'sweep age': `${Math.round(sweepAgeSec / 60)}m`,
        'Silver SMT': smt.reason,
        'silver pane': silverPane ? `${silverPane.symbol} ${silverPane.resolution}m` : 'MISSING',
      },
      invalidationLevel: sweep.wickPrice,
      geometry: {
        target: { name: target.name, level: target.level, side: target.side },
        sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
      },
    });
    return out;
  }

  // STATE 3: BOS + volume spike + FVG/IFVG present
  const mss = detectMSS(ltfBars, wantedDir, { displacementMult: 1.0, lookback: 15 });
  const vol = volumeSpike(ltfBars, 1.5, 20);
  const volOK = vol === null /* no volume data — accept */ || vol.spike;

  if (!mss) {
    out.push({
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${direction}-smt-no-bos`,
      status: 'forming',
      direction,
      setupName: `${LABEL} · SMT confirmed, awaiting BOS+volume`,
      summary: `SMT bullish (silver diverging). Waiting for ${wantedDir} BOS + volume spike on ${ltf.resolution}m.`,
      confidence: 0.55,
      details: {
        'phase': 'state 2 — SMT confirmed',
        'sweep wick': sweep.wickPrice.toFixed(2),
        'Silver SMT': smt.reason,
        'volume': vol === null ? 'unavailable' : `${vol.ratio.toFixed(2)}× avg`,
      },
      invalidationLevel: sweep.wickPrice,
      geometry: {
        target: { name: target.name, level: target.level, side: target.side },
        sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
      },
    });
    return out;
  }

  // FVG / IFVG / OB
  const fvgs = findFVGs(ltfBars, 40).filter((f) => f.side === wantedDir && !f.invalidated);
  const freshFvgs = fvgs.filter((f) => f.idx >= mss.idx - 1 && f.idx <= mss.idx + 1);
  const fvg = freshFvgs[freshFvgs.length - 1] || null;
  const ob = orderBlockBefore(ltfBars, mss.idx, wantedDir);

  if (!fvg && !ob) {
    out.push({
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${direction}-bos-no-imbalance`,
      status: 'near_trigger',
      direction,
      setupName: `${LABEL} · BOS confirmed, no imbalance — skip`,
      summary: `Displacement happened but no FVG/IFVG/OB available. State 3 incomplete.`,
      confidence: 0.55,
      details: {
        'phase': 'state 3 — displacement, no imbalance',
        'MSS x ATR': mss.ratio.toFixed(2),
        'volume': vol === null ? 'unavailable' : `${vol.ratio.toFixed(2)}× avg`,
      },
      invalidationLevel: sweep.wickPrice,
      geometry: {
        target: { name: target.name, level: target.level, side: target.side },
        sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
        mss: { brokenPrice: mss.brokenSwing.price, time: mss.time, ratio: mss.ratio },
      },
    });
    return out;
  }

  if (!volOK) {
    out.push({
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${direction}-bos-low-volume`,
      status: 'near_trigger',
      direction,
      setupName: `${LABEL} · BOS w/o volume spike — degraded`,
      summary: `Displacement happened but volume ${vol.ratio.toFixed(2)}× (needs ≥1.5×). Spec requires institutional volume confirmation.`,
      confidence: 0.55,
      details: {
        'phase': 'state 3 — low volume',
        'MSS x ATR': mss.ratio.toFixed(2),
        'volume ratio': vol.ratio.toFixed(2) + '×',
      },
      invalidationLevel: sweep.wickPrice,
      geometry: {
        target: { name: target.name, level: target.level, side: target.side },
        sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
        mss: { brokenPrice: mss.brokenSwing.price, time: mss.time, ratio: mss.ratio },
      },
    });
    return out;
  }

  // STATE 4: compute 71% fib of displacement leg (sweep → MSS extreme)
  const mssBar = ltfBars[mss.idx];
  const legLow = direction === 'LONG' ? sweep.wickPrice : Math.min(mssBar.low, mssBar.high);
  const legHigh = direction === 'LONG' ? Math.max(mssBar.low, mssBar.high) : sweep.wickPrice;
  const fib = fib71(legLow, legHigh, wantedDir);

  // Confluence: 71% fib must overlap or be near (±10% of leg range) the FVG/OB
  const legRange = Math.abs(legHigh - legLow);
  const tolerance = Math.max(legRange * 0.10, 0.5);
  let imbalanceTop, imbalanceBottom, imbalanceLabel;
  if (fvg) {
    imbalanceTop = fvg.top; imbalanceBottom = fvg.bottom; imbalanceLabel = 'FVG';
  } else {
    imbalanceTop = ob.body.top; imbalanceBottom = ob.body.bottom; imbalanceLabel = 'OB';
  }
  const inside = isWithinZone(fib, imbalanceTop, imbalanceBottom);
  const near = Math.abs(fib - imbalanceTop) <= tolerance || Math.abs(fib - imbalanceBottom) <= tolerance;
  if (!inside && !near) {
    out.push({
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${direction}-fib-no-confluence`,
      status: 'near_trigger',
      direction,
      setupName: `${LABEL} · 71% Fib outside ${imbalanceLabel} — confluence missing`,
      summary: `71% fib @ ${fib.toFixed(2)} doesn't overlap ${imbalanceLabel} ${imbalanceBottom.toFixed(2)}-${imbalanceTop.toFixed(2)}. Spec requires confluence.`,
      confidence: 0.6,
      details: {
        'phase': 'state 4 — fib confluence missing',
        '71% Fib': fib.toFixed(2),
        [`${imbalanceLabel}`]: `${imbalanceBottom.toFixed(2)} - ${imbalanceTop.toFixed(2)}`,
      },
      invalidationLevel: sweep.wickPrice,
      geometry: {
        target: { name: target.name, level: target.level, side: target.side },
        sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
        mss: { brokenPrice: mss.brokenSwing.price, time: mss.time, ratio: mss.ratio },
        fvg: fvg ? { top: fvg.top, bottom: fvg.bottom, time: fvg.time, side: fvg.side } : null,
        ob: !fvg && ob ? { top: ob.body.top, bottom: ob.body.bottom, time: ob.time, side: ob.side } : null,
        fib71: fib,
      },
    });
    return out;
  }

  // STATE 4 — full trigger: place limit at 71% fib, stop at OB.low/high, target HTF BSL/SSL
  const obLow = ob ? ob.low : (fvg ? fvg.bottom : sweep.wickPrice);
  const obHigh = ob ? ob.high : (fvg ? fvg.top : sweep.wickPrice);
  const buffer = Math.max(0.5, 0.1 * a14);
  const stop = direction === 'LONG' ? obLow - buffer : obHigh + buffer;
  const risk = Math.abs(fib - stop);
  const tp = pickHtfTarget_TP(htfBars, currentPrice, direction) || (direction === 'LONG' ? fib + 3 * risk : fib - 3 * risk);
  const tp1 = direction === 'LONG' ? fib + risk : fib - risk; // 1R partial / BE move
  const tp2 = direction === 'LONG' ? fib + 2 * risk : fib - 2 * risk; // 50% scale per spec
  const news = checkBlackout(ctx.ts / 1000, 30);
  if (news.blocked) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${direction}-blackout`,
      status: 'invalidated',
      direction,
      setupName: `${LABEL} · BLOCKED — news ±30min`,
      summary: `Tier-1 news ${news.minutesAway}m away (${news.event?.name}). No trade.`,
      confidence: 0,
      details: { 'event': news.event?.name || '?' },
      invalidationLevel: stop,
    }];
  }

  let confidence = 0.85;
  if (vol && vol.ratio >= 2) confidence += 0.04;
  if (inside) confidence += 0.04;
  if (mss.ratio >= 1.5) confidence += 0.03;
  confidence = Math.min(0.97, confidence);

  out.push({
    strategy: NAME,
    setupId: `${NAME}-${ctx.dateKey}-${direction}-trig`,
    status: 'triggered',
    direction,
    setupName: `${LABEL} · TRIGGERED (71% Fib + ${imbalanceLabel})`,
    summary: `Full 5-state setup. Limit ${fib.toFixed(2)} · Stop ${stop.toFixed(2)} · TP1 ${tp1.toFixed(2)} · TP2 ${tp2.toFixed(2)} · Runner ${tp.toFixed(2)}`,
    confidence,
    details: {
      'phase': 'state 4 — armed',
      'HTF': htf.resolution + 'm',
      'LTF': ltf.resolution + 'm',
      'HTF target': `${target.name} @ ${target.level.toFixed(2)}`,
      'sweep wick': sweep.wickPrice.toFixed(2),
      'Silver SMT': smt.reason,
      'MSS x ATR': mss.ratio.toFixed(2),
      'volume': vol === null ? 'unavailable' : `${vol.ratio.toFixed(2)}× avg`,
      'imbalance': `${imbalanceLabel} ${imbalanceBottom.toFixed(2)}-${imbalanceTop.toFixed(2)}`,
      '71% Fib': fib.toFixed(2) + (inside ? ' ✓ inside' : ' ~near'),
      'entry': `Limit @ ${fib.toFixed(2)}`,
      'stop': `${stop.toFixed(2)} (${risk.toFixed(2)} risk)`,
      'TP1 (50%, BE-trail)': `${tp1.toFixed(2)} (1R)`,
      'TP2 (50%, scale)': `${tp2.toFixed(2)} (2R)`,
      'Runner (HTF BSL)': tp.toFixed(2),
    },
    invalidationLevel: stop,
    entryPlan: { direction, entry: fib, stop, t1: tp1, t2: tp2, runner: tp, risk },
    geometry: {
      target: { name: target.name, level: target.level, side: target.side },
      sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
      mss: { brokenPrice: mss.brokenSwing.price, time: mss.time, ratio: mss.ratio },
      fvg: fvg ? { top: fvg.top, bottom: fvg.bottom, time: fvg.time, side: fvg.side } : null,
      ob: !fvg && ob ? { top: ob.body.top, bottom: ob.body.bottom, time: ob.time, side: ob.side } : null,
      fib71: fib,
      entryPlan: { direction, entry: fib, stop, t1: tp1, t2: tp2, runner: tp },
    },
  });

  return out;
}

export function evaluateAlgoSMC(ctx) {
  // Gold-only: spec depends on Gold/Silver SMT divergence.
  if (ctx.instrument !== 'gold') return [];
  const now = ctx.ts / 1000;
  if (!isMarketOpen(now)) return [];

  // Single "no HTF" alert if user hasn't added the required panes.
  const htf = pickHTF(ctx);
  const ltf = pickLTF(ctx);
  if (!htf || !htf.bars || htf.bars.length < 30) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-no-htf`,
      status: 'forming',
      direction: 'NONE',
      setupName: `${LABEL} · waiting — no 1H/4H gold pane`,
      summary: 'Add a 1H or 4H gold pane to enable Strategy #3 HTF sweep mapping.',
      confidence: 0,
      details: { 'phase': 'state 0 — no HTF data' },
      invalidationLevel: null,
    }];
  }
  if (!ltf || !ltf.bars || ltf.bars.length < 30) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-no-ltf`,
      status: 'forming',
      direction: 'NONE',
      setupName: `${LABEL} · waiting — no 5m/15m gold pane`,
      summary: 'Add a 5m or 15m gold pane for execution-TF sweep + MSS detection.',
      confidence: 0,
      details: { 'phase': 'state 0 — no LTF data' },
      invalidationLevel: null,
    }];
  }

  const out = [];
  out.push(...evaluateOneSide(ctx, 'LONG'));
  out.push(...evaluateOneSide(ctx, 'SHORT'));
  return out;
}
