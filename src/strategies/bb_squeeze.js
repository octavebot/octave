/**
 * Strategy: Bollinger Squeeze Expansion
 *
 * Volatility mean-reverts: a multi-bar contraction (Bollinger band width at a
 * local minimum = a "squeeze") tends to resolve into an expansion. We take the
 * first decisive 15m close out of the coil, in the H1 trend direction. Distinct
 * from the range-breakout strategies — the entry is gated on a volatility
 * REGIME (low → expanding), not a fixed session range.
 */

import { ema } from '../lib/indicators.js';
import { atr } from '../lib/structure.js';
import { buildTriggered, dayScopedId, qualityConfidence, projectTrade, bollingerSeries, rangeOf } from './_helpers.js';

export const meta = {
  id: 'BB-SQUEEZE',
  name: 'Bollinger Squeeze Expansion',
  concept: 'Breakout from a Bollinger-width squeeze (low-volatility coil), H1-trend-aligned',
  window: 'Any session hour',
  timeframes: ['15', '60'],
  defaultEnabled: true,
};

export const playbook = `# Bollinger Squeeze Expansion

## Concept
When the 15m Bollinger bands contract to a recent-low width, price is coiling —
volatility is about to expand. We take the first wide-body 15m close out of the
coil, in the direction of the H1 50-EMA trend.

## Rules
1. **Squeeze** — current 20-period BB width is the lowest of the last 12 bars.
2. **Trend** — H1 close on the trade side of the 50-EMA.
3. **Trigger** — 15m close beyond the prior 6-bar coil range, body ≥ 55% of bar.

## Entry
- Market at the breakout close.

## Stop loss
- Mid of the coil range (then widened by STOP_PAD).

## Take profit
- TP2 = 1× coil-height measured move; TP1 the mode default. Clamped to the
  active mode's reward band.
`;

const COIL = 6, WIDTH_LOOKBACK = 12;

function squeezeState(tf) {
  if (!tf?.bars || tf.bars.length < WIDTH_LOOKBACK + 21) return null;
  const series = bollingerSeries(tf.bars, WIDTH_LOOKBACK, 20, 2);
  if (series.length < 3) return null;
  const widths = series.map((b) => b.width);
  const curW = widths[widths.length - 1];
  const isSqueeze = curW <= Math.min(...widths);
  const coil = rangeOf(tf.bars.slice(-COIL - 1, -1)); // last COIL closed bars (exclude forming)
  return coil ? { isSqueeze, coil } : null;
}

export function evaluate(ctx) {
  const out = [];
  const tf = ctx.pane('15');
  const tf60 = ctx.pane('60');
  if (!tf?.bars || tf.bars.length < 40) return out;
  if (!tf60?.bars || tf60.bars.length < 55) return out;
  const st = squeezeState(tf);
  if (!st || !st.isSqueeze) return out;

  const last = tf.bars[tf.bars.length - 1];
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  if (range <= 0 || body / range < 0.55) return out;

  const a15 = atr(tf.bars, 14);
  if (!a15) return out;
  const e50 = ema(tf60.bars, 50);
  const e50last = e50[e50.length - 1];
  const h1 = tf60.bars[tf60.bars.length - 1];
  if (e50last == null) return out;
  const trendUp = h1.close > e50last, trendDown = h1.close < e50last;
  const { high: cHi, low: cLo, mid: cMid } = st.coil;
  const height = cHi - cLo;
  const margin = 0.1 * a15;

  if (trendUp && last.close > cHi + margin) {
    const entry = last.close, stop = cMid, risk = entry - stop;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'LONG', 'sqz'),
      direction: 'LONG', timeframe: '15',
      confidence: qualityConfidence(meta.id, [
        (body / range - 0.55) / 0.45,
        (last.close - cHi) / a15,
        Math.abs(h1.close - e50last) / (a15 * 2),
      ]),
      setupName: 'Bollinger squeeze breakout (long)',
      summary: `Coil $${cLo.toFixed(2)}–$${cHi.toFixed(2)} · expansion up`,
      entry, stop, t2: cHi + height,
    }));
  } else if (trendDown && last.close < cLo - margin) {
    const entry = last.close, stop = cMid, risk = stop - entry;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'SHORT', 'sqz'),
      direction: 'SHORT', timeframe: '15',
      confidence: qualityConfidence(meta.id, [
        (body / range - 0.55) / 0.45,
        (cLo - last.close) / a15,
        Math.abs(h1.close - e50last) / (a15 * 2),
      ]),
      setupName: 'Bollinger squeeze breakout (short)',
      summary: `Coil $${cLo.toFixed(2)}–$${cHi.toFixed(2)} · expansion down`,
      entry, stop, t2: cLo - height,
    }));
  }
  for (const r of out) r.confirmations = ['BB squeeze (low width)', 'Break beyond coil', 'H1 trend aligned', 'Wide-body bar'];
  return out;
}

export function precheck(ctx) {
  const tf = ctx.pane('15');
  const tf60 = ctx.pane('60');
  if (!tf?.bars || tf.bars.length < 40) return null;
  const st = squeezeState(tf);
  const last = tf.bars[tf.bars.length - 1];
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low || 1;
  const a15 = atr(tf.bars, 14);
  let trendUp = false, trendDown = false;
  if (tf60?.bars && tf60.bars.length >= 55) {
    const e50 = ema(tf60.bars, 50); const e = e50[e50.length - 1];
    if (e != null) { const c = tf60.bars[tf60.bars.length - 1].close; trendUp = c > e; trendDown = c < e; }
  }
  let direction = null, projection = null;
  if (st?.coil) {
    const { high: cHi, low: cLo, mid: cMid } = st.coil; const height = cHi - cLo; const margin = 0.1 * (a15 || 1);
    const up = trendUp && last.close > cHi + margin, dn = trendDown && last.close < cLo - margin;
    direction = up ? 'LONG' : dn ? 'SHORT' : (trendUp ? 'LONG' : trendDown ? 'SHORT' : null);
    if (direction === 'LONG') projection = projectTrade({ direction, entry: last.close, stop: cMid, t2: cHi + height });
    else if (direction === 'SHORT') projection = projectTrade({ direction, entry: last.close, stop: cMid, t2: cLo - height });
  }
  return {
    direction, projection,
    conditions: [
      { kind: 'gate', label: 'BB squeeze (width at 12-bar low)', met: !!st?.isSqueeze, value: st ? (st.isSqueeze ? 'coiled' : 'not squeezed') : 'warming up' },
      { kind: 'gate', label: 'H1 trend aligned', met: trendUp || trendDown, value: trendUp ? 'up' : trendDown ? 'down' : 'flat' },
      { kind: 'trigger', label: 'Wide-body break of coil', met: !!projection, value: st?.coil ? `coil ${st.coil.low.toFixed(2)}–${st.coil.high.toFixed(2)} · body ${Math.round(body / range * 100)}%` : '—' },
    ],
  };
}
