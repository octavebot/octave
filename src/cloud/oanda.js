/**
 * OANDA REST adapter (free demo account, requires API token).
 *
 * Used as a fallback when Yahoo Finance fails. OANDA's free demo accounts
 * give clean, reliable OHLCV for XAU_USD and XAG_USD via the v3 candles API.
 *
 * Setup:
 *   1. Create a free OANDA account at https://www.oanda.com/demo-account/
 *   2. Generate an API token from "Manage API Access"
 *   3. Set env var OANDA_API_TOKEN (and optionally OANDA_API_BASE)
 *      - Demo: https://api-fxpractice.oanda.com   (default)
 *      - Live: https://api-fxtrade.oanda.com
 *
 * If OANDA_API_TOKEN is unset, this adapter returns null cleanly so the
 * caller can skip it without crashing.
 */

const SYMBOLS = {
  gold: 'XAU_USD',
  silver: 'XAG_USD',
  // OANDA doesn't have a free DXY instrument. Use Yahoo for DXY.
};

const GRANULARITY = {
  '1':  'M1',
  '3':  'M3',
  '5':  'M5',
  '15': 'M15',
  '30': 'M30',
  '60': 'H1',
  '240':'H4',
  '1D': 'D',
  'D':  'D',
  'W':  'W',
};

function defaultCount(g) {
  // OANDA returns up to 5000 candles per request; we cap for sanity.
  if (g === 'M1' || g === 'M3') return 500;
  if (g === 'M5' || g === 'M15') return 400;
  if (g === 'M30' || g === 'H1') return 300;
  if (g === 'H4') return 200;
  return 200;
}

export async function fetchBars(asset, tf) {
  const token = process.env.OANDA_API_TOKEN;
  if (!token) return null;
  const symbol = SYMBOLS[asset];
  const granularity = GRANULARITY[String(tf)];
  if (!symbol || !granularity) return null;
  const base = process.env.OANDA_API_BASE || 'https://api-fxpractice.oanda.com';
  const count = defaultCount(granularity);
  const url = `${base}/v3/instruments/${symbol}/candles?granularity=${granularity}&count=${count}&price=M`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`OANDA ${asset} ${tf}: HTTP ${res.status}`);
  const data = await res.json();
  const candles = data?.candles || [];
  const bars = [];
  for (const c of candles) {
    if (!c.complete && candles.length > 1 && c === candles[candles.length - 1]) {
      // Keep incomplete last candle too — strategies need the live bar
    }
    const mid = c.mid;
    if (!mid) continue;
    bars.push({
      time: Math.floor(new Date(c.time).getTime() / 1000),
      open: +mid.o, high: +mid.h, low: +mid.l, close: +mid.c,
      volume: c.volume ?? 0,
    });
  }
  return {
    symbol,
    resolution: String(tf),
    bars,
    barCount: bars.length,
    source: 'oanda',
  };
}

export async function fetchAll(requests) {
  if (!process.env.OANDA_API_TOKEN) return new Map();
  const out = new Map();
  const results = await Promise.allSettled(
    requests.map(([asset, tf]) => fetchBars(asset, tf).then((pane) => [asset, tf, pane]))
  );
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const [asset, tf, pane] = r.value;
    if (pane && pane.bars && pane.bars.length > 0) out.set(`${asset}|${tf}`, pane);
  }
  return out;
}
