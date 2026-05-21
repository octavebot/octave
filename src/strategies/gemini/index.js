/**
 * Gemini Strategies pack — 5 evaluators wired into the detector via a single
 * entry point. Each is enabled/disabled independently in runtime-config.
 */

import { isStrategyEnabled } from '../../lib/runtime_config.js';
import { evaluate as asianRangeBreakout } from './asian_range_breakout.js';
import { evaluate as goldenRiverEma } from './golden_river_ema.js';
import { evaluate as institutionalOrderBlocks } from './institutional_order_blocks.js';
import { evaluate as vwapRubberBand } from './vwap_rubber_band.js';
import { evaluate as goldenFibonacci } from './golden_fibonacci.js';

const PACK = [
  ['GEM-ASIA',  asianRangeBreakout],
  ['GEM-EMA',   goldenRiverEma],
  ['GEM-FIB',   goldenFibonacci],
  ['GEM-SMC',   institutionalOrderBlocks],
  ['GEM-VWAP',  vwapRubberBand],
];

export function evaluateGeminiPack(ctx) {
  const out = [];
  for (const [key, fn] of PACK) {
    if (!isStrategyEnabled(key)) continue;
    try { out.push(...fn(ctx)); }
    catch (err) {
      console.error(`[gemini:${key}] threw:`, err.message);
    }
  }
  return out;
}
