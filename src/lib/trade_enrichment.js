/**
 * Enrichment orchestrator — given a triggered detector result + its ctx,
 * compute regime, volatility, sentiment, adaptive-threshold context, and
 * similar past setups. Deterministic-only path; sentimentDeep / LLM calls
 * stay off the hot path.
 *
 * Output shape consumed by the auto-journal and the AI tools:
 *   {
 *     regime:        { regime, adx, rsi, ... },
 *     volatility:    { atr, atrPct, bucket, forecastNext },
 *     sentiment:     { score, label, factors },
 *     adaptive:      { recommendedFloor, recommendation, winRate, n },
 *     similar:       { matches: [...], summary: { ... } },
 *     direction:     'LONG' | 'SHORT',
 *     instrument:    string,
 *     strategy:      string,
 *     barTime:       number,
 *     enrichedAt:    number,
 *   }
 */

import { classifyRegime } from './regime.js';
import { predictVolatility } from './volatility.js';
import { sentimentSnapshot } from './sentiment.js';
import { snapshot as adaptiveSnapshot } from './adaptive_thresholds.js';
import { findSimilarSetups } from './pattern_clustering.js';

/**
 * @param {object} r — detector result (has setupId, strategy, instrument, direction, confidence)
 * @param {object} ctx — instrument ctx from detector (has pane(tf))
 */
export function enrichSetup(r, ctx) {
  const regime = safe(() => classifyRegime(ctx, '15')) || { regime: 'undefined' };
  const volatility = safe(() => predictVolatility(ctx, '15')) || { bucket: 'undefined' };
  const sentiment = safe(() => sentimentSnapshot(ctx)) || { score: 0, label: 'neutral', factors: [] };

  const adaptiveAll = safe(() => adaptiveSnapshot()) || { byStrategy: {} };
  const adaptive = adaptiveAll.byStrategy?.[r.strategy] || { recommendedFloor: 0.50, recommendation: 'no data' };

  const similar = safe(() => findSimilarSetups({
    regime: regime.regime,
    volatilityBucket: volatility.bucket,
    rsi: regime.rsi,
    adx: regime.adx,
    direction: r.direction,
  }, 5)) || { matches: [], summary: { n: 0 } };

  return {
    regime,
    volatility,
    sentiment,
    adaptive,
    similar,
    direction: r.direction,
    instrument: r.instrument,
    strategy: r.strategy,
    barTime: r.barTime,
    enrichedAt: Date.now(),
  };
}

function safe(fn) {
  try { return fn(); } catch { return null; }
}
