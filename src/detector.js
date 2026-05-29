/**
 * Strategy orchestrator — multi-instrument, registry-driven.
 *
 * Loops every enabled strategy across each instrument [gold, nasdaq].
 * Strategies are auto-discovered from src/strategies/ — see strategy_registry.js.
 *
 * @typedef {Object} DetectorResult
 * @property {string} strategy        strategy id (matches meta.id)
 * @property {string} instrument      'gold' | 'nasdaq'
 * @property {string} setupId         stable id across lifecycle
 * @property {'forming'|'near_trigger'|'triggered'|'invalidated'} status
 * @property {string} direction       'LONG' | 'SHORT' | 'NONE'
 * @property {string} setupName
 * @property {string} summary
 * @property {number} confidence      0..1
 * @property {string|number} timeframe
 * @property {Object} [entryPlan]     { entry, stop, t1, t2, risk } on triggered
 * @property {Array<string>} [confirmations]  bullet list shown in alerts
 */

import { writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nyParts } from './lib/time.js';
import { log } from './logger.js';
import { refresh as refreshConfig, isStrategyEnabled } from './lib/runtime_config.js';
import { fetchAllPanes, fetchBiasPanes } from './lib/cloud_data_supplement.js';
import { checkBlackout, refreshForexFactory } from './lib/news.js';
import { evaluateUserStrategies } from './lib/user_strategies.js';
import { loadRegistry } from './lib/strategy_registry.js';
import { computeInstrumentBias, tallyStrategyVote, combineBias } from './lib/bias.js';

const BIAS_SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), 'state', 'last-bias.json');
const PRECHECK_SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), 'state', 'last-precheck.json');

// Three primary instruments. Each runs the full strategy gauntlet; strategies
// can opt out by declaring `meta.instruments`.
export const INSTRUMENTS = ['gold', 'nasdaq', 'sp'];

export const INSTRUMENT_META = {
  gold:   { label: 'Gold',   symbol: 'MGC1!', tvFullSymbol: 'COMEX:MGC1!' },
  nasdaq: { label: 'Nasdaq', symbol: 'MNQ1!', tvFullSymbol: 'CME_MINI:MNQ1!' },
  sp:     { label: 'S&P',    symbol: 'MES1!', tvFullSymbol: 'CME_MINI:MES1!' },
};

// Yahoo's 60m feed returns 11k+ bars per instrument; strategies only need a
// few hundred for any indicator they compute. Trim panes lazily in ctx.pane()
// so each evaluate() call sees a slim slice, not the full 2-year history.
// WeakMap keyed on the source pane so the slim copy is GC'd when fetchAllPanes
// refreshes the underlying pane (every ~15s) and the old one drops out of scope.
const MAX_PANE_BARS = 400;
const trimmedCache = new WeakMap();
function trimmed(pane) {
  if (!pane?.bars) return pane;
  if (pane.bars.length <= MAX_PANE_BARS) return pane;
  const cached = trimmedCache.get(pane);
  if (cached) return cached;
  const slim = { ...pane, bars: pane.bars.slice(-MAX_PANE_BARS) };
  trimmedCache.set(pane, slim);
  return slim;
}

const TF_SEC = { '1': 60, '3': 180, '5': 300, '15': 900, '30': 1800, '60': 3600, '240': 14400, '1D': 86400, 'D': 86400, 'W': 604800 };
// Drop a still-forming final bar so STRATEGY EVALUATION sees only CLOSED candles
// — matching the backtest (yahoo/databento/oanda feeds already drop it, but the
// live TV-bridge keeps the partial sub-daily bucket, so live used to evaluate the
// in-progress bar → level-touch strategies over-fired and completed-bar-pattern
// strategies under-fired vs the closed-bar backtest). A bar is forming if its
// close time (open + TF duration) is still in the future. ONLY the detector ctx
// uses this; getLivePrices()/follow-up TP-SL still read the raw panes (with the
// live bar) so intrabar exits aren't delayed.
function dropFormingBar(pane, tfKey) {
  if (!pane?.bars?.length) return pane;
  const sec = TF_SEC[tfKey];
  if (!sec || pane.bars.length < 2) return pane;
  const last = pane.bars[pane.bars.length - 1];
  if (last.time + sec > Date.now() / 1000 + 1) return { ...pane, bars: pane.bars.slice(0, -1) };
  return pane;
}

// A live feed's latest RAW (forming) bar updates every tick, so it's <15min old
// during trading. >30min old ⇒ the feed is FROZEN (TV bridge down, weekend, CME
// 17:00-18:00 ET halt, or a stale Yahoo fallback) → the "last closed bar" is no
// longer real-time, so strategies must NOT evaluate/fire on it. (getLivePrices
// still reads these raw panes for follow-up TP/SL — but a frozen price can't hit
// new levels anyway.)
const MAX_DATA_AGE_SEC = 30 * 60;
function dataAgeSec(panesByTf, instrument) {
  for (const tf of ['15', '5', '60']) {
    const p = panesByTf.get(`${instrument}|${tf}`);
    if (p?.bars?.length) return Date.now() / 1000 - p.bars[p.bars.length - 1].time;
  }
  return Infinity;
}

// TV-ONLY strategy detection (user directive): only evaluate/fire when this
// instrument's 15m pane is sourced from the real-time TradingView bridge AND
// fresh. If the bridge drops, fetchAllPanes falls back to Yahoo (source 'yahoo')
// — we DO NOT trade on that delayed feed; the instrument goes silent until TV is
// back. (Yahoo deep history under the TV tail is fine — it's old closed bars for
// EMA/ATR, not the trigger bar.) Returns {ok, reason} for a throttled log.
function liveFeedOk(panesByTf, instrument) {
  const src = panesByTf.get(`${instrument}|15`)?.source || '';
  if (!src.startsWith('tradingview')) return { ok: false, reason: `not TV-sourced (${src || 'none'})` };
  const age = dataAgeSec(panesByTf, instrument);
  if (age > MAX_DATA_AGE_SEC) return { ok: false, reason: `stale ${Math.round(age / 60)}min` };
  return { ok: true };
}

function buildInstrumentCtx(instrument, panesByTf) {
  // Anchor on 15m of this instrument; fall back through 60/5/1/D.
  const candidates = ['15', '60', '5', '1', '240', '1D', 'D'];
  let anchor = null, anchorTf = null;
  for (const tf of candidates) {
    const p = panesByTf.get(`${instrument}|${tf}`);
    if (p?.bars?.length) { anchor = p; anchorTf = tf; break; }
  }
  if (!anchor) return null;

  // Anchor on the last CLOSED bar so barTime/lastClose/dateKey aren't the
  // in-progress bar (fall back to the raw anchor only if dropping empties it).
  const anchorClosed = dropFormingBar(anchor, anchorTf);
  const closedBars = anchorClosed.bars.length ? anchorClosed : anchor;
  const lastBar = closedBars.bars[closedBars.bars.length - 1];
  const np = nyParts(lastBar.time);

  const ctx = {
    instrument,
    ts: Date.now(),
    barTime: lastBar.time,
    lastClose: lastBar.close,
    panes: [...panesByTf.entries()].map(([k, p]) => trimmed(dropFormingBar(p, k.split('|')[1]))),
    panesByTf,
    anchorSymbol: INSTRUMENT_META[instrument].symbol,
    anchorResolution: anchor.resolution,
    dateKey: np.dateKey,
    dataSource: 'cloud',
  };
  // ctx.pane(tf) returns THIS instrument's pane at the requested TF, trimmed and
  // with the still-forming bar dropped (closed candles only, like the backtest).
  // ctx.paneFor(asset, tf) is the cross-asset equivalent (silver SMT, DXY, etc).
  // ctx.panesByTf is the RAW map (live bar intact) for callers that need it.
  ctx.pane = (tf) => trimmed(dropFormingBar(panesByTf.get(`${instrument}|${tf}`), tf));
  ctx.paneFor = (asset, tf) => trimmed(dropFormingBar(panesByTf.get(`${asset}|${tf}`), tf));
  return ctx;
}

// Cache last-detect results keyed on the per-instrument anchor bar time.
// The cloud_data_supplement cache returns the SAME pane objects within its 15s
// TTL, so the 3s detector loop sees ~5 ticks of identical data per refresh
// cycle. With identical inputs, evaluate() produces identical results that
// dedup would block anyway. Short-circuiting these saves ~80% of CPU per
// 15s window during the trading day.
let _lastDetect = { sig: null, results: null, bias: null, precheck: null };

// Latest per-instrument price snapshot ({ gold: {last, high, low}, ... }) from
// the freshest intraday pane. The follow-up tracker reads this DIRECTLY (via
// getLivePrices) every tick so open trades are monitored against the live feed
// regardless of whether any strategy emitted a result this bar — and it carries
// the bar HIGH/LOW so an intrabar TP/SL touch (a wick) is caught, not just a
// close-through. Set on every detect() call (both the full and short-circuit
// paths), since panesByTf is available in both.
let _lastPrices = {};
function pricesFromPanes(panesByTf) {
  const out = {};
  for (const inst of INSTRUMENTS) {
    const pane = ['5', '15', '60'].map((tf) => panesByTf.get(`${inst}|${tf}`)).find((p) => p?.bars?.length);
    const b = pane?.bars?.[pane.bars.length - 1];
    if (b && Number.isFinite(b.close)) {
      out[inst] = { last: b.close, high: b.high ?? b.close, low: b.low ?? b.close, time: b.time };
    }
  }
  return out;
}

/** Latest live per-instrument prices ({inst:{last,high,low,time}}) for the follow-up tracker. */
export function getLivePrices() { return _lastPrices; }

function writeBiasSnapshot(biasByInstrument) {
  if (!biasByInstrument || Object.keys(biasByInstrument).length === 0) return;
  try {
    writeFileSync(BIAS_SNAPSHOT + '.tmp', JSON.stringify({ at: Date.now(), bias: biasByInstrument }));
    renameSync(BIAS_SNAPSHOT + '.tmp', BIAS_SNAPSHOT);
  } catch { /* best-effort */ }
}

function writePrecheckSnapshot(precheckRows) {
  if (!precheckRows || precheckRows.length === 0) return;
  try {
    writeFileSync(PRECHECK_SNAPSHOT + '.tmp', JSON.stringify({ at: Date.now(), rows: precheckRows }));
    renameSync(PRECHECK_SNAPSHOT + '.tmp', PRECHECK_SNAPSHOT);
  } catch { /* best-effort */ }
}

// Fetch the OANDA real-time bias panes, never throwing (null on any failure
// so the caller transparently falls back to the Yahoo panes).
async function fetchBiasPanesSafe() {
  try { return await fetchBiasPanes(); }
  catch { return null; }
}

// Build the per-instrument bias snapshot. `biasPanesByTf` is the OANDA
// real-time feed (or the Yahoo panes as fallback); `precheckRows` is the flat
// list of strategy precheck rows used for the strategy-vote half.
//
// Each entry carries staleness metadata (lastBarMs / dataAgeMs) so the bot can
// flag a frozen read instead of presenting stale numbers as a live bias.
// Merge the OANDA/TV bias panes ON TOP of the always-complete main feed.
// OANDA periodically 522s (Cloudflare timeout) and returns a PARTIAL set —
// e.g. nasdaq|60 cached but gold|60 missing. With the old all-or-nothing
// `biasPanes || mainPanes` fallback, a partial OANDA result dropped gold
// entirely (computeInstrumentBias needs 15+60+1D; missing 60 → null → gold
// vanishes from /bias). Overlaying instead guarantees every instrument keeps
// its 15/60/1D from the main Yahoo/TV feed, with OANDA's real-time direction
// layered over wherever it IS available. Direction is basis-insensitive, so
// falling back to the futures feed for a pane is directionally identical.
function mergedBiasPanes(mainPanes, biasPanes) {
  const merged = new Map(mainPanes || []);
  if (biasPanes) for (const [k, v] of biasPanes) if (v?.bars?.length) merged.set(k, v);
  return merged;
}

function computeBiasSnapshot(biasPanesByTf, precheckRows) {
  if (!biasPanesByTf) return {};
  const rowsByInstrument = new Map();
  for (const r of precheckRows || []) {
    if (!rowsByInstrument.has(r.instrument)) rowsByInstrument.set(r.instrument, []);
    rowsByInstrument.get(r.instrument).push(r);
  }
  const now = Date.now();
  const out = {};
  for (const instrument of INSTRUMENTS) {
    const ctx = buildInstrumentCtx(instrument, biasPanesByTf);
    if (!ctx) continue;
    try {
      const structural = computeInstrumentBias(ctx);
      if (!structural) continue;
      const vote = tallyStrategyVote(rowsByInstrument.get(instrument) || []);
      const combined = combineBias(structural, vote);
      const m15 = ctx.pane('15');
      const lastBar = m15?.bars?.length ? m15.bars[m15.bars.length - 1] : null;
      const lastBarMs = lastBar ? lastBar.time * 1000 : null;
      out[instrument] = {
        ...structural,
        strategyVote: vote,
        combined: combined ? { direction: combined.direction, label: combined.label } : null,
        dataSource: m15?.source || ctx.dataSource || 'unknown',
        lastBarMs,
        dataAgeMs: lastBarMs != null ? now - lastBarMs : null,
      };
    } catch (err) { log.warn('bias compute threw', { instrument, err: err.message }); }
  }
  return out;
}

function signatureOf(panesByTf) {
  const parts = [];
  for (const inst of INSTRUMENTS) {
    const anchor = ['15', '60', '5'].map((tf) => panesByTf.get(`${inst}|${tf}`)).find((p) => p?.bars?.length);
    if (!anchor) continue;
    parts.push(`${inst}:${anchor.bars[anchor.bars.length - 1].time}`);
  }
  return parts.join('|');
}

export async function detect() {
  let panesByTf;
  try {
    panesByTf = await fetchAllPanes();
  } catch (err) {
    log.throttled('cloud-data-fail', 30000, () =>
      log.warn('cloud data fetch failed', { err: err.message }));
    return [];
  }
  if (panesByTf.size === 0) return [];

  // Skip the work if no instrument has a new anchor bar since the last call.
  // Returns the cached result array so writeDetectSnapshot keeps the snapshot
  // fresh (with stable contents) and downstream behavior is identical.
  _lastPrices = pricesFromPanes(panesByTf);
  const sig = signatureOf(panesByTf);
  if (sig && sig === _lastDetect.sig && _lastDetect.results) {
    // Strategies are unchanged (no new Yahoo bar), but the OANDA bias feed
    // keeps ticking overnight / weekends / holidays — recompute bias from it
    // so /bias reflects real-time direction instead of re-stamping a frozen
    // read. Falls back to the last bias if OANDA is unavailable.
    const biasPanes = await fetchBiasPanesSafe();
    // Always merge over the main feed so a partial/empty OANDA result never
    // drops an instrument. panesByTf is in scope (fetched at the top of this
    // call) and always carries gold/nasdaq 15/60/1D.
    const freshBias = computeBiasSnapshot(mergedBiasPanes(panesByTf, biasPanes), _lastDetect.precheck);
    writeBiasSnapshot(freshBias);
    writePrecheckSnapshot(_lastDetect.precheck);
    _lastDetect.bias = freshBias;
    return _lastDetect.results;
  }

  refreshConfig();
  refreshForexFactory().catch(() => {});
  const blackout = checkBlackout(Date.now() / 1000, 30);

  const registry = await loadRegistry();
  const allResults = [];
  const precheckRows = [];

  // First pass — collect precheck rows for the strategy-vote half of bias.
  // The bot's /setups reads these too, so the work is shared.
  for (const instrument of INSTRUMENTS) {
    if (!liveFeedOk(panesByTf, instrument).ok) continue; // TV-only + fresh → else no forming display
    const ctx = buildInstrumentCtx(instrument, panesByTf);
    if (!ctx) continue;
    for (const s of registry) {
      if (!isStrategyEnabled(s.id)) continue;
      if (!s.instruments.includes(instrument)) continue;
      if (typeof s.precheck !== 'function') continue;
      try {
        const pc = s.precheck(ctx);
        if (pc) precheckRows.push({ strategy: s.id, instrument, ...pc });
      } catch (err) {
        log.warn('strategy precheck threw', { strategy: s.id, instrument, err: err.message });
      }
    }
  }

  // Bias = structural multi-TF read (OANDA real-time feed) + live strategy
  // vote, combined. Strategies below stay on the Yahoo (futures) panes; only
  // the directional bias uses OANDA. Falls back to Yahoo if OANDA is down.
  const biasPanes = await fetchBiasPanesSafe();
  const biasByInstrument = computeBiasSnapshot(mergedBiasPanes(panesByTf, biasPanes), precheckRows);

  for (const instrument of INSTRUMENTS) {
    const feed = liveFeedOk(panesByTf, instrument);
    if (!feed.ok) {
      log.throttled(`feed-${instrument}`, 300000, () =>
        log.warn('skipping strategy eval — not real-time TV data', { instrument, reason: feed.reason }));
      continue;
    }
    const ctx = buildInstrumentCtx(instrument, panesByTf);
    if (!ctx) continue;

    const results = [];
    for (const s of registry) {
      if (!isStrategyEnabled(s.id)) continue;
      if (!s.instruments.includes(instrument)) continue;
      try { results.push(...s.evaluate(ctx)); }
      catch (err) {
        log.error('strategy evaluator threw', { strategy: s.id, instrument, err: err.message, stack: err.stack });
      }
    }
    try { results.push(...evaluateUserStrategies(ctx, isStrategyEnabled)); }
    catch (err) { log.error('user strategies threw', { instrument, err: err.message, stack: err.stack }); }

    for (const r of results) {
      r.instrument = instrument;
      r.symbol = ctx.anchorSymbol;
      if (!r.timeframe) r.timeframe = ctx.anchorResolution;
      r.lastClose = ctx.lastClose;
      r.barTime = ctx.barTime;
      if (!r.setupId.startsWith(`${instrument}|`)) r.setupId = `${instrument}|${r.setupId}`;
    }
    allResults.push(...results);
  }

  // 15m+ gate — strategies emitting on 5m/1m don't reach the user.
  const TF_MIN = { '1': 1, '3': 3, '5': 5, '15': 15, '30': 30, '60': 60, '240': 240, 'D': 1440, '1D': 1440, 'W': 10080 };
  const filtered = allResults.filter((r) => (TF_MIN[String(r.timeframe)] || 0) >= 15);

  // News blackout: soft-block triggered setups ±30m of high-impact events.
  if (blackout.blocked) {
    for (const r of filtered) {
      if (r.status === 'triggered') {
        r.status = 'invalidated';
        r.invalidReason = `news blackout: ${blackout.event?.title || 'high-impact event'} ±30m`;
      }
    }
  }

  // Persist the bias snapshot so /bias reads a fresh structural read instantly.
  writeBiasSnapshot(biasByInstrument);
  writePrecheckSnapshot(precheckRows);

  _lastDetect = { sig, results: filtered, bias: biasByInstrument, precheck: precheckRows };
  return filtered;
}
