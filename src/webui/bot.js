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
// Auto-discovered from src/strategies/ via lib/strategy_registry.js. Loaded
// once at startup into module-level maps. Numbers are assigned 1..N by
// registry order so /enable <num> still works.

let STRATEGIES = [];          // [{ num, key, name, concept, timeframes }]
let NUM_TO_KEY = {};
let KEY_TO_NUM = {};
let KEY_TO_NAME = {};
let ALL_KEYS = [];

async function loadStrategies() {
  try {
    const { loadRegistry } = await import('../lib/strategy_registry.js');
    const reg = await loadRegistry();
    STRATEGIES = reg.map((s, i) => ({
      num: String(i + 1), key: s.id, name: s.name,
      concept: s.concept, timeframes: s.timeframes,
      window: s.window || 'Any session hour',
    }));
    NUM_TO_KEY = Object.fromEntries(STRATEGIES.map((s) => [s.num, s.key]));
    KEY_TO_NUM = Object.fromEntries(STRATEGIES.map((s) => [s.key, s.num]));
    KEY_TO_NAME = Object.fromEntries(STRATEGIES.map((s) => [s.key, s.name]));
    ALL_KEYS = STRATEGIES.map((s) => s.key);
    console.log(`[bot] loaded ${STRATEGIES.length} strategies from registry`);
  } catch (err) {
    console.error('[bot] strategy registry load failed:', err.message);
  }
}

// ─── CREDENTIALS + ACCESS CONTROL ────────────────────────────────────────
//
//   TOKEN          — bot token.
//   CHAT_ID        — primary signal destination (the shared group, or the
//                    owner's DM before a group is set up).
//   OWNER_ID       — the owner's personal Telegram USER id. Owner-only
//                    commands (enable/disable/mute/restart/…) check this so
//                    friends in the group stay read-only.
//   ALLOWED_CHATS  — every chat the bot accepts commands from (signal group
//                    + owner DM + anything in OCTAVE_ALLOWED_CHATS).

let TOKEN = '', CHAT_ID = '', OWNER_ID = '';
let ALLOWED_CHATS = new Set();

// Commands that change state — restricted to the owner.
const OWNER_ONLY = new Set([
  '/enable', '/disable', '/mute', '/unmute', '/ai-engine', '/aiengine',
  '/restart', '/shutdown', '/fix', '/addstrategy', '/delstrategy', '/clearchat',
  '/ai', '/backtest', '/risk', '/broker', '/cleanup-group',
]);

// Friends in the group chat can only invoke these commands. Anything else
// typed in the group routes the reply to the owner DM (so the friends never
// see private state like account balances). The owner can still use
// everything from the group; the reply just goes to their DM.
const GROUP_ALLOWED_COMMANDS = new Set([
  // Market intel
  '/bias', '/setups', '/setup', '/news', '/price', '/session',
  '/regime', '/levels', '/killzones',
  // Signal history (no account info — just the alert stream)
  '/last', '/today', '/yesterday', '/range', '/summary', '/history',
  // Strategy info (read-only — toggle is owner only via /enable /disable)
  '/strategies', '/playbook',
  // Help / discovery
  '/help', '/menu', '/start', '/chatid', '/id',
]);

function mergedEnv() {
  const env = { ...process.env };
  for (const p of ENV_FILE_CANDIDATES) {
    if (!existsSync(p)) continue;
    try {
      for (const l of readFileSync(p, 'utf8').split('\n')) {
        if (!l.includes('=') || l.trim().startsWith('#')) continue;
        const [k, v] = l.split('=', 2);
        if (env[k.trim()] == null) env[k.trim()] = v.trim();
      }
    } catch {}
  }
  return env;
}

function loadCreds() {
  const env = mergedEnv();
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  TOKEN = env.TELEGRAM_BOT_TOKEN;
  CHAT_ID = env.TELEGRAM_CHAT_ID;
  // Owner = explicit OCTAVE_OWNER_ID, else the original chat id (a DM chat id
  // equals the user's own Telegram user id).
  OWNER_ID = env.OCTAVE_OWNER_ID || CHAT_ID;
  ALLOWED_CHATS = new Set([String(CHAT_ID), String(OWNER_ID)]);
  for (const c of String(env.OCTAVE_ALLOWED_CHATS || '').split(',')) {
    const t = c.trim();
    if (t) ALLOWED_CHATS.add(t);
  }
  return true;
}

/** True if this Telegram user id is the owner. */
function isOwner(userId) { return String(userId) === String(OWNER_ID); }
/** True if the bot should accept commands from this chat. */
function isAllowedChat(chatId) { return ALLOWED_CHATS.has(String(chatId)); }

// ─── TELEGRAM TRANSPORT ──────────────────────────────────────────────────

// Where command replies go. Set per-update to the originating chat so an
// owner command in a private DM doesn't leak its reply into the group.
// Defaults to CHAT_ID (the signal group).
let replyChat = '';
function replyTarget() { return replyChat || CHAT_ID; }

function tgEscape(s) {
  return String(s).replace(/([_*`\[])/g, '\\$1');
}

// Shorthand for eval/risk commands that should ONLY land in the owner DM,
// regardless of which chat invoked them. Usage: `sendOwner(text)`.
async function sendOwner(text, opts = {}) { return send(text, { ...opts, ownerOnly: true }); }

// Telegram's hard cap is 4096 BYTES (UTF-8), not characters. Our messages are
// emoji/box-drawing heavy (✓ █ ─ 🟢 are 3 bytes each), so a char-based cap
// under-counts and still 400s with "message is too long". Cap on bytes, with
// headroom for the keyboard/markup overhead.
const TG_MAX_BYTES = 3900;
const byteLen = (s) => Buffer.byteLength(s, 'utf8');

// Split text into <=TG_MAX_BYTES chunks at line boundaries (never mid-line, so
// Markdown stays balanced per chunk). A single over-long line is hard-split.
function chunkByBytes(text) {
  if (byteLen(text) <= TG_MAX_BYTES) return [text];
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    const candidate = cur ? cur + '\n' + line : line;
    if (byteLen(candidate) <= TG_MAX_BYTES) { cur = candidate; continue; }
    if (cur) { chunks.push(cur); cur = ''; }
    if (byteLen(line) <= TG_MAX_BYTES) { cur = line; continue; }
    // Single line longer than the cap — hard-split on bytes.
    let buf = Buffer.from(line, 'utf8');
    while (buf.length > TG_MAX_BYTES) {
      // Slice on a UTF-8 boundary by decoding a safe prefix.
      let cut = TG_MAX_BYTES;
      while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--; // don't split a multibyte char
      chunks.push(buf.subarray(0, cut).toString('utf8'));
      buf = buf.subarray(cut);
    }
    cur = buf.toString('utf8');
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function send(text, opts = {}) {
  // ownerOnly routes the reply to the owner DM regardless of which chat
  // triggered it. Used for eval/risk commands so friends don't see the
  // owner's account state when they happen to be in the same group.
  const target = opts.ownerOnly ? OWNER_ID : replyTarget();
  const parse_mode = opts.html ? 'HTML' : 'Markdown';
  const post = (payload) => fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch((err) => ({ ok: false, status: 0, text: async () => err.message }));

  // Chunk long output into multiple messages so nothing is lost (the keyboard
  // attaches to the LAST chunk only).
  const chunks = typeof text === 'string' ? chunkByBytes(text) : [String(text)];
  let res;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const body = { chat_id: target, text: chunks[i], parse_mode, disable_web_page_preview: true };
    if (isLast && opts.keyboard) body.reply_markup = { inline_keyboard: opts.keyboard };
    res = await post(body);
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      // Markdown parse failure — never let a stray * / _ / ` swallow a reply.
      // Resend this chunk as plain text so the content still reaches the user.
      if (res.status === 400 && /can't parse entities/i.test(errBody)) {
        const { parse_mode: _pm, ...plain } = body;
        res = await post(plain);
        if (res.ok) { console.warn('[bot] markdown failed — sent plain'); continue; }
        const e2 = await res.text().catch(() => '');
        console.error('[bot] sendMessage (plain retry)', res.status, e2.slice(0, 200));
      } else {
        console.error('[bot] sendMessage', res.status, errBody.slice(0, 200));
      }
    }
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
  const post = (payload) => fetch(`https://api.telegram.org/bot${TOKEN}/editMessageText`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => null);

  let res = await post(body);
  if (res && !res.ok) {
    const t = await res.text().catch(() => '');
    if (/can't parse entities/i.test(t) && body.parse_mode) {
      const { parse_mode, ...plain } = body;
      res = await post(plain);
      if (res && res.ok) return;
    }
    if (!t.includes('not modified')) console.error('[bot] editMessage', res.status, t.slice(0, 200));
  }
}

async function ackCallback(callbackId, text = '') {
  await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: false }),
  }).catch(() => {});
}

/** Upload a local file as a Telegram document. Node 20 has FormData/Blob built-in. */
async function sendDocument(filePath, caption = '') {
  try {
    const bytes = readFileSync(filePath);
    const form = new FormData();
    form.append('chat_id', String(replyTarget()));
    if (caption) { form.append('caption', caption); form.append('parse_mode', 'Markdown'); }
    form.append('document', new Blob([bytes], { type: 'application/pdf' }), filePath.split('/').pop());
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: 'POST', body: form });
    if (!res.ok) {
      console.error('[bot] sendDocument', res.status, (await res.text().catch(() => '')).slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[bot] sendDocument threw:', err.message);
    return false;
  }
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

  const sessLabel = (session.lastSession || 'closed').toUpperCase().replace(/_/g, ' ');
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
  const s = (session.lastSession || 'closed').toUpperCase().replace(/_/g, ' ');
  const open = s !== 'CLOSED' && s !== '—';

  // Live, futures-accurate gold price (Yahoo when fresh, else OANDA spot+basis).
  let goldLine = '';
  try {
    const { getLiveFuturesQuotes } = await import('../lib/cloud_data_supplement.js');
    const g = (await getLiveFuturesQuotes()).get('gold');
    if (g) {
      const tag = g.source === 'oanda+basis' ? ' _(est.)_' : g.stale ? ' _(stale)_' : '';
      goldLine = `Gold: $${g.price.toFixed(2)}${tag}`;
    }
    // No else-fallback: the TV bridge + Yahoo/OANDA cascade in getLiveFuturesQuotes
    // is the source of truth. If it returns nothing, /session just omits the gold
    // line rather than serve a stale value from a dead heartbeat file.
  } catch { /* leave goldLine blank */ }

  await send([
    header(open ? '🟢' : '⚫', `${s} session`),
    `NY time: ${nyHHmm(Date.now())}`,
    goldLine,
  ].filter(Boolean).join('\n'));
}

async function cmdPrice() {
  const { getLiveFuturesQuotes } = await import('../lib/cloud_data_supplement.js');
  const sign = (n) => n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
  let quotes;
  try { quotes = await getLiveFuturesQuotes(); }
  catch { quotes = new Map(); }

  const ORDER = ['gold', 'nasdaq', 'sp'];
  const FALLBACK = {
    gold:   { sym: 'MGC1!', label: 'Micro Gold' },
    nasdaq: { sym: 'MNQ1!', label: 'Micro Nasdaq' },
    sp:     { sym: 'MES1!', label: 'Micro S&P' },
  };
  // Tight one-line-per-instrument layout. Header carries the source; rows
  // carry price + signed change only. Anything stale/estimated gets a 🕒.
  const srcSeen = new Set();
  let anyStale = false, anyEst = false;
  const rows = [];
  for (const key of ORDER) {
    const q = quotes.get(key);
    if (!q) { const f = FALLBACK[key]; rows.push(`⚪ *${f.label.replace('Micro ', '')}* — _no data_`); continue; }
    srcSeen.add(q.source);
    if (q.stale) anyStale = true;
    if (q.source === 'oanda+basis') anyEst = true;
    const dot = q.stale ? '🕒' : (q.change == null ? '⚪' : q.change >= 0 ? '🟢' : '🔴');
    const chg = q.change != null
      ? ` ${sign(q.change)}${q.changePct != null ? ` (${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%)` : ''}`
      : '';
    const label = q.label.replace('Micro ', '');
    rows.push(`${dot} *${label}*  $${q.price.toFixed(2)}${chg}`);
  }
  const srcLabel = quotes.size === 0 ? 'no feed'
    : srcSeen.has('tradingview') ? 'TradingView · live'
    : anyEst ? 'OANDA + basis (CME closed)'
    : anyStale ? '⚠️ stale'
    : 'Yahoo · delayed';
  await send([`💰 *Live prices · ${srcLabel}*`, '', ...rows].join('\n'));
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
          // Live rows only. Without this filter /summary stats include
          // every simulated backtest trade (the file accumulates 25k+ of
          // those for every /backtest run) — daily_report.js does the
          // same filter for the same reason.
          if (t.source !== 'live') continue;
          const ts = Date.parse(t.opened_at || t.ts || '') || 0;
          if (ts >= sinceMs) trades.push(t);
        } catch {}
      }
    }
  } catch {}

  const wins = trades.filter((t) => t.outcome === 'WIN').length;
  const losses = trades.filter((t) => t.outcome === 'LOSS').length;
  // Limit orders that never filled — recorded, but NOT trades. Excluded
  // from the win rate (which is wins ÷ resolved trades only).
  const cancelled = trades.filter((t) => t.outcome === 'CANCELLED').length;
  const sumR = trades.reduce((acc, t) => acc + (+t.result_R || 0), 0);

  const lines = [
    header('📊', days === 1 ? "Today's summary" : `${days}-day summary`),
    '',
    `Alerts: *${alerts.length}* · ${triggered} 🟢 triggered · ${near} 🟠 near · ${formed} 🟡 forming`,
  ];
  if (wins + losses > 0) {
    const wr = ((wins / (wins + losses)) * 100).toFixed(0);
    lines.push(`Trades: *${wins + losses}* filled · ${wins}W / ${losses}L (${wr}%) · ${sumR >= 0 ? '+' : ''}${sumR.toFixed(2)}R`);
  }
  if (cancelled > 0) {
    lines.push(`Cancelled: *${cancelled}* limit${cancelled === 1 ? '' : 's'} never filled _(not counted W/L)_`);
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
  const onCount = STRATEGIES.filter((s) => !!cfg.strategies[s.key]).length;
  const lines = [header('🎚', 'Strategies', `${onCount}/${STRATEGIES.length} active`), ''];
  for (const s of STRATEGIES) {
    const on = !!cfg.strategies[s.key];
    lines.push(`${statusDot(on ? 'ok' : 'off')} \`#${s.num}\` ${tgEscape(s.name)}`);
  }
  // User-added strategies (from file uploads / AI)
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
  lines.push('',
    '_Tap toggles in `/menu` → Strategies, or `/enable <num>` · `/disable <num>`._',
    '_`/killzones` for active windows · `/playbook <num>` for the PDF._');
  await send(lines.join('\n'));
}

/** /killzones — show the time window each strategy hunts in (NY time). */
async function cmdKillzones() {
  const nyNow = nyHHmm(Date.now());
  const nyHour = parseInt(nyNow.split(':')[0], 10);

  // Resolve active/idle from each strategy's window string. A window like
  // "… 02:00-05:00 ET" gives a numeric range; "Any session hour" is always on.
  const rows = STRATEGIES.map((s) => {
    const w = s.window || 'Any session hour';
    const m = w.match(/(\d{2}):\d{2}\s*[-–]\s*(\d{2}):\d{2}/);
    const active = !m || (nyHour >= +m[1] && nyHour < +m[2]);
    return { s, w, active };
  });
  const live = rows.filter((r) => r.active);
  const idle = rows.filter((r) => !r.active);

  const lines = [header('🕐', 'Strategy Killzones', `Now: ${nyNow} ET`), ''];
  lines.push('_The window each strategy hunts for setups. New York time._', '');

  if (live.length) {
    lines.push(section('🟢 Hunting now'));
    for (const r of live) {
      lines.push(`  \`#${r.s.num}\` ${tgEscape(r.s.name)}`);
      lines.push(`       ${tgEscape(r.w)}`);
    }
  }
  if (idle.length) {
    lines.push('', section('⚫ Waiting for their window'));
    for (const r of idle) {
      lines.push(`  \`#${r.s.num}\` ${tgEscape(r.s.name)}`);
      lines.push(`       ${tgEscape(r.w)}`);
    }
  }
  lines.push('',
    '*Reference — NY time*',
    bullet('Asian session  ·  20:00-02:00 ET'),
    bullet('London killzone  ·  02:00-05:00 ET'),
    bullet('NY killzone  ·  07:00-10:00 ET'),
    '',
    '_Gold/futures are closed Fri 17:00 → Sun 18:00 ET._');
  await send(lines.join('\n'));
}

async function cmdEnable(arg) {
  const k = resolveStrategy(arg);
  if (!k) return send(`Usage: \`/enable <num>\` (1-${STRATEGIES.length}) or \`/enable <key>\``);
  await updateConfig((c) => { c.strategies = c.strategies || {}; c.strategies[k] = true; return c; });
  await send(`${statusDot('ok')} *${KEY_TO_NAME[k] || k}* (\`#${KEY_TO_NUM[k] || 'U'}\`) → ENABLED`);
}

async function cmdDisable(arg) {
  const k = resolveStrategy(arg);
  if (!k) return send(`Usage: \`/disable <num>\` (1-${STRATEGIES.length}) or \`/disable <key>\``);
  await updateConfig((c) => { c.strategies = c.strategies || {}; c.strategies[k] = false; return c; });
  await send(`${statusDot('off')} *${KEY_TO_NAME[k] || k}* (\`#${KEY_TO_NUM[k] || 'U'}\`) → disabled`);
}

/** /playbook <num|id> — send the strategy's PDF playbook. */
async function cmdPlaybook(arg) {
  const k = resolveStrategy(arg);
  if (!k) {
    return send([
      header('📘', 'Playbooks'),
      '',
      'Send `/playbook <num>` to get a strategy\'s full PDF.',
      `Example: \`/playbook 1\` → ${KEY_TO_NAME[NUM_TO_KEY['1']] || ''}`,
      '',
      'See `/strategies` for the numbered list.',
    ].join('\n'));
  }
  const pdfPath = join(REPO_DIR, 'playbooks', `${k}.pdf`);
  if (!existsSync(pdfPath)) {
    return send(`📘 No playbook PDF for *${k}* yet. Run the backtest report to generate it.`);
  }
  const ok = await sendDocument(pdfPath, `📘 ${KEY_TO_NAME[k] || k} — playbook + backtest stats`);
  if (!ok) await send('⚠️ Could not send the playbook file.');
}

// ── User strategies (add via file/AI, delete via command — no editing) ──

async function cmdMyStrategies() {
  let items = [];
  try { const us = await import('../lib/user_strategies.js'); items = us.list(); } catch {}
  if (items.length === 0) {
    return send([
      header('👤', 'My strategies'),
      '',
      '_(none added yet)_',
      '',
      section('Adding a strategy is one step'),
      bullet('📎 Send a PDF / image / text file describing the strategy'),
      bullet('💬 Or just describe it to me in plain English'),
      '',
      'The AI extracts the rules and adds it automatically.',
    ].join('\n'));
  }
  const cfg = loadConfig() || {};
  const lines = [header('👤', 'My strategies'), ''];
  for (const it of items) {
    const on = cfg.strategies?.[it.id] !== false;
    lines.push(`${statusDot(on ? 'ok' : 'off')} \`${tgEscape(it.id)}\` · ${tgEscape(it.name)}`);
  }
  lines.push('', '_Delete: `/delstrategy <id>` · Add: send a file or describe it._');
  await send(lines.join('\n'));
}

async function cmdAddStrategy() {
  await send([
    header('➕', 'Add a strategy'),
    '',
    'Two simple ways — no forms, no parameters:',
    '',
    bullet('📎 *Send a file* — PDF, image, or text describing the strategy. The AI reads it and builds the strategy.'),
    bullet('💬 *Just describe it* — e.g. "add a strategy that buys when RSI drops below 30 on the 1h and price is above the 200 EMA".'),
    '',
    'Either way it\'s added enabled and starts watching immediately.',
    '_Remove one anytime with `/delstrategy <id>`._',
  ].join('\n'));
}

async function cmdDelStrategy(arg) {
  const id = (arg || '').trim().replace(/^['"]|['"]$/g, '');
  if (!id) return send('Usage: `/delstrategy <id>` — see `/mystrategies` for ids.');
  try {
    const us = await import('../lib/user_strategies.js');
    us.remove(id);
    await updateConfig((c) => { c.strategies = c.strategies || {}; delete c.strategies[id]; return c; });
    await send(`🗑 Deleted \`${tgEscape(id)}\``);
  } catch (err) { await send(`⚠️ ${err.message}`); }
}

// ── Settings ──

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

  // Bare `/backtest` → serve the nightly-cached 30-day result instantly. The
  // VPS is too slow to run a 30-day backtest live within the command window.
  if (parts.length === 0 || (parts.length === 1 && /^(latest|cached)$/i.test(parts[0]))) {
    const cache = readJson(join(STATE_DIR, 'backtest-cache.json'), null);
    if (cache?.tg) {
      const ageH = Math.round((Date.now() - cache.generatedAt) / 3_600_000);
      return send(`${cache.tg}\n\n_Cached ${cache.days}-day result · refreshed ${ageH}h ago. For a live run: \`/backtest <days>\` or \`/backtest <strategy>\`._`);
    }
    return send('📊 No cached backtest yet — the nightly run hasn\'t produced one. Use `/backtest 14` for a live run.');
  }

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
  // A live full run of >14 days won't finish within the timeout on the VPS.
  if (!strategy && days > 14) {
    return send(`⏳ A live ${days}-day all-strategy backtest is too slow for the VPS (it would time out).\n\nUse \`/backtest\` (no number) for the cached 30-day result, or \`/backtest ${days} <strategy>\` for one strategy.`);
  }
  await send(`⏳ Running ${days}-day backtest${strategy ? ` for *${strategy}*` : ' for all enabled strategies'}…\n_Runs in isolated process; bot stays responsive._`);

  // Hard heap cap so the backtest can never exhaust RAM and thrash the VPS
  // into swap. If a run genuinely needs more it crashes cleanly (the bot is a
  // separate process and survives) instead of taking the box down.
  const args = ['--max-old-space-size=320', 'scripts/run-backtest-child.js', '--days', String(days)];
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

  const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 12 * 60 * 1000);

  child.on('exit', async (code, signal) => {
    clearTimeout(killTimer);
    if (signal === 'SIGKILL' && !resultRow) return send('⚠️ Backtest timed out (>12min) — killed. Bot is fine; try a smaller window.');
    if (resultRow?.error) return send(`⚠️ Backtest failed: \`${resultRow.error}\``);
    if (tgMessage) return send(tgMessage);
    if (resultRow?.ok) return send(`✅ Backtest done (${Math.round((resultRow.durationMs || 0) / 1000)}s) — no summary produced.`);
    return send(`⚠️ Backtest exited code ${code}${signal ? ` (${signal})` : ''}.\nStderr:\n\`\`\`\n${(stderrBuf || '').slice(-500)}\n\`\`\``);
  });
  child.on('error', (err) => { clearTimeout(killTimer); send(`⚠️ Could not spawn: ${err.message}`); });
}

// ── Bias / setup / news ──

/**
 * Get the latest detect() results. Reads the signal-engine's live snapshot
 * (refreshed every 3s) — instant, no spawn. Only falls back to a child
 * process if the snapshot is missing or stale (signal-engine down).
 */
async function runDetectChild() {
  const snap = readJson(join(STATE_DIR, 'last-detect.json'), null);
  if (snap && Array.isArray(snap.results) && (Date.now() - (snap.at || 0)) < 120_000) {
    return { results: snap.results, fromSnapshot: true };
  }
  // Fallback — signal-engine snapshot missing/stale. Spawn a fresh detect
  // with a generous timeout (the VPS can be slow under load).
  const script = join(REPO_DIR, 'scripts', 'run-detect-child.js');
  if (!existsSync(script)) {
    return { error: 'signal engine has no recent data and the detect runner is missing' };
  }
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
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 75_000);
    child.on('exit', (code) => {
      clearTimeout(kill);
      if (result) return resolve(result);
      resolve({ error: 'detect is busy — the signal engine is catching up. Try again in a few seconds.' });
    });
    child.on('error', (e) => { clearTimeout(kill); resolve({ error: e.message }); });
  });
}

async function cmdBias() {
  // Combined bias = structural multi-TF read + live strategy vote. Engine
  // re-stamps this on every detector tick (every 3s, even on cache hits).
  const snap = readJson(join(STATE_DIR, 'last-bias.json'), null);
  if (!snap || !snap.bias || (Date.now() - (snap.at || 0)) > 180_000) {
    return send('🧭 Bias data not ready — the signal engine is still warming up. Try again in a moment.');
  }

  // Overlay the LIVE TV-bridge futures price into the bias 'price' field for
  // display. The bias DIRECTION still comes from OANDA (basis cancels for
  // direction, and OANDA carries the deeper history needed for the vol-regime
  // factor), but the DISPLAYED price should match the contract the user
  // trades — otherwise /bias looks 'stuck on 4570' while futures are at 4574.
  try {
    const { getLiveFuturesQuotes } = await import('../lib/cloud_data_supplement.js');
    const quotes = await getLiveFuturesQuotes();
    for (const [key, q] of quotes) {
      if (snap.bias[key] && q?.source === 'tradingview' && Number.isFinite(q.price)) {
        snap.bias[key].price = q.price;
        snap.bias[key].priceSource = 'tradingview';
      }
    }
  } catch { /* keep OANDA-priced bias if the live quote fails */ }

  const INSTRUMENTS = [
    { key: 'gold',   label: 'GOLD',   sym: 'MGC1!' },
    { key: 'nasdaq', label: 'NASDAQ', sym: 'MNQ1!' },
    { key: 'sp',     label: 'S&P',    sym: 'MES1!' },
  ];
  const ICON = { BULLISH: '🟢', BEARISH: '🔴', NEUTRAL: '⚪', MIXED: '🟠' };
  // Strength icon based on signed magnitude (was binary +1/-1/0).
  const fIcon = (v) => {
    const a = Math.abs(v || 0);
    if (a < 0.15) return '⚪';
    if (v > 0) return a > 0.6 ? '🟢' : '🟡';
    return a > 0.6 ? '🔴' : '🟠';
  };
  const sign = (n) => (n > 0 ? '+' : '') + n.toFixed(2);

  // Data staleness — the bias read is only meaningful if the underlying bars
  // are current. 45min = 3× the 15m bar cadence, so a normal "last closed bar"
  // (up to ~15-30min old) never trips it, but a frozen weekend/holiday feed does.
  const STALE_MS = 45 * 60 * 1000;
  const fmtAge = (ms) => {
    if (ms == null || !Number.isFinite(ms)) return '?';
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  };
  const isStale = (b) => b?.dataAgeMs != null && b.dataAgeMs > STALE_MS;
  const ages = INSTRUMENTS.map((i) => snap.bias[i.key]?.dataAgeMs).filter((a) => a != null);
  const freshestAge = ages.length ? Math.min(...ages) : null;
  const allStale = ages.length > 0 && freshestAge > STALE_MS;

  // Compact bias: one row per instrument with the essentials. Full structural
  // factor breakdown is kept under /bias detail (handled below).
  const detail = false;  // future: parse arg for '/bias detail'
  const lines = [header('🧭', 'Bias'), ''];
  if (allStale) lines.push(`🕒 _freshest feed ${fmtAge(freshestAge)} old · last-known direction shown_`, '');
  for (const inst of INSTRUMENTS) {
    const b = snap.bias[inst.key];
    if (!b) { lines.push(`⚪ *${inst.label}* — no data`); continue; }
    const dir = b.combined?.direction || b.direction || 'NEUTRAL';
    const stale = isStale(b);
    const icon = stale ? '🕒' : (ICON[dir] || '⚪');
    const conf = b.confidence != null ? `${b.confidence}%` : '—';
    const chg = b.intradayChange != null
      ? `${b.intradayChange >= 0 ? '+' : ''}${b.intradayChange.toFixed(2)}`
      : '';
    // One line: ICON LABEL  $price  DIRECTION conf%  ±chg
    lines.push(`${icon} *${inst.label}*  $${b.price.toFixed(2)}  · ${dir} ${conf}${chg ? ' · ' + chg + ' today' : ''}`);
    // Detail mode: keep the existing deep breakdown (factors, vote, etc).
    if (detail) {
      const combinedLabel = b.combined?.label ? ` · _${tgEscape(b.combined.label)}_` : '';
      const staleTag = stale ? ` · _stale ${fmtAge(b.dataAgeMs)}_` : '';
      lines.push(`   ${dir}${combinedLabel}${staleTag}`);
      const factorLines = b.factors.map((f) => `${fIcon(f.v)} ${tgEscape(f.label)} ${sign(f.v)}`);
      for (let i = 0; i < factorLines.length; i += 2) {
        lines.push(`     ${factorLines[i]}${factorLines[i + 1] ? '   ·   ' + factorLines[i + 1] : ''}`);
      }
      const vote = b.strategyVote || {};
      if ((vote.candidates || []).length) {
        const top = vote.candidates.slice(0, 3).map((c) => `${c.direction === 'LONG' ? '🟢' : '🔴'}${tgEscape(c.strategy)} ${Math.round(c.closeness * 100)}%`);
        lines.push('   ' + top.join(' · '));
      }
    }
  }
  await send(lines.join('\n'));
}

async function cmdActiveSetups() {
  // Three sections: open positions (follow-up tracker), live forming setups
  // (precheck snapshot from the signal engine), signals fired today.
  let open = [];
  try { const fu = await import('../lib/follow_up.js'); open = fu.active(); } catch {}

  const todayKey = nyDateKey(Date.now());
  // Only count signals actually DELIVERED to Telegram (telegram:'sent') — a
  // setup that triggered but was confidence-gated or muted was NOT sent to the
  // user, so listing it under "Signals fired today" was misleading.
  const fired = readAlerts({ limit: 200 })
    .filter((a) => a.status === 'triggered' && a.telegram === 'sent' && nyDateKey(a.time) === todayKey);

  // Live precheck — what each strategy is watching RIGHT NOW. The signal
  // engine re-stamps this every tick (3s) so a stale read just means the
  // engine is restarting. Older than 3 min → treat as missing.
  const precheckSnap = readJson(join(STATE_DIR, 'last-precheck.json'), null);
  const precheckFresh = precheckSnap && (Date.now() - (precheckSnap.at || 0)) <= 180_000;
  const precheckRows = precheckFresh ? (precheckSnap.rows || []) : [];

  const INST = { gold: 'GOLD', nasdaq: 'NASDAQ', sp: 'S&P' };
  const lines = [header('🎯', 'Setups')];

  // Compact /setups: one-liner per item across three sections.
  if (open.length) {
    lines.push('', `*Open · ${open.length}*`);
    for (const s of open) {
      const dir = s.direction === 'LONG' ? '🟢' : '🔴';
      const stage = Object.keys(s.milestonesFired || {}).filter((m) => m !== 'be').pop()?.toUpperCase()
        || (s.milestonesFired?.be ? 'BE' : 'live');
      lines.push(`${dir} *${tgEscape(s.strategy || '?')}* ${(s.instrument || '').toUpperCase()} · @${s.entry} · ${stage}`);
    }
  }

  if (precheckRows.length) {
    const ranked = precheckRows
      .map((r) => {
        const conds = r.conditions || [];
        const gates = conds.filter((c) => c.kind === 'gate');
        const triggers = conds.filter((c) => c.kind === 'trigger');
        const gatesOk = gates.length > 0 && gates.every((c) => c.met);
        const tMet = triggers.filter((c) => c.met).length;
        const tTotal = triggers.length || 1;
        return { ...r, gatesOk, tMet, tTotal, closeness: gatesOk ? tMet / tTotal : 0 };
      })
      .filter((r) => r.gatesOk)
      .sort((a, b) => b.closeness - a.closeness || a.strategy.localeCompare(b.strategy));

    if (ranked.length) {
      lines.push('', `*Forming · ${ranked.length}*`);
      for (const r of ranked.slice(0, 6)) {
        const inst = INST[r.instrument] || r.instrument;
        const dir = r.direction === 'LONG' ? '🟢' : r.direction === 'SHORT' ? '🔴' : '⚪';
        const stage = r.tMet === r.tTotal ? '🟢 READY' : r.tMet >= r.tTotal - 1 ? '🟠 NEAR' : '🟡 forming';
        const proj = r.projection
          ? ` · E${r.projection.entry.toFixed(2)} SL${r.projection.stop.toFixed(2)} TP${r.projection.t2.toFixed(2)} (1:${r.projection.rr2.toFixed(1)}R)`
          : '';
        lines.push(`${dir} *${tgEscape(r.strategy)}* ${inst} · ${stage}${proj}`);
      }
    }
  } else if (precheckSnap && !precheckFresh) {
    lines.push('', '_engine catching up…_');
  }

  if (fired.length) {
    const seen = new Set();
    const uniq = fired.filter((a) => { if (seen.has(a.setupId)) return false; seen.add(a.setupId); return true; });
    lines.push('', `*Fired today · ${uniq.length}*`);
    for (const a of uniq.slice(0, 8)) {
      const inst = INST[String(a.setupId || '').split('|')[0]] || '?';
      lines.push(`\`${nyHHmm(a.time)}\` ${inst} · ${tgEscape(a.strategy)} · ${Math.round((a.confidence || 0) * 100)}%`);
    }
  }

  if (!open.length && !precheckRows.length && !fired.length) {
    lines.push('', '_Nothing forming. `/bias` for current lean._');
  } else {
    lines.push('', '_`/setup <num>` for a strategy\'s live detail · `/bias` for direction._');
  }
  await send(lines.join('\n'));
}

async function cmdSetup(arg) {
  const key = resolveStrategy(arg);
  if (!key) return send('Usage: `/setup <num>` or `/setup <key>` (e.g. `LONDON-SWEEP`)');

  // Read the same precheck snapshot /setups uses — single source of truth.
  // 3-min freshness gate matches the bias snapshot rule.
  const snap = readJson(join(STATE_DIR, 'last-precheck.json'), null);
  const fresh = snap && (Date.now() - (snap.at || 0)) <= 180_000;
  if (!snap || !fresh) {
    return send(`🔍 *${tgEscape(key)}* · live diagnostics not ready — signal engine still warming up. Try again in a moment.`);
  }
  const rows = (snap.rows || []).filter((r) => r.strategy === key);
  if (rows.length === 0) {
    return send(`#${KEY_TO_NUM[key] || 'U'} *${tgEscape(key)}* · not running on any instrument right now. \`/strategies\` shows the enabled list.`);
  }

  const INST = { gold: 'GOLD', nasdaq: 'NASDAQ', sp: 'S&P' };
  // Stage + closeness for each instrument row, same scoring as /setups.
  const rendered = rows.map((r) => {
    const conds = r.conditions || [];
    const gates = conds.filter((c) => c.kind === 'gate');
    const triggers = conds.filter((c) => c.kind === 'trigger');
    const gatesOk = gates.length > 0 && gates.every((c) => c.met);
    const gMet = gates.filter((c) => c.met).length;
    const tMet = triggers.filter((c) => c.met).length;
    const tTot = triggers.length || 1;
    let stage, icon;
    if (!gatesOk) { stage = 'BLOCKED'; icon = '⚪'; }
    else if (tMet === tTot) { stage = 'READY'; icon = '🟢'; }
    else if (tMet >= tTot - 1) { stage = 'NEAR'; icon = '🟠'; }
    else { stage = 'FORMING'; icon = '🟡'; }
    return { ...r, gates, triggers, gatesOk, gMet, tMet, tTot, stage, icon };
  });

  // Sort: gate-passing rows first (by closeness), then blocked rows (by gates met).
  rendered.sort((a, b) => {
    if (a.gatesOk !== b.gatesOk) return a.gatesOk ? -1 : 1;
    if (a.gatesOk) return (b.tMet / b.tTot) - (a.tMet / a.tTot);
    return (b.gMet / b.gates.length) - (a.gMet / a.gates.length);
  });

  const lines = [header('🔍', `#${KEY_TO_NUM[key] || 'U'} ${key}`)];

  // Show every instrument row with full gate + trigger detail so the user
  // sees exactly what's met and what's blocking, per instrument.
  for (const r of rendered) {
    const inst = INST[r.instrument] || r.instrument;
    const dir = r.direction === 'LONG' ? '🟢 LONG' : r.direction === 'SHORT' ? '🔴 SHORT' : '⚪ —';
    lines.push('');
    lines.push(`${r.icon} *${inst}* · ${dir} · _${r.stage}_ · gates ${r.gMet}/${r.gates.length} · triggers ${r.tMet}/${r.tTot}`);
    if (r.projection) {
      const p = r.projection;
      lines.push(`   📐 \`E ${p.entry.toFixed(2)}\` · \`SL ${p.stop.toFixed(2)}\` · \`TP1 ${p.t1.toFixed(2)}\` (${p.rr1.toFixed(1)}R) · \`TP2 ${p.t2.toFixed(2)}\` (${p.rr2.toFixed(1)}R) · risk ${p.risk.toFixed(2)}`);
    }
    if (r.gates.length) {
      lines.push('   *Gates*');
      for (const c of r.gates) {
        const ic = c.met ? '✅' : '⛔';
        const val = c.value ? ` _${tgEscape(String(c.value))}_` : '';
        lines.push(`   ${ic} ${tgEscape(c.label)}${val}`);
      }
    }
    if (r.triggers.length) {
      lines.push('   *Triggers*');
      for (const c of r.triggers) {
        const ic = c.met ? '✅' : '⏳';
        const val = c.value ? ` _${tgEscape(String(c.value))}_` : '';
        lines.push(`   ${ic} ${tgEscape(c.label)}${val}`);
      }
    }
  }

  // If any row is fully READY, attempt to attach the chart image — pulled
  // from the actual triggered detect snapshot which has the entryPlan.
  let chartUrl = null;
  const readyRow = rendered.find((r) => r.stage === 'READY');
  if (readyRow) {
    try {
      const det = await runDetectChild();
      const match = (det.results || []).find((x) => x.strategy === key && x.instrument === readyRow.instrument && x.entryPlan);
      if (match) {
        const m = await import('../lib/chart_image.js');
        chartUrl = await m.buildAlertChartUrl(match);
      }
    } catch {}
  }

  lines.push('', `_\`/playbook ${KEY_TO_NUM[key] || key}\` for the full ruleset · \`/setups\` for all strategies._`);

  if (chartUrl) {
    const text = lines.join('\n');
    const caption = text.length <= 1024 ? text : text.slice(0, 980) + '…';
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: replyTarget(), photo: chartUrl, caption, parse_mode: 'Markdown' }),
    }).catch(() => {});
    if (text.length > 1024) await send(text);
  } else await send(lines.join('\n'));
}

async function cmdNews(arg) {
  const newsLib = await import('../lib/news.js');
  const { upcomingEvents, checkBlackout, refreshForexFactory, nextEvent, recentReleases, parseEconNumber, eventDirectionRule } = newsLib;
  // Don't force-refresh — FF rate-limits hard (429) on repeated calls. The
  // 30-min TTL keeps the cache fresh enough; in-process setInterval also
  // pulls every 30 min in the background.
  await refreshForexFactory(false).catch(() => {});
  const argTrim = (arg || '').trim().toLowerCase();
  const showAll = argTrim === 'all';
  const showHighOnly = argTrim === 'high' || argTrim === 'h';
  const hours = showAll || showHighOnly ? 168
    : Math.max(1, Math.min(168, parseInt(argTrim, 10) || 48));
  const now = Date.now() / 1000;
  const bo = checkBlackout(now, 30);
  let evs = upcomingEvents(now, hours);
  if (showHighOnly) evs = evs.filter((e) => e.impact === 'high');

  const fmtTime = (u) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(u * 1000));
  const fmtDayHeader = (u) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
  }).format(new Date(u * 1000));
  const todayKey = fmtDayHeader(now);
  const fmtCountdown = (mins) => {
    if (mins < 0) return `${Math.abs(mins)}m ago`;
    if (mins < 60) return `in ${mins}m`;
    if (mins < 1440) return `in ${(mins / 60).toFixed(1)}h`;
    return `in ${(mins / 1440).toFixed(1)}d`;
  };
  const folder = (impact) => ({ high: '🔴', medium: '🟠', low: '🟡' }[impact] || '⚪');

  // Compute surprise direction for a released event. Returns:
  //   { dir: 'usd_up'|'usd_down'|'neutral', pct: number|null, words: string }
  const surpriseOf = (ev) => {
    if (!ev.actual) return null;
    const rule = eventDirectionRule(ev.title);
    if (!rule) return { dir: 'neutral', pct: null, words: 'released' };
    const a = parseEconNumber(ev.actual);
    const f = parseEconNumber(ev.forecast);
    if (a == null || f == null) return { dir: 'neutral', pct: null, words: 'released' };
    const beat = a > f;
    const usdPositive = (rule === 'usd_pos' && beat) || (rule === 'usd_neg' && !beat);
    const usdNegative = (rule === 'usd_pos' && !beat) || (rule === 'usd_neg' && beat);
    const deltaPct = f !== 0 ? ((a - f) / Math.abs(f)) * 100 : null;
    return {
      dir: usdPositive ? 'usd_up' : usdNegative ? 'usd_down' : 'neutral',
      pct: deltaPct,
      words: usdPositive ? '↑ USD (gold ↓ likely)' : usdNegative ? '↓ USD (gold ↑ likely)' : 'released',
    };
  };

  // ── Header: live blackout state with countdown ───────────────────────────
  const lines = [header('📰', 'News watch'), ''];
  if (bo.blocked && bo.event) {
    const direction = bo.event.unix > now ? 'in' : 'ago';
    lines.push(`🚫 *BLACKOUT · bot paused*`);
    lines.push(`   ${tgEscape(bo.event.title)} · ${direction === 'in' ? 'in ' : ''}${bo.minutesAway}m${direction === 'ago' ? ' ago' : ''}`);
    if (bo.event.forecast || bo.event.previous) {
      const fp = [bo.event.forecast && `fc ${bo.event.forecast}`, bo.event.previous && `prev ${bo.event.previous}`].filter(Boolean).join(' · ');
      lines.push(`   _${tgEscape(fp)}_`);
    }
  } else {
    lines.push(`✅ *Trading freely* — no high-impact within 30m`);
  }

  // ── Next high-impact (and exact pause window) ────────────────────────────
  const nxt = nextEvent(now);
  if (nxt) {
    const pauseStart = fmtTime(nxt.unix - 30 * 60);
    const pauseEnd = fmtTime(nxt.unix + 30 * 60);
    lines.push('', section('⏳ Next high-impact'));
    lines.push(`🔴 *${tgEscape(nxt.title)}* — ${fmtCountdown(nxt.minutesAway)} (${fmtTime(nxt.unix)} ET)`);
    const data = [
      nxt.forecast && `fc *${tgEscape(nxt.forecast)}*`,
      nxt.previous && `prev ${tgEscape(nxt.previous)}`,
    ].filter(Boolean).join(' · ');
    if (data) lines.push(`   ${data}`);
    lines.push(`   _Bot pauses ${pauseStart}–${pauseEnd} ET_`);
  }

  // ── Recent releases (last 24h) — beat/miss + USD direction ──────────────
  const released = recentReleases(now, 24).slice(0, 5);
  if (released.length) {
    lines.push('', section('📊 Recent releases'));
    for (const ev of released) {
      const s = surpriseOf(ev);
      const arrow = s?.dir === 'usd_up' ? '🟢' : s?.dir === 'usd_down' ? '🔴' : '⚪';
      const pct = s?.pct != null ? ` (${s.pct >= 0 ? '+' : ''}${s.pct.toFixed(1)}% vs fc)` : '';
      lines.push(`${arrow} \`${fmtTime(ev.unix)}\` *${tgEscape(ev.title)}*`);
      const parts = [
        ev.actual && `act *${tgEscape(ev.actual)}*`,
        ev.forecast && `fc ${tgEscape(ev.forecast)}`,
        ev.previous && `prev ${tgEscape(ev.previous)}`,
      ].filter(Boolean).join(' · ');
      lines.push(`   ${parts}${pct ? ' · ' + tgEscape(pct) : ''}`);
      if (s?.words && s.words !== 'released') lines.push(`   _${tgEscape(s.words)}_`);
    }
  }

  // ── Upcoming events grouped by day ───────────────────────────────────────
  if (!showHighOnly && !showAll) evs = evs.filter((e) => e.impact !== 'low'); // default: high+medium
  const byDay = new Map();
  for (const ev of evs) {
    const key = fmtDayHeader(ev.unix);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }

  if (byDay.size === 0) {
    lines.push('', '_No events in this window._');
  } else {
    const label = showAll ? 'All upcoming · 7d'
      : showHighOnly ? '🔴 High-impact · 7d'
      : `Upcoming · ${hours}h`;
    lines.push('', section(label));
    for (const [day, dayEvents] of byDay) {
      lines.push(`*${day === todayKey ? 'TODAY' : day.toUpperCase()}*`);
      for (const ev of dayEvents) {
        const mins = Math.round((ev.unix - now) / 60);
        const cd = mins < 1440 ? ` _${fmtCountdown(mins)}_` : '';
        const fp = [ev.forecast && `fc ${ev.forecast}`, ev.previous && `prev ${ev.previous}`].filter(Boolean).join(' · ');
        const fpLine = fp ? ` · ${tgEscape(fp)}` : '';
        lines.push(`${folder(ev.impact)} \`${fmtTime(ev.unix)}\` ${tgEscape(ev.title)}${cd}${fpLine}`);
      }
    }
  }

  lines.push('',
    '🔴 high · 🟠 medium · 🟡 low  ·  bot auto-pauses ±30m around 🔴',
    '_`/news` 48h hi+med · `/news 24` short window · `/news high` 🔴-only 7d · `/news all` everything 7d_');
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
  ai.clearSession(replyTarget());
  await send('🧹 Chat memory cleared. Next message starts a fresh thread.');
}

async function runAiChat(userText) {
  const chat = replyTarget();
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendChatAction`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, action: 'typing' }),
    });
  } catch {}
  try {
    const ai = await import('../lib/ai_chat.js');
    const reply = await ai.chat(chat, userText);
    await send(reply);
  } catch (err) {
    await send(`⚠️ AI error: ${err.message}\n\nFalls back to commands — send \`/help\`.`);
  }
}

// ── System ──

// Service name → (linux systemd unit, mac launchd label). Keep in sync with
// the LINUX_UNITS / MAC_LABELS maps in webui/server.js /api/restart.
const SERVICE_LABELS = {
  signal:    { linux: 'octave-signal-engine', mac: 'com.jqvier.trading-alerts' },
  signals:   { linux: 'octave-signal-engine', mac: 'com.jqvier.trading-alerts' },
  bot:       { linux: 'octave-telegram',      mac: 'com.jqvier.octave-telegram' },
  telegram:  { linux: 'octave-telegram',      mac: 'com.jqvier.octave-telegram' },
  webui:     { linux: 'octave-webui',         mac: 'com.jqvier.octave-webui' },
  dashboard: { linux: 'octave-webui',         mac: 'com.jqvier.octave-webui' },
  watchdog:  { linux: 'octave-watchdog',      mac: 'com.jqvier.octave-watchdog' },
};

function restartUnit(unit) {
  if (process.platform === 'linux') {
    spawn('systemctl', ['restart', unit.linux], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${unit.mac}`], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function cmdRestart(arg) {
  const key = (arg || 'all').trim().toLowerCase();
  if (key === 'all') {
    await send('🔄 Restarting all services…');
    // Each entry only restarted once — the map has aliases so dedupe by unit.
    const seen = new Set();
    for (const u of Object.values(SERVICE_LABELS)) {
      const k = u.linux;
      if (seen.has(k)) continue;
      seen.add(k);
      restartUnit(u);
    }
    return setTimeout(cmdHealth, 5000);
  }
  const unit = SERVICE_LABELS[key];
  if (!unit) return send('Unknown service. Try: `/restart all` · `/restart bot` · `/restart signals` · `/restart webui` · `/restart watchdog`');
  await send(`🔄 Restarting *${key}*…`);
  restartUnit(unit);
  setTimeout(cmdHealth, 4000);
}

// ── Eval / paper-trading commands ──

async function cmdAccount(arg) {
  const rm = await import('../lib/risk_manager.js');
  const at = await import('../lib/account_tracker.js');
  at.maybeRollDay();
  const which = (arg || '').toLowerCase().trim();
  const ids = at.ACCOUNT_IDS.includes(which) ? [which] : at.ACCOUNT_IDS;
  const lines = [header('🏦', 'Lucid Flex 50k status')];
  for (const id of ids) {
    const acc = at.get(id);
    const st = rm.evalStatus(acc);
    lines.push('');
    lines.push(`*${id.toUpperCase()}* · ${acc.mode} · ${acc.enabled ? '🟢 active' : '⚫ disabled'} · ${st.phase}`);
    lines.push('```');
    lines.push(`Balance        $${st.balance.toFixed(2)}`);
    lines.push(`Peak (EOD)     $${st.peakEod.toFixed(2)}`);
    lines.push(`Profit         $${st.profit.toFixed(2)}  (target $${rm.EVAL_RULES.profitTarget})`);
    lines.push(`DD from peak   $${st.ddFromPeakEod.toFixed(2)}  (cap $${rm.EVAL_RULES.maxDrawdown}, ${st.ddRemaining.toFixed(0)} remaining)`);
    lines.push(`Today P&L      $${st.dailyPnl.toFixed(2)}`);
    if (st.phase === 'eval') {
      lines.push(`Consistency    largest day $${st.largestProfitableDay.toFixed(0)} / $${st.consistencyCap} cap`);
      lines.push(`               today has $${st.consistencyRoom.toFixed(0)} room before cap`);
      lines.push(`Circuit-break  $${rm.EVAL_RULES.dailyCircuitBreaker}/day (our safety)`);
    } else {
      lines.push(`Max payout     $${st.maxPayoutRequest.toFixed(0)}  (50% of profit, capped $${rm.PAYOUT_RULES.maxRequestUsd})`);
      lines.push(`Payout floor   $${rm.PAYOUT_RULES.minRequestUsd}`);
    }
    lines.push(`Open trades    ${st.openTrades}`);
    lines.push(`Closed trades  ${acc.closedTrades}   W:${acc.wins} L:${acc.losses}`);
    lines.push(`Status         ${st.passed ? '✅ PASSED' : st.blown ? '🛑 BLOWN' : '🟡 in progress'}`);
    if (acc.rulesViolated.length) lines.push(`Violations     ${acc.rulesViolated.join(', ')}`);
    lines.push('```');
  }
  await sendOwner(lines.join('\n'));
}

async function cmdRisk(arg) {
  const at = await import('../lib/account_tracker.js');
  const ID = at.ACCOUNT_IDS[0];  // single account
  // Single-account era: `auto` is a deprecated alias accepted silently.
  const parts = (arg || '').toLowerCase().trim().split(/\s+/)
    .map((p) => p === 'auto' ? ID : p)
    .filter(Boolean);

  // /risk            → show
  // /risk on         → enable
  // /risk off        → disable
  // /risk live       → live mode (requires webhook)
  // /risk paper      → paper mode
  // /risk funded     → mark account as funded
  // /risk eval       → mark account back to eval
  // /risk per 250    → set risk-per-trade USD
  // /risk reset      → wipe back to fresh $50k
  if (parts.length === 0 || parts[0] === '' || parts[0] === 'status') {
    const a = at.get(ID);
    return sendOwner([
      header('⚙️', 'Risk control'),
      '',
      `*${ID.toUpperCase()}*  ${a.enabled ? '🟢 active' : '⚫ disabled'} · ${a.mode} · ${a.phase}`,
      '',
      'Commands:',
      bullet('`/risk on` · `/risk off` — enable/disable'),
      bullet('`/risk paper` · `/risk live` — switch mode'),
      bullet('`/risk eval` · `/risk funded` — phase'),
      bullet('`/risk per 250` — set risk-per-trade USD'),
      bullet('`/risk reset` — wipe back to fresh $50k'),
    ].join('\n'));
  }
  if (parts[0] === 'on')  { at.setEnabled(ID, true);  return sendOwner('🟢 enabled'); }
  if (parts[0] === 'off') { at.setEnabled(ID, false); return sendOwner('⚫ disabled'); }
  if (parts[0] === 'per' && parts[1]) {
    const pt = await import('../lib/paper_trader.js');
    pt.setRiskPerTrade(Number(parts[1]));
    return sendOwner(`risk per trade set to $${pt.getRiskPerTrade()}`);
  }
  if (parts[0] === 'reset' || (parts[0] === 'reset' && parts[1] === ID)) {
    at.reset(ID);
    return sendOwner(`account reset to fresh $50k`);
  }
  if (parts[0] === 'paper' || parts[0] === 'live') {
    if (parts[0] === 'live') {
      const le = await import('../lib/live_executor.js');
      const cfg = le.getConfig();
      if (!cfg.webhooks[ID] && parts[1] !== 'force') {
        return sendOwner([
          `⚠️ *live mode refused* — no webhook configured`,
          '',
          `Configure first:  \`/broker set-url <https-url>\``,
          `Test it:          \`/broker test\``,
          `Then enable:      \`/risk live\``,
          '',
          `Override (no execution until webhook set):`,
          `  \`/risk live force\``,
        ].join('\n'));
      }
    }
    at.setMode(ID, parts[0]);
    return sendOwner(`mode → *${parts[0]}*${parts[0] === 'live' ? '\n🚀 Live execution active. Every passing signal will fire to broker.' : ''}`);
  }
  if (parts[0] === 'funded' || parts[0] === 'eval') {
    const acc = at.get(ID);
    if (acc) acc.phase = parts[0];
    return sendOwner(`phase → *${parts[0]}*\n${parts[0] === 'funded' ? 'Consistency rule + circuit breaker waived. Only EOD trailing DD enforced.' : 'Eval rules re-active.'}`);
  }
  // Backward-compat: `/risk <id> <subcmd>` where id was 'user' or 'auto'.
  if (parts[0] === ID && parts[1]) {
    return cmdRisk(parts.slice(1).join(' '));
  }
  return sendOwner('unrecognized — try `/risk` with no args for help');
}

async function cmdPaper() {
  const at = await import('../lib/account_tracker.js');
  at.maybeRollDay();
  const lines = [header('📑', 'Paper trader status')];
  for (const id of at.ACCOUNT_IDS) {
    const acc = at.get(id);
    if (!acc.enabled) { lines.push(`*${id}* — disabled (\`/risk ${id} on\` to start)`); continue; }
    lines.push('');
    lines.push(`*${id.toUpperCase()}* — ${acc.openTrades.length} open · ${acc.closedTrades} closed · $${acc.balance.toFixed(2)}`);
    if (acc.openTrades.length) {
      lines.push('```');
      lines.push('Open:');
      for (const t of acc.openTrades.slice(0, 5)) {
        lines.push(`  ${t.strategy} ${t.direction} ${t.instrument} ${t.contracts}c @${t.entry.toFixed(2)} SL ${t.stop.toFixed(2)} ($${t.riskUsd.toFixed(0)} risk)`);
      }
      lines.push('```');
    }
  }
  await sendOwner(lines.join('\n'));
}

async function cmdDd() {
  const rm = await import('../lib/risk_manager.js');
  const at = await import('../lib/account_tracker.js');
  at.maybeRollDay();
  const lines = [header('📉', 'Drawdown status (EOD trailing)')];
  for (const id of at.ACCOUNT_IDS) {
    const acc = at.get(id);
    const st = rm.evalStatus(acc);
    const usedPct = st.ddFromPeakEod / rm.EVAL_RULES.maxDrawdown * 100;
    const bars = Math.floor(usedPct / 5);
    const bar = '█'.repeat(Math.max(0, Math.min(20, bars))) + '░'.repeat(Math.max(0, 20 - bars));
    lines.push('');
    lines.push(`*${id.toUpperCase()}*  ·  peak EOD $${st.peakEod.toFixed(0)}  ·  bal $${st.balance.toFixed(0)}`);
    lines.push(`${bar} ${usedPct.toFixed(0)}%`);
    lines.push(`Used $${st.ddFromPeakEod.toFixed(0)} / $${rm.EVAL_RULES.maxDrawdown}  ·  $${st.ddRemaining.toFixed(0)} remaining`);
  }
  await sendOwner(lines.join('\n'));
}

async function cmdPayout() {
  const rm = await import('../lib/risk_manager.js');
  const at = await import('../lib/account_tracker.js');
  at.maybeRollDay();
  const lines = [header('💵', 'Payout status')];
  for (const id of at.ACCOUNT_IDS) {
    const acc = at.get(id);
    const st = rm.evalStatus(acc);
    lines.push('');
    lines.push(`*${id.toUpperCase()}* · ${st.phase}`);
    if (st.phase === 'eval') {
      lines.push(`Eval in progress — payouts unlock once funded.`);
      lines.push(`Profit to pass: $${st.profitRemaining.toFixed(0)} of $${rm.EVAL_RULES.profitTarget}`);
    } else {
      lines.push(`Eligible: ${st.payoutEligible ? '✅ yes' : '⚫ not yet'}`);
      lines.push(`Max request: $${st.maxPayoutRequest.toFixed(0)}  (50% of $${st.profit.toFixed(0)} profit, capped $${rm.PAYOUT_RULES.maxRequestUsd})`);
      lines.push(`Min request: $${rm.PAYOUT_RULES.minRequestUsd}`);
    }
    const recent = (acc.dailyHistory || []).slice(-7);
    if (recent.length) {
      lines.push('```');
      lines.push('Last 7 days:');
      for (const d of recent) {
        const mark = d.pnl > 0 ? '+' : d.pnl < 0 ? '-' : ' ';
        lines.push(`  ${mark} ${d.dateKey}  $${d.pnl.toFixed(2)}  (${d.trades} trades, EOD $${(d.eodBalance || 0).toFixed(0)})`);
      }
      lines.push('```');
    }
  }
  await sendOwner(lines.join('\n'));
}

async function cmdLevels(arg) {
  const at = await import('../lib/account_tracker.js');
  const which = (arg || '').toLowerCase().trim();
  const ids = at.ACCOUNT_IDS.includes(which) ? [which] : at.ACCOUNT_IDS;
  const lines = [header('📊', 'TV indicator levels')];
  let any = false;
  for (const id of ids) {
    const acc = at.get(id);
    for (const t of acc.openTrades) {
      any = true;
      lines.push('');
      lines.push(`*${id.toUpperCase()}* · ${t.strategy} · ${t.direction} ${t.instrument.toUpperCase()}${t.live ? ' · LIVE' : ''}`);
      lines.push('```');
      lines.push(`OCTAVE  ${t.direction}  ${t.entry} / ${t.stop} / ${t.t1} / ${t.t2}`);
      lines.push('```');
      lines.push(`_Paste into the Octave Levels Pine indicator settings:_`);
      lines.push(`_Direction = *${t.direction}*  ·  Entry = *${t.entry}*  ·  Stop = *${t.stop}*  ·  TP1 = *${t.t1}*  ·  TP2 = *${t.t2}*_`);
    }
  }
  if (!any) lines.push('', '_No open trades._');
  await sendOwner(lines.join('\n'));
}

async function cmdBroker(arg) {
  const le = await import('../lib/live_executor.js');
  const at = await import('../lib/account_tracker.js');
  const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
  const subcmd = parts[0]?.toLowerCase();
  // Single-account era: alias 'auto' → 'user' so old commands keep working.
  const resolveId = (raw) => {
    const id = (raw || '').toLowerCase();
    if (id === 'auto') return 'user';
    return at.ACCOUNT_IDS.includes(id) ? id : null;
  };

  // /broker → status
  if (!subcmd || subcmd === 'status') {
    const cfg = le.getConfig();
    const lines = [header('🔌', 'Broker bridge status')];
    lines.push('');
    for (const id of at.ACCOUNT_IDS) {
      const url = cfg.webhooks[id];
      lines.push(`*${id.toUpperCase()}*  webhook: ${url ? '✅ set' : '⚫ none'}`);
      if (url) {
        const masked = url.replace(/^(https:\/\/[^/]+).*$/, '$1/…' + url.slice(-6));
        lines.push(`  \`${masked}\``);
      }
    }
    lines.push('');
    lines.push(`Cooldown: ${cfg.cooldownMs / 1000}s between fires`);
    lines.push(`Auth:     ${cfg.authHeader ? 'header set' : 'none'}`);
    lines.push('');
    lines.push('Commands:');
    lines.push(bullet('`/broker set-url <https-url>` — set webhook'));
    lines.push(bullet('`/broker set-url off` — clear webhook'));
    lines.push(bullet('`/broker test` — fire a test ping'));
    lines.push(bullet('`/broker set-auth <header>` — set authorization header'));
    lines.push(bullet('`/broker set-cooldown <ms>` — between-fire cooldown'));
    lines.push('');
    lines.push('🛑 *Live fires* require ALL three:');
    lines.push('  1. `/risk live` (account mode)');
    lines.push('  2. `/broker set-url <url>`');
    lines.push('  3. Signal passes risk gates');
    return sendOwner(lines.join('\n'));
  }

  if (subcmd === 'set-url') {
    // Single-account: accept `set-url <url>` (account inferred) OR legacy
    // `set-url <id> <url>`.
    let id = at.ACCOUNT_IDS[0];
    let url = parts[1];
    if (parts.length >= 3) { id = resolveId(parts[1]) || id; url = parts[2]; }
    if (!url) return sendOwner('usage: `/broker set-url <https-url|off>`');
    const r = le.setWebhook(id, url);
    if (!r.ok) return sendOwner(`⚠️ ${r.error}`);
    if (r.cleared) return sendOwner(`✅ webhook cleared`);
    return sendOwner(`✅ webhook set\n_Type \`/broker test\` to verify it works before going live._`);
  }

  if (subcmd === 'test') {
    // Single-account: no arg needed; legacy `test <id>` still accepted.
    const id = resolveId(parts[1]) || at.ACCOUNT_IDS[0];
    await sendOwner(`⏳ Firing test ping to ${id} webhook…`);
    const r = await le.testPing(id);
    if (r.ok) return sendOwner(`✅ Test OK — HTTP ${r.status}\n\`\`\`\n${(r.body || '(no body)').slice(0, 300)}\n\`\`\``);
    return sendOwner(`⚠️ Test FAILED${r.status ? ` — HTTP ${r.status}` : ''}\n\`\`\`\n${(r.body || r.error || '(no body)').slice(0, 300)}\n\`\`\``);
  }

  if (subcmd === 'set-auth') {
    const val = parts.slice(1).join(' ');
    le.setAuthHeader(val || null);
    return sendOwner(val ? '✅ auth header set' : '✅ auth header cleared');
  }

  if (subcmd === 'set-cooldown') {
    const ms = parseInt(parts[1], 10);
    if (!isFinite(ms) || ms < 5000) return sendOwner('cooldown must be ≥5000ms');
    le.setCooldown(ms);
    return sendOwner(`✅ cooldown set to ${ms}ms`);
  }

  return sendOwner('unknown subcommand — try `/broker` for help');
}

async function cmdCleanupGroup(arg) {
  const { send: tgSend, listSentToChat, clearSentLog } = await import('../lib/telegram_queue.js');
  const groupChatId = String(CHAT_ID);
  if (String(replyChat) === groupChatId) {
    // Owner ran it from the group itself — odd but allow. Routing already
    // sent the reply to DM since this is a non-allowlist command.
  }
  const sent = listSentToChat(groupChatId);
  if (sent.length === 0) {
    return sendOwner('No tracked bot messages to delete in the group.\n\n_Older messages (pre-Phase-3) need to be cleared manually:_\n_open the group → tap group name → "Clear chat history" → Delete for all members_');
  }
  await sendOwner(`🧹 Deleting ${sent.length} tracked bot message${sent.length === 1 ? '' : 's'} from the group…`);

  // Telegram allows deleting bot's own messages anytime. Older than ~48h
  // from non-bot users requires admin rights; for our own messages, no
  // limit applies. Failures are silently counted.
  let ok = 0, fail = 0;
  for (const m of sent) {
    try {
      const r = await tgSend(TOKEN, 'deleteMessage', { chat_id: groupChatId, message_id: m.id });
      if (r) ok++; else fail++;
    } catch { fail++; }
    // Small delay to avoid rate limiting
    await new Promise((res) => setTimeout(res, 50));
  }
  clearSentLog(groupChatId);
  return sendOwner([
    `✅ Cleanup done.`,
    `Deleted: *${ok}*${fail > 0 ? '  ·  Failed: *' + fail + '*' : ''}`,
    '',
    fail > 0 ? '_Failures usually mean the message is > 48h old or already deleted. Use Telegram\'s "Clear chat history" to wipe older ones manually._' : '_Tracking log cleared. Future sends are re-tracked from now._',
  ].join('\n'));
}

async function cmdShutdown(arg) {
  if (arg !== 'confirm') {
    return send([
      header('⚠️', 'Shutdown'),
      '',
      'Use `/shutdown confirm` to stop every Octave service:',
      bullet('signal engine'),
      bullet('telegram bot'),
      bullet('dashboard (webui)'),
      bullet('watchdog'),
      '',
      '_You\'ll have to bring services back manually with `systemctl start octave-*` on the VPS._',
    ].join('\n'));
  }
  await send('⏸ Shutting down…');
  // Linux: stop each systemd unit. The webui unit goes last because it's
  // serving the dashboard the user may be watching. The bot stops itself
  // by exiting cleanly after this command via the SIGTERM path.
  if (process.platform === 'linux') {
    // Matches the unit list in webui/server.js /api/shutdown — keep these
    // in sync so bot and dashboard stop the same set.
    const units = ['octave-signal-engine', 'octave-watchdog', 'octave-tunnel', 'octave-tunnel-watcher', 'octave-webui'];
    for (const u of units) {
      spawn('systemctl', ['stop', u], { detached: true, stdio: 'ignore' }).unref();
    }
    spawn('systemctl', ['stop', 'octave-telegram'], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  // Mac dev path — kept for local debugging only.
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
  bullet('`/help settings` — mute, backtest'),
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
    kv('/killzones', 'time window each strategy hunts in'),
    kv('/playbook <num>', 'get the strategy PDF'),
    '',
    section('Your own strategies'),
    kv('/mystrategies', 'list yours'),
    kv('/addstrategy', 'how to add one (file or describe it)'),
    kv('/delstrategy <id>', 'delete'),
    '',
    '_To add: send a PDF/image or just describe the strategy — the AI builds it._',
  ].join('\n'),
  settings: [
    header('⚙️', 'Settings commands'),
    '',
    kv('/mute <minutes>', 'pause alerts (1-1440)'),
    kv('/unmute', 'resume'),
    '',
    section('Backtest'),
    kv('/backtest', 'cached 30-day result (instant)'),
    kv('/backtest <num>', 'single strategy, live'),
    kv('/backtest <days>', 'custom window, live (≤14d)'),
    '_Cache refreshes nightly at 08:00 UTC._',
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
    'Just send any non-command text and the AI handles it. Examples:',
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

// Slim menu shown in the group chat — only the read-only buttons friends
// are allowed to invoke. No eval/account/risk surface visible.
function buildGroupMenu() {
  const text = [
    header('🎵', 'Octave · Signals'),
    '',
    'Signals fire automatically. Tap to pull live market intel:',
  ].join('\n');
  const keyboard = [
    [{ text: '🧭 Bias',    callback_data: 'act:bias' },    { text: '🎯 Setups',  callback_data: 'act:setups' }],
    [{ text: '💰 Price',   callback_data: 'act:price' },   { text: '🌍 Session', callback_data: 'act:session' }],
    [{ text: '📰 News',    callback_data: 'act:news' },    { text: '🌡 Regime',  callback_data: 'act:regime' }],
    [{ text: '📊 Levels',  callback_data: 'act:levels' },  { text: '🔔 Last',    callback_data: 'act:last' }],
  ];
  return { text, keyboard };
}

async function buildMainMenu() {
  const cfg = loadConfig() || {};
  const session = readJson(SESSION_FILE, { lastSession: null });
  const onCount = cfg.strategies ? Object.values(cfg.strategies).filter(Boolean).length : 0;
  const muteMin = cfg.mute?.untilMs && cfg.mute.untilMs > Date.now()
    ? Math.round((cfg.mute.untilMs - Date.now()) / 60000) : 0;

  let userCount = 0;
  try { const us = await import('../lib/user_strategies.js'); userCount = us.list().length; } catch {}
  const total = STRATEGIES.length + userCount;

  // Eval account snapshot — single line glance.
  let acctLine = '';
  try {
    const at = await import('../lib/account_tracker.js');
    at.maybeRollDay();
    const a = at.get(at.ACCOUNT_IDS[0]);
    const fmt = (v) => '$' + Math.round(v).toLocaleString('en-US');
    const profit = a.balance - 50000;
    const pSign = profit >= 0 ? '+' : '−';
    acctLine = `🏦 ${fmt(a.balance)} · ${pSign}${fmt(Math.abs(profit)).replace('$', '$')} · today ${a.dailyPnl >= 0 ? '+' : '−'}${fmt(Math.abs(a.dailyPnl)).replace('$', '$')}`;
  } catch {}

  const sessLabel = (session.lastSession || 'closed').toUpperCase().replace(/_/g, ' ');
  const text = [
    header('🎵', 'Octave'),
    '',
    `${muteMin > 0 ? '🔕 Muted ' + muteMin + 'm' : '🔔 Live'} · ${onCount}/${total} strategies · ${sessLabel} session`,
    acctLine,
  ].filter(Boolean).join('\n');

  const keyboard = [
    [{ text: '🧭 Bias',       callback_data: 'act:bias' },        { text: '🎯 Setups',  callback_data: 'act:setups' }],
    [{ text: '🏦 Accounts',   callback_data: 'act:account' },     { text: '🌍 Session', callback_data: 'act:session' }],
    [{ text: '🎚 Strategies', callback_data: 'view:strategies' }, { text: '📈 Backtest', callback_data: 'view:backtest' }],
    [{ text: '🌐 Dashboard',  callback_data: 'act:dashboard' },   { text: '🩺 Health',  callback_data: 'act:health' }],
    [{ text: '⚙️ Settings',   callback_data: 'view:settings' },   { text: '🔄 Refresh', callback_data: 'view:main' }],
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
  const cache = readJson(join(STATE_DIR, 'backtest-cache.json'), null);
  const ageH = cache?.generatedAt ? Math.round((Date.now() - cache.generatedAt) / 3_600_000) : null;
  const cacheLabel = cache?.tg
    ? `📊 Latest cached (${cache.days}d · ${ageH}h ago)`
    : '📊 Latest cached (none yet)';
  const text = [
    header('📈', 'Backtest'),
    '',
    'Live runs use an isolated process — bot stays responsive.',
    'Anything beyond 14d is served from the nightly cache (the VPS is too slow to run a 30d backtest within the command window).',
  ].join('\n');
  const keyboard = [
    [{ text: '7 days (live)',  callback_data: 'bt:7' },
     { text: '14 days (live)', callback_data: 'bt:14' }],
    [{ text: cacheLabel,       callback_data: 'bt:cached' }],
    [{ text: '« Back',         callback_data: 'view:main' }],
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
    `Chart images · ${cfg.alertChartImages !== false ? '🟢 ON' : '⚫ OFF'}`,
    `Holy AI      · ${aiOn ? '🟢 ON' : '⚫ OFF'} · gate ${aiThr}%`,
  ].join('\n');
  const keyboard = [
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
  // Slim menu in the group (signals + 5 read-only buttons), full menu in DM.
  const inGroup = String(replyChat) === String(CHAT_ID) && String(replyChat) !== String(OWNER_ID);
  const v = inGroup ? buildGroupMenu() : await buildMainMenu();
  await send(v.text, { keyboard: v.keyboard });
}

// ─── CALLBACK DISPATCHER ─────────────────────────────────────────────────

// Inline-button kinds that change state — owner only. 'view' (navigation),
// and 'act' verbs that just display info, are open to everyone in the group.
// 'pt' (paper-trader confirm/skip) is owner-only — only the account owner
// should be able to promote a trade to live on their account.
const OWNER_ONLY_CALLBACKS = new Set(['strat', 'mute', 'set', 'bt', 'pt']);
const OWNER_ONLY_ACTS = new Set(['restart', 'shutdown-confirm', 'shutdown-do']);

async function handleCallback(cq) {
  const chatId = cq.message?.chat?.id;
  if (!isAllowedChat(chatId)) return ackCallback(cq.id, 'unauthorized');
  replyChat = chatId;
  const data = cq.data || '';
  const messageId = cq.message?.message_id;
  const [kind, ...rest] = data.split(':');
  const arg = rest.join(':');
  const owner = isOwner(cq.from?.id);

  // Gate state-changing taps to the owner.
  const actVerb = kind === 'act' ? arg.split(':')[0] : '';
  if ((OWNER_ONLY_CALLBACKS.has(kind) || (kind === 'act' && OWNER_ONLY_ACTS.has(actVerb))) && !owner) {
    return ackCallback(cq.id, '🔒 Owner only');
  }

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
      if (what === 'charts') await updateConfig((c) => { c.alertChartImages = (val === 'on'); return c; });
      else if (what === 'ai') await updateConfig((c) => { c.aiEngine = c.aiEngine || {}; c.aiEngine.enabled = (val === 'on'); return c; });
      else return ackCallback(cq.id, 'unknown setting');
      const v = buildSettingsView();
      await editMessage(chatId, messageId, v.text, { keyboard: v.keyboard });
      return ackCallback(cq.id, `${what} → ${val}`);
    }

    if (kind === 'bt') {
      if (arg === 'cached') {
        await ackCallback(cq.id);
        return cmdBacktest('');
      }
      const days = parseInt(arg, 10) || 7;
      await editMessage(chatId, messageId, `⏳ Running ${days}-day backtest…`, { keyboard: [] });
      await ackCallback(cq.id);
      return cmdBacktest(String(days));
    }

    // Paper trader confirm/skip — callback_data format:
    //   pt:exec:<accountId>:<setupId>   (accountId = 'auto' | 'user')
    //   pt:skip:<setupId>
    if (kind === 'pt') {
      const [verb, ...rest3] = arg.split(':');
      const pt = await import('../lib/paper_trader.js');
      const at = await import('../lib/account_tracker.js');
      if (verb === 'exec') {
        const accountId = rest3[0];
        const setupId = rest3.slice(1).join(':');
        if (!at.ACCOUNT_IDS.includes(accountId)) return ackCallback(cq.id, 'bad account');
        const acc = at.get(accountId);
        const promoted = pt.confirm(accountId, setupId);
        if (!promoted) return ackCallback(cq.id, 'trade not open (may have already closed)');
        const modeLabel = acc?.mode === 'live' ? 'LIVE BROKER' : 'live-tracked (paper P&L)';
        return ackCallback(cq.id, `✅ ${accountId.toUpperCase()} → ${modeLabel}`);
      }
      if (verb === 'skip') {
        const setupId = rest3.join(':');
        pt.skip(setupId);
        return ackCallback(cq.id, '⏭ skipped');
      }
      return ackCallback(cq.id, 'unknown pt verb');
    }

    if (kind === 'act') {
      const [verb, ...rest2] = arg.split(':');
      const map = {
        bias: cmdBias, setups: cmdActiveSetups, today: cmdToday, last: cmdLast,
        price: cmdPrice, session: cmdSession, health: cmdHealth, dashboard: cmdDashboard,
        regime: cmdRegime, coach: cmdCoach, news: cmdNews,
        account: cmdAccount, paper: cmdPaper, dd: cmdDd, payout: cmdPayout, levels: cmdLevels,
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
      `✅ *Strategy added* via ${source === 'heuristic' ? 'heuristic fallback' : 'AI extraction'}`,
      kv('id', `\`${tgEscape(created.id)}\``),
      kv('name', tgEscape(created.name)),
      kv('entry', `\`${created.entry}\` · tf \`${created.timeframe}m\``),
      notes ? `_${tgEscape(notes)}_` : '',
      '',
      `Enabled and watching now. Remove anytime with \`/delstrategy ${created.id}\`.`,
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
  '/playbook': cmdPlaybook, '/killzones': cmdKillzones,
  '/mystrategies': cmdMyStrategies, '/addstrategy': cmdAddStrategy,
  '/delstrategy': cmdDelStrategy,
  '/mute': cmdMute, '/unmute': cmdUnmute,
  '/backtest': cmdBacktest,
  '/in': cmdJournalIn, '/out': cmdJournalOut, '/be': cmdJournalBE,
  '/note': cmdJournalNote, '/journal': cmdJournal,
  '/ai': cmdAi, '/clearchat': cmdClearChat,
  '/regime': cmdRegime, '/coach': cmdCoach, '/ai-engine': cmdAiEngine, '/aiengine': cmdAiEngine,
  '/account': cmdAccount, '/risk': cmdRisk, '/paper': cmdPaper,
  '/dd': cmdDd, '/payout': cmdPayout, '/broker': cmdBroker, '/levels': cmdLevels,
  '/cleanup-group': cmdCleanupGroup, '/cleanupgroup': cmdCleanupGroup,
  '/restart': cmdRestart, '/shutdown': cmdShutdown,
  '/version': cmdVersion, '/dashboard': cmdDashboard,
  '/diagnose': cmdDiagnose, '/fix': cmdFix,
};

// ─── DISPATCH ────────────────────────────────────────────────────────────

export async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg) return;
  const chatId = msg.chat?.id;
  replyChat = chatId; // route this turn's replies to the originating chat

  // Bot added to a group → announce the chat id so it can be wired up.
  if (Array.isArray(msg.new_chat_members) && msg.new_chat_members.some((u) => u.is_bot)) {
    await send([
      header('🎵', 'Octave added to this group'),
      '',
      'Group chat id:',
      `\`${chatId}\``,
      '',
      'Send that id to the admin to start receiving signals here.',
    ].join('\n'));
    return;
  }

  const rawText = (msg.text || '').trim();

  // /chatid works from ANY chat — the discovery tool for wiring up a new group.
  if (/^\/(chatid|id)(@\w+)?$/i.test(rawText)) {
    const kind = msg.chat?.type === 'private' ? 'your DM' : 'this group';
    await send(`Chat id: \`${chatId}\`  _(${kind})_`);
    return;
  }

  // Access gate — signal group + owner DM + OCTAVE_ALLOWED_CHATS only.
  if (!isAllowedChat(chatId)) {
    console.log('[bot] ignored msg from unauthorized chat', chatId);
    return;
  }

  const owner = isOwner(msg.from?.id);

  // File upload → AI strategy extraction. Owner only — it changes the set.
  const fileObj = msg.document
    || (Array.isArray(msg.photo) ? msg.photo[msg.photo.length - 1] : null)
    || msg.video || msg.audio;
  if (fileObj?.file_id) {
    if (!owner) return send('🔒 Only the owner can add strategies.');
    return handleStrategyUpload(fileObj, msg.caption || '');
  }
  if (!rawText) return;

  const m = /^\/([a-z0-9_-]+)(?:@\w+)?(?:\s+([\s\S]+))?$/i.exec(rawText);
  if (!m) {
    // Free-form text → AI chat, but ONLY in the owner's private DM. In a group
    // the bot must stay quiet during ordinary conversation (use /ai there).
    if (msg.chat?.type === 'private' && owner) return runAiChat(rawText);
    return;
  }
  const cmd = '/' + m[1].toLowerCase();
  const arg = m[2] ? m[2].trim() : '';
  const handler = COMMANDS[cmd];
  if (!handler) {
    // In the group: silently ignore unknown commands so friends can chat
    // freely without bot noise. In the owner DM: show help hint.
    if (String(chatId) === String(CHAT_ID) && String(chatId) !== String(OWNER_ID)) return;
    return send(`Unknown command: \`${cmd}\`\n\nSend \`/help\` for the list.`);
  }

  // Owner-only gate for state-changing / heavy commands.
  if (OWNER_ONLY.has(cmd) && !owner) {
    // Friend tried a state-changing command in the group → silent (no noise).
    // If the owner typed it in the group, fall through (owner check above is
    // "not owner" — won't reach here as owner).
    if (String(chatId) === String(CHAT_ID) && String(chatId) !== String(OWNER_ID)) return;
    return send('🔒 *Owner only.* This command changes settings for everyone — ask the admin.');
  }

  // Group chat allowlist — if the command isn't in GROUP_ALLOWED_COMMANDS
  // and the source IS the group, redirect the reply to the owner DM.
  // Friends in the group never see private/admin output.
  const fromGroup = String(chatId) === String(CHAT_ID) && String(chatId) !== String(OWNER_ID);
  if (fromGroup && !GROUP_ALLOWED_COMMANDS.has(cmd)) {
    if (!owner) return;  // friend typed a non-allowlist command → silent
    replyChat = OWNER_ID;  // owner typed it in group → reply goes to their DM
  }

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

// Initialize creds + strategy maps WITHOUT starting the poll loop. Lets a test
// harness drive handleUpdate through the real code path (same as start() minus
// polling), so commands can be exercised exactly as a user would.
export async function initForTest() {
  if (!loadCreds()) throw new Error('loadCreds failed — env not found');
  await loadStrategies();
  return { CHAT_ID, OWNER_ID };
}

export async function start() {
  if (!loadCreds()) {
    console.error('[bot] missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID — disabled');
    return;
  }
  await loadStrategies(); // populate the strategy maps before polling
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
