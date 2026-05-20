/**
 * Cloud tick — one-shot entry point for the autonomous service.
 *
 * Designed to be invoked by a GitHub Actions cron (or any scheduler).
 * Each invocation:
 *   1. Fetches bars from Yahoo (primary) and OANDA (fallback)
 *   2. Builds a ctx in the same shape detector.js builds locally
 *   3. Runs the active strategies (#5 ICT, #6 SMT, #7 Trinity)
 *   4. Dedups against state/cloud-dedup.json (committed to the repo)
 *   5. Sends Telegram for any new alerts
 *   6. Writes state/cloud-heartbeat.json so the local Mac service knows
 *      the cloud is alive and can suppress duplicate Telegram sends
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN   required
 *   TELEGRAM_CHAT_ID     required
 *   OANDA_API_TOKEN      optional (enables OANDA fallback)
 *
 * Exit codes:
 *   0   success (zero or more alerts fired)
 *   2   missing required env
 *   3   data fetch failure (no panes)
 *   4   unexpected exception
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCloudCtx } from './data_source.js';
import { evaluateUSLS } from '../strategies/usls.js';
import { evaluateICTSMC } from '../strategies/ict_smc.js';
import { evaluateAlgoSMC } from '../strategies/algo_smc.js';
import { evaluateAdaptive } from '../strategies/adaptive.js';
import { evaluateICTM15 } from '../strategies/ict_m15.js';
import { evaluateSMTM15 } from '../strategies/smt_m15.js';
import { evaluateTrinity } from '../strategies/trinity.js';
import { refresh as refreshConfig, isStrategyEnabled, cloudShouldFire, isMuted, muteRemainingSec } from '../lib/runtime_config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_DIR = join(__dirname, '..', 'state');
const DEDUP_FILE = join(STATE_DIR, 'cloud-dedup.json');
const HEARTBEAT_FILE = join(STATE_DIR, 'cloud-heartbeat.json');
const BAR = '══════════════════';

function loadDedup() {
  if (!existsSync(DEDUP_FILE)) return { version: 1, entries: {} };
  try {
    const j = JSON.parse(readFileSync(DEDUP_FILE, 'utf8'));
    return j?.entries ? j : { version: 1, entries: {} };
  } catch { return { version: 1, entries: {} }; }
}

function writeAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

function pruneDedup(state, hours = 6) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  for (const [k, v] of Object.entries(state.entries)) {
    if ((v.firedAt || 0) < cutoff) delete state.entries[k];
  }
}

const STATUS_GLYPH = {
  forming: '👀',
  near_trigger: '⚠️',
  triggered: '🚀',
  invalidated: '❌',
};
const STATUS_LABEL = {
  forming: 'FORMING',
  near_trigger: 'NEAR TRIGGER',
  triggered: 'TRIGGERED',
  invalidated: 'INVALIDATED',
};
const STRATEGY_NUM = {
  USLS: '#1', 'ICT-SMC': '#2', 'ALGO-SMC': '#3', ADAPTIVE: '#4',
  ICT: '#5', SMT: '#6', TRINITY: '#7',
};
function biasBanner(dir) {
  if (dir === 'LONG') return '🟢 *BUY BIAS — LONG*';
  if (dir === 'SHORT') return '🔴 *SELL BIAS — SHORT*';
  return '⚪ *NO BIAS*';
}
function tgEscape(s) { return String(s).replace(/([_*`\[])/g, '\\$1'); }
function fmtPrice(p) { return p == null || !Number.isFinite(+p) ? '—' : Number(p).toFixed(2); }
function fmtPct(c) { return c == null ? '—' : `${Math.round(c * 100)}%`; }

function entryIntent(direction, entry, currentPrice, risk) {
  if (entry == null || currentPrice == null) return null;
  const diff = currentPrice - entry;
  const tolerance = risk ? Math.max(0.5, 0.15 * risk) : 1;
  if (Math.abs(diff) <= tolerance) return { label: '🚀 MARKET — fill NOW', hint: 'price is at entry level' };
  if (direction === 'LONG') {
    if (diff > 0) return { label: `⏳ LIMIT BUY @ $${entry.toFixed(2)}`, hint: `price is $${diff.toFixed(2)} above entry, wait for pullback` };
    return { label: '🚀 MARKET BUY — price already at entry', hint: `price is $${Math.abs(diff).toFixed(2)} below entry` };
  }
  if (diff < 0) return { label: `⏳ LIMIT SELL @ $${entry.toFixed(2)}`, hint: `price is $${(-diff).toFixed(2)} below entry, wait for pullback` };
  return { label: '🚀 MARKET SELL — price already at entry', hint: `price is $${diff.toFixed(2)} above entry` };
}

function formatAlert(r, ctx) {
  // This formatter is only called for status === 'triggered' (cloud tick
  // filters non-triggered upstream). Still defend against unexpected shapes.
  const ep = r.entryPlan || r.geometry?.entryPlan;
  if (!ep) {
    return [BAR, `🔔 *${STATUS_LABEL[r.status] || r.status}*`, tgEscape(r.setupName || ''), BAR].join('\n');
  }
  const num = STRATEGY_NUM[r.strategy] || r.strategy;
  const dirWord = r.direction === 'LONG' ? 'LONG' : 'SHORT';
  const conf = Math.round((r.confidence || 0) * 100);
  const risk = ep.risk ?? Math.abs(ep.entry - ep.stop);
  const intent = entryIntent(r.direction, ep.entry, ctx.lastClose, risk);
  const fmt = (v) => v != null && Number.isFinite(+v) ? Number(v).toFixed(2) : '—';
  const t1r = ep.t1 != null ? Math.abs(ep.t1 - ep.entry) / risk : null;
  const t2r = ep.t2 != null ? Math.abs(ep.t2 - ep.entry) / risk : null;

  const lines = [];
  lines.push(BAR);
  lines.push(`🚀 *GOLD ${dirWord}*  ·  ${num}  ·  ☁️ cloud`);
  if (intent) lines.push(`*${intent.label}*`);
  lines.push(BAR);
  lines.push('');

  lines.push('```');
  lines.push(`Entry  $${fmt(ep.entry)}`);
  lines.push(`SL     $${fmt(ep.stop)}     -$${fmt(risk)} risk`);
  if (ep.t1 != null) lines.push(`TP1    $${fmt(ep.t1)}     +${t1r != null ? t1r.toFixed(1) : '?'}R`);
  if (ep.t2 != null) lines.push(`TP2    $${fmt(ep.t2)}     +${t2r != null ? t2r.toFixed(1) : '?'}R`);
  if (ep.runner != null && ep.runner !== ep.t2) {
    const rr = Math.abs(ep.runner - ep.entry) / risk;
    lines.push(`Runner $${fmt(ep.runner)}     +${rr.toFixed(1)}R`);
  }
  lines.push('```');
  lines.push('');

  if (ctx.lastClose != null && ep.entry != null) {
    const diff = ctx.lastClose - ep.entry;
    lines.push(`📍 Current: *$${fmt(ctx.lastClose)}*  (${diff >= 0 ? '+' : ''}${diff.toFixed(2)} from entry)`);
  }
  if (intent?.hint) lines.push(`_${tgEscape(intent.hint)}_`);
  lines.push('');
  lines.push(`⚡ Confidence: *${conf}%*   ⏰ TF: \`${ctx.anchorResolution}m\``);
  if (r.summary) { lines.push(''); lines.push(`ℹ️ ${tgEscape(r.summary)}`); }
  lines.push('');
  lines.push(BAR);
  return lines.join('\n');
}

async function sendTelegram(text, token, chatId) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`telegram non-2xx: ${res.status} ${body}`);
    return false;
  }
  return true;
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    process.exit(2);
  }

  let ctx;
  try {
    ctx = await buildCloudCtx();
  } catch (err) {
    console.error('Cloud ctx build failed:', err.message);
    // Still write heartbeat (with error) so local knows we tried
    writeAtomic(HEARTBEAT_FILE, {
      lastTick: Date.now(),
      status: 'error',
      error: err.message,
    });
    process.exit(3);
  }

  const panesSummary = [];
  for (const [k, p] of ctx.panesByTf) {
    panesSummary.push(`${k}=${p.bars.length}b(${p.source})`);
  }
  console.log(`[cloud-tick] panes: ${panesSummary.join(', ')}`);
  console.log(`[cloud-tick] anchor: ${ctx.anchorSymbol} ${ctx.anchorResolution}m lastClose=${ctx.lastClose}`);

  // Refresh runtime config and respect mode/strategy/mute toggles
  refreshConfig();

  // Mode 'local' or active mute means cloud should not fire alerts.
  // Still write the heartbeat so local knows cloud is online but intentionally silent.
  if (!cloudShouldFire() || isMuted()) {
    const reason = isMuted() ? `muted (${muteRemainingSec()}s left)` : 'mode=local';
    console.log(`[cloud-tick] ${reason} — skipping alert dispatch (still writing heartbeat)`);
    writeAtomic(HEARTBEAT_FILE, {
      lastTick: Date.now(),
      status: isMuted() ? 'skipped-muted' : 'skipped-mode-local',
      reason,
      fired: 0,
      pane_count: ctx.panesByTf.size,
      anchor: { symbol: ctx.anchorSymbol, tf: ctx.anchorResolution, close: ctx.lastClose, time: ctx.barTime },
      panes_summary: panesSummary,
    });
    console.log(`[cloud-tick] done (${reason}).`);
    return;
  }

  // Run enabled strategies. Each call wrapped so one strategy throwing doesn't kill others.
  const results = [];
  const STRATEGY_TABLE = [
    ['USLS', evaluateUSLS],
    ['ICT-SMC', evaluateICTSMC],
    ['ALGO-SMC', evaluateAlgoSMC],
    ['ADAPTIVE', evaluateAdaptive],
    ['ICT', evaluateICTM15],
    ['SMT', evaluateSMTM15],
    ['TRINITY', evaluateTrinity],
  ];
  for (const [name, fn] of STRATEGY_TABLE) {
    if (!isStrategyEnabled(name)) continue;
    try {
      results.push(...(fn(ctx) || []));
    } catch (err) {
      console.error(`[cloud-tick] ${name} threw:`, err.message);
    }
  }

  console.log(`[cloud-tick] detector returned ${results.length} results`);

  // Dedup + send
  const dedup = loadDedup();
  pruneDedup(dedup);
  let fired = 0;
  // Sort by priority so highest-impact alerts fire first within rate limits
  const PRI = { triggered: 0, invalidated: 1, near_trigger: 2, forming: 3 };
  results.sort((a, b) => (PRI[a.status] ?? 9) - (PRI[b.status] ?? 9) || (b.confidence || 0) - (a.confidence || 0));

  for (const r of results) {
    const key = `${r.setupId}:${r.status}`;
    if (dedup.entries[key]) continue;

    // Telegram filter: per user directive, only TRIGGERED setups are alerted.
    // Other statuses are still recorded in dedup (so we don't accumulate stale
    // entries) but don't ring the phone.
    const isTelegramWorthy = r.status === 'triggered';

    dedup.entries[key] = {
      firedAt: Date.now(),
      strategy: r.strategy,
      status: r.status,
      direction: r.direction,
      telegram: isTelegramWorthy ? 'pending' : 'skipped-not-triggered',
    };

    if (!isTelegramWorthy) {
      console.log(`[cloud-tick] ${r.strategy} ${r.status} ${r.setupId} — dedup recorded, telegram skipped`);
      continue;
    }

    const text = formatAlert(r, ctx);
    const ok = await sendTelegram(text, token, chatId);
    if (ok) {
      fired++;
      dedup.entries[key].telegram = 'sent';
      console.log(`[cloud-tick] alert fired: ${r.strategy} ${r.status} ${r.setupId}`);
      await new Promise((s) => setTimeout(s, 1200));
    } else {
      delete dedup.entries[key];
    }
  }

  writeAtomic(DEDUP_FILE, dedup);
  writeAtomic(HEARTBEAT_FILE, {
    lastTick: Date.now(),
    status: 'ok',
    fired,
    pane_count: ctx.panesByTf.size,
    anchor: { symbol: ctx.anchorSymbol, tf: ctx.anchorResolution, close: ctx.lastClose, time: ctx.barTime },
    panes_summary: panesSummary,
  });

  console.log(`[cloud-tick] done. fired=${fired} dedup_entries=${Object.keys(dedup.entries).length}`);
}

main().catch((err) => {
  console.error('[cloud-tick] fatal:', err.message, err.stack);
  try {
    writeAtomic(HEARTBEAT_FILE, { lastTick: Date.now(), status: 'fatal', error: err.message });
  } catch {}
  process.exit(4);
});
