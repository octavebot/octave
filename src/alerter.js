import { config } from './config.js';
import { log } from './logger.js';
import { buildAlertChartUrl } from './lib/chart_image.js';
import { get as getRuntimeConfig } from './lib/runtime_config.js';
import { send as sendViaQueue, startDrain } from './lib/telegram_queue.js';
startDrain(); // re-attempt any queued sends on startup

const API = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
const API_PHOTO = `https://api.telegram.org/bot${config.telegramBotToken}/sendPhoto`;
const MIN_GAP_MS = 1000;
const BAR = '══════════════════';
const TG_CAPTION_MAX = 1024; // Telegram's caption limit
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
  AMN: '#8',
  TORI: '#9',
  WARRIOR: '#10',
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
  // Routes through the queue: succeeds immediately on a good network, or
  // gets persisted to disk + retried with backoff when Telegram is down.
  return sendViaQueue(config.telegramBotToken, 'sendMessage', {
    chat_id: config.telegramChatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
}

/**
 * Post a photo with a caption. If the caption exceeds Telegram's 1024-char
 * cap we send the photo with a short caption and then post the full text
 * as a follow-up message.
 */
async function postPhoto(photoUrl, caption) {
  const gap = Date.now() - lastSendAt;
  if (gap < MIN_GAP_MS) await new Promise((r) => setTimeout(r, MIN_GAP_MS - gap));
  lastSendAt = Date.now();

  const fullText = caption || '';
  const fitsInCaption = fullText.length <= TG_CAPTION_MAX;
  const shortCaption = fitsInCaption ? fullText : (fullText.slice(0, TG_CAPTION_MAX - 40) + '…\n_(full detail below)_');

  const ok = await sendViaQueue(config.telegramBotToken, 'sendPhoto', {
    chat_id: config.telegramChatId,
    photo: photoUrl,
    caption: shortCaption,
    parse_mode: 'Markdown',
  });
  if (ok && !fitsInCaption) {
    await postRaw(fullText);
  }
  return ok;
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
// Determine whether the entry can be MARKET-ordered right now, or needs a
// resting LIMIT. The strategies all use limit-style entries (FVG midpoint,
// C1 edge, etc.) so most triggers expect price to retrace into the zone.
//
//   LONG: limit BUY below current price → wait for retrace down to fill
//   SHORT: limit SELL above current price → wait for retrace up to fill
//   If current price is already at/past the limit, it's market-fillable now.
function entryIntent(direction, entry, currentPrice, risk) {
  if (entry == null || currentPrice == null) return null;
  const diff = currentPrice - entry;
  const tolerance = risk ? Math.max(0.5, 0.15 * risk) : 1;
  if (Math.abs(diff) <= tolerance) {
    return { label: '🚀 MARKET — fill NOW', hint: 'price is at entry level' };
  }
  if (direction === 'LONG') {
    if (diff > 0) {
      return { label: `⏳ LIMIT BUY @ $${entry.toFixed(2)}`, hint: `price is $${diff.toFixed(2)} above entry, wait for pullback` };
    }
    return { label: '🚀 MARKET BUY — price already at entry', hint: `price is $${Math.abs(diff).toFixed(2)} below entry` };
  }
  // SHORT
  if (diff < 0) {
    return { label: `⏳ LIMIT SELL @ $${entry.toFixed(2)}`, hint: `price is $${(-diff).toFixed(2)} below entry, wait for pullback` };
  }
  return { label: '🚀 MARKET SELL — price already at entry', hint: `price is $${diff.toFixed(2)} above entry` };
}

export async function send(r, ctx) {
  // TRIGGERED-only format per user directive. Non-triggered (forming /
  // near_trigger / invalidated) shouldn't reach here because loop.js filters,
  // but if one slips through we send a minimal one-liner instead of crashing.
  if (r.status !== 'triggered' || !r.entryPlan) {
    return postRaw([
      BAR,
      `${STATUS_EMOJI[r.status] || '🔔'} *${STATUS_LABEL[r.status] || r.status}*`,
      tgEscape(r.setupName || ''),
      BAR,
    ].join('\n'));
  }

  const ep = r.entryPlan;
  const num = strategyNum(r.strategy);
  const dirWord = r.direction === 'LONG' ? 'LONG' : 'SHORT';
  const conf = Math.round((r.confidence || 0) * 100);
  const risk = ep.risk ?? Math.abs(ep.entry - ep.stop);
  const intent = entryIntent(r.direction, ep.entry, ctx.lastClose, risk);
  const fmt = (v) => (v != null && Number.isFinite(+v)) ? Number(v).toFixed(2) : '—';
  const t1r = ep.t1 != null ? Math.abs(ep.t1 - ep.entry) / risk : null;
  const t2r = ep.t2 != null ? Math.abs(ep.t2 - ep.entry) / risk : null;

  const lines = [];
  lines.push(BAR);
  lines.push(`🚀 *GOLD ${dirWord}*  ·  ${num}`);
  if (intent) lines.push(`*${intent.label}*`);
  lines.push(BAR);
  lines.push('');

  // Monospace price block — tappable & copy-friendly on mobile
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

  // Live context
  if (ctx.lastClose != null && ep.entry != null) {
    const diff = ctx.lastClose - ep.entry;
    const sign = diff >= 0 ? '+' : '';
    lines.push(`📍 Current: *$${fmt(ctx.lastClose)}*  (${sign}${diff.toFixed(2)} from entry)`);
  } else if (ctx.lastClose != null) {
    lines.push(`📍 Current: *$${fmt(ctx.lastClose)}*`);
  }
  if (intent?.hint) lines.push(`_${tgEscape(intent.hint)}_`);
  lines.push('');

  // ---- Trade management hints ----
  // Universal rule: move SL → breakeven at +1R, scale out at TP1, trail to runner
  const bePrice = ep.t1 != null
    ? (r.direction === 'LONG' ? ep.entry + risk : ep.entry - risk)
    : null;
  if (bePrice != null) {
    lines.push('💡 *Trade management*');
    lines.push(`• At +1R ($${fmt(bePrice)}): move SL → breakeven ($${fmt(ep.entry)})`);
    if (ep.t1 != null) lines.push(`• At TP1 ($${fmt(ep.t1)}): close 50%, let rest run`);
    if (ep.t2 != null && ep.t2 !== ep.t1) lines.push(`• At TP2 ($${fmt(ep.t2)}): close remainder OR trail to runner`);
    lines.push('');
  }

  lines.push(`⚡ Confidence: *${conf}%*   ⏰ TF: \`${ctx.timeframe || '?'}m\``);
  if (r.summary) {
    lines.push('');
    lines.push(`ℹ️ ${tgEscape(r.summary)}`);
  }
  lines.push('');
  lines.push(BAR);

  const text = lines.join('\n');

  // Chart image path: if alertChartImages is enabled in runtime config (default
  // ON), generate a QuickChart URL with entry/SL/TP overlaid on recent bars
  // and send via sendPhoto. Falls back to text-only sendMessage on any failure.
  const cfg = getRuntimeConfig();
  if (cfg?.alertChartImages !== false) {
    const photoUrl = await buildAlertChartUrl(r);
    if (photoUrl) {
      const ok = await postPhoto(photoUrl, text);
      if (ok) return true;
      // sendPhoto failed (network glitch or Telegram couldn't fetch the image)
      // — fall through to text-only send so the user still gets the alert
      log.warn('sendPhoto failed, falling back to text', {});
    }
  }
  return postRaw(text);
}
