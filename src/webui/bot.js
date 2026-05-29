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
import { withFileLock } from '../lib/safe_json.js';
import { MODES } from '../lib/risk_manager.js';

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
// Includes the journal commands (/in /out /be /note) so friends in the group
// can't pollute the owner's trade journal, and so the test-harness mutation
// guard automatically covers them.
const OWNER_ONLY = new Set([
  '/enable', '/disable', '/mute', '/unmute',
  '/restart', '/shutdown', '/fix', '/addstrategy', '/delstrategy',
  '/backtest', '/risk', '/mode', '/cleanup-group',
  '/in', '/out', '/be', '/note',
]);

// Friends in the group chat can only invoke these commands. Anything else
// typed in the group routes the reply to the owner DM (so the friends never
// see private state like account balances). The owner can still use
// everything from the group; the reply just goes to their DM.
const GROUP_ALLOWED_COMMANDS = new Set([
  // Market intel
  '/bias', '/setups', '/setup', '/news', '/price', '/session',
  '/killzones',
  // Signal history (no account info — just the alert stream)
  '/last', '/today', '/yesterday', '/range', '/summary', '/results', '/history',
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
  // Cross-process lock: bot + webui both write this file (Telegram commands
  // here, dashboard POSTs in webui/server.js). Without the lock, concurrent
  // load→merge→write sequences clobber each other's updates.
  return withFileLock(CONFIG_FILE, async () => {
    const cur = loadConfig() || {};
    const next = updater(JSON.parse(JSON.stringify(cur)));
    next.lastUpdated = Date.now();
    writeJsonAtomic(CONFIG_FILE, next);
    return next;
  });
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
  // Trade rows store the R-multiple as `risk_reward` (loop.js appendTrade /
  // daily_report.js both use that key). Reading `result_R` here meant the
  // summary's R total was silently always 0.00R. `result_R` kept only as a
  // fallback for any legacy rows that may have used it.
  const sumR = trades.reduce((acc, t) => acc + (+t.risk_reward || +t.result_R || 0), 0);

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

// ── Results — fired trades by instrument, with TP vs SL tally ──
async function cmdResults(arg) {
  const days = Math.max(1, Math.min(90, parseInt(arg, 10) || 1));
  const sinceMs = Date.now() - days * 86_400_000;

  // Live rows only (the file also holds tens of thousands of backtest sims).
  let trades = [];
  try {
    if (existsSync(TRADE_LOG)) {
      for (const ln of readFileSync(TRADE_LOG, 'utf8').split('\n').filter(Boolean)) {
        try {
          const t = JSON.parse(ln);
          if (t.source !== 'live') continue;
          const ts = Date.parse(t.opened_at || t.ts || '') || 0;
          if (ts >= sinceMs) trades.push(t);
        } catch {}
      }
    }
  } catch {}

  const INST = { gold: 'GOLD', nasdaq: 'NASDAQ', sp: 'S&P' };
  const instOf = (t) => INST[t.instrument] || String(t.instrument || '?').toUpperCase();
  const rOf = (t) => (+t.risk_reward || +t.result_R || 0);
  // Buckets per instrument. TP = a net-winning close (reached a take-profit),
  // SL = a net loss (stopped out), BE = scratched at breakeven, exp = expired.
  const by = {};
  for (const t of trades) {
    const b = (by[instOf(t)] ||= { tp: 0, sl: 0, be: 0, exp: 0, cancelled: 0, r: 0 });
    switch (t.outcome) {
      case 'WIN':       b.tp++; b.r += rOf(t); break;
      case 'LOSS':      b.sl++; b.r += rOf(t); break;
      case 'BE':        b.be++; b.r += rOf(t); break;
      case 'EXPIRED':   b.exp++; b.r += rOf(t); break;
      case 'CANCELLED': b.cancelled++; break;
      default: break;
    }
  }

  const lines = [header('📊', days === 1 ? 'Results · today' : `Results · ${days}d`)];
  const rows = Object.entries(by).sort((a, b) => (b[1].tp + b[1].sl) - (a[1].tp + a[1].sl));
  if (!rows.length) {
    lines.push('', '_No live trades in this window._',
      '', '_`/results 7` week · `/results 30` month_');
    return send(lines.join('\n'));
  }

  let totTp = 0, totSl = 0, totBe = 0, totExp = 0, totCancel = 0, totR = 0;
  lines.push('', section('By instrument'));
  for (const [inst, b] of rows) {
    const fired = b.tp + b.sl + b.be + b.exp;
    totTp += b.tp; totSl += b.sl; totBe += b.be; totExp += b.exp; totCancel += b.cancelled; totR += b.r;
    const extra = [b.be ? `${b.be}⚖️` : '', b.exp ? `${b.exp}⏳` : ''].filter(Boolean).join(' ');
    lines.push(bullet(`*${inst}* — ${fired} fired · ${b.tp}🎯 TP · ${b.sl}🛑 SL${extra ? ' · ' + extra : ''}`));
  }

  const resolved = totTp + totSl;
  const wr = resolved ? Math.round((totTp / resolved) * 100) : 0;
  lines.push('', section('Totals'));
  lines.push(bullet(`${totTp + totSl + totBe + totExp} trades · *${totTp}*🎯 TP / *${totSl}*🛑 SL${resolved ? ` · ${wr}% win` : ''} · ${totR >= 0 ? '+' : ''}${totR.toFixed(1)}R`));
  if (totBe) lines.push(bullet(`${totBe} breakeven _(scratch — runner pulled back to BE)_`));
  if (totExp) lines.push(bullet(`${totExp} expired`));
  if (totCancel) lines.push(bullet(`${totCancel} unfilled limit${totCancel === 1 ? '' : 's'} _(never filled, not counted)_`));

  // Individual fired trades, newest first — the actual trades behind the tally.
  const recent = trades.filter((t) => ['WIN', 'LOSS', 'BE', 'EXPIRED'].includes(t.outcome)).slice(-8).reverse();
  if (recent.length) {
    lines.push('', section('Recent'));
    for (const t of recent) {
      const icon = t.outcome === 'WIN' ? '🎯' : t.outcome === 'LOSS' ? '🛑' : t.outcome === 'BE' ? '⚖️' : '⏳';
      const reason = (t.outcome === 'WIN' && t.exit_reason === 'sl') ? 'TP1→BE'
        : String(t.exit_reason || t.outcome || '').toUpperCase();
      const r = rOf(t);
      lines.push(bullet(`${icon} ${instOf(t)} · ${tgEscape(t.strategy || '?')} · ${reason} ${r >= 0 ? '+' : ''}${r.toFixed(1)}R`));
    }
  }
  lines.push('', '_`/results 7` week · `/results 30` month_');
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
  // Which tracked setups the paper account actually holds — lets the "Open"
  // list flag gate-blocked signals (tracked for pings, but no paper position),
  // matching the trade panel's "signal only · paper skipped" marker.
  let paperOpenIds = new Set();
  try {
    const at = await import('../lib/account_tracker.js');
    for (const id of at.ACCOUNT_IDS) for (const t of (at.get(id)?.openTrades || [])) paperOpenIds.add(t.setupId);
  } catch {}

  const todayKey = nyDateKey(Date.now());
  // EVERY status:triggered event today, including ones that didn't reach
  // Telegram (gated for low confidence, muted, news blackout). The user's
  // dedup is day-scoped on setupId — the strategy WILL NOT re-trigger today
  // regardless of why the alert was suppressed, so /setups must flag those
  // rows or they read "READY" forever with no explanation.
  // (The original bug: only telegram:'sent' was counted, so a confidence-
  //  gated triggered setup left its precheck row reading READY all day with
  //  no fire marker — the user saw "ready but never gave signal".)
  const triggeredToday = readAlerts({ limit: 200 })
    .filter((a) => a.status === 'triggered' && nyDateKey(a.time) === todayKey);
  // Only the delivered subset goes under the "Fired today" Telegram-history
  // section — that section is the actual alert stream, gated/muted setups
  // should not appear there.
  const fired = triggeredToday.filter((a) => a.telegram === 'sent');

  // Live precheck — what each strategy is watching RIGHT NOW. The signal
  // engine re-stamps this every tick (3s) so a stale read just means the
  // engine is restarting. Older than 3 min → treat as missing.
  const precheckSnap = readJson(join(STATE_DIR, 'last-precheck.json'), null);
  const precheckFresh = precheckSnap && (Date.now() - (precheckSnap.at || 0)) <= 180_000;
  const precheckRows = precheckFresh ? (precheckSnap.rows || []) : [];

  // A precheck row can read "READY" while no NEW signal arrives because:
  //  - the setup already triggered today (dedup is day-scoped, fires once)
  //  - it's already an open trade
  //  - it triggered but was confidence-gated, muted, or blacked-out
  // Map (strategy|instrument|direction) → marker so READY isn't read as
  // "an alert is coming" when the strategy has actually acted today.
  const takenKey = (strat, inst, dir) => `${strat}|${inst}|${dir}`;
  // Short label per telegram disposition. Keeps the marker on one row.
  const dispositionLabel = (tg, time) => {
    const t = nyHHmm(time);
    if (tg === 'sent') return `fired ${t}`;
    if (tg === 'suppressed (muted)' || tg === 'muted') return `fired ${t} · muted`;
    if (tg && tg.startsWith('gated')) return `gated ${t} · low conf`;
    if (tg && tg.includes('blackout')) return `fired ${t} · news blackout`;
    return `fired ${t}`;
  };
  const taken = new Map();
  for (const a of triggeredToday) {
    const parts = String(a.setupId || '').split('|');
    const inst = parts[0];
    const dir = parts.find((p) => p === 'LONG' || p === 'SHORT') || '';
    taken.set(takenKey(a.strategy, inst, dir), dispositionLabel(a.telegram, a.time));
  }
  for (const s of open) taken.set(takenKey(s.strategy, s.instrument, s.direction), 'open trade');

  // Strategy|instrument that already fired or is open today (direction-agnostic).
  // Used to keep the "Waiting" list clean: once a strategy has acted on an
  // instrument it shows under Open / Fired today, not as still-dormant.
  const takenSI = new Set();
  for (const a of fired) takenSI.add(`${a.strategy}|${String(a.setupId || '').split('|')[0]}`);
  for (const s of open) takenSI.add(`${s.strategy}|${s.instrument}`);

  const INST = { gold: 'GOLD', nasdaq: 'NASDAQ', sp: 'S&P' };
  const lines = [header('🎯', 'Setups')];

  // Compact /setups: one-liner per item across three sections.
  if (open.length) {
    lines.push('', `*Open · ${open.length}*`);
    for (const s of open) {
      const dir = s.direction === 'LONG' ? '🟢' : '🔴';
      const stage = Object.keys(s.milestonesFired || {}).filter((m) => m !== 'be').pop()?.toUpperCase()
        || (s.milestonesFired?.be ? 'BE' : 'live');
      const skipped = !paperOpenIds.has(s.setupId) ? ' · ⚠️ paper skipped' : '';
      const px = Number.isFinite(s.entry) ? Number(s.entry).toFixed(2) : s.entry;
      lines.push(`${dir} *${tgEscape(s.strategy || '?')}* ${(s.instrument || '').toUpperCase()} · @${px} · ${stage}${skipped}`);
    }
  }

  if (precheckRows.length) {
    // Score every in-play row (strategy × instrument). gatesOk = all gates met
    // (the setup's preconditions hold); closeness = how many trigger conditions
    // are met. A row is "forming" only when its gates pass — otherwise it's
    // "waiting" on a gate (out of time window, no Asian range, no trend, etc).
    const scored = precheckRows.map((r) => {
      const conds = r.conditions || [];
      const gates = conds.filter((c) => c.kind === 'gate');
      const triggers = conds.filter((c) => c.kind === 'trigger');
      const gatesOk = gates.length > 0 && gates.every((c) => c.met);
      const tMet = triggers.filter((c) => c.met).length;
      const tTotal = triggers.length || 1;
      return { ...r, gates, gatesOk, tMet, tTotal, closeness: gatesOk ? tMet / tTotal : 0 };
    });

    // FORMING — gates met, genuinely building toward a signal, not yet fired
    // today (direction-aware: a strategy that fired LONG can still form a SHORT)
    // and not already an open trade.
    const forming = scored
      .filter((r) => r.gatesOk && !taken.has(takenKey(r.strategy, r.instrument, r.direction)))
      .sort((a, b) => b.closeness - a.closeness || a.strategy.localeCompare(b.strategy));
    if (forming.length) {
      lines.push('', `*Forming · ${forming.length}*`);
      for (const r of forming) {
        const inst = INST[r.instrument] || r.instrument;
        const dir = r.direction === 'LONG' ? '🟢' : r.direction === 'SHORT' ? '🔴' : '⚪';
        const stage = r.tMet === r.tTotal ? '🟢 READY' : r.tMet >= r.tTotal - 1 ? '🟠 NEAR' : '🟡 forming';
        const proj = r.projection
          ? ` · E${r.projection.entry.toFixed(2)} SL${r.projection.stop.toFixed(2)} TP${r.projection.t2.toFixed(2)} (1:${r.projection.rr2.toFixed(1)}R)`
          : '';
        lines.push(`${dir} *${tgEscape(r.strategy)}* ${inst} · ${stage}${proj}`);
      }
    }

    // WAITING — every other in-play strategy whose gate isn't satisfied yet, so
    // the user sees ALL strategies that are live, not just the forming subset.
    // Reason is derived from the first unmet gate (auto-updates if a strategy's
    // gates change). Collapse to one line when a strategy is waiting on every
    // instrument for the same reason (e.g. a time window blocks all at once);
    // otherwise list per-instrument so partial states stay visible.
    const shortReason = (gate) => {
      if (!gate) return 'gate not met';
      const label = String(gate.label || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
      const val = gate.value != null ? String(gate.value) : '';
      return val && val.length <= 24 ? `${label} · ${val}` : label;
    };
    const totalByStrat = new Map();
    for (const r of scored) totalByStrat.set(r.strategy, (totalByStrat.get(r.strategy) || 0) + 1);
    const byStrat = new Map();
    for (const r of scored) {
      if (r.gatesOk) continue;
      if (takenSI.has(`${r.strategy}|${r.instrument}`)) continue;
      const reason = shortReason(r.gates.find((c) => !c.met));
      if (!byStrat.has(r.strategy)) byStrat.set(r.strategy, []);
      byStrat.get(r.strategy).push({ inst: r.instrument, reason });
    }
    const waitingLines = [];
    for (const [strat, items] of [...byStrat.entries()].sort((a, b) => (KEY_TO_NUM[a[0]] || 99) - (KEY_TO_NUM[b[0]] || 99))) {
      const uniform = items.every((it) => it.reason === items[0].reason);
      const waitingAll = items.length === (totalByStrat.get(strat) || items.length);
      if (uniform && waitingAll) {
        waitingLines.push(`*${tgEscape(strat)}* · ${items[0].reason}`);
      } else {
        for (const it of items) waitingLines.push(`*${tgEscape(strat)}* ${INST[it.inst] || it.inst} · ${it.reason}`);
      }
    }
    if (waitingLines.length) {
      lines.push('', `*Waiting · ${waitingLines.length}*`);
      for (const l of waitingLines) lines.push(l);
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
    if (uniq.length > 8) lines.push(`_…+${uniq.length - 8} earlier_`);
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

  // A setup fires once per day (dedup is day-scoped). A "READY" row whose
  // setup already triggered today — whether delivered, confidence-gated,
  // muted, or news-blacked-out — will NOT re-fire. Flag every triggered event
  // (regardless of telegram delivery) with a label that explains why no
  // signal came (the original bug: only telegram:'sent' was counted, so a
  // confidence-gated row read READY all day with no explanation).
  const takenKey = (inst, dir) => `${inst}|${dir}`;
  const taken = new Map();
  try {
    const fu = await import('../lib/follow_up.js');
    for (const s of fu.active()) if (s.strategy === key) taken.set(takenKey(s.instrument, s.direction), 'open trade');
  } catch {}
  const todayKey = nyDateKey(Date.now());
  const dispositionLabel = (tg, time) => {
    const t = nyHHmm(time);
    if (tg === 'sent') return `fired ${t}`;
    if (tg === 'suppressed (muted)' || tg === 'muted') return `fired ${t} · muted`;
    if (tg && tg.startsWith('gated')) return `gated ${t} · low conf`;
    if (tg && tg.includes('blackout')) return `fired ${t} · news blackout`;
    return `fired ${t}`;
  };
  for (const a of readAlerts({ limit: 200 })) {
    if (a.strategy !== key || a.status !== 'triggered' || nyDateKey(a.time) !== todayKey) continue;
    const parts = String(a.setupId || '').split('|');
    const dir = parts.find((p) => p === 'LONG' || p === 'SHORT') || '';
    if (!taken.has(takenKey(parts[0], dir))) taken.set(takenKey(parts[0], dir), dispositionLabel(a.telegram, a.time));
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
    const already = taken.get(takenKey(r.instrument, r.direction));
    const alreadyNote = already ? ` · ✅ ${already}` : '';
    lines.push('');
    lines.push(`${r.icon} *${inst}* · ${dir} · _${r.stage}_${alreadyNote} · gates ${r.gMet}/${r.gates.length} · triggers ${r.tMet}/${r.tTot}`);
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

  // Explain why a READY row may not alert: a setup fires once per day, so once
  // it has triggered (delivered OR gated OR muted) it stays "READY" on the
  // chart but won't re-signal until the next session.
  if (rendered.some((r) => r.stage === 'READY' && taken.get(takenKey(r.instrument, r.direction)))) {
    lines.push('', '_✅ = this setup already triggered today (whether delivered, confidence-gated, or muted). Each setup alerts once per day, so it won\'t re-signal until the next session even while it still reads READY._');
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
    // sudo prefix required: the bot runs as `octave`, whose sudoers only
    // permits `sudo systemctl <verb> octave-*`. Without sudo the spawn exits
    // silently with permission-denied and the Telegram /restart command
    // reports success while nothing actually restarted.
    spawn('sudo', ['systemctl', 'restart', unit.linux], { detached: true, stdio: 'ignore' }).unref();
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
    lines.push(`*${id.toUpperCase()}* · paper · ${acc.enabled ? '🟢 active' : '⚫ disabled'} · ${st.phase}`);
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
  // /risk funded     → mark account as funded
  // /risk eval       → mark account back to eval
  // /risk per 250    → set risk-per-trade USD
  // /risk reset      → wipe back to fresh $50k
  if (parts.length === 0 || parts[0] === '' || parts[0] === 'status') {
    const a = at.get(ID);
    const rc = await import('../lib/runtime_config.js');
    const m = rc.getMode();
    return sendOwner([
      header('⚙️', 'Risk control'),
      '',
      `*${ID.toUpperCase()}*  ${a.enabled ? '🟢 active' : '⚫ disabled'} · paper · ${a.phase}`,
      `Mode: *${m.label}* · $${m.riskPerTrade}/trade · up to ${m.maxContracts}c/instrument`,
      '',
      'Commands:',
      bullet('`/mode` — view/switch passive ↔ aggressive (risk-per-trade lives here)'),
      bullet('`/risk on` · `/risk off` — enable/disable'),
      bullet('`/risk eval` · `/risk funded` — phase'),
      bullet('`/risk reset` — wipe back to fresh $50k'),
    ].join('\n'));
  }
  if (parts[0] === 'on')  { at.setEnabled(ID, true);  return sendOwner('🟢 enabled'); }
  if (parts[0] === 'off') { at.setEnabled(ID, false); return sendOwner('⚫ disabled'); }
  if (parts[0] === 'per') {
    return sendOwner('risk-per-trade is set by the active *mode* now — use `/mode passive` or `/mode aggressive`. See `/mode`.');
  }
  if (parts[0] === 'reset' || (parts[0] === 'reset' && parts[1] === ID)) {
    at.reset(ID);
    return sendOwner(`account reset to fresh $50k`);
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

// /mode                  → show both modes + which is active
// /mode passive          → switch to capital-preservation
// /mode aggressive       → switch to push-the-target
async function cmdMode(arg) {
  const rc = await import('../lib/runtime_config.js');
  const { MODES } = await import('../lib/risk_manager.js');
  const want = (arg || '').toLowerCase().trim();
  if (want === 'passive' || want === 'aggressive') {
    rc.setMode(want);
    const m = rc.getMode();
    return sendOwner(`✅ Mode → *${m.label}*\n$${m.riskPerTrade}/trade · up to ${m.maxContracts}c/instrument · daily stop $${m.dailyBreaker} · ${m.maxOpen} open · TP2≤${m.tp2MaxR}R\n_Takes effect on the next signal (engine refreshes config each tick)._`);
  }
  const active = rc.getModeName();
  const fmt = (key) => {
    const m = MODES[key];
    const star = key === active ? ' ◀ ACTIVE' : '';
    return [
      `*${m.label}*${star}`,
      bullet(`$${m.riskPerTrade}/trade · up to ${m.maxContracts} micros/instrument`),
      bullet(`daily stop $${m.dailyBreaker} · max ${m.maxOpen} open positions`),
      bullet(`TP1 ${m.tp1R}R def (≤${m.tp1MaxR}R) · TP2 ${m.tp2R}R def (≤${m.tp2MaxR}R) · BE at +1R`),
    ].join('\n');
  };
  return sendOwner([
    header('🎚', 'Risk mode'),
    '',
    fmt('aggressive'),
    '',
    fmt('passive'),
    '',
    '_Tap to switch — applies on the next signal._',
  ].join('\n'), { keyboard: [[
    { text: (active === 'aggressive' ? '✅ AGGRESSIVE' : 'AGGRESSIVE'), callback_data: 'set:mode:aggressive' },
    { text: (active === 'passive' ? '✅ PASSIVE' : 'PASSIVE'), callback_data: 'set:mode:passive' },
  ]] });
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
  bullet('`/help history`  — today, yesterday, history, range, summary, results'),
  bullet('`/help strats`   — list, enable/disable, custom strategies'),
  bullet('`/help settings` — mute, backtest'),
  bullet('`/help journal`  — log entries, exits, stats'),
  bullet('`/help system`   — health, perf, restart, diagnose, fix'),
  '',
  '_`/menu` opens the tap-to-use UI._',
].join('\n');

const HELP_TOPICS = {
  market: [
    header('📊', 'Market commands'),
    '',
    kv('/bias', 'multi-instrument bias (gold + nasdaq)'),
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
    kv('/results [days]', 'fired trades by instrument · TP vs SL tally'),
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
    [{ text: '📰 News',    callback_data: 'act:news' },    { text: '🔔 Last',    callback_data: 'act:last' }],
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
  const mode = (cfg.mode === 'passive' || cfg.mode === 'aggressive') ? cfg.mode : 'aggressive';
  // Read the authoritative per-mode gate (risk_manager MODES), not the legacy
  // aiEngine.threshold fallback — the latter sits in runtime-config.json at
  // its old default (0.55) while the live MODES.gate has been changed (0.45)
  // and would show a stale value here otherwise. See loop.js confThreshold
  // resolution: getMode().gate ?? aiEngine.threshold ?? 0.55.
  const liveGate = MODES[mode]?.gate ?? Number(cfg.aiEngine?.threshold) ?? 0.55;
  const gateThr = Math.round(liveGate * 100);
  const other = mode === 'aggressive' ? 'passive' : 'aggressive';
  const text = [
    header('⚙️', 'Settings'),
    '',
    `Risk mode    · ${mode === 'aggressive' ? '🟢 AGGRESSIVE' : '🔵 PASSIVE'}`,
    `Chart images · ${cfg.alertChartImages !== false ? '🟢 ON' : '⚫ OFF'}`,
    `Signal gate  · min confidence ${gateThr}% (win-rate based)`,
  ].join('\n');
  const keyboard = [
    [{ text: `🎚 Switch to ${other.toUpperCase()} mode`, callback_data: `set:mode:${other}` }],
    [{ text: cfg.alertChartImages !== false ? '⚫ Disable chart images' : '🟢 Enable chart images', callback_data: `set:charts:${cfg.alertChartImages !== false ? 'off' : 'on'}` }],
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
const OWNER_ONLY_CALLBACKS = new Set(['strat', 'mute', 'set', 'bt']);
const OWNER_ONLY_ACTS = new Set(['restart', 'shutdown-confirm', 'shutdown-do']);

export async function handleCallback(cq) {
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
      else if (what === 'mode') {
        if (val !== 'passive' && val !== 'aggressive') return ackCallback(cq.id, 'invalid mode');
        await updateConfig((c) => { c.mode = val; return c; });
      }
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

    if (kind === 'act') {
      const [verb, ...rest2] = arg.split(':');
      const map = {
        bias: cmdBias, setups: cmdActiveSetups, today: cmdToday, last: cmdLast,
        price: cmdPrice, session: cmdSession, health: cmdHealth, dashboard: cmdDashboard,
        news: cmdNews,
        account: cmdAccount, paper: cmdPaper, dd: cmdDd, payout: cmdPayout,
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
  '/range': cmdRange, '/last': cmdLast, '/summary': cmdSummary, '/results': cmdResults,
  '/strategies': cmdStrategies, '/enable': cmdEnable, '/disable': cmdDisable,
  '/playbook': cmdPlaybook, '/killzones': cmdKillzones,
  '/mystrategies': cmdMyStrategies, '/addstrategy': cmdAddStrategy,
  '/delstrategy': cmdDelStrategy,
  '/mute': cmdMute, '/unmute': cmdUnmute,
  '/backtest': cmdBacktest,
  '/in': cmdJournalIn, '/out': cmdJournalOut, '/be': cmdJournalBE,
  '/note': cmdJournalNote, '/journal': cmdJournal,
  '/account': cmdAccount, '/risk': cmdRisk, '/mode': cmdMode, '/paper': cmdPaper,
  '/dd': cmdDd, '/payout': cmdPayout,
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
    // Non-command text. The bot is rules-based (no AI chat) — nudge the owner
    // to the command menu; stay silent in groups during ordinary conversation.
    if (msg.chat?.type === 'private' && owner) return send('Send `/menu` for the control panel or `/help` for commands.');
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

  // Test-harness guard: refuse to actually mutate state when the bot was
  // started via initForTest() rather than start(). See the IS_TEST_HARNESS
  // comment above initForTest() for context (an audit pass leaked a /mute
  // into the live bot, suppressing a real signal). Read commands pass through.
  if (IS_TEST_HARNESS && OWNER_ONLY.has(cmd)) {
    console.warn(`[bot] test-harness refusing OWNER_ONLY ${cmd} (would mutate live state)`);
    return send(`🧪 _test-harness mode: refusing \`${cmd}\` (would mutate live runtime config). Use the real bot to issue this command._`);
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
//
// IS_TEST_HARNESS is flipped here and checked in handleUpdate before dispatching
// any OWNER_ONLY (state-mutating) command. Without this guard, a test that
// includes /mute, /enable, /restart, etc. in its command-coverage sweep leaks
// real mutations into the live runtime — an earlier audit pass briefly muted
// the live bot via /mute (1m default), which then suppressed a real signal.
// The flag is module-scoped so it only affects the same process that called
// initForTest; the real systemd-started bot never hits this code path.
let IS_TEST_HARNESS = false;
export async function initForTest() {
  if (!loadCreds()) throw new Error('loadCreds failed — env not found');
  await loadStrategies();
  IS_TEST_HARNESS = true;
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
