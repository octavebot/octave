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
import * as liveExecutor from './live_executor.js';

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
      // Open the paper trade (tracks P&L regardless of live/paper mode).
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
        live: false,  // set true if live execution succeeds below
      });
      logTrade({
        event: 'open', accountId: accId, setupId: signal.setupId,
        strategy: signal.strategy, instrument: signal.instrument,
        direction: signal.direction, contracts: sizing.contracts,
        riskUsd: sizing.riskUsdActual, entry: signal.entryPlan.entry,
        stop: signal.entryPlan.stop, t1: signal.entryPlan.t1, t2: signal.entryPlan.t2,
        mode: acc.mode,
      });

      // LIVE EXECUTION — fully autonomous when account.mode === 'live'.
      // Three independent conditions ALL required (defense in depth):
      //   acc.mode === 'live'  (default 'paper'; requires /risk auto live)
      //   webhook URL configured (/broker set-url <url>)
      //   gate already passed (above)
      // Fires asynchronously; result handled via owner Telegram notification.
      // markLive() called only on success — paper P&L tracks all trades
      // regardless of execution outcome.
      if (acc.mode === 'live') {
        liveExecutor.fireLive(accId, signal, sizing)
          .then((result) => {
            if (result.fired) accounts.markLive(accId, signal.setupId);
            logTrade({
              event: result.fired ? 'live-fired' : 'live-skipped',
              accountId: accId, setupId: signal.setupId,
              reason: result.reason, status: result.status,
            });
          })
          .catch((err) => log.warn('fireLive promise rejected', { err: err.message }));
      }
    }
  } catch (err) {
    log.warn('paper_trader.onTriggered threw', { err: err.message, setupId: signal?.setupId });
  }
  return decisions;
}

/**
 * Owner clicked "Execute Auto" or "Execute User" on the signal card.
 * Promotes the existing paper trade to live (still tracked via paper P&L,
 * but marked so downstream knows to consider it real-money).
 *
 * Idempotent: clicking twice has no effect.
 * Returns true if the trade was found and promoted; false if not (e.g.
 * already closed by SL/TP between alert and click).
 */
export function confirm(accountId, setupId) {
  try {
    const acc = accounts.get(accountId);
    if (!acc) return false;
    const t = acc.openTrades.find((x) => x.setupId === setupId);
    if (!t) return false;
    if (t.live) return true;  // already promoted
    accounts.markLive(accountId, setupId);
    logTrade({
      event: 'promote-live', accountId, setupId,
      strategy: t.strategy, contracts: t.contracts, riskUsd: t.riskUsd,
    });
    return true;
  } catch (err) {
    log.warn('paper_trader.confirm threw', { accountId, setupId, err: err.message });
    return false;
  }
}

/**
 * Owner clicked "Skip" on the signal card. Cancels any still-open paper
 * trades for this setup across every enabled account. Idempotent.
 */
export function skip(setupId) {
  try {
    for (const id of accounts.ACCOUNT_IDS) {
      const acc = accounts.get(id);
      if (!acc?.enabled) continue;
      const t = acc.openTrades.find((x) => x.setupId === setupId);
      if (t) {
        if (t.live) continue;  // can't skip an already-promoted live trade
        accounts.cancelOpen(id, setupId);
        logTrade({ event: 'skip', accountId: id, setupId, strategy: t.strategy });
      }
    }
    return true;
  } catch (err) {
    log.warn('paper_trader.skip threw', { setupId, err: err.message });
    return false;
  }
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
    const isWin = ['tp1', 'tp2', 'runner', 'filled'].includes(milestone)
      ? milestone !== 'filled'
      : false;  // 'filled' is not a close — bot still holds the trade
    if (milestone === 'filled') return;
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
