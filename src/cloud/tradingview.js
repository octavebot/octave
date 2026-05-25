/**
 * TradingView (via bridge) OHLCV adapter — real-time CME futures via the
 * user's TradingView Desktop running on an always-on Mac.
 *
 * Architecture: a small Node bridge on the Mac reads bars from local TV via
 * the Chrome DevTools Protocol (port 9222) and POSTs them to the VPS every
 * ~3 seconds. This module reads from the in-memory cache populated by
 * `lib/tv_ingest.js` and exposes the same `fetchBars(asset,tf)` /
 * `fetchAll(requests)` shape Yahoo and Databento use, so `cloud_data_supplement`
 * can route the live signal path here behind a `DATA_SOURCE=tradingview` flag.
 *
 * Coverage: the traded micros (gold/nasdaq). Silver/dxy aren't on
 * TV by default and aren't used by any strategy anyway — those stay on Yahoo
 * via cloud_data_supplement's existing fallback layering.
 *
 * Freshness: tv_ingest tags every pane with `lastPushAt`; a pane older than
 * the FRESH_WINDOW (60s) returns null so the caller falls back to Yahoo. This
 * is what stops a Mac/wifi outage from blinding the bot — bot degrades to
 * Yahoo-delayed instead of going dark.
 */

import { getPane, status as ingestStatus } from '../lib/tv_ingest.js';

const INSTRUMENTS = new Set(['gold', 'nasdaq']);

/**
 * Fetch OHLCV bars for a single asset+timeframe from the bridge cache.
 * @param {'gold'|'nasdaq'} asset
 * @param {string} tf  internal TF key ('5','15','60' etc.)
 * @returns {Promise<null|{symbol,resolution,bars,barCount,source}>}
 *   null if no fresh bars yet — caller falls back to Yahoo.
 */
export async function fetchBars(asset, tf) {
  if (!INSTRUMENTS.has(asset)) return null;
  const pane = getPane(asset, String(tf));
  if (!pane) return null;
  return {
    symbol: pane.symbol,
    resolution: pane.resolution,
    bars: pane.bars,
    barCount: pane.bars.length,
    source: 'tradingview',
  };
}

/**
 * Fetch a list of (asset, tf) tuples in parallel.
 * @param {Array<[string, string]>} requests
 * @returns {Promise<Map<string, object>>}  `${asset}|${tf}` -> pane
 */
export async function fetchAll(requests) {
  const out = new Map();
  await Promise.all(requests.map(async ([asset, tf]) => {
    const pane = await fetchBars(asset, tf);
    if (pane?.bars?.length) out.set(`${asset}|${tf}`, pane);
  }));
  return out;
}

/** True if any fresh pane is in the cache right now. */
export function isConfigured() {
  if (process.env.DATA_SOURCE !== 'tradingview') return false;
  return ingestStatus().anyFresh;
}
