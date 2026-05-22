/**
 * Alerter — builds and sends Telegram trade-signal cards.
 *
 * The triggered-setup card is a clean box-drawing layout designed for fast
 * execution on a live account: direction, instrument, entry zone, TP1/TP2,
 * SL, trade data, the strategy + its confirmations, and the Holy AI opinion.
 *
 * Exports: send, sendFollowUp, sendStartup, sendSessionChange, sendDown.
 */

import { config } from './config.js';
import { log } from './logger.js';
import { buildAlertChartUrl } from './lib/chart_image.js';
import { get as getRuntimeConfig } from './lib/runtime_config.js';
import { send as sendViaQueue, startDrain } from './lib/telegram_queue.js';
import { register as registerFollowUp } from './lib/follow_up.js';
import { INSTRUMENT_META } from './detector.js';
import { loadRegistry } from './lib/strategy_registry.js';

startDrain();

const MIN_GAP_MS = 1000;
const TG_CAPTION_MAX = 1024;
let lastSendAt = 0;

// ─── Strategy name cache ─────────────────────────────────────────────────
// The detector result carries the strategy id; we want the human name in
// the card. Load the registry once, cache id→name. Falls back to the id.

let _nameCache = null;
async function strategyName(id) {
  if (!_nameCache) {
    _nameCache = {};
    try {
      for (const s of await loadRegistry()) _nameCache[s.id] = s.name;
    } catch {}
  }
  return _nameCache[id] || id;
}

// ─── Formatting helpers ──────────────────────────────────────────────────

function tgEscape(s) {
  return String(s).replace(/([_*`\[])/g, '\\$1');
}

function fmtPrice(v) {
  if (v == null || !Number.isFinite(+v)) return '—';
  const n = Number(v);
  // Thousands separator, 2 decimals. Nasdaq ~20000 looks better with commas.
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function tfLabel(tf) {
  const map = { '1': '1M', '3': '3M', '5': '5M', '15': '15M', '30': '30M', '60': '1H', '240': '4H', '1D': '1D', 'D': '1D' };
  return map[String(tf)] || `${tf}M`;
}

function riskLabel(conf) {
  if (conf >= 0.78) return 'Low';
  if (conf >= 0.68) return 'Medium';
  return 'High';
}

// ─── Transport ───────────────────────────────────────────────────────────

async function postRaw(text) {
  const gap = Date.now() - lastSendAt;
  if (gap < MIN_GAP_MS) await new Promise((r) => setTimeout(r, MIN_GAP_MS - gap));
  lastSendAt = Date.now();
  return sendViaQueue(config.telegramBotToken, 'sendMessage', {
    chat_id: config.telegramChatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
}

async function postPhoto(photoUrl, caption) {
  const gap = Date.now() - lastSendAt;
  if (gap < MIN_GAP_MS) await new Promise((r) => setTimeout(r, MIN_GAP_MS - gap));
  lastSendAt = Date.now();
  const full = caption || '';
  const fits = full.length <= TG_CAPTION_MAX;
  const shortCaption = fits ? full : full.slice(0, TG_CAPTION_MAX - 30) + '…';
  const ok = await sendViaQueue(config.telegramBotToken, 'sendPhoto', {
    chat_id: config.telegramChatId,
    photo: photoUrl,
    caption: shortCaption,
    parse_mode: 'Markdown',
  });
  if (ok && !fits) await postRaw(full);
  return ok;
}

// ─── Signal card ─────────────────────────────────────────────────────────

/**
 * Build the box-drawing signal card for a triggered setup.
 * @param {object} r    detector result (triggered, with entryPlan)
 * @param {object} ctx  { symbol, timeframe, lastClose }
 */
async function buildSignalCard(r, ctx) {
  const ep = r.entryPlan;
  const inst = INSTRUMENT_META[r.instrument] || { label: r.instrument || '?', symbol: r.symbol || '?' };
  const dirIcon = r.direction === 'LONG' ? '🟢' : '🔴';
  const risk = ep.risk ?? Math.abs(ep.entry - ep.stop);

  // Entry zone — a small execution band around the limit price (±6% of risk).
  const band = 0.06 * risk;
  const zLo = ep.entry - band;
  const zHi = ep.entry + band;

  // Confidence: prefer the AI-adjusted figure (what actually gated the send).
  const conf = r.adjustedConfidence ?? r.confidence ?? 0;
  const confPct = Math.round(conf * 100);

  // RR — to the furthest target.
  const farTarget = ep.t2 ?? ep.t1;
  const rr = (farTarget != null && risk > 0) ? Math.abs(farTarget - ep.entry) / risk : null;

  const name = await strategyName(r.strategy);
  const confirmations = Array.isArray(r.confirmations) && r.confirmations.length
    ? r.confirmations
    : [r.setupName || 'Strategy trigger'];

  const lines = [];
  lines.push('╭───────────────────────╮');
  lines.push('│   ⚡ *OCTAVE SIGNAL* ⚡   │');
  lines.push('╰───────────────────────╯');
  lines.push('');
  lines.push(`${dirIcon} *${r.direction}*   ·   *${inst.label.toUpperCase()}*`);
  lines.push(`\`${inst.symbol}\``);
  lines.push('');
  lines.push('┌ *Entry Zone* ──────────');
  lines.push(`  \`${fmtPrice(zLo)}\` — \`${fmtPrice(zHi)}\``);
  lines.push('');
  lines.push('├ *Take Profit* ─────────');
  if (ep.t1 != null) lines.push(`  🎯 TP1  →  \`${fmtPrice(ep.t1)}\``);
  if (ep.t2 != null) lines.push(`  🎯 TP2  →  \`${fmtPrice(ep.t2)}\``);
  lines.push('');
  lines.push('├ *Stop Loss* ───────────');
  lines.push(`  ❌  \`${fmtPrice(ep.stop)}\``);
  lines.push('');
  lines.push('├ *Trade Data* ──────────');
  lines.push(`  ⏰ TF     →  ${tfLabel(r.timeframe || ctx.timeframe)}`);
  lines.push(`  📊 Conf   →  ${confPct}%`);
  lines.push(`  ⚠️ Risk   →  ${riskLabel(conf)}`);
  if (rr != null) lines.push(`  💎 RR     →  1:${rr.toFixed(1)}`);
  lines.push('');
  lines.push('├ *Confirmation* ────────');
  lines.push(`  _${tgEscape(name)}_`);
  for (const c of confirmations.slice(0, 4)) lines.push(`  ✓ ${tgEscape(c)}`);
  lines.push('╰───────────────────────╯');

  if (r.aiCommentary) {
    lines.push('');
    lines.push('🤖 *Holy AI*');
    lines.push(`_${tgEscape(r.aiCommentary)}_`);
  }
  return lines.join('\n');
}

/**
 * Main entry: send a detector result as a Telegram alert.
 * Only 'triggered' setups get the full card; others get a one-liner.
 */
export async function send(r, ctx = {}) {
  if (r.status !== 'triggered' || !r.entryPlan) {
    // Non-triggered states don't normally reach here (loop.js gates on
    // triggered) but keep a minimal fallback.
    const name = await strategyName(r.strategy);
    return postRaw(`👀 *${tgEscape(name)}* — ${r.status}\n${tgEscape(r.setupName || '')}`);
  }

  // Register for follow-up milestone pings (BE/TP1/TP2/SL).
  try { registerFollowUp(r); }
  catch (err) { log.warn('registerFollowUp threw', { err: err.message }); }

  const card = await buildSignalCard(r, ctx);

  // Chart image path — overlay entry/SL/TP on recent bars when enabled.
  const cfg = getRuntimeConfig();
  if (cfg?.alertChartImages !== false) {
    try {
      const photoUrl = await buildAlertChartUrl(r);
      if (photoUrl) {
        const ok = await postPhoto(photoUrl, card);
        if (ok) return true;
        log.warn('sendPhoto failed, falling back to text', {});
      }
    } catch (err) {
      log.warn('chart image build threw', { err: err.message });
    }
  }
  return postRaw(card);
}

// ─── Follow-up milestone alerts ──────────────────────────────────────────

export async function sendFollowUp({ setup, milestone, currentPrice }) {
  const fmt = (v) => fmtPrice(v);
  const dir = setup.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  let head, body;
  switch (milestone) {
    case 'be':
      head = '🟡 *MOVE TO BREAKEVEN*';
      body = `+1R reached. Drag SL to entry \`${fmt(setup.entry)}\` — trade is now risk-free.`;
      break;
    case 'tp1':
      head = '🎯 *TP1 HIT*';
      body = `Close 50% at \`${fmt(setup.t1)}\`. SL should be at BE; leave the runner.`;
      break;
    case 'tp2':
      head = '🏆 *TP2 HIT — FULL TARGET*';
      body = `Target reached at \`${fmt(setup.t2)}\`. Trade complete.`;
      break;
    case 'runner':
      head = '🚀 *RUNNER HIT*';
      body = `Extended past TP2 to \`${fmt(setup.runner)}\`. Banner trade — close it out.`;
      break;
    case 'sl':
      head = '🛑 *STOP LOSS HIT*';
      body = `Closed at \`${fmt(setup.stop)}\`. Risk managed per plan — next setup.`;
      break;
    case 'expired':
      head = '⏳ *SETUP EXPIRED*';
      body = `No TP1/SL hit within the window. Close any remainder manually.`;
      break;
    default:
      return;
  }
  const text = [
    head,
    `${dir}  ·  ${setup.strategy || ''}`,
    '',
    body,
    currentPrice != null ? `📍 Now: \`${fmt(currentPrice)}\`` : '',
  ].filter(Boolean).join('\n');
  return postRaw(text);
}

// ─── Startup banner ──────────────────────────────────────────────────────

export async function sendStartup() {
  const cfg = getRuntimeConfig() || {};
  let total = 0, enabled = 0;
  try {
    for (const s of await loadRegistry()) {
      total++;
      if (cfg.strategies?.[s.id] === true) enabled++;
    }
  } catch {}
  const muteSec = cfg.mute?.untilMs && cfg.mute.untilMs > Date.now()
    ? Math.round((cfg.mute.untilMs - Date.now()) / 1000) : 0;
  // No closed box — emoji render wider than the border glyphs in Telegram's
  // font, so a boxed title never lines up. Heavy rules + a centred title read
  // clean because there is no right edge to misalign.
  const text = [
    '━━━━━━━━━━━━━━━━━━━━',
    '🎵   *O C T A V E   O N L I N E*',
    '━━━━━━━━━━━━━━━━━━━━',
    '',
    `📡  *Watching*   MGC1! · MNQ1! · MES1!`,
    `🎚  *Strategies*   ${enabled}/${total} active`,
    `🤖  *Holy AI*   ${cfg.aiEngine?.enabled !== false ? 'on' : 'off'}`,
    `${muteSec > 0 ? '🔕' : '🔔'}  *Alerts*   ${muteSec > 0 ? `muted ${Math.round(muteSec / 60)}m` : 'live'}`,
    '',
    '_Send /menu for the control panel._',
  ].join('\n');
  return postRaw(text);
}

export async function sendDown(reason) {
  return postRaw(`⚠️ *OCTAVE STOPPING*\n${tgEscape(reason || '')}`);
}

// ─── Session-change banner ───────────────────────────────────────────────

export async function sendSessionChange({ fromSession, toSession, nowLabel, hint }) {
  const text = [
    '🌍 *SESSION CHANGE*',
    `${(toSession || '').toUpperCase()}${fromSession ? ` _(was ${String(fromSession).toUpperCase()})_` : ''}`,
    nowLabel ? `⏰ ${tgEscape(nowLabel)}` : '',
    hint ? `ℹ️ ${tgEscape(hint)}` : '',
  ].filter(Boolean).join('\n');
  return postRaw(text);
}
