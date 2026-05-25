/**
 * Strategy registry — auto-discovers strategy modules from src/strategies/.
 *
 * To add a strategy: drop a .js file in src/strategies/ that exports:
 *   export const meta = {
 *     id: 'EMA-PULLBACK',                  // stable, uppercase, kebab/snake
 *     name: 'EMA Pullback Continuation',   // human label shown in alerts
 *     concept: 'Trend continuation on 20-EMA pullback',
 *     timeframes: ['15', '60'],            // panes the strategy needs
 *     instruments: ['gold', 'nasdaq', 'sp'], // (optional) default all three
 *     defaultEnabled: true,
 *   };
 *   export const playbook = `# markdown playbook…`;
 *   export function evaluate(ctx) { return [detectorResult, …]; }
 *
 * To delete a strategy: delete the file. Nothing else to edit.
 *
 * The registry is loaded once at module-import time (per process). Adding a
 * new file requires a process restart. That's acceptable — strategies are
 * a deploy-time concern, not a runtime one.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STRATEGY_DIR = join(__dirname, '..', 'strategies');
const STATS_FILE = join(__dirname, '..', 'state', 'backtest-stats.json');

let cached = null;
// Track backtest-stats.json's mtime so the registry AUTO-INVALIDATES and
// re-sorts when stats are regenerated (e.g. after a strategy edit kicks off
// a background regen via git-sync). No restart needed: next loadRegistry()
// rebuilds with the new ranking. The detector calls loadRegistry() once per
// tick (3s), so a new ranking goes live within ~3s of stats landing on disk.
let lastStatsMtime = 0;

/**
 * Read the latest backtest stats and return { id → sumR } for ranking.
 * Returns null if the file is missing or unreadable — registry falls
 * back to alphabetical order in that case.
 */
function loadProfitMap() {
  try {
    const j = JSON.parse(readFileSync(STATS_FILE, 'utf8'));
    const map = {};
    for (const r of j.rows || []) {
      if (typeof r.sumR === 'number') map[r.id] = r.sumR;
    }
    return Object.keys(map).length ? map : null;
  } catch { return null; }
}

/** Load and return the full registry. Idempotent. */
export async function loadRegistry() {
  // Auto-invalidate when backtest-stats.json mtime changes so re-tunes show
  // up in the registry ranking without a service restart.
  try {
    const m = statSync(STATS_FILE).mtimeMs;
    if (m !== lastStatsMtime) { cached = null; lastStatsMtime = m; }
  } catch { /* stats file missing — keep current cache */ }
  if (cached) return cached;
  const files = readdirSync(STRATEGY_DIR)
    .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
    .sort();
  const out = [];
  for (const f of files) {
    const url = pathToFileURL(join(STRATEGY_DIR, f)).href;
    try {
      const mod = await import(url);
      if (!mod.meta || !mod.evaluate) {
        console.error(`[registry] ${f} missing meta/evaluate — skipped`);
        continue;
      }
      out.push({
        id: mod.meta.id,
        name: mod.meta.name,
        concept: mod.meta.concept,
        window: mod.meta.window || 'Any session hour',
        timeframes: mod.meta.timeframes || ['15'],
        instruments: mod.meta.instruments || ['gold', 'nasdaq', 'sp'],
        defaultEnabled: mod.meta.defaultEnabled !== false,
        playbook: mod.playbook || '',
        evaluate: mod.evaluate,
        precheck: mod.precheck || null,
        file: f,
      });
    } catch (err) {
      console.error(`[registry] ${f} failed to import: ${err.message}`);
    }
  }
  // Sort by 45-day backtest sumR, most profitable first. Strategies with no
  // stats yet (a brand-new file that hasn't been backtested) sink to the end
  // in alphabetical order — they slot into rank on the next backtest run.
  const profitMap = loadProfitMap();
  if (profitMap) {
    out.sort((a, b) => {
      const ra = profitMap[a.id], rb = profitMap[b.id];
      const hasA = typeof ra === 'number', hasB = typeof rb === 'number';
      if (hasA && hasB) return rb - ra;
      if (hasA) return -1;
      if (hasB) return 1;
      return a.id.localeCompare(b.id);
    });
  }
  cached = out;
  return out;
}

/** Force re-import (for tests / dev). Production should restart the process. */
export function clearRegistry() { cached = null; }

/** Return all registered strategy ids. */
export async function listIds() {
  return (await loadRegistry()).map((s) => s.id);
}

/** Get one strategy by id. */
export async function getStrategy(id) {
  return (await loadRegistry()).find((s) => s.id === id) || null;
}

/** Default enabled map for runtime-config initialization. */
export async function defaultEnabledMap() {
  const reg = await loadRegistry();
  return Object.fromEntries(reg.map((s) => [s.id, s.defaultEnabled]));
}
