/**
 * Backtest harness.
 *
 * Walk-forward replay using Yahoo Finance bars (same source the live system
 * now uses). For each anchor bar, builds a synthetic ctx with bars up to
 * that point, runs each enabled strategy, queues triggered alerts as limit
 * orders, simulates against subsequent bars (stop checked first, then TPs),
 * and reports per-strategy win rate / R-sum / setup frequency.
 *
 * Two invocation modes:
 *   1. CLI: `node src/backtest.js` (or `--weekly`, `--strategy TRINITY`, etc.)
 *   2. Programmatic: `import { runBacktest } from './backtest.js'`
 *
 * Limitations to be honest about:
 *   - Yahoo intraday history: 1m=7d, 5m/15m=60d, 1h=730d, 1d=years. We use
 *     a 7-day window by default for the weekly job.
 *   - 7 days × M15 ≈ 670 bars per pane = ~30-50 anchor ticks in walk-forward.
 *     That's a small sample. Conclusions are directional, not statistical.
 *   - Stop-vs-TP ordering is pessimistic: if both hit on the same bar we
 *     count it as a stop. Real-world fills depend on intra-bar ordering.
 */

import { fetchBars as fetchYahoo } from './cloud/yahoo.js';
import { evaluateUserStrategies, list as listUserStrategies } from './lib/user_strategies.js';
import { loadRegistry } from './lib/strategy_registry.js';
import { nyParts } from './lib/time.js';
import { get as getRuntimeConfig } from './lib/runtime_config.js';
import { appendTrade, sessionLabel } from './lib/trade_log.js';

function userStrategyEntry(spec) {
  return {
    name: spec.id,
    num: 'U',
    label: spec.name || spec.id,
    fn: (ctx) => evaluateUserStrategies(ctx, (k) => k === spec.id),
  };
}

/**
 * Full strategy registry for the backtest. Async because it loads from
 * the file-based strategy_registry. Re-reads user strategies each call.
 */
export async function getAllStrategies() {
  const reg = await loadRegistry();
  const builtins = reg.map((s, i) => ({
    name: s.id, num: i + 1, fn: s.evaluate, label: s.name,
  }));
  return [...builtins, ...listUserStrategies().map(userStrategyEntry)];
}

// All three primary instruments are fetched. Gold-only strategies (Gold/Silver
// SMT, DXY-driven gold bias, Trinity, etc.) simply produce no triggered results
// when ctx.instrument !== 'gold'; the walk still runs them.
const INSTRUMENTS = ['gold', 'nasdaq', 'sp'];
const INSTRUMENT_META = {
  gold:   { pair: 'XAUUSD', symbol: 'MGC1!', dollarPerPoint: 10 }, // MGC = $10/point
  nasdaq: { pair: 'NQ100',  symbol: 'MNQ1!', dollarPerPoint: 2 },  // MNQ = $2/point
  sp:     { pair: 'SP500',  symbol: 'MES1!', dollarPerPoint: 5 },  // MES = $5/point
};

const PANE_REQUESTS = [
  ['gold',   '1'], ['gold',   '5'], ['gold',   '15'], ['gold',   '60'], ['gold',   '1D'],
  ['nasdaq', '5'], ['nasdaq', '15'], ['nasdaq', '60'], ['nasdaq', '1D'],
  ['sp',     '5'], ['sp',     '15'], ['sp',     '60'], ['sp',     '1D'],
  ['silver', '5'], ['silver', '15'],
  ['dxy',    '1D'],
];

async function fetchAllPanes() {
  const map = new Map();
  await Promise.all(PANE_REQUESTS.map(async ([asset, tf]) => {
    try {
      const pane = await fetchYahoo(asset, tf);
      if (pane?.bars?.length) map.set(`${asset}|${tf}`, pane);
    } catch {}
  }));
  return map;
}

function trimToWindow(panesByTf, sinceUnix) {
  const out = new Map();
  for (const [k, p] of panesByTf) {
    const bars = p.bars.filter((b) => b.time >= sinceUnix);
    if (bars.length >= 30) out.set(k, { ...p, bars });
  }
  return out;
}

function buildCtxFromMaps(panesByTf, lastBarIdxByKey, instrument = 'gold') {
  const ctxPanes = new Map();
  let anchor = null;
  // Strategies need at most ~120 bars of history; cap the slice at 400 so the
  // walk-forward doesn't copy 11k-bar panes on every tick. Keeps the backtest
  // fast without changing any signal (all indicators converge well under 400).
  const MAX_CTX_BARS = 400;
  for (const [key, p] of panesByTf) {
    const idx = lastBarIdxByKey.get(key) ?? p.bars.length - 1;
    if (idx < 30) continue;
    const sliceStart = Math.max(0, idx + 1 - MAX_CTX_BARS);
    const slice = p.bars.slice(sliceStart, idx + 1);
    ctxPanes.set(key, { ...p, bars: slice });
    if (!anchor && (key === `${instrument}|5` || key === `${instrument}|15`)) {
      anchor = ctxPanes.get(key);
    }
  }
  if (!anchor) {
    for (const [k, p] of ctxPanes) {
      if (k.startsWith(`${instrument}|`)) { anchor = p; break; }
    }
  }
  if (!anchor) return null;
  const last = anchor.bars[anchor.bars.length - 1];
  const np = nyParts(last.time);
  return {
    instrument,
    ts: last.time * 1000,
    barTime: last.time,
    lastClose: last.close,
    panes: [...ctxPanes.values()],
    panesByTf: ctxPanes,
    pane: (tf) => ctxPanes.get(`${instrument}|${tf}`),
    anchorSymbol: anchor.symbol,
    anchorResolution: anchor.resolution,
    dateKey: np.dateKey,
  };
}

function simulateTrade(bars, trade, opts = {}) {
  const maxBars = opts.maxBars ?? 200;
  const { direction, entry, stop, t1, t2, openIdx, risk } = trade;
  for (let i = openIdx + 1; i < Math.min(bars.length, openIdx + maxBars); i++) {
    const b = bars[i];
    if (direction === 'LONG') {
      if (b.low <= stop) return { exit: stop, exitIdx: i, R: -1, reason: 'SL' };
      if (t2 != null && b.high >= t2) return { exit: t2, exitIdx: i, R: Math.abs(t2 - entry) / risk, reason: 'TP2' };
      if (t1 != null && b.high >= t1) return { exit: t1, exitIdx: i, R: Math.abs(t1 - entry) / risk, reason: 'TP1' };
    } else {
      if (b.high >= stop) return { exit: stop, exitIdx: i, R: -1, reason: 'SL' };
      if (t2 != null && b.low <= t2) return { exit: t2, exitIdx: i, R: Math.abs(entry - t2) / risk, reason: 'TP2' };
      if (t1 != null && b.low <= t1) return { exit: t1, exitIdx: i, R: Math.abs(entry - t1) / risk, reason: 'TP1' };
    }
  }
  const last = bars[Math.min(bars.length - 1, openIdx + maxBars - 1)];
  if (!last) return null;
  const R = direction === 'LONG' ? (last.close - entry) / risk : (entry - last.close) / risk;
  return { exit: last.close, exitIdx: Math.min(bars.length - 1, openIdx + maxBars - 1), R, reason: 'time' };
}

/**
 * The main programmatic entry point.
 *
 * @param {object} opts
 * @param {string[]} [opts.strategies]  Names to include; default: enabled in config
 * @param {number} [opts.days]          Lookback window in days (default 7)
 * @param {number} [opts.step]          Anchor step in bars (default 1)
 * @param {number} [opts.confMin]       Quality filter on triggered confidence (default 0.7)
 * @returns {Promise<{ stats, panesSummary, window }>}
 */
export async function runBacktest(opts = {}) {
  const days = opts.days ?? 7;
  const step = opts.step ?? 1;
  const confMin = opts.confMin ?? 0.7;
  const cfg = getRuntimeConfig();
  const enabledNames = opts.strategies?.length
    ? opts.strategies
    : Object.entries(cfg.strategies).filter(([, v]) => v).map(([k]) => k);
  // Accept multiple identifiers per strategy: full key (TRINITY), display num
  // (1..10), or any case variant. Normalize before matching.
  const requested = new Set(enabledNames.map((n) => String(n).toUpperCase()));
  const ALL = await getAllStrategies();
  const selected = ALL.filter((s) =>
    requested.has(String(s.name).toUpperCase()) || requested.has(String(s.num).toUpperCase())
  );
  if (selected.length === 0) {
    return { error: 'no strategies to backtest', stats: {}, panesSummary: [], window: null };
  }

  const panesByTfFull = await fetchAllPanes();
  if (panesByTfFull.size === 0) {
    return { error: 'no Yahoo data', stats: {}, panesSummary: [], window: null };
  }

  // Trim every pane to the last `days` days
  const sinceUnix = Math.floor(Date.now() / 1000) - days * 86400;
  const panesByTf = trimToWindow(panesByTfFull, sinceUnix);
  if (panesByTf.size === 0) {
    return { error: 'no panes after trim', stats: {}, panesSummary: [], window: null };
  }

  // Bookkeeping — stats are aggregate across instruments; trades carry an
  // `instrument` field so downstream can group/filter.
  const stats = {};
  for (const s of selected) {
    stats[s.name] = {
      name: s.name, num: s.num, label: s.label,
      ticksRun: 0, formingCount: 0, nearTriggerCount: 0,
      triggeredCount: 0, uniqueTriggered: 0, invalidatedCount: 0,
      limitsExpired: 0, trades: [],
    };
  }

  let firstAnchorTime = null, lastAnchorTime = null;
  const panesSummary = [...panesByTf.entries()].map(([k, p]) => `${k}=${p.bars.length}`);
  let walkedInstruments = 0;
  let lastAnchorTF = '5m';

  for (const inst of INSTRUMENTS) {
    const anchorKey = [`${inst}|5`, `${inst}|15`, `${inst}|60`].find((k) => panesByTf.has(k));
    if (!anchorKey) continue;
    const anchorPane = panesByTf.get(anchorKey);
    const total = anchorPane.bars.length;
    if (total < 50) continue;
    const warmup = Math.min(80, Math.floor(total * 0.15));
    walkedInstruments++;
    lastAnchorTF = anchorKey.split('|')[1] + 'm';
    const t0 = anchorPane.bars[0].time, tN = anchorPane.bars[total - 1].time;
    if (firstAnchorTime == null || t0 < firstAnchorTime) firstAnchorTime = t0;
    if (lastAnchorTime == null || tN > lastAnchorTime) lastAnchorTime = tN;

    // Per-instrument dedup + pending-limits buckets (kept inside the inst loop
    // so a setupId in gold doesn't accidentally suppress the same id in nasdaq)
    const seenSetupIds = {};
    const pendingLimits = {};
    for (const s of selected) { seenSetupIds[s.name] = new Set(); pendingLimits[s.name] = []; }

    for (let i = warmup; i < total; i += step) {
      const anchorTime = anchorPane.bars[i].time;
      const lastBarIdx = new Map();
      for (const [k, p] of panesByTf) {
        // binary search for last bar with time <= anchorTime
        let lo = 0, hi = p.bars.length - 1, idx = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (p.bars[mid].time <= anchorTime) { idx = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (idx >= 0) lastBarIdx.set(k, idx);
      }
      const ctx = buildCtxFromMaps(panesByTf, lastBarIdx, inst);
      if (!ctx) continue;

      for (const s of selected) {
        const st = stats[s.name];
        st.ticksRun++;
        let results;
        try { results = s.fn(ctx) || []; } catch { continue; }
        for (const r of results) {
          if (r.status === 'forming') st.formingCount++;
          else if (r.status === 'near_trigger') st.nearTriggerCount++;
          else if (r.status === 'invalidated') st.invalidatedCount++;
          else if (r.status === 'triggered' && r.entryPlan && r.direction !== 'NONE') {
            st.triggeredCount++;
            const dedupId = `${inst}|${r.setupId}`;
            if (seenSetupIds[s.name].has(dedupId)) continue;
            if ((r.confidence || 0) < confMin) {
              seenSetupIds[s.name].add(dedupId);
              continue;
            }
            seenSetupIds[s.name].add(dedupId);
            st.uniqueTriggered++;
            pendingLimits[s.name].push({
              instrument: inst,
              direction: r.direction, entry: r.entryPlan.entry, stop: r.entryPlan.stop,
              t1: r.entryPlan.t1, t2: r.entryPlan.t2,
              risk: r.entryPlan.risk ?? Math.abs(r.entryPlan.entry - r.entryPlan.stop),
              placedIdx: i, placedTime: anchorTime,
              setupId: r.setupId, confidence: r.confidence,
              expiresIdx: i + 40,
            });
          }
        }
      }

      // Process pending limits against this anchor bar
      for (const s of selected) {
        const arr = pendingLimits[s.name];
        const st = stats[s.name];
        const remaining = [];
        for (const lim of arr) {
          if (i >= lim.expiresIdx) { st.limitsExpired++; continue; }
          const bar = anchorPane.bars[i];
          const fill = (lim.direction === 'LONG' && bar.low <= lim.entry) ||
                       (lim.direction === 'SHORT' && bar.high >= lim.entry);
          if (!fill) {
            const stopFirst = (lim.direction === 'LONG' && bar.low <= lim.stop) ||
                              (lim.direction === 'SHORT' && bar.high >= lim.stop);
            if (stopFirst) { st.limitsExpired++; continue; }
            remaining.push(lim);
            continue;
          }
          const outcome = simulateTrade(anchorPane.bars, { ...lim, openIdx: i });
          if (outcome) {
            st.trades.push({
              ...lim, openIdx: i, openTime: bar.time,
              exit: outcome.exit, exitIdx: outcome.exitIdx, exitReason: outcome.reason,
              R: outcome.R, win: outcome.R > 0,
            });
          }
        }
        pendingLimits[s.name] = remaining;
      }
    }
  }

  if (walkedInstruments === 0) {
    return { error: 'no anchor pane on any instrument', stats: {}, panesSummary, window: null };
  }

  const window = {
    days,
    fromUnix: firstAnchorTime,
    toUnix: lastAnchorTime,
    anchorTF: lastAnchorTF,
    instruments: INSTRUMENTS,
  };

  // Compute summary metrics per strategy + log every trade to the JSONL
  for (const name of Object.keys(stats)) {
    const s = stats[name];
    const trades = s.trades;
    s.tradeCount = trades.length;
    s.wins = trades.filter((t) => t.win).length;
    s.losses = trades.length - s.wins;
    s.winRate = trades.length ? (s.wins / trades.length) : 0;
    s.sumR = trades.reduce((a, b) => a + b.R, 0);
    s.avgR = trades.length ? s.sumR / trades.length : 0;
    s.bestR = trades.length ? Math.max(...trades.map((t) => t.R)) : 0;
    s.worstR = trades.length ? Math.min(...trades.map((t) => t.R)) : 0;

    // Profit Factor: gross R won / gross |R lost|
    const grossWin = trades.filter((t) => t.R > 0).reduce((a, b) => a + b.R, 0);
    const grossLoss = Math.abs(trades.filter((t) => t.R < 0).reduce((a, b) => a + b.R, 0));
    s.profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

    // Expectancy per trade (already = avgR, but compute formal version for clarity)
    const avgWin = s.wins > 0 ? grossWin / s.wins : 0;
    const avgLoss = s.losses > 0 ? -grossLoss / s.losses : 0; // negative
    s.avgWin = avgWin;
    s.avgLoss = avgLoss;
    s.expectancy = s.winRate * avgWin + (1 - s.winRate) * avgLoss;

    // Max drawdown on an equity curve (cumulative R, starting at 0)
    let equity = 0, peak = 0, maxDD = 0;
    for (const t of trades) {
      equity += t.R;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDD) maxDD = dd;
    }
    s.maxDrawdownR = maxDD;

    // Sharpe-ish ratio: mean(R) / stddev(R). Annualization would need
    // trades-per-year context, which we don't have, so report the raw ratio.
    if (trades.length >= 2) {
      const mean = s.avgR;
      const variance = trades.reduce((a, t) => a + Math.pow(t.R - mean, 2), 0) / (trades.length - 1);
      const sd = Math.sqrt(variance);
      s.sharpe = sd > 0 ? mean / sd : 0;
    } else {
      s.sharpe = 0;
    }

    // Max consecutive losses
    let curStreak = 0, maxStreak = 0;
    for (const t of trades) {
      if (t.R < 0) { curStreak++; if (curStreak > maxStreak) maxStreak = curStreak; }
      else curStreak = 0;
    }
    s.maxConsecutiveLosses = maxStreak;

    // Long vs Short split
    const longs = trades.filter((t) => t.direction === 'LONG');
    const shorts = trades.filter((t) => t.direction === 'SHORT');
    s.longCount = longs.length;
    s.shortCount = shorts.length;
    s.longWinRate = longs.length ? longs.filter((t) => t.win).length / longs.length : 0;
    s.shortWinRate = shorts.length ? shorts.filter((t) => t.win).length / shorts.length : 0;
    s.longSumR = longs.reduce((a, b) => a + b.R, 0);
    s.shortSumR = shorts.reduce((a, b) => a + b.R, 0);

    // Session performance — group by NY-local session of the open time
    s.sessionPerf = {};
    for (const t of trades) {
      const sess = sessionLabel(t.openTime || 0);
      const bucket = s.sessionPerf[sess] || { count: 0, wins: 0, sumR: 0 };
      bucket.count++;
      if (t.win) bucket.wins++;
      bucket.sumR += t.R;
      s.sessionPerf[sess] = bucket;
    }

    // Average duration (in minutes — bars × anchor TF minutes)
    // anchor TF is 5m, so each bar between entry & exit is 5 minutes
    const ANCHOR_MIN = 5;
    const durations = trades.map((t) => (t.exitIdx - t.openIdx) * ANCHOR_MIN);
    s.avgDurationMin = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

    // Average / median RR achieved on winners
    const winRRs = trades.filter((t) => t.win).map((t) => t.R);
    s.avgWinR = winRRs.length ? winRRs.reduce((a, b) => a + b, 0) / winRRs.length : 0;

    // Net dollars per trade — multiply R × risk-in-price-points × $/point for the
    // instrument that trade was placed on. Gold ≈ $10/point (MGC), Nasdaq ≈ $2 (MNQ),
    // S&P ≈ $5 (MES). Defaults to $1/point if instrument unknown (back-compat).
    const netDollars = trades.reduce((a, t) => {
      const mult = INSTRUMENT_META[t.instrument]?.dollarPerPoint ?? 1;
      return a + t.R * (t.risk || 0) * mult;
    }, 0);
    s.netDollars = netDollars;
    // Legacy "netPips" — only meaningful for gold (cents). Set null for mixed/other.
    s.netPips = null;

    // Average confidence and A+ subset
    const confs = trades.map((t) => t.confidence || 0);
    s.avgConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
    s.aPlusCount = trades.filter((t) => (t.confidence || 0) >= 0.85).length;
    s.aPlusWinRate = s.aPlusCount > 0
      ? trades.filter((t) => (t.confidence || 0) >= 0.85 && t.win).length / s.aPlusCount
      : 0;

    // Append each trade to the JSONL log in the requested format
    for (const t of trades) {
      const meta = INSTRUMENT_META[t.instrument] || { pair: 'UNKNOWN', dollarPerPoint: 1 };
      appendTrade({
        strategy: name,
        instrument: t.instrument,
        pair: meta.pair,
        direction: t.direction,
        entry: t.entry,
        sl: t.stop,
        tp: t.t1,
        risk_reward: t.risk > 0 ? Math.abs(t.t1 - t.entry) / t.risk : null,
        result_R: t.R,
        result_dollars: t.R * (t.risk || 0) * meta.dollarPerPoint,
        result_pips: t.instrument === 'gold' ? Math.round(t.R * (t.risk || 0) * 100) : null,
        duration_minutes: (t.exitIdx - t.openIdx) * ANCHOR_MIN,
        session: sessionLabel(t.openTime || 0),
        outcome: t.win ? 'WIN' : (t.R === 0 ? 'BREAKEVEN' : 'LOSS'),
        exit_reason: t.exitReason || 'unknown',
        confidence: t.confidence,
        opened_at: new Date((t.openTime || 0) * 1000).toISOString(),
        closed_at: new Date((t.placedTime || t.openTime || 0) * 1000).toISOString(),
      }, 'backtest');
    }

    // Per-instrument breakdown so reports can show "USLS on gold: 8W/3L, nasdaq: 2W/2L".
    s.byInstrument = {};
    for (const inst of INSTRUMENTS) {
      const sub = trades.filter((t) => t.instrument === inst);
      if (sub.length === 0) continue;
      const wins = sub.filter((t) => t.win).length;
      s.byInstrument[inst] = {
        tradeCount: sub.length,
        wins,
        losses: sub.length - wins,
        winRate: wins / sub.length,
        sumR: sub.reduce((a, b) => a + b.R, 0),
        avgR: sub.reduce((a, b) => a + b.R, 0) / sub.length,
      };
    }
  }

  return { stats, panesSummary, window };
}

// ---------- Suggestion engine ----------
// Heuristic refinements based on observed stats. Output suggestions only;
// user opts in by editing strategy code or /apply (TBD). Never auto-modify.

export function suggestionsFor(stats) {
  const out = [];
  for (const s of Object.values(stats)) {
    const tc = s.tradeCount;
    if (tc === 0) {
      out.push({
        strategy: s.name, num: s.num,
        suggestion: 'No trades fired this week. Consider widening proximity thresholds or relaxing required confluences. May also indicate quiet market — re-check next week.',
        kind: 'no-trades',
      });
      continue;
    }
    // 1) Win rate too low
    if (s.winRate < 0.33 && tc >= 5) {
      out.push({
        strategy: s.name, num: s.num,
        suggestion: `Win rate ${(s.winRate*100).toFixed(0)}% on ${tc} trades. Try tightening MSS displacement threshold (1.0→1.3 ATR) or requiring confidence ≥ 0.80 to filter weak setups.`,
        kind: 'low-winrate',
      });
    }
    // 2) Negative expectancy
    if (s.avgR < 0 && tc >= 5) {
      out.push({
        strategy: s.name, num: s.num,
        suggestion: `Avg ${s.avgR.toFixed(2)}R/trade is negative. Most exits hit SL — widen stop buffer (e.g. 0.1→0.3 ATR) so normal noise doesn't blow up trades.`,
        kind: 'negative-expectancy',
      });
    }
    // 3) Few setups
    if (tc < 3) {
      out.push({
        strategy: s.name, num: s.num,
        suggestion: `Only ${tc} setup${tc === 1 ? '' : 's'} fired. Loosen sweep-detection lookback or accept lower confidence (0.7→0.6) for more action — but watch win rate.`,
        kind: 'few-setups',
      });
    }
    // 4) A+ subset materially better
    if (s.aPlusCount >= 3 && s.aPlusWinRate > s.winRate + 0.15) {
      out.push({
        strategy: s.name, num: s.num,
        suggestion: `A+ subset (conf≥0.85): ${s.aPlusCount} trades at ${(s.aPlusWinRate*100).toFixed(0)}% win rate vs ${(s.winRate*100).toFixed(0)}% overall. Consider raising confMin to 0.85 — fewer trades but materially higher quality.`,
        kind: 'a-plus-edge',
      });
    }
    // 5) Excellent: net + and decent win rate
    if (s.avgR >= 0.3 && s.winRate >= 0.4 && tc >= 5) {
      out.push({
        strategy: s.name, num: s.num,
        suggestion: `Performing well: ${(s.winRate*100).toFixed(0)}% wins, ${s.avgR.toFixed(2)}R/trade. Hold current settings; consider increasing position size or applying to live.`,
        kind: 'healthy',
      });
    }
  }
  return out;
}

// ---------- Telegram-ready formatter ----------

function fmtR(r) {
  const n = Number(r) || 0;
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}R`;
}

export function formatTelegramSummary({ stats, panesSummary, window }, suggestions = []) {
  const BAR = '══════════════════';
  const lines = [];
  lines.push(BAR);
  lines.push(`📊 *BACKTEST RESULTS*`);
  if (window) {
    const from = new Date(window.fromUnix * 1000).toISOString().slice(0, 10);
    const to = new Date(window.toUnix * 1000).toISOString().slice(0, 10);
    lines.push(`${from} → ${to} · anchor ${window.anchorTF}`);
  }
  lines.push(BAR);
  lines.push('');

  const allStats = Object.values(stats);
  const totalTrades = allStats.reduce((a, b) => a + b.tradeCount, 0);
  const totalWins = allStats.reduce((a, b) => a + b.wins, 0);
  const totalR = allStats.reduce((a, b) => a + b.sumR, 0);
  const combinedWR = totalTrades ? (totalWins / totalTrades) : 0;

  lines.push(`Total trades: *${totalTrades}* across ${allStats.length} strategies`);
  lines.push(`Combined: ${fmtR(totalR)} · win rate ${(combinedWR * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('*PER-STRATEGY*');

  for (const s of allStats) {
    if (s.tradeCount === 0) {
      lines.push('');
      lines.push(`#${s.num} ${s.label}: _no setups fired_`);
      continue;
    }
    lines.push('');
    lines.push(`#${s.num} *${s.label}*`);
    lines.push('```');
    lines.push(`Trades        ${s.tradeCount}    Wins ${s.wins}/${s.tradeCount} (${(s.winRate*100).toFixed(0)}%)`);
    lines.push(`Sum R         ${fmtR(s.sumR).padEnd(8)}  Avg ${fmtR(s.avgR)}/trade`);
    lines.push(`Net dollars   $${s.netDollars.toFixed(2)} (${s.netPips} pips)`);
    lines.push(`Profit factor ${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'}`);
    lines.push(`Expectancy    ${fmtR(s.expectancy)}/trade`);
    lines.push(`Avg win       ${fmtR(s.avgWin)}    Avg loss ${fmtR(s.avgLoss)}`);
    lines.push(`Max DD        ${fmtR(-s.maxDrawdownR)}     Sharpe ${s.sharpe.toFixed(2)}`);
    lines.push(`Best          ${fmtR(s.bestR).padEnd(8)}  Worst ${fmtR(s.worstR)}`);
    lines.push(`Max consec L  ${s.maxConsecutiveLosses}`);
    lines.push(`Avg duration  ${Math.round(s.avgDurationMin)}m`);
    lines.push(`Long          ${s.longCount} (${(s.longWinRate*100).toFixed(0)}%) ${fmtR(s.longSumR)}`);
    lines.push(`Short         ${s.shortCount} (${(s.shortWinRate*100).toFixed(0)}%) ${fmtR(s.shortSumR)}`);
    if (Object.keys(s.sessionPerf || {}).length > 0) {
      const sessions = Object.entries(s.sessionPerf).map(([sess, b]) =>
        `${sess} ${b.count}(${Math.round(b.wins/b.count*100)}%)`
      ).join(' · ');
      lines.push(`By session    ${sessions}`);
    }
    if (s.aPlusCount > 0) {
      lines.push(`A+ subset     ${s.aPlusCount} trades, ${(s.aPlusWinRate*100).toFixed(0)}% wins`);
    }
    lines.push('```');
  }

  if (suggestions.length > 0) {
    lines.push('');
    lines.push('🔧 *SUGGESTIONS*');
    for (const sg of suggestions) {
      const tag = sg.kind === 'healthy' ? '✅' : sg.kind === 'a-plus-edge' ? '⭐' : '⚠️';
      lines.push('');
      lines.push(`${tag} *#${sg.num} ${sg.strategy}*`);
      lines.push(sg.suggestion);
    }
  }
  lines.push('');
  lines.push(`_Panes: ${panesSummary?.join(', ') || '(none)'}_`);
  lines.push(BAR);
  return lines.join('\n');
}

// ---------- CLI ----------

async function sendTelegram(text) {
  // Read creds from .env (works in both LaunchAgent and manual run contexts)
  const { readFileSync } = await import('node:fs');
  let TOKEN = '', CHAT = '';
  try {
    const env = Object.fromEntries(
      readFileSync('/Users/jqvier/.config/trading-alerts/.env', 'utf8')
        .split('\n').filter((l) => l.includes('=')).map((l) => l.split('=', 2))
    );
    TOKEN = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
    CHAT  = env.TELEGRAM_CHAT_ID   || process.env.TELEGRAM_CHAT_ID   || '';
  } catch {
    TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    CHAT  = process.env.TELEGRAM_CHAT_ID || '';
  }
  if (!TOKEN || !CHAT) {
    console.error('No Telegram creds available');
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT, text, parse_mode: 'Markdown', disable_web_page_preview: true,
    }),
  });
  if (!res.ok) { console.error('telegram send failed:', res.status); return false; }
  return true;
}

async function cli() {
  const argv = process.argv.slice(2);
  const weekly = argv.includes('--weekly');
  const sIdx = argv.indexOf('--strategy');
  const strategy = sIdx >= 0 ? argv[sIdx + 1] : null;
  const dIdx = argv.indexOf('--days');
  const days = dIdx >= 0 ? parseInt(argv[dIdx + 1], 10) || 7 : 7;
  const post = weekly || argv.includes('--post');

  console.log(`Running backtest (days=${days}, strategy=${strategy || 'enabled'}, post=${post})…`);
  const opts = { days };
  if (strategy) opts.strategies = [strategy];
  const result = await runBacktest(opts);
  if (result.error) {
    console.error('Backtest error:', result.error);
    if (post) await sendTelegram(`⚠️ Backtest failed: ${result.error}`);
    process.exit(1);
  }
  const suggestions = suggestionsFor(result.stats);
  const text = formatTelegramSummary(result, suggestions);
  console.log(text);
  if (post) await sendTelegram(text);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((err) => {
    console.error('Backtest crashed:', err.message, err.stack);
    process.exit(2);
  });
}
