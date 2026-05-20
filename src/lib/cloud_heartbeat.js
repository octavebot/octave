/**
 * Cloud heartbeat reader for the LOCAL service.
 *
 * The cloud tick (running in GitHub Actions) commits a heartbeat JSON to
 * the repo at src/state/cloud-heartbeat.json on every run. The local Mac
 * service periodically `git pull`s and reads this file to know whether
 * cloud is alive.
 *
 * Rule: if the cloud heartbeat is FRESH (less than `STALE_AFTER_MS` old),
 * local should NOT send Telegram alerts (cloud is the source of truth).
 * Local still draws on TradingView so the user sees setups visually.
 *
 * If cloud goes stale (e.g., GitHub Actions outage, repo issues, network),
 * local automatically takes over and resumes sending Telegram.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HEARTBEAT_FILE = join(__dirname, '..', 'state', 'cloud-heartbeat.json');

// Cloud runs every 5 min via GitHub Actions; allow up to 8 min of drift
// (cron isn't precise, plus push-after-commit can lag).
const STALE_AFTER_MS = 8 * 60 * 1000;

let cache = { mtime: 0, value: null };

function reload() {
  if (!existsSync(HEARTBEAT_FILE)) {
    cache = { mtime: 0, value: null };
    return;
  }
  try {
    const stat = statSync(HEARTBEAT_FILE);
    if (stat.mtimeMs === cache.mtime) return;
    const raw = JSON.parse(readFileSync(HEARTBEAT_FILE, 'utf8'));
    cache = { mtime: stat.mtimeMs, value: raw };
  } catch {
    /* keep old cache on parse error */
  }
}

/**
 * @returns {{alive: boolean, ageMs: number|null, lastTick: number|null, raw: object|null}}
 */
export function cloudStatus() {
  reload();
  if (!cache.value || !cache.value.lastTick) {
    return { alive: false, ageMs: null, lastTick: null, raw: null };
  }
  const ageMs = Date.now() - cache.value.lastTick;
  return {
    alive: ageMs <= STALE_AFTER_MS && cache.value.status === 'ok',
    ageMs,
    lastTick: cache.value.lastTick,
    raw: cache.value,
  };
}

/** Convenience: should the LOCAL service suppress its Telegram sends right now? */
export function shouldLocalSuppressTelegram() {
  const s = cloudStatus();
  return s.alive;
}
