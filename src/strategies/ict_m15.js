/**
 * Strategy #5 — ICT M15 Liquidity Sweep & Structural Shift
 *
 * Per ICT.pdf: single-asset M15 state machine, killzone-gated.
 *
 *   STATE 0 IDLE → 1 MONITOR_SWEEP (when London or NY KZ opens)
 *   STATE 1 → 2 VERIFY_SWEEP (when Low < SSL for long, or High > BSL for short)
 *   STATE 2 → 3 DETECT_FVG (when MSS triggers via body close past local swing)
 *   STATE 3 → 4 LIMIT_ORDER_ACTIVE (when valid 3-candle FVG forms within 3 bars after MSS)
 *   STATE 4 → 5 POSITION_MGMT (when price touches FVG entry boundary)
 *
 *   Long entry: C1.High of FVG
 *   Short entry: C1.Low of FVG
 *   Long SL: sweep_low - 2 pips (~$0.20 on gold)
 *   Short SL: sweep_high + 2 pips
 *   TP1: 1:2 RR
 *   TP2: opposite Asian-range pool (BSL for longs, SSL for shorts)
 *
 *   ONLY operates during London KZ (02:00-05:00 EST) or NY KZ (07:00-10:00 EST).
 *   Outside killzones: nothing fires.
 *
 *   Asian Range: 20:00 - 00:00 EST. Fallback to PDH/PDL if Asian range missing.
 */

import { isMarketOpen, fmtNY } from '../lib/time.js';
import {
  activeKillZone, isInLondonKZ, isInNYKZ,
  asianRangeHighLow, previousDayHighLow,
} from '../lib/ict_session.js';
import {
  detectSweep, detectMSS, findFVGs, atr,
} from '../lib/structure.js';

const NAME = 'ICT';
const LABEL = 'Strategy #5';
const PIP = 0.10; // gold "pip" interpreted as $0.10 (10 ticks); spec says 2 pips / 8 ticks

function findGoldM15(ctx) {
  return ctx.pane('15');
}

function buildSetup(ctx, m15, kz, target, sweep, mss, fvg, direction) {
  const wantedSide = direction === 'LONG' ? 'SSL' : 'BSL';
  const bars = m15.bars;
  const a14 = atr(bars, 14) || 0;
  const lastClose = bars[bars.length - 1].close;

  // Entry per spec: C1.High for longs, C1.Low for shorts
  const c1 = bars[fvg.idx - 1];
  const entry = direction === 'LONG' ? c1.high : c1.low;
  const buffer = 2 * PIP; // 2 pips
  const stop = direction === 'LONG' ? sweep.wickPrice - buffer : sweep.wickPrice + buffer;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;

  // TP1 1:2 RR, TP2 = opposite Asian pool
  const t1 = direction === 'LONG' ? entry + 2 * risk : entry - 2 * risk;
  const t2 = direction === 'LONG' ? target.opposite : target.opposite; // opposite-pool value
  const runner = t2;

  return {
    strategy: NAME,
    setupId: `${NAME}-${ctx.dateKey}-${kz}-${direction}-${target.side}-trig`,
    status: 'triggered',
    direction,
    setupName: `${LABEL} · ${kz.toUpperCase()} ${direction} TRIGGERED`,
    summary: `Sweep of ${target.label} → MSS → FVG. Limit ${entry.toFixed(2)} · SL ${stop.toFixed(2)} · TP1 ${t1.toFixed(2)} · TP2 ${t2.toFixed(2)}`,
    confidence: 0.78 + (mss.ratio >= 1.5 ? 0.05 : 0) + (kz === 'ny' ? 0.02 : 0),
    details: {
      'killzone': kz,
      'liquidity pool': `${target.label} @ ${target.level.toFixed(2)} (${target.side})`,
      'sweep wick': sweep.wickPrice.toFixed(2),
      'MSS at': fmtNY(mss.time),
      'MSS x ATR': mss.ratio.toFixed(2),
      'FVG': `${fvg.bottom.toFixed(2)} - ${fvg.top.toFixed(2)}`,
      'entry (C1 edge)': entry.toFixed(2),
      'stop (sweep ±2pip)': stop.toFixed(2),
      'TP1 (1:2 RR)': t1.toFixed(2),
      'TP2 (opposite pool)': t2.toFixed(2),
    },
    invalidationLevel: stop,
    entryPlan: { direction, entry, stop, t1, t2, runner, risk },
    geometry: {
      target: { name: target.label, level: target.level, side: target.side },
      sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
      mss: { brokenPrice: mss.brokenSwing.price, time: mss.time, ratio: mss.ratio },
      fvg: { top: fvg.top, bottom: fvg.bottom, time: fvg.time, side: fvg.side },
      entryPlan: { direction, entry, stop, t1, t2, runner },
    },
  };
}

function evalDirection(ctx, m15, kz, target, oppositeLevel, direction) {
  const bars = m15.bars;
  const wantedSide = direction === 'LONG' ? 'SSL' : 'BSL';
  const wantedMssDir = direction === 'LONG' ? 'bullish' : 'bearish';

  // Sweep detection within last 12 M15 bars (3 hours)
  const sweep = detectSweep(bars, target.level, wantedSide, 12);
  if (!sweep) {
    // Approaching alert if price within 0.5×ATR of level
    const a14 = atr(bars, 14) || 0;
    const lastClose = bars[bars.length - 1].close;
    if (a14 > 0 && Math.abs(lastClose - target.level) < 0.5 * a14) {
      return {
        strategy: NAME,
        setupId: `${NAME}-${ctx.dateKey}-${kz}-${direction}-approaching-${target.side}`,
        status: 'forming',
        direction,
        setupName: `${LABEL} · ${kz.toUpperCase()} ${direction} — approaching ${target.label}`,
        summary: `Price ${lastClose.toFixed(2)} approaching ${target.label} @ ${target.level.toFixed(2)}. Awaiting sweep.`,
        confidence: 0.25,
        details: {
          'killzone': kz,
          'liquidity pool': `${target.label} @ ${target.level.toFixed(2)}`,
          'distance': (lastClose - target.level).toFixed(2),
        },
        invalidationLevel: null,
        geometry: { target: { name: target.label, level: target.level, side: target.side } },
      };
    }
    return null;
  }

  // MSS check post-sweep
  const mss = detectMSS(bars, wantedMssDir, { displacementMult: 1.0, lookback: 12 });
  if (!mss || mss.idx <= sweep.idx) {
    return {
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${kz}-${direction}-${target.side}-swept`,
      status: 'forming',
      direction,
      setupName: `${LABEL} · ${kz.toUpperCase()} ${direction} — sweep complete, awaiting MSS`,
      summary: `${target.label} swept @ ${sweep.wickPrice.toFixed(2)}. Waiting for ${direction} body-close MSS.`,
      confidence: 0.5,
      details: {
        'killzone': kz,
        'liquidity pool': `${target.label} @ ${target.level.toFixed(2)}`,
        'sweep wick': sweep.wickPrice.toFixed(2),
      },
      invalidationLevel: sweep.wickPrice,
      geometry: {
        target: { name: target.label, level: target.level, side: target.side },
        sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
      },
    };
  }

  // FVG within 3 trailing candles of the MSS event
  const allFvgs = findFVGs(bars, 20).filter((f) => f.side === wantedMssDir && !f.invalidated);
  const fvg = allFvgs.find((f) => f.idx >= mss.idx - 1 && f.idx <= mss.idx + 3);

  if (!fvg) {
    return {
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${kz}-${direction}-${target.side}-mss`,
      status: 'near_trigger',
      direction,
      setupName: `${LABEL} · ${kz.toUpperCase()} ${direction} — MSS confirmed, awaiting FVG`,
      summary: `MSS confirmed (${mss.ratio.toFixed(1)}× ATR). No valid FVG within 3 trailing candles yet — per spec, resets if no FVG appears soon.`,
      confidence: 0.6,
      details: {
        'killzone': kz,
        'sweep wick': sweep.wickPrice.toFixed(2),
        'MSS x ATR': mss.ratio.toFixed(2),
        'broken swing': mss.brokenSwing.price.toFixed(2),
      },
      invalidationLevel: sweep.wickPrice,
      geometry: {
        target: { name: target.label, level: target.level, side: target.side },
        sweep: { wickPrice: sweep.wickPrice, time: sweep.time },
        mss: { brokenPrice: mss.brokenSwing.price, time: mss.time, ratio: mss.ratio },
      },
    };
  }

  // Full trigger
  const targetWithOpp = { ...target, opposite: oppositeLevel };
  return buildSetup(ctx, m15, kz, targetWithOpp, sweep, mss, fvg, direction);
}

export function evaluateICTM15(ctx) {
  const now = ctx.ts / 1000;
  if (!isMarketOpen(now)) return [];
  const kz = activeKillZone(now);
  if (!kz) return []; // strict killzone gating per spec

  const m15 = findGoldM15(ctx);
  if (!m15 || !m15.bars || m15.bars.length < 50) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-no-m15`,
      status: 'forming',
      direction: 'NONE',
      setupName: `${LABEL} · waiting — no 15m gold pane`,
      summary: 'Strategy #5 requires a 15m gold pane (GC1!, MGC1!, XAUUSD).',
      confidence: 0,
      details: { 'phase': 'state 0 — no M15 data' },
      invalidationLevel: null,
    }];
  }

  // Compute liquidity pools: Asian range OR PDH/PDL fallback
  let pools = asianRangeHighLow(m15.bars, now);
  let poolLabel = 'Asian';
  if (!pools) {
    pools = previousDayHighLow(m15.bars, now);
    poolLabel = 'PDH/PDL';
  }
  if (!pools) {
    return [{
      strategy: NAME,
      setupId: `${NAME}-${ctx.dateKey}-${kz}-no-pools`,
      status: 'forming',
      direction: 'NONE',
      setupName: `${LABEL} · ${kz.toUpperCase()} — no Asian range / PDH-PDL resolvable`,
      summary: 'Bar history does not cover the prior Asian session window. Backfill required.',
      confidence: 0,
      details: { 'killzone': kz },
      invalidationLevel: null,
    }];
  }

  const out = [];
  const bslTarget = { label: `${poolLabel} BSL`, level: pools.high, side: 'BSL' };
  const sslTarget = { label: `${poolLabel} SSL`, level: pools.low, side: 'SSL' };

  const longResult = evalDirection(ctx, m15, kz, sslTarget, pools.high, 'LONG');
  if (longResult) out.push(longResult);

  const shortResult = evalDirection(ctx, m15, kz, bslTarget, pools.low, 'SHORT');
  if (shortResult) out.push(shortResult);

  return out;
}
