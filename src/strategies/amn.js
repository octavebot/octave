/**
 * Strategy #8 — AMN (Adeel / AMN TRADING — Dual-Model Confirmation)
 *
 * Source: AMN.pdf "The Dual-Model Confirmation Strategy" by Adeel | AMN TRADING.
 *
 * Two entry models that both require the SAME 5M HTF context:
 *
 *   HTF SETUP (5M chart) — required for both models:
 *     1. Bullish (or bearish) trend: clean HH/HL (or LL/LH)
 *     2. Fresh unmitigated 5M demand zone — the origin of a prior BOS
 *     3. Liquidity engineering: a minor 1M-visible swing low between the HTF
 *        high and the demand zone, with retail stops parked below
 *     4. Sweep: price wicks below that engineered liquidity into the zone
 *
 *   MODEL 1 — LTF CHoCH on 1M:
 *     - Once price is inside the 5M demand zone with structure forming on 1M
 *     - Find the "protected high": the most recent 1M swing high that printed
 *       the absolute lowest low after the sweep
 *     - Wait for a 1M body close above the protected high (NOT a wick)
 *     - Entry: limit inside the new 1M discounted demand matrix
 *     - SL: just below the new 1M structural swing low
 *     - TP: fixed 1:1.5 RR
 *
 *   MODEL 2 — HTF IFVG on 5M:
 *     - Used when the drop into the zone is a single vertical leg with no
 *       1M structure to anchor a CHoCH
 *     - Find the last bearish 5M FVG inside the drop
 *     - Wait for a bullish 5M candle to body-close above the FVG's upper
 *       boundary (Candle 3 high) — gap is "inversed"
 *     - Entry: limit at the upper lip of the inversed FVG (i.e., the old C3
 *       high acts as new support)
 *     - SL: below the macro swing low inside the demand zone
 *     - TP: fixed 1:1.5 RR
 *
 * Symmetrical for shorts (bearish HTF trend, supply zone above, sweep above
 * an engineered liquidity high, etc.).
 *
 * AMN is intraday and not strictly killzone-gated, but real markets only
 * trend during liquid sessions, so we additionally require London or NY
 * killzone to be active. Spec says "asset class FX/indices/crypto" — for gold
 * the same logic applies during high-volume sessions.
 */

import { isMarketOpen } from '../lib/time.js';
import { activeKillZone } from '../lib/ict_session.js';
import { atr, findFVGs, findSwings, detectSweep } from '../lib/structure.js';

const NAME = 'AMN';
const LABEL = 'Strategy #8';
const RR = 1.5;

function findGold5(ctx)  { return ctx.panesByTf.get('gold|5'); }
function findGold1(ctx)  { return ctx.panesByTf.get('gold|1'); }

/**
 * Has the 5M chart been in a clean uptrend or downtrend recently?
 * Looks at the most recent 20 5M bars: we want HH/HL count for bullish,
 * LL/LH count for bearish. Returns 'LONG' / 'SHORT' / null.
 */
function detectTrend5M(bars) {
  if (bars.length < 30) return null;
  const tail = bars.slice(-30);
  const { highs: hSw, lows: lSw } = findSwings(tail, 2);
  if (hSw.length < 2 || lSw.length < 2) return null;
  const highs = hSw.map((s) => s.price);
  const lows  = lSw.map((s) => s.price);
  const hh = highs[highs.length - 1] > highs[highs.length - 2];
  const hl = lows[lows.length - 1]   > lows[lows.length - 2];
  const lh = highs[highs.length - 1] < highs[highs.length - 2];
  const ll = lows[lows.length - 1]   < lows[lows.length - 2];
  if (hh && hl) return 'LONG';
  if (ll && lh) return 'SHORT';
  return null;
}

/**
 * Identify the demand (or supply) zone — origin of the most recent BOS in
 * the trend direction. Simplified: take the bullish/bearish bar that broke
 * the prior swing high/low, use its body as the zone.
 */
function findFreshZone(bars, direction) {
  const tail = bars.slice(-50);
  const { highs: priorHighs, lows: priorLows } = findSwings(tail, 2);
  const offset = bars.length - tail.length;
  // For LONG demand zone: find the most recent BOS UP (bullish candle whose
  // close > a prior swing high). Its body becomes the demand zone.
  if (direction === 'LONG') {
    if (priorHighs.length === 0) return null;
    for (let i = bars.length - 1; i >= Math.max(0, bars.length - 30); i--) {
      const b = bars[i];
      const refHigh = priorHighs.find((h) => h.idx + offset < i)?.price;
      if (refHigh != null && b.close > refHigh && b.open < refHigh) {
        return { top: Math.max(b.open, b.close), bottom: Math.min(b.open, b.close), idx: i, time: b.time };
      }
    }
  } else {
    if (priorLows.length === 0) return null;
    for (let i = bars.length - 1; i >= Math.max(0, bars.length - 30); i--) {
      const b = bars[i];
      const refLow = priorLows.find((l) => l.idx + offset < i)?.price;
      if (refLow != null && b.close < refLow && b.open > refLow) {
        return { top: Math.max(b.open, b.close), bottom: Math.min(b.open, b.close), idx: i, time: b.time };
      }
    }
  }
  return null;
}

/** Has price recently swept into / through the zone? */
function priceIsInOrThroughZone(bars, zone, direction) {
  const last = bars[bars.length - 1];
  const tail = bars.slice(-6);
  if (direction === 'LONG') {
    // price has wicked into or below the zone in the last few bars
    return tail.some((b) => b.low <= zone.top && b.low >= zone.bottom - 5)
        || last.low <= zone.top;
  }
  return tail.some((b) => b.high >= zone.bottom && b.high <= zone.top + 5)
      || last.high >= zone.bottom;
}

/**
 * MODEL 1 — 1M CHoCH check.
 *
 * After the 5M sweep:
 *   - Locate the most recent 1M swing low (LONG) inside the zone area
 *   - The "protected high" is the 1M swing high after that low
 *   - Trigger: most recent 1M candle's body close > protected high
 *
 * Returns the trade plan or null.
 */
function tryModel1_CHoCH(bars1m, zone, direction) {
  if (!bars1m || bars1m.length < 30) return null;
  // Limit to bars after the zone touch (last 80 1M bars)
  const tail = bars1m.slice(-80);
  const { highs: allHighs, lows: allLows } = findSwings(tail, 2);
  if (allHighs.length + allLows.length < 3) return null;

  if (direction === 'LONG') {
    // Find the absolute lowest swing low in the zone region
    const lows = allLows.filter((s) => tail[s.idx].low <= zone.top);
    if (lows.length === 0) return null;
    const swingLow = lows.reduce((a, b) => (a.price < b.price ? a : b));
    // Protected high = the swing high AFTER the swing low
    const highsAfter = allHighs.filter((s) => s.idx > swingLow.idx);
    if (highsAfter.length === 0) return null;
    const protectedHigh = highsAfter[highsAfter.length - 1];
    // Trigger: latest candle's body (close) > protectedHigh.price AND open < protectedHigh.price
    const last = tail[tail.length - 1];
    const bodyTop = Math.max(last.open, last.close);
    const bodyBottom = Math.min(last.open, last.close);
    if (bodyTop > protectedHigh.price && bodyBottom < protectedHigh.price) {
      // CHoCH confirmed — entry inside the new 1M demand matrix (recent dip)
      const entryRangeTop = protectedHigh.price;
      const entryRangeBottom = tail[swingLow.idx].low;
      const entry = entryRangeBottom + 0.4 * (entryRangeTop - entryRangeBottom);
      const stop = entryRangeBottom - 0.05 * (entryRangeTop - entryRangeBottom);
      const risk = Math.abs(entry - stop);
      const t1 = entry + RR * risk;
      return { model: 'CHoCH', entry, stop, t1, risk, protectedHigh: protectedHigh.price, swingLow: swingLow.price };
    }
  } else {
    const highs = allHighs.filter((s) => tail[s.idx].high >= zone.bottom);
    if (highs.length === 0) return null;
    const swingHigh = highs.reduce((a, b) => (a.price > b.price ? a : b));
    const lowsAfter = allLows.filter((s) => s.idx > swingHigh.idx);
    if (lowsAfter.length === 0) return null;
    const protectedLow = lowsAfter[lowsAfter.length - 1];
    const last = tail[tail.length - 1];
    const bodyTop = Math.max(last.open, last.close);
    const bodyBottom = Math.min(last.open, last.close);
    if (bodyBottom < protectedLow.price && bodyTop > protectedLow.price) {
      const entryRangeBottom = protectedLow.price;
      const entryRangeTop = tail[swingHigh.idx].high;
      const entry = entryRangeTop - 0.4 * (entryRangeTop - entryRangeBottom);
      const stop = entryRangeTop + 0.05 * (entryRangeTop - entryRangeBottom);
      const risk = Math.abs(stop - entry);
      const t1 = entry - RR * risk;
      return { model: 'CHoCH', entry, stop, t1, risk, protectedLow: protectedLow.price, swingHigh: swingHigh.price };
    }
  }
  return null;
}

/**
 * MODEL 2 — 5M IFVG (Inverse Fair Value Gap).
 *
 * After the 5M sweep, find the most recent bearish (for LONG) FVG. Wait for a
 * bullish 5M candle to body-close above its top. Entry: limit at the upper
 * boundary of the now-inversed FVG (old top = new support).
 */
function tryModel2_IFVG(bars5m, zone, direction) {
  if (!bars5m || bars5m.length < 30) return null;
  const fvgs = findFVGs(bars5m, 30);
  if (direction === 'LONG') {
    // Find a bearish FVG whose level overlaps the zone area
    const candidates = fvgs.filter((f) => f.side === 'bearish' && f.top >= zone.bottom && f.bottom <= zone.top + 5)
      .sort((a, b) => b.idx - a.idx);
    for (const fvg of candidates) {
      // Look forward from fvg.idx for a bullish candle whose body close > fvg.top
      for (let i = fvg.idx + 1; i < bars5m.length; i++) {
        const b = bars5m[i];
        if (b.close > b.open && b.close > fvg.top) {
          // Inversion confirmed. Entry = fvg.top (the now-flipped upper lip)
          const entry = fvg.top;
          const stop = zone.bottom - 0.3 * (zone.top - zone.bottom); // below macro swing low in zone
          const risk = Math.abs(entry - stop);
          if (risk <= 0) continue;
          const t1 = entry + RR * risk;
          return { model: 'IFVG', entry, stop, t1, risk, invertedAt: b.time, fvgTop: fvg.top, fvgBottom: fvg.bottom };
        }
      }
    }
  } else {
    const candidates = fvgs.filter((f) => f.side === 'bullish' && f.bottom <= zone.top && f.top >= zone.bottom - 5)
      .sort((a, b) => b.idx - a.idx);
    for (const fvg of candidates) {
      for (let i = fvg.idx + 1; i < bars5m.length; i++) {
        const b = bars5m[i];
        if (b.close < b.open && b.close < fvg.bottom) {
          const entry = fvg.bottom;
          const stop = zone.top + 0.3 * (zone.top - zone.bottom);
          const risk = Math.abs(stop - entry);
          if (risk <= 0) continue;
          const t1 = entry - RR * risk;
          return { model: 'IFVG', entry, stop, t1, risk, invertedAt: b.time, fvgTop: fvg.top, fvgBottom: fvg.bottom };
        }
      }
    }
  }
  return null;
}

function buildTriggered(ctx, direction, plan, zone) {
  const t1r = plan.risk > 0 ? Math.abs(plan.t1 - plan.entry) / plan.risk : 0;
  return {
    strategy: NAME,
    setupId: `${NAME}-${ctx.dateKey}-${direction}-${plan.model}-${Math.round(plan.entry * 100)}`,
    status: 'triggered',
    direction,
    setupName: `${LABEL} · ${direction} ${plan.model} TRIGGERED`,
    summary: `5M HTF ${direction === 'LONG' ? 'demand' : 'supply'} swept + ${plan.model === 'CHoCH' ? '1M CHoCH body-close' : '5M FVG inversion'}. Entry ${plan.entry.toFixed(2)} · SL ${plan.stop.toFixed(2)} · TP ${plan.t1.toFixed(2)} (1:${RR} RR).`,
    confidence: 0.78 + (plan.model === 'CHoCH' ? 0.04 : 0.02),
    details: {
      'model': plan.model,
      'zone': `${zone.bottom.toFixed(2)} - ${zone.top.toFixed(2)}`,
      'entry': plan.entry.toFixed(2),
      'stop': plan.stop.toFixed(2),
      'TP (1:1.5)': plan.t1.toFixed(2),
      ...(plan.protectedHigh != null ? { 'protected high': plan.protectedHigh.toFixed(2) } : {}),
      ...(plan.protectedLow != null ? { 'protected low': plan.protectedLow.toFixed(2) } : {}),
      ...(plan.fvgTop != null ? { 'IFVG zone': `${plan.fvgBottom.toFixed(2)} - ${plan.fvgTop.toFixed(2)}` } : {}),
    },
    invalidationLevel: plan.stop,
    entryPlan: {
      direction, entry: plan.entry, stop: plan.stop,
      t1: plan.t1, t2: plan.t1, runner: plan.t1, risk: plan.risk,
    },
    geometry: {
      target: { name: plan.model === 'CHoCH' ? 'CHoCH high' : 'IFVG top', level: plan.model === 'CHoCH' ? plan.protectedHigh || plan.protectedLow : plan.fvgTop },
      sweep: { wickPrice: direction === 'LONG' ? zone.bottom : zone.top, time: zone.time },
      mss: { brokenPrice: plan.model === 'CHoCH' ? (plan.protectedHigh || plan.protectedLow) : plan.fvgTop, time: plan.invertedAt },
      fvg: plan.fvgTop != null ? { top: plan.fvgTop, bottom: plan.fvgBottom } : null,
      entryPlan: { direction, entry: plan.entry, stop: plan.stop, t1: plan.t1, t2: plan.t1, runner: plan.t1 },
    },
  };
}

export function evaluateAMN(ctx) {
  const now = ctx.ts / 1000;
  if (!isMarketOpen(now)) return [];
  if (!activeKillZone(now)) return []; // require liquid session

  const m5 = findGold5(ctx);
  const m1 = findGold1(ctx);
  if (!m5 || !m5.bars || m5.bars.length < 40) return [];

  const out = [];
  for (const direction of ['LONG', 'SHORT']) {
    const trend = detectTrend5M(m5.bars);
    if (trend !== direction) continue;
    const zone = findFreshZone(m5.bars, direction);
    if (!zone) continue;
    if (!priceIsInOrThroughZone(m5.bars, zone, direction)) continue;

    // Try Model 1 first (CHoCH on 1M) — primary mechanism per spec
    let plan = m1 && m1.bars && m1.bars.length >= 30
      ? tryModel1_CHoCH(m1.bars, zone, direction)
      : null;
    // If Model 1 doesn't fit (no clean structure on 1M), try Model 2 (IFVG)
    if (!plan) plan = tryModel2_IFVG(m5.bars, zone, direction);

    if (plan && plan.risk > 0) {
      out.push(buildTriggered(ctx, direction, plan, zone));
    }
  }
  return out;
}
