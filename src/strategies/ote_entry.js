/**
 * Strategy: OTE Pullback (ICT Optimal Trade Entry)
 *
 * In an H1 trend, after a fresh impulse leg, price retraces into the 0.62–0.79
 * "optimal trade entry" zone before continuing. Deep retracement = excellent
 * reward:risk. We enter on a rejection inside the OTE zone, stop beyond the leg
 * origin, target the leg high/low (and beyond via the mode profile).
 */

import { ema } from '../lib/indicators.js';
import { atr, findSwings, oteZone } from '../lib/structure.js';
import { buildTriggered, dayScopedId, qualityConfidence, projectTrade } from './_helpers.js';

export const meta = {
  id: 'OTE-PULLBACK',
  name: 'OTE Pullback',
  concept: 'Retracement into the 0.62–0.79 OTE zone of the last impulse leg, in H1 trend',
  window: 'Any session hour',
  timeframes: ['15', '60'],
  defaultEnabled: true,
};

export const playbook = `# OTE Pullback (ICT)

## Concept
After an impulse leg, institutional re-entries cluster in the 62–79% retracement
("optimal trade entry"). A rejection there in the direction of the H1 trend is a
deep, high-RR continuation entry.

## Rules
1. **H1 trend** — close on the trade side of the 50-EMA.
2. **Impulse leg** — most recent 15m swing low→high (long) / high→low (short).
3. **OTE** — current bar trades into the 0.62–0.79 retracement of that leg.
4. **Rejection** — bar closes back in trend direction.

## Entry
- Market at the rejection close inside the OTE zone.

## Stop loss
- Beyond the leg origin (0.2×ATR pad), then widened by STOP_PAD.

## Take profit
- Mode default R profile (deep entry → favourable RR).
`;

export function evaluate(ctx) {
  const out = [];
  const tf = ctx.pane('15');
  const tf60 = ctx.pane('60');
  if (!tf?.bars || tf.bars.length < 60) return out;
  if (!tf60?.bars || tf60.bars.length < 55) return out;
  const a = atr(tf.bars, 14);
  if (!a) return out;
  const e50 = ema(tf60.bars, 50);
  const e50last = e50[e50.length - 1];
  const h1 = tf60.bars[tf60.bars.length - 1];
  if (e50last == null) return out;
  const trendUp = h1.close > e50last, trendDown = h1.close < e50last;
  if (!trendUp && !trendDown) return out;

  const { highs, lows } = findSwings(tf.bars, 3);
  const last = tf.bars[tf.bars.length - 1];

  if (trendUp && highs.length && lows.length) {
    const swH = highs[highs.length - 1];
    // leg low = most recent swing low BEFORE that swing high
    const swL = [...lows].reverse().find((l) => l.idx < swH.idx);
    if (swL && swH.price - swL.price > 1.5 * a && (tf.bars.length - 1 - swH.idx) <= 12) {
      const z = oteZone(swL.price, swH.price, 'bullish'); // {shallow:0.62, sweet, deep:0.79}
      const inZone = last.low <= z.shallow && last.low >= z.deep - 0.2 * a;
      const reject = last.close > last.open && last.close > z.deep;
      if (inZone && reject) {
        const entry = last.close, stop = swL.price - 0.2 * a, risk = entry - stop;
        if (risk > 0) out.push(buildTriggered({
          strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'LONG', 'ote'),
          direction: 'LONG', timeframe: '15',
          confidence: qualityConfidence(meta.id, [
            (z.shallow - last.low) / (z.shallow - z.deep || 1),
            Math.abs(h1.close - e50last) / (a * 2),
            (last.close - last.open) / (last.high - last.low || 1),
          ]),
          setupName: 'Bullish OTE pullback',
          summary: `OTE ${z.deep.toFixed(2)}–${z.shallow.toFixed(2)} of leg`,
          entry, stop,
        }));
      }
    }
  } else if (trendDown && highs.length && lows.length) {
    const swL = lows[lows.length - 1];
    const swH = [...highs].reverse().find((h) => h.idx < swL.idx);
    if (swH && swH.price - swL.price > 1.5 * a && (tf.bars.length - 1 - swL.idx) <= 12) {
      const z = oteZone(swL.price, swH.price, 'bearish');
      const inZone = last.high >= z.shallow && last.high <= z.deep + 0.2 * a;
      const reject = last.close < last.open && last.close < z.deep;
      if (inZone && reject) {
        const entry = last.close, stop = swH.price + 0.2 * a, risk = stop - entry;
        if (risk > 0) out.push(buildTriggered({
          strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'SHORT', 'ote'),
          direction: 'SHORT', timeframe: '15',
          confidence: qualityConfidence(meta.id, [
            (last.high - z.shallow) / (z.deep - z.shallow || 1),
            Math.abs(h1.close - e50last) / (a * 2),
            (last.open - last.close) / (last.high - last.low || 1),
          ]),
          setupName: 'Bearish OTE pullback',
          summary: `OTE ${z.shallow.toFixed(2)}–${z.deep.toFixed(2)} of leg`,
          entry, stop,
        }));
      }
    }
  }
  for (const r of out) r.confirmations = ['H1 trend', 'OTE 62–79% retrace', 'Rejection in trend'];
  return out;
}

// Live diagnostics for /setups — mirrors evaluate() so the forming OTE setup
// shows with the same would-be entry/stop/TP it will fire with.
export function precheck(ctx) {
  const tf = ctx.pane('15');
  const tf60 = ctx.pane('60');
  if (!tf?.bars || tf.bars.length < 60 || !tf60?.bars || tf60.bars.length < 55) return null;
  const a = atr(tf.bars, 14);
  if (!a) return null;
  const e50arr = ema(tf60.bars, 50);
  const e50 = e50arr[e50arr.length - 1];
  const h1 = tf60.bars[tf60.bars.length - 1];
  const trendUp = e50 != null && h1.close > e50;
  const trendDown = e50 != null && h1.close < e50;
  const { highs, lows } = findSwings(tf.bars, 3);
  const last = tf.bars[tf.bars.length - 1];

  let direction = null, legOk = false, inZone = false, rej = false, projection = null, z = null;
  if (trendUp && highs.length && lows.length) {
    direction = 'LONG';
    const swH = highs[highs.length - 1];
    const swL = [...lows].reverse().find((l) => l.idx < swH.idx);
    if (swL) {
      legOk = (swH.price - swL.price > 1.5 * a) && (tf.bars.length - 1 - swH.idx) <= 12;
      z = oteZone(swL.price, swH.price, 'bullish');
      inZone = last.low <= z.shallow && last.low >= z.deep - 0.2 * a;
      rej = last.close > last.open && last.close > z.deep;
      if (legOk) projection = projectTrade({ direction, entry: last.close, stop: swL.price - 0.2 * a });
    }
  } else if (trendDown && highs.length && lows.length) {
    direction = 'SHORT';
    const swL = lows[lows.length - 1];
    const swH = [...highs].reverse().find((hh) => hh.idx < swL.idx);
    if (swH) {
      legOk = (swH.price - swL.price > 1.5 * a) && (tf.bars.length - 1 - swL.idx) <= 12;
      z = oteZone(swL.price, swH.price, 'bearish');
      inZone = last.high >= z.shallow && last.high <= z.deep + 0.2 * a;
      rej = last.close < last.open && last.close < z.deep;
      if (legOk) projection = projectTrade({ direction, entry: last.close, stop: swH.price + 0.2 * a });
    }
  }
  return {
    direction, projection,
    conditions: [
      { kind: 'gate', label: 'H1 50-EMA trend', met: trendUp || trendDown, value: e50 != null ? `H1 ${h1.close.toFixed(2)} ${trendUp ? '>' : trendDown ? '<' : '≈'} EMA50 ${e50.toFixed(2)}` : 'no H1 data' },
      { kind: 'gate', label: 'Fresh impulse leg (≥1.5×ATR, ≤12 bars)', met: legOk, value: z ? `OTE ${Math.min(z.shallow, z.deep).toFixed(2)}–${Math.max(z.shallow, z.deep).toFixed(2)}` : 'no qualifying leg' },
      { kind: 'trigger', label: 'Price in OTE 62–79% zone', met: inZone, value: z ? `last ${last.low.toFixed(2)}–${last.high.toFixed(2)}` : '—' },
      { kind: 'trigger', label: 'Rejection in trend direction', met: rej, value: rej ? 'confirmed' : 'not yet' },
    ],
  };
}
