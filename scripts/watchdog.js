#!/usr/bin/env node
/**
 * Octave Watchdog
 *
 * Loops every 30s:
 *   1. Heartbeat itself
 *   2. Read all per-service heartbeats
 *   3. For each stale service:
 *      - Restart it (systemctl on Linux, launchctl on Mac)
 *      - Track "first seen stale at" time
 *      - If still stale > 5 minutes OR restarted 3+ times in 30 min,
 *        send a Telegram alert
 *
 * Self-healing: if THIS watchdog dies, its own service unit restarts it.
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { readAllBeats, isStale, beat as heartbeat } from '../src/lib/heartbeat.js';

const isLinux = process.platform === 'linux';
const isMac   = process.platform === 'darwin';

// Map heartbeat-service-name → unit/launchd-label
const SERVICE_MAP = isLinux
  ? {
      'signal-engine': 'octave-signal-engine',
      'bot':           'octave-telegram',
      'webui':         'octave-webui',
    }
  : {
      'signal-engine': 'com.jqvier.trading-alerts',
      'bot':           'com.jqvier.octave-telegram',
      'webui':         'com.jqvier.octave-webui',
    };

const RESTART_COOLDOWN_MS = 5 * 60 * 1000;
const ALERT_AFTER_MS = 5 * 60 * 1000;     // alert when stale > 5 minutes
const FLAP_WINDOW_MS = 30 * 60 * 1000;    // count restarts within this window
const FLAP_THRESHOLD = 3;                 // 3+ restarts in 30min = flapping
const ALERT_DEDUPE_MS = 30 * 60 * 1000;   // don't re-alert same service for 30min

// Per-service state tracked across ticks
const restartHistory = new Map();  // service → [timestamps]
const firstStaleAt = new Map();    // service → timestamp first observed stale
const lastAlertAt = new Map();     // service → last Telegram alert timestamp

// ---- Telegram credentials ----
function loadCreds() {
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    return { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
  }
  const envPaths = ['/home/octave/.config/trading-alerts/.env', `${process.env.HOME}/.config/trading-alerts/.env`];
  for (const p of envPaths) {
    if (!existsSync(p)) continue;
    try {
      const env = Object.fromEntries(
        readFileSync(p, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => l.split('=', 2))
      );
      if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        return { token: env.TELEGRAM_BOT_TOKEN, chat: env.TELEGRAM_CHAT_ID };
      }
    } catch {}
  }
  return null;
}

async function alertTelegram(text) {
  const creds = loadCreds();
  if (!creds) return;
  try {
    await fetch(`https://api.telegram.org/bot${creds.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: creds.chat, text, parse_mode: 'Markdown' }),
    });
  } catch (err) {
    console.error('[watchdog] alert send failed:', err.message);
  }
}

function restartService(service) {
  const target = SERVICE_MAP[service];
  if (!target) return;
  // On Linux the watchdog runs as `octave` and uses a sudoers NOPASSWD rule
  // scoped to `/bin/systemctl restart octave-*.service`. Without sudo the call
  // silently fails with "Interactive authentication required".
  const cmd = isLinux ? 'sudo' : '/bin/launchctl';
  const args = isLinux
    ? ['/bin/systemctl', 'restart', `${target}.service`]
    : ['kickstart', '-k', `gui/${process.getuid()}/${target}`];
  console.log(`[watchdog] restarting ${target} (heartbeat for ${service} is stale)`);
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', (d) => console.error(`[watchdog] restart stderr: ${d.toString().trim()}`));
  child.on('error', (e) => console.error(`[watchdog] restart spawn error: ${e.message}`));
  child.on('exit', (code) => {
    if (code !== 0) console.error(`[watchdog] restart of ${target} exited ${code}`);
  });
  child.unref();
  const history = restartHistory.get(service) || [];
  history.push(Date.now());
  restartHistory.set(service, history.filter((t) => t > Date.now() - FLAP_WINDOW_MS));
}

function shouldRestart(service) {
  const history = restartHistory.get(service) || [];
  const last = history[history.length - 1] || 0;
  return (Date.now() - last) > RESTART_COOLDOWN_MS;
}

async function tick() {
  heartbeat('watchdog', { restartHistory: Object.fromEntries(restartHistory) });
  let beats = {};
  try { beats = readAllBeats(); }
  catch (err) { console.error('[watchdog] readAllBeats threw:', err.message); return; }

  for (const service of Object.keys(SERVICE_MAP)) {
    const b = beats[service];
    const stale = isStale(service, b);

    if (!stale) {
      // Service recovered — reset stale tracking
      if (firstStaleAt.has(service)) {
        console.log(`[watchdog] ${service} recovered`);
        const wasStaleMs = Date.now() - firstStaleAt.get(service);
        firstStaleAt.delete(service);
        // Send recovery notification ONLY if we had alerted about this outage
        if (lastAlertAt.has(service) && wasStaleMs > ALERT_AFTER_MS) {
          await alertTelegram(`✅ *${service}* recovered after ${Math.round(wasStaleMs / 60000)}m of downtime.`);
          lastAlertAt.delete(service);
        }
      }
      continue;
    }

    // Mark first-seen-stale
    if (!firstStaleAt.has(service)) firstStaleAt.set(service, Date.now());
    const staleForMs = Date.now() - firstStaleAt.get(service);

    // Restart (with cooldown)
    if (shouldRestart(service)) {
      restartService(service);
    } else {
      console.log(`[watchdog] ${service} stale (${Math.round(staleForMs / 1000)}s) — cooling down`);
    }

    // Telegram alert when stale > 5min OR flapping (3+ restarts in 30min)
    const history = restartHistory.get(service) || [];
    const flapping = history.length >= FLAP_THRESHOLD;
    const longDown = staleForMs > ALERT_AFTER_MS;
    const lastAlert = lastAlertAt.get(service) || 0;
    if ((longDown || flapping) && (Date.now() - lastAlert) > ALERT_DEDUPE_MS) {
      const mins = Math.round(staleForMs / 60_000);
      let msg = `🚨 *Service down: ${service}*\n\nStale for ${mins} minutes.`;
      if (flapping) msg += `\n⚠️ Restarted ${history.length} times in the last 30 min — looks like it's crash-looping.`;
      msg += `\n\nWatchdog is restarting it every ${RESTART_COOLDOWN_MS / 60000}min. If you keep getting this alert, SSH in and check:\n\`journalctl -u octave-${service.replace('-engine', '-engine')} -n 30\``;
      await alertTelegram(msg);
      lastAlertAt.set(service, Date.now());
    }
  }
}

console.log('[watchdog] starting on', process.platform);
heartbeat('watchdog', { phase: 'startup' });

// First check after 60s (let services boot)
setTimeout(() => {
  tick();
  setInterval(tick, 30_000);
}, 60_000);

process.on('uncaughtException', (err) => console.error('[watchdog] UNCAUGHT:', err.message, err.stack));
process.on('unhandledRejection', (err) => console.error('[watchdog] UNHANDLED:', err?.message || err));
