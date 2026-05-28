/**
 * Risk manager — sizing + eval-rule gates.
 *
 * Pure functions over the account state. No I/O, no Telegram. The paper
 * trader and (later) live executor call into here for every signal.
 *
 * EVAL RULES — Lucid Flex 50k account (per user spec 2026-05-23):
 *   - Starting balance:   $50,000
 *   - Profit target:      $3,000   (6% of starting balance)
 *   - Max drawdown:       $2,000   EOD trailing from peak END-OF-DAY balance
 *                                  (intraday peaks above EOD high don't count)
 *   - Consistency rule:   single largest profitable day ≤ $1,500
 *                          (= 50% of the $3,000 PROFIT TARGET, fixed cap)
 *                          waived once funded
 *
 * FUNDED RULES:
 *   - Only EOD trailing max DD is active. No consistency, no circuit breaker.
 *
 * PAYOUT RULES (funded):
 *   - Minimum $500 per request
 *   - Maximum $2,000 per request
 *   - Up to 50% of accrued profit can be withdrawn
 *   - No fixed buffer balance required
 *
 * DAILY CIRCUIT BREAKER — OUR OWN (not Lucid's), eval-only safety:
 *   - Stop trading for the day if daily P&L hits -$500
 *     (1% of account = 25% of max DD in one day — preserves runway)
 *
 * INSTRUMENT $/POINT (futures contract specs):
 *   - Gold   (MGC1!): $10 / point
 *   - Nasdaq (MNQ1!): $2  / point
 *   - S&P500 (MES1!): $5  / point
 */

export const EVAL_RULES = Object.freeze({
  startingBalance: 50_000,
  profitTarget:    3_000,
  maxDrawdown:     2_000,
  dailyCircuitBreaker: -500,      // our own, eval-only
  consistencyMaxDay:   1_500,     // 50% of $3000 target — FIXED cap
});

export const PAYOUT_RULES = Object.freeze({
  minRequestUsd:  500,
  maxRequestUsd:  2_000,
  maxProfitShare: 0.50,
});

export const INSTRUMENT_DOLLARS_PER_POINT = Object.freeze({
  gold:   10,
  nasdaq: 2,
  sp:     5,
});

/**
 * Risk MODES — switchable bundles of every risk/sizing/reward knob. The active
 * mode lives in runtime-config (`mode`) and is read by paper_trader (sizing +
 * gates), _helpers (TP profile), and asian_breakout (stop-cap budget). Switch
 * live with /mode — the engine refreshes config each tick.
 *
 *   PASSIVE     — capital preservation. Small size, low risk, banks profit
 *                 early (achievable TPs), tight daily stop. Hard to blow.
 *   AGGRESSIVE  — pushes the $3k target. Up to 10 micros/instrument, lets
 *                 winners run to 4R. Bigger positions, wider daily stop.
 *
 * riskPerTrade = $ risk budget/trade; maxContracts caps size per instrument;
 * dailyBreaker = eval-only daily stop; maxOpen caps concurrent positions;
 * asianCapUsd = budget ASIAN-BREAKOUT caps its range-mid stop to (so it sizes
 * ≥1); tp1R/tp2R are default reward multiples; tp1MaxR/tp2MaxR clamp structural
 * targets into an achievable band.
 */
export const MODES = Object.freeze({
  // `gate` = min base confidence to send a signal. 0.55 on both modes — the
  // calibrated boundary. A 2-window train/test (2026-05-28) showed 0.65 was
  // OVER-filtering: it ~halved book profit (TRAIN 177→86R, TEST 300→195R) WITHOUT
  // raising win rate (~56%/64% either way), by discarding profitable strategies
  // (VWAP/EMA/ASIAN) whose win-rate-anchored confidence sits <0.65. 0.55 keeps the
  // token floor (0.50-0.55 band is ~neutral) while letting the full +EV book trade.
  passive: Object.freeze({
    label: 'PASSIVE', riskPerTrade: 120, maxContracts: 3, dailyBreaker: -350,
    maxOpen: 2, asianCapUsd: 120, tp1R: 1.0, tp2R: 2.0, tp1MaxR: 1.5, tp2MaxR: 2.0, gate: 0.55,
  }),
  aggressive: Object.freeze({
    label: 'AGGRESSIVE', riskPerTrade: 200, maxContracts: 10, dailyBreaker: -500,
    maxOpen: 3, asianCapUsd: 200, tp1R: 1.2, tp2R: 1.8, tp1MaxR: 2.5, tp2MaxR: 4.0, gate: 0.55,
  }),
});
export const DEFAULT_MODE = 'aggressive';

/**
 * Compute position size for a signal at a target dollar risk.
 *
 * @param {object} signal  detector result with entryPlan.{ entry, stop, risk }
 * @param {object} opts    { riskUsd, dollarPerPoint, maxContracts }
 * @returns {{ contracts, riskUsdActual, riskPoints, riskRR }}
 */
export function computeSize(signal, opts = {}) {
  const riskUsdTarget = Number(opts.riskUsd) || 250;
  const dpp = Number(opts.dollarPerPoint)
    || INSTRUMENT_DOLLARS_PER_POINT[signal.instrument]
    || 1;
  const maxContracts = Number(opts.maxContracts) > 0 ? Math.floor(opts.maxContracts) : Infinity;
  const ep = signal.entryPlan || {};
  const riskPoints = Math.abs((ep.entry ?? 0) - (ep.stop ?? 0));
  if (!riskPoints || !isFinite(riskPoints) || riskPoints <= 0) {
    return { contracts: 0, riskUsdActual: 0, riskPoints: 0, riskRR: 0, error: 'invalid risk' };
  }
  const dollarPerContract = riskPoints * dpp;
  // Fractional contracts impossible — round DOWN so we never exceed target risk,
  // then cap at the mode's per-instrument max (e.g. 10 micros in aggressive).
  const byRisk = Math.max(0, Math.floor(riskUsdTarget / dollarPerContract));
  const contracts = Math.min(byRisk, maxContracts);
  const riskUsdActual = contracts * dollarPerContract;
  return {
    contracts,
    riskUsdActual,
    riskPoints,
    dollarPerContract,
    cappedByMax: byRisk > maxContracts,
    riskRR: riskUsdActual / Math.max(1, riskUsdTarget),
  };
}

/**
 * Check whether a signal can be taken given the account state.
 * Returns { allowed: boolean, reason?: string, severity?: 'hard'|'soft' }.
 *
 * Hard reasons block the trade entirely. Soft reasons would block in eval
 * mode but be allowed in funded mode (e.g. consistency rule).
 */
export function checkGates(account, signal, sizing, opts = {}) {
  // Mode-driven gate params (caller passes the active mode's values). Defaults
  // preserve the original eval rules for any caller that doesn't pass them.
  const maxOpen = Number(opts.maxOpen) > 0 ? opts.maxOpen : 3;
  const dailyBreaker = Number.isFinite(opts.dailyBreaker) ? opts.dailyBreaker : EVAL_RULES.dailyCircuitBreaker;
  if (!sizing || sizing.contracts <= 0) {
    return { allowed: false, reason: 'sizing zero contracts', severity: 'hard' };
  }
  const balance = account.balance || EVAL_RULES.startingBalance;
  // EOD-trailing DD — the trailing peak is the highest END-OF-DAY balance ever
  // recorded. Intraday spikes don't count. account_tracker maintains
  // peakEodBalance; default to startingBalance until any day closes.
  const peakEod = account.peakEodBalance || EVAL_RULES.startingBalance;
  const ddFromPeakEod = peakEod - balance;
  const ddAfterLoss = ddFromPeakEod + sizing.riskUsdActual; // worst case
  if (ddAfterLoss > EVAL_RULES.maxDrawdown) {
    return {
      allowed: false, severity: 'hard',
      reason: `EOD-trailing max-DD breach: a stop here would put DD at $${ddAfterLoss.toFixed(0)} (cap $${EVAL_RULES.maxDrawdown})`,
    };
  }
  // Max open positions — correlation protection (gold/nasdaq/sp can correlate).
  // Applies in both eval and funded.
  const openCount = (account.openTrades || []).length;
  if (openCount >= maxOpen) {
    return {
      allowed: false, severity: 'hard',
      reason: `max open positions reached (${openCount}/${maxOpen})`,
    };
  }
  // Funded skips the eval-specific gates below.
  if (account.phase === 'funded') return { allowed: true };

  // EVAL-ONLY GATES BELOW.
  // Daily circuit breaker — our own safety net, not Lucid's. Stops trading
  // for the day if it gets ugly so a bad regime can't blow the eval in one
  // session. Doesn't apply in funded (no buffer balance required).
  const dayPnl = account.dailyPnl || 0;
  if (dayPnl <= dailyBreaker) {
    return {
      allowed: false, severity: 'hard',
      reason: `daily circuit breaker hit: day P&L $${dayPnl.toFixed(0)} ≤ $${dailyBreaker} (eval-mode safety)`,
    };
  }
  if ((dayPnl - sizing.riskUsdActual) < dailyBreaker) {
    return {
      allowed: false, severity: 'hard',
      reason: `would breach daily circuit breaker on a stop ($${(dayPnl - sizing.riskUsdActual).toFixed(0)} ≤ $${dailyBreaker})`,
    };
  }
  // Consistency: single largest profitable day ≤ $1500 (50% of $3000 target).
  // Project the day's P&L if this trade is a full winner. With the 50%-at-TP1
  // / 50%-runner-to-TP2 scale-out, a winner blends to ~1.5R (0.5·1.2R +
  // 0.5·1.8R), so 1.5× the risk is the right projection. If projected day
  // exceeds the cap, block the trade.
  const projectedDayWin = dayPnl + sizing.riskUsdActual * 1.5;
  if (projectedDayWin > EVAL_RULES.consistencyMaxDay) {
    return {
      allowed: false, severity: 'soft',
      reason: `consistency: this win would put today at $${projectedDayWin.toFixed(0)} (cap $${EVAL_RULES.consistencyMaxDay}) — skip or reduce size`,
    };
  }
  return { allowed: true };
}

/**
 * Compute current eval/funded status for a `/account` style report.
 *
 * `peakEodBalance` is the highest end-of-day balance ever recorded — the
 * basis for EOD trailing DD. Intraday spikes are intentionally ignored.
 */
export function evalStatus(account) {
  const balance = account.balance || EVAL_RULES.startingBalance;
  const peakEod = account.peakEodBalance || EVAL_RULES.startingBalance;
  const ddFromPeakEod = peakEod - balance;
  const profit = balance - EVAL_RULES.startingBalance;
  const profitRemaining = Math.max(0, EVAL_RULES.profitTarget - profit);
  const ddRemaining = EVAL_RULES.maxDrawdown - ddFromPeakEod;
  const passed = profit >= EVAL_RULES.profitTarget;
  const blown = ddFromPeakEod >= EVAL_RULES.maxDrawdown;
  // Largest profitable day so far (consistency rule denominator)
  const dailyHist = account.dailyHistory || [];
  const todayPnl = account.dailyPnl || 0;
  const largestDay = Math.max(0, ...dailyHist.map((d) => d.pnl), todayPnl);
  // Funded payout capacity
  const maxPayout = Math.min(
    PAYOUT_RULES.maxRequestUsd,
    Math.max(0, profit * PAYOUT_RULES.maxProfitShare),
  );
  const payoutEligible = account.phase === 'funded' && maxPayout >= PAYOUT_RULES.minRequestUsd;
  return {
    phase: account.phase || 'eval',
    balance, peakEod, ddFromPeakEod, ddRemaining,
    profit, profitRemaining,
    passed, blown,
    dailyPnl: todayPnl,
    largestProfitableDay: largestDay,
    consistencyCap: EVAL_RULES.consistencyMaxDay,
    consistencyRoom: Math.max(0, EVAL_RULES.consistencyMaxDay - todayPnl),
    openTrades: (account.openTrades || []).length,
    payoutEligible,
    maxPayoutRequest: maxPayout,
  };
}
