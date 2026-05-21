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
    // ChatGPT pack (5 strategies)
    'CGT-EMA': true,
    'CGT-HTFSD': true,
    'CGT-LONDON': true,
    'CGT-NYREV': true,
    'CGT-VWAP': true,
    // Gemini pack (5 strategies)
    'GEM-ASIA': true,
    'GEM-EMA': true,
    'GEM-FIB': true,
    'GEM-SMC': true,
    'GEM-VWAP': true,
  },
  mute: { untilMs: 0, reason: null },
  alertChartImages: true,
  // 24/7 by default per user directive 2026-05-21: every strategy should
  // fire any hour. Toggle off via /24h off if you want killzone gating back.
  bypassKillzones: true,
  lastUpdated: 0,
});

// All strategy keys this system knows about (in display order). The first
// 10 are the original numbered set; the ChatGPT and Gemini packs each add
// 5 named strategies organized by folder.
export const ALL_STRATEGIES = [
  { key: 'USLS', num: '#1', label: 'Strategy #1 (USLS)', group: 'Core' },
  { key: 'ICT-SMC', num: '#2', label: 'Strategy #2 (ICT/SMC)', group: 'Core' },
  { key: 'ALGO-SMC', num: '#3', label: 'Strategy #3 (ALGO/SMC)', group: 'Core' },
  { key: 'ADAPTIVE', num: '#4', label: 'Strategy #4 (Adaptive Matrix)', group: 'Core' },
  { key: 'ICT', num: '#5', label: 'Strategy #5 (ICT)', group: 'Core' },
  { key: 'SMT', num: '#6', label: 'Strategy #6 (SMT)', group: 'Core' },
  { key: 'TRINITY', num: '#7', label: 'Strategy #7 (Trinity)', group: 'Core' },
  { key: 'AMN', num: '#8', label: 'Strategy #8 (AMN — Dual-Model)', group: 'Core' },
  { key: 'TORI', num: '#9', label: 'Strategy #9 (TORI — 4H Trendline)', group: 'Core' },
  { key: 'WARRIOR', num: '#10', label: 'Strategy #10 (Warrior Momentum)', group: 'Core' },
  // ChatGPT Strategies folder
  { key: 'CGT-EMA',    num: '#C1', label: 'EMA Trend Continuation', group: 'Chatgpt Strategies' },
  { key: 'CGT-HTFSD',  num: '#C2', label: 'HTF Supply & Demand Sniper', group: 'Chatgpt Strategies' },
  { key: 'CGT-LONDON', num: '#C3', label: 'London Breakout Momentum', group: 'Chatgpt Strategies' },
  { key: 'CGT-NYREV',  num: '#C4', label: 'NY Reversal Trap', group: 'Chatgpt Strategies' },
  { key: 'CGT-VWAP',   num: '#C5', label: 'VWAP Mean Reversion', group: 'Chatgpt Strategies' },
  // Gemini Strategies folder
  { key: 'GEM-ASIA',   num: '#G1', label: 'Asian Range Breakout', group: 'Gemini Strategies' },
  { key: 'GEM-EMA',    num: '#G2', label: 'Golden River EMA', group: 'Gemini Strategies' },
  { key: 'GEM-FIB',    num: '#G3', label: 'Golden Fibonacci Pullback', group: 'Gemini Strategies' },
  { key: 'GEM-SMC',    num: '#G4', label: 'Institutional Order Blocks', group: 'Gemini Strategies' },
  { key: 'GEM-VWAP',   num: '#G5', label: 'VWAP Rubber Band', group: 'Gemini Strategies' },
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

/**
 * 24/7 mode toggle: when true, every strategy ignores its killzone /
 * session-window gating and fires any hour the market is open.
 * Default is true per the 2026-05-21 user directive.
 */
export function is24x7() {
  const cfg = get();
  return cfg.bypassKillzones === true;
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
