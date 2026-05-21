/**
 * Telegram bot poller — receives commands from the user and replies with
 * status, history, and control over the alerts system.
 *
 * Architecture:
 *   - Long-poll Telegram getUpdates with timeout=25s (cheap, low overhead).
 *   - Only respond to messages from the configured chat_id (security).
 *   - Commands map to handlers below. Each handler reads local state files
 *     and replies via sendMessage. Config-mutating commands also commit and
 *     push to GitHub (background).
 *
 * Loaded by src/webui/server.js as a side-effect import at startup.
 */

import { readFileSync, existsSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { beat as heartbeat, startHeartbeat, readAllBeats, isStale, STALE_TOLERANCE_MS } from '../lib/heartbeat.js';
import { sessionLabel } from '../lib/trade_log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_DIR = join(__dirname, '..', '..');
const CONFIG_FILE = join(REPO_DIR, 'src', 'state', 'runtime-config.json');
const HEARTBEAT_FILE = join(REPO_DIR, 'src', 'state', 'cloud-heartbeat.json');
const DRAWINGS_FILE = join(REPO_DIR, 'src', 'state', 'drawings.json');
const SESSION_FILE = join(REPO_DIR, 'src', 'state', 'session.json');
// Resolve the signal-engine log: Mac uses ~/Library/Logs/trading-alerts/stdout.log,
// VPS uses /home/octave/.octave-logs/signal-engine.log. First-existing wins.
import { existsSync as _existsSync } from 'node:fs';
const STDOUT_LOG_CANDIDATES = [
  '/Users/jqvier/Library/Logs/trading-alerts/stdout.log',
  '/home/octave/.octave-logs/signal-engine.log',
  process.env.HOME + '/.octave-logs/signal-engine.log',
];
const STDOUT_LOG = STDOUT_LOG_CANDIDATES.find((p) => p && _existsSync(p)) || STDOUT_LOG_CANDIDATES[0];
const TRADE_LOG = join(REPO_DIR, 'src', 'state', 'trades.jsonl');
// Multiple candidate locations — first found wins. Mac uses ~/.config,
// VPS uses /home/octave/.config. Also we honor env vars set by systemd's
// EnvironmentFile, which is the primary delivery mechanism on Linux.
const ENV_FILE_CANDIDATES = [
  process.env.OCTAVE_ENV_FILE,
  '/Users/jqvier/.config/trading-alerts/.env',
  '/home/octave/.config/trading-alerts/.env',
  process.env.HOME ? `${process.env.HOME}/.config/trading-alerts/.env` : null,
].filter(Boolean);

const STRATEGY_KEYS = [
  'USLS', 'ICT-SMC', 'ALGO-SMC', 'ADAPTIVE', 'ICT', 'SMT', 'TRINITY', 'AMN', 'TORI', 'WARRIOR',
  // ChatGPT Strategies folder
  'CGT-EMA', 'CGT-HTFSD', 'CGT-LONDON', 'CGT-NYREV', 'CGT-VWAP',
  // Gemini Strategies folder
  'GEM-ASIA', 'GEM-EMA', 'GEM-FIB', 'GEM-SMC', 'GEM-VWAP',
];
const STRATEGY_NUM = {
  USLS: '1', 'ICT-SMC': '2', 'ALGO-SMC': '3', ADAPTIVE: '4',
  ICT: '5', SMT: '6', TRINITY: '7', AMN: '8', TORI: '9', WARRIOR: '10',
  'CGT-EMA': 'C1', 'CGT-HTFSD': 'C2', 'CGT-LONDON': 'C3', 'CGT-NYREV': 'C4', 'CGT-VWAP': 'C5',
  'GEM-ASIA': 'G1', 'GEM-EMA': 'G2', 'GEM-FIB': 'G3', 'GEM-SMC': 'G4', 'GEM-VWAP': 'G5',
};
// Group strategies by folder for /strategies output
const STRATEGY_GROUPS = [
  { name: 'Core (10)', keys: ['USLS', 'ICT-SMC', 'ALGO-SMC', 'ADAPTIVE', 'ICT', 'SMT', 'TRINITY', 'AMN', 'TORI', 'WARRIOR'] },
  { name: 'Chatgpt Strategies', keys: ['CGT-EMA', 'CGT-HTFSD', 'CGT-LONDON', 'CGT-NYREV', 'CGT-VWAP'] },
  { name: 'Gemini Strategies', keys: ['GEM-ASIA', 'GEM-EMA', 'GEM-FIB', 'GEM-SMC', 'GEM-VWAP'] },
];
// /enable and /disable accept both the number form (1..10) and the letter-prefix form (C1, G3)
const NUM_TO_KEY = Object.fromEntries(Object.entries(STRATEGY_NUM).map(([k, v]) => [String(v).toUpperCase(), k]));

let TOKEN = '', CHAT_ID = '';
function loadCreds() {
  // 1. Prefer env vars (systemd EnvironmentFile delivers them this way)
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    return true;
  }
  // 2. Try each candidate .env file
  for (const p of ENV_FILE_CANDIDATES) {
    if (!existsSync(p)) continue;
    try {
      const env = Object.fromEntries(
        readFileSync(p, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => l.split('=', 2))
      );
      const t = env.TELEGRAM_BOT_TOKEN || '';
      const c = env.TELEGRAM_CHAT_ID || '';
      if (t && c) { TOKEN = t; CHAT_ID = c; return true; }
    } catch {}
  }
  return false;
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

function tgEscape(s) {
  // Markdown V1 escape; safer than V2 which requires escaping more chars
  return String(s).replace(/([_*`\[])/g, '\\$1');
}

async function send(text, opts = {}) {
  const body = {
    chat_id: CHAT_ID, text,
    parse_mode: opts.html ? 'HTML' : 'Markdown',
    disable_web_page_preview: true,
  };
  if (opts.keyboard) body.reply_markup = { inline_keyboard: opts.keyboard };
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const bodyT = await res.text().catch(() => '');
    console.error('[bot] sendMessage non-2xx:', res.status, bodyT.slice(0, 200));
  }
  return res.json().catch(() => null);
}

/** Edit an existing message in place (used for tap-to-toggle). */
async function editMessage(chatId, messageId, text, opts = {}) {
  const body = {
    chat_id: chatId, message_id: messageId, text,
    parse_mode: opts.html ? 'HTML' : 'Markdown',
    disable_web_page_preview: true,
  };
  if (opts.keyboard) body.reply_markup = { inline_keyboard: opts.keyboard };
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const bodyT = await res.text().catch(() => '');
    // 400 "message is not modified" is fine when toggling re-renders identical content
    if (!bodyT.includes('not modified')) {
      console.error('[bot] editMessageText non-2xx:', res.status, bodyT.slice(0, 200));
    }
  }
}

/** Acknowledge a button-tap callback. Required by Telegram or buttons keep spinning. */
async function answerCallback(callbackId, text = '') {
  await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: false }),
  }).catch(() => {});
}

// ---------- runtime config helpers ----------

function loadConfig() {
  return readJson(CONFIG_FILE, null);
}

async function saveConfigAndPush(updater) {
  // VPS is authoritative. We just write the file atomically. No git push —
  // that was racing with the webui's POST /api/config writes, causing
  // strategies (notably AMN, TORI, WARRIOR) to flip back to disabled.
  const cur = loadConfig() || {};
  const next = updater(JSON.parse(JSON.stringify(cur)));
  next.lastUpdated = Date.now();
  writeJsonAtomic(CONFIG_FILE, next);
  return next;
}

// ---------- log scanning ----------

function nyDateKey(unixMs) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(unixMs)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function nyHourMinute(unixMs) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return fmt.format(new Date(unixMs));
}

/**
 * Read alert-fired lines from stdout.log within the optional time window.
 * Returns newest first, up to `limit` entries.
 *
 * @param {object} opts {since?: ms, until?: ms, limit?: number}
 */
function readAlerts({ since = 0, until = Infinity, limit = 50 } = {}) {
  if (!existsSync(STDOUT_LOG)) return [];
  const out = [];
  const text = readFileSync(STDOUT_LOG, 'utf8');
  // Iterate from end to grab newest first
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln.includes('"alert fired"')) continue;
    try {
      const e = JSON.parse(ln);
      const t = Date.parse(e.ts);
      if (!Number.isFinite(t)) continue;
      if (t < since || t > until) continue;
      out.push({
        ts: e.ts, time: t, strategy: e.strategy, status: e.status,
        setupId: e.setupId, confidence: e.confidence, telegram: e.telegram,
      });
      if (out.length >= limit) break;
    } catch {}
  }
  return out;
}

function fmtAlert(a) {
  const t = nyHourMinute(a.time);
  const conf = Number.isFinite(+a.confidence) ? `${Math.round(a.confidence * 100)}%` : '—';
  const num = STRATEGY_NUM[a.strategy] || '?';
  return `\`${t}\` · #${num} ${a.strategy} _${a.status}_ · ${conf}`;
}

// ---------- service helpers ----------

async function exec(cmd, args) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => out += d.toString());
    p.stderr.on('data', (d) => err += d.toString());
    p.on('close', (code) => res({ code, out: out.trim(), err: err.trim() }));
  });
}

async function servicePid() {
  const r = await exec('/usr/bin/pgrep', ['-f', 'trading-alerts/src/index.js']);
  return r.code === 0 ? r.out.split('\n')[0] : null;
}

// ---------- COMMAND HANDLERS ----------

const HELP_TEXT = `🎵 *Octave Bot — Commands*

🎛 *Tap-to-use interface*
\`/menu\` — open the Control Panel with buttons
\`/app\` or \`/panel\` — same thing

📊 *Market*
\`/bias\` — current market bias (BUY/SELL) from all strategies
\`/setup <num>\` — what's forming on a strategy + chart
\`/price\` — micro gold (MGC1!) live price
\`/news [hours]\` — upcoming high-impact USD events + blackout state

📊 *Status*
\`/status\` — overall health
\`/health\` — per-service detail
\`/perf\` — VPS hardware + process stats
\`/summary [days]\` — alerts + trades digest (default 1 day)
\`/session\` — current trading session

📜 *History*
\`/today\` — alerts from today (NY time)
\`/yesterday\` — alerts from yesterday
\`/history [N]\` — last N alerts (default 10)
\`/range HH:MM-HH:MM\` — alerts in NY time window today
\`/last\` — most recent alert

🎚 *Strategies*
\`/strategies\` — list every strategy with on/off state (grouped by folder)
\`/enable <num>\` — turn on (e.g. \`/enable 5\` or \`/enable C3\`)
\`/disable <num>\` — turn off

👤 *My Strategies* (user-defined)
\`/mystrategies\` — list your custom strategies
\`/addstrategy <id> "<name>" <entry> [tf]\` — create
\`/editstrategy <id> key=value …\` — edit any field
\`/delstrategy <id>\` — delete

⚙️ *Settings*
\`/24h on|off\` — bypass killzone gating (alerts any hour)
\`/mute <minutes>\` — pause alerts (max 1440)
\`/unmute\` — resume alerts

📈 *Backtest*
\`/backtest\` — 30-day backtest of enabled strategies
\`/backtest <num>\` — single strategy
\`/backtest <num> <days>\` — custom window
Auto-runs Sunday 8pm NY.

🚨 *System*
\`/restart all\` — restart everything
\`/restart bot\` / \`/restart signals\` / \`/restart webui\` — single
\`/version\` — current git commit
\`/shutdown confirm\` — stop everything

Tip: send \`/help\` anytime.`;

async function cmdHelp() {
  await send(HELP_TEXT);
}

// Human-readable nicknames for /status. Source of truth for the names the
// user sees; the strategy KEY (USLS, ICT, etc.) is the internal id.
const STRATEGY_NICKNAME = {
  USLS: 'USLS',
  'ICT-SMC': 'ICT/SMC',
  'ALGO-SMC': 'Algo SMC',
  ADAPTIVE: 'Adaptive Matrix',
  ICT: 'ICT Killzone',
  SMT: 'Gold/Silver SMT',
  TRINITY: 'Trinity Model',
  AMN: 'AMN Dual-Model',
  TORI: 'TORI 4H Trendline',
  WARRIOR: 'Warrior Momentum',
  // ChatGPT pack
  'CGT-EMA': 'CGT · EMA Trend',
  'CGT-HTFSD': 'CGT · HTF S/D Sniper',
  'CGT-LONDON': 'CGT · London Breakout',
  'CGT-NYREV': 'CGT · NY Reversal Trap',
  'CGT-VWAP': 'CGT · VWAP Reversion',
  // Gemini pack
  'GEM-ASIA': 'GEM · Asian Range Breakout',
  'GEM-EMA': 'GEM · Golden River EMA',
  'GEM-FIB': 'GEM · Golden Fibonacci',
  'GEM-SMC': 'GEM · Institutional Order Blocks',
  'GEM-VWAP': 'GEM · VWAP Rubber Band',
};

async function cmdStatus() {
  const cfg = loadConfig();
  const drawings = readJson(DRAWINGS_FILE, { setups: {} });
  const session = readJson(SESSION_FILE, { lastSession: null });
  const pid = await servicePid();

  const enabled = cfg?.strategies
    ? Object.entries(cfg.strategies).filter(([, v]) => v).map(([k]) => k)
    : [];
  const muteMin = cfg?.mute?.untilMs && cfg.mute.untilMs > Date.now()
    ? Math.round((cfg.mute.untilMs - Date.now()) / 60000) : 0;

  // News awareness — lifted into status so the user always knows if a
  // blackout is in effect.
  let newsLine = '';
  try {
    const { checkBlackout, nextEvent } = await import('../lib/news.js');
    const bo = checkBlackout(Date.now() / 1000, 30);
    if (bo.blocked && bo.event) {
      newsLine = `📰 *NEWS BLACKOUT* — ${tgEscape(bo.event.title || bo.event.name || 'high-impact event')} (${bo.minutesAway}m away)`;
    } else if (typeof nextEvent === 'function') {
      const nxt = nextEvent(Date.now() / 1000);
      if (nxt) newsLine = `📰 Next high-impact: ${tgEscape(nxt.title || nxt.name || '')} in ${nxt.minutesAway}m`;
    }
  } catch {}

  const alerting = !muteMin && pid;
  const headline = alerting
    ? '🟢 *Octave is live and watching*'
    : muteMin > 0
      ? `🔕 *Muted for ${muteMin}m*`
      : '🔴 *Octave is offline*';

  const sessLabel = (session.lastSession || 'closed').toUpperCase();
  // Open positions = follow_up tracker (matches dashboard's "Active Setups" tile)
  let setupCount = 0;
  try {
    const fu = await import('../lib/follow_up.js');
    setupCount = fu.active().length;
  } catch {}

  const stratLines = enabled.length === 0
    ? ['_(no strategies enabled)_']
    : enabled.map((k) => `  • ${tgEscape(STRATEGY_NICKNAME[k] || k)}`);

  await send([
    headline,
    '',
    `🕒 Session: *${sessLabel}*  ·  📡 Setups tracked: *${setupCount}*`,
    newsLine,
    '',
    `🎚 *Active strategies (${enabled.length})*`,
    ...stratLines,
    '',
    `Send /bias for direction · /news for upcoming events · /health for service detail`,
  ].filter((l) => l !== '').join('\n'));
}

async function cmdSession() {
  const session = readJson(SESSION_FILE, { lastSession: null });
  const hb = readJson(HEARTBEAT_FILE, null);
  const nyTime = nyHourMinute(Date.now());
  const s = (session.lastSession || 'closed').toUpperCase();
  const isOpen = s !== 'CLOSED' && s !== '—';
  await send([
    `${isOpen ? '🟢' : '⚫'} *${s}* session`,
    `NY time: ${nyTime}`,
    hb?.anchor ? `Gold: $${Number(hb.anchor.close).toFixed(2)}` : '',
  ].filter(Boolean).join('\n'));
}

/** /24h on|off — bypass killzone gating so strategies fire any hour. */
async function cmd24h(arg) {
  const a = (arg || '').trim().toLowerCase();
  if (a !== 'on' && a !== 'off' && a !== '') {
    await send('Usage: `/24h on` or `/24h off`');
    return;
  }
  if (a === '') {
    const cfg = loadConfig();
    const on = !!cfg?.bypassKillzones;
    await send(`24/7 mode: *${on ? 'ON' : 'OFF'}*\n\nSend \`/24h on\` to let strategies fire any hour (skips London/NY killzones).\nSend \`/24h off\` to require killzones (default — higher quality signals).`);
    return;
  }
  const on = a === 'on';
  await saveConfigAndPush((c) => { c.bypassKillzones = on; return c; });
  if (on) {
    await send('🌐 *24/7 mode ON*\n\nStrategies will fire any hour, killzone or not. Expect more alerts, lower average quality. Signal frequency goes up ~3-5x.\n\nTurn back off anytime with `/24h off`.');
  } else {
    await send('🎯 *24/7 mode OFF*\n\nStrategies only fire during London (02:00-05:00) and NY (07:00-10:00) killzones, plus Trinity 09:30-11:00 — default quality mode.');
  }
}

async function cmdPrice() {
  // Strategies are now anchored to MGC1! (Micro Gold) per user directive
  // 2026-05-21. MGC tracks the standard GC contract tick-for-tick, so the
  // price you see here is identical to what your TradingView MGC chart shows.
  let mgc = null;
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/MGC%3DF?interval=1m&range=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json().catch(() => null);
    const meta = data?.chart?.result?.[0]?.meta;
    if (meta) mgc = { price: meta.regularMarketPrice, change: meta.regularMarketPrice - meta.chartPreviousClose, time: meta.regularMarketTime };
  } catch {}

  if (!mgc) {
    const hb = readJson(HEARTBEAT_FILE, null);
    if (!hb?.anchor) { await send('💰 No price data available.'); return; }
    await send(`💰 *Micro Gold* (cached)\n*$${hb.anchor.close}* · ${hb.anchor.tf}m bar`);
    return;
  }

  const sign = (n) => n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
  await send([
    '💰 *Micro Gold (MGC1!)*',
    '',
    `*$${mgc.price.toFixed(2)}*  _${sign(mgc.change)} today_`,
    '',
    '→ matches TradingView `COMEX:MGC1!`',
  ].join('\n'));
}

async function cmdHistory(arg) {
  const n = Math.min(50, Math.max(1, parseInt(arg, 10) || 10));
  const alerts = readAlerts({ limit: n });
  if (alerts.length === 0) { await send('📜 No alerts in the log yet.'); return; }
  const lines = [`📜 *Last ${alerts.length} alerts*`, ''];
  for (const a of alerts) lines.push(fmtAlert(a));
  await send(lines.join('\n'));
}

async function cmdToday() {
  const now = Date.now();
  const todayKey = nyDateKey(now);
  // Find ms boundary: today midnight in NY
  const all = readAlerts({ limit: 500 });
  const today = all.filter((a) => nyDateKey(a.time) === todayKey);
  if (today.length === 0) { await send(`📅 No alerts today (${todayKey} NY).`); return; }
  const lines = [`📅 *Today's alerts* (${todayKey}, NY time)`, `Total: ${today.length}`, ''];
  for (const a of today.slice(0, 30)) lines.push(fmtAlert(a));
  if (today.length > 30) lines.push(`… ${today.length - 30} more`);
  await send(lines.join('\n'));
}

async function cmdYesterday() {
  const yKey = nyDateKey(Date.now() - 24 * 3600 * 1000);
  const all = readAlerts({ limit: 500 });
  const day = all.filter((a) => nyDateKey(a.time) === yKey);
  if (day.length === 0) { await send(`📅 No alerts yesterday (${yKey} NY).`); return; }
  const lines = [`📅 *Yesterday's alerts* (${yKey}, NY time)`, `Total: ${day.length}`, ''];
  for (const a of day.slice(0, 30)) lines.push(fmtAlert(a));
  if (day.length > 30) lines.push(`… ${day.length - 30} more`);
  await send(lines.join('\n'));
}

async function cmdRange(arg) {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(arg || '');
  if (!m) { await send('Usage: `/range HH:MM-HH:MM` (NY time, e.g. `/range 09:30-11:00`)'); return; }
  const [_, h1, m1, h2, m2] = m;
  const todayKey = nyDateKey(Date.now());
  const all = readAlerts({ limit: 500 });
  const day = all.filter((a) => nyDateKey(a.time) === todayKey);
  const startMin = +h1 * 60 + +m1, endMin = +h2 * 60 + +m2;
  const window = day.filter((a) => {
    const [h, mm] = nyHourMinute(a.time).split(':').map(Number);
    const tm = h * 60 + mm;
    return tm >= startMin && tm < endMin;
  });
  if (window.length === 0) {
    await send(`📅 No alerts in *${h1}:${m1}-${h2}:${m2}* NY today.`);
    return;
  }
  const lines = [`📅 *${h1}:${m1}-${h2}:${m2}* NY today`, `Total: ${window.length}`, ''];
  for (const a of window.slice(0, 30)) lines.push(fmtAlert(a));
  await send(lines.join('\n'));
}

async function cmdLast() {
  const a = readAlerts({ limit: 1 })[0];
  if (!a) { await send('🔔 No alerts yet.'); return; }
  await send([
    '🔔 *Last Alert*',
    `When: \`${nyHourMinute(a.time)}\` NY (${nyDateKey(a.time)})`,
    `Strategy: *#${STRATEGY_NUM[a.strategy]} ${a.strategy}*`,
    `Status: \`${a.status}\``,
    `Confidence: *${Math.round((a.confidence || 0) * 100)}%*`,
    `Setup id: \`${a.setupId}\``,
    `Telegram: ${a.telegram || '?'}`,
  ].join('\n'));
}

async function cmdStrategies() {
  const cfg = loadConfig() || { strategies: {} };
  const lines = ['🎚 *Strategies*', ''];
  for (const group of STRATEGY_GROUPS) {
    lines.push(`📁 *${group.name}*`);
    for (const k of group.keys) {
      const on = !!cfg.strategies[k];
      const icon = on ? '🟢' : '⚫';
      const name = STRATEGY_NICKNAME[k] || k;
      lines.push(`  ${icon} \`#${STRATEGY_NUM[k]}\` ${tgEscape(name)}`);
    }
    lines.push('');
  }
  lines.push('Toggle: `/enable <num>` · `/disable <num>` (e.g. `/enable C3` or `/enable 5`)');
  await send(lines.join('\n'));
}

function resolveStrategy(arg) {
  if (!arg) return null;
  const trimmed = String(arg).trim().toUpperCase().replace(/^#/, '');
  // Try as letter-prefixed (C1/G3) or numeric (1..10) lookup
  if (NUM_TO_KEY[trimmed]) return NUM_TO_KEY[trimmed];
  // Try as full key (USLS / CGT-EMA)
  if (STRATEGY_KEYS.includes(trimmed)) return trimmed;
  return null;
}

async function cmdEnable(arg) {
  const k = resolveStrategy(arg);
  if (!k) { await send(`Usage: \`/enable <num>\` (1-7) or \`/enable <name>\``); return; }
  const next = await saveConfigAndPush((c) => { c.strategies = c.strategies || {}; c.strategies[k] = true; return c; });
  await send(`🟢 *${k}* (\`#${STRATEGY_NUM[k]}\`) → ENABLED`);
}

async function cmdDisable(arg) {
  const k = resolveStrategy(arg);
  if (!k) { await send(`Usage: \`/disable <num>\` (1-7) or \`/disable <name>\``); return; }
  const next = await saveConfigAndPush((c) => { c.strategies = c.strategies || {}; c.strategies[k] = false; return c; });
  await send(`⚫ *${k}* (\`#${STRATEGY_NUM[k]}\`) → disabled`);
}

async function cmdMode(arg) {
  const cfg = loadConfig() || {};
  if (!arg) {
    await send([
      `🎚 Current mode: \`${cfg.mode || 'auto'}\``,
      '',
      'Options: `/mode auto`, `/mode cloud`, `/mode local`',
      '',
      '_auto_: cloud-primary, local-fallback',
      '_cloud_: only cloud sends Telegram',
      '_local_: only local sends Telegram',
    ].join('\n'));
    return;
  }
  const m = String(arg).trim().toLowerCase();
  if (!['auto', 'cloud', 'local'].includes(m)) {
    await send('Mode must be one of: `auto`, `cloud`, `local`'); return;
  }
  await saveConfigAndPush((c) => { c.mode = m; return c; });
  await send(`🎚 Mode → \`${m}\``);
}

async function cmdMute(arg) {
  const minutes = Math.min(1440, Math.max(1, parseInt(arg, 10) || 0));
  if (!minutes) { await send('Usage: `/mute <minutes>` (1-1440)'); return; }
  const untilMs = Date.now() + minutes * 60 * 1000;
  await saveConfigAndPush((c) => { c.mute = { untilMs, reason: 'telegram /mute' }; return c; });
  await send(`🔕 Muted for *${minutes}m*. Will auto-unmute at \`${nyHourMinute(untilMs)} NY\`.`);
}

async function cmdUnmute() {
  await saveConfigAndPush((c) => { c.mute = { untilMs: 0, reason: null }; return c; });
  await send('🔔 Alerts resumed.');
}

async function cmdVersion() {
  const r = await exec('/usr/bin/git', ['-C', REPO_DIR, 'log', '-1', '--format=%h %s']);
  await send(r.code === 0 ? `🔖 \`${r.out}\`` : 'Could not read git log');
}

async function cmdRestart() {
  await send('🔄 Restarting local service…');
  spawn('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.jqvier.trading-alerts`], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(async () => {
    const pid = await servicePid();
    await send(pid ? `✅ Restarted (PID ${pid})` : '⚠️ Restart triggered but new PID not found yet');
  }, 4000);
}

async function cmdBacktest(arg) {
  // Parse optional strategy + days arg
  const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
  let strategyArg = null;
  let days = 30;
  for (const p of parts) {
    const asInt = parseInt(p, 10);
    if (Number.isFinite(asInt) && asInt > 0 && asInt <= 365) {
      days = asInt;
    } else {
      strategyArg = p;
    }
  }
  const strategy = strategyArg ? resolveStrategy(strategyArg) : null;
  if (strategyArg && !strategy) {
    await send(`Unknown strategy: \`${strategyArg}\`\n\nUse \`/strategies\` to see names. Examples: \`/backtest 5\`, \`/backtest TRINITY\`, \`/backtest 60\` (days).`);
    return;
  }

  // CRITICAL CRASH ISOLATION: spawn the backtest as a CHILD process.
  // If the backtest OOMs, throws, or loops infinitely, the bot stays alive.
  // The previous in-process import() approach is what caused the USLS crash:
  // the event loop blocked, the bot couldn't poll Telegram, the webui couldn't
  // serve HTTP — every visible service appeared frozen.
  await send(`⏳ Running ${days}-day backtest${strategy ? ` for *${strategy}*` : ' for all enabled strategies'}…\n_Runs in an isolated process; bot stays responsive even if it fails._`);

  const args = ['scripts/run-backtest-child.js', '--days', String(days)];
  if (strategy) args.push('--strategy', strategy);

  // Use the SAME node that's running this bot (works on Mac /opt/homebrew,
  // VPS /usr/bin, anywhere) and the module-level REPO_DIR (resolved from
  // __dirname so it's correct on both Mac /Users/jqvier/... and VPS /home/octave/...)
  const child = spawn(process.execPath, args, {
    cwd: REPO_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Detached: false so parent can wait, but the child has its own event loop —
    // crucially, an OOM in the child kills the child only.
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  let tgMessage = null;
  let resultRow = null;

  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    // Parse RESULT: and TG: lines as they arrive
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.startsWith('RESULT:')) {
        try { resultRow = JSON.parse(line.slice(7)); } catch {}
      } else if (line.startsWith('TG:')) {
        try { tgMessage = Buffer.from(line.slice(3), 'base64').toString('utf8'); } catch {}
      } else {
        console.log('[backtest-child]', line);
      }
    }
  });
  child.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    console.error('[backtest-child stderr]', d.toString().trim());
  });

  // Hard timeout: kill the child if it runs too long (e.g., 8 minutes)
  const killTimer = setTimeout(() => {
    console.error('[bot] backtest child exceeded 8min — killing');
    try { child.kill('SIGKILL'); } catch {}
  }, 8 * 60 * 1000);

  child.on('exit', async (code, signal) => {
    clearTimeout(killTimer);
    if (signal === 'SIGKILL' && !resultRow) {
      await send(`⚠️ Backtest timed out (>8min) and was killed. The bot itself is fine — try a smaller window or single strategy.`);
      return;
    }
    if (resultRow?.error) {
      await send(`⚠️ Backtest failed: \`${resultRow.error}\``);
      return;
    }
    if (tgMessage) {
      await send(tgMessage);
    } else if (resultRow?.ok) {
      await send(`✅ Backtest completed (${Math.round((resultRow.durationMs || 0) / 1000)}s) but no Telegram summary was produced.`);
    } else {
      await send(`⚠️ Backtest exited with code ${code}${signal ? ` (signal ${signal})` : ''}.\nStderr tail:\n\`\`\`\n${(stderrBuf || '').slice(-500)}\n\`\`\``);
    }
  });

  child.on('error', async (err) => {
    clearTimeout(killTimer);
    await send(`⚠️ Could not spawn backtest process: ${err.message}`);
  });
}

async function cmdDashboard() {
  // Reads the Cloudflare Tunnel URL stashed by scripts/setup-cloudflare-tunnel.sh
  // If running locally without a tunnel, falls back to localhost.
  const TUNNEL_PATHS = [
    '/home/octave/.octave-tunnel-url',
    process.env.HOME + '/.octave-tunnel-url',
  ];
  let url = null;
  for (const p of TUNNEL_PATHS) {
    try {
      if (existsSync(p)) {
        const u = readFileSync(p, 'utf8').trim();
        if (u.startsWith('https://')) { url = u; break; }
      }
    } catch {}
  }
  if (!url) {
    await send([
      '🌐 *Dashboard*',
      '',
      'No public HTTPS URL configured yet.',
      '',
      'For local Mac only: open `http://127.0.0.1:7345/`',
      '',
      'To enable public access:',
      '1. Deploy to a VPS (see `docs/VPS-DEPLOY.md`)',
      '2. Run `sudo bash scripts/setup-cloudflare-tunnel.sh`',
      '3. The URL appears here automatically',
    ].join('\n'));
    return;
  }
  // Plain URL button — opens in the user's default browser. The web_app
  // variant needs BotFather domain whitelist which we don't have set up.
  const keyboard = [
    [{ text: '🎵 Open Dashboard', url }],
  ];
  await send(`🌐 *Octave Dashboard*\n\nTap the button to open in your browser:\n\`${url}\``, { keyboard });
}

/** /summary [days] — activity digest. Default 1 day. */
async function cmdSummary(arg) {
  const days = Math.max(1, Math.min(30, parseInt(arg, 10) || 1));
  const sinceMs = Date.now() - days * 86_400_000;
  const alerts = readAlerts({ since: sinceMs, limit: 1000 });

  // Per-strategy + per-status counts
  const byStrategy = {};
  let triggered = 0, formed = 0, near = 0;
  for (const a of alerts) {
    byStrategy[a.strategy] = byStrategy[a.strategy] || { triggered: 0, near: 0, forming: 0, total: 0 };
    byStrategy[a.strategy].total++;
    if (a.status === 'triggered') { byStrategy[a.strategy].triggered++; triggered++; }
    else if (a.status === 'near_trigger') { byStrategy[a.strategy].near++; near++; }
    else if (a.status === 'forming') { byStrategy[a.strategy].forming++; formed++; }
  }

  // Session breakdown (NY-local hour bucketing)
  const sessions = { Asian: 0, London: 0, 'NY-AM': 0, 'NY-PM': 0 };
  for (const a of alerts) {
    if (a.status !== 'triggered') continue;
    const sess = sessionLabel(Math.floor(a.time / 1000));
    if (sess in sessions) sessions[sess]++;
  }

  // Completed trades from trades.jsonl (in window)
  let trades = [];
  try {
    if (existsSync(TRADE_LOG)) {
      const lines = readFileSync(TRADE_LOG, 'utf8').split('\n').filter(Boolean);
      for (const ln of lines) {
        try {
          const t = JSON.parse(ln);
          const ts = Date.parse(t.opened_at || t.ts || '') || 0;
          if (ts >= sinceMs) trades.push(t);
        } catch {}
      }
    }
  } catch {}

  const wins = trades.filter((t) => t.outcome === 'WIN').length;
  const losses = trades.filter((t) => t.outcome === 'LOSS').length;
  const sumR = trades.reduce((acc, t) => acc + (+t.result_R || 0), 0);

  const lines = [
    `📊 *${days === 1 ? 'Today\'s' : `${days}-day`} Summary*`,
    '',
    `Alerts: *${alerts.length}*  (${triggered} triggered · ${near} near · ${formed} forming)`,
  ];
  if (trades.length > 0) {
    const wr = ((wins / trades.length) * 100).toFixed(0);
    lines.push(`Trades: *${trades.length}*  ·  ${wins}W / ${losses}L  (${wr}% wins)  ·  ${sumR >= 0 ? '+' : ''}${sumR.toFixed(2)}R`);
  }
  lines.push('');

  // Top strategies
  const ranked = Object.entries(byStrategy).sort((a, b) => b[1].total - a[1].total).slice(0, 7);
  if (ranked.length > 0) {
    lines.push('*By strategy*');
    for (const [name, s] of ranked) {
      const num = STRATEGY_NUM[name] || '?';
      lines.push(`  #${num} ${name}: ${s.total} (${s.triggered}🟢/${s.near}🟠/${s.forming}🟡)`);
    }
    lines.push('');
  }

  // Triggered by session
  const sessParts = Object.entries(sessions).filter(([, n]) => n > 0).map(([s, n]) => `${s} ${n}`);
  if (sessParts.length > 0) {
    lines.push('*Triggered by session*');
    lines.push(`  ${sessParts.join(' · ')}`);
    lines.push('');
  }

  if (alerts.length === 0) {
    lines.push('_Quiet window. No alerts in this period._');
  }

  lines.push('Tip: `/summary 7` for the last week, `/summary 30` for the month.');
  await send(lines.join('\n'));
}

/** /perf — VPS hardware + Octave runtime perf snapshot. */
async function cmdPerf() {
  const lines = ['⚡ *Performance*', ''];

  // CPU load average (1/5/15-min). Linux exposes via /proc/loadavg; Mac via uptime.
  const loadR = await exec('/usr/bin/uptime', []);
  const loadMatch = loadR.out.match(/load averages?:\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (loadMatch) {
    lines.push(`CPU load: *${loadMatch[1]}* (1m) · ${loadMatch[2]} (5m) · ${loadMatch[3]} (15m)`);
  }

  // RAM — /proc/meminfo on Linux
  try {
    const { readFileSync } = await import('node:fs');
    const mi = readFileSync('/proc/meminfo', 'utf8');
    const total = +(mi.match(/MemTotal:\s+(\d+)/)?.[1] || 0) * 1024;
    const avail = +(mi.match(/MemAvailable:\s+(\d+)/)?.[1] || 0) * 1024;
    if (total > 0) {
      const usedGB = ((total - avail) / 1024 ** 3).toFixed(1);
      const totalGB = (total / 1024 ** 3).toFixed(1);
      const usedPct = Math.round(((total - avail) / total) * 100);
      lines.push(`RAM: *${usedGB} GB / ${totalGB} GB* (${usedPct}%)`);
    }
  } catch {}

  // Disk — df for the root filesystem
  const dfR = await exec('/bin/df', ['-h', '/']);
  const dfLine = dfR.out.split('\n').filter((l) => l.trim() && !l.startsWith('Filesystem'))[0];
  if (dfLine) {
    const parts = dfLine.split(/\s+/);
    if (parts.length >= 5) {
      lines.push(`Disk: *${parts[2]} / ${parts[1]}* (${parts[4]})`);
    }
  }

  lines.push('');
  lines.push('*Octave processes*');

  // RSS per service from heartbeats
  const beats = readAllBeats();
  const SVC = { 'signal-engine': 'Signal', 'bot': 'Bot', 'webui': 'Dashboard', 'watchdog': 'Watchdog' };
  let totalMb = 0;
  for (const [key, label] of Object.entries(SVC)) {
    const b = beats[key];
    if (b && b.mem_mb) {
      lines.push(`  ${label}: ${b.mem_mb} MB · up ${Math.round((b.uptime_s || 0) / 60)}m`);
      totalMb += b.mem_mb;
    } else {
      lines.push(`  ${label}: not reporting`);
    }
  }
  lines.push(`  Total: *${totalMb} MB*`);

  // Market data freshness
  const md = beats['market-data'];
  if (md?.last_fetch_ms) {
    const age = Math.round((Date.now() - md.last_fetch_ms) / 1000);
    lines.push('');
    lines.push(`Market data: last Yahoo fetch ${age}s ago · ${md.pane_count || 0} panes cached`);
  }

  await send(lines.join('\n'));
}

async function cmdHealth() {
  const beats = readAllBeats();
  const SERVICE_DISPLAY = {
    'signal-engine': 'Signal Engine',
    'bot':           'Telegram Bot',
    'webui':         'Dashboard',
    'watchdog':      'Watchdog',
    'market-data':   'Market Data',
  };
  const serviceLines = [];
  let allGreen = true;
  for (const [key, label] of Object.entries(SERVICE_DISPLAY)) {
    const b = beats[key];
    if (!b) {
      serviceLines.push(`🔴 ${label}: not running`);
      allGreen = false;
      continue;
    }
    const ageS = Math.round((Date.now() - b.at) / 1000);
    if (isStale(key, b)) {
      serviceLines.push(`🟠 ${label}: stale (${ageS}s ago)`);
      allGreen = false;
    } else {
      const mem = b.mem_mb ? ` · ${b.mem_mb}MB` : '';
      serviceLines.push(`🟢 ${label}: live · ${ageS}s ago${mem}`);
    }
  }
  await send([
    allGreen ? '✅ *All systems normal*' : '⚠️ *Issues detected*',
    '',
    ...serviceLines,
  ].join('\n'));
}

const SERVICE_LABELS = {
  all: 'all services',
  signal: 'com.jqvier.trading-alerts',
  signals: 'com.jqvier.trading-alerts',
  bot: 'com.jqvier.octave-telegram',
  telegram: 'com.jqvier.octave-telegram',
  webui: 'com.jqvier.octave-webui',
  dashboard: 'com.jqvier.octave-webui',
  watchdog: 'com.jqvier.octave-watchdog',
};

async function cmdRestartSvc(arg) {
  const key = (arg || 'all').trim().toLowerCase();
  if (key === 'all') {
    await send('🔄 Restarting all services…');
    for (const label of ['com.jqvier.trading-alerts', 'com.jqvier.octave-telegram', 'com.jqvier.octave-webui', 'com.jqvier.octave-watchdog']) {
      spawn('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], { detached: true, stdio: 'ignore' }).unref();
    }
    setTimeout(() => cmdHealth(), 5000);
    return;
  }
  const label = SERVICE_LABELS[key];
  if (!label) {
    await send(`Unknown service. Try: \`/restart all\`, \`/restart bot\`, \`/restart signals\`, \`/restart webui\`, \`/restart watchdog\``);
    return;
  }
  await send(`🔄 Restarting \`${label}\`…`);
  spawn('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => cmdHealth(), 4000);
}

async function cmdCloudDiagnose() {
  // Hit GitHub Actions API to check recent workflow runs
  await send('🔍 Diagnosing cloud (this takes ~3s)…');
  try {
    const repo = 'octavebot/octave';
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/octave-tick.yml/runs?per_page=5`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'octave-bot' },
    });
    if (!res.ok) {
      await send(`⚠️ GitHub API returned ${res.status}. The repo may be private and need a token, or Actions may not be enabled.\n\nFix: visit https://github.com/${repo}/settings/actions and ensure "Allow all actions" is selected.`);
      return;
    }
    const data = await res.json();
    const runs = data.workflow_runs || [];
    if (runs.length === 0) {
      await send(`📭 No workflow runs found.\n\nLikely cause: GitHub Actions not enabled.\n\n*Fix:*\n1. Go to https://github.com/${repo}/settings/actions\n2. Select "Allow all actions"\n3. Then go to the Actions tab and click "Run workflow" once to bootstrap`);
      return;
    }
    const lines = ['☁️ *Cloud Diagnostic*', '', `Repo: \`${repo}\``, `Workflow: \`octave-tick.yml\``, ''];
    lines.push('*Last 5 runs:*');
    for (const r of runs.slice(0, 5)) {
      const age = Math.round((Date.now() - new Date(r.updated_at).getTime()) / 60000);
      const icon = r.conclusion === 'success' ? '✅' : r.conclusion === 'failure' ? '❌' : (r.status === 'in_progress' ? '🔄' : '⏸');
      lines.push(`${icon} \`${r.status}/${r.conclusion || '...'}\` — ${age}m ago — ${r.event}`);
    }
    lines.push('');
    const lastFail = runs.find((r) => r.conclusion === 'failure');
    if (lastFail) {
      lines.push(`⚠️ Last failure: ${lastFail.html_url}`);
      lines.push('Open it in the browser to see which step failed (usually missing secrets).');
    }
    lines.push('');
    lines.push('Common fixes if cloud is stale:');
    lines.push('• Actions disabled → enable at settings/actions');
    lines.push('• Missing secret → add TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID at settings/secrets/actions');
    lines.push('• Cron not firing → workflow_dispatch a test run from the Actions page');
    await send(lines.join('\n'));
  } catch (err) {
    await send(`⚠️ Diagnose failed: ${err.message}`);
  }
}

/** Run the detector in a child process; returns the parsed results array. */
async function runDetectChild() {
  const script = join(REPO_DIR, 'scripts', 'run-detect-child.js');
  if (!existsSync(script)) return { error: 'detect runner script not found at ' + script };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: REPO_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '', stderr = '', result = null;
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith('RESULT:')) {
          try { result = JSON.parse(line.slice(7)); } catch {}
        } else {
          console.log('[detect-child]', line);
        }
      }
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      console.error('[detect-child stderr]', s.trim());
    });
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 30_000);
    child.on('exit', (code) => {
      clearTimeout(kill);
      if (result) return resolve(result);
      // No RESULT line — surface the actual stderr so the user can see why
      const tail = (stderr || '(no stderr)').split('\n').slice(-6).join(' / ').slice(0, 400);
      resolve({ error: `detect crashed (exit ${code}): ${tail}` });
    });
    child.on('error', (e) => { clearTimeout(kill); resolve({ error: e.message }); });
  });
}

/** Lists every strategy with directional activity right now (forming/near/triggered). */
async function cmdActiveSetups() {
  await send('🎯 Checking all strategies…');
  const r = await runDetectChild();
  if (r.error) { await send(`⚠️ ${r.error}`); return; }
  const directional = (r.results || []).filter((x) => x.direction === 'LONG' || x.direction === 'SHORT');
  if (directional.length === 0) {
    await send('🎯 *No active setups*\n\nNo strategy is showing directional development. Could be: outside killzones, no liquidity sweep yet, market consolidating. Try `/24h on` to allow signals any hour (lower quality).');
    return;
  }
  // Group by strategy with the most-advanced status per
  const PRI = { triggered: 0, near_trigger: 1, forming: 2, invalidated: 3 };
  const byStrategy = {};
  for (const x of directional) {
    const cur = byStrategy[x.strategy];
    if (!cur || (PRI[x.status] ?? 9) < (PRI[cur.status] ?? 9)) byStrategy[x.strategy] = x;
  }
  const sorted = Object.values(byStrategy).sort((a, b) => (PRI[a.status] ?? 9) - (PRI[b.status] ?? 9));
  const STAGE = { triggered: '🟢 TRIGGERED', near_trigger: '🟠 NEAR', forming: '🟡 FORMING' };
  const lines = ['🎯 *Active Setups*', ''];
  for (const s of sorted) {
    const dir = s.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    lines.push(`*#${STRATEGY_NUM[s.strategy] || '?'} ${s.strategy}* — ${dir} · ${STAGE[s.status] || s.status} · ${Math.round((s.confidence||0)*100)}%`);
    if (s.summary) lines.push(`  _${s.summary.slice(0, 100)}_`);
    lines.push('');
  }
  lines.push('Send `/setup <num>` for a chart + what\'s still missing.');
  await send(lines.join('\n'));
}

async function cmdBias() {
  await send('🧭 Computing market bias…');
  const r = await runDetectChild();
  if (r.error) { await send(`⚠️ ${r.error}`); return; }

  // Confidence-weighted scoring: triggered counts more than forming, high
  // confidence counts more than low.
  const STATUS_WT = { triggered: 3, near_trigger: 2, forming: 1, invalidated: 0 };
  let longScore = 0, shortScore = 0;
  const longSetups = [], shortSetups = [];
  for (const x of r.results || []) {
    if (!x.direction || x.direction === 'NONE') continue;
    const w = (STATUS_WT[x.status] || 0) * (x.confidence || 0.5);
    if (x.direction === 'LONG')  { longScore  += w; longSetups.push(x); }
    if (x.direction === 'SHORT') { shortScore += w; shortSetups.push(x); }
  }

  // If NOTHING came back at all (no signals from any strategy), we can't bias
  if (!longSetups.length && !shortSetups.length) {
    await send([
      '⚪ *NEUTRAL* — no signals',
      '',
      'No strategy is showing directional development right now. The market is in chop / outside killzones / waiting for a sweep.',
      '',
      'Try /setup <num> on a specific strategy to see what it\'s waiting for.',
    ].join('\n'));
    return;
  }

  const total = longScore + shortScore;
  let biasIcon, biasWord, biasPct;
  if (total < 0.1) {
    biasIcon = '⚪'; biasWord = 'NEUTRAL'; biasPct = '—';
  } else if (longScore > shortScore * 1.3) {
    biasIcon = '🟢'; biasWord = 'BULLISH';
    biasPct = `${Math.round(longScore / total * 100)}%`;
  } else if (shortScore > longScore * 1.3) {
    biasIcon = '🔴'; biasWord = 'BEARISH';
    biasPct = `${Math.round(shortScore / total * 100)}%`;
  } else {
    biasIcon = '⚪'; biasWord = 'MIXED'; biasPct = '~50/50';
  }

  const lines = [
    `${biasIcon} *${biasWord}* bias  (${biasPct})`,
    `Long ${longSetups.length} · Short ${shortSetups.length} signals`,
    '',
  ];
  if (longSetups.length) {
    lines.push(`🟢 *LONG*`);
    for (const s of longSetups.slice(0, 5)) {
      lines.push(`  · #${STRATEGY_NUM[s.strategy] || '?'} ${s.strategy} — ${s.status} ${Math.round((s.confidence||0)*100)}%`);
    }
  }
  if (shortSetups.length) {
    if (longSetups.length) lines.push('');
    lines.push(`🔴 *SHORT*`);
    for (const s of shortSetups.slice(0, 5)) {
      lines.push(`  · #${STRATEGY_NUM[s.strategy] || '?'} ${s.strategy} — ${s.status} ${Math.round((s.confidence||0)*100)}%`);
    }
  }
  await send(lines.join('\n'));
}

async function cmdSetup(arg) {
  const key = resolveStrategy(arg);
  if (!key) {
    await send('Usage: `/setup <num>` (1-10) or `/setup <name>` (e.g. `/setup ICT`).');
    return;
  }
  await send(`🔍 Checking *${key}*…`);
  const r = await runDetectChild();
  if (r.error) { await send(`⚠️ ${r.error}`); return; }
  const matches = (r.results || []).filter((x) => x.strategy === key);
  if (matches.length === 0) {
    await send(`#${STRATEGY_NUM[key]} *${key}* — no activity right now.\n\nThe strategy is enabled and watching but no setup is forming. Common reasons: outside killzone window, no liquidity sweep yet, no HTF gap tapped, etc.`);
    return;
  }
  // Pick the most advanced one (triggered > near_trigger > forming > invalidated)
  const PRI = { triggered: 0, near_trigger: 1, forming: 2, invalidated: 3 };
  matches.sort((a, b) => (PRI[a.status] ?? 9) - (PRI[b.status] ?? 9));
  const top = matches[0];
  const conf = Math.round((top.confidence || 0) * 100);

  // Build a chart image if entryPlan exists OR pseudo-plan from geometry
  let chartUrl = null;
  if (top.entryPlan) {
    try {
      const m = await import('../lib/chart_image.js');
      chartUrl = await m.buildAlertChartUrl(top);
    } catch {}
  }

  const STAGE_LABEL = { forming: '🟡 FORMING', near_trigger: '🟠 NEAR TRIGGER', triggered: '🟢 TRIGGERED', invalidated: '❌ INVALIDATED' };
  const lines = [
    `🔍 *#${STRATEGY_NUM[key]} ${key}* — ${STAGE_LABEL[top.status] || top.status}`,
    `Direction: ${top.direction === 'LONG' ? '🟢 LONG' : top.direction === 'SHORT' ? '🔴 SHORT' : '—'}`,
    `Confidence: *${conf}%*`,
    '',
    top.summary || top.setupName || '',
  ];
  // What's confirmed vs missing
  const g = top.geometry || {};
  const confirmed = [], missing = [];
  if (g.target?.level)   confirmed.push(`Target identified (${g.target.name || ''} @ ${g.target.level.toFixed(2)})`);
  else missing.push('Liquidity target');
  if (g.sweep?.wickPrice) confirmed.push(`Sweep wick @ ${g.sweep.wickPrice.toFixed(2)}`);
  else missing.push('Liquidity sweep');
  if (g.mss?.brokenPrice) confirmed.push(`MSS @ ${g.mss.brokenPrice.toFixed(2)}`);
  else missing.push('Market structure shift (MSS)');
  if (g.fvg?.top != null) confirmed.push(`FVG ${g.fvg.bottom.toFixed(2)}-${g.fvg.top.toFixed(2)}`);
  else if (top.status !== 'triggered') missing.push('Fair Value Gap');
  if (top.entryPlan) confirmed.push(`Entry plan ready @ ${top.entryPlan.entry.toFixed(2)}`);

  if (confirmed.length) {
    lines.push('');
    lines.push('*✅ Confirmed:*');
    for (const c of confirmed) lines.push(`  · ${c}`);
  }
  if (missing.length && top.status !== 'triggered') {
    lines.push('');
    lines.push('*⏳ Still needed:*');
    for (const m of missing) lines.push(`  · ${m}`);
  }

  if (chartUrl) {
    // Send via sendPhoto with this whole message as caption (truncated if needed)
    const fits = lines.join('\n').length <= 1024;
    const caption = fits ? lines.join('\n') : lines.join('\n').slice(0, 980) + '…';
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, photo: chartUrl, caption, parse_mode: 'Markdown' }),
    }).catch(() => {});
    if (!fits) await send(lines.join('\n'));
  } else {
    await send(lines.join('\n'));
  }
}

async function cmdShutdown(arg) {
  if (arg !== 'confirm') {
    await send('⚠️ Use `/shutdown confirm` to actually stop everything.\n\nThis will:\n• Stop the alerts service\n• Stop caffeinate (Mac can sleep)\n• Quit TradingView\n• Kill Claude Code\n• Stop the web UI / bot');
    return;
  }
  await send('⏸ Shutting down…');
  spawn('/Users/jqvier/Desktop/Octave.app/Contents/MacOS/octave', ['shutdown'], { detached: true, stdio: 'ignore' }).unref();
}

// ---------- INLINE KEYBOARD VIEWS ----------

async function buildMainMenuView() {
  const cfg = loadConfig() || {};
  const session = readJson(SESSION_FILE, { lastSession: null });
  const onCount = cfg.strategies ? Object.values(cfg.strategies).filter(Boolean).length : 0;
  const muteMin = cfg.mute?.untilMs && cfg.mute.untilMs > Date.now()
    ? Math.round((cfg.mute.untilMs - Date.now()) / 60000) : 0;
  const sessionLabel = (session.lastSession || 'closed').toUpperCase();

  // Total = built-in STRATEGY_KEYS + any user-defined strategies on disk
  let userCount = 0;
  try {
    const us = await import('../lib/user_strategies.js');
    userCount = us.list().length;
  } catch {}
  const totalStrategies = STRATEGY_KEYS.length + userCount;

  const text = [
    '🎵 *Octave*',
    '',
    `${muteMin > 0 ? '🔕 Muted ' + muteMin + 'm' : '🔔 Live'} · ${onCount}/${totalStrategies} strategies · ${sessionLabel} session`,
    cfg.bypassKillzones ? '🌐 24/7 mode ON' : '',
  ].filter(Boolean).join('\n');

  // Trader-focused layout: most-used commands first, by daily workflow
  const keyboard = [
    [
      { text: '🧭 Bias',       callback_data: 'act:bias' },
      { text: '🎯 Active Setups', callback_data: 'act:setups' },
    ],
    [
      { text: '📊 Today',      callback_data: 'act:today' },
      { text: '🔔 Last Alert', callback_data: 'act:last' },
    ],
    [
      { text: '💰 Price',      callback_data: 'act:price' },
      { text: '🌍 Session',    callback_data: 'act:session' },
    ],
    [
      { text: '🎛 Strategies', callback_data: 'view:strategies' },
      { text: '🔕 Mute',       callback_data: 'view:mute' },
    ],
    [
      { text: '📈 Backtest',   callback_data: 'view:backtest' },
      { text: '🌐 Dashboard',  callback_data: 'act:dashboard' },
    ],
    [
      { text: '🩺 Health',     callback_data: 'act:health' },
      { text: '⚙️ Settings',   callback_data: 'view:settings' },
    ],
    [
      { text: '🔄 Refresh',    callback_data: 'view:main' },
    ],
  ];
  return { text, keyboard };
}

function buildStrategiesView() {
  const cfg = loadConfig() || { strategies: {} };
  const text = [
    '🎛 *Strategies*',
    '',
    'Tap any strategy to toggle on/off. Grouped by source folder.',
  ].join('\n');
  const keyboard = [];
  for (const group of STRATEGY_GROUPS) {
    // Section header as a non-callable row (Telegram requires callback_data;
    // use a no-op placeholder).
    keyboard.push([{ text: `── 📁 ${group.name} ──`, callback_data: 'view:strategies' }]);
    for (const k of group.keys) {
      const on = !!cfg.strategies[k];
      const name = STRATEGY_NICKNAME[k] || k;
      keyboard.push([{
        text: `${on ? '🟢' : '⚫'} #${STRATEGY_NUM[k]} ${name}`,
        callback_data: `strat:${k}`,
      }]);
    }
  }
  keyboard.push([{ text: '« Back', callback_data: 'view:main' }]);
  return { text, keyboard };
}

function buildMuteView() {
  const cfg = loadConfig() || {};
  const sec = cfg.mute?.untilMs && cfg.mute.untilMs > Date.now()
    ? Math.round((cfg.mute.untilMs - Date.now()) / 1000) : 0;
  const text = sec > 0
    ? `🔕 *Muted* — ${Math.round(sec / 60)}m remaining\n\nUntil: \`${nyHourMinute(cfg.mute.untilMs)}\` NY`
    : '🔔 *Alerts are live*\n\nMute pauses all alerts for the chosen duration.';
  const keyboard = [
    [
      { text: '🔕 30 min', callback_data: 'mute:30' },
      { text: '🔕 60 min', callback_data: 'mute:60' },
      { text: '🔕 3 hours', callback_data: 'mute:180' },
    ],
    [
      { text: '🔕 12 hours', callback_data: 'mute:720' },
      { text: '🔕 24 hours', callback_data: 'mute:1440' },
    ],
    [{ text: '🔔 Unmute', callback_data: 'mute:0' }],
    [{ text: '« Back', callback_data: 'view:main' }],
  ];
  return { text, keyboard };
}

function buildBacktestView() {
  const text = [
    '📈 *Backtest*',
    '',
    'Pick a window. Reports run in an isolated process — bot stays responsive even if a strategy is slow.',
  ].join('\n');
  const keyboard = [
    [
      { text: '7 days',  callback_data: 'bt:7' },
      { text: '30 days', callback_data: 'bt:30' },
      { text: '60 days', callback_data: 'bt:60' },
    ],
    [
      { text: 'All enabled (30d)', callback_data: 'bt:30' },
    ],
    [{ text: '« Back', callback_data: 'view:main' }],
  ];
  return { text, keyboard };
}

function buildSettingsView() {
  const cfg = loadConfig() || {};
  const text = [
    '⚙️ *Settings*',
    '',
    `24/7 mode:    ${cfg.bypassKillzones ? '🟢 ON (alerts any hour)' : '⚫ OFF (killzones only)'}`,
    `Chart images: ${cfg.alertChartImages !== false ? '🟢 ON' : '⚫ OFF'}`,
  ].join('\n');
  const keyboard = [
    [{ text: cfg.bypassKillzones ? '⚫ Turn 24/7 mode OFF' : '🌐 Turn 24/7 mode ON', callback_data: `set:24h:${cfg.bypassKillzones ? 'off' : 'on'}` }],
    [{ text: cfg.alertChartImages !== false ? '⚫ Disable chart images' : '🟢 Enable chart images', callback_data: `set:charts:${cfg.alertChartImages !== false ? 'off' : 'on'}` }],
    [{ text: '🚨 System (restart/shutdown)', callback_data: 'view:system' }],
    [{ text: '« Back', callback_data: 'view:main' }],
  ];
  return { text, keyboard };
}

function buildSystemView() {
  const text = [
    '🚨 *System Actions*',
    '',
    'Restart bounces a single service. Shutdown stops Octave entirely (you\'d have to SSH back in to restart).',
  ].join('\n');
  const keyboard = [
    [{ text: '🔄 Restart all',          callback_data: 'act:restart-all' }],
    [{ text: '🔄 Restart signal engine', callback_data: 'act:restart' }],
    [{ text: '🔄 Restart bot',          callback_data: 'act:restart-bot' }],
    [{ text: '🔄 Restart dashboard',    callback_data: 'act:restart-webui' }],
    [{ text: '« Back', callback_data: 'view:settings' }],
    [{ text: '⏸ Shutdown ALL', callback_data: 'act:shutdown-confirm' }],
    [{ text: '⏸ Shutdown ALL', callback_data: 'act:shutdown-confirm' }],
    [{ text: '« Back', callback_data: 'view:main' }],
  ];
  return { text, keyboard };
}

async function cmdMenu() {
  const v = await buildMainMenuView();
  await send(v.text, { keyboard: v.keyboard });
}

// ---------- CALLBACK (button tap) DISPATCHER ----------

async function handleCallback(cq) {
  // Security check (same as messages)
  if (String(cq.from?.id) !== String(CHAT_ID) && String(cq.message?.chat?.id) !== String(CHAT_ID)) {
    return answerCallback(cq.id, 'unauthorized');
  }
  const data = cq.data || '';
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const [kind, ...rest] = data.split(':');
  const arg = rest.join(':');

  try {
    if (kind === 'view') {
      let v;
      if (arg === 'main') v = await buildMainMenuView();
      else if (arg === 'strategies') v = buildStrategiesView();
      else if (arg === 'mute') v = buildMuteView();
      else if (arg === 'backtest') v = buildBacktestView();
      else if (arg === 'settings') v = buildSettingsView();
      else if (arg === 'system') v = buildSystemView();
      if (v) {
        await editMessage(chatId, messageId, v.text, { keyboard: v.keyboard });
        await answerCallback(cq.id);
      } else {
        await answerCallback(cq.id, 'unknown view');
      }
      return;
    }

    if (kind === 'strat') {
      const k = arg;
      if (!STRATEGY_KEYS.includes(k)) return answerCallback(cq.id, 'unknown strategy');
      const cur = loadConfig() || { strategies: {} };
      const next = !cur.strategies?.[k];
      await saveConfigAndPush((c) => { c.strategies = c.strategies || {}; c.strategies[k] = next; return c; });
      const v = buildStrategiesView();
      await editMessage(chatId, messageId, v.text, { keyboard: v.keyboard });
      await answerCallback(cq.id, `${k} → ${next ? 'ON' : 'OFF'}`);
      return;
    }

    if (kind === 'mute') {
      const minutes = parseInt(arg, 10);
      if (minutes === 0) {
        await saveConfigAndPush((c) => { c.mute = { untilMs: 0, reason: null }; return c; });
        const v = buildMuteView();
        await editMessage(chatId, messageId, v.text, { keyboard: v.keyboard });
        await answerCallback(cq.id, '🔔 Unmuted');
        return;
      }
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
        return answerCallback(cq.id, 'invalid');
      }
      const untilMs = Date.now() + minutes * 60 * 1000;
      await saveConfigAndPush((c) => { c.mute = { untilMs, reason: 'telegram menu' }; return c; });
      const v = buildMuteView();
      await editMessage(chatId, messageId, v.text, { keyboard: v.keyboard });
      await answerCallback(cq.id, `🔕 ${minutes}m`);
      return;
    }

    if (kind === 'set') {
      const [what, val] = arg.split(':');
      if (what === '24h') {
        await saveConfigAndPush((c) => { c.bypassKillzones = (val === 'on'); return c; });
        const v = buildSettingsView();
        await editMessage(chatId, messageId, v.text, { keyboard: v.keyboard });
        return answerCallback(cq.id, '24/7 → ' + val);
      }
      if (what === 'charts') {
        await saveConfigAndPush((c) => { c.alertChartImages = (val === 'on'); return c; });
        const v = buildSettingsView();
        await editMessage(chatId, messageId, v.text, { keyboard: v.keyboard });
        return answerCallback(cq.id, 'Charts → ' + val);
      }
      return answerCallback(cq.id, 'unknown setting');
    }

    if (kind === 'bt') {
      const days = parseInt(arg, 10) || 30;
      await editMessage(chatId, messageId, `⏳ Running ${days}-day backtest…`, { keyboard: [] });
      await answerCallback(cq.id);
      await cmdBacktest(String(days));
      return;
    }

    if (kind === 'act') {
      if (arg === 'bias')      { await cmdBias();      return answerCallback(cq.id); }
      if (arg === 'setups')    { await cmdActiveSetups(); return answerCallback(cq.id); }
      if (arg === 'today')     { await cmdToday();     return answerCallback(cq.id); }
      if (arg === 'last')      { await cmdLast();      return answerCallback(cq.id); }
      if (arg === 'price')     { await cmdPrice();     return answerCallback(cq.id); }
      if (arg === 'session')   { await cmdSession();   return answerCallback(cq.id); }
      if (arg === 'health')    { await cmdHealth();    return answerCallback(cq.id); }
      if (arg === 'dashboard') { await cmdDashboard(); return answerCallback(cq.id); }
      if (arg === 'restart')      { await cmdRestartSvc('signal-engine'); return answerCallback(cq.id, 'Restarting signal engine…'); }
      if (arg === 'restart-all')  { await cmdRestartSvc('all');  return answerCallback(cq.id, 'Restarting all…'); }
      if (arg === 'restart-bot')  { await cmdRestartSvc('bot');  return answerCallback(cq.id, 'Restarting bot…'); }
      if (arg === 'restart-webui'){ await cmdRestartSvc('webui'); return answerCallback(cq.id, 'Restarting dashboard…'); }
      if (arg === 'shutdown-confirm') {
        const text = '⚠️ *Confirm Shutdown*\n\nThis stops every service on the VPS. You\'ll need to SSH in to bring Octave back.';
        await editMessage(chatId, messageId, text, {
          keyboard: [
            [{ text: '✅ Yes, shut down', callback_data: 'act:shutdown-do' }],
            [{ text: '« Cancel', callback_data: 'view:system' }],
          ],
        });
        return answerCallback(cq.id);
      }
      if (arg === 'shutdown-do') {
        await editMessage(chatId, messageId, '⏸ Shutting down…', { keyboard: [] });
        await cmdShutdown('confirm');
        return answerCallback(cq.id, 'Bye.');
      }
    }

    await answerCallback(cq.id, 'Unknown action');
  } catch (err) {
    console.error('[bot] callback handler threw:', err.message);
    await answerCallback(cq.id, 'Error: ' + err.message);
  }
}

// ---------- dispatch ----------

const COMMANDS = {
  '/start': cmdMenu,
  '/help': cmdHelp,
  '/menu': cmdMenu,
  '/panel': cmdMenu,
  '/app': cmdMenu,
  '/status': cmdStatus,
  // /cloud and /local merged into /health (cloud-only architecture now)
  '/session': cmdSession,
  '/price': cmdPrice,
  '/history': cmdHistory,
  '/today': cmdToday,
  '/yesterday': cmdYesterday,
  '/range': cmdRange,
  '/last': cmdLast,
  '/strategies': cmdStrategies,
  '/enable': cmdEnable,
  '/disable': cmdDisable,
  // /mode removed — cloud-only architecture, no more switching
  '/mute': cmdMute,
  '/unmute': cmdUnmute,
  '/version': cmdVersion,
  '/restart': cmdRestartSvc,
  '/shutdown': cmdShutdown,
  '/backtest': cmdBacktest,
  '/health': cmdHealth,
  '/dashboard': cmdDashboard,
  '/web': cmdDashboard,
  '/bias': cmdBias,
  '/setup': cmdSetup,
  '/24h': cmd24h,
  '/24': cmd24h,
  '/summary': cmdSummary,
  '/digest': cmdSummary,
  '/perf': cmdPerf,
  '/news': cmdNews,
  '/addstrategy': cmdAddStrategy,
  '/editstrategy': cmdEditStrategy,
  '/delstrategy': cmdDelStrategy,
  '/mystrategies': cmdMyStrategies,
};

/**
 * /mystrategies — list user-defined strategies with status.
 */
async function cmdMyStrategies() {
  let items = [];
  try {
    const us = await import('../lib/user_strategies.js');
    items = us.list();
  } catch {}
  if (items.length === 0) {
    await send(['👤 *My Strategies*', '', '_(none defined yet)_', '',
      'Add one from the dashboard (📁 My Strategies → ＋ New strategy)',
      'or via Telegram:',
      '`/addstrategy <id> <name> <entry> [tf]`',
      'entry ∈ ema_cross | ema_pullback | bb_extreme | rsi_bounds',
      'Example: `/addstrategy my-ema-9-21 "EMA 9/21 cross" ema_cross 15`',
    ].join('\n'));
    return;
  }
  const lines = ['👤 *My Strategies*', ''];
  const cfg = loadConfig() || {};
  for (const it of items) {
    const on = cfg.strategies?.[it.id] !== false;
    lines.push(`${on ? '🟢' : '⚫'} \`${tgEscape(it.id)}\` · ${tgEscape(it.name)}`);
    lines.push(`   ${tgEscape(it.entry)} @ ${it.timeframe}m · stop ${it.stop_atr_mult}× ATR · TP ${it.tp_r}R`);
  }
  lines.push('');
  lines.push('Edit: `/editstrategy <id> <field>=<value> ...`');
  lines.push('Delete: `/delstrategy <id>`');
  await send(lines.join('\n'));
}

/**
 * /addstrategy <id> <name in quotes> <entry> [tf]
 * Minimal Telegram CRUD. For richer fields use the dashboard.
 */
async function cmdAddStrategy(arg) {
  const parts = parseArgs(arg || '');
  if (parts.length < 3) {
    await send([
      'Usage: `/addstrategy <id> "<name>" <entry> [tf]`',
      'entry: ema_cross · ema_pullback · bb_extreme · rsi_bounds',
      'Example: `/addstrategy my-cross "EMA Cross" ema_cross 15`',
    ].join('\n'));
    return;
  }
  const [id, name, entry, tf] = parts;
  try {
    const us = await import('../lib/user_strategies.js');
    const created = us.create({
      id, name, entry, timeframe: tf || '15',
      description: '', direction: 'auto',
      fast: 9, slow: 21, rsi_min: 0, rsi_max: 100,
      stop_atr_mult: 1.5, tp_r: 2, enabled: true,
    });
    await saveConfigAndPush((c) => { c.strategies = c.strategies || {}; c.strategies[created.id] = true; return c; });
    await send(`✅ Created \`${tgEscape(created.id)}\` — ${tgEscape(created.name)}\nEnabled by default. Edit any field with \`/editstrategy ${created.id} <key>=<value>\`.`);
  } catch (err) {
    await send(`⚠️ ${err.message}`);
  }
}

/**
 * /editstrategy <id> key=value key=value …
 * Updates any of: name, description, timeframe, direction, entry, fast, slow,
 *                 rsi_min, rsi_max, stop_atr_mult, tp_r, enabled.
 */
async function cmdEditStrategy(arg) {
  const parts = parseArgs(arg || '');
  if (parts.length < 2) {
    await send('Usage: `/editstrategy <id> key=value …`\nKeys: name, description, timeframe, direction, entry, fast, slow, rsi_min, rsi_max, stop_atr_mult, tp_r, enabled');
    return;
  }
  const id = parts[0];
  try {
    const us = await import('../lib/user_strategies.js');
    const cur = us.get(id);
    if (!cur) { await send(`No strategy with id \`${tgEscape(id)}\`. See \`/mystrategies\`.`); return; }
    const patch = { ...cur };
    for (const kv of parts.slice(1)) {
      const eq = kv.indexOf('=');
      if (eq < 0) continue;
      const k = kv.slice(0, eq).trim();
      const v = kv.slice(eq + 1).trim();
      if (['fast', 'slow', 'rsi_min', 'rsi_max'].includes(k)) patch[k] = Number(v);
      else if (['stop_atr_mult', 'tp_r'].includes(k)) patch[k] = Number(v);
      else if (k === 'enabled') patch.enabled = (v === 'true' || v === '1' || v === 'on');
      else patch[k] = v;
    }
    const updated = us.update(id, patch);
    await saveConfigAndPush((c) => { c.strategies = c.strategies || {}; c.strategies[updated.id] = updated.enabled; return c; });
    await send(`✅ Updated \`${tgEscape(updated.id)}\` — ${tgEscape(updated.name)}`);
  } catch (err) {
    await send(`⚠️ ${err.message}`);
  }
}

async function cmdDelStrategy(arg) {
  const id = (arg || '').trim().replace(/^['"]|['"]$/g, '');
  if (!id) { await send('Usage: `/delstrategy <id>`'); return; }
  try {
    const us = await import('../lib/user_strategies.js');
    us.remove(id);
    await saveConfigAndPush((c) => {
      c.strategies = c.strategies || {};
      delete c.strategies[id];
      return c;
    });
    await send(`🗑 Deleted \`${tgEscape(id)}\``);
  } catch (err) {
    await send(`⚠️ ${err.message}`);
  }
}

/** Tokenize a Telegram arg string, honoring "double-quoted phrases". */
function parseArgs(s) {
  const out = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] != null ? m[1] : m[2]);
  return out;
}

/**
 * /news — clean digest of high-impact USD events.
 * Header tells you EXACTLY whether the bot is paused right now; body groups
 * the next events by day so you can plan around them.
 */
async function cmdNews(arg) {
  const { upcomingEvents, checkBlackout, refreshForexFactory, nextEvent } = await import('../lib/news.js');
  await refreshForexFactory().catch(() => {});
  const hours = Math.max(1, Math.min(168, parseInt((arg || '').trim(), 10) || 48));
  const now = Date.now() / 1000;
  const bo = checkBlackout(now, 30);
  const evs = upcomingEvents(now, hours);

  // ── Header — single most important line ──
  const header = bo.blocked && bo.event
    ? `🚫 *Bot paused — news blackout*\n   ${tgEscape(bo.event.title || 'high-impact event')} · ${bo.minutesAway}m away`
    : `✅ *Bot is trading freely*\n   _No high-impact event in the next 30m._`;

  // ── Next event countdown ──
  let nextLine = '';
  const nxt = nextEvent(now);
  if (nxt && nxt.minutesAway > 30) {
    const m = nxt.minutesAway;
    const away = m < 60 ? `${m}m`
                : m < 1440 ? `${(m / 60).toFixed(1)}h`
                : `${(m / 1440).toFixed(1)}d`;
    nextLine = `⏳ Next: *${tgEscape(nxt.title || '?')}* in ${away}`;
  }

  // ── Group upcoming by NY date ──
  const fmtDate = (unix) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
  }).format(new Date(unix * 1000));
  const fmtTime = (unix) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(unix * 1000));

  const byDay = new Map();
  for (const ev of evs) {
    const key = fmtDate(ev.unix);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }

  const lines = [
    '📰 *News watch*',
    '',
    header,
    nextLine,
    '',
    `─── next ${hours}h ───`,
  ].filter(Boolean);

  if (byDay.size === 0) {
    lines.push('');
    lines.push('_No upcoming high-impact USD events in this window._');
  } else {
    for (const [day, dayEvents] of byDay) {
      lines.push('');
      lines.push(`*${day}*`);
      for (const ev of dayEvents) {
        lines.push(`  \`${fmtTime(ev.unix)}\` · ${tgEscape(ev.title || ev.name || '?')}`);
      }
    }
  }
  lines.push('');
  lines.push('_Auto-paused ±30m around each event. Source: ForexFactory._');
  await send(lines.join('\n'));
}

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;
  // Security: only respond to the configured chat
  if (String(msg.chat?.id) !== String(CHAT_ID)) {
    console.log('[bot] ignored msg from chat', msg.chat?.id);
    return;
  }
  const text = msg.text.trim();
  // Match leading command + optional argument (handles "/help" and "/help@octavebot" and "/range 09:30-11:00")
  const m = /^\/([a-z]+)(?:@\w+)?(?:\s+(.+))?$/i.exec(text);
  if (!m) {
    // Free-form message — guide them to /help
    await send('I respond to commands. Send `/help` to see what I can do.');
    return;
  }
  const cmd = '/' + m[1].toLowerCase();
  const arg = m[2] ? m[2].trim() : '';
  const handler = COMMANDS[cmd];
  if (!handler) {
    await send(`Unknown command: \`${cmd}\`\n\nSend \`/help\` for the list.`);
    return;
  }
  try {
    await handler(arg);
  } catch (err) {
    console.error(`[bot] handler ${cmd} threw:`, err.message);
    await send(`⚠️ Error running \`${cmd}\`: ${err.message}`).catch(() => {});
  }
}

let offset = 0;
let stopped = false;
let pollErrors = 0;

async function pollLoop() {
  console.log('[bot] poll loop started');
  // Heartbeat every 10s independent of Telegram traffic
  const hbTimer = startHeartbeat('bot', 10_000, () => ({ offset, pollErrors }));
  while (!stopped) {
    try {
      heartbeat('bot', { offset, phase: 'polling' });
      const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}&timeout=25`;
      const res = await fetch(url);
      if (!res.ok) {
        pollErrors++;
        console.error('[bot] getUpdates non-2xx', res.status);
        await new Promise((r) => setTimeout(r, Math.min(60000, 1000 * pollErrors)));
        continue;
      }
      pollErrors = 0;
      const data = await res.json();
      const updates = data?.result || [];
      for (const u of updates) {
        if (u.update_id >= offset) offset = u.update_id + 1;
        if (u.callback_query) {
          handleCallback(u.callback_query).catch((e) =>
            console.error('[bot] handleCallback threw:', e.message)
          );
        } else {
          handleUpdate(u).catch((e) => console.error('[bot] handleUpdate threw:', e.message));
        }
      }
    } catch (err) {
      pollErrors++;
      console.error('[bot] poll error:', err.message);
      await new Promise((r) => setTimeout(r, Math.min(60000, 2000 * pollErrors)));
    }
  }
  console.log('[bot] poll loop stopped');
}

export function start() {
  if (!loadCreds()) {
    console.error('[bot] missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID — bot disabled');
    return;
  }
  console.log(`[bot] starting (chat ${CHAT_ID})`);
  pollLoop().catch((e) => console.error('[bot] poll loop crashed:', e.message));
}

export function stop() { stopped = true; }

// Crash-safety: a bug in a command handler must not bring the bot down.
process.on('uncaughtException', (err) => {
  console.error('[bot] UNCAUGHT:', err.message, err.stack);
  // Don't exit — let the LaunchAgent / watchdog decide
});
process.on('unhandledRejection', (err) => {
  console.error('[bot] UNHANDLED:', err?.message || err);
});

// Standalone-entry: when invoked directly (LaunchAgent), bootstrap and run.
// When imported from webui/server.js (legacy in-process mode), do nothing —
// the caller is responsible for invoking start().
if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
