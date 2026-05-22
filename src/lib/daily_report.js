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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const TRADE_LOG = join(REPO, 'src', 'state', 'trades.jsonl');
const LOG_CANDIDATES = [
  '/home/octave/.octave-logs/signal-engine.log',
  '/Users/jqvier/Library/Logs/trading-alerts/stdout.log',
  process.env.HOME ? join(process.env.HOME, '.octave-logs', 'signal-engine.log') : null,
].filter(Boolean);

const INST = { gold: 'GOLD', nasdaq: 'NASDAQ', sp: 'S&P' };
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
  let wins = 0, losses = 0, cancelled = 0, expired = 0, sumR = 0;
  if (existsSync(TRADE_LOG)) {
    for (const line of readFileSync(TRADE_LOG, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.source !== 'live') continue;
        const t = Date.parse(r.ts) / 1000;
        if (!Number.isFinite(t) || nyParts(t).dateKey !== todayKey) continue;
        if (r.outcome === 'WIN') wins++;
        else if (r.outcome === 'LOSS') losses++;
        else if (r.outcome === 'CANCELLED') cancelled++;
        else if (r.outcome === 'EXPIRED') expired++;
        if (typeof r.risk_reward === 'number') sumR += r.risk_reward;
      } catch {}
    }
  }

  const hasActivity = uniq.length > 0 || wins + losses + cancelled + expired > 0;

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

  // Signals
  lines.push(`📡 *Signals sent*   ${uniq.length}`);
  const instParts = Object.entries(byInst)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${INST[k] || k} ${n}`);
  if (instParts.length) lines.push(`   ${instParts.join('  ·  ')}`);
  lines.push('');

  // Outcomes
  const resolved = wins + losses;
  lines.push('📋 *Outcomes*');
  if (resolved > 0) {
    const wr = Math.round((wins / resolved) * 100);
    lines.push(`   ✅ ${wins}W   ❌ ${losses}L   →   *${wr}%* win`);
    lines.push(`   💰 *${sumR >= 0 ? '+' : ''}${sumR.toFixed(2)}R* on the day`);
  } else {
    lines.push('   _No trades resolved yet — still running or none filled._');
  }
  if (cancelled > 0) lines.push(`   ⌛ ${cancelled} cancelled — limit never filled _(not W/L)_`);
  if (expired > 0) lines.push(`   ⏳ ${expired} expired open`);
  lines.push('');

  // By strategy
  const ranked = Object.entries(byStrategy).sort((a, b) => b[1] - a[1]);
  if (ranked.length) {
    lines.push('🎚 *By strategy*');
    for (const [name, n] of ranked) lines.push(`   ${name} · ${n}`);
    lines.push('');
  }

  lines.push('_Send /summary anytime · /backtest for the 30-day picture._');
  return { text: lines.join('\n'), hasActivity: true };
}
