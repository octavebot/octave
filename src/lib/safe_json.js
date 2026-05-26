/**
 * Corruption-resilient JSON state I/O.
 *
 * Every persistent state file (accounts, follow-ups, runtime-config) used to
 * load with `try { JSON.parse } catch { return defaults }` — so a corrupt file
 * (disk fault, truncated write, bad manual edit) SILENTLY reset the eval
 * account to $50k / dropped tracked trades / reverted strategy+mute state, with
 * no log and no alert. This module makes that loud and recoverable:
 *
 *   - readJsonSafe: parse the file; on failure restore from the last-known-good
 *     `.bak` if it parses, else fall back to the default — and RECORD the event.
 *   - backupJson: called after each successful atomic save to refresh the `.bak`.
 *   - drainCorruptionEvents: the signal loop drains this each tick and fires a
 *     Telegram ops alert, so corruption is never silent again.
 */

import {
  readFileSync, writeFileSync, existsSync, copyFileSync, appendFileSync, mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '..', 'state');
const CORRUPTION_LOG = join(STATE_DIR, 'state-corruption.jsonl');
const OFFSET_FILE = join(STATE_DIR, '.state-corruption.offset');

function clone(x) {
  try { return structuredClone(x); } catch { return JSON.parse(JSON.stringify(x)); }
}

function recordCorruption(file, action, errMsg) {
  const row = { ts: Date.now(), file, action, err: String(errMsg || '').slice(0, 200) };
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(CORRUPTION_LOG, JSON.stringify(row) + '\n');
  } catch { /* never throw from the recorder */ }
  try { console.error(`[safe_json] CORRUPT ${file} → ${action}: ${row.err}`); } catch {}
}

/**
 * Read + parse a JSON state file with recovery. Never throws.
 * @param {string} file      absolute path
 * @param {object} fallback  default value if the file is missing/unrecoverable
 */
export function readJsonSafe(file, fallback) {
  if (!existsSync(file)) return clone(fallback);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    // Snapshot a .bak on first successful read so a corruption BEFORE the file
    // is ever mutated still has a recovery point (save() only runs on writes).
    try { if (!existsSync(file + '.bak')) copyFileSync(file, file + '.bak'); } catch {}
    return parsed;
  } catch (err) {
    const bak = file + '.bak';
    if (existsSync(bak)) {
      try {
        const data = JSON.parse(readFileSync(bak, 'utf8'));
        try { copyFileSync(bak, file); } catch { /* tolerate read-only */ }
        recordCorruption(file, 'recovered-from-bak', err.message);
        return data;
      } catch { /* bak also bad → fall through to default */ }
    }
    recordCorruption(file, 'reset-to-default', err.message);
    return clone(fallback);
  }
}

/** Snapshot a just-saved file as the last-known-good `.bak`. Best-effort. */
export function backupJson(file) {
  try { if (existsSync(file)) copyFileSync(file, file + '.bak'); } catch { /* best-effort */ }
}

/**
 * Return corruption events not yet reported, advancing a persisted offset so
 * each event alerts exactly once (survives restarts). Called by the loop.
 */
export function drainCorruptionEvents() {
  if (!existsSync(CORRUPTION_LOG)) return [];
  let lines;
  try { lines = readFileSync(CORRUPTION_LOG, 'utf8').split('\n').filter(Boolean); }
  catch { return []; }
  let offset = 0;
  try { offset = parseInt(readFileSync(OFFSET_FILE, 'utf8'), 10) || 0; } catch {}
  if (lines.length <= offset) return [];
  const fresh = lines.slice(offset).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  try { writeFileSync(OFFSET_FILE, String(lines.length)); } catch {}
  return fresh;
}
