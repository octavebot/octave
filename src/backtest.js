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
import { evaluateUSLS } from './strategies/usls.js';
import { evaluateICTSMC } from './strategies/ict_smc.js';
import { evaluateAlgoSMC } from './strategies/algo_smc.js';
import { evaluateAdaptive } from './strategies/adaptive.js';
import { evaluateICTM15 } from './strategies/ict_m15.js';
import { evaluateSMTM15 } from './strategies/smt_m15.js';
import { evaluateTrinity } from './strategies/trinity.js';
import { evaluateAMN } from './strategies/amn.js';
import { evaluateTORI } from './strategies/tori.js';
import { evaluateWARRIOR } from './strategies/warrior.js';
import { nyParts } from './lib/time.js';
import { get as getRuntimeConfig } from './lib/runtime_config.js';

export const STRATEGIES = [
  { name: 'USLS',     num: 1,  fn: evaluateUSLS,     label: 'USLS' },
  { name: 'ICT-SMC',  num: 2,  fn: evaluateICTSMC,   label: 'ICT/SMC' },
  { name: 'ALGO-SMC', num: 3,  fn: evaluateAlgoSMC,  label: 'ALGO/SMC' },
  { name: 'ADAPTIVE', num: 4,  fn: evaluateAdaptive, label: 'Adaptive Matrix' },
  { name: 'ICT',      num: 5,  fn: evaluateICTM15,   label: 'ICT M15' },
  { name: 'SMT',      num: 6,  fn: evaluateSMTM15,   label: 'SMT M15' },
  { name: 'TRINITY',  num: 7,  fn: evaluateTrinity,  label: 'Trinity' },
  { name: 'AMN',      num: 8,  fn: evaluateAMN,      label: 'AMN Dual-Model' },
  { name: 'TORI',     num: 9,  fn: evaluateTORI,     label: 'TORI Trendline' },
  { name: 'WARRIOR',  num: 10, fn: evaluateWARRIOR,  label: 'Warrior Momentum' },
];

const PANE_REQUESTS = [
  ['gold',   '1'],
  ['gold',   '5'],
  ['gold',   '15'],
  ['gold',   '60'],
  ['gold',   '1D'],
  ['silver', '5'],
  ['silver', '15'],
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

function buildCtxFromMaps(panesByTf, lastBarIdxByKey) {
  const ctxPanes = new Map();
  let anchor = null;
  for (const [key, p] of panesByTf) {
    const idx = lastBarIdxByKey.get(key) ?? p.bars.length - 1;
    if (idx < 30) continue;
    const slice = p.bars.slice(0, idx + 1);
    ctxPanes.set(key, { ...p, bars: slice });
    if (!anchor && (key === 'gold|5' || key === 'gold|15')) {
      anchor = ctxPanes.get(key);
    }
  }
  if (!anchor) {
    for (const [k, p] of ctxPanes) {
      if (k.startsWith('gold|')) { anchor = p; break; }
    }
  }
  if (!anchor) return null;
  const last = anchor.bars[anchor.bars.length - 1];
  const np = nyParts(last.time);
  return {
    ts: last.time * 1000,
    barTime: last.time,
    lastClose: last.close,
    panes: [...ctxPanes.values()],
    panesByTf: ctxPanes,
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
  const selected = STRATEGIES.filter((s) => enabledNames.includes(s.name));
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

  // Pick anchor — prefer 5m gold for the walk
  const anchorKey = ['gold|5', 'gold|15', 'gold|60'].find((k) => panesByTf.has(k));
  if (!anchorKey) {
    return { error: 'no anchor pane', stats: {}, panesSummary: [], window: null };
  }
  const anchorPane = panesByTf.get(anchorKey);
  const total = anchorPane.bars.length;
  const warmup = Math.min(80, Math.floor(total * 0.15));

  const panesSummary = [...panesByTf.entries()].map(([k, p]) => `${k}=${p.bars.length}`);
  const window = {
    days,
    fromUnix: anchorPane.bars[0].time,
    toUnix: anchorPane.bars[total - 1].time,
    anchorTF: anchorKey.split('|')[1] + 'm',
    anchorSym: anchorPane.symbol,
  };

  // Bookkeeping
  const stats = {};
  const seenSetupIds = {};
  const pendingLimits = {};
  for (const s of selected) {
    stats[s.name] = {
      name: s.name, num: s.num, label: s.label,
      ticksRun: 0, formingCount: 0, nearTriggerCount: 0,
      triggeredCount: 0, uniqueTriggered: 0, invalidatedCount: 0,
      limitsExpired: 0, trades: [],
    };
    seenSetupIds[s.name] = new Set();
    pendingLimits[s.name] = [];
  }

  // Walk forward through anchor bars
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
    const ctx = buildCtxFromMaps(panesByTf, lastBarIdx);
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
          if (seenSetupIds[s.name].has(r.setupId)) continue;
          if ((r.confidence || 0) < confMin) {
            seenSetupIds[s.name].add(r.setupId);
            continue;
          }
          seenSetupIds[s.name].add(r.setupId);
          st.uniqueTriggered++;
          pendingLimits[s.name].push({
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

  // Compute summary metrics per strategy
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
    // Average confidence and any A+ rate
    const confs = trades.map((t) => t.confidence || 0);
    s.avgConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
    s.aPlusCount = trades.filter((t) => (t.confidence || 0) >= 0.85).length;
    s.aPlusWinRate = s.aPlusCount > 0
      ? trades.filter((t) => (t.confidence || 0) >= 0.85 && t.win).length / s.aPlusCount
      : 0;
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
    lines.push(`Trades  : ${s.tradeCount}   Wins ${s.wins}/${s.tradeCount} (${(s.winRate*100).toFixed(0)}%)`);
    lines.push(`Sum R   : ${fmtR(s.sumR)}      Avg ${fmtR(s.avgR)}/trade`);
    lines.push(`Best    : ${fmtR(s.bestR)}     Worst ${fmtR(s.worstR)}`);
    if (s.aPlusCount > 0) {
      lines.push(`A+ subset: ${s.aPlusCount} trades, ${(s.aPlusWinRate*100).toFixed(0)}% wins`);
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
