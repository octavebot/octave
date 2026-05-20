/**
 * Backtest harness.
 *
 * Pulls historical bars from each TV pane (limited to ~500 per pane by TV's CDP),
 * replays them bar-by-bar, and runs each strategy's evaluator against a synthetic
 * `ctx` containing only bars up to that point ("walk-forward" replay).
 *
 * For each `triggered` alert, simulates the trade against subsequent bars:
 *   - LONG: stop hit if low ≤ stop; TP1 hit if high ≥ t1
 *   - SHORT: stop hit if high ≥ stop; TP1 hit if low ≤ t1
 *
 * Outputs win-rate, average R, setup frequency, per-strategy.
 *
 * Run: `node src/backtest.js`
 */

import { snapshotAllPanes } from './lib/panes.js';
import { evaluateUSLS } from './strategies/usls.js';
import { evaluateICTSMC } from './strategies/ict_smc.js';
import { evaluateAlgoSMC } from './strategies/algo_smc.js';
import { evaluateAdaptive } from './strategies/adaptive.js';
import { nyParts } from './lib/time.js';

const STRATEGIES = [
  { name: 'USLS',      fn: evaluateUSLS },
  { name: 'ICT-SMC',   fn: evaluateICTSMC },
  { name: 'ALGO-SMC',  fn: evaluateAlgoSMC },
  { name: 'ADAPTIVE',  fn: evaluateAdaptive },
];

function indexPanesByGoldOrAux(panes) {
  const m = new Map();
  for (const p of panes) {
    if (p.error || !p.bars) continue;
    const sym = String(p.symbol || '').toUpperCase();
    const res = String(p.resolution);
    if (/GC1|MGC1|XAU|GOLD|GCJ|GCM|GCN|GCQ|GCV|GCZ|GCG/i.test(sym)) m.set(`gold|${res}`, p);
    if (/DXY|US Dollar Index|TVC:DXY|USDOLLAR/i.test(sym)) m.set(`dxy|${res}`, p);
    if (/XAG|SI1!|^SI$|SILVER|SIL_|MSI1/i.test(sym)) m.set(`silver|${res}`, p);
  }
  return m;
}

function buildBacktestCtx(allPanesByTf, lastBarIdxByKey) {
  // For each pane, slice bars to [0 .. lastBarIdx] (inclusive)
  const panesByTf = new Map();
  let anchorClose = null;
  let anchorTime = null;
  let anchorSym = null;
  let anchorRes = null;
  for (const [key, p] of allPanesByTf) {
    const idx = lastBarIdxByKey.get(key) ?? p.bars.length - 1;
    const slice = p.bars.slice(0, idx + 1);
    if (slice.length < 30) continue;
    panesByTf.set(key, { ...p, bars: slice });
    if (key.startsWith('gold|')) {
      const last = slice[slice.length - 1];
      if (!anchorClose || (key === 'gold|5' || key === 'gold|15')) {
        anchorClose = last.close;
        anchorTime = last.time;
        anchorSym = p.symbol;
        anchorRes = p.resolution;
      }
    }
  }
  if (!anchorTime) return null;
  const np = nyParts(anchorTime);
  return {
    ts: anchorTime * 1000,
    barTime: anchorTime,
    lastClose: anchorClose,
    panes: [...panesByTf.values()],
    panesByTf,
    anchorSymbol: anchorSym,
    anchorResolution: anchorRes,
    dateKey: np.dateKey,
  };
}

/**
 * Walk forward through the LTF anchor pane and call strategies on each step.
 * Tracks triggered alerts as candidate trades and simulates outcomes.
 */
function runBacktest(allPanesByTf, opts = {}) {
  // Anchor: prefer 5m gold, fall back to 15m, then 1H.
  const anchorKey = ['gold|5', 'gold|15', 'gold|60', 'gold|240'].find((k) => allPanesByTf.has(k));
  if (!anchorKey) {
    console.log('No suitable gold pane for backtest anchor (need 5m/15m/1H/4H).');
    return null;
  }
  const anchorPane = allPanesByTf.get(anchorKey);
  const total = anchorPane.bars.length;
  const warmup = Math.min(80, Math.floor(total * 0.25));
  const step = opts.step ?? 1;

  // Per-strategy bookkeeping
  const stats = {};
  const seenSetupIds = {}; // strategyName → Set of setupIds already simulated
  const pendingLimits = {}; // strategyName → array of pending limit orders
  for (const s of STRATEGIES) {
    stats[s.name] = {
      ticksRun: 0,
      ticksWithResult: 0,
      formingCount: 0,
      nearTriggerCount: 0,
      triggeredCount: 0,
      invalidatedCount: 0,
      uniqueTriggered: 0,
      limitsExpired: 0,
      trades: [],
    };
    seenSetupIds[s.name] = new Set();
    pendingLimits[s.name] = [];
  }

  // Walk forward on the anchor pane
  for (let i = warmup; i < total; i += step) {
    // Build a lastBarIdx map: for every aux pane, find the bar with time <= anchor[i].time
    const anchorTime = anchorPane.bars[i].time;
    const lastBarIdx = new Map();
    for (const [k, p] of allPanesByTf) {
      // binary search for last bar with time <= anchorTime
      let lo = 0, hi = p.bars.length - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (p.bars[mid].time <= anchorTime) { idx = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (idx >= 0) lastBarIdx.set(k, idx);
    }
    const ctx = buildBacktestCtx(allPanesByTf, lastBarIdx);
    if (!ctx) continue;

    for (const s of STRATEGIES) {
      const st = stats[s.name];
      st.ticksRun++;
      let results;
      try { results = s.fn(ctx) || []; }
      catch (e) { continue; }
      if (results.length > 0) st.ticksWithResult++;
      for (const r of results) {
        if (r.status === 'forming') st.formingCount++;
        else if (r.status === 'near_trigger') st.nearTriggerCount++;
        else if (r.status === 'invalidated') st.invalidatedCount++;
        else if (r.status === 'triggered' && r.entryPlan && r.direction && r.direction !== 'NONE') {
          st.triggeredCount++;
          // Dedup by setupId — only one limit order per setup
          if (seenSetupIds[s.name].has(r.setupId)) continue;
          // Quality filter: skip low-confidence triggered setups (real-world equivalent
          // of "don't take every signal"). 0.7 is roughly the A+ threshold for most strategies.
          if ((r.confidence || 0) < 0.7) { seenSetupIds[s.name].add(r.setupId); continue; }
          seenSetupIds[s.name].add(r.setupId);
          st.uniqueTriggered++;
          pendingLimits[s.name].push({
            direction: r.direction,
            entry: r.entryPlan.entry,
            stop: r.entryPlan.stop,
            t1: r.entryPlan.t1,
            t2: r.entryPlan.t2,
            risk: r.entryPlan.risk ?? Math.abs(r.entryPlan.entry - r.entryPlan.stop),
            placedIdx: i,
            placedTime: anchorTime,
            setupId: r.setupId,
            confidence: r.confidence,
            expiresIdx: i + 40, // limit valid for ~40 bars (~10 hours on 15m)
          });
        }
      }
    }

    // Process pending limit orders: check if anchor bar reached the limit price
    for (const s of STRATEGIES) {
      const arr = pendingLimits[s.name];
      const st = stats[s.name];
      const remaining = [];
      for (const lim of arr) {
        if (i >= lim.expiresIdx) {
          st.limitsExpired++;
          continue; // expired without fill
        }
        const bar = anchorPane.bars[i];
        const fill = (lim.direction === 'LONG' && bar.low <= lim.entry) ||
                     (lim.direction === 'SHORT' && bar.high >= lim.entry);
        if (!fill) {
          // Check if stop would have hit before limit filled (invalidate)
          const stopHitFirst = (lim.direction === 'LONG' && bar.low <= lim.stop) ||
                               (lim.direction === 'SHORT' && bar.high >= lim.stop);
          if (stopHitFirst) {
            st.limitsExpired++;
            continue;
          }
          remaining.push(lim);
          continue;
        }
        // Limit filled at lim.entry. Now simulate from bar i onward.
        const trade = { ...lim, openIdx: i };
        const outcome = simulateTrade(anchorPane.bars, trade);
        if (outcome) {
          trade.exit = outcome.exit;
          trade.exitIdx = outcome.exitIdx;
          trade.R = outcome.R;
          trade.win = outcome.R > 0;
          trade.exitReason = outcome.reason;
          st.trades.push(trade);
        }
      }
      pendingLimits[s.name] = remaining;
    }
  }
  return stats;
}

function simulateTrade(bars, trade) {
  const { direction, entry, stop, t1, t2, openIdx, risk } = trade;
  // Cap simulation window so partial trades don't dominate
  const maxBars = 200;
  for (let i = openIdx + 1; i < Math.min(bars.length, openIdx + maxBars); i++) {
    const b = bars[i];
    if (direction === 'LONG') {
      // Check stop first (conservative)
      if (b.low <= stop) return { exit: stop, exitIdx: i, R: -1, reason: 'SL' };
      if (b.high >= (t2 ?? Infinity)) return { exit: t2, exitIdx: i, R: 2, reason: 'TP2' };
      if (b.high >= t1) return { exit: t1, exitIdx: i, R: 1, reason: 'TP1' };
    } else {
      if (b.high >= stop) return { exit: stop, exitIdx: i, R: -1, reason: 'SL' };
      if (b.low <= (t2 ?? -Infinity)) return { exit: t2, exitIdx: i, R: 2, reason: 'TP2' };
      if (b.low <= t1) return { exit: t1, exitIdx: i, R: 1, reason: 'TP1' };
    }
  }
  // Timed out — mark to last close
  const last = bars[Math.min(bars.length - 1, openIdx + maxBars - 1)];
  if (!last) return null;
  const R = direction === 'LONG' ? (last.close - entry) / risk : (entry - last.close) / risk;
  return { exit: last.close, exitIdx: Math.min(bars.length - 1, openIdx + maxBars - 1), R, reason: 'time' };
}

function summarize(stats) {
  console.log('\n══════════════════════════════════════════');
  console.log(' BACKTEST RESULTS');
  console.log('══════════════════════════════════════════\n');
  for (const name of Object.keys(stats)) {
    const s = stats[name];
    const trades = s.trades;
    const wins = trades.filter((t) => t.win).length;
    const sumR = trades.reduce((a, b) => a + b.R, 0);
    const avgR = trades.length ? sumR / trades.length : 0;
    const winRate = trades.length ? (wins / trades.length) * 100 : 0;
    console.log(`📊 Strategy: ${name}`);
    console.log(`   Ticks run:        ${s.ticksRun}`);
    console.log(`   Forming alerts:   ${s.formingCount}`);
    console.log(`   Near-trigger:     ${s.nearTriggerCount}`);
    console.log(`   Triggered events: ${s.triggeredCount} (${s.uniqueTriggered ?? 0} unique setupIds)`);
    console.log(`   Invalidated:      ${s.invalidatedCount}`);
    console.log(`   Limits unfilled/expired: ${s.limitsExpired ?? 0}`);
    console.log(`   Trades filled+closed: ${trades.length}`);
    console.log(`   Wins:             ${wins}`);
    console.log(`   Win rate:         ${winRate.toFixed(1)}%`);
    console.log(`   Sum R:            ${sumR.toFixed(2)}R`);
    console.log(`   Avg R/trade:      ${avgR.toFixed(2)}R`);
    if (trades.length > 0) {
      const wl = trades.slice(-10).map((t) => `${t.direction[0]}${t.exitReason}(${t.R.toFixed(2)}R)`).join(' ');
      console.log(`   Last 10:          ${wl}`);
    }
    console.log('');
  }
}

async function main() {
  console.log('Pulling historical bars from all panes (max 500 each)...');
  const panes = await snapshotAllPanes(500);
  console.log(`Loaded ${panes.length} panes:`);
  for (const p of panes) {
    if (p.error) console.log(`  ✗ index ${p.index}: ${p.error}`);
    else console.log(`  ✓ ${p.symbol} @ ${p.resolution}m (${p.bars.length} bars)`);
  }

  const indexed = indexPanesByGoldOrAux(panes);
  if (indexed.size === 0) {
    console.log('No gold/silver/dxy panes recognized. Aborting.');
    process.exit(1);
  }

  console.log('\nRunning walk-forward backtest...');
  const stats = runBacktest(indexed, { step: 1 });
  if (!stats) process.exit(1);
  summarize(stats);
}

main().catch((err) => {
  console.error('Backtest crashed:', err.message, err.stack);
  process.exit(1);
});
