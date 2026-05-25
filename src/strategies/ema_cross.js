/**
 * Strategy: EMA Cross (9/21 with 50 EMA trend filter)
 *
 * One of the oldest trend-follow patterns. The 50 EMA defines bias; the 9/21
 * cross times the entry. Filter eliminates counter-trend chop signals.
 */

import { ema } from '../lib/indicators.js';
import { atr } from '../lib/structure.js';
import { buildTriggered, dayScopedId, qualityConfidence, projectTrade } from './_helpers.js';

export const meta = {
  id: 'EMA-CROSS',
  name: 'EMA 9/21 Cross · Trend',
  concept: 'Momentum cross in the direction of the 50-EMA trend',
  window: 'Any session hour',
  timeframes: ['15', '60'],
  defaultEnabled: true,
};

export const playbook = `# EMA 9/21 Cross · Trend Continuation

## Concept
Classic trend-follow momentum. The 50-EMA defines the bias (price above → long-only; below → short-only). The 9/21 EMA cross gates the entry inside that trend so we only take momentum kicks aligned with the higher-timeframe direction.

## Rules
1. **Bias** — H1 close > 50-EMA → LONG bias only. < 50-EMA → SHORT bias only.
2. **Trigger** — On 15m close, the 9-EMA crosses the 21-EMA in the direction of the bias AND the closing bar's body is in the same direction.
3. **Confirmation filter** — ATR(14) on 15m > 0.5 × ATR(14) on H1 (avoid dead-tape entries).

## Entry
- Limit order at the 9-EMA value of the trigger bar (small pullback fill).

## Stop loss
- 1.0 × ATR(14) on 15m below entry (long) / above entry (short).

## Take profit
- TP1: 1.1 x risk  ·  TP2: 1.5 x risk  ·  SL: 1.0 x risk

## Best timeframe
15m execution with H1 trend filter. The 9/21/50 EMA stack is the only thing on the chart.

## When to skip
- News blackout ±30m (handled globally).
- Outside US session if the instrument is futures-thin.
`;

export function evaluate(ctx) {
  const out = [];
  const tf15 = ctx.pane('15');
  const tf60 = ctx.pane('60');
  if (!tf15?.bars || tf15.bars.length < 60 || !tf60?.bars || tf60.bars.length < 60) return out;

  const bars15 = tf15.bars;
  const bars60 = tf60.bars;
  const ema9 = ema(bars15, 9);
  const ema21 = ema(bars15, 21);
  const ema50_60 = ema(bars60, 50);
  if (ema9.length < 3 || ema21.length < 3 || !ema50_60.length) return out;

  const last = bars15[bars15.length - 1];
  const prev = bars15[bars15.length - 2];
  const ema50last = ema50_60[ema50_60.length - 1];
  const lastH1 = bars60[bars60.length - 1];

  const a15 = atr(bars15, 14);
  const a60 = atr(bars60, 14);
  if (!a15 || !a60 || a15 < 0.5 * a60 * 0.5) return out;

  const e9now = ema9[ema9.length - 1], e9prev = ema9[ema9.length - 2];
  const e21now = ema21[ema21.length - 1], e21prev = ema21[ema21.length - 2];

  const longBias  = lastH1.close > ema50last;
  const shortBias = lastH1.close < ema50last;
  const crossedUp   = e9prev <= e21prev && e9now > e21now;
  const crossedDown = e9prev >= e21prev && e9now < e21now;
  const bullBody = last.close > last.open;
  const bearBody = last.close < last.open;
  // Gold's 9/21 EMAs graze back and forth — on gold require the cross to
  // open real separation rather than a touch-and-go that immediately recrosses.
  const goldSepOK = ctx.instrument !== 'gold' || Math.abs(e9now - e21now) >= 0.06 * a15;

  if (longBias && crossedUp && bullBody && goldSepOK) {
    const entry = e9now;
    const stop  = entry - a15;
    const risk  = entry - stop;
    out.push(buildTriggered({
      strategy: meta.id,
      setupId: dayScopedId(meta.id, ctx.dateKey, 'LONG', 'cross'),
      direction: 'LONG',
      setupName: '9/21 EMA cross in uptrend',
      summary: `H1 above 50-EMA · 9/21 EMA bullish cross on 15m · ATR-sized stop`,
      confidence: qualityConfidence(meta.id, [
        Math.abs(e9now - e21now) / a15,                                 // cross separation
        Math.abs(last.close - last.open) / (last.high - last.low || 1), // cross-bar body
        Math.abs(lastH1.close - ema50last) / (a60 * 2),                 // H1 trend strength
      ]),
      timeframe: '15',
      entry, stop,
      t1: entry + 1.2 * risk,
      t2: entry + 2.0 * risk,
    }));
  } else if (shortBias && crossedDown && bearBody && goldSepOK) {
    const entry = e9now;
    const stop  = entry + a15;
    const risk  = stop - entry;
    out.push(buildTriggered({
      strategy: meta.id,
      setupId: dayScopedId(meta.id, ctx.dateKey, 'SHORT', 'cross'),
      direction: 'SHORT',
      setupName: '9/21 EMA cross in downtrend',
      summary: `H1 below 50-EMA · 9/21 EMA bearish cross on 15m · ATR-sized stop`,
      confidence: qualityConfidence(meta.id, [
        Math.abs(e9now - e21now) / a15,                                 // cross separation
        Math.abs(last.close - last.open) / (last.high - last.low || 1), // cross-bar body
        Math.abs(lastH1.close - ema50last) / (a60 * 2),                 // H1 trend strength
      ]),
      timeframe: '15',
      entry, stop,
      t1: entry - 1.2 * risk,
      t2: entry - 2.0 * risk,
    }));
  }

  for (const r of out) {
    r.confirmations = ['H1 50-EMA trend', '9/21 EMA cross', 'Body in cross direction'];
  }
  return out;
}

export function precheck(ctx) {
  const tf15 = ctx.pane('15');
  const tf60 = ctx.pane('60');
  if (!tf15?.bars || tf15.bars.length < 60 || !tf60?.bars || tf60.bars.length < 60) return null;

  const ema9 = ema(tf15.bars, 9);
  const ema21 = ema(tf15.bars, 21);
  const ema50_60 = ema(tf60.bars, 50);
  if (ema9.length < 3 || ema21.length < 3 || !ema50_60.length) return null;

  const last = tf15.bars[tf15.bars.length - 1];
  const lastH1 = tf60.bars[tf60.bars.length - 1];
  const ema50last = ema50_60[ema50_60.length - 1];

  const a15 = atr(tf15.bars, 14);
  const a60 = atr(tf60.bars, 14);
  const tapeOk = a15 && a60 && a15 >= 0.5 * a60 * 0.5;

  const e9now = ema9[ema9.length - 1], e9prev = ema9[ema9.length - 2];
  const e21now = ema21[ema21.length - 1], e21prev = ema21[ema21.length - 2];

  const longBias = lastH1.close > ema50last;
  const shortBias = lastH1.close < ema50last;
  const direction = longBias ? 'LONG' : shortBias ? 'SHORT' : null;

  const stackedUp = e9now > e21now;
  const stackedDown = e9now < e21now;
  const crossedUp = e9prev <= e21prev && e9now > e21now;
  const crossedDown = e9prev >= e21prev && e9now < e21now;
  const crossOnBar = crossedUp || crossedDown;
  const stackAligned = (longBias && stackedUp) || (shortBias && stackedDown);

  const bodyAlign = (longBias && last.close > last.open) || (shortBias && last.close < last.open);
  const goldSepOK = ctx.instrument !== 'gold' || Math.abs(e9now - e21now) >= 0.06 * (a15 || 1);

  const ratio = a15 && a60 ? (a15 / a60).toFixed(2) : '—';
  // Project the would-be trade (limit at 9-EMA, stop ATR away).
  let projection = null;
  if (direction && a15) {
    const entry = e9now;
    const stop = direction === 'LONG' ? entry - a15 : entry + a15;
    projection = projectTrade({ direction, entry, stop, t2Mult: 2.0 });
  }
  return {
    direction,
    projection,
    conditions: [
      { kind: 'gate',    label: 'H1 50-EMA trend',                 met: !!direction, value: ema50last != null ? `H1 ${lastH1.close.toFixed(2)} ${longBias ? '>' : shortBias ? '<' : '≈'} EMA50 ${ema50last.toFixed(2)}` : 'no EMA yet' },
      { kind: 'gate',    label: 'Tape alive (15m ATR vs H1)',      met: !!tapeOk, value: a15 && a60 ? `ATR15 ${a15.toFixed(2)} / ATR60 ${a60.toFixed(2)} (${ratio})` : '—' },
      { kind: 'gate',    label: '9/21 EMAs stacked with trend',    met: stackAligned, value: `9-EMA ${e9now.toFixed(2)} ${stackedUp ? '>' : stackedDown ? '<' : '≈'} 21-EMA ${e21now.toFixed(2)}` },
      { kind: 'trigger', label: 'Cross on this bar',               met: crossOnBar, value: crossOnBar ? `9/21 crossed ${crossedUp ? 'up' : 'down'} (prev 9=${e9prev.toFixed(2)} 21=${e21prev.toFixed(2)})` : `prev 9=${e9prev.toFixed(2)} 21=${e21prev.toFixed(2)} · no flip` },
      { kind: 'trigger', label: 'Body in cross direction',         met: bodyAlign, value: `last ${last.open.toFixed(2)}→${last.close.toFixed(2)} (${last.close > last.open ? 'bull' : last.close < last.open ? 'bear' : 'doji'} body)` },
      ...(ctx.instrument === 'gold' ? [{ kind: 'gate', label: 'Gold separation gate (≥ 0.06×ATR15)', met: goldSepOK, value: `sep ${Math.abs(e9now - e21now).toFixed(2)} vs threshold ${(0.06 * (a15 || 0)).toFixed(2)}` }] : []),
    ],
  };
}
