/**
 * Databento OHLCV adapter — real-time CME futures via the GLBX.MDP3 dataset.
 *
 * Drop-in replacement for the Yahoo feed on the LIVE strategy path: exports the
 * same `fetchBars(asset, tf)` / `fetchAll(requests)` shape so the detector,
 * bias, and dashboard pick it up unchanged. Selected in cloud_data_supplement
 * when `DATA_SOURCE=databento` and `DATABENTO_API_KEY` is set.
 *
 * Why Databento over Yahoo: Yahoo's free feed is ~15min delayed and FREEZES
 * overnight/weekends/holidays. Databento streams the authoritative CME tape in
 * real time, so live execution levels are exact and the bias never recomputes
 * off a stale tail. These are FUTURES prices (same as Yahoo's =F), so there is
 * no spot-vs-futures basis to adjust — unlike the OANDA bias feed.
 *
 * Coverage: only the three traded micros (MGC/MNQ/MES) live on GLBX.MDP3.
 * Silver stays on Yahoo and DXY isn't a CME product at all, so both fall back
 * to Yahoo in cloud_data_supplement.
 *
 * Cost discipline: GLBX is billed by data volume. We pull a bounded tail once,
 * then top up INCREMENTALLY (only bars newer than what we already hold) on each
 * 15s refresh, so we never re-download history. Concurrent requests for the
 * same raw stream share one in-flight fetch.
 *
 * Schemas: Databento has no native 5m/15m. We pull `ohlcv-1m` and aggregate to
 * 5m/15m, use native `ohlcv-1h` for 60m, and derive 1D from 1h on the CME
 * session boundary (22:00 UTC) — matching cloud_data_supplement's synth-daily
 * logic, NOT native `ohlcv-1d` which aligns to 00:00 UTC and splits the session.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithTimeout } from '../lib/http.js';
// Backtest-only feed, but still cap it so a hung request can't wedge a run.
const fetch = (url, opts) => fetchWithTimeout(url, opts, 30000);

const API = 'https://hist.databento.com/v0/timeseries.get_range';
const DATASET = 'GLBX.MDP3';

// Internal asset key → Databento continuous front-month symbol (volume roll,
// `.v.0` = the most-traded contract, which is what a trader is actually in).
const SYMBOLS = {
  gold:   'MGC.v.0',  // Micro Gold      → COMEX:MGC1!
  nasdaq: 'MNQ.v.0',  // Micro Nasdaq    → CME_MINI:MNQ1!
  sp:     'MES.v.0',  // Micro S&P 500   → CME_MINI:MES1!
};

const TF_SECONDS = { '1': 60, '5': 300, '15': 900, '60': 3600, '1D': 86400 };

// Databento JSON prices are fixed-precision integers scaled by 1e9.
const PRICE_SCALE = 1e9;

// How much tail to keep per raw schema. 1m × 8 calendar days ≈ 450+ aggregated
// 15m bars (>> the ~114 the bias needs); 1h × 100 days ≈ 70 daily bars.
const WINDOW_DAYS = { 'ohlcv-1m': 8, 'ohlcv-1h': 100 };
const MAX_BARS = 450; // detector caps panes at 400; keep a little headroom

// raw cache: `${symbol}|${schema}` -> { bars, fetchedAt }
const RAW = new Map();
// in-flight dedup so gold|1, gold|5, gold|15 share ONE 1m fetch per refresh.
const INFLIGHT = new Map();

function authHeader() {
  const key = process.env.DATABENTO_API_KEY;
  if (!key) throw new Error('DATABENTO_API_KEY not set');
  return 'Basic ' + Buffer.from(`${key}:`).toString('base64');
}

// ns-since-epoch string → integer seconds (BigInt keeps full precision; the
// resulting seconds value is well within Number's safe range).
function nsToSec(ns) { return Number(BigInt(ns) / 1_000_000_000n); }

function parseNdjson(text) {
  const bars = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    if (!o?.hd?.ts_event || o.open == null) continue; // skip non-OHLCV records
    bars.push({
      time: nsToSec(o.hd.ts_event),
      open: Number(o.open) / PRICE_SCALE,
      high: Number(o.high) / PRICE_SCALE,
      low: Number(o.low) / PRICE_SCALE,
      close: Number(o.close) / PRICE_SCALE,
      volume: Number(o.volume) || 0,
    });
  }
  return bars;
}

async function postRange(symbol, schema, startMs, endMs) {
  const body = new URLSearchParams({
    dataset: DATASET,
    symbols: symbol,
    schema,
    stype_in: 'continuous',
    encoding: 'json',
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  });
  return fetch(API, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
}

// Databento Historical "seals" data on a watermark that lags wall-clock by
// ~10min, so requesting end=now returns 422 `data_end_after_available_end`.
// The error states the true available end, so we parse it and retry once at
// that boundary — self-adapting to whatever the live lag is (no hardcoded
// delay), and always pulling the freshest bars Databento has.
function parseAvailableEnd(txt) {
  const m = txt.match(/available up to '([^']+)'/);
  if (!m) return 0;
  // e.g. "2026-05-25 13:42:00+00:00" → ISO
  return Date.parse(m[1].replace(' ', 'T'));
}

async function rangeRequest(symbol, schema, startMs, endMs) {
  let res = await postRange(symbol, schema, startMs, endMs);
  if (res.status === 422) {
    const txt = await res.text().catch(() => '');
    const avail = parseAvailableEnd(txt);
    if (avail) {
      const cappedEnd = Math.min(endMs, avail);
      if (cappedEnd <= startMs) return []; // window is entirely beyond available data
      res = await postRange(symbol, schema, startMs, cappedEnd);
    } else {
      throw new Error(`Databento ${symbol} ${schema}: HTTP 422 ${txt.slice(0, 160)}`);
    }
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Databento ${symbol} ${schema}: HTTP ${res.status} ${txt.slice(0, 160)}`);
  }
  return parseNdjson(await res.text());
}

// Replace the existing tail from the first incoming bar onward (the last held
// bar may have been mid-formation), then append the rest.
function mergeBars(existing, incoming) {
  if (!existing.length) return incoming;
  if (!incoming.length) return existing;
  const firstNew = incoming[0].time;
  return existing.filter((b) => b.time < firstNew).concat(incoming);
}

async function getRaw(symbol, schema) {
  const key = `${symbol}|${schema}`;
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);
  const p = (async () => {
    const now = Date.now();
    const windowMs = (WINDOW_DAYS[schema] || 8) * 86400 * 1000;
    const entry = RAW.get(key);
    let bars;
    if (entry?.bars?.length) {
      // Incremental top-up from the last held bar forward.
      const lastSec = entry.bars[entry.bars.length - 1].time;
      const incoming = await rangeRequest(symbol, schema, lastSec * 1000, now);
      bars = mergeBars(entry.bars, incoming);
    } else {
      bars = await rangeRequest(symbol, schema, now - windowMs, now);
    }
    const cutoff = Math.floor((now - windowMs) / 1000);
    bars = bars.filter((b) => b.time >= cutoff);
    RAW.set(key, { bars, fetchedAt: now });
    return bars;
  })().finally(() => INFLIGHT.delete(key));
  INFLIGHT.set(key, p);
  return p;
}

// Aggregate finer bars into wall-clock-aligned UTC buckets (5m/15m).
function aggregateBucket(bars, bucketSec) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const t = Math.floor(b.time / bucketSec) * bucketSec;
    if (!cur || cur.time !== t) {
      if (cur) out.push(cur);
      cur = { time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// CME futures "day" rolls at 22:00 UTC (≈18:00 ET) — matches the synth-daily
// boundary in cloud_data_supplement so D1 trend filters are source-agnostic.
const SESSION_UTC_HOUR = 22;
function sessionStartUtc(unixSec) {
  const d = new Date(unixSec * 1000);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), SESSION_UTC_HOUR, 0, 0) / 1000;
  return unixSec < dayStart ? dayStart - 86400 : dayStart;
}
function aggregateDaily(bars) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const t = sessionStartUtc(b.time);
    if (!cur || cur.time !== t) {
      if (cur) out.push(cur);
      cur = { time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Fetch OHLCV bars for a single asset+timeframe.
 * @param {'gold'|'nasdaq'} asset
 * @param {string} tf  internal TF key ('1','5','15','60','1D')
 * @returns {Promise<null|{symbol,resolution,bars,barCount,source}>}
 *   null for assets/TFs Databento doesn't serve — caller falls back to Yahoo.
 */
export async function fetchBars(asset, tf) {
  const symbol = SYMBOLS[asset];
  const tfSec = TF_SECONDS[String(tf)];
  if (!symbol || !tfSec) return null;

  let bars;
  if (tf === '1' || tf === '5' || tf === '15') {
    const raw = await getRaw(symbol, 'ohlcv-1m');
    bars = tf === '1' ? raw.slice() : aggregateBucket(raw, tfSec);
  } else if (tf === '60') {
    bars = (await getRaw(symbol, 'ohlcv-1h')).slice();
  } else if (tf === '1D') {
    bars = aggregateDaily(await getRaw(symbol, 'ohlcv-1h'));
  } else {
    return null;
  }

  // Only ever expose CLOSED candles (mirror yahoo.js): drop a still-forming
  // final bar so live alerts never fire on a half-formed candle.
  if (bars.length) {
    const lastOpen = bars[bars.length - 1].time;
    if (lastOpen + tfSec > Date.now() / 1000) bars.pop();
  }
  if (bars.length > MAX_BARS) bars = bars.slice(-MAX_BARS);

  return { symbol, resolution: String(tf), bars, barCount: bars.length, source: 'databento' };
}

/**
 * Fetch a list of (asset, tf) tuples in parallel.
 * @param {Array<['gold'|'nasdaq', string]>} requests
 * @returns {Promise<Map<string, object>>}  `${asset}|${tf}` -> pane
 */
export async function fetchAll(requests) {
  const out = new Map();
  const results = await Promise.allSettled(
    requests.map(([asset, tf]) => fetchBars(asset, tf).then((pane) => [asset, tf, pane])),
  );
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const [asset, tf, pane] = r.value;
    if (pane?.bars?.length) out.set(`${asset}|${tf}`, pane);
  }
  return out;
}

// ─── Backtest: deep historical pull ─────────────────────────────────────────
// This key is HISTORICAL-ONLY with a rolling ~8h embargo on recent data, so we
// cap every backtest request to `now − 9h` to stay safely inside the licensed
// window (losing the last few hours is irrelevant to a backtest). Bypasses the
// live RAW/incremental cache — backtests run on demand, not in the hot loop.
const LICENSE_LAG_MS = 9 * 60 * 60 * 1000;

// Deep history is billed by volume, so we cache each backtest pull to disk and
// reuse it. Cache NEVER expires automatically — historical 1m/1h bars from past
// dates don't change, so once on disk they're good forever. To force a refresh
// (e.g. extend the backtest window with newer data), delete the matching file:
//   rm src/state/databento-cache/backtest_d<N>.json
// This keeps the user's Databento spend at a one-time cost: pay once for the
// year of history, then unlimited backtests run free off disk.
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'state', 'databento-cache');

function loadBacktestCache(targetDays) {
  try {
    const f = join(CACHE_DIR, `backtest_d${targetDays}.json`);
    statSync(f); // existence check — no TTL
    const obj = JSON.parse(readFileSync(f, 'utf8'));
    return new Map(obj.entries);
  } catch { return null; }
}
function saveBacktestCache(targetDays, map) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, `backtest_d${targetDays}.json`), JSON.stringify({ at: Date.now(), entries: [...map] }));
  } catch { /* cache is best-effort */ }
}

// Fetch a long range in chunks so a single request never buffers an enormous
// response (2y of 1m ≈ 1M bars). end is exclusive in get_range, so adjacent
// chunks don't overlap; we de-dupe by time defensively anyway.
async function rangeRequestChunked(symbol, schema, startMs, endMs, chunkDays) {
  const chunkMs = chunkDays * 86400 * 1000;
  const all = [];
  let lastTime = -1;
  for (let s = startMs; s < endMs; s += chunkMs) {
    const e = Math.min(s + chunkMs, endMs);
    const part = await rangeRequest(symbol, schema, s, e);
    for (const b of part) {
      if (b.time > lastTime) { all.push(b); lastTime = b.time; }
    }
  }
  return all;
}

/**
 * Deep history for all traded micros. Pulls each raw schema ONCE per symbol and
 * derives every timeframe from it: one 1m pull → 5m + 15m, one 1h pull → 60m +
 * 1D. The 5m pane matters even though no strategy reads it — the backtest's
 * walk-forward anchors on `inst|5`, so without a deep 5m the anchor (and thus
 * the whole window) collapses to Yahoo's 60-day cap. HTF reaches 90 extra days
 * back so daily trend filters have warmup. `${asset}|${tf}` -> pane.
 */
export async function fetchAllForBacktest(targetDays = 730) {
  const cached = loadBacktestCache(targetDays);
  if (cached) return cached;

  const now = Date.now();
  const end = now - LICENSE_LAG_MS;                            // licensed window
  const execStart = now - (targetDays + 2) * 86400 * 1000;     // 1m → 5m / 15m
  const htfStart = now - (targetDays + 90) * 86400 * 1000;     // 1h → 60m / 1D
  const pane = (symbol, tf, bars) => ({ symbol, resolution: tf, bars, barCount: bars.length, source: 'databento' });
  const out = new Map();
  for (const asset of Object.keys(SYMBOLS)) {
    const symbol = SYMBOLS[asset];
    try {
      const m1 = await rangeRequestChunked(symbol, 'ohlcv-1m', execStart, end, 30);
      if (m1.length) {
        out.set(`${asset}|5`, pane(symbol, '5', aggregateBucket(m1, 300)));
        out.set(`${asset}|15`, pane(symbol, '15', aggregateBucket(m1, 900)));
      }
      const h1 = await rangeRequestChunked(symbol, 'ohlcv-1h', htfStart, end, 365);
      if (h1.length) {
        out.set(`${asset}|60`, pane(symbol, '60', h1));
        out.set(`${asset}|1D`, pane(symbol, '1D', aggregateDaily(h1)));
      }
    } catch (err) {
      console.error('[databento backtest]', asset, err?.message || err);
    }
  }
  if (out.size) saveBacktestCache(targetDays, out);
  return out;
}

export function isConfigured() {
  return !!process.env.DATABENTO_API_KEY;
}
