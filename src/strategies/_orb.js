/**
 * Shared ORB (Opening Range Breakout) engine — clean-room port of the
 * N4A_ORB_Clone_v0.2 Pine engine that the PLAYBIT "Pure Hunt / Safe Flow /
 * Akimbo" strategies all run on (MNQ1! 5-min chart). The opening range is the
 * first 15 minutes of the NY RTH cash open (09:30–09:45 ET) measured on the
 * 5-minute pane (three 5m bars).
 *
 * Three entry styles, matching the Pine engine 1:1 on signal generation
 * (trigger bar, direction, entry price, stop, primary target):
 *
 *   HUNTER (Classic/Hunter) — Pine ll.225-257
 *     LONG  = ta.crossover(close, orbH); SHORT = ta.crossunder(close, orbL).
 *     entry = breakout close · stop = opposite ORB edge (buf 0) · target = 2R
 *     (hptT2). Partial 50% @ 0.7R (hptTrg). BE off.
 *
 *   CONSERVATIVE (Classic/Conservative) — Pine ll.269-297
 *     Arm on the breakout crossover; entry on a RETEST of the broken edge
 *     (low<=orbH long) within consMaxBars=5 of the arm. entry = orbH · stop =
 *     orbL · target = SD1.0 = orbH + orbRange (100% exit). No partial/BE.
 *
 *   FVG (Revised) — Pine ll.302-370
 *     A post-breakout 3-candle FVG sitting at/above orbH (or at/below orbL),
 *     strict min size 2.0 pt; enter on the retrace into the gap top/bottom
 *     within fvgBarsAfter=15 bars. stop = far gap edge ∓ 1.0 buffer · target 2R.
 *
 * PLATFORM NOTE (honest, irreducible): Octave manages an open trade with the
 * active risk MODE (e.g. QUALITY = bank 50% @ TP1, trail the runner), whereas
 * the Pine engine uses each strategy's fixed partial/BE/T2 config. The SIGNAL
 * (which bar, direction, entry, stop, primary target) is reproduced exactly;
 * the post-entry MANAGEMENT follows the Octave mode. Likewise Octave fires once
 * per direction per day (setupId dedup) rather than Pine's cooldown/re-entry.
 */

import { nyParts, nyDayStartUnix } from '../lib/time.js';
import { atr, findFVGs } from '../lib/structure.js';
import { buildTriggered, dayScopedId, qualityConfidence, projectTrade } from './_helpers.js';

export const RTH_OPEN_MIN = 9 * 60 + 30;   // 09:30 ET
export const ORB_END_MIN  = 9 * 60 + 45;   // 09:45 ET (opening range closes)
const CONS_MAX_BARS = 5;                    // consMaxBars — retest must come ≤5 bars after the arm
const FVG_BARS_AFTER = 15;                  // fvgBarsAfter — FVG is live for 15 bars
const FVG_MIN_SIZE = 2.0;                   // fvgMinSize (Strict)
const FVG_BUFFER = 1.0;                     // Revised safety buffer (pts)

const c01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// N4ADigital ORB management is FIXED-target: 50% partial at the trigger R, the
// rest to a fixed T2 — explicitly NOT trailed ("Don't add Break-Even, Trail
// Stop... they hurt this configuration" — N4A.ORB v27.4 cookbook). The Octave
// QUALITY mode otherwise forces a trailing runner on every signal, which a
// 185d Databento walk confirms HURTS the breakout legs (Pure Hunt +12R→+3R,
// Akimbo +12R→+3R, max-DD 4.7R→11.5R). So every ORB signal opts OUT of the mode
// trail and keeps the validated fixed 0.7R/50% + 2R (Hunter) / SD1.0 (Cons) /
// 1R/50% + 2R (FVG) profile that follow_up's non-trailing path applies.
function orbTriggered(args) {
  const r = buildTriggered(args);
  if (r?.entryPlan) r.entryPlan.trail = null;
  return r;
}

/**
 * Build today's opening range from the 5m pane.
 * `post` is the chronological list of post-ORB 5m bars (open ≥ 09:45).
 * Returns null until at least 2 of the 3 opening-range bars are present.
 */
export function computeORB(ctx) {
  const p5 = ctx.pane('5');
  if (!p5?.bars || p5.bars.length < 20) return null;
  // Day-window math via a SINGLE day-boundary computation (no per-bar nyParts —
  // that was the hot-path killer). DST transitions only ever land on Sundays
  // (market closed → no RTH bars), so the fixed ET offset is exact for every
  // trading day.
  const bt = ctx.barTime;
  const dayStart = nyDayStartUnix(bt);             // 00:00 ET (unix)
  const orbStart = dayStart + RTH_OPEN_MIN * 60;   // 09:30 ET
  const orbEnd   = dayStart + ORB_END_MIN * 60;    // 09:45 ET
  const dayEnd   = dayStart + 24 * 3600;
  const orbBars = [], post = [];
  for (const b of p5.bars) {
    if (b.time < orbStart || b.time >= dayEnd) continue;
    if (b.time < orbEnd) orbBars.push(b);
    else post.push(b);
  }
  if (orbBars.length < 2) return null;
  const orbH = Math.max(...orbBars.map((b) => b.high));
  const orbL = Math.min(...orbBars.map((b) => b.low));
  const minutesNow = Math.floor((bt - dayStart) / 60);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(bt * 1000));
  const a5 = atr(p5.bars, 14) || (orbH - orbL) || 1;
  return {
    orbH, orbL, orbRange: orbH - orbL, orbDone: minutesNow >= ORB_END_MIN,
    minutesNow, weekday, post, a5,
  };
}

export function dayAllowed(weekday, days) { return days.includes(weekday); }

/** True when post[i] is the bar that crosses the edge (prev close on the
 * correct side). j=0's "prev" is an ORB bar, whose close is always inside the
 * range, so a first post bar beyond the edge is itself a crossover. */
function isCrossUp(post, i, orbH) {
  if (post[i].close <= orbH) return false;
  const prevClose = i === 0 ? orbH : post[i - 1].close;
  return prevClose <= orbH;
}
function isCrossDn(post, i, orbL) {
  if (post[i].close >= orbL) return false;
  const prevClose = i === 0 ? orbL : post[i - 1].close;
  return prevClose >= orbL;
}

// ── HUNTER ────────────────────────────────────────────────────────────────
export function hunterSignal(ctx, metaId, opts) {
  const o = computeORB(ctx);
  if (!o || !o.orbDone || !(o.orbRange > 0)) return [];
  if (o.minutesNow < opts.winStart || o.minutesNow >= opts.winEnd) return [];
  const n = o.post.length;
  if (n === 0) return [];
  const i = n - 1;                         // current (just-closed) 5m bar
  const last = o.post[i];
  const out = [];
  if (isCrossUp(o.post, i, o.orbH)) {
    const entry = last.close, stop = o.orbL;
    if (entry - stop > 0) out.push(orbTriggered({
      strategy: metaId, setupId: dayScopedId(metaId, ctx.dateKey, 'LONG', 'orb-hunter'),
      direction: 'LONG', timeframe: '5',
      confidence: qualityConfidence(metaId, [c01((entry - o.orbH) / o.a5), c01(o.orbRange / (2 * o.a5))]),
      setupName: 'ORB breakout (Hunter)',
      summary: `ORB ${o.orbL.toFixed(2)}–${o.orbH.toFixed(2)} (${o.orbRange.toFixed(2)}) · LONG breakout @ ${entry.toFixed(2)}`,
      entry, stop, t1Mult: 0.7, t2Mult: 2.0,   // partial 50% @ 0.7R, target 2R
    }));
  } else if (isCrossDn(o.post, i, o.orbL)) {
    const entry = last.close, stop = o.orbH;
    if (stop - entry > 0) out.push(orbTriggered({
      strategy: metaId, setupId: dayScopedId(metaId, ctx.dateKey, 'SHORT', 'orb-hunter'),
      direction: 'SHORT', timeframe: '5',
      confidence: qualityConfidence(metaId, [c01((o.orbL - entry) / o.a5), c01(o.orbRange / (2 * o.a5))]),
      setupName: 'ORB breakout (Hunter)',
      summary: `ORB ${o.orbL.toFixed(2)}–${o.orbH.toFixed(2)} (${o.orbRange.toFixed(2)}) · SHORT breakout @ ${entry.toFixed(2)}`,
      entry, stop, t1Mult: 0.7, t2Mult: 2.0,
    }));
  }
  return out;
}

// ── CONSERVATIVE ────────────────────────────────────────────────────────────
// Armed = a breakout crossover occurred in the prior CONS_MAX_BARS bars; entry
// triggers when the current bar retests the broken edge (Pine ll.269-297).
export function conservativeSignal(ctx, metaId, opts) {
  const o = computeORB(ctx);
  if (!o || !o.orbDone || !(o.orbRange > 0)) return [];
  if (o.minutesNow < opts.winStart || o.minutesNow >= opts.winEnd) return [];
  const n = o.post.length;
  if (n < 2) return [];
  const i = n - 1;
  const last = o.post[i];
  const from = Math.max(0, i - CONS_MAX_BARS);   // arm must be within 5 bars before now
  const out = [];
  let armedLong = false, armedShort = false;
  for (let j = from; j < i; j++) {
    if (isCrossUp(o.post, j, o.orbH)) armedLong = true;
    if (isCrossDn(o.post, j, o.orbL)) armedShort = true;
  }
  if (armedLong && last.low <= o.orbH && last.close > o.orbL) {
    const entry = o.orbH, stop = o.orbL;       // SD1.0 = orbH + orbRange (100% exit)
    out.push(orbTriggered({
      strategy: metaId, setupId: dayScopedId(metaId, ctx.dateKey, 'LONG', 'orb-cons'),
      direction: 'LONG', timeframe: '5',
      confidence: qualityConfidence(metaId, [0.5, c01(o.orbRange / (2 * o.a5))]),
      setupName: 'ORB retest (Conservative)',
      summary: `ORB ${o.orbL.toFixed(2)}–${o.orbH.toFixed(2)} · retest LONG · SD1.0 target`,
      entry, stop, t1: o.orbH + o.orbRange, t2: o.orbH + o.orbRange,
    }));
  } else if (armedShort && last.high >= o.orbL && last.close < o.orbH) {
    const entry = o.orbL, stop = o.orbH;
    out.push(orbTriggered({
      strategy: metaId, setupId: dayScopedId(metaId, ctx.dateKey, 'SHORT', 'orb-cons'),
      direction: 'SHORT', timeframe: '5',
      confidence: qualityConfidence(metaId, [0.5, c01(o.orbRange / (2 * o.a5))]),
      setupName: 'ORB retest (Conservative)',
      summary: `ORB ${o.orbL.toFixed(2)}–${o.orbH.toFixed(2)} · retest SHORT · SD1.0 target`,
      entry, stop, t1: o.orbL - o.orbRange, t2: o.orbL - o.orbRange,
    }));
  }
  return out;
}

// ── FVG (Revised) ────────────────────────────────────────────────────────────
// Post-breakout 3-candle FVG that sits at/above orbH (long) or at/below orbL
// (short), strict min 2.0 pt, entered on the retrace into the gap within
// FVG_BARS_AFTER bars (Pine ll.302-370). entry = near gap edge, stop = far gap
// edge ∓ buffer, target 2R.
export function fvgSignal(ctx, metaId, opts) {
  const o = computeORB(ctx);
  if (!o || !o.orbDone || !(o.orbRange > 0)) return [];
  if (o.minutesNow < opts.winStart || o.minutesNow >= opts.winEnd) return [];
  const post = o.post;
  const n = post.length;
  if (n < 4) return [];
  const i = n - 1;
  const last = post[i];
  const gaps = findFVGs(post, 60);
  if (!gaps.length) return [];
  // Newest qualifying gap that is still live (formed within FVG_BARS_AFTER bars).
  // findFVGs idx is the impulse (middle) bar; the gap "completes" at idx+1.
  let pick = null;
  for (const g of gaps) {
    const ageBars = i - (g.idx + 1);
    if (ageBars < 0 || ageBars > FVG_BARS_AFTER) continue;
    const size = g.top - g.bottom;
    if (size < FVG_MIN_SIZE) continue;
    if (g.side === 'bullish' && g.bottom >= o.orbH) pick = g;        // gap above ORB
    else if (g.side === 'bearish' && g.top <= o.orbL) pick = g;      // gap below ORB
  }
  if (!pick) return [];
  const out = [];
  if (pick.side === 'bullish' && last.low <= pick.top && last.low >= pick.bottom - FVG_BUFFER) {
    const entry = pick.top, stop = pick.bottom - FVG_BUFFER;
    if (entry - stop > 0) out.push(orbTriggered({
      strategy: metaId, setupId: dayScopedId(metaId, ctx.dateKey, 'LONG', `orb-fvg-${pick.time}`),
      direction: 'LONG', timeframe: '5',
      confidence: qualityConfidence(metaId, [c01((pick.top - pick.bottom) / o.a5), 0.55]),
      setupName: 'ORB post-breakout FVG (Revised)',
      summary: `Bullish FVG ${pick.bottom.toFixed(2)}–${pick.top.toFixed(2)} above ORB · retrace LONG`,
      entry, stop, t1Mult: 1.0, t2Mult: 2.0,
    }));
  } else if (pick.side === 'bearish' && last.high >= pick.bottom && last.high <= pick.top + FVG_BUFFER) {
    const entry = pick.bottom, stop = pick.top + FVG_BUFFER;
    if (stop - entry > 0) out.push(orbTriggered({
      strategy: metaId, setupId: dayScopedId(metaId, ctx.dateKey, 'SHORT', `orb-fvg-${pick.time}`),
      direction: 'SHORT', timeframe: '5',
      confidence: qualityConfidence(metaId, [c01((pick.top - pick.bottom) / o.a5), 0.55]),
      setupName: 'ORB post-breakout FVG (Revised)',
      summary: `Bearish FVG ${pick.bottom.toFixed(2)}–${pick.top.toFixed(2)} below ORB · retrace SHORT`,
      entry, stop, t1Mult: 1.0, t2Mult: 2.0,
    }));
  }
  return out;
}

/**
 * Shared precheck for /setups forming display. `style` ∈
 * 'hunter' | 'conservative' | 'fvg' | 'safeflow' | 'akimbo'.
 */
export function orbPrecheck(ctx, metaId, { style, days, winStart, winEnd }) {
  if (ctx.instrument !== 'nasdaq') return null;
  const o = computeORB(ctx);
  const np = nyParts((ctx.ts || Date.now()) / 1000);
  const nowMin = np.h * 60 + np.min;
  const dayOk = dayAllowed(np.weekday, days);
  const inWindow = nowMin >= winStart && nowMin < winEnd;
  const effStyle = style === 'akimbo'
    ? (['Mon', 'Wed', 'Fri'].includes(np.weekday) ? 'hunter' : 'conservative')
    : style;
  let direction = null, projection = null;
  if (o && o.orbDone && o.orbRange > 0 && o.post.length) {
    const i = o.post.length - 1;
    const last = o.post[i];
    if (effStyle === 'hunter') {
      if (isCrossUp(o.post, i, o.orbH)) direction = 'LONG';
      else if (isCrossDn(o.post, i, o.orbL)) direction = 'SHORT';
      if (direction) projection = projectTrade({ strategy: metaId, direction, entry: last.close, stop: direction === 'LONG' ? o.orbL : o.orbH });
    } else {
      const from = Math.max(0, i - CONS_MAX_BARS);
      let aL = false, aS = false;
      for (let j = from; j < i; j++) { if (isCrossUp(o.post, j, o.orbH)) aL = true; if (isCrossDn(o.post, j, o.orbL)) aS = true; }
      if (aL && last.low <= o.orbH) direction = 'LONG';
      else if (aS && last.high >= o.orbL) direction = 'SHORT';
      if (direction) projection = projectTrade({
        strategy: metaId, direction, entry: direction === 'LONG' ? o.orbH : o.orbL,
        stop: direction === 'LONG' ? o.orbL : o.orbH,
        t1: direction === 'LONG' ? o.orbH + o.orbRange : o.orbL - o.orbRange,
      });
    }
  }
  return {
    direction,
    projection,
    conditions: [
      { kind: 'gate', label: `Trading day (${days.join('/')})`, met: dayOk, value: np.weekday },
      { kind: 'gate', label: `Entry window (${fmtMin(winStart)}–${fmtMin(winEnd)} ET)`, met: inWindow, value: `${np.h}:${String(np.min).padStart(2, '0')} ET` },
      { kind: 'gate', label: 'Opening range built (09:30–09:45)', met: !!(o && o.orbDone), value: o ? `${o.orbL.toFixed(2)}–${o.orbH.toFixed(2)} (${o.orbRange.toFixed(2)} pt)` : 'forming' },
      { kind: 'trigger', label: effStyle === 'hunter' ? 'Crossover beyond range' : 'Breakout then retest', met: !!direction, value: direction || 'none yet' },
    ],
  };
}

function fmtMin(m) { return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
