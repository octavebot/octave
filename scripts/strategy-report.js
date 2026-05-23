#!/usr/bin/env node
/**
 * Strategy report — backtest every registered strategy, print per-strategy
 * stats, and flag pass/fail against the target (≥60% win rate, ≥1.2 avg
 * winner RR, 0.5-3 trades/day frequency).
 *
 * Usage: node scripts/strategy-report.js [days]
 */

import { runBacktest } from '../src/backtest.js';
import { loadRegistry } from '../src/lib/strategy_registry.js';

const days = parseInt(process.argv[2], 10) || 45;

const TARGET_WINRATE = 0.60;
const TARGET_EXPECTANCY = 0.15;   // avg R per trade — proves the edge is real money
const MIN_TRADES_PER_DAY = 0.4;
const MAX_TRADES_PER_DAY = 4.0;

(async () => {
  const reg = await loadRegistry();
  const ids = reg.map((s) => s.id);
  console.log(`\nBacktesting ${ids.length} strategies over ${days} days…\n`);

  // step:3 samples the 5m anchor every 15m — strategies fire on 15m+ panes,
  // so this loses no signal while running 3× faster.
  // confMin: 0 — report measures RAW strategy edge over every setup it produces.
  // Live runtime gates via the Holy AI engine + aiEngine.threshold, not this
  // pre-filter. Filtering on confidence here would be circular: confidence is
  // derived from the win rate, so a low-WR strategy would self-suppress to
  // zero trades and never get measured.
  const res = await runBacktest({ days, strategies: ids, confMin: 0, step: 3 });
  if (res.error) {
    console.error('Backtest error:', res.error);
    process.exit(1);
  }

  const rows = [];
  for (const id of ids) {
    const s = res.stats[id];
    if (!s) { rows.push({ id, trades: 0, status: 'NO-DATA' }); continue; }
    const tradesPerDay = s.tradeCount / days;
    const winRate = s.winRate;
    const avgWinR = s.avgWinR || 0;
    const pass = s.tradeCount >= 8
      && winRate >= TARGET_WINRATE
      && s.avgR >= TARGET_EXPECTANCY
      && tradesPerDay >= MIN_TRADES_PER_DAY
      && tradesPerDay <= MAX_TRADES_PER_DAY;
    rows.push({
      id, trades: s.tradeCount, tradesPerDay,
      winRate, avgWinR, avgR: s.avgR, sumR: s.sumR,
      profitFactor: s.profitFactor, maxDD: s.maxDrawdownR,
      triggered: s.triggeredCount || 0, uniqueTriggered: s.uniqueTriggered || 0,
      status: s.tradeCount < 8 ? 'LOW-SAMPLE' : (pass ? 'PASS' : 'FAIL'),
    });
  }

  const pad = (v, n) => String(v).padEnd(n);
  const num = (v, d = 2) => (v == null || !isFinite(v)) ? '—' : v.toFixed(d);
  console.log(pad('STRATEGY', 18) + pad('TRIG', 7) + pad('TRADES', 8) + pad('/DAY', 7) + pad('WIN%', 8) + pad('avgR', 8) + pad('winRR', 8) + pad('PF', 7) + 'STATUS');
  console.log('─'.repeat(86));
  for (const r of rows) {
    if (r.status === 'NO-DATA') { console.log(pad(r.id, 18) + 'no data'); continue; }
    console.log(
      pad(r.id, 18) +
      pad(r.triggered, 7) +
      pad(r.trades, 8) +
      pad(num(r.tradesPerDay, 2), 7) +
      pad((r.winRate * 100).toFixed(0) + '%', 8) +
      pad(num(r.avgR), 8) +
      pad(num(r.avgWinR), 8) +
      pad(num(r.profitFactor), 7) +
      r.status
    );
  }
  console.log('─'.repeat(86));
  const passed = rows.filter((r) => r.status === 'PASS');
  console.log(`\n${passed.length}/${ids.length} strategies PASS (≥${TARGET_WINRATE*100}% win, ≥${TARGET_EXPECTANCY}R expectancy, ${MIN_TRADES_PER_DAY}-${MAX_TRADES_PER_DAY}/day)\n`);

  // Persist machine-readable summary for the PDF generator + dashboard.
  const fs = await import('node:fs');
  const statsOut = { generatedAt: Date.now(), days, rows };
  fs.writeFileSync(new URL('../src/state/backtest-stats.json', import.meta.url), JSON.stringify(statsOut, null, 2));
  console.log('JSON:' + JSON.stringify(rows));
})().catch((e) => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
