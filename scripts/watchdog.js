#!/usr/bin/env node
/**
 * Octave Watchdog
 *
 * Runs as com.jqvier.octave-watchdog. Loops every 30s:
 *   1. Heartbeat itself
 *   2. Read all per-service heartbeats
 *   3. For each service that's stale, launchctl kickstart -k its LaunchAgent
 *   4. Sleep 30s
 *
 * Service → LaunchAgent label map is hardcoded below. To add a new service
 * to the watchdog's care: 1) the service starts emitting a heartbeat via
 * lib/heartbeat.js, 2) add its (heartbeat-name, launchd-label) here.
 *
 * Self-healing: if THIS watchdog dies, its own LaunchAgent (KeepAlive=true)
 * restarts it within ~10s.
 */

import { spawn } from 'node:child_process';
import { readAllBeats, isStale, beat as heartbeat } from '../src/lib/heartbeat.js';

const UID = process.getuid();

// Map heartbeat-service-name → launchd label
const SERVICE_MAP = {
  'signal-engine': 'com.jqvier.trading-alerts',
  'bot':           'com.jqvier.octave-telegram',
  'webui':         'com.jqvier.octave-webui',
};

// Don't restart the same service more than once per 5 minutes
const restartHistory = new Map();
const RESTART_COOLDOWN_MS = 5 * 60 * 1000;

function shouldRestart(service) {
  const last = restartHistory.get(service) || 0;
  return (Date.now() - last) > RESTART_COOLDOWN_MS;
}

function recordRestart(service) {
  restartHistory.set(service, Date.now());
}

function restartService(service) {
  const label = SERVICE_MAP[service];
  if (!label) return;
  console.log(`[watchdog] kickstarting ${label} (heartbeat for ${service} is stale)`);
  spawn('/bin/launchctl', ['kickstart', '-k', `gui/${UID}/${label}`], {
    detached: true, stdio: 'ignore',
  }).unref();
  recordRestart(service);
}

async function tick() {
  heartbeat('watchdog', { restartHistory: Object.fromEntries(restartHistory) });
  let beats = {};
  try { beats = readAllBeats(); }
  catch (err) { console.error('[watchdog] readAllBeats threw:', err.message); return; }

  for (const service of Object.keys(SERVICE_MAP)) {
    const b = beats[service];
    const stale = isStale(service, b);
    if (!stale) continue;
    if (!shouldRestart(service)) {
      console.log(`[watchdog] ${service} stale but cooling down (last restart < 5min ago)`);
      continue;
    }
    restartService(service);
  }
}

console.log('[watchdog] starting');
heartbeat('watchdog', { phase: 'startup' });

// First check after 60s to let services boot
setTimeout(() => {
  tick();
  setInterval(tick, 30_000);
}, 60_000);

process.on('uncaughtException', (err) => {
  console.error('[watchdog] UNCAUGHT:', err.message, err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('[watchdog] UNHANDLED:', err?.message || err);
});
