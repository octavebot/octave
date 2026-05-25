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
import { fetchAll as fetchOanda, fetchBars as fetchOandaBars, isConfigured as oandaConfigured } from '../cloud/oanda.js';
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
      // Synthesize stale higher-TF bars from the freshest lower-TF source.
      // Yahoo's micro-futures feed lags 15m/60m/1D into the Sunday Asian open
      // (sometimes by 50+ hours). 1m/5m stay fresh — aggregate those into the
      // higher TFs so bias, every strategy's H1/D1 trend filter, and the
      // precheck readouts all see CURRENT market structure.
      try { backfillHigherTfs(panes); }
      catch (err) { /* never block live data on a synth error */ console.error('[cloud-data] backfill failed:', err?.message || err); }
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

// ─── Real-time bias feed (OANDA) ────────────────────────────────────────────
// Yahoo's free micro-futures feed freezes overnight / weekends / holidays
// (no bars past the last RTH close), which makes /bias recompute identical
// numbers from stale data. OANDA's gold/index CFDs trade ~24/5 and stay live,
// so we use it as a dedicated REAL-TIME source for the directional bias read.
//
// Scope: BIAS ONLY. OANDA quotes spot/CFD (XAU_USD, NAS100_USD…) which carries
// a futures-vs-spot basis (~+61pt NQ, ~+12 ES, ~+1 gold). A directional read
// (trend / EMA / RSI / momentum) is basis-insensitive — the offset cancels —
// so OANDA is accurate for direction. Strategy entry/stop/target levels stay
// on the Yahoo (futures) feed so live execution levels are unaffected.
const BIAS_REQUESTS = [
  // [asset, tf, lookbackDays] — enough bars for computeInstrumentBias()
  // (15m ≥50 + vol percentile needs ~114; 60m ≥55; 1D ≥25).
  ['gold',   '15', 7], ['gold',   '60', 14], ['gold',   '1D', 90],
  ['nasdaq', '15', 7], ['nasdaq', '60', 14], ['nasdaq', '1D', 90],
  ['sp',     '15', 7], ['sp',     '60', 14], ['sp',     '1D', 90],
];

let biasCache = { panes: null, fetchedAt: 0 };
let inflightBias = null;

/**
 * Real-time `panesByTf` for the bias read, sourced from OANDA. Same key shape
 * as fetchAllPanes (`${asset}|${tf}`) so detector's buildInstrumentCtx works
 * unchanged. Cached for TTL_MS like the main feed.
 *
 * @returns {Promise<Map<string,object>|null>} null when OANDA is unconfigured
 *   or returned nothing — caller should fall back to the Yahoo panes.
 */
export async function fetchBiasPanes() {
  if (!oandaConfigured()) return null;
  if (!shouldFetch(biasCache.fetchedAt) && biasCache.panes) {
    return new Map(biasCache.panes);
  }
  if (inflightBias) return inflightBias.then((m) => (m ? new Map(m) : null));
  inflightBias = (async () => {
    try {
      const out = new Map();
      const results = await Promise.allSettled(
        BIAS_REQUESTS.map(([asset, tf, days]) =>
          fetchOandaBars(asset, tf, days).then((pane) => [asset, tf, pane])),
      );
      for (const r of results) {
        if (r.status !== 'fulfilled' || !r.value) continue;
        const [asset, tf, pane] = r.value;
        if (pane?.bars?.length) out.set(`${asset}|${tf}`, pane);
      }
      if (out.size === 0) return null;
      biasCache = { panes: out, fetchedAt: Date.now() };
      return out;
    } catch {
      return null;
    } finally {
      inflightBias = null;
    }
  })();
  return inflightBias.then((m) => (m ? new Map(m) : null));
}

// ─── Higher-TF synthesis ──────────────────────────────────────────────────

const INSTRUMENTS_FOR_SYNTH = ['gold', 'nasdaq', 'sp'];
const SYNTH_TARGETS = [
  { tf: '15',  bucketSec: 15 * 60,      sourceTfs: ['5', '1'] },
  { tf: '60',  bucketSec: 60 * 60,      sourceTfs: ['15', '5', '1'] },
  { tf: '1D',  bucketSec: 24 * 60 * 60, sourceTfs: ['60', '15', '5'] },
];

function backfillHigherTfs(panes) {
  for (const inst of INSTRUMENTS_FOR_SYNTH) {
    for (const target of SYNTH_TARGETS) {
      const dest = panes.get(`${inst}|${target.tf}`);
      if (!dest?.bars?.length) continue;
      const destLastTime = dest.bars[dest.bars.length - 1].time;
      // Pick the freshest source pane available
      let source = null;
      for (const sTf of target.sourceTfs) {
        const cand = panes.get(`${inst}|${sTf}`);
        if (cand?.bars?.length && cand.bars[cand.bars.length - 1].time > destLastTime) {
          source = cand;
          break;
        }
      }
      if (!source) continue;
      const sourceBarSec = sourceBarSize(source);
      if (!sourceBarSec) continue;
      // Aggregate source bars that are NEWER than dest's last bar into
      // target-TF buckets. Daily bars use the futures session boundary
      // (close at 17:00 ET = 21:00 UTC daylight / 22:00 UTC standard).
      const synth = target.tf === '1D'
        ? aggregateToDaily(source.bars, destLastTime)
        : aggregateToBucket(source.bars, target.bucketSec, destLastTime, sourceBarSec);
      if (!synth.length) continue;
      // Drop any partial bucket (the last bar of source might not fill the
      // entire target bucket yet). We keep partial only if it's reasonably
      // recent — within 25% of the bucket window of "now".
      const nowSec = Math.floor(Date.now() / 1000);
      const filtered = synth.filter((b, i) => {
        const isLast = i === synth.length - 1;
        if (!isLast) return true;
        const bucketEnd = b.time + target.bucketSec;
        // For sub-daily we accept partial bars (mid-bucket update is useful).
        if (target.tf !== '1D') return true;
        // Daily: only accept if the bucket "should" be open right now.
        return nowSec < bucketEnd;
      });
      for (const b of filtered) b.synthetic = true;
      dest.bars = dest.bars.concat(filtered);
      dest.source = (dest.source || 'yahoo') + '+synth';
    }
  }
}

function sourceBarSize(p) {
  if (!p?.bars || p.bars.length < 2) return null;
  const n = p.bars.length;
  return p.bars[n - 1].time - p.bars[n - 2].time;
}

function aggregateToBucket(bars, bucketSec, sinceExclusive, sourceBarSec) {
  // Keep only source bars strictly newer than the existing dest tail.
  const fresh = bars.filter((b) => b.time > sinceExclusive);
  if (!fresh.length) return [];
  const out = [];
  let cur = null;
  for (const b of fresh) {
    const bucketTime = Math.floor(b.time / bucketSec) * bucketSec;
    if (!cur || cur.time !== bucketTime) {
      if (cur) out.push(cur);
      cur = { time: bucketTime, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function aggregateToDaily(bars, sinceExclusive) {
  // Futures session "day" starts at 18:00 ET = 22:00 UTC (DST) / 23:00 UTC (std).
  // Use 22:00 UTC year-round — close enough; bias filters tolerate ±1h shift.
  // Each bar belongs to the session that ended at the next 22:00 UTC boundary.
  const SESSION_UTC_HOUR = 22;
  const fresh = bars.filter((b) => b.time > sinceExclusive);
  if (!fresh.length) return [];
  const out = [];
  let cur = null;
  for (const b of fresh) {
    const sessionStart = sessionStartUtc(b.time, SESSION_UTC_HOUR);
    if (!cur || cur.time !== sessionStart) {
      if (cur) out.push(cur);
      cur = { time: sessionStart, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function sessionStartUtc(unixSec, hourUtc) {
  const d = new Date(unixSec * 1000);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc, 0, 0) / 1000;
  return unixSec < dayStart ? dayStart - 24 * 60 * 60 : dayStart;
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
