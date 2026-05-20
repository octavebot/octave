/**
 * Cloud data source for the LOCAL service.
 *
 * Two modes:
 *   1. fetchAll() — PRIMARY data path. Always returns a fresh `panesByTf` Map
 *      with all the panes any enabled strategy might need, sourced from
 *      Yahoo Finance (with OANDA fallback). Cached in memory for 90s so the
 *      3s detector loop doesn't hammer Yahoo.
 *   2. supplement(panesByTf) — legacy/optional. Fills in missing keys in an
 *      existing map (e.g., if you also want to use some TV-CDP panes).
 *
 * Why cloud-primary: the user's TradingView chart layout shouldn't constrain
 * which strategies can run. Yahoo gives us everything (gold 1m/5m/15m/60m/1D
 * + silver 5m/15m + DXY 1D). Strategies that need silver or daily MACD work
 * even if the user only has GC1! 15m loaded — or no chart at all.
 *
 * TTL math: 90s × 8 panes ≈ 320 Yahoo requests/hour. Well under Yahoo's
 * unofficial ~2000/hour throttle. Tunable via OCTAVE_DATA_TTL_MS env var.
 */

import { fetchAll as fetchYahoo } from '../cloud/yahoo.js';

// 60s is a compromise: fresh enough for 5m+ strategies, well under Yahoo's
// unofficial ~2000/hour rate limit (8 panes × 60/hr = 480 req/hr).
// Lower this (e.g. to 20s) if you need fresher 1m bars and accept higher risk.
const TTL_MS = parseInt(process.env.OCTAVE_DATA_TTL_MS || '', 10) || 60 * 1000;

const NEEDED_REQUESTS = [
  ['gold',   '1'],
  ['gold',   '5'],
  ['gold',   '15'],
  ['gold',   '60'],
  ['gold',   '1D'],
  ['silver', '5'],
  ['silver', '15'],
  ['dxy',    '1D'],
];

// Single in-memory cache for the full fetch
let fullCache = { panes: null, fetchedAt: 0 };
// Per-key cache (kept for legacy supplement() callers)
const perKeyCache = new Map();
let inflightFull = null;

function shouldFetch(at) { return !at || (Date.now() - at) > TTL_MS; }

/**
 * Primary data accessor: returns the full `panesByTf` Map fresh from Yahoo
 * (with OANDA fallback for any pane Yahoo missed).
 *
 * Cached for TTL_MS so successive calls from the 3s detector loop are
 * essentially free. The first call after expiry blocks until Yahoo responds
 * (~300-800ms), all callers awaiting that block share the same inflight
 * promise so we only fetch once.
 */
export async function fetchAllPanes() {
  if (!shouldFetch(fullCache.fetchedAt) && fullCache.panes) {
    return new Map(fullCache.panes); // return a fresh copy so callers can mutate freely
  }
  if (inflightFull) return inflightFull.then((m) => new Map(m));
  inflightFull = (async () => {
    try {
      // Note: yahoo.fetchAll handles the per-symbol HTTP errors via Promise.allSettled,
      // so partial responses still produce a useful Map.
      const panes = await fetchYahoo(NEEDED_REQUESTS).catch(() => new Map());
      // Tag the panes so downstream code can tell where bars came from
      for (const [, p] of panes) p.source = p.source || 'yahoo';
      // Update both caches
      fullCache = { panes, fetchedAt: Date.now() };
      for (const [k, p] of panes) perKeyCache.set(k, { pane: p, fetchedAt: Date.now() });
      return panes;
    } finally {
      inflightFull = null;
    }
  })();
  return inflightFull.then((m) => new Map(m));
}

/**
 * Legacy: augment an existing panesByTf (from e.g. TV CDP) with cloud data
 * for any keys that are missing or under-populated.
 *
 * Kept for backward compat. Most callers should use fetchAllPanes() instead.
 */
export async function supplement(panesByTf) {
  const missing = [];
  for (const [asset, tf] of NEEDED_REQUESTS) {
    const key = `${asset}|${tf}`;
    const existing = panesByTf.get(key);
    if (!existing || !existing.bars || existing.bars.length < 30) {
      missing.push([asset, tf, key]);
    }
  }
  if (missing.length === 0) return panesByTf;

  // First fill from per-key cache
  const stillMissing = [];
  for (const [asset, tf, key] of missing) {
    const entry = perKeyCache.get(key);
    if (entry && !shouldFetch(entry.fetchedAt)) {
      panesByTf.set(key, { ...entry.pane, source: 'yahoo-cache' });
    } else {
      stillMissing.push([asset, tf, key]);
    }
  }
  if (stillMissing.length === 0) return panesByTf;

  // Fetch the missing ones from Yahoo
  const fetched = await fetchYahoo(stillMissing.map(([a, t]) => [a, t])).catch(() => new Map());
  const now = Date.now();
  for (const [key, pane] of fetched) perKeyCache.set(key, { pane, fetchedAt: now });
  for (const [asset, tf, key] of stillMissing) {
    const pane = fetched.get(`${asset}|${tf}`);
    if (pane?.bars?.length > 0) panesByTf.set(key, { ...pane, source: 'yahoo-supplement' });
  }
  return panesByTf;
}

/** Stats for /status etc. */
export function cacheStats() {
  return {
    ttl_ms: TTL_MS,
    full_age_ms: fullCache.fetchedAt ? Date.now() - fullCache.fetchedAt : null,
    full_pane_count: fullCache.panes ? fullCache.panes.size : 0,
    inflight: inflightFull != null,
  };
}
