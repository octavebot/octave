import { config } from './config.js';
import { log } from './logger.js';
import { buildAlertChartUrl } from './lib/chart_image.js';
import { get as getRuntimeConfig } from './lib/runtime_config.js';
import { send as sendViaQueue, startDrain } from './lib/telegram_queue.js';
import { register as registerFollowUp } from './lib/follow_up.js';
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
  // ChatGPT pack
  'CGT-EMA': '#C1',
  'CGT-HTFSD': '#C2',
  'CGT-LONDON': '#C3',
  'CGT-NYREV': '#C4',
  'CGT-VWAP': '#C5',
  // Gemini pack
  'GEM-ASIA': '#G1',
  'GEM-EMA': '#G2',
  'GEM-FIB': '#G3',
  'GEM-SMC': '#G4',
  'GEM-VWAP': '#G5',
};

// Pretty name used in the alert header — what the user actually wants to see.
const STRATEGY_DISPLAY = {
  USLS: 'USLS · Session Sweep',
  'ICT-SMC': 'ICT/SMC · HTF Judas',
  'ALGO-SMC': 'Algo SMC · 71% Fib',
  ADAPTIVE: 'Adaptive Matrix',
  ICT: 'ICT Killzone',
  SMT: 'Gold/Silver SMT',
  TRINITY: 'Trinity Model',
  AMN: 'AMN Dual-Model',
  TORI: 'TORI · 4H Trendline',
  WARRIOR: 'Warrior Momentum',
  'CGT-EMA': 'EMA Trend Continuation',
  'CGT-HTFSD': 'HTF Supply & Demand Sniper',
  'CGT-LONDON': 'London Breakout Momentum',
  'CGT-NYREV': 'NY Reversal Trap',
  'CGT-VWAP': 'VWAP Mean Reversion',
  'GEM-ASIA': 'Asian Range Breakout',
  'GEM-EMA': 'Golden River EMA',
  'GEM-FIB': 'Golden Fibonacci Pullback',
  'GEM-SMC': 'Institutional Order Blocks',
  'GEM-VWAP': 'VWAP Rubber Band',
};

function strategyNum(name) {
  return STRATEGY_NUM[name] || `(${name})`;
}

function strategyDisplay(name) {
  return STRATEGY_DISPLAY[name] || name;
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

// Strategy nicknames keyed by config field name. Source of truth for the
// startup banner; mirrors STRATEGY_DISPLAY but trimmed for compactness.
const STRATEGY_INFO = [
  { key: 'USLS',       short: 'USLS' },
  { key: 'ICT-SMC',    short: 'ICT/SMC' },
  { key: 'ALGO-SMC',   short: 'ALGO/SMC' },
  { key: 'ADAPTIVE',   short: 'Adaptive' },
  { key: 'ICT',        short: 'ICT' },
  { key: 'SMT',        short: 'SMT' },
  { key: 'TRINITY',    short: 'Trinity' },
  { key: 'AMN',        short: 'AMN' },
  { key: 'TORI',       short: 'TORI' },
  { key: 'WARRIOR',    short: 'Warrior' },
  { key: 'CGT-EMA',    short: 'CGT·EMA' },
  { key: 'CGT-HTFSD',  short: 'CGT·HTF' },
  { key: 'CGT-LONDON', short: 'CGT·London' },
  { key: 'CGT-NYREV',  short: 'CGT·NYRev' },
  { key: 'CGT-VWAP',   short: 'CGT·VWAP' },
  { key: 'GEM-ASIA',   short: 'GEM·Asia' },
  { key: 'GEM-EMA',    short: 'GEM·EMA' },
  { key: 'GEM-FIB',    short: 'GEM·Fib' },
  { key: 'GEM-SMC',    short: 'GEM·SMC' },
  { key: 'GEM-VWAP',   short: 'GEM·VWAP' },
];

export async function sendStartup({ symbol, timeframe }) {
  const sym = symbol || '(no chart)';
  const tf = timeframe || '?';

  // Read live runtime-config — actually reflects what the user has enabled
  // RIGHT NOW, not what was the case at code-write time.
  const cfg = getRuntimeConfig() || {};
  const enabledStrategies = STRATEGY_INFO.filter((s) => cfg.strategies?.[s.key] === true);
  const disabledStrategies = STRATEGY_INFO.filter((s) => cfg.strategies?.[s.key] !== true);

  const activeLine = enabledStrategies.length === 0
    ? '_(none enabled)_'
    : enabledStrategies.map((s) => `${strategyNum(s.key)} ${s.short}`).join(' · ');
  const inactiveLine = disabledStrategies.length === 0
    ? '_(all enabled)_'
    : disabledStrategies.map((s) => strategyNum(s.key)).join(' ');

  const muteSec = cfg.mute?.untilMs && cfg.mute.untilMs > Date.now()
    ? Math.round((cfg.mute.untilMs - Date.now()) / 1000) : 0;
  const muteLine = muteSec > 0 ? `🔕 Muted ${Math.round(muteSec / 60)}m` : null;
  const bypassLine = cfg.bypassKillzones ? '🌐 24/7 mode ON' : null;

  const text = [
    BAR,
    `✅ *OCTAVE ONLINE*  ·  MGC1!`,
    `📊 Active (${enabledStrategies.length}/${STRATEGY_INFO.length}): ${activeLine}`,
    `⚫ Inactive: ${inactiveLine}`,
    muteLine,
    bypassLine,
    BAR,
    ``,
    `🔌 Watching: \`${tgEscape(sym)}\` · \`${tgEscape(tf)}m\``,
    `🟢 Service started · monitoring live`,
    ``,
    BAR,
  ].filter(Boolean).join('\n');
  return postRaw(text);
}

export async function sendDown(reason) {
  return postRaw(`${BAR}\n⚠️ *OCTAVE STOPPING*\n${tgEscape(reason)}\n${BAR}`);
}

/**
 * Follow-up milestone message — fired by loop.js when the follow-up tracker
 * detects price reaching BE / TP1 / TP2 / Runner / SL / expiry on an active
 * setup. Short and focused: tells the user what just happened and what to do.
 */
export async function sendFollowUp({ setup, milestone, currentPrice }) {
  const num = strategyNum(setup.strategy);
  const display = strategyDisplay(setup.strategy);
  const dirWord = setup.direction === 'LONG' ? 'LONG' : 'SHORT';
  const fmt = (v) => (v != null && Number.isFinite(+v)) ? Number(v).toFixed(2) : '—';

  let head, body, action;
  switch (milestone) {
    case 'be':
      head = '🟡 *MOVE TO BREAKEVEN*';
      body = `+1R reached on ${dirWord} setup. Drag SL to entry now — trade is risk-free from here.`;
      action = `New SL: \`$${fmt(setup.entry)}\``;
      break;
    case 'tp1':
      head = '🎯 *TP1 HIT — TAKE PARTIAL*';
      body = `Close 50%, leave runner to TP2. SL should already be at BE (or trail it tighter).`;
      action = `TP1 was \`$${fmt(setup.t1)}\``;
      break;
    case 'tp2':
      head = '🏆 *TP2 HIT — FULL TARGET*';
      body = `Trade completed at full target.${setup.runner != null && setup.runner !== setup.t2 ? ' Optional: trail remainder to runner.' : ''}`;
      action = `TP2 was \`$${fmt(setup.t2)}\``;
      break;
    case 'runner':
      head = '🚀 *RUNNER HIT*';
      body = `Trade extended past TP2 to the runner target. Close it out — banner trade.`;
      action = `Runner was \`$${fmt(setup.runner)}\``;
      break;
    case 'sl':
      head = '🛑 *STOP LOSS HIT*';
      body = `Setup invalidated, trade closed. Risk was managed per plan.`;
      action = `SL was \`$${fmt(setup.stop)}\``;
      break;
    case 'expired':
      head = '⏳ *SETUP EXPIRED*';
      body = `24h elapsed without TP1 or SL hit. Close any remaining position manually.`;
      action = '';
      break;
    default:
      return;
  }

  const text = [
    BAR,
    head,
    `${display}  ·  ${num}  ·  ${dirWord}`,
    BAR,
    '',
    body,
    action,
    '',
    currentPrice != null ? `📍 Now: *$${fmt(currentPrice)}*` : '',
    BAR,
  ].filter(Boolean).join('\n');
  return postRaw(text);
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
  if (r.status !== 'triggered' || !r.entryPlan) {
    const g = STATUS_GLYPH[r.status] || { head: '🔔', verb: r.status };
    return postRaw([
      BAR,
      `${g.head} *${g.verb.toUpperCase()}*`,
      tgEscape(r.setupName || ''),
      BAR,
    ].join('\n'));
  }

  const ep = r.entryPlan;
  const num = strategyNum(r.strategy);
  const display = strategyDisplay(r.strategy);
  const dirEmoji = r.direction === 'LONG' ? '🟢' : '🔴';
  const dirWord = r.direction === 'LONG' ? 'LONG' : 'SHORT';
  const conf = Math.round((r.confidence || 0) * 100);
  const risk = ep.risk ?? Math.abs(ep.entry - ep.stop);
  const intent = entryIntent(r.direction, ep.entry, ctx.lastClose, risk);
  const fmt = (v) => (v != null && Number.isFinite(+v)) ? Number(v).toFixed(2) : '—';
  const t1r = ep.t1 != null ? Math.abs(ep.t1 - ep.entry) / risk : null;
  const t2r = ep.t2 != null ? Math.abs(ep.t2 - ep.entry) / risk : null;
  const bePrice = r.direction === 'LONG' ? ep.entry + risk : ep.entry - risk;

  // Register for follow-up so future ticks ping BE/TP1/TP2/SL milestones.
  try { registerFollowUp(r); }
  catch (err) { log.warn('registerFollowUp threw', { err: err.message }); }

  // === Visual format per user directive 2026-05-21 ===
  // Strategy name leads (big, bold). Number badge as subtitle. One clean
  // price block; trade-management block clearly separated. No mode/local cruft.
  const lines = [];
  lines.push(BAR);
  lines.push(`${dirEmoji} *${tgEscape(display.toUpperCase())}*`);
  lines.push(`   _Strategy ${num}_   ·   ${dirWord}   ·   MGC1!`);
  if (intent) lines.push(`*${intent.label}*`);
  lines.push(BAR);
  lines.push('');

  // Price block (monospace, copy-friendly)
  lines.push('```');
  lines.push(`Entry   $${fmt(ep.entry)}`);
  lines.push(`Stop    $${fmt(ep.stop)}    risk -$${fmt(risk)}`);
  if (ep.t1 != null) lines.push(`TP1     $${fmt(ep.t1)}    +${t1r != null ? t1r.toFixed(1) : '?'}R`);
  if (ep.t2 != null) lines.push(`TP2     $${fmt(ep.t2)}    +${t2r != null ? t2r.toFixed(1) : '?'}R`);
  if (ep.runner != null && ep.runner !== ep.t2) {
    const rr = Math.abs(ep.runner - ep.entry) / risk;
    lines.push(`Runner  $${fmt(ep.runner)}    +${rr.toFixed(1)}R`);
  }
  lines.push('```');
  lines.push('');

  // Current price context
  if (ctx.lastClose != null && ep.entry != null) {
    const diff = ctx.lastClose - ep.entry;
    const sign = diff >= 0 ? '+' : '';
    lines.push(`📍 Now: *$${fmt(ctx.lastClose)}*  _(${sign}${diff.toFixed(2)} from entry)_`);
  } else if (ctx.lastClose != null) {
    lines.push(`📍 Now: *$${fmt(ctx.lastClose)}*`);
  }
  if (intent?.hint) lines.push(`_${tgEscape(intent.hint)}_`);
  lines.push('');

  // Trade management — the "what to do next" line
  lines.push('🛡 *Risk plan*');
  lines.push(`  • At +1R \`$${fmt(bePrice)}\` → move SL to breakeven`);
  if (ep.t1 != null) lines.push(`  • At TP1 \`$${fmt(ep.t1)}\` → close 50%`);
  if (ep.t2 != null && ep.t2 !== ep.t1) lines.push(`  • At TP2 \`$${fmt(ep.t2)}\` → close remainder or trail`);
  lines.push(`  _You'll be auto-pinged when each level prints._`);
  lines.push('');

  lines.push(`⚡ ${conf}% conf   ·   ⏰ ${ctx.timeframe || '?'}m`);
  if (r.summary) lines.push(`ℹ️ ${tgEscape(r.summary)}`);
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
