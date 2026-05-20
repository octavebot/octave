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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_DIR = join(__dirname, '..', '..');
const CONFIG_FILE = join(REPO_DIR, 'src', 'state', 'runtime-config.json');
const HEARTBEAT_FILE = join(REPO_DIR, 'src', 'state', 'cloud-heartbeat.json');
const DRAWINGS_FILE = join(REPO_DIR, 'src', 'state', 'drawings.json');
const SESSION_FILE = join(REPO_DIR, 'src', 'state', 'session.json');
const STDOUT_LOG = '/Users/jqvier/Library/Logs/trading-alerts/stdout.log';
const ENV_FILE = '/Users/jqvier/.config/trading-alerts/.env';

const STRATEGY_KEYS = ['USLS', 'ICT-SMC', 'ALGO-SMC', 'ADAPTIVE', 'ICT', 'SMT', 'TRINITY'];
const STRATEGY_NUM = { USLS: 1, 'ICT-SMC': 2, 'ALGO-SMC': 3, ADAPTIVE: 4, ICT: 5, SMT: 6, TRINITY: 7 };
const NUM_TO_KEY = Object.fromEntries(Object.entries(STRATEGY_NUM).map(([k, v]) => [v, k]));

let TOKEN = '', CHAT_ID = '';
function loadCreds() {
  if (!existsSync(ENV_FILE)) return false;
  const env = Object.fromEntries(
    readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => l.split('=', 2))
  );
  TOKEN = env.TELEGRAM_BOT_TOKEN || '';
  CHAT_ID = env.TELEGRAM_CHAT_ID || '';
  return !!(TOKEN && CHAT_ID);
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
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID, text,
      parse_mode: opts.html ? 'HTML' : 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[bot] sendMessage non-2xx:', res.status, body.slice(0, 200));
  }
}

// ---------- runtime config helpers ----------

function loadConfig() {
  return readJson(CONFIG_FILE, null);
}

async function saveConfigAndPush(updater) {
  const cur = loadConfig() || {};
  const next = updater(JSON.parse(JSON.stringify(cur)));
  next.lastUpdated = Date.now();
  writeJsonAtomic(CONFIG_FILE, next);
  // Background push to GitHub so cloud picks up the change
  spawn('/bin/sh', ['-c', `
    cd "${REPO_DIR}" && \
    git add src/state/runtime-config.json && \
    git diff --cached --quiet || (
      git commit -m "octave: bot-update $(date -u +%FT%TZ)" >/dev/null 2>&1 && \
      git pull --rebase --autostash --quiet 2>/dev/null && \
      git push --quiet 2>/dev/null
    )
  `], { detached: true, stdio: 'ignore' }).unref();
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

📊 *Status*
\`/status\` — overall health
\`/cloud\` — cloud (GitHub Actions) state
\`/local\` — local Mac service state
\`/session\` — current trading session
\`/price\` — current gold price

📜 *History*
\`/today\` — alerts from today (NY time)
\`/yesterday\` — alerts from yesterday
\`/history [N]\` — last N alerts (default 10, max 50)
\`/range HH:MM-HH:MM\` — today's alerts in NY time range
\`/last\` — most recent alert with details

🎚 *Strategies*
\`/strategies\` — list all 7 with on/off state
\`/enable <num>\` — turn on (e.g. \`/enable 5\`)
\`/disable <num>\` — turn off (e.g. \`/disable 2\`)

⚙️ *Settings*
\`/mode\` — show current mode
\`/mode auto|cloud|local\` — change mode
\`/mute <minutes>\` — pause all alerts (max 1440 = 24h)
\`/unmute\` — resume alerts

🚨 *System*
\`/version\` — current git commit
\`/restart\` — restart local service
\`/shutdown confirm\` — stop everything

Tip: send \`/help\` anytime to see this menu again.`;

async function cmdHelp() {
  await send(HELP_TEXT);
}

async function cmdStatus() {
  const cfg = loadConfig();
  const hb = readJson(HEARTBEAT_FILE, null);
  const drawings = readJson(DRAWINGS_FILE, { setups: {} });
  const session = readJson(SESSION_FILE, { lastSession: null });
  const pid = await servicePid();

  let cloudLine = '🔴 No heartbeat';
  if (hb?.lastTick) {
    const ageMin = Math.round((Date.now() - hb.lastTick) / 60000);
    if (ageMin < 8 && hb.status === 'ok') cloudLine = `🟢 Online (${ageMin}m ago)`;
    else if (hb.status === 'skipped-mode-local') cloudLine = `⚪ Idle (mode=local, ${ageMin}m ago)`;
    else if (hb.status === 'skipped-muted') cloudLine = `🔕 Muted (${ageMin}m ago)`;
    else cloudLine = `🟠 Stale (${ageMin}m ago)`;
  }

  const onCount = cfg?.strategies ? Object.values(cfg.strategies).filter(Boolean).length : 0;
  const onNums = cfg?.strategies
    ? Object.entries(cfg.strategies).filter(([, v]) => v).map(([k]) => `#${STRATEGY_NUM[k]}`).sort().join(' ')
    : '(none)';

  const muteSec = cfg?.mute?.untilMs && cfg.mute.untilMs > Date.now()
    ? Math.round((cfg.mute.untilMs - Date.now()) / 1000) : 0;

  const lines = [
    '🎵 *Octave Status*',
    '',
    `🎚 Mode: \`${cfg?.mode || '?'}\``,
    `🟢 Enabled: ${onNums} (${onCount}/7)`,
    muteSec > 0 ? `🔕 Muted for ${Math.round(muteSec / 60)}m` : `🔔 Alerts: live`,
    '',
    `☁️ Cloud: ${cloudLine}`,
    `💻 Local: ${pid ? `🟢 PID ${pid}` : '🔴 stopped'}`,
    `📊 Active setups: ${Object.keys(drawings.setups || {}).length}`,
    `🌍 Session: \`${(session.lastSession || '—').toUpperCase()}\``,
  ];
  await send(lines.join('\n'));
}

async function cmdCloud() {
  const hb = readJson(HEARTBEAT_FILE, null);
  if (!hb) { await send('☁️ No cloud heartbeat found.'); return; }
  const ageSec = Math.round((Date.now() - (hb.lastTick || 0)) / 1000);
  const lines = [
    '☁️ *Cloud (GitHub Actions)*',
    `Last tick: ${ageSec}s ago`,
    `Status: \`${hb.status}\``,
    `Fired this tick: ${hb.fired ?? 0}`,
    `Panes: ${hb.pane_count ?? '?'}`,
    `Anchor: \`${hb.anchor?.symbol || '?'}\` ${hb.anchor?.tf || ''}m @ ${hb.anchor?.close ?? '?'}`,
    '',
    'Panes summary:',
    '`' + (hb.panes_summary || []).join('`, `') + '`',
  ];
  await send(lines.join('\n'));
}

async function cmdLocal() {
  const pid = await servicePid();
  if (!pid) { await send('💻 Local service: 🔴 *stopped*'); return; }
  const ps = await exec('/bin/ps', ['-p', String(pid), '-o', 'etime=,rss=']);
  const [etime, rssKb] = (ps.code === 0 ? ps.out : '').trim().split(/\s+/);
  const drawings = readJson(DRAWINGS_FILE, { setups: {} });
  await send([
    '💻 *Local Service*',
    `PID: \`${pid}\``,
    `Uptime: \`${etime || '?'}\``,
    `Memory: ${rssKb ? Math.round(+rssKb / 1024) + ' MB' : '?'}`,
    `Tracked setups: ${Object.keys(drawings.setups || {}).length}`,
  ].join('\n'));
}

async function cmdSession() {
  const session = readJson(SESSION_FILE, { lastSession: null });
  const hb = readJson(HEARTBEAT_FILE, null);
  const nyTime = nyHourMinute(Date.now());
  await send([
    '🌍 *Session*',
    `Current: \`${(session.lastSession || '—').toUpperCase()}\``,
    `NY time: \`${nyTime}\``,
    hb?.anchor ? `Last gold close: *${hb.anchor.close}* (${hb.anchor.tf}m bar)` : '',
  ].filter(Boolean).join('\n'));
}

async function cmdPrice() {
  const hb = readJson(HEARTBEAT_FILE, null);
  if (!hb?.anchor) { await send('💰 No price data available yet.'); return; }
  const ageMin = Math.round((Date.now() - (hb.anchor.time || 0) * 1000) / 60000);
  await send([
    '💰 *Gold Price*',
    `\`${hb.anchor.symbol}\`: *$${hb.anchor.close}*`,
    `Bar timeframe: ${hb.anchor.tf}m`,
    `Bar age: ${ageMin}m`,
    `Source: cloud heartbeat (${Math.round((Date.now() - hb.lastTick) / 1000)}s ago)`,
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

async function cmdShutdown(arg) {
  if (arg !== 'confirm') {
    await send('⚠️ Use `/shutdown confirm` to actually stop everything.\n\nThis will:\n• Stop the alerts service\n• Stop caffeinate (Mac can sleep)\n• Quit TradingView\n• Kill Claude Code\n• Stop the web UI / bot');
    return;
  }
  await send('⏸ Shutting down…');
  spawn('/Users/jqvier/Desktop/Octave.app/Contents/MacOS/octave', ['shutdown'], { detached: true, stdio: 'ignore' }).unref();
}

// ---------- dispatch ----------

const COMMANDS = {
  '/start': cmdHelp,
  '/help': cmdHelp,
  '/status': cmdStatus,
  '/cloud': cmdCloud,
  '/local': cmdLocal,
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
  '/restart': cmdRestart,
  '/shutdown': cmdShutdown,
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
  while (!stopped) {
    try {
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
        handleUpdate(u).catch((e) => console.error('[bot] handleUpdate threw:', e.message));
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
