/**
 * Paper trader — shadow execution that mirrors the bot's signals against
 * a Lucid Flex 50k eval account.
 *
 * Lifecycle:
 *   1. Loop calls `onTriggered(signal)` for each fresh triggered alert.
 *      Paper trader checks risk gates, computes size, opens a paper trade
 *      if allowed, returns a metadata block the alerter can include in the
 *      signal card.
 *   2. Loop calls `onMilestone(setup, milestone, exitPrice)` whenever
 *      follow-up tracker fires a terminal event.
 *      Paper trader looks up the open trade, computes P&L in $, and closes
 *      it in account_tracker.
 *
 * EVERY public function is wrapped in try/catch that returns null on error.
 * A paper-trader bug must never break the existing alert path.
 */

import { log } from '../logger.js';
import * as accounts from './account_tracker.js';
import { computeSize, checkGates, INSTRUMENT_DOLLARS_PER_POINT } from './risk_manager.js';

// One log line per executed paper trade — JSONL for /paper trades.
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PAPER_LOG = join(__dirname, '..', 'state', 'paper-trades.jsonl');

function logTrade(row) {
  try {
    if (!existsSync(dirname(PAPER_LOG))) mkdirSync(dirname(PAPER_LOG), { recursive: true });
    appendFileSync(PAPER_LOG, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
  } catch { /* never throw from paper logger */ }
}

// Read the risk-per-trade USD from runtime config; default $250 (0.5% of 50k).
let _riskPerTradeUsd = 250;
export function setRiskPerTrade(usd) {
  const n = Number(usd);
  if (isFinite(n) && n > 0 && n <= 2000) _riskPerTradeUsd = n;
}
export function getRiskPerTrade() { return _riskPerTradeUsd; }

/**
 * Called by the loop AFTER alerter.send for every triggered signal.
 * Decides whether each enabled account should open a paper trade.
 *
 * @returns {Array<{ accountId, contracts, riskUsd, gateResult }>} per-account decisions
 *          for inclusion in the alert card (and Telegram audit log). Empty array if
 *          no accounts are participating or this is a no-op.
 */
export function onTriggered(signal) {
  const decisions = [];
  try {
    if (!signal || !signal.entryPlan) return decisions;
    accounts.maybeRollDay();
    for (const accId of accounts.ACCOUNT_IDS) {
      const acc = accounts.get(accId);
      if (!acc?.enabled) continue;
      // Sizing (target risk per trade)
      const sizing = computeSize(signal, { riskUsd: _riskPerTradeUsd });
      // Gates
      const gate = checkGates(acc, signal, sizing);
      decisions.push({
        accountId: accId,
        contracts: sizing.contracts,
        riskUsdActual: sizing.riskUsdActual,
        riskPoints: sizing.riskPoints,
        gateAllowed: gate.allowed,
        gateReason: gate.reason || null,
        gateSeverity: gate.severity || null,
      });
      if (!gate.allowed) {
        logTrade({
          event: 'gate-block', accountId: accId, setupId: signal.setupId,
          strategy: signal.strategy, reason: gate.reason, severity: gate.severity,
        });
        continue;
      }
      if (sizing.contracts <= 0) continue;
      // Open the paper trade. Paper-only — live execution is intentionally
      // not wired (user runs the bot as a reference signal source).
      accounts.openTrade(accId, {
        setupId: signal.setupId,
        instrument: signal.instrument,
        direction: signal.direction,
        entry: signal.entryPlan.entry,
        stop: signal.entryPlan.stop,
        t1: signal.entryPlan.t1,
        t2: signal.entryPlan.t2,
        contracts: sizing.contracts,
        riskUsd: sizing.riskUsdActual,
        strategy: signal.strategy,
      });
      logTrade({
        event: 'open', accountId: accId, setupId: signal.setupId,
        strategy: signal.strategy, instrument: signal.instrument,
        direction: signal.direction, contracts: sizing.contracts,
        riskUsd: sizing.riskUsdActual, entry: signal.entryPlan.entry,
        stop: signal.entryPlan.stop, t1: signal.entryPlan.t1, t2: signal.entryPlan.t2,
      });
    }
  } catch (err) {
    log.warn('paper_trader.onTriggered threw', { err: err.message, setupId: signal?.setupId });
  }
  return decisions;
}

/**
 * Called by the loop when follow-up tracker fires a terminal milestone.
 * Computes the dollar P&L and closes the trade on every enabled account
 * that has it open.
 */
export function onMilestone(setup, milestone, exitPrice) {
  try {
    if (!setup?.setupId) return;
    accounts.maybeRollDay();
    // 'filled' (entry happened) and 'be' (+1R reached → move stop to breakeven)
    // are NOT closes — the trade stays open. Only tp1/tp2/runner/sl/expired and
    // the flat outcomes below close a position.
    if (milestone === 'filled' || milestone === 'be') return;
    const isWin = ['tp1', 'tp2', 'runner'].includes(milestone);
    const isLoss = milestone === 'sl';
    const isFlat = ['invalidated', 'missed', 'unfilled'].includes(milestone);
    // Expired = close at last known price; treat as 0 if no exit price
    if (isFlat) {
      // No fill happened — just remove from open list with 0 P&L
      for (const accId of accounts.ACCOUNT_IDS) {
        const acc = accounts.get(accId);
        if (!acc?.enabled) continue;
        if (acc.openTrades.find((t) => t.setupId === setup.setupId)) {
          accounts.closeTrade(accId, setup.setupId, 0);
          logTrade({
            event: 'close-flat', accountId: accId, setupId: setup.setupId,
            milestone, pnlUsd: 0, balance: accounts.get(accId).balance,
          });
        }
      }
      return;
    }
    const dpp = INSTRUMENT_DOLLARS_PER_POINT[setup.instrument] || 1;
    const entry = setup.entry, stop = setup.stop;
    const riskPoints = Math.abs(entry - stop);
    for (const accId of accounts.ACCOUNT_IDS) {
      const acc = accounts.get(accId);
      if (!acc?.enabled) continue;
      const open = acc.openTrades.find((t) => t.setupId === setup.setupId);
      if (!open) continue;
      let resultPoints;
      if (isWin) {
        // TP1 hit = 1.5R for DAILY-TREND-PB, 1.2R for most others; trust the
        // setup.t1/t2 the strategy emitted.
        const tgt = milestone === 'tp1' ? setup.t1 : (milestone === 'tp2' || milestone === 'runner') ? setup.t2 : (exitPrice || setup.t1);
        resultPoints = Math.abs(tgt - entry);
      } else if (isLoss) {
        resultPoints = -riskPoints;
      } else {
        // expired / other — use exitPrice if available
        const px = exitPrice ?? entry;
        resultPoints = setup.direction === 'LONG' ? (px - entry) : (entry - px);
      }
      const pnlUsd = resultPoints * dpp * open.contracts;
      accounts.closeTrade(accId, setup.setupId, pnlUsd);
      logTrade({
        event: 'close', accountId: accId, setupId: setup.setupId,
        milestone, contracts: open.contracts, pnlUsd, riskUsd: open.riskUsd,
        balance: accounts.get(accId).balance,
      });
    }
  } catch (err) {
    log.warn('paper_trader.onMilestone threw', { err: err.message, setupId: setup?.setupId, milestone });
  }
}
