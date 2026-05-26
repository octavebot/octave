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

async function postRaw(text, keyboard = null, chatId = null) {
  const gap = Date.now() - lastSendAt;
  if (gap < MIN_GAP_MS) await new Promise((r) => setTimeout(r, MIN_GAP_MS - gap));
  lastSendAt = Date.now();
  const body = {
    chat_id: chatId || config.telegramChatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return sendViaQueue(config.telegramBotToken, 'sendMessage', body);
}

async function postPhoto(photoUrl, caption, keyboard = null, chatId = null) {
  const gap = Date.now() - lastSendAt;
  if (gap < MIN_GAP_MS) await new Promise((r) => setTimeout(r, MIN_GAP_MS - gap));
  lastSendAt = Date.now();
  const full = caption || '';
  const fits = full.length <= TG_CAPTION_MAX;
  const shortCaption = fits ? full : full.slice(0, TG_CAPTION_MAX - 30) + '…';
  const body = {
    chat_id: chatId || config.telegramChatId,
    photo: photoUrl,
    caption: shortCaption,
    parse_mode: 'Markdown',
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  const ok = await sendViaQueue(config.telegramBotToken, 'sendPhoto', body);
  if (ok && !fits) await postRaw(full, keyboard, chatId);
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
  const cfg = getRuntimeConfig() || {};
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

  const last = ctx.lastClose;
  const fillsNow = last != null && (r.direction === 'LONG' ? last <= ep.entry : last >= ep.entry);
  const DOLLAR_PER_POINT = { gold: 10, nasdaq: 2 };
  const dpp = DOLLAR_PER_POINT[r.instrument] || 1;
  const perContract = risk * dpp;
  const riskBudget = Number(cfg.riskPerTradeUsd) > 0 ? Number(cfg.riskPerTradeUsd) : 250;
  const contracts = perContract > 0 ? Math.max(1, Math.floor(riskBudget / perContract)) : 0;
  const sizeUsd = contracts * perContract;

  const lines = [];

  // Header — single clean line, no ASCII box (emoji width breaks alignment).
  lines.push(`${dirIcon} *${r.direction} · ${inst.label.toUpperCase()}*  \`${inst.symbol}\``);
  lines.push(`_${tgEscape(name)}_  ·  ${tfLabel(r.timeframe || ctx.timeframe)}  ·  ${fillsNow ? '🟢 fillable now' : '⏳ resting limit'}`);
  lines.push('');

  // Levels — one block, monospace for alignment. Telegram renders ``` perfectly.
  lines.push('```');
  lines.push(`Entry   ${fmtPrice(zLo).padStart(10)} — ${fmtPrice(zHi)}`);
  lines.push(`Stop    ${fmtPrice(ep.stop).padStart(10)}`);
  if (ep.t1 != null) lines.push(`TP1     ${fmtPrice(ep.t1).padStart(10)}`);
  if (ep.t2 != null) lines.push(`TP2     ${fmtPrice(ep.t2).padStart(10)}`);
  lines.push('```');

  // Trade data — one tight row.
  const dataLine = [
    `📐 ${contracts}c (~$${Math.round(sizeUsd)})`,
    `📊 ${confPct}%`,
    rr != null ? `💎 1:${rr.toFixed(1)}` : null,
    `⚠️ ${riskLabel(conf)} risk`,
  ].filter(Boolean).join('  ·  ');
  lines.push(dataLine);

  // Confirmations — bulleted, no nested-tree characters.
  if (confirmations.length) {
    lines.push('');
    for (const c of confirmations.slice(0, 4)) lines.push(`  ✓ ${tgEscape(c)}`);
  }

  if (r.aiCommentary) {
    lines.push('');
    lines.push(`🤖 _${tgEscape(r.aiCommentary)}_`);
  }

  // Paper-trader block — only shown when the account participated.
  // Single-account era: collapse to one line.
  if (Array.isArray(r.paperDecisions) && r.paperDecisions.length) {
    lines.push('');
    const d = r.paperDecisions[0];  // single account
    if (d.gateAllowed) {
      lines.push(`🏦 *Paper trade* — ${d.contracts}c · ~$${Math.round(d.riskUsdActual)} risk`);
    } else {
      const icon = d.gateSeverity === 'hard' ? '🛑' : '⚠️';
      lines.push(`${icon} *Paper blocked* — ${tgEscape(d.gateReason || 'gate')}`);
    }
    // Copy-paste block for the Octave Levels Pine indicator.
    lines.push('');
    lines.push('📊 _TV levels (tap to copy)_');
    lines.push('```');
    lines.push(`${r.direction}  ${ep.entry} / ${ep.stop} / ${ep.t1} / ${ep.t2}`);
    lines.push('```');
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

  // Signal cards go to the GROUP ONLY — paper trader is fully autonomous
  // (every signal auto-opens a paper trade via paper_trader.onTriggered, and
  // the follow-up tracker auto-closes it on TP/SL), so there are no manual
  // Execute / Skip buttons and no need to dual-send to the owner DM. The
  // paper-trader metadata stays in the card so the group can see what the
  // bot decided. Operational banners (startup, daily report, session change)
  // still go to the owner DM via the other send* helpers below.
  const groupChat = config.telegramChatId;
  const card = await buildSignalCard(r, ctx);

  const cfg = getRuntimeConfig();
  const wantPhoto = cfg?.alertChartImages !== false;
  let photoUrl = null;
  if (wantPhoto) {
    try { photoUrl = await buildAlertChartUrl(r); }
    catch (err) { log.warn('chart image build threw', { err: err.message }); }
  }

  let groupOk;
  if (photoUrl) {
    groupOk = await postPhoto(photoUrl, card, null, groupChat);
    if (!groupOk) groupOk = await postRaw(card, null, groupChat);
  } else {
    groupOk = await postRaw(card, null, groupChat);
  }
  return groupOk;
}

// ─── Follow-up milestone alerts ──────────────────────────────────────────

export async function sendFollowUp({ setup, milestone, currentPrice }) {
  const fmt = (v) => fmtPrice(v);
  const dir = setup.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  // Identify WHICH trade this follow-up is about. With gold + nasdaq and
  // several strategies able to run at once, "LONG · LONDON-SWEEP" alone is
  // ambiguous — the instrument + entry price pin it to one specific trade.
  const im = INSTRUMENT_META[setup.instrument] || { label: setup.instrument || '?', symbol: '' };
  const instLabel = String(im.label || setup.instrument || '?').toUpperCase();
  const idLine = [`${dir}`, `${instLabel}${im.symbol ? ` ${im.symbol}` : ''}`, setup.strategy || '']
    .filter(Boolean).join('  ·  ');
  const refLine = setup.entry != null ? `↳ _entry_ \`${fmt(setup.entry)}\`` : '';

  let head, body;
  switch (milestone) {
    case 'filled':
      head = '✅ *LIMIT FILLED — TRADE LIVE*';
      body = `Entered at \`${fmt(setup.entry)}\`.\n🛑 SL \`${fmt(setup.stop)}\`  ·  🎯 TP1 \`${fmt(setup.t1)}\`  ·  🎯 TP2 \`${fmt(setup.t2)}\``;
      break;
    case 'invalidated':
      head = '❌ *SETUP INVALIDATED*';
      body = `Price blew past the entry to the stop without a clean fill. *Cancel the limit* — no trade.`;
      break;
    case 'missed':
      head = '⏭ *SETUP MISSED*';
      body = `Price ran to the first target without pulling back to fill. *Cancel the limit* — don't chase.`;
      break;
    case 'unfilled':
      head = '⌛ *LIMIT EXPIRED — UNFILLED*';
      body = `The limit at \`${fmt(setup.entry)}\` never triggered within the window. *Cancel the order* — no trade.`;
      break;
    case 'be':
      head = '🟡 *MOVE TO BREAKEVEN*';
      body = `+1R reached. Drag SL to entry \`${fmt(setup.entry)}\` — trade is now risk-free.`;
      break;
    case 'tp1':
      head = '🎯 *TP1 HIT — SCALE OUT*';
      body = `Close 50% at \`${fmt(setup.t1)}\`. SL now at breakeven \`${fmt(setup.entry)}\`; runner targets TP2 \`${fmt(setup.t2)}\`.`;
      break;
    case 'tp2':
      head = '🏆 *TP2 HIT — FULL TARGET*';
      body = `Runner reached \`${fmt(setup.t2)}\`. Trade complete.`;
      break;
    case 'runner':
      head = '🚀 *RUNNER HIT*';
      body = `Extended past TP2 to \`${fmt(setup.runner)}\`. Banner trade — close it out.`;
      break;
    case 'sl':
      if (setup.wasBeStop) {
        // Stop had already been moved to breakeven (+1R / TP1 reached), so this
        // is a risk-free exit, not a -1R loss.
        head = '🟡 *STOPPED AT BREAKEVEN*';
        body = `Runner pulled back to entry \`${fmt(setup.entry)}\` — closed flat. No loss; any TP1 partial is banked.`;
      } else {
        head = '🛑 *STOP LOSS HIT*';
        body = `Closed at \`${fmt(setup.stop)}\`. Risk managed per plan — next setup.`;
      }
      break;
    case 'expired':
      head = '⏳ *SETUP EXPIRED*';
      body = `No TP2/SL hit within the window. Close any remainder manually.`;
      break;
    default:
      return;
  }
  const text = [
    head,
    idLine,
    refLine,
    '',
    body,
    currentPrice != null ? `📍 Now: \`${fmt(currentPrice)}\`` : '',
  ].filter(Boolean).join('\n');
  return postRaw(text);
}

// ─── Startup banner ──────────────────────────────────────────────────────
// Operational banners (startup, shutdown, daily-report, session-change) go
// to OWNER DM only — friends in the group chat see signals + follow-ups, not
// system noise. See the chat-routing block at the top of `send()`.

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
  const text = [
    '━━━━━━━━━━━━━━━━━━━━',
    '🎵   *O C T A V E   O N L I N E*',
    '━━━━━━━━━━━━━━━━━━━━',
    '',
    `📡  *Watching*   MGC1! · MNQ1!`,
    `🎚  *Strategies*   ${enabled}/${total} active`,
    `🤖  *Holy AI*   ${cfg.aiEngine?.enabled !== false ? 'on' : 'off'}`,
    `${muteSec > 0 ? '🔕' : '🔔'}  *Alerts*   ${muteSec > 0 ? `muted ${Math.round(muteSec / 60)}m` : 'live'}`,
    '',
    '_Send /menu for the control panel._',
  ].join('\n');
  return postRaw(text, null, config.telegramOwnerChatId);
}

export async function sendDown(reason) {
  return postRaw(`⚠️ *OCTAVE STOPPING*\n${tgEscape(reason || '')}`, null, config.telegramOwnerChatId);
}

/** Operational alert to the OWNER DM (state corruption, silent-state warnings). */
export async function sendOpsAlert(text) {
  return postRaw(text, null, config.telegramOwnerChatId);
}

/** End-of-day report — pre-formatted text from lib/daily_report.js. Owner only. */
export async function sendDailyReport(text) {
  return postRaw(text, null, config.telegramOwnerChatId);
}

// ─── Session-change banner ───────────────────────────────────────────────

export async function sendSessionChange({ toSession, nowLabel }) {
  const fmtSess = (s) => String(s || '').toUpperCase().replace(/_/g, ' ');
  const text = [
    '🌍 *SESSION CHANGE*',
    fmtSess(toSession),
    nowLabel ? `⏰ ${tgEscape(nowLabel)}` : '',
  ].filter(Boolean).join('\n');
  // Group sees it too. Single post when group + owner resolve to the same chat.
  const groupChat = config.telegramChatId;
  const ownerChat = config.telegramOwnerChatId;
  const groupOk = await postRaw(text, null, groupChat);
  if (String(groupChat) !== String(ownerChat)) {
    try { await postRaw(text, null, ownerChat); }
    catch (err) { log.warn('owner session-change send threw', { err: err.message }); }
  }
  return groupOk;
}
