/**
 * Session range tracker.
 *
 * From a flat list of bars on the 15m TF, computes:
 *  - the most recently COMPLETED range for each of asia/london/ny_am/ny_pm
 *  - the IN-PROGRESS range for whichever session is currently active (if any)
 *  - prior day's PDH/PDL and prior week's PWH/PWL for HTF context
 *
 * Bars are expected to be sorted ascending by time.
 */

import { sessionBucket, activeSession, nyParts } from './time.js';

/**
 * Build per-session range buckets from bars.
 * @param {Array<{time:number,high:number,low:number,close:number}>} bars
 * @returns {{
 *   bySession: { asia: Range[], london: Range[], ny_am: Range[], ny_pm: Range[] },
 *   live: { session: string|null, range: Range|null },
 *   byDay: { [dateKey]: { high:number, low:number, open:number, close:number } }
 * }}
 *
 * Where Range = { session, dateKey, high, low, openTime, closeTime, complete, barCount }
 */
export function buildSessionRanges(bars, now = Date.now() / 1000) {
  const out = {
    bySession: { asia: [], london: [], ny_am: [], ny_pm: [] },
    live: { session: null, range: null },
    byDay: {},
  };
  if (!bars || bars.length === 0) return out;

  const buckets = new Map(); // key = `${session}|${dateKey}` -> aggregate
  const dayBuckets = new Map(); // key = dateKey -> { high, low, open, close, firstTime, lastTime }
  const liveSession = activeSession(now);

  for (const b of bars) {
    const sb = sessionBucket(b);
    const p = nyParts(b.time);
    const dKey = p.dateKey;
    const day = dayBuckets.get(dKey);
    if (!day) {
      dayBuckets.set(dKey, {
        dateKey: dKey,
        high: b.high,
        low: b.low,
        open: b.open,
        close: b.close,
        firstTime: b.time,
        lastTime: b.time,
      });
    } else {
      day.high = Math.max(day.high, b.high);
      day.low = Math.min(day.low, b.low);
      day.close = b.close;
      day.lastTime = b.time;
    }

    if (!sb) continue;
    const key = `${sb.session}|${sb.dateKey}`;
    const cur = buckets.get(key);
    if (!cur) {
      buckets.set(key, {
        session: sb.session,
        dateKey: sb.dateKey,
        high: b.high,
        low: b.low,
        openTime: b.time,
        closeTime: b.time,
        firstClose: b.close,
        lastClose: b.close,
        barCount: 1,
      });
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.closeTime = b.time;
      cur.lastClose = b.close;
      cur.barCount += 1;
    }
  }

  out.byDay = Object.fromEntries(dayBuckets);

  // Sort each session list by dateKey descending and split live/complete
  for (const [key, agg] of buckets) {
    const sessName = agg.session;
    // Live = session matches current AND its date matches the current session's bucket date
    const isLive = (() => {
      if (sessName !== liveSession) return false;
      const liveBucket = sessionBucket({ time: now });
      return liveBucket && liveBucket.dateKey === agg.dateKey;
    })();
    if (isLive) {
      agg.complete = false;
      out.live = { session: sessName, range: agg };
    } else {
      agg.complete = true;
      out.bySession[sessName].push(agg);
    }
  }

  for (const s of Object.keys(out.bySession)) {
    out.bySession[s].sort((a, b) => (a.dateKey < b.dateKey ? 1 : -1));
  }

  return out;
}

/**
 * Convenience: get the most recently completed range for a session.
 */
export function lastCompletedRange(sessionRanges, sessionName) {
  const arr = sessionRanges.bySession[sessionName];
  return arr && arr.length > 0 ? arr[0] : null;
}

/**
 * Build the list of "draw on liquidity" candidates for the active session,
 * per the USLS session→target mapping table in Strategy 1.
 *
 * Returns an array of { name, level, side } where side ∈ {'BSL','SSL'}.
 */
export function liquidityTargetsFor(sessionRanges, activeSessionName) {
  const targets = [];
  const push = (label, range, side) => {
    if (!range) return;
    const level = side === 'BSL' ? range.high : range.low;
    targets.push({ name: label, level, side, fromSession: range.session, fromDate: range.dateKey });
  };

  const lastAsia = lastCompletedRange(sessionRanges, 'asia');
  const lastLondon = lastCompletedRange(sessionRanges, 'london');
  const lastNyAm = lastCompletedRange(sessionRanges, 'ny_am');
  const lastNyPm = lastCompletedRange(sessionRanges, 'ny_pm');

  switch (activeSessionName) {
    case 'london':
      push('AsiaHi (BSL)', lastAsia, 'BSL');
      push('AsiaLo (SSL)', lastAsia, 'SSL');
      break;
    case 'ny_am':
      push('LondonHi (BSL)', lastLondon, 'BSL');
      push('LondonLo (SSL)', lastLondon, 'SSL');
      push('AsiaHi (BSL)', lastAsia, 'BSL');
      push('AsiaLo (SSL)', lastAsia, 'SSL');
      break;
    case 'ny_pm':
      push('NYAM-Hi (BSL)', lastNyAm, 'BSL');
      push('NYAM-Lo (SSL)', lastNyAm, 'SSL');
      break;
    case 'asia':
      push('PrevNYPM-Hi (BSL)', lastNyPm, 'BSL');
      push('PrevNYPM-Lo (SSL)', lastNyPm, 'SSL');
      break;
    default:
      // Outside any named session (5-7 EST gap, 10-13 EST lunch, 16-19 EST gap,
      // or weekend). Use ALL most-recent session ranges as candidates so the
      // strategy can still trigger if price sweeps any meaningful level.
      push('NYPM-Hi (BSL)', lastNyPm, 'BSL');
      push('NYPM-Lo (SSL)', lastNyPm, 'SSL');
      push('NYAM-Hi (BSL)', lastNyAm, 'BSL');
      push('NYAM-Lo (SSL)', lastNyAm, 'SSL');
      push('LondonHi (BSL)', lastLondon, 'BSL');
      push('LondonLo (SSL)', lastLondon, 'SSL');
      push('AsiaHi (BSL)', lastAsia, 'BSL');
      push('AsiaLo (SSL)', lastAsia, 'SSL');
      break;
  }

  return targets;
}
