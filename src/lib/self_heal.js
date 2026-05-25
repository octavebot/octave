/**
 * Self-healing toolkit.
 *
 * Each "component" is a (name, diagnose, fix) triple. The /fix command runs
 * diagnose first; if it returns issues, the fixer runs and re-diagnoses.
 *
 * Detection only — actions are platform-specific (LaunchAgent on Mac, systemd
 * unit on VPS Linux). The platform helpers `restart(unit)` and `pgrepRun(name)`
 * handle the difference; each fixer just declares which units it owns.
 */

import { existsSync, readFileSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_DIR = join(__dirname, '..', '..');
const HEARTBEAT_DIR = join(REPO_DIR, 'src', 'state', 'heartbeats');
const HEALTH_LOG_FILE = join(REPO_DIR, 'src', 'state', 'self-heal.log');

const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

const STALE_TOLERANCE_MS = 8 * 60 * 1000; // 8 minutes — matches existing heartbeat logic

// ─── Platform helpers ────────────────────────────────────────────────────

async function exec(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = '', err = '', settled = false;
    const settle = (code) => { if (!settled) { settled = true; resolve({ code, out: out.trim(), err: err.trim() }); } };
    let p;
    try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return settle(127); }
    p.stdout.on('data', (d) => out += d.toString());
    p.stderr.on('data', (d) => err += d.toString());
    p.on('exit', (code) => settle(code ?? 1));
    p.on('error', () => settle(1));
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} settle(124); }, timeoutMs);
  });
}

async function isProcessRunning(searchPattern) {
  const r = await exec('pgrep', ['-f', searchPattern]);
  return r.code === 0 && r.out.length > 0;
}

async function restartUnit({ macAgent, systemdUnit }) {
  if (IS_MAC && macAgent) {
    const r = await exec('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${macAgent}`]);
    return r.code === 0;
  }
  if (IS_LINUX && systemdUnit) {
    const r = await exec('systemctl', ['restart', '--user', systemdUnit]);
    if (r.code === 0) return true;
    // Some setups run units in system scope instead of user scope
    const r2 = await exec('sudo', ['systemctl', 'restart', systemdUnit]);
    return r2.code === 0;
  }
  return false;
}

function readHeartbeatAgeMs(serviceName) {
  const path = join(HEARTBEAT_DIR, `${serviceName}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    // heartbeat.js writes `at`; older code wrote `ts`/`lastTick` — accept all.
    const ts = raw?.at || raw?.ts || raw?.lastTick;
    if (!ts) return null;
    return Date.now() - ts;
  } catch { return null; }
}

function appendHealLog(entry) {
  try {
    mkdirSync(dirname(HEALTH_LOG_FILE), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    // Cap log to ~1 MB by truncating on overflow
    if (existsSync(HEALTH_LOG_FILE) && statSync(HEALTH_LOG_FILE).size > 1024 * 1024) {
      const old = readFileSync(HEALTH_LOG_FILE, 'utf8').split('\n').slice(-500).join('\n');
      writeFileSync(HEALTH_LOG_FILE, old);
    }
    writeFileSync(HEALTH_LOG_FILE, line, { flag: 'a' });
  } catch {}
}

// ─── Component definitions ───────────────────────────────────────────────

const COMPONENTS = {
  'signal-engine': {
    label: 'Signal engine (strategy evaluator)',
    macAgent: 'com.jqvier.trading-alerts',
    systemdUnit: 'octave-signal-engine.service',
    processPattern: 'trading-alerts/src/index.js',
    heartbeat: 'signal-engine',
  },
  'bot': {
    label: 'Telegram bot poller',
    macAgent: 'com.jqvier.octave-telegram',
    systemdUnit: 'octave-telegram.service', // real unit (was octave-bot.service — nonexistent → bot would never auto-recover if it crashed)
    processPattern: 'webui/bot.js',
    heartbeat: 'bot',
  },
  'webui': {
    label: 'Dashboard webui',
    macAgent: 'com.jqvier.octave-webui',
    systemdUnit: 'octave-webui.service',
    processPattern: 'webui/server.js',
    heartbeat: 'webui',
  },
  'watchdog': {
    label: 'Watchdog',
    macAgent: 'com.jqvier.octave-watchdog',
    systemdUnit: 'octave-watchdog.service',
    processPattern: 'scripts/watchdog.js',
    heartbeat: 'watchdog',
  },
  'market-data': {
    label: 'Market data cache (Yahoo)',
    heartbeat: 'market-data',
    // No process of its own — lives inside signal-engine. Restart that.
    owner: 'signal-engine',
  },
  'backtest': {
    label: 'Backtest harness',
    // Backtest is a one-shot child process. "Fixing" = clearing stale state.
    fixer: async () => {
      const dedupPath = join(REPO_DIR, 'src', 'state', 'follow-ups.json');
      try { writeFileSync(dedupPath, JSON.stringify({ setups: {} }, null, 2)); } catch {}
      // Re-spawn a dry-run to verify it actually executes
      const r = await exec(process.execPath, ['scripts/run-backtest-child.js', '--days', '1'], 60_000);
      return r.code === 0;
    },
    diagnose: async () => {
      const r = await exec(process.execPath, ['-e', 'await import("./src/backtest.js"); console.log("ok");'], 8_000);
      if (r.code !== 0) return [`backtest module fails to import: ${r.err.slice(0, 200)}`];
      return [];
    },
  },
};

// ─── Diagnose + fix orchestration ────────────────────────────────────────

async function diagnoseComponent(key) {
  const c = COMPONENTS[key];
  if (!c) return { ok: false, issues: [`unknown component: ${key}`] };
  const issues = [];
  // Custom diagnose
  if (c.diagnose) {
    const custom = await c.diagnose();
    if (custom && custom.length) issues.push(...custom);
  }
  // Process check
  if (c.processPattern && !(await isProcessRunning(c.processPattern))) {
    issues.push(`process not running (pgrep -f ${c.processPattern})`);
  }
  // Heartbeat check
  if (c.heartbeat) {
    const age = readHeartbeatAgeMs(c.heartbeat);
    if (age === null) issues.push(`no heartbeat file for ${c.heartbeat}`);
    else if (age > STALE_TOLERANCE_MS) issues.push(`heartbeat stale: ${Math.round(age / 1000)}s old`);
  }
  return { ok: issues.length === 0, issues };
}

async function fixComponent(key) {
  const c = COMPONENTS[key];
  if (!c) return { ok: false, actions: [], message: `unknown component: ${key}` };
  const actions = [];
  // If this is a passive component (e.g. market-data lives inside signal-engine),
  // delegate to the owner.
  if (c.owner) {
    actions.push(`delegating to owner: ${c.owner}`);
    const r = await fixComponent(c.owner);
    return { ok: r.ok, actions: [...actions, ...r.actions], message: r.message };
  }
  // Custom fixer wins
  if (c.fixer) {
    const ok = await c.fixer();
    actions.push(ok ? 'ran custom fixer (ok)' : 'ran custom fixer (failed)');
    if (!ok) return { ok: false, actions, message: 'custom fixer failed' };
    return { ok: true, actions };
  }
  // Default: restart the LaunchAgent / systemd unit
  if (c.macAgent || c.systemdUnit) {
    const restarted = await restartUnit({ macAgent: c.macAgent, systemdUnit: c.systemdUnit });
    actions.push(restarted ? `restarted ${c.macAgent || c.systemdUnit}` : `restart failed for ${c.macAgent || c.systemdUnit}`);
    // Give it time to come up then re-diagnose
    await new Promise((r) => setTimeout(r, 4000));
    const d = await diagnoseComponent(key);
    return { ok: d.ok, actions, message: d.ok ? '' : `after restart: ${d.issues.join('; ')}` };
  }
  return { ok: false, actions, message: 'no fix strategy registered' };
}

// ─── Public API ──────────────────────────────────────────────────────────

export function listComponents() {
  return Object.entries(COMPONENTS).map(([key, c]) => ({ key, label: c.label }));
}

export async function diagnoseAll() {
  const report = {};
  for (const key of Object.keys(COMPONENTS)) {
    report[key] = await diagnoseComponent(key);
  }
  return report;
}

export async function fixAll() {
  const log = {};
  for (const key of Object.keys(COMPONENTS)) {
    const d = await diagnoseComponent(key);
    if (d.ok) { log[key] = { ok: true, actions: ['(healthy — no action)'], wasHealthy: true }; continue; }
    const f = await fixComponent(key);
    log[key] = { ...f, issues: d.issues };
  }
  appendHealLog({ kind: 'fix-all', log });
  return log;
}

export async function fixOne(key) {
  const d = await diagnoseComponent(key);
  if (d.ok) return { ok: true, actions: ['(healthy — no action)'], wasHealthy: true };
  const f = await fixComponent(key);
  appendHealLog({ kind: 'fix-one', component: key, issues: d.issues, ...f });
  return { ...f, issues: d.issues };
}

export async function diagnoseOne(key) { return diagnoseComponent(key); }
