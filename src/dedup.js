import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, 'state', 'dedup.json');
const TMP_FILE = STATE_FILE + '.tmp';
// Dedup window. setupIds are day-scoped (embed the NY dateKey + direction +
// a per-fire discriminator), so a setup should fire at most once per day. The
// old 6h TTL broke that for ALL-DAY strategies (OTE-PULLBACK has no session
// window; ASIAN's window is 8h): a setup that fired in the morning was pruned
// after 6h, so the SAME setupId could re-fire >6h later, opening a second paper
// position that follow_up never re-armed (it had a closed record for that id)
// → an untracked "orphan" position that never hit TP/SL. A 24h TTL makes
// "once per day per setupId" true — matching the backtest (which dedups once
// per setupId) and eliminating the orphan/over-trading class. NY-FVG is
// unaffected (its setupIds embed the gap bar time, so each gap is unique).
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

function loadState() {
  if (!existsSync(STATE_FILE)) {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    return { version: 1, entries: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.entries) return { version: 1, entries: {} };
    return raw;
  } catch {
    return { version: 1, entries: {} };
  }
}

const state = loadState();
prune();
setInterval(prune, 60 * 60 * 1000).unref();

function prune() {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  let removed = 0;
  for (const [k, v] of Object.entries(state.entries)) {
    if (!v || (v.firedAt || 0) < cutoff) {
      delete state.entries[k];
      removed++;
    }
  }
  if (removed > 0) flush();
}

function flush() {
  try {
    writeFileSync(TMP_FILE, JSON.stringify(state));
    renameSync(TMP_FILE, STATE_FILE);
  } catch {
    /* swallow — next flush will retry */
  }
}

export function has(key) {
  return key in state.entries;
}

export function add(key, meta = {}) {
  state.entries[key] = { firedAt: Date.now(), ...meta };
  flush();
}

export function remove(key) {
  if (key in state.entries) {
    delete state.entries[key];
    flush();
  }
}

export function flushNow() {
  flush();
}
