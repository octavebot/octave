/**
 * Adaptive thresholds — rolling per-strategy quality stats with a recommended
 * confidence floor that tightens after losing streaks and loosens after
 * winning streaks.
 *
 * Reads closed trades from trade_journal (paired in/out events). State
 * persists at src/state/adaptive-thresholds.json so recommendations survive
 * restart.
 *
 * The recommended floor is advisory — the detector still emits everything
 * above its own static threshold (0.5 default). UI/AI surfaces the
 * adaptive floor as a per-strategy "should I take this?" hint, and
 * downstream filters (e.g. alerter.js) can opt into respecting it.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recentTrades } from './trade_journal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, '..', 'state', 'adaptive-thresholds.json');

const WINDOW_DAYS = 14;
const MIN_TRADES = 5;
const STATIC_FLOOR = 0.50;
const MIN_FLOOR = 0.40, MAX_FLOOR = 0.85;

function loadState() {
  if (!existsSync(STATE_FILE)) return { byStrategy: {}, updatedAt: 0 };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { byStrategy: {}, updatedAt: 0 }; }
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Recompute per-strategy stats from the journal and persist. */
export function recompute() {
  const cutoff = Date.now() - WINDOW_DAYS * 86400_000;
  const trades = recentTrades(500).filter((t) =>
    (t.entryTs || 0) >= cutoff && t.exitPrice != null && t.strategy);

  const byStrategy = {};
  for (const t of trades) {
    const k = t.strategy;
    if (!byStrategy[k]) byStrategy[k] = { wins: 0, losses: 0, breakevens: 0, n: 0 };
    const s = byStrategy[k];
    s.n++;
    if (t.exitReason === 'sl') s.losses++;
    else if (t.exitReason === 'tp1' || t.exitReason === 'tp2' || t.exitReason === 'runner') s.wins++;
    else if (t.exitReason === 'be' || t.isBE) s.breakevens++;
  }

  for (const k of Object.keys(byStrategy)) {
    const s = byStrategy[k];
    const closed = s.wins + s.losses;
    s.winRate = closed ? s.wins / closed : null;
    s.recommendedFloor = recommendFloor(s.winRate, s.n);
    s.recommendation = describeRecommendation(s.winRate, s.n, s.recommendedFloor);
  }

  const state = { byStrategy, updatedAt: Date.now() };
  saveState(state);
  return state;
}

function recommendFloor(winRate, n) {
  if (winRate == null || n < MIN_TRADES) return STATIC_FLOOR;
  // High winrate → loosen (let more in). Low → tighten.
  // Linear: 60%+ winrate → -0.05; 35% or less → +0.15.
  let delta = 0;
  if (winRate >= 0.60) delta = -0.05;
  else if (winRate >= 0.50) delta = 0;
  else if (winRate >= 0.40) delta = 0.10;
  else delta = 0.15;
  return Math.max(MIN_FLOOR, Math.min(MAX_FLOOR, STATIC_FLOOR + delta));
}

function describeRecommendation(winRate, n, floor) {
  if (winRate == null || n < MIN_TRADES) return `Not enough data (${n}/${MIN_TRADES}). Holding static floor ${STATIC_FLOOR}.`;
  if (floor < STATIC_FLOOR) return `Winrate ${(winRate * 100).toFixed(0)}% over ${n} trades — LOOSEN to ${floor}.`;
  if (floor > STATIC_FLOOR) return `Winrate ${(winRate * 100).toFixed(0)}% over ${n} trades — TIGHTEN to ${floor}.`;
  return `Winrate ${(winRate * 100).toFixed(0)}% over ${n} trades — HOLD at ${floor}.`;
}

/** Snapshot for AI / dashboards. Recomputes if state is older than 5min. */
export function snapshot() {
  const s = loadState();
  if (!s.updatedAt || Date.now() - s.updatedAt > 5 * 60_000) return recompute();
  return s;
}

/** Look up the recommended floor for one strategy (falls back to static). */
export function floorFor(strategy) {
  const s = snapshot();
  return s.byStrategy?.[strategy]?.recommendedFloor ?? STATIC_FLOOR;
}
