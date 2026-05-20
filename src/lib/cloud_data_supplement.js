/**
 * Cloud data supplement for the LOCAL service.
 *
 * The local Mac service reads bars from TradingView Desktop via CDP. The user
 * usually has only 1-2 panes loaded (e.g. GC1! 15m), but our strategies need
 * multiple TFs (15m + 5m + 1D for Trinity, silver pane for SMT, etc.).
 *
 * This module supplements local `panesByTf` with bars fetched from Yahoo
 * Finance, so strategies see all required data even without the user manually
 * adding panes to TradingView.
 *
 * In-memory TTL cache (5 min default) avoids hammering Yahoo on a 3s loop.
 */

import { fetchAll as fetchYahoo } from '../cloud/yahoo.js';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key=`${asset}|${tf}` → { pane, fetchedAt }
let inflight = null;

/**
 * The full set of panes any enabled strategy might need.
 * Adding a new strategy that needs an extra pane? Add it here.
 */
const NEEDED_REQUESTS = [
  ['gold', '1'],
  ['gold', '5'],
  ['gold', '15'],
  ['gold', '60'],
  ['gold', '1D'],
  ['silver', '5'],
  ['silver', '15'],
  ['dxy', '1D'],
];

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) return null;
  return entry.pane;
}

function setCached(key, pane) {
  cache.set(key, { pane, fetchedAt: Date.now() });
}

/**
 * Augment a panesByTf map with cloud-fetched panes for any missing keys.
 * @param {Map<string, object>} panesByTf  existing local panes (CDP-sourced)
 * @returns {Promise<Map<string, object>>}  same Map (mutated) with supplements added
 */
export async function supplement(panesByTf) {
  // Determine which keys are missing entirely or have very few bars
  const missing = [];
  for (const [asset, tf] of NEEDED_REQUESTS) {
    const key = `${asset}|${tf}`;
    const existing = panesByTf.get(key);
    if (!existing || !existing.bars || existing.bars.length < 30) {
      missing.push([asset, tf, key]);
    }
  }
  if (missing.length === 0) return panesByTf;

  // First fill from cache
  const stillMissing = [];
  for (const [asset, tf, key] of missing) {
    const cached = getCached(key);
    if (cached) {
      // Mark as supplemented so the rest of the system knows it's not from TV
      panesByTf.set(key, { ...cached, source: 'yahoo-cache' });
    } else {
      stillMissing.push([asset, tf, key]);
    }
  }
  if (stillMissing.length === 0) return panesByTf;

  // Avoid concurrent re-fetches if multiple ticks land at once
  if (!inflight) {
    inflight = (async () => {
      try {
        const fetched = await fetchYahoo(stillMissing.map(([a, t]) => [a, t]));
        // Update cache
        for (const [key, pane] of fetched) {
          setCached(key, pane);
        }
        return fetched;
      } finally {
        inflight = null;
      }
    })();
  }
  const fetched = await inflight.catch(() => new Map());

  // Merge fetched panes into panesByTf
  for (const [asset, tf, key] of stillMissing) {
    const pane = fetched.get(`${asset}|${tf}`);
    if (pane && pane.bars && pane.bars.length > 0) {
      panesByTf.set(key, { ...pane, source: 'yahoo-supplement' });
    }
  }
  return panesByTf;
}
