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
    // 'filled' just confirms the entry happened — nothing to settle yet.
    if (milestone === 'filled') return;

    const dpp = INSTRUMENT_DOLLARS_PER_POINT[setup.instrument] || 1;
    const entry = setup.entry;
    const long = setup.direction === 'LONG';
    // Signed points in the trade's favour (+ = profit) from a given price.
    const pts = (px) => (px == null ? 0 : (long ? px - entry : entry - px));

    // ── BE (+1R) — move the stop to breakeven. NOT a close. ─────────────────
    // Mirrors the follow-up's "trade is now risk-free" so the dashboard panel
    // shows the same BE stop the user was told to set.
    if (milestone === 'be') {
      for (const accId of accounts.ACCOUNT_IDS) {
        const acc = accounts.get(accId);
        if (!acc?.enabled) continue;
        if (acc.openTrades.find((t) => t.setupId === setup.setupId)) {
          accounts.moveStopToBE(accId, setup.setupId);
          logTrade({ event: 'be', accountId: accId, setupId: setup.setupId });
        }
      }
      return;
    }

    // ── TP1 — scale out half at t1, leave the runner open with stop at BE. ──
    // This is the risk management the alert instructs ("close 50%, leave the
    // runner, SL at BE"). The trade stays OPEN so the panel + follow-up tracker
    // agree the runner is still live until TP2/SL.
    if (milestone === 'tp1') {
      const t1Pts = pts(setup.t1);
      for (const accId of accounts.ACCOUNT_IDS) {
        const acc = accounts.get(accId);
        if (!acc?.enabled) continue;
        const open = acc.openTrades.find((t) => t.setupId === setup.setupId);
        if (!open) continue;
        const half = open.contracts / 2;
        const pnlUsd = t1Pts * dpp * half;
        accounts.partialClose(accId, setup.setupId, pnlUsd, { stop: entry, tp1Done: true, beStop: true });
        logTrade({
          event: 'partial-tp1', accountId: accId, setupId: setup.setupId,
          contracts: half, pnlUsd, balance: accounts.get(accId).balance,
        });
      }
      return;
    }

    // ── Flat outcomes — limit never produced a real position. Close at $0. ──
    if (['invalidated', 'missed', 'unfilled'].includes(milestone)) {
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

    // ── Terminal closes (tp2 / runner / sl / expired) — settle the remainder ─
    for (const accId of accounts.ACCOUNT_IDS) {
      const acc = accounts.get(accId);
      if (!acc?.enabled) continue;
      const open = acc.openTrades.find((t) => t.setupId === setup.setupId);
      if (!open) continue;
      // Remaining size: half if TP1 already scaled out, otherwise the full size.
      const remaining = open.tp1Done ? open.contracts / 2 : open.contracts;
      let exitPts;
      if (milestone === 'tp2' || milestone === 'runner') {
        exitPts = pts(setup.t2 ?? setup.t1);
      } else if (milestone === 'sl') {
        // Effective stop: breakeven if +1R/TP1 was reached (the stop we moved),
        // else the original structural stop. → 0 P&L on a breakeven stop-out.
        const beStop = open.beStop || !!setup.wasBeStop;
        exitPts = pts(beStop ? entry : setup.stop);
      } else {
        // expired / other — settle at the last known price.
        exitPts = pts(exitPrice ?? entry);
      }
      const pnlUsd = exitPts * dpp * remaining;
      accounts.closeTrade(accId, setup.setupId, pnlUsd);
      logTrade({
        event: 'close', accountId: accId, setupId: setup.setupId,
        milestone, contracts: remaining, pnlUsd, riskUsd: open.riskUsd,
        balance: accounts.get(accId).balance,
      });
    }
  } catch (err) {
    log.warn('paper_trader.onMilestone threw', { err: err.message, setupId: setup?.setupId, milestone });
  }
}
