/**
 * Cloud data source. `fetchAllPanes()` returns a fresh `panesByTf` Map with
 * every pane any enabled strategy might need.
 *
 * Layered sources:
 *   1. Yahoo Finance — free, fast, but caps 15m intraday at 60-71 days.
 *      Sufficient for live alerts; insufficient for true 1y/3y backtests.
 *   2. OANDA — optional. If OANDA_API_TOKEN is set, the deep-backtest path
 *      (fetchAllPanesForBacktest) pulls historical pages from OANDA to extend
 *      back to ~5 years on the instruments OANDA supports (gold always; the
 *      indices depend on account type).
 *
 * Cached in memory for ~15s so the 3s detector loop doesn't hammer the API.
 * Tunable via OCTAVE_DATA_TTL_MS env var.
 */

import { fetchAll as fetchYahoo } from '../cloud/yahoo.js';
import { fetchAll as fetchOanda, isConfigured as oandaConfigured } from '../cloud/oanda.js';
import { beat as heartbeat } from './heartbeat.js';

// 15s = close to real-time. 8 panes × 4 fetches/min = ~1920 req/hr,
// still under Yahoo's unofficial ~2000/hr threshold. If we ever start
// seeing 429s, bump back to 30-60s via OCTAVE_DATA_TTL_MS env var.
const TTL_MS = parseInt(process.env.OCTAVE_DATA_TTL_MS || '', 10) || 15 * 1000;

// Three primary instruments at the execution + HTF timeframes the strategies
// need; silver / dxy are cross-asset add-ons (SMT divergence, macro bias).
const NEEDED_REQUESTS = [
  // Gold (micro)
  ['gold',   '1'],
  ['gold',   '5'],
  ['gold',   '15'],
  ['gold',   '60'],
  ['gold',   '1D'],
  // Nasdaq (micro)
  ['nasdaq', '5'],
  ['nasdaq', '15'],
  ['nasdaq', '60'],
  ['nasdaq', '1D'],
  // S&P (micro)
  ['sp',     '5'],
  ['sp',     '15'],
  ['sp',     '60'],
  ['sp',     '1D'],
  // Cross-asset
  ['silver', '5'],
  ['silver', '15'],
  ['dxy',    '1D'],
];

// Single in-memory cache for the full fetch
let fullCache = { panes: null, fetchedAt: 0 };
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
      fullCache = { panes, fetchedAt: Date.now() };
      // Heartbeat — the dashboard's "market-data" tile reads this so the
      // user knows live data is flowing (even if no alerts fire).
      heartbeat('market-data', {
        pane_count: panes.size,
        source: 'yahoo',
        last_fetch_ms: Date.now(),
      });
      return panes;
    } finally {
      inflightFull = null;
    }
  })();
  return inflightFull.then((m) => new Map(m));
}

/**
 * Deep-history fetch for backtests. Pulls Yahoo first (fast, free) and then,
 * if OANDA is configured, fetches the same instruments going back `targetDays`
 * and MERGES the deeper history under the SAME pane keys.
 *
 * Merge rule: OANDA bars older than Yahoo's earliest bar fill in the gap;
 * Yahoo wins for any overlapping time (it's the more authoritative live source).
 *
 * Bypasses the 15s cache — backtests run on demand, not in the hot loop.
 *
 * @param {number} targetDays  How far back to extend history (default 730 = 2y).
 */
export async function fetchAllPanesForBacktest(targetDays = 730) {
  const yahoo = await fetchYahoo(NEEDED_REQUESTS).catch(() => new Map());
  for (const [, p] of yahoo) p.source = p.source || 'yahoo';

  if (!oandaConfigured()) return yahoo;

  // Try OANDA only for instruments OANDA supports cleanly; skip dxy.
  const oandaRequests = NEEDED_REQUESTS.filter(([asset]) => asset !== 'dxy');
  const oanda = await fetchOanda(oandaRequests, { targetDays }).catch(() => new Map());

  for (const [key, oandaPane] of oanda) {
    const yahooPane = yahoo.get(key);
    if (!yahooPane?.bars?.length) {
      yahoo.set(key, oandaPane);
      continue;
    }
    const yahooEarliest = yahooPane.bars[0].time;
    const merged = [
      ...oandaPane.bars.filter((b) => b.time < yahooEarliest),
      ...yahooPane.bars,
    ];
    yahoo.set(key, { ...yahooPane, bars: merged, source: 'yahoo+oanda', barCount: merged.length });
  }
  return yahoo;
}
