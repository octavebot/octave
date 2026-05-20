/**
 * ICT/SMT M15 session helpers (Strategy #5 + #6).
 *
 * Per the specs:
 *   - Asian Range: 20:00 - 00:00 EST (4 hours)
 *   - London Kill Zone: 02:00 - 05:00 EST (active execution)
 *   - New York Kill Zone: 07:00 - 10:00 EST (active execution)
 *
 * Note: these windows differ from our `time.js` activeSession() (which uses
 * 19:00 start for Asia and 08:30-11:00 for the NY-AM killzone). The strategies
 * in this file use the strict ICT/SMT-spec windows.
 */

import { nyParts, nyWallToUnix } from './time.js';

const LONDON_KZ_START_MIN = 2 * 60;
const LONDON_KZ_END_MIN = 5 * 60;
const NY_KZ_START_MIN = 7 * 60;
const NY_KZ_END_MIN = 10 * 60;

/** Is `unixSeconds` inside the ICT London Kill Zone (02:00-05:00 EST, Mon-Fri)? */
export function isInLondonKZ(unixSeconds) {
  const { minutesOfDay, weekday } = nyParts(unixSeconds);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return minutesOfDay >= LONDON_KZ_START_MIN && minutesOfDay < LONDON_KZ_END_MIN;
}

/** Is `unixSeconds` inside the ICT NY Kill Zone (07:00-10:00 EST, Mon-Fri)? */
export function isInNYKZ(unixSeconds) {
  const { minutesOfDay, weekday } = nyParts(unixSeconds);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return minutesOfDay >= NY_KZ_START_MIN && minutesOfDay < NY_KZ_END_MIN;
}

/** Returns the active killzone label or null. */
export function activeKillZone(unixSeconds) {
  if (isInLondonKZ(unixSeconds)) return 'london';
  if (isInNYKZ(unixSeconds)) return 'ny';
  return null;
}

/**
 * Compute the boundaries (start/end unix seconds) of the most recent
 * COMPLETED Asian Range relative to `nowUnix`. The Asian Range that
 * "feeds" today's London/NY killzones is yesterday 20:00 EST → today 00:00 EST.
 */
export function asianRangeBounds(nowUnix) {
  const p = nyParts(nowUnix);
  // 00:00 EST of "today" (in EST wall-clock terms based on now)
  const todayMidnight = nyWallToUnix(p.y, p.m, p.d, 0, 0);
  // If we're currently BEFORE 02:00 EST, the "today" date in wall-clock is the
  // same day but the Asian range hasn't actually closed yet — back off one day.
  let endUnix = todayMidnight;
  if (p.minutesOfDay >= 20 * 60) {
    // We're in the Asian session itself; the most recent COMPLETED Asian range
    // is yesterday's. Step back one day.
    const prev = new Date((todayMidnight - 12 * 3600) * 1000); // safely inside prev day
    const pp = nyParts(prev.getTime() / 1000);
    endUnix = nyWallToUnix(pp.y, pp.m, pp.d, 0, 0);
  }
  const startUnix = endUnix - 4 * 3600;
  return { startUnix, endUnix };
}

/**
 * Compute the high/low of the most recent COMPLETED Asian Range on a 15m
 * bar array. Returns { high, low, startUnix, endUnix, barCount } or null
 * if the range can't be resolved (e.g., bar history doesn't cover it).
 */
export function asianRangeHighLow(bars, nowUnix) {
  const { startUnix, endUnix } = asianRangeBounds(nowUnix);
  let high = -Infinity, low = Infinity, count = 0;
  for (const b of bars) {
    if (b.time >= startUnix && b.time < endUnix) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      count++;
    }
  }
  if (count === 0 || !Number.isFinite(high) || !Number.isFinite(low)) return null;
  return { high, low, startUnix, endUnix, barCount: count };
}

/**
 * Previous Day High / Previous Day Low — fallback when Asian range is unavailable.
 * "Day" is NY-calendar; PDH/PDL is the prior trading day's full range.
 */
export function previousDayHighLow(bars, nowUnix) {
  const p = nyParts(nowUnix);
  const todayMidnight = nyWallToUnix(p.y, p.m, p.d, 0, 0);
  const yesterdayMidnight = todayMidnight - 24 * 3600;
  let high = -Infinity, low = Infinity, count = 0;
  for (const b of bars) {
    if (b.time >= yesterdayMidnight && b.time < todayMidnight) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      count++;
    }
  }
  if (count === 0 || !Number.isFinite(high)) return null;
  return { high, low, startUnix: yesterdayMidnight, endUnix: todayMidnight, barCount: count };
}
