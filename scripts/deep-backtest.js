#!/usr/bin/env node
/**
 * Deep backtest — the most thorough analysis possible with Yahoo's free data.
 *
 * Yahoo caps 15m intraday history at 60-71 days. Every strategy in the stack
 * anchors on 15m, so the backtest is capped by that. This script runs the
 * deepest possible window AND annualizes it under explicit assumptions.
 *
 * Usage: node scripts/deep-backtest.js
 */

import { runBacktest } from '../src/backtest.js';
import { loadRegistry } from '../src/lib/strategy_registry.js';

const fmtR = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + 'R';
const fmtPct = (n) => (n * 100).toFixed(0) + '%';
const fmt$ = (n) => '$' + Math.round(n).toLocaleString('en-US');
const RISK_USD = 250;

function rule(c = '─', n = 100) { return c.repeat(n); }

/**
 * Build a combined equity curve from per-strategy trade arrays. Chronological,
 * sorted by openTime so the combined drawdown reflects the order trades
 * actually occurred.
 */
function combinedEquity(stats) {
  const allTrades = [];
  for (const s of Object.values(stats)) {
    for (const t of (s.trades || [])) allTrades.push(t);
  }
  allTrades.sort((a, b) => (a.openTime || 0) - (b.openTime || 0));
  let eq = 0, peak = 0, maxDD = 0;
  for (const t of allTrades) {
    eq += t.R;
    if (eq > peak) peak = eq;
    if (peak - eq > maxDD) maxDD = peak - eq;
  }
  return { trades: allTrades, finalR: eq, peakR: peak, maxDrawdownR: maxDD };
}

function rankedStrategies(stats, ids) {
  return [...ids].sort((a, b) => (stats[b]?.sumR || 0) - (stats[a]?.sumR || 0));
}

async function report(mode, days, partial) {
  const reg = await loadRegistry();
  const ids = reg.map((s) => s.id);
  const res = await runBacktest({ days, strategies: ids, confMin: 0, step: 3, partial });
  const w = res.window;
  const actualDays = w ? (w.toUnix - w.fromUnix) / 86400 : 0;
  return { mode, res, actualDays, ids };
}

(async () => {
  console.log('\n' + rule('═'));
  console.log('DEEP BACKTEST · maximum-depth analysis');
  console.log(rule('═'));

  // Request 1095 days to confirm the data cap, then use whatever Yahoo gives us
  console.log('Probing Yahoo data depth (requesting 1095 days)...');
  const { res: probe } = await report('probe', 1095, false);
  const probeDays = (probe.window.toUnix - probe.window.fromUnix) / 86400;
  console.log(`Yahoo intraday actual: ${probeDays.toFixed(1)} days (15m bars cap at 60-71 days on free tier).`);

  // Conservative run = legacy all-or-nothing TP1 exit
  console.log('\nRunning CONSERVATIVE simulation (exit 100% at TP1)...');
  const cons = await report('conservative', 1095, false);

  // Partial run = 50% off at TP1, runner trails to TP2 with BE stop
  console.log('Running PARTIAL-TP simulation (50% at TP1, runner to TP2 w/ BE stop)...');
  const part = await report('partial', 1095, true);

  const w = cons.res.window;
  const actualDays = (w.toUnix - w.fromUnix) / 86400;
  console.log('\n' + rule('═'));
  console.log(`Window: ${new Date(w.fromUnix * 1000).toISOString().slice(0, 10)} → ${new Date(w.toUnix * 1000).toISOString().slice(0, 10)} (${actualDays.toFixed(0)} days)`);
  console.log(`Instruments: gold, nasdaq, sp · Anchor TF: ${w.anchorTF}`);
  console.log(rule('═'));

  // ── PER-STRATEGY TABLE ────────────────────────────────────────────────
  const sorted = rankedStrategies(cons.res.stats, cons.ids);
  console.log('\nPER-STRATEGY (sorted by Conservative sumR):\n');
  console.log(
    'STRATEGY'.padEnd(18) +
    'TR'.padStart(4) + ' WIN%'.padStart(6) +
    ' SumR-C'.padStart(10) + ' SumR-P'.padStart(10) +
    ' Avg-C'.padStart(8) + ' Avg-P'.padStart(8) +
    ' PF-C'.padStart(7) + ' PF-P'.padStart(7) +
    ' MaxDD-P'.padStart(10) + ' /day'.padStart(7),
  );
  console.log(rule('-'));
  let totT = 0, totW = 0, totRC = 0, totRP = 0;
  for (const id of sorted) {
    const c = cons.res.stats[id], p = part.res.stats[id];
    if (!c) continue;
    totT += c.tradeCount; totW += c.wins; totRC += c.sumR; totRP += p.sumR;
    console.log(
      id.padEnd(18) +
      String(c.tradeCount).padStart(4) +
      fmtPct(c.winRate).padStart(6) +
      fmtR(c.sumR).padStart(10) +
      fmtR(p.sumR).padStart(10) +
      (c.avgR.toFixed(2)).padStart(8) +
      (p.avgR.toFixed(2)).padStart(8) +
      (isFinite(c.profitFactor) ? c.profitFactor.toFixed(2) : 'inf').padStart(7) +
      (isFinite(p.profitFactor) ? p.profitFactor.toFixed(2) : 'inf').padStart(7) +
      fmtR(-p.maxDrawdownR).padStart(10) +
      (c.tradeCount / actualDays).toFixed(2).padStart(7),
    );
  }
  console.log(rule('-'));
  console.log(
    'COMBINED'.padEnd(18) +
    String(totT).padStart(4) +
    fmtPct(totW / totT).padStart(6) +
    fmtR(totRC).padStart(10) +
    fmtR(totRP).padStart(10),
  );

  // ── COMBINED DRAWDOWN ─────────────────────────────────────────────────
  const eqC = combinedEquity(cons.res.stats);
  const eqP = combinedEquity(part.res.stats);
  console.log('\nCOMBINED EQUITY (chronological, all strategies × all instruments):\n');
  console.log('Mode'.padEnd(18) + 'Final R'.padStart(12) + 'Peak R'.padStart(12) + 'Max DD'.padStart(12) + 'Return:DD'.padStart(14));
  console.log(rule('-'));
  console.log(
    'Conservative'.padEnd(18) +
    fmtR(eqC.finalR).padStart(12) +
    fmtR(eqC.peakR).padStart(12) +
    fmtR(-eqC.maxDrawdownR).padStart(12) +
    ((eqC.maxDrawdownR > 0 ? eqC.finalR / eqC.maxDrawdownR : Infinity).toFixed(2) + 'x').padStart(14),
  );
  console.log(
    'Partial 50/50'.padEnd(18) +
    fmtR(eqP.finalR).padStart(12) +
    fmtR(eqP.peakR).padStart(12) +
    fmtR(-eqP.maxDrawdownR).padStart(12) +
    ((eqP.maxDrawdownR > 0 ? eqP.finalR / eqP.maxDrawdownR : Infinity).toFixed(2) + 'x').padStart(14),
  );

  // ── PER-INSTRUMENT BREAKDOWN ──────────────────────────────────────────
  console.log('\nPER-INSTRUMENT (Conservative mode):\n');
  console.log(
    'STRATEGY'.padEnd(18) +
    'gold trades'.padStart(13) +
    'gold sumR'.padStart(12) +
    'nasdaq trades'.padStart(15) +
    'nasdaq sumR'.padStart(13) +
    'sp trades'.padStart(11) +
    'sp sumR'.padStart(11),
  );
  console.log(rule('-'));
  for (const id of sorted) {
    const s = cons.res.stats[id];
    if (!s) continue;
    const g = s.byInstrument?.gold, n = s.byInstrument?.nasdaq, sp = s.byInstrument?.sp;
    console.log(
      id.padEnd(18) +
      String(g?.tradeCount || 0).padStart(13) +
      fmtR(g?.sumR || 0).padStart(12) +
      String(n?.tradeCount || 0).padStart(15) +
      fmtR(n?.sumR || 0).padStart(13) +
      String(sp?.tradeCount || 0).padStart(11) +
      fmtR(sp?.sumR || 0).padStart(11),
    );
  }

  // ── ANNUALIZATION ─────────────────────────────────────────────────────
  const annFactor = 365 / actualDays;
  console.log('\nANNUALIZED PROJECTION (linear extrapolation — caveats below):\n');
  console.log(
    'Mode'.padEnd(18) +
    '1Y R'.padStart(12) +
    `1Y @$${RISK_USD}/R`.padStart(15) +
    '1Y trades'.padStart(12) +
    'Days needed for 5% target'.padStart(28),
  );
  console.log(rule('-'));
  const target5pct = 50_000 * 0.05;  // $2500 for a 50k account
  const dailyRC = totRC / actualDays, dailyRP = totRP / actualDays;
  const daysFor5C = target5pct / (dailyRC * RISK_USD);
  const daysFor5P = target5pct / (dailyRP * RISK_USD);
  console.log(
    'Conservative'.padEnd(18) +
    fmtR(totRC * annFactor).padStart(12) +
    fmt$(totRC * annFactor * RISK_USD).padStart(15) +
    String(Math.round(totT * annFactor)).padStart(12) +
    `${daysFor5C.toFixed(1)} trading days`.padStart(28),
  );
  console.log(
    'Partial 50/50'.padEnd(18) +
    fmtR(totRP * annFactor).padStart(12) +
    fmt$(totRP * annFactor * RISK_USD).padStart(15) +
    String(Math.round(totT * annFactor)).padStart(12) +
    `${daysFor5P.toFixed(1)} trading days`.padStart(28),
  );

  console.log('\nCaveats — read these before sizing real money:');
  console.log('  · ' + actualDays.toFixed(0) + '-day sample. A bear regime or low-volatility chop period could halve these numbers.');
  console.log('  · GROSS. No slippage, no spread, no commission, no overnight financing.');
  console.log('  · Assumes you size EVERY signal at the configured risk. Realistic if you have the bot running 24/5 — manual execution will miss some.');
  console.log('  · Combined drawdown above is the WORST historical drawdown in this window; live drawdowns can exceed it.');
  console.log('  · For true 1y/3y validation, wire OANDA (5-year intraday history) or another paid data source.');

  console.log('\n' + rule('═'));
})().catch((e) => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
