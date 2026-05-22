/**
 * News blackout helper + ForexFactory auto-fetch.
 *
 * Two sources merged:
 *   1. ~/trading-alerts/data/news.json — user-maintained (hot-reloaded).
 *   2. ForexFactory weekly calendar (https://nfs.faireconomy.media/ff_calendar_thisweek.json)
 *      — auto-fetched every 30 min, USD high-impact events only, mostly the
 *      ones that move gold (NFP, CPI, PPI, FOMC, Powell, Retail Sales, etc.).
 *
 * Strategies should call `checkBlackout()` before firing — returns true when
 * we're within ±30 minutes of any high-impact USD event from either source.
 */

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const NEWS_FILE = join(__dirname, '..', '..', 'data', 'news.json');
const FF_CACHE = join(__dirname, '..', 'state', 'news-ff-cache.json');

let cache = { mtime: 0, events: [] };
let ffCache = { fetchedAt: 0, events: [] };

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const FF_TTL_MS = 30 * 60 * 1000; // 30 min — calendar is weekly, no need to hammer
const HIGH_IMPACT_KEYWORDS = [
  'nfp', 'non-farm', 'cpi', 'ppi', 'fomc', 'powell', 'retail sales',
  'unemployment', 'jobless', 'gdp', 'fed', 'rate decision', 'core pce',
  'ism', 'jolts', 'pce', 'consumer confidence', 'durable goods',
];

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

/** Load the persisted ForexFactory cache on startup, if any. */
function loadFfCache() {
  if (!existsSync(FF_CACHE)) return;
  try {
    const raw = JSON.parse(readFileSync(FF_CACHE, 'utf8'));
    if (raw?.events) ffCache = { fetchedAt: raw.fetchedAt || 0, events: raw.events };
  } catch {}
}
loadFfCache();

function saveFfCache() {
  try {
    mkdirSync(dirname(FF_CACHE), { recursive: true });
    writeFileSync(FF_CACHE, JSON.stringify(ffCache, null, 2));
  } catch {}
}

/**
 * Fetch the weekly ForexFactory calendar, filter to USD high-impact events
 * (the ones that move gold), and merge into the in-memory cache. Cached to
 * disk so a restart doesn't lose the calendar.
 */
export async function refreshForexFactory(force = false) {
  if (!force && Date.now() - ffCache.fetchedAt < FF_TTL_MS) return ffCache.events;
  try {
    const res = await fetch(FF_URL, { headers: { 'User-Agent': 'OctaveBot/1.0' } });
    if (!res.ok) return ffCache.events;
    const data = await res.json();
    if (!Array.isArray(data)) return ffCache.events;
    const events = [];
    for (const ev of data) {
      if (!ev?.date || !ev?.title) continue;
      const country = (ev.country || '').toUpperCase();
      if (country !== 'USD' && country !== 'US') continue;
      const impact = (ev.impact || '').toLowerCase();
      const titleLc = String(ev.title).toLowerCase();
      const keywordHit = HIGH_IMPACT_KEYWORDS.some((kw) => titleLc.includes(kw));
      // Keep low / medium / high so the calendar can show the full
      // yellow/orange/red folder system. Holiday + non-economic rows dropped.
      // A keyword hit (NFP, CPI, FOMC…) is forced to high even if FF mislabels it.
      let level = ['high', 'medium', 'low'].includes(impact) ? impact : null;
      if (keywordHit) level = 'high';
      if (!level) continue;
      // ForexFactory date is ISO with timezone offset, e.g. "2026-05-22T08:30:00-04:00"
      const unix = Math.floor(new Date(ev.date).getTime() / 1000);
      if (!Number.isFinite(unix)) continue;
      events.push({
        title: ev.title,
        impact: level,
        source: 'forexfactory',
        unix,
        date: ev.date.slice(0, 10),
        time: ev.date.slice(11, 16),
      });
    }
    ffCache = { fetchedAt: Date.now(), events };
    saveFfCache();
  } catch {
    /* network failure — keep stale cache */
  }
  return ffCache.events;
}

// Kick off a background refresh on import so the cache populates immediately.
// Failures are swallowed by refreshForexFactory.
refreshForexFactory().catch(() => {});
// And schedule periodic re-fetches.
setInterval(() => refreshForexFactory().catch(() => {}), FF_TTL_MS).unref?.();

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

/** Combined event stream (manual JSON + ForexFactory cache) — all impacts. */
function allEvents() {
  reload();
  const out = [];
  for (const ev of cache.events) {
    const t = eventTime(ev);
    if (!t) continue;
    out.push({ ...ev, impact: (ev.impact || 'high').toLowerCase(), unix: t, source: ev.source || 'manual' });
  }
  for (const ev of ffCache.events) {
    if (Number.isFinite(ev.unix)) out.push({ ...ev, impact: (ev.impact || 'high').toLowerCase() });
  }
  return out;
}

/** High-impact subset — the only events that gate the trading blackout. */
function allHighImpactEvents() {
  return allEvents().filter((ev) => ev.impact === 'high');
}

/**
 * Is the current moment within ±windowMinutes of any high-impact event?
 * @returns {{ blocked: boolean, event: object|null, minutesAway: number|null }}
 */
export function checkBlackout(nowUnix = Date.now() / 1000, windowMinutes = 30) {
  let nearest = null;
  let nearestMin = Infinity;
  for (const ev of allHighImpactEvents()) {
    const diffMin = Math.abs(ev.unix - nowUnix) / 60;
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

/**
 * Upcoming events in the next `hoursAhead` hours — ALL impact levels, each
 * carrying its `impact` ('high'|'medium'|'low') for the folder-colour display.
 */
export function upcomingEvents(nowUnix = Date.now() / 1000, hoursAhead = 24) {
  const cutoff = nowUnix + hoursAhead * 3600;
  return allEvents()
    .filter((ev) => ev.unix >= nowUnix && ev.unix <= cutoff)
    .sort((a, b) => a.unix - b.unix);
}

/** Next upcoming HIGH-impact event (or null), with minutesAway. */
export function nextEvent(nowUnix = Date.now() / 1000) {
  const up = upcomingEvents(nowUnix, 7 * 24).filter((ev) => ev.impact === 'high');
  if (up.length === 0) return null;
  const ev = up[0];
  return { ...ev, minutesAway: Math.round((ev.unix - nowUnix) / 60) };
}
