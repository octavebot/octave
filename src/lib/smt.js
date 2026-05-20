/**
 * SMT (Smart Money Technique) — Gold ↔ DXY divergence detection.
 *
 * Per Strategy 2 step 11:
 *   Bullish SMT (long setup confluence):
 *     - Gold makes a new low (the judas sweep)
 *     - DXY does NOT make a corresponding new high
 *     → divergence signals smart money no longer pushing the move
 *
 *   Bearish SMT (short setup confluence):
 *     - Gold makes a new high
 *     - DXY does NOT make a corresponding new low
 *
 * Both panes should be on the same timeframe (typically the execution TF).
 */

function maxHigh(bars, fromIdx, toIdx) {
  let m = -Infinity;
  for (let i = fromIdx; i <= toIdx && i < bars.length; i++) {
    if (i < 0) continue;
    if (bars[i].high > m) m = bars[i].high;
  }
  return m;
}

function minLow(bars, fromIdx, toIdx) {
  let m = Infinity;
  for (let i = fromIdx; i <= toIdx && i < bars.length; i++) {
    if (i < 0) continue;
    if (bars[i].low < m) m = bars[i].low;
  }
  return m;
}

/**
 * Align DXY bars to gold's sweep window by timestamp.
 * Returns the DXY bar slice within the same time range.
 */
function dxySliceForGoldWindow(goldBars, dxyBars, windowBars) {
  if (!goldBars.length || !dxyBars.length) return [];
  const startTime = goldBars[Math.max(0, goldBars.length - windowBars)].time;
  const endTime = goldBars[goldBars.length - 1].time;
  return dxyBars.filter((b) => b.time >= startTime && b.time <= endTime);
}

/**
 * Evaluate SMT for a given sweep direction.
 *
 * @param {Array} goldBars
 * @param {Array} dxyBars
 * @param {'sweep_low'|'sweep_high'} sweepKind  what gold just did
 * @param {number} windowBars  bars to look back for "did the other side make corresponding high/low?"
 * @returns {{ smt: 'bullish'|'bearish'|'none', confirmed: boolean, reason: string }}
 */
export function evaluateSMT(goldBars, dxyBars, sweepKind, windowBars = 20) {
  if (!dxyBars || dxyBars.length === 0) {
    return { smt: 'none', confirmed: false, reason: 'DXY pane unavailable' };
  }
  if (!goldBars || goldBars.length < 3) {
    return { smt: 'none', confirmed: false, reason: 'gold bars insufficient' };
  }

  // Compare gold's most recent N bars vs DXY's same time window.
  const slice = dxySliceForGoldWindow(goldBars, dxyBars, windowBars);
  if (slice.length < 3) {
    return { smt: 'none', confirmed: false, reason: 'DXY/gold time alignment insufficient' };
  }

  // Reference: prior window (bars BEFORE the recent N), so we have a baseline
  const goldRecentStart = Math.max(0, goldBars.length - windowBars);
  const goldPriorEnd = goldRecentStart - 1;
  const goldPriorStart = Math.max(0, goldPriorEnd - windowBars + 1);

  const goldRecentLow = minLow(goldBars, goldRecentStart, goldBars.length - 1);
  const goldRecentHigh = maxHigh(goldBars, goldRecentStart, goldBars.length - 1);
  const goldPriorLow = minLow(goldBars, goldPriorStart, goldPriorEnd);
  const goldPriorHigh = maxHigh(goldBars, goldPriorStart, goldPriorEnd);

  const dxyStartTime = goldBars[goldRecentStart].time;
  const dxyRecent = dxyBars.filter((b) => b.time >= dxyStartTime);
  const dxyPrior = dxyBars.filter((b) => b.time < dxyStartTime).slice(-windowBars);
  if (dxyRecent.length === 0 || dxyPrior.length === 0) {
    return { smt: 'none', confirmed: false, reason: 'DXY alignment insufficient' };
  }
  const dxyRecentLow = minLow(dxyRecent, 0, dxyRecent.length - 1);
  const dxyRecentHigh = maxHigh(dxyRecent, 0, dxyRecent.length - 1);
  const dxyPriorLow = minLow(dxyPrior, 0, dxyPrior.length - 1);
  const dxyPriorHigh = maxHigh(dxyPrior, 0, dxyPrior.length - 1);

  if (sweepKind === 'sweep_low') {
    // Gold made new low (recent low < prior low). For bullish SMT, DXY did NOT make new high.
    const goldNewLow = goldRecentLow < goldPriorLow;
    const dxyNewHigh = dxyRecentHigh > dxyPriorHigh;
    if (goldNewLow && !dxyNewHigh) {
      return { smt: 'bullish', confirmed: true, reason: 'Gold new low, DXY no new high — bullish divergence' };
    }
    if (goldNewLow && dxyNewHigh) {
      return { smt: 'none', confirmed: false, reason: 'Gold new low AND DXY new high — momentum confirms down' };
    }
    return { smt: 'none', confirmed: false, reason: 'gold did not make new low vs prior window' };
  }
  if (sweepKind === 'sweep_high') {
    const goldNewHigh = goldRecentHigh > goldPriorHigh;
    const dxyNewLow = dxyRecentLow < dxyPriorLow;
    if (goldNewHigh && !dxyNewLow) {
      return { smt: 'bearish', confirmed: true, reason: 'Gold new high, DXY no new low — bearish divergence' };
    }
    if (goldNewHigh && dxyNewLow) {
      return { smt: 'none', confirmed: false, reason: 'Gold new high AND DXY new low — momentum confirms up' };
    }
    return { smt: 'none', confirmed: false, reason: 'gold did not make new high vs prior window' };
  }
  return { smt: 'none', confirmed: false, reason: 'unknown sweep kind' };
}

/**
 * Gold↔Silver SMT (per Strategy #3 spec).
 *
 * Gold and Silver are POSITIVELY correlated. Divergence:
 *   Bullish SMT: Gold makes a new low, Silver does NOT make a new low
 *                (silver holding up = smart money accumulating, gold sweep is the trap)
 *   Bearish SMT: Gold makes a new high, Silver does NOT make a new high
 *
 * @param {Array} goldBars
 * @param {Array} silverBars
 * @param {'sweep_low'|'sweep_high'} sweepKind
 * @param {number} windowBars
 */
export function evaluateGoldSilverSMT(goldBars, silverBars, sweepKind, windowBars = 20) {
  if (!silverBars || silverBars.length === 0) {
    return { smt: 'none', confirmed: false, reason: 'Silver pane unavailable' };
  }
  if (!goldBars || goldBars.length < 3) {
    return { smt: 'none', confirmed: false, reason: 'gold bars insufficient' };
  }

  const goldRecentStart = Math.max(0, goldBars.length - windowBars);
  const goldPriorEnd = goldRecentStart - 1;
  const goldPriorStart = Math.max(0, goldPriorEnd - windowBars + 1);

  const goldRecentLow = minLow(goldBars, goldRecentStart, goldBars.length - 1);
  const goldRecentHigh = maxHigh(goldBars, goldRecentStart, goldBars.length - 1);
  const goldPriorLow = minLow(goldBars, goldPriorStart, goldPriorEnd);
  const goldPriorHigh = maxHigh(goldBars, goldPriorStart, goldPriorEnd);

  const sliceStart = goldBars[goldRecentStart].time;
  const silverRecent = silverBars.filter((b) => b.time >= sliceStart);
  const silverPrior = silverBars.filter((b) => b.time < sliceStart).slice(-windowBars);
  if (silverRecent.length === 0 || silverPrior.length === 0) {
    return { smt: 'none', confirmed: false, reason: 'silver/gold time alignment insufficient' };
  }
  const silverRecentLow = minLow(silverRecent, 0, silverRecent.length - 1);
  const silverRecentHigh = maxHigh(silverRecent, 0, silverRecent.length - 1);
  const silverPriorLow = minLow(silverPrior, 0, silverPrior.length - 1);
  const silverPriorHigh = maxHigh(silverPrior, 0, silverPrior.length - 1);

  if (sweepKind === 'sweep_low') {
    const goldNewLow = goldRecentLow < goldPriorLow;
    const silverNewLow = silverRecentLow < silverPriorLow;
    if (goldNewLow && !silverNewLow) {
      return { smt: 'bullish', confirmed: true, reason: 'Gold new low, Silver no new low — bullish SMT' };
    }
    if (goldNewLow && silverNewLow) {
      return { smt: 'none', confirmed: false, reason: 'Gold + Silver both new lows — momentum confirms down' };
    }
    return { smt: 'none', confirmed: false, reason: 'gold did not make new low vs prior window' };
  }
  if (sweepKind === 'sweep_high') {
    const goldNewHigh = goldRecentHigh > goldPriorHigh;
    const silverNewHigh = silverRecentHigh > silverPriorHigh;
    if (goldNewHigh && !silverNewHigh) {
      return { smt: 'bearish', confirmed: true, reason: 'Gold new high, Silver no new high — bearish SMT' };
    }
    if (goldNewHigh && silverNewHigh) {
      return { smt: 'none', confirmed: false, reason: 'Gold + Silver both new highs — momentum confirms up' };
    }
    return { smt: 'none', confirmed: false, reason: 'gold did not make new high vs prior window' };
  }
  return { smt: 'none', confirmed: false, reason: 'unknown sweep kind' };
}
