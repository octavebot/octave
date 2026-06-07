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

  // confMin: 0 — report measures RAW strategy edge over every setup it produces.
  // Live runtime gates via the Holy AI engine + aiEngine.threshold, not this
  // pre-filter. Filtering on confidence here would be circular: confidence is
  // derived from the win rate, so a low-WR strategy would self-suppress to
  // zero trades and never get measured.
  // CONF_MIN env simulates the live confidence gate (aiEngine.threshold) so we
  // can measure book winrate/profit at different gate levels. Default 0 = raw.
  const confMin = Number(process.env.CONF_MIN) || 0;

  // Step depends on the anchor timeframe:
  //   - 15m+ strategies are signal-identical at step:3 (samples the 5m anchor
  //     every 15m → 3× faster, loses no signal).
  //   - 5m-anchored strategies (the ORB family: Pure Hunt / Safe Flow / Akimbo)
  //     MUST be walked at step:1 — a coarser step skips the exact breakout/
  //     crossover bar, so the entry never registers and they under-count to ~0.
  // Run the two groups separately and merge their stats.
  const fineIds = reg.filter((s) => (s.timeframes || []).includes('5')).map((s) => s.id);
  const coarseIds = reg.filter((s) => !(s.timeframes || []).includes('5')).map((s) => s.id);
  console.log(`\nBacktesting ${ids.length} strategies over ${days} days (fine=${fineIds.length}@step1 · coarse=${coarseIds.length}@step3)…\n`);

  const stats = {};
  if (coarseIds.length) {
    const r = await runBacktest({ days, strategies: coarseIds, confMin, step: 3 });
    if (r.error) { console.error('Backtest error (coarse):', r.error); process.exit(1); }
    Object.assign(stats, r.stats);
  }
  if (fineIds.length) {
    const r = await runBacktest({ days, strategies: fineIds, confMin, step: 1 });
    if (r.error) { console.error('Backtest error (fine):', r.error); process.exit(1); }
    Object.assign(stats, r.stats);
  }

  const rows = [];
  for (const id of ids) {
    const s = stats[id];
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

  // Also refresh the confidence-model win-rate cache so a freshly-added
  // strategy's signals are scored on its REAL backtested win rate (not the 0.62
  // fallback, which can leave a high-win strategy stuck below the mode gate).
  // Only publish strategies with a meaningful sample (≥20 trades), matching
  // run-backtest-child's threshold.
  try {
    const cacheUrl = new URL('../src/state/backtest-cache.json', import.meta.url);
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(cacheUrl, 'utf8')); } catch { /* no cache yet */ }
    const winRates = { ...(cache.winRates || {}) };
    for (const r of rows) {
      if (r.trades >= 20 && typeof r.winRate === 'number') winRates[r.id] = Math.round(r.winRate * 1000) / 1000;
    }
    fs.writeFileSync(cacheUrl, JSON.stringify({ ...cache, winRates, statsGeneratedAt: Date.now(), statsDays: days }, null, 2));
  } catch (e) { console.error('winRate cache update failed:', e.message); }

  console.log('JSON:' + JSON.stringify(rows));
})().catch((e) => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
