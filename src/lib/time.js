/**
 * Time utilities — convert unix timestamps to America/New_York (EST/EDT)
 * and identify active session windows.
 *
 * EST handling: Intl.DateTimeFormat with timeZone:'America/New_York'
 * correctly applies DST. Sessions are defined in wall-clock EST.
 */

/**
 * Decompose a unix-seconds timestamp into NY wall-clock parts.
 */
export function nyParts(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const map = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const hour = +map.hour;
  const minute = +map.minute;
  return {
    y: +map.year,
    m: +map.month,
    d: +map.day,
    h: hour,
    min: minute,
    s: +map.second,
    weekday: map.weekday,           // 'Mon' 'Tue' ...
    minutesOfDay: hour * 60 + minute, // 0..1439
    dateKey: `${map.year}-${map.month}-${map.day}`,
  };
}

/**
 * Is the gold market open? Returns false during the weekend close
 * (Fri 17:00 EST → Sun 18:00 EST). All weekday hours are "open."
 */
export function isMarketOpen(unixSeconds) {
  const { minutesOfDay, weekday } = nyParts(unixSeconds);
  if (weekday === 'Sat') return false;
  if (weekday === 'Sun' && minutesOfDay < 18 * 60) return false;
  if (weekday === 'Fri' && minutesOfDay >= 17 * 60) return false;
  return true;
}

/**
 * Which trading session contains this timestamp?
 * Returns one of: 'asia' | 'london' | 'ny_am' | 'ny_pm' | 'lunch' | 'off'
 * (sessions are defined in NY wall-clock per the strategy docs)
 */
export function activeSession(unixSeconds) {
  const { minutesOfDay, weekday } = nyParts(unixSeconds);
  // Weekend exclusion (Sat all day, Sun before 18:00 EST)
  if (weekday === 'Sat') return 'off';
  if (weekday === 'Sun' && minutesOfDay < 18 * 60) return 'off';
  if (weekday === 'Fri' && minutesOfDay >= 17 * 60) return 'off';

  // Asia: 19:00 prev day -> 02:00 current
  if (minutesOfDay >= 19 * 60 || minutesOfDay < 2 * 60) return 'asia';
  // London: 02:00 -> 05:00
  if (minutesOfDay >= 2 * 60 && minutesOfDay < 5 * 60) return 'london';
  // Pre-NY gap: 05:00 -> 07:00
  if (minutesOfDay >= 5 * 60 && minutesOfDay < 7 * 60) return 'off';
  // NY AM: 07:00 -> 10:00
  if (minutesOfDay >= 7 * 60 && minutesOfDay < 10 * 60) return 'ny_am';
  // NY lunch / dead zone: 10:00 -> 13:00
  if (minutesOfDay >= 10 * 60 && minutesOfDay < 13 * 60) return 'lunch';
  // NY PM: 13:00 -> 16:00
  if (minutesOfDay >= 13 * 60 && minutesOfDay < 16 * 60) return 'ny_pm';
  // 16:00 -> 19:00 = off
  return 'off';
}

/**
 * Convert a NY wall-clock (y, m, d, hour, minute in EST/EDT) into unix seconds,
 * accounting for daylight saving. Used by nyDayStartUnix() for session anchors.
 */
function nyWallToUnix(y, m, d, hour, minute) {
  const fakeUtc = Date.UTC(y, m - 1, d, hour, minute, 0);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(fakeUtc)).map((p) => [p.type, p.value])
  );
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, 0);
  const offsetMs = fakeUtc - shown;
  return Math.floor((fakeUtc + offsetMs) / 1000);
}

/**
 * Format a unix-seconds timestamp as NY-clock string for log/alert use.
 */
export function fmtNY(unixSeconds) {
  const p = nyParts(unixSeconds);
  return `${p.weekday} ${p.dateKey} ${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')} EST`;
}

/**
 * Get NY date parts for a unix-seconds timestamp at a specific NY wall hour.
 * Returns the unix-seconds of that NY wall time on the same calendar day.
 * Used by strategies that anchor to GMT or NY session boundaries.
 */
export function nyDayStartUnix(unixSeconds) {
  const p = nyParts(unixSeconds);
  return nyWallToUnix(p.y, p.m, p.d, 0, 0);
}
