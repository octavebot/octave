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
import { fetchAllForBacktest as fetchDatabentoBacktest, isConfigured as databentoConfigured } from '../cloud/databento.js';
import { fetchAll as fetchTradingview, fetchBars as fetchTvBars, isConfigured as tvConfigured } from '../cloud/tradingview.js';
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

      // TradingView bridge — real-time CME tape via the user's Mac. When the
      // bridge is alive (DATA_SOURCE=tradingview and at least one pane fresh
      // in the last 60s), TV panes OVERRIDE the Yahoo ones for the micros so
      // live signals fire on un-delayed data. Yahoo keeps serving silver/dxy
      // and any micro pane TV didn't supply, which is also what catches a Mac
      // outage automatically: stale TV pane → null → falls back to Yahoo.
      if (tvConfigured()) {
        try {
          const tvRequests = NEEDED_REQUESTS.filter(([asset]) => asset === 'gold' || asset === 'nasdaq' || asset === 'sp');
          const tv = await fetchTradingview(tvRequests).catch(() => new Map());
          for (const [key, p] of tv) {
            if (p?.bars?.length) panes.set(key, p);
          }
          // Rebuild the micros' 60m + 1D from the live TV 15m. Yahoo's frozen
          // micro-futures HTF bars carry a RECENT timestamp with a STALE price,
          // so the generic time-based synth below can't tell they're stale and
          // won't replace them — leaving the H1/D1 trend filters reading
          // Friday's close while the 15m is live. Here we keep Yahoo's DEEP
          // history (needed for the daily 20-EMA etc.) and splice the live TV
          // tail on top: deep[time < tvTail[0]] + aggregate(TV 15m).
          for (const inst of ['gold', 'nasdaq', 'sp']) {
            const tv15 = panes.get(`${inst}|15`);
            if (tv15?.source !== 'tradingview' || !tv15.bars?.length) continue;
            for (const { tf, bucketSec, daily } of [{ tf: '60', bucketSec: 3600 }, { tf: '1D', daily: true }]) {
              const tail = daily ? aggregateToDaily(tv15.bars, -Infinity)
                                 : aggregateToBucket(tv15.bars, bucketSec, -Infinity, 900);
              if (!tail.length) continue;
              const deep = panes.get(`${inst}|${tf}`);
              const cutoff = tail[0].time;
              const history = (deep?.bars || []).filter((b) => b.time < cutoff);
              panes.set(`${inst}|${tf}`, {
                symbol: tv15.symbol, resolution: tf,
                bars: history.concat(tail), source: 'tradingview+htf',
                barCount: history.length + tail.length,
              });
            }
          }
        } catch (err) {
          console.error('[cloud-data] tradingview overlay failed:', err?.message || err);
        }
      }
      // Synthesize stale higher-TF bars from the freshest lower-TF source.
      // Yahoo's micro-futures feed lags 15m/60m/1D into the Sunday Asian open
      // (sometimes by 50+ hours). 1m/5m stay fresh — aggregate those into the
      // higher TFs so bias, every strategy's H1/D1 trend filter, and the
      // precheck readouts all see CURRENT market structure.
      try { backfillHigherTfs(panes); }
      catch (err) { /* never block live data on a synth error */ console.error('[cloud-data] backfill failed:', err?.message || err); }
      fullCache = { panes, fetchedAt: Date.now() };
      // Heartbeat — the dashboard's "market-data" tile reads this so the
      // user knows live data is flowing (even if no alerts fire). The source
      // label reflects whichever feed produced the most micro panes (TV when
      // the bridge is alive, otherwise yahoo).
      const sources = {};
      for (const [, p] of panes) sources[p.source || 'yahoo'] = (sources[p.source || 'yahoo'] || 0) + 1;
      // Headline label = the feed driving LIVE SIGNALS, i.e. the traded micros'
      // 15m execution pane — not a raw pane-count vote (which the yahoo-only
      // 1m/1D/silver/dxy context panes would always win). If the micros' 15m is
      // TradingView, the bot is on real-time; that's what the user cares about.
      const execSrc = (panes.get('gold|15')?.source || '').startsWith('tradingview')
        ? 'tradingview'
        : (Object.entries(sources).sort((a, b) => b[1] - a[1])[0]?.[0] || 'yahoo');
      const dominantSource = execSrc;
      heartbeat('market-data', {
        pane_count: panes.size,
        source: dominantSource,
        sources,
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

      // Upgrade the 15m bias pane to the TradingView real-time FUTURES feed
      // when the bridge is live. Bias's fastest factors (15m trend/momentum,
      // VWAP, and the spot price shown) then come off the exact futures tape
      // instead of OANDA spot. 60m/1D stay on OANDA — those are slow,
      // direction-only factors where the spot-vs-futures basis cancels, and
      // TV's bridge window isn't deep enough for them anyway. Each timeframe
      // is single-sourced, so there's no futures/spot discontinuity within a
      // series. Falls back to OANDA 15m automatically if TV is stale.
      if (tvConfigured()) {
        try {
          const tv = await fetchTradingview([['gold', '15'], ['nasdaq', '15'], ['sp', '15']]).catch(() => new Map());
          for (const [key, p] of tv) {
            // Only override if TV actually has enough bars for the bias window.
            if (p?.bars?.length >= 114) out.set(key, p);
          }
        } catch (err) {
          console.error('[bias] tradingview overlay failed:', err?.message || err);
        }
      }

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

// ─── Real-time futures-accurate quotes ──────────────────────────────────────
// For price DISPLAY commands (/price, /session). Yahoo gives the exact futures
// price the user trades but freezes when CME is closed; OANDA spot stays live
// but sits a basis below the future. So: use Yahoo's futures quote while it's
// fresh, and when it's frozen, estimate the live future as OANDA spot + the
// measured futures-vs-spot basis (median over recent overlapping 15m bars) so
// the number still tick-matches the user's TradingView futures chart.
const QUOTE_INSTRUMENTS = [
  { key: 'gold',   yh: 'MGC=F', sym: 'MGC1!', label: 'Micro Gold' },
  { key: 'nasdaq', yh: 'MNQ=F', sym: 'MNQ1!', label: 'Micro Nasdaq' },
  { key: 'sp',     yh: 'MES=F', sym: 'MES1!', label: 'Micro S&P' },
];
// Yahoo's futures quote is "live" only if its last actual BAR is recent.
// NOTE: meta.regularMarketTime keeps ticking even when CME is closed (it's the
// poll time, not the last trade), so it can't gauge freshness — the last bar's
// timestamp can. 25min ≈ 1.6× the 15m bar so an open in-progress bar still
// reads fresh, but a frozen weekend/overnight feed (hours/days old) does not.
const FUTURES_FRESH_MS = 25 * 60 * 1000;

// Last good basis per instrument — reused if a transient Yahoo failure means we
// can't measure it this call, so the estimate stays accurate instead of blanking.
const lastBasis = {};
// Last known prior-session close per instrument (from Yahoo's chartPreviousClose
// when we last fetched it on the stale path). Lets the TV-fresh fast path report
// an accurate "change since prior settle" without a Yahoo round-trip.
const lastPrevClose = {};
// Short result cache so rapid /price + /session presses don't hammer Yahoo.
let quoteCache = { at: 0, map: null };
const QUOTE_TTL_MS = 10 * 1000;

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function fetchYahooQuote(yh) {
  // 15m/5d gives both the live meta (price/prevClose/time) and enough bars to
  // overlap with OANDA for the basis measurement, in one request.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yh)}?interval=15m&range=5d&includePrePost=false`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 OctaveBot' } });
  if (!res.ok) throw new Error(`Yahoo quote ${yh}: HTTP ${res.status}`);
  const data = await res.json();
  const r = data?.chart?.result?.[0];
  const meta = r?.meta || null;
  const ts = r?.timestamp || [];
  const q = r?.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (c == null) continue;
    bars.push({ time: ts[i], close: +c });
  }
  return { meta, bars };
}

/**
 * Real-time, futures-accurate price per instrument for display commands.
 * @returns {Promise<Map<string, {
 *   sym, label, price, change, changePct, source, estimated, basis,
 *   stale, ageMs, asOfMs }>>}
 *   - source 'tradingview'  → exact real-time futures print from the Mac bridge
 *   - source 'yahoo'        → live futures print (exact, but ~15min delayed feed)
 *   - source 'oanda+basis'  → estimated future = OANDA spot + basis (market closed)
 *   - source 'yahoo-stale'  → OANDA unavailable, last futures print (flagged stale)
 */
export async function getLiveFuturesQuotes() {
  if (quoteCache.map && (Date.now() - quoteCache.at) < QUOTE_TTL_MS) {
    return new Map(quoteCache.map);
  }
  const now = Date.now();
  const out = new Map();

  // TV-fresh FAST PATH: when the Mac bridge is up it provides the EXACT live
  // futures price, so we skip the (slow, sometimes 5-7s-each) Yahoo + OANDA
  // network fetches entirely — those are only needed to ESTIMATE the price via
  // basis when TV/Yahoo are stale. This is what kept /price and /session fast
  // vs the ~20s cold call that hit Yahoo+OANDA for all three instruments.
  if (tvConfigured()) {
    let allFresh = true;
    for (const inst of QUOTE_INSTRUMENTS) {
      let tvBars = null, tvLast = null;
      try {
        const p = await fetchTvBars(inst.key, '5');
        if (p?.bars?.length) { tvBars = p.bars; tvLast = p.bars[p.bars.length - 1]; }
      } catch { /* no-op */ }
      if (!tvLast) { allFresh = false; break; }
      // Prior-session close for the change% — derived from the TV bars (no
      // network): the close of the last bar before the current CME session
      // start (futures roll 22:00 UTC). Falls back to a remembered Yahoo
      // prevClose, then the window's first bar.
      const SESSION_UTC_HOUR = 22;
      const d = new Date(now);
      let sessStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), SESSION_UTC_HOUR) / 1000;
      if (now / 1000 < sessStart) sessStart -= 86400;
      let priorClose = null;
      for (let i = tvBars.length - 1; i >= 0; i--) {
        if (tvBars[i].time < sessStart) { priorClose = tvBars[i].close; break; }
      }
      const ref = priorClose ?? lastPrevClose[inst.key] ?? tvBars[0]?.close ?? null;
      const change = ref != null ? tvLast.close - ref : null;
      out.set(inst.key, {
        sym: inst.sym, label: inst.label, price: tvLast.close,
        change, changePct: (change != null && ref) ? (change / ref) * 100 : null,
        source: 'tradingview', estimated: false, basis: null,
        stale: false, ageMs: now - tvLast.time * 1000, asOfMs: tvLast.time * 1000,
      });
    }
    if (allFresh && out.size === QUOTE_INSTRUMENTS.length) {
      quoteCache = { at: Date.now(), map: out };
      return new Map(out);
    }
    out.clear(); // partial TV — fall through to the full Yahoo/OANDA path below
  }

  const biasPanes = await fetchBiasPanes().catch(() => null);

  await Promise.all(QUOTE_INSTRUMENTS.map(async (inst) => {
    let yMeta = null, yBars = [];
    try { ({ meta: yMeta, bars: yBars } = await fetchYahooQuote(inst.yh)); }
    catch { /* Yahoo may rate-limit; OANDA path below still works */ }

    // OANDA: freshest spot from M1 (≈1min), plus 15m bars (shared cache) for
    // basis. If M1 fails, fall back to the last 15m bar as the spot price.
    let oM1Last = null, oM15 = [];
    try {
      const m1 = await fetchOandaBars(inst.key, '1', 1);
      oM1Last = m1?.bars?.length ? m1.bars[m1.bars.length - 1] : null;
    } catch { /* no-op */ }
    oM15 = biasPanes?.get(`${inst.key}|15`)?.bars || [];
    const oSpot = oM1Last || (oM15.length ? oM15[oM15.length - 1] : null);

    // Basis = median(yahoo futures close − oanda spot close) over overlapping 15m
    // bars. If we can't measure it this call (e.g. Yahoo rate-limited), reuse the
    // last good basis so the estimate stays accurate rather than disappearing.
    let basis = null;
    if (yBars.length && oM15.length) {
      const oMap = new Map(oM15.map((b) => [b.time, b.close]));
      const diffs = [];
      for (const b of yBars.slice(-16)) {
        const o = oMap.get(b.time);
        if (o != null) diffs.push(b.close - o);
      }
      basis = median(diffs);
    }
    if (basis != null) lastBasis[inst.key] = basis;
    else if (lastBasis[inst.key] != null) basis = lastBasis[inst.key];

    // TradingView bridge — the EXACT real-time futures print (same contract the
    // user trades, no spot-vs-futures basis to estimate). When the bridge is
    // live this is strictly better than both Yahoo (15-min delayed) and the
    // OANDA-spot-plus-basis estimate, so it wins outright.
    let tvLast = null;
    if (tvConfigured()) {
      try {
        const tvPane = await fetchTvBars(inst.key, '5');
        if (tvPane?.bars?.length) tvLast = tvPane.bars[tvPane.bars.length - 1];
      } catch { /* fall through to yahoo/oanda */ }
    }

    // Freshness from the last real BAR, not meta.regularMarketTime (see note above).
    const yBarTimeMs = yBars.length ? yBars[yBars.length - 1].time * 1000 : null;
    const yFresh = yBarTimeMs != null && (now - yBarTimeMs) < FUTURES_FRESH_MS;
    const prevClose = yMeta?.chartPreviousClose ?? null;
    if (prevClose != null) lastPrevClose[inst.key] = prevClose; // remembered for the TV fast path
    const yLivePrice = yMeta?.regularMarketPrice ?? (yBars.length ? yBars[yBars.length - 1].close : null);

    let entry = null;
    if (tvLast != null) {
      // prevClose for the % change: prefer Yahoo's chartPreviousClose (prior
      // session settle) so /price's "change" reads the same as the user's
      // platform; fall back to the first TV bar in the window.
      const ref = prevClose ?? yBars[0]?.close ?? tvLast.open;
      entry = {
        price: tvLast.close,
        change: ref != null ? tvLast.close - ref : null,
        source: 'tradingview', estimated: false, basis: null,
        stale: false, ageMs: now - tvLast.time * 1000, asOfMs: tvLast.time * 1000,
      };
    } else if (yFresh && yLivePrice != null) {
      entry = {
        price: yLivePrice,
        change: prevClose != null ? yLivePrice - prevClose : null,
        source: 'yahoo', estimated: false, basis: null,
        stale: false, ageMs: now - yBarTimeMs, asOfMs: yBarTimeMs,
      };
    } else if (oSpot && basis != null) {
      const price = oSpot.close + basis;
      const oAgeMs = now - oSpot.time * 1000;
      // Reference the last actual futures close (Yahoo's frozen tail) so the
      // change reads as "move since CME closed", not a multi-day span vs the
      // prior daily settlement.
      const lastFutClose = yBars.length ? yBars[yBars.length - 1].close : prevClose;
      entry = {
        price,
        change: lastFutClose != null ? price - lastFutClose : null,
        source: 'oanda+basis', estimated: true, basis,
        // OANDA is live, so this is NOT stale even though Yahoo is frozen.
        stale: false, ageMs: oAgeMs, asOfMs: oSpot.time * 1000,
      };
    } else if (yLivePrice != null) {
      entry = {
        price: yLivePrice,
        change: prevClose != null ? yLivePrice - prevClose : null,
        source: 'yahoo-stale', estimated: false, basis: null,
        stale: true, ageMs: yBarTimeMs != null ? now - yBarTimeMs : null, asOfMs: yBarTimeMs,
      };
    }
    if (!entry) return;
    entry.changePct = (entry.change != null && entry.price - entry.change !== 0)
      ? (entry.change / (entry.price - entry.change)) * 100 : null;
    out.set(inst.key, { sym: inst.sym, label: inst.label, ...entry });
  }));

  if (out.size) quoteCache = { at: Date.now(), map: out };
  return new Map(out);
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
  // The three traded micros — Databento serves these from the real CME tape.
  const MICROS = new Set(['gold', 'nasdaq', 'sp']);
  const useDb = databentoConfigured();

  // 1) Yahoo baseline for everything (fast; sole intraday source for silver/dxy
  //    and the fallback for the micros if Databento is off or partial).
  const panes = await fetchYahoo(NEEDED_REQUESTS).catch(() => new Map());
  for (const [, p] of panes) p.source = p.source || 'yahoo';

  // 2) Databento = authoritative DEEP CME history for the micros: real futures
  //    bars (no spot-vs-futures basis), no Yahoo 60-day intraday cap. Replaces
  //    the Yahoo/OANDA micro panes outright on 15m / 60m / 1D.
  if (useDb) {
    try {
      const db = await fetchDatabentoBacktest(targetDays);
      for (const [key, pane] of db) {
        if (pane?.bars?.length) panes.set(key, pane);
      }
    } catch (err) {
      console.error('[backtest] databento deep fetch failed, falling back to yahoo/oanda:', err?.message || err);
    }
  }

  // 3) OANDA extends the remaining instruments back to targetDays — silver, and
  //    the micros only if Databento didn't cover them (off / a transient miss).
  if (oandaConfigured()) {
    const oandaRequests = NEEDED_REQUESTS.filter(([asset, tf]) =>
      asset !== 'dxy' && !(useDb && MICROS.has(asset) && panes.get(`${asset}|${tf}`)?.source === 'databento'));
    const oanda = await fetchOanda(oandaRequests, { targetDays }).catch(() => new Map());
    for (const [key, oandaPane] of oanda) {
      const cur = panes.get(key);
      if (!cur?.bars?.length) {
        panes.set(key, oandaPane);
        continue;
      }
      const earliest = cur.bars[0].time;
      const merged = [
        ...oandaPane.bars.filter((b) => b.time < earliest),
        ...cur.bars,
      ];
      panes.set(key, { ...cur, bars: merged, source: `${cur.source || 'yahoo'}+oanda`, barCount: merged.length });
    }
  }
  return panes;
}
