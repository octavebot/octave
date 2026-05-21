/**
 * Follow-up tracker for triggered setups.
 *
 * When a setup is triggered, we register it here. On each detector tick the
 * tracker is given the latest gold price; it walks every active setup and
 * fires one Telegram follow-up message per milestone:
 *
 *   - "Move SL to breakeven" when price reaches +1R (favorable)
 *   - "TP1 hit"  when price crosses TP1
 *   - "TP2 hit"  when price crosses TP2
 *   - "SL hit"   when price retraces past the stop
 *   - "Expired"  when more than EXPIRY_HOURS pass without resolution
 *
 * Each milestone is recorded so the same one can't fire twice. State persists
 * to src/state/follow-ups.json across restarts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, '..', 'state', 'follow-ups.json');

const EXPIRY_HOURS = 24;

function load() {
  if (!existsSync(STATE_FILE)) {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    return { setups: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return raw?.setups ? raw : { setups: {} };
  } catch {
    return { setups: {} };
  }
}

const state = load();

function save() {
  try {
    const tmp = STATE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    log.warn('follow-up state save failed', { err: err.message });
  }
}

/**
 * Register a freshly triggered setup so future ticks can monitor it.
 * Idempotent — re-registering the same setupId is a no-op.
 *
 * @param {object} r   the DetectorResult (must have entryPlan + direction)
 */
export function register(r) {
  if (!r || r.status !== 'triggered' || !r.entryPlan) return;
  if (state.setups[r.setupId]) return;
  const ep = r.entryPlan;
  if (ep.entry == null || ep.stop == null) return;
  const risk = Math.abs(ep.entry - ep.stop);
  if (!risk) return;
  state.setups[r.setupId] = {
    setupId: r.setupId,
    strategy: r.strategy,
    direction: r.direction,
    entry: ep.entry,
    stop: ep.stop,
    t1: ep.t1 ?? null,
    t2: ep.t2 ?? null,
    runner: ep.runner ?? null,
    risk,
    createdAt: Date.now(),
    milestonesFired: {},   // be | tp1 | tp2 | runner | sl | expired -> true
    closedAt: null,
    closedReason: null,
  };
  save();
}

/**
 * Walk all active setups and return any newly-hit milestones.
 * The caller decides what to do (typically send Telegram).
 *
 * @param {number} price   latest gold price
 * @returns {Array<{setup: object, milestone: 'be'|'tp1'|'tp2'|'runner'|'sl'|'expired'}>}
 */
export function step(price) {
  if (price == null || !Number.isFinite(price)) return [];
  const events = [];
  const now = Date.now();
  let dirty = false;

  for (const id of Object.keys(state.setups)) {
    const s = state.setups[id];
    if (s.closedAt) continue;

    // Expiry check first — a setup we never reached BE on but it's been 24h
    if (now - s.createdAt > EXPIRY_HOURS * 3600 * 1000) {
      if (!s.milestonesFired.expired) {
        s.milestonesFired.expired = true;
        s.closedAt = now;
        s.closedReason = 'expired';
        events.push({ setup: { ...s }, milestone: 'expired' });
        dirty = true;
      }
      continue;
    }

    const long = s.direction === 'LONG';
    const fav = (level) => long ? price >= level : price <= level;
    const adv = (level) => long ? price <= level : price >= level;
    const bePrice = long ? s.entry + s.risk : s.entry - s.risk;

    // SL hit closes the trade entirely
    if (adv(s.stop)) {
      if (!s.milestonesFired.sl) {
        s.milestonesFired.sl = true;
        s.closedAt = now;
        s.closedReason = 'sl';
        events.push({ setup: { ...s }, milestone: 'sl' });
        dirty = true;
      }
      continue;
    }

    // BE-able? Fires once when price reaches +1R favorable
    if (!s.milestonesFired.be && fav(bePrice)) {
      s.milestonesFired.be = true;
      events.push({ setup: { ...s }, milestone: 'be' });
      dirty = true;
    }
    // TP1
    if (!s.milestonesFired.tp1 && s.t1 != null && fav(s.t1)) {
      s.milestonesFired.tp1 = true;
      events.push({ setup: { ...s }, milestone: 'tp1' });
      dirty = true;
    }
    // TP2 — also closes the trade
    if (!s.milestonesFired.tp2 && s.t2 != null && fav(s.t2)) {
      s.milestonesFired.tp2 = true;
      events.push({ setup: { ...s }, milestone: 'tp2' });
      // If no runner defined, this is the natural close
      if (s.runner == null || s.runner === s.t2) {
        s.closedAt = now;
        s.closedReason = 'tp2';
      }
      dirty = true;
    }
    // Runner
    if (!s.milestonesFired.runner && s.runner != null && s.runner !== s.t2 && fav(s.runner)) {
      s.milestonesFired.runner = true;
      s.closedAt = now;
      s.closedReason = 'runner';
      events.push({ setup: { ...s }, milestone: 'runner' });
      dirty = true;
    }
  }

  if (dirty) save();
  return events;
}

/** Active (open) setups, newest first. Used by /status & dashboards. */
export function active() {
  return Object.values(state.setups)
    .filter((s) => !s.closedAt)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Remove closed setups older than 7d so the file stays small. */
export function prune() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  let removed = 0;
  for (const id of Object.keys(state.setups)) {
    const s = state.setups[id];
    if (s.closedAt && s.closedAt < cutoff) {
      delete state.setups[id];
      removed++;
    }
  }
  if (removed) save();
  return removed;
}

setInterval(prune, 6 * 3600 * 1000).unref?.();
