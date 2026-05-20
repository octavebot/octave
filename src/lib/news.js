/**
 * News blackout helper.
 *
 * Reads ~/trading-alerts/data/news.json. Strategies should check
 * `isBlackedOut(now)` before firing setups.
 *
 * Window per strategy docs: ±30 minutes around any 'high' impact event.
 * High-impact items for gold: NFP, CPI, PPI, FOMC, Retail Sales, Fed speakers.
 *
 * The JSON file is hot-reloaded once per minute so the user can edit it
 * without restarting the service.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const NEWS_FILE = join(__dirname, '..', '..', 'data', 'news.json');

let cache = { mtime: 0, events: [] };

function reload() {
  if (!existsSync(NEWS_FILE)) {
    cache = { mtime: 0, events: [] };
    return;
  }
  try {
    const stat = statSync(NEWS_FILE);
    if (stat.mtimeMs === cache.mtime) return;
    const raw = JSON.parse(readFileSync(NEWS_FILE, 'utf8'));
    const events = Array.isArray(raw.events) ? raw.events : [];
    cache = { mtime: stat.mtimeMs, events };
  } catch {
    /* swallow; keep old cache */
  }
}

/** Resolve a news event entry into a unix-seconds timestamp. */
function eventTime(ev) {
  if (!ev?.date || !ev?.time) return null;
  // Treat tz as America/New_York for safety, even if missing.
  // Construct local date string then re-parse into NY-tz time.
  // Easiest method: build an ISO-without-zone, derive NY offset using Intl.
  const [y, m, d] = ev.date.split('-').map(Number);
  const [hh, mm] = ev.time.split(':').map(Number);
  if (![y, m, d, hh, mm].every(Number.isFinite)) return null;
  // Compute UTC seconds for the wall time in NY:
  // 1) Make a "fake-UTC" date matching the wall components
  const fakeUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
  // 2) Format that instant in NY tz to learn what wall it represents (this works because
  //    the difference between fakeUtc and the actual NY wall is the tz offset we need to subtract).
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(fakeUtc)).map((p) => [p.type, p.value]));
  const nyDate = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, 0));
  const offset = fakeUtc - nyDate.getTime();
  return Math.floor((fakeUtc + offset) / 1000);
}

/**
 * Is the current moment within ±windowMinutes of any high-impact event?
 * @returns {{ blocked: boolean, event: object|null, minutesAway: number|null }}
 */
export function checkBlackout(nowUnix = Date.now() / 1000, windowMinutes = 30) {
  reload();
  let nearest = null;
  let nearestMin = Infinity;
  for (const ev of cache.events) {
    if (ev.impact !== 'high') continue;
    const t = eventTime(ev);
    if (!t) continue;
    const diffMin = Math.abs(t - nowUnix) / 60;
    if (diffMin < nearestMin) {
      nearestMin = diffMin;
      nearest = ev;
    }
  }
  const blocked = nearest && nearestMin <= windowMinutes;
  return {
    blocked: !!blocked,
    event: blocked ? nearest : null,
    minutesAway: nearest ? Math.round(nearestMin) : null,
  };
}

/** Return all upcoming high-impact events in the next `hoursAhead` hours. */
export function upcomingEvents(nowUnix = Date.now() / 1000, hoursAhead = 24) {
  reload();
  const cutoff = nowUnix + hoursAhead * 3600;
  return cache.events
    .map((ev) => ({ ev, t: eventTime(ev) }))
    .filter(({ t }) => t != null && t >= nowUnix && t <= cutoff)
    .sort((a, b) => a.t - b.t)
    .map(({ ev, t }) => ({ ...ev, unix: t }));
}
