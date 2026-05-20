import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, 'state', 'dedup.json');
const TMP_FILE = STATE_FILE + '.tmp';
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

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
  const cutoff = Date.now() - SIX_HOURS_MS;
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
