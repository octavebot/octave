/**
 * Strategy: Asian Range Breakout
 *
 * Most days the Asian session range gets broken decisively during London/NY.
 * Trade the first 15m close that breaks the range with a wide-body bar.
 */

import { ema } from '../lib/indicators.js';
import { atr } from '../lib/structure.js';
import { nyParts } from '../lib/time.js';
import { buildTriggered, dayScopedId, qualityConfidence, projectTrade } from './_helpers.js';

export const meta = {
  id: 'ASIAN-BREAKOUT',
  name: 'Asian Range Breakout',
  concept: 'First 15m close beyond Asian session range with strong body',
  window: 'London + NY · 02:00-10:00 ET (skips 02 & 05)',
  timeframes: ['15'],
  defaultEnabled: true,
};

export const playbook = `# Asian Range Breakout

## Concept
Asian range (20:00 prior NY → 02:00 NY) caps where the night algos sat. London/NY traders take it out cleanly when intent is real. We trade the first 15m close beyond the range with a body > 60% of the bar.

## Rules
1. **Time** — After 02:00 NY, before 10:00 NY (the breakout window).
2. **Range** — Asian session bars define hi/lo.
3. **Trigger** — Closing 15m bar's close > Asian hi (LONG) or < Asian lo (SHORT) AND |body|/range > 0.6.

## Entry
- Market at trigger close.

## Stop loss
- Mid of Asian range.

## Take profit
- TP1: 1.1 x risk  ·  TP2: 1.5 x risk  ·  SL: 1.0 x risk
`;

export function evaluate(ctx) {
  const out = [];
  const tf = ctx.pane('15');
  if (!tf?.bars || tf.bars.length < 40) return out;
  const np = nyParts(ctx.barTime);
  // Breakout window 02:00–10:00 ET, minus the 02:00 & 05:00 hours — a 1-year
  // Databento train/test split (2026-05) showed those two hours are the only
  // money-losers in the window (h2 n=117 ~flat, h5 n=54 −0.13R); dropping them
  // lifted BOTH halves (TRAIN +2.8pp/+2.5R, TEST +3.8pp/+7.4R).
  if (np.h <= 2 || np.h === 5 || np.h >= 10) return out;

  // Asian range = prior day 20:00 NY → today 02:00 NY
  const asianBars = tf.bars.filter((b) => {
    const p = nyParts(b.time);
    if (p.dateKey === ctx.dateKey && p.h < 2) return true;
    const dayMs = 24 * 3600 * 1000;
    if (ctx.barTime * 1000 - b.time * 1000 < dayMs && p.h >= 20) return true;
    return false;
  });
  if (asianBars.length < 5) return out;
  const asianHi = Math.max(...asianBars.map((b) => b.high));
  const asianLo = Math.min(...asianBars.map((b) => b.low));
  const asianMid = (asianHi + asianLo) / 2;
  const asianRange = asianHi - asianLo;

  const last = tf.bars[tf.bars.length - 1];
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  if (range <= 0) return out;
  // Gold fakes range breakouts more than the indices — demand a more
  // decisive (fuller-bodied) breakout candle there.
  if (body / range < (ctx.instrument === 'gold' ? 0.78 : 0.62)) return out;

  // H1 trend filter — only take breakouts aligned with the H1 50-EMA, and
  // require a real close beyond the range edge (not a marginal poke).
  const tf60 = ctx.pane('60');
  const a15 = atr(tf.bars, 14);
  if (!tf60?.bars || tf60.bars.length < 55 || !a15) return out;
  const e50 = ema(tf60.bars, 50);
  const e50last = e50[e50.length - 1];
  const h1 = tf60.bars[tf60.bars.length - 1];
  if (e50last == null) return out;
  const trendUp = h1.close > e50last;
  const trendDown = h1.close < e50last;
  const margin = 0.12 * a15;

  if (trendUp && last.close > asianHi + margin) {
    const entry = last.close, stop = asianMid, risk = entry - stop;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'LONG', 'asian-bo'),
      direction: 'LONG', timeframe: '15',
      confidence: qualityConfidence(meta.id, [
        (body / range - 0.62) / 0.38,                   // breakout bar body
        (last.close - asianHi - margin) / a15,          // close beyond range
        Math.abs(h1.close - e50last) / (a15 * 2),       // H1 trend strength
      ]),
      setupName: 'Asian range bullish breakout',
      summary: `Asian range $${asianRange.toFixed(2)} · close above $${asianHi.toFixed(2)}`,
      entry, stop, t1: entry + 1.2 * asianRange, t2: entry + 1.8 * asianRange,
    }));
  } else if (trendDown && last.close < asianLo - margin) {
    const entry = last.close, stop = asianMid, risk = stop - entry;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'SHORT', 'asian-bo'),
      direction: 'SHORT', timeframe: '15',
      confidence: qualityConfidence(meta.id, [
        (body / range - 0.62) / 0.38,                   // breakout bar body
        (asianLo - margin - last.close) / a15,          // close beyond range
        Math.abs(h1.close - e50last) / (a15 * 2),       // H1 trend strength
      ]),
      setupName: 'Asian range bearish breakout',
      summary: `Asian range $${asianRange.toFixed(2)} · close below $${asianLo.toFixed(2)}`,
      entry, stop,
    }));
  }
  for (const r of out) r.confirmations = ['Asian range defined', 'Close beyond range', 'Body > 60% bar'];
  return out;
}

export function precheck(ctx) {
  const tf = ctx.pane('15');
  const tf60 = ctx.pane('60');
  if (!tf?.bars || tf.bars.length < 40) return null;
  const np = nyParts(ctx.barTime);
  const inWindow = np.h >= 2 && np.h < 10 && np.h !== 2 && np.h !== 5;

  const asianBars = tf.bars.filter((b) => {
    const p = nyParts(b.time);
    if (p.dateKey === ctx.dateKey && p.h < 2) return true;
    const dayMs = 24 * 3600 * 1000;
    if (ctx.barTime * 1000 - b.time * 1000 < dayMs && p.h >= 20) return true;
    return false;
  });
  const haveAsian = asianBars.length >= 5;
  const asianHi = haveAsian ? Math.max(...asianBars.map((b) => b.high)) : null;
  const asianLo = haveAsian ? Math.min(...asianBars.map((b) => b.low)) : null;

  const last = tf.bars[tf.bars.length - 1];
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low || 1;
  const bodyMin = ctx.instrument === 'gold' ? 0.78 : 0.62;
  const bodyOk = body / range >= bodyMin;

  const a15 = atr(tf.bars, 14);
  let trendUp = false, trendDown = false;
  if (tf60?.bars && tf60.bars.length >= 55) {
    const e50 = ema(tf60.bars, 50);
    const e50last = e50[e50.length - 1];
    const h1 = tf60.bars[tf60.bars.length - 1];
    if (e50last != null) { trendUp = h1.close > e50last; trendDown = h1.close < e50last; }
  }
  const margin = 0.12 * (a15 || 1);
  const brokeUp = haveAsian && trendUp && last.close > asianHi + margin;
  const brokeDown = haveAsian && trendDown && last.close < asianLo - margin;
  const direction = brokeUp ? 'LONG' : brokeDown ? 'SHORT' : (trendUp ? 'LONG' : trendDown ? 'SHORT' : null);

  let h1Close = null, h1Ema50 = null;
  if (tf60?.bars && tf60.bars.length >= 55) {
    const e50 = ema(tf60.bars, 50);
    h1Ema50 = e50[e50.length - 1];
    h1Close = tf60.bars[tf60.bars.length - 1].close;
  }
  // Project the would-be trade (entry at current close, stop at Asian mid).
  let projection = null;
  if (haveAsian && direction) {
    const asianMidLocal = (asianHi + asianLo) / 2;
    projection = projectTrade({ direction, entry: last.close, stop: asianMidLocal });
  }
  return {
    direction,
    projection,
    conditions: [
      { kind: 'gate',    label: 'Breakout window (02:00–10:00 ET, skips 02 & 05)', met: inWindow, value: `${np.h}:${String(np.m||0).padStart(2,'0')} ET` },
      { kind: 'gate',    label: 'Asian range defined',              met: haveAsian, value: haveAsian ? `hi ${asianHi.toFixed(2)} / lo ${asianLo.toFixed(2)} · ${asianBars.length} bars` : `only ${asianBars.length} bars (need 5)` },
      { kind: 'gate',    label: 'H1 trend aligned',                 met: trendUp || trendDown, value: h1Close != null && h1Ema50 != null ? `H1 ${h1Close.toFixed(2)} ${trendUp ? '>' : trendDown ? '<' : '≈'} EMA50 ${h1Ema50.toFixed(2)}` : 'no H1 data' },
      { kind: 'trigger', label: 'Wide-body breakout bar',           met: bodyOk, value: `body ${body.toFixed(2)} / range ${range.toFixed(2)} = ${Math.round(body/range*100)}% (min ${Math.round(bodyMin*100)}%)` },
      { kind: 'trigger', label: 'Close beyond range',               met: brokeUp || brokeDown, value: brokeUp ? `close ${last.close.toFixed(2)} > hi ${asianHi.toFixed(2)} by ${(last.close - asianHi).toFixed(2)}` : brokeDown ? `close ${last.close.toFixed(2)} < lo ${asianLo.toFixed(2)} by ${(asianLo - last.close).toFixed(2)}` : haveAsian ? `close ${last.close.toFixed(2)} inside ${asianLo.toFixed(2)}–${asianHi.toFixed(2)}` : `close ${last.close.toFixed(2)}` },
    ],
  };
}
