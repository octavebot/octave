/**
 * Account state tracker — persistent per-account ledger.
 *
 * Two accounts are tracked independently:
 *   - 'auto':  the account the bot will (eventually) auto-execute on
 *   - 'user':  the user's account, executing alerts manually
 *
 * For now both default to paper-trading mode. The user's account starts
 * tracking when they manually report fills via /opened /closed.
 *
 * Persisted to src/state/accounts.json. Atomic writes. All mutations go
 * through this module so daily-pnl, peak-balance, history all stay coherent.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVAL_RULES } from './risk_manager.js';
import { nyParts } from './time.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_FILE = join(__dirname, '..', 'state', 'accounts.json');

// Single paper-trading account. Stays an array so iteration code remains
// generic (cheap to add a second account back if needed). 'auto' is
// accepted as an alias for 'user' by the bot for backward compat.
export const ACCOUNT_IDS = ['user'];

function defaultAccount(id) {
  return {
    id,
    phase: 'eval',                  // 'eval' | 'funded'
    enabled: false,                 // master switch — set via /risk on
    balance: EVAL_RULES.startingBalance,
    peakEodBalance: EVAL_RULES.startingBalance, // EOD trailing DD basis
    dailyPnl: 0,
    todayTrades: 0,
    dailyResetDate: null,           // NY dateKey of last reset
    openTrades: [],                 // [{ setupId, entry, stop, t1, t2, contracts, riskUsd, openedAt }]
    closedTrades: 0,
    wins: 0,
    losses: 0,
    dailyHistory: [],               // [{ dateKey, pnl, trades, eodBalance }]
    rulesViolated: [],              // ['max-dd'|'consistency'|'circuit-breaker']
    lastUpdated: Date.now(),
  };
}

function load() {
  if (!existsSync(STATE_FILE)) {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    const init = { version: 1, accounts: {} };
    for (const id of ACCOUNT_IDS) init.accounts[id] = defaultAccount(id);
    return init;
  }
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (!raw?.accounts) throw new Error('no accounts');
    // Backfill any missing fields when schema evolves.
    for (const id of ACCOUNT_IDS) {
      raw.accounts[id] = { ...defaultAccount(id), ...(raw.accounts[id] || {}) };
    }
    // Drop deprecated account ids (e.g. 'auto' from the old 2-account era).
    for (const id of Object.keys(raw.accounts)) {
      if (!ACCOUNT_IDS.includes(id)) delete raw.accounts[id];
    }
    return raw;
  } catch {
    const init = { version: 1, accounts: {} };
    for (const id of ACCOUNT_IDS) init.accounts[id] = defaultAccount(id);
    return init;
  }
}

let state = load();
let stateMtimeMs = (() => { try { return statSync(STATE_FILE).mtimeMs; } catch { return 0; } })();

// accounts.json is written from MULTIPLE processes (signal-engine on every TP/SL
// close, bot on user commands like /risk reset, etc.). Without re-reading from
// disk before a mutation, an earlier-loaded in-memory snapshot would clobber
// the other process's writes on save(). Hot reads (`get()`) stay in-memory for
// speed; mutators call `reloadIfStale()` first so they apply to the fresh state.
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
    state.lastUpdated = Date.now();
    const tmp = STATE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, STATE_FILE);
    try { stateMtimeMs = statSync(STATE_FILE).mtimeMs; } catch {}
  } catch {
    /* swallow — next save will retry */
  }
}

/** Get a snapshot of one account (mutable — callers should not mutate). */
export function get(accountId) {
  return state.accounts[accountId];
}

/** Get all accounts keyed by id. */
export function getAll() {
  return { ...state.accounts };
}

/**
 * Reset daily P&L at NY day boundary. Pushes yesterday's net to dailyHistory.
 * Safe to call every tick — only acts on day rollover.
 */
export function maybeRollDay() {
  reloadIfStale();
  const today = nyParts(Date.now() / 1000).dateKey;
  let changed = false;
  for (const id of ACCOUNT_IDS) {
    const acc = state.accounts[id];
    if (acc.dailyResetDate === today) continue;
    changed = true;
    if (acc.dailyResetDate) {
      // Push yesterday into history and ratchet the EOD peak.
      acc.dailyHistory.push({
        dateKey: acc.dailyResetDate,
        pnl: acc.dailyPnl,
        trades: acc.todayTrades || 0,
        eodBalance: acc.balance,
      });
      if (acc.dailyHistory.length > 90) acc.dailyHistory = acc.dailyHistory.slice(-90);
      // EOD trailing peak — ratchet up only.
      if (acc.balance > (acc.peakEodBalance || 0)) acc.peakEodBalance = acc.balance;
    }
    acc.dailyPnl = 0;
    acc.todayTrades = 0;
    acc.dailyResetDate = today;
  }
  if (changed) save();
}

/** Toggle whether an account participates in paper/live trading. */
export function setEnabled(accountId, enabled) {
  reloadIfStale();
  const acc = state.accounts[accountId];
  if (!acc) return false;
  acc.enabled = !!enabled;
  save();
  return true;
}

/**
 * Record an open trade. Called by the paper trader when a signal passes the
 * risk gates.
 */
export function openTrade(accountId, trade) {
  // Ensure today bucket is current before incrementing todayTrades.
  // maybeRollDay() already calls reloadIfStale, so state is fresh here.
  maybeRollDay();
  const acc = state.accounts[accountId];
  if (!acc) return false;
  acc.openTrades.push({
    setupId: trade.setupId,
    instrument: trade.instrument,
    direction: trade.direction,
    entry: trade.entry,
    stop: trade.stop,
    t1: trade.t1,
    t2: trade.t2,
    contracts: trade.contracts,
    riskUsd: trade.riskUsd,
    openedAt: Date.now(),
    strategy: trade.strategy,
  });
  acc.todayTrades = (acc.todayTrades || 0) + 1;
  save();
  return true;
}

/**
 * Record a closed trade. Called when the follow-up tracker fires a terminal
 * milestone (TP1/TP2/SL/expiry/invalidated/missed/unfilled).
 *
 * @param {string} accountId
 * @param {string} setupId
 * @param {number} pnlUsd  net dollar result of the trade (signed)
 */
export function closeTrade(accountId, setupId, pnlUsd) {
  // Ensure we're billing P&L to the CURRENT NY day. If the day flipped
  // since the last call, roll yesterday's bucket into history first so
  // this close's P&L lands in today's record, not yesterday's.
  // maybeRollDay() already calls reloadIfStale, so state is fresh here.
  maybeRollDay();
  const acc = state.accounts[accountId];
  if (!acc) return false;
  const idx = acc.openTrades.findIndex((t) => t.setupId === setupId);
  if (idx < 0) return false;
  acc.openTrades.splice(idx, 1);
  acc.balance += pnlUsd;
  acc.dailyPnl += pnlUsd;
  acc.closedTrades++;
  if (pnlUsd > 0) acc.wins++;
  else if (pnlUsd < 0) acc.losses++;
  // EOD trailing DD: peak only ratchets at day rollover, NOT on every trade.
  // Mark eval-killing violations against the EOD peak.
  const ddFromPeakEod = (acc.peakEodBalance || EVAL_RULES.startingBalance) - acc.balance;
  if (ddFromPeakEod >= EVAL_RULES.maxDrawdown && !acc.rulesViolated.includes('max-dd')) {
    acc.rulesViolated.push('max-dd');
    acc.enabled = false;  // auto-disable to prevent further damage
  }
  save();
  return true;
}

/** Reset an account to fresh state (eval restart). */
export function reset(accountId) {
  reloadIfStale();
  const acc = state.accounts[accountId];
  if (!acc) return false;
  const enabled = acc.enabled;
  state.accounts[accountId] = { ...defaultAccount(accountId), enabled };
  save();
  return true;
}
