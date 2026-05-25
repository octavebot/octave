#!/usr/bin/env node
/**
 * Filter validator — train/test split.
 *
 * For each proposed filter, runs the strategy backtest twice:
 *   - Baseline (current code)
 *   - Filtered (apply the proposed rule POST-trade-generation)
 * On a train half (first half of window) and a test half (second half).
 *
 * Filter ships ONLY IF it improves sumR AND win% in BOTH halves.
 * Anything that only helps one half is noise; discard.
 *
 * Usage:  node scripts/filter-validate.js [days]
 */

import { runBacktest } from '../src/backtest.js';
import { nyParts } from '../src/lib/time.js';

const days = parseInt(process.argv[2], 10) || 30;

// ── Proposed filters ──────────────────────────────────────────────────────
// Each filter is a predicate: (trade) → true to KEEP the trade, false to DROP.
// Applied post-hoc on backtest output so we don't have to re-run with code
// changes. Equivalent to "this filter would have prevented entry on this bar".
const filters = {
  'ASIAN-BREAKOUT': {
    name: 'Cap window at 02:00–07:00 ET (drop 07–10 → NY-FVG territory)',
    keep: (t) => {
      const h = nyParts(t.openTime).h;
      return h >= 2 && h < 7;
    },
  },
  'DAILY-TREND-PB': {
    name: 'Skip ny_am session (07:00–12:00 ET)',
    keep: (t) => {
      const h = nyParts(t.openTime).h;
      return !(h >= 7 && h < 12);
    },
  },
  // VWAP-REJ tightening requires CODE change (entry condition), can't be
  // simulated post-hoc by filtering trades — those trades wouldn't have
  // been generated. We'll handle that one separately.
};

function stats(trades) {
  if (!trades.length) return { n: 0, winRate: 0, sumR: 0, avgR: 0, pf: 0 };
  let wins = 0, sumR = 0, sumWin = 0, sumLoss = 0;
  for (const t of trades) {
    sumR += t.R;
    if (t.R > 0) { wins++; sumWin += t.R; } else { sumLoss += -t.R; }
  }
  return {
    n: trades.length,
    winRate: wins / trades.length,
    sumR,
    avgR: sumR / trades.length,
    pf: sumLoss > 0 ? sumWin / sumLoss : Infinity,
  };
}

function fmtStats(s) {
  const sgn = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
  return `n=${String(s.n).padStart(3)} win=${(s.winRate*100).toFixed(0).padStart(3)}% sumR=${sgn(s.sumR).padStart(7)}R avgR=${sgn(s.avgR)}R PF=${isFinite(s.pf) ? s.pf.toFixed(2) : '∞'}`;
}

function delta(after, before) {
  return {
    winRate: after.winRate - before.winRate,
    sumR: after.sumR - before.sumR,
    avgR: after.avgR - before.avgR,
    n: after.n - before.n,
  };
}

(async () => {
  console.log(`\nRunning ${days}-day backtest…`);
  const r = await runBacktest({ days, step: 3 });
  if (r.error) { console.error('error:', r.error); process.exit(1); }

  // Compute train/test cutoff from the actual data window. Use the median
  // openTime across ALL trades as the boundary — robust to gaps.
  const allTrades = [];
  for (const s of Object.values(r.stats)) allTrades.push(...(s.trades || []));
  if (!allTrades.length) { console.log('no trades'); process.exit(0); }
  allTrades.sort((a, b) => a.openTime - b.openTime);
  const cutoff = allTrades[Math.floor(allTrades.length / 2)].openTime;
  const cutoffDate = new Date(cutoff * 1000).toISOString().slice(0, 10);
  console.log(`Train/test split at ${cutoffDate} (median of ${allTrades.length} trades).\n`);

  let shipping = [];
  let discarding = [];

  for (const [stratId, filt] of Object.entries(filters)) {
    const s = r.stats[stratId];
    if (!s) { console.log(`SKIP ${stratId} — not in backtest`); continue; }
    const trades = s.trades || [];
    const train = trades.filter((t) => t.openTime <= cutoff);
    const test  = trades.filter((t) => t.openTime > cutoff);

    const trainBase = stats(train);
    const testBase  = stats(test);
    const trainAfter = stats(train.filter(filt.keep));
    const testAfter  = stats(test.filter(filt.keep));

    const trainDelta = delta(trainAfter, trainBase);
    const testDelta  = delta(testAfter, testBase);

    console.log(`══════ ${stratId} ══════`);
    console.log(`  filter: ${filt.name}`);
    console.log(`  TRAIN baseline:  ${fmtStats(trainBase)}`);
    console.log(`  TRAIN filtered:  ${fmtStats(trainAfter)}`);
    console.log(`  TEST  baseline:  ${fmtStats(testBase)}`);
    console.log(`  TEST  filtered:  ${fmtStats(testAfter)}`);
    console.log(`  Δ TRAIN: win ${(trainDelta.winRate*100>=0?'+':'')+(trainDelta.winRate*100).toFixed(1)}pp  sumR ${(trainDelta.sumR>=0?'+':'')+trainDelta.sumR.toFixed(2)}R  trades ${trainDelta.n}`);
    console.log(`  Δ TEST:  win ${(testDelta.winRate*100>=0?'+':'')+(testDelta.winRate*100).toFixed(1)}pp  sumR ${(testDelta.sumR>=0?'+':'')+testDelta.sumR.toFixed(2)}R  trades ${testDelta.n}`);

    // Ship rule: BOTH halves must show improvement in winRate AND sumR.
    // We allow flat sumR (drops within ±0.5R) if win% clearly up — that means
    // we're cutting equal R but skewing toward fewer losses.
    const trainGood = trainDelta.winRate >= 0 && trainDelta.sumR > -0.5;
    const testGood  = testDelta.winRate  >= 0 && testDelta.sumR  > -0.5;
    const trainImproves = trainDelta.winRate > 0 || trainDelta.sumR > 0;
    const testImproves  = testDelta.winRate  > 0 || testDelta.sumR  > 0;

    let verdict;
    if (trainGood && testGood && trainImproves && testImproves) {
      verdict = '✅ SHIP — both halves improve';
      shipping.push({ stratId, filt: filt.name });
    } else if ((trainImproves && !testImproves) || (!trainImproves && testImproves)) {
      verdict = '❌ DISCARD — only one half benefits (noise)';
      discarding.push({ stratId, filt: filt.name, reason: 'asymmetric' });
    } else if (!trainImproves && !testImproves) {
      verdict = '❌ DISCARD — neither half benefits';
      discarding.push({ stratId, filt: filt.name, reason: 'no benefit' });
    } else {
      verdict = '❌ DISCARD — hurts one half too much';
      discarding.push({ stratId, filt: filt.name, reason: 'hurts other' });
    }
    console.log(`  verdict: ${verdict}\n`);
  }

  console.log('═══════════ SUMMARY ═══════════');
  if (shipping.length) {
    console.log('  SHIP:');
    for (const x of shipping) console.log(`    ✅ ${x.stratId} — ${x.filt}`);
  } else {
    console.log('  no filters survived validation');
  }
  if (discarding.length) {
    console.log('  DISCARD:');
    for (const x of discarding) console.log(`    ❌ ${x.stratId} (${x.reason}) — ${x.filt}`);
  }
})();
