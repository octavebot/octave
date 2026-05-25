/**
 * End-of-day report.
 *
 * Builds a summary of the trading day — signals sent, fills, outcomes,
 * win rate, R — from the signal-engine log and trades.jsonl. The signal
 * engine calls buildDailyReport() once at 18:00 NY and sends it to Telegram.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nyParts } from './time.js';
import * as followUp from './follow_up.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const TRADE_LOG = join(REPO, 'src', 'state', 'trades.jsonl');
const LOG_CANDIDATES = [
  '/home/octave/.octave-logs/signal-engine.log',
  '/Users/jqvier/Library/Logs/trading-alerts/stdout.log',
  process.env.HOME ? join(process.env.HOME, '.octave-logs', 'signal-engine.log') : null,
].filter(Boolean);

const INST = { gold: 'GOLD', nasdaq: 'NASDAQ' };
const fmtDay = (u) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
}).format(new Date(u * 1000));

/**
 * Build the end-of-day report text for the NY date containing `nowUnix`.
 * @returns {{ text: string, hasActivity: boolean }}
 */
export function buildDailyReport(nowUnix = Date.now() / 1000) {
  const todayKey = nyParts(nowUnix).dateKey;

  // ── Signals sent today (signal-engine log) ──
  const signals = [];
  const logPath = LOG_CANDIDATES.find(existsSync);
  if (logPath) {
    for (const line of readFileSync(logPath, 'utf8').split('\n')) {
      if (!line.includes('"alert fired"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.status !== 'triggered' || e.telegram !== 'sent') continue;
        const t = Date.parse(e.ts) / 1000;
        if (!Number.isFinite(t) || nyParts(t).dateKey !== todayKey) continue;
        signals.push({ strategy: e.strategy, setupId: e.setupId });
      } catch {}
    }
  }
  // Dedupe by setupId — collapse any re-fires into one signal.
  const seen = new Set();
  const uniq = signals.filter((s) => { if (seen.has(s.setupId)) return false; seen.add(s.setupId); return true; });

  const byInst = {}, byStrategy = {};
  for (const s of uniq) {
    const inst = String(s.setupId || '').split('|')[0];
    byInst[inst] = (byInst[inst] || 0) + 1;
    byStrategy[s.strategy] = (byStrategy[s.strategy] || 0) + 1;
  }

  // ── Outcomes today (trades.jsonl, live rows only) ──
  let tp1 = 0, tp2 = 0, runner = 0, sl = 0, expired = 0;
  let invalidated = 0, missed = 0, unfilled = 0;
  let sumR = 0, bestR = null, worstR = null;
  if (existsSync(TRADE_LOG)) {
    for (const line of readFileSync(TRADE_LOG, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.source !== 'live') continue;
        const t = Date.parse(r.ts) / 1000;
        if (!Number.isFinite(t) || nyParts(t).dateKey !== todayKey) continue;
        const reason = r.exit_reason;
        if (r.outcome === 'WIN') {
          if (reason === 'tp2') tp2++;
          else if (reason === 'runner') runner++;
          else tp1++;
        } else if (r.outcome === 'LOSS') {
          sl++;
        } else if (r.outcome === 'EXPIRED') {
          expired++;
        } else if (r.outcome === 'CANCELLED') {
          if (reason === 'invalidated') invalidated++;
          else if (reason === 'missed') missed++;
          else unfilled++;
        }
        if (r.outcome !== 'CANCELLED' && typeof r.risk_reward === 'number') {
          sumR += r.risk_reward;
          if (bestR == null || r.risk_reward > bestR) bestR = r.risk_reward;
          if (worstR == null || r.risk_reward < worstR) worstR = r.risk_reward;
        }
      } catch {}
    }
  }
  const wins = tp1 + tp2 + runner;
  const losses = sl;
  const cancelled = invalidated + missed + unfilled;
  const resolved = wins + losses;

  // ── Open positions carried into the next session ──
  let stillLive = 0, stillPending = 0;
  try {
    for (const s of followUp.active()) {
      if (s.phase === 'pending') stillPending++;
      else stillLive++;
    }
  } catch {}

  const hasActivity = uniq.length > 0 || resolved + cancelled + expired > 0;

  const lines = [
    '━━━━━━━━━━━━━━━━━━━━',
    `📊 *DAILY REPORT* · ${fmtDay(nowUnix)}`,
    '━━━━━━━━━━━━━━━━━━━━',
    '',
  ];

  if (!hasActivity) {
    lines.push('😴 *Quiet day* — no signals fired.', '',
      '_Markets thin or outside killzones. /backtest for the 30-day picture._');
    return { text: lines.join('\n'), hasActivity: false };
  }

  // ── Signals ──
  lines.push(`📡 *Signals fired*   ${uniq.length}`);
  const instParts = Object.entries(byInst).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${INST[k] || k} ${n}`);
  if (instParts.length) lines.push(`   ${instParts.join('  ·  ')}`);
  lines.push('');

  // ── Fills ──
  lines.push('⚙️ *Fills*');
  lines.push(`   ✅ Filled      ${resolved + stillLive}`);
  lines.push(`   ⏳ Pending     ${stillPending}`);
  lines.push(`   ⌛ Cancelled   ${cancelled}`);
  if (cancelled > 0) {
    const cp = [];
    if (invalidated) cp.push(`${invalidated} invalidated`);
    if (missed) cp.push(`${missed} missed`);
    if (unfilled) cp.push(`${unfilled} unfilled`);
    lines.push(`      ↳ ${cp.join(' · ')}`);
  }
  lines.push('');

  // ── Results ──
  lines.push(`🎯 *Results*  (${resolved} closed)`);
  if (resolved > 0) {
    lines.push(`   🟢 TP1 hit    ${tp1}`);
    lines.push(`   🏆 TP2 hit    ${tp2}`);
    if (runner) lines.push(`   🚀 Runner     ${runner}`);
    lines.push(`   🛑 SL hit     ${sl}`);
    if (expired) lines.push(`   ⏳ Expired    ${expired}`);
    const wr = Math.round((wins / resolved) * 100);
    lines.push('   ──────────────');
    lines.push(`   📈 Win rate   *${wr}%*   (${wins}W / ${losses}L)`);
    lines.push(`   💰 Net        *${sumR >= 0 ? '+' : ''}${sumR.toFixed(2)}R*`);
    if (bestR != null) lines.push(`   Best ${bestR >= 0 ? '+' : ''}${bestR.toFixed(2)}R · Worst ${worstR >= 0 ? '+' : ''}${worstR.toFixed(2)}R`);
  } else {
    lines.push('   _No trades closed yet — filled trades still running._');
  }
  lines.push('');

  // ── By strategy ──
  const ranked = Object.entries(byStrategy).sort((a, b) => b[1] - a[1]);
  if (ranked.length) {
    lines.push('🎚 *Signals by strategy*');
    for (const [name, n] of ranked) lines.push(`   ${name} · ${n}`);
    lines.push('');
  }

  // ── Carry-over ──
  if (stillLive + stillPending > 0) {
    lines.push(`📂 *Into next session:* ${stillLive} open · ${stillPending} pending limit${stillPending === 1 ? '' : 's'}`);
    lines.push('');
  }

  lines.push('_/summary anytime · /backtest for the 30-day picture._');
  return { text: lines.join('\n'), hasActivity: true };
}
