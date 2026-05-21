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
const DRAWINGS_FILE = join(STATE_DIR, 'drawings.json');
const SESSION_FILE = join(STATE_DIR, 'session.json');
const LOG_DIR = '/Users/jqvier/Library/Logs/trading-alerts';
const HTML_FILE = join(__dirname, 'index.html');
const PORT = parseInt(process.env.OCTAVE_WEBUI_PORT || '7345', 10);

const DEFAULTS = {
  version: 1,
  mode: 'auto',
  strategies: {
    USLS: false, 'ICT-SMC': false, 'ALGO-SMC': false, ADAPTIVE: false,
    ICT: true, SMT: true, TRINITY: true,
    AMN: true, TORI: true, WARRIOR: true,
    // ChatGPT Strategies pack
    'CGT-EMA': true, 'CGT-HTFSD': true, 'CGT-LONDON': true, 'CGT-NYREV': true, 'CGT-VWAP': true,
    // Gemini Strategies pack
    'GEM-ASIA': true, 'GEM-EMA': true, 'GEM-FIB': true, 'GEM-SMC': true, 'GEM-VWAP': true,
  },
  lastUpdated: 0,
};

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

  const drawings = readJson(DRAWINGS_FILE, { setups: {} });
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

  // Last alert from stdout log
  let lastAlert = null;
  try {
    const out = readFileSync(join(LOG_DIR, 'stdout.log'), 'utf8');
    const lines = out.trim().split('\n');
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 500); i--) {
      if (lines[i].includes('"alert fired"')) {
        const parsed = JSON.parse(lines[i]);
        lastAlert = { strategy: parsed.strategy, status: parsed.status, ts: parsed.ts };
        break;
      }
    }
  } catch {}

  return {
    config,
    cloud: { alive: cloudAlive, ageMs: cloudAgeMs, raw: cloud },
    service: { pid: servicePid, uptime: serviceUptime },
    trading_view: { pid: tvPid, cdp_open: cdpOpen },
    caffeinate: { active: caffActive },
    activity: {
      tracked_setups: Object.keys(drawings.setups || {}).length,
      current_session: session.lastSession,
      last_alert: lastAlert,
    },
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
    for (const [k, v] of Object.entries(updates.strategies)) {
      if (k in DEFAULTS.strategies) next.strategies[k] = !!v;
    }
  }
  if (typeof updates.bypassKillzones === 'boolean') next.bypassKillzones = updates.bypassKillzones;
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

    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req).catch(() => null);
      if (!body) return sendJson(res, 400, { error: 'bad json' });
      const next = await saveConfig(body);
      return sendJson(res, 200, { config: next });
    }

    if (req.method === 'POST' && url.pathname === '/api/open-logs') {
      await exec('/usr/bin/open', [LOG_DIR]);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      const { spawn } = await import('node:child_process');
      spawn('/Users/jqvier/Desktop/Octave.app/Contents/MacOS/octave', ['shutdown'], {
        detached: true, stdio: 'ignore',
      }).unref();
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
