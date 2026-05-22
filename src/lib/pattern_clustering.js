/**
 * Pattern clustering — finds the N past trades most similar to a candidate
 * setup, by cosine similarity on a feature vector.
 *
 * Rather than k-means (overkill for our trade volume), we just compute
 * pairwise cosine and return the top matches with their actual outcomes.
 * This is more useful in practice: "given this setup looks 0.92 similar
 * to these 5 past trades, which were 3W/2L → expected EV +0.4R".
 *
 * Feature vector (12 dims):
 *   [reg_trend_up, reg_trend_down, reg_range, reg_breakout, reg_reversal,   // 5 regime one-hots
 *    vol_low, vol_normal, vol_elevated, vol_extreme,                        // 4 vol one-hots
 *    rsi_norm,                                                              // RSI/100
 *    adx_norm,                                                              // ADX/100, capped at 1
 *    direction]                                                             // 1=LONG, -1=SHORT
 *
 * Needs the candidate's enrichment block (see trade_enrichment.js). Past
 * trades must have an enrichment block too — only auto-logged trades
 * qualify, since manual entries lack the features.
 */

import { recentTrades, read as readJournal } from './trade_journal.js';

const FEATURE_DIM = 12;

/**
 * Find similar past trades.
 * @param {object} candidate — { regime, volatilityBucket, rsi, adx, direction }
 * @param {number} [n=5] — how many neighbours
 * @returns {{ matches: Array, summary: object }}
 */
export function findSimilarSetups(candidate, n = 5) {
  const candVec = featureVector(candidate);
  if (!candVec) return { matches: [], summary: { reason: 'candidate-missing-features' } };

  // Walk the journal for 'in' events that carry enrichment, then look up
  // the paired outcome.
  const allEntries = readJournal({ limit: 5000 }).filter((e) => e.action === 'in' && e.enrichment);
  const enriched = [];
  for (const entry of allEntries) {
    const vec = featureVectorFromEnrichment(entry.enrichment, entry);
    if (!vec) continue;
    const sim = cosine(candVec, vec);
    // Look up outcome
    const trades = recentTrades(500);
    const t = trades.find((x) => x.setupId === entry.setupId);
    if (!t || t.exitPrice == null) continue; // only closed trades count
    enriched.push({
      setupId: entry.setupId,
      strategy: entry.strategy,
      instrument: entry.instrument,
      direction: entry.enrichment.direction,
      regime: entry.enrichment.regime?.regime,
      volBucket: entry.enrichment.volatility?.bucket,
      similarity: sim,
      exitReason: t.exitReason,
      outcome: outcomeOf(t),
      entryTs: entry.ts,
    });
  }

  enriched.sort((a, b) => b.similarity - a.similarity);
  const matches = enriched.slice(0, n);

  const wins = matches.filter((m) => m.outcome === 'WIN').length;
  const losses = matches.filter((m) => m.outcome === 'LOSS').length;
  const bes = matches.filter((m) => m.outcome === 'BE').length;
  const winRate = wins + losses > 0 ? wins / (wins + losses) : null;

  return {
    matches,
    summary: {
      n: matches.length,
      wins, losses, breakevens: bes,
      winRate,
      avgSimilarity: matches.length ? matches.reduce((a, m) => a + m.similarity, 0) / matches.length : null,
    },
  };
}

function outcomeOf(t) {
  if (t.exitReason === 'sl') return 'LOSS';
  if (t.exitReason === 'tp1' || t.exitReason === 'tp2' || t.exitReason === 'runner') return 'WIN';
  if (t.isBE || t.exitReason === 'be') return 'BE';
  return 'UNKNOWN';
}

function featureVector({ regime, volatilityBucket, rsi, adx, direction }) {
  if (!regime || !volatilityBucket) return null;
  return buildVec(regime, volatilityBucket, rsi, adx, direction);
}

function featureVectorFromEnrichment(enr, entry) {
  const regime = enr.regime?.regime;
  const volBucket = enr.volatility?.bucket;
  const rsi = enr.regime?.rsi;
  const adxVal = enr.regime?.adx;
  const direction = enr.direction || entry.direction;
  if (!regime || !volBucket) return null;
  return buildVec(regime, volBucket, rsi, adxVal, direction);
}

function buildVec(regime, volBucket, rsi, adxVal, direction) {
  const vec = new Array(FEATURE_DIM).fill(0);
  vec[0] = regime === 'trend_up' ? 1 : 0;
  vec[1] = regime === 'trend_down' ? 1 : 0;
  vec[2] = regime === 'range' ? 1 : 0;
  vec[3] = regime === 'breakout' ? 1 : 0;
  vec[4] = regime === 'reversal' ? 1 : 0;
  vec[5] = volBucket === 'low' ? 1 : 0;
  vec[6] = volBucket === 'normal' ? 1 : 0;
  vec[7] = volBucket === 'elevated' ? 1 : 0;
  vec[8] = volBucket === 'extreme' ? 1 : 0;
  vec[9] = rsi != null ? Math.max(0, Math.min(1, rsi / 100)) : 0.5;
  vec[10] = adxVal != null ? Math.max(0, Math.min(1, adxVal / 100)) : 0.2;
  vec[11] = direction === 'LONG' ? 1 : direction === 'SHORT' ? -1 : 0;
  return vec;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
