/**
 * OANDA REST adapter — long-history fallback when Yahoo's 15m cap (~60-71 days)
 * isn't enough for proper backtesting.
 *
 * OANDA demo accounts are free. They give clean OHLC for:
 *   - XAU_USD (gold), XAG_USD (silver) — always available
 *   - NAS100_USD (nasdaq), SPX500_USD (sp500), US30_USD, DE30_EUR, etc — CFD
 *     instruments, availability depends on account type/region
 *
 * Setup (5 minutes):
 *   1. https://www.oanda.com/demo-account/  — sign up free, pick "fxTrade Practice"
 *   2. Log in → "Manage API Access" (under your account name) → "Generate"
 *   3. Add the token to /home/octave/.config/trading-alerts/.env on the VPS:
 *        OANDA_API_TOKEN=your-token-here
 *        OANDA_ACCOUNT_ID=your-account-id   (e.g. 101-001-12345678-001)
 *   4. Set the base if you use a live account (default is demo):
 *        OANDA_API_BASE=https://api-fxtrade.oanda.com
 *
 * Unset OANDA_API_TOKEN → adapter is silent no-op. Yahoo remains primary.
 */

import { fetchWithTimeout } from '../lib/http.js';
// Hard-cap every OANDA request so a hung connection can't stall callers.
const fetch = (url, opts) => fetchWithTimeout(url, opts, 12000);

const SYMBOLS = {
  gold:   'XAU_USD',
  silver: 'XAG_USD',
  nasdaq: 'NAS100_USD',  // CFD — may 404 on some free accounts
  sp:     'SPX500_USD',  // CFD — may 404 on some free accounts
};

const GRANULARITY = {
  '1':  'M1',  '3':  'M3',  '5':  'M5',  '15': 'M15', '30': 'M30',
  '60': 'H1',  '240':'H4',  '1D': 'D',   'D':  'D',   'W':  'W',
};

const SECS = {
  M1: 60, M3: 180, M5: 300, M15: 900, M30: 1800,
  H1: 3600, H4: 14400, D: 86400, W: 604800,
};

const MAX_CANDLES_PER_REQUEST = 5000;
const PAGINATE_BACKWARD_LIMIT = 30;  // ≤150k candles per pane — plenty for 5y of 15m

/**
 * Fetch a single chronological page ending at `toUnix` (exclusive).
 * Returns null on hard failure (auth, instrument not on account, etc.) so
 * the caller can stop paginating.
 */
async function fetchPage(symbol, granularity, count, toUnix, token, base) {
  // OANDA docs: `includeFirst` is only valid alongside `from`. We always
  // paginate backward via `to` + `count`, so we never set `from` or `includeFirst`.
  const params = new URLSearchParams({
    granularity,
    count: String(count),
    price: 'M',
    smooth: 'false',
  });
  if (toUnix) params.set('to', String(toUnix));
  const url = `${base}/v3/instruments/${symbol}/candles?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    // 404 = instrument unsupported on this account (e.g. NAS100 on EU demo).
    // 400 = bad params — most often "instrument is not tradeable" wrapper.
    if (res.status === 404 || res.status === 400) return { error: 'unsupported', status: res.status };
    throw new Error(`OANDA ${symbol} ${granularity}: HTTP ${res.status}`);
  }
  const data = await res.json();
  return { candles: data?.candles || [] };
}

/**
 * Fetch bars going backward via pagination. `targetDays` is how far back we
 * want; we keep fetching until we cover it or hit a hard limit.
 */
export async function fetchBars(asset, tf, targetDays = 730) {
  const token = process.env.OANDA_API_TOKEN;
  if (!token) return null;
  const symbol = SYMBOLS[asset];
  const granularity = GRANULARITY[String(tf)];
  if (!symbol || !granularity) return null;
  const base = process.env.OANDA_API_BASE || 'https://api-fxpractice.oanda.com';

  const cutoffSec = Math.floor(Date.now() / 1000) - targetDays * 86400;
  const intervalSec = SECS[granularity] || 900;
  const idealCount = Math.min(MAX_CANDLES_PER_REQUEST, Math.ceil(targetDays * 86400 / intervalSec) + 10);
  // For deep history we may need multiple pages; cap pages to avoid runaway.
  const allBarsByTime = new Map();
  let toUnix = null;  // null = "now"
  for (let page = 0; page < PAGINATE_BACKWARD_LIMIT; page++) {
    const count = page === 0 ? idealCount : MAX_CANDLES_PER_REQUEST;
    const r = await fetchPage(symbol, granularity, count, toUnix, token, base);
    if (!r) return null;
    if (r.error === 'unsupported') return null;
    if (!r.candles?.length) break;
    let oldest = null;
    for (const c of r.candles) {
      const mid = c.mid;
      if (!mid) continue;
      const t = Math.floor(new Date(c.time).getTime() / 1000);
      if (oldest == null || t < oldest) oldest = t;
      if (allBarsByTime.has(t)) continue;
      allBarsByTime.set(t, {
        time: t,
        open: +mid.o, high: +mid.h, low: +mid.l, close: +mid.c,
        volume: c.volume ?? 0,
      });
    }
    if (oldest == null || oldest <= cutoffSec) break;
    // Next page ends just before the oldest bar we got.
    toUnix = oldest - intervalSec;
  }
  const bars = [...allBarsByTime.values()].sort((a, b) => a.time - b.time);
  // Drop the in-progress final bar (same logic as yahoo.js).
  if (bars.length) {
    const last = bars[bars.length - 1];
    if (last.time + intervalSec > Date.now() / 1000) bars.pop();
  }
  return {
    symbol, resolution: String(tf), bars, barCount: bars.length, source: 'oanda',
  };
}

/**
 * Fetch many (asset, tf) tuples in parallel. Each request paginates as
 * needed to cover `targetDays`.
 */
export async function fetchAll(requests, { targetDays = 730 } = {}) {
  if (!process.env.OANDA_API_TOKEN) return new Map();
  const out = new Map();
  const results = await Promise.allSettled(
    requests.map(([asset, tf]) => fetchBars(asset, tf, targetDays).then((pane) => [asset, tf, pane])),
  );
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const [asset, tf, pane] = r.value;
    if (pane?.bars?.length) out.set(`${asset}|${tf}`, pane);
  }
  return out;
}

/** True if OANDA is configured for this process. */
export function isConfigured() {
  return !!process.env.OANDA_API_TOKEN;
}
