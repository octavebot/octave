import { config } from './config.js';
import { log } from './logger.js';

const API = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
const MIN_GAP_MS = 1000;
const BAR = '══════════════════';
let lastSendAt = 0;

const STATUS_GLYPH = {
  forming: { head: '👀', verb: 'forming', dir_word: (d) => d || 'NEUTRAL' },
  near_trigger: { head: '⚠️', verb: 'near trigger', dir_word: (d) => d },
  triggered: { head: '🚀', verb: 'TRIGGERED', dir_word: (d) => d },
  invalidated: { head: '❌', verb: 'INVALIDATED', dir_word: (d) => d || 'NONE' },
};

const STRATEGY_NUM = {
  USLS: '#1',
  'ICT-SMC': '#2',
  'ALGO-SMC': '#3',
  ADAPTIVE: '#4',
  ICT: '#5',
  SMT: '#6',
  TRINITY: '#7',
};

function strategyNum(name) {
  return STRATEGY_NUM[name] || `(${name})`;
}

function tgEscape(s) {
  return String(s).replace(/([_*`\[])/g, '\\$1');
}

function fmtPrice(p) {
  if (p == null || !Number.isFinite(+p)) return '—';
  return Number(p).toFixed(2);
}

function fmtPct(c) {
  if (c == null) return '—';
  return `${Math.round(c * 100)}%`;
}

async function postRaw(text) {
  const gap = Date.now() - lastSendAt;
  if (gap < MIN_GAP_MS) await new Promise((r) => setTimeout(r, MIN_GAP_MS - gap));
  lastSendAt = Date.now();
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    log.warn('telegram non-2xx', { status: res.status, body });
    return false;
  }
  return true;
}

export async function sendStartup({ symbol, timeframe }) {
  const sym = symbol || '(no chart)';
  const tf = timeframe || '?';
  const text = [
    BAR,
    `✅ *OCTAVE ONLINE*`,
    `📊 Active strategies: #5 (ICT) · #6 (SMT) · #7 (Trinity)`,
    `🔕 Inactive: #1-#4 (deactivated)`,
    BAR,
    ``,
    `🔌 Watching: \`${tgEscape(sym)}\` · \`${tgEscape(tf)}m\``,
    `🤖 Telegram channel connected`,
    `🟢 Service started · monitoring live`,
    ``,
    BAR,
  ].join('\n');
  return postRaw(text);
}

export async function sendDown(reason) {
  return postRaw(`${BAR}\n⚠️ *OCTAVE STOPPING*\n${tgEscape(reason)}\n${BAR}`);
}

/**
 * Session-banner alert (separate path from setup alerts).
 * Called by detector when active session transitions.
 */
export async function sendSessionChange({ fromSession, toSession, nowLabel, hint }) {
  const text = [
    BAR,
    `🌍 *SESSION CHANGE*`,
    `📅 ${toSession.toUpperCase()}${fromSession ? ` (was ${fromSession.toUpperCase()})` : ''}`,
    BAR,
    ``,
    `⏰ ${tgEscape(nowLabel)}`,
    hint ? `ℹ️ ${tgEscape(hint)}` : '',
    ``,
    BAR,
  ].filter(Boolean).join('\n');
  return postRaw(text);
}

/**
 * Setup alert in the new box-drawing format.
 *
 *   ══════════════════
 *   🚀 GOLD — LONG
 *   📊 STRATEGY #1
 *   ══════════════════
 *
 *   🟢 Buy: 4490.50
 *   🛑 SL:  4484.30
 *   🎯 TP1: 4496.70
 *   🎯 TP2: 4502.90
 *
 *   ⏰ Timeframe: 5m
 *   ⚡ Confidence: 87%
 *
 *   ℹ️ <summary>
 *
 *   ══════════════════
 */
export async function send(r, ctx) {
  const g = STATUS_GLYPH[r.status] || { head: '🔔', verb: r.status, dir_word: (d) => d };
  const head = g.head;
  const directionWord = g.dir_word(r.direction || 'NEUTRAL');
  const num = strategyNum(r.strategy);
  const ep = r.entryPlan || r.geometry?.entryPlan;
  const tfDisplay = ctx.timeframe ? `${ctx.timeframe}m` : '?';

  // Title line: "🚀 GOLD — LONG" or "👀 GOLD — LONG (forming)"
  const stateTag =
    r.status === 'triggered' ? '' :
    r.status === 'invalidated' ? ' (invalidated)' :
    r.status === 'near_trigger' ? ' (near)' :
    ' (forming)';
  const title = `${head} GOLD — ${directionWord}${stateTag}`;

  const lines = [];
  lines.push(BAR);
  lines.push(`*${title}*`);
  lines.push(`📊 STRATEGY ${num}`);
  lines.push(BAR);
  lines.push('');

  if (r.status === 'triggered' && ep) {
    // Full trade plan
    lines.push(`🟢 Buy:  *${fmtPrice(ep.entry)}*`);
    lines.push(`🛑 SL:   *${fmtPrice(ep.stop)}*`);
    lines.push(`🎯 TP1:  *${fmtPrice(ep.t1)}*  _(1R)_`);
    lines.push(`🎯 TP2:  *${fmtPrice(ep.t2)}*  _(2R)_`);
    if (ep.runner != null) lines.push(`🏃 Runner: *${fmtPrice(ep.runner)}*  _(DOL)_`);
  } else if (r.status === 'invalidated') {
    if (r.invalidationLevel != null) lines.push(`🛑 Invalidation: *${fmtPrice(r.invalidationLevel)}*`);
    if (ctx.lastClose != null) lines.push(`📍 Price now: *${fmtPrice(ctx.lastClose)}*`);
  } else {
    // forming / near_trigger — show what we know so far
    if (r.geometry?.target?.level != null) {
      lines.push(`🎯 Target: *${fmtPrice(r.geometry.target.level)}* (${tgEscape(r.geometry.target.name || '')})`);
    }
    if (r.geometry?.sweep?.wickPrice != null) {
      lines.push(`⚔️ Sweep wick: *${fmtPrice(r.geometry.sweep.wickPrice)}*`);
    }
    if (r.geometry?.mss?.brokenPrice != null) {
      lines.push(`📈 MSS @ *${fmtPrice(r.geometry.mss.brokenPrice)}*`);
    }
    if (ctx.lastClose != null) lines.push(`📍 Price now: *${fmtPrice(ctx.lastClose)}*`);
    if (r.invalidationLevel != null) lines.push(`🛡 Invalidates if: *${fmtPrice(r.invalidationLevel)}*`);
  }

  lines.push('');
  lines.push(`⏰ Timeframe: \`${tgEscape(tfDisplay)}\``);
  lines.push(`⚡ Confidence: *${fmtPct(r.confidence)}*`);
  lines.push('');

  if (r.summary) {
    lines.push(`ℹ️ ${tgEscape(r.summary)}`);
    lines.push('');
  }

  lines.push(BAR);

  return postRaw(lines.join('\n'));
}
