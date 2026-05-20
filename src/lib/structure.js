/**
 * Market structure primitives used by both strategies.
 *
 * All functions operate on a contiguous, ascending-by-time array of bars.
 * Bars are: { time, open, high, low, close, volume }
 */

/** ATR(N) using true range. Returns the last ATR value. */
export function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // Simple average of the last `period` TRs (no Wilder smoothing — keep it cheap)
  const last = trs.slice(-period);
  return last.reduce((a, b) => a + b, 0) / last.length;
}

/**
 * Identify swing pivots using `lookback` bars on each side.
 * Returns { highs: [{idx, time, price}], lows: [...] }, oldest first.
 */
export function findSwings(bars, lookback = 3) {
  const highs = [];
  const lows = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const h = bars[i].high, l = bars[i].low;
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j].high >= h) isHigh = false;
      if (bars[j].low <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ idx: i, time: bars[i].time, price: h });
    if (isLow) lows.push({ idx: i, time: bars[i].time, price: l });
  }
  return { highs, lows };
}

/**
 * Most-recent swing pivots (with confirmation lookback).
 * Returns the last confirmed swing high and low (may be null).
 */
export function lastSwings(bars, lookback = 3) {
  const { highs, lows } = findSwings(bars, lookback);
  return {
    swingHigh: highs.length ? highs[highs.length - 1] : null,
    swingLow: lows.length ? lows[lows.length - 1] : null,
  };
}

/**
 * Detect a liquidity sweep of a level.
 * A sweep = a bar wicks past the level AND closes back inside the range.
 *
 * @param {Array} bars        ascending bars
 * @param {number} level      price level being swept
 * @param {'BSL'|'SSL'} side  BSL = sweep above; SSL = sweep below
 * @param {number} lookback   how many recent bars to scan (default 6)
 * @returns {null | { idx, time, wickPrice, closePrice, magnitude }}
 */
export function detectSweep(bars, level, side, lookback = 6) {
  const start = Math.max(0, bars.length - lookback);
  for (let i = bars.length - 1; i >= start; i--) {
    const b = bars[i];
    if (side === 'BSL') {
      // Wick above level, close back at/below it
      if (b.high > level && b.close <= level) {
        return {
          idx: i,
          time: b.time,
          wickPrice: b.high,
          closePrice: b.close,
          magnitude: b.high - level,
        };
      }
    } else {
      if (b.low < level && b.close >= level) {
        return {
          idx: i,
          time: b.time,
          wickPrice: b.low,
          closePrice: b.close,
          magnitude: level - b.low,
        };
      }
    }
  }
  return null;
}

/**
 * Find Fair Value Gaps in the recent history.
 * 3-candle pattern:
 *   bullish FVG = bars[i-1].high < bars[i+1].low (gap between them, bar i is the impulse)
 *   bearish FVG = bars[i-1].low  > bars[i+1].high
 *
 * Returns FVGs in chronological order. Each FVG: { idx, time, side, top, bottom, mid, filled, invalidated }
 *
 * 'filled' means the FVG has been touched by a later candle (mitigated).
 * 'invalidated' means a later candle closed THROUGH it (IFVG candidate).
 */
export function findFVGs(bars, lookbackBars = 80) {
  const out = [];
  const start = Math.max(1, bars.length - lookbackBars);
  const end = bars.length - 1;
  for (let i = start; i < end; i++) {
    const prev = bars[i - 1], next = bars[i + 1], mid = bars[i];
    // bullish
    if (prev.high < next.low) {
      const top = next.low, bottom = prev.high;
      out.push(buildFvg(bars, i, mid.time, 'bullish', top, bottom));
    }
    // bearish
    if (prev.low > next.high) {
      const top = prev.low, bottom = next.high;
      out.push(buildFvg(bars, i, mid.time, 'bearish', top, bottom));
    }
  }
  return out;
}

function buildFvg(bars, idx, time, side, top, bottom) {
  const mid = (top + bottom) / 2;
  let filled = false, invalidated = false;
  for (let j = idx + 2; j < bars.length; j++) {
    const b = bars[j];
    // Touched (partial fill)
    if (b.low <= top && b.high >= bottom) filled = true;
    // Invalidation = close beyond opposite side of gap
    if (side === 'bullish' && b.close < bottom) invalidated = true;
    if (side === 'bearish' && b.close > top) invalidated = true;
  }
  return { idx, time, side, top, bottom, mid, filled, invalidated };
}

/**
 * Detect Market Structure Shift / Change of Character.
 * After a directional move, a strong opposing candle closes past the
 * most recent opposing swing pivot, with body > displacementMult × ATR.
 *
 * @param {Array} bars
 * @param {'bullish'|'bearish'} direction direction the MSS would shift TO
 * @param {object} opts { displacementMult=1.0, atrPeriod=14, lookback=20, swingLookback=3 }
 * @returns null | { idx, time, side, brokenSwing, displacement, atrAtBreak }
 */
export function detectMSS(bars, direction, opts = {}) {
  const displacementMult = opts.displacementMult ?? 1.0;
  const atrPeriod = opts.atrPeriod ?? 14;
  const lookback = opts.lookback ?? 20;
  const swingLookback = opts.swingLookback ?? 3;

  const a = atr(bars, atrPeriod);
  if (!a) return null;

  const { highs, lows } = findSwings(bars, swingLookback);
  const scanStart = Math.max(0, bars.length - lookback);

  for (let i = bars.length - 1; i >= scanStart; i--) {
    const b = bars[i];
    const body = Math.abs(b.close - b.open);
    if (body < a * displacementMult) continue;

    if (direction === 'bullish' && b.close > b.open) {
      // Find the most recent swing HIGH that lives BEFORE this candle.
      // Bullish MSS breaks an LTF lower-high during a down-move.
      const prevHigh = lastBefore(highs, i);
      if (prevHigh && b.close > prevHigh.price) {
        return {
          idx: i,
          time: b.time,
          side: 'bullish',
          brokenSwing: prevHigh,
          displacement: body,
          atrAtBreak: a,
          ratio: body / a,
        };
      }
    } else if (direction === 'bearish' && b.close < b.open) {
      const prevLow = lastBefore(lows, i);
      if (prevLow && b.close < prevLow.price) {
        return {
          idx: i,
          time: b.time,
          side: 'bearish',
          brokenSwing: prevLow,
          displacement: body,
          atrAtBreak: a,
          ratio: body / a,
        };
      }
    }
  }
  return null;
}

function lastBefore(pivots, idx) {
  for (let i = pivots.length - 1; i >= 0; i--) if (pivots[i].idx < idx) return pivots[i];
  return null;
}

/**
 * Identify the Order Block adjacent to an MSS — the last opposing candle
 * before the displacement candle.
 */
export function orderBlockBefore(bars, mssIdx, side) {
  for (let i = mssIdx - 1; i >= Math.max(0, mssIdx - 8); i--) {
    const b = bars[i];
    const isOpposing = side === 'bullish' ? b.close < b.open : b.close > b.open;
    if (isOpposing) {
      return {
        idx: i,
        time: b.time,
        side,
        high: b.high,
        low: b.low,
        open: b.open,
        close: b.close,
        body: { top: Math.max(b.open, b.close), bottom: Math.min(b.open, b.close) },
      };
    }
  }
  return null;
}

/**
 * OTE (Optimal Trade Entry) retracement: 0.62–0.79 of the leg.
 * legLow = bottom of leg, legHigh = top of leg.
 * For longs after a sweep low: legLow = sweep low, legHigh = MSS high.
 * For shorts after a sweep high: legHigh = sweep high, legLow = MSS low.
 * Returns { high, mid, low } of the OTE zone (0.62 / 0.705 / 0.79 retracement).
 */
export function oteZone(legLow, legHigh, direction) {
  const diff = legHigh - legLow;
  if (direction === 'bullish') {
    return {
      shallow: legHigh - 0.62 * diff,
      sweet: legHigh - 0.705 * diff,
      deep: legHigh - 0.79 * diff,
    };
  } else {
    return {
      shallow: legLow + 0.62 * diff,
      sweet: legLow + 0.705 * diff,
      deep: legLow + 0.79 * diff,
    };
  }
}

/**
 * Volume spike detector. Returns true if the most recent bar's volume
 * is at least `factor` × the average of the prior `lookback` bars.
 * Returns null if there's no volume data (some TV symbols don't expose it).
 */
export function volumeSpike(bars, factor = 1.5, lookback = 20) {
  if (!bars || bars.length < lookback + 1) return null;
  const last = bars[bars.length - 1];
  const window = bars.slice(-lookback - 1, -1);
  const hasVolume = window.some((b) => (b.volume || 0) > 0);
  if (!hasVolume) return null;
  const avg = window.reduce((a, b) => a + (b.volume || 0), 0) / window.length;
  if (avg === 0) return null;
  return {
    spike: (last.volume || 0) >= factor * avg,
    ratio: avg ? (last.volume || 0) / avg : 0,
    lastVolume: last.volume || 0,
    avgVolume: avg,
  };
}

/**
 * 71% Fibonacci retracement of a displacement leg (per Strategy #3).
 *   bullish: legLow -> legHigh, fib71 = legHigh - 0.71 × range
 *   bearish: legHigh -> legLow, fib71 = legLow + 0.71 × range
 */
export function fib71(legLow, legHigh, direction) {
  const range = legHigh - legLow;
  if (direction === 'bullish') return legHigh - 0.71 * range;
  return legLow + 0.71 * range;
}

/**
 * Does point `p` lie inside or touch the [top, bottom] zone?
 */
export function isWithinZone(p, top, bottom) {
  const hi = Math.max(top, bottom);
  const lo = Math.min(top, bottom);
  return p >= lo && p <= hi;
}

/**
 * Premium/discount classification of a price within a range.
 * Returns 'premium' (top half), 'discount' (bottom half), or 'equilibrium' (within 1% of mid).
 */
export function pdRegion(price, rangeLow, rangeHigh) {
  const mid = (rangeLow + rangeHigh) / 2;
  const tol = (rangeHigh - rangeLow) * 0.01;
  if (Math.abs(price - mid) < tol) return 'equilibrium';
  return price > mid ? 'premium' : 'discount';
}
