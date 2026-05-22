/**
 * Runtime config — shared between local Mac service and cloud GitHub Actions.
 *
 * The file at src/state/runtime-config.json is committed to the repo so both
 * sides read identical settings. Edited via the dashboard, /enable, /disable,
 * /mute, /24h, /ai-engine commands.
 *
 * Strategy enable/disable flags are flat: { strategies: { 'STRAT-ID': boolean } }.
 * The known set of strategy IDs is derived at runtime from
 * src/strategies/* (see lib/strategy_registry.js) — adding a new strategy
 * means dropping a file in there, not editing this module.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_FILE = join(__dirname, '..', 'state', 'runtime-config.json');

const DEFAULTS = Object.freeze({
  version: 2,
  mode: 'auto',
  strategies: {},  // populated by registry on first run
  mute: { untilMs: 0, reason: null },
  alertChartImages: true,
  bypassKillzones: true,
  aiEngine: { enabled: true, threshold: 0.55 },
  lastUpdated: 0,
});

let cache = null;

export function load() {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    return {
      version: raw.version ?? DEFAULTS.version,
      mode: ['auto', 'cloud', 'local'].includes(raw.mode) ? raw.mode : DEFAULTS.mode,
      strategies: { ...(raw.strategies || {}) },
      mute: { ...DEFAULTS.mute, ...(raw.mute || {}) },
      alertChartImages: raw.alertChartImages !== false,
      bypassKillzones: raw.bypassKillzones === true,
      aiEngine: {
        enabled: raw.aiEngine?.enabled !== false,
        threshold: Number(raw.aiEngine?.threshold) || 0.55,
      },
      lastUpdated: raw.lastUpdated || 0,
    };
  } catch {
    return { ...DEFAULTS };
  }
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
  cache = merged;
  return merged;
}

/** Convenience: is strategy `key` enabled? Unknown ids default to false. */
export function isStrategyEnabled(key) {
  const cfg = get();
  return cfg.strategies[key] === true;
}

export function is24x7() { return get().bypassKillzones === true; }
export function isMuted() { return (get().mute?.untilMs || 0) > Date.now(); }
export function muteRemainingSec() {
  const until = get().mute?.untilMs || 0;
  return until > Date.now() ? Math.round((until - Date.now()) / 1000) : 0;
}

export function localTelegramBehavior({ cloudAlive }) {
  const m = get().mode;
  if (m === 'local') return 'send';
  if (m === 'cloud') return 'suppress';
  return cloudAlive ? 'suppress' : 'send';
}

export function cloudShouldFire() { return get().mode !== 'local'; }

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
