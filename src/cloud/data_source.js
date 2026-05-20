/**
 * Unified data source: Yahoo Finance primary, OANDA fallback.
 *
 * Returns a `panesByTf` Map keyed the same way the local CDP adapter does
 * (e.g. `gold|15`, `silver|15`, `dxy|1D`), so all existing strategy code
 * runs unchanged against either data source.
 */

import * as yahoo from './yahoo.js';
import * as oanda from './oanda.js';

// Default request set for the active strategies (#5 ICT, #6 SMT, #7 Trinity).
// Each strategy declares what it needs in its source; this is the union.
//
//   #5 ICT  : gold|15
//   #6 SMT  : gold|15, silver|15
//   #7 TRINITY: gold|15, gold|1 (or 3 or 5), silver|any, gold|1D (narrative)
//
// Yahoo doesn't have a 3m granularity; we'll use 1m for LTF and 15m for the rest.
const DEFAULT_REQUESTS = [
  ['gold', '1'],
  ['gold', '5'],
  ['gold', '15'],
  ['gold', '60'],
  ['gold', '1D'],
  ['silver', '5'],
  ['silver', '15'],
  ['dxy', '1D'],
];

/**
 * Fetch all required bars, merging Yahoo (primary) with OANDA (fallback for
 * any pane Yahoo failed to deliver). Returns `panesByTf` Map.
 */
export async function fetchPanesByTf(requests = DEFAULT_REQUESTS) {
  // 1. Try Yahoo for everything
  const yahooMap = await yahoo.fetchAll(requests).catch(() => new Map());

  // 2. Find missing panes; fall back to OANDA where Yahoo didn't deliver.
  //    OANDA only covers gold/silver (no DXY) so it's bounded.
  const missing = requests.filter(([asset, tf]) => !yahooMap.has(`${asset}|${tf}`));
  if (missing.length > 0) {
    const oandaMap = await oanda.fetchAll(missing).catch(() => new Map());
    for (const [key, pane] of oandaMap) yahooMap.set(key, pane);
  }

  return yahooMap;
}

/**
 * Build a detector ctx in the same shape buildCtx() produces locally.
 * Anchor pane: prefer gold|5, fall back through TFs as available.
 */
export async function buildCloudCtx() {
  const panesByTf = await fetchPanesByTf();
  if (panesByTf.size === 0) {
    throw new Error('No cloud data source returned any bars (Yahoo + OANDA both empty)');
  }
  // Pick an anchor: prefer 5m gold > 15m > 1m > 60m > 1D
  let anchor =
    panesByTf.get('gold|5') ||
    panesByTf.get('gold|15') ||
    panesByTf.get('gold|1') ||
    panesByTf.get('gold|60') ||
    panesByTf.get('gold|1D');
  if (!anchor) {
    for (const [k, p] of panesByTf) {
      if (k.startsWith('gold|')) { anchor = p; break; }
    }
  }
  if (!anchor) throw new Error('No gold pane available from cloud data sources');

  const lastBar = anchor.bars[anchor.bars.length - 1];
  // Mirror the detector.js dateKey convention (NY date of the anchor's last bar)
  const { nyParts } = await import('../lib/time.js');
  const np = nyParts(lastBar.time);

  return {
    ts: Date.now(),
    barTime: lastBar.time,
    lastClose: lastBar.close,
    panes: [...panesByTf.values()],
    panesByTf,
    anchorSymbol: anchor.symbol,
    anchorResolution: anchor.resolution,
    dateKey: np.dateKey,
    source: 'cloud',
  };
}
