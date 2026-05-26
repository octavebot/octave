/**
 * Sentiment — deterministic only (the LLM narrative flavour was removed with
 * the AI layer).
 *
 *   sentimentSnapshot(ctx)
 *     Combines structural signals into a score in [-1, +1]:
 *       - News blackout proximity (negative if event within 60min)
 *       - Recent triggered direction balance from journal (longs - shorts)
 *       - Price vs daily VWAP (above = +, below = -)
 *       - RSI extreme tilt (>70 = -, <30 = +)
 *       - HTF trend bias (from regime classifier on daily/4H if available)
 *     Cheap, runs in the auto-journal path. No LLM calls.
 *
 * Returns:
 *   { score: number, label: 'bearish'|'neutral'|'bullish', factors: string[] }
 */

import { checkBlackout, nextEvent, upcomingEvents } from './news.js';
import { rsiLast, vwap } from './indicators.js';
import { recentTrades } from './trade_journal.js';
import { classifyRegime } from './regime.js';

const RECENT_TRIGGER_WINDOW_HRS = 4;

export function sentimentSnapshot(ctx) {
  const factors = [];
  let score = 0;

  // 1) News blackout — within 60 min of high-impact event drags toward neutral/negative
  const black = checkBlackout(Date.now() / 1000, 60);
  if (black.blocked) {
    const penalty = Math.max(0.1, 0.3 * (1 - (black.minutesAway || 0) / 60));
    score -= penalty;
    factors.push(`news risk -${penalty.toFixed(2)} (${black.event?.title || 'event'} ${black.minutesAway}m)`);
  } else {
    const nxt = nextEvent(Date.now() / 1000);
    if (nxt && nxt.minutesAway != null && nxt.minutesAway < 180) {
      score -= 0.05;
      factors.push(`news soon -0.05 (${nxt.title || 'event'} in ${nxt.minutesAway}m)`);
    }
  }

  // 2) Recent triggered direction balance — last 4h, this instrument
  const cutoff = Date.now() - RECENT_TRIGGER_WINDOW_HRS * 3600_000;
  const recents = recentTrades(50).filter((t) =>
    (t.entryTs || 0) >= cutoff && (!ctx?.instrument || t.instrument === ctx.instrument));
  let longs = 0, shorts = 0;
  for (const t of recents) {
    // direction may not be on the trade; infer from enrichment if present (skip otherwise)
    if (t.direction === 'LONG') longs++;
    else if (t.direction === 'SHORT') shorts++;
  }
  if (longs + shorts > 0) {
    const tilt = (longs - shorts) / (longs + shorts);
    score += tilt * 0.3;
    factors.push(`recent ${longs}L/${shorts}S → ${(tilt * 0.3).toFixed(2)}`);
  }

  // 3) Price vs daily VWAP (uses 15m bars; vwap helper expects a session start)
  const pane15 = ctx?.pane?.('15');
  if (pane15?.bars?.length) {
    // anchor VWAP at start of today's NY session (~13:00 UTC, but bars carry their own time)
    const last = pane15.bars[pane15.bars.length - 1];
    const dayStart = Math.floor(last.time / 86400) * 86400;
    const v = vwap(pane15.bars, dayStart);
    if (v != null && Number.isFinite(v)) {
      const above = last.close > v;
      const dist = Math.abs(last.close - v) / last.close;
      const contrib = above ? Math.min(0.2, dist * 50) : -Math.min(0.2, dist * 50);
      score += contrib;
      factors.push(`${above ? '↑' : '↓'} VWAP ${contrib >= 0 ? '+' : ''}${contrib.toFixed(2)}`);
    }
  }

  // 4) RSI extremes — mean-reversion bias against the prevailing extreme
  if (pane15?.bars?.length) {
    const r = rsiLast(pane15.bars, 14);
    if (r != null) {
      if (r > 70) { score -= 0.15; factors.push(`RSI ${r.toFixed(0)} OB -0.15`); }
      else if (r < 30) { score += 0.15; factors.push(`RSI ${r.toFixed(0)} OS +0.15`); }
    }
  }

  // 5) HTF regime bias — daily or 4H trend
  const htfRegime = classifyRegime(ctx, '240') || classifyRegime(ctx, '1D');
  if (htfRegime?.regime === 'trend_up') { score += 0.2; factors.push('HTF trend_up +0.20'); }
  else if (htfRegime?.regime === 'trend_down') { score -= 0.2; factors.push('HTF trend_down -0.20'); }

  // Clamp
  score = Math.max(-1, Math.min(1, score));
  const label = score < -0.25 ? 'bearish' : score > 0.25 ? 'bullish' : 'neutral';
  return { score, label, factors };
}

// sentimentDeep (LLM narrative) was removed with the AI layer — only the
// deterministic sentimentSnapshot above remains (used by trade_enrichment).
