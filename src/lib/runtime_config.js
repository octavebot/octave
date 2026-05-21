/**
 * Runtime config — shared between local Mac service and cloud GitHub Actions.
 *
 * The file at src/state/runtime-config.json is committed to the repo so both
 * sides read identical settings. Edited via the Octave.app Settings dialog
 * (which writes the file, then git commits + pushes immediately).
 *
 * Schema:
 *   {
 *     version: 1,
 *     mode: 'auto' | 'cloud' | 'local',
 *     strategies: {
 *       USLS, 'ICT-SMC', 'ALGO-SMC', ADAPTIVE, ICT, SMT, TRINITY: boolean
 *     },
 *     lastUpdated: unix-ms
 *   }
 *
 *   mode semantics:
 *     'auto'  — cloud sends when alive (heartbeat fresh); local takes over if stale (current default)
 *     'cloud' — only cloud sends Telegram; local stays silent on Telegram (still draws on TV)
 *     'local' — only local sends Telegram; cloud tick exits early without firing
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_FILE = join(__dirname, '..', 'state', 'runtime-config.json');

const DEFAULTS = Object.freeze({
  version: 1,
  mode: 'auto',
  strategies: {
    USLS: false,
    'ICT-SMC': false,
    'ALGO-SMC': false,
    ADAPTIVE: false,
    ICT: true,
    SMT: true,
    TRINITY: true,
    AMN: true,
    TORI: true,
    WARRIOR: true,
  },
  mute: { untilMs: 0, reason: null },
  alertChartImages: true,
  bypassKillzones: false,
  lastUpdated: 0,
});

// All strategy keys this system knows about (in numeric order)
export const ALL_STRATEGIES = [
  { key: 'USLS', num: '#1', label: 'Strategy #1 (USLS)' },
  { key: 'ICT-SMC', num: '#2', label: 'Strategy #2 (ICT/SMC)' },
  { key: 'ALGO-SMC', num: '#3', label: 'Strategy #3 (ALGO/SMC)' },
  { key: 'ADAPTIVE', num: '#4', label: 'Strategy #4 (Adaptive Matrix)' },
  { key: 'ICT', num: '#5', label: 'Strategy #5 (ICT)' },
  { key: 'SMT', num: '#6', label: 'Strategy #6 (SMT)' },
  { key: 'TRINITY', num: '#7', label: 'Strategy #7 (Trinity)' },
  { key: 'AMN', num: '#8', label: 'Strategy #8 (AMN — Dual-Model)' },
  { key: 'TORI', num: '#9', label: 'Strategy #9 (TORI — 4H Trendline)' },
  { key: 'WARRIOR', num: '#10', label: 'Strategy #10 (Warrior Momentum)' },
];

let cache = null;

export function load() {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    // Merge with defaults so new fields don't break old configs
    return {
      version: raw.version ?? DEFAULTS.version,
      mode: ['auto', 'cloud', 'local'].includes(raw.mode) ? raw.mode : DEFAULTS.mode,
      strategies: { ...DEFAULTS.strategies, ...(raw.strategies || {}) },
      mute: { ...DEFAULTS.mute, ...(raw.mute || {}) },
      alertChartImages: raw.alertChartImages !== false, // default true
      bypassKillzones: raw.bypassKillzones === true, // default false
      lastUpdated: raw.lastUpdated || 0,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Cached load — re-reads from disk if file mtime is newer. */
export function get() {
  if (!cache) cache = load();
  return cache;
}

/** Force reload from disk (used by long-running processes). */
export function refresh() {
  cache = load();
  return cache;
}

export function save(next) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  const merged = {
    ...DEFAULTS,
    ...next,
    strategies: { ...DEFAULTS.strategies, ...(next.strategies || {}) },
    lastUpdated: Date.now(),
  };
  const tmp = CONFIG_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(merged, null, 2));
  renameSync(tmp, CONFIG_FILE);
  cache = merged;
  return merged;
}

/** Convenience: is strategy `key` enabled in the current config? */
export function isStrategyEnabled(key) {
  const cfg = get();
  return cfg.strategies[key] === true;
}

/** Convenience: are alerts currently muted? */
export function isMuted() {
  const cfg = get();
  return (cfg.mute?.untilMs || 0) > Date.now();
}

/** How many seconds remain in the current mute, or 0 if not muted. */
export function muteRemainingSec() {
  const cfg = get();
  const until = cfg.mute?.untilMs || 0;
  return until > Date.now() ? Math.round((until - Date.now()) / 1000) : 0;
}

/** Convenience: effective Telegram-sending behavior for the local service. */
export function localTelegramBehavior({ cloudAlive }) {
  const m = get().mode;
  if (m === 'local') return 'send';   // always send
  if (m === 'cloud') return 'suppress';// never send
  // auto: suppress only if cloud is alive
  return cloudAlive ? 'suppress' : 'send';
}

/** Convenience: should the cloud tick fire alerts? */
export function cloudShouldFire() {
  return get().mode !== 'local';
}
