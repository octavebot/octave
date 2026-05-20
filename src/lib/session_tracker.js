/**
 * Session-change tracker.
 *
 * Watches `activeSession(now)` and fires a one-shot Telegram banner whenever
 * the named session transitions (e.g., asia → london, ny_am → lunch, off → asia).
 *
 * State is persisted to src/state/session.json so transitions across service
 * restarts are not re-announced.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeSession, fmtNY } from './time.js';
import * as alerter from '../alerter.js';
import { log } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, '..', 'state', 'session.json');

const SESSION_HINTS = {
  asia: 'Asia open — watching for sweeps of prior NY PM range. Strategy #1 active.',
  london: 'London open — Asia range now in play. Strategy #1 + #2 monitoring sweeps.',
  ny_am: 'NY AM open — peak liquidity window. All 3 strategies live, ICT killzone bonus active 08:30–11:00 EST.',
  lunch: 'Lunch chop (10:00–13:00 EST). Strategies stay alert but cleaner setups usually come later.',
  ny_pm: 'NY PM open — NY AM range in play. Watching for late-day reversals.',
  off: 'Between sessions. Strategies still scanning recent ranges for opportunity.',
};

function loadState() {
  if (!existsSync(STATE_FILE)) {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    return { lastSession: null, lastSeenAt: 0 };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) || { lastSession: null, lastSeenAt: 0 };
  } catch {
    return { lastSession: null, lastSeenAt: 0 };
  }
}

function saveState(state) {
  try {
    const tmp = STATE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    log.warn('session tracker flush failed', { err: err.message });
  }
}

const state = loadState();

/**
 * Called each tick. If session has changed, fires a Telegram banner.
 * Returns true if a banner was sent.
 */
export async function checkSessionChange(nowUnix = Date.now() / 1000) {
  const current = activeSession(nowUnix);
  if (state.lastSession === current) return false;

  const fromSession = state.lastSession;
  state.lastSession = current;
  state.lastSeenAt = nowUnix;
  saveState(state);

  // Don't fire on the very first run (cold start) — only on actual transitions.
  if (fromSession === null) {
    log.info('session tracker initialized', { session: current });
    return false;
  }

  log.info('session change detected', { from: fromSession, to: current });
  try {
    await alerter.sendSessionChange({
      fromSession,
      toSession: current,
      nowLabel: fmtNY(nowUnix),
      hint: SESSION_HINTS[current] || '',
    });
    return true;
  } catch (err) {
    log.warn('session banner send failed', { err: err.message });
    return false;
  }
}
