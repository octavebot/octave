#!/usr/bin/env node
/**
 * Per-day signal distribution from the backtest.
 *
 * Confirms the strategies still produce "several signals per day" after any
 * filter changes. Shows:
 *   - histogram of trades/day across the window
 *   - coverage by hour-of-day across the day (signal density)
 *   - which strategies fire when (so gaps are visible)
 *
 * Usage:  node scripts/daily-distribution.js [days]
 */

import { runBacktest } from '../src/backtest.js';
import { nyParts } from '../src/lib/time.js';

const days = parseInt(process.argv[2], 10) || 30;

(async () => {
  console.log(`\nRunning ${days}-day backtest…`);
  const r = await runBacktest({ days, step: 3 });
  if (r.error) { console.error('error:', r.error); process.exit(1); }

  // Flatten all trades, tag with NY day key
  const trades = [];
  for (const [stratId, s] of Object.entries(r.stats)) {
    for (const t of s.trades || []) {
      const np = nyParts(t.openTime);
      const dayKey = `${np.y}-${String(np.m).padStart(2, '0')}-${String(np.d).padStart(2, '0')}`;
      trades.push({ ...t, strategy: stratId, dayKey, hour: np.h });
    }
  }
  if (!trades.length) { console.log('no trades'); process.exit(0); }

  // ── Trades per day histogram ────────────────────────────────────────────
  const byDay = new Map();
  for (const t of trades) {
    if (!byDay.has(t.dayKey)) byDay.set(t.dayKey, []);
    byDay.get(t.dayKey).push(t);
  }
  const dayCounts = [...byDay.values()].map((ts) => ts.length).sort((a, b) => a - b);
  const totalDays = byDay.size;
  const zeroDays = days - totalDays; // days in window with NO trades
  const median = dayCounts[Math.floor(dayCounts.length / 2)] || 0;
  const min = dayCounts[0] || 0;
  const max = dayCounts[dayCounts.length - 1] || 0;
  const avg = (trades.length / days).toFixed(1);

  console.log('\n═══════ TRADES PER DAY ═══════');
  console.log(`  total trades: ${trades.length}  ·  active days: ${totalDays}/${days}  ·  zero-trade days: ${zeroDays}`);
  console.log(`  avg: ${avg}/day  ·  median: ${median}  ·  min: ${min}  ·  max: ${max}`);
  console.log('  histogram (trades/day → count of days):');
  const histo = new Map();
  for (const c of dayCounts) histo.set(c, (histo.get(c) || 0) + 1);
  for (const [c, n] of [...histo.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`    ${String(c).padStart(2)} trades: ${'█'.repeat(n)} ${n}`);
  }
  if (zeroDays > 0) console.log(`     0 trades: ${'░'.repeat(zeroDays)} ${zeroDays}  (no signals all day)`);

  // ── Coverage by hour of day ─────────────────────────────────────────────
  console.log('\n═══════ COVERAGE BY HOUR-OF-DAY (ET) ═══════');
  const byHour = new Map();
  for (let h = 0; h < 24; h++) byHour.set(h, new Set());
  for (const t of trades) byHour.get(t.hour).add(t.strategy);
  console.log('  hour  strategies that fire here');
  for (const [h, ss] of byHour) {
    if (!ss.size) continue;
    const bar = '█'.repeat(ss.size);
    console.log(`  ${String(h).padStart(2)}:00  ${bar.padEnd(6)} ${[...ss].sort().join(', ')}`);
  }

  // ── Quietest hour windows (no strategy ever fires) ──────────────────────
  const quietHours = [];
  for (const [h, ss] of byHour) if (!ss.size) quietHours.push(h);
  if (quietHours.length) {
    console.log(`\n  silent hours (no strategy fired): ${quietHours.join(', ')}`);
  } else {
    console.log(`\n  ✓ every hour of day has at least one strategy firing somewhere in window`);
  }

  // ── Per-strategy contribution ───────────────────────────────────────────
  console.log('\n═══════ STRATEGY CONTRIBUTION ═══════');
  const byStrat = new Map();
  for (const t of trades) {
    if (!byStrat.has(t.strategy)) byStrat.set(t.strategy, []);
    byStrat.get(t.strategy).push(t);
  }
  for (const [s, ts] of [...byStrat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${s.padEnd(16)} ${String(ts.length).padStart(3)} trades  ${(ts.length / days).toFixed(2)}/day`);
  }
})();
