/**
 * ChatGPT Strategies pack — 5 evaluators wired into the detector via a single
 * entry point. Each is enabled/disabled independently in runtime-config.
 */

import { isStrategyEnabled } from '../../lib/runtime_config.js';
import { evaluate as emaTrend } from './ema_trend.js';
import { evaluate as htfSupplyDemand } from './htf_supply_demand.js';
import { evaluate as londonBreakout } from './london_breakout.js';
import { evaluate as nyReversalTrap } from './ny_reversal_trap.js';
import { evaluate as vwapMeanReversion } from './vwap_mean_reversion.js';

const PACK = [
  ['CGT-EMA',    emaTrend],
  ['CGT-HTFSD',  htfSupplyDemand],
  ['CGT-LONDON', londonBreakout],
  ['CGT-NYREV',  nyReversalTrap],
  ['CGT-VWAP',   vwapMeanReversion],
];

export function evaluateChatgptPack(ctx) {
  const out = [];
  for (const [key, fn] of PACK) {
    if (!isStrategyEnabled(key)) continue;
    try { out.push(...fn(ctx)); }
    catch (err) {
      // Don't let one bad pack member kill the whole pack
      console.error(`[chatgpt:${key}] threw:`, err.message);
    }
  }
  return out;
}
