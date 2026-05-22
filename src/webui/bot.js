/**
 * Telegram bot — Octave control surface.
 *
 * Long-polls Telegram, dispatches commands, handles inline-keyboard taps,
 * and falls back to AI chat for free-form text. Runs as its own LaunchAgent
 * so a handler bug can't take down the dashboard.
 *
 * Crash safety: uncaughtException is swallowed so a thrown handler doesn't
 * exit the process. SIGTERM is honored immediately so `launchctl kickstart -k`
 * never overlaps two pollers (the previous design held SIGTERM until the
 * 25s long-poll returned, causing 409 conflicts on restart).
 */

import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { beat as heartbeat, startHeartbeat, readAllBeats, isStale } from '../lib/heartbeat.js';
import { sessionLabel } from '../lib/trade_log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_DIR = join(__dirname, '..', '..');
const STATE_DIR = join(REPO_DIR, 'src', 'state');
const CONFIG_FILE = join(STATE_DIR, 'runtime-config.json');
const HEARTBEAT_FILE = join(STATE_DIR, 'cloud-heartbeat.json');
const DRAWINGS_FILE = join(STATE_DIR, 'drawings.json');
const SESSION_FILE = join(STATE_DIR, 'session.json');
const TRADE_LOG = join(STATE_DIR, 'trades.jsonl');

// Resolve the signal-engine log: Mac under ~/Library/Logs, VPS under ~/.octave-logs.
const STDOUT_LOG_CANDIDATES = [
  '/Users/jqvier/Library/Logs/trading-alerts/stdout.log',
  '/home/octave/.octave-logs/signal-engine.log',
  process.env.HOME ? `${process.env.HOME}/.octave-logs/signal-engine.log` : null,
].filter(Boolean);
const STDOUT_LOG = STDOUT_LOG_CANDIDATES.find(existsSync) || STDOUT_LOG_CANDIDATES[0];

const ENV_FILE_CANDIDATES = [
  process.env.OCTAVE_ENV_FILE,
  '/Users/jqvier/.config/trading-alerts/.env',
  '/home/octave/.config/trading-alerts/.env',
  process.env.HOME ? `${process.env.HOME}/.config/trading-alerts/.env` : null,
].filter(Boolean);

// ─── STRATEGY REGISTRY ───────────────────────────────────────────────────
// Single source of truth. Number → key bidirectional; display order matches.

const STRATEGIES = [
  { num:  '1', key: 'USLS',     name: 'USLS — Session Sweep' },
  { num:  '2', key: 'ICT-SMC',  name: 'ICT/SMC — HTF Judas' },
  { num:  '3', key: 'ALGO-SMC', name: 'ALGO/SMC — 71% Fib' },
  { num:  '4', key: 'ADAPTIVE', name: 'Adaptive Matrix' },
  { num:  '5', key: 'ICT',      name: 'ICT Killzone' },
  { num:  '6', key: 'SMT',      name: 'Gold/Silver SMT' },
  { num:  '7', key: 'TRINITY',  name: 'Trinity Model' },
  { num:  '8', key: 'AMN',      name: 'AMN Dual-Model' },
  { num:  '9', key: 'TORI',     name: 'TORI · 4H Trendline' },
  { num: '10', key: 'WARRIOR',  name: 'Warrior Momentum' },
];
const NUM_TO_KEY = Object.fromEntries(STRATEGIES.map((s) => [s.num, s.key]));
const KEY_TO_NUM = Object.fromEntries(STRATEGIES.map((s) => [s.key, s.num]));
const KEY_TO_NAME = Object.fromEntries(STRATEGIES.map((s) => [s.key, s.name]));
const ALL_KEYS = STRATEGIES.map((s) => s.key);

// ─── CREDENTIALS ─────────────────────────────────────────────────────────

let TOKEN = '', CHAT_ID = '';
function loadCreds() {
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    return true;
  }
  for (const p of ENV_FILE_CANDIDATES) {
    if (!existsSync(p)) continue;
    try {
      const env = Object.fromEntries(
        readFileSync(p, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => l.split('=', 2))
      );
      if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        TOKEN = env.TELEGRAM_BOT_TOKEN; CHAT_ID = env.TELEGRAM_CHAT_ID; return true;
      }
    } catch {}
  }
  return false;
}

// ─── TELEGRAM TRANSPORT ──────────────────────────────────────────────────

function tgEscape(s) {
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
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((err) => ({ ok: false, status: 0, text: async () => err.message }));
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[bot] sendMessage', res.status, body.slice(0, 200));
  }
  return res;
}

async function editMessage(chatId, messageId, text, opts = {}) {
  const body = {
    chat_id: chatId, message_id: messageId, text,
    parse_mode: opts.html ? 'HTML' : 'Markdown',
    disable_web_page_preview: true,
  };
  if (opts.keyboard) body.reply_markup = { inline_keyboard: opts.keyboard };
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/editMessageText`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (res && !res.ok) {
    const t = await res.text().catch(() => '');
    if (!t.includes('not modified')) console.error('[bot] editMessage', res.status, t.slice(0, 200));
  }
}

async function ackCallback(callbackId, text = '') {
  await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: false }),
  }).catch(() => {});
}

// ─── STATE ACCESSORS ─────────────────────────────────────────────────────

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

function loadConfig() { return readJson(CONFIG_FILE, null); }

async function updateConfig(updater) {
  const cur = loadConfig() || {};
  const next = updater(JSON.parse(JSON.stringify(cur)));
  next.lastUpdated = Date.now();
  writeJsonAtomic(CONFIG_FILE, next);
  return next;
}

function nyDateKey(unixMs) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(unixMs)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function nyHHmm(unixMs) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(unixMs));
}

function readAlerts({ since = 0, until = Infinity, limit = 50 } = {}) {
  if (!existsSync(STDOUT_LOG)) return [];
  const text = readFileSync(STDOUT_LOG, 'utf8');
  const lines = text.split('\n');
  const out = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"alert fired"')) continue;
    try {
      const e = JSON.parse(lines[i]);
      const t = Date.parse(e.ts);
      if (!Number.isFinite(t) || t < since || t > until) continue;
      out.push({
        ts: e.ts, time: t, strategy: e.strategy, status: e.status,
        setupId: e.setupId, confidence: e.confidence, telegram: e.telegram,
      });
      if (out.length >= limit) break;
    } catch {}
  }
  return out;
}

async function exec(cmd, args) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => out += d.toString());
    p.stderr.on('data', (d) => err += d.toString());
    p.on('close', (code) => res({ code, out: out.trim(), err: err.trim() }));
    p.on('error', (e) => res({ code: 127, out: '', err: e.message }));
  });
}

async function servicePid() {
  const r = await exec('/usr/bin/pgrep', ['-f', 'trading-alerts/src/index.js']);
  return r.code === 0 ? r.out.split('\n')[0] : null;
}

function resolveStrategy(arg) {
  if (!arg) return null;
  const a = String(arg).trim().toUpperCase().replace(/^#/, '');
  const orig = String(arg).trim().replace(/^#/, '');
  if (NUM_TO_KEY[a]) return NUM_TO_KEY[a];
  if (ALL_KEYS.includes(a)) return a;
  try {
    const usPath = join(STATE_DIR, 'user-strategies.json');
    if (existsSync(usPath)) {
      const items = JSON.parse(readFileSync(usPath, 'utf8'))?.items || [];
      const hit = items.find((s) => s.id === orig || s.id.toLowerCase() === orig.toLowerCase());
      if (hit) return hit.id;
    }
  } catch {}
  return null;
}

function tokenize(s) {
  const out = []; const re = /"([^"]+)"|(\S+)/g; let m;
  while ((m = re.exec(s))) out.push(m[1] != null ? m[1] : m[2]);
  return out;
}

// ─── VISUAL PRIMITIVES ───────────────────────────────────────────────────
// Shared so every reply looks consistent. Don't write headers/dividers ad-hoc
// in handlers — use these.

const DIV = '━━━━━━━━━━━━━━━━━━';

function header(emoji, title, subtitle = '') {
  const head = `${emoji} *${title}*`;
  return subtitle ? `${head}\n${subtitle}` : head;
}

function section(label) { return `*${label}*`; }
function bullet(text) { return `  • ${text}`; }
function kv(key, value) { return `${key}: *${value}*`; }
function statusDot(state) {
  return { ok:'🟢', warn:'🟠', down:'🔴', off:'⚫', forming:'🟡', mute:'🔕' }[state] || '·';
}

// ─── COMMAND HANDLERS ────────────────────────────────────────────────────
// Grouped by use case. Keep each handler small. Push help text into HELP_*.

// ── Overview ──

async function cmdStatus() {
  const cfg = loadConfig();
  const session = readJson(SESSION_FILE, { lastSession: null });
  const pid = await servicePid();
  const enabled = cfg?.strategies ? Object.entries(cfg.strategies).filter(([, v]) => v).map(([k]) => k) : [];
  const muteMin = cfg?.mute?.untilMs && cfg.mute.untilMs > Date.now()
    ? Math.round((cfg.mute.untilMs - Date.now()) / 60000) : 0;

  let newsLine = '';
  try {
    const { checkBlackout, nextEvent } = await import('../lib/news.js');
    const bo = checkBlackout(Date.now() / 1000, 30);
    if (bo.blocked && bo.event) {
      newsLine = `📰 NEWS BLACKOUT · ${tgEscape(bo.event.title || 'high-impact event')} (${bo.minutesAway}m)`;
    } else {
      const nxt = nextEvent(Date.now() / 1000);
      if (nxt) newsLine = `📰 Next: ${tgEscape(nxt.title || '')} in ${nxt.minutesAway}m`;
    }
  } catch {}

  let setupCount = 0;
  try { const fu = await import('../lib/follow_up.js'); setupCount = fu.active().length; } catch {}

  const live = !muteMin && pid;
  const headLine = live ? '🟢 *Live · watching markets*'
    : muteMin > 0 ? `🔕 *Muted ${muteMin}m*`
    : '🔴 *Offline*';

  const sessLabel = (session.lastSession || 'closed').toUpperCase();
  const enabledList = enabled.length
    ? enabled.map((k) => `#${KEY_TO_NUM[k] || '?'} ${KEY_TO_NAME[k] || k}`)
    : ['_(no strategies enabled)_'];

  await send([
    headLine,
    `${sessLabel} session · ${setupCount} active setups · ${enabled.length}/${STRATEGIES.length} strategies on`,
    newsLine,
    '',
    section('Active strategies'),
    ...enabledList.map(bullet),
    '',
    '_/bias for direction · /health for service detail · /menu for buttons_',
  ].filter((l) => l !== '').join('\n'));
}

async function cmdHealth() {
  const beats = readAllBeats();
  const DISPLAY = {
    'signal-engine': 'Signal engine',
    'bot':           'Telegram bot',
    'webui':         'Dashboard',
    'watchdog':      'Watchdog',
    'market-data':   'Market data',
  };
  const lines = [];
  let allGreen = true;
  for (const [key, label] of Object.entries(DISPLAY)) {
    const b = beats[key];
    if (!b) { lines.push(`${statusDot('down')} ${label} · not reporting`); allGreen = false; continue; }
    const ageS = Math.round((Date.now() - b.at) / 1000);
    if (isStale(key, b)) {
      lines.push(`${statusDot('warn')} ${label} · stale ${ageS}s`); allGreen = false;
    } else {
      const mem = b.mem_mb ? ` · ${b.mem_mb} MB` : '';
      const up = b.uptime_s ? ` · up ${Math.round(b.uptime_s / 60)}m` : '';
      lines.push(`${statusDot('ok')} ${label} · ${ageS}s ago${mem}${up}`);
    }
  }
  await send([
    header(allGreen ? '✅' : '⚠️', allGreen ? 'All systems normal' : 'Issues detected'),
    '',
    ...lines,
    '',
    '_/diagnose for self-heal scan · /fix <name> to repair_',
  ].join('\n'));
}

async function cmdPerf() {
  const lines = [header('⚡', 'Performance')];

  const loadR = await exec('/usr/bin/uptime', []);
  const lm = loadR.out.match(/load averages?:\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (lm) lines.push('', kv('CPU load', `${lm[1]} · ${lm[2]} · ${lm[3]} (1/5/15m)`));

  if (process.platform === 'linux') {
    try {
      const mi = readFileSync('/proc/meminfo', 'utf8');
      const total = +(mi.match(/MemTotal:\s+(\d+)/)?.[1] || 0) * 1024;
      const avail = +(mi.match(/MemAvailable:\s+(\d+)/)?.[1] || 0) * 1024;
      if (total > 0) {
        const usedGB = ((total - avail) / 1024 ** 3).toFixed(1);
        const totalGB = (total / 1024 ** 3).toFixed(1);
        lines.push(kv('RAM', `${usedGB} / ${totalGB} GB`));
      }
    } catch {}
  } else {
    const vmR = await exec('/usr/bin/vm_stat', []);
    const free = +(vmR.out.match(/Pages free:\s+(\d+)/)?.[1] || 0);
    const wired = +(vmR.out.match(/Pages wired down:\s+(\d+)/)?.[1] || 0);
    const active = +(vmR.out.match(/Pages active:\s+(\d+)/)?.[1] || 0);
    if (free + active + wired > 0) {
      const usedMB = Math.round((active + wired) * 4096 / 1024 ** 2);
      const freeMB = Math.round(free * 4096 / 1024 ** 2);
      lines.push(kv('RAM', `${usedMB} MB used · ${freeMB} MB free`));
    }
  }

  const dfR = await exec('/bin/df', ['-h', '/']);
  const dfLine = dfR.out.split('\n').filter((l) => l.trim() && !l.startsWith('Filesystem'))[0];
  if (dfLine) {
    const parts = dfLine.split(/\s+/);
    if (parts.length >= 5) lines.push(kv('Disk', `${parts[2]} / ${parts[1]} (${parts[4]})`));
  }

  lines.push('', section('Octave processes'));
  const beats = readAllBeats();
  const SVC = { 'signal-engine': 'Signal', 'bot': 'Bot', 'webui': 'Dashboard', 'watchdog': 'Watchdog' };
  let totalMb = 0;
  for (const [k, label] of Object.entries(SVC)) {
    const b = beats[k];
    if (b?.mem_mb) {
      lines.push(bullet(`${label}: ${b.mem_mb} MB · up ${Math.round((b.uptime_s || 0) / 60)}m`));
      totalMb += b.mem_mb;
    } else lines.push(bullet(`${label}: not reporting`));
  }
  lines.push(bullet(`Total: *${totalMb} MB*`));

  const md = beats['market-data'];
  if (md?.last_fetch_ms) {
    const age = Math.round((Date.now() - md.last_fetch_ms) / 1000);
    lines.push('', `Market data · last fetch ${age}s ago · ${md.pane_count || 0} panes`);
  }
  await send(lines.join('\n'));
}

async function cmdSession() {
  const session = readJson(SESSION_FILE, { lastSession: null });
  const hb = readJson(HEARTBEAT_FILE, null);
  const s = (session.lastSession || 'closed').toUpperCase();
  const open = s !== 'CLOSED' && s !== '—';
  await send([
    header(open ? '🟢' : '⚫', `${s} session`),
    `NY time: ${nyHHmm(Date.now())}`,
    hb?.anchor ? `Gold: $${Number(hb.anchor.close).toFixed(2)}` : '',
  ].filter(Boolean).join('\n'));
}

async function cmdPrice() {
  const INSTRUMENTS = [
    { sym: 'MGC1!', yh: 'MGC%3DF', label: 'Micro Gold' },
    { sym: 'MNQ1!', yh: 'MNQ%3DF', label: 'Micro Nasdaq' },
    { sym: 'MES1!', yh: 'MES%3DF', label: 'Micro S&P' },
  ];
  const sign = (n) => n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
  const fetches = await Promise.all(INSTRUMENTS.map(async (i) => {
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${i.yh}?interval=1m&range=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data = await res.json().catch(() => null);
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) return { ...i, ok: false };
      return { ...i, ok: true, price: meta.regularMarketPrice,
               change: meta.regularMarketPrice - meta.chartPreviousClose };
    } catch { return { ...i, ok: false }; }
  }));

  const lines = [header('💰', 'Live prices'), ''];
  for (const r of fetches) {
    if (!r.ok) { lines.push(`${r.label} \`${r.sym}\` · _no data_`); continue; }
    const pct = (r.change / (r.price - r.change)) * 100;
    const dot = r.change >= 0 ? '🟢' : '🔴';
    lines.push(`${dot} *${r.label}* \`${r.sym}\` · *$${r.price.toFixed(2)}* · ${sign(r.change)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`);
  }
  lines.push('', '_Source: Yahoo (tick-matches TradingView micro-futures)._');
  await send(lines.join('\n'));
}

// ── Alert history ──

function fmtAlert(a) {
  const t = nyHHmm(a.time);
  const conf = Number.isFinite(+a.confidence) ? `${Math.round(a.confidence * 100)}%` : '—';
  const num = KEY_TO_NUM[a.strategy] || '?';
  return `\`${t}\` · #${num} ${a.strategy} _${a.status}_ · ${conf}`;
}

async function cmdHistory(arg) {
  const n = Math.min(50, Math.max(1, parseInt(arg, 10) || 10));
  const alerts = readAlerts({ limit: n });
  if (alerts.length === 0) return send('📜 No alerts in the log yet.');
  await send([header('📜', `Last ${alerts.length} alerts`), '', ...alerts.map(fmtAlert)].join('\n'));
}

async function cmdToday() {
  const todayKey = nyDateKey(Date.now());
  const all = readAlerts({ limit: 500 });
  const day = all.filter((a) => nyDateKey(a.time) === todayKey);
  if (day.length === 0) return send(`📅 No alerts today (${todayKey} NY).`);
  const lines = [header('📅', `Today · ${todayKey}`, `${day.length} alerts`), ''];
  for (const a of day.slice(0, 30)) lines.push(fmtAlert(a));
  if (day.length > 30) lines.push(`_… ${day.length - 30} more_`);
  await send(lines.join('\n'));
}

async function cmdYesterday() {
  const yKey = nyDateKey(Date.now() - 24 * 3600 * 1000);
  const all = readAlerts({ limit: 500 });
  const day = all.filter((a) => nyDateKey(a.time) === yKey);
  if (day.length === 0) return send(`📅 No alerts yesterday (${yKey} NY).`);
  const lines = [header('📅', `Yesterday · ${yKey}`, `${day.length} alerts`), ''];
  for (const a of day.slice(0, 30)) lines.push(fmtAlert(a));
  if (day.length > 30) lines.push(`_… ${day.length - 30} more_`);
  await send(lines.join('\n'));
}

async function cmdRange(arg) {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(arg || '');
  if (!m) return send('Usage: `/range HH:MM-HH:MM` (NY time, e.g. `/range 09:30-11:00`)');
  const [, h1, m1, h2, m2] = m;
  const todayKey = nyDateKey(Date.now());
  const all = readAlerts({ limit: 500 });
  const startMin = +h1 * 60 + +m1, endMin = +h2 * 60 + +m2;
  const window = all.filter((a) => {
    if (nyDateKey(a.time) !== todayKey) return false;
    const [h, mm] = nyHHmm(a.time).split(':').map(Number);
    const t = h * 60 + mm;
    return t >= startMin && t < endMin;
  });
  if (window.length === 0) return send(`📅 No alerts in *${h1}:${m1}-${h2}:${m2}* NY today.`);
  await send([
    header('📅', `${h1}:${m1}-${h2}:${m2} NY today`, `${window.length} alerts`),
    '', ...window.slice(0, 30).map(fmtAlert),
  ].join('\n'));
}

async function cmdLast() {
  const a = readAlerts({ limit: 1 })[0];
  if (!a) return send('🔔 No alerts yet.');
  await send([
    header('🔔', 'Last alert'),
    kv('When', `${nyHHmm(a.time)} NY · ${nyDateKey(a.time)}`),
    kv('Strategy', `#${KEY_TO_NUM[a.strategy]} ${a.strategy}`),
    kv('Status', a.status),
    kv('Confidence', `${Math.round((a.confidence || 0) * 100)}%`),
    `Setup id: \`${a.setupId}\``,
    `Telegram: ${a.telegram || '?'}`,
  ].join('\n'));
}

async function cmdSummary(arg) {
  const days = Math.max(1, Math.min(30, parseInt(arg, 10) || 1));
  const sinceMs = Date.now() - days * 86_400_000;
  const alerts = readAlerts({ since: sinceMs, limit: 1000 });

  const byStrategy = {};
  let triggered = 0, near = 0, formed = 0;
  for (const a of alerts) {
    const s = (byStrategy[a.strategy] ||= { triggered: 0, near: 0, forming: 0, total: 0 });
    s.total++;
    if (a.status === 'triggered') { s.triggered++; triggered++; }
    else if (a.status === 'near_trigger') { s.near++; near++; }
    else if (a.status === 'forming') { s.forming++; formed++; }
  }

  const sessions = { Asian: 0, London: 0, 'NY-AM': 0, 'NY-PM': 0 };
  for (const a of alerts) {
    if (a.status !== 'triggered') continue;
    const sess = sessionLabel(Math.floor(a.time / 1000));
    if (sess in sessions) sessions[sess]++;
  }

  let trades = [];
  try {
    if (existsSync(TRADE_LOG)) {
      for (const ln of readFileSync(TRADE_LOG, 'utf8').split('\n').filter(Boolean)) {
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
    header('📊', days === 1 ? "Today's summary" : `${days}-day summary`),
    '',
    `Alerts: *${alerts.length}* · ${triggered} 🟢 triggered · ${near} 🟠 near · ${formed} 🟡 forming`,
  ];
  if (trades.length > 0) {
    const wr = ((wins / trades.length) * 100).toFixed(0);
    lines.push(`Trades: *${trades.length}* · ${wins}W / ${losses}L (${wr}%) · ${sumR >= 0 ? '+' : ''}${sumR.toFixed(2)}R`);
  }

  const ranked = Object.entries(byStrategy).sort((a, b) => b[1].total - a[1].total).slice(0, 7);
  if (ranked.length > 0) {
    lines.push('', section('By strategy'));
    for (const [name, s] of ranked) {
      lines.push(bullet(`#${KEY_TO_NUM[name] || '?'} ${name} · ${s.total} (${s.triggered}🟢/${s.near}🟠/${s.forming}🟡)`));
    }
  }
  const sessParts = Object.entries(sessions).filter(([, n]) => n > 0).map(([s, n]) => `${s} ${n}`);
  if (sessParts.length > 0) {
    lines.push('', section('Triggered by session'), bullet(sessParts.join(' · ')));
  }
  if (alerts.length === 0) lines.push('', '_Quiet window. No alerts in this period._');
  lines.push('', '_`/summary 7` for the week · `/summary 30` for the month_');
  await send(lines.join('\n'));
}

// ── Strategies ──

async function cmdStrategies() {
  const cfg = loadConfig() || { strategies: {} };
  const lines = [header('🎚', 'Strategies')];
  for (const s of STRATEGIES) {
    const on = !!cfg.strategies[s.key];
    lines.push(`${statusDot(on ? 'ok' : 'off')} \`#${s.num}\` ${tgEscape(s.name)}`);
  }
  // User-defined
  try {
    const us = await import('../lib/user_strategies.js');
    const items = us.list();
    if (items.length) {
      lines.push('', section('My strategies'));
      for (const it of items) {
        const on = cfg.strategies?.[it.id] !== false;
        lines.push(`${statusDot(on ? 'ok' : 'off')} \`${tgEscape(it.id)}\` ${tgEscape(it.name)}`);
      }
    }
  } catch {}
  lines.push('', '_Toggle: `/enable <num>` · `/disable <num>` (e.g. `/enable 5`)_');
  await send(lines.join('\n'));
}

async function cmdEnable(arg) {
  const k = resolveStrategy(arg);
  if (!k) return send('Usage: `/enable <num>` (1-10) or `/enable <key>` (e.g. `TRINITY`)');
  await updateConfig((c) => { c.strategies = c.strategies || {}; c.strategies[k] = true; return c; });
  await send(`${statusDot('ok')} *${k}* (\`#${KEY_TO_NUM[k] || 'U'}\`) → ENABLED`);
}

async function cmdDisable(arg) {
  const k = resolveStrategy(arg);
  if (!k) return send('Usage: `/disable <num>` (1-10) or `/disable <key>`');
  await updateConfig((c) => { c.strategies = c.strategies || {}; c.strategies[k] = false; return c; });
  await send(`${statusDot('off')} *${k}* (\`#${KEY_TO_NUM[k] || 'U'}\`) → disabled`);
}

// ── User strategies ──

async function cmdMyStrategies() {
  let items = [];
  try { const us = await import('../lib/user_strategies.js'); items = us.list(); } catch {}
  if (items.length === 0) {
    return send([
      header('👤', 'My strategies'),
      '',
      '_(none defined yet)_',
      '',
      'Create with: `/addstrategy <id> "<name>" <entry> [tf]`',
      'entry ∈ ema_cross · ema_pullback · bb_extreme · rsi_bounds',
      'Example: `/addstrategy my-ema 9/21 cross" ema_cross 15`',
      '',
      'Or upload a PDF/image and the AI will extract it.',
    ].join('\n'));
  }
  const cfg = loadConfig() || {};
  const lines = [header('👤', 'My strategies'), ''];
  for (const it of items) {
    const on = cfg.strategies?.[it.id] !== false;
    lines.push(`${statusDot(on ? 'ok' : 'off')} \`${tgEscape(it.id)}\` · ${tgEscape(it.name)}`);
    lines.push(`   ${tgEscape(it.entry)} @ ${it.timeframe}m · stop ${it.stop_atr_mult}× ATR · TP ${it.tp_r}R`);
  }
  lines.push('', '_Edit: `/editstrategy <id> key=value` · Delete: `/delstrategy <id>`_');
  await send(lines.join('\n'));
}

async function cmdAddStrategy(arg) {
  const parts = tokenize(arg || '');
  if (parts.length < 3) {
    return send([
      'Usage: `/addstrategy <id> "<name>" <entry> [tf]`',
      'entry: ema_cross · ema_pullback · bb_extreme · rsi_bounds',
      'Example: `/addstrategy my-cross "EMA Cross" ema_cross 15`',
    ].join('\n'));
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
    await updateConfig((c) => { c.strategies = c.strategies || {}; c.strategies[created.id] = true; return c; });
    await send(`✅ Created \`${tgEscape(created.id)}\` — ${tgEscape(created.name)}\nEnabled. Tune with \`/editstrategy ${created.id} key=value\`.`);
  } catch (err) { await send(`⚠️ ${err.message}`); }
}

async function cmdEditStrategy(arg) {
  const parts = tokenize(arg || '');
  if (parts.length < 2) {
    return send('Usage: `/editstrategy <id> key=value …`\nKeys: name, description, timeframe, direction, entry, fast, slow, rsi_min, rsi_max, stop_atr_mult, tp_r, enabled');
  }
  const id = parts[0];
  try {
    const us = await import('../lib/user_strategies.js');
    const cur = us.get(id);
    if (!cur) return send(`No strategy \`${tgEscape(id)}\`. See \`/mystrategies\`.`);
    const patch = { ...cur };
    for (const kv of parts.slice(1)) {
      const eq = kv.indexOf('='); if (eq < 0) continue;
      const k = kv.slice(0, eq).trim(); const v = kv.slice(eq + 1).trim();
      if (['fast', 'slow', 'rsi_min', 'rsi_max', 'stop_atr_mult', 'tp_r'].includes(k)) patch[k] = Number(v);
      else if (k === 'enabled') patch.enabled = (v === 'true' || v === '1' || v === 'on');
      else patch[k] = v;
    }
    const updated = us.update(id, patch);
    await updateConfig((c) => { c.strategies = c.strategies || {}; c.strategies[updated.id] = updated.enabled; return c; });
    await send(`✅ Updated \`${tgEscape(updated.id)}\``);
  } catch (err) { await send(`⚠️ ${err.message}`); }
}

async function cmdDelStrategy(arg) {
  const id = (arg || '').trim().replace(/^['"]|['"]$/g, '');
  if (!id) return send('Usage: `/delstrategy <id>`');
  try {
    const us = await import('../lib/user_strategies.js');
    us.remove(id);
    await updateConfig((c) => { c.strategies = c.strategies || {}; delete c.strategies[id]; return c; });
    await send(`🗑 Deleted \`${tgEscape(id)}\``);
  } catch (err) { await send(`⚠️ ${err.message}`); }
}

// ── Settings ──

async function cmd24h(arg) {
  const a = (arg || '').trim().toLowerCase();
  if (a !== 'on' && a !== 'off' && a !== '') return send('Usage: `/24h on` or `/24h off`');
  if (a === '') {
    const on = !!loadConfig()?.bypassKillzones;
    return send([
      header('🌐', `24/7 mode · ${on ? 'ON' : 'OFF'}`),
      '',
      on ? 'Strategies fire any hour (killzones disabled).' : 'Strategies require killzones (London 02-05 ET, NY 07-10 ET, Trinity 09:30-11 ET).',
      '',
      `Toggle: \`/24h ${on ? 'off' : 'on'}\``,
    ].join('\n'));
  }
  const on = a === 'on';
  await updateConfig((c) => { c.bypassKillzones = on; return c; });
  await send(on
    ? '🌐 *24/7 mode ON*\n\nStrategies fire any hour. Expect ~3-5× more alerts, lower average quality.'
    : '🎯 *24/7 mode OFF*\n\nKillzones enforced — higher quality, fewer alerts.');
}

async function cmdMute(arg) {
  const minutes = Math.min(1440, Math.max(1, parseInt(arg, 10) || 0));
  if (!minutes) return send('Usage: `/mute <minutes>` (1-1440)');
  const untilMs = Date.now() + minutes * 60 * 1000;
  await updateConfig((c) => { c.mute = { untilMs, reason: 'telegram /mute' }; return c; });
  await send(`🔕 Muted *${minutes}m*. Auto-unmute at \`${nyHHmm(untilMs)} NY\`.`);
}

async function cmdUnmute() {
  await updateConfig((c) => { c.mute = { untilMs: 0, reason: null }; return c; });
  await send('🔔 Alerts resumed.');
}

// ── Backtest ──

async function cmdBacktest(arg) {
  const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
  let strategyArg = null, days = 30;
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (Number.isFinite(n) && n > 0 && n <= 365) days = n;
    else strategyArg = p;
  }
  const strategy = strategyArg ? resolveStrategy(strategyArg) : null;
  if (strategyArg && !strategy) {
    return send(`Unknown strategy: \`${strategyArg}\`. Use \`/strategies\` to see names.`);
  }
  await send(`⏳ Running ${days}-day backtest${strategy ? ` for *${strategy}*` : ' for all enabled strategies'}…\n_Runs in isolated process; bot stays responsive._`);

  const args = ['scripts/run-backtest-child.js', '--days', String(days)];
  if (strategy) args.push('--strategy', strategy);
  const child = spawn(process.execPath, args, { cwd: REPO_DIR, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdoutBuf = '', stderrBuf = '', tgMessage = null, resultRow = null;
  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.startsWith('RESULT:')) { try { resultRow = JSON.parse(line.slice(7)); } catch {} }
      else if (line.startsWith('TG:')) { try { tgMessage = Buffer.from(line.slice(3), 'base64').toString('utf8'); } catch {} }
      else console.log('[backtest-child]', line);
    }
  });
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); console.error('[backtest-child]', d.toString().trim()); });

  const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 8 * 60 * 1000);

  child.on('exit', async (code, signal) => {
    clearTimeout(killTimer);
    if (signal === 'SIGKILL' && !resultRow) return send('⚠️ Backtest timed out (>8min) — killed. Bot is fine; try smaller window.');
    if (resultRow?.error) return send(`⚠️ Backtest failed: \`${resultRow.error}\``);
    if (tgMessage) return send(tgMessage);
    if (resultRow?.ok) return send(`✅ Backtest done (${Math.round((resultRow.durationMs || 0) / 1000)}s) — no summary produced.`);
    return send(`⚠️ Backtest exited code ${code}${signal ? ` (${signal})` : ''}.\nStderr:\n\`\`\`\n${(stderrBuf || '').slice(-500)}\n\`\`\``);
  });
  child.on('error', (err) => { clearTimeout(killTimer); send(`⚠️ Could not spawn: ${err.message}`); });
}

// ── Bias / setup / news ──

async function runDetectChild() {
  const script = join(REPO_DIR, 'scripts', 'run-detect-child.js');
  if (!existsSync(script)) return { error: 'detect runner script not found' };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: REPO_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', stderr = '', result = null;
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.startsWith('RESULT:')) { try { result = JSON.parse(line.slice(7)); } catch {} }
        else console.log('[detect-child]', line);
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); console.error('[detect-child]', d.toString().trim()); });
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 30_000);
    child.on('exit', (code) => {
      clearTimeout(kill);
      if (result) return resolve(result);
      const tail = (stderr || '(no stderr)').split('\n').slice(-6).join(' / ').slice(0, 400);
      resolve({ error: `detect crashed (exit ${code}): ${tail}` });
    });
    child.on('error', (e) => { clearTimeout(kill); resolve({ error: e.message }); });
  });
}

async function cmdBias() {
  await send('🧭 Computing bias across MGC + MNQ + MES…');
  const r = await runDetectChild();
  if (r.error) return send(`⚠️ ${r.error}`);

  const STATUS_WT = { triggered: 3, near_trigger: 2, forming: 1, invalidated: 0 };
  const INSTRUMENTS = [
    { key: 'gold',   label: 'GOLD',   sym: 'MGC1!' },
    { key: 'nasdaq', label: 'NASDAQ', sym: 'MNQ1!' },
    { key: 'sp',     label: 'S&P',    sym: 'MES1!' },
  ];

  const byInst = {};
  for (const x of r.results || []) {
    if (!x.direction || x.direction === 'NONE') continue;
    const inst = x.instrument || 'gold';
    (byInst[inst] ||= { long: [], short: [], longScore: 0, shortScore: 0 });
    const w = (STATUS_WT[x.status] || 0) * (x.confidence || 0.5);
    if (x.direction === 'LONG')  { byInst[inst].long.push(x);  byInst[inst].longScore  += w; }
    if (x.direction === 'SHORT') { byInst[inst].short.push(x); byInst[inst].shortScore += w; }
  }
  const totalSignals = Object.values(byInst).reduce((n, g) => n + g.long.length + g.short.length, 0);

  if (totalSignals === 0) {
    return send([
      header('⚪', 'NEUTRAL — no signals'),
      '',
      'Markets in chop, outside killzones, or waiting for sweep.',
      'Try `/24h on` for any-hour signals (lower quality).',
    ].join('\n'));
  }

  const lines = [header('🧭', 'Multi-instrument bias'), ''];
  for (const inst of INSTRUMENTS) {
    const g = byInst[inst.key];
    if (!g) { lines.push(`⚪ *${inst.label}* \`${inst.sym}\` · no signals`); continue; }
    const total = g.longScore + g.shortScore;
    let icon, word, pct;
    if (total < 0.1) { icon = '⚪'; word = 'NEUTRAL'; pct = '—'; }
    else if (g.longScore > g.shortScore * 1.3) { icon = '🟢'; word = 'BULLISH'; pct = `${Math.round(g.longScore / total * 100)}%`; }
    else if (g.shortScore > g.longScore * 1.3) { icon = '🔴'; word = 'BEARISH'; pct = `${Math.round(g.shortScore / total * 100)}%`; }
    else { icon = '⚪'; word = 'MIXED'; pct = '~50/50'; }
    lines.push(`${icon} *${inst.label}* \`${inst.sym}\` · ${word} (${pct})`);
    lines.push(`   ${g.long.length}L · ${g.short.length}S signals`);
    const top = [...g.long, ...g.short].sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 3);
    for (const s of top) {
      const arrow = s.direction === 'LONG' ? '🟢' : '🔴';
      lines.push(`     ${arrow} #${KEY_TO_NUM[s.strategy] || 'U'} ${s.strategy} · ${s.status} · ${Math.round((s.confidence||0)*100)}%`);
    }
    lines.push('');
  }
  await send(lines.join('\n'));
}

async function cmdActiveSetups() {
  await send('🎯 Checking all strategies…');
  const r = await runDetectChild();
  if (r.error) return send(`⚠️ ${r.error}`);
  const directional = (r.results || []).filter((x) => x.direction === 'LONG' || x.direction === 'SHORT');
  if (directional.length === 0) {
    return send([
      header('🎯', 'No active setups'),
      '',
      'No strategy showing directional development right now.',
      'Could be outside killzones, no sweep yet, or chop. Try `/24h on`.',
    ].join('\n'));
  }
  const PRI = { triggered: 0, near_trigger: 1, forming: 2, invalidated: 3 };
  const byStrategy = {};
  for (const x of directional) {
    const cur = byStrategy[x.strategy];
    if (!cur || (PRI[x.status] ?? 9) < (PRI[cur.status] ?? 9)) byStrategy[x.strategy] = x;
  }
  const sorted = Object.values(byStrategy).sort((a, b) => (PRI[a.status] ?? 9) - (PRI[b.status] ?? 9));
  const STAGE = { triggered: '🟢 TRIGGERED', near_trigger: '🟠 NEAR', forming: '🟡 FORMING' };
  const lines = [header('🎯', 'Active setups'), ''];
  for (const s of sorted) {
    const dir = s.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    lines.push(`*#${KEY_TO_NUM[s.strategy] || 'U'} ${s.strategy}* · ${dir} · ${STAGE[s.status] || s.status} · ${Math.round((s.confidence||0)*100)}%`);
    if (s.summary) lines.push(`  _${s.summary.slice(0, 100)}_`);
  }
  lines.push('', '_`/setup <num>` for full detail + chart._');
  await send(lines.join('\n'));
}

async function cmdSetup(arg) {
  const key = resolveStrategy(arg);
  if (!key) return send('Usage: `/setup <num>` (1-10) or `/setup <key>` (e.g. `TRINITY`)');
  await send(`🔍 Checking *${key}*…`);
  const r = await runDetectChild();
  if (r.error) return send(`⚠️ ${r.error}`);
  const matches = (r.results || []).filter((x) => x.strategy === key);
  if (matches.length === 0) {
    return send(`#${KEY_TO_NUM[key] || 'U'} *${key}* · no activity.\n\nEnabled and watching, but no setup is forming. Outside killzone, no sweep yet, or no HTF gap tapped.`);
  }
  const PRI = { triggered: 0, near_trigger: 1, forming: 2, invalidated: 3 };
  matches.sort((a, b) => (PRI[a.status] ?? 9) - (PRI[b.status] ?? 9));
  const top = matches[0];
  const STAGE = { forming: '🟡 FORMING', near_trigger: '🟠 NEAR TRIGGER', triggered: '🟢 TRIGGERED', invalidated: '❌ INVALIDATED' };

  let chartUrl = null;
  if (top.entryPlan) {
    try { const m = await import('../lib/chart_image.js'); chartUrl = await m.buildAlertChartUrl(top); } catch {}
  }

  const lines = [
    header('🔍', `#${KEY_TO_NUM[key] || 'U'} ${key} · ${STAGE[top.status] || top.status}`),
    kv('Direction', top.direction === 'LONG' ? '🟢 LONG' : top.direction === 'SHORT' ? '🔴 SHORT' : '—'),
    kv('Confidence', `${Math.round((top.confidence || 0) * 100)}%`),
    '',
    top.summary || top.setupName || '',
  ];

  const g = top.geometry || {};
  const confirmed = [], missing = [];
  if (g.target?.level)    confirmed.push(`Target @ ${g.target.level.toFixed(2)} ${g.target.name ? `(${g.target.name})` : ''}`);
  else                    missing.push('Liquidity target');
  if (g.sweep?.wickPrice) confirmed.push(`Sweep wick @ ${g.sweep.wickPrice.toFixed(2)}`);
  else                    missing.push('Liquidity sweep');
  if (g.mss?.brokenPrice) confirmed.push(`MSS @ ${g.mss.brokenPrice.toFixed(2)}`);
  else                    missing.push('Market structure shift');
  if (g.fvg?.top != null) confirmed.push(`FVG ${g.fvg.bottom.toFixed(2)}-${g.fvg.top.toFixed(2)}`);
  else if (top.status !== 'triggered') missing.push('Fair Value Gap');
  if (top.entryPlan)      confirmed.push(`Entry plan ready @ ${top.entryPlan.entry.toFixed(2)}`);

  if (confirmed.length) { lines.push('', section('✅ Confirmed'), ...confirmed.map(bullet)); }
  if (missing.length && top.status !== 'triggered') {
    lines.push('', section('⏳ Still needed'), ...missing.map(bullet));
  }

  if (chartUrl) {
    const text = lines.join('\n');
    const caption = text.length <= 1024 ? text : text.slice(0, 980) + '…';
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, photo: chartUrl, caption, parse_mode: 'Markdown' }),
    }).catch(() => {});
    if (text.length > 1024) await send(text);
  } else await send(lines.join('\n'));
}

async function cmdNews(arg) {
  const { upcomingEvents, checkBlackout, refreshForexFactory, nextEvent } = await import('../lib/news.js');
  await refreshForexFactory().catch(() => {});
  const hours = Math.max(1, Math.min(168, parseInt((arg || '').trim(), 10) || 48));
  const now = Date.now() / 1000;
  const bo = checkBlackout(now, 30);
  const evs = upcomingEvents(now, hours);

  const headerLine = bo.blocked && bo.event
    ? `🚫 *Bot paused · news blackout*\n   ${tgEscape(bo.event.title || 'high-impact event')} · ${bo.minutesAway}m away`
    : `✅ *Bot trading freely*\n   _No high-impact event in the next 30m._`;

  let nextLine = '';
  const nxt = nextEvent(now);
  if (nxt && nxt.minutesAway > 30) {
    const m = nxt.minutesAway;
    const away = m < 60 ? `${m}m` : m < 1440 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`;
    nextLine = `⏳ Next: *${tgEscape(nxt.title || '?')}* in ${away}`;
  }

  const fmtDate = (u) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
  }).format(new Date(u * 1000));
  const fmtTime = (u) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(u * 1000));

  const byDay = new Map();
  for (const ev of evs) {
    const key = fmtDate(ev.unix);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }

  const lines = [header('📰', 'News watch'), '', headerLine, nextLine, '', `─── next ${hours}h ───`].filter(Boolean);
  if (byDay.size === 0) lines.push('', '_No high-impact USD events in this window._');
  else for (const [day, dayEvents] of byDay) {
    lines.push('', section(day));
    for (const ev of dayEvents) lines.push(bullet(`\`${fmtTime(ev.unix)}\` · ${tgEscape(ev.title || ev.name || '?')}`));
  }
  lines.push('', '_Auto-paused ±30m around each event. Source: ForexFactory._');
  await send(lines.join('\n'));
}

// ── Journal ──

async function cmdJournalIn(arg) {
  const journal = await import('../lib/trade_journal.js');
  const parts = tokenize(arg || '');
  if (parts.length < 3) return send('Usage: `/in <setupId> <contracts> <price> [instrument]`');
  const [setupId, c, p, instrument] = parts;
  const ev = journal.log({ action: 'in', setupId, contracts: Number(c), price: Number(p), instrument });
  await send(`${statusDot('ok')} *Entered* \`${tgEscape(setupId)}\`\n${ev.contracts}× @ \`$${ev.price}\`${instrument ? ` · ${instrument}` : ''}`);
}

async function cmdJournalOut(arg) {
  const journal = await import('../lib/trade_journal.js');
  const parts = tokenize(arg || '');
  if (parts.length < 3) return send('Usage: `/out <setupId> <tp1|tp2|sl|be|manual> <price> [contracts]`');
  const [setupId, reason, p, c] = parts;
  const ev = journal.log({ action: 'out', setupId, reason, price: Number(p), contracts: c ? Number(c) : undefined });
  const icon = reason === 'sl' ? '🛑' : reason === 'be' ? '🟡' : '🎯';
  await send(`${icon} *Closed* \`${tgEscape(setupId)}\` · ${reason.toUpperCase()} @ \`$${ev.price}\``);
}

async function cmdJournalBE(arg) {
  const journal = await import('../lib/trade_journal.js');
  const setupId = (arg || '').trim();
  if (!setupId) return send('Usage: `/be <setupId>`');
  journal.log({ action: 'be', setupId });
  await send(`🟡 SL → breakeven on \`${tgEscape(setupId)}\``);
}

async function cmdJournalNote(arg) {
  const journal = await import('../lib/trade_journal.js');
  const parts = tokenize(arg || '');
  if (parts.length < 2) return send('Usage: `/note <setupId> <text…>`');
  const [setupId, ...rest] = parts;
  journal.log({ action: 'note', setupId, text: rest.join(' ') });
  await send(`📝 Note saved on \`${tgEscape(setupId)}\``);
}

async function cmdJournal(arg) {
  const journal = await import('../lib/trade_journal.js');
  const trimmed = (arg || '').trim();
  if (trimmed.startsWith('stats')) {
    const days = parseInt(trimmed.split(/\s+/)[1] || '7', 10) || 7;
    const s = journal.stats(days);
    return send([
      header('📊', `Journal stats · last ${days}d`),
      '',
      kv('Trades', `${s.totalTrades} (${s.openTrades} open, ${s.closedTrades} closed)`),
      kv('W/L', `${s.wins} / ${s.losses}`),
      kv('Win rate', `${(s.winRate * 100).toFixed(0)}%`),
      kv('Contracts', s.totalContracts),
      '',
      `Breakdown: ${Object.entries(s.byReason).map(([k, v]) => `${k}=${v}`).join(' · ')}`,
    ].join('\n'));
  }
  const n = Math.max(1, Math.min(50, parseInt(trimmed, 10) || 10));
  const trades = journal.recentTrades(n);
  if (trades.length === 0) return send('📓 Journal empty — log your first trade with `/in <id> <contracts> <price>`.');
  const lines = [header('📓', `Last ${trades.length} trades`), ''];
  for (const t of trades) {
    const status = t.exitReason ? `${t.exitReason.toUpperCase()} @ $${t.exitPrice}` : t.isBE ? 'open (BE)' : 'open';
    lines.push(`\`${tgEscape(t.setupId)}\` · ${t.contracts || '?'}× @ $${t.entryPrice} → ${status}`);
  }
  await send(lines.join('\n'));
}

// ── Holy AI Engine ──

async function cmdRegime() {
  await send('🌡 Reading the market regime…');
  try {
    const holyAi = await import('../lib/holy_ai.js');
    const r = await holyAi.marketRegime();
    if (!r.aiEnabled) return send('🤖 AI offline — set `GROQ_API_KEY` or `GEMINI_API_KEY` in `~/.config/trading-alerts/.env`.');
    const ICON = { trend: '📈', range: '↔️', chop: '🌀', 'news-driven': '📰', reversal: '🔄', unknown: '❔' };
    await send([
      header(`${ICON[r.regime] || '🌡'}`, `Regime · ${r.regime.toUpperCase()}`),
      '',
      kv('Confidence', `${Math.round(r.confidence * 100)}%`),
      '',
      `_${tgEscape(r.summary)}_`,
      '',
      '_Cached 30min · `/regime` to refresh after expiry._',
    ].join('\n'));
  } catch (err) { await send(`⚠️ Regime read failed: ${err.message}`); }
}

async function cmdCoach(arg) {
  const days = Math.max(1, Math.min(30, parseInt(arg, 10) || 7));
  await send(`🧠 Coaching from last ${days}d trades…`);
  try {
    const holyAi = await import('../lib/holy_ai.js');
    const r = await holyAi.coachTrades(days);
    await send([
      header('🧠', `Coach · last ${days}d`),
      '',
      `_${tgEscape(r.text)}_`,
      '',
      r.aiEnabled ? '_Cached per NY date · re-runs once a day._' : '_AI offline._',
    ].join('\n'));
  } catch (err) { await send(`⚠️ Coach failed: ${err.message}`); }
}

async function cmdAiEngine(arg) {
  const a = (arg || '').trim().toLowerCase();
  if (a === '') {
    const holyAi = await import('../lib/holy_ai.js');
    const c = holyAi.getEngineConfig();
    return send([
      header('🤖', `Holy AI Engine · ${c.enabled ? 'ON' : 'OFF'}`),
      '',
      kv('Provider', c.provider),
      kv('Gate threshold', `${Math.round(c.threshold * 100)}% adjusted confidence`),
      '',
      'When ON: every triggered setup is re-scored by the LLM, multiplied into the strategy confidence, and dropped from Telegram if below threshold.',
      '',
      `Toggle: \`/ai-engine ${c.enabled ? 'off' : 'on'}\``,
      `Set threshold: \`/ai-engine threshold 0.55\``,
    ].join('\n'));
  }
  if (a === 'on' || a === 'off') {
    await updateConfig((c) => { c.aiEngine = c.aiEngine || {}; c.aiEngine.enabled = (a === 'on'); return c; });
    return send(`🤖 Holy AI Engine → ${a === 'on' ? '*ON*' : '*OFF*'}${a === 'off' ? '\n_Raw strategy output reaches Telegram without AI gating._' : ''}`);
  }
  if (a.startsWith('threshold')) {
    const v = Number(a.split(/\s+/)[1]);
    if (!Number.isFinite(v) || v < 0 || v > 1) return send('Usage: `/ai-engine threshold <0..1>` (e.g. `0.55`)');
    await updateConfig((c) => { c.aiEngine = c.aiEngine || { enabled: true }; c.aiEngine.threshold = v; return c; });
    return send(`🤖 Gate threshold → *${Math.round(v * 100)}%*`);
  }
  await send('Usage: `/ai-engine` · `/ai-engine on|off` · `/ai-engine threshold 0.55`');
}

// ── AI (free-form chat) ──

async function cmdAi(arg) {
  if (!arg) return send('Usage: `/ai <message>` — or send any non-command text.');
  await runAiChat(arg);
}

async function cmdClearChat() {
  const ai = await import('../lib/ai_chat.js');
  ai.clearSession(CHAT_ID);
  await send('🧹 Chat memory cleared. Next message starts a fresh thread.');
}

async function runAiChat(userText) {
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendChatAction`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, action: 'typing' }),
    });
  } catch {}
  try {
    const ai = await import('../lib/ai_chat.js');
    const reply = await ai.chat(CHAT_ID, userText);
    await send(reply);
  } catch (err) {
    await send(`⚠️ AI error: ${err.message}\n\nFalls back to commands — send \`/help\`.`);
  }
}

// ── System ──

const SERVICE_LABELS = {
  all:       null,
  signal:    'com.jqvier.trading-alerts',
  signals:   'com.jqvier.trading-alerts',
  bot:       'com.jqvier.octave-telegram',
  webui:     'com.jqvier.octave-webui',
  dashboard: 'com.jqvier.octave-webui',
  watchdog:  'com.jqvier.octave-watchdog',
};

async function cmdRestart(arg) {
  const key = (arg || 'all').trim().toLowerCase();
  if (key === 'all') {
    await send('🔄 Restarting all services…');
    for (const label of ['com.jqvier.trading-alerts', 'com.jqvier.octave-telegram', 'com.jqvier.octave-webui', 'com.jqvier.octave-watchdog']) {
      spawn('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], { detached: true, stdio: 'ignore' }).unref();
    }
    return setTimeout(cmdHealth, 5000);
  }
  const label = SERVICE_LABELS[key];
  if (!label) return send('Unknown service. Try: `/restart all` · `/restart bot` · `/restart signals` · `/restart webui` · `/restart watchdog`');
  await send(`🔄 Restarting \`${label}\`…`);
  spawn('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(cmdHealth, 4000);
}

async function cmdShutdown(arg) {
  if (arg !== 'confirm') {
    return send([
      header('⚠️', 'Shutdown'),
      '',
      'Use `/shutdown confirm` to stop everything:',
      bullet('alerts service'),
      bullet('caffeinate (Mac can sleep)'),
      bullet('TradingView'),
      bullet('web UI / bot'),
    ].join('\n'));
  }
  await send('⏸ Shutting down…');
  spawn('/Users/jqvier/Desktop/Octave.app/Contents/MacOS/octave', ['shutdown'], { detached: true, stdio: 'ignore' }).unref();
}

async function cmdVersion() {
  const r = await exec('/usr/bin/git', ['-C', REPO_DIR, 'log', '-1', '--format=%h %s']);
  await send(r.code === 0 ? `🔖 \`${r.out}\`` : 'Could not read git log');
}

async function cmdDashboard() {
  const TUNNEL_PATHS = ['/home/octave/.octave-tunnel-url', process.env.HOME ? `${process.env.HOME}/.octave-tunnel-url` : null].filter(Boolean);
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
    return send([
      header('🌐', 'Dashboard'),
      '',
      'No public HTTPS URL configured yet.',
      '',
      'Local Mac: open http://127.0.0.1:7345/',
      '',
      'For public access:',
      bullet('Deploy to VPS (`docs/VPS-DEPLOY.md`)'),
      bullet('Run `sudo bash scripts/setup-cloudflare-tunnel.sh`'),
    ].join('\n'));
  }
  await send(`${header('🌐', 'Octave Dashboard')}\n\n\`${url}\``, {
    keyboard: [[{ text: '🎵 Open Dashboard', url }]],
  });
}

// ── Self-heal ──

async function cmdDiagnose() {
  const sh = await import('../lib/self_heal.js');
  const report = await sh.diagnoseAll();
  const lines = [header('🩺', 'Health check'), ''];
  for (const [key, r] of Object.entries(report)) {
    lines.push(`${r.ok ? statusDot('ok') : statusDot('down')} *${key}*${r.ok ? '' : ` · ${r.issues.join('; ')}`}`);
  }
  lines.push('', '_`/fix <name>` or `/fix all` to repair._');
  await send(lines.join('\n'));
}

async function cmdFix(arg) {
  const sh = await import('../lib/self_heal.js');
  const a = (arg || '').trim().toLowerCase();
  if (!a || a === 'all') {
    await send('🩹 Running self-heal across all services…');
    const log = await sh.fixAll();
    const lines = [header('🩹', 'Self-heal report'), ''];
    for (const [key, entry] of Object.entries(log)) {
      const icon = entry.wasHealthy ? statusDot('ok') : entry.ok ? '✅' : '❌';
      const issues = entry.issues?.length ? ` _(${entry.issues.join('; ').slice(0, 120)})_` : '';
      lines.push(`${icon} *${key}*${issues}`);
      for (const act of (entry.actions || [])) lines.push(`  · ${tgEscape(act)}`);
      if (entry.message) lines.push(`  · ${tgEscape(entry.message)}`);
    }
    return send(lines.join('\n'));
  }
  const aliases = { signals: 'signal-engine', dashboard: 'webui', telegram: 'bot', data: 'market-data' };
  const key = aliases[a] || a;
  if (!sh.listComponents().some((c) => c.key === key)) {
    return send([
      'Unknown component. Available:',
      ...sh.listComponents().map((c) => `\`${c.key}\` · ${tgEscape(c.label)}`),
      '', 'Or `/fix all` to fix everything.',
    ].join('\n'));
  }
  await send(`🩹 Diagnosing + fixing *${key}*…`);
  const r = await sh.fixOne(key);
  const icon = r.wasHealthy ? statusDot('ok') : r.ok ? '✅' : '❌';
  await send([
    `${icon} *${key}*: ${r.ok ? 'OK' : 'still failing'}`,
    r.issues?.length ? `Issues: ${r.issues.join('; ')}` : '',
    r.actions?.length ? `Actions:\n${r.actions.map((a) => '  · ' + a).join('\n')}` : '',
    r.message ? `_${tgEscape(r.message)}_` : '',
  ].filter(Boolean).join('\n'));
}

// ── HELP ──
// Paginated by category. /help shows the index; /help <topic> shows detail.

const HELP_INDEX = [
  header('🎵', 'Octave Bot · /help'),
  '',
  'Tap a topic or send `/help <topic>`:',
  '',
  bullet('`/help market`   — bias, setups, price, news'),
  bullet('`/help history`  — today, yesterday, history, range, summary'),
  bullet('`/help strats`   — list, enable/disable, custom strategies'),
  bullet('`/help settings` — mute, 24/7 mode, backtest'),
  bullet('`/help journal`  — log entries, exits, stats'),
  bullet('`/help system`   — health, perf, restart, diagnose, fix'),
  bullet('`/help ai`       — free-form chat, file uploads'),
  bullet('`/help holy`     — Holy AI Engine: regime, coach, gating'),
  '',
  '_Free-form text goes to AI. `/menu` opens the tap-to-use UI._',
].join('\n');

const HELP_TOPICS = {
  market: [
    header('📊', 'Market commands'),
    '',
    kv('/bias', 'multi-instrument bias (gold + nasdaq + S&P)'),
    kv('/setups', "what's forming on every strategy now"),
    kv('/setup <num>', 'detail + chart for one strategy'),
    kv('/price', 'live micro-futures prices'),
    kv('/session', 'current session window'),
    kv('/news [hours]', 'upcoming USD events + blackout state'),
  ].join('\n'),
  history: [
    header('📜', 'History commands'),
    '',
    kv('/today', "today's alerts (NY time)"),
    kv('/yesterday', "yesterday's alerts"),
    kv('/history [N]', 'last N alerts'),
    kv('/range HH:MM-HH:MM', 'alerts in NY window today'),
    kv('/last', 'most recent alert detail'),
    kv('/summary [days]', 'alerts + trades digest'),
  ].join('\n'),
  strats: [
    header('🎚', 'Strategy commands'),
    '',
    kv('/strategies', 'list every strategy, on/off'),
    kv('/enable <num>', 'turn on (e.g. `/enable 5`)'),
    kv('/disable <num>', 'turn off'),
    '',
    section('Custom strategies'),
    kv('/mystrategies', 'list yours'),
    kv('/addstrategy <id> "<name>" <entry> [tf]', 'create'),
    kv('/editstrategy <id> key=value', 'edit'),
    kv('/delstrategy <id>', 'delete'),
    '',
    '_Or send a PDF/image — AI will extract a strategy from it._',
  ].join('\n'),
  settings: [
    header('⚙️', 'Settings commands'),
    '',
    kv('/24h on|off', 'bypass killzones (any-hour alerts)'),
    kv('/mute <minutes>', 'pause alerts (1-1440)'),
    kv('/unmute', 'resume'),
    '',
    section('Backtest'),
    kv('/backtest', '30d backtest of enabled strategies'),
    kv('/backtest <num>', 'single strategy'),
    kv('/backtest <num> <days>', 'custom window'),
    '_Auto-runs Sunday 8pm NY._',
  ].join('\n'),
  journal: [
    header('📓', 'Trade journal'),
    '',
    kv('/in <id> <ctrs> <price> [inst]', 'record entry'),
    kv('/out <id> <tp1|tp2|sl|be|manual> <price>', 'record exit'),
    kv('/be <id>', 'moved SL to breakeven'),
    kv('/note <id> <text>', 'attach a note'),
    kv('/journal [N]', 'last N trades'),
    kv('/journal stats [days]', 'win-rate breakdown'),
  ].join('\n'),
  system: [
    header('🚨', 'System commands'),
    '',
    kv('/status', 'high-level live state'),
    kv('/health', 'per-service detail'),
    kv('/perf', 'CPU · RAM · disk · process stats'),
    kv('/version', 'current git commit'),
    kv('/dashboard', 'web UI URL'),
    '',
    section('Recovery'),
    kv('/diagnose', 'health check all components'),
    kv('/fix [name]', 'auto-heal (e.g. `/fix all`, `/fix bot`)'),
    kv('/restart [name]', 'restart service (all/bot/signals/webui/watchdog)'),
    kv('/shutdown confirm', 'stop everything'),
  ].join('\n'),
  ai: [
    header('🤖', 'AI assistant'),
    '',
    'Just send any non-command text and Gemini handles it. Examples:',
    bullet('"I entered MGC long at 4520 with 2 contracts"'),
    bullet('"what\'s my win rate this week?"'),
    bullet('"create a strategy that fades RSI extremes on 1h"'),
    bullet('"run a 14-day backtest"'),
    '',
    kv('/ai <message>', 'explicit prompt'),
    kv('/clearchat', 'wipe AI memory'),
    '',
    '_Upload a PDF/image/text file and the AI will extract a strategy from it._',
  ].join('\n'),
  holy: [
    header('✨', 'Holy AI Engine'),
    '',
    'Adaptive LLM layer that boosts precision of every strategy:',
    bullet('Re-scores every triggered setup with the current market regime + news + geometry'),
    bullet('Multiplies into the strategy confidence to gate weak alerts before they ring your phone'),
    bullet('Appends a 1-line senior-trader read to each alert'),
    bullet('Caches per setupId so the LLM is never spent twice'),
    '',
    section('Commands'),
    kv('/regime', 'current market regime (cached 30min)'),
    kv('/coach [days]', 'AI coaching from recent trades (cached daily)'),
    kv('/ai-engine', 'status · provider · threshold'),
    kv('/ai-engine on|off', 'master toggle (default ON)'),
    kv('/ai-engine threshold 0.55', 'gate min adjusted confidence (0..1)'),
    '',
    '_When the LLM is offline (no GROQ/GEMINI key), the engine no-ops cleanly — strategies pass through unchanged._',
  ].join('\n'),
};

async function cmdHelp(arg) {
  const topic = (arg || '').trim().toLowerCase();
  if (!topic) return send(HELP_INDEX);
  if (HELP_TOPICS[topic]) return send(HELP_TOPICS[topic]);
  await send(`Unknown topic. Send \`/help\` for the index.`);
}

// ─── INLINE MENU ─────────────────────────────────────────────────────────

async function buildMainMenu() {
  const cfg = loadConfig() || {};
  const session = readJson(SESSION_FILE, { lastSession: null });
  const onCount = cfg.strategies ? Object.values(cfg.strategies).filter(Boolean).length : 0;
  const muteMin = cfg.mute?.untilMs && cfg.mute.untilMs > Date.now()
    ? Math.round((cfg.mute.untilMs - Date.now()) / 60000) : 0;

  let userCount = 0;
  try { const us = await import('../lib/user_strategies.js'); userCount = us.list().length; } catch {}
  const total = STRATEGIES.length + userCount;

  const text = [
    header('🎵', 'Octave'),
    '',
    `${muteMin > 0 ? '🔕 Muted ' + muteMin + 'm' : '🔔 Live'} · ${onCount}/${total} strategies · ${(session.lastSession || 'closed').toUpperCase()} session`,
    cfg.bypassKillzones ? '🌐 24/7 mode ON' : '',
  ].filter(Boolean).join('\n');

  const keyboard = [
    [{ text: '🧭 Bias',     callback_data: 'act:bias' }, { text: '🎯 Setups',  callback_data: 'act:setups' }],
    [{ text: '📊 Today',    callback_data: 'act:today' }, { text: '🔔 Last',   callback_data: 'act:last' }],
    [{ text: '💰 Price',    callback_data: 'act:price' }, { text: '🌍 Session', callback_data: 'act:session' }],
    [{ text: '🎚 Strategies', callback_data: 'view:strategies' }, { text: '🔕 Mute', callback_data: 'view:mute' }],
    [{ text: '📈 Backtest', callback_data: 'view:backtest' }, { text: '🌐 Dashboard', callback_data: 'act:dashboard' }],
    [{ text: '🩺 Health',   callback_data: 'act:health' }, { text: '⚙️ Settings', callback_data: 'view:settings' }],
    [{ text: '🔄 Refresh',  callback_data: 'view:main' }],
  ];
  return { text, keyboard };
}

function buildStrategiesView() {
  const cfg = loadConfig() || { strategies: {} };
  const text = [header('🎚', 'Strategies'), '', 'Tap any strategy to toggle on/off.'].join('\n');
  const keyboard = [];
  for (const s of STRATEGIES) {
    const on = !!cfg.strategies[s.key];
    keyboard.push([{ text: `${on ? '🟢' : '⚫'} #${s.num} ${s.name}`, callback_data: `strat:${s.key}` }]);
  }
  keyboard.push([{ text: '« Back', callback_data: 'view:main' }]);
  return { text, keyboard };
}

function buildMuteView() {
  const cfg = loadConfig() || {};
  const sec = cfg.mute?.untilMs && cfg.mute.untilMs > Date.now()
    ? Math.round((cfg.mute.untilMs - Date.now()) / 1000) : 0;
  const text = sec > 0
    ? `${header('🔕', `Muted · ${Math.round(sec / 60)}m remaining`)}\n\nUntil: \`${nyHHmm(cfg.mute.untilMs)}\` NY`
    : `${header('🔔', 'Alerts live')}\n\nMute pauses all alerts for the chosen duration.`;
  const keyboard = [
    [{ text: '🔕 30 min', callback_data: 'mute:30' }, { text: '🔕 60 min', callback_data: 'mute:60' }, { text: '🔕 3 h', callback_data: 'mute:180' }],
    [{ text: '🔕 12 h', callback_data: 'mute:720' }, { text: '🔕 24 h', callback_data: 'mute:1440' }],
    [{ text: '🔔 Unmute', callback_data: 'mute:0' }],
    [{ text: '« Back', callback_data: 'view:main' }],
  ];
  return { text, keyboard };
}

function buildBacktestView() {
  const text = [header('📈', 'Backtest'), '', 'Pick a window. Runs in isolated process — bot stays responsive.'].join('\n');
  const keyboard = [
    [{ text: '7 days', callback_data: 'bt:7' }, { text: '30 days', callback_data: 'bt:30' }, { text: '60 days', callback_data: 'bt:60' }],
    [{ text: 'All enabled (30d)', callback_data: 'bt:30' }],
    [{ text: '« Back', callback_data: 'view:main' }],
  ];
  return { text, keyboard };
}

function buildSettingsView() {
  const cfg = loadConfig() || {};
  const aiOn = cfg.aiEngine?.enabled !== false;
  const aiThr = Math.round((Number(cfg.aiEngine?.threshold) || 0.55) * 100);
  const text = [
    header('⚙️', 'Settings'),
    '',
    `24/7 mode    · ${cfg.bypassKillzones ? '🟢 ON (any hour)' : '⚫ OFF (killzones only)'}`,
    `Chart images · ${cfg.alertChartImages !== false ? '🟢 ON' : '⚫ OFF'}`,
    `Holy AI      · ${aiOn ? '🟢 ON' : '⚫ OFF'} · gate ${aiThr}%`,
  ].join('\n');
  const keyboard = [
    [{ text: cfg.bypassKillzones ? '⚫ Turn 24/7 OFF' : '🌐 Turn 24/7 ON', callback_data: `set:24h:${cfg.bypassKillzones ? 'off' : 'on'}` }],
    [{ text: cfg.alertChartImages !== false ? '⚫ Disable chart images' : '🟢 Enable chart images', callback_data: `set:charts:${cfg.alertChartImages !== false ? 'off' : 'on'}` }],
    [{ text: aiOn ? '⚫ Disable Holy AI' : '✨ Enable Holy AI', callback_data: `set:ai:${aiOn ? 'off' : 'on'}` }],
    [{ text: '🌡 Regime', callback_data: 'act:regime' }, { text: '🧠 Coach', callback_data: 'act:coach' }],
    [{ text: '🚨 System (restart/shutdown)', callback_data: 'view:system' }],
    [{ text: '« Back', callback_data: 'view:main' }],
  ];
  return { text, keyboard };
}

function buildSystemView() {
  const text = [
    header('🚨', 'System actions'),
    '',
    'Restart bounces a service. Shutdown stops everything (you\'d have to bring it back manually).',
  ].join('\n');
  const keyboard = [
    [{ text: '🔄 Restart all',         callback_data: 'act:restart:all' }],
    [{ text: '🔄 Restart signal engine', callback_data: 'act:restart:signals' }],
    [{ text: '🔄 Restart bot',         callback_data: 'act:restart:bot' }],
    [{ text: '🔄 Restart dashboard',   callback_data: 'act:restart:webui' }],
    [{ text: '⏸ Shutdown ALL',         callback_data: 'act:shutdown-confirm' }],
    [{ text: '« Back', callback_data: 'view:settings' }],
  ];
  return { text, keyboard };
}

async function cmdMenu() {
  const v = await buildMainMenu();
  await send(v.text, { keyboard: v.keyboard });
}

// ─── CALLBACK DISPATCHER ─────────────────────────────────────────────────

async function handleCallback(cq) {
  if (String(cq.from?.id) !== String(CHAT_ID) && String(cq.message?.chat?.id) !== String(CHAT_ID)) {
    return ackCallback(cq.id, 'unauthorized');
  }
  const data = cq.data || '';
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const [kind, ...rest] = data.split(':');
  const arg = rest.join(':');

  try {
    if (kind === 'view') {
      const v = arg === 'main' ? await buildMainMenu()
        : arg === 'strategies' ? buildStrategiesView()
        : arg === 'mute'       ? buildMuteView()
        : arg === 'backtest'   ? buildBacktestView()
        : arg === 'settings'   ? buildSettingsView()
        : arg === 'system'     ? buildSystemView()
        : null;
      if (!v) return ackCallback(cq.id, 'unknown view');
      await editMessage(chatId, messageId, v.text, { keyboard: v.keyboard });
      return ackCallback(cq.id);
    }

    if (kind === 'strat') {
      const k = arg;
      if (!ALL_KEYS.includes(k)) return ackCallback(cq.id, 'unknown strategy');
      const cur = loadConfig() || { strategies: {} };
      const next = !cur.strategies?.[k];
      await updateConfig((c) => { c.strategies = c.strategies || {}; c.strategies[k] = next; return c; });
      const v = buildStrategiesView();
      await editMessage(chatId, messageId, v.text, { keyboard: v.keyboard });
      return ackCallback(cq.id, `${k} → ${next ? 'ON' : 'OFF'}`);
    }

    if (kind === 'mute') {
      const minutes = parseInt(arg, 10);
      if (minutes === 0) {
        await updateConfig((c) => { c.mute = { untilMs: 0, reason: null }; return c; });
        const v = buildMuteView();
        await editMessage(chatId, messageId, v.text, { keyboard: v.keyboard });
        return ackCallback(cq.id, '🔔 Unmuted');
      }
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) return ackCallback(cq.id, 'invalid');
      const untilMs = Date.now() + minutes * 60 * 1000;
      await updateConfig((c) => { c.mute = { untilMs, reason: 'telegram menu' }; return c; });
      const v = buildMuteView();
      await editMessage(chatId, messageId, v.text, { keyboard: v.keyboard });
      return ackCallback(cq.id, `🔕 ${minutes}m`);
    }

    if (kind === 'set') {
      const [what, val] = arg.split(':');
      if (what === '24h')    await updateConfig((c) => { c.bypassKillzones = (val === 'on'); return c; });
      else if (what === 'charts') await updateConfig((c) => { c.alertChartImages = (val === 'on'); return c; });
      else if (what === 'ai') await updateConfig((c) => { c.aiEngine = c.aiEngine || {}; c.aiEngine.enabled = (val === 'on'); return c; });
      else return ackCallback(cq.id, 'unknown setting');
      const v = buildSettingsView();
      await editMessage(chatId, messageId, v.text, { keyboard: v.keyboard });
      return ackCallback(cq.id, `${what} → ${val}`);
    }

    if (kind === 'bt') {
      const days = parseInt(arg, 10) || 30;
      await editMessage(chatId, messageId, `⏳ Running ${days}-day backtest…`, { keyboard: [] });
      await ackCallback(cq.id);
      return cmdBacktest(String(days));
    }

    if (kind === 'act') {
      const [verb, ...rest2] = arg.split(':');
      const map = {
        bias: cmdBias, setups: cmdActiveSetups, today: cmdToday, last: cmdLast,
        price: cmdPrice, session: cmdSession, health: cmdHealth, dashboard: cmdDashboard,
        regime: cmdRegime, coach: cmdCoach,
      };
      if (map[verb]) { await map[verb](); return ackCallback(cq.id); }
      if (verb === 'restart') { await cmdRestart(rest2[0]); return ackCallback(cq.id, `Restarting ${rest2[0]}…`); }
      if (verb === 'shutdown-confirm') {
        await editMessage(chatId, messageId, [
          header('⚠️', 'Confirm shutdown'),
          '',
          'Stops every service. You\'ll need to manually bring Octave back.',
        ].join('\n'), {
          keyboard: [
            [{ text: '✅ Yes, shut down', callback_data: 'act:shutdown-do' }],
            [{ text: '« Cancel', callback_data: 'view:system' }],
          ],
        });
        return ackCallback(cq.id);
      }
      if (verb === 'shutdown-do') {
        await editMessage(chatId, messageId, '⏸ Shutting down…', { keyboard: [] });
        await cmdShutdown('confirm');
        return ackCallback(cq.id, 'Bye.');
      }
    }

    await ackCallback(cq.id, 'Unknown action');
  } catch (err) {
    console.error('[bot] callback threw:', err.message);
    await ackCallback(cq.id, 'Error: ' + err.message);
  }
}

// ─── FILE UPLOAD → STRATEGY EXTRACTION ───────────────────────────────────

async function handleStrategyUpload(fileObj, caption) {
  await send('📎 Pulling file and running AI extraction…');
  try {
    const meta = await (await fetch(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileObj.file_id}`)).json();
    if (!meta?.ok) throw new Error('getFile failed');
    const fileResp = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${meta.result.file_path}`);
    if (!fileResp.ok) throw new Error('download failed');
    const buf = Buffer.from(await fileResp.arrayBuffer());
    const filename = (fileObj.file_name || meta.result.file_path.split('/').pop() || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_');
    const mime = fileObj.mime_type || guessMimeByExt(filename);

    const { extractStrategy } = await import('../lib/strategy_extractor.js');
    const us = await import('../lib/user_strategies.js');
    const { spec, source, notes } = await extractStrategy({ buffer: buf, mimetype: mime, filename });
    if (caption) spec.description = caption + (spec.description ? ' — ' + spec.description : '');

    let candidate = { ...spec };
    const existing = new Set(us.list().map((s) => s.id));
    let n = 1;
    while (existing.has(candidate.id)) candidate.id = `${spec.id}-${++n}`;
    const created = us.create(candidate);
    await updateConfig((c) => { c.strategies = c.strategies || {}; c.strategies[created.id] = true; return c; });

    await send([
      `✅ *Strategy created* via ${source === 'heuristic' ? 'heuristic fallback' : 'AI extraction'}`,
      kv('id', `\`${tgEscape(created.id)}\``),
      kv('name', tgEscape(created.name)),
      kv('entry', `\`${created.entry}\` · tf \`${created.timeframe}m\``),
      kv('params', `EMA ${created.fast}/${created.slow} · stop ${created.stop_atr_mult}× ATR · TP ${created.tp_r}R`),
      notes ? `_${tgEscape(notes)}_` : '',
      '',
      `Tune with \`/editstrategy ${created.id} key=value\`.`,
    ].filter(Boolean).join('\n'));
  } catch (err) {
    await send(`⚠️ Upload failed: ${err.message}`);
  }
}

function guessMimeByExt(name) {
  const ext = (name.match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase();
  return {
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    mp4: 'video/mp4', mov: 'video/quicktime',
    js: 'text/plain', py: 'text/plain', json: 'application/json',
  }[ext] || 'application/octet-stream';
}

// ─── COMMAND TABLE ───────────────────────────────────────────────────────

const COMMANDS = {
  '/start': cmdMenu, '/menu': cmdMenu, '/help': cmdHelp,
  '/status': cmdStatus, '/health': cmdHealth, '/perf': cmdPerf,
  '/session': cmdSession, '/price': cmdPrice,
  '/bias': cmdBias, '/setups': cmdActiveSetups, '/setup': cmdSetup, '/news': cmdNews,
  '/history': cmdHistory, '/today': cmdToday, '/yesterday': cmdYesterday,
  '/range': cmdRange, '/last': cmdLast, '/summary': cmdSummary,
  '/strategies': cmdStrategies, '/enable': cmdEnable, '/disable': cmdDisable,
  '/mystrategies': cmdMyStrategies, '/addstrategy': cmdAddStrategy,
  '/editstrategy': cmdEditStrategy, '/delstrategy': cmdDelStrategy,
  '/24h': cmd24h, '/mute': cmdMute, '/unmute': cmdUnmute,
  '/backtest': cmdBacktest,
  '/in': cmdJournalIn, '/out': cmdJournalOut, '/be': cmdJournalBE,
  '/note': cmdJournalNote, '/journal': cmdJournal,
  '/ai': cmdAi, '/clearchat': cmdClearChat,
  '/regime': cmdRegime, '/coach': cmdCoach, '/ai-engine': cmdAiEngine, '/aiengine': cmdAiEngine,
  '/restart': cmdRestart, '/shutdown': cmdShutdown,
  '/version': cmdVersion, '/dashboard': cmdDashboard,
  '/diagnose': cmdDiagnose, '/fix': cmdFix,
};

// ─── DISPATCH ────────────────────────────────────────────────────────────

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg) return;
  if (String(msg.chat?.id) !== String(CHAT_ID)) {
    console.log('[bot] ignored msg from chat', msg.chat?.id);
    return;
  }
  const fileObj = msg.document
    || (Array.isArray(msg.photo) ? msg.photo[msg.photo.length - 1] : null)
    || msg.video || msg.audio;
  if (fileObj?.file_id) return handleStrategyUpload(fileObj, msg.caption || '');
  if (!msg.text) return;

  const text = msg.text.trim();
  const m = /^\/([a-z0-9_-]+)(?:@\w+)?(?:\s+([\s\S]+))?$/i.exec(text);
  if (!m) return runAiChat(text);
  const cmd = '/' + m[1].toLowerCase();
  const arg = m[2] ? m[2].trim() : '';
  const handler = COMMANDS[cmd];
  if (!handler) return send(`Unknown command: \`${cmd}\`\n\nSend \`/help\` for the list.`);
  try { await handler(arg); }
  catch (err) {
    console.error(`[bot] handler ${cmd} threw:`, err.message);
    await send(`⚠️ Error running \`${cmd}\`: ${err.message}`).catch(() => {});
  }
}

// ─── POLL LOOP ───────────────────────────────────────────────────────────

let offset = 0;
let stopped = false;
let pollErrors = 0;
let activeFetch = null; // AbortController for the current getUpdates

async function pollLoop() {
  console.log('[bot] poll loop started');
  startHeartbeat('bot', 10_000, () => ({ offset, pollErrors }));
  while (!stopped) {
    activeFetch = new AbortController();
    try {
      heartbeat('bot', { offset, phase: 'polling' });
      const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}&timeout=25`;
      const res = await fetch(url, { signal: activeFetch.signal });
      if (!res.ok) {
        pollErrors++;
        // 409 = another instance is polling; clear webhook + wait
        if (res.status === 409) {
          console.error('[bot] 409 conflict — another poller is active; pausing 5s');
          await fetch(`https://api.telegram.org/bot${TOKEN}/deleteWebhook?drop_pending_updates=false`).catch(() => {});
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        console.error('[bot] getUpdates', res.status);
        await new Promise((r) => setTimeout(r, Math.min(60000, 1000 * pollErrors)));
        continue;
      }
      pollErrors = 0;
      const data = await res.json();
      for (const u of (data?.result || [])) {
        if (u.update_id >= offset) offset = u.update_id + 1;
        if (u.callback_query) {
          handleCallback(u.callback_query).catch((e) => console.error('[bot] callback threw:', e.message));
        } else {
          handleUpdate(u).catch((e) => console.error('[bot] update threw:', e.message));
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') break;
      pollErrors++;
      console.error('[bot] poll error:', err.message);
      await new Promise((r) => setTimeout(r, Math.min(60000, 2000 * pollErrors)));
    }
  }
  console.log('[bot] poll loop stopped');
}

export function start() {
  if (!loadCreds()) {
    console.error('[bot] missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID — disabled');
    return;
  }
  // Clear any stale webhook so long-poll works (prevents 409 on a fresh boot
  // if the token was ever used with setWebhook elsewhere).
  fetch(`https://api.telegram.org/bot${TOKEN}/deleteWebhook?drop_pending_updates=false`).catch(() => {});
  console.log(`[bot] starting (chat ${CHAT_ID})`);
  pollLoop().catch((e) => console.error('[bot] poll loop crashed:', e.message));
}

export function stop() {
  stopped = true;
  if (activeFetch) { try { activeFetch.abort(); } catch {} }
}

// ─── SHUTDOWN HANDLERS ───────────────────────────────────────────────────
// SIGTERM is what `launchctl kickstart -k` sends. Abort the in-flight long-poll
// and exit immediately so the new instance can claim getUpdates without
// triggering a 409 conflict. The previous design held the 25s fetch open and
// the new bot started polling before the old one released, causing 409 bursts.

function shutdown(signal) {
  console.log(`[bot] ${signal} received — exiting`);
  stop();
  setTimeout(() => process.exit(0), 200); // brief grace for pending heartbeats
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Crash-safety: a buggy handler must not bring the bot down.
process.on('uncaughtException', (err) => console.error('[bot] UNCAUGHT:', err.message, err.stack));
process.on('unhandledRejection', (err) => console.error('[bot] UNHANDLED:', err?.message || err));

// Standalone-entry: when invoked directly (LaunchAgent), bootstrap and run.
if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
