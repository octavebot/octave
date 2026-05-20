/**
 * Per-service heartbeats.
 *
 * Each long-running service (signal engine, bot poller, webui, etc.) calls
 * `beat('serviceName', extra?)` every few seconds. The watchdog and the
 * dashboard read the latest beat per service to know if it's alive.
 *
 * Stored as src/state/heartbeats/<service>.json — atomic write each time.
 * Cheap: ~150 bytes × write every 5-30s = negligible disk activity.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HB_DIR = join(__dirname, '..', 'state', 'heartbeats');

// Per-service freshness tolerance — beyond this, watchdog considers stale and
// auto-restarts. Tuned to be 3-4x each service's normal beat interval.
export const STALE_TOLERANCE_MS = {
  'signal-engine': 30_000,   // beats every 3s; 30s = 10 missed beats
  'bot': 60_000,             // long-polls Telegram up to 25s
  'webui': 30_000,           // beats on each /api/state call + 15s timer
  'watchdog': 120_000,       // beats every 30s
  'market-data': 180_000,    // 60s TTL + buffer
};

export function beat(service, extra = {}) {
  try {
    if (!existsSync(HB_DIR)) mkdirSync(HB_DIR, { recursive: true });
    const path = join(HB_DIR, `${service}.json`);
    const tmp = `${path}.tmp`;
    const body = {
      service,
      pid: process.pid,
      at: Date.now(),
      uptime_s: Math.round(process.uptime()),
      mem_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      ...extra,
    };
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, path);
  } catch {
    // Heartbeat failures must NEVER crash the calling service
  }
}

export function readBeat(service) {
  try {
    const path = join(HB_DIR, `${service}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function readAllBeats() {
  if (!existsSync(HB_DIR)) return {};
  const out = {};
  for (const f of readdirSync(HB_DIR)) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -5);
    const b = readBeat(name);
    if (b) out[name] = b;
  }
  return out;
}

export function isStale(service, beat) {
  if (!beat) return true;
  const tol = STALE_TOLERANCE_MS[service] || 60_000;
  return (Date.now() - beat.at) > tol;
}

/**
 * Convenience: start a periodic heartbeat for a service.
 * Returns the timer handle so callers can clearInterval() on shutdown.
 */
export function startHeartbeat(service, intervalMs, extraFn = null) {
  beat(service, extraFn ? extraFn() : {}); // immediate first beat
  return setInterval(() => {
    try { beat(service, extraFn ? extraFn() : {}); }
    catch { /* swallow */ }
  }, intervalMs);
}
