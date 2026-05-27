/**
 * Runtime config — shared between local Mac service and cloud GitHub Actions.
 *
 * The file at src/state/runtime-config.json is committed to the repo so both
 * sides read identical settings. Edited via the dashboard, /enable, /disable,
 * /mute, /ai-engine commands.
 *
 * Strategy enable/disable flags are flat: { strategies: { 'STRAT-ID': boolean } }.
 * The known set of strategy IDs is derived at runtime from
 * src/strategies/* (see lib/strategy_registry.js) — adding a new strategy
 * means dropping a file in there, not editing this module.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonSafe, backupJson } from './safe_json.js';
import { MODES, DEFAULT_MODE } from './risk_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_FILE = join(__dirname, '..', 'state', 'runtime-config.json');

const DEFAULTS = Object.freeze({
  version: 2,
  strategies: {},  // populated by registry on first run
  mute: { untilMs: 0, reason: null },
  alertChartImages: false,  // chart images disabled — text-only signal cards
  aiEngine: { enabled: true, threshold: 0.55 },
  mode: DEFAULT_MODE,       // 'passive' | 'aggressive' — risk/sizing/reward bundle (see MODES)
  lastUpdated: 0,
});

let cache = null;

export function load() {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  // readJsonSafe recovers from a .bak on corruption (and records it) instead of
  // silently resetting strategy enable-state + mute to defaults.
  const raw = readJsonSafe(CONFIG_FILE, { ...DEFAULTS });
  return {
    version: raw.version ?? DEFAULTS.version,
    strategies: { ...(raw.strategies || {}) },
    mute: { ...DEFAULTS.mute, ...(raw.mute || {}) },
    alertChartImages: raw.alertChartImages === true,  // default off
    aiEngine: {
      enabled: raw.aiEngine?.enabled !== false,
      threshold: Number(raw.aiEngine?.threshold) || 0.55,
    },
    mode: (raw.mode === 'passive' || raw.mode === 'aggressive') ? raw.mode : DEFAULT_MODE,
    lastUpdated: raw.lastUpdated || 0,
  };
}

/** Active mode name ('passive'|'aggressive'). */
export function getModeName() { return get().mode || DEFAULT_MODE; }
/** Active mode's full param bundle (riskPerTrade, maxContracts, tp*, …). */
export function getMode() { return MODES[getModeName()] || MODES[DEFAULT_MODE]; }
/** Switch mode; persists to disk. Returns the new mode name, or null if invalid. */
export function setMode(name) {
  if (name !== 'passive' && name !== 'aggressive') return null;
  save({ ...get(), mode: name });
  return name;
}

/** Cached load. Call refresh() to re-read from disk. */
export function get() {
  if (!cache) cache = load();
  return cache;
}

/** Force reload from disk. */
export function refresh() {
  cache = load();
  return cache;
}

export function save(next) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  const merged = {
    ...DEFAULTS,
    ...next,
    strategies: { ...(next.strategies || {}) },
    lastUpdated: Date.now(),
  };
  const tmp = CONFIG_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(merged, null, 2));
  renameSync(tmp, CONFIG_FILE);
  backupJson(CONFIG_FILE);   // refresh last-known-good copy
  cache = merged;
  return merged;
}

/** Convenience: is strategy `key` enabled? Unknown ids default to false. */
export function isStrategyEnabled(key) {
  const cfg = get();
  return cfg.strategies[key] === true;
}

export function isMuted() { return (get().mute?.untilMs || 0) > Date.now(); }
export function muteRemainingSec() {
  const until = get().mute?.untilMs || 0;
  return until > Date.now() ? Math.round((until - Date.now()) / 1000) : 0;
}

/**
 * Async helper to merge any new strategies (from the registry) into the
 * persisted config with their defaultEnabled flag. Called by detector on
 * startup so newly-added strategies appear in the config automatically.
 */
export async function syncRegistryToConfig() {
  const { loadRegistry } = await import('./strategy_registry.js');
  const reg = await loadRegistry();
  const cfg = get();
  let changed = false;
  for (const s of reg) {
    if (!(s.id in (cfg.strategies || {}))) {
      cfg.strategies = cfg.strategies || {};
      cfg.strategies[s.id] = s.defaultEnabled;
      changed = true;
    }
  }
  if (changed) {
    save(cfg);
    console.log(`[runtime_config] synced ${reg.length} strategies from registry`);
  }
}
