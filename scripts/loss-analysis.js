#!/usr/bin/env node
/**
 * Per-strategy losing-trade analysis.
 *
 * Runs a backtest, then for each strategy buckets losing trades by:
 *   - hour of day (NY)
 *   - session (asia / london / ny_am / lunch / ny_pm)
 *   - instrument (gold / nasdaq / sp)
 *   - direction (LONG / SHORT)
 *   - confidence bucket (low/mid/high)
 *
 * Prints the single largest loss bucket per strategy — that's where a
 * filter, if data-driven, would do the most good.
 *
 * Usage:  node scripts/loss-analysis.js [days]
 */

import { runBacktest } from '../src/backtest.js';
import { nyParts } from '../src/lib/time.js';

const days = parseInt(process.argv[2], 10) || 30;

function sessionOf(unix) {
  const np = nyParts(unix);
  const h = np.h;
  if (h >= 18 || h < 2) return 'asia';
  if (h >= 2 && h < 7) return 'london';
  if (h >= 7 && h < 12) return 'ny_am';
  if (h >= 12 && h < 14) return 'lunch';
  return 'ny_pm';
}

function confBucket(c) {
  if (c == null) return 'unknown';
  if (c < 0.5) return 'low';
  if (c < 0.7) return 'mid';
  return 'high';
}

function bucketStats(trades) {
  const out = { n: trades.length, wins: 0, sumR: 0, avgR: 0 };
  for (const t of trades) {
    if (t.R > 0) out.wins++;
    out.sumR += t.R;
  }
  out.winRate = trades.length ? out.wins / trades.length : 0;
  out.avgR = trades.length ? out.sumR / trades.length : 0;
  return out;
}

function bucketBy(trades, fn) {
  const m = new Map();
  for (const t of trades) {
    const k = fn(t);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return [...m.entries()]
    .map(([k, ts]) => ({ key: k, ...bucketStats(ts) }))
    .sort((a, b) => a.sumR - b.sumR); // worst (most negative) first
}

(async () => {
  console.log(`\nRunning ${days}-day backtest…`);
  const r = await runBacktest({ days, step: 1 });
  if (r.error) { console.error('backtest error:', r.error); process.exit(1); }
  const stats = r.stats || {};
  const all = Object.values(stats);
  console.log(`Done. ${all.length} strategies analysed.\n`);

  for (const s of all) {
    const trades = s.trades || [];
    if (!trades.length) continue;
    const losses = trades.filter((t) => t.R <= 0);
    console.log(`═══════ ${s.name} ═══════`);
    console.log(`  total trades: ${trades.length}  ·  losses: ${losses.length}  ·  sumR: ${trades.reduce((a, t) => a + t.R, 0).toFixed(2)}R`);

    const dims = {
      hour:       (t) => nyParts(t.openTime).h,
      session:    (t) => sessionOf(t.openTime),
      instrument: (t) => t.instrument,
      direction:  (t) => t.direction,
      conf:       (t) => confBucket(t.confidence),
    };
    for (const [name, fn] of Object.entries(dims)) {
      const buckets = bucketBy(trades, fn);
      console.log(`  by ${name}:`);
      for (const b of buckets) {
        const arrow = b.sumR < 0 ? '🔴' : b.sumR < 2 ? '🟡' : '🟢';
        console.log(`    ${arrow}  ${String(b.key).padEnd(10)}  n=${b.n.toString().padStart(3)}  win%=${(b.winRate * 100).toFixed(0).padStart(3)}%  sumR=${(b.sumR >= 0 ? '+' : '') + b.sumR.toFixed(2).padStart(6)}R  avgR=${(b.avgR >= 0 ? '+' : '') + b.avgR.toFixed(2)}R`);
      }
    }
    console.log();
  }
})();
