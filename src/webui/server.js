/**
 * Octave Control Panel — local HTTP server.
 *
 * Binds 127.0.0.1:7345 (loopback only, never exposed externally). Serves a
 * single HTML page with toggle switches for mode + per-strategy on/off,
 * plus live status indicators.
 *
 * API endpoints:
 *   GET  /              → index.html
 *   GET  /api/state     → { config, cloud_heartbeat, service, last_alert }
 *   POST /api/config    → { mode?, strategies? } — writes runtime-config.json,
 *                         commits, and pushes to GitHub (background)
 *
 * Designed to be run as a LaunchAgent (auto-start, auto-restart).
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_DIR = join(__dirname, '..', '..');
const STATE_DIR = join(REPO_DIR, 'src', 'state');
const CONFIG_FILE = join(STATE_DIR, 'runtime-config.json');
const HEARTBEAT_FILE = join(STATE_DIR, 'cloud-heartbeat.json');
const SESSION_FILE = join(STATE_DIR, 'session.json');
// Platform-aware log dir resolution. Mac (dev) writes via LaunchAgent
// stdout; VPS writes via systemd to ~/.octave-logs. Pick whichever exists.
const LOG_DIR_CANDIDATES = [
  process.env.OCTAVE_LOG_DIR,
  '/home/octave/.octave-logs',
  process.env.HOME ? `${process.env.HOME}/.octave-logs` : null,
  '/Users/jqvier/Library/Logs/trading-alerts',
].filter(Boolean);
const LOG_DIR = LOG_DIR_CANDIDATES.find((p) => existsSync(p)) || LOG_DIR_CANDIDATES[0];
const STDOUT_LOG_NAME = existsSync(join(LOG_DIR, 'signal-engine.log'))
  ? 'signal-engine.log' : 'stdout.log';
const HTML_FILE = join(__dirname, 'index.html');
const PORT = parseInt(process.env.OCTAVE_WEBUI_PORT || '7345', 10);

const DEFAULTS = {
  version: 2,
  mode: 'auto',
  strategies: {},  // populated from the strategy registry at runtime
  lastUpdated: 0,
};

// Strategy registry — loaded once at startup. Used to validate config writes
// and to surface the strategy list to the dashboard.
let REGISTRY = [];
async function loadStrategyRegistry() {
  try {
    const { loadRegistry } = await import('../lib/strategy_registry.js');
    REGISTRY = await loadRegistry();
    console.log(`[webui] loaded ${REGISTRY.length} strategies from registry`);
  } catch (err) {
    console.error('[webui] registry load failed:', err.message);
  }
}
function registryIds() { return new Set(REGISTRY.map((s) => s.id)); }

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

function loadConfig() {
  const raw = readJson(CONFIG_FILE, DEFAULTS);
  return {
    version: raw.version ?? DEFAULTS.version,
    mode: ['auto', 'cloud', 'local'].includes(raw.mode) ? raw.mode : DEFAULTS.mode,
    strategies: { ...DEFAULTS.strategies, ...(raw.strategies || {}) },
    lastUpdated: raw.lastUpdated || 0,
  };
}

function getServicePid() {
  try {
    const out = spawnSync('pgrep', ['-f', 'trading-alerts/src/index.js']);
    return out ? Number(out.split('\n')[0]) || null : null;
  } catch { return null; }
}

function spawnSync(cmd, args) {
  try {
    const { execSync } = require('node:child_process');
    return execSync(`${cmd} ${args.map(a => `'${a}'`).join(' ')}`, { encoding: 'utf8' }).trim();
  } catch { return null; }
}

// Spawn a binary and capture stdout/stderr. ALWAYS resolves — even when the
// binary doesn't exist or the call takes too long. The previous version only
// listened for 'close' and never resolved on 'error' (ENOENT), which hung
// /api/state and /api/services on Linux where /bin/launchctl doesn't exist.
async function exec(cmd, args, opts = {}) {
  const { spawn } = await import('node:child_process');
  const timeoutMs = opts.timeoutMs || 5000;
  return new Promise((res) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; res(v); } };
    let p;
    try {
      p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    } catch (err) {
      return settle({ code: 127, out: '', err: err.message });
    }
    let out = '', err = '';
    p.stdout.on('data', (d) => out += d.toString());
    p.stderr.on('data', (d) => err += d.toString());
    p.on('error', (e) => settle({ code: 127, out, err: e.message })); // ENOENT etc.
    p.on('close', (code) => settle({ code, out: out.trim(), err: err.trim() }));
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} settle({ code: 124, out, err: 'timeout' }); }, timeoutMs);
  });
}

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

async function gatherState() {
  const config = loadConfig();
  const cloud = readJson(HEARTBEAT_FILE, null);
  let cloudAlive = false;
  let cloudAgeMs = null;
  if (cloud?.lastTick) {
    cloudAgeMs = Date.now() - cloud.lastTick;
    cloudAlive = cloudAgeMs < 8 * 60 * 1000 && cloud.status === 'ok';
  }

  const session = readJson(SESSION_FILE, { lastSession: null });

  // Service PID + uptime — pgrep works on both macOS and Linux
  const pidR = await exec('pgrep', ['-f', 'trading-alerts/src/index.js']);
  const servicePid = pidR.code === 0 ? Number(pidR.out.split('\n')[0]) || null : null;
  let serviceUptime = null;
  if (servicePid) {
    const psR = await exec('ps', ['-p', String(servicePid), '-o', 'etime=']);
    if (psR.code === 0) serviceUptime = psR.out.trim();
  }

  // TV + CDP — Mac-only concept. On Linux we skip entirely.
  let tvPid = null, cdpOpen = false;
  if (isMac) {
    const tvR = await exec('pgrep', ['-f', 'TradingView']);
    tvPid = tvR.code === 0 ? Number(tvR.out.split('\n')[0]) || null : null;
    const cdpR = await exec('lsof', ['-i', ':9222', '-sTCP:LISTEN']);
    cdpOpen = cdpR.code === 0;
  }

  // Caffeinate — Mac-only (it's a macOS power-management command via launchctl)
  let caffActive = false;
  if (isMac) {
    const caffR = await exec('/bin/launchctl', ['print', `gui/${process.getuid()}/com.jqvier.octave-caffeinate`]);
    caffActive = caffR.code === 0 && /state\s*=\s*running/.test(caffR.out);
  }

  // Last alert from the signal-engine stdout log. STDOUT_LOG_NAME resolves
  // to 'signal-engine.log' on the VPS (systemd) and 'stdout.log' on Mac dev.
  let lastAlert = null;
  try {
    const out = readFileSync(join(LOG_DIR, STDOUT_LOG_NAME), 'utf8');
    const lines = out.trim().split('\n');
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 500); i--) {
      if (lines[i].includes('"alert fired"')) {
        const parsed = JSON.parse(lines[i]);
        lastAlert = { strategy: parsed.strategy, status: parsed.status, ts: parsed.ts };
        break;
      }
    }
  } catch {}

  // Active follow-up count = source of truth for "live setups" in dashboard.
  let activeSetups = 0;
  try {
    const fu = await import('../lib/follow_up.js');
    activeSetups = fu.active().length;
  } catch {}

  // User-editable strategies — surfaced so the dashboard can render the
  // "My Strategies" folder + its enable/disable toggles.
  let userStrategies = [];
  try {
    const us = await import('../lib/user_strategies.js');
    userStrategies = us.list();
  } catch {}

  // Pull per-instrument latest close from cloud data cache (live Yahoo).
  // The signal-engine populates this map every ~15s via cloud_data_supplement.
  let instrumentPrices = {};
  try {
    const cd = await import('../lib/cloud_data_supplement.js');
    const panes = await cd.fetchAllPanes();
    for (const inst of ['gold', 'nasdaq', 'sp']) {
      const p = panes.get(`${inst}|15`) || panes.get(`${inst}|5`);
      const last = p?.bars?.[p.bars.length - 1];
      if (last) instrumentPrices[inst] = { close: last.close, ts: last.time };
    }
  } catch {}

  return {
    config,
    cloud: { alive: cloudAlive, ageMs: cloudAgeMs, raw: { ...(cloud || {}), instrumentPrices } },
    service: { pid: servicePid, uptime: serviceUptime },
    trading_view: { pid: tvPid, cdp_open: cdpOpen },
    caffeinate: { active: caffActive },
    activity: {
      tracked_setups: activeSetups,
      active_setups: activeSetups,
      current_session: session.lastSession,
      last_alert: lastAlert,
    },
    user_strategies: userStrategies,
    allow_user_strategies: true,
    now_ms: Date.now(),
  };
}

async function saveConfig(updates) {
  // VPS is authoritative. We just write the file atomically. No git push —
  // that was racing with the bot's saveConfigAndPush writes, causing user
  // toggles (notably AMN/TORI/WARRIOR) to flip back to disabled.
  const current = loadConfig();
  const next = { ...current };
  if (updates.strategies && typeof updates.strategies === 'object') {
    next.strategies = { ...current.strategies };
    // Accept any registered built-in strategy id, plus any user strategy id.
    const valid = registryIds();
    try {
      const us = await import('../lib/user_strategies.js');
      for (const s of us.list()) valid.add(s.id);
    } catch {}
    for (const [k, v] of Object.entries(updates.strategies)) {
      if (valid.has(k)) next.strategies[k] = !!v;
    }
  }
  if (updates.mute && typeof updates.mute === 'object') next.mute = updates.mute;
  next.lastUpdated = Date.now();
  writeJsonAtomic(CONFIG_FILE, next);
  return next;
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', (c) => chunks += c.toString());
    req.on('end', () => {
      try { resolve(chunks ? JSON.parse(chunks) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// 50MB cap so a stray upload can't exhaust memory. PDFs are typically <5MB,
// images <10MB, short videos <30MB. Videos > cap will be rejected.
const UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
async function readMultipart(req) {
  const { default: Busboy } = await import('busboy');
  const files = [];
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: UPLOAD_LIMIT_BYTES, files: 8 } });
    bb.on('file', (fieldname, stream, info) => {
      const chunks = [];
      let truncated = false;
      stream.on('data', (c) => chunks.push(c));
      stream.on('limit', () => { truncated = true; });
      stream.on('end', () => {
        if (truncated) return; // skip oversize files
        files.push({
          buffer: Buffer.concat(chunks),
          filename: info.filename || 'upload',
          mimetype: info.mimeType || info.mimetype || 'application/octet-stream',
        });
      });
    });
    bb.on('finish', () => resolve(files));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

// Accept hosts: loopback, plus Cloudflare Tunnel patterns, plus anything the
// user explicitly allowlists via OCTAVE_ALLOWED_HOSTS (comma-separated).
const EXTRA_HOSTS = (process.env.OCTAVE_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
function isAllowedHost(host) {
  if (host === '127.0.0.1' || host === 'localhost') return true;
  if (host.endsWith('.trycloudflare.com')) return true;
  if (host.endsWith('.cfargotunnel.com')) return true;
  if (EXTRA_HOSTS.includes(host)) return true;
  return false;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const host = (req.headers.host || '').split(':')[0];
    if (!isAllowedHost(host)) {
      res.statusCode = 403;
      return res.end('forbidden');
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const html = readFileSync(HTML_FILE, 'utf8');
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      return res.end(html);
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const state = await gatherState();
      return sendJson(res, 200, state);
    }

    // ─── Trade Panel ────────────────────────────────────────────────────
    // GET /api/positions[?account=auto|user]  → JSON of open trades for the
    //     account(s) with current price snapshot. Polled by the panel HTML.
    if (req.method === 'GET' && url.pathname === '/api/positions') {
      try {
        const at = await import('../lib/account_tracker.js');
        const cd = await import('../lib/cloud_data_supplement.js');
        at.maybeRollDay();
        const which = (url.searchParams.get('account') || '').toLowerCase();
        const ids = which === 'auto' || which === 'user' ? [which] : at.ACCOUNT_IDS;
        // Current price per instrument (latest 15m close)
        let prices = {};
        try {
          const panes = await cd.fetchAllPanes();
          for (const inst of ['gold', 'nasdaq', 'sp']) {
            const p = panes.get(`${inst}|15`) || panes.get(`${inst}|5`);
            const last = p?.bars?.[p.bars.length - 1];
            if (last) prices[inst] = { close: last.close, time: last.time };
          }
        } catch {}
        const out = {};
        for (const id of ids) {
          const acc = at.get(id);
          out[id] = {
            enabled: acc.enabled, mode: acc.mode, phase: acc.phase,
            balance: acc.balance, dailyPnl: acc.dailyPnl, peakEod: acc.peakEodBalance,
            openTrades: (acc.openTrades || []).map((t) => ({
              ...t,
              currentPrice: prices[t.instrument]?.close ?? null,
            })),
          };
        }
        return sendJson(res, 200, { accounts: out, prices, at: Date.now() });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // GET /positions  → HTML trade panel (auto-refreshing every 3s).
    if (req.method === 'GET' && url.pathname === '/positions') {
      const html = readFileSync(join(__dirname, 'positions.html'), 'utf8');
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      return res.end(html);
    }

    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req).catch(() => null);
      if (!body) return sendJson(res, 400, { error: 'bad json' });
      const next = await saveConfig(body);
      return sendJson(res, 200, { config: next });
    }

    // ─── Strategy file upload → AI extraction ───
    if (req.method === 'POST' && url.pathname === '/api/user-strategies/upload') {
      try {
        const files = await readMultipart(req);
        if (files.length === 0) return sendJson(res, 400, { error: 'no file uploaded' });
        const { extractStrategy } = await import('../lib/strategy_extractor.js');
        const us = await import('../lib/user_strategies.js');
        const results = [];
        for (const file of files) {
          try {
            const { spec, source, notes } = await extractStrategy(file);
            // Ensure unique id — append a suffix if it collides
            let candidate = { ...spec };
            const existing = new Set(us.list().map((s) => s.id));
            let n = 1;
            while (existing.has(candidate.id)) candidate.id = `${spec.id}-${++n}`;
            const created = us.create(candidate);
            await saveConfig({ strategies: { [created.id]: true } });
            results.push({ ok: true, filename: file.filename, source, notes, strategy: created });
          } catch (err) {
            results.push({ ok: false, filename: file.filename, error: err.message });
          }
        }
        return sendJson(res, 200, { results });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // ─── User-editable strategies CRUD ───
    if (req.method === 'GET' && url.pathname === '/api/user-strategies') {
      const us = await import('../lib/user_strategies.js');
      return sendJson(res, 200, { items: us.list() });
    }
    if (req.method === 'POST' && url.pathname === '/api/user-strategies') {
      const body = await readBody(req).catch(() => null);
      if (!body) return sendJson(res, 400, { error: 'bad json' });
      try {
        const us = await import('../lib/user_strategies.js');
        const created = us.create(body);
        // Mirror enabled flag into runtime config so /enable /disable also works
        await saveConfig({ strategies: { [created.id]: created.enabled } });
        return sendJson(res, 200, created);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    const usMatch = url.pathname.match(/^\/api\/user-strategies\/(.+)$/);
    if (usMatch) {
      const id = decodeURIComponent(usMatch[1]);
      const us = await import('../lib/user_strategies.js');
      if (req.method === 'GET') {
        const item = us.get(id);
        if (!item) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, item);
      }
      if (req.method === 'PUT') {
        const body = await readBody(req).catch(() => null);
        if (!body) return sendJson(res, 400, { error: 'bad json' });
        try {
          const updated = us.update(id, body);
          await saveConfig({ strategies: { [updated.id]: updated.enabled } });
          return sendJson(res, 200, updated);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
      if (req.method === 'DELETE') {
        try { us.remove(id); }
        catch (err) { return sendJson(res, 404, { error: err.message }); }
        return sendJson(res, 200, { ok: true });
      }
    }

    // ─── Strategy registry + playbooks ───
    if (req.method === 'GET' && url.pathname === '/api/strategies') {
      const cfg = loadConfig();
      let userStrategies = [];
      try { const us = await import('../lib/user_strategies.js'); userStrategies = us.list(); } catch {}
      const builtins = REGISTRY.map((s, i) => ({
        id: s.id, num: i + 1, name: s.name, concept: s.concept,
        timeframes: s.timeframes, enabled: cfg.strategies?.[s.id] === true,
        kind: 'builtin',
        hasPlaybook: existsSync(join(REPO_DIR, 'playbooks', `${s.id}.pdf`)),
      }));
      const custom = userStrategies.map((u) => ({
        id: u.id, name: u.name, concept: u.entry || '', enabled: cfg.strategies?.[u.id] !== false,
        kind: 'user', hasPlaybook: false,
      }));
      return sendJson(res, 200, { strategies: [...builtins, ...custom] });
    }
    const pbMatch = url.pathname.match(/^\/api\/playbook\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && pbMatch) {
      const pdfPath = join(REPO_DIR, 'playbooks', `${pbMatch[1]}.pdf`);
      if (!existsSync(pdfPath)) return sendJson(res, 404, { error: 'no playbook' });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/pdf');
      res.setHeader('content-disposition', `attachment; filename="${pbMatch[1]}.pdf"`);
      return res.end(readFileSync(pdfPath));
    }

    // ─── Self-heal endpoints ───
    if (req.method === 'GET' && url.pathname === '/api/diagnose') {
      const sh = await import('../lib/self_heal.js');
      return sendJson(res, 200, { report: await sh.diagnoseAll(), components: sh.listComponents() });
    }
    if (req.method === 'POST' && url.pathname === '/api/fix') {
      const body = await readBody(req).catch(() => ({}));
      const sh = await import('../lib/self_heal.js');
      if (!body?.component || body.component === 'all') {
        return sendJson(res, 200, { log: await sh.fixAll() });
      }
      return sendJson(res, 200, { result: await sh.fixOne(body.component) });
    }

    if (req.method === 'POST' && url.pathname === '/api/open-logs') {
      // Only meaningful on Mac dev (opens Finder at the log dir). On the
      // VPS the logs are on the server's filesystem — surface the path
      // instead of pretending to "open" them.
      if (!isMac) return sendJson(res, 200, { ok: false, logDir: LOG_DIR, message: `Server logs live at ${LOG_DIR} on the VPS` });
      await exec('/usr/bin/open', [LOG_DIR]);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      const { spawn } = await import('node:child_process');
      if (isLinux) {
        // Stop each octave-* systemd unit. Bot last so this response can
        // still come back before its own service dies.
        const units = ['octave-signal-engine', 'octave-watchdog', 'octave-tunnel', 'octave-tunnel-watcher', 'octave-webui', 'octave-telegram'];
        for (const u of units) spawn('systemctl', ['stop', u], { detached: true, stdio: 'ignore' }).unref();
        return sendJson(res, 200, { ok: true, stopped: units });
      }
      // Mac dev — local Octave.app launcher.
      spawn('/Users/jqvier/Desktop/Octave.app/Contents/MacOS/octave', ['shutdown'], {
        detached: true, stdio: 'ignore',
      }).unref();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/launch-tv') {
      // Mac-only concept (TradingView Desktop). Stub on Linux to keep the
      // dashboard from logging UNCAUGHT spawn errors if a stale button or
      // an old client hits this endpoint.
      if (!isMac) return sendJson(res, 200, { ok: false, message: 'TradingView Desktop is Mac-only — VPS has no GUI' });
      const { spawn } = await import('node:child_process');
      spawn('/usr/bin/open', ['-a', 'TradingView'], { detached: true, stdio: 'ignore' }).unref();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/services') {
      const hb = await import('../lib/heartbeat.js');
      const beats = hb.readAllBeats();
      const services = ['signal-engine', 'bot', 'webui', 'watchdog', 'market-data'];
      const out = {};
      for (const s of services) {
        const b = beats[s];
        out[s] = {
          name: s,
          alive: !!b && !hb.isStale(s, b),
          beat: b,
          age_s: b ? Math.round((Date.now() - b.at) / 1000) : null,
          tolerance_s: Math.round((hb.STALE_TOLERANCE_MS[s] || 60000) / 1000),
        };
      }
      return sendJson(res, 200, { services: out, now_ms: Date.now() });
    }

    if (req.method === 'POST' && url.pathname === '/api/restart') {
      const body = await readBody(req).catch(() => ({}));
      // Map service nickname → systemd unit (Linux) or launchd label (Mac)
      const LINUX_UNITS = {
        'signal-engine': 'octave-signal-engine',
        'signals':       'octave-signal-engine',
        'bot':           'octave-telegram',
        'telegram':      'octave-telegram',
        'webui':         'octave-webui',
        'watchdog':      'octave-watchdog',
      };
      const MAC_LABELS = {
        'signal-engine': 'com.jqvier.trading-alerts',
        'signals':       'com.jqvier.trading-alerts',
        'bot':           'com.jqvier.octave-telegram',
        'telegram':      'com.jqvier.octave-telegram',
        'webui':         'com.jqvier.octave-webui',
        'watchdog':      'com.jqvier.octave-watchdog',
      };
      const map = isLinux ? LINUX_UNITS : MAC_LABELS;
      const service = String(body?.service || '');
      const { spawn } = await import('node:child_process');
      const restartCmd = (target) => {
        if (isLinux) return ['systemctl', ['restart', target]];
        return ['/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${target}`]];
      };
      if (service === 'all') {
        for (const target of Object.values(map)) {
          const [cmd, args] = restartCmd(target);
          spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
        }
        return sendJson(res, 200, { ok: true, restarted: Object.keys(map) });
      }
      const target = map[service];
      if (!target) return sendJson(res, 400, { error: `unknown service: ${service}` });
      const [cmd, args] = restartCmd(target);
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
      return sendJson(res, 200, { ok: true, restarted: target });
    }

    if (req.method === 'GET' && url.pathname === '/api/icon') {
      try {
        const iconPath = join(__dirname, 'octave-icon.png');
        const png = readFileSync(iconPath);
        res.statusCode = 200;
        res.setHeader('content-type', 'image/png');
        res.setHeader('cache-control', 'public, max-age=86400');
        return res.end(png);
      } catch {
        res.statusCode = 404;
        return res.end('no icon');
      }
    }

    // ---- Code viewer (/code page + /api/code/tree + /api/code/file) ----
    if (req.method === 'GET' && url.pathname === '/code') {
      const html = readFileSync(join(__dirname, 'code.html'), 'utf8');
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      return res.end(html);
    }

    if (req.method === 'GET' && url.pathname === '/api/code/tree') {
      const { readdirSync, statSync } = await import('node:fs');
      const SKIP = new Set(['node_modules', '.git', 'src/state', 'state']);
      function walk(dir, prefix = '') {
        const out = [];
        try {
          for (const name of readdirSync(dir).sort()) {
            if (name.startsWith('.')) continue;
            const full = join(dir, name);
            const rel = prefix ? `${prefix}/${name}` : name;
            if (SKIP.has(name) || SKIP.has(rel)) continue;
            const stat = statSync(full);
            if (stat.isDirectory()) {
              out.push({ type: 'dir', name, path: rel, children: walk(full, rel) });
            } else if (stat.isFile() && stat.size < 200 * 1024) {
              out.push({ type: 'file', name, path: rel, size: stat.size });
            }
          }
        } catch {}
        return out;
      }
      const tree = walk(REPO_DIR);
      return sendJson(res, 200, { tree, repoUrl: 'https://github.com/octavebot/octave' });
    }

    if (req.method === 'GET' && url.pathname === '/api/code/file') {
      const path = url.searchParams.get('path') || '';
      if (path.includes('..') || path.startsWith('/')) return sendJson(res, 400, { error: 'bad path' });
      const full = join(REPO_DIR, path);
      try {
        const content = readFileSync(full, 'utf8');
        return sendJson(res, 200, { path, content });
      } catch (err) {
        return sendJson(res, 404, { error: err.message });
      }
    }

    res.statusCode = 404;
    res.end('not found');
  } catch (err) {
    console.error('[webui] request error:', err.message, err.stack);
    res.statusCode = 500;
    res.end('error');
  }
});

// Default to loopback for safety. On the VPS (where Cloudflare Tunnel runs
// in the same machine) loopback is still fine — but the host-header allowlist
// protects us. Override via OCTAVE_WEBUI_BIND=0.0.0.0 if you intentionally
// want direct public access.
const BIND = process.env.OCTAVE_WEBUI_BIND || '127.0.0.1';
server.listen(PORT, BIND, () => {
  console.log(`[webui] listening on http://${BIND}:${PORT}`);
});

// Load the strategy registry so /api/strategies + config validation work.
loadStrategyRegistry();

// Webui no longer runs the Telegram bot in-process. The bot runs as its own
// LaunchAgent (com.jqvier.octave-telegram) so a bug in command handlers can't
// take down the dashboard. Heartbeat ourselves so the watchdog sees us alive.
import('../lib/heartbeat.js').then(({ startHeartbeat }) => {
  startHeartbeat('webui', 15_000, () => ({ port: PORT }));
}).catch((err) => console.error('[webui] heartbeat start failed:', err.message));

// Hardening: never let a request handler bug exit the process.
process.on('uncaughtException', (err) => {
  console.error('[webui] UNCAUGHT:', err.message, err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('[webui] UNHANDLED:', err?.message || err);
});
