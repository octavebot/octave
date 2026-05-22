/**
 * Yahoo Finance OHLCV adapter (free, no API key).
 *
 * Maps our internal "gold|<tf>" / "silver|<tf>" keys to Yahoo's chart endpoint.
 * Returns bars in the same shape as the MCP CDP adapter (panes.js).
 *
 * Limits:
 *   - intraday bars (1m, 5m, 15m, 30m, 60m): up to ~7 days history
 *   - daily/weekly: years of history
 *   - personal use OK; commercial restricted by Yahoo TOS
 */

// Yahoo symbol map for our internal asset keys.
// All three primary instruments use micro futures (matches what retail traders
// run on TopstepX / Apex / Lucid prop accounts and keeps tick math consistent
// with the user's TradingView charts).
const SYMBOLS = {
  gold:    'MGC=F',    // Micro Gold futures      → COMEX:MGC1!
  nasdaq:  'MNQ=F',    // Micro Nasdaq-100 E-mini → CME_MINI:MNQ1!
  sp:      'MES=F',    // Micro S&P 500 E-mini    → CME_MINI:MES1!
  silver:  'SI=F',     // Silver futures          → COMEX:SI1!  (cross-asset for SMT)
  dxy:     'DX-Y.NYB', // US Dollar Index         → TVC:DXY     (macro bias)
};

// Yahoo interval map for our internal timeframe keys
const INTERVAL = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '30': '30m',
  '60': '60m',
  '240': '4h',     // Yahoo doesn't have 4h native; will skip and resample if needed later
  '1D': '1d',
  'D': '1d',
  'W': '1wk',
};

// Bar duration in seconds per timeframe key — used to detect and drop the
// still-forming final bar.
const TF_SECONDS = {
  '1': 60, '5': 300, '15': 900, '30': 1800, '60': 3600,
  '240': 14400, '1D': 86400, 'D': 86400, 'W': 604800,
};

// Yahoo intraday lookback caps:
//   1m: 7 days max
//   5m / 15m / 30m: 60 days max
//   60m: 730 days max
// We pull as much history as Yahoo allows so backtests have meaningful samples.
// For live alerting the bar set is updated each tick; only the tail matters.
const RANGE = {
  '1m':  '7d',
  '5m':  '60d',
  '15m': '60d',
  '30m': '60d',
  '60m': '2y',
  '4h':  '2y',
  '1d':  '2y',
  '1wk': '5y',
};

/**
 * Fetch OHLCV bars from Yahoo for a single asset+timeframe.
 * @param {'gold'|'silver'|'dxy'} asset
 * @param {string} tf  internal TF key ('1','5','15','60','1D' etc.)
 * @returns {Promise<null|{symbol:string,resolution:string,bars:Array}>}
 */
export async function fetchBars(asset, tf) {
  const symbol = SYMBOLS[asset];
  const interval = INTERVAL[String(tf)];
  if (!symbol || !interval) return null;
  const range = RANGE[interval] || '5d';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 OctaveBot' } });
  if (!res.ok) throw new Error(`Yahoo ${asset} ${tf}: HTTP ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${asset} ${tf}: no result`);
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    bars.push({ time: ts[i], open: +o, high: +h, low: +l, close: +c, volume: v ?? 0 });
  }
  // Drop the final bar if it is still in progress. Yahoo includes the current
  // unfinished period; strategies and the backtest must only ever see CLOSED
  // candles, or live alerting fires on a half-formed bar whose high/low/close
  // keep moving — premature signals that diverge from backtested behaviour.
  const intervalSec = TF_SECONDS[String(tf)];
  if (intervalSec && bars.length) {
    const lastOpen = bars[bars.length - 1].time;
    if (lastOpen + intervalSec > Date.now() / 1000) bars.pop();
  }
  return {
    symbol,
    resolution: String(tf),
    bars,
    barCount: bars.length,
    source: 'yahoo',
  };
}

/**
 * Convenience: fetch a list of (asset, tf) tuples in parallel.
 * @param {Array<['gold'|'silver'|'dxy', string]>} requests
 * @returns {Promise<Map<string, object>>}  map of `${asset}|${tf}` -> pane
 */
export async function fetchAll(requests) {
  const out = new Map();
  const results = await Promise.allSettled(
    requests.map(([asset, tf]) => fetchBars(asset, tf).then((pane) => [asset, tf, pane]))
  );
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const [asset, tf, pane] = r.value;
    if (pane && pane.bars && pane.bars.length > 0) {
      out.set(`${asset}|${tf}`, pane);
    }
  }
  return out;
}
