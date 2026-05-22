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

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STRATEGY_DIR = join(__dirname, '..', 'strategies');

let cached = null;

/** Load and return the full registry. Idempotent. */
export async function loadRegistry() {
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
        timeframes: mod.meta.timeframes || ['15'],
        instruments: mod.meta.instruments || ['gold', 'nasdaq', 'sp'],
        defaultEnabled: mod.meta.defaultEnabled !== false,
        playbook: mod.playbook || '',
        evaluate: mod.evaluate,
        file: f,
      });
    } catch (err) {
      console.error(`[registry] ${f} failed to import: ${err.message}`);
    }
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
