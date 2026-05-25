#!/usr/bin/env node
/**
 * Split a strategy's trades by LONG/SHORT AND train/test.
 *
 * The default tune report pools direction across the full window. Before
 * filtering on direction we need to verify the asymmetry survives the
 * train→test split — otherwise we're chasing a sampling artifact.
 *
 * Usage: node scripts/split-by-direction.js <STRATEGY_ID>
 */

import { runBacktest } from '../src/backtest.js';

const id = process.argv[2];
if (!id) { console.error('Usage: split-by-direction.js <STRATEGY_ID>'); process.exit(1); }

const fmtR = (n) => (n >= 0 ? '+' : '') + n.toFixed(1) + 'R';
const fmtPct = (n) => (n * 100).toFixed(0) + '%';

const daysArg = process.argv.find((a) => a.startsWith('--days='));
const DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 730;
const res = await runBacktest({ days: DAYS, strategies: [id], confMin: 0, step: 3 });
const w = res.window;
const splitUnix = w.fromUnix + (w.toUnix - w.fromUnix) * (2 / 3);
const trades = res.stats[id]?.trades || [];
if (!trades.length) { console.log('no trades'); process.exit(0); }

function stat(arr) {
  const n = arr.length;
  if (!n) return { n: 0 };
  const wins = arr.filter((t) => t.win).length;
  const sumR = arr.reduce((a, t) => a + t.R, 0);
  return { n, wr: wins / n, sumR, avgR: sumR / n };
}

const groups = {
  'TRAIN LONG':  trades.filter((t) => t.openTime <  splitUnix && t.direction === 'LONG'),
  'TRAIN SHORT': trades.filter((t) => t.openTime <  splitUnix && t.direction === 'SHORT'),
  'TEST  LONG':  trades.filter((t) => t.openTime >= splitUnix && t.direction === 'LONG'),
  'TEST  SHORT': trades.filter((t) => t.openTime >= splitUnix && t.direction === 'SHORT'),
};

console.log(`\n${id} — direction split by train/test:`);
console.log('GROUP'.padEnd(14) + 'N'.padStart(5) + 'WIN%'.padStart(6) + 'avgR'.padStart(8) + 'sumR'.padStart(10));
console.log('-'.repeat(43));
for (const [k, arr] of Object.entries(groups)) {
  const s = stat(arr);
  if (!s.n) { console.log(`${k.padEnd(14)}${'0'.padStart(5)}`); continue; }
  console.log(
    k.padEnd(14) +
    String(s.n).padStart(5) +
    fmtPct(s.wr).padStart(6) +
    s.avgR.toFixed(2).padStart(8) +
    fmtR(s.sumR).padStart(10)
  );
}
console.log();
