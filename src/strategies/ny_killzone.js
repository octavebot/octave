/**
 * Strategy: NY Killzone FVG Entry
 *
 * NY open (07:00-10:00 NY) frequently delivers an impulse move that leaves
 * a fair value gap. Trade the retracement into the gap.
 */

import { findFVGs, atr } from '../lib/structure.js';
import { ema } from '../lib/indicators.js';
import { nyParts } from '../lib/time.js';
import { buildTriggered, dayScopedId, qualityConfidence, projectTrade } from './_helpers.js';

export const meta = {
  id: 'NY-FVG',
  name: 'NY Killzone · FVG Retracement',
  concept: 'Impulse + 3-candle FVG during NY killzone, enter on retrace',
  window: 'NY killzone · 07:00-10:00 ET · skips LONG at 09:00',
  timeframes: ['15'],
  defaultEnabled: true,
};

export const playbook = `# NY Killzone · FVG Retracement

## Concept
First hour of NY (07:00-10:00 NY) often delivers a clean impulse that leaves an unfilled 3-candle FVG. Price tends to revisit that gap before continuing — we enter on the retrace into the gap midpoint.

## Rules
1. **Session** — NY killzone (07:00-10:00 NY). LONG signals at 09:00 ET are
   muted: 365d Databento split showed LONG×09 bled 8R on both halves
   (train 30% win, test 43% win — both losing). SHORT×09 stays active.
2. **FVG** — Newest bullish/bearish FVG formed in the last 8 bars on 15m.
3. **Retrace** — Latest bar pulled into the FVG zone (low or high inside the gap).

## Entry
- Limit at FVG midpoint.

## Stop loss
- 0.5 × ATR beyond the gap's far edge.

## Take profit
- TP1: 1.1 x risk  ·  TP2: 1.5 x risk  ·  SL: 1.0 x risk
`;

export function evaluate(ctx) {
  const out = [];
  const tf = ctx.pane('15');
  if (!tf?.bars || tf.bars.length < 30) return out;
  const np = nyParts(ctx.barTime);
  if (np.h < 7 || np.h >= 10) return out;
  const gaps = findFVGs(tf.bars, 50);
  if (!gaps?.length) return out;
  // Newest gap within last 8 bars
  const recent = gaps.filter((g) => g.idx >= tf.bars.length - 9);
  if (recent.length === 0) return out;
  const gap = recent[recent.length - 1];
  const last = tf.bars[tf.bars.length - 1];
  const a = atr(tf.bars, 14);
  if (!a) return out;

  // Skip noise-sized gaps — a tradable FVG needs real displacement behind it.
  // Gold whipsaws through fair-value gaps far more than the indices, so on
  // gold we demand a much larger displacement gap to filter out the chop.
  const gapSize = gap.top - gap.bottom;
  const minGap = (ctx.instrument === 'gold' ? 0.6 : 0.25) * a;
  if (gapSize < minGap) return out;

  // H1 trend filter — trade the FVG retrace only with a genuinely trending
  // H1: price beyond the 50-EMA AND the 50-EMA itself sloping that way.
  const tf60 = ctx.pane('60');
  if (!tf60?.bars || tf60.bars.length < 55) return out;
  const e50arr = ema(tf60.bars, 50);
  const e50last = e50arr[e50arr.length - 1];
  const e50prev = e50arr[e50arr.length - 4];
  const h1 = tf60.bars[tf60.bars.length - 1];
  if (e50last == null || e50prev == null) return out;
  const trendUp = h1.close > e50last && e50last >= e50prev;
  const trendDown = h1.close < e50last && e50last <= e50prev;

  // LONG×09:00-ET filter — 365d Databento train/test showed this single
  // sub-bucket bleeds: 61 trades, 36% win, −8.4R (TRAIN 30%/−8.0R,
  // TEST 43%/−0.4R, both halves losing). Skipping h09 entirely was
  // rejected (the SHORT half flips healthy in test), but LONG×h09
  // specifically is bad on both halves → structural, not overfit.
  // After filter: TRAIN +2.4pp/+8.0R · TEST +10.4pp/+0.4R.
  const skipLongH09 = np.h === 9;

  // bullish FVG: price moves up, leaves gap; retrace = price comes back down to it
  if (trendUp && !skipLongH09 && gap.side === 'bullish' && last.low <= gap.top && last.low >= gap.bottom) {
    const entry = (gap.top + gap.bottom) / 2;
    const stop  = gap.bottom - 0.5 * a;
    const risk  = entry - stop;
    const sessHi = Math.max(...tf.bars.slice(-20).map((b) => b.high));
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'LONG', `fvg-${gap.time}`),
      direction: 'LONG', timeframe: '15',
      confidence: qualityConfidence(meta.id, [
        gapSize / a,                                        // gap displacement
        Math.abs(h1.close - e50last) / (e50last * 0.004),   // H1 trend strength
        1 - Math.abs(last.low - entry) / (gapSize / 2 || 1), // retrace centring
      ]),
      setupName: 'NY killzone FVG retrace',
      summary: `Bullish FVG ${gap.bottom.toFixed(2)}–${gap.top.toFixed(2)} retraced into`,
      entry, stop, t1: entry + 1.2 * risk, t2: sessHi,
    }));
  } else if (trendDown && gap.side === 'bearish' && last.high >= gap.bottom && last.high <= gap.top) {
    const entry = (gap.top + gap.bottom) / 2;
    const stop  = gap.top + 0.5 * a;
    const risk  = stop - entry;
    const sessLo = Math.min(...tf.bars.slice(-20).map((b) => b.low));
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'SHORT', `fvg-${gap.time}`),
      direction: 'SHORT', timeframe: '15',
      confidence: qualityConfidence(meta.id, [
        gapSize / a,                                         // gap displacement
        Math.abs(h1.close - e50last) / (e50last * 0.004),    // H1 trend strength
        1 - Math.abs(last.high - entry) / (gapSize / 2 || 1), // retrace centring
      ]),
      setupName: 'NY killzone FVG retrace',
      summary: `Bearish FVG ${gap.bottom.toFixed(2)}–${gap.top.toFixed(2)} retraced into`,
      entry, stop, t1: entry - 1.2 * risk, t2: sessLo,
    }));
  }
  for (const r of out) r.confirmations = ['NY killzone window', '3-candle FVG', 'Retracement into gap'];
  return out;
}

export function precheck(ctx) {
  const tf = ctx.pane('15');
  const tf60 = ctx.pane('60');
  if (!tf?.bars || tf.bars.length < 30) return null;
  const np = nyParts(ctx.barTime);
  // Window shown as met when EITHER the wall clock OR the last-closed bar is in
  // the killzone — fixes the ≤15-min session-start lag (see london_killzone.js
  // precheck comment). UNLIKE london/asian, NY-FVG's retrace trigger CAN fire
  // on a pre-session closed bar, so we must guard the trigger on inWindowBar
  // (the barTime window evaluate() actually uses) — otherwise a retrace on the
  // 06:45 bar at 07:05 wall would show READY while evaluate() refuses (false
  // READY, the bug fixed in the pass-10 audit). Live-only; evaluate unchanged.
  const nowNp = nyParts((ctx.ts || Date.now()) / 1000);
  const inWindowBar = np.h >= 7 && np.h < 10;
  const inWindowNow = nowNp.h >= 7 && nowNp.h < 10;
  const inWindow = inWindowNow || inWindowBar;

  const gaps = findFVGs(tf.bars, 50) || [];
  const recent = gaps.filter((g) => g.idx >= tf.bars.length - 9);
  const gap = recent.length ? recent[recent.length - 1] : null;
  const last = tf.bars[tf.bars.length - 1];
  const a = atr(tf.bars, 14);

  const minGap = (ctx.instrument === 'gold' ? 0.6 : 0.25) * (a || 1);
  const gapSize = gap ? gap.top - gap.bottom : 0;
  const gapSizeOk = gap && gapSize >= minGap;

  let trendUp = false, trendDown = false;
  if (tf60?.bars && tf60.bars.length >= 55) {
    const e50arr = ema(tf60.bars, 50);
    const e50last = e50arr[e50arr.length - 1];
    const e50prev = e50arr[e50arr.length - 4];
    const h1 = tf60.bars[tf60.bars.length - 1];
    if (e50last != null && e50prev != null) {
      trendUp = h1.close > e50last && e50last >= e50prev;
      trendDown = h1.close < e50last && e50last <= e50prev;
    }
  }
  let direction = trendUp ? 'LONG' : trendDown ? 'SHORT' : null;
  // See evaluate(): LONG×h09 is muted (train+test both negative).
  const longH09Skip = direction === 'LONG' && np.h === 9;
  if (longH09Skip) direction = null;

  // Couple gap-side to direction so precheck matches evaluate exactly: the
  // LONG branch in evaluate only fires on a bullish FVG, SHORT only on a
  // bearish FVG. Without this coupling, trendUp + bearish FVG would read
  // READY in /setup ("retrace into gap" met because the bearish path's
  // condition was checked unconditionally) while evaluate's LONG branch
  // refused to fire — the user's "ready but never gave signal" report.
  // `inWindowBar` guard: the retrace trigger may only show as met when the
  // last CLOSED bar is itself in the killzone — i.e. exactly when evaluate()
  // would act. This prevents a pre-session bar (e.g. 06:45 at 07:05 wall) from
  // showing the trigger as READY when evaluate() would early-return.
  const inRetrace = inWindowBar && gap && (
    (direction === 'LONG'  && gap.side === 'bullish' && last.low  <= gap.top    && last.low  >= gap.bottom) ||
    (direction === 'SHORT' && gap.side === 'bearish' && last.high >= gap.bottom && last.high <= gap.top)
  );

  let h1Close = null, h1Ema50 = null;
  if (tf60?.bars && tf60.bars.length >= 55) {
    const e50arr = ema(tf60.bars, 50);
    h1Ema50 = e50arr[e50arr.length - 1];
    h1Close = tf60.bars[tf60.bars.length - 1].close;
  }
  // Project the would-be trade.
  let projection = null;
  if (gap && a && direction) {
    const entry = (gap.top + gap.bottom) / 2;
    const stop = direction === 'LONG' ? gap.bottom - 0.5 * a : gap.top + 0.5 * a;
    projection = projectTrade({ strategy: meta.id, direction, entry, stop });
  }
  return {
    direction,
    projection,
    conditions: [
      { kind: 'gate',    label: 'NY killzone (07:00–10:00 ET, skips LONG at 09:00)', met: inWindow && !longH09Skip, value: `${nowNp.h}:${String(nowNp.min||0).padStart(2,'0')} ET${longH09Skip ? ' (LONG×09 muted)' : ''}` },
      { kind: 'gate',    label: 'H1 trend (vs 50-EMA, w/ slope)',met: !!direction, value: h1Close != null && h1Ema50 != null ? `H1 ${h1Close.toFixed(2)} ${trendUp ? '>' : trendDown ? '<' : '≈'} EMA50 ${h1Ema50.toFixed(2)}` : 'no H1 data' },
      { kind: 'gate',    label: 'Tradable FVG present',         met: gapSizeOk, value: gap ? `${gap.bottom.toFixed(2)}–${gap.top.toFixed(2)} (${gap.side}, size ${(gap.top - gap.bottom).toFixed(2)} / min ${minGap.toFixed(2)})` : 'no recent FVG' },
      { kind: 'trigger', label: 'Retrace into gap',             met: !!inRetrace, value: gap ? `last ${last.low.toFixed(2)}–${last.high.toFixed(2)} vs gap ${gap.bottom.toFixed(2)}–${gap.top.toFixed(2)}` : 'no gap to retrace' },
    ],
  };
}
