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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_DIR = join(__dirname, '..', '..');
const CONFIG_FILE = join(REPO_DIR, 'src', 'state', 'runtime-config.json');
const HEARTBEAT_FILE = join(REPO_DIR, 'src', 'state', 'cloud-heartbeat.json');
const DRAWINGS_FILE = join(REPO_DIR, 'src', 'state', 'drawings.json');
const SESSION_FILE = join(REPO_DIR, 'src', 'state', 'session.json');
const STDOUT_LOG = '/Users/jqvier/Library/Logs/trading-alerts/stdout.log';
// Multiple candidate locations — first found wins. Mac uses ~/.config,
// VPS uses /home/octave/.config. Also we honor env vars set by systemd's
// EnvironmentFile, which is the primary delivery mechanism on Linux.
const ENV_FILE_CANDIDATES = [
  process.env.OCTAVE_ENV_FILE,
  '/Users/jqvier/.config/trading-alerts/.env',
  '/home/octave/.config/trading-alerts/.env',
  process.env.HOME ? `${process.env.HOME}/.config/trading-alerts/.env` : null,
].filter(Boolean);

const STRATEGY_KEYS = ['USLS', 'ICT-SMC', 'ALGO-SMC', 'ADAPTIVE', 'ICT', 'SMT', 'TRINITY', 'AMN', 'TORI', 'WARRIOR'];
const STRATEGY_NUM = { USLS: 1, 'ICT-SMC': 2, 'ALGO-SMC': 3, ADAPTIVE: 4, ICT: 5, SMT: 6, TRINITY: 7, AMN: 8, TORI: 9, WARRIOR: 10 };
const NUM_TO_KEY = Object.fromEntries(Object.entries(STRATEGY_NUM).map(([k, v]) => [v, k]));

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
\`/price\` — spot + futures gold

📊 *Status*
\`/status\` — overall health
\`/health\` — per-service detail
\`/session\` — current trading session

📜 *History*
\`/today\` — alerts from today (NY time)
\`/yesterday\` — alerts from yesterday
\`/history [N]\` — last N alerts (default 10)
\`/range HH:MM-HH:MM\` — alerts in NY time window today
\`/last\` — most recent alert

🎚 *Strategies*
\`/strategies\` — list all 10 with on/off state
\`/enable <num>\` — turn on (e.g. \`/enable 5\`)
\`/disable <num>\` — turn off

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

async function cmdStatus() {
  const cfg = loadConfig();
  const drawings = readJson(DRAWINGS_FILE, { setups: {} });
  const session = readJson(SESSION_FILE, { lastSession: null });
  const pid = await servicePid();

  const onNums = cfg?.strategies
    ? Object.entries(cfg.strategies).filter(([, v]) => v).map(([k]) => `#${STRATEGY_NUM[k]}`).sort().join(' ')
    : '(none)';

  const muteMin = cfg?.mute?.untilMs && cfg.mute.untilMs > Date.now()
    ? Math.round((cfg.mute.untilMs - Date.now()) / 60000) : 0;

  // Lead with what matters: are we alerting? Then context.
  const alerting = !muteMin && pid;
  const headline = alerting
    ? '🟢 *Octave is live and watching*'
    : muteMin > 0
      ? `🔕 *Muted for ${muteMin}m*`
      : '🔴 *Octave is offline*';

  await send([
    headline,
    '',
    `Active strategies: ${onNums}`,
    `Mode: \`${cfg?.mode || 'auto'}\`  ·  Session: *${(session.lastSession || 'closed').toUpperCase()}*`,
    `${Object.keys(drawings.setups || {}).length} setups being tracked`,
    '',
    `Send /bias for current direction · /health for service detail`,
  ].join('\n'));
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
  // Fetch BOTH spot (XAUUSD=X, matches TradingView OANDA:XAUUSD ~$1-2 diff)
  // AND futures (GC=F, what most strategies actually evaluate on). The user
  // sees both with delta — no more "your price doesn't match my chart."
  let spot = null, futures = null;
  try {
    const [spotRes, futRes] = await Promise.all([
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD%3DX?interval=1m&range=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } }),
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1m&range=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } }),
    ]);
    const spotData = await spotRes.json().catch(() => null);
    const futData = await futRes.json().catch(() => null);
    const spotMeta = spotData?.chart?.result?.[0]?.meta;
    const futMeta = futData?.chart?.result?.[0]?.meta;
    if (spotMeta) spot = { price: spotMeta.regularMarketPrice, change: spotMeta.regularMarketPrice - spotMeta.chartPreviousClose, time: spotMeta.regularMarketTime };
    if (futMeta)  futures = { price: futMeta.regularMarketPrice, change: futMeta.regularMarketPrice - futMeta.chartPreviousClose, time: futMeta.regularMarketTime };
  } catch {}

  if (!spot && !futures) {
    // Fall back to the heartbeat snapshot
    const hb = readJson(HEARTBEAT_FILE, null);
    if (!hb?.anchor) { await send('💰 No price data available.'); return; }
    await send(`💰 *Gold* (futures, cached)\n*$${hb.anchor.close}* · ${hb.anchor.tf}m bar`);
    return;
  }

  const sign = (n) => n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
  const lines = ['💰 *Gold*', ''];
  if (spot) {
    lines.push(`*Spot (XAU/USD)*: *$${spot.price.toFixed(2)}*  _${sign(spot.change)} today_`);
    lines.push('  → matches TradingView \\`OANDA:XAUUSD\\`');
  }
  if (futures) {
    lines.push('');
    lines.push(`*Futures (GC1!)*: *$${futures.price.toFixed(2)}*  _${sign(futures.change)} today_`);
    lines.push('  → matches TradingView \\`COMEX:GC1!\\` (strategies use this)');
  }
  if (spot && futures) {
    const basis = futures.price - spot.price;
    lines.push('');
    lines.push(`Basis (futures − spot): *${sign(basis)}*`);
  }
  await send(lines.join('\n'));
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
  for (const k of STRATEGY_KEYS) {
    const on = !!cfg.strategies[k];
    const icon = on ? '🟢' : '⚫';
    lines.push(`${icon} \`#${STRATEGY_NUM[k]}\` ${k}`);
  }
  lines.push('', 'Use `/enable <num>` or `/disable <num>` to toggle.');
  await send(lines.join('\n'));
}

function resolveStrategy(arg) {
  if (!arg) return null;
  const trimmed = String(arg).trim().toUpperCase().replace(/^#/, '');
  const num = parseInt(trimmed, 10);
  if (Number.isFinite(num) && NUM_TO_KEY[num]) return NUM_TO_KEY[num];
  // Try name match
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

async function cmdHealth() {
  const beats = readAllBeats();
  const services = ['signal-engine', 'bot', 'webui', 'watchdog', 'market-data'];
  const lines = ['🩺 *Octave Health*', ''];
  for (const s of services) {
    const b = beats[s];
    if (!b) {
      lines.push(`🔴 ${s}: no heartbeat`);
      continue;
    }
    const ageS = Math.round((Date.now() - b.at) / 1000);
    const stale = isStale(s, b);
    const icon = stale ? '🟠' : '🟢';
    lines.push(`${icon} ${s}: ${ageS}s ago · pid ${b.pid} · ${b.mem_mb || '?'}MB · up ${Math.round((b.uptime_s || 0) / 60)}m`);
  }

  // Also fetch local + cloud snapshot
  const cfg = loadConfig();
  const hb = readJson(HEARTBEAT_FILE, null);
  lines.push('');
  if (hb?.lastTick) {
    const age = Math.round((Date.now() - hb.lastTick) / 1000);
    lines.push(`☁️ Cloud tick: ${age}s ago · status \`${hb.status}\``);
  } else {
    lines.push(`☁️ Cloud: no heartbeat — run \`/cloud diagnose\``);
  }
  lines.push(`🎚 Mode: \`${cfg?.mode || '?'}\``);
  await send(lines.join('\n'));
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
  // Resolve from the module-level REPO_DIR (computed from __dirname so it's
  // correct on Mac /Users/jqvier/... AND VPS /home/octave/...)
  const script = join(REPO_DIR, 'scripts', 'run-detect-child.js');
  if (!existsSync(script)) return { error: 'detect runner script not found at ' + script };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: REPO_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '', result = null;
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith('RESULT:')) {
          try { result = JSON.parse(line.slice(7)); } catch {}
        }
      }
    });
    child.stderr.on('data', (d) => console.error('[detect-child]', d.toString().trim()));
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 30_000);
    child.on('exit', () => { clearTimeout(kill); resolve(result || { error: 'no result' }); });
    child.on('error', (e) => { clearTimeout(kill); resolve({ error: e.message }); });
  });
}

async function cmdBias() {
  await send('🧭 Computing market bias…');
  const r = await runDetectChild();
  if (r.error) { await send(`⚠️ ${r.error}`); return; }

  // Score each result: triggered=3, near_trigger=2, forming=1, invalidated=-0.5
  const STATUS_WT = { triggered: 3, near_trigger: 2, forming: 1, invalidated: -0.5 };
  let longScore = 0, shortScore = 0;
  const longSetups = [], shortSetups = [];
  for (const x of r.results || []) {
    if (!x.direction || x.direction === 'NONE') continue;
    const w = (STATUS_WT[x.status] || 0) * (x.confidence || 0.5);
    if (x.direction === 'LONG')  { longScore  += w; longSetups.push(x); }
    if (x.direction === 'SHORT') { shortScore += w; shortSetups.push(x); }
  }

  const total = longScore + shortScore;
  let biasIcon, biasWord, biasPct;
  if (total < 0.5) {
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

  const lines = [`${biasIcon} *${biasWord}* bias (${biasPct})`, ''];
  if (longSetups.length) {
    lines.push(`🟢 *LONG signals* (${longSetups.length}):`);
    for (const s of longSetups.slice(0, 5)) {
      lines.push(`  · #${STRATEGY_NUM[s.strategy] || '?'} ${s.strategy} — ${s.status} (${Math.round((s.confidence||0)*100)}%)`);
    }
  }
  if (shortSetups.length) {
    lines.push('');
    lines.push(`🔴 *SHORT signals* (${shortSetups.length}):`);
    for (const s of shortSetups.slice(0, 5)) {
      lines.push(`  · #${STRATEGY_NUM[s.strategy] || '?'} ${s.strategy} — ${s.status} (${Math.round((s.confidence||0)*100)}%)`);
    }
  }
  if (!longSetups.length && !shortSetups.length) {
    lines.push('No directional signals from any strategy right now. Market is quiet — wait for setup development.');
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

function buildMainMenuView() {
  const cfg = loadConfig() || {};
  const hb = readJson(HEARTBEAT_FILE, null);
  const session = readJson(SESSION_FILE, { lastSession: null });
  const onCount = cfg.strategies ? Object.values(cfg.strategies).filter(Boolean).length : 0;
  const onNums = cfg.strategies
    ? Object.entries(cfg.strategies).filter(([, v]) => v).map(([k]) => `#${STRATEGY_NUM[k]}`).sort().join(' ')
    : '(none)';
  let cloudLine = '🔴 no heartbeat';
  if (hb?.lastTick) {
    const ageMin = Math.round((Date.now() - hb.lastTick) / 60000);
    if (ageMin < 8 && hb.status === 'ok') cloudLine = `🟢 ${ageMin}m ago`;
    else if (hb.status === 'skipped-mode-local') cloudLine = `⚪ idle (mode=local)`;
    else if (hb.status === 'skipped-muted') cloudLine = `🔕 muted`;
    else cloudLine = `🟠 ${ageMin}m stale`;
  }
  const muteSec = cfg.mute?.untilMs && cfg.mute.untilMs > Date.now()
    ? Math.round((cfg.mute.untilMs - Date.now()) / 1000) : 0;
  const muteLine = muteSec > 0 ? `🔕 ${Math.round(muteSec / 60)}m left` : `🔔 live`;

  const text = [
    '🎵 *Octave Control Panel*',
    '',
    `🎚 Mode: \`${cfg.mode || 'auto'}\``,
    `🟢 Enabled: ${onNums} (${onCount}/7)`,
    `🔔 Alerts: ${muteLine}`,
    `☁️ Cloud: ${cloudLine}`,
    `🌍 Session: \`${(session.lastSession || '—').toUpperCase()}\``,
  ].join('\n');

  const keyboard = [
    [
      { text: '🎚 Mode', callback_data: 'view:mode' },
      { text: '🎛 Strategies', callback_data: 'view:strategies' },
    ],
    [
      { text: '🔕 Mute', callback_data: 'view:mute' },
      { text: '📊 Status', callback_data: 'act:status' },
    ],
    [
      { text: '📜 Today', callback_data: 'act:today' },
      { text: '🔔 Last alert', callback_data: 'act:last' },
    ],
    [
      { text: '☁️ Cloud', callback_data: 'act:cloud' },
      { text: '💻 Local', callback_data: 'act:local' },
    ],
    [
      { text: '🔄 Refresh', callback_data: 'view:main' },
      { text: '🚨 System', callback_data: 'view:system' },
    ],
  ];
  return { text, keyboard };
}

function buildModeView() {
  const cfg = loadConfig() || {};
  const cur = cfg.mode || 'auto';
  const mark = (m) => m === cur ? '✅ ' : '   ';
  const text = [
    '🎚 *Mode*',
    '',
    `Current: \`${cur}\``,
    '',
    '_auto_  — cloud-primary, local-fallback',
    '_cloud_ — only cloud sends Telegram',
    '_local_ — only local sends Telegram',
  ].join('\n');
  const keyboard = [
    [
      { text: `${mark('auto')}Auto`, callback_data: 'mode:auto' },
      { text: `${mark('cloud')}Cloud`, callback_data: 'mode:cloud' },
      { text: `${mark('local')}Local`, callback_data: 'mode:local' },
    ],
    [{ text: '« Back', callback_data: 'view:main' }],
  ];
  return { text, keyboard };
}

function buildStrategiesView() {
  const cfg = loadConfig() || { strategies: {} };
  const text = [
    '🎛 *Strategies*',
    '',
    'Tap any strategy to toggle on/off.',
    'State syncs to GitHub for the cloud tick.',
  ].join('\n');
  const keyboard = STRATEGY_KEYS.map((k) => {
    const on = !!cfg.strategies[k];
    return [{
      text: `${on ? '🟢' : '⚫'} #${STRATEGY_NUM[k]} ${k}`,
      callback_data: `strat:${k}`,
    }];
  });
  keyboard.push([{ text: '« Back', callback_data: 'view:main' }]);
  return { text, keyboard };
}

function buildMuteView() {
  const cfg = loadConfig() || {};
  const sec = cfg.mute?.untilMs && cfg.mute.untilMs > Date.now()
    ? Math.round((cfg.mute.untilMs - Date.now()) / 1000) : 0;
  const text = sec > 0
    ? `🔕 *Muted* — ${Math.round(sec / 60)}m remaining\n\nUntil: \`${nyHourMinute(cfg.mute.untilMs)}\` NY`
    : '🔔 *Alerts are live*\n\nMute pauses ALL alerts (local + cloud).';
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

function buildSystemView() {
  const text = [
    '🚨 *System Actions*',
    '',
    'Restart kickstarts the local LaunchAgent.',
    'Shutdown stops EVERYTHING (alerts, TV, caffeinate, bot itself).',
  ].join('\n');
  const keyboard = [
    [{ text: '🔄 Restart local service', callback_data: 'act:restart' }],
    [{ text: '⏸ Shutdown ALL', callback_data: 'act:shutdown-confirm' }],
    [{ text: '« Back', callback_data: 'view:main' }],
  ];
  return { text, keyboard };
}

async function cmdMenu() {
  const v = buildMainMenuView();
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
      if (arg === 'main') v = buildMainMenuView();
      else if (arg === 'mode') v = buildModeView();
      else if (arg === 'strategies') v = buildStrategiesView();
      else if (arg === 'mute') v = buildMuteView();
      else if (arg === 'system') v = buildSystemView();
      if (v) {
        await editMessage(chatId, messageId, v.text, { keyboard: v.keyboard });
        await answerCallback(cq.id);
      } else {
        await answerCallback(cq.id, 'unknown view');
      }
      return;
    }

    if (kind === 'mode') {
      if (!['auto', 'cloud', 'local'].includes(arg)) return answerCallback(cq.id, 'invalid');
      await saveConfigAndPush((c) => { c.mode = arg; return c; });
      const v = buildModeView();
      await editMessage(chatId, messageId, v.text, { keyboard: v.keyboard });
      await answerCallback(cq.id, `Mode → ${arg}`);
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

    if (kind === 'act') {
      if (arg === 'status') { await cmdStatus(); return answerCallback(cq.id); }
      if (arg === 'today')  { await cmdToday();  return answerCallback(cq.id); }
      if (arg === 'last')   { await cmdLast();   return answerCallback(cq.id); }
      if (arg === 'cloud')  { await cmdHealth(); return answerCallback(cq.id); }
      if (arg === 'local')  { await cmdHealth(); return answerCallback(cq.id); }
      if (arg === 'restart') { await cmdRestart(); return answerCallback(cq.id, 'Restarting…'); }
      if (arg === 'shutdown-confirm') {
        // Two-tap confirm: turn into a confirm button row
        const text = '⚠️ *Confirm Shutdown*\n\nThis will stop EVERYTHING:\n• Alerts service\n• Caffeinate\n• TradingView\n• Claude Code\n• Web UI + Bot\n\nClick the Octave icon to restart.';
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
  '/mode': cmdMode,
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
};

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
