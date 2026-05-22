/**
 * Strategy: VWAP Rejection
 *
 * Intraday institutional reference. Price testing VWAP from above and rejecting
 * = continuation of the day's uptrend. Mirror for downtrend.
 */

import { vwap } from '../lib/indicators.js';
import { atr } from '../lib/structure.js';
import { nyDayStartUnix } from '../lib/time.js';
import { buildTriggered, dayScopedId } from './_helpers.js';

export const meta = {
  id: 'VWAP-REJ',
  name: 'VWAP Rejection · Intraday',
  concept: 'Rejection at daily VWAP confirms the day\'s direction',
  timeframes: ['5', '15'],
  defaultEnabled: true,
};

export const playbook = `# VWAP Rejection · Intraday Continuation

## Concept
VWAP is the volume-weighted "fair price" of the day. Institutions defend it. When price pulls back to VWAP from the trending side and rejects (wick into VWAP, body away), that's continuation. Skip this if price is sitting ON VWAP — no edge.

## Rules
1. **Day direction** — Last 6 closed 15m bars: open > close on session start vs current close defines bias.
2. **Touch** — Bar's wick crosses VWAP, body closes on the trending side.
3. **Distance** — Close > 0.5 × ATR away from VWAP (not lingering on it).

## Entry
- Limit at VWAP + 0.25 × ATR (or - for shorts).

## Stop loss
- 1.0 × ATR beyond VWAP on the opposite side.

## Take profit
- TP1: 1.1 x risk  ·  TP2: 1.5 x risk  ·  SL: 1.0 x risk
`;

export function evaluate(ctx) {
  const out = [];
  const tf = ctx.pane('15');
  if (!tf?.bars || tf.bars.length < 30) return out;
  const bars = tf.bars;
  const sessStart = nyDayStartUnix(ctx.barTime);
  const sessBars = bars.filter((b) => b.time >= sessStart);
  if (sessBars.length < 6) return out;
  const vwapVal = vwap(sessBars, sessStart);
  if (vwapVal == null) return out;
  const sessOpen = sessBars[0].open;
  const last = bars[bars.length - 1];
  const a = atr(bars, 14);
  if (!a) return out;

  const bias = last.close > sessOpen ? 'LONG' : 'SHORT';
  const sessHi = Math.max(...sessBars.map((b) => b.high));
  const sessLo = Math.min(...sessBars.map((b) => b.low));

  if (bias === 'LONG' && last.low <= vwapVal && last.close > vwapVal + 0.5 * a) {
    const entry = vwapVal + 0.25 * a;
    const stop  = vwapVal - a;
    const risk  = entry - stop;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'LONG', 'vwap'),
      direction: 'LONG', timeframe: '15', confidence: 0.7,
      setupName: 'VWAP rejection · long', summary: `Day bullish · wick into VWAP $${vwapVal.toFixed(2)} · body holds above`,
      entry, stop, t1: entry + 1.2 * risk, t2: sessHi,
    }));
  } else if (bias === 'SHORT' && last.high >= vwapVal && last.close < vwapVal - 0.5 * a) {
    const entry = vwapVal - 0.25 * a;
    const stop  = vwapVal + a;
    const risk  = stop - entry;
    if (risk > 0) out.push(buildTriggered({
      strategy: meta.id, setupId: dayScopedId(meta.id, ctx.dateKey, 'SHORT', 'vwap'),
      direction: 'SHORT', timeframe: '15', confidence: 0.7,
      setupName: 'VWAP rejection · short', summary: `Day bearish · wick into VWAP $${vwapVal.toFixed(2)} · body holds below`,
      entry, stop, t1: entry - 1.2 * risk, t2: sessLo,
    }));
  }
  for (const r of out) r.confirmations = ['Session direction', 'Wick crosses VWAP', 'Body holds the side'];
  return out;
}
