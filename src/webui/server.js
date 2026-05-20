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

// Node import in ESM
async function exec(cmd, args, opts = {}) {
  const { spawn } = await import('node:child_process');
  return new Promise((res) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', (d) => out += d.toString());
    p.stderr.on('data', (d) => err += d.toString());
    p.on('close', (code) => res({ code, out: out.trim(), err: err.trim() }));
  });
}

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

  // Service PID + uptime
  const pidR = await exec('/usr/bin/pgrep', ['-f', 'trading-alerts/src/index.js']);
  const servicePid = pidR.code === 0 ? Number(pidR.out.split('\n')[0]) || null : null;
  let serviceUptime = null;
  if (servicePid) {
    const psR = await exec('/bin/ps', ['-p', String(servicePid), '-o', 'etime=']);
    if (psR.code === 0) serviceUptime = psR.out.trim();
  }

  // TV + CDP
  const tvR = await exec('/usr/bin/pgrep', ['-f', 'TradingView']);
  const tvPid = tvR.code === 0 ? Number(tvR.out.split('\n')[0]) || null : null;
  const cdpR = await exec('/usr/sbin/lsof', ['-i', ':9222', '-sTCP:LISTEN']);
  const cdpOpen = cdpR.code === 0;

  // Caffeinate
  const caffR = await exec('/bin/launchctl', ['print', `gui/${process.getuid()}/com.jqvier.octave-caffeinate`]);
  const caffActive = caffR.code === 0 && /state\s*=\s*running/.test(caffR.out);

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
  const current = loadConfig();
  const next = { ...current };
  if (typeof updates.mode === 'string' && ['auto', 'cloud', 'local'].includes(updates.mode)) {
    next.mode = updates.mode;
  }
  if (updates.strategies && typeof updates.strategies === 'object') {
    next.strategies = { ...current.strategies };
    for (const [k, v] of Object.entries(updates.strategies)) {
      if (k in DEFAULTS.strategies) next.strategies[k] = !!v;
    }
  }
  next.lastUpdated = Date.now();
  writeJsonAtomic(CONFIG_FILE, next);

  // Background: commit + push so cloud picks up the change
  (async () => {
    const a = await exec('/usr/bin/git', ['add', 'src/state/runtime-config.json'], { cwd: REPO_DIR });
    if (a.code !== 0) { console.error('[webui] git add failed:', a.err); return; }
    const c = await exec('/usr/bin/git', ['commit', '-m', `octave: runtime-config via webui ${new Date().toISOString()}`], { cwd: REPO_DIR });
    if (c.code !== 0 && !/nothing to commit/.test(c.out + c.err)) {
      console.error('[webui] git commit failed:', c.err || c.out);
      return;
    }
    if (/nothing to commit/.test(c.out + c.err)) {
      console.log('[webui] no change to push');
      return;
    }
    const r = await exec('/usr/bin/git', ['pull', '--rebase', '--autostash', '--quiet'], { cwd: REPO_DIR });
    const p = await exec('/usr/bin/git', ['push', '--quiet'], { cwd: REPO_DIR });
    if (p.code !== 0) console.error('[webui] git push failed:', p.err);
    else console.log('[webui] pushed config update');
  })().catch((e) => console.error('[webui] background push threw:', e.message));

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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // Loopback safety: refuse if Host header isn't localhost/127.0.0.1
    const host = (req.headers.host || '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') {
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
      const VALID = {
        'signal-engine': 'com.jqvier.trading-alerts',
        'signals':       'com.jqvier.trading-alerts',
        'bot':           'com.jqvier.octave-telegram',
        'telegram':      'com.jqvier.octave-telegram',
        'webui':         'com.jqvier.octave-webui',
        'watchdog':      'com.jqvier.octave-watchdog',
      };
      const service = String(body?.service || '');
      const { spawn } = await import('node:child_process');
      if (service === 'all') {
        for (const label of Object.values(VALID)) {
          spawn('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], { detached: true, stdio: 'ignore' }).unref();
        }
        return sendJson(res, 200, { ok: true, restarted: Object.keys(VALID) });
      }
      const label = VALID[service];
      if (!label) return sendJson(res, 400, { error: `unknown service: ${service}` });
      spawn('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], { detached: true, stdio: 'ignore' }).unref();
      return sendJson(res, 200, { ok: true, restarted: label });
    }

    if (req.method === 'POST' && url.pathname === '/api/launch-tv') {
      const { spawn } = await import('node:child_process');
      spawn('/Applications/TradingView.app/Contents/MacOS/TradingView', ['--remote-debugging-port=9222'], {
        detached: true, stdio: 'ignore',
      }).unref();
      return sendJson(res, 200, { ok: true });
    }

    res.statusCode = 404;
    res.end('not found');
  } catch (err) {
    console.error('[webui] request error:', err.message, err.stack);
    res.statusCode = 500;
    res.end('error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[webui] listening on http://127.0.0.1:${PORT}`);
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
