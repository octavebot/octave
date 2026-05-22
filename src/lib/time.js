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
  // NY lunch / dead zone: 10:00 -> 13:00 (per USLS doc)
  if (minutesOfDay >= 10 * 60 && minutesOfDay < 13 * 60) return 'lunch';
  // NY PM: 13:00 -> 16:00
  if (minutesOfDay >= 13 * 60 && minutesOfDay < 16 * 60) return 'ny_pm';
  // 16:00 -> 19:00 = off
  return 'off';
}

/**
 * Trinity Model execution window: 9:30–11:00 AM EST (per Rule #2).
 */
export function isInTrinityWindow(unixSeconds) {
  const { minutesOfDay, weekday } = nyParts(unixSeconds);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return minutesOfDay >= 9 * 60 + 30 && minutesOfDay < 11 * 60;
}

/**
 * NY AM Killzone window: 8:30–11:00 EST, plus the ICT macro windows
 * (9:50–10:10 and 10:50–11:10).
 */
export function killzoneStatus(unixSeconds) {
  const { minutesOfDay, weekday } = nyParts(unixSeconds);
  if (weekday === 'Sat' || weekday === 'Sun') return { inKillzone: false, inMacro: false };
  const inMacro1 = minutesOfDay >= 9 * 60 + 50 && minutesOfDay < 10 * 60 + 10;
  const inMacro2 = minutesOfDay >= 10 * 60 + 50 && minutesOfDay < 11 * 60 + 10;
  return {
    inKillzone: minutesOfDay >= 8 * 60 + 30 && minutesOfDay < 11 * 60,
    inMacro: inMacro1 || inMacro2,
    macroLabel: inMacro1 ? 'macro1' : inMacro2 ? 'macro2' : null,
  };
}

/**
 * Categorize a bar's session by its bar-open timestamp.
 * Returns null for bars outside any defined session.
 */
export function barSession(bar) {
  const s = activeSession(bar.time);
  if (s === 'off' || s === 'lunch') return null;
  return s;
}

/**
 * Bucket key for grouping bars by "session date" — the calendar date
 * the session BEGAN on (in EST). Asia crosses midnight so its bucket key
 * is the start-date.
 *
 * Returns e.g. { session: 'asia', dateKey: '2026-05-18' }
 */
export function sessionBucket(bar) {
  const s = barSession(bar);
  if (!s) return null;
  const p = nyParts(bar.time);
  // Asia "before 02:00 EST" rolls back one day for bucket purposes
  if (s === 'asia' && p.minutesOfDay < 2 * 60) {
    // Subtract one day from the EST date
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d) - 86400000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return { session: s, dateKey: `${y}-${m}-${day}` };
  }
  return { session: s, dateKey: p.dateKey };
}

/**
 * Convert a NY wall-clock (y, m, d, hour, minute in EST/EDT) into unix seconds,
 * accounting for daylight saving. Used by Strategy #5/#6 to lock the Asian
 * range boundaries (20:00 → 00:00 EST) precisely.
 */
export function nyWallToUnix(y, m, d, hour, minute) {
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

/**
 * GMT wall-clock components for a unix-seconds timestamp.
 * Used by strategies that define their windows in GMT (e.g. Asian Range
 * Breakout uses 00:00-06:00 GMT, London open 07:00 GMT).
 */
export function gmtParts(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    min: d.getUTCMinutes(),
    minutesOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dateKey: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
  };
}

/**
 * Build a GMT wall-clock unix timestamp from components.
 */
export function gmtWallToUnix(y, m, d, hour, minute) {
  return Math.floor(Date.UTC(y, m - 1, d, hour, minute, 0) / 1000);
}

/**
 * Asian session window in GMT (00:00-06:00 GMT). Returns the start/end
 * unix-seconds for the asian session of the current calendar day in GMT.
 */
export function gmtAsianWindow(unixSeconds) {
  const p = gmtParts(unixSeconds);
  const start = gmtWallToUnix(p.y, p.m, p.d, 0, 0);
  const end = gmtWallToUnix(p.y, p.m, p.d, 6, 0);
  return { start, end };
}

/**
 * London session window in GMT (07:00-12:00 GMT). Strategy 1 (Gemini) caps
 * London at 11:00 LONDON time (which == 11:00 GMT in winter / 10:00 GMT in DST);
 * Strategy 1 (ChatGPT) uses 8:00-11:00 London time. We keep a generous window
 * 07:00-12:00 GMT to cover both; each strategy can further gate inside that.
 */
export function gmtLondonWindow(unixSeconds) {
  const p = gmtParts(unixSeconds);
  const start = gmtWallToUnix(p.y, p.m, p.d, 7, 0);
  const end = gmtWallToUnix(p.y, p.m, p.d, 12, 0);
  return { start, end };
}

/** NY session start in NY-local time (09:30 EST, i.e. 13:30/14:30 GMT). */
export function nyOpenUnix(unixSeconds) {
  const p = nyParts(unixSeconds);
  return nyWallToUnix(p.y, p.m, p.d, 9, 30);
}
