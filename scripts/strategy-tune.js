#!/usr/bin/env node
/**
 * Strategy tuning harness — train/test split with diagnostic breakdowns.
 *
 * Splits the 3-year backtest window into 2y train + 1y test.
 *   - Train: 2023-03 → 2025-03 (used to identify weaknesses)
 *   - Test:  2025-03 → 2026-05 (held out — proves changes generalize)
 *
 * A "real" improvement must improve sumR on BOTH halves. A change that
 * only helps train is overfit; we reject it.
 *
 * Per strategy, also breaks results down by session and instrument so we
 * can spot where the strategy actually leaks money (e.g. shorts on gold
 * in Asian session lose 80% — a clear filter target).
 *
 * Usage:
 *   node scripts/strategy-tune.js                    # all strategies
 *   node scripts/strategy-tune.js VWAP-REJ           # one strategy
 *   node scripts/strategy-tune.js VWAP-REJ --diag    # +diagnostics
 */

import { runBacktest } from '../src/backtest.js';
import { loadRegistry } from '../src/lib/strategy_registry.js';

const argv = process.argv.slice(2);
const onlyId = argv.find((a) => !a.startsWith('--'));
const showDiag = argv.includes('--diag');

const fmtR = (n) => (n >= 0 ? '+' : '') + n.toFixed(1) + 'R';
const fmtPct = (n) => (n * 100).toFixed(0) + '%';

function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }

(async () => {
  const reg = await loadRegistry();
  const ids = onlyId ? [onlyId] : reg.map((s) => s.id);

  console.log(`\nRunning 3-year backtest (1095 days)…`);
  const res = await runBacktest({ days: 1095, strategies: ids, confMin: 0, step: 3 });
  const w = res.window;
  const totalDays = (w.toUnix - w.fromUnix) / 86400;
  // Split at the 2/3 point — first 2y train, last 1y test
  const splitUnix = w.fromUnix + (w.toUnix - w.fromUnix) * (2 / 3);
  console.log(`Window: ${new Date(w.fromUnix * 1000).toISOString().slice(0, 10)} → ${new Date(w.toUnix * 1000).toISOString().slice(0, 10)} (${totalDays.toFixed(0)} days)`);
  console.log(`Split: train ${new Date(w.fromUnix * 1000).toISOString().slice(0, 10)} → ${new Date(splitUnix * 1000).toISOString().slice(0, 10)}  |  test ${new Date(splitUnix * 1000).toISOString().slice(0, 10)} → ${new Date(w.toUnix * 1000).toISOString().slice(0, 10)}`);
  console.log();

  // Build train/test stats per strategy by splitting the trades by openTime
  const summary = [];
  for (const id of ids) {
    const s = res.stats[id];
    if (!s || !s.trades) continue;
    const trainT = s.trades.filter((t) => t.openTime < splitUnix);
    const testT = s.trades.filter((t) => t.openTime >= splitUnix);
    const stats = (trades) => {
      const wins = trades.filter((t) => t.win).length;
      const sumR = trades.reduce((a, t) => a + t.R, 0);
      const gw = trades.filter((t) => t.R > 0).reduce((a, t) => a + t.R, 0);
      const gl = Math.abs(trades.filter((t) => t.R < 0).reduce((a, t) => a + t.R, 0));
      const pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);
      return {
        n: trades.length, wr: trades.length ? wins / trades.length : 0,
        sumR, avgR: trades.length ? sumR / trades.length : 0, pf,
      };
    };
    summary.push({ id, train: stats(trainT), test: stats(testT), trades: s.trades });
  }
  summary.sort((a, b) => (b.train.sumR + b.test.sumR) - (a.train.sumR + a.test.sumR));

  console.log('TRAIN (2y)' + ' '.repeat(31) + 'TEST (1y)');
  console.log(pad('STRATEGY', 18) + rpad('N', 5) + rpad('WIN%', 6) + rpad('avgR', 7) + rpad('PF', 6) + rpad('SumR', 9) + '   ' +
              rpad('N', 5) + rpad('WIN%', 6) + rpad('avgR', 7) + rpad('PF', 6) + rpad('SumR', 9) + '  GENERALIZES?');
  console.log('─'.repeat(110));
  for (const r of summary) {
    const generalizes = r.train.sumR > 0 && r.test.sumR > 0 ? 'YES'
      : r.train.sumR > 0 && r.test.sumR < 0 ? 'OVERFIT?'
      : r.train.sumR < 0 && r.test.sumR > 0 ? 'WAS-BROKEN'
      : 'BROKEN';
    console.log(
      pad(r.id, 18) +
      rpad(r.train.n, 5) +
      rpad(fmtPct(r.train.wr), 6) +
      rpad(r.train.avgR.toFixed(2), 7) +
      rpad(isFinite(r.train.pf) ? r.train.pf.toFixed(2) : 'inf', 6) +
      rpad(fmtR(r.train.sumR), 9) + '   ' +
      rpad(r.test.n, 5) +
      rpad(fmtPct(r.test.wr), 6) +
      rpad(r.test.avgR.toFixed(2), 7) +
      rpad(isFinite(r.test.pf) ? r.test.pf.toFixed(2) : 'inf', 6) +
      rpad(fmtR(r.test.sumR), 9) + '  ' + generalizes,
    );
  }

  if (showDiag) {
    console.log('\n\nDIAGNOSTICS (full 3y):');
    for (const r of summary) {
      const trades = r.trades;
      if (!trades.length) continue;
      console.log(`\n── ${r.id} ──`);

      // Per-instrument
      console.log('  By instrument:');
      for (const inst of ['gold', 'nasdaq', 'sp']) {
        const sub = trades.filter((t) => t.instrument === inst);
        if (!sub.length) continue;
        const wins = sub.filter((t) => t.win).length;
        const sumR = sub.reduce((a, t) => a + t.R, 0);
        console.log(`    ${pad(inst, 8)}  ${rpad(sub.length, 5)} trades  ${rpad(fmtPct(wins / sub.length), 5)}  ${rpad(fmtR(sumR), 9)}  avg ${(sumR / sub.length).toFixed(2)}R`);
      }

      // Per-session (via openTime + NY hour)
      console.log('  By session:');
      const sessionOf = (ts) => {
        const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ts * 1000)), 10);
        if (h >= 20 || h < 2) return 'Asian';
        if (h >= 2 && h < 7) return 'London';
        if (h >= 7 && h < 12) return 'NY-AM';
        if (h >= 12 && h < 16) return 'NY-PM';
        return 'PM';
      };
      const bySess = {};
      for (const t of trades) {
        const s = sessionOf(t.openTime || 0);
        const b = bySess[s] || { n: 0, w: 0, sumR: 0 };
        b.n++; if (t.win) b.w++; b.sumR += t.R;
        bySess[s] = b;
      }
      for (const [name, b] of Object.entries(bySess).sort((a, b) => b[1].sumR - a[1].sumR)) {
        console.log(`    ${pad(name, 8)}  ${rpad(b.n, 5)} trades  ${rpad(fmtPct(b.w / b.n), 5)}  ${rpad(fmtR(b.sumR), 9)}  avg ${(b.sumR / b.n).toFixed(2)}R`);
      }

      // Per-direction
      console.log('  By direction:');
      for (const dir of ['LONG', 'SHORT']) {
        const sub = trades.filter((t) => t.direction === dir);
        if (!sub.length) continue;
        const wins = sub.filter((t) => t.win).length;
        const sumR = sub.reduce((a, t) => a + t.R, 0);
        console.log(`    ${pad(dir, 8)}  ${rpad(sub.length, 5)} trades  ${rpad(fmtPct(wins / sub.length), 5)}  ${rpad(fmtR(sumR), 9)}  avg ${(sumR / sub.length).toFixed(2)}R`);
      }
    }
  }

  console.log();
})().catch((e) => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
