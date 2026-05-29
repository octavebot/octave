/**
 * Follow-up tracker — full limit-order lifecycle.
 *
 * A triggered setup is a LIMIT order, not an instant fill. Each setup moves
 * through phases, and the tracker fires one Telegram follow-up per transition:
 *
 *   PENDING (limit placed, waiting for price to reach the entry)
 *     → filled        price reached the entry → trade is now live
 *     → invalidated   price blew through the entry to the stop — no clean fill
 *     → missed        price ran to TP1 without ever pulling back to fill
 *     → unfilled      the fill window elapsed — limit never triggered
 *
 *   LIVE (filled, trade active)
 *     → be    +1R reached — move stop to breakeven
 *     → tp1   first target hit
 *     → tp2   second target hit
 *     → runner / sl / expired
 *
 * Setups registered before this lifecycle existed (no `phase` field) are
 * treated as already-live, preserving the old behaviour. State persists to
 * src/state/follow-ups.json across restarts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../logger.js';
import { readJsonSafe, backupJson } from './safe_json.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, '..', 'state', 'follow-ups.json');

const EXPIRY_HOURS = 24;          // a LIVE trade auto-expires this long after fill
const FILL_WINDOW_HOURS = 4;      // a PENDING limit is cancelled if unfilled this long

function load() {
  if (!existsSync(STATE_FILE)) {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    return { setups: {} };
  }
  // readJsonSafe recovers from a .bak on corruption (recording it) instead of
  // silently dropping every tracked trade.
  const raw = readJsonSafe(STATE_FILE, { setups: {} });
  return raw?.setups ? raw : { setups: {} };
}

let state = load();
let stateMtimeMs = (() => { try { return statSync(STATE_FILE).mtimeMs; } catch { return 0; } })();

// follow-ups.json is WRITTEN only by the signal-engine (register/step via the
// loop) but READ by the bot and webui (active() for /setups + the trade panel).
// Those reader processes load state once at import and would otherwise serve a
// frozen snapshot forever — a trade the engine has since closed would still show
// as "Open · live" until the reader restarts (the "/setups shows a stale London
// trade" bug). Re-read from disk whenever the file has changed under us, before
// any read or mutation. (prune() also runs on a timer in EVERY importing process,
// so without this a stale-state bot could clobber the engine's fresh writes.)
function reloadIfStale() {
  try {
    const mt = statSync(STATE_FILE).mtimeMs;
    if (mt > stateMtimeMs) {
      state = load();
      stateMtimeMs = mt;
    }
  } catch { /* file missing → keep in-memory state, save() will recreate it */ }
}

function save() {
  try {
    const tmp = STATE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, STATE_FILE);
    backupJson(STATE_FILE);   // last-known-good for corruption recovery
    try { stateMtimeMs = statSync(STATE_FILE).mtimeMs; } catch {}
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
  reloadIfStale();
  if (state.setups[r.setupId]) return;
  const ep = r.entryPlan;
  if (ep.entry == null || ep.stop == null) return;
  const risk = Math.abs(ep.entry - ep.stop);
  if (!risk) return;
  state.setups[r.setupId] = {
    setupId: r.setupId,
    strategy: r.strategy,
    instrument: r.instrument || 'gold',  // namespaced so price check uses the right pane
    direction: r.direction,
    entry: ep.entry,
    stop: ep.stop,
    t1: ep.t1 ?? null,
    t2: ep.t2 ?? null,
    runner: ep.runner ?? null,
    risk,
    phase: 'pending',      // pending → live → (closed)
    placedAt: Date.now(),
    filledAt: null,
    createdAt: Date.now(),
    milestonesFired: {},   // filled | be | tp1 | tp2 | runner | sl | expired -> true
    closedAt: null,
    closedReason: null,
  };
  save();
}

/**
 * Walk all active setups and return any newly-hit milestones.
 * The caller decides what to do (typically send Telegram).
 *
 * @param {number|object} priceOrPriceMap  Either a single price (legacy: assumed
 *   gold) or a map keyed by instrument. Each value is either a bare number or a
 *   bar snapshot `{ last, high, low }` — e.g. `{ gold: { last: 4536, high: 4541,
 *   low: 4528 } }`. When high/low are supplied, TP/SL/fill detection uses the
 *   intrabar EXTREME, so a wick that tags a target counts as a hit (not just a
 *   close-through). Setups are matched against the price for their own instrument.
 * @returns {Array<{setup: object, milestone: 'filled'|'invalidated'|'missed'|'unfilled'|'be'|'tp1'|'tp2'|'runner'|'sl'|'expired'}>}
 */
export function step(priceOrPriceMap) {
  reloadIfStale();
  const priceMap = (typeof priceOrPriceMap === 'object' && priceOrPriceMap)
    ? priceOrPriceMap
    : { gold: priceOrPriceMap };
  const events = [];
  const now = Date.now();
  let dirty = false;

  for (const id of Object.keys(state.setups)) {
    const s = state.setups[id];
    if (s.closedAt) continue;
    const q = priceMap[s.instrument || 'gold'];
    if (q == null) continue;
    // Accept a bare number (legacy) or a {last,high,low} bar snapshot.
    const last = typeof q === 'number' ? q : q.last;
    if (last == null || !Number.isFinite(last)) continue;
    const hi = (typeof q === 'object' && Number.isFinite(q.high)) ? q.high : last;
    const lo = (typeof q === 'object' && Number.isFinite(q.low)) ? q.low : last;

    const long = s.direction === 'LONG';
    // favReached: price tagged a FAVORABLE level (TP/BE) — checks the favorable
    // intrabar extreme (high for longs, low for shorts) so a wick to the target
    // counts. advReached: price tagged an ADVERSE level (stop, or the limit
    // entry on the initial pullback) — checks the adverse extreme.
    const favReached = (level) => long ? hi >= level : lo <= level;
    const advReached = (level) => long ? lo <= level : hi >= level;
    const bePrice = long ? s.entry + s.risk : s.entry - s.risk;

    // ─── PENDING phase — limit order not yet filled ──────────────────────
    // (Setups from before the lifecycle existed have no `phase` → treated as
    //  already live, so this block is skipped for them.)
    if (s.phase === 'pending') {
      // Fill: price reached the limit entry (LONG fills on a dip to entry,
      // SHORT on a rally to entry). A setup whose entry is at the current
      // price fills on the very first tick — that is the "market" case.
      const reachedEntry = advReached(s.entry);
      // Blown through: price gapped past the entry all the way to the stop.
      const pastStop = advReached(s.stop);
      // Missed: price ran to the first target without ever filling.
      const ranToTarget = s.t1 != null && favReached(s.t1);
      const unfilledExpired = now - (s.placedAt || s.createdAt) > FILL_WINDOW_HOURS * 3600 * 1000;

      if (pastStop) {
        s.phase = 'closed'; s.closedAt = now; s.closedReason = 'invalidated';
        events.push({ setup: { ...s }, milestone: 'invalidated' });
        dirty = true;
      } else if (reachedEntry) {
        s.phase = 'live'; s.filledAt = now; s.milestonesFired.filled = true;
        events.push({ setup: { ...s }, milestone: 'filled' });
        dirty = true;
      } else if (ranToTarget) {
        s.phase = 'closed'; s.closedAt = now; s.closedReason = 'missed';
        events.push({ setup: { ...s }, milestone: 'missed' });
        dirty = true;
      } else if (unfilledExpired) {
        s.phase = 'closed'; s.closedAt = now; s.closedReason = 'unfilled';
        events.push({ setup: { ...s }, milestone: 'unfilled' });
        dirty = true;
      }
      continue; // never run live-trade checks on the same tick as a fill
    }

    // ─── LIVE phase — trade is open ──────────────────────────────────────
    // A live trade auto-expires EXPIRY_HOURS after the fill (or after
    // creation for legacy setups with no filledAt).
    if (now - (s.filledAt || s.createdAt) > EXPIRY_HOURS * 3600 * 1000) {
      if (!s.milestonesFired.expired) {
        s.milestonesFired.expired = true;
        s.closedAt = now;
        s.closedReason = 'expired';
        events.push({ setup: { ...s }, milestone: 'expired' });
        dirty = true;
      }
      continue;
    }

    // Once +1R (be) or TP1 is reached, the stop is at breakeven (entry) — that
    // is exactly what the follow-up told the user to do ("trade is now risk-free"
    // / "SL should be at BE"). SL detection must use that BE-moved stop, not the
    // original structural stop. Otherwise a trade we already announced as
    // risk-free could still reverse to the original stop and book a full -1R,
    // which is the "not using proper risk management" bug.
    const beActive = !!s.milestonesFired.be || !!s.milestonesFired.tp1;
    const slLevel = beActive ? s.entry : s.stop;

    // SL hit closes the trade entirely. Checked before TPs so an ambiguous bar
    // that tagged both the stop and a target resolves to the stop (conservative).
    if (advReached(slLevel)) {
      if (!s.milestonesFired.sl) {
        s.milestonesFired.sl = true;
        s.closedAt = now;
        s.closedReason = beActive ? 'be-stop' : 'sl';
        s.exitLevel = slLevel;        // entry when BE-active, else original stop
        s.wasBeStop = beActive;
        events.push({ setup: { ...s }, milestone: 'sl' });
        dirty = true;
      }
      continue;
    }

    // BE-able? Fires once when price reaches +1R favorable. Suppressed if TP1
    // already fired — TP1 moves the stop to BE itself, so a separate "move to
    // breakeven" ping (possible when a structural TP1 sits below +1R) would be
    // a confusing duplicate.
    if (!s.milestonesFired.be && !s.milestonesFired.tp1 && favReached(bePrice)) {
      s.milestonesFired.be = true;
      events.push({ setup: { ...s }, milestone: 'be' });
      dirty = true;
    }
    // TP1
    if (!s.milestonesFired.tp1 && s.t1 != null && favReached(s.t1)) {
      s.milestonesFired.tp1 = true;
      events.push({ setup: { ...s }, milestone: 'tp1' });
      dirty = true;
    }
    // TP2 — also closes the trade
    if (!s.milestonesFired.tp2 && s.t2 != null && favReached(s.t2)) {
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
    if (!s.milestonesFired.runner && s.runner != null && s.runner !== s.t2 && favReached(s.runner)) {
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
// A setup still "open" after this long is stale — the trade resolved and the
// tracker missed the exit, or it belonged to a since-removed strategy. Either
// way it should not count as a live position.
const STALE_OPEN_MS = 36 * 3600 * 1000;

export function active() {
  reloadIfStale();
  const now = Date.now();
  return Object.values(state.setups)
    .filter((s) => !s.closedAt && (now - (s.createdAt || 0)) < STALE_OPEN_MS)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Force-close a tracked setup because a higher-win-rate opposite signal took
 * over the instrument (see loop.js conflict guard). Marks it closed so it
 * leaves active() and stops generating TP/SL pings. Returns the closed setup
 * (a copy) or null if it wasn't open. The paper position + journal + Telegram
 * are settled by the caller — this only updates the tracker's own state.
 */
export function closeForConflict(setupId) {
  reloadIfStale();
  const s = state.setups[setupId];
  if (!s || s.closedAt) return null;
  s.closedAt = Date.now();
  s.closedReason = 'conflict';
  save();
  return { ...s };
}

/** Drop closed setups >7d old and stale-open setups >36h old. */
export function prune() {
  reloadIfStale();
  const now = Date.now();
  const closedCutoff = now - 7 * 24 * 3600 * 1000;
  let removed = 0;
  for (const id of Object.keys(state.setups)) {
    const s = state.setups[id];
    const staleClosed = s.closedAt && s.closedAt < closedCutoff;
    const staleOpen = !s.closedAt && (now - (s.createdAt || 0)) > STALE_OPEN_MS;
    if (staleClosed || staleOpen) {
      delete state.setups[id];
      removed++;
    }
  }
  if (removed) save();
  return removed;
}

setInterval(prune, 6 * 3600 * 1000).unref?.();
