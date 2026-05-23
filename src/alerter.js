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

  const lines = [];
  lines.push('╭───────────────────────╮');
  lines.push('│   ⚡ *OCTAVE SIGNAL* ⚡   │');
  lines.push('╰───────────────────────╯');
  lines.push('');
  lines.push(`${dirIcon} *${r.direction}*   ·   *${inst.label.toUpperCase()}*`);
  lines.push(`\`${inst.symbol}\``);
  lines.push('');
  // Limit vs market: a LONG fills on a dip to entry, a SHORT on a rally to
  // entry. If the current price is already at/through the entry it's a market
  // fill; otherwise it's a resting limit and you wait for the FILLED alert.
  const last = ctx.lastClose;
  let entryMode = '';
  if (last != null) {
    const fillsNow = r.direction === 'LONG' ? last <= ep.entry : last >= ep.entry;
    entryMode = fillsNow
      ? '  🟢 Market — fillable now'
      : '  ⏳ Limit — wait for price to reach the zone';
  }
  lines.push('┌ *Entry Zone* ──────────');
  lines.push(`  \`${fmtPrice(zLo)}\` — \`${fmtPrice(zHi)}\``);
  if (entryMode) lines.push(entryMode);
  lines.push('');
  lines.push('├ *Take Profit* ─────────');
  if (ep.t1 != null) lines.push(`  🎯 TP1  →  \`${fmtPrice(ep.t1)}\``);
  if (ep.t2 != null) lines.push(`  🎯 TP2  →  \`${fmtPrice(ep.t2)}\``);
  lines.push('');
  lines.push('├ *Stop Loss* ───────────');
  lines.push(`  ❌  \`${fmtPrice(ep.stop)}\``);
  lines.push('');
  // Position size — contracts to risk the configured $/trade given this
  // setup's stop distance. The widened risk is in price points; convert to
  // dollars with the micro-future point value.
  const DOLLAR_PER_POINT = { gold: 10, nasdaq: 2, sp: 5 };
  const dpp = DOLLAR_PER_POINT[r.instrument] || 1;
  const perContract = risk * dpp;
  const riskBudget = Number(cfg.riskPerTradeUsd) > 0 ? Number(cfg.riskPerTradeUsd) : 250;
  if (perContract > 0) {
    const contracts = Math.floor(riskBudget / perContract);
    lines.push('├ *Position Size* ───────');
    if (contracts >= 1) {
      lines.push(`  📐  *${contracts}* contract${contracts > 1 ? 's' : ''}  ·  risks ~$${Math.round(contracts * perContract)}`);
    } else {
      lines.push(`  📐  *1* contract  ·  risks ~$${Math.round(perContract)}  _(stop wide — over your $${riskBudget})_`);
    }
    lines.push('');
  }
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

  // Paper-trader block — show per-account decision. Only added when paper
  // trader has made decisions for this signal (i.e. at least one account is
  // enabled). Quietly absent otherwise.
  if (Array.isArray(r.paperDecisions) && r.paperDecisions.length) {
    lines.push('');
    lines.push('🏦 *Eval account status*');
    for (const d of r.paperDecisions) {
      const id = d.accountId.toUpperCase();
      if (d.gateAllowed) {
        lines.push(`  ${d.contracts >= 1 ? '✅' : '⚠️'} *${id}* — ${d.contracts}c · ~$${Math.round(d.riskUsdActual)} risk`);
      } else {
        const icon = d.gateSeverity === 'hard' ? '🛑' : '⚠️';
        lines.push(`  ${icon} *${id}* — blocked: ${tgEscape(d.gateReason || 'gate')}`);
      }
    }
    // Copy-paste block for the Octave Levels PineScript indicator on TV.
    // Tap the code block in Telegram → it copies to clipboard; paste 4
    // numbers into the indicator's Settings panel to draw lines on chart.
    lines.push('');
    lines.push('📊 *TV indicator levels*');
    lines.push('```');
    lines.push(`OCTAVE  ${r.direction}  ${ep.entry} / ${ep.stop} / ${ep.t1} / ${ep.t2}`);
    lines.push('```');
  }
  return lines.join('\n');
}

/**
 * Build the Telegram inline_keyboard for a signal. One row of [Execute Auto]
 * [Execute User] [Skip] when at least one account is enabled with a passing
 * gate. callback_data format: `pt:exec:auto:<setupId>`, `pt:exec:user:<...>`,
 * `pt:skip:<setupId>`. The handler is in webui/bot.js.
 */
function buildSignalKeyboard(r) {
  if (!Array.isArray(r.paperDecisions) || !r.paperDecisions.length) return null;
  const row = [];
  for (const d of r.paperDecisions) {
    if (!d.gateAllowed || d.contracts <= 0) continue;
    row.push({
      text: `✅ ${d.accountId === 'auto' ? 'Auto' : 'User'} live`,
      callback_data: `pt:exec:${d.accountId}:${r.setupId}`,
    });
  }
  if (!row.length) return null;
  row.push({ text: '⏭ Skip', callback_data: `pt:skip:${r.setupId}` });
  return [row];
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

  // Two-chat routing:
  //   GROUP   (config.telegramChatId)       — signal card only, NO paper-
  //                                            trader metadata, NO buttons.
  //                                            Friends in this chat see clean
  //                                            signals to execute themselves.
  //   OWNER   (config.telegramOwnerChatId)  — full card WITH paper-trader
  //                                            metadata AND inline buttons
  //                                            (Execute/Skip). Only the owner
  //                                            uses these.
  // If owner chat id == group chat id, we send only ONCE (single combined
  // card with metadata + buttons — backward compat for single-chat setups).
  const ownerChat = config.telegramOwnerChatId;
  const groupChat = config.telegramChatId;
  const sameChat = String(ownerChat) === String(groupChat);

  // Build the BASE card without paper-trader meta (for group).
  // r.paperDecisions is temporarily stripped during build, then restored.
  const decisions = r.paperDecisions;
  r.paperDecisions = null;
  const groupCard = await buildSignalCard(r, ctx);
  r.paperDecisions = decisions;
  // Owner card includes the meta + keyboard.
  const ownerCard = sameChat ? groupCard : await buildSignalCard(r, ctx);
  let ownerKeyboard = null;
  try { ownerKeyboard = buildSignalKeyboard(r); }
  catch (err) { log.warn('buildSignalKeyboard threw', { err: err.message }); }

  const cfg = getRuntimeConfig();
  const wantPhoto = cfg?.alertChartImages !== false;
  let photoUrl = null;
  if (wantPhoto) {
    try { photoUrl = await buildAlertChartUrl(r); }
    catch (err) { log.warn('chart image build threw', { err: err.message }); }
  }

  // Send to group first. No metadata/keyboard. Never blocks owner send.
  let groupOk = true;
  if (sameChat) {
    // Single-chat mode: ONE message with full card + keyboard.
    if (photoUrl) {
      groupOk = await postPhoto(photoUrl, ownerCard, ownerKeyboard, groupChat);
      if (!groupOk) groupOk = await postRaw(ownerCard, ownerKeyboard, groupChat);
    } else {
      groupOk = await postRaw(ownerCard, ownerKeyboard, groupChat);
    }
    return groupOk;
  }

  if (photoUrl) {
    groupOk = await postPhoto(photoUrl, groupCard, null, groupChat);
    if (!groupOk) groupOk = await postRaw(groupCard, null, groupChat);
  } else {
    groupOk = await postRaw(groupCard, null, groupChat);
  }

  // Send to owner DM (best-effort — never causes the group send to be marked failed).
  try {
    if (photoUrl) {
      const ok = await postPhoto(photoUrl, ownerCard, ownerKeyboard, ownerChat);
      if (!ok) await postRaw(ownerCard, ownerKeyboard, ownerChat);
    } else {
      await postRaw(ownerCard, ownerKeyboard, ownerChat);
    }
  } catch (err) {
    log.warn('owner-chat send threw', { err: err.message });
  }
  return groupOk;
}

// ─── Follow-up milestone alerts ──────────────────────────────────────────

export async function sendFollowUp({ setup, milestone, currentPrice }) {
  const fmt = (v) => fmtPrice(v);
  const dir = setup.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
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
    `📡  *Watching*   MGC1! · MNQ1! · MES1!`,
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

/** End-of-day report — pre-formatted text from lib/daily_report.js. Owner only. */
export async function sendDailyReport(text) {
  return postRaw(text, null, config.telegramOwnerChatId);
}

// ─── Session-change banner ───────────────────────────────────────────────

export async function sendSessionChange({ fromSession, toSession, nowLabel, hint }) {
  const fmtSess = (s) => String(s || '').toUpperCase().replace(/_/g, ' ');
  const text = [
    '🌍 *SESSION CHANGE*',
    `${fmtSess(toSession)}${fromSession ? ` _(was ${fmtSess(fromSession)})_` : ''}`,
    nowLabel ? `⏰ ${tgEscape(nowLabel)}` : '',
    hint ? `ℹ️ ${tgEscape(hint)}` : '',
  ].filter(Boolean).join('\n');
  return postRaw(text, null, config.telegramOwnerChatId);
}
